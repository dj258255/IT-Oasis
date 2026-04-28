---
title: '트랜잭션 ACID ①: Atomicity는 어떻게 구현되는가'
titleEn: 'Transaction ACID ①: How Is Atomicity Implemented?'
description: PostgreSQL과 InnoDB가 같은 Atomicity 보장을 어떻게 다른 비용 구조로 구현하는지 — STEAL/NO-FORCE 정책, append-only vs in-place + Undo Log, ARIES 복구 vs 가시성 규칙까지 1차 자료 기준으로 정리해요.
descriptionEn: How PostgreSQL and InnoDB deliver the same Atomicity guarantee through fundamentally different cost structures — STEAL/NO-FORCE buffer policies, append-only vs in-place with Undo Log, ARIES recovery vs visibility rules — grounded in primary sources.
date: 2026-04-28T00:00:00.000Z
tags:
  - Transaction
  - ACID
  - Atomicity
  - PostgreSQL
  - InnoDB
  - MVCC
  - WAL
  - Database
category: theory/Database
draft: false
coverImage: "/uploads/theory/transaction-acid/cover-1.svg"
series: "트랜잭션 ACID"
seriesOrder: 1
---

## 0. 들어가며

PostgreSQL, MySQL InnoDB, SQL Server 셋 다 **WAL 프로토콜**을 따르고, 데이터 페이지는 모두 버퍼풀(메모리)에 두며 **WAL 로그만 fsync** 합니다. 진짜 차이는 **이전 버전을 어디에 두느냐**, 그리고 그로 인한 **롤백 메커니즘의 차이**예요.

이 글은 그 정확한 차이를 Atomicity 관점에서 풀어봅니다.

## 1. Atomicity가 풀어야 하는 진짜 문제

> "트랜잭션 내의 모든 쿼리는 전부 성공하거나 전부 실패해야 한다." 부분 성공은 허용되지 않는다.

말은 단순하지만 구현은 까다롭습니다. 가장 흔한 예시:

```sql
BEGIN;
UPDATE account SET balance = balance - 100 WHERE id = 1;  -- 성공
-- 여기서 무슨 일이 생기면?
UPDATE account SET balance = balance + 100 WHERE id = 2;  -- 실패
COMMIT;
```

첫 번째 `UPDATE`만 반영된 채로 끝나면 100원이 허공으로 사라져요. **일관성 위반의 근본 원인은 원자성 부재**입니다. A가 깨지면 C도 즉시 깨져요 — A는 C의 전제 조건처럼 작동합니다.

DB가 보장해야 하는 시나리오는 세 가지예요:

1. **트랜잭션 중 한 쿼리가 실패** → 지금까지 성공한 쿼리를 모두 되돌려야 함
2. **사용자가 명시적으로 ROLLBACK** → 동일
3. **트랜잭션 도중에 DB가 다운** → 재시작 시 미커밋 트랜잭션의 흔적을 지워야 함

이 세 시나리오를 어떻게 구현하느냐가 곧 Atomicity 구현 전략이고, 여기서 DB마다 갈립니다.

## 2. 사전 지식 — STEAL과 NO-FORCE

DB 교과서의 표준 용어로 먼저 정리해요. Atomicity 메커니즘을 이해하려면 **버퍼 관리 정책 두 가지**를 알아야 합니다.

![STEAL + NO-FORCE — 거의 모든 현대 DB의 선택](/uploads/theory/transaction-acid/steal-noforce.svg)

### STEAL vs NO-STEAL

> 미커밋 트랜잭션이 수정한 dirty page를 디스크에 쓸 수 있는가?

- **STEAL**: 가능. 버퍼풀이 부족하면 미커밋 변경도 디스크로 evict될 수 있음 → 롤백/복구 시 **undo가 필요**해짐
- **NO-STEAL**: 불가. 모든 dirty page는 커밋될 때까지 메모리에 묶여야 함 → undo는 필요 없지만, 큰 트랜잭션에서 메모리 압박이 심해짐

### FORCE vs NO-FORCE

> 커밋 시점에 그 트랜잭션의 모든 변경 페이지를 디스크에 강제로 써야 하는가?

- **FORCE**: 강제. 커밋 시 모든 dirty page를 fsync → redo는 필요 없지만, 커밋이 매우 느려짐
- **NO-FORCE**: 강제하지 않음. 커밋 시점에는 WAL만 fsync하고, 데이터 페이지는 나중에 천천히 → **redo가 필요**해짐

### 거의 모든 현대 DB는 STEAL + NO-FORCE를 씁니다

PostgreSQL, MySQL InnoDB, SQL Server, Oracle 모두 마찬가지예요. 이유는 단순해요 — **성능** 때문입니다. STEAL이 없으면 큰 트랜잭션을 못 돌리고, NO-FORCE가 없으면 매 커밋마다 무차별 I/O가 터져요.

대신 그 대가로 **redo와 undo 메커니즘**이 필요합니다. **ARIES 알고리즘**이 바로 STEAL + NO-FORCE 환경에서 어떻게 복구할지를 정의한 표준이고, InnoDB와 SQL Server가 이걸 따라요. PostgreSQL은 약간 다른 길을 갔는데, 뒤에서 다룹니다.

## 3. 롤백을 구현하는 두 가지 철학

`ROLLBACK` 명령을 받았을 때 DB가 실제로 무엇을 하느냐? 두 가지 정반대 접근이 존재해요. 차이의 핵심은 **이전 버전을 어디에 저장하느냐** 입니다.

![두 가지 롤백 철학 — 이전 버전을 어디에 두느냐](/uploads/theory/transaction-acid/rollback-philosophies.svg)

### 접근 1: PostgreSQL — Append-only + 가시성 규칙

PostgreSQL은 `UPDATE`를 받아도 기존 행을 수정하지 않아요. 같은 테이블(힙) 안에 **새 튜플을 추가**하고 옛 튜플은 그대로 둡니다. 각 튜플은 자신을 만든 트랜잭션 ID(`xmin`)와 자신을 삭제한 트랜잭션 ID(`xmax`)를 헤더에 가지고 있어요.

`ROLLBACK`이 일어나면? 트랜잭션 상태를 **CLOG**(commit log, 현재는 `pg_xact`)에 `ABORTED`로 마킹하면 끝입니다. 그 트랜잭션이 만든 새 튜플들은 자동으로 *"xmin이 ABORTED 트랜잭션인 죽은 튜플"* 이 되어 **가시성 규칙(visibility rules)** 에 의해 다른 트랜잭션에게 보이지 않게 돼요.

PostgreSQL 코어 개발자 Tom Lane이 메일링 리스트에서 직접 한 말:

> "Commit and abort are both O(1). Where we pay the piper is in having to run VACUUM to clean up no-longer-needed row versions."

즉 **롤백 연산 자체는 O(1)** 에 가까워요. 하지만 주의 — 이게 *"공짜"* 라는 뜻은 아닙니다:

- 트랜잭션이 만든 새 튜플들은 이미 WAL에 기록됐고 디스크 공간도 차지하고 있음
- 그 튜플들을 물리적으로 청소하는 비용은 나중에 **VACUUM**이 치름
- 인덱스 항목도 같이 누적됨

> **"롤백 자체는 싸지만, 시스템 전체 비용은 공짜가 아니다."** PostgreSQL은 비용을 지금 즉시 치르는 대신 나중에 백그라운드로 치르는 구조예요.

### 접근 2: InnoDB / Oracle — In-place 수정 + Undo Log

InnoDB는 정반대예요. `UPDATE`가 오면 메인 테이블의 행을 **in-place로 수정**하고, 변경 전 이미지(before-image)를 별도의 **Undo Log**(rollback segment)에 기록합니다. 행 헤더의 `DB_ROLL_PTR`이 Undo Log 안의 옛 버전을 가리키는 포인터 역할을 해요.

`ROLLBACK`이 일어나면? Undo Log를 따라가서 행을 한 줄씩 되돌려야 해요. 100만 행을 수정한 트랜잭션을 롤백하면 **100만 번의 undo 작업**이 발생합니다. 진짜로 시간이 걸리는 작업이에요.

### 비용은 어디로 가는가

| 구분 | PostgreSQL | InnoDB / Oracle |
|------|-----------|----------------|
| 행 업데이트 | 새 튜플 추가 (append-only) | In-place + 옛 버전을 Undo Log에 |
| 옛 버전의 위치 | 같은 테이블의 힙 | 별도 Undo Log (rollback segment) |
| 가시성 판단 | xmin/xmax + CLOG + 스냅샷 + hint bit | Read view + DB_ROLL_PTR 포인터 체인 |
| 롤백 자체의 비용 | **O(1)** — abort 마킹만 | **O(N)** — Undo Log 역재생 |
| 이연 비용 | VACUUM (백그라운드 dead tuple 청소) | Undo tablespace 관리, purge thread |

> **흔한 오해 정정**: *"낙관적 vs 비관적"* 이라는 표현은 정확하지 않아요. 낙관/비관은 원래 락 전략 용어이고, 여기서의 차이는 **MVCC 구현 방식**입니다. 면접에서는 *"이전 버전을 저장하는 위치가 다릅니다"* 라고 말하는 게 안전해요.

## 4. 크래시가 났을 때의 Atomicity

명시적 `ROLLBACK`은 그래도 쉬워요. 진짜 까다로운 건 **트랜잭션 도중에 DB가 다운되는 경우**입니다. 다운된 DB는 스스로 ROLLBACK을 호출할 수도 없어요.

해결책은 재시작 시점의 **복구(recovery) 절차**입니다. 여기서도 두 학파가 갈립니다.

![크래시 후 복구 — 두 학파](/uploads/theory/transaction-acid/recovery-flow.svg)

### ARIES 스타일 — Redo + Undo (InnoDB, SQL Server)

표준 STEAL + NO-FORCE 환경의 표준 복구 알고리즘이에요. 재시작하면 **3단계**를 수행합니다:

1. **Analysis phase** — WAL을 읽어서 크래시 시점의 활성 트랜잭션과 dirty page 목록을 재구성
2. **Redo phase** — 마지막 체크포인트 이후의 WAL을 순방향으로 재생해서 모든 변경(미커밋 포함)을 데이터 페이지에 반영
3. **Undo phase** — 미커밋 트랜잭션의 변경을 Undo Log를 따라 역방향으로 되돌림

이 세 단계를 거치면 재시작 후 DB는 *"커밋된 트랜잭션의 효과만 남고 미커밋의 흔적은 모두 사라진"* 상태가 됩니다.

### PostgreSQL 스타일 — 명시적 Undo phase 없이 Redo + 가시성 규칙

PostgreSQL은 다른 길을 택했어요. 재시작 시 명시적인 Undo phase 없이 **Redo만 수행**하고, 미커밋 트랜잭션의 흔적은 **가시성 규칙**으로 처리합니다.

PostgreSQL 7.3 공식 문서:

> "UNDO operation is not implemented. This means that changes made by aborted transactions will still occupy disk space"

미커밋 트랜잭션의 흔적은 어떻게 사라질까요? **사라지지 않습니다.** 디스크에 그대로 남아있어요. 다만 그 튜플들의 `xmin`이 ABORTED 트랜잭션 ID이기 때문에, CLOG와 가시성 규칙이 그 튜플들을 안 보이게 만듭니다. 사용자 입장에서는 마치 없는 것처럼 보여요.

물리적 청소는 나중에 **VACUUM**이 해줍니다. **hint bit**가 한 번 설정되고 나면 CLOG를 매번 조회할 필요도 없어 효율이 더 올라가요.

> **표현 주의**: PostgreSQL이 *"undo 개념이 아예 없다"* 고 하면 부정확해요. 전통적인 Undo Log 기반 롤백을 사용하지 않을 뿐이고, **CLOG와 가시성 규칙**(xmin/xmax + hint bit + 스냅샷)으로 동일한 효과를 냅니다. WAL은 이 과정에서 데이터 페이지의 **물리적 redo**를 담당할 뿐, abort 판정 자체의 메커니즘은 아니라는 점을 구분하세요.

### 같은 목적, 다른 메커니즘

| 시나리오 | InnoDB / SQL Server | PostgreSQL |
|---------|---------------------|------------|
| 명시적 ROLLBACK | Undo Log 역재생 | CLOG에 ABORTED 마킹만 |
| 크래시 후 복구 | Analysis → Redo → Undo | Redo + 가시성 규칙 (명시적 Undo phase 없음) |
| 미커밋 변경의 운명 | 물리적으로 되돌려짐 | 가시성 규칙으로 무시됨 → VACUUM이 청소 |
| 핵심 자료구조 | Undo Log, rollback segment | CLOG (pg_xact), hint bit, xmin/xmax |

둘 다 외부에서 보면 동일한 Atomicity 보장을 제공해요. 단지 **비용을 언제, 어떤 형태로 치르느냐** 가 다를 뿐입니다.

## 5. WAL은 모두 같은가? — 정확히 짚고 가자

세 DB가 WAL을 쓴다는 점은 같지만, 구현은 동일하지 않아요. 이 부분을 면접에서 *"다 같다"* 고 하면 깊이 없어 보입니다. 정확하게는:

### 공통점 (개념 수준)

- 데이터 파일 변경 전에 WAL 레코드를 먼저 기록
- 데이터 페이지는 메모리(버퍼풀)에 있고 WAL만 fsync
- 커밋 보장은 WAL의 fsync로 결정됨

### 차이점 (구현 수준)

- **flush 타이밍**: PostgreSQL의 `synchronous_commit`, InnoDB의 `innodb_flush_log_at_trx_commit`, SQL Server의 delayed durability — 다이얼이 다름
- **group commit**: 여러 트랜잭션을 묶어 한 번에 fsync하는 전략의 디테일이 다름
- **doublewrite buffer**: InnoDB는 페이지 부분 쓰기(torn page)를 막기 위한 별도의 doublewrite 영역이 있음. PostgreSQL은 `full_page_writes`로, SQL Server는 다른 방식으로 같은 문제를 풀어요
- **체크포인트 전략**: PostgreSQL의 `checkpoint_timeout`/`max_wal_size`, InnoDB의 fuzzy checkpointing, SQL Server의 indirect checkpoint — 모두 다름

WAL의 자세한 동작은 **D편(Durability)** 에서 다뤄요. 여기서는 *"셋 다 WAL을 쓰지만 그 안의 디테일은 다르다"* 는 정도로 충분합니다.

## 6. 그래서 긴 트랜잭션이 어디서든 위험합니다

Atomicity 메커니즘을 이해하면 **왜 긴 트랜잭션이 어디서든 안 좋은가**가 자연스럽게 보여요. 두 진영 모두 비용을 치르는데, 그 형태만 다릅니다.

### PostgreSQL의 부담

- 긴 미커밋 트랜잭션의 스냅샷이 보는 옛 행 버전들을 VACUUM이 청소할 수 없음
- 죽은 튜플이 누적 → 테이블 bloat, 인덱스 bloat, 쿼리 성능 저하
- 오래된 트랜잭션은 트랜잭션 ID **wraparound** 위험까지 증가시킴

### InnoDB의 부담

- 긴 트랜잭션이 살아있는 동안 purge thread가 Undo Log를 정리하지 못함
- **History list length(HLL)** 가 계속 증가하고 Undo tablespace가 부풀어 오름
- 긴 트랜잭션이 ROLLBACK되면 그동안 쌓인 Undo Log를 모두 역재생해야 해서 진짜로 오래 걸림

### 공통 부담

- 마지막 체크포인트 이후의 WAL이 길어져서 **크래시 복구 시간**이 늘어남
- 트랜잭션이 길수록 그 시간 안에 장애가 발생할 확률 자체가 비례해서 커짐

> **트랜잭션은 짧고 응집력 있게.** 비즈니스 로직 단위로 명확하게 끊자. 이 격언의 진짜 근거가 위의 메커니즘들이에요.

## 7. 정리

Atomicity는 단순한 *"전부 성공 or 전부 실패"* 규칙이 아니라, **"부분 성공의 흔적을 어떻게 지울 것인가"** 라는 구현 문제예요. 거의 모든 현대 DB는 성능을 위해 **STEAL + NO-FORCE** 정책을 쓰고, 그 대가로 redo/undo 메커니즘을 갖춰야 합니다. 이 메커니즘을 두 가지 철학이 다르게 풀어요:

- **PostgreSQL** — Append-only + 가시성 규칙. 롤백은 abort 마킹만(O(1)), 명시적 Undo phase 없이 Redo + 가시성으로 처리. 비용은 VACUUM으로 이연.
- **InnoDB / Oracle** — In-place 수정 + 별도 Undo Log. 롤백은 Undo Log 역재생, 크래시 복구는 ARIES 스타일 Redo + Undo.
- **SQL Server** — InnoDB와 비슷한 ARIES 계열. 단 MVCC는 옵트인(스냅샷 격리)이고 version store는 tempdb에 둠.

세 DB 모두 외부에서 보면 같은 Atomicity 보장을 제공하지만, 내부적으로는 **비용을 청구하는 시점과 형태**가 완전히 다릅니다.

## 참고 (1차 자료 우선)

- [PostgreSQL Documentation: Write-Ahead Logging (WAL)](https://www.postgresql.org/docs/current/wal-intro.html)
- [PostgreSQL 7.3 Documentation: WAL — UNDO operation is not implemented](https://www.postgresql.org/docs/7.3/wal.html)
- [PostgreSQL Mailing List: PG and undo logging (Tom Lane on commit/abort being O(1))](https://www.postgresql.org/message-id/603c8f070908180931s5b6f3a59l4f64488e6e2476a8%40mail.gmail.com)
- [PostgreSQL Wiki: Hint Bits](https://wiki.postgresql.org/wiki/Hint_Bits)
- [The Internals of PostgreSQL: Commit Log (clog)](https://www.interdb.jp/pg/pgsql05.html)
- [SQL Server Transaction Log Architecture — Microsoft Learn](https://learn.microsoft.com/en-us/sql/relational-databases/sql-server-transaction-log-architecture-and-management-guide)
- [Well-known Databases Use Different Approaches for MVCC — EDB](https://www.enterprisedb.com/blog/postgresql-anti-wraparound)
- [Comparing PostgreSQL MVCC vs InnoDB — Severalnines](https://severalnines.com/blog/comparing-postgresql-mvcc-vs-innodb/)
- [InnoDB Undo Log vs Redo Log — Percona](https://www.percona.com/blog/innodbs-redo-log-and-undo-log/)
- ARIES: A Transaction Recovery Method (Mohan et al., 1992)
- [How Postgres Makes Transactions Atomic — brandur.org](https://brandur.org/postgres-atomicity)

<!-- EN -->

## 0. Introduction

PostgreSQL, MySQL InnoDB, and SQL Server all follow the **WAL protocol**. Data pages live in the buffer pool (memory) in all three, and only the **WAL log is fsync-ed**. The real difference is **where the previous version is stored**, and the **rollback mechanism** that flows from that choice.

This post unpacks that real difference from the angle of Atomicity.

## 1. The Real Problem Atomicity Has to Solve

> "Every query inside a transaction must either all succeed or all fail." Partial success is not allowed.

Simple to state, tricky to implement. Classic example:

```sql
BEGIN;
UPDATE account SET balance = balance - 100 WHERE id = 1;  -- success
-- what if something happens here?
UPDATE account SET balance = balance + 100 WHERE id = 2;  -- failure
COMMIT;
```

If only the first `UPDATE` lands, 100 vanishes into thin air. **The root cause of consistency violation is the absence of atomicity.** When A breaks, C breaks immediately — A is essentially a precondition for C.

The DB has to handle three scenarios:

1. **A query fails mid-transaction** → undo all queries that succeeded so far
2. **The user explicitly issues ROLLBACK** → same
3. **The DB crashes mid-transaction** → on restart, erase all traces of uncommitted transactions

How a DB implements these three scenarios is exactly its Atomicity strategy, and this is where DBs diverge.

## 2. Background — STEAL and NO-FORCE

Let us start with standard textbook terms. To understand the Atomicity mechanism, you need to know two **buffer management policies**.

![STEAL + NO-FORCE — what nearly every modern DB picks](/uploads/theory/transaction-acid/steal-noforce.svg)

### STEAL vs NO-STEAL

> Can a dirty page modified by an uncommitted transaction be written to disk?

- **STEAL**: Yes. If the buffer pool is short on memory, even uncommitted changes can be evicted to disk → rollback/recovery now requires **undo**
- **NO-STEAL**: No. Every dirty page has to stay pinned in memory until commit → no undo needed, but big transactions create severe memory pressure

### FORCE vs NO-FORCE

> At commit time, must all modified pages of that transaction be flushed to disk?

- **FORCE**: Yes. Every dirty page is fsync-ed at commit → no redo needed, but commit becomes very slow
- **NO-FORCE**: No. Only the WAL is fsync-ed at commit; data pages get flushed lazily later → **redo** is required

### Nearly every modern DB uses STEAL + NO-FORCE

PostgreSQL, MySQL InnoDB, SQL Server, Oracle — all of them. The reason is simple: **performance**. Without STEAL, you cannot run large transactions; without NO-FORCE, every commit triggers indiscriminate I/O.

The price is needing **redo and undo machinery**. The **ARIES algorithm** is the standard for "how do we recover under STEAL + NO-FORCE", and InnoDB and SQL Server follow it. PostgreSQL took a slightly different path, which we will get to.

## 3. Two Philosophies for Implementing Rollback

What does the DB actually do when it receives `ROLLBACK`? Two opposite approaches exist. The crux of the difference is **where the previous version lives**.

![Two rollback philosophies — where the previous version lives](/uploads/theory/transaction-acid/rollback-philosophies.svg)

### Approach 1: PostgreSQL — Append-only + Visibility Rules

PostgreSQL never modifies an existing row when it receives an `UPDATE`. It **appends a new tuple** into the same heap (the table) and leaves the old tuple alone. Each tuple carries in its header the transaction ID that created it (`xmin`) and the transaction ID that deleted it (`xmax`).

What happens on `ROLLBACK`? The DB simply marks the transaction state as `ABORTED` in the **CLOG** (commit log, today `pg_xact`). The new tuples that transaction created automatically become *"dead tuples whose xmin is an aborted transaction"* and are made invisible to other transactions by the **visibility rules**.

Tom Lane, a core PostgreSQL developer, said it directly on the mailing list:

> "Commit and abort are both O(1). Where we pay the piper is in having to run VACUUM to clean up no-longer-needed row versions."

So **the rollback operation itself is essentially O(1)**. But careful — that does not mean it is *"free"*:

- The new tuples that the transaction created have already been written to WAL and are taking up disk space
- The cost of physically cleaning them up is paid later by **VACUUM**
- Index entries pile up the same way

> **"The rollback itself is cheap, but the system-wide cost is not free."** PostgreSQL defers the cost — it pays later, in the background, instead of immediately.

### Approach 2: InnoDB / Oracle — In-place Modification + Undo Log

InnoDB does the opposite. When an `UPDATE` arrives, it **modifies the row in place** in the main table and writes the before-image to a separate **Undo Log** (rollback segment). The row header's `DB_ROLL_PTR` acts as a pointer to the old version inside the Undo Log.

What happens on `ROLLBACK`? It has to walk the Undo Log and revert each row one by one. Rolling back a transaction that modified a million rows triggers **a million undo operations**. This is genuinely slow work.

### Where the cost goes

| Aspect | PostgreSQL | InnoDB / Oracle |
|--------|-----------|-----------------|
| Row update | Append a new tuple (append-only) | In-place + old version into Undo Log |
| Where the old version lives | The table's heap | A separate Undo Log (rollback segment) |
| Visibility check | xmin/xmax + CLOG + snapshot + hint bit | Read view + DB_ROLL_PTR pointer chain |
| Rollback cost itself | **O(1)** — just an abort marker | **O(N)** — replay the Undo Log |
| Deferred cost | VACUUM (background dead-tuple cleanup) | Undo tablespace management, purge thread |

> **Common misconception fix**: *"Optimistic vs pessimistic"* is an inaccurate framing. Those terms are about locking strategies; the difference here is the **MVCC implementation**. In an interview it is safer to say *"the place where the previous version is stored is different."*

## 4. Atomicity Under Crash

An explicit `ROLLBACK` is the easy case. The truly hard case is **the DB crashing mid-transaction**. A crashed DB cannot call ROLLBACK on itself.

The solution is **a recovery procedure on restart**. Two schools of thought again.

![Crash recovery — the two schools](/uploads/theory/transaction-acid/recovery-flow.svg)

### ARIES style — Redo + Undo (InnoDB, SQL Server)

The standard recovery algorithm for the standard STEAL + NO-FORCE environment. On restart it runs **three phases**:

1. **Analysis phase** — read the WAL to reconstruct the active transactions and dirty page list at crash time
2. **Redo phase** — replay the WAL forward from the last checkpoint, applying every change (including uncommitted ones) to the data pages
3. **Undo phase** — undo the changes of uncommitted transactions backward by walking the Undo Log

After these three phases, the DB ends up in a state where *"only the effects of committed transactions remain, and no trace of uncommitted ones is left."*

### PostgreSQL style — Redo + visibility rules, no explicit Undo phase

PostgreSQL chose differently. On restart it runs **only Redo** with no explicit Undo phase, and lets the **visibility rules** take care of uncommitted transactions' traces.

PostgreSQL 7.3 official docs:

> "UNDO operation is not implemented. This means that changes made by aborted transactions will still occupy disk space"

How do the traces of uncommitted transactions disappear? **They do not.** They stay on disk. But because their `xmin` is an ABORTED transaction ID, the CLOG and visibility rules make those tuples invisible. From the user's perspective they look as if they never existed.

Physical cleanup happens later through **VACUUM**. Once the **hint bit** is set, you do not even need to consult the CLOG every time, which makes things more efficient.

> **A note on phrasing**: saying *"PostgreSQL has no undo concept at all"* would be inaccurate. It just does not use traditional Undo-Log-based rollback. The same effect is achieved through **CLOG and visibility rules** (xmin/xmax + hint bit + snapshot). WAL handles the **physical redo** of data pages in this story; it is not the mechanism that decides abort itself.

### Same goal, different mechanisms

| Scenario | InnoDB / SQL Server | PostgreSQL |
|----------|---------------------|------------|
| Explicit ROLLBACK | Replay the Undo Log | Just mark CLOG as ABORTED |
| Crash recovery | Analysis → Redo → Undo | Redo + visibility rules (no explicit Undo phase) |
| Fate of uncommitted changes | Physically reverted | Ignored by visibility rules → cleaned by VACUUM |
| Key data structures | Undo Log, rollback segment | CLOG (pg_xact), hint bit, xmin/xmax |

From the outside both deliver the same Atomicity guarantee. They just differ in **when and in what form they bill you for the cost**.

## 5. Is WAL the Same Everywhere? — Be Precise

All three DBs use WAL, but the implementations are not identical. Saying *"they are all the same"* in an interview will sound shallow. Precisely:

### What is shared (at the conceptual level)

- WAL records are written before the data files are modified
- Data pages live in memory (buffer pool); only WAL is fsync-ed
- The commit guarantee is decided by WAL fsync

### What differs (at the implementation level)

- **Flush timing**: PostgreSQL's `synchronous_commit`, InnoDB's `innodb_flush_log_at_trx_commit`, SQL Server's delayed durability — the dials are different
- **Group commit**: the details of bundling many transactions into one fsync differ
- **Doublewrite buffer**: InnoDB has a dedicated doublewrite area to defend against torn pages. PostgreSQL solves the same problem with `full_page_writes`; SQL Server solves it differently
- **Checkpoint strategy**: PostgreSQL's `checkpoint_timeout`/`max_wal_size`, InnoDB's fuzzy checkpointing, SQL Server's indirect checkpoint — all different

The detailed behavior of WAL is for the **D (Durability) part**. For now, *"all three use WAL but the details differ"* is enough.

## 6. Why Long Transactions Are Risky Everywhere

Once you understand the Atomicity mechanism, **why long transactions are bad everywhere** becomes obvious. Both camps pay a price; only the form differs.

### PostgreSQL's burden

- VACUUM cannot clean the old row versions visible to a long uncommitted transaction's snapshot
- Dead tuples accumulate → table bloat, index bloat, query slowdown
- Old transactions also raise the risk of transaction ID **wraparound**

### InnoDB's burden

- While a long transaction is alive, the purge thread cannot trim the Undo Log
- The **history list length (HLL)** keeps growing and the Undo tablespace bloats
- If a long transaction does ROLLBACK, all the Undo Log accumulated over that time has to be replayed — and that genuinely takes a while

### Shared burden

- The WAL since the last checkpoint grows longer, which inflates **crash recovery time**
- The longer the transaction, the higher the chance of hitting an incident during that time

> **Keep transactions short and cohesive.** Cut them along clear business-logic boundaries. The real basis for that maxim is the mechanisms above.

## 7. Wrap-up

Atomicity is not just a *"all succeed or all fail"* rule — it is the implementation question of **"how do you erase the traces of partial success?"** Nearly every modern DB picks **STEAL + NO-FORCE** for performance, and pays for it by needing redo/undo machinery. Two philosophies tackle that machinery differently:

- **PostgreSQL** — Append-only + visibility rules. Rollback is just an abort marker (O(1)); recovery does Redo + visibility, with no explicit Undo phase. Cost is deferred to VACUUM.
- **InnoDB / Oracle** — In-place modification + a separate Undo Log. Rollback replays the Undo Log; crash recovery is ARIES-style Redo + Undo.
- **SQL Server** — In the ARIES family like InnoDB. MVCC is opt-in (snapshot isolation) and the version store lives in tempdb.

All three deliver the same external Atomicity guarantee, but internally **the moment and form of the bill** are completely different.

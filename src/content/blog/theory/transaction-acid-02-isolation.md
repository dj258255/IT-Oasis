---
title: '트랜잭션 ACID ②: Isolation은 어떻게 구현되는가'
titleEn: 'Transaction ACID ②: How Is Isolation Implemented?'
description: 격리 수준 이름만 보고 동작을 판단하면 안 되는 이유. PostgreSQL의 RR(Snapshot Isolation, ANSI phantom 차단)과 InnoDB의 RR(consistent read + locking statement hybrid)이 어떻게 다른지, write skew와 lost update가 왜 DB마다 다르게 새어나오는지를 1차 자료 기준으로 정리해요.
descriptionEn: Why you cannot judge actual behavior just from the isolation-level name. How PostgreSQL's RR (Snapshot Isolation, blocks ANSI phantom) differs from InnoDB's RR (consistent read + locking statement hybrid), and why write skew and lost update leak differently across DBs — grounded in primary sources.
date: 2026-04-29T00:00:00.000Z
tags:
  - Transaction
  - ACID
  - Isolation
  - MVCC
  - PostgreSQL
  - InnoDB
  - Snapshot Isolation
  - Serializable
  - Database
category: theory/Database
draft: false
coverImage: "/uploads/theory/transaction-acid/cover-2.svg"
series: "트랜잭션 ACID"
seriesOrder: 2
---

## 0. 들어가며

같은 `REPEATABLE READ`라도 PostgreSQL과 MySQL InnoDB는 다르게 동작하고, 같은 `SERIALIZABLE`이라도 SSI 기반(낙관)과 잠금 기반(비관)은 비용 구조가 완전히 다릅니다. **표준은 최소 보장만 정의하고, 실제 동작은 제품마다 다르다** — 이 글은 그 정확한 차이를 Isolation 관점에서 풀어봅니다. A편(Atomicity)에서 살짝 등장한 MVCC와 `xmin`/`xmax`/Undo Log를 본격적으로 다뤄요.

## 1. Isolation이 풀어야 하는 진짜 문제

DB에 클라이언트가 한 명뿐이면 격리 따위 신경 쓸 필요 없어요. 트랜잭션을 하나씩 처리하면 그만이에요. 그러나 실제로는 수많은 TCP 커넥션이 동시에 트랜잭션을 실행합니다. 이때 **동시 실행 중인 트랜잭션들이 서로의 변경을 어떻게 보게 할 것인가** — 이게 격리(Isolation)의 본질이에요.

핵심 질문 하나로 압축할 수 있어요:

> "진행 중인 내 트랜잭션이, 다른 트랜잭션의 변경을 볼 수 있어야 하는가?"

- **봐야 한다** → 동시성↑, 일관성↓
- **보지 말아야 한다** → 일관성↑, 동시성↓

정답은 없어요. 워크로드에 따라 다릅니다. 이 트레이드오프를 표현하는 도구가 **격리 수준(Isolation Level)** 이고, 격리 수준이 충분히 강하지 않을 때 발생하는 비정상 동작이 **읽기 현상(Read Phenomena)** 입니다.

> **왜 격리 수준 이슈가 그렇게 골치 아픈가?** 격리 수준에서 비롯된 버그는 DB 분야에서 디버깅하기 가장 어려운 종류에 속해요. 재현이 안 되거나(타이밍 의존), 부하 테스트에서만 가끔 나타나거나, 운영에서만 발생하기 때문입니다. 코드만 보면 정상인데 결과가 이상한 — 그런 버그가 대부분 격리 수준이나 동시성 문제예요. 그래서 이 개념을 알고 모르고는 실무에서 진짜 차이를 만듭니다.

## 2. 읽기 현상 (Read Phenomena)

먼저 정확한 사실 하나. **SQL 표준(ANSI SQL-92)이 공식적으로 정의한 읽기 현상은 3가지** — Dirty Read, Non-repeatable Read, Phantom Read입니다. **"Lost Update"는 후속 논문**(*A Critique of ANSI SQL Isolation Levels*, Berenson et al. 1995)에서 추가된 anomaly로, 표준의 4번째 phenomenon은 아니에요. 다만 실무에서 매우 중요해서 함께 다룹니다.

![읽기 현상 4가지](/uploads/theory/transaction-acid/read-phenomena.svg)

### 2.1 Dirty Read — 커밋되지 않은 값을 읽는다

![Dirty Read 시나리오 — 미커밋 값을 읽음](/uploads/theory/transaction-acid/dirty-read-flow.svg)

같은 트랜잭션 안에서 개별 행 합계(50+80=130)와 SUM(155)이 일치하지 않는 보고서가 나갑니다. 게다가 Tx2가 롤백하면 그 데이터는 **애초에 존재한 적이 없는 값**이 돼요. 가장 직관적으로 위험한 읽기 현상입니다.

> **흔한 안티패턴**: *"Dirty Read를 쓰면 잠금 비용이 없어서 빠르다"* 는 이유로 의도적으로 활성화하는 경우가 있어요. 단기적으로는 빨라 보이지만, 존재한 적도 없는 값을 읽고 그 값으로 비즈니스 로직이 실행되면서 데이터 정합성이 무너집니다. 이런 결정은 거의 항상 후회로 돌아와요.

### 2.2 Non-repeatable Read — 같은 값이 중간에 바뀐다

![Non-repeatable Read 시나리오 — 같은 행을 두 번 읽으니 값이 다름](/uploads/theory/transaction-acid/non-repeatable-flow.svg)

Dirty Read와 달리 읽은 값이 모두 커밋된 값이에요. 그래서 더 미묘합니다. *"같은 트랜잭션 안에서 같은 행을 두 번 읽었더니 값이 다르더라"* 가 핵심.

> 강의에서 *"굳이 같은 행을 두 번 읽을 일이 있냐"* 는 의문이 든다고 하는데, 실제로는 다른 쿼리가 같은 행에 의존하는 경우가 흔해요. 위 예시도 첫 쿼리는 product_id별 세부, 두 번째는 SUM — 둘 다 product 1의 qty에 의존합니다.

### 2.3 Phantom Read — 없던 행이 갑자기 나타난다

![Phantom Read 시나리오 — 범위 쿼리에 새 행이 끼어듦](/uploads/theory/transaction-acid/phantom-flow.svg)

Non-repeatable Read와 비슷해 보이지만 다릅니다.

| 구분 | Non-repeatable Read | Phantom Read |
|---|---|---|
| 대상 | 이미 읽은 기존 행이 변경됨 | 이전엔 없던 새 행이 끼어듦 |
| 막는 방법 | 읽은 행에 잠금 또는 버전 고정 | 범위 자체에 잠금(gap lock 등) 또는 스냅샷 |

이 둘을 구분하는 이유는 **구현 비용이 완전히 다르기 때문**이에요. 읽은 행을 잠그는 건 비교적 쉬워요 — *"내가 읽은 이 행은 트랜잭션 끝까지 변하지 마"* 라고 하면 됩니다. 하지만 **읽은 적도 없는 행을 잠글 수는 없어요.** 그래서 phantom은 더 까다로운 문제입니다.

> 범위 조건이 있는 쿼리에서 phantom은 생각보다 자주 잠재적으로 발생할 수 있어요. PK 단일 행 조회처럼 phantom과 무관한 경우도 있지만, 범위 조건이나 비-유니크 조건의 WHERE 절은 모두 잠재적 phantom 위험을 가집니다 — `WHERE created_at BETWEEN ...`, `WHERE status = 'pending'`, `WHERE category = 'electronics'` 같은 것들. 다만 phantom이 실제로 결과에 영향이 없는 경우도 많아서(애플리케이션 로직상 새 행이 들어와도 무방한 경우), 격리 수준이나 타이밍에 따라 드러나지 않을 뿐이에요. 범위 조건 기반 검증 로직에서는 특히 주의가 필요합니다.

### 2.4 Lost Update — 동시 업데이트가 서로를 덮어쓴다

![Lost Update 시나리오 — read-modify-write에서 한쪽이 사라짐](/uploads/theory/transaction-acid/lost-update-flow.svg)

Tx1과 Tx2가 같은 시작값(10)을 읽고 각자 계산해서 쓰는 바람에, **나중에 커밋한 쪽이 먼저 커밋한 쪽을 덮어씁니다.** 15+10=25가 되어야 하는데 20이 돼요. Tx2의 +5가 사라진 것.

> 표준 외 anomaly이지만 실무에서 가장 자주 만나는 동시성 버그예요. 보통은 행 잠금(`SELECT ... FOR UPDATE`) 또는 낙관적 동시성 제어(버전 번호, CAS)로 해결합니다.

> **왜 Lost Update가 특히 위험한가?** 다른 읽기 현상도 잘못된 의사결정, 잘못된 정산, 중복 처리로 이어질 수 있어 결코 가볍지 않아요. 다만 Lost Update는 그 위에 한 단계 더 — 이미 디스크에 쓴 변경이 다른 트랜잭션에 의해 **영구적으로 덮어쓰여지는 직접적 데이터 손실**입니다. 재고 카운트가 어긋나고, 잔액이 잘못 누적되고, 좌석이 중복 예약돼요. 그래서 4가지 anomaly 중 비즈니스 임팩트가 가장 즉각적이고 회복이 어렵습니다.

> **2장 요약** — SQL 표준이 정의한 읽기 현상은 Dirty Read, Non-repeatable Read, Phantom 3가지이고, Lost Update는 표준 외 anomaly이지만 실무에서 가장 자주 만나는 동시성 버그입니다.

## 3. 격리 수준 (Isolation Levels)

SQL 표준은 4가지 격리 수준을 정의해요 — 약한 것부터 강한 순.

![격리 수준 — 표준 vs 실제](/uploads/theory/transaction-acid/isolation-levels.svg)

| 격리 수준 | Dirty Read | Non-repeatable | Phantom |
|---|---|---|---|
| READ UNCOMMITTED | 가능 | 가능 | 가능 |
| READ COMMITTED | 방지 | 가능 | 가능 |
| REPEATABLE READ | 방지 | 방지 | 표준상 가능 |
| SERIALIZABLE | 방지 | 방지 | 방지 |

표준은 **"최소 보장"만 정의**해요. 실제 DB는 더 강한 보장을 제공할 수 있습니다. 이게 강의 노트의 단순화된 표와 다른 점이에요.

### 3.1 READ UNCOMMITTED

> **강의 노트 정정**: 강의에서는 *"SQL Server를 제외하고는 다른 데이터베이스가 지원하지 않는다"* 고 했는데, 이는 부정확합니다.

1차 자료 확인:

- **MySQL InnoDB**: READ UNCOMMITTED를 정식 지원해요 (MySQL 8.4 매뉴얼).
- **PostgreSQL**: SQL 명령 자체는 거부하지 않지만 **내부적으로 Read Committed처럼 처리**합니다. PostgreSQL 공식 문서: *"PostgreSQL's Read Uncommitted mode behaves like Read Committed."*
- **SQL Server**: 정식 지원.

즉 *"MySQL/SQL Server는 정식 지원하고, PostgreSQL은 문법적으로 허용하지만 내부적으로 MVCC 특성상 Dirty Read를 허용하지 않아 Read Committed처럼 동작한다"* 가 정확합니다. PostgreSQL의 읽기는 MVCC 기반 스냅샷으로 처리되며, READ COMMITTED는 statement 단위 스냅샷, REPEATABLE READ는 트랜잭션의 첫 non-transaction-control statement(첫 실제 쿼리) 시점에 고정된 스냅샷을 사용해요(공식 문서: *"a snapshot as of the start of the first non-transaction-control statement in the transaction"*). 어느 경우든 미커밋 데이터를 보는 메커니즘 자체가 존재하지 않아요.

이론적으로 RU는 다른 트랜잭션의 미커밋 변경까지 허용하는 수준이에요 — 격리가 사실상 없는 수준이라 거의 쓰지 않습니다. 다만 위에서 본 것처럼 PostgreSQL은 문법은 허용하되 내부적으로 RC처럼 처리해 Dirty Read 자체를 허용하지 않아요.

### 3.2 READ COMMITTED

커밋된 변경만 봅니다. Dirty Read는 막지만 Non-repeatable Read와 Phantom은 허용해요.

- **PostgreSQL의 기본 격리 수준.**
- **Oracle, SQL Server의 기본 격리 수준이기도 합니다.**
- **MySQL InnoDB의 기본은 Repeatable Read입니다** (아래 참고).

> **강의 노트 정정**: 강의에서 *"많은 데이터베이스에서 이것이 기본 격리 수준이라고 믿습니다"* 라고 했는데, MySQL은 예외예요. MySQL InnoDB의 기본은 Repeatable Read.

### 3.3 REPEATABLE READ

같은 트랜잭션 안에서 같은 행을 다시 읽어도 값이 변하지 않아요. Non-repeatable Read까지 막습니다. **표준상 Phantom은 여전히 가능**하지만 — 실제 DB의 구현은 표준보다 강한 경우가 많아요. 이게 헷갈리는 부분입니다:

| DB | REPEATABLE READ에서 Phantom 발생? |
|---|---|
| **PostgreSQL** | 스냅샷 기반이라 ANSI 정의의 phantom은 발생하지 않음. 다만 predicate 기반 anomaly(write skew)는 여전히 발생 |
| **MySQL InnoDB** | 일반 SELECT(consistent read)는 트랜잭션 스냅샷으로 막고, locking read나 UPDATE/DELETE 검색에서 next-key/gap lock으로 삽입을 차단. 단, Jepsen 검증에 따르면 일부 시나리오에서 write skew 등 anomaly 발생 |
| **표준** | 발생 가능 (이론상) |

PostgreSQL 공식 문서: *"PostgreSQL's Repeatable Read implementation does not allow phantom reads. This is acceptable under the SQL standard because the standard specifies which anomalies must not occur at certain isolation levels; higher guarantees are acceptable."*

> 즉 위키피디아의 표를 곧이곧대로 외우면 PostgreSQL/MySQL의 실제 동작과 어긋나요. 강의가 *"각 DBMS가 격리 수준을 다르게 구현한다"* 고 한 말은 정확합니다.

> **그럼 PostgreSQL은 SERIALIZABLE이 필요 없는가?** 필요해요. ANSI 정의의 phantom은 RR에서 막히지만, 더 일반화된 **predicate 기반 anomaly(write skew)** 는 RR에서 여전히 발생하기 때문이에요. 의사 on-call 같은 *서로 다른 행을 보면서 전체 제약이 깨지는* 시나리오는 SERIALIZABLE의 SSI(predicate read 추적)로만 막힙니다 — 자세한 메커니즘은 다음 섹션에서 다뤄요.

### 3.4 SNAPSHOT ISOLATION

표준 4단계와 별개로 존재하는 격리 수준. **트랜잭션 시작 시점의 일관된 스냅샷**을 봅니다.

**무엇을 막고 무엇을 못 막는가:**

- **Dirty Read, Non-repeatable Read** — 모두 막아요.
- **Phantom (ANSI A3)** — 같은 스냅샷을 보기 때문에 Berenson et al. 정의 기준(A3)의 phantom은 발생하지 않아요. 다만 predicate 기반 충돌(write skew)은 별도의 anomaly로 남습니다.
- **동일 행에 대한 Write-Write Conflict** — *"First-committer-wins"* 규칙으로 감지하고 한쪽을 abort합니다. 이론적 SI는 first-committer-wins로 Lost Update를 방지한다고 정의되지만(Berenson et al. 1995), **실제 DB 구현에서는 보장되지 않을 수 있어요** — PostgreSQL의 RR은 거의 정의대로 동작하지만, MySQL InnoDB의 RR은 read view와 write view가 분리되어 있어 read-modify-write 패턴에서 lost update가 새어나옵니다(아래 박스 참조).
- **Write Skew** — 두 트랜잭션이 *서로 다른 행에 쓰지만* 둘 다 상대방의 read set을 침범하는 경우. SI는 predicate 기반 충돌을 감지하지 못해 이걸 못 잡아요.

**DB 구현마다 동작이 다르다:**

- **PostgreSQL의 REPEATABLE READ**: write-write conflict를 감지해 두 번째 트랜잭션을 abort시킨다 → Lost Update 방지.
- **MySQL InnoDB의 REPEATABLE READ**: InnoDB는 기본적으로 동일 행에 대한 write-write conflict 자체는 감지해요(두 트랜잭션이 같은 행을 동시 UPDATE하면 두 번째는 첫 번째 끝날 때까지 대기). 문제는 **read-modify-write 패턴** — plain SELECT로 옛 스냅샷을 읽고 애플리케이션이 계산한 값을 UPDATE로 덮어쓰면, DB 입장에서는 두 UPDATE 모두 정상 처리되지만 첫 트랜잭션의 변경이 두 번째에 의해 덮어써집니다. 즉 lost update는 DB가 아니라 애플리케이션 로직이 만들어내는 anomaly예요. Jepsen 검증(2023, MySQL 8.0.34)에서 G-single, read skew, lost update 같은 anomaly가 관찰된 것도 이 패턴 때문입니다. 방지 방법:

  - `UPDATE qty = qty + ?` 같은 DB 내 계산 (애플리케이션 read-then-write 흐름을 제거)
  - `SELECT ... FOR UPDATE`로 명시적 행 잠금
  - `WHERE id = ? AND version = ?` 같은 버전 조건부 UPDATE (낙관적 잠금)

> 즉 *"SI는 Lost Update를 막는다"* 는 표현은 모델 정의(Berenson 1995의 First-committer-wins) 기준으로는 정확하지만, 실제 DB 구현에서는 보장 수준이 다릅니다. 면접에서 안전한 표현은 *"SI는 정의적으로 First-committer-wins로 Lost Update(P4)를 방지하지만, MySQL InnoDB처럼 순수 SI가 아닌 구현에서는 특정 패턴에서 발생할 수 있다"* 입니다.

> **Berenson et al. 1995의 정의**: *"Snapshot Isolation histories preclude anomalies A1, A2 and A3."* 즉 ANSI 정의 기준의 phantom(A3)은 막지만, predicate 기반 충돌은 별개의 anomaly(write skew)로 분류돼요.

따라서 **"Snapshot Isolation은 SI ≠ Serializable"** 입니다. 모든 anomaly를 막는 건 SERIALIZABLE이고, SI는 거의 다 막지만 write skew를 허용해요.

**DB별 구현:**

- **PostgreSQL**: REPEATABLE READ는 Snapshot Isolation으로 구현되어 있어요 (공식 문서 명시). SERIALIZABLE은 별도 — SSI(Serializable Snapshot Isolation)로 SI에 충돌 감지를 추가해 write skew까지 막습니다.
- **SQL Server**: 별도의 SNAPSHOT 키워드로 제공. 기본 격리 수준과 별개.
- **MySQL InnoDB**: REPEATABLE READ는 **consistent read와 locking read가 분리된 hybrid 모델**입니다. 일반 SELECT는 트랜잭션 첫 read 시점의 스냅샷을 사용(consistent nonlocking read)하고, `SELECT ... FOR UPDATE`/`UPDATE`/`DELETE` 같은 locking read는 next-key/gap lock으로 삽입을 차단해요. 따라서 *"RR = gap lock으로 phantom 방지"* 라고 단순화하면 안 됩니다. 즉, consistent read는 snapshot을 사용하기 때문에 동일 트랜잭션 내에서는 phantom이 보이지 않지만, locking read는 index range에 대해 next-key lock을 사용하기 때문에 동작 방식이 달라요.

> **왜 MySQL InnoDB의 RR에서 Lost Update가 발생하는가?** MySQL 8.4 공식 문서가 직접 이 분리를 설명해요 — *"non-locking SELECT는 read view 기반(트랜잭션 내 첫 consistent read 시점에 생성된 스냅샷)으로 읽지만, locking statement(UPDATE, DELETE, FOR UPDATE 등)는 most recent state(최신 커밋된 버전)를 기준으로 동작한다."* 즉 UPDATE도 MVCC 기반으로 동작하지만 어느 시점의 버전을 보느냐가 SELECT와 다릅니다.
>
> 핵심은 — MySQL은 **동일 행에 대한 write-write conflict 자체는 감지**하지만(두 트랜잭션이 같은 행을 동시 UPDATE하면 두 번째는 첫 번째가 끝날 때까지 대기), **read-modify-write 패턴은 DB 입장에서 충돌이 아니라 그냥 정상적인 순차 overwrite로 처리**돼요. 첫 트랜잭션이 옛 스냅샷을 읽고 commit한 후, 두 번째 트랜잭션이 또 다른 옛 스냅샷을 읽고 그 위에 덮어쓰면 — 두 UPDATE는 서로 다른 시점에 일어나므로 DB 입장에서는 충돌이 아닙니다. 그래서 lost update가 새어나와요. MySQL 공식 매뉴얼은 이 두 view를 혼용하면 *"한 번도 존재한 적 없는 상태로 보일 수 있다"* 고 표현하며, *"locking statement와 non-locking SELECT를 한 RR 트랜잭션에서 섞는 것은 권장하지 않는다 — 그런 경우는 보통 SERIALIZABLE이 필요한 시나리오다"* 라고 명시합니다. 이게 PostgreSQL의 RR(순수 SI 구현)과 결정적으로 다른 지점입니다.

### 3.5 SERIALIZABLE

가장 강한 수준. 동시 트랜잭션을 마치 하나씩 차례로 실행한 것과 같은 결과만 허용해요. 모든 read anomaly뿐 아니라 write skew까지 방지합니다. 다만 구현에 따라 비용이 다르며 — 잠금 기반(2PL)은 blocking 비용, 낙관적 기반(SSI)은 abort/retry 비용이 발생하며, 특히 충돌이 많은 워크로드에서는 처리량이 크게 떨어질 수 있어요. 클라이언트는 멱등하게 재시도할 수 있어야 한다는 전제가 깔려있습니다.

> **왜 비싼가?** *"직렬화"* 는 트랜잭션을 차례대로 줄 세워서 하나씩 처리하는 것과 같은 효과를 보장한다는 뜻이에요. 동시 실행이 결과적으로 어떤 순차 실행과 동등해야 하므로, DB는 실제로 그렇게 동작하거나(2PL이 잠금으로 강제) 그 결과를 보장할 수 있을 때만 커밋을 허용해야 해요(SSI가 충돌 감지로 강제). 단, 항상 *"가장 느린"* 은 아닙니다. SSI 같은 낙관적 구현은 충돌이 적은 워크로드에서는 SI 비용에 가깝게 동작하지만, 충돌이 많은 워크로드에서는 abort/retry로 처리량이 급락할 수 있어요.

구현 방식은 두 가지예요:

- **2PL(Two-Phase Locking) 기반** — 잠금으로 직렬화. SQL Server의 SERIALIZABLE.
- **SSI(Serializable Snapshot Isolation) 기반** — 스냅샷 격리에 충돌 감지를 추가. 잠금 대신 abort 방식으로 직렬화 가능성을 보장합니다 — 위험한 read-write 의존 패턴을 감지하면 트랜잭션 중 하나를 abort시켜 클라이언트가 재시도하게 해요. PostgreSQL 9.1+의 SERIALIZABLE이 이 방식.

> SERIALIZABLE을 전역적으로 켜는 대신, 필요한 트랜잭션에만 명시적으로 비관적 잠금을 거는 것도 흔한 패턴이에요. `SELECT ... FOR UPDATE`로 특정 행을 트랜잭션 끝까지 잠그면 사실상 그 부분만 직렬화시키는 효과가 있어요. 전체 트랜잭션을 SERIALIZABLE로 격상시키는 것보다 동시성에 미치는 영향이 적습니다.

> **언제 SERIALIZABLE을 써야 하는가?** *"여러 행에 걸친 전체 조건을 만족해야 하는"* 비즈니스 로직 — write skew를 막아야 할 때 필요해요. 동일 행을 동시에 갱신하는 경우(같은 좌석 row 1개에 두 사용자가 INSERT/UPDATE)는 SI의 first-committer-wins나 명시적 행 잠금으로도 막을 수 있어요. SI로 막을 수 없는 대표 예시는 **서로 다른 행을 갱신하지만 전체 조건이 깨지는 경우**입니다 — 예를 들어 의사 2명이 동시에 on-call에서 빠지는 시나리오에서 *"최소 1명은 근무 중이어야 한다"* 는 제약을 둘이 각자의 read snapshot 기준으로 검증하면 둘 다 통과해버려 결국 아무도 근무하지 않는 상태가 돼요.
>
> **원리**: SI는 동일 행에 대한 write-write 충돌만 감지하고 predicate(조건) 기반 충돌은 감지하지 못해요. 두 트랜잭션의 write set이 서로 겹치지 않으면 SI 입장에서 충돌이 없는 것이지만, 실제로는 한쪽의 write가 다른 쪽이 read한 조건의 결과를 바꿔버린 거예요.
>
> 이게 **SERIALIZABLE과 단순 행 잠금의 결정적 차이**예요 — `SELECT ... FOR UPDATE`는 *읽은 행에 대해서만* 직렬화를 보장(read-modify-write 보호에는 충분), SERIALIZABLE은 *predicate까지 포함한 전체 직렬화*(read predicate에 영향을 줄 수 있는 미래의 write까지 추적). PostgreSQL의 SSI는 이를 위해 SIREAD lock을 인덱스 범위에 걸어 read/write 의존성을 추적해요.
>
> **구체적으로 FOR UPDATE로 못 막는 케이스**: `SELECT COUNT(*) FROM doctors WHERE on_call = true` 같은 집계/범위 쿼리는 결과 행을 잠그는 게 의미가 없어요(잠글 행은 조건을 만족하는 행들이고, 다른 트랜잭션이 조건을 만족하지 않던 행을 갱신해 조건을 만족하게 만들 수 있음). 이런 predicate 무결성은 SERIALIZABLE이나 검증 대상 전체 범위를 잠그는 더 넓은 잠금이 필요해요.

> **3장 요약** — 격리 수준은 RU < RC < RR < SERIALIZABLE 4단계지만, 실제 동작은 DB마다 다릅니다. PostgreSQL RR은 SI로 구현되어 ANSI phantom까지 막고, MySQL InnoDB RR은 consistent read와 locking statement가 분리된 hybrid예요. SERIALIZABLE만이 write skew까지 막습니다.

## 4. 격리는 어떻게 구현되는가 — 두 가지 동시성 제어

격리 수준은 명세이고, 실제 구현은 **동시성 제어(Concurrency Control)** 가 담당합니다. 크게 두 갈래예요.

### 4.1 비관적 동시성 제어 (Pessimistic) — 잠금

*"충돌이 일어날 것이라고 가정"* 하고, 미리 잠금을 걸어 막아요.

- **행 잠금 (Row-level lock)**: 가장 인기 있어요. 변경 중인 행만 다른 트랜잭션이 못 건드리게 합니다.
- **페이지 잠금 (Page-level lock)**: 페이지 단위로 잠가요. 클러스터링 인덱스 페이지를 동시에 변경하는 것을 막는 데 씁니다.
- **테이블 잠금 (Table-level lock)**: 테이블 전체. 매우 비싸요.

> **Lock Escalation**: 행 잠금이 너무 많아지면(예: 한 트랜잭션이 수십만 행을 변경) 일부 DB는 자동으로 페이지 잠금이나 테이블 잠금으로 격상시킬 수 있어요. 그 결과 다른 트랜잭션들이 줄줄이 대기하게 됩니다. **긴 트랜잭션이 나쁜 또 다른 이유**예요.
>
> 단, Lock Escalation은 DB마다 동작이 매우 달라요:
>
> - **SQL Server**: 명시적으로 발생 (lock 5,000개 또는 메모리 임계 초과 시 자동 escalation, `LOCK_ESCALATION` 옵션으로 제어 가능).
> - **PostgreSQL**: 일반적으로 row lock을 유지하며 traditional escalation은 발생하지 않아요. 구조적 이유 — PostgreSQL은 row lock을 lock table 메모리에 저장하지 않고 행 자체에 기록하므로(공식 문서: *"PostgreSQL doesn't remember any information about modified rows in memory"*), escalation을 트리거할 메모리 압박 자체가 없습니다.
> - **MySQL InnoDB**: 일반적으로 row-level locking을 유지하며 자동 escalation을 수행하지 않아요.
>
> 이 차이는 대량 UPDATE 상황에서 SQL Server와 PostgreSQL/MySQL의 동작이 갈라지는 중요한 지점입니다 — SQL Server는 escalation으로 인해 큰 UPDATE가 갑자기 테이블 전체를 잠가버릴 수 있지만, PostgreSQL/MySQL은 row lock을 그대로 유지해요. 단, 이게 SQL Server가 전반적으로 동시성에 약하다는 뜻은 아닙니다 — RCSI나 SNAPSHOT 옵션을 켜면 SQL Server도 row versioning 기반으로 동작해요.

> **잠금 관리 자체가 비싼 이유** — SQL Server처럼 lock table을 메모리에 두는 시스템에서는, 모든 잠금 정보를 추적해야 합니다. 한 트랜잭션이 700,000개 행을 행 잠금으로 잠그면 그 700,000개 잠금 정보를 다 메모리에 들고 있어야 해요 — 그래서 테이블 단위 일괄 작업에서 메모리 압박이 심해지고, 이게 SQL Server에서 lock escalation이 일어나는 직접적 이유입니다. PostgreSQL은 이 문제를 lock 정보를 행에 직접 저장하는 방식으로 우회해요.

### 4.2 낙관적 동시성 제어 (Optimistic) — 잠금 없음

*"충돌은 드물다고 가정"* 하고, 일단 진행한 뒤 커밋 시점에 충돌을 감지해 한쪽을 실패시킵니다.

- 잠금 관리 비용이 없어요 → 동시성 ↑
- 충돌 시 트랜잭션이 **직렬화 오류(serialization failure)** 로 실패하고 클라이언트가 재시도해야 합니다.
- PostgreSQL의 SERIALIZABLE(SSI)이 대표적. 일부 NoSQL 시스템도 conditional write, CAS, 버전 조건부 갱신 같은 낙관적 충돌 감지 방식을 제공해요 (예: DynamoDB의 conditional write, MongoDB의 document-level concurrency, Cassandra의 LWT).

### 4.3 MVCC — 두 진영의 결합

대부분의 현대 RDBMS는 **MVCC(Multi-Version Concurrency Control)** 로 두 접근을 결합해요.

![MVCC 두 진영](/uploads/theory/transaction-acid/mvcc-comparison.svg)

> **MVCC의 핵심**: **읽기와 쓰기의 직접적인 blocking을 최소화**하는 것. 읽기는 과거 버전을, 쓰기는 충돌만 제어하도록 분리합니다 (단, write-write 충돌이나 명시적 locking read는 여전히 blocking이 발생할 수 있어요).

이게 결정적이에요. 읽기는 snapshot 기준으로 수행되고, 쓰기 간 충돌만 locking 또는 validation으로 처리됩니다. 그 결과 **읽기와 쓰기가 서로를 막지 않아요.** A편에서 다룬 `xmin`/`xmax`(PostgreSQL)와 `DB_ROLL_PTR`(InnoDB)이 바로 MVCC를 위한 메커니즘입니다.

#### PostgreSQL의 MVCC — 새 튜플 생성 + 가시성 관리

UPDATE가 와도 기존 튜플을 in-place로 덮어쓰지 않고 새 튜플을 생성해요. 옛 튜플은 그대로 두고 가시성 규칙으로 관리합니다. 트랜잭션 시작 시점의 스냅샷 ID를 기준으로 어떤 버전을 볼지 결정돼요.

> 엄밀히 말하면 순수 append-only는 아닙니다. **HOT(Heap-Only Tuple) update** 최적화가 있어서, 인덱스 컬럼이 변경되지 않고 같은 페이지에 공간이 있으면 인덱스를 갱신하지 않고 같은 페이지 내에서 새 튜플을 추가해요. 그래도 **기존 튜플을 즉시 덮어쓰지는 않는다**는 점이 InnoDB의 in-place update와 다른 핵심입니다.

![PostgreSQL — 한 페이지에 옛/새 튜플 공존, 가시성으로 분기](/uploads/theory/transaction-acid/pg-tuple-versions.svg)

#### InnoDB의 MVCC — Undo Log 기반 버전 재구성

PostgreSQL처럼 테이블 힙에 여러 튜플 버전을 쌓기보다는, clustered index record에는 현재 버전을 두고 **Undo Log 체인**을 통해 이전 버전을 재구성해요 (in-place update). 행 헤더의 `DB_ROLL_PTR`이 Undo Log 안의 옛 버전을 가리키는 포인터 역할을 합니다.

![InnoDB — 현재 버전은 in-place, 옛 버전은 Undo Log 체인](/uploads/theory/transaction-acid/innodb-undo-chain.svg)

장기 실행 트랜잭션이 있으면 그 스냅샷이 보는 옛 버전을 purge할 수 없어서 Undo Log가 부풀어 오릅니다(History List Length 증가). Undo chain이 길어지면 snapshot read 비용이 증가하고, purge가 지연되면 성능 저하로 이어져요.

#### 비교

| 항목 | PostgreSQL | MySQL InnoDB |
|---|---|---|
| 메인 데이터 | 모든 버전이 힙에 누적 | 최신 버전만 in-place |
| 옛 버전 위치 | 같은 테이블 페이지 | 별도 Undo Log |
| 옛 버전 조회 | 페이지에서 즉시 (포인터 따라가기) | Undo Log를 거꾸로 추적해 재구성 |
| 정리 메커니즘 | VACUUM | purge thread |
| 옛 버전 조회 비용 | 페이지 내 tuple/HOT chain과 가시성 체크 영향을 받음 | Undo Log 체인이 길수록 비용 증가 |

> 강의 노트의 *"장기 실행 트랜잭션에서 InnoDB는 최신 값에 신뢰할 수 없어 비용이 많이 든다"* 는 표현은 정확히 이 얘기예요.

> **4장 요약** — 격리는 비관적 잠금과 낙관적 충돌 감지 두 갈래로 구현되며, 현대 RDBMS는 MVCC로 두 접근을 결합해 읽기와 쓰기의 직접적 blocking을 최소화합니다. PostgreSQL은 새 튜플을 힙에 추가하고 InnoDB는 Undo Log 체인으로 옛 버전을 재구성해요.

## 5. 격리 수준 정리표 (DB별 실제 동작)

표준만 보면 안 돼요. 같은 REPEATABLE READ라도 PostgreSQL은 SI에 가깝고, MySQL InnoDB는 consistent read + locking read + next-key/gap lock이 섞인 hybrid라 동작이 다릅니다. **이름은 표준이지만 의미는 제품 종속이에요.**

| 격리 수준 | PostgreSQL | MySQL InnoDB | SQL Server |
|---|---|---|---|
| READ UNCOMMITTED | Read Committed로 자동 승격 | 정식 지원 | 정식 지원 |
| READ COMMITTED | 기본값 | 옵션 | 기본값 — `READ_COMMITTED_SNAPSHOT` OFF(기본)면 locking 기반, ON이면 MVCC처럼 row versioning 사용. Azure SQL은 기본 ON |
| REPEATABLE READ | 스냅샷 기반 — ANSI 정의의 phantom은 발생하지 않지만 predicate 기반 anomaly(write skew)는 여전히 가능 | 기본값, consistent read는 스냅샷 / locking read는 next-key/gap lock | 잠금 기반 — 읽은 행만 보호하며, 범위 조건은 SERIALIZABLE의 key-range lock에서만 보호됨 |
| SNAPSHOT | 별도 SNAPSHOT 키워드 없음 — REPEATABLE READ가 Snapshot Isolation에 해당 | 별도 SNAPSHOT 격리 수준 없음. RR의 consistent read는 snapshot 기반이지만 locking statement는 next-key/gap lock과 최신 커밋 상태를 사용하는 hybrid 모델 | 별도 옵션 (`ALLOW_SNAPSHOT_ISOLATION ON` + `SET TRANSACTION ISOLATION LEVEL SNAPSHOT`) |
| SERIALIZABLE | SSI 기반 (write skew까지 막음) | 잠금 기반 (`SELECT ... FOR SHARE`로 변환) | 잠금 기반 — key-range lock으로 범위 조건을 보호하여 phantom 방지 |

> SQL 표준은 SERIALIZABLE을 기본값으로 권장하지만, 그렇게 따르는 주요 DB는 사실상 없어요. PostgreSQL/SQL Server/Oracle은 Read Committed, MySQL은 Repeatable Read.

## 6. 실무에서 어떤 격리 수준을 언제 쓰는가

이론은 끝났고, 진짜 질문은 *"그래서 내 시스템에는 뭘 써야 하나?"* 예요. 일반적인 가이드라인:

### 워크로드별 권장 수준

**일반 OLTP (REST API, 트랜잭션 처리) → READ COMMITTED**

- 대부분의 비즈니스 애플리케이션의 합리적 기본값.
- PostgreSQL/SQL Server/Oracle의 기본값이기도 해요.
- 짧은 트랜잭션이 많고, 약간의 비일관성(non-repeatable read)은 허용 가능한 경우.
- **왜 성능적으로 유리한가**: 짧은 트랜잭션 + 최신 데이터 우선 + 충돌 적음이 전형적인 OLTP 특성인데, RC는 statement 단위 스냅샷만 유지하면 되므로 일반적으로 RR/SERIALIZABLE보다 장기 스냅샷 유지 부담이 작고, 직렬화 실패에 의한 재시도도 거의 없어 throughput에 유리합니다.

**보고서 / 배치 / 분석 트랜잭션 → REPEATABLE READ (= Snapshot Isolation)**

- 트랜잭션 동안 *"같은 데이터의 일관된 뷰"* 가 필요한 경우.
- 매출 집계, 회계 마감, 일별 통계 등.
- PostgreSQL의 RR이 SI로 동작하므로 이런 용도에 매우 적합해요.
- **왜 성능적으로 유리한가**: 보고서 트랜잭션은 길고 read-heavy인데, SI는 잠금 없이 일관된 스냅샷을 제공하므로 동시 OLTP 트래픽을 막지 않아요. 같은 일관성을 잠금 기반으로 구현하면 다른 트랜잭션이 줄줄이 대기해 throughput이 무너집니다.

**재고 / 한도 / 제약 검증 → 상황에 맞는 단계적 선택**

상황의 제약 범위에 따라 해결 방법이 달라요. 단순한 것부터:

1. **단일 row의 단순 증감/차감** → **원자적 조건부 UPDATE**면 충분.
   - 예: `UPDATE stock SET qty = qty - 1 WHERE id = ? AND qty > 0`
   - 예: `UPDATE account SET balance = balance - ? WHERE id = ? AND balance >= ?`
   - DB가 자동으로 행 잠금을 잡고 조건을 원자적으로 검증해요. SERIALIZABLE 불필요.

2. **read-modify-write가 필수인 경우** → `SELECT ... FOR UPDATE`로 명시적 행 잠금.
   - 애플리케이션 로직이 복잡해서 DB 표현식으로 못 줄이는 경우.

3. **충돌이 드물고 재시도 비용 낮음** → 버전 기반 낙관적 잠금 (`WHERE version = ?`).

4. **여러 행에 걸친 predicate 제약** → SERIALIZABLE 또는 더 넓은 잠금 전략.
   - 예: 의사 2명 중 최소 1명은 on-call이어야 한다(서로 다른 행에서 검증).
   - 단순 FOR UPDATE는 이미 선택된 행만 보호하므로, predicate 자체를 보호하려면 SSI나 검증 대상 전체 범위를 잠그는 더 넓은 잠금이 필요해요.

> **흔한 실수**: *"재고 차감이니까 SERIALIZABLE 써야지"* 라고 일괄 적용. 사실 단일 row 차감은 위 #1로 해결되며, SERIALIZABLE은 진짜 predicate 기반 write skew가 있을 때만 필요합니다. 잘못된 일괄 적용은 throughput만 깎아먹어요.

> 위 단계의 결정적 차이 — `FOR UPDATE`(#2)는 *선택된 행 단위 직렬화*(read-modify-write 보호에는 충분), SERIALIZABLE(#4)은 *predicate까지 추적하는 전체 직렬화*(읽지 않은 미래의 행까지 포함). 따라서 의사 on-call 같은 predicate 기반 write skew는 단순 FOR UPDATE로는 막히지 않을 수 있어요.

> **왜 부분적으로만 적용하는가**: SERIALIZABLE은 SSI든 2PL이든 충돌 시 abort/retry나 blocking 비용이 발생합니다. 충돌 가능성이 있는 일부 트랜잭션에만 적용하면 전체 throughput 손실을 최소화하면서 정합성을 확보할 수 있어요.

**대량 분석 쿼리 / 보고서 (정합성 손상 감수 가능) → 신중하게 선택**

- 일반적으로는 별도 read replica나 데이터 웨어하우스에서 처리하는 것이 안전해요.
- 같은 DB에서 처리해야 한다면 **REPEATABLE READ(=Snapshot Isolation)** 가 가장 균형 잡힌 선택입니다 — 일관된 스냅샷을 보면서도 다른 트랜잭션을 막지 않아요.
- READ UNCOMMITTED는 SQL Server의 NOLOCK 힌트처럼 *"정합성을 포기하고 잠금 비용을 줄여야 하는"* 매우 제한적인 상황에서만 써요. 일반 권장값으로 두기 어렵고, 글 앞부분에서 다룬 Dirty Read 위험을 그대로 떠안게 된다는 점을 인지해야 합니다.

### 안티패턴 — 자주 보는 실수

- **"빠르게 만들기 위해" 격리 수준을 낮추기** — 측정도 안 한 채로 RC를 RU로 낮추는 건 거의 항상 잘못된 결정이에요. MVCC 기반 DB에서는 성능 차이도 크지 않습니다.
- **`SELECT ... FOR UPDATE`를 무차별 사용** — *"안전하게 하자"* 고 모든 SELECT에 FOR UPDATE를 거는 코드를 본 적이 있다면, 그 시스템은 hot row contention으로 죽어요. 정말 동시 수정이 일어나는 행에만 써야 합니다.
- **트랜잭션 안에 외부 API 호출** — 결제 API나 이메일 발송을 트랜잭션 안에 넣으면 트랜잭션이 길어지고, 그동안 잠금 또는 옛 버전이 유지되어 다른 트랜잭션을 막아요. 외부 호출은 트랜잭션 밖으로.

## 7. 낙관적 vs 비관적 — 언제 어느 것을 선택하는가

격리 수준을 정했다면 다음 질문은 동시성 제어 전략입니다.

**비관적 (`SELECT ... FOR UPDATE`, 행 잠금)이 유리한 경우**

- **충돌이 잦은 hot row** — 인기 상품의 재고, 자주 갱신되는 카운터.
- **재시도 비용이 큰 작업** — 트랜잭션이 길거나 외부 시스템과 연동되어 있어서 다시 실행하기 어려운 경우.
- **순서가 중요한 작업** — 큐에서 다음 작업을 가져오기, 분산 락 구현.

**낙관적 (버전 번호, CAS, SSI)이 유리한 경우**

- **충돌이 드문 워크로드** — 사용자가 자기 데이터만 수정하는 경우.
- **읽기 위주 시스템** — 잠금 비용 없이 동시성을 높일 수 있어요.
- **분산 시스템** — 노드 간 잠금 조정 비용이 비싸므로 낙관적 접근이 일반적입니다. 일부 분산 저장소가 conditional write/CAS 계열 연산을 제공하는 이유도 이와 연결돼요(제품마다 의미와 보장이 다르므로 개별 확인 필요).

### 애플리케이션 레벨 패턴

ORM과 함께 자주 보는 패턴들:

- **Hibernate/JPA의 `@Version`** — 행에 version 컬럼을 두고, UPDATE 시 `WHERE id = ? AND version = ?` 조건을 자동으로 붙여요. 다른 트랜잭션이 먼저 갱신했다면 0행 update가 되어 `OptimisticLockException`이 발생합니다. 이게 낙관적 잠금의 표준 구현.
- **Spring의 `@Transactional`과 격리 수준** — 트랜잭션마다 다른 격리 수준을 지정할 수 있어요. 보고서 트랜잭션은 RR, 일반 처리는 RC, 재고 차감은 SERIALIZABLE — 이런 식으로 세분화하면 전역 설정보다 효율적입니다.
- **재시도 로직** — 낙관적 잠금이나 SSI를 쓰면 직렬화 오류로 트랜잭션이 실패할 수 있어요. 클라이언트는 멱등하게 재시도할 수 있어야 합니다.

### 트랜잭션 자체에 대한 일반 규칙

격리 수준과 무관하게, 모든 트랜잭션은 짧을수록 좋아요:

- 짧을수록 잠금 보유 시간이 줄어 다른 트랜잭션을 덜 막아요.
- 짧을수록 PostgreSQL의 VACUUM, MySQL의 purge thread가 더 빨리 일할 수 있어요 (A편 참조).
- 짧을수록 충돌 가능성이 낮아 직렬화 실패 / 재시도가 줄어요.
- 짧을수록 크래시 시 복구해야 할 양이 적어요.

A편의 결론과 같습니다 — **트랜잭션은 비즈니스 로직 단위로 짧고 응집력 있게.**

## 8. 정리

- **격리(Isolation)** 는 동시 트랜잭션 사이에서 **변경의 가시성을 어디까지 허용할지의 문제**예요.
- **SQL 표준이 정의한 읽기 현상은 3가지** — Dirty Read, Non-repeatable Read, Phantom. **Lost Update**는 표준 외 anomaly지만 실무에서 매우 자주 만나요.
- **격리 수준은 4단계** — READ UNCOMMITTED < READ COMMITTED < REPEATABLE READ < SERIALIZABLE. 강할수록 안전하지만 동시성이 떨어집니다.
- **표준은 최소 보장만 정의**해요. 실제 DB는 표준보다 강하게 구현할 수 있고(PostgreSQL 공식 문서: *"higher guarantees are acceptable"*), 표준이 명시적으로 포착하지 못한 anomaly(write skew, lost update 등)는 DB별로 다르게 남을 수 있어요. 예: PostgreSQL의 REPEATABLE READ는 phantom까지 막지만, MySQL의 REPEATABLE READ는 Jepsen 검증 기준 특정 read-modify-write 패턴에서 lost update가 발생할 수 있습니다. 따라서 같은 격리 수준 이름이라도 DB마다 실제 보장 수준은 달라요.
- **Snapshot Isolation ≠ Serializable.** 이론적 SI는 first-committer-wins 규칙으로 P4(Lost Update)까지 모델 정의 수준에서 막는다고 설명되지만(Berenson 1995), 실제 DB에서는 update 방식과 conflict detection 구현에 따라 보장 수준이 달라져요. 제품별 문서와 검증 결과를 따로 확인해야 합니다. SI는 어떤 구현이든 **write skew는 막지 못하며**, SERIALIZABLE은 SSI나 잠금으로 이를 차단해요.
- **언제 SERIALIZABLE이 필요한가**: 여러 행에 걸친 predicate 제약이 깨질 위험이 있는 경우 — 의사 on-call 최소 인원, 여러 계좌 합계 한도 같은 시나리오. 단일 row의 단순 차감/검증은 원자적 조건부 UPDATE로 해결되므로 SERIALIZABLE이 필요하지 않아요.
- **구현은 두 갈래** — 비관적(잠금) vs 낙관적(충돌 감지). 대부분의 현대 RDBMS는 **MVCC로 두 접근을 결합**해서 읽기-쓰기를 서로 막지 않아요.
- **PostgreSQL MVCC**는 UPDATE 시 새 튜플을 생성하고 가시성 규칙으로 관리, VACUUM이 정리. **InnoDB MVCC**는 clustered index record에 현재 버전을 두고 Undo Log 체인으로 이전 버전을 재구성. A편에서 다룬 롤백 비용 차이가 여기서도 그대로 작용합니다.
- **실무 가이드**: OLTP는 RC, 보고서/배치는 RR(=SI), 재고/예약/한도 검증은 SERIALIZABLE 또는 명시적 `SELECT ... FOR UPDATE`. 격리 수준은 트랜잭션마다 다르게 지정 가능하므로 워크로드별로 세분화하면 효율적이에요.
- **트랜잭션은 짧게** — 격리 수준과 무관하게 모든 면(잠금 보유, VACUUM/purge, 충돌 가능성, 크래시 복구)에서 짧은 트랜잭션이 유리합니다.

## 참고 (1차 자료 우선)

- [PostgreSQL Documentation: Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
- [MySQL 8.4 Reference Manual: Transaction Isolation Levels](https://dev.mysql.com/doc/refman/8.4/en/innodb-transaction-isolation-levels.html)
- [SQL Server: SET TRANSACTION ISOLATION LEVEL — Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/statements/set-transaction-isolation-level-transact-sql)
- Berenson et al. — *A Critique of ANSI SQL Isolation Levels* (1995) — Lost Update, Write Skew 등의 출처
- [Wikipedia: Isolation (database systems)](https://en.wikipedia.org/wiki/Isolation_(database_systems))
- [No Dirty Reads: Everything you wanted to know about SQL isolation levels — Cockroach Labs](https://www.cockroachlabs.com/blog/sql-isolation-levels-explained/)
- [Isolation Repeatable Read in PostgreSQL versus MySQL — verite.pro](https://verite.pro/blog/isolation-repeatable-read-postgresql-vs-mysql.html)
- [MySQL performance implications of InnoDB isolation modes — Percona](https://www.percona.com/blog/innodbs-gap-locks/)
- [Jepsen: MySQL 8.0.34 — Repeatable Read 분석](https://jepsen.io/analyses/mysql-8.0.34) — MySQL RR이 G2-item, lost update, read skew 등의 anomaly를 보인다는 정밀 검증
- [What if MySQL's Repeatable Reads Cause You to Lose Money? — Percona](https://www.percona.com/blog/lost-updates-in-innodb/) — MySQL RR의 Lost Update 시나리오 실증
- [A beginner's guide to database locking and the lost update phenomena — Vlad Mihalcea](https://vladmihalcea.com/a-beginners-guide-to-database-locking-and-the-lost-update-phenomena/) — PostgreSQL은 RR에서 Lost Update 방지하지만 MySQL은 그렇지 않다는 비교

<!-- EN -->

> **Core message of this post**: **"Do not judge actual behavior just from the isolation-level name."** The same REPEATABLE READ behaves differently between PostgreSQL and MySQL InnoDB, and the same SERIALIZABLE has different cost structures between SSI-based and lock-based implementations. The standard defines only minimum guarantees; actual behavior is product-specific.

## 1. The Real Problem Isolation Has to Solve

If a DB had only one client, you would not need isolation. Just process transactions one by one. But in reality, many TCP connections execute transactions concurrently. So **how concurrently running transactions should see each other's changes** — that is the essence of isolation.

It compresses to one core question:

> "Should my in-progress transaction be able to see other transactions' changes?"

- **Should** → concurrency↑, consistency↓
- **Should not** → consistency↑, concurrency↓

There is no right answer. It depends on the workload. The tool that expresses this trade-off is the **isolation level**, and the abnormal behaviors that occur when isolation is not strong enough are **read phenomena**.

> **Why isolation-level bugs are so painful?** Bugs caused by isolation levels are among the hardest to debug in the DB space. They do not reproduce (timing-dependent), only show up under load tests sometimes, or only happen in production. Code looks fine but results are wrong — most such bugs are isolation or concurrency issues. So knowing this concept makes a real difference in practice.

## 2. Read Phenomena

First, an accurate fact. **The SQL standard (ANSI SQL-92) officially defines 3 read phenomena** — Dirty Read, Non-repeatable Read, Phantom Read. **"Lost Update" is an anomaly added in a follow-up paper** (*A Critique of ANSI SQL Isolation Levels*, Berenson et al. 1995); it is not the standard's 4th phenomenon. But it is so important in practice that we cover it together.

![Four read phenomena](/uploads/theory/transaction-acid/read-phenomena.svg)

### 2.1 Dirty Read — reading uncommitted values

![Dirty Read flow — reading an uncommitted value](/uploads/theory/transaction-acid/dirty-read-flow.svg)

In the same transaction, the per-row sum (50+80=130) and SUM (155) do not match — the report goes out inconsistent. And if Tx2 rolls back, the data **never existed in the first place**. The most intuitively dangerous read phenomenon.

> **Common anti-pattern**: enabling Dirty Read intentionally because *"no lock cost, so it is faster."* Looks faster short-term, but reading values that never existed and running business logic on them collapses data integrity. Such decisions almost always come back as regret.

### 2.2 Non-repeatable Read — same value changes mid-transaction

![Non-repeatable Read flow — same row read twice gives different values](/uploads/theory/transaction-acid/non-repeatable-flow.svg)

Unlike Dirty Read, all values read are committed values. So it is more subtle. The crux: *"reading the same row twice in the same transaction returned different values."*

> A common doubt: *"do you really read the same row twice?"* Yes — different queries often depend on the same row. In the example above, the first query is per-product detail, the second is SUM — both depend on product 1's qty.

### 2.3 Phantom Read — rows that did not exist suddenly appear

![Phantom Read flow — a new row sneaks into a range query](/uploads/theory/transaction-acid/phantom-flow.svg)

Looks similar to Non-repeatable Read but is different.

| Aspect | Non-repeatable Read | Phantom Read |
|---|---|---|
| Target | an already-read existing row changes | a new row that was not there sneaks in |
| Prevention | lock the read row or pin its version | lock the range itself (e.g., gap lock) or use a snapshot |

The reason to distinguish them: **implementation cost is completely different.** Locking a row you read is relatively easy — *"don't change this row I read until my tx ends."* But **you cannot lock a row you never read.** That is why phantoms are harder.

> Phantom is more potentially common in range queries than people realize. PK single-row lookups are phantom-irrelevant, but every range condition or non-unique WHERE predicate is a potential phantom risk — `WHERE created_at BETWEEN ...`, `WHERE status = 'pending'`, `WHERE category = 'electronics'`. That said, phantoms often have no observable effect (when application logic tolerates new rows), so they may not surface depending on isolation level or timing. Range-based validation logic deserves special care.

### 2.4 Lost Update — concurrent updates overwrite each other

![Lost Update flow — read-modify-write where one side disappears](/uploads/theory/transaction-acid/lost-update-flow.svg)

Tx1 and Tx2 read the same starting value (10), each computes, and writes — **the later commit overwrites the earlier one.** Should be 15+10=25 but ends as 20. Tx2's +5 is gone.

> A non-standard anomaly but the most frequent concurrency bug in practice. Usually solved with row locks (`SELECT ... FOR UPDATE`) or optimistic concurrency control (version numbers, CAS).

> **Why is Lost Update particularly dangerous?** Other read phenomena can also lead to wrong decisions, wrong settlements, duplicate processing — none are light. But Lost Update is one step further — **a write that already hit disk is permanently overwritten by another transaction**, a direct data loss. Inventory counts go wrong, balances accumulate incorrectly, seats get double-booked. So among the four anomalies, the business impact is the most immediate and the hardest to recover from.

> **Section 2 takeaway** — The SQL standard defines three read phenomena (Dirty/Non-repeatable/Phantom). Lost Update is non-standard but the most frequent concurrency bug in practice.

## 3. Isolation Levels

The SQL standard defines four isolation levels — from weak to strong.

![Isolation levels — standard vs reality](/uploads/theory/transaction-acid/isolation-levels.svg)

| Isolation level | Dirty Read | Non-repeatable | Phantom |
|---|---|---|---|
| READ UNCOMMITTED | possible | possible | possible |
| READ COMMITTED | prevented | possible | possible |
| REPEATABLE READ | prevented | prevented | possible per standard |
| SERIALIZABLE | prevented | prevented | prevented |

The standard defines **minimum guarantees only.** Actual DBs may provide stronger ones. This is what differs from the simplified table in lecture notes.

### 3.1 READ UNCOMMITTED

> **Lecture note correction**: a lecture saying *"only SQL Server supports it; other DBs don't"* is inaccurate.

Primary-source check:

- **MySQL InnoDB**: officially supports READ UNCOMMITTED (MySQL 8.4 manual).
- **PostgreSQL**: does not reject the SQL command but **internally treats it like Read Committed.** Official doc: *"PostgreSQL's Read Uncommitted mode behaves like Read Committed."*
- **SQL Server**: officially supports it.

So accurately: *"MySQL/SQL Server officially support it; PostgreSQL accepts the syntax but, by MVCC nature, does not allow Dirty Reads and behaves like Read Committed."* PostgreSQL reads via MVCC snapshots — READ COMMITTED uses a per-statement snapshot; REPEATABLE READ uses a snapshot fixed at the start of the transaction's first non-transaction-control statement (per docs: *"a snapshot as of the start of the first non-transaction-control statement in the transaction"*). Either way, no mechanism to see uncommitted data exists.

Theoretically RU allows seeing other transactions' uncommitted changes — essentially no isolation, almost never used. As shown above, PostgreSQL accepts the syntax but internally treats it as RC and does not allow Dirty Reads.

### 3.2 READ COMMITTED

Sees only committed changes. Prevents Dirty Read but allows Non-repeatable Read and Phantom.

- **PostgreSQL's default isolation level.**
- **Also the default for Oracle, SQL Server.**
- **MySQL InnoDB's default is Repeatable Read** (see below).

> **Lecture note correction**: a claim like *"I believe many DBs use this as default"* — MySQL is an exception. MySQL InnoDB's default is Repeatable Read.

### 3.3 REPEATABLE READ

In the same transaction, re-reading the same row returns the same value. Prevents Non-repeatable Read. **Per standard, Phantom is still possible** — but actual DB implementations are often stronger than the standard. This is the confusing part:

| DB | Phantom in REPEATABLE READ? |
|---|---|
| **PostgreSQL** | snapshot-based; ANSI-defined phantom does not occur. But predicate-based anomaly (write skew) still occurs. |
| **MySQL InnoDB** | plain SELECT (consistent read) blocks via the transaction snapshot; locking read or UPDATE/DELETE searches block insertions via next-key/gap lock. Per Jepsen testing, some scenarios still allow anomalies like write skew. |
| **Standard** | possible (in theory) |

PostgreSQL official doc: *"PostgreSQL's Repeatable Read implementation does not allow phantom reads. This is acceptable under the SQL standard because the standard specifies which anomalies must not occur at certain isolation levels; higher guarantees are acceptable."*

> If you memorize the Wikipedia table verbatim, it diverges from PostgreSQL/MySQL's actual behavior. The lecture's *"each DBMS implements isolation levels differently"* is accurate.

> **Then does PostgreSQL not need SERIALIZABLE?** It does. ANSI-defined phantom is blocked at RR, but the more general **predicate-based anomaly (write skew)** still occurs at RR. Scenarios like the on-call doctors — *checking different rows but breaking a global constraint* — are only blocked by SERIALIZABLE's SSI (predicate read tracking). Mechanism details are in the next section.

### 3.4 SNAPSHOT ISOLATION

Separate from the four standard levels. Sees a **consistent snapshot as of the transaction start.**

**What it blocks and what it does not:**

- **Dirty Read, Non-repeatable Read** — both blocked.
- **Phantom (ANSI A3)** — same snapshot, so the Berenson et al. (A3) phantom does not occur. But predicate-based conflict (write skew) remains as a separate anomaly.
- **Write-Write Conflict on the same row** — detected and one is aborted by the *"First-committer-wins"* rule. Theoretical SI is defined to prevent Lost Update by first-committer-wins (Berenson et al. 1995), but **actual DB implementations may not guarantee it** — PostgreSQL's RR behaves close to definition, but MySQL InnoDB's RR separates read view and write view, so Lost Update leaks in read-modify-write patterns (see the box below).
- **Write Skew** — two transactions write *different rows* but each invades the other's read set. SI does not detect predicate-based conflicts and so does not catch this.

**Implementation differs by DB:**

- **PostgreSQL REPEATABLE READ**: detects write-write conflict and aborts the second transaction → prevents Lost Update.
- **MySQL InnoDB REPEATABLE READ**: InnoDB does detect write-write conflict on the same row by default (two concurrent UPDATEs to the same row → second waits for the first). The problem is the **read-modify-write pattern** — read an old snapshot via plain SELECT, the application computes a value, then UPDATE overwrites; from the DB's perspective both UPDATEs are normal but the first transaction's change is overwritten by the second. So Lost Update is an anomaly that application logic produces, not the DB. Anomalies observed in Jepsen's testing (2023, MySQL 8.0.34) — G-single, read skew, lost update — are all due to this pattern. Mitigations:

  - DB-side computation like `UPDATE qty = qty + ?` (eliminates the application read-then-write flow)
  - Explicit row lock with `SELECT ... FOR UPDATE`
  - Version-conditional UPDATE like `WHERE id = ? AND version = ?` (optimistic locking)

> So the phrase *"SI prevents Lost Update"* is accurate per model definition (Berenson 1995's First-committer-wins), but actual DB implementations differ. A safe interview phrasing: *"SI by definition prevents Lost Update (P4) via First-committer-wins, but in non-pure-SI implementations like MySQL InnoDB, it can still occur in specific patterns."*

> **Berenson et al. 1995 definition**: *"Snapshot Isolation histories preclude anomalies A1, A2 and A3."* So the ANSI-defined phantom (A3) is blocked, but predicate-based conflicts are classified as a separate anomaly (write skew).

So **"Snapshot Isolation ≠ Serializable"**. Only SERIALIZABLE blocks every anomaly; SI blocks almost all but allows write skew.

**Per-DB implementation:**

- **PostgreSQL**: REPEATABLE READ is implemented as Snapshot Isolation (per official docs). SERIALIZABLE is separate — SSI (Serializable Snapshot Isolation) adds conflict detection on top of SI to also block write skew.
- **SQL Server**: provides a separate `SNAPSHOT` keyword. Independent of the default isolation level.
- **MySQL InnoDB**: REPEATABLE READ is a **hybrid model with consistent read and locking read separated.** Plain SELECT uses a snapshot from the transaction's first read (consistent nonlocking read); locking reads like `SELECT ... FOR UPDATE`/`UPDATE`/`DELETE` block insertions with next-key/gap lock. So do not simplify it as *"RR = phantom-prevention via gap lock."* Within the same transaction, consistent reads do not see phantoms (snapshot), but locking reads use next-key locks over index ranges and behave differently.

> **Why does MySQL InnoDB's RR allow Lost Update?** MySQL 8.4 official docs explain the split directly — *"non-locking SELECT reads using a read view (a snapshot created at the transaction's first consistent read), but locking statements (UPDATE, DELETE, FOR UPDATE, etc.) operate on the most recent state (latest committed version)."* So UPDATE is also MVCC-based, but which version it sees differs from SELECT.
>
> The crux — MySQL **does detect write-write conflict on the same row** (two concurrent UPDATEs to the same row → second waits), but the **read-modify-write pattern is not a conflict to the DB; it is just a normal sequential overwrite.** First transaction reads an old snapshot and commits, then the second reads another old snapshot and overwrites — the two UPDATEs happen at different points in time, so to the DB it is no conflict. That is how Lost Update leaks. The MySQL official manual phrases mixing the two views as *"may produce a state that has never existed,"* and explicitly states *"mixing locking statements with non-locking SELECTs in a single RR transaction is not recommended — that is usually a scenario that needs SERIALIZABLE."* This is the decisive point that differs from PostgreSQL's RR (a pure SI implementation).

### 3.5 SERIALIZABLE

The strongest level. Allows only outcomes equivalent to running the concurrent transactions one by one in some order. Prevents not only every read anomaly but also write skew. Cost varies by implementation — lock-based (2PL) pays blocking cost; optimistic (SSI) pays abort/retry cost; throughput can drop sharply under conflict-heavy workloads. Clients must be prepared to retry idempotently.

> **Why so expensive?** *"Serializable"* means guaranteeing the same effect as if transactions ran one after another. Concurrent execution must be equivalent to *some* serial execution, so the DB must either actually do that (2PL forces it via locks) or only allow commits when the result can be guaranteed (SSI forces it via conflict detection). It is not always *"the slowest"* though. Optimistic implementations like SSI behave close to SI cost under low-conflict workloads, but throughput collapses under high-conflict workloads due to abort/retry.

Two implementation paths:

- **2PL (Two-Phase Locking) based** — serialization via locks. SQL Server SERIALIZABLE.
- **SSI (Serializable Snapshot Isolation) based** — adds conflict detection to snapshot isolation. Instead of locking, ensures serializability via abort — when a dangerous read-write dependency pattern is detected, abort one transaction and let the client retry. PostgreSQL 9.1+ SERIALIZABLE.

> Instead of turning SERIALIZABLE on globally, applying explicit pessimistic locks only to the necessary transactions is also a common pattern. `SELECT ... FOR UPDATE` locks specific rows to the end of the transaction, effectively serializing just that part — less impact on overall concurrency than escalating the whole transaction to SERIALIZABLE.

> **When should you use SERIALIZABLE?** When business logic requires *"a constraint across multiple rows"* — when you must block write skew. Concurrent updates to the same row (two users INSERT/UPDATE the same seat) can be blocked by SI's first-committer-wins or explicit row locks. The canonical case where SI cannot help is **updating different rows but breaking a global constraint** — e.g., two doctors going off-call simultaneously while *"at least one must remain on call"*; if each verifies via their own snapshot they both pass and end with no one on call.
>
> **Principle**: SI detects only same-row write-write conflicts and not predicate (condition)-based conflicts. If two transactions' write sets do not overlap, SI sees no conflict — but in reality one transaction's write changed the result of the other transaction's read predicate.
>
> This is the **decisive difference between SERIALIZABLE and a plain row lock** — `SELECT ... FOR UPDATE` guarantees serialization *only over rows that were read* (sufficient for read-modify-write protection); SERIALIZABLE provides full serialization *including predicates* (tracks even future writes that could affect the read predicate). PostgreSQL's SSI uses SIREAD locks over index ranges to track read/write dependencies.
>
> **Concretely, what FOR UPDATE cannot block**: aggregate/range queries like `SELECT COUNT(*) FROM doctors WHERE on_call = true` — locking the result rows is meaningless (the rows to lock are those that satisfy the condition, but another transaction can update a row that did not satisfy the condition into one that does). Such predicate integrity requires SERIALIZABLE or a broader lock that covers the entire validation range.

> **Section 3 takeaway** — The four isolation levels are RU < RC < RR < SERIALIZABLE, but actual behavior differs by DB. PostgreSQL RR is implemented as SI and even blocks ANSI phantom; MySQL InnoDB RR is a hybrid of consistent read and locking statement. Only SERIALIZABLE blocks write skew.

## 4. How Isolation Is Implemented — Two Concurrency Controls

Isolation level is the spec; the actual implementation is by **concurrency control (CC).** Two main schools.

### 4.1 Pessimistic CC — locking

Assume *"conflict will happen"* and lock pre-emptively.

- **Row-level lock**: most popular. Only the row being modified is off-limits to other transactions.
- **Page-level lock**: per-page. Used to prevent concurrent changes to a clustering-index page.
- **Table-level lock**: whole table. Very expensive.

> **Lock Escalation**: if there are too many row locks (e.g., one transaction modifying hundreds of thousands of rows), some DBs may automatically escalate to page or table locks. The result is many waiting transactions. **Another reason long transactions are bad.**
>
> But Lock Escalation behavior differs greatly per DB:
>
> - **SQL Server**: explicitly happens (auto-escalates at 5,000 locks or memory threshold; controllable via `LOCK_ESCALATION`).
> - **PostgreSQL**: typically retains row locks; traditional escalation does not occur. Structural reason — PostgreSQL stores row locks not in a lock-table memory but in the row itself (per docs: *"PostgreSQL doesn't remember any information about modified rows in memory"*), so there is no memory pressure to trigger escalation.
> - **MySQL InnoDB**: typically retains row-level locking, no auto escalation.
>
> This is a key divergence between SQL Server and PostgreSQL/MySQL on bulk UPDATEs — SQL Server may suddenly lock the whole table due to escalation, while PostgreSQL/MySQL keep row locks. That said, this does not mean SQL Server is generally weak on concurrency — turning on RCSI or SNAPSHOT options makes SQL Server row-versioning-based.

> **Why managing locks itself is expensive** — in systems like SQL Server that hold the lock table in memory, every lock must be tracked. Locking 700,000 rows means 700,000 lock entries in memory — that is the memory pressure that causes lock escalation in SQL Server during bulk operations. PostgreSQL bypasses this by storing lock info on the row.

### 4.2 Optimistic CC — no locking

Assume *"conflict is rare"*; proceed first, detect conflict at commit time, fail one side.

- No lock-management cost → concurrency↑
- On conflict the transaction fails with a **serialization failure** and the client must retry.
- PostgreSQL SERIALIZABLE (SSI) is the canonical example. Some NoSQL systems also offer optimistic conflict detection like conditional writes, CAS, version-conditional updates (e.g., DynamoDB conditional writes, MongoDB document-level concurrency, Cassandra LWT).

### 4.3 MVCC — combining the two schools

Most modern RDBMSs combine both via **MVCC (Multi-Version Concurrency Control).**

![Two MVCC schools](/uploads/theory/transaction-acid/mvcc-comparison.svg)

> **MVCC's core**: **minimize direct blocking between reads and writes.** Reads see past versions; writes only contend on conflict (though write-write conflicts and explicit locking reads can still block).

This is decisive. Reads run on a snapshot, write conflicts are handled by locking or validation. As a result **reads and writes do not block each other.** `xmin`/`xmax` (PostgreSQL) and `DB_ROLL_PTR` (InnoDB) — covered in part A — are exactly the mechanisms for MVCC.

#### PostgreSQL's MVCC — new tuples + visibility management

UPDATE does not overwrite the existing tuple in place; it creates a new tuple. Old tuples are kept and managed by visibility rules. The transaction's snapshot ID at start determines which version is visible.

> Strictly, it is not pure append-only. **HOT (Heap-Only Tuple) update** optimization: when no indexed columns change and there is space on the same page, no index update is needed and a new tuple is added within the same page. Even so, the key difference from InnoDB's in-place update is that **the existing tuple is not immediately overwritten.**

![PostgreSQL — old/new tuples coexist on the same page; visibility decides which one each reader sees](/uploads/theory/transaction-acid/pg-tuple-versions.svg)

#### InnoDB's MVCC — version reconstruction via Undo Log

Rather than stacking multiple tuple versions in the table heap like PostgreSQL, InnoDB keeps the current version in the clustered index record and reconstructs older versions via an **Undo Log chain** (in-place update). The row header's `DB_ROLL_PTR` points to the old version inside the Undo Log.

![InnoDB — current version stays in place; old versions reconstructed by following the Undo Log chain](/uploads/theory/transaction-acid/innodb-undo-chain.svg)

Long-running transactions prevent purging the old versions their snapshot sees, so the Undo Log balloons (History List Length grows). Long undo chains increase snapshot read cost; delayed purge degrades performance.

#### Comparison

| Aspect | PostgreSQL | MySQL InnoDB |
|---|---|---|
| Main data | all versions accumulate in heap | only the latest version, in place |
| Old version location | same table page | separate Undo Log |
| Old version read | immediate from page (follow pointer) | reconstruct by walking Undo Log backward |
| Cleanup mechanism | VACUUM | purge thread |
| Old version read cost | affected by tuple/HOT chain on the page and visibility checks | grows with Undo Log chain length |

> The lecture note's *"under long-running transactions, InnoDB cannot trust the latest value and pays high cost"* refers exactly to this.

> **Section 4 takeaway** — Isolation is implemented in two schools (pessimistic locking vs optimistic conflict detection), and modern RDBMSs combine both via MVCC to minimize direct read-write blocking. PostgreSQL appends new tuples to the heap; InnoDB reconstructs old versions via Undo Log chains.

## 5. Isolation Level Reference Table (per-DB actual behavior)

Do not look only at the standard. The same REPEATABLE READ is close to SI in PostgreSQL but a hybrid of consistent read + locking read + next-key/gap lock in MySQL InnoDB — different behavior. **The name is standard; the meaning is product-specific.**

| Isolation level | PostgreSQL | MySQL InnoDB | SQL Server |
|---|---|---|---|
| READ UNCOMMITTED | auto-promoted to Read Committed | officially supported | officially supported |
| READ COMMITTED | default | optional | default — `READ_COMMITTED_SNAPSHOT` OFF (default) is lock-based; ON uses MVCC-like row versioning. Azure SQL defaults to ON |
| REPEATABLE READ | snapshot-based — ANSI-defined phantom does not occur but predicate-based anomaly (write skew) still possible | default; consistent read uses snapshot, locking read uses next-key/gap lock | lock-based — protects only read rows; range conditions are protected only at SERIALIZABLE via key-range lock |
| SNAPSHOT | no separate SNAPSHOT keyword — REPEATABLE READ corresponds to Snapshot Isolation | no separate SNAPSHOT level; RR's consistent read is snapshot-based but locking statements use next-key/gap lock and most-recent state — a hybrid model | separate option (`ALLOW_SNAPSHOT_ISOLATION ON` + `SET TRANSACTION ISOLATION LEVEL SNAPSHOT`) |
| SERIALIZABLE | SSI-based (also blocks write skew) | lock-based (converts to `SELECT ... FOR SHARE`) | lock-based — protects range conditions via key-range locks to prevent phantoms |

> The SQL standard recommends SERIALIZABLE as default, but virtually no major DB follows that. PostgreSQL/SQL Server/Oracle default to Read Committed; MySQL defaults to Repeatable Read.

## 6. Which Isolation Level When in Practice

Theory aside, the real question is *"so what should I use for my system?"* General guidelines:

### Per-workload recommendations

**General OLTP (REST APIs, transactional processing) → READ COMMITTED**

- A reasonable default for most business applications.
- Also the default of PostgreSQL/SQL Server/Oracle.
- Many short transactions, slight inconsistency (non-repeatable read) tolerable.
- **Why it is performance-friendly**: short transactions + latest data preferred + few conflicts is the typical OLTP profile, and RC only needs per-statement snapshots, so generally less long-snapshot maintenance burden than RR/SERIALIZABLE and very few serialization-failure retries — favorable for throughput.

**Reports / batch / analytical transactions → REPEATABLE READ (= Snapshot Isolation)**

- When the transaction needs *"a consistent view of the same data."*
- Sales aggregation, accounting close, daily statistics, etc.
- Highly suitable since PostgreSQL's RR behaves as SI.
- **Why it is performance-friendly**: report transactions are long and read-heavy, and SI provides a consistent snapshot without locks — does not block concurrent OLTP traffic. Implementing the same consistency with locks would queue up other transactions and tank throughput.

**Inventory / limits / constraint validation → graduated choice based on situation**

The right answer depends on the constraint scope. From simplest:

1. **Simple increment/decrement on a single row** → an **atomic conditional UPDATE** is enough.
   - Example: `UPDATE stock SET qty = qty - 1 WHERE id = ? AND qty > 0`
   - Example: `UPDATE account SET balance = balance - ? WHERE id = ? AND balance >= ?`
   - The DB takes a row lock and atomically validates the condition. SERIALIZABLE not needed.

2. **Read-modify-write is unavoidable** → explicit row lock with `SELECT ... FOR UPDATE`.
   - When the application logic is too complex to reduce to a DB expression.

3. **Conflicts rare and retry cheap** → version-based optimistic locking (`WHERE version = ?`).

4. **Predicate constraint across multiple rows** → SERIALIZABLE or a broader lock strategy.
   - Example: at least 1 of 2 doctors must be on call (validated across different rows).
   - Plain FOR UPDATE only protects rows already selected; protecting the predicate itself requires SSI or a broader lock that covers the entire validation range.

> **Common mistake**: blanket-applying SERIALIZABLE *"because it is inventory deduction."* Single-row deduction is solved by #1 above; SERIALIZABLE is needed only for true predicate-based write skew. Blanket misuse just slashes throughput.

> Decisive difference of the steps above — `FOR UPDATE` (#2) is *row-level serialization* (sufficient for read-modify-write protection); SERIALIZABLE (#4) is *full serialization including predicates* (covers even unread future rows). So predicate-based write skew like the on-call doctors may not be blocked by plain FOR UPDATE.

> **Why apply only partially?** SERIALIZABLE — whether SSI or 2PL — pays abort/retry or blocking cost on conflict. Applying it only to potentially conflicting transactions secures consistency while minimizing total throughput loss.

**Heavy analytical queries / reports (consistency-loss tolerable) → choose carefully**

- Generally safer to handle on a separate read replica or data warehouse.
- If on the same DB, **REPEATABLE READ (= Snapshot Isolation)** is the most balanced choice — consistent snapshot without blocking other transactions.
- READ UNCOMMITTED — like SQL Server's NOLOCK hint — is for very narrow situations where *"you must trade consistency for less locking cost."* Hard to recommend generally; you take on the Dirty Read risk discussed earlier.

### Anti-patterns — frequent mistakes

- **Lowering isolation level "for speed"** — dropping RC to RU without measurement is almost always wrong. On MVCC-based DBs, the perf delta is small.
- **Indiscriminate use of `SELECT ... FOR UPDATE`** — code that puts FOR UPDATE on every SELECT *"to be safe"* dies of hot-row contention. Use it only on rows that truly see concurrent modifications.
- **External API calls inside a transaction** — putting payment APIs or email sends inside a transaction lengthens it, holding locks or old versions and blocking others. Move external calls outside.

## 7. Optimistic vs Pessimistic — When to Pick What

After picking an isolation level, the next question is concurrency-control strategy.

**Pessimistic (`SELECT ... FOR UPDATE`, row locks) wins when**

- **Hot rows with frequent conflict** — popular product stock, frequently-updated counters.
- **Retry is expensive** — long transactions or transactions integrating with external systems where re-execution is hard.
- **Order matters** — pulling next item from a queue, distributed lock implementation.

**Optimistic (version numbers, CAS, SSI) wins when**

- **Low-conflict workloads** — users only modify their own data.
- **Read-heavy systems** — boost concurrency without lock cost.
- **Distributed systems** — cross-node lock coordination is expensive, so optimistic is the norm. That is why some distributed stores expose conditional-write/CAS operations (semantics and guarantees vary; check per product).

### Application-level patterns

Patterns commonly seen with ORMs:

- **Hibernate/JPA `@Version`** — add a version column; UPDATE auto-includes `WHERE id = ? AND version = ?`. If another transaction updated first, you get a 0-row update and `OptimisticLockException` fires. The standard implementation of optimistic locking.
- **Spring `@Transactional` with isolation levels** — set isolation per transaction. RR for reports, RC for normal processing, SERIALIZABLE for inventory deduction — finer than a global setting.
- **Retry logic** — optimistic locking or SSI can fail with serialization errors. Clients must be ready to retry idempotently.

### General rule for transactions themselves

Regardless of isolation level, every transaction should be as short as possible:

- Shorter → less lock-hold time, less blocking.
- Shorter → PostgreSQL VACUUM, MySQL purge thread can work faster (see part A).
- Shorter → less chance of conflict, fewer serialization failures / retries.
- Shorter → less to recover after a crash.

Same conclusion as part A — **keep transactions short and cohesive at business-logic boundaries.**

## 8. Wrap-up

- **Isolation** is the question of **how much visibility of changes is allowed across concurrent transactions.**
- **The SQL standard defines three read phenomena** — Dirty Read, Non-repeatable Read, Phantom. **Lost Update** is non-standard but extremely common in practice.
- **Four isolation levels** — READ UNCOMMITTED < READ COMMITTED < REPEATABLE READ < SERIALIZABLE. Stronger means safer but lower concurrency.
- **The standard defines minimum guarantees only.** Actual DBs may implement stronger guarantees (PostgreSQL doc: *"higher guarantees are acceptable"*), and anomalies the standard does not explicitly capture (write skew, lost update) may differ across DBs. For example: PostgreSQL REPEATABLE READ blocks even phantoms, but MySQL REPEATABLE READ — per Jepsen — can show lost update in certain read-modify-write patterns. So the same isolation-level *name* yields different actual guarantees per DB.
- **Snapshot Isolation ≠ Serializable.** Theoretical SI is described to block P4 (Lost Update) at the model-definition level via first-committer-wins (Berenson 1995), but in real DBs the guarantee level depends on update method and conflict-detection implementation. Check per-product docs and verification results separately. Either way, SI does **not** block write skew; SERIALIZABLE blocks it via SSI or locking.
- **When you need SERIALIZABLE**: when a predicate constraint across multiple rows can be broken — minimum on-call doctors, multi-account total limit, etc. Single-row simple deduction/validation is solved by atomic conditional UPDATE; SERIALIZABLE is unnecessary.
- **Two implementation schools** — pessimistic (locking) vs optimistic (conflict detection). Most modern RDBMSs **combine both via MVCC** so reads and writes do not block each other directly.
- **PostgreSQL MVCC** creates new tuples on UPDATE and manages with visibility rules; VACUUM cleans. **InnoDB MVCC** keeps the latest version in the clustered index record and reconstructs older versions via the Undo Log chain. The rollback-cost difference from part A applies the same here.
- **Practical guide**: RC for OLTP, RR (= SI) for reports/batch, SERIALIZABLE or explicit `SELECT ... FOR UPDATE` for inventory/booking/limit checks. You can set isolation per transaction, so segmenting by workload is more efficient than a global setting.
- **Keep transactions short** — regardless of isolation level, short transactions win on every axis (lock holding, VACUUM/purge, conflict probability, crash recovery).

## References (Primary Sources First)

- [PostgreSQL Documentation: Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
- [MySQL 8.4 Reference Manual: Transaction Isolation Levels](https://dev.mysql.com/doc/refman/8.4/en/innodb-transaction-isolation-levels.html)
- [SQL Server: SET TRANSACTION ISOLATION LEVEL — Microsoft Learn](https://learn.microsoft.com/en-us/sql/t-sql/statements/set-transaction-isolation-level-transact-sql)
- Berenson et al. — *A Critique of ANSI SQL Isolation Levels* (1995) — source of Lost Update, Write Skew, etc.
- [Wikipedia: Isolation (database systems)](https://en.wikipedia.org/wiki/Isolation_(database_systems))
- [No Dirty Reads: Everything you wanted to know about SQL isolation levels — Cockroach Labs](https://www.cockroachlabs.com/blog/sql-isolation-levels-explained/)
- [Isolation Repeatable Read in PostgreSQL versus MySQL — verite.pro](https://verite.pro/blog/isolation-repeatable-read-postgresql-vs-mysql.html)
- [MySQL performance implications of InnoDB isolation modes — Percona](https://www.percona.com/blog/innodbs-gap-locks/)
- [Jepsen: MySQL 8.0.34 — Repeatable Read analysis](https://jepsen.io/analyses/mysql-8.0.34) — rigorous verification that MySQL RR exhibits G2-item, lost update, read skew
- [What if MySQL's Repeatable Reads Cause You to Lose Money? — Percona](https://www.percona.com/blog/lost-updates-in-innodb/) — empirical Lost Update scenario on MySQL RR
- [A beginner's guide to database locking and the lost update phenomena — Vlad Mihalcea](https://vladmihalcea.com/a-beginners-guide-to-database-locking-and-the-lost-update-phenomena/) — comparison: PostgreSQL prevents Lost Update at RR, MySQL does not

---
title: 'DB 내부 ④: 격리 — 2PL에서 MVCC 스냅샷 격리까지, reader가 writer를 안 막기까지'
titleEn: 'DB Internals ④: Isolation — From 2PL to MVCC Snapshot Isolation, Until Readers Stop Blocking Writers'
description: "동시에 여럿이 읽고 쓸 때 DB는 어떻게 안전한가. 두 철학이 있다 — 충돌을 미리 막는 2PL(잠금)과, 버전을 갈라 충돌을 피하는 MVCC. MVCC의 두뇌는 가시성 규칙 한 줄(xmin 커밋 AND xmax 미커밋이면 보인다)이고, 그 규칙이 성립하려면 DELETE조차 지우면 안 된다(xmax 도장) — 그 순간 힙을 읽는 아홉 갈래 전부에 가시성 게이트가 필요해지고, '인덱스는 MVCC를 모른다'는 원칙이 선다. 일부러 만든 쓰레기(dead tuple)는 VACUUM이 치우는데, PostgreSQL nbtree처럼 병합 없는 lazy 삭제로 충분한 이유, VACUUM해도 파일이 안 줄어드는 이유까지 코드로 확인한다. 마지막으로 reader의 락을 제거하고 BEGIN 시점 스냅샷(PG의 xmax/xip 축소판)을 고정하면 — 한 트랜잭션이 미커밋 UPDATE를 쥐고 있어도 다른 쪽이 옛 버전을 막힘 없이 읽는 진짜 스냅샷 격리가 선다. 그 여파로 PK 인덱스가 다중 버전 멀티맵이 되어야 했던 것까지, C 구현으로 확인하며 정리해요."
descriptionEn: "How is a DB safe when many read and write at once? Two philosophies: 2PL (locks) prevents conflicts up front; MVCC avoids them by splitting versions. MVCC's brain is one line — a version is visible iff xmin committed AND xmax not — and for that rule to hold, even DELETE must not delete (it stamps xmax). The moment it doesn't, all nine paths that read the heap need a visibility gate, and the principle 'indexes don't know MVCC' stands. The garbage made on purpose (dead tuples) is swept by VACUUM — with a lazy, merge-free B+Tree delete like PostgreSQL's nbtree, and a clear answer to why VACUUM doesn't shrink your file. Finally, remove the readers' locks and pin a BEGIN-time snapshot (a miniature of PG's xmax/xip) — and true snapshot isolation stands: while one transaction holds an uncommitted UPDATE, another reads the old version unblocked. Including the aftermath — the PK index had to become a multi-version multimap — verified on a C implementation."
date: 2026-03-28T00:00:00.000Z
tags:
  - Database Internals
  - MVCC
  - Isolation
  - Transaction
  - PostgreSQL
  - InnoDB
  - C
category: study/db-hobby
coverImage: /uploads/project/db-hobby/cover.svg
draft: false
series: "미니 DB로 이해하는 DB 내부"
seriesOrder: 4
---

## 0. 들어가며 — 동시에 여럿이 올 때

[3편](/blog/project/db-hobby/db-internals-03-wal-recovery)까지로 크래시엔 안 깨지게 됐어요. 이번 문제는 **동시성**입니다 — 두 트랜잭션이 같은 행을 동시에 건드리면? 하나는 읽고 하나는 쓰면?

이 편은 그 답의 두 철학(2PL vs MVCC)에서 시작해, MVCC를 실제로 구현하며 부딪힌 벽들을 순서대로 밟습니다. 스포일러: MVCC의 핵심은 "버전을 쌓는다"가 아니라 **가시성 규칙 한 줄**이고, 그 한 줄을 지키려면 DELETE조차 지우면 안 되고, 지우지 않으면 청소부(VACUUM)가 필요해지고, 청소까지 끝나면 마침내 **"reader가 writer를 안 막는다"** 가 시연이 아니라 실행이 됩니다.

격리 수준과 이상현상의 이론 전체 그림은 [트랜잭션 ACID ②: Isolation](/blog/theory/transaction-acid-02-isolation)에 있어요 — 이 편은 그 이론이 코드로 서는 과정입니다.

## 1. 두 철학 — 충돌을 막을까, 피할까

두 트랜잭션이 같은 행을 동시에 건드릴 때, 안전하게 만드는 답은 둘이에요.

**2PL(잠금) — 충돌을 미리 막는다.** 읽으려면 공유 락(S), 쓰려면 배타 락(X)을 잡습니다. 누가 잠근 건 못 건드려요. 비관적(pessimistic) 접근. 락이 서로를 기다리다 사이클이 생기면 **교착(deadlock)** 이라, wait-for 그래프로 탐지해 한쪽을 abort해야 합니다.

**MVCC(버전) — 충돌을 피한다.** 쓰면 덮어쓰는 대신 **새 버전**을 만들고, 읽으면 자기 트랜잭션 시점의 **스냅샷**을 봐요. 읽는 쪽과 쓰는 쪽이 서로 다른 버전을 보니 막을 일이 없습니다.

| 이상현상 | 2PL의 처방 | MVCC의 처방 |
|---|---|---|
| dirty read | X 잠긴 행을 못 읽음 | 미커밋 버전은 애초에 안 보임 |
| lost update | X 락으로 쓰기 직렬화 | 행 락 + first-updater-wins |
| non-repeatable read | S 락을 커밋까지 쥠 | 스냅샷이 시작 시점에 고정 |

같은 문제를 한쪽은 "잠가서", 한쪽은 "버전을 갈라서" 풀어요. 그리고 공짜 점심은 없습니다:

| | 2PL (잠금) | MVCC (버전) |
|---|---|---|
| 얻는 것 | 단순한 저장(행당 버전 1개) | **읽기가 쓰기를 안 막음** |
| 치르는 비용 | 동시성 저하, 교착 탐지·abort | dead tuple 누적, **VACUUM** |
| 비용 청구 시점 | 실행 중(락 대기) | 나중에 백그라운드(청소) |

> **실무/면접 포인트**: "MVCC가 빠르다"보다 정확한 설명은 **"MVCC는 읽기-쓰기 충돌을 없앤다"** 다. 일반 SELECT가 락 없이 스냅샷을 읽으니 reader와 writer가 서로 안 기다린다(`FOR UPDATE` 같은 명시적 락은 예외). 다만 **쓰기-쓰기 충돌은 MVCC에서도 남는다**(5절). PostgreSQL의 높은 읽기 동시성이 여기서 나오고, 그 값으로 PG는 VACUUM을 떠안고 산다.

db-hobby는 2PL(테이블 S/X 락, strict 2PL, wait-for 교착 탐지)을 먼저 만들어 "막는" 쪽을 확인한 뒤, MVCC로 갈아탔어요. 이 갈아타기가 이 편의 나머지 전부입니다.

## 2. MVCC의 두뇌 — 가시성 규칙 한 줄

MVCC는 "버전을 쌓는다"가 전부처럼 보이지만, 그걸 작동시키는 두뇌는 **가시성 규칙** 한 줄이에요. 각 행 버전이 두 개의 트랜잭션 ID를 답니다.

- `xmin` — 이 버전을 만든(INSERT한) 트랜잭션
- `xmax` — 이 버전을 지운(DELETE한) 트랜잭션 (0이면 아직)

> **가시성 규칙**: 어떤 행 버전은, `xmin`이 커밋됐고 AND (`xmax`가 0이거나 아직 커밋 안 됨)일 때만 보인다.

```c
int mvcc_visible(const TxnLog *log, int xmin, int xmax) {
    if (txnlog_status(log, xmin) != TXN_COMMITTED) return 0; /* 생성자가 미커밋/abort -> 없는 행 */
    if (xmax != 0 && txnlog_status(log, xmax) == TXN_COMMITTED) return 0; /* 커밋된 삭제 -> 안 보임 */
    return 1;
}
```

`TxnLog`는 트랜잭션 id마다 상태(진행/커밋/아보트)를 담은 배열 — PostgreSQL의 **CLOG**(`pg_xact`)에 대응해요. 행 저장은 [1편의 행 포맷](/blog/project/db-hobby/db-internals-01-storage) 맨 앞에 8바이트 헤더(`[xmin(4)][xmax(4)]`)를 붙이는 것으로 끝납니다.

![행 버전과 가시성 — xmin/xmax와 트랜잭션 상태가 버전의 보임/안 보임을 가른다](/uploads/project/db-hobby/mvcc-version-visibility.svg)

여기서 **"이전 버전을 어디에 두느냐"** 가 실제 DB들을 가르는 분기점이에요.

| | db-hobby | PostgreSQL | InnoDB |
|---|---|---|---|
| 옛 버전 위치 | 같은 힙 (행 헤더 xmin/xmax) | 같은 힙 (튜플 헤더) | **별도 Undo Log** |
| UPDATE | 옛 버전에 xmax + 새 버전(새 RID) | 새 튜플 append | in-place 수정 + before를 undo에 |
| 트랜잭션 상태 | TxnLog | CLOG(`pg_xact`) | rollback segment 포인터 |

db-hobby는 PostgreSQL을 따라 **같은 힙 안**(append-only)에 둡니다. 이 선택의 우아한 보상이 하나 있어요 — **롤백이 공짜**입니다. abort하면 TxnLog에 "아보트"라 적기만 하면, 그 트랜잭션이 만든 모든 버전이 가시성 규칙에 의해 **자동으로 안 보이게** 돼요. 행을 하나하나 되돌릴 필요가 없습니다. (InnoDB는 반대로 undo log를 재생해 물리적으로 되돌리는 대신, 힙이 항상 최신 버전만 들고 있어 읽기가 가볍습니다 — 이 트레이드오프의 전체 그림은 [ACID ①](/blog/theory/transaction-acid-01-atomicity).)

## 3. DELETE는 지우지 않는다 — xmax 도장과 아홉 갈래 게이트

가시성 규칙이 성립하려면 치명적인 전제가 하나 있어요 — **DELETE가 행을 물리적으로 지우면 안 됩니다.** 지워 버리면 "커밋 안 된 삭제는 여전히 보여야 한다"(reader의 스냅샷)를 지킬 수 없거든요. DELETE 롤백도 물리 복원에 기대야 하고요.

그래서 DELETE는 슬롯을 지우는 대신 **xmax 4바이트만 제자리에서 덮어씁니다** — 도장을 찍는 거예요.

```c
static int stamp_xmax(Table *t, RID rid, int32_t xmax) {
    uint8_t rec[PAGE_SIZE]; uint16_t len;
    heap_get(&t->heap, rid, rec, &len);
    memcpy(rec + 4, &xmax, 4);                     /* MVCC 헤더 = [xmin(4)][xmax(4)] */
    return heap_overwrite(&t->heap, rid, rec, len); /* 같은 길이 제자리 덮어쓰기 */
}
```

UPDATE도 같은 결이에요 — 옛 버전에 `stamp_xmax`, 새 버전을 새 RID로 삽입. PostgreSQL이 UPDATE를 다루는 방식 그대로입니다.

### 대가 — 힙을 읽는 모든 경로가 가시성을 알아야 한다

"지워진 행이 물리적으로 존재"하게 된 순간, 힙을 읽는 **모든** 경로가 버전을 걸러야 해요. 세어 보니 아홉 갈래였습니다 — 풀스캔, PK 점 조회, PK 범위, 보조 인덱스, 조인 세 방식(중첩 루프·해시 빌드·인덱스 NLJ), 집계/정렬 materialize, DML 대상 수집, CREATE INDEX 빌드. 게이트는 한 줄인데, 그 한 줄을 아홉 군데 다 달아야 정확합니다. 하나라도 빼먹으면 그 경로만 유령(지워진 행)을 봐요.

![xmax 게이트 — 힙을 읽는 모든 경로가 가시성 판정을 지난다](/uploads/project/db-hobby/mvcc-xmax-gate.svg)

여기서 인덱스에 관한 중요한 관찰:

> **인덱스는 MVCC를 모른다.** B+Tree는 (키 → RID)만 알지, 그 RID의 행이 어느 트랜잭션에 보이는지 모른다. 그래서 모든 인덱스 경로가 "인덱스로 후보를 찾고 → 힙에서 행을 읽고 → 게이트로 판정"하는 2단 구조가 된다. PostgreSQL의 인덱스 스캔이 힙에 들러 가시성을 확인하는 것(그리고 그 비용을 아끼려 visibility map을 두는 것)과 같은 이유다. [2편](/blog/project/db-hobby/db-internals-02-btree-index)의 "인덱스는 후보일 뿐, 진실은 힙에" 원칙이 MVCC에서 생존 조건이 된다.

보상은 즉시 왔어요 — **DELETE 롤백이 되살아납니다.** xmax를 찍은 트랜잭션이 아보트되면 가시성 규칙이 그 도장을 무효로 치니까, ROLLBACK 한 번에 지운 행이 돌아와요. 물리 복원이 아니라 논리의 귀결로요.

## 4. 일부러 만든 쓰레기 — VACUUM

이제 새 문제가 생겼습니다. DELETE가 안 지우니 **죽은 버전(dead tuple)이 무한히 쌓여요.** DELETE를 해도 파일이 1바이트도 안 줄어듭니다. 이게 MVCC가 청구하는 비용이고, 청소부가 **VACUUM**이에요.

**누가 죽었는가** — 판정 원칙은 "지금은 물론 앞으로도 아무 트랜잭션에게 보일 수 없는 버전". 일반적으론 실행 중인 모든 스냅샷을 고려하는 까다로운 판정인데(PostgreSQL의 oldest xmin horizon), 단일 노드 미니 DB에선 "커밋된 xmax가 찍힌 버전"으로 떨어집니다. VACUUM은 PostgreSQL처럼 트랜잭션 안에서는 거부하고요(`VACUUM cannot run inside a transaction block`).

**청소부의 세 가지 일** — 순서가 중요해요.

```
① 죽은 버전을 가리키던 인덱스 항목을 지운다   (B+Tree lazy 삭제)
② 힙 슬롯을 비우고 페이지를 compaction한다    (슬롯 번호 = RID 불변!)
③ 꼬리가 전부 빈 페이지면 파일을 자른다        (조건부 truncate)
```

![VACUUM — 죽은 버전 수집, 인덱스 항목 제거, 페이지 compaction, 꼬리 truncate](/uploads/project/db-hobby/vacuum-sweep.svg)

②에서 슬롯 번호를 보존하는 이유는 [1편](/blog/project/db-hobby/db-internals-01-storage)의 그 원칙 — 슬롯 번호가 곧 RID고 인덱스가 RID로 가리키니까요. ③은 **파일 끝의 전부-빈 페이지만** 자르고 가운데 빈 페이지는 남깁니다 — PostgreSQL VACUUM도 정확히 이래서, **"VACUUM 했는데 파일이 안 줄어요"** 가 흔한 겁니다(공간은 재사용 가능해졌지만 OS에 반납되진 않은 상태).

**B+Tree 삭제 — 교과서와 다르게.** 죽은 버전을 치우면 인덱스 항목이 허공을 가리키니 지워야 하는데, 교과서(병합·재분배)를 이식하기 전에 진짜 DB를 봤어요. **PostgreSQL nbtree는 재분배를 안 합니다** — 리프에서 항목을 지우고, 페이지가 완전히 비면 트리에서 떼어 재활용할 뿐. 노드가 반쯤 비어도 그냥 둡니다. 그래서 **lazy 삭제**로 충분해요. 포인트는 키가 아니라 **(키, RID) 짝**을 지우는 것 — UPDATE된 PK는 같은 키가 살아있는 새 버전을 가리키고 있어서, 짝으로 지워야 산 항목을 안 다칩니다.

## 5. 진짜 스냅샷 격리 — reader의 락을 없애다

부품이 다 모였습니다. 이제 철학 전환의 마지막 한 수 — **SELECT가 락을 안 잡습니다.**

```c
static int acquire_stmt_locks(Database *db, const Statement *st, int txn, FILE *out) {
    switch (st->type) {
        case STMT_INSERT: case STMT_DELETE: case STMT_UPDATE:
            return lock_one(db, ..., LOCK_X, txn, out);  /* 쓰기만 X락 */
        default: return 0;                                /* SELECT: 락 없음 */
    }
}
```

"락 없이 dirty read를 어떻게 막지?" — **그건 더 이상 락의 일이 아닙니다.** writer의 미커밋 버전은 xmin이 미커밋이라 게이트가 걸러요. UPDATE의 옛 버전은 xmax가 미커밋이라 **여전히 보이고요.** reader는 거부당하는 게 아니라 그냥 **옛 버전을 읽습니다.** 막는 대신 가르기 — 1절의 표가 코드가 된 순간이에요.

**시간을 고정한다 — BEGIN 시점 스냅샷.** 락을 없앴으니 격리는 온전히 가시성이 정하는데, "지금 커밋된 것"을 보면 read committed예요(같은 SELECT 두 번 사이에 남이 커밋하면 결과가 바뀜). 스냅샷 격리라 부르려면 시간을 BEGIN에 고정해야 합니다. 구현은 PostgreSQL 스냅샷의 축소판 — BEGIN 때 ① 이후에 태어날 트랜잭션의 경계(`snap_next`)와 ② 지금 열려 있는 남의 트랜잭션 목록(`snap_inprog`)을 기록하고, 가시성 판정이 이 스냅샷을 통과해야 "커밋됨"으로 칩니다. PG 스냅샷의 `xmax`(경계)와 `xip`(in-progress 목록)에 정확히 대응해요. 이로써 트랜잭션 안은 REPEATABLE READ, 밖의 단문은 read committed — PostgreSQL의 기본 구도와 같은 두 층입니다.

**쓰기-쓰기만은 막는다 — first-updater-wins.** 두 트랜잭션이 같은 데이터를 고치는 것만은 버전으로 못 피해요(lost update). 답은 쓰기에만 X락을 유지하고, 충돌 시 뒤에 온 쪽이 물러나는 것. PostgreSQL은 이걸 **행 단위**로 하고(REPEATABLE READ에선 serialization failure), db-hobby는 테이블 단위라 더 거칠지만 — granularity의 차이지 철학의 차이가 아닙니다.

**예상 못 한 여파 — PK 인덱스가 다중 버전이 되어야 했다.** 여기까지 하고 테스트를 돌리니 스냅샷 시나리오가 깨졌어요. 범인은 PK 인덱스 — 지금까지 유니크라서 UPDATE가 키의 항목을 새 RID로 **덮어썼는데**, 그 순간 **옛 버전으로 가는 인덱스 경로가 끊깁니다.** 스냅샷 reader가 인덱스로 조회하면 빈 결과, 풀스캔으론 보이는 모순. 답은 PostgreSQL이 이미 알고 있었어요 — **인덱스도 버전마다 항목을 갖는다.** PK 인덱스가 한 키에 여러 RID를 매다는 멀티맵(`btree_insert_dup`)이 되고, 조회가 후보들 중 보이는 버전을 고릅니다. [2편](/blog/project/db-hobby/db-internals-02-btree-index)의 부제("인덱스는 왜 단순 key→value가 아닌가")의 답이 이거예요.

![다중 세션 — 한 트랜잭션이 미커밋 UPDATE를 쥐어도 다른 세션은 옛 버전을 막힘 없이 읽는다](/uploads/project/db-hobby/multi-txn-sessions.svg)

이제 그 장면이 실제로 돕니다:

```
SESSION 0> BEGIN; UPDATE t SET v = 999 WHERE id = 1;   -- 미커밋 쓰기를 쥔 채
SESSION 1> SELECT * FROM t WHERE id = 1;
1 | 100                                                  -- 막히지 않고 옛 버전을 읽는다
SESSION 0> COMMIT;
SESSION 1> SELECT * FROM t WHERE id = 1;
1 | 999                                                  -- (트랜잭션 밖) 이제 새 값
```

**reader가 writer를 안 막는다** — 시연이 아니라 실행으로.

## 6. 정리

- **두 철학**: 2PL은 충돌을 막고(락, 교착의 비용), MVCC는 버전을 갈라 피한다(dead tuple과 VACUUM의 비용). 비용 청구 시점이 다르다 — 실행 중 vs 백그라운드.
- **MVCC의 두뇌는 가시성 규칙 한 줄** — xmin 커밋 AND xmax 미커밋. 트랜잭션 상태 배열(CLOG)과 행 헤더 8바이트가 전부다. **롤백이 공짜**로 나온다.
- **DELETE는 지우지 않는다** — xmax 도장. 그 대가로 힙을 읽는 아홉 갈래 전부에 게이트, 그리고 **"인덱스는 MVCC를 모른다"** 원칙.
- **VACUUM** — dead 판정(커밋된 xmax), 인덱스 (키,RID) 짝 삭제(lazy — PG nbtree도 재분배 안 함), RID 불변 compaction, 꼬리만 truncate(그래서 파일이 잘 안 줄어든다).
- **스냅샷 격리** — reader 락 제거 + BEGIN 스냅샷(xmax/xip) + 쓰기만 first-updater-wins. 여파로 **PK 인덱스가 다중 버전 멀티맵**이 된다.

다음 편은 이 엔진에 **네트워크**를 뚫습니다 — 진짜 `psql`이 접속하는 PostgreSQL wire protocol 서버.

## 참고 (1차 자료 우선)

- [PostgreSQL Documentation: MVCC — Concurrency Control](https://www.postgresql.org/docs/current/mvcc.html)
- [PostgreSQL Documentation: Routine Vacuuming](https://www.postgresql.org/docs/current/routine-vacuuming.html)
- [MySQL 8.0 Reference: InnoDB Multi-Versioning](https://dev.mysql.com/doc/refman/8.0/en/innodb-multi-versioning.html)
- Hal Berenson et al., *A Critique of ANSI SQL Isolation Levels* (SIGMOD 1995) — 스냅샷 격리의 고전
- 본 블로그: [트랜잭션 ACID ①: Atomicity](/blog/theory/transaction-acid-01-atomicity) · [②: Isolation](/blog/theory/transaction-acid-02-isolation) · [락 메커니즘 총정리](/blog/theory/lock-mechanisms-all)
- [db-hobby 코드 (GitHub)](https://github.com/dj258255/db-hobby) — `mvcc.c` · `lock.c` · `db.c`

<!-- EN -->

## 0. Introduction — When Many Arrive at Once

Through [Part 3](/blog/project/db-hobby/db-internals-03-wal-recovery), crashes no longer corrupt us. The next problem is **concurrency** — two transactions touching the same row at once; one reading while the other writes.

This part starts from the two philosophies (2PL vs MVCC), then walks the walls hit while actually implementing MVCC. Spoiler: MVCC's core is not "pile up versions" but **one line of visibility rule**; keeping that line true means even DELETE must not delete; not deleting demands a janitor (VACUUM); and once the sweeping works, **"readers don't block writers"** finally becomes execution rather than demonstration.

The full theory of isolation levels and anomalies lives in [Transaction ACID ②: Isolation](/blog/theory/transaction-acid-02-isolation) — this part is that theory standing up in code.

## 1. Two Philosophies — Prevent Conflicts, or Avoid Them

When two transactions touch the same row, there are two ways to be safe.

**2PL (locks) — prevent conflicts up front.** Take a shared lock (S) to read, an exclusive lock (X) to write; nobody touches what's locked. Pessimistic. Locks waiting on each other can cycle into **deadlock**, requiring wait-for-graph detection and aborting someone.

**MVCC (versions) — avoid conflicts.** Writes create a **new version** instead of overwriting; reads see a **snapshot** as of their transaction. Readers and writers look at different versions, so there's nothing to block.

| Anomaly | 2PL's remedy | MVCC's remedy |
|---|---|---|
| dirty read | can't read an X-locked row | uncommitted versions simply aren't visible |
| lost update | X locks serialize writes | row lock + first-updater-wins |
| non-repeatable read | hold S locks to commit | snapshot pinned at start |

Same problems — one side locks, the other splits versions. And there's no free lunch:

| | 2PL (locks) | MVCC (versions) |
|---|---|---|
| You gain | simple storage (one version/row) | **reads never block writes** |
| You pay | reduced concurrency, deadlocks | dead-tuple accumulation, **VACUUM** |
| When billed | during execution (lock waits) | later, in the background (sweeping) |

> **Practical/interview point**: more accurate than "MVCC is fast" is **"MVCC eliminates read-write conflicts."** Plain SELECTs read a snapshot without locks, so readers and writers don't wait on each other (explicit locks like `FOR UPDATE` are the exception). But **write-write conflicts remain even under MVCC** (§5). PostgreSQL's high read concurrency comes from here — and the price it lives with is VACUUM.

db-hobby built 2PL first (table S/X locks, strict 2PL, wait-for deadlock detection) to see the "prevent" side, then switched to MVCC. That switch is the rest of this part.

## 2. MVCC's Brain — One Line of Visibility

MVCC looks like "stack versions," but the brain that makes it work is the **visibility rule.** Each row version carries two transaction IDs:

- `xmin` — the transaction that created (INSERTed) this version
- `xmax` — the transaction that deleted it (0 = not yet)

> **Visibility rule**: a row version is visible iff `xmin` committed AND (`xmax` is 0 or not yet committed).

```c
int mvcc_visible(const TxnLog *log, int xmin, int xmax) {
    if (txnlog_status(log, xmin) != TXN_COMMITTED) return 0; /* creator uncommitted/aborted -> no row */
    if (xmax != 0 && txnlog_status(log, xmax) == TXN_COMMITTED) return 0; /* committed delete -> hidden */
    return 1;
}
```

`TxnLog` is just an array of per-transaction status (in-progress / committed / aborted) — corresponding to PostgreSQL's **CLOG** (`pg_xact`). Storage-wise, an 8-byte header (`[xmin(4)][xmax(4)]`) goes at the front of [Part 1's row format](/blog/project/db-hobby/db-internals-01-storage).

![Row versions and visibility — xmin/xmax plus transaction status decide whether a version is seen](/uploads/project/db-hobby/mvcc-version-visibility.svg)

**Where the old version lives** is the fork that separates real DBs:

| | db-hobby | PostgreSQL | InnoDB |
|---|---|---|---|
| Old version lives | same heap (row header) | same heap (tuple header) | **separate Undo Log** |
| UPDATE | xmax on old + new version (new RID) | append a new tuple | in-place + before-image to undo |
| Txn status | TxnLog | CLOG (`pg_xact`) | rollback segment pointers |

db-hobby follows PostgreSQL — old versions stay **in the same heap** (append-only). That choice pays one elegant dividend: **rollback is free.** Abort by marking "aborted" in the TxnLog, and every version that transaction created becomes invisible **automatically** by the visibility rule. Nothing to physically revert. (InnoDB inverts the trade: it replays undo to physically revert, but its heap always holds only the latest version, keeping reads light — the full picture in [ACID ①](/blog/theory/transaction-acid-01-atomicity).)

## 3. DELETE Doesn't Delete — the xmax Stamp and Nine Gates

The visibility rule has one fatal precondition — **DELETE must not physically remove the row.** Remove it and you can't keep "an uncommitted delete must still be visible" (to readers' snapshots), and DELETE rollback would depend on physical restoration.

So DELETE stamps: instead of freeing the slot, it **overwrites just the 4 xmax bytes in place.**

```c
static int stamp_xmax(Table *t, RID rid, int32_t xmax) {
    uint8_t rec[PAGE_SIZE]; uint16_t len;
    heap_get(&t->heap, rid, rec, &len);
    memcpy(rec + 4, &xmax, 4);                     /* MVCC header = [xmin(4)][xmax(4)] */
    return heap_overwrite(&t->heap, rid, rec, len); /* same length, in place */
}
```

UPDATE follows suit — `stamp_xmax` on the old version, insert the new version at a new RID. Exactly how PostgreSQL handles UPDATE.

### The Price — Every Heap-Reading Path Must Know Visibility

The moment "deleted rows physically exist," **every** path that reads the heap must filter versions. Counting them: nine — full scan, PK point lookup, PK range, secondary index, three join flavors (nested-loop, hash build, index NLJ), aggregate/sort materialization, DML target collection, CREATE INDEX build. The gate is one line; correctness requires installing it in all nine places. Miss one and that path alone sees ghosts.

![The xmax gate — every heap-reading path passes the visibility check](/uploads/project/db-hobby/mvcc-xmax-gate.svg)

One important observation about indexes:

> **Indexes don't know MVCC.** A B+Tree knows (key → RID), not which transaction can see that RID's row. So every index path becomes two-stage: "index narrows candidates → read the row from the heap → the gate decides." The same reason PostgreSQL's index scans visit the heap for visibility (and keep a visibility map to save that cost). [Part 2](/blog/project/db-hobby/db-internals-02-btree-index)'s principle — "the index only narrows; the truth lives in the heap" — becomes a survival condition under MVCC.

The reward came instantly — **DELETE rollback comes back to life.** If the transaction that stamped xmax aborts, the visibility rule voids the stamp: one ROLLBACK and the deleted row returns — as a logical consequence, not physical restoration.

## 4. Garbage Made on Purpose — VACUUM

Now a new problem: since DELETE doesn't delete, **dead tuples pile up forever.** DELETE all you want; the file shrinks by zero bytes. This is MVCC's bill, and the janitor is **VACUUM.**

**Who's dead?** The principle: "a version that cannot be visible to any transaction, now or ever." In general that's a delicate judgment over all live snapshots (PostgreSQL's oldest-xmin horizon); in a single-node mini DB it collapses to "a version with a committed xmax." Like PostgreSQL, VACUUM refuses to run inside a transaction block.

**The janitor's three jobs** — order matters:

```
① delete index entries pointing at dead versions   (lazy B+Tree deletion)
② free heap slots and compact pages                (slot numbers = RIDs stay fixed!)
③ truncate the file only if trailing pages are all empty
```

![VACUUM — collect dead versions, remove index entries, compact pages, truncate the tail](/uploads/project/db-hobby/vacuum-sweep.svg)

② preserves slot numbers for [Part 1](/blog/project/db-hobby/db-internals-01-storage)'s reason — the slot number *is* the RID and indexes point at it. ③ trims **only all-empty trailing pages**, leaving empty pages in the middle — exactly what PostgreSQL's VACUUM does, which is why **"I ran VACUUM and the file didn't shrink"** is so common (space became reusable but wasn't returned to the OS).

**B+Tree deletion — unlike the textbook.** Cleaning dead versions leaves index entries pointing at nothing, so they must go. Before porting the textbook (merge/redistribute), look at a real DB: **PostgreSQL's nbtree doesn't redistribute** — it removes leaf entries and recycles fully-empty pages, leaving half-empty nodes alone. So **lazy deletion** suffices. The point is deleting **(key, RID) pairs**, not keys — an UPDATEd PK's key already points at the live new version, so deleting by pair protects live entries.

## 5. True Snapshot Isolation — Removing the Readers' Locks

All the parts are assembled. The final move of the philosophy switch: **SELECT takes no locks.**

```c
static int acquire_stmt_locks(Database *db, const Statement *st, int txn, FILE *out) {
    switch (st->type) {
        case STMT_INSERT: case STMT_DELETE: case STMT_UPDATE:
            return lock_one(db, ..., LOCK_X, txn, out);  /* writes only: X lock */
        default: return 0;                                /* SELECT: no lock */
    }
}
```

"How do you prevent dirty reads without locks?" — **that's no longer the lock's job.** A writer's uncommitted version has an uncommitted xmin, so the gate filters it. An UPDATE's old version has an uncommitted xmax, so it's **still visible.** The reader isn't rejected — it simply **reads the old version.** Splitting instead of blocking; §1's table became code.

**Pinning time — the BEGIN snapshot.** With locks gone, isolation is decided wholly by visibility — but seeing "what's committed *now*" is read committed (a neighbor's commit between two identical SELECTs changes the result). For snapshot isolation, pin time at BEGIN. The implementation is a miniature of PostgreSQL's snapshot: record ① the boundary of transactions born later (`snap_next`) and ② the list of others' transactions currently open (`snap_inprog`); visibility counts a transaction as "committed" only if it also passes the snapshot. Exactly PG's `xmax` (boundary) and `xip` (in-progress list). Inside a transaction: REPEATABLE READ; bare statements outside: read committed — the same two-layer scheme as PostgreSQL's defaults.

**Blocking only write-write — first-updater-wins.** Two transactions modifying the same data is the one thing versions can't dodge (lost update). Keep X locks on writes only; on conflict, the latecomer yields. PostgreSQL does this **per row** (raising serialization failures under REPEATABLE READ); db-hobby's is per table — coarser, but a difference of granularity, not philosophy.

**An unexpected aftermath — the PK index had to go multi-version.** With all this in place, the snapshot tests broke. The culprit: the PK index, hitherto unique — UPDATE **overwrote** the key's entry with the new RID, and at that instant **the index path to the old version was severed.** A snapshot reader querying via the index got nothing while a full scan showed the row. PostgreSQL already knew the answer — **the index holds an entry per version.** The PK index becomes a multimap hanging several RIDs off one key (`btree_insert_dup`), and lookups pick the visible version among candidates. That is the answer to [Part 2](/blog/project/db-hobby/db-internals-02-btree-index)'s subtitle — "why an index isn't a simple key→value map."

![Multiple sessions — one transaction holds an uncommitted UPDATE while another reads the old version unblocked](/uploads/project/db-hobby/multi-txn-sessions.svg)

And now the scene actually runs:

```
SESSION 0> BEGIN; UPDATE t SET v = 999 WHERE id = 1;   -- holding an uncommitted write
SESSION 1> SELECT * FROM t WHERE id = 1;
1 | 100                                                  -- reads the old version, unblocked
SESSION 0> COMMIT;
SESSION 1> SELECT * FROM t WHERE id = 1;
1 | 999                                                  -- (outside a txn) now the new value
```

**Readers don't block writers** — as execution, not demonstration.

## 6. Wrap-up

- **Two philosophies**: 2PL prevents (locks; deadlock cost), MVCC avoids by splitting versions (dead tuples; VACUUM cost). The bill arrives at different times — during execution vs in the background.
- **MVCC's brain is one line** — xmin committed AND xmax not. A transaction-status array (CLOG) plus an 8-byte row header is all it takes. **Rollback falls out for free.**
- **DELETE doesn't delete** — it stamps xmax. The price: gates on all nine heap-reading paths, and the principle **"indexes don't know MVCC."**
- **VACUUM** — dead = committed xmax; delete index (key,RID) pairs lazily (PG's nbtree doesn't redistribute either); RID-preserving compaction; truncate only the tail (hence files rarely shrink).
- **Snapshot isolation** — remove reader locks + BEGIN snapshot (xmax/xip) + first-updater-wins on writes only. Aftermath: **the PK index becomes a multi-version multimap.**

Next: punching a **network** hole into this engine — a PostgreSQL wire protocol server that a real `psql` connects to.

## References (primary sources first)

- [PostgreSQL Documentation: Concurrency Control (MVCC)](https://www.postgresql.org/docs/current/mvcc.html)
- [PostgreSQL Documentation: Routine Vacuuming](https://www.postgresql.org/docs/current/routine-vacuuming.html)
- [MySQL 8.0 Reference: InnoDB Multi-Versioning](https://dev.mysql.com/doc/refman/8.0/en/innodb-multi-versioning.html)
- Hal Berenson et al., *A Critique of ANSI SQL Isolation Levels* (SIGMOD 1995)
- This blog: [Transaction ACID ①: Atomicity](/blog/theory/transaction-acid-01-atomicity) · [②: Isolation](/blog/theory/transaction-acid-02-isolation) · [Lock Mechanisms](/blog/theory/lock-mechanisms-all)
- [db-hobby source (GitHub)](https://github.com/dj258255/db-hobby) — `mvcc.c` · `lock.c` · `db.c`

---
title: 'reader는 writer를 기다리지 않는다 — 다중 트랜잭션, 13편이 남긴 마지막 벽'
titleEn: "Readers Don't Wait for Writers — Multi-Transaction, the Last Wall Part 13 Left Behind"
description: "13편부터 17편까지 MVCC의 모든 부품을 지었다 — 버전 헤더, 가시성 규칙, steal과 undo, no-force WAL, xmax 논리 삭제, VACUUM. 그런데 정작 MVCC의 존재 이유인 'reader가 writer를 안 막는다'를 보여줄 수 없었다. 트랜잭션을 동시에 두 개 열 수조차 없고(단일 핸들), SELECT가 여전히 11편의 S락을 잡아 writer와 충돌하면 거부됐으니까 — 지금까지의 db-hobby는 'MVCC의 뼈대를 가진 2PL DB'였던 셈이다. 이번 편이 그 마지막 벽을 넘는다: 세션(SESSION n)으로 다중 트랜잭션 핸들을 열고, reader의 락을 제거해 격리를 가시성에 맡기고, BEGIN 시점 스냅샷으로 REPEATABLE READ를 세우고, 쓰기 충돌은 first-updater-wins로 즉시 거부한다. 예상 못 한 여파도 정직하게 — PK 인덱스가 다중 버전이 되어야 했던 이유, 테이블별 WAL이 다중 트랜잭션에서도 무수정으로 살아남은 설계 행운(사실은 X락의 필연), 그리고 닫힘=롤백이라는 진짜 DB의 커넥션 의미론까지."
descriptionEn: "From Parts 13 through 17 we built every component of MVCC — version headers, the visibility rule, steal and undo, a no-force WAL, xmax logical deletion, VACUUM. Yet we couldn't demonstrate MVCC's reason for existing: 'readers don't block on writers.' We couldn't even open two transactions at once (a single handle), and SELECT still took Part 11's S lock, getting rejected on conflict with a writer — db-hobby so far was 'a 2PL database wearing MVCC's skeleton.' This part crosses that final wall: open multiple transaction handles via sessions (SESSION n), remove the reader's lock and hand isolation to visibility, pin a begin-time snapshot for REPEATABLE READ, and reject write-write conflicts immediately as first-updater-wins. The unexpected fallout, honestly told — why the PK index had to become multi-version, the design luck (actually the X lock's necessity) that let the per-table WAL survive multi-transaction unchanged, and the real-database connection semantics of close-equals-rollback."
date: 2026-07-03
tags:
  - C
  - Database Internals
  - MVCC
  - Transaction
  - Snapshot Isolation
  - Concurrency
  - PostgreSQL
  - Learning
category: study/db-hobby
coverImage: /uploads/project/db-hobby/cover.svg
draft: false
series: "db-hobby"
seriesOrder: 18
---

## 0. 들어가며 — 부품은 다 있는데 엔진이 안 돈다

[13편](/blog/project/db-hobby/db-hobby-13-mvcc)부터 [17편](/blog/project/db-hobby/db-hobby-17-vacuum)까지, MVCC의 부품을 전부 지었어요. 버전 헤더(xmin/xmax), 가시성 규칙, steal과 before-image undo([14편](/blog/project/db-hobby/db-hobby-14-steal-undo)), 로그가 진실인 no-force WAL([15편](/blog/project/db-hobby/db-hobby-15-noforce-checkpoint)), DELETE의 논리 삭제([16편](/blog/project/db-hobby/db-hobby-16-delete-xmax)), 그리고 청소부 VACUUM(17편).

그런데 이 모든 걸 짓고도, **MVCC의 존재 이유를 보여줄 수 없었습니다.** "reader가 writer를 안 막는다" — 이 한 문장을 시연하려면 트랜잭션 두 개가 동시에 떠 있어야 하는데:

1. 실행기가 트랜잭션 핸들을 **하나**만 가집니다(`cur_txn` 단일 변수). BEGIN을 두 번 하면 "이미 트랜잭션 중입니다".
2. SELECT가 여전히 [11편](/blog/project/db-hobby/db-hobby-11-isolation)의 **S락**을 잡습니다. writer가 X락을 쥔 테이블을 읽으려 하면 — MVCC가 무색하게 — **거부**됩니다.

즉 지금까지의 db-hobby는 정직하게 말해 **"MVCC의 뼈대를 가진 2PL DB"** 였어요. 이번 편이 그 마지막 벽을 넘습니다. 13편이 "코어 재작성 프론티어"라고 적어 둔 바로 그 지점이에요.

## 1. 문을 연다 — 세션

첫 번째 문제(핸들 하나)부터. db-hobby는 단일 스레드라 진짜 동시 실행은 없지만, 트랜잭션의 동시성은 스레드가 아니라 **상태**의 문제입니다 — 두 트랜잭션이 "열린 채로" 문장을 번갈아 실행할 수 있으면(인터리브) 격리 의미론은 완전하게 시연돼요. 그래서 **세션**을 만들었습니다.

```c
/* 한 세션 = 하나의 (열려 있을 수 있는) 트랜잭션 핸들 */
typedef struct {
    int in_txn; /* BEGIN 중인가 */
    int txn;    /* 이 세션의 트랜잭션 id */
    int snap_next;                     /* 시작 스냅샷: 이후 발급된 id는 안 보임 */
    int snap_inprog[DB_MAX_SESSIONS];  /*             시작 시점 진행 중이던 id들 */
    int n_snap_inprog;
} DbSession;
```

`SESSION n`(0~7)으로 갈아탑니다. psql 터미널 두 개를 나란히 띄워 놓고 번갈아 입력하는 것의 db-hobby판이에요.

```
db-hobby> BEGIN;                        -- 세션 0에서 트랜잭션 시작
db-hobby> UPDATE t SET v=999 WHERE id=1;
db-hobby> SESSION 1;                    -- 다른 세션으로 전환
db-hobby> SELECT * FROM t WHERE id=1;   -- 이제 이게 어떻게 될까?
```

## 2. 자물쇠를 바꾼다 — reader의 락을 제거

두 번째 문제가 이 편의 심장입니다. [12편](/blog/project/db-hobby/db-hobby-12-2pl-vs-mvcc)에서 2PL과 MVCC를 "정반대 철학"으로 비교했었죠 — 2PL은 충돌을 **막고**, MVCC는 버전을 **갈라** 피한다고. 그 철학 전환이 코드로는 딱 한 가지 변경입니다: **SELECT가 락을 안 잡는다.**

```c
/* 쓰기 문장만 X락. SELECT는 락을 안 잡는다 — 11편의 S락은
 * MVCC 가시성(스냅샷)으로 대체됐다: reader는 writer의 미커밋 버전을
 * '가시성으로' 못 볼 뿐, 막히지 않는다. */
static int acquire_stmt_locks(Database *db, const Statement *st, int txn, FILE *out) {
    switch (st->type) {
        case STMT_INSERT: return lock_one(db, st->insert.table, LOCK_X, txn, out);
        case STMT_DELETE: return lock_one(db, st->del.table,    LOCK_X, txn, out);
        case STMT_UPDATE: return lock_one(db, st->upd.table,    LOCK_X, txn, out);
        default:          return 0; /* SELECT: 락 없음 */
    }
}
```

여기서 "락 없이 어떻게 dirty read를 막지?"가 자연스러운 질문인데 — **그걸 막는 게 더 이상 락의 일이 아닙니다.** writer의 미커밋 버전은 xmin이 미커밋이라 가시성 게이트([16편](/blog/project/db-hobby/db-hobby-16-delete-xmax)에서 아홉 갈래 전부에 달아 둔 그 게이트)가 걸러요. UPDATE의 옛 버전은 xmax가 미커밋이라 **여전히 보이고요**. reader는 거부당하는 게 아니라, 그냥 **옛 버전을 읽습니다.**

11편에서 S락으로 시연했던 dirty read 방지가, 같은 결과를 **정반대 메커니즘**으로 얻게 된 겁니다. 막는 대신 가르기 — 12편의 표가 코드가 됐어요.

## 3. 시간을 고정한다 — BEGIN 시점 스냅샷

락을 없앴으니 reader의 격리 수준은 온전히 가시성이 정합니다. 그런데 지금까지의 가시성은 "**지금** 커밋된 것"을 봤어요(read committed식 — [13편](/blog/project/db-hobby/db-hobby-13-mvcc)에서 미뤄 둔 그 항목). 트랜잭션 안에서 같은 SELECT를 두 번 했는데 사이에 남이 커밋하면 결과가 달라집니다(non-repeatable read). 스냅샷 격리라 부르려면 **시간을 BEGIN 시점에 고정**해야 해요.

구현은 PostgreSQL 스냅샷의 축소판입니다 — BEGIN 때 두 가지를 기록해요.

```c
s->snap_next = db->next_txn;      /* ① 이후에 태어날 트랜잭션들의 경계 */
s->n_snap_inprog = 0;             /* ② 지금 열려 있는 남의 트랜잭션들 */
for (각 다른 세션 i)
    if (sessions[i].in_txn) s->snap_inprog[적재] = sessions[i].txn;
```

그리고 가시성 판정이 이 스냅샷을 통과해야 "커밋됨"으로 칩니다.

```c
/* 커밋돼 있어도: 내 시작 이후에 태어났거나(>= snap_next),
 * 시작 시점에 진행 중이던 트랜잭션이면 -> 나에겐 '아직 커밋 안 됨' */
if (txn >= s->snap_next) return 0;
for (i < s->n_snap_inprog) if (snap_inprog[i] == txn) return 0;
```

PostgreSQL 스냅샷의 `xmax`(경계)와 `xip`(in-progress 목록)에 정확히 대응합니다. 이로써 트랜잭션 안은 **REPEATABLE READ**, 트랜잭션 밖의 단문은 read committed — PostgreSQL의 기본 구도와 같은 두 층이에요.

## 4. 충돌만은 막는다 — first-updater-wins

읽기를 다 풀어 줬으니 쓰기-쓰기만 남습니다. 두 트랜잭션이 같은 데이터를 고치는 것만은 버전으로 피할 수 없어요 — lost update가 되니까. db-hobby의 답은 **테이블 X락(strict 2PL) 유지**: 첫 writer가 락을 쥐면, 같은 테이블의 두 번째 writer는 (단일 스레드라 대기 대신) **즉시 거부**됩니다.

```
db-hobby> SESSION 1;
db-hobby> UPDATE t SET v = 555 WHERE id = 1;
ERROR: 테이블 't'가 다른 트랜잭션에 잠겨 있습니다 (쓰기 충돌)
```

이게 **first-updater-wins**입니다 — 먼저 고친 쪽이 이기고, 뒤에 온 쪽이 물러나요. PostgreSQL은 이걸 **행 단위**로 합니다(같은 행을 고칠 때만 충돌하고, REPEATABLE READ에선 serialization failure를 던짐). db-hobby는 테이블 단위라 더 거칠지만, "쓰기 충돌은 누군가 양보해야 한다"는 원리는 동일해요 — granularity의 차이지 철학의 차이가 아닙니다(정직하게 명시).

그리고 이 X락이 뜻밖의 선물을 줍니다. **"테이블당 writer는 언제나 하나"** 라는 불변식이요. 테이블별 WAL은 여전히 한 번에 한 트랜잭션의 변경만 보게 되고 — 그래서 [14](/blog/project/db-hobby/db-hobby-14-steal-undo)·[15편](/blog/project/db-hobby/db-hobby-15-noforce-checkpoint)에서 지은 steal/undo/no-force 복구가 **한 줄도 안 바뀌고** 다중 트랜잭션에서 성립합니다. 행운처럼 보이지만 사실 필연이에요: WAL의 단일-트랜잭션 가정을 지켜 주는 게 정확히 그 락이니까. 대신 COMMIT/ROLLBACK은 이제 "내가 쓴 테이블만"(`writer_txn == 나`) 확정/원복합니다 — 남의 미커밋을 건드리면 안 되니까요.

## 5. 예상 못 한 여파 — PK 인덱스가 다중 버전이 되어야 했다

여기까지 설계하고 테스트를 돌렸더니, 스냅샷 시나리오가 깨졌습니다. 원인을 좇으니 **PK 인덱스**였어요.

지금까지 PK 인덱스는 유니크였습니다 — `UPDATE`가 새 버전을 만들면 키의 항목을 새 RID로 **덮어썼어요**. 단일 트랜잭션에선 문제가 없었죠(옛 버전은 어차피 아무에게도 안 보이니). 그런데 스냅샷 reader가 생기니: writer가 v=999로 UPDATE하는 순간 인덱스의 키 1이 새 버전만 가리키고, **옛 버전(100)으로 가는 인덱스 경로가 끊깁니다.** reader가 `WHERE id=1`을 인덱스로 조회하면 미커밋 새 버전에 막혀 빈 결과 — 풀스캔으로는 보이는 행이 인덱스로는 안 보이는 모순이에요.

답은 PostgreSQL이 이미 알고 있었습니다 — **인덱스도 버전마다 항목을 갖는다.**

```c
/* INSERT/UPDATE: 유니크 덮어쓰기(btree_insert) 대신 짝 추가(btree_insert_dup).
 * 같은 PK의 옛/새 버전 항목이 공존하고, 조회가 '보이는' 버전을 고른다. */
btree_insert_dup(&t->index, row[0].int_val, rid_encode(newrid));
```

점 조회와 인덱스 조인은 이제 후보들을 훑어 **보이는 버전**을 고릅니다(16편의 "인덱스는 MVCC를 모른다 — 판정은 힙에서" 원칙이 PK까지 확장). 그리고 죽은 버전의 항목은 [17편](/blog/project/db-hobby/db-hobby-17-vacuum) VACUUM이 (키,RID) 짝으로 지워요 — 17편에서 "UPDATE된 PK는 건드리면 안 된다"고 조심하던 특례가, 다중 버전 인덱스에선 "그냥 짝을 지우면 된다"로 **오히려 단순해졌습니다.** 부품들이 서로 맞물리는 순간이에요.

마지막 디테일 하나 — `db_close`가 이제 **열린 트랜잭션을 롤백하고** 닫습니다. 진짜 DB에서 커넥션이 끊기면 그 트랜잭션이 abort되는 것과 같은 의미론이고, 안 그러면 닫힘 flush가 미커밋 페이지를 디스크에 쓰고 재오픈 시 커밋으로 승격되는 유출이 생겨요.

## 6. 시연 — 13편이 원했던 바로 그 장면

`test_multitxn`(신설 17 시나리오)의 핵심 장면:

```
ok   writer(세션0) 자신은 자기 미커밋 값을 본다
ok   reader(세션1)는 writer에게 안 막힌다 — 거부 없음
ok   reader는 옛 버전(100)을 본다 — dirty read 없음 (락이 아니라 가시성)
ok   두 번째 writer(세션1)의 UPDATE -> 즉시 거부 (first-updater-wins)
ok   세션1(스냅샷)은 여전히 999 — 시작 이후의 커밋은 안 보인다 (REPEATABLE READ)
ok   시작 시점에 진행 중이던 트랜잭션의 INSERT는 커밋됐어도 안 보임 (스냅샷)
ok   세션1이 롤백한 b의 행은 사라진다 (커밋/롤백이 테이블별로 독립)
ok   재오픈 후 b: 0행 (두 세션의 미커밋이 모두 롤백)
```

REPL에서 직접 치면 이렇게 보입니다 — 13편이 "언젠가"로 미뤄 뒀던 바로 그 장면이에요.

```
db-hobby> BEGIN;  UPDATE t SET v=999 WHERE id=1;   -- 세션 0: 미커밋 writer
db-hobby> SESSION 1;
db-hobby> SELECT * FROM t WHERE id=1;
1 | 100                          ← 거부가 아니라 '옛 버전'. reader는 기다리지 않았다
db-hobby> UPDATE t SET v=555 WHERE id=1;
ERROR: 쓰기 충돌                  ← 쓰기만은 first-updater-wins
db-hobby> SESSION 0;  COMMIT;
db-hobby> SESSION 1;  SELECT * FROM t WHERE id=1;
1 | 999                          ← 커밋 후엔 새 값
```

전체 스위트 **396개 테스트 / 24스위트 green** — S락 제거로 11편의 격리 테스트도 새 의미론("SELECT는 안 막힘")으로 갱신됐고, 나머지는 무회귀입니다.

> **실무/면접 포인트**: "PostgreSQL에서 SELECT가 UPDATE 중인 행을 읽으면 어떻게 되나?"의 정답 구조가 이 편 그대로입니다 — ① 안 막힌다(reader는 락 없음), ② 스냅샷에 따라 옛 버전을 본다, ③ 단 `SELECT FOR UPDATE`처럼 락을 명시하면 그때는 기다린다. 그리고 "REPEATABLE READ에서 동시 UPDATE가 충돌하면?" → first-updater-wins, 진 쪽은 `could not serialize access` — db-hobby의 즉시 거부가 그 축소판이에요.

![다중 트랜잭션 — 세션0(writer)이 미커밋 UPDATE를 든 동안 세션1(reader)은 막히지 않고 스냅샷으로 옛 버전을 읽는다. 같은 테이블에 쓰려는 두 번째 writer만 first-updater-wins로 즉시 거부. 테이블 X락이 '테이블당 writer 하나'를 보장해 테이블별 WAL 복구가 무수정 성립](/uploads/project/db-hobby/multi-txn-sessions.svg)

## 7. 정리 — 13편의 표, 전부 O가 되다

[13편](/blog/project/db-hobby/db-hobby-13-mvcc) 정리표의 마지막 X까지 닫혔습니다.

| 항목 | 13편 | 18편 |
|---|---|---|
| 가시성 규칙 · 버전 헤더 · abort 롤백 | O | O |
| SELECT가 가시성으로 거름 | 풀스캔만 | 아홉 갈래 전부 (16편) |
| DELETE를 xmax가 주도 | X | O (16편) |
| 죽은 버전 청소 | — | O (17편 VACUUM) |
| **reader가 writer를 안 막는 동시성** | **X** | **O — 세션 + 무락 읽기 + 스냅샷** |
| 쓰기-쓰기 충돌 처리 | — | O — first-updater-wins (테이블 단위) |
| 트랜잭션 시작 스냅샷 | X (read committed식) | O — REPEATABLE READ |

13편은 이렇게 끝났었어요 — *"어떤 기능은 끼워넣는 게 아니라 처음부터 그걸 위해 설계해야 한다."* 다섯 편에 걸쳐 그 "처음부터"를 다시 만들었습니다: steal(14) → no-force(15) → xmax(16) → VACUUM(17) → 그리고 이번 편에서 문이 열렸어요. **한 걸음씩 초록불을 지키며 걸으면, 갈아엎어야 한다던 코어도 결국 건너갈 수 있다** — 이 시리즈가 몸으로 배운 것입니다.

남은 지평은 이제 결이 다른 것들이에요 — 진짜 스레드 동시성(latch, 블로킹 락)과 psql이 붙는 네트워크 서버. 단일 노드 in-process DB로서의 db-hobby는, 여기서 한 챕터를 닫습니다.

## 참고

- [PostgreSQL Documentation: Transaction Isolation (repeatable read, first-updater-wins)](https://www.postgresql.org/docs/current/transaction-iso.html)
- [The Internals of PostgreSQL: Concurrency Control — snapshots (xmin/xmax/xip)](https://www.interdb.jp/pg/pgsql05.html)
- 본 시리즈: [11편 2PL](/blog/project/db-hobby/db-hobby-11-isolation) · [12편 2PL vs MVCC](/blog/project/db-hobby/db-hobby-12-2pl-vs-mvcc) · [13편 MVCC](/blog/project/db-hobby/db-hobby-13-mvcc) · [16편 DELETE=xmax](/blog/project/db-hobby/db-hobby-16-delete-xmax) · [17편 VACUUM](/blog/project/db-hobby/db-hobby-17-vacuum)

<!-- EN -->

## 0. Introduction — All the Parts, but the Engine Won't Turn

From [Part 13](/blog/project/db-hobby/db-hobby-13-mvcc) to [Part 17](/blog/project/db-hobby/db-hobby-17-vacuum), we built every component of MVCC: version headers (xmin/xmax), the visibility rule, steal with before-image undo ([Part 14](/blog/project/db-hobby/db-hobby-14-steal-undo)), a no-force WAL where the log is the truth ([Part 15](/blog/project/db-hobby/db-hobby-15-noforce-checkpoint)), logical DELETE ([Part 16](/blog/project/db-hobby/db-hobby-16-delete-xmax)), and the janitor VACUUM (17).

And yet, with all of it built, **we couldn't demonstrate MVCC's reason for existing.** "Readers don't block on writers" — showing that one sentence requires two transactions alive at once, but:

1. The executor had **one** transaction handle (a single `cur_txn`). A second BEGIN got "already in a transaction."
2. SELECT still took [Part 11](/blog/project/db-hobby/db-hobby-11-isolation)'s **S lock**. Reading a table whose writer held X — MVCC notwithstanding — got **rejected**.

Honestly put, db-hobby so far was **"a 2PL database wearing MVCC's skeleton."** This part crosses the last wall — exactly the spot Part 13 marked as the "core-rewrite frontier."

## 1. Open the Door — Sessions

First problem (one handle). db-hobby is single-threaded, so there's no true parallel execution — but transaction concurrency is a matter of **state**, not threads: if two transactions can stay *open* while their statements interleave, isolation semantics can be demonstrated completely. So: **sessions**.

```c
/* One session = one (possibly open) transaction handle */
typedef struct {
    int in_txn;
    int txn;
    int snap_next;                     /* snapshot: ids born later are invisible */
    int snap_inprog[DB_MAX_SESSIONS];  /*           ids in progress at begin     */
    int n_snap_inprog;
} DbSession;
```

`SESSION n` (0–7) switches between them — db-hobby's version of two psql terminals side by side.

```
db-hobby> BEGIN;                        -- start a transaction in session 0
db-hobby> UPDATE t SET v=999 WHERE id=1;
db-hobby> SESSION 1;                    -- switch
db-hobby> SELECT * FROM t WHERE id=1;   -- now what happens?
```

## 2. Change the Locks — Remove the Reader's Lock

The second problem is this part's heart. [Part 12](/blog/project/db-hobby/db-hobby-12-2pl-vs-mvcc) compared 2PL and MVCC as "opposite philosophies" — 2PL **blocks** conflicts, MVCC **splits versions** to avoid them. In code, that philosophy switch is exactly one change: **SELECT takes no lock.**

```c
/* Only writes take X locks. SELECT locks nothing — Part 11's S lock is
 * replaced by MVCC visibility: a reader simply cannot SEE a writer's
 * uncommitted version; it is never blocked by it. */
static int acquire_stmt_locks(Database *db, const Statement *st, int txn, FILE *out) {
    switch (st->type) {
        case STMT_INSERT: return lock_one(db, st->insert.table, LOCK_X, txn, out);
        case STMT_DELETE: return lock_one(db, st->del.table,    LOCK_X, txn, out);
        case STMT_UPDATE: return lock_one(db, st->upd.table,    LOCK_X, txn, out);
        default:          return 0; /* SELECT: no lock */
    }
}
```

"Without locks, what stops dirty reads?" — **that's no longer the lock's job.** A writer's uncommitted version has an uncommitted xmin, so the visibility gate (the one [Part 16](/blog/project/db-hobby/db-hobby-16-delete-xmax) installed on all nine read paths) filters it. The UPDATE's old version has an uncommitted xmax, so it's **still visible**. The reader isn't rejected — it just **reads the old version.**

The dirty-read prevention Part 11 demonstrated with S locks is now achieved by the **opposite mechanism**. Split instead of block — Part 12's table became code.

## 3. Freeze Time — the Begin-Time Snapshot

With locks gone, the reader's isolation is entirely visibility's doing. But visibility so far saw "what's committed **now**" (read-committed-style — the item [Part 13](/blog/project/db-hobby/db-hobby-13-mvcc) deferred). Run the same SELECT twice inside a transaction and someone commits in between — the results differ (non-repeatable read). To call it snapshot isolation, **time must freeze at BEGIN.**

The implementation is a miniature of PostgreSQL's snapshot — record two things at BEGIN:

```c
s->snap_next = db->next_txn;      /* ① boundary: ids born after me */
s->n_snap_inprog = 0;             /* ② other transactions open right now */
for (each other session i)
    if (sessions[i].in_txn) s->snap_inprog[...] = sessions[i].txn;
```

And the visibility verdict must pass the snapshot before counting as "committed":

```c
/* Even if committed: born after my begin (>= snap_next), or in progress
 * at my begin -> to me, "not committed yet" */
if (txn >= s->snap_next) return 0;
for (i < s->n_snap_inprog) if (snap_inprog[i] == txn) return 0;
```

This maps exactly to PostgreSQL's snapshot `xmax` (boundary) and `xip` (in-progress list). Inside a transaction: **REPEATABLE READ**; bare statements outside: read committed — the same two-layer picture as PostgreSQL's defaults.

## 4. Block Only Conflicts — First-Updater-Wins

Reads are free; only write-write remains. Two transactions modifying the same data cannot be version-split away — that's a lost update. db-hobby's answer: **keep the table X lock (strict 2PL)**. Once the first writer holds it, a second writer on the same table is (single-threaded, so instead of waiting) **rejected immediately**.

```
db-hobby> SESSION 1;
db-hobby> UPDATE t SET v = 555 WHERE id = 1;
ERROR: table 't' is locked by another transaction (write conflict)
```

That's **first-updater-wins** — the first modifier wins; the latecomer backs off. PostgreSQL does this at **row granularity** (conflicting only on the same row, throwing serialization failure under REPEATABLE READ). db-hobby's table granularity is coarser, but the principle — "on a write conflict, someone must yield" — is identical. A granularity difference, not a philosophy difference (stated honestly).

And the X lock gives an unexpected gift: the invariant **"one writer per table, always."** Each table's WAL still sees only one transaction's changes at a time — so the steal/undo/no-force recovery built in [Parts 14](/blog/project/db-hobby/db-hobby-14-steal-undo)–[15](/blog/project/db-hobby/db-hobby-15-noforce-checkpoint) holds under multi-transaction **without changing a line**. It looks like luck; it's necessity — that lock is precisely what preserves the WAL's single-transaction assumption. In exchange, COMMIT/ROLLBACK now finalize/revert **only the tables I wrote** (`writer_txn == me`) — you must not touch someone else's uncommitted work.

## 5. Unexpected Fallout — the PK Index Had to Go Multi-Version

With all that designed, the snapshot scenarios failed. The culprit: the **PK index**.

Until now the PK index was unique — an `UPDATE` **overwrote** the key's entry with the new RID. Fine under a single transaction (nobody could see the old version anyway). But with a snapshot reader alive: the moment the writer UPDATEs to v=999, index key 1 points only at the new version, and **the index path to the old version (100) is severed.** An indexed `WHERE id=1` hits the invisible uncommitted version and returns nothing — visible via full scan, invisible via index. A contradiction.

PostgreSQL already knew the answer — **the index, too, keeps an entry per version.**

```c
/* INSERT/UPDATE: add a (key,RID) pair (btree_insert_dup) instead of unique
 * overwrite. Old and new versions' entries coexist; lookups pick the visible one. */
btree_insert_dup(&t->index, row[0].int_val, rid_encode(newrid));
```

Point lookups and index joins now walk the candidates and pick the **visible** version (Part 16's principle — "indexes don't know MVCC; the heap decides" — extended to the PK). Dead versions' entries are removed by [Part 17](/blog/project/db-hobby/db-hobby-17-vacuum)'s VACUUM as (key,RID) pairs — and the careful special case from Part 17 ("don't touch an UPDATEd PK's entry") **simplifies away** under the multi-version index: just delete the pair. The parts interlocking.

One last detail — `db_close` now **rolls back open transactions** before closing. Same semantics as a real database aborting a dropped connection's transaction; otherwise the closing flush would write uncommitted pages to disk and the reopen would promote them to committed.

## 6. The Demonstration — the Very Scene Part 13 Wanted

Highlights from the new `test_multitxn` (17 scenarios):

```
ok   the writer (session 0) sees its own uncommitted value
ok   the reader (session 1) is not blocked by the writer — no rejection
ok   the reader sees the old version (100) — no dirty read (visibility, not locks)
ok   a second writer's UPDATE -> rejected immediately (first-updater-wins)
ok   session 1 (snapshot) still sees 999 — commits after my begin are invisible
ok   an INSERT by a txn in-progress at my begin stays invisible even after it commits
ok   session 1's rollback erases b's row (commit/rollback independent per table)
ok   after reopen, b has 0 rows (both sessions' uncommitted work rolled back)
```

At the REPL, it looks like this — the scene Part 13 deferred to "someday":

```
db-hobby> BEGIN;  UPDATE t SET v=999 WHERE id=1;   -- session 0: uncommitted writer
db-hobby> SESSION 1;
db-hobby> SELECT * FROM t WHERE id=1;
1 | 100                          ← not a rejection: the OLD version. The reader never waited
db-hobby> UPDATE t SET v=555 WHERE id=1;
ERROR: write conflict             ← only writes obey first-updater-wins
db-hobby> SESSION 0;  COMMIT;
db-hobby> SESSION 1;  SELECT * FROM t WHERE id=1;
1 | 999                          ← after commit, the new value
```

Full suite: **396 checks / 24 suites green** — Part 11's isolation test was updated to the new semantics ("SELECT is never blocked"); everything else passed unchanged.

> **Practical/interview note**: "In PostgreSQL, what happens when SELECT reads a row being UPDATEd?" — the answer's structure is this part verbatim: ① it doesn't block (readers take no locks), ② it sees the old version per its snapshot, ③ unless you explicitly lock (`SELECT FOR UPDATE`), in which case it waits. And "what if two UPDATEs collide under REPEATABLE READ?" → first-updater-wins; the loser gets `could not serialize access` — db-hobby's immediate rejection is the miniature of that.

![Multi-transaction — while session 0 (writer) holds an uncommitted UPDATE, session 1 (reader) is never blocked and reads the old version through its snapshot. Only a second writer on the same table is rejected immediately (first-updater-wins). The table X lock guarantees one writer per table, so per-table WAL recovery holds unchanged](/uploads/project/db-hobby/multi-txn-sessions.svg)

## 7. Wrap-up — Every X in Part 13's Table Is Now an O

The last X in [Part 13](/blog/project/db-hobby/db-hobby-13-mvcc)'s wrap-up table is closed.

| Item | Part 13 | Part 18 |
|---|---|---|
| Visibility rule · version header · abort rollback | O | O |
| SELECT filters by visibility | full scan only | all nine roads (Part 16) |
| DELETE governed by xmax | X | O (Part 16) |
| Cleaning dead versions | — | O (Part 17 VACUUM) |
| **Reads-don't-block-writes concurrency** | **X** | **O — sessions + lockless reads + snapshots** |
| Write-write conflict handling | — | O — first-updater-wins (table granularity) |
| Begin-time snapshot | X (read-committed-style) | O — REPEATABLE READ |

Part 13 ended with: *"some features cannot be bolted on — they must be designed for from the start."* Across five parts we rebuilt that "from the start": steal (14) → no-force (15) → xmax (16) → VACUUM (17) → and in this part, the door opened. **Walk one green-test step at a time, and even the core you thought needed a teardown can be crossed** — the lesson this series learned in its bones.

What remains is different in kind — real thread concurrency (latches, blocking locks) and a network server that speaks to `psql`. As a single-node in-process database, db-hobby closes a chapter here.

## References

- [PostgreSQL Documentation: Transaction Isolation (repeatable read, first-updater-wins)](https://www.postgresql.org/docs/current/transaction-iso.html)
- [The Internals of PostgreSQL: Concurrency Control — snapshots (xmin/xmax/xip)](https://www.interdb.jp/pg/pgsql05.html)
- This series: [Part 11 2PL](/blog/project/db-hobby/db-hobby-11-isolation) · [Part 12 2PL vs MVCC](/blog/project/db-hobby/db-hobby-12-2pl-vs-mvcc) · [Part 13 MVCC](/blog/project/db-hobby/db-hobby-13-mvcc) · [Part 16 DELETE=xmax](/blog/project/db-hobby/db-hobby-16-delete-xmax) · [Part 17 VACUUM](/blog/project/db-hobby/db-hobby-17-vacuum)

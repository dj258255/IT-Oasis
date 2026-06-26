---
title: 'MVCC는 어떻게 구현되는가 — minidb에 직접 심어보며'
titleEn: 'How Is MVCC Implemented? — Grafting It onto minidb'
description: "PostgreSQL식 힙 엔진 minidb에 MVCC(다중 버전 동시성 제어)를 실제 코드로 심어봅니다. 가시성 규칙(xmin/xmax + 트랜잭션 상태)이 왜 MVCC의 핵심 한 줄인지, 롤백이 왜 O(1)로 공짜가 되는지, 읽기 경로가 어떻게 버전을 거르는지를 minidb 코드로 보고, PostgreSQL·InnoDB와 표로 비교합니다. 그리고 진짜 동시 MVCC가 no-steal/단일 트랜잭션 코어와 충돌해 멈춘 지점 — '어떤 기능은 끼워넣는 게 아니라 처음부터 그걸 위해 설계해야 한다'는 교훈까지."
descriptionEn: "We graft MVCC (multi-version concurrency control) onto minidb, a PostgreSQL-style heap engine, with real code. Why the visibility rule (xmin/xmax + transaction status) is the one-line core of MVCC, why rollback becomes O(1) and free, and how the read path filters versions — shown in minidb code and compared with PostgreSQL and InnoDB in tables. Then the wall: where true concurrent MVCC collides with minidb's no-steal, single-transaction core — and the lesson that some features cannot be bolted on, they must be designed for from the start."
date: 2026-06-20
tags:
  - C
  - Database Internals
  - MVCC
  - Transaction
  - PostgreSQL
  - InnoDB
  - Learning
category: project/minidb
coverImage: /uploads/project/minidb/cover.svg
draft: false
series: "minidb"
seriesOrder: 13
---

## 0. 들어가며

[11편](/blog/project/minidb/minidb-11-isolation)에서 잠금(2PL)으로 격리를 만들었고, [12편](/blog/project/minidb/minidb-12-2pl-vs-mvcc)에서 잠금과 MVCC가 정반대 철학임을 개념으로 비교했어요. 이번 편은 그 MVCC를 **minidb에 실제 코드로 심으며** 봅니다 — MVCC가 코드로는 무엇인지, 어디까지 끼워 넣을 수 있고, 어디서 엔진 코어를 갈아엎어야 하는지.

minidb는 [1편](/blog/project/minidb/minidb-1-storage)부터 PostgreSQL식 힙 엔진이라(데이터를 힙에 두고 인덱스가 RID로 가리킴), MVCC를 얹기에 유리한 토대예요. 이론적 배경 — PostgreSQL의 append-only MVCC vs InnoDB의 undo log — 은 [트랜잭션 ACID ①: Atomicity](/blog/theory/transaction-acid-01-atomicity)에 정리돼 있으니, 여기서는 그 이론이 **코드로 어떻게 떨어지는지**에 집중합니다.

## 1. MVCC의 핵심은 한 줄이다 — 가시성 규칙

MVCC는 "행을 덮어쓰지 않고 버전을 쌓는다"가 전부처럼 보이지만, 정작 그걸 작동시키는 두뇌는 **가시성 규칙(visibility rule)** 한 줄이에요. 각 행 버전은 두 개의 트랜잭션 ID를 답니다.

- `xmin` — 이 버전을 만든(INSERT한) 트랜잭션
- `xmax` — 이 버전을 지운(DELETE한) 트랜잭션 (0이면 아직 안 지워짐)

> **가시성 규칙**: 어떤 행 버전은, `xmin`이 커밋됐고 AND (`xmax`가 0이거나 아직 커밋 안 됨)일 때만 보인다.

minidb에서 이걸 그대로 옮긴 게 `mvcc_visible`입니다.

```c
int mvcc_visible(const TxnLog *log, int xmin, int xmax) {
    /* 생성자가 커밋 안 했으면(진행 중이거나 abort) 이 버전은 없는 것이다. */
    if (txnlog_status(log, xmin) != TXN_COMMITTED) return 0;
    /* 커밋된 트랜잭션이 지웠으면 안 보인다. (xmax==0 = 안 지움) */
    if (xmax != 0 && txnlog_status(log, xmax) == TXN_COMMITTED) return 0;
    return 1;
}
```

`TxnLog`는 트랜잭션 id마다 상태(진행 중 / 커밋 / 아보트)를 담은 배열일 뿐이에요. PostgreSQL의 **CLOG**(`pg_xact`)에 대응합니다. 잠금 방식([11편](/blog/project/minidb/minidb-11-isolation))이 "충돌하면 막아서" 격리했다면, MVCC는 이 규칙으로 "버전을 갈라서" 격리해요.

| | 2PL (잠금) | MVCC (버전) |
|---|---|---|
| 충돌 처리 | 미리 막는다 (비관적) | 버전을 갈라 피한다 |
| 읽기/쓰기 | 서로 막는다 | **읽기가 쓰기를 안 막는다** |
| 핵심 자료구조 | 락 테이블 | xmin/xmax + 트랜잭션 상태 |
| 대가 | 동시성 저하, 교착 | 죽은 버전 누적, VACUUM |

## 2. 행은 버전을 단다 — xmin/xmax 헤더

규칙을 실제 저장에 박으려면, 모든 행이 `xmin`/`xmax`를 들고 있어야 해요. minidb의 [튜플 코덱](/blog/project/minidb/minidb-2-sql-engine)에 8바이트 헤더를 앞에 붙였습니다 — PostgreSQL 튜플 헤더가 `xmin`/`xmax`를 두는 것과 같은 발상이에요.

```c
/* 행 맨 앞 MVCC 헤더: int32 xmin + int32 xmax, 그 뒤에 null 비트맵, 그 뒤에 값들 */
#define MVCC_HDR 8

static int encode_row(const CreateStmt *schema, const Value *vals, int nvals,
                      int32_t xmin, int32_t xmax, uint8_t *buf, uint16_t *out_len) {
    memcpy(buf, &xmin, 4);      /* 만든 트랜잭션 */
    memcpy(buf + 4, &xmax, 4);  /* 지운 트랜잭션(0=아직) */
    /* ... null 비트맵, 값들 ... */
}
```

`INSERT`는 `xmin = 현재 트랜잭션`을 박고, `decode_row`는 헤더를 건너뛰어 값만 읽습니다 — 그래서 `SELECT` 출력은 그대로고, 헤더 추가 전의 테스트 316개가 한 줄도 안 깨졌어요(메타데이터일 뿐이니까). **이전 버전을 어디에 두느냐**가 PostgreSQL과 InnoDB를 가르는 핵심인데([ACID ①](/blog/theory/transaction-acid-01-atomicity)), minidb는 PostgreSQL을 따라 **같은 힙 안에** 둡니다.

| | minidb | PostgreSQL | InnoDB |
|---|---|---|---|
| 옛 버전 위치 | 같은 힙 (행 헤더 xmin/xmax) | 같은 힙 (튜플 헤더) | 별도 Undo Log |
| UPDATE | 옛 버전 + 새 버전(새 RID) | 새 튜플 append | in-place + before-image를 undo에 |
| 트랜잭션 상태 | `TxnLog` | CLOG(`pg_xact`) | rollback segment 포인터 |

## 3. 롤백이 공짜로 나온다

여기서 MVCC의 우아함이 드러나요. 행이 `xmin`/`xmax`를 들고, 가시성이 트랜잭션 **상태**로 판정되니, **롤백이 "상태만 바꾸면" 끝**입니다.

- `INSERT`한 트랜잭션을 abort -> 그 행의 `xmin`이 아보트 상태 -> 가시성 규칙이 자동으로 안 보이게 함
- `DELETE`한 트랜잭션을 abort -> 그 행의 `xmax`가 아보트 상태 -> **행이 다시 보임**
- `UPDATE`(옛 버전에 xmax + 새 버전 xmin)도 abort 한 번에 옛 버전 복귀·새 버전 소멸

그림으로 보면 한눈에 들어와요 — `UPDATE`는 옛 버전에 xmax를 찍고 새 버전을 만들 뿐이고, 보이고/안 보이고는 **트랜잭션 상태**가 정합니다.

![MVCC 버전 가시성 — UPDATE는 옛 버전에 xmax를 찍고 새 버전을 만들며, 트랜잭션 10의 COMMIT/ABORT가 옛·새 버전의 보임/안 보임을 정한다](/uploads/project/minidb/mvcc-version-visibility.svg)

`truncate`도 `discard`도 없어요. minidb의 `test_mvcc`가 이걸 그대로 검증합니다 — `txnlog_abort` 한 번에 그 트랜잭션이 만든 행이 안 보이고, 지운 행이 다시 보입니다. 이게 PostgreSQL 코어 개발자 Tom Lane이 말한 "commit과 abort는 둘 다 O(1)"의 정체예요([ACID ①](/blog/theory/transaction-acid-01-atomicity) 인용).

> **실무/면접 포인트**: PostgreSQL의 롤백이 O(1)인 건 "되돌릴 게 없어서"가 아니라 **"되돌리지 않고 안 보이게만 하기 때문"** 입니다. 미커밋 행은 디스크에 그대로 남고(공간 차지), 나중에 VACUUM이 청소해요. 반대로 InnoDB는 Undo Log를 역재생하니 롤백이 O(N)입니다. "이전 버전을 저장하는 위치가 달라서 롤백 비용 구조가 다르다"가 정확한 설명이에요.

## 4. 읽기 경로가 버전을 거른다

MVCC에서 `SELECT`는 더 이상 "행을 읽는 함수"가 아니에요 — 한 행의 여러 후보 버전 가운데 **"내 스냅샷에서 보여야 하는 버전"을 고르는 함수**가 됩니다. 가시성 규칙이 MVCC의 두뇌라면, 그 두뇌가 실제로 작동하는 곳이 바로 이 읽기 경로예요. 규칙과 헤더가 있으면, 이제 `SELECT`가 **보이는 버전만** 내보내야 해요. minidb의 단일 테이블 풀스캔 경로(`select_visit`)에 게이트를 달았습니다.

```c
static int select_visit(RID rid, const void *rec, uint16_t len, void *ctx_) {
    SelectCtx *ctx = ctx_;
    if (!row_visible(ctx->db, db_rec_xmin(rec), db_rec_xmax(rec), ctx->my_txn)) {
        return 0; /* 내 스냅샷에 안 보이는 버전은 건너뜀 */
    }
    /* ... WHERE 평가, 출력 ... */
}
```

`row_visible`은 `mvcc_visible`에 두 가지를 더했어요 — **자기 트랜잭션의 미커밋 쓰기도 봐야 하고**(`xmin == my_txn`), **재오픈 시 옛 행을 커밋으로 봐야** 합니다. 후자가 까다로운데, minidb의 트릭은 이래요.

> **재오픈 문제**: 다시 열면 트랜잭션 상태(`TxnLog`)가 초기화되니, 옛 행의 `xmin`이 전부 "진행 중"으로 보여 SELECT가 빈 결과를 낼 위험이 있어요. 해결: `next_txn`(트랜잭션 번호 발급기)을 카탈로그에 저장하고, 재오픈 때 `committed_below = 저장값`으로 둬 **그 미만 id는 전부 커밋**으로 칩니다. minidb는 no-steal이라 **디스크엔 커밋된 행만** 존재하니, 이 가정이 안전해요. PostgreSQL의 frozen xid + CLOG의 축소판입니다.

```c
static int txn_committed_view(Database *db, int txn) {
    if (txn < db->committed_below) return 1;          /* 이전 세션 = 전부 커밋 */
    return txnlog_status(&db->txnlog, txn) == TXN_COMMITTED;
}
```

닫고 다시 열어도 옛 행이 정상으로 보이는 걸 `test_mvcc_store`로 증명했고, 경합이 없는 현재 동작에선 결과가 똑같아 무회귀로 들어갔습니다.

## 5. 그리고 벽을 만났다 — no-steal vs steal

여기까지가 **안전하게 심을 수 있는 MVCC**였어요. 그 너머에서 벽을 만났습니다. 진짜 MVCC의 자랑 — "reader가 writer를 안 막는다" — 를 **눈에 보이게** 하려면, 두 트랜잭션이 동시에 떠서 한쪽이 미커밋 새 버전을 쓰는 동안 다른 쪽이 옛 버전을 읽어야 해요. 그런데 그러려면 **미커밋 버전이 디스크(또는 공유 버퍼)에 있어야** 합니다.

[ACID ①](/blog/theory/transaction-acid-01-atomicity)의 STEAL/NO-FORCE 표를 다시 보면 이게 왜 벽인지 보여요.

| 버퍼 정책 | 미커밋 dirty page를 디스크에? | 롤백 방식 |
|---|---|---|
| **STEAL** (PostgreSQL·InnoDB) | 쓸 수 있음 | undo / 가시성 규칙 필요 |
| **NO-STEAL** (minidb) | 못 씀 (커밋까지 메모리에 묶음) | 그냥 버리면 됨 (truncate) |

minidb는 [4편](/blog/project/minidb/minidb-4-transactions)에서 단순함을 위해 **no-steal + WAL truncate-롤백**을 골랐어요. 그래서 미커밋 행은 애초에 디스크에 안 가고, 롤백은 truncate로 처리합니다. 이건 MVCC가 전제하는 "미커밋 버전을 쓰고, 롤백은 abort 표시로"와 **정면충돌**해요. 게다가 실행기가 트랜잭션을 한 번에 하나만 열어서([11편](/blog/project/minidb/minidb-11-isolation)), 진짜 동시 트랜잭션 자체가 없습니다.

> **주의**: 그래서 지금 minidb의 MVCC는 "**버전을 쌓고 가시성으로 거르는 토대**"까지입니다. reader가 writer를 안 막는 진짜 동시 스냅샷 격리는 아니에요. 거기로 가려면 no-steal -> steal, truncate-롤백 -> abort-롤백, 단일 트랜잭션 -> 다중 트랜잭션 핸들로 **엔진 코어를 갈아엎어야** 합니다(ARIES나 PostgreSQL의 진짜 MVCC 스토리지를 다시 쓰는 일).

## 6. 교훈 — 끼워넣기 vs 설계하기

이 벽이 사실 가장 큰 교훈이에요. MVCC는 **가시성 규칙이 어려운 게 아닙니다**(그건 한 줄이었죠). 어려운 건, 그 규칙을 받쳐줄 **스토리지·트랜잭션 모델 전체가 처음부터 MVCC를 전제로 설계돼야** 한다는 점이에요.

PostgreSQL이 힙(append-only)·dead tuple·VACUUM·CLOG·hint bit를 가진 건 전부 MVCC를 위해서입니다. minidb는 **저장은 이미 PostgreSQL식**이라 절반(버전 헤더·가시성·롤백 개념)은 거의 공짜로 들어왔어요. 하지만 **트랜잭션/WAL 코어는 단순한 no-steal**이라, 진짜 동시 MVCC에서 갈렸습니다.

> **한 줄 교훈**: 어떤 기능은 위에 끼워넣을 수 있고, 어떤 기능은 토대가 그걸 위해 설계돼 있어야 합니다. MVCC는 후자예요. minidb의 저장이 PG식이라 절반이 공짜였다는 사실 자체가, "토대 설계가 곧 기능 가능성"임을 보여줍니다.

## 7. 정리

| 항목 | minidb | 왜 (가능 / 한계) |
|---|---|---|
| 가시성 규칙(xmin/xmax + 상태) | O | `mvcc_visible` — MVCC의 두뇌 |
| 행 버전 헤더 | O | PG 튜플 헤더식, 힙 안에 |
| abort 표시만으로 롤백(개념) | O | `txnlog_abort`로 INSERT/DELETE/UPDATE 롤백 |
| SELECT가 가시성으로 거름 | O | `select_visit` + 영속화(`committed_below`) |
| DELETE를 xmax가 주도 | X | 지금은 tombstone(코어 모델 충돌) |
| reader가 writer를 안 막는 동시성 | X | steal + 다중 트랜잭션 필요 = 코어 재작성 |

minidb의 격리는 이제 두 갈래로 손에 잡혀요 — 잠금(2PL)으로 "막아서"([11편](/blog/project/minidb/minidb-11-isolation)), 버전(MVCC)으로 "거르는" 토대까지(이번 편). 진짜 동시 MVCC는 코어를 갈아엎는 프론티어로 남겨 뒀습니다. 만들다 만 게 아니라, **여기까지가 기존 엔진에 안전하게 심을 수 있는 MVCC**이고 그 너머는 다른 엔진이라는 걸, 코드로 부딪히며 배웠어요.

## 참고

- [PostgreSQL Documentation: Concurrency Control — MVCC Introduction](https://www.postgresql.org/docs/current/mvcc-intro.html)
- [PostgreSQL Documentation: Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
- [The Internals of PostgreSQL: Concurrency Control (xmin/xmax, clog, visibility)](https://www.interdb.jp/pg/pgsql05.html)
- [PostgreSQL Mailing List: commit/abort are both O(1) (Tom Lane)](https://www.postgresql.org/message-id/603c8f070908180931s5b6f3a59l4f64488e6e2476a8%40mail.gmail.com)
- 본 시리즈: [트랜잭션 ACID ①: Atomicity](/blog/theory/transaction-acid-01-atomicity) · [② Isolation](/blog/theory/transaction-acid-02-isolation) · [④ Durability](/blog/theory/transaction-acid-04-durability)
- ARIES: A Transaction Recovery Method (Mohan et al., 1992)

<!-- EN -->

## 0. Introduction

In [Part 11](/blog/project/minidb/minidb-11-isolation) we built isolation with 2PL locks, and in [Part 12](/blog/project/minidb/minidb-12-2pl-vs-mvcc) we compared locking and MVCC as opposite philosophies at the concept level. This part grafts MVCC onto minidb **with real code** — what MVCC is as code, how far it can be bolted on, and where you must rewrite the engine core.

minidb has been a PostgreSQL-style heap engine since [Part 1](/blog/project/minidb/minidb-1-storage) (data in a heap, indexes pointing by RID), which makes it a friendly base for MVCC. The theory — PostgreSQL's append-only MVCC vs InnoDB's undo log — is in [Transaction ACID ①: Atomicity](/blog/theory/transaction-acid-01-atomicity); here we focus on how that theory **lands as code**.

## 1. The Core of MVCC Is One Line — the Visibility Rule

MVCC looks like it is all about "stack versions instead of overwriting", but the brain that makes it work is a single **visibility rule**. Each row version carries two transaction IDs:

- `xmin` — the transaction that created (INSERTed) this version
- `xmax` — the transaction that deleted this version (0 means not deleted)

> **Visibility rule**: a row version is visible only if its `xmin` committed AND (`xmax` is 0 or not yet committed).

minidb ports this directly as `mvcc_visible`.

```c
int mvcc_visible(const TxnLog *log, int xmin, int xmax) {
    if (txnlog_status(log, xmin) != TXN_COMMITTED) return 0;   /* creator not committed */
    if (xmax != 0 && txnlog_status(log, xmax) == TXN_COMMITTED) return 0; /* committed delete */
    return 1;
}
```

`TxnLog` is just an array of per-transaction status (in-progress / committed / aborted) — the counterpart of PostgreSQL's **CLOG** (`pg_xact`). Where locking ([Part 11](/blog/project/minidb/minidb-11-isolation)) isolates by "blocking on conflict", MVCC isolates by "splitting versions" with this rule.

| | 2PL (locks) | MVCC (versions) |
|---|---|---|
| Conflicts | prevented up front (pessimistic) | avoided by splitting versions |
| Read/write | block each other | **reads do not block writes** |
| Key structure | lock table | xmin/xmax + transaction status |
| Cost | low concurrency, deadlocks | dead-version buildup, VACUUM |

## 2. Rows Carry Versions — the xmin/xmax Header

To put the rule into real storage, every row must carry `xmin`/`xmax`. minidb's [tuple codec](/blog/project/minidb/minidb-2-sql-engine) gained an 8-byte header at the front — the same idea as PostgreSQL's tuple header holding `xmin`/`xmax`.

```c
#define MVCC_HDR 8  /* int32 xmin + int32 xmax, then null bitmap, then values */

static int encode_row(const CreateStmt *schema, const Value *vals, int nvals,
                      int32_t xmin, int32_t xmax, uint8_t *buf, uint16_t *out_len) {
    memcpy(buf, &xmin, 4);      /* creator */
    memcpy(buf + 4, &xmax, 4);  /* deleter (0 = none) */
    /* ... null bitmap, values ... */
}
```

`INSERT` stamps `xmin = current transaction`, and `decode_row` skips the header to read values — so `SELECT` output is unchanged, and the 316 tests from before the header did not break a single line (it is just metadata). **Where the previous version lives** is the crux that separates PostgreSQL and InnoDB ([ACID ①](/blog/theory/transaction-acid-01-atomicity)); minidb follows PostgreSQL and keeps it **in the same heap**.

| | minidb | PostgreSQL | InnoDB |
|---|---|---|---|
| Old version location | same heap (row header xmin/xmax) | same heap (tuple header) | separate Undo Log |
| UPDATE | old version + new version (new RID) | append new tuple | in-place + before-image to undo |
| Transaction status | `TxnLog` | CLOG (`pg_xact`) | rollback segment pointer |

## 3. Rollback Comes for Free

Here MVCC's elegance shows. Because rows carry `xmin`/`xmax` and visibility is decided by transaction **status**, **rollback is just "change the status"**.

- Abort the transaction that `INSERT`ed -> that row's `xmin` is aborted -> the visibility rule hides it automatically
- Abort the transaction that `DELETE`d -> that row's `xmax` is aborted -> **the row is visible again**
- `UPDATE` (old version's xmax + new version's xmin) is undone by one abort: old version returns, new version vanishes

A diagram makes it click — `UPDATE` just stamps xmax on the old version and writes a new one; what is visible is decided by **transaction status**.

![MVCC version visibility — UPDATE stamps xmax on the old version and adds a new one; transaction 10's COMMIT/ABORT decides which of the old/new versions is visible](/uploads/project/minidb/mvcc-version-visibility.svg)

No `truncate`, no `discard`. minidb's `test_mvcc` verifies exactly this — one `txnlog_abort` hides rows the transaction created and brings back rows it deleted. This is what Tom Lane meant by "commit and abort are both O(1)" (quoted in [ACID ①](/blog/theory/transaction-acid-01-atomicity)).

> **Practical/interview note**: PostgreSQL's rollback is O(1) not because "there is nothing to undo" but because **it does not undo — it just makes things invisible**. Uncommitted rows stay on disk (taking space) and VACUUM cleans them later. InnoDB, by contrast, replays the Undo Log, so its rollback is O(N). The precise framing is "the place where the previous version is stored differs, so the rollback cost structure differs."

## 4. The Read Path Filters Versions

Under MVCC, `SELECT` is no longer a "function that reads a row" — it becomes a **function that picks, among a row's candidate versions, the one that should be visible to my snapshot**. If the visibility rule is MVCC's brain, the read path is where that brain actually runs. With the rule and the header in place, `SELECT` must emit **only visible versions**. minidb's single-table full-scan path (`select_visit`) gained a gate.

```c
static int select_visit(RID rid, const void *rec, uint16_t len, void *ctx_) {
    SelectCtx *ctx = ctx_;
    if (!row_visible(ctx->db, db_rec_xmin(rec), db_rec_xmax(rec), ctx->my_txn)) {
        return 0; /* skip versions not visible to my snapshot */
    }
    /* ... evaluate WHERE, output ... */
}
```

`row_visible` adds two things to `mvcc_visible`: a transaction must **see its own uncommitted writes** (`xmin == my_txn`), and on reopen **old rows must count as committed**. The latter is tricky, and minidb's trick is this:

> **The reopen problem**: on reopen the transaction status (`TxnLog`) resets, so old rows' `xmin` all look "in-progress" and SELECT could return empty. Fix: persist `next_txn` (the transaction counter) in the catalog, and on reopen set `committed_below = saved value`, treating **every id below it as committed**. Because minidb is no-steal, **only committed rows exist on disk**, so this assumption is safe. It is a miniature of PostgreSQL's frozen xid + CLOG.

```c
static int txn_committed_view(Database *db, int txn) {
    if (txn < db->committed_below) return 1;          /* prior session = all committed */
    return txnlog_status(&db->txnlog, txn) == TXN_COMMITTED;
}
```

`test_mvcc_store` proves old rows are still visible after close-and-reopen, and since there is no contention in current behavior the result is identical — it went in with no regression.

## 5. Then I Hit a Wall — no-steal vs steal

That was the MVCC you can **safely bolt on**. Beyond it is a wall. To make MVCC's signature — "reads do not block writes" — **observable**, two transactions must be live at once: one writing an uncommitted new version while the other reads the old one. But for that, **uncommitted versions must live on disk (or a shared buffer)**.

The STEAL/NO-FORCE table from [ACID ①](/blog/theory/transaction-acid-01-atomicity) shows why this is a wall.

| Buffer policy | Uncommitted dirty page to disk? | Rollback |
|---|---|---|
| **STEAL** (PostgreSQL, InnoDB) | allowed | needs undo / visibility rules |
| **NO-STEAL** (minidb) | not allowed (pinned until commit) | just discard (truncate) |

minidb chose **no-steal + WAL truncate-rollback** for simplicity in [Part 4](/blog/project/minidb/minidb-4-transactions). So uncommitted rows never reach disk, and rollback is a truncate. This **collides head-on** with what MVCC assumes — "write uncommitted versions, roll back by marking aborted". On top of that, the executor opens only one transaction at a time ([Part 11](/blog/project/minidb/minidb-11-isolation)), so there are no truly concurrent transactions to begin with.

> **Caveat**: so minidb's MVCC today is the **"stack versions and filter by visibility" foundation**. It is not true concurrent snapshot isolation where reads do not block writes. Getting there means rewriting the engine core: no-steal -> steal, truncate-rollback -> abort-rollback, single transaction -> multiple transaction handles (rewriting ARIES or PostgreSQL's real MVCC storage).

## 6. The Lesson — Bolt-on vs Designed-for

That wall is the biggest lesson. MVCC is **not hard because of the visibility rule** (that was one line). It is hard because the **entire storage and transaction model has to be designed for MVCC from the start**.

PostgreSQL has its heap (append-only), dead tuples, VACUUM, CLOG, and hint bits all because of MVCC. minidb's **storage was already PostgreSQL-style**, so half of it (version header, visibility, the rollback idea) came almost for free. But its **transaction/WAL core is plain no-steal**, and that is where true concurrent MVCC diverged.

> **One-line lesson**: some features you can bolt on top, and some require the foundation to have been designed for them. MVCC is the latter. The very fact that half of it was free because minidb's storage is PG-style shows that "foundation design is feature possibility."

## 7. Wrap-up

| Item | minidb | Why (possible / limit) |
|---|---|---|
| Visibility rule (xmin/xmax + status) | O | `mvcc_visible` — MVCC's brain |
| Row version header | O | PG-tuple-header style, in the heap |
| Rollback by abort-marking (concept) | O | `txnlog_abort` undoes INSERT/DELETE/UPDATE |
| SELECT filters by visibility | O | `select_visit` + persistence (`committed_below`) |
| DELETE governed by xmax | X | still a tombstone (collides with core model) |
| Reads-don't-block-writes concurrency | X | needs steal + multiple transactions = core rewrite |

minidb's isolation is now graspable along two lines — locking (2PL) that "blocks" ([Part 11](/blog/project/minidb/minidb-11-isolation)), and versioning (MVCC) that "filters", up to its foundation (this part). True concurrent MVCC is left as a core-rewriting frontier. This was not abandonment — I learned, by hitting it in code, that **this is as far as MVCC bolts safely onto an existing engine, and beyond it is a different engine.**

## References

- [PostgreSQL Documentation: Concurrency Control — MVCC Introduction](https://www.postgresql.org/docs/current/mvcc-intro.html)
- [PostgreSQL Documentation: Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
- [The Internals of PostgreSQL: Concurrency Control (xmin/xmax, clog, visibility)](https://www.interdb.jp/pg/pgsql05.html)
- [PostgreSQL Mailing List: commit/abort are both O(1) (Tom Lane)](https://www.postgresql.org/message-id/603c8f070908180931s5b6f3a59l4f64488e6e2476a8%40mail.gmail.com)
- This series: [Transaction ACID ①: Atomicity](/blog/theory/transaction-acid-01-atomicity) · [② Isolation](/blog/theory/transaction-acid-02-isolation) · [④ Durability](/blog/theory/transaction-acid-04-durability)
- ARIES: A Transaction Recovery Method (Mohan et al., 1992)

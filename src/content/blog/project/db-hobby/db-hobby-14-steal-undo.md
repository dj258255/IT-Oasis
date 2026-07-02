---
title: '버퍼 풀보다 큰 트랜잭션은 왜 못 도는가 — no-steal의 벽을 steal + undo로 넘기'
titleEn: 'Why a Transaction Bigger Than the Buffer Pool Fails — Breaking the No-Steal Wall with Steal + Undo'
description: "db-hobby는 트랜잭션이 버퍼 풀(64페이지)보다 커지면 커밋은커녕 INSERT 도중 죽는다. 범인은 redo-only 복구를 단순하게 지키려고 걸어둔 no-steal이다 — dirty 페이지를 커밋 전에 디스크로 못 내리니 전부 메모리에 쌓여 자리가 바닥난다. 이 벽을 ARIES의 steal로 넘는데, steal을 켜는 순간 '디스크에 미커밋 변경이 새는' 새 문제가 생기고 그래서 UNDO(before-image) 로깅이 필연이 된다. WAL 규칙·first-write-wins·redo+undo 2-패스 복구를 db-hobby 코드에 심어, 커밋 전 크래시에도 데이터가 정확히 커밋 지점까지 복구되는 것을 test_recovery로 증명한다. db-hobby의 페이지 물리 로깅·FORCE 유지가 진짜 ARIES와 어떻게 다른지도 정직하게 짚는다."
descriptionEn: "In db-hobby, a transaction larger than the buffer pool (64 pages) doesn't just fail to commit — it dies mid-INSERT. The culprit is no-steal, the policy kept to make redo-only recovery simple: dirty pages can't be flushed before commit, so they pile up in memory until there's no frame left. We break the wall with ARIES steal — but the moment steal is on, uncommitted changes can reach disk, which makes UNDO (before-image) logging unavoidable. We graft the WAL rule, first-write-wins, and a two-pass redo+undo recovery into db-hobby code, and prove with test_recovery that even a crash before commit recovers exactly to the commit point. We're also honest about how db-hobby's full-page physical logging and kept-FORCE differ from real ARIES."
date: 2026-07-02
tags:
  - C
  - Database Internals
  - Recovery
  - WAL
  - ARIES
  - Transaction
  - PostgreSQL
  - Learning
category: study/db-hobby
coverImage: /uploads/project/db-hobby/cover.svg
draft: false
series: "db-hobby"
seriesOrder: 14
---

## 0. 들어가며

[13편](/blog/project/db-hobby/db-hobby-13-mvcc) 끝에서 벽을 하나 만났어요. 진짜 동시 MVCC로 가려면 **no-steal을 steal로** 바꿔야 하는데, 그게 엔진 코어를 갈아엎는 일이라 "프론티어"로 남겨 뒀죠. 이번 편은 그 벽의 **다른 쪽 면** — 동시성이 아니라 **복구와 트랜잭션 크기** — 을 실제로 뚫습니다. 같은 no-steal이 만든 또 하나의 한계, "**트랜잭션이 버퍼 풀보다 크면 아예 못 돈다**"를 steal + undo로 넘겨요.

배경 이론(STEAL/NO-FORCE, redo/undo)은 [트랜잭션 ACID ④: Durability](/blog/theory/transaction-acid-04-durability)와 [① Atomicity](/blog/theory/transaction-acid-01-atomicity)에 정리돼 있으니, 여기서는 그 이론이 **db-hobby 코드에서 어떻게 부서지고 다시 세워지는지**에 집중합니다.

## 1. 장애 — 큰 트랜잭션은 커밋 전에 죽는다

작은 트랜잭션은 잘 돕니다. 그런데 한 트랜잭션 안에서 수천 행을 넣으면?

```sql
CREATE TABLE t (id INT, v TEXT);
BEGIN;
INSERT INTO t VALUES (1,  '...');
INSERT INTO t VALUES (2,  '...');
-- ... 계속 ...
INSERT INTO t VALUES (105, '...');   -- 여기서 프로세스가 죽는다
```

커밋에 도달하지도 못하고, 105번째 언저리의 `INSERT`에서 세그폴트가 납니다. 원인을 좇으면 B+Tree 노드를 새로 만드는 자리예요.

```c
BTNode *r = (BTNode *)bufpool_new_page(bt->bp, &rpid);
r->is_leaf = 1;   /* <- bufpool_new_page가 NULL을 돌려줘 여기서 크래시 */
```

`bufpool_new_page`가 `NULL`을 반환했어요 — **버퍼 풀에 더 올릴 자리가 없다**는 뜻입니다. 작은 트랜잭션은 되고 큰 트랜잭션은 죽는 이 비대칭이 실마리예요.

## 2. 범인은 no-steal — 세 겹으로 묶여 있다

db-hobby는 [4편](/blog/project/db-hobby/db-hobby-4-transactions)에서 크래시 복구를 **redo-only**로 단순하게 만들려고 **no-steal**을 골랐어요. no-steal은 "커밋 안 된 dirty 페이지를 디스크로 절대 안 내보낸다"는 정책입니다. 문제는 이게 세 겹으로 묶여 트랜잭션 크기를 버퍼 풀 크기에 못 박는다는 거예요.

```c
/* db.c — 버퍼 풀을 스테이지 상한만큼만 만든다 */
t->bp = bufpool_create(&t->wal.data, WAL_MAX_STAGED); /* 64 프레임 */

/* bufpool.c — 교체 대상을 고를 때, 트랜잭션 중이면 dirty를 건너뛴다 */
if (f->dirty && !can_steal_dirty) {
    continue; /* no-steal: 커밋 안 된 페이지를 쫓아내지 않는다 */
}
```

트랜잭션이 페이지를 하나씩 더럽히면, no-steal 때문에 그 dirty 페이지들이 **전부 풀에 남습니다**(쫓아낼 수 없으니까). 64프레임이 다 dirty로 차는 순간, 다음 새 페이지 요청은 자리를 못 얻어 `NULL` — 그리고 크래시. B+Tree는 노드당 키가 8개뿐이라([3편](/blog/project/db-hobby/db-hobby-3-index-wal)) 인덱스 쪽이 먼저 64페이지에 닿았을 뿐이에요.

왜 하필 no-steal이었을까요? **redo-only 복구가 성립하려면** 그래야 했거든요.

> **핵심 인과**: no-steal이면 디스크엔 **커밋된 페이지만** 존재합니다. 그래서 크래시 복구가 "커밋 마커 있으면 재적용(redo), 없으면 버림"으로 끝나요 — 되돌릴(undo) 게 아예 없으니까. 단순함의 대가가 바로 이 크기 제한입니다.

## 3. 교과서의 축 — STEAL / FORCE

복구 정책은 두 축으로 나뉘어요. **STEAL**(커밋 전 dirty를 디스크에 써도 되나?)과 **FORCE**(커밋 시 모든 페이지를 디스크에 강제로 내리나?).

| | 커밋 전 미커밋 페이지를 디스크에? | 필요한 복구 |
|---|---|---|
| **NO-STEAL** (지금 db-hobby) | 못 씀 | redo만 (되돌릴 게 없음) |
| **STEAL** (PostgreSQL·InnoDB) | 씀 | **undo 필요** |
| **FORCE** (지금 db-hobby) | 커밋 시 전부 flush | redo 최소 |
| **NO-FORCE** (PostgreSQL·InnoDB) | 커밋 시 로그만 flush | redo 필요 |

진짜 DB는 대개 **(steal, no-force)** 예요 — 가장 유연하지만 redo·undo를 다 갖춰야 합니다. db-hobby는 지금 **(no-steal, force)**. 이번 편의 목표는 딱 한 칸, **steal로** 옮기는 겁니다(FORCE는 유지 — no-force는 다음 편). 그 한 칸이 "버퍼 풀보다 큰 트랜잭션" 벽을 없애요.

## 4. 1차 해결 — steal을 켜다

버퍼 풀이 자리가 없을 때, dirty 페이지를 **쫓아내되 디스크로 안전하게 내보내면** 됩니다. 단, 그냥 쓰면 미커밋 데이터가 디스크에 남으니, **되돌릴 정보(before-image)를 로그에 먼저** 남겨야 해요. 이게 **WAL 규칙**입니다 — 데이터를 바꾸기 전에 로그부터.

버퍼 풀에 "축출 핸들러"를 달아, no-steal 중이라도 핸들러가 있으면 dirty를 내보내게 했어요.

```c
/* bufpool.c — victim이 dirty면: 핸들러가 있으면 steal(로그+디스크), 없으면 옛 동작 */
if (victim->dirty) {
    if (bp->no_steal && bp->steal_fn) {
        if (bp->steal_fn(victim->page_id, victim->data, bp->steal_ctx) != 0)
            return NULL;                 /* 핸들러가 WAL undo 로깅 + 디스크 쓰기까지 책임 */
    } else if (pager_write(bp->pager, victim->page_id, victim->data) != 0) {
        return NULL;
    }
    victim->dirty = 0;
}
```

핸들러의 알맹이가 `wal_steal`이에요. **최초로 그 페이지를 내보낼 때만** before-image를 남기고(first-write-wins), 로그를 fsync한 뒤에야 데이터를 씁니다.

```c
int wal_steal(Wal *w, page_id_t pid, const void *buf) {
    if (!w->stole) { /* 최초 steal: 트랜잭션 시작 페이지 수를 기록(undo 시 truncate 기준) */
        write_rec(w, REC_BEGIN, w->base_pages);
        w->stole = 1;
    }
    if (!spilled_contains(w, pid)) {
        if (pid < w->base_pages) {           /* 기존 페이지 = 아직 안 건드린 디스크는 커밋본 */
            uint8_t before[PAGE_SIZE];
            pager_read(&w->data, pid, before);   /* 이게 before-image */
            write_rec(w, REC_UNDO, pid, before);
        }
        spilled_add(w, pid);                 /* 새 페이지(>= base)는 undo=truncate라 불필요 */
    }
    fsync(w->log_fd);                        /* WAL 규칙: undo가 내구된 뒤에야 */
    pager_write(&w->data, pid, buf);         /* 데이터를 바꾼다 */
    fsync(w->data.fd);                       /* stolen 페이지도 내구화(FORCE 유지) */
    return 0;
}
```

`base_pages`는 트랜잭션 시작 시점의 파일 페이지 수예요. **최초 steal에서 디스크를 읽으면 그게 곧 커밋본**입니다 — 아직 이 트랜잭션이 그 페이지를 디스크에 쓴 적이 없으니까. 그래서 그 순간을 놓치지 않고 잡아 두는 게 정확성의 핵심이고, `spilled` 집합으로 "페이지당 한 번만" 남기게 강제합니다(first-write-wins).

이제 큰 트랜잭션이 **커밋됩니다.** 2000행을 한 트랜잭션에 넣고 재오픈해도 그대로 있어요. 됐다 — 그런데.

## 5. 새 장애 — steal하면 디스크에 미커밋이 샌다

steal을 켠 순간, **디스크에 커밋 안 된 변경이 존재**하게 됐어요. 트랜잭션 도중 크래시가 나면? redo-only 복구는 이걸 못 고칩니다. "커밋 마커가 없으니 버린다"고 했지만, **버릴 대상이 이미 디스크에 적용돼 버렸거든요.** 되돌릴 원본이 없습니다.

바로 이래서 2절의 인과가 뒤집혀요. no-steal일 땐 "되돌릴 게 없어서" redo만으로 충분했는데, steal을 켜면 "되돌릴 게 생겨서" **undo가 필연**이 됩니다. 다행히 우리는 4절에서 이미 before-image를 로그에 남겨 뒀어요. 이제 복구가 그걸 쓰면 됩니다.

## 6. 2차 해결 — redo + undo 2-패스 복구

복구를 두 갈래로 나눴습니다. 로그에 **커밋 마커가 있으면** 그 after-image를 재적용(redo), **없으면** before-image로 되돌리고(undo) 트랜잭션이 새로 할당한 페이지는 잘라냅니다.

```c
/* wal.c — 커밋 여부로 갈린다 */
if (committed) {
    for (each REC_PAGE) pager_write(&w->data, pid, after);   /* redo: 커밋분 재적용 */
} else {
    for (each REC_UNDO) pager_write(&w->data, pid, before);  /* undo: 미완분 되돌림 */
    if (base < w->data.num_pages) pager_truncate(&w->data, base); /* 새 페이지 제거 */
}
```

undo 레코드는 개수 제한이 없어야 해서(큰 트랜잭션이 수백 페이지를 steal할 수 있으니) 메모리에 다 담지 않고 **로그를 두 번 훑는 스트리밍**으로 적용합니다. 롤백(`ROLLBACK`)도 정확히 같은 길을 써요 — 크래시 복구와 롤백이 한 메커니즘으로 통일됐습니다.

아래 그림이 이 흐름 전체예요 — steal이 로그에 남기는 것, 그리고 커밋 마커 유무가 redo와 undo를 어떻게 가르는지.

![steal + undo 복구 — 트랜잭션 중 steal은 REC_BEGIN(base)와 REC_UNDO(before-image)를 로그에 남기고, 크래시 시 커밋 마커가 있으면 after-image를 redo, 없으면 before-image로 undo + 새 페이지 truncate](/uploads/project/db-hobby/aries-steal-recovery.svg)

`test_recovery`가 세 가지를 증명합니다 — ① 2000행(버퍼 풀 초과) 트랜잭션이 커밋되고 재오픈 후에도 유지(내구성), ② 커밋된 50행을 두고 큰 트랜잭션을 롤백하면 **before-image가 원복돼 정확히 50행만** 남음(원자성), ③ steal 후 **커밋 전 크래시** → 재오픈 시 undo로 50행만(크래시 원자성). 이걸로 "죽여도 안 깨진다"가 손에 잡혀요.

> **실무/면접 포인트**: "버퍼 풀보다 큰 트랜잭션이 왜 도는가?"의 답이 곧 STEAL입니다. 그리고 STEAL은 공짜가 아니라 **UNDO를 데리고 옵니다** — 미커밋 페이지가 디스크에 새기 때문에. 반대로 NO-FORCE는 REDO를 데려와요. "어느 버퍼 정책을 고르느냐가 어떤 복구 로직이 필수인지를 결정한다"가 핵심 프레임입니다.

## 7. db-hobby ≠ 진짜 ARIES — 정직한 경계

여기서 분명히 해 둘게요. 위 구현은 **ARIES의 발상**을 db-hobby 규모로 옮긴 것이지, 교과서 ARIES 그대로가 아닙니다.

| | db-hobby (이번 편) | 진짜 ARIES (PostgreSQL·InnoDB 계열) |
|---|---|---|
| 로깅 단위 | 페이지 **전체**(물리) | **physiological**(연산+데이터, 훨씬 작음) |
| pageLSN | 없음(페이지 전체라 redo가 idempotent) | 페이지마다 LSN으로 재적용 판정 |
| 커밋 정책 | **FORCE 유지** | NO-FORCE(커밋 시 로그만 force) |
| 복구 패스 | redo/undo 2-패스(단일 트랜잭션) | Analysis → Redo → Undo 3-패스 |
| CLR(보상 로그) | 없음 | undo도 로깅해 재크래시에 안전 |

db-hobby가 **페이지 전체를 물리 로깅**하기 때문에 pageLSN 없이도 redo가 안전해요(전체 페이지를 덮어쓰는 건 몇 번을 해도 같으니까). 진짜 DB는 로그를 작게 하려고 physiological 로깅을 쓰고, 그래서 pageLSN·CLR 같은 장치가 필요해집니다. 이 차이를 "구현마다 다른 선택"으로 보는 게 정확하지, "DB는 원래 이렇다"로 뭉뚱그리면 틀려요.

## 8. 정리 — 그리고 다음 편

| 항목 | db-hobby | 왜 (가능 / 한계) |
|---|---|---|
| 버퍼 풀보다 큰 트랜잭션 | O | steal로 dirty를 디스크에 방출 |
| WAL 규칙(로그 먼저 fsync) | O | `wal_steal`에서 before-image → 데이터 순 |
| 크래시/롤백 undo | O | before-image 원복 + 새 페이지 truncate |
| redo+undo 2-패스 복구 | O | 커밋 마커로 갈림, undo는 스트리밍 |
| no-force(커밋 시 로그만) | X | 지금은 FORCE 유지 |
| pageLSN·CLR·3-패스 ARIES | X | physiological 로깅으로 가야 필요 |

13편에서 "steal이 없어 막혔다"던 그 벽을, 이번엔 **복구 관점에서 절반** 뚫었어요. no-steal → steal, redo-only → redo+undo로 옮겨 트랜잭션이 버퍼 풀 크기에서 풀려났습니다. 다음 편은 나머지 절반 — **no-force + 퍼지 체크포인트 + 3-패스 ARIES 정식화** — 이고, 그게 완성되면 13편이 남긴 **진짜 동시 MVCC 재작성**(steal + abort-롤백이 전제)과 자연히 만나게 됩니다.

## 참고

- [ARIES: A Transaction Recovery Method Supporting Fine-Granularity Locking and Partial Rollbacks Using Write-Ahead Logging (Mohan et al., 1992)](https://cs.stanford.edu/people/chrismre/cs345/rl/aries.pdf)
- [PostgreSQL Documentation: Reliability and the Write-Ahead Log](https://www.postgresql.org/docs/current/wal-intro.html)
- [The Internals of PostgreSQL: Write Ahead Logging](https://www.interdb.jp/pg/pgsql09.html)
- 본 시리즈: [트랜잭션 ACID ①: Atomicity](/blog/theory/transaction-acid-01-atomicity) · [④ Durability](/blog/theory/transaction-acid-04-durability)
- db-hobby: [4편 트랜잭션·WAL](/blog/project/db-hobby/db-hobby-4-transactions) · [13편 MVCC](/blog/project/db-hobby/db-hobby-13-mvcc)

<!-- EN -->

## 0. Introduction

At the end of [Part 13](/blog/project/db-hobby/db-hobby-13-mvcc) we hit a wall. Reaching true concurrent MVCC means switching **no-steal to steal**, but that rewrites the engine core, so we left it as a "frontier". This part breaks through the **other face** of that wall — not concurrency, but **recovery and transaction size**. We tackle another limit the same no-steal created: "**a transaction bigger than the buffer pool can't run at all**", using steal + undo.

The background theory (STEAL/NO-FORCE, redo/undo) is in [Transaction ACID ④: Durability](/blog/theory/transaction-acid-04-durability) and [① Atomicity](/blog/theory/transaction-acid-01-atomicity); here we focus on how that theory **breaks and is rebuilt in db-hobby code**.

## 1. The Failure — A Big Transaction Dies Before Commit

Small transactions run fine. But insert thousands of rows inside one transaction?

```sql
CREATE TABLE t (id INT, v TEXT);
BEGIN;
INSERT INTO t VALUES (1,  '...');
INSERT INTO t VALUES (2,  '...');
-- ... more ...
INSERT INTO t VALUES (105, '...');   -- the process dies here
```

It never even reaches commit — it segfaults around the 105th `INSERT`. Chasing it lands on the spot that allocates a new B+Tree node.

```c
BTNode *r = (BTNode *)bufpool_new_page(bt->bp, &rpid);
r->is_leaf = 1;   /* <- bufpool_new_page returned NULL, so this crashes */
```

`bufpool_new_page` returned `NULL` — meaning **there's no room left in the buffer pool**. That asymmetry (small works, big dies) is the clue.

## 2. The Culprit Is No-Steal — Bound in Three Layers

db-hobby chose **no-steal** in [Part 4](/blog/project/db-hobby/db-hobby-4-transactions) to keep crash recovery **redo-only**. No-steal means "never flush an uncommitted dirty page to disk". The problem: it's bound in three layers that pin transaction size to buffer-pool size.

```c
/* db.c — the buffer pool is created exactly as large as the stage limit */
t->bp = bufpool_create(&t->wal.data, WAL_MAX_STAGED); /* 64 frames */

/* bufpool.c — when picking a victim, skip dirty during a transaction */
if (f->dirty && !can_steal_dirty) {
    continue; /* no-steal: don't evict an uncommitted page */
}
```

As a transaction dirties pages one by one, no-steal keeps them **all in the pool** (they can't be evicted). The moment all 64 frames are dirty, the next new-page request finds no room → `NULL` → crash. A B+Tree node holds only 8 keys ([Part 3](/blog/project/db-hobby/db-hobby-3-index-wal)), so the index pool just hit 64 pages first.

Why no-steal in the first place? Because **redo-only recovery needs it**.

> **The core cause**: with no-steal, only **committed pages** ever exist on disk. So crash recovery is just "redo if the commit marker is present, discard if not" — there's nothing to undo. The price of that simplicity is exactly this size limit.

## 3. The Textbook Axes — STEAL / FORCE

Recovery policy splits along two axes: **STEAL** (may uncommitted dirty pages go to disk?) and **FORCE** (are all pages forced to disk at commit?).

| | Uncommitted page to disk before commit? | Recovery needed |
|---|---|---|
| **NO-STEAL** (db-hobby now) | not allowed | redo only (nothing to undo) |
| **STEAL** (PostgreSQL, InnoDB) | allowed | **undo required** |
| **FORCE** (db-hobby now) | flush all at commit | minimal redo |
| **NO-FORCE** (PostgreSQL, InnoDB) | flush only the log at commit | redo required |

Real databases are usually **(steal, no-force)** — most flexible, but they must have both redo and undo. db-hobby is **(no-steal, force)**. This part's goal is exactly one cell: move **to steal** (keeping FORCE — no-force is next part). That one cell removes the "bigger than the buffer pool" wall.

## 4. First Fix — Turn On Steal

When the buffer pool is full, we can **evict a dirty page as long as we send it to disk safely**. But writing it plainly leaves uncommitted data on disk, so we must **log the undo info (before-image) first**. That's the **WAL rule** — log before you touch data.

We gave the buffer pool a "steal handler": even during no-steal, if a handler is set, dirty pages can be evicted through it.

```c
/* bufpool.c — if victim is dirty: steal via handler if present, else old behavior */
if (victim->dirty) {
    if (bp->no_steal && bp->steal_fn) {
        if (bp->steal_fn(victim->page_id, victim->data, bp->steal_ctx) != 0)
            return NULL;                 /* handler does WAL undo logging + disk write */
    } else if (pager_write(bp->pager, victim->page_id, victim->data) != 0) {
        return NULL;
    }
    victim->dirty = 0;
}
```

The handler's core is `wal_steal`. It logs a before-image **only the first time** it spills a page (first-write-wins), and fsyncs the log before touching data.

```c
int wal_steal(Wal *w, page_id_t pid, const void *buf) {
    if (!w->stole) { /* first steal: record txn-start page count (truncate base for undo) */
        write_rec(w, REC_BEGIN, w->base_pages);
        w->stole = 1;
    }
    if (!spilled_contains(w, pid)) {
        if (pid < w->base_pages) {           /* existing page = untouched disk is the committed copy */
            uint8_t before[PAGE_SIZE];
            pager_read(&w->data, pid, before);   /* this is the before-image */
            write_rec(w, REC_UNDO, pid, before);
        }
        spilled_add(w, pid);                 /* new page (>= base): undo = truncate, no image needed */
    }
    fsync(w->log_fd);                        /* WAL rule: only after the undo is durable */
    pager_write(&w->data, pid, buf);         /* change the data */
    fsync(w->data.fd);                       /* make the stolen page durable too (FORCE kept) */
    return 0;
}
```

`base_pages` is the file's page count at transaction start. **Reading disk on the first steal gives the committed copy** — this transaction hasn't written that page to disk yet. Capturing exactly that moment is the crux of correctness, and the `spilled` set enforces "once per page" (first-write-wins).

Now the big transaction **commits.** Insert 2000 rows in one transaction, reopen, and they're all there. Done — but.

## 5. A New Failure — Steal Leaks Uncommitted Data to Disk

The instant steal is on, **uncommitted changes now exist on disk**. What if a crash hits mid-transaction? Redo-only recovery can't fix it. It said "no commit marker, so discard", but **the thing to discard is already applied to disk.** There's no original to restore.

This flips the cause from Section 2. Under no-steal, redo sufficed "because there's nothing to undo"; turn on steal and "now there is something to undo", so **undo becomes unavoidable**. Fortunately we already logged before-images back in Section 4. Recovery just needs to use them.

## 6. Second Fix — Two-Pass Redo + Undo Recovery

We split recovery in two. If the log **has a commit marker**, reapply the after-images (redo); if **not**, restore before-images (undo) and truncate pages the transaction newly allocated.

```c
/* wal.c — it forks on commit-ness */
if (committed) {
    for (each REC_PAGE) pager_write(&w->data, pid, after);   /* redo: reapply committed */
} else {
    for (each REC_UNDO) pager_write(&w->data, pid, before);  /* undo: revert unfinished */
    if (base < w->data.num_pages) pager_truncate(&w->data, base); /* remove new pages */
}
```

Undo records must be unbounded (a big transaction can steal hundreds of pages), so instead of buffering them all in memory we apply them by **streaming through the log twice**. Rollback (`ROLLBACK`) takes exactly the same path — crash recovery and rollback are unified into one mechanism.

The diagram below is the whole flow — what steal writes to the log, and how the presence of a commit marker forks redo vs undo.

![Steal + undo recovery — during a transaction, steal logs REC_BEGIN(base) and REC_UNDO(before-image); on crash, redo the after-images if the commit marker is present, else undo the before-images and truncate new pages](/uploads/project/db-hobby/aries-steal-recovery.svg)

`test_recovery` proves three things — ① a 2000-row (over-the-pool) transaction commits and survives reopen (durability), ② with 50 committed rows present, rolling back a big transaction **restores before-images to leave exactly 50 rows** (atomicity), ③ steal then **crash before commit** → reopen undoes to 50 rows (crash atomicity). That makes "kill it and it doesn't break" concrete.

> **Practical/interview note**: the answer to "why can a transaction bigger than the buffer pool run?" *is* STEAL. And STEAL isn't free — it **brings UNDO along**, because uncommitted pages leak to disk. NO-FORCE, conversely, brings REDO. The key framing: "which buffer policy you pick determines which recovery logic is mandatory."

## 7. db-hobby ≠ Real ARIES — an Honest Boundary

Let's be clear: the above ports **the idea** of ARIES to db-hobby's scale, not textbook ARIES verbatim.

| | db-hobby (this part) | Real ARIES (PostgreSQL/InnoDB family) |
|---|---|---|
| Logging unit | **whole page** (physical) | **physiological** (operation + data, far smaller) |
| pageLSN | none (whole-page redo is idempotent) | per-page LSN decides reapply |
| Commit policy | **FORCE kept** | NO-FORCE (force only the log at commit) |
| Recovery passes | redo/undo two-pass (single transaction) | Analysis → Redo → Undo three-pass |
| CLR (compensation log) | none | logs undo too, safe across re-crash |

Because db-hobby does **whole-page physical logging**, redo is safe without a pageLSN (overwriting a full page is the same however many times you do it). Real databases use physiological logging to keep logs small, which then requires machinery like pageLSN and CLR. The accurate view is "different implementations, different choices", not "databases just work this way".

## 8. Wrap-up — and What's Next

| Item | db-hobby | Why (possible / limit) |
|---|---|---|
| Transaction bigger than the buffer pool | O | steal flushes dirty to disk |
| WAL rule (log fsync first) | O | `wal_steal`: before-image → then data |
| Crash/rollback undo | O | restore before-image + truncate new pages |
| Two-pass redo+undo recovery | O | forks on commit marker; undo streams |
| No-force (only log at commit) | X | still keeps FORCE |
| pageLSN, CLR, three-pass ARIES | X | needed once you go physiological |

The wall Part 13 hit ("stuck because there's no steal") is now **half broken, from the recovery side**. Moving no-steal → steal and redo-only → redo+undo freed transactions from the buffer-pool size. Next part is the other half — **no-force + fuzzy checkpoint + a proper three-pass ARIES** — and once that lands, it naturally meets the **true concurrent MVCC rewrite** Part 13 left behind (which presumes steal + abort-rollback).

## References

- [ARIES: A Transaction Recovery Method Supporting Fine-Granularity Locking and Partial Rollbacks Using Write-Ahead Logging (Mohan et al., 1992)](https://cs.stanford.edu/people/chrismre/cs345/rl/aries.pdf)
- [PostgreSQL Documentation: Reliability and the Write-Ahead Log](https://www.postgresql.org/docs/current/wal-intro.html)
- [The Internals of PostgreSQL: Write Ahead Logging](https://www.interdb.jp/pg/pgsql09.html)
- This series: [Transaction ACID ①: Atomicity](/blog/theory/transaction-acid-01-atomicity) · [④ Durability](/blog/theory/transaction-acid-04-durability)
- db-hobby: [Part 4 Transactions & WAL](/blog/project/db-hobby/db-hobby-4-transactions) · [Part 13 MVCC](/blog/project/db-hobby/db-hobby-13-mvcc)

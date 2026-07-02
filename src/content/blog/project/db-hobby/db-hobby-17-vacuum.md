---
title: '지운 것과 치운 것은 다르다 — VACUUM, 그리고 드디어 필요해진 B+Tree 삭제'
titleEn: "Deleting and Cleaning Are Different Jobs — VACUUM, and B+Tree Deletion Finally Becomes Necessary"
description: "16편이 일부러 만든 문제를 치울 차례다. DELETE가 xmax 도장이 된 뒤로 죽은 버전이 힙에 영원히 쌓인다 — DELETE를 해도 파일은 안 줄고, UPDATE 다섯 번이면 옛 버전 다섯 개가 남는다(bloat). VACUUM을 만든다: 죽은 버전(커밋된 xmax의 옛 버전)을 골라 ① 그걸 가리키던 인덱스 항목을 지우고 ② 힙 슬롯을 비워 페이지를 compaction하고(RID 불변) ③ 꼬리가 전부 빈 페이지면 파일을 자른다(PG의 조건부 truncate). 이 과정에서 시리즈가 계속 미뤄 온 B+Tree 삭제가 '드디어 필요해서' 등장하는데 — 교과서의 병합·재분배가 아니라 PostgreSQL nbtree처럼 리프 항목만 지우는 lazy 삭제다. UPDATE된 키의 PK 항목은 살아있는 새 버전을 가리키므로 건드리면 안 된다는 함정, 잘린 페이지의 dirty 프레임이 파일을 되살리는 유령 flush까지 — 청소부의 디테일을 전부 코드로 푼다."
descriptionEn: "Time to clean up the mess Part 16 made on purpose. Since DELETE became an xmax stamp, dead versions pile up in the heap forever — DELETE doesn't shrink the file, and five UPDATEs leave five old versions (bloat). We build VACUUM: find dead versions (old versions with a committed xmax), then ① remove the index entries pointing at them, ② empty their heap slots and compact each page (RIDs stay stable), ③ truncate trailing all-empty pages (PG-style conditional truncation). Along the way, the B+Tree deletion this series kept deferring finally arrives 'because it's needed' — not the textbook's merge/redistribute, but lazy leaf deletion, just like PostgreSQL's nbtree. Plus the traps: a PK entry for an UPDATEd key points at the live new version and must not be touched, and a truncated page's dirty frame can resurrect the file with a ghost flush. All the janitor's details, solved in code."
date: 2026-07-03
tags:
  - C
  - Database Internals
  - MVCC
  - VACUUM
  - B+Tree
  - PostgreSQL
  - Learning
category: study/db-hobby
coverImage: /uploads/project/db-hobby/cover.svg
draft: false
series: "db-hobby"
seriesOrder: 17
---

## 0. 들어가며

[16편](/blog/project/db-hobby/db-hobby-16-delete-xmax)은 문제를 하나 **일부러** 만들고 끝났어요. DELETE가 행을 지우는 대신 xmax 도장을 찍게 되면서(논리 삭제), 죽은 버전이 힙에 영원히 남게 됐죠. 그때 이렇게 썼습니다 — *"지우는 것과 치우는 것은 다른 작업이다. VACUUM이 다음 편의 장애 서사다."*

이번 편이 그 청소부입니다. 그리고 이 시리즈가 [3편](/blog/project/db-hobby/db-hobby-3-index-wal)부터 계속 미뤄 온 숙제 — **B+Tree 삭제** — 가 드디어 "필요해서" 등장합니다.

## 1. 장애 — DELETE를 해도 아무것도 줄지 않는다

16편 이후의 db-hobby에서 이런 일이 벌어집니다.

```sql
db-hobby> INSERT ... (10행)
db-hobby> DELETE FROM t WHERE id > 5;
5개 행 삭제됨
db-hobby> SELECT COUNT(*) FROM t;
5                     -- 보이는 건 5행인데...
```

힙을 물리적으로 세어 보면 **여전히 10행**입니다. UPDATE는 더 심해요 — 같은 행을 다섯 번 고치면 옛 버전 다섯 개가 힙에 쌓입니다. 파일은 자라기만 하고, 스캔은 죽은 버전을 읽어 게이트에서 버리느라 갈수록 느려집니다. **bloat**예요.

이건 버그가 아니라 MVCC의 설계 그 자체입니다(PostgreSQL에서 "DELETE 많이 했는데 디스크가 안 줄어요"가 정상인 것과 같은 이유). 하지만 설계라고 해서 안 치워도 되는 건 아니죠 — PostgreSQL엔 VACUUM이 있으니까요. 우리도 만듭니다.

## 2. 누가 죽었는가 — 판정은 한 줄

VACUUM의 첫 질문: **어떤 버전을 치워도 되는가?** 원칙은 "지금은 물론 앞으로도 아무 트랜잭션에게 보일 수 없는 버전"입니다. 일반적으론 실행 중인 모든 스냅샷을 고려해야 하는 까다로운 판정인데(PostgreSQL의 oldest xmin horizon), db-hobby의 단순화가 여기서 효자 노릇을 해요.

```c
/* 죽은 버전인가 — 커밋된 xmax가 찍혀 이제 아무 트랜잭션에게도 안 보일 옛 버전.
 * (단일 트랜잭션 + 물리 롤백이라 '아보트된 xmin' 행은 디스크에 없고, VACUUM은
 * 트랜잭션 밖에서만 돌므로 미커밋 xmax도 없다.) */
static int rec_dead(Database *db, const void *rec) {
    int32_t xmax = db_rec_xmax(rec);
    return xmax != 0 && txn_committed_view(db, xmax);
}
```

**dead = 커밋된 xmax.** 이 한 줄이 완전한 판정인 이유는 두 단순화 덕입니다 — 트랜잭션이 하나뿐이라 다른 스냅샷이 없고, 롤백이 물리 복원이라 아보트된 행이 디스크에 존재하지 않아요. VACUUM은 PostgreSQL처럼 **트랜잭션 안에서는 거부**합니다(`VACUUM cannot run inside a transaction block` — 우리도 같은 에러를 냅니다). 그래서 미커밋 xmax를 만날 일도 없고요.

## 3. 청소부의 세 가지 일

`VACUUM [<table>]`은 세 단계로 움직입니다. 순서가 중요해요.

```
① 죽은 버전을 가리키던 인덱스 항목을 지운다   (B+Tree lazy 삭제)
② 힙 슬롯을 비우고 페이지를 compaction한다    (RID 불변)
③ 꼬리가 전부 빈 페이지면 파일을 자른다        (조건부 truncate)
```

**② 페이지 compaction** — 슬롯을 비우는 건 `heap_delete`(tombstone)가 합니다. 재밌는 순간이에요: 16편에서 DELETE의 의미론에서 쫓겨났던 tombstone이, **VACUUM의 청소 도구로 제 역할을 찾았습니다.** 비운 뒤엔 살아있는 레코드를 페이지 끝쪽으로 다시 패킹해 공간을 회수하는데, **슬롯 번호는 그대로** 둡니다 — 슬롯 번호가 곧 RID고, 인덱스가 RID로 행을 가리키니까요. PostgreSQL이 페이지를 정리할 때 line pointer 배열을 보존하는 것과 같은 이유입니다.

**③ 조건부 truncate** — 파일 끝에서부터 거꾸로 훑으며 전부-빈 페이지만 자릅니다. **가운데의 빈 페이지는 남아요.** PostgreSQL의 VACUUM도 정확히 이래요 — 그래서 "VACUUM 했는데도 파일이 안 줄어요"가 흔한 겁니다(16편의 실무 포인트가 이제 우리 코드에서도 참).

## 4. 드디어 등장한 B+Tree 삭제 — 교과서와 다르게

죽은 버전을 힙에서 치우면, 그걸 가리키던 인덱스 항목은 허공을 가리킵니다. 지워야죠 — 그런데 이 시리즈의 README엔 3편부터 이렇게 적혀 있었어요: *"B+Tree deletion isn't implemented."* 삽입·분할만 있고 삭제가 없었습니다. 필요가 없었으니까요. **이제 필요해졌습니다.**

그런데 교과서(병합·재분배)를 그대로 이식하기 전에, 진짜 DB는 어떻게 하는지 봤어요. **PostgreSQL의 nbtree는 재분배를 안 합니다.** 리프에서 항목을 지우고, 페이지가 완전히 비면 트리에서 떼어 재활용할 뿐이에요. 노드가 반쯤 비어도 그냥 둡니다. 그래서 우리도 그 결을 따랐습니다 — **lazy 삭제**.

```c
/* (key, val) 항목 하나를 리프에서 제거한다 — lazy: 병합·재분배 없음.
 * 내부 노드의 분리키가 stale해질 수 있지만 라우팅 안내판일 뿐이라 탐색은 정확하다. */
int btree_delete_val(BTree *bt, bkey_t key, bval_t val) {
    /* 하한 탐색으로 가장 왼쪽 후보 리프로 -> 리프 체인을 훑어 (key,val) 짝을 찾아
       자리를 당겨 지운다. 리프가 비어도 체인에 남는다 — 스캔이 그냥 지나간다. */
}
```

키만이 아니라 **(키, RID) 짝**을 지우는 게 포인트예요. 보조 인덱스는 비유니크라 같은 키가 여러 RID를 가질 수 있으니, 죽은 버전의 짝만 정확히 지워야 합니다.

그리고 이번 편에서 가장 조심해야 했던 함정 — **PK 인덱스 항목은 함부로 지우면 안 됩니다.**

```c
/* PK는 '인덱스가 지금도 이 죽은 RID를 가리킬 때만' 지운다 — UPDATE/재삽입이면
 * 같은 키가 살아있는 새 버전을 가리키고 있어서 건드리면 안 된다. */
if (btree_search(&t->index, e->pk, &v) == 0 && v == rid_encode(e->rid)) {
    btree_delete_val(&t->index, e->pk, v);
}
```

`UPDATE t SET v='new' WHERE id=1`을 생각해 보세요. 옛 버전(죽음)도 PK가 1이고, 새 버전(살아있음)도 PK가 1인데, 인덱스의 `1`은 이미 **새 버전을** 가리킵니다. 죽은 버전을 치운다고 키 `1`을 지워 버리면 살아있는 행이 인덱스에서 사라져요. 그래서 "인덱스가 지금도 죽은 RID를 가리킬 때만" 지웁니다 — DELETE된 키만 여기 해당하고, UPDATE·재삽입된 키는 자연히 보존됩니다.

## 5. 유령 flush — 청소부가 밟을 뻔한 지뢰

③의 파일 truncate에는 함정이 하나 숨어 있었어요. 잘라낼 꼬리 페이지가 **버퍼 풀에 dirty 프레임으로 남아 있으면**, 커밋 때 그 프레임이 flush되면서 `pwrite`가 파일을 도로 늘려 놓습니다 — 잘랐던 페이지가 유령처럼 되살아나요. 그래서 truncate 전에 그 범위의 프레임을 무효화합니다.

```c
bufpool_invalidate_from(t->bp, new_np); /* 잘린 페이지의 프레임이 파일을 되살리지 않게 */
pager_truncate(&t->wal.data, new_np);
```

그리고 정직하게 짚을 것: **파일 truncate는 WAL에 기록되지 않습니다.** VACUUM 커밋 전에 크래시가 나면 truncate만 적용되고 슬롯 비움은 롤백될 수 있어요. 그래도 안전한 이유 — 잘린 페이지엔 **죽은 버전만** 있었고, 죽은 버전은 원래 아무에게도 안 보였으니, 사용자 가시 상태는 크래시 전후가 동일합니다. 남을 수 있는 stale 인덱스 항목은 잘린 페이지를 가리키다 `heap_get`이 실패해 걸러지고요(16편의 게이트 구조가 여기서도 방어선).

## 6. 검증 — 청소 전후

`test_vacuum`(신설 17 시나리오)의 하이라이트:

```
ok   VACUUM 전: 죽은 버전 5개가 힙에 남아 있다 (10행)
ok   VACUUM이 죽은 버전 5개를 회수
ok   VACUUM 후: 힙에 살아있는 5행만
ok   VACUUM은 멱등 — 두 번째엔 치울 게 없다
ok   UPDATE 5번 -> 옛 버전 5개 누적 (bloat)
ok   최신 버전은 PK로 정상 조회 (같은 키의 살아있는 항목은 안 지움)
ok   BEGIN 안에서 VACUUM -> 거부 (PostgreSQL과 동일)
ok   꼬리의 빈 페이지가 잘려 파일이 줄었다 (조건부 truncate)
```

가시 행 수·인덱스 조회는 청소 전후 완전히 동일하고(청소는 보이는 세계를 못 건드림), 물리 행 수와 파일 크기만 줍니다. 전체 스위트 **380개 / 23스위트 green**.

> **실무/면접 포인트**: PostgreSQL의 autovacuum이 왜 그렇게 중요한 데몬인지가 이 구조에서 나옵니다. VACUUM을 안 돌리면 ① bloat로 스캔이 느려지고 ② dead tuple 통계(`n_dead_tup`)가 쌓이며 ③ (진짜 PG에선) xid wraparound라는 재앙까지 갑니다. "DELETE는 도장, 청소는 별도 데몬"이라는 그림을 갖고 있으면 `autovacuum_vacuum_scale_factor` 같은 파라미터가 전부 "언제 청소부를 부를 것인가"의 문제로 읽혀요.

![VACUUM — 죽은 버전(커밋된 xmax)을 골라 인덱스 항목을 lazy 삭제하고, 힙 슬롯을 비워 페이지를 compaction하고(RID 불변), 꼬리의 전부-빈 페이지만 조건부 truncate한다. UPDATE된 PK 항목은 살아있는 새 버전을 가리키므로 보존](/uploads/project/db-hobby/vacuum-sweep.svg)

## 7. 정리 — 단일 트랜잭션의 미니 PostgreSQL, 완성

| 항목 | 상태 | 비고 |
|---|---|---|
| 죽은 버전 힙 회수 | O | 슬롯 비움 + compaction (RID 불변) |
| 죽은 인덱스 항목 제거 | O | **B+Tree lazy 삭제** — PG nbtree처럼 재분배 없음 |
| 살아있는 인덱스 항목 보존 | O | PK가 새 버전을 가리키면 안 건드림 |
| 파일 축소 | 부분 | 꼬리의 빈 페이지만 (PG와 같은 조건부) |
| 트랜잭션 안 VACUUM | 거부 | PostgreSQL과 동일 |
| autovacuum | X | 수동 `VACUUM`만 — 데몬은 다중 트랜잭션 이후에나 의미 |

이로써 [13편](/blog/project/db-hobby/db-hobby-13-mvcc)에서 시작한 사슬이 한 바퀴 돌았습니다 — 버전과 가시성(13) → steal과 undo(14) → no-force와 WAL(15) → DELETE의 MVCC화(16) → **그 부산물의 청소(17)**. 단일 트랜잭션 기준으로 저장·복구·격리·청소 축이 모두 선, "미니 PostgreSQL"의 한 사이클이에요.

남은 프론티어는 하나입니다 — **진짜 다중 트랜잭션**(reader가 writer를 안 막는 걸 실제로 시연하는 것, 그리고 first-updater-wins 쓰기 충돌). 13편부터 쌓아 온 전제(steal·abort-롤백·로그 중심 복구·버전·게이트·청소)가 전부 그걸 위해 준비됐습니다.

## 참고

- [PostgreSQL Documentation: Routine Vacuuming](https://www.postgresql.org/docs/current/routine-vacuuming.html)
- [PostgreSQL Documentation: B-Tree Implementation (nbtree README — 삭제·페이지 재활용)](https://www.postgresql.org/docs/current/btree-implementation.html)
- [The Internals of PostgreSQL: Vacuum Processing](https://www.interdb.jp/pg/pgsql06.html)
- 본 시리즈: [16편 DELETE=xmax](/blog/project/db-hobby/db-hobby-16-delete-xmax) · [13편 MVCC](/blog/project/db-hobby/db-hobby-13-mvcc) · [3편 B+Tree](/blog/project/db-hobby/db-hobby-3-index-wal)

<!-- EN -->

## 0. Introduction

[Part 16](/blog/project/db-hobby/db-hobby-16-delete-xmax) ended by creating a problem **on purpose**. Once DELETE stamped xmax instead of erasing rows (logical deletion), dead versions stayed in the heap forever. We wrote: *"deleting and cleaning are different jobs — VACUUM is the next part's failure narrative."*

This part is that janitor. And the homework this series has deferred since [Part 3](/blog/project/db-hobby/db-hobby-3-index-wal) — **B+Tree deletion** — finally arrives, "because it's needed."

## 1. The Failure — DELETE Shrinks Nothing

In post-16 db-hobby:

```sql
db-hobby> INSERT ... (10 rows)
db-hobby> DELETE FROM t WHERE id > 5;
5 rows deleted
db-hobby> SELECT COUNT(*) FROM t;
5                     -- 5 rows visible, but...
```

Count the heap physically: **still 10 rows.** UPDATE is worse — modify the same row five times and five old versions pile up. The file only grows, and scans slow down reading dead versions just to discard them at the gate. **Bloat.**

Not a bug — MVCC by design (the same reason "I deleted a lot in PostgreSQL but disk didn't shrink" is normal). But design doesn't mean you never clean: PostgreSQL has VACUUM. So we build one.

## 2. Who's Dead — a One-Line Verdict

VACUUM's first question: **which versions may be removed?** The principle: versions that no transaction, now or ever, can see. In general that's a delicate judgment over all live snapshots (PostgreSQL's oldest-xmin horizon), but db-hobby's simplifications pay off here.

```c
/* Dead — an old version with a committed xmax, visible to no one anymore.
 * (Single transaction + physical rollback: no aborted-xmin rows exist on disk,
 *  and VACUUM only runs outside transactions, so no uncommitted xmax either.) */
static int rec_dead(Database *db, const void *rec) {
    int32_t xmax = db_rec_xmax(rec);
    return xmax != 0 && txn_committed_view(db, xmax);
}
```

**Dead = committed xmax.** That one line is a complete verdict thanks to two simplifications — only one transaction exists (no other snapshots), and rollback is physical (no aborted rows on disk). VACUUM **refuses to run inside a transaction**, like PostgreSQL (`VACUUM cannot run inside a transaction block` — we raise the same error), so it never meets an uncommitted xmax.

## 3. The Janitor's Three Jobs

`VACUUM [<table>]` works in three steps, in order:

```
① remove the index entries pointing at dead versions   (lazy B+Tree deletion)
② empty their heap slots and compact each page          (RIDs stay stable)
③ truncate trailing all-empty pages                     (conditional truncation)
```

**② page compaction** — emptying slots is `heap_delete` (tombstone). A fun moment: the tombstone that Part 16 evicted from DELETE's semantics **found its true job as VACUUM's cleaning tool.** After emptying, live records are repacked toward the page end to reclaim space, but **slot numbers stay put** — a slot number is the RID, and indexes point at rows by RID. Same reason PostgreSQL preserves the line-pointer array when it defragments a page.

**③ conditional truncation** — walk backward from the file's end, cutting only all-empty pages. **Empty pages in the middle stay.** PostgreSQL's VACUUM behaves exactly the same — which is why "I ran VACUUM and the file didn't shrink" is so common (Part 16's practical note is now true in our own code).

## 4. B+Tree Deletion Arrives — Unlike the Textbook

Remove dead versions from the heap and their index entries point at nothing. They must go — but this series' README has said since Part 3: *"B+Tree deletion isn't implemented."* Insert and split only; no delete. There was no need. **Now there is.**

Before transplanting the textbook (merge/redistribute), we checked what a real database does. **PostgreSQL's nbtree does not redistribute.** It deletes leaf items, and only when a page becomes completely empty does it unlink and recycle it. Half-empty nodes just stay. So we followed that grain — **lazy deletion**.

```c
/* Remove one (key, val) entry from a leaf — lazy: no merge/redistribute.
 * Internal separator keys may go stale, but they are only routing guides,
 * so searches stay correct. */
int btree_delete_val(BTree *bt, bkey_t key, bval_t val) {
    /* lower-bound descent to the leftmost candidate leaf -> walk the leaf chain
       for the (key,val) pair and shift it out. An empty leaf stays in the
       chain — scans simply pass through it. */
}
```

Note it deletes a **(key, RID) pair**, not just a key. Secondary indexes are non-unique — one key can hold many RIDs — so only the dead version's pair must go.

And the trap that needed the most care: **a PK index entry must not be deleted carelessly.**

```c
/* Delete the PK entry only if the index still points at this dead RID —
 * after an UPDATE/re-insert, the same key points at the live new version. */
if (btree_search(&t->index, e->pk, &v) == 0 && v == rid_encode(e->rid)) {
    btree_delete_val(&t->index, e->pk, v);
}
```

Consider `UPDATE t SET v='new' WHERE id=1`. The old (dead) version has PK 1, the new (live) version has PK 1, and the index's `1` already points at **the new one**. Delete key `1` while cleaning the dead version and the live row vanishes from the index. So we delete only when the index still points at the dead RID — purely-DELETEd keys qualify; UPDATEd and re-inserted keys are naturally preserved.

## 5. The Ghost Flush — a Landmine the Janitor Almost Stepped On

Step ③ hid a trap. If a to-be-truncated tail page is still sitting in the buffer pool as a **dirty frame**, the commit-time flush will `pwrite` it back — re-extending the file. The truncated page returns like a ghost. So we invalidate those frames before truncating:

```c
bufpool_invalidate_from(t->bp, new_np); /* so cut pages' frames can't resurrect the file */
pager_truncate(&t->wal.data, new_np);
```

And an honest note: **file truncation is not WAL-logged.** If we crash before VACUUM's commit, the truncation may stick while the slot-emptying rolls back. It's still safe — the cut pages held **only dead versions**, which were visible to no one, so the user-visible state is identical before and after the crash. Any stale index entries pointing into the cut region fail `heap_get` and get filtered (Part 16's gate structure is the safety net again).

## 6. Verification — Before and After Cleaning

Highlights from the new `test_vacuum` (17 scenarios):

```
ok   before VACUUM: 5 dead versions remain in the heap (10 rows)
ok   VACUUM reclaims the 5 dead versions
ok   after VACUUM: only the 5 live rows in the heap
ok   VACUUM is idempotent — nothing to clean the second time
ok   5 UPDATEs -> 5 old versions accumulated (bloat)
ok   newest version still found via PK (live entries for the same key untouched)
ok   VACUUM inside BEGIN -> refused (same as PostgreSQL)
ok   trailing empty pages cut — the file shrank (conditional truncation)
```

Visible row counts and index lookups are identical before and after (cleaning must not touch the visible world); only physical row counts and file size drop. Full suite: **380 checks / 23 suites green.**

> **Practical/interview note**: this structure explains why autovacuum is such a critical daemon. Skip VACUUM and ① bloat slows scans, ② dead-tuple stats (`n_dead_tup`) pile up, ③ (in real PG) you eventually face xid wraparound. With the "DELETE is a stamp; cleaning is a separate daemon" picture, parameters like `autovacuum_vacuum_scale_factor` all read as one question: *when do you call the janitor?*

![VACUUM — pick dead versions (committed xmax), lazily delete their index entries, empty their heap slots and compact pages (RIDs stable), and conditionally truncate trailing all-empty pages. PK entries for UPDATEd keys point at the live new version and are preserved](/uploads/project/db-hobby/vacuum-sweep.svg)

## 7. Wrap-up — the Single-Transaction Mini-PostgreSQL, Complete

| Item | Status | Note |
|---|---|---|
| Dead-version heap reclaim | O | slot emptying + compaction (RIDs stable) |
| Dead index entry removal | O | **lazy B+Tree deletion** — no redistribute, like PG nbtree |
| Live index entry preservation | O | untouched when the PK points at a new version |
| File shrink | partial | trailing empty pages only (PG-style conditional) |
| VACUUM inside a transaction | refused | same as PostgreSQL |
| autovacuum | X | manual `VACUUM` only — a daemon matters after multi-transaction |

The chain that began in [Part 13](/blog/project/db-hobby/db-hobby-13-mvcc) has come full circle — versions and visibility (13) → steal and undo (14) → no-force and the WAL (15) → MVCC-native DELETE (16) → **cleaning its byproduct (17)**. Storage, recovery, isolation, and cleanup all stand, single-transaction-wise: one full cycle of a "mini PostgreSQL."

One frontier remains — **true multi-transaction** (actually demonstrating that readers don't block writers, plus first-updater-wins write conflicts). Everything built since Part 13 — steal, abort-rollback, log-centric recovery, versions, gates, cleaning — has been preparation for exactly that.

## References

- [PostgreSQL Documentation: Routine Vacuuming](https://www.postgresql.org/docs/current/routine-vacuuming.html)
- [PostgreSQL Documentation: B-Tree Implementation (nbtree — deletion and page recycling)](https://www.postgresql.org/docs/current/btree-implementation.html)
- [The Internals of PostgreSQL: Vacuum Processing](https://www.interdb.jp/pg/pgsql06.html)
- This series: [Part 16 DELETE=xmax](/blog/project/db-hobby/db-hobby-16-delete-xmax) · [Part 13 MVCC](/blog/project/db-hobby/db-hobby-13-mvcc) · [Part 3 B+Tree](/blog/project/db-hobby/db-hobby-3-index-wal)

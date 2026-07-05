---
title: 'LSM을 진짜 PK 인덱스로 — 왜 DB 인덱스는 단순 key→value가 아닌가 (USING lsm)'
titleEn: 'Wiring LSM as a Real PK Index — Why a DB Index Isn''t a Simple key→value Store (USING lsm)'
description: "27편에서 LSM을 독립 모듈로 증명하며 정직하게 남긴 경계가 있었다 — 'db.c 저장 계층에 미배선. 실행기 뒤에 또 하나의 저장 엔진으로 꽂는 건 프론티어.' 이 편이 그 프론티어를 닫는다. 31편(WAL 복제)·33편(Raft SMR)처럼, 독립 증명 모듈을 실제 엔진에 배선한다. CREATE TABLE ... USING lsm으로 테이블마다 PK 인덱스 저장 엔진을 B+Tree(제자리, 읽기 최적)와 LSM(append, 쓰기 최적) 중에 고른다. 배선하며 진짜 벽에 부딪혔다: PK 인덱스는 MVCC 다중버전 때문에 '한 PK → 여러 RID' 비유니크 멀티맵이라, unique(키당 값 하나) LSM으로는 담을 수 없다. 그래서 LSM에 멀티값 모드를 더한다 — dedup 단위가 key가 아니라 (key,val) 짝이 되는. 실행기 5개 지점을 작은 인덱스 추상화(Table Access Method)로 라우팅하고, LSM 인덱스는 WAL-backed heap을 진실의 원천으로 삼는 파생 가속기로 둔다: 재오픈·롤백 시 heap에서 재구축하고, 중단 트랜잭션의 dangling 항목은 읽기 경로의 가시성 게이트가 걸러낸다. B+Tree 테이블과 점/범위 조회·MVCC UPDATE 가시성·DELETE/VACUUM·ROLLBACK·재오픈에서 동치임을 테스트로 증명한다. 634 checks / 36스위트, ASan/UBSan 클린. 정직한 경계: bloom filter·leveled compaction·인덱스 WAL 내구성·보조 인덱스 LSM화는 프론티어."
descriptionEn: "In Part 27 I proved an LSM as a standalone module and honestly left a boundary — 'not wired into db.c's storage layer. Plugging it behind the executor as another storage engine is the frontier.' This part closes that frontier. Like Part 31 (WAL replication) and Part 33 (Raft SMR), it wires a standalone proof module into the real engine. CREATE TABLE ... USING lsm lets each table pick its PK-index storage engine between the B+Tree (in-place, read-optimal) and the LSM (append, write-optimal). Wiring it hit a real wall: because MVCC keeps multiple row versions per key, the PK index is a NON-UNIQUE multimap (one PK → many RIDs), which a unique (one-value-per-key) LSM can't hold. So I add a multi-value mode to the LSM — where the dedup unit is the (key,val) pair, not the key. Five executor call sites route through a small index abstraction (a Table Access Method), and the LSM index is a derived accelerator over the WAL-backed heap as the source of truth: it's rebuilt from the heap on reopen/rollback, and dangling entries from an aborted transaction are filtered by the read path's visibility gate. Tests prove it's equivalent to a B+Tree table across point/range lookups, MVCC UPDATE visibility, DELETE/VACUUM, ROLLBACK, and reopen. 634 checks / 36 suites, ASan/UBSan clean. Honest boundary: bloom filters, leveled compaction, index-WAL durability, and LSM-backed secondary indexes are frontiers."
date: 2026-07-05
tags:
  - C
  - Database Internals
  - LSM-Tree
  - Storage Engine
  - MVCC
  - Indexing
  - Learning
category: study/db-hobby
coverImage: /uploads/project/db-hobby/cover.svg
draft: false
series: "db-hobby"
seriesOrder: 35
---

## 0. 들어가며 — 27편이 남긴 프론티어

[27편](/blog/project/db-hobby/db-hobby-27-lsm-engine)에서 LSM-Tree를 독립 모듈로 만들며, 마지막에 이렇게 적었어요:

> "이 LSM은 **독립 모듈**입니다. db.c의 저장 계층(heap/B+Tree) 뒤에 '또 하나의 테이블 저장 엔진'으로 꽂는 것 — MySQL의 **MyRocks**가 RocksDB를 InnoDB 옆에 꽂듯 — 이 **프론티어**입니다. … 400개 넘는 green 테스트를 지키면서 그걸 하는 건 별개의 큰 작업이에요."

이 편이 그 프론티어를 닫습니다. [31편(WAL 복제)](/blog/project/db-hobby/db-hobby-31-replicated-db)·[33편(Raft SMR)](/blog/project/db-hobby/db-hobby-33-raft-replicated-db)이 그랬듯, **독립 증명 모듈을 실제 db.c 엔진에 배선**하는 캡스톤이에요. 목표는 이거예요:

```sql
CREATE TABLE t (id INT, v INT) USING lsm;
```

테이블마다 **PK 인덱스 저장 엔진**을 B+Tree(제자리 갱신, 읽기 최적)와 LSM(append, 쓰기 최적) 중에 고른다. 쓰기가 많은 테이블은 LSM으로, 읽기가 많은 테이블은 B+Tree로 — MyRocks가 InnoDB 옆에 사는 그림 그대로요.

## 1. 어디에 꽂을까 — PK 인덱스라는 깨끗한 seam

우리 엔진에서 한 테이블은 세 조각이에요:

- **heap**(`t->heap`): 행(가변 길이 바이트)을 slotted-page에 저장. RID로 주소 지정.
- **PK 인덱스**(`t->index`): `PK(int64) → RID(encoded int64)` 매핑. B+Tree.
- **보조 인덱스**(`t->sec[]`): `컬럼값 → RID`. B+Tree.

LSM의 네이티브 API는 `int64 → int64`예요. 행(가변 길이)엔 안 맞지만, **PK 인덱스는 정확히 `int64(PK) → int64(RID)`** 예요. 그래서 행 heap을 건드리지 않고 **PK 인덱스만 교체 가능(pluggable)**하게 만들면 LSM이 그대로 들어갑니다. 이게 가장 깨끗한 seam이에요. (보조 인덱스는 이 편에선 B+Tree로 둡니다 — 왜인지는 §5에서.)

## 2. 부딪힌 진짜 벽 — 인덱스는 단순 key→value가 아니다

막상 꽂으려니 벽이 하나 나왔어요. **PK 인덱스는 유니크가 아니에요.**

왜냐면 [MVCC](/blog/project/db-hobby/db-hobby-16-delete-xmax) 때문이에요. `UPDATE`는 옛 행을 제자리에서 고치지 않고, **새 버전(새 RID)을 추가**하고 옛 버전은 [VACUUM](/blog/project/db-hobby/db-hobby-17-vacuum) 전까지 남겨둬요. 그래서 같은 PK에 **여러 RID**가 매달립니다:

```
PK=9 → RID(3,1)   ← 옛 버전 (xmax 찍힘, 아직 VACUUM 안 됨)
PK=9 → RID(5,0)   ← 새 버전 (지금 보이는 것)
```

점 조회 `WHERE id = 9`는 이 **모든** 후보 RID를 받아, 각각 heap에서 읽고, **스냅샷에 보이는 버전 하나**를 골라야 해요. 그래서 B+Tree PK 인덱스도 유니크가 아니라 `btree_insert_dup`(중복 허용)으로 넣죠.

그런데 27편의 LSM은 **유니크**였어요 — 키당 값 하나, `lsm_put`은 덮어쓰기(upsert). "최신이 옛것을 가린다(shadow)"가 read path의 규칙이었으니까요. 이걸로는 `PK=9 → {RID1, RID2}`를 담을 수 없어요.

> 이게 이 편의 핵심 문장이에요: **DB 인덱스는 단순 key→value 저장소가 아니다.** 다중버전을 담으려면 인덱스가 **비유니크 멀티맵**이어야 한다.

## 3. 개선 — LSM에 '멀티값 모드'를 더하다

그래서 LSM 자체를 개선해요. dedup 단위를 **key**에서 **(key, val) 짝**으로 바꾸는 모드예요. RocksDB/MyRocks가 비유니크 보조 인덱스를 담는 것과 같은 계열이죠.

```c
LSM *lsm_open_multi(const char *dir, size_t threshold, int multi);
int  lsm_put_dup(LSM *l, int64_t key, int64_t val);   // (key,val) 짝 추가 — 다른 val 안 가림
int  lsm_delete_val(LSM *l, int64_t key, int64_t val);// 그 짝만 tombstone
int64_t lsm_find_all(LSM *l, int64_t key, cb, ctx);   // key의 살아있는 모든 val
```

바뀐 건 딱 두 곳의 사고방식이에요:

- **memtable**: 유니크는 key로 정렬·치환. 멀티는 `(key, val)`로 정렬하고, 같은 짝이 있으면 tombstone 비트만 갱신, 다른 val은 안 건드림(`mem_upsert_dup`).
- **merge/dedup**: 유니크는 `(key asc, prio desc)`로 정렬해 **key마다** 최신 하나. 멀티는 `(key asc, val asc, prio desc)`로 정렬해 **(key,val)마다** 최신 하나(`mentry_cmp_multi` + `same_group`). tombstone된 짝은 스킵.

`prio`는 최신도예요(memtable=`UINT64_MAX`, SSTable=`seq`). 그래서 memtable의 `delete_val(9, RID1)`이 옛 SSTable의 `put_dup(9, RID1)`을 정확히 그 짝만 가려요. `compaction`도 `(key,val)` 그룹마다 최신만 남기고요.

기존 유니크 API(`lsm_put`/`lsm_get`)와 27편 테스트는 `multi=0` 경로 그대로라 **무손상**이에요. `test_lsm`에 멀티값 시나리오 10개를 더해 독립 증명부터 했어요:

```
  ok   find_all(1): 같은 key의 세 val 모두 반환(3개)
  ok   find_all(1): val 오름차순 {100,101,102} — memtable/SSTable 경계 넘어 dedup by (key,val)
  ok   delete_val(1,101): 그 짝만 삭제 -> {100,102} (다른 짝 살아있음)
  ok   re-put_dup(1,101): tombstone 위에 최신 put -> 부활(3개)
  ok   compaction 후에도 (key,val) 단위 라이브 유지: {100,101,102}
```

## 4. 배선 — Table Access Method 층

이제 db.c의 실행기가 PK 인덱스를 만지는 **다섯 지점**을 작은 추상화로 라우팅해요. 실행기는 "B+Tree냐 LSM이냐"를 몰라도 되고, `pidx_*`가 `t->index_kind`를 보고 고릅니다. 이게 곧 **Table Access Method** 층이에요(PostgreSQL의 `tableam`, MySQL의 handler API의 축소판).

```c
static void pidx_insert(Table *t, int64_t key, RID rid) {
    if (t->index_kind == 1) lsm_put_dup(t->lindex, key, rid_encode(rid));
    else                    btree_insert_dup(&t->index, key, rid_encode(rid));
}
// pidx_delete / pidx_find_all(점 조회) / pidx_range(범위 조회) 도 같은 꼴
```

![교체 가능한 PK 인덱스: 실행기는 PK→RID 매핑만 알고, pidx가 B+Tree/LSM으로 라우팅한다](/uploads/project/db-hobby/lsm-pk-index.svg)

파싱은 `USING lsm|btree`를 `CREATE TABLE` 끝에 붙여요(키워드가 아니라 식별자로 렉싱해 텍스트로 매칭). 선택 결과는 `CreateStmt.index_kind`에 실려 **카탈로그에 영속**되고, 재오픈 때 `table_open_files`가 그걸 읽어 어느 엔진을 열지 정합니다.

### 정직한 경계 — 롤백과 내구성

여기서 정직해야 할 지점이 있어요. B+Tree PK 인덱스는 **자체 WAL로 트랜잭션 롤백에 참여**해요(BEGIN 시점 페이지 수로 truncate, `btree_reload_root`). 그런데 LSM은 append-only 파일 + volatile memtable이라 그 롤백 기계에 못 낍니다.

해법은 **관점을 바꾸는 것**이에요. 읽기 경로(`point_visit`)는 인덱스가 준 RID를 heap에서 다시 읽고 **[가시성](/blog/project/db-hobby/db-hobby-18-snapshot)을 재검사**해요. 즉 인덱스는 "권위 있는 진실"이 아니라 heap 위의 **파생 가속기**예요. 그래서:

- **재오픈**: LSM 인덱스를 heap에서 통째로 재구축(`lsm_pk_rebuild` — 보조 인덱스가 이미 하는 `secidx_build`와 같은 발상). heap이 진실의 원천이라 crash에도 안전.
- **롤백**: 트랜잭션이 중단되면, 이미 롤백된 heap에서 LSM 인덱스를 재구축해 동기화.
- **중단 txn의 dangling 항목**: 혹시 남더라도, heap_get이 실패하거나 가시성 게이트가 걸러내서 **결과는 항상 옳다.**

한 문장으로: **LSM PK 인덱스는 잠깐 부정확해도 결과가 틀리지 않는다 — heap과 가시성 게이트가 최종 방어선이니까.**

## 5. 검증 — B+Tree와 완전히 동치인가

`test_lsm_engine`(신규, 22 checks)이 `USING lsm` 테이블과 기본 B+Tree 테이블에 **같은 SQL을 던져 결과가 같은지**를 봐요:

```
  ok   LSM 점 조회 id=7 -> 70 (인덱스 사용)
  ok   점 조회: LSM == B+Tree
  ok   범위 >=: LSM == B+Tree   /  범위 >  /  범위 <=  /  범위 <
  ok   UPDATE 후 점 조회: 새 버전만 보임(옛 70 가림) — 다중버전 LSM 인덱스
  ok   VACUUM 후 살아있는 최신 버전 유지
  ok   ROLLBACK 후 id=99 사라짐(인덱스 재구축으로 dangling 없음)
  ok   재오픈 후 LSM 인덱스 여전히 동작(카탈로그 index_kind 영속 + 재구축)
  ok   SSTable flush 여러 번 후에도 점 조회 정확(id=500)
```

점 조회·네 부등호 범위 조회·MVCC UPDATE 가시성·DELETE/VACUUM·ROLLBACK·재오픈·대량 삽입(flush 다회) 전부 통과. 전체 **634 checks / 36스위트, FAIL 0, ASan/UBSan 클린**이에요.

### 적대적 자체 리뷰

[30·32·33·34편](/blog/project/db-hobby/db-hobby-32-raft-membership)에서 서브에이전트 적대 리뷰가 실버그를 잡았기에, 이번에도 가장 위험한 지점을 스스로 공격했어요:

- **범위 bounds**: LSM은 콜백의 조기중단 반환을 무시하지만, op에 맞춰 `[lo,hi]`를 잡고 `range_visit`가 최종 필터링해 `GT`의 `key==bound` 제외까지 B+Tree와 동일 — 테스트의 문자열 일치로 실증.
- **멀티 compaction**: SSTable만 merge하고 memtable은 제외 → memtable이 항상 최신이라 tombstone drop이 부활을 못 일으킴.
- **롤백 순서**: `txn_abort_tables`가 테이블별로 heap을 먼저 롤백한 뒤 그 자리에서 재구축 → 재구축이 롤백된 heap을 본다.

### 남긴 프론티어

- **bloom filter 없음**: 멀티값 점 조회 `find_all`은 per-SSTable 이진탐색이 아니라 전체 run을 merge해요 — 이게 바로 LSM의 대가인 **read amplification**을 그대로 노출하죠. bloom + per-file 프루닝이 프론티어.
- **인덱스 WAL 내구성 없음**: LSM 인덱스는 재구축에 기대는 파생 구조. memtable을 WAL로 보호해 재구축을 없애는 건([15편의 WAL](/blog/project/db-hobby/db-hobby-15-noforce-checkpoint) 재사용) 다음 단계.
- **보조 인덱스는 B+Tree**: 보조 인덱스도 비유니크라 멀티값 LSM으로 담을 수 있지만, 이 편은 PK만.
- **leveled compaction·다중 컬럼 값**: 여전히 27편 그대로.

## 6. 마무리

- 27편이 남긴 프론티어("LSM을 실제 저장 엔진으로 배선")를 닫았다 — `CREATE TABLE ... USING lsm`.
- 진짜 벽은 **MVCC 다중버전**: PK 인덱스는 '한 PK → 여러 RID' **비유니크 멀티맵**이라, unique LSM으로는 못 담는다. → LSM에 **멀티값 모드**((key,val) 단위 dedup)를 더해 넘었다.
- 실행기 5개 지점을 **Table Access Method**(`pidx_*`)로 라우팅 — 실행기는 저장 엔진을 모른다.
- LSM 인덱스는 **WAL-backed heap의 파생 가속기**: 재오픈·롤백 시 재구축, dangling은 가시성 게이트가 무해화 — 잠깐 부정확해도 결과는 옳다.
- B+Tree 테이블과 점/범위/UPDATE/DELETE/VACUUM/ROLLBACK/재오픈에서 동치임을 634 checks로 증명.

<!-- EN -->

## 0. Intro — The Frontier Part 27 Left

Building the LSM-Tree as a standalone module in [Part 27](/blog/project/db-hobby/db-hobby-27-lsm-engine), I closed with this:

> "This LSM is a **standalone module.** Plugging it behind db.c's storage layer (heap/B+Tree) as 'another table storage engine' — the way MySQL's **MyRocks** plugs RocksDB in next to InnoDB — is the **frontier.** … Doing that while keeping 400+ green tests is a separate large effort."

This part closes that frontier. Like [Part 31 (WAL replication)](/blog/project/db-hobby/db-hobby-31-replicated-db) and [Part 33 (Raft SMR)](/blog/project/db-hobby/db-hobby-33-raft-replicated-db), it's a capstone that **wires a standalone proof module into the real db.c engine.** The goal:

```sql
CREATE TABLE t (id INT, v INT) USING lsm;
```

Each table picks its **PK-index storage engine** between the B+Tree (in-place, read-optimal) and the LSM (append, write-optimal). Write-heavy tables go LSM, read-heavy tables stay B+Tree — exactly the picture of MyRocks living beside InnoDB.

## 1. Where to Plug In — the PK Index as a Clean Seam

In our engine a table is three pieces:

- **heap** (`t->heap`): stores rows (variable-length bytes) in slotted pages, addressed by RID.
- **PK index** (`t->index`): maps `PK(int64) → RID(encoded int64)`. A B+Tree.
- **secondary indexes** (`t->sec[]`): `column value → RID`. B+Trees.

The LSM's native API is `int64 → int64`. That doesn't fit a variable-length row, but the **PK index is exactly `int64(PK) → int64(RID)`.** So without touching the row heap, making just the **PK index pluggable** lets the LSM drop in. That's the cleanest seam. (Secondary indexes stay B+Tree here — why, in §5.)

## 2. The Real Wall — an Index Isn't a Simple key→value Store

Trying to plug it in hit a wall: **the PK index isn't unique.**

Because of [MVCC](/blog/project/db-hobby/db-hobby-16-delete-xmax). An `UPDATE` doesn't fix the old row in place — it **adds a new version (new RID)** and leaves the old one until [VACUUM](/blog/project/db-hobby/db-hobby-17-vacuum). So one PK carries **many RIDs**:

```
PK=9 → RID(3,1)   ← old version (xmax stamped, not yet VACUUMed)
PK=9 → RID(5,0)   ← new version (currently visible)
```

A point lookup `WHERE id = 9` must receive **all** these candidate RIDs, read each from the heap, and pick the **one version visible to the snapshot.** That's why even the B+Tree PK index is non-unique — it uses `btree_insert_dup`.

But Part 27's LSM was **unique** — one value per key, `lsm_put` overwrites. "Newest shadows older" was the read-path rule. That can't hold `PK=9 → {RID1, RID2}`.

> The key sentence of this part: **a DB index isn't a simple key→value store.** To hold multiple versions, the index must be a **non-unique multimap.**

## 3. The Improvement — a "Multi-Value Mode" for the LSM

So I improve the LSM itself: a mode where the dedup unit is the **(key, val) pair** instead of the **key** — the same lineage as how RocksDB/MyRocks hold non-unique secondary indexes.

```c
LSM *lsm_open_multi(const char *dir, size_t threshold, int multi);
int  lsm_put_dup(LSM *l, int64_t key, int64_t val);    // add a (key,val) pair — doesn't shadow other vals
int  lsm_delete_val(LSM *l, int64_t key, int64_t val); // tombstone that pair only
int64_t lsm_find_all(LSM *l, int64_t key, cb, ctx);    // all live vals for a key
```

Only two ideas change:

- **memtable**: unique sorts/replaces by key. Multi sorts by `(key, val)` and, if the same pair exists, updates only the tombstone bit — leaving other vals alone (`mem_upsert_dup`).
- **merge/dedup**: unique sorts `(key asc, prio desc)` and keeps the newest **per key**. Multi sorts `(key asc, val asc, prio desc)` and keeps the newest **per (key,val)** (`mentry_cmp_multi` + `same_group`), skipping tombstoned pairs.

`prio` is recency (memtable=`UINT64_MAX`, SSTable=`seq`). So a memtable `delete_val(9, RID1)` shadows exactly the old SSTable's `put_dup(9, RID1)` — that pair only. `compaction` likewise keeps the newest per `(key,val)` group.

The old unique API (`lsm_put`/`lsm_get`) and the Part 27 tests run the `multi=0` path **untouched.** I added 10 multi-value scenarios to `test_lsm` to prove it in isolation first:

```
  ok   find_all(1): returns all three vals for the same key (3)
  ok   find_all(1): vals ascending {100,101,102} — dedup by (key,val) across the memtable/SSTable boundary
  ok   delete_val(1,101): only that pair removed -> {100,102} (other pairs alive)
  ok   re-put_dup(1,101): newest put over a tombstone -> revived (3)
  ok   after compaction: still live per (key,val): {100,101,102}
```

## 4. The Wiring — a Table Access Method Layer

Now the **five places** in db.c's executor that touch the PK index route through a small abstraction. The executor needn't know "B+Tree or LSM"; `pidx_*` checks `t->index_kind` and picks. This is a **Table Access Method** layer (a miniature of PostgreSQL's `tableam` / MySQL's handler API).

```c
static void pidx_insert(Table *t, int64_t key, RID rid) {
    if (t->index_kind == 1) lsm_put_dup(t->lindex, key, rid_encode(rid));
    else                    btree_insert_dup(&t->index, key, rid_encode(rid));
}
// pidx_delete / pidx_find_all (point) / pidx_range (range) follow the same shape
```

![Pluggable PK index: the executor only knows the PK→RID mapping; pidx routes to B+Tree or LSM](/uploads/project/db-hobby/lsm-pk-index.svg)

Parsing adds `USING lsm|btree` at the end of `CREATE TABLE` (lexed as an identifier, matched by text). The choice rides in `CreateStmt.index_kind`, is **persisted in the catalog**, and on reopen `table_open_files` reads it to decide which engine to open.

### The Honest Boundary — Rollback and Durability

Here's the spot that demands honesty. The B+Tree PK index **participates in transaction rollback via its own WAL** (truncate to the page count at BEGIN, `btree_reload_root`). But the LSM is append-only files + a volatile memtable — it can't join that rollback machinery.

The fix is a **change of perspective.** The read path (`point_visit`) re-reads the RID from the heap and **re-checks [visibility](/blog/project/db-hobby/db-hobby-18-snapshot).** So the index isn't the authoritative truth — it's a **derived accelerator** over the heap. Therefore:

- **Reopen**: rebuild the LSM index wholesale from the heap (`lsm_pk_rebuild` — the same idea as `secidx_build`, which secondary indexes already do). The heap is the source of truth, so it's crash-safe.
- **Rollback**: on abort, rebuild the LSM index from the (already-rolled-back) heap to resync.
- **Dangling entries from an aborted txn**: even if some linger, heap_get fails or the visibility gate filters them, so **the result is always correct.**

In one line: **an LSM PK index can be briefly inaccurate without ever being wrong — the heap and the visibility gate are the last line of defense.**

## 5. Verification — Truly Equivalent to the B+Tree?

`test_lsm_engine` (new, 22 checks) throws the **same SQL** at a `USING lsm` table and a default B+Tree table and checks the results match:

```
  ok   LSM point lookup id=7 -> 70 (index used)
  ok   point lookup: LSM == B+Tree
  ok   range >=: LSM == B+Tree  /  range >  /  range <=  /  range <
  ok   after UPDATE, point lookup shows only the new version (old 70 shadowed) — multi-version LSM index
  ok   after VACUUM, the live newest version survives
  ok   after ROLLBACK, id=99 is gone (index rebuild leaves no dangling)
  ok   after reopen, the LSM index still works (catalog index_kind persisted + rebuild)
  ok   point lookup correct after multiple SSTable flushes (id=500)
```

Point lookup, all four range inequalities, MVCC UPDATE visibility, DELETE/VACUUM, ROLLBACK, reopen, and bulk insert (many flushes) all pass. The whole suite is **634 checks / 36 suites, FAIL 0, ASan/UBSan clean.**

### Adversarial Self-Review

Since subagent adversarial reviews caught real bugs in [Parts 30/32/33/34](/blog/project/db-hobby/db-hobby-32-raft-membership), I attacked the riskiest spots myself again:

- **Range bounds**: the LSM ignores the callback's early-stop return, but it sets `[lo,hi]` per op and lets `range_visit` do the final filtering — down to excluding `key==bound` for `GT` — matching the B+Tree exactly (proven by string-equal tests).
- **Multi compaction**: it merges SSTables only, excluding the memtable → since the memtable is always newest, dropping a tombstone can't resurrect anything.
- **Rollback order**: `txn_abort_tables` rolls back each table's heap first, then rebuilds in place → the rebuild sees the rolled-back heap.

### Frontiers Left

- **No bloom filter**: the multi-value point lookup `find_all` merges the full runs rather than per-SSTable binary search — exposing the LSM's price, **read amplification**, directly. Bloom + per-file pruning is the frontier.
- **No index-WAL durability**: the LSM index is a derived structure that leans on rebuild. Protecting the memtable with a WAL (reusing [Part 15's WAL](/blog/project/db-hobby/db-hobby-15-noforce-checkpoint)) to remove the rebuild is the next step.
- **Secondary indexes stay B+Tree**: they're non-unique too and could use the multi-value LSM, but this part does the PK only.
- **Leveled compaction, multi-column values**: still as in Part 27.

## 6. Wrap-up

- Closed the frontier Part 27 left ("wire the LSM in as a real storage engine") — `CREATE TABLE ... USING lsm`.
- The real wall was **MVCC multi-versioning**: the PK index is a **non-unique multimap** (one PK → many RIDs), which a unique LSM can't hold. → crossed it by adding a **multi-value mode** ((key,val)-granular dedup) to the LSM.
- Routed the executor's five touch points through a **Table Access Method** (`pidx_*`) — the executor doesn't know the storage engine.
- The LSM index is a **derived accelerator over the WAL-backed heap**: rebuilt on reopen/rollback, dangling entries neutralized by the visibility gate — briefly inaccurate, never wrong.
- Proved equivalence to a B+Tree table across point/range/UPDATE/DELETE/VACUUM/ROLLBACK/reopen with 634 checks.

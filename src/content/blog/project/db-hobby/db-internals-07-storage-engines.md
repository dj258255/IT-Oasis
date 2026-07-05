---
title: 'DB 내부 ⑦: 저장 엔진의 세 철학 — 힙 vs 클러스터드 vs LSM, 그리고 USING lsm'
titleEn: 'DB Internals ⑦: Three Philosophies of Storage Engines — Heap vs Clustered vs LSM, and USING lsm'
description: "같은 행들을 저장하는 세 가지 철학이 있다. PostgreSQL의 힙(순서 없이 쌓고 인덱스가 RID로 가리킴), InnoDB의 클러스터드(데이터 자체를 PK 순서로 — 보조 인덱스는 PK를 들고 이중 조회), RocksDB의 LSM(제자리에서 절대 안 고침 — memtable→SSTable→compaction). 한 코드베이스에 셋을 세워 실측하면 교과서의 문장들이 숫자가 된다: PK 점 조회 1.2배·범위 3.8배 클러스터드 우세(지역성), 보조 점 조회는 2배 열세(이중 조회), LSM은 쓰기가 순차화되는 대신 읽기가 여러 SSTable을 뒤진다(read amplification). 마지막은 이 시리즈의 캡스톤 — LSM을 진짜 엔진의 PK 인덱스로 배선하며(CREATE TABLE ... USING lsm) 부딪힌 벽: MVCC 다중버전 때문에 인덱스는 비유니크 멀티맵이어야 하고, unique LSM으로는 담을 수 없어 dedup 단위를 (key,val)로 바꾼 멀티값 모드가 필요했다. 트랜잭션 롤백에 못 끼는 LSM 인덱스를 'heap에서 재구축되는 파생 가속기'로 다루는 설계까지 — MyRocks가 InnoDB 옆에 서는 방식 그대로."
descriptionEn: "There are three philosophies for storing the same rows. PostgreSQL's heap (pile unordered; indexes point by RID), InnoDB's clustered organization (the data itself sorted by PK — secondary indexes carry PK values and pay a double lookup), and RocksDB's LSM (never modify in place — memtable→SSTable→compaction). Standing all three in one codebase turns textbook sentences into numbers: clustered wins PK point lookups 1.2× and ranges 3.8× (locality), loses secondary point lookups 2× (double lookup); the LSM sequentializes writes at the price of reads searching multiple SSTables (read amplification). The finale is this series' capstone — wiring the LSM in as the engine's real PK index (CREATE TABLE ... USING lsm) and the wall hit doing so: MVCC multi-versioning makes an index a non-unique multimap that a unique LSM can't hold, demanding a multi-value mode whose dedup unit is the (key,val) pair. Plus treating the rollback-incapable LSM index as a 'derived accelerator rebuilt from the heap' — exactly how MyRocks stands beside InnoDB."
date: 2026-07-05T00:00:00.000Z
tags:
  - Database Internals
  - Storage Engine
  - LSM-Tree
  - InnoDB
  - PostgreSQL
  - RocksDB
  - C
category: study/db-hobby
coverImage: /uploads/project/db-hobby/cover.svg
draft: false
series: "미니 DB로 이해하는 DB 내부"
seriesOrder: 7
---

## 0. 들어가며 — 같은 행, 세 가지 저장 철학

지금까지의 엔진은 [1편](/blog/project/db-hobby/db-internals-01-storage)에서 고른 **힙**(PostgreSQL식) 위에 서 있어요. 그런데 그건 세 철학 중 하나일 뿐입니다.

| 철학 | 대표 | 한 줄 요약 |
|---|---|---|
| **힙** | PostgreSQL | 순서 없이 쌓고, 인덱스가 RID(물리 위치)로 가리킨다 |
| **클러스터드** | MySQL InnoDB | 데이터 자체를 PK 순서로 정렬해 저장한다 |
| **LSM** | RocksDB·Cassandra | 제자리에서 절대 안 고친다 — 쓰기는 전부 append |

교과서는 이 셋의 장단점을 문장으로 말해요 — "클러스터드는 PK 범위에 유리하다", "LSM은 쓰기에 유리하다". 이 편은 **한 코드베이스에 셋을 다 세워 그 문장들을 숫자로** 만듭니다. 그리고 마지막엔 LSM을 진짜 엔진에 `CREATE TABLE ... USING lsm`으로 배선하며 부딪힌, 교과서에 잘 안 나오는 벽까지.

## 1. 힙 vs 클러스터드 — 두 거인의 정반대 선택

구조 차이부터. **힙**에선 행이 아무 데나 살고, PK 인덱스가 "키 → RID"로 가리켜요(조회 = 인덱스 하강 + 힙 페치, 2단계). **클러스터드**에선 PK 인덱스의 **리프가 곧 데이터**입니다(조회 = 트리 하강 한 번). 대신 보조 인덱스가 갈려요 — 힙의 보조 인덱스는 RID를 들지만, 클러스터드의 보조 인덱스는 **PK 값**을 들고 "보조 트리 → PK 트리 → 데이터"의 **이중 조회**를 합니다(행이 페이지 분할로 옮겨 다니니 물리 포인터를 들 수 없거든요).

같은 데이터를 두 구조로 만들어 실측하면(동일 비용 모델·동일 머신):

| 접근 경로 | 힙 (PG식) | 클러스터드 (InnoDB식) | 결과 |
|---|---|---|---|
| PK 점 조회 | 인덱스→RID→힙 | 트리 하강 한 번 | 클러스터드 **1.2배** 빠름 |
| PK 범위 스캔 | RID마다 힙 페치(흩어짐) | 리프가 데이터 — 순서대로 쭉 | 클러스터드 **3.8배** 빠름 |
| 보조 점 조회 | 보조→RID→힙 | 보조→**PK 트리 또 하강**→데이터 | 클러스터드 **2배 느림** |

숫자가 교과서 문장과 정확히 맞아떨어져요.

- **PK 범위 3.8배** — 클러스터드의 본질인 **지역성**입니다. PK 순서로 정렬돼 있으니 범위 스캔이 연속 페이지를 쭉 읽어요. 힙은 RID들이 흩어진 페이지를 하나씩 페치하고요.
- **보조 2배 열세** — InnoDB의 유명한 **이중 조회(double lookup)** 비용이 그대로 재현됩니다. 그래서 InnoDB에선 "보조 인덱스가 PK를 포함한다"(커버링에 PK 컬럼이 공짜로 들어감) 같은 특성도 따라와요.

> **핵심**: "어느 쪽이 더 좋다"가 아니라 **"무엇에 최적화됐나"** 다. PK 중심의 조회·범위가 많으면 클러스터드(InnoDB), 쓰기가 단순하고 보조 인덱스가 많으면 힙(PG)이 유리하다. 워크로드가 답을 정한다. — 이론은 [DB 인덱스 ⑤: 클러스터형 인덱스와 DBMS별 차이](/blog/theory/db-index-05-clustered-dbms).

## 2. LSM — 제자리에서 절대 안 고친다

세 번째 철학은 더 급진적이에요. B+Tree(힙이든 클러스터드든)는 **제자리 갱신(in-place)** 입니다 — 키가 갈 페이지를 찾아가 그 페이지를 고쳐요. 읽기엔 좋지만 쓰기는 랜덤 I/O + 페이지 분할이라 비쌉니다.

**LSM(Log-Structured Merge tree)** 은 정반대 내기를 겁니다: **절대 제자리에서 안 고친다.**

1. 모든 쓰기는 인메모리 정렬 구조(**memtable**)에 append되고,
2. 임계치를 넘으면 통째로 정렬된 **불변 파일(SSTable)** 로 순차 flush되고,
3. 나중에 background로 여러 SSTable을 merge(**compaction**)해 정리한다.

삭제조차 제자리 삭제가 아니라 **tombstone**(묘비 마커)을 새로 써요 — [4편](/blog/project/db-hobby/db-internals-04-mvcc)의 MVCC DELETE(xmax 논리 삭제)와 VACUUM(나중에 청소)이 했던 그 지연 삭제와 똑같은 발상입니다.

![LSM-Tree — memtable append → SSTable 순차 flush → compaction merge. 읽기는 memtable→최신 SSTable 순(read amplification)](/uploads/project/db-hobby/lsm-tree.svg)

대가는 **읽기**예요. 한 키를 찾으려면 memtable → 최신 SSTable → … → 가장 오래된 SSTable 순으로 뒤져야 합니다(**read amplification**). 최신이 옛것을 "가리고(shadow)", 처음 만난 버전(tombstone 포함)이 이겨요. RocksDB가 Bloom 필터(없는 키를 O(1)에 거름)와 leveled compaction으로 이 비용을 깎는 게 LSM 엔지니어링의 절반입니다.

| | B+Tree (제자리) | LSM (append) |
|---|---|---|
| 쓰기 | 랜덤 I/O + 분할 | **순차 쓰기** (memtable→flush) |
| 읽기 | O(log n) 한 트리 | 여러 run 탐색 (read amp) |
| 삭제 | 제자리 | tombstone (지연) |
| 대표 | PostgreSQL·InnoDB | RocksDB·Cassandra·LevelDB |
| 적합 | 읽기·쓰기 균형 + 트랜잭션 | 쓰기 폭주·로그성 |

C 구현(memtable = 정렬 배열, full compaction, 재오픈 시 `*.sst` 발견)으로 이 성질들을 전부 테스트로 못박았어요 — flush 경계를 넘은 갱신에서 최신이 가리는지, tombstone이 옛 SSTable 값을 가리는지, compaction 후 살아있는 키가 전부 정확한지, 재오픈 후 flush된 데이터가 생존하는지.

## 3. 캡스톤 — LSM을 진짜 PK 인덱스로 (USING lsm)

여기까지의 LSM은 독립 모듈이에요. MySQL의 **MyRocks**가 InnoDB 옆에 RocksDB를 꽂듯, 이걸 진짜 엔진에 꽂아 봅니다 — 목표는:

```sql
CREATE TABLE t (id INT, v INT) USING lsm;
```

테이블마다 PK 인덱스 저장 엔진을 B+Tree(읽기 최적)와 LSM(쓰기 최적) 중에 고르는 거예요. 어디에 꽂을까요? LSM의 네이티브 API는 `int64 → int64`인데, **PK 인덱스가 정확히 `PK(int64) → RID(int64)`** 입니다. 행 heap은 안 건드리고 **PK 인덱스만 교체 가능(pluggable)** 하게 만들면 돼요 — 실행기가 인덱스를 만지는 지점들을 작은 추상화(`pidx_*`)로 라우팅하는, PostgreSQL `tableam`/MySQL handler API의 축소판입니다.

### 부딪힌 벽 — 인덱스는 단순 key→value가 아니다

그런데 막상 꽂으려니 벽이 나왔어요. [4편](/blog/project/db-hobby/db-internals-04-mvcc)에서 본 그것 — **MVCC 때문에 PK 인덱스는 한 키에 여러 RID(버전들)를 매다는 비유니크 멀티맵**입니다. UPDATE가 옛 버전을 남기고 새 버전을 추가하니까요. 그런데 LSM은 unique(키당 값 하나, 최신이 가림)였어요. `PK=9 → {RID_old, RID_new}`를 담을 수 없습니다.

그래서 LSM 자체를 확장했어요 — **멀티값 모드**: dedup 단위를 key에서 **(key, val) 짝**으로 바꿉니다.

```c
int  lsm_put_dup(LSM *l, int64_t key, int64_t val);    /* (key,val) 짝 추가 — 다른 val 안 가림 */
int  lsm_delete_val(LSM *l, int64_t key, int64_t val); /* 그 짝만 tombstone */
int64_t lsm_find_all(LSM *l, int64_t key, cb, ctx);    /* key의 살아있는 모든 val */
```

memtable은 `(key, val)`로 정렬하고, merge는 `(key asc, val asc, 최신도 desc)`로 정렬해 **짝마다** 최신 하나를 채택해요. 같은 키의 서로 다른 RID가 공존하고, 특정 짝만 지울 수 있습니다. RocksDB 계열이 비유니크 보조 인덱스를 담는 방식과 같은 계열이에요.

![교체 가능한 PK 인덱스 — 실행기는 PK→RID 매핑만 알고, pidx가 B+Tree/LSM으로 라우팅한다. MVCC 멀티버전이 멀티값 모드를 강제한다](/uploads/project/db-hobby/lsm-pk-index.svg)

### 두 번째 벽 — 트랜잭션 롤백에 못 낀다

B+Tree PK 인덱스는 자체 WAL로 트랜잭션 롤백에 참여해요. LSM은 append-only 파일 + 휘발성 memtable이라 그 롤백 기계에 못 낍니다. 해법은 **관점 전환**이었어요:

> **LSM PK 인덱스는 "권위 있는 진실"이 아니라 heap 위의 파생 가속기다.** 읽기 경로가 어차피 인덱스 후보를 heap에서 재검사하므로([2편](/blog/project/db-hobby/db-internals-02-btree-index)의 recheck + [4편](/blog/project/db-hobby/db-internals-04-mvcc)의 가시성 게이트), 인덱스가 잠깐 부정확해도 결과는 옳다. 그래서 재오픈·롤백 시 **heap에서 통째로 재구축**하면 되고, 중단된 트랜잭션이 남긴 dangling 항목은 가시성 게이트가 무해화한다.

검증은 동치성으로 — `USING lsm` 테이블과 B+Tree 테이블에 같은 SQL을 던져 점/범위 조회, MVCC UPDATE 가시성, DELETE/VACUUM, ROLLBACK, 재오픈까지 결과가 같은지. 전부 통과했어요.

## 4. 정리

- **세 철학**: 힙(순서 없음+RID), 클러스터드(데이터=PK 트리 리프), LSM(절대 제자리 안 고침). "더 좋다"가 아니라 "무엇에 최적화됐나".
- **실측**: 클러스터드가 PK 점 1.2배·범위 3.8배(지역성) 우세, 보조 점 조회는 2배 열세(이중 조회). 교과서 문장이 숫자가 됐다.
- **LSM의 내기**: 무작위 쓰기를 순차로 바꾸는 대신 read amplification을 진다. tombstone은 MVCC의 지연 삭제와 같은 발상.
- **USING lsm 배선의 교훈**: ① MVCC 멀티버전이 인덱스를 비유니크 멀티맵으로 강제한다 — unique LSM엔 **멀티값 모드**((key,val) dedup)가 필요했다. ② 롤백에 못 끼는 구조는 **heap에서 재구축되는 파생 가속기**로 다루면 된다 — recheck·가시성 게이트가 최종 방어선이니까.

다음 편은 이 엔진을 **여러 코어로** — latch를 계층별로 걷어내는 병렬 실행의 여정(그리고 실측이 알려준 진짜 천장)입니다.

## 참고 (1차 자료 우선)

- Patrick O'Neil et al., *The Log-Structured Merge-Tree (LSM-Tree)* (Acta Informatica, 1996)
- [RocksDB Wiki: Leveled Compaction / Bloom Filters](https://github.com/facebook/rocksdb/wiki)
- [MySQL 8.0 Reference: InnoDB Clustered and Secondary Indexes](https://dev.mysql.com/doc/refman/8.0/en/innodb-index-types.html)
- [MyRocks: A RocksDB Storage Engine for MySQL](http://myrocks.io/)
- [PostgreSQL Documentation: Table Access Method Interface](https://www.postgresql.org/docs/current/tableam.html)
- 본 블로그: [DB 인덱스 ⑤: 클러스터형 인덱스와 DBMS별 차이](/blog/theory/db-index-05-clustered-dbms) · [DB 스토리지 내부 ②: Row vs Column](/blog/theory/db-storage-02-row-vs-column)
- [db-hobby 코드 (GitHub)](https://github.com/dj258255/db-hobby) — `lsm.c` · `cbtree.c` · `db.c`(pidx)

<!-- EN -->

## 0. Introduction — Same Rows, Three Storage Philosophies

The engine so far stands on the **heap** (PostgreSQL-style) chosen in [Part 1](/blog/project/db-hobby/db-internals-01-storage). But that's one philosophy of three:

| Philosophy | Representative | One line |
|---|---|---|
| **Heap** | PostgreSQL | pile unordered; indexes point by RID (physical location) |
| **Clustered** | MySQL InnoDB | store the data itself sorted by PK |
| **LSM** | RocksDB · Cassandra | never modify in place — every write is an append |

Textbooks state the trade-offs in prose — "clustered favors PK ranges," "LSM favors writes." This part stands **all three in one codebase and turns those sentences into numbers** — then finishes by wiring the LSM into the real engine via `CREATE TABLE ... USING lsm`, hitting a wall textbooks rarely mention.

## 1. Heap vs Clustered — Two Giants' Opposite Choices

Structure first. In a **heap**, rows live anywhere and the PK index points "key → RID" (lookup = index descent + heap fetch: 2 steps). In a **clustered** table, the PK index's **leaves are the data** (lookup = one tree descent). The fork moves to secondary indexes — a heap's secondaries carry RIDs, but a clustered table's secondaries carry **PK values** and pay a **double lookup**: secondary tree → PK tree → data (rows migrate during page splits, so physical pointers can't be stored).

Building the same data both ways and measuring (same cost model, same machine):

| Access path | Heap (PG-style) | Clustered (InnoDB-style) | Result |
|---|---|---|---|
| PK point lookup | index→RID→heap | one tree descent | clustered **1.2×** faster |
| PK range scan | heap fetch per RID (scattered) | leaves are the data — read straight | clustered **3.8×** faster |
| Secondary point lookup | secondary→RID→heap | secondary→**descend PK tree again**→data | clustered **2× slower** |

The numbers land exactly on the textbook prose:

- **3.8× on PK ranges** — clustering's essence, **locality**: sorted by PK, a range scan reads consecutive pages; the heap fetches scattered pages one by one.
- **2× behind on secondaries** — InnoDB's famous **double lookup**, reproduced. (It's also why InnoDB secondaries "include the PK for free" in covering terms.)

> **Key point**: not "which is better" but **"optimized for what."** PK-centric lookups and ranges favor clustered (InnoDB); simple writes and many secondaries favor the heap (PG). The workload decides. Theory: [DB Index ⑤: Clustered Indexes Across DBMSs](/blog/theory/db-index-05-clustered-dbms).

## 2. The LSM — Never Modify In Place

The third philosophy is more radical. A B+Tree (heap or clustered) does **in-place updates** — find the page a key belongs to and modify it. Great for reads; writes pay random I/O plus page splits.

The **LSM (Log-Structured Merge tree)** makes the opposite bet: **never modify in place.**

1. Every write appends to an in-memory sorted structure (the **memtable**);
2. past a threshold, it's flushed wholesale into a sorted **immutable file (SSTable)** — sequentially;
3. later, background **compaction** merges SSTables to tidy up.

Even deletion isn't in-place — it writes a **tombstone** marker. The same deferred-deletion idea as [Part 4](/blog/project/db-hobby/db-internals-04-mvcc)'s MVCC DELETE (logical xmax) and VACUUM (clean later).

![LSM-Tree — memtable appends → sequential SSTable flushes → compaction merges. Reads search memtable → newest SSTables (read amplification)](/uploads/project/db-hobby/lsm-tree.svg)

The price is **reads**: finding one key means searching memtable → newest SSTable → … → oldest (**read amplification**). Newer **shadows** older; the first version found (including tombstones) wins. Half of LSM engineering — RocksDB's Bloom filters (reject absent keys in O(1)) and leveled compaction — exists to trim this cost.

| | B+Tree (in-place) | LSM (append) |
|---|---|---|
| Writes | random I/O + splits | **sequential** (memtable→flush) |
| Reads | O(log n), one tree | multiple runs (read amp) |
| Deletes | in place | tombstones (deferred) |
| Representatives | PostgreSQL · InnoDB | RocksDB · Cassandra · LevelDB |
| Fits | balanced R/W + transactions | write-heavy, log-like |

A C implementation (memtable = sorted array, full compaction, `*.sst` discovery on reopen) pins all these properties with tests — newest shadowing across a flush boundary, tombstones shadowing old SSTable values, correctness of all live keys after compaction, survival of flushed data across reopen.

## 3. The Capstone — LSM as the Real PK Index (USING lsm)

So far the LSM is standalone. Like MySQL's **MyRocks** plugging RocksDB in beside InnoDB, we now plug it into the real engine:

```sql
CREATE TABLE t (id INT, v INT) USING lsm;
```

Each table picks its PK-index storage engine: B+Tree (read-optimized) or LSM (write-optimized). Where does it plug in? The LSM's native API is `int64 → int64`, and **the PK index is exactly `PK(int64) → RID(int64)`.** Leave the row heap alone and make just the **PK index pluggable** — routing the executor's index touch-points through a small abstraction (`pidx_*`), a miniature of PostgreSQL's `tableam` / MySQL's handler API.

### The Wall — an Index Is Not a Simple key→value Map

Then the wall: as [Part 4](/blog/project/db-hobby/db-internals-04-mvcc) showed, **MVCC makes the PK index a non-unique multimap** hanging several RIDs (versions) off one key — UPDATE leaves the old version and adds a new one. But the LSM was unique (one value per key; newest shadows). It cannot hold `PK=9 → {RID_old, RID_new}`.

So the LSM itself was extended — a **multi-value mode**: the dedup unit changes from the key to the **(key, val) pair.**

```c
int  lsm_put_dup(LSM *l, int64_t key, int64_t val);    /* add a (key,val) pair — doesn't shadow other vals */
int  lsm_delete_val(LSM *l, int64_t key, int64_t val); /* tombstone that pair only */
int64_t lsm_find_all(LSM *l, int64_t key, cb, ctx);    /* all live vals for a key */
```

The memtable sorts by `(key, val)`; merges sort `(key asc, val asc, recency desc)` and keep the newest **per pair.** Different RIDs of the same key coexist, and a specific pair can be deleted — the same lineage as how RocksDB-family engines hold non-unique secondary indexes.

![Pluggable PK index — the executor knows only the PK→RID mapping; pidx routes to B+Tree or LSM. MVCC multi-versioning forces the multi-value mode](/uploads/project/db-hobby/lsm-pk-index.svg)

### The Second Wall — It Can't Join Transaction Rollback

The B+Tree PK index participates in rollback via its own WAL. The LSM — append-only files plus a volatile memtable — can't join that machinery. The fix was a change of perspective:

> **The LSM PK index is not "authoritative truth" but a derived accelerator over the heap.** Since the read path rechecks index candidates against the heap anyway ([Part 2](/blog/project/db-hobby/db-internals-02-btree-index)'s recheck + [Part 4](/blog/project/db-hobby/db-internals-04-mvcc)'s visibility gate), the index may be briefly inaccurate without the results ever being wrong. So on reopen/rollback it's **rebuilt wholesale from the heap**, and dangling entries from aborted transactions are neutralized by the visibility gate.

Verification by equivalence — the same SQL against a `USING lsm` table and a B+Tree table must match across point/range lookups, MVCC UPDATE visibility, DELETE/VACUUM, ROLLBACK, and reopen. All green.

## 4. Wrap-up

- **Three philosophies**: heap (unordered + RID), clustered (data = PK tree leaves), LSM (never in place). Not "better" — "optimized for what."
- **Measured**: clustered wins PK point 1.2× and range 3.8× (locality), loses secondary lookups 2× (double lookup). Textbook prose became numbers.
- **The LSM's bet**: turn random writes sequential, pay read amplification. Tombstones are MVCC's deferred deletion in another coat.
- **Lessons from wiring USING lsm**: ① MVCC multi-versioning forces the index to be a non-unique multimap — the unique LSM needed a **multi-value mode** ((key,val) dedup). ② A structure that can't join rollback can be treated as a **derived accelerator rebuilt from the heap** — recheck and the visibility gate are the last line of defense.

Next: this engine on **many cores** — the journey of peeling latches off layer by layer for parallel execution, and the real ceiling the measurements revealed.

## References (primary sources first)

- Patrick O'Neil et al., *The Log-Structured Merge-Tree (LSM-Tree)* (Acta Informatica, 1996)
- [RocksDB Wiki: Leveled Compaction / Bloom Filters](https://github.com/facebook/rocksdb/wiki)
- [MySQL 8.0 Reference: InnoDB Clustered and Secondary Indexes](https://dev.mysql.com/doc/refman/8.0/en/innodb-index-types.html)
- [MyRocks](http://myrocks.io/)
- [PostgreSQL Documentation: Table Access Method Interface](https://www.postgresql.org/docs/current/tableam.html)
- This blog: [DB Index ⑤](/blog/theory/db-index-05-clustered-dbms) · [DB Storage Internals ②: Row vs Column](/blog/theory/db-storage-02-row-vs-column)
- [db-hobby source (GitHub)](https://github.com/dj258255/db-hobby) — `lsm.c` · `cbtree.c` · `db.c` (pidx)

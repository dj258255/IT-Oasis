---
title: '한 코드에서 PostgreSQL vs MySQL — 힙 vs 클러스터드, 구조가 곧 성능'
titleEn: 'PostgreSQL vs MySQL in One Codebase — Heap vs Clustered, Structure Is Performance'
description: "db-hobby는 1편부터 PostgreSQL식 '힙'이다 — 행은 힙 파일에 순서 없이 쌓이고, 인덱스는 RID로 그걸 가리킨다. MySQL의 InnoDB는 정반대다 — 데이터를 PK B+Tree 리프에 PK 순서로 저장하고(클러스터드), 보조 인덱스는 RID가 아니라 PK 값을 든다. 이 편은 두 방식을 같은 데이터로 만들어 make bench-clustered로 나란히 잰다. 결과가 구조를 그대로 드러낸다: PK 점 조회는 클러스터드가 1.2배 빠르고(행이 리프에 있어 힙 페치가 없다), PK 범위 스캔은 3.8배 빠르며(행이 PK 순서로 붙어 있어 지역성 최고), 반대로 보조 점 조회는 2배 느리다(보조->PK->데이터 이중 조회 — InnoDB의 유명한 특성). '어느 게 더 좋냐'가 아니라 '무엇에 최적화됐냐'가 저장 구조로 갈린다는 걸, 남의 말이 아니라 내 벤치 숫자로 확인한다."
descriptionEn: "db-hobby has been a PostgreSQL-style 'heap' since Part 1 — rows pile into a heap file in no order, and indexes point at them by RID. MySQL's InnoDB is the opposite — it stores data in the PK B+Tree leaves in PK order (clustered), and secondary indexes hold the PK value, not a RID. This part builds both over the same data and measures them side by side with make bench-clustered. The results lay the structure bare: PK point lookups are 1.2× faster clustered (the row is in the leaf, no heap fetch), PK range scans are 3.8× faster (rows sit contiguously in PK order — peak locality), while secondary point lookups are 2× slower (secondary→PK→data double lookup — InnoDB's famous trait). Not 'which is better' but 'what each is optimized for,' decided by the storage structure — confirmed by my own benchmark numbers, not someone else's claim."
date: 2026-07-03
tags:
  - C
  - Database Internals
  - PostgreSQL
  - MySQL
  - InnoDB
  - Clustered Index
  - Benchmark
  - Learning
category: study/db-hobby
coverImage: /uploads/project/db-hobby/cover.svg
draft: false
series: "db-hobby"
seriesOrder: 23
---

## 0. 들어가며 — 두 거인의 정반대 선택

db-hobby는 [1편](/blog/project/db-hobby/db-hobby-1-storage)부터 **PostgreSQL식 힙**이었어요. 행은 **힙 파일**에 순서 없이 쌓이고(들어온 순서대로), 인덱스는 `RID = (페이지, 슬롯)`로 그 행을 가리킵니다. 조회는 "인덱스에서 RID를 얻고 → 힙에서 그 RID의 행을 가져오는" 2단계죠.

MySQL의 **InnoDB는 정반대**를 골랐습니다 — **클러스터드 인덱스**. 데이터를 별도 힙에 두지 않고, **PK B+Tree의 리프에 PK 순서로 직접 저장**해요. 그리고 보조 인덱스는 RID가 아니라 **PK 값**을 듭니다. 조회는 "보조 인덱스 → PK → 클러스터드에서 데이터" 순이고요.

같은 관계형 DB인데 저장의 뿌리 철학이 반대예요. 어느 게 더 좋을까요? 이 편은 그 답을 **남의 말이 아니라 내 벤치로** 냅니다 — 두 구조를 같은 데이터로 만들어 나란히 재요. ROADMAP이 "한 코드에서 PG식 vs MySQL식을 나란히"라고 적어 둔 그 대조입니다.

## 1. 두 구조를 나란히 세우다

`make bench-clustered`는 같은 4만 행을 두 방식으로 만듭니다.

**힙 모델(PostgreSQL식)** — 세 자료구조:
```c
Heap  heap;      /* 행이 순서 없이 쌓이는 힙 파일 */
BTree pk_idx;    /* PK -> RID */
BTree sk_idx;    /* 보조키 -> RID */
/* 삽입: */
heap_insert(&heap, row, &rid);      /* 힙에 행을 넣고 RID를 받아 */
btree_insert(&pk_idx, key, rid_enc(rid));   /* 인덱스는 RID를 가리킨다 */
btree_insert(&sk_idx, seckey, rid_enc(rid));
```

**클러스터드 모델(InnoDB식)** — 힙이 없어요:
```c
BTree clust;     /* PK -> 행(데이터가 리프에 직접) */
BTree csec;      /* 보조키 -> PK (RID 아님!) */
/* 삽입: */
btree_insert(&clust, key, row);     /* 행 자체를 PK 트리에 */
btree_insert(&csec, seckey, key);   /* 보조는 PK를 든다 */
```

핵심 차이 두 가지가 여기 다 있어요 — ① 클러스터드는 **데이터가 PK 리프 안에** 있다(힙이 없다), ② 보조 인덱스가 **RID가 아니라 PK**를 든다. 그리고 실제 테이블처럼 보이게, 행을 **섞어서 넣습니다** — 그래야 힙의 물리적 순서가 PK 순서와 어긋나요(진짜 테이블은 시간이 지나며 이렇게 흩어집니다).

## 2. PK 점 조회 — 클러스터드가 이긴다

`WHERE id = k` 하나를 찾는 비용을 봅시다.

- **힙**: PK 인덱스를 타고 내려가 RID를 얻고(트리 1번) → 그 RID의 힙 페이지를 가져온다(페치 1번). **트리 + 힙 페치.**
- **클러스터드**: PK 트리를 타고 내려가면 **리프에 행이 이미 있다**(트리 1번). 끝. **힙 페치가 없다.**

```
PK 점 조회    힙(PG) 0.249s   클러스터드 0.208s   → 1.20배 빠름
```

클러스터드가 **1.2배 빠릅니다.** 데이터가 인덱스 리프에 붙어 있으니 별도 힙 방문이 없어요. InnoDB에서 "PK로 찾는 게 제일 빠르다"는 게 이 구조에서 나옵니다.

## 3. 보조 점 조회 — 이번엔 클러스터드가 진다

그런데 보조 컬럼으로 찾으면 판이 뒤집혀요.

- **힙**: 보조 인덱스 → RID(트리 1번) → 힙 페치(1번). PK 조회와 **똑같은 비용**. 힙에선 PK든 보조든 인덱스가 다 RID를 가리키니까요.
- **클러스터드**: 보조 인덱스 → **PK**(트리 1번) → 그 PK로 **클러스터드를 다시 타고 내려가 데이터**(트리 또 1번). **트리를 두 번** 탑니다.

```
보조 점 조회  힙(PG) 0.249s   클러스터드 0.495s   → 0.50배 (2배 느림)
```

클러스터드가 **2배 느립니다.** 이게 InnoDB의 유명한 특성이에요 — **보조 인덱스 조회는 항상 "이중 조회(secondary → PK → clustered)"** 를 합니다. 보조 인덱스가 RID(데이터 위치)가 아니라 PK를 들기 때문에, 데이터에 닿으려면 클러스터드 인덱스를 한 번 더 타야 하거든요.

> **실무/면접 포인트**: "InnoDB에서 보조 인덱스가 왜 PK를 포함하나요?"의 답이 이거예요. 클러스터드라 데이터가 PK 트리에 있으니, 보조 인덱스는 데이터로 가려면 PK를 거쳐야 합니다. 그래서 **InnoDB의 PK를 길게 잡으면 모든 보조 인덱스가 뚱뚱해지고 느려져요**(보조 인덱스마다 PK를 통째로 저장하니까). "InnoDB PK는 짧게"라는 튜닝 격언이 이 구조에서 나옵니다. PostgreSQL엔 이 특성이 없죠 — 인덱스가 다 RID(고정 크기)를 가리키니까.

## 4. PK 범위 스캔 — 클러스터드의 압승

가장 극적인 차이는 범위 스캔이에요. `WHERE id BETWEEN k AND k+200` 같은 걸 봅시다.

- **힙**: PK 인덱스가 RID를 PK 순서로 주지만, 그 RID들이 가리키는 힙 행은 **여기저기 흩어진 페이지**에 있어요(섞어 넣었으니까). 200개 행 = 200번의 (거의) 랜덤 페치. 버퍼 풀을 넘으면 캐시 미스 폭발.
- **클러스터드**: 행이 PK 순서로 **리프 체인에 붙어 있어요.** 범위 200행이 **인접한 몇 개 리프 페이지**에 몰려 있죠. 순차적으로 쭉 읽으면 끝 — 지역성 최고.

```
PK 범위(200행)  힙(PG) 0.673s   클러스터드 0.177s   → 3.80배 빠름
```

**3.8배.** 이게 클러스터드의 진짜 무기예요. "PK 순서로 데이터가 물리적으로 붙어 있다"가 범위 스캔·정렬·PK 기준 조인에서 압도적 지역성을 줍니다. InnoDB가 PK 순 정렬/범위에 강한 이유이자, "InnoDB는 PK를 신중히 고르라"는 또 다른 이유예요(PK가 곧 물리적 저장 순서니까).

![힙(PG) vs 클러스터드(InnoDB) — 힙은 행이 힙 파일에 흩어져 쌓이고 인덱스가 RID로 가리킨다(조회 = 인덱스->RID->힙). 클러스터드는 데이터가 PK B+Tree 리프에 PK 순서로 있고 보조 인덱스는 PK를 든다(조회 = 보조->PK->데이터). PK 점 조회·범위는 클러스터드 유리(지역성), 보조 점 조회는 이중 조회로 힙 유리](/uploads/project/db-hobby/clustered-vs-heap.svg)

## 5. 그래서 — "더 좋다"가 아니라 "무엇에 최적화됐나"

벤치 한 장으로 정리돼요(4만 행, 섞어 적재, 구조당 버퍼 풀 32프레임).

| 작업 | 힙(PG) | 클러스터드(InnoDB) | 승자 |
|---|---|---|---|
| PK 점 조회 | 0.249s | 0.208s | **클러스터드 1.2배** (힙 페치 없음) |
| 보조 점 조회 | 0.249s | 0.495s | **힙 2배** (클러스터드는 이중 조회) |
| PK 범위(200행) | 0.673s | 0.177s | **클러스터드 3.8배** (지역성) |

어느 것도 전부 이기지 않아요. **저장 구조가 트레이드오프를 정합니다:**

- **클러스터드(InnoDB)** 는 PK 중심 접근(점 조회·범위·PK 조인)에 강하고, 보조 인덱스 조회에 세금(이중 조회)을 냅니다. PK가 곧 물리 순서라 PK 선택이 성능을 좌우해요.
- **힙(PostgreSQL)** 은 모든 인덱스가 대등하게 RID를 가리켜 **보조 인덱스에 페널티가 없고**, 인덱스가 많은 워크로드에 균형 잡혀요. 대신 PK 범위의 지역성은 포기하죠(그래서 PG엔 `CLUSTER` 명령으로 물리 재정렬하는 옵션이 따로 있습니다).

"MySQL이 빠르다 / PostgreSQL이 낫다" 같은 말이 왜 상황마다 뒤집히는지가, 이 세 줄 표에 다 있어요. **벤치를 내 손으로 돌려 보면, 남의 벤치 논쟁이 그냥 "어떤 워크로드를 쟀냐"의 문제로 보입니다.**

## 6. 정직한 경계 — 벤치·비교로 구현했다

솔직히 짚을게요. 이 클러스터드 모델은 **엔진에 `CREATE TABLE ... CLUSTERED` 모드로 배선하지 않았습니다.** 기존 `btree.c`·`heap.c` 원시 자료구조를 두 방식으로 **조합한 벤치·비교 모듈**(`bench_clustered`, `test_clustered`)로 구현했어요. 이유는 [22편](/blog/project/db-hobby/db-hobby-22-latch-crabbing)과 같아요 — 대조의 **핵심(접근 경로 비용)은 구조 조합으로 충분히 드러나고**, 엔진 코어에 새 저장 모드를 심으면 400개 넘는 기존 테스트를 흔들 회귀 위험이 크거든요.

그래서 이건 "InnoDB식 저장을 db-hobby 엔진에 정식 모드로 넣은 것"은 아니고, **두 저장 철학의 비용 구조를 같은 원시 계층 위에서 나란히 실측한 것**입니다. 정식 모드로 넣으려면 실행기가 RID 대신 "클러스터드 키"로 행을 다루게 갈아엎어야 하는데(보조 인덱스·조인·VACUUM의 RID 가정 전부), 그건 별도 큰 작업이에요. 이 편은 그 큰 결정을 하기 전에 **"과연 얼마나 다른가"를 숫자로 먼저 확인**한 셈이고요.

## 7. 정리

| 항목 | db-hobby | 비고 |
|---|---|---|
| 힙 모델 (PG식, 인덱스->RID->힙) | O | 엔진의 실제 저장 방식(1~22편) |
| 클러스터드 모델 (InnoDB식) | O | 벤치·비교 모듈로 |
| PK 점 조회·범위 대조 | O | 클러스터드 1.2배·3.8배 (지역성) |
| 보조 이중 조회 대조 | O | 클러스터드 2배 느림 재현 |
| 엔진에 CLUSTERED 모드 배선 | X | 실행기 RID 가정 재작성 = 큰 작업 |

이 편은 [1편](/blog/project/db-hobby/db-hobby-1-storage)에서 고른 "힙"이라는 정체성을, 그 반대편(InnoDB 클러스터드)과 나란히 재봄으로써 **왜 그 선택이 그런 성능 성격을 갖는지** 숫자로 이해했어요. 좋은 엔지니어링 판단은 "무엇이 옳다"가 아니라 "무엇을 얻고 무엇을 포기하는가"를 아는 거고, 이 벤치가 그 트레이드오프를 손에 쥐여 줍니다.

db-hobby는 이제 저장(힙·클러스터드 대조)·인덱스·SQL·WAL(steal/no-force)·MVCC(스냅샷)·VACUUM·다중 트랜잭션·psql 서버·스레드 안전(버퍼 풀 latch·B+Tree crabbing)·비용 기반 옵티마이저까지, 진짜 DB의 거의 모든 축을 한 번씩 손으로 만져 봤습니다.

## 참고

- [MySQL Documentation: Clustered and Secondary Indexes (InnoDB)](https://dev.mysql.com/doc/refman/8.0/en/innodb-index-types.html)
- [PostgreSQL Documentation: CLUSTER (physical reordering)](https://www.postgresql.org/docs/current/sql-cluster.html)
- [Jeremy Cole: How does InnoDB behave without a Primary Key / clustered index layout](https://blog.jcole.us/2013/05/02/how-does-innodb-behave-without-a-primary-key/)
- 본 시리즈: [1편 저장(힙)](/blog/project/db-hobby/db-hobby-1-storage) · [3편 B+Tree](/blog/project/db-hobby/db-hobby-3-index-wal) · [22편 latch crabbing](/blog/project/db-hobby/db-hobby-22-latch-crabbing)

<!-- EN -->

## 0. Introduction — Two Giants' Opposite Choices

db-hobby has been a **PostgreSQL-style heap** since [Part 1](/blog/project/db-hobby/db-hobby-1-storage). Rows pile into a **heap file** in no order (insertion order), and indexes point at them by `RID = (page, slot)`. A lookup is two steps: "get the RID from the index → fetch that RID's row from the heap."

MySQL's **InnoDB chose the opposite** — a **clustered index**. It doesn't keep a separate heap; it stores data **directly in the PK B+Tree's leaves, in PK order**. And secondary indexes hold the **PK value**, not a RID. A lookup goes "secondary index → PK → data in the clustered index."

Same relational database, opposite storage philosophies at the root. Which is better? This part answers **with my own benchmark, not someone's claim** — building both over the same data and measuring side by side. It's the contrast ROADMAP noted: "PG-style vs MySQL-style, side by side in one codebase."

## 1. Standing the Two Structures Side by Side

`make bench-clustered` builds the same 40,000 rows two ways.

**Heap model (PostgreSQL-style)** — three structures:
```c
Heap  heap;      /* a heap file where rows pile in no order */
BTree pk_idx;    /* PK -> RID */
BTree sk_idx;    /* secondary key -> RID */
/* insert: */
heap_insert(&heap, row, &rid);      /* put the row in the heap, get a RID */
btree_insert(&pk_idx, key, rid_enc(rid));   /* the index points at a RID */
btree_insert(&sk_idx, seckey, rid_enc(rid));
```

**Clustered model (InnoDB-style)** — no heap:
```c
BTree clust;     /* PK -> row (data lives in the leaf) */
BTree csec;      /* secondary key -> PK (not a RID!) */
/* insert: */
btree_insert(&clust, key, row);     /* the row itself goes into the PK tree */
btree_insert(&csec, seckey, key);   /* the secondary holds the PK */
```

Both key differences are here — ① clustered keeps **data inside the PK leaf** (no heap), ② the secondary index holds a **PK, not a RID**. And to look like a real table, we **insert in shuffled order** — so the heap's physical order diverges from PK order (real tables scatter this way over time).

## 2. PK Point Lookup — Clustered Wins

Consider the cost of finding one `WHERE id = k`.

- **Heap**: descend the PK index to get a RID (1 tree) → fetch that RID's heap page (1 fetch). **Tree + heap fetch.**
- **Clustered**: descend the PK tree and **the row is already in the leaf** (1 tree). Done. **No heap fetch.**

```
PK point lookup    heap(PG) 0.249s   clustered 0.208s   → 1.20× faster
```

Clustered is **1.2× faster.** The data is attached to the index leaf, so no separate heap visit. "PK lookups are fastest in InnoDB" comes from this structure.

## 3. Secondary Point Lookup — Now Clustered Loses

But look up by a secondary column and the tables turn.

- **Heap**: secondary index → RID (1 tree) → heap fetch (1). **Same cost as the PK lookup** — in a heap, every index points at a RID, PK or secondary.
- **Clustered**: secondary index → **PK** (1 tree) → descend the **clustered index again** with that PK to reach the data (another tree). **Two tree traversals.**

```
Secondary point lookup  heap(PG) 0.249s   clustered 0.495s   → 0.50× (2× slower)
```

Clustered is **2× slower.** This is InnoDB's famous trait — **secondary index lookups always do a "double lookup" (secondary → PK → clustered).** Because the secondary index holds a PK (not the data's location), reaching the data means traversing the clustered index one more time.

> **Practical/interview note**: this is the answer to "why does an InnoDB secondary index contain the PK?" Because it's clustered — the data lives in the PK tree, so a secondary index must go through the PK to reach it. That's why **a long InnoDB PK makes every secondary index fat and slow** (each secondary stores the full PK). The tuning maxim "keep InnoDB PKs short" comes from this structure. PostgreSQL has no such trait — all its indexes point at RIDs (fixed size).

## 4. PK Range Scan — Clustered's Blowout

The most dramatic difference is range scans. Consider `WHERE id BETWEEN k AND k+200`.

- **Heap**: the PK index gives RIDs in PK order, but those RIDs point at heap rows on **scattered pages** (we inserted shuffled). 200 rows = 200 (nearly) random fetches. Exceed the buffer pool and cache misses explode.
- **Clustered**: rows sit in PK order **contiguously in the leaf chain.** A 200-row range clusters into **a few adjacent leaf pages.** Read them sequentially, done — peak locality.

```
PK range (200 rows)  heap(PG) 0.673s   clustered 0.177s   → 3.80× faster
```

**3.8×.** This is clustered's real weapon. "Data is physically contiguous in PK order" gives overwhelming locality for range scans, sorts, and PK-based joins. It's why InnoDB is strong on PK-ordered ranges — and another reason to "choose the InnoDB PK carefully" (the PK *is* the physical storage order).

![Heap (PG) vs clustered (InnoDB) — a heap scatters rows in a heap file and indexes point by RID (lookup = index→RID→heap). Clustered keeps data in the PK B+Tree leaves in PK order, and secondary indexes hold the PK (lookup = secondary→PK→data). PK point lookups and ranges favor clustered (locality); secondary point lookups favor heap (no double lookup)](/uploads/project/db-hobby/clustered-vs-heap.svg)

## 5. So — Not "Better" but "Optimized for What"

One benchmark sums it up (40,000 rows, shuffled load, 32 buffer frames per structure).

| Operation | Heap (PG) | Clustered (InnoDB) | Winner |
|---|---|---|---|
| PK point lookup | 0.249s | 0.208s | **clustered 1.2×** (no heap fetch) |
| Secondary point lookup | 0.249s | 0.495s | **heap 2×** (clustered double-lookups) |
| PK range (200 rows) | 0.673s | 0.177s | **clustered 3.8×** (locality) |

Neither wins everything. **The storage structure sets the trade-off:**

- **Clustered (InnoDB)** is strong on PK-centric access (point, range, PK joins) and pays a tax (double lookup) on secondary lookups. The PK *is* the physical order, so the PK choice governs performance.
- **Heap (PostgreSQL)** has all indexes point at RIDs equally, so **no secondary-index penalty**, balanced for index-heavy workloads. In exchange it gives up PK-range locality (hence PG's separate `CLUSTER` command to physically reorder).

Why "MySQL is faster / PostgreSQL is better" flips situation to situation is all in these three rows. **Run the benchmark yourself, and other people's benchmark wars just look like "which workload did you measure."**

## 6. An Honest Boundary — Built as a Benchmark/Comparison

Let me be honest. This clustered model is **not wired into the engine as a `CREATE TABLE ... CLUSTERED` mode.** It's a **benchmark/comparison** (`bench_clustered`, `test_clustered`) that **composes** the existing `btree.c`/`heap.c` primitives two ways. Same reasoning as [Part 22](/blog/project/db-hobby/db-hobby-22-latch-crabbing) — the **crux of the contrast (access-path cost) is fully revealed by composing structures**, and planting a new storage mode into the engine core would risk regressing 400+ existing tests.

So this isn't "InnoDB-style storage added as a first-class engine mode"; it's **the cost structure of two storage philosophies, measured side by side on the same primitive layer.** Making it a real mode would mean rewriting the executor to handle rows by "clustered key" instead of RID (every RID assumption in secondary indexes, joins, VACUUM) — a separate big job. This part **checked "how different is it really," in numbers, before making that big decision.**

## 7. Wrap-up

| Item | db-hobby | Note |
|---|---|---|
| Heap model (PG-style, index→RID→heap) | O | the engine's actual storage (Parts 1–22) |
| Clustered model (InnoDB-style) | O | as a benchmark/comparison |
| PK point/range contrast | O | clustered 1.2×/3.8× (locality) |
| Secondary double-lookup contrast | O | clustered 2× slower reproduced |
| CLUSTERED mode wired into the engine | X | rewriting the executor's RID assumptions = a big job |

This part took the "heap" identity chosen in [Part 1](/blog/project/db-hobby/db-hobby-1-storage) and measured it against its opposite (InnoDB clustered), understanding **why that choice has the performance character it does** — in numbers. Good engineering judgment isn't "what's right" but "what you gain and what you give up," and this benchmark puts that trade-off in hand.

db-hobby has now touched, by hand, nearly every axis of a real database: storage (heap vs clustered), indexing, SQL, WAL (steal/no-force), MVCC (snapshots), VACUUM, multi-transaction, a psql server, thread safety (buffer pool latch, B+Tree crabbing), and a cost-based optimizer.

## References

- [MySQL Documentation: Clustered and Secondary Indexes (InnoDB)](https://dev.mysql.com/doc/refman/8.0/en/innodb-index-types.html)
- [PostgreSQL Documentation: CLUSTER (physical reordering)](https://www.postgresql.org/docs/current/sql-cluster.html)
- [Jeremy Cole: How does InnoDB behave without a Primary Key](https://blog.jcole.us/2013/05/02/how-does-innodb-behave-without-a-primary-key/)
- This series: [Part 1 Storage (heap)](/blog/project/db-hobby/db-hobby-1-storage) · [Part 3 B+Tree](/blog/project/db-hobby/db-hobby-3-index-wal) · [Part 22 Latch Crabbing](/blog/project/db-hobby/db-hobby-22-latch-crabbing)

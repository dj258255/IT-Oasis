---
title: '플래너가 멍청한 순간 — 규칙 기반에서 비용 기반 옵티마이저로'
titleEn: 'When the Planner Is Dumb — From Rule-Based to a Cost-Based Optimizer'
description: "지금까지 db-hobby의 플래너는 규칙 하나로 움직였다: 'PK 조건이면 무조건 인덱스.' 그런데 id > 100처럼 테이블의 90%가 매칭되는 넓은 범위엔, 인덱스 범위 스캔이 행마다 랜덤 힙 페치를 하느라 그냥 전부 훑는 순차 스캔보다 훨씬 느리다. 규칙 기반 플래너는 이걸 모른 채 인덱스를 고른다. 이 편은 그 '멍청한 순간'을 진짜 옵티마이저로 고친다: ANALYZE로 행 수·PK 범위 통계를 재고, WHERE 조건의 선택도로 매칭 행 수를 추정하고, 순차(=페이지 수) vs 인덱스(=1+매칭 행수의 랜덤 페치) 비용을 비교해 싼 쪽을 고른다. id=5는 점 조회, id>999는 인덱스, id>100은 순차 — 크로스오버가 실제로 갈리는 걸 EXPLAIN의 rows=.. cost=.. 로 보인다. PostgreSQL의 random_page_cost 직관이 왜 그렇게 생겼는지까지."
descriptionEn: "Until now db-hobby's planner ran on one rule: 'if it's a PK condition, always use the index.' But for a wide range like id > 100 that matches 90% of the table, an index range scan does a random heap fetch per row and is far slower than just scanning everything sequentially. The rule-based planner picks the index anyway, oblivious. This part fixes that 'dumb moment' with a real optimizer: ANALYZE gathers row-count and PK-range stats, selectivity on the WHERE predicate estimates the matched rows, and we compare sequential cost (= page count) vs index cost (= 1 + a random fetch per matched row) and pick the cheaper. id=5 is a point lookup, id>999 uses the index, id>100 goes sequential — the crossover actually flips, shown via EXPLAIN's rows=.. cost=... Including why PostgreSQL's random_page_cost intuition looks the way it does."
date: 2026-07-03
tags:
  - C
  - Database Internals
  - Query Optimizer
  - Cost Model
  - EXPLAIN
  - PostgreSQL
  - Learning
category: study/db-hobby
coverImage: /uploads/project/db-hobby/cover.svg
draft: false
series: "db-hobby"
seriesOrder: 21
---

## 0. 들어가며 — 인덱스가 항상 정답은 아니다

db-hobby는 [3편](/blog/project/db-hobby/db-hobby-3-index-wal)부터 B+Tree 인덱스가 있었고, 플래너는 규칙 하나로 움직였어요: **"WHERE가 PK(첫 컬럼) 조건이면 인덱스를 쓴다."** `id = 5`도, `id > 100`도, `id < 999`도 전부 인덱스. 8편의 EXPLAIN이 그 결정을 그대로 출력했죠.

그런데 이 규칙엔 **틀리는 순간**이 있습니다. "인덱스가 항상 빠르다"는 건 흔한 오해예요. 이번 편은 그 오해를 db-hobby 안에서 직면하고, 진짜 옵티마이저처럼 **통계로 비용을 매겨** 고치게 만듭니다.

## 1. 장애 — 넓은 범위에 인덱스를 쓰면 오히려 느리다

`id > 100`을 생각해 보세요. 1000행짜리 테이블이면 **901행이 매칭**됩니다. 규칙 기반 플래너는 인덱스 범위 스캔을 골라요. 그게 왜 나쁘냐면:

- **인덱스 범위 스캔**은 리프 체인을 따라가며 매칭된 RID를 하나씩 얻고, **RID마다 힙에서 그 행을 읽습니다**. 901개 행이 여기저기 흩어진 페이지에 있으니, 901번의 (사실상 랜덤한) 페이지 접근이에요.
- **순차 스캔**은 그냥 힙의 모든 페이지를 처음부터 끝까지 읽습니다. 1000행이 7페이지에 담겨 있으면 **7번의 순차 접근**이면 끝나요.

901번 랜덤 vs 7번 순차 — 순차가 압도적으로 쌉니다. 그런데 규칙 기반 플래너는 "PK 조건 = 인덱스"만 보고 **901번 랜덤을 고릅니다.** 이게 플래너가 멍청해지는 순간이에요.

> **직관**: 인덱스는 "바늘 찾기"(적은 행을 콕 집을 때)엔 최고지만, "건초 대부분을 가져오기"(넓은 범위)엔 독입니다. 페치할 행이 페이지 수보다 많아지는 순간, 순차 스캔이 이겨요. 이게 PostgreSQL의 `random_page_cost`(랜덤 접근은 순차보다 비싸다)가 담고 있는 바로 그 지혜입니다.

## 2. 재료 1 — ANALYZE, 통계를 재다

비용을 매기려면 먼저 **데이터를 알아야** 합니다. 규칙 기반 플래너가 멍청한 건 데이터를 안 보기 때문이에요. 그래서 `ANALYZE` 명령을 추가했습니다 — 테이블을 훑어 옵티마이저가 쓸 통계를 카탈로그에 기록합니다(PostgreSQL의 `pg_statistic` 축소판).

```c
static void analyze_table(Database *db, Table *t) {
    AnalyzeCtx c = {db, &t->schema, 0, 0, 0, 0};
    heap_scan(&t->heap, analyze_visit, &c);   /* 보이는 행만 세고 PK min/max 추적 */
    t->stat_rows  = c.rows;                    /* 행 수 */
    t->stat_pages = t->wal.data.num_pages;     /* 힙 페이지 수 (순차 비용 단위) */
    t->stat_pk_min = c.pk_min;                 /* PK 최소/최대 (범위 선택도용) */
    t->stat_pk_max = c.pk_max;
    t->stat_valid = 1;
}
```

세 가지를 잽니다: **행 수**, **페이지 수**(순차 스캔의 비용), **PK의 최소·최대값**(범위 선택도 추정용). 그리고 `analyze_visit`은 [16편](/blog/project/db-hobby/db-hobby-16-delete-xmax)의 가시성 게이트를 지나 **보이는 행만** 셉니다 — 죽은 버전은 통계에서 빠져요([17편](/blog/project/db-hobby/db-hobby-17-vacuum) VACUUM 전이라도 정확한 추정이 나오게). 통계는 카탈로그에 영속화돼 재오픈 후에도 유지됩니다.

```
db-hobby> ANALYZE t;
ANALYZE t: 행 1000 · 페이지 7 · PK 범위 [1, 1000]
```

## 3. 재료 2 — 선택도, 몇 행이나 맞을까

이제 `id > 100`이 **몇 행을 잡을지 추정**합니다. 이게 **선택도(selectivity)** 예요. PK 값이 `[min, max]`에 대략 고르게 퍼져 있다고 보면(균등분포 가정), 범위가 그 구간에서 차지하는 비율이 곧 매칭 비율입니다.

```c
/* id > v 의 선택도 = (max - v) / (max - min) */
static int64_t est_pk_range_rows(const Table *t, CmpOp op, long v) {
    double lo = t->stat_pk_min, hi = t->stat_pk_max, span = hi - lo;
    double f = (op == CMP_GT || op == CMP_GE) ? (hi - v) / span   /* > 는 위쪽 */
                                              : (v - lo) / span;  /* < 는 아래쪽 */
    if (f < 0) f = 0; if (f > 1) f = 1;
    return (int64_t)(t->stat_rows * f + 0.5);  /* 비율 × 전체 행 수 */
}
```

`id > 100`이면 f = (1000-100)/(1000-1) ≈ 0.9 → **약 901행**. `id > 999`면 f ≈ 0.001 → **약 1행**. 같은 "PK 범위 조건"인데 잡는 양이 900배 차이 나요 — 규칙 기반은 이 차이를 아예 안 봤습니다.

> **정직한 한계**: 이건 **균등분포 가정**입니다. 실제 데이터가 한쪽에 몰려 있으면(예: id가 1~100에 990개, 나머지 900개 구간에 10개) 추정이 빗나가요. 진짜 옵티마이저는 **히스토그램**(구간별 빈도)으로 이 편향을 잡습니다. db-hobby는 우선 min/max 균등분포로 시작했고, 히스토그램은 조인 순서(다음 편)와 함께 얹을 자리예요.

## 4. 재료 3 — 비용, 그래서 어느 게 싼가

행 수를 추정했으니 이제 **비용**을 매깁니다. 단순하지만 핵심을 담은 모델이에요.

```c
static double cost_seq(const Table *t) { return t->stat_pages; }      /* 순차 = 페이지 수 */
static double cost_idx_range(int64_t est_rows) { return 1.0 + est_rows; } /* 인덱스 = 하강 1 + 랜덤 페치 */
```

- **순차 스캔** = 페이지 수. 모든 페이지를 순서대로 한 번씩 읽으니까(7페이지 = 비용 7).
- **인덱스 범위 스캔** = 1(트리 하강) + 매칭 행 수(행마다 랜덤 힙 페치 ≈ 페이지 1개). 901행이면 비용 902.

그리고 **싼 쪽을 고릅니다.**

```c
static int choose_pk_range(const Table *t, CmpOp op, long v, ...) {
    if (!t->stat_valid) return 1;              /* ANALYZE 안 했으면 옛 규칙(인덱스) */
    int64_t er = est_pk_range_rows(t, op, v);
    return cost_idx_range(er) < cost_seq(t) ? 1 : 0;  /* 인덱스가 싸면 1, 아니면 순차 */
}
```

`exec_select`(실행)와 `explain_single`(EXPLAIN)이 **같은** `choose_pk_range`를 부릅니다 — 실행과 설명이 절대 어긋나지 않게. 8편에서 세운 "EXPLAIN은 실행기와 같은 결정 로직을 쓴다"는 원칙 그대로예요.

## 5. 그래서 — 크로스오버가 실제로 갈린다

ANALYZE를 돌린 뒤 EXPLAIN을 보면, **같은 PK 범위 조건이 매칭 양에 따라 다른 계획으로** 갈립니다.

```
db-hobby> EXPLAIN SELECT * FROM t WHERE id = 5;
Index Point Lookup on t using id  (id = 5)  rows=1 cost=1

db-hobby> EXPLAIN SELECT * FROM t WHERE id > 999;
Index Range Scan on t using id  (id > 999)  rows=1 cost=2

db-hobby> EXPLAIN SELECT * FROM t WHERE id > 100;
Seq Scan on t  (filter: id > 100)  rows=901 cost=7  [비용 기반: 인덱스보다 쌈]
```

- `id = 5` → 1행 → **점 조회** (cost 1).
- `id > 999` → 1행 → **인덱스 범위 스캔** (cost 2 < 순차 7).
- `id > 100` → 901행 → **순차 스캔** (인덱스면 cost 902 ≫ 순차 7).

세 번째가 이 편의 핵심이에요. **규칙 기반이라면 인덱스를 골랐을 자리**에서, 비용 모델이 "901번 랜덤보다 7번 순차가 싸다"를 계산해 순차를 고릅니다. `[비용 기반: 인덱스보다 쌈]` 표시가 그 판단을 드러내요. 그리고 어느 경로를 타든 **결과는 똑같습니다** — 옵티마이저는 *어떻게* 가느냐만 바꾸지 *무엇이* 나오느냐는 안 바꾸니까(`test_optimizer`가 인덱스 경로·순차 경로의 결과 행 수가 같음을 검증).

`ANALYZE`를 안 했을 땐? 통계가 없으니 **옛 규칙(무조건 인덱스)으로 안전하게 폴백**합니다 — 통계 없이 비용을 지어내지 않아요. 그리고 데이터가 바뀌면(`DELETE`로 대부분 삭제 등) 다시 `ANALYZE`해서 통계를 갱신합니다. PostgreSQL의 autovacuum이 통계도 같이 갱신하는 이유죠.

> **실무/면접 포인트**: "인덱스를 걸었는데 왜 안 타요?"의 절반은 이 이야기입니다. 옵티마이저가 통계를 보고 "이 쿼리는 테이블 대부분을 읽으니 순차가 싸다"고 판단해 **일부러 인덱스를 안 쓴** 거예요. 그리고 "통계가 오래돼서(ANALYZE 안 함) 플래너가 오판한다"가 나머지 절반이고요. `EXPLAIN`의 `rows=` 추정치가 실제와 크게 다르면 그게 통계 문제의 신호입니다.

![비용 기반 옵티마이저 — ANALYZE가 행 수·페이지 수·PK[min,max]를 재고, WHERE의 선택도로 매칭 행 수를 추정한다. 순차 비용(페이지 수) vs 인덱스 비용(1+매칭 행수의 랜덤 페치)을 비교해 싼 쪽을 고른다. id=5는 점 조회, 좁은 범위는 인덱스, 넓은 범위는 순차 — 페치할 행이 페이지 수를 넘는 지점에서 크로스오버](/uploads/project/db-hobby/cost-optimizer.svg)

## 6. 정리 — 그리고 다음

| 항목 | db-hobby | 비고 |
|---|---|---|
| ANALYZE (행·페이지·PK 범위) | O | 카탈로그 영속화, 보이는 행만 |
| 범위 선택도 → 매칭 행 수 추정 | O | min/max 균등분포 가정 |
| 비용으로 인덱스 vs 순차 선택 | O | 순차=페이지, 인덱스=1+랜덤 페치 |
| EXPLAIN에 `rows= cost=` | O | 실행과 같은 결정 공유 |
| 히스토그램 (편향 데이터) | X | 균등분포 넘어서기 — 다음 |
| 비용 기반 조인 순서 (System R DP) | X | N-way 조인 순서 탐색 — 다음 |

규칙 기반 플래너의 "PK면 무조건 인덱스"라는 멍청한 순간을, 통계+선택도+비용으로 고쳤습니다. 이제 db-hobby는 *데이터를 보고* 접근 방법을 골라요. 8편에서 "규칙으로 고른다"던 플래너가, 21편에서 "비용으로 고른다"로 자랐습니다.

남은 큰 조각은 **조인 순서**예요. 지금 N-way 조인은 "선언한 순서대로 왼쪽부터" 묶는데, 진짜 옵티마이저는 **System R식 동적 계획법**으로 모든 순서·방법 조합의 비용을 매겨 최소를 찾습니다 — 3-테이블 조인에서 어느 걸 먼저 묶느냐로 성능이 수십 배 갈리거든요. 그때 히스토그램(편향 데이터의 정확한 카디널리티)도 함께 필요해집니다. 그게 트랙 F의 다음 산입니다.

## 참고

- [PostgreSQL Documentation: Row Estimation Examples (selectivity, statistics)](https://www.postgresql.org/docs/current/row-estimation-examples.html)
- [PostgreSQL Documentation: Planner Cost Constants (random_page_cost)](https://www.postgresql.org/docs/current/runtime-config-query.html)
- [Selinger et al., "Access Path Selection in a Relational Database Management System" (System R, 1979)](https://dl.acm.org/doi/10.1145/582095.582099)
- 본 시리즈: [3편 B+Tree 인덱스](/blog/project/db-hobby/db-hobby-3-index-wal) · [8편 EXPLAIN](/blog/project/db-hobby/db-hobby-8-explain) · [16편 가시성 게이트](/blog/project/db-hobby/db-hobby-16-delete-xmax)

<!-- EN -->

## 0. Introduction — the Index Isn't Always the Answer

db-hobby has had a B+Tree index since [Part 3](/blog/project/db-hobby/db-hobby-3-index-wal), and the planner ran on one rule: **"if the WHERE is a PK (first-column) condition, use the index."** `id = 5`, `id > 100`, `id < 999` — all index. Part 8's EXPLAIN printed exactly that decision.

But this rule has a **moment where it's wrong**. "The index is always faster" is a common misconception. This part faces that misconception inside db-hobby and fixes it the way a real optimizer does — by **pricing choices with statistics**.

## 1. The Failure — Using the Index on a Wide Range Is Slower

Consider `id > 100`. On a 1000-row table, **901 rows match**. The rule-based planner picks an index range scan. Why that's bad:

- An **index range scan** walks the leaf chain, gets matched RIDs one by one, and **reads each row from the heap by RID**. With 901 rows scattered across pages, that's 901 (effectively random) page accesses.
- A **sequential scan** just reads every heap page front to back. If 1000 rows fit in 7 pages, that's **7 sequential accesses**, done.

901 random vs 7 sequential — sequential wins overwhelmingly. Yet the rule-based planner sees only "PK condition = index" and **picks the 901 random accesses.** That's the moment the planner turns dumb.

> **Intuition**: an index is best for "finding a needle" (pinpointing a few rows) but poison for "hauling most of the haystack" (a wide range). The moment the rows you'd fetch exceed the page count, the sequential scan wins. This is exactly the wisdom in PostgreSQL's `random_page_cost` (random access costs more than sequential).

## 2. Ingredient 1 — ANALYZE, Measuring the Statistics

To price things, you first have to **know the data**. The rule-based planner is dumb because it doesn't look at the data. So we added an `ANALYZE` command — it scans a table and records statistics the optimizer will use, into the catalog (a miniature of PostgreSQL's `pg_statistic`).

```c
static void analyze_table(Database *db, Table *t) {
    AnalyzeCtx c = {db, &t->schema, 0, 0, 0, 0};
    heap_scan(&t->heap, analyze_visit, &c);   /* count only visible rows, track PK min/max */
    t->stat_rows  = c.rows;                    /* row count */
    t->stat_pages = t->wal.data.num_pages;     /* heap page count (unit of sequential cost) */
    t->stat_pk_min = c.pk_min;                 /* PK min/max (for range selectivity) */
    t->stat_pk_max = c.pk_max;
    t->stat_valid = 1;
}
```

Three things: the **row count**, the **page count** (the cost of a sequential scan), and the **PK min and max** (for range selectivity). And `analyze_visit` passes [Part 16](/blog/project/db-hobby/db-hobby-16-delete-xmax)'s visibility gate to count **only visible rows** — dead versions are excluded from stats (so estimates stay accurate even before [Part 17](/blog/project/db-hobby/db-hobby-17-vacuum)'s VACUUM). The stats persist in the catalog and survive a reopen.

```
db-hobby> ANALYZE t;
ANALYZE t: rows 1000 · pages 7 · PK range [1, 1000]
```

## 3. Ingredient 2 — Selectivity, How Many Rows Will Match

Now we **estimate how many rows `id > 100` catches**. That's **selectivity**. Assuming PK values are spread roughly evenly across `[min, max]` (a uniform-distribution assumption), the fraction of that span the range covers is the match fraction.

```c
/* selectivity of id > v = (max - v) / (max - min) */
static int64_t est_pk_range_rows(const Table *t, CmpOp op, long v) {
    double lo = t->stat_pk_min, hi = t->stat_pk_max, span = hi - lo;
    double f = (op == CMP_GT || op == CMP_GE) ? (hi - v) / span   /* > is the upper part */
                                              : (v - lo) / span;  /* < is the lower part */
    if (f < 0) f = 0; if (f > 1) f = 1;
    return (int64_t)(t->stat_rows * f + 0.5);  /* fraction × total rows */
}
```

For `id > 100`, f = (1000-100)/(1000-1) ≈ 0.9 → **about 901 rows**. For `id > 999`, f ≈ 0.001 → **about 1 row**. Same "PK range condition," but a 900× difference in how much it catches — a difference the rule-based planner never looked at.

> **Honest limitation**: this is a **uniform-distribution assumption**. If the real data is skewed (say 990 of the ids in 1–100 and only 10 in the rest), the estimate misses. A real optimizer catches that skew with a **histogram** (per-bucket frequencies). db-hobby starts with min/max uniform; the histogram is the slot to add alongside join ordering (next part).

## 4. Ingredient 3 — Cost, So Which Is Cheaper

With rows estimated, we price the **cost**. A simple model, but it captures the essence.

```c
static double cost_seq(const Table *t) { return t->stat_pages; }         /* seq = page count */
static double cost_idx_range(int64_t est_rows) { return 1.0 + est_rows; } /* index = descent 1 + random fetches */
```

- **Sequential scan** = page count. Read every page once, in order (7 pages = cost 7).
- **Index range scan** = 1 (tree descent) + matched rows (a random heap fetch ≈ one page each). 901 rows → cost 902.

And we **pick the cheaper**.

```c
static int choose_pk_range(const Table *t, CmpOp op, long v, ...) {
    if (!t->stat_valid) return 1;              /* not ANALYZEd -> old rule (index) */
    int64_t er = est_pk_range_rows(t, op, v);
    return cost_idx_range(er) < cost_seq(t) ? 1 : 0;  /* 1 if index is cheaper, else sequential */
}
```

`exec_select` (execution) and `explain_single` (EXPLAIN) call the **same** `choose_pk_range` — so execution and explanation can never disagree. Exactly Part 8's principle: "EXPLAIN uses the same decision logic as the executor."

## 5. So — the Crossover Actually Flips

After running ANALYZE, EXPLAIN shows the **same PK range condition splitting into different plans by how much it matches**.

```
db-hobby> EXPLAIN SELECT * FROM t WHERE id = 5;
Index Point Lookup on t using id  (id = 5)  rows=1 cost=1

db-hobby> EXPLAIN SELECT * FROM t WHERE id > 999;
Index Range Scan on t using id  (id > 999)  rows=1 cost=2

db-hobby> EXPLAIN SELECT * FROM t WHERE id > 100;
Seq Scan on t  (filter: id > 100)  rows=901 cost=7  [cost-based: cheaper than the index]
```

- `id = 5` → 1 row → **point lookup** (cost 1).
- `id > 999` → 1 row → **index range scan** (cost 2 < sequential 7).
- `id > 100` → 901 rows → **sequential scan** (index would be cost 902 ≫ sequential 7).

The third is this part's heart. **Where the rule would have picked the index**, the cost model computes "7 sequential beats 901 random" and picks sequential. The `[cost-based: cheaper than the index]` tag reveals that judgment. And whichever path it takes, the **result is identical** — an optimizer changes *how* you go, never *what* comes out (`test_optimizer` checks the index path and sequential path return the same row count).

What if you didn't ANALYZE? With no stats, it **safely falls back to the old rule (always index)** — it never invents a cost without data. And when the data changes (e.g. `DELETE` most rows), you `ANALYZE` again to refresh. That's why PostgreSQL's autovacuum refreshes statistics too.

> **Practical/interview note**: half of "I added an index, why isn't it used?" is this story. The optimizer looked at the stats and judged "this query reads most of the table, so sequential is cheaper" and **deliberately skipped the index.** The other half is "stats are stale (no ANALYZE), so the planner misjudges." When `EXPLAIN`'s `rows=` estimate is far off from reality, that's the signal of a stats problem.

![Cost-based optimizer — ANALYZE gathers row count, page count, and PK[min,max]; the WHERE's selectivity estimates matched rows. Compare sequential cost (page count) vs index cost (1 + a random fetch per matched row) and pick the cheaper. id=5 is a point lookup, a narrow range uses the index, a wide range goes sequential — the crossover is where fetched rows exceed the page count](/uploads/project/db-hobby/cost-optimizer.svg)

## 6. Wrap-up — and What's Next

| Item | db-hobby | Note |
|---|---|---|
| ANALYZE (rows, pages, PK range) | O | persisted in catalog; visible rows only |
| Range selectivity → matched-row estimate | O | min/max uniform assumption |
| Cost picks index vs sequential | O | seq=pages, index=1+random fetches |
| EXPLAIN with `rows= cost=` | O | shares the executor's decision |
| Histogram (skewed data) | X | beyond uniform — next |
| Cost-based join ordering (System R DP) | X | N-way join order search — next |

We fixed the rule-based planner's dumb moment — "PK means always index" — with statistics, selectivity, and cost. Now db-hobby picks its access method *by looking at the data*. The planner that "chose by rule" in Part 8 grew into one that "chooses by cost" in Part 21.

The big remaining piece is **join ordering**. The N-way join currently binds "left to right in declaration order," but a real optimizer prices every order-and-method combination with **System R-style dynamic programming** and finds the minimum — because in a 3-table join, which you bind first can swing performance by tens of times. That's where the histogram (accurate cardinality on skewed data) becomes necessary too. That's Track F's next mountain.

## References

- [PostgreSQL Documentation: Row Estimation Examples (selectivity, statistics)](https://www.postgresql.org/docs/current/row-estimation-examples.html)
- [PostgreSQL Documentation: Planner Cost Constants (random_page_cost)](https://www.postgresql.org/docs/current/runtime-config-query.html)
- [Selinger et al., "Access Path Selection in a Relational Database Management System" (System R, 1979)](https://dl.acm.org/doi/10.1145/582095.582099)
- This series: [Part 3 B+Tree Index](/blog/project/db-hobby/db-hobby-3-index-wal) · [Part 8 EXPLAIN](/blog/project/db-hobby/db-hobby-8-explain) · [Part 16 Visibility Gate](/blog/project/db-hobby/db-hobby-16-delete-xmax)

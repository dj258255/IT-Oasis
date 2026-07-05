---
title: 'DB 내부 ⑥: 비용 기반 옵티마이저 — 플래너가 멍청해지는 순간을 통계로 고치기'
titleEn: 'DB Internals ⑥: The Cost-Based Optimizer — Fixing the Planner''s Stupid Moments with Statistics'
description: "'인덱스가 있으면 무조건 쓴다'는 규칙은 id > 100 앞에서 무너진다 — 901번의 랜덤 힙 페치가 7페이지 순차 스캔보다 백 배 비싸니까. 비용 기반 최적화(CBO)의 세 재료를 순서대로 짓는다: ANALYZE(행 수·페이지 수·PK min/max를 재는 통계), 선택도(균등분포 가정으로 매칭 행 수 추정 — 히스토그램이 필요한 이유까지), 비용 모델(순차 = 페이지 수, 인덱스 = 1 + 매칭 행수의 랜덤 페치). 그러면 같은 PK 범위 조건이 매칭 양에 따라 점 조회/인덱스/순차로 갈리는 크로스오버가 실제로 나타난다 — '인덱스를 걸었는데 왜 안 타요?'의 정답. 후반부는 다중 테이블의 진짜 고민, 조인 순서다: 순서 하나가 2.8배를 가르고, n!을 2ⁿ으로 줄이는 Selinger의 부분집합 DP(1979), 교차곱을 피하는 연결성 규칙, 조인 방법(인덱스 NLJ vs 해시)까지 한 번에 고르는 계획기를 짓는다. EXPLAIN이 실행기와 같은 결정 함수를 공유해 '플랜이 거짓말하지 않는' 원칙도 함께."
descriptionEn: "The rule 'use an index whenever you can' collapses at id > 100 — 901 random heap fetches cost a hundred times more than a 7-page sequential scan. We build the three ingredients of cost-based optimization in order: ANALYZE (statistics — row count, page count, PK min/max), selectivity (estimating matching rows under a uniformity assumption — and why histograms exist), and a cost model (seq = pages; index = 1 + one random fetch per matching row). Then the crossover appears for real: the same PK-range predicate resolves to point lookup / index scan / seq scan depending on how much it matches — the true answer to 'why isn't my index being used?'. The second half is the real multi-table agony, join ordering: one ordering decides 2.8×, Selinger's subset DP (1979) turns n! into 2ⁿ, a connectivity rule avoids Cartesian products, and the planner picks the join method (index NLJ vs hash) at each step. Plus the principle that EXPLAIN shares the executor's exact decision function — so the plan never lies."
date: 2026-07-05T00:00:00.000Z
tags:
  - Database Internals
  - Query Optimizer
  - EXPLAIN
  - Selinger
  - PostgreSQL
  - C
category: project/db-hobby
coverImage: /uploads/project/db-hobby/cover.svg
draft: false
series: "미니 DB로 이해하는 DB 내부"
seriesOrder: 6
---

## 0. 들어가며 — 플래너가 멍청해지는 순간

[2편](/blog/project/db-hobby/db-internals-02-btree-index)의 플래너는 규칙 하나였어요 — "PK 조건이면 인덱스를 쓴다." 이 규칙 기반(RBO)이 언제 틀리는지, 그리고 그걸 통계와 비용으로 고치는 **비용 기반 최적화(CBO)** 가 이 편의 주제입니다. 후반부엔 다중 테이블의 진짜 고민 — **조인 순서**까지.

그 전에 도구 하나. 옵티마이저를 이야기하려면 그 결정을 **보이게** 만들어야 해요. 그게 `EXPLAIN`입니다. db-hobby의 EXPLAIN엔 원칙이 하나 있어요:

> **플랜은 거짓말하지 않는다** — EXPLAIN은 결정을 *추정*해서 출력하는 게 아니라, 실행기가 쓰는 **같은 결정 함수를 호출**해서 출력한다. EXPLAIN이 "Index Scan"이라 말하면 실행기도 반드시 그 인덱스를 쓴다. 둘이 같은 코드를 보니까.

실행과 설명이 어긋나는 순간 EXPLAIN은 쓸모가 없어져요. 이 원칙은 이 편 내내 지켜집니다.

## 1. 장애 — 넓은 범위에 인덱스를 쓰면 오히려 느리다

`id > 100`을 생각해 보세요. 1000행 테이블이면 **901행이 매칭**됩니다. 규칙 기반 플래너는 인덱스 범위 스캔을 골라요. 그게 왜 나쁘냐면:

- **인덱스 범위 스캔**은 리프 체인에서 매칭 RID를 하나씩 얻고, **RID마다 힙에서 행을 읽습니다.** 901개 행이 흩어진 페이지에 있으니 901번의 (사실상 랜덤한) 페이지 접근.
- **순차 스캔**은 힙의 모든 페이지를 처음부터 끝까지. 1000행이 7페이지면 **7번의 순차 접근**이면 끝.

901번 랜덤 vs 7번 순차 — 순차가 압도적으로 쌉니다. 그런데 규칙은 "PK 조건 = 인덱스"만 보고 901번 랜덤을 고릅니다.

> **직관**: 인덱스는 "바늘 찾기"(적은 행을 콕 집기)엔 최고지만, "건초 대부분을 가져오기"(넓은 범위)엔 독이다. **페치할 행이 페이지 수보다 많아지는 순간 순차가 이긴다.** PostgreSQL의 `random_page_cost`(랜덤 접근은 순차보다 비싸다)가 담고 있는 바로 그 지혜다.

## 2. 세 가지 재료 — 통계, 선택도, 비용

### 재료 1 — ANALYZE: 데이터를 잰다

규칙 기반이 멍청한 건 **데이터를 안 보기** 때문이에요. `ANALYZE`가 테이블을 훑어 통계를 카탈로그에 기록합니다(PostgreSQL `pg_statistic`의 축소판): **행 수**, **페이지 수**(순차 비용의 단위), **PK min/max**(범위 선택도용). [4편](/blog/project/db-hobby/db-internals-04-mvcc)의 가시성 게이트를 지나 **보이는 행만** 세는 게 디테일 — 죽은 버전은 통계에서 빠져야 추정이 정확해요.

### 재료 2 — 선택도: 몇 행이나 맞을까

`id > 100`이 몇 행을 잡을지 **추정**합니다. PK 값이 `[min, max]`에 고르게 퍼져 있다고 보면(균등분포 가정), 범위가 차지하는 비율이 곧 매칭 비율:

```c
/* id > v 의 선택도 = (max - v) / (max - min) */
double f = (op == CMP_GT || op == CMP_GE) ? (hi - v) / span : (v - lo) / span;
est_rows = stat_rows * f;
```

`id > 100` → f ≈ 0.9 → 약 901행. `id > 999` → f ≈ 0.001 → 약 1행. **같은 "PK 범위 조건"인데 잡는 양이 900배 차이** — 규칙 기반은 이 차이를 아예 안 봤어요.

> **정직한 한계**: 균등분포 가정이다. 데이터가 한쪽에 몰려 있으면 추정이 빗나간다. 진짜 옵티마이저는 **히스토그램**(구간별 빈도)으로 이 편향을 잡는다 — PostgreSQL의 `pg_stats`에 있는 `histogram_bounds`가 그것.

### 재료 3 — 비용: 그래서 어느 게 싼가

```c
static double cost_seq(const Table *t)       { return t->stat_pages; }   /* 순차 = 페이지 수 */
static double cost_idx_range(int64_t rows)   { return 1.0 + rows; }      /* 인덱스 = 하강 1 + 랜덤 페치 */
```

그리고 **싼 쪽을 고릅니다.** 통계가 없으면(ANALYZE 안 함) 옛 규칙으로 안전하게 폴백해요 — 통계 없이 비용을 지어내지 않습니다.

## 3. 크로스오버 — 같은 조건, 다른 계획

ANALYZE 후 EXPLAIN을 보면, 같은 PK 범위 조건이 **매칭 양에 따라 다른 계획**으로 갈립니다.

```
db-hobby> EXPLAIN SELECT * FROM t WHERE id = 5;
Index Point Lookup on t using id  (id = 5)  rows=1 cost=1

db-hobby> EXPLAIN SELECT * FROM t WHERE id > 999;
Index Range Scan on t using id  (id > 999)  rows=1 cost=2

db-hobby> EXPLAIN SELECT * FROM t WHERE id > 100;
Seq Scan on t  (filter: id > 100)  rows=901 cost=7  [비용 기반: 인덱스보다 쌈]
```

![비용 기반 옵티마이저 — ANALYZE 통계와 선택도로 매칭 행 수를 추정하고, 순차 vs 인덱스 비용을 비교해 싼 쪽을 고른다. 크로스오버는 페치 행 수가 페이지 수를 넘는 지점](/uploads/project/db-hobby/cost-optimizer.svg)

세 번째 줄이 핵심이에요. 규칙 기반이라면 인덱스를 골랐을 자리에서, 비용 모델이 "901번 랜덤보다 7번 순차가 싸다"를 계산해 **일부러 인덱스를 안 씁니다.** 그리고 어느 경로든 **결과는 똑같아요** — 옵티마이저는 *어떻게* 가느냐만 바꾸지 *무엇이* 나오느냐는 안 바꿉니다(두 경로의 결과 동일성이 회귀 테스트).

> **실무/면접 포인트**: "인덱스를 걸었는데 왜 안 타요?"의 절반이 이 이야기다 — 옵티마이저가 통계를 보고 "이 쿼리는 대부분을 읽으니 순차가 싸다"고 판단한 것. 나머지 절반은 "통계가 오래돼(ANALYZE 안 됨) 플래너가 오판"이고. `EXPLAIN`의 `rows=` 추정치가 실제와 크게 다르면 그게 통계 문제의 신호다. 스캔 종류별 이론은 [DB 인덱스 ②: 스캔의 종류와 옵티마이저의 선택](/blog/theory/db-index-02-scan-types).

## 4. 조인 순서 — 순서 하나가 2.8배를 가른다

단일 테이블은 "인덱스냐 순차냐"가 전부지만, 다중 테이블에선 옵티마이저의 진짜 고민이 나옵니다 — **어느 순서로 조인하나.** 세 테이블 체인으로 보죠:

```
R0(1만 행) —[선택도 0.001]— R1(1천 행) —[선택도 0.01]— R2(10 행)
```

쿼리에 적힌 순서(R0부터)로 실행하면 큰 테이블끼리 먼저 만나 **중간 결과가 커지고**, 그걸 다음 단계가 또 처리해요. 반대로 **작은 R2부터** 붙이면 중간 결과가 100으로 작게 유지됩니다. 같은 결과, 같은 세 테이블 — **순서만 바꿔 비용이 2.8배** 줄어요(db-hobby 비용 모델 기준).

![순진한 좌→우 순서 vs Selinger DP — 작은 테이블부터 붙여 중간 결과를 작게 유지](/uploads/project/db-hobby/join-order-dp.svg)

> **조인 순서의 본질**: 최종 결과는 순서와 무관하지만, **중간 결과의 크기**는 순서가 정한다. 옵티마이저의 일은 중간 결과를 작게 유지하는 순서를 찾는 것.

### n!을 2ⁿ으로 — Selinger의 부분집합 DP

테이블 n개의 순서는 n!가지 — 10개면 360만, 12개면 4억 8천만. 다 해볼 수 없어요. 1979년 System R 논문에서 Patricia Selinger가 낸 답이 **부분집합 동적 계획법**입니다.

> "관계 집합 S를 조인하는 최적 계획"은, S에서 하나 뺀 부분집합의 최적 계획에 그 하나를 붙인 것들 중 가장 싼 것이다. — 최적 부분 구조.

부분집합을 **비트마스크**로 표현하면(`{R0,R2}` = `0b101`), 채울 칸이 n!이 아니라 **2ⁿ**개예요. 12개면 4억이 아니라 4096칸.

```c
for (int mask = 1; mask <= full; mask++) {       /* 증가하는 정수 순서 = 작은 집합부터 */
    for (int r = 0; r < n; r++) {
        if (mask & (1 << r)) continue;
        double ncost = dp_cost[mask] + join_step_cost(g, mask, r, ...);
        int nmask = mask | (1 << r);
        if (ncost < dp_cost[nmask]) {
            dp_cost[nmask] = ncost;
            dp_prev[nmask] = mask;                /* 역추적용 */
        }
    }
}
```

`mask`를 증가하는 정수 순서로 훑는 게 트릭이에요 — 어떤 부분집합(비트 하나 뺀 것)도 값이 더 작아 이미 확정돼 있으니, 위상 정렬이 필요 없습니다. 다 채운 뒤 `dp_prev`를 거꾸로 따라가면 최적 순서가 나와요.

### 품질을 가르는 두 규칙

DP 뼈대만으론 부족합니다.

- **교차곱을 피하라(연결성)** — 조인 술어가 없는 두 관계를 붙이면 중간 결과가 `|A|×|B|`로 터져요. 그래서 이미 조인된 집합에 **조인 간선으로 연결된 관계만** 다음 후보로 삼습니다(정말 분리된 그래프일 때만 교차곱을 허용하고 정직하게 표시).
- **방법까지 고른다** — 각 확장 단계에서 인덱스 NLJ(안쪽에 인덱스가 있으면 프로브 ≈ 1)와 해시 조인(빌드+프로브)의 비용을 비교해 **싼 방법**을 그 단계에 기록합니다. 순서와 방법이 한 DP에서 같이 정해져요.

검증은 성질로 합니다 — **"DP는 절대 순진한 좌→우 순서보다 나쁘지 않다"** 를 무작위 그래프 다수로 확인(같은 비용 모델에서 DP 비용 ≤ 순진 비용이 불변식).

> **정직한 경계**: 이 조인 순서 계획기는 독립 모듈이다 — 실행기에 배선하려면 다중 테이블 통계·중간 결과 카디널리티 추정이 실행기 쪽에 있어야 한다. 단일 테이블 CBO(2~3절)는 실행기에 배선돼 있고, 조인 순서는 뼈대의 증명까지. PostgreSQL은 이 DP를 `geqo_threshold`(기본 12) 테이블까지 쓰고, 그 이상은 유전 알고리즘(GEQO)으로 넘어간다 — 2ⁿ도 커지면 감당이 안 되니까.

## 5. 정리

- **EXPLAIN의 원칙**: 실행기와 같은 결정 함수를 공유 — 플랜은 거짓말하지 않는다.
- **규칙이 틀리는 지점**: 페치할 행 > 페이지 수면 순차가 이긴다(`random_page_cost`의 지혜). "인덱스를 걸었는데 왜 안 타요?"의 정답.
- **CBO의 세 재료**: ANALYZE(통계) → 선택도(균등분포 가정, 히스토그램은 그 다음) → 비용 비교. 통계 없으면 규칙으로 폴백.
- **조인 순서**: 중간 결과 크기가 전부다. Selinger DP가 n!을 2ⁿ으로, 연결성 규칙이 교차곱을 막고, 방법(NLJ vs 해시)까지 한 DP에서. PostgreSQL은 큰 조인에서 GEQO로 넘어간다.

다음 편은 저장 엔진의 세 철학 — **힙(PostgreSQL) vs 클러스터드(InnoDB) vs LSM(RocksDB)** 을 한 코드베이스에서 실측으로 대조합니다.

## 참고 (1차 자료 우선)

- P. G. Selinger et al., *Access Path Selection in a Relational Database Management System* (SIGMOD 1979) — System R 옵티마이저 논문
- [PostgreSQL Documentation: Planner/Optimizer](https://www.postgresql.org/docs/current/planner-optimizer.html)
- [PostgreSQL Documentation: Statistics Used by the Planner](https://www.postgresql.org/docs/current/planner-stats.html)
- [PostgreSQL Documentation: Genetic Query Optimizer](https://www.postgresql.org/docs/current/geqo.html)
- 본 블로그: [DB 인덱스 ①: EXPLAIN 읽기](/blog/theory/db-index-01-explain-basics) · [②: 스캔의 종류](/blog/theory/db-index-02-scan-types)
- [db-hobby 코드 (GitHub)](https://github.com/dj258255/db-hobby) — `db.c`(ANALYZE·비용 선택) · `joinopt.c`(Selinger DP)

<!-- EN -->

## 0. Introduction — the Planner's Stupid Moments

[Part 2](/blog/project/db-hobby/db-internals-02-btree-index)'s planner was one rule — "if there's a PK condition, use the index." When that rule-based (RBO) approach goes wrong, and how statistics and cost fix it — **cost-based optimization (CBO)** — is this part's subject. The second half tackles the real multi-table agony: **join ordering.**

One tool first. To discuss an optimizer you must make its decisions **visible** — that's `EXPLAIN`. db-hobby's EXPLAIN has one principle:

> **The plan never lies** — EXPLAIN doesn't *estimate* the decision; it **calls the same decision function** the executor uses. If EXPLAIN says "Index Scan," the executor necessarily uses that index. They read the same code.

The moment execution and explanation diverge, EXPLAIN is useless. This principle holds throughout.

## 1. The Failure — an Index on a Wide Range Is Slower

Consider `id > 100` on a 1,000-row table: **901 rows match.** The rule-based planner picks an index range scan. Why that's bad:

- An **index range scan** walks the leaf chain collecting RIDs, and **fetches the row from the heap per RID** — 901 effectively random page accesses.
- A **sequential scan** just reads every heap page front to back — 1,000 rows in 7 pages means **7 sequential accesses.**

901 random vs 7 sequential — sequential wins overwhelmingly. The rule looks only at "PK condition = index" and picks the 901 random fetches.

> **Intuition**: an index is superb for **finding needles** (picking few rows) and poison for **hauling most of the haystack** (wide ranges). **The moment rows-to-fetch exceeds the page count, sequential wins.** Exactly the wisdom encoded in PostgreSQL's `random_page_cost`.

## 2. Three Ingredients — Statistics, Selectivity, Cost

### Ingredient 1 — ANALYZE: measure the data

Rule-based planning is stupid because it **never looks at the data.** `ANALYZE` sweeps the table and records statistics in the catalog (a miniature of PostgreSQL's `pg_statistic`): **row count**, **page count** (the unit of sequential cost), and **PK min/max** (for range selectivity). A detail: it counts only rows passing [Part 4](/blog/project/db-hobby/db-internals-04-mvcc)'s visibility gate — dead versions must not pollute the stats.

### Ingredient 2 — selectivity: how many rows will match

Estimate how many rows `id > 100` catches. Assuming PK values spread uniformly over `[min, max]`, the fraction of the range is the match fraction:

```c
/* selectivity of id > v  =  (max - v) / (max - min) */
double f = (op == CMP_GT || op == CMP_GE) ? (hi - v) / span : (v - lo) / span;
est_rows = stat_rows * f;
```

`id > 100` → f ≈ 0.9 → ~901 rows. `id > 999` → f ≈ 0.001 → ~1 row. **The same kind of predicate, a 900× difference in rows caught** — which the rule never saw.

> **Honest limit**: this is a uniformity assumption; skewed data breaks the estimate. Real optimizers correct the skew with **histograms** — PostgreSQL's `histogram_bounds` in `pg_stats`.

### Ingredient 3 — cost: so which is cheaper

```c
static double cost_seq(const Table *t)       { return t->stat_pages; }   /* seq = page count */
static double cost_idx_range(int64_t rows)   { return 1.0 + rows; }      /* index = 1 descent + random fetches */
```

Then **pick the cheaper one.** With no statistics (no ANALYZE), fall back safely to the old rule — don't invent costs without data.

## 3. The Crossover — Same Predicate, Different Plans

After ANALYZE, EXPLAIN shows the same PK-range predicate resolving to **different plans by match volume**:

```
db-hobby> EXPLAIN SELECT * FROM t WHERE id = 5;
Index Point Lookup on t using id  (id = 5)  rows=1 cost=1

db-hobby> EXPLAIN SELECT * FROM t WHERE id > 999;
Index Range Scan on t using id  (id > 999)  rows=1 cost=2

db-hobby> EXPLAIN SELECT * FROM t WHERE id > 100;
Seq Scan on t  (filter: id > 100)  rows=901 cost=7  [cost-based: cheaper than the index]
```

![Cost-based optimizer — ANALYZE stats and selectivity estimate matching rows; seq vs index costs compared; the crossover sits where rows-to-fetch exceeds page count](/uploads/project/db-hobby/cost-optimizer.svg)

The third line is the point: where the rule would have chosen the index, the cost model computes "7 sequential beats 901 random" and **deliberately skips the index.** Either path returns **identical results** — the optimizer changes *how*, never *what* (result-equality across paths is the regression test).

> **Practical/interview point**: half of "I added an index, why isn't it used?" is this story — the optimizer read the statistics and decided a scan is cheaper. The other half is "stale statistics misled the planner." When `EXPLAIN`'s `rows=` estimate diverges wildly from reality, that's the signal. Scan-type theory: [DB Index ②](/blog/theory/db-index-02-scan-types).

## 4. Join Ordering — One Ordering Decides 2.8×

Single tables end at "index or scan"; with multiple tables the optimizer's real agony appears — **in what order to join.** A three-table chain:

```
R0 (10k rows) —[sel 0.001]— R1 (1k rows) —[sel 0.01]— R2 (10 rows)
```

Executing in written order (R0 first) makes the big tables meet first, **inflating the intermediate result** that the next step must chew. Starting from **small R2** keeps intermediates near 100. Same answer, same three tables — **ordering alone changes cost 2.8×** (under db-hobby's cost model).

![Naive left-to-right vs Selinger DP — attach small tables first to keep intermediates small](/uploads/project/db-hobby/join-order-dp.svg)

> **The essence of join ordering**: the final result is order-independent, but **the size of intermediates** is decided by the order. The optimizer's job is finding the order that keeps intermediates small.

### From n! to 2ⁿ — Selinger's Subset DP

n tables have n! orders — 3.6M at 10, 480M at 12. Patricia Selinger's 1979 System R answer: **dynamic programming over subsets.**

> The best plan joining relation-set S is the cheapest among: best plan for S minus one relation, extended by that relation. — Optimal substructure.

Represent subsets as **bitmasks** (`{R0,R2}` = `0b101`) and the table has **2ⁿ** cells, not n! — 4,096 instead of 480M at n=12.

```c
for (int mask = 1; mask <= full; mask++) {       /* increasing ints = smaller sets first */
    for (int r = 0; r < n; r++) {
        if (mask & (1 << r)) continue;
        double ncost = dp_cost[mask] + join_step_cost(g, mask, r, ...);
        int nmask = mask | (1 << r);
        if (ncost < dp_cost[nmask]) { dp_cost[nmask] = ncost; dp_prev[nmask] = mask; }
    }
}
```

Sweeping `mask` in increasing integer order is the trick — every subset (one bit removed) has a smaller value and is already final, so no topological sort is needed. Backtrack `dp_prev` from the full set to read off the optimal order.

### Two Rules That Decide Quality

The DP skeleton isn't enough:

- **Avoid Cartesian products (connectivity)** — joining two relations with no join predicate explodes intermediates to `|A|×|B|`. So only relations **connected by a join edge** to the current set are candidates (allowing a cross product only for genuinely disconnected graphs, flagged honestly).
- **Pick the method too** — at each extension, compare index NLJ (probe ≈ 1 if the inner side has an index) vs hash join (build + probe) and record the **cheaper method** for that step. Order and method are decided in one DP.

Verification is by property: **"DP is never worse than the naive left-to-right order"** across many random graphs (DP cost ≤ naive cost as an invariant under the same cost model).

> **Honest boundary**: this join-order planner is a standalone module — wiring it into the executor needs multi-table statistics and intermediate-cardinality estimation on the executor side. The single-table CBO (§2–3) *is* wired in; join ordering is proven to the skeleton. PostgreSQL runs this DP up to `geqo_threshold` (default 12) tables and switches to a genetic algorithm (GEQO) beyond — even 2ⁿ eventually overwhelms.

## 5. Wrap-up

- **EXPLAIN's principle**: share the executor's decision function — the plan never lies.
- **Where the rule fails**: rows-to-fetch > page count means sequential wins (`random_page_cost`'s wisdom). The real answer to "why isn't my index used?"
- **CBO's three ingredients**: ANALYZE (stats) → selectivity (uniformity now, histograms next) → cost comparison. No stats → fall back to the rule.
- **Join ordering**: intermediate size is everything. Selinger's DP turns n! into 2ⁿ; connectivity blocks Cartesian products; the method (NLJ vs hash) rides in the same DP. PostgreSQL hands large joins to GEQO.

Next: the three philosophies of storage engines — **heap (PostgreSQL) vs clustered (InnoDB) vs LSM (RocksDB)** — contrasted with measurements in one codebase.

## References (primary sources first)

- P. G. Selinger et al., *Access Path Selection in a Relational Database Management System* (SIGMOD 1979)
- [PostgreSQL Documentation: Planner/Optimizer](https://www.postgresql.org/docs/current/planner-optimizer.html)
- [PostgreSQL Documentation: Statistics Used by the Planner](https://www.postgresql.org/docs/current/planner-stats.html)
- [PostgreSQL Documentation: Genetic Query Optimizer](https://www.postgresql.org/docs/current/geqo.html)
- This blog: [DB Index ①: Reading EXPLAIN](/blog/theory/db-index-01-explain-basics) · [②: Scan Types](/blog/theory/db-index-02-scan-types)
- [db-hobby source (GitHub)](https://github.com/dj258255/db-hobby) — `db.c` (ANALYZE, cost choice) · `joinopt.c` (Selinger DP)

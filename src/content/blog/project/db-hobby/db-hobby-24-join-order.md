---
title: '조인 순서 최적화 — 옵티마이저의 진짜 결정, Selinger DP'
titleEn: 'Join Order Optimization — the Optimizer''s Real Decision, Selinger DP'
description: "21편의 비용 옵티마이저는 '한 테이블을 어떻게 읽나(seq vs index)'만 골랐다. 하지만 테이블이 셋 이상 얽히면 진짜 병목은 '어느 순서로 조인하나'다. R0(1만) — R1(1천) — R2(10) 체인을, 쿼리에 적힌 순서(0→1→2)로 조인하면 먼저 R0×R1의 중간 결과가 폭발해 비용 31,010이 된다. 작은 R2부터 붙이면(2→1→0) 중간 결과가 작게 유지돼 11,120 — 2.8배 싸다. 이 편은 System R의 Selinger가 1979년에 제시한 부분집합 동적 계획법을 구현한다: dp[S]=관계 집합 S를 조인하는 최소 비용 계획을 비트마스크로 bottom-up으로 채워, n! 순열 대신 2ⁿ 부분집합만 본다. 교차곱 회피(연결된 관계만 붙임)와 독립 가정 카디널리티 추정이 품질을 가른다. 정직한 경계: 이건 순수 계획기이고 실행기 배선은 프론티어다(LEFT JOIN 순서 제약·ON 재매핑)."
descriptionEn: "Part 21's cost optimizer only chose how to read one table (seq vs index). But once three or more tables tangle, the real bottleneck is the order you join them. Join the chain R0(10k) — R1(1k) — R2(10) in written order (0→1→2) and the R0×R1 intermediate explodes to cost 31,010. Attach the small R2 first (2→1→0) and the intermediate stays small — 11,120, 2.8× cheaper. This part implements the subset dynamic programming Selinger introduced in System R (1979): dp[S] = the minimum-cost plan joining relation set S, filled bottom-up over bitmasks, so you examine 2ⁿ subsets instead of n! permutations. Cross-product avoidance (only attach connected relations) and independence-assumption cardinality estimation decide the quality. Honest boundary: this is a pure planner; wiring it into the executor is a frontier (LEFT JOIN ordering constraints, ON remapping)."
date: 2026-07-04
tags:
  - C
  - Database Internals
  - Query Optimizer
  - Join Order
  - Dynamic Programming
  - PostgreSQL
  - Learning
category: study/db-hobby
coverImage: /uploads/project/db-hobby/cover.svg
draft: false
series: "db-hobby"
seriesOrder: 24
---

## 0. 들어가며 — 옵티마이저가 진짜로 고민하는 것

[21편](/blog/project/db-hobby/db-hobby-21-cost-optimizer)에서 비용 기반 옵티마이저를 심었어요. 하지만 그건 **한 테이블을 어떻게 읽나** — 순차 스캔이냐 인덱스냐 — 만 골랐습니다. 테이블 하나짜리 쿼리의 세계죠.

진짜 옵티마이저가 밤새 고민하는 건 다른 겁니다. `A JOIN B JOIN C JOIN D` 처럼 테이블이 여럿 얽히면, 질문은 "각각을 어떻게 읽나"가 아니라 **"어느 순서로 조인하나"** 로 바뀌어요. 그리고 이 순서 하나가 쿼리를 밀리초로 끝낼지 몇 분을 끌지 가릅니다.

왜 그렇게까지 차이가 날까요? 조인은 **중간 결과**를 만들고, 그 중간 결과가 다음 조인의 입력이 되기 때문입니다. 큰 걸 먼저 곱하면 중간 결과가 폭발하고, 그 폭발한 걸 또 스캔하게 돼요.

## 1. 순서 하나가 2.8배를 가른다

구체적으로 봅시다. 세 테이블이 체인으로 연결돼 있어요:

```
R0(1만 행) —[선택도 0.001]— R1(1천 행) —[선택도 0.01]— R2(10 행)
```

`SELECT * FROM R0 JOIN R1 ON … JOIN R2 ON …` 를 **쿼리에 적힌 순서**(R0 먼저)로 실행하면:

```
1) R0 스캔                     → 1만 행 읽기,     비용 10000
2) (R0) ⋈ R1                   → 중간결과 1만×1천×0.001 = 1만 행,  비용 1만×1천 = 10,000,000
   ...아니, 나이브 중첩이면 그렇고, 여기선 스캔·프로브 비용 모델로 rows=1만
3) (R0⋈R1) ⋈ R2               → …
```

핵심은 **2단계에서 R0×R1을 먼저 만든다**는 것. R0가 크니 중간 결과가 커지고, 그걸 3단계가 또 처리해요. 반대로 **작은 R2부터** 붙이면:

```
R2(10) ⋈ R1(1천) → 중간결과 100  →  ⋈ R0(1만) → 최종 100
```

중간 결과가 100으로 작게 유지됩니다. 같은 결과, 같은 세 테이블 — **순서만 바꿔 비용이 31,010 → 11,120으로 2.8배** 줄어요.

![순진한 좌→우 순서 vs Selinger DP: 체인 조인에서 작은 테이블부터 붙여 중간 결과를 작게 유지한다](/uploads/project/db-hobby/join-order-dp.svg)

> 참고: 위 숫자는 db-hobby의 단순화한 비용 모델(스캔=행 수, 인덱스 프로브≈1, 해시=빌드+프로브) 기준입니다. PostgreSQL·MySQL의 실제 비용 모델은 페이지 수·CPU 튜플 비용·랜덤/순차 I/O 계수까지 반영해 훨씬 정교해요. 여기선 '순서가 왜 중요한가'의 뼈대만 봅니다.

## 2. n! 을 2ⁿ 으로 — Selinger의 아이디어

테이블 n개의 조인 순서는 순열이니 **n!** 가지예요. 10개면 360만 가지, 12개면 4억 8천만. 다 해보는 건 불가능하죠.

1979년 System R 논문에서 Patricia Selinger가 낸 답이 **부분집합 동적 계획법**입니다. 핵심 통찰:

> "관계 집합 S를 조인하는 최적 계획"은, S에서 관계 하나 r을 뺀 부분집합 S\{r}의 최적 계획에 r을 붙인 것들 중 가장 싼 것이다.

즉 최적 부분 구조가 성립해요. 그래서 **작은 집합부터 큰 집합으로 표를 채우면** 됩니다:

```
dp[{i}]      = R_i 를 스캔        (기저)
dp[S ∪ {r}]  = min over r∉S:  dp[S] + (S에 r을 붙이는 비용)
답            = dp[전체집합]
```

부분집합은 **비트마스크**로 표현합니다. `{R0, R2}` = `0b101` = 5. 관계 n개면 부분집합은 2ⁿ개 — n!가 아니라 **2ⁿ**만 채우면 되죠. 12개면 4억이 아니라 4096개입니다.

db-hobby의 구현(`src/joinopt.c`)은 이걸 그대로 옮깁니다:

```c
for (int mask = 1; mask <= full; mask++) {
    if (dp_cost[mask] >= INF) continue;      /* 도달 못 한 집합은 건너뜀 */
    for (int r = 0; r < n; r++) {
        if (mask & (1 << r)) continue;       /* 이미 S에 있음 */
        double add   = join_step_cost(g, mask, r, dp_rows[mask], …);
        double ncost = dp_cost[mask] + add;
        int    nmask = mask | (1 << r);
        if (ncost < dp_cost[nmask]) {        /* 더 싼 계획 발견 → 갱신 */
            dp_cost[nmask] = ncost;
            dp_prev[nmask] = mask;           /* 역추적용 */
            dp_last[nmask] = r;
        }
    }
}
```

`mask`를 **증가하는 정수 순서**로 훑는 게 트릭이에요. 어떤 부분집합(비트 하나 뺀 것)도 값이 더 작아 **이미 확정**돼 있으니, 위상 정렬을 따로 안 해도 됩니다. 다 채운 뒤 `dp_prev`를 `full`부터 거꾸로 따라가면 최적 순서가 나와요.

## 3. 품질을 가르는 두 규칙

DP 뼈대만으론 부족합니다. 실전 옵티마이저를 옵티마이저답게 만드는 두 규칙이 있어요.

### 규칙 1 — 교차곱을 피하라 (연결성)

조인 술어가 **없는** 두 관계를 붙이면 그건 교차곱(Cartesian product)이라 중간 결과가 `|A|×|B|`로 터집니다. 그래서 DP는 **이미 조인된 집합 S에 조인 간선으로 연결된 관계만** 다음에 붙여요:

```c
static double combined_sel(const JoinGraph *g, int mask, int r, int *connected) {
    double s = 1.0; int conn = 0;
    for (int x = 0; x < g->nrel; x++) {
        if (!(mask & (1 << x))) continue;
        if (g->sel[r][x] < 1.0) { s *= g->sel[r][x]; conn = 1; }  /* r·x 간선 존재 */
    }
    *connected = conn;
    return s;
}
```

연결된 확장이 하나라도 있으면 그것만 시도하고, **정말 아무와도 안 붙는 분리된 그래프일 때만** 교차곱을 허용합니다(그리고 `had_cross`로 정직하게 표시해요).

### 규칙 2 — 카디널리티를 추정하라 (독립 가정)

"작은 걸 먼저"를 판단하려면 각 중간 결과의 크기를 **추정**해야 합니다. 표준 공식은 독립 가정이에요:

```
|S ∪ {r}| = |S| × |R_r| × ∏(S와 r 사이 연결 술어들의 선택도)
```

선택도(selectivity)는 "조인 조건을 통과하는 비율"입니다. `R0·R1` 간선이 0.001이면, 곱집합의 0.1%만 살아남는다는 뜻이죠. 이 추정이 빗나가면 옵티마이저 전체가 틀립니다 — 그래서 실제 DB들이 통계(히스토그램·상관관계)에 목숨 거는 거예요. db-hobby는 [21편의 ANALYZE 통계](/blog/project/db-hobby/db-hobby-21-cost-optimizer)와 같은 정신으로, 단순화한 균일 선택도를 씁니다.

## 4. 방법까지 고른다 — 인덱스 NLJ vs 해시

순서를 정하는 김에, 각 조인 단계에서 **방법**도 함께 골라요. 붙이는 관계 r에 대해:

```c
double nested = prev_rows * card[r];         /* 중첩 루프: 외부행마다 r 전체 스캔 */
double hash   = card[r] + prev_rows;         /* 해시: r로 해시 1번 + prefix 프로브 */
double index  = prev_rows * 1.0;             /* 인덱스 NLJ: 외부행마다 PK 점 조회 1회 */
```

r의 PK가 조인 키라면(21편의 Index Point Lookup) `index`가 보통 가장 쌉니다. 이건 [21편의 접근 경로 선택](/blog/project/db-hobby/db-hobby-21-cost-optimizer)이 조인 레벨로 올라온 것 — 두 층의 비용 결정이 같은 언어로 만나요.

## 5. 검증 — DP는 절대 순진보다 나쁘지 않다

`make test` 의 `test_joinopt` 스위트가 계획의 질을 검증합니다. 핵심은 **불변식**이에요:

```
어떤 조인 그래프에서도  cost(DP) ≤ cost(순진한 좌→우)
```

DP는 순진한 순서도 후보로 포함하므로, 논리적으로 절대 더 나쁠 수 없습니다. 여러 그래프(체인·스타 스키마·분리 그래프)에서 이걸 확인하고, 재정렬 이득이 있는 케이스(체인)에선 **엄격히 더 싸다**는 것까지 봐요. 스타 스키마(큰 fact + 작은 dimension들)에선 교차곱 없이 연결로만 조인하는지도 검사합니다.

```
     [체인] naive=31010  dp=11120  (order 2,1,0)   ← 작은 R2부터
     [스타] naive=400300  dp=300400
     [인덱스] order 0,1  method[1]=Index NLJ  cost=2000
```

## 6. 정직한 경계 — 왜 실행기에 안 붙였나

[22편(latch crabbing)](/blog/project/db-hobby/db-hobby-22-latch-crabbing)·[23편(힙 vs 클러스터드)](/blog/project/db-hobby/db-hobby-23-clustered-vs-heap)과 똑같이, 이 모듈도 **독립 계획기**로 세웠습니다. `joinopt.c`는 최적 순서와 비용을 계산하지만, db.c의 실행기(`exec_select_join`)는 여전히 쿼리에 적힌 순서대로 돌아요. 왜 배선하지 않았을까요? 세 가지가 더 필요하고, 그게 진짜 프론티어라서입니다:

1. **실행 순서 재정렬** — `tabs[]`·컬럼 오프셋·결합 행 레이아웃을 새 순서로 재배치.
2. **ON 술어 재매핑** — `on_at`/`on_bt` 같은 인덱스가 옛 순서를 가리키니, 새 순서 기준으로 다시 풀어야 함.
3. **LEFT/OUTER JOIN 순서 제약** — 이게 결정적입니다. `A LEFT JOIN B`를 `B` 먼저로 돌리면 **의미가 바뀌어요**. 외부 조인은 자유롭게 재정렬할 수 없습니다. 현재 DP 모델은 inner equi-join만 가정해요. 진짜 옵티마이저는 조인 그래프를 "재정렬 가능한 덩어리"로 쪼개 그 안에서만 DP를 돌립니다.

400개 넘는 green 테스트를 지키면서 이 셋을 안전하게 넣는 건 별도의 큰 작업이에요. 그래서 **무엇을 안 했는지를 명시하는 것**이 이 편의 결론입니다 — 계획기는 옳게 서 있고, 실행기 배선은 다음 정거장이라는 것.

## 7. 정리

- 테이블이 셋 이상 얽히면 옵티마이저의 진짜 결정은 **접근 경로가 아니라 조인 순서**다.
- 순서 하나가 중간 결과의 크기를 가르고, 그게 비용을 몇 배씩 바꾼다(체인 예시 2.8배).
- Selinger의 **부분집합 DP**는 n! 순열을 2ⁿ 부분집합으로 접는다 — `dp[S]`를 비트마스크로 bottom-up.
- 품질은 **교차곱 회피(연결성)** 와 **독립 가정 카디널리티 추정**이 가른다.
- db-hobby는 이를 순수 계획기로 구현하고, 실행기 배선(LEFT JOIN 순서 제약 등)은 정직한 프론티어로 남겼다.

<!-- EN -->

## 0. Intro — What the Optimizer Actually Agonizes Over

In [Part 21](/blog/project/db-hobby/db-hobby-21-cost-optimizer) I planted a cost-based optimizer. But it only chose **how to read one table** — sequential scan or index. That's the single-table world.

What a real optimizer stays up all night over is different. Once tables tangle — `A JOIN B JOIN C JOIN D` — the question isn't "how do I read each" but **"in what order do I join them."** And this one decision decides whether the query finishes in milliseconds or drags on for minutes.

Why such a difference? Because a join produces an **intermediate result**, and that intermediate feeds the next join. Multiply the big one first and the intermediate explodes — then you scan that exploded thing again.

## 1. One Ordering Decides 2.8×

Concretely. Three tables chained:

```
R0(10k rows) —[sel 0.001]— R1(1k rows) —[sel 0.01]— R2(10 rows)
```

Run `SELECT * FROM R0 JOIN R1 ON … JOIN R2 ON …` in **written order** (R0 first) and step 2 builds R0×R1 first — R0 is big, so the intermediate grows, and step 3 processes that. Attach the **small R2 first** instead:

```
R2(10) ⋈ R1(1k) → intermediate 100  →  ⋈ R0(10k) → final 100
```

The intermediate stays at 100. Same result, same three tables — **just reordering drops the cost 31,010 → 11,120, 2.8×.**

![Naive left-to-right vs Selinger DP: attach the small table first to keep the intermediate result small](/uploads/project/db-hobby/join-order-dp.svg)

> Note: these numbers use db-hobby's simplified cost model (scan = row count, index probe ≈ 1, hash = build + probe). PostgreSQL/MySQL's real models are far more precise — page counts, CPU tuple costs, random/sequential I/O coefficients. Here we see only the skeleton of "why order matters."

## 2. Turning n! into 2ⁿ — Selinger's Idea

The join orders of n tables are permutations — **n!** of them. Ten tables is 3.6M; twelve is 480M. Trying them all is impossible.

The answer Patricia Selinger gave in the 1979 System R paper is **subset dynamic programming**. The key insight:

> "The optimal plan joining relation set S" is the cheapest among: take the optimal plan of a subset S\{r}, and attach r to it.

Optimal substructure holds. So you **fill a table from small sets to big**:

```
dp[{i}]      = scan R_i                (base)
dp[S ∪ {r}]  = min over r∉S:  dp[S] + (cost of attaching r to S)
answer       = dp[full set]
```

Subsets are **bitmasks**. `{R0, R2}` = `0b101` = 5. With n relations there are 2ⁿ subsets — you fill **2ⁿ**, not n!. Twelve tables is 4096, not 480 million.

db-hobby's implementation (`src/joinopt.c`) transcribes it directly:

```c
for (int mask = 1; mask <= full; mask++) {
    if (dp_cost[mask] >= INF) continue;      /* unreached set — skip */
    for (int r = 0; r < n; r++) {
        if (mask & (1 << r)) continue;       /* already in S */
        double add   = join_step_cost(g, mask, r, dp_rows[mask], …);
        double ncost = dp_cost[mask] + add;
        int    nmask = mask | (1 << r);
        if (ncost < dp_cost[nmask]) {        /* cheaper plan → update */
            dp_cost[nmask] = ncost;
            dp_prev[nmask] = mask;           /* for backtracking */
            dp_last[nmask] = r;
        }
    }
}
```

Scanning `mask` in **increasing integer order** is the trick. Any subset (one bit removed) has a smaller value and is thus **already finalized** — no separate topological sort needed. After filling, walk `dp_prev` back from `full` to recover the optimal order.

## 3. Two Rules That Decide Quality

The DP skeleton alone isn't enough. Two rules make a real optimizer optimizer-grade.

### Rule 1 — Avoid cross products (connectivity)

Attaching two relations with **no** join predicate is a Cartesian product — the intermediate blows up to `|A|×|B|`. So the DP attaches **only relations connected by a join edge** to the already-joined set S:

```c
static double combined_sel(const JoinGraph *g, int mask, int r, int *connected) {
    double s = 1.0; int conn = 0;
    for (int x = 0; x < g->nrel; x++) {
        if (!(mask & (1 << x))) continue;
        if (g->sel[r][x] < 1.0) { s *= g->sel[r][x]; conn = 1; }  /* edge r·x exists */
    }
    *connected = conn;
    return s;
}
```

If any connected extension exists, only those are tried; **only for a truly disconnected graph** is a cross product allowed (and flagged honestly via `had_cross`).

### Rule 2 — Estimate cardinality (independence assumption)

To judge "small first," you must **estimate** each intermediate's size. The standard formula assumes independence:

```
|S ∪ {r}| = |S| × |R_r| × ∏(selectivities of edges between S and r)
```

Selectivity is "the fraction passing the join condition." An `R0·R1` edge of 0.001 means only 0.1% of the cross product survives. If this estimate is off, the whole optimizer is wrong — which is why real DBs live and die by statistics (histograms, correlations). db-hobby uses simplified uniform selectivity, in the same spirit as [Part 21's ANALYZE stats](/blog/project/db-hobby/db-hobby-21-cost-optimizer).

## 4. It Also Picks the Method — Index NLJ vs Hash

While deciding order, we pick the **method** at each join step too. For a relation r being attached:

```c
double nested = prev_rows * card[r];         /* nested loop: scan all of r per outer row */
double hash   = card[r] + prev_rows;         /* hash: build once on r + probe per prefix */
double index  = prev_rows * 1.0;             /* index NLJ: one PK point lookup per outer row */
```

If r's PK is the join key (Part 21's Index Point Lookup), `index` is usually cheapest. This is [Part 21's access-path choice](/blog/project/db-hobby/db-hobby-21-cost-optimizer) lifted to the join level — two layers of cost decisions meeting in the same language.

## 5. Verification — DP Is Never Worse Than Naive

The `test_joinopt` suite in `make test` verifies plan quality. The core is an **invariant**:

```
for any join graph:  cost(DP) ≤ cost(naive left-to-right)
```

DP includes the naive order as a candidate, so it can logically never be worse. I confirm this across graphs (chain, star schema, disconnected), and where reordering helps (chain) confirm it's **strictly cheaper**. For a star schema (big fact + small dimensions) I also check it joins purely by connectivity, no cross product.

```
     [chain] naive=31010  dp=11120  (order 2,1,0)   ← small R2 first
     [star]  naive=400300  dp=300400
     [index] order 0,1  method[1]=Index NLJ  cost=2000
```

## 6. The Honest Boundary — Why It's Not Wired into the Executor

Just like [Part 22 (latch crabbing)](/blog/project/db-hobby/db-hobby-22-latch-crabbing) and [Part 23 (heap vs clustered)](/blog/project/db-hobby/db-hobby-23-clustered-vs-heap), this module stands as an **independent planner**. `joinopt.c` computes the optimal order and cost, but db.c's executor (`exec_select_join`) still runs in written order. Why not wire it in? Three more things are needed, and that's the real frontier:

1. **Reorder execution** — rearrange `tabs[]`, column offsets, and the combined-row layout to the new order.
2. **Remap ON predicates** — indices like `on_at`/`on_bt` point at the old order and must be re-resolved against the new one.
3. **LEFT/OUTER JOIN ordering constraints** — this is decisive. Turning `A LEFT JOIN B` into `B`-first **changes the meaning**. Outer joins can't be freely reordered. The current DP model assumes inner equi-joins only. Real optimizers split the join graph into "freely reorderable blocks" and run DP only within those.

Doing all three safely while keeping 400+ green tests is a separate large effort. So **naming what wasn't done** is this part's conclusion — the planner stands correct; wiring the executor is the next stop.

## 7. Wrap-up

- Once three or more tables tangle, the optimizer's real decision is **join order, not access path**.
- One ordering decides intermediate-result size, which shifts cost by multiples (2.8× in the chain example).
- Selinger's **subset DP** folds n! permutations into 2ⁿ subsets — `dp[S]` over bitmasks, bottom-up.
- Quality is decided by **cross-product avoidance (connectivity)** and **independence-assumption cardinality estimation**.
- db-hobby implements it as a pure planner and leaves executor wiring (LEFT JOIN ordering constraints, etc.) as an honest frontier.

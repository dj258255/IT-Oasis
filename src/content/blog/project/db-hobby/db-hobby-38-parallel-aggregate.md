---
title: '병렬 집계 — 그리고 조용히 틀리던 집계 버그를 고치다'
titleEn: 'Parallel Aggregation — and Fixing an Aggregate That Was Silently Wrong'
description: "37편에서 스트리밍 SELECT를 병렬화하며, 다음 수순으로 parallel aggregate를 지목했다. 이 편이 그걸 한다 — 그런데 병렬화하려고 집계 경로를 들여다보다 진짜 버그를 발견했다. 직렬 집계 경로(exec_select_project)는 행을 SELECT_MAX_ROWS(4096)까지만 모은 뒤 집계한다. 그래서 6000행 테이블에 SELECT COUNT(*)를 하면 4096을 준다 — 조용히 틀린 답. materialize 버퍼의 학습용 상한이 큰 테이블 집계를 소리 없이 절단하고 있었다. 38편은 이 버그를 병렬 수집으로 고친다: 큰 테이블(>= 16페이지)의 서브쿼리 없는 집계/GROUP BY에서, 37편의 parscan_collect·parsel_pred를 그대로 재사용해 워커가 가시성 게이트와 WHERE를 병렬로 평가하고 매칭 RID를 페이지 순서로 모은다. leader는 매칭 수만큼(cap 없이) rows를 채워 기존 aggregate_rowset(직렬과 똑같은 집계·GROUP BY·출력 코드)에 넘긴다. 그래서 cap 없이 정답을 내면서 병렬화되고, 출력 형식도 직렬과 동일하다. 검증은 수학적 정답(oracle)과 대조한다 — SUM은 n(n+1)/2, COUNT(*)는 6000, AVG는 3000.5. MVCC UPDATE/DELETE가 병렬 집계에도 반영되고, GROUP BY도 cap 없이 집계되며, 엔진 병렬 경로를 ThreadSanitizer로 돌려 data race 0을 확인한다. 668 checks / 39스위트. 정직한 경계: 매칭 행을 모두 담으므로(cap 제거의 대가) 매우 큰 결과엔 메모리를 쓴다 — 행을 안 모으고 누적만 하는 진짜 partial aggregation(메모리 O(1))은 프론티어."
descriptionEn: "In Part 37, parallelizing the streaming SELECT, I named parallel aggregate as the next step. This part does it — but looking into the aggregate path to parallelize it, I found a real bug. The serial aggregate path (exec_select_project) collects rows only up to SELECT_MAX_ROWS (4096) before aggregating. So SELECT COUNT(*) on a 6000-row table returns 4096 — a silently wrong answer. The materialization buffer's learning-purpose cap was quietly truncating large-table aggregates. Part 38 fixes it with parallel collection: for a large table (>= 16 pages) on a subquery-free aggregate/GROUP BY, it reuses Part 37's parscan_collect and parsel_pred so workers evaluate the visibility gate and WHERE in parallel and collect matching RIDs in page order. The leader fills a rows array with all the matches (no cap) and hands it to the existing aggregate_rowset (the same aggregate/GROUP BY/output code as serial). So it produces the correct answer with no cap while running in parallel, and the output format is identical to serial. Verification is against math oracles — SUM is n(n+1)/2, COUNT(*) is 6000, AVG is 3000.5. MVCC UPDATE/DELETE is reflected in the parallel aggregate too, GROUP BY aggregates without the cap, and the engine parallel path runs under ThreadSanitizer with zero data races. 668 checks / 39 suites. Honest boundary: it holds all matching rows (the price of removing the cap), so a very large result uses memory — a true partial aggregation that only accumulates (O(1) memory) is the frontier."
date: 2026-07-05
tags:
  - C
  - Database Internals
  - Parallel Query
  - Aggregation
  - Concurrency
  - MVCC
  - Learning
category: study/db-hobby
coverImage: /uploads/project/db-hobby/cover.svg
draft: false
series: "db-hobby"
seriesOrder: 38
---

## 0. 들어가며 — 37편이 지목한 다음, 그리고 발견한 버그

[37편](/blog/project/db-hobby/db-hobby-37-parallel-select)에서 스트리밍 `SELECT`를 병렬화하며 다음 수순을 이렇게 적어뒀어요:

> "parallel aggregate / parallel hash join이 다음 수순."

이 편이 병렬 집계를 합니다. 그런데 병렬화하려고 집계 경로를 들여다보다 **진짜 버그**를 발견했어요.

`SELECT COUNT(*) FROM big`을 6000행 테이블에 던지면 — **4096**이 나옵니다. 조용히 틀린 답이에요.

## 1. 버그 — materialize 상한이 집계를 소리 없이 절단한다

직렬 집계 경로(`exec_select_project`)는 이렇게 동작해요:

```c
Value *rows = malloc(SELECT_MAX_ROWS * ncols * sizeof(Value)); // 상한 4096
MatCtx m = { .cap = SELECT_MAX_ROWS, ... };
heap_scan(&t->heap, mat_visit, &m);   // 행을 rows[]에 모은다
// ... aggregate_rowset(rows, m.count, ...)   // 모은 행으로 집계
```

`mat_visit`은 `m->count >= m->cap`이면 그냥 멈춰요(학습용 상한). 그래서 6000행 테이블은 **4096행만 모으고**, `COUNT(*)`는 `4096`, `SUM(v)`는 1..4096의 합만 냅니다. 나머지 1904행이 **조용히 사라진** 거예요.

> 이건 "느리다"보다 나쁜 버그예요 — **틀린 답을 조용히** 줍니다. 병렬화를 하려다 이걸 발견했으니, 38편은 **병렬화로 이 버그까지 함께 고칩니다.**

## 2. 고침 — 병렬 수집으로 cap을 없앤다

핵심 통찰: 집계는 [37편](/blog/project/db-hobby/db-hobby-37-parallel-select)과 **같은 역할 분담**으로 풀려요. 뜨거운 부분(가시성 게이트 + WHERE)은 워커가 병렬로, 나머지는 leader가.

- **워커(병렬)**: 37편의 `parscan_collect` + `parsel_pred`를 **그대로 재사용**해, 가시성 게이트와 WHERE를 병렬로 평가하고 매칭 RID를 **페이지 순서로** 모은다. `parscan`의 결과 버퍼는 동적으로 자라 **상한이 없다.**
- **leader(직렬)**: 모은 RID를 매칭 수만큼 `rows`에 채운다 — **cap 없이.** 그다음 **기존 `aggregate_rowset`**(직렬과 똑같은 집계·GROUP BY·출력 코드)에 넘긴다.

```c
static int try_parallel_aggregate(Table *t, ..., const SelectStmt *sel, FILE *out) {
    if (!(sel->has_aggregate || sel->group_col[0])) return 0; // 순수 투영은 직렬
    if (where_has_subquery(&sel->where)) return 0;            // 서브쿼리는 직렬
    if (heap_pages(t) < PARSCAN_MIN_PAGES) return 0;          // 작은 테이블은 직렬

    ParscanResult res;
    parscan_collect(&t->heap, PARSCAN_WORKERS, parsel_pred, &pc, &res); // 병렬 필터
    Value *rows = malloc(res.n * ncols * sizeof(Value));     // cap 없이 실제 매칭 수만큼
    // ... res의 RID로 rows 채움 ...
    aggregate_rowset(sel, rows, nrows, ncols, cols, out);    // 직렬과 같은 코드
    return 1;
}
```

![병렬 집계: 직렬은 cap에서 절단(틀림), 병렬은 매칭 행을 cap 없이 모아 기존 집계 코드로](/uploads/project/db-hobby/parallel-aggregate.svg)

`aggregate_rowset`을 그대로 부르니, **출력 형식과 집계 의미가 직렬과 완전히 같아요** — 달라진 건 딱 하나, 이제 **모든 매칭 행을 본다**는 것(= cap 제거 = 버그 수정)이죠.

## 3. 검증 — 수학적 정답과 대조

병렬 집계는 이제 직렬과 다른(더 올바른) 답을 내므로, 직렬과 비교하는 대신 **수학적 정답(oracle)**과 대조해요. `test_paragg`(신규, 13 checks)는 6,000행(18페이지) 테이블로:

```
  ok   COUNT(*) = 6000 — materialize cap 우회(직렬은 4096 절단)
  ok   SUM(v) = 18003000 (n(n+1)/2)
  ok   MIN(v) = 1  /  MAX(v) = 6000  /  AVG(v) = 3000.5
  ok   COUNT(*) WHERE v>5990 = 10  /  SUM(v) WHERE v<=10 = 55
```

**MVCC가 병렬 집계에도 그대로**: `UPDATE big SET v=1000000 WHERE id=1` 뒤 `SUM(v)`는 `18003000 - 1 + 1000000 = 19002999`. 워커가 같은 가시성 게이트를 지나 옛 버전을 제외하니까요. `DELETE` 뒤 `COUNT(*)`도 하나 줄어요.

**GROUP BY도 cap 없이**: `SELECT k, COUNT(*) FROM grp GROUP BY k`가 세 그룹 각 2000행을 정확히 셉니다(총 6000, 직렬이면 4096에서 잘렸을).

**레이스 부재**: `test_paragg_tsan`(엔진을 ThreadSanitizer로 빌드)이 **data race 0**을 확인해요. 전체는 **668 checks / 39스위트, FAIL 0.**

## 4. 남긴 프론티어

- **행을 모두 담는다**: cap을 없앤 대가로, 매칭 행을 전부 `rows`에 모아요. 6000행이면 사소하지만, 수백만 행 집계엔 메모리를 써요. **진짜 partial aggregation**(행을 안 모으고 워커가 COUNT/SUM/MIN/MAX를 **누적만** 하고 leader가 결합 — 메모리 O(1))이 프론티어예요. 지금은 "병렬 수집 + 기존 집계 코드 재사용"으로 정확성·형식 일치를 **싸게** 사고, 메모리 최적화는 남겼습니다.
- **서브쿼리·투영은 직렬**: 37편과 같은 이유(실행기 재진입·형식 유지).
- **engine_mtx 완전 제거**: 여전히 프론티어. 버퍼 풀(20)·병렬 스캔(36)·병렬 SELECT(37)·병렬 집계(38)는 그 길의 발판들.

## 5. 마무리

- 병렬화하려다 **조용히 틀리던 집계 버그**(materialize cap 절단)를 발견하고, **병렬 수집으로 그 버그까지 고쳤다.**
- 37편의 `parscan_collect`·`parsel_pred`를 재사용 — 워커가 가시성+WHERE 병렬, leader가 cap 없이 행을 모아 **기존 `aggregate_rowset`**에 넘김 → 형식 동일, 정답.
- 수학적 정답(oracle)으로 검증(SUM=n(n+1)/2, COUNT=6000…), MVCC·GROUP BY 그대로, 엔진 ThreadSanitizer 클린.
- 정직한 경계: 매칭 행을 모두 담는다 — 누적만 하는 진짜 partial aggregation은 프론티어.

<!-- EN -->

## 0. Intro — Part 37's Next Step, and a Bug I Found

In [Part 37](/blog/project/db-hobby/db-hobby-37-parallel-select), parallelizing the streaming `SELECT`, I named the next step:

> "Parallel aggregate / parallel hash join come next."

This part does parallel aggregation. But looking into the aggregate path to parallelize it, I found a **real bug**.

Run `SELECT COUNT(*) FROM big` on a 6000-row table and you get — **4096**. A silently wrong answer.

## 1. The Bug — the Materialization Cap Silently Truncates Aggregates

The serial aggregate path (`exec_select_project`) works like this:

```c
Value *rows = malloc(SELECT_MAX_ROWS * ncols * sizeof(Value)); // cap 4096
MatCtx m = { .cap = SELECT_MAX_ROWS, ... };
heap_scan(&t->heap, mat_visit, &m);   // collect rows into rows[]
// ... aggregate_rowset(rows, m.count, ...)   // aggregate the collected rows
```

`mat_visit` just stops when `m->count >= m->cap` (a learning-purpose cap). So a 6000-row table collects **only 4096 rows**, and `COUNT(*)` is `4096`, `SUM(v)` is only the sum of 1..4096. The other 1904 rows **silently vanish.**

> This is worse than "slow" — it silently returns the **wrong answer.** I found it while trying to parallelize, so Part 38 **fixes the bug via parallelization.**

## 2. The Fix — Parallel Collection Removes the Cap

The key insight: aggregation solves with the **same division of labor** as [Part 37](/blog/project/db-hobby/db-hobby-37-parallel-select). The hot part (visibility gate + WHERE) goes to workers in parallel; the rest to the leader.

- **Workers (parallel)**: reuse Part 37's `parscan_collect` + `parsel_pred` **verbatim** to evaluate the visibility gate and WHERE in parallel and collect matching RIDs **in page order.** `parscan`'s result buffer grows dynamically — **no cap.**
- **Leader (serial)**: fill `rows` with all the matches — **no cap** — then hand it to the **existing `aggregate_rowset`** (the same aggregate/GROUP BY/output code as serial).

```c
static int try_parallel_aggregate(Table *t, ..., const SelectStmt *sel, FILE *out) {
    if (!(sel->has_aggregate || sel->group_col[0])) return 0; // pure projection -> serial
    if (where_has_subquery(&sel->where)) return 0;            // subquery -> serial
    if (heap_pages(t) < PARSCAN_MIN_PAGES) return 0;          // small table -> serial

    ParscanResult res;
    parscan_collect(&t->heap, PARSCAN_WORKERS, parsel_pred, &pc, &res); // parallel filter
    Value *rows = malloc(res.n * ncols * sizeof(Value));     // no cap: actual match count
    // ... fill rows from res's RIDs ...
    aggregate_rowset(sel, rows, nrows, ncols, cols, out);    // same code as serial
    return 1;
}
```

![Parallel aggregation: serial truncates at the cap (wrong); parallel collects matches with no cap and feeds the existing aggregate code](/uploads/project/db-hobby/parallel-aggregate.svg)

Because it calls `aggregate_rowset` unchanged, the **output format and aggregate semantics are exactly the same as serial** — the one difference is that it now **sees every matching row** (= cap removed = bug fixed).

## 3. Verification — Against Math Oracles

The parallel aggregate now gives a different (more correct) answer than serial, so instead of comparing to serial I check against **math oracles.** `test_paragg` (new, 13 checks) uses a 6,000-row (18-page) table:

```
  ok   COUNT(*) = 6000 — bypasses the materialize cap (serial truncates to 4096)
  ok   SUM(v) = 18003000 (n(n+1)/2)
  ok   MIN(v) = 1  /  MAX(v) = 6000  /  AVG(v) = 3000.5
  ok   COUNT(*) WHERE v>5990 = 10  /  SUM(v) WHERE v<=10 = 55
```

**MVCC holds in the parallel aggregate too**: after `UPDATE big SET v=1000000 WHERE id=1`, `SUM(v)` is `18003000 - 1 + 1000000 = 19002999`, because workers pass the same visibility gate and exclude the old version. After a `DELETE`, `COUNT(*)` drops by one.

**GROUP BY without the cap too**: `SELECT k, COUNT(*) FROM grp GROUP BY k` counts three groups of exactly 2000 each (6000 total, which serial would have truncated at 4096).

**No races**: `test_paragg_tsan` (the engine built with ThreadSanitizer) confirms **zero data races.** The whole suite is **668 checks / 39 suites, FAIL 0.**

## 4. Frontiers Left

- **It holds all rows**: the price of removing the cap is collecting all matching rows into `rows`. Trivial for 6000 rows, but a million-row aggregate uses memory. A **true partial aggregation** (no row collection — workers **only accumulate** COUNT/SUM/MIN/MAX and the leader combines, O(1) memory) is the frontier. For now I buy correctness and format-parity **cheaply** with "parallel collection + reuse the existing aggregate code," and leave the memory optimization.
- **Subqueries and projection stay serial**: same reasons as Part 37 (executor re-entry, format parity).
- **Full removal of engine_mtx**: still the frontier. The buffer pool (20), parallel scan (36), parallel SELECT (37), and parallel aggregate (38) are footholds on that road.

## 5. Wrap-up

- While trying to parallelize, I found an aggregate that was **silently wrong** (the materialization cap truncating), and **fixed that bug via parallel collection.**
- Reused Part 37's `parscan_collect`/`parsel_pred` — workers do visibility+WHERE in parallel, the leader collects rows with no cap and hands them to the **existing `aggregate_rowset`** → identical format, correct answer.
- Verified against math oracles (SUM=n(n+1)/2, COUNT=6000, …), with MVCC and GROUP BY intact, and ThreadSanitizer clean.
- Honest boundary: it holds all matching rows — a true accumulate-only partial aggregation is the frontier.

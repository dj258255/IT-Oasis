---
title: '진짜 부분 집계 — 행을 안 모으고 누적만 (메모리 O(1))'
titleEn: 'True Partial Aggregation — Accumulate, Never Collect (O(1) Memory)'
description: "38편에서 병렬 집계로 silent 절단 버그를 고쳤지만, 정직하게 경계를 하나 남겼다 — 매칭 행을 모두 rows[]에 모은 뒤 집계하므로 메모리가 O(매칭 행수)라는 것. 큰 집계엔 수백만 행을 쌓는다. 이 편이 그 경계를 닫는다. PostgreSQL의 Partial Aggregate → Finalize Aggregate 두 단계처럼, 워커가 자기 페이지 범위를 훑으며 항목별 부분합(total/cnt/sum/min/max)만 '누적'하고 행은 하나도 안 쌓는다. leader는 워커들의 부분합을 결합해(COUNT=Σcnt, SUM=Σsum, MIN=min의 min, MAX=max의 max, AVG=Σsum/Σcnt) compute_cell과 같은 OutCell을 만든다. 메모리는 O(매칭 행수)에서 O(워커수 × 항목수)로 떨어진다. 이를 위해 parscan에 parscan_foreach 프리미티브를 더했다 — nworkers 스레드가 워커별 전용 컨텍스트에 병렬 누적하므로 락이 필요 없다(map-reduce의 토대). 자격은 그룹/HAVING/DISTINCT 없는 순수 INT 집계(또는 COUNT(*))·서브쿼리 없는 WHERE·큰 테이블이고, 그 외(GROUP BY·TEXT MIN/MAX·투영)는 38편(수집)이나 직렬로 폴백한다. 출력은 헤더와 emit_out_rows를 재사용해 직렬과 형식이 동일하고, 값은 수학적 정답(oracle)과 대조한다 — NULL 무시(COUNT(*) vs COUNT(col)/SUM), 다중 집계, 빈 결과(COUNT=0/SUM=NULL)까지. 엔진 병렬 경로를 ThreadSanitizer로 돌려 data race 0을 확인한다. 677 checks / 40스위트. 정직한 경계: 그룹별 부분 집계(per-group 해시 병합)와 TEXT 누적은 프론티어."
descriptionEn: "In Part 38, parallel aggregation fixed a silent truncation bug, but I honestly left one boundary — it collects all matching rows into rows[] before aggregating, so memory is O(matching rows). A large aggregate piles up millions of rows. This part closes that boundary. Like PostgreSQL's Partial Aggregate → Finalize Aggregate two-step, workers sweep their page ranges and only accumulate per-item partials (total/cnt/sum/min/max), stacking no rows at all. The leader combines the workers' partials (COUNT=Σcnt, SUM=Σsum, MIN=min of mins, MAX=max of maxes, AVG=Σsum/Σcnt) into the same OutCell compute_cell would produce. Memory drops from O(matching rows) to O(workers × items). For it I added a parscan_foreach primitive — nworkers threads accumulate into per-worker private contexts, so no lock is needed (the foundation for map-reduce). Eligibility is a pure INT aggregate (or COUNT(*)) with no GROUP BY/HAVING/DISTINCT, a subquery-free WHERE, and a large table; everything else (GROUP BY, TEXT MIN/MAX, projection) falls back to Part 38 (collection) or serial. Output reuses the header and emit_out_rows so the format is identical to serial, and values are checked against math oracles — NULL handling (COUNT(*) vs COUNT(col)/SUM), multiple aggregates, empty result (COUNT=0/SUM=NULL). The engine parallel path runs under ThreadSanitizer with zero data races. 677 checks / 40 suites. Honest boundary: per-group partial aggregation (merging per-group hashes) and TEXT accumulation are the frontier."
date: 2026-07-05
tags:
  - C
  - Database Internals
  - Parallel Query
  - Aggregation
  - Concurrency
  - Learning
category: study/db-hobby
coverImage: /uploads/project/db-hobby/cover.svg
draft: false
series: "db-hobby"
seriesOrder: 39
---

## 0. 들어가며 — 38편이 남긴 O(n) 메모리

[38편](/blog/project/db-hobby/db-hobby-38-parallel-aggregate)에서 병렬 집계로 silent 절단 버그를 고쳤지만, 마지막에 정직하게 경계를 하나 적어뒀어요:

> "**행을 모두 담는다**: cap을 없앤 대가로 매칭 행을 전부 `rows`에 모아요. 6000행이면 사소하지만, 수백만 행 집계엔 메모리를 써요. **진짜 partial aggregation**(행을 안 모으고 워커가 누적만 — 메모리 O(1))이 프론티어예요."

이 편이 그 경계를 닫습니다. `SUM(v)`를 구하려고 **행을 다 쌓을 이유가 없어요** — 지나가면서 더하면 되죠.

## 1. 발상 — Partial → Finalize 두 단계

PostgreSQL의 병렬 집계는 **Partial Aggregate → Finalize Aggregate** 두 단계로 돼요. 각 워커가 자기 몫을 **부분 집계**하고, 리더가 부분 결과를 **최종 결합**하죠. 우리도 똑같이 합니다:

- **워커(Partial)**: 자기 페이지 범위를 훑으며 항목별 **누산기만** 갱신한다 — `{total, cnt, sum, min, max}`. **행은 하나도 안 쌓는다.**
- **leader(Finalize)**: 워커들의 부분합을 결합한다.
  - `COUNT(*)` = Σtotal · `COUNT(col)` = Σcnt · `SUM` = Σsum
  - `MIN` = min(각 워커 min) · `MAX` = max(각 워커 max) · `AVG` = Σsum / Σcnt

메모리가 **O(매칭 행수)에서 O(워커수 × 항목수)로** 떨어져요. 6000행이든 6억 행이든 워커당 누산기 몇 개면 끝이죠.

![부분 집계: 38편은 행을 다 모으고(O(n)), 39편은 워커가 부분합만 누적(O(1)) → leader가 Finalize](/uploads/project/db-hobby/partial-aggregate.svg)

## 2. 프리미티브 — parscan_foreach

37·38편의 `parscan_collect`는 **매칭 RID를 모아주는** 함수라 누적엔 안 맞아요. 그래서 더 일반적인 프리미티브를 `parscan`에 더했어요:

```c
/* nworkers 스레드가 페이지 범위를 나눠 훑으며, 각 살아있는 슬롯마다
 * visit(rid, rec, len, ctxs[wid])를 부른다. ctxs[wid]는 '워커 전용'이라
 * visit이 거기에 자유롭게 누적해도 락이 필요 없다. */
int parscan_foreach(Heap *h, int nworkers, void **ctxs,
                    void (*visit)(RID, const void*, uint16_t, void*));
```

핵심은 **워커마다 전용 컨텍스트**(`ctxs[wid]`)를 준다는 거예요. 각자 자기 것에만 누적하니 **락이 아예 필요 없어요** — map-reduce의 map 단계 그대로죠. (37·38편이 쓰던 `parscan_collect`는 그대로 두고 이걸 따로 추가해, 검증된 코드를 안 건드렸어요.)

## 3. 워커 — 누적만, 락 없이

워커의 visit은 가시성 게이트와 WHERE를 통과한 행에 대해 부분합만 갱신해요:

```c
static void agg_worker_visit(RID rid, const void *rec, uint16_t len, void *c_) {
    AggWctx *w = c_;
    if (!row_visible(w->db, db_rec_xmin(rec), db_rec_xmax(rec), w->my_txn)) return;
    Value row[SQL_MAX_COLS];
    decode_row(w->schema, rec, row);
    if (!where_matches(w->schema, w->tname, w->where, row)) return;
    for (int k = 0; k < w->sel->num_items; k++) {
        AggPart *p = &w->part[k];
        p->total++;                                   // COUNT(*)
        if (COUNT(*)) continue;
        const Value *v = &row[w->item_ci[k]];
        if (v->type == VAL_NULL) continue;            // COUNT(col)/SUM/AVG/MIN/MAX는 NULL 무시
        long iv = v->int_val;
        p->cnt++; p->sum += iv;
        if (!p->seen) { p->minv = p->maxv = iv; p->seen = 1; }
        else { if (iv < p->minv) p->minv = iv; if (iv > p->maxv) p->maxv = iv; }
    }
}
```

`NULL` 처리가 미묘해요 — `COUNT(*)`는 NULL 포함 전체 행을 세지만, `COUNT(col)`·`SUM`·`AVG`·`MIN`·`MAX`는 NULL을 건너뜁니다(SQL 표준). `total`과 `cnt`를 따로 두는 이유예요.

## 4. Finalize — 형식은 직렬과 똑같이

leader는 부분합을 결합해 **`compute_cell`이 만들던 것과 똑같은 `OutCell`**을 만들어요. 그리고 출력은 직렬 집계와 **같은 코드**(`print_item_label` 헤더 + `emit_out_rows`)를 재사용합니다:

```c
// Finalize: 워커 부분합 결합 -> OutCell
if (COUNT(*)) c.num = Σtotal;
else if (SUM)  c.num = seen ? Σsum : NULL;
else if (AVG)  c.num = seen ? Σsum/Σcnt : NULL;
else if (MIN)  c.num = seen ? min(min) : NULL;
// ... 헤더 출력 후:
emit_out_rows(sel, outbuf, 1, out);   // 행 + "(1행)" 푸터 — 직렬과 형식 동일
```

`emit_out_rows`를 그대로 쓰니 `ORDER BY`·`LIMIT`·푸터까지 직렬과 **바이트 단위로 동일**해요.

## 5. 자격과 폴백 — 정직하게

부분 집계 fast-path는 **딱 맞는 경우만** 처리하고, 나머지는 **폴백**해요(정확성은 늘 보장):

- **자격**: 그룹/`HAVING`/`DISTINCT` 없는 순수 집계, 모든 항목이 **INT** 집계(또는 `COUNT(*)`), 서브쿼리 없는 WHERE, 큰 테이블(≥16페이지).
- **폴백**: `GROUP BY`·`TEXT` MIN/MAX·투영 섞임 → [38편](/blog/project/db-hobby/db-hobby-38-parallel-aggregate)(병렬 수집)이나 직렬 경로가 처리. 없는 컬럼 같은 에러도 그쪽에서 일관되게 나요.

## 6. 검증 — 수학 oracle + NULL + 레이스

`test_partagg`(신규, 9 checks)는 6,000행 테이블(10의 배수 행은 `v=NULL`)로 부분 집계의 **구별되는 성질**을 봐요:

```
  ok   COUNT(*) = 6000 (NULL 포함 전체 행)
  ok   COUNT(v) = 5400 (NULL 600개 제외)
  ok   SUM(v) = 16200000 (NULL 무시)
  ok   MIN(v), MAX(v) = 1 | 5999 (NULL 무시)
  ok   다중 집계 한 쿼리: 6000 | 5400 | 16200000
  ok   빈 결과: COUNT(*)=0, SUM=NULL
  ok   TEXT MIN/MAX = n00001 | n06000 (부분집계 폴백 경로도 정확)
```

값은 전부 **수학적 정답(oracle)**과 대조해요. `test_partagg_tsan`(엔진을 ThreadSanitizer로)이 **data race 0**을 확인하고요 — 워커들이 전용 컨텍스트에만 누적하니 당연하지만, 실측으로 못 박습니다. 전체는 **677 checks / 40스위트, FAIL 0.**

## 7. 남긴 프론티어

- **그룹별 부분 집계**: `GROUP BY`는 워커마다 **그룹별 부분합 해시**를 두고 leader가 병합해야 해요(PostgreSQL의 Partial HashAggregate). 지금은 38편의 수집 경로로 폴백. 이게 다음 발판.
- **TEXT 누적**: 문자열 MIN/MAX 부분합은 워커가 현재 최소/최대 문자열을 들고 있으면 되는데(고정 버퍼), 지금은 폴백. 어렵진 않아요.
- **engine_mtx 완전 제거**: 여전히 프론티어. 버퍼 풀(20)·병렬 스캔(36)·SELECT(37)·집계(38)·부분 집계(39)는 그 길의 발판들.

## 8. 마무리

- 38편이 남긴 **O(n) 메모리** 경계를 닫았다 — 워커가 행을 안 모으고 **부분합만 누적**, leader가 Finalize. 메모리 O(워커수 × 항목수).
- `parscan_foreach`(워커별 전용 컨텍스트로 병렬 순회) 프리미티브 위에 얹음 — 누적에 **락 없음**.
- `NULL` 처리(COUNT(*) vs COUNT(col)/SUM)·다중 집계·빈 결과를 수학 oracle로 검증, 출력 형식은 `emit_out_rows` 재사용으로 직렬과 동일, ThreadSanitizer 클린.
- 정직한 경계: 그룹별 부분 집계·TEXT 누적은 프론티어.

<!-- EN -->

## 0. Intro — the O(n) Memory Part 38 Left

In [Part 38](/blog/project/db-hobby/db-hobby-38-parallel-aggregate), parallel aggregation fixed the silent truncation bug, but I honestly left one boundary:

> "**It holds all rows**: the price of removing the cap is collecting all matching rows into `rows`. Trivial for 6000 rows, but a million-row aggregate uses memory. A **true partial aggregation** (no row collection — workers only accumulate — O(1) memory) is the frontier."

This part closes it. There's **no reason to pile up rows** to compute `SUM(v)` — you just add as you go.

## 1. The Idea — a Two-Step Partial → Finalize

PostgreSQL's parallel aggregation is a **Partial Aggregate → Finalize Aggregate** two-step: each worker **partially aggregates** its share, and the leader **finalizes** by combining the partials. We do the same:

- **Workers (Partial)**: sweep their page range and only update per-item **accumulators** — `{total, cnt, sum, min, max}`. **Stack no rows at all.**
- **Leader (Finalize)**: combine the workers' partials.
  - `COUNT(*)` = Σtotal · `COUNT(col)` = Σcnt · `SUM` = Σsum
  - `MIN` = min(each worker's min) · `MAX` = max(each worker's max) · `AVG` = Σsum / Σcnt

Memory drops from **O(matching rows) to O(workers × items).** Whether 6000 rows or 600 million, it's a few accumulators per worker.

![Partial aggregation: Part 38 collects all rows (O(n)), Part 39 accumulates partials only (O(1)) → leader finalizes](/uploads/project/db-hobby/partial-aggregate.svg)

## 2. The Primitive — parscan_foreach

Parts 37/38's `parscan_collect` **collects matching RIDs**, which doesn't fit accumulation. So I added a more general primitive to `parscan`:

```c
/* nworkers threads split page ranges and, for each live slot, call
 * visit(rid, rec, len, ctxs[wid]). ctxs[wid] is per-worker, so visit can
 * accumulate freely into it with no lock. */
int parscan_foreach(Heap *h, int nworkers, void **ctxs,
                    void (*visit)(RID, const void*, uint16_t, void*));
```

The key is giving each worker a **private context** (`ctxs[wid]`). Each accumulates only into its own, so **no lock at all** — exactly the map phase of map-reduce. (I left the `parscan_collect` that 37/38 use untouched and added this separately, not disturbing tested code.)

## 3. The Worker — Accumulate Only, No Lock

The worker's visit updates partials for rows that pass the visibility gate and WHERE:

```c
static void agg_worker_visit(RID rid, const void *rec, uint16_t len, void *c_) {
    AggWctx *w = c_;
    if (!row_visible(w->db, db_rec_xmin(rec), db_rec_xmax(rec), w->my_txn)) return;
    Value row[SQL_MAX_COLS];
    decode_row(w->schema, rec, row);
    if (!where_matches(w->schema, w->tname, w->where, row)) return;
    for (int k = 0; k < w->sel->num_items; k++) {
        AggPart *p = &w->part[k];
        p->total++;                                   // COUNT(*)
        if (COUNT(*)) continue;
        const Value *v = &row[w->item_ci[k]];
        if (v->type == VAL_NULL) continue;            // COUNT(col)/SUM/AVG/MIN/MAX ignore NULL
        long iv = v->int_val;
        p->cnt++; p->sum += iv;
        if (!p->seen) { p->minv = p->maxv = iv; p->seen = 1; }
        else { if (iv < p->minv) p->minv = iv; if (iv > p->maxv) p->maxv = iv; }
    }
}
```

`NULL` handling is subtle — `COUNT(*)` counts all rows including NULLs, but `COUNT(col)`/`SUM`/`AVG`/`MIN`/`MAX` skip NULLs (SQL standard). That's why `total` and `cnt` are separate.

## 4. Finalize — Same Format as Serial

The leader combines the partials into the **same `OutCell` that `compute_cell` produced**, and reuses the **same code** as serial aggregation for output (`print_item_label` header + `emit_out_rows`):

```c
// Finalize: combine worker partials -> OutCell
if (COUNT(*)) c.num = Σtotal;
else if (SUM)  c.num = seen ? Σsum : NULL;
else if (AVG)  c.num = seen ? Σsum/Σcnt : NULL;
else if (MIN)  c.num = seen ? min(min) : NULL;
// ... after printing the header:
emit_out_rows(sel, outbuf, 1, out);   // row + "(1행)" footer — identical format to serial
```

Because it reuses `emit_out_rows`, the `ORDER BY`, `LIMIT`, and footer come out **byte-identical to serial.**

## 5. Eligibility and Fallback — Honestly

The partial-aggregate fast path handles **only the exact case** and **falls back** otherwise (correctness always guaranteed):

- **Eligible**: a pure aggregate with no GROUP BY/`HAVING`/`DISTINCT`, all items **INT** aggregates (or `COUNT(*)`), a subquery-free WHERE, a large table (≥16 pages).
- **Fallback**: `GROUP BY`, `TEXT` MIN/MAX, mixed projection → handled by [Part 38](/blog/project/db-hobby/db-hobby-38-parallel-aggregate) (parallel collection) or the serial path. Errors like an unknown column come out consistently from there.

## 6. Verification — Math Oracles + NULL + Races

`test_partagg` (new, 9 checks) uses a 6,000-row table (rows at multiples of 10 have `v=NULL`) to check the partial path's **distinguishing properties**:

```
  ok   COUNT(*) = 6000 (all rows, NULLs included)
  ok   COUNT(v) = 5400 (600 NULLs excluded)
  ok   SUM(v) = 16200000 (NULLs ignored)
  ok   MIN(v), MAX(v) = 1 | 5999 (NULLs ignored)
  ok   multiple aggregates in one query: 6000 | 5400 | 16200000
  ok   empty result: COUNT(*)=0, SUM=NULL
  ok   TEXT MIN/MAX = n00001 | n06000 (correct via the fallback path too)
```

All values are checked against **math oracles.** `test_partagg_tsan` (the engine under ThreadSanitizer) confirms **zero data races** — obvious since workers accumulate only into private contexts, but pinned down by measurement. The whole suite is **677 checks / 40 suites, FAIL 0.**

## 7. Frontiers Left

- **Per-group partial aggregation**: `GROUP BY` needs each worker to keep a **per-group partial hash** and the leader to merge them (PostgreSQL's Partial HashAggregate). For now it falls back to Part 38's collection path. That's the next foothold.
- **TEXT accumulation**: a string MIN/MAX partial just needs the worker to hold the current min/max string (a fixed buffer); for now it falls back. Not hard.
- **Full removal of engine_mtx**: still the frontier. The buffer pool (20), parallel scan (36), SELECT (37), aggregate (38), and partial aggregate (39) are footholds on that road.

## 8. Wrap-up

- Closed the **O(n) memory** boundary Part 38 left — workers **accumulate partials** instead of collecting rows, the leader finalizes. Memory O(workers × items).
- Built on a `parscan_foreach` primitive (parallel iteration with per-worker private contexts) — **no lock** on accumulation.
- Verified `NULL` handling (COUNT(*) vs COUNT(col)/SUM), multiple aggregates, and empty results against math oracles; output format reuses `emit_out_rows` to stay identical to serial; ThreadSanitizer clean.
- Honest boundary: per-group partial aggregation and TEXT accumulation are the frontier.

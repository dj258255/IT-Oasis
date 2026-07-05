---
title: '병렬 스캔을 진짜 SELECT에 배선 — 워커는 판정, 출력은 leader'
titleEn: 'Wiring the Parallel Scan into a Real SELECT — Workers Judge, the Leader Prints'
description: "36편에서 병렬 풀 스캔을 독립 모듈로 증명하며, 마지막에 다음 발판을 이렇게 적어뒀다 — exec_select의 풀 스캔 경로에 배선하려면 워커가 decode_row·rec_visible·결과 수집을 스레드 안전하게 해야 하고 출력은 leader가. 이 편이 그 발판을 밟는다. 31편(WAL 복제)·33편(Raft SMR)·35편(LSM PK 인덱스)처럼 독립 모듈을 실제 db.c 엔진에 배선하는 캡스톤이다. 큰 테이블(>= 16페이지)의 인덱스 없는 스트리밍 SELECT full-scan에서, 서브쿼리 없는 WHERE면 병렬로 돈다. 설계의 핵심은 역할 분담이다: 뜨거운 부분(MVCC 가시성 게이트 + WHERE 평가)을 워커들이 병렬로 돌려 매칭 RID를 페이지 순서로 모으고(36편 parscan_collect를 그대로 재사용), 유일하게 스레드 안전하지 않은 부분인 '출력(print_row)'은 leader가 직렬로 한다. 그래서 결과가 직렬 경로와 바이트 단위로 동일하다. 서브쿼리를 품은 WHERE는 술어가 실행기를 재진입하므로(스레드 안전하지 않음) 게이트로 제외하고 직렬로 폴백한다. 검증: 병렬 경로의 정확성(v>X·복합 WHERE·전체 스캔), MVCC UPDATE 가시성·DELETE·ROLLBACK이 그대로 지켜짐, 작은 테이블은 직렬로 무회귀, 그리고 엔진 병렬 경로를 ThreadSanitizer로 돌려 data race 0을 확인한다. 655 checks / 38스위트. 정직한 경계: 읽기 전용 스트리밍 SELECT만. ORDER BY·집계·조인·서브쿼리는 직렬이고, engine_mtx를 통째로 걷어내 서로 다른 트랜잭션을 동시에 돌리는 건 여전히 프론티어."
descriptionEn: "In Part 36 I proved a parallel sequential scan as a standalone module, and closed by naming the next foothold — wiring it into exec_select needs the workers' decode_row/rec_visible/result-collection made thread-safe, with the leader doing output. This part takes that foothold. Like Part 31 (WAL replication), Part 33 (Raft SMR), and Part 35 (LSM PK index), it's a capstone wiring a standalone module into the real db.c engine. For a large table (>= 16 pages) on an index-less streaming SELECT full scan, a subquery-free WHERE runs in parallel. The design's core is a division of labor: workers run the hot part (the MVCC visibility gate + WHERE evaluation) in parallel and collect matching RIDs in page order (reusing Part 36's parscan_collect verbatim), while the only non-thread-safe part — output (print_row) — is done serially by the leader. So the result is byte-identical to the serial path. A WHERE holding a subquery makes the predicate re-enter the executor (not thread-safe), so it's gated out and falls back to serial. Verification: parallel-path correctness (v>X, compound WHERE, full scan), MVCC UPDATE visibility / DELETE / ROLLBACK all preserved, small tables stay serial (no regression), and the engine parallel path runs under ThreadSanitizer with zero data races. 655 checks / 38 suites. Honest boundary: read-only streaming SELECT only. ORDER BY, aggregates, joins, and subqueries stay serial, and peeling off engine_mtx entirely to run different transactions at once is still the frontier."
date: 2026-07-05
tags:
  - C
  - Database Internals
  - Parallel Query
  - Concurrency
  - MVCC
  - Executor
  - Learning
category: study/db-hobby
coverImage: /uploads/project/db-hobby/cover.svg
draft: false
series: "db-hobby"
seriesOrder: 37
---

## 0. 들어가며 — 36편이 지목한 다음 발판

[36편](/blog/project/db-hobby/db-hobby-36-parallel-scan)에서 병렬 풀 스캔을 **독립 모듈**로 증명하며, 마지막에 다음 발판을 이렇게 적어뒀어요:

> "**실행기 미배선**: `exec_select`의 풀 스캔 경로에 배선하려면 워커가 `decode_row`·`rec_visible`·결과 수집을 스레드 안전하게 해야 하고(출력은 leader가), 그건 다음 발판."

이 편이 그 발판을 밟습니다. [31편(WAL 복제)](/blog/project/db-hobby/db-hobby-31-replicated-db)·[33편(Raft SMR)](/blog/project/db-hobby/db-hobby-33-raft-replicated-db)·[35편(LSM PK 인덱스)](/blog/project/db-hobby/db-hobby-35-lsm-pk-index)처럼, **독립 증명 모듈을 실제 db.c 엔진에 배선하는 캡스톤**이에요.

## 1. 역할 분담 — 워커는 판정, leader는 출력

배선의 핵심은 "무엇을 병렬로, 무엇을 직렬로"를 정확히 가르는 거예요. 직렬 풀스캔의 `select_visit`을 보면 한 행에 네 가지를 해요:

```c
if (!row_visible(...)) return 0;        // ① MVCC 가시성 게이트
decode_row(schema, rec, row);           // ② 행 디코드
if (!where_matches(...)) return 0;      // ③ WHERE 평가
print_row(out, schema, row);            // ④ 출력
```

이 중 ①②③은 **읽기 전용**(스냅샷·스키마·WHERE 다 불변)이라 병렬로 돌려도 안전해요. 하지만 ④ `print_row`는 공유 `FILE*`에 쓰니 **동시에 하면 안 돼요.**

그래서 이렇게 갈랐어요:

- **워커(병렬)**: ①②③을 술어로 묶어, 매칭되는 **RID만** 모은다. 이게 뜨거운 CPU 작업이에요.
- **leader(직렬)**: 워커들이 모은 RID를 **페이지 순서**로 받아 ④ 출력만 한다.

출력이 한 스레드에서 페이지 순서로 나오므로, 결과가 **직렬 경로와 바이트 단위로 동일**해요. 그리고 이 구조 덕에 36편의 `parscan_collect`를 **한 글자도 안 고치고 그대로 재사용**합니다 — 술어가 매칭 RID를 페이지 순서로 주는 게 정확히 그 함수가 하는 일이니까요.

![병렬 스캔을 SELECT에 배선: 워커가 가시성+WHERE를 병렬 판정해 RID 수집, leader가 페이지 순서로 출력](/uploads/project/db-hobby/parallel-select.svg)

## 2. 술어 — 딱 하나의 함정: 서브쿼리

워커의 술어는 이게 전부예요:

```c
static int parsel_pred(RID rid, const void *rec, uint16_t len, void *ctx_) {
    ParSelCtx *c = ctx_;
    if (!row_visible(c->db, db_rec_xmin(rec), db_rec_xmax(rec), c->my_txn)) return 0;
    Value row[SQL_MAX_COLS];
    decode_row(c->schema, rec, row);
    return where_matches(c->schema, c->tname, c->where, row);   // ← 함정
}
```

`row_visible`은 순수 읽기예요(xmin/xmax와 내 스냅샷을 비교할 뿐, 아무것도 안 바꿈). `decode_row`도 순수하고요. 문제는 `where_matches` 하나예요:

> `WHERE v > (SELECT ...)` 처럼 **서브쿼리**가 들어가면, `where_matches`가 안쪽 쿼리를 실행하려고 **실행기를 재진입**해요. 실행기는 아직 스레드 안전하지 않으니, 여러 워커가 동시에 재진입하면 깨져요.

그래서 게이트를 둡니다. `WHERE`의 어느 조건이든 서브쿼리(`cond->sub != NULL`)를 품으면 **병렬을 포기하고 직렬로 폴백**해요. 서브쿼리 없는 WHERE(비교·`AND`/`OR`·`BETWEEN`·`LIKE`·`IN(값목록)`)만 병렬로 돕니다.

## 3. 게이트 — 언제 병렬로 가나

`exec_select`의 스트리밍 풀스캔 `else` 분기(인덱스 안 씀·`ORDER BY`/`LIMIT` 없음·`select_star`)에서, 이 조건이면 병렬:

```c
} else if (parallel_fullscan(db, t, tname, &sel->where, out, &count)) {
    /* 큰 테이블 + 서브쿼리 없는 WHERE -> 병렬 (count 채워짐) */
} else {
    /* 폴백: 직렬 풀 스캔 */
    heap_scan(&t->heap, select_visit, &ctx);
}
```

`parallel_fullscan`이 자격을 검사해요:

- **큰 테이블**: 힙 페이지 수 ≥ 16(`PARSCAN_MIN_PAGES`). 작은 테이블은 스레드 띄우는 오버헤드가 이득보다 커요. PostgreSQL의 `min_parallel_table_scan_size`와 같은 발상.
- **서브쿼리 없는 WHERE**(§2).
- 실패하면 조용히 **직렬 폴백** — 정확성은 늘 보장돼요.

이 게이트 덕에 **기존 645개 테스트는 전부 무회귀**예요. 대부분 테이블이 몇 페이지라 직렬 경로 그대로거든요. (설령 큰 테이블이 있어도 병렬 결과가 직렬과 바이트 동일하니 안전하고요.)

## 4. 검증 — 정확성 · MVCC · 레이스

`test_parexec`(신규, 10 checks)가 6,000행(18페이지) 테이블로 봐요.

**정확성**: 비인덱스 `WHERE v > 11990` → 5행(5996..6000, 페이지 순서), 복합 `WHERE v>10 AND v<30` → 9행, `WHERE` 없는 전체 → 6000행.

**MVCC가 병렬 경로에서도 그대로**:

```
  ok   병렬 full-scan: UPDATE된 새 버전만 보임(가시성 게이트)
  ok   병렬 full-scan: 옛 버전(v=200) 안 보임
  ok   병렬 full-scan: DELETE된 행 안 보임
  ok   병렬 full-scan: ROLLBACK된 삽입 안 보임
```

같은 `row_visible` 게이트를 워커가 부르니까요. **회귀 없음**: 작은 테이블은 직렬로 정확.

**레이스 부재**: `test_parexec_tsan`(엔진을 ThreadSanitizer로 빌드)이 같은 시나리오를 돌려 **data race 0**을 확인해요. 워커들이 `row_visible`·`where_matches`·`decode_row`를 동시에 불러도 안전하다는 진짜 증거예요. 전체는 **655 checks / 38스위트, FAIL 0.**

## 5. 남긴 프론티어

- **읽기 전용 스트리밍 SELECT만**: `ORDER BY`·집계·`DISTINCT`·조인은 각자 다른 경로(정렬 버퍼·해시 테이블·전역 `g_sort_*`)라 병렬 안 함. parallel aggregate / parallel hash join이 다음 수순.
- **서브쿼리 WHERE**: 실행기 재진입이라 직렬. 실행기를 재진입 가능(re-entrant)하게 만들면 풀려요.
- **engine_mtx 완전 제거**: 진짜 목표인 "서로 다른 트랜잭션 동시 실행"은 여전히 프론티어. 버퍼 풀(20편)·병렬 스캔(36)·이 배선(37)은 그 긴 여정의 발판들이에요 — 하나씩.

## 6. 마무리

- 36편이 지목한 발판을 밟아, 독립 병렬 스캔을 **실제 `SELECT`에 배선**했다(31·33·35편 계열의 캡스톤).
- 핵심은 **역할 분담**: 워커는 읽기 전용 판정(가시성+WHERE)을 병렬로, leader는 출력을 직렬로 — 결과가 직렬과 바이트 동일.
- 딱 하나의 함정 **서브쿼리 WHERE**(실행기 재진입)는 게이트로 제외, 자격 미달은 직렬 폴백 → 기존 645 테스트 무회귀.
- MVCC 가시성·DELETE·ROLLBACK이 병렬 경로에서도 그대로, 엔진 ThreadSanitizer 클린(data race 0)으로 실증.

<!-- EN -->

## 0. Intro — the Next Foothold Part 36 Named

Proving a parallel sequential scan as a **standalone module** in [Part 36](/blog/project/db-hobby/db-hobby-36-parallel-scan), I closed by naming the next foothold:

> "**Not wired into the executor**: wiring it into `exec_select`'s scan path needs the workers' `decode_row`/`rec_visible`/result-collection made thread-safe (with the leader doing output) — the next foothold."

This part takes it. Like [Part 31 (WAL replication)](/blog/project/db-hobby/db-hobby-31-replicated-db), [Part 33 (Raft SMR)](/blog/project/db-hobby/db-hobby-33-raft-replicated-db), and [Part 35 (LSM PK index)](/blog/project/db-hobby/db-hobby-35-lsm-pk-index), it's a **capstone wiring a standalone module into the real db.c engine.**

## 1. Division of Labor — Workers Judge, the Leader Prints

The core of the wiring is drawing the line between "parallel what, serial what." The serial full-scan's `select_visit` does four things per row:

```c
if (!row_visible(...)) return 0;        // ① MVCC visibility gate
decode_row(schema, rec, row);           // ② decode the row
if (!where_matches(...)) return 0;      // ③ WHERE evaluation
print_row(out, schema, row);            // ④ output
```

Of these, ①②③ are **read-only** (snapshot, schema, WHERE all immutable), so they're safe to run in parallel. But ④ `print_row` writes to a shared `FILE*`, so it **must not** be done concurrently.

So I split it:

- **Workers (parallel)**: bundle ①②③ into a predicate and collect just the matching **RIDs**. This is the hot CPU work.
- **Leader (serial)**: take the collected RIDs in **page order** and do only ④ output.

Since output comes from one thread in page order, the result is **byte-identical to the serial path.** And thanks to this shape, I reuse Part 36's `parscan_collect` **verbatim** — a predicate that yields matching RIDs in page order is exactly what that function does.

![Wiring the parallel scan into SELECT: workers judge visibility+WHERE in parallel and collect RIDs; the leader prints in page order](/uploads/project/db-hobby/parallel-select.svg)

## 2. The Predicate — the One Trap: Subqueries

The worker's predicate is all of this:

```c
static int parsel_pred(RID rid, const void *rec, uint16_t len, void *ctx_) {
    ParSelCtx *c = ctx_;
    if (!row_visible(c->db, db_rec_xmin(rec), db_rec_xmax(rec), c->my_txn)) return 0;
    Value row[SQL_MAX_COLS];
    decode_row(c->schema, rec, row);
    return where_matches(c->schema, c->tname, c->where, row);   // ← the trap
}
```

`row_visible` is a pure read (it only compares xmin/xmax against my snapshot, mutating nothing). `decode_row` is pure too. The problem is `where_matches` alone:

> When the WHERE holds a **subquery** like `WHERE v > (SELECT ...)`, `where_matches` **re-enters the executor** to run the inner query. The executor isn't thread-safe yet, so multiple workers re-entering at once breaks it.

So I add a gate. If any WHERE condition holds a subquery (`cond->sub != NULL`), it **gives up on parallel and falls back to serial.** Only subquery-free WHERE clauses (comparisons, `AND`/`OR`, `BETWEEN`, `LIKE`, `IN(value-list)`) run in parallel.

## 3. The Gate — When Do We Go Parallel

In `exec_select`'s streaming full-scan `else` branch (no index, no `ORDER BY`/`LIMIT`, `select_star`), it goes parallel when:

```c
} else if (parallel_fullscan(db, t, tname, &sel->where, out, &count)) {
    /* large table + subquery-free WHERE -> parallel (count filled in) */
} else {
    /* fallback: serial full scan */
    heap_scan(&t->heap, select_visit, &ctx);
}
```

`parallel_fullscan` checks eligibility:

- **Large table**: heap pages ≥ 16 (`PARSCAN_MIN_PAGES`). For small tables, thread-spawn overhead outweighs the gain — the same idea as PostgreSQL's `min_parallel_table_scan_size`.
- **Subquery-free WHERE** (§2).
- On any failure it quietly **falls back to serial** — correctness is always guaranteed.

Thanks to this gate, **all 645 existing tests stay green with no regression**: most tables are a few pages, so they take the serial path unchanged. (And even a large table would be safe, since the parallel result is byte-identical to serial.)

## 4. Verification — Correctness · MVCC · Races

`test_parexec` (new, 10 checks) uses a 6,000-row (18-page) table.

**Correctness**: index-less `WHERE v > 11990` → 5 rows (5996..6000, page order), compound `WHERE v>10 AND v<30` → 9 rows, no `WHERE` → 6000 rows.

**MVCC holds on the parallel path too**:

```
  ok   parallel full-scan: only the UPDATEd new version is visible (visibility gate)
  ok   parallel full-scan: the old version (v=200) is not visible
  ok   parallel full-scan: a DELETEd row is not visible
  ok   parallel full-scan: a ROLLBACKed insert is not visible
```

because workers call the same `row_visible` gate. **No regression**: small tables are correct on the serial path.

**No races**: `test_parexec_tsan` (the engine built with ThreadSanitizer) runs the same scenarios and confirms **zero data races.** That's the real evidence that workers calling `row_visible`/`where_matches`/`decode_row` concurrently is safe. The whole suite is **655 checks / 38 suites, FAIL 0.**

## 5. Frontiers Left

- **Read-only streaming SELECT only**: `ORDER BY`, aggregates, `DISTINCT`, and joins take their own paths (sort buffers, hash tables, the global `g_sort_*`), so no parallelism yet. Parallel aggregate / parallel hash join come next.
- **Subquery WHERE**: serial, because it re-enters the executor. Making the executor re-entrant unlocks it.
- **Full removal of engine_mtx**: the real goal, "different transactions running at once," is still the frontier. The buffer pool (Part 20), the parallel scan (36), and this wiring (37) are footholds on that long road — one at a time.

## 6. Wrap-up

- Took the foothold Part 36 named and **wired the standalone parallel scan into a real `SELECT`** (a capstone in the Part 31/33/35 line).
- The core is a **division of labor**: workers do the read-only judging (visibility + WHERE) in parallel; the leader does output serially — the result is byte-identical to serial.
- The one trap, a **subquery WHERE** (executor re-entry), is gated out, and ineligible queries fall back to serial → no regression across the 645 existing tests.
- MVCC visibility / DELETE / ROLLBACK hold on the parallel path too, shown race-free by ThreadSanitizer (zero data races).

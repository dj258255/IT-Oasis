---
title: '옵티마이저를 눈에 보이게 만들기 — EXPLAIN 짓기'
titleEn: 'Making the Optimizer Visible — Building EXPLAIN'
description: "관계형 DB를 C로 밑바닥부터 만든 db-hobby 시리즈 8편. 3편·5편에서 만든 플래너(인덱스 점조회/범위/풀스캔, 조인 방법 선택)는 실행 안에 숨어 보이지 않았습니다. EXPLAIN을 붙여 그 결정을 트리로 출력합니다. 핵심은 별도 추정기를 만들지 않고 실행기가 결정을 내리는 바로 그 지점에서 플랜을 찍는 것 — 그래서 플랜과 실제 실행이 절대 어긋나지 않습니다. 덤으로 ORDER BY나 LIMIT만 붙어도 인덱스가 꺼지는 db-hobby의 한계가 플랜에 정직하게 드러납니다. 규칙 기반 vs 비용 기반, EXPLAIN vs EXPLAIN ANALYZE를 실제 DB와 비교합니다."
descriptionEn: "Part 8 of building a relational database from scratch in C. The planner built in parts 3 and 5 (index point/range/scan, join-method choice) was invisible, buried inside execution. EXPLAIN prints those decisions as a tree. The key: don't build a separate estimator — emit the plan at the exact point the executor makes the decision, so the plan can never diverge from reality. As a bonus, db-hobby's limits (ORDER BY or LIMIT disabling the index) show up honestly in the plan. We compare rule-based vs cost-based and EXPLAIN vs EXPLAIN ANALYZE against real DBs."
date: 2026-06-04
tags:
  - C
  - Database Internals
  - Query Planner
  - EXPLAIN
  - Optimizer
  - Learning
category: study/db-hobby
coverImage: /uploads/project/db-hobby/cover.svg
draft: false
series: "db-hobby"
seriesOrder: 8
---

## 0. 들어가며 — 만든 결정을 보이게 하는 창

[3편](/blog/project/db-hobby/db-hobby-3-index-wal)에서 "PK 조건이면 인덱스 점 조회, 범위면 범위 스캔, 아니면 풀 스캔"이라는 플래너의 씨앗을 만들었어요. [5편](/blog/project/db-hobby/db-hobby-5-join-aggregate)에선 조인마다 인덱스·해시·중첩 루프 중 하나를 고르게 했습니다. 그런데 이 결정들은 전부 실행 코드 안에 숨어 있었어요. 쿼리를 던지면 결과 행만 나올 뿐, "그래서 인덱스를 쓴 거야 만 거야?"는 보이지 않습니다.

진짜 DB엔 그걸 보여주는 `EXPLAIN`이 있죠. 이번 편은 그걸 붙입니다. 그리고 미리 말해 두면, EXPLAIN은 새 기능이라기보다 **이미 만든 것을 보이게 하는 창**이에요. 3편·5편에서 내린 결정들은 줄곧 거기 있었지만, 실행 코드 안에 묻혀 눈에 안 띄었을 뿐입니다.

> **이번 편의 목표**: 플래너가 매 쿼리마다 무슨 생각을 하는지를 트리로 출력한다. 단, 추정기를 따로 만들지 않고 — 실행기가 결정을 내리는 바로 그 지점에서 플랜을 찍어, 플랜과 실제 실행이 구조적으로 어긋날 수 없게 한다.

## 1. 핵심 결정 — 추정하지 말고, 실행기에게 물어라

EXPLAIN을 만드는 방법은 크게 둘이에요.

| | 별도 추정기 | 결정 지점에서 찍기 (db-hobby 선택) |
|---|---|---|
| 방식 | WHERE를 보고 "아마 인덱스 쓰겠지" 따로 판단 | 실행기가 method를 정하는 그 줄 옆에서 출력 |
| 구현 난이도 | 처음엔 간단 | 실행기 안에 한 줄 끼우면 끝 |
| 시간이 지나면 | 실행기와 **어긋난다** | 실행기가 바뀌면 자동으로 따라 바뀜 |
| 위험 | "인덱스 쓴다"는데 실제론 풀 스캔인 거짓말쟁이 | 현재 구조에선 거짓말이 불가능 |

첫째 길 — **플랜을 따로 추정하는 코드**를 새로 짜는 것 — 은 간단해 보이지만 함정이 있어요. 그 추정 로직과 실제 실행기의 결정이 **시간이 지나며 어긋납니다.** 실행기를 고쳤는데 EXPLAIN 추정기를 안 고치면, 플랜은 "인덱스 쓴다"는데 실제론 풀 스캔을 도는 거짓말쟁이가 돼요 — 플랜을 따로 구현하면 실행기와 EXPLAIN이 서로 다른 규칙을 갖게 될 위험이 있는 거죠. (오해 방지: 진짜 PostgreSQL·MySQL의 EXPLAIN은 옵티마이저가 고른 그 계획을 그대로 보여주니 "실행과 다른" 게 아니에요. 실무에서 어긋나는 건 EXPLAIN의 *예상* 비용·행수와 실제값이고, 그건 `EXPLAIN ANALYZE`로 확인합니다.)

그래서 저는 둘째 길로 갔어요. **추정기를 따로 만들지 않고, 실행기가 결정을 내리는 바로 그 지점에서 플랜을 찍습니다.** 조인 방법을 고르는 코드는 이미 5편에 있죠. 거기서 `method[k]`를 다 정한 직후, 해시를 빌드하기 직전에 이 한 줄을 끼웠어요.

```c
/* 레벨별 method를 다 고른 직후 - EXPLAIN이면 여기까지의 결정만 찍고 끝낸다 */
if (sel->explain) {
    explain_join(out, sel, &m);
    return 0;
}
/* (아니면 계속) 해시 조인 레벨은 미리 해시를 빌드하고... */
```

단일 테이블도 똑같습니다. 실행기가 인덱스를 쓸지 말지 판정하는 `pk_cond` 로직과 **글자 그대로 같은 조건**을 EXPLAIN이 다시 평가해 출력해요. 실제로 단일 플랜 코드는 인덱스 선택의 핵심인 `sec_index_for`(어떤 보조 인덱스를 쓸지) 같은 헬퍼를 실행기와 그대로 공유합니다.

> **핵심 사실**: EXPLAIN은 결정을 따라 하지 않는다 — 결정을 내리는 코드 옆에 붙어, 그 결정을 그냥 받아 적는다. 그래서 (실행 중 재계획 같은 게 없는) 지금 구조에선 플랜과 실제 실행이 **어긋날 수가 없다.** 실행기가 바뀌면 EXPLAIN도 자동으로 따라 바뀐다.

## 2. 플랜은 트리다 — 위에서 아래로, 마지막 일에서 첫 일로

쿼리 실행은 파이프라인이에요. 스캔이 행을 뱉으면 -> WHERE가 거르고 -> 조인이 잇고 -> GROUP BY가 접고 -> ORDER BY가 정렬하고 -> LIMIT이 자릅니다. 그래서 플랜도 트리로 찍어요. 맨 위가 마지막에 일어나는 일(결과), 안으로 들어갈수록 먼저 일어나는 일입니다.

복잡한 쿼리 하나를 EXPLAIN해 보면 이렇게 나와요.

```sql
EXPLAIN SELECT users.name, COUNT(*) FROM users JOIN orders ON users.id = orders.uid
        WHERE users.id > 2 GROUP BY users.name ORDER BY 2 DESC LIMIT 5;
```

![EXPLAIN 플랜 트리 — Limit → Sort → GroupAggregate → Filter → Nested-Loop Join → (Seq Scan, Hash Join). 위가 마지막 일, 아래가 첫 일이라 실행은 아래에서 위로](/uploads/project/db-hobby/explain-plan-tree.svg)

아래에서 위로 읽으면 그대로 실행 순서예요. `users`를 훑고(Seq Scan), `orders`를 조인 컬럼으로 해시 빌드해 잇고(Hash Join), `users.id > 2`로 거르고(Filter), 이름으로 묶어 세고(GroupAggregate), 집계값으로 정렬하고(Sort), 위 5개만(Limit). 참고로 위는 **db-hobby의 출력 형태**예요 — 실제 PostgreSQL은 이런 행 필터를 보통 스캔 노드 밑(`Seq Scan` + `Filter`)으로 내려 붙입니다.

조인 레벨에 붙은 `Hash Join`은 5편에서 고른 그 방법입니다 — 안쪽 `orders`의 조인 키(`uid`)가 PK가 아니라서 인덱스 대신 해시를 빌드한 거예요. 만약 안쪽 조인 키가 PK였다면 거기엔 `Index Nested Loop`이 찍힙니다.

이 트리는 실행기와 공유하는 `xexplain_post`(후처리: Limit/Sort/GroupAggregate 등)와 접근 방법 노드(Seq Scan/Index Scan/조인)를 위에서 아래로 쌓아 만들어요. db-hobby가 출력하는 플랜 노드를 진짜 DB 용어와 나란히 놓으면 이렇습니다.

| db-hobby 노드 | 하는 일 | PostgreSQL 대응 |
|---|---|---|
| `Index Point Lookup` | PK 등식 점 조회 | Index Scan (= 조건) |
| `Index Range Scan` | PK 범위 스캔 | Index Scan / Index Range Scan |
| `Index Scan ... (recheck)` | 보조 인덱스 조회 후 재확인 | Bitmap/Index Scan + Recheck |
| `Seq Scan` | 풀 스캔(필터는 행마다) | Seq Scan + Filter |
| `Nested-Loop Join` | 다중 테이블 결합 | Nested Loop |
| `Hash Join -> t` | 안쪽에 해시 빌드 | Hash Join |
| `Index Nested Loop -> t` | 안쪽 PK 인덱스로 잇기 | Nested Loop + Index Scan |
| `GroupAggregate` / `Aggregate` | 묶어 세기 / 전체 집계 | GroupAggregate / Aggregate |
| `Sort` · `Limit` · `Unique` | 정렬 · 자르기 · DISTINCT | Sort · Limit · Unique |

## 3. 정직한 플랜 — ORDER BY가 인덱스를 끈다

EXPLAIN을 붙이고 나서 제일 재밌었던 건, db-hobby의 **한계가 플랜에 그대로 드러난다**는 점이었어요.

```
EXPLAIN SELECT * FROM users WHERE id = 2;
Index Point Lookup on users using id  (id = 2)

EXPLAIN SELECT * FROM users WHERE id = 2 LIMIT 1;
Limit  (limit=1)
  Seq Scan on users  (filter: id = 2)
```

같은 `WHERE id = 2`인데, `LIMIT`을 붙였더니 `Index Point Lookup`이 `Seq Scan`으로 바뀌었습니다. 이건 버그가 아니라 db-hobby의 실제 동작이에요. [3편](/blog/project/db-hobby/db-hobby-3-index-wal)에서 인덱스 경로를 "`SELECT *` 이고 `ORDER BY`/`LIMIT`/`OFFSET`이 없을 때"로만 좁게 열어 뒀기 때문입니다. 정렬·자르기가 끼면 행을 모았다가 후처리하는 다른 경로로 빠지면서, 그 경로는 인덱스를 안 써요. **이건 db-hobby의 현재 구현에서만 그렇습니다** — 진짜 DB는 오히려 반대예요. `ORDER BY id LIMIT 10`은 인덱스가 가장 잘 먹는 경우라(정렬된 인덱스를 앞에서 10개만 읽고 멈추면 되니까) 인덱스를 더 적극적으로 씁니다.

코드로 보면 이 조건은 한 줄에 그대로 박혀 있고, EXPLAIN과 실행기가 같은 줄을 평가합니다.

```c
/* 인덱스는 SELECT * + ORDER BY/LIMIT/OFFSET 없음 경로에서만 쓰인다(exec_select와 동일). */
int can_index = sel->select_star && sel->num_order == 0 && sel->limit < 0 && sel->offset <= 0;
```

말로 설명할 땐 흐릿했던 이 한계가, EXPLAIN으로 보니 한눈에 잡혔어요.

> **실무/면접 포인트**: "왜 이 쿼리가 느리지?"는 결국 "옵티마이저가 왜 인덱스를 안 썼지?"인 경우가 많고, 그 답을 눈으로 보게 해 주는 도구가 EXPLAIN이다. 실무에서 `WHERE`에 인덱스를 걸어 놓고도 함수로 감싸거나 형변환이 끼어 인덱스가 죽는 경우, EXPLAIN의 `type=ALL`(풀 스캔)이 그걸 일러바친다.

> 더 깊이: [DB 인덱스 ①: 인덱스 기초와 EXPLAIN 읽기](/blog/theory/db-index-01-explain-basics) — 실제 MySQL/PostgreSQL의 EXPLAIN을 어떻게 읽는지, `type`·`rows`·`key`가 뭘 말하는지. 그리고 [② 스캔의 종류와 옵티마이저의 선택](/blog/theory/db-index-02-scan-types) — 같은 쿼리라도 데이터 분포에 따라 인덱스와 풀 스캔 중 무엇이 빠른지를 옵티마이저가 어떻게 저울질하는지.

## 4. db-hobby가 안 한 것 — 비용 기반과 EXPLAIN ANALYZE

db-hobby의 플래너는 **규칙 기반(rule-based)** 이에요. "PK 등식이면 무조건 인덱스", "조인 키가 PK면 무조건 인덱스 NLJ" 같은 if 문 몇 개로 정해집니다. 진짜 DB는 여기서 한참 더 가요 — **비용 기반(cost-based)** 입니다. 두 방식을 나란히 두면:

| | 규칙 기반 (db-hobby) | 비용 기반 (PostgreSQL·MySQL) |
|---|---|---|
| 판단 근거 | 고정된 if 규칙 | 통계(행 수·값 분포) + 비용 모델 |
| "전체의 90% 걸리는 조건" | 그래도 인덱스 규칙대로 | 풀 스캔이 싸다고 계산해 풀 스캔 선택 |
| 통계 갱신 | 없음 | ANALYZE로 주기적 수집 |
| 같은 쿼리·다른 데이터 | 항상 같은 플랜 | 데이터 분포 따라 플랜이 바뀜 |

비용 기반은 테이블에 행이 몇 개고 값 분포가 어떤지(통계)를 들고, 인덱스를 타는 비용과 풀 스캔 비용을 숫자로 계산해 더 싼 쪽을 골라요. 그래서 대표적인 예로 "이 조건이면 전체의 90%가 걸리니 인덱스로 한 줄씩 찾느니 그냥 다 읽는 게 싸다"는 판단도 합니다 — 규칙 기반인 db-hobby는 못 하는 일이에요. (선택도는 비용 모델이 보는 여러 요소 중 하나일 뿐, 행 폭·클러스터링·랜덤 I/O·캐시·가시성도 함께 저울질합니다.)

또 하나, 진짜 DB의 `EXPLAIN ANALYZE`는 플랜을 **실제로 실행해** 예상 행 수와 실측 행 수, 실측 시간까지 나란히 보여줘요.

| | EXPLAIN (db-hobby·실DB) | EXPLAIN ANALYZE (실DB) |
|---|---|---|
| 쿼리 실행 | 안 함(플랜만) | 실제로 실행 |
| 보여주는 것 | 접근 방법·조인·순서 | + 예상 vs 실측 행 수, 실측 시간 |
| 잡아내는 것 | 어떤 경로를 탔는지 | 통계 오차("100행 예상 -> 100만 행 실제") |

"옵티마이저는 100행을 예상했는데 실제론 100만 행이었다" 같은 통계 오차를 잡는 핵심 도구예요. db-hobby의 EXPLAIN은 실행을 안 하는 쪽(추정만)이라 거기까진 못 갑니다. 하지만 db-hobby는 애초에 통계도, 비용 모델도 없으니 — 규칙 기반 플래너엔 규칙을 그대로 보여주는 EXPLAIN이 딱 맞는 짝이었어요.

> **주의**: 규칙 기반 EXPLAIN은 "내 규칙이 무엇인지"는 정직하게 보여주지만, "그 규칙이 이 데이터에서 빠른지"는 말해 주지 않는다. 그 판단은 통계와 비용 모델이 있어야 가능하고, 그게 비용 기반 옵티마이저가 db-hobby보다 한 차원 위인 지점이다.

## 5. 정리 — 자랑이 아니라 고백인 트리

EXPLAIN은 새 기능이라기보다 **이미 만든 것을 보이게 하는 창**이었어요. 3편·5편에서 내린 결정들은 줄곧 거기 있었지만, 실행 코드 안에 묻혀 눈에 안 띄었을 뿐입니다. 그 결정 지점 옆에 출력 한 줄을 끼우니, 플래너가 매 쿼리마다 무슨 생각을 하는지가 트리로 드러났어요. 핵심을 정리하면:

- **추정하지 말고 결정 지점에서 찍어라** — 실행기와 같은 로직(`sec_index_for`, `can_index` 등)을 공유하므로 플랜과 실행이 어긋날 수 없다.
- **플랜은 트리** — 위가 마지막 일(Limit/Sort), 안쪽이 첫 일(Scan/Join). 아래에서 위로 읽으면 실행 순서.
- **정직한 한계** — `ORDER BY`/`LIMIT`이 붙으면 인덱스 경로가 꺼지는 게 플랜에 그대로 드러난다.
- **규칙 기반의 짝** — 통계·비용 모델이 없으니 EXPLAIN ANALYZE까진 못 가지만, 규칙을 그대로 보여주는 EXPLAIN이 규칙 기반 플래너엔 딱 맞다.

그리고 그 트리는 자랑이 아니라 고백이었어요 — "나는 ORDER BY가 붙으면 인덱스를 못 써요"라고. 실행기를 만들던 단계가 "동작"이었다면, EXPLAIN은 그 동작을 **설명할 수 있게** 만드는 단계였어요. 만든 걸 재보는 게 [7편](/blog/project/db-hobby/db-hobby-7-benchmark)이었다면, 만든 걸 들여다보는 건 이 EXPLAIN입니다.

## 참고

- [PostgreSQL Documentation: Using EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html)
- [PostgreSQL Documentation: Planner/Optimizer](https://www.postgresql.org/docs/current/planner-optimizer.html)
- [MySQL Reference Manual: Optimizing Queries with EXPLAIN](https://dev.mysql.com/doc/refman/8.0/en/using-explain.html)
- 본 블로그: [DB 인덱스 ①: 인덱스 기초와 EXPLAIN 읽기](/blog/theory/db-index-01-explain-basics) · [DB 인덱스 ②: 스캔의 종류와 옵티마이저의 선택](/blog/theory/db-index-02-scan-types)
- [db-hobby 코드 (GitHub)](https://github.com/dj258255/db-hobby)

<!-- EN -->

## 0. Introduction — A Window That Makes Decisions Visible

In [Part 3](/blog/project/db-hobby/db-hobby-3-index-wal) we planted the seed of a planner: "PK equality -> index point lookup, range -> range scan, otherwise full scan." In [Part 5](/blog/project/db-hobby/db-hobby-5-join-aggregate) we let each join pick one of index / hash / nested loop. But all these decisions were buried inside the execution code. Fire a query and you only get result rows back — "so did it use the index or not?" stays invisible.

A real DB has `EXPLAIN` to show exactly that. This part adds it. And to say it up front: EXPLAIN is less a new feature than **a window that makes what you already built visible**. The decisions from Parts 3 and 5 were there all along — just hidden inside execution code, out of sight.

> **Goal of this part**: print, as a tree, what the planner is thinking on every query. But without building a separate estimator — emit the plan at the exact point the executor makes the decision, so the plan can never structurally diverge from reality.

## 1. The Key Decision — Don't Estimate, Ask the Executor

There are broadly two ways to build EXPLAIN.

| | Separate estimator | Emit at the decision point (db-hobby's choice) |
|---|---|---|
| Approach | look at WHERE and guess "probably uses index" | print right beside the line where the executor sets method |
| Difficulty | simple at first | one line dropped inside the executor |
| Over time | **drifts** from the executor | follows the executor automatically when it changes |
| Risk | a liar: says "uses index" while really full-scanning | impossible to lie in the current structure |

The first path — writing new code that **estimates the plan separately** — looks simple but has a trap. That estimation logic and the executor's actual decision **drift apart over time.** Fix the executor but not the EXPLAIN estimator, and the plan claims "uses index" while reality spins a full scan — a liar. That is, implementing the plan separately risks the executor and EXPLAIN ending up with different rules. (To avoid a misconception: real PostgreSQL/MySQL EXPLAIN shows the very plan the optimizer chose, so it is not "different from execution." What diverges in practice is EXPLAIN's *estimated* cost/rows vs the actual values, which you check with `EXPLAIN ANALYZE`.)

So I took the second path. **No separate estimator — print the plan at the exact point the executor makes the decision.** The code that picks the join method already lives in Part 5. Right after it sets every `method[k]`, just before building the hash, I slipped in this one line.

```c
/* Right after picking method per level - if EXPLAIN, print decisions so far and stop */
if (sel->explain) {
    explain_join(out, sel, &m);
    return 0;
}
/* (otherwise continue) hash-join levels build the hash first... */
```

Single-table is the same. EXPLAIN re-evaluates the **literally identical condition** as the executor's `pk_cond` logic that decides whether to use the index. The single-table plan code even shares helpers with the executor, like `sec_index_for` (which secondary index to use) — the heart of index selection.

> **Key fact**: EXPLAIN doesn't imitate the decision — it sits beside the code that makes the decision and just transcribes it. So in the current structure (no runtime re-planning) the plan and the real execution **cannot diverge.** Change the executor and EXPLAIN follows automatically.

## 2. A Plan Is a Tree — Top to Bottom, Last Thing to First Thing

Query execution is a pipeline. A scan emits rows -> WHERE filters -> the join stitches -> GROUP BY folds -> ORDER BY sorts -> LIMIT cuts. So the plan prints as a tree too. The top is what happens last (the result); deeper in is what happens first.

EXPLAIN one complex query and it comes out like this.

```sql
EXPLAIN SELECT users.name, COUNT(*) FROM users JOIN orders ON users.id = orders.uid
        WHERE users.id > 2 GROUP BY users.name ORDER BY 2 DESC LIMIT 5;
```

![EXPLAIN plan tree — Limit → Sort → GroupAggregate → Filter → Nested-Loop Join → (Seq Scan, Hash Join). The top is the last step, the bottom the first, so execution runs bottom to top](/uploads/project/db-hobby/explain-plan-tree.svg)

Read bottom to top and it is the execution order verbatim. Scan `users` (Seq Scan), stitch `orders` by building a hash on the join column (Hash Join), filter by `users.id > 2` (Filter), group by name and count (GroupAggregate), sort by the aggregate (Sort), keep the top 5 (Limit). Note this is **db-hobby's output shape** — real PostgreSQL usually pushes such a row filter down under the scan node (`Seq Scan` + `Filter`).

The `Hash Join` at the join level is the method picked back in Part 5 — `orders`'s join key (`uid`) is not a PK, so it builds a hash instead of using an index. Had the inner join key been a PK, `Index Nested Loop` would print there instead.

This tree is built by stacking, top to bottom, the post-processing nodes that EXPLAIN shares with the executor (`xexplain_post`: Limit/Sort/GroupAggregate etc.) and the access-method nodes (Seq Scan / Index Scan / join). Lining up db-hobby's plan nodes against real-DB terms:

| db-hobby node | What it does | PostgreSQL counterpart |
|---|---|---|
| `Index Point Lookup` | PK equality point lookup | Index Scan (= condition) |
| `Index Range Scan` | PK range scan | Index Scan / Index Range Scan |
| `Index Scan ... (recheck)` | secondary-index lookup then recheck | Bitmap/Index Scan + Recheck |
| `Seq Scan` | full scan (filter per row) | Seq Scan + Filter |
| `Nested-Loop Join` | multi-table join | Nested Loop |
| `Hash Join -> t` | build a hash on the inner | Hash Join |
| `Index Nested Loop -> t` | stitch via inner PK index | Nested Loop + Index Scan |
| `GroupAggregate` / `Aggregate` | grouped count / whole-table aggregate | GroupAggregate / Aggregate |
| `Sort` · `Limit` · `Unique` | sort · cut · DISTINCT | Sort · Limit · Unique |

## 3. An Honest Plan — ORDER BY Turns the Index Off

The most fun part after adding EXPLAIN was that db-hobby's **limits show up right in the plan.**

```
EXPLAIN SELECT * FROM users WHERE id = 2;
Index Point Lookup on users using id  (id = 2)

EXPLAIN SELECT * FROM users WHERE id = 2 LIMIT 1;
Limit  (limit=1)
  Seq Scan on users  (filter: id = 2)
```

Same `WHERE id = 2`, but adding `LIMIT` flipped `Index Point Lookup` into `Seq Scan`. This is not a bug; it is db-hobby's actual behavior. In [Part 3](/blog/project/db-hobby/db-hobby-3-index-wal) we opened the index path narrowly — only "when it's `SELECT *` and there's no `ORDER BY`/`LIMIT`/`OFFSET`." Once sorting or cutting enters, the query falls into a different path that gathers rows and post-processes, and that path doesn't use the index. **This is true only in db-hobby's current implementation** — real DBs do the opposite. `ORDER BY id LIMIT 10` is exactly where an index shines best (read the first 10 from the sorted index and stop), so they use the index more aggressively.

In code, that condition sits on one line, and EXPLAIN and the executor evaluate the same line.

```c
/* The index is used only on the SELECT * + no ORDER BY/LIMIT/OFFSET path (same as exec_select). */
int can_index = sel->select_star && sel->num_order == 0 && sel->limit < 0 && sel->offset <= 0;
```

This limit, hazy when described in words, snapped into focus once seen through EXPLAIN.

> **Practical/interview note**: "Why is this query slow?" often reduces to "Why didn't the optimizer use the index?", and EXPLAIN is the tool that lets you see the answer. In practice, when you put an index on a `WHERE` column but wrap it in a function or trip a type cast, the index dies — and EXPLAIN's `type=ALL` (full scan) snitches on it.

> Deeper: [DB Index ①: Index Basics and Reading EXPLAIN](/blog/theory/db-index-01-explain-basics) — how to read real MySQL/PostgreSQL EXPLAIN and what `type`·`rows`·`key` mean. And [② Scan Types and the Optimizer's Choice](/blog/theory/db-index-02-scan-types) — how the optimizer weighs index vs full scan for the same query depending on data distribution.

## 4. What db-hobby Didn't Do — Cost-Based Planning and EXPLAIN ANALYZE

db-hobby's planner is **rule-based.** It is decided by a few if statements like "PK equality -> always index", "join key is PK -> always index NLJ." A real DB goes much further — it is **cost-based.** Side by side:

| | Rule-based (db-hobby) | Cost-based (PostgreSQL·MySQL) |
|---|---|---|
| Basis for the choice | fixed if rules | statistics (row count, distribution) + cost model |
| "condition matching 90% of rows" | still follows the index rule | computes that full scan is cheaper, picks it |
| Statistics refresh | none | collected periodically via ANALYZE |
| Same query, different data | always the same plan | plan changes with data distribution |

Cost-based planning holds statistics — how many rows, how values are distributed — computes the cost of taking the index versus a full scan as numbers, and picks the cheaper one. So it can decide, as a representative example, "this condition matches 90% of the table, so rather than finding rows one by one through the index, just read everything" — something rule-based db-hobby cannot do. (Selectivity is only one of many factors the cost model weighs — row width, clustering, random I/O, cache, and visibility all go in too.)

One more thing: a real DB's `EXPLAIN ANALYZE` **actually runs** the plan and shows estimated rows, measured rows, and measured time side by side.

| | EXPLAIN (db-hobby·real DB) | EXPLAIN ANALYZE (real DB) |
|---|---|---|
| Runs the query | no (plan only) | yes, actually runs |
| Shows | access method, joins, order | + estimated vs measured rows, measured time |
| Catches | which path was taken | estimation error ("expected 100 rows -> actually 1M") |

It is the key tool for catching estimation errors like "the optimizer expected 100 rows but it was actually a million." db-hobby's EXPLAIN doesn't run the query (estimation only), so it can't go that far. But db-hobby has no statistics and no cost model to begin with — so an EXPLAIN that just shows the rules is the perfect match for a rule-based planner.

> **Caution**: a rule-based EXPLAIN honestly shows "what my rules are," but it does not tell you "whether those rules are fast on this data." That judgment requires statistics and a cost model — and that is exactly where a cost-based optimizer sits a tier above db-hobby.

## 5. Wrap-up — A Tree That's a Confession, Not a Boast

EXPLAIN was less a new feature than **a window that makes what you already built visible**. The decisions from Parts 3 and 5 were there all along, just buried in execution code. Slip one print line beside the decision point and the planner's per-query thinking unfolds as a tree. The key points:

- **Don't estimate, emit at the decision point** — sharing the executor's own logic (`sec_index_for`, `can_index`, etc.) means the plan and execution can't diverge.
- **A plan is a tree** — top is the last thing (Limit/Sort), inside is the first thing (Scan/Join). Read bottom to top for the execution order.
- **Honest limits** — when `ORDER BY`/`LIMIT` is added, the index path turning off shows up right in the plan.
- **The right match for rule-based** — without statistics or a cost model it can't reach EXPLAIN ANALYZE, but an EXPLAIN that shows the rules fits a rule-based planner perfectly.

And that tree was a confession, not a boast — "I can't use the index once there's an ORDER BY." If building the executor was the "doing" stage, EXPLAIN was the stage that made that doing **explainable**. If [Part 7](/blog/project/db-hobby/db-hobby-7-benchmark) measured what we built, this EXPLAIN looks inside it.

## References

- [PostgreSQL Documentation: Using EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html)
- [PostgreSQL Documentation: Planner/Optimizer](https://www.postgresql.org/docs/current/planner-optimizer.html)
- [MySQL Reference Manual: Optimizing Queries with EXPLAIN](https://dev.mysql.com/doc/refman/8.0/en/using-explain.html)
- This blog: [DB Index ①: Index Basics and Reading EXPLAIN](/blog/theory/db-index-01-explain-basics) · [DB Index ②: Scan Types and the Optimizer's Choice](/blog/theory/db-index-02-scan-types)
- [db-hobby on GitHub](https://github.com/dj258255/db-hobby)

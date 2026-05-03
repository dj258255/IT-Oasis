---
title: '데이터베이스 인덱스 ②: 스캔의 종류와 옵티마이저의 선택'
titleEn: 'Database Index ②: Scan Types and How the Optimizer Picks'
description: 인덱스가 있다고 모든 쿼리가 같은 방식으로 그 인덱스를 쓰는 건 아니에요. PostgreSQL의 Sequential / Index / Index-Only / Bitmap Scan 4가지 전략과, 옵티마이저가 통계 기반 셀렉티비티 추정으로 그 중 하나를 고르는 메커니즘을 1차 자료 기준으로 정리합니다. correlation, work_mem, BitmapAnd, Index Cond vs Filter까지.
descriptionEn: An index does not mean every query uses it the same way. Covers PostgreSQL's four scan strategies (Sequential / Index / Index-Only / Bitmap) and how the optimizer picks among them based on statistics-driven selectivity estimates — correlation, work_mem, BitmapAnd, Index Cond vs Filter — grounded in primary sources.
date: 2026-04-23T00:00:00.000Z
tags:
  - Database
  - Index
  - PostgreSQL
  - EXPLAIN
  - Bitmap Scan
  - Query Optimizer
  - Selectivity
  - Performance
category: theory/Database
draft: false
coverImage: "/uploads/theory/db-index/cover-2.svg"
series: "데이터베이스 인덱스"
seriesOrder: 2
---

## 0. 들어가며

인덱스 시리즈 2편이에요. [1편](/blog/theory/db-index-01-explain-basics)에서 *EXPLAIN을 읽는 법* 을 익혔다면, 이번 편은 **EXPLAIN에 등장하는 스캔 노드들의 메커니즘** 과 **옵티마이저가 그 중 무엇을 언제 선택하는가** 를 다룹니다. 같은 인덱스, 같은 데이터에서도 *쿼리 모양에 따라 plan이 달라지는 이유* 를 이해하는 편이에요.

핵심 메시지: **인덱스가 있다고 모든 쿼리가 같은 방식으로 그 인덱스를 쓰는 건 아니다.** PostgreSQL은 *Sequential Scan / Index Scan / Index-Only Scan / Bitmap Index Scan + Bitmap Heap Scan* 같은 여러 스캔 전략을 가지고 있고, 옵티마이저는 *통계 기반 셀렉티비티 추정* 에 따라 *비용이 가장 낮은 plan* 을 골라요. 셀렉티비티가 *매우 낮으면 Index Scan*, *매우 높으면 Seq Scan*, *중간이면 Bitmap Scan* — 이 스펙트럼이 핵심.

![인덱스 시리즈 2편 커버 — 셀렉티비티 스펙트럼](/uploads/theory/db-index/cover-2.svg)

> **글의 범위**: 이번 편은 *스캔의 종류와 선택 메커니즘* 까지. Index-Only Scan의 *진짜 IOS 조건*([Visibility Map과의 관계](/blog/theory/db-storage-03-hot-update-visibility-map))은 3편에서 deep dive하고, 복합 인덱스/AND/OR 동작은 4편에서 다룹니다.

## 1. 스캔이란 무엇인가

### Scan Node — 쿼리 plan의 가장 아래

PostgreSQL의 쿼리 plan은 *트리 구조* 예요. 가장 아래에 있는 노드가 **Scan Node** — *테이블이나 인덱스에서 raw row를 가져오는 단계*. 그 위에 sort, join, aggregate 같은 노드들이 쌓입니다.

이번 편에서 다룰 *스캔 노드 5종*:

1. **Sequential Scan (Seq Scan)** — 테이블 전체를 처음부터 끝까지 읽음
2. **Index Scan** — 인덱스에서 후보를 찾고 → 힙(테이블)으로 가서 행을 가져옴
3. **Index-Only Scan** — 인덱스만으로 답이 완료, 힙으로 안 감 (3편에서 deep dive)
4. **Bitmap Index Scan** — 인덱스 스캔으로 *페이지 비트맵* 을 만듦
5. **Bitmap Heap Scan** — 비트맵을 사용해 *페이지를 물리적 순서로* 읽음

이 중 **Bitmap Index Scan은 단독으로 최종 결과를 반환하지 않아요** — 보통 *상위 Bitmap Heap Scan에서 소비* 되며, 중간에 *BitmapAnd / BitmapOr* 가 끼기도 합니다. 사실상 *4가지 주요 전략* 이 있다고 보면 됩니다 — Seq, Index, IOS, Bitmap.

### 옵티마이저의 선택 — 셀렉티비티가 결정한다

옵티마이저는 *통계*(`pg_statistic`)를 기반으로 *각 plan의 cost를 추정* 하고 *가장 낮은 cost를 선택* 해요. 핵심 변수는 **셀렉티비티(selectivity)** — *조건이 매칭하는 행의 비율*. PostgreSQL 공식 문서가 정의하듯, *"WHERE 조건이 row의 얼마나 많은 부분을 통과시키는가"* 가 plan 결정의 출발점.

![셀렉티비티 스펙트럼 — 매칭 비율이 plan을 결정한다](/uploads/theory/db-index/selectivity-spectrum.svg)

다만 이건 *대략적 경향성* 이지 *고정 규칙은 아니에요*. **셀렉티비티는 출발점일 뿐이며, 실제 plan 선택은 cost 모델의 종합 계산 결과** 입니다 — *correlation(컬럼 값과 물리적 순서의 상관성), cost 파라미터(`seq_page_cost`/`random_page_cost`/`effective_cache_size`), 캐시 상태, row width, parallel 가능성* 등 여러 요소가 함께 작용해요.

> **1장 요약** — Scan Node는 plan tree의 가장 아래에서 *raw row를 가져오는 단계*. 옵티마이저는 *셀렉티비티* 에 따라 4가지 주요 전략(Seq / Index / IOS / Bitmap) 중 하나를 cost 기반으로 선택해요.

## 2. Sequential Scan — 테이블 전체 순차 읽기

### 동작

가장 단순한 스캔. *테이블의 첫 페이지부터 마지막 페이지까지* 차례대로 읽으면서 WHERE 조건으로 필터링.

```sql
EXPLAIN ANALYZE SELECT * FROM grades WHERE name = 'Z';
```

```
 Parallel Seq Scan on grades
   (cost=1000.00..125000.00 rows=10 width=20)
   (actual time=2845..3012 rows=8 loops=1)
   Filter: (name = 'Z')
   Rows Removed by Filter: 11000000
```

`Rows Removed by Filter: 11000000` — 1100만 행을 *전부 읽고* 필터로 걸러냈어요.

### 언제 선택되는가

직관과 다르게 — **Seq Scan이 항상 나쁜 건 아니에요**. 다음 경우 옵티마이저는 Seq Scan을 *적극적으로* 선택해요:

1. **인덱스가 없는 컬럼 조건**: 다른 선택지가 없으니 Seq Scan
2. **테이블이 매우 작음**: 인덱스 메타데이터 읽는 비용이 *전체 테이블 읽기* 보다 클 수 있음
3. **반환할 행이 많음**: 거의 모든 행이 매칭하면 *인덱스로 후보 찾기 + 힙 random IO* 가 *순차 IO* 보다 비쌈
4. **`SELECT *` + 모든 컬럼 인덱스 가정 무용**: 어차피 힙으로 가야 함

### Parallel Seq Scan

PostgreSQL은 *큰 테이블의 Seq Scan* 을 *병렬* 로 처리할 수 있어요 — 여러 worker 프로세스가 *테이블을 분할해서 동시에 스캔* 한 뒤 *Gather 노드* 가 결과를 합칩니다. 다만 *parallel 사용 여부* 는 옵티마이저가 *`parallel_setup_cost` / `parallel_tuple_cost` / `min_parallel_table_scan_size`(기본 8MB) / `max_parallel_workers_per_gather`* 를 종합해 결정 — *작은 테이블이거나 cost 이득이 없으면 parallel을 안 써요*. 또한 *모든 쿼리가 parallel 가능한 건 아닙니다* — `PARALLEL UNSAFE`로 표시된 함수, `SERIALIZABLE` 격리 수준, `FOR UPDATE` 같은 lock 절, cursor 사용은 parallel을 막아요.

> **2장 요약** — Seq Scan은 *테이블 전체 순차 읽기*. 인덱스 부재 / 작은 테이블 / 높은 셀렉티비티에서 선택돼요. Parallel Seq Scan은 *큰 테이블 + worker 띄울 만한 cost 이득* 이 있을 때만 사용.

## 3. Index Scan — 인덱스에서 찾고 힙으로 점프

### 동작

가장 직관적인 *인덱스 활용* 패턴:

1. *인덱스를 스캔* 해서 조건에 맞는 후보의 *위치(CTID)* 를 찾는다
2. 각 후보에 대해 *힙(테이블)으로 점프* 해서 실제 행을 읽는다
3. 필요한 컬럼을 반환

```sql
EXPLAIN ANALYZE SELECT name FROM employees WHERE id = 7;
```

```
 Index Scan using employees_pkey on employees
   (cost=0.43..8.45 rows=1 width=20)
   (actual time=0.012..0.045 rows=1 loops=1)
   Index Cond: (id = 7)
```

`Index Cond: (id = 7)` — 인덱스를 *id=7로 검색해서* 정확히 한 후보 찾음 → 힙으로 가서 *name 컬럼* 을 읽음.

### 핵심 비용 — 힙으로의 random IO

**Index Scan의 약점은 힙 접근의 random IO** 예요. 인덱스 자체는 정렬되어 있지만, *인덱스가 가리키는 힙 위치* 는 *디스크 상에서 흩어져 있을 수 있어요*. 매 행마다 *서로 다른 페이지* 로 점프하면, *순차 IO 대비 4배 비싼* random IO(`random_page_cost=4.0` 기본값)가 누적돼요.

![Index Scan vs Bitmap Scan — 같은 인덱스, 다른 IO 패턴](/uploads/theory/db-index/index-vs-bitmap.svg)

이 비용 때문에 **반환 행이 많아지면 Index Scan이 갑자기 비효율적** 이 돼요 — 정확히는 *행 수가 아니라 서로 다른 페이지 접근 수* 가 늘어나면서 random IO 비용이 누적됩니다 (같은 페이지에 여러 행이 모여 있거나 buffer cache hit이 있으면 실제 IO는 더 적을 수 있어요). 그래도 *행이 물리적으로 흩어져 있을수록* 비용은 빠르게 폭증.

### 언제 선택되는가

- **셀렉티비티가 매우 낮을 때**: 한두 행, 또는 0.x% 수준
- **`LIMIT`이 작은 경우**: 필요한 행이 *전체 중 몇 개* 라 random IO 누적 비용이 작음
- **점프가 physical order에 가까운 경우 (correlation 높음)**: 인덱스 순서와 힙 순서가 비슷하면 random IO가 *순차 IO처럼* 빨라짐 (`pg_stats.correlation`이 이를 추적). `CLUSTER table_name USING idx_name` 명령으로 *테이블을 인덱스 순서로 물리적 재배치* 해 correlation을 인위적으로 높일 수도 있어요 — 단 PostgreSQL 공식 문서가 명시하듯 *CLUSTER는 one-time 작업* 이고 *이후 INSERT/UPDATE는 clustering을 유지하거나 보장하지 않아요*. [HOT update](/blog/theory/db-storage-03-hot-update-visibility-map)는 *같은 페이지 안* 에서 새 버전을 만들 수 있어 *물리적 locality 훼손을 줄일 수는 있지만* clustering 순서 보장 메커니즘은 아닙니다.

> **3장 요약** — Index Scan은 *인덱스로 후보 찾고 힙으로 점프*. 약점은 *힙의 random IO 누적* 이라 *일반적으로 매우 낮은 셀렉티비티에서 가장 효율적* 이지만, 데이터 배치(correlation)나 캐시 상태에 따라 그 효율 범위는 *중간 셀렉티비티까지 확장* 될 수 있어요.

## 4. Bitmap Index Scan + Bitmap Heap Scan — 중간 지점

### 왜 필요한가

*Index Scan은 너무 많고 Seq Scan은 너무 적은 중간 지점* 에서 옵티마이저가 선택하는 *하이브리드 전략*. PostgreSQL 공식 문서가 직접 *"Like an index scan, it scans an index... but like a sequential scan, it takes advantage of data being easier to read in bulk"* 라고 표현해요.

### 동작

두 단계로 나뉩니다:

**1단계 — Bitmap Index Scan**

- 인덱스를 스캔해 조건에 맞는 *행들의 위치* 를 찾음
- 결과를 *행 하나하나로 반환하지 않고* — *페이지 기반 비트맵* 으로 만든다 (PostgreSQL의 TIDBitmap 구조)
- *정상적인 exact bitmap* 은 *페이지 단위 chunk + 그 안에서 tuple offset bitmap* 까지 기억 — 즉 *어느 페이지의 어느 row가 매칭하는지 정확히* 추적. PostgreSQL 내부 구조로는 *PageTableEntry per page* 에 *최대 256개 tuple bitmap* (8KB 페이지 기준)
- *`work_mem`이 부족* 하면 일부 chunk가 *lossy 모드* 로 축약 — *페이지 단위로만* 기억하고 tuple offset은 버림 (이 경우 heap에서 페이지 전체를 읽고 재검증해야 함)

**2단계 — Bitmap Heap Scan**

- 비트맵의 페이지들을 *물리적 페이지 번호 순서대로* 읽음 → **완전한 순차 IO는 아니지만, 페이지 접근을 정렬해 random IO를 크게 줄이는 방식** (흩어진 random 접근보다 훨씬 효율적)
- *lossy 페이지* 에서는 페이지 내 *조건을 만족하지 않는 행* 을 다시 필터링 (`Recheck Cond`)

```sql
EXPLAIN ANALYZE
SELECT * FROM customer_records
WHERE state_code = 'KS' AND gender = 'F';
```

```
 Bitmap Heap Scan on customer_records
   (cost=835.78..8669.29 rows=49226 width=12)
   Recheck Cond: (state_code = 'KS')
   Filter: (gender = 'F')
   Heap Blocks: exact=6370
   ->  Bitmap Index Scan on idx_state_code
         (cost=0.00..823.48 rows=97567 width=0)
         Index Cond: (state_code = 'KS')
```

해석:

- `Bitmap Index Scan`이 먼저 실행 → 인덱스에서 *state_code='KS'* 후보 페이지 비트맵 생성
- `Bitmap Heap Scan`이 *비트맵에 표시된 페이지들을 물리적 순서로* 읽음
- `Recheck Cond` — *exact 비트맵* 에서는 plan에 표시만 되고 실제로 의미 있는 row 제거는 거의 발생하지 않음. *진짜로 작동하는 경우* 는 (1) **lossy bitmap** (`work_mem` 부족으로 비트맵이 *페이지 단위* 로 축약된 경우) — 페이지 내 어느 행이 매칭하는지 모르므로 *전체 페이지 fetch + 행마다 재검증*, (2) **lossy index type** (예: GiST/BRIN — 인덱스가 후보를 *대략* 반환하므로 정확한 매칭 재검증 필요)
- `Heap Blocks: exact=6370` — 6,370개 페이지를 읽음

### 다중 인덱스 결합 — BitmapAnd / BitmapOr

Bitmap Scan의 *진짜 강력한 능력* 은 **여러 인덱스의 비트맵을 결합** 할 수 있다는 점이에요:

```sql
EXPLAIN SELECT * FROM test
WHERE a = 100 AND b = 100;
```

```
 Bitmap Heap Scan on test
   ->  BitmapAnd
         ->  Bitmap Index Scan on idx_a
               Index Cond: (a = 100)
         ->  Bitmap Index Scan on idx_b
               Index Cond: (b = 100)
```

![BitmapAnd — 두 인덱스의 비트맵을 교집합으로 결합](/uploads/theory/db-index/bitmapand-flow.svg)

해석:

- `idx_a` 비트맵 + `idx_b` 비트맵을 *AND 연산* 해 *둘 다 만족하는 페이지* 만 남김
- 그 결합된 비트맵으로 한 번만 힙 접근

`OR` 조건이면 `BitmapOr`로 *합집합* 비트맵 생성. 즉 **단일 인덱스로는 못 풀 쿼리도 여러 인덱스 결합으로 효율적으로 처리** 가능.

### 언제 선택되는가

- **중간 셀렉티비티**: 수~수십 %. Index Scan은 random IO가 너무 많고, Seq Scan은 너무 많이 읽음
- **다중 인덱스 결합 가능**: 두 컬럼에 각각 인덱스가 있고 AND/OR로 묶인 쿼리
- **인덱스 후보가 많지만 페이지 수는 적당히 적은 경우**: 비트맵의 페이지 단위 묶기가 효과적

### Recheck Cond와 lossy bitmap

`Recheck Cond`가 plan에 표시되는 게 *항상 의미 있는 작업* 은 아니에요. **진짜로 row 제거가 일어나는 경우는 두 가지**:

**1. lossy bitmap (work_mem 부족)**

**정상적인 exact bitmap은 페이지 단위로 관리되며, 각 페이지 안에서 어떤 tuple이 매칭되는지 비트로 표시해요.** PostgreSQL 내부 구조로는 *PageTableEntry per page* (페이지마다 한 chunk) + *그 chunk 안에 tuple offset bitmap* (8KB 페이지에 최대 256 tuples). 즉 *순수한 행 단위 비트 배열이 아니라 — 페이지 기반 + 페이지 안에서 tuple 위치까지 정확히 추적* 하는 두 단계 구조. `work_mem`이 부족하면 PageTableEntry 일부가 *lossy로 축약* 되고 — 이 경우 *tuple offset bitmap을 버리고 페이지 단위로만* 기억하므로 heap에서 *전체 페이지 fetch + 각 행 재검증* 이 필요해요. 여기서 진짜 `Recheck Cond` 비용이 발생.

EXPLAIN 출력의 `Heap Blocks: exact=N lossy=M`이 결정적 신호 — `lossy > 0`이면 `work_mem`을 늘리는 게 첫 처방. `Rows Removed by Index Recheck: N`도 같이 보면 lossy로 인한 비효율을 정량화 가능.

**2. lossy index type (GiST, BRIN 등)**

GiST나 BRIN 같은 인덱스는 *후보를 대략적으로만* 반환해요 — 예: BRIN은 *블록 범위 요약* 이라 *값 범위가 겹치는 블록의 모든 행* 을 후보로 던지고, 진짜 매칭은 heap에서 재확인해야 함. 이 경우 `Recheck Cond`가 *항상* 의미 있는 작업.

> B-tree + exact bitmap에서는 lossy bitmap에 비해 recheck 비용이 작아요. 다만 *인덱스 타입(GIN/GiST/BRIN)이나 추가 조건* 에 따라 *exact pages인데도* `Rows Removed by Index Recheck`가 나타나는 케이스가 있어요 (PostgreSQL 메일링 리스트에 사례 보고됨). 즉 *Recheck Cond의 실제 비용은 plan만으로 추정하지 말고 EXPLAIN ANALYZE의 `Rows Removed by Index Recheck`로 확인* 해야 합니다.

### Index Cond vs Filter — 미묘한 차이

EXPLAIN 출력에서 `Index Cond`와 `Filter`는 *겉모양은 비슷해 보여도 의미가 달라요*:

- **`Index Cond`** — *인덱스 자체로 후보를 좁히는* 조건. B-tree에서 *범위를 줄이는 access predicate*
- **`Filter`** — *후보 행을 가져온 뒤 적용하는* 조건. 인덱스로 좁히지 못해 *모든 후보 행* 에 대해 평가

![Index Cond vs Filter — access predicate vs filter predicate](/uploads/theory/db-index/index-cond-vs-filter.svg)

```
 Index Scan using idx_a on test
   Index Cond: (a = 100)
   Filter: (b = 100)        -- 인덱스로 못 좁힘, heap에서 행마다 재평가
```

여기서 `b = 100`은 *모든 a=100 후보 행을 가져온 뒤* 적용. *후보가 많으면 비효율* 이라 *복합 인덱스로 풀어야 할 신호* (4편에서 deep dive).

> **4장 요약** — Bitmap Scan은 *Index Scan과 Seq Scan의 중간*. 페이지 단위 비트맵을 *물리적 순서로 읽기* 하고 *여러 인덱스 결합* 가능. `Recheck Cond`는 *lossy bitmap 또는 lossy index* 에서만 진짜 비용이 발생하며, `Heap Blocks: lossy > 0`이면 `work_mem` 부족 신호. `Index Cond` vs `Filter`는 *인덱스 활용 vs heap 재평가* 의 차이.

## 5. Index-Only Scan — 힙으로 안 가는 최선의 경우

### 동작

인덱스 안에 *쿼리가 필요한 모든 컬럼* 이 들어있으면, 힙으로 안 가도 답을 만들 수 있어요. *진짜 최선의 plan*.

```sql
EXPLAIN ANALYZE SELECT id FROM grades WHERE id = 7;
```

```
 Index Only Scan using grades_pkey on grades
   (cost=0.43..8.45 rows=1 width=4)
   (actual time=0.005..0.005 rows=1 loops=1)
   Index Cond: (id = 7)
   Heap Fetches: 0
```

`Heap Fetches: 0` — 힙 접근 0번. 인덱스만으로 답 완료.

### 진짜 IOS의 조건은 까다롭다

**`Index Only Scan` 노드가 plan에 잡혔다고 진짜 IOS는 아니에요.** PostgreSQL의 IOS는 [Visibility Map(VM)](/blog/theory/db-storage-03-hot-update-visibility-map)과 협업해야 진정한 효과를 봐요 — VM이 *해당 페이지가 모든 트랜잭션에 visible* 이라고 표시한 경우에만 *힙 접근을 생략* 할 수 있어요. VM이 *최신이 아니면* `Heap Fetches > 0`가 되어 *결국 힙으로 가야 합니다*.

이 메커니즘은 **3편에서 deep dive** 합니다 ([스토리지 ③편의 Visibility Map](/blog/theory/db-storage-03-hot-update-visibility-map) 내용과 통합). 이번 편에서는 *`Heap Fetches` 값이 IOS의 진짜 효율을 보여준다* 는 점만 기억하면 돼요.

### Covering Index — INCLUDE로 IOS 만들기

기본적으로 인덱스에는 *키 컬럼* 만 들어가요. *추가 컬럼* 까지 인덱스에 포함시키면 IOS 가능 범위가 넓어집니다 — `INCLUDE` 절을 써요:

```sql
CREATE INDEX idx_grades_id_name
ON grades(id) INCLUDE (name);
```

이러면 `SELECT id, name FROM grades WHERE id = 7`도 *인덱스만으로* 답할 수 있어요 (id가 검색 키, name이 비검색 데이터). 이걸 *Covering Index* 라 부르고, **3편에서 INCLUDE 절의 트레이드오프와 함께 deep dive** 합니다.

### 언제 선택되는가

- **쿼리에 필요한 모든 컬럼이 인덱스에 있음** (covering index)
- **VM이 최신**: VACUUM이 잘 돌고 있어 *visible 표시가 정확*
- **`SELECT *` 같은 패턴이 아님**: 모든 컬럼 요구는 IOS 거의 불가능

> **5장 요약** — IOS는 *힙 접근 없이 인덱스만으로 답 완료* 하는 최선의 plan. 다만 *VM 최신성* 조건이 있어 `Heap Fetches > 0`이면 진짜 IOS가 아니에요. 3편에서 자세히 다룹니다.

## 6. 옵티마이저는 어떻게 인덱스를 선택하는가

### 통계 기반 셀렉티비티 추정

옵티마이저의 *모든 결정의 출발점* 은 셀렉티비티 추정. 이를 위해 PostgreSQL은 *각 컬럼* 에 대해 다음 통계를 유지해요 (`pg_statistic`, 사용자용 뷰는 `pg_stats`):

- **`reltuples` / `relpages`**: 테이블 전체 행 수, 페이지 수
- **`n_distinct`**: 컬럼의 고유값 수
- **`null_frac`**: NULL 비율
- **`most_common_vals` (MCV)**: 가장 자주 나오는 값들과 빈도
- **`histogram_bounds`**: MCV에 없는 값들의 분포 (default 100 buckets)
- **`correlation`**: 컬럼 값 순서와 *물리적 디스크 순서* 의 상관성 (-1~1)

이 통계는 *`ANALYZE` 명령* 이나 *autovacuum의 자동 분석* 으로 갱신돼요. **통계가 부정확하면 plan이 망가져요** — [1편](/blog/theory/db-index-01-explain-basics)에서 봤듯 *추정 vs 실측 격차* 가 진단 신호.

### 다중 인덱스 — 어떤 걸 쓸까

여러 컬럼에 각각 인덱스가 있는 경우, 옵티마이저는 세 가지 시나리오를 검토해요:

**시나리오 1 — 두 인덱스 모두 사용 (BitmapAnd/BitmapOr)**

각각의 인덱스를 비트맵으로 만들어 결합. *AND 조건이고 두 인덱스 모두 적당히 셀렉티브* 할 때 효과적.

**시나리오 2 — 한 인덱스만 사용 + 추가 필터**

더 셀렉티브한 인덱스 하나만 사용해 후보를 줄이고, 다른 조건은 *필터* 로 처리.

```
 Index Scan using idx_a on test
   Index Cond: (a = 100)
   Filter: (b = 100)
```

`Index Cond`는 *인덱스로 직접 필터링*, `Filter`는 *힙에서 가져온 행에 대해 필터링*. AND 조건에서 *셀렉티브한 쪽이 인덱스로*, 나머지는 *필터* 로 처리되는 패턴.

**시나리오 3 — 둘 다 안 씀**

두 인덱스 모두 너무 많은 행을 반환하면 *그냥 Seq Scan*. *통계 기반* 으로 *cost가 가장 낮은 plan* 이 결정돼요.

### AND vs OR — 동작 차이

옵티마이저의 결정에 *AND인지 OR인지* 가 결정적이에요:

- **AND**: *교집합* — 한쪽만 *충분히 셀렉티브* 하면 *그 인덱스만 사용* 하고 나머지는 Filter로 처리되는 경우가 많아요. 다만 *두 조건 모두 적당히 셀렉티브* 하면 *BitmapAnd로 결합* 하는 게 더 효율적인 경우도 있어 옵티마이저가 cost로 결정.
- **OR**: *합집합* — 어느 한쪽이라도 매칭하는 행이 모두 결과. *모든 관련 인덱스를 다 봐야* 함. 결과적으로 *Bitmap Scan + BitmapOr* 가 자연스럽거나, 아예 *Seq Scan* 이 더 효율적일 수도 있어요.

**4편에서 복합 인덱스 + AND/OR** 를 더 자세히 다룹니다.

### 옵티마이저가 인덱스를 안 쓰는 이유

- **함수/표현식 적용**: `WHERE LOWER(name) = 'z'` — 함수 인덱스를 따로 만들어야 함
- **LIKE 시작 와일드카드**: `WHERE name LIKE '%Z%'` — B-tree로 해결 불가
- **암묵적 타입 변환**: `WHERE id::TEXT = '100'` — 인덱스가 *원본 타입* 에 만들어졌으므로 적용 불가
- **너무 많은 행 반환 예상**: 통계상 *Seq Scan이 더 싸다* 고 판단
- **통계가 stale**: `ANALYZE` 안 돌아 *옵티마이저가 잘못된 가정*

> **6장 요약** — 옵티마이저는 *통계 기반 셀렉티비티 추정* 으로 plan을 결정해요. 다중 인덱스는 *결합 / 단일 사용 / 둘 다 무시* 세 시나리오 중 cost가 낮은 것이 선택되며, AND vs OR로 동작이 크게 달라집니다. *함수/와일드카드/타입 변환* 이 인덱스 사용을 막는 흔한 패턴.

## 7. 실전 — 같은 인덱스, 다른 plan

같은 테이블, 같은 인덱스에서 *조건 형태에 따라 plan이 달라지는* 예를 봐요. `grades` 테이블에 *G(grade)* 에 인덱스가 있고 *id* 에는 PK 인덱스가 있어요.

### 패턴 1 — 매우 셀렉티브한 조건 → Index Scan

```sql
EXPLAIN SELECT name FROM grades WHERE id = 1000;
```

```
 Index Scan using grades_pkey on grades
   Index Cond: (id = 1000)
```

한 행. Random IO 1번. → Index Scan 선택.

### 패턴 2 — 중간 셀렉티비티 → Bitmap Scan

```sql
EXPLAIN SELECT name FROM grades WHERE g > 95;
```

```
 Bitmap Heap Scan on grades
   Recheck Cond: (g > 95)
   ->  Bitmap Index Scan on idx_g
         Index Cond: (g > 95)
```

대략 5% 수준의 행이 매칭. 이 정도 셀렉티비티에서 *Index Scan은 random IO 부담이 크고*, *Seq Scan은 95%를 버려야 하는 낭비* 가 있어 Bitmap이 합리적인 선택지가 돼요 (정확한 임계값은 데이터 분포/cost 설정에 따라 달라져요).

### 패턴 3 — 너무 많은 행 → Seq Scan (인덱스가 있어도)

```sql
EXPLAIN SELECT name FROM grades WHERE id > 100;
```

```
 Seq Scan on grades
   Filter: (id > 100)
```

거의 모든 행이 매칭. → 인덱스 무시하고 Seq Scan.

### 패턴 4 — 다중 인덱스 결합 → BitmapAnd

```sql
EXPLAIN SELECT * FROM grades WHERE g > 95 AND id < 10000;
```

```
 Bitmap Heap Scan on grades
   ->  BitmapAnd
         ->  Bitmap Index Scan on idx_g
               Index Cond: (g > 95)
         ->  Bitmap Index Scan on grades_pkey
               Index Cond: (id < 10000)
```

두 인덱스 모두 적당히 셀렉티브. 결합으로 *결과가 더 작아짐*.

### 패턴 5 — 함수 적용 → 인덱스 못 씀

```sql
EXPLAIN SELECT name FROM grades WHERE LOWER(name) = 'z';
```

```
 Seq Scan on grades
   Filter: (lower(name) = 'z')
```

인덱스가 *name* 에 있어도 — *LOWER(name)에는* 없음. 함수 인덱스가 필요하거나, 데이터를 미리 소문자로 저장해야 합니다.

> **7장 요약** — 같은 인덱스가 있어도 *조건의 셀렉티비티 + 형태* 에 따라 *Index / Bitmap / Seq* plan이 갈려요. 함수/표현식은 *원본 인덱스를 무력화* 시킵니다.

## 8. 정리

### 핵심 통찰

- **PostgreSQL의 4가지 주요 스캔**: Sequential / Index / Index-Only / Bitmap. *Bitmap은 Index Scan과 Seq Scan의 중간*. **Bitmap Index Scan은 단독으로 결과를 내지 않고**, 보통 BitmapAnd/BitmapOr를 거쳐 *Bitmap Heap Scan에서 소비* 된다.
- **선택의 기준은 셀렉티비티**: 매우 낮으면 Index Scan, 매우 높으면 Seq Scan, 중간이면 Bitmap. 정확한 임계값은 *cost 모델 + 데이터 분포 + correlation + 캐시 상태* 에 따라 달라진다.
- **Index Scan의 약점은 힙 random IO 누적**: *서로 다른 페이지 접근 수* 가 누적 비용을 결정. *correlation 높거나 cache hit 많으면* 효율 범위가 중간 셀렉티비티까지 확장될 수 있음.
- **Bitmap Scan의 본질은 random IO를 물리적 순서로 정렬해 크게 줄이기**: 페이지 단위 비트맵을 *물리적 순서로 읽기*. `Recheck Cond`는 *lossy bitmap(work_mem 부족) 또는 lossy index type* 에서만 진짜 비용 — `Heap Blocks: lossy > 0`이 신호.
- **다중 인덱스 결합 (BitmapAnd / BitmapOr)**: 단일 인덱스로 못 풀 쿼리도 *여러 인덱스의 비트맵 결합* 으로 효율 가능.
- **IOS는 진짜 IOS여야 효과**: `Heap Fetches: 0`이어야 함. VM 최신성 조건은 3편에서.
- **옵티마이저의 통계 기반 결정은 한계가 있다**: stale 통계, 컬럼 상관관계, 함수/와일드카드, 타입 변환이 *plan을 망가뜨리는 흔한 원인*.

### 진짜 한 줄

> **인덱스가 있어도 어떻게 쓰일지는 셀렉티비티가 결정한다.** PostgreSQL의 스캔 전략은 *Index Scan만 있는 게 아니라* Seq / Index / IOS / Bitmap 4가지 스펙트럼이고, *옵티마이저는 그 중 가장 싼 것을 고를 뿐* 이다.

### 통합된 답 — 한 단락 정리

PostgreSQL은 *Sequential Scan / Index Scan / Index-Only Scan / Bitmap Index Scan + Bitmap Heap Scan* 등 여러 스캔 전략을 가지고 있고, 옵티마이저는 *통계 기반* 으로 *cost가 가장 낮은 plan* 을 골라요. *셀렉티비티가 가장 중요한 변수지만 유일한 변수는 아니며*, correlation/cost 파라미터/캐시 상태/row width/parallel 가능성이 함께 작용합니다. **Seq Scan** 은 인덱스 없거나/작은 테이블/높은 셀렉티비티에서 선택되며 *parallel 가능* (단 PARALLEL UNSAFE 함수, SERIALIZABLE, FOR UPDATE 등은 막음). **Index Scan** 은 *인덱스로 후보 찾고 힙으로 random IO로 점프* 하는 패턴이라 *일반적으로 매우 낮은 셀렉티비티에서 가장 효율적* 이지만 — 정확히는 *서로 다른 페이지 접근 수* 가 누적 비용을 결정하므로 correlation이 높거나 cache hit이 많으면 *중간 셀렉티비티(예: 5%)에서도 충분히 효율적* 일 수 있어요. correlation이 높을수록 Index Scan 효율이 올라가고 `CLUSTER`로 인위적으로 높일 수도 있지만 *one-time 작업* 이라 이후 INSERT/UPDATE는 정렬을 보장하지 않아요. **Bitmap Scan** 은 *Index와 Seq의 중간 지점* 에서 *비트맵* 을 만들어 *완전한 순차 IO는 아니지만 페이지 접근을 정렬해 random IO를 크게 줄이고*, *BitmapAnd / BitmapOr* 로 *여러 인덱스 결합* 까지 가능합니다. *exact bitmap* 은 *페이지 + tuple offset까지* 정확히 추적하지만 *work_mem 부족* 하면 *lossy(페이지 단위)로 축약* 되어 `Recheck Cond`가 진짜 비용 발생 — `Heap Blocks: lossy > 0`이 결정적 신호. lossy index type(GIN/GiST/BRIN)이나 추가 조건에서도 recheck가 의미 있을 수 있어 `Rows Removed by Index Recheck`로 확인이 정확. **Bitmap Index Scan은 단독으로 결과를 내지 않고** 보통 BitmapAnd/BitmapOr를 거쳐 *Bitmap Heap Scan에서 소비* 됩니다. `Index Cond` vs `Filter`는 *인덱스 활용 범위 vs heap 재평가* 의 차이라 후자가 많으면 *복합 인덱스 신호*. **Index-Only Scan** 은 *인덱스만으로 답 완료* 하는 최선의 plan이지만 *Visibility Map 최신성* 이 조건이라 `Heap Fetches: 0`이어야 진짜 IOS예요 (3편 deep dive). 다중 인덱스 환경에서는 *결합 / 단일 사용 / 둘 다 무시* 시나리오 중 cost가 낮은 것이 선택되며, **AND vs OR** 로 동작이 갈립니다 — AND는 *한쪽만 충분히 셀렉티브* 하면 단일 인덱스 + Filter, *둘 다 적당히 셀렉티브* 면 BitmapAnd. OR는 *모든 인덱스를 봐야* 함. 함수/표현식 적용, LIKE 시작 와일드카드, 암묵적 타입 변환은 *원본 인덱스를 무력화* 시키는 흔한 패턴. *EXPLAIN으로 plan 노드 종류를 확인* 해 *옵티마이저의 실제 선택* 을 검증하는 게 튜닝의 출발점이에요.

### 글의 범위와 한계

이 글은 *PostgreSQL 기준* 이에요. 스캔 노드의 종류와 명칭은 DBMS마다 달라요 — MySQL의 `EXPLAIN`은 *type 컬럼* 에 `ALL` (Seq Scan 해당), `index`, `range`, `ref`, `eq_ref`, `const` 같은 값으로 표현하고, *Bitmap Index Scan은 PostgreSQL 특유의 메커니즘* 입니다 (MySQL InnoDB는 비슷한 효과를 *Index Merge* 로 처리). 다만 *옵티마이저가 셀렉티비티 기반으로 plan을 결정한다* 는 본질은 모든 RDBMS에 공통이고, 사고법 자체는 이식 가능해요.

또한 이번 편은 *cost 계산의 정확한 공식* 은 다루지 않았어요 — `seq_page_cost`, `random_page_cost`, `cpu_tuple_cost`, `cpu_index_tuple_cost`, `cpu_operator_cost` 같은 cost 모델 상수의 *상세한 조합 공식* 은 PostgreSQL 공식 문서 *Section 14.2 Statistics Used by the Planner* 와 *Section 19.7 Query Planning* 을 참고.

### 참고 (1차 자료 우선)

- [PostgreSQL Documentation — Using EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html) — 스캔 노드 출력 해석
- [PostgreSQL Documentation — Statistics Used by the Planner](https://www.postgresql.org/docs/current/planner-stats.html) — pg_statistic, pg_stats, MCV, histogram
- [PostgreSQL Documentation — Row Estimation Examples](https://www.postgresql.org/docs/current/row-estimation-examples.html) — 셀렉티비티 계산의 실제 예시
- [PostgreSQL Documentation — Planner/Optimizer](https://www.postgresql.org/docs/current/planner-optimizer.html) — paths, plans, GEQO
- [PostgreSQL Documentation — CLUSTER](https://www.postgresql.org/docs/current/sql-cluster.html) — 테이블의 물리적 재배치, one-time 작업
- [Crunchy Data — Postgres Scan Types in EXPLAIN Plans](https://www.crunchydata.com/blog/postgres-scan-types-in-explain-plans) — 스캔 종류별 실전 해설
- [Crunchy Data — Postgres' Clever Query Planning System](https://www.crunchydata.com/blog/indexes-selectivity-and-statistics) — 셀렉티비티와 통계
- [pganalyze — Bitmap Index Scan](https://pganalyze.com/docs/explain/scan-nodes/bitmap-index-scan) — Bitmap Scan 메커니즘 상세
- [pganalyze — Bitmap Heap Scan + lossy bitmap insights](https://pganalyze.com/docs/explain/insights/lossy-bitmaps) — exact vs lossy block 차이
- [pganalyze — How Postgres Chooses Which Index To Use For A Query](https://pganalyze.com/blog/how-postgres-chooses-index) — 옵티마이저의 인덱스 선택 과정
- [pgMustard — Recheck Cond](https://www.pgmustard.com/docs/explain/recheck-cond) — Recheck Cond는 lossy 상황에서만 의미
- [pgMustard — Index Cond](https://www.pgmustard.com/docs/explain/index-cond) — Index Cond와 Filter의 차이
- [Use The Index, Luke! — Filter Predicates](https://use-the-index-luke.com/sql/explain-plan/postgresql/filter-predicates) — access vs filter predicate
- [Yugabyte — Bitmap Scans on Distributed PostgreSQL](https://www.yugabyte.com/blog/bitmap-scans-on-distributed-postgresql/) — TIDBitmap 내부 구조 (PageTableEntry / 256 tuples per page)
- [Postgres Pro — Queries in PostgreSQL: 4. Index scan](https://postgrespro.com/blog/pgsql/5969493) — exact vs lossy bitmap, chunk 크기 (32 bytes per page)
- [Paquier — Postgres 9.4 lossy/exact pages for bitmap heap scan](https://paquier.xyz/postgresql-2/postgres-9-4-feature-highlight-lossyexact-pages-for-bitmap-heap-scan/) — lossy bitmap의 work_mem 의존성 실험
- [CYBERTEC — Use HOT, so CLUSTER won't rot](https://www.cybertec-postgresql.com/en/use-hot-so-cluster-wont-rot-postgresql/) — CLUSTER 후 correlation 보존을 위한 HOT update
- [Percona — One Index, Three Different PostgreSQL Scan Types](https://www.percona.com/blog/one-index-three-different-postgresql-scan-types-bitmap-index-and-index-only/) — 같은 인덱스, 다른 scan
- [CYBERTEC — PostgreSQL indexing: Index scan vs. Bitmap scan vs. Sequential scan](https://www.cybertec-postgresql.com/en/postgresql-indexing-index-scan-vs-bitmap-scan-vs-sequential-scan-basics/) — 세 스캔의 비교

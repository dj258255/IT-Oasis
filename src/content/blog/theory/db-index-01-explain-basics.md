---
title: '데이터베이스 인덱스 ①: 인덱스 기초와 EXPLAIN 읽기'
titleEn: 'Database Index ①: Index Basics and Reading EXPLAIN'
description: 인덱스는 검색용 보조 자료구조이고, 그 인덱스를 쓸지 말지를 결정하는 건 옵티마이저예요. 옵티마이저의 결정을 검증하는 도구가 EXPLAIN이고, 실측까지 더하는 게 EXPLAIN ANALYZE. cost가 임의 단위라는 점, 추정 vs 실측 격차가 진단의 핵심 신호라는 점, 인덱스가 있어도 안 쓰이는 4가지 패턴까지 1차 자료 기준으로 정리합니다.
descriptionEn: An index is an auxiliary data structure for search, and whether to use it is decided by the optimizer. EXPLAIN reveals that decision; EXPLAIN ANALYZE adds measured truth. Covers why cost is in arbitrary units, why estimate-vs-actual gap is the diagnostic signal, and four patterns where indexes silently aren't used — grounded in primary sources.
date: 2026-04-22T00:00:00.000Z
tags:
  - Database
  - Index
  - PostgreSQL
  - EXPLAIN
  - Query Optimizer
  - B-tree
  - Performance
category: theory/Database
draft: false
coverImage: "/uploads/theory/db-index/cover-1.svg"
series: "데이터베이스 인덱스"
seriesOrder: 1
---

## 0. 들어가며

새 시리즈 1편이에요. [DB 스토리지 내부](/blog/theory/db-storage-01-heap-page-index) 시리즈가 *"데이터가 디스크에 어떻게 살고 있나"* 를 다뤘다면, 이 시리즈는 그 데이터를 *"어떻게 빨리 찾아내는가"* 를 다룹니다. 첫 편은 **인덱스가 무엇이고 왜 필요한가** 에서 시작해, **EXPLAIN으로 쿼리가 실제로 어떻게 동작하는지 들여다보는 법** 까지. 시리즈 전체의 진입점이자 공통 도구가 되는 편이에요.

핵심 메시지: **인덱스는 전체 테이블을 검색하지 않기 위한 보조 자료구조** 이고, **인덱스를 쓸지 말지·어느 인덱스를 쓸지는 옵티마이저가 통계 기반으로 결정** 합니다. 그 결정의 결과를 보여주는 도구가 `EXPLAIN`이고, 실제로 실행해 측정값까지 얻는 게 `EXPLAIN ANALYZE`예요. **인덱스 튜닝의 출발점은 EXPLAIN 결과를 정확히 읽는 능력** 입니다.

![인덱스 시리즈 1편 커버](/uploads/theory/db-index/cover-1.svg)

> **글의 범위**: 이번 편은 *인덱스의 개념 + EXPLAIN 기초* 까지. 스캔 종류별 메커니즘은 2편, covering index와 IOS는 3편, 복합 인덱스는 4편에서 다룹니다.

## 1. 인덱스란 무엇인가

### 인덱스의 정의

> **Index**: 원본 테이블에 대한 *검색용 보조 자료구조*. 테이블 자체를 다시 정렬하는 게 아니라, 검색을 빠르게 하기 위한 별도 구조를 옆에 만들어 둔다.

비유하자면 *전화번호부 책의 ㄱ-ㅎ 인덱스 탭* 같은 거예요 — 책 본문은 그대로 두고, 알파벳별로 시작 페이지를 표시한 보조 색인을 만들어 원하는 부분으로 빨리 점프할 수 있게 해줍니다.

데이터베이스에서 흔히 쓰는 인덱스 자료구조는 두 가지:

- **B-tree (정확히는 B+tree)**: 거의 모든 관계형 데이터베이스의 표준. 읽기 최적화. PostgreSQL, MySQL InnoDB, Oracle, SQL Server 모두 기본.
- **LSM-tree (Log-Structured Merge Tree)**: 쓰기 최적화. Cassandra, LevelDB, RocksDB, ScyllaDB 같은 NoSQL/임베디드 엔진의 표준.

이 시리즈에서는 **B-tree 기반 인덱스에 집중** 해요(RDBMS의 기본 가정). LSM-tree는 워크로드 다른 시스템 설계에서 별도로 다뤄야 할 주제.

### 인덱스가 빠른 이유 — 자료구조의 본질

테이블에 1억 개 행이 있고 정렬되지 않은 상태에서 특정 값을 찾는다면 최악의 경우 1억 번의 비교가 필요해요. 반면 B-tree는 **fanout(노드당 자식 수)** 이 키 크기와 페이지 크기에 따라 달라지지만 일반적으로 수십~수백 수준이고, 결과적으로 대규모 테이블도 **수 단계(보통 depth 3~5) 안에 도달 가능** 합니다 — 즉 수백 번 이내의 비교로 끝나요.

![Seq Scan O(N) vs B-tree Index O(log N) — 자료구조의 효율 차이가 곧 인덱스의 본질](/uploads/theory/db-index/seqscan-vs-btree.svg)

그래서 인덱스는 마법이 아니라 **자료구조** 예요. 검색 효율이 이론적으로 *O(N)에서 O(log N)으로 떨어지는 단순한 사실의 응용*. 다만 실제 성능은 이론 그대로가 아니에요 — Seq Scan은 [순차 IO + OS readahead](/blog/theory/db-storage-01-heap-page-index)로 의외로 빠르고, Index Scan은 random IO가 따라와 캐시 상태에 따라 더 느릴 수도 있어요. 그래서 옵티마이저가 항상 인덱스를 선택하지는 않습니다(5장에서). 또 INSERT/UPDATE/DELETE마다 인덱스도 같이 갱신해야 하므로 쓰기 비용이 늘어나요 — 이게 인덱스를 무한정 만들면 안 되는 이유.

### 인덱스가 만드는 두 가지 비용

1. **쓰기 비용 증가**: INSERT/UPDATE/DELETE 시 인덱스도 같이 갱신. 인덱스 N개면 최악의 경우 N개 모두 갱신. ([스토리지 ③편의 HOT update](/blog/theory/db-storage-03-hot-update-visibility-map)가 이 비용을 조건부로 회피하는 메커니즘.)
2. **저장 공간 증가**: 인덱스도 디스크에 저장됨. 큰 테이블의 인덱스는 수 GB에 달할 수 있고, 메모리에 다 들어가지 않으면 인덱스 자체 IO가 발생.

이 두 비용 때문에 인덱스 설계는 **트레이드오프** — *모든 컬럼에 인덱스가 답이 아니라 워크로드에 맞춰 필요한 만큼만*.

> **1장 요약** — 인덱스는 검색 효율을 이론적으로 O(log N)으로 낮추는 보조 자료구조예요(실제 성능은 I/O 패턴 + 캐시 상태에 좌우). RDBMS는 보통 B-tree 기반. 쓰기 비용과 저장 공간 비용이 따라오므로 워크로드 기반 설계가 핵심.

## 2. 실습 환경 — 큰 테이블 만들기

이론만으로는 인덱스의 효과가 와닿지 않아요. **수백만 행이 있어야 인덱스 없을 때와 있을 때의 차이가 체감** 됩니다. PostgreSQL에서 큰 테이블을 빠르게 만드는 정석은 `generate_series`:

```sql
CREATE TABLE temp (t INTEGER);

INSERT INTO temp
SELECT (random() * 100)::INTEGER
FROM generate_series(0, 1000000);
```

해석:

- `generate_series(0, 1000000)` — 0부터 100만까지의 정수를 순차적으로 생성. **양끝을 모두 포함**하므로 실제 행 수는 100만이 아니라 **1,000,001개**다.
- `random()` — 0 이상 1 미만의 실수 반환
- `(random() * 100)::INTEGER` — 반올림으로 0~100 범위의 랜덤 정수로 변환(0과 100은 경계라 드물게 나옴)
- 결과: 약 100만(정확히는 1,000,001) 개의 랜덤 정수 행이 생성됨

이 패턴 하나로 임의 크기의 테스트 테이블을 만들 수 있어요. 이번 시리즈 전체에서 이런 식의 큰 테이블에 쿼리를 실행해 인덱스 효과를 비교합니다.

> **2장 요약** — `generate_series`와 `random()` 조합으로 수백만 행 테스트 테이블을 빠르게 만들 수 있어요. 인덱스 학습은 *작은 테이블에서 안 보이는 패턴을 보는 게* 핵심.

## 3. EXPLAIN — 옵티마이저의 결정을 들여다보기

### EXPLAIN의 역할

`EXPLAIN`은 PostgreSQL 옵티마이저가 *"이 쿼리를 어떻게 실행할 계획인가"* 를 출력하는 명령이에요. **실제로 실행하지는 않고 계획만** 보여줍니다. 한 가지 미리 짚을 것 — 옵티마이저는 **통계 기반 휴리스틱** 이라 항상 최적 plan을 고르지는 않아요. EXPLAIN의 가치는 *옵티마이저의 현재 결정을 검증할 수 있다*는 점에 있어요.

```sql
EXPLAIN SELECT * FROM users;
```

출력 예시 (PostgreSQL 18 공식 문서 기준):

```
QUERY PLAN
-------------------------------------------------------------
 Seq Scan on users  (cost=0.00..17.00 rows=1000 width=17)
```

이 한 줄에 4가지 정보가 들어 있어요.

![EXPLAIN 한 줄에 들어있는 4가지 정보 — Node Type / Cost / Rows / Width](/uploads/theory/db-index/explain-anatomy.svg)

### 첫 번째 — Node Type (`Seq Scan`, `Index Scan`, ...)

`Seq Scan` — 순차 스캔, 즉 테이블 전체를 처음부터 끝까지 읽음. 다른 가능한 노드 타입은 `Index Scan`, `Index Only Scan`, `Bitmap Index Scan`, `Bitmap Heap Scan`, `Hash Join`, `Sort` 등. 이 노드 타입들이 **옵티마이저가 선택한 실행 전략** 을 보여줍니다 (2편에서 deep dive).

### 두 번째 — `cost=0.00..17.00` (시작 비용 .. 총 비용)

**cost는 시간이 아니라 임의 단위** 예요. 흔한 오해 — 밀리초라고 생각하기 쉬운데, 실제로는 옵티마이저 내부의 추상 단위. PostgreSQL은 다음 기준 상수로 cost를 계산해요:

- `seq_page_cost = 1.0` — 순차 페이지 1개 읽기 비용 (기준)
- `random_page_cost = 4.0` — 랜덤 페이지 1개 읽기 비용
- `cpu_tuple_cost = 0.01` — 튜플 1개 처리하는 CPU 비용
- 기타 여러 상수

즉 cost 17.00은 *17번의 순차 페이지 읽기에 해당하는 작업량 추정* 이에요. 밀리초가 아니에요. 다른 시스템에서 같은 cost가 나와도 실제 시간은 다를 수 있어요.

또 하나 중요한 점 — **cost는 절대값으로 의미가 없어요**. 옵티마이저가 후보 plan들 간 비용을 비교해 더 낮은 cost의 plan을 선택하는 *상대 비교용* 값일 뿐. cost 100인 plan보다 cost 200인 plan이 더 비싸다고 판단해 전자가 선택되지만, 실제 실행 시간이 정확히 두 배 차이 난다는 의미는 아닙니다 — cost model 자체가 추정이고, 실제 시간은 캐시/디스크 상태/동시 부하에 좌우돼요. 즉 *"내 쿼리 cost가 1000인데 큰 건가요?"* 라는 질문 자체가 무의미 — 같은 쿼리의 다른 plan과 비교해야만 의미 있어요.

두 숫자의 의미:

- `startup_cost` (`0.00`) — 첫 번째 행을 반환하기까지의 비용
- `total_cost` (`17.00`) — 모든 행을 반환할 때까지의 비용

`LIMIT`이나 `EXISTS` 서브쿼리처럼 일부 행만 필요한 경우에는 `startup_cost`가 결정적. 일반적인 쿼리에서는 `total_cost`가 중요해요.

### 세 번째 — `rows=1000` (예상 행 수)

옵티마이저가 통계 기반으로 **추정한** 반환될 행의 수. 실제 행 수가 아니에요 — 통계가 오래되었거나 추정이 빗나가면 실제와 크게 다를 수 있어요. 통계는 `ANALYZE`(또는 autovacuum의 자동 분석)로 갱신되며 `pg_statistic`에 저장됩니다.

이 추정값이 옵티마이저의 모든 결정의 기반이에요 — 추정이 빗나가면 잘못된 plan이 선택돼요. 통계 갱신이 중요한 이유.

### 네 번째 — `width=17` (행당 평균 바이트)

각 행이 평균 17바이트라는 추정. 이 값이 작을수록 한 페이지에 더 많은 행이 들어가고 IO 효율이 높아요. width는 IO뿐 아니라 sort 메모리, hash 테이블 크기, 네트워크 전송량에도 영향을 줍니다 — *큰 width는 불필요한 컬럼을 SELECT 하고 있는 신호일 수 있어요* (예: `SELECT *`).

> **3장 요약** — EXPLAIN은 *cost(시작/총), rows, width* 4가지 정보를 보여줘요. cost는 임의 단위이고 밀리초 아님. rows는 통계 기반 추정이라 실제와 다를 수 있어요.

## 4. EXPLAIN ANALYZE — 추정이 아닌 실측

### 차이점

`EXPLAIN`은 plan만 보여주고 실행은 안 해요. `EXPLAIN ANALYZE`는 **실제로 쿼리를 실행하고 실측값까지 추가** 해줍니다.

```sql
EXPLAIN ANALYZE SELECT * FROM users WHERE id < 100;
```

출력 예시:

```
 Index Scan using users_pkey on users
   (cost=0.29..8.45 rows=99 width=17)
   (actual time=0.012..0.045 rows=98 loops=1)
   Index Cond: (id < 100)
 Planning Time: 0.171 ms
 Execution Time: 0.073 ms
```

추가된 정보:

- `actual time=0.012..0.045` — 실제 시작/완료 시간 (밀리초)
- `actual rows=98` — 실제로 반환된 행 수
- `loops=1` — 이 노드가 몇 번 실행되었는지 (Nested Loop의 안쪽이면 여러 번)
- `Planning Time` — 옵티마이저가 plan을 짜는 데 걸린 시간
- `Execution Time` — 실제 실행 시간

### 추정 vs 실측 — 격차가 곧 문제 신호

EXPLAIN ANALYZE의 **진짜 가치는 추정과 실측의 격차** 를 보는 것이에요.

![추정 rows vs 실측 actual rows — 격차가 곧 진단 신호](/uploads/theory/db-index/estimate-vs-actual.svg)

```
cost=0.29..8.45 rows=99    ← 옵티마이저 추정
actual time=0.012..0.045 rows=98 ← 실제
```

이 경우 추정 99 / 실제 98로 거의 일치 → 통계가 정확하고 plan이 적절함. 반대로:

```
cost=8.45 rows=10          ← 추정 10
actual time=234.5 rows=50000 ← 실제 5만
```

이런 경우 옵티마이저가 행 수를 5000배 과소 추정했다는 의미 — 통계 갱신이 안 되어 있거나, 데이터 분포가 옵티마이저의 가정과 다르거나. 결과적으로 잘못된 plan이 선택되어 쿼리가 느려져요. `ANALYZE` 명령을 실행해 통계 갱신이 첫 처방.

### EXPLAIN ANALYZE의 주의점

- **실제로 실행됨**: `UPDATE`, `DELETE`, `INSERT`도 진짜로 실행돼요. 데이터 변경 쿼리에 함부로 쓰지 말 것 (트랜잭션으로 감싸고 `ROLLBACK` 하는 게 안전).
- **약간의 오버헤드**: 실측 시간 측정 자체가 비용이라 실제 운영보다 약간 더 느린 시간이 측정될 수 있어요.
- **`BUFFERS` 옵션과 함께 쓰면 더 강력**: `EXPLAIN (ANALYZE, BUFFERS)`는 shared buffer hit / read 같은 IO 지표까지 보여줘 캐시 효과까지 진단 가능.

```sql
EXPLAIN (ANALYZE, BUFFERS) SELECT id FROM users WHERE id = 12345;
```

출력에 추가되는 라인:

```
Buffers: shared hit=3
```

`shared hit`이 모든 read를 차지하면 완전히 캐시에 있다는 뜻 — 디스크 IO 없이 처리됐다는 의미. `shared read`가 많으면 디스크에서 새로 읽어왔다는 의미.

> **4장 요약** — `EXPLAIN ANALYZE`는 실제 실행 + 실측값을 추가해줘요. *추정 vs 실측 격차* 가 통계 문제 / plan 오류의 핵심 신호. `BUFFERS` 옵션으로 캐시 효과까지 진단 가능.

## 5. 인덱스 효과 체감하기 — 같은 쿼리, 다른 plan

### 인덱스 없이 — Sequential Scan

1100만 행이 있는 `employees` 테이블에 인덱스 없는 컬럼으로 검색 (예시 환경 — 실제 시간은 하드웨어/캐시 상태에 따라 달라져요):

```sql
EXPLAIN ANALYZE
SELECT id FROM employees WHERE name = 'Z';
```

출력:

```
 Parallel Seq Scan on employees
   (cost=1000.00..125000.00 rows=10 width=4)
   (actual time=2845.123..3012.456 rows=8 loops=1)
   Filter: (name = 'Z')
   Rows Removed by Filter: 11000000
 Execution Time: 3015.234 ms
```

해석:

- `Parallel Seq Scan` — 인덱스가 없으니 전체 테이블을 병렬로 순차 스캔. 다만 parallel 사용 여부 자체는 옵티마이저가 `parallel_setup_cost` / `parallel_tuple_cost` / `min_parallel_table_scan_size` / `max_parallel_workers_per_gather` 같은 설정과 cost 추정에 따라 결정해요 — 작은 테이블이거나 cost 이득이 없으면 parallel을 안 써요.
- `Rows Removed by Filter: 11000000` — 1100만 행을 다 읽어서 필터로 걸러냄
- 3초 소요

### 인덱스 만든 후 — Index Scan

```sql
CREATE INDEX idx_employees_name ON employees(name);

EXPLAIN ANALYZE
SELECT id FROM employees WHERE name = 'Z';
```

출력:

```
 Bitmap Heap Scan on employees
   (cost=4.50..120.00 rows=10 width=4)
   (actual time=0.234..0.567 rows=8 loops=1)
   Recheck Cond: (name = 'Z')
   ->  Bitmap Index Scan on idx_employees_name
         (cost=0.00..4.50 rows=10 width=0)
         Index Cond: (name = 'Z')
 Execution Time: 0.789 ms
```

해석:

- `Bitmap Index Scan` + `Bitmap Heap Scan` — 인덱스로 후보를 찾고 힙으로 가서 실제 행 가져옴 (2편에서 deep dive)
- 0.789ms — 수천 배까지 차이가 날 수 있어요(환경 의존, 같은 환경 내 비교)

이게 인덱스를 만들기 전과 후의 차이 — 같은 쿼리, 같은 데이터, 다른 plan.

### 인덱스가 항상 빠르지는 않다

다만 인덱스가 항상 사용되는 것도, 항상 빠른 것도 아니에요:

```sql
EXPLAIN SELECT * FROM employees WHERE id > 100;
```

`id`에 인덱스가 있어도 — 전체의 거의 모든 행이 조건을 만족하면, 옵티마이저는 *인덱스를 통해 거의 모든 행을 가져오느니 그냥 테이블 전체를 순차 스캔하는 게 낫다* 고 판단해 결과적으로 Seq Scan을 선택해요.

이게 **인덱스가 있어도 옵티마이저가 안 쓰는 첫 번째 패턴**. 반환할 행이 너무 많으면 인덱스가 오히려 비효율. 대략 수% 수준부터 Seq Scan으로 기우는 경우가 많지만, 정확한 임계값은 *데이터 분포 + cost 설정(`random_page_cost` vs `seq_page_cost`) + 행 크기 + 캐시 상태* 에 따라 크게 달라집니다 — 1%인데 Seq Scan이 나오기도 하고 20%인데 Index Scan이 유지되기도 해요. 옵티마이저는 통계 기반으로 이 결정을 자동으로 합니다.

> **5장 요약** — 인덱스는 *적절한 셀렉티비티에서만* 빠릅니다. 너무 많은 행이 매칭되면 옵티마이저는 인덱스를 무시하고 Seq Scan을 선택해요. EXPLAIN으로 *옵티마이저가 인덱스를 실제로 썼는지* 확인하는 게 첫 단계.

## 6. EXPLAIN 활용의 실전 패턴

### 패턴 1 — 추정 vs 실측 격차 모니터링

```sql
EXPLAIN ANALYZE <쿼리>;
```

`rows=N` (추정)과 `actual rows=M` (실측)이 **10배 이상 차이나면 통계 문제 의심**:

```sql
ANALYZE <테이블명>;
```

으로 통계 갱신.

### 패턴 2 — 인덱스가 실제로 쓰이는지 확인

`Seq Scan`이 보이는데 분명 인덱스가 있는 컬럼이라면:

![인덱스가 있어도 안 쓰이는 4가지 패턴](/uploads/theory/db-index/index-not-used-patterns.svg)

- `WHERE` 조건이 **함수/표현식** 을 쓰고 있는지 (예: `WHERE LOWER(name) = 'z'` — 함수 인덱스가 별도로 필요)
- `LIKE` 연산자가 **시작 와일드카드** 를 쓰고 있는지 (`WHERE name LIKE '%Z%'` — 인덱스 사용 불가)
- 데이터 타입이 **암묵적으로 변환** 되는지 (예: `id::TEXT = '100'`)
- 반환할 행이 너무 많아 옵티마이저가 의도적으로 **Seq Scan을 더 싸다고 판단** 했는지 (5장 참고)

### 패턴 3 — Heap Fetches로 IOS 효율 진단

```sql
EXPLAIN (ANALYZE, BUFFERS) SELECT id FROM users WHERE id < 100;
```

출력에 `Heap Fetches: N`이 있으면:

- `Heap Fetches: 0` → 진짜 Index-Only Scan, 인덱스만으로 답 완료
- `Heap Fetches: > 0` → IOS plan으로 잡혔지만 VM stale로 heap 방문 발생 ([스토리지 ③편](/blog/theory/db-storage-03-hot-update-visibility-map) 참고)

### 패턴 4 — Buffers로 캐시 효과 진단

```sql
EXPLAIN (ANALYZE, BUFFERS) <쿼리>;
```

- `shared hit: N` — 캐시에서 가져온 페이지 (빠름)
- `shared read: N` — 디스크에서 새로 읽은 페이지 (느림)
- 쿼리 두 번 연달아 실행해서 두 번째가 훨씬 빠르면 캐시 효과 — *진짜 성능 측정은 cold cache에서*.

> **6장 요약** — EXPLAIN의 진짜 가치는 *문제 진단* 이에요. 추정 vs 실측 격차, 인덱스 사용 여부, IOS heap fetches, 캐시 효과 — 모두 EXPLAIN으로 보여요.

## 7. 정리

### 핵심 통찰

1. **인덱스는 검색용 보조 자료구조**: 테이블을 다시 정렬하는 게 아니라 옆에 별도 구조를 만든다. RDBMS는 거의 모두 B-tree 기반.
2. **인덱스의 효과 = 자료구조의 효과**: O(N) → O(log N). 그러나 *쓰기 비용 + 저장 공간* 이 트레이드오프.
3. **EXPLAIN은 plan, EXPLAIN ANALYZE는 plan + 실측**: 단일 쿼리의 plan 분석에는 가장 강력한 도구지만, 실제 운영의 동시성/lock 경합/cold vs warm cache 같은 환경 요소까지 완전히 반영하지는 않는다. 또 measurement instrumentation 자체가 비용이고 JIT 컴파일 발동 여부(cost 기반, `jit_above_cost` 기본 100,000)에 따라 같은 쿼리도 시간이 달라질 수 있다 — 짧은 쿼리는 JIT가 오히려 느리게 만들기도 한다. 변경 쿼리(UPDATE/DELETE/INSERT)는 진짜 실행되므로 트랜잭션으로 감싸고 ROLLBACK이 안전.
4. **cost는 임의 단위, 밀리초 아님**: cost 비교는 *상대적 비용* 만 의미 있고, 절대 시간과 다르다.
5. **추정 rows vs 실측 actual rows의 격차가 대부분의 plan 오류의 진단점**: 격차가 크면 `ANALYZE`로 통계 갱신.
6. **인덱스가 있어도 옵티마이저가 안 쓸 수 있다**: 너무 많은 행이 매칭되면 Seq Scan이 더 효율적. 옵티마이저의 판단을 EXPLAIN으로 검증해야 한다.
7. **`BUFFERS` 옵션으로 캐시 효과까지 진단**: shared hit / read 비율이 결정적.
8. **옵티마이저는 통계 기반 휴리스틱**: 항상 최적 plan을 선택하지는 않는다. 통계가 부정확하거나, 데이터 분포가 옵티마이저의 가정과 다르거나, *컬럼 간 상관관계* 가 있으면 잘못된 plan을 고를 수 있다 — 특히 기본 통계는 컬럼 독립을 가정하기 때문에 상관관계가 있는 컬럼을 함께 필터링할 때 cardinality 추정이 크게 어긋나는 게 흔한 패턴이다 (해결책으로 PostgreSQL 10+에서 `CREATE STATISTICS`로 다중 컬럼 통계를 만들 수 있음). 또한 옵티마이저는 모든 가능한 plan을 다 비교하지 않는다 — 조인 수가 많아지면 (PostgreSQL 기본 `geqo_threshold=12`) 휴리스틱 기반 GEQO(Genetic Query Optimizer)로 전환해 합리적이지만 최적은 아닐 수 있는 plan을 만든다. 그래서 EXPLAIN ANALYZE로 검증하고, 필요하면 통계를 갱신(`ANALYZE`)하거나 plan 힌트(extension/SET 옵션)로 개입해야 한다.

### 한 줄

> **인덱스 튜닝의 출발점은 EXPLAIN ANALYZE 결과를 정확히 읽는 능력이다.** Plan을 못 읽으면 어떤 인덱스를 만들어야 하는지도, 왜 인덱스가 안 쓰이는지도 알 수 없다.

### 통합된 답 — 한 단락 정리

인덱스는 원본 테이블에 대한 *검색용 보조 자료구조* 로, 보통 B-tree 기반이에요. 검색 효율을 이론적으로 O(N)에서 O(log N)으로 낮추는 단순한 자료구조의 응용이고, 그 대가로 *쓰기 비용 + 저장 공간* 이 늘어납니다. 다만 실제 성능은 *I/O 패턴 + 캐시 상태* 에 따라 달라지며 Seq Scan이 더 빠를 수도 있어요. 인덱스를 언제, 어떻게 쓸지는 옵티마이저가 *통계 기반 휴리스틱* 으로 결정해요 — 항상 최적은 아니고, 특히 컬럼 간 상관관계는 기본 통계로 포착되지 않아 cardinality 추정이 어긋나는 흔한 원인입니다. 그 결정을 보여주는 도구가 `EXPLAIN`이에요. EXPLAIN은 *cost(시작/총), rows, width* 같은 추정값을 보여주고, `EXPLAIN ANALYZE`는 실제로 실행해서 *actual time, actual rows, loops* 같은 실측값까지 추가해줘요. cost는 시간이 아니라 *임의 단위* (`seq_page_cost=1.0`이 기준)이고 plan 간 *상대 비교용* 이지 절대값으로 의미 없으며 실제 시간과 정확히 비례하지도 않아요. *추정 rows와 실측 actual rows의 격차* 가 plan 문제 진단의 핵심 신호예요 — 격차가 크면 `ANALYZE`로 통계 갱신부터. 인덱스가 있어도 반환할 행이 너무 많으면(대략 수% 수준부터, 다만 데이터 분포/cost 설정에 따라 달라짐) 옵티마이저는 Seq Scan이 더 효율적이라고 판단해 인덱스를 무시할 수 있고, *함수/표현식 + LIKE 시작 와일드카드 + 암묵적 타입 변환* 같은 패턴은 인덱스 사용 자체를 막아요. `EXPLAIN (ANALYZE, BUFFERS)` 옵션으로 *shared hit/read* 같은 캐시 효과까지 진단 가능 — 단 동시성/lock/cold cache 같은 운영 환경 요소까지 완전히 반영하지는 않는다는 점은 염두에 둬야 해요. **인덱스 튜닝의 출발점은 plan을 정확히 읽는 능력** 이에요.

### 글의 범위와 한계

이 글은 PostgreSQL 기준이에요. EXPLAIN의 출력 형식과 cost 계산 모델은 DBMS마다 다릅니다 — MySQL의 `EXPLAIN`은 형식이 다르고(`type`, `rows`, `Extra` 컬럼), Oracle의 `EXPLAIN PLAN`은 `DBMS_XPLAN.DISPLAY`로 출력해요. 다만 *옵티마이저가 통계 기반으로 plan을 결정한다* 는 본질적 메커니즘은 모든 RDBMS에 공통이고, plan을 읽는 사고법 자체는 이식 가능합니다.

또한 LSM-tree 기반 시스템(Cassandra, RocksDB 등)의 쿼리 계획 도구는 RDBMS와 크게 달라요(compaction, bloom filter, level 구조 등 별도 개념). 이 시리즈의 범위 밖.

### 참고 (1차 자료 우선)

- [PostgreSQL Documentation — Using EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html) — EXPLAIN 출력 해석 공식 가이드
- [PostgreSQL Documentation — EXPLAIN](https://www.postgresql.org/docs/current/sql-explain.html) — EXPLAIN 명령 reference
- [PostgreSQL Documentation — Query Planning Cost Constants](https://www.postgresql.org/docs/current/runtime-config-query.html#RUNTIME-CONFIG-QUERY-CONSTANTS) — `seq_page_cost`, `random_page_cost` 등 cost 모델 상수
- [PostgreSQL Documentation — Statistics Used by the Planner](https://www.postgresql.org/docs/current/planner-stats.html) — `pg_statistic`, `CREATE STATISTICS` 등
- [PostgreSQL Documentation — Genetic Query Optimizer](https://www.postgresql.org/docs/current/geqo.html) — `geqo_threshold`와 GEQO 동작
- [ScaleGrid — What Is The Cost In PostgreSQL EXPLAIN Query](https://scalegrid.io/blog/postgres-explain-cost/) — cost 계산의 실전 해석
- [thoughtbot — Reading a Postgres EXPLAIN ANALYZE Query Plan](https://thoughtbot.com/blog/reading-an-explain-analyze-query-plan) — EXPLAIN ANALYZE 읽는 법
- [TiKV — B-Tree vs LSM-Tree](https://tikv.org/deep-dive/key-value-engine/b-tree-vs-lsm/) — 두 자료구조의 정량적 비교

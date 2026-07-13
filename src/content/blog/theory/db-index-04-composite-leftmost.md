---
title: '데이터베이스 인덱스 ④: 복합 인덱스와 좌측 컬럼 규칙'
titleEn: 'Database Index ④: Composite Index and Leftmost Prefix Rule'
description: 복합 인덱스는 컬럼들의 정렬 순서를 그대로 B-tree에 반영한 자료구조입니다. 같은 세 컬럼이라도 순서를 바꾸면 전혀 다른 인덱스가 되고, leftmost prefix rule이 활용 방식을 결정합니다. ESR Rule(Equality·Sort·Range) 가이드라인, PG18 skip scan, AND vs OR, INCLUDE와의 차이까지 1차 자료 기준으로 정리.
descriptionEn: A composite index encodes column order directly into a B-tree. Same three columns in different order are different indexes, and the leftmost prefix rule decides how each query uses them. Covers ESR Rule (Equality / Sort / Range), PG18 skip scan, AND vs OR behavior, and how composite key columns differ from INCLUDE — grounded in primary sources.
date: 2026-04-25T00:00:00.000Z
tags:
  - Database
  - Index
  - PostgreSQL
  - Composite Index
  - Leftmost Prefix
  - Skip Scan
  - ESR Rule
  - Performance
category: theory/Database
draft: false
coverImage: "/uploads/theory/db-index/cover-4.svg"
series: "데이터베이스 인덱스"
seriesOrder: 4
---

## 0. 들어가며

인덱스 시리즈 4편입니다. [1](/blog/theory/db-index-01-explain-basics)~[3편](/blog/theory/db-index-03-covering-index-ios)이 *단일 컬럼 인덱스* 를 다뤘다면, 이번 편은 *여러 컬럼을 묶은 복합 인덱스(composite/multicolumn index)* 입니다. 핵심은 **컬럼 순서가 인덱스 활용 방식에 결정적인 영향을 준다**는 점입니다. 같은 세 컬럼이라도 *순서를 바꾸면 전혀 다른 인덱스* 가 되고, 같은 쿼리도 *어떤 인덱스가 잡히는지가 갈립니다*.

핵심 메시지: **복합 인덱스는 *컬럼들의 정렬 순서* 를 그대로 B-tree에 반영한 자료구조** 입니다. PostgreSQL의 사용 규칙(leftmost prefix rule)은 *equality 조건이 leading 컬럼부터 차례로 있어야* 인덱스 스캔 범위가 좁혀진다는 것입니다. 이 규칙을 어기면 *주력 활용 패턴에서 벗어나며*, *인덱스 전체를 훑는 우회 경로(PG 17 이하)* 나 *skip scan(PG 18+)* 같은 방식에 의존하게 됩니다 (어느 쪽이든 *옵티마이저의 cost 판단* 이 선택을 결정). 컬럼 순서 결정의 *경험적 가이드라인* 은 *Equality 컬럼을 먼저 두고, Sort와 Range는 워크로드(어떤 prefix가 단독으로 자주 쓰이는지, ORDER BY/GROUP BY 패턴, range 위치)에 따라 우선순위를 정하는 것* (ESR Rule)입니다. equality 컬럼 내부 순서는 *단순 셀렉티비티보다 prefix 재사용성, 정렬/그룹핑, 후속 range 조건* 을 함께 보는 게 정확합니다. 다중 인덱스 결합과는 *근본적으로 다른 도구* 이며, 공통 패턴이 명확할 때만 복합 인덱스가 더 강력합니다.

![인덱스 시리즈 4편 커버: Leftmost Prefix + ESR Rule](/uploads/theory/db-index/cover-4.svg)

> **글의 범위**: 이번 편은 *복합 인덱스의 메커니즘 + 컬럼 순서 결정 + AND/OR 동작* 까지. 클러스터형 인덱스와 DBMS별 차이, 운영(CONCURRENTLY/장기 트랜잭션) 같은 주제는 후속 편에서 별도로 다룹니다.

## 1. 복합 인덱스란 무엇인가

### 정의

`CREATE INDEX idx ON tab (a, b, c)`는 세 컬럼을 묶은 *하나의* 인덱스입니다. *세 개의 단일 인덱스* 와 본질적으로 다릅니다.

### 내부 구조: 정렬의 의미

복합 인덱스는 *왼쪽 컬럼부터 차례로 정렬* 된 B-tree입니다. `(a, b, c)` 인덱스라면 leaf의 entry는 *사전식(lexicographic) 순서* 로 정렬됩니다:

![(a, b, c) 복합 인덱스: 사전식 정렬](/uploads/theory/db-index/composite-sort-order.svg)

```
(A, 1, X)
(A, 1, Y)
(A, 2, X)
(A, 2, Y)
(B, 1, X)
(B, 1, Y)
(B, 2, X)
...
```

핵심은 **a로 먼저 정렬되고, *같은 a 안에서만* b로 정렬되고, *같은 (a, b) 안에서만* c로 정렬** 된다는 것입니다. 즉:

- *a로 검색*: 한 덩어리(슬라이스)로 찾을 수 있음 (인덱스가 직접 활용됨)
- *a와 b로 검색*: 더 작은 한 덩어리
- *b만으로 검색*: *전체 인덱스에 b 값이 흩어져 있어* leftmost prefix로 직접 슬라이스를 만들지는 못합니다 (즉 *주력 활용 패턴* 은 아님). 다만 *인덱스가 테이블보다 충분히 작거나 skip scan이 유리한 경우* 옵티마이저는 여전히 인덱스를 선택할 수 있습니다. PG 17 이하는 *인덱스 전체를 훑는 방식* (이 글에서는 편의상 'Full-Index Scan'으로 표기, PostgreSQL 공식 plan node 이름은 아니고 leading 조건 없이 인덱스 전반을 스캔하는 상황을 가리키는 설명용 용어), PG 18+는 *skip scan* 으로 처리합니다

이것이 **leftmost prefix rule(좌측 컬럼 규칙)** 의 본질입니다.

### 단일 인덱스 여러 개 vs 복합 인덱스 하나

`(a, b, c)` 복합 인덱스 vs *a, b, c 각각의 단일 인덱스 3개* 는 다음과 같이 갈립니다:

| 시나리오 | 복합 인덱스 | 단일 인덱스 3개 |
|---|---|---|
| `WHERE a=? AND b=? AND c=?` | 가장 효율적 (한 슬라이스 직접 접근) | BitmapAnd 결합 필요 |
| `WHERE a=? AND b=?` | 효율적 | a 인덱스 + b 필터 또는 BitmapAnd |
| `WHERE a=?` | 효율적 (앞부분만 사용) | a 인덱스 사용 |
| `WHERE b=?` | 주력 활용은 아님, Full-Index Scan(PG17-) 또는 skip scan(PG18+) 가능 | b 인덱스 사용 |
| `WHERE a=? OR b=?` | 어려움, Bitmap으로 결합 | BitmapOr 자연스러움 |
| 인덱스 유지 비용 | 1개 (적음) | 3개 (큼) |

> **1장 요약**: 복합 인덱스는 *왼쪽 컬럼부터 차례로 정렬* 된 B-tree. 컬럼 순서가 *직접 인덱스 구조* 에 반영되며, 이것이 leftmost prefix rule의 근원.

## 2. Leftmost Prefix Rule: 좌측 컬럼 규칙

### 공식 규칙

PostgreSQL 18 공식 문서:

> *"The exact rule is that equality constraints on leading columns, plus any inequality constraints on the first column that does not have an equality constraint, will always be used to limit the portion of the index that is scanned."*

해석: **"leading 컬럼에 equality(=) 조건이 있으면 그 다음 컬럼으로 진행 가능 + equality가 끊긴 첫 컬럼에 inequality(>, <, BETWEEN, ...) 조건이 있으면 거기까지가 인덱스 스캔 범위 제한"**.

이 규칙을 두 가지 핵심으로 정리:

1. **왼쪽부터 차례로**: 가운데 컬럼을 건너뛰면 인덱스 활용 불가
2. **첫 range에서 멈춤**: range 조건이 나오면 그 다음 컬럼은 *Index Cond로 필터링에는 사용되지만 스캔 시작/종료 범위를 줄이지는 못합니다*

### 패턴별 동작: `(a, b, c)` 인덱스

```sql
CREATE INDEX idx ON tab (a, b, c);
```

![(a, b, c) 인덱스의 쿼리별 활용: Leftmost Prefix Rule](/uploads/theory/db-index/leftmost-prefix-patterns.svg)

| 쿼리 | 인덱스 활용 | 비고 |
|---|---|---|
| `WHERE a=1 AND b=2 AND c=3` | 완전 활용 | 한 슬라이스 |
| `WHERE a=1 AND b=2` | 활용 | 더 큰 슬라이스 |
| `WHERE a=1` | 활용 | a 슬라이스 전체 |
| `WHERE a=1 AND c=3` | a만 인덱스로 좁히고 *c는 인덱스에서 체크* (skip scan 적용 가능) | b가 빠짐 |
| `WHERE b=2` | PG 17 이하에서는 leftmost prefix를 못 써 *주력 활용은 아니지만* Full-Index Scan은 가능 / PG 18+ skip scan으로 일부 활용 | leading 누락 |
| `WHERE a=1 AND b>=2 AND c=3` | a, b까지 활용 (b는 range라 거기서 멈춤). c는 *Index Cond로 인덱스에서 적용되지만 스캔 시작/종료 범위는 못 좁힘* | range 이후 정지 |

PostgreSQL 18 공식의 정확한 예시:

> *"given an index on (a, b, c) and a query condition WHERE a = 5 AND b >= 42 AND c < 77, the index would have to be scanned from the first entry with a = 5 and b = 42 up through the last entry with a = 5"*

c 조건은 *index condition으로 인덱스에서 적용되지만* (heap fetch 줄임), *스캔의 시작/종료 범위는 못 좁힙니다*. 즉 *a=5 슬라이스 전체를 훑으면서* c 조건으로 필터링합니다.

### 쿼리 작성 순서 vs 인덱스 정의 순서

**중요한 구분**: 쿼리에서 `WHERE c=3 AND a=1`이라고 *써도 옵티마이저가 자동으로 leftmost prefix를 찾습니다*. 즉 *쿼리 작성 순서는 무관* 하고 *인덱스 정의 순서가 결정적* 입니다. 다만 *쿼리에 leading 컬럼 조건이 없으면* 자동으로 찾을 게 없습니다.

> **2장 요약**: Leftmost prefix rule = *equality는 leading부터, range가 나오면 거기서 멈춤*. 쿼리 작성 순서가 아니라 *인덱스 정의 순서* 가 결정적.

## 3. 컬럼 순서 결정: ESR Rule과 Selectivity

### ESR Rule: Equality, Sort, Range

복합 인덱스 컬럼 순서의 *경험적 가이드라인* (PostgreSQL 공식 규칙은 아니고 MongoDB 가이드에서 통용되는 명명, B-tree 기반 RDBMS에 일반적으로 적용 가능):

1. **Equality 컬럼 먼저**: `=` 조건의 컬럼은 *후속 컬럼의 정렬을 살리는 가장 핵심적인 prefix*
2. **Sort vs Range**: `ORDER BY`로 정렬되는 컬럼과 `>`, `<`, `BETWEEN` 같은 range 조건의 우선순위는 *워크로드 의존*. *정렬이 더 critical하면 sort 먼저, range 조건이 인덱스 활용의 핵심이면 range 먼저*

즉 ESR의 *S와 R 순서* 는 *어떤 쿼리가 더 자주, 더 critical한지에 따라 결정* 되는 휴리스틱이지 *절대적 순서가 아닙니다*. 다만 *Equality는 거의 예외 없이 leading* 에 두는 게 일반적입니다.

### Equality 컬럼 내부 순서

*equality 컬럼이 여러 개* 라면, *둘 다 equality라면 어느 순서든 한 슬라이스로 좁혀지니* 단순 셀렉티비티가 결정 인자가 아닙니다 (PostgreSQL B-tree에서). 더 중요한 결정 요인:

- **Prefix 재사용성**: *어떤 prefix만 단독으로 자주 쓰이는지*. `WHERE a=?`만 있는 쿼리도 자주 실행되면 a를 leading
- **정렬/그룹핑 매칭**: *ORDER BY나 GROUP BY와 일치하는 컬럼* 이 있다면 그 컬럼을 적절한 위치에
- **후속 range 위치**: *range가 어디에 붙는지* 에 따라 그 앞 컬럼은 모두 equality여야 함
- **Skip scan 기대 여부**: *낮은 카디널리티 컬럼이 leading이면 PG 18+ skip scan 유리*

따라서 ESR Rule은 *워크로드에 따라 예외가 존재* 하며 *항상 최적을 보장하는 규칙은 아닙니다*. 실제 인덱스 설계는 `EXPLAIN ANALYZE`로 검증하는 게 정공법입니다.

### 실전 결정 흐름

쿼리 패턴 분석부터:

```sql
-- 자주 실행되는 쿼리 1
SELECT * FROM orders WHERE user_id = ? AND status = ? AND created_at >= ?;

-- 자주 실행되는 쿼리 2
SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 20;
```

ESR 적용:

- **Equality**: `user_id`, `status`
- **Sort**: `created_at DESC`
- **Range**: `created_at >=`

→ `(user_id, status, created_at DESC)` 또는 `(user_id, created_at DESC, status)`. *어느 쿼리가 더 자주, 더 critical인지* 에 따라 결정합니다.

### 안티패턴: 컬럼 많은 인덱스를 그냥 만들기

PostgreSQL 공식 문서가 명시:

> *"Multicolumn indexes should be used sparingly. In most situations, an index on a single column is sufficient and saves space and time. Indexes with more than three columns are unlikely to be helpful unless the usage of the table is extremely stylized."*

즉 *3컬럼을 넘어가면 재사용성이 낮아져 신중히 설계* 해야 합니다. *너무 specific해서 다른 쿼리에 재사용 안 되거나* *유지 비용* 이 부담될 수 있습니다. 다만 *covering index 목적* 이거나 *특정 워크로드에 명확한 패턴* 이 있으면 4~5 컬럼도 충분히 유효할 수 있습니다.

> **3장 요약**: ESR Rule (경험적 가이드라인): *Equality 먼저, Sort/Range 우선순위는 워크로드 의존*. equality 컬럼 내부는 *prefix 재사용성, 정렬/그룹핑, range 위치, skip scan 기대* 를 함께 고려. 3컬럼을 넘어가면 *재사용성이 낮아져 신중히 설계* 해야 합니다.

## 4. PostgreSQL 18: Skip Scan의 도입

### 기존 한계

PostgreSQL 17 이하에서 `(status, customer_id, order_date)` 인덱스가 있는데 `WHERE customer_id = 100` 쿼리만 실행하면 *옵티마이저가 cost를 비교해 Seq Scan 또는 Full-Index Scan을 선택* 했습니다 (leading 컬럼 `status`가 빠져 *주력 활용 패턴은 아니지만 인덱스가 충분히 작으면 Full-Index Scan으로 활용 가능*).

해법은 *별도 인덱스 추가* (`CREATE INDEX ON sales (customer_id)`)였는데, 인덱스가 늘어나면 유지 비용이 함께 증가합니다.

### Skip Scan: PostgreSQL 18 신규

PostgreSQL 18 공식 릴리스 노트:

> *"Allow skip scans of btree indexes ... allows multi-column btree indexes to be used by queries that only equality-reference the second or later indexed columns"*

![Skip Scan: leading 컬럼 없는 쿼리도 인덱스 활용](/uploads/theory/db-index/skip-scan-mechanism.svg)

동작 원리 (Better Stack + pgEdge 자료):

0. **옵티마이저가 cost 추정 결과 skip scan이 더 유리하다고 판단했을 때만** 선택 (자동, 강제 불가). 통계가 stale하면 잘못된 선택 가능
1. 옵티마이저가 *omitted leading 컬럼의 distinct value들* 을 식별
2. 각 distinct value에 대해 *작은 range seek* 을 반복 수행
3. 결과를 모아서 반환

`(status, customer_id, order_date)` + `WHERE customer_id = 100`:

- status에 *distinct value가 3개* (`active`, `pending`, `shipped`)라면
- 옵티마이저가 *3번의 작은 인덱스 검색* 을 수행 (각 status 값에 대해 customer_id=100 찾기)
- *전체 테이블 스캔보다 훨씬 효율적이라고 cost로 판단* 되면 skip scan 선택

### Skip Scan의 한계

PostgreSQL 18 공식과 Neon 자료가 명시:

- **B-tree 한정**: GiST, GIN 등은 미지원
- **낮은 카디널리티에서만 효과적**: *prefix 컬럼의 distinct value가 많으면* 너무 많은 mini-scan이 되어 비효율
- **후행 컬럼 equality 필요**: `customer_id = 100` 같은 equality 조건이 있어야 함
- **ANALYZE 통계 의존**: 옵티마이저가 *prefix 컬럼의 카디널리티를 추정* 해 결정. *통계가 stale하면 잘못된 선택* 이 발생 가능 (예: 실제로는 distinct value가 많은데 적다고 추정해 비효율적인 skip scan 시도). `ANALYZE` 갱신이나 *autovacuum analyze* 튜닝이 함께 필요

EXPLAIN 출력에서는 *별도 노드 이름이 아니라 `Index Scan`에 `Index Searches: N` 메트릭* 으로 표시됩니다 (PostgreSQL 18 EXPLAIN 강화).

### Skip Scan은 정공법이 아니다

pgEdge 정확한 표현:

> *"Skip scan is a planner optimization, not a universal substitute. You may still want a dedicated index that leads with your actual filter column for heavy OLTP workloads."*

즉 **OLTP에서 주력 쿼리에 leading 컬럼이 자주 빠진다면 그 컬럼이 leading인 별도 인덱스가 더 정공법**입니다. Skip scan은 *분석/리포팅 워크로드처럼 다양한 컬럼 조합으로 조회* 되는 경우의 *보너스 기능* 에 가깝습니다.

> **4장 요약**: PostgreSQL 18의 skip scan은 *leading 컬럼 없는 쿼리도 복합 인덱스 활용 가능* 하게 합니다. 단 *낮은 카디널리티 + 후행 equality* 에서만 효과적, B-tree 한정. *정공법은 여전히 leading 컬럼 매칭*.

## 5. AND vs OR: 복합 인덱스의 동작 차이

### AND: 복합 인덱스의 천국

```sql
CREATE INDEX idx ON orders (user_id, status, created_at);

SELECT * FROM orders
WHERE user_id = 100 AND status = 'paid' AND created_at >= '2026-01-01';
```

```
 Index Scan using idx on orders
   Index Cond: ((user_id = 100) AND (status = 'paid') AND (created_at >= '2026-01-01'))
```

ESR을 따른 인덱스라 *세 조건 모두 인덱스로 좁힘*. 가장 이상적인 패턴.

### OR: 복합 인덱스의 약점

```sql
SELECT * FROM orders
WHERE user_id = 100 OR status = 'urgent';
```

복합 인덱스 `(user_id, status, ...)` 기준으로 *user_id로 슬라이스 가능* 하지만 *status는 그 슬라이스 안에서만 정렬됨*. 즉 *status='urgent'를 인덱스 전체에서 찾으려면* B-tree의 leftmost prefix rule을 어기는 셈입니다.

옵티마이저의 선택:

- *각 컬럼에 단일 인덱스* 가 있다면 → **BitmapOr로 결합** ([2편](/blog/theory/db-index-02-scan-types) 주제)
- *복합 인덱스만 있다면* → 한쪽은 슬라이스, 한쪽은 *Seq Scan 또는 skip scan(PG 18+)*

**어떤 방식이 선택되는지는 옵티마이저의 cost 기반 판단** 에 따라 달라집니다. 통계, 셀렉티비티, 인덱스 크기에 따라 동일한 OR 쿼리에서도 다른 plan이 나올 수 있습니다.

> 즉 **OR 패턴이 흔하다면 복합 인덱스보다 단일 인덱스 여러 개가 유리한 경우가 많습니다**. BitmapOr가 자연스럽게 작동합니다.

### IN: 논리적으로 OR과 유사

`WHERE user_id IN (100, 200, 300)`은 *논리적으로* `WHERE user_id = 100 OR user_id = 200 OR user_id = 300`과 동치입니다. 다만 *옵티마이저 내부 표현과 plan은 DBMS/버전에 따라 달라질 수 있습니다*. PostgreSQL은 IN을 *ScalarArrayOpExpr* 로 처리하고, *같은 컬럼이라 복합 인덱스로 여러 슬라이스를 직접 처리* 하는 plan이 일반적입니다.

**PostgreSQL 18에서는 OR-to-ANY 변환 최적화** 가 추가되어 `WHERE a = 1 OR a = 2`가 `WHERE a = ANY(ARRAY[1, 2])`로 *자동 변환되어 인덱스 활용이 크게 개선* 됩니다 (PostgreSQL 18 공식 News에 *"better utilize recent indexing improvements"* 로 강조). 또한 *partial index* 가 OR의 한쪽 분기에 매칭되면 옵티마이저가 *분기별로 다른 인덱스를 활용* 하는 plan도 가능합니다. 즉 OR 처리는 *PG 18에서 상당히 개선된 영역* 입니다.

### AND/OR 혼합

```sql
WHERE (user_id = 100 AND status = 'paid') OR (user_id = 200 AND status = 'urgent')
```

이런 패턴은 *옵티마이저가 두 개의 별도 인덱스 슬라이스로 처리* 하거나 *Seq Scan* 입니다. 복잡한 OR 패턴이 많으면 *인덱스 설계가 어려워지는 영역* 입니다.

> **5장 요약**: AND는 복합 인덱스의 천국, OR는 약점. *OR가 흔하다면 단일 인덱스 여러 개 + BitmapOr* 가 종종 유리. PostgreSQL 18은 OR-to-array 변환으로 일부 개선.

## 6. INCLUDE와 복합 인덱스의 차이

[3편](/blog/theory/db-index-03-covering-index-ios)에서 다룬 INCLUDE 절과 *복합 인덱스(key 컬럼 추가)* 는 *겉보기에 비슷* 하지만 *근본적으로 다릅니다*.

### 두 방식 비교

```sql
-- 방식 A: 모두 key 컬럼
CREATE INDEX idx_a ON tab (id, name, email);

-- 방식 B: id만 key, 나머지 INCLUDE
CREATE INDEX idx_b ON tab (id) INCLUDE (name, email);
```

![복합 인덱스(key 컬럼 추가) vs INCLUDE: 같아 보이지만 다르다](/uploads/theory/db-index/composite-vs-include.svg)

| 특성 | 방식 A (모두 key) | 방식 B (INCLUDE) |
|---|---|---|
| Uniqueness 적용 | (id, name, email) 조합 | id만 |
| Internal node 크기 | 모든 컬럼 포함 → 큼 | id만 → 작음 |
| Leaf tuple 크기 | 모든 컬럼 포함 | INCLUDE 컬럼 포함 (동일) |
| `WHERE id=? AND name=?`로 인덱스 활용 | 가능 | 불가 (name은 검색 불가) |
| `SELECT id, name, email WHERE id=?`로 IOS | 가능 | 가능 |
| 좌측 컬럼 규칙 | (id, name, email)에 적용 | id에만 |

### 어느 방식을 선택할 것인가

**방식 A를 선택해야 할 때**:

- `WHERE name=? AND id=?` 같은 *복합 검색이 자주 발생*
- *이 컬럼 조합으로 정렬/그룹핑* 이 자주 일어남

**방식 B를 선택해야 할 때**:

- *id로만 검색하지만* `name`, `email`을 함께 SELECT
- *uniqueness는 id에만* 걸려야 함
- *Internal node를 가볍게* 유지하고 싶음

**핵심 사고**: *검색 키* 인지 *조회 데이터* 인지 구분. 검색 키는 *key 컬럼*, 단순 조회 데이터는 *INCLUDE*.

> **6장 요약**: 복합 인덱스(key 컬럼)는 *검색 + 정렬에 활용*, INCLUDE는 *조회 데이터만 추가*. 같은 컬럼 조합이라도 *어떤 방식이 맞는지* 는 워크로드가 결정.

## 7. 실전: 복합 인덱스 설계 패턴

### 패턴 1: 사용자별 시계열 조회

```sql
-- 자주 실행되는 쿼리
SELECT * FROM events
WHERE user_id = ?
ORDER BY created_at DESC
LIMIT 20;

-- 인덱스
CREATE INDEX idx_events_user_created
ON events (user_id, created_at DESC);
```

ESR: *equality(user_id)* + *sort(created_at DESC)*. `LIMIT 20`이 인덱스에서 직접 처리됨 → *매우 빠름*.

### 패턴 2: 다단계 필터링

```sql
SELECT * FROM products
WHERE category_id = ? AND is_active = true AND price BETWEEN ? AND ?;

-- 인덱스 (ESR 적용)
CREATE INDEX idx_products_filter
ON products (category_id, is_active, price);
```

equality 둘(category_id, is_active) + range 하나(price). *셀렉티브한 category_id가 leading* 이고 *range인 price는 마지막*.

### 패턴 3: 복합 unique constraint + INCLUDE

```sql
-- (tenant_id, email) 조합이 unique + 자주 함께 SELECT되는 컬럼
CREATE UNIQUE INDEX idx_users_unique
ON users (tenant_id, email) INCLUDE (full_name, created_at);
```

*검색 + uniqueness* 는 key, *조회만 하는 컬럼* 은 INCLUDE.

### 패턴 4: 잘못된 컬럼 순서로 인한 인덱스 무용

```sql
-- 안티패턴
CREATE INDEX idx_bad ON orders (status, user_id);

-- 자주 실행되는 쿼리는...
SELECT * FROM orders WHERE user_id = 100;
```

PostgreSQL 17 이하에서는 *Seq Scan으로 떨어지는 경우가 많고* (cost에 따라 Full-Index Scan이 선택될 수도 있음), PG 18+에서 status의 distinct value가 적다면 skip scan으로 일부 회복 가능하지만 *정공법은 컬럼 순서 변경*:

```sql
CREATE INDEX idx_good ON orders (user_id, status);
```

### 패턴 5: Range가 leading인 인덱스의 함정

```sql
-- 함정
CREATE INDEX idx_trap ON orders (created_at, user_id);

-- 쿼리
SELECT * FROM orders WHERE created_at >= '2026-01-01' AND user_id = 100;
```

leading이 *range* 라서 `user_id` 조건은 *인덱스에서 체크는 되지만 스캔 범위를 좁히지 못함*. *2026-01-01 이후 모든 행을 스캔* 하게 됩니다. 정공법:

```sql
CREATE INDEX idx_fix ON orders (user_id, created_at);
```

> **7장 요약**: ESR 적용 패턴이 가장 일반적. *컬럼 순서 잘못 잡으면 인덱스 활용 효율이 크게 떨어집니다* (Full-Index Scan/skip scan으로 일부 회복은 가능하지만 정공법은 아님). EXPLAIN으로 *Index Cond에 어떤 조건이 잡히는지* 확인이 정공법.

## 8. 정리

### 핵심 통찰

- **복합 인덱스는 *왼쪽 컬럼부터 차례로 정렬* 된 B-tree**: `(a, b, c)` = a 정렬, 같은 a 안에서 b 정렬, 같은 (a, b) 안에서 c 정렬.
- **Leftmost prefix rule**: *equality 조건이 leading 컬럼부터 차례로 있어야* 인덱스 스캔 범위가 좁혀진다. *equality 끊긴 첫 컬럼의 inequality까지가 한계*.
- **ESR Rule (경험적 가이드라인)**: *Equality 먼저*, Sort와 Range의 우선순위는 *워크로드(prefix 재사용성, ORDER BY/GROUP BY, range 위치)* 에 따라 결정. equality 컬럼 내부 순서는 *단순 셀렉티비티보다 prefix 재사용성과 정렬/그룹핑 매칭* 이 더 중요. PostgreSQL 공식 규칙이 아닌 *실무 휴리스틱* 이지만 강력한 출발점.
- **3컬럼을 넘어가면 신중히**: PostgreSQL 공식이 *"unlikely to be helpful"* 이라 명시. *너무 specific한 인덱스는 재사용성 ↓*. 다만 *covering 목적이나 명확한 패턴* 이 있으면 4~5 컬럼도 유효 가능.
- **AND는 복합 인덱스의 천국, OR는 약점**: OR가 흔하면 *단일 인덱스 + BitmapOr* 가 종종 더 효율적.
- **PostgreSQL 18 skip scan**: leading 컬럼 없는 쿼리도 복합 인덱스 활용 가능. 단 *낮은 카디널리티 prefix + 후행 equality* 에서만, *B-tree 한정*. 정공법 대체가 아니라 *보너스 기능*.
- **INCLUDE vs key 컬럼**: 검색 + 정렬에 쓰는 컬럼은 *key*, 조회만 하는 컬럼은 *INCLUDE*. uniqueness 적용 범위와 internal node 크기가 결정적 차이.
- **컬럼 순서가 인덱스 활용에 결정적 영향**: 같은 세 컬럼이라도 *순서를 바꾸면 전혀 다른 인덱스*. 쿼리 작성 순서가 아니라 *인덱스 정의 순서가 본질*. (단 skip scan/Full-Index Scan/BitmapOr 같은 우회 경로도 존재)

### 진짜 한 줄

> **복합 인덱스의 본질은 *컬럼 순서가 곧 정렬 순서*다.** 같은 세 컬럼이라도 *(a, b, c)와 (c, b, a)는 전혀 다른 인덱스* 이고, 같은 쿼리에서도 활용 여부가 갈립니다. ESR Rule은 실무에서 널리 쓰이는 경험적 가이드라인, skip scan은 PG 18+의 보너스.

### 통합된 답: 한 단락 정리

복합 인덱스(multicolumn index)는 *여러 컬럼을 묶어 정렬한 단일 B-tree* 입니다. `(a, b, c)`는 a로 먼저 정렬되고, 같은 a 안에서만 b로, 같은 (a, b) 안에서만 c로 정렬됩니다. 이 구조에서 파생되는 *leftmost prefix rule* 은 *equality 조건이 leading 컬럼부터 차례로 있어야 인덱스 스캔 범위가 좁혀진다* 는 것입니다. *equality가 끊긴 첫 컬럼의 inequality까지가 한계* 이고, 그 뒤 컬럼은 *Index Cond로 인덱스에서 적용은 되지만(heap fetch 줄임) 스캔 시작/종료 범위는 못 좁힙니다*. *leading 컬럼이 빠진 쿼리도 인덱스가 완전히 무용지물은 아닙니다*. *주력 활용 패턴에서는 벗어나지만* PG 17 이하에서는 *인덱스 전체를 훑는 방식* (편의상 'Full-Index Scan'으로 표기, 공식 plan node 이름은 아님), PG 18+는 *skip scan* 이라는 우회 경로가 있습니다 (어느 쪽이든 *옵티마이저가 cost가 유리하다고 판단했을 때만*). 컬럼 순서 결정의 *경험적 가이드라인* 은 **ESR Rule** 입니다. *Equality 컬럼을 먼저 두고 Sort/Range는 워크로드(prefix 재사용성, ORDER BY/GROUP BY, range 위치)에 따라 우선순위 결정* (PostgreSQL 공식 규칙은 아니고 MongoDB 가이드 origin). equality 컬럼 내부 순서는 *단순 셀렉티비티보다 prefix 재사용성, 정렬/그룹핑 매칭, 후속 range 조건, skip scan 기대 여부* 를 함께 보는 게 정확합니다. PostgreSQL 공식이 *"3컬럼 이상은 거의 도움이 안 된다"* 고 명시할 정도로 *과도하게 specific한 복합 인덱스는 재사용성이 낮지만*, *covering index 목적이나 명확한 워크로드 패턴* 이 있으면 4~5 컬럼도 유효 가능합니다. AND 조건은 복합 인덱스의 천국이지만 OR는 약점이라 *각 컬럼의 단일 인덱스 + BitmapOr* 가 종종 더 효율적입니다 (PostgreSQL 18은 *OR-to-ANY 변환* 으로 상당히 개선됨). *어떤 방식이 선택되는지는 옵티마이저의 cost 기반 판단* 에 따라 동일 쿼리에서도 갈립니다. IN은 *논리적으로 같은 컬럼에 대한 OR와 유사* 하지만 *옵티마이저 내부 표현과 plan은 DBMS/버전에 따라 달라질 수 있습니다*. PostgreSQL 18에 도입된 **skip scan** 은 *leading 컬럼이 빠진 쿼리도 복합 인덱스를 활용* 할 수 있게 해주는 신규 최적화입니다. 옵티마이저가 *omitted prefix의 distinct value들* 을 식별해 *작은 range seek을 반복* 하는 방식이고, *cost가 유리하다고 판단할 때만 자동 선택* 됩니다. 단 *B-tree 한정*, *낮은 카디널리티 prefix + 후행 equality* 에서만 효과적이며, *통계가 stale하면 잘못된 선택* 이 발생 가능해 `ANALYZE`/autovacuum 갱신이 필요합니다. 정공법은 여전히 *leading 컬럼 매칭*. 복합 인덱스(key 컬럼)와 INCLUDE의 차이는 *검색/정렬에 쓰는지 vs 조회 데이터인지* 이고, uniqueness 적용 범위, internal node 크기, leftmost prefix rule 적용 범위가 결정적으로 갈립니다. *컬럼 순서가 인덱스 활용 방식에 결정적 영향* 을 주므로, 같은 세 컬럼이라도 순서를 바꾸면 전혀 다른 인덱스가 되고, 워크로드 분석이 곧 인덱스 설계의 출발점입니다.

---

### 글의 범위와 한계

이 글은 *PostgreSQL 기준* 입니다. leftmost prefix rule 자체는 *MySQL, MongoDB, SQL Server 등 대부분의 RDBMS에 공통* 이지만, skip scan은 PostgreSQL 18에서 신규 도입된 기능으로 *Oracle은 9i(2001)에서 도입했고, MySQL은 8.0+의 일부 케이스에서 지원, SQL Server는 자체 변형이 있습니다*. 정확한 동작은 DBMS별 매뉴얼 확인 필요.

또한 이번 편은 *복합 GIN/GiST/BRIN 인덱스* 는 깊이 다루지 않았습니다. 이들은 *leftmost prefix rule이 적용되지 않거나 다르게 적용* 됩니다 (PostgreSQL 공식 문서에 따르면 *GIN/BRIN은 컬럼 순서에 무관하게 효율 동일*). B-tree 외 인덱스 타입은 후속 편에서 부분적으로 보완 예정.

ESR Rule의 *"S(Sort)"* 위치에 대한 논쟁도 있습니다. 일부는 *Sort를 Equality와 Range 사이에 두지 않고 별도 고려* 하는 입장입니다. 본문에서는 ESR을 *기본 원칙* 으로 다뤘지만, *정렬 컬럼은 인덱스의 ASC/DESC 옵션과 함께 별도 검토* 가 필요합니다 (PostgreSQL `CREATE INDEX ... (col DESC NULLS LAST)`).

### 참고 (1차 자료 우선)

- [PostgreSQL Documentation — Multicolumn Indexes](https://www.postgresql.org/docs/current/indexes-multicolumn.html): leftmost prefix rule 공식 정의 + skip scan 예시
- [PostgreSQL Documentation — Release 18](https://www.postgresql.org/docs/current/release-18.html): skip scan 신규 도입 (Peter Geoghegan)
- [PostgreSQL News — PostgreSQL 18 Released!](https://www.postgresql.org/about/news/postgresql-18-released-3142/): skip scan + OR-to-array 변환 공식 announcement
- [Neon — PostgreSQL 18 Skip Scan B-tree](https://neon.com/postgresql/postgresql-18/skip-scan-btree): skip scan 동작 + 한계 상세
- [pgEdge — Postgres 18: Skip Scan](https://www.pgedge.com/blog/postgres-18-skip-scan-breaking-free-from-the-left-most-index-limitation): skip scan은 정공법이 아닌 보너스
- [Better Stack — How to Use Skip Scans in PostgreSQL 18](https://betterstack.com/community/guides/databases/skip-scans-postgres/): `Index Searches: N` 메트릭 분석
- [Mastering Postgres — Composite Indexes](https://masteringpostgres.com/watch/composite-indexes): *"left to right, no skipping, stops at the first range"* 직관적 정리
- [SolarWinds — The Left-Prefix Index Rule](https://orangematter.solarwinds.com/2019/02/05/the-left-prefix-index-rule/): 사전식 정렬 시각화
- [PostgreSQL Documentation — CREATE INDEX](https://www.postgresql.org/docs/current/sql-createindex.html): 32 컬럼 한계, ASC/DESC/NULLS 옵션
- [That Guy From Delhi — The "Skip Scan" You Already Had Before v18](https://www.robins.in/2026/02/the-skip-scan-you-already-had-before-v18.html): PG 17 이하에서도 cost 기반으로 Full-Index Scan 활용 가능

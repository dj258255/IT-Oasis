---
title: '데이터베이스 인덱스 ③: Covering Index와 Index-Only Scan'
titleEn: 'Database Index ③: Covering Index and Index-Only Scan'
description: plan에 Index Only Scan이 잡혔다고 진짜 IOS는 아니에요. PostgreSQL의 IOS는 covering(쿼리 컬럼이 인덱스에) + visibility(VM all-visible) 두 단계 조건을 모두 만족해야 Heap Fetches가 0이 됩니다. INCLUDE 절은 covering을, VACUUM은 visibility를 충족시키는 도구. INCLUDE의 leaf-only 저장 메커니즘과 인덱스 타입별 IOS 지원, 그리고 PG12 이전 insert-only Mandrill 함정까지.
descriptionEn: An "Index Only Scan" node in the plan does not mean a real IOS. PostgreSQL requires both conditions — covering (all referenced columns in the index) and visibility (VM all-visible) — for Heap Fetches to drop to zero. INCLUDE satisfies covering; VACUUM satisfies visibility. Covers INCLUDE's leaf-only storage, IOS support per index type, and the PG12 insert-only Mandrill outage.
date: 2026-04-24T00:00:00.000Z
tags:
  - Database
  - Index
  - PostgreSQL
  - Index-Only Scan
  - Covering Index
  - INCLUDE
  - Visibility Map
  - VACUUM
category: theory/Database
draft: false
coverImage: "/uploads/theory/db-index/cover-3.svg"
series: "데이터베이스 인덱스"
seriesOrder: 3
---

## 0. 들어가며

인덱스 시리즈 3편이에요. [2편](/blog/theory/db-index-02-scan-types)에서 *스캔의 종류* 를 살펴봤다면, 이번 편은 그 중 *조건이 맞을 때 가장 강력한 plan* 인 **Index-Only Scan(IOS)** 만들기에 집중합니다. 핵심은 — *plan에 `Index Only Scan`이 떠도 진짜 IOS는 아닐 수 있어요*. PostgreSQL의 IOS는 *두 단계 조건* 을 만족해야 진짜 효과를 봅니다.

핵심 메시지: **Index-Only Scan은 인덱스만으로 답을 완성해 힙 접근을 회피할 수 있을 때 매우 강력한 plan** 이에요 (다만 인덱스가 너무 크거나 캐시에 못 들어가면 Index Scan보다 빠르지 않을 수도 있어요). PostgreSQL에서 진짜 IOS가 되려면 *두 단계 조건* 이 모두 충족되어야 합니다 — (1) **covering**: 쿼리에 필요한 모든 컬럼이 인덱스에 있고, (2) **visibility**: 해당 페이지가 [Visibility Map](/blog/theory/db-storage-03-hot-update-visibility-map)에 *all-visible* 로 표시되어야 해요. 둘 중 하나만 깨져도 *IOS plan은 잡혔지만 실제로는 힙 fetch가 발생* 하는 상황(`Heap Fetches > 0`)이 됩니다. *이 두 조건이 충족되어야 IOS가 성립하지만, 실제 성능은 인덱스 크기, 캐시 상태, correlation 같은 추가 요소에도 영향을 받아요*. **`INCLUDE` 절은 covering 조건을, `VACUUM`은 visibility 조건을 충족시키는 도구** 예요.

![인덱스 시리즈 3편 커버 — Covering + Visibility 두 조건](/uploads/theory/db-index/cover-3.svg)

> **글의 범위**: 이번 편은 *IOS의 두 단계 조건 + INCLUDE를 활용한 covering index 설계* 까지. Visibility Map 자체의 구조와 VACUUM의 동작은 [스토리지 ③편](/blog/theory/db-storage-03-hot-update-visibility-map)과 cross-reference하며 *인덱스 측면에서만* 다뤄요. 복합 인덱스는 4편 주제.

## 1. Index Scan vs Index-Only Scan — 진짜 차이

### 동작 비교

[2편](/blog/theory/db-index-02-scan-types)에서 다룬 내용 복습 + 한 단계 더:

**Index Scan**: 인덱스에서 후보 위치(CTID)를 찾고 → 힙(테이블)으로 점프해서 *실제 row* 를 읽음. *random IO 누적* 이 비용의 핵심.

**Index-Only Scan**: 인덱스에서 후보를 찾되 → *힙으로 안 감*. 인덱스 안에 *쿼리가 필요한 모든 컬럼* 이 있으면 거기서 답이 끝나요.

```sql
-- Index Scan
EXPLAIN ANALYZE SELECT name FROM grades WHERE id = 7;
```

```
 Index Scan using grades_pkey on grades
   Index Cond: (id = 7)
```

`name` 컬럼이 인덱스에 없으니 *힙으로 가야 해요*.

```sql
-- Index-Only Scan (가능한 경우)
EXPLAIN ANALYZE SELECT id FROM grades WHERE id = 7;
```

```
 Index Only Scan using grades_pkey on grades
   Index Cond: (id = 7)
   Heap Fetches: 0
```

`id`만 필요하고 *id는 PK 인덱스에 있으니* — 힙 접근 불필요. **`Heap Fetches: 0`이 진짜 IOS의 신호** 예요.

### 왜 IOS가 강력한가

힙 접근은 *random IO가 될 가능성이 높지만*, buffer cache hit이면 *메모리 접근으로 처리될 수도 있어요*. 그래도 *cache miss 시* 디스크까지 다녀와야 합니다. IOS는 이 *힙 접근 자체를 통째로 회피* 해요 — 인덱스 자체는 *정렬된 작은 자료구조* 라 cache 적중률도 높고 buffer pool에 상주할 가능성이 큽니다. 그래서 *단순한 카운트나 키만 조회하는 쿼리* 에서 IOS는 *힙 접근을 제거함으로써 상당한 성능 개선* 을 보일 수 있어요 (정확한 폭은 워크로드/cache 상태에 따라 다름).

> **1장 요약** — IOS는 *힙 접근을 통째로 회피* 해 random IO를 없애요. `Heap Fetches: 0`이 진짜 IOS의 결정적 신호.

## 2. IOS의 두 단계 조건 — 한 가지만 만족해서는 부족

### 표면적 조건과 실제 조건

**표면적 조건 (covering)**: *쿼리에 필요한 모든 컬럼* 이 인덱스에 있어야 해요.

```sql
-- idx에 a, b만 있는 경우
SELECT a, b FROM tab WHERE a = 1;          -- IOS 가능 (a, b 모두 인덱스에)
SELECT a, b, c FROM tab WHERE a = 1;       -- IOS 불가 (c가 없음)
SELECT count(*) FROM tab WHERE a > 0;      -- IOS 가능 (count는 컬럼 값 불필요)
```

**실제 조건 (covering + visibility)**: 표면적 조건은 *plan을 IOS로 잡히게* 할 뿐, *실제로 힙 접근을 회피* 하려면 PostgreSQL Wiki가 명명한 두 번째 조건이 필요해요 — **Visibility Map(VM) 의 해당 페이지 *all-visible* 비트가 켜져 있어야 한다**.

![IOS의 두 단계 조건 — covering(plan time) + visibility(런타임)](/uploads/theory/db-index/ios-two-conditions.svg)

### 왜 visibility 조건이 따로 필요한가

PostgreSQL은 MVCC 데이터베이스예요 — *동시에 실행되는 다른 트랜잭션들이 보는 row 버전이 다를 수 있어요*. 각 row의 *visibility 정보(`xmin`/`xmax`)* 는 *힙에만* 저장되고 *인덱스에는 없습니다*. 그래서:

> *"인덱스에서 후보를 찾았다 = 그 row가 내 트랜잭션에 보이는가?" 는 별개의 질문*

원칙적으로 *visibility 확인을 위해 매번 힙을 방문* 해야 하지만 — 그러면 IOS의 의미가 사라져요. PostgreSQL의 해법: **Visibility Map (VM)** — 페이지 단위로 *"이 페이지의 모든 row가 모든 활성 트랜잭션에 visible한가?"* 를 *비트 한 개* 로 표시.

VM 작동 방식:

1. IOS가 인덱스에서 후보 찾음
2. *해당 후보의 heap page에 대해 VM의 all-visible bit 확인*
3. **bit가 켜져 있음** → *visibility 확인을 위한 heap 방문이 생략됨* (VM 확인 자체는 항상 필요), 인덱스 데이터로 답 반환
4. **bit가 꺼져 있음** → *힙 방문해서 직접 visibility 확인* (`Heap Fetches`가 증가)

PostgreSQL 공식 문서:

> *"visibility map is four orders of magnitude smaller than the heap it describes ... in most situations the visibility map remains cached in memory all the time"*

VM 자체는 *매우 작아 대부분의 경우 메모리에 상주* 하지만, 그 비트가 *꺼져 있으면 힙으로 가야* 해요.

### Heap Fetches가 0이 아니면 진짜 IOS 아님

```
 Index Only Scan using ...
   Heap Fetches: 1234
```

이런 plan은 *겉보기에 IOS* 지만 *1234번 힙 방문* 이 있었어요. 다만 **`Heap Fetches`는 *힙 방문 횟수* 이지 *디스크 IO 횟수* 가 아니에요** — 같은 페이지를 반복 방문할 수도 있고 buffer cache hit이면 메모리 접근으로 끝나요. 실제 디스크 IO 여부는 `EXPLAIN (ANALYZE, BUFFERS)`의 *shared hit / shared read* 를 함께 봐야 정확히 판단 가능. 그래도 *Heap Fetches가 0이 아니라는 사실 자체* 가 *진짜 IOS의 효과는 약화된다* 는 신호. PostgreSQL Wiki가 *"index-mostly scans"* 라는 표현이 더 정확하다고 짚는 이유예요.

> **2장 요약** — 진짜 IOS의 조건은 **(1) covering — 쿼리 컬럼 모두 인덱스에 있음, (2) visibility — VM에 all-visible 표시**. 둘 다 만족할 때만 `Heap Fetches: 0`. 한 가지만 깨져도 plan은 잡혔지만 효과는 사라져요.

## 3. INCLUDE 절 — covering 조건을 만족시키는 도구

### 기존 방식의 문제

PostgreSQL 11 이전에는 covering index를 만들려면 *원하는 컬럼을 모두 key 컬럼으로* 추가해야 했어요:

```sql
-- 11 이전 방식
CREATE UNIQUE INDEX idx_old ON tab (id, name, email);
```

문제는:

1. *uniqueness* 가 *(id, name, email) 조합* 에 적용 — 원래 의도(id만 unique)와 다름
2. *navigation tree(internal node)* 도 모든 컬럼을 저장해 *인덱스 비대화*
3. *복합 인덱스의 좌측 컬럼 규칙* 에 모든 컬럼이 묶임 (4편 주제)

### INCLUDE 절의 도입 (PostgreSQL 11+)

```sql
-- 11+ 방식
CREATE UNIQUE INDEX idx_new ON tab (id) INCLUDE (name, email);
```

**핵심 차이**: INCLUDE 컬럼은 *leaf tuple에만* 저장되고 *상위 internal/navigation node에는 들어가지 않아요*. PostgreSQL 18 공식 문서:

> *"the values of columns listed in the INCLUDE clause are included in leaf tuples which correspond to heap tuples, but are not included in upper-level index entries used for tree navigation"*

![INCLUDE 절 — leaf tuple에만 저장, navigation node에는 안 감](/uploads/theory/db-index/include-leaf-only.svg)

이 구조 차이가 만드는 효과:

- **Uniqueness는 key(id)에만** 적용 — 원래 의도 유지
- **Upper-level navigation entry는 작게 유지** (INCLUDE 컬럼이 안 들어가니까) → tree 탐색 효율 측면에서는 *(id, name, email)을 모두 key로 넣는 방식보다 유리*. 다만 *leaf tuple은 INCLUDE 컬럼만큼 커지므로 전체 인덱스 크기는 증가* 해요 (즉 *항상 더 작은 인덱스가 되는 건 아님*)
- **B-tree 검색은 key로만** — 즉 INCLUDE 컬럼은 *검색에 못 쓰임* (그 컬럼으로 WHERE 필터링은 인덱스 못 활용)

### INCLUDE의 사용 예시

자주 보는 패턴 — *PK + 추가 데이터 컬럼*:

```sql
CREATE UNIQUE INDEX idx_users_id_email
ON users (id) INCLUDE (email);

-- 이제 IOS 가능
SELECT id, email FROM users WHERE id = 100;
```

```
 Index Only Scan using idx_users_id_email on users
   Index Cond: (id = 100)
   Heap Fetches: 0
```

또 다른 패턴 — *조회 키 + 자주 SELECT되는 컬럼*:

```sql
CREATE INDEX idx_orders_user_amount
ON orders (user_id) INCLUDE (amount, created_at);

-- IOS로 사용자별 주문 합계 빠르게
SELECT SUM(amount) FROM orders WHERE user_id = 42;
```

### INCLUDE의 트레이드오프

**비용 1 — 인덱스 크기 증가**

INCLUDE 컬럼은 *모든 leaf tuple* 에 복사되어 저장돼요. 큰 컬럼(긴 문자열, JSON 등)을 INCLUDE하면 *인덱스가 비대해져* 메모리에 못 들어가고 *디스크 IO* 가 늘어납니다. PostgreSQL 공식 문서가 명시:

> *"It's wise to be conservative about adding non-key payload columns to an index, especially wide columns"*

**비용 2 — UPDATE 시 인덱스 갱신 트리거**

INCLUDE 컬럼이 *UPDATE되면 인덱스도 갱신* 해야 해요 — *[HOT update](/blog/theory/db-storage-03-hot-update-visibility-map)가 깨질 수 있어요*. 즉 *자주 바뀌는 컬럼을 INCLUDE하면 HOT 비율 ↓ → bloat 가속화*.

**비용 3 — B-tree index entry 크기 제한**

PostgreSQL 18 공식 B-Tree 문서가 명시하듯 — **B-tree index entry는 *TOAST compression 이후* 에도 *대략 페이지의 1/3* 을 넘을 수 없어요** (8KB 페이지 기준 약 2.7KB). 실제로 *"ERROR: index row size N exceeds btree version 4 maximum 2704 for index"* 같은 에러가 발생합니다. 즉 큰 컬럼을 INCLUDE하면 *insert 자체가 실패* 할 수 있어요 — text 본문, 큰 JSON, 긴 array 등을 INCLUDE할 때 특히 주의.

**비용 4 — 32 컬럼 제한**

key + INCLUDE 합쳐서 *32개* 가 한계 (compile time 변경 가능하지만 일반적이지 않음).

### 어떤 컬럼을 INCLUDE할 것인가

**좋은 후보**:

- 자주 함께 SELECT되는 작은 컬럼 (int, short string)
- *거의 안 바뀌는* 컬럼
- *값이 작은* 컬럼

**피해야 할 후보**:

- 자주 UPDATE되는 컬럼 (HOT 비율 깨뜨림)
- 큰 컬럼 (text 본문, JSON, BLOB)
- *간헐적으로만 SELECT되는* 컬럼 (인덱스 비용이 이득보다 큼)

PostgreSQL 공식의 핵심 가이드:

> *"there is little point in including payload columns in an index unless the table changes slowly enough that an index-only scan is likely to not need to access the heap"*

즉 **INCLUDE는 *변화가 적은 테이블* 에 가장 효과적**. 변화가 잦으면 VM이 자꾸 reset되어 IOS 효과가 사라져요.

> **3장 요약** — INCLUDE 절은 *covering 조건* 을 만족시키는 정석 도구. *leaf tuple에만* 저장, navigation node에는 안 감. 단점은 *인덱스 크기 + UPDATE 비용 + tuple size 한계 + 32 컬럼 제한*. *변화가 적은 테이블* 에 가장 효과적.

## 4. Visibility Map과 VACUUM — visibility 조건의 관리

### VM은 어떻게 갱신되는가

VM의 *all-visible* 비트는 *VACUUM 명령* 이 갱신해요 (autovacuum 포함). 핵심 동작:

1. VACUUM이 페이지를 스캔하며 *모든 row가 모든 활성 트랜잭션에 visible* 인지 확인
2. 조건 만족하면 *all-visible bit set*
3. 그 페이지에 *INSERT / UPDATE / DELETE가 발생* 하면 *bit reset*

즉 VM은 **트랜잭션 활동에 *역방향* 으로 반응** 해요 — 변화가 발생할 때마다 깎이고, VACUUM이 와야 다시 채워집니다.

![VM은 VACUUM이 채우고 write activity가 깎는다](/uploads/theory/db-index/vm-vacuum-cycle.svg)

### IOS와 VACUUM의 직접적 관계

**핵심 시나리오** (CYBERTEC 사례):

> 큰 테이블에 *단 하나의 row만 UPDATE* 해도 — 그 row가 속한 페이지의 *all-visible bit이 reset* 돼요. 결과적으로 그 페이지에 매칭하는 IOS 쿼리는 *전체 페이지의 모든 row에 대해 heap fetch* 를 해야 합니다. UPDATE 한 번으로 *Heap Fetches가 수백~수천 단위로 증가* 할 수 있어요.

이게 **자주 변경되는 테이블에서 IOS가 빛을 못 보는 이유**. 반대로:

- *append-only 테이블* (로그, 이벤트, 시계열 데이터) — *VACUUM이 함께 도는 경우* VM이 안정적으로 채워짐 → IOS 매우 효과적. 다만 **append-only라고 자동으로 IOS가 빛나는 게 아니에요** — PostgreSQL 12 이전에는 *insert만 발생하는 테이블에 autovacuum이 트리거되지 않아* VM이 안 채워지는 함정이 있었어요 (Mandrill outage 사례). PostgreSQL 13+에서는 `autovacuum_vacuum_insert_scale_factor` 도입으로 insert 기반 트리거가 가능해졌지만 *기본값 0.2* 라 대형 테이블은 *0.005~0.01 수준으로 낮춰야* 효과적.
- *변경이 잦은 OLTP 핫 테이블* — VM이 자주 reset → IOS plan은 잡혀도 Heap Fetches 누적

### autovacuum 튜닝과 IOS

VM의 최신성을 유지하려면 *autovacuum이 충분히 자주* 돌아야 해요. 관련 파라미터:

- **`autovacuum_vacuum_threshold`** (기본 50): VACUUM 트리거 최소 행 수
- **`autovacuum_vacuum_scale_factor`** (기본 0.2): 테이블 행 수의 *20%* 가 변경되면 트리거
- **`autovacuum_naptime`** (기본 1분): autovacuum launcher 주기

**대형 테이블의 함정**: scale_factor 0.2 = 1억 행 테이블이라면 *2천만 행이 바뀌어야 트리거*. 그 사이 VM은 거의 reset 상태 → IOS 효과 사라짐. 해법으로 *워크로드에 따라 scale_factor를 1% 수준까지 낮추는* 패턴이 자주 등장:

```sql
ALTER TABLE huge_table SET (
  autovacuum_vacuum_scale_factor = 0.01,  -- 워크로드에 따라 조정
  autovacuum_vacuum_threshold = 1000      -- 절대 행 수 함께 조정
);
```

다만 *너무 낮추면 autovacuum이 너무 자주 돌아 IO 부담* 이 돼요 — 특히 *OLTP 환경* 에서는 *과도한 autovacuum으로 인한 IO 증가* 가 응답 시간에 직접 영향을 줄 수 있으므로, *Heap Fetches와 dead tuple 비율, autovacuum 부하* 를 함께 모니터링하며 점진적으로 조정하는 게 정확.

### Heap Fetches 진단

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, email FROM users WHERE id < 1000;
```

```
 Index Only Scan using idx_users_id_email on users
   Heap Fetches: 854
   Buffers: shared hit=12 read=854
```

해석:

- **`Heap Fetches: 854`**: 1000개 후보 중 *854개에 대해 힙 방문*. VM이 거의 무용지물 — *진짜 IOS 효과 거의 없음*
- 처방: `VACUUM users` 또는 *autovacuum 튜닝*

`VACUUM` 후 다시 측정해 *`Heap Fetches`가 0 또는 매우 작은 값* 이 되어야 IOS가 효과 발휘.

> **4장 요약** — VM의 *all-visible 비트* 는 VACUUM이 갱신, 트랜잭션이 reset해요. *append-only + 적절한 VACUUM이 함께 이루어질 때* IOS에 이상적이며, *VACUUM 없는 append-only는 오히려 IOS가 안 되는 함정* (Mandrill 사례)이 있어요. 대형 고변경 테이블에서는 `autovacuum_vacuum_scale_factor`를 *0.01 수준까지 낮추는 패턴* 이 자주 등장하고, *insert-only 테이블* 은 PostgreSQL 13+의 `autovacuum_vacuum_insert_scale_factor`를 활용 — 워크로드에 따라 *Heap Fetches, dead tuple, autovacuum 부하* 를 함께 모니터링하며 조정해야 합니다.

## 5. IOS가 가능한 인덱스 타입 — 모든 인덱스가 되는 건 아님

### 인덱스 타입별 IOS 지원

PostgreSQL 18 공식 문서에 따르면 — **IOS 지원은 *index access method* 뿐 아니라 *operator class* 에 의존**. 핵심 조건은 *"인덱스 항목에서 원본 값을 저장하거나 재구성할 수 있어야 한다"* 는 것:

![인덱스 타입별 IOS / INCLUDE 지원](/uploads/theory/db-index/index-type-ios-support.svg)

| 인덱스 타입 | IOS 지원 | INCLUDE 지원 | 비고 |
|---|---|---|---|
| **B-tree** | 일반적으로 지원 | 지원 | 가장 일반적, 모든 operator class |
| **GiST** | 일부 operator class | 지원 | 원본 값 재구성 가능한 클래스에 한함 |
| **SP-GiST** | 일부 operator class | 지원 | non-balanced 트리, operator class 의존 |
| **GIN** | 불가 | 불가 | 인덱스 항목이 원본 값의 일부만 저장 |
| **BRIN** | 불가 | 불가 | 매우 큰 테이블의 요약 인덱스 |
| **Hash** | 불가 | 불가 | equality only |

### 왜 GIN은 IOS 불가능한가

PostgreSQL 공식 문서:

> *"GIN indexes cannot support index-only scans because each index entry typically holds only part of the original data value"*

즉 GIN의 *각 인덱스 항목은 원본 값의 일부* 만 가짐 — *array의 각 원소*, *tsvector의 각 lexeme* 등. 인덱스에서 *원본을 재구성할 수 없으므로* IOS 불가.

### 실무적 함의

- **B-tree는 IOS의 정석**: 대부분의 IOS 사례는 B-tree, 모든 operator class에서 작동
- **GiST/SP-GiST는 operator class 단위로 확인 필요**: 모든 GiST/SP-GiST 인덱스가 IOS 되는 건 아니고 — *원본 값을 저장/재구성할 수 있는 operator class* 에서만 작동. `pg_opclass` 카탈로그 또는 EXPLAIN으로 검증
- **GIN은 IOS 자체 불가**: full-text 검색에서 *추가 컬럼 조회가 필요하면 무조건 힙 접근*

> **5장 요약** — IOS는 *B-tree, GiST(부분), SP-GiST(부분)* 에서만 지원. *GIN/BRIN/Hash* 는 IOS 불가. INCLUDE 절도 *B-tree, GiST, SP-GiST* 만 지원.

## 6. 실전 — IOS 만들기 패턴

### 패턴 1 — count(*) 쿼리에 IOS 적용

```sql
-- 인덱스 없을 때
SELECT count(*) FROM orders WHERE user_id = 42;
-- → Seq Scan (전체 테이블 스캔)

-- 인덱스 추가
CREATE INDEX idx_orders_user_id ON orders (user_id);
SELECT count(*) FROM orders WHERE user_id = 42;
-- → Index Only Scan + Heap Fetches: 0 (VM 최신이면)
```

`count(*)`는 *컬럼 값을 직접 참조하지 않음* → covering 조건은 *키만 있어도 자동 만족*. 다만 *visibility 조건은 별개* 라서 — VM이 안 채워져 있으면 *`Heap Fetches`가 발생* 해 IOS 효과가 줄어듭니다 (즉 "인덱스만 만들면 끝"이 아님).

### 패턴 2 — 자주 함께 조회되는 컬럼 INCLUDE

```sql
-- 자주 실행되는 쿼리
SELECT id, email, created_at FROM users WHERE id = 100;

-- IOS를 위한 인덱스
CREATE UNIQUE INDEX idx_users_lookup
ON users (id) INCLUDE (email, created_at);
```

`email`과 `created_at`이 *변경 빈도가 낮은 컬럼* 이라면 효과적. *사용자 프로필 조회 API* 같은 패턴에 자주 등장.

### 패턴 3 — 시계열 / append-only 테이블

```sql
-- 로그 테이블 (append-only)
CREATE INDEX idx_events_at_user
ON events (created_at, user_id) INCLUDE (event_type);

-- IOS 가능
SELECT created_at, user_id, event_type
FROM events
WHERE created_at >= '2026-01-01';
```

*append-only 패턴* 이라 *VACUUM이 함께 도는 경우* VM이 안정적으로 채워져 IOS의 이상적 환경이 돼요. **다만 PostgreSQL 12 이전 버전에서는 *insert만 있는 테이블에 autovacuum이 트리거되지 않아* VM이 안 채워지는 함정** 이 있었습니다 (Mandrill outage가 실제 사례). 13+에서는 `autovacuum_vacuum_insert_scale_factor` 설정으로 해결 가능:

```sql
ALTER TABLE events SET (
  autovacuum_vacuum_insert_scale_factor = 0.005
);
```

### 패턴 4 — IOS 망가지는 것 진단

`Heap Fetches > 0`이면 *원인 진단*:

1. **VM이 stale** → `VACUUM table` 실행
2. **테이블이 자주 변경** → autovacuum scale_factor 낮추기
3. **장기 트랜잭션이 VACUUM 막음** → `pg_stat_activity`로 long-running tx 확인 ([스토리지 ③편](/blog/theory/db-storage-03-hot-update-visibility-map), 시리즈 6편 참고)
4. **partitioned table** — 각 파티션의 VM 상태 따로 관리

### 패턴 5 — IOS가 진짜 효과 있는지 검증

```sql
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT user_id, count(*) FROM orders WHERE user_id < 100 GROUP BY user_id;
```

체크리스트:

- Plan 노드가 `Index Only Scan`인가
- `Heap Fetches: 0`인가
- `Buffers: shared hit` 위주인가 (디스크 read 거의 없음)
- 비교: `EXPLAIN ANALYZE`로 *Index Scan 강제 실행* (`SET enable_indexonlyscan = off`)했을 때 *실제로 더 느린가*

> **6장 요약** — IOS가 효과를 발휘하려면 *append-only + 적절한 VACUUM / 잘 설계된 INCLUDE / autovacuum 튜닝* 세 가지가 함께. EXPLAIN으로 *plan + Heap Fetches + Buffers* 모두 확인.

## 7. 정리

### 핵심 통찰

- **IOS는 조건이 맞을 때 가장 강력한 plan**: 힙 접근을 *통째로 회피* 해 random IO 제거. `Heap Fetches: 0`이 진짜 IOS의 결정적 신호. 다만 *인덱스가 너무 크거나 캐시에 못 들어가면* IOS 효과가 줄어들 수 있다.
- **두 단계 조건**: (1) *covering* — 쿼리 컬럼 모두 인덱스에, (2) *visibility* — VM에 all-visible. 한 가지만 깨져도 *plan은 잡혔지만 실제로는 힙 fetch 발생*.
- **INCLUDE 절은 covering 조건 도구**: leaf tuple에만 저장, navigation node 안 감. uniqueness는 key 컬럼에만. *PostgreSQL 11+* 에서 사용 가능.
- **VM은 VACUUM이 갱신, 트랜잭션이 reset**: *append-only + 적절한 VACUUM* 에서 IOS가 빛나고, 변경 잦은 테이블에서는 효과가 사라진다. *insert-only 테이블* 도 *PostgreSQL 12 이전엔 autovacuum이 안 와 VM이 안 채워지는 함정* 있음 (Mandrill 사례) — *13+의 `autovacuum_vacuum_insert_scale_factor` 활용*. 대형 고변경 테이블에서는 `autovacuum_vacuum_scale_factor`를 1% 수준까지 낮추는 패턴이 흔하지만 워크로드에 따라 *Heap Fetches와 autovacuum 부하 모니터링하며 조정* 하는 게 정확.
- **INCLUDE 트레이드오프**: 인덱스 크기 ↑ + UPDATE 시 갱신 비용 + B-tree entry는 *TOAST 후 약 페이지의 1/3* 제한 (8KB 페이지 기준 약 2.7KB) + 32 컬럼 제한. *작고 거의 안 바뀌는 컬럼* 만 INCLUDE.
- **IOS 가능 인덱스**: *index access method + operator class* 에 의존. *B-tree* 는 일반적으로 지원, *GiST/SP-GiST* 는 *원본 값을 재구성 가능한 operator class* 에서만, *GIN/BRIN/Hash는 불가*.
- **PostgreSQL Wiki의 정확한 명칭**: *"index-mostly scan"* — IOS plan이라도 *항상 힙 회피되는 건 아니라* 는 뉘앙스.

### 진짜 한 줄

> **`Index Only Scan`이 plan에 떠도 진짜 IOS는 아니에요 — `Heap Fetches: 0`을 봐야 합니다.** Covering(`INCLUDE`)과 Visibility(`VACUUM`) 두 조건이 함께 만족되어야 *진짜* IOS.

### 통합된 답 — 한 단락 정리

Index-Only Scan은 *인덱스만으로 답을 완성* 해 힙 접근을 통째로 회피할 수 있을 때 *매우 강력한 plan* 이지만 (인덱스가 너무 크거나 캐시에 못 들어가면 효과는 줄어듭니다), PostgreSQL의 IOS는 *plan에 잡혔다고 진짜 IOS는 아니에요* — *`Heap Fetches: 0`* 이어야 합니다 (다만 `Heap Fetches`는 *힙 방문 횟수* 이지 *디스크 IO 횟수* 는 아니므로 실제 IO는 BUFFERS의 shared hit/read로 함께 확인). 힙 접근은 *random IO가 될 가능성이 높지만 buffer cache hit이면 메모리 접근* 으로 끝날 수도 있어요. 진짜 IOS의 *두 단계 조건*: (1) **covering** — 쿼리에 필요한 모든 컬럼이 인덱스에 있어야 하고, (2) **visibility** — Visibility Map에 *all-visible bit* 이 켜져 있어야 합니다 (VM 확인 자체는 항상 필요, *bit가 켜져 있을 때만 heap 방문이 생략*). VM은 *매우 작아 대부분의 경우 메모리에 상주* 해요. 두 조건이 충족되어야 IOS가 *성립* 하지만, *실제 성능은 인덱스 크기, 캐시 상태, correlation 같은 추가 요소* 에도 영향을 받아요. 첫 번째는 *INCLUDE 절* 로 만족시킵니다 — PostgreSQL 11+에서 도입, *leaf tuple에만 저장 + navigation node 안 들어감 + uniqueness는 key 컬럼에만*. 다만 *INCLUDE 컬럼이 자주 UPDATE되면 HOT update가 깨지고*, *큰 컬럼이면 인덱스 비대화*, *B-tree index entry는 TOAST 후에도 약 페이지의 1/3 한계*, *총 32 컬럼 제한* 같은 트레이드오프가 따라요. 두 번째 조건(visibility)은 *VACUUM이 갱신, 트랜잭션이 reset* 하는 동적 상태라 — *append-only + 적절한 VACUUM이 함께 이뤄질 때 IOS에 이상적* 이고, *변경이 잦은 테이블이나 VACUUM 없는 insert-only 테이블에서는 효과가 사라져요* (PostgreSQL 12 이전 insert-only 테이블의 Mandrill outage 사례). 대형 고변경 테이블에서는 `autovacuum_vacuum_scale_factor`를 *1% 수준까지 낮추는 패턴* 이 흔하고, *insert-only 테이블* 은 PostgreSQL 13+의 `autovacuum_vacuum_insert_scale_factor`로 별도 트리거 가능 — 어느 쪽이든 *워크로드에 따라 `Heap Fetches`와 autovacuum 부하를 모니터링하며 조정* 하는 게 정확합니다 (*특히 OLTP에서는 과도한 autovacuum의 IO 증가도 함께 고려*). *`EXPLAIN (ANALYZE, BUFFERS)`* 로 `Heap Fetches`와 `Buffers`를 함께 확인하면 IOS의 실제 효과를 정량화할 수 있어요. IOS 지원은 *index access method뿐 아니라 operator class에 의존* 합니다 — *B-tree* 는 일반적으로 지원, *GiST/SP-GiST* 는 *원본 값을 재구성할 수 있는 operator class* 에서만, *GIN/BRIN/Hash* 는 불가 (GIN은 인덱스 항목이 *원본 값의 일부* 만 저장해서). PostgreSQL Wiki가 *"index-mostly scan"* 이라 부르는 게 더 정확한 명칭일 정도로, *plan만 보고 IOS 효과를 단정하면 안 돼요*.

### 다음 편 예고

- **4편 — 복합 인덱스**: *좌측 컬럼 규칙(leftmost prefix)*, AND vs OR 동작 차이, 컬럼 순서 결정 전략, INCLUDE와 복합 인덱스의 차이
- **5편 — 클러스터형 인덱스와 DB별 차이**: PostgreSQL vs MySQL InnoDB vs SQL Server
- **6편 — 운영과 한계**: `CONCURRENTLY`, 장기 트랜잭션 비용, 파티셔닝/샤딩, Bloom Filter

---

### 글의 범위와 한계

이 글은 *PostgreSQL 기준*. IOS의 두 단계 조건(covering + visibility) 메커니즘은 *PostgreSQL 고유* 예요 — MySQL InnoDB는 *clustered index 구조* 라 leaf node에 *모든 컬럼이 저장* 되므로 *secondary index에서 covering이 자연스럽게 발생* 합니다 (5편에서 비교). SQL Server는 *INCLUDE 절을 PostgreSQL보다 먼저 도입(2005)* 했고 *clustered index 또는 RID로 visibility 처리* 하는 방식이라 PostgreSQL의 VM 같은 별도 메커니즘이 없어요.

또한 이번 편은 *Visibility Map 자체의 깊은 구조* 는 다루지 않았어요 — *2 bits per page (all-visible + all-frozen)*, *VM stale 시 hint bits 활용*, *VACUUM의 세 가지 역할(dead tuple 정리 + VM 갱신 + XID freezing)* 같은 내용은 [스토리지 ③편](/blog/theory/db-storage-03-hot-update-visibility-map)에서 다뤘어요. 이번 편에서는 *인덱스 측면에서 VM의 효과* 만 다뤘습니다.

INCLUDE의 *expression 미지원*, *partial index와의 조합*, *deduplication 옵션* (B-tree)도 분량상 다루지 않았어요 — PostgreSQL 공식 문서 *Section 11.9 Index-Only Scans and Covering Indexes* 와 *Section 65.1 B-Tree Indexes* 를 참고.

### 참고 (1차 자료 우선)

- [PostgreSQL Documentation — Index-Only Scans and Covering Indexes](https://www.postgresql.org/docs/current/indexes-index-only-scans.html) — IOS의 두 단계 조건 공식 가이드
- [PostgreSQL Documentation — CREATE INDEX](https://www.postgresql.org/docs/current/sql-createindex.html) — INCLUDE 절 syntax + 제한사항
- [PostgreSQL Documentation — B-Tree Indexes](https://www.postgresql.org/docs/current/btree.html) — leaf/internal node 구조, deduplication
- [PostgreSQL Documentation — Multicolumn Indexes](https://www.postgresql.org/docs/current/indexes-multicolumn.html) — 32 컬럼 한계, INCLUDE와 multicolumn 관계
- [PostgreSQL Wiki — Index-only scans](https://wiki.postgresql.org/wiki/Index-only_scans) — *"index-mostly scans"* 명명 + visibility map의 본질
- [Use The Index, Luke! — Index INCLUDE Clause](https://use-the-index-luke.com/blog/2019-04/include-columns-in-btree-indexes) — INCLUDE의 세 계층 구조 분석
- [CYBERTEC — Making the PostgreSQL visibility map visible](https://www.cybertec-postgresql.com/en/making-the-postgresql-visibility-map-visible/) — 단일 UPDATE가 VM을 깎는 실증 사례
- [Postgres Pro — Indexes in PostgreSQL: 4 (Btree)](https://postgrespro.com/blog/pgsql/4161516) — covering index와 unique 결합
- [Atlas — Indexes with Included Columns in PostgreSQL](https://atlasgo.io/guides/postgres/included-columns) — INCLUDE의 leaf-only 저장 메커니즘
- [DEV.to — ERROR: index row size 3056 exceeds btree version 4 maximum 2704](https://dev.to/yugabyte/error-index-row-size-3056-exceeds-btree-version-4-maximum-2704-for-index-4e8d) — B-tree 1/3 page 한계 실증 사례
- [CYBERTEC — PostgreSQL v13 new feature: tuning autovacuum on insert-only tables](https://www.cybertec-postgresql.com/en/postgresql-autovacuum-insert-only-tables/) — `autovacuum_vacuum_insert_scale_factor` 도입 배경
- [Crunchy Data — Insert-Only Tables and Autovacuum Issues Prior to PostgreSQL 13](https://www.crunchydata.com/blog/insert-only-tables-and-autovacuum-issues-prior-to-postgresql-13) — append-only 테이블의 VM 함정 실증 사례

---
title: '데이터베이스 인덱스 ⑤: 클러스터형 인덱스와 DBMS별 차이'
description: PostgreSQL의 heap-organized 모델과 MySQL InnoDB의 clustered index 모델은 근본적으로 다른 세계관입니다. 같은 SQL이라도 저장 구조에 따라 plan과 비용이 전혀 달라지고, secondary index 동작·PK 선택 전략·DBMS 이전 시 함정이 모두 달라집니다. PG/MySQL/SQL Server/Oracle 비교를 1차 자료 기준으로 정리.
date: 2026-04-26T00:00:00.000Z
tags:
  - Database
  - Index
  - PostgreSQL
  - MySQL
  - InnoDB
  - SQL Server
  - Oracle
  - Clustered Index
category: theory/Database
draft: false
coverImage: "/uploads/theory/db-index/cover-5.svg"
series: "데이터베이스 인덱스"
seriesOrder: 5
---

## 0. 들어가며

인덱스 시리즈 5편입니다. [1](/blog/theory/db-index-01-explain-basics)~[4편](/blog/theory/db-index-04-composite-leftmost)이 *PostgreSQL을 기준* 으로 인덱스의 구조와 활용을 다뤘다면, 이번 편은 한 단계 위로 올라가 **테이블 자체의 저장 구조** 를 다룹니다. *PostgreSQL의 heap-organized 모델* 과 *MySQL InnoDB의 clustered index 모델* 은 *근본적으로 다른 세계관* 이고, 이 차이가 *secondary index의 동작, 인덱스 설계 전략, PK 선택까지* 좌우합니다.

핵심 메시지: **테이블 데이터를 저장하는 *대표적인 두 가지 모델* 이 있습니다.** 하나는 *heap-organized*(PostgreSQL 전용, Oracle 기본, SQL Server 옵션), 다른 하나는 *index-organized*(MySQL InnoDB 강제, Oracle IOT 옵션, SQL Server 기본)입니다. 그 외에도 *column store, LSM tree* 같은 모델이 존재합니다. PostgreSQL은 *기본 구조상 모든 인덱스가 secondary로 동등하게 취급* 되며 heap에 직접 포인터를 가집니다 (단 *실제 비용은 쿼리 조건과 통계에 따라 달라짐*, [1](/blog/theory/db-index-01-explain-basics)~[3편](/blog/theory/db-index-03-covering-index-ios) 참고). InnoDB는 *개념적으로 PK B-tree가 테이블 역할* 을 하고 secondary index는 *PK 값을 포인터로 저장* 하므로 *PK 선택과 secondary index 비용이 PostgreSQL과 다르게 작동* 합니다. SQL Server는 heap/clustered 모두 지원하지만 *clustered가 일반적입니다*. **같은 SQL 코드라도 DBMS의 저장 구조에 따라 plan과 비용이 전혀 다르게 나옵니다**.

![인덱스 시리즈 5편 커버: Heap vs Index-Organized](/uploads/theory/db-index/cover-5.svg)

> **글의 범위**: 이번 편은 *테이블 저장 구조 + secondary index 동작 차이* 까지. 운영 측면(CONCURRENTLY, 장기 트랜잭션, 파티셔닝, Bloom Filter)은 다음 편에서 다룹니다.

## 1. 대표적인 두 가지 저장 구조: Heap vs Index-Organized

### Heap-Organized Table

데이터가 *정렬되지 않은 페이지* 들에 *삽입 순서대로* 저장됩니다. 인덱스는 *별도 자료구조* 이고, 각 인덱스 항목은 *heap의 행 위치* 를 가리키는 포인터(CTID, RID 등)를 들고 있습니다.

![Heap-Organized vs Index-Organized: 두 세계관](/uploads/theory/db-index/heap-vs-iot.svg)

특징:

- *INSERT는 빠름*: 다음 빈 공간에 그냥 추가
- *PK 조회도 인덱스 + heap fetch 두 단계*
- *모든 인덱스가 동등* 한 secondary index: *어떤 인덱스든 heap에 직접 포인터*
- *물리 정렬 없음*: `CLUSTER`로 일시적 정렬 가능하나 유지 안 됨 ([2편](/blog/theory/db-index-02-scan-types)/[3편](/blog/theory/db-index-03-covering-index-ios) 참고)

### Index-Organized Table (IOT) / Clustered Index

테이블 데이터가 *PK B-tree의 leaf node에 직접 저장* 됩니다. *인덱스가 곧 테이블*입니다. 별도의 heap이 없습니다.

특징:

- **PK 조회가 한 단계**: 인덱스를 따라가면 *바로 데이터에 도달*
- **PK 순서로 물리 정렬 유지**: range 쿼리에 유리
- *INSERT는 더 비쌈*: PK B-tree의 *적절한 위치 찾기 + 페이지 분할 가능성*
- *secondary index는 두 단계 lookup*: secondary 인덱스 → PK 값 → PK B-tree

> **1장 요약**: Heap은 *데이터 + 인덱스 분리*, IOT는 *인덱스가 곧 데이터*. 두 구조는 *INSERT 비용, 조회 단계 수, 정렬 유지, secondary index 동작* 이 모두 다릅니다.

## 2. DBMS별 저장 구조: 한눈에

PostgreSQL 18 / MySQL 8 / SQL Server / Oracle 기준:

![DBMS별 저장 구조 한눈에](/uploads/theory/db-index/dbms-storage-matrix.svg)

| DBMS | 기본 구조 | 다른 옵션 | PK가 정렬 결정 | Secondary Index 포인터 |
|---|---|---|---|---|
| **PostgreSQL** | Heap (변경 불가) | 없음 | 아니오 (CLUSTER 일시적) | CTID (heap 직접) |
| **MySQL InnoDB** | Clustered (강제) | 없음 | 예 | PK 값 |
| **MySQL MyISAM** | Heap | 없음 | 아니오 | RID |
| **SQL Server** | Clustered (PK 자동) | Heap (PK 없거나 명시) | 옵션 (clustered인 경우 예) | PK 또는 RID |
| **Oracle** | Heap (기본) | IOT (`ORGANIZATION INDEX`) | 옵션 (IOT는 예) | ROWID 또는 PK |

핵심 인사이트:

- **PostgreSQL은 *선택권 없음***: heap 전용. clustered index가 *언어 차원에서 존재하지 않습니다*
- **MySQL InnoDB도 *선택권 없음***: 모든 테이블이 clustered. PK 없으면 *내부적으로 자동 생성* (hidden 6-byte clustered key)
- **SQL Server는 *암묵적으로 clustered***: PK 만들면 자동으로 clustered가 됨 (변경 가능)
- **Oracle은 *유일하게 명시적 선택***: `ORGANIZATION INDEX`로 IOT 지정

> **2장 요약**: DBMS마다 *기본 + 선택 가능 여부* 가 달라집니다. PostgreSQL은 heap 전용, InnoDB는 clustered 강제, SQL Server는 둘 다 가능, Oracle은 가장 유연.

## 3. PostgreSQL: 모든 인덱스가 평등한 세계

### 구조

PostgreSQL의 모든 테이블은 *heap*. PK도 *그냥 secondary index 중 하나에 unique constraint이 붙은 것* 에 불과합니다. *PK가 특별하지 않습니다*.

```sql
CREATE TABLE users (
    id BIGINT PRIMARY KEY,
    email TEXT UNIQUE,
    name TEXT
);
```

이 테이블에는 *세 개의 자료구조* 가 만들어집니다:

1. **users heap**: 실제 데이터 페이지
2. **users_pkey** (B-tree on id): secondary index, heap CTID 포인터
3. **users_email_key** (B-tree on email): secondary index, heap CTID 포인터

`SELECT * FROM users WHERE id = 100`과 `SELECT * FROM users WHERE email = 'x'`는 *기본 구조상 같은 비용 패턴* (각 인덱스 → heap fetch)을 따릅니다. 다만 *실제 비용은 통계, IOS 가능 여부, correlation, partial/expression index 같은 요소* 에 따라 달라질 수 있습니다.

### Secondary Index의 동작

```
1. id 인덱스에서 100 검색 → CTID = (page=42, offset=3)
2. heap의 page 42, offset 3에서 row 읽기
```

*두 단계* 는 동일하지만 *heap 접근이 random IO* 가 될 수 있습니다 ([3편 IOS 조건](/blog/theory/db-index-03-covering-index-ios) 참고).

### 함의

- **PK 선택이 *인덱스 비용에만 영향*, 데이터 정렬에는 영향 없음**: UUID PK도 heap에 그냥 들어가므로 *InnoDB 대비 부담은 훨씬 적습니다*. 다만 *인덱스 크기 증가, cache locality 저하, bloat 영향* 은 여전히 존재 (UUIDv7 같은 시간 정렬 UUID면 cache locality 일부 회복 가능)
- **기본 구조상 모든 인덱스가 동등**: *어떤 인덱스로 검색하든 같은 lookup 패턴*. 다만 *실제 비용은 쿼리 조건/통계/IOS 가능 여부에 따라 달라집니다*
- **CLUSTER 명령으로 *일시적* 정렬 가능**: 다만 *유지되지 않음* ([2편](/blog/theory/db-index-02-scan-types)/[3편](/blog/theory/db-index-03-covering-index-ios) cross-reference)

> **3장 요약**: PostgreSQL에서는 *모든 인덱스가 secondary*, *PK 특별 대우 없음*. *기본 구조상 모든 인덱스가 동등하게 취급* 되지만 *실제 비용은 쿼리 조건/통계/IOS 가능 여부에 따라 달라집니다*.

## 4. MySQL InnoDB: PK가 곧 테이블

### 구조

InnoDB의 모든 테이블은 *clustered index 형태*. *개념적으로 PK B-tree가 테이블 역할을 하며, 실제 데이터는 leaf에 저장* 됩니다 (실제로는 *row format / overflow page / compression* 같은 내부 메커니즘이 추가로 작동).

```sql
-- MySQL
CREATE TABLE users (
    id BIGINT PRIMARY KEY,
    email VARCHAR(255) UNIQUE,
    name VARCHAR(100)
) ENGINE=InnoDB;
```

이 테이블의 자료구조:

1. **users PK B-tree (= 테이블)**: id 정렬, leaf에 (id, email, name) 모두 저장
2. **email secondary index**: email 정렬, *leaf에 PK 값(id)* 만 저장 (CTID 같은 heap 포인터 없음)

### PK 조회는 한 단계

```sql
SELECT * FROM users WHERE id = 100;
```

PK B-tree를 따라가면 *바로 (100, email, name) 도달*. 한 번의 B-tree 탐색으로 끝.

### Secondary Index 조회는 두 단계: 그러나 PostgreSQL과 다름

```sql
SELECT * FROM users WHERE email = 'x';
```

```
1. email 인덱스에서 'x' 검색 → PK 값 (예: 100) 획득
2. PK B-tree에서 100 검색 → 모든 컬럼 획득
```

![Secondary Index 조회: 2단계는 같지만 본질이 다르다](/uploads/theory/db-index/secondary-lookup-paths.svg)

**PostgreSQL과 결정적 차이**: 1단계 결과가 *heap 포인터(CTID)* 가 아니라 *PK 값*입니다. 2단계에서 *다시 PK B-tree를 탐색* 해야 합니다. *PostgreSQL의 random heap fetch와 비용 구조가 다릅니다*.

### 함의 1: PK 선택이 결정적으로 중요

InnoDB에서 PK는 *모든 secondary index에 복제* 됩니다:

```
secondary_idx_email = [(email, PK)]
secondary_idx_name = [(name, PK)]
secondary_idx_x = [(x, PK)]
```

*PK가 크면 모든 secondary index가 비대화*. 그래서:

- **자연 PK 대신 작은 surrogate PK** 권장 (보통 INT/BIGINT)
- **UUID PK는 InnoDB의 안티패턴**: 16바이트 UUID가 *모든 secondary index 항목에 복사* + *random insert로 페이지 분할 폭증*

이게 InnoDB 환경에서 *"UUID 쓰지 말고 BIGINT auto_increment 쓰라"* 는 정석 가이드의 근원입니다.

### 함의 2: Covering Index의 자연스러운 발생

InnoDB에서 *secondary index* 는 *(secondary_col, PK)* 를 들고 있습니다. 즉:

```sql
SELECT id FROM users WHERE email = 'x';
```

이 쿼리는 **email 인덱스만으로 답이 끝납니다.** id가 *이미 인덱스 항목* 에 있기 때문입니다. PostgreSQL의 `INCLUDE` 절 효과가 *자동으로 발생* 하는 셈입니다.

다만 *id 외의 컬럼 (예: name)* 은 여전히 *PK B-tree로 가야* 합니다 (`SELECT name FROM users WHERE email='x'` → secondary → PK B-tree → name).

### 함의 3: PK 순서로 물리 정렬

`ORDER BY id`는 *추가 sort 없이 물리 순서*. range 쿼리(`WHERE id BETWEEN 100 AND 200`)도 *연속된 페이지에서 sequential read* 로 처리.

> **4장 요약**: InnoDB는 *PK가 곧 테이블*. Secondary index는 *PK를 포인터로* 저장하므로 *PK 선택이 모든 secondary index 크기에 영향*. UUID PK 안티패턴, *작은 surrogate PK + auto_increment* 가 정석.

## 5. SQL Server: 두 모드 모두 지원

### 기본은 Clustered

SQL Server에서 `PRIMARY KEY` 제약을 만들면 *자동으로 clustered index* 가 생성됩니다 (이미 다른 clustered가 없으면). 즉 *암묵적 default가 InnoDB와 같은 구조*.

```sql
CREATE TABLE users (
    id BIGINT PRIMARY KEY,  -- 자동으로 clustered
    email NVARCHAR(255) UNIQUE,
    name NVARCHAR(100)
);
```

### 그러나 명시적으로 Heap 선택 가능

```sql
CREATE TABLE staging_data (
    id BIGINT,  -- PK 없음 → heap
    payload TEXT
);
```

PK가 없으면 SQL Server는 *heap*. 또는 *PK를 nonclustered로* 강제 가능:

```sql
ALTER TABLE staging_data
ADD CONSTRAINT pk_staging PRIMARY KEY NONCLUSTERED (id);
-- → heap + nonclustered PK index
```

### Heap의 Row Locator: RID

SQL Server의 heap에서 행 위치는 **RID(Row Identifier)** 입니다. *8 bytes, FileID:PageID:SlotID 형태*. Microsoft Learn 직접 인용:

> *"For a heap, a row locator is a pointer to the row. For a clustered table, the row locator is the clustered index key."*

즉:

- **Heap + nonclustered index**: nonclustered → RID → heap row (*RID Lookup*)
- **Clustered + nonclustered index**: nonclustered → PK → clustered B-tree (*Key Lookup*)

EXPLAIN(SQL Server는 *Execution Plan*)에서 *RID Lookup* 과 *Key Lookup* 이 명확히 구분되어 표시됩니다.

### Heap이 적합한 경우

Microsoft Learn 가이드:

- *Staging 테이블 (대량 unordered insert)*
- *작은 테이블*
- *항상 nonclustered index로만 접근*

**Heap이 부적합**:

- 큰 테이블 + 잦은 검색
- range 쿼리
- 잦은 UPDATE (heap의 forwarded record 문제: 페이지 안 들어가는 update가 *다른 페이지로 옮겨가고 forwarding pointer* 를 남김 → 단편화)

### SQL Server의 Nonclustered with INCLUDE

PostgreSQL 11보다 훨씬 일찍(2005) `INCLUDE` 절 도입. 동작은 동일: *leaf에만 추가 컬럼*. PostgreSQL의 INCLUDE 설계는 SQL Server에서 차용된 측면이 큽니다 ([3편](/blog/theory/db-index-03-covering-index-ios) 참고).

> **5장 요약**: SQL Server는 *clustered가 default* 지만 *heap도 명시적으로 선택 가능*. RID Lookup vs Key Lookup이 *Execution Plan에서 구분되어 표시*. INCLUDE 절은 PostgreSQL보다 먼저 도입.

## 6. Oracle: 가장 유연한 선택

### 기본은 Heap, IOT는 옵션

```sql
-- Heap (default)
CREATE TABLE users (
    id NUMBER PRIMARY KEY,
    email VARCHAR2(255),
    name VARCHAR2(100)
);

-- IOT (명시적)
CREATE TABLE users_iot (
    id NUMBER PRIMARY KEY,
    email VARCHAR2(255),
    name VARCHAR2(100)
) ORGANIZATION INDEX;
```

### Oracle Heap의 Row Locator: ROWID

Oracle heap의 *ROWID* 는 *데이터블록주소(DBA) + 행 슬롯*. PostgreSQL의 CTID, SQL Server의 RID와 같은 역할.

### Oracle IOT의 특이점: Overflow Segment

IOT에서 *큰 컬럼* 은 PK B-tree에 두지 않고 *별도 overflow segment* 로 보낼 수 있습니다(`OVERFLOW` 절). 이 메커니즘이 IOT의 *단점(B-tree 비대화)* 을 완화합니다.

PostgreSQL의 *TOAST* 가 *큰 컬럼을 별도 저장* 하는 것과 비슷한 발상이지만, *IOT의 overflow는 PK 인덱스 자체의 leaf node 크기 제어용* 이라 목적이 다릅니다.

### 함의

- **OLTP에서 IOT는 PK 조회 빈번한 경우 유리**: PK lookup 한 단계
- **분석 워크로드에는 heap**: 범위 스캔, 큰 secondary index가 유리
- **Oracle에서 IOT는 흔하지 않음**: *기본 heap이 default* 고 *DBA가 명시적으로 IOT 선택* 해야 함

> **6장 요약**: Oracle은 *heap default + IOT 옵션* 으로 가장 유연. IOT는 *overflow segment* 로 단점을 완화하지만, *기본 선택은 여전히 heap*.

## 7. Secondary Index 동작: DBMS별 비교

같은 쿼리, 다른 동작:

```sql
SELECT name FROM users WHERE email = 'x';
```

| DBMS | 동작 | 단계 수 |
|---|---|---|
| **PostgreSQL** | email B-tree → CTID → heap (page에서 name 읽음) | 2 (인덱스 + heap fetch) |
| **MySQL InnoDB** | email B-tree → PK 값 → PK B-tree (leaf에서 name 읽음) | 2 (인덱스 + clustered lookup) |
| **SQL Server (clustered)** | email B-tree → PK → clustered B-tree (Key Lookup) | 2 (인덱스 + clustered lookup) |
| **SQL Server (heap)** | email B-tree → RID → heap (RID Lookup) | 2 (인덱스 + heap fetch) |
| **Oracle (heap)** | email B-tree → ROWID → heap | 2 (인덱스 + heap fetch) |
| **Oracle (IOT)** | email B-tree → PK 값 → IOT B-tree | 2 (인덱스 + IOT lookup) |

겉보기엔 모두 2단계지만 *2단계의 비용 구조가 달라집니다*:

- **Heap fetch (PostgreSQL/SQL Server heap/Oracle heap)**: random IO 가능성, *VM/visibility 메커니즘*
- **Clustered/IOT lookup (InnoDB/SQL Server clustered/Oracle IOT)**: *PK B-tree 탐색*, *일반적으로 cache locality가 좋아 random IO가 줄어드는 경향* 이지만, *PK 분포가 random* 하거나 *cache 상태가 좋지 않으면* random IO가 여전히 발생 가능

> 두 방식 모두 *cache hit 여부* 가 실제 비용을 크게 좌우합니다. buffer pool에 PK B-tree 또는 heap page가 상주하면 메모리 접근으로 끝나고, 그렇지 않으면 디스크 IO가 발생합니다.

### 같은 쿼리, 다른 PK 선택의 영향

```sql
-- 큰 테이블에 매우 많은 secondary index가 있는 경우
SELECT * FROM users WHERE email = 'x';
```

- **PostgreSQL**: PK 크기 영향 *적음* (CTID 6 bytes 고정): *모든 secondary index에 PK 복사 안 됨*
- **InnoDB**: PK 크기 영향 *결정적*: 모든 secondary index 항목에 PK 복사

이게 **InnoDB에서 surrogate PK가 필수에 가까운 이유**.

> **7장 요약**: *2단계 lookup* 은 모든 DBMS 공통이지만 *2단계의 본질이 다름* (heap fetch vs clustered lookup). PK 크기 영향도 *DBMS 따라 결정적으로 갈림*.

## 8. 실전: DBMS 이전 시 흔한 함정

![DBMS 이전 시 흔한 함정](/uploads/theory/db-index/migration-pitfalls.svg)

### 함정 1 (MySQL → PostgreSQL): UUID PK 그대로 들고 옴

InnoDB에서 *UUID PK는 안티패턴* 이지만, PostgreSQL로 옮기면 *부담이 훨씬 줄어듭니다*. heap이라 *모든 인덱스가 동등하게 취급* 되고, UUID의 영향은 *PK 인덱스 자체* 에만 국한됩니다.

다만 *생활 습관처럼* InnoDB 권고("BIGINT auto_increment")를 PostgreSQL에 그대로 적용하는 경우가 많습니다. *PostgreSQL에서는 UUID PK가 InnoDB만큼 치명적이지는 않지만*, *인덱스 크기와 cache locality 측면에서는 여전히 영향* 이 있습니다. *UUIDv7 같은 시간 정렬 UUID* 가 절충안입니다.

### 함정 2 (PostgreSQL → MySQL): secondary index 전략 그대로

PostgreSQL에서 *많은 secondary index를 자유롭게* 만들던 패턴을 InnoDB에 그대로 적용 → *PK가 모든 secondary index에 복사* 되어 *공간 사용량 폭증*.

### 함정 3 (SQL Server): clustered index 변경 비용 간과

SQL Server에서 clustered index를 *변경* 하면 *모든 nonclustered index를 재구축* 해야 합니다 (Microsoft Learn 직접 명시). 큰 테이블에서는 *시간 + 공간 부담* 이 결정적.

### 함정 4 (Oracle IOT): 잘못된 컬럼 순서

IOT의 PK는 *물리 정렬 키* 이자 *secondary index의 포인터*. 잘못 선택하면 InnoDB 안티패턴이 그대로 재현됩니다.

### 함정 5: Plan 모양만 보고 비교

같은 EXPLAIN에 *Index Scan + Heap Fetch* 가 나와도 *PostgreSQL의 heap fetch* 와 *InnoDB의 clustered lookup* 은 비용 구조가 달라집니다. *DBMS별 plan 노드의 의미* 를 정확히 이해해야 진짜 비교 가능.

> **8장 요약**: DBMS 이전 시 *PK 선택 / secondary index 전략 / clustered 변경 비용* 이 흔한 함정. 같은 SQL 코드도 *저장 구조에 따라 비용이 전혀 달라집니다*.

## 9. 정리

### 핵심 통찰

- **대표적인 두 가지 모델**: *Heap-organized*(PostgreSQL 전용, Oracle 기본, SQL Server 옵션)와 *Index-organized*(InnoDB 강제, Oracle IOT 옵션, SQL Server 기본). 그 외 column store, LSM tree 같은 다른 모델도 존재.
- **PostgreSQL은 *선택권 없음 + 기본 구조상 모든 인덱스 동등***: PK도 그냥 *unique constraint이 붙은 인덱스*. UUID PK는 InnoDB 대비 부담 훨씬 적지만 *인덱스 크기/cache locality 영향은 여전*.
- **InnoDB는 *PK가 곧 테이블***: secondary index가 *PK 값을 포인터로* 저장 → *PK 크기가 모든 secondary index에 복제됨* → *작은 surrogate PK가 정석*.
- **SQL Server는 *clustered가 default지만 heap 선택 가능***: RID Lookup vs Key Lookup이 *Execution Plan에서 구분되어 표시*.
- **Oracle은 *heap default + IOT 명시 선택***: *overflow segment* 로 IOT의 단점 완화.
- **Secondary Index 2단계 lookup은 공통** 이지만 *2단계의 본질이 다르다*: heap fetch(random IO) vs clustered lookup(B-tree 탐색).
- **DBMS 이전 시 함정**: PK 선택 전략, secondary index 전략, clustered 변경 비용은 *DBMS별로 정반대 권고* 가 나올 수 있음.

### 진짜 한 줄

> **같은 SQL 코드라도 DBMS의 저장 구조에 따라 plan, 비용, 인덱스 설계 전략이 모두 달라집니다.** PostgreSQL의 heap-only는 *유연성*, InnoDB의 clustered는 *PK 조회 효율*, SQL Server는 *둘 다*, Oracle은 *가장 명시적인 선택*.

### 통합된 답: 한 단락 정리

데이터베이스의 테이블 저장 구조는 *대표적으로* *heap-organized* 와 *index-organized(clustered)* 두 모델로 나뉩니다 (그 외 column store, LSM tree 같은 모델도 존재). heap은 *데이터를 정렬되지 않은 페이지에 저장하고 인덱스는 별도 자료구조* 인 모델, IOT는 *개념적으로 PK B-tree가 테이블 역할* 을 하며 *실제 데이터가 leaf에 저장* 되는 모델입니다. **PostgreSQL은 heap 전용** 이라 *모든 인덱스가 secondary* 고 PK도 *unique constraint이 붙은 인덱스* 에 불과합니다 (CLUSTER 명령은 일시적 정렬). 기본 구조상 *모든 인덱스가 동등하게 취급* 되지만, *실제 비용은 쿼리 조건/통계/IOS 가능 여부에 따라 달라집니다*. **MySQL InnoDB는 clustered 강제** 라 *PK B-tree가 테이블 역할* 을 하고 secondary index는 *PK 값을 포인터로 저장* 해 *PK 크기가 모든 secondary index에 복제* 됩니다. 이게 *작은 surrogate PK + auto_increment* 가 정석인 이유이자 UUID PK가 안티패턴인 이유입니다 (PostgreSQL에서는 *부담이 훨씬 적지만* 인덱스 크기/cache locality 영향은 여전하며, UUIDv7 같은 시간 정렬 UUID가 절충안). **SQL Server는 clustered가 default지만 heap도 명시적으로 선택 가능**합니다. `PRIMARY KEY` 만들면 자동으로 clustered, heap에서는 *RID(8 bytes) Lookup*, clustered에서는 *Key Lookup* 이 Execution Plan에 구분되어 표시됩니다. **Oracle은 heap default + IOT 명시 선택** 이 가장 유연하고, IOT의 *overflow segment* 로 B-tree 비대화 단점을 완화합니다. *Secondary index의 2단계 lookup* 은 모든 DBMS 공통이지만 *2단계의 본질이 다릅니다*. heap fetch(random IO 가능성, visibility map 의존)와 clustered lookup(PK B-tree 탐색, *cache locality가 좋아 random IO가 줄어드는 경향* 이지만 PK 분포/cache 상태에 따라 달라짐)은 비용 구조가 달라집니다. *두 방식 모두 cache hit 여부가 실제 비용을 크게 좌우*. 같은 EXPLAIN/Execution Plan을 봐도 DBMS별로 의미가 다르고, *PK 선택 전략, secondary index 비용, clustered 변경 비용* 이 DBMS별로 정반대 권고가 나올 수 있습니다. *DBMS 이전 시 인덱스 전략을 그대로 옮기면 큰 함정* 에 빠집니다. 결국 *인덱스 설계는 DBMS의 저장 구조 이해에서 출발* 합니다.

---

### 글의 범위와 한계

이 글은 *PostgreSQL/MySQL InnoDB/SQL Server/Oracle* 의 일반적인 표준 저장 구조 비교. 각 DBMS의 *세부 옵션* 까지 모두 다루지는 않았습니다. 예를 들어 PostgreSQL의 *zheap* 같은 실험적 storage engine, MySQL InnoDB의 *page compression / row format(REDUNDANT/COMPACT/DYNAMIC/COMPRESSED)*, SQL Server의 *columnstore index*, Oracle의 *hash cluster / sorted hash cluster* 등은 분량상 제외했습니다.

또한 각 DBMS의 *최신 버전 신규 기능* (예: PostgreSQL 18 skip scan, MySQL 8.0 invisible index, SQL Server 2022 ledger table 등)도 4편 또는 후속 편에서 부분적으로만 다룹니다. 정확한 동작은 *해당 DBMS의 최신 버전 공식 문서* 가 진짜 출처입니다.

특히 **MyISAM** 은 MySQL legacy 엔진이라 *현대 MySQL 환경에서는 거의 InnoDB 사용* 이 일반적입니다. 이 글의 *MySQL 비교* 는 InnoDB 기준입니다.

### 참고 (1차 자료 우선)

- [PostgreSQL Documentation — Database Physical Storage](https://www.postgresql.org/docs/current/storage.html): heap 페이지 구조, CTID
- [PostgreSQL Documentation — CLUSTER](https://www.postgresql.org/docs/current/sql-cluster.html): 일시적 정렬 명령
- [MySQL Reference Manual — Clustered and Secondary Indexes](https://dev.mysql.com/doc/refman/8.0/en/innodb-index-types.html): InnoDB의 clustered/secondary 구조 공식
- [Microsoft Learn — Clustered and Nonclustered Indexes Described](https://learn.microsoft.com/en-us/sql/relational-databases/indexes/clustered-and-nonclustered-indexes-described): clustered/nonclustered/heap row locator
- [Microsoft Learn — Heaps (Tables without clustered indexes)](https://learn.microsoft.com/en-us/sql/relational-databases/indexes/heaps-tables-without-clustered-indexes): heap 구조, RID, forwarded records
- [Oracle Documentation — Index-Organized Tables](https://docs.oracle.com/en/database/oracle/oracle-database/19/cncpt/indexes-and-index-organized-tables.html): IOT, ORGANIZATION INDEX, overflow
- [Use The Index, Luke! — Clustered indexes are index-organized tables](https://use-the-index-luke.com/sql/clustering/index-organized-clustered-index): 4 DBMS 비교 정리
- [Severalnines — PostgreSQL Index vs InnoDB Index](https://severalnines.com/blog/postgresql-index-vs-innodb-index-understanding-differences/): secondary index 동작 차이 deep dive
- [Redrock Postgres — Heap Tables vs. Index-Organized Tables](https://www.rockdata.net/blog/heap-table-vs-index-organized-table/): 4 DBMS의 default 정리

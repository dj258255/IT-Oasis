---
title: 'DB 스토리지 내부 ②: Row Store vs Column Store'
description: 같은 데이터를 디스크에 어떻게 배치할 것인가. row store는 같이 읽는 데이터를 같이, column store는 같이 계산하는 데이터를 같이 배치합니다. PostgreSQL/MySQL이 row인 이유, ClickHouse/Parquet/Snowflake가 column인 이유, 그리고 hybrid/HTAP까지 정리합니다.
date: 2026-04-20T00:00:00.000Z
tags:
  - Database
  - Storage
  - Row Store
  - Column Store
  - OLAP
  - OLTP
  - HTAP
  - ClickHouse
  - Parquet
category: theory/Database
draft: false
coverImage: "/uploads/theory/db-storage/cover-2.svg"
series: "DB 스토리지 내부"
seriesOrder: 2
---

## 0. 들어가며

스토리지 시리즈 2편입니다. [1편](/blog/theory/db-storage-01-heap-page-index)에서 페이지·힙·인덱스·B+Tree를 다뤘다면, 이번 편은 한 단계 위 질문을 다룹니다. *"같은 데이터를 디스크에 어떻게 배치할 것인가?"*

핵심을 한 줄로 압축하면: **Row store는 같이 읽는 데이터를 같이 배치하고, column store는 같이 계산하는 데이터를 같이 배치한다.** 같은 데이터의 다른 배치일 뿐이고, 어느 쪽이 우월한 것은 아니며 어떤 쿼리를 자주 던지느냐가 둘 중 하나를 선택하게 만듭니다. PostgreSQL/MySQL이 row store인 이유, ClickHouse·Parquet·Snowflake가 column store인 이유, 그리고 둘 다 한 시스템에 담으려는 hybrid 접근(TimescaleDB, Spanner Columnar Engine)까지 모두 이 트레이드오프 위에서 설명됩니다.

![Row Store vs Column Store 시리즈 커버](/uploads/theory/db-storage/cover-2.svg)

## 1. 왜 두 가지 방식이 존재하는가

데이터베이스에 던지는 쿼리는 크게 두 종류로 나뉩니다.

![OLTP vs OLAP: 접근 패턴이 저장 방식을 결정한다](/uploads/theory/db-storage/oltp-vs-olap.svg)

### OLTP (Online Transaction Processing): 점-쿼리 + 짧은 트랜잭션

```sql
SELECT * FROM users WHERE id = 12345;
UPDATE accounts SET balance = balance - 100 WHERE id = 7;
INSERT INTO orders (...) VALUES (...);
```

특징: 한 번에 몇 개 행에 여러 컬럼을 읽고 씀. 응답 시간 ms 단위. 동시성 높음. 정확성 필수([ACID](/blog/theory/transaction-acid-01-atomicity)).

### OLAP (Online Analytical Processing): 집계 + 광범위 스캔

```sql
SELECT region, SUM(revenue) FROM sales WHERE date >= '2024-01-01' GROUP BY region;
SELECT product_id, AVG(price) FROM transactions GROUP BY product_id;
```

특징: 한 번에 수백만~수십억 행에 몇 개 컬럼만 봄. 응답 시간 초~분 단위 허용. 동시성 낮음. 보통 읽기 전용에 가까움.

이 두 워크로드는 완전히 다른 접근 패턴을 가집니다. OLTP는 **행 단위로 좁게**, OLAP는 **컬럼 단위로 넓게**. 이 패턴 차이가 *디스크에 데이터를 어떻게 배치할 것인가*를 결정합니다.

> **1장 요약**: OLTP는 몇 행 × 많은 컬럼, OLAP는 많은 행 × 몇 컬럼. 접근 패턴이 다르므로 최적 저장 방식도 달라집니다.

## 2. Row Store: 행 단위로 모은다

> **Row Store**: 한 행의 모든 컬럼이 디스크 상에서 연속된 위치에 함께 저장됨. PostgreSQL, MySQL, Oracle 등 대부분의 전통 RDBMS가 이 방식.

### 디스크 배치

![Row Store 디스크 배치: 한 페이지에 여러 행이 함께](/uploads/theory/db-storage/row-store-pages.svg)

한 행의 모든 필드가 물리적으로 인접합니다. 이것이 1편의 단순한 모델이고, 우리가 페이지·힙·인덱스를 이야기할 때 암묵적으로 가정한 배치입니다.

### Row Store의 강점

- **한 행 lookup이 빠름**: `WHERE id = ?`로 한 행 찾으면 모든 컬럼이 그 페이지에 함께 있습니다. IO 한 번이면 행 전체 확보.
- **INSERT/UPDATE 변경 단위가 행 중심**: 새 행은 free space가 있는 페이지(PostgreSQL은 FSM 기반 탐색)나 clustered index 위치(InnoDB는 PK 순서)에 배치됩니다. UPDATE는 논리적으로 한 행 변경이지만, MVCC 구현에서는 새 row version 생성 + 인덱스 갱신이 동반될 수 있습니다(PostgreSQL의 HOT update가 가능하면 인덱스 갱신을 회피하는 최적화). 핵심은 변경 단위가 행 중심이라는 점이고, 이게 OLTP 트랜잭션 처리·WAL·MVCC와 자연스럽게 맞물립니다.
- **트랜잭션 자연스러움**: ACID 보장이 행 단위 락·MVCC와 잘 맞물립니다.

### Row Store의 약점

- **집계 쿼리가 비효율적**: `SELECT SUM(salary) FROM employees`를 실행하면, salary만 필요한데 모든 컬럼이 든 페이지를 다 읽어야 함. 페이지의 80% 이상이 불필요한 데이터.
- **압축 효율 낮음**: 한 행 안에는 서로 다른 타입의 값들(int + string + date + ...)이 섞여있어 압축 알고리즘이 패턴을 못 찾음.
- **컬럼 수 많은 wide table에 약함**: 100개 컬럼 중 3개만 쿼리해도 모든 100개 컬럼 데이터를 디스크에서 끌어오게 됨.

> **2장 요약**: Row store는 한 행의 컬럼들을 연속 배치합니다. 점-쿼리와 트랜잭션에 자연스럽지만, 집계 쿼리에서는 불필요한 컬럼까지 IO해야 해서 비효율적입니다.

## 3. Column Store: 컬럼 단위로 모은다

> **Column Store** (= Columnar Storage): 같은 컬럼의 값들이 디스크 상에서 연속된 위치에 함께 저장됨. ClickHouse, Apache Parquet, ORC, DuckDB, Amazon Redshift, Snowflake, Google BigQuery 등이 이 방식.

### 디스크 배치

같은 직원 데이터를 column store로 저장하면:

![Column Store 디스크 배치: 컬럼별 별도 영역](/uploads/theory/db-storage/column-store-areas.svg)

각 컬럼이 별도의 영역(보통 별도 파일 또는 별도 페이지 묶음)에 저장됩니다. 같은 행의 데이터를 모으려면 각 컬럼의 같은 위치에서 가져와 조립해야 합니다.

이래서 **컬럼들은 같은 row group/segment 안에서 position(위치)을 공유합니다.** 같은 위치의 값들을 조합해 논리적 행을 재구성합니다. 즉 모든 값마다 명시적 row ID가 붙는 것은 아니지만, **위치 정렬이 행 매칭의 기준**이 됩니다. ClickHouse도 각 컬럼 값을 순차 저장하고, 같은 인덱스 위치의 값들을 묶어 행을 만듭니다.

### 같은 데이터, 다른 배치

![같은 데이터, 다른 디스크 배치: Row Store vs Column Store](/uploads/theory/db-storage/row-vs-column-layout.svg)

근본적으로 같은 데이터입니다. 단지 **어느 차원으로 먼저 자르느냐**가 다를 뿐입니다:

| 측면 | Row Store | Column Store |
|---|---|---|
| 연속 저장 단위 | 한 행의 모든 컬럼 | 한 컬럼의 모든 값 |
| 자연스러운 접근 패턴 | "이 행 전체 줘" | "이 컬럼만 다 줘" |
| `SELECT *` 비용 | 저렴 (페이지 한 번) | 비쌈 (컬럼 수만큼 다른 영역 접근) |
| `SELECT SUM(salary)` 비용 | 비쌈 (모든 컬럼 페이지 IO) | 저렴 (salary 영역만 스캔) |
| 압축 효율 | 낮음 (혼합 타입) | 높음 (같은 타입·유사 값) |

> **3장 요약**: Column store는 같은 컬럼의 값들을 연속 배치합니다. 행을 재구성하려면 여러 영역을 합쳐야 하지만, 컬럼 단위 스캔은 자연스럽고 빠릅니다.

## 4. 3가지 쿼리로 비교: 인덱스 없는 풀 스캔 기준

인덱스를 의도적으로 빼고 *순수한 저장 구조 차이*만 봅니다. 100만 행, 10개 컬럼 직원 테이블 가정.

### 쿼리 A: 점-쿼리, `WHERE ssn = '666'`의 `name`

**Row store**:
1. 모든 페이지를 순차 스캔 (각 페이지에 여러 행, 모든 컬럼 포함).
2. 각 행의 ssn 비교, 일치하면 같은 행의 name 추출.
3. 한 페이지 IO로 행 전체가 메모리에 있으므로 name 추출은 추가 IO 없음.

비용: 전체 페이지 수만큼 IO. 하지만 한 번 행을 찾으면 다른 컬럼도 거의 공짜.

**Column store**:
1. ssn 컬럼 영역만 스캔 → '666'의 위치(예: 행 ID 1006) 찾음.
2. 그 위치를 갖고 name 컬럼 영역으로 점프 → 1006번째 값 추출.

비용: ssn 영역의 IO + name 영역의 1번 IO. ssn 영역이 row store의 전체 페이지보다 훨씬 작으므로 유리. 하지만 행 ID 매칭으로 컬럼 영역 간 점프가 필요.

**승자 (인덱스 없는 풀 스캔 기준)**: 컬럼 수를 줄이는 효과 덕분에 column store가 유리해 보일 수 있습니다. 다만 **점-쿼리는 column store의 주력 패턴이 아닙니다.** row group metadata, zone map, encoding/compression, random access 비용, 데이터 정렬 여부에 따라 실제 성능은 크게 달라집니다. 실전 OLTP에서는 row store + index가 일반적으로 훨씬 적합하고, 이 비교는 어디까지나 *순수 저장 구조 차이만 보기 위한 통제 실험*입니다.

### 쿼리 B: `SELECT * FROM employees WHERE id = 1`

**Row store**:
1. id 위치 찾으면 (인덱스 또는 스캔으로) → 그 페이지에 모든 컬럼이 함께 있음.
2. 한 페이지 IO로 답.

비용: 페이지 1개 IO. 매우 저렴.

**Column store**:
1. id 영역 스캔 → 행 ID 1001 위치 찾음.
2. 각 컬럼 영역(또는 column chunk)에서 같은 위치의 값을 가져옴 → 10개 컬럼이면 10개 영역에 대한 별도 접근.
3. 메모리에서 행 재구성.

비용: 컬럼 수만큼의 분산된 영역 접근. row store처럼 한 페이지로 끝나지 않고 접근이 분산됩니다(다만 vectorized read와 prefetch가 부분 완화). 단일 행 lookup에서는 row store가 압승.

**승자**: 압도적으로 row store. `SELECT *`처럼 많은 컬럼을 행 단위로 재구성해야 하는 쿼리는 column store의 장점이 크게 줄어드는 패턴.

### 쿼리 C: `SELECT SUM(salary) FROM employees`

**Row store**:
1. 모든 페이지를 순차 스캔.
2. 각 페이지에서 salary 컬럼만 추출, 다른 컬럼은 버림.
3. 합산.

비용: 전체 페이지 IO. 페이지의 80~90%가 불필요한 컬럼 데이터.

**Column store**:
1. salary 영역만 스캔.
2. 연속된 숫자들을 일괄 합산.

비용: salary 영역의 IO만. 압축까지 적용되면 *전체 데이터의 5~10%*만 디스크에서 읽으면 됨 (5~10× 압축이 일반적).

**승자**: 압도적으로 column store. 집계 쿼리는 column store가 빛을 발하는 영역.

> **4장 요약**: 인덱스 없는 풀 스캔 기준으로 점-쿼리는 column store가 *읽는 데이터 양*에서는 유리하지만 주력 패턴 아님(실전 OLTP는 row store + index가 적합), `SELECT *` 류는 row store 압승, 집계는 column store 압승. **어느 쿼리가 자주 던져지느냐가 선택의 기준입니다.**

## 5. Column Store가 빠른 진짜 이유: 압축 + Vectorized Execution

*"더 적은 IO"* 외에도, 현대 column store의 진짜 강점은 **CPU 효율**에 있습니다.

![Column Store가 빠른 진짜 이유: 4가지 메커니즘의 결합](/uploads/theory/db-storage/columnar-engine-stack.svg)

### 압축 (Compression)

같은 컬럼의 값들은 같은 타입 + 유사한 분포를 가집니다. 그래서 압축이 잘 먹습니다:

- **Run-Length Encoding (RLE)**: 같은 값이 반복되면 (값, 횟수)로 저장. 정렬된 컬럼이나 boolean에 효과적.
- **Dictionary Encoding**: 자주 나오는 문자열을 정수 ID로 치환 (예: 국가 컬럼의 'KR' → 1, 'US' → 2).
- **Delta Encoding**: 정렬된 숫자/타임스탬프의 증분만 저장.
- **Bit Packing**: 작은 정수값을 정확히 필요한 비트 수로만 저장.

이런 기법들로 데이터 분포가 잘 맞으면 **수 배 이상의 압축률**이 흔히 보고됩니다 (Airbyte 등 업계 자료에서 5~10× 압축 사례 다수). 특히 *low cardinality*(반복되는 값이 많은) 컬럼이나 정렬된 타임스탬프/숫자 컬럼에서 높은 압축률이 나오기 쉽습니다. 다만 실제 압축률은 cardinality, 정렬 여부, encoding 방식, null 비율에 따라 크게 달라집니다. 압축의 부수 효과는 명확합니다. **더 적은 디스크 IO + 더 적은 메모리 사용 = 더 빠른 쿼리.**

### Vectorized Execution + SIMD

전통적인 row store 엔진들은 행 하나씩(*tuple-at-a-time*) 처리하는 경향이 있습니다. 각 행에 함수 호출, 분기, 메모리 접근이 따라오는 *Volcano iterator model* 이 고전 표준입니다. 다만 PostgreSQL/MySQL 등도 실행기 최적화가 다양하므로 모든 전통 시스템이 순수 tuple-at-a-time이라 단정할 수는 없습니다. 핵심은 *row sequential processing* 의 오버헤드가 *column-vectorized 처리* 에 비해 크다는 점.

Column store는 **값 한 묶음(vector)을 한꺼번에 처리합니다.** 모던 엔진은 보통 수천 개 값을 한 batch로 처리합니다. DuckDB의 `STANDARD_VECTOR_SIZE`는 2048이고, ClickHouse도 비슷한 규모입니다. 이게 가능한 이유:

- 같은 컬럼의 값들은 같은 타입이라 한 번에 같은 연산을 적용 가능.
- 메모리에 연속 배치되어 있어 CPU 캐시 친화적.
- **SIMD (Single Instruction, Multiple Data)** 명령어로 한 번에 여러 값을 병렬 처리.

예: `WHERE country = 'USA'` 필터링을 vector batch(예: 2048개) 단위로 처리하면서, 내부 루프에서 SIMD 명령으로 수 개에서 수십 개의 값을 동시에 비교합니다 (SIMD 레지스터 폭과 데이터 타입에 따라 다름: AVX2는 256비트, AVX-512는 512비트 폭으로, int32 기준 각각 8개·16개를 한 명령에 처리). 즉 **vector batch는 엔진 차원의 단위, SIMD는 CPU 차원의 단위**이며, 둘이 결합해 처리량을 극대화합니다. Row store에서는 각 행마다 함수 호출 → 분기 → 메모리 접근이 반복되는데, vectorized engine은 이 오버헤드를 크게 줄입니다. 한 단계 더 들어가면, 같은 타입 값이 연속 배치되어 *branch prediction이 안정적이고 CPU cache line 사용률도 높아져*, row store와는 다른 CPU 차원의 특성을 보입니다.

실측 효과: Spanner의 columnar engine은 분석 쿼리 최대 200× 가속 보고 (Google Cloud, 2025). TimescaleDB는 5×~166× 향상 보고.

### Late Materialization

전통적인 쿼리 실행은 *일찍* 행을 재구성합니다. 필터링 전에 모든 컬럼을 합쳐서 행을 만든 후 조건 비교. **Late materialization**은 정반대입니다:

1. 필터 조건에 쓰이는 컬럼만 먼저 스캔 → 통과한 행의 *위치 리스트(position list)*만 보관.
2. 다음 단계에서 통과한 위치만 다른 컬럼에서 가져옴.
3. 마지막에 결과 컬럼만 모아서 행으로 재구성.

결과: 필터에서 99% 행이 탈락하면 나머지 99% 컬럼 데이터를 *아예 안 읽음.* 메모리 사용·CPU 캐시 효율 모두 향상.

### Zone Map과 Data Skipping

현대 column store의 또 하나의 핵심 무기입니다. **데이터 블록(row group, granule, segment 등) 단위로 min/max 통계를 메타데이터로 저장**해두고, 쿼리 필터와 비교해 통째로 건너뛸 수 있는 블록을 빠르게 골라냅니다. Oracle은 이를 *zone map*, IBM DB2는 *synopsis*라 부르고, Parquet/ORC는 row group/stripe 단위 min/max를 footer에 저장합니다. ClickHouse의 sparse primary index도 이 개념의 한 형태(granule 단위 첫 키 저장).

예: `WHERE price > 100` 쿼리에서 row group 1의 max=80이면 row group 1은 통째로 스킵. 선택적인 필터에서는 90% 이상의 데이터를 아예 건드리지 않고 끝나는 경우가 흔합니다(IBM Research의 *Extensible Data Skipping* 논문 등 다수 측정).

확장 형태로 **Bloom filter**(equality 필터에 효과적)와 **dictionary filter**도 함께 쓰입니다. ClickHouse, DuckDB, Snowflake, Spark, Trino, Dremio 등 거의 모든 현대 OLAP 엔진이 이 메커니즘을 활용합니다.

다만 한계도 명확합니다. 필터 selectivity가 낮거나(스킵할 수 있는 블록이 적음) 데이터가 정렬되어 있지 않으면(min-max 범위가 모든 블록에서 비슷하게 넓음) data skipping 효과는 제한적입니다. 그래서 column store에서 **ORDER BY 키 설계와 데이터 정렬은 압축률뿐 아니라 skipping 효율에도 결정적으로 영향**을 줍니다.

> **5장 요약**: Column store가 빠른 이유는 *적은 IO만이 아니라*, 높은 압축률 + vectorized SIMD 처리 + late materialization + zone map/data skipping이 결합된 결과입니다. 자료구조와 CPU 아키텍처가 한 단위로 묶인 설계.

## 6. Row Store가 강한 진짜 이유: Locality + 단순성 + 트랜잭션

Row store의 강점도 *몇 행 lookup이 빠르다* 그 이상입니다.

### Locality

한 행의 모든 데이터가 물리적으로 인접합니다. OLTP의 전형적 패턴(한 사용자의 정보를 몽땅 가져오기, 한 주문의 모든 컬럼을 업데이트하기)에서는 한 번 페이지에 적중하면 추가 컬럼 접근 비용이 낮습니다. CPU 캐시도 한 행 단위로 잘 머뭅니다. (단, 인덱스를 통한 lookup의 경우 *어느 페이지에 도달할 것인가*는 인덱스 동작에 좌우됩니다. 예를 들어 PostgreSQL heap + B+Tree index는 leaf의 CTID가 가리키는 페이지에 random 접근하게 됩니다. **페이지 내부 locality**와 **페이지 간 locality**는 별개의 문제입니다.)

Column store에서 같은 작업을 하려면 컬럼 수만큼의 영역 접근이 필요합니다. 여러 컬럼 영역에 분산된 접근으로 인해 메모리 locality와 CPU 캐시 효율이 떨어집니다 (HDD 시대에는 디스크 seek 비용까지 컸지만, SSD 환경에서는 캐시·prefetch 효율 저하가 주된 비용).

### 단순성과 트랜잭션

- **WAL 기록**: [WAL](/blog/theory/transaction-acid-04-durability)에는 페이지 변경을 반영하는 로그 레코드들이 기록되는데, MVCC에서 UPDATE는 새 row version 생성 + old tuple mark dead + 필요 시 인덱스 변경을 포함할 수 있어 실제 WAL 기록은 단일 델타라기보다 여러 변경의 집합이 됩니다 (체크포인트 직후 첫 변경이면 full page write까지). 그래도 row store에서는 이 변경들이 *한 행 단위로 응집되어 발생* 하고(InnoDB의 Redo Log는 ARIES 계열의 *physiological logging* 모델을 따라 *"어느 페이지에 어떤 논리적 연산을 어떻게 적용할 것인가"* 를 기록), column store는 같은 행 UPDATE가 여러 컬럼 단위 변경으로 발생할 수 있어 변경 단위가 row store에 비해 분산됩니다. (PostgreSQL은 ARIES 식 명시적 undo log 대신 MVCC + CLOG로 처리하는 다른 길을 가지만, 변경이 행 중심으로 응집된다는 점은 동일.)
- **MVCC**: [행 단위 버전 관리](/blog/theory/transaction-acid-02-isolation)가 row store에서 자연스럽게 맞물립니다. Column store에서는 version 정보가 컬럼 단위로 분산될 수 있어 row 단위 snapshot을 유지하는 구현이 row store보다 복잡해지고, 그래서 시스템마다 다양한 방식으로 해결합니다. ClickHouse는 *delete bitmap* (`_row_exists` 마스크)과 MergeTree 기반 mutation을 쓰고 (실제로 MVCC + Snapshot Isolation 제공), 일부는 delta store + main store 분리, 일부는 version column 등을 활용합니다.
- **인덱스 동작**: row store의 secondary index는 *행 위치(CTID)*만 가리키면 되어 자연스럽습니다. Column store에서는 인덱스가 컬럼 영역과 어떻게 연결되는가가 시스템마다 다르고(예: ClickHouse의 sparse primary index는 행이 아닌 granule 단위로 가리킴), row store만큼 단순하지는 않습니다.

### 결과: 왜 OLTP DB는 row store인가

PostgreSQL, MySQL InnoDB의 기본 저장 방식은 row store입니다. Oracle, SQL Server도 기본 OLTP 경로는 row 기반이지만, 분석 성능을 위해 columnar 구조를 부분적으로 도입해왔습니다(아래 7장에서). 짧은 트랜잭션 + 점-쿼리 + 동시성이라는 전통적인 OLTP 워크로드에서는 row store가 일반적으로 더 자연스럽고 효율적인 선택이 됩니다. 다만 LSM 기반(RocksDB 계열)이나 일부 HTAP 시스템처럼 다른 접근으로 OLTP 영역을 다루는 시스템도 존재합니다.

> **6장 요약**: Row store가 OLTP에 강한 이유는 *행 locality + 행 단위 응집된 변경 단위 + 자연스러운 인덱스 매핑*입니다. 트랜잭션 시스템에서 row store가 기본 선택이 되는 데에는 이 구조적 이유들이 있습니다.

## 7. 실제 시스템들: 누가 무엇을 쓰는가

### Row-oriented OLTP 중심

- **PostgreSQL, MySQL InnoDB**: 기본 저장 방식이 순수 row store. [1편](/blog/theory/db-storage-01-heap-page-index)에서 다룬 모든 메커니즘(Heap, B+Tree, MVCC, WAL)이 row store 가정 위에서 설계됨.
- **Oracle, SQL Server**: 기본 OLTP 경로는 row 기반이지만, 분석 워크로드를 위해 columnar 구조를 함께 제공(아래 hybrid 섹션 참고).

### Columnar OLAP 중심

- **Apache Parquet, ORC**: 데이터 레이크의 파일 포맷 표준. Spark, Hive, Presto 등이 읽음. 압축 + 통계 메타데이터 내장.
- **ClickHouse**: 오픈소스 OLAP DB. 로그·메트릭 분석에서 널리 쓰임.
- **DuckDB**: 임베디드 분석 DB. SQLite의 OLAP 버전이라 부를 만함.
- **Amazon Redshift, Google BigQuery, Snowflake**: 클라우드 데이터 웨어하우스의 대표 사례. columnar storage 기반에 vectorized execution + 분산 처리를 결합.

### Hybrid 접근: OLTP와 OLAP를 한 시스템에

이게 최근의 흐름입니다. 데이터를 두 번 쓰지 않으면서 두 워크로드를 한 시스템에서 처리하려는 시도:

- **TimescaleDB**: PostgreSQL 확장. 최근 데이터는 row store, 오래된 데이터는 자동으로 columnar 압축으로 전환. TimescaleDB 2.12부터 SIMD vectorized execution 지원.
- **Google Spanner Columnar Engine**: 기존 row-based Spanner에 columnar engine을 추가해 같은 데이터를 두 형식으로 유지하는 hybrid 접근. Google Cloud 발표 기준 분석 쿼리 최대 200× 가속.
- **MySQL HeatWave**: MySQL에 인메모리 column store 분석 엔진 추가.
- **Oracle In-Memory Column Store**: 디스크는 row store, 메모리는 column store dual format.
- **PostgreSQL의 columnar 확장들**: Citus의 columnar(이전 cstore_fdw), Hydra 등.

### HTAP (Hybrid Transactional/Analytical Processing)

이런 hybrid 시스템들이 추구하는 것이 **HTAP**, 즉 한 시스템에서 OLTP와 OLAP를 모두 처리하는 것입니다. 학계 연구로는 Lang et al.의 *Data Blocks* (2016)이 대표적 사례입니다. 압축된 컬럼 형식 + light-weight 인덱스 + JIT 컴파일 + vectorized scan을 결합한 접근으로, CMU의 15-721 강의에서도 핵심 자료로 다뤄집니다.

> **7장 요약**: 전통 RDBMS는 row store, 데이터 웨어하우스는 column store가 표준입니다. 최근에는 둘을 한 시스템에서 다루는 hybrid/HTAP 접근이 중요한 흐름 중 하나로 자리잡고 있습니다.

## 8. 정리: 어느 쪽을 선택할 것인가

### 결정 가이드

| 질문 | Yes → | No → |
|---|---|---|
| 워크로드가 OLTP (트랜잭션, 점-쿼리, 짧은 응답)? | Row Store (PostgreSQL, MySQL) | 다음 질문 |
| 워크로드가 OLAP (분석, 집계, 광범위 스캔)? | Column Store (ClickHouse, Parquet, Snowflake) | 다음 질문 |
| 둘 다 필요? 데이터를 두 번 쓰기 싫음? | Hybrid/HTAP (TimescaleDB, Spanner, HeatWave) | 워크로드 재정의 필요 |

### 핵심 통찰

- **같은 데이터, 다른 배치**: Row store는 *같이 읽는 데이터를 같이 배치*하고, column store는 *같이 계산하는 데이터를 같이 배치*합니다. 우열의 문제가 아니라 *접근 패턴 적합성*의 문제입니다.
- **OLTP는 row store, OLAP는 column store**: 점-쿼리·트랜잭션에는 row, 집계·스캔에는 column이 일반적으로 더 자연스럽습니다. 다만 LSM(RocksDB 계열)이나 HTAP처럼 다른 접근으로 OLTP 영역을 다루는 시스템도 있습니다.
- **`SELECT *`는 column store의 약점이 드러나는 패턴**: 컬럼 영역마다 행을 재구성해야 해서 장점이 크게 줄어듭니다. 행 단위가 자주 필요하면 row store로.
- **압축은 column store의 부수 효과가 아니라 핵심**: 같은 타입·유사 분포 덕분에 데이터 분포에 따라 수 배 이상의 압축이 흔히 보고됨 (정확한 수치는 cardinality, 정렬, encoding, null 비율에 따라 달라짐).
- **Vectorized + SIMD + Data Skipping이 진짜 가속의 출처**: column store가 빠른 건 *적은 IO만이 아니라*, CPU 효율(vectorized batch + SIMD)과 zone map/min-max metadata 기반 data skipping이 결합된 결과입니다. 현대 OLAP 엔진은 *읽지 않을 데이터를 빨리 골라내는 메커니즘* 에 사활을 겁니다.
- **Hybrid/HTAP가 중요한 흐름**: TimescaleDB, Spanner Columnar Engine, Oracle Database In-Memory 같은 HTAP 접근이 데이터를 두 번 쓰지 않으면서 두 워크로드를 처리하는 방향으로 발전 중입니다. 모든 워크로드를 다 대체하지는 않지만, OLTP/OLAP 경계가 모호한 경우 강력한 선택지.

> 결국 row vs column 선택은 **어떤 차원(행 vs 컬럼)에 대해 locality를 최적화할 것인가**의 문제입니다. 행 차원의 locality를 최적화하면 OLTP에 자연스러워지고, 컬럼 차원의 locality를 최적화하면 OLAP에 자연스러워집니다. 자료구조의 선택이 곧 *어떤 쿼리를 빠르게 만들고 어떤 쿼리를 포기할 것인가의 선언*입니다.

### 글의 범위와 한계

이 글은 row store vs column store의 *개념적 대비*를 다뤘습니다. 실제 시스템은 둘 중 하나로 깔끔히 떨어지지 않는 경우가 많다는 점은 짚어둘 필요가 있습니다:

- **LSM 기반 스토리지**(RocksDB, Cassandra, Scylla 등): row store도 column store도 아닌 *Sorted String Table + write-ahead 메커니즘* 기반의 third path. OLTP 영역의 일부를 다른 방식으로 해결.
- **HTAP 시스템**(TimescaleDB, Spanner Columnar Engine, Oracle Database In-Memory 등): 같은 데이터를 row와 column 두 형식으로 동시에 유지하거나, 자동 변환을 통해 두 워크로드를 한 시스템에서 처리.
- **Columnar index / columnstore index**(SQL Server, MySQL HeatWave 등): 기본은 row store인데 columnar 구조를 보조 인덱스/엔진으로 추가.

따라서 이 글의 모델은 *개념적 이해를 위한 단순화된 그림* 이고, 실전 시스템 선택에서는 워크로드 패턴 + 데이터 양 + 일관성 요구사항 + 운영 비용 등 다양한 차원이 함께 고려됩니다.

## 참고 (1차 자료 우선)

- [Airbyte — A Comprehensive Guide to Columnar Storage](https://airbyte.com/data-engineering-resources/columnar-storage): 압축 비율 5~10× + vectorized execution 권위 설명
- [Google Cloud — Spanner's Columnar Engine Unites OLTP & Analytics](https://cloud.google.com/blog/products/databases/spanner-columnar-engine-unites-oltp-and-analytics): 200× 분석 가속, hybrid 아키텍처 사례
- [InfoQ — Columnar Databases and Vectorization](https://www.infoq.com/articles/columnar-databases-vectorization/): SIMD + dictionary encoding 메커니즘 깊이 설명
- [TimescaleDB — Teaching Postgres New Tricks: SIMD Vectorization](https://www.timescale.com/blog/teaching-postgres-new-tricks-simd-vectorization-for-faster-analytical-queries): PostgreSQL hybrid 접근 사례, 5~166× 가속 측정
- [MotherDuck — Columnar Databases: Column vs Row Storage](https://motherduck.com/learn-more/columnar-database/): DuckDB 관점의 column store 종합 설명
- [DuckDB — Execution Format documentation](https://duckdb.org/docs/internals/vector.html): `STANDARD_VECTOR_SIZE = 2048` 공식 명세
- [ClickHouse — Transactional (ACID) Support](https://clickhouse.com/docs/en/guides/developer/transactional): MVCC + Snapshot Isolation 공식 문서
- [ClickHouse — Sparse Primary Indexes](https://clickhouse.com/docs/en/optimize/sparse-primary-indexes): granule 단위 sparse index 동작
- Rabl et al., *Extensible Data Skipping* (arxiv 2009.08150): zone map / data skipping 학술적 분석
- Lang et al., *Data Blocks: Hybrid OLTP and OLAP on Compressed Storage* (2016, CMU 15-721): HTAP 학술 기원
- [Apache Parquet Documentation](https://parquet.apache.org/docs/): 컬럼 파일 포맷 표준 명세
- Mohan et al., *ARIES: A Transaction Recovery Method Supporting Fine-Granularity Locking* (1992): physiological logging 모델 학술 기원

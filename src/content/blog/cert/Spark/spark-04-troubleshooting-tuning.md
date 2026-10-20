---
title: '[Spark Ch-04] 문제 해결과 튜닝: 느린 Job은 파티션 크기와 셔플 위치부터 본다'
description: Databricks Spark 자격증 4영역(문제 해결과 튜닝, 10%)을 시험 안내서 항목 순서대로 정리합니다. repartition과 coalesce, 데이터 쏠림, 셔플 줄이기, AQE의 설정과 기본값, explain()과 Spark UI, 드라이버·익스큐터 로그로 메모리 부족과 저사용을 가르는 방법을 Spark 4.2.0 공식 문서 기준으로 확인합니다.
date: 2026-10-19T00:00:00.000Z
tags:
  - Spark
  - Databricks
  - PySpark
  - Certification
  - AQE
  - Performance Tuning
category: cert/Spark
topics:
  - cert
draft: false
series: "Spark 공부"
seriesOrder: 4
---

## 결론부터

1. 파티션 수는 세 군데에서 정해집니다. 파일을 읽을 때는 `spark.sql.files.maxPartitionBytes`(기본 128MB), 셔플 뒤에는 `spark.sql.shuffle.partitions`(기본 200), 직접 바꿀 때는 `repartition()`과 `coalesce()`입니다. 튜닝 문제는 대부분 이 셋 중 어디를 건드리는지 묻습니다.
2. `coalesce(n)`은 셔플 없이 파티션을 합치는 좁은 의존성이라 줄이기만 됩니다. 늘리라고 하면 현재 수를 유지합니다. `repartition(n)`은 전체 셔플을 일으키는 해시 파티셔닝이고 늘리기와 줄이기가 모두 됩니다.
3. AQE는 3.2.0부터 기본으로 켜져 있고 런타임 통계로 세 가지를 합니다. 셔플 뒤 작은 파티션 합치기, sort-merge 조인을 broadcast 조인이나 shuffled hash 조인으로 바꾸기, 쏠린 파티션 쪼개기입니다. 쏠림 판정은 파티션이 중앙값의 5배를 넘고 동시에 256MB를 넘을 때입니다.
4. 셔플을 줄이는 첫 수단은 작은 쪽 테이블을 broadcast하는 것입니다. 자동 broadcast 기준은 `spark.sql.autoBroadcastJoinThreshold` 10MB이고 -1이면 꺼집니다. 그다음은 필터와 컬럼 선택을 일찍 해서 소스에서 덜 읽는 것입니다.
5. 메모리 부족(OOM)은 어느 프로세스에서 났는지부터 가릅니다. `collect()`와 `toPandas()`처럼 결과를 한곳으로 모으면 드라이버가, 쏠린 파티션이나 큰 그룹을 한 Task가 들고 있으면 익스큐터가 터집니다. 익스큐터 로그는 Spark UI의 Executors 탭이나 Stage 상세 화면의 Task 표에서 엽니다.

---

## 1. 시험 안내서 항목과 이 글의 순서

2025년 10월판 시험 안내서의 4영역 제목은 "Troubleshooting and Tuning Apache Spark DataFrame API Applications"이고 항목은 셋입니다.

| 안내서 항목(원문 요약) | 이 글 |
|---|---|
| 성능 튜닝과 클러스터 활용 최적화: partitioning, repartitioning, coalescing, 데이터 쏠림 식별, 셔플 줄이기 | 2~5절 |
| Adaptive Query Execution(AQE)과 그 이점 | 6절 |
| 드라이버 로그와 익스큐터 로그를 남기고(publish) 설정하고(customize) 분석해서 OOM, 클러스터 저사용 등을 진단 | 7~11절 |

안내서 샘플 문항 2번이 이 영역에서 나왔습니다. Job 실행 시간이 늘어서 익스큐터 로그를 보려면 어떻게 하느냐는 문제이고 정답은 "Spark UI에서 Stage를 골라 익스큐터 로그를 연다"입니다. 로그 파일 경로를 외우기보다 UI에서 어디를 누르는지를 묻는다는 뜻으로 읽었습니다.

예제 데이터는 쇼핑몰 주문(`orders`)과 고객(`customers`), 결제(`payments`)로 통일합니다.

```python
from pyspark.sql import SparkSession, functions as F

spark = (SparkSession.builder
         .master("local[4]")
         .appName("ch04-tuning")
         .getOrCreate())

orders = spark.read.parquet("/data/orders")        # order_id, customer_id, store_id, amount, status, order_ts
customers = spark.read.parquet("/data/customers")  # customer_id, grade, region
```

## 2. 파티션 수가 정해지는 세 지점

파티션은 Task 하나가 처리하는 데이터 조각입니다. Stage 하나의 Task 수는 그 Stage의 파티션 수와 같으니 파티션 수가 곧 병렬도입니다.

| 지점 | 설정 또는 API | 기본값 | 비고 |
|---|---|---|---|
| 파일 읽기 | `spark.sql.files.maxPartitionBytes` | 128MB | 파티션 하나에 담는 최대 바이트. Parquet, JSON, ORC 같은 파일 소스에만 적용 |
| 파일 읽기 | `spark.sql.files.openCostInBytes` | 4MB | 파일 하나를 여는 비용을 바이트로 환산한 값. 작은 파일 여러 개를 한 파티션에 묶을 때 쓴다 |
| 셔플 뒤(조인, 집계) | `spark.sql.shuffle.partitions` | 200 | DataFrame과 SQL의 셔플 파티션 수 |
| RDD 셔플, `parallelize` | `spark.default.parallelism` | 로컬은 코어 수, 그 밖은 전체 익스큐터 코어 수와 2 중 큰 값 | DataFrame 셔플에는 위 설정이 쓰인다 |
| 직접 지정 | `repartition()`, `coalesce()`, `repartitionByRange()` | 없음 | 3절 |

Tuning 가이드의 "Level of Parallelism" 절은 클러스터의 CPU 코어 하나당 Task 2~3개를 권합니다. 코어가 16개라면 셔플 파티션 32~48개가 출발점이라는 계산입니다. 기본값 200은 로컬 노트북에서는 너무 많고 수백 GB 셔플에는 너무 적을 수 있습니다. AQE의 파티션 합치기(6절)가 이 값을 런타임에 줄여 주는 이유이기도 합니다.

현재 파티션 수와 파티션별 행 수는 이렇게 봅니다.

```python
print(orders.rdd.getNumPartitions())

(orders
 .groupBy(F.spark_partition_id().alias("pid"))
 .count()
 .orderBy(F.desc("count"))
 .show(5))
```

`df.rdd`는 Spark Connect에서 쓸 수 없습니다(Ch-06에서 다룹니다). Connect 환경에서는 `spark_partition_id()`로 묶어 세는 두 번째 방법만 됩니다.

헷갈리는 지점은 둘입니다.

- `spark.sql.shuffle.partitions`는 셔플이 일어난 뒤의 파티션 수입니다. 파일을 읽은 직후 파티션 수와는 관계가 없습니다. 안내서 샘플 문항 5번이 이 설정의 기본값 200의 의미를 묻고 정답은 "셔플할 때 200개로 나뉜다"입니다.
- AQE가 켜져 있으면 실제 셔플 파티션 수는 200보다 작게 나올 수 있습니다. 200개를 만든 뒤 작은 것을 합치기 때문입니다.

## 3. repartition과 coalesce

### 3-1. 시그니처와 동작

PySpark API 문서 기준 시그니처입니다.

```python
DataFrame.repartition(numPartitions, *cols)
DataFrame.repartitionByRange(numPartitions, *cols)
DataFrame.coalesce(numPartitions)
```

| | `repartition` | `coalesce` |
|---|---|---|
| 셔플 | 전체 셔플 | 없음(좁은 의존성) |
| 파티셔닝 방식 | 해시 파티셔닝. 컬럼을 주면 그 컬럼의 해시로 나눈다 | 기존 파티션을 이웃끼리 묶는다 |
| 늘리기 | 된다 | 현재 수를 유지한다 |
| 줄이기 | 된다 | 된다 |
| 파티션 크기 | 고르게 다시 나뉜다 | 합친 결과라 고르지 않을 수 있다 |
| 인자 | 숫자, 컬럼, 둘 다 | 숫자만 |

`coalesce` 문서는 1000개를 100개로 줄이면 셔플 없이 새 파티션 하나가 기존 파티션 10개를 맡는다고 설명합니다. 같은 문서가 `numPartitions = 1`처럼 급격히 줄이면 계산이 원하는 것보다 적은 노드(1이면 노드 하나)에서 돌 수 있으니 `repartition()`을 쓰라고 권합니다. 셔플이 하나 더 생기지만 앞 단계는 원래 파티션 수대로 병렬로 돕니다.

`repartition(numPartitions)`의 첫 인자에 컬럼을 주면 그 컬럼이 첫 파티셔닝 컬럼이 되고 파티션 수는 기본값을 씁니다. `repartition("store_id")`는 셔플 파티션 수(기본 200)만큼 나뉩니다.

```python
# 매장별로 묶어서 다음 집계의 셔플을 미리 맞춘다
by_store = orders.repartition(64, "store_id")

# 날짜 범위로 정렬된 파티션이 필요할 때
by_day = orders.repartitionByRange(30, "order_ts")

# 집계 결과가 작아서 파일 수만 줄이고 싶을 때
daily = (orders.groupBy(F.to_date("order_ts").alias("d"))
               .agg(F.sum("amount").alias("revenue")))
daily.coalesce(1).write.mode("overwrite").parquet("/out/daily_revenue")
```

마지막 줄의 `coalesce(1)`은 집계 결과가 작을 때만 맞는 선택입니다. 좁은 의존성이라 `coalesce(1)`이 앞 Stage까지 파티션 하나로 끌어내릴 수 있습니다. 위 코드에서는 `groupBy`가 셔플 경계를 만들어서 집계 자체는 셔플 파티션 수만큼 병렬로 돌고 마지막 쓰기만 Task 하나가 맡습니다. 셔플 경계 없이 큰 DataFrame에 바로 `coalesce(1)`을 걸면 읽기부터 Task 하나가 할 수 있습니다.

### 3-2. SQL 파티셔닝 힌트

Spark SQL에도 같은 일을 하는 힌트가 있습니다(Performance Tuning 문서의 Partitioning Hints).

| 힌트 | 인자 |
|---|---|
| `COALESCE` | 파티션 수만 |
| `REPARTITION` | 파티션 수, 컬럼, 둘 다, 또는 없음 |
| `REPARTITION_BY_RANGE` | 컬럼 필수, 파티션 수는 선택 |
| `REBALANCE` | 초기 파티션 수, 컬럼, 둘 다, 또는 없음 |

```sql
SELECT /*+ REPARTITION(64, store_id) */ * FROM orders;
SELECT /*+ REBALANCE(store_id) */ * FROM orders;
```

`REBALANCE`는 AQE가 켜져 있을 때 쏠린 파티션을 쪼개고 작은 파티션을 합쳐 출력 파일 크기를 맞추는 데 씁니다. 관련 설정이 `spark.sql.adaptive.optimizeSkewsInRebalancePartitions.enabled`(기본 true, 3.2.0)입니다.

### 3-3. 헷갈리는 지점

- `coalesce(400)`을 파티션 200개인 DataFrame에 걸면 200개 그대로입니다. 오류도 나지 않습니다.
- `repartition`은 트랜스포메이션이라 액션 전까지 아무 일도 하지 않습니다. 파티션 수를 바꾸는 시점은 Job이 돌 때입니다.
- `df.write.partitionBy("col")`은 출력 디렉터리 구조를 정하는 것이고 메모리 안의 파티션 수와는 다른 개념입니다. 이름이 비슷해서 시험 보기에서 섞어 냅니다.

## 4. 데이터 쏠림

쏠림(skew)은 특정 키에 행이 몰려서 그 키를 맡은 파티션 하나가 다른 파티션보다 훨씬 큰 상태입니다. 쇼핑몰이라면 대형 입점 매장 하나의 `store_id`, 비회원 주문이 모두 같은 값으로 들어간 `customer_id`가 흔한 예입니다. Stage는 마지막 Task가 끝나야 끝나서 큰 파티션 하나가 Stage 전체 시간을 정합니다.

### 4-1. Spark UI에서 찾기

Web UI 문서 기준으로 Stage 상세 화면이 쏠림을 보는 곳입니다.

| 화면 위치 | 볼 것 |
|---|---|
| Stage 상세의 Summary metrics 표 | Duration, Shuffle Read Size / Records, Peak execution memory의 분포. 최댓값이 중앙값보다 몇 배 크면 쏠림 |
| 같은 화면의 Executor별 집계 | 한 익스큐터만 Shuffle Read가 큰지 |
| Task 표 | 오래 걸린 Task 하나의 입력 크기와 Spill. Task 행마다 익스큐터 로그 링크가 있다 |
| 이벤트 타임라인 | 다른 Task가 모두 끝난 뒤 혼자 남은 막대 |
| SQL 탭의 계획 그래프 | Exchange 노드의 `shuffle bytes written`, Sort와 HashAggregate의 `spill size` |

Summary metrics 표가 최솟값, 25번째 백분위, 중앙값, 75번째 백분위, 최댓값을 보여 준다는 것은 UI 화면 기준 설명이고 이번 글에서는 화면을 직접 띄워 보지 못했습니다.

코드로는 키별 행 수를 세면 됩니다.

```python
(orders.groupBy("store_id")
       .count()
       .orderBy(F.desc("count"))
       .show(10))
```

### 4-2. AQE skew join으로 자동 처리

AQE의 skew join 최적화는 sort-merge 조인에서 쏠린 파티션을 여러 개로 쪼개고 필요하면 반대쪽 파티션을 복제해서 Task 크기를 맞춥니다. 판정 조건은 두 설정을 동시에 넘는 것입니다.

| 설정 | 기본값 | 의미 |
|---|---|---|
| `spark.sql.adaptive.skewJoin.enabled` | true | AQE가 켜져 있을 때 skew join 처리 |
| `spark.sql.adaptive.skewJoin.skewedPartitionFactor` | 5.0 | 중앙값 파티션 크기의 이 배수보다 커야 한다 |
| `spark.sql.adaptive.skewJoin.skewedPartitionThresholdInBytes` | 256MB | 이 바이트보다도 커야 한다. advisory 크기(64MB)보다 크게 두라고 문서가 권한다 |
| `spark.sql.adaptive.forceOptimizeSkewedJoin` | false | 셔플이 하나 더 생겨도 skew join 규칙을 강제로 적용 |

중앙값이 10MB인데 한 파티션이 200MB라면 배수 조건(50MB 초과)은 넘지만 256MB를 넘지 못해 쏠림으로 보지 않습니다. 두 조건이 AND라는 점이 시험에서 헷갈리기 좋은 자리입니다. 대상이 sort-merge 조인이라는 점도 문서에 적혀 있습니다. 집계(`groupBy`)의 쏠림은 이 규칙이 처리하지 않습니다.

### 4-3. salting으로 직접 처리

AQE가 처리하지 못하는 쏠림(집계의 쏠림, 판정 기준 아래의 쏠림)은 키에 임의의 접미사(salt)를 붙여 한 키를 여러 파티션으로 흩는 방법을 씁니다. 이 기법은 Spark 공식 문서에서 찾지 못했고 널리 쓰이는 패턴으로 정리합니다.

```python
N = 8  # 한 키를 몇 조각으로 흩을지

# 1단계: 소금 친 키로 부분 집계
salted = orders.withColumn("salt", (F.rand(seed=42) * N).cast("int"))
partial = (salted.groupBy("store_id", "salt")
                 .agg(F.sum("amount").alias("part_sum")))

# 2단계: 원래 키로 다시 합치기
revenue = partial.groupBy("store_id").agg(F.sum("part_sum").alias("revenue"))
```

조인에 쓸 때는 큰 쪽에 0~N-1 사이의 salt를 붙이고 작은 쪽은 salt 0~N-1을 모두 가진 행으로 N배 복제해서 `(key, salt)`로 조인합니다. 작은 쪽이 N배 커지는 대가가 있습니다. 작은 쪽이 broadcast할 만큼 작으면 salting보다 broadcast 조인(5-1)이 더 단순합니다.

### 4-4. 헷갈리는 지점

- 쏠림은 파티션 수를 늘려도 풀리지 않을 수 있습니다. 같은 키는 해시가 같아서 파티션을 1000개로 늘려도 한 파티션으로 갑니다.
- 반대로 파티션이 너무 적어서 모든 파티션이 큰 상태는 쏠림과 증상이 다릅니다. Summary metrics의 중앙값과 최댓값이 함께 크면 파티션 수 문제, 최댓값만 크면 쏠림입니다.

## 5. 셔플 줄이기

셔플은 데이터를 키 기준으로 다시 나눠 네트워크로 주고받는 단계이고 Stage 경계를 만듭니다. 계획에서는 `Exchange` 노드로 보입니다. 줄이는 방법은 셔플 자체를 없애는 것(broadcast)과 셔플할 양을 줄이는 것(필터, 컬럼 선택, 부분 집계)으로 나눠 봅니다.

### 5-1. broadcast 조인

작은 테이블을 모든 익스큐터에 통째로 보내면 큰 테이블은 셔플하지 않고 그 자리에서 조인합니다.

| 설정 | 기본값 | 의미 |
|---|---|---|
| `spark.sql.autoBroadcastJoinThreshold` | 10485760(10MB) | 이 크기 이하로 추정되는 테이블을 자동으로 broadcast. -1이면 끈다 |
| `spark.sql.broadcastTimeout` | 300(초) | broadcast를 기다리는 시간 |
| `spark.sql.adaptive.autoBroadcastJoinThreshold` | 없음(위 값과 같음) | AQE가 런타임에 broadcast로 바꿀 때만 쓰는 기준(3.2.0) |

```python
from pyspark.sql.functions import broadcast

# 고객 등급 테이블이 작다는 것을 알고 있을 때
joined = orders.join(broadcast(customers), "customer_id")

# 같은 뜻의 힌트
joined2 = orders.join(customers.hint("broadcast"), "customer_id")
```

```sql
SELECT /*+ BROADCAST(c) */ o.order_id, c.grade
FROM orders o JOIN customers c ON o.customer_id = c.customer_id;
```

조인 전략 힌트는 `BROADCAST`, `MERGE`, `SHUFFLE_HASH`, `SHUFFLE_REPLICATE_NL` 네 가지입니다. SQL에서 `BROADCAST`는 `BROADCASTJOIN`, `MAPJOIN`이라고 써도 됩니다. 양쪽에 서로 다른 힌트를 주면 BROADCAST, MERGE, SHUFFLE_HASH, SHUFFLE_REPLICATE_NL 순으로 우선합니다. 문서는 어떤 전략은 모든 조인 유형을 지원하지 않아서 힌트대로 고른다는 보장이 없다고 적습니다.

헷갈리는 지점입니다.

- 자동 broadcast는 Spark가 추정한 크기로 판단합니다. 통계가 없거나 틀리면 작은 테이블이어도 sort-merge 조인을 고릅니다. 이때 AQE가 런타임 크기를 보고 broadcast로 바꿀 수 있습니다(6-3).
- broadcast할 테이블은 드라이버를 거쳐 익스큐터로 퍼지는 것으로 알려져 있어서 너무 큰 테이블을 강제로 broadcast하면 드라이버 메모리 부족이나 `broadcastTimeout` 초과가 날 수 있습니다. 드라이버를 거친다는 설명은 이번에 연 공식 문서에서 문장으로 확인하지 못했습니다.
- broadcast 조인(DataFrame 최적화)과 broadcast 변수(`sc.broadcast`, 읽기 전용 공유 값)는 다른 API입니다. 3영역 범위지만 이름 때문에 같이 나옵니다.

### 5-2. 필터 푸시다운과 컬럼 가지치기

Parquet, ORC 같은 컬럼 형식은 필요한 컬럼만 읽고(column pruning) 파일 메타데이터의 최솟값과 최댓값으로 필요 없는 블록을 건너뜁니다(filter pushdown). Spark가 이 정보를 소스로 내려보내려면 필터와 `select`가 계획 안에 있어야 합니다. 옵티마이저가 코드 순서와 관계없이 필터를 스캔 쪽으로 옮기기는 하지만 UDF로 감싼 조건은 소스에 내려보낼 수 없습니다.

| 설정 | 기본값 |
|---|---|
| `spark.sql.parquet.filterPushdown` | true |
| `spark.sql.orc.filterPushdown` | true |
| `spark.sql.csv.filterPushdown.enabled` | true(3.0.0) |
| `spark.sql.json.filterPushdown.enabled` | true(3.1.0) |

```python
paid = (orders
        .filter((F.col("status") == "PAID") & (F.col("order_ts") >= "2026-10-01"))
        .select("order_id", "customer_id", "amount"))
paid.explain()
```

문서 기준 예상 결과(실행하지 않았고 형태만 적었습니다):

```text
== Physical Plan ==
*(1) Filter (... status = PAID ... order_ts >= ...)
+- *(1) ColumnarToRow
   +- FileScan parquet [order_id, customer_id, amount, status, order_ts]
        PushedFilters: [IsNotNull(status), EqualTo(status,PAID), ...],
        ReadSchema: struct<order_id:..., customer_id:..., amount:..., status:..., order_ts:...>
```

`PushedFilters`에 조건이 있으면 소스로 내려간 것이고 `ReadSchema`에 필요한 컬럼만 있으면 가지치기가 된 것입니다. 이 두 필드 이름은 PySpark에서 흔히 보는 FileScan 출력이고 공식 문서 예제로는 확인하지 못해 표시해 둡니다.

### 5-3. 셔플할 양 줄이기

- 집계는 셔플 전에 부분 집계를 합니다. EXPLAIN 문서 예제의 계획이 `HashAggregate(partial_sum)` 다음에 `Exchange hashpartitioning(k, 200)`, 그다음 `HashAggregate(sum)` 순서입니다. 그래서 `groupBy().agg(sum)`은 키별 부분 합만 셔플합니다.
- 조인과 집계를 같은 키로 이어서 하면 이미 그 키로 나뉜 데이터는 다시 셔플하지 않습니다. 앞의 3-1에서 `repartition(64, "store_id")`를 미리 해 둔 이유입니다.
- 같은 셔플 결과를 여러 액션에서 쓰면 `cache()`로 재계산을 막습니다. DataFrame `cache()`의 기본 저장 레벨은 `MEMORY_AND_DISK_DESER`입니다(Ch-00 표).
- 자주 같은 키로 조인하는 영구 테이블은 `bucketBy`로 저장해 셔플을 줄일 수 있습니다. 2영역(Spark SQL) 범위라 여기서는 이름만 적습니다.

## 6. AQE

### 6-1. 무엇을 하는지

Performance Tuning 문서는 AQE를 런타임 통계로 가장 효율적인 실행 계획을 고르는 최적화라고 설명하고 3.2.0부터 기본으로 켜져 있다고 적습니다. 우산 설정은 `spark.sql.adaptive.enabled`입니다. 셔플이 끝난 Stage마다 실제 크기를 보고 남은 계획을 다시 짭니다. 정적 계획은 실행 전에 추정한 통계로만 정하니 추정이 틀린 만큼 손해를 봅니다.

| 기능 | 켜는 설정(기본) | 하는 일 |
|---|---|---|
| 셔플 뒤 파티션 합치기 | `spark.sql.adaptive.coalescePartitions.enabled`(true) | 이웃한 작은 셔플 파티션을 목표 크기에 맞춰 합친다 |
| 조인 전략 바꾸기 | 별도 스위치 없이 기준값으로 동작 | sort-merge 조인을 broadcast hash 조인이나 shuffled hash 조인으로 바꾼다 |
| skew join | `spark.sql.adaptive.skewJoin.enabled`(true) | 쏠린 파티션을 쪼갠다(4-2) |

### 6-2. 파티션 합치기 설정

| 설정 | 기본값 | 버전 |
|---|---|---|
| `spark.sql.adaptive.advisoryPartitionSizeInBytes` | 64MB | 3.0.0 |
| `spark.sql.adaptive.coalescePartitions.parallelismFirst` | true | 3.2.0 |
| `spark.sql.adaptive.coalescePartitions.minPartitionSize` | 1MB | 3.2.0 |
| `spark.sql.adaptive.coalescePartitions.initialPartitionNum` | 없음(셔플 파티션 수와 같음) | 3.0.0 |

기본값에서 함정이 하나 있습니다. `parallelismFirst`가 true면 목표 크기 64MB를 무시하고 최소 크기 1MB만 지키면서 병렬도를 최대로 둡니다. 문서는 AQE를 켰을 때 성능이 떨어지는 일을 막으려는 기본값이라고 설명합니다. 그리고 바쁜 클러스터에서는 작은 Task가 많아지지 않도록 false로 두라고 권합니다. 그러니 기본 설정에서 "AQE가 파티션을 64MB 단위로 합친다"는 말은 정확하지 않습니다.

문서가 제안하는 사용법은 `initialPartitionNum`을 넉넉하게 크게 두고 합치기를 AQE에 맡기는 것입니다. 데이터 크기에 맞는 셔플 파티션 수를 미리 맞출 필요가 줄어듭니다.

### 6-3. 조인 전략 바꾸기

- sort-merge 조인에서 broadcast hash 조인으로: 한쪽의 런타임 크기가 AQE broadcast 기준(`spark.sql.adaptive.autoBroadcastJoinThreshold`, 기본은 10MB 기준과 같음)보다 작으면 바꿉니다. 문서는 처음부터 broadcast로 계획한 것만큼 효율적이지는 않다고 적습니다. 이미 셔플은 했기 때문입니다. 그래도 양쪽 정렬을 건너뛰고 `spark.sql.adaptive.localShuffleReader.enabled`(기본 true)로 셔플 파일을 로컬에서 읽어 네트워크를 아낍니다.
- sort-merge 조인에서 shuffled hash 조인으로: 셔플 뒤 모든 파티션이 `spark.sql.adaptive.maxShuffledHashJoinLocalMapThreshold`보다 작으면 바꿉니다. 기본값이 0이라 기본 설정에서는 이 변환이 일어나지 않습니다.

### 6-4. 계획에서 AQE 확인하기

AQE가 켜진 상태에서 `explain()`을 실행 전에 찍으면 최상단에 `AdaptiveSparkPlan isFinalPlan=false`가 붙는 것으로 알려져 있습니다. 실행 뒤 SQL 탭의 상세 화면에서는 최종 계획(`isFinalPlan=true`)과 바뀐 조인을 볼 수 있습니다. 이 표기는 공식 문서 문장으로 확인하지 못해서 로컬에서 실행한 뒤 고치겠습니다. Performance Tuning 문서가 확인해 주는 것은 런타임 통계를 SQL UI의 "Details"에서 `Statistics(..., isRuntime=true)`로 찾을 수 있다는 점입니다.

```python
spark.conf.get("spark.sql.adaptive.enabled")        # 'true'
spark.conf.set("spark.sql.adaptive.enabled", "false")  # 비교 실험용으로 끄기
```

### 6-5. 헷갈리는 지점

- AQE는 셔플 경계에서 다시 계획합니다. 셔플이 없는 쿼리에는 바꿀 자리가 거의 없습니다.
- `spark.sql.adaptive.enabled`의 "Since"는 1.6.0이고 기본 true는 3.2.0부터입니다. 3.0과 3.1에서는 기본이 꺼져 있었습니다.
- skew join은 sort-merge 조인 대상이고 쏠림 판정은 5배와 256MB를 함께 넘어야 합니다.

## 7. explain()으로 계획 읽기

```python
DataFrame.explain(extended=None, mode=None)
```

| 호출 | 출력 |
|---|---|
| `explain()` 또는 `explain(mode="simple")` | 물리 계획만(기본) |
| `explain(True)` 또는 `explain(mode="extended")` | 파싱된 논리 계획, 분석된 논리 계획, 최적화된 논리 계획, 물리 계획 |
| `explain(mode="codegen")` | 물리 계획과 생성된 코드 |
| `explain(mode="cost")` | 논리 계획과 통계(있을 때) |
| `explain(mode="formatted")` | 물리 계획 개요와 노드별 상세 두 부분 |

`mode` 인자는 3.0.0에서 추가됐습니다. SQL로는 `EXPLAIN [EXTENDED | CODEGEN | COST | FORMATTED] statement`입니다.

계획에서 찾을 노드입니다.

| 노드 | 뜻 |
|---|---|
| `Exchange hashpartitioning(key, 200)` | 해시 셔플. 숫자가 셔플 파티션 수 |
| `Exchange rangepartitioning(...)` | 정렬이나 `repartitionByRange`를 위한 범위 셔플 |
| `Exchange SinglePartition` | 모든 데이터를 파티션 하나로. 파티션 없이 정렬한 Window 등에서 나온다 |
| `BroadcastExchange`, `BroadcastHashJoin` | broadcast 조인 |
| `SortMergeJoin` | 양쪽 셔플과 정렬이 필요한 조인 |
| `HashAggregate(partial_...)` | 셔플 전 부분 집계 |
| `*(n)` 접두사 | whole-stage codegen으로 묶인 구간과 그 id |

`explain()`은 계획만 출력하고 Job을 돌리지 않습니다. 비싼 연산이 들어 있는지 실행 전에 볼 수 있는 이유입니다.

## 8. Spark UI 탭

드라이버마다 Web UI가 뜨고 기본 포트는 `spark.ui.port` 4040입니다. 같은 머신에 애플리케이션이 여러 개면 4041, 4042로 올라가는 것으로 알려져 있습니다(이번에 문서 문장은 확인하지 못했습니다). 애플리케이션이 끝나면 UI도 사라지니 끝난 뒤에 보려면 `spark.eventLog.enabled`(기본 false)를 켜고 History Server를 띄웁니다.

| 탭 | 보여 주는 것 | 진단에 쓰는 곳 |
|---|---|---|
| Jobs | Job별 상태, 시간, 이벤트 타임라인, 상세에서 DAG와 Stage 목록 | 어느 액션이 오래 걸렸는지 |
| Stages | Stage별 상태. 상세에서 Task 요약 지표, Executor별 집계, Task 표 | 쏠림, Spill, GC 시간, 익스큐터 로그 링크 |
| Storage | 캐시된 RDD와 DataFrame, 저장 레벨, 크기 | 캐시가 실제로 됐는지. 액션 전에는 목록에 없다 |
| Environment | Spark Properties, 런타임 정보, 클래스패스 | 설정이 의도대로 들어갔는지 |
| Executors | 익스큐터와 드라이버의 메모리, 디스크, 코어, Task 수, GC 시간, stdout/stderr 로그 링크 | 익스큐터 로그, 저사용 |
| SQL | DataFrame과 SQL 쿼리 목록, 계획 그래프와 노드별 지표, Details에 논리·물리 계획 | 조인 전략, 셔플 바이트, AQE 결과 |
| Structured Streaming | 스트리밍 쿼리별 입력·처리 속도, 배치 시간, 상태 행 수 | Ch-05 |

Stage 상세의 요약 지표는 문서 기준으로 Task 역직렬화 시간, Duration, GC time, 결과 직렬화 시간, 결과 가져오기 시간, 스케줄러 지연, Peak execution memory, Shuffle Read Size / Records, Shuffle Read Fetch Wait Time, Shuffle Remote Reads, Shuffle Write Time, Shuffle spill(memory), Shuffle spill(disk)입니다. Spill(disk)이 크면 실행 메모리가 모자라 디스크로 넘긴 것이고 GC time이 Duration에서 큰 몫을 차지하면 힙이 빡빡하다는 신호입니다.

## 9. 드라이버 로그와 익스큐터 로그

### 9-1. 어디에 남는지

| 로그 | 위치 |
|---|---|
| 드라이버(client 모드) | `spark-submit`을 실행한 콘솔. 노트북이면 노트북 프로세스 쪽 |
| 드라이버(cluster 모드) | 클러스터 안에서 드라이버가 뜬 노드. 클러스터 매니저 UI로 찾는다 |
| 익스큐터 | Spark UI Executors 탭의 stdout, stderr 링크. Stage 상세의 Task 표에도 링크가 있다 |
| 익스큐터(Standalone) | 각 워커의 work 디렉터리(기본 `SPARK_HOME/work`)에 Job마다 stdout과 stderr 파일 |

드라이버 로그에는 Job, Stage 이름과 스케줄링 정보, 드라이버 쪽 예외가 남습니다. Cluster Mode Overview의 용어표도 Job과 Stage를 "드라이버 로그에서 보게 될 용어"라고 소개합니다. 익스큐터 로그에는 Task 안에서 난 예외, GC, 셔플 fetch 실패 같은 익스큐터 쪽 사건이 남습니다. Task가 실패하면 드라이버 로그에는 요약이 남고 원인 스택은 익스큐터 로그에 있는 경우가 많습니다.

### 9-2. 설정과 남기기

안내서의 publish, customize를 문서의 설정에 대응시키면 이렇습니다.

| 목적 | 방법 | 기본값과 버전 |
|---|---|---|
| 로그 레벨 바꾸기(런타임) | `spark.sparkContext.setLogLevel("WARN")` | 유효 값 ALL, DEBUG, ERROR, FATAL, INFO, OFF, TRACE, WARN |
| 로그 레벨 바꾸기(시작 시) | `spark.log.level` | 없음, 3.5.0 |
| 형식과 출력 대상 | `conf/log4j2.properties`(템플릿 `log4j2.properties.template`) | 기본은 일반 텍스트 PatternLayout |
| 구조화(JSON) 로그 | `spark.log.structuredLogging.enabled` | false, 4.0.0부터 |
| client 모드 드라이버 로그를 영구 저장소로 | `spark.driver.log.persistToDfs.enabled` + `spark.driver.log.dfsDir` | false, 3.0.0 |
| 드라이버 로그 UI 탭 | `spark.driver.log.localDir` | 없음, 4.0.0 |
| 익스큐터 로그 롤링 | `spark.executor.logs.rolling.strategy` 등 | 기본 꺼짐 |
| 끝난 앱의 UI 보존 | `spark.eventLog.enabled` + History Server | false |

`setLogLevel`은 Spark Connect에서 `SparkContext`를 쓸 수 없어서 막힙니다. Connect 환경에서는 서버 쪽 설정으로 바꿔야 합니다.

구조화 로그는 4.0.0에서 생겨서 시험 기준 버전이 3.5라면 범위 밖일 수 있습니다. 문서는 JSON 로그를 Spark로 다시 읽는 방법도 줍니다.

```python
from pyspark.logger import SPARK_LOG_SCHEMA
log_df = spark.read.schema(SPARK_LOG_SCHEMA).json("/logs/spark")
log_df.filter(F.col("level") == "ERROR").show(truncate=False)
```

`level` 컬럼 이름은 스키마를 직접 확인하지 못해 실행할 때 `log_df.printSchema()`로 맞춰 보겠습니다.

## 10. 메모리 부족 진단

### 10-1. 드라이버인지 익스큐터인지

| | 드라이버 OOM | 익스큐터 OOM |
|---|---|---|
| 흔한 원인 | `collect()`, `toPandas()`, `take(큰 n)`로 결과를 모음. 큰 테이블 강제 broadcast | 쏠린 파티션, 너무 큰 파티션, 큰 그룹(`applyInPandas`, `collect_list`), 큰 캐시 |
| 어디서 보이나 | 드라이버 로그, 콘솔 | Stage 상세의 실패 Task, Executors 탭 로그, 익스큐터 손실(lost) 메시지 |
| 관련 설정 | `spark.driver.memory`(1g), `spark.driver.maxResultSize`(1g) | `spark.executor.memory`(1g), `spark.executor.memoryOverhead`, `spark.memory.fraction`(0.6) |
| 먼저 할 일 | 모으지 않는다. 필요한 만큼 `limit` 후 모으거나 파일로 쓴다 | 파티션 수를 늘리고 쏠림을 푼다. 그다음 메모리를 늘린다 |

`spark.driver.maxResultSize`는 액션 하나에서 모든 파티션 결과를 직렬화한 총합의 한도이고 넘으면 Job을 중단합니다. 문서는 이 한도를 너무 높이면 드라이버 OOM이 날 수 있고 적절한 한도가 드라이버를 보호한다고 적습니다. 그래서 `collect()`가 이 한도에 걸려 실패했다면 한도를 올리기 전에 정말 다 모아야 하는지부터 봅니다.

`toPandas()` 문서도 결과가 작을 때만 쓰라고 하고 모든 데이터를 드라이버 메모리로 올린다고 적습니다. Arrow를 켜도 모은다는 사실은 같습니다(Ch-06).

```python
# 드라이버로 다 모으는 코드
rows = orders.collect()                 # 위험
pdf = orders.toPandas()                 # 위험

# 필요한 만큼만
top = orders.orderBy(F.desc("amount")).limit(100).toPandas()

# 결과가 크면 파일로
orders.write.mode("overwrite").parquet("/out/orders_snapshot")
```

### 10-2. 익스큐터 메모리 구조

Tuning 가이드 기준입니다.

- 힙에서 300MiB를 뺀 공간의 `spark.memory.fraction`(기본 0.6)이 실행과 저장이 함께 쓰는 통합 영역 M입니다. 나머지 40%는 사용자 자료 구조, Spark 내부 메타데이터, 크고 드문 레코드로 인한 OOM 완충에 씁니다.
- M 안에서 `spark.memory.storageFraction`(기본 0.5)만큼은 캐시 블록이 실행 메모리에 밀려나지 않는 영역 R입니다.
- 실행은 필요하면 저장을 내쫓을 수 있지만 R 아래로는 못 내립니다. 저장은 실행을 내쫓지 못합니다.

같은 가이드의 "Memory Usage of Reduce Tasks"는 RDD 전체가 메모리에 들어가더라도 `groupByKey` 같은 reduce Task 하나의 작업 집합이 너무 커서 OOM이 나는 경우가 있다고 설명합니다. 가장 단순한 해결은 병렬도를 높여 Task당 입력을 줄이는 것이고 Spark는 200ms짜리 짧은 Task도 효율적으로 돌린다고 적습니다.

Python을 쓰면 힙 밖 메모리도 봐야 합니다. pandas UDF와 Python UDF는 익스큐터 옆의 Python 워커 프로세스에서 돕니다. `spark.executor.pyspark.memory`는 기본으로 설정되지 않아 Python 메모리에 상한이 없습니다. 컨테이너 한도는 `spark.executor.memoryOverhead`(기본 executorMemory × 0.10, 최소 384MiB, YARN과 Kubernetes)로 잡힙니다. 컨테이너가 메모리 초과로 죽으면 JVM 힙 OOM과 다른 메시지가 나오니 로그 문구를 보고 힙을 늘릴지 overhead를 늘릴지 정합니다.

### 10-3. 헷갈리는 지점

- `spark.driver.memory`는 드라이버 JVM이 뜬 뒤에는 바꿔도 효과가 없습니다. client 모드라면 `spark-submit --driver-memory`나 설정 파일로 시작할 때 줍니다. 노트북에서 `spark.conf.set`으로 바꾸는 보기는 오답입니다.
- 익스큐터 OOM을 메모리 증설로만 풀면 쏠린 키 하나가 그 메모리마저 넘길 때 다시 납니다. 4절의 진단이 먼저입니다.

## 11. 클러스터 저사용 진단

저사용은 코어는 놀고 있는데 Job이 오래 걸리는 상태입니다. Tuning 가이드는 연산마다 병렬도를 충분히 높이지 않으면 클러스터를 다 쓰지 못한다고 적습니다.

| 증상(UI에서) | 원인 후보 | 대응 |
|---|---|---|
| Stage의 Task 수가 전체 코어 수보다 적다 | 파티션이 적다. 큰 파일 하나, `coalesce(1)`, 셔플 파티션 수가 작다 | `repartition`, 셔플 파티션 수 조정, AQE 초기 파티션 수를 넉넉히 |
| Task 대부분은 끝났는데 몇 개만 남는다 | 쏠림 | 4절 |
| Task는 많은데 익스큐터 일부만 바쁘다 | 데이터 지역성 대기, 익스큐터별 코어 불균형 | Executors 탭의 Active Tasks와 Locality level 확인 |
| 짧은 Task가 수만 개 | 파티션이 너무 많다. 스케줄러 지연이 계산 시간보다 크다 | 파티션 줄이기, `parallelismFirst=false` 검토 |
| Job과 Job 사이가 비어 있다 | 드라이버 쪽 작업(`collect` 후 Python 루프, 파일 목록 조회) | 드라이버 로그와 타임라인 확인 |
| 익스큐터 수가 작업량과 맞지 않는다 | 고정 할당 | `spark.dynamicAllocation.enabled`(기본 false) 검토 |

기본값을 계산에 넣으면 이런 식입니다. 익스큐터 4개 × 4코어 = 16코어 클러스터에서 셔플 파티션이 8개로 나오면 한 번에 8코어만 일합니다. 반대로 200개면 코어마다 12~13번씩 Task가 돌아갑니다. 가이드의 코어당 2~3개 권고를 따르면 32~48개 근처입니다.

## 12. 확인 문제

시험 안내서 항목을 보고 직접 만든 문제입니다. 덤프나 문제 은행에서 가져온 것은 없습니다.

**문제 1.** 파티션 200개인 `orders`에 `orders.coalesce(500)`을 실행한 결과의 파티션 수는 몇 개입니까?

<details>
<summary>정답과 근거</summary>

200개입니다. `coalesce`는 좁은 의존성이라 늘리라고 하면 현재 파티션 수를 유지하고 오류를 내지 않습니다. 500개가 필요하면 셔플이 드는 `repartition(500)`을 씁니다.

</details>

**문제 2.** AQE 기본 설정에서 셔플 파티션의 중앙값이 20MB이고 한 파티션이 180MB입니다. skew join 최적화가 이 파티션을 쪼갭니까?

<details>
<summary>정답과 근거</summary>

쪼개지 않습니다. 배수 조건(중앙값 20MB × 5 = 100MB 초과)은 넘지만 `skewedPartitionThresholdInBytes` 256MB를 넘지 못합니다. 두 조건을 동시에 넘어야 쏠림으로 판정합니다. 또 이 최적화는 sort-merge 조인에만 적용됩니다.

</details>

**문제 3.** 다음 중 드라이버 메모리 부족을 일으킬 가능성이 가장 큰 코드는 무엇입니까?

- A. `orders.groupBy("store_id").count().write.parquet(path)`
- B. `orders.repartition(400)`
- C. `pdf = orders.toPandas()`
- D. `orders.filter("amount > 0").cache()`

<details>
<summary>정답과 근거</summary>

C입니다. `toPandas()`는 모든 데이터를 드라이버 메모리로 올립니다. A는 익스큐터가 파일로 씁니다. B와 D는 트랜스포메이션이라 액션이 오기 전에는 실행되지 않습니다. D의 캐시도 익스큐터 메모리를 씁니다.

</details>

**문제 4.** 작은 `customers`(3MB)와 큰 `orders`의 조인 계획에 `SortMergeJoin`이 나왔습니다. `spark.sql.autoBroadcastJoinThreshold`는 기본값입니다. 가능한 설명 두 가지와 코드로 broadcast를 강제하는 방법을 말해 보세요.

<details>
<summary>정답과 근거</summary>

자동 broadcast는 추정 크기로 판단하므로 통계가 없거나 틀려서 10MB를 넘는다고 추정했을 수 있습니다. 또는 앞 단계 필터 결과처럼 크기를 미리 알 수 없는 입력이었을 수 있고 이때는 AQE가 런타임에 broadcast로 바꿀 수 있습니다. 강제하려면 `orders.join(broadcast(customers), "customer_id")`나 `customers.hint("broadcast")`, SQL에서는 `/*+ BROADCAST(c) */`를 씁니다.

</details>

**문제 5.** 셔플 파티션 수를 200으로 두고 AQE를 켰는데 Stage의 Task가 7개만 돌았습니다. 왜 그럴 수 있습니까?

<details>
<summary>정답과 근거</summary>

AQE의 셔플 파티션 합치기가 작은 파티션을 합쳤기 때문입니다. `coalescePartitions.enabled`가 기본 true이고 `parallelismFirst`가 true여서 최소 크기 1MB를 기준으로 합칩니다. 셔플 데이터가 작으면 200개가 몇 개로 줄어듭니다.

</details>

**문제 6.** Job 하나가 평소보다 오래 걸립니다. 실패한 Task는 없습니다. 쏠림인지 확인하려면 Spark UI의 어디를 먼저 봅니까?

<details>
<summary>정답과 근거</summary>

오래 걸린 Stage의 상세 화면에서 Task Summary metrics의 Duration과 Shuffle Read Size가 중앙값 대비 최댓값이 얼마나 튀는지 봅니다. 같은 화면 Task 표에서 가장 오래 걸린 Task의 입력 크기와 익스큐터 로그를 확인합니다.

</details>

**문제 7.** 노트북에서 실행 중인 SparkSession에 `spark.conf.set("spark.driver.memory", "8g")`을 실행하면 드라이버 메모리가 늘어납니까?

<details>
<summary>정답과 근거</summary>

늘어나지 않습니다. 드라이버 메모리는 드라이버 JVM이 뜰 때 정해집니다. client 모드에서는 `spark-submit --driver-memory`나 기본 설정 파일처럼 시작 전에 줘야 합니다.

</details>

**문제 8.** 기본 설정에서 AQE가 sort-merge 조인을 shuffled hash 조인으로 바꿉니까?

<details>
<summary>정답과 근거</summary>

바꾸지 않습니다. 이 변환은 셔플 뒤 모든 파티션이 `spark.sql.adaptive.maxShuffledHashJoinLocalMapThreshold`보다 작을 때 일어나는데 기본값이 0입니다. 기본에서 일어나는 조인 변환은 broadcast hash 조인으로의 변환입니다.

</details>

## 13. 범위와 한계

- 설정 이름, 기본값, 버전은 2026년 10월 19일에 연 Spark 4.2.0 문서(Performance Tuning, Configuration, Tuning, Web UI, PySpark API)를 기준으로 했습니다. 시험 기준 버전이 공개되지 않아 3.5와 다를 수 있는 부분은 본문에 버전을 적었습니다.
- 이 글의 코드는 아직 실행하지 않았습니다. 이 노트북에 Java가 없어서 PySpark를 띄우지 못했습니다. `explain()` 출력 예시는 공식 문서 예제의 형태를 따라 적은 것이고 실제 출력은 다를 수 있습니다.
- 확인하지 못한 것을 따로 적습니다. salting은 공식 문서에서 찾지 못한 일반 기법입니다. `AdaptiveSparkPlan isFinalPlan` 표기, `PushedFilters`와 `ReadSchema` 필드, Summary metrics 표의 백분위 열, UI 포트가 4041로 올라가는 동작, broadcast 테이블이 드라이버를 거친다는 설명은 화면이나 문서 문장으로 확인하지 못했습니다.
- Databricks 런타임 고유의 기능(Photon, 자동 최적화 등)은 다루지 않았습니다. 시험 안내서는 Apache Spark 기준으로 씁니다.

## 참고 자료

공식 자료
- Databricks, [Exam Guide, Oct 2025](https://www.databricks.com/sites/default/files/2025-10/databricks-certified-associate-developer-apache-spark-exam-guide-oct-2025.pdf) (4영역 항목과 샘플 문항 2, 5)
- Apache Spark 4.2.0, [Performance Tuning](https://spark.apache.org/docs/latest/sql-performance-tuning.html) (AQE, 조인 힌트, 파티셔닝 힌트, 파일 파티션 설정)
- Apache Spark 4.2.0, [Tuning Spark](https://spark.apache.org/docs/latest/tuning.html) (Memory Management Overview, Level of Parallelism, Memory Usage of Reduce Tasks)
- Apache Spark 4.2.0, [Spark Configuration](https://spark.apache.org/docs/latest/configuration.html) (드라이버·익스큐터 메모리, 로그, 필터 푸시다운 설정, Configuring Logging)
- Apache Spark 4.2.0, [Web UI](https://spark.apache.org/docs/latest/web-ui.html)
- Apache Spark 4.2.0, [Monitoring and Instrumentation](https://spark.apache.org/docs/latest/monitoring.html)
- Apache Spark 4.2.0, [Cluster Mode Overview](https://spark.apache.org/docs/latest/cluster-overview.html), [Spark Standalone Mode](https://spark.apache.org/docs/latest/spark-standalone.html) (워커 work 디렉터리 로그)
- Apache Spark 4.2.0, [EXPLAIN](https://spark.apache.org/docs/latest/sql-ref-syntax-qry-explain.html)
- PySpark 4.2.0 API: [DataFrame.repartition](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.repartition.html), [DataFrame.coalesce](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.coalesce.html), [DataFrame.explain](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.explain.html), [DataFrame.toPandas](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.toPandas.html), [functions.broadcast](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.functions.broadcast.html)

이 시리즈
- [Spark Ch-00: 시험 구조와 공부 계획](/blog/cert/spark/spark-00-exam-and-study-plan)

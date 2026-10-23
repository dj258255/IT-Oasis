---
title: '[Spark Ch-00b] 위에서 내려다보는 Spark: 코드 한 줄이 결과 20행이 되기까지'
description: 쇼핑몰 주문 데이터에 groupBy와 count를 거는 코드 한 줄을 골라 SparkSession, 논리 계획, Catalyst, 물리 계획과 AQE, Job, Stage, Task, 익스큐터까지 위에서부터 따라 내려갑니다. 층마다 시험이 무엇을 묻는지와 어느 챕터에서 깊게 다루는지 연결하고 Structured Streaming, Spark Connect, pandas API가 이 그림 어디에 붙는지 정리합니다.
date: 2026-10-23T00:00:00.000Z
tags:
  - Spark
  - Databricks
  - PySpark
  - Certification
  - Catalyst
  - AQE
category: cert/Spark
topics:
  - cert
draft: false
series: "Spark 공부"
seriesOrder: 0.5
---

## 결론부터

1. 이 시리즈의 Ch-01~06은 시험 영역 순서로 나뉘어 있습니다. 영역 순서대로 읽으면 각 편은 꼼꼼해도 서로 어디서 이어지는지가 잘 안 보입니다. 그래서 코드 한 줄을 골라 위에서 아래로 따라가는 지도를 먼저 둡니다.
2. 따라갈 코드는 `spark.read.parquet("orders").groupBy("category").count().show()`입니다. 이 한 줄이 SparkSession, 논리 계획, Catalyst, 물리 계획과 AQE, Job, Stage, Task, 익스큐터를 전부 지나갑니다.
3. 층마다 시험이 묻는 것은 거의 "기본값"과 "언제 일어나는가"입니다. 트랜스포메이션은 언제 실행되는지, Stage는 어디서 잘리는지, 셔플 파티션은 기본 몇 개인지, AQE는 기본으로 켜져 있는지 같은 질문입니다.
4. Structured Streaming, Spark Connect, pandas API on Spark는 엔진을 따로 두지 않습니다. 같은 계획과 실행 경로의 입구나 반복 방식만 바꿉니다. 이 셋을 마지막에 붙이면 시험 범위 전체가 한 장의 그림에 들어옵니다.

---

## 1. 왜 위에서부터 보는가

Ch-01을 처음 쓸 때는 시험 안내서 항목 순서를 그대로 따랐습니다. 장점과 과제, 드라이버와 익스큐터, DataFrame과 Dataset, SparkSession, 캐시, GC, 실행 계층, 파티션과 셔플, 지연 평가 순서입니다. 항목을 빠짐없이 덮기에는 좋았는데 다시 읽어 보니 "지연 평가"를 9절에서야 설명하면서 7절의 Job과 Stage가 그 결과라는 점이 뒤늦게 나옵니다. 읽는 사람은 7절에서 이미 "액션이 뭔데 Job을 만들지?"라는 질문을 안고 있습니다.

탑다운으로 보면 순서가 바뀝니다. 먼저 결과를 하나 정하고 그 결과가 나오기까지 무슨 일이 있었는지를 한 층씩 벗겨 냅니다. 층을 내려갈 때마다 "여기서 시험이 묻는 것"과 "여기서 실제로 생기는 문제"를 붙여 두면 각 챕터가 어느 층을 깊게 판 글인지가 보입니다.

이 글은 지도만 그립니다. 정의와 기본값의 근거, 코드 재현은 각 챕터 링크로 넘깁니다.

## 2. 출발점: 코드 한 줄과 결과 20행

쇼핑몰 주문이 Parquet 파일로 쌓여 있다고 둡니다. 컬럼은 `order_id`, `category`, `amount`, `status`, `order_date` 정도입니다. 카테고리별 주문 수를 보고 싶어서 이렇게 씁니다.

```python
from pyspark.sql import SparkSession

spark = SparkSession.builder.appName("orders-map").getOrCreate()

(spark.read.parquet("data/orders")
      .groupBy("category")
      .count()
      .show())
```

```text
+--------+-----+
|category|count|
+--------+-----+
|    의류|    3|
|    식품|    3|
|    가전|    3|
+--------+-----+
```

위 출력은 그림 3절의 작은 예시에 맞춰 적은 모양이고 실행 결과를 붙인 것이 아닙니다. 행 순서도 실행마다 다를 수 있습니다. `groupBy` 결과에는 정렬이 없기 때문입니다. 제목의 "20행"은 `show()`가 기본으로 찍는 최대 행 수이고 이 예는 카테고리가 셋이라 세 줄만 나옵니다.

이 한 줄을 위에서부터 벗기면 아래 그림의 아홉 층이 나옵니다. 오른쪽 칸은 그 층을 깊게 다룬 챕터입니다.

![코드 한 줄이 결과가 되기까지 아홉 층. SparkSession과 드라이버, 논리 계획, Catalyst 최적화, 물리 계획과 AQE, Job, Stage와 셔플, Task, 익스큐터와 파티션, 결과 20행 순서로 내려가고 각 층 오른쪽에 깊게 다룬 챕터 번호가 붙어 있다](/uploads/cert/spark-map/layers.svg)

## 3. 층별로 내려가기

### 3-1. SparkSession과 드라이버: 코드를 받는 쪽

`SparkSession.builder.getOrCreate()`가 이 프로그램의 입구입니다. 클래식 PySpark에서는 이 줄이 같은 머신에 드라이버 JVM을 띄우고 Python은 Py4J로 그 JVM을 부릅니다. 드라이버는 계획을 세우고 Task를 나눠 주는 쪽이고 실제 데이터를 계산하는 쪽은 익스큐터입니다.

Spark 공식 문서의 Cluster Mode Overview에 이 관계를 그린 그림이 있습니다.

![Spark 공식 문서의 클러스터 개요 그림. 드라이버 프로그램의 SparkContext가 클러스터 매니저를 거쳐 워커 노드의 익스큐터에 Task를 보내고 익스큐터 안에 캐시가 있다](/uploads/cert/spark-map/cluster-overview.png)

그림 출처: [Apache Spark, Cluster Mode Overview](https://spark.apache.org/docs/latest/cluster-overview.html), Apache License 2.0.

| 시험이 묻는 것 | 여기서 생기는 문제 | 깊게 보는 곳 |
|---|---|---|
| 드라이버, 익스큐터, 코어, 메모리의 역할 / `getOrCreate`가 기존 세션을 돌려주는지 / client, cluster, local 배포 모드 | `collect()`로 큰 결과를 받다가 드라이버 메모리 부족 | [Ch-01 2-1절](/blog/cert/spark/spark-01-architecture#2-1-구성-요소의-역할), [Ch-01 4절](/blog/cert/spark/spark-01-architecture#4-sparksession-수명-주기), [Ch-06 5절](/blog/cert/spark/spark-06-connect-pandas-api#5-배포-모드와-master-url) |

### 3-2. 논리 계획: 아직 아무것도 돌지 않는다

`groupBy`와 `count`는 트랜스포메이션이고 `read.parquet`는 계획의 시작점(어떤 파일을 읽을지)을 만듭니다. 이 셋을 부르는 동안에는 행 데이터를 한 줄도 계산하지 않고 "무엇을 할지"를 적은 트리만 자랍니다. 다만 `read.parquet`는 스키마를 알아내려고 파일 목록과 Parquet 파일 끝의 메타데이터(footer)를 그 줄에서 바로 읽기 때문에 Spark UI에 짧은 Job이 찍힐 수 있습니다. 여기서 `count()`가 헷갈립니다. `df.count()`는 숫자를 돌려주는 액션인데 `groupBy(...).count()`는 `count` 컬럼이 붙은 새 DataFrame을 돌려주는 트랜스포메이션입니다. 이 코드에서 액션은 맨 끝의 `show()` 하나입니다.

클래식 PySpark는 DataFrame을 만드는 순간 분석까지는 바로 합니다. 그래서 `groupBy("categroy")`처럼 컬럼 이름을 틀리면 그 줄에서 `AnalysisException`이 납니다. Spark Connect는 분석을 서버로 미루니 오류가 나는 줄이 달라집니다(5절).

| 시험이 묻는 것 | 여기서 생기는 문제 | 깊게 보는 곳 |
|---|---|---|
| 트랜스포메이션과 액션 구분 / 지연 평가 / `explain()`은 Job을 만드는지 | 오류가 트랜스포메이션 줄과 액션 줄 중 어디서 나는지 | [Ch-01 9-1절](/blog/cert/spark/spark-01-architecture#9-1-지연-평가), [Ch-01 7절](/blog/cert/spark/spark-01-architecture#7-실행-계층-job-stage-task와-dag) |

### 3-3. Catalyst: 계획을 다듬는다

`show()`가 불리면 드라이버가 쌓인 트리를 꺼내 Catalyst 최적화기에 넘깁니다. 분석, 논리 최적화, 물리 계획, 코드 생성 순서입니다. 이 예제에서 눈에 띄는 최적화는 두 가지입니다.

- **컬럼 가지치기**: 주문 파일에 컬럼이 다섯 개 있어도 쓰는 것은 `category` 하나입니다. Parquet는 컬럼 단위로 저장하니 `category` 컬럼만 읽습니다. `explain()`의 `ReadSchema`에 `struct<category:string>`만 보이면 가지치기가 된 것입니다.
- **부분 집계**: 셔플 전에 파티션 안에서 먼저 셉니다. 셔플로 보내는 것이 주문 한 건씩이 아니고 "파티션 0의 의류 2건" 같은 중간 합계가 됩니다.

필터가 있었다면 필터를 읽기 쪽으로 당기는 푸시다운도 여기서 일어납니다. Databricks가 Catalyst를 소개한 글([Deep Dive into Spark SQL's Catalyst Optimizer](https://www.databricks.com/blog/2015/04/13/deep-dive-into-spark-sqls-catalyst-optimizer.html))에 단계 그림이 있으니 같이 보면 좋습니다.

| 시험이 묻는 것 | 여기서 생기는 문제 | 깊게 보는 곳 |
|---|---|---|
| `explain()` 모드와 출력 읽기 / 필터 푸시다운과 컬럼 가지치기 | UDF를 쓰면 Catalyst가 안을 못 봐서 푸시다운이 끊김 | [Ch-01 9-1절](/blog/cert/spark/spark-01-architecture#9-1-지연-평가), [Ch-04 7절](/blog/cert/spark/spark-04-troubleshooting-tuning#7-explain으로-계획-읽기), [Ch-04 5절](/blog/cert/spark/spark-04-troubleshooting-tuning#5-셔플-줄이기) |

### 3-4. 물리 계획과 AQE: 셔플 자리가 정해진다

물리 계획을 `explain()`으로 찍으면 대략 이런 모양이 나옵니다. 연산자 이름과 순서만 남기고 줄였습니다.

```text
AdaptiveSparkPlan isFinalPlan=false
+- HashAggregate(keys=[category], functions=[count(1)])
   +- Exchange hashpartitioning(category, 200)
      +- HashAggregate(keys=[category], functions=[partial_count(1)])
         +- FileScan parquet [category] ReadSchema: struct<category:string>
```

아래에서 위로 읽습니다. 파일을 읽고(`FileScan`) 파티션 안에서 부분 count를 하고(`partial_count`) `Exchange`에서 `category` 기준으로 다시 나눈 뒤 최종 count를 합니다. `Exchange`가 셔플이고 숫자 200은 `spark.sql.shuffle.partitions` 기본값입니다.

맨 위의 `AdaptiveSparkPlan isFinalPlan=false`는 AQE가 켜져 있다는 표시입니다. AQE는 Spark 3.2.0부터 기본으로 켜져 있고 셔플이 끝난 뒤 실제 크기를 보고 남은 계획을 고칩니다. 이 예제처럼 카테고리가 몇 개뿐이면 200개 셔플 파티션 대부분이 비어 있을 테니 AQE가 작은 파티션을 합칩니다. Databricks 블로그의 [Adaptive Query Execution 소개 글](https://www.databricks.com/blog/2020/05/29/adaptive-query-execution-speeding-up-spark-sql-at-runtime.html)에 파티션 합치기 전후를 그린 그림이 있습니다.

| 시험이 묻는 것 | 여기서 생기는 문제 | 깊게 보는 곳 |
|---|---|---|
| `spark.sql.shuffle.partitions` 기본 200 / AQE 세 기능(파티션 합치기, 조인 전략 바꾸기, skew join) / broadcast 조인 | 작은 Task 수백 개, 한 파티션에 몰린 데이터 | [Ch-04 6절](/blog/cert/spark/spark-04-troubleshooting-tuning#6-aqe), [Ch-04 4절](/blog/cert/spark/spark-04-troubleshooting-tuning#4-데이터-쏠림), [Ch-03 5-3절](/blog/cert/spark/spark-03-dataframe-api#5-3-broadcast-조인) |

### 3-5. Job: 액션이 만든다

물리 계획이 정해지면 그것을 실행하는 Job이 생깁니다. Job을 만드는 것은 액션이고 이 코드에서는 `show()`입니다. `show()`는 기본 20행만 보여 주니 내부에서 행 수를 제한해 가져옵니다.

Job이 정확히 하나라고 단정하지는 않겠습니다. 행 수 제한이 붙은 수집은 앞쪽 파티션부터 조금씩 읽다가 모자라면 더 읽는 방식이라 Job이 둘 이상 찍힐 수 있고 AQE도 스테이지를 나눠 실행합니다. Ch-01 7절에서 적은 것처럼 개념 구조와 실제 Job 수는 Spark UI로 확인해야 합니다.

| 시험이 묻는 것 | 여기서 생기는 문제 | 깊게 보는 곳 |
|---|---|---|
| 어떤 메서드가 액션인지 / `show`, `take`, `collect`, `count`의 차이 | 같은 DataFrame에 액션을 여러 번 걸어 매번 처음부터 다시 계산 | [Ch-01 9-3절](/blog/cert/spark/spark-01-architecture#9-3-액션-목록), [Ch-01 5절](/blog/cert/spark/spark-01-architecture#5-캐시와-저장-레벨), [Ch-03 8-2절](/blog/cert/spark/spark-03-dataframe-api#8-2-드라이버로-가져오기) |

### 3-6. Stage: 셔플에서 잘린다

드라이버의 DAG 스케줄러는 Job을 셔플 경계에서 Stage로 자릅니다. 이 예제에는 셔플이 하나뿐이니 Stage가 둘입니다. 앞 Stage는 읽기와 부분 집계를 하고 셔플 파일을 씁니다. 뒤 Stage는 셔플 파일을 읽어 최종 집계를 합니다.

![groupBy count가 Stage 둘로 잘리는 모양. 입력 파티션 세 개가 각각 부분 count를 하고 셔플에서 category 기준으로 다시 나뉘어 의류, 식품, 가전 최종 count가 되고 드라이버로 모인다](/uploads/cert/spark-map/stages.svg)

그림은 셔플 파티션을 세 개로 줄여 그렸습니다. 실제로는 200개에서 시작하고 AQE가 합칩니다.

여기서 시험이 자주 꼬는 것은 "Stage 경계는 액션 수와 무관하다"는 점입니다. 셔플이 없는 Job은 Stage가 하나이고 셔플이 둘이면 Stage가 셋입니다.

| 시험이 묻는 것 | 여기서 생기는 문제 | 깊게 보는 곳 |
|---|---|---|
| 좁은 변환과 넓은 변환 / 셔플을 일으키는 연산 / `repartition`과 `coalesce` | 셔플이 커서 디스크와 네트워크가 막힘 | [Ch-01 7절](/blog/cert/spark/spark-01-architecture#7-실행-계층-job-stage-task와-dag), [Ch-01 8-2절](/blog/cert/spark/spark-01-architecture#8-2-셔플이란), [Ch-04 3절](/blog/cert/spark/spark-04-troubleshooting-tuning#3-repartition과-coalesce) |

### 3-7. Task: 파티션 하나에 하나

Stage마다 파티션 수만큼 Task가 생깁니다. 앞 Stage의 Task 수는 입력 파티션 수이고 뒤 Stage의 Task 수는 셔플 파티션 수입니다. 같은 Stage의 Task는 코드가 같고 맡은 파티션만 다릅니다.

동시에 몇 개가 도는지는 익스큐터 코어 수가 정합니다. 코어가 8개인데 Task가 200개면 8개씩 25번에 걸쳐 돕니다. 실패한 Task는 다시 시도하고 같은 Task가 `spark.task.maxFailures`(기본 4)번 실패하면 Job이 실패합니다.

| 시험이 묻는 것 | 여기서 생기는 문제 | 깊게 보는 곳 |
|---|---|---|
| 파티션 수가 정해지는 자리 / 코어와 동시 Task 수 | Task가 너무 잘거나 너무 커서 클러스터가 놀거나 터짐 | [Ch-01 2-3절](/blog/cert/spark/spark-01-architecture#2-3-코어와-동시에-도는-task-수), [Ch-01 8-1절](/blog/cert/spark/spark-01-architecture#8-1-파티션-수가-정해지는-자리), [Ch-04 2절](/blog/cert/spark/spark-04-troubleshooting-tuning#2-파티션-수가-정해지는-세-지점) |

### 3-8. 익스큐터와 파티션: 실제로 도는 곳

Task는 익스큐터의 빈 코어에서 돕니다. 실제로 문제가 터지는 곳도 대부분 여기입니다. "의류" 주문이 전체의 90%라면 셔플 뒤 "의류" 파티션을 맡은 Task 하나만 오래 걸립니다. Spark UI의 Stages 탭에서 Task 시간 분포의 최댓값이 중앙값보다 훨씬 크면 쏠림을 의심합니다. 메모리가 모자라면 익스큐터 로그에 OOM이 남고 드라이버 쪽인지 익스큐터 쪽인지에 따라 손볼 곳이 다릅니다.

| 시험이 묻는 것 | 여기서 생기는 문제 | 깊게 보는 곳 |
|---|---|---|
| 익스큐터 메모리 구조 / 캐시 저장 레벨 / Spark UI 탭과 로그 위치 | 데이터 쏠림, 메모리 부족, 클러스터 저사용 | [Ch-01 2-4절](/blog/cert/spark/spark-01-architecture#2-4-메모리-구조), [Ch-04 8절](/blog/cert/spark/spark-04-troubleshooting-tuning#8-spark-ui-탭), [Ch-04 10절](/blog/cert/spark/spark-04-troubleshooting-tuning#10-메모리-부족-진단) |

### 3-9. 결과: 드라이버로 돌아온다

뒤 Stage의 Task들이 낸 결과가 드라이버로 모이고 `show()`가 표로 찍습니다. 기본은 20행이고 문자열은 20자에서 자릅니다. 결과가 작으니 여기서는 문제가 없지만 `show()` 대신 `collect()`를 큰 결과에 걸면 전부 드라이버 메모리로 들어옵니다.

결과를 화면에 찍는 대신 파일이나 테이블로 쓰는 쪽이 Ch-02의 영역입니다. `write`의 저장 모드 기본값이 `errorifexists`라는 것처럼 쓰기 쪽 기본값도 시험에 나옵니다.

| 시험이 묻는 것 | 여기서 생기는 문제 | 깊게 보는 곳 |
|---|---|---|
| `show`의 기본 인자 / 저장 모드 기본값 / `partitionBy`와 `bucketBy` | `collect()`로 드라이버 OOM, 의도치 않은 덮어쓰기 | [Ch-03 8-2절](/blog/cert/spark/spark-03-dataframe-api#8-2-드라이버로-가져오기), [Ch-02 3절](/blog/cert/spark/spark-02-spark-sql#3-저장-모드), [Ch-02 4절](/blog/cert/spark/spark-02-spark-sql#4-영구-테이블-partitionby-bucketby-sortby) |

## 4. 같은 길을 SQL로 들어와도 똑같다

같은 집계를 SQL로 써도 길은 같습니다.

```python
spark.read.parquet("data/orders").createOrReplaceTempView("orders")
spark.sql("SELECT category, count(*) AS count FROM orders GROUP BY category").show()
```

SQL 문자열은 파서를 거쳐 미해석 논리 계획이 되고 그 뒤로는 3-3절부터 똑같이 내려갑니다. 그래서 시험의 Spark SQL 영역(20%)과 DataFrame API 영역(30%)은 입구만 다르고 아래 층을 공유합니다. 영역을 따로 공부해도 `explain()`을 찍어 보면 같은 계획이 나오는지 확인할 수 있습니다.

## 5. Streaming, Connect, pandas API는 어디에 붙나

여기까지가 배치 한 번의 경로입니다. 시험 범위의 나머지 세 영역은 이 경로의 입구나 반복 방식을 바꿉니다.

![Streaming, Connect, pandas API가 붙는 자리. Spark Connect와 pandas API는 DataFrame 연산 쪽 입구에 붙고 pandas UDF는 익스큐터 실행에도 닿는다. Structured Streaming은 Catalyst부터 Task까지의 과정을 마이크로배치마다 반복한다](/uploads/cert/spark-map/attach.svg)

| 영역 | 이 그림에서 바뀌는 곳 | 시험이 묻는 것 | 깊게 보는 곳 |
|---|---|---|---|
| Structured Streaming (10%) | 입력을 계속 늘어나는 표로 보고 마이크로배치마다 위 경로를 한 번씩 돌립니다. 배치 사이를 잇는 상태, 워터마크, 체크포인트가 더해집니다. 스트리밍 쿼리에는 AQE가 적용되지 않습니다 | 출력 모드, 트리거, 워터마크와 중복 제거, exactly-once 조건 | [Ch-05 2절](/blog/cert/spark/spark-05-structured-streaming#2-엔진과-프로그래밍-모델), [Ch-05 10절](/blog/cert/spark/spark-05-structured-streaming#10-워터마크와-늦은-데이터) |
| Spark Connect (5%) | 3-1절의 드라이버와 Python이 떨어집니다. 클라이언트는 해석 전 계획을 gRPC로 보내고 결과를 Arrow 배치로 받습니다. 그래서 3-2절의 컬럼 이름 오류가 나는 줄이 뒤로 밀립니다 | 특징, 배포 모드, RDD와 `SparkContext`를 못 쓰는 이유 | [Ch-06 2절](/blog/cert/spark/spark-06-connect-pandas-api#2-spark-connect의-구조) |
| pandas API on Spark (5%) | pandas 문법으로 쓰지만 아래는 Spark DataFrame이라 3-2절부터 똑같이 갑니다. pandas UDF는 익스큐터에서 Python 함수를 Arrow로 돌립니다 | 장점, 기본 인덱스, pandas UDF 만들고 부르기 | [Ch-06 6절](/blog/cert/spark/spark-06-connect-pandas-api#6-pandas-api-on-spark의-장점), [Ch-06 10절](/blog/cert/spark/spark-06-connect-pandas-api#10-pandas-udf) |

공식 문서로는 [Structured Streaming Programming Guide](https://spark.apache.org/docs/latest/structured-streaming-programming-guide.html), [Spark Connect Overview](https://spark.apache.org/docs/latest/spark-connect-overview.html), [pandas API on Spark 사용자 가이드](https://spark.apache.org/docs/latest/api/python/user_guide/pandas_on_spark/index.html)가 각 영역의 출발점입니다.

## 6. 시험 영역과 챕터 대응

비중은 [Ch-00 2절](/blog/cert/spark/spark-00-exam-and-study-plan#2-영역과-출제-항목)의 공식 안내서 기준입니다.

| 영역 | 비중 | 이 지도에서의 층 | 챕터 |
|---|---|---|---|
| 아키텍처와 구성 요소 | 20% | 3-1 ~ 3-8 전체의 뼈대 | [Ch-01](/blog/cert/spark/spark-01-architecture) |
| Spark SQL | 20% | 4절의 SQL 입구, 3-9의 쓰기 | [Ch-02](/blog/cert/spark/spark-02-spark-sql) |
| DataFrame/Dataset API | 30% | 3-2의 트랜스포메이션들, 3-5의 액션 | [Ch-03](/blog/cert/spark/spark-03-dataframe-api) |
| 문제 해결과 튜닝 | 10% | 3-4 AQE, 3-6 셔플, 3-8 익스큐터 | [Ch-04](/blog/cert/spark/spark-04-troubleshooting-tuning) |
| Structured Streaming | 10% | 5절, 경로의 반복 | [Ch-05](/blog/cert/spark/spark-05-structured-streaming) |
| Spark Connect | 5% | 5절, 3-1의 입구 분리 | [Ch-06](/blog/cert/spark/spark-06-connect-pandas-api) |
| pandas API on Spark | 5% | 5절, 3-2의 다른 문법 | [Ch-06](/blog/cert/spark/spark-06-connect-pandas-api) |

DataFrame API가 30%로 가장 크지만 그 문제들도 결국 "이 메서드가 트랜스포메이션인가 액션인가, 셔플을 일으키는가, 기본값이 무엇인가"를 묻습니다. 위 지도의 층 이름을 먼저 머리에 넣어 두면 메서드 하나를 외울 때마다 어느 층에 걸어 둘지가 정해집니다.

## 7. 추천 읽기 순서

1. **이 글**: 아홉 층의 이름과 순서만 익힙니다.
2. **Ch-01의 척추 세 절**: [9-1 지연 평가](/blog/cert/spark/spark-01-architecture#9-1-지연-평가) → [7 실행 계층](/blog/cert/spark/spark-01-architecture#7-실행-계층-job-stage-task와-dag) → [8 파티션과 셔플](/blog/cert/spark/spark-01-architecture#8-파티션과-셔플) 순서로 먼저 읽고 나머지 절을 읽습니다. 3-2, 3-6, 3-7절의 근거가 여기 있습니다.
3. **Ch-03 DataFrame API**: 비중이 가장 크니 일찍 손에 익힙니다. 메서드마다 3-2(트랜스포메이션)인지 3-5(액션)인지 표시하며 읽습니다.
4. **Ch-02 Spark SQL**: 4절처럼 같은 길의 다른 입구라는 생각으로 읽고 쓰기 쪽 기본값을 외웁니다.
5. **Ch-04 튜닝**: 3-4, 3-6, 3-8절의 "여기서 생기는 문제" 칸을 실제로 재현해 봅니다.
6. **Ch-05, Ch-06**: 5절 그림의 세 상자를 하나씩 엽니다.
7. **Ch-07**: 시험 직전 기본값 체크리스트와 당일 전략을 봅니다.

[Ch-00](/blog/cert/spark/spark-00-exam-and-study-plan)의 공부 계획 표는 영역 단위로 일정을 짠 것이고 이 순서는 그 안에서 읽는 순서입니다. 둘은 겹쳐 쓸 수 있습니다.

## 8. 범위와 한계

- 2절과 3-4절의 출력은 모양을 보이려고 적은 것입니다. 로컬에서 실행해 붙인 결과가 아니고 실제 `explain()` 출력에는 연산자마다 번호, 파티션 정보, 파일 경로 같은 내용이 더 붙습니다.
- 3-5절의 Job 수는 Spark 버전, AQE 설정, 결과 크기에 따라 달라집니다. 이 글은 개념 구조만 그렸습니다.
- 층마다 붙인 "시험이 묻는 것"은 공식 안내서 항목을 층에 배치한 것이고 실제 출제 비율을 층별로 나눈 자료는 없습니다.
- Spark Connect와 Classic의 오류 시점 차이는 4.x 문서 기준입니다. 버전별 세부 차이는 Ch-06에 정리했습니다.

## 참고 자료

- [Apache Spark, Cluster Mode Overview](https://spark.apache.org/docs/latest/cluster-overview.html) (클러스터 개요 그림 출처, Apache License 2.0)
- [Apache Spark, Performance Tuning (AQE)](https://spark.apache.org/docs/latest/sql-performance-tuning.html)
- [Apache Spark, Web UI](https://spark.apache.org/docs/latest/web-ui.html)
- [Apache Spark, Structured Streaming Programming Guide](https://spark.apache.org/docs/latest/structured-streaming-programming-guide.html)
- [Apache Spark, Spark Connect Overview](https://spark.apache.org/docs/latest/spark-connect-overview.html)
- [Apache Spark, pandas API on Spark User Guide](https://spark.apache.org/docs/latest/api/python/user_guide/pandas_on_spark/index.html)
- [Databricks, Deep Dive into Spark SQL's Catalyst Optimizer](https://www.databricks.com/blog/2015/04/13/deep-dive-into-spark-sqls-catalyst-optimizer.html)
- [Databricks, Adaptive Query Execution: Speeding Up Spark SQL at Runtime](https://www.databricks.com/blog/2020/05/29/adaptive-query-execution-speeding-up-spark-sql-at-runtime.html)
- 이 글의 손그림 세 장(`layers.svg`, `stages.svg`, `attach.svg`)은 직접 그렸습니다.

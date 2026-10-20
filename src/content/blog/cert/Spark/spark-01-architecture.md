---
title: '[Spark Ch-01] Spark 아키텍처와 구성 요소: 액션 하나가 Job, Stage, Task로 나뉘는 과정'
description: Databricks Spark 자격증 1영역(아키텍처와 구성 요소, 20%)을 시험 안내서의 항목 순서대로 정리합니다. 드라이버와 익스큐터의 역할, 메모리 구조, 캐시 저장 레벨, GC, 실행 계층, 셔플과 파티션, 지연 평가를 Spark 4.2.0 공식 문서의 기본값과 함께 확인하고, 3.x와 달라진 동작을 표시합니다.
date: 2026-10-19T00:00:00.000Z
tags:
  - Spark
  - Databricks
  - PySpark
  - Certification
  - Architecture
category: cert/Spark
topics:
  - cert
draft: false
series: "Spark 공부"
seriesOrder: 1
---

## 결론부터

1. Spark 애플리케이션은 드라이버 하나와 익스큐터 여러 개로 이뤄집니다. 드라이버가 작업을 Task로 쪼개 보냅니다. 익스큐터는 Task를 실행하고 캐시 데이터를 들고 있습니다. 익스큐터는 애플리케이션마다 따로 뜨기 때문에 애플리케이션끼리 데이터를 직접 나눌 수 없습니다.
2. 실행 계층은 액션 하나가 Job 하나, Job은 셔플 경계에서 Stage로, Stage는 파티션마다 Task 하나로 나뉩니다. 트랜스포메이션은 지연 평가되므로 액션이 불릴 때까지 아무 일도 하지 않습니다.
3. DataFrame `cache()`의 기본 저장 레벨은 `MEMORY_AND_DISK_DESER`이고 RDD `cache()`는 `MEMORY_ONLY`입니다. `spark.catalog.cacheTable()`의 기본값은 문서에 `MEMORY_AND_DISK`로 적혀 있습니다. 셋이 서로 달라서 시험에서 헷갈리기 좋습니다.
4. 셔플 후 파티션 수는 `spark.sql.shuffle.partitions`(기본 200)가 정하고 파일을 읽을 때의 파티션 크기는 `spark.sql.files.maxPartitionBytes`(기본 128MB)가 정합니다. `coalesce`는 셔플 없이 줄이기만 하고 `repartition`은 전체 셔플을 일으킵니다.
5. 익스큐터 힙에서 300MiB를 뺀 나머지의 60%(`spark.memory.fraction`)가 실행과 저장이 함께 쓰는 통합 영역이고 그 절반(`spark.memory.storageFraction`)은 캐시가 밀려나지 않는 구간입니다. Spark 4.0부터는 JDK 17이 기본이라 G1GC가 기본 수집기입니다.

---

시험 안내서(2025년 10월판) 1영역의 항목은 일곱 개입니다. 이 글은 그 순서를 그대로 목차로 씁니다.

| 안내서 항목 | 이 글 |
|---|---|
| Spark 도입의 장점과 어려운 점 | 1절 |
| 클러스터, 드라이버, 워커 노드와 익스큐터, CPU 코어, 메모리의 역할 | 2절 |
| DataFrame과 Dataset, SparkSession 수명 주기, 캐시, 저장 레벨, GC | 3~6절 |
| 실행 계층 | 7절 |
| 파티셔닝 설정(셔플과 파티션) | 8절 |
| 액션, 트랜스포메이션, 지연 평가 | 9절 |
| 모듈(Core, Spark SQL, DataFrames, pandas API on Spark, Structured Streaming, MLlib) | 10절 |

예제는 쇼핑몰 주문 데이터 하나로 통일합니다. 모든 절의 코드가 아래 `orders`를 씁니다.

```python
from pyspark.sql import SparkSession
from pyspark.sql import functions as F

spark = (SparkSession.builder
         .master("local[4]")          # 로컬 스레드 4개
         .appName("ch01-architecture")
         .getOrCreate())

orders = spark.createDataFrame(
    [
        (1, 101, "PAID",     32000, "2026-10-01"),
        (2, 102, "PAID",     15000, "2026-10-01"),
        (3, 101, "CANCELED",  8000, "2026-10-02"),
        (4, 103, "PAID",     54000, "2026-10-02"),
        (5, 102, "REFUNDED", 15000, "2026-10-03"),
    ],
    "order_id INT, user_id INT, status STRING, amount INT, order_date STRING",
)
```

## 1. Spark의 장점과 어려운 점

Spark 공식 홈페이지는 Spark를 "Unified engine for large-scale data analytics"라고 소개합니다. 문서 첫 페이지는 Java, Scala, Python, R로 쓰는 고수준 API와 일반적인 실행 그래프를 돌리는 최적화 엔진을 제공한다고 적습니다. 시험에서 장점을 고르라고 하면 아래 여섯 가지가 문서 근거가 있는 답입니다.

| 장점 | 문서 근거 |
|---|---|
| 배치와 스트리밍을 한 엔진으로 처리 | 홈페이지 "Batch/streaming data" 항목, Structured Streaming이 DataFrame API를 그대로 씀 |
| 여러 언어와 SQL을 같은 엔진에서 실행 | SQL 가이드: 어떤 API와 언어로 표현하든 같은 실행 엔진을 쓴다 |
| 노트북에서 쓴 코드를 수천 대 클러스터로 확장 | 홈페이지 "Machine learning" 항목 |
| 장애 시 재계산으로 복구 | RDD 가이드: 모든 저장 레벨은 잃어버린 데이터를 다시 계산해 장애를 견딘다 |
| 반복해서 쓰는 데이터를 메모리에 캐시 | RDD 가이드: 캐시는 반복 알고리즘과 대화형 분석의 핵심 도구이고 이후 액션이 종종 10배 넘게 빨라진다 |
| 지연 평가로 계획 전체를 최적화 | RDD 가이드: 트랜스포메이션은 액션이 결과를 요구할 때 계산해서 더 효율적으로 돌 수 있다(9절) |

어려운 점은 공식 문서의 튜닝 가이드와 RDD 가이드가 경고하는 내용에서 뽑을 수 있습니다.

| 어려운 점 | 문서가 적은 이유 |
|---|---|
| 셔플 비용 | 디스크 I/O, 직렬화, 네트워크 I/O가 함께 일어나는 비싼 연산이다 |
| 메모리 관리 | 셔플용 자료구조가 힙을 많이 쓴다. 메모리에 안 들어가면 디스크로 흘려 쓰고(spill) 디스크 I/O와 GC가 늘어난다 |
| 설정할 값이 많음 | 병렬도를 충분히 높이지 않으면 클러스터를 다 쓰지 못한다. 문서는 CPU 코어당 Task 2~3개를 권한다 |
| 드라이버 병목 | `collect()`처럼 결과를 드라이버로 모으는 연산은 드라이버 메모리에 다 올라간다 |
| 데이터 쏠림 | Performance Tuning 문서는 쏠림이 조인 성능을 크게 떨어뜨릴 수 있다고 적고 AQE가 sort-merge 조인의 쏠린 Task를 비슷한 크기로 쪼갠다고 설명한다([Ch-04](/blog/cert/spark/spark-04-troubleshooting-tuning)) |
| 작은 파일이 많음 | 파일을 여는 비용을 `spark.sql.files.openCostInBytes`(기본 4MB)만큼 읽는 시간으로 쳐서 작은 파일 여러 개를 한 파티션에 묶는다(8-1절) |
| GC | 튜닝 가이드: 저장한 RDD가 자주 바뀔수록(churn) GC가 문제가 되고 GC 비용은 Java 객체 수에 비례한다(6절) |

### 헷갈리는 지점

- "Spark는 항상 메모리에서만 계산한다"는 보기는 틀립니다. 저장 레벨에 디스크가 있고 셔플 중간 파일은 디스크(`spark.local.dir`, 기본 `/tmp`)에 씁니다.
- 애플리케이션 사이에 데이터를 나누려면 외부 저장소에 써야 한다고 Cluster Mode Overview가 적습니다. Spark 자체는 계산 엔진이고 데이터는 파일이나 테이블로 남깁니다.

## 2. 클러스터, 드라이버, 익스큐터, 코어, 메모리

### 2-1. 구성 요소의 역할

Cluster Mode Overview(4.2.0)의 용어 정의를 그대로 옮기면 이렇습니다.

| 용어 | 문서의 정의 |
|---|---|
| Application | Spark로 만든 사용자 프로그램. 드라이버 프로그램과 클러스터의 익스큐터로 이뤄진다 |
| Driver program | 애플리케이션의 `main()`을 실행하고 SparkContext를 만드는 프로세스 |
| Cluster manager | 클러스터 자원을 얻어 오는 외부 서비스(Standalone, YARN, Kubernetes) |
| Deploy mode | 드라이버가 어디서 도는지 구분한다. cluster 모드는 클러스터 안에서, client 모드는 제출한 쪽(클러스터 밖)에서 드라이버를 띄운다 |
| Worker node | 클러스터에서 애플리케이션 코드를 실행할 수 있는 노드 |
| Executor | 워커 노드에 애플리케이션용으로 뜨는 프로세스. Task를 실행하고 데이터를 메모리나 디스크에 들고 있다. 애플리케이션마다 자기 익스큐터가 있다 |
| Task | 익스큐터 하나로 보내는 작업 단위 |

동작 순서는 다음과 같습니다. SparkContext가 클러스터 매니저에 연결해 익스큐터를 얻습니다. 이어서 애플리케이션 코드(JAR나 Python 파일)를 익스큐터로 보내고 마지막으로 Task를 보내 실행시킵니다. 드라이버는 수명 내내 익스큐터의 연결을 받아야 하므로 워커 노드에서 네트워크로 닿을 수 있어야 합니다.

클러스터 매니저는 4.2.0 문서 기준으로 Standalone, YARN, Kubernetes 세 가지입니다. 예전 자료에 나오는 Mesos는 4.2.0 문서의 목록에 없습니다.

### 2-2. 배포 모드: client, cluster, local

`spark-submit`의 `--deploy-mode` 기본값은 `client`입니다(`spark.submit.deployMode`도 기본 `client`). 이 모드는 6영역(Spark Connect와 배포 모드)에서 다시 나오지만 드라이버 위치와 묶여 있어 여기서 같이 봅니다.

| 모드 | 드라이버 위치 | 문서가 권하는 상황 |
|---|---|---|
| client | `spark-submit`을 실행한 프로세스 안 | 워커와 가까운 게이트웨이에서 제출할 때, REPL처럼 콘솔 입출력이 필요할 때 |
| cluster | 클러스터 안의 노드 | 노트북처럼 워커와 먼 곳에서 제출할 때. Standalone은 Python 애플리케이션의 cluster 모드를 지원하지 않는다 |
| local | 한 JVM 안에서 드라이버와 실행이 같이 돈다 | 개발과 테스트 |

local 모드의 마스터 URL은 의미가 조금씩 다릅니다.

| 마스터 URL | 문서의 의미 |
|---|---|
| `local` | 워커 스레드 1개. 병렬성이 전혀 없다 |
| `local[K]` | 워커 스레드 K개 |
| `local[*]` | 논리 코어 수만큼 워커 스레드 |
| `local[K,F]` | 스레드 K개, Task 최대 실패 횟수 F |

Standalone(`spark://host:7077`), YARN, Kubernetes의 마스터 URL과 Spark Connect의 배포 방식은 [Ch-06](/blog/cert/spark/spark-06-connect-pandas-api)에서 6영역 범위로 묶어 다룹니다.

### 2-3. 코어와 동시에 도는 Task 수

익스큐터 하나가 동시에 돌리는 Task 수는 두 설정으로 정해집니다. `spark.executor.cores`는 익스큐터당 코어 수이고 기본값은 YARN에서 1, Standalone에서는 워커의 가용 코어 전부입니다. `spark.task.cpus`는 Task 하나에 배정하는 코어 수이고 기본 1입니다. 두 값으로 나누면 익스큐터 하나가 동시에 돌리는 Task 수가 나옵니다(문서의 두 정의에서 계산한 값입니다).

```text
익스큐터 4개 x spark.executor.cores 4 / spark.task.cpus 1
= 클러스터 전체에서 동시에 도는 Task 최대 16개
```

파티션이 200개인 Stage라면 Task 200개가 이 16개 자리를 돌아가며 씁니다. 반대로 파티션이 8개뿐이면 자리 8개는 놀게 됩니다. 튜닝 가이드가 코어당 Task 2~3개를 권하는 이유입니다.

### 2-4. 메모리 구조

익스큐터 메모리는 힙과 힙 밖(overhead)으로 나뉩니다. 4.2.0 Configuration과 Tuning 문서의 기본값입니다.

| 설정 | 기본값 | 의미 |
|---|---|---|
| `spark.executor.memory` | `1g` | 익스큐터 프로세스의 힙. 최소 450m |
| `spark.executor.memoryOverhead` | 익스큐터 메모리 x 0.10, 최소 384m | 힙 밖 메모리(VM 오버헤드, 네이티브 메모리). YARN과 Kubernetes에서 쓴다 |
| `spark.memory.fraction` | `0.6` | (힙 - 300MiB) 중 실행과 저장이 함께 쓰는 통합 영역 M의 비율 |
| `spark.memory.storageFraction` | `0.5` | M 안에서 캐시가 실행 메모리에 밀려나지 않는 구간 R의 비율 |
| `spark.driver.memory` | `1g` | 드라이버 힙. client 모드에서는 `SparkConf`로 못 바꾸고 `--driver-memory`로 준다 |
| `spark.driver.maxResultSize` | `1g` | 액션 하나가 드라이버로 보내는 직렬화 결과의 총량 상한. 넘으면 Job이 중단된다 |

실행 메모리는 셔플, 조인, 정렬, 집계에 쓰고 저장 메모리는 캐시와 브로드캐스트에 씁니다. 둘은 M을 같이 씁니다. 실행 쪽이 모자라면 저장 쪽 캐시를 R 아래로 떨어질 때까지 밀어낼 수 있습니다. 반대로 저장 쪽은 실행 메모리를 밀어내지 못합니다. 문서는 구현이 복잡해서라고 이유를 적습니다.

익스큐터 메모리 4g로 계산하면 이렇습니다(문서 공식을 적용한 값이고 실측이 아닙니다).

```text
힙              4096 MiB
예약             300 MiB
통합 영역 M      (4096 - 300) x 0.6 = 약 2277.6 MiB
캐시 보호 구간 R  2277.6 x 0.5     = 약 1138.8 MiB
나머지 40%       약 1518.4 MiB (사용자 자료구조, Spark 내부 메타데이터)
```

### 헷갈리는 지점

- 드라이버는 Task를 실행하지 않습니다. 계획을 세우고 Task를 나눠 보내며 결과를 받습니다. local 모드에서만 드라이버 JVM 안의 스레드가 Task를 실행합니다.
- 워커 노드는 기계이고 익스큐터는 그 위에 애플리케이션마다 뜨는 프로세스입니다. 한 워커 노드에 익스큐터가 여러 개 뜰 수 있습니다.
- 익스큐터 수를 늘리지 않아도 `spark.executor.cores`를 올리면 동시 Task 수가 늘어납니다. 대신 Task들이 같은 힙을 나눠 씁니다.

## 3. DataFrame과 Dataset

SQL 가이드(4.2.0)의 정의를 정리하면 다음과 같습니다.

| 개념 | 정의 | 쓸 수 있는 언어 |
|---|---|---|
| Dataset | 분산 데이터 컬렉션. RDD의 장점(강한 타입, 람다)과 Spark SQL 최적화 엔진의 장점을 합친 인터페이스로 1.6에 추가됐다 | Scala, Java |
| DataFrame | 이름 붙은 컬럼으로 구성된 Dataset. 관계형 DB의 테이블과 개념이 같다 | Python, Scala, Java, R |

Scala에서 `DataFrame`은 `Dataset[Row]`의 타입 별칭이고 Java에서는 `Dataset<Row>`로 씁니다. Python은 Dataset API를 지원하지 않습니다. 문서는 Python이 동적 언어라서 `row.columnName`처럼 이름으로 필드를 읽을 수 있어 Dataset의 장점 상당수를 이미 누린다고 설명합니다. 시험이 Python 전용이어도 "Dataset은 어느 언어에서 쓰는가"는 개념 문항으로 나올 수 있습니다.

Dataset은 직렬화에 Java 직렬화나 Kryo 대신 Encoder를 씁니다. Encoder는 동적으로 생성된 코드라서 바이트를 객체로 되돌리지 않고도 필터, 정렬, 해싱을 할 수 있다고 Getting Started가 적습니다.

```python
# DataFrame은 스키마를 가진다
orders.printSchema()
# root
#  |-- order_id: integer (nullable = true)
#  |-- user_id: integer (nullable = true)
#  |-- status: string (nullable = true)
#  |-- amount: integer (nullable = true)
#  |-- order_date: string (nullable = true)
# (문서 기준 예상 결과: DDL 문자열 스키마의 타입이 그대로 찍힌다)

# Row는 이름으로 필드를 읽는다
first = orders.first()
first.status        # 'PAID'
first["amount"]     # 32000
```

### 헷갈리는 지점

- DataFrame도 RDD 위에서 돕니다. `df.rdd`는 `Row`의 RDD를 돌려줍니다. Spark Connect에서는 RDD API를 쓸 수 없어 이 속성이 막힙니다.
- DataFrame은 불변입니다. `withColumn` 같은 메서드는 원본을 바꾸지 않고 새 DataFrame을 돌려줍니다. 결과를 변수에 받지 않으면 바뀐 것이 없습니다.

## 4. SparkSession 수명 주기

SparkSession은 Spark SQL의 모든 기능으로 들어가는 진입점입니다. 세션은 `SparkSession.builder`에 설정을 이어 붙이고 마지막에 `getOrCreate()`를 불러 얻습니다. builder 메서드는 모두 builder를 돌려주므로 순서는 자유이고 세션을 돌려주는 것은 `getOrCreate()` 하나입니다.

| builder 메서드 | 문서의 동작 |
|---|---|
| `appName(name)` | Spark UI에 보일 애플리케이션 이름. 지정하지 않으면 무작위로 만든 이름을 쓴다 |
| `master(master)` | 붙을 마스터 URL. `"local"`, `"local[4]"`, `"spark://master:7077"` 같은 값 |
| `config(key=None, value=None, conf=None, *, map=None)` | 설정 하나(키와 값), `SparkConf` 객체, 딕셔너리(`map`, 3.4.0부터) 중 하나로 준다. SparkConf와 세션 설정 양쪽에 전달된다 |
| `enableHiveSupport()` | Hive 메타스토어 연결과 Hive SerDe, Hive UDF 지원을 켠다 |

```python
# 새 애플리케이션에서 세션을 처음 만들 때의 형태
spark = (SparkSession.builder
         .appName("shop-orders")
         .master("local[*]")
         .config("spark.sql.shuffle.partitions", "8")
         .config(map={"spark.sql.session.timeZone": "Asia/Seoul"})
         .getOrCreate())
```

`getOrCreate()`가 이미 있는 세션을 돌려줄 때는 주의할 점이 있습니다. 문서는 builder에 준 설정을 기존 세션에 적용한다고 적지만 PySpark 4.2.0 소스는 이때 `applyModifiableSettings`로 실행 중에 바꿀 수 있는 설정만 넣고 SparkContext는 공유하므로 `SparkConf`를 갱신하지 않는다고 주석을 답니다. 그래서 `spark.executor.memory`처럼 SparkContext가 뜰 때 정해지는 값은 두 번째 `getOrCreate()`로 바꿀 수 없고 `spark.sql.shuffle.partitions` 같은 런타임 SQL 설정은 바뀝니다.

수명 주기에서 시험에 나올 만한 메서드는 넷입니다.

| 메서드 | 문서의 동작 |
|---|---|
| `SparkSession.builder.getOrCreate()` | 유효한 전역 기본 세션이 있으면 그것을 돌려주고 없으면 새로 만들어 전역 기본으로 등록한다. 기존 세션을 돌려줄 때 builder에 준 설정을 그 세션에 적용한다 |
| `spark.newSession()` | SQLConf, 임시 뷰, UDF는 따로 갖고 SparkContext와 테이블 캐시는 공유하는 새 세션 |
| `spark.stop()` | 밑에 있는 SparkContext를 멈춘다 |
| `SparkSession.getActiveSession()` | 현재 스레드의 활성 세션 |

```python
s1 = SparkSession.builder.config("spark.sql.shuffle.partitions", "8").getOrCreate()
s2 = SparkSession.builder.getOrCreate()
s1 is s2          # 문서 기준 예상 결과: 같은 세션을 돌려준다

s3 = s1.newSession()
orders.createOrReplaceTempView("orders_v")
s3.catalog.tableExists("orders_v")   # 임시 뷰는 세션별이라 s3에서는 보이지 않는다

spark.stop()      # SparkContext까지 멈춘다. 이후 같은 세션으로는 작업할 수 없다
new_spark = SparkSession.builder.getOrCreate()   # stop()이 기본 세션을 지웠으므로 새 세션이 생긴다
```

PySpark 소스의 `stop()`은 SparkContext를 멈춘 뒤 전역 기본 세션과 활성 세션 기록을 지웁니다. 그래서 `stop()` 다음의 `getOrCreate()`는 새 SparkContext와 새 세션을 만듭니다. `with SparkSession.builder.getOrCreate() as session:` 형태로 쓰면 블록을 나갈 때 `stop()`이 불립니다(`__enter__`와 `__exit__` 구현).

세션과 애플리케이션의 수명은 이렇게 겹칩니다.

| 대상 | 수명 |
|---|---|
| 임시 뷰(`createOrReplaceTempView`) | 만든 SparkSession |
| 전역 임시 뷰(`createGlobalTempView`) | Spark 애플리케이션. `global_temp` 데이터베이스로 조회 |
| 캐시 데이터 | 클러스터의 모든 세션이 공유한다. `unpersist()`나 `clearCache()`는 모든 세션에 영향을 준다 |
| SparkContext | 애플리케이션 하나에 하나. `stop()`으로 끝난다 |

### 헷갈리는 지점

- `getOrCreate()`를 두 번 불러도 세션이 둘 생기지 않습니다. 두 번째 호출에 준 설정이 기존 세션에 덮어써지는 것도 문서 예제에 나옵니다. 덮어써지는 것은 실행 중에 바꿀 수 있는 설정뿐입니다.
- `appName`, `master`, `config`는 builder를 돌려줍니다. 보기에서 `SparkSession.builder.appName("x").master("local")`로 끝나는 코드가 돌려주는 것은 builder이고 세션은 `getOrCreate()`를 불러야 생깁니다.
- `newSession()`은 SparkContext를 새로 만들지 않습니다. 캐시도 공유합니다.
- Spark SQL의 `spark.sql()`은 4.2.0 문서에 Spark Classic과 Spark Connect의 차이가 적혀 있습니다. Classic은 참조한 임시 뷰를 즉시 해석하고 Connect는 늦게 분석합니다. 그래서 Connect에서 뷰를 바꾼 뒤 실행하면 결과가 달라질 수 있습니다.

## 5. 캐시와 저장 레벨

### 5-1. 기본 저장 레벨 세 가지

같은 "cache"라도 API마다 기본값이 다릅니다. 각 API 문서(4.2.0)에 적힌 값입니다.

| API | 기본 저장 레벨 | 비고 |
|---|---|---|
| `DataFrame.cache()` | `MEMORY_AND_DISK_DESER` | 3.0에서 Scala와 맞추려고 바뀌었다 |
| `DataFrame.persist()` | `MEMORY_AND_DISK_DESER` | 이미 저장 레벨이 있으면 새 레벨을 줄 수 없다 |
| `RDD.cache()` | `MEMORY_ONLY` | RDD Programming Guide |
| `spark.catalog.cacheTable(name)` | `MEMORY_AND_DISK` | 3.5.0부터 `storageLevel` 인자를 받는다 |
| SQL `CACHE [LAZY] TABLE` | `MEMORY_AND_DISK` | `OPTIONS ('storageLevel' 'DISK_ONLY')`로 바꾼다. `LAZY`가 없으면 즉시 캐시한다 |

시그니처는 이렇습니다.

```python
DataFrame.cache()
DataFrame.persist(storageLevel=StorageLevel(True, True, False, True, 1))
DataFrame.unpersist(blocking=False)
StorageLevel(useDisk, useMemory, useOffHeap, deserialized, replication=1)
```

`StorageLevel`의 다섯 인자를 읽을 줄 알면 보기에 튜플만 나와도 풀 수 있습니다. `DataFrame.storageLevel` 문서 예제의 값입니다.

| 상태 | `storageLevel` | 읽는 법 |
|---|---|---|
| 캐시 전 | `StorageLevel(False, False, False, False, 1)` | 아무 데도 저장하지 않음 |
| `cache()` 후 | `StorageLevel(True, True, False, True, 1)` | 디스크 O, 메모리 O, 오프힙 X, 역직렬화 O, 복제 1 = `MEMORY_AND_DISK_DESER` |
| `persist(DISK_ONLY_2)` 후 | `StorageLevel(True, False, False, False, 2)` | 디스크만, 복제 2 |

### 5-2. 저장 레벨의 뜻

RDD Programming Guide의 설명을 줄이면 다음과 같습니다.

| 레벨 | 동작 |
|---|---|
| `MEMORY_ONLY` | 메모리에만. 안 들어가는 파티션은 캐시하지 않고 필요할 때마다 다시 계산한다 |
| `MEMORY_AND_DISK` | 메모리에 안 들어가는 파티션은 디스크에 두고 거기서 읽는다 |
| `DISK_ONLY` | 디스크에만 |
| `*_2`, `DISK_ONLY_3` | 같은 레벨에 파티션을 노드 2개(3개)에 복제 |
| `OFF_HEAP` | 오프힙 메모리. 오프힙을 켜야 한다(실험적) |

Python의 `StorageLevel` 상수는 `DISK_ONLY`, `DISK_ONLY_2`, `DISK_ONLY_3`, `MEMORY_AND_DISK`, `MEMORY_AND_DISK_2`, `MEMORY_AND_DISK_DESER`, `MEMORY_ONLY`, `MEMORY_ONLY_2`, `NONE`, `OFF_HEAP`입니다. `MEMORY_ONLY_SER`는 Java와 Scala용이라 Python 상수 목록에 없습니다. Python 쪽 데이터는 항상 직렬화되므로 Python 상수는 모두 직렬화 형식을 쓴다고 문서가 적습니다.

### 5-3. 캐시도 지연 평가된다

`cache()`는 표시만 해 둡니다. 실제로 저장되는 시점은 그 DataFrame을 계산하는 첫 액션입니다. Web UI 문서도 새로 persist한 데이터는 실체화되기 전까지 Storage 탭에 보이지 않으니 액션을 먼저 실행하라고 적습니다.

```python
from pyspark import StorageLevel

paid = orders.filter(F.col("status") == "PAID").cache()   # 아직 아무것도 저장되지 않음
paid.storageLevel        # StorageLevel(True, True, False, True, 1)  표시는 바로 바뀐다
paid.count()             # 첫 액션. 이때 계산하면서 캐시에 올린다
paid.agg(F.sum("amount")).show()   # 캐시에서 읽는다

paid.unpersist()                     # 기본 blocking=False
paid.persist(StorageLevel.DISK_ONLY) # 해제한 뒤에는 다른 레벨로 다시 지정할 수 있다
```

`explain()`으로 확인하면 캐시된 DataFrame의 물리 계획에 `InMemoryTableScan`이 나옵니다(`cache` 문서 예제).

### 5-4. 체크포인트와 캐시의 차이

캐시는 계보(논리 계획)를 그대로 둔 채 결과를 저장해 둡니다. 캐시를 잃으면 계보를 따라 다시 계산합니다. 체크포인트는 결과를 저장하면서 논리 계획을 잘라 냅니다. 문서는 반복 알고리즘처럼 계획이 기하급수로 커질 때 쓸모가 있다고 적습니다.

| | `cache()` / `persist()` | `checkpoint(eager=True)` | `localCheckpoint(eager=True, storageLevel=None)` |
|---|---|---|---|
| 저장 위치 | 익스큐터 메모리와 디스크(저장 레벨) | 체크포인트 디렉터리의 파일 | 익스큐터의 캐시 저장소 |
| 계보 | 유지 | 잘라 낸다 | 잘라 낸다 |
| 실행 시점 | 첫 액션 때(지연) | 기본 `eager=True`라 호출 즉시 | 기본 `eager=True`라 호출 즉시 |
| 신뢰성 | 잃으면 재계산 | 파일로 남는다(클러스터에서는 HDFS 같은 공유 경로) | 문서가 "not reliable"이라고 적는다. 익스큐터를 잃으면 함께 사라진다 |
| 준비 | 없음 | `spark.sparkContext.setCheckpointDir(경로)`나 `spark.checkpoint.dir`(4.0.0부터) | 없음 |
| Spark Connect | 3.4.0부터 | 4.0.0부터 | 4.0.0부터. `storageLevel` 인자도 4.0.0에 추가 |

```python
spark.sparkContext.setCheckpointDir("/tmp/shop-ckpt")   # Spark Classic. 클러스터에서는 HDFS 경로
base = orders.groupBy("user_id").agg(F.sum("amount").alias("total"))
cut = base.checkpoint()          # 즉시 파일로 쓰고 계보를 끊은 새 DataFrame을 돌려준다
cut.explain()                    # groupBy가 계획에서 빠진다(계획을 잘라 낸다는 문서 설명으로 예상한 결과)

local_cut = base.localCheckpoint(eager=False)   # 첫 액션 때 익스큐터 캐시에 저장
```

두 메서드 모두 원본을 바꾸지 않고 새 DataFrame을 돌려줍니다. 이후 계산에서 체크포인트를 쓰려면 돌려받은 DataFrame(`cut`)으로 이어 가야 합니다. 두 API 문서 모두 "This API is experimental"이라고 적습니다. Structured Streaming의 `checkpointLocation`은 쿼리의 진행 상황과 상태를 남기는 다른 기능입니다([Ch-05](/blog/cert/spark/spark-05-structured-streaming)).

### 헷갈리는 지점

- "`cache()`는 즉시 데이터를 메모리에 올린다"는 틀린 보기입니다. 액션이 있어야 올라갑니다. SQL 문 `CACHE TABLE`은 반대로 기본이 즉시 캐시이고 `CACHE LAZY TABLE`이라고 써야 처음 쓸 때 캐시합니다(SQL 레퍼런스).
- `cache()`와 `persist()`의 차이는 인자 유무뿐입니다. DataFrame에서는 둘 다 기본 `MEMORY_AND_DISK_DESER`입니다.
- `unpersist()`의 `blocking` 기본값은 `False`입니다. 2.0에서 Scala와 맞추려고 바뀌었다고 문서가 적습니다.
- Spark는 캐시를 노드마다 LRU 방식으로 비웁니다. 직접 지우지 않아도 오래된 파티션은 빠질 수 있습니다.
- Databricks 서버리스 컴퓨트(Free Edition 포함)에서는 `cache()`가 예외를 냅니다([Ch-00](/blog/cert/spark/spark-00-exam-and-study-plan) 4절). 이 절의 실습은 로컬에서 해야 합니다.

## 6. 가비지 컬렉션

Spark는 JVM 위에서 돌기 때문에 익스큐터 힙의 객체는 GC가 치웁니다. 튜닝 가이드(4.2.0)가 설명하는 JVM 힙 구조와 대응은 이렇습니다.

| 개념 | 문서 설명 |
|---|---|
| Young / Old | 힙은 수명이 짧은 객체용 Young과 긴 객체용 Old로 나뉜다 |
| Eden, Survivor1, Survivor2 | Young의 세 구역. Eden이 차면 minor GC가 돌고 살아남은 객체가 Survivor로 옮겨진다 |
| full GC | Old가 거의 차면 일어난다 |
| 목표 | 오래 쓰는 캐시 데이터만 Old에 두고 Young은 짧게 쓰는 객체를 담을 만큼 크게 둔다 |

GC가 문제인지 보는 방법은 둘입니다. Web UI의 Stage 상세 화면은 Task 요약 지표에 GC time(JVM GC에 쓴 총시간)을 보여 주고 Executors 탭은 익스큐터(드라이버 포함)마다 한 줄씩 GC time을 보여 줍니다. 탭 읽는 법은 [Ch-04](/blog/cert/spark/spark-04-troubleshooting-tuning)에 모았습니다. 더 자세히 보려면 Java 옵션에 `-verbose:gc -XX:+PrintGCDetails -XX:+PrintGCTimeStamps`를 넣습니다. 이 로그는 워커 노드의 `stdout`(작업 디렉터리 안)에 찍힌다고 문서가 따로 강조합니다. 익스큐터 GC 옵션은 `spark.executor.extraJavaOptions`나 `spark.executor.defaultJavaOptions`로 줍니다.

이 옵션 문구는 3.5.7과 4.2.0 튜닝 가이드에 똑같이 남아 있지만 JDK 8 시절 옵션입니다. JDK 9부터 GC 로그가 통합 로깅(`-Xlog:gc*`)으로 바뀌었고 JDK 11과 17에서는 `-XX:+PrintGCTimeStamps` 같은 옵션을 인식하지 못해 JVM이 뜨지 않는다는 벤더 문서(Atlassian)가 있습니다. Spark 4.x 기본인 JDK 17에서 실제로 GC 로그를 켤 때는 `-Xlog:gc*`를 쓰는 편이 안전합니다. 이 조합은 이번에 실행해 보지 않았습니다. 시험에서는 튜닝 가이드의 문구 그대로 나올 수 있으니 "Java 옵션으로 GC 로그를 켜고 워커의 stdout에서 본다"는 흐름을 기억합니다.

문서가 권하는 대응을 상황별로 묶었습니다.

| 관찰 | 문서의 대응 |
|---|---|
| GC가 문제라면 가장 먼저 | 직렬화 캐시. 파티션마다 객체가 바이트 배열 하나만 남는다 |
| Task가 끝나기 전에 full GC가 여러 번 | Task 실행에 쓸 메모리가 모자란다 |
| minor GC는 잦고 major GC는 적음 | Eden을 늘린다. Young 크기를 `-Xmn=4/3*E`로 잡는다 |
| Old가 거의 참 | `spark.memory.fraction`을 낮춰 캐시를 줄인다. 캐시를 덜 하는 편이 Task를 느리게 하는 것보다 낫다 |
| 큰 익스큐터 힙 | G1 region 크기(`-XX:G1HeapRegionSize`)를 키운다 |

버전 차이가 하나 있습니다. 4.2.0 튜닝 가이드는 Spark 4.0.0부터 JDK 17이 기본이고 그래서 G1GC가 기본 수집기라고 적습니다. 3.5.7 튜닝 가이드의 같은 자리는 "`-XX:+UseG1GC`로 G1GC를 써 보라"는 권고입니다. 기본 수집기는 JDK가 정하므로 3.x 시절 자료의 GC 설명은 그때 쓰던 JDK 기준으로 읽어야 합니다.

### 헷갈리는 지점

- 익스큐터 GC 로그는 워커 쪽 `stdout`에 있습니다. 드라이버 로그에서 찾으라는 보기는 틀립니다.
- `MEMORY_ONLY_SER` 권고는 Java와 Scala 이야기입니다. Python의 저장 레벨은 원래 직렬화 형식이라 PySpark 문항에서 "직렬화 레벨로 바꿔 GC를 줄인다"는 보기는 문맥을 따져 봐야 합니다.
- 직렬화 라이브러리 기본값은 Java 직렬화이고 Kryo는 `spark.serializer`로 바꿉니다. 문서는 Kryo가 종종 10배까지 빠르고 작다고 적지만 이 수치는 "often as much as 10x"라는 표현이라 조건이 없는 상한값입니다.

## 7. 실행 계층: Job, Stage, Task와 DAG

Cluster Mode Overview의 정의에 RDD 가이드의 문장 둘을 붙이면 계층이 완성됩니다.

| 단위 | 정의 | 만들어지는 때 |
|---|---|---|
| Job | 여러 Task로 이뤄진 병렬 계산 | 액션(`save`, `collect` 등)마다 |
| Stage | Job을 나눈 Task 묶음. 서로 의존한다(MapReduce의 map/reduce 단계와 비슷) | 셔플 경계마다 나뉜다 |
| Task | 익스큐터 하나로 보내는 작업 단위 | 파티션 하나당 하나 |

RDD 가이드는 "액션은 분산 셔플 연산으로 나뉜 Stage들을 거쳐 실행된다"고 적고 "Task 하나는 파티션 하나를 처리한다"고 적습니다. 그래서 Stage 안의 Task 수는 그 Stage가 다루는 파티션 수와 같습니다.

DAG(방향 비순환 그래프)는 트랜스포메이션이 쌓인 의존 관계입니다. Web UI의 Job 상세 화면은 DAG visualization을 보여 줍니다. 문서는 꼭짓점이 RDD나 DataFrame이고 간선이 적용할 연산이라고 설명합니다.

주문 데이터로 Stage가 어떻게 나뉘는지 봅니다.

```python
daily = (orders
         .filter(F.col("status") == "PAID")     # 좁은 변환: 셔플 없음
         .withColumn("vat", F.col("amount") * 0.1)  # 좁은 변환
         .groupBy("order_date")                 # 넓은 변환: 여기서 셔플
         .agg(F.sum("amount").alias("revenue")))

daily.explain()      # 액션이 아니다. 계획만 출력한다
daily.collect()      # 액션. Job이 생긴다
```

`collect()` 한 번이 만드는 구조를 문서 정의대로 그리면 이렇습니다.

```text
Job 0 (collect)
├─ Stage 0: 읽기 → filter → withColumn → 부분 집계 → 셔플 쓰기
│   Task 수 = 입력 파티션 수
└─ Stage 1: 셔플 읽기 → 최종 집계 → 드라이버로 반환
    Task 수 = 셔플 파티션 수 (spark.sql.shuffle.partitions, AQE가 합칠 수 있음)
```

실제 Job 개수와 Task 수는 AQE와 최적화기에 따라 달라질 수 있습니다. 위 그림은 개념 구조이고 실행해서 확인한 값이 아닙니다. 다음 실습 글에서 Spark UI 화면으로 확인하겠습니다.

### 헷갈리는 지점

- `explain()`, `printSchema()`, `schema`, `columns`는 Job을 만들지 않습니다. 계획이나 메타데이터만 봅니다. 다만 CSV를 `inferSchema=True`로 읽으면 스키마를 추론하려고 읽기 시점에 데이터를 한 번 훑는다고 `DataFrameReader.csv` 문서가 적습니다.
- 셔플이 없는 Job은 Stage가 하나입니다. Stage 경계는 셔플이고 액션 수와는 무관합니다.

## 8. 파티션과 셔플

### 8-1. 파티션 수가 정해지는 자리

| 시점 | 정하는 값 | 기본값 |
|---|---|---|
| 파일 읽기 | `spark.sql.files.maxPartitionBytes` | 128MB |
| 파일 읽기(작은 파일 묶기) | `spark.sql.files.openCostInBytes` | 4MB |
| DataFrame 셔플 후(조인, 집계) | `spark.sql.shuffle.partitions` | 200 |
| RDD 셔플, `parallelize` | `spark.default.parallelism` | 셔플은 부모 RDD의 최대 파티션 수, `parallelize`는 local에서 코어 수, 그 밖에는 전체 익스큐터 코어 수와 2 중 큰 값 |
| 셔플 후 파티션 합치기 | `spark.sql.adaptive.coalescePartitions.enabled` | true(AQE가 켜져 있을 때) |

AQE(`spark.sql.adaptive.enabled`)는 3.2.0부터 기본으로 켜져 있습니다. 켜져 있으면 셔플 후 인접한 작은 파티션을 목표 크기(`advisoryPartitionSizeInBytes`, 64MB)에 맞춰 합칩니다. 그래서 200으로 셔플해도 Spark UI의 다음 Stage Task 수가 200보다 적게 보일 수 있습니다. AQE는 4영역(튜닝)에서 자세히 다룹니다.

### 8-2. 셔플이란

RDD 가이드는 셔플을 "파티션 사이에 데이터를 다시 나눠 다르게 묶는 메커니즘"이라고 정의합니다. 같은 키의 값을 한곳에 모으려면 모든 파티션을 읽어야 하므로 all-to-all 연산이 됩니다. 비용 요소는 셋입니다.

1. 디스크 I/O: map 쪽 결과를 대상 파티션별로 정렬해 파일로 씁니다.
2. 직렬화: 네트워크로 보내려면 객체를 바이트로 바꿉니다.
3. 네트워크 I/O: reduce 쪽 Task가 다른 익스큐터의 블록을 읽어 옵니다.

셔플 파일은 해당 RDD가 쓰이지 않아 GC될 때까지 남아 있습니다. 계보를 다시 계산할 때 셔플 파일을 다시 만들지 않으려는 설계입니다. 그래서 오래 도는 애플리케이션은 `spark.local.dir`의 디스크를 많이 쓸 수 있다고 문서가 경고합니다.

### 8-3. repartition과 coalesce

```python
DataFrame.repartition(numPartitions, *cols)
DataFrame.coalesce(numPartitions)
```

| | `repartition` | `coalesce` |
|---|---|---|
| 셔플 | 전체 셔플 | 없음(좁은 의존성) |
| 늘리기 | 된다 | 안 된다. 더 큰 수를 주면 현재 수를 유지한다 |
| 분배 방식 | 해시 파티셔닝. 컬럼을 주면 그 컬럼 기준 | 기존 파티션을 합친다(1000개를 100개로 줄이면 새 파티션이 기존 10개씩을 맡는다) |
| `numPartitions` 생략 | 컬럼을 주면 생략 가능. 기본 파티션 수(`spark.sql.shuffle.partitions`)를 쓴다 | 필수 |

```python
orders.rdd.getNumPartitions()            # 로컬 RDD 확인용. Spark Connect에서는 RDD를 못 쓴다

by_user = orders.repartition(8, "user_id")   # user_id 해시로 8개. 같은 user_id는 같은 파티션
fewer   = by_user.coalesce(2)                # 셔플 없이 2개로
same    = by_user.coalesce(16)               # 늘어나지 않는다. 8개 그대로

# 파티션 번호를 컬럼으로 보는 방법(문서 예제와 같은 방식, Connect에서도 된다)
by_user.select(F.spark_partition_id().alias("pid")).distinct().count()
```

`coalesce(1)`처럼 급격히 줄이면 계산이 노드 하나에서 일어날 수 있다고 문서가 경고합니다. 이때는 셔플이 더해지더라도 `repartition(1)`이 위쪽 파티션을 병렬로 계산하게 해 줍니다.

### 헷갈리는 지점

- `spark.sql.shuffle.partitions=200`은 "셔플할 때 DataFrame이 200개 파티션으로 나뉜다"는 뜻입니다. 익스큐터 200개나 처음 200개 파티션만 처리한다는 뜻이 아닙니다. 시험 안내서 샘플 문항 5번이 이 내용입니다.
- RDD 가이드는 `coalesce`를 셔플을 일으킬 수 있는 연산(repartition 계열)에 넣습니다. RDD의 `coalesce(n, shuffle=True)`를 염두에 둔 표현이고 DataFrame `coalesce` 문서는 셔플이 없다고 적습니다. 문항이 DataFrame인지 RDD인지 보고 답합니다.
- 셔플 뒤 파티션 안의 원소 순서는 결정적이지 않습니다. 파티션 구성과 파티션 순서는 결정적입니다.

## 9. 트랜스포메이션, 액션, 지연 평가

### 9-1. 지연 평가

RDD 가이드의 문장 그대로 "Spark의 모든 트랜스포메이션은 지연된다." 트랜스포메이션은 결과를 바로 계산하지 않고 어떤 변환을 적용했는지만 기억합니다. 액션이 드라이버로 결과를 돌려달라고 할 때 비로소 계산합니다. 문서가 드는 이점은 최적화입니다. `map` 뒤에 `reduce`가 온다는 것을 알면 큰 중간 결과 대신 `reduce` 결과만 드라이버로 보낼 수 있습니다.

DataFrame에서는 이 이점이 더 큽니다. SQL 가이드는 Spark SQL 인터페이스가 데이터 구조와 계산에 대한 정보를 더 주고 엔진이 그 정보로 추가 최적화를 한다고 적습니다. 지연 평가 덕분에 최적화기는 액션 전까지 쌓인 계획 전체를 보고 필터를 앞으로 당기거나 필요한 컬럼만 읽을 수 있습니다.

### 9-2. 좁은 변환과 넓은 변환

| 구분 | 의미 | 예 |
|---|---|---|
| 좁은 변환(narrow) | 출력 파티션 하나가 입력 파티션 하나(또는 몇 개)에만 의존. 셔플 없음 | `select`, `filter`/`where`, `withColumn`, `drop`, `union`, `coalesce` |
| 넓은 변환(wide) | 출력 파티션이 여러 입력 파티션의 데이터를 필요로 함. 셔플 발생 | `groupBy().agg()`, `distinct`, `dropDuplicates`, `join`(브로드캐스트 제외), `orderBy`/`sort`, `repartition` |

좁은 변환과 넓은 변환이라는 말은 Spark 문서의 `coalesce` 설명에 "narrow dependency"로 나옵니다. 위 표의 넓은 변환 목록은 RDD 가이드의 셔플 연산 목록(repartition 계열, ByKey 계열, join 계열)을 DataFrame 연산에 대응시킨 것입니다. 브로드캐스트 조인은 작은 쪽을 모든 익스큐터에 보내므로 큰 쪽을 셔플하지 않습니다.

### 9-3. 액션 목록

| 액션 | 돌려주는 것 | 주의 |
|---|---|---|
| `count()` | 행 수(int) | |
| `collect()` | `Row` 리스트 | 모든 데이터를 드라이버 메모리에 올린다 |
| `take(n)`, `head(n)` | `Row` 리스트 | `head()`는 인자가 없으면 `Row` 하나 |
| `first()` | `Row` 하나, 비면 `None` | |
| `show(n=20, truncate=True)` | 출력만(반환값 `None`) | 20자 넘는 문자열을 자른다 |
| `toPandas()` | pandas DataFrame | 드라이버 메모리에 다 올린다 |
| `write...save()`, `saveAsTable()` | 없음 | 쓰기도 액션이다 |
| `foreach(f)` | 없음 | 익스큐터에서 실행된다 |

```python
step1 = orders.filter("amount >= 10000")      # 트랜스포메이션. Job 없음
step2 = step1.select("order_id", "amount")    # 트랜스포메이션. Job 없음
step2.count()                                 # 액션. 여기서 Job 생성
step2.show()                                  # 또 액션. 캐시가 없으므로 처음부터 다시 계산
```

### 헷갈리는 지점

- 캐시 없이 같은 DataFrame에 액션을 두 번 부르면 계보 전체를 두 번 계산합니다. 재사용이 많으면 `cache()`를 겁니다.
- 데이터 값 때문에 나는 오류(예: ANSI 모드에서 날짜로 바꿀 수 없는 문자열)는 계산할 때 드러나므로 액션 줄에서 터집니다. 트랜스포메이션 줄만 보고 "여기서 오류가 난다"고 고르는 보기를 조심합니다. 임시 뷰 참조는 Spark Classic이 즉시 해석하고 Spark Connect가 늦게 분석한다고 `SparkSession.sql` 문서가 적으니, Connect에서는 분석 오류도 늦게 보일 수 있습니다.
- `show()`는 액션이지만 결과를 돌려주지 않습니다. 안내서 샘플 문항 4번의 오답 보기가 `show()`의 반환값을 리스트로 바꾸려는 코드입니다.

## 10. Spark 모듈

4.2.0 문서 첫 페이지는 Spark 위의 고수준 도구로 다섯 가지(Spark SQL, pandas API on Spark, MLlib, GraphX, Structured Streaming)를 듭니다. 시험 안내서는 Core, Spark SQL, DataFrames, pandas API on Spark, Structured Streaming, MLlib 여섯을 적습니다. 둘을 맞춰 봅니다.

| 모듈 | 문서의 용도 | 이 시리즈 |
|---|---|---|
| Spark Core | RDD Programming Guide가 다루는 기반 API. 문서는 RDD를 "core but old API"라고 적고 accumulator와 broadcast 변수를 함께 설명한다 | 이 글, [Ch-03](/blog/cert/spark/spark-03-dataframe-api) |
| Spark SQL, DataFrames | SQL과 구조화 데이터 처리 | Ch-02, Ch-03 |
| pandas API on Spark | pandas 작업 | 7영역 |
| Structured Streaming | 증분 계산과 스트림 처리. DataFrame 기반 | 5영역 |
| MLlib | 머신러닝 | 이 시험에서는 기능만 묻는다 |
| GraphX | 그래프 처리 | 안내서 목록에는 없다 |

문서는 DStream 기반의 Spark Streaming을 "old API"로, Structured Streaming을 "DStream보다 새로운 API"로 구분합니다. 시험 안내서의 스트리밍 영역은 Structured Streaming입니다.

### 헷갈리는 지점

- GraphX는 4.2.0 문서의 고수준 도구 목록에 있지만 시험 안내서의 모듈 목록에는 없습니다.
- pandas API on Spark는 pandas와 비슷한 API로 Spark DataFrame을 다루는 모듈입니다. 계산은 Spark가 분산해서 합니다. `to_pandas()`는 데이터를 클라이언트로 다 모읍니다([Ch-00](/blog/cert/spark/spark-00-exam-and-study-plan) 3절).

## 11. 확인 문제

직접 만든 문제입니다. 시험 문항이나 문제 은행에서 가져오지 않았습니다.

**문제 1.** 다음 코드에서 Job은 몇 개 생깁니까? (AQE와 최적화기가 Job을 더 만드는 경우는 생각하지 않습니다.)

```python
a = orders.filter("status = 'PAID'")
b = a.groupBy("user_id").count()
b.explain()
b.cache()
n = b.count()
rows = b.collect()
```

A. 0개 B. 1개 C. 2개 D. 4개

<details>
<summary>정답과 풀이</summary>

C. 액션은 `count()`와 `collect()` 둘입니다. `explain()`은 계획만 출력하고 `cache()`는 표시만 합니다. `count()`가 계산하면서 캐시에 올리고 `collect()`는 캐시에서 읽지만 액션이므로 Job은 따로 생깁니다.

</details>

**문제 2.** `df.cache()` 직후 `df.storageLevel`의 값으로 맞는 것은? (DataFrame API)

A. `StorageLevel(False, True, False, False, 1)`
B. `StorageLevel(True, True, False, True, 1)`
C. `StorageLevel(True, True, False, False, 2)`
D. 첫 액션 전이므로 `StorageLevel(False, False, False, False, 1)`

<details>
<summary>정답과 풀이</summary>

B. DataFrame 기본은 `MEMORY_AND_DISK_DESER`이고 인자 순서는 (useDisk, useMemory, useOffHeap, deserialized, replication)입니다. 데이터가 실제로 올라가는 시점은 첫 액션이지만 `storageLevel` 표시는 `cache()` 호출 즉시 바뀝니다(`DataFrame.storageLevel` 문서 예제). D는 "데이터가 아직 없다"와 "레벨이 지정되지 않았다"를 섞은 함정입니다.

</details>

**문제 3.** 파티션이 40개인 DataFrame `df`에 대해 맞는 설명은?

A. `df.coalesce(80)`은 셔플 후 80개가 된다.
B. `df.coalesce(10)`은 셔플 없이 10개가 된다.
C. `df.repartition(10)`은 셔플 없이 10개가 된다.
D. `df.repartition("user_id")`는 파티션 수가 40개로 유지된다.

<details>
<summary>정답과 풀이</summary>

B. `coalesce`는 좁은 의존성이라 셔플이 없고 늘리려 하면 현재 수(40)를 유지하므로 A는 틀립니다. `repartition`은 항상 전체 셔플입니다. D처럼 컬럼만 주면 기본 파티션 수(`spark.sql.shuffle.partitions`)를 씁니다.

</details>

**문제 4.** 익스큐터의 GC 시간을 확인하려 합니다. 문서 기준으로 맞는 방법은?

A. 드라이버 로그에서 `-verbose:gc` 출력을 찾는다.
B. Spark UI의 Executors 탭이나 Stages 탭에서 GC time을 보고 자세한 로그는 워커 노드의 `stdout`에서 본다.
C. `spark.memory.fraction`을 1.0으로 올리면 GC 로그가 켜진다.
D. `df.explain(mode="cost")`의 통계에 GC 시간이 나온다.

<details>
<summary>정답과 풀이</summary>

B. 튜닝 가이드는 GC 로그가 워커 노드의 `stdout`에 찍힌다고 적습니다. Web UI 문서는 Executors 탭과 Stages 탭에 GC time을 보여 줍니다. C와 D는 GC 로그와 관계가 없습니다.

</details>

**문제 5.** `spark.executor.memory=4g`이고 다른 메모리 설정이 기본값일 때 캐시가 실행 메모리에 밀려나지 않는 구간 R의 크기에 가장 가까운 값은?

A. 약 2GB B. 약 1.1GiB C. 약 2.4GiB D. 0

<details>
<summary>정답과 풀이</summary>

B. (4096 - 300) x 0.6 x 0.5 = 약 1138.8MiB입니다. A의 2GB는 4g x 0.5로 300MiB 예약과 `spark.memory.fraction`을 빼먹은 값이고 C의 2.4GiB는 4g x 0.6입니다.

</details>

**문제 6.** 다음 중 SparkSession과 수명이 같은 것은?

A. `createGlobalTempView`로 만든 뷰
B. `createOrReplaceTempView`로 만든 뷰
C. `df.cache()`로 캐시한 데이터
D. SparkContext

<details>
<summary>정답과 풀이</summary>

B. 임시 뷰는 만든 세션에 묶입니다. 전역 임시 뷰와 SparkContext는 애플리케이션 수명이고 캐시는 클러스터의 모든 세션이 공유합니다.

</details>

**문제 7.** 반복 계산으로 논리 계획이 계속 길어지는 쇼핑몰 추천 점수 DataFrame `scores`가 있습니다. 계획을 끊어 내면서 결과를 파일로 남기는 코드는? (Spark Classic)

A. `scores.cache()`
B. `scores.persist(StorageLevel.DISK_ONLY)`
C. `spark.sparkContext.setCheckpointDir("/tmp/ckpt")` 다음 `scores = scores.checkpoint()`
D. `scores = scores.localCheckpoint()`

<details>
<summary>정답과 풀이</summary>

C. `checkpoint()`는 체크포인트 디렉터리에 파일로 쓰고 논리 계획을 잘라 냅니다. 기본 `eager=True`라 호출할 때 바로 씁니다. A와 B는 계보를 그대로 둡니다. D도 계획을 자르지만 익스큐터 캐시 저장소에 두므로 문서가 신뢰할 수 없다고 적고 파일로 남지 않습니다.

</details>

## 범위와 한계

- 기본값과 시그니처는 2026년 10월 19일에 연 Spark 4.2.0 문서와 PySpark 4.2.0 API 문서 기준입니다. 3.x와 다른 부분은 문서에 버전이 적힌 것만 표시했습니다(G1GC 기본, `cacheTable`의 `storageLevel` 인자 3.5.0, AQE 기본 켜짐 3.2.0). 시험의 기준 Spark 버전은 공개되지 않았습니다.
- 코드는 아직 실행하지 않았습니다. 이 노트북에 Java가 없어 PySpark를 띄울 수 없었습니다. 주석의 결과는 문서 예제와 정의로 예상한 값이고 7절의 Stage 그림은 개념 구조입니다. 로컬 환경을 갖춘 뒤 Spark UI 화면과 함께 실제 결과로 바꾸겠습니다.
- 2-4절과 문제 5의 메모리 계산은 문서 공식을 적용한 값이고 측정값이 아닙니다.
- 9-2절의 넓은 변환 목록은 RDD 가이드의 셔플 연산 목록을 DataFrame 연산에 대응시킨 것입니다. DataFrame 연산마다 셔플 여부를 적은 공식 표는 찾지 못했습니다.
- 10절의 MLlib과 Spark Core 설명은 이번에 문서를 깊이 읽지 않았습니다.
- 2026년 10월 20일에 4.2.0과 3.5.7 문서, PySpark 4.2.0 API 문서를 다시 열어 기본값을 대조했습니다. 이때 추가한 버전 표시는 `checkpoint`와 `localCheckpoint`의 Spark Connect 지원(4.0.0), `spark.checkpoint.dir`(4.0.0), `localCheckpoint`의 `storageLevel` 인자(4.0.0), 3.5.7 튜닝 가이드의 G1GC 권고입니다.
- 4절의 `getOrCreate()`가 기존 세션에 런타임 설정만 적용한다는 내용과 `stop()`이 기본 세션 기록을 지운다는 내용은 API 문서에 없어서 PySpark 4.2.0 소스(`python/pyspark/sql/session.py`)를 읽고 적었습니다.
- 6절의 JDK 17 GC 로그 옵션은 Atlassian 지원 문서 기준이고 Spark에서 실행해 보지 않았습니다.

## 참고 자료

시험
- Databricks, [Exam Guide, Oct 2025](https://www.databricks.com/sites/default/files/2025-10/databricks-certified-associate-developer-apache-spark-exam-guide-oct-2025.pdf) (Section 1 항목과 샘플 문항 4, 5번)

Apache Spark 4.2.0 문서
- [Overview](https://spark.apache.org/docs/latest/index.html), [Apache Spark 홈페이지](https://spark.apache.org/)
- [Cluster Mode Overview](https://spark.apache.org/docs/latest/cluster-overview.html)
- [Submitting Applications](https://spark.apache.org/docs/latest/submitting-applications.html)
- [Configuration](https://spark.apache.org/docs/latest/configuration.html)
- [Tuning Spark](https://spark.apache.org/docs/latest/tuning.html)
- [RDD Programming Guide](https://spark.apache.org/docs/latest/rdd-programming-guide.html)
- [Spark SQL, DataFrames and Datasets Guide](https://spark.apache.org/docs/latest/sql-programming-guide.html), [Getting Started](https://spark.apache.org/docs/latest/sql-getting-started.html)
- [Performance Tuning](https://spark.apache.org/docs/latest/sql-performance-tuning.html)
- [Web UI](https://spark.apache.org/docs/latest/web-ui.html)

PySpark 4.2.0 API
- [DataFrame.cache](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.cache.html), [DataFrame.persist](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.persist.html), [DataFrame.unpersist](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.unpersist.html), [DataFrame.storageLevel](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.storageLevel.html)
- [StorageLevel](https://spark.apache.org/docs/latest/api/python/reference/api/pyspark.StorageLevel.html), [Catalog.cacheTable](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.Catalog.cacheTable.html)
- [DataFrame.repartition](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.repartition.html), [DataFrame.coalesce](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.coalesce.html), [DataFrame.explain](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.explain.html)
- [DataFrame.checkpoint](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.checkpoint.html), [DataFrame.localCheckpoint](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.localCheckpoint.html), [SparkContext.setCheckpointDir](https://spark.apache.org/docs/latest/api/python/reference/api/pyspark.SparkContext.setCheckpointDir.html)
- [SparkSession.builder.appName](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.SparkSession.builder.appName.html), [SparkSession.builder.master](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.SparkSession.builder.master.html), [SparkSession.builder.config](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.SparkSession.builder.config.html), [SparkSession.builder.enableHiveSupport](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.SparkSession.builder.enableHiveSupport.html)
- [SparkSession.builder.getOrCreate](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.SparkSession.builder.getOrCreate.html), [SparkSession.newSession](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.SparkSession.newSession.html), [SparkSession.stop](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.SparkSession.stop.html), [SparkSession.sql](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.SparkSession.sql.html)
- [DataFrame.collect](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.collect.html), [DataFrame.show](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.show.html)

그 밖의 문서와 소스
- Apache Spark, [CACHE TABLE (SQL Reference)](https://spark.apache.org/docs/latest/sql-ref-syntax-aux-cache-cache-table.html)
- Apache Spark 3.5.7, [Tuning Spark](https://spark.apache.org/docs/3.5.7/tuning.html)
- Apache Spark, [python/pyspark/sql/session.py (v4.2.0)](https://github.com/apache/spark/blob/v4.2.0/python/pyspark/sql/session.py)
- Atlassian, [Unrecognized JVM GC options when using JDK 11/17](https://support.atlassian.com/confluence/kb/unrecognized-jvm-gc-options-when-using-jdk-11-17/)

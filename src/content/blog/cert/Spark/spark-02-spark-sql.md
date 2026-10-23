---
title: '[Spark Ch-02] Spark SQL로 읽고 쓰기: 저장 모드 기본값은 errorifexists'
description: Databricks Spark 자격증 2영역(Spark SQL 사용, 20%)을 시험 안내서의 항목 순서대로 정리합니다. JDBC와 파일 소스의 읽기·쓰기, overwrite와 partitionBy, 파일에 직접 SQL 실행, 저장 모드, bucketBy와 sortBy를 쓴 영구 테이블, 관리형과 외부 테이블, 임시 뷰를 Spark 4.2.0과 Databricks 공식 문서의 기본값으로 확인합니다.
date: 2026-10-19T00:00:00.000Z
tags:
  - Spark
  - Databricks
  - PySpark
  - Certification
  - Spark SQL
category: cert/Spark
topics:
  - cert
draft: false
series: "Spark 공부"
seriesOrder: 2
---

## 결론부터

1. 저장 모드는 `append`, `overwrite`, `error`(= `errorifexists`), `ignore` 넷이고 기본값은 `errorifexists`입니다. 문서는 저장 모드가 잠금을 쓰지 않고 원자적이지 않으며 `overwrite`는 새 데이터를 쓰기 전에 기존 데이터를 먼저 지운다고 적습니다.
2. 형식을 지정하지 않으면 `spark.sql.sources.default`(기본 `parquet`)로 읽고 씁니다. CSV는 `header`와 `inferSchema`가 둘 다 기본 `false`이고 JSON은 한 줄에 객체 하나(JSON Lines)가 기본입니다.
3. `partitionBy`는 `save`와 `saveAsTable` 모두에 쓰고 `컬럼=값` 디렉터리를 만듭니다. `bucketBy`와 `sortBy`는 `saveAsTable`과 함께 쓰는 영구 테이블 전용입니다. 카디널리티가 큰 컬럼에는 `partitionBy` 대신 `bucketBy`가 맞다고 문서가 적습니다.
4. `saveAsTable`에 `path` 옵션을 주면 외부 테이블이 되어 `DROP TABLE` 후에도 파일이 남습니다. 경로를 주지 않은 관리형 테이블은 웨어하우스 디렉터리의 파일까지 지워집니다. Databricks Unity Catalog의 관리형 테이블은 기본 형식이 Delta이고 삭제 후 7일 동안 `UNDROP`으로 되살릴 수 있습니다.
5. 임시 뷰는 만든 SparkSession이 끝나면 사라지고 전역 임시 뷰는 애플리케이션이 끝날 때까지 `global_temp.뷰이름`으로 조회합니다. `createTempView`는 같은 이름이 있으면 예외를 내고 `createOrReplaceTempView`는 덮어씁니다.

---

시험 안내서(2026년 10월 8일판, 2025년 10월판과 같음) 2영역의 항목은 넷입니다.

| 안내서 항목 | 이 글 |
|---|---|
| JDBC, 파일 같은 데이터 소스를 Spark SQL로 읽고 쓰기(overwrite, 컬럼 기준 파티셔닝 포함) | 1절 |
| 파일(ORC, JSON, CSV, Text, Delta)에 직접 SQL 실행, 저장 모드 | 2절, 3절 |
| 정렬과 파티셔닝을 적용해 영구 테이블에 저장 | 4절, 5절 |
| DataFrame을 임시 뷰로 등록해 SQL로 조회 | 6절 |

[Ch-01](/blog/cert/spark/spark-01-architecture)과 같은 주문 데이터에 회원과 결제를 더해 씁니다.

```python
from pyspark.sql import SparkSession
from pyspark.sql import functions as F

spark = SparkSession.builder.master("local[4]").appName("ch02-sql").getOrCreate()

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
users = spark.createDataFrame(
    [(101, "Seoul", "GOLD"), (102, "Busan", "SILVER"), (103, "Seoul", "SILVER")],
    "user_id INT, city STRING, grade STRING",
)
payments = spark.createDataFrame(
    [(9001, 1, "CARD"), (9002, 2, "BANK"), (9003, 4, "CARD")],
    "payment_id INT, order_id INT, method STRING",
)
```

## 1. 데이터 소스 읽기와 쓰기

### 1-1. Reader와 Writer의 모양

<details>
<summary>기초부터: Spark SQL과 DataFrame은 같은 엔진, 그리고 spark.read가 하는 일</summary>

> **핵심 한 줄**: `spark.sql("SELECT ...")`와 `df.filter(...).groupBy(...)`는 같은 논리 계획으로 바뀌어 같은 Catalyst 최적화기와 실행 엔진을 탑니다. 다른 것은 문법뿐입니다.

#### 1. 왜 필요한가

분석가는 SQL로, 엔지니어는 Python으로 쓰고 싶어 합니다. 엔진이 둘이면 같은 계산의 성능과 결과가 달라질 수 있습니다. Spark SQL 가이드는 어떤 API와 언어로 표현하든 같은 실행 엔진을 쓴다고 적습니다([Ch-01](/blog/cert/spark/spark-01-architecture) 1절 표). SQL로 쓰든 DataFrame으로 쓰든 [Ch-01](/blog/cert/spark/spark-01-architecture) 9-1절 토글의 Catalyst 단계를 똑같이 거칩니다.

#### 2. 같은 계산을 두 문법으로

```python
orders.createOrReplaceTempView("orders_v")

by_sql = spark.sql("""
    SELECT order_date, sum(amount) AS revenue
    FROM orders_v WHERE status = 'PAID' GROUP BY order_date
""")
by_df = (orders.filter(F.col("status") == "PAID")
               .groupBy("order_date").agg(F.sum("amount").alias("revenue")))

by_sql.explain()
by_df.explain()   # 두 물리 계획의 모양이 같을 것으로 예상합니다(실행해서 비교하지 않았습니다)
```

#### 3. spark.read가 하는 일

1. **소스 고르기**: `format()`(생략하면 `parquet`)으로 데이터 소스 구현을 고릅니다.
2. **스키마 정하기**: 지정한 스키마를 쓰거나 Parquet 파일의 메타데이터에서 읽습니다. CSV와 JSON에서 추론을 켜면 데이터를 훑어 정합니다.
3. **DataFrame 반환**: 데이터는 아직 읽지 않았습니다. "이 경로를 이 형식으로 읽는다"는 계획 한 단계가 생겼을 뿐입니다.
4. **액션 때 읽기**: 파일을 파티션([Ch-01](/blog/cert/spark/spark-01-architecture) 8절)으로 나눠 Task마다 자기 조각을 읽습니다. 필요한 컬럼만, 조건에 맞는 파일만 읽도록 최적화가 들어갑니다(1-2절, 1-4절 토글).

```text
spark.read.parquet(path)   →  계획: [Scan parquet path]        (읽지 않음)
  .filter(...).select(...) →  계획: [Scan] → [Filter] → [Project]
  .count()                 →  최적화 후 Task들이 파일 조각을 나눠 읽음
```

| 구분 | `spark.read` | `df.write` |
|---|---|---|
| 실행 시점 | 계획만 만듦(스키마 추론은 예외로 데이터를 훑음) | 호출 즉시 실행(액션) |
| 돌려주는 것 | DataFrame | 없음 |

> **정리**: 읽기는 계획의 첫 단계이고 쓰기는 계획을 실행하는 액션입니다. SQL과 DataFrame은 그 사이의 계획을 만드는 두 가지 문법입니다.

</details>

읽기는 `spark.read`(`DataFrameReader`), 쓰기는 `df.write`(`DataFrameWriter`)로 시작합니다. 형식 전용 메서드(`csv`, `json`, `parquet`, `orc`, `text`, `jdbc`)와 범용 메서드(`format().load()`, `format().save()`)가 있고 결과는 같습니다.

```python
DataFrameReader.load(path=None, format=None, schema=None, **options)
DataFrameWriter.save(path=None, format=None, mode=None, partitionBy=None, **options)
DataFrameWriter.saveAsTable(name, format=None, mode=None, partitionBy=None, **options)
```

| 항목 | 4.2.0 문서 |
|---|---|
| 형식 생략 시 | `spark.sql.sources.default`, 기본 `parquet` |
| 내장 소스의 짧은 이름 | `json`, `parquet`, `jdbc`, `orc`, `libsvm`, `csv`, `text` |
| 스키마 지정 | `StructType` 또는 DDL 문자열(예: `"col0 INT, col1 DOUBLE"`) |
| Delta | 내장 목록에 없다. 로컬에서는 `delta-spark` 패키지와 설정이 필요하고 Databricks에는 들어 있다 |

```python
# 세 줄 모두 같은 일을 한다
spark.read.parquet("/data/orders")
spark.read.format("parquet").load("/data/orders")
spark.read.load("/data/orders")              # 기본 형식 parquet

# 쓰기도 같다
orders.write.mode("overwrite").parquet("/out/orders")
orders.write.format("parquet").mode("overwrite").save("/out/orders")
```

### 1-2. 파일 소스 옵션의 기본값

<details>
<summary>기초부터: 행 기반 파일(CSV, JSON)과 열 기반 파일(Parquet, ORC)</summary>

> **핵심 한 줄**: CSV와 JSON은 한 행씩 이어 적은 텍스트이고 Parquet와 ORC는 컬럼별로 묶어 타입과 통계까지 적은 바이너리입니다. 분석 쿼리는 몇 개 컬럼만 읽는 경우가 많아서 열 기반 파일이 유리합니다.

#### 1. 왜 필요한가

주문 테이블에 컬럼이 50개 있고 `amount`의 합만 구한다고 합시다. CSV는 한 줄에 50개 값이 섞여 있어서 `amount` 하나를 꺼내려고 모든 줄을 처음부터 끝까지 읽고 쪼개야 합니다. 열 기반 파일은 `amount` 값들이 한곳에 모여 있어서 그 부분만 읽으면 됩니다.

#### 2. 어떻게 저장되나

```text
행 기반 (CSV)
1,101,PAID,32000,2026-10-01
2,102,PAID,15000,2026-10-01
3,101,CANCELED,8000,2026-10-02

열 기반 (Parquet 개념도: 행 묶음 하나 안의 컬럼 덩어리)
order_id : 1, 2, 3
user_id  : 101, 102, 101
status   : PAID, PAID, CANCELED
amount   : 32000, 15000, 8000       ← 최솟값 8000, 최댓값 32000을 메타데이터에 기록
```

#### 3. 열 기반이 빠른 이유

1. **컬럼 가지치기(column pruning)**: 쿼리에 필요한 컬럼 덩어리만 읽습니다.
2. **필터 내려보내기(predicate pushdown)**: 행 묶음(row group)마다 적힌 최솟값과 최댓값을 보고 `amount > 100000`을 만족할 수 없는 묶음은 건너뜁니다. Parquet에서는 `spark.sql.parquet.filterPushdown`(기본 true)이 이 기능을 켭니다.
3. **압축**: 같은 타입 값이 모여 있어 잘 압축됩니다. Spark의 Parquet 기본 코덱은 `snappy`입니다(`spark.sql.parquet.compression.codec`).
4. **스키마 내장**: 파일에 컬럼 이름과 타입이 들어 있어 추론할 필요가 없습니다.

#### 4. 한눈에 비교

| 구분 | CSV, JSON | Parquet, ORC |
|---|---|---|
| 저장 단위 | 행 | 행 묶음 안에서 열 |
| 스키마 | 파일에 없음. 지정하거나 추론 | 파일에 들어 있음 |
| 스키마 추론 비용 | 데이터를 훑어야 함 | 메타데이터만 읽음 |
| 일부 컬럼만 읽기 | 줄 전체를 읽어야 함 | 필요한 컬럼만 |
| 사람이 직접 읽기 | 쉬움 | 도구가 필요 |

#### 5. 헷갈리는 점

- CSV를 스키마 없이 `inferSchema` 기본값(`false`)으로 읽으면 모든 컬럼이 문자열입니다. 숫자 계산 전에 타입을 바꾸거나 처음부터 스키마를 줍니다([Ch-03](/blog/cert/spark/spark-03-dataframe-api) 7-1절 토글).
- Delta는 Parquet 데이터 파일에 트랜잭션 로그를 더한 형식입니다(2절). 열 기반의 이점을 그대로 가집니다.

> **정리**: 아래 표의 옵션 대부분이 CSV와 JSON에 몰려 있는 이유는 이 형식들이 타입 정보를 갖고 있지 않아서입니다. Parquet와 ORC는 타입과 통계를 파일에 담아 옵션이 적습니다.

</details>

시험에 문서가 없으니 형식별로 자주 쓰는 옵션의 기본값을 외워 둡니다. 4.2.0 Data Source 문서의 값입니다.

| 형식 | 옵션 | 기본값 |
|---|---|---|
| CSV | `sep`(`delimiter`) | `,` |
| CSV | `header` | `false` |
| CSV | `inferSchema` | `false`. 켜면 데이터를 한 번 더 읽는다 |
| CSV, JSON | `samplingRatio` | `1.0`(스키마 추론에 쓰는 행 비율) |
| CSV | `quote` / `escape` | `"` / `\` |
| CSV | `nullValue` | 없음(null로 볼 문자열) |
| CSV, JSON | `mode` | `PERMISSIVE` (그 밖에 `DROPMALFORMED`, `FAILFAST`) |
| CSV, JSON | `columnNameOfCorruptRecord` | `spark.sql.columnNameOfCorruptRecord` 값, 기본 `_corrupt_record` |
| CSV, JSON | `dateFormat` | `yyyy-MM-dd` |
| CSV, JSON | `multiLine` | `false` |
| CSV | `enforceSchema` | `true` |
| CSV | `encoding` | `UTF-8` |
| JSON | `primitivesAsString` | `false` |
| Text | `wholetext` | `false` |
| Text | `lineSep` | 읽기는 `\r`, `\r\n`, `\n` 모두, 쓰기는 `\n` |

`mode`의 세 값은 이렇게 다릅니다.

| mode | 깨진 레코드 처리 |
|---|---|
| `PERMISSIVE` | 깨진 문자열을 `columnNameOfCorruptRecord` 컬럼에 넣고 깨진 필드는 `null`. 스키마에 그 컬럼이 없으면 깨진 레코드를 버린다 |
| `DROPMALFORMED` | 깨진 레코드를 무시한다 |
| `FAILFAST` | 깨진 레코드를 만나면 예외를 낸다 |

```python
orders_csv = (spark.read
              .option("header", True)
              .option("mode", "FAILFAST")
              .schema("order_id INT, user_id INT, status STRING, amount INT, order_date DATE")
              .csv("/data/orders.csv"))

events = spark.read.option("multiLine", True).json("/data/events.json")   # 파일 하나가 JSON 하나일 때

lines = spark.read.text("/data/logs")   # 스키마: value STRING 한 컬럼
```

`PERMISSIVE`에서 깨진 줄을 버리지 않고 보려면 사용자 스키마에 문자열 컬럼 `_corrupt_record`를 직접 넣어야 합니다. CSV와 JSON 문서 모두 스키마에 그 컬럼이 없으면 깨진 레코드를 파싱 중에 버린다고 적습니다.

세 모드가 같은 파일에서 어떻게 갈리는지 한 줄로 따라가 보겠습니다. 주문 CSV에 금액 칸이 `abc`로 잘못 들어간 줄이 하나 섞여 있고 `header`를 켠 채 `amount INT` 스키마로 읽는다고 합시다.

```text
order_id,user_id,status,amount
1,101,PAID,32000
6,104,PAID,abc        ← amount를 INT로 바꿀 수 없음
```

| 읽는 방법 | 1번 줄 | 6번 줄 |
|---|---|---|
| `PERMISSIVE` + 스키마에 `_corrupt_record` 있음 | 정상 행, `_corrupt_record`는 null | `amount`는 null, 나머지 칸은 값이 들어가고 `_corrupt_record`에 원래 줄 `6,104,PAID,abc` |
| `PERMISSIVE` + 스키마에 그 컬럼 없음 | 정상 행 | 버려짐 |
| `DROPMALFORMED` | 정상 행 | 버려짐 |
| `FAILFAST` | 액션을 실행하는 순간 예외 | |

표의 값은 CSV 문서의 모드 설명을 이 줄에 적용한 예상이고 실행해서 본 결과가 아닙니다. `FAILFAST`도 `spark.read`를 부르는 줄에서는 조용하다가 데이터를 실제로 읽는 액션 줄에서 예외가 납니다([Ch-01](/blog/cert/spark/spark-01-architecture) 9-3절 헷갈리는 지점).

표에서 설명이 필요한 옵션이 하나 더 있습니다. `enforceSchema`(기본 `true`)는 헤더 줄과 내가 준 스키마가 다를 때 누구 말을 따를지 정합니다. `true`면 CSV 문서 표현대로 스키마를 강제로 적용하고 헤더는 무시합니다. 헤더가 `order_id,user_id`인데 스키마를 `user_id INT, order_id INT`로 주면 이름을 보고 맞추지 않고 위치대로 첫 칸이 `user_id`가 됩니다. `false`로 두고 `header`도 켜면 스키마를 헤더와 대조해 검증합니다.

```python
raw = (spark.read
       .schema("order_id INT, user_id INT, status STRING, amount INT, _corrupt_record STRING")
       .option("header", True)
       .option("mode", "PERMISSIVE")
       .csv("/data/orders.csv"))
bad = raw.filter(F.col("_corrupt_record").isNotNull())
```

스키마는 `StructType`과 DDL 문자열 둘 다 받습니다(`DataFrameReader.schema` 문서). 스키마를 주면 추론 단계를 건너뛰어 읽기가 빨라진다고 같은 문서가 적습니다.

```python
from pyspark.sql.types import StructType, StructField, IntegerType, StringType

schema_ddl = "order_id INT, status STRING"
schema_st = StructType([
    StructField("order_id", IntegerType(), True),
    StructField("status", StringType(), True),
])
spark.read.schema(schema_ddl).csv("/data/orders.csv")   # 둘은 같은 스키마
spark.read.schema(schema_st).csv("/data/orders.csv")
```

Text 형식은 쓸 때 제약이 있습니다. `DataFrameWriter.text` 문서는 DataFrame에 문자열 컬럼이 하나만 있어야 한다고 적습니다. 컬럼이 여럿이면 `concat_ws` 같은 함수로 한 컬럼으로 만든 뒤 씁니다.

### 1-3. JDBC 읽기와 쓰기

<details>
<summary>기초부터: JDBC 병렬 읽기가 쿼리를 나누는 방식</summary>

> **핵심 한 줄**: `partitionColumn`의 값 범위를 `numPartitions`개 구간으로 잘라 구간마다 WHERE 절을 붙인 쿼리를 따로 보냅니다. 구간 하나가 파티션 하나이고 DB 연결 하나입니다.

#### 1. 왜 필요한가

분할 옵션 없이 읽으면 Spark는 테이블 전체를 가져오는 쿼리 하나를 연결 하나로 보냅니다. 결과가 파티션 하나, Task 하나로 들어와서 익스큐터가 많아도 코어 하나만 일합니다.

#### 2. 어떻게 나누나 (Spark 4.2.0 `JDBCRelation.columnPartition`)

계산이 나누어떨어지도록 `lowerBound=0`, `upperBound=100000`, `numPartitions=4`로 두겠습니다.

1. **보폭 계산**: `upperBound / numPartitions - lowerBound / numPartitions` = 25000입니다.
2. **구간마다 WHERE**: 첫 구간에는 하한을 두지 않고 null도 함께 받습니다. 마지막 구간에는 상한을 두지 않습니다.
3. **Task마다 쿼리 하나**: 각 Task가 자기 WHERE 절을 붙인 쿼리로 DB에 따로 질의합니다.

```text
파티션 0: WHERE order_id < 25000 or order_id is null
파티션 1: WHERE order_id >= 25000 AND order_id < 50000
파티션 2: WHERE order_id >= 50000 AND order_id < 75000
파티션 3: WHERE order_id >= 75000
```

위 WHERE 절은 소스의 계산식에 값을 넣어 쓴 것이고 실행해서 본 쿼리 로그는 아닙니다.

본문 예제는 `lowerBound=1`입니다. 이때는 나누어떨어지지 않아서 소스가 두 가지를 더 합니다.

1. **보폭을 정수로 자름**: 정확한 보폭은 100000/4 - 1/4 = 24999.75이고 소스가 이를 `toLong`으로 잘라 24999를 씁니다.
2. **시작점을 조금 옮김**: 잘려 나간 0.75씩이 네 구간에 쌓이면 마지막 구간이 그만큼 길어집니다. 소스는 잃은 길이(0.75 x 4 = 3)의 절반쯤을 반올림한 2를 하한에 더해 첫 구간과 마지막 구간이 비슷해지게 합니다. 그래서 시작점이 1에서 3으로 옮겨집니다.

```text
경계 = 3 + 24999 = 25002, 25002 + 24999 = 50001, 50001 + 24999 = 75000

파티션 0: WHERE order_id < 25002 or order_id is null
파티션 1: WHERE order_id >= 25002 AND order_id < 50001
파티션 2: WHERE order_id >= 50001 AND order_id < 75000
파티션 3: WHERE order_id >= 75000
```

이 값은 Spark 4.2.0 `JDBCRelation.columnPartition`의 계산식을 같은 정밀도(BigDecimal 34자리)로 Python에서 따라 계산한 것입니다. 경계가 몇 칸 옮겨져도 범위 밖 값이 첫 구간과 마지막 구간에 들어간다는 성질은 그대로입니다.

#### 3. 헷갈리는 점

- 범위 밖의 값은 첫 구간과 마지막 구간에 들어갑니다. 본문의 "테이블의 모든 행이 파티션되어 반환된다"는 문장이 이 구조에서 나옵니다.
- 보폭은 값의 범위로만 정하고 실제 분포는 보지 않습니다. 주문 번호가 한쪽에 몰려 있으면 파티션 하나만 커집니다.
- `numPartitions`가 곧 DB 동시 연결 수입니다. 크게 잡을수록 DB가 받는 부하도 커집니다.

> **정리**: JDBC 병렬 읽기는 값 범위를 쪼갠 쿼리 여러 개입니다. `lowerBound`, `upperBound`는 보폭을 정하는 데만 쓰입니다.

</details>

```python
DataFrameReader.jdbc(url, table, column=None, lowerBound=None, upperBound=None,
                     numPartitions=None, predicates=None, properties=None)
DataFrameWriter.jdbc(url, table, mode=None, properties=None)
```

JDBC 드라이버 JAR는 Spark 클래스패스에 직접 넣어야 합니다. 옵션은 대소문자를 가리지 않습니다. 시험에 나올 만한 옵션만 추렸습니다.

| 옵션 | 기본값 | 범위 | 뜻 |
|---|---|---|---|
| `url` | 없음 | 읽기/쓰기 | `jdbc:subprotocol:subname` |
| `dbtable` | 없음 | 읽기/쓰기 | 테이블. 읽기에서는 `FROM`에 올 수 있는 것(서브쿼리 포함) |
| `query` | 없음 | 읽기 | `FROM`의 서브쿼리로 쓰일 쿼리. `dbtable`과도, `partitionColumn`과도 같이 쓸 수 없다 |
| `partitionColumn`, `lowerBound`, `upperBound` | 없음 | 읽기 | 병렬 읽기. 하나를 주면 셋 다와 `numPartitions`까지 줘야 한다 |
| `numPartitions` | 없음 | 읽기/쓰기 | 최대 파티션 수이자 최대 동시 JDBC 연결 수. 쓰기에서 파티션이 이보다 많으면 `coalesce(numPartitions)`로 줄인다 |
| `fetchsize` | `0` | 읽기 | 왕복 한 번에 가져올 행 수 |
| `batchsize` | `1000` | 쓰기 | 왕복 한 번에 넣을 행 수 |
| `truncate` | `false` | 쓰기 | `overwrite`일 때 테이블을 지우고 다시 만드는 대신 TRUNCATE |
| `isolationLevel` | `READ_UNCOMMITTED` | 쓰기 | 트랜잭션 격리 수준 |
| `pushDownPredicate` | `true` | 읽기 | 필터를 DB로 내려보낸다 |

`lowerBound`와 `upperBound`는 파티션 보폭을 정할 뿐 행을 걸러내지 않습니다. 문서 문장 그대로 "테이블의 모든 행이 파티션되어 반환된다." `partitionColumn`은 숫자, 날짜, 타임스탬프 컬럼이어야 합니다.

```python
jdbc_url = "jdbc:postgresql://db.example:5432/shop"   # 예시 주소
props = {"user": "reader", "password": "***"}

# 병렬 읽기: order_id 1~100000을 4개 구간으로 나눠 연결 4개로 읽는다
orders_db = (spark.read.format("jdbc")
             .option("url", jdbc_url)
             .option("dbtable", "public.orders")
             .option("partitionColumn", "order_id")
             .option("lowerBound", "1")
             .option("upperBound", "100000")
             .option("numPartitions", "4")
             .option("user", props["user"])
             .option("password", props["password"])
             .load())

# 서브쿼리를 partitionColumn과 쓰려면 query 대신 dbtable에 별칭과 함께 넣는다
paid_db = (spark.read.format("jdbc")
           .option("url", jdbc_url)
           .option("dbtable", "(SELECT order_id, amount FROM orders WHERE status = 'PAID') AS t")
           .option("partitionColumn", "order_id")
           .option("lowerBound", "1").option("upperBound", "100000")
           .option("numPartitions", "4")
           .load())

# 쓰기: 기본 모드는 errorifexists
orders.write.jdbc(jdbc_url, "public.orders_copy", mode="append", properties=props)
```

### 1-4. overwrite와 partitionBy

<details>
<summary>기초부터: 디스크의 파티션 디렉터리와 파티션 가지치기</summary>

> **핵심 한 줄**: `partitionBy`는 컬럼 값별로 폴더를 나눠 쓰는 기능입니다. 읽을 때 그 컬럼으로 거르면 맞는 폴더만 열어서 읽는 양이 줄어듭니다(파티션 가지치기).

#### 1. 왜 필요한가

3년 치 주문이 한 폴더에 있으면 "10월 3일 주문"만 보려 해도 모든 파일을 열어 날짜를 확인해야 합니다. 날짜별 폴더로 나눠 두면 폴더 이름만 보고 나머지를 건너뜁니다.

#### 2. 어떻게 동작하나

1. **쓰기**: Task마다 자기 파티션의 행을 `order_date` 값별로 나눠 해당 폴더에 파일로 씁니다.
2. **폴더 이름이 값**: 파일 안에는 `order_date`를 저장하지 않고 폴더 이름(`order_date=2026-10-03`)이 그 값을 대신합니다.
3. **읽기**: 경로 아래 폴더 이름을 훑어 파티션 컬럼을 스키마 끝에 붙입니다(이 절 Partition Discovery 문단).
4. **가지치기**: 조건이 `order_date = '2026-10-03'`이면 그 폴더만 읽습니다. `explain()`의 파일 스캔 줄에 `PartitionFilters`로 조건이 보입니다.

```text
spark.read.parquet("/out/orders_by_date").filter("order_date = '2026-10-03'")

/out/orders_by_date/
├── order_date=2026-10-01/   건너뜀
├── order_date=2026-10-02/   건너뜀
└── order_date=2026-10-03/   읽음
```

#### 3. 두 가지 "파티션"

| 구분 | 메모리 파티션([Ch-01](/blog/cert/spark/spark-01-architecture) 8절) | 디스크 파티션(`partitionBy`) |
|---|---|---|
| 무엇 | DataFrame을 나눈 조각. Task 하나의 몫 | 컬럼 값별 폴더 |
| 정하는 것 | `maxPartitionBytes`, `shuffle.partitions`, `repartition` | `partitionBy`에 준 컬럼 |
| 수명 | 실행하는 동안 | 파일로 남음 |
| 효과 | 병렬도 | 읽는 범위 줄이기 |

#### 4. 헷갈리는 점

- 출력 파일 수는 "Task 수 × 각 Task가 만난 값의 수"까지 늘 수 있습니다. 메모리 파티션 200개가 저마다 365개 날짜를 섞어 갖고 있으면 파일이 최대 200 × 365개 생깁니다. 쓰기 전에 `repartition("order_date")`로 같은 날짜를 한 파티션에 모으면 날짜당 파일 수가 줄어듭니다.
- 고유값이 아주 많은 컬럼은 폴더가 너무 많이 생깁니다. 그런 컬럼은 `bucketBy`를 씁니다(4-2절).

> **정리**: 디스크 파티션은 폴더로 데이터를 미리 나눠 읽기 범위를 줄이는 장치입니다. 실행 중의 메모리 파티션과 이름만 같고 하는 일은 다릅니다.

</details>

`partitionBy(*cols)`는 출력을 Hive 파티셔닝처럼 `컬럼=값` 디렉터리로 나눕니다. 시험 안내서 샘플 문항 1번이 정확히 이 조합(`mode("overwrite").partitionBy("country").parquet(...)`)을 묻습니다.

```python
(orders.write
       .mode("overwrite")
       .partitionBy("order_date")
       .parquet("/out/orders_by_date"))
```

문서 기준으로 예상하는 디렉터리 구조입니다. 파일 이름은 실행마다 다릅니다.

```text
/out/orders_by_date/
├── order_date=2026-10-01/part-....parquet
├── order_date=2026-10-02/part-....parquet
└── order_date=2026-10-03/part-....parquet
```

Parquet 문서의 Partition Discovery 절에 따르면 파티션 컬럼 값은 디렉터리 경로에 담깁니다. 테이블 경로를 읽으면 Spark가 경로에서 파티션 컬럼을 꺼내 스키마 끝에 붙입니다. 타입은 숫자, 날짜, 타임스탬프, 문자열 중에서 추론하고(`spark.sql.sources.partitionColumnTypeInference.enabled`, 기본 true) 끄면 문자열이 됩니다. 1.6.0부터는 넘긴 경로 아래에서만 파티션을 찾으므로 `order_date=2026-10-01` 하위 경로만 읽으면 `order_date` 컬럼이 생기지 않습니다. 이때는 `basePath` 옵션으로 테이블 경로를 알려 줍니다.

파티션된 경로에 overwrite할 때 지우는 범위는 `spark.sql.sources.partitionOverwriteMode`가 정합니다.

| 값 | 동작(Configuration 문서) |
|---|---|
| `STATIC`(기본) | 덮어쓰기 전에 조건에 맞는 파티션을 모두 지운다. 2.3 이전 동작을 유지하려는 기본값 |
| `DYNAMIC` | 미리 지우지 않고 실행 중 데이터가 쓰인 파티션만 덮어쓴다 |

같은 값을 쓰기 옵션 `partitionOverwriteMode`로 줄 수 있고 옵션이 설정보다 우선합니다.

두 모드 차이는 결과 폴더를 나란히 놓으면 바로 보입니다. 경로에 10월 1~3일 폴더가 있고 10월 3일 행만 담은 `fix`를 overwrite로 쓴다고 합시다.

| 폴더 | 쓰기 전 | `STATIC`(기본)으로 쓴 뒤 | `DYNAMIC`으로 쓴 뒤 |
|---|---|---|---|
| `order_date=2026-10-01/` | 있음 | 사라짐 | 그대로 |
| `order_date=2026-10-02/` | 있음 | 사라짐 | 그대로 |
| `order_date=2026-10-03/` | 옛 데이터 | 새 데이터 | 새 데이터로 교체 |

`STATIC`의 "조건에 맞는 파티션"은 `INSERT OVERWRITE ... PARTITION (order_date='2026-10-03')`처럼 파티션 값을 고정해 줄 때의 조건입니다. DataFrame 쓰기는 그런 조건이 없으니 경로 아래 파티션 전체가 지울 대상이 됩니다. 매일 그날 파티션만 다시 쓰는 배치에서 이 기본값을 모르고 돌리면 지난 날짜가 전부 사라집니다. 같은 날짜를 몇 번 다시 돌려도 결과가 같게 만드는 쓰기 패턴은 [DE Ch-03](/blog/data/foundations/de-03-idempotency-retry-backoff)에서 더 다룹니다.

```python
# 10월 3일 파티션만 다시 쓰고 나머지 날짜는 남긴다
fix = orders.filter("order_date = '2026-10-03'")
(fix.write
    .mode("overwrite")
    .option("partitionOverwriteMode", "dynamic")
    .partitionBy("order_date")
    .parquet("/out/orders_by_date"))
```

### 헷갈리는 지점

- `mode`를 빼고 이미 있는 경로에 쓰면 예외가 납니다. 기본값이 `errorifexists`라서 샘플 문항 1번의 B 보기는 두 번째 실행부터 실패합니다.
- `partitionBy`를 빼고 `overwrite`하면 파티션 디렉터리 없이 파일만 생깁니다. 샘플 문항 1번의 C 보기가 이 경우입니다.
- `option("header", True)`는 CSV에만 뜻이 있습니다. Parquet와 ORC는 스키마를 파일에 담고 있어서 헤더 개념이 없습니다.
- 4.0부터 ORC 압축 기본값이 `snappy`에서 `zstd`로 바뀌었습니다(4.2.0 SQL Migration Guide).

## 2. 파일에 직접 SQL 실행

테이블이나 뷰를 만들지 않고 파일 경로를 테이블처럼 씁니다. 문법은 `형식.`경로``이고 경로는 백틱으로 감쌉니다.

```sql
SELECT * FROM parquet.`/out/orders_by_date`;
SELECT * FROM orc.`/out/orders_orc`;
SELECT * FROM json.`/data/events.json`;
SELECT * FROM csv.`/data/orders.csv`;
SELECT * FROM text.`/data/logs`;
SELECT * FROM delta.`/out/orders_delta`;
```

Python에서는 `spark.sql()`에 그대로 넣습니다. 결과는 DataFrame입니다.

```python
spark.sql("SELECT order_date, sum(amount) AS revenue "
          "FROM parquet.`/out/orders_by_date` GROUP BY order_date").show()
```

형식마다 결과가 다릅니다.

| 형식 | 직접 SQL의 결과 | 근거 |
|---|---|---|
| Parquet, ORC | 파일에 든 스키마 그대로 | SQL 레퍼런스 File 문서 예제 |
| JSON | 스키마를 추론해 컬럼으로 | 같은 문서 예제 |
| CSV | Databricks 문서는 옵션을 줄 수 없다고 적는다. `header` 기본값 `false`이므로 첫 줄도 데이터로 읽는다 | Databricks CSV 문서, Spark CSV 옵션 기본값 |
| Text | `value` 문자열 컬럼 하나 | Spark Text 문서 |
| Delta | 테이블의 현재 버전 | Delta Lake 문서 `delta.`/path`` |

CSV에 옵션이 필요하면 직접 SQL 대신 옵션을 붙인 임시 뷰를 만듭니다. Databricks CSV 문서의 예제와 같은 모양입니다. Databricks는 SQL 사용자가 CSV를 읽을 때 `read_files` 테이블 함수를 권합니다. 이 함수는 Databricks Runtime 13.3 LTS 이상에서 쓸 수 있습니다.

```sql
CREATE OR REPLACE TEMPORARY VIEW orders_csv
USING CSV
OPTIONS (path "/data/orders.csv", header "true", inferSchema "true", mode "FAILFAST");

SELECT status, count(*) FROM orders_csv GROUP BY status;
```

Delta를 로컬에서 쓰려면 Delta Lake Quick Start가 적은 설정이 필요합니다. Delta 릴리스 호환표(2026년 10월 20일 열람)는 최신 Delta 4.3.x가 Spark 4.0.x와 4.1.x를 지원한다고 적고 Spark 4.2는 아직 표에 없습니다. Spark 3.5.x는 Delta 3.1~3.3.x와 짝입니다. Spark 4.2.0 이미지에서 Delta를 쓰기 전에 이 표를 먼저 봅니다.

```python
# pip install delta-spark   (Spark 버전과 맞는 delta-spark 버전은 Delta 릴리스 호환표에서 확인)
from delta import configure_spark_with_delta_pip

builder = (SparkSession.builder
           .config("spark.sql.extensions", "io.delta.sql.DeltaSparkSessionExtension")
           .config("spark.sql.catalog.spark_catalog",
                   "org.apache.spark.sql.delta.catalog.DeltaCatalog"))
spark = configure_spark_with_delta_pip(builder).getOrCreate()

orders.write.format("delta").mode("overwrite").save("/out/orders_delta")
spark.sql("SELECT count(*) FROM delta.`/out/orders_delta`").show()
```

Delta 읽기와 쓰기도 `format("delta")`만 바꾸면 1절의 Reader/Writer 모양 그대로입니다. Delta Lake의 Table batch reads and writes 문서에서 시험 범위와 닿는 옵션만 골랐습니다.

| 하고 싶은 일 | 코드 | 문서 설명 |
|---|---|---|
| 경로로 쓰기 | `df.write.format("delta").save(path)` | 저장 모드는 1절과 같다 |
| 테이블로 쓰기 | `df.write.format("delta").saveAsTable("shop.orders_d")` | DataFrame 스키마로 메타스토어에 테이블을 만들고 쓴다 |
| 스키마까지 바꿔 덮어쓰기 | `.mode("overwrite").option("overwriteSchema", "true")` | 이 옵션 없이 overwrite하면 기존 스키마를 유지한다 |
| 새 컬럼을 붙여 추가 | `.mode("append").option("mergeSchema", "true")` | 쓰기 한 번에만 적용. 세션 전체 설정보다 이쪽을 권한다 |
| 조건에 맞는 행만 교체 | `.mode("overwrite").option("replaceWhere", "order_date = '2026-10-03'")` | 조건에 맞는 행만 원자적으로 덮어쓴다 |
| 이전 버전 읽기 | `spark.read.format("delta").option("versionAsOf", 0).load(path)` | `timestampAsOf`는 날짜나 타임스탬프 문자열만 받는다 |

Delta 테이블에서 임의 조건에 맞는 행만 골라 바꿀 때는 `replaceWhere`를 씁니다.

### 헷갈리는 지점

- 경로를 감싸는 기호는 백틱(`` ` ``)입니다. 작은따옴표로 감싸면 문자열 리터럴이 됩니다.
- 헤더 없이 읽은 CSV의 컬럼 이름은 `_c0`, `_c1`, `_c2` 순서로 붙습니다. CSV 문서의 예제가 `spark.read.csv(path)` 결과를 `_c0` 컬럼으로 보여 주고 첫 줄 `name;age;job`이 데이터 행으로 나옵니다. 직접 SQL도 같습니다. Spark 4.2.0 소스의 `ResolveSQLOnFile` 규칙은 파일 직접 SQL을 `spark.read`와 같은 `DataSource`로 바꾸면서 옵션을 따로 넣지 않습니다. 그래서 `header`가 기본값 `false`로 남고 `CSVUtils`가 컬럼 이름을 `_c` 뒤에 위치 번호를 붙여 만듭니다.
- Delta에 overwrite하면 Delta는 트랜잭션 로그로 이전 버전을 남깁니다. Delta Lake 문서는 지금 테이블에 없는 데이터를 트랜잭션 로그로 읽는 기능을 time travel이라고 적습니다. Parquet 경로 overwrite는 기존 파일을 지우고 씁니다.

## 3. 저장 모드

### 3-1. 네 가지 모드

<details>
<summary>기초부터: 쓰기는 Task마다 파일을 따로 쓴다</summary>

> **핵심 한 줄**: `df.write`는 Task마다 자기 파티션을 파일로 쓰고 모든 Task가 끝나면 드라이버가 작업 전체를 확정(commit)하는 분산 작업입니다.

#### 1. 왜 알아야 하나

출력 경로에 폴더가 생기고 그 안에 `part-00000-...` 파일이 여러 개 생기는 모습이 처음에는 낯섭니다. 저장 모드가 원자적이지 않다는 아래 문서 문장도 이 구조를 알면 이해됩니다.

#### 2. 어떻게 동작하나

1. **모드 확인**: 드라이버가 대상이 이미 있는지 보고 저장 모드를 적용합니다. `errorifexists`면 여기서 예외, `ignore`면 여기서 끝, `overwrite`면 기존 데이터를 지웁니다.
2. **Task별 쓰기**: 각 Task가 자기 파티션의 행을 파일로 씁니다.
3. **확정**: Task가 쓴 파일은 Task 단위와 Job 단위의 커밋을 거쳐 최종 경로에 보이게 됩니다. 커밋하는 방식은 출력 커미터 구현에 따라 다릅니다.

```text
orders (메모리 파티션 4개)
 Task 0 ─► part-00000-....parquet
 Task 1 ─► part-00001-....parquet
 Task 2 ─► part-00002-....parquet
 Task 3 ─► part-00003-....parquet
           └─► 모두 성공하면 Job 커밋 → /out/orders/ 에서 보임
```

#### 3. 모드별로 1단계에서 하는 일

| 모드 | 대상이 이미 있을 때 1단계 | 이후 |
|---|---|---|
| `errorifexists` | 예외 | 쓰지 않음 |
| `ignore` | 아무것도 하지 않고 끝 | 쓰지 않음 |
| `append` | 기존 데이터 유지 | 새 파일을 더함 |
| `overwrite` | 기존 데이터 삭제 | 새 파일을 씀 |

`overwrite`는 1단계에서 지우고 2~3단계에서 쓰므로 그 사이에 실패하면 옛 데이터는 이미 사라진 뒤입니다. 아래 문서 주의 2번이 이 상황입니다.

3단계의 "확정"이 출력 폴더에서 어떻게 보이는지도 알아 두면 좋습니다. Spark가 기본으로 쓰는 Hadoop `FileOutputCommitter`의 알고리즘 1번(`spark.hadoop.mapreduce.fileoutputcommitter.algorithm.version` 기본 1) 기준입니다.

1. Task는 처음에 최종 경로 대신 `/out/orders/_temporary/...` 아래 자기 몫의 임시 폴더에 씁니다.
2. Task가 성공하면 그 폴더를 Job 시도용 폴더로 이름을 바꿔 옮깁니다(Task 커밋).
3. 모든 Task가 끝나면 드라이버가 파일을 `/out/orders/` 바로 아래로 옮기고 `_temporary`를 지운 뒤 빈 파일 `_SUCCESS`를 남깁니다(Job 커밋).

그래서 출력 폴더에 `_SUCCESS`가 있으면 Job 커밋까지 끝났다는 표시이고 `_temporary`가 남아 있으면 중간에 멈춘 흔적입니다. 다음 단계 작업이 `_SUCCESS`를 보고 시작하게 만드는 파이프라인이 많은 이유입니다. 이 순서는 Hadoop `mapred-default.xml`의 알고리즘 설명에 적혀 있습니다. S3 같은 객체 저장소는 이름 바꾸기를 복사로 흉내 내서 이 방식이 느리고 실패하면 상태를 알 수 없게 될 수 있다고 Spark의 [Cloud Integration](https://spark.apache.org/docs/latest/cloud-integration.html) 문서가 경고합니다. 객체 저장소에서는 이름을 바꾸지 않는 전용 커미터를 쓰라는 것이 같은 문서의 권고입니다.

#### 4. 헷갈리는 점

- 출력 파일 수는 쓰기 직전의 파티션 수를 따릅니다. `partitionBy`를 함께 쓰면 더 늘어납니다(1-4절 토글).
- 파일 하나로 받고 싶으면 `coalesce(1)` 뒤에 씁니다. Task 하나가 전부 쓰므로 느려집니다([Ch-01](/blog/cert/spark/spark-01-architecture) 8-3절).

> **정리**: 쓰기는 여러 Task가 나눠 하는 일이고 저장 모드는 그 앞에서 대상 경로를 어떻게 다룰지를 정합니다.

</details>

Generic Load/Save Functions 문서(4.2.0)의 표를 옮깁니다.

| Scala/Java | 문자열 | 데이터가 이미 있을 때 |
|---|---|---|
| `SaveMode.ErrorIfExists`(기본) | `"error"`, `"errorifexists"`(기본) | 예외를 낸다 |
| `SaveMode.Append` | `"append"` | 기존 데이터 뒤에 붙인다 |
| `SaveMode.Overwrite` | `"overwrite"` | DataFrame 내용으로 덮어쓴다 |
| `SaveMode.Ignore` | `"ignore"` | 아무것도 쓰지 않고 기존 데이터도 건드리지 않는다. SQL의 `CREATE TABLE IF NOT EXISTS`와 비슷하다 |

같은 문서가 붙인 주의 두 가지가 중요합니다.

1. 저장 모드는 잠금을 쓰지 않고 원자적이지 않습니다.
2. `Overwrite`는 새 데이터를 쓰기 전에 기존 데이터를 지웁니다. 쓰기가 중간에 실패하면 기존 데이터도 새 데이터도 온전하지 않은 상태가 될 수 있습니다(문서 문장에서 이끌어 낸 결론입니다).

모드를 주는 방법은 세 가지이고 결과는 같습니다.

```python
orders.write.mode("append").parquet("/out/orders")
orders.write.parquet("/out/orders", mode="append")
orders.write.save("/out/orders", format="parquet", mode="append")
```

### 3-2. 테이블에 쓸 때의 차이

`saveAsTable`과 `insertInto`는 컬럼을 맞추는 방식이 다릅니다.

| 메서드 | 컬럼 맞추기 | 기존 테이블이 있을 때 |
|---|---|---|
| `saveAsTable(name, mode=...)` | 이름으로 | 모드를 따른다(기본 예외). `append`면 기존 테이블의 형식과 옵션을 쓰고 컬럼 순서가 달라도 된다. `overwrite`면 스키마가 기존과 같지 않아도 된다 |
| `insertInto(tableName, overwrite=None)` | 위치로(이름 무시) | 테이블이 이미 있어야 하고 스키마가 같아야 한다. `overwrite` 기본은 꺼짐. `partitionBy`, `bucketBy`와 같이 쓰면 오류 |

```python
orders.write.mode("overwrite").saveAsTable("shop.orders")

# 컬럼 순서를 바꾼 DataFrame
reordered = orders.select("amount", "order_id", "user_id", "status", "order_date")
reordered.write.mode("append").saveAsTable("shop.orders")   # 이름으로 맞춰 들어간다
reordered.write.insertInto("shop.orders")                   # 위치로 들어간다. 아래 표처럼 이 줄은 오류가 난다
```

`insertInto`가 위치로 맞춘다는 말을 칸마다 따라가 보면 이렇습니다. 테이블은 `order_id INT, user_id INT, status STRING, amount INT, order_date STRING` 순서입니다.

| 위치 | `reordered`의 컬럼(타입) | 들어가는 테이블 컬럼(타입) | 결과 |
|---|---|---|---|
| 1 | `amount`(INT) | `order_id`(INT) | 타입이 같아 그대로 들어감. 금액이 주문 번호 칸에 |
| 2 | `order_id`(INT) | `user_id`(INT) | 그대로 들어감. 주문 번호가 회원 번호 칸에 |
| 3 | `user_id`(INT) | `status`(STRING) | 숫자를 문자열로 바꾸는 것은 허용 |
| 4 | `status`(STRING) | `amount`(INT) | 문자열을 숫자 칸에 넣는 것은 거부 |
| 5 | `order_date`(STRING) | `order_date`(STRING) | 그대로 |

4번 칸 때문에 이 쓰기는 실패합니다. Spark 3.0부터 `spark.sql.storeAssignmentPolicy` 기본값이 `ANSI`이고 [ANSI Compliance](https://spark.apache.org/docs/latest/sql-ref-ansi-compliance.html) 문서의 저장 규칙 표는 문자열을 숫자 칸에 넣는 것을 허용하지 않습니다(`Cannot safely cast ... "STRING" to "INT"`). 더 위험한 경우는 오류가 나지 않을 때입니다. 1번과 2번처럼 타입이 같은 컬럼끼리 순서만 바뀌면 경고 없이 금액이 주문 번호 칸에 들어갑니다. 위 표는 문서의 규칙을 적용한 예상이고 실행해 본 결과가 아닙니다.

SQL로는 `INSERT INTO`와 `INSERT OVERWRITE`가 각각 append와 overwrite에 대응합니다.

```sql
INSERT INTO shop.orders SELECT * FROM orders_v;
INSERT OVERWRITE shop.orders SELECT * FROM orders_v WHERE status = 'PAID';
```

### 헷갈리는 지점

- `"error"`와 `"errorifexists"`는 같은 모드입니다. 보기에 둘이 따로 나오면 둘 다 기본값입니다.
- `ignore`는 대상이 이미 있으면 쓰기 자체를 건너뛰고 오류도 내지 않습니다. 대상이 없으면 평소처럼 씁니다. 그래서 쓰기가 실제로 일어났는지 코드만 보고 알 수 없습니다.
- `insertInto`의 위치 기반 매칭은 `union`의 위치 기반 매칭과 같은 함정입니다([Ch-03](/blog/cert/spark/spark-03-dataframe-api) 6절).

## 4. 영구 테이블: partitionBy, bucketBy, sortBy

<details>
<summary>기초부터: 버킷팅은 무엇이고 왜 셔플을 줄이나</summary>

> **핵심 한 줄**: 버킷팅은 키의 해시값으로 행을 고정된 n개 버킷에 미리 나눠 저장하는 방식입니다. 같은 키는 항상 같은 번호의 버킷에 들어가므로 나중에 그 키로 조인하거나 집계할 때 셔플을 건너뛸 수 있습니다.

#### 1. 왜 필요한가

주문과 회원을 `user_id`로 매일 조인하면 매번 양쪽을 `user_id`로 셔플합니다([Ch-01](/blog/cert/spark/spark-01-architecture) 8-2절 토글). 섞는 방식은 매번 같은데 비용도 매번 냅니다. 저장할 때 한 번 키별로 나눠 두면 읽을 때 다시 섞을 일이 줄어듭니다.

#### 2. 어떻게 동작하나

1. **저장**: 행마다 버킷 번호(키 해시값을 버킷 수로 나눈 나머지)를 계산해 그 버킷 파일에 씁니다.
2. **테이블 정보에 기록**: 버킷 컬럼과 버킷 수를 메타스토어의 테이블 정보에 남깁니다. 이 정보가 메타스토어에 있어야 하므로 `saveAsTable`로 만든 영구 테이블에서만 씁니다.
3. **조인할 때**: 양쪽 테이블이 같은 키, 같은 버킷 수로 버킷팅돼 있으면 Spark가 같은 번호 버킷끼리 바로 조인합니다. 물리 계획에서 그 쪽의 `Exchange`(셔플)가 빠집니다.

```text
orders (bucketBy 8, user_id)            users (bucketBy 8, user_id)
 버킷 0 : 해시(user_id) % 8 = 0  ◄─조인─►  버킷 0
 버킷 1                          ◄─조인─►  버킷 1
 ...                                       ...
 버킷 7                          ◄─조인─►  버킷 7
 같은 번호끼리 만나므로 셔플 없이 조인
```

#### 3. partitionBy와 비교

| 구분 | `partitionBy` | `bucketBy` |
|---|---|---|
| 나누는 기준 | 값 그대로 | 해시값을 버킷 수로 나눈 나머지 |
| 나뉘는 개수 | 고유값 수만큼 폴더 | n개로 고정 |
| 얻는 것 | 필터할 때 폴더 건너뛰기 | 조인, 집계할 때 셔플 생략 |
| 맞는 컬럼 | 날짜처럼 고유값이 적고 필터에 쓰는 컬럼 | `user_id`처럼 고유값이 많고 조인 키로 쓰는 컬럼 |

#### 4. 헷갈리는 점

- 두 테이블의 버킷 수가 다르면 기본 설정에서 셔플이 다시 생길 수 있습니다. 같이 조인할 테이블은 같은 키, 같은 버킷 수로 맞춥니다.
- 조인 방식 자체(sort merge 조인, broadcast 조인)는 [Ch-03](/blog/cert/spark/spark-03-dataframe-api) 5-3절 토글에서 봅니다.

> **정리**: `partitionBy`는 읽는 범위를 줄이고 `bucketBy`는 셔플을 줄입니다. 아래 4-2절의 선택 기준이 이 차이에서 나옵니다.

</details>

### 4-1. 시그니처와 제약

```python
DataFrameWriter.partitionBy(*cols)
DataFrameWriter.bucketBy(numBuckets, col, *cols)
DataFrameWriter.sortBy(col, *cols)
DataFrameWriter.saveAsTable(name, format=None, mode=None, partitionBy=None, **options)
```

| 기능 | 결과 | 쓸 수 있는 곳 |
|---|---|---|
| `partitionBy` | 파티션 컬럼 값마다 디렉터리 | `save`와 `saveAsTable` 모두 |
| `bucketBy(n, col)` | 컬럼 해시로 고정된 n개 버킷 파일 | 파일 기반 소스 + `saveAsTable`만 |
| `sortBy(col)` | 각 버킷 안을 정렬 | 버킷과 함께, 영구 테이블만 |

문서 문장 그대로 "버킷팅과 정렬은 영구 테이블에만 적용된다." `bucketBy`의 해시 함수는 Hive 버킷팅과 다르고 호환되지 않는다고 `bucketBy` 문서가 적습니다. 버킷 수 상한은 `spark.sql.sources.bucketing.maxBuckets`(기본 100000)이고 `spark.sql.sources.bucketing.enabled`(기본 true)를 끄면 버킷 테이블을 일반 테이블처럼 다룹니다.

```python
# 주문 날짜로 파티션하고 회원 ID로 버킷을 나눈 뒤 버킷 안을 금액 순으로 정렬
(orders.write
       .mode("overwrite")
       .partitionBy("order_date")
       .bucketBy(8, "user_id")
       .sortBy("amount")
       .saveAsTable("shop.orders_bucketed"))

# 경로 저장(save, parquet 등)에 bucketBy를 쓰면 오류: 'save' does not support bucketBy right now.
# orders.write.bucketBy(8, "user_id").parquet("/out/x")

# bucketBy 없이 sortBy만 쓰면 오류: sortBy must be used together with bucketBy.
# orders.write.sortBy("amount").saveAsTable("shop.x")
```

두 오류 문장은 실행 결과가 아닙니다. Spark 4.2.0 소스의 `DataFrameWriter`와 오류 정의 파일(`error-conditions.json`)에서 확인했습니다. `save`와 `insertInto`는 쓰기 전에 버킷 지정 여부를 검사해서 `bucketBy`만 있으면 `_LEGACY_ERROR_TEMP_1312`, `sortBy`까지 있으면 "does not support bucketBy and sortBy right now"(`_LEGACY_ERROR_TEMP_1313`)를 냅니다. 버킷 수 없이 정렬 컬럼만 있으면 `SORT_BY_WITHOUT_BUCKETING` 오류입니다. 쓰기 메서드는 액션이라 이 오류는 그 줄을 실행하는 순간 납니다.

### 4-2. partitionBy와 bucketBy 고르기

Generic Load/Save Functions 문서는 이렇게 구분합니다. `partitionBy`는 디렉터리 구조를 만들기 때문에 카디널리티가 큰 컬럼에는 쓰기 어렵습니다. `bucketBy`는 데이터를 고정된 수의 버킷에 나누므로 고유값 수에 상한이 없을 때 쓸 수 있습니다.

| 컬럼 | 고유값 | 고를 것 |
|---|---|---|
| `order_date` | 하루에 하나, 1년이면 365개 | `partitionBy`. 날짜 조건으로 디렉터리를 건너뛸 수 있다 |
| `user_id` | 회원 수만큼 | `bucketBy`. `partitionBy`면 회원마다 디렉터리가 생긴다 |
| `status` | 서너 개 | `partitionBy`도 되지만 파티션당 데이터가 너무 크면 나누는 효과가 작다 |

SQL 레퍼런스의 `CREATE TABLE ... USING`은 `CLUSTERED BY`를 "데이터 파티셔닝을 정해 셔플을 피하는 최적화"라고 설명합니다. 같은 키로 버킷팅된 두 테이블을 조인할 때 셔플을 줄일 수 있다는 뜻으로 읽으면 됩니다.

### 4-3. SQL로 만들기

```sql
CREATE TABLE [ IF NOT EXISTS ] table_identifier
    [ ( col_name1 col_type1 [ COMMENT col_comment1 ], ... ) ]
    USING data_source
    [ OPTIONS ( key1=val1, key2=val2, ... ) ]
    [ PARTITIONED BY ( col_name1, col_name2, ... ) ]
    [ CLUSTERED BY ( col_name3, col_name4, ... )
        [ SORTED BY ( col_name [ ASC | DESC ], ... ) ]
        INTO num_buckets BUCKETS ]
    [ LOCATION path ]
    [ COMMENT table_comment ]
    [ TBLPROPERTIES ( key1=val1, key2=val2, ... ) ]
    [ AS select_statement ]
```

`SORTED BY`의 기본 방향은 `ASC`입니다. `USING`과 `AS SELECT` 사이의 절은 순서를 바꿔 써도 됩니다.

```sql
CREATE TABLE shop.orders_sql
USING parquet
PARTITIONED BY (order_date)
CLUSTERED BY (user_id) SORTED BY (amount DESC) INTO 8 BUCKETS
AS SELECT * FROM orders_v;
```

Python API와 SQL 이름이 엇갈립니다.

| Python `DataFrameWriter` | SQL `CREATE TABLE` |
|---|---|
| `partitionBy` | `PARTITIONED BY` |
| `bucketBy` | `CLUSTERED BY ... INTO n BUCKETS` |
| `sortBy` | `SORTED BY` |
| `option("path", ...)` | `LOCATION` |

### 헷갈리는 지점

- `DataFrameWriter.sortBy`는 버킷 안을 정렬해 파일로 남깁니다. `DataFrame.sort`/`orderBy`는 DataFrame 결과를 정렬하는 트랜스포메이션입니다. 이름이 비슷해서 보기에 섞여 나옵니다.
- Spark 4.0부터 `USING`과 `STORED AS` 없이 `CREATE TABLE`을 쓰면 `spark.sql.sources.default`(기본 parquet)를 형식으로 씁니다. 3.5까지는 Hive 형식이었습니다. 되돌리려면 `spark.sql.legacy.createHiveTableByDefault=true`를 줍니다(4.2.0 SQL Migration Guide). 3.x 자료로 공부하면 이 부분이 다릅니다.
- `DataFrameWriterV2`(`df.writeTo("t")`)에는 `partitionedBy`, `clusterBy`, `create`, `createOrReplace`, `append`, `overwritePartitions` 같은 메서드가 따로 있습니다. 시험 안내서는 `bucketBy`/`sortBy` 쪽을 묻는 것으로 보여 여기서는 이름만 적습니다.

## 5. 관리형 테이블과 외부 테이블

<details>
<summary>기초부터: 테이블은 파일과 메타데이터 두 부분이다</summary>

> **핵심 한 줄**: 테이블은 데이터 파일과 그 파일을 설명하는 메타데이터로 이뤄집니다. 메타데이터를 보관하는 곳이 메타스토어(카탈로그)이고 관리형과 외부 테이블은 `DROP TABLE`이 파일까지 지우는지로 갈립니다.

#### 1. 왜 필요한가

경로만 있으면 매번 `spark.read.format("parquet").load("/lake/orders_ext")`처럼 경로와 형식을 기억해 적어야 합니다. `shop.orders` 같은 이름만으로 부르려면 이름마다 위치, 형식, 스키마, 파티션을 적어 둔 장부가 필요합니다.

#### 2. 어떻게 동작하나

1. **만들기**: `saveAsTable`이나 `CREATE TABLE`이 파일을 쓰고 메타스토어에 테이블 항목을 만듭니다.
2. **조회**: SQL이나 `spark.table("shop.orders")`가 이름을 쓰면 분석 단계([Ch-01](/blog/cert/spark/spark-01-architecture) 9-1절 토글)에서 카탈로그를 찾아 위치와 스키마를 알아낸 뒤 파일 스캔으로 바꿉니다.
3. **삭제**: `DROP TABLE`이 메타스토어 항목을 지웁니다. 관리형이면 파일도 지웁니다.

```text
메타스토어(장부)                       저장소(파일)
shop.orders_managed ──► spark-warehouse/shop.db/orders_managed/   Spark가 관리
shop.orders_ext     ──► /lake/orders_ext/                          사용자가 관리
```

| 장부에 적는 것 | 예 |
|---|---|
| 위치 | `/lake/orders_ext` |
| 형식 | `parquet` |
| 스키마 | 컬럼 이름과 타입 |
| 파티션, 버킷 정보 | `order_date`, 버킷 8개 |

#### 3. 헷갈리는 점

- 로컬 PySpark 스크립트에서 `enableHiveSupport()` 없이 만든 세션은 카탈로그를 메모리에 둡니다. Spark 4.2.0 소스의 `spark.sql.catalogImplementation` 기본값이 `in-memory`이고 `enableHiveSupport()`가 이 값을 `hive`로 바꿉니다. 메모리 카탈로그의 테이블 항목은 애플리케이션이 끝나면 사라지고 파일만 남습니다. 5-1절 본문과 5-2절 표의 Derby 메타스토어는 Hive 지원을 켰을 때의 이야기입니다. `pyspark` 셸은 Hive 클래스가 있으면 Hive 지원을 켠 세션을 만듭니다(같은 소스의 `_create_shell_session`).
- Databricks에서는 Unity Catalog가 이 장부 역할을 합니다(5-2절).

> **정리**: 테이블 이름은 장부의 한 줄이고 데이터는 파일에 있습니다. 관리형은 장부와 파일을 Spark가 함께 관리하고 외부 테이블은 장부만 관리합니다.

</details>

### 5-1. Apache Spark 기준

`saveAsTable`은 DataFrame 내용을 실체화하고 메타스토어에 그 데이터를 가리키는 포인터를 만듭니다. 메타스토어 연결이 같으면 프로그램을 다시 시작해도 테이블이 남습니다. Hive 지원을 켠 세션(`enableHiveSupport()`, `pyspark` 셸은 Hive 클래스가 있으면 자동으로 켬)이면 Hive를 따로 설치하지 않아도 Spark가 Derby로 로컬 Hive 메타스토어를 만든다고 문서가 적습니다. Hive 지원 없이 만든 세션은 카탈로그를 메모리에 두므로(4.2.0 기본값 `spark.sql.catalogImplementation=in-memory`) 프로그램이 끝나면 테이블 항목이 사라집니다.

| | 관리형(managed) | 외부(external) |
|---|---|---|
| 만드는 법 | `saveAsTable("t")`, `CREATE TABLE ... USING ...`(LOCATION 없음) | `option("path", "/some/path").saveAsTable("t")`, `CREATE TABLE ... LOCATION '...'` |
| 데이터 위치 | 웨어하우스 디렉터리(`spark.sql.warehouse.dir`, 기본 `$PWD/spark-warehouse`) 아래 기본 경로 | 지정한 경로 |
| `DROP TABLE` | 메타데이터와 디렉터리 모두 삭제 | 메타스토어의 메타데이터만 삭제. 파일은 남는다 |
| 파티션 정보 | 만들 때 기록 | 경로를 준 테이블은 파티션 정보를 기본으로 모으지 않는다. `MSCK REPAIR TABLE`로 맞춘다 |

```python
orders.write.mode("overwrite").saveAsTable("shop.orders_managed")
(orders.write.mode("overwrite")
       .option("path", "/lake/orders_ext")
       .partitionBy("order_date")
       .saveAsTable("shop.orders_ext"))

spark.sql("DROP TABLE shop.orders_managed")   # 웨어하우스 아래 파일까지 사라진다
spark.sql("DROP TABLE shop.orders_ext")       # /lake/orders_ext 파일은 남는다

# 파일만 남은 경로에 테이블을 다시 붙이고 파티션을 등록한다
spark.sql("""CREATE TABLE shop.orders_ext
             USING parquet LOCATION '/lake/orders_ext'""")
spark.sql("MSCK REPAIR TABLE shop.orders_ext")
```

마지막 `CREATE TABLE`처럼 스키마를 생략하고 기존 Parquet 경로에 붙이는 동작은 Spark 4.2.0 소스의 `CreateDataSourceTableCommand`로 확인했습니다. 스키마가 비어 있으면 경로의 파일에서 스키마와 파티션 컬럼을 추론해 메타스토어에 적습니다. 파티션 목록은 비어 있는 채로 시작하고 소스 주석이 `msck repair table`을 불러 채워야 한다고 적습니다. 그래서 `MSCK REPAIR TABLE`을 이어 붙였습니다. 실행해서 확인한 코드는 아닙니다.

### 5-2. Databricks Unity Catalog 기준

Databricks 문서의 관리형 테이블과 외부 테이블 설명입니다.

| | Unity Catalog 관리형 | Unity Catalog 외부 |
|---|---|---|
| 위치 | Unity Catalog가 저장소, 최적화까지 관리 | 클라우드 저장소. `LOCATION`이 필수이고 등록된 external location 아래여야 한다 |
| 형식 | 기본 Delta. `USING iceberg`면 Iceberg | DELTA, CSV, JSON, AVRO, PARQUET, ORC, TEXT |
| `DROP TABLE` | 기본 7일 보관 후 비동기로 파일 삭제. 그 안에는 `UNDROP TABLE`로 복구. 보관 기간은 카탈로그나 스키마 단위로 0시간(복구 끔) 또는 7~30일로 바꿀 수 있다 | 메타데이터만 삭제. 파일은 직접 지워야 한다 |
| 권장 | Databricks가 기본으로 권하는 테이블 유형 | |

테이블 이름을 부르는 방식도 다릅니다.

| | 로컬 Apache Spark(기본 설정) | Databricks Unity Catalog | Databricks 레거시 Hive 메타스토어 |
|---|---|---|---|
| 이름 | `database.table`(예: `shop.orders`) | `catalog.schema.table` 세 단계 | `hive_metastore.schema.table` |
| 메타데이터 | Hive 지원을 켜면 Derby 로컬 메타스토어, 아니면 메모리 카탈로그 | Unity Catalog | 워크스페이스 Hive 메타스토어 |
| 관리형 데이터 위치 | `spark.sql.warehouse.dir`(기본 `$PWD/spark-warehouse`) | Unity Catalog가 관리하는 저장소 | 워크스페이스 설정을 따른다(이번에 확인하지 않음) |
| 형식 생략 시 | `spark.sql.sources.default`(기본 `parquet`) | Delta | Delta |

Databricks 문서는 "Delta Lake is the default format for all operations on Databricks"라고 적어서 Databricks에서는 `format`을 생략한 `saveAsTable`도 Delta 테이블을 만듭니다. Unity Catalog 관리형 테이블 문서는 관리형 테이블을 세 단계 이름으로만 읽고 써야 하고 경로 접근은 접근 제어를 우회하므로 지원하지 않는다고 적습니다(Compatibility Mode는 예외). Hive 메타스토어는 Unity Catalog 워크스페이스에서 `hive_metastore` 카탈로그 아래에 보이고 Databricks는 Hive 메타스토어를 쓴 데이터 거버넌스를 지원 중단(deprecated) 상태로 둡니다. 시험 보기에 세 단계 이름이 나오면 Databricks와 Unity Catalog를 전제로 한 것입니다.

### 헷갈리는 지점

- "외부 테이블을 DROP하면 데이터도 지워진다"는 보기는 Spark와 Databricks 모두에서 틀립니다.
- Databricks 관리형 테이블은 DROP 직후 파일이 바로 사라지지 않습니다. Apache Spark의 관리형 테이블은 DROP할 때 디렉터리를 지웁니다. 문항이 어느 쪽을 전제로 하는지 봐야 합니다.
- 테이블이 캐시돼 있으면 `DROP TABLE`이 그 테이블과 의존하는 것들의 캐시를 함께 해제합니다.

## 6. 임시 뷰와 전역 임시 뷰

### 6-1. 메서드 넷

| 메서드 | 같은 이름이 있으면 | 수명 |
|---|---|---|
| `createTempView(name)` | 예외(`TempTableAlreadyExistsException`) | 만든 SparkSession |
| `createOrReplaceTempView(name)` | 덮어쓴다 | 만든 SparkSession |
| `createGlobalTempView(name)` | 예외 | Spark 애플리케이션 |
| `createOrReplaceGlobalTempView(name)` | 덮어쓴다 | Spark 애플리케이션 |

Getting Started 문서의 설명은 이렇습니다. 임시 뷰는 세션 범위라서 만든 세션이 끝나면 사라집니다. 모든 세션이 같이 쓰고 애플리케이션이 끝날 때까지 남기려면 전역 임시 뷰를 만듭니다. 전역 임시 뷰는 시스템이 예약한 `global_temp` 데이터베이스에 묶여 있어서 반드시 `global_temp.뷰이름`으로 불러야 합니다.

```python
orders.createOrReplaceTempView("orders_v")
users.createOrReplaceGlobalTempView("users_g")

spark.sql("""
    SELECT u.city, sum(o.amount) AS revenue
    FROM orders_v o JOIN global_temp.users_g u ON o.user_id = u.user_id
    WHERE o.status = 'PAID'
    GROUP BY u.city
""").show()

other = spark.newSession()
other.sql("SELECT count(*) FROM global_temp.users_g").show()   # 된다
# other.sql("SELECT count(*) FROM orders_v")                   # 세션이 달라 찾지 못한다

spark.catalog.dropTempView("orders_v")          # 지웠으면 True
spark.catalog.dropGlobalTempView("users_g")
```

### 6-2. SQL로 만들기

```sql
CREATE [ OR REPLACE ] [ [ GLOBAL ] TEMPORARY ] VIEW [ IF NOT EXISTS ] view_identifier
    create_view_clauses AS query
```

```sql
CREATE OR REPLACE TEMPORARY VIEW paid_orders AS
SELECT * FROM orders_v WHERE status = 'PAID';

CREATE OR REPLACE GLOBAL TEMPORARY VIEW city_users AS
SELECT city, count(*) AS cnt FROM global_temp.users_g GROUP BY city;
```

4.2.0 문서는 `IF NOT EXISTS`를 임시 뷰에는 아직 지원하지 않는다고 적습니다. 같은 문서는 임시 뷰가 세션별 `system.session` 네임스페이스에 산다고 설명하고 `session.v`나 `system.session.v`처럼 이름 앞에 붙이는 것을 허용합니다. 이 한정자는 4.2에서 생겼습니다. SQL Migration Guide가 "Since Spark 4.2"로 적고 3.5.7의 CREATE VIEW 문서에는 `system.session`이라는 말이 없습니다. 그 밖의 한정자(`mydb.v` 등)는 `INVALID_TEMP_OBJ_QUALIFIER` 오류입니다.

### 6-3. 뷰와 테이블과 캐시

| | 임시 뷰 | 영구 테이블(`saveAsTable`) |
|---|---|---|
| 데이터 | 저장하지 않는다. 조회할 때마다 계보를 다시 계산한다 | 파일로 실체화한다 |
| 메타스토어 | 기록하지 않는다 | 기록한다 |
| 프로그램 재시작 후 | 사라진다 | 같은 메타스토어면 남는다 |

임시 뷰를 여러 번 조회할 예정이면 `spark.catalog.cacheTable("orders_v")`나 DataFrame `cache()`를 겁니다. 두 API의 기본 저장 레벨이 다른 점은 [Ch-01](/blog/cert/spark/spark-01-architecture) 5절에 정리했습니다. 뷰를 지우면 캐시도 함께 해제된다고 `dropTempView` 문서가 적습니다.

### 헷갈리는 지점

- 전역 임시 뷰를 `SELECT * FROM users_g`로 부르면 찾지 못합니다. `global_temp.` 접두어가 필수입니다.
- "전역 임시 뷰는 클러스터의 모든 애플리케이션이 공유한다"는 보기는 틀립니다. 범위는 같은 애플리케이션 안의 세션들입니다.
- 임시 뷰는 DataFrame을 복사하지 않습니다. 원본 DataFrame의 계획에 이름을 붙인 것입니다.

## 7. 확인 문제

직접 만든 문제입니다. 시험 문항이나 문제 은행에서 가져오지 않았습니다.

**문제 1.** `/out/orders`에 이미 Parquet 파일이 있습니다. 다음 코드를 실행하면?

```python
orders.write.parquet("/out/orders")
```

A. 기존 파일 뒤에 붙는다. B. 기존 파일을 지우고 쓴다. C. 아무것도 쓰지 않는다. D. 예외가 난다.

<details>
<summary>정답과 풀이</summary>

D. 모드를 주지 않으면 기본값 `errorifexists`가 적용되어 데이터가 이미 있으면 예외를 냅니다. C는 `ignore`, A는 `append`, B는 `overwrite`입니다.

</details>

**문제 2.** 회원 ID(`user_id`) 기준으로 조인이 잦은 큰 주문 테이블을 영구 테이블로 저장하려 합니다. 회원은 수백만 명입니다. 문서 권고에 맞는 코드는?

```python
A. orders.write.partitionBy("user_id").saveAsTable("shop.o")
B. orders.write.bucketBy(64, "user_id").saveAsTable("shop.o")
C. orders.write.bucketBy(64, "user_id").parquet("/out/o")
D. orders.write.sortBy("user_id").saveAsTable("shop.o")
```

<details>
<summary>정답과 풀이</summary>

B. 고유값이 많은 컬럼은 `partitionBy`보다 `bucketBy`가 맞다고 문서가 적습니다(A 탈락). 버킷은 `saveAsTable`과 함께 쓰는 영구 테이블 전용이라 C는 `'save' does not support bucketBy` 오류가 납니다. D의 `sortBy`는 버킷 안을 정렬하는 기능이라 `bucketBy` 없이 쓰면 `sortBy must be used together with bucketBy` 오류가 납니다(4-1절, Spark 소스 기준).

</details>

**문제 3.** 다음 중 `DROP TABLE` 후에도 데이터 파일이 남는 경우는? (Apache Spark, 기본 설정)

A. `orders.write.saveAsTable("t1")`
B. `orders.write.option("path", "/lake/t2").saveAsTable("t2")`
C. `spark.sql("CREATE TABLE t3 USING parquet AS SELECT * FROM orders_v")`
D. `orders.createOrReplaceTempView("t4")`

<details>
<summary>정답과 풀이</summary>

B. `path`를 준 테이블은 외부 테이블이라 DROP하면 메타데이터만 지웁니다. A와 C는 웨어하우스 아래의 관리형 테이블이라 디렉터리까지 지워집니다. D는 임시 뷰라서 데이터 파일을 만든 적이 없습니다.

</details>

**문제 4.** 같은 애플리케이션에서 `spark.newSession()`으로 만든 세션 `s2`가 조회할 수 있는 것을 모두 고르면?

```python
orders.createOrReplaceTempView("ov")
orders.createOrReplaceGlobalTempView("og")
```

A. `s2.sql("SELECT * FROM ov")` B. `s2.sql("SELECT * FROM og")` C. `s2.sql("SELECT * FROM global_temp.og")` D. 셋 다 안 된다

<details>
<summary>정답과 풀이</summary>

C만 됩니다. 임시 뷰 `ov`는 만든 세션 전용이고 전역 임시 뷰는 `global_temp.` 접두어를 붙여야 합니다.

</details>

**문제 5.** 다음 JDBC 읽기에서 반환되는 행에 대해 맞는 설명은?

```python
(spark.read.format("jdbc")
     .option("url", jdbc_url).option("dbtable", "orders")
     .option("partitionColumn", "order_id")
     .option("lowerBound", "1000").option("upperBound", "2000")
     .option("numPartitions", "5")
     .load())
```

A. `order_id`가 1000~2000인 행만 반환된다.
B. 테이블의 모든 행이 반환되고 `order_id` 구간으로 5개 파티션에 나뉜다.
C. `numPartitions`가 5이므로 행 5개만 반환된다.
D. `query` 옵션이 없어서 오류가 난다.

<details>
<summary>정답과 풀이</summary>

B. `lowerBound`와 `upperBound`는 파티션 보폭만 정하고 행을 거르지 않습니다. 범위 밖 행은 첫 구간과 마지막 구간에 들어갑니다. Spark 4.2.0 소스의 `JDBCRelation`은 첫 파티션 조건을 `order_id < 첫 경계 or order_id is null`로, 마지막 파티션 조건을 `order_id >= 마지막 경계`로 만들어 아래위가 열려 있습니다. null도 첫 파티션으로 갑니다. 이 문제의 값을 넣으면 보폭이 (2000 - 1000) / 5 = 200으로 나누어떨어져 경계가 1200, 1400, 1600, 1800이 됩니다. `order_id`가 500인 행은 첫 파티션(`order_id < 1200`)에, 5000인 행은 마지막 파티션(`order_id >= 1800`)에 들어가고 어느 행도 버려지지 않습니다. `dbtable`과 `query`는 둘 중 하나만 쓰므로 D는 틀립니다.

</details>

**문제 6.** 날짜 파티션 테이블 경로에서 10월 3일 파티션만 바꾸고 나머지 날짜는 남기려 합니다. 필요한 조합은?

A. `mode("append")`와 `partitionBy("order_date")`
B. `mode("overwrite")`와 `partitionBy("order_date")`, 기본 설정 그대로
C. `mode("overwrite")`, `partitionBy("order_date")`, `option("partitionOverwriteMode", "dynamic")`
D. `mode("ignore")`와 `partitionBy("order_date")`

<details>
<summary>정답과 풀이</summary>

C. 기본값 `STATIC`에서는 덮어쓰기 전에 조건에 맞는 파티션을 모두 지웁니다. 경로 전체에 overwrite하면 다른 날짜까지 사라집니다. `DYNAMIC`은 데이터가 쓰인 파티션만 덮어씁니다. A는 10월 3일 데이터가 중복되고 D는 경로가 있으므로 아무것도 쓰지 않습니다.

</details>

**문제 7.** 결제 로그 CSV에 형식이 깨진 줄이 섞여 있습니다. 깨진 줄을 버리지 않고 따로 모아 보려면?

A. `spark.read.option("mode", "DROPMALFORMED").csv(path)`
B. `spark.read.option("mode", "FAILFAST").csv(path)`
C. `spark.read.schema("pay_id INT, amount INT, _corrupt_record STRING").csv(path)`
D. `spark.read.schema("pay_id INT, amount INT").option("mode", "PERMISSIVE").csv(path)`

<details>
<summary>정답과 풀이</summary>

C. 기본 `mode`가 `PERMISSIVE`이고 깨진 문자열은 `columnNameOfCorruptRecord`(기본 `_corrupt_record`) 컬럼에 들어갑니다. 그 컬럼을 사용자 스키마에 넣어야 남습니다. D는 같은 모드지만 스키마에 그 컬럼이 없어 깨진 레코드를 버립니다. A는 깨진 줄을 버리고 B는 예외를 냅니다.

</details>

## 범위와 한계

- 기본값과 시그니처는 2026년 10월 19일과 20일에 연 Spark 4.2.0 문서, PySpark 4.2.0 API 문서, Databricks 문서, Delta Lake 문서 기준입니다. 3.x와 다른 부분은 SQL Migration Guide에 적힌 것(`CREATE TABLE` 기본 형식, ORC 압축 기본값, 임시 뷰 한정자)과 3.5.7 문서로 대조한 것만 표시했습니다. 시험의 기준 Spark 버전은 공개되지 않았습니다.
- 코드는 아직 실행하지 않았습니다. 이 노트북에 Java가 없어 PySpark를 띄울 수 없었습니다. 코드 블록은 Python 문법 검사만 했습니다. JDBC 예제의 주소와 계정은 형식을 보이려는 예시이고 실제로 연결한 적이 없습니다.
- `bucketBy`와 `sortBy` 오류 문장, JDBC 범위 밖 행이 들어가는 파티션, CSV 직접 SQL의 컬럼 이름, 스키마 없이 기존 경로에 붙인 `CREATE TABLE`의 동작은 실행 대신 Spark 4.2.0 소스로 확인했습니다. Spark Connect 클라이언트에서는 오류가 서버에서 돌아오므로 표시 형식이 다를 수 있습니다.
- Spark 4.0부터 SQL 문법에 테이블 이름 뒤 `WITH (키 = 값)` 옵션 절이 생겼고 `ResolveSQLOnFile`이 그 옵션을 `DataSource`로 넘깁니다. 그래서 Apache Spark 4.x에서는 직접 SQL에도 CSV 옵션을 줄 수 있어 보이지만 Spark 문서와 테스트에서 그 예제를 찾지 못해 본문에는 Databricks 문서 문장만 남겼습니다.
- Delta는 `overwriteSchema`, `mergeSchema`, `replaceWhere`, `versionAsOf`의 문서 설명만 옮겼습니다. Delta의 동적 파티션 덮어쓰기 같은 세부 동작은 다루지 않았습니다.

## 참고 자료

시험
- Databricks, [Exam Guide, 2026-10-08판](https://www.databricks.com/sites/default/files/2026-10/databricks-certified-associate-developer-apache-spark-exam-guide-august-2026.pdf), [Exam Guide, Oct 2025](https://www.databricks.com/sites/default/files/2025-10/databricks-certified-associate-developer-apache-spark-exam-guide-oct-2025.pdf) (Section 2 항목과 샘플 문항 1번)

Apache Spark 4.2.0 문서
- [Generic Load/Save Functions](https://spark.apache.org/docs/latest/sql-data-sources-load-save-functions.html)
- [JDBC To Other Databases](https://spark.apache.org/docs/latest/sql-data-sources-jdbc.html)
- [Parquet Files](https://spark.apache.org/docs/latest/sql-data-sources-parquet.html), [CSV Files](https://spark.apache.org/docs/latest/sql-data-sources-csv.html), [JSON Files](https://spark.apache.org/docs/latest/sql-data-sources-json.html), [Text Files](https://spark.apache.org/docs/latest/sql-data-sources-text.html)
- [Getting Started](https://spark.apache.org/docs/latest/sql-getting-started.html)
- [File (SQL 레퍼런스)](https://spark.apache.org/docs/latest/sql-ref-syntax-qry-select-file.html), [CREATE TABLE USING](https://spark.apache.org/docs/latest/sql-ref-syntax-ddl-create-table-datasource.html), [DROP TABLE](https://spark.apache.org/docs/latest/sql-ref-syntax-ddl-drop-table.html), [CREATE VIEW](https://spark.apache.org/docs/latest/sql-ref-syntax-ddl-create-view.html)
- [Configuration](https://spark.apache.org/docs/latest/configuration.html) (`spark.sql.sources.partitionOverwriteMode`, `spark.sql.warehouse.dir`, 버킷 설정)
- [SQL Migration Guide](https://spark.apache.org/docs/latest/sql-migration-guide.html)
- 3.5.7 비교: [CREATE VIEW](https://spark.apache.org/docs/3.5.7/sql-ref-syntax-ddl-create-view.html), [Generic Load/Save Functions](https://spark.apache.org/docs/3.5.7/sql-data-sources-load-save-functions.html)

Apache Spark 4.2.0 소스
- [sql/api DataFrameWriter.scala](https://github.com/apache/spark/blob/v4.2.0/sql/api/src/main/scala/org/apache/spark/sql/DataFrameWriter.scala), [sql/core classic DataFrameWriter.scala](https://github.com/apache/spark/blob/v4.2.0/sql/core/src/main/scala/org/apache/spark/sql/classic/DataFrameWriter.scala), [error-conditions.json](https://github.com/apache/spark/blob/v4.2.0/common/utils/src/main/resources/error/error-conditions.json), [JDBCRelation.scala](https://github.com/apache/spark/blob/v4.2.0/sql/core/src/main/scala/org/apache/spark/sql/execution/datasources/jdbc/JDBCRelation.scala)

PySpark 4.2.0 API
- [DataFrameWriter.mode](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrameWriter.mode.html), [partitionBy](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrameWriter.partitionBy.html), [bucketBy](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrameWriter.bucketBy.html), [sortBy](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrameWriter.sortBy.html), [saveAsTable](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrameWriter.saveAsTable.html), [insertInto](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrameWriter.insertInto.html), [save](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrameWriter.save.html), [jdbc](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrameWriter.jdbc.html), [text](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrameWriter.text.html)
- [DataFrameReader.load](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrameReader.load.html), [schema](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrameReader.schema.html), [csv](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrameReader.csv.html), [json](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrameReader.json.html), [jdbc](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrameReader.jdbc.html)
- [DataFrame.createTempView](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.createTempView.html), [createGlobalTempView](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.createGlobalTempView.html), [Catalog.dropTempView](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.Catalog.dropTempView.html), [DataFrameWriterV2](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrameWriterV2.html)

Databricks와 Delta Lake
- Databricks, [Unity Catalog managed tables for Delta Lake and Apache Iceberg](https://docs.databricks.com/aws/en/tables/managed)
- Databricks, [Work with external tables](https://docs.databricks.com/aws/en/tables/external)
- Databricks, [Read and write CSV files](https://docs.databricks.com/aws/en/query/formats/csv)
- Databricks, [What is Delta Lake in Databricks?](https://docs.databricks.com/aws/en/delta/)
- Databricks, [Database objects in the legacy Hive metastore](https://docs.databricks.com/aws/en/database-objects/hive-metastore)
- Delta Lake, [Table batch reads and writes](https://docs.delta.io/delta-batch/), [Quick Start](https://docs.delta.io/quick-start/), [Releases(Compatibility with Apache Spark)](https://docs.delta.io/releases/)

쓰기 확정과 저장 규칙
- Apache Spark, [ANSI Compliance](https://spark.apache.org/docs/latest/sql-ref-ansi-compliance.html) (`spark.sql.storeAssignmentPolicy`와 저장 규칙 표, 3-2절)
- Apache Spark, [Integration with Cloud Infrastructures](https://spark.apache.org/docs/latest/cloud-integration.html) (이름 바꾸기 기반 커밋의 한계, 3-1절 토글)
- Apache Hadoop, [mapred-default.xml](https://hadoop.apache.org/docs/stable/hadoop-mapreduce-client/hadoop-mapreduce-client-core/mapred-default.xml) (`mapreduce.fileoutputcommitter.algorithm.version` 설명의 `_temporary`와 `_SUCCESS`)

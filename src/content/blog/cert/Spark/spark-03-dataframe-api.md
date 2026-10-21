---
title: '[Spark Ch-03] DataFrame API: union은 위치로, unionByName은 이름으로 맞춘다'
description: Databricks Spark 자격증에서 비중이 가장 큰 3영역(DataFrame/Dataset API, 30%)을 시험 안내서의 항목 순서대로 정리합니다. 컬럼 조작, 중복 제거와 null 처리, 집계, 날짜 함수, 조인과 union, 스키마 지정, 정렬과 리스트 변환, UDF, broadcast 변수와 accumulator를 PySpark 4.2.0 API 문서의 시그니처와 기본값으로 확인하고 3.x와 달라진 동작을 표시합니다.
date: 2026-10-19T00:00:00.000Z
tags:
  - Spark
  - Databricks
  - PySpark
  - Certification
  - DataFrame
category: cert/Spark
topics:
  - cert
draft: false
series: "Spark 공부"
seriesOrder: 3
---

## 결론부터

1. `withColumn`은 같은 이름이 있으면 바꾸고 없으면 추가합니다. `drop`과 `withColumnRenamed`는 없는 컬럼 이름을 주면 오류 없이 아무 일도 하지 않습니다(no-op). 오타가 오류로 드러나지 않으니 시험 보기에서 함정이 되기 좋습니다.
2. `na.drop()`의 기본값은 `how='any'`라서 null이 하나라도 있는 행을 지웁니다. `thresh`를 주면 `how`를 무시합니다. `F.count(col)`은 null을 빼고 세고 `count(*)`와 `DataFrame.count()`는 모든 행을 셉니다.
3. `join`의 `how` 기본값은 `inner`입니다. `on`에 컬럼 이름(문자열이나 리스트)을 주면 키 컬럼이 결과에 하나만 남고 조건식을 주면 양쪽 컬럼이 다 남습니다. `left_semi`와 `left_anti`는 왼쪽 컬럼만 돌려줍니다.
4. `union`과 `unionAll`은 같은 메서드이고 컬럼을 위치로 맞추며 중복을 없애지 않습니다. 이름으로 맞추려면 `unionByName`을 씁니다. 한쪽에 없는 컬럼을 null로 채우려면 `allowMissingColumns=True`(3.1.0~)를 줍니다.
5. Spark 4.0부터 ANSI 모드가 기본으로 켜져서 `to_date`, `to_timestamp`, `unix_timestamp`가 해석할 수 없는 문자열에 null 대신 오류를 냅니다. null로 받으려면 `try_to_date`(4.0.0~) 같은 `try_` 함수를 씁니다. `udf`의 반환 타입 기본값은 `StringType`이고 4.2.0부터 Python UDF가 Arrow를 기본으로 씁니다.

---

시험 안내서(2026년 10월 8일판, 2025년 10월판과 같음) 3영역의 항목은 열 개입니다. 비슷한 것끼리 묶어 목차로 씁니다. 11절과 12절은 목록에 없지만 중복 제거, 집계, 배열 처리 문항의 보기에 섞이기 쉬워 덧붙였습니다.

| 안내서 항목 | 이 글 |
|---|---|
| 컬럼 추가·삭제·분리·이름 변경, 필터, 배열 explode | 1절 |
| 중복 제거와 검증 | 2절 |
| count, approximate count distinct, mean, summary | 3절 |
| 날짜(Unix epoch를 날짜 문자열로, 날짜 요소 추출) | 4절 |
| inner, left, broadcast, 다중 키, cross 조인 / broadcast 조인의 목적과 구현 | 5절 |
| union, union all | 6절 |
| 스키마를 지정한 읽기·쓰기·덮어쓰기 | 7절 |
| 정렬, 반복, 스키마 출력, DataFrame과 리스트 변환 | 8절 |
| UDF 만들고 호출하기(stateful 연산자와 StateStore 포함) | 9절 |
| broadcast 변수와 accumulator | 10절 |
| (안내서 목록 밖) 윈도 함수 | 11절 |
| (안내서 목록 밖) 배열 고차 함수, pivot, 샘플링 | 12절 |

예제 데이터입니다. 주문에 상품 배열과 null을 일부러 넣었습니다.

```python
from pyspark.sql import SparkSession, Row
from pyspark.sql import functions as F
from pyspark.sql.types import (StructType, StructField, IntegerType, LongType,
                               StringType, ArrayType)

spark = SparkSession.builder.master("local[4]").appName("ch03-df").getOrCreate()
spark.conf.set("spark.sql.session.timeZone", "UTC")   # 날짜 예제의 결과를 고정하려고

orders = spark.createDataFrame(
    [
        (1, 101, "PAID",     32000, 1790812800, ["book", "pen"]),
        (2, 102, "PAID",     15000, 1790812800, ["mug"]),
        (3, 101, "CANCELED",  8000, 1790947800, []),
        (4, 103, "PAID",     54000, 1790947800, None),
        (5, 102, None,       15000, 1791018900, ["book"]),
        (5, 102, None,       15000, 1791018900, ["book"]),   # 완전히 같은 중복 행
    ],
    "order_id INT, user_id INT, status STRING, amount INT, ordered_at LONG, items ARRAY<STRING>",
)
users = spark.createDataFrame(
    [(101, "Kim Minji", "Seoul"), (102, "Lee Junho", "Busan"), (104, "Park Sora", None)],
    "user_id INT, full_name STRING, city STRING",
)
payments = spark.createDataFrame(
    [(9001, 1, 101, "CARD"), (9002, 2, 102, "BANK"), (9003, 4, 103, "CARD")],
    "payment_id INT, order_id INT, user_id INT, method STRING",
)
```

`ordered_at`의 세 값은 UTC 기준 2026-10-01 00:00:00, 2026-10-02 13:30:00, 2026-10-03 09:15:00의 epoch 초입니다(Python `datetime`으로 계산한 값).

## 1. 컬럼과 행 다루기

### 1-1. 시그니처

| 메서드 | 시그니처 | 동작 |
|---|---|---|
| 추가·교체 | `withColumn(colName, col)` | 같은 이름이 있으면 교체, 없으면 추가 |
| 여러 개 | `withColumns(*colsMap)` | dict 하나로 여러 컬럼(3.3.0~) |
| 삭제 | `drop(*cols)` | 없는 이름이면 no-op |
| 이름 변경 | `withColumnRenamed(existing, new)` | 없는 이름이면 no-op |
| 여러 개 이름 변경 | `withColumnsRenamed(colsMap)` | dict 하나(3.4.0~) |
| 필터 | `filter(condition)`, `where(condition)` | `where`는 `filter`의 별칭. Column이나 SQL 문자열 |
| 분리 | `F.split(str, pattern, limit=-1)` | pattern은 Java 정규식 |
| 펼치기 | `F.explode(col)`, `F.explode_outer(col)`, `F.posexplode(col)` | 원소마다 행 하나 |

`withColumnRenamed`의 인자 순서는 (기존 이름, 새 이름)입니다. 시험 안내서 샘플 문항 3번의 오답 보기 B가 순서를 뒤집은 코드입니다.

```python
o = (orders
     .withColumn("amount_vat", F.col("amount") * 1.1)       # 추가
     .withColumn("amount", F.col("amount").cast("long"))    # 같은 이름이라 교체
     .withColumnRenamed("ordered_at", "ordered_epoch")      # (기존, 새)
     .withColumnsRenamed({"user_id": "uid"})                # 3.4.0~
     .drop("amount_vat", "no_such_column"))                 # 없는 이름은 무시
```

### 1-2. split의 정규식과 limit

`split`의 pattern은 정규식이라 `.`이나 `|`를 그대로 쓰면 의도와 다르게 나뉩니다. `limit`이 양수면 결과 배열 길이가 limit을 넘지 않고 마지막 원소에 나머지가 다 들어갑니다. 0 이하면 가능한 만큼 나눕니다. 기본값 -1은 3.0에서 추가됐습니다.

```python
names = users.select(
    F.split("full_name", " ").getItem(0).alias("last_name"),   # 'Kim'
    F.split("full_name", " ").getItem(1).alias("first_name"),  # 'Minji'
)

skus = spark.createDataFrame([("A.B.C",)], "sku STRING")
skus.select(F.split("sku", r"\.").alias("parts"))        # 문서 기준 예상 결과: ['A', 'B', 'C']
skus.select(F.split("sku", r"\.", 2).alias("parts"))     # 문서 기준 예상 결과: ['A', 'B.C']
```

4.0.0부터 `pattern`에 Column도 받습니다. 다만 문자열은 계속 정규식으로 해석하므로 컬럼 이름 문자열을 pattern으로 줄 수는 없습니다.

### 1-3. filter

```python
orders.filter(F.col("amount") >= 15000)
orders.where("amount >= 15000 AND status = 'PAID'")              # SQL 문자열
orders.filter((F.col("status") == "PAID") & (F.col("amount") > 20000))   # 괄호 필수
orders.filter(F.col("status").isin("PAID", "REFUNDED"))
orders.filter(~F.col("status").isin("CANCELED"))                 # ~ 는 NOT
```

Python의 `and`, `or`, `not`은 Column에 쓸 수 없고 `&`, `|`, `~`를 씁니다. `&`가 비교 연산자보다 먼저 묶이므로 각 조건을 괄호로 감쌉니다. `status`가 null인 행은 `status == "PAID"`도 `status != "PAID"`도 통과하지 못합니다. NULL Semantics 문서는 WHERE와 JOIN 조건에서 결과가 `True`인 행만 남고 null(unknown)은 걸러진다고 적습니다.

### 1-4. explode와 explode_outer

| 함수 | null 배열, 빈 배열 | 기본 컬럼 이름 |
|---|---|---|
| `explode` | 행이 사라진다 | 배열은 `col`, 맵은 `key`, `value` |
| `explode_outer` | null 원소 하나로 행을 남긴다 | 같음 |
| `posexplode` | 행이 사라진다 | `pos`, `col` |
| `posexplode_outer` | null로 남긴다 | `pos`, `col` |

```python
orders.select("order_id", F.explode("items").alias("item"))
# 문서 기준 예상 결과: 주문 1은 2행, 2는 1행, 5는 2행(중복 행 2개 각각 1행), 3(빈 배열)과 4(null)는 없음

orders.select("order_id", F.explode_outer("items").alias("item"))
# 주문 3과 4가 item = null 인 행으로 남는다
```

`explode` 문서는 SELECT 하나에 explode를 하나만 쓸 수 있다고 적습니다. 두 배열을 펼치려면 `select`를 두 번 이어 씁니다.

### 헷갈리는 지점

- `withColumn` 문서는 반복문에서 여러 번 부르면 내부 projection이 쌓여 계획이 커지고 성능 문제나 `StackOverflowException`이 날 수 있다고 경고합니다. 여러 컬럼은 `select`나 `withColumns`로 한 번에 만듭니다.
- `withColumn`의 두 번째 인자는 Column 식이어야 합니다. 상수는 `F.lit(0)`으로 감쌉니다. 다른 DataFrame의 컬럼을 넣으면 오류가 납니다.
- `drop("a")`와 `drop(F.col("a"))`는 의미가 다를 수 있다고 문서가 적습니다. 이름은 글자 그대로 찾고 Column은 같은 식을 찾습니다. 조인 뒤 같은 이름 컬럼이 둘일 때 차이가 납니다.

## 2. 중복 제거와 검증

### 2-1. distinct와 dropDuplicates

```python
DataFrame.distinct()
DataFrame.dropDuplicates(subset=None)      # drop_duplicates는 별칭
```

| 메서드 | 비교 기준 | 결과 컬럼 |
|---|---|---|
| `distinct()` | 모든 컬럼 | 전부 |
| `dropDuplicates()` | 모든 컬럼(= `distinct`) | 전부 |
| `dropDuplicates(["user_id"])` | 지정한 컬럼만 | 전부. 같은 키의 행 중 하나만 남는다 |

```python
orders.distinct().count()                       # 문서 기준 예상 결과: 5 (주문 5 중복 제거)
orders.dropDuplicates(["user_id"]).count()      # 회원 101, 102, 103 하나씩 → 3
orders.select("user_id").distinct().count()     # 3, 다만 결과 컬럼은 user_id 하나
```

`dropDuplicates(subset)`이 같은 키의 여러 행 중 어느 행을 남기는지는 API 문서에 적혀 있지 않습니다. 특정 행(예: 가장 최근 주문)을 남겨야 하면 윈도 함수 `row_number()`로 직접 고릅니다(11절). 스트리밍 DataFrame의 `dropDuplicates`는 트리거를 넘어 모든 데이터를 상태로 들고 있고 `withWatermark()`로 범위를 줄인다고 문서가 적습니다(5영역에서 다룹니다).

### 2-2. null 처리

```python
DataFrame.dropna(how='any', thresh=None, subset=None)     # = df.na.drop(...)
DataFrame.fillna(value, subset=None)                      # = df.na.fill(...)
DataFrameNaFunctions.replace(to_replace, value=<no value>, subset=None)
```

| 호출 | 지우는 행 |
|---|---|
| `na.drop()` | 컬럼 중 하나라도 null(또는 NaN)인 행. 기본 `how='any'` |
| `na.drop("all")` | 모든 컬럼이 null인 행만 |
| `na.drop(subset=["status"])` | `status`가 null인 행 |
| `na.drop(thresh=5)` | null이 아닌 값이 5개 미만인 행. `how`를 덮어쓴다 |

시험 안내서 샘플 문항 6번이 "컬럼 중 하나라도 값이 빠진 행을 모두 지우는 코드"로 `na.drop()`을 정답으로 듭니다.

`fillna`에는 함정이 둘 있습니다. 값이 dict면 `subset`을 무시합니다. 값의 타입과 맞지 않는 컬럼은 `subset`에 있어도 조용히 건너뜁니다.

```python
orders.na.fill("UNKNOWN", subset=["status", "amount"])   # amount는 정수라 무시되고 status만 채워진다
orders.na.fill({"status": "UNKNOWN", "amount": 0})       # 컬럼마다 다른 값
orders.na.replace("REFUNDED", "RETURNED", subset=["status"])
```

### 2-3. 검증 조건

```python
orders.filter(F.col("status").isNull())          # Column.isNull()
orders.filter(F.col("status").isNotNull())
orders.filter(F.isnull("status"))                # 함수형도 있다
orders.select(F.coalesce("status", F.lit("UNKNOWN")).alias("status"))   # 첫 번째 null 아닌 값

# 검증 규칙을 컬럼으로 만들고 통과하지 못한 행만 따로 본다
checked = orders.withColumn(
    "is_valid",
    F.col("status").isNotNull() & (F.col("amount") > 0) & (F.size("items") > 0),
)
checked.filter(~F.col("is_valid"))
```

마지막 예에서 `items`가 null이면 `size`의 결과가 무엇인지가 판정을 바꾸고 이 값은 버전마다 다릅니다. SQL 함수 문서 기준으로 `size`는 `spark.sql.ansi.enabled`가 false이고 `spark.sql.legacy.sizeOfNull`이 true일 때만 null 입력에 -1을 돌려주고 그 밖에는 null을 돌려줍니다.

| 버전(기본 설정) | `size(null)` | 주문 4(`items` null)의 `is_valid` | `filter(~is_valid)`에 잡히는지 |
|---|---|---|---|
| 3.5(ANSI 꺼짐) | -1 | false | 잡힌다 |
| 4.x(ANSI 켜짐) | null | null | 잡히지 않는다 |

4.x에서는 `is_valid`가 null이라 `~is_valid`도 null이고 그 행은 두 필터 어디에도 잡히지 않습니다. 검증 컬럼은 `F.coalesce(조건, F.lit(False))`로 null을 거짓으로 바꿔 두면 두 버전에서 결과가 같습니다.

### 헷갈리는 지점

- `col == None`으로 null을 찾으면 결과가 null이라 아무 행도 통과하지 못합니다. `isNull()`을 씁니다.
- `distinct()`와 `GROUP BY`는 null을 같은 값으로 묶습니다. 비교 연산(`=`)에서는 null과 null이 같지 않습니다. NULL Semantics 문서에 둘 다 나옵니다.
- `na.drop()`은 NaN도 null처럼 지웁니다(문서 문장 "null or NaN values"). `thresh`도 null과 NaN이 아닌 값의 개수로 셉니다(문서 예제 3).

## 3. 집계

### 3-1. 세는 방법 다섯 가지

| 코드 | 무엇을 세나 | 결과 |
|---|---|---|
| `df.count()` | 행 수. 액션 | Python int |
| `F.count("*")`, `F.count(F.lit(1))` | 모든 행 | Column |
| `F.count("status")` | `status`가 null이 아닌 행 | Column |
| `F.count_distinct("user_id")` | 고유값 수(정확) | Column |
| `F.approx_count_distinct("user_id", rsd=None)` | 고유값 수(근사, HyperLogLog++). 기본 상대 표준편차 0.05 | Column |

```python
orders.select(
    F.count("*").alias("rows"),                     # 6
    F.count("status").alias("status_not_null"),     # 4
    F.count_distinct("user_id").alias("users"),     # 3
    F.approx_count_distinct("user_id").alias("users_approx"),
)
# 문서 기준 예상 결과(근사값 제외): 6, 4, 3
```

`approx_count_distinct`도 셔플을 합니다. 차이는 셔플하는 양입니다. Spark 4.2.0 소스(`AggUtils.planAggregateWithOneDistinct`)를 보면 `count_distinct`는 그룹 키에 DISTINCT 대상 컬럼을 더한 조합으로 먼저 묶습니다. 그래서 그룹마다 고유값이 모두 셔플됩니다. `approx_count_distinct`는 일반 집계처럼 파티션 안에서 부분 집계를 해 그룹마다 HyperLogLog++ 스케치 하나를 만들고 그 스케치만 셔플합니다. 고유값이 많을수록 셔플 데이터가 크게 줄어듭니다. 이 설명은 소스를 읽고 정리한 것이고 같은 내용의 문서 문장은 찾지 못했습니다.

`approx_count_distinct` 문서는 `rsd`를 0.01보다 작게 잡을 거면 `count_distinct()`를 쓰는 편이 효율적이라고 적습니다. `countDistinct`는 3.5.9 문서에 `count_distinct`의 별칭으로 나오고 `count_distinct`를 직접 쓰라고 권합니다. 4.2.0 API 문서에는 `countDistinct` 페이지가 없지만 4.2.0 소스(`functions/builtin.py`)에는 같은 설명의 별칭으로 남아 있어 호출은 됩니다.

### 3-2. 평균, 합계, groupBy

`F.mean(col)`은 `F.avg(col)`의 별칭입니다. 집계 함수는 null을 무시합니다(`count(*)` 제외). 모든 입력이 null이거나 입력이 비면 `max`, `min`, `sum`, `avg`는 null을 돌려준다고 NULL Semantics 문서가 적습니다.

```python
DataFrame.groupBy(*cols)            # groupby는 별칭. 4.0.0부터 1부터 시작하는 컬럼 위치(int)도 받는다
GroupedData.agg(*exprs)             # dict 하나 또는 Column 여러 개
GroupedData.count()                 # 결과 컬럼 이름은 count
```

```python
by_user = (orders
           .groupBy("user_id")
           .agg(F.count("*").alias("orders"),
                F.sum("amount").alias("total"),
                F.mean("amount").alias("avg_amount"),
                F.max("ordered_at").alias("last_at")))

orders.groupBy("user_id").agg({"amount": "avg", "*": "count"})   # dict 형식. 결과 이름은 avg(amount), count(1)
orders.groupBy("status").count()                                  # 컬럼 이름 status, count. null status도 한 그룹
```

`agg` 문서는 내장 집계 함수와 그룹 집계 pandas UDF를 한 번의 `agg` 호출에 섞을 수 없다고 적습니다.

### 3-3. describe와 summary

| 메서드 | 기본 통계 | 인자 |
|---|---|---|
| `describe(*cols)` | count, mean, stddev, min, max | 컬럼 이름 |
| `summary(*statistics)` | count, mean, stddev, min, 25%, 50%, 75%, max | 통계 이름(예: `"count"`, `"min"`, `"75%"`) |

```python
orders.describe("amount").show()
orders.summary().show()                    # 사분위수까지
orders.summary("count", "min", "90%").show()
```

두 메서드 모두 숫자와 문자열 컬럼에 대해 통계를 냅니다. 결과는 통계 이름 컬럼(`summary`)이 붙은 DataFrame이고 값은 문자열로 나옵니다. 문서는 결과 스키마의 하위 호환을 보장하지 않는 탐색용 기능이라고 적습니다. 사분위수는 근사값입니다.

### 헷갈리는 지점

- `df.count()`는 액션이라 int를 돌려주고 `F.count()`는 Column이라 `select`나 `agg` 안에 씁니다.
- `summary()`의 인자는 통계 이름입니다. 컬럼을 고르려면 `df.select("amount").summary()`처럼 먼저 고릅니다. 4.2.0 문서의 Parameters 설명에는 "Column names to calculate statistics by"라고 적혀 있지만 본문과 예제는 통계 이름을 받습니다.
- `GroupedData.count()`의 결과 컬럼 이름은 `count`이고 `F.count("*")`를 별칭 없이 쓰면 `count(1)`입니다.

## 4. 날짜와 시간

### 4-1. 시그니처와 반환 타입

| 함수 | 시그니처 | 반환 |
|---|---|---|
| epoch 초 → 문자열 | `from_unixtime(timestamp, format='yyyy-MM-dd HH:mm:ss')` | String |
| 문자열 → epoch 초 | `unix_timestamp(timestamp=None, format='yyyy-MM-dd HH:mm:ss')` | Long. 인자가 없으면 현재 시각 |
| epoch 초 → 타임스탬프 | `timestamp_seconds(col)`(3.1.0~) | Timestamp |
| → 날짜 | `to_date(col, format=None)` | Date. 형식 생략 시 `cast("date")`와 같다 |
| → 타임스탬프 | `to_timestamp(col, format=None)` | Timestamp |
| 날짜 → 문자열 | `date_format(date, format)` | String |
| 요소 추출 | `year`, `month`, `dayofmonth`, `dayofweek`, `dayofyear`, `hour`, ... | Integer |
| 날짜 계산 | `date_add(start, days)`, `datediff(end, start)` | Date / Integer |

`from_unixtime` 문서는 결과를 "현재 시스템 시간대" 기준 문자열로 낸다고 적습니다. 위 예제는 결과를 고정하려고 세션 시간대(`spark.sql.session.timeZone`, 기본 로컬 시간대)를 UTC로 맞췄습니다.

```python
dated = orders.select(
    "order_id",
    F.from_unixtime("ordered_at").alias("ordered_str"),                  # '2026-10-01 00:00:00'
    F.from_unixtime("ordered_at", "yyyy/MM/dd").alias("ordered_ymd"),    # '2026/10/01'
    F.timestamp_seconds("ordered_at").alias("ordered_ts"),
    F.to_date(F.from_unixtime("ordered_at")).alias("ordered_date"),     # 2026-10-01 (DateType)
)
parts = dated.select(
    "order_id",
    F.year("ordered_ts").alias("y"),           # 2026
    F.month("ordered_ts").alias("m"),          # 10
    F.dayofmonth("ordered_ts").alias("d"),     # 1, 2, 3
    F.dayofweek("ordered_ts").alias("dow"),    # 10월 1일(목) 5, 10월 3일(토) 7
    F.date_format("ordered_ts", "EEE").alias("dow_name"),
)
# 문서 기준 예상 결과. 세션 시간대 UTC 기준이고 실행해서 확인하지 않았다
```

`dayofweek`는 일요일 1부터 토요일 7까지입니다. 월요일을 1로 생각하면 틀립니다. `datediff`는 인자 순서가 (end, start)라서 `datediff("2026-10-03", "2026-10-01")`이 2입니다.

### 4-2. 3.x와 4.x의 차이: ANSI 모드

4.2.0 SQL Migration Guide는 Spark 4.0부터 `spark.sql.ansi.enabled`가 기본으로 켜졌다고 적습니다. ANSI Compliance 문서는 ANSI 모드에서 `to_date`, `to_timestamp`, `unix_timestamp`, `to_unix_timestamp`가 입력을 해석할 수 없거나 패턴이 잘못되면 실패한다고 적습니다.

| 상황 | ANSI 꺼짐(3.5 기본) | ANSI 켜짐(4.0 기본) |
|---|---|---|
| `to_date("2026-13-45")` | null | 오류 |
| `CAST('a' AS INT)` | null | `CAST_INVALID_INPUT` 오류 |
| `F.col("amount") / 0` | null | 0으로 나누기 오류(`try_divide` 설명과 4.2.0 소스 `DivModLike`) |
| `size(null)` | -1 | null(2-3절) |
| null로 받고 싶을 때 | 그대로 | `try_to_date`(4.0.0~), `try_to_timestamp`(3.5.0~), `Column.try_cast`(4.0.0~), `try_divide`(3.2.0~) |

`unix_timestamp`의 API 문서는 3.5.9와 4.2.0 모두 "실패하면 null을 돌려준다"고 적습니다. ANSI 문서와 엇갈리는데 4.2.0 소스를 보면 ANSI 문서 쪽이 맞습니다. `UnixTimestamp` 식의 `failOnError` 기본값이 `spark.sql.ansi.enabled`이고 이 값이 true면 해석 실패에서 예외를 던지며 false일 때만 null을 돌려줍니다. 4.x 기본 설정에서는 오류가 납니다.

같은 가이드는 4.0에서 `spark.sql.legacy.timeParserPolicy` 기본값이 `EXCEPTION`에서 `CORRECTED`로 바뀌었다고 적습니다. ANSI 모드에서는 `CANNOT_PARSE_TIMESTAMP` 오류가 나고 ANSI가 꺼져 있으면 null이 나옵니다.

```python
raw = spark.createDataFrame([("2026-10-01",), ("2026-13-45",), (None,)], "d STRING")
raw.select(F.try_to_date("d").alias("d"))     # 4.0.0~. 잘못된 값은 null
# raw.select(F.to_date("d"))                  # 4.x 기본 설정에서는 두 번째 행 때문에 액션에서 오류
```

### 헷갈리는 지점

- `from_unixtime`은 문자열을 돌려줍니다. 날짜 연산을 하려면 `to_date`나 `to_timestamp`로 다시 바꾸거나 `timestamp_seconds`를 씁니다.
- `date_format` 문서는 가능하면 `year` 같은 전용 함수를 쓰라고 권합니다. `date_format(col, "yyyy")`는 문자열 `'2026'`이고 `year(col)`은 정수 2026입니다.
- epoch 밀리초를 `from_unixtime`에 그대로 넣으면 초로 해석합니다. 1000으로 나누거나 `timestamp_millis`를 씁니다.

## 5. 조인

### 5-1. 시그니처와 조인 종류

```python
DataFrame.join(other, on=None, how=None)     # how 기본값 'inner'
DataFrame.crossJoin(other)
```

`how`에 쓸 수 있는 문자열(4.2.0 문서): `inner`, `cross`, `outer`, `full`, `fullouter`, `full_outer`, `left`, `leftouter`, `left_outer`, `right`, `rightouter`, `right_outer`, `semi`, `leftsemi`, `left_semi`, `anti`, `leftanti`, `left_anti`.

| 종류 | 돌려주는 행 | 돌려주는 컬럼 |
|---|---|---|
| inner | 양쪽에 매칭되는 행 | 양쪽 |
| left | 왼쪽 전부. 매칭이 없으면 오른쪽은 null | 양쪽 |
| right | 오른쪽 전부 | 양쪽 |
| full | 양쪽 전부 | 양쪽 |
| cross | 카테시안 곱 | 양쪽 |
| left_semi | 오른쪽에 매칭이 있는 왼쪽 행 | 왼쪽만 |
| left_anti | 오른쪽에 매칭이 없는 왼쪽 행 | 왼쪽만 |

### 5-2. on을 주는 방법에 따라 달라지는 컬럼

| `on` | 조인 방식 | 키 컬럼 |
|---|---|---|
| `"user_id"` | 등가 조인. 양쪽에 같은 이름 컬럼이 있어야 한다 | 하나만 남는다 |
| `["order_id", "user_id"]` | 다중 키 등가 조인 | 각각 하나만 남는다 |
| `orders.user_id == users.user_id` | 조건식 | 양쪽 컬럼이 다 남는다 |
| `[cond1, cond2]` | 조건식 리스트(AND) | 다 남는다 |

```python
o = orders.dropDuplicates()

# 1) 이름으로: user_id 컬럼 하나
o.join(users, "user_id")                        # inner, 103과 104는 빠진다

# 2) 조건식으로: user_id가 둘이 되어 그냥 "user_id"를 고르면 모호하다
j = o.join(users, o.user_id == users.user_id, "left")
j.select(o.user_id, users.city)                 # DataFrame을 붙여 고른다

# 3) 다중 키
o.join(payments, ["order_id", "user_id"], "left")

# 4) 결제가 있는 주문만, 결제가 없는 주문만 (왼쪽 컬럼만 남는다)
o.join(payments, "order_id", "left_semi")       # 주문 1, 2, 4
o.join(payments, "order_id", "left_anti")       # 주문 3, 5

# 5) cross
o.crossJoin(users).count()                      # 문서 기준 예상 결과: 5 x 3 = 15
```

자기 자신과 조인하면 직접 컬럼 참조가 모호해진다고 문서가 경고합니다. 이때는 `alias`로 DataFrame에 이름을 붙이고 `F.col("a.user_id")`처럼 부릅니다.

```python
a, b = o.alias("a"), o.alias("b")
same_user = a.join(b, (F.col("a.user_id") == F.col("b.user_id")) &
                      (F.col("a.order_id") < F.col("b.order_id")))
```

조인 키가 null이면 `=` 비교가 null이 되어 매칭되지 않습니다. null끼리 맞추려면 null-safe 비교(`<=>`, PySpark에서는 `Column.eqNullSafe`)를 씁니다. `eqNullSafe` 문서 예제에서 null 값과 `'foo'`를 비교하면 `==`는 NULL, `eqNullSafe`는 false이고 `eqNullSafe(None)`은 true입니다.

### 5-3. broadcast 조인

broadcast 조인은 작은 쪽 DataFrame 전체를 모든 익스큐터에 보내고 큰 쪽은 셔플하지 않은 채 각 파티션에서 바로 조인합니다. 큰 쪽의 셔플을 없애는 것이 목적입니다.

| 방법 | 코드 |
|---|---|
| 자동 | 테이블 크기가 `spark.sql.autoBroadcastJoinThreshold`(기본 10MB, -1이면 끔) 이하일 때 |
| 함수 | `F.broadcast(df)`. 1.6.0부터 |
| 힌트 | `df.hint("broadcast")`, SQL `/*+ BROADCAST(t) */`(`BROADCASTJOIN`, `MAPJOIN`도 같다) |

Performance Tuning 문서는 broadcast 힌트를 주면 추정 크기가 임계값을 넘어도 그 쪽을 build 쪽으로 broadcast 조인을 우선한다고 적습니다. 다만 조인 종류가 지원하지 않으면 힌트를 따르지 않을 수 있습니다. 양쪽에 힌트가 다르면 우선순위는 `BROADCAST` > `MERGE` > `SHUFFLE_HASH` > `SHUFFLE_REPLICATE_NL`입니다. broadcast 대기 시간 상한은 `spark.sql.broadcastTimeout`(기본 300초)입니다.

```python
big = o            # 실제로는 수억 건이라고 가정
small = users      # 수천 건

joined = big.join(F.broadcast(small), "user_id", "left")
joined.explain()   # 물리 계획에 BroadcastHashJoin이 나오는지 본다
```

### 헷갈리는 지점

- `how`를 생략하면 inner입니다. 샘플 문항류에서 "왼쪽 행이 모두 남는다"를 고르려면 `how="left"`가 있어야 합니다.
- `left_semi`는 오른쪽에 매칭이 여러 개여도 왼쪽 행을 한 번만 돌려줍니다. 4.2.0 소스의 해시 조인 구현(`HashJoin.semiJoin`)은 왼쪽 행마다 매칭이 있는지만 보고 걸러 내는 `filter`라서 행이 늘지 않습니다. inner 조인 뒤 왼쪽 컬럼만 고르면 매칭 수만큼 행이 늘어나니 중복 처리에서 다릅니다.
- broadcast 대상은 작은 쪽입니다. 큰 쪽을 `broadcast()`로 감싸면 드라이버와 익스큐터 메모리를 크게 씁니다.
- broadcast 조인(`F.broadcast(df)`)과 broadcast 변수(`sc.broadcast(value)`)는 다른 API입니다. 10절에서 다룹니다.

## 6. union, unionAll, unionByName

```python
DataFrame.union(other)
DataFrame.unionAll(other)                                 # union의 별칭
DataFrame.unionByName(other, allowMissingColumns=False)   # allowMissingColumns는 3.1.0~
```

| 메서드 | 컬럼 맞추기 | 중복 |
|---|---|---|
| `union` | 위치(이름 무시). SQL 표준 동작 | 남긴다(SQL의 `UNION ALL`과 같음) |
| `unionAll` | `union`과 같다 | 남긴다 |
| `unionByName` | 이름 | 남긴다 |
| `union(...).distinct()` | | SQL의 `UNION`과 같다 |

```python
oct_orders = spark.createDataFrame([(10, 101, 5000)], "order_id INT, user_id INT, amount INT")
nov_orders = spark.createDataFrame([(201, 11, 7000)], "user_id INT, order_id INT, amount INT")

oct_orders.union(nov_orders)
# 위치로 붙어서 order_id = 201, user_id = 11 인 행이 생긴다. 타입이 같으니 오류도 없다

oct_orders.unionByName(nov_orders)
# 이름으로 맞춰 order_id = 11, user_id = 201

with_note = spark.createDataFrame([(12, 103, 9000, "gift")],
                                  "order_id INT, user_id INT, amount INT, note STRING")
oct_orders.unionByName(with_note, allowMissingColumns=True)
# oct_orders 쪽 행의 note는 null
```

같은 계열 집합 연산도 같이 정리해 둡니다. 4.2.0 문서 기준으로 모두 위치로 컬럼을 맞춥니다.

| 메서드 | SQL | 중복 |
|---|---|---|
| `intersect` | `INTERSECT` | 없앤다. 남기려면 `intersectAll` |
| `subtract` | `EXCEPT DISTINCT` | 없앤다 |
| `exceptAll` | `EXCEPT ALL` | 남긴다 |

### 헷갈리는 지점

- `union`이 중복을 없앤다는 보기는 틀립니다. SQL의 `UNION`과 이름이 같아서 생기는 함정입니다. 예전 자료 중에도 union이 이름으로 맞춘다고 잘못 적은 글이 있습니다([Ch-00](/blog/cert/spark/spark-00-exam-and-study-plan) 5절).
- 위치가 바뀐 두 DataFrame의 컬럼 타입이 같으면 `union`은 오류 없이 값을 섞습니다. 4.2.0 `union` 문서 예제 2는 `id LONG, money INT`와 `money INT, id LONG`을 union해도 오류 없이 위치대로 붙는 모습을 보여 줍니다. 타입이 다르면 위치마다 공통 타입을 찾아 캐스트합니다(4.2.0 소스 `WidenSetOperationTypes`). 문자열과 정수가 같은 위치에 오면 ANSI가 꺼진 3.5에서는 STRING으로 맞추고 ANSI가 켜진 4.x에서는 BIGINT로 맞춥니다(ANSI Compliance 문서의 "least common type between Byte/Short/Int and String is Long"). 4.x에서는 숫자로 읽을 수 없는 문자열이 있으면 캐스트에서 오류가 납니다.
- 결과 컬럼 이름은 첫 번째 DataFrame을 따릅니다. 문서 예제 3에서 `A, B`와 `C, D`를 union한 결과 컬럼은 `A, B`입니다.
- 집합 연산(`intersect`, `subtract`)은 null끼리 같은 값으로 봅니다(NULL Semantics 문서).

## 7. 스키마를 지정한 읽기와 쓰기

### 7-1. StructType과 DDL 문자열

```python
StructType(fields=None)
StructField(name, dataType, nullable=True, metadata=None)
StructType.add(field, data_type=None, nullable=True, metadata=None)
```

같은 스키마를 두 방식으로 씁니다.

```python
order_schema = StructType([
    StructField("order_id", IntegerType(), False),
    StructField("user_id", IntegerType(), True),
    StructField("status", StringType(), True),
    StructField("amount", IntegerType(), True),
    StructField("ordered_at", LongType(), True),
    StructField("items", ArrayType(StringType()), True),
])

order_ddl = ("order_id INT, user_id INT, status STRING, amount INT, "
             "ordered_at BIGINT, items ARRAY<STRING>")
```

DDL 문자열로는 `NOT NULL`을 적지 않는 한 nullable이 true입니다. 위 두 스키마는 `order_id`의 nullable만 다릅니다. 4.0.0부터 `StructType.fromDDL(ddl)`로 DDL 문자열을 `StructType` 객체로 바꿀 수 있습니다.

### 7-2. 스키마를 지정하는 자리

| 자리 | 받는 것 |
|---|---|
| `spark.read.schema(schema)` | `StructType` 또는 DDL 문자열 |
| `spark.read.csv(path, schema=...)`, `json(path, schema=...)`, `load(..., schema=...)` | 같음 |
| `spark.createDataFrame(data, schema=None, samplingRatio=None, verifySchema=True)` | `DataType`, DDL 문자열, 컬럼 이름 리스트 |
| `Column.cast(dataType)` | `DataType` 또는 DDL 타입 문자열 |

`DataFrameReader.schema` 문서는 스키마를 주면 소스가 스키마 추론 단계를 건너뛰어 읽기가 빨라진다고 적습니다. CSV의 `inferSchema=True`는 데이터를 한 번 더 훑습니다.

```python
orders_in = (spark.read
             .schema(order_ddl)
             .option("mode", "FAILFAST")
             .json("/data/orders_json"))

(orders_in.write
          .mode("overwrite")
          .parquet("/out/orders_typed"))      # Parquet는 스키마를 파일에 저장한다

spark.read.parquet("/out/orders_typed").printSchema()   # 다시 읽어도 같은 타입
```

`createDataFrame`에 컬럼 이름 리스트만 주면 타입은 데이터에서 추론합니다. 빈 DataFrame을 만들 때는 추론할 데이터가 없으므로 스키마가 필수입니다.

### 7-3. 스키마 확인

| 코드 | 결과 |
|---|---|
| `df.printSchema(level=None)` | 트리 형식으로 출력. `level`은 중첩 깊이(3.5.0~) |
| `df.schema` | `StructType` 객체(속성, 괄호 없음) |
| `df.dtypes` | `[('order_id', 'int'), ...]` 리스트 |
| `df.columns` | 컬럼 이름 리스트 |

### 헷갈리는 지점

- `df.schema()`처럼 괄호를 붙이면 오류입니다. `schema`는 속성입니다. 샘플 문항 4번의 오답 보기 B에 이 코드가 있습니다.
- 파일에서 읽을 때 지정한 `nullable=False`는 지켜지지 않습니다. 4.2.0 소스의 `DataSource.resolveRelation`이 파일 소스의 데이터 스키마를 기본으로 `asNullable`로 바꿉니다. Parquet 문서도 읽을 때 모든 컬럼이 호환성 때문에 nullable로 바뀐다고 적습니다.
- CSV `enforceSchema` 기본값 true는 지정한 스키마를 파일에 강제로 적용하고 헤더 이름을 무시합니다. 문서는 잘못된 결과를 피하려면 끄라고 권합니다.

## 8. 정렬, 반복, 리스트 변환

### 8-1. 정렬

```python
DataFrame.sort(*cols, **kwargs)        # ascending=True 기본
DataFrame.orderBy(*cols, **kwargs)     # sort와 같다
DataFrame.sortWithinPartitions(*cols, **kwargs)
```

```python
orders.orderBy(F.desc("amount"), F.asc("order_id"))
orders.sort(F.col("amount").desc(), "order_id")
orders.sort(["amount", "order_id"], ascending=[False, True])   # 리스트 길이가 cols와 같아야 한다
orders.orderBy(F.col("status").desc_nulls_last())
```

| 기본 | 값 |
|---|---|
| 방향 | 오름차순 |
| 오름차순의 null | 처음(NULLS FIRST) |
| 내림차순의 null | 마지막(NULLS LAST) |
| 4.0.0~ | 컬럼 위치(1부터)도 받는다. 음수면 내림차순 |

`sort`/`orderBy`는 전체 정렬이라 셔플이 일어납니다. `sortWithinPartitions`는 파티션 안만 정렬합니다.

### 8-2. 드라이버로 가져오기

| 메서드 | 반환 | 메모리 |
|---|---|---|
| `collect()` | `Row` 리스트 전체 | 전부 드라이버에 |
| `take(num)` | `Row` 리스트 | num개 |
| `head(n=None)` | n을 주면 리스트, 안 주면 `Row` 하나 | |
| `first()` | `Row` 하나, 비면 `None` | |
| `tail(num)` | 마지막 num개 리스트(3.0.0~) | num이 크면 드라이버 OOM 경고 |
| `toLocalIterator(prefetchPartitions=False)` | 행 iterator | 가장 큰 파티션 하나만큼(prefetch면 두 개) |
| `toPandas()` | pandas DataFrame | 전부. pandas 필요 |
| `limit(num)` | DataFrame(트랜스포메이션) | 드라이버로 오지 않는다 |

```python
rows = orders.orderBy(F.desc("amount")).collect()
[r.asDict() for r in rows]            # dict 리스트
[r["order_id"] for r in rows]         # 한 컬럼 값 리스트
[r.order_id for r in orders.select("order_id").toLocalIterator()]

pdf = orders.limit(100).toPandas()    # 작게 줄인 뒤 변환
```

샘플 문항 4번의 정답 보기는 `orderBy(col(...).desc(), ...)`로 정렬하고 `collect()` 결과에 `row.asDict()`를 적용하는 코드입니다. `sort(..., descending=True)`는 존재하지 않는 인자이고 `show()`는 `None`을 돌려주며 `toList()`는 DataFrame 메서드가 아닙니다.

4.2.0부터 `spark.sql.execution.arrow.pyspark.enabled`가 기본 true라서 `toPandas()`와 pandas에서 만드는 `createDataFrame`이 Arrow를 씁니다(PySpark Migration Guide, 4.1 → 4.2). 3.x와 4.1까지는 기본 false였습니다.

### 8-3. 반복

안내서의 "iterating"은 행을 하나씩 도는 방법을 묻습니다. 어디서 도는지가 핵심이라 실행 위치로 나눕니다.

| 방법 | 함수가 도는 곳 | 쓰임 |
|---|---|---|
| `for r in df.collect():` | 드라이버 | 작은 결과. 전체를 한 번에 드라이버로 모은다 |
| `for r in df.toLocalIterator():` | 드라이버 | 큰 결과를 파티션 단위로 받아 돈다. 메모리는 가장 큰 파티션 하나만큼 |
| `df.foreach(f)` | 익스큐터 | 행마다 `f(row)`. 반환값이 없는 액션 |
| `df.foreachPartition(f)` | 익스큐터 | 파티션마다 `f(iterator)`. 외부 연결을 파티션당 한 번 연다 |

`foreach`와 `foreachPartition`은 드라이버의 리스트에 값을 모으는 용도로 쓸 수 없습니다. 함수가 익스큐터에서 돌고 각 익스큐터는 드라이버 변수의 복사본을 고칩니다. 외부 시스템에 쓰거나 accumulator를 더할 때 씁니다. 4.2.0 문서 기준으로 두 메서드는 4.0.0부터 Spark Connect에서도 쓸 수 있습니다.

DataFrame과 리스트 사이 변환은 다음 정도를 외워 둡니다.

```python
orders.columns                                            # ['order_id', 'user_id', ...] 컬럼 이름 리스트
[r.asDict() for r in orders.collect()]                    # dict 리스트
[r["order_id"] for r in orders.select("order_id").collect()]   # 한 컬럼 값 리스트
[r[0] for r in orders.select("order_id").collect()]            # 위치로 꺼내도 같다
orders.select("order_id").rdd.flatMap(lambda r: r).collect()   # RDD 경유. Spark Connect에서는 .rdd를 쓸 수 없다

# 리스트 → DataFrame
spark.createDataFrame([(1, "PAID"), (2, "CANCELED")], ["order_id", "status"])
spark.createDataFrame([Row(order_id=1, status="PAID")])
```

### 헷갈리는 지점

- `show()`는 기본 20행, 20자 넘는 문자열 자르기(`truncate=True`)입니다. 반환값은 `None`입니다.
- `take(5)`와 `limit(5)`의 차이는 반환 타입입니다. `take`는 리스트(액션), `limit`은 DataFrame(트랜스포메이션)입니다.
- `head()`와 `head(1)`은 다릅니다. 앞은 `Row`, 뒤는 `Row` 하나가 든 리스트입니다.

## 9. UDF

### 9-1. 일반 Python UDF

```python
F.udf(f=None, returnType=StringType(), *, useArrow=None)
spark.udf.register(name, f, returnType=None)
```

| 항목 | 4.2.0 문서 |
|---|---|
| 반환 타입 기본값 | `StringType` |
| 반환 타입 지정 | `DataType` 객체나 DDL 타입 문자열(`"int"`) |
| 결정성 | 기본으로 결정적 함수로 본다. 아니면 `asNondeterministic()` |
| 조건 평가 | 조건식이나 불리언 단락 평가를 지원하지 않는다. 특정 행에서 실패할 수 있으면 조건을 함수 안에 넣는다 |
| 호출 쪽 키워드 인자 | 4.0.0부터 받는다(`calc(b=..., a=...)` 예제). 같은 페이지 Notes에는 받지 않는다는 예전 문장이 남아 있다 |
| Arrow | 4.2.0부터 기본으로 Arrow 직렬화. `useArrow=None`이면 `spark.sql.execution.pythonUDF.arrow.enabled`(4.2.0 기본 true, 그 전 false)를 따른다 |
| 타입 힌트 | 4.1.0부터 pandas UDF 형태의 타입 힌트(`pd.Series -> pd.Series`)를 붙이면 `udf`로 만들어도 벡터화된 pandas UDF가 된다 |

```python
@F.udf(returnType="int")
def item_count(items):
    if items is None:          # null 처리는 함수가 직접 한다
        return 0
    return len(items)

def grade_of(amount):
    return "HIGH" if amount is not None and amount >= 30000 else "LOW"

grade_udf = F.udf(grade_of)    # returnType 생략 → StringType

orders.select("order_id", item_count("items").alias("n"), grade_udf("amount").alias("grade"))

# SQL에서 쓰려면 등록한다
spark.udf.register("grade_of", grade_of)                # 반환 타입 기본 string
spark.udf.register("item_count", item_count)            # 이미 udf면 그 반환 타입을 쓴다. returnType을 주면 안 된다
orders.createOrReplaceTempView("orders_v")
spark.sql("SELECT order_id, grade_of(amount) AS grade FROM orders_v")
```

반환 타입을 실제 값과 다르게 선언하면 결과가 틀어집니다. Arrow를 쓰지 않는 경로는 4.2.0 소스(`EvaluatePython.makeFromJava`)에서 선언 타입과 맞지 않는 값을 null로 바꾸고 선언이 문자열일 때만 값을 문자열로 바꿔 받습니다. 그래서 위 `item_count`를 `returnType` 없이 만들면 오류도 null도 없이 정수가 `"2"` 같은 문자열로 나옵니다. 4.2.0 기본인 Arrow 경로의 변환 규칙은 확인하지 못했습니다. 반환 타입은 항상 맞춰 적습니다.

### 9-2. pandas UDF

```python
F.pandas_udf(f=None, returnType=None, functionType=None)
```

pandas UDF는 Arrow로 데이터를 넘기고 pandas로 계산합니다. 3.0부터는 Python 타입 힌트로 종류를 정하고 `functionType`은 호환용으로만 남아 있습니다. 7영역(pandas API on Spark)에서 자세히 다룹니다.

```python
import pandas as pd

@F.pandas_udf("double")
def with_vat(amount: pd.Series) -> pd.Series:
    return amount * 1.1

orders.select("order_id", with_vat("amount").alias("amount_vat"))
```

### 9-3. stateful 연산자와 StateStore

안내서 문구는 "Create and invoke user-defined functions with or without stateful operators, including StateStores"입니다. 배치 DataFrame의 UDF는 행마다 독립적으로 계산하고 상태를 들고 있지 않습니다. 상태가 생기는 곳은 Structured Streaming입니다. 둘을 이렇게 나눕니다.

| 구분 | 예 | 상태 |
|---|---|---|
| 상태 없는 함수 | `udf`, `pandas_udf`, 내장 함수 | 행이나 배치마다 독립 계산. 앞 트리거의 값을 기억하지 않는다 |
| 내장 stateful 연산자 | 스트리밍 `groupBy().agg()`, 윈도 집계, `dropDuplicates`, 스트림-스트림 조인 | Spark가 State Store에 그룹별 중간 결과를 저장한다 |
| 사용자 정의 상태 함수 | `applyInPandasWithState`(3.4.0~), `transformWithStateInPandas`(4.0.0~) | 사용자가 그룹별 상태를 읽고 쓴다. 저장은 State Store가 맡는다 |

시험 보기에서 "UDF가 이전 배치의 값을 기억한다"는 설명은 상태 없는 UDF에는 맞지 않습니다. 이전 값을 기억해야 하면 위 표 세 번째 줄의 API를 씁니다. 각 연산자의 출력 모드와 워터마크는 [Ch-05](/blog/cert/spark/spark-05-structured-streaming)에서 다룹니다.

| 개념 | 4.2.0 Structured Streaming 문서 |
|---|---|
| State store | 읽기와 쓰기를 제공하는 버전 관리 키-값 저장소. 배치 사이의 stateful 연산을 처리한다 |
| 기본 구현 | HDFS 상태 저장소 제공자. 먼저 메모리 맵에 두고 HDFS 호환 파일 시스템에 백업한다 |
| RocksDB | 3.2부터 내장. `spark.sql.streaming.stateStore.providerClass`를 `org.apache.spark.sql.execution.streaming.state.RocksDBStateStoreProvider`로 준다 |
| 임의 상태 연산 | 2.2부터 `mapGroupsWithState`, `flatMapGroupsWithState`(지금은 legacy). 4.0부터 `transformWithState`를 권한다 |

기본 구현은 상태를 익스큐터 JVM 메모리에 두기 때문에 상태 객체가 많으면 GC 일시 정지가 길어질 수 있다고 문서가 적습니다. RocksDB 제공자가 나온 이유입니다. 사용법은 [Ch-05](/blog/cert/spark/spark-05-structured-streaming)에서 다룹니다.

### 헷갈리는 지점

- UDF는 최적화기가 안을 들여다볼 수 없습니다. 같은 일을 하는 내장 함수(`F.size`, `F.when`)가 있으면 내장 함수가 낫습니다. 이 권고는 공식 문서 문장으로 확인하지 못했고 일반적인 설명입니다.
- `udf`가 결정적 함수로 취급되므로 최적화 과정에서 호출이 줄거나 늘 수 있다고 문서가 적습니다. 난수나 현재 시각을 쓰는 UDF는 `asNondeterministic()`을 붙입니다.
- `register`는 Python 함수에는 `returnType`을 줄 수 있고 이미 만든 UDF에는 줄 수 없습니다.

## 10. broadcast 변수와 accumulator

### 10-1. broadcast 변수

```python
bc = spark.sparkContext.broadcast(value)   # SparkContext.broadcast(value) → Broadcast
bc.value
bc.unpersist(blocking=False)               # 익스큐터 복사본 삭제. 다시 쓰면 다시 broadcast
bc.destroy(blocking=False)                 # 영구 해제. 이후 사용 불가
```

RDD 가이드의 설명입니다. broadcast 변수는 읽기 전용 값을 Task마다 보내지 않고 머신마다 한 번 캐시해 둡니다. Spark는 Stage 안의 Task가 공통으로 쓰는 데이터를 이미 자동으로 broadcast하므로 직접 만드는 broadcast 변수는 여러 Stage가 같은 데이터를 쓰거나 역직렬화된 형태로 캐시하는 것이 중요할 때 쓸모가 있다고 적습니다. broadcast한 뒤에는 원래 객체를 바꾸지 말라고도 적습니다.

```python
city_names = {"Seoul": "서울", "Busan": "부산"}
bc_city = spark.sparkContext.broadcast(city_names)

@F.udf("string")
def city_label(city):
    return bc_city.value.get(city, "기타")

users.select("user_id", city_label("city").alias("city_ko"))
```

### 10-2. accumulator

```python
acc = spark.sparkContext.accumulator(0)    # SparkContext.accumulator(value, accum_param=None)
acc.add(1)                                 # 또는 acc += 1  (Task에서)
acc.value                                  # 드라이버에서만 읽는다
```

| 규칙 | 문서 |
|---|---|
| 연산 | 결합·교환 법칙이 성립하는 "더하기"만 |
| 읽기 | Task는 값을 읽을 수 없다. 드라이버만 `value`로 읽는다 |
| 기본 타입 | 정수와 실수는 기본 `AccumulatorParam`. 그 밖의 타입은 직접 만든다 |
| 액션 안의 갱신 | Task마다 정확히 한 번 반영된다. 재시작한 Task는 다시 더하지 않는다 |
| 트랜스포메이션 안의 갱신 | Task나 Stage가 다시 실행되면 여러 번 반영될 수 있다 |
| 지연 평가 | 트랜스포메이션 안의 갱신은 액션이 그 계산을 실행할 때만 일어난다 |

```python
bad_rows = spark.sparkContext.accumulator(0)

def check(row):
    if row.status is None:
        bad_rows.add(1)

orders.foreach(check)      # 액션 안에서 더했으므로 Task마다 한 번만 반영
print(bad_rows.value)      # 문서 기준 예상 결과: 2 (status가 null인 중복 행 2개)
```

### 헷갈리는 지점

- broadcast 변수는 읽기 전용, accumulator는 Task 쪽에서 쓰기 전용(더하기)이라고 짝지어 외우면 됩니다.
- `map` 같은 트랜스포메이션 안에서 accumulator를 더하고 액션을 부르지 않으면 값은 0 그대로입니다. RDD 가이드 예제가 이 경우입니다.
- `spark.sparkContext`가 필요하므로 Spark Connect(Databricks 서버리스 포함)에서는 이 절의 코드를 쓸 수 없습니다([Ch-00](/blog/cert/spark/spark-00-exam-and-study-plan) 3절).

## 11. 윈도 함수

안내서 3영역 목록에 윈도 함수가 따로 적혀 있지는 않습니다. 다만 2-1절처럼 "같은 키에서 특정 행 하나 남기기"를 풀려면 필요하고 정렬, 집계 문항의 보기에 자주 섞입니다. `groupBy`는 그룹마다 한 행으로 줄이고 윈도 함수는 행 수를 그대로 둔 채 같은 그룹의 값을 옆에 붙입니다.

### 11-1. Window 스펙과 기본 프레임

```python
from pyspark.sql import Window

Window.partitionBy(*cols)            # 그룹. 없으면 전체가 한 그룹
Window.orderBy(*cols)                # 그룹 안 순서
WindowSpec.rowsBetween(start, end)   # 행 개수 기준 프레임, 양 끝 포함
WindowSpec.rangeBetween(start, end)  # 정렬 키 값 기준 프레임, 양 끝 포함
Window.unboundedPreceding, Window.unboundedFollowing, Window.currentRow
```

`Window` 문서의 기본 프레임 규칙이 집계 결과를 가릅니다.

| 스펙 | 기본 프레임 | 집계 함수(`sum`, `avg`)의 결과 |
|---|---|---|
| `orderBy` 없음 | ROWS, 처음부터 끝까지 | 그룹 전체 값. 모든 행이 같은 값 |
| `orderBy` 있음 | RANGE, 처음부터 현재 행까지 | 누적값(running total) |

RANGE 프레임은 정렬 키가 같은 행을 한 덩어리로 봅니다. 같은 시각의 주문이 둘이면 두 행의 누적값이 같게 나옵니다. 행 단위 누적이 필요하면 `rowsBetween(Window.unboundedPreceding, Window.currentRow)`를 명시합니다.

`partitionBy` 없이 `orderBy`만 주면 모든 데이터가 파티션 하나로 모입니다. Spark 4.2.0 소스(`WindowExecBase.scala`)에 "No Partition Defined for Window operation! Moving all data to a single partition" 경고가 있습니다.

### 11-2. 순위와 앞뒤 행

| 함수 | 같은 값(동점)이 있을 때 | 예: 54000, 32000, 15000, 15000, 8000 |
|---|---|---|
| `row_number()` | 동점에도 다른 번호 | 1, 2, 3, 4, 5 |
| `rank()` | 같은 번호, 다음 번호를 건너뛴다 | 1, 2, 3, 3, 5 |
| `dense_rank()` | 같은 번호, 건너뛰지 않는다 | 1, 2, 3, 3, 4 |
| `lag(col, offset=1, default=None)` | offset만큼 앞 행 값. 없으면 default | |
| `lead(col, offset=1, default=None)` | offset만큼 뒤 행 값 | |

순위 함수와 `lag`, `lead`는 `orderBy`가 있는 윈도에서 씁니다.

```python
o = orders.dropDuplicates()
by_user_time = Window.partitionBy("user_id").orderBy(F.col("ordered_at").desc())

# 회원마다 가장 최근 주문 하나(2-1절의 dropDuplicates로는 고를 수 없던 것)
latest = (o.withColumn("rn", F.row_number().over(by_user_time))
           .filter(F.col("rn") == 1)
           .drop("rn"))
# 문서 기준 예상 결과: 101 → 주문 3, 102 → 주문 5, 103 → 주문 4

running = Window.partitionBy("user_id").orderBy("ordered_at")
o.select(
    "user_id", "order_id", "amount",
    F.sum("amount").over(running).alias("running_total"),      # 기본 프레임이라 누적
    F.sum("amount").over(Window.partitionBy("user_id")).alias("user_total"),   # orderBy 없음 → 그룹 합계
    F.lag("amount").over(running).alias("prev_amount"),       # 첫 주문은 null
)
# 회원 102: 주문 2(15000) → 누적 15000, 주문 5(15000) → 누적 30000. user_total은 둘 다 30000
```

`row_number()`는 동점일 때 어느 행이 1번이 될지 정해지지 않습니다. 결과를 고정하려면 `orderBy`에 `order_id` 같은 고유 컬럼을 하나 더 넣습니다.

## 12. 배열 고차 함수, pivot, 샘플링

### 12-1. 배열 고차 함수

배열 컬럼을 펼치지 않고 원소마다 식을 적용하는 함수들입니다. 모두 3.1.0에 Python API가 생겼고 Python lambda는 Column을 받아 Column을 돌려줘야 합니다. 문서는 lambda 안에서 Python UDF를 쓸 수 없다고 적습니다(SPARK-27052).

| 함수 | 시그니처 | 반환 |
|---|---|---|
| `transform` | `transform(col, f)`. `f`는 `x` 하나 또는 `(x, i)`(i는 0부터 시작하는 인덱스) | 배열 |
| `filter` | `filter(col, f)`. 형태는 `transform`과 같다 | 조건을 만족하는 원소의 배열 |
| `exists` | `exists(col, f)` | 하나라도 참이면 true |
| `forall` | `forall(col, f)` | 모두 참이면 true |
| `aggregate` | `aggregate(col, initialValue, merge, finish=None)` | `merge(acc, x)`로 접은 값 하나 |

```python
orders.select(
    "order_id",
    F.transform("items", lambda x: F.upper(x)).alias("items_upper"),
    F.filter("items", lambda x: x != "pen").alias("without_pen"),
    F.exists("items", lambda x: x == "book").alias("has_book"),
    F.forall("items", lambda x: F.length(x) <= 4).alias("short_names"),
    F.aggregate("items", F.lit(0), lambda acc, x: acc + F.length(x)).alias("chars"),
)
# 문서 정의로 예상한 주문 1(["book", "pen"])의 결과: ["BOOK", "PEN"], ["book"], true, true, 7
```

`F.filter`는 배열 함수이고 `DataFrame.filter`는 행을 거르는 메서드입니다. 이름이 같아서 보기에서 섞이기 쉽습니다.

### 12-2. pivot

```python
GroupedData.pivot(pivot_col, values=None)
```

`groupBy` 뒤에 `pivot`을 붙이고 `agg`로 값을 채웁니다. `pivot_col`의 값마다 결과 컬럼이 하나씩 생깁니다.

```python
o.groupBy("user_id").pivot("status", ["PAID", "CANCELED"]).agg(F.sum("amount"))
# 문서 기준 예상 결과
# user_id | PAID  | CANCELED
# 101     | 32000 | 8000
# 102     | 15000 | null
# 103     | 54000 | null
```

`values`를 생략하면 결과 스키마를 정하려고 `pivot_col`의 고유값을 먼저 계산한다고 문서가 적습니다(eager computation). 트랜스포메이션을 정의하는 시점에 Job이 하나 더 돕니다. 값 목록을 알고 있으면 `values`로 넘겨 그 계산을 없앱니다. 목록에 없는 값(위 예제에서 status가 null인 주문 5)은 결과 컬럼에 들어가지 않습니다.

`pivot`은 `GroupedData`의 메서드라서 `groupBy` 없이 DataFrame에서 바로 부를 수 없습니다. 반대로 넓은 표를 긴 표로 되돌리는 메서드는 `DataFrame.unpivot(ids, values, variableColumnName, valueColumnName)`(3.4.0~, 별칭 `melt`)입니다. 문서는 집계까지 되돌리지는 못한다고 적습니다.

### 12-3. 샘플링

| 메서드 | 시그니처 | 주의 |
|---|---|---|
| `sample` | `sample(withReplacement=None, fraction=None, seed=None)` | `fraction`은 0.0~1.0의 비율이다. 정확히 그 비율만큼 나온다는 보장이 없다 |
| `sampleBy` | `sampleBy(col, fractions, seed=None)` | 층(stratum)별 비율을 dict로. dict에 없는 층은 비율 0으로 본다. 비복원 추출 |
| `randomSplit` | `randomSplit(weights, seed=None)` | DataFrame 리스트를 돌려준다. 가중치 합이 1이 아니면 정규화한다 |

```python
orders.sample(fraction=0.5, seed=42)        # 약 절반. 시드를 빼면 실행마다 행 수가 달라진다
orders.sample(0.5, 42)                      # 첫 위치 인자가 float면 fraction으로 받는다(문서 예제)
orders.sampleBy("status", fractions={"PAID": 0.5, "CANCELED": 1.0}, seed=7)
train, test = orders.randomSplit([8.0, 2.0], seed=7)   # [0.8, 0.2]로 정규화
```

샘플 행 수를 정확히 n개로 맞춰야 하면 `orderBy(F.rand(seed)).limit(n)`처럼 무작위로 정렬한 뒤 자릅니다. 이때는 전체 정렬 비용이 듭니다.

## 13. 확인 문제

직접 만든 문제입니다. 시험 문항이나 문제 은행에서 가져오지 않았습니다.

**문제 1.** 다음 코드의 결과 DataFrame 컬럼으로 맞는 것은?

```python
df = (orders.select("order_id", "user_id", "amount")
            .withColumnRenamed("userid", "uid")
            .withColumn("amount", F.col("amount") * 2)
            .drop("amt"))
```

A. 오류가 난다. B. `order_id`, `uid`, `amount` C. `order_id`, `user_id`, `amount` D. `order_id`, `user_id`, `amount`, `amount`

<details>
<summary>정답과 풀이</summary>

C. `withColumnRenamed`와 `drop`은 없는 컬럼 이름(`userid`, `amt`)을 주면 no-op이라 오류가 없습니다. `withColumn("amount", ...)`는 같은 이름이 있어 교체하므로 컬럼이 늘지 않습니다.

</details>

**문제 2.** `status`, `amount`, `items` 중 `status`가 null인 행만 지우는 코드는?

A. `df.na.drop()` B. `df.na.drop("all")` C. `df.na.drop(subset=["status"])` D. `df.na.fill("x", subset=["status"])`

<details>
<summary>정답과 풀이</summary>

C. A는 어느 컬럼이든 null이 있으면 지우고 B는 모든 컬럼이 null일 때만 지웁니다. D는 지우지 않고 채웁니다.

</details>

**문제 3.** 다음 두 DataFrame에 대해 `a.union(b).collect()`의 결과로 맞는 것은?

```python
a = spark.createDataFrame([(1, 101)], "order_id INT, user_id INT")
b = spark.createDataFrame([(102, 2)], "user_id INT, order_id INT")
```

A. `[Row(order_id=1, user_id=101), Row(order_id=2, user_id=102)]`
B. `[Row(order_id=1, user_id=101), Row(order_id=102, user_id=2)]`
C. 컬럼 순서가 달라 예외가 난다.
D. 중복이 제거되어 한 행만 남는다.

<details>
<summary>정답과 풀이</summary>

B. `union`은 이름을 보지 않고 위치로 맞춥니다. 두 컬럼 모두 INT라서 오류 없이 `b`의 `user_id` 값 102가 `order_id` 자리에 들어갑니다. A처럼 붙이려면 `a.unionByName(b)`를 씁니다. `union`은 중복을 없애지 않습니다.

</details>

**문제 4.** 결제가 한 번도 없는 회원만 회원 컬럼 그대로 얻는 코드는?

A. `users.join(payments, "user_id", "left")` B. `users.join(payments, "user_id", "left_anti")` C. `users.join(payments, "user_id", "left_semi")` D. `users.crossJoin(payments)`

<details>
<summary>정답과 풀이</summary>

B. `left_anti`는 오른쪽에 매칭이 없는 왼쪽 행을 왼쪽 컬럼만으로 돌려줍니다. 예제 데이터에서는 104입니다. A는 모든 회원과 결제 컬럼(null 포함)을 돌려주고 C는 결제가 있는 회원입니다.

</details>

**문제 5.** 세션 시간대가 UTC일 때 `F.from_unixtime(F.lit(1790812800))`의 결과 타입과 값은?

A. TimestampType, 2026-10-01 00:00:00 B. StringType, '2026-10-01 00:00:00' C. LongType, 1790812800 D. DateType, 2026-10-01

<details>
<summary>정답과 풀이</summary>

B. `from_unixtime`은 기본 형식 `yyyy-MM-dd HH:mm:ss`의 문자열을 돌려줍니다. 타임스탬프가 필요하면 `timestamp_seconds`, 날짜가 필요하면 `to_date`를 덧붙입니다.

</details>

**문제 6.** 다음 코드에서 `acc.value`로 맞는 것은? (`orders`는 6행)

```python
acc = spark.sparkContext.accumulator(0)
def tag(r):
    acc.add(1)
    return r
rdd2 = orders.rdd.map(tag)
print(acc.value)
```

A. 0 B. 6 C. 12 D. 오류

<details>
<summary>정답과 풀이</summary>

A. `map`은 트랜스포메이션이라 액션이 없으면 실행되지 않습니다. 액션을 부른 뒤에는 6이 되지만 트랜스포메이션 안의 갱신이라 Task가 다시 실행되면 6보다 커질 수 있습니다.

</details>

**문제 7.** 5GB 주문 테이블과 2MB 회원 테이블을 `user_id`로 조인합니다. 기본 설정에서 맞는 설명은?

A. 기본 임계값 10MB보다 작으므로 회원 테이블이 자동으로 broadcast될 수 있다.
B. broadcast 조인은 양쪽을 모두 셔플한다.
C. `F.broadcast(orders)`로 큰 쪽을 감싸야 한다.
D. broadcast 힌트는 임계값을 넘는 테이블에는 적용되지 않는다.

<details>
<summary>정답과 풀이</summary>

A. `spark.sql.autoBroadcastJoinThreshold` 기본은 10MB입니다. broadcast 조인은 작은 쪽을 보내 큰 쪽의 셔플을 없애므로 B와 C는 틀립니다. 문서는 힌트를 주면 추정 크기가 임계값을 넘어도 broadcast를 우선한다고 적으므로 D도 틀립니다.

</details>

**문제 8.** `w = Window.partitionBy("user_id").orderBy("ordered_at")`일 때 `F.sum("amount").over(w)`가 회원 102의 두 주문(15000, 15000, 시각이 다름)에 주는 값은?

A. 30000, 30000 B. 15000, 30000 C. 15000, 15000 D. `rowsBetween`이 없어서 오류

<details>
<summary>정답과 풀이</summary>

B. `orderBy`가 있는 윈도의 기본 프레임은 처음부터 현재 행까지(RANGE)라서 누적합이 나옵니다. A는 `orderBy`가 없을 때(그룹 전체 합)의 결과입니다. 프레임을 생략해도 오류가 나지 않으므로 D는 틀립니다.

</details>

**문제 9.** 다음 중 `status` 값 목록을 미리 계산하는 Job 없이 pivot하는 코드는?

A. `o.groupBy("user_id").pivot("status").agg(F.sum("amount"))`
B. `o.groupBy("user_id").pivot("status", ["PAID", "CANCELED"]).agg(F.sum("amount"))`
C. `o.pivot("status").groupBy("user_id").sum("amount")`
D. `o.groupBy("user_id").agg(F.pivot("status"))`

<details>
<summary>정답과 풀이</summary>

B. `values`를 주면 결과 스키마를 바로 정할 수 있어 고유값 계산을 건너뜁니다. A는 동작하지만 고유값을 먼저 계산합니다. `pivot`은 `GroupedData`의 메서드라서 C처럼 DataFrame에서 바로 부를 수 없습니다. 4.2.0 함수 목록에 `pivot`이라는 함수는 없으므로 D도 틀립니다.

</details>

## 범위와 한계

- 시그니처와 기본값은 2026년 10월 19일에 연 PySpark 4.2.0 API 문서와 Spark 4.2.0 문서 기준입니다. 3.x와 다른 부분은 문서에 버전이 적힌 것만 표시했습니다(ANSI 기본 켜짐 4.0, `size(null)`의 -1과 null, `try_to_date` 4.0.0, `try_to_timestamp` 3.5.0, `Column.try_cast` 4.0.0, `StructType.fromDDL` 4.0.0, 컬럼 위치 정렬 4.0.0, UDF 호출 쪽 키워드 인자 4.0.0, 타입 힌트 `udf`의 벡터화 4.1.0, Arrow 기본 4.2, Python UDF Arrow 기본 4.2, `countDistinct`는 3.5.9 문서와 비교). 2026년 10월 20일에 2-3절, 4-2절, 6절, 8-3절, 9절을 다시 확인해 고쳤고 11절과 12절을 더했습니다. 시험의 기준 Spark 버전은 공개되지 않았습니다.
- 코드는 아직 실행하지 않았습니다. 이 노트북에 Java가 없어 PySpark를 띄울 수 없었습니다. "문서 기준 예상 결과"는 API 문서의 정의와 예제로 예상한 값이고 epoch 값은 Python `datetime`으로 계산했습니다.
- 2026년 10월 21일에 Spark 4.2.0 소스로 `union`의 타입 맞추기, 0으로 나누기, `unix_timestamp`의 ANSI 동작, `left_semi`의 중복 처리, 비 Arrow UDF의 반환 타입 불일치, 파일 소스의 nullable 처리, `countDistinct` 별칭을 확인해 본문에 반영했습니다. `approx_count_distinct`와 `count_distinct`의 셔플 비교도 문서 문장 없이 소스로만 확인한 내용입니다.
- 확인하지 못한 것은 Arrow 경로 UDF의 반환 타입 불일치 결과, 내장 함수가 UDF보다 낫다는 권고의 공식 문서 문장, 12-1절 고차 함수의 실제 결과값(실행하지 않음)입니다.

## 참고 자료

시험
- Databricks, [Exam Guide, 2026-10-08판](https://www.databricks.com/sites/default/files/2026-10/databricks-certified-associate-developer-apache-spark-exam-guide-august-2026.pdf), [Exam Guide, Oct 2025](https://www.databricks.com/sites/default/files/2025-10/databricks-certified-associate-developer-apache-spark-exam-guide-oct-2025.pdf) (Section 3 항목과 샘플 문항 3, 4, 6번)

PySpark 4.2.0 API
- DataFrame: [withColumn](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.withColumn.html), [withColumns](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.withColumns.html), [drop](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.drop.html), [withColumnRenamed](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.withColumnRenamed.html), [withColumnsRenamed](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.withColumnsRenamed.html), [filter](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.filter.html), [distinct](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.distinct.html), [dropDuplicates](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.dropDuplicates.html), [dropna](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.dropna.html), [fillna](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.fillna.html), [describe](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.describe.html), [summary](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.summary.html), [groupBy](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.groupBy.html), [join](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.join.html), [crossJoin](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.crossJoin.html), [union](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.union.html), [unionAll](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.unionAll.html), [unionByName](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.unionByName.html), [sort](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.sort.html), [collect](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.collect.html), [head](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.head.html), [tail](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.tail.html), [toLocalIterator](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.toLocalIterator.html), [toPandas](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.toPandas.html), [printSchema](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.printSchema.html), [hint](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.hint.html)
- functions: [split](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.functions.split.html), [explode](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.functions.explode.html), [explode_outer](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.functions.explode_outer.html), [count](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.functions.count.html), [count_distinct](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.functions.count_distinct.html), [approx_count_distinct](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.functions.approx_count_distinct.html), [mean](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.functions.mean.html), [from_unixtime](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.functions.from_unixtime.html), [unix_timestamp](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.functions.unix_timestamp.html), [to_date](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.functions.to_date.html), [try_to_date](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.functions.try_to_date.html), [date_format](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.functions.date_format.html), [dayofweek](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.functions.dayofweek.html), [timestamp_seconds](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.functions.timestamp_seconds.html), [broadcast](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.functions.broadcast.html), [udf](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.functions.udf.html), [pandas_udf](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.functions.pandas_udf.html)
- 그 밖: [GroupedData.agg](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.GroupedData.agg.html), [DataFrameNaFunctions.fill](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrameNaFunctions.fill.html), [StructType](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.types.StructType.html), [StructField](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.types.StructField.html), [DataFrameReader.schema](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrameReader.schema.html), [SparkSession.createDataFrame](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.SparkSession.createDataFrame.html), [UDFRegistration.register](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.UDFRegistration.register.html), [SparkContext.broadcast](https://spark.apache.org/docs/latest/api/python/reference/api/pyspark.SparkContext.broadcast.html), [SparkContext.accumulator](https://spark.apache.org/docs/latest/api/python/reference/api/pyspark.SparkContext.accumulator.html), [Broadcast](https://spark.apache.org/docs/latest/api/python/reference/api/pyspark.Broadcast.html), [Accumulator](https://spark.apache.org/docs/latest/api/python/reference/api/pyspark.Accumulator.html)
- 2026-10-20 추가 확인: [functions.size](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.functions.size.html), [functions.try_to_timestamp](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.functions.try_to_timestamp.html), [Column.try_cast](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.Column.try_cast.html), [DataFrame.foreach](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.foreach.html), [DataFrame.foreachPartition](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.foreachPartition.html), [GroupedData.applyInPandasWithState](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.GroupedData.applyInPandasWithState.html), [GroupedData.transformWithStateInPandas](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.GroupedData.transformWithStateInPandas.html), [Window](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.Window.html), [functions.row_number](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.functions.row_number.html), [functions.rank](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.functions.rank.html), [functions.dense_rank](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.functions.dense_rank.html), [functions.lag](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.functions.lag.html), [functions.transform](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.functions.transform.html), [functions.filter](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.functions.filter.html), [functions.exists](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.functions.exists.html), [functions.forall](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.functions.forall.html), [functions.aggregate](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.functions.aggregate.html), [GroupedData.pivot](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.GroupedData.pivot.html), [DataFrame.unpivot](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.unpivot.html), [DataFrame.sample](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.sample.html), [DataFrame.sampleBy](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.sampleBy.html), [DataFrame.randomSplit](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.randomSplit.html)
- 3.5.9 비교: [functions.countDistinct (3.5.9)](https://spark.apache.org/docs/3.5.9/api/python/reference/pyspark.sql/api/pyspark.sql.functions.countDistinct.html), [functions.unix_timestamp (3.5.9)](https://spark.apache.org/docs/3.5.9/api/python/reference/pyspark.sql/api/pyspark.sql.functions.unix_timestamp.html)

Apache Spark 4.2.0 문서
- [NULL Semantics](https://spark.apache.org/docs/latest/sql-ref-null-semantics.html), [Parquet Files](https://spark.apache.org/docs/latest/sql-data-sources-parquet.html), [Column.eqNullSafe](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.Column.eqNullSafe.html), [JOIN](https://spark.apache.org/docs/latest/sql-ref-syntax-qry-select-join.html), [ORDER BY](https://spark.apache.org/docs/latest/sql-ref-syntax-qry-select-orderby.html)
- [ANSI Compliance](https://spark.apache.org/docs/latest/sql-ref-ansi-compliance.html), [SQL Migration Guide](https://spark.apache.org/docs/latest/sql-migration-guide.html), [PySpark Migration Guide](https://spark.apache.org/docs/latest/api/python/migration_guide/pyspark_upgrade.html)
- [Performance Tuning](https://spark.apache.org/docs/latest/sql-performance-tuning.html), [RDD Programming Guide](https://spark.apache.org/docs/latest/rdd-programming-guide.html)
- [Spark SQL, Built-in Functions: Collection Functions](https://spark.apache.org/docs/latest/api/sql/collection-functions/) (`size`, `cardinality`), [Aggregate Functions](https://spark.apache.org/docs/latest/api/sql/agg-functions/) (`approx_count_distinct`)
- Spark 3.5.9 비교: [Spark SQL, Built-in Functions (3.5.9)](https://spark.apache.org/docs/3.5.9/api/sql/index.html) (`size`, `try_divide`)
- [Structured Streaming: APIs on DataFrames and Datasets](https://spark.apache.org/docs/latest/streaming/apis-on-dataframes-and-datasets.html) (State Store 절)

Apache Spark 4.2.0 소스
- [sql/core/.../aggregate/AggUtils.scala](https://github.com/apache/spark/blob/v4.2.0/sql/core/src/main/scala/org/apache/spark/sql/execution/aggregate/AggUtils.scala) (`planAggregateWithOneDistinct`)
- [sql/core/.../window/WindowExecBase.scala](https://github.com/apache/spark/blob/v4.2.0/sql/core/src/main/scala/org/apache/spark/sql/execution/window/WindowExecBase.scala) (파티션 없는 윈도 경고)
- [sql/catalyst/.../analysis/TypeCoercionBase.scala](https://github.com/apache/spark/blob/v4.2.0/sql/catalyst/src/main/scala/org/apache/spark/sql/catalyst/analysis/TypeCoercionBase.scala) (`WidenSetOperationTypes`), [AnsiStringPromotionTypeCoercion.scala](https://github.com/apache/spark/blob/v4.2.0/sql/catalyst/src/main/scala/org/apache/spark/sql/catalyst/analysis/AnsiStringPromotionTypeCoercion.scala), [TypeCoercion.scala](https://github.com/apache/spark/blob/v4.2.0/sql/catalyst/src/main/scala/org/apache/spark/sql/catalyst/analysis/TypeCoercion.scala) (union의 타입 맞추기)
- [sql/catalyst/.../expressions/arithmetic.scala](https://github.com/apache/spark/blob/v4.2.0/sql/catalyst/src/main/scala/org/apache/spark/sql/catalyst/expressions/arithmetic.scala) (`DivModLike`), [datetimeExpressions.scala](https://github.com/apache/spark/blob/v4.2.0/sql/catalyst/src/main/scala/org/apache/spark/sql/catalyst/expressions/datetimeExpressions.scala) (`UnixTimestamp`의 `failOnError`)
- [sql/core/.../joins/HashJoin.scala](https://github.com/apache/spark/blob/v4.2.0/sql/core/src/main/scala/org/apache/spark/sql/execution/joins/HashJoin.scala) (`semiJoin`), [sql/core/.../datasources/DataSource.scala](https://github.com/apache/spark/blob/v4.2.0/sql/core/src/main/scala/org/apache/spark/sql/execution/datasources/DataSource.scala) (`resolveRelation`의 `asNullable`), [sql/core/.../python/EvaluatePython.scala](https://github.com/apache/spark/blob/v4.2.0/sql/core/src/main/scala/org/apache/spark/sql/execution/python/EvaluatePython.scala) (`makeFromJava`)
- [python/pyspark/sql/functions/builtin.py](https://github.com/apache/spark/blob/v4.2.0/python/pyspark/sql/functions/builtin.py) (`countDistinct`)

---
title: '[Spark Ch-05] Structured Streaming: 출력 모드는 쿼리 모양이 정하고 상태 크기는 워터마크가 정한다'
description: Databricks Spark 자격증 5영역(Structured Streaming, 10%)을 시험 안내서 항목 순서대로 정리합니다. 무한 입력 테이블 모델과 마이크로배치, 체크포인트와 재실행 가능한 소스로 만드는 exactly-once, 출력 모드와 싱크별 보장, 트리거, 이벤트 시간 윈도와 워터마크, 워터마크가 있을 때와 없을 때의 중복 제거를 Spark 4.2.0 공식 문서 기준으로 확인합니다.
date: 2026-10-19T00:00:00.000Z
tags:
  - Spark
  - Databricks
  - PySpark
  - Certification
  - Structured Streaming
  - Watermark
category: cert/Spark
topics:
  - cert
draft: false
series: "Spark 공부"
seriesOrder: 5
---

## 결론부터

1. Structured Streaming은 스트림을 계속 행이 덧붙는 입력 테이블로 보고 배치와 같은 DataFrame 쿼리를 증분으로 돌립니다. 기본 실행은 마이크로배치이고 문서 기준 종단 간 지연은 최저 100ms 수준입니다. Continuous 처리(실험적)는 약 1ms까지 내려가는 대신 at-least-once입니다.
2. exactly-once는 세 조건이 함께 맞아야 나옵니다. 오프셋으로 다시 읽을 수 있는 소스, 체크포인트와 WAL에 남긴 처리 범위, 같은 배치를 다시 써도 결과가 같은 멱등 싱크입니다. 파일 싱크는 exactly-once이고 Kafka 싱크와 foreach 싱크는 at-least-once, `foreachBatch`는 구현에 달렸습니다. socket 소스와 console, memory 싱크는 장애 내성이 없습니다.
3. 출력 모드 기본값은 Append입니다. 워터마크 없는 집계는 Complete와 Update만 되고 Append는 안 됩니다. 집계가 없는 쿼리는 Complete를 쓸 수 없습니다. 스트림 조인은 Append만 됩니다.
4. 워터마크는 지금까지 본 최대 이벤트 시간에서 허용 지연을 뺀 값입니다. 이보다 덜 늦은 데이터는 반드시 집계에 들어가고 더 늦은 데이터는 버려질 수 있습니다(반드시 버린다는 보장은 없습니다). Append 모드의 윈도 집계는 워터마크가 윈도 끝을 넘어야 결과를 한 번 냅니다.
5. `dropDuplicates`는 워터마크가 없으면 과거 키를 전부 상태로 들고 있습니다. 워터마크를 걸 때는 이벤트 시간 컬럼을 중복 판정 컬럼에 같이 넣어야 상태가 정리됩니다. 이벤트 시간이 중복마다 다르면 `dropDuplicatesWithinWatermark`(3.5.0부터)를 씁니다.

---

## 1. 시험 안내서 항목과 이 글의 순서

2025년 10월판 안내서의 5영역 항목은 넷입니다.

| 안내서 항목(원문 요약) | 이 글 |
|---|---|
| 엔진의 기능, 프로그래밍 모델, 마이크로배치, exactly-once, 장애 복구 | 2~3절 |
| Streaming DataFrame 만들고 쓰기, 기본 출력 모드와 출력 싱크 | 4~7절 |
| 선택, 투영, 윈도, 집계 | 8~10절 |
| 워터마크를 쓸 때와 안 쓸 때의 스트리밍 중복 제거 | 11절 |

3영역 항목 하나("stateful operators, including StateStores"를 쓰거나 쓰지 않는 UDF)도 상태와 관련이 있어서 12절에 같이 묶었습니다. 안내서 샘플 문항 8번은 "최근 1시간 평균 세션 시간을 2분마다 갱신"하는 클릭 스트림에 Streaming DataFrame을 고르는 이유를 묻고 정답은 "전체를 다시 계산하지 않고 집계를 증분으로 갱신한다"입니다. 샘플 문항 9번은 상태가 필요 없는 검증 로직이면 상태 연산 없이 UDF만 쓰라는 문제입니다.

예제는 게시판 클릭 이벤트와 쇼핑몰 주문 이벤트로 통일합니다. 파일 소스는 로컬에서도 바로 재현할 수 있어서 대부분 JSON 디렉터리를 읽는 형태로 썼습니다.

```python
from pyspark.sql import SparkSession, functions as F
from pyspark.sql.types import StructType, StructField, StringType, TimestampType, LongType

spark = SparkSession.builder.master("local[4]").appName("ch05-streaming").getOrCreate()

click_schema = StructType([
    StructField("event_id", StringType()),
    StructField("user_id", StringType()),
    StructField("post_id", LongType()),
    StructField("event_time", TimestampType()),
])
```

## 2. 엔진과 프로그래밍 모델

### 2-1. 계속 늘어나는 입력 테이블

Programming Model 절의 핵심 문장은 "라이브 데이터 스트림을 계속 덧붙는 테이블로 다룬다"입니다.

| 개념 | 뜻 |
|---|---|
| 입력 테이블(Input Table) | 스트림에 도착하는 데이터 하나하나가 새 행으로 덧붙는 무한(unbounded) 테이블 |
| 결과 테이블(Result Table) | 입력 테이블에 쿼리를 적용한 결과. 트리거마다 갱신된다 |
| 출력(Output) | 결과 테이블에서 외부 저장소로 쓰는 부분. 출력 모드가 정한다(5절) |

Spark는 입력 테이블 전체를 메모리에 만들지 않습니다. 문서는 소스에서 최신 데이터를 읽어 결과를 증분 갱신하고 원본은 버리며 결과를 갱신하는 데 필요한 최소한의 중간 상태(예: 단어별 누적 개수)만 들고 있다고 설명합니다. 그 중간 상태가 12절의 상태 저장소에 들어갑니다.

배치와 스트리밍이 같은 엔진을 쓴다는 점이 시험에 자주 나옵니다. 스트리밍 쿼리도 Spark SQL 엔진과 같은 옵티마이저를 거치고 코드도 `read`가 `readStream`, `write`가 `writeStream`으로 바뀌는 정도입니다.

### 2-2. 마이크로배치와 Continuous 처리

| | 마이크로배치(기본) | Continuous 처리 |
|---|---|---|
| 동작 | 데이터를 작은 배치 Job의 연속으로 처리 | 오래 도는 Task가 계속 읽고 처리하고 쓴다 |
| 지연(문서 기준) | 최저 약 100ms | 최저 약 1ms |
| 보장 | exactly-once | at-least-once |
| 상태 | 실험적 표시 없음 | 2.3에서 도입, 실험적(Experimental) |
| 지원 연산 | 전부 | 투영과 선택 같은 map류만. 집계 함수, `current_timestamp()`, `current_date()` 불가 |
| 지원 소스·싱크 | 전부 | 소스는 Kafka, rate. 싱크는 Kafka, memory, console |

Continuous 모드는 소스 파티션 수만큼 Task를 계속 띄워 두므로 Kafka 토픽 파티션이 10개면 코어가 10개 이상 있어야 진행합니다. 실패한 Task를 자동으로 재시도하지 않아서 실패하면 쿼리가 멈추고 체크포인트에서 수동으로 다시 시작해야 합니다.

PySpark 4.2.0의 `DataStreamWriter.trigger`에는 `realTime` 인자가 있고 설명은 "real time mode 쿼리를 주어진 배치 기간으로 실행"입니다. 3.5.6 API 문서의 같은 함수에는 이 인자가 없습니다. 2차 자료에서는 4.1에서 들어온 Real-time Mode라고 하고 처음에는 상태 없는 쿼리만 지원한다고 적지만 Apache 4.2.0 문서에서 이 모드의 설명 페이지를 찾지 못했습니다. 시험 기준 버전이 이보다 이전일 가능성이 커서 이름만 적어 둡니다.

## 3. exactly-once와 장애 복구

### 3-1. 세 가지 조건

Fault Tolerance Semantics 절의 설명을 순서대로 옮기면 이렇습니다.

1. 모든 스트리밍 소스는 읽은 위치를 추적하는 오프셋(Kafka 오프셋, Kinesis 시퀀스 번호와 비슷한 것)이 있다고 가정합니다.
2. 엔진은 체크포인트와 WAL(write-ahead log)에 트리거마다 처리하는 오프셋 범위를 기록합니다.
3. 싱크는 재처리를 견디도록 멱등으로 설계됩니다.

문서의 결론 문장은 "재실행 가능한 소스와 멱등 싱크를 함께 쓰면 어떤 장애에서도 종단 간 exactly-once를 보장한다"입니다. 셋 중 하나라도 빠지면 보장이 약해집니다. socket 소스는 오프셋으로 다시 읽을 수 없고 Kafka 싱크는 같은 배치를 다시 쓰면 메시지가 중복될 수 있습니다.

| 소스 | 장애 내성 | 비고 |
|---|---|---|
| 파일 | 예 | text, CSV, JSON, ORC, Parquet. 파일은 디렉터리에 원자적으로 옮겨 넣어야 한다 |
| Kafka | 예 | 브로커 0.10.0 이상 |
| socket | 아니오 | 테스트용. 드라이버가 서버 소켓에 붙는다 |
| rate, rate-micro-batch | 예 | 테스트와 벤치마크용 |

### 3-2. 체크포인트 위치

```python
query = (clicks_agg.writeStream
         .outputMode("update")
         .format("console")
         .option("checkpointLocation", "/chk/click_counts")
         .start())
```

체크포인트 위치에는 트리거마다 처리한 오프셋 범위와 누적 집계 같은 상태가 저장됩니다. 문서는 HDFS 호환 파일 시스템 경로여야 한다고 적습니다. 같은 경로로 쿼리를 다시 시작하면 마지막에 끝난 위치부터 이어서 처리합니다. 세션 전체의 기본 경로는 `spark.sql.streaming.checkpointLocation`(기본 없음)으로 줄 수 있습니다.

`StreamingQuery.id`는 체크포인트를 따라 재시작해도 유지되는 식별자이고 `runId`는 시작할 때마다 새로 생깁니다. PySpark에서 `id`는 속성(property)입니다(PySpark API 문서는 `property StreamingQuery.id`). 프로그래밍 가이드의 Python 예제는 `query.id()`로 적혀 있어서 문서끼리 표기가 어긋납니다.

### 3-3. 재시작 사이에 바꿔도 되는 것

같은 체크포인트로 다시 시작할 때 쿼리를 바꾸면 복구가 깨질 수 있습니다. 문서의 "Recovery Semantics after Changes" 절을 줄였습니다.

| 변경 | 허용 여부 |
|---|---|
| 입력 소스의 수나 종류 | 허용 안 됨 |
| Kafka 구독 토픽 바꾸기 | 대체로 허용 안 됨(결과 예측 불가) |
| 소스의 속도 제한(`maxOffsetsPerTrigger` 등) 추가·삭제 | 허용 |
| 파일 싱크를 Kafka 싱크로 | 허용(Kafka는 새 데이터만 본다) |
| Kafka 싱크를 파일 싱크로 | 허용 안 됨 |
| 파일 싱크의 출력 디렉터리 | 허용 안 됨 |
| 필터 추가·삭제 | 허용 |
| 상태 연산(집계 키, 중복 제거 컬럼, 스트림 조인 조건과 유형)의 스키마 | 허용 안 됨 |

상태 연산 스키마를 바꾸면 체크포인트의 상태를 읽을 수 없습니다. `spark.sql.streaming.stateStore.stateSchemaCheck`(기본 true, 3.1.0)가 재시작할 때 이를 검사해서 맞지 않으면 쿼리를 실패시킵니다.

## 4. readStream과 writeStream

### 4-1. Streaming DataFrame 만들기

```python
clicks = (spark.readStream
          .schema(click_schema)               # 파일 소스는 스키마가 필요하다
          .option("maxFilesPerTrigger", 10)
          .json("/stream/clicks"))

clicks.isStreaming   # True
```

파일 소스는 기본으로 스키마를 직접 줘야 합니다. 문서는 장애 뒤에도 같은 스키마를 쓰게 하려는 제약이라고 설명하고 임시 용도라면 `spark.sql.streaming.schemaInference`를 true로 켜라고 적습니다.

파일 소스의 주요 옵션입니다.

| 옵션 | 기본값 | 뜻 |
|---|---|---|
| `maxFilesPerTrigger` | 제한 없음 | 트리거마다 볼 새 파일 수 상한 |
| `maxBytesPerTrigger` | 제한 없음 | 트리거마다 볼 새 파일 총 크기 상한. 위 옵션과 동시에 쓸 수 없다 |
| `latestFirst` | false | 최신 파일부터 처리 |
| `maxFileAge` | 1주 | 가장 최신 파일 기준으로 이보다 오래된 파일은 무시(첫 배치는 전부 유효) |
| `cleanSource` | off | 처리한 파일을 archive 또는 delete |

Kafka 소스는 `spark.readStream.format("kafka").option("kafka.bootstrap.servers", ...).option("subscribe", "orders").load()` 형태이고 `key`, `value`가 바이너리라 `CAST(value AS STRING)` 후 `from_json`으로 펼칩니다. Kafka 연동은 `spark-sql-kafka` 패키지를 따로 붙여야 해서 이번 글의 재현은 파일 소스로 했습니다.

### 4-2. 쿼리 시작하기

`writeStream`에서 정하는 것은 다섯입니다. 싱크(형식과 위치), 출력 모드, 쿼리 이름(선택), 트리거(선택), 체크포인트 위치입니다. `start()`를 불러야 실행되고 `StreamingQuery` 핸들이 돌아옵니다.

```python
q = (clicks.select("user_id", "post_id", "event_time")
     .writeStream
     .format("parquet")
     .option("path", "/out/clicks")
     .option("checkpointLocation", "/chk/clicks_raw")
     .queryName("clicks_raw")
     .start())

q.status          # 현재 상태
q.lastProgress    # 마지막 배치의 진행 정보(dict)
q.recentProgress  # 최근 진행 정보 목록
q.awaitTermination(timeout=60)
q.stop()

spark.streams.active   # 이 세션에서 도는 쿼리 목록
```

헷갈리는 지점입니다.

- 스트리밍 DataFrame에 `count()`, `show()`, `foreach()` 같은 즉시 실행 액션을 부르면 `AnalysisException`이 납니다. 개수는 `groupBy().count()`로 스트리밍 결과를 만들고 화면 출력은 console 싱크로 합니다.
- `limit`, `take`, `distinct`는 스트리밍에서 지원하지 않습니다. 정렬은 집계 뒤 Complete 모드에서만 됩니다.
- 스트리밍 DataFrame에도 `createOrReplaceTempView`를 걸고 SQL을 쓸 수 있고 결과는 또 하나의 스트리밍 DataFrame입니다.

## 5. 출력 모드

### 5-1. 세 가지 모드

| 모드 | 내보내는 행 | 비고 |
|---|---|---|
| Append(기본) | 지난 트리거 뒤 결과 테이블에 새로 추가된 행만 | 이미 나간 행이 바뀌지 않는 쿼리에만. 행마다 한 번만 나간다 |
| Complete | 결과 테이블 전체를 트리거마다 | 집계 쿼리에만 |
| Update | 지난 트리거 뒤 바뀐 행만(2.1.1부터) | 집계가 없으면 Append와 같다 |

```python
DataStreamWriter.outputMode(outputMode)   # "append" | "complete" | "update"
```

### 5-2. 쿼리 종류별로 되는 모드

| 쿼리 | 되는 모드 | 이유 |
|---|---|---|
| 이벤트 시간 컬럼에 워터마크를 건 집계 | Append, Update, Complete | Append는 워터마크가 윈도를 넘은 뒤 확정 행만 낸다. Complete는 상태를 버리지 않는다 |
| 그 밖의 집계(워터마크 없음) | Complete, Update | 집계 값이 계속 바뀔 수 있어서 Append 불가 |
| `mapGroupsWithState` | Update | 이 쿼리 안에서 집계 불가 |
| `flatMapGroupsWithState` | Append 또는 Update(연산 모드에 따라) | Append 연산 모드에서는 뒤에 집계 가능 |
| 조인 | Append | Update와 Complete는 아직 미지원 |
| 그 밖(선택, 필터, map 등) | Append, Update | 집계 안 된 데이터를 전부 결과 테이블에 들 수 없어서 Complete 불가 |

시험 보기에서 가장 자주 섞이는 조합은 이렇습니다.

```python
# 워터마크 없는 집계 + append  -> 시작할 때 AnalysisException
clicks.groupBy("post_id").count().writeStream.outputMode("append")

# 집계 없는 쿼리 + complete -> 시작할 때 AnalysisException
clicks.filter("post_id > 0").writeStream.outputMode("complete")
```

예외가 나는 시점은 문서로 확인하지 못했습니다. 쿼리를 분석하는 `start()` 단계로 알고 있고 실행해 보고 고치겠습니다.

## 6. 싱크와 보장

### 6-1. 내장 싱크

| 싱크 | 되는 모드 | 장애 내성 | 비고 |
|---|---|---|---|
| 파일(parquet, orc, json, csv 등) | Append | 예, exactly-once | 파티션 디렉터리로 쓸 수 있다. `path` 필수 |
| Kafka | Append, Update, Complete | 예, at-least-once | `topic` 옵션이나 `topic` 컬럼 |
| foreach | Append, Update, Complete | 예, at-least-once | 행마다 사용자 코드 |
| foreachBatch | Append, Update, Complete | 구현에 달림 | 마이크로배치마다 사용자 함수 |
| console | Append, Update, Complete | 아니오 | 디버깅용. `numRows` 기본 20, `truncate` 기본 true |
| memory | Append, Complete | 아니오(Complete 모드는 재시작 시 전체 테이블 재생성) | 디버깅용. 쿼리 이름이 테이블 이름 |

console 싱크는 문서 안에서 표기가 엇갈립니다. 본문 설명은 "Append와 Complete 지원"이고 싱크 표는 Append, Update, Complete입니다. 위 표는 싱크 표를 따랐습니다. console과 memory는 매 트리거 출력 전체를 드라이버 메모리로 모으므로 작은 데이터에만 씁니다.

```python
# memory 싱크로 결과를 SQL로 확인하기
agg = clicks.groupBy("post_id").count()
mq = (agg.writeStream
      .queryName("post_clicks")      # 이 이름이 메모리 테이블 이름
      .outputMode("complete")
      .format("memory")
      .start())
spark.sql("SELECT * FROM post_clicks ORDER BY count DESC").show()
```

### 6-2. foreachBatch

```python
DataStreamWriter.foreachBatch(func)   # func(batch_df, batch_id)
```

함수는 마이크로배치 출력 DataFrame과 배치 ID를 받습니다. 문서가 드는 쓰임새는 셋입니다. 스트리밍 싱크가 없는 저장소에 배치 writer를 쓰기, 여러 위치에 쓰기, 스트리밍에서 지원하지 않는 DataFrame 연산을 배치마다 적용하기입니다.

```python
def upsert_order_stats(batch_df, batch_id):
    batch_df.persist()
    batch_df.write.mode("append").parquet("/out/order_stats")
    (batch_df.filter("status = 'CANCELLED'")
             .write.mode("append").parquet("/out/cancelled"))
    batch_df.unpersist()

order_q = (order_stats.writeStream
           .foreachBatch(upsert_order_stats)
           .option("checkpointLocation", "/chk/order_stats")
           .start())
```

헷갈리는 지점입니다.

- `foreachBatch`의 기본 보장은 at-least-once입니다. 같은 `batch_id`의 출력은 결정적 연산이라면 항상 같으니 그 ID로 중복을 거르면 exactly-once를 만들 수 있다고 문서가 적습니다.
- 여러 번 쓰면 매번 다시 계산하므로 `persist()`와 `unpersist()`로 감쌉니다. 상태가 있는 쿼리면 상태를 여러 번 다시 읽어서 더 느려집니다.
- Continuous 모드에서는 쓸 수 없습니다. 그때는 `foreach`를 씁니다.
- Spark Connect에서는 함수가 바깥 변수에 접근하지 못한다고 API 문서가 적습니다. 함수가 서버 쪽에서 돌기 때문입니다.
- 4.1.0에서 `spark.sql.streaming.stateStore.commitValidation.enabled`(기본 true)가 생겼습니다. 상태가 있는 쿼리의 `foreachBatch` 안에서 `show()`나 `limit()`처럼 모든 파티션을 처리하지 않는 동작을 하면 이를 검출합니다.

### 6-3. foreach

`foreach`는 행마다 쓰는 로직을 `open(partition_id, epoch_id)`, `process(row)`, `close(error)`로 나눕니다. Python에서는 함수 하나만 넘길 수도 있지만 그러면 재처리 때 중복을 거를 수 없고 객체로 넘겨야 `open`에서 받은 `partition_id`와 `epoch_id`로 중복을 판단할 수 있습니다. Python에서 `process`만 필수입니다.

## 7. 트리거

```python
DataStreamWriter.trigger(*, processingTime=None, once=None,
                         continuous=None, availableNow=None, realTime=None)
```

인자는 하나만 줄 수 있습니다. `realTime`은 4.x에만 있습니다(2-2).

| 트리거 | 코드 | 동작 |
|---|---|---|
| 지정 안 함(기본) | 없음 | 마이크로배치. 이전 배치가 끝나면 바로 다음 배치. `processingTime='0 seconds'`와 같다 |
| 고정 간격 | `trigger(processingTime="2 minutes")` | 간격마다 배치 시작. 이전 배치가 간격 안에 끝나면 기다리고 넘기면 끝나자마자 시작. 새 데이터가 없으면 배치를 띄우지 않는다 |
| 한 번(deprecated) | `trigger(once=True)` | 쌓인 데이터를 배치 하나로 처리하고 멈춘다 |
| 지금 있는 것 전부 | `trigger(availableNow=True)` | 쌓인 데이터를 소스 옵션에 맞춘 여러 배치로 처리하고 멈춘다 |
| Continuous(실험적) | `trigger(continuous="1 second")` | 저지연 모드. 인자는 체크포인트 간격 |

`once`와 `availableNow`는 둘 다 처리하고 멈추지만 문서는 `availableNow`로 옮기라고 권합니다. 이유는 셋입니다. `maxFilesPerTrigger` 같은 옵션을 지켜 여러 배치로 나누니 한 번에 너무 큰 배치가 생기지 않습니다. 이전 실행에서 남은 미커밋 배치부터 처리해서 실행 시점의 데이터를 모두 끝냅니다. 배치마다 워터마크가 진행되고 마지막에 데이터 없는 배치까지 돌아 상태가 작게 유지됩니다. 소스 중 하나라도 `availableNow`를 지원하지 않으면 한 번 트리거로 대신 돈다는 주의도 있습니다.

정기적으로 클러스터를 띄워 쌓인 것만 처리하고 끄는 운영(비용 절감용)이 이 두 트리거의 쓰임새입니다. Continuous 체크포인트는 마이크로배치와 호환되는 형식이라 같은 쿼리를 트리거만 바꿔 다시 시작할 수 있지만 Continuous로 바꾸는 순간 보장은 at-least-once입니다.

## 8. 선택, 투영, 집계

배치 DataFrame 연산 대부분이 그대로 됩니다.

```python
# 선택과 투영: 상태가 필요 없다
valid = (clicks
         .filter(F.col("post_id").isNotNull())
         .select("user_id", "post_id", "event_time",
                 F.hour("event_time").alias("hour")))

# 집계: 상태가 필요하다
per_post = valid.groupBy("post_id").agg(F.count("*").alias("clicks"),
                                        F.approx_count_distinct("user_id").alias("users"))
```

선택과 투영만 있는 쿼리는 상태를 만들지 않습니다. 문서는 SQL로 쓴 스트리밍 쿼리에도 Spark가 상태 연산을 끼워 넣을 수 있으니 계획을 확인하라고 적습니다. 상태 연산이 들어가면 출력 모드, 워터마크, 상태 크기를 함께 고려해야 합니다.

스트림과 정적 DataFrame 조인도 됩니다. 문서는 이 조인이 상태를 쓰지 않는다고 적습니다. 정적 쪽은 매 배치에 다시 읽힙니다.

```python
posts = spark.read.parquet("/data/posts")   # post_id, board, title
clicks_with_board = valid.join(posts, "post_id")              # inner
clicks_left = valid.join(posts, "post_id", "left_outer")      # 스트림 쪽 left outer
```

정적 쪽을 매 배치에 다시 읽는다는 부분은 문서 문장으로 확인하지 못했고 동작에서 추론한 것입니다.

스트림과 스트림의 조인은 2.3부터 됩니다. 양쪽 과거 입력을 상태로 버퍼링하므로 상태를 줄이려면 양쪽에 워터마크를 걸고 시간 범위 조건(`leftTime BETWEEN rightTime AND rightTime + INTERVAL 1 HOUR` 같은 형태)이나 같은 윈도 조건을 넣어야 합니다.

## 9. 이벤트 시간 윈도

### 9-1. 세 가지 윈도

| 윈도 | 함수 | 특징 |
|---|---|---|
| 텀블링 | `window(col, "10 minutes")` | 고정 크기, 겹치지 않음. 행 하나는 윈도 하나에 |
| 슬라이딩 | `window(col, "10 minutes", "5 minutes")` | 고정 크기, 이동 간격이 크기보다 작으면 겹침. 행 하나가 여러 윈도에 |
| 세션 | `session_window(col, "5 minutes")` | 입력에 따라 길이가 변함. 간격 안에 다음 입력이 오면 늘어난다(3.2.0부터) |

```python
pyspark.sql.functions.window(timeColumn, windowDuration, slideDuration=None, startTime=None)
pyspark.sql.functions.session_window(timeColumn, gapDuration)
```

`window`의 규칙입니다. 시작은 포함, 끝은 제외라서 12:05는 `[12:05, 12:10)`에 들어가고 `[12:00, 12:05)`에는 안 들어갑니다. `slideDuration`을 안 주면 텀블링입니다. 월 단위 윈도는 지원하지 않고 "1 day"는 항상 86,400,000밀리초입니다. `startTime`은 1970-01-01 00:00:00 UTC 기준 오프셋이라 매시 15분에 시작하는 1시간 윈도라면 `startTime="15 minutes"`입니다. 결과 컬럼은 `window`라는 struct이고 안에 `start`, `end`가 있습니다.

```python
# 5분마다 갱신하는 최근 10분 게시글별 클릭 수
windowed = (clicks
            .withWatermark("event_time", "10 minutes")
            .groupBy(F.window("event_time", "10 minutes", "5 minutes"), "post_id")
            .count())

# 30분 동안 클릭이 없으면 끝나는 사용자 방문 세션
sessions = (clicks
            .withWatermark("event_time", "10 minutes")
            .groupBy(F.session_window("event_time", "30 minutes"), "user_id")
            .agg(F.count("*").alias("clicks_in_session")))
```

### 9-2. 세션 윈도의 제약

스트리밍 쿼리에서 세션 윈도를 쓸 때 문서가 적은 제약은 둘입니다.

- Update 출력 모드를 지원하지 않습니다.
- 그룹 키에 `session_window` 말고 컬럼이 하나 이상 더 있어야 합니다. 배치 쿼리는 `session_window`만으로 묶는 전역 윈도도 됩니다.

간격은 행마다 다르게 줄 수도 있습니다. `session_window("event_time", F.when(F.col("board") == "notice", "5 minutes").otherwise("30 minutes"))`처럼 식을 주면 되고 0이나 음수 간격인 행은 집계에서 빠집니다.

### 9-3. 윈도 위에 다시 윈도

5분 윈도 결과를 1시간 텀블링 윈도로 다시 묶으려면 윈도의 대표 시각이 필요합니다. `window_time(window_col)`이 그 타임스탬프를 만들고 `window()`에 윈도 컬럼을 그대로 넣어도 됩니다.

```python
five_min = clicks.groupBy(F.window("event_time", "5 minutes"), "post_id").count()
hourly = five_min.groupBy(F.window(F.window_time("window"), "1 hour"), "post_id").agg(F.sum("count"))
```

## 10. 워터마크와 늦은 데이터

### 10-1. 정의

```python
DataFrame.withWatermark(eventTime, delayThreshold)
```

API 문서의 정의는 "쿼리의 모든 파티션에서 본 MAX(eventTime)에서 사용자가 준 delayThreshold를 뺀 값"입니다. 파티션 사이에 이 값을 맞추는 비용 때문에 실제 워터마크는 실제 이벤트 시간보다 최소 delayThreshold만큼 뒤에 있다는 것만 보장하고 경우에 따라 그보다 더 늦은 레코드도 처리될 수 있다고 적습니다.

프로그래밍 가이드의 예를 게시판 클릭으로 옮기면 이렇습니다. 허용 지연이 10분이고 트리거 동안 본 최대 이벤트 시간이 12:14이면 다음 트리거의 워터마크는 12:04입니다. 12:09에 발생한 클릭이 늦게 도착해도 12:04보다 뒤라서 `[12:00, 12:10)`과 `[12:05, 12:15)` 윈도에 들어갑니다. 최대 이벤트 시간이 12:21까지 가서 워터마크가 12:11이 되면 `[12:00, 12:10)` 윈도의 상태를 지우고 그 뒤에 온 12:04 클릭은 너무 늦은 데이터로 버립니다.

보장은 한 방향입니다. 허용 지연 2시간이면 2시간보다 덜 늦은 데이터는 절대 버리지 않습니다. 2시간보다 더 늦은 데이터는 버려진다는 보장이 없고 집계될 수도 있습니다. 시험 보기에 "워터마크보다 늦은 데이터는 항상 버려진다"가 나오면 틀린 문장입니다.

### 10-2. 출력 모드에 따라 결과가 나오는 시점

| 모드 | 윈도 결과가 나가는 시점 | 상태 정리 |
|---|---|---|
| Update | 트리거마다 바뀐 윈도의 중간 값 | 워터마크가 윈도 끝을 넘으면 정리 |
| Append | 워터마크가 윈도 끝을 넘은 뒤 최종 값 한 번 | 같은 시점에 정리 |
| Complete | 트리거마다 전체 | 정리하지 않는다 |

Append는 정확하지만 허용 지연만큼 늦게 나옵니다. 위 예에서 `[12:00, 12:10)` 윈도의 최종 개수는 워터마크가 12:11로 올라간 뒤에야 나갑니다. 파일 싱크처럼 Append만 되는 싱크에 윈도 집계를 쓰려면 워터마크가 필요한 이유입니다.

### 10-3. 워터마크가 상태를 정리하는 조건

문서가 적은 조건 넷입니다.

1. 출력 모드가 Append나 Update여야 합니다. Complete는 모든 집계를 보존해야 해서 워터마크로 상태를 버릴 수 없습니다.
2. 집계에 이벤트 시간 컬럼이나 그 컬럼의 윈도가 있어야 합니다.
3. `withWatermark`는 집계에 쓰는 타임스탬프 컬럼과 같은 컬럼에 걸어야 합니다. `df.withWatermark("time", "1 min").groupBy("time2").count()`는 Append에서 잘못된 쿼리입니다.
4. `withWatermark`를 집계보다 먼저 불러야 합니다. `df.groupBy("time").count().withWatermark("time", "1 min")`는 Append에서 잘못된 쿼리입니다.

배치 DataFrame에 `withWatermark`를 걸면 아무 일도 하지 않습니다(no-op).

### 10-4. 입력이 여럿일 때

스트림 둘을 조인하거나 union하면 입력마다 워터마크를 따로 계산하고 전역 워터마크 하나를 고릅니다. 기본은 최솟값이라 가장 느린 스트림 속도로 움직입니다. 한 스트림이 멈춰도 데이터를 실수로 버리지 않기 위해서입니다. `spark.sql.streaming.multipleWatermarkPolicy`를 `max`(2.4부터)로 바꾸면 가장 빠른 스트림을 따르고 느린 스트림 데이터를 공격적으로 버립니다. 이 설정은 같은 체크포인트로 재시작할 때 바꿀 수 없습니다.

### 10-5. Flink와 비교

같은 개념을 Flink에서 정리한 글이 [DE Ch-15](/blog/data/streaming/de-15-flink-time-watermark)와 [DE Ch-16](/blog/data/streaming/de-16-flink-window-join)입니다. 둘을 나란히 놓으면 차이가 보입니다.

| 항목 | Spark Structured Streaming | Flink(DE Ch-15, 16 기준) |
|---|---|---|
| 워터마크 정의 | 최대 이벤트 시간 − 허용 지연. 트리거 시작마다 갱신 | `forBoundedOutOfOrderness(d)` 등 전략으로 생성, `pipeline.auto-watermark-interval`(기본 200ms)마다 내보냄 |
| 여러 입력 | 기본 최솟값, `multipleWatermarkPolicy=max` 선택 | 입력 중 최솟값. 멈춘 입력은 `withIdleness`로 계산에서 뺀다 |
| 결과 시점 | 출력 모드가 정한다(Append는 확정 뒤 한 번) | trigger가 정한다 |
| 윈도 종류 | 텀블링, 슬라이딩, 세션 | 텀블링, 슬라이딩, 세션, 글로벌 |
| 처리 단위 | 마이크로배치(기본) | 레코드 단위 |

Spark에는 Flink의 `withIdleness`에 해당하는 설정을 이번에 연 문서에서 찾지 못했습니다. 그래서 조용한 입력 하나가 전역 워터마크를 붙잡는 문제는 Spark에서도 최솟값 정책일 때 생길 수 있다고 추론하고 실험으로 확인할 목록에 넣었습니다.

## 11. 스트리밍 중복 제거

### 11-1. 고유 ID만으로 제거

```python
dedup_all = clicks.dropDuplicates(["event_id"])
```

중복이 언제 올지 상한이 없으니 지금까지 본 모든 `event_id`를 상태로 보관합니다. 상태가 끝없이 커집니다. API 문서도 스트리밍에서는 트리거를 넘어 모든 데이터를 중간 상태로 유지한다고 적습니다.

### 11-2. 워터마크와 이벤트 시간으로 제거

```python
dedup_bounded = (clicks
                 .withWatermark("event_time", "10 minutes")
                 .dropDuplicates(["event_id", "event_time"]))
```

중복이 최대 얼마나 늦게 올지 알면 이벤트 시간에 워터마크를 걸고 고유 ID와 이벤트 시간 컬럼을 함께 중복 판정 컬럼으로 씁니다. 엔진은 워터마크보다 오래된 상태를 지웁니다. `dropDuplicates` 문서는 워터마크보다 오래된 데이터는 중복 가능성을 없애기 위해 버린다고 적습니다.

여기서 시험에 나올 만한 함정이 있습니다. 판정 컬럼에 이벤트 시간을 넣지 않고 `withWatermark(...).dropDuplicates(["event_id"])`라고 쓰면 워터마크는 걸렸지만 상태를 이벤트 시간으로 정리할 근거가 없습니다. 문서 예제는 두 컬럼을 같이 쓰는 형태만 보여 주고 이 경우 상태가 정리되지 않는다는 문장은 없어서 추론으로 적습니다.

### 11-3. dropDuplicatesWithinWatermark

```python
DataFrame.dropDuplicatesWithinWatermark(subset=None)   # 3.5.0부터, 스트리밍 전용
```

```python
dedup_within = (clicks
                .withWatermark("event_time", "1 hour")
                .dropDuplicatesWithinWatermark(["event_id"]))
```

같은 이벤트가 다른 이벤트 시간으로 중복되는 경우(예: 재전송할 때마다 발생 시각을 새로 찍는 클라이언트)를 위한 API입니다. 이벤트 시간을 판정 컬럼에 넣을 수 없으니 ID만으로 판정하고 상태는 워터마크로 정리합니다. 문서가 보장하는 의미는 "가장 이른 이벤트와 가장 늦은 이벤트의 시간 차가 워터마크 지연보다 작으면 중복이 제거된다"입니다. 그래서 지연을 중복 이벤트 사이 최대 시간 차보다 길게 잡으라고 권합니다. 워터마크가 없으면 쓸 수 없고 워터마크보다 늦은 데이터는 버립니다.

| | `dropDuplicates(id)` | `withWatermark` + `dropDuplicates(id, time)` | `withWatermark` + `dropDuplicatesWithinWatermark(id)` |
|---|---|---|---|
| 워터마크 | 없음 | 필요 | 필수 |
| 상태 | 무한히 커진다 | 워터마크로 정리 | 워터마크로 정리 |
| 판정 컬럼 | ID | ID와 이벤트 시간 | ID |
| 중복의 이벤트 시간이 다를 때 | 제거됨 | 다른 행으로 본다 | 지연 범위 안이면 제거 |
| 버전 | 1.4.0 | 2.1.0(워터마크) | 3.5.0 |

배치 DataFrame에서 `dropDuplicates`는 그냥 중복 행을 지웁니다. `dropDuplicatesWithinWatermark`는 스트리밍 DataFrame에서만 동작합니다.

## 12. 상태 저장 연산과 StateStore

### 12-1. 무엇이 상태를 만드는지

스트리밍 집계, 스트리밍 중복 제거, 스트림 간 조인, `mapGroupsWithState`와 `flatMapGroupsWithState`가 상태를 씁니다. 문서는 4.0부터 복잡한 상태 처리에 `transformWithState` 연산자를 쓰라고 권하고 앞의 두 연산은 legacy로 부릅니다. 선택, 필터, 상태 없는 UDF는 상태를 만들지 않습니다(안내서 샘플 문항 9번의 정답 방향).

체인 제한도 있습니다. 상태 연산 여러 개를 이어 붙이는 것은 Update와 Complete 모드에서 지원하지 않습니다. 문서가 제시하는 우회는 상태 연산 하나씩 들어간 쿼리 여러 개로 나누는 것입니다.

### 12-2. 상태 저장소 구현

| 구현 | 기본 여부 | 특징 |
|---|---|---|
| HDFS 기반(HDFSBackedStateStore) | 기본 | 처음에는 메모리 맵에 두고 HDFS 호환 파일 시스템 파일로 백업. 업데이트 묶음마다 버전이 올라간다 |
| RocksDB(3.2부터) | 선택 | 상태를 JVM 힙 대신 네이티브 메모리와 로컬 디스크에 둔다. 체크포인트 위치에 변경을 저장해 장애 내성은 같다 |

문서가 RocksDB를 권하는 상황은 상태 키가 수백만 개라서 HDFS 기반 저장소가 힙에 상태 객체를 많이 들고 있고 GC 멈춤 때문에 마이크로배치 처리 시간이 크게 흔들릴 때입니다. 켜는 방법입니다.

```python
spark.conf.set(
    "spark.sql.streaming.stateStore.providerClass",
    "org.apache.spark.sql.execution.streaming.state.RocksDBStateStoreProvider",
)
```

상태 크기는 Spark UI의 Structured Streaming 탭에서 봅니다. 문서 기준 지표에 집계된 총 상태 행 수, 갱신된 상태 행 수, 상태 메모리 사용량, 워터마크로 버린 상태 행 수, 전역 워터마크 간격(배치 시각과 전역 워터마크의 차이)이 있습니다. 워터마크를 걸었는데 총 상태 행 수가 계속 늘면 10-3의 조건을 다시 봅니다.

### 12-3. 헷갈리는 지점

- "Structured Streaming은 상태를 메모리에만 둔다"는 틀립니다. 상태는 체크포인트 위치에 버전별로 저장되고 재시작 때 복구됩니다.
- RocksDB 저장소를 켜도 exactly-once 보장 방식(체크포인트와 재실행)은 같습니다. 바뀌는 것은 상태가 놓이는 메모리 위치입니다.

## 13. 확인 문제

시험 안내서 항목을 보고 직접 만든 문제입니다. 덤프나 문제 은행에서 가져온 것은 없습니다.

**문제 1.** 다음 쿼리를 Append 모드로 시작하면 어떻게 됩니까?

```python
clicks.groupBy("post_id").count().writeStream.outputMode("append").format("console").start()
```

<details>
<summary>정답과 근거</summary>

실패합니다(AnalysisException). 워터마크 없는 집계는 집계 값이 계속 바뀔 수 있어서 Complete와 Update만 지원합니다. 이벤트 시간 윈도에 워터마크를 걸면 Append가 됩니다.

</details>

**문제 2.** 종단 간 exactly-once를 만드는 조합으로 맞는 것은 무엇입니까?

- A. socket 소스 + 파일 싱크 + 체크포인트
- B. Kafka 소스 + 파일 싱크 + 체크포인트
- C. Kafka 소스 + console 싱크 + 체크포인트
- D. Kafka 소스 + Kafka 싱크, 체크포인트 없음

<details>
<summary>정답과 근거</summary>

B입니다. Kafka 소스는 오프셋으로 다시 읽을 수 있고 파일 싱크는 exactly-once이며 체크포인트가 처리 범위를 기록합니다. A의 socket은 재실행할 수 없고 C의 console은 장애 내성이 없습니다. D는 체크포인트가 없고 Kafka 싱크 자체도 at-least-once입니다.

</details>

**문제 3.** 허용 지연 10분인 워터마크에서 지금까지 본 최대 이벤트 시간이 09:30입니다. 이벤트 시간 09:25인 클릭과 09:15인 클릭이 도착했습니다. 각각 어떻게 됩니까?

<details>
<summary>정답과 근거</summary>

워터마크는 09:20입니다. 09:25 클릭은 워터마크보다 뒤라서 반드시 집계됩니다. 09:15 클릭은 워터마크보다 늦은데 해당 윈도의 상태가 이미 지워졌다면 버려집니다. 다만 늦은 데이터를 반드시 버린다는 보장은 없어서 상태가 남아 있으면 집계될 수도 있습니다.

</details>

**문제 4.** 매일 새벽 한 번 클러스터를 띄워 쌓인 주문 파일을 모두 처리하고 멈추려고 합니다. 파일이 수천 개 쌓였고 `maxFilesPerTrigger=100`을 지키고 싶습니다. 어느 트리거가 맞습니까?

<details>
<summary>정답과 근거</summary>

`trigger(availableNow=True)`입니다. 쌓인 데이터를 소스 옵션에 맞춰 여러 배치로 나눠 처리하고 멈춥니다. `trigger(once=True)`는 배치 하나로 처리하려 하고 deprecated입니다.

</details>

**문제 5.** 같은 클릭이 재전송될 때마다 클라이언트가 `event_time`을 새로 찍습니다. 1시간 안의 재전송을 `event_id` 기준으로 걸러 내고 상태도 제한하려면 어떻게 씁니까?

<details>
<summary>정답과 근거</summary>

`clicks.withWatermark("event_time", "1 hour").dropDuplicatesWithinWatermark(["event_id"])`입니다. 중복 사이의 이벤트 시간이 달라서 `dropDuplicates(["event_id", "event_time"])`로는 다른 행으로 판정됩니다. 지연은 중복 사이 최대 시간 차보다 길게 잡습니다.

</details>

**문제 6.** 세션 윈도 집계를 Update 모드 스트리밍 쿼리로 쓸 수 있습니까?

<details>
<summary>정답과 근거</summary>

쓸 수 없습니다. 스트리밍 쿼리의 세션 윈도는 Update 출력 모드를 지원하지 않습니다. 또 그룹 키에 `session_window` 말고 컬럼이 하나 이상 더 있어야 합니다.

</details>

**문제 7.** `foreachBatch`로 외부 저장소에 쓸 때 exactly-once에 가깝게 만드는 방법은 무엇입니까?

<details>
<summary>정답과 근거</summary>

함수가 받는 `batch_id`를 쓰는 것입니다. 결정적 쿼리라면 같은 `batch_id`의 출력이 항상 같으므로 이미 쓴 `batch_id`를 기록해 두고 다시 오면 건너뛰거나 트랜잭션으로 덮어씁니다. 기본 보장은 at-least-once입니다.

</details>

**문제 8.** 워터마크를 걸었는데 상태가 계속 커집니다. 쿼리는 `clicks.groupBy("post_id").count().withWatermark("event_time", "10 minutes")`이고 Update 모드입니다. 무엇이 문제입니까?

<details>
<summary>정답과 근거</summary>

두 가지입니다. `withWatermark`를 집계 뒤에 불렀고 집계 키에 이벤트 시간 컬럼이나 그 윈도가 없습니다. 워터마크로 상태를 정리하려면 집계 전에 같은 이벤트 시간 컬럼에 워터마크를 걸고 `window("event_time", ...)`를 그룹 키에 넣어야 합니다.

</details>

## 14. 범위와 한계

- 동작과 기본값은 2026년 10월 19일에 연 Spark 4.2.0 Structured Streaming Programming Guide와 PySpark 4.2.0 API 문서를 기준으로 했습니다. `trigger`의 `realTime` 인자처럼 3.5.6 API 문서와 다른 부분은 본문에 표시했습니다.
- 이 글의 코드는 아직 실행하지 않았습니다. 이 노트북에 Java가 없어서 PySpark를 띄우지 못했습니다. 예외가 나는 시점(5-2), 스트림과 정적 조인에서 정적 쪽을 다시 읽는 동작(8절), 이벤트 시간을 판정 컬럼에서 뺀 중복 제거의 상태 정리(11-2), Spark에서 조용한 입력이 워터마크를 붙잡는지(10-5)는 문서 문장으로 확인하지 못한 추론입니다.
- Real-time Mode(4.1 이후)는 2차 자료로만 확인했습니다. Kafka 연동 옵션, 스트림 간 outer 조인 지원 표, `transformWithState`의 API는 범위가 커서 다루지 않았습니다.
- 출력 모드와 싱크 표는 문서 표를 옮긴 것이고 console 싱크의 지원 모드는 문서 안에서 서술이 엇갈립니다.

## 참고 자료

공식 자료
- Databricks, [Exam Guide, Oct 2025](https://www.databricks.com/sites/default/files/2025-10/databricks-certified-associate-developer-apache-spark-exam-guide-oct-2025.pdf) (5영역 항목과 샘플 문항 8, 9)
- Apache Spark 4.2.0, [Structured Streaming Programming Guide: Overview](https://spark.apache.org/docs/latest/streaming/index.html)
- Apache Spark 4.2.0, [Getting Started](https://spark.apache.org/docs/latest/streaming/getting-started.html) (Programming Model, Fault Tolerance Semantics)
- Apache Spark 4.2.0, [APIs on DataFrames and Datasets](https://spark.apache.org/docs/latest/streaming/apis-on-dataframes-and-datasets.html) (소스, 윈도, 워터마크, 중복 제거, State Store, 출력 모드, 싱크, 트리거, 복구)
- Apache Spark 4.2.0, [Performance Tips](https://spark.apache.org/docs/latest/streaming/performance-tips.html) (Continuous Processing)
- Apache Spark 4.2.0, [Web UI: Structured Streaming Tab](https://spark.apache.org/docs/latest/web-ui.html)
- Apache Spark 4.2.0, [Spark Configuration](https://spark.apache.org/docs/latest/configuration.html) (`spark.sql.streaming.*`)
- PySpark 4.2.0 API: [DataStreamWriter.trigger](https://spark.apache.org/docs/latest/api/python/reference/pyspark.ss/api/pyspark.sql.streaming.DataStreamWriter.trigger.html), [DataStreamWriter.outputMode](https://spark.apache.org/docs/latest/api/python/reference/pyspark.ss/api/pyspark.sql.streaming.DataStreamWriter.outputMode.html), [DataStreamWriter.foreachBatch](https://spark.apache.org/docs/latest/api/python/reference/pyspark.ss/api/pyspark.sql.streaming.DataStreamWriter.foreachBatch.html), [DataFrame.withWatermark](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.withWatermark.html), [DataFrame.dropDuplicates](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.dropDuplicates.html), [DataFrame.dropDuplicatesWithinWatermark](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.dropDuplicatesWithinWatermark.html), [functions.window](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.functions.window.html), [functions.session_window](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.functions.session_window.html), [StreamingQuery.id](https://spark.apache.org/docs/latest/api/python/reference/pyspark.ss/api/pyspark.sql.streaming.StreamingQuery.id.html)
- PySpark 3.5.6 API: [DataStreamWriter.trigger](https://spark.apache.org/docs/3.5.6/api/python/reference/pyspark.ss/api/pyspark.sql.streaming.DataStreamWriter.trigger.html) (`realTime` 인자 없음 확인용)

2차 자료(Real-time Mode 버전 확인용, 내용 검증 안 함)
- Apache Spark 소스 저장소, [docs/streaming/real-time-mode.md](https://apache.googlesource.com/spark/+/master/docs/streaming/real-time-mode.md) (master 브랜치 문서. 검색 결과로만 확인했고 직접 열지 않았습니다)
- Apache Spark 커밋, [SPARK-53737 Add Real-time Mode trigger](https://apache.googlesource.com/spark/+/848e47a5d766b22ac28cd9e926fce2fe4f11de05%5E%21) (검색 결과로만 확인)

이 시리즈와 비교 글
- [Spark Ch-00: 시험 구조와 공부 계획](/blog/cert/spark/spark-00-exam-and-study-plan), [Spark Ch-04: 문제 해결과 튜닝](/blog/cert/spark/spark-04-troubleshooting-tuning)
- [DE Ch-15: Flink의 시간과 watermark](/blog/data/streaming/de-15-flink-time-watermark), [DE Ch-16: 윈도와 interval join](/blog/data/streaming/de-16-flink-window-join)

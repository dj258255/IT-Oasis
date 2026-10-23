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

2026년 10월 8일판 안내서의 5영역 항목은 넷이고 2025년 10월판과 같습니다.

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

<details>
<summary>기초부터: 배치와 스트리밍, 끝이 있는 입력과 끝이 없는 입력</summary>

> **핵심 한 줄**: 배치는 끝이 있는 입력을 한 번 처리하고 끝납니다. 스트리밍은 끝이 없는 입력을 계속 지켜보다가 새로 온 만큼만 처리해 결과를 갱신합니다.

#### 1. 왜 필요한가

게시판 클릭 수를 몇 분마다 갱신해 보고 싶다고 합시다. 배치로 하면 주기마다 Job을 띄워 쌓인 파일을 다시 읽습니다. 이때 어디까지 읽었는지 직접 기록해야 하고 같은 파일을 두 번 읽거나 Job이 중간에 죽는 경우도 코드로 직접 막아야 합니다. Structured Streaming은 이 기록과 재시작을 엔진이 맡게 하려고 만든 모델입니다.

#### 2. 어떻게 동작하나

1. **입력을 무한 테이블로 보기**: 새 클릭 이벤트는 입력 테이블 끝에 붙는 새 행입니다.
2. **쿼리는 배치처럼 쓰기**: `groupBy("post_id").count()`처럼 배치와 같은 DataFrame 코드를 씁니다.
3. **엔진이 증분으로 바꾸기**: 엔진은 "테이블 전체에 대한 쿼리"를 "새 행만 읽어 이전 결과에 더하기"로 바꿔 실행합니다. 이전 결과를 들고 있는 것이 상태(12절)입니다.
4. **트리거마다 반복**: 정해진 때마다 새 행을 읽고 결과 테이블을 갱신하고 출력 모드(5절)가 정한 행을 싱크에 씁니다.

```text
a~e는 게시글 p1, p2에 대한 클릭 (a, b, c는 p1 / d, e는 p2)

시간 →        트리거 1        트리거 2            트리거 3
입력 테이블    [a, b]         [a, b | c, d]       [a, b, c, d | e]
처리 대상      a, b           c, d만              e만
상태           {p1: 2}        {p1: 3, p2: 1}      {p1: 3, p2: 2}
```

#### 3. 한눈에 비교

| 구분 | 배치 | Structured Streaming |
|---|---|---|
| 입력 | 끝이 있다(파일 묶음, 테이블 스냅숏) | 끝이 없다(Kafka 토픽, 파일이 계속 들어오는 디렉터리) |
| 실행 | 액션 한 번에 Job을 돌리고 끝 | `start()` 뒤 멈출 때까지 계속 |
| 읽은 위치 기록 | 사용자가 직접 | 엔진이 체크포인트에(3절) |
| 이전 결과 | 매번 처음부터 계산 | 상태로 들고 있다가 이어서 계산 |
| 코드 | `read`, `write` | `readStream`, `writeStream` |

#### 4. 헷갈리는 점

- 입력 테이블 전체를 메모리에 두지 않습니다. 처리한 원본은 버리고 결과에 필요한 중간 상태만 남깁니다(2-1).
- 기본 실행은 레코드 하나씩 처리하는 방식이 아닙니다. 작은 배치를 이어 돌리는 마이크로배치입니다(2-2).

> **정리**: 스트리밍 쿼리는 같은 DataFrame 코드를 엔진이 증분으로 반복 실행하는 것입니다. 무엇을 기억할지(상태)와 어디까지 읽었는지(체크포인트)를 엔진이 관리하는 점이 배치와 갈리는 지점입니다.

</details>

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

<details>
<summary>기초부터: 마이크로배치 한 바퀴</summary>

> **핵심 한 줄**: 마이크로배치는 트리거마다 이번에 읽을 오프셋 범위를 먼저 적어 두고 그 범위만 작은 배치 Job으로 처리한 뒤 끝났다고 적는 일을 반복합니다.

#### 1. 왜 필요한가

새 데이터를 조금씩 모아 배치 Job으로 돌리면 배치 엔진의 옵티마이저와 장애 복구 방식을 그대로 쓸 수 있습니다. 배치마다 처리 범위가 기록으로 남으니 장애가 나도 그 범위를 다시 돌리면 됩니다. 대가는 배치 하나를 모으고 돌리는 만큼의 지연이고 문서 기준으로 최저 약 100ms입니다.

#### 2. 어떻게 동작하나 (4.2.0 소스 `MicroBatchExecution` 기준)

1. **트리거 대기**: 트리거 조건이 되면 새 배치를 시작합니다. 기본은 앞 배치가 끝나자마자입니다(7절).
2. **오프셋 정하기**: 소스마다 지금 어디까지 데이터가 있는지 묻고 이번 배치의 끝 오프셋을 정합니다. `maxFilesPerTrigger` 같은 옵션이 한 번에 읽을 양을 줄입니다.
3. **오프셋 로그 기록**: 체크포인트의 `offsets/`에 배치 ID와 범위를 먼저 씁니다.
4. **배치 Job 실행**: 그 범위의 데이터만 DataFrame으로 만들어 쿼리를 실행합니다. 상태 연산이 있으면 상태 저장소를 읽고 갱신합니다.
5. **싱크 쓰기**: 결과를 출력 모드에 맞춰 싱크에 씁니다.
6. **커밋 로그 기록**: `commits/`에 그 배치 ID를 씁니다. 다음 배치에 쓸 워터마크 값도 이 기록에 함께 들어갑니다.

```text
batch 7   offsets/7 기록 → Job 실행(오프셋 120~180) → 싱크 쓰기 → commits/7 기록
batch 8   offsets/8 기록 → Job 실행(오프셋 180~230) → 싱크 쓰기 → commits/8 기록
batch 9   ...
```

#### 3. 실전에서 보이는 모습

- Spark UI Jobs 탭에 배치마다 Job이 새로 생깁니다. 스트리밍 쿼리 하나가 Job 수백 개로 보이는 이유입니다.
- `q.lastProgress`에는 배치 하나의 기록(`batchId`, `numInputRows`, `durationMs` 등)이 들어 있습니다.
- 배치 처리 시간이 트리거 간격보다 길면 다음 배치는 앞 배치가 끝나자마자 시작합니다. 지연이 계속 쌓이면 배치당 입력을 줄이거나 자원을 늘려야 합니다.

> **정리**: 적고 돌리고 다시 적는 이 순서가 다음 3절 exactly-once의 바탕입니다. 아래 표는 이 방식과 Continuous 처리의 차이입니다.

</details>

| | 마이크로배치(기본) | Continuous 처리 |
|---|---|---|
| 동작 | 데이터를 작은 배치 Job의 연속으로 처리 | 오래 도는 Task가 계속 읽고 처리하고 쓴다 |
| 지연(문서 기준) | 최저 약 100ms | 최저 약 1ms |
| 보장 | exactly-once | at-least-once |
| 상태 | 실험적 표시 없음 | 2.3에서 도입, 실험적(Experimental) |
| 지원 연산 | 전부 | 투영과 선택 같은 map류만. 집계 함수, `current_timestamp()`, `current_date()` 불가 |
| 지원 소스·싱크 | 전부 | 소스는 Kafka, rate. 싱크는 Kafka, memory, console |

Continuous 모드는 소스 파티션 수만큼 Task를 계속 띄워 두므로 Kafka 토픽 파티션이 10개면 코어가 10개 이상 있어야 진행합니다. 실패한 Task를 자동으로 재시도하지 않아서 실패하면 쿼리가 멈추고 체크포인트에서 수동으로 다시 시작해야 합니다.

PySpark 4.2.0의 `DataStreamWriter.trigger`에는 `realTime` 인자가 있고 설명은 "real time mode 쿼리를 주어진 배치 기간으로 실행"입니다. 같은 함수의 PySpark 3.5.6, 4.0.0, 4.1.0, 4.1.3 API 문서에는 이 인자가 없습니다. 엔진 쪽은 더 먼저 들어왔습니다. Java API `Trigger.RealTime`은 4.1.0 소스에 이미 있고 4.2.0 설정 문서의 `spark.sql.streaming.realTimeMode.minBatchDuration`(기본 5000ms)과 `spark.sql.streaming.realTimeMode.allowlistCheck`(기본 true)도 도입 버전이 4.1.0입니다. 4.2.0 문서에는 이 모드를 설명하는 페이지가 없고 apache/spark 메인 브랜치에 아직 배포되지 않은 `docs/streaming/real-time-mode.md`만 있습니다. 이 문서는 Real-time Mode를 4.1.0에 도입한 실행 모드로 소개하고 상태 없는 쿼리(투영, 필터, union, 스트림과 정적 조인)를 지원하며 중복 제거와 집계 같은 상태 연산은 4.3.0부터 지원한다고 적습니다(2026년 10월 21일 현재 최신 릴리스는 4.2.0). 시험 기준 버전이 이보다 이전일 가능성이 커서 이름만 적어 둡니다.

## 3. exactly-once와 장애 복구

### 3-1. 세 가지 조건

<details>
<summary>기초부터: 장애 지점별로 보는 exactly-once</summary>

> **핵심 한 줄**: 장애는 막을 수 없으니 엔진은 어디까지 했는지 남겨 두고 실패한 배치를 같은 범위로 다시 돌립니다. 싱크가 같은 배치를 두 번 받아도 한 번 쓴 것과 같게 만들면 결과가 정확히 한 번 반영됩니다.

#### 1. 왜 필요한가

결제 이벤트를 집계해 파일로 쓰는 쿼리가 싱크에 쓰던 중 죽었다고 합시다. 다시 시작할 때 고를 수 있는 길은 셋입니다.

| 재시작 방식 | 결과 | 이름 |
|---|---|---|
| 마지막 위치 다음부터 읽기 | 죽은 배치의 데이터가 빠질 수 있다 | at-most-once |
| 죽은 배치를 다시 처리 | 일부가 이미 쓰였다면 두 번 반영될 수 있다 | at-least-once |
| 다시 처리하고 싱크가 중복을 걸러 냄 | 한 번만 반영된다 | exactly-once |

#### 2. 어떻게 동작하나 (장애 지점별)

1. **오프셋 기록 전에 죽음**: 배치가 시작되지 않은 것과 같습니다. 재시작하면 마지막 커밋 뒤부터 범위를 새로 정합니다.
2. **오프셋 기록 뒤 커밋 전에 죽음**: `offsets/N`은 있고 `commits/N`은 없습니다. 재시작하면 배치 N을 같은 오프셋 범위로 다시 실행합니다. 소스가 그 범위를 다시 줄 수 있어야 합니다(재실행 가능한 소스).
3. **싱크에 일부 쓰고 죽음**: 2번과 같이 배치 N을 다시 씁니다. 싱크가 배치 N을 이미 받았는지 알아보고 건너뛰거나 덮어써야 중복이 없습니다(멱등 싱크). 4.2.0 파일 싱크(`FileStreamSink`)는 이미 커밋한 배치 ID면 "Skipping already committed batch"를 남기고 건너뜁니다.
4. **커밋 뒤에 죽음**: 배치 N은 끝났습니다. 재시작하면 N+1부터 합니다.

```text
offsets/   0  1  2  3  4  5
commits/   0  1  2  3  4          ← 5가 없다: 배치 5를 같은 범위로 다시 실행
```

#### 3. 한눈에 비교

| 구성 | 맡는 일 | 빠지면 |
|---|---|---|
| 재실행 가능한 소스(파일, Kafka) | 같은 오프셋 범위를 다시 준다 | socket처럼 다시 못 주면 데이터가 빠진다 |
| 체크포인트(오프셋 로그, 커밋 로그, 상태) | 어디까지 했는지 기억한다 | 어디서 다시 시작할지 모른다 |
| 멱등 싱크(파일 싱크) | 같은 배치를 다시 받아도 결과가 같다 | Kafka 싱크처럼 메시지가 중복될 수 있다 |

#### 4. 헷갈리는 점

- exactly-once는 "배치가 한 번만 실행된다"는 뜻으로 읽으면 틀립니다. 배치는 여러 번 실행될 수 있고 결과가 한 번 반영된 것과 같다는 뜻입니다.
- 소스, 체크포인트, 싱크를 합친 종단 간 성질이라 셋 중 하나만 약해도 보장이 at-least-once로 내려갑니다.

> **정리**: 다시 돌릴 수 있는 입력, 어디까지 했는지의 기록, 두 번 받아도 같은 출력이 함께 있어야 exactly-once가 됩니다. 아래 표는 소스마다 다시 돌릴 수 있는지를 정리한 것입니다.

</details>

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

<details>
<summary>기초부터: 체크포인트 디렉터리 안에 남는 것</summary>

> **핵심 한 줄**: 체크포인트 위치는 쿼리 하나의 작업 일지입니다. 일지라는 비유처럼 디렉터리 안에 배치별 오프셋 기록, 커밋 기록, 상태 파일이 순서대로 쌓이고 재시작한 쿼리는 이것을 읽어 이어서 합니다.

#### 1. 왜 필요한가

드라이버가 죽으면 메모리에 있던 진행 상황과 집계 상태가 사라집니다. 다시 띄운 쿼리가 이어서 처리하려면 이 정보가 장애를 견디는 저장소에 있어야 합니다. 문서가 HDFS 호환 파일 시스템 경로를 요구하는 이유입니다.

#### 2. 어떻게 동작하나

4.2.0 소스 `StreamingCheckpointConstants`가 정하는 하위 이름은 `offsets`, `commits`, `state`, `metadata`입니다.

```text
/chk/click_counts/
├─ metadata    쿼리 id. 재시작해도 유지되는 StreamingQuery.id
├─ offsets/    배치 ID별 파일. 그 배치가 읽을 소스별 오프셋 범위
├─ commits/    배치 ID별 파일. 끝난 배치 표시와 다음 워터마크
└─ state/      상태 연산이 있을 때. 연산자와 파티션별 상태 파일
```

1. **처음 시작**: `metadata`가 없으면 새 쿼리로 보고 id를 만들어 씁니다. 있으면 그 id를 이어받습니다.
2. **복구 지점 찾기**: `offsets/`와 `commits/`의 마지막 번호를 비교해 다시 돌릴 배치를 정합니다(3-1).
3. **상태 불러오기**: 상태 연산이 있으면 `state/`에서 마지막으로 커밋된 버전을 읽습니다.
4. **오래된 기록 정리**: 엔진이 최근 배치 기록을 일정 개수만 남기고 지웁니다. 4.2.0 소스의 내부 설정 `spark.sql.streaming.minBatchesToRetain` 기본값이 100입니다.

#### 3. 헷갈리는 점

- 쿼리마다 다른 경로를 줍니다. 두 쿼리가 한 경로를 쓰면 같은 쿼리 id를 이어받아 기록이 섞입니다.
- 체크포인트를 지우고 시작하면 처음 보는 쿼리가 됩니다. 소스의 시작 위치 옵션(Kafka `startingOffsets` 등)부터 다시 읽습니다.
- 배치 DataFrame의 `checkpoint()`는 계보를 잘라 결과를 저장하는 다른 기능입니다([Ch-01](/blog/cert/spark/spark-01-architecture) 5-4).

> **정리**: 체크포인트는 "어디까지 읽었고 어디까지 썼고 무엇을 기억하는지"를 파일로 남긴 것입니다. 그래서 3-3처럼 재시작 사이에 쿼리 모양을 바꾸면 이 기록과 어긋날 수 있습니다.

</details>

```python
query = (clicks_agg.writeStream
         .outputMode("update")
         .format("console")
         .option("checkpointLocation", "/chk/click_counts")
         .start())
```

체크포인트 위치에는 트리거마다 처리한 오프셋 범위와 누적 집계 같은 상태가 저장됩니다. 문서는 HDFS 호환 파일 시스템 경로여야 한다고 적습니다. 같은 경로로 쿼리를 다시 시작하면 마지막에 끝난 위치부터 이어서 처리합니다. 세션 전체의 기본 경로는 `spark.sql.streaming.checkpointLocation`(기본 없음)으로 줄 수 있고 이때 실제 위치는 그 아래 쿼리 이름(없으면 무작위 UUID) 디렉터리입니다.

체크포인트 위치를 아무 데도 주지 않았을 때 동작은 싱크마다 다릅니다. 4.2.0 소스(`DataStreamWriter`, `ResolveWriteToStream`) 기준으로 memory, console, foreach, foreachBatch, noop 싱크는 임시 디렉터리를 만들어 쓰고 쿼리가 정상 종료되면 지웁니다. 파일, Kafka, 테이블 같은 나머지 싱크는 `start()`에서 체크포인트 위치를 지정하라는 오류가 납니다. 임시 체크포인트는 재시작하면 사라지니 디버깅용 싱크에서도 장애 복구는 기대할 수 없습니다.

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

처음 보면 "왜 바로 컬럼이 안 나오지?"에서 막힙니다. Kafka는 메시지 내용이 JSON인지 Avro인지 모르고 바이트만 저장합니다. 그래서 Spark가 돌려주는 DataFrame은 메시지 내용 대신 Kafka가 아는 정보로 고정된 스키마를 가집니다. Kafka 연동 가이드의 스키마는 `key`(binary), `value`(binary), `topic`(string), `partition`(int), `offset`(long), `timestamp`(timestamp), `timestampType`(int)이고 `includeHeaders`를 켜면 `headers`가 붙습니다. 주문 JSON을 컬럼으로 만들려면 두 단계를 거칩니다.

```python
order_schema = "order_id string, amount long, status string, event_time timestamp"

orders = (spark.readStream
          .format("kafka")
          .option("kafka.bootstrap.servers", "broker1:9092")
          .option("subscribe", "orders")
          .load()                                                  # key, value, topic, partition, offset, ...
          .select(F.col("value").cast("string").alias("json"))     # 1단계: 바이트를 문자열로
          .select(F.from_json("json", order_schema).alias("o"))    # 2단계: 문자열을 struct로
          .select("o.*"))                                          # struct를 컬럼으로 펼치기
```

| 줄 | 하는 일 |
|---|---|
| `load()` | Kafka 메시지 하나가 행 하나. 이때 주문 내용은 `value` 칸의 바이트 덩어리입니다 |
| `cast("string")` | 바이트를 UTF-8 문자열로 읽습니다. `{"order_id":"o-1","amount":12000,...}` 같은 글자가 됩니다 |
| `from_json(..., order_schema)` | 문자열을 스키마에 맞춰 struct 하나로 바꿉니다. 스키마와 안 맞는 메시지는 null이 됩니다 |
| `select("o.*")` | struct 안의 필드를 일반 컬럼으로 꺼냅니다 |

스트리밍 쿼리에서 `startingOffsets` 기본값은 `latest`라서 처음 띄운 쿼리는 그 뒤에 들어온 메시지부터 읽습니다(배치 쿼리는 `earliest`). 체크포인트가 있으면 이 옵션은 무시되고 체크포인트의 오프셋부터 이어 갑니다.

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

`lastProgress`는 쿼리가 잘 돌고 있는지 확인하는 첫 창구인데 출력이 긴 dict라서 어디를 봐야 할지 막막합니다. 공식 가이드의 출력 예(Kafka 소스, memory 싱크)에서 자주 보는 칸만 남기면 이렇습니다.

```text
{'id': 'ce011fdc-...', 'runId': '88e2ff94-...', 'name': 'MyQuery',
 'numInputRows': 10, 'inputRowsPerSecond': 120.0, 'processedRowsPerSecond': 200.0,
 'durationMs': {'getOffset': 2, 'triggerExecution': 3},
 'eventTime': {'watermark': '2016-12-14T18:45:24.873Z'},
 'stateOperators': [],
 'sources': [{'description': 'KafkaSource[Subscribe[topic-0]]',
              'startOffset': {'topic-0': {'0': 1, '1': 1, ...}},
              'endOffset':   {'topic-0': {'0': 534, '1': 134, ...}}, ...}],
 'sink': {'description': 'MemorySink'}}
```

| 칸 | 읽는 법 |
|---|---|
| `id`, `runId` | 체크포인트를 따라 유지되는 쿼리 id와 시작할 때마다 바뀌는 실행 id(3-2) |
| `numInputRows` | 이번 배치에 들어온 행 수 |
| `inputRowsPerSecond`, `processedRowsPerSecond` | 들어오는 속도와 처리하는 속도. 처리 속도가 계속 더 낮으면 밀리고 있다는 뜻입니다 |
| `durationMs.triggerExecution` | 배치 하나 전체에 걸린 시간 |
| `eventTime.watermark` | 지금 워터마크(10절). 워터마크를 걸지 않았으면 이 칸이 없습니다 |
| `stateOperators` | 상태 연산별 상태 행 수와 메모리(12절). 상태 연산이 없어서 빈 목록입니다 |
| `sources[].startOffset`, `endOffset` | 이번 배치가 읽은 범위. 파티션 `0`은 오프셋 1부터 534 전까지 읽었습니다 |

빠르게 진단할 때는 두 속도를 먼저 비교하고 상태 연산이 있으면 `stateOperators`의 행 수가 계속 늘기만 하는지 봅니다.

헷갈리는 지점입니다.

- 스트리밍 DataFrame에 `count()`, `show()`, `foreach()` 같은 즉시 실행 액션을 부르면 `AnalysisException`이 납니다. 개수는 `groupBy().count()`로 스트리밍 결과를 만들고 화면 출력은 console 싱크로 합니다.
- `limit`, `take`, `distinct`는 스트리밍에서 지원하지 않습니다. 정렬은 집계 뒤 Complete 모드에서만 됩니다. 중복 제거가 필요하면 `distinct` 자리에 11절의 `dropDuplicates`를 씁니다.
- `spark.sql.adaptive.enabled`가 켜져 있어도 스트리밍 쿼리에는 AQE를 적용하지 않습니다. 4.2.0 소스(`ResolveWriteToStream`)는 이 경우 "스트리밍에서 지원하지 않아 끈다"는 경고만 남깁니다. [Ch-04](/blog/cert/spark/spark-04-troubleshooting-tuning)의 AQE 설명은 배치 쿼리 기준입니다.
- 스트리밍 DataFrame에도 `createOrReplaceTempView`를 걸고 SQL을 쓸 수 있고 결과는 또 하나의 스트리밍 DataFrame입니다.

## 5. 출력 모드

### 5-1. 세 가지 모드

<details>
<summary>기초부터: 출력 모드는 결과 테이블의 어느 행을 내보낼지 정한다</summary>

> **핵심 한 줄**: 결과 테이블은 트리거마다 바뀝니다. 출력 모드는 그중 어느 행을 싱크로 내보낼지 고르는 규칙입니다.

#### 1. 왜 필요한가

게시글별 클릭 수를 세는 결과 테이블은 트리거마다 기존 행의 값이 바뀌고 새 행도 생깁니다. 싱크마다 받을 수 있는 것이 다릅니다. 파일 싱크는 이미 쓴 파일을 고칠 수 없어서 새 행 추가만 받습니다. 키로 덮어쓸 수 있는 저장소라면 바뀐 행만 받아 갱신하는 편이 쌉니다.

#### 2. 어떻게 동작하나

1. **결과 테이블 갱신**: 엔진이 새 행으로 상태를 갱신하고 결과 테이블을 계산합니다.
2. **모드로 고르기**: Complete는 전부, Update는 이번에 바뀐 행, Append는 앞으로 바뀌지 않을 새 행만 고릅니다.
3. **싱크 쓰기**: 고른 행만 싱크에 넘깁니다.

```text
결과 테이블 ──Complete: 전부───────────▶ 싱크
            ──Update: 이번에 바뀐 행────▶ 싱크
            ──Append: 확정된 새 행──────▶ 싱크
```

게시글별 클릭 수(워터마크 없음)로 트리거 세 번을 따라가면 이렇습니다.

| 트리거 | 새로 들어온 클릭 | 결과 테이블 | Complete 출력 | Update 출력 |
|---|---|---|---|---|
| 1 | p1, p1 | p1=2 | p1=2 | p1=2 |
| 2 | p1, p2 | p1=3, p2=1 | p1=3, p2=1 | p1=3, p2=1 |
| 3 | p2 | p1=3, p2=2 | p1=3, p2=2 | p2=2 |

이 쿼리는 Append를 쓸 수 없습니다. 트리거 1에서 p1=2를 내보낸 뒤 트리거 2에서 p1=3으로 바뀌는데 Append는 이미 내보낸 행을 고칠 방법이 없기 때문입니다.

#### 3. 헷갈리는 점

- 집계를 Append로 내보내려면 "이 행은 더 안 바뀐다"를 알려 줄 장치가 있어야 하고 그 장치가 워터마크입니다(10-2).
- 필터와 select만 있는 쿼리는 한 번 나간 행이 바뀌지 않으므로 Append가 자연스럽고 기본값도 Append입니다.
- Complete는 결과 테이블 전체를 매번 내보내야 하므로 상태를 지울 수 없습니다(10-3).

> **정리**: 출력 모드는 "결과 행이 나중에 바뀔 수 있는지"와 "싱크가 무엇을 받을 수 있는지"를 맞추는 선택입니다. 5-2의 쿼리별 허용 표가 이 원리에서 나옵니다.

</details>

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

`mapGroupsWithState`와 `flatMapGroupsWithState`는 Scala와 Java API입니다. PySpark에서 같은 자리에 쓰는 것은 `GroupedData.applyInPandasWithState`(3.4.0부터)와 `GroupedData.transformWithStateInPandas`(4.0.0부터)입니다. 문서의 호환 표는 Scala 이름으로 적혀 있으니 보기에서 Python 이름이 나오면 이 대응으로 읽습니다.

시험 보기에서 가장 자주 섞이는 조합은 이렇습니다.

```python
# 워터마크 없는 집계 + append  -> 시작할 때 AnalysisException
clicks.groupBy("post_id").count().writeStream.outputMode("append")

# 집계 없는 쿼리 + complete -> 시작할 때 AnalysisException
clicks.filter("post_id > 0").writeStream.outputMode("complete")
```

예외는 `start()`를 부를 때 납니다. `writeStream`과 `outputMode()`까지는 오류 없이 지나갑니다. 4.2.0 소스에서 `start()`가 `StreamingQueryManager.createQuery`로 쓰기 계획을 분석하고 그 분석 규칙(`ResolveWriteToStream`)이 `UnsupportedOperationChecker.checkForStreaming(쿼리, 출력 모드)`를 부르는 것을 확인했습니다. 반면 스트리밍 DataFrame에 `count()`나 `show()`를 부르면 그 줄에서 바로 예외가 납니다. 실행해서 확인한 결과는 아닙니다.

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

console 싱크는 문서 안에서 표기가 엇갈립니다. 본문 설명은 "Append와 Complete 지원"이고 싱크 표는 Append, Update, Complete입니다. 4.2.0 소스(`console.scala`)의 쓰기 빌더가 Complete용 `SupportsTruncate`와 Update용 `SupportsStreamingUpdateAsAppend`를 둘 다 구현하므로 싱크 표가 맞습니다. console과 memory는 매 트리거 출력 전체를 드라이버 메모리로 모으므로 작은 데이터에만 씁니다.

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

"`batch_id`로 중복을 거른다"는 말이 실제 코드로 어떻게 되는지 보겠습니다. 가장 단순한 방법은 배치마다 자기 전용 위치를 정해 두고 거기에 덮어쓰는 것입니다.

```python
def write_idempotent(batch_df, batch_id):
    (batch_df
     .write
     .mode("overwrite")                                   # 같은 위치에 다시 쓰면 덮어쓴다
     .parquet(f"/out/order_stats/batch_id={batch_id}"))   # 배치마다 전용 디렉터리
```

배치 7을 쓰다가 드라이버가 죽었다고 합시다. 재시작하면 엔진은 `commits/7`이 없으니 배치 7을 같은 오프셋 범위로 다시 돌리고(3-1) 함수는 같은 `batch_id=7`을 받습니다. 결정적 쿼리라면 출력도 같으니 `batch_id=7` 디렉터리를 같은 내용으로 덮어쓰고 끝납니다. 두 번 실행됐지만 결과는 한 벌입니다. DB에 쓸 때는 같은 생각을 "이미 처리한 `batch_id`를 기록하는 표"로 옮깁니다. 쓰기와 기록을 한 트랜잭션에 묶고 함수 첫 줄에서 그 표에 `batch_id`가 있으면 바로 돌아갑니다.

### 6-3. foreach

`foreach`는 행마다 쓰는 로직을 `open(partition_id, epoch_id)`, `process(row)`, `close(error)`로 나눕니다. Python에서는 `process`만 필수입니다.

```python
class OrderAlertWriter:
    def open(self, partition_id, epoch_id):
        self.conn = connect_alert_api()     # 연결은 여기서 연다(가정한 함수)
        return True                         # False면 이 파티션의 process를 건너뛴다
    def process(self, row):
        self.conn.send(row.order_id, row.amount)
    def close(self, error):
        self.conn.close()

orders.writeStream.foreach(OrderAlertWriter()).start()
```

| 메서드 | 불리는 때 |
|---|---|
| `open(partition_id, epoch_id)` | 배치(Continuous 모드에서는 epoch)마다, 파티션마다 한 번 |
| `process(row)` | `open`이 True를 돌려준 경우 그 파티션의 행마다 |
| `close(error)` | 파티션 처리가 끝나면. 처리 중 난 오류가 있으면 인자로 받는다 |

객체는 직렬화돼 Task마다 새 복사본으로 넘어갑니다. 그래서 연결처럼 직렬화할 수 없는 것은 생성자 대신 `open`에서 만들라고 문서가 권합니다.

`epoch_id`로 중복을 거를 수 있을 것 같지만 문서는 반대로 적습니다. 같은 `(partition_id, epoch_id)`에 같은 출력이 나온다는 보장이 없어서 이 쌍으로는 중복을 거를 수 없고 출력 중복 제거가 필요하면 `foreachBatch`를 쓰라고 합니다. 소스가 주는 파티션 수가 바뀌거나 최적화로 파티션 수가 달라지면 같은 번호의 파티션에 다른 행이 들어가기 때문입니다(SPARK-28650). 그래서 `foreach`의 보장은 at-least-once입니다.

## 7. 트리거

```python
DataStreamWriter.trigger(*, processingTime=None, once=None,
                         continuous=None, availableNow=None, realTime=None)
```

인자는 하나만 줄 수 있습니다. `realTime`은 PySpark 4.2.0부터 있습니다(2-2).

| 트리거 | 코드 | 동작 |
|---|---|---|
| 지정 안 함(기본) | 없음 | 마이크로배치. 이전 배치가 끝나면 바로 다음 배치. `processingTime='0 seconds'`와 같다 |
| 고정 간격 | `trigger(processingTime="2 minutes")` | 간격마다 배치 시작. 이전 배치가 간격 안에 끝나면 기다리고 넘기면 끝나자마자 시작. 새 데이터가 없으면 배치를 띄우지 않는다 |
| 한 번(deprecated) | `trigger(once=True)` | 쌓인 데이터를 배치 하나로 처리하고 멈춘다 |
| 지금 있는 것 전부 | `trigger(availableNow=True)` | 쌓인 데이터를 소스 옵션에 맞춘 여러 배치로 처리하고 멈춘다 |
| Continuous(실험적) | `trigger(continuous="1 second")` | 저지연 모드. 인자는 체크포인트 간격 |

고정 간격 트리거가 실제로 언제 배치를 띄우는지 `processingTime="2 minutes"`로 따라가 보겠습니다. 배치는 0분, 2분, 4분처럼 간격의 경계에 맞춰 시작하려고 합니다.

| 배치 | 시작 | 걸린 시간 | 끝 | 다음 배치 |
|---|---|---|---|---|
| 0 | 0:00 | 1분 | 1:00 | 2:00 경계까지 기다린다 |
| 1 | 2:00 | 3분 | 5:00 | 4:00 경계를 이미 넘겼으니 끝나자마자 5:00에 시작 |
| 2 | 5:00 | 1분 | 6:00 | 6:00 경계에 맞춰 바로 시작 |
| (6:00 확인) | 새 데이터 없음 | | | 배치를 띄우지 않고 8:00 경계에 다시 본다 |

배치 1처럼 한 번 밀리면 다음 배치는 경계를 기다리지 않고 바로 붙습니다. 배치 처리 시간이 계속 간격보다 길면 트리거 간격은 의미를 잃고 기본 트리거처럼 쉬지 않고 돕니다. 이때 볼 곳이 4-2의 `durationMs.triggerExecution`입니다.

Continuous 트리거의 인자 `"1 second"`는 배치 간격과 뜻이 다릅니다. Continuous 모드의 Task는 멈추지 않고 계속 처리하고 엔진은 이 간격마다 epoch라는 표시를 데이터 사이에 끼워 지금까지 진행한 위치를 체크포인트에 남깁니다. 1초는 진행 위치를 기록하는 주기이고 결과는 이 주기와 상관없이 처리되는 대로 나갑니다.

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

스트림과 정적 DataFrame 조인도 됩니다(2.0부터). 문서는 이 조인이 상태를 쓰지 않는다고 적습니다.

```python
posts = spark.read.parquet("/data/posts")   # post_id, board, title
clicks_with_board = valid.join(posts, "post_id")              # inner
clicks_left = valid.join(posts, "post_id", "left_outer")      # 스트림 쪽 left outer
```

스트림과 스트림의 조인은 2.3부터 됩니다. 양쪽 과거 입력을 상태로 버퍼링하므로 상태를 줄이려면 양쪽에 워터마크를 걸고 시간 범위 조건(`leftTime BETWEEN rightTime AND rightTime + INTERVAL 1 HOUR` 같은 형태)이나 같은 윈도 조건을 넣어야 합니다.

조인 유형마다 되는 조합은 문서의 지원 표에 있습니다. 왼쪽이 스트림이면 오른쪽(정적)을 보존하는 조인이 막힌다고 기억하면 표가 거의 재현됩니다.

| 왼쪽 + 오른쪽 | inner | left outer | right outer | full outer | left semi |
|---|---|---|---|---|---|
| 스트림 + 정적 | 됨(상태 없음) | 됨(상태 없음) | 안 됨 | 안 됨 | 됨(상태 없음) |
| 정적 + 스트림 | 됨(상태 없음) | 안 됨 | 됨(상태 없음) | 안 됨 | 안 됨 |
| 스트림 + 스트림 | 됨. 워터마크와 시간 조건은 상태 정리용 선택 | 오른쪽 워터마크와 시간 조건 필수 | 왼쪽 워터마크와 시간 조건 필수 | 한쪽 워터마크와 시간 조건 필수 | 오른쪽 워터마크와 시간 조건 필수 |

조인이 들어간 쿼리는 Append 모드에서만 됩니다(문서 문장은 "As of Spark 2.4"). 조인 앞뒤에 `mapGroupsWithState`와 `flatMapGroupsWithState`를 둘 수 없고 조인을 여러 번 이어 붙이는 것은 됩니다.

## 9. 이벤트 시간 윈도

<details>
<summary>기초부터: 이벤트 시간과 처리 시간</summary>

> **핵심 한 줄**: 이벤트 시간은 일이 실제로 일어난 시각(데이터 안의 `event_time`)이고 처리 시간은 Spark가 그 행을 처리한 시각입니다. 윈도 집계는 보통 이벤트 시간으로 묶습니다.

#### 1. 왜 필요한가

사용자가 12:04에 게시글을 눌렀는데 네트워크가 끊겨 12:11에 서버에 도착했다고 합시다. 도착 시각으로 묶으면 이 클릭은 12:10~12:20 칸에 들어가고 실제로 클릭이 일어난 12:00~12:10 칸의 숫자가 틀립니다. 프로그래밍 가이드도 12:04에 생긴 데이터가 12:11에 도착하면 12:11 대신 12:04로 `12:00 - 12:10` 윈도를 갱신해야 한다고 적습니다.

#### 2. 어떻게 동작하나

1. **시각을 데이터에 담기**: 이벤트를 만든 쪽이 발생 시각을 컬럼(`event_time`)으로 넣습니다.
2. **윈도에 배정**: `window("event_time", "10 minutes")`가 행마다 그 시각이 속한 윈도를 계산합니다. 슬라이딩 윈도면 여러 윈도에 들어갑니다.
3. **윈도별 상태 갱신**: (윈도, 키)마다 집계 값을 상태로 들고 있다가 늦게 온 행도 자기 윈도의 값에 더합니다.
4. **언제 닫을지 정하기**: 오래된 윈도를 언제까지 열어 둘지는 워터마크가 정합니다(10절).

```text
           발생(이벤트 시간)   도착(처리 시간)
클릭 A     12:02               12:03
클릭 B     12:04               12:11    ← 늦게 도착
클릭 C     12:12               12:12

이벤트 시간으로 묶으면   [12:00, 12:10) A, B    [12:10, 12:20) C
처리 시간으로 묶으면     [12:00, 12:10) A       [12:10, 12:20) B, C
```

#### 3. 한눈에 비교

| 구분 | 이벤트 시간 | 처리 시간 |
|---|---|---|
| 값의 출처 | 데이터 안 컬럼 | Spark가 처리하는 시각 |
| 늦은 데이터 | 원래 윈도로 들어간다 | 도착한 때의 윈도로 들어간다 |
| 같은 데이터를 다시 처리하면 | 같은 윈도에 묶인다 | 다시 돌린 시각에 따라 달라진다 |
| 따라오는 숙제 | 늦은 데이터를 얼마나 기다릴지(워터마크) | 없음 |

#### 4. 헷갈리는 점

- 트리거의 `processingTime="2 minutes"`는 배치를 얼마나 자주 돌릴지 정하는 값입니다. 윈도를 어떻게 묶을지와는 관계가 없습니다.
- 이벤트 시간 집계는 도착 순서를 가정하지 않습니다. 순서가 뒤섞여 와도 워터마크 안이면 같은 윈도에 들어갑니다.

> **정리**: 이벤트 시간으로 묶으면 결과가 정확해지는 대신 "늦은 데이터를 언제까지 기다리나"라는 질문이 생깁니다. 그 답이 10절의 워터마크입니다.

</details>

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

![같은 클릭 여섯 개를 텀블링, 슬라이딩, 세션 윈도로 묶은 모양. 텀블링은 10분 칸에 하나씩, 슬라이딩은 5분마다 시작하는 10분 칸이 겹쳐서 12:07 클릭이 두 칸에 들어가고 세션은 30분 넘게 비면 끊겨서 두 세션이 된다](/uploads/cert/spark/spark-05-structured-streaming/three-windows.svg)

행 하나가 어느 윈도에 들어가는지를 직접 계산해 보면 표가 외워집니다. 프로그래밍 가이드의 예처럼 크기 10분, 간격 5분인 슬라이딩 윈도에서 12:07 클릭을 보겠습니다.

1. 윈도는 5분마다 시작하니 후보 시작 시각은 12:00, 12:05, 12:10, …입니다.
2. 각 윈도는 시작부터 10분이니 `[12:00, 12:10)`, `[12:05, 12:15)`, `[12:10, 12:20)`입니다.
3. 12:07을 포함하는 것은 앞의 둘입니다. 그래서 이 클릭은 두 윈도의 개수를 하나씩 올립니다.

크기를 간격으로 나눈 값(10 ÷ 5 = 2)이 행 하나가 들어가는 윈도 수입니다. 텀블링은 크기와 간격이 같아서 1입니다.

세션 윈도는 시작과 끝이 데이터로 정해집니다. 간격 30분으로 한 사용자의 클릭을 따라가 보겠습니다.

| 클릭 | 직전 클릭과의 거리 | 세션 |
|---|---|---|
| 10:00 | 처음 | 세션 1 시작, `[10:00, 10:30)` |
| 10:20 | 20분 | 30분 안이라 세션 1이 `[10:00, 10:50)`으로 늘어남 |
| 10:45 | 25분 | 세션 1이 `[10:00, 11:15)`로 늘어남 |
| 11:30 | 45분 | 11:15에 이미 끝났으니 세션 2 시작, `[11:30, 12:00)` |

세션의 끝은 마지막 클릭 시각에 간격을 더한 값입니다. 늦게 온 클릭이 두 세션 사이 빈틈을 메우면(예를 들어 11:10 클릭이 뒤늦게 도착) 두 세션이 하나로 합쳐질 수 있습니다. 그래서 세션 윈도는 워터마크가 지나기 전까지 끝을 확정할 수 없습니다.

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

간격은 행마다 다르게 줄 수도 있습니다. 8절의 `clicks_with_board`처럼 `board` 컬럼이 붙은 스트림이라면 `F.session_window("event_time", F.when(F.col("board") == "notice", "5 minutes").otherwise("30 minutes"))`처럼 식을 주면 되고 0이나 음수 간격인 행은 집계에서 빠집니다.

### 9-3. 윈도 위에 다시 윈도

5분 윈도 결과를 1시간 텀블링 윈도로 다시 묶으려면 윈도의 대표 시각이 필요합니다. `window_time(window_col)`이 그 타임스탬프를 만들고 `window()`에 윈도 컬럼을 그대로 넣어도 됩니다.

```python
five_min = (clicks
            .withWatermark("event_time", "10 minutes")
            .groupBy(F.window("event_time", "5 minutes"), "post_id")
            .count())
hourly = five_min.groupBy(F.window(F.window_time("window"), "1 hour"), "post_id").agg(F.sum("count"))
```

`window_time`은 3.4.0에 들어왔고 윈도 끝에서 1마이크로초를 뺀 시각(`[12:00, 12:05)`이면 12:04:59.999999)을 돌려줍니다. 스트리밍에서 이렇게 집계를 두 번 잇는 쿼리는 상태 연산 두 개를 체인으로 이은 것이라 Append 모드에서만 돌고(12-1) Append 집계에는 워터마크가 필요해서 위 예제에 워터마크를 걸었습니다.

## 10. 워터마크와 늦은 데이터

### 10-1. 정의

<details>
<summary>기초부터: 워터마크로 늦은 데이터를 기다리는 한도 정하기</summary>

> **핵심 한 줄**: 워터마크는 "이 시각보다 이른 이벤트는 더 기다리지 않는다"고 엔진이 정하는 선입니다. 이 선을 넘긴 윈도는 결과를 확정하고 상태를 지웁니다.

#### 1. 왜 필요한가

늦은 데이터를 받아 주려면 지난 윈도의 상태를 계속 들고 있어야 합니다. 끝없이 들고 있으면 상태가 계속 커지고 Append 모드는 결과를 언제 내보낼지 정할 수 없습니다. 그래서 사용자가 허용 지연을 정하고 엔진이 그 기준으로 윈도를 닫습니다.

#### 2. 어떻게 동작하나 (허용 지연 10분)

1. **최대 이벤트 시간 추적**: 배치마다 지금까지 본 가장 늦은 `event_time`을 갱신합니다.
2. **워터마크 계산**: 워터마크는 최대 이벤트 시간에서 10분을 뺀 값입니다. 배치가 끝날 때 계산해 다음 배치부터 씁니다.
3. **늦은 행 판정**: 이벤트 시간이 워터마크보다 이른 행은 버려질 수 있습니다.
4. **윈도 닫기**: 윈도 끝이 워터마크보다 이르면 그 윈도는 더 바뀌지 않는다고 봅니다. Append는 이때 최종 값을 내보내고 상태를 지웁니다.

| 배치 | 들어온 이벤트 시간 | 이 배치의 워터마크 | 배치 뒤 최대 이벤트 시간 | `[12:00, 12:10)` 윈도 |
|---|---|---|---|---|
| 1 | 12:02, 12:07 | 없음 | 12:07 | 열림, 2건 |
| 2 | 12:14, 12:09 | 11:57 | 12:14 | 열림, 3건(12:09는 늦게 왔지만 반영) |
| 3 | 12:21 | 12:04 | 12:21 | 열림 |
| 4(데이터 없음) | 없음 | 12:11 | 12:21 | 닫힘. Append는 최종 3건을 이때 내보냄 |
| 5 | 12:04 | 12:11 | 12:21 | 12:04 행은 닫힌 윈도라 버려짐 |

표에서 헷갈리는 칸은 "이 배치의 워터마크"입니다. 배치 2의 워터마크 11:57은 배치 1이 끝났을 때의 최대 이벤트 시간 12:07에서 10분을 뺀 값입니다. 배치 2에 들어온 12:14는 배치 3의 워터마크(12:04)를 정하는 데 쓰입니다. 워터마크는 배치가 끝날 때 계산해 다음 배치에 쓰므로 표에서 항상 한 줄씩 밀려 보입니다. 배치 2에서 12:09가 늦게 왔는데도 들어간 이유도 여기 있습니다. 그 순간 워터마크는 11:57이었고 12:09는 그보다 뒤입니다.

4번 배치는 새 데이터가 없어도 워터마크가 바뀌면 돌리는 빈 배치입니다. 4.2.0 `SQLConf`의 `spark.sql.streaming.noDataMicroBatches.enabled`(기본 true)가 상태 연산 쿼리에서 이 배치를 돌립니다.

```text
이벤트 시간 →  12:00 ─────── 12:10 ─ 12:11 ────────── 12:21
               [ 윈도 12:00~12:10 ]   ↑ 워터마크        ↑ 최대 이벤트 시간
                                      └──── 10분 ───────┘
```

#### 3. 헷갈리는 점

- 워터마크는 벽시계 시간과 관계없이 데이터 안의 이벤트 시간으로만 움직입니다. 새 데이터가 오지 않으면 워터마크도 그대로입니다.
- 이벤트 시간이 미래로 잘못 찍힌 행 하나가 최대 이벤트 시간을 끌어올리면 정상 데이터가 늦은 데이터로 취급될 수 있습니다.
- 보장은 한 방향입니다. 허용 지연보다 덜 늦은 데이터는 반드시 반영되고 더 늦은 데이터는 버려질 수도 있고 반영될 수도 있습니다.

> **정리**: 허용 지연을 길게 잡으면 늦은 데이터를 더 받는 대신 상태가 크고 Append 결과가 늦게 나옵니다. 아래 정의와 10-2 표가 이 교환을 문서 문장으로 보여 줍니다.

</details>

```python
DataFrame.withWatermark(eventTime, delayThreshold)
```

API 문서의 정의는 "쿼리의 모든 파티션에서 본 MAX(eventTime)에서 사용자가 준 delayThreshold를 뺀 값"입니다. 파티션 사이에 이 값을 맞추는 비용 때문에 실제 워터마크는 실제 이벤트 시간보다 최소 delayThreshold만큼 뒤에 있다는 것만 보장하고 경우에 따라 그보다 더 늦은 레코드도 처리될 수 있다고 적습니다.

프로그래밍 가이드의 예를 게시판 클릭으로 옮기면 이렇습니다. 허용 지연이 10분이고 트리거 동안 본 최대 이벤트 시간이 12:14이면 다음 트리거의 워터마크는 12:04입니다. 12:09에 발생한 클릭이 늦게 도착해도 12:04보다 뒤라서 `[12:00, 12:10)`과 `[12:05, 12:15)` 윈도에 들어갑니다. 최대 이벤트 시간이 12:21까지 가서 워터마크가 12:11이 되면 `[12:00, 12:10)` 윈도의 상태를 지우고 그 뒤에 온 12:04 클릭은 너무 늦은 데이터로 버립니다.

워터마크를 처음 소개한 Databricks 블로그 글(Tathagata Das, 2017)도 같은 그림으로 설명합니다. 지금까지 본 최대 이벤트 시간이 12:33이고 허용 지연이 10분이면 워터마크는 12:23이 되고 12:23보다 오래된 윈도의 상태를 지웁니다. 허용 지연을 늘리면 더 늦은 데이터를 받는 대신 메모리를 더 쓴다는 교환도 그 글이 짚습니다([Databricks, Event-time Aggregation and Watermarking](https://www.databricks.com/blog/2017/05/08/event-time-aggregation-watermarking-apache-sparks-structured-streaming.html)).

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

Flink의 `withIdleness`에 해당하는 설정은 4.2.0 설정 문서와 `SQLConf` 소스에 없습니다. 4.2.0 소스의 `WatermarkTracker.updateWatermark`는 이번 배치에 행이 들어온 입력의 워터마크만 올리고 행이 없는 입력은 이전 값(데이터가 한 번도 없었으면 0)을 그대로 둔 채 정책으로 전역 워터마크를 고릅니다. 그래서 기본 `min` 정책에서는 조용한 입력 하나가 전역 워터마크를 붙잡습니다. 프로그래밍 가이드도 한 스트림이 업스트림 장애로 데이터를 받지 못하는 경우를 예로 들며 전역 워터마크가 가장 느린 스트림 속도로 움직인다고 적습니다.

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

여기서 시험에 나올 만한 함정이 있습니다. 판정 컬럼에 이벤트 시간을 넣지 않고 `withWatermark(...).dropDuplicates(["event_id"])`라고 쓰면 워터마크는 걸렸지만 상태가 정리되지 않습니다. 4.2.0 소스의 `StreamingDeduplicateExec`는 상태 키(중복 판정 컬럼)에 워터마크가 걸린 컬럼이 있을 때만 워터마크보다 오래된 키를 지웁니다. 워터마크보다 늦은 입력 행을 버리는 필터는 입력 컬럼을 보고 동작하므로 이 경우에도 걸립니다. 프로그래밍 가이드 예제도 두 컬럼을 같이 쓰는 형태입니다.

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

<details>
<summary>기초부터: 배치 사이에 이어지는 중간 결과, 상태</summary>

> **핵심 한 줄**: 상태는 배치와 배치 사이에 들고 가야 하는 중간 결과입니다. Spark는 이를 파티션별 상태 저장소에 두고 배치마다 새 버전으로 체크포인트에 남깁니다.

#### 1. 왜 필요한가

마이크로배치 하나는 새로 들어온 행만 봅니다. 게시글별 누적 클릭 수를 내려면 지난 배치까지의 개수를 어딘가에 들고 있어야 합니다. 필터나 select는 행 하나만 보고 끝나므로 기억할 것이 없습니다.

#### 2. 어떻게 동작하나 (배치 N의 스트리밍 집계)

1. **셔플**: 새 행을 그룹 키(`post_id`)로 셔플해 같은 키를 같은 파티션에 모읍니다. 상태 파티션 수는 첫 실행 때의 셔플 파티션 수로 고정됩니다. 4.2.0 소스 `OffsetSeq`가 이 값을 오프셋 로그에 함께 저장합니다.
2. **상태 불러오기**: 파티션마다 Task가 자기 상태 저장소를 버전 N-1로 엽니다.
3. **갱신**: 새 행으로 키별 값을 읽고 고쳐 씁니다.
4. **정리**: 워터마크가 있으면 워터마크보다 오래된 키를 지웁니다.
5. **커밋**: 바뀐 내용을 버전 N으로 체크포인트 `state/` 아래에 남깁니다.

```text
배치 N, 집계 Task (파티션 3)
  state v(N-1)   {p1: 3, p7: 10}
  새 행          p1, p1, p9
  state v(N)     {p1: 5, p7: 10, p9: 1}   → /chk/.../state/<연산자>/3/ 에 저장
```

#### 3. 한눈에 비교

| 연산 | 상태 | 상태에 남는 것 |
|---|---|---|
| select, filter, 스트림과 정적 조인 | 없음 | 없음 |
| 스트리밍 집계, 윈도 집계 | 있음 | 키(와 윈도)별 집계 중간 값 |
| `dropDuplicates` | 있음 | 이미 본 키 |
| 스트림과 스트림 조인 | 있음 | 양쪽 입력 행 버퍼 |
| `applyInPandasWithState`, `transformWithStateInPandas` | 있음 | 사용자가 정한 그룹별 값 |

#### 4. 헷갈리는 점

- 상태 크기는 키 수와 워터마크가 정합니다. 키가 계속 새로 생기는데 워터마크로 정리되지 않으면 끝없이 커집니다(11-1).
- 상태의 원본은 체크포인트입니다. Task가 다른 익스큐터에서 다시 돌면 그 익스큐터가 체크포인트에서 상태를 읽어 옵니다.
- 셔플 파티션 수가 고정되므로 재시작 때 `spark.sql.shuffle.partitions`를 바꿔도 상태 연산의 파티션 수는 그대로입니다.

> **정리**: 상태가 있는 연산은 배치마다 "불러오기, 고치기, 버전 남기기"를 반복합니다. 아래 본문은 어떤 연산이 상태를 만들고 몇 개까지 이어 붙일 수 있는지입니다.

</details>

스트리밍 집계, 스트리밍 중복 제거, 스트림 간 조인, `mapGroupsWithState`와 `flatMapGroupsWithState`가 상태를 씁니다. 문서는 4.0부터 복잡한 상태 처리에 `transformWithState` 연산자를 쓰라고 권하고 앞의 두 연산은 legacy로 부릅니다. 선택, 필터, 상태 없는 UDF는 상태를 만들지 않습니다(안내서 샘플 문항 9번의 정답 방향).

체인 제한도 있습니다. 상태 연산 여러 개를 이어 붙이는 것은 Update와 Complete 모드에서 지원하지 않습니다. Append 모드의 체인은 버전에 따라 답이 갈립니다. 3.3.0 문서는 "Multiple streaming aggregations (i.e. a chain of aggregations on a streaming DF) are not yet supported"라고 적었고 3.4.0 문서부터 지금 문장(Update와 Complete에서만 불가)으로 바뀌었습니다. 그래서 3.4.0 이상에서는 Append 모드로 윈도 집계 위에 윈도 집계를 다시 거는 쿼리(9-3)가 됩니다. `mapGroupsWithState`나 `flatMapGroupsWithState` 뒤에 다른 상태 연산을 두는 것은 Append에서도 안 됩니다. 문서가 제시하는 우회는 상태 연산 하나씩 들어간 쿼리 여러 개로 나누는 것입니다.

### 12-2. 상태 저장소 구현

| 구현 | 기본 여부 | 특징 |
|---|---|---|
| HDFS 기반(HDFSBackedStateStore) | 기본 | 처음에는 메모리 맵에 두고 HDFS 호환 파일 시스템 파일로 백업. 업데이트 묶음마다 버전이 올라간다 |
| RocksDB(3.2부터) | 선택 | 상태를 JVM 힙 대신 네이티브 메모리와 로컬 디스크에 둔다. 체크포인트 위치에 변경을 저장해 장애 내성은 같다 |

표의 "네이티브 메모리"는 JVM 힙 밖에서 프로세스가 직접 잡는 메모리입니다. 힙에 있는 객체는 GC가 주기적으로 훑어야 해서 상태 객체가 수백만 개면 훑는 일 자체가 길어지고 그동안 Task가 멈춥니다. RocksDB는 C++ 라이브러리라 상태를 힙 밖 메모리와 로컬 디스크에 두고 GC는 그 내용을 보지 않습니다.

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

B입니다. Kafka 소스는 오프셋으로 다시 읽을 수 있고 파일 싱크는 exactly-once이며 체크포인트가 처리 범위를 기록합니다. A의 socket은 재실행할 수 없고 C의 console은 장애 내성이 없습니다. D는 Kafka 싱크 자체가 at-least-once입니다. 게다가 Kafka 싱크는 체크포인트 위치가 없으면 세션 기본값(`spark.sql.streaming.checkpointLocation`)을 주지 않은 한 `start()`에서 오류가 납니다(3-2).

</details>

**문제 3.** 허용 지연 10분인 워터마크에서 지금까지 본 최대 이벤트 시간이 09:30입니다. 이벤트 시간 09:25인 클릭과 09:15인 클릭이 도착했습니다. 각각 어떻게 됩니까?

<details>
<summary>정답과 근거</summary>

워터마크는 09:20입니다(최대 이벤트 시간 09:30을 본 트리거가 끝난 뒤 다음 트리거부터 적용). 09:25 클릭은 워터마크보다 뒤라서 반드시 집계됩니다. 09:15 클릭은 워터마크보다 늦은데 해당 윈도의 상태가 이미 지워졌다면 버려집니다. 다만 늦은 데이터를 반드시 버린다는 보장은 없어서 상태가 남아 있으면 집계될 수도 있습니다.

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

**문제 8.** 워터마크를 걸었는데 상태가 계속 커집니다. 쿼리는 `clicks.withWatermark("event_time", "10 minutes").groupBy("post_id").count()`이고 Update 모드입니다. 무엇이 문제입니까?

<details>
<summary>정답과 근거</summary>

집계 키에 이벤트 시간 컬럼이나 그 윈도가 없습니다. 10-3의 두 번째 조건입니다. 워터마크가 진행해도 `post_id`별 개수 상태에는 시간이 없어서 어느 키를 버려도 되는지 정할 근거가 없습니다. `F.window("event_time", "10 minutes")`를 그룹 키에 함께 넣으면 워터마크가 윈도 끝을 넘은 상태부터 정리됩니다.

순서를 뒤집어 `clicks.groupBy("post_id").count().withWatermark("event_time", "10 minutes")`라고 쓰면 집계 결과에 `event_time` 컬럼이 남지 않아 워터마크를 걸 컬럼부터 찾지 못합니다. 문서가 집계보다 먼저 `withWatermark`를 부르라고 하는 조건(10-3의 네 번째)과 같은 이야기입니다.

</details>

## 14. 범위와 한계

- 동작과 기본값은 Spark 4.2.0 Structured Streaming Programming Guide와 PySpark 4.2.0 API 문서를 기준으로 했습니다(2026년 10월 19일 작성, 10월 20일 재확인). 출력 모드 호환 표, 지원하지 않는 연산 목록, 조인 지원 표는 3.5.6 가이드와 대조했고 내용이 같았습니다. `trigger`의 `realTime` 인자와 상태 연산 체인(12-1)처럼 버전에 따라 다른 부분은 본문에 표시했습니다.
- 이 글의 코드는 아직 실행하지 않았습니다. 이 노트북에 Java가 없어서 PySpark를 띄우지 못했습니다. Python 코드 블록은 문법 검사(`ast.parse`)만 통과시켰습니다. 예외가 나는 시점(5-2), 체크포인트를 생략했을 때의 동작(3-2), console 싱크의 지원 모드(6-1), 조용한 입력과 전역 워터마크(10-5), 이벤트 시간을 판정 컬럼에서 뺀 중복 제거의 상태 정리(11-2)는 4.2.0 소스를 읽고 적었습니다.
- Real-time Mode의 동작 설명은 배포되지 않은 메인 브랜치 문서로만 확인했습니다. Kafka 연동 옵션과 `transformWithState`의 API는 범위가 커서 다루지 않았습니다.

## 참고 자료

공식 자료
- Databricks, [Exam Guide, 2026-10-08판](https://www.databricks.com/sites/default/files/2026-10/databricks-certified-associate-developer-apache-spark-exam-guide-august-2026.pdf), [Exam Guide, Oct 2025](https://www.databricks.com/sites/default/files/2025-10/databricks-certified-associate-developer-apache-spark-exam-guide-oct-2025.pdf) (5영역 항목과 샘플 문항 8, 9)
- Apache Spark 4.2.0, [Structured Streaming Programming Guide: Overview](https://spark.apache.org/docs/latest/streaming/index.html)
- Apache Spark 4.2.0, [Getting Started](https://spark.apache.org/docs/latest/streaming/getting-started.html) (Programming Model, Fault Tolerance Semantics)
- Apache Spark 4.2.0, [APIs on DataFrames and Datasets](https://spark.apache.org/docs/latest/streaming/apis-on-dataframes-and-datasets.html) (소스, 윈도, 워터마크, 중복 제거, State Store, 출력 모드, 싱크, 트리거, 복구)
- Apache Spark 4.2.0, [Performance Tips](https://spark.apache.org/docs/latest/streaming/performance-tips.html) (Continuous Processing)
- Apache Spark 4.2.0, [Web UI: Structured Streaming Tab](https://spark.apache.org/docs/latest/web-ui.html)
- Apache Spark 4.2.0, [Spark Configuration](https://spark.apache.org/docs/latest/configuration.html) (`spark.sql.streaming.*`)
- PySpark 4.2.0 API: [DataStreamWriter.trigger](https://spark.apache.org/docs/latest/api/python/reference/pyspark.ss/api/pyspark.sql.streaming.DataStreamWriter.trigger.html), [DataStreamWriter.outputMode](https://spark.apache.org/docs/latest/api/python/reference/pyspark.ss/api/pyspark.sql.streaming.DataStreamWriter.outputMode.html), [DataStreamWriter.foreachBatch](https://spark.apache.org/docs/latest/api/python/reference/pyspark.ss/api/pyspark.sql.streaming.DataStreamWriter.foreachBatch.html), [DataFrame.withWatermark](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.withWatermark.html), [DataFrame.dropDuplicates](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.dropDuplicates.html), [DataFrame.dropDuplicatesWithinWatermark](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.dropDuplicatesWithinWatermark.html), [functions.window](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.functions.window.html), [functions.session_window](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.functions.session_window.html), [StreamingQuery.id](https://spark.apache.org/docs/latest/api/python/reference/pyspark.ss/api/pyspark.sql.streaming.StreamingQuery.id.html)
- PySpark 4.2.0 API: [DataStreamWriter.foreach](https://spark.apache.org/docs/latest/api/python/reference/pyspark.ss/api/pyspark.sql.streaming.DataStreamWriter.foreach.html), [DataStreamWriter.toTable](https://spark.apache.org/docs/latest/api/python/reference/pyspark.ss/api/pyspark.sql.streaming.DataStreamWriter.toTable.html), [StreamingQuery.lastProgress](https://spark.apache.org/docs/latest/api/python/reference/pyspark.ss/api/pyspark.sql.streaming.StreamingQuery.lastProgress.html), [StreamingQuery.awaitTermination](https://spark.apache.org/docs/latest/api/python/reference/pyspark.ss/api/pyspark.sql.streaming.StreamingQuery.awaitTermination.html), [functions.window_time](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.functions.window_time.html), [GroupedData.applyInPandasWithState](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.GroupedData.applyInPandasWithState.html), [GroupedData.transformWithStateInPandas](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.GroupedData.transformWithStateInPandas.html)
- PySpark 버전별 `DataStreamWriter.trigger`(`realTime` 인자 유무 확인용): [3.5.6](https://spark.apache.org/docs/3.5.6/api/python/reference/pyspark.ss/api/pyspark.sql.streaming.DataStreamWriter.trigger.html), [4.0.0](https://spark.apache.org/docs/4.0.0/api/python/reference/pyspark.ss/api/pyspark.sql.streaming.DataStreamWriter.trigger.html), [4.1.0](https://spark.apache.org/docs/4.1.0/api/python/reference/pyspark.ss/api/pyspark.sql.streaming.DataStreamWriter.trigger.html)
- Apache Spark 3.5.6, [Structured Streaming Programming Guide](https://spark.apache.org/docs/3.5.6/structured-streaming-programming-guide.html) (4.2.0과 대조용)
- Apache Spark 3.3.0과 3.4.0, [Structured Streaming Programming Guide 3.3.0](https://archive.apache.org/dist/spark/docs/3.3.0/structured-streaming-programming-guide.html), [Structured Streaming Programming Guide 3.4.0](https://archive.apache.org/dist/spark/docs/3.4.0/structured-streaming-programming-guide.html) (Unsupported Operations의 상태 연산 체인 문장 비교)

소스 코드(표시 없는 것은 4.2.0 태그)
- Apache Spark, [sql/classic/DataStreamWriter.scala](https://github.com/apache/spark/blob/v4.2.0/sql/core/src/main/scala/org/apache/spark/sql/classic/DataStreamWriter.scala) (임시 체크포인트를 허용하는 싱크 목록)
- Apache Spark, [sql/classic/StreamingQueryManager.scala](https://github.com/apache/spark/blob/v4.2.0/sql/core/src/main/scala/org/apache/spark/sql/classic/StreamingQueryManager.scala) (`start()`에서 쓰기 계획 분석)
- Apache Spark, [ResolveWriteToStream.scala](https://github.com/apache/spark/blob/v4.2.0/sql/core/src/main/scala/org/apache/spark/sql/execution/streaming/runtime/ResolveWriteToStream.scala) (출력 모드 검사, 체크포인트 위치 결정, AQE 비활성 경고)
- Apache Spark, [console.scala](https://github.com/apache/spark/blob/v4.2.0/sql/core/src/main/scala/org/apache/spark/sql/execution/streaming/console.scala) (console 싱크의 Complete, Update 지원)
- Apache Spark, [WatermarkTracker.scala](https://github.com/apache/spark/blob/v4.2.0/sql/core/src/main/scala/org/apache/spark/sql/execution/streaming/runtime/WatermarkTracker.scala) (입력별 워터마크와 전역 워터마크 선택)
- Apache Spark, [statefulOperators.scala](https://github.com/apache/spark/blob/v4.2.0/sql/core/src/main/scala/org/apache/spark/sql/execution/streaming/operators/stateful/statefulOperators.scala) (`StreamingDeduplicateExec`의 상태 정리 조건)
- Apache Spark, [Trigger.java 4.1.0](https://github.com/apache/spark/blob/v4.1.0/sql/api/src/main/java/org/apache/spark/sql/streaming/Trigger.java) (`Trigger.RealTime`), [docs/streaming/real-time-mode.md(메인 브랜치, 미배포)](https://github.com/apache/spark/blob/master/docs/streaming/real-time-mode.md)

참고한 기술 블로그
- Tathagata Das, [Event-time Aggregation and Watermarking in Apache Spark's Structured Streaming](https://www.databricks.com/blog/2017/05/08/event-time-aggregation-watermarking-apache-sparks-structured-streaming.html) (Databricks, 2017-05-08). 10-1의 12:33, 12:23 예와 허용 지연과 메모리의 교환
- Apache Spark 4.2.0, [Structured Streaming + Kafka Integration Guide](https://spark.apache.org/docs/latest/streaming/structured-streaming-kafka-integration.html) (4-1의 Kafka 소스 스키마와 `startingOffsets` 기본값)
- Apache Spark JIRA, [SPARK-28650](https://issues.apache.org/jira/browse/SPARK-28650) (6-3의 `(partition_id, epoch_id)` 중복 제거 한계)

이 시리즈와 비교 글
- [Spark Ch-00: 시험 구조와 공부 계획](/blog/cert/spark/spark-00-exam-and-study-plan), [Spark Ch-04: 문제 해결과 튜닝](/blog/cert/spark/spark-04-troubleshooting-tuning)
- [DE Ch-15: Flink의 시간과 watermark](/blog/data/streaming/de-15-flink-time-watermark), [DE Ch-16: 윈도와 interval join](/blog/data/streaming/de-16-flink-window-join)

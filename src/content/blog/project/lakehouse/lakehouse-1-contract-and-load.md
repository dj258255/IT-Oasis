---
title: '계약 먼저, 그다음 어제치를 안전하게 — 데이터 계약과 인덱스 선두를 타는 Extract & Load'
titleEn: 'Contract First, Then Offload Yesterday Safely — A Data Contract and an Extract & Load That Rides the Index Prefix'
description: "코드부터 짜고 싶었지만 참았습니다. 파이프라인의 버그는 대부분 '계약 불명확'에서 오니까요 — dt 경계가 UTC냐 KST냐, 파티션 키가 뭐냐, calls가 누적값이냐 구간값이냐. 1부에서는 Airflow(LocalExecutor) 스캐폴드를 세우고 원천 스키마·파티셔닝·포맷·워터마크를 담은 데이터 계약을 먼저 씁니다. 2부에서는 그 계약 위에 실제 추출·적재를 얹습니다. 어제 쌓인 스냅샷은 6일 뒤 삭제되는데, 추출이 관제탑(메타 PG)을 느리게 하면 자기모순입니다. DBTower의 인덱스는 (instance_id, captured_at) 순서라 인스턴스별 등치 질의로 인덱스 선두를 타게 하고, 읽기 전용 세션 + 서버커서로 부하를 눌렀습니다. 멱등성은 파티션 통째 덮어쓰기로. 실측으로 원천 PG = MinIO parquet = DuckDB count 3자 일치(닫힌 창 07-05=149,259 · 07-06=79,894)를 확인하고, 닫힌 구간을 두 번 돌려 79,894행이 불변임을(중복 0) 증명합니다. Airflow 스케줄러가 부른 태스크가 원천→parquet→조회까지 정확히 흐른 것도 dags test로 확인했습니다."
descriptionEn: "I wanted to start with code, but held back — most pipeline bugs come from an unclear contract: is the dt boundary UTC or KST, what's the partition key, are calls cumulative or interval values. Part 1 stands up an Airflow (LocalExecutor) scaffold and writes the data contract first: source schema, partitioning, format, watermark. Part 2 builds the actual extract and load on that contract. Yesterday's snapshots get deleted in six days, and if the extraction slows the control tower (metadata PG) it's self-contradictory — DBTower's index is ordered (instance_id, captured_at), so I query per instance with an equality predicate to ride the index prefix, with a read-only session and a server-side cursor. Idempotency comes from whole-partition overwrite. Live checks confirm source PG = MinIO parquet = DuckDB count agree three ways (closed windows 07-05 = 149,259 and 07-06 = 79,894), and a closed window run twice holds at 79,894 rows with zero duplication. A scheduler-invoked task flowing source to parquet to query was verified via dags test."
date: 2026-04-19
tags:
  - Airflow
  - Docker Compose
  - Data Contract
  - Parquet
  - Data Engineering
  - PostgreSQL
  - DuckDB
  - MinIO
  - Idempotency
category: personal/lakehouse
coverImage: /uploads/project/lakehouse/cover.svg
draft: false
series: "lakehouse"
seriesOrder: 1
---

## 1부 — 계약 먼저: DAG를 짜기 전에 무엇을 옮길지부터 못박다

### 0. 상황 — 코드부터 짜고 싶은 유혹

[0편](/blog/project/lakehouse/lakehouse-0-why)에서 "버려지는 7일을 분석계로 내린다"는 방향을 잡았습니다. 이제 DAG를 짜고 싶었어요.

참았습니다. 파이프라인의 버그는 대부분 코드가 아니라 **계약 불명확**에서 옵니다.

- dt 경계가 UTC냐 KST냐? (하루가 어긋나면 어제 데이터가 두 파티션에 쪼개집니다.)
- 파티션 키가 뭐냐? (나중에 바꾸면 그동안 쌓은 파일을 못 읽습니다.)
- 스키마가 진화하면 옛 파일은 어떻게 읽냐?
- calls 같은 숫자가 **누적값이냐 구간값이냐?** (이걸 착각하면 2단계의 모든 집계가 조용히 틀립니다.)

이걸 코드로 먼저 굳혀 버리면, 나중에 규칙이 흔들릴 때 backfill이 통째로 깨집니다. 그래서 0단계의 목표는 "돌아가는 DAG"가 아니라 **계약과 스캐폴드**입니다.

### 1. 계약 — 원천을 코드로 먼저 확인하다

가장 위험한 함정부터. `query_snapshot`의 `calls`·`total_time_ms`가 **누적인지 구간인지**를 단정하지 않고 확인했습니다. 두 경로로요.

**코드**: DBTower의 `QuerySnapshot` 엔티티 주석이 "쿼리별 **누적 통계** 한 줄"이라 못박고 있고, `ComparisonService`가 시점 비교를 이렇게 합니다.

```java
// 구간 양 끝 배치의 누적 카운터 차분으로 구간 내 발생량을 구한다
long deltaCalls = start == null ? end.getCalls()
                                : Math.max(0, end.getCalls() - start.getCalls());
```

`end - start` 차분에 `Math.max(0, …)` 클램프 — 대상 DB가 재기동돼 카운터가 리셋되면 음수 델타가 나오는데 그걸 0으로 눌러줍니다. 전형적인 **누적 카운터** 처리예요.

**실측**: 한 쿼리를 시간순으로 뽑아봤습니다.

```
captured_at              | calls | total_time_ms
2026-07-03 20:54:27.937  |    61 |     99.4283
2026-07-03 20:55:28.107  |   204 |    339.6784
2026-07-03 20:56:28.189  |   348 |    585.8628
2026-07-03 20:57:28.283  |   700 |   1154.9456
2026-07-03 20:58:28.350  |  1348 |   2186.0748
2026-07-03 20:59:28.495  |  1732 |   2812.3712
2026-07-03 21:00:52.238  |  1732 |   2812.3712   <- 유휴 구간엔 평탄(감소 없음)
```

61 → 204 → 348 → … 단조 증가하다가, 실행이 없는 구간엔 값이 그대로 유지됩니다. 감소가 없어요. **누적이 확실합니다.**

중요한 건, **1단계(EL)는 이 판단이 없어도 정확하다**는 점입니다. 원본을 그대로 parquet로 내리니까요. 누적→일간 델타 변환은 2단계(dbt)의 몫입니다. 그래서 여기선 "누적이다"라는 **사실만** 계약서(`docs/CONTRACT.md`)에 적어 두고, 변환은 뒤로 미룹니다. 확인 안 된 걸 단정하지 않는 게 계약의 핵심이에요.

계약서에 굳힌 규칙은 이렇습니다.

- **파티셔닝**: `s3://lakehouse/raw/query_snapshot/dt=YYYY-MM-DD/instance_id=N/part-000.parquet`
- **포맷**: Parquet + zstd 압축, **스키마 명시 선언**(타입 추론이 흔들려도 파일 스키마는 고정).
- **워터마크**: `data_interval`. `dt` = data_interval_start의 날짜, **UTC 자정 경계**. DBTower가 `captured_at`을 UTC로 저장하므로(hibernate `time_zone=UTC`) 경계도 UTC로 맞춰 KST/DST 흔들림을 없앱니다.
- **경계 조건**: `captured_at >= dt AND captured_at < dt+1` (반열림 구간 — 겹침·누락 0).

### 2. 스캐폴드 — LocalExecutor를 고른 이유

Airflow 공식 docker-compose의 기본은 **CeleryExecutor**입니다. Redis 브로커 + 별도 워커 컨테이너가 붙어요. 일 수만 행짜리 단일 노드 배치에는 과합니다.

그래서 **LocalExecutor**로 갔습니다. 스케줄러 프로세스 안에서 태스크를 병렬 실행하니 Redis도, 워커도 필요 없어요. 대신 메타DB는 SQLite로는 병렬이 안 되므로 PostgreSQL이 필요합니다 — Airflow 전용 PG 하나를 **격리**해서 띄웠습니다. DBTower 메타 PG(원천)와 물리적으로 분리해, 관제 DB를 오염시키지 않게요.

원천 PG와 MinIO는 이미 DBTower 데모 스택에 떠 있습니다. 중복 스택을 만들지 않고 **기존 네트워크를 재사용**했어요.

```yaml
networks:
  default:
    name: dbtower_default   # DBTower 데모 스택 네트워크
    external: true
```

이러면 Airflow 컨테이너가 `dbtower-postgres:5432`·`dbtower-minio:9000`으로 바로 붙습니다. 추가 런타임 패키지(pyarrow·psycopg2·boto3·duckdb)는 이미지 재빌드 없이 `_PIP_ADDITIONAL_REQUIREMENTS`로 얹었습니다.

#### 함정 — start_date와 @daily 정렬

Airflow의 data interval은 초심자가 반드시 밟는 지뢰입니다. `@daily`는 자정 경계로 도는데, `start_date`를 자정이 아닌 시각(예: 09:30)으로 두면 첫 인터벌이 어긋나 "언제 무슨 날짜가 도는지"가 헷갈려집니다. 그래서 자정으로 못박았습니다.

```python
@dag(
    schedule="@daily",
    start_date=pendulum.datetime(2026, 7, 3, tz="UTC"),  # @daily 경계(자정)에 정렬
    catchup=False,          # 무의도 대량 백필 방지
    max_active_runs=1,      # 동시 런 상한
)
```

`catchup=False`는 시작하자마자 과거 전체를 백필하는 사고를 막습니다. `max_active_runs=1`과 태스크 단위 `max_active_tis_per_dag=1`은, 나중에 backfill을 돌릴 때 수백 태스크가 동시에 떠 스케줄러를 짓누르는 걸 막는 상한입니다.

### 3. 실측 — 뜨는지 확인

```
$ docker compose up -d
$ docker exec ... airflow dags list-import-errors
No data found                         # 임포트 에러 0

$ docker exec ... airflow dags list
snapshot_offload | .../snapshot_offload.py | airflow | True
```

DAG가 임포트 에러 없이 목록에 뜹니다. MinIO health는 200, Airflow 웹서버는 `:8080`에 올라옵니다.

![Airflow UI — snapshot_offload DAG가 임포트 에러 없이 목록에 뜬다(태그 el·extract·lakehouse, @daily)](/uploads/project/lakehouse/airflow-dag.png)

DAG는 떴지만 아직 껍데기입니다. MinIO 버킷은 비어 있어요 — 실제 데이터가 흐르는 건 이어지는 2부입니다.

### 4. 잔여 — 아직 데이터는 안 흐른다

0단계는 여기까지입니다. 계약이 서고 스캐폴드가 떴지만, **아직 한 줄도 안 옮겼어요.** DAG는 껍데기고, MinIO 버킷은 비어 있습니다.

2부에서 그 껍데기에 실제 추출·적재 로직을 넣습니다. 그리고 마주칠 함정이 하나 예고돼 있어요 — DBTower의 인덱스는 `(instance_id, captured_at)` 순서라, `captured_at` 단독 조건으로 뽑으면 인덱스 선두를 못 탑니다. 관제탑을 느리게 하지 않으면서 어제치를 안전하게 내리는 방법이 이어지는 2부의 주제입니다.

코드는 [GitHub](https://github.com/dj258255/dbtower-lakehouse)에 있습니다.

여기까지가 1부 — 계약과 스캐폴드입니다. 이제 그 껍데기에 실제 데이터를 흘립니다.

## 2부 — 어제치를 안전하게 내리다: 인덱스 선두를 타는 Extract & Load

### 0. 상황 — 6일 남은 데이터

어제 자정이 지났습니다. 어제 쌓인 스냅샷은 이제 **6일 남았어요**. DBTower가 7일 뒤 지우니까요. 6일 안에 안전하게 MinIO로 내려야 합니다.

"안전하게"에 두 가지 뜻이 있습니다.

1. **관제탑에 부하를 주지 않기.** 추출 쿼리가 메타 PG를 느리게 하면, 관제 도구를 관제하다 관제를 망가뜨리는 자기모순입니다.
2. **멱등하기.** 같은 날짜를 두 번 돌려도 결과가 같아야 backfill과 재시도가 안전합니다.

### 1. 함정 — 인덱스 선두를 못 타는 조건

가장 순진한 추출은 이겁니다.

```sql
SELECT ... FROM query_snapshot
WHERE captured_at >= ? AND captured_at < ?   -- 어제 하루
```

그런데 DBTower의 인덱스는 이렇게 생겼습니다.

```java
@Index(name = "idx_snapshot_instance_time", columnList = "instanceId, capturedAt")
```

복합 인덱스 `(instance_id, captured_at)`의 **선두는 instance_id**입니다. `captured_at` 단독 조건은 선두 컬럼을 건너뛰므로 이 인덱스를 제대로 못 탑니다 — 최악의 경우 풀스캔에 가까워집니다. 50만 행짜리 관제 DB에서 이건 그대로 부하가 됩니다. (DBTower 자신의 하드닝 감사에서 이미 지적된 실제 제약이에요.)

**판단**: 원천 인덱스를 함부로 바꾸지 않습니다(관제탑을 건드리는 최후 수단). 대신 **인스턴스별로 루프를 돌아** 등치 조건을 선두에 놓습니다.

```sql
SELECT ... FROM query_snapshot
WHERE instance_id = ?                          -- 선두 컬럼 등치 → 인덱스 탐
  AND captured_at >= ? AND captured_at < ?     -- 두 번째 컬럼 범위
ORDER BY captured_at
```

훑을 인스턴스 목록은 `query_snapshot`을 DISTINCT 스캔하지 않고(그 자체가 선두를 못 탑니다) 레지스트리 테이블 `database_instance`에서 가져옵니다.

부하를 더 눌렀습니다.

- **읽기 전용 세션** — `conn.set_session(readonly=True)`로 세션 레벨에서 쓰기를 원천 차단. "운영을 안 건드린다"를 코드가 아니라 트랜잭션이 보장하게.
- **서버커서** — named cursor + `itersize=50000`으로 결과 전체를 클라이언트 메모리에 올리지 않고 나눠 읽습니다.

### 2. 적재 — 명시 스키마와 멱등 덮어쓰기

읽은 행을 pyarrow로 parquet로 만드는데, **스키마를 명시 선언**합니다. 타입 추론에 맡기면 어느 날 조용히 int64가 double로 바뀌는 사고가 납니다.

```python
SNAPSHOT_SCHEMA = pa.schema([
    pa.field("id", pa.int64(), nullable=False),
    pa.field("instance_id", pa.int64(), nullable=False),
    pa.field("captured_at", pa.timestamp("us"), nullable=False),
    pa.field("query_id", pa.string(), nullable=False),
    pa.field("query_text", pa.string(), nullable=True),
    pa.field("calls", pa.int64(), nullable=False),
    pa.field("total_time_ms", pa.float64(), nullable=False),
    pa.field("rows_examined", pa.int64(), nullable=False),
])
```

멱등성은 **파티션 통째 덮어쓰기**로 얻습니다. 적재 전에 그 파티션 프리픽스 아래를 통째로 지우고, 단일 `part-000.parquet`를 새로 씁니다.

```python
prefix = f"raw/query_snapshot/dt={dt}/instance_id={instance_id}/"
_delete_prefix(s3, bucket, prefix)      # 이전 산출물 제거
s3.put_object(Bucket=bucket, Key=prefix + "part-000.parquet", Body=buf)
```

같은 날짜를 몇 번 돌려도 인스턴스당 오브젝트는 항상 1개, 행수는 원천과 동일합니다. 부분 실패로 낡은 파일이 남아 중복되는 일이 구조적으로 없어요.

압축은 zstd, 포맷은 zstd Parquet. 경로는 Hive 스타일이라 DuckDB가 `dt`·`instance_id`를 컬럼으로 직독합니다.

### 3. 실측 — 원천 = parquet = DuckDB

Airflow 없이도 e2e가 도는 게 중요합니다(핵심 로직이 `extract/offload.py`에 독립적으로 있고, DAG는 이걸 감쌀 뿐). 원천 DB의 시계 기준으로 완전히 닫힌 구간(dt=2026-07-06)을 호스트에서 직접 돌렸습니다.

```
$ python -m extract.offload 2026-07-06
instance 1: 18551행 → s3://lakehouse/.../instance_id=1/part-000.parquet
instance 2: 17743행 → ...
instance 3: 20158행 → ...
...
적재 완료 dt=2026-07-06 총 79894행
```

적재된 dt 파티션은 MinIO 콘솔에서 이렇게 보입니다 — `raw/query_snapshot` 아래 날짜별로 갈리고,

![MinIO 콘솔 — raw/query_snapshot 아래 dt 파티션](/uploads/project/lakehouse/minio-console.png)

그 한 날짜를 열면 인스턴스별 파티션으로 다시 갈립니다(Hive 스타일).

![MinIO에 적재된 parquet 파티션 트리 — dt 아래 instance_id별 분할](/uploads/project/lakehouse/minio-parquet.png)

이제 원천·적재·조회 3자를 대조합니다. `extract/verify_count.py`가 추출과 **동일한 경계 조건**(`captured_at >= dt AND < dt+1`)으로 원천 PG를 세고, DuckDB(httpfs)로 S3 parquet를 세서 dt별로 맞춰봅니다.

```sql
SELECT count(*)
FROM read_parquet('s3://lakehouse/raw/query_snapshot/dt=2026-07-06/instance_id=*/*.parquet',
                  hive_partitioning=1);
-- 79894  (원천 PG와 동일)
```

닫힌 두 구간(07-05·07-06)을 `verify_count`로 한 번에 대조한 실제 출력입니다.

```
$ python -m extract.verify_count 2026-07-05 2026-07-06
dt              source PG    parquet(S3)   match
------------------------------------------------
2026-07-05        149,259        149,259      OK
2026-07-06         79,894         79,894      OK
------------------------------------------------
RESULT: ALL MATCH
```

![verify_count 실행 결과 — 닫힌 두 구간에서 원천 PG = parquet(S3)](/uploads/project/lakehouse/duckdb-count.png)

#### 멱등성 — 닫힌 구간 2회

여기서 정직하게 짚을 게 있습니다. 원천 DBTower는 지금도 살아서 수집 중입니다. 그래서 **원천 DB의 시계 기준 '오늘'(dt=2026-07-07)은 열린 창**이에요 — 세어 볼 때마다 값이 달라집니다(한때 269,354였다가 뒤에 279,002로 자라 있었어요). 열린 창을 스냅샷하면 그 순간의 값을 찍을 뿐이라, 행수 일치나 멱등성을 이 창으로 검증하면 안 됩니다. 그래서 **검증은 완전히 닫힌 과거 구간**(07-05·07-06)으로만 합니다. 아래는 닫힌 dt=2026-07-06을 두 번 돌린 결과예요.

```
dt=2026-07-06 (닫힌 구간)
  원천 PG count        : 79,894
  offload 1회차 합계   : 79,894
  offload 2회차 합계   : 79,894   ← 불변
  파티션 오브젝트 수   : 6 (인스턴스당 1, 누적 안 됨)
  DuckDB count         : 79,894
```

두 번 돌려도 79,894로 고정. 오브젝트도 6개 그대로. 덮어쓰기 멱등성이 실측으로 확인됩니다.

#### Airflow 스케줄러 e2e

껍데기 DAG가 아니라 스케줄러가 부른 태스크가 실제로 흐르는지 `airflow dags test`로 확인했습니다.

```
$ airflow dags test snapshot_offload 2026-07-06
created dagrun ... data_interval_start=2026-07-05
offload.py: 적재 완료 dt=2026-07-05 총 149259행
Marking task as SUCCESS
```

여기서 재밌는 게 보입니다. 논리 실행일 `2026-07-06`의 `data_interval_start`는 **2026-07-05**라, 태스크가 처리한 건 dt=2026-07-05입니다. 즉 "어제"를 정확히 집었어요 — 0단계에서 start_date를 @daily 자정에 정렬해 둔 게 이렇게 맞아떨어집니다. 이 파티션도 원천 149,259 = DuckDB 149,259로 일치했습니다.

![Airflow 성공 런 — snapshot_offload 태스크 SUCCESS](/uploads/project/lakehouse/airflow-run-success.png)

### 4. 잔여 — raw는 아직 질문에 못 답한다

parquet는 내려왔지만, 이 raw는 **아직 "지난달보다 느려진 쿼리"에 답하지 못합니다.** calls/total_time_ms가 누적값이라, 그대로 더하면 의미가 없어요. 일간 델타로 바꿔야 하는데, 그게 [2편](/blog/project/lakehouse/lakehouse-2-transform-and-gate)의 dbt 변환입니다.

그리고 하나 더. 어느 날 특정 인스턴스의 파티션이 수집 장애로 비면, 그 위에 만든 랭킹은 조용히 오답을 냅니다. 지금은 그걸 잡을 게 없어요. 품질 게이트는 뒤에서 세웁니다.

정직하게 남기는 한계:

- 원천이 라이브라 "완전히 닫힌 최신 구간"은 하루 뒤에야 안정됩니다(어제치 값은 시점 의존).
- 스케줄러 상시 구동은 로컬 리소스를 아끼려 검증 후 정지했습니다 — DAG 구조와 스케줄러 e2e 실행은 위에서 확인한 그대로입니다.

코드는 [GitHub](https://github.com/dj258255/dbtower-lakehouse)에 있습니다.

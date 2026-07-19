---
title: '코드보다 데이터 계약을 먼저 쓰고, 조용한 오답을 게이트로 막으며 파이프라인을 지었습니다'
titleEn: 'Writing the Data Contract Before the Code, and Blocking Silent Wrong Answers with a Gate'
description: 'DBTower가 7일 뒤 버리는 쿼리 스냅샷을 컬럼형 저장소로 내려 장기 이력을 만드는 파이프라인을, 짓는 순서대로 담았습니다. DAG를 짜기 전에 무엇을 어떤 계약으로 옮길지부터 못박고, 원천 인덱스 선두를 타는 인스턴스별 등치 질의와 파티션 통째 덮어쓰기로 어제치를 안전하고 멱등하게 내립니다(닫힌 창 재실행에 79,894행 불변). 누적 카운터 raw로는 "느려진 쿼리"에 답할 수 없어, 지문 충돌 12,743키를 SUM으로 접고 하루 양 끝 차분에 리셋 클램프를 걸어 일간 델타로 바꿉니다. 반쪽 파티션 위 랭킹이 조용히 오답을 내는 걸 막으려 reconciliation·completeness·freshness·드리프트 4축 게이트를 다운스트림 앞에 세워 fail-closed로 dbt를 아예 실행하지 않게 했습니다(장애 주입 시 exit 2). 덮어쓰기만으로는 ACID도 타임트래블도 없어 lake일 뿐이라, 카탈로그를 이미 쓰던 PostgreSQL에 두고 데이터는 S3 parquet에 두는 DuckLake를 얹어 과거 버전 복원과 롤백을 실증했습니다. 막았다는 사실을 아무도 모르면 마트가 조용히 낡으니 컨테이너 안 dbt e2e·webhook·retry·CHECKPOINT로 운영을 경화했고, 마지막으로 Metabase가 DuckLake를 read-only로 읽게 해 처음 던진 "지난달 대비 느려진 쿼리"에 화면이 답하게 했습니다. 모든 수치는 직접 측정했습니다.'
descriptionEn: 'The pipeline that offloads DBTower query snapshots into columnar storage for long-term history, told in build order. Before any DAG, the data contract fixes what moves and how; instance-keyed equality queries riding the source index and whole-partition overwrites land yesterday safely and idempotently (79,894 rows invariant on closed-window replay). Cumulative raw cannot answer which query slowed, so 12,743 fingerprint collisions fold via SUM and a first-vs-last daily diff with reset clamp yields daily deltas. To stop rankings built on half-loaded partitions from silently lying, a four-axis gate (reconciliation, completeness, freshness, drift) sits before downstream and fails closed so dbt never runs (exit 2 on injected faults). Overwrites give neither ACID nor time travel, only a lake, so DuckLake with its catalog in the existing PostgreSQL and data as S3 parquet adds version restore and rollback. Since a block no one sees leaves marts to age silently, ops is hardened with in-container dbt e2e, webhooks, retries, and CHECKPOINT, and finally Metabase reads DuckLake read-only so the screen answers the original question about queries slower than last month. Every number was measured firsthand.'
date: 2026-07-11
tags:
  - Data Engineering
  - Airflow
  - dbt
  - DuckDB
  - Metabase
category: personal/lakehouse
coverImage: /uploads/project/lakehouse/cover.svg
draft: false
series: "lakehouse"
seriesOrder: 1
---

이 편은 파이프라인을 짓는 과정 전체를 순서대로 담았습니다. 무엇을 옮길지 계약부터 쓰고, 어제치를 안전하게 내리고, 누적을 일간 델타로 접고, 조용한 오답을 게이트로 막고, lake를 house로 올리고, 운영을 경화한 뒤, 마지막에 화면으로 답이 나오기까지의 일곱 부입니다.

## 1부. 계약부터, DAG를 짜기 전에 무엇을 옮길지부터 못박다

### 0. 코드부터 짜고 싶은 유혹

[0편](/blog/project/lakehouse/lakehouse-0-why)에서 "버려지는 7일을 분석계로 내린다"는 방향을 잡았습니다. 이제 DAG를 짜고 싶었습니다.

참았습니다. 파이프라인의 버그는 대부분 코드에서 나오지 않습니다. **계약 불명확**에서 옵니다.

- dt 경계가 UTC냐 KST냐? (하루가 어긋나면 어제 데이터가 두 파티션에 쪼개집니다.)
- 파티션 키가 뭐냐? (나중에 바꾸면 그동안 쌓은 파일을 못 읽습니다.)
- 스키마가 진화하면 옛 파일은 어떻게 읽냐?
- calls 같은 숫자가 **누적값이냐 구간값이냐?** (이걸 착각하면 2단계의 모든 집계가 조용히 틀립니다.)

이걸 코드로 먼저 굳혀 버리면, 나중에 규칙이 흔들릴 때 backfill이 통째로 깨집니다. 그래서 0단계의 목표는 "돌아가는 DAG" 대신 **계약과 스캐폴드**로 잡았습니다.

### 1. 원천을 코드로 먼저 확인하다

가장 위험한 함정부터. `query_snapshot`의 `calls`·`total_time_ms`가 **누적인지 구간인지**를 단정하지 않고 두 경로로 확인했습니다.

**코드**: DBTower의 `QuerySnapshot` 엔티티 주석이 "쿼리별 **누적 통계** 한 줄"이라 못박고 있고, `ComparisonService`가 시점 비교를 이렇게 합니다.

```java
// 구간 양 끝 배치의 누적 카운터 차분으로 구간 내 발생량을 구한다
long deltaCalls = start == null ? end.getCalls()
                                : Math.max(0, end.getCalls() - start.getCalls());
```

`end - start` 차분에 `Math.max(0, …)` 클램프가 걸려 있습니다. 대상 DB가 재기동돼 카운터가 리셋되면 음수 델타가 나오는데, 그걸 0으로 눌러줍니다. 전형적인 **누적 카운터** 처리입니다.

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

61 → 204 → 348 → … 단조 증가하다가 실행이 없는 구간엔 값이 그대로 유지됩니다. 감소가 없습니다. **누적이 확실합니다.**

다만 **1단계(EL)는 이 판단이 없어도 정확합니다**. 원본을 그대로 parquet로 내리기 때문입니다. 누적→일간 델타 변환은 2단계(dbt)의 몫입니다. 그래서 여기선 "누적이다"라는 **사실만** 계약서(`docs/CONTRACT.md`)에 적어 두고 변환은 뒤로 미룹니다. 확인 안 된 걸 단정하지 않는 게 계약의 핵심입니다.

계약서에 굳힌 규칙은 이렇습니다.

- **파티셔닝**: `s3://lakehouse/raw/query_snapshot/dt=YYYY-MM-DD/instance_id=N/part-000.parquet`
- **포맷**: Parquet + zstd 압축, **스키마 명시 선언**(타입 추론이 흔들려도 파일 스키마는 고정).
- **워터마크**: `data_interval`. `dt` = data_interval_start의 날짜, **UTC 자정 경계**. DBTower가 `captured_at`을 UTC로 저장하므로(hibernate `time_zone=UTC`) 경계도 UTC로 맞춰 KST/DST 흔들림을 없앱니다.
- **경계 조건**: `captured_at >= dt AND captured_at < dt+1` (반열림 구간이라 겹침도 누락도 0).

### 2. LocalExecutor를 고른 이유

Airflow 공식 docker-compose의 기본은 **CeleryExecutor**입니다. Redis 브로커 + 별도 워커 컨테이너가 붙습니다. 일 수만 행짜리 단일 노드 배치에는 과합니다.

그래서 **LocalExecutor**로 갔습니다. 스케줄러 프로세스 안에서 태스크를 병렬 실행하니 Redis도, 워커도 필요 없습니다. 대신 메타DB는 SQLite로는 병렬이 안 되므로 PostgreSQL이 필요합니다. Airflow 전용 PG 하나를 **격리**해서 띄웠습니다. DBTower 메타 PG(원천)와 물리적으로 분리해 관제 DB를 오염시키지 않게 했습니다.

원천 PG와 MinIO는 이미 DBTower 데모 스택에 떠 있습니다. 중복 스택을 만들지 않고 **기존 네트워크를 재사용**했습니다.

```yaml
networks:
  default:
    name: dbtower_default   # DBTower 데모 스택 네트워크
    external: true
```

이러면 Airflow 컨테이너가 `dbtower-postgres:5432`·`dbtower-minio:9000`으로 바로 붙습니다. 추가 런타임 패키지(pyarrow·psycopg2·boto3·duckdb)는 이미지 재빌드 없이 `_PIP_ADDITIONAL_REQUIREMENTS`로 얹었습니다.

#### start_date와 @daily 정렬이라는 함정

Airflow의 data interval은 초심자가 한 번은 밟는 지뢰입니다. `@daily`는 자정 경계로 도는데, `start_date`를 자정이 아닌 시각(예: 09:30)으로 두면 첫 인터벌이 어긋나 "언제 무슨 날짜가 도는지"부터 헷갈립니다. 그래서 자정으로 못박았습니다.

```python
@dag(
    schedule="@daily",
    start_date=pendulum.datetime(2026, 7, 3, tz="UTC"),  # @daily 경계(자정)에 정렬
    catchup=False,          # 무의도 대량 백필 방지
    max_active_runs=1,      # 동시 런 상한
)
```

`catchup=False`는 시작하자마자 과거 전체를 백필하는 사고를 막습니다. `max_active_runs=1`과 태스크 단위 `max_active_tis_per_dag=1`은, 나중에 backfill을 돌릴 때 수백 태스크가 동시에 떠 스케줄러를 짓누르는 걸 막는 상한입니다.

### 3. 정말 뜨는지 확인하다

```
$ docker compose up -d
$ docker exec ... airflow dags list-import-errors
No data found                         # 임포트 에러 0

$ docker exec ... airflow dags list
snapshot_offload | .../snapshot_offload.py | airflow | True
```

DAG가 임포트 에러 없이 목록에 뜹니다. MinIO health는 200, Airflow 웹서버는 `:8080`에 올라옵니다.

![Airflow UI에서 snapshot_offload DAG가 임포트 에러 없이 목록에 뜬다(태그 el·extract·lakehouse, @daily)](/uploads/project/lakehouse/airflow-dag.png)

DAG는 떴지만 아직 껍데기입니다.

### 4. 아직 데이터는 안 흐른다

0단계는 여기까지입니다. 계약이 서고 스캐폴드가 떴지만, **아직 한 줄도 안 옮겼습니다.** DAG는 껍데기고, MinIO 버킷은 비어 있습니다.

2부에서 그 껍데기에 실제 추출·적재 로직을 넣습니다. 마주칠 함정도 하나 예고해 둡니다. DBTower의 인덱스는 `(instance_id, captured_at)` 순서라, `captured_at` 단독 조건으로 뽑으면 인덱스 선두를 못 탑니다. 관제탑을 느리게 하지 않으면서 어제치를 안전하게 내리는 방법이 이어지는 2부의 주제입니다.

여기까지가 계약과 스캐폴드를 세운 1부입니다. 이제 그 껍데기에 실제 데이터를 흘립니다.

## 2부. 어제치를 안전하게 내리다, 인덱스 선두를 타는 Extract & Load

### 0. 6일 남은 데이터

어제 자정이 지났습니다. 어제 쌓인 스냅샷은 이제 **6일 남았습니다**. DBTower가 7일 뒤 지우기 때문입니다. 6일 안에 안전하게 MinIO로 내려야 합니다.

"안전하게"에 두 가지 뜻이 있습니다.

1. **관제탑에 부하를 주지 않기.** 추출 쿼리가 메타 PG를 느리게 하면, 관제 도구를 관제하다 관제를 망가뜨리는 자기모순입니다.
2. **멱등하기.** 같은 날짜를 두 번 돌려도 결과가 같아야 backfill과 재시도가 안전합니다.

### 1. 인덱스 선두를 못 타는 조건

가장 순진한 추출은 이겁니다.

```sql
SELECT ... FROM query_snapshot
WHERE captured_at >= ? AND captured_at < ?   -- 어제 하루
```

그런데 DBTower의 인덱스는 이렇게 생겼습니다.

```java
@Index(name = "idx_snapshot_instance_time", columnList = "instanceId, capturedAt")
```

복합 인덱스 `(instance_id, captured_at)`의 **선두는 instance_id**입니다. `captured_at` 단독 조건은 선두 컬럼을 건너뛰므로 이 인덱스를 제대로 못 탑니다. 최악의 경우 풀스캔에 가까워집니다. 50만 행짜리 관제 DB에서 이건 그대로 부하가 됩니다. (DBTower 자신의 하드닝 감사에서 이미 지적된 실제 제약입니다.)

**판단**: 원천 인덱스를 함부로 바꾸지 않습니다(관제탑을 건드리는 최후 수단). 대신 **인스턴스별로 루프를 돌아** 등치 조건을 선두에 놓습니다.

```sql
SELECT ... FROM query_snapshot
WHERE instance_id = ?                          -- 선두 컬럼 등치 → 인덱스 탐
  AND captured_at >= ? AND captured_at < ?     -- 두 번째 컬럼 범위
ORDER BY captured_at
```

훑을 인스턴스 목록은 `query_snapshot`을 DISTINCT 스캔하지 않고(그 자체가 선두를 못 탑니다) 레지스트리 테이블 `database_instance`에서 가져옵니다.

부하를 더 눌렀습니다.

- **읽기 전용 세션.** `conn.set_session(readonly=True)`로 세션 레벨에서 쓰기를 원천 차단합니다. "운영을 안 건드린다"를 코드에 맡기지 않고 트랜잭션이 보장하게 합니다.
- **서버커서**로 나눠 읽습니다. named cursor에 `itersize=50000`을 걸어 결과 전체를 클라이언트 메모리에 올리지 않습니다.

### 2. 명시 스키마와 멱등 덮어쓰기

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

같은 날짜를 몇 번 돌려도 인스턴스당 오브젝트는 항상 1개, 행수는 원천과 동일합니다. 부분 실패로 낡은 파일이 남아 중복되는 일이 구조적으로 없습니다.

포맷은 계약대로 zstd로 압축한 Parquet입니다. 경로는 Hive 스타일이라 DuckDB가 `dt`·`instance_id`를 컬럼으로 직독합니다.

### 3. 원천 = parquet = DuckDB 대조

Airflow 없이도 e2e가 도는 게 중요합니다(핵심 로직이 `extract/offload.py`에 독립적으로 있고, DAG는 이걸 감쌀 뿐). 원천 DB의 시계 기준으로 완전히 닫힌 구간(dt=2026-07-06)을 호스트에서 직접 돌렸습니다.

```
$ python -m extract.offload 2026-07-06
instance 1: 18551행 → s3://lakehouse/.../instance_id=1/part-000.parquet
instance 2: 17743행 → ...
instance 3: 20158행 → ...
...
적재 완료 dt=2026-07-06 총 79894행
```

적재된 dt 파티션은 MinIO 콘솔에서 이렇게 보입니다. `raw/query_snapshot` 아래 날짜별로 갈리고

![MinIO 콘솔에서 raw/query_snapshot 아래로 갈린 dt 파티션](/uploads/project/lakehouse/minio-console.png)

그 한 날짜를 열면 인스턴스별 파티션으로 다시 갈립니다(Hive 스타일).

![MinIO에 적재된 parquet 파티션 트리로, dt 아래 instance_id별로 분할된다](/uploads/project/lakehouse/minio-parquet.png)

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

![닫힌 두 구간에서 원천 PG = parquet(S3)로 맞아떨어진 verify_count 실행 결과](/uploads/project/lakehouse/duckdb-count.png)

#### 닫힌 구간을 두 번 돌린 멱등성

여기서 정직하게 짚을 게 있습니다. 원천 DBTower는 지금도 살아서 수집 중입니다. 그래서 **원천 DB의 시계 기준 '오늘'(dt=2026-07-07)은 열린 창**입니다. 세어 볼 때마다 값이 달라집니다(한때 269,354였다가 뒤에 279,002로 자라 있었습니다). 열린 창을 스냅샷하면 그 순간의 값을 찍을 뿐이라, 행수 일치나 멱등성을 이 창으로 검증하면 안 됩니다. 그래서 **검증은 완전히 닫힌 과거 구간**(07-05·07-06)으로만 합니다. 아래는 닫힌 dt=2026-07-06을 두 번 돌린 결과입니다.

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

DAG가 목록에 뜨는 것까지 확인한 다음, 스케줄러가 부른 태스크가 실제로 흐르는지 `airflow dags test`로 점검했습니다.

```
$ airflow dags test snapshot_offload 2026-07-06
created dagrun ... data_interval_start=2026-07-05
offload.py: 적재 완료 dt=2026-07-05 총 149259행
Marking task as SUCCESS
```

여기서 재밌는 게 보입니다. 논리 실행일 `2026-07-06`의 `data_interval_start`는 **2026-07-05**라, 태스크가 처리한 건 dt=2026-07-05입니다. 즉 "어제"를 정확히 집었습니다. 0단계에서 start_date를 @daily 자정에 정렬해 둔 게 이렇게 맞아떨어집니다. 이 파티션도 원천 149,259 = DuckDB 149,259로 일치했습니다.

![snapshot_offload 태스크가 SUCCESS로 끝난 Airflow 성공 런](/uploads/project/lakehouse/airflow-run-success.png)

### 4. raw는 아직 질문에 못 답한다

parquet는 내려왔지만, 이 raw는 **아직 "지난달보다 느려진 쿼리"에 답하지 못합니다.** calls/total_time_ms가 누적값이라, 그대로 더하면 의미가 없습니다. 일간 델타로 바꿔야 하는데, 그게 이 편 3부의 dbt 변환입니다.

그리고 하나 더. 어느 날 특정 인스턴스의 파티션이 수집 장애로 비면, 그 위에 만든 랭킹은 조용히 오답을 냅니다. 지금은 그걸 잡을 게 없습니다. 품질 게이트는 뒤에서 세웁니다.

정직하게 남기는 한계:

- 원천이 라이브라 "완전히 닫힌 최신 구간"은 하루 뒤에야 안정됩니다(어제치 값은 시점 의존).
- 스케줄러 상시 구동은 로컬 리소스를 아끼려 검증 후 정지했습니다. DAG 구조와 스케줄러 e2e 실행은 위에서 확인한 그대로입니다.

코드는 [GitHub](https://github.com/dj258255/dbtower-lakehouse)에 있습니다.


## 3부. 누적 스냅샷을 일간 델타로: 가짜 리셋을 걷어내고 답하기

### 0. 내려는 놨는데 여전히 못 답하는 상황

어제치 스냅샷은 MinIO에 내렸는데, 정작 이 프로젝트가 존재하는 이유였던 질문, 곧 **"지난 구간보다 느려진 쿼리 있어?"** 앞에서는 raw가 여전히 침묵합니다. 앞의 2부에서 원천 = parquet = DuckDB 3자 일치까지 확인한 상태인데도 그렇습니다.

이유는 컬럼 두 개에 있습니다.

```
calls          누적 호출수 (서버 기동 이후 단조 증가 카운터)
total_time_ms  누적 총 실행시간 (구간값 아님)
```

`calls`를 그냥 `SUM`하면 무슨 일이 벌어지는지 봅시다. 하루에 스냅샷이 인스턴스당 수백 번 찍힙니다(실측 256~813회). 매 스냅샷마다 "지금까지 누적 302회"가 반복 기록됩니다. 그걸 다 더하면 302를 수백 번 더한, 아무 의미 없는 수가 나옵니다. 하루의 실제 발생량은 **차분**해야 합니다. 하루 끝 누적에서 하루 시작 누적을 뺀 값입니다.

이건 DBTower가 이미 하던 것입니다. `ComparisonService`가 두 시점을 비교할 때:

```java
long delta = Math.max(0, end.getCalls() - start.getCalls());
```

`end - start`로 구간을 구하고 `Math.max(0, …)`로 감싸 음수를 0으로 누릅니다. **왜 음수가 나오냐**가 이 편의 진짜 함정입니다.

### 1. 시간순으로 늘어놓으면 감소가 섞이는 함정

누적 카운터는 단조 증가여야 합니다. 그러니 하루 안에서 시간순 정렬하면 302, 303, 305, … 처럼 계속 오르기만 해야 정상입니다. 그런데 한 쿼리를 실제로 뽑아 보면 이렇습니다.

```
captured_at                   calls
2026-07-07 00:00:18.340565    302
2026-07-07 00:00:18.340565     55
2026-07-07 00:01:18.470229    302
2026-07-07 00:01:18.470229     56
2026-07-07 00:02:11.143368    302
2026-07-07 00:02:11.143368     56
...
```

302과 55가 번갈아 나옵니다. 인접 차분을 하면 302→55는 **-247**, 다음은 55→302로 **+247**. 하루에 이런 가짜 감소가 수백 번씩 잡혔습니다(전체 32,946건).

카운터 리셋(대상 DB 재기동)인가 싶었지만 같은 `captured_at`에 두 행이 있다는 게 이상했습니다. 파고들었더니:

```
id      calls  total_time_ms  query_text
382469    302        19.6588  SHOW REPLICA STATUS
382471     55         5.2660  SHOW REPLICA STATUS
```

**같은 `query_id`(지문 해시), 같은 `query_text`인데 누적값이 다른 두 계열**이 한 순간에 공존합니다. 지문 충돌입니다. `id`는 다르지만 `id`는 스냅샷마다 새로 발번되는 전역 PK라 계열 식별자가 못 됩니다. 이런 (instance_id, query_id, captured_at) 중복이 **12,743키** 있었습니다.

즉 감소의 정체는 리셋이 아니었습니다. **두 누적 계열이 한 지문 아래 얽혀 시간순으로 지그재그**한 것이었습니다. 이걸 안 풀고 인접 차분을 하면 델타가 통째로 오염됩니다.

### 2. 합쳐서 단조를 복원하고 양 끝만 보는 판단

두 함정에 각각 답이 필요합니다.

**얽힌 계열(함정 A)**: staging에서 `captured_at`별로 누적값을 **SUM**합니다. 핵심은 이겁니다. *단조 비감소 계열들의 합도 단조 비감소*라는 겁니다. 302 계열과 55 계열을 더하면 357, 358, 360, … 으로 다시 깔끔하게 증가하는, 지문 단위 '총 활동'의 누적 계열이 복원됩니다. 서로 다른 물리 쿼리를 하나로 합치는 근사이긴 하지만 지문이 같은 이상 이게 정직하게 낼 수 있는 최선의 그레인입니다.

**차분 방식(함정 B)**: 하루 **first-vs-last**(양 끝 차분)를 택했습니다. `GREATEST(0, 마지막_누적 - 처음_누적)`. DBTower `ComparisonService`의 `Math.max(0, end - start)`와 정확히 같은 원리라, 나중에 DBTower 화면의 시점 비교와 교차검증까지 됩니다.

여기서 갈림길이 하나 있었습니다. 인접 스냅샷의 양의 델타를 전부 합산하는 방식(Prometheus `rate()`가 카운터 리셋을 다루는 그 방식)도 후보였습니다. 하루 중 리셋이 일어나도 리셋 이후 증가분을 살린다는 장점이 있습니다. 그런데 실측해 보니:

```
인접 양의 델타 합산 : 총 delta_calls = 22,264,704
first-vs-last       : 총 delta_calls =  3,126,579
```

7배 넘게 부풀었습니다. 원인은 앞의 SUM 집계와 상호작용입니다. 어떤 쿼리가 스냅샷 사이에 잠깐 보고되지 않으면 합계가 뚝 떨어졌다가, 다시 나타나면 확 오릅니다. 인접 델타 합산은 그 **유령 재등장**을 활동으로 과대계상합니다. 반면 first-vs-last는 하루 양 끝만 보므로 중간 출렁임에 흔들리지 않습니다. DBTower 정식 로직과의 정합까지 고려해 first-vs-last를 택했습니다.

리셋 클램프는 여전히 필요합니다. SUM으로 얽힘을 푼 뒤에도 하루 `last < first`인 **순리셋 그레인이 219개** 남았습니다(진짜 재기동이거나 종일 간헐 보고). 거기서 `GREATEST(0, …)`가 음수를 0으로 눌러 줍니다.

### 3. dbt 3계층으로 개선하기

#### staging에서 얽힘을 접는다

```sql
-- models/staging/stg_query_snapshot.sql (view)
select
    instance_id,
    query_id,
    cast(dt as date)   as dt,
    captured_at,
    sum(calls)         as calls,          -- 지문 충돌·중복 계열을 합산으로 접는다
    sum(total_time_ms) as total_time_ms,  -- 단조 계열의 합도 단조
    sum(rows_examined) as rows_examined,
    max(query_text)    as query_text
from {{ source('raw', 'query_snapshot') }}
group by instance_id, query_id, cast(dt as date), captured_at
```

소스는 dbt-duckdb의 `external_location`으로 MinIO parquet에 직결됩니다. httpfs·s3 설정은 프로파일에서 로드됩니다.

```yaml
# models/sources.yml
sources:
  - name: raw
    meta:
      external_location: >-
        read_parquet(
          's3://lakehouse/raw/query_snapshot/dt=*/instance_id=*/*.parquet',
          hive_partitioning = 1
        )
```

#### marts에서 차분하고 클램프한다

```sql
-- models/marts/fct_query_daily.sql (table)
with endpoints as (
    select
        instance_id, query_id, dt, query_text, calls, total_time_ms,
        row_number() over (partition by instance_id, query_id, dt order by captured_at asc)  as rn_first,
        row_number() over (partition by instance_id, query_id, dt order by captured_at desc) as rn_last
    from {{ ref('stg_query_snapshot') }}
),
diffed as (
    select
        instance_id, query_id, dt,
        any_value(query_text)                              as query_text,
        max(case when rn_first = 1 then calls end)         as first_calls,
        max(case when rn_last  = 1 then calls end)         as last_calls,
        max(case when rn_first = 1 then total_time_ms end) as first_time_ms,
        max(case when rn_last  = 1 then total_time_ms end) as last_time_ms
    from endpoints
    group by instance_id, query_id, dt
)
select
    instance_id, query_id, dt, query_text,
    greatest(0, last_calls   - first_calls)   as delta_calls,          -- 리셋 클램프
    greatest(0, last_time_ms - first_time_ms) as delta_total_time_ms,
    greatest(0, last_time_ms - first_time_ms)
        / nullif(greatest(0, last_calls - first_calls), 0) as avg_latency_ms
from diffed
```

그 위에 0편의 질문에 답하는 마트를 얹습니다. 인스턴스+쿼리별로 첫 활동일 대비 마지막 활동일 평균 지연을 비교해 악화 순으로 정렬합니다(`mart_query_regression`). 잡음이 큰 지문을 거르려고 `delta_calls`가 100 미만이면 비교에서 뺐습니다.

#### 누적 카운터라 delta는 음수일 수 없다는 테스트

스키마 테스트(not_null·relationships) 외에, 이 도메인에만 있는 불변식을 singular 테스트로 박았습니다.

```sql
-- tests/assert_fct_delta_non_negative.sql
-- GREATEST(0, ...) 클램프가 살아 있으면 0행이어야 한다.
select * from {{ ref('fct_query_daily') }}
where delta_calls < 0 or delta_total_time_ms < 0
```

그레인 유일성(`assert_stg_grain_unique`, `assert_fct_grain_unique`)도 같은 방식으로 검증합니다.

### 4. dbt run/test와 마트가 답한 질문을 실측하다

한 가지 정직하게 짚을 것. 호스트 `.venv`가 python3.14였는데 dbt-core 1.11이 그 위에서 직렬화 오류로 아예 뜨질 않았습니다. `.venv`를 python3.12로 재구성하고 추출 의존성까지 동일 버전으로 다시 깔아 해결했습니다(`dbt-duckdb 1.10.1`).

```
$ .venv/bin/dbt run --profiles-dir .
  1 of 3 OK view  main.stg_query_snapshot ...... [OK 0.06s]
  2 of 3 OK table main.fct_query_daily ......... [OK 0.27s]
  3 of 3 OK table main.mart_query_regression ... [OK 0.02s]
  Done. PASS=3 WARN=0 ERROR=0 SKIP=0 TOTAL=3

$ .venv/bin/dbt test --profiles-dir .
  Done. PASS=18 WARN=0 ERROR=0 SKIP=0 TOTAL=18
```

테스트 18개(not_null 14 + relationships 1 + 커스텀 3) 전부 통과. 그중 `assert_fct_delta_non_negative`가 통과했다는 건 **리셋 클램프가 실제로 동작해 음수 델타가 하나도 없다**는 뜻입니다. `fct_query_daily.delta_calls` 최솟값을 직접 세도 0이었습니다. 순리셋 219그레인이 조용히 0으로 눌린 겁니다.

![dbt run/test 통과와 마트 질의 실제 출력](/uploads/project/lakehouse/dbt-mart-result.png)

이제 0편의 질문에 마침내 답합니다. `mart_query_regression`을 악화 순으로 뽑으면(07-05 → 07-07 평균 지연):

| inst | 쿼리 | first_ms | last_ms | +ms | +% |
|---|---|---|---|---|---|
| 8 (Oracle) | `SELECT sql_id, MAX(SUBSTR(sql_text…` | 25.89 | 64.50 | **+38.61** | +149% |
| 4 (메타 PG) | `select qs1_0.id,qs1_0.calls,…` | 19.52 | 38.30 | +18.78 | +96% |
| 1 (MySQL) | ``SELECT `p`.`ID` AS `pid`,…`` | 1.05 | 2.19 | +1.14 | +109% |

"instance 8의 Oracle 쿼리가 이틀 새 평균 25.9ms에서 64.5ms로, **149% 느려졌다.**" raw만으로는 못 냈을 답입니다. 4번 인스턴스는 따로 볼 만합니다. DBTower가 자기 메타 PG에 던지는 스냅샷 적재/조회 쿼리입니다(`qs1_0`은 하이버네이트 별칭). **파이프라인이 준 부하를 파이프라인이 관측하는 도그푸딩**이 데이터로도 드러났습니다.

#### 계보(lineage)

`dbt docs generate` 후 계보 그래프입니다. source에서 마트까지, 그리고 커스텀 테스트가 어디에 걸리는지 한눈에 보입니다.

![raw.query_snapshot에서 stg, fct, mart_query_regression까지 이어지는 dbt lineage](/uploads/project/lakehouse/dbt-lineage.png)

`raw.query_snapshot`(초록 소스) → `stg_query_snapshot` → `fct_query_daily` → `mart_query_regression`으로 흐르고, fct에서 검증 테스트 세 갈래가 갈라집니다.

### 5. 아직 남은 정직한 한계

- **지문 충돌 근사**: SUM으로 얽힌 계열을 접은 건 서로 다른 물리 쿼리를 한 지문으로 합치는 근사입니다. `id`로 계열을 온전히 분리하진 못합니다(스냅샷마다 새 `id`). "지문 단위 총 활동"이 낼 수 있는 그레인의 상한입니다.
- **first-vs-last의 손실**: 하루 중 리셋이 나면 재상승분을 일부 잃습니다(219그레인). DBTower 정식 로직과의 정합을 우선해 감수했고 잃는 양은 클램프된 그레인 수로 계량해 뒀습니다. 인접 델타 합산은 반대로 과대계상하니, 둘 다 틀린 방향이 다를 뿐 온전하진 않습니다.
- **품질 게이트 없음**: 어느 날 한 인스턴스 파티션이 수집 장애로 비면, 그 위 랭킹은 조용히 오답을 냅니다. 지금은 그걸 잡을 게 없습니다. freshness·빈 파티션 검증과 알림은 이어지는 2부입니다.
- **구간이 짧다**: 아직 3일치(07-05~07)만 적재돼 사실상 이틀 비교입니다. "지난달" 규모의 추세는 적재가 쌓인 뒤에.

그래도 이 편에서 raw가 처음으로 질문에 답했습니다. 다음은 이 답을 **믿어도 되는지**를 지키는 품질 게이트입니다.

코드는 [GitHub](https://github.com/dj258255/dbtower-lakehouse)에 있습니다.

## 4부. 실패해야 하는 파이프라인: 조용한 오답을 막는 품질 게이트

### 0. 답은 나오는데 믿어도 되는지는 아무도 안 지키는 상황

1부에서 raw가 처음으로 질문에 답했습니다. "instance 8의 Oracle 쿼리가 이틀 새 25.9ms에서 64.5ms로 149% 느려졌다" 같은 답이 마트에서 나왔습니다. 그런데 거기엔 조용한 전제가 하나 깔려 있었습니다. **그 밑의 raw가 온전하다**는 전제입니다.

한 상황을 가정해 봅시다. 어느 날 새벽, 특정 인스턴스의 어제 파티션이 수집 장애로 비었습니다. 오브젝트가 아예 안 올라왔거나, 절반만 올라왔거나. 그 위에서 dbt는 아무 불평 없이 돌아갑니다. 마트는 "악화 쿼리 랭킹"을 여전히 뱉어냅니다. 다만 그 랭킹은 이제 **빠진 인스턴스를 뺀 채 계산된, 조용히 틀린 답**입니다. dbt run은 초록불, 테스트도 초록불. 아무도 모릅니다.

이건 DBTower 시리즈 내내 지켰던 원칙, **"못 하는 것은 못 한다고"**의 데이터판입니다. 데이터가 반쪽이면, 반쪽인 채로 답을 내지 말고 **멈춰야** 합니다. 조용히 틀린 데이터는 없는 것보다 나쁩니다. 없으면 "데이터 없음"이라고 답하지만, 반쪽이면 그럴듯한 오답을 자신 있게 냅니다.

그래서 이 편은 **파이프라인이 실패하게 만드는** 장치를 답니다.

### 1. 반쪽 적재는 dbt가 잡아주지 않는다는 함정

dbt에도 테스트가 있습니다(1부에서 18개 통과시켰습니다). 하지만 dbt test는 not_null, unique, 참조 무결성처럼 **이미 로드된 데이터 안의 관계**를 검증합니다. "parquet에 있어야 할 인스턴스가 통째로 안 왔다"는 건 dbt가 보는 세계 밖의 일입니다. 없는 행은 not_null을 위반하지 않습니다. 없기 때문입니다.

세 가지 반쪽이 특히 조용합니다.

```
빈 파티션      한 인스턴스의 dt 파티션이 아예 안 올라옴 → 그 인스턴스만 랭킹에서 증발
행수 불일치     원천 PG엔 20,158행인데 parquet엔 12,000행만 → 부분 적재, 델타가 축소
freshness 붕괴  수집이 낮 12시에 끊김 → 하루 절반만 담긴 파티션을 '하루'로 취급
```

세 경우 모두 dbt run은 성공합니다. 마트도 틀린 채로 나옵니다. 그러니 검문은 **dbt 이전에, raw 파티션 자체를 상대로** 해야 합니다.

### 2. 다운스트림 앞에 검문소를 세워 FAIL이면 막는 판단 (fail-closed)

핵심 결정은 **fail-closed**입니다. 게이트가 통과를 확신하지 못하면 다운스트림을 진행시키지 않습니다. 기본값이 "차단"입니다. 반대(fail-open, 의심스러워도 일단 진행)는 조용한 오답을 그대로 통과시키기 때문입니다.

검문은 세 축입니다. 각각 이미 아는 사실 하나씩과 대조합니다.

**reconciliation(정합)**은 원천 PG의 그 dt 행수와 parquet 행수가 인스턴스별로 정확히 같은지 봅니다. 앞의 2부에서 만든 `verify_count`(원천=적재 대조)를 이 게이트로 흡수했습니다. 불일치가 하나라도 있으면 유실·중복·부분 적재 중 하나이므로 FAIL입니다.

**completeness(완결성)**는 레지스트리(`database_instance`)에 등록된 인스턴스가 그 dt 파티션에 **전부** 존재하는지 확인합니다. 빈 파티션·수집 누락을 잡는 축입니다. 하나라도 빠지면 FAIL.

**freshness(신선도)**는 그 dt의 최신 `captured_at`이 다음날 00:00 경계에 충분히 근접한지 따집니다. 수집이 하루 중간에 끊기면 최신 시각이 경계에서 멀어집니다. 기본 임계는 3시간 초과 WARN, 12시간 초과 FAIL로 뒀습니다. freshness만 WARN 단계를 둔 건, 늦게 한 번 끊긴 것과 하루 절반이 빈 것은 심각도가 다르기 때문입니다(dbt test의 warn/error 이원화와 같은 발상).

WARN은 통과시키되 기록합니다. FAIL만 막습니다.

### 3. 게이트 모듈과 오케스트레이션으로 개선하기

#### 게이트 (`extract/quality.py`)

dt마다 세 검문을 돌려 `OK`/`WARN`/`FAIL`을 매기고, dt 판정은 그중 가장 나쁜 값으로 접습니다. FAIL이 하나라도 있으면 `blocked`.

```python
def check_reconciliation(pg: dict[int, int], pq: dict[int, int]) -> CheckResult:
    """원천 PG == parquet 행수(인스턴스별). 하나라도 어긋나면 FAIL."""
    mismatches = []
    for iid in sorted(set(pg) | set(pq)):
        p, q = pg.get(iid, 0), pq.get(iid, 0)
        if p != q:
            mismatches.append(f"inst {iid}: PG {p:,} != parquet {q:,}")
    if mismatches:
        return CheckResult("reconciliation", FAIL, "; ".join(mismatches))
    return CheckResult("reconciliation", OK, f"PG=parquet={sum(pg.values()):,}행")

def check_completeness(registry: list[int], pq: dict[int, int]) -> CheckResult:
    """레지스트리 기대 인스턴스가 파티션에 전부 존재하는가. 빠지면 FAIL."""
    present = {iid for iid, n in pq.items() if n > 0}
    missing = [iid for iid in registry if iid not in present]
    if missing:
        return CheckResult("completeness", FAIL, f"누락 {missing}")
    return CheckResult("completeness", OK, f"기대 {len(registry)}인스턴스 전부 존재")
```

parquet 행수는 DuckDB `read_parquet(..., hive_partitioning=1)`로 인스턴스별 `count(*)`를 세고, PG는 같은 UTC 하루창으로 `group by instance_id`를 셉니다. 파티션이 통째로 없어 glob이 아무 파일과도 안 맞으면 DuckDB가 `IOException`을 던지는데, 이걸 잡아 "파티션 전무(빈 dict)"로 해석합니다. 그러면 completeness가 전 인스턴스 누락으로 잡습니다.

#### 게이트를 dbt 앞에 두는 오케스트레이션 (`extract/run_pipeline.py`)

fail-closed의 실체는 여기입니다. 게이트가 막으면 **dbt를 아예 호출하지 않습니다.**

```python
reports = evaluate(days)
print_report(reports)

if any(r.blocked for r in reports):
    print("SKIPPED — 게이트 FAIL. dbt를 실행하지 않는다(fail-closed).")
    return 2                      # dbt 미실행, 종료코드 2

# 여기까지 왔다 = 모든 dt 통과
subprocess.run([sys.executable, "-m", "dbt.cli.main", "run", "--profiles-dir", "."], cwd=DBT_DIR)
```

#### Airflow에서 태스크 의존성으로 같은 계약을 건다

DAG를 `offload → quality_gate → transform`으로 확장했습니다. `quality_gate` 태스크는 게이트를 돌리고 FAIL이면 예외를 던집니다. 그러면 Airflow가 이 태스크를 failed로 표시하고, 의존하는 `transform`은 **upstream_failed**가 되어 실행되지 않습니다.

```python
@task(retries=0)  # 품질 FAIL은 결정적이다 — 재시도해도 그대로 FAIL이므로 즉시 차단한다.
def quality_gate(offload_result: dict) -> dict:
    from extract.quality import assert_gate
    assert_gate([offload_result["dt"]])   # FAIL이면 RuntimeError → 태스크 실패 → transform 차단
    return {"dt": offload_result["dt"], "gate": "PASS"}

transform(quality_gate(offload()))
```

`retries=0`은 의도한 설계입니다. 재시도는 일시적 장애(네트워크 등)를 회복할 때 의미가 있는데, 품질 FAIL은 **결정적**입니다. 같은 파티션을 다시 검문해도 똑같이 FAIL이기 때문입니다. 무의미한 5분×2회 대기 없이 즉시 downstream을 막습니다.

### 4. 통과, 그리고 일부러 깨뜨려 보는 실측

#### 정상일 때 3개 dt 전부 통과

```
$ python -m extract.quality 2026-07-05 2026-07-06 2026-07-07
2026-07-05  reconciliation OK  PG=parquet=149,259행 (6인스턴스)
            completeness   OK  기대 6인스턴스 전부 존재
            freshness      OK  최신 23:59:30, 경계까지 0.0h
2026-07-06  ... PG=parquet=79,894행 ...  freshness OK 최신 23:58:47
2026-07-07  ... PG=parquet=279,002행 ... freshness OK 최신 23:04:30, 경계까지 0.9h  (진행 중인 오늘)
GATE: PASS — 모든 dt 통과 → 다운스트림 진행 가능
```

여기서 하나 짚고 가야 합니다. dt=2026-07-07은 **원천 DB의 시계 기준 아직 진행 중인 '오늘'**입니다(원천 `now()`가 07-07 23시대). 그래서 값이 계속 자랍니다(268,952 → 269,354 → 279,002). 재적재 직후 그 순간엔 PG=parquet로 맞지만 열린 창이라 다음 순간 또 벌어질 수 있습니다. 실제로 freshness가 07-07만 '경계까지 0.9h'로 뜨는 게 바로 **아직 안 닫힌 날**이라는 신호입니다. 그래서 게이트의 안정 통과 근거는 닫힌 창(07-05·07-06)에 둡니다. 149,259·79,894는 몇 번을 세도 불변이기 때문입니다.

#### instance 3의 파티션을 지우는 장애 주입

dt=2026-07-06에서 `instance_id=3` 파티션(20,158행)을 MinIO에서 통째로 삭제했습니다. 수집 장애로 한 인스턴스가 통째로 빠진 상황입니다. 그리고 파이프라인을 돌립니다.

```
$ python -m extract.run_pipeline 2026-07-05 2026-07-06 2026-07-07
2026-07-06  reconciliation FAIL  총 PG 79,894 vs parquet 59,736 — inst 3: PG 20,158 != parquet 0
            completeness   FAIL  기대 6인스턴스 중 누락 [3] (존재 [1, 2, 4, 7, 8])
            freshness      OK    최신 23:58:47, 경계까지 0.0h
GATE: BLOCKED — FAIL 파티션 ['2026-07-06'] → dbt 미실행(fail-closed)
=== 2) dbt ===
SKIPPED — 게이트 FAIL. dbt를 실행하지 않는다(fail-closed).   (exit code 2)
```

두 축이 동시에 잡았습니다. reconciliation은 20,158행이 사라진 걸(79,894 → 59,736), completeness는 인스턴스 3이 목록에서 빠진 걸. 그리고 나머지 dt는 멀쩡하니 통과합니다. **문제 있는 dt만** 막는 것입니다. dbt는 실행되지 않았고 종료코드는 2입니다.

![품질 게이트 정상 통과와 장애주입 FAIL 실제 출력](/uploads/project/lakehouse/quality-gate.png)

#### Airflow에서도 같은 차단

Airflow DAG에서도 같은 계약을 확인했습니다. freshness FAIL 임계를 0.5h로 조여 07-07(경계까지 0.9h)을 강제로 FAIL시킨 `airflow dags test`의 태스크 상태입니다.

```
$ airflow tasks states-for-dag-run snapshot_offload 2026-07-08
offload       success
quality_gate  failed            # 게이트가 raise → 태스크 실패
transform     upstream_failed   # 게이트 실패로 실행되지 않음
```

그래프로 보면 offload(초록 success) → quality_gate(빨강 failed) → transform(주황 upstream_failed)으로, 게이트가 변환을 실제로 막고 있는 게 그대로 찍혀 있습니다.

![quality_gate 실패가 transform을 upstream_failed로 막는 Airflow 그래프](/uploads/project/lakehouse/quality-gate-dag.png)

#### 원상복구

시연이 끝나고 `python -m extract.offload 2026-07-06`으로 재적재했습니다. 파티션 통째 덮어쓰기(앞 2부의 멱등성)라 인스턴스 3이 그대로 복원되고 게이트를 다시 돌리니 3개 dt 전부 PASS로 돌아왔습니다. 리포에는 정상 상태만 남습니다.

### 5. 아직 남은 정직한 한계

- **규칙 기반까지입니다.** 정합·완결성·freshness는 명시적 규칙으로 잡지만, "행수는 맞는데 값이 이상하다"류의 통계적 이상(분포 급변 등)은 이 게이트가 못 봅니다. 그건 다른 층의 일이고, 여기선 범위 밖으로 뒀습니다.
- **알림 발화는 아직입니다.** 게이트는 FAIL로 다운스트림을 막지만, 그 사실을 사람에게 밀어 보내는 웹훅(DBTower의 Discord 채널 재사용 같은)은 붙이지 않았습니다. 지금은 종료코드와 태스크 상태로만 드러납니다.
- **freshness는 dt 파티션 전체 기준입니다.** 그날 일부 인스턴스만 일찍 끊겨도 다른 인스턴스가 경계까지 수집했으면 dt-level로는 OK가 됩니다(07-07이 그랬습니다). 인스턴스별 freshness는 더 촘촘하지만, 그만큼 오탐도 늘어 지금은 dt 단위로 뒀습니다.
- **Airflow의 transform은 얇습니다.** 컨테이너엔 dbt를 얹지 않아, 실제 dbt 빌드는 호스트의 `run_pipeline`에서 실측합니다. Airflow가 증명하는 건 "게이트 통과가 전제여야 변환이 시작된다"는 오케스트레이션 계약이고, 실제 dbt를 막는 것은 `run_pipeline`으로 보였습니다.

1부에서 raw가 처음 답을 냈다면, 이 2부에선 그 답을 **믿어도 되는지**를 지키는 문지기를 세웠습니다. 다음은 이 lake에 ACID·타임트래블·스키마 진화를 얹어 진짜 lakehouse로 만드는 테이블 포맷입니다.

코드는 [GitHub](https://github.com/dj258255/dbtower-lakehouse)에 있습니다.


## 5부. lake를 house로: 카탈로그를 PostgreSQL에 두는 DuckLake

### 0. 상황: 지금까지 만든 건 엄밀히 lake다

여기까지 파이프라인은 제법 갖춰졌습니다. 원천에서 추출하고(1~2부), dbt로 변환하고 반쪽 데이터를 막는 문지기까지 세웠죠(3~4부). 그런데 [0편](/blog/project/lakehouse/lakehouse-0-why)에서 스스로 그은 선이 하나 있었습니다.

> "Parquet 덮어쓰기만으론 ACID·타임트래블이 없어 엄밀히는 lake입니다. 테이블 포맷을 얹어야 house가 되고, 그래야 lakehouse라 부르는 게 정직합니다."

이 편은 그 문장을 닫는 편입니다.

무엇이 부족한지는 raw의 멱등성 규약에 그대로 드러나 있습니다. 앞 2부에서 만든 적재는 파티션 프리픽스를 **통째로 지우고 다시 씁니다**(whole-partition overwrite). 같은 날짜를 몇 번 돌려도 결과가 같다는 건 backfill에는 큰 장점이지만 뒤집으면 이런 뜻이기도 합니다. **어제의 파티션이 오늘 덮어쓰이면, 어제 그 안에 무엇이 있었는지는 사라집니다.** 파일이 없기 때문입니다.

그래서 이런 질문에 답할 수 없습니다.

- "지난주 화요일 기준으로 다시 계산해줘." → 그날 parquet가 이미 덮였으면 불가능.
- "적재가 도중일 때 대시보드를 열면?" → 반쪽 상태가 그대로 보일 수 있음.
- "저 수치, 언제부터 저렇게 됐지?" → 버전이 없으니 되짚을 이력이 없음.

lakehouse의 정의는 개방 포맷(Parquet) 위에 **ACID·타임트래블·스키마 진화**를 얹은 것입니다. 지금 우리에겐 Parquet만 있고 그 위층이 비어 있습니다. 그러니 지금은 lake에 머물러 있고, house라 부르기엔 이릅니다.

### 1. 파일 덮어쓰기에 '버전' 개념이 없다는 함정

raw 레이어의 시간 모델을 정확히 보겠습니다. `s3://lakehouse/raw/query_snapshot/dt=2026-07-06/instance_id=3/part-000.parquet`는 그 파티션의 **현재 진실 딱 하나**입니다. 재적재하면 같은 키에 새 바이트가 올라가고, 이전 바이트는 없어집니다. S3 버저닝을 켜면 오브젝트 버전은 남지만, 그건 스토리지 레벨의 파일 이력이지 **테이블 레벨의 논리 버전**이 아닙니다. "이 테이블의 3번째 커밋 시점"을 SQL로 가리킬 방법이 없습니다.

정리하면 파일 덮어쓰기에는 세 가지가 구조적으로 빠져 있습니다.

```
원자성 없음     여러 인스턴스 파티션을 쓰는 도중 조회하면 반쪽이 보인다.
버전 없음       "N번째 상태"를 가리킬 좌표가 없다 → 타임트래블 불가.
스키마 고정      컬럼을 늘리면 옛 파티션과 새 파티션의 스키마가 갈라진다.
```

이걸 메우는 게 **테이블 포맷**입니다. 핵심 발상은 간단합니다. 데이터 파일(Parquet)은 그대로 두되, **"어느 스냅샷에 어떤 파일들이 속하는지"를 따로 기록하는 카탈로그**를 둡니다. 커밋할 때마다 카탈로그에 새 스냅샷 한 줄이 쌓이고, 각 스냅샷은 그 시점의 파일 목록을 가리킵니다. 그러면 과거 스냅샷을 지정해 그때의 파일들만 읽으면 그게 타임트래블이고, 커밋을 원자 단위로 만들면 그게 ACID입니다.

### 2. 카탈로그를 PostgreSQL에 두는 DuckLake라는 판단

테이블 포맷의 사실상 표준은 Apache Iceberg입니다. 다만 로컬 단일노드에서는 걸리는 지점이 있습니다. DuckDB에서 **Iceberg에 쓰려면 REST 카탈로그 서버가 따로 필요합니다**(path 기반은 읽기 전용). 관제 부하를 최소화하려고 시작한 프로젝트인데, 여기서 상시 서비스가 하나 더 느는 건 규모에 안 맞습니다.

그래서 **DuckLake**를 택했습니다. DuckLake는 카탈로그를 별도 서버 대신 **평범한 SQL 데이터베이스에 테이블로** 둡니다. 이미 PostgreSQL을 쓰고 있습니다(DBTower 메타 DB가 PostgreSQL입니다). 그 인스턴스를 재사용하면 **서비스 추가가 0**입니다. 데이터 파일은 지금처럼 MinIO(S3)에 Parquet로 둡니다.

한 가지 반드시 지킬 선이 있습니다. **카탈로그를 DBTower 메타 DB(`dbtower`)에 섞으면 안 됩니다.** 그 DB는 관측 데이터가 사는 원천이고, 분석계가 그걸 오염시키면 "운영계와 분석계를 분리한다"는 이 프로젝트의 첫 원칙이 무너집니다. 그래서 같은 PG 인스턴스 안에 **별도 DB `ducklake_catalog`를 새로 만들어** 카탈로그 전용으로 씁니다. 물리 인스턴스는 공유하되 데이터베이스는 분리합니다. 서비스 0의 이점은 취하면서 오염은 막는 방식입니다.

정리하면 이런 구도입니다.

```
카탈로그(메타데이터)  →  PostgreSQL  ducklake_catalog DB   (dbtower와 분리)
데이터 파일(Parquet)  →  MinIO(S3)   s3://lakehouse/ducklake/
```

스토리지/컴퓨트 분리는 그대로 유지됩니다. 오히려 "어떤 파일이 어느 버전에 속하나"라는 메타데이터가 SQL로 조회 가능한 PG에 앉으면서 더 또렷해집니다.

Iceberg를 뺀 실제 이유는 규모가 안 맞아서입니다. 타임트래블·스키마 진화라는 개념은 두 포맷이 동일하므로, 나중에 멀티엔진·대규모가 되면 Iceberg 전환은 카탈로그 어댑터를 바꾸는 문제입니다.

### 3. DuckLake ATTACH와 테이블 적재 구현

구현은 `extract/ducklake_load.py` 한 모듈입니다. 순서대로 봅니다.

#### 카탈로그 DB 준비 (dbtower를 건드리지 않고)

`postgres` 기본 DB로 접속해 `ducklake_catalog`가 없으면 만듭니다. `CREATE DATABASE`는 트랜잭션 안에서 못 돌아서 autocommit으로 엽니다.

```python
def ensure_catalog_db(cfg: DuckLakeConfig) -> bool:
    conn = psycopg2.connect(cfg.admin_dsn())
    conn.autocommit = True                       # CREATE DATABASE는 트랜잭션 밖에서
    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM pg_database WHERE datname = %s", (cfg.catalog_db,))
        if cur.fetchone():
            return False                         # 이미 있으면 그대로 (멱등)
        cur.execute(f'CREATE DATABASE "{cfg.catalog_db}"')
        return True
```

#### ATTACH로 카탈로그는 PG에, 데이터는 S3에

DuckDB에서 `ducklake`·`postgres`·`httpfs` 확장을 로드하고, MinIO 접속용 S3 시크릿을 만든 뒤, 한 줄로 붙입니다. `DATA_PATH`가 데이터 파일이 떨어질 S3 경로입니다.

```python
con.execute(
    f"ATTACH 'ducklake:postgres:{cfg.catalog_dsn()}' AS {cfg.lake_alias} "
    f"(DATA_PATH '{cfg.data_path}')"
)
con.execute(f"USE {cfg.lake_alias}")
```

이 `ATTACH` 한 줄이 실행되는 순간, PG의 `ducklake_catalog`에 카탈로그 테이블 30개가 생깁니다(`ducklake_snapshot`, `ducklake_table`, `ducklake_data_file` …). 스키마·스냅샷·파일 목록이 전부 여기 SQL 테이블로 관리됩니다.

#### 테이블 만들고 닫힌 창을 적재

스키마는 raw 계약을 그대로 따르되, 파티션 키였던 `dt`를 값 컬럼으로 명시 선언합니다. 테이블 포맷이라 스키마를 추론에 맡기지 않고 카탈로그에 박아 둡니다. 적재는 MinIO의 raw parquet를 `read_parquet`로 읽어 `INSERT` 합니다. 이 INSERT 하나가 하나의 커밋(스냅샷)이 됩니다.

```python
con.execute("""
    INSERT INTO query_snapshot
    SELECT id, instance_id, captured_at, query_id, query_text,
           calls, total_time_ms, rows_examined, CAST(dt AS DATE)
    FROM read_parquet('s3://lakehouse/raw/query_snapshot/dt=2026-07-06/instance_id=*/*.parquet',
                      hive_partitioning = 1)
""")
```

수치는 **닫힌 UTC 창만** 씁니다. dt=2026-07-06(79,894행)과 dt=2026-07-05(149,259행)입니다. 07-07은 원천 DB의 시계 기준 아직 진행 중인 '오늘'이라 값이 계속 자라므로(앞 3부에서 다뤘습니다), 재현 가능한 실증에는 넣지 않습니다.

### 4. 실측: 버전이 쌓이고, 과거를 실제로 되살린다

`python -m extract.ducklake_load`를 돌리면 네 번의 커밋이 순서대로 쌓입니다. 아래는 **실제 실행 출력**입니다.

```
[카탈로그 DB] ducklake_catalog @ localhost:15432 (신규 생성) — DBTower 메타 DB(dbtower)와 분리
[ATTACH] ducklake:postgres → DATA_PATH s3://lakehouse/ducklake/  (카탈로그=PG, 데이터=S3)

[커밋1] CREATE TABLE query_snapshot  → 버전 1
[커밋2] INSERT dt=2026-07-06  +79,894행  → 버전 2  (누적 79,894)
[커밋3] INSERT dt=2026-07-05  +149,259행  → 버전 3  (누적 229,153)
[커밋4] UPDATE id=382457 total_time_ms 0.55 → 1000.55  → 버전 4  (행수 불변 229,153)
```

커밋4는 '뒤늦게 정정된 스냅샷'을 흉내 낸 한 행 UPDATE입니다. 타임트래블로 되돌아볼 대상입니다.

#### 스냅샷(버전) 목록

`ducklake_snapshots('lh')`를 조회하면 커밋 하나하나가 버전으로 남아 있습니다.

```
v0  {'schemas_created': ['main']}
v1  {'tables_created': ['main.query_snapshot']}
v2  {'tables_inserted_into': ['1']}
v3  {'tables_inserted_into': ['1']}
v4  {'inlined_insert': ['1'], 'inlined_delete': ['1']}
```

정직하게 짚을 게 있습니다. 벌크 INSERT 두 건(v2·v3)은 S3에 Parquet 데이터 파일을 실제로 썼지만, 단일 행 UPDATE(v4)는 DuckLake가 Parquet를 새로 쓰는 대신 **카탈로그에 인라인**했습니다(`inlined_insert`/`inlined_delete`). 작은 변경까지 매번 파일을 만들지 않으려는 최적화입니다. 그래도 결과는 동일하게 버전으로 남습니다.

#### 타임트래블, 같은 테이블에서 버전별로 다른 결과

**같은 테이블, 같은 쿼리인데, 버전만 지정하면 그 시점의 상태가 그대로 나옵니다.**

```
count @ v2 (07-06만 적재 직후)  = 79,894
count @ v3 (07-05까지 적재 직후) = 229,153
count @ v4 (현재)             = 229,153
```

`SELECT count(*) FROM query_snapshot AT (VERSION => 2)`는 79,894를, `AT (VERSION => 3)`은 229,153을 돌려줍니다. 07-06만 담겼던 그 순간을, 파일을 아무것도 되돌리지 않고 SQL 한 줄로 재현한 것입니다. raw 덮어쓰기로는 불가능했던 일입니다.

행 하나의 값도 시점별로 다릅니다. 커밋4에서 UPDATE한 `id=382457`을 과거 버전과 현재에서 각각 읽으면,

```
total_time_ms @ v3(과거) = 0.55       -- UPDATE 이전
total_time_ms @ v4(현재) = 1000.55    -- UPDATE 이후
```

과거 버전이 UPDATE 이전 값을 그대로 보존하고 있습니다. "저 수치 언제부터 저랬지?"에 이제 답할 수 있습니다.

#### BEGIN에서 ROLLBACK까지, 원자성 확인

트랜잭션 안에서 149,259행(07-05 전체)을 지웠다가 되돌립니다.

```
트랜잭션 전 count       = 229,153
DELETE 07-05 후(txn 내) = 79,894
ROLLBACK 후 count       = 229,153   (원상복구)
스냅샷 수 5 → 5  (롤백은 버전을 남기지 않음)
```

트랜잭션 안에서는 79,894로 줄었지만 ROLLBACK 하면 229,153으로 흔적 없이 돌아오고, 스냅샷(버전)도 늘지 않습니다. 부분 반영이 없습니다. 이게 ACID의 A입니다.

#### 카탈로그=PG / 데이터=S3, 그리고 오염 없음

마지막으로 분리가 실제로 지켜졌는지 확인합니다. 카탈로그는 PG에, 데이터는 S3에 갈라져 앉아 있고, DBTower 메타 DB는 깨끗합니다.

```
PG ducklake_catalog:  ducklake_ 카탈로그 테이블 30개
                      ducklake_table = query_snapshot (1건)
                      ducklake_data_file = 2건 (79,894행 · 149,259행)
S3 s3://lakehouse/ducklake/main/query_snapshot/*.parquet
                      810 KB (79,894행) + 1.38 MB (149,259행)
PG dbtower(메타 DB):  ducklake_ 테이블 = 0   ← 오염 없음
```

![DuckLake ACID·타임트래블 실제 실행 출력으로 버전 v0~v4와 타임트래블, 롤백, 카탈로그/데이터 분리를 담았다](/uploads/project/lakehouse/ducklake-timetravel.png)

*위 이미지는 터미널풍 카드로 렌더했지만 내용은 전부 실제 실행 출력입니다. DuckDB·PostgreSQL은 웹 UI가 없어 CLI 출력을 그대로 담았습니다.*

### 5. 잔여, 정직한 한계

- **단일 노드입니다.** DuckLake는 카탈로그를 SQL DB에 두는 구조라 로컬 단일노드에 잘 맞지만, 여러 엔진(Spark·Trino·Flink)이 한 테이블을 공유하는 대규모 조직 표준은 여전히 Iceberg입니다. 여기선 규모가 안 맞아 DuckLake를 택했고, 개념(타임트래블·스키마 진화)이 같으니 전환은 카탈로그 어댑터 문제로 남겨둡니다.
- **적재는 raw 스냅샷을 테이블로 등록하는 데까지입니다.** dbt-duckdb에도 DuckLake를 마트의 물질화 대상으로 붙이는 길이 있지만, 이 편의 목적은 ACID·타임트래블을 **또렷한 커밋 단위로** 실증하는 것이라, 명시적 INSERT/UPDATE로 버전을 쌓는 쪽을 택했습니다. dbt 파이프라인 전체를 DuckLake 위로 옮기는 건 별도 작업으로 남습니다.
- **스냅샷 만료(버전 폭증)는 아직입니다.** 커밋마다 버전이 쌓이므로, 오래 돌리면 카탈로그와 데이터 파일이 계속 늘어납니다. 오래된 스냅샷을 정리하는 만료 정책은 이번 범위 밖입니다.
- **스키마 진화는 구조만 확인했습니다.** 테이블 포맷이라 ADD COLUMN이 버전으로 남는다는 건 카탈로그 구조상 성립하지만, 이 편의 실측은 ACID·타임트래블 두 축에 집중했습니다. 컬럼 추가 후 과거 버전 조회까지의 실측은 다음으로 미룹니다.
- **수치는 닫힌 창만입니다.** 07-05·07-06(149,259·79,894)만 재현 근거로 썼습니다. 07-07은 원천의 진행 중인 오늘이라 값이 자라므로 넣지 않았습니다.

0편에서 "Parquet 덮어쓰기만으론 엄밀히 lake"라고 선을 그었습니다. 5부에서 그 위에 테이블 포맷을 얹어, 같은 테이블의 과거를 SQL로 되살리고 트랜잭션을 원자로 만들었습니다. 이제 lake가 house가 됐고, lakehouse라 부르는 게 정직해졌습니다.

여기까지가 1부입니다. 이제 이걸 운영이라 부를 수 있는지 볼 차례입니다.

## 6부. 실패해도 아무도 모르는 파이프라인은 미완성: 알림·retry·컨테이너 dbt·CHECKPOINT

### 0. 상황: 게이트는 잘 막는데, 막았다고 아무도 안 알려준다

5부까지 파이프라인은 형태를 다 갖췄습니다. 추출하고(1~2부), 변환하고 반쪽 데이터를 막고(3~4부), 테이블 포맷으로 버전까지 쌓았죠(5부). 그런데 이걸 "운영한다"고 상상하는 순간 구멍이 줄줄이 보였습니다.

**첫째, 알림이 없습니다.** 4부의 품질 게이트는 fail-closed입니다. FAIL이면 transform이 실행되지 않습니다. 잘 막습니다. 문제는 그다음입니다. 막았다는 사실을 누구에게도 알리지 않습니다. 게이트가 어느 새벽에 FAIL을 내면, 파이프라인은 조용히 멈춘 채 제가 우연히 Airflow UI를 열어볼 때까지 그대로 있습니다. 그동안 마트는 낡아갑니다. **조용히 멈춘 파이프라인은 안 멈춘 척하는 파이프라인과 다를 게 없습니다.** 차단했으면 알려야 끝난 겁니다.

**둘째, 이게 제일 부끄러운데, transform이 반쪽이었습니다.** DAG 그래프는 `offload → quality_gate → transform` 3단계인데, Airflow 컨테이너에 dbt가 없어서 transform 태스크는 "게이트 통과 확인" 로그만 남겼습니다. 실제 dbt run은 제가 호스트에서 손으로 돌렸습니다. 그래프의 마지막 단계가 사람 손으로 남으면 그건 오케스트레이션 그림일 뿐입니다.

**셋째, DuckLake는 스스로 아무것도 지우지 않습니다.** 1부 잔여에 적어둔 그대로입니다. 커밋마다 스냅샷이 쌓이고 덮어쓰인 파일은 타임트래블을 위해 S3에 남습니다. 만료 없이 방치하면 카탈로그(PG)와 스토리지(S3)가 단조 증가합니다.

그 밖에도 retry 정책이 기본값 방치였고, backfill 절차는 제 머릿속에만 있었습니다. 이 편은 새 기능 없이 **운영을 단단히 조이는 일**만 다룹니다. 화려하진 않지만 이거 없으면 앞의 편들이 전부 "데모"에 머뭅니다.

### 1. 알림·재시도·유지보수에 하나씩 있는 함정

#### 함정 1: SLA 콜백은 폐기 경로다

Airflow에서 "실패를 알린다"를 검색하면 `sla_miss_callback`이 같이 나옵니다. 쓰면 안 됩니다. SLA 기능은 오랫동안 버그가 많기로 유명했고(스케줄러 안에서 돌아 지연·누락이 잦음), **Airflow 3.0에서 아예 제거됐습니다.** 지금 2.x에서 붙여봤자 이주할 때 뜯어내야 할 빚입니다. 표준 경로는 `on_failure_callback`입니다. 태스크가 최종 실패하면(재시도 소진 후) 호출되는 콜백입니다.

그리고 알림 코드 자체의 함정: **알림이 실패하면?** webhook 수신기가 죽어 있을 때 콜백이 예외를 던지면, 알림 실패가 장애 대응을 더 꼬이게 만듭니다. 알림은 best-effort여야 합니다. 전 과정을 try/except로 감싸고 실패하면 로그만 남긴 채 삼킵니다.

#### 함정 2: 품질 게이트를 재시도하면 안 된다

재시도가 의미 있는 건 **일시 장애**(네트워크 순단, 원천 재기동)뿐입니다. 품질 게이트의 FAIL은 결정적입니다. 데이터가 틀렸다는 판정인데, 5분 뒤에 다시 검문한다고 데이터가 맞아지지 않습니다. 재시도는 원천 PG와 S3에 재검문 부하만 얹습니다. 그래서 retry 정책은 태스크별로 갈라야 합니다: 추출·변환은 retries=3 + 지수 백오프, **게이트는 retries=0**(4부 설계 그대로).

여기에 이번에 몸으로 배운 게 하나 더 있습니다. 작업 중 원천 스택이 통째로 내려간 적이 있는데(머신 절전), psycopg2 기본값엔 접속 타임아웃이 없어서 **연결 시도가 무한 대기**로 멈춰버렸습니다. 걸려서 멈춘 태스크는 실패도 아니라서 재시도도 알림도 못 탑니다. 그래서 모든 PG DSN에 `connect_timeout=5`를 박았습니다. 빨리 죽어야 재시도가 삽니다.

#### 함정 3: dbt와 Airflow를 같은 환경에 섞으면 안 된다

컨테이너에 dbt를 넣는 가장 쉬운 방법은 Airflow의 site-packages에 `pip install dbt-duckdb`를 얹는 겁니다. 하면 안 되는 걸로 널리 알려져 있습니다. dbt-core와 Airflow는 공유 의존성(jinja2, click, protobuf 등)의 버전 요구가 자주 충돌해서 어느 한쪽을 올리는 순간 다른 쪽이 조용히 깨집니다. 관례는 **컨테이너 안 별도 venv에 dbt를 격리**하고 subprocess로 부르는 것입니다. Cosmos 같은 통합 도구도, MWAA 문서도 같은 이유로 이 구조를 권장합니다.

기존 compose의 `_PIP_ADDITIONAL_REQUIREMENTS`도 이참에 폐기했습니다. 컨테이너가 뜰 때마다 pip을 도는 방식이라 기동이 느리고 무엇보다 "그날 PyPI 상태"에 따라 환경이 달라지는 비재현 요소였습니다. Dockerfile로 구워야 이미지 해시가 곧 환경입니다.

#### 함정 4: DuckLake 정리는 순서가 있다

DuckLake의 유지보수 수단은 여러 개입니다. 스냅샷 만료(`ducklake_expire_snapshots`), 인접 파일 컴팩션(`ducklake_merge_adjacent_files`), 옛 파일 삭제(`ducklake_cleanup_old_files`) 같은 것들입니다. 이걸 손으로 하나씩 부르면 **순서에 따라 꼬입니다.** 컴팩션 먼저·만료 나중 같은 조합에서 파일이 남거나 스냅샷 참조가 어긋나는 이슈가 보고돼 있습니다(ducklake #336, #536). 공식 권장은 **`CHECKPOINT` 번들**입니다. 만료+인라인 플러시+컴팩션을 안전한 순서로 한 번에 묶어 실행합니다. 보존 기간은 `expire_older_than` 옵션으로 선언합니다.

### 2. 넷을 한 번에, 전부 실측으로 내린 판단

정리하면 이번 편의 판단은 이렇습니다.

```
알림        on_failure_callback → webhook POST (URL은 env 주입, 실패는 삼킴)
retry       retries=3 + 지수 백오프. 단 quality_gate만 retries=0 (결정적 실패)
transform   Dockerfile: 분리 venv(/opt/dbt-venv)에 dbt-duckdb → 컨테이너 안 run+test
유지보수     @weekly DAG: CHECKPOINT 번들 + 삭제 예약 파일 정리, 보존 7일
```

보존 7일은 원천(DBTower 스냅샷 보존 7일)과 대칭입니다. raw parquet 원본이 별도 경로에 그대로 있으니, DuckLake 버전 7일이면 "지난주 기준 재계산"까지는 되고 그 이전 타임트래블은 포기합니다. 대신 용량이 유계가 됩니다.

그리고 전부 실측합니다. 특히 이번 편의 핵심 증거는 하나예요: **`airflow dags test`로 3태스크가 전부 컨테이너 안에서 success가 되는 것.** transform 로그 안에 dbt의 PASS가 찍혀 있어야 합니다.

### 3. 코드는 얇게, 경계는 분명하게

#### 알림 모듈 (extract/alerts.py)

의존성 0(표준 라이브러리 urllib)으로 짰습니다. 핵심은 두 겹의 try/except입니다. 전송 실패도, 콜백 내부 오류도 절대 밖으로 안 새 나갑니다.

```python
def notify_task_failure(context: dict) -> None:
    """Airflow on_failure_callback 진입점."""
    try:
        ti = context.get("task_instance")
        payload = {
            "event": "airflow_task_failed",
            "dag_id": ti.dag_id, "task_id": ti.task_id,
            "logical_date": str(context.get("logical_date")),
            "try_number": ti.try_number, "max_tries": ti.max_tries,
            "log_url": ti.log_url,
            "error": str(context.get("exception"))[:1000],
        }
        post_webhook(payload)          # 이 안에서도 실패는 로그만 남기고 삼킨다
    except Exception:
        log.exception("실패 알림 콜백 내부 오류(무시)")
```

URL은 `ALERT_WEBHOOK_URL` 환경변수로 주입합니다. Slack이든 Discord든 사내 수신기든 POST 받는 곳이면 되고, 미설정이면 no-op이라 알림 없이도 파이프라인은 돕니다.

#### DAG의 retry 정책과 콜백

```python
default_args={
    "retries": 3,
    "retry_delay": pendulum.duration(minutes=2),
    "retry_exponential_backoff": True,      # 2분 → 4분 → 8분
    "max_retry_delay": pendulum.duration(minutes=30),
    "on_failure_callback": notify_task_failure,
},
```

그리고 게이트만 예외를 명시합니다.

```python
@task(retries=0)  # 품질 FAIL은 결정적 — 재시도해도 그대로 FAIL
def quality_gate(offload_result: dict) -> dict:
```

#### Dockerfile에서 dbt는 분리 venv에

```dockerfile
FROM apache/airflow:2.10.4-python3.12

# 추출·게이트·유지보수 의존성 — Airflow venv에 직접
RUN pip install --no-cache-dir pyarrow==18.1.0 psycopg2-binary==2.9.10 \
    boto3==1.35.90 duckdb==1.5.4

# dbt는 분리 venv — Airflow 의존성과 절대 섞지 않는다
USER root
RUN python -m venv /opt/dbt-venv \
    && /opt/dbt-venv/bin/pip install --no-cache-dir dbt-duckdb==1.10.1 duckdb==1.5.4 \
    && chown -R airflow:0 /opt/dbt-venv
USER airflow
```

transform 태스크는 이 venv의 dbt를 subprocess로 부릅니다. run이 통과해도 test가 깨지면 태스크는 실패입니다.

```python
for command in ("run", "test"):
    proc = subprocess.run([DBT_BIN, command,
                           "--profiles-dir", DBT_PROJECT_DIR,
                           "--project-dir", DBT_PROJECT_DIR], ...)
    if proc.returncode != 0:
        raise RuntimeError(f"dbt {command} 실패")
```

한 가지 주의할 배선: dbt 프로파일의 S3 endpoint는 지금까지 호스트 관점(`localhost:19000`)이었습니다. 컨테이너 안에서는 MinIO가 `dbtower-minio:9000`이므로, 프로파일이 읽는 `S3_ENDPOINT_HOSTPORT` env를 compose에서 컨테이너 관점으로 주입했습니다. 같은 profiles.yml이 호스트에서도 컨테이너에서도 돌아갑니다.

#### DuckLake 유지보수 (extract/ducklake_maintenance.py + @weekly DAG)

공식 권장 순서 그대로 세 줄입니다.

```python
con.execute(f"CALL lh.set_option('expire_older_than', '{retention}')")  # 보존 선언
con.execute("CHECKPOINT lh")                        # 만료+플러시+컴팩션 번들
con.execute("CALL ducklake_cleanup_old_files('lh', cleanup_all => true)")  # 예약된 파일 실제 삭제
```

셋째 줄이 필요한 이유: 만료가 하는 일은 **삭제 예약**뿐입니다. 파일이 그 자리에서 바로 지워지진 않습니다. 예약만으로는 S3 용량이 줄지 않습니다. 그리고 모듈에 안전 불변식을 하나 박았습니다. 유지보수 전/후 테이블 행수를 대조해서 다르면 예외를 던집니다(유지보수는 과거를 지울 뿐 현재를 바꾸면 안 되기 때문입니다). 그 예외도 물론 webhook으로 옵니다.

### 4. 실측: 알림 도착·3태스크 e2e·CHECKPOINT 전후·backfill

실측 시점의 원천 시계는 2026-07-08 17:24 UTC입니다. 즉 **07-07이 닫힌 창이 됐습니다**(279,002행으로 안정). 이 편의 수치는 전부 닫힌 창만 씁니다.

#### 3태스크가 전부 컨테이너 안에서 success

`airflow dags test snapshot_offload 2026-07-08`(→ dt=2026-07-07 처리) 결과입니다.

```
$ airflow tasks states-for-dag-run snapshot_offload manual__2026-07-08T00:00:00+00:00
offload       success    # dt=2026-07-07, 279,002행 (원천 PG = parquet)
quality_gate  success    # 3검문 모두 OK → GATE: PASS
transform     success    # 컨테이너 안 dbt

transform 로그 안:
  dbt run   Done. PASS=3 WARN=0 ERROR=0 SKIP=0 TOTAL=3
  dbt test  Done. PASS=18 WARN=0 ERROR=0 SKIP=0 TOTAL=18
  Returned value: {'dt': '2026-07-07', 'dbt_run': 'PASS', 'dbt_test': 'PASS'}
```

![Airflow 그래프 뷰에서 offload·quality_gate·transform 3태스크가 전부 success다 (dbt가 컨테이너 안에서 돈 그 런)](/uploads/project/lakehouse/e2e-dag.png)

처음으로 세 단계가 전부 한 컨테이너 안에서 끝났습니다. 호스트의 제 손은 이제 그래프에 없습니다.

#### 강제 FAIL → webhook에 실제로 도착

freshness FAIL 임계를 0.5h로 조여(dt=07-07은 경계까지 0.9h) 게이트를 강제로 죽였습니다. 로컬 수신기(표준 라이브러리 http.server 한 장짜리, :18808)의 **실제 수신 로그**입니다.

```
[2026-07-08 17:47:22 UTC] POST /alert from 127.0.0.1
{
  "event": "airflow_task_failed",
  "dag_id": "snapshot_offload",
  "task_id": "quality_gate",
  "logical_date": "2026-07-08 00:00:00+00:00",
  "try_number": 1,
  "max_tries": 0,
  "log_url": "http://localhost:8080/dags/snapshot_offload/grid?...&task_id=quality_gate&...tab=logs",
  "error": "품질 게이트 FAIL — 파티션 ['2026-07-07']. 다운스트림 차단."
}
```

같은 순간 스케줄러 로그는 `Marking task as FAILED ... quality_gate` → `알림 전송 완료 (HTTP 200)` → DagRun failed(transform 미실행) 순서로 흘렀습니다. 4부의 차단에 드디어 통보가 붙었습니다. 눈여겨볼 것은 `max_tries: 0`입니다. 게이트는 재시도 없이 즉시 죽고 즉시 알립니다. 결정적 실패에 재시도는 낭비이기 때문입니다.

#### CHECKPOINT 전후, 쌓인 것이 줄고 현재는 그대로

1부 데모를 두 번 반복해 일부러 버전·파일을 쌓은 뒤, 컨테이너 안에서 `airflow dags test ducklake_maintenance`(데모용 보존 0초)를 돌렸습니다.

```
[DuckLake 유지보수] retention = 0 seconds
지표                          전              후
--------------------------------------------------
스냅샷 수                     11               2
활성 데이터 파일               2               2
S3 오브젝트 수                 7               3
S3 바이트             7,337,540       2,828,889
테이블 행수(불변식)      229,153         229,153
삭제된 파일: 7개
```

옛 버전 9개와 죽은 파일 7개(4.5MB)가 사라졌고, 현재 상태는 한 행도 안 변했습니다(불변식 검사 통과). 운영에선 이 DAG가 @weekly, 보존 7일로 돕니다. 트레이드오프는 명확합니다. 7일보다 오래된 버전으로 되돌아가는 타임트래블은 포기하고 대신 카탈로그와 스토리지가 유계가 됩니다.

#### backfill, 날짜 산수를 실측으로 확정

backfill은 문서 없이는 항상 헷갈립니다. 실측으로 확정했습니다: `-s/-e`는 **논리 실행일 구간(양끝 포함)**이고, @daily에서 각 런은 **논리일의 전날 dt**를 처리합니다.

```
$ airflow dags backfill snapshot_offload -s 2026-07-06 -e 2026-07-07 --reset-dagruns -y
→ 런 2개 생성 (논리 07-06, 07-07 = dt 07-05, 07-06 처리)
→ 태스크 6/6 succeeded, failed 0
```

즉 **dt=D 하나만 재적재하려면 `-s D+1 -e D+1`**. 그리고 멱등 검증입니다. 재적재 전후가 완전히 같습니다.

| 항목 | backfill 전 | backfill 후 |
|---|---|---|
| dt=2026-07-05 행수 | 149,259 | 149,259 |
| dt=2026-07-06 행수 | 79,894 | 79,894 |
| dt=2026-07-06 오브젝트 수 | 6 | 6 |

앞 2부에서 "파티션 통째 덮어쓰기 멱등"을 설계할 때 노린 게 바로 이 장면입니다. backfill이 무서운 일에서 명령 한 줄로 내려앉습니다. `catchup=False`는 그대로 둡니다. DAG를 며칠 껐다 켰을 때 Airflow가 밀린 날짜를 멋대로 대량 실행하는 걸 막고 과거 재처리는 위처럼 **명시적으로만** 하자는 결정입니다. 이 절차 전체(실패 대응 → 로그 → 재적재, dry-run의 알려진 제약 포함)는 `docs/RUNBOOK.md`로 문서화했습니다. 새벽에 알림을 받은 사람이 처음부터 끝까지 따라갈 수 있게 했습니다.

### 5. 남은 일과 한계

- **마트는 여전히 전체 재빌드입니다.** 매일 fct/mart 테이블을 통째로 다시 만듭니다. 지금 규모(수십만 행)에선 수 초지만, 적재가 수개월 쌓이면 dbt incremental 모델로 바꿔야 합니다.
- **알림은 채널 하나, best-effort 하나입니다.** 심각도 라우팅(게이트 FAIL은 급하고 유지보수 실패는 덜 급함), 중복 억제, 에스컬레이션은 없습니다. 그리고 알림 실패를 삼키는 설계라 "알림이 안 옴 = 정상"이 아닙니다. 최종 진실은 Airflow UI라고 RUNBOOK에 못박았습니다.
- **dbt 통합은 subprocess까지입니다.** 모델별 태스크 분해·재시도는 Cosmos 같은 통합 레이어의 몫인데, 모델 3개 규모엔 과잉이라 넣지 않았습니다.
- **CHECKPOINT 주기는 @weekly 고정입니다.** 커밋 빈도나 카탈로그 크기에 따른 적응형 주기는 하지 않았습니다.
- **대시보드(Serve)는 여전히 다음 몫입니다.** 30일 시야가 쌓이는 중이라, "DBTower로는 데이터 없음 vs lakehouse로는 답이 나옴" 대비 실측은 적재가 더 쌓인 뒤에 합니다.

0편에서 시작한 질문은 "버려지는 데이터를 어떻게 살릴까"였습니다. 여기까지 오고 나니 대답이 조금 달라졌습니다. 파이프라인인 줄 알았던 게 실은 **운영**이었습니다. 막고(4부), 버전을 남기고(5부), 이제 실패를 통보하고 스스로를 청소하는 데까지 왔습니다. 실패해도 아무도 모르는 파이프라인은 미완성입니다.

코드는 [GitHub](https://github.com/dj258255/dbtower-lakehouse)에 있습니다.


## 7부. 서빙: 마트에 소비자를 붙인다

[0편](/blog/project/lakehouse/lakehouse-0-why)은 질문 하나로 시작했습니다. **"지난달보다 느려진 쿼리 있어?"** DBTower는 스냅샷을 7일 뒤 지우니까 구조적으로 답할 수 없고, 그래서 버려지기 직전의 데이터를 내려 장기 이력을 만드는 파이프라인을 지었습니다. 추출하고(1~2부), 델타로 변환하고 반쪽 데이터를 막고(3~4부), 테이블 포맷으로 버전을 쌓고 실패하면 알리게(5~6부)까지 했습니다.

그런데 6부까지 오고 그 질문에 실제로 답해보려니, 저는 여전히 **DuckDB 셸을 열고 SQL을 치고** 있었습니다. `mart_query_regression`은 매일 구워지는데, 그걸 볼 수 있는 사람이 SQL 칠 줄 아는 저 하나뿐입니다. 질문을 던진 사람은 SQL을 치는 사람이 아닙니다. **마트에 소비자가 없으면 파이프라인은 출구 없는 공장입니다.**

이 7부는 그 출구를 답니다. 클릭 몇 번으로 0편의 질문에 답하는 화면 말입니다. 그리고 화면 한 장 다는 일이 생각보다 함정이 많았다는 이야기입니다.

### 왜 Metabase를 골랐나

후보는 크게 둘이었습니다. 정적 리포트 계열(Evidence처럼 빌드 타임에 SQL을 돌려 페이지를 굽는 방식, 혹은 노트북 내보내기)과 BI 서버 계열입니다.

정적 리포트는 "만든 질문"에는 깔끔하게 답하지만, 질문이 조금만 비틀리면, 이를테면 "그거 인스턴스 8만 보여줘" 같은 요청이 들어오면 다시 빌드해야 합니다. 관제에서 파생되는 질문은 대부분 필터를 바꿔가며 파고드는 탐색이라, 서버가 라이브로 질의하고 필터가 배선된 대시보드가 맞다고 봤습니다.

BI 서버 중에 Metabase를 고른 근거는 셋입니다.

1. **DuckDB 커넥터가 있습니다.** MotherDuck이 유지하는 [커뮤니티 드라이버](https://github.com/motherduckdb/metabase_duckdb_driver)가 있어서, 마트를 다른 DB로 복사해 나르지 않아도 DuckDB/DuckLake를 직접 읽을 수 있습니다. 서빙용 DB를 새로 세우지 않는다는 뜻입니다.
2. **전부 API로 됩니다.** 초기 설정(관리자 계정)부터 커넥션·질문·대시보드·필터 배선까지 REST API가 있어서, 대시보드를 제 브라우저에만 두지 않고 스크립트로 재현되는 산출물로 만들 수 있습니다.
3. **운영 부담이 작습니다.** 컨테이너 하나, 앱 DB는 로컬 데모 규모면 내장 H2로 충분합니다(운영이면 PG로 빼야 하고 잔여에 적었습니다).

### 화면 한 장에 함정이 셋

### 함정 1: 공식 이미지에서 드라이버가 안 뜬다

compose에 `metabase/metabase:v0.59.16`을 얹고 드라이버 jar를 plugins에 넣었습니다. 드라이버 등록까지는 로그가 멀쩡합니다(`Registered driver :duckdb`). 그런데 첫 연결에서:

```
UnsatisfiedLinkError: /tmp/libduckdb_java....so:
  Error loading shared library libstdc++.so.6: No such file or directory
```

공식 Metabase 이미지는 **Alpine(musl)** 기반인데, DuckDB JDBC의 네이티브 라이브러리는 glibc에 링크돼 있습니다. 드라이버 저장소도 README에서 "기본 Alpine 컨테이너에선 안 된다"고 못박고 Debian 기반 Dockerfile을 제공합니다. 그래서 이미지를 직접 구웠습니다. `eclipse-temurin:21-jre-jammy` 위에 metabase.jar와 드라이버 jar를 얹은 20줄짜리입니다.

여기서 버전을 짝으로 고정하는 게 중요합니다. 드라이버 릴리스 이름이 아예 "Metabase 59 + DuckDB 1.5.3"처럼 짝을 명시합니다. Metabase만 올리면 드라이버가 안 뜨고 드라이버의 DuckDB 계열이 dbt 쪽(1.5.4)과 갈라지면 파일/DuckLake 포맷 호환부터 다시 봐야 합니다. 저는 드라이버 1.5.3.0 = Metabase 59로 맞췄고, 1.5 동계열이라 포맷 호환은 실측으로 확인됐습니다.

### 함정 2: dbt의 DuckDB 파일을 직접 물면 안 된다

드라이버가 떴으니 가장 쉬운 연결은 dbt가 마트를 굽는 그 DuckDB 파일을 read-only로 무는 겁니다. 실제로 됩니다. 마트 테이블이 보이고, 랭킹 쿼리도 정확한 값을 돌려줬습니다. 여기서 멈췄으면 "연결 완료"라고 썼을 겁니다.

정작 발목을 잡는 건 읽기 쪽이 아닙니다. **동시성**입니다. DuckDB 파일은 프로세스 간 **단일 쓰기**입니다. 읽기 전용 커넥션이라도 물고 있으면 쓰기 프로세스가 배타 잠금을 못 잡습니다. 그리고 BI는 켜 두는 물건이고 커넥션 풀은 커넥션을 계속 쥐고 있습니다. 실측 두 장면:

**같은 호스트, 프로세스 둘.** 읽기 전용 커넥션이 파일을 문 상태에서 쓰기로 열면:

```
Conflicting lock is held in .../Python (PID 99884) by user beomsu.
```

리눅스 서버에 이대로 올리면 **매일 새벽 transform(dbt run)이 이 에러로 죽습니다.** 대시보드를 다는 순간 파이프라인이 깨지는 구조입니다.

**컨테이너 경계(macOS Docker Desktop).** 더 놀란 건 이쪽입니다. Metabase 컨테이너가 파일을 문 걸 확인하고(`/proc/1/fd/25 → /marts/dbtower_lakehouse.duckdb`) 스케줄러 컨테이너에서 dbt run을 돌렸습니다. 그런데 **에러 없이 성공했습니다.** 잠금이 virtiofs 마운트 경계를 넘어 전파되지 않은 것입니다. 그러니까 dbt가 열린 리더 밑에서 파일을 통째로 재작성했는데 아무도 몰랐습니다. 시끄럽게 죽는 앞 장면보다 나쁩니다. 단일 쓰기를 지켜주던 안전장치가 배포 형태에 따라 조용히 사라지고, 쓰기 도중 읽기가 무방비가 되기 때문입니다.

죽거나(잠금이 전파되는 환경), 조용히 위험하거나(안 되는 환경). 어느 쪽이든 **dbt의 DuckDB 파일은 서빙 계층으로 실격**입니다.

### 함정 3: 커넥션 풀의 init_sql이 동시 카드 로딩에서 SECRET 경합을 깨운다

해법(3절)으로 DuckLake 연결을 붙인 뒤에도 하나 더 있었습니다. 커넥션에는 "새 커넥션마다 실행"되는 init_sql을 줄 수 있는데, 첫 구현은 여기서 `CREATE OR REPLACE SECRET minio (...)`로 S3(MinIO) 자격증명을 만들었습니다. 카드를 한 장씩 API로 돌리면 전부 통과합니다. 그런데 **대시보드를 열어** 카드 3장이 동시에 나가면 2장이 500으로 죽었습니다:

```
TransactionContext Error: Catalog write-write conflict on alter with "minio"
```

대시보드가 카드들을 병렬로 쏘니 커넥션 풀이 커넥션을 여러 개 열고, 커넥션마다 도는 init_sql이 같은 DuckDB 인스턴스의 **공유 카탈로그**에 SECRET replace를 동시에 시도한 것입니다. 하나씩 돌릴 땐 절대 안 나오고 화면을 여는 순간에만 나오는, 전형적인 동시성 함정입니다. 해법은 경합할 공유 상태를 없애는 것입니다. SECRET 대신 **세션 로컬**인 `SET s3_endpoint / s3_access_key_id / ...`로 바꾸자 동시 3카드를 몇 번을 쏴도, 컨테이너를 재기동해 콜드 스타트로 열어도 전부 통과했습니다.

### 서빙 계층은 이미 세워둔 lakehouse로

함정 3에서 잠깐 앞질러 등장한 해법을 이제 폅니다. 함정 2의 답은 "파일 말고 무엇을 물릴까"입니다. 마트를 PostgreSQL로 내보내고 PG 커넥터로 붙는 안도 검토했습니다. 드라이버가 아예 버전 비호환이었다면 그렇게 갔을 겁니다. 그런데 이미 5부에서 세운 **DuckLake**가 있습니다. 카탈로그는 PG 트랜잭션이고 데이터는 S3 parquet입니다. 읽기와 쓰기를 파일 잠금 대신 **DB 트랜잭션(스냅샷 격리)**이 중재합니다. raw가 이미 사는 곳이라 서비스 추가도 0입니다.

그래서 DAG 끝에 태스크 하나를 달았습니다.

```
offload → quality_gate → transform → publish
```

`publish`는 dbt가 구운 마트 두 장(fct_query_daily, mart_query_regression)을 DuckLake로 통째 복사합니다. 마트는 일간 집계라 수천 행 규모입니다. 증분보다 통째 교체가 단순하고 멱등합니다. DuckLake에선 DROP+CREATE가 **한 커밋**이라 읽는 쪽은 언제나 발행 전이나 후의 온전한 버전만 봅니다. 발행 후엔 행수를 원본과 대조해서 다르면 태스크를 실패시킵니다(그 실패도 6부의 webhook으로 옵니다).

Metabase는 이제 DuckLake를 뭅니다. 드라이버가 1.4.1.0부터 `ducklake:` 접두사를 지원해서, 커넥션의 데이터베이스 경로에 카탈로그 PG DSN을 그대로 씁니다:

```
ducklake:postgres:dbname=ducklake_catalog host=dbtower-postgres port=5432 user=... password=...
read_only: true
init_sql: SET s3_endpoint='dbtower-minio:9000'; SET s3_access_key_id='...'; ...
```

대시보드는 읽기 전용이고, 쓰기는 파이프라인(publish)만 합니다. 역할이 커넥션 수준에서 갈립니다.

마지막 조각은 재현성입니다. 대시보드를 손으로 만들면 그건 제 브라우저에만 있는 산출물입니다. `scripts/metabase_bootstrap.py`가 빈 Metabase에서 출발해 초기 설정 → DuckLake 커넥션 → 질문 3개(악화 랭킹 표·일별 추이·악화 쿼리 수) → 대시보드 1장 + 인스턴스 필터 배선까지 전부 REST API로 만듭니다(멱등이라 있으면 재사용합니다). 재현 절차가 문서에 없고 스크립트에 있습니다:

```bash
docker compose up -d metabase        # 커스텀 이미지 빌드(드라이버 포함)
.venv/bin/python scripts/metabase_bootstrap.py
```

### 0편의 질문에 화면이 답한다

실측 시점 기준 원천 시계는 2026-07-08 18:28 UTC, dt=07-05·06·07 셋 다 닫힌 창입니다(수치 안정).

**파이프라인부터.** 4태스크가 전부 컨테이너 안에서 success:

```
offload       success   dt=2026-07-07, 279,002행 (원천 PG = parquet)
quality_gate  success   3검문 OK → GATE: PASS
transform     success   dbt run PASS=3 · dbt test PASS=18
publish       success   fct_query_daily 1,749행 · mart_query_regression 22행 → DuckLake
```

![Airflow 그래프 뷰에서 offload, quality_gate, transform, publish 4태스크가 전부 success](/uploads/project/lakehouse/e2e-dag-publish.png)

**그리고 화면.** 0편의 질문을 대시보드 이름으로 걸었습니다. 시야가 아직 3일이라 "지난달" 대신 "지난 구간"으로 바꿔서요. "지난 구간보다 느려진 쿼리 있어?"

![Metabase 대시보드 전체 화면으로, 악화 쿼리 수와 일별 호출량 추이, 악화 쿼리 랭킹, 인스턴스 필터가 보인다](/uploads/project/lakehouse/metabase-dashboard.png)

랭킹 표 클로즈업입니다. 답은 "있다"입니다. **instance 8(Oracle)의 `g108q7fj4pmkv`가 구간 첫날 평균 25.89ms에서 마지막 날 64.50ms로, +149.1%** 느려졌습니다. 3부에서 SQL로 캤던 그 값이 이제 클릭 한 번의 화면입니다.

![악화 쿼리 랭킹 클로즈업으로, instance 8이 25.89ms → 64.50ms, +149.1%](/uploads/project/lakehouse/metabase-regression.png)

수치는 세 경로로 대조했습니다. dbt의 DuckDB 파일을 직독하고, Metabase API로 DuckLake를 읽고, 대시보드 화면으로 확인했습니다. 셋 다 같은 값입니다(악화 1위 +149.1%, 일별 delta_calls 합 07-05=624,915 · 07-06=7,458 · 07-07=2,503,874).

필터 배선도 실측입니다. Instance를 8로 좁히면 카드 셋이 같이 좁혀집니다. 악화 쿼리는 4건이고 파일 직독 count와 일치합니다:

![인스턴스 필터를 적용해 instance 8만 남긴 화면, 악화 쿼리 4건](/uploads/project/lakehouse/metabase-dashboard-filtered.png)

**함정 2를 갈아엎은 보람도 실측으로.** publish(커밋 2회)를 돌리면서 Metabase로 0.3초 간격 연속 질의를 41회 쐈습니다. 전부 completed였고 매번 온전한 22행이었습니다. 발행 커밋과 정확히 겹친 읽기도 반쪽 테이블을 본 적이 없습니다. 파일을 물렸을 때(죽거나, 조용히 위험하거나)와 정반대입니다.

미리 적어둘 것: 지금 마트의 시야는 3일(07-05~07)입니다. 아직 DBTower의 7일 보존 안입니다. 하지만 구조가 다릅니다. 원천은 7일이 되는 날 이 스냅샷들을 지우고, lakehouse는 계속 쌓습니다. 이 화면의 시야는 매일 하루씩 자라고, "지난달" 비교는 한 달 뒤에 같은 화면에서 그냥 됩니다. DBTower엔 이 질문에 해당하는 화면 자체가 없고(두 시점 비교까지가 관제의 몫), 그건 0편에서 정리한 대로 결함처럼 보이지만 역할 분리입니다.

### 정직하게 남긴 한계

- **시야가 아직 3일입니다.** 4절에 적은 대로 매일 자라지만, "DBTower로는 데이터 없음 vs lakehouse로는 답이 나옴"의 30일 대비 스크린샷은 적재가 7일을 넘긴 뒤에야 찍을 수 있습니다.
- **인스턴스가 숫자 id로 보입니다.** 원천의 database_instance(이름·기종)를 dim으로 내리지 않아 화면엔 "instance 8"뿐입니다. 기종 라벨이 필요해지면 작은 dim 추출을 추가해야 합니다.
- **Metabase 앱 DB가 H2 단일 파일입니다.** 로컬 데모 규모의 선택이고, 운영이면 PG로 빼고 백업 대상에 넣어야 합니다.
- **알림과 대시보드가 아직 별개입니다.** 게이트 FAIL이 webhook으로는 오지만 대시보드에 배지로 뜨지는 않습니다. 파이프라인 상태 카드가 다음 후보입니다.
- 6부에서 남긴 마트 전체 재빌드(증분 전환), dbt 태스크 분해(Cosmos), 적응형 CHECKPOINT도 그대로 남아 있습니다.

### 원이 닫혔다

0편은 답할 수 없는 질문에서 시작했습니다. 일곱 부를 지나 이제 그 질문은 대시보드 이름이 됐습니다. 매일 새벽 파이프라인이 스냅샷을 내리고, 검문하고, 델타로 갈아 마트를 굽고, DuckLake로 발행하면 화면이 답합니다. "있어. instance 8의 이 쿼리, +149.1%."

버려지던 데이터에 두 번째 삶을 주겠다는 게 이 시리즈의 약속이었습니다. 두 번째 삶이란 결국 **누군가의 질문에 답하는 것**이었습니다. 파이프라인은 그 답을 만드는 공정이었고, 이번 편에서 그 답이 나오는 창구를 달았습니다.

코드는 [GitHub](https://github.com/dj258255/dbtower-lakehouse)에 있습니다.

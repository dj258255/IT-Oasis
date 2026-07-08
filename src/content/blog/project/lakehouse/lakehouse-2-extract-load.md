---
title: '어제치를 안전하게 내리다 — 인덱스 선두를 타는 Extract & Load'
titleEn: 'Offloading Yesterday Safely — Extract & Load That Rides the Index Prefix'
description: "어제 쌓인 스냅샷은 6일 뒤 삭제됩니다. 삭제 전에 MinIO로 안전하게 내려야 하는데, 추출이 관제탑(메타 PG)을 느리게 하면 자기모순입니다. DBTower의 인덱스는 (instance_id, captured_at) 순서라 captured_at 단독 조건은 선두 컬럼을 못 탑니다. 그래서 인스턴스별 등치 질의로 인덱스 선두를 타게 하고, 읽기 전용 세션 + 서버커서로 부하를 눌렀습니다. 멱등성은 파티션 통째 덮어쓰기로. 실측으로 원천 PG 행수 = MinIO parquet = DuckDB count 3자 일치를 확인하고, 닫힌 구간을 두 번 돌려 79,894행이 불변임을(중복 0) 증명합니다. Airflow 스케줄러가 부른 태스크가 원천→parquet→조회까지 정확히 흐른 것도 dags test로 확인했습니다."
descriptionEn: "Yesterday's snapshots get deleted in six days. They must be offloaded to MinIO before that — but if the extraction slows the control tower (metadata PG), it's self-contradictory. DBTower's index is ordered (instance_id, captured_at), so a captured_at-only predicate can't ride the leading column. So I query per instance with an equality predicate to ride the index prefix, and pin down load with a read-only session plus a server-side cursor. Idempotency comes from whole-partition overwrite. Live checks confirm source PG rows = MinIO parquet = DuckDB count agree three ways, and a closed window run twice holds at 79,894 rows (zero duplication). I also verified via dags test that a scheduler-invoked task flows source → parquet → query exactly."
date: 2026-07-08
tags:
  - Airflow
  - PostgreSQL
  - Parquet
  - DuckDB
  - MinIO
  - Idempotency
category: personal/lakehouse
coverImage: /uploads/project/lakehouse/cover.svg
draft: false
series: "lakehouse"
seriesOrder: 2
---

## 0. 상황 — 6일 남은 데이터

어제 자정이 지났습니다. 어제 쌓인 스냅샷은 이제 **6일 남았어요**. DBTower가 7일 뒤 지우니까요. 6일 안에 안전하게 MinIO로 내려야 합니다.

"안전하게"에 두 가지 뜻이 있습니다.

1. **관제탑에 부하를 주지 않기.** 추출 쿼리가 메타 PG를 느리게 하면, 관제 도구를 관제하다 관제를 망가뜨리는 자기모순입니다.
2. **멱등하기.** 같은 날짜를 두 번 돌려도 결과가 같아야 backfill과 재시도가 안전합니다.

## 1. 함정 — 인덱스 선두를 못 타는 조건

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

## 2. 적재 — 명시 스키마와 멱등 덮어쓰기

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

## 3. 실측 — 원천 = parquet = DuckDB

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

### 멱등성 — 닫힌 구간 2회

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

### Airflow 스케줄러 e2e

껍데기 DAG가 아니라 스케줄러가 부른 태스크가 실제로 흐르는지 `airflow dags test`로 확인했습니다.

```
$ airflow dags test snapshot_offload 2026-07-06
created dagrun ... data_interval_start=2026-07-05
offload.py: 적재 완료 dt=2026-07-05 총 149259행
Marking task as SUCCESS
```

여기서 재밌는 게 보입니다. 논리 실행일 `2026-07-06`의 `data_interval_start`는 **2026-07-05**라, 태스크가 처리한 건 dt=2026-07-05입니다. 즉 "어제"를 정확히 집었어요 — Phase 0에서 start_date를 @daily 자정에 정렬해 둔 게 이렇게 맞아떨어집니다. 이 파티션도 원천 149,259 = DuckDB 149,259로 일치했습니다.

![Airflow 성공 런 — snapshot_offload 태스크 SUCCESS](/uploads/project/lakehouse/airflow-run-success.png)

## 4. 잔여 — raw는 아직 질문에 못 답한다

parquet는 내려왔지만, 이 raw는 **아직 "지난달보다 느려진 쿼리"에 답하지 못합니다.** calls/total_time_ms가 누적값이라, 그대로 더하면 의미가 없어요. 일간 델타로 바꿔야 하는데, 그게 [3편](/blog/project/lakehouse/lakehouse-3-transform)의 dbt 변환입니다.

그리고 하나 더. 어느 날 특정 인스턴스의 파티션이 수집 장애로 비면, 그 위에 만든 랭킹은 조용히 오답을 냅니다. 지금은 그걸 잡을 게 없어요. 품질 게이트는 뒤에서 세웁니다.

정직하게 남기는 한계:

- 원천이 라이브라 "완전히 닫힌 최신 구간"은 하루 뒤에야 안정됩니다(어제치 값은 시점 의존).
- 스케줄러 상시 구동은 로컬 리소스를 아끼려 검증 후 정지했습니다 — DAG 구조와 스케줄러 e2e 실행은 위에서 확인한 그대로입니다.

코드는 [GitHub](https://github.com/dj258255/dbtower-lakehouse)에 있습니다.

---
title: '계약 먼저 — DAG를 짜기 전에 무엇을 옮길지부터 못박다'
titleEn: 'Contract First — Nailing Down What to Move Before Writing a Single DAG'
description: "코드부터 짜고 싶었지만 참았습니다. 파이프라인의 버그는 대부분 '계약 불명확'에서 오니까요 — dt 경계가 UTC냐 KST냐, 파티션 키가 뭐냐, 스키마가 바뀌면 옛 파일은 어떻게 읽냐. 그래서 0단계에서는 Airflow(LocalExecutor) 스캐폴드를 세우고, 원천 스키마·파티셔닝·포맷·워터마크를 담은 데이터 계약 문서를 먼저 썼습니다. 공식 docker-compose의 CeleryExecutor 대신 LocalExecutor를 고른 이유, start_date를 @daily 자정에 정렬해 첫 인터벌 어긋남을 막은 이유, 기존 dbtower-minio를 external network로 재사용한 이유를 실측과 함께 기록합니다."
descriptionEn: "I wanted to start with code, but held back. Most pipeline bugs come from an unclear contract — is the dt boundary UTC or KST, what's the partition key, how do you read old files when the schema changes. So in phase 0 I stood up an Airflow (LocalExecutor) scaffold and wrote a data contract first, capturing source schema, partitioning, format, and watermark. I record — with live checks — why I chose LocalExecutor over the official compose's CeleryExecutor, why I aligned start_date to the @daily midnight boundary to avoid a skewed first interval, and why I reused the existing dbtower-minio over an external network."
date: 2026-04-11
tags:
  - Airflow
  - Docker Compose
  - Data Contract
  - Parquet
  - Data Engineering
category: personal/lakehouse
coverImage: /uploads/project/lakehouse/cover.svg
draft: false
series: "lakehouse"
seriesOrder: 1
---

## 0. 상황 — 코드부터 짜고 싶은 유혹

[0편](/blog/project/lakehouse/lakehouse-0-why)에서 "버려지는 7일을 분석계로 내린다"는 방향을 잡았습니다. 이제 DAG를 짜고 싶었어요.

참았습니다. 파이프라인의 버그는 대부분 코드가 아니라 **계약 불명확**에서 옵니다.

- dt 경계가 UTC냐 KST냐? (하루가 어긋나면 어제 데이터가 두 파티션에 쪼개집니다.)
- 파티션 키가 뭐냐? (나중에 바꾸면 그동안 쌓은 파일을 못 읽습니다.)
- 스키마가 진화하면 옛 파일은 어떻게 읽냐?
- calls 같은 숫자가 **누적값이냐 구간값이냐?** (이걸 착각하면 2단계의 모든 집계가 조용히 틀립니다.)

이걸 코드로 먼저 굳혀 버리면, 나중에 규칙이 흔들릴 때 backfill이 통째로 깨집니다. 그래서 0단계의 목표는 "돌아가는 DAG"가 아니라 **계약과 스캐폴드**입니다.

## 1. 계약 — 원천을 코드로 먼저 확인하다

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

## 2. 스캐폴드 — LocalExecutor를 고른 이유

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

### 함정 — start_date와 @daily 정렬

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

## 3. 실측 — 뜨는지 확인

```
$ docker compose up -d
$ docker exec ... airflow dags list-import-errors
No data found                         # 임포트 에러 0

$ docker exec ... airflow dags list
snapshot_offload | .../snapshot_offload.py | airflow | True
```

DAG가 임포트 에러 없이 목록에 뜹니다. MinIO health는 200, Airflow 웹서버는 `:8080`에 올라옵니다.

![Airflow UI — snapshot_offload DAG가 임포트 에러 없이 목록에 뜬다(태그 el·extract·lakehouse, @daily)](/uploads/project/lakehouse/airflow-dag.png)

DAG는 떴지만 아직 껍데기입니다. MinIO 버킷은 비어 있어요 — 실제 데이터가 흐르는 건 다음 편입니다.

## 4. 잔여 — 아직 데이터는 안 흐른다

0단계는 여기까지입니다. 계약이 서고 스캐폴드가 떴지만, **아직 한 줄도 안 옮겼어요.** DAG는 껍데기고, MinIO 버킷은 비어 있습니다.

다음 편에서 그 껍데기에 실제 추출·적재 로직을 넣습니다. 그리고 마주칠 함정이 하나 예고돼 있어요 — DBTower의 인덱스는 `(instance_id, captured_at)` 순서라, `captured_at` 단독 조건으로 뽑으면 인덱스 선두를 못 탑니다. 관제탑을 느리게 하지 않으면서 어제치를 안전하게 내리는 방법이 [2편](/blog/project/lakehouse/lakehouse-2-extract-load)의 주제입니다.

코드는 [GitHub](https://github.com/dj258255/dbtower-lakehouse)에 있습니다.

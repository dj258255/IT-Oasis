---
title: '7일이면 버려지는 스냅샷을 장기 이력으로 살려낸 dbtower-lakehouse 실측 11절 총정리'
titleEn: 'How dbtower-lakehouse Turns Seven Days of Doomed Snapshots into Long-Term History, in 11 Measured Sections'
description: 'DBTower가 7일 뒤 버리는 쿼리 스냅샷을 컬럼형 저장소로 내려 장기 이력을 만드는 ELT 파이프라인의 전체 기록을 한 편에 정리합니다. 오케스트레이션은 Airflow, 적재는 MinIO의 Parquet입니다. 변환은 dbt가 맡고 질의는 DuckLake로 합니다. 문제 정의(7일 시야로는 ''지난달 대비 느려진 쿼리''에 못 답함)에서 시작해, 원천·적재·조회 3자 일치로 검증한 멱등 추출(닫힌 창 07-05=149,259·07-06=79,894), 누적 카운터를 일간 델타로 접는 변환, 조용한 오답을 막는 4축 fail-closed 게이트(장애 주입 시 dbt 미실행 차단), lake를 house로 올리는 DuckLake 타임트래블·롤백을 담았습니다. 아카이브가 자신을 지우던 치명 결함의 시연과 차단, 1년치를 합성해 병목을 지목하고 증분 전환으로 407.62초를 4초로 줄인 규모 실측, 그리고 Kafka를 넣지 않은 근거까지 담았습니다. 모든 수치는 직접 측정했고 재현 기록이 저장소에 있습니다.'
descriptionEn: 'The complete story of a pipeline that offloads DBTower''s soon-to-expire query snapshots into columnar storage to build long-term history. It is orchestrated by Airflow, landed as Parquet in MinIO, transformed by dbt, and queried by DuckLake. From problem definition (a seven-day window can''t answer ''which query got slower than last month'') through idempotent extraction verified by source/load/query three-way agreement, cumulative-to-daily-delta transformation, a four-axis fail-closed quality gate that blocks dbt on injected faults, DuckLake time travel and rollback that turn a lake into a house, the reproduction and blocking of a critical fault where the archive deleted itself, a scale test on a synthesized year that pinpointed the bottleneck and cut a 407.62s rebuild to 4s, and the reasoning behind not adding Kafka. Every number was measured firsthand; the reproduction log lives in the repo.'
date: 2026-07-10
tags:
  - Airflow
  - dbt
  - DuckDB
  - MinIO
  - Data Engineering
  - ELT
category: personal/lakehouse
coverImage: /uploads/project/lakehouse/cover.svg
draft: false
series: "lakehouse"
seriesOrder: 0
---

## 0. 이 글 하나로

이 글은 dbtower-lakehouse 시리즈 본편 여섯 편의 총정리입니다. 시리즈를 안 읽어도 이 한 편으로 전체가 파악되게 썼고 깊이가 필요한 지점마다 해당 편을 링크했습니다.

한 줄로 요약하면 **[DBTower](/blog/project/dbtower/dbtower-0-overview)가 7일 뒤 버리는 쿼리 스냅샷을, 버려지기 직전에 컬럼형 저장소로 내려(ELT) 장기 이력으로 만드는 데이터 파이프라인**입니다. 오케스트레이션은 Airflow, 적재는 MinIO의 Parquet입니다. 변환은 dbt가 맡고 질의는 DuckLake로 합니다. 코드는 [GitHub](https://github.com/dj258255/dbtower-lakehouse)에 공개되어 있습니다.

숫자부터 놓고 시작하겠습니다. 전부 직접 측정했고, 재현 명령과 원천 대조가 담긴 기록([VERIFICATION.md](https://github.com/dj258255/dbtower-lakehouse/blob/main/docs/VERIFICATION.md))이 저장소에 있습니다.

| 항목 | 수치 |
|---|---|
| 검증 원칙 | 원천 PG = Parquet = DuckDB **3자 일치** (닫힌 창 07-05=149,259 · 07-06=79,894행) |
| 멱등성 | 같은 날짜 2회 실행 → 행수·오브젝트 수 불변 (79,894행 / 파티션 6개) |
| 품질 게이트 | 4축 fail-closed로 장애 주입 시 dbt를 아예 실행하지 않음 (exit 2) |
| lake→house | DuckLake 타임트래블·롤백·PG 카탈로그 격리 (과거 버전 행수·행 값 복원) |
| 규모 병목 | 1년치(2,190파일·54.5M행) 합성 실측 → fct 전체 재빌드 **407.62s**가 유일 병목 |
| 증분 전환 | 그 수치가 정당화 → 407.62s → **4s (~100배)** |
| 테스트 / CI | pytest 57 + dbt build PASS=26(unit test 5·계약·데이터 테스트), GitHub Actions 3관문 |

측정 환경은 macOS + Docker 위의 로컬 스택입니다. 원천(DBTower)이 라이브로 수집 중이라, 검증은 값이 더 자라지 않는 **닫힌 UTC 구간**으로만 했습니다. 이 규율은 뒤에서 다시 설명합니다.

## 1. 답할 수 없던 질문이라는 문제

[DBTower](/blog/project/dbtower/dbtower-0-overview)를 석 달쯤 운영하고 나서, 누군가 물었다고 해봅시다. **"지난달보다 이번 달에 느려진 쿼리 있어?"**

답할 수 없습니다. DBTower의 쿼리 스냅샷은 **7일 뒤 삭제**됩니다. 이건 버그처럼 보이지만 의도된 설계입니다. 관제 도구가 관측 데이터를 무한히 쌓으면 메타 DB가 관리 대상보다 먼저 포화됩니다. 그래서 보존을 7일로 뒀습니다(`SnapshotRetentionJob` + `retention-days: 7`). AWS Performance Insights의 무료 티어가 정확히 7일 보존인 것과 같은 선례입니다.

문제는 관제의 시야가 **"지금~최근 7일"**이라는 점입니다. 이건 관제 도구로서는 올바른 설계입니다. 하지만 이런 질문들은 그 설계로는 구조적으로 못 답합니다.

- "지난 분기 대비 가장 악화된 쿼리 TOP 10은?"
- "이 인스턴스의 3개월 성장 추세로 볼 때 용량 증설 시점은?"
- "기종별로 장기 레이턴시 분포가 어떻게 다른가?"

전부 **장기 이력**이 있어야 답할 수 있는 질문입니다. 판단은 실무에서 프로덕션 DB(OLTP)와 데이터 웨어하우스(분석)를 분리하는 그 원칙 그대로입니다. **관제(DBTower)는 지금에 최적화된 채로 두고 장기 분석은 별도 계층으로 뺍니다.** 방법은 버려지기 직전의 스냅샷을 컬럼형 저장소로 내리는 것, 데이터 엔지니어링에서 ELT(Extract, Load, Transform)라 부르는 흐름입니다.

![query_snapshot을 Airflow로 추출·적재하고 dbt로 집계해 DuckDB/DuckLake로 질의하며 그 사이에 데이터 품질 게이트를 둔 dbtower-lakehouse 파이프라인 구조](/uploads/project/lakehouse/architecture.svg)

즉 이 프로젝트는 **버려지는 관측 데이터의 두 번째 삶**입니다. DBTower가 7일 만에 버리는 데이터를, 분석계가 받아 오래 기억하는 것입니다. 스택은 2026년 기준 소규모 팀의 정석 계보(Airflow + dbt + Parquet/객체스토리지 + DuckDB + DuckLake + Metabase)이고, 각 선택의 근거는 뒤에서 수치로 답합니다.

단계 관점으로 다시 그리면 셋으로 접힙니다. 추출·적재(EL)가 원천을 다치지 않게 내립니다. 검증과 변환은 게이트와 dbt의 몫이고, 발행부터 서빙·감시까지는 DuckLake와 Metabase가 받습니다. 각 단에 그 단만의 안전장치(자기파괴 가드, fail-closed 게이트, deadman)가 붙어 있는 게 이 파이프라인의 성격입니다.

![파이프라인 흐름을 추출·적재, 검증·변환, 발행·서빙·감시 3단과 각 단의 안전장치로 나눠 그린 그림](/uploads/project/lakehouse/pipeline-flow.svg)

구조를 한 단계 더 뜯어보면 이렇습니다. 컨테이너 경계와 포트(원천 PG 15432 · MinIO 19000 · Airflow 8080 · Metabase 13001), 다섯 태스크 체인 `offload → quality_gate → transform → publish → heartbeat`, 품질 FAIL 시 webhook으로 빠지는 분기, 성공 신호(heartbeat)를 역방향으로 감시하는 deadman, 주간 CHECKPOINT 유지보수까지 담은 것이 위 그림의 상세판입니다.

![Airflow 태스크 체인과 FAIL 분기, MinIO 경로 레이아웃, DuckLake 카탈로그(PG)와 데이터(S3) 분리, Metabase read-only를 담은 상세 서버·데이터 아키텍처](/uploads/project/lakehouse/architecture-detail.svg)

데이터가 어떤 모양으로 흐르는지도 컬럼 단위로 그렸습니다. 원천 두 테이블(`query_snapshot`·`database_instance`)에서 raw parquet(dt·instance_id 파티션 키), staging의 SUM 정규화, `fct_query_daily`의 일간 델타, 그리고 `mart_query_regression`의 롤링 윈도우 컬럼과 운영 테이블(`pipeline_run_log`·`pipeline_heartbeat`)까지의 계보입니다. `fct_query_daily`의 일간 델타는 누적 카운터가 일간 발생량으로 접히는 변환 지점입니다.

![원천에서 마트·운영 테이블까지의 컬럼 계보와 누적에서 일간 델타로 접히는 변환 지점을 표기한 데이터 모델](/uploads/project/lakehouse/erd.svg)

## 2. 단계별로 본 개선 아크 요약 (상황 → 만든 것 → 핵심 실측)

시리즈는 "어떤 상황에서 무엇이 깨지고, 그래서 무엇을 만드는가"의 개선 아크로 씁니다. 전/후가 있는 건 전/후로 실측했습니다. 표의 단계 번호는 저장소 [ROADMAP](https://github.com/dj258255/dbtower-lakehouse/blob/main/docs/ROADMAP.md)의 아크 번호라서 블로그 편 번호와 다릅니다. 열 단계를 본편 여섯 편(1~6편)으로 묶었고 각 행에 해당 편을 링크했습니다. 4단계(Serve)는 반쪽 데이터 위 서빙을 피하려 7단계(대시보드)에서 함께 구현해 표에선 7단계 행에 합쳤습니다.

| 단계 | 상황 | 만든 것 | 핵심 실측 |
|---|---|---|---|
| 1 EL: [1편](/blog/project/lakehouse/lakehouse-1-contract-and-load) | 6일 뒤 삭제 전 안전하게 내려야 | 인덱스 선두를 타는 인스턴스별 추출 + 파티션 통째 덮어쓰기 | 원천·적재·조회 **3자 일치**, 같은 날짜 2회 실행에 79,894행·오브젝트 6 불변 |
| 2 변환: [2편](/blog/project/lakehouse/lakehouse-2-transform-and-gate) | 누적값 raw로는 "느려진 쿼리"에 답 못 함 | 하루 first-vs-last 차분 + `GREATEST(0,…)` 리셋 클램프 | 지문 충돌 12,743키를 SUM으로 접고, 순리셋 219그레인을 0에 클램프(음수 0건) |
| 3 품질 게이트: [2편](/blog/project/lakehouse/lakehouse-2-transform-and-gate) | 반쪽 파티션 위 랭킹이 조용히 오답 | reconciliation·completeness·freshness·스키마 드리프트 4축 fail-closed | inst 3 파티션(20,158행) 삭제 주입 → 2축 동시 FAIL, **dbt 미실행(exit 2)** |
| 5 DuckLake: [3편](/blog/project/lakehouse/lakehouse-3-ducklake-and-ops) | 덮어쓰기만으론 ACID·타임트래블 없음 | PG 카탈로그 + S3 데이터 테이블 포맷 | 과거 버전 행수·행 값 복원(0.55→1000.55), ROLLBACK로 229,153 원복 |
| 6 운영 경화: [3편](/blog/project/lakehouse/lakehouse-3-ducklake-and-ops) | 막았는데 아무도 모름 + transform이 수동 | 컨테이너 내 dbt e2e·webhook·retry·CHECKPOINT | 3태스크 한 컨테이너 success, CHECKPOINT 스냅샷 **11→2**(행수 불변) |
| 4·7 대시보드: [4편](/blog/project/lakehouse/lakehouse-4-dashboard) | 마트는 있는데 소비자가 없음 | Metabase가 DuckLake를 read-only로 | DuckDB 파일 직결 실격 판정, 악화 랭킹 instance 8 **+149.1%** 3자 대조 |
| 8 감사 소탕: [5편](/blog/project/lakehouse/lakehouse-5-audit-and-trust) | 장치가 자기 원칙을 자신엔 안 씀 | 아카이브 자기파괴 가드·게이트 인덱스·발행 원자성 | 게이트 Seq Scan **332ms → Index 20ms**, pytest 35 |
| 9 신뢰: [5편](/blog/project/lakehouse/lakehouse-5-audit-and-trust) | 테스트는 로컬 자산, 침묵은 못 잡음 | CI 3관문·deadman heartbeat·dbt contracts | 30h 침묵 경보 발화, 계약 위반 주입 시 **빌드 차단**(data type mismatch) |
| 10 규모: [6편](/blog/project/lakehouse/lakehouse-6-scale-and-serve) | 며칠치로는 "버틴다"를 증명 못 함 | 365dt 합성 → 증분 전환·롤링 윈도우·운영 대시보드 | fct 전체 재빌드 **407.62s → 4s**, 파일 평균 177KB(128MB 타깃의 1/741) |

아래에서 각 아크의 핵심만 짚습니다.

### 부하가 되지 않게 내리는 EL

DBTower의 "진단이 부하가 되면 안 된다" 원칙을 파이프라인에도 옮겼습니다. 추출은 **관측 전용 메타 PG에서만**, 세션을 `readonly=True`로 열어 쓰기 자체를 차단하고 운영 대상 DB(mysql/oracle 등)는 건드리지 않습니다. 원천 인덱스 `idx_snapshot_instance_time(instance_id, captured_at)`의 선두 컬럼을 타도록 인스턴스별 등치 질의로 루프하고 서버커서로 결과 전체를 메모리에 올리지 않습니다.

멱등성은 닫힌 구간에서 검증했습니다. dt=2026-07-06을 두 번 돌려도 원천 PG count·parquet·DuckDB가 전부 79,894행으로 불변이고 파티션 오브젝트도 인스턴스당 1개(총 6개)로 누적되지 않습니다. 파티션을 통째로 덮어쓰기 때문에 backfill이 안전합니다. Airflow 스케줄러 e2e(`airflow dags test`)까지 원천→parquet→조회가 정확히 흘렀고(dt=07-05 = 149,259행 일치), data interval 정렬로 "어제"의 의미가 어긋나지 않는 것도 실증했습니다.

### 누적 스냅샷을 일간 델타로 바꾸는 변환

raw를 시간순으로 늘어놓으면 `calls`가 302→55→302→56처럼 감소가 섞여 가짜 리셋으로 보입니다. 원인은 `(instance_id, query_id, captured_at)` 중복 **12,743키**입니다. 같은 지문에 둘 이상의 누적 계열이 얽혀 있습니다("SHOW REPLICA STATUS"가 302 계열과 55 계열로 동시 존재). id는 스냅샷마다 새로 발번되는 전역 PK라 계열 식별자가 못 됩니다. 해법은 staging에서 지문·시점별로 누적값을 SUM해 단조 비감소 계열을 복원하는 것.

차분 방식은 **하루 first-vs-last(양 끝 차분)**를 택했습니다. DBTower `ComparisonService`의 `Math.max(0, end.calls - start.calls)`와 같은 원리라 교차검증이 됩니다. 대안인 인접 델타 합산(Prometheus rate 방식)은 쿼리가 사라졌다 재등장할 때 유령 증가분을 과대계상합니다. 실측으로 총 delta_calls가 22,264,704 vs first-vs-last 3,126,579로 벌어졌습니다. SUM-dedup 후에도 남는 순리셋 219그레인은 `GREATEST(0,…)`로 0에 클램프했고 결과 최솟값이 0(음수 0건)인 것으로 확인했습니다. `dbt run` PASS=3, `dbt test` PASS=18.

### 품질 게이트, 조용히 틀린 데이터는 없는 것보다 나쁘다

수집 장애로 빈 파티션 위에 만든 "악화 쿼리 랭킹"은 조용히 오답을 냅니다. 다운스트림(dbt) 앞에 검문소를 세웠습니다. 네 축입니다. reconciliation(원천 PG 행수 == parquet 행수), completeness(레지스트리 기대 인스턴스가 전부 존재), freshness(수집 중단 탐지), 스키마 드리프트(유실·타입 변경 FAIL)입니다.

동작은 **fail-closed**입니다. 한 dt라도 FAIL이면 dbt를 아예 호출하지 않고 종료코드 2로 빠집니다. 장애 주입으로 dt=07-06의 instance_id=3 파티션(20,158행)을 통째로 삭제하자, reconciliation(79,894 vs 59,736)과 completeness(누락 [3])가 동시에 잡고 dbt가 SKIPPED됐습니다. 정상 dt(07-05·07-07)는 통과, 문제 dt만 차단. Airflow에서도 `quality_gate` 태스크가 예외를 던져 `transform`이 `upstream_failed`로 실행되지 않는 것을 실측했습니다.

![품질 게이트가 정상은 통과시키고 장애 주입 시엔 FAIL로 차단하는 모습](/uploads/project/lakehouse/quality-gate.png)

### lake를 house로 끌어올린 DuckLake

raw 파티션 덮어쓰기는 정확·멱등하지만 ACID도 타임트래블도 없어 엄밀히는 "lake"입니다. 그 위에 테이블 포맷 DuckLake를 얹었습니다. **카탈로그는 PostgreSQL**(로컬에 이미 PG가 있어 서비스 추가 0, 단 DBTower 메타 DB와 분리된 `ducklake_catalog`), **데이터 파일은 MinIO(S3)**. 카탈로그 테이블 30개가 PG에 생기고 DBTower 메타 DB 안의 `ducklake_%` 테이블은 0개라 원천 메타는 오염되지 않습니다.

타임트래블이 lake와 house를 가르는 지점입니다. 같은 테이블·같은 쿼리인데 버전 지정(`AT (VERSION => n)`)만으로 과거 상태를 그대로 되살렸습니다.

```
count @ v2 (07-06만 적재 직후)  = 79,894
count @ v3 (07-05까지 적재 직후) = 229,153
total_time_ms @ v3(과거) = 0.55       -- UPDATE 이전
total_time_ms @ v4(현재) = 1000.55    -- UPDATE 이후
```

원자성도 확인했습니다. 트랜잭션 안에서 149,259행을 지워도 `ROLLBACK` 하면 229,153행으로 흔적 없이 되돌아가고 스냅샷(버전)도 남기지 않습니다. raw 덮어쓰기로는 불가능했습니다.

### 운영 경화, 실패해도 아무도 모르는 파이프라인은 미완성

fail-closed 게이트가 반쪽 데이터를 잘 막았는데, 막았다는 사실을 아무도 모르면 마트가 조용히 낡아갑니다. 게다가 5단계까지 transform 태스크는 컨테이너에 dbt가 없어 실제 빌드가 호스트 수동 실행이었습니다. DAG는 3단계인데 마지막이 사람 손이면 반쪽 오케스트레이션입니다. Dockerfile로 분리 venv(`/opt/dbt-venv`)에 dbt-duckdb를 얹어 세 태스크가 처음으로 한 컨테이너 안에서 끝났습니다(dbt run PASS=3 · test PASS=18).

차단에 통보를 붙였습니다. `on_failure_callback`으로 webhook에 JSON을 POST하고(로컬 수신기에 HTTP 200 실수신 확인), retry는 지수 백오프(2→4→8분)를 두되 `quality_gate`만 `retries=0`(품질 FAIL은 결정적이라 재시도 무의미). 모든 PG DSN에 `connect_timeout=5`를 넣어 원천이 죽었을 때 무한 대기 대신 5초에 실패시켰는데 이건 실제로 원천 스택 다운 시 무한 대기 사고를 겪고 넣은 방어입니다. DuckLake CHECKPOINT(@weekly)는 churn을 만든 뒤 스냅샷 11→2, S3 오브젝트 7→3, 바이트 7,337,540→2,828,889로 정리하면서 테이블 행수는 229,153으로 불변인 것을 전/후 대조했습니다.

### 마트에 소비자를 붙이는 대시보드

1절의 질문을 던진 사람은 DuckDB 셸에 SQL을 치는 사람이 아닙니다. Metabase를 붙였는데 함정이 셋이었습니다. (1) 공식 이미지가 Alpine(musl)이라 DuckDB JDBC 네이티브 라이브러리가 안 떠서 Debian 기반 커스텀 이미지로 교체했고, (2) dbt의 DuckDB 파일 직결은 읽히긴 하지만 **서빙 계층 실격**입니다. 파일은 프로세스 간 단일 쓰기라 같은 호스트에선 transform이 잠금 충돌로 죽고 컨테이너 경계(virtiofs)에선 잠금이 전파되지 않아 쓰기 도중 읽기가 무방비가 됩니다(시끄럽게 죽는 것보다 나쁨). 그래서 마트를 DuckLake로 발행하고 Metabase는 DuckLake만 읽게 해 동시성 중재를 파일 잠금에서 PG 트랜잭션으로 넘겼습니다.

수치는 세 경로(DuckDB 파일 직독·Metabase API·대시보드 화면)로 대조했고 전부 일치했습니다. 악화 1위는 instance 8로 first→last 25.89→64.50ms, **+149.1%**였습니다. 발행(쓰기) 중 0.3초 간격 연속 41회 읽기가 전부 온전한 22행을 봤고(DuckLake 스냅샷 격리), 파일 케이스와 정반대 결과입니다.

![Metabase 대시보드에 뜬 악화 쿼리 랭킹과 일별 추이](/uploads/project/lakehouse/metabase-dashboard.png)

## 3. 아카이브가 자신을 지우는 경로를 다룬 심층 사례

포트폴리오용 요약은 접고 실제 결함 하나를 통째로 보여드릴게요([5편](/blog/project/lakehouse/lakehouse-5-audit-and-trust) 상세). 내가 만든 걸 스스로 감사하다 잡은 것 중 제일 무서운 결함이었습니다.

**정상 상태**에서 offload는 멱등을 위해 파티션을 통째로 덮어씁니다. `delete-first`, 즉 기존 파티션 오브젝트를 지우고 새로 씁니다. 원천에 데이터가 있는 한, 지운 자리에 같은 데이터가 다시 써지니 안전합니다.

**문제 상황**은 이렇습니다. 원천 보존(7일) 밖의 dt를 backfill이나 Clear로 재실행하면 어떻게 되는지 봅시다. 그 dt는 원천 PG에 이미 0행입니다. 하지만 MinIO의 parquet는 **유일본**으로 남아 있습니다(그게 아카이브의 존재 이유니까). 그런데 코드에서 `_delete_prefix()`가 `if table is None: continue`(원천 0행이면 스킵)보다 **먼저** 실행됐습니다.

```
INFO 기존 파티션 오브젝트 1개 삭제 (raw/query_snapshot/dt=2026-06-01/instance_id=1/)
INFO instance 1: 해당 날짜 데이터 없음 → 스킵
INFO 적재 완료 dt=2026-06-01 총 0행          # exit 0 — '성공'
# after: (dt=2026-06-01 파티션 아래 오브젝트 없음)  ← 유일본 소멸, 복구 불가
```

유일본을 지우고 아무것도 안 쓰고 **성공(exit 0)으로 끝납니다.** 아카이브의 존재 이유를 정면으로 부정하는 치명 결함입니다. 실데이터와 무관한 dt=2026-06-01에 가짜 파티션(3행, 2,665바이트)을 심어 재현했습니다(원천은 읽기 전용 유지).

**구조적 원인**을 보면 멱등 덮어쓰기의 `delete→write`는 "쓸 데이터가 반드시 있다"를 암묵 전제합니다. 보존 창 안에서는 참이지만, 창 밖에서는 그 전제가 깨지면서 delete만 남고 write가 사라집니다. fail-closed 원칙을 게이트(읽기 경로)에는 적용했으면서, 정작 **쓰기 경로에는 적용하지 않은** 뒷면이었습니다.

**수정**했습니다. 원천 0행 + 파티션 존재 시 삭제 없이 시끄럽게 실패시킵니다.

```
ArchiveSelfDestructError: 원천 0행인데 기존 파티션 오브젝트가 존재 — 보존 창 밖
재적재로 판단. 이 파티션이 유일본일 수 있어 삭제를 거부한다(fail-closed). ...
# exit 1 → Airflow 재시도·webhook 알림 경로 탑승
# after: s3://lakehouse/raw/.../part-000.parquet 2665 bytes  ← 유일본 보존
```

원천 0행 + 파티션도 없음 → 기존처럼 스킵. 원천 N행 → 기존 멱등 경로 그대로. 세 갈래를 갈라 위험한 한 갈래만 fail-closed로 막았습니다. 같은 감사 라운드에서 게이트 자신이 원천을 Seq Scan하던 결함(EXPLAIN 332ms → Index Only Scan 20ms)과 발행 혼합 버전 결함(개별 커밋 → 단일 트랜잭션)도 잡아 pytest 35개로 고정했습니다.

## 4. 며칠치로는 "버틴다"를 증명하지 못하는 규모 문제

9단계까지 모든 실측은 닫힌 dt 3개(수십만 행)에서 돌았습니다. 그 규모에선 전부 초 단위라 "규모에서도 버틴다"고 말하고 싶어지는데, 며칠치 수치로는 증명이 안 됩니다. 희망일 뿐입니다. fct 마트는 매일 O(전체 이력)을 다시 계산하는데, 이력이 3일이라 안 아팠을 뿐입니다. 그래서 **1년치를 실제로 만들어** 어디가 먼저 무너지는지 쟀습니다([6편](/blog/project/lakehouse/lakehouse-6-scale-and-serve)).

닫힌 dt parquet를 날짜 시프트 복제해 **365dt × 6인스턴스 = 2,190파일(54,479,535행, 396.6MB)**을 격리 프리픽스에 생성했습니다(실데이터·원천 무접촉, 끝나고 2,196 오브젝트 전부 정리).

| 단계 | 규모(365dt·2,190파일) | 병목 |
|---|---|---|
| dbt fct 전체 재빌드 | **407.62s** | **1순위** |
| DuckDB 전체 글롭+count | 3,471ms (54.5M행) | O(이력) |
| S3 list_objects_v2 전체 | 2,182ms | 글롭 |
| dbt mart 재빌드 | 0.31s | 아니오(사전집계) |
| 게이트/verify per-dt | 8–22ms | 아니오(O(1 파티션)) |
| DuckLake CHECKPOINT(1년 커밋) | 0.47s (366→1파일) | 아니오 |
| 파일 크기 | 평균 177KB | **128MB 타깃의 1/741** |

병목은 명백히 **fct 전체 재빌드(407.62s) 하나**입니다. 나머지는 규모에서도 초 단위입니다. mart는 사전집계라 0.31s, 게이트는 dt별 파티션만 봐서 이력과 무관, CHECKPOINT는 1년치 366커밋이 쌓은 소파일을 1파일로 컴팩션하는 데 0.47s입니다. 파일 평균 177KB는 실무 합의 타깃(128MB~1GB)의 1/741로 소파일 폭증이 있지만, 그 고통은 글롭 리스팅과 커밋 누적으로 나타나고 후자는 CHECKPOINT가 값싸게 흡수합니다.

**수치가 요구하니 전환했습니다.** 전체 재빌드 407.62s는 매일 돌리면 날마다 7분씩 쓰는 셈입니다. 그런데 fct의 grain은 dt 단위로 완전 독립(하루 발생량 = 그날 파티션 양 끝 차분)이라 새 dt만 계산해도 결과가 같습니다. `delete+insert` + `unique_key=(instance,query,dt)`로 증분화했습니다. 함정이 하나 있었습니다. `where dt >= (select max(dt) from {{ this }})` 스칼라 서브쿼리로는 DuckDB가 hive 파티션 프루닝을 못 해 2,190파일을 전부 스캔했습니다(증분인데 2분+ 타임아웃). 워터마크를 `run_query`로 **컴파일 타임 리터럴**로 구워 넣자 파티션 경로 프루닝이 걸려 최신 dt만 읽었습니다.

| | fct 전체 재빌드 | fct 증분(1 dt 추가) |
|---|---|---|
| 소요(wall) | **407.62s** | **4s** |
| 읽는 파일 | 2,190 | 워터마크≥ dt만(~6–12) |

약 **100배+**. microbatch 전략은 event_time 필수·unique_key로 파티션 교체 불가 제약이 있어 delete+insert를 택했고, 반대로 mart는 규모에서도 0.31s라 증분화하지 않았습니다. 초 단위인 곳을 최적화하면 복잡도만 늘어납니다. 문제 없는 곳은 손대지 않는 것도 판단입니다.

## 5. 정직성과 트레이드오프

이 프로젝트에서 기능만큼 공들인 게 "무엇을 수치로 쓸 수 있고 없는지"의 규율입니다.

- **닫힌 창만 수치로 쓴다.** 원천(DBTower)이 실측 시점에 라이브로 수집 중이라 dt=07-07 같은 열린 창은 값이 계속 자랍니다(268,952 → 269,354 → 279,002). 재적재 직후 그 순간엔 PG=parquet로 맞지만 다음 순간 또 벌어질 수 있습니다. 그래서 안정 통과의 근거는 값이 불변인 닫힌 창(07-05=149,259 · 07-06=79,894)에만 뒀습니다. 원천 수집기가 07-07 23:04에 멈춘 뒤로는 그 세 날이 전부 닫혀 마트가 안정됐습니다.
- **DuckLake vs Iceberg.** 표준은 Iceberg입니다. 하지만 DuckDB에서 Iceberg 쓰기는 REST 카탈로그 서버가 필수라(path 기반은 읽기 전용) 로컬 단일노드에 서비스가 하나 더 늡니다. DuckLake는 카탈로그를 이미 쓰던 PG에 SQL로 두고 데이터는 parquet라 서비스 추가가 0입니다. 타임트래블·스키마 진화 개념은 동일하므로 멀티엔진 연합이 필요해지는 시점의 Iceberg 전환은 어댑터 문제로 남깁니다. 정직하게 말하면 이 규모엔 Iceberg가 과할 뿐, 지원되지 않아서 못 쓰는 게 아닙니다.
- **자체 게이트 vs elementary.** dbt 관측성 도구 elementary는 자체 4축 게이트 + webhook과 역할이 겹칩니다. 도구를 늘리기보다 게이트를 키웠습니다. 마찬가지로 dbt source freshness도 게이트 freshness 검문과 중복이라, 같은 판정을 두 군데서 내려 기준이 갈라지지 않게 게이트를 단일 진실로 뒀습니다.
- **지문 충돌 SUM은 근사입니다.** 서로 다른 물리 쿼리를 하나로 합치기 때문입니다. id로 계열을 완벽히 분리하진 못합니다(id는 스냅샷마다 새로 발번). 지문 단위 '총 활동'까지가 정직한 한계이고, 그렇게 적었습니다.

관제·분석 도구의 출력은 운영 결정의 입력이 됩니다. 과장된 수치는 버그보다 나쁘다고 생각합니다.

## 6. Kafka 판정과 안 하기로 한 것

"왜 안 넣었는지 안다"가 "많이 넣었다"보다 강점이라고 생각합니다. 실무 실태를 웹 리서치로 조사해 근거를 박았습니다.

**Kafka를 넣지 않는 것이 실무적 정답입니다.** 조직 단위 채택률과 파이프라인 단위 실사용은 완전히 다른 그림입니다. 벤더 서베이는 높게 나오지만(Confluent 2025: "86%가 스트리밍 투자 우선순위") 이는 조직 어딘가에서 쓴다는 뜻이지 파이프라인 다수가 스트리밍이란 뜻이 아닙니다. 실무 바닥은 반대입니다. 시니어 패널은 "'실시간' 요구의 90%를 물리쳤다"고 하고, BigQuery 실사용 분석은 쿼리의 90%가 100MB 미만을 처리한다고 합니다. 채택 조건은 세 가지(①초~분 단위 신선도가 돈이 되고 ②동일 이벤트 소비자가 여럿이고 ③분산시스템 운영 여력이 있을 때)인데, 이 파이프라인은 셋 다 아닙니다. 스냅샷 원천이라 붙일 이벤트 스트림 자체가 없고, 일 단위 SLA에, 소비자는 하나입니다. 준실시간 신선도가 필요해지면 그때도 풀 Kafka 대신 **Debezium Server(단독) 같은 경량 CDC**가 2025~2026 실무 흐름이고, 그마저도 이 저장소 밖, 별도 수집 계층의 일입니다.

같은 논리로 안 하기로 한 것들과 이유입니다.

- **Spark**는 단일 노드 DuckDB로 수년치 처리가 가능해 필요 없습니다(컬럼형 + 파티션 프루닝). 메모리·로컬 디스크 한계를 실측으로 넘으면 그때 이야기입니다.
- **Iceberg/Delta**는 멀티엔진(Spark·Trino·Flink)이 한 테이블을 공유하는 조직 표준입니다. 단일 엔진(DuckDB) 규모엔 DuckLake가 맞고 전환은 어댑터 문제입니다.
- **OpenLineage/Marquez**는 아직 필요 없습니다. 계보 소비자가 하나라 dbt docs의 문서 계보로 충분하기 때문입니다. 계보를 질의할 팀이 생기면 그때 가면 됩니다.
- **Cosmos(dbt→Airflow 태스크 분해)**는 모델 3개짜리에서 태스크 그래프 분해라 오버헤드만 더합니다.
- **클라우드 DW(BigQuery)** 대신 로컬 재현성을 택했습니다. dbt 어댑터 교체로 이전할 수 있습니다.

그리고 이 로드맵이 실제로 향한 방향(CI·deadman·규모 실측·롤링 윈도우·contracts)은 서베이가 집계한 실무 고통 순위와 그대로 겹칩니다.

| 실무 고통 (근거 수치) | 이 프로젝트의 대응 |
|---|---|
| 1. 조용한 실패(스테이크홀더가 먼저 발견 74%, 해결 평균 15시간) | 4축 fail-closed 게이트 + webhook + **deadman heartbeat**로 '미실행'까지 |
| 2. 스키마 변경이 다운스트림 파괴 | 드리프트 게이트 + **dbt contracts**로 발행 전 빌드 차단 |
| 3. 비용 통제 | 스캔량·저장량 대응물로 CHECKPOINT가 파일·바이트 절감 실측 |
| 4. 백필/멱등 | 파티션 덮어쓰기 멱등 + backfill 실증 + 자기파괴 가드 |
| 5. 작은 파일/파티션 폭증 (최대 4배 저하) | DuckLake CHECKPOINT 컴팩션 + 규모 실측(177KB 계측) |

## 7. 커밋마다 검증되고 침묵해도 잡히는 신뢰

8단계에서 pytest 35개로 로직을 고정했지만 그건 로컬 자산입니다. 내 노트북에서만 돕니다. 세 구멍을 닫았습니다([5편](/blog/project/lakehouse/lakehouse-5-audit-and-trust)).

**CI 3관문**으로 GitHub Actions가 커밋마다 ruff·pytest·dbt(deps/parse/build)를 강제합니다. 이 스택의 강점이 CI에서 드러납니다. 쿼리 엔진 DuckDB가 임베디드라 MinIO·PG 없는 러너에서 tiny 픽스처 parquet 몇 장으로 staging→fct→mart를 **실제로 짓고** 데이터 테스트·계약·unit test까지 한 번에 돕니다(dbt build PASS=25→26). **dbt unit test**는 이 프로젝트의 심장(누적→일간 델타)을 정적 입력→기대 출력으로 고정했습니다. first-vs-last 차분과 순리셋 클램프, 하루 1스냅샷이면 델타 0이 되는 경계, 지문 충돌 SUM, 롤링 윈도우. 이렇게 5건입니다.

**deadman heartbeat**입니다. 기존 알림은 "실패하면 운다"뿐이라 태스크가 시작조차 못 하면(스케줄러 death·DAG pause·원천 침묵) 아무도 안 웁니다. 성공 시 heartbeat를 카탈로그 PG에 남기고 "기한 내 갱신 없으면 경보"하는 역방향 감시를 넣었습니다. 30시간 침묵을 실제 경보 발화로, 한 번도 성공 기록이 없는 DAG도 경보로 잡았습니다. 한계가 하나 있습니다. Airflow 내 감시 DAG는 자기 스케줄러의 total death는 못 잡아 외부 cron 경로를 함께 뒀고, 그 외부 러너의 생존은 결국 조직 밖 상시 모니터(PagerDuty류)의 몫으로 남깁니다.

**dbt contracts**로 fct·mart에 `contract: enforced: true` + 컬럼 타입·CHECK 제약을 선언했습니다. dbt-duckdb가 DB 레벨로 실제 enforce하므로, 마트 컬럼 하나의 산출 타입을 바꿔 다운스트림 파괴를 시뮬레이션하면 CREATE TABLE 시점에 빌드가 막혀요(`data type mismatch`, PASS=0 ERROR=1). 대시보드가 기대는 컬럼 타입이 조용히 바뀌는 경로를 발행 전에 끊습니다.

## 8. 커버리지와 남은 한계

남겨둔 것들입니다.

- **원천 부분 유실**입니다. F1 가드는 "원천 0행 vs 파티션 존재"까지만 봅니다. 0은 아니지만 급감하는 부분 유실은 여전히 덮어써요(게이트 reconciliation의 사후 탐지 영역). 쓰기 전 행수 급감 거부는 정당한 감소와의 오탐 트레이드오프라 미결로 뒀습니다.
- **통계적 이상 감지**도 남습니다. 품질 게이트는 규칙 기반(정합·완결성·freshness·드리프트)까지입니다. 실패 통보는 webhook으로 닫았지만 통계적 이상 자동 감지는 범위 밖입니다.
- **인스턴스별 freshness**도 과제입니다. 지금은 dt 파티션 전체의 최신 captured_at으로 판정해서, 일부 인스턴스만 일찍 끊겨도 다른 인스턴스가 경계까지 수집했으면 dt-level로는 OK가 될 수 있습니다.
- **롤링 윈도우는 이력을 요구합니다.** 최신 dt 기준 최근 7일 vs 직전 30일 창이라, 실데이터 닫힌 dt가 3개뿐이라 실운영 마트는 0행입니다(규모 합성에서만 랭킹이 나옴). 이력이 쌓이면 실데이터에서도 채워집니다. 구조는 검증됐고 이력이 없으면 마트를 그대로 비워 두는 게 규율입니다.
- **과거 dt 정정**입니다. fct는 이제 증분이라 과거 dt(<max) 정정은 `--full-refresh`가 필요합니다(backfill 레시피는 RUNBOOK).
- **합성 규모의 재현 범위**도 한계입니다. 파일 수·파티션 규모는 정확히 재현하지만 고유 쿼리 카디널리티 폭증은 하루치의 반복이라 미재현입니다(원천 다양성의 문제).
- **계약·계보**도 마찬가지입니다. 컬럼 레벨 계보·PII 태깅은 dbt Enterprise 영역이라 문서 계보까지만 했습니다.

돌아보면 이 프로젝트를 관통한 건 세 문장입니다.

1. **버려지는 것에 두 번째 삶을 준다.** 관제가 7일 만에 버리는 데이터를 분석계가 받아 장기 이력으로 잇습니다.
2. **주장은 실측으로 편다.** 멱등은 닫힌 창 재실행으로, 품질은 장애 주입으로 확인했습니다. 규모는 1년치를 실제로 만들어 쟀고, 최적화는 병목 수치가 정당화한 곳만 건드렸습니다.
3. **안 하는 것에도 이유를 붙인다.** Kafka·Spark·Iceberg를 안 넣은 근거가 넣은 것만큼 이 파이프라인의 성격을 보여줍니다.

전 과정의 상세는 시리즈 [1편(계약·적재)](/blog/project/lakehouse/lakehouse-1-contract-and-load)부터 [6편(규모)](/blog/project/lakehouse/lakehouse-6-scale-and-serve)까지에, 재현 가능한 기록은 [GitHub](https://github.com/dj258255/dbtower-lakehouse)에 있습니다.

---
title: '버려지는 7일 — 관측 데이터의 두 번째 삶을 위한 파이프라인'
titleEn: 'The Discarded Seven Days — A Pipeline for the Second Life of Observability Data'
description: "DBTower를 석 달 운영하고 물었습니다. '지난달보다 이번 달에 느려진 쿼리 있어?' 답할 수 없었어요. DBTower의 쿼리 스냅샷은 메타 DB 포화를 막으려고 7일 뒤 삭제되기 때문입니다(AWS Performance Insights 무료 티어와 같은 7일). 운영 관제는 '지금~최근'에 최적화됐고 그래야 하지만, 장기 추세·용량 계획·분기 비교는 그 설계로 구조적으로 못 답합니다. 그래서 운영계와 분석계를 분리하고, 버려지기 직전의 스냅샷을 컬럼나 저장소로 내려(ELT) 장기 이력을 만드는 데이터 파이프라인을 만듭니다 — Airflow로 오케스트레이션하고, MinIO에 Parquet로 적재하고, dbt로 변환하고, DuckDB/DuckLake로 질의하는."
descriptionEn: "After running DBTower for three months, I asked: which queries got slower this month than last? I couldn't answer. DBTower's query snapshots are deleted after seven days to keep its metadata DB from bloating (the same seven days as AWS Performance Insights' free tier). Operational monitoring is optimized for the recent window, and it should be — but long-term trends, capacity planning, and quarter-over-quarter comparisons are structurally out of reach. So I separate the operational plane from the analytical one, and build a pipeline that offloads soon-to-expire snapshots into columnar storage (ELT) for long-term history — orchestrated by Airflow, landed as Parquet in MinIO, transformed by dbt, queried by DuckDB/DuckLake."
date: 2026-07-08
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

## 0. 상황 — 답할 수 없었던 질문

[DBTower](/blog/project/dbtower/dbtower-0-overview)를 석 달쯤 운영하고 나서, 누군가 물었다고 해봅시다. **"지난달보다 이번 달에 느려진 쿼리 있어?"**

답할 수 없었습니다. DBTower의 쿼리 스냅샷은 **7일 뒤 삭제**되거든요.

이건 버그가 아니라 의도된 설계입니다. 관제 도구가 관측 데이터를 무한히 쌓으면, 메타 DB가 관리 대상보다 먼저 포화됩니다. 그래서 보존을 7일로 뒀어요 — AWS Performance Insights의 무료 티어가 정확히 7일 보존인 것과 같은 선례입니다(그 이상은 유료).

## 1. 한계 — 운영 관제는 "지금"에 최적화됐고, 그래야 한다

문제는 관제의 시야가 **"지금~최근 7일"**이라는 점입니다. 이건 관제 도구로서는 올바른 설계예요 — "지금 무슨 일이 일어나고 있나"를 빠르게 보려면 데이터를 오래 들고 있으면 안 됩니다.

하지만 이런 질문들은 그 설계로는 구조적으로 못 답합니다:

- "지난 분기 대비 가장 악화된 쿼리 TOP 10은?"
- "이 인스턴스의 3개월 성장 추세로 볼 때 용량 증설 시점은?"
- "기종별로 장기 레이턴시 분포가 어떻게 다른가?"

전부 **장기 이력**이 있어야 답할 수 있는 질문이에요. 7일 시야로는 불가능합니다.

## 2. 판단 — 운영계와 분석계를 분리한다

실무에서 프로덕션 DB(OLTP)와 데이터 웨어하우스(분석)를 분리하는 그 원칙 그대로입니다. **관제(DBTower)는 지금에 최적화된 채로 두고, 장기 분석은 별도 계층**으로 뺍니다.

방법은 버려지기 직전의 스냅샷을 컬럼나 저장소로 내리는 것 — 데이터 엔지니어링에서 ELT(Extract, Load, Transform)라 부르는 흐름입니다.

![dbtower-lakehouse 파이프라인 — query_snapshot을 Airflow로 추출·적재하고 dbt로 집계해 DuckDB로 질의, 사이에 데이터 품질 게이트](/uploads/project/lakehouse/architecture.svg)

즉 이 프로젝트는 **버려지는 관측 데이터의 두 번째 삶**입니다. DBTower가 7일 만에 버리는 데이터를, 분석계가 받아 오래 기억하는 거죠.

## 3. 그래서 이 시리즈가 만드는 것

스택은 2025년 실제 업계에서 쓰는 조합입니다(노트북에서 lakehouse 만들기 튜토리얼·GitHub 프로젝트가 다수 실존):

- **Airflow** — 일 배치 오케스트레이션. 공공 SI가 아직 쓰는 Oozie의 현대판(개념은 DAG로 동일).
- **MinIO + Parquet** — S3 호환 객체저장소에 컬럼나 포맷. DBTower 데모 스택에 MinIO가 이미 있어 재사용.
- **dbt + DuckDB** — SQL 기반 변환·테스트·문서화. Hive 가공의 현대판.
- **DuckLake** — 카탈로그를 PostgreSQL에 두는 테이블 포맷으로 ACID·타임트래블을 얹어, "lake"를 "lakehouse"로 완성. (이미 PG를 써서 서비스 추가 0.)

핵심 소재는 이겁니다:

- **분석이 운영의 부하가 되면 안 된다** — DBTower의 "진단이 부하가 되면 안 된다" 원칙을 파이프라인에도. 관측 전용 메타 PG에서만, 읽기 전용·시간창으로 추출합니다(운영 대상 DB는 안 건드림).
- **멱등성** — 같은 날짜를 몇 번 돌려도 결과가 같아야 backfill이 안전합니다.
- **조용히 틀린 데이터는 없는 것보다 나쁘다** — 수집 장애로 빈 파티션 위에 만든 랭킹은 조용히 오답을 냅니다. 품질 게이트로 막습니다.
- **lake vs house** — Parquet 덮어쓰기만으론 ACID·타임트래블이 없어 엄밀히는 "lake"입니다. 테이블 포맷을 얹어야 "house"가 되고, 그래야 lakehouse라 부르는 게 정직합니다.

각 편은 "어떤 상황에서 무엇이 깨지고, 그래서 무엇을 만드는가"의 개선 아크로 씁니다. 코드는 [GitHub](https://github.com/dj258255/dbtower-lakehouse)에 공개합니다.

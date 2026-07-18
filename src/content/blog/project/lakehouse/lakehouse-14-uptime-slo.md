---
title: '판정이 다섯인데 "떠 있었나"가 없었고, 그게 마침 유일하게 비어 있던 자리였습니다'
titleEn: 'We Had Five Verdicts but Not "Was It Up," and That Was the One Slot Still Empty'
description: '창고의 판정이 다섯이 됐습니다. 용량 D-day, 플랜 회귀, 백업 공백, 미사용 인덱스, 설정 변경 상관. 그런데 정작 "이 DB 이번 분기 얼마나 떠 있었나"는 못 답했습니다. DBTower는 health_sample이라는 테이블에 1분마다 up 여부와 ping을 쌓아 30일 가용성 SLO를 계산하지만, 35일만 보존하고 지웁니다. 그래서 30일 넘는 장기 가용성은 어디에도 없었습니다. DBTower의 29개 테이블을 lakehouse 오프로드 현황과 전부 대조해보니, health_sample이 두 잣대를 다 통과하는 유일한 미착수 원천이었습니다. DBTower가 지우고, 7일이나 30일로는 못 하는 장기 판정이라는 두 조건입니다. 게다가 이 up 여부는 Prometheus 게이지로 노출되지도 않아서, 호스트 디스크 메트릭이 Prometheus로 가는 것과 달리 메트릭 경로에도 없는 빈 자리였습니다. 그래서 경계를 침범하지 않고 가져올 수 있었습니다. 나머지 테이블은 DBTower 콘솔 자체의 감사 로그거나 인프라 설정이라 lakehouse 도메인 밖입니다. 1분 샘플을 하루로 접어 uptime 퍼센트를 내고, 다운일 때의 ping은 타임아웃 값이라 지연 통계를 오염시키므로 up 샘플로만 평균과 p95를 냈습니다. 그리고 최근 30일 가용성을 목표와 견줘 SRE 에러버짓과 판정을 냈습니다. 라이브에서 이건 상관 마트와 달리 바로 의미 있게 켜졌습니다. MSSQL 두 인스턴스가 63퍼센트대 가용성에 평균 ping 2초에서 7초로 나오고, PostgreSQL과 Mongo와 Oracle은 99.9퍼센트로 목표를 지킵니다. 가용성이 창고의 여섯 번째 판정이 되면서 마지막 빈 자리가 채워졌습니다.'
descriptionEn: 'The warehouse had five verdicts: capacity D-day, plan regression, backup gap, unused index, and config-change correlation. Yet it could not answer "how much was this DB up this quarter." DBTower stacks up-status and ping every minute in a table called health_sample to compute a 30-day availability SLO, but retains only 35 days and prunes the rest, so long-term availability lived nowhere. Comparing all 29 DBTower tables against what lakehouse offloads, health_sample was the only untouched source that passed both tests: DBTower prunes it, and it needs a long window a 7- or 30-day view cannot give. It is also not exposed as a Prometheus gauge, so unlike host disk metrics that flow to Prometheus, it had no home in the metrics path either, meaning I could take it without crossing the boundary. The remaining tables are DBTower console audit logs or infra config, outside the lakehouse domain. I fold the minute samples into a day to get uptime percent, and since ping during downtime is a timeout value that would poison latency stats, I average and take p95 of ping over up-samples only. Then I compare recent 30-day availability against a target to produce an SRE error budget and a verdict. Live, unlike the correlation marts this lit up meaningfully at once: two MSSQL instances read 63-percent availability with average ping of two to seven seconds, while PostgreSQL, Mongo, and Oracle hold 99.9 percent against target. Availability became the sixth verdict, filling the last empty slot.'
date: 2026-07-19
tags:
  - Data Engineering
  - dbt
  - DuckDB
  - Metabase
  - SRE
category: personal/lakehouse
coverImage: /uploads/project/lakehouse/cover.svg
draft: false
series: "lakehouse"
seriesOrder: 14
---

## 0. 판정이 다섯인데 "떠 있었나"가 없었다

창고의 판정이 어느새 다섯이 됐습니다. 용량 D-day, 플랜 회귀, 백업 공백, 미사용 인덱스,
설정 변경 상관. 그런데 대시보드를 보다가 이상한 걸 느꼈습니다. 정작 제일 기본적인 질문인
**"이 DB 이번 주, 이번 분기 얼마나 떠 있었나"**는 못 답하고 있었습니다.

DBTower에는 `health_sample`이라는 테이블이 있습니다. 1분마다 각 인스턴스에 핑을 날려
`up` 여부와 `ping_millis`를 쌓습니다. `SloService`가 이걸로 30일 가용성 SLO와 에러버짓을
계산합니다. 그런데 이 테이블은 **35일만 보존하고 지웁니다.** 에러버짓 회계 기간보다 조금
길게만 잡아 두는 겁니다. 그래서 30일 넘는 장기 가용성은 어디에도 남지 않았습니다.

## 1. 정말 lakehouse의 몫인지부터 확인했다

바로 짓기 전에, DBTower의 테이블 29개를 창고 오프로드 현황과 **전부 대조**했습니다. 아무거나
가져오면 경계가 무너지니까요. 잣대는 둘이었습니다. DBTower가 그걸 지우는가(그래야 구할
데이터가 있음), 그리고 7일이나 30일로는 못 하는 장기 판정인가.

대조 결과 `health_sample`이 두 잣대를 다 통과하는 **유일한 미착수 원천**이었습니다. 게다가
확인해보니 이 `up` 여부는 **Prometheus 게이지로 노출되지도 않습니다.** 호스트 디스크 메트릭은
Prometheus로 가는데, 이 가용성 샘플은 DBTower의 PG 테이블에만 있고 SloService가 30일 창으로만
계산합니다. 즉 메트릭 경로(Prometheus에서 장기는 Thanos로)에도 없는 빈 자리라, 이걸 가져와도
"메트릭은 Prometheus, 쿼리 분석은 lakehouse"라는 경계를 안 침범합니다.

![가용성 SLO 파이프라인. health_sample(1분 폴링, 35일 보존)에서 fct_uptime_daily(up 샘플 나누기 전체가 uptime 퍼센트)로, 다시 mart_uptime_slo(최근 30일 대 목표로 에러버짓)로 흐른다. 아래는 에러버짓 개념과 라이브 막대로, local-postgres는 99.9퍼센트로 meets, local-mysql은 98.9퍼센트로 breach, local-mssql은 63.4퍼센트로 breach다](/uploads/project/lakehouse/lh21_slo.svg)

나머지 테이블은 안 가져오는 게 맞았습니다. `audit_event`나 `login_attempt`는 DBTower 콘솔
자체의 감사 로그라 관리 대상 DB 이야기가 아니고, 나머지는 인프라나 설정 테이블입니다.

## 2. 1분 샘플을 하루로 접는다

`fct_uptime_daily`는 하루치 1분 샘플을 하나로 접습니다. `uptime_pct`는 up 샘플을 전체 샘플로
나눈 값입니다. 여기서 작은 함정이 하나 있었습니다. **다운일 때의 `ping_millis`는 타임아웃
값**입니다. 이걸 평균에 넣으면 가끔 다운된 인스턴스의 평균 지연이 실제보다 훨씬 나빠 보입니다.
그래서 ping의 평균과 p95는 `up`인 샘플로만 냈습니다. 가용성은 전체 샘플로, 지연은 살아 있던
샘플로 봅니다.

## 3. 목표 대비 에러버짓을 낸다

`mart_uptime_slo`는 최근 30일 가용성을 목표와 견줍니다. 목표는 seed로 인스턴스별로 정하거나
(기본 99.5%), 전역 기본을 씁니다. 그리고 SRE 에러버짓을 냅니다. 목표 99.5%는 한 달에 다운을
약 3.6시간까지 허용한다는 뜻인데, 그중 얼마가 남았는지를 잔량 퍼센트로 계산합니다. 남은 게
음수면 이미 목표를 넘긴 겁니다. 판정은 목표 미달이면 breach, 버짓을 거의 소진했으면 at_risk,
그 외는 meets입니다.

발화는 여기서도 안 합니다. SLO 판정까지만 계산하고, 다운 알림은 DBTower나 Metabase의 몫입니다.

## 4. 라이브에서 바로 켜졌다

지금까지의 상관 마트들은 후행 관측이 필요해서 실데이터로 켜지려면 시간이 걸렸는데, 가용성은
**연속 측정이라 바로 의미 있게 채워졌습니다.**

![Metabase 가용성 SLO 대시보드 실화면. instance_name과 engine이 붙어 있고, local-mssql은 63.45퍼센트에 worst day 41.19퍼센트, 평균 ping 2132밀리초, mssql-pitr는 64.28퍼센트에 평균 ping 6897밀리초로 목표 99.9에 한참 못 미친다. local-mysql은 98.86퍼센트, PostgreSQL과 Mongo와 Oracle은 99.9퍼센트대다](/uploads/project/lakehouse/lh21_slo_dashboard.png)

결과가 선명합니다. MSSQL 두 인스턴스가 63퍼센트대 가용성에 평균 ping이 2초에서 7초입니다.
`worst_day_uptime_pct`를 보면 최악의 날은 41퍼센트까지 떨어졌습니다. 반면 PostgreSQL, Mongo,
Oracle은 99.9퍼센트로 목표를 지키고, DBTower 자기 자신(dbtower-self)은 100퍼센트입니다.
기종 축을 앞 단계에서 붙여 둔 덕에 "어느 기종이 몇 퍼센트 떴나"가 한 줄로 읽힙니다. MSSQL이
지금 문제라는 게 숫자로 바로 보입니다.

주간 보고에도 `this_week_uptime_pct` 한 칸을 더했습니다. 이제 주간 보고 한 줄이 "이 DB
이번 주 어땠나"를 느림, 용량, 백업에 더해 **떠 있었나까지** 답합니다.

## 5. 마지막 빈 자리

이걸로 창고의 판정이 여섯이 됐습니다. 용량, 플랜, 백업, 인덱스, 설정 상관, 그리고 가용성입니다.
전수 대조에서 남았던 유일한 빈 자리가 채워졌고, 그게 마침 제일 기본적인 "떠 있었나"였습니다.

여기서 남은 건 정말로 시간이 해제하는 것들뿐입니다. 플랜 이력이 쌓이면 플랜 회귀와 설정 상관이
실데이터로 켜지고, 그건 코드가 아니라 날짜가 하는 일입니다. DBTower의 나머지 테이블은 콘솔
감사거나 인프라거나 이미 다른 집(Prometheus)이 있어서, 창고가 더 가져올 게 없습니다. 관리 대상
DB에 관해 창고가 답할 수 있는 판정은 여기서 한 바퀴가 찼습니다.

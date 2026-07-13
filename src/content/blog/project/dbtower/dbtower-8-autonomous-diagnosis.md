---
title: '사람이 모는 대시보드에서 스스로 보는 관제탑으로, 자율 진단 8종을 만들었습니다'
titleEn: 'From a Human-Driven Dashboard to a Tower That Watches by Itself, with Eight Autonomous Diagnostics'
description: '이기종 DBMS 운영 관리 플랫폼 DBTower 8편. 대시보드는 사람이 봐야만 가치가 있습니다. 안 보는 새벽의 조용한 저하는 아무도 못 잡습니다. 그래서 플랫폼이 스스로 보게 만든 기록입니다. 고정 임계 없이 (요일x시간대) 베이스라인 z-score로 ''평소와 다름''을 잡는 이상 자동 감지(z=378 실측), 운영 문서의 규칙을 코드로 옮긴 Advisors(operator 인터페이스 변경 0), AI에게 read-only 도구 화이트리스트를 쥐여주고 스스로 연쇄 호출하게 한 자연어 진단, 같은 p95인데 기종마다 NATIVE/COMPUTED/ESTIMATED/UNSUPPORTED로 정직하게 라벨을 가른 레이턴시 백분위, Google SRE의 SLO/에러 버짓을 DB 운영에 적용한 이야기, 그리고 흩어진 신호를 인스턴스별 0~100점으로 합산해 나쁜 순으로 정렬하는 통합 헬스 스코어까지 담았습니다.'
descriptionEn: 'Part 8 of DBTower. A dashboard is only worth what a human looks at, and nobody catches the silent degradation at 3 AM. So the platform learned to watch by itself. The record covers anomaly detection with (day-of-week x hour) baseline z-scores instead of fixed thresholds (z=378 measured), Advisors that turn ops-runbook rules into code with zero operator-interface changes, natural-language diagnosis where an AI chains read-only whitelisted tools on its own, latency percentiles honestly labeled NATIVE/COMPUTED/ESTIMATED/UNSUPPORTED per engine, Google SRE''s SLO/error budget applied to database operations, and a unified health score that folds scattered signals into a 0-100 grade per instance, sorted worst-first.'
date: 2026-07-05
tags:
  - Java
  - Spring Boot
  - DBRE
  - SRE
  - Observability
  - Claude
category: personal/DBTower
coverImage: /uploads/project/dbtower/cover.svg
draft: false
series: "DBTower"
seriesOrder: 8
---

## 0. 들어가며, 대시보드는 사람이 봐야만 가치가 있다

[7편](/blog/project/dbtower/dbtower-7-provisioning)까지 만든 DBTower는 좋은 대시보드였습니다. 시점 비교, Wait Event, 실행계획 분석은 전부 **사람이 화면을 열어야** 가치가 나오는 기능들입니다. 그런데 사람이 안 보는 시간에 일어나는 조용한 저하는 누가 잡습니까?

방향을 잡을 때 실존 제품들을 근거로 삼았습니다. AWS는 DevOps Guru for RDS로 이상을 자동 감지하고, Percona PMM은 Advisors로 운영 규칙을 자동 점검하고, pganalyze는 AI 보조 진단을 붙였습니다. 업계는 이미 "사람이 모는 대시보드"에서 "스스로 보는 관제탑"으로 이동했습니다. Phase D는 그 이동을 따라가되, 시리즈 내내 지킨 가드레일은 그대로 유지합니다. **전부 읽고 판단만 한다. 대상 DB를 바꾸는 자동 실행은 없다.** 그 선을 넘으면(자동 인덱스 생성 같은) 다른 제품이 되기 때문입니다.

## 1. 고정 임계의 한계를 넘어선 이상 자동 감지, 그리고 z=378

기존 회귀 감지(2편)에는 "QPS +200%면 알림" 같은 고정 임계가 있었습니다. 문제는 이 숫자가 **모든 쿼리에 같은 기준**이라는 겁니다. 평소 QPS 0.2인 쿼리가 25가 되면 125배인데, 평소 100인 쿼리 기준으로 잡은 +200%로는 놓칠 수도, 반대로 트래픽 패턴상 정상인 아침 피크를 오탐할 수도 있습니다.

그래서 스냅샷 이력으로 인스턴스·쿼리별 **(요일 x 시간대) 베이스라인**(평균과 표준편차)을 학습하고, 현재 값이 평소에서 몇 표준편차 벗어났는지(z-score)로 판정하게 했습니다. "화요일 오후 3시의 이 쿼리는 평소 어땠나"가 기준이 됩니다.

```
부하 실측: COUNT digest qps 25.0
  베이스라인(같은 요일·시간대): 0.17 ± 0.07
  -> z = 378, 고정 임계 없이 감지
폴러 end-to-end 발화: qps 55.0, 평소 5.17 ± 12.22 -> z = 4.1
```

설계에서 신경 쓴 두 가지. **하나, 고정 임계를 없애지 않고 공존시켰습니다.** 베이스라인은 학습 데이터가 필요하고, 갓 등록된 인스턴스에는 없기 때문입니다. **둘, 데이터 부족은 "학습 중"으로 보류합니다.** 관측이 부족한 버킷에서 판정을 내리면 신규 인스턴스마다 오탐이 쏟아집니다. 응답에 `learningCount`를 실어서 "아직 판단 안 한다"를 명시하게 했습니다. 모르는 것을 모른다고 말하는 것도 감지기의 정직성입니다.

![현재 이상 없음과 함께 학습 중 12건은 관측 8회 미만이라 판정을 보류한 이상 감지 화면](/uploads/project/dbtower/anomaly.png)

## 2. 운영 문서를 코드로 옮긴 Advisors, 인터페이스 변경 0

시리즈를 쓰면서 쌓인 운영 문서가 있습니다. digest 테이블이 차면 새 쿼리가 통계에서 사라진다(operations.md), 기종별 최소 권한 목록(least-privilege.md) 같은 것들입니다. 문서의 문제는 **사람이 기억해야 작동한다**는 겁니다. 그래서 이 규칙들을 Advisor 6종 코드로 옮겨 일일 스윕(HA 분산 락)으로 자동 점검하게 했습니다.

재밌는 건 구현 비용입니다. **operator 인터페이스 변경이 0이었습니다.** 기존의 `parameters()`, `describeSchema()`, `tableStats()`, `queryStats()`를 재사용해서 판정만 얹은 거라, "새 능력 = 메서드 1개"조차 필요 없던 케이스입니다. 실측(MySQL)에서 "digest 테이블 포화 위험"과 "위험 파라미터값"이 VIOLATIONS로, 중복 인덱스는 OK로, 기종에 무관한 점검은 UNSUPPORTED로 나뉘어 나옵니다.

![digest 포화 위험을 권고와 함께 지적하고 무관한 점검은 미지원으로 정직하게 표기한 Advisors](/uploads/project/dbtower/advisors.png)

## 3. AI에게 읽기 전용 도구만 쥐여준 자연어 진단

3편에서 만든 AI 분석은 단발이었습니다. 사람이 쿼리를 고르고 EXPLAIN 결과를 넘기면 판정하는 구조였습니다. 이번엔 이걸 **도구 사용 루프**로 승격했습니다. "이 DB 왜 느려?"라고 물으면, AI가 어떤 MCP 도구를 부를지 스스로 정하고, 서버가 실행해 결과를 돌려주고, 그걸 보고 다음 도구를 정하는 반복입니다(최대 5스텝).

여기서 안전장치가 두 겹입니다. MCP 도구 중 **read-only 12종 화이트리스트**만 노출해서, kill·backup·online-ddl 같은 쓰기 도구는 루프에 아예 존재하지 않습니다. AI가 아무리 연쇄해도 대상 DB 변경이 0인 게 구조적으로 보장됩니다.

```
질문: "이 DB 왜 느려?"  (LIKE 풀스캔 부하 상태)
AI 연쇄: query_stats -> explain
결론: access_type=ALL, 앞 와일드카드 LIKE는 B+Tree 시작점을
      못 잡는다(판단 기준 문서 인용), confidence=high

질문: "작년 크리스마스 접속자 수는?"  (데이터 없음)
결론: 수치를 지어내지 않고 confidence=low
```

두 번째 실측이 중요합니다. 근거가 없는 질문에 그럴듯한 숫자를 만들어내지 않는 것. 이건 AI를 1차 분석기에 묶어두고 최종 판단은 맡기지 않는 원칙(3편)이 루프에서도 유지되는지 확인한 겁니다.

## 4. p95의 다섯 얼굴, 그리고 SLO와 에러 버짓

SLO를 만들려면 레이턴시 백분위(p95/p99)가 필요한데, 여기서 이기종의 현실을 또 만났습니다. **같은 "p95"인데 기종마다 낼 수 있는 수준이 다릅니다.**

| 기종 | 방식 | 라벨 |
|---|---|---|
| MySQL | events_statements_summary_by_digest의 QUANTILE_95/99 컬럼 | NATIVE (실측 p95=19.95ms) |
| MongoDB | system.profile 원샘플을 직접 계산 | COMPUTED |
| PostgreSQL | 평균 + 1.645 x 표준편차 (정규분포 가정) | ESTIMATED |
| SQL Server / Oracle | 통계 뷰에 분위수도 표준편차도 없음 | UNSUPPORTED |

![같은 p95인데 소스 라벨(실측·직접계산·추정·미지원)이 다른 레이턴시 백분위](/uploads/project/dbtower/latency.png)

핵심은 **네 라벨을 절대 섞지 않는 것**입니다. ESTIMATED를 NATIVE인 척 보여주면 사용자는 추정치를 실측으로 믿고 결정을 내리게 됩니다. 백업 검증의 3값(5편), Terraform validate(7편)와 같은 계열의 정직성입니다.

이 위에 Google SRE의 SLO 모델을 얹었습니다. 원칙은 "인프라 지표(CPU)가 아니라 사용자 경험 지표"입니다. 레이턴시 SLI는 방금의 p95를 재사용하고, UNSUPPORTED 기종은 평균 레이턴시로 폴백하되 `source=AVG_FALLBACK`으로 표기합니다. 가용성 SLI는 헬스 샘플 이력의 up 비율이고, 에러 버짓(허용 다운타임 대비 소진율)과 번 레이트로 EXHAUSTED/WARNING/OK를 판정합니다. 실측에서 MySQL이 NATIVE 기반 BREACHING, Oracle이 AVG_FALLBACK, 가용성은 MEETING으로 나왔습니다.

![레이턴시 SLI 위반과 가용성 충족, 에러 버짓 소진율과 번인 레이트를 보여주는 SLO와 에러 버짓](/uploads/project/dbtower/slo.png)

## 5. 파티션·FinOps·백업 신선도로 신호를 채우다

나머지 세 축은 간결하게 짚습니다.

**파티션 조회(D5)**: `partitions()` 메서드 하나로 4기종(MySQL information_schema, PG relpartbound, Oracle user_tab_partitions, MSSQL sys.partitions), MongoDB는 관계형 파티셔닝 개념이 없어 UNSUPPORTED. 직접 파티션 테이블을 만들어 실조회로 검증하고 정리했습니다. 조회 전용이고, 생성·자동 관리는 범위 밖입니다.

**FinOps 신호(D6)**: 미사용 인덱스를 실제 사용 카운터(PG idx_scan, MySQL COUNT_STAR 등)로 잡되, **절감액 달러는 계산하지 않습니다.** 스토리지 단가는 환경마다 달라서 금액을 찍는 순간 지어낸 숫자가 되기 때문입니다. 신호까지만 내고 판단은 사람에게 넘깁니다. 유니크/PK 인덱스는 미사용이어도 제외했습니다. 제약 조건 역할이라 지우면 안 되기 때문입니다.

**백업 신선도(D7)**: 마지막 성공 백업 경과로 FRESH/STALE/NO_BACKUP을 나눕니다. 설계 포인트는 **메타 DB만 읽고 판정**한다는 겁니다. 대상 DB가 죽었을 때야말로 백업 신선도가 가장 중요한 순간인데, 그때 대상에 접속해야 알 수 있다면 앞뒤가 바뀐 것입니다. 실측에서 6개 인스턴스가 FRESH 1·STALE 2·NO_BACKUP 3으로 분류됐습니다.

## 6. 흩어진 신호를 아침 첫 화면으로 모으는 헬스 스코어

마지막 조각이 D8입니다. D1~D7이 만든 신호는 흩어져 있습니다. 이상 감지 따로, Advisors 따로, SLO 따로. 운영자가 아침에 열어야 할 화면은 모든 걸 나열하기보다 **어디부터 봐야 하는지 알려주는 화면**입니다.

그래서 health·이상 감지·Advisors·SLO·백업 신선도를 인스턴스별 0~100점 + 등급으로 합산하고, 감점 사유를 분해해서 나쁜 순으로 정렬했습니다. 설계 판단 세 가지:

- 신호가 없는 신규 인스턴스는 0점이 아니라 INSUFFICIENT_DATA로 둬서 **"데이터 부족"과 "나쁨"을 구분**합니다.
- 접속 자체가 안 되면 다른 신호가 무의미합니다. 그래서 **health 프로브 예외는 down으로 수렴**시켜 치명으로 처리했습니다.
- 신호 하나의 수집 실패가 스코어 전체를 죽이지 않도록 **신호를 격리(partial)**했습니다.

```
실측(실 8080): local-mysql / local-mssql -> F 52점, 나머지 B ~ 88점, 나쁜 순 정렬
canary 인스턴스 kill -> F 35점으로 최상단 부상
```

canary를 죽이자마자 최상단에 떠오르는 걸 보고 이 화면의 역할이 분명해졌습니다. 이건 대시보드보다 **분류(triage) 큐**에 가깝습니다.

![감점 사유 분해와 나쁜 순 정렬로 아침에 여는 첫 화면이 되는 통합 헬스 스코어](/uploads/project/dbtower/health-score.png)

## 7. 마치며, 읽기만 하는 자율

Phase D의 여덟 축을 놓고 보면 공통점이 하나입니다. 전부 **읽고, 판단하고, 알려줄 뿐** 대상 DB를 건드리지 않습니다. 이상을 감지해도 쿼리를 죽이지 않고, 미사용 인덱스를 찾아도 지우지 않고, SLO가 EXHAUSTED여도 스로틀하지 않습니다. pganalyze가 "AI-assisted but developer-driven"이라고 부르는 그 선입니다.

그리고 구현 비용을 보면, 여덟 기능 전부가 `DbmsOperator` 메서드 1개 추가(latencyPercentiles·partitions·indexUsage) 또는 기존 재사용(Advisors·SLO·신선도·스코어)으로 5기종을 통합했습니다. 1편에서 그은 추상화 경계가 자율 진단까지 그대로 버틴 셈입니다.

남은 건 하나입니다. 이상을 감지하고 나쁜 인스턴스를 지목하는 것까지 왔는데, 이제 "그래서 **왜** 느린가"의 마지막 층이 남았습니다. 실행계획이 왜 인덱스를 못 탔는지를 기종별로 파고드는 심층 원인 진단이 다음 편입니다.

코드와 실측 기록 전체는 [GitHub](https://github.com/dj258255/dbtower)에 있습니다.

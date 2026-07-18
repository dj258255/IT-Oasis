---
title: '상관을 넓히고, 기종 축으로 각주를 회수하고, 가용성으로 마지막 자리를 채웠습니다'
titleEn: 'Widening the Correlation, Reclaiming Scattered Caveats with an Engine Axis, and Filling the Last Slot with Availability'
description: '앞 편에서 만든 설정 변경 상관은 실데이터에서 계속 no_flip_observed였습니다. 상관을 플랜 뒤집힘 하나에만 묶어 둔 한계였습니다. 그래서 안 지을 것과 넓힐 것을 갈랐습니다. change_review 오프로드는 저빈도 감사 데이터라 안 짓되 int_change_events로 상관을 일반화해 자리만 열고, 값이 확실한 지연 축을 더해 플랜이 안 뒤집혀도 followed_by_latency_rise로 잡게 했습니다. 미사용 인덱스는 DBTower 라이브 분석기와 lakehouse 90일 마트가 겹치니, 단기 즉답은 라이브 장기 확정은 마트라는 지평 경계를 문서에 못박았습니다. 다음으로, 여러 마트가 "기종 축이 없다"는 같은 각주를 달고 있었는데 정작 기종이 든 database_instance는 이미 매 오프로드가 읽고 있었습니다. 컬럼 둘(name·type)만 더 실어 dim_instance 차원을 만들어 대기 마트와 주간 보고에 조인하니 instance_id 1이 local-mysql (MYSQL)로 읽히고, 흩어진 각주가 한 번에 사라졌습니다. 상관에는 볼륨 축도 더했지만 config가 디스크를 직접 키우는 인과는 약해 우선순위 최하에 두었습니다. 마지막으로, 판정이 다섯인데 "떠 있었나"가 없었습니다. DBTower가 1분마다 쌓고 35일 뒤 지우는 health_sample이 두 잣대를 다 통과하고 Prometheus에도 없던 유일한 빈 자리라, 이걸 장기 가용성 SLO로 만들었습니다. 라이브에서 MSSQL 두 인스턴스가 63퍼센트대 가용성에 평균 ping 2에서 7초로 breach, 나머지는 99.9퍼센트로 meets입니다. 가용성이 여섯 번째 판정이 되면서 창고가 답할 판정이 한 바퀴 찼습니다.'
descriptionEn: 'The config-change correlation from the previous post kept reading no_flip_observed on real data, a limit of tying it to plan flips alone. So I separated what not to build from what to widen: not offloading change_review (low-volume audit data) but generalizing the correlation through int_change_events to leave a seat open, and adding a certain-value latency axis so followed_by_latency_rise fires even without a plan flip. Since DBTower a live unused-index analyzer and lakehouse a 90-day mart overlap, I pinned the horizon boundary in docs: short answers from live, long-term confirmation from the mart. Next, several marts carried the same "no engine axis" caveat while database_instance, which holds the engine, was already read on every offload; adding two columns built a dim_instance dimension that, joined into the wait mart and weekly report, makes instance_id 1 read as local-mysql (MYSQL) and retires the scattered caveats at once. I also added a volume axis to the correlation but kept it lowest priority since config rarely grows disk. Finally, with five verdicts there was no "was it up." health_sample, which DBTower stacks every minute and prunes after 35 days, passed both tests and had no home in Prometheus either, so I turned it into a long-term availability SLO. Live, two MSSQL instances read 63-percent availability at two to seven seconds average ping (breach) while the rest hold 99.9 percent (meets). Availability became the sixth verdict, completing the set the warehouse can answer.'
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
seriesOrder: 11
---

## 0. 상관이 계속 안 켜졌다

앞 편에서 설정 변경을 성능 회귀의 원인 후보로 겹치는 마트를 만들었습니다. 그런데 실데이터에서
계속 `no_flip_observed`가 나왔습니다. 창고의 플랜 이력이 하루뿐이라 변경 뒤에 겹칠 뒤집힘이
없었기 때문입니다. 정직한 결과이긴 한데, 그걸 계속 보다 보니 설계의 한계가 눈에 들어왔습니다.
**상관을 플랜 뒤집힘 하나에만 묶어 둔 것**입니다.

원인의 축은 하나가 아닙니다. 파라미터가 바뀌면 플랜을 뒤집지 않고도 그냥 느려질 수 있습니다.
그리고 바뀌는 대상도 파라미터만이 아닙니다. 개발자가 인덱스를 추가하거나 컬럼 타입을 바꾸는
스키마 변경도 성능을 흔듭니다. 한 소스, 한 신호에 묶인 상관은 반쪽입니다.

## 1. 안 지을 것과 넓힐 것

여기서 유혹이 하나 있었습니다. DBTower에는 이미 스키마 변경 리뷰 기능(`change_review`)이
있습니다. 개발자가 DDL을 배포 전 리뷰 요청하면 규칙 엔진이 위험을 지적하고 ADMIN이 승인하는
워크플로입니다. 이걸 창고로 내리면 "승인된 스키마 변경 뒤 느려졌나"까지 상관을 넓힐 수 있습니다.

그런데 냉정하게 보니 이건 **안 짓는 게 맞았습니다.** 이 프로젝트의 전제는 "DBTower가 7일 뒤
버리는 데이터의 두 번째 삶"입니다. 그런데 리뷰 요청은 저빈도 감사 데이터라 스냅샷처럼 공간
때문에 지울 이유가 약합니다. DBTower가 이미 장기로 들고 있을 가능성이 높으니, 창고가 구할
"버려지는 데이터"가 별로 없습니다. 게다가 리뷰는 월 몇 건 수준이라 상관 신호도 성깁니다.
전체 오프로드 아크(계약·CI·블로그)를 짊어질 값이 안 나옵니다.

그래서 갈랐습니다. change_review는 **안 짓되, 나중에 끼울 자리는 연다.** 상관 자체를 특정
소스에 묶지 않고 일반화해 두면, 정말 필요해지는 날 소스 하나만 붙이면 됩니다.

## 2. 변경을 한 형태로 모은다

`int_change_events`라는 통합 스트림을 만들었습니다. 변경을 종류에 상관없이 한 형태
(instance, 언제, 무엇을, 어떻게)로 모읍니다. 지금은 설정 변경만 흘러 들어오고, 스키마 변경은
`union all` 자리를 코드 주석으로 남겨 두었습니다.

![변경 영향 상관의 확장 구조. 왼쪽은 변경 소스로, 설정 변경(config)은 실선 상자로 연결돼 있고 스키마 변경(schema)은 점선 상자로 자리만 열려 있다. 둘이 int_change_events 통합 스트림으로 모이고, 변경 뒤 N일 안의 신호를 두 축(플랜 뒤집힘·평균 지연 상승)으로 본다. 아래는 우선순위 판정 사다리로 followed_by_regression, followed_by_plan_flip, followed_by_latency_rise, no_signal 순이다](/uploads/project/lakehouse/lh19_change_impact.svg)

여기서 작은 함정을 하나 밟았습니다. 스키마 변경 자리를 주석으로 남기면서 `union all` 예시에
`ref()` 문법을 그대로 적었더니, dbt가 **주석 안의 `ref()`까지 의존으로 파싱해서** 존재하지
않는 모델을 찾다 빌드가 깨졌습니다. dbt의 참조 탐지는 정규식 기반이라 주석을 구분하지 않습니다.
자리 표시용 코드에서는 `ref()` 문법을 일부러 안 쓰는 걸로 바꿨습니다.

## 3. 지연 축을 더한다

두 번째로 상관의 신호 축을 넓혔습니다. 기존엔 변경 뒤 플랜이 뒤집혔나만 봤는데, 이제 **변경
전후로 그 인스턴스의 평균 지연이 올랐나**도 봅니다. 변경 전 N일과 후 N일의 평균 지연을
비교해서, 비율이 임계 이상이면 `followed_by_latency_rise`로 잡습니다. 플랜이 안 뒤집혀도
"변경 뒤 느려졌다"가 켜집니다.

판정은 우선순위 사다리입니다. 회귀가 뒤따르면 가장 강한 신호이고, 그다음이 플랜 뒤집힘,
그다음이 지연 상승, 아무것도 없으면 신호 없음입니다. 지연을 계산할 때 호출이 0이던 날의
지연은 NULL이라 평균에서 자연히 빠집니다. 이걸 0으로 접으면 활동 없던 날이 "빨라진 날"로
둔갑해 회귀를 개선으로 오판하는데, 그 함정은 앞 편에서 이미 배운 것이라 그대로 피했습니다.

## 4. 지평 경계를 못박는다

여기서 코드가 아니라 문서로 정리한 게 하나 있습니다. 미사용 인덱스 판정을 놓고 보면,
DBTower에도 라이브 분석기(`UnusedIndexAnalyzer`)가 있고 lakehouse에도 90일 마트
(`mart_index_verdict`)가 있습니다. 둘 다 "미사용 인덱스"를 판정하니, 셀프호스터 입장에서
어느 걸 믿어야 하는지 헷갈릴 수 있습니다.

용량 D-day에서 세운 분업을 그대로 적용했습니다. **단기·즉답이 필요하면 DBTower 라이브,
"분기 내내 정말 안 쓰였나"의 확정은 장기 마트.** DBTower의 순간 판정은 방금 재기동한 서버의
0회도 미사용처럼 보이는 약점이 있고, 90일 창은 그 노이즈에 안 흔들립니다. 원천(인덱스 사용
통계)은 같고 창만 다른 상호보완이지 경쟁이 아닙니다. 이 경계를 마트 헤더와 로드맵에 못박아,
"지워도 되나"를 확정할 때는 마트를, "지금 훑어보기"는 DBTower 화면을 보게 했습니다.

## 5. 상관 라이브

상관 마트를 실데이터에 다시 돌렸습니다. 이제 `change_source`가 config로 채워지고, 변경 전
지연이 실측으로 붙습니다. 인스턴스 2는 변경 전 평균 3.1ms, 인스턴스 4는 35.04ms였습니다.

![Metabase 설정 드리프트 대시보드의 영향 카드. change_source와 change_key 컬럼이 채워져 변경 소스가 일반화됐음을 보여준다. 인스턴스 2와 4의 work_mem 변경이 config 소스로 기록돼 있다](/uploads/project/lakehouse/lh19_impact_dashboard.png)

변경 후 지연은 아직 비어 있습니다. work_mem 변경이 오늘 일어났는데, "변경 후 N일"의 창이
아직 미래라 채울 데이터가 없기 때문입니다. 그래서 상관은 `no_signal`입니다. 이건 버그가 아니라
정직한 상태입니다. 내일부터 데이터가 쌓이면 후 창이 차고, 지연이 올랐다면 상관이 켜집니다.
두 축(플랜·지연) 모두 변경 이후의 관측이 필요하다는 성질이라, 당일 변경이 아직 no_signal인 건
당연합니다.

## 6. 같은 각주가 마트마다 반복됐다

상관을 넓히다 눈에 걸리는 게 또 있었습니다. 여러 마트가 **같은 각주**를 달고 있었습니다.
"이 창고엔 기종 축이 없다, 기종은 소비자가 DBTower 인스턴스 화면에서 안다."

대기 마트(`mart_wait_top`)에서는 `delta_ms`와 `last_ms`의 의미가 기종마다 다릅니다. MySQL은
누적, PostgreSQL은 현재 스냅샷, Mongo는 대기 큐입니다. 그런데 마트엔 기종이 없어서 "누적인지
스냅샷인지는 저쪽에서 보세요"라고 적어 두었습니다. 백업 공백 마트에서는 `no_backup_observed`가
정말 백업이 안 도는 건지, 그 기종을 아직 수집 못 한 건지 못 갈랐습니다. 대시보드도 마찬가지로
`instance_id 4` 같은 숫자만 나와서 안 읽혔습니다.

각주가 한 곳이면 한계지만, 여러 곳에서 반복되면 신호입니다. 뭔가 빠져 있다는 신호입니다.

## 7. 원천은 이미 읽고 있었다

그런데 정작 기종이 든 테이블은 새로 만들 필요가 없었습니다. `database_instance`는 **이미 매
오프로드가 읽고 있었습니다.** "어느 인스턴스를 훑을지" 목록을 뽑느라 매번 읽던 그 테이블에,
`name`(local-mysql, local-postgres…)과 `type`(MYSQL, POSTGRESQL, MSSQL, MONGODB, ORACLE)이
나란히 있었습니다. 컬럼 두 개만 더 실으면 되는 거였습니다.

한 가지는 조심해야 했습니다. `database_instance`는 지금까지 내리던 팩트와 **성질이
다릅니다.** 팩트는 시계열 스냅샷이라 날짜와 인스턴스로 파티션했는데, `database_instance`는
인스턴스 목록 자체입니다. 느린 변화 차원이고, instance_id로 파티션할 수도 없습니다(그게 곧
행이니까요). 그래서 팩트 오프로드 기계를 재사용하지 않고, 전량을 날짜별로 한 파일에
스냅샷하는 작은 오프로드를 따로 만들었습니다. 이름과 기종이 나중에 바뀌면 그 이력까지
남습니다. 그리고 차원 마트(`dim_instance`)는 그중 **최신 스냅샷만** 취해 현재 상태를
만듭니다. 변화 이력이 필요하면 스테이징을 직접 보면 됩니다.

## 8. 각주가 사라진다

이 차원을 대기 마트와 주간 보고에 조인했습니다.

![기종 축이 흩어진 각주를 회수하는 구조. 왼쪽의 팩트 마트들은 instance_id 숫자만 갖고 있었는데, dim_instance를 조인하면 instance_id 1이 local-mysql (MYSQL)로 읽힌다. 이 조인 하나로 대기 마트의 delta/last 의미 각주, 백업 마트의 미백업 대 미수집 각주, 대시보드의 숫자 표기가 모두 해소된다. 새 기능이라기보다 흩어져 있던 각주의 회수다](/uploads/project/lakehouse/lh20_engine_axis.svg)

결과가 바로 읽힙니다. `instance_id 1`이 `local-mysql (MYSQL)`이 되고, top 대기 이벤트가 기종과
나란히 섭니다. `wait/io/file/sql/binlog`는 MySQL의 것이고, `WalSenderMain`은 PostgreSQL 복제,
`RESOURCE_SEMAPHORE_QUERY_COMPILE`은 MSSQL, `resmgr:cpu quantum`은 Oracle이라는 게 한눈에
보입니다. 예전엔 이 대기 이름만 보고 기종을 짐작해야 했는데, 이제 옆 칸에 기종이 있습니다.

![Metabase 주간 운영 보고 대시보드. instance_id 옆에 instance_name과 engine 컬럼이 붙어, 1은 local-mysql (MYSQL), 2는 local-postgres (POSTGRESQL), 3은 local-mssql (MSSQL), 4는 dbtower-self (POSTGRESQL)로 읽힌다. top 대기 이벤트가 기종과 나란히 서 있다](/uploads/project/lakehouse/lh20_weekly_engine.png)

이건 새 기능이라기보다 **흩어져 있던 "기종은 저쪽에서 보세요"의 회수**입니다. 원천에 이미
있던 걸 안 실었을 뿐이었습니다.

## 9. 상관에 볼륨 축을 더한다

기종 축을 붙인 김에, 앞에서 열어 둔 상관 층에 볼륨 축을 마저 더했습니다. 상관에 플랜
뒤집힘과 지연 두 축을 뒀는데, 여기에 **변경 전후로 용량이 급증했나**를 더했습니다. 설정
변경 뒤 인스턴스의 총 크기가 임계 이상 커지면 `followed_by_size_growth`로 잡습니다.

다만 이 축은 정직하게 약한 신호입니다. 설정 변경이 디스크를 직접 키우는 경우는 드뭅니다.
로깅을 켜거나 WAL 보존을 늘리는 정도입니다. 그래서 우선순위 사다리의 **맨 아래**에 두고,
회귀나 지연 상승이 있으면 그쪽을 먼저 봅니다. 세 축(플랜·지연·볼륨)을 한 번에 조인하면
행이 곱해져 부풀 수 있어서, 지연과 볼륨을 인스턴스와 날짜 단위로 먼저 접어 조인 폭발을
막았습니다. 평균과 합의 의미는 그래도 그대로입니다.

## 10. 판정이 다섯인데 "떠 있었나"가 없었다

창고의 판정이 어느새 다섯이 됐습니다. 용량 D-day, 플랜 회귀, 백업 공백, 미사용 인덱스,
설정 변경 상관. 그런데 대시보드를 보다가 이상한 걸 느꼈습니다. 정작 제일 기본적인 질문인
**"이 DB 이번 주, 이번 분기 얼마나 떠 있었나"**는 못 답하고 있었습니다.

DBTower에는 `health_sample`이라는 테이블이 있습니다. 1분마다 각 인스턴스에 핑을 날려
`up` 여부와 `ping_millis`를 쌓습니다. `SloService`가 이걸로 30일 가용성 SLO와 에러버짓을
계산합니다. 그런데 이 테이블은 **35일만 보존하고 지웁니다.** 에러버짓 회계 기간보다 조금
길게만 잡아 두는 겁니다. 그래서 30일 넘는 장기 가용성은 어디에도 남지 않았습니다.

## 11. 정말 lakehouse의 몫인지부터 확인했다

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

## 12. 1분 샘플을 하루로 접는다

`fct_uptime_daily`는 하루치 1분 샘플을 하나로 접습니다. `uptime_pct`는 up 샘플을 전체 샘플로
나눈 값입니다. 여기서 작은 함정이 하나 있었습니다. **다운일 때의 `ping_millis`는 타임아웃
값**입니다. 이걸 평균에 넣으면 가끔 다운된 인스턴스의 평균 지연이 실제보다 훨씬 나빠 보입니다.
그래서 ping의 평균과 p95는 `up`인 샘플로만 냈습니다. 가용성은 전체 샘플로, 지연은 살아 있던
샘플로 봅니다.

그리고 `mart_uptime_slo`는 최근 30일 가용성을 목표와 견줍니다. 목표는 seed로 인스턴스별로
정하거나(기본 99.5%), 전역 기본을 씁니다. 그리고 SRE 에러버짓을 냅니다. 목표 99.5%는 한 달에
다운을 약 3.6시간까지 허용한다는 뜻인데, 그중 얼마가 남았는지를 잔량 퍼센트로 계산합니다.
남은 게 음수면 이미 목표를 넘긴 겁니다. 판정은 목표 미달이면 breach, 버짓을 거의 소진했으면
at_risk, 그 외는 meets입니다. 발화는 여기서도 안 합니다. SLO 판정까지만 계산하고, 다운 알림은
DBTower나 Metabase의 몫입니다.

## 13. 라이브에서 바로 켜졌다

지금까지의 상관 마트들은 후행 관측이 필요해서 실데이터로 켜지려면 시간이 걸렸는데, 가용성은
**연속 측정이라 바로 의미 있게 채워졌습니다.**

![Metabase 가용성 SLO 대시보드 실화면. instance_name과 engine이 붙어 있고, local-mssql은 63.45퍼센트에 worst day 41.19퍼센트, 평균 ping 2132밀리초, mssql-pitr는 64.28퍼센트에 평균 ping 6897밀리초로 목표 99.9에 한참 못 미친다. local-mysql은 98.86퍼센트, PostgreSQL과 Mongo와 Oracle은 99.9퍼센트대다](/uploads/project/lakehouse/lh21_slo_dashboard.png)

결과가 선명합니다. MSSQL 두 인스턴스가 63퍼센트대 가용성에 평균 ping이 2초에서 7초입니다.
`worst_day_uptime_pct`를 보면 최악의 날은 41퍼센트까지 떨어졌습니다. 반면 PostgreSQL, Mongo,
Oracle은 99.9퍼센트로 목표를 지키고, DBTower 자기 자신(dbtower-self)은 100퍼센트입니다.
기종 축을 앞에서 붙여 둔 덕에 "어느 기종이 몇 퍼센트 떴나"가 한 줄로 읽힙니다. MSSQL이
지금 문제라는 게 숫자로 바로 보입니다.

주간 보고에도 `this_week_uptime_pct` 한 칸을 더했습니다. 이제 주간 보고 한 줄이 "이 DB
이번 주 어땠나"를 느림, 용량, 백업에 더해 **떠 있었나까지** 답합니다.

## 14. 마지막 빈 자리

이걸로 창고의 판정이 여섯이 됐습니다. 용량, 플랜, 백업, 인덱스, 설정 상관, 그리고 가용성입니다.
전수 대조에서 남았던 유일한 빈 자리가 채워졌고, 그게 마침 제일 기본적인 "떠 있었나"였습니다.

이번 편을 관통한 방식은 하나였습니다. 축을 미리 다 벌려 놓기보다, 신호가 실제로 도는 걸 보고
하나씩 붙였습니다. change_review는 자리만 열어 두었고, 볼륨 축은 우선순위 맨 아래에 뒀고,
가용성은 마지막에야 확인 절차를 거쳐 가져왔습니다. 기종 축처럼 "짓기"보다 "회수"에 가까운
것도 있었습니다.

여기서 남은 건 정말로 시간이 해제하는 것들뿐입니다. 플랜 이력이 쌓이면 플랜 회귀와 설정 상관이
실데이터로 켜지고, 그건 코드가 아니라 날짜가 하는 일입니다. DBTower의 나머지 테이블은 콘솔
감사거나 인프라거나 이미 다른 집(Prometheus)이 있어서, 창고가 더 가져올 게 없습니다. 관리 대상
DB에 관해 창고가 답할 수 있는 판정은 여기서 한 바퀴가 찼습니다.

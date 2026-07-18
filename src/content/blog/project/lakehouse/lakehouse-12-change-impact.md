---
title: '상관이 한 축으로는 안 켜졌고, 그래서 안 지을 것과 넓힐 것을 갈랐습니다'
titleEn: 'The Correlation Would Not Light Up on One Axis, So I Separated What Not to Build from What to Widen'
description: '앞 편에서 만든 설정 변경 영향 상관은 실데이터에서 계속 no_flip_observed였습니다. 창고의 플랜 이력이 얕아 겹칠 뒤집힘이 없었기 때문인데, 이건 상관을 플랜 뒤집힘 하나에만 묶어 둔 설계의 한계였습니다. 원인의 축은 여럿입니다. 파라미터가 바뀌면 플랜이 뒤집히지 않고도 그냥 느려질 수 있고, 바뀌는 대상도 파라미터만이 아니라 스키마일 수 있습니다. 그래서 두 가지를 갈랐습니다. change_review(스키마 변경 리뷰, DBTower에 이미 있는 기능)를 통째로 오프로드하는 것은 안 짓기로 했습니다. 리뷰는 저빈도 감사 데이터라 버려지는 데이터의 두 번째 삶이라는 전제가 약하고 상관 신호도 성깁니다. 대신 상관을 일반화해서 소스가 늘면 끼우기만 하면 되게 자리를 열었습니다. int_change_events가 변경을 한 형태로 모으고, 지금은 설정 변경만 들어오지만 스키마 변경은 union all 자리를 코드에 주석으로 남겨 두었습니다. 그리고 값이 확실한 지연 축을 더했습니다. mart_config_impact가 변경 전후로 그 인스턴스의 평균 지연이 올랐는지를 봐서, 플랜이 안 뒤집혀도 followed_by_latency_rise로 잡습니다. 마지막으로 미사용 인덱스 판정의 지평 경계를 문서에 못박았습니다. DBTower의 라이브 분석기와 lakehouse의 90일 마트가 둘 다 미사용 인덱스를 판정하니, 단기 즉답은 라이브 장기 확정은 마트라는 분업을 명시했습니다. 라이브에서 상관 마트는 change_source와 변경 전 지연을 실측으로 채웠고, 변경 후 지연은 변경이 당일이라 미래 창이 비어 아직 no_signal입니다.'
descriptionEn: 'The config-change impact correlation I built last time kept reading no_flip_observed on real data. The warehouse plan history was too shallow to overlap any flip, which exposed the limit of tying correlation to a single axis. Causes have several axes: a parameter can slow a query without flipping its plan, and what changes is not only parameters but schema. So I separated two things. I decided not to build a full offload of change_review (the schema-change review feature DBTower already has), because reviews are low-volume audit data where the "second life for discarded data" premise is weak and correlation signal is sparse. Instead I generalized the correlation so a source can plug in later. int_change_events unifies changes into one shape, only config flows in now, and the schema-change source is left as a commented union all seat. Then I added the axis whose value is certain: mart_config_impact now checks whether the instance''s average latency rose across the change, flagging followed_by_latency_rise even when no plan flips. Finally I pinned the horizon boundary for the unused-index verdict, since DBTower''s live analyzer and lakehouse''s 90-day mart both judge unused indexes: short answers from live, quarter-long confirmation from the mart. Live, the correlation mart filled change_source and before-change latency from real data, while after-change latency is still empty because the change happened today, so it honestly reads no_signal.'
date: 2026-07-18
tags:
  - Data Engineering
  - dbt
  - DuckDB
  - Metabase
category: personal/lakehouse
coverImage: /uploads/project/lakehouse/cover.svg
draft: false
series: "lakehouse"
seriesOrder: 12
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
둔갑해 회귀를 개선으로 오판하는데, 그 함정은 앞 단계에서 이미 배운 것이라 그대로 피했습니다.

## 4. 지평 경계를 못박는다

마지막은 코드가 아니라 문서입니다. 미사용 인덱스 판정을 놓고 보면, DBTower에도 라이브
분석기(`UnusedIndexAnalyzer`)가 있고 lakehouse에도 90일 마트(`mart_index_verdict`)가 있습니다.
둘 다 "미사용 인덱스"를 판정하니, 셀프호스터 입장에서 어느 걸 믿어야 하는지 헷갈릴 수 있습니다.

용량 D-day에서 세운 분업을 그대로 적용했습니다. **단기·즉답이 필요하면 DBTower 라이브,
"분기 내내 정말 안 쓰였나"의 확정은 장기 마트.** DBTower의 순간 판정은 방금 재기동한 서버의
0회도 미사용처럼 보이는 약점이 있고, 90일 창은 그 노이즈에 안 흔들립니다. 원천(인덱스 사용
통계)은 같고 창만 다른 상호보완이지 경쟁이 아닙니다. 이 경계를 마트 헤더와 로드맵에 못박아,
"지워도 되나"를 확정할 때는 마트를, "지금 훑어보기"는 DBTower 화면을 보게 했습니다.

## 5. 라이브에서 나온 것

상관 마트를 실데이터에 다시 돌렸습니다. 이제 `change_source`가 config로 채워지고, 변경 전
지연이 실측으로 붙습니다. 인스턴스 2는 변경 전 평균 3.1ms, 인스턴스 4는 35.04ms였습니다.

![Metabase 설정 드리프트 대시보드의 영향 카드. change_source와 change_key 컬럼이 채워져 변경 소스가 일반화됐음을 보여준다. 인스턴스 2와 4의 work_mem 변경이 config 소스로 기록돼 있다](/uploads/project/lakehouse/lh19_impact_dashboard.png)

변경 후 지연은 아직 비어 있습니다. work_mem 변경이 오늘 일어났는데, "변경 후 N일"의 창이
아직 미래라 채울 데이터가 없기 때문입니다. 그래서 상관은 `no_signal`입니다. 이건 버그가 아니라
정직한 상태입니다. 내일부터 데이터가 쌓이면 후 창이 차고, 지연이 올랐다면 상관이 켜집니다.
두 축(플랜·지연) 모두 변경 이후의 관측이 필요하다는 성질이라, 당일 변경이 아직 no_signal인 건
당연합니다.

## 6. 남은 것

이번 편은 새 기능을 많이 짓기보다 **무엇을 안 지을지 정한** 쪽에 가깝습니다. change_review는
자리만 열어 두었고, 실제로 "이 DDL 뒤로 느려졌다"는 질문이 현업에서 생기는 날 소스 하나로
붙이면 됩니다. 그때는 리뷰가 사후에 승인되는 저빈도 변이 테이블이라, 백업 이력에서 썼던 D+1
스냅샷 계약을 그대로 가져오면 됩니다.

상관 층은 아직 플랜 뒤집힘과 지연 두 축입니다. 볼륨 성장으로 느려지는 회귀는 롤링 랭킹 마트의
몫이라 여기 안 겹쳤는데, 그 축까지 언제 더할지는 이력이 더 쌓여 상관이 실제로 켜지는 걸 보고
정하려 합니다. 축을 미리 다 벌려 놓기보다, 신호가 실제로 도는 걸 확인하며 하나씩 붙이는 게
이 프로젝트의 방식입니다.

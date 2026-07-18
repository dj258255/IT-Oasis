---
title: '판정은 "무엇이 언제"까지만 말했고, "왜 그렇게 됐나"의 첫 후보가 빠져 있었습니다'
titleEn: 'The Verdicts Told Us What and When, but the First Candidate for Why Was Missing'
description: '지금까지 만든 판정 셋(용량 D-day·플랜 회귀·백업 공백)은 "무엇이 언제"까지는 답했지만 "왜 그렇게 됐나"는 답하지 못했습니다. DBA 장애의 흔한 숨은 원인은 사람이 조용히 바꾼 파라미터인데, DBTower는 설정 변경을 1시간마다 감지해 쌓으면서도 그 이력을 7일류로 지웁니다. "3개월 전 언제부터 work_mem이 달라졌나"와 "그 변경 뒤 성능이 나빠졌나"는 장기 이력이 있어야 답하는데 매일 사라지고 있었습니다. 그래서 config_snapshot과 config_param_change를 창고로 내렸습니다. 신규 수집은 필요 없었습니다. 원천은 DBTower에 이미 완성돼 있어서, 이건 lakehouse 단독 작업이었습니다. fct_config_change_daily는 config_snapshot을 스파인으로 삼아 "수집됐는데 무변경"과 "수집 자체가 없음"을 구분합니다. mart_config_change는 최근 90일 변경 타임라인을 서빙합니다. 그리고 이 창고만 할 수 있는 판정인 mart_config_impact를 만들었습니다. 설정 변경 뒤 N일 안에 그 인스턴스에서 플랜이 뒤집히거나 회귀가 관측됐나를 상관시킵니다. 장기 설정 이력과 장기 성능 이력이 같은 창고에 있어야만 가능한 판정이고, DBTower의 7일 창은 구조적으로 못 합니다. 라이브에서 인스턴스 2와 4의 work_mem이 4096에서 8192로 올랐다가 다시 내려온 실제 드리프트를 잡았고, 일별 팩트는 나머지 다섯 인스턴스가 23사이클 수집됐지만 무변경임을 정직하게 구분했습니다. 상관은 지금 플랜 이력이 하루뿐이라 no_flip_observed이지만, CI 픽스처에서는 변경과 뒤집힘을 겹쳐 followed_by_plan_flip이 나오는 것을 확인했습니다. 상관은 인과가 아니라서 조언 어휘로만 싣고, "누가" 바꿨는지는 대상 DB가 주지 않아 담지 않습니다.'
descriptionEn: 'The three verdicts so far (capacity D-day, plan regression, backup gap) answered what and when, but not why. A common hidden cause of DBA incidents is a parameter someone quietly changed, and while DBTower detects config changes hourly, it prunes that history within days. "When over the last quarter did work_mem change" and "did performance degrade after that change" both need long-term history that was vanishing daily. So I offloaded config_snapshot and config_param_change to the warehouse. No new collection was needed: the producer already exists in DBTower, making this lakehouse-only work. fct_config_change_daily uses config_snapshot as a spine to distinguish "collected but unchanged" from "not collected at all." mart_config_change serves a 90-day change timeline. And I built the verdict only this warehouse can produce, mart_config_impact, correlating each config change with plan flips or regressions observed on that instance within N days. It needs long-term config history and long-term performance history in the same warehouse, which DBTower''s 7-day window structurally cannot do. Live, it caught real drift where instances 2 and 4 had work_mem raised from 4096 to 8192 and then lowered again, while the daily fact honestly showed the other five instances collected across 23 cycles with no change. The correlation currently reads no_flip_observed because plan history is only one day deep, but the CI fixture overlays a change with a flip and confirms followed_by_plan_flip. Correlation is not causation, so it ships only as advisory wording, and "who" changed it is not stored because the target DB does not provide it.'
date: 2026-07-18
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
seriesOrder: 11
---

## 0. 판정에 "왜"가 없었다

지난 편까지 창고가 내리는 판정이 넷이 됐습니다. 용량 D-day, 플랜 회귀, 백업 공백,
그리고 미사용 인덱스. 그런데 이것들은 전부 "무엇이 언제"까지만 답합니다. "이 쿼리가
느려졌다", "이 인스턴스 백업이 3주째 없다" 까지는 말하는데, **"왜 그렇게 됐나"의 첫
후보**는 아무도 안 짚어 줍니다.

DBA 장애의 흔한 숨은 원인 하나가 사람이 조용히 바꾼 파라미터입니다. `work_mem`을 줄였거나
`max_connections`를 건드렸는데, 그게 며칠 뒤 특정 쿼리의 플랜을 뒤집습니다. DBTower는
이 설정 변경을 1시간마다 감지해서 쌓습니다. 그런데 그 이력을 7일류로 지웁니다(자체 정리
잡이 돕니다). "3개월 전 언제부터 이 인스턴스 설정이 달라졌나"와 "그 변경 뒤로 성능이
나빠졌나"는 장기 이력이 있어야 답하는데, 그게 매일 사라지고 있었습니다.

## 1. 원천은 DBTower에 이미 있었다

이번엔 착수가 가벼웠습니다. 앞선 단계들(대기 이벤트, 인덱스 통계)은 DBTower 쪽에 테이블과
수집 잡을 새로 만들어야 했는데, 설정 드리프트는 **producer가 이미 완성**돼 있었습니다.
DBTower가 `config_snapshot`(매 수집 1행, 무변경도 해시로 증명)과 `config_param_change`
(바뀐 파라미터만 append)를 1시간 주기로 쌓고, 기존 파라미터 조회 기능을 5기종에서
재사용합니다. 그래서 이 단계는 lakehouse 단독 작업이었습니다. DBTower 쪽은 읽기 권한
한 줄만 주면 됩니다.

내릴 테이블을 고를 때 하나는 뺐습니다. `config_current_param`은 "현재 전량 거울"이라
값이 바뀔 때마다 덮어쓰고 지우는 변이 테이블입니다. 이 창고는 불변 append만 내린다는
계약을 지켜야 해서, 시간이 지나도 안 바뀌는 두 테이블만 오프로드 대상으로 삼았습니다.

## 2. 무변경도 기록한다

첫 마트 `fct_config_change_daily`에서 신경 쓴 건 **"조용한 날"과 "빈 날"의 구분**입니다.
설정이 안 바뀐 날은 정상입니다. 하지만 수집 자체가 안 돈 날은 문제입니다. 이 둘을 뭉개면
"변경 0"이 두 가지 다른 상태를 가립니다.

그래서 팩트의 스파인을 `config_snapshot`으로 잡았습니다. 이 테이블은 무변경 사이클에도
1행을 남기니까(해시로 "그 시각 설정은 이랬다"를 증명), 이 행이 있으면 "수집됐다"는 뜻입니다.
여기에 실제 변경 상세를 `config_param_change`에서 붙입니다. 결과적으로 한 인스턴스의 하루가
"23사이클 수집됐고 변경은 0" 인지 "수집 자체가 없음" 인지 구분됩니다. 백업 공백 마트에서
"기록 없음"을 행으로 드러냈던 그 정직함과 같은 결입니다.

## 3. 변경 타임라인, 그리고 DuckDB가 낸 내부 오류

두 번째 마트 `mart_config_change`는 최근 90일 변경을 시간순으로 서빙합니다. "언제 무엇이
어떻게 바뀌었나"의 답입니다.

여기서 예상 못한 벽을 만났습니다. 처음엔 스테이징 뷰에서 `select *`로 전체 컬럼을 가져와
최신 dt 기준으로 창을 잘랐는데, DuckDB가 `INTERNAL Error: Attempted to access index 8
within vector of size 8`을 냈습니다. 원인은 파티션 규약이었습니다. 원천 parquet는
`dt=.../instance_id=.../` 로 나뉘는데, `instance_id`는 파일 안에도 컬럼으로 있고 경로에도
있습니다. `select *`가 hive 파티션 뷰 위에서 자기 자신을 참조하는 `max(dt)` 서브쿼리와
겹치자, 바인더가 중복 컬럼을 세다 벡터 범위를 넘었습니다. 컬럼을 명시로 나열하고 창 기준을
별도 CTE(anchor)로 뽑아 `날짜 - 정수` 산수로 바꾸니 사라졌습니다. 롤링 회귀 마트에서 쓰던
그 안정적인 패턴 그대로입니다.

## 4. 원인 후보로 겹친다

세 번째 마트가 이 단계의 핵심입니다. `mart_config_impact`는 설정 변경 이벤트와 플랜
뒤집힘을 시간축으로 겹칩니다. 어떤 파라미터가 바뀐 뒤 N일(기본 7일) 안에, 그 인스턴스에서
플랜이 뒤집히거나 회귀(REGRESSED)가 관측됐나를 셉니다.

![설정 변경 영향 상관의 개념. 위 레인의 설정 변경(work_mem 4MB→1MB)에서 아래 레인의 플랜 뒤집힘·지연 증가로 이어지는 화살표. 변경 뒤 하루 안에 회귀가 뒤따르면 correlation=followed_by_regression으로 판정한다. 상관이지 인과가 아니라는 것을 판정 박스에 명시했다](/uploads/project/lakehouse/lh18_config_correlation.svg)

이건 **장기 설정 이력과 장기 성능 이력이 같은 창고에 있어야만 가능**한 판정입니다. DBTower의
7일 창은 설정 변경도 성능 이력도 7일치뿐이라 이 상관을 못 봅니다. 용량 D-day, 플랜 회귀,
백업 공백에 이은 네 번째 "창고라야 가능한 판정"이고, 앞의 판정들에 "왜 그렇게 됐나"의 첫
후보를 붙이는 층입니다.

정직함을 두 군데 박았습니다. 첫째, **상관은 인과가 아닙니다.** "이 설정이 원인"이라고
단정하지 않고 `followed_by_regression` / `followed_by_plan_flip` / `no_flip_observed`
라는 관측 사실만 조언 어휘로 싣습니다. 최종 판단은 사람의 몫입니다. 미사용 인덱스 마트에서
"삭제 지시"가 아니라 "후보"라고만 했던 그 절제와 같습니다. 둘째, **"누가" 바꿨는지는
못 담습니다.** 파라미터를 누가 바꿨는지는 대상 DB가 주지 않는 정보라 DBTower도 저장하지
않고, 이 창고도 "언제 무엇이 어떻게" 까지만 압니다.

## 5. 라이브에서 나온 것

dev 창고에서 돌렸더니 원천에 진짜 드리프트가 있었습니다. 인스턴스 2와 4의 `work_mem`이
4096에서 8192로 올랐다가 다시 4096으로 내려와 있었습니다. 누군가 올렸다가 되돌린 흔적입니다.

![Metabase 설정 드리프트 대시보드 실화면. 왼쪽 위는 변경 타임라인으로 인스턴스 2·4의 work_mem이 4096과 8192 사이를 오간 기록이다. 오른쪽 위는 영향 상관 표다. 아래는 일별 수집·변경 표인데, 인스턴스 2·4는 change_events가 2이고 나머지 다섯은 0이지만 cycles_collected가 모두 23이라 무변경과 미수집이 구분된다](/uploads/project/lakehouse/lh18_config_dashboard.png)

`fct_config_change_daily`가 정확히 의도대로 나왔습니다. 일곱 인스턴스 전부 그날 23사이클
수집됐고(수집됨의 증거), 그중 2와 4만 변경 이벤트 2건에 파라미터 1종이 바뀌었으며, 나머지
다섯은 변경 0입니다. "무변경"과 "미수집"이 한 표에서 갈립니다.

상관 마트는 네 변경 이벤트 모두 `no_flip_observed`로 나왔습니다. 창고의 플랜 이력이 아직
하루뿐이라 겹칠 뒤집힘이 없기 때문입니다. 정직한 결과입니다. 그래서 로직 자체는 CI 픽스처로
증명했습니다. 설정 변경(1월 1일)과 플랜 뒤집힘(1월 2일)을 일부러 겹쳐 두니
`followed_by_plan_flip`이 나옵니다. 실데이터에서 이 상관이 켜지는 건 플랜 이력이 쌓인
뒤이고, 그 조건과 예상 시점은 로드맵의 "시간이 해제하는 체크리스트"에 적어 뒀습니다.

## 6. 남은 것

이걸로 창고의 판정이 다섯이 됐고, 그중 하나는 앞의 판정들에 "왜"의 첫 후보를 붙입니다.
설정 변경은 지금도 실물로 잡히고, 그 변경이 성능 회귀와 겹쳤는지는 이력이 쌓이며 켜집니다.

발화 경계는 이번에도 지켰습니다. 창고는 타임라인과 상관까지만 계산하고, "이 설정 바뀐 뒤
회귀가 시작됐다" 같은 급변 알림은 DBTower의 reverse ETL이나 Metabase 구독이 쏩니다.
두 번째 알림 시스템을 만들지 않습니다.

한 가지 더 정직하게 적자면, 이 상관은 플랜 뒤집힘 하나만 본다는 한계가 있습니다. 볼륨
증가로 같은 플랜이 느려지는 회귀는 롤링 랭킹 마트의 몫이라 여기서는 안 겹칩니다. 원인의
축이 여럿이라는 뜻이고, 지금 겹친 건 그중 "설정 변경 → 플랜 변경" 한 갈래입니다. 나머지
축을 이 상관 층에 어떻게 더할지는 이력이 더 쌓인 다음의 일로 남겨 둡니다.

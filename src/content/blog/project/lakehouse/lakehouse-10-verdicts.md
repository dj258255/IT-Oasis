---
title: '창고에 데이터만 내리고 판정은 안 하고 있었습니다 — 플랜 회귀·백업 공백·주간 보고, 그리고 "왜 느려졌나"의 첫 후보'
titleEn: 'We Were Only Landing Data, Never Judging It — Plan Regression, Backup Gaps, a Weekly Report, and the First Candidate for "Why"'
description: '창고에 데이터를 내리기만 하고 판정을 안 하고 있었습니다. plan_snapshot과 fct_query_daily를 둘 다 갖고도 상관시키지 않아 "새벽에 느려졌다"는 신고마다 DBA가 30분씩 플랜 이력을 뒤졌고, fct_backup_daily엔 "마지막 성공 백업이 며칠 전인가"라는 판정 컬럼이 없어 백업 공백을 복구하다 발견했습니다. 셋 다 신규 수집 없이 이미 내린 데이터를 판정 컬럼까지 밀어붙이는 일이었습니다. 플랜 회귀는 일 단위 대표 플랜의 뒤집힘을 잡아 전후 N일 지연을 비교하되 관측이 덜 차면 PENDING, 비교창이 오염되면 AMBIGUOUS로 지어내지 않고, 백업 공백은 유니버스를 query 팩트에서 잡아 기록 없는 인스턴스도 행으로 드러내며 기준일을 벽시계가 아닌 창고 최신 dt로 잡습니다. 라이브에서 4개가 no_backup_observed로 나왔는데 원천엔 백업이 있어 마트가 breach로 단정하지 않은 게 정확했습니다. 이 셋을 주간 보고 한 장으로 접었습니다. 그리고 이 판정들은 "무엇이 언제"까지만 답한다는 걸 깨달아, "왜 그렇게 됐나"의 첫 후보로 설정 드리프트를 붙였습니다. DBTower가 1시간마다 쌓고 7일 뒤 지우는 config_snapshot과 config_param_change를 장기 보관해, config_snapshot을 스파인으로 "수집됐는데 무변경"과 "수집 없음"을 구분하고, 설정 변경을 플랜 뒤집힘과 시간축으로 겹쳐 원인 후보를 지목합니다. 상관이지 인과가 아니라 조언 어휘로만 싣고, "누가" 바꿨는지는 대상 DB가 주지 않아 담지 않습니다.'
descriptionEn: 'We were only landing data in the warehouse and never judging it. We held both plan_snapshot and fct_query_daily without correlating them, so every "slow last night" report cost a DBA 30 minutes of digging through plan history, and fct_backup_daily had no verdict column for "days since last successful backup," so silent gaps got found during recovery. All three needed no new collection, just pushing landed data through to a verdict. Plan regression detects day-level dominant-plan flips and compares latency across N days before and after, refusing to invent a verdict when observation is thin (PENDING) or the window is contaminated (AMBIGUOUS); backup RPO draws its universe from the query fact so instances with no backup rows still surface, and anchors "as of" to the warehouse latest dt, not the wall clock. Live, four instances read no_backup_observed while the source had backups, so the mart was right not to declare a breach. These fold into one weekly report. Then, realizing these verdicts answer only "what and when," I added config drift as the first candidate for "why": long-term storage of config_snapshot and config_param_change that DBTower stacks hourly and prunes after seven days, using config_snapshot as a spine to separate "collected but unchanged" from "not collected," and overlaying config changes with plan flips on the time axis. It ships as advisory correlation, not causation, and does not store "who," which the target DB never provides.'
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
seriesOrder: 10
---

## 0. 데이터는 내렸는데 판정을 안 하고 있었다

지난 편들에서 원천 세 테이블(백업 이력, 플랜 변경, 대기 이벤트)을 창고로 내리고,
용량 예측까지 붙였습니다. 그런데 어느 순간 이상했습니다. 재료는 다 창고에 있는데,
정작 DBA가 매일 겪는 몇 가지 병목에는 아무 답도 못 내고 있었습니다.

세 장면을 떠올렸습니다.

새벽 3시에 "특정 쿼리가 갑자기 느려졌다"는 신고가 옵니다. 단골 원인은 옵티마이저가
통계 갱신이나 분포 변화로 플랜을 갈아탄 건데, 새 플랜이 더 느린 경우입니다. 저는
`plan_snapshot`(플랜이 언제 어떤 해시로 바뀌었나)과 `fct_query_daily`(그 쿼리의
일별 평균 지연)를 **둘 다** 갖고 있으면서, 이 둘을 한 번도 겹쳐 보지 않았습니다.
그래서 이 상황이 오면 사람이 플랜 이력과 지연 그래프를 눈으로 대조합니다. 건당 30분입니다.

복구하려고 보니 백업이 3주째 조용히 안 돌고 있었습니다. `fct_backup_daily`에는 일별
성공·실패 집계가 있는데, "이 인스턴스는 마지막 성공 백업이 며칠 전이다"라는 판정 컬럼이
없었습니다. 실패는 시끄럽습니다. FAILED 행이 남으니까요. 그런데 공백은 조용합니다.
행 자체가 없기 때문입니다. 아무도 그 부재를 묻지 않습니다.

월요일 오전은 보고서 만드는 날입니다. 용량 D-day, top 대기 이벤트, 플랜 변경 건수,
백업 상태를 화면 네 곳에서 긁어모아 문서로 만듭니다. 재료는 전부 창고에 있는데, 그걸
한 장으로 접는 계층이 없었습니다.

세 가지 모두 사람의 시간이 새는 지점입니다. 그리고 세 가지 모두 **신규 수집이 필요
없었습니다.** 이미 내린 데이터를 판정 컬럼까지 밀어붙이는 일이었습니다.

## 1. 왜 이게 창고의 몫인가

DBTower의 라이브 시야는 7일입니다. 그 창으로는 구조적으로 못 하는 판정이 있습니다.

플랜 회귀는 "며칠치 전후 비교"가 있어야 합니다. 뒤집힌 그날 하루만 보면 이게 개선인지
악화인지 알 수 없습니다. 뒤집힘 전 며칠과 후 며칠의 평균 지연을 비교해야 판정이 섭니다.

백업 공백은 "분기 내내 0회"와 "지난주 이후 0회"를 구분해야 합니다. 순간 관측으로는
둘이 똑같아 보입니다. 장기 이력이 있어야 마지막 성공일을 찾고 경과일을 잽니다.

이건 이미 이 프로젝트가 서 있는 자리(용량 D-day)와 같은 계열입니다. 미래 외삽, 시점
전후 상관, 부재 감지. 셋 다 7일 창으로는 못 보고 장기 창고라야 보이는 판정입니다.
이번 편에서 이 셋을 마트 세 개로 채웁니다. 발화는 여전히 안 합니다. 앞서 정한
원칙대로, 창고는 판정 컬럼까지만 계산하고 알림은 Metabase(사람이 pull) 또는
DBTower(기계가 push)의 몫으로 둡니다. 두 번째 알림 시스템을 만들지 않습니다.

## 2. 플랜 회귀: 뒤집힘을 지연과 겹친다

먼저 뒤집힘을 정의해야 했습니다. `plan_snapshot`은 한 쿼리에 대해 하루에도 여러 플랜
해시를 담을 수 있어서(쿼리당 최신 20개 보존), 관측 하나하나로 뒤집힘을 세면 같은 하루
안의 출렁임까지 뒤집힘으로 잡힙니다. 그래서 크기 마트에서 "그날 마지막 관측이 대푯값"을
쓴 것과 같은 방식으로, **하루의 대표 플랜**을 그날 마지막 관측의 해시로 잡았습니다.
이제 grain이 `fct_query_daily`와 같은 일 단위가 됩니다.

뒤집힘은 대표 플랜을 날짜순으로 놓고 `lag`로 직전과 비교해, 해시가 실제로 바뀐 행만
이벤트로 남깁니다. 같은 해시가 반복되면 뒤집힘이 아니고, 첫 관측은 직전이 없으니 등장이지
뒤집힘이 아닙니다. 둘 다 걸러집니다.

뒤집힘이 잡히면 그 시점을 지연과 겹칩니다. 뒤집힘 전 N일과 후 N일(기본 3일)의 평균
지연을 비교합니다.

![플랜 회귀 판정의 개념. 대표 플랜이 A에서 B로 뒤집힌 날을 기준으로, 전 N일과 후 N일의 평균 지연을 비교한다. 뒤집힘 당일은 전후 플랜이 섞이므로 양쪽에서 제외하고, 후/전 비율이 임계를 넘으면 REGRESSED로 판정한다](/uploads/project/lakehouse/lh16_plan_regression.svg)

세 가지를 조심했습니다.

**뒤집힘 당일은 전후가 섞입니다.** 그날은 오전엔 옛 플랜, 오후엔 새 플랜일 수 있어서
지연이 혼합됩니다. 그래서 당일 dt는 전 창에서도 후 창에서도 뺍니다.

**지연이 NULL인 날을 0으로 접으면 안 됩니다.** `fct_query_daily`는 그날 호출이 0이면
평균 지연을 0이 아니라 NULL로 둡니다. 나눌 게 없으니까요. 전후 평균을 낼 때 NULL을 0으로
접으면, 활동이 없던 날이 "0ms로 빨라진 날"로 둔갑해 회귀를 개선으로 오판합니다. 평균은
NULL을 자연 제외하도록 뒀습니다.

**판정을 지어내지 않습니다.** 후 N일이 아직 안 지났으면 비교할 데이터가 없으니 PENDING으로
두고, 매일 재계산되며 시간이 차면 확정됩니다. 같은 쿼리가 비교창 안에서 또 뒤집혔으면
전후가 다른 뒤집힘에 오염되므로 AMBIGUOUS로 둡니다. 억지로 REGRESSED라고 답하는 것보다
"지금은 판단 못 함"이 정직합니다.

비율 판정에는 앞선 CI에서 배운 걸 그대로 적용했습니다. 후/전 비율을 소수 둘째 자리로
반올림한 값으로 판정해서, 플랫폼마다 최하위 비트가 흔들리는 부동소수 때문에 맥과 CI
러너가 다른 답을 내는 일을 막았습니다.

산식은 unit test 네 개로 못박았습니다. 10ms에서 30ms로 세 배가 된 뒤집힘은 REGRESSED,
후 관측이 없으면 PENDING, 2일 간격 재뒤집힘은 AMBIGUOUS, 그리고 백업 쪽까지. 실데이터가
없어도 이 판정 로직이 조용히 바뀌면 CI에서 깨집니다.

## 3. 백업 공백: 침묵을 행으로 만든다

백업 공백 마트에서 제일 중요한 결정은 **인스턴스 유니버스를 어디서 잡느냐**였습니다.
백업 테이블에서 인스턴스 목록을 뽑으면, 백업 기록이 아예 없는 인스턴스가 목록에서 사라집니다.
정작 제일 위험한 대상인데 조용히 빠지는 겁니다. 그래서 유니버스를 `fct_query_daily`의
distinct 인스턴스(모든 기종이 공통으로 남기는 관측)에서 잡고, 백업 팩트를 left join
했습니다. 이러면 기록 부재가 사라지지 않고 행으로 드러납니다. 원천 계약을 건드리지 않고
`database_instance` 신규 추출 없이 전수를 확보하는 방법이기도 합니다.

두 번째는 **기준일을 벽시계로 잡지 않는 것**입니다. "오늘로부터 며칠 전"으로 잡으면
파이프라인이 죽어도 gap이 자랍니다. 백업은 멀쩡히 도는데 창고가 갱신을 못 받으면
백업 공백처럼 보인다는 뜻입니다. 그래서 기준을 창고의 최신 dt로 잡았습니다. 파이프라인
신선도는 게이트와 deadman이 이미 보는 관심사라, 여기서 섞지 않습니다.

세 번째가 이 마트의 정직함입니다. "성공 백업 관측이 없음"은 두 경우가 섞여 있습니다.
백업이 정말 안 도는 경우와, 그 기종의 백업 이력을 아직 수집 못 한 경우입니다. 이 창고에는
기종 축이 없어서(대기 마트와 같은 한계입니다) 둘을 구분할 수 없습니다. 그래서 breach라고
단정하지 않고 `no_backup_observed`라는 사실만 싣습니다. 소비자가 DBTower 인스턴스 화면에서
기종을 알고 해석합니다.

## 4. 주간 보고: 네 판정을 한 장으로

앞의 둘에 용량 예측과 대기 top을 더하면, 월요일 보고서의 재료가 다 모입니다. 인스턴스당
한 행에 용량 위험도와 D-day, 이번 주 top 대기, 이번 주 플랜 뒤집힘 수와 그중 회귀 수,
백업 경과일과 상태를 접었습니다. 용량·대기·백업은 지금 시점의 스냅샷이고, 플랜 뒤집힘만
flip_dt가 있어 주 단위로 셉니다. 이력이 한 주가 안 차는 초기에는 반쪽 주라서, week_start에
is_partial_week 플래그를 둬 소비자가 온전한 주와 헷갈리지 않게 했습니다.

`metabase_bootstrap.py`에 대시보드 하나를 더 얹었습니다. 7편에서 쓴 그 멱등 패턴 그대로,
보고표 한 장과 백업 공백 목록, 플랜 회귀 목록을 카드로 만듭니다.

![Metabase 주간 운영 보고 대시보드 실화면. 위쪽 보고표는 인스턴스별로 용량 위험도(capacity_risk)·top 대기·플랜 변경 수·백업 경과일과 상태를 한 줄로 보여준다. 기종마다 top 대기가 다르다. MySQL은 binlog, PG는 WalSenderMain, MSSQL은 RESOURCE_SEMAPHORE_QUERY_COMPILE이다. 아래 왼쪽은 백업 공백 목록(rpo_status가 ok가 아닌 4개 인스턴스), 오른쪽은 플랜 회귀 목록인데 지금은 비어 있다](/uploads/project/lakehouse/lh16_weekly_dashboard.png)

top 대기 컬럼이 기종마다 다른 게 눈에 띕니다. MySQL(1번)은 `wait/io/file/sql/binlog`,
PG(4번)는 `WalSenderMain`, Oracle(8번)은 `resmgr:cpu quantum`, MSSQL(3·32번)은
`RESOURCE_SEMAPHORE_QUERY_COMPILE`입니다. 창고에는 기종 축이 없어도, 대기 마트가
누적/스냅샷 의미를 뭉개지 않고 실은 덕분에 한 화면에서 기종별 성격이 그대로 보입니다.

## 5. 라이브에서 드러난 것

dev 창고에 세 마트를 돌렸습니다.

백업 공백 마트는 7행이 나왔습니다. 인스턴스 1·2·7은 마지막 성공 백업이 하루 전이라 ok고,
3·4·8·32는 no_backup_observed입니다. 여기서 착수 명세에 미리 적어둔 함정을 확인했습니다.
원천(DBTower의 PG)의 backup_run 테이블을 직접 열어 보니, 7기종 전부 성공 백업 이력이
있었습니다. 그런데 창고의 `fct_backup_daily`에는 1·2·7의 07-16 하루치만 들어와 있었습니다.
보조 원천 오프로드가 최근에 신설된 터라 아직 그만큼만 실린 겁니다. 그러니 이 4건은 "백업이
안 돎"이 아니라 "창고가 아직 그 백업을 안 받음"이었고, 마트가 breach로 단정하지 않고
no_backup_observed로 사실만 실은 게 정확했습니다. 판정이 조심스러운 값이라 오히려 맞았습니다.

플랜 회귀 마트는 0행이었습니다. 창고의 플랜 이력이 07-16 하루뿐이라, 날짜 간 뒤집힘을
잡을 최소 조건(이틀)이 안 됩니다. 로직이 틀린 게 아니라 재료가 아직 하루입니다. CI
픽스처에는 교차일 뒤집힘을 심어 PENDING 한 행이 나오는 걸 확인해 뒀는데, 이게 초기
실데이터가 앞으로 보일 모습입니다. 하루가 이틀이 되는 내일이면 뒤집힘이 잡히기 시작합니다.

주간 보고 마트는 7행으로, 앞의 두 판정과 용량·대기를 한 줄씩 묶어 위 대시보드가 됐습니다.

## 6. 판정은 "무엇이 언제"까지였고, "왜"가 빠져 있었다

이걸로 "장기 창고라야 가능한 판정" 세 개가 갖춰졌습니다. 용량 D-day는 미래를 외삽하고,
플랜 회귀는 시점 전후를 상관시키고, 백업 공백은 부재를 감지합니다. 셋 다 라이브 7일
창으로는 구조적으로 못 하는 판정이라, 이 창고가 존재하는 이유를 그대로 보여줍니다. 그
사이에 미사용 인덱스 판정도 하나 더 붙었습니다(그건 뒤에서 기종 축과 함께 다시 나옵니다).

그런데 이 판정들을 보다가 한 가지가 걸렸습니다. 전부 **"무엇이 언제"까지만** 답합니다.
"이 쿼리가 느려졌다", "이 인스턴스 백업이 3주째 없다" 까지는 말하는데, **"왜 그렇게
됐나"의 첫 후보**는 아무도 안 짚어 줍니다.

DBA 장애의 흔한 숨은 원인 하나가 사람이 조용히 바꾼 파라미터입니다. `work_mem`을 줄였거나
`max_connections`를 건드렸는데, 그게 며칠 뒤 특정 쿼리의 플랜을 뒤집습니다. DBTower는
이 설정 변경을 1시간마다 감지해서 쌓습니다. 그런데 그 이력을 7일류로 지웁니다(자체 정리
잡이 돕니다). "3개월 전 언제부터 이 인스턴스 설정이 달라졌나"와 "그 변경 뒤로 성능이
나빠졌나"는 장기 이력이 있어야 답하는데, 그게 매일 사라지고 있었습니다. 그래서 이 판정
층에 "왜"의 첫 후보로 설정 드리프트를 붙이기로 했습니다.

## 7. 원천은 DBTower에 이미 있었다

이번엔 착수가 가벼웠습니다. 앞선 단계들(대기 이벤트, 인덱스 통계)은 DBTower 쪽에 테이블과
수집 잡을 새로 만들어야 했는데, 설정 드리프트는 **producer가 이미 완성**돼 있었습니다.
DBTower가 `config_snapshot`(매 수집 1행, 무변경도 해시로 증명)과 `config_param_change`
(바뀐 파라미터만 append)를 1시간 주기로 쌓고, 기존 파라미터 조회 기능을 5기종에서
재사용합니다. 그래서 이 단계는 lakehouse 단독 작업이었습니다. DBTower 쪽은 읽기 권한
한 줄만 주면 됩니다.

내릴 테이블을 고를 때 하나는 뺐습니다. `config_current_param`은 "현재 전량 거울"이라
값이 바뀔 때마다 덮어쓰고 지우는 변이 테이블입니다. 이 창고는 불변 append만 내린다는
계약을 지켜야 해서, 시간이 지나도 안 바뀌는 두 테이블만 오프로드 대상으로 삼았습니다.

## 8. 무변경도 기록한다

첫 마트 `fct_config_change_daily`에서 신경 쓴 건 **"조용한 날"과 "빈 날"의 구분**입니다.
설정이 안 바뀐 날은 정상입니다. 하지만 수집 자체가 안 돈 날은 문제입니다. 이 둘을 뭉개면
"변경 0"이 두 가지 다른 상태를 가립니다.

그래서 팩트의 스파인을 `config_snapshot`으로 잡았습니다. 이 테이블은 무변경 사이클에도
1행을 남기니까(해시로 "그 시각 설정은 이랬다"를 증명), 이 행이 있으면 "수집됐다"는 뜻입니다.
여기에 실제 변경 상세를 `config_param_change`에서 붙입니다. 결과적으로 한 인스턴스의 하루가
"23사이클 수집됐고 변경은 0" 인지 "수집 자체가 없음" 인지 구분됩니다. 백업 공백 마트에서
"기록 없음"을 행으로 드러냈던 그 정직함과 같은 결입니다.

## 9. 변경 타임라인, 그리고 DuckDB가 낸 내부 오류

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

## 10. 원인 후보로 겹친다

세 번째 마트가 이 설정 아크의 핵심입니다. `mart_config_impact`는 설정 변경 이벤트와 플랜
뒤집힘을 시간축으로 겹칩니다. 어떤 파라미터가 바뀐 뒤 N일(기본 7일) 안에, 그 인스턴스에서
플랜이 뒤집히거나 회귀(REGRESSED)가 관측됐나를 셉니다.

![설정 변경 영향 상관의 개념. 위 레인의 설정 변경(work_mem 4MB→1MB)에서 아래 레인의 플랜 뒤집힘·지연 증가로 이어지는 화살표. 변경 뒤 하루 안에 회귀가 뒤따르면 correlation=followed_by_regression으로 판정한다. 상관이지 인과가 아니라는 것을 판정 박스에 명시했다](/uploads/project/lakehouse/lh18_config_correlation.svg)

이건 **장기 설정 이력과 장기 성능 이력이 같은 창고에 있어야만 가능**한 판정입니다. DBTower의
7일 창은 설정 변경도 성능 이력도 7일치뿐이라 이 상관을 못 봅니다. 용량 D-day, 플랜 회귀,
백업 공백에 이은 "창고라야 가능한 판정"이고, 앞의 판정들에 "왜 그렇게 됐나"의 첫
후보를 붙이는 층입니다.

정직함을 두 군데 박았습니다. 첫째, **상관은 인과가 아닙니다.** "이 설정이 원인"이라고
단정하지 않고 `followed_by_regression` / `followed_by_plan_flip` / `no_flip_observed`
라는 관측 사실만 조언 어휘로 싣습니다. 최종 판단은 사람의 몫입니다. 미사용 인덱스 마트에서
"삭제 지시"가 아니라 "후보"라고만 했던 그 절제와 같습니다. 둘째, **"누가" 바꿨는지는
못 담습니다.** 파라미터를 누가 바꿨는지는 대상 DB가 주지 않는 정보라 DBTower도 저장하지
않고, 이 창고도 "언제 무엇이 어떻게" 까지만 압니다.

## 11. 라이브에서 나온 설정 드리프트

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

## 12. 남은 것

이걸로 창고의 판정이 다섯이 됐고, 그중 하나는 앞의 판정들에 "왜"의 첫 후보를 붙입니다.
설정 변경은 지금도 실물로 잡히고, 그 변경이 성능 회귀와 겹쳤는지는 이력이 쌓이며 켜집니다.

발화 경계는 이번에도 지켰습니다. 창고는 판정 컬럼과 타임라인, 상관까지만 계산하고, "이
설정 바뀐 뒤 회귀가 시작됐다" 같은 급변 알림은 DBTower의 reverse ETL이나 Metabase 구독이
쏩니다. 두 번째 알림 시스템을 만들지 않습니다.

한 가지 더 정직하게 적자면, 이 상관은 플랜 뒤집힘 하나만 본다는 한계가 있습니다. 볼륨
증가로 같은 플랜이 느려지는 회귀는 롤링 랭킹 마트의 몫이라 여기서는 안 겹칩니다. 원인의
축이 여럿이라는 뜻이고, 지금 겹친 건 그중 "설정 변경 → 플랜 변경" 한 갈래입니다. 나머지
축을 이 상관 층에 어떻게 더할지는 다음 편의 일로 남겨 둡니다.

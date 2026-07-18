---
title: '느려졌다는 신고에 30분씩 플랜 이력을 뒤지고 있었는데, 답할 재료는 창고에 이미 다 있었습니다'
titleEn: 'We Spent 30 Minutes Digging Through Plan History on Every Slowness Report, When the Warehouse Already Held the Answer'
description: '창고에 데이터를 내리기만 하고 판정을 안 하고 있었습니다. plan_snapshot(플랜이 언제 바뀌었나)과 fct_query_daily(그 쿼리가 느려졌나)를 둘 다 갖고 있으면서 서로 상관시키지 않아, "새벽에 갑자기 느려졌다"는 신고가 오면 DBA가 플랜 이력과 지연 그래프를 눈으로 대조하며 30분을 씁니다. fct_backup_daily에는 일별 성공/실패 집계가 있는데 "이 인스턴스, 마지막 성공 백업이 며칠 전인가"라는 판정 컬럼이 없어서, 백업이 조용히 안 돌던 걸 복구하려다 발견합니다. 실패는 시끄럽지만 공백은 조용합니다. 이 세 가지는 전부 사람의 시간이 새는 지점인데, 신규 수집은 하나도 필요 없었습니다. 이미 내린 데이터를 판정 컬럼까지 밀어붙이는 일이었습니다. 플랜 회귀는 일 단위 대표 플랜의 뒤집힘을 잡아 전후 N일 지연을 비교하고, 관측이 덜 찼으면 PENDING, 비교창 안에서 또 뒤집혔으면 AMBIGUOUS로 판정을 지어내지 않습니다. 백업 공백은 인스턴스 유니버스를 query 팩트에서 잡아 백업 기록이 아예 없는 인스턴스도 행으로 드러나게 하고, 기준일을 벽시계가 아니라 창고 최신 dt로 잡아 파이프라인 중단과 백업 중단을 섞지 않습니다. 라이브에서 7인스턴스 중 4개가 no_backup_observed로 나왔는데, 원천을 확인하니 백업이 안 도는 게 아니라 창고가 아직 그 백업을 안 받은 것이었고, 마트가 breach로 단정하지 않고 사실만 실어 정확했습니다. 마지막으로 용량 D-day, top 대기, 플랜 뒤집힘, 백업 공백을 인스턴스당 한 행으로 접는 주간 보고 마트를 만들어, 월요일마다 화면 네 곳을 긁던 보고서를 대시보드 한 장으로 바꿨습니다.'
descriptionEn: 'We were only landing data in the warehouse, never judging it. We held both plan_snapshot (when the plan changed) and fct_query_daily (whether the query slowed down) without correlating them, so a "suddenly slow last night" report meant a DBA eyeballing plan history against a latency graph for 30 minutes. fct_backup_daily had daily success/fail counts but no verdict column for "how many days since this instance last had a successful backup," so silent backup gaps got discovered during recovery. Failures are loud; gaps are silent. All three are places human time leaks, and none needed new collection: it was pushing already-landed data through to a verdict column. Plan regression detects day-level dominant-plan flips and compares latency across N days before and after, refusing to invent a verdict when observation is thin (PENDING) or another flip contaminates the window (AMBIGUOUS). Backup RPO draws its instance universe from the query fact so instances with no backup rows at all still surface, and anchors "as of" to the warehouse''s latest dt rather than the wall clock, so a stalled pipeline isn''t confused with a stalled backup. Live, 4 of 7 instances came back no_backup_observed; checking the source showed backups were running fine, the warehouse just hadn''t received them yet, and the mart was correct to state the fact rather than declare a breach. Finally a weekly report mart folds capacity D-day, top wait, plan flips, and backup gap into one row per instance, turning the Monday four-screen scavenger hunt into a single dashboard.'
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
이번 편에서 이 셋을 마트 세 개로 채웁니다. 발화는 여전히 안 합니다. 13편에서 정한
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

비율 판정에는 13편 CI에서 배운 걸 그대로 적용했습니다. 후/전 비율을 소수 둘째 자리로
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

정직하게 적자면, 판정의 "실데이터 완성"은 보조 오프로드 이력이 더 쌓여야 옵니다. 지금
마트는 정직하게 비거나(플랜) 창고가 받은 만큼만 판정합니다(백업). 그래서 로드맵의 "시간이
해제하는 체크리스트"에 두 줄을 더했습니다. 플랜 회귀 실판정은 플랜 오프로드 이력이 이틀이
되면 자동으로 시작되고, 백업 공백은 7기종이 다 누적되면 no_backup_observed가 진짜 미백업만
남기고 좁혀집니다. 각각 예상 해제일을 못박아 뒀습니다.

## 6. 남은 것

이걸로 "장기 창고라야 가능한 판정" 세 개가 갖춰졌습니다. 용량 D-day는 미래를 외삽하고,
플랜 회귀는 시점 전후를 상관시키고, 백업 공백은 부재를 감지합니다. 셋 다 라이브 7일
창으로는 구조적으로 못 하는 판정이라, 이 창고가 존재하는 이유를 그대로 보여주는 기능들입니다.

만든 것은 판정 컬럼까지입니다. 알림을 직접 쏘지 않는다는 원칙은 이번에도 지켰습니다.
REGRESSED와 breach는 계산해 두고, 그걸 사람에게 알리거나 액션으로 구동하는 건 Metabase
구독이나 DBTower의 몫입니다. 구독(이메일 발송)은 SMTP 설정이 있어야 해서, 셀프호스트
어플라이언스에 강제하지 않고 RUNBOOK에 설정 절차만 적어 두기로 했습니다. 실측 범위는
대시보드까지입니다.

다음은 미사용 인덱스입니다. "이 인덱스 지워도 되나"는 7일 관측으로는 절대 못 답하고
분기 내내 스캔 0회를 봐야 하는, 정확히 이 창고만 할 수 있는 판정입니다. 다만 그건
DBTower 쪽에서 인덱스 사용 통계를 주기적으로 수집하는 게 먼저라, 자리만 예약해 두고
이번 편은 여기서 닫습니다.

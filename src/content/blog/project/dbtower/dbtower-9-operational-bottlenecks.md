---
title: '사람 손이 붙어 있던 다섯 곳을 끊다: 설정 드리프트·변경 리뷰·인덱스 판정·인시던트 리포트·월간 점검'
titleEn: 'Cutting the Five Places Human Hands Were Still Stuck: Config Drift, Change Review, Index Verdict, Incident Report, Monthly Check'
description: '이기종 DBMS 운영 관리 플랫폼 DBTower 9편. 현업 DBA의 병목이 어디에 남는지를 렌즈로, 사람 손이 선형으로 붙던 다섯 지점을 기능으로 끊었습니다. (1) 설정 드리프트 이력: 파라미터 diff의 공간축("A와 B가 다른가")에 시간축("언제부터 무엇이 바뀌었나")을 붙였습니다. 거울 테이블과 변경 로그로 무변경 주기엔 스냅샷 한 줄만 쌓이게 했고, work_mem 4096→8192 실변경을 감지해 카드를 쐈습니다. 검증 중 MongoDB parameters()가 $clusterTime 같은 응답 gossip 필드를 흘려 매번 오탐이 나던 기존 버그도 잡았습니다. (2) 스키마 변경 리뷰 게이트: 배포 전 DDL을 규칙으로 판정(락 위험·DEFAULT 없는 NOT NULL·DROP·WHERE 없는 대량 변경)하고 실제 행수로 락 위험을 확정한 뒤 AI 1차 소견을 붙여 ADMIN 승인·자동 감사까지. 실행은 하지 않고 gh-ost 경로만 안내합니다. (3) 인덱스 사용 통계 주기 영속: "이 인덱스 지워도 되나"는 재시작 누적 카운터의 순간값으론 못 답합니다. 5기종 스캔 통계를 6시간 주기로 영속하고(Oracle은 미지원 정직), lakehouse가 first-vs-last 델타·리셋 클램프로 분기 창 판정 마트를 짓습니다. (4) 인시던트 리포트: 장애 구간을 주면 시점 비교·설정 변경·플랜 플립·대기·가용성을 한 장으로 재구성하고 AI가 재료 내 사실만으로 요약합니다. (5) 월간 점검 리포트: 헬스·백업·Advisor·용량·낭비·설정 변경을 매월 자동 발행합니다. 다섯 개 전부 읽고 판정·기록까지가 몫이고 대상 DB는 바꾸지 않습니다. 신규 모듈 하나(review)는 이벤트로 alert에 카드를 위임하고, 공개 파사드 둘(score·finops)로 Modulith 경계를 순환 없이 유지했습니다. 테스트 514건, VERIFICATION 110개 절.'
descriptionEn: 'Part 20 of DBTower. Using where a working DBA''s bottleneck remains as the lens, five places where human effort scaled linearly were cut into features. (1) Config drift history adds a time axis to parameter diff. (2) A schema-change review gate judges DDL by rules, confirms lock risk with real row counts, adds an AI first opinion, and routes to ADMIN approval with automatic audit, without executing. (3) Index usage snapshots persist scan stats across engines so the lakehouse can judge "safe to drop?" over a quarter with first-vs-last deltas. (4) An incident report reconstructs a window''s point comparison, config changes, plan flips, waits, and availability into one page with an AI summary bound to the assembled facts. (5) A monthly check report publishes health, backup, advisor, capacity, waste, and config changes automatically. All five read, judge, and record; none change the target DB. 514 tests, 110 verification sections.'
date: 2026-08-01
tags:
  - Java
  - Spring Boot
  - DBRE
  - Spring Modulith
  - dbt
category: personal/DBTower
coverImage: /uploads/project/dbtower/review-gate.png
draft: false
series: "DBTower"
seriesOrder: 9
---

## 0. 같은 렌즈로 다섯 곳을 봤다

플랫폼을 여기까지 만들고 물었습니다. 현업 DBA의 손은 아직 어디에 붙어 있나. 답은 다섯 곳이었습니다. 개발자가 파라미터를 바꾸면 DBA가 "누가 언제 바꿨어"를 뒤지고, 변경 배포 전에 리뷰를 기다리고, "이 인덱스 지워도 되나"를 며칠 관측으로는 답 못 하고, 장애가 끝나면 보고서를 손으로 쓰고, 매달 정기 점검 보고서를 또 손으로 만듭니다. 다섯 곳 모두 관리 대상이 늘수록 사람 손이 선형으로 붙는 구조, 이 시리즈가 처음부터 끝까지 겨눈 바로 그 구조입니다.

원칙 하나를 지켰습니다. 읽고 판정하고 기록하는 것은 깊게 하되, 대상 DB를 바꾸는 실행은 기존 경계(ADMIN·gh-ost·사람) 뒤에 둡니다. 관제탑이 대상 DB에 임의 DDL을 실행하는 순간 다른 제품이 되니까요.

## 1. 설정 드리프트: "언제부터 무엇이 바뀌었나"

파라미터 diff는 이미 있었습니다. 같은 역할의 두 장비 설정을 비교해 "왜 저쪽만 느리지"를 보는 공간축 기능이죠. 빠진 건 시간축이었습니다. 한 인스턴스의 설정이 어제와 오늘 다른지, 다르면 언제부터인지는 이력이 있어야 답합니다.

원천은 새로 만들 게 없었습니다. 5기종 `parameters()`를 주기로 읽어 직전 상태와 비교하면 됩니다. 문제는 폭증이었습니다. PostgreSQL만 파라미터가 수백 개인데 매 시간 통째로 저장하면 이력 테이블이 순식간에 붑니다. 그래서 거울 테이블 하나에 현재 전량을 들고, 바뀐 항목만 변경 로그에 append하고, 매 수집엔 해시 한 줄만 남깁니다. 무변경 주기엔 그 한 줄만 쌓이죠. 첫 수집은 변경이 아니라 기준선으로 기록해, 기동하자마자 수백 개가 "변경됐다"고 카드를 쏘는 사고를 막았습니다.

정직하게 못 하는 것도 있습니다. "누가" 바꿨는지는 대상 DB가 알려주지 않아, 그 칸을 지어내지 않고 대상 DB의 감사 로그에서 확인하라고 안내합니다. 대신 좋은 연결이 생겼습니다. 플랜 플립이 감지된 시각 ±24시간 안에 설정 변경이 있었는지를 대조해, "설정 변경이 플랜을 갈아탄 원인 후보"라는 진단 서사를 잇습니다.

![설정 변경 이력. work_mem이 언제 바뀌었는지 시간순으로, "누가"는 대상 DB 감사 로그의 몫이라 미표기](/uploads/project/dbtower/config-drift.png)

라이브로 대상 PostgreSQL의 `work_mem`을 4MB에서 8MB로 바꾸고 다음 수집을 기다리니, 같은 서버를 쓰는 인스턴스 둘에 각각 `4096 → 8192` 변경이 잡혔습니다. 덤으로 버그도 드러났습니다. MongoDB가 매번 드리프트로 잡히길래 봤더니, `parameters()`가 `getParameter` 응답의 봉투 필드(`$clusterTime`, `operationTime` 같은 gossip 값)까지 파라미터로 흘리고 있었습니다. 호출마다 변하는 값이라 오탐이 날 수밖에 없었고, 공간축 파라미터 diff도 오염시키던 기존 버그였죠. 오퍼레이터에서 봉투 필드를 걸러 622개에서 620개로 줄이니 오탐이 사라졌습니다. 변경이 감지되면 웹훅으로 카드가 나갑니다.

![설정 변경 감지 Discord 카드. work_mem 변경과 "누가는 대상 DB 감사 로그의 몫" 안내](/uploads/project/dbtower/card-config-drift.png)

## 2. 변경 리뷰 게이트: 판정·승인·기록까지, 실행은 안 함

DBA 병목의 대표가 변경 요청 리뷰 대기, 사내 DB 플랫폼이 공통으로 가진 기능입니다. 예전에 이 프로젝트는 SQL 변경 심의를 "범위 밖"으로 미뤄뒀습니다. gh-ost류 실행이 MySQL 전용이라 이기종 정체성과 안 맞고, 쓰기 거버넌스가 읽기·진단과 다른 결이라는 이유였죠. 이번엔 범위를 판정·승인·기록까지로 좁혀 부분 재결정했습니다. 실행을 안 하니 gh-ost 문제는 사라지고, 판정은 규칙 엔진 그 자체라 읽기·진단 DNA와 충돌하지 않습니다.

개발자가 변경 SQL을 제출하면 규칙이 위험을 자동 지적합니다. WHERE 없는 UPDATE와 DELETE, DROP TABLE과 DROP COLUMN, DEFAULT 없는 NOT NULL 컬럼 추가, 대테이블 ALTER의 락 위험. 락 위험은 참조 테이블의 실제 행수를 테이블 상세로 조회해 확정합니다. 그 위에 AI가 1차 소견을 답니다. 규칙이 이미 짚은 걸 반복하지 말고 배포 순서나 롤백 계획 같은 보완 관점만 더하라고 프롬프트에 박아뒀습니다. 승인과 반려는 ADMIN이 하고, 그 전이는 감사 인터셉터가 자동 기록합니다.

![변경 리뷰 게이트. ALTER TABLE users에 락 위험·NOT NULL·실제 행수(8,118행)를 지적하고 AI가 배포 순서·롤백까지 소견, ADMIN 승인/반려 버튼](/uploads/project/dbtower/review-gate.png)

라이브로 MySQL `users` 테이블에 `ADD COLUMN nickname VARCHAR(32) NOT NULL`을 제출하니 세 가지가 잡혔습니다. 락 위험, DEFAULT 없는 NOT NULL, 그리고 실제 행수 8,118행으로 확정한 락 시간 판정. AI 소견은 규칙이 짚은 락과 NOT NULL을 반복하지 않고, 트래픽 낮은 시간대 배포와 nickname을 채우는 코드의 배포 순서, 롤백 시 컬럼 DROP의 락까지 짚었습니다. 승인하니 APPROVED로 전이되고 감사 로그에 제출과 승인 두 건이 남았습니다. 승인된 MySQL DDL이라 gh-ost 화면 안내가 붙지만, 플랫폼이 직접 실행하진 않습니다. 제출과 결정 시점에 각각 카드가 나갑니다.

![변경 리뷰 요청 Discord 카드. 규칙 지적 세 줄과 AI 1차 소견](/uploads/project/dbtower/card-review-request.png)

![변경 리뷰 승인 Discord 카드. 결정자·코멘트·gh-ost 안내, 실행은 사람](/uploads/project/dbtower/card-review-decision.png)

모듈 경계에서 판단을 하나 했습니다. 카드 발송은 alert 모듈 책임인데, 새 review 모듈이 alert 내부를 직접 참조하면 순환이 생깁니다. 그래서 review가 이벤트를 발행하고 alert의 리스너가 카드를 만들어 보냅니다. 구조적 의존은 이미 있던 한 방향뿐이라 순환이 없습니다.

처음엔 SQL 판정을 정규식으로 짰습니다. 문제는 알고 있었죠. 정규식은 문장을 세미콜론으로 가르는데, 문자열 리터럴이나 PostgreSQL 달러 인용 안의 세미콜론을 문장 경계로 오인합니다. 그래서 다중 문장은 `parseLimited`로 "이건 근사치"라고 정직하게 표기했습니다. 이번에 판정을 JSqlParser 구문 트리로 올렸습니다. 정상 다중 문장은 이제 정확히 갈라져 `parseLimited`가 꺼지고, 파서가 못 다루는 방언(종료 안 된 리터럴 등)만 정규식 폴백으로 내려가 한계를 표기합니다. 구문 트리가 생기니 부수 효과로 판정 하나가 더 가능해졌습니다. ADD/DROP 컬럼을 구조로 뽑아 실제 스키마와 대조하는 겁니다. "이미 있는 컬럼을 또 추가"하거나 "없는 컬럼을 삭제"하는, 배포 시 에러가 날 변경을 미리 짚죠. 다만 스냅샷에 그 테이블이 없거나 스키마리스(MongoDB)면 존재 여부를 단정하지 않고 판정을 보류합니다. 확신 없는 지적은 규칙 엔진의 신뢰를 깎으니까요.

리포트 쪽은 검증을 한 겹 더 얹었습니다. 인시던트·월간 리포트 조립기는 목 기반 유닛만 있었는데, 스프링 컨텍스트 통합 테스트를 더해 컨트롤러부터 보안(ADMIN)·조립기·마크다운·직렬화까지 엔드포인트 계약을 관통 검증합니다. 스냅샷 테이블은 JPA 엔티티가 없어 인메모리 H2엔 없으므로, 그 조회 원천만 목으로 빈 신호를 넣고 나머지는 실빈으로 태웠습니다. 스냅샷 조회는 목 유닛으로 검증한다는 저장소 방침을 그대로 이었습니다.

## 3. 인덱스 판정: "지워도 되나"는 분기가 답한다

"이 인덱스 안 쓰이니 지워도 되나"는 7일 관측으로는 절대 못 답합니다. 스캔 카운터는 통계 리셋(재기동) 이후 누적이라, "지난주 재기동 이후 0회"와 "분기 내내 0회"가 구분되지 않습니다. 지난주 재기동한 서버의 0회를 미사용으로 오판하면 실사용 인덱스를 지우는 사고가 나죠. 이건 정확히 lakehouse(장기 분석계)만 할 수 있는 판정입니다.

DBTower는 원료를 공급합니다. 5기종 인덱스 스캔 통계를 6시간 주기로 영속하죠. PostgreSQL은 `pg_stat_user_indexes`, SQL Server는 `dm_db_index_usage_stats`, MySQL은 `table_io_waits_summary_by_index_usage`, MongoDB는 `$indexStats`입니다. Oracle은 인덱스 사용 추적이 대상 설정 변경(침습)이거나 라이선스 문제라, 지원하는 척 빈 값을 내지 않고 미지원으로 정직하게 표기합니다. FinOps의 미사용 인덱스 신호에도 관측 기간 라벨을 붙였습니다. "미사용(관측 3일)"과 "미사용(관측 90일)"은 완전히 다른 말이니까요.

![FinOps 미사용 인덱스 신호. 스캔 0회에 크기와 "관측 N일" 라벨, "분기 단위 장기 판정(lakehouse)과 함께 보라"는 권고](/uploads/project/dbtower/index-observation.png)

lakehouse가 그 원료를 받아 판정 마트를 지었습니다. 누적 카운터를 일간 실사용으로 접는 건 1편에서 쿼리 통계에 쓴 first-vs-last 델타와 리셋 클램프를 그대로 재사용합니다. 창은 기본 90일, 판정은 네 갈래입니다. 사용 중이면 사용 중, 유니크나 PK를 뒷받침하면 미사용이라도 제약 유지에 필요하니 제외, 관측 기간이 하한 미만이면 판정 보류, 남는 것만(비유니크·충분 관측·사용 0) 삭제 후보입니다. FK 뒷받침과 레플리카 전용 사용은 이 통계로 알 수 없어, 판정문에 그 한계를 적고 사람이 확인 후 실행하라고 남깁니다. dbt 빌드는 유닛 테스트 세 개(델타, 리셋 클램프, 판정 네 갈래)를 포함해 전부 통과했습니다.

## 4. 인시던트 리포트: 장애 구간을 신호로 재구성

장애가 끝나면 보고서를 손으로 씁니다. 여러 화면을 오가며 그 시간에 무슨 일이 있었는지 긁어모으는 일이죠. 이걸 원클릭으로 만들었습니다. 신규 수집 없이 이미 저장된 신호를 시간창으로 조합합니다. 시점 비교로 무엇이 느려졌나, 설정 변경으로 그때 뭘 바꿨나, 플랜 플립으로 계획이 갈아탔나, 대기 이벤트로 무엇을 기다렸나, 헬스 추이로 언제 나빠졌나를 한 장으로 엮습니다.

![인시던트 리포트. 성능 비교 표·설정 변경·플랜 플립·대기·가용성에 AI 요약을 얹은 한 장](/uploads/project/dbtower/incident-report.png)

AI 요약은 조립된 재료에 있는 사실만 쓰라고 프롬프트에 박았습니다. 라이브로 자기 자신(dbtower-self)의 2시간 구간을 뽑으니 AI가 이렇게 요약했습니다. 평균 지연 상승이 읽은 행수 상승과 거의 나란히 움직이니 플랜 악화보다 워크로드 증가가 원인일 가능성이 크다, work_mem 변경은 4분 만에 되돌린 net-zero라 2시간 악화를 설명하기 어렵다, 플랜 플립이 0건이라 설정 변경에서 플랜 전환으로 이어지는 경로의 근거가 재료에 없다, 그래서 근본 원인을 확정하기엔 근거가 부족하다. 지어내지 않고 모른다고 말하는 것, 그게 1차 분석기의 원칙입니다. 요약 카드는 웹훅으로 나가고 전문은 콘솔에서 봅니다.

![인시던트 리포트 Discord 카드. 구간 성능 악화에 AI 요약(워크로드 증가 가능성·근거 부족 정직 판정)](/uploads/project/dbtower/card-incident.png)

정직하게 밝힌 한계가 하나 있습니다. 감지 알림(회귀·이상·운영)은 영속 이력 없이 웹훅으로만 나가, 이 타임라인엔 못 넣고 "영속된 신호로 재구성한 사건"임을 리포트에 명시합니다. 구간이 24시간을 넘으면 자르고 그 사실을 노트로 남깁니다.

## 5. 월간 점검 리포트: 기간 전체의 건강을 한 장으로

인시던트 리포트가 "장애 구간의 사건"이라면, 이쪽은 "기간 전체의 건강"입니다. DBA가 매달 손으로 만드는 정기 점검 보고서를 자동 발행하죠. 헬스 스코어, 백업 신선도와 복원 검증, Advisor 스윕 지적과 용량 예측, 낭비 신호, 설정 변경 건수를 한 장에 모읍니다. 매월 1일에 전 인스턴스 리포트를 만들어 나쁜 순으로 정렬한 롤업 카드 한 장을 보냅니다. 인스턴스마다 카드를 쏘면 폭주라 한 장으로 묶습니다.

![월간 점검 리포트. 헬스 72점(C)·백업 FRESH·Advisor 중복 인덱스 경고·낭비 9건·설정 변경 2건](/uploads/project/dbtower/monthly-report.png)

여기서도 모듈 경계 문제가 있었습니다. 헬스 스코어는 score, 낭비 신호는 finops 모듈 내부에 있어 alert의 리포트가 직접 못 읽습니다. 그래서 두 모듈에 최소 공개 파사드(인터페이스 하나와 요약 레코드 하나씩)를 두고, 리포트가 그 인터페이스로만 읽게 했습니다. Modulith 경계 테스트가 순환 없음을 계속 지켜줍니다.

## 6. 다섯 개를 관통하는 한 줄

다섯 개 전부 같은 자리에 섰습니다. 읽고 판정하고 기록하는 것은 깊게, 대상 DB를 바꾸는 실행은 사람이나 기존 경계 뒤로. 설정 변경은 이력만 남기고, 리뷰는 승인까지만 하고 실행은 gh-ost나 사람에게, 인덱스는 삭제 후보까지만 내고, 리포트는 재구성만 합니다. 관제 도구가 대상을 바꾸기 시작하면 소유자와 판단이 갈릴 때 사고가 나니까요.

기능을 늘리면서도 경계는 안 무너뜨렸습니다. 신규 모듈 하나는 이벤트로 카드를 위임하고, 두 모듈은 공개 파사드로만 열렸습니다. 새 신호를 저장하는 잡들은 기존 스냅샷 잡과 같은 뼈대를 따랐습니다. 테스트는 514건, 재현 기록은 110개 절입니다. 검증하다 발견한 버그(MongoDB 봉투 필드 누출, 리뷰 조회의 팀 스코프 누락) 두 개는 그 자리에서 고쳐 함께 기록에 남겼습니다.

## 7. 웹 콘솔 개편 — 레퍼런스 화면 대조

기능을 다 붙인 뒤 콘솔을 실무에서 쓸 만하게 다듬었습니다. 카드 그리드로 나열되던 인스턴스를 좌측 검색 사이드바로 옮기고, 수백~수천 대를 상정해 전부 렌더하지 않고 검색·필터가 있을 때만 매칭분을 그립니다(선택한 DB만 상세를 펼치고, 5기종은 공식 브랜드 로고로 구분). Monitoring 탭에 스무 개 넘게 쌓이던 카드는 성능·진단·거버넌스·백업·비용 다섯 카테고리로 묶었습니다. 쿼리 상세에선 SQL을 문법대로 줄바꿈하고 색을 입혔고, 실행계획은 MySQL이면 레퍼런스식 표(id·type·key·rows·Extra)로, 그 외 기종은 색을 입힌 JSON 트리로 보여줍니다. 차트는 커서를 올리면 정확 수치를 띄우고 CPU는 0~100% 고정축으로 읽기 쉽게 했습니다.

전부 라이브러리·빌드체인 없이 했습니다. SQL·JSON 색상 강조는 경량 토크나이저를 직접 썼고, 브랜드 로고는 SVG 스프라이트로 한 번만 정의해 참조했습니다. "java -jar 하나로 콘솔까지"라는 셀프호스트 원칙을 지키는 것이 이 프로젝트에선 의존성 하나 늘리는 것보다 값어치가 큽니다.

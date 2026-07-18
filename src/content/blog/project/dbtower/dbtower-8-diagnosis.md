---
title: '스스로 보는 관제탑: 자율 진단 8종, 그리고 "인덱스가 있는데 왜 안 타요?"까지'
titleEn: 'A Tower That Watches by Itself — Eight Autonomous Diagnostics, Down to "The Index Is There, Why Is It Not Used?"'
description: '이기종 DBMS 운영 관리 플랫폼 DBTower 8편. 대시보드는 사람이 봐야만 가치가 있고, 안 보는 새벽의 조용한 저하는 아무도 못 잡습니다. 그래서 플랫폼이 스스로 보게 만들었습니다. 고정 임계 없이 (요일x시간대) 베이스라인 z-score로 "평소와 다름"을 잡는 이상 감지(z=378 실측), 운영 문서의 규칙을 코드로 옮긴 Advisors, AI에게 read-only 도구 화이트리스트를 쥐여준 자연어 진단, 같은 p95인데 기종마다 NATIVE/COMPUTED/ESTIMATED/UNSUPPORTED로 라벨을 가른 레이턴시 백분위와 SLO/에러 버짓, 흩어진 신호를 0~100점으로 모으는 헬스 스코어까지가 전반부입니다. 후반부는 그렇게 지목된 쿼리에 "왜"를 답하는 마지막 층입니다. EXPLAIN은 옵티마이저의 추정이라 옵티마이저가 속은 이유는 추정 vs 실제 행수의 괴리로만 보입니다. 실제 실행 계획을 얻는 방법이 다섯 기종 전부 다르다는 것, actual rows가 루프당 평균이라 loops를 곱해야 하는 함정, 숫자 리터럴 하나로 인덱스가 무력화되는 암시적 형변환을 code=12345 실측으로 지목하고 원클릭 재진단으로 before/after까지 비교한 기록, 그리고 "실제 실행"이라는 위험을 ADMIN 경계와 타임아웃으로 다루는 안전 설계를 담았습니다.'
descriptionEn: 'Part 8 of DBTower. A dashboard is only worth what a human looks at, so the platform learned to watch by itself: anomaly detection with (day-of-week x hour) baseline z-scores instead of fixed thresholds (z=378 measured), Advisors that turn runbook rules into code, natural-language diagnosis where an AI chains read-only whitelisted tools, latency percentiles honestly labeled NATIVE/COMPUTED/ESTIMATED/UNSUPPORTED per engine with SLO/error budgets, and a unified health score. The second half answers the question that follows: why is the flagged query slow? EXPLAIN shows the optimizer''s estimate, so you need the gap between estimated and actual rows — obtained five different ways across five engines. Includes the loops-multiplication pitfall, a measured case where one numeric literal disabled an index via implicit type conversion (code=12345) with one-click re-diagnosis comparing before/after, and the safety design (ADMIN boundary, timeouts) for the risk that is actually executing queries.'
date: 2026-07-05
tags:
  - Java
  - Spring Boot
  - DBRE
  - SRE
  - Query Optimization
  - Observability
category: personal/DBTower
coverImage: /uploads/project/dbtower/cover.svg
draft: false
series: "DBTower"
seriesOrder: 8
---

## 0. 들어가며, 대시보드는 사람이 봐야만 가치가 있다

[7편](/blog/project/dbtower/dbtower-7-provisioning)까지 만든 DBTower는 좋은 대시보드였습니다. 시점 비교, Wait Event, 실행계획 분석은 전부 **사람이 화면을 열어야** 가치가 나옵니다. 그럼 사람이 안 보는 시간의 조용한 저하는 누가 잡습니까?

방향은 실존 제품들을 근거로 잡았습니다. AWS는 DevOps Guru for RDS로 이상을 자동 감지하고, Percona PMM은 Advisors로 운영 규칙을 점검하고, pganalyze는 AI 보조 진단을 붙였습니다. 업계는 이미 "사람이 모는 대시보드"에서 "스스로 보는 관제탑"으로 이동했습니다. Phase D는 그 이동을 따라가되 시리즈 내내 지킨 가드레일은 유지합니다. **전부 읽고 판단만 한다. 대상 DB를 바꾸는 자동 실행은 없다.** 그 선을 넘으면(자동 인덱스 생성 같은) 다른 제품이 되기 때문입니다.

이 편은 2부 구성입니다. 전반부는 "어디가 이상한가"를 스스로 잡는 자율 진단 8종, 후반부는 그렇게 지목된 쿼리에 "그래서 **왜** 느린가"를 답하는 심층 원인 진단입니다.

## 1. 고정 임계의 한계를 넘어선 이상 자동 감지, 그리고 z=378

기존 회귀 감지(2편)에는 "QPS +200%면 알림" 같은 고정 임계가 있었습니다. 문제는 이 숫자가 **모든 쿼리에 같은 기준**이라는 겁니다. 평소 QPS 0.2인 쿼리가 25가 되면 125배인데, 평소 100인 쿼리 기준의 +200%로는 놓칠 수도, 반대로 트래픽 패턴상 정상인 아침 피크를 오탐할 수도 있습니다.

그래서 스냅샷 이력으로 인스턴스·쿼리별 **(요일 x 시간대) 베이스라인**(평균과 표준편차)을 학습하고, 현재 값이 평소에서 몇 표준편차 벗어났는지(z-score)로 판정합니다. "화요일 오후 3시의 이 쿼리는 평소 어땠나"가 기준입니다.

```
부하 실측: COUNT digest qps 25.0
  베이스라인(같은 요일·시간대): 0.17 ± 0.07
  -> z = 378, 고정 임계 없이 감지
폴러 end-to-end 발화: qps 55.0, 평소 5.17 ± 12.22 -> z = 4.1
```

설계에서 신경 쓴 두 가지. **하나, 고정 임계를 없애지 않고 공존시켰습니다.** 베이스라인은 학습 데이터가 필요한데 갓 등록된 인스턴스에는 없기 때문입니다. **둘, 데이터 부족은 "학습 중"으로 보류합니다.** 관측이 부족한 버킷에서 판정을 내리면 신규 인스턴스마다 오탐이 쏟아집니다. 응답에 `learningCount`를 실어 "아직 판단 안 한다"를 명시합니다. 모르는 것을 모른다고 말하는 것도 감지기의 정직성입니다.

![현재 이상 없음과 함께 학습 중 12건은 관측 8회 미만이라 판정을 보류한 이상 감지 화면](/uploads/project/dbtower/anomaly.png)

## 2. 운영 문서를 코드로 옮긴 Advisors, 인터페이스 변경 0

시리즈를 쓰며 쌓인 운영 문서가 있습니다. digest 테이블이 차면 새 쿼리가 통계에서 사라진다(operations.md), 기종별 최소 권한 목록(least-privilege.md) 같은 것들입니다. 문서의 문제는 **사람이 기억해야 작동한다**는 겁니다. 이 규칙들을 Advisor 6종 코드로 옮겨 일일 스윕(HA 분산 락)으로 자동 점검합니다.

재밌는 건 구현 비용입니다. **operator 인터페이스 변경이 0이었습니다.** 기존 `parameters()`, `describeSchema()`, `tableStats()`, `queryStats()`를 재사용해 판정만 얹어서, "새 능력 = 메서드 1개"조차 필요 없던 케이스입니다. 실측(MySQL)에서 "digest 테이블 포화 위험"과 "위험 파라미터값"이 VIOLATIONS로, 중복 인덱스는 OK로, 기종에 무관한 점검은 UNSUPPORTED로 나뉘어 나옵니다.

![digest 포화 위험을 권고와 함께 지적하고 무관한 점검은 미지원으로 정직하게 표기한 Advisors](/uploads/project/dbtower/advisors.png)

## 3. AI에게 읽기 전용 도구만 쥐여준 자연어 진단

3편에서 만든 AI 분석은 단발이었습니다. 사람이 쿼리를 고르고 EXPLAIN 결과를 넘기면 판정하는 구조. 이번엔 **도구 사용 루프**로 승격했습니다. "이 DB 왜 느려?"라고 물으면 AI가 어떤 MCP 도구를 부를지 스스로 정하고, 서버가 실행해 결과를 돌려주고, 그걸 보고 다음 도구를 정하는 반복입니다(최대 5스텝).

여기서 안전장치가 두 겹입니다. MCP 도구 중 **read-only 12종 화이트리스트**만 노출해, kill·backup·online-ddl 같은 쓰기 도구는 루프에 아예 존재하지 않습니다. AI가 아무리 연쇄해도 대상 DB 변경이 0인 게 구조적으로 보장됩니다.

```
질문: "이 DB 왜 느려?"  (LIKE 풀스캔 부하 상태)
AI 연쇄: query_stats -> explain
결론: access_type=ALL, 앞 와일드카드 LIKE는 B+Tree 시작점을
      못 잡는다(판단 기준 문서 인용), confidence=high

질문: "작년 크리스마스 접속자 수는?"  (데이터 없음)
결론: 수치를 지어내지 않고 confidence=low
```

두 번째 실측이 중요합니다. 근거 없는 질문에 그럴듯한 숫자를 만들어내지 않는 것. AI를 1차 분석기에 묶어두고 최종 판단은 맡기지 않는 원칙(3편)이 루프에서도 유지되는지 확인한 셈입니다.

## 4. p95의 다섯 얼굴, 그리고 SLO와 에러 버짓

SLO를 만들려면 레이턴시 백분위(p95/p99)가 필요한데, 여기서 이기종의 현실을 또 만났습니다. **같은 "p95"인데 기종마다 낼 수 있는 수준이 다릅니다.**

| 기종 | 방식 | 라벨 |
|---|---|---|
| MySQL | events_statements_summary_by_digest의 QUANTILE_95/99 컬럼 | NATIVE (실측 p95=19.95ms) |
| MongoDB | system.profile 원샘플을 직접 계산 | COMPUTED |
| PostgreSQL | 평균 + 1.645 x 표준편차 (정규분포 가정) | ESTIMATED |
| SQL Server / Oracle | 통계 뷰에 분위수도 표준편차도 없음 | UNSUPPORTED |

![같은 p95인데 소스 라벨(실측·직접계산·추정·미지원)이 다른 레이턴시 백분위](/uploads/project/dbtower/latency.png)

핵심은 **네 라벨을 절대 섞지 않는 것**입니다. ESTIMATED를 NATIVE인 척 보여주면 사용자는 추정치를 실측으로 믿고 결정을 내립니다. 백업 검증의 3값(5편), Terraform validate(7편)와 같은 계열의 정직성입니다.

이 위에 Google SRE의 SLO 모델을 얹었습니다. 원칙은 "인프라 지표(CPU)가 아니라 사용자 경험 지표"입니다. 레이턴시 SLI는 방금의 p95를 재사용하고, UNSUPPORTED 기종은 평균 레이턴시로 폴백하되 `source=AVG_FALLBACK`으로 표기합니다. 가용성 SLI는 헬스 샘플 이력의 up 비율이고, 에러 버짓(허용 다운타임 대비 소진율)과 번 레이트로 EXHAUSTED/WARNING/OK를 판정합니다. 실측에서 MySQL이 NATIVE 기반 BREACHING, Oracle이 AVG_FALLBACK, 가용성은 MEETING으로 나왔습니다.

![레이턴시 SLI 위반과 가용성 충족, 에러 버짓 소진율과 번인 레이트를 보여주는 SLO와 에러 버짓](/uploads/project/dbtower/slo.png)

## 5. 파티션·FinOps·백업 신선도로 신호를 채우다

나머지 세 축은 간결하게 짚습니다.

**파티션 조회(D5)**: `partitions()` 메서드 하나로 4기종(MySQL information_schema, PG relpartbound, Oracle user_tab_partitions, MSSQL sys.partitions), MongoDB는 관계형 파티셔닝 개념이 없어 UNSUPPORTED. 직접 파티션 테이블을 만들어 실조회로 검증했습니다. 조회 전용이고, 생성·자동 관리는 범위 밖입니다.

**FinOps 신호(D6)**: 미사용 인덱스를 실제 사용 카운터(PG idx_scan, MySQL COUNT_STAR 등)로 잡되, **절감액 달러는 계산하지 않습니다.** 스토리지 단가는 환경마다 달라 금액을 찍는 순간 지어낸 숫자가 되기 때문입니다. 신호까지만 내고 판단은 사람에게 넘깁니다. 유니크/PK 인덱스는 미사용이어도 제외했습니다. 제약 조건 역할이라 지우면 안 되기 때문입니다.

**백업 신선도(D7)**: 마지막 성공 백업 경과로 FRESH/STALE/NO_BACKUP을 나눕니다. 설계 포인트는 **메타 DB만 읽고 판정**한다는 겁니다. 대상 DB가 죽었을 때야말로 백업 신선도가 가장 중요한데, 그때 대상에 접속해야 알 수 있다면 앞뒤가 바뀐 것입니다. 실측에서 6개 인스턴스가 FRESH 1·STALE 2·NO_BACKUP 3으로 분류됐습니다.

## 6. 흩어진 신호를 아침 첫 화면으로 모으는 헬스 스코어

전반부의 마지막 조각이 D8입니다. D1~D7이 만든 신호는 흩어져 있습니다. 이상 감지 따로, Advisors 따로, SLO 따로. 운영자가 아침에 열 화면은 모든 걸 나열하기보다 **어디부터 봐야 하는지 알려주는 화면**입니다.

health·이상 감지·Advisors·SLO·백업 신선도를 인스턴스별 0~100점 + 등급으로 합산하고, 감점 사유를 분해해 나쁜 순으로 정렬했습니다. 설계 판단 세 가지:

- 신호가 없는 신규 인스턴스는 0점이 아니라 INSUFFICIENT_DATA로 둬서 **"데이터 부족"과 "나쁨"을 구분**합니다.
- 접속 자체가 안 되면 다른 신호가 무의미하니, **health 프로브 예외는 down으로 수렴**시켜 치명으로 처리했습니다.
- 신호 하나의 수집 실패가 스코어 전체를 죽이지 않도록 **신호를 격리(partial)**했습니다.

```
실측(실 8080): local-mysql / local-mssql -> F 52점, 나머지 B ~ 88점, 나쁜 순 정렬
canary 인스턴스 kill -> F 35점으로 최상단 부상
```

canary를 죽이자마자 최상단에 떠오르는 걸 보고 이 화면의 역할이 분명해졌습니다. 대시보드보다 **분류(triage) 큐**에 가깝습니다.

![감점 사유 분해와 나쁜 순 정렬로 아침에 여는 첫 화면이 되는 통합 헬스 스코어](/uploads/project/dbtower/health-score.png)

여기까지가 "어느 인스턴스의 어느 쿼리가 문제"까지 지목하는 전반부입니다. 그런데 다음 질문이 남습니다. 현업에서 제일 흔한 형태가 이것입니다. **"인덱스가 있는데 왜 안 타요?"**

기존 explain 기능(1편)은 이 질문에 절반만 답합니다. EXPLAIN은 옵티마이저의 **추정**이기 때문입니다. "풀스캔을 택했다"까지는 보여주지만 **왜 그런 선택을 했는지**, 옵티마이저가 무엇에 속았는지는 추정 계획만으로 알 수 없습니다. 그걸 알려면 예상 행수(추정)와 실제 읽은 행수(실측)의 **괴리**를 봐야 합니다. 추정 5행인데 실제 348행이었다면 옵티마이저는 거기서 속은 것입니다. 후반부는 그 마지막 층입니다. 명세는 기종별 공식 문서를 웹서칭으로 검증해 판단 기준 문서(ai-analysis-rules.md)에 "심층 원인 규칙" 절부터 만들었습니다. AI 분석과 코드가 같은 기준을 공유해야 하기 때문입니다.

## 7. "실제 실행 계획"이 다섯 가지로 갈라진다

이 시리즈의 익숙한 패턴이 또 반복됩니다. 같은 "실제 실행 계획"인데 얻는 방법이 기종마다 전부 다릅니다.

| 기종 | 방법 | 특이점 |
|---|---|---|
| MySQL | EXPLAIN ANALYZE (TREE) | 8.4가 FORMAT=JSON을 거부해서 아래 참고 |
| PostgreSQL | EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) | 버퍼 읽기까지 JSON으로 |
| Oracle | /*+ gather_plan_statistics */ 힌트 + DBMS_XPLAN.DISPLAY_CURSOR('ALLSTATS LAST') | 실행과 조회가 **같은 커넥션**이어야 함 |
| SQL Server | SET STATISTICS XML ON | 계획이 **별도 결과셋**으로 오므로 getMoreResults()로 수거 |
| MongoDB | explain의 executionStats verbosity | totalDocsExamined vs nReturned |

구현 디테일 두 개만 봅니다. Oracle은 `DISPLAY_CURSOR`가 "방금 이 세션이 실행한 커서"를 찾는 구조라 풀에서 커넥션을 두 번 빌리면 안 됩니다. `ConnectionCallback`으로 실행과 조회를 한 커넥션에 묶었습니다(6편에서 explain에 쓴 것과 같은 패턴). SQL Server는 `SET STATISTICS XML ON`을 켜면 쿼리 결과 **다음에** 계획 XML이 별도 결과셋으로 따라와서, `getMoreResults()`로 넘겨가며 수거해야 합니다.

그리고 MySQL에서 문서가 실측에 진 이야기. 명세 단계에서는 웹 자료를 근거로 `EXPLAIN ANALYZE FORMAT=JSON`으로 적어뒀는데, 구현하며 실제 MySQL 8.4에 던지자 **ERROR 1235로 거부**됐습니다. 구현은 기본 출력인 TREE 파싱으로 갔고, **판단 기준 문서를 실측 결과대로 고쳤습니다.** 명세대로 코드를 끼워맞추는 대신 실측이 명세를 고쳤습니다. 시리즈 내내 지켜온 순서입니다.

## 8. loops를 곱하지 않으면 빠지는 괴리 계산의 함정

괴리를 계산할 때 밟기 쉬운 함정이 있습니다. MySQL과 PostgreSQL의 actual rows는 **루프당 평균**입니다. 중첩 루프 조인의 안쪽 노드가 `rows=3, loops=100`이면 실제로 읽은 건 300행입니다. 3행이 loops만큼 돈 값이니까요. loops를 곱하지 않으면 "추정 3, 실제 3, 괴리 없음"이라는 엉뚱한 결론이 나옵니다.

괴리 판정은 이렇게 했습니다:

- MySQL/PG: 실제 총량 = actual rows x loops로 환산 후 추정과 비교
- Oracle: ALLSTATS LAST의 A-Rows는 이미 총량이라 그대로
- **추정 vs 실제가 10배 이상** 벌어진 노드 중 **최하위(리프에 가까운) 노드**를 지목합니다. 괴리는 아래에서 위로 전파되니 뿌리를 짚어야 처방이 나오기 때문입니다

loops 곱의 정확성은 단위 테스트로 고정했습니다(전체 12건에 포함). 한 번 틀리면 진단 전체가 그럴듯한 거짓말이 되는 지점이기 때문입니다.

## 9. 숫자 하나로 인덱스가 죽는 근본 원인 5종

괴리 노드를 찾았으면 이제 "왜"입니다. 인덱스를 무력화하는 패턴을 다섯 가지로 정리해 판정 규칙에 넣었습니다.

1. **암시적 형변환**. 문자열 컬럼에 숫자 리터럴(`code = 12345`)을 주면, 비교 규칙상 문자열 쪽이 숫자로 캐스팅돼(컬럼에 함수를 씌운 꼴) 인덱스가 무력화됩니다. 게다가 `'012345'` 같은 다른 문자열까지 같은 숫자로 매칭되는 **정합성 위험**까지 있습니다
2. **컬럼에 함수/표현식**. `WHERE UPPER(name) = ...` 같은 경우입니다. 인덱스는 원본 값 순서로 정렬돼 있습니다
3. **앞 와일드카드 LIKE**. `LIKE '%abc'`는 B+Tree 탐색 시작점을 못 잡습니다
4. **복합 인덱스 선두 누락**. (a, b) 인덱스에 b만으로 조건을 건 경우
5. **통계 노후**. 옵티마이저가 낡은 분포로 추정합니다

이 중 1번이 제일 악랄합니다. 쿼리만 봐서는 멀쩡해 보이기 때문입니다. 실측입니다:

```
MySQL, code VARCHAR 컬럼에 인덱스 존재:

WHERE code = 12345      (숫자 리터럴)
  -> 풀스캔. 근본 원인: "암시적 형변환" 정확 지목
  -> 처방: "값을 문자열로 주거나 컬럼 타입을 맞춰라"

WHERE code = '012345'   (문자열 리터럴)
  -> 인덱스 정상 사용. 근본 원인 없음
```

![심층 원인 진단으로 추정 300행과 실제 1행의 괴리에서 암시적 형변환을 지목하고 처방까지 내놓은 화면](/uploads/project/dbtower/deep-diagnose.png)

같은 인덱스, 같은 테이블, 따옴표 하나 차이입니다. "풀스캔입니다"까지만 말해주는 도구와 "형변환 때문이고 이렇게 고치세요"까지 말해주는 도구의 차이가 이 기능의 존재 이유입니다. 다른 기종에서도 같은 틀이 동작합니다. PostgreSQL은 추정 5행 vs 실제 348행(69.6배)에서 앞 와일드카드를, MongoDB는 docsExamined가 반환 문서의 2만 배인 COLLSCAN을 잡았습니다.

발행 후 받은 외부 리뷰가 이 화면을 세 군데 고치게 했습니다. **하나, 카드 순서.** 처음엔 "카디널리티 오추정"이 첫 카드였는데, 괴리는 형변환의 **증상**일 뿐입니다. 첫 카드만 읽은 사용자가 "통계 문제구나" 하고 ANALYZE만 돌리고 끝낼 수 있다는 지적이 정확했습니다. 지금은 근본 원인이 먼저 오고, 괴리는 "위 원인의 부산물이라 통계 갱신으로는 안 풀린다"로 옮겼습니다. **둘, 정합성 경고.** 형변환의 더 무서운 얼굴은 `'012345'`·`'12345 '`·`'12345abc'`가 전부 숫자 12345로 매칭된다는 겁니다. 조회면 오답, UPDATE/DELETE면 데이터 사고인데, 원래 판정문은 성능 얘기만 했습니다. **셋, loops 환산 안내는 loops>1일 때만.** loops=1인 계획에서는 노이즈였기 때문입니다.

그리고 리뷰가 제안한 것 하나를 새로 만들었습니다. **수정안 원클릭 재진단**입니다. 형변환 케이스는 "숫자 리터럴에 따옴표"라는 기계적으로 안전한 수정이 가능해서, 판정이 수정안 SQL을 함께 돌려주고 버튼 한 번으로 재진단해 before/after를 비교합니다.

![수정 전후를 비교하니 괴리가 300배에서 없음으로, 근본원인이 1건에서 0건으로 줄고 Index lookup으로 전환된 화면](/uploads/project/dbtower/deep-before-after.png)

여기서 정합성 경고가 실측으로 증명되는 덤이 있었습니다. 수정 전의 "실제 1행"은 사실 `'012345'`가 숫자 캐스팅으로 **잘못 매칭된 행**이었고, 문자열 `'12345'`로 고치자 정확히 0행이 나왔습니다. 형변환은 느린 것보다 틀린 게 진짜 문제라는 걸 진단 도구가 스스로 보여준 셈입니다.

## 10. "실제 실행"이라는 위험 앞에서 안전을 먼저 설계한다

여기서 심층 진단은 기존 explain과 결정적으로 다릅니다. EXPLAIN ANALYZE는 이름 그대로 **쿼리를 실제로 실행합니다.** 10분짜리 쿼리를 진단하겠다고 던지면 대상 DB에서 10분을 실제로 돕니다. 진단 도구가 부하 유발자가 됩니다.

그래서 안전장치를 기능보다 먼저 설계했습니다:

- **SELECT 전용**. DML은 실행 자체가 대상 변경이라 입구에서 거부합니다
- **타임아웃**. 기종별 수단으로 실행 시간에 상한을 둡니다(예: PG는 statement_timeout). 실측으로 `pg_sleep` 쿼리가 10초에 취소되는 것까지 확인했습니다
- **ADMIN 경계**. 조회·EXPLAIN(추정)은 VIEWER부터지만, 이건 대상에서 워크로드를 실제로 돌리는 행위라 "실행하는 행위는 ADMIN"이라는 5편의 인가 원칙에 따라 ADMIN 전용으로 올렸습니다

"진단은 읽기니까 안전하다"는 통념이 여기서는 성립하지 않습니다. 실제 실행은 읽기여도 부하입니다. 이 인식이 다음 편의 주제(분석 보호장치)로 이어집니다.

## 11. 마치며, 읽기만 하는 자율과 진단의 마지막 층

이번 편으로 진단 스택이 한 줄로 이어졌습니다. **어느 인스턴스가 나쁜가**(헬스 스코어) -> **어느 쿼리가 문제인가**(시점 비교·이상 감지) -> **계획이 왜 나쁜가**(explain + 규칙) -> **옵티마이저는 왜 속았나**(추정 vs 실제 괴리) -> **무엇을 고치면 되나**(근본 원인 5종 + 처방).

그리고 전부 **읽고, 판단하고, 알려줄 뿐** 대상 DB를 건드리지 않습니다. 이상을 감지해도 쿼리를 죽이지 않고, 미사용 인덱스를 찾아도 지우지 않고, SLO가 EXHAUSTED여도 스로틀하지 않습니다. pganalyze가 "AI-assisted but developer-driven"이라고 부르는 그 선입니다. 구현 비용도 한결같았습니다. 여덟 축과 심층 진단 전부가 `DbmsOperator` 메서드 1개 추가(latencyPercentiles·partitions·indexUsage·explainAnalyze) 또는 기존 재사용으로 5기종을 통합했습니다. 1편에서 그은 추상화 경계가 가장 기종 의존적인 기능에서도 버틴 것입니다.

코드와 실측 기록 전체는 [GitHub](https://github.com/dj258255/dbtower)에 있습니다.

---
title: '"인덱스가 있는데 왜 안 타요?" — 추정이 아니라 실제 실행 계획으로 답하기'
titleEn: '"The Index Is There, Why Is It Not Used?" — Answering with Actual Execution Plans, Not Estimates'
description: "이기종 DBMS 운영 관리 플랫폼 DBTower 9편. EXPLAIN은 옵티마이저의 '추정'이라, 옵티마이저가 속은 이유는 EXPLAIN만으로 알 수 없습니다 — 추정 행수와 실제 행수의 괴리를 봐야 해요. 그런데 '실제 실행 계획'을 얻는 방법이 다섯 기종 전부 다릅니다: MySQL EXPLAIN ANALYZE(8.4가 FORMAT=JSON을 거부해 TREE로 — 문서를 실측으로 고친 이야기), PostgreSQL (ANALYZE,BUFFERS), Oracle gather_plan_statistics 힌트와 DISPLAY_CURSOR를 같은 커넥션에서, SQL Server SET STATISTICS XML의 별도 결과셋, MongoDB executionStats. actual rows가 루프당 평균이라 loops를 곱해야 하는 함정, 숫자 리터럴 하나로 인덱스가 무력화되는 암시적 형변환을 code=12345 실측으로 정확히 지목한 기록, 그리고 '실제 실행'이라는 위험을 ADMIN 경계와 타임아웃으로 다루는 안전 설계까지."
descriptionEn: "Part 9 of DBTower. EXPLAIN shows the optimizer's estimate — it cannot tell you why the optimizer was fooled. For that you need the gap between estimated and actual rows, and the way to get an actual execution plan differs across all five engines: MySQL EXPLAIN ANALYZE (8.4 rejects FORMAT=JSON, so TREE — a spec corrected by measurement), PostgreSQL (ANALYZE, BUFFERS), Oracle's gather_plan_statistics hint plus DISPLAY_CURSOR on the same connection, SQL Server's SET STATISTICS XML as a separate result set, and MongoDB's executionStats. Includes the loops-multiplication pitfall (actual rows are per-loop averages), a measured case where one numeric literal disabled an index via implicit type conversion (code=12345), and the safety design — ADMIN boundary and timeouts — for the risk that is 'actually executing.'"
date: 2026-07-05
tags:
  - Java
  - Spring Boot
  - DBRE
  - Query Optimization
  - MySQL
  - PostgreSQL
category: project/dbtower
coverImage: /uploads/project/dbtower/cover.svg
draft: true
series: "dbtower"
seriesOrder: 9
---

## 0. 들어가며 — EXPLAIN이 답 못 하는 질문

[8편](/blog/project/dbtower/dbtower-8-autonomous-diagnosis)의 자율 진단은 "어느 인스턴스의 어느 쿼리가 문제"까지 지목해요. 그런데 그 다음 질문이 남습니다. 현업에서 제일 흔한 형태로는 이거예요 — **"인덱스가 있는데 왜 안 타요?"**

기존 explain 기능(1편)은 이 질문에 절반만 답합니다. EXPLAIN은 옵티마이저의 **추정**이거든요. "풀스캔을 택했다"까지는 보여주지만, **왜 그런 선택을 했는지** — 옵티마이저가 무엇에 속았는지는 추정 계획만으로 알 수 없어요. 그걸 알려면 옵티마이저가 예상한 행수(추정)와 실제로 읽은 행수(실측)를 나란히 놓고 **괴리**를 봐야 합니다. 추정 5행인데 실제 348행이었다면, 옵티마이저는 그 지점에서 속은 거예요.

그래서 D9는 "실제 실행 계획"을 5기종에서 얻고, 괴리를 찾고, 괴리의 근본 원인을 지목하는 기능입니다. 명세를 확정할 때는 기종별 공식 문서를 웹서칭으로 검증해서 판단 기준 문서(ai-analysis-rules.md)에 "심층 원인 규칙" 절부터 만들었어요 — AI 분석과 코드가 같은 기준을 공유해야 하니까요.

## 1. "실제 실행 계획"이 다섯 가지로 갈라진다

이 시리즈의 익숙한 패턴이 여기서도 반복됩니다. 같은 "실제 실행 계획"인데 얻는 방법이 기종마다 전부 달라요.

| 기종 | 방법 | 특이점 |
|---|---|---|
| MySQL | EXPLAIN ANALYZE (TREE) | 8.4가 FORMAT=JSON을 거부 — 아래 참고 |
| PostgreSQL | EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) | 버퍼 읽기까지 JSON으로 |
| Oracle | /*+ gather_plan_statistics */ 힌트 + DBMS_XPLAN.DISPLAY_CURSOR('ALLSTATS LAST') | 실행과 조회가 **같은 커넥션**이어야 함 |
| SQL Server | SET STATISTICS XML ON | 계획이 **별도 결과셋**으로 옴 — getMoreResults()로 수거 |
| MongoDB | explain의 executionStats verbosity | totalDocsExamined vs nReturned |

구현 디테일 두 개만요. Oracle은 `DISPLAY_CURSOR`가 "방금 이 세션이 실행한 커서"를 찾는 구조라, 풀에서 커넥션을 두 번 빌리면 안 됩니다. `ConnectionCallback`으로 실행과 조회를 한 커넥션에 묶었어요(6편에서 explain에 쓴 것과 같은 패턴). SQL Server는 `SET STATISTICS XML ON`을 켜면 쿼리 결과 **다음에** 계획 XML이 별도 결과셋으로 따라와서, `getMoreResults()`로 넘겨가며 수거해야 합니다.

그리고 MySQL에서 문서가 실측에 진 이야기. 명세 단계에서는 웹 자료를 근거로 `EXPLAIN ANALYZE FORMAT=JSON`으로 적어뒀는데, 구현하며 실제 MySQL 8.4에 던지자 **ERROR 1235로 거부**됐어요. 구현은 기본 출력인 TREE 파싱으로 갔고, **판단 기준 문서를 실측 결과대로 고쳤습니다.** 명세가 코드를 이기는 게 아니라, 실측이 명세를 고치는 순서 — 시리즈 내내 지켜온 순서예요.

## 2. loops 곱 — 괴리 계산의 함정

괴리를 계산할 때 밟기 쉬운 함정이 하나 있어요. MySQL과 PostgreSQL의 actual rows는 **루프당 평균**입니다. 중첩 루프 조인의 안쪽 노드가 `rows=3, loops=100`이면 실제로 읽은 건 3행이 아니라 300행이에요. loops를 곱하지 않으면 "추정 3, 실제 3, 괴리 없음"이라는 엉뚱한 결론이 나옵니다.

그래서 괴리 판정은 이렇게 했어요:

- MySQL/PG: 실제 총량 = actual rows x loops로 환산 후 추정과 비교
- Oracle: ALLSTATS LAST의 A-Rows는 이미 총량이라 그대로
- **추정 vs 실제가 10배 이상** 벌어진 노드 중 **최하위(리프에 가까운) 노드**를 지목 — 괴리는 아래에서 위로 전파되므로, 뿌리를 짚어야 처방이 나옵니다

loops 곱의 정확성은 단위 테스트로 고정했어요(전체 12건에 포함). 이런 건 한 번 틀리면 진단 전체가 그럴듯한 거짓말이 되는 지점이라서요.

## 3. 근본 원인 5종 — 숫자 하나로 인덱스가 죽는다

괴리 노드를 찾았으면 이제 "왜"입니다. 인덱스를 무력화하는 패턴을 다섯 가지로 정리해 판정 규칙으로 넣었어요.

1. **암시적 형변환** — 문자열 컬럼에 숫자 리터럴(`code = 12345`). 컬럼 쪽이 변환되며 인덱스 무력화
2. **컬럼에 함수/표현식** — `WHERE UPPER(name) = ...`. 인덱스는 원본 값 순서로 정렬돼 있음
3. **앞 와일드카드 LIKE** — `LIKE '%abc'`. B+Tree 탐색 시작점을 못 잡음
4. **복합 인덱스 선두 누락** — (a, b) 인덱스에 b만으로 조건
5. **통계 노후** — 옵티마이저가 낡은 분포로 추정

이 중 1번이 제일 악랄해요. 쿼리만 봐서는 멀쩡해 보이거든요. 실측이 이겁니다:

```
MySQL, code VARCHAR 컬럼에 인덱스 존재:

WHERE code = 12345      (숫자 리터럴)
  -> 풀스캔. 근본 원인: "암시적 형변환" 정확 지목
  -> 처방: "값을 문자열로 주거나 컬럼 타입을 맞춰라"

WHERE code = '012345'   (문자열 리터럴)
  -> 인덱스 정상 사용. 근본 원인 없음
```

![심층 원인 진단 — 추정 300행 vs 실제 1행 괴리에서 암시적 형변환을 지목하고 처방까지](/uploads/project/dbtower/deep-diagnose.png)

같은 인덱스, 같은 테이블, 따옴표 하나 차이예요. 이걸 "풀스캔입니다"까지만 말해주는 도구와 "형변환 때문이고 이렇게 고치세요"까지 말해주는 도구의 차이가 D9의 존재 이유입니다. 다른 기종에서도 같은 틀이 동작해요 — PostgreSQL은 추정 5행 vs 실제 348행(69.6배)에서 앞 와일드카드를, MongoDB는 docsExamined가 반환 문서의 2만 배인 COLLSCAN을 잡았습니다.

## 4. "실제 실행"이라는 위험 — 안전을 먼저 설계한다

여기서 D9가 기존 explain과 결정적으로 다른 점을 짚어야 해요. EXPLAIN ANALYZE는 이름 그대로 **쿼리를 실제로 실행합니다.** 10분짜리 쿼리를 진단하겠다고 던지면 대상 DB에서 10분을 실제로 돌아요. 진단 도구가 부하 유발자가 되는 거죠.

그래서 안전장치를 기능보다 먼저 설계했습니다:

- **SELECT 전용** — DML은 실행 자체가 대상 변경이라 입구에서 거부
- **타임아웃** — 기종별 수단으로 실행 시간에 상한(예: PG는 statement_timeout). 실측으로 `pg_sleep` 쿼리가 10초에 취소되는 것까지 확인했어요
- **ADMIN 경계** — 조회·EXPLAIN(추정)은 VIEWER부터지만, D9는 대상에서 워크로드를 실제로 돌리는 행위라 "실행하는 행위는 ADMIN"이라는 5편의 인가 원칙에 따라 ADMIN 전용으로 올렸습니다

"진단은 읽기니까 안전하다"는 통념이 D9에서는 성립하지 않아요. 실제 실행은 읽기여도 부하입니다. 이 인식은 다음 편의 주제(분석 보호장치)로 이어져요.

## 5. 마치며 — 진단의 마지막 층

이번 편으로 진단 스택이 한 줄로 이어졌어요. **어느 인스턴스가 나쁜가**(헬스 스코어) -> **어느 쿼리가 문제인가**(시점 비교·이상 감지) -> **계획이 왜 나쁜가**(explain + 규칙) -> **옵티마이저는 왜 속았나**(추정 vs 실제 괴리) -> **무엇을 고치면 되나**(근본 원인 5종 + 처방).

그리고 이 기능도 결국 `DbmsOperator`에 `explainAnalyze()` 메서드 하나를 추가한 것이었습니다. 다섯 기종의 전혀 다른 다섯 가지 획득 방법 — 힌트, 세션 설정, 별도 결과셋, verbosity — 이 전부 그 메서드 시그니처 하나 뒤로 들어갔어요. 1편에서 "추상화 경계는 SQL이 아니라 운영 행위에 긋는다"고 했던 게, 가장 기종 의존적인 기능에서도 버틴 셈입니다.

코드와 실측 기록 전체는 [GitHub](https://github.com/dj258255/dbtower)에 있습니다.

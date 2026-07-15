---
title: '"기능이 된다"와 "같은 화면이 나온다"는 다릅니다 — 화면 패리티와 세 개의 함정'
titleEn: '"It Works" and "It Shows the Same Screen" Are Different — Screen Parity and Three Traps'
description: '이기종 DBMS 운영 관리 플랫폼 DBTower 15편. 레퍼런스 발표의 화면 11장을 옆에 놓고 컬럼 단위로 전수 대조했습니다. 뼈대는 다 돌아가는데 표의 컬럼이 달랐고, 그걸 맞추는 과정에서 함정 셋을 만났습니다. 단위 테스트 382건이 초록인데 웹 콘솔 전체가 백화된 채 커밋돼 있었고(중복 선언 하나가 SPA를 전멸시킴), "카탈로그 재구성(근사)"라는 배지는 사실 게으름의 라벨이었고(pg_get_constraintdef를 쓰면 근사가 아님), CPU 그래프를 붙이다 보니 활동 그래프가 9시간 미래의 빈 구간을 조회하고 있었습니다(UTC 고정 JVM vs 브라우저 벽시계). 테이블 상세 5기종, 표 컬럼 패리티, CPU·Connections 그래프 내장과 CPU 드래그까지 — 라이브 실측과 함께 기록합니다.'
descriptionEn: 'Part 15 of DBTower. I put 11 slides of the reference platform side by side and compared column by column. The skeleton all worked, but table columns differed — and closing that gap surfaced three traps: 382 green unit tests while the entire web console was white-screened in a committed state (one duplicate declaration killed the whole SPA); the "catalog reconstruction (approximate)" badge was actually a label for laziness (with pg_get_constraintdef it is not approximate); and wiring the CPU graph revealed the activity chart had been querying an empty window nine hours in the future (UTC-pinned JVM vs browser wall clock). Table detail across five engines, column parity, built-in CPU/Connections graphs and CPU-drag selection — recorded with live measurements.'
date: 2026-07-15
tags:
  - Java
  - Spring Boot
  - PostgreSQL
  - Frontend
  - DBRE
category: personal/DBTower
coverImage: /uploads/project/dbtower/cover.svg
draft: false
series: "DBTower"
seriesOrder: 15
---

## 0. 들어가며, 화면을 옆에 놓고 대조하다

14편에서 셀프호스트 블로커를 없애고 나서, 처음의 레퍼런스 발표 자료를 다시 꺼냈습니다. 이번엔 기능 목록이 아니라 **화면 11장**을 옆에 놓고 컬럼 단위로 대조했습니다. 결과가 흥미로웠습니다. 뼈대 — 3탭 구조, 시점 비교, 증감·신규 감지, 활용 사례 세 가지 흐름 — 는 전부 돌아가는데, **표에 찍히는 컬럼이 달랐습니다.**

레퍼런스의 상위 SQL 표는 Call/sec·Latency(ms)·Row Examined(Avg)를 보여주는데 DBTower는 누적 Calls·Total(ms)을 보여주고 있었고, 슬로우 쿼리 표엔 User@host와 Lock_time이 없었고, MongoDB 표엔 인덱스를 탔는지(IXSCAN/COLLSCAN)를 바로 보여주는 Plan 컬럼이 없었습니다. 기능이 된다는 것과 운영자가 매일 보는 화면이 같은 정보 밀도를 갖는 것은 다른 문제였습니다. 이번 편은 그 간극을 메운 기록이고, 메우는 과정에서 만난 함정 셋이 사실 본편입니다.

## 1. 테이블 상세 — DDL의 출처를 속이지 않기

먼저 제일 큰 조각부터. 레퍼런스의 "테이블 상세 정보" 화면은 CREATE TABLE 전문, 기본 통계(엔진·행수·데이터/인덱스 크기·평균 행 길이·생성 시각), 인덱스 정보(타입·카디널리티)를 한 화면에 보여줍니다. 문의에 붙이던 "린 요약"(컬럼·인덱스 이름 수준)을 이 수준으로 끌어올렸습니다.

5기종의 사정이 다 달랐습니다. MySQL은 `SHOW CREATE TABLE`이 원문을 그대로 주지만, PostgreSQL엔 그런 단일 명령이 없습니다. 그래서 DDL에 **출처 라벨**을 달았습니다 — 엔진이 준 원문이면 NATIVE, 카탈로그에서 조립했으면 RECONSTRUCTED. 재구성한 것을 원문인 척 보여주지 않겠다는 원칙입니다. 카디널리티도 같은 원칙으로, SQL Server처럼 기본 노출이 아닌 기종(DBCC는 무겁고 권한이 필요합니다)은 지어내지 않고 비워둡니다.

기종별 함정도 하나씩 있었습니다. MySQL의 STATISTICS는 복합 인덱스 카디널리티를 컬럼 위치별로 누적해 주므로 마지막 위치 값이 인덱스 전체 카디널리티입니다. PostgreSQL의 `pg_stats.n_distinct`는 음수면 "행수 대비 비율"이라는 뜻이라 `round(-n_distinct × reltuples)`로 환산해야 하고 — 여기서 라이브 함정 하나: n_distinct는 float4인데 pgjdbc가 float4→Double 변환을 지원하지 않아 `::float8` 캐스팅이 필요했습니다. 그리고 `SHOW CREATE TABLE`류는 테이블명을 파라미터 바인딩할 수 없어서, 식별자 문자 집합을 강하게 제한하는 검증(`[A-Za-z0-9_$#]{1,128}`)이 유일한 주입 방어선입니다. `{"table":"users; DROP TABLE users"}`를 넣어 거부되는 것까지 라이브로 확인했습니다.

![MySQL users 테이블 상세 — SHOW CREATE TABLE 원문(NATIVE), InnoDB, 카디널리티 8,118](/uploads/project/dbtower/table-detail-mysql.png)

### "(근사)"는 게으름의 라벨이었다

처음엔 PG 재구성 DDL에 "카탈로그 재구성(근사)"라는 배지를 달았습니다. 컬럼·PK·인덱스만 조립하고 FK·CHECK를 생략했으니 근사가 맞긴 했습니다. 그런데 "근사가 뭐냐, 정확하게 해야 하는 거 아니냐"는 지적을 받고 다시 보니 — **근사일 이유가 없었습니다.** PostgreSQL은 `pg_get_constraintdef`, `pg_get_indexdef`라는 자체 정의 함수를 제공합니다. pg_dump가 쓰는 바로 그 함수들입니다. 이걸 쓰면 FK·CHECK 절이 엔진이 렌더한 원문 그대로 나옵니다.

FK와 CHECK가 있는 데모 테이블을 만들어 확인하니 `CONSTRAINT demo_order_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES demo_customer(id)`와 `CHECK ((qty > 0))`가 정확히 재조립됐습니다. 배지에서 "(근사)"를 뗐고, 이제 담지 못하는 것은 트리거·파티션 정의뿐이라 **실제로 있을 때만** note에 밝힙니다. RECONSTRUCTED는 "단일 명령이 없다"는 사실의 표기이지 부정확의 표기가 아니게 됐습니다. 정직 라벨은 한계를 가리는 데 쓰면 안 되고, 한계를 없앨 수 있으면 없애는 게 먼저라는 걸 배웠습니다.

![PostgreSQL demo_order 테이블 상세 — FK·CHECK까지 재조립된 DDL, 근사 아님](/uploads/project/dbtower/table-detail-pg.png)

## 2. 함정 하나 — 테스트 382건 초록, 화면은 전멸

테이블 상세를 검증하려고 브라우저를 열었더니 **모든 화면이 "불러오는 중..."에서 멈춰 있었습니다.** 인스턴스 목록도, 그래프도, 전부. 콘솔엔 한 줄이 찍혀 있었습니다: `Identifier 'fmtBytes' has already been declared`.

테이블 상세 렌더를 붙이면서 추가한 `const fmtBytes`가, 파일 저 위에 이미 있던 같은 이름의 선언과 충돌한 겁니다. 자바스크립트에서 `const` 중복 선언은 실행 중 에러가 아니라 **파싱 에러**입니다. app.js 전체가 한 글자도 실행되지 못했고, SPA는 아무것도 렌더하지 못했습니다. 그리고 이 상태로 커밋까지 되어 있었습니다 — 단위 테스트 382건이 전부 초록이었으니까요.

당연한 이야기지만 Java 단위 테스트도, curl로 하는 API 검증도 프론트 자바스크립트의 파싱을 거치지 않습니다. 13편의 YAML 중복 키(테스트는 통과, 실제 부팅에서 폭발)와 정확히 같은 결입니다. 검증 파이프라인에 `node --check`(구문 검사)를 넣고, 기능 검증은 API 응답 확인이 아니라 브라우저에서 실제 화면이 그려지는 것까지로 기준을 올렸습니다. 이 습관이 뒤에 나올 세 번째 함정도 잡아냅니다.

## 3. 표 컬럼 패리티 — Call/sec의 정직

컬럼을 맞추는 건 대부분 "데이터는 이미 안에 있는데 노출만 안 된" 문제였습니다. 슬로우 쿼리의 User@host·Lock_time·Rows_sent는 mysql.slow_log에 이미 있는 컬럼이었고, MongoDB의 Plan은 system.profile이 저장하는 planSummary("IXSCAN { k: 1 }", "COLLSCAN")를 그대로 배지로 올리면 됐습니다. COLLSCAN은 빨강, 인덱스를 탄 스캔은 초록 — 표에서 바로 "인덱스를 안 탔네"가 보입니다.

![MongoDB 슬로우 쿼리 — Plan 컬럼으로 인덱스 사용 여부가 바로 보인다 (COLLSCAN 43,000행 스캔)](/uploads/project/dbtower/slow-mongo-plan.png)

까다로운 건 상위 SQL 표의 **Call/sec** 하나였습니다. 평균 Latency와 평균 Row Examined는 누적값을 호출수로 나누면 그만이지만, "초당 호출"은 다릅니다. `performance_schema`의 calls는 서버 기동 이후 누적 카운터라서, 단일 시점 조회로는 초당 얼마인지 알 수가 없습니다. 시간 창이 필요합니다.

마침 이상 감지가 이미 하고 있던 일이었습니다. 1분마다 쌓는 스냅샷에서 최근 창의 양 끝 배치를 차분해 쿼리별 QPS를 계산하는 로직이요. 그걸 재사용해 Call/sec를 채우되, **스냅샷 이력이 없으면 0으로 지어내지 않고 "—"로 표기**합니다. 수집이 방금 시작된 인스턴스에서 Call/sec가 0으로 보이는 것과 "아직 모름"으로 보이는 것은 운영자에게 완전히 다른 정보입니다.

## 4. 모니터링 지표 통합 — 위임을 접고 내장하다

Monitoring 탭의 CPU·Connections 그래프는 처음에 "의도된 차이"로 분류했습니다. 레퍼런스는 관리형 DB 환경이라 CloudWatch·Performance Insights가 있고, 우리는 exporter·Prometheus·Grafana 스택이니 링크로 위임하면 된다고요. 그런데 다시 생각해 보니 레퍼런스도 결국 수집기의 패널을 화면에 임베드한 것이었습니다. 우리 스택도 똑같이 할 수 있습니다 — Prometheus HTTP API(`query_range`)를 앱이 직접 조회하면 됩니다. exporter는 이미 데모 스택에서 돌고 있었고, 없는 건 호스트 CPU를 줄 node_exporter뿐이었습니다.

그래서 내장했습니다. Monitoring 탭 맨 위에 CPU(%)와 Connections 라인 차트, 그리고 "전체 화면으로 보기"는 Grafana로. 원칙 하나를 지켰습니다 — **Prometheus는 선택 인프라입니다.** 미설정이든 연결 불가든 그래프는 사유를 그대로 표기하고("node_exporter 미수집 — ..."), 콘솔의 나머지는 아무 영향이 없습니다. 그래프 한 장 때문에 콘솔이 죽으면 안 되니까요. MSSQL처럼 표준 exporter가 없는 기종은 미지원을 미지원이라고 적습니다.

![Monitoring 탭 Metric 카드 — CPU%·Connections를 콘솔이 직접 그린다](/uploads/project/dbtower/metric-card.png)

그리고 레퍼런스 화면의 핵심 인터랙션 — **CPU 그래프를 드래그해서 조회·비교 구간을 고르는 것** — 도 가져왔습니다. 기존 드래그 차트는 QPS만 그렸는데, QPS ↔ CPU% 토글을 달아 같은 드래그가 CPU 그래프 위에서도 동작하게 했습니다. 부하가 튄 구간을 CPU 곡선에서 눈으로 집어 드래그하면 그 구간이 시점 비교의 입력이 됩니다.

![CPU 그래프에서 조회(초록)·비교(주황) 구간을 드래그로 선택](/uploads/project/dbtower/compare-cpu-drag.png)

부수 효과로, Phase 5에 계획해 뒀던 디스크 포화 예측(`predict_linear`)의 기반 — node_exporter와 Prometheus 클라이언트 — 이 이 작업으로 먼저 생겼습니다.

## 5. 함정 셋 — 9시간 미래를 조회하고 있었다

그런데 metrics API가 자꾸 빈 결과를 돌려줬습니다. Prometheus에 직접 curl을 치면 데이터가 나오는데, 앱을 거치면 빈 배열. 클라이언트 코드를 똑같이 떼어 단독 실행하면 또 됩니다. 앱에서만 안 되는 이유를 쫓다가 로그 타임스탬프가 눈에 들어왔습니다 — 호스트는 오후 12시 55분인데 앱 로그는 03:55Z.

DBTower의 JVM은 **의도적으로 UTC에 고정**되어 있습니다(하드닝 아크에서, 서버·수집기·대상 DB의 시각 기준이 섞여 쿨다운·베이스라인이 어긋나는 걸 막으려고요). 그런데 프론트는 브라우저 벽시계 — 한국이면 KST — 를 그대로 API에 보내고 있었습니다. 서버는 그 벽시계 숫자를 UTC로 읽습니다. "최근 3시간"을 조회한다는 게 실제로는 **9시간 미래의 빈 구간**을 조회하고 있던 겁니다.

이건 새 기능의 버그가 아니라 기존 버그였습니다. 활동 그래프도, 드래그로 채운 비교 조회도 같은 스큐를 갖고 있었습니다. 고치는 방향은 한 가지 규칙으로 정리했습니다 — **선을 넘는 시각은 UTC, 사람 눈에 닿는 시각은 로컬.** API로 보낼 땐 `toISOString()`으로 변환하고, API가 주는 시각(오프셋 표기가 없는 UTC 벽시계)은 Z를 붙여 진짜 시각으로 만든 뒤 차트 축·입력창은 브라우저 로컬로 렌더합니다. 고치고 나서 CPU 그래프에서 드래그 → KST로 표시된 입력 → UTC로 변환된 요청 → 비교 조회 성공(호출량 +75%, 신규 쿼리 10개)까지 한 번에 이어지는 걸 확인했습니다.

돌아보면 이 버그는 2번 함정과 같은 종류입니다. 단위 테스트는 서버 안에서만 돌고, 서버 안에서 시각은 일관됩니다. 브라우저라는 다른 시간대의 참여자가 끼어야 드러나는 문제였고, 그래서 화면까지 열어보는 검증이 또 한 번 값을 했습니다.

## 6. 남은 조각

화면 11장 기준으로 남은 건 이제 명확합니다. 활용 사례 화면 좌상단의 "Slack Group: 팀명 / 콘솔 딥링크" — 인스턴스마다 담당 팀과 콘솔 URL을 달아주는 메타데이터인데, 멀티팀 접근 제어(Phase 3)의 팀 라벨과 같은 컬럼으로 설계해야 마이그레이션을 두 번 하지 않습니다. AWS SDK를 붙이는 대신 URL 필드 하나로 일반화하면, 관리형 DB를 쓰는 조직은 PI 링크를, 셀프호스트는 Grafana 링크를 넣으면 됩니다. 그리고 14편에서 미뤄둔 데이터 마스킹 — 외부로 나가는 쿼리에서 리터럴만 가리는 스캐너는 써뒀고, 발신 지점 네 곳에 배선하는 일이 남았습니다.

"기능이 된다"에서 "같은 화면이 나온다"로 오는 데 함정이 셋이었습니다. 전부 단위 테스트 바깥에서만 보이는 것들이었고요. 다음 편은 아마 마스킹과 팀 라벨, 그러니까 "여러 팀이 한 콘솔을 쓰기 시작할 때"의 이야기가 될 겁니다.

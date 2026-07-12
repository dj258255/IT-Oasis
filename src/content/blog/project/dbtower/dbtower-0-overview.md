---
title: '5기종 DBMS를 인터페이스 하나로 묶기까지, 실측 62절로 남긴 DBTower 총정리'
titleEn: 'How DBTower Brings Five DBMS Engines Under One Interface, Told in 62 Sections of Measured Evidence'
description: 'MySQL·PostgreSQL·SQL Server·Oracle·MongoDB를 하나의 관제탑에서 등록·진단·백업·자율 감시하는 컨트롤 플레인 DBTower의 전체 기록을 한 편에 정리합니다. 도구 파편화와 DBA 반복 문의라는 문제 정의에서 시작해, 추상화 경계를 SQL이 아니라 ''운영 행위''에 그은 설계 결정과 그 검증(새 기종 추가는 구현체 1개, 수집·비교·회귀 감지·웹·MCP 코어 경로 수정 0줄 실측)을 다룹니다. 자기 자신을 관리 대상으로 등록해 자기 풀스캔을 잡은 도그푸딩(21.269ms→0.062ms), 따옴표 하나로 인덱스가 죽는 암시적 형변환을 실제 실행 계획의 추정 vs 실제 괴리로 지목하는 심층 진단, ''진단이 부하 유발자가 되면 안 된다''는 보호장치의 트레이드오프, 못 하는 것을 UNSUPPORTED로 표기하는 정직성 설계, AI를 판단자가 아니라 1차 분석기로 묶는 안전 장치(read-only 도구 화이트리스트)도 담았습니다. v1.0.0 뒤에도 쓰다 보니 필요해서 다시 파고든 심화 네 아크(플랜 플립 5기종·p95 정직 등급·데드락·스케일 제어)와 내가 만든 걸 스스로 감사해 고친 하드닝까지 이어집니다. 모든 수치는 직접 측정했고 재현 기록 62절이 저장소에 있습니다.'
descriptionEn: 'The complete story of DBTower, a control plane that registers, diagnoses, backs up, and autonomously watches MySQL, PostgreSQL, SQL Server, Oracle, and MongoDB from one tower. It starts with the problem definition of tool fragmentation and repeated DBA inquiries, then covers the design decision to draw the abstraction boundary at ''operational actions'' rather than SQL, verified by adding new engines as single operator implementations with zero changes to the core paths of collection, comparison, regression detection, web console, and MCP. It also covers dogfooding that caught the platform''s own full scan (21.269ms to 0.062ms), deep diagnosis that pinpoints implicit type conversion from estimated-vs-actual row gaps in real execution plans, the trade-offs behind the principle that diagnosis must never become the load, honesty by design with UNSUPPORTED instead of fake passes, AI constrained to a first-pass analyst with a read-only tool whitelist, and cost awareness. The story continues into four deepening arcs that real use demanded after v1.0.0, a self-audit hardening pass, and the remaining limits. Every number was measured firsthand, and 62 sections of reproduction logs live in the repository.'
date: 2026-07-06
tags:
  - Java
  - Spring Boot
  - DBRE
  - MySQL
  - PostgreSQL
  - Oracle
  - MongoDB
  - MCP
category: personal/DBTower
coverImage: /uploads/project/dbtower/cover.svg
draft: false
series: "DBTower"
seriesOrder: 0
---

## 0. 이 글 하나로

이 글은 DBTower 시리즈 13편의 총정리입니다. 시리즈를 안 읽어도 이 한 편으로 전체가 파악되게 썼고, 깊이가 필요한 지점마다 해당 편을 링크했어요.

한 줄로 요약하면 이렇습니다. **서로 다른 DBMS 5기종(MySQL·PostgreSQL·SQL Server·Oracle·MongoDB)의 운영을, 인터페이스 하나(`DbmsOperator`) 뒤에서 등록부터 진단·백업·자율 감시까지 처리하는 컨트롤 플레인**입니다. Java 21 + Spring Boot 4, 코드는 [GitHub](https://github.com/dj258255/dbtower)에 공개되어 있습니다.

숫자부터 놓고 시작할게요. 전부 직접 측정했고, 명령·출력·환경이 담긴 재현 기록([VERIFICATION.md](https://github.com/dj258255/dbtower/blob/main/docs/VERIFICATION.md) 62절)이 저장소에 있습니다.

| 항목 | 수치 |
|---|---|
| 관리 기종 | 5기종 (SQL도 JDBC도 없는 MongoDB 포함) |
| 새 기종 추가 비용 | Operator 구현체 1개, 코어 경로(수집·비교·회귀 감지·웹·MCP) 수정 0줄 (실측) |
| 성능 개선 | 수집 4.0배 · 저장 13.8배 · 조회 343배 (전부 전후 비교 측정) |
| 부하 상한 | k6 10 VU 30s — 2,832 req/s, P95 5.86ms, 실패 0 |
| 테스트 / 기록 | 356건 (CI 게이트) / VERIFICATION 62절 |
| 심화·자기검증 | v1.0.0 뒤 심화 네 아크 + 4축 자체 감사로 하드닝 (라이브에서 진짜 버그 여럿 잡음) |
| 규모 가정 | 관제 도구 특성상 실사용은 수십 RPS면 충분 — 상한은 그래도 실측해 뒀습니다 |

측정 환경은 공통적으로 로컬 Docker(Apple Silicon) 위의 대상 DB 5기종이며, 각 수치의 상세 조건은 해당 절에 명시했습니다.

## 1. 무슨 문제를 풀려고 만들었나

시작은 정상 상태의 관찰입니다. DB에 이슈가 나면 개발자는 지표가 흩어진 도구들을 오갑니다. CPU는 모니터링 대시보드에서, 쿼리 통계는 DB마다 다른 시스템 뷰에서, 실행계획은 콘솔에서 봐야 하니까요. 그러다 결국 DBA에게 문의하고 DBA는 같은 질문에 반복해서 답합니다. 관리 대상 DB가 늘수록 사람 손이 선형으로 늘어나는 구조예요.

이건 제가 지어낸 문제가 아닙니다. 업계가 이미 정의해 둔 문제예요. 당근이 사내 DB 플랫폼 KDMS를 만든 이유였고, AWS가 인프라 메트릭(CloudWatch) 위에 쿼리 수준 분석(RDS Performance Insights)을 별도 층으로 얹은 이유이기도 해요. 저는 그 문제 정의를 출발점으로 **핵심 메커니즘을 직접 구현**하기로 했습니다.

여기서 범위 결정 하나가 중요했어요. 메트릭 층(exporter + Prometheus + Grafana)은 이미 검증된 스택이라 **직접 만들지 않고 그대로 씁니다.** DBTower가 맡는 건 그 위의 층입니다. "그 시각에 어떤 쿼리가 원인이고, 실행계획이 왜 나쁘고, 무엇을 해야 하나"를 다루는 층이죠. 이미 잘 푼 문제를 다시 푸는 건 열정처럼 보여도 낭비라고 판단했습니다.

## 2. 설계의 중심은 경계를 어디에 긋는가

이기종 플랫폼의 본질은 추상화 경계의 위치 선정입니다. 같은 "쿼리 통계"가 기종마다 소스가 다르고(performance_schema / pg_stat_statements / DMV / V$SQL / system.profile), 같은 "백업"이 실행 모델부터 다릅니다(외부 CLI / 서버 사이드 SQL / 서버 사이드 API).

![DBTower 전체 구조. 소비자 차이는 채널 뒤로, 기종 차이는 DbmsOperator 뒤로, 기술 차이는 각자의 제자리로](/uploads/project/dbtower/architecture-full.svg)

결정은 세 겹입니다.

**경계는 SQL 대신 "운영 행위"에 긋는다.** `DbmsOperator`는 `queryStats()`, `explain()`, `backup()`처럼 운영자가 하는 행위를 선언하고, 기종별 구현체가 각자의 방식으로 채웁니다. 경계를 SQL에 그었다면 SQL이 없는 MongoDB가 들어올 수 없었을 거예요. 이 결정 덕에 explain 입력이 SQL 대신 명령 JSON이어도 인터페이스가 흡수합니다.

**기술은 적재적소에 쓰고 통일하지 않는다.** "Operator도 JPA + Native Query로 통일하면 깔끔하지 않냐"는 질문을 받고 제대로 분석해 봤는데([6편](/blog/project/dbtower/dbtower-6-wait-events-and-right-tool)), 결론은 반대였습니다. 대상은 런타임에 등록되는 N개의 동적 데이터소스라 부팅 시점에 고정되는 EntityManager와 안 맞고, 조회 대상인 시스템 뷰에는 매핑할 엔티티도 생명주기도 없으며, MongoDB엔 JPA 자체가 없어요. 그래서 플랫폼 자기 저장소는 Spring Data JPA(파생 메서드·@Query·Specification 3층위), 대상 DB 조회는 JdbcTemplate과 Mongo 드라이버, 스냅샷 대량 쓰기는 JDBC batch로 처리합니다. 층마다 맞는 도구를 쓰는 거예요. 깔끔함은 프레임워크 하나로 통일하는 데 있지 않습니다. 각 도구가 제일 잘하는 자리에 있는 것, 그게 이 프로젝트가 일관되게 내놓은 답입니다.

**경계는 문서로는 지켜지지 않는다. 빌드가 지킨다.** 패키지 8개를 Spring Modulith 모듈로 선언하고 모듈 간 순환 의존을 테스트가 빌드에서 실패시킵니다. 도입 첫 실행에서 실제로 순환 2개(registry↔operator, insight↔alert)가 잡혀서 의존 역전으로 해소했어요. 규칙이 실제로 작동한다는 증거를 도입 당일에 얻은 셈입니다.

경계 이야기를 한 층 더 내려가면 이렇습니다. 채널 3종(웹 콘솔·MCP·웹훅)에서 기종 어댑터와 외부 의존(메타 PG·MinIO·AI 백엔드·관측 스택)까지, 실제 모듈명과 docker-compose 포트 기준의 상세도예요. 모듈은 이후 페이즈에서 advisor·finops·score·slo·audit·onlineddl이 더해져 현재 14개입니다.

![DBTower 상세 아키텍처. 채널 3종·모듈 14개·관제 대상 5기종](/uploads/project/dbtower/architecture-detail.svg)

채널 중 웹훅이 하는 일을 실물로 보면 이렇습니다. 자동 경보(회귀·이상·플랜 플립)가 플랫폼이 사람에게 미는 push라면, 웹 콘솔의 "DB팀에 문의" 버튼은 방향은 같되 트리거가 사람인 push예요. 현재 패널의 쿼리·실행계획·규칙 지적·AI 분석을 embed 카드 한 장으로 묶어 같은 웹훅 어댑터로 보냅니다.

![문제 쿼리 식별, 원인 분석, 공유·DB팀 문의로 이어지는 진단 흐름](/uploads/project/dbtower/insight-flow.svg)

![DB팀 문의 Discord embed 실물. 요청자·인스턴스·쿼리(sql 코드블록)·실행계획·규칙 지적·AI 분석이 카드 한 장에](/uploads/project/dbtower/inquiry-discord.png)

플랫폼 자신의 상태가 어디에 어떻게 쌓이는지도 스키마로 고정해 뒀습니다. 메타 DB의 단일 권위는 Flyway 마이그레이션(V1~V10)이고(엔티티는 ddl-auto=validate로 검증만), 표 9개의 관계는 아래 ERD와 같아요. 인스턴스 한 행을 지우면 자식 다섯 표가 FK ON DELETE CASCADE(V10)로 함께 정리되고 감사 로그만 일부러 FK 없이 남습니다. 기록은 삭제와 무관하게 보존해야 하니까요.

![Flyway V1~V10 기준 표 9개로 그린 DBTower 메타 DB ERD](/uploads/project/dbtower/erd.svg)

## 3. 주장은 검증 전까지 빚이다, "새 기종 = 구현체 1개"

설계 문서에 계속 적어온 주장이 있었습니다. "새 기종 추가 = Operator 구현체 1개, 플랫폼 코드 수정 없음." 주장은 검증 전까지 빚이라, 성격이 정반대인 두 기종을 실제로 추가해 갚았습니다([4편](/blog/project/dbtower/dbtower-4-five-engines)). 상용 DB의 대표 Oracle과, SQL도 JDBC도 없는 MongoDB였죠.

결과를 정직하게 세면: 새로 만든 것은 Operator 구현체 2개와 Mongo 클라이언트 캐시, 기존 수정은 enum 값·팩토리 case 등 몇 줄. **스냅샷 수집·시점 비교·회귀 감지·웹 콘솔·MCP는 0줄 수정**으로 5기종을 처리했습니다. 이후 페이즈에서 추가한 능력들(Wait Event, 파티션, 레이턴시 백분위, 실제 실행 계획...)도 전부 "인터페이스 메서드 1개 추가"의 반복이었어요. 요행으로 한 번 맞은 결과였다면 이렇게 반복될 수 없습니다. 구조에서 나오는 성질이라는 걸 반복 검증으로 보였어요.

![다섯 기종 여섯 인스턴스가 같은 카드·같은 그래프·같은 진단으로 뜨는 대시보드](/uploads/project/dbtower/dashboard.png)

## 4. 성능, 다섯 개의 개선 아크를 전부 전후 실측

성능 서술은 "빨라졌다"에서 멈추면 안 됩니다. **무엇이, 어떤 조건에서, 왜, 얼마나**여야 한다고 생각해요. 다섯 아크 전부 개선 전 수치를 먼저 재고, 원인을 분석하고, 고친 뒤 다시 쟀습니다.

| # | 문제 | 원인 분석 | 개선 | 실측 (환경: 로컬 Docker) |
|---|---|---|---|---|
| 1 | 수집마다 지연 | 매 수집 새 커넥션 — TCP+인증 핸드셰이크 반복 | 인스턴스별 HikariCP 풀 | 47.1 → 11.8ms (4.0배) |
| 2 | 대량 저장 느림 | JPA saveAll이 행별 INSERT | JDBC batch + reWriteBatchedInserts | 행당 1.51 → 0.11ms (13.8배) |
| 3 | 스냅샷 조회 지연 | 50만 행 Seq Scan | 복합 인덱스(등치 컬럼 선두) | 21.269 → 0.062ms (343배) |
| 4 | 긴 쿼리 통계 병합 | digest 길이 1024에서 절단 | max_digest_length 4096 | side-by-side 재현·해소 |
| 5 | 상한 미검증 | — | k6 부하 테스트 | 2,832 req/s, P95 5.86ms, 실패 0 |

3번이 이 프로젝트에서 제일 아끼는 이야기입니다. **DBTower 자신을 DBTower의 관리 대상으로 등록**(메타 저장소가 PostgreSQL이라 가능했고, 도그푸딩을 염두에 둔 선택이었어요)했더니, 자기 스냅샷 조회 쿼리가 자기 화면의 슬로우 쿼리 목록에 떴습니다. 자기 explain API로 진단하니 50만 행 Seq Scan. 등치 조건 컬럼을 선두로 한 복합 인덱스를 걸고 같은 API로 재측정해 343배를 확인했어요. **개선을 측정한 도구가 곧 내가 만든 기능**이라는 순환이, 이 플랫폼이 실제로 동작한다는 가장 강한 증거라고 생각합니다.

부하 검증(5번)도 한 줄 짚을게요. 관제 도구는 사용자가 운영자 몇 명이라 실사용 수십 RPS면 충분하지만, "충분할 것"과 "상한을 안다"는 다른 문제라 k6로 상한을 실측해 뒀습니다.

## 5. 심층 사례, "인덱스가 있는데 왜 안 타요?"

포트폴리오용으로 짧게 요약하지 않고, 실제 진단 흐름 하나를 5단계로 통째로 보여드릴게요([9편](/blog/project/dbtower/dbtower-9-deep-diagnosis) 상세).

**정상 상태.** `products` 테이블(3,001행)의 `code VARCHAR(20)` 컬럼에 B-Tree 인덱스 `idx_code`가 있습니다. `WHERE code = '012345'` 조회는 인덱스를 타고 1행을 읽습니다.

**문제 상황.** 같은 쿼리를 `WHERE code = 12345`(따옴표 없이 숫자)로 던지면 풀스캔이 됩니다. 쿼리만 봐서는 멀쩡해 보여서, 현업에서 "인덱스가 있는데 왜 안 타요?"로 접수되는 대표 사례예요.

**구조적 원인.** MySQL 비교 규칙상 문자열과 숫자를 비교하면 **문자열 쪽이 숫자로 캐스팅**됩니다(`CAST(code AS DOUBLE) = 12345` 꼴). 인덱스 컬럼에 함수를 씌운 것과 같아 B-Tree 정렬을 못 쓰고, '1'·' 1'·'1a'가 같은 숫자로 매핑되므로 문자열 순서 인덱스로는 숫자 등치를 탐색할 수도 없어요(암시적 형변환). 더 무서운 건 정합성이에요. `'012345'` 같은 다른 문자열까지 같은 숫자로 매칭돼 조회면 오답, UPDATE/DELETE면 데이터 사고입니다. 그리고 EXPLAIN(추정)만으로는 옵티마이저가 "왜 속았는지"까지 안 보입니다. 그래서 **추정 행수와 실제 행수의 괴리**를 봐야 하고, 그러려면 쿼리를 실제로 실행하는 EXPLAIN ANALYZE가 필요합니다.

**학습 과정.** "실제 실행 계획"을 얻는 방법이 5기종 전부 달랐습니다. MySQL EXPLAIN ANALYZE, PostgreSQL (ANALYZE, BUFFERS), Oracle은 gather_plan_statistics 힌트 후 DISPLAY_CURSOR를 **같은 커넥션**에서, SQL Server는 SET STATISTICS XML의 **별도 결과셋**, MongoDB는 executionStats. 기종별 공식 문서로 명세를 검증해 판단 기준 문서에 먼저 적었는데, 구현 중 MySQL 8.4가 `FORMAT=JSON`을 ERROR 1235로 거부해 **문서를 실측대로 고쳤습니다.** 함정도 하나 있었어요. MySQL/PostgreSQL의 actual rows는 루프당 평균이라 loops를 곱해야 총량이고, 안 곱하면 괴리 계산 전체가 틀립니다(단위 테스트로 고정).

**결과.** 아래가 실제 화면입니다. 추정 300행 vs 실제 1행(300배 괴리)에서 최하위 노드를 짚고, 근본 원인 "암시적 형변환"과 처방("값을 문자열로 주거나 컬럼 타입을 맞춰라")까지. 같은 쿼리를 `'012345'`로 바꾸면 "근본 원인 없음"으로 정상 판정합니다.

![심층 원인 진단. 추정 300행 vs 실제 1행, 암시적 형변환 지목과 처방](/uploads/project/dbtower/deep-diagnose.png)

처방은 말로 끝나지 않습니다. 기계적으로 안전한 수정(숫자 리터럴에 따옴표)이 가능한 케이스는 수정안 SQL을 함께 만들어, **버튼 한 번으로 재진단해 before/after를 비교**해요. 괴리 300배가 없음으로, 풀스캔이 Index lookup으로 바뀌는 것까지 확인하고 끝납니다. 덤으로 이 검증에서 수정 전의 "실제 1행"이 사실 `'012345'`가 캐스팅으로 잘못 매칭된 행이었음이 드러났어요. 정합성 경고가 실측으로 증명된 셈이죠([9편](/blog/project/dbtower/dbtower-9-deep-diagnosis) 상세).

![수정안 원클릭 재진단. 괴리 300배에서 없음으로, 근본원인 1건에서 0건으로](/uploads/project/dbtower/deep-before-after.png)

이런 진단이 헬스 스코어(어느 인스턴스부터) → 시점 비교·이상 감지(어느 쿼리가) → 실행계획 규칙(계획이 왜 나쁜가) → 심층 진단(옵티마이저는 왜 속았나)의 마지막 층으로 들어가, "어디부터 봐야 하나"에서 "무엇을 고치면 되나"까지 한 줄로 이어집니다([8편](/blog/project/dbtower/dbtower-8-autonomous-diagnosis)).

## 6. 진단이 부하가 되면 안 된다는 트레이드오프 하나

마지막으로 꼭 필요하다고 생각한 기능은 화려한 쪽이 아니었어요. 보호장치였습니다([10편](/blog/project/dbtower/dbtower-10-guardrails-and-selfhost)). 심층 진단은 쿼리를 실제로 실행하고, 수집 폴러는 1분마다 대상들을 두드립니다. 관제 도구가 관제 대상을 느리게 만들면 본말전도예요.

구현보다 결정이 어려웠던 지점을 하나만 꺼내면 MongoDB 타임아웃입니다. 드라이버에 CSOT(클라이언트 전역 operation timeout)라는 정석이 있는데 **일부러 안 썼어요.** CSOT를 켜면 드라이버가 심층 진단이 명령에 직접 실은 서버측 `maxTimeMS`를 무시하고 자기 예산으로 재계산합니다. 전역 안전장치(정석)가 정밀 안전장치를 덮어쓰는 간섭이라, 소켓 read 상한 + 명령별 maxTimeMS 조합을 택하고 **이유를 코드 주석으로 남겼습니다.** 나중에 누가 "왜 정석을 안 썼지?"라며 바꾸면 조용히 망가질 지점이니까요. 정석을 아는 것과, 정석이 내 맥락에 맞는지 판단하는 건 다른 일이라고 배웠습니다.

수집 폴러에는 인스턴스별 지수 백오프를 넣었어요. 죽은 DB를 매 틱 다시 두드리는 것(TCP·인증·타임아웃 대기) 자체가 부하라서요. 연속 실패 시 건너뛸 틱이 1→2→4→8→16으로 늘고 한 번 성공하면 즉시 정상 주기로 복귀합니다. 회복한 DB를 벌주지 않는 게 포인트였고, 죽은 인스턴스를 등록해 로그로 라이브 검증했습니다.

## 7. 못 하는 것을 못 한다고 말하는 정직성 설계

이 프로젝트에서 기능만큼 공들인 게 "못 하는 것의 표기"입니다.

- **백업 복원 검증은 3값**입니다. VERIFIED / FAILED / **UNSUPPORTED**. Oracle은 자동 복원 검증 수단이 없어서 UNSUPPORTED인데, 이걸 "통과"로 위장하면 사용자는 검증 안 된 백업을 믿게 됩니다
- **레이턴시 p95는 소스 라벨을 섞지 않습니다.** MySQL은 실측(QUANTILE), MongoDB는 직접 계산, PostgreSQL은 정규분포 가정 추정(ESTIMATED 표기), SQL Server/Oracle은 원자료가 없어 UNSUPPORTED입니다
- **이상 감지는 "학습 중"을 보류로 둡니다.** 관측 8회 미만 버킷은 판정하지 않고 learningCount를 노출하죠. 모르는 것을 모른다고 말하는 것도 감지기의 정직성입니다
- **FinOps는 신호까지만 냅니다.** 절감액 달러는 환경마다 달라 찍는 순간 지어낸 숫자가 되므로, 미사용 인덱스 신호만 내고 판단은 사람에게 맡깁니다
- **Terraform은 validate까지 갑니다.** apply는 AWS 자격증명·과금이 필요해 실행하지 않았고, 그렇게 적었습니다. 같은 등록 흐름의 실제 완주는 K8s(CloudNativePG e2e)와 Ansible(멱등 changed=0)로 검증했어요([7편](/blog/project/dbtower/dbtower-7-provisioning))

관제 도구의 출력은 운영 결정의 입력이 됩니다. 과장된 능력 표기는 버그보다 나쁘다고 생각해요.

## 8. 운영 안전, 기본기의 목록

화려함보다 먼저 닫아야 했던 것들입니다([5편](/blog/project/dbtower/dbtower-5-production-safety)). 각 항목은 요약 한 줄이지만 전부 실측 기록이 있습니다.

| 축 | 내용 |
|---|---|
| 인증·인가 | 사람=세션(BCrypt)+CSRF 쿠키, 기계=Bearer 토큰(fail-closed 랜덤). 진단은 VIEWER부터, 대상을 바꾸는 행위는 ADMIN |
| 비밀번호 암호화 | AES-256-GCM + 버전 접두사(평문 하위 호환), 키 오류 시 기동 거부 |
| 스키마 | Flyway V1~V5 + ddl-auto=validate — ddl-auto=update가 CHECK 제약을 못 고치는 함정을 직접 밟고 이관 |
| 최소 권한 | 권한 0에서 시작해 에러 원문으로 5기종 최소 집합 실측 확정 (MongoDB clusterMonitor가 system.profile 읽기를 이미 포함하는 것도 실측으로 발견) |
| HA | ShedLock 분산 락 — 2노드 실측으로 중복 수집 차단 확인 |
| 감사 | 상태 변경·로그인·월권 시도 기록 + Specification 동적 검색 |
| 보안 리뷰 | mongodump stdin의 YAML 주입 가능성을 리뷰로 발견, 이스케이프+테스트로 차단 |

## 9. AI는 판단자가 아니라 1차 분석기

AI 기능은 두 가지 원칙으로 묶었습니다.

**판단 기준은 사람이 문서로 정한다.** 실행계획 판정 규칙(기종별 비효율 신호, 근거, 예외)을 문서로 만들어 시스템 프롬프트로 주입합니다. 같은 입력에 일관된 판정이 나오고, **근거가 없으면 모른다고 답하게** 했어요. 실측에서 데이터에 없는 질문("작년 크리스마스 접속자 수")에 수치를 지어내지 않고 confidence=low로 답하는 것까지 확인했습니다.

**AI에게 도구를 주되, 읽기 전용만.** 자연어 진단("이 DB 왜 느려?")은 AI가 MCP 도구를 스스로 연쇄 호출하는 루프(최대 5스텝)인데, **read-only 화이트리스트**만 노출해 kill·backup·online-ddl 같은 쓰기 도구는 루프에 아예 존재하지 않습니다. AI가 어떤 판단을 해도 대상 DB 변경이 0인 게 구조로 보장돼요. 그 MCP 서버 자체도 SDK 없이 JSON-RPC 2.0을 직접 구현했고(stdio/HTTP 전송이 프로토콜 코어 공유), 스펙 준수를 테스트로 고정했습니다([3편](/blog/project/dbtower/dbtower-3-channels-web-mcp-ai)).

![MCP 도구 목록. read-only 도구만 화이트리스트로 노출(런타임 Bearer 토큰은 마스킹)](/uploads/project/dbtower/mcp.png)

## 10. 관제 도구는 남의 자원을 쓴다는 비용 관점

이 도구의 비용 감각은 "내 인프라"보다 "대상 DB의 자원"에 있습니다.

- **커넥션 풀은 인스턴스당 max 2로 잡았습니다.** 대상 DB의 커넥션 슬롯은 그 DB의 서비스가 써야 할 자원이라, 관제 도구가 크게 점유하면 안 되니까요
- **스냅샷 보존은 기본 7일에 시간당 정리입니다.** 무한 적재면 메타 DB가 관리 대상보다 먼저 포화되니까요. 7일은 AWS Performance Insights의 기본 보존(그 이상은 명시적 선택·과금) 선례를 따랐어요
- **배포는 셀프호스트입니다.** SaaS는 대상 DB 자격증명 수탁·사설망 도달·멀티테넌시·상시 서버 비용 네 벽에 막힙니다. 도구가 사용자 인프라 안으로 들어가면 넷 다 사라져요(Grafana/PMM 모델). 그래서 배터리 포함 컨테이너 이미지(백업 CLI 번들)와 원커맨드 compose, 태그 push가 곧 릴리스인 GHCR 파이프라인으로 v1.0.0을 찍었습니다

## 11. DBA 직무 지도로 본 커버리지, 남은 한계, 결산

마지막으로 DBMS 운영의 전통적 직무 축(설치·패치·장애조치·백업/복구·오브젝트·용량)에 이 도구를 대보면, "하는 것"만큼 "안 하는 것과 그 이유"가 이 프로젝트의 성격을 보여줍니다.

| 직무 축 | 하는 것 | 위임/범위 밖 (이유) |
|---|---|---|
| 설치·프로비저닝 | 생성 즉시 멱등 등록으로 관제 편입 (K8s·Ansible·Terraform e2e) | 생성 자체는 Operator/IaC — 잘 푼 문제를 다시 풀지 않음 |
| 패치·업그레이드 | 버전 가시화 + 패치 전후 검증(드리프트·Schema Diff·시점 비교) | 패치 실행은 플랫폼별 도구의 영역 |
| 장애조치 | 감지(스코어·이상·웹훅) → 원인(Wait Event·블로킹·심층 진단) → 수동 개입(kill) | 자동 페일오버는 HA 소유자 몫 — 관제가 개입하면 스플릿 브레인 위험 |
| 백업·복구 | 정책 → 기종별 실행, 복원 검증 3값, S3 호환 원격 보관(오프사이트), 신선도 감시 — 3-2-1 완성 | 산출물 암호화는 잔여 |
| 오브젝트 관리 | 스키마·파티션·인덱스 조회/비교/조언 + 온라인 DDL(dry-run 기본) | 자동 인덱스 생성은 범위 밖 |
| 용량 관리 | 테이블 크기 상위·오버프로비저닝 신호·자체 보존 정책 | OS/디스크 시계열은 메트릭 층 위임 |
| 계정·권한 | 최소 권한 실측 가이드 + Ansible 계정 생성 | 대상 계정 CRUD UI는 안 함 |
| 모니터링·튜닝 | 본진 — 이 글의 4~6장 전부 | — |

한 줄로 요약하면, **읽고 판단하는 것은 깊게, 대상을 바꾸는 것은 최소한으로, 바꾸는 주체가 따로 있는 일은 그 주체와 잇는다.**

## 12. v1.0.0 뒤에 더 깊이 판 심화 네 아크와 자기 검증

완주 선언이 끝은 아니었어요. 오히려 거기서부터가 진짜 깊이였습니다.

먼저 v1.0.0을 찍으며 정직하게 남겨둔 잔여 셋을 닫았습니다([11편](/blog/project/dbtower/dbtower-11-deepening)). 실행계획 변경 감지(플랜 플립), 백업 원격 보관(S3 호환 오프사이트로 3-2-1 완성), TLS 강제 접속(검증 우회 옵션은 일부러 없음), 이 셋이었죠. 그리고 그 숙제를 실마리로 **심화 네 아크**를 더 팠습니다([12편](/blog/project/dbtower/dbtower-12-deepening-four-arcs)).

**하나의 기능을 다섯 기종으로.** 플랜 플립 감지가 PostgreSQL만 되던 걸 다섯 기종으로 완성했어요. 계획 형태를 얻는 경로가 기종마다 전혀 다른데(MySQL 리터럴 샘플 재EXPLAIN·SQL Server Query Store·Oracle plan_hash_value·Mongo 프로파일러 명령), `planShapeForDigest` 메서드 하나 뒤로 숨기고 shape 정규화 한 겹으로 통일했습니다.

**p95의 정직 등급을 올리다.** 값은 다 냈지만 신뢰 등급이 제각각이던 레이턴시 백분위를 손봤어요. MySQL은 히스토그램 스냅샷을 차분해 누적 0.48ms를 최근 구간 0.19ms로 갈랐고, SQL Server는 미지원을 추정으로 풀었고, Mongo는 프로파일러가 꺼져도 인스턴스 p95를 살렸고, **못 올리는 Oracle은 그대로 UNSUPPORTED로 두어** 라벨로 대비시켰습니다. 여기서 2^64 센티넬 오버플로, 최소권한 계정의 조용한 폴백 같은 진짜 버그를 라이브로 잡았어요.

![실측누적·실측구간·히스토그램·추정·미지원이 배지로 갈리는 레이턴시 카드](/uploads/project/dbtower/latency-windowed.png)

**설정 변경 0으로 데드락을 읽다.** 세 기종의 데드락 관측 입도가 근본적으로 달라(SQL Server XE는 풍부·MySQL은 최근 1건·PG는 카운터뿐), 두 갈래로 다뤘습니다. 여기서 착수 조사와 **정반대**의 현실을 만났어요. "ring_buffer 쓰지 마라"던 조사와 달리, 방금 난 데드락은 파일에 없고 링버퍼에만 있었습니다. 실측이 문서를 이긴 순간이었죠.

![SQL Server 데드락 카드. victim(spid)·경합 인덱스·관여 문장까지](/uploads/project/dbtower/deadlock-mssql.png)

**관제가 부하가 되지 않게.** 인스턴스가 수십 개로 늘 때를 대비해 수집 병렬화(ShedLock 노드 배타는 유지)·스케줄러 풀 분리·알림 폭주 제어·격리 토글·헬스 스코어 캐시 다섯 축을 넣었습니다. 문제 인스턴스를 삭제 없이 관제에서 잠시 빼는 스위치까지요.

![인스턴스 목록. 전부 '수집중', 격리한 하나만 '격리됨'](/uploads/project/dbtower/collection-toggle.png)

그리고 마지막으로, **내가 만든 걸 스스로 감사**했습니다([13편](/blog/project/dbtower/dbtower-13-hardening-arc)). 동시성·기종정확성·보안·HA 네 축을 병렬로 훑고 OWASP·CWE·벤더 문서까지 웹서칭으로 대조해, 나온 결함을 **전부 고치는 대신 FIX/SKIP으로 갈라** 근거와 함께 문서로 남겼어요. 세 장면이 특히 기억에 남습니다. 하나는 내 코드가 이미 정답을 알고 있던 곳(XXE는 다른 파일에서 이미 올바르게 막고 있었다), 하나는 병렬화가 되살린 함정(스케일 아크가 커넥션 풀 경합을 키웠다), 그리고 마지막은 실측이 감사를 다시 이긴 순간(감사는 마이크로초가 안 저장된다 했지만, 실제로는 저장돼 있어 수정이 작동했다)이었어요.

![슬로우쿼리 카드. 1초 미만 쿼리가 실측 ms로(구코드는 전부 0), 시각은 UTC 고정](/uploads/project/dbtower/slowquery-subsecond.png)

## 13. 남은 한계와 결산

여전히 정직하게 남겨둔 것들: 알림 쿨다운의 설정 외부화, Vault 동적 계정, 백업 산출물 암호화, 저장 컬럼의 `Instant` 전환, 대규모 보존의 배치 삭제. 반대로 의도적으로 안 하는 것도 있습니다. 자동 인덱스 생성, SQL 승인 워크플로 같은 "대상 DB를 스스로 바꾸는" 기능은 이 제품의 정체성(읽고 판단한다) 밖이라 범위에서 제외했어요.

돌아보면 이 프로젝트를 관통한 건 세 문장입니다.

1. **차이는 경계 뒤로.** 기종 차이는 인터페이스 뒤로, 소비자 차이는 채널 뒤로, 기술 차이는 각자의 제자리로 보냅니다
2. **주장은 실측으로.** 확장성 주장은 기종을 실제로 추가해서, 성능 주장은 전후 측정으로, 능력 표기는 안 되는 것의 명시로 증명했습니다
3. **관제 도구는 힘으로 완성되지 않는다. 신뢰가 완성한다.** 마지막에 추가한 기능이 "내가 부하가 되지 않는 장치"였고, 제품화의 첫 결정이 "비밀은 사용자 인프라를 떠나지 않는다"였습니다

전 과정의 상세는 시리즈 [1편(설계)](/blog/project/dbtower/dbtower-1-why-and-design)부터 [13편(하드닝)](/blog/project/dbtower/dbtower-13-hardening-arc)까지에, 재현 가능한 기록은 [GitHub](https://github.com/dj258255/dbtower)에 있습니다. 셀프호스트로 직접 띄워보실 수 있어요.

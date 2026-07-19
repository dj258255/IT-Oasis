---
title: 'DBTower 포트폴리오 총정리: 이기종 DBMS 5기종을 인터페이스 하나로 관제·진단하기까지, 실측 117절'
titleEn: 'DBTower Portfolio: Operating and Diagnosing Five DBMS Engines Behind One Interface, in 117 Sections of Measured Evidence'
description: 'MySQL, PostgreSQL, SQL Server, Oracle, MongoDB를 하나의 관제탑에서 등록하고 진단하고 백업하고 자율 감시하는 컨트롤 플레인 DBTower의 포트폴리오 총정리입니다. 도구 파편화와 DBA 반복 문의라는 문제 정의에서 출발합니다. 추상화 경계를 SQL이 아니라 운영 행위에 그은 설계 결정과, 그 결정을 성격이 정반대인 두 기종을 실제로 추가해 코어 0줄 수정으로 증명한 과정을 담았습니다. 자기 자신을 관리 대상으로 등록해 자기 풀스캔을 잡은 도그푸딩(21.269ms에서 0.062ms), 따옴표 하나로 인덱스가 죽는 암시적 형변환을 추정 대 실제 괴리 300배로 지목하고 정합성 사고까지 증명한 심층 진단, FULL 앵커와 LOG 체인이 병행하는 정석 백업과 실제 시점 복구, 결함 20건 이상을 스스로 감사해 FIX와 SKIP을 가른 하드닝까지. 모든 성능 수치는 개선 전후를 직접 잰 실측이고, 재현 절차는 저장소 VERIFICATION.md 117개 절에 있습니다.'
descriptionEn: 'A portfolio overview of DBTower, a control plane that registers, diagnoses, backs up, and autonomously watches MySQL, PostgreSQL, SQL Server, Oracle, and MongoDB from one tower. It starts from the problem of tool fragmentation and repeated DBA inquiries. It covers the decision to draw the abstraction boundary at operational actions rather than SQL, proven by adding two opposite engines with zero changes to core paths. It also covers dogfooding that caught the platform''s own full scan (21.269ms to 0.062ms), deep diagnosis that pinpoints implicit type conversion from a 300x estimated-vs-actual row gap and proves a correctness hazard, orthodox backups where FULL anchors and LOG chains run on independent schedules with real point-in-time restores, and hardening where over twenty self-audited defects were split into FIX and SKIP. Every performance number is a measured before/after, with reproduction steps in the repository''s VERIFICATION.md across 117 sections.'
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
coverImage: /uploads/project/dbtower/dashboard.png
draft: false
series: "DBTower"
seriesOrder: 0
---

이 글은 DBTower 시리즈 전체를 면접관이 읽는 포트폴리오 관점으로 총정리한 문서입니다. 각 주제는 "문제 정의 → 설계 판단 → 실증 → 트레이드오프"의 순서로 적었고, 성능 수치는 전부 개선 전을 먼저 재고 고친 뒤 다시 잰 전후 실측입니다. 더 깊은 과정은 1편부터 9편에 나눠 담았고, 이 글에서 각 편으로 링크합니다.

## 0. 한 장 요약

**DBTower는 서로 다른 DBMS 5기종(MySQL, PostgreSQL, SQL Server, Oracle, MongoDB)의 운영을 인터페이스 하나(`DbmsOperator`) 뒤에서 처리하는 컨트롤 플레인입니다.** 등록부터 진단, 백업, 자율 감시까지가 한 화면에서 끝납니다.

- 기간: 2026.03 ~ 2026.07, 개인 프로젝트(기여 100%)
- 스택: Java 21, Spring Boot, PostgreSQL(메타 저장소), Spring Modulith(모듈 15개), JdbcTemplate·Mongo Driver·JDBC batch(적재적소), MCP(JSON-RPC 2.0 직접 구현), Flyway, ShedLock, Docker, k6
- 규모 가정: 관제 도구라 실사용 트래픽은 수십 RPS를 예상하고 단일 노드 셀프호스트 운용을 전제했습니다. 그래도 처리 상한은 k6로 실측해 뒀습니다(2,832 req/s)
- 코드와 재현 기록: [GitHub](https://github.com/dj258255/dbtower), [VERIFICATION.md 117개 절](https://github.com/dj258255/dbtower/blob/main/docs/VERIFICATION.md), GHCR 멀티아치 공개 이미지(원커맨드 셀프호스트)
- 측정 환경: 로컬 Docker(Apple Silicon) 위 대상 DB 5기종. 모든 성능 수치는 개선 전을 먼저 재고 고친 뒤 다시 잰 전후 실측입니다

숫자부터 놓고 시작하겠습니다.

| 항목 | 수치 |
|---|---|
| 관리 기종 | 5기종 (SQL도 JDBC도 없는 MongoDB 포함) |
| 새 기종 추가 비용 | Operator 구현체 1개. 코어 경로(수집, 비교, 회귀 감지, 웹, MCP) 수정 0줄 실측 |
| 심층 진단 | 추정 300행 vs 실제 1행, 괴리 300배에서 암시적 형변환 지목 + 정합성 사고 증명 |
| 성능 개선 | 수집 4.0배(47.1→11.8ms), 저장 13.8배(행당 1.51→0.11ms), 자기 진단 343배(21.269→0.062ms) |
| 부하 상한 | k6 10 VU 30초에서 2,832 req/s, P95 5.86ms, 실패 0 |
| 보존 정리 | 월별 파티셔닝 전환으로 200만 행 DELETE 1.9초가 파티션 DROP 12.8ms로 (147배, 블로트 0) |
| 백업·복구 | 5기종 로그 백업 + FULL 앵커/LOG 체인 병행 · PITR 실제 복원 2기종(STOPAT·recovery_target_time) · AES-256-GCM |
| 품질 | 테스트 515건 CI 게이트, VERIFICATION 117개 절, 자체 감사 결함 20건 이상 FIX/SKIP 분리 |
| 배포 | GHCR 멀티아치(amd64+arm64) 공개, compose 한 번이면 뜨는 셀프호스트 |

![다섯 기종 여섯 인스턴스가 같은 카드, 같은 그래프, 같은 진단으로 뜨는 대시보드](/uploads/project/dbtower/dashboard.png)

## 1. 문제 정의: DB 이슈 대응은 지금 이렇게 흘러갑니다

문제를 정확히 정의하지 못하면 해결책이 아무리 좋아도 설득력이 없습니다. 그래서 여기서부터 시작합니다.

DB에 이슈가 나면 개발자는 지표가 흩어진 도구들을 오갑니다.

```
이슈 발생 -> CPU는 모니터링 대시보드, 쿼리 통계는 기종마다 다른 시스템 뷰,
             실행계획은 각 DB 콘솔
          -> 어제와 오늘을 사람이 눈으로 비교
          -> 원인을 못 찾으면 결국 DBA에게 문의
          -> DBA는 같은 질문에 반복해서 답변
```

관리 대상 DB가 늘수록 사람 손이 선형으로 늘어나는 구조입니다. 제가 지어낸 문제가 아니라 업계가 이미 정의해 둔 문제입니다. 국내 대형 서비스 기업들이 사내 DB 어드민 플랫폼을 직접 만들어 운영하고, AWS가 인프라 메트릭(CloudWatch) 위에 쿼리 수준 분석(RDS Performance Insights)을 별도 층으로 얹은 이유가 같은 문제의식입니다.

여기에 5기종이라는 축이 더해집니다. 같은 "쿼리 통계"가 기종마다 소스가 다르고(performance_schema, pg_stat_statements, DMV, V\$SQL, system.profile), 같은 "백업"이 실행 모델부터 다릅니다. 백업·모니터링·계정 관리 구문이 기종마다 전부 달라, 도구를 하나 만들어도 기종이 늘면 그 도구가 같이 커집니다.

**범위 결정이 중요했습니다.** 메트릭 수집 층(exporter, Prometheus, Grafana)은 이미 검증된 스택이라 다시 만들지 않고 그대로 씁니다. DBTower가 맡는 건 그 위의 층, "그 시각에 어떤 쿼리가 원인이고, 실행계획이 왜 나쁘고, 무엇을 해야 하나"입니다. 이미 잘 푼 문제를 다시 푸는 건 낭비라고 봤습니다.

목표는 두 줄입니다.

- 개발자가 DBA 문의 없이도 스스로 DB 이슈를 분석할 수 있게 한다
- 개발팀과 DB팀이 다섯 기종을 하나의 툴, 같은 화면, 같은 용어로 본다

## 2. 해법의 모양: 진단 3단계가 한 화면에서 이어진다

해법은 식별 → 분석 → 문의의 세 단계가 한 플랫폼 안에서 끊기지 않고 이어지는 구조입니다.

```
1. 문제 쿼리 식별            2. 원인 분석                3. DB팀 문의
--------------------        --------------------        --------------------
헬스 스코어(나쁜 순)          실행계획 (EXPLAIN·규칙)       문의 발송 (Discord 카드)
상위 SQL (Load 순)           테이블 스키마와 통계          쿼리·플랜·분석 자동 첨부
시점 비교 (증감, NEW)         심층 진단(추정 vs 실제)       알림 스레드에서 AI 재진단
그래프 드래그 구간 선택        AI 1차 분석(규칙 위)
```

헬스 스코어가 "어느 인스턴스가 나쁜가"를 나쁜 순으로 정렬해 아침에 여는 첫 화면이 되고, 시점 비교가 "어느 쿼리가 문제인가"를, 실행계획 규칙과 심층 진단이 "계획이 왜 나쁘고 옵티마이저는 왜 속았나"를, 마지막으로 "DB팀에 문의" 버튼이 그 맥락을 한 장으로 묶어 보냅니다.

![감점 사유 분해와 나쁜 순 정렬로 아침에 여는 첫 화면이 되는 통합 헬스 스코어](/uploads/project/dbtower/health-score.png)

시점 비교는 CPU 그래프 위에서 조회 구간(초록)과 비교 구간(주황)을 드래그로 고르고, 신규 쿼리 유입(NEW 뱃지), 호출량 급증, Latency·rows/call 증가(IN절 파라미터 폭증류)의 세 갈래 원인을 같은 화면에서 가릅니다. 자세한 원리는 [1편](/blog/project/dbtower/dbtower-1-design)에 있습니다.

![두 구간의 쿼리별 증감률과 신규 쿼리 NEW 뱃지를 보여주는 시점 비교 화면](/uploads/project/dbtower/compare.png)

## 3. 설계 결정: 경계를 어디에 긋는가

이기종 플랫폼의 본질은 추상화 경계의 위치 선정입니다. 이 프로젝트의 심장은 `DbmsOperator` 인터페이스 하나이고, 플랫폼의 모든 기능은 이 인터페이스에만 의존합니다. 기종 분기는 팩토리 한 곳에만 존재합니다. 결정은 세 겹입니다.

![DBTower 전체 구조. 소비자 차이는 채널 뒤로, 기종 차이는 DbmsOperator 뒤로, 기술 차이는 각자의 제자리로](/uploads/project/dbtower/architecture-full.svg)

**경계는 SQL 대신 "운영 행위"에 긋습니다.** `DbmsOperator`는 `queryStats()`, `explain()`, `backup()`처럼 운영자가 하는 행위를 선언하고, 기종별 구현체가 각자의 방식으로 채웁니다. 경계를 SQL 문법에 그었다면 SQL이 없는 MongoDB가 들어올 수 없었을 겁니다. 실제로 MongoDB가 같은 인터페이스로 들어온 것이 경계가 맞았다는 증거입니다.

**기술은 적재적소에 쓰고 통일하지 않습니다.** "Operator도 JPA로 통일하면 깔끔하지 않냐"는 질문을 받고 제대로 분석해 봤는데([2편](/blog/project/dbtower/dbtower-2-engines-and-diagnosis)), 결론은 반대였습니다. 대상은 런타임에 등록되는 N개의 동적 데이터소스라 부팅 시점에 고정되는 EntityManager와 안 맞고, 시스템 뷰에는 매핑할 엔티티도 없습니다. 그래서 플랫폼 자기 저장소는 Spring Data JPA, 대상 DB 조회는 JdbcTemplate과 Mongo 드라이버, 스냅샷 대량 쓰기는 JDBC batch입니다. 하나의 ORM으로 통일하는 편함 대신 경로별 비용으로 선택했습니다.

**경계는 빌드가 지킵니다.** 패키지를 Spring Modulith 모듈로 선언하고 모듈 간 순환 의존을 테스트가 빌드에서 실패시킵니다. 도입 첫 실행에서 실제로 순환 2개가 잡혀 의존 역전으로 해소했으니, 규칙이 작동한다는 증거를 도입 당일에 얻은 셈입니다. 모듈은 이후 확장을 거쳐 현재 15개입니다.

**AI 채널은 안전을 구조로 보장합니다.** MCP 서버를 JSON-RPC 2.0 스펙으로 직접 구현해 도구 16종을 노출하되, AI에게는 read-only 도구 화이트리스트만 열어 대상 DB 변경 0을 코드 레벨에서 강제했습니다. 인증(OAuth 2.1·기본 거부 화이트리스트), 외부 발신 SQL 리터럴 마스킹까지 단계별 보안 3겹입니다.

![DBTower 상세 아키텍처. 채널 3종, 모듈 15개, 관제 대상 5기종](/uploads/project/dbtower/architecture-detail.svg)

메타 DB의 단일 권위는 Flyway 마이그레이션이고, 인스턴스 한 행을 지우면 자식 표들이 FK ON DELETE CASCADE로 함께 정리됩니다. 감사 로그만 일부러 FK 없이 남습니다. 기록은 삭제와 무관하게 보존해야 하기 때문입니다.

![Flyway 기준으로 그린 DBTower 메타 DB ERD](/uploads/project/dbtower/erd.svg)

## 4. 규모 가정과 부하 실측

프로젝트를 배포까지만 하고 끝내면 "이게 얼마나 버티나"에 답할 수 없습니다. 그래서 규모를 먼저 가정하고 상한을 실측했습니다.

DBTower는 관제 도구라 실사용 트래픽은 수십 RPS 규모를 예상하고, 단일 노드 셀프호스트 운용을 전제했습니다. 그래도 처리 상한은 배포 전에 알아야 합니다. k6로 10 VU 30초 부하를 걸어 **2,832 req/s, P95 5.86ms, 실패 0**을 확인했습니다(환경: 로컬 Docker, Apple Silicon). 예상 트래픽 대비 충분한 여유이고, 병목은 대상 DB 조회이지 플랫폼 자신이 아니라는 것도 이때 확인했습니다.

## 5. 실증 1: "새 기종 = 구현체 1개"를 검증으로 갚다

설계 문서에 계속 적어온 주장이 있었습니다. "새 기종 추가는 Operator 구현체 1개, 플랫폼 코드 수정 없음." 주장은 검증 전까지 빚이라, 성격이 정반대인 두 기종을 실제로 추가해 갚았습니다([2편](/blog/project/dbtower/dbtower-2-engines-and-diagnosis)). 상용 DB 대표 Oracle과, SQL도 JDBC도 없는 MongoDB였습니다.

결과를 정직하게 세면 이렇습니다. 새로 만든 것은 Operator 구현체 2개와 Mongo 클라이언트 캐시, 기존 수정은 enum 값과 팩토리 case 몇 줄. **스냅샷 수집, 시점 비교, 회귀 감지, 웹 콘솔, MCP는 0줄 수정으로 5기종을 처리했습니다.** 이후 추가한 능력들(Wait Event, 파티션 조회, 레이턴시 백분위, 실제 실행 계획)도 전부 "인터페이스 메서드 1개 추가"의 반복이었습니다. 요행으로 한 번 맞은 결과라면 이렇게 반복될 수 없습니다.

![Wait Events로 그 시간에 무엇을 기다렸나를 보고, 비활성 instrument 범위까지 응답에 명시한 화면](/uploads/project/dbtower/wait-events.png)

## 6. 실증 2: 심층 진단, "인덱스가 있는데 왜 안 타요"에 옵티마이저가 속은 이유까지

실제 진단 흐름 하나를 통째로 보여드리겠습니다([2편](/blog/project/dbtower/dbtower-2-engines-and-diagnosis) 상세).

- **정상 상태**: `code VARCHAR(20)` 컬럼에 B-Tree 인덱스가 있는 테이블. 쿼리만 봐서는 멀쩡해 보입니다.
- **문제 발견**: `WHERE code = 12345`(따옴표 없이 숫자)를 던지면 풀스캔이 됩니다. 현업에서 "인덱스가 있는데 왜 안 타요"로 접수되는 대표 사례입니다. MySQL 비교 규칙상 문자열과 숫자를 비교하면 문자열 쪽이 숫자로 캐스팅되는데, 인덱스 컬럼에 함수를 씌운 것과 같아 B-Tree 정렬을 못 씁니다.
- **원인 분석**: 추정 EXPLAIN만으로는 옵티마이저가 왜 속았는지 안 보입니다. 추정 행수와 실제 행수의 괴리를 봐야 합니다. "실제 실행 계획"을 얻는 방법은 5기종 전부 달라 각각 구현했습니다(EXPLAIN ANALYZE, ANALYZE·BUFFERS, DISPLAY_CURSOR, STATISTICS XML, executionStats). actual rows가 루프당 평균이라 loops를 곱해야 하는 함정은 단위 테스트로 고정했습니다. 구현 중 MySQL 8.4가 문서와 달리 FORMAT=JSON을 거부해 판단 기준 문서를 실측대로 고치기도 했습니다.
- **해결**: 추정 300행 대 실제 1행, **괴리 300배**에서 근본 원인 "암시적 형변환"과 처방까지 지목합니다. 기계적으로 안전한 수정이 가능한 케이스는 수정안 SQL을 만들어 버튼 한 번으로 재진단합니다. 괴리 300배가 없음으로, 풀스캔이 Index lookup으로 바뀌는 것까지 확인하고 끝냅니다.
- **정합성 위험까지 증명**: 수정 전의 "실제 1행"은 사실 `'012345'` 같은 다른 문자열이 캐스팅으로 잘못 매칭된 행이었습니다. 형변환은 성능 문제로 보이지만 실제로는 정확성 문제입니다. 조회면 오답이고, UPDATE나 DELETE였으면 데이터 사고입니다.

![심층 원인 진단. 추정 300행 대 실제 1행, 암시적 형변환 지목과 처방](/uploads/project/dbtower/deep-diagnose.png)

![수정안 원클릭 재진단. 괴리 300배에서 없음으로, 근본원인 1건에서 0건으로](/uploads/project/dbtower/deep-before-after.png)

## 7. 실증 3: 만든 도구를 자기 자신에게 먼저 쓰다

**DBTower 자신을 DBTower의 관리 대상으로 등록했습니다.** 메타 저장소가 PostgreSQL이라 가능했고, 도그푸딩을 염두에 둔 선택이었습니다. 그랬더니 자기 스냅샷 조회 쿼리가 자기 화면의 슬로우 쿼리 목록에 떴습니다(50만 행 적재 상태). 자기 explain API로 진단하니 "Seq Scan 발생, 인덱스를 검토하세요"라고 자기 자신을 지적했고, 실행 시간은 21.269ms였습니다. 등치 조건인 `instance_id`를 선두에 둔 복합 인덱스를 추가하고 같은 API로 재진단하니 "규칙에 걸린 비효율 신호가 없습니다"로 바뀌었고 실행 시간은 0.062ms, **343배**였습니다.

개선을 측정한 도구가 곧 제가 만든 기능이라는 순환, 이게 플랫폼이 실제로 동작한다는 가장 강한 증거입니다.

## 8. 성능 개선 기록 (전부 전후 비교 실측)

전부 개선 전 수치를 먼저 재고, 구조적 원인을 분석하고, 고친 뒤 다시 쟀습니다.

| 문제 | 원인 | 해결 | 전/후 |
|---|---|---|---|
| 수집(폴링)마다 지연 | 매 수집 새 커넥션 생성으로 TCP+인증 핸드셰이크 반복 | 인스턴스별 HikariCP 풀(대상 DB 보호를 위해 max 2) | 47.1 → 11.8ms (4.0배) |
| 스냅샷 대량 저장이 느림 | JPA saveAll이 행별 INSERT 발행 | JDBC batch + reWriteBatchedInserts | 행당 1.51 → 0.11ms (13.8배) |
| 자기 조회가 슬로우 쿼리 | 50만 행 Seq Scan(인덱스 없음) | instance_id 선두 복합 인덱스 | 21.269 → 0.062ms (343배) |
| 긴 쿼리 통계가 하나로 뭉개짐 | max_digest_length 1024에서 digest 절단 | 4096 상향(메모리 영향 계산식 문서화) | side-by-side 재현·해소 |
| 보존 정리가 느리고 블로트 잔존 | 200만 행 벌크 DELETE + dead tuple 404MB | 월별 RANGE 파티셔닝(신테이블→복사→스왑) | DELETE 1.9s → DROP 12.8ms (147배)·블로트 0 |

## 9. 판단과 트레이드오프

성능 개선에는 항상 비용과 트레이드오프가 붙습니다. 그 판단을 남깁니다.

- **데이터 접근 적재적소**: 메타 CRUD는 JPA, 스냅샷 대량 쓰기는 JDBC batch, SQL이 없는 MongoDB는 드라이버 직접. 하나의 ORM으로 통일하는 편함 대신 경로별 비용으로 골랐습니다.
- **p95 세 라벨**: MySQL은 히스토그램을 구간 차분해 실측(누적 0.48ms가 가리던 최근 구간 0.19ms를 노출), PostgreSQL은 평균+1.645σ 추정 표기, 원자료 없는 기종은 UNSUPPORTED. 그럴듯한 단일 숫자보다 소스가 다른 숫자를 섞지 않는 쪽을 택했습니다. 자세한 근거는 [4편](/blog/project/dbtower/dbtower-4-deepening)에 있습니다.
- **최소 권한 계정**: 권한 0 계정으로 시작해, DB가 돌려주는 권한 에러 원문을 수집하며 필요한 것만 추가해 확정했습니다. MongoDB는 커스텀 롤을 만들려다 clusterMonitor가 이미 충분함을 확인했고, PostgreSQL은 pg_monitor 전체가 아니라 pg_read_all_stats로 좁혔습니다. 권한이 부족하면 PostgreSQL이 에러 대신 HTTP 200에 전 행 insufficient privilege를 채워 조용히 저하되는 함정도 이때 실측으로 잡았습니다.
- **Terraform은 validate까지**: 실제 RDS apply는 AWS 자격증명과 과금이 필요해 실행하지 않았고, 문서에 그대로 적었습니다. 같은 등록 흐름의 완주는 K8s(CloudNativePG e2e)와 Ansible(changed=0)에서 확인했습니다. 자세한 프로비저닝 흐름은 [3편](/blog/project/dbtower/dbtower-3-production-safety)에 있습니다.

![같은 p95인데 소스 라벨(실측·직접계산·추정·미지원)이 다른 레이턴시 백분위 화면](/uploads/project/dbtower/latency.png)

## 10. 백업은 복원까지 해봐야 백업이다

백업 정책(주기·보존·검증)은 플랫폼이 추상 수준에서 관리하고, 실행은 기종별 구현체가 각자 지원하는 방식으로 수행합니다. 같은 "FULL 백업" 한 마디가 실제로는 네 가지 실행 모델로 갈라집니다([6편](/blog/project/dbtower/dbtower-6-backup)).

| 실행 모델 | 기종 | 비밀번호 전달 |
|---|---|---|
| 외부 CLI + 환경변수 | MySQL(mysqldump), PostgreSQL(pg_dump) | MYSQL_PWD / PGPASSWORD |
| 외부 CLI + stdin | MongoDB(mongodump) | --config /dev/stdin |
| 서버 사이드 SQL | SQL Server | 필요 없음 (BACKUP DATABASE) |
| 서버 사이드 API | Oracle | 필요 없음 (DBMS_DATAPUMP PL/SQL) |

- **성공 판정은 로그가 아니라 복원**: VERIFIED/FAILED/UNSUPPORTED 3값으로 표기하고, 3-2-1 원칙의 오프사이트 사본(S3 호환)까지 자동화했습니다.
- **정책은 (인스턴스, 타입)별 병행**: 현업 정석인 "FULL 앵커는 드물게 + LOG 체인은 촘촘하게"를 자동 스케줄로 겁니다. 신선도는 앵커 기준이라 LOG 성공이 FULL 실패를 가리지 못합니다.
- **시점 복구는 실행으로 증명**: MSSQL은 STOPAT으로 6행짜리 현재에서 5행짜리 과거를, PostgreSQL은 recovery_target_time으로 목표 시점 직전 정지를 서버 로그로 확인했습니다. 산출물은 AES-256-GCM으로 암호화해 변조가 조용한 오염 대신 명확한 실패가 되게 했습니다.
- **보안 리뷰가 잡아준 것**: 비밀번호에 개행을 넣으면 mongodump 설정의 다른 키를 주입할 수 있는 stdin YAML 주입 구멍을 발견해, 제어 문자를 거부하고 작은따옴표 스칼라 이스케이프로 막은 뒤 주입 시도가 거부되는 것을 테스트로 고정했습니다.

![백업/PITR 카드, 물리(xbstream) 앵커와 복원 가능 창](/uploads/project/dbtower/xtrabackup-physical.png)

## 11. 만든 것을 스스로 감사하고, 전부 고치지는 않았다

기능이 쌓인 뒤 동시성·기종별 정확성·보안·수명주기 네 축으로 코드를 정독하고 OWASP·CWE·벤더 문서와 대조해 결함 20건 이상을 찾았습니다([4편](/blog/project/dbtower/dbtower-4-deepening)).

- **FIX/SKIP 분리**: 전부 고치지 않았습니다. "안 고쳐도 되는 걸 고치는 것도 부채"라서 재검증 후 FIX와 SKIP을 근거와 함께 갈랐습니다(예: MySQL 5.7 비호환은 8.0+ 명시 지원으로 SKIP). 수정에는 신규 단위 테스트 28건.
- **가장 심각한 결함(XXE)**: 데드락·실행계획 XML을 파싱하는 세 곳이 외부 DTD 로드 차단만 걸어놨는데, OWASP가 "불충분"이라 명시한 조합이었습니다. 조작된 XML을 주는 악성 대상 DB가 있으면 DBTower 호스트가 외부로 요청을 날리는 블라인드 SSRF가 가능했습니다. 같은 저장소의 DeepAnalyzer는 이미 DOCTYPE 선언 자체를 거부하도록 올바르게 막고 있었으니, 설계를 몰랐던 게 아니라 나중에 만든 파서에 기준을 안 옮긴 일관성 누락이었습니다. 세 곳을 같은 설정으로 통일하고, XXE 페이로드가 파싱에서 거부되는 것(외부 fetch 없음)을 단위 테스트로 고정했습니다.
- **개선이 만든 부채**: 인스턴스당 풀 max 2에 폴러 8개 이상이 붙자 대기 → 타임아웃 → "죽은 대상" 오인 → 허위 "수집 정지" 경보로 증폭됐습니다. 직전에 성능을 위해 넣은 수집 병렬화가 이 경합을 키웠습니다. 풀 상한을 2에서 6으로 올리고 설정값으로 분리해 차단했습니다. 고친 자리뿐 아니라 그 옆까지 다시 봐야 했습니다.
- **실측이 감사를 이김**: "slow_log는 마이크로초를 저장 안 해 복구 불가"라는 감사 결론을 원본 테이블 실측이 뒤집었습니다(0.6초 쿼리를 600.594ms로 정확 표시). 감사 결론도 실측으로 한 번 더 확인해야 했습니다.

![INNODB STATUS의 최근 1건에서 victim·PRIMARY 인덱스·문장을 잡은 MySQL 데드락 카드](/uploads/project/dbtower/deadlock-mysql.png)

## 12. 관제탑과 대화하기: 알림에서 진단까지 채팅 안에서

경보를 받아도 분석은 콘솔을 따로 열어 처음부터였습니다. 사내 플랫폼 사례의 "알럿 스레드 이모지 → AI 분석 댓글" 루프를 셀프호스트 제약에서 재현하고 싶었습니다([8편](/blog/project/dbtower/dbtower-8-talking-and-lakehouse)).

- **함정**: 웹훅이 쓴 메시지의 본문을 봇이 읽으려면 Discord의 Message Content 특권 인텐트(심사 필요)가 있어야 합니다.
- **해결**: 발송 시점에 message_id를 인스턴스에 매핑해 메타 DB에 영속(재시작 생존 e2e 실측)했습니다. 반응이 오면 조회 한 번으로 대상이 나옵니다. 특권 인텐트 0개로 풀었습니다.
- **정직성이 런타임까지 관통**: 진단 도구가 전부 빈 결과인 죽은 인스턴스 케이스에서, AI 답글이 수집 5단계를 나열하고 "근본원인을 확정하지 못했습니다. 수치를 지어내지 않겠습니다"로 마감했습니다. 판단 기준을 사람이 문서로 정하는 원칙이 런타임 응답까지 관통한다는 증거입니다.
- **인증**: 정적 토큰 대신 OAuth 2.1 브라우저 로그인으로 대체했습니다. MCP 클라이언트가 authorize를 열면 DBTower 로그인 창이 뜨고, 로그인하면 토큰이 자동 발급됩니다.

![알림 embed에 돋보기 반응을 달면 봇이 진단을 시작한다](/uploads/project/dbtower/alert-embed-reaction.png)

![봇의 진단 답글. 근거 다섯 개와 정직한 한계 고지까지 카드 한 장에](/uploads/project/dbtower/bot-diagnosis-reply.png)

## 13. 운영 병목 다섯 곳: 사람 손이 붙던 자리를 끊기

현업 DBA의 병목이 어디에 남는지를 렌즈로, 사람 손이 선형으로 붙던 다섯 지점을 기능으로 끊었습니다([9편](/blog/project/dbtower/dbtower-9-operational-bottlenecks)). 다섯 개 전부 읽고 판정·기록까지가 몫이고, 대상 DB는 바꾸지 않습니다.

- **설정 드리프트 이력**: 파라미터 diff의 공간축("A와 B가 다른가")에 시간축("언제부터 무엇이 바뀌었나")을 붙였습니다. 거울 테이블과 변경 로그로 무변경 주기엔 스냅샷 한 줄만 쌓이게 했고, work_mem 변경을 감지해 카드를 쐈습니다.
- **스키마 변경 리뷰 게이트**: 배포 전 DDL/대량 DML을 규칙으로 판정(락 위험·DEFAULT 없는 NOT NULL·DROP·WHERE 없는 대량 변경)하고, 실제 행수로 락 위험을 확정한 뒤 AI 1차 소견을 붙여 ADMIN 승인·자동 감사까지. 실행은 하지 않고 gh-ost 경로만 안내합니다. 규칙 판정에는 JSqlParser 구문 트리를 씁니다.
- **인덱스 사용 통계 주기 영속 + 인시던트/월간 리포트**: "이 인덱스 지워도 되나"는 재시작 누적 카운터의 순간값으론 못 답합니다. 5기종 스캔 통계를 주기 영속하고, 장애 구간을 주면 시점 비교·설정 변경·플랜 플립·대기·가용성을 한 장으로 재구성하며, 헬스·백업·Advisor·용량·낭비를 매월 자동 발행합니다.

![변경 리뷰 게이트. 락 위험·NOT NULL·실제 행수를 지적하고 AI가 배포 순서·롤백까지 소견, ADMIN 승인/반려](/uploads/project/dbtower/review-gate.png)

![설정 변경 이력. work_mem이 언제 바뀌었는지 시간순으로, "누가"는 대상 DB 감사 로그의 몫이라 미표기](/uploads/project/dbtower/config-drift.png)

## 14. 멀티테넌시와 고가용성 대비

여러 팀이 한 콘솔을 쓰고, 관제탑 자체를 여러 대로 늘리는 국면입니다([7편](/blog/project/dbtower/dbtower-7-multi-tenancy)).

- **팀 경계**: 팀 사용자는 자기 팀 인스턴스와 전역만 보고, 남의 팀 인스턴스는 id로 직접 찔러도 403이 아니라 404를 받습니다(존재 자체를 숨김). 강제 지점은 단 한 곳(RegistryService)입니다.
- **플랫폼 자신의 멀티노드 실측**: 분산 락(ShedLock) 위에 수집 샤딩(샤드별 락)을 얹어 2노드가 일을 나눠 들고, 한 노드를 죽이면 남은 노드가 설정 변경 없이 전 샤드를 인수하는 것을 실측했습니다. 세션과 로그인 잠금 카운터도 메타 DB로 옮겨, 노드를 오가도 상태가 하나입니다.
- **복구선**: 복제 상태와 레플리케이션 슬롯을 수집 체계에 포함해 이중화 상태를 플랫폼에서 바로 관측하고, 백업의 복원 검증 3값과 오프사이트 사본이 가용성의 마지막 방어선입니다.

![페일오버 후 node B가 같은 세션으로 콘솔을 서빙한다](/uploads/project/dbtower/node-b-survivor.png)

## 15. 정직성 설계: 못 하는 것을 못 한다고 말하기

관제 도구의 출력은 누군가의 운영 결정의 입력이 됩니다. 그래서 못 하는 것을 정직하게 표기하는 것이 과장된 능력 표기보다 도구의 신뢰를 만듭니다.

- **정직한 라벨**: 백업 복원 검증은 VERIFIED/FAILED/UNSUPPORTED 3값, p95는 실측·추정·미지원 소스 라벨을 섞지 않습니다. 이상 감지도 관측 8회 미만은 "학습 중"으로 판정을 보류합니다.
- **보호장치**: 진단이 부하가 되지 않게 쿼리 타임아웃 15초·지수 백오프·인스턴스당 풀 max 2. MongoDB는 정석인 드라이버 전역 타임아웃(CSOT)이 심층 진단의 명령별 시간 상한(maxTimeMS)을 덮어쓰는 간섭이라 일부러 배제하고, 이유를 코드 주석으로 남겼습니다.

![digest 포화 위험을 권고와 함께 지적하고 무관한 점검은 미지원으로 정직하게 표기한 Advisors](/uploads/project/dbtower/advisors.png)

## 16. 무엇을 다루는가: 운영 영역별 정리

기능을 운영 영역으로 묶으면 이렇습니다.

| 영역 | DBTower가 하는 것 |
|---|---|
| 성능 진단·튜닝 | 상위 SQL·시점 비교·실행계획 규칙·심층 진단(추정 vs 실제)·원클릭 재진단·인덱스 처방 |
| 모니터링·관측 | 통합 헬스 스코어·Wait Event·복제 상태/슬롯·p95(소스 라벨 분리)·Prometheus/Grafana 연동 |
| 백업·복구 | 5기종 로그 백업·FULL/LOG 병행 정책·복원 자동 검증·실제 PITR·오프사이트 사본 |
| 이상·회귀 대응 | 요일×시간대 z-score 이상 감지·회귀 자동 감지·플랜 플립(60초)·인시던트 리포트 |
| 변경 관리 | 설정 드리프트 이력·스키마 변경 리뷰 게이트(규칙+AI+승인)·감사 로그 |
| 용량·비용 | 디스크 포화 예측(잔량 아닌 속도)·FinOps 미사용 인덱스 신호·월간 점검 리포트 |
| 보안·거버넌스 | 최소 권한 계정·인증/인가·팀 스코프(LBAC)·비밀번호 암호화·API 토큰 |
| 신뢰성(SRE) | SLO/에러 버짓·멀티노드 수집 샤딩·페일오버 실측·셀프호스트 배포 |

## 17. 대표 수치

| 항목 | 수치 |
|---|---|
| 새 기종 추가 비용 | Operator 구현체 추가만으로 핵심 파이프라인 0줄 수정 |
| 시점 비교·회귀 감지 | 호출량 +461% · 읽은 행수 +852% · 신규 쿼리 검출, 같은 비교를 폴러가 자동 실행 |
| 플랜 플립 감지 | 인덱스 드랍을 다음 폴링 주기(60초)에 감지, 동반 레이턴시 회귀 +23,249%(PG e2e, 계획 shape 획득은 5기종) |
| 심층 진단 | 추정 300행 vs 실제 1행 괴리 → 형변환 지목 → 원클릭 재진단 before/after |
| 성능 개선 | HikariCP 4.0배 · JDBC batch 13.8배 · 자기 진단 343배 |
| 부하 상한 | k6 10 VU 30초에서 2,832 req/s, P95 5.86ms, 실패 0 |
| 품질 | 테스트 515건 CI 게이트 · VERIFICATION 117절 · 자체 감사 결함 20+건 FIX/SKIP |
| 백업·복구 | 5기종 로그 백업 + 병행 정책 · PITR 실제 복원 2기종 · AES-256-GCM |
| 배포 | GHCR 멀티아치(amd64+arm64) 공개, 원커맨드 셀프호스트 |

## 18. Lessons Learned: 밟은 지뢰들

- 추상화 경계는 기술(SQL)이 아니라 도메인 행위에 그어야 이기종이 들어옵니다. 경계가 맞는지는 문서로는 알 수 없고, 정반대 성격의 구현체를 실제로 추가해 봐야 증명됩니다.
- 관제 도구의 출력은 누군가의 운영 결정의 입력이 됩니다. 못 하는 것을 UNSUPPORTED로 정직하게 표기하는 쪽이 과장된 능력 표기보다 도구의 신뢰를 만듭니다.
- 진단 기능은 그 자체가 대상에 주는 부하까지 설계 범위입니다. "측정이 대상을 바꾸면 안 된다"는 감각을 타임아웃·백오프·풀 상한으로 코드에 새겼습니다.
- 성능을 위한 병렬화가 풀 경합을 되살렸습니다. 고친 자리뿐 아니라 그 옆까지 다시 봐야 했습니다.
- 문서와 감사와 단위 테스트가 놓치는 것을 실측과 실화면이 잡습니다. 그래서 기록 117개 절이 전부 명령과 출력이 담긴 재현 로그입니다.

## 19. 시리즈 지도: 더 깊이 읽기

이 글은 시리즈 아홉 편(1~9편)의 지도이기도 합니다.

- **[1편, 설계와 추상화](/blog/project/dbtower/dbtower-1-design)**: 경계를 운영 행위에 긋고, "30분 백업" 한 줄이 세 갈래로 갈라지는 걸 인터페이스로 받아내고, 회귀 감지를 플랫폼에 맡기기
- **[2편, 다섯 기종과 심층 진단](/blog/project/dbtower/dbtower-2-engines-and-diagnosis)**: 채널 세 겹(웹·MCP·AI), "새 기종 = 구현체 1개" 실측, 대기 이벤트와 적재적소, 추정 대 실제 괴리까지
- **[3편, 프로덕션과 셀프호스트](/blog/project/dbtower/dbtower-3-production-safety)**: 준비도 감사와 안전 장치, IaC 프로비저닝, 타임아웃·백오프 가드레일과 원커맨드 셀프호스트
- **[4편, 심화와 하드닝](/blog/project/dbtower/dbtower-4-deepening)**: 플랜 플립을 다섯 기종으로, p95 정직 등급, 데드락 축, 스케일 제어, 스스로 감사하고 스스로 고치기
- **[5편, 프로덕션화와 화면 패리티](/blog/project/dbtower/dbtower-5-productionization)**: 남이 쓸 수 있게 만드는 계단, 문의에 스키마 붙이기, 화면을 레퍼런스와 옆에 놓고 대조
- **[6편, 정석 백업](/blog/project/dbtower/dbtower-6-backup)**: FULL 앵커와 LOG 체인이 독립 주기로 돌고, 복원까지 해봐야 백업
- **[7편, 멀티테넌시와 호스트 차원](/blog/project/dbtower/dbtower-7-multi-tenancy)**: 멀티유저에서 멀티노드로, 상태는 어느 한 노드에 있으면 안 되고, 디스크의 미래를 속도로 읽기
- **[8편, 관제탑 대화와 레이크하우스](/blog/project/dbtower/dbtower-8-talking-and-lakehouse)**: 알림이 카드가 되고 이모지가 진단을 부르고, lakehouse가 계산한 "평소"로 오탐을 줄이기
- **[9편, 운영 병목 다섯 곳](/blog/project/dbtower/dbtower-9-operational-bottlenecks)**: 설정 드리프트·변경 리뷰 게이트·인덱스 분기 판정·인시던트 리포트·월간 점검

바쁘신 분께는 세 편을 권합니다. 설계 결정의 뿌리인 [1편](/blog/project/dbtower/dbtower-1-design), 진단의 끝까지 간 [2편](/blog/project/dbtower/dbtower-2-engines-and-diagnosis), 백업이 진짜가 되는 [6편](/blog/project/dbtower/dbtower-6-backup)입니다.

## 20. 마치며

관통하는 원칙은 하나입니다. 소비자 차이는 채널 뒤로, 기종 차이는 `DbmsOperator` 뒤로, 기술 차이는 각자의 제자리로 숨기고, 대상 DB는 읽기만 하되 판단 기준은 사람이 문서로 정합니다. 그 위에서 AI는 판단자가 아니라 1차 분석기로만 움직입니다.

코드와 재현 기록 전체는 [GitHub](https://github.com/dj258255/dbtower)에 있고, GHCR 공개 이미지를 받아 compose 한 번이면 직접 띄워 볼 수 있습니다.

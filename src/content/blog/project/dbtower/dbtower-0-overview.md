---
title: 'DBTower 포트폴리오 총정리: 이기종 DBMS 5기종을 인터페이스 하나로 관제하기까지, 실측 98절'
titleEn: 'DBTower Portfolio: Five DBMS Engines Under One Interface, Told in 98 Sections of Measured Evidence'
description: 'MySQL, PostgreSQL, SQL Server, Oracle, MongoDB를 하나의 관제탑에서 등록하고 진단하고 백업하고 자율 감시하는 컨트롤 플레인 DBTower의 포트폴리오 총정리입니다. 도구 파편화와 DBA 반복 문의라는 문제 정의에서 출발해, 추상화 경계를 SQL 대신 "운영 행위"에 그은 설계 결정과 그 실증(새 기종 추가는 구현체 1개, 코어 경로 수정 0줄)을 발표 흐름으로 정리했습니다. 자기 자신을 관리 대상으로 등록해 자기 풀스캔을 잡은 도그푸딩(21.269ms에서 0.062ms로), 따옴표 하나로 인덱스가 죽는 암시적 형변환을 추정 대 실제 괴리 300배로 지목하는 심층 진단, FULL 앵커와 LOG 체인이 병행하는 정석 백업과 시점 복구 실증, 알림에 이모지를 달면 AI가 진단 답글을 붙이는 Discord 루프까지. 모든 수치는 측정 조건과 함께 적었고 재현 기록 98개 절이 저장소에 있습니다.'
descriptionEn: 'The portfolio overview of DBTower, a control plane that registers, diagnoses, backs up, and autonomously watches MySQL, PostgreSQL, SQL Server, Oracle, and MongoDB from one tower. It starts with the problem definition of tool fragmentation and repeated DBA inquiries, then covers the design decision to draw the abstraction boundary at operational actions rather than SQL, verified by adding new engines as single operator implementations with zero changes to core paths. It also covers dogfooding that caught the platform''s own full scan (21.269ms to 0.062ms), deep diagnosis that pinpoints implicit type conversion from a 300x estimated-vs-actual row gap, orthodox backups where FULL anchors and LOG chains run on independent schedules with point-in-time restores actually executed, and a Discord loop where reacting to an alert makes AI post a diagnosis reply. Every number carries its measurement conditions, and 98 sections of reproduction logs live in the repository.'
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

## 0. 프로젝트 한 장 요약

**DBTower는 서로 다른 DBMS 5기종(MySQL, PostgreSQL, SQL Server, Oracle, MongoDB)의 운영을 인터페이스 하나(`DbmsOperator`) 뒤에서 처리하는 컨트롤 플레인입니다.** 등록부터 진단, 백업, 자율 감시까지가 한 화면에서 끝납니다.

- 기간: 2026.03 ~ 2026.07, 개인 프로젝트(기여 100%)
- 스택: Java 21, Spring Boot, PostgreSQL(메타 저장소), Spring Modulith(모듈 14개), MCP(JSON-RPC 2.0 직접 구현), Flyway, ShedLock, Docker, k6
- 코드와 재현 기록: [GitHub](https://github.com/dj258255/dbtower), [VERIFICATION.md 98개 절](https://github.com/dj258255/dbtower/blob/main/docs/VERIFICATION.md), GHCR 공개 이미지(원커맨드 셀프호스트)
- 측정 환경: 로컬 Docker(Apple Silicon) 위 대상 DB 5기종. 모든 성능 수치는 개선 전을 먼저 재고 고친 뒤 다시 잰 전후 실측입니다

숫자부터 놓고 시작하겠습니다.

| 항목 | 수치 |
|---|---|
| 관리 기종 | 5기종 (SQL도 JDBC도 없는 MongoDB 포함) |
| 새 기종 추가 비용 | Operator 구현체 1개. 코어 경로(수집, 비교, 회귀 감지, 웹, MCP) 수정 0줄 실측 |
| 성능 개선 | 수집 4.0배(47.1에서 11.8ms), 저장 13.8배(행당 1.51에서 0.11ms), 조회 343배(21.269에서 0.062ms) |
| 부하 상한 | k6 10 VU 30초에서 2,832 req/s, P95 5.86ms, 실패 0 |
| 보존 정리 | 월별 파티셔닝 전환으로 200만 행 DELETE 1.9초가 파티션 DROP 12.8ms로 (147배, 블로트 0) |
| 테스트와 기록 | 478건 CI 게이트, VERIFICATION 98개 절, 자체 감사 결함 20건 이상 FIX/SKIP 분리 |
| 배포 | GHCR 멀티아치 공개, compose 한 번이면 뜨는 셀프호스트 |

## 1. 문제 정의: 지금의 DB 이슈 대응은 이렇게 흘러갑니다

DB에 이슈가 나면 개발자는 지표가 흩어진 도구들을 오갑니다.

```
이슈 발생 -> CPU는 모니터링 대시보드, 쿼리 통계는 기종마다 다른 시스템 뷰,
             실행계획은 각 DB 콘솔
          -> 어제와 오늘을 사람이 눈으로 비교
          -> 원인을 못 찾으면 결국 DBA에게 문의
          -> DBA는 같은 질문에 반복해서 답변
```

관리 대상 DB가 늘수록 사람 손이 선형으로 늘어나는 구조입니다. 이 문제는 제가 지어낸 것이 아니고, 업계가 이미 정의해 둔 문제입니다. 국내 대형 서비스 기업들이 사내 DB 플랫폼을 직접 만들어 운영하는 이유였고, AWS가 인프라 메트릭(CloudWatch) 위에 쿼리 수준 분석(RDS Performance Insights)을 별도 층으로 얹은 이유이기도 합니다. 저는 그 문제 정의를 출발점으로 핵심 메커니즘을 직접 구현하기로 했습니다.

범위 결정 하나가 중요했습니다. 메트릭 층(exporter, Prometheus, Grafana)은 이미 검증된 스택이라 다시 만들지 않고 그대로 씁니다. DBTower가 맡는 건 그 위의 층, "그 시각에 어떤 쿼리가 원인이고, 실행계획이 왜 나쁘고, 무엇을 해야 하나"입니다. 이미 잘 푼 문제를 다시 푸는 건 열정처럼 보여도 낭비라고 판단했습니다.

## 2. 목표와 해법의 모양

목표는 두 줄입니다.

- 개발자가 DBA 문의 없이도 스스로 DB 이슈를 분석할 수 있게 한다
- 개발팀과 DB팀이 다섯 기종을 하나의 툴, 같은 화면, 같은 용어로 본다

해법은 진단 3단계가 한 플랫폼 안에서 이어지는 구조입니다.

```
1. 문제 쿼리 식별            2. 원인 분석                3. DB팀 문의
--------------------        --------------------        --------------------
상위 SQL (Load 순)           실행계획 (EXPLAIN)           문의 발송 (Discord 카드)
시점 비교 (증감, NEW)         테이블 스키마와 통계          쿼리, 플랜, 분석 자동 첨부
그래프 드래그 구간 선택        규칙 기반 비효율 지적         알림 스레드에서 AI 재진단
모니터링 지표 통합            AI 1차 분석
```

![다섯 기종 여섯 인스턴스가 같은 카드, 같은 그래프, 같은 진단으로 뜨는 대시보드](/uploads/project/dbtower/dashboard.png)

## 3. 설계 결정: 경계를 어디에 긋는가

이기종 플랫폼의 본질은 추상화 경계의 위치 선정입니다. 같은 "쿼리 통계"가 기종마다 소스가 다르고(performance_schema, pg_stat_statements, DMV, V$SQL, system.profile), 같은 "백업"이 실행 모델부터 다릅니다.

![DBTower 전체 구조. 소비자 차이는 채널 뒤로, 기종 차이는 DbmsOperator 뒤로, 기술 차이는 각자의 제자리로](/uploads/project/dbtower/architecture-full.svg)

결정은 세 겹입니다.

**경계는 SQL 대신 "운영 행위"에 긋습니다.** `DbmsOperator`는 `queryStats()`, `explain()`, `backup()`처럼 운영자가 하는 행위를 선언하고, 기종별 구현체가 각자의 방식으로 채웁니다. 경계를 SQL에 그었다면 SQL이 없는 MongoDB가 들어올 수 없었을 겁니다.

**기술은 적재적소에 쓰고 통일하지 않습니다.** "Operator도 JPA로 통일하면 깔끔하지 않냐"는 질문을 받고 제대로 분석해 봤는데([6편](/blog/project/dbtower/dbtower-6-wait-events-and-right-tool)), 결론은 반대였습니다. 대상은 런타임에 등록되는 N개의 동적 데이터소스라 부팅 시점에 고정되는 EntityManager와 안 맞고, 시스템 뷰에는 매핑할 엔티티도 없습니다. 그래서 플랫폼 자기 저장소는 Spring Data JPA, 대상 DB 조회는 JdbcTemplate과 Mongo 드라이버, 스냅샷 대량 쓰기는 JDBC batch입니다. 각 도구가 제일 잘하는 자리에 있는 것, 그게 이 프로젝트가 일관되게 내놓은 답입니다.

**경계는 빌드가 지킵니다.** 패키지를 Spring Modulith 모듈로 선언하고 모듈 간 순환 의존을 테스트가 빌드에서 실패시킵니다. 도입 첫 실행에서 실제로 순환 2개가 잡혀 의존 역전으로 해소했으니, 규칙이 작동한다는 증거를 도입 당일에 얻은 셈입니다. 모듈은 이후 확장을 거쳐 현재 14개입니다.

![DBTower 상세 아키텍처. 채널 3종, 모듈 14개, 관제 대상 5기종](/uploads/project/dbtower/architecture-detail.svg)

메타 DB의 단일 권위는 Flyway 마이그레이션이고, 인스턴스 한 행을 지우면 자식 표들이 FK ON DELETE CASCADE로 함께 정리됩니다. 감사 로그만 일부러 FK 없이 남습니다. 기록은 삭제와 무관하게 보존해야 하기 때문입니다.

![Flyway 기준으로 그린 DBTower 메타 DB ERD](/uploads/project/dbtower/erd.svg)

## 4. 실증 1: "새 기종 = 구현체 1개"를 검증으로 갚다

설계 문서에 계속 적어온 주장이 있었습니다. "새 기종 추가는 Operator 구현체 1개, 플랫폼 코드 수정 없음." 주장은 검증 전까지 빚이라, 성격이 정반대인 두 기종을 실제로 추가해 갚았습니다([4편](/blog/project/dbtower/dbtower-4-five-engines)). 상용 DB의 대표 Oracle과, SQL도 JDBC도 없는 MongoDB였습니다.

결과를 정직하게 세면 이렇습니다. 새로 만든 것은 Operator 구현체 2개와 Mongo 클라이언트 캐시, 기존 수정은 enum 값과 팩토리 case 몇 줄. **스냅샷 수집, 시점 비교, 회귀 감지, 웹 콘솔, MCP는 0줄 수정으로 5기종을 처리했습니다.** 이후 추가한 능력들(Wait Event, 파티션 조회, 레이턴시 백분위, 실제 실행 계획)도 전부 "인터페이스 메서드 1개 추가"의 반복이었습니다. 요행으로 한 번 맞은 결과라면 이렇게 반복될 수 없습니다.

## 5. 실증 2: 심층 진단, "인덱스가 있는데 왜 안 타요?"

실제 진단 흐름 하나를 통째로 보여드리겠습니다([8편](/blog/project/dbtower/dbtower-8-diagnosis) 상세).

`code VARCHAR(20)` 컬럼에 B-Tree 인덱스가 있는 테이블에서, `WHERE code = 12345`(따옴표 없이 숫자)를 던지면 풀스캔이 됩니다. 쿼리만 봐서는 멀쩡해 보여서 현업에서 "인덱스가 있는데 왜 안 타요?"로 접수되는 대표 사례입니다. MySQL 비교 규칙상 문자열과 숫자를 비교하면 문자열 쪽이 숫자로 캐스팅되는데, 인덱스 컬럼에 함수를 씌운 것과 같아 B-Tree 정렬을 못 씁니다. 더 무서운 건 정합성입니다. `'012345'` 같은 다른 문자열까지 같은 숫자로 매칭되니 조회면 오답이고 UPDATE나 DELETE였으면 데이터 사고입니다.

추정 EXPLAIN만으로는 옵티마이저가 왜 속았는지 보이지 않아서, 추정 행수와 실제 행수의 괴리를 봐야 합니다. "실제 실행 계획"을 얻는 방법은 5기종 전부 달랐고(EXPLAIN ANALYZE, ANALYZE·BUFFERS, DISPLAY_CURSOR, STATISTICS XML, executionStats), 구현 중 MySQL 8.4가 문서와 달리 FORMAT=JSON을 거부해 판단 기준 문서를 실측대로 고쳤습니다.

![심층 원인 진단. 추정 300행 대 실제 1행, 암시적 형변환 지목과 처방](/uploads/project/dbtower/deep-diagnose.png)

결과 화면이 위와 같습니다. 괴리 300배에서 근본 원인 "암시적 형변환"과 처방까지 지목하고, 기계적으로 안전한 수정이 가능한 케이스는 수정안 SQL을 만들어 버튼 한 번으로 재진단합니다. 괴리 300배가 없음으로, 풀스캔이 Index lookup으로 바뀌는 것까지 확인하고 끝납니다.

![수정안 원클릭 재진단. 괴리 300배에서 없음으로, 근본원인 1건에서 0건으로](/uploads/project/dbtower/deep-before-after.png)

## 6. 실증 3: 만든 도구를 자기 자신에게 먼저 쓰다

**DBTower 자신을 DBTower의 관리 대상으로 등록했습니다.** 메타 저장소가 PostgreSQL이라 가능했고, 도그푸딩을 염두에 둔 선택이었습니다. 그랬더니 자기 스냅샷 조회 쿼리가 자기 화면의 슬로우 쿼리 목록에 떴습니다. 자기 explain API로 진단하니 50만 행 Seq Scan. 등치 조건 컬럼을 선두로 한 복합 인덱스를 걸고 같은 API로 재측정해 21.269ms에서 0.062ms, 343배를 확인했습니다. 개선을 측정한 도구가 곧 내가 만든 기능이라는 순환이 이 플랫폼이 실제로 동작한다는 가장 강한 증거라고 생각합니다.

성능 개선 다섯 아크를 표로 모으면 이렇습니다. 전부 개선 전 수치를 먼저 재고, 원인을 분석하고, 고친 뒤 다시 쟀습니다.

| # | 문제 | 원인 분석 | 개선 | 실측 (로컬 Docker) |
|---|---|---|---|---|
| 1 | 수집마다 지연 | 매 수집 새 커넥션으로 핸드셰이크 반복 | 인스턴스별 HikariCP 풀 | 47.1에서 11.8ms (4.0배) |
| 2 | 대량 저장 느림 | JPA saveAll이 행별 INSERT | JDBC batch + reWriteBatchedInserts | 행당 1.51에서 0.11ms (13.8배) |
| 3 | 자기 조회 지연 | 50만 행 Seq Scan | 복합 인덱스(등치 컬럼 선두) | 21.269에서 0.062ms (343배) |
| 4 | 긴 쿼리 통계 병합 | digest 길이 1024 절단 | max_digest_length 4096 | side-by-side 재현과 해소 |
| 5 | 보존 정리 부하 | 200만 행 벌크 DELETE와 블로트 404MB | 월별 RANGE 파티셔닝 | DELETE 1.9초가 DROP 12.8ms로 (147배, 블로트 0) |

부하 상한도 실측해 뒀습니다. 관제 도구라 실사용은 수십 RPS면 충분하지만 "충분할 것"과 "상한을 안다"는 다른 문제라서, k6 10 VU 30초에서 2,832 req/s, P95 5.86ms, 실패 0을 확인했습니다.

## 7. 실증 4: 백업은 복원까지 해봐야 백업이다

백업 축은 "기능이 있다"와 "복구가 된다"의 간극을 메우는 데 공을 들였습니다([15편](/blog/project/dbtower/dbtower-15-backup) 상세).

- 로그 백업을 5기종 전부로 넓혔습니다(binlog, WAL, BACKUP LOG, oplog, 아카이브 로그). "기종이 못 하는 것"과 "하다가 깨진 것"을 UNSUPPORTED와 FAILED로 구분해 기록합니다
- 시점 복구 안내문을 생성하는 데서 멈추지 않았습니다. SQL Server에서 6행짜리 현재로부터 5행짜리 과거를 STOPAT으로 실제 복원했고, PostgreSQL도 물리 백업 위에 recovery_target_time으로 목표 시점 직전 정지를 서버 로그로 확인했습니다
- Mongo oplog는 증분으로 전환하며 일부러 한 건을 겹쳐 받게 했습니다($gte). 이번 산출물의 첫 엔트리가 직전 마커와 일치하면 그 겹침 자체가 체인에 구멍이 없다는 물증이 됩니다. 산출물은 28분의 1로 줄었습니다
- 산출물 암호화는 AES-256-GCM입니다. GCM 태그 검증이 복호에 포함되니 변조된 백업은 조용히 오염되는 대신 명확히 실패합니다
- 정책은 (인스턴스, 타입)별 병행입니다. 현업 정석인 "FULL 앵커는 드물게, LOG 체인은 촘촘하게"를 자동 스케줄로 걸 수 있고, 신선도는 앵커 기준이라 LOG 성공이 FULL 실패를 가리지 못합니다

## 8. 관제탑과 대화하기: 알림에서 진단까지 채팅 안에서

경보는 받는 데서 끝나지 않고 그 자리에서 진단으로 이어집니다([18편](/blog/project/dbtower/dbtower-18-talking-tower) 상세).

```
회귀/이상 감지 -> Discord 리치 embed 알림 (심각도 색, 담당 팀, AI 1차 분석, 진단 딥링크)
             -> 알림에 돋보기 이모지 반응
             -> 봇이 대상 인스턴스를 식별 (발송 시점 message_id 매핑, 메타 DB 영속)
             -> AI가 read-only 도구를 연쇄 호출해 근거 수집
             -> 원 알림의 답글로 진단 카드 게시
```

![알림 embed에 돋보기 반응을 달면 봇이 진단을 시작한다](/uploads/project/dbtower/alert-embed-reaction.png)

![봇의 진단 답글. 근거 다섯 개와 정직한 한계 고지까지 카드 한 장에](/uploads/project/dbtower/bot-diagnosis-reply.png)

이 루프에서 제가 제일 아끼는 실측은 실패 케이스입니다. 대상 DB가 죽어 있어 도구가 전부 빈 결과를 돌려주자, AI 답글이 수집 5단계를 투명하게 나열하고 "수치를 지어내지 않겠습니다"로 마감했습니다. AI를 판단자가 아니라 1차 분석기로 묶고(판단 기준은 사람이 문서로 정해 시스템 프롬프트에 주입), 도구는 read-only 화이트리스트만 여는 원칙이 런타임 응답까지 관통한다는 증거였습니다. MCP 서버 자체는 SDK 없이 JSON-RPC 2.0을 직접 구현했고, 인증은 정적 토큰을 OAuth 2.1 브라우저 로그인으로 대체했습니다.

## 9. 정직성 설계: 못 하는 것을 못 한다고 말하기

이 프로젝트에서 기능만큼 공들인 게 "못 하는 것의 표기"입니다. 관제 도구의 출력은 운영 결정의 입력이 되기 때문입니다.

- 백업 복원 검증은 VERIFIED, FAILED, UNSUPPORTED 3값입니다. Oracle처럼 자동 검증 수단이 없는 경우를 통과로 위장하면 사용자는 검증 안 된 백업을 믿게 됩니다
- 레이턴시 p95는 소스 라벨(실측, 직접 계산, 추정, 미지원)을 섞지 않습니다
- 이상 감지는 관측이 부족한 버킷을 "학습 중"으로 보류하고 판정하지 않습니다
- FinOps는 미사용 인덱스 신호까지만 냅니다. 절감액 달러는 환경마다 달라 찍는 순간 지어낸 숫자가 됩니다
- Terraform은 validate까지 확인했고 apply는 AWS 과금이 필요해 실행하지 않았다고 그대로 적었습니다

같은 결의 보호장치도 있습니다. 진단이 대상의 부하가 되면 본말전도라서 쿼리 타임아웃, 지수 백오프, 인스턴스당 풀 상한을 걸었고, MongoDB에서는 정석인 전역 타임아웃(CSOT)이 명령별 상한(maxTimeMS)을 덮어쓰는 간섭을 실측으로 확인해 일부러 배제하고 이유를 주석으로 남겼습니다. 정석을 아는 것과 정석이 내 맥락에 맞는지 판단하는 건 다른 일이었습니다.

## 10. Lessons Learned: 밟은 지뢰들

돌아보면 배움은 대부분 함정에서 왔습니다. 대표 다섯 개만 추리면 이렇습니다.

| 함정 | 무엇이 벌어졌나 | 어떻게 잡았나 |
|---|---|---|
| digest 절단 | 앞부분이 같은 긴 쿼리들이 한 통계로 병합 | max_digest_length 1024와 4096을 side-by-side로 재현해 해소, 메모리 영향 계산식까지 문서화 |
| Prepared Statement 사각 | PS 워크로드가 Top Query에서 익명 부하가 됨 | 데모로 실측 입증 후 Advisor 경고와 원문 보완 소스 노출 |
| 프론트와 서버의 9시간 스큐 | 브라우저 벽시계를 UTC로 읽어 미래의 빈 구간을 조회 | "선을 넘는 시각은 UTC, 눈에 닿는 시각은 로컬" 규칙으로 정리 |
| 진단이 하트비트를 굶김 | 분 단위 진단이 봇의 하트비트 스레드를 점유해 연결이 반복 종료 | 진단 전용 워커 분리, 수정 후 재접속 0회 실측 |
| 콘솔 진입 회귀 | MCP 카드의 401이 로그인 리다이렉트를 유발해 로그인한 사용자가 계속 튕김 | 화면을 실제로 열어보는 검증에서 발견, API 검증만으로는 못 잡는 종류였음 |

관통하는 교훈은 하나입니다. 문서와 감사와 단위 테스트가 놓치는 것을 실측과 실화면이 잡습니다. 그래서 기록 98개 절이 전부 명령과 출력이 담긴 재현 로그입니다.

## 11. DBA 직무 지도로 본 커버리지

DBMS 운영의 전통적 직무 축에 이 도구를 대보면, "하는 것"만큼 "안 하는 것과 그 이유"가 이 프로젝트의 성격을 보여줍니다.

| 직무 축 | 하는 것 | 위임 또는 범위 밖 (이유) |
|---|---|---|
| 설치와 프로비저닝 | 생성 즉시 멱등 등록으로 관제 편입 (K8s, Ansible, Terraform e2e) | 생성 자체는 IaC의 몫, 잘 푼 문제를 다시 풀지 않음 |
| 패치와 업그레이드 | 버전 가시화, 패치 전후 드리프트와 시점 비교 검증 | 패치 실행은 플랫폼별 도구의 영역 |
| 장애조치 | 감지에서 원인 분석, 수동 개입(kill)까지 | 자동 페일오버는 HA 소유자 몫, 관제가 개입하면 스플릿 브레인 위험 |
| 백업과 복구 | 병행 정책, 복원 검증 3값, 오프사이트, 암호화, 신선도 감시로 3-2-1 완성 | 대상 서버 구성이 필요한 완전 자동 PITR 오케스트레이션 |
| 오브젝트 관리 | 스키마와 파티션과 인덱스의 조회, 비교, 조언, 온라인 DDL(dry-run 기본) | 자동 인덱스 생성은 범위 밖 |
| 용량 관리 | 디스크 포화 예측(속도 기반 ETA), 크기 상위, 자체 보존 정책 | OS 디스크 시계열은 메트릭 층 위임 |
| 모니터링과 튜닝 | 본진, 이 글의 4번부터 8번 절 전부 | 해당 없음 |

한 줄로 요약하면 이렇습니다. **읽고 판단하는 것은 깊게, 대상을 바꾸는 것은 최소한으로, 바꾸는 주체가 따로 있는 일은 그 주체와 잇는다.**

## 12. 시리즈 지도: 더 깊이 읽기

이 글은 시리즈 18편의 지도이기도 합니다. 여섯 아크로 묶입니다.

- **설계와 추상화** ([1](/blog/project/dbtower/dbtower-1-why-and-design), [2](/blog/project/dbtower/dbtower-2-abstraction-and-regression), [3](/blog/project/dbtower/dbtower-3-channels-web-mcp-ai)편): 경계를 운영 행위에 긋고, 코어 하나에 채널만 갈아끼우기
- **5기종 증명과 진단 심화** ([4](/blog/project/dbtower/dbtower-4-five-engines), [6](/blog/project/dbtower/dbtower-6-wait-events-and-right-tool), [8](/blog/project/dbtower/dbtower-8-diagnosis)편): "새 기종 = 구현체 1개"의 실측부터 추정 대 실제 괴리까지
- **프로덕션과 셀프호스트** ([5](/blog/project/dbtower/dbtower-5-production-safety), [7](/blog/project/dbtower/dbtower-7-provisioning), [9](/blog/project/dbtower/dbtower-9-guardrails-and-selfhost), [13](/blog/project/dbtower/dbtower-13-productionization), [14](/blog/project/dbtower/dbtower-14-screen-parity)편)
- **심화와 하드닝** ([10](/blog/project/dbtower/dbtower-10-deepening), [11](/blog/project/dbtower/dbtower-11-deepening-four-arcs), [12](/blog/project/dbtower/dbtower-12-hardening-arc)편): 스스로 감사하고 스스로 고치기
- **백업과 스케일** ([15](/blog/project/dbtower/dbtower-15-backup), [16](/blog/project/dbtower/dbtower-16-multi), [17](/blog/project/dbtower/dbtower-17-host-dimension)편): 백업 대장정, 멀티유저에서 멀티노드로, 디스크의 미래
- **채널과 AI 루프** ([18](/blog/project/dbtower/dbtower-18-talking-tower)편): 알림이 카드가 되고 이모지가 진단을 부르기까지

바쁘신 분께는 세 편을 권합니다. 설계 결정의 뿌리인 [1편](/blog/project/dbtower/dbtower-1-why-and-design), 진단의 끝까지 간 [8편](/blog/project/dbtower/dbtower-8-diagnosis), 백업이 진짜가 되는 [15편](/blog/project/dbtower/dbtower-15-backup)입니다.

## 13. 마치며

이 프로젝트를 관통한 문장은 셋입니다.

1. **차이는 경계 뒤로.** 기종 차이는 인터페이스 뒤로, 소비자 차이는 채널 뒤로, 기술 차이는 각자의 제자리로 보냅니다
2. **주장은 실측으로.** 확장성 주장은 기종을 실제로 추가해서, 성능 주장은 전후 측정으로, 능력 표기는 안 되는 것의 명시로 증명했습니다
3. **관제 도구를 완성하는 건 신뢰입니다.** 마지막에 공들인 기능들이 "내가 부하가 되지 않는 장치"와 "못 하는 것의 정직한 표기"였고, 제품화의 첫 결정이 "비밀은 사용자 인프라를 떠나지 않는다"였습니다

전 과정의 상세는 시리즈 [1편](/blog/project/dbtower/dbtower-1-why-and-design)부터 [18편](/blog/project/dbtower/dbtower-18-talking-tower)까지에, 재현 가능한 기록은 [GitHub](https://github.com/dj258255/dbtower)에 있습니다. GHCR 이미지를 받아 셀프호스트로 직접 띄워보실 수 있습니다.

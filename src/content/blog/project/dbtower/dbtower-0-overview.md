---
title: 'DBTower 총정리 — 5기종 DBMS, 인터페이스 1개, 실측 52절'
titleEn: 'DBTower, the Complete Story — Five DBMS Engines, One Interface, 52 Sections of Measured Evidence'
description: "MySQL·PostgreSQL·SQL Server·Oracle·MongoDB를 하나의 관제탑에서 등록·진단·백업·자율 감시하는 컨트롤 플레인 DBTower의 전체 기록을 한 편에 정리합니다. 문제 정의(도구 파편화와 DBA 반복 문의)에서 시작해, 추상화 경계를 SQL이 아니라 '운영 행위'에 그은 설계 결정과 그 검증(새 기종 추가 = 구현체 1개, 플랫폼 코드 0줄 수정 실측), 자기 자신을 관리 대상으로 등록해 자기 풀스캔을 잡은 도그푸딩(21.269ms→0.062ms), 따옴표 하나로 인덱스가 죽는 암시적 형변환을 실제 실행 계획의 추정 vs 실제 괴리로 지목하는 심층 진단, '진단이 부하 유발자가 되면 안 된다'는 보호장치의 트레이드오프, 못 하는 것을 UNSUPPORTED로 표기하는 정직성 설계, AI를 판단자가 아니라 1차 분석기로 묶는 안전 장치(read-only 도구 화이트리스트), 그리고 비용 관점과 남은 한계까지 — 모든 수치는 직접 측정했고 재현 기록 52절이 저장소에 있습니다."
descriptionEn: "The complete story of DBTower, a control plane that registers, diagnoses, backs up, and autonomously watches MySQL, PostgreSQL, SQL Server, Oracle, and MongoDB from one tower. From problem definition (tool fragmentation and repeated DBA inquiries) through the design decision to draw the abstraction boundary at 'operational actions' rather than SQL — verified by adding new engines with zero platform-code changes — dogfooding that caught the platform's own full scan (21.269ms to 0.062ms), deep diagnosis that pinpoints implicit type conversion from estimated-vs-actual row gaps in real execution plans, the trade-offs behind 'diagnosis must never become the load,' honesty-by-design (UNSUPPORTED instead of fake passes), AI constrained to a first-pass analyst with a read-only tool whitelist, cost awareness, and the remaining limits. Every number was measured firsthand; 52 sections of reproduction logs live in the repository."
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

이 글은 DBTower 시리즈 10편의 총정리입니다. 시리즈를 안 읽어도 이 한 편으로 전체가 파악되게 썼고, 깊이가 필요한 지점마다 해당 편을 링크했어요.

한 줄로 요약하면 — **서로 다른 DBMS 5기종(MySQL·PostgreSQL·SQL Server·Oracle·MongoDB)의 운영을, 인터페이스 하나(`DbmsOperator`) 뒤에서 등록부터 진단·백업·자율 감시까지 처리하는 컨트롤 플레인**입니다. Java 21 + Spring Boot 4, 코드는 [GitHub](https://github.com/dj258255/dbtower)에 공개되어 있습니다.

숫자부터 놓고 시작할게요. 전부 직접 측정했고, 명령·출력·환경이 담긴 재현 기록([VERIFICATION.md](https://github.com/dj258255/dbtower/blob/main/docs/VERIFICATION.md) 52절)이 저장소에 있습니다.

| 항목 | 수치 |
|---|---|
| 관리 기종 | 5기종 (SQL도 JDBC도 없는 MongoDB 포함) |
| 새 기종 추가 비용 | Operator 구현체 1개 — 플랫폼 코드 0줄 수정 (실측) |
| 성능 개선 | 수집 4.0배 · 저장 13.8배 · 조회 343배 (전부 전후 비교 측정) |
| 부하 상한 | k6 10 VU 30s — 2,832 req/s, P95 5.86ms, 실패 0 |
| 테스트 / 기록 | 259건 (CI 게이트) / VERIFICATION 52절 |
| 규모 가정 | 관제 도구 특성상 실사용은 수십 RPS면 충분 — 상한은 그래도 실측해 뒀습니다 |

측정 환경은 공통적으로 로컬 Docker(Apple Silicon) 위의 대상 DB 5기종이며, 각 수치의 상세 조건은 해당 절에 명시했습니다.

## 1. 문제 정의 — 왜 만들었나

시작은 정상 상태의 관찰입니다. DB에 이슈가 나면 개발자는 지표가 흩어진 도구들을 오갑니다 — CPU는 모니터링 대시보드에, 쿼리 통계는 DB마다 다른 시스템 뷰에, 실행계획은 콘솔에. 그러다 결국 DBA에게 문의하고, DBA는 같은 질문에 반복해서 답합니다. 관리 대상 DB가 늘수록 사람 손이 선형으로 늘어나는 구조예요.

이건 제가 지어낸 문제가 아니라 업계가 이미 정의한 문제입니다. 당근이 사내 DB 플랫폼 KDMS를 만든 이유였고, AWS가 인프라 메트릭(CloudWatch) 위에 쿼리 수준 분석(RDS Performance Insights)을 별도 층으로 얹은 이유이기도 해요. 저는 그 문제 정의를 출발점으로 **핵심 메커니즘을 직접 구현**하기로 했습니다.

여기서 범위 결정 하나가 중요했어요. 메트릭 층(exporter + Prometheus + Grafana)은 이미 검증된 스택이라 **직접 만들지 않고 그대로 씁니다.** DBTower가 맡는 건 그 위의 층 — "그 시각에 어떤 쿼리가 원인이고, 실행계획이 왜 나쁘고, 무엇을 해야 하나"입니다. 이미 잘 푼 문제를 다시 푸는 건 열정이 아니라 낭비라고 판단했습니다.

## 2. 설계의 중심 — 경계를 어디에 긋나

이기종 플랫폼의 본질은 추상화 경계의 위치 선정입니다. 같은 "쿼리 통계"가 기종마다 소스가 다르고(performance_schema / pg_stat_statements / DMV / V$SQL / system.profile), 같은 "백업"이 실행 모델부터 다릅니다(외부 CLI / 서버 사이드 SQL / 서버 사이드 API).

![DBTower 전체 구조 — 소비자 차이는 채널 뒤로, 기종 차이는 DbmsOperator 뒤로, 기술 차이는 각자의 제자리로](/uploads/project/dbtower/architecture-full.svg)

결정은 세 겹입니다.

**경계는 SQL이 아니라 "운영 행위"에 긋는다.** `DbmsOperator`는 `queryStats()`, `explain()`, `backup()`처럼 운영자가 하는 행위를 선언하고, 기종별 구현체가 각자의 방식으로 채웁니다. 경계를 SQL에 그었다면 SQL이 없는 MongoDB가 들어올 수 없었을 거예요. 이 결정 덕에 explain 입력이 SQL 대신 명령 JSON이어도 인터페이스가 흡수합니다.

**기술은 적재적소 — 통일하지 않는다.** "Operator도 JPA + Native Query로 통일하면 깔끔하지 않냐"는 질문을 받고 제대로 분석해 봤는데([6편](/blog/project/dbtower/dbtower-6-wait-events-and-right-tool)), 결론은 반대였습니다. 대상은 런타임에 등록되는 N개의 동적 데이터소스라 부팅 시점에 고정되는 EntityManager와 안 맞고, 조회 대상인 시스템 뷰에는 매핑할 엔티티도 생명주기도 없으며, MongoDB엔 JPA 자체가 없어요. 그래서 플랫폼 자기 저장소는 Spring Data JPA(파생 메서드·@Query·Specification 3층위), 대상 DB 조회는 JdbcTemplate과 Mongo 드라이버, 스냅샷 대량 쓰기는 JDBC batch로 — 층마다 맞는 도구를 씁니다. 프레임워크 하나로 통일하는 게 깔끔함이 아니라, 각 도구가 제일 잘하는 자리에 있는 게 깔끔함이라는 게 이 프로젝트의 일관된 답입니다.

**경계는 문서가 아니라 빌드가 지킨다.** 패키지 8개를 Spring Modulith 모듈로 선언하고, 모듈 간 순환 의존을 테스트가 빌드에서 실패시킵니다. 도입 첫 실행에서 실제로 순환 2개(registry↔operator, insight↔alert)가 잡혀서 의존 역전으로 해소했어요 — 규칙이 실제로 작동한다는 증거를 도입 당일에 얻은 셈입니다.

## 3. 주장은 검증 전까지 빚이다 — "새 기종 = 구현체 1개"

설계 문서에 계속 적어온 주장이 있었습니다. "새 기종 추가 = Operator 구현체 1개, 플랫폼 코드 수정 없음." 주장은 검증 전까지 빚이라, 성격이 정반대인 두 기종을 실제로 추가해 갚았습니다([4편](/blog/project/dbtower/dbtower-4-five-engines)) — 상용 DB의 대표 Oracle과, SQL도 JDBC도 없는 MongoDB.

결과를 정직하게 세면: 새로 만든 것은 Operator 구현체 2개와 Mongo 클라이언트 캐시, 기존 수정은 enum 값·팩토리 case 등 몇 줄. **스냅샷 수집·시점 비교·회귀 감지·웹 콘솔·MCP는 0줄 수정**으로 5기종을 처리했습니다. 이후 페이즈에서 추가한 능력들(Wait Event, 파티션, 레이턴시 백분위, 실제 실행 계획...)도 전부 "인터페이스 메서드 1개 추가"의 반복이었어요. 한 번의 요행이 아니라 구조의 성질이라는 걸 반복 검증으로 보였습니다.

![대시보드 — 다섯 기종 여섯 인스턴스가 같은 카드, 같은 그래프, 같은 진단으로](/uploads/project/dbtower/dashboard.png)

## 4. 성능 — 다섯 개의 개선 아크, 전부 전후 실측

성능 서술은 "빨라졌다"가 아니라 **무엇이, 어떤 조건에서, 왜, 얼마나**여야 한다고 생각해요. 다섯 아크 전부 개선 전 수치를 먼저 재고, 원인을 분석하고, 고친 뒤 다시 쟀습니다.

| # | 문제 | 원인 분석 | 개선 | 실측 (환경: 로컬 Docker) |
|---|---|---|---|---|
| 1 | 수집마다 지연 | 매 수집 새 커넥션 — TCP+인증 핸드셰이크 반복 | 인스턴스별 HikariCP 풀 | 47.1 → 11.8ms (4.0배) |
| 2 | 대량 저장 느림 | JPA saveAll이 행별 INSERT | JDBC batch + reWriteBatchedInserts | 행당 1.51 → 0.11ms (13.8배) |
| 3 | 스냅샷 조회 지연 | 50만 행 Seq Scan | 복합 인덱스(등치 컬럼 선두) | 21.269 → 0.062ms (343배) |
| 4 | 긴 쿼리 통계 병합 | digest 길이 1024에서 절단 | max_digest_length 4096 | side-by-side 재현·해소 |
| 5 | 상한 미검증 | — | k6 부하 테스트 | 2,832 req/s, P95 5.86ms, 실패 0 |

3번이 이 프로젝트에서 제일 아끼는 이야기입니다. **DBTower 자신을 DBTower의 관리 대상으로 등록**(메타 저장소가 PostgreSQL이라 가능 — 도그푸딩을 염두에 둔 선택이었어요)했더니, 자기 스냅샷 조회 쿼리가 자기 화면의 슬로우 쿼리 목록에 떴습니다. 자기 explain API로 진단하니 50만 행 Seq Scan. 등치 조건 컬럼을 선두로 한 복합 인덱스를 걸고 같은 API로 재측정해 343배를 확인했어요. **개선을 측정한 도구가 곧 내가 만든 기능**이라는 순환이, 이 플랫폼이 실제로 동작한다는 가장 강한 증거라고 생각합니다.

부하 검증(5번)도 한 줄 짚을게요. 관제 도구는 사용자가 운영자 몇 명이라 실사용 수십 RPS면 충분하지만, "충분할 것"과 "상한을 안다"는 다른 문제라 k6로 상한을 실측해 뒀습니다.

## 5. 심층 사례 — "인덱스가 있는데 왜 안 타요?"

포트폴리오용 요약이 아니라 실제 진단 흐름 하나를 5단계로 통째로 보여드릴게요([9편](/blog/project/dbtower/dbtower-9-deep-diagnosis) 상세).

**정상 상태** — `products` 테이블(3,001행), `code VARCHAR(20)` 컬럼에 B-Tree 인덱스 `idx_code`. `WHERE code = '012345'` 조회는 인덱스를 타고 1행을 읽습니다.

**문제 상황** — 같은 쿼리를 `WHERE code = 12345`(따옴표 없이 숫자)로 던지면 풀스캔이 됩니다. 쿼리만 봐서는 멀쩡해 보여서, 현업에서 "인덱스가 있는데 왜 안 타요?"로 접수되는 대표 사례예요.

**구조적 원인** — MySQL 비교 규칙상 문자열과 숫자를 비교하면 **문자열 쪽이 숫자로 캐스팅**됩니다(`CAST(code AS DOUBLE) = 12345` 꼴) — 인덱스 컬럼에 함수를 씌운 것과 같아 B-Tree 정렬을 못 쓰고, '1'·' 1'·'1a'가 같은 숫자로 매핑되므로 문자열 순서 인덱스로는 숫자 등치를 탐색할 수도 없어요(암시적 형변환). 더 무서운 건 정합성입니다 — `'012345'` 같은 다른 문자열까지 같은 숫자로 매칭돼 조회면 오답, UPDATE/DELETE면 데이터 사고예요. 그리고 EXPLAIN(추정)만으로는 옵티마이저가 "왜 속았는지"까지 안 보입니다 — 그래서 **추정 행수와 실제 행수의 괴리**를 봐야 하고, 그러려면 쿼리를 실제로 실행하는 EXPLAIN ANALYZE가 필요합니다.

**학습 과정** — "실제 실행 계획"을 얻는 방법이 5기종 전부 달랐습니다. MySQL EXPLAIN ANALYZE, PostgreSQL (ANALYZE, BUFFERS), Oracle은 gather_plan_statistics 힌트 후 DISPLAY_CURSOR를 **같은 커넥션**에서, SQL Server는 SET STATISTICS XML의 **별도 결과셋**, MongoDB는 executionStats. 기종별 공식 문서로 명세를 검증해 판단 기준 문서에 먼저 적었는데, 구현 중 MySQL 8.4가 `FORMAT=JSON`을 ERROR 1235로 거부해 **문서를 실측대로 고쳤습니다.** 함정도 하나 — MySQL/PostgreSQL의 actual rows는 루프당 평균이라 loops를 곱해야 총량이고, 안 곱하면 괴리 계산 전체가 틀립니다(단위 테스트로 고정).

**결과** — 아래가 실제 화면입니다. 추정 300행 vs 실제 1행(300배 괴리)에서 최하위 노드를 짚고, 근본 원인 "암시적 형변환"과 처방("값을 문자열로 주거나 컬럼 타입을 맞춰라")까지. 같은 쿼리를 `'012345'`로 바꾸면 "근본 원인 없음"으로 정상 판정합니다.

![심층 원인 진단 — 추정 300행 vs 실제 1행, 암시적 형변환 지목과 처방](/uploads/project/dbtower/deep-diagnose.png)

이런 진단이 헬스 스코어(어느 인스턴스부터) → 시점 비교·이상 감지(어느 쿼리가) → 실행계획 규칙(계획이 왜 나쁜가) → 심층 진단(옵티마이저는 왜 속았나)의 마지막 층으로 들어가, "어디부터 봐야 하나"에서 "무엇을 고치면 되나"까지 한 줄로 이어집니다([8편](/blog/project/dbtower/dbtower-8-autonomous-diagnosis)).

## 6. 트레이드오프 하나 — 진단이 부하가 되면 안 된다

로드맵의 마지막 기능은 화려한 게 아니라 보호장치였습니다([10편](/blog/project/dbtower/dbtower-10-guardrails-and-selfhost)). 심층 진단은 쿼리를 실제로 실행하고, 수집 폴러는 1분마다 대상들을 두드립니다. 관제 도구가 관제 대상을 느리게 만들면 본말전도예요.

구현보다 결정이 어려웠던 지점을 하나만 꺼내면 — MongoDB 타임아웃입니다. 드라이버에 CSOT(클라이언트 전역 operation timeout)라는 정석이 있는데 **일부러 안 썼어요.** CSOT를 켜면 드라이버가 심층 진단이 명령에 직접 실은 서버측 `maxTimeMS`를 무시하고 자기 예산으로 재계산합니다. 전역 안전장치(정석)가 정밀 안전장치를 덮어쓰는 간섭이라, 소켓 read 상한 + 명령별 maxTimeMS 조합을 택하고 **이유를 코드 주석으로 남겼습니다** — 나중에 누가 "왜 정석을 안 썼지?"라며 바꾸면 조용히 망가질 지점이니까요. 정석을 아는 것과, 정석이 내 맥락에 맞는지 판단하는 건 다른 일이라고 배웠습니다.

수집 폴러에는 인스턴스별 지수 백오프를 넣었어요. 죽은 DB를 매 틱 다시 두드리는 것(TCP·인증·타임아웃 대기) 자체가 부하라서요. 연속 실패 시 건너뛸 틱이 1→2→4→8→16으로 늘고, 한 번 성공하면 즉시 정상 주기로 복귀합니다 — 회복한 DB를 벌주지 않는 게 포인트였고, 죽은 인스턴스를 등록해 로그로 라이브 검증했습니다.

## 7. 정직성 설계 — 못 하는 것을 못 한다고 말하는 기능

이 프로젝트에서 기능만큼 공들인 게 "못 하는 것의 표기"입니다.

- **백업 복원 검증은 3값** — VERIFIED / FAILED / **UNSUPPORTED**. Oracle은 자동 복원 검증 수단이 없어서 UNSUPPORTED인데, 이걸 "통과"로 위장하면 사용자는 검증 안 된 백업을 믿게 됩니다
- **레이턴시 p95는 소스 라벨을 섞지 않음** — MySQL은 실측(QUANTILE), MongoDB는 직접 계산, PostgreSQL은 정규분포 가정 추정(ESTIMATED 표기), SQL Server/Oracle은 원자료가 없어 UNSUPPORTED
- **이상 감지는 "학습 중"을 보류로** — 관측 8회 미만 버킷은 판정하지 않고 learningCount를 노출. 모르는 것을 모른다고 말하는 것도 감지기의 정직성
- **FinOps는 신호까지만** — 절감액 달러는 환경마다 달라 찍는 순간 지어낸 숫자가 되므로, 미사용 인덱스 신호만 내고 판단은 사람에게
- **Terraform은 validate까지** — apply는 AWS 자격증명·과금이 필요해 실행하지 않았고, 그렇게 적었습니다. 같은 등록 흐름의 실제 완주는 K8s(CloudNativePG e2e)와 Ansible(멱등 changed=0)로 검증했어요([7편](/blog/project/dbtower/dbtower-7-provisioning))

관제 도구의 출력은 운영 결정의 입력이 됩니다. 과장된 능력 표기는 버그보다 나쁘다고 생각해요.

## 8. 운영 안전 — 기본기의 목록

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

## 9. AI — 판단자가 아니라 1차 분석기

AI 기능은 두 가지 원칙으로 묶었습니다.

**판단 기준은 사람이 문서로 정한다.** 실행계획 판정 규칙(기종별 비효율 신호, 근거, 예외)을 문서로 만들어 시스템 프롬프트로 주입합니다. 같은 입력에 일관된 판정이 나오고, **근거가 없으면 모른다고 답하게** 했어요 — 실측에서 데이터에 없는 질문("작년 크리스마스 접속자 수")에 수치를 지어내지 않고 confidence=low로 답하는 것까지 확인했습니다.

**AI에게 도구를 주되, 읽기 전용만.** 자연어 진단("이 DB 왜 느려?")은 AI가 MCP 도구를 스스로 연쇄 호출하는 루프(최대 5스텝)인데, **read-only 12종 화이트리스트**만 노출해 kill·backup·online-ddl 같은 쓰기 도구는 루프에 아예 존재하지 않습니다. AI가 어떤 판단을 해도 대상 DB 변경이 0인 게 구조로 보장돼요. 그 MCP 서버 자체도 SDK 없이 JSON-RPC 2.0을 직접 구현했고(stdio/HTTP 전송이 프로토콜 코어 공유), 스펙 준수를 테스트로 고정했습니다([3편](/blog/project/dbtower/dbtower-3-channels-web-mcp-ai)).

## 10. 비용 관점 — 관제 도구는 남의 자원을 쓴다

이 도구의 비용 감각은 "내 인프라"보다 "대상 DB의 자원"에 있습니다.

- **커넥션 풀은 인스턴스당 max 2** — 대상 DB의 커넥션 슬롯은 그 DB의 서비스가 써야 할 자원이라, 관제 도구가 크게 점유하면 안 됩니다
- **스냅샷 보존은 기본 7일 + 시간당 정리** — 무한 적재면 메타 DB가 관리 대상보다 먼저 포화됩니다. 7일은 AWS Performance Insights의 기본 보존(그 이상은 명시적 선택·과금) 선례를 따랐어요
- **배포는 셀프호스트** — SaaS는 대상 DB 자격증명 수탁·사설망 도달·멀티테넌시·상시 서버 비용 네 벽에 막힙니다. 도구가 사용자 인프라 안으로 들어가면 넷 다 사라져요(Grafana/PMM 모델). 그래서 배터리 포함 컨테이너 이미지(백업 CLI 번들)와 원커맨드 compose, 태그 push가 곧 릴리스인 GHCR 파이프라인으로 v1.0.0을 찍었습니다

## 11. 남은 한계, 그리고 결산

정직하게 남겨둔 것들: 알림 쿨다운의 설정 외부화, Vault 동적 계정, 백업 원격 보관(3-2-1의 오프사이트), 히스토그램 기반 구간 p95, 그리고 TLS 강제 클라우드 서비스(Atlas·Azure SQL 등)용 접속 옵션. 반대로 의도적으로 안 하는 것도 있습니다 — 자동 인덱스 생성, SQL 승인 워크플로 같은 "대상 DB를 스스로 바꾸는" 기능은 이 제품의 정체성(읽고 판단한다) 밖이라 범위에서 제외했어요.

돌아보면 이 프로젝트를 관통한 건 세 문장입니다.

1. **차이는 경계 뒤로** — 기종 차이는 인터페이스 뒤로, 소비자 차이는 채널 뒤로, 기술 차이는 각자의 제자리로
2. **주장은 실측으로** — 확장성 주장은 기종을 실제로 추가해서, 성능 주장은 전후 측정으로, 능력 표기는 안 되는 것의 명시로
3. **관제 도구는 힘이 아니라 신뢰로 완성된다** — 마지막에 추가한 기능이 "내가 부하가 되지 않는 장치"였고, 제품화의 첫 결정이 "비밀은 사용자 인프라를 떠나지 않는다"였습니다

전 과정의 상세는 시리즈 [1편(설계)](/blog/project/dbtower/dbtower-1-why-and-design)부터 [10편(제품화)](/blog/project/dbtower/dbtower-10-guardrails-and-selfhost)까지에, 재현 가능한 기록은 [GitHub](https://github.com/dj258255/dbtower)에 있습니다. 셀프호스트로 직접 띄워보실 수 있어요.

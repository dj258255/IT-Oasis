---
title: '인증부터 셀프호스트 v1.0.0까지, 운영 안전 8축·IaC 프로비저닝·진단 가드레일로 프로덕션에 올리다'
titleEn: 'From Auth to Self-Hosted v1.0.0: Eight Axes of Operational Safety, IaC Provisioning, and Diagnostic Guardrails to Production'
description: '이기종 DBMS 운영 관리 플랫폼 DBTower의 운영 안전 편. ''네트워크에 닿는 누구나 인스턴스를 등록·삭제·백업할 수 있는 관제탑''이라는 결격 사유에서 시작해 운영 안전을 8개 축으로 닫았습니다. 세션+토큰 이중 인증과 역할 분리, 비밀번호 AES-256-GCM 암호화와 하위호환, ddl-auto가 만든 스키마 드리프트를 Flyway로 이관하다 밟은 Boot 4 스타터 조용한 미실행 함정, 권한 0에서 시작해 실측으로 확정한 최소 권한 계정, 스케줄러 분산 락, 복원 검증까지. 이어 생성과 관제를 잇는 Phase C에서 멱등 등록 PUT을 종점으로 K8s(CloudNativePG e2e)·Ansible(changed=0)·Terraform(validate까지)을 관제탑에 이었고, 마지막으로 진단이 대상 DB의 부하가 되지 않게 하는 가드레일(단일 지점 쿼리 타임아웃·MongoDB 소켓 상한·죽은 DB 지수 백오프)을 달고 SaaS의 네 벽을 피해 Grafana처럼 셀프호스트 배터리 포함 이미지로 v1.0.0을 찍었습니다.'
descriptionEn: 'The operational-safety part of DBTower. Starting from a disqualifying flaw, that anyone on the network could register, delete, or back up instances, I closed operational safety along eight axes: session+token dual auth with role separation, AES-256-GCM password encryption with backward compatibility, migrating ddl-auto schema drift to Flyway (hitting Boot 4''s silent-no-run trap), a least-privilege account confirmed by measurement, a distributed scheduler lock, and backup restore verification. Then Phase C wires creation to control: an idempotent registration PUT as the single endpoint for K8s (CloudNativePG e2e), Ansible (changed=0), and Terraform (validate only). Finally guardrails so diagnosis never becomes the load, a single-point query timeout, a MongoDB socket cap, exponential backoff for dead DBs, and a self-hosted batteries-included image like Grafana, shipping v1.0.0.'
date: 2026-07-04
tags:
  - Java
  - Spring Boot
  - DBRE
  - Spring Security
  - Flyway
  - Kubernetes
  - Ansible
  - Terraform
  - Docker
  - GitHub Actions
  - Self-hosted
category: personal/DBTower
coverImage: /uploads/project/dbtower/selfhost-architecture.svg
draft: false
series: "DBTower"
seriesOrder: 3
---

## 0. 들어가며: 인증 없는 관제탑은 관제탑이 아니다

[2편](/blog/project/dbtower/dbtower-2-engines-and-diagnosis)까지 DBTower는 다섯 기종을 하나로 묶고 시점 비교·회귀 감지·MCP까지 다 갖췄습니다. 그런데 냉정하게 보면 큰 구멍이 있었습니다. **인증이 없었습니다.** 콘솔도 REST도 MCP도 전부 열려 있어 네트워크에 닿는 누구든 인스턴스를 등록·삭제하고 백업을 실행할 수 있었습니다. DB 접속정보를 다루는 관리 도구로서 가장 큰 결격 사유입니다. 같은 장르의 Percona PMM이 서비스 계정과 접근 제어를 갖추는 이유가 여기 있습니다.

여기서부터가 진짜 차이라고 느꼈습니다. 기능을 붙이는 건 포트폴리오지만 "이걸 남의 DB에 붙여도 되는가"를 닫는 게 프로덕션입니다. 운영 안전을 8개 축으로 나누고 각 축을 **한계 인지 → 개선 → 실측 → 남은 한계 정직 명시**라는 같은 아크로 하나씩 닫았습니다. 이번 편은 그 8개를 압축한 기록입니다.

## 1. A1 인증·인가, 주체가 둘이라 인증도 둘이다

가장 먼저 닫아야 할 구멍이었습니다. 설계의 출발점은 "이 플랫폼을 쓰는 주체가 둘"이라는 사실입니다. 사람(웹 콘솔)과 기계(MCP 클라이언트·자동화)는 인증 방식이 다를 수밖에 없습니다.

| 주체 | 인증 | CSRF |
|---|---|---|
| 사람 (웹 콘솔) | 세션 폼 로그인, 비밀번호는 메타 DB에 BCrypt | 쿠키(XSRF-TOKEN) → SPA가 헤더로 되돌리는 표준 패턴 |
| 기계 (MCP·자동화) | Bearer 서비스 토큰 (상수 시간 비교) | 쿠키 세션이 없어 CSRF가 성립하지 않으므로 대상 아님 |

인가는 역할 두 개로 나눴습니다. 진단(조회·explain)은 VIEWER부터, **대상 DB를 바꾸는 행위**(등록/삭제/백업/정책)와 서비스 토큰 조회는 ADMIN만. 그리고 fail-closed 원칙 두 가지를 박았습니다. admin 초기 비밀번호는 `admin/admin`으로 하드코딩하지 않고 미설정 시 랜덤 생성 후 로그에 1회만 안내(Jenkins 방식). 서비스 토큰도 미설정이면 무인증으로 열릴 것 같지만 기동마다 랜덤 토큰이 걸립니다. 그 값을 모르면 아무도 못 씁니다.

실측으로 인가 표를 그대로 확인했습니다.

```
미인증:  GET /            -> 302 /login.html   (브라우저는 로그인으로)
         GET /api/...     -> 401               (API는 상태코드로)
viewer:  POST .../explain -> 200               (진단은 VIEWER부터)
         POST /api/instances(등록) -> 403
         GET  .../mcp-token         -> 403
admin:   GET  .../mcp-token         -> 200      (MCP 카드가 이걸로 등록 명령 완성)
기계:    Bearer 올바른 토큰 -> 200 / 틀린 토큰 -> 401
```

여기서 Spring Boot 4 / Security 7 함정을 둘 밟았습니다. 하나는 **AntPathRequestMatcher가 아예 사라진 것**입니다. Security 7에서 제거돼 람다 RequestMatcher로 대체했습니다. 다른 하나는 **로그인하면 CSRF 토큰이 회전한다**는 것입니다. 세션 고정 방어로 인증 성공 시 기존 CSRF 토큰이 무효화되는데, curl로 E2E를 짜며 로그인 전 토큰을 재사용했다가 403을 맞고 알았습니다(브라우저 SPA는 매 요청 쿠키를 다시 읽으니 자연히 무관합니다). 보안 테스트 10건으로 이 인가 표를 코드로 고정해, 누가 규칙을 바꾸면 CI가 잡게 했습니다.

![로그인 화면. 최초 기동 때 admin을 부트스트랩하고 기본 비밀번호는 하드코딩하지 않는다](/uploads/project/dbtower/login.png)

## 2. A2 비밀번호 암호화로 평문 저장을 닫다

등록된 인스턴스의 비밀번호가 메타 DB에 **평문**으로 저장되고 있었습니다. 메타 DB가 유출되면 관리 대상 DB 전체의 열쇠가 함께 샙니다. AES-256-GCM으로 암호화했습니다. 랜덤 IV 12바이트를 암호문 앞에 붙이고 128비트 태그, 키는 `DBTOWER_ENCRYPTION_KEY`(base64 32바이트) 환경변수로만.

재미있었던 건 **하위호환**입니다. JPA `AttributeConverter`에 `enc:v1:` 접두사 디스패치를 뒀습니다. 기존 평문 행은 마이그레이션 없이 그대로 읽히고 다음 저장 때 자연스럽게 재암호화됩니다. `v1`을 붙인 건 나중에 키·알고리즘을 교체할 여지입니다.

그리고 키 정책은 A1과 **일부러 비대칭**으로 갔습니다. API 토큰은 미설정 시 랜덤 생성이 안전(fail-closed)이지만 암호화 키를 랜덤 생성하면 오히려 위험합니다. 재기동하면 기존 암호문을 영영 못 풀기 때문입니다. 키 미설정은 WARN+평문(과도기), 잘못된 키는 기동 거부, 키 없이 암호문을 만나면 예외. "조용히 평문으로 새는" 경로만은 없게 했습니다.

```
기존 평문 행:  id 1·7·8 health 전부 up  — 하위 호환 확인
신규 등록:     raw 컬럼 = enc:v1:PflkG... (psql로 직접 확인)
테스트:        SecretCipher 8건(변조 시 복호 실패 포함) + Converter 6건 + JPA 통합 2건
```

## 3. A3 Flyway, 2편에서 밟은 그 함정의 정식 해결

[2편](/blog/project/dbtower/dbtower-2-engines-and-diagnosis)에서 MongoDB를 등록하다 500을 맞은 일이 있었습니다. Hibernate가 처음 만든 `CHECK (type IN ('MYSQL','POSTGRESQL','MSSQL'))` 제약을 `ddl-auto: update`가 갱신하지 않아 enum에 값을 추가하는 게 배포로 끝나지 않고 스키마 마이그레이션이 돼버리는 문제였습니다. 그때는 수동 ALTER로 풀었는데, 이번에 스키마의 단일 권위를 Flyway로 정식 이관했습니다.

`V1__baseline.sql`에 테이블 5개(5기종 CHECK 포함)를 엔티티 소스와 라이브 스키마 `\d` 대조로 작성하고 `ddl-auto`를 `update`에서 `validate`로 바꿨습니다. 이제 엔티티-스키마 불일치는 조용히 드리프트로 남지 않고 **부팅 실패**로 터집니다. 기존 DB는 baseline-on-migrate로 비파괴 도입했습니다.

```
기존 DB: instances 6 · snapshots 46,711 무손상 — 실측 확인
빈 스크래치 DB: V1이 실제 실행되어 기동까지 검증
```

그런데 여기서 **Boot 4다운 함정**을 하나 더 밟았습니다. `flyway-database-postgresql` 의존성만 넣으면 부팅은 되는데 Flyway가 **조용히 실행되지 않습니다**. 로그 0건, history 테이블 없음. Boot 4의 자동구성 모듈화로 `spring-boot-starter-flyway`가 따로 필요했습니다. "조용한 미실행"은 다 된 줄 알게 되니 에러보다 나쁜 실패 양식입니다. 예전 MySQL digest 절단과 같은 계열의 함정이었습니다.

## 4. A4 스냅샷 보존으로 무한 적재를 닫다

시점 비교의 재료인 60초 주기 스냅샷이 무한히 쌓이고 있었습니다. 실측으로 이틀에 50,960행. 방치하면 메타 DB가 플랫폼 자신의 병목이 됩니다(AWS Performance Insights도 기본 보존이 7일입니다). 1시간 주기로 cutoff(기본 7일) 이전을 JPQL 벌크 DELETE 한 문장으로 지웁니다. 수십만 행을 영속성 컨텍스트에 올리지 않으려 벌크로 갔고 `@Modifying(clearAutomatically=true)`로 1차 캐시 불일치도 막았습니다. `retention-days <= 0`이면 보존 무제한 스위치입니다.

## 5. A6 감사 로그, 누가 언제 무엇을 했나

A1로 인증은 생겼는데, 인증된 사용자가 **무엇을 했는지** 기록이 없었습니다. 접근 통제만큼 사후 추적도 관리 도구의 기본 요건입니다. audit 모듈을 신설해 `/api/**`의 POST/PUT/DELETE(상태 변경·explain·백업)와 로그인 성공/실패를 기록했습니다. GET 조회는 폴링 노이즈라 뺐습니다.

설계에 사각지대가 하나 있었습니다. 인가 거부(403)는 `DispatcherServlet` 앞에서 끝나 인터셉터가 못 봅니다. 인터셉터(인가 통과 요청) + `AuthorizationDeniedEvent` 리스너(403 거부) 조합으로 메웠습니다.

```
POST /api/instances/8/explain 실행 후 GET /api/audit ->
  2026-07-04T15:10:40  api-token  ADMIN  POST .../8/explain -> 200 (145ms)
```

여기서도 Security 7.1 함정이 있었습니다. `InteractiveAuthenticationSuccessEvent`는 더 이상 `AuthenticationSuccessEvent` 하위 타입이 아니었고, `AuthorizationFilter`가 이벤트에 싣는 객체도 `RequestAuthorizationContext`인 줄 알았더니 `HttpServletRequest`였습니다. 첫 테스트가 실패해 발견했습니다.

![감사 로그 화면. 누가 언제 무엇을 했는지 사용자·action·결과·기간으로 동적 필터링한다](/uploads/project/dbtower/audit.png)

## 6. A8 최소 권한 계정: 권한 0에서 시작해 실측으로 확정

지금까지 DBTower는 root/sa/system급 계정으로 대상 DB에 붙었습니다. 관제 도구는 조회에 필요한 **최소 권한만** 가진 전용 계정으로 붙어야 합니다(Datadog DBM 등의 관행). 문제는 "최소가 얼마냐"를 추측하면 반드시 틀린다는 것. 그래서 권한 0인 계정을 먼저 등록하고 기능별 API를 호출해 **DB가 돌려주는 권한 에러 원문**을 하나씩 수집하며 필요한 것만 더했습니다.

| 기종 | 확정된 최소 집합 |
|---|---|
| MySQL | `sample.*` + performance_schema digest + `mysql.slow_log` + REPLICATION CLIENT/SLAVE |
| PostgreSQL | LOGIN + `pg_read_all_stats` (pg_monitor 전체는 과함) |
| SQL Server | `VIEW SERVER PERFORMANCE STATE` 한 줄 (2022 세분화 권한) |
| Oracle | CREATE SESSION + SELECT_CATALOG_ROLE + 대상 테이블 READ |
| MongoDB | read@sample + clusterMonitor@admin |

실측이라 예상과 다른 지점이 나왔습니다. **MongoDB의 read 롤은 `system.profile`을 못 읽습니다**(Unauthorized). 커스텀 롤을 만들어야 하나 했는데, `showPrivileges`로 확인해 보니 **clusterMonitor에 그 권한이 이미 있어** 별도 롤이 불필요했습니다. 또 하나, PostgreSQL은 권한이 없어도 query-stats가 HTTP 200으로 성공하되 전 행이 `<insufficient privilege>`로 **조용히 저하**됩니다. 에러라면 눈에 띄었을 텐데 빈 데이터로 내려와 더 위험한 형태였습니다. 백업은 관리 작업이라 이 조회 계정 범위 밖이라는 경계도 문서에 박았습니다.

## 7. A5 HA 분산 락, 두 대 띄우면 무너지는 전제

`@Scheduled` 폴러 4종(통계 수집·회귀 감지·보존 삭제·백업)이 전부 "단일 프로세스" 전제로 짜여 있었습니다. 앱을 2개 이상 띄우면 모든 노드가 동시에 같은 대상 DB를 수집하고, 회귀 감지 쿨다운이 인메모리라 노드마다 따로 놀아 같은 회귀를 중복 알림합니다. ShedLock(JdbcTemplate 프로바이더)으로 폴러마다 고정 이름 락을 걸어 한 시점에 한 노드만 실행합니다. `usingDbTime`으로 노드 JVM 클럭 대신 메타 DB 시계로 만료를 판정한 게 포인트입니다(HA 클럭 스큐 방어).

```
2노드(18081+18082, 공유 메타DB, 15초 주기, 약 90초):
  NODE A: 스냅샷 수집 = 54건 / NODE B: = 0건
  NODE B: "Not executing 'snapshot-collect'. It's locked." (매 틱)
```

그런데 여기서 **정직한 잔여 한계**를 남겼습니다. RegressionDetector 쿨다운 Map은 여전히 노드별 인메모리입니다. 락 stickiness로 정상 시엔 한 노드가 계속 이겨 중복이 급감하지만, 락 핸드오프(failover) 직후엔 새 승자의 Map이 비어 이미 보낸 회귀를 1회 재알림할 수 있습니다. 완전 해결은 쿨다운을 메타 DB로 외부화하는 건데, 잔여 리스크를 "중복 1회"로 판단해 이번엔 수용했습니다. 이런 걸 숨기지 않고 적어두는 게 운영 도구의 신뢰라고 생각합니다.

## 8. A7 백업 복원 검증, 테스트 안 한 백업은 백업이 아니다

지금까지 "백업했다"까지만 있고 "그 백업이 복원되는가"는 검증하지 않았습니다. 3-2-1-1-0 규칙의 "0 errors"가 요구하는 지점입니다. 핵심 원칙은 두 가지였습니다. **못 하는 것을 통과로 위장하지 않는다**, 그리고 **복원은 반드시 격리된 임시 대상**(`dbtower_verify_<타임스탬프>`)에서만 이뤄지고 원본은 절대 건드리지 않는다. 그래서 상태를 3값(VERIFIED/FAILED/UNSUPPORTED)으로 뒀습니다.

| 기종 | 수준 | 방법 |
|---|---|---|
| MySQL·PostgreSQL·MongoDB | VERIFIED | 임시 DB에 실제 복원 후 테이블/컬렉션 수 확인, drop |
| SQL Server | VERIFIED(VERIFYONLY) | 서버 측 .bak라 파일 접근 불가 → RESTORE VERIFYONLY로 무결성만 |
| Oracle | UNSUPPORTED | Data Pump 서버 측 산출물이라 자동 검증 범위 밖, 통과 위장 안 함 |

```
PostgreSQL: VERIFIED — 임시 DB 복원 성공, 복원 테이블 3개, 임시 DB 정리 확인
Oracle:     UNSUPPORTED — "IMPDP 필요, 범위 밖" (정직 표기)
FAILED 분기 증명: 없는 덤프 verify -> FAILED (러버스탬프 아님)
임시 검증 DB 잔여물: 0, 원본 sample DB 불변
```

## 9. 결산: 8개 축을 닫고 보니

인증 없는 관제탑에서 시작해 운영 안전 8개 축을 전부 닫았습니다.

| # | 한계였던 것 | 개선 |
|---|---|---|
| A1 | 누구나 들어오는 관제탑 | 세션+토큰 인증, 역할 분리 |
| A2 | 비밀번호 평문 저장 | AES-256-GCM + 접두사 하위호환 |
| A3 | ddl-auto 스키마 드리프트 | Flyway baseline + validate |
| A4 | 스냅샷 무한 적재 | 보존 7일 벌크 삭제 |
| A6 | 누가 뭘 했는지 모름 | 감사 로그 |
| A8 | root/sa급 접속 | 최소 권한 계정 실측 확정 |
| A5 | 단일 프로세스 전제 | ShedLock 분산 락 |
| A7 | 복원 안 되는 백업 | 복원 검증 3값 |

테스트는 81건까지 늘었고 마이그레이션은 V1~V4가 됐습니다. 이 8개 중 서로 다른 모듈에 걸친 것들은 git worktree로 브랜치를 나눠 병렬로 개발했습니다(스키마 권위를 바꾸는 Flyway를 마지막에 병합).

한 가지 더. "기종 분기는 팩토리 한 곳", "플랫폼 코드는 인터페이스만 안다"는 주장을 1편부터 써 왔는데, 문서 속 아키텍처는 강제력이 없습니다. Spring Modulith를 도입해 패키지=모듈로 선언하고 순환 의존을 빌드에서 실패시키게 했더니, 첫 실행에서 바로 순환 2개(registry↔operator, insight↔alert)가 잡혔습니다. 좋은 실패였습니다. 깨끗하다 믿었던 구조에 순환이 실재했다는 뜻이니까요. 의존 역전으로 풀고 나니 이제 누가 경계를 넘으면 CI가 빨간불이 됩니다.

이걸로 "포트폴리오에서 프로덕션으로" 넘어가는 축은 대부분 닫았습니다.

## 10. 프로비저닝: DB는 IaC로 태어난다

[2편](/blog/project/dbtower/dbtower-2-engines-and-diagnosis)까지의 DBTower에는 한 가지 전제가 숨어 있었습니다. **"관리할 DB가 이미 존재한다"**는 전제입니다. 인스턴스는 사람이 API로 등록했고, 그 DB가 어디서 왔는지는 플랫폼의 관심 밖이었습니다.

그런데 현업에서 DB는 그렇게 오지 않습니다. Kubernetes에서는 Operator가 만들고, VM에서는 Ansible이 깔고, 클라우드에서는 Terraform이 RDS를 띄웁니다. DB가 IaC로 태어나는데 관제 등록만 사람이 수동으로 한다면 생성과 관제 사이가 끊긴 것입니다. 이 끊김을 이으려고 이번 축을 만들었습니다. 설계 노트에 적어둔 문장 그대로입니다. **"생성과 관제가 이어져야 플랫폼이고, 끊어져 있으면 도구 모음이다."**

![세 층의 프로비저닝이 멱등 PUT 하나로 관제탑에 모이는 Phase C 구조](/uploads/project/dbtower/provisioning-flow.svg)

## 11. 첫 전제, 등록은 멱등이어야 한다

프로비저닝 도구를 붙이기 전에 먼저 고칠 게 있었습니다. 기존 등록은 `POST /api/instances`인데, IaC는 **재실행되는 물건**입니다. Ansible 플레이북을 두 번 돌리고, Terraform을 다시 apply하고, K8s Job이 재시도됩니다. 그때마다 POST가 인스턴스를 하나씩 더 만들면 관제탑에 같은 DB가 세 개 등록됩니다.

그래서 멱등 등록 `PUT /api/instances`를 먼저 만들었습니다.

- **같은 이름이면 갱신**: 접속 정보를 덮어쓰고 기존 커넥션 풀을 정리한 뒤 새 정보로 접속 검증
- **없으면 신규**: POST와 동일한 경로
- **이름이 논리 식별자**: id가 아니라 이름이 IaC 쪽의 불변 키가 됩니다. `createdAt`은 유지해서 "언제부터 관제했나"가 안 깨지게 했습니다
- 등록/삭제와 같은 **ADMIN 경계**

실측으로 같은 이름을 재차 PUT해도 id가 유지되고 중복이 0인 걸 확인했습니다(신규/갱신/접속 실패 거부 단위 테스트 3건). 이 PUT 하나가 이후 세 도구 모두의 **종점**입니다.

## 12. Kubernetes에서 CloudNativePG로 e2e 완주

첫 번째 층은 K8s입니다. 요즘 DB의 Day-1(생성)과 Day-2(페일오버·백업)는 Operator가 맡는 흐름이라, 직접 StatefulSet을 짜는 대신 CNCF의 CloudNativePG를 썼습니다. DBTower가 할 일은 그렇게 만들어진 DB를 **관제탑에 잇는 것**뿐입니다.

kind 로컬 클러스터에서 끝까지 완주했습니다:

```
kind create cluster (v0.32)            -> Docker 노드 기동
CloudNativePG operator 1.24.1 설치     -> cnpg-controller-manager Available
kubectl apply cluster.yml              -> cluster/dbtower-pg "healthy", pod Running
  Operator가 접속 Secret 자동 생성      -> dbtower-pg-app (username/password/host/port/dbname)
register-job: Secret 읽어 PUT          -> 등록 id 1
DBTower가 그 DB에 실제 접속            -> health up, "PostgreSQL 16.4" (pingMillis 47)
등록 재실행(멱등)                      -> id 1 유지, 중복 0
kind delete cluster                    -> 정리
```

설계 포인트는 등록 훅이 **CloudNativePG의 규약을 그대로 읽는다**는 것입니다. CloudNativePG는 클러스터를 만들면 `<cluster>-app`이라는 접속 Secret을 자동으로 만들어 줍니다. register-job은 그 Secret을 마운트해 PUT을 쏘는 게 전부입니다. K8s 전용 코드를 새로 넣지 않았습니다. K8s 규약과 DBTower의 멱등 PUT이 자연스럽게 만나는 지점을 찾았을 뿐입니다.

## 13. Ansible로 최소 권한 계정까지, 멱등 changed=0

두 번째 층은 온프레미스/VM입니다. 등록에 한 가지를 더 얹었습니다. 앞서 A8에서 실측으로 확정한 **최소 권한 모니터링 계정**을 플레이북이 만들어, 사람이 root 계정을 등록하는 실수를 구조적으로 막습니다.

```
대상 dbtower-postgres에 register-db.yml 실행:
  1차: 모니터링 계정 생성 + pg_read_all_stats 부여 + PUT 등록
       -> changed=1, "등록 완료 HTTP 200"
  2차: 멱등 -> changed=0 (중복도 에러도 없음)
DBTower에서 확인: prod-postgres-01 등록(개수 1),
  최소 권한 계정으로 health up "PostgreSQL 16.14"
```

계정 생성은 `community.postgresql` 모듈(psycopg2), 등록은 `uri` 모듈의 PUT입니다. Ansible의 멱등성 모델과 DBTower의 멱등 PUT이 맞물려 2차 실행이 `changed=0`으로 끝납니다. "몇 번을 돌려도 상태는 하나"라는 IaC의 약속이 등록까지 이어집니다. 비밀값은 `secrets.yml`로 분리해 gitignore에 뒀습니다.

## 14. Terraform은 validate까지만, 그리고 그렇게 적었다

세 번째 층은 클라우드(RDS)입니다. `aws_db_instance`로 RDS를 만들고, 생성 후 `local-exec`로 같은 PUT을 쏘는 모듈을 만들었습니다.

그런데 이 층은 검증 수준이 다릅니다:

```
OpenTofu v1.12.3, aws provider v5.100:
  tofu init      -> provider 설치
  tofu fmt       -> 정상
  tofu validate  -> "configuration is valid"
```

**apply는 실행하지 않았습니다.** 실제 RDS를 띄우려면 AWS 자격증명과 과금이 필요하기 때문입니다. 선택지는 둘이었습니다. "Terraform 연동 완료"라고 뭉뚱그리거나, 검증 수준의 차이를 그대로 드러내거나. 시리즈 내내 지켜온 원칙대로 후자를 택했습니다. 문서에는 "validate 통과, apply는 자격증명 필요라 미실행"이라 적고, 같은 등록 흐름이 실제로 완주되는 건 K8s와 Ansible에서 확인했다고 근거를 연결했습니다. 백업 검증의 UNSUPPORTED, 레이턴시 백분위의 ESTIMATED와 같은 계열의 정직성입니다. **못 본 것을 본 척하지 않기.**

덤으로 하나. 도구는 Terraform이 아니라 OpenTofu를 썼습니다. brew에서 terraform 공식 포뮬러가 라이선스 변경(BUSL) 이후 내려가 별도 tap 신뢰가 필요했기 때문입니다. 오픈소스 포크인 OpenTofu가 문법 호환이라 검증 목적에는 차이가 없었습니다.

## 15. 세 층이 하나의 종점으로

Phase C를 표로 정리하면 이렇게 됩니다.

| 환경 | 도구 | 검증 수준 |
|---|---|---|
| Kubernetes | CloudNativePG Operator + 등록 Job | e2e 완주 (프로비저닝 -> Secret -> 등록 -> health up) |
| 온프레미스/VM | Ansible 플레이북 | e2e 완주 (계정 생성 -> 등록, 멱등 changed=0) |
| 클라우드 | Terraform(OpenTofu) RDS 모듈 | validate 통과 (apply는 자격증명 필요라 정직하게 미실행) |

셋은 완전히 다른 도구지만 전부 DBTower의 멱등 PUT 하나를 종점으로 씁니다. 2편에서 기종 차이를 `DbmsOperator` 뒤로 숨겼듯, 이번엔 프로비저닝 도구의 차이가 등록 API 하나 뒤로 숨었습니다. 플랫폼에 K8s용·Ansible용·Terraform용 코드가 따로 생기는 대신 **잘 정의된 멱등 API 하나가 세 생태계의 접점**이 됐다는 게 이 Phase의 결론입니다.

## 16. 가드레일: 마지막 항목은 화려하지 않다

[2편](/blog/project/dbtower/dbtower-2-engines-and-diagnosis)을 끝내니 미뤄둔 기능이 딱 하나 남았습니다. **분석 보호장치**, 진단 도구가 대상 DB의 부하 유발자가 되지 않게 하는 장치입니다. 이상 감지나 심층 진단과는 결이 다른, "진단 도구가 대상 DB에 부하를 주지 않게 하라"는 겸손한 항목입니다.

2편 마지막 문장이 정확히 이 항목을 가리켰습니다. "실제 실행은 읽기여도 부하다." D9만의 얘기가 아닙니다. DBTower는 1분마다 대상 DB들의 통계를 읽고, 요청마다 세션과 Wait Event를 조회합니다. 관제 도구가 관제 대상을 느리게 만들면 본말전도입니다. 이번 축은 그 마지막 항목을 닫고 **"이걸 누구에게 어떻게 줄 것인가"**라는 질문에 답하며 v1.0.0을 찍는 기록입니다.

## 17. 보호장치 하나, 타임아웃은 단일 지점에

D9는 만들 때부터 타임아웃이 있었지만 정작 **평범한 조회들**(query-stats·wait-events·sessions)엔 상한이 없었습니다. 시스템 뷰 조회야 가볍지만, 대상 DB가 힘든 순간엔 가벼운 쿼리도 오래 붙잡힙니다. 그때 진단 도구까지 커넥션을 물고 늘어지면 안 됩니다.

메서드 수십 개에 하나씩 심는 대신 구조를 이용했습니다. 2편의 정리 아크에서 Operator의 모든 JDBC 조회를 `jdbc()` 헬퍼 하나로 모아뒀기 때문입니다. 그 **한 곳**에 `setQueryTimeout`을 걸면 끝입니다.

```java
protected JdbcTemplate jdbc() {
    JdbcTemplate t = new JdbcTemplate(pools.getDataSource(instance, jdbcUrl()));
    t.setQueryTimeout(pools.queryTimeoutSeconds());  // 모든 JDBC 조회가 상속
    return t;
}
```

설정은 `dbtower.query-timeout-seconds`(기본 15초) 하나입니다. Datadog DBM 같은 상용 모니터링도 수집 쿼리에 statement timeout을 거는 것과 같은 원칙입니다. 개별 기능(D9의 explain 실행 등)은 더 짧은 명시적 타임아웃으로 덮어씁니다.

MongoDB는 갈래가 달랐습니다. 드라이버에 CSOT(클라이언트 전역 operation timeout)라는 정석이 있지만 **일부러 안 썼습니다.** CSOT를 켜면 드라이버가 D9가 명령에 직접 실은 `maxTimeMS`를 무시하고 자기 예산으로 재계산하기 때문입니다. 전역 안전장치가 정밀 안전장치를 덮어쓰는 간섭입니다. 대신 같은 설정값을 소켓 read 상한에 걸고, 무거운 실행 경로는 기존 `maxTimeMS`(서버 측 상한)를 유지했습니다. 이유는 코드 주석에 남겼습니다. 나중에 누가 "왜 정석을 안 썼지?"라며 CSOT로 바꾸면 D9가 조용히 망가지기 때문입니다.

## 18. 보호장치 둘, 죽은 DB를 계속 두드리는 것도 부하다

두 번째는 수집 폴러입니다. 대상 인스턴스가 죽으면 스냅샷 수집이 실패하는데, 기존 코드는 **다음 틱에 또 두드립니다.** 실패한 접속 시도도 공짜가 아닙니다. TCP 연결, 인증 핸드셰이크, 타임아웃 대기가 다 따라붙습니다. 죽어가는 DB엔 이것도 부하고, 완전히 죽은 DB엔 무의미한 낭비입니다.

그래서 인스턴스별 지수 백오프를 넣었습니다. 연속 실패하면 건너뛸 틱을 1, 2, 4, 8, 16(상한)으로 늘리고 **한 번 성공하면 즉시 정상 주기로 복귀**합니다. 회복한 DB를 벌주지 않는 게 포인트입니다. 한 인스턴스의 백오프가 나머지 수집을 막지 않는 격리는 그대로 유지했습니다.

닿지 않는 포트로 죽은 인스턴스를 등록해 라이브로 관측했습니다:

```
22:13:00  수집 실패 instance=a9-dead-canary ... 다음_건너뛸틱=1
22:13:56  (틱 — canary 건너뜀, 나머지 6개는 정상 수집)
22:14:54  수집 실패 instance=a9-dead-canary ... 다음_건너뛸틱=2
```

실패 로그 사이 간격이 정상 틱의 두 배로 벌어졌습니다. 한 틱을 통째로 쉬고 재시도한 뒤 백오프가 2로 자란 것입니다. 지수 수열과 즉시 복귀는 단위 테스트 4건으로 고정했습니다. 이걸로 만들려 적어둔 기능이 전부 닫혔습니다.

## 19. SaaS의 네 벽, 그래서 셀프호스트

기능이 끝났으니 배포의 질문이 남습니다. 처음엔 웹에 올려 사람들이 그냥 써보게 하고 싶었습니다. 그런데 이걸 SaaS로 만들려 하면 네 개의 벽에 부딪힙니다.

1. **자격증명 수탁**. 사용자가 자기 DB의 접속 정보를 남의 서버에 맡겨야 합니다. 관리 도구가 요구하기엔 너무 큰 신뢰입니다
2. **사설망 도달**. 진짜 운영 DB는 공인 IP가 없습니다. SaaS가 닿으려면 터널이나 에이전트가 필요한데, 그 순간 "간단히 써보세요"가 무너집니다
3. **멀티테넌시**. 테넌트 격리와 과금, 남의 쿼리 텍스트(민감 정보) 보관 책임이 따라옵니다
4. **비용**. 상시 서버와 저장소는 제가 부담해야 합니다

그런데 이 넷은 전부 **도구가 사용자 인프라 안으로 들어가면 사라집니다.** 자격증명은 사용자 네트워크를 안 떠나고, 사설망 안이니 도달 문제가 없고, 테넌트는 하나고, 서버는 사용자 것. Grafana, Percona PMM, pganalyze 셀프호스트판이 전부 이 모델인 이유입니다. DBTower도 **자기 인프라에 띄우고 자기 DB를 붙이는 도구**로 이 길을 따릅니다.

![자격증명·쿼리 텍스트·백업이 사용자 인프라 경계를 넘지 않는 셀프호스트 구조](/uploads/project/dbtower/selfhost-architecture.svg)

## 20. 배터리 포함, 백업이 조용히 실패하지 않게

셀프호스트의 최소 단위는 컨테이너 이미지입니다. 멀티스테이지 Dockerfile로 빌드 스테이지에서 jar를 만들고(`clean bootJar`를 쓴 건 `build`를 부르면 실행 불가능한 `-plain.jar`가 같이 생겨 COPY가 모호해지기 때문입니다), 런타임은 JRE + 비루트 사용자 + actuator 헬스체크로 구성했습니다.

고민은 이미지 구성이었습니다. DBTower의 백업/복원은 mysqldump·pg_dump·mongodump로 shell-out하는데(1편), 이 바이너리가 이미지에 없으면 **셀프호스트 사용자의 백업이 조용히 실패합니다.** 이미지가 ~250MB 커지지만 "정직하게 동작하는 제품"이 되려면 클라이언트를 번들해야 한다고 판단했습니다(배터리 포함, 최종 751MB). 반대로 SQL Server는 서버 사이드 T-SQL이라 클라이언트가 필요 없고, Oracle 백업은 UNSUPPORTED입니다. 그 둘의 CLI는 **안 넣었습니다.** 필요 근거가 있는 것만 담습니다.

pg_dump엔 각주가 붙습니다. 로컬 개발 때 직접 밟은 문제인데, 호스트의 pg_dump(14)가 서버(16)보다 낮아 백업이 안 됐습니다. pg_dump는 서버 이상 버전이어야 합니다. 그래서 이미지엔 배포판 기본 패키지 대신 PGDG 저장소의 postgresql-client-16을 넣었습니다. **자신이 겪은 함정을 사용자가 못 밟게 이미지 차원에서 제거**한 것입니다.

명령 형태도 갈라야 했습니다. 로컬 개발의 백업 명령은 `docker exec`로 형제 컨테이너의 바이너리를 빌려 썼는데, 컨테이너로 배포되면 대상이 형제에서 사용자의 원격 DB로 바뀝니다. `docker` 프로파일(application-docker.yml)이 백업 명령을 "번들된 클라이언트로 대상에 직접 네트워크 접속"으로 덮어쓰고 로컬 설정은 그대로 둡니다.

## 21. 원커맨드와 릴리스, 태그가 곧 게시

사용자 경험은 Grafana를 기준으로 잡았습니다. `.env.example`를 복사해 채우고, 한 줄:

```bash
docker compose -f docker-compose.app.yml up -d   # 앱 + 전용 메타 DB
```

meta-db가 pg_isready로 Healthy가 된 뒤 앱이 뜨고, Flyway가 새 메타 DB에 스키마를 깔고, 관리자 계정이 부트스트랩됩니다(앞서 A1에서 세운 fail-closed 원칙 그대로, 기본 비밀번호를 하드코딩하지 않고 환경변수나 랜덤으로 생성합니다). 실측으로 빈 볼륨에서 health 200까지, 컨테이너 안에서 mysqldump 8.0.46 / pg_dump 16.14 / mongodump 100.17.0이 실제로 실행되는 것까지 확인했습니다.

게시는 GitHub Actions로 합니다. `v1.0.0` 태그를 push하면 테스트 게이트를 통과한 뒤 GHCR에 이미지가 올라갑니다(semver 태그 자동 파생). 사람이 하는 일은 태그 하나입니다.

## 22. 마치며, 시리즈를 하나의 매듭으로

버전을 1.0.0으로 올리며 시리즈도 여기서 접습니다. 1편의 문제 정의에서 시작해 추상화(1편), 채널(2편), 5기종 증명(2편), 운영 안전(3편), 적재적소(2편), 프로비저닝(3편), 자율 진단(2편), 심층 원인(2편), 보호장치와 제품화(3편)까지 왔습니다. 필요하다 생각한 기능은 전부 닫혔고, 남은 건 의도적 잔여(쿨다운 설정 외부화, Vault 동적 계정, 백업 원격 보관)로 문서에 정직하게 적어뒀습니다.

돌아보면 마지막 두 작업이 이 프로젝트의 성격을 제일 잘 보여줍니다. 마지막에 추가한 기능이 "내가 남에게 부하가 되지 않게 하는 장치"였고, 제품화의 첫 결정이 "사용자의 비밀은 사용자의 인프라를 떠나지 않는다"였습니다. 관제 도구는 힘이 세지는 쪽보다 **믿을 수 있게 되는 방향**으로 완성됩니다. 열 편을 관통한 결론입니다.

코드와 실측 기록 전체는 [GitHub](https://github.com/dj258255/dbtower)에 있습니다. 셀프호스트로 직접 띄워보실 수 있습니다.

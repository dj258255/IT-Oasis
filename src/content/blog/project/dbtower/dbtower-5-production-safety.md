---
title: '포트폴리오에서 프로덕션으로 — 운영 안전 8개 축을 닫다'
titleEn: 'From Portfolio to Production: Closing Eight Operational-Safety Gaps'
description: "이기종 DBMS 운영 관리 플랫폼 DBTower 5편. '네트워크에 닿는 누구나 인스턴스를 등록·삭제·백업할 수 있는 관제탑'이라는 결격 사유에서 시작해, 운영 안전을 8개 축으로 하나씩 닫은 기록. 세션+토큰 이중 인증과 역할 분리, 비밀번호 AES-256-GCM 암호화와 하위호환, ddl-auto=update가 만든 스키마 드리프트를 Flyway로 이관하다 밟은 'Boot 4 스타터 조용한 미실행' 함정, 권한 0에서 시작해 실측으로 확정한 최소 권한 계정(MongoDB clusterMonitor가 system.profile 읽기를 이미 갖고 있더라), 스케줄러 분산 락, 그리고 '테스트 안 한 백업은 백업이 아니다'라는 복원 검증까지 — 모든 개선을 '한계 인지 → 개선 → 실측 → 남은 한계 정직 명시' 아크로 남깁니다."
descriptionEn: "Part 5 of DBTower. Starting from a disqualifying flaw — anyone on the network could register, delete, or back up instances — I closed operational safety along eight axes: session+token dual auth with role separation, AES-256-GCM password encryption with backward compatibility, migrating ddl-auto=update schema drift to Flyway (and hitting Boot 4's silent-no-run trap), a least-privilege account confirmed by measurement (MongoDB's clusterMonitor already held system.profile read), a distributed scheduler lock, and backup restore verification. Every improvement recorded as 'recognize the limit → improve → measure → honestly state what remains.'"
date: 2026-07-04
tags:
  - Java
  - Spring Boot
  - DBRE
  - Spring Security
  - Flyway
category: project/dbtower
coverImage: /uploads/project/dbtower/cover.svg
draft: true
series: "dbtower"
seriesOrder: 5
---

## 0. 들어가며 — 인증 없는 관제탑은 관제탑이 아니다

[4편](/blog/project/dbtower/dbtower-4-five-engines)까지 DBTower는 다섯 기종을 하나로 묶고, 시점 비교·회귀 감지·MCP까지 다 갖췄어요. 그런데 냉정하게 보면 큰 구멍이 있었습니다. **인증이 없었어요.** 콘솔도 REST도 MCP도 전부 열려 있어서, 네트워크에 닿는 누구든 인스턴스를 등록·삭제하고 백업을 실행할 수 있었죠. DB 접속정보를 다루는 관리 도구로서 이건 가장 큰 결격 사유예요. 같은 장르의 Percona PMM이 서비스 계정과 접근 제어를 갖추는 이유가 여기 있고요.

여기서부터가 진짜 차이라고 느꼈습니다. 기능을 붙이는 건 포트폴리오지만, "이걸 남의 DB에 붙여도 되는가"를 닫는 게 프로덕션이거든요. 그래서 운영 안전을 8개 축으로 나눠 로드맵 Phase A로 올리고, 각 축을 **한계 인지 → 개선 → 실측 → 남은 한계 정직 명시**라는 같은 아크로 하나씩 닫았어요. 이번 편은 그 8개를 압축한 기록입니다.

## 1. A1 인증·인가 — 주체가 둘이라 인증도 둘이다

가장 먼저 닫아야 할 구멍이었어요. 설계의 출발점은 "이 플랫폼을 쓰는 주체가 둘"이라는 사실이었습니다. 사람(웹 콘솔)과 기계(MCP 클라이언트·자동화)는 인증 방식이 다를 수밖에 없어요.

| 주체 | 인증 | CSRF |
|---|---|---|
| 사람 (웹 콘솔) | 세션 폼 로그인, 비밀번호는 메타 DB에 BCrypt | 쿠키(XSRF-TOKEN) → SPA가 헤더로 되돌리는 표준 패턴 |
| 기계 (MCP·자동화) | Bearer 서비스 토큰 (상수 시간 비교) | 대상 아님 — 쿠키 세션이 없어 CSRF가 성립 안 함 |

인가는 역할 두 개로 나눴어요. 진단(조회·explain)은 VIEWER부터, **대상 DB를 바꾸는 행위**(등록/삭제/백업/정책)와 서비스 토큰 조회는 ADMIN만. 그리고 fail-closed 원칙 두 가지를 박았습니다. admin 초기 비밀번호를 `admin/admin`으로 하드코딩하지 않고 미설정 시 랜덤 생성 후 로그에 1회만 안내(Jenkins 방식), 서비스 토큰도 미설정 시 "무인증"이 아니라 "기동마다 랜덤 토큰" — 모르면 아무도 못 씁니다.

실측으로 인가 표를 그대로 확인했어요.

```
미인증:  GET /            -> 302 /login.html   (브라우저는 로그인으로)
         GET /api/...     -> 401               (API는 상태코드로)
viewer:  POST .../explain -> 200               (진단은 VIEWER부터)
         POST /api/instances(등록) -> 403
         GET  .../mcp-token         -> 403
admin:   GET  .../mcp-token         -> 200      (MCP 카드가 이걸로 등록 명령 완성)
기계:    Bearer 올바른 토큰 -> 200 / 틀린 토큰 -> 401
```

여기서 Spring Boot 4 / Security 7 함정을 둘 밟았어요. 하나는 **AntPathRequestMatcher가 아예 사라진 것** — Security 7에서 제거돼 람다 RequestMatcher로 대체했습니다. 다른 하나는 **로그인하면 CSRF 토큰이 회전한다**는 것. 세션 고정 방어로 인증 성공 시 기존 CSRF 토큰이 무효화되는데, curl로 E2E를 짜면서 로그인 전 토큰을 재사용했다가 403을 맞고 알았어요(브라우저 SPA는 매 요청 쿠키를 다시 읽으니 자연히 무관합니다). 보안 테스트 10건으로 이 인가 표를 코드로 고정해서, 누가 규칙을 바꾸면 CI가 잡게 했습니다.

![로그인 — 최초 기동 admin 부트스트랩, 기본 비밀번호 하드코딩 없이](/uploads/project/dbtower/login.png)

## 2. A2 비밀번호 암호화 — 평문 저장을 닫다

등록된 인스턴스의 비밀번호가 메타 DB에 **평문**으로 저장되고 있었어요. 메타 DB가 유출되면 관리 대상 DB 전체의 열쇠가 함께 새는 구조죠. AES-256-GCM으로 암호화했습니다. 랜덤 IV 12바이트를 암호문 앞에 붙이고 128비트 태그, 키는 `DBTOWER_ENCRYPTION_KEY`(base64 32바이트) 환경변수로만.

재미있었던 건 **하위호환**이에요. JPA `AttributeConverter`에 `enc:v1:` 접두사 디스패치를 뒀습니다. 기존 평문 행은 마이그레이션 없이 그대로 읽히고, 다음 저장 때 자연스럽게 재암호화돼요. `v1`을 붙인 건 나중에 키·알고리즘을 교체할 여지고요.

그리고 키 정책은 A1과 **일부러 비대칭**으로 갔어요. API 토큰은 미설정 시 랜덤 생성이 안전(fail-closed)이지만, 암호화 키를 랜덤 생성하면 오히려 위험합니다 — 재기동하면 기존 암호문을 영영 못 풀거든요. 그래서 키 미설정은 WARN+평문(과도기), 잘못된 키는 기동 거부, 키 없이 암호문을 만나면 예외. "조용히 평문으로 새는" 경로만은 없게 했어요.

```
기존 평문 행:  id 1·7·8 health 전부 up  — 하위 호환 확인
신규 등록:     raw 컬럼 = enc:v1:PflkG... (psql로 직접 확인)
테스트:        SecretCipher 8건(변조 시 복호 실패 포함) + Converter 6건 + JPA 통합 2건
```

## 3. A3 Flyway — 4편에서 밟은 그 함정의 정식 해결

[4편](/blog/project/dbtower/dbtower-4-five-engines)에서 MongoDB를 등록하다 500을 맞았던 그 일 기억하시나요. Hibernate가 처음 만든 `CHECK (type IN ('MYSQL','POSTGRESQL','MSSQL'))` 제약을 `ddl-auto: update`가 갱신하지 않아서, enum에 값을 추가하는 게 배포가 아니라 스키마 마이그레이션이 되는 문제였어요. 그때는 수동 ALTER로 풀었는데, 이번에 스키마의 단일 권위를 Flyway로 정식 이관했습니다.

`V1__baseline.sql`에 테이블 5개(5기종 CHECK 포함)를 엔티티 소스와 라이브 스키마 `\d` 대조로 작성하고, `ddl-auto`를 `update`에서 `validate`로 바꿨어요. 이제 엔티티-스키마 불일치는 조용한 드리프트가 아니라 **부팅 실패**가 됩니다. 기존 DB는 baseline-on-migrate로 비파괴 도입했고요.

```
기존 DB: instances 6 · snapshots 46,711 무손상 — 실측 확인
빈 스크래치 DB: V1이 실제 실행되어 기동까지 검증
```

그런데 여기서 **Boot 4다운 함정**을 하나 더 밟았어요. `flyway-database-postgresql` 의존성만 넣으면 부팅은 되는데, Flyway가 **조용히 실행되지 않습니다**. 로그 0건, history 테이블 없음. Boot 4의 자동구성 모듈화로 `spring-boot-starter-flyway`가 따로 필요했어요. "조용한 미실행"은 에러보다 나쁜 실패 양식이에요 — 다 된 줄 알거든요. 예전에 MySQL digest 절단으로 겪었던 것과 같은 계열의 함정이었습니다.

## 4. A4 스냅샷 보존 — 무한 적재를 닫다

시점 비교의 재료인 60초 주기 스냅샷이 무한히 쌓이고 있었어요. 이 시점 실측이 이틀에 50,960행 — 방치하면 메타 DB가 플랫폼 자신의 병목이 됩니다(AWS Performance Insights도 기본 보존이 7일이에요). 그래서 1시간 주기로 cutoff(기본 7일) 이전을 JPQL 벌크 DELETE 한 문장으로 지우게 했습니다. 수십만 행을 영속성 컨텍스트에 올리지 않으려고 벌크로 갔고, `@Modifying(clearAutomatically=true)`로 1차 캐시 불일치도 막았어요. `retention-days <= 0`이면 보존 무제한 스위치고요.

## 5. A6 감사 로그 — 누가 언제 무엇을 했나

A1로 인증은 생겼는데, 인증된 사용자가 **무엇을 했는지** 기록이 없었어요. 접근 통제만큼 사후 추적도 관리 도구의 기본 요건이죠. audit 모듈을 신설해서 `/api/**`의 POST/PUT/DELETE(상태 변경·explain·백업)와 로그인 성공/실패를 기록했습니다. GET 조회는 폴링 노이즈라 뺐고요.

설계에서 사각지대가 하나 있었어요. 인가 거부(403)는 `DispatcherServlet` 앞에서 끝나서 인터셉터가 못 봅니다. 그래서 인터셉터(인가 통과 요청) + `AuthorizationDeniedEvent` 리스너(403 거부) 조합으로 메웠어요.

```
POST /api/instances/8/explain 실행 후 GET /api/audit ->
  2026-07-04T15:10:40  api-token  ADMIN  POST .../8/explain -> 200 (145ms)
```

여기서도 Security 7.1 함정이 있었어요. `InteractiveAuthenticationSuccessEvent`가 더 이상 `AuthenticationSuccessEvent` 하위 타입이 아니고, `AuthorizationFilter`가 이벤트에 싣는 객체가 `RequestAuthorizationContext`가 아니라 `HttpServletRequest`였습니다. 첫 테스트가 실패해서 발견했어요.

![감사 로그 — 누가 언제 무엇을 했나, 사용자·action·결과·기간 동적 필터](/uploads/project/dbtower/audit.png)

## 6. A8 최소 권한 계정 — 권한 0에서 시작해 실측으로 확정

지금까지 DBTower는 root/sa/system급 계정으로 대상 DB에 붙었어요. 관제 도구는 조회에 필요한 **최소 권한만** 가진 전용 계정으로 붙어야 합니다(Datadog DBM 등의 관행). 문제는 "최소가 얼마냐"를 추측하면 반드시 틀린다는 거예요. 그래서 권한 0인 계정을 먼저 만들어 등록하고, 기능별 API를 호출해 **DB가 돌려주는 권한 에러 원문**을 하나씩 수집하며 필요한 것만 더했습니다.

| 기종 | 확정된 최소 집합 |
|---|---|
| MySQL | `sample.*` + performance_schema digest + `mysql.slow_log` + REPLICATION CLIENT/SLAVE |
| PostgreSQL | LOGIN + `pg_read_all_stats` (pg_monitor 전체는 과함) |
| SQL Server | `VIEW SERVER PERFORMANCE STATE` 한 줄 (2022 세분화 권한) |
| Oracle | CREATE SESSION + SELECT_CATALOG_ROLE + 대상 테이블 READ |
| MongoDB | read@sample + clusterMonitor@admin |

실측이라 예상과 다른 지점이 나왔어요. **MongoDB의 read 롤은 `system.profile`을 못 읽습니다**(Unauthorized). 커스텀 롤을 만들어야 하나 했는데, `showPrivileges`로 확인해 보니 **clusterMonitor가 그 권한을 이미 갖고 있어서** 별도 롤이 불필요했어요. 또 하나, PostgreSQL은 권한이 없어도 query-stats가 HTTP 200으로 성공하되 전 행이 `<insufficient privilege>`로 **조용히 저하**됩니다. 에러가 아니라 빈 데이터라 더 위험한 형태였어요. 백업은 관리 작업이라 이 조회 계정 범위 밖이라는 경계도 문서에 박았습니다.

## 7. A5 HA 분산 락 — 두 대 띄우면 무너지는 전제

`@Scheduled` 폴러 4종(통계 수집·회귀 감지·보존 삭제·백업)이 전부 "단일 프로세스" 전제로 짜여 있었어요. 앱을 2개 이상 띄우면 모든 노드가 동시에 같은 대상 DB를 수집하고, 회귀 감지 쿨다운이 인메모리라 노드마다 따로 놀아 같은 회귀를 중복 알림합니다. ShedLock(JdbcTemplate 프로바이더)으로 폴러마다 고정 이름 락을 걸어 한 시점에 한 노드만 실행하게 했어요. `usingDbTime`으로 노드 JVM 클럭이 아니라 메타 DB 시계로 만료를 판정하게 한 게 포인트예요(HA 클럭 스큐 방어).

```
2노드(18081+18082, 공유 메타DB, 15초 주기, 약 90초):
  NODE A: 스냅샷 수집 = 54건 / NODE B: = 0건
  NODE B: "Not executing 'snapshot-collect'. It's locked." (매 틱)
```

그런데 여기서 **정직한 잔여 한계**를 남겼어요. RegressionDetector 쿨다운 Map은 여전히 노드별 인메모리입니다. 락 stickiness로 정상 시엔 한 노드가 계속 이겨 중복이 급감하지만, 락 핸드오프(failover) 직후엔 새 승자의 Map이 비어서 이미 보낸 회귀를 1회 재알림할 수 있어요. 완전 해결은 쿨다운을 메타 DB로 외부화하는 건데, 잔여 리스크를 "중복 1회"로 판단해 이번엔 수용했습니다. 이런 걸 숨기지 않고 적어두는 게 운영 도구의 신뢰라고 생각해요.

## 8. A7 백업 복원 검증 — 테스트 안 한 백업은 백업이 아니다

지금까지 "백업했다"까지만 있고 "그 백업이 복원되는가"는 검증하지 않았어요. 3-2-1-1-0 규칙의 "0 errors"가 요구하는 지점이죠. 핵심 원칙은 두 가지였습니다. **못 하는 것을 통과로 위장하지 않는다**, 그리고 **복원은 반드시 격리된 임시 대상**(`dbtower_verify_<타임스탬프>`)에만 — 원본은 절대 안 건드린다. 그래서 상태를 3값(VERIFIED/FAILED/UNSUPPORTED)으로 뒀어요.

| 기종 | 수준 | 방법 |
|---|---|---|
| MySQL·PostgreSQL·MongoDB | VERIFIED | 임시 DB에 실제 복원 후 테이블/컬렉션 수 확인, drop |
| SQL Server | VERIFIED(VERIFYONLY) | 서버 측 .bak라 파일 접근 불가 → RESTORE VERIFYONLY로 무결성만 |
| Oracle | UNSUPPORTED | Data Pump 서버 측 산출물 — 자동 검증 범위 밖, 통과 위장 안 함 |

```
PostgreSQL: VERIFIED — 임시 DB 복원 성공, 복원 테이블 3개, 임시 DB 정리 확인
Oracle:     UNSUPPORTED — "IMPDP 필요, 범위 밖" (정직 표기)
FAILED 분기 증명: 없는 덤프 verify -> FAILED (러버스탬프 아님)
임시 검증 DB 잔여물: 0, 원본 sample DB 불변
```

## 9. 결산 — 8개 축을 닫고 보니

인증 없는 관제탑에서 시작해 운영 안전 8개 축을 전부 닫았어요.

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

테스트는 81건까지 늘었고 마이그레이션은 V1~V4가 됐어요. 이 8개 중 서로 다른 모듈에 걸친 것들은 git worktree로 브랜치를 나눠 병렬로 개발했습니다(스키마 권위를 바꾸는 Flyway를 마지막에 병합).

한 가지 더. "기종 분기는 팩토리 한 곳", "플랫폼 코드는 인터페이스만 안다"는 주장을 1편부터 문서에 써 왔는데, 문서 속 아키텍처는 강제력이 없어요. 그래서 Spring Modulith를 도입해 패키지=모듈로 선언하고 순환 의존을 빌드에서 실패시키게 했더니, 첫 실행에서 바로 순환 2개(registry↔operator, insight↔alert)가 잡혔습니다. 좋은 실패였어요 — 깨끗하다고 믿었던 구조에 순환이 실재했다는 뜻이니까요. 의존 역전으로 풀고 나니 이제 누가 경계를 넘으면 CI가 빨간불이 됩니다.

이걸로 "포트폴리오에서 프로덕션으로" 넘어가는 축은 대부분 닫았어요. 다음 편은 방향이 조금 달라요 — DBA가 장애 때 매일 보는 화면(Wait Event)을 붙이고, "이 다섯 기종을 JPA와 Native Query로 통일하면 되지 않냐"는 질문에 왜 그러지 않았는지를 적재적소라는 답으로 정리합니다. 코드와 실측 기록 전체는 [GitHub](https://github.com/dj258255/dbtower)에 있습니다.
</content>
</invoke>

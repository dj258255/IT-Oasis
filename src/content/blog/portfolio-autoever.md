---
title: '범수 포트폴리오'
description: 'DBMS 운영 관리 플랫폼 직무를 위해 정리한 포트폴리오입니다. 이기종 5기종 관제 플랫폼 DBTower, 관측 데이터 장기 분석 파이프라인 DBTower-lakehouse, 오픈소스 기여(Spring Boot, Apache Lucene)를 아키텍처와 실측 수치, 재현 기록과 함께 담았습니다.'
date: 2026-07-13T00:00:00.000Z
tags:
  - Portfolio
  - Backend
  - DBRE
  - DBMS
  - Platform Engineering
category: portfolio
coverImage: /uploads/project/dbtower/cover.svg
draft: false
unlisted: true
---

# 범수 포트폴리오

**주장을 실측으로 증명하는 백엔드 엔지니어입니다.** 모든 프로젝트에 전/후 수치와 재현 기록(VERIFICATION)이 있습니다.

**Backend**: Java 21, Spring Boot, JPA / JdbcTemplate, PostgreSQL, MySQL, MongoDB
**Data Pipeline**: Python, Airflow, dbt, DuckDB / DuckLake, MinIO(S3), Parquet, Metabase
**Infra / 검증**: Docker, Kubernetes(CloudNativePG), Ansible, GitHub Actions CI, k6, Prometheus, JUnit / pytest

## AI를 쓰는 방식

- **안전 설계**: MCP 서버를 직접 구현하되 AI에는 read-only 도구 화이트리스트만 열어 대상 DB 변경 0을 구조로 보장
- **Plan-First 협업**: 변경 범위·영향·테스트 계획을 먼저 세우고 사람이 승인한 뒤에만 구현
- **컨텍스트 엔지니어링**: 프로젝트 규칙·과거 결정을 CLAUDE.md와 메모리 파일로 관리
- **역할 분리**: 작업한 에이전트가 자기 결과를 채점하지 않도록 탐지·수정·검증을 별도 에이전트로 분리
- **검증이 기본값**: AI가 만든 코드도 같은 관문(테스트 CI·전/후 실측)을 통과해야 채택

## 오픈소스 기여: Spring Boot · Apache Lucene

**쓰는 프레임워크의 문제를 직접 고쳐 반영된 기여 2건. 남의 코드를 읽고 직접 재현해 검증하는 눈을 여기서 배웠다.**

### Spring Boot: Kotlin 테스트 API 사용성 개선 · [PR #49063](https://github.com/spring-projects/spring-boot/pull/49063)

**reified 확장**으로 `TestEntityManager`의 Kotlin 사용성을 개선, 메인테이너 커밋으로 반영되어 **Spring Boot 4.1.0-M2 New Features에 기록**

- 문제: Kotlin 테스트에서 `find(Foo::class.java, id)`처럼 Java class reference를 직접 전달해야 했음
- 해결: reified 확장 함수(`find<Foo>(id)`, `persistAndGetId<Long>(entity)` 등)를 추가해 간결하고 타입 안전하게
- 검증: 각 확장이 기존 API로 올바르게 위임되는지 Mockito 단위 테스트로 증명해 제출

```kotlin
// before — Java class reference 직접 전달
val foo = testEntityManager.find(Foo::class.java, id)
// after — reified 확장 함수
val foo = testEntityManager.find<Foo>(id)
```

### Apache Lucene: IndexWriter 초기화 실패 시 리소스 누수 수정 · [PR #15675](https://github.com/apache/lucene/pull/15675)

**실패 경로의 스레드 풀 누수**를 잡아 **Apache Lucene main branch에 merge, CHANGES.txt에 bug fix로 기록**

- 문제: `IndexWriter` 생성자 실패 시 writeLock만 닫고 `MergeScheduler`를 닫지 않아 `ThreadPoolExecutor`가 종료되지 않음
- 해결: 실패 경로에서 `MergeScheduler`까지 함께 정리하도록 수정
- 검증: `OpenMode.APPEND`+빈 디렉터리로 초기화 실패를 재현하고, `close()` 호출을 `AtomicBoolean`으로 확인하는 회귀 테스트 추가

```java
// 회귀 테스트 요지 — 초기화 실패 재현 후 close 호출 검증
expectThrows(IndexNotFoundException.class, () -> new IndexWriter(emptyDir, cfg));
assertTrue(schedulerClosed.get());
```

## DBTower: 이기종 DBMS 5종 관제·진단 플랫폼

**MySQL부터 MongoDB까지, 이기종 DBMS 5종의 등록·진단·백업·감시를 인터페이스 하나 뒤에서 처리한다.**

- 기간: 2026.03 ~ 2026.07 · 개인(100%) · [GitHub](https://github.com/dj258255/dbtower) · [블로그 시리즈 0~13편](/blog/project/dbtower/dbtower-0-overview)
- 스택: Java 21, Spring Boot, PostgreSQL(메타), JdbcTemplate·Mongo Driver·JDBC batch(적재적소), MCP(JSON-RPC 2.0 직접 구현), Flyway, ShedLock, Docker, k6
- 규모 가정: 관제 도구라 실사용 트래픽은 수십 RPS를 예상하고 단일 노드 셀프호스트 운용을 전제했다. 그래도 상한은 k6로 실측해 뒀다(**2,832 req/s**)
- 측정 환경: 로컬 Docker(Apple Silicon) 위 대상 DB 5기종. 모든 수치는 개선 전을 먼저 재고 고친 뒤 다시 잰 전/후 실측이며, 재현 절차는 VERIFICATION.md 62개 절에 보존

### 왜 만들었는가

**DB에 이슈가 나면 개발자는 흩어진 도구를 오가다 결국 DBA에게 묻고, DBA는 같은 질문에 반복해서 답한다. 관리 대상 DB가 늘수록 사람 손이 선형으로 늘어나는 구조를 인터페이스 하나로 끊고 싶었다.**

- CPU는 모니터링 대시보드에, 쿼리 통계는 기종마다 다른 시스템 뷰에, 실행계획은 콘솔에 흩어져 있다. 백업·모니터링·계정 관리 구문도 5기종이 전부 다르다
- 업계가 이미 정의한 문제이기도 하다. 국내 대형 서비스 기업들이 사내 DB 어드민 플랫폼을 직접 만들어 운영하고, AWS가 CloudWatch 위에 RDS Performance Insights를 별도 층으로 얹은 이유가 같은 문제의식이다
- **범위 결정**: 메트릭 수집 층(Prometheus·Grafana)은 이미 검증된 스택이라 다시 만들지 않았다. DBTower가 맡는 건 그 위의 층, "그 시각에 어떤 쿼리가 원인이고, 실행계획이 왜 나쁘고, 무엇을 해야 하나"이다

### 누구에게 도움이 되는가

- **DBA에게 반복 문의하던 개발자**: 헬스 스코어(어느 인스턴스가 나쁜가) → 시점 비교(어느 쿼리가 문제인가) → 실행계획 규칙(계획이 왜 나쁜가) → 심층 진단(옵티마이저는 왜 속았나) → 처방(무엇을 고치나)까지 한 화면에서 스스로 분석한다
- **같은 질문에 반복 답하던 DB팀**: "DB팀에 문의" 버튼이 쿼리·실행계획·규칙 지적·AI 분석을 Discord 카드 한 장으로 묶어 보낸다. 받는 쪽이 맥락을 다시 물을 필요가 없다
- **배포 형태**: 설치형(셀프호스트)으로 배포한다. DB 접속 정보를 외부 서비스에 맡기지 않아도 되고, 사설망 안의 DB에도 그대로 닿고, 별도 서버 비용도 들지 않기 때문이다(Grafana·PMM과 같은 모델). GHCR 공개 이미지를 받아 compose 한 번이면 뜬다

### 아키텍처

![DBTower 전체 구조: 소비자 차이는 채널 뒤로, 기종 차이는 DbmsOperator 뒤로, 기술 차이는 각자의 제자리로](/uploads/project/dbtower/architecture-full.svg)

- 소비자 3채널(웹 콘솔·MCP·웹훅) → 플랫폼 코어(수집 폴러·시점비교·회귀감지·헬스스코어·자율진단) → `DbmsOperator` 인터페이스 → 기종별 구현체 5개
- 경계는 "운영 행위"에 있다. SQL 없는 MongoDB가 같은 인터페이스로 들어온 것이 그 증거다
- AI 채널은 안전을 구조로 보장한다. MCP 서버를 JSON-RPC 2.0 스펙으로 직접 구현해 도구 13종을 노출하되, AI에는 **read-only 도구 화이트리스트만** 열어 대상 DB 변경 0을 코드 레벨에서 강제했다

### 운영 상세 아키텍처

![상세 아키텍처: 컨테이너 경계·포트, 폴러와 채널의 실제 배선, 메타 DB와 대상 DB 5기종](/uploads/project/dbtower/architecture-detail.svg)

### 식별에서 문의까지 이어지는 진단 흐름

![진단 흐름: 문제 쿼리 식별 → 원인 분석 → 공유·DB팀 문의](/uploads/project/dbtower/insight-flow.svg)

웹 콘솔의 "DB팀에 문의" 버튼은 현재 패널의 쿼리·실행계획·규칙 지적·AI 분석을 한 메시지로 묶어 Discord/Slack 웹훅으로 보낸다.

![DB팀 문의 Discord embed 실물](/uploads/project/dbtower/inquiry-discord.png)

자동 경보(회귀·이상·플랜 플립)가 플랫폼이 사람에게 미는 push라면, 문의는 사람이 트리거하는 push라서 같은 웹훅 어댑터를 재사용한다.

### 기능 지도

| 영역 | 기능 |
|---|---|
| 관측 | 기종별 쿼리 통계·슬로우 쿼리 수집 폴러 · Wait Event · 복제 상태·레플리케이션 슬롯 · p95(실측/추정/미지원 라벨 분리) |
| 진단 | 통합 헬스 스코어 → 시점 비교(구간 차분) → 회귀·이상 감지(요일x시간대 z-score) → 플랜 플립(60초 내) → 실행계획 규칙 → 심층 진단(추정 vs 실제) → 원클릭 재진단 → 처방·Advisors |
| 운영 | 백업 정책·복원 자동 검증(VERIFIED/FAILED/UNSUPPORTED) · SLO/에러 버짓 · FinOps 신호 · 감사 로그 · 최소 권한 계정 |
| 채널 | 웹 콘솔(의존성 0 정적 SPA) · MCP 도구 13종(JSON-RPC 2.0 직접 구현) · 웹훅 경보와 DB팀 문의(Discord embed) |
| 프로비저닝(IaC) | DB가 태어나는 순간 자동 등록: K8s(CloudNativePG) 프로비저닝→등록→health up e2e 완주 · Ansible 멱등 등록(changed=0) · Terraform validate. 도구 셋이 멱등 등록 PUT 하나로 수렴 |
| 안전 | 쿼리 타임아웃 15s · 지수 백오프 · 인스턴스당 풀 상한 · AI read-only 화이트리스트 · 스택 쿼리 차단 |

### 백업 정책: 추상은 하나, 실행 모델은 네 갈래

백업 정책(주기·보존·검증)은 플랫폼이 추상 수준에서 관리하고, 실행은 기종별 구현체가 각자 지원하는 방식으로 수행한다. 같은 "FULL 백업" 한 마디가 실제로는 네 가지 실행 모델로 갈라진다.

| 실행 모델 | 기종 | 비밀번호 전달 |
|---|---|---|
| 외부 CLI + 환경변수 | MySQL(mysqldump), PostgreSQL(pg_dump) | `MYSQL_PWD` / `PGPASSWORD` |
| 외부 CLI + stdin | MongoDB(mongodump) | `--config /dev/stdin` |
| 서버 사이드 SQL | SQL Server | 필요 없음 (`BACKUP DATABASE`) |
| 서버 사이드 API | Oracle | 필요 없음 (`DBMS_DATAPUMP` PL/SQL) |

- mongodump의 stdin 설정에는 비밀번호에 개행을 넣으면 YAML의 다른 키를 주입할 수 있는 구멍이 있었다. 제어 문자를 거부하고 작은따옴표 스칼라 이스케이프를 넣어 막고, 주입 시도가 거부되는 것을 테스트로 고정했다
- 백업의 성공 판정은 로그가 아니라 복원 검증이다. VERIFIED/FAILED/UNSUPPORTED 3값으로 표기하고, 3-2-1 원칙의 S3(MinIO) 오프사이트 사본까지 자동화했다

### 데이터 모델

![메타 DB 데이터 모델: 인스턴스 레지스트리·스냅샷·베이스라인·감사 테이블의 관계](/uploads/project/dbtower/erd.svg)

### 1. 새 기종을 추가해도 플랫폼은 그대로이도록 경계를 설계하고 실증했다 ([4편](/blog/project/dbtower/dbtower-4-five-engines))

- **문제**: 다섯 DBMS는 같은 "쿼리 통계"를 주는 방식이 전부 다르다(performance_schema / pg_stat_statements / DMV / V$SQL / system.profile). 기종이 늘 때마다 플랫폼 코드가 함께 커지면, 관리 대상이 늘수록 사람 손이 비례해 늘어나는 구조를 도구가 그대로 물려받는다
- **판단**: 경계를 SQL 문법이 아니라 "운영 행위"(통계 조회·실행계획·백업)에 그으면, SQL도 JDBC도 없는 MongoDB까지 같은 틀에 들어온다고 봤다
- **실증**: 성격이 정반대인 Oracle과 MongoDB를 실제로 추가했다. 수집·시점비교·회귀감지·웹 콘솔·MCP 전부 **코어 경로 0줄 수정**. 이후 능력 확장(Wait Event·플랜플립·p95)도 "메서드 1개 추가"의 반복이었다. 경계를 처음에 잘 그어둔 덕을 계속 봤다

### 2. "인덱스가 있는데 왜 안 타요"에 옵티마이저가 속은 이유까지 답했다 ([9편](/blog/project/dbtower/dbtower-9-deep-diagnosis))

- **정상 상태**: `code VARCHAR` 컬럼에 B-Tree 인덱스. 쿼리만 봐서는 멀쩡해 보인다
- **문제 발견**: `WHERE code = 12345`(따옴표 누락)가 풀스캔을 탄다. 추정 EXPLAIN만으로는 옵티마이저가 "왜 속았는지" 보이지 않는다
- **원인 분석**: 추정 행수와 실제 행수의 괴리를 봐야 한다. 실제 실행계획 취득 경로가 5기종 전부 달라 각각 구현했다(EXPLAIN ANALYZE / ANALYZE,BUFFERS / DISPLAY_CURSOR / STATISTICS XML / executionStats). actual rows는 루프당 평균이라 loops를 곱해야 하는 함정은 단위 테스트로 고정했다
- **해결**: 추정 300행 vs 실제 1행, **괴리 300배**에서 암시적 형변환을 지목. 수정안 SQL의 원클릭 재진단 before/after로 괴리 해소와 **Index lookup 전환**까지 확인했다
- **정합성 위험까지 증명**: 수정 전의 "실제 1행"이 사실 `'012345'`가 캐스팅으로 잘못 매칭된 행이었다. 형변환은 성능 문제로 보이지만 실제로는 정확성 문제였다. 조회면 오답이고, UPDATE/DELETE였으면 데이터 사고다

![심층 진단 실물: 수정 전(괴리 300배·풀스캔)과 수정 후(괴리 없음·Index lookup) before/after](/uploads/project/dbtower/deep-before-after.png)

### 3. 만든 진단 도구를 자기 자신에게 먼저 쓴다

- **발견**: 메타 저장소 PostgreSQL을 DBTower 자신의 관리 대상으로 등록했더니, 자기 스냅샷 조회 쿼리가 자기 화면의 슬로우 쿼리 목록에 떴다(50만 행 적재 상태)
- **원인**: 자기 explain API로 진단하자 자체 분석기가 "Seq Scan 발생, 인덱스를 검토하세요"라고 자기 자신을 지적했다
- **해결**: 등치 조건인 `instance_id`를 선두에 둔 복합 인덱스를 추가하고 같은 API로 재진단, "규칙에 걸린 비효율 신호가 없습니다"
- **결과**: **21.269ms → 0.062ms(343배)**. 개선을 측정한 도구가 곧 내가 만든 기능이라는 순환이, 이 플랫폼이 실제로 동작한다는 증거다

### 성능 개선 기록

| 문제 | 원인 | 해결 | 전/후 |
|---|---|---|---|
| 수집(폴링)마다 지연 | 매 수집 새 커넥션 생성으로 TCP+인증 핸드셰이크 반복 | 인스턴스별 HikariCP 풀(대상 DB 보호를 위해 상한 설정) | **47.1 → 11.8ms (4.0배)** |
| 스냅샷 대량 저장이 느림 | JPA saveAll이 행별 INSERT 발행 | JDBC batch + `reWriteBatchedInserts` | 행당 **1.51 → 0.11ms (13.8배)** |
| 자기 조회가 슬로우 쿼리 | 50만 행 Seq Scan(인덱스 없음) | `instance_id` 선두 복합 인덱스(서사 3) | **21.269 → 0.062ms (343배)** |
| 긴 쿼리 통계가 하나로 뭉개짐 | `max_digest_length` 1024에서 digest 절단 | 4096 상향 | side-by-side 재현·해소 |
| 처리 상한을 모름 | 배포 전 부하 검증 부재 | k6 부하 테스트(10 VU 30s) | **2,832 req/s · P95 5.86ms · 실패 0** |

### 판단과 트레이드오프

- **데이터 접근 적재적소**: 메타 CRUD는 JPA, 스냅샷 대량 쓰기는 JDBC batch, SQL이 없는 MongoDB는 드라이버 직접. 하나의 ORM으로 통일하는 편함 대신 경로별 비용으로 선택했다
- **p95 세 라벨**: MySQL은 히스토그램을 구간 차분해 실측(누적 0.48ms가 가리던 최근 구간 0.19ms를 노출), PostgreSQL은 평균+1.645σ 추정 표기, 원자료 없는 기종은 UNSUPPORTED. 그럴듯한 단일 숫자보다 소스가 다른 숫자를 섞지 않는 쪽을 택했다
- **최소 권한 계정**: 권한 0 계정으로 시작해, DB가 돌려주는 권한 에러 원문을 수집하며 필요한 것만 추가해 확정했다. MongoDB는 커스텀 롤을 만들려다 clusterMonitor가 이미 충분함을 확인했고, PostgreSQL은 pg_monitor 전체가 아니라 pg_read_all_stats로 좁혔다. 권한이 부족하면 PG가 에러 대신 HTTP 200에 전 행 insufficient privilege를 채워 조용히 저하되는 함정도 이때 실측으로 잡았다
- **Terraform은 validate까지**: 실제 RDS apply는 AWS 자격증명과 과금이 필요해 실행하지 않았고, 문서에 그대로 적었다. 같은 등록 흐름의 완주는 K8s와 Ansible에서 확인했다

### 4. 결함 20건 이상을 스스로 감사하고 전부 고치지는 않았다 ([13편](/blog/project/dbtower/dbtower-13-hardening-arc))

- **4축 병렬 감사**: 기능이 쌓인 뒤 동시성·기종별 정확성·보안·수명주기 네 축으로 코드를 정독하고 OWASP·CWE·벤더 문서와 대조해 결함 20건 이상을 찾았다
- **FIX/SKIP 분리**: 전부 고치지 않았다. "안 고쳐도 되는 걸 고치는 것도 부채"라서 재검증 후 FIX와 SKIP을 근거와 함께 갈랐다(예: MySQL 5.7 비호환은 8.0+ 명시 지원으로 SKIP). 수정에는 신규 단위 테스트 28건
- **가장 심각한 결함(XXE)**: 데드락·실행계획 XML을 파싱하는 세 곳이 외부 DTD 로드 차단만 걸어놨는데, OWASP가 "불충분"이라 명시한 조합이다. 조작된 XML을 주는 악성 대상 DB가 있으면 DBTower 호스트가 외부로 요청을 날리는 블라인드 SSRF가 가능했다. 같은 저장소의 DeepAnalyzer는 이미 DOCTYPE 선언 자체를 거부(disallow-doctype-decl)하도록 올바르게 막고 있었으니, 설계를 몰랐던 게 아니라 나중에 만든 파서에 기준을 안 옮긴 일관성 누락이었다. 세 곳을 같은 설정으로 통일하고, XXE 페이로드가 파싱에서 거부되는 것(외부 fetch 없음)을 단위 테스트로 고정했다
- **개선이 만든 부채**: 인스턴스당 풀 상한이 낮은 상태에서 폴러 8개 이상이 붙자 대기 → 타임아웃 → "죽은 대상" 오인 → 허위 "수집 정지" 경보로 증폭됐다. 직전에 성능을 위해 넣은 수집 병렬화가 이 경합을 키웠다. 풀 상한을 올리고 설정값으로 분리해 차단했다
- **실측이 감사를 이김**: "slow_log는 마이크로초를 저장 안 해 복구 불가"라는 감사 결론을 원본 테이블 실측이 뒤집었다(`00:00:00.600594` 저장 확인, 0.6초 쿼리를 600.594ms로 정확 표시). 감사 결론도 실측으로 한 번 더 확인해야 했다

### 미지원은 UNSUPPORTED로 표기하고, 진단 부하는 상한으로 막는다

- **정직한 라벨**: 백업 복원 검증은 VERIFIED/FAILED/**UNSUPPORTED** 3값, p95는 실측·추정·미지원 소스 라벨을 섞지 않는다. 관제 도구의 출력은 운영 결정의 입력이기 때문이다
- **보호장치**: 진단이 부하가 되지 않게 쿼리 타임아웃 15s·지수 백오프·인스턴스당 풀 상한. MongoDB는 정석인 드라이버 전역 타임아웃(CSOT)이 심층 진단의 명령별 시간 상한(maxTimeMS)을 덮어쓰는 간섭이라 일부러 배제하고, 이유를 코드 주석으로 남겼다

### 대표 수치 (성능 항목은 전부 전후 비교 실측, 재현 기록 VERIFICATION.md 62개 절)

| 항목 | 수치 |
|---|---|
| 새 기종 추가 비용 | Operator 구현체 추가만으로 핵심 파이프라인(수집·비교·감지·콘솔·MCP) **0줄 수정** |
| 시점 비교·회귀 감지 | 호출량 **+461%** · 읽은 행수 **+852%** · 신규 쿼리 검출, 같은 비교를 폴러가 자동 실행 |
| 플랜 플립 감지 | 인덱스 드랍을 다음 폴링 주기(60초)에 감지, 동반 레이턴시 회귀 **+23,249%**(PG e2e, 계획 shape 획득은 5기종) |
| 심층 진단 | 추정 300행 vs 실제 1행 괴리 → 형변환 지목 → 원클릭 재진단 before/after |
| 성능 개선 | HikariCP **4.0배**(47.1→11.8ms) · JDBC batch **13.8배**(행당 1.51→0.11ms) · 자기 진단 **343배**(21.269→0.062ms) |
| 부하 상한 | k6 10 VU 30s에서 **2,832 req/s, P95 5.86ms, 실패 0** |
| 품질 | 테스트 **360건** CI 게이트 · VERIFICATION **62절** · 자체 감사 결함 20+건 FIX/SKIP |
| 배포 | GHCR **멀티아치(amd64+arm64) v1.1.0** 공개, 원커맨드 셀프호스트 |

### 배운 것

- 추상화 경계는 기술(SQL)이 아니라 도메인 행위에 그어야 이기종이 들어온다. 경계가 맞는지는 문서로는 알 수 없고, 정반대 성격의 구현체를 실제로 추가해 봐야 증명된다.
- 관제 도구의 출력은 누군가의 운영 결정의 입력이 된다. 못 하는 것을 UNSUPPORTED로 정직하게 표기하는 쪽이 과장된 능력 표기보다 도구의 신뢰를 만든다.
- 진단 기능은 그 자체가 대상에 주는 부하까지 설계 범위다. "측정이 대상을 바꾸면 안 된다"는 감각을 타임아웃·백오프·풀 상한으로 코드에 새겼다.
- 이번엔 성능을 위한 병렬화가 풀 경합을 되살렸다. 고친 자리뿐 아니라 그 옆까지 다시 봐야 했다.

### 링크

- **GitHub 저장소**: [github.com/dj258255/dbtower](https://github.com/dj258255/dbtower) (재현 기록 docs/VERIFICATION.md 62개 절)
- **블로그 총정리 0편**: [설계 판단과 실측 과정 전체, 시리즈 0~13편](/blog/project/dbtower/dbtower-0-overview)
- **직접 실행(GHCR)**: `docker pull ghcr.io/dj258255/dbtower` 원커맨드 compose, 포트 8080

## DBTower-lakehouse: 버려지는 관측 데이터의 장기 분석 파이프라인

**DBTower가 7일 뒤 삭제하는 관측 데이터를 만료 전에 내려(ELT) 장기 질문에 답한다. 운영계와 분석계를 분리하고, 조용히 틀린 데이터는 fail-closed(이상하면 통과 대신 정지)로 차단한다.**

- 기간: 2026.04 ~ 진행 중 · 개인(100%) · [GitHub](https://github.com/dj258255/dbtower-lakehouse) · [블로그 시리즈 0~6편](/blog/project/lakehouse/lakehouse-0-why)
- 스택: Airflow · dbt · DuckDB/DuckLake · MinIO(S3) · PostgreSQL · Metabase · pytest · GitHub Actions
- 역할 전부: 멱등 추출(EL) / dbt 변환 / 품질 게이트 / DuckLake 테이블 포맷 / 운영(알림·deadman·CI) / 대시보드 / 규모 실측
- 규모 가정과 측정 환경: 하루 수십만 행 스냅샷을 일 단위 SLA의 배치로 처리하는 단일 노드 전제. 규모는 1년치 **54.5M행**을 합성해 별도 검증했다. 측정은 로컬 Docker(Airflow·MinIO·PostgreSQL·Metabase) 위 전/후 실측, 재현 기록은 VERIFICATION.md에 보존

### 왜 만들었는가

**관제의 시야가 "지금부터 최근 7일"인 것은 관제 도구로서 올바른 설계다. 하지만 그 설계는 장기 질문에 구조적으로 답할 수 없다.**

- 7일 삭제는 의도된 설계다. 관측 데이터를 무한히 쌓으면 메타 DB가 관리 대상보다 먼저 포화된다. AWS RDS Performance Insights 무료 티어의 보존 기간이 정확히 7일인 것과 같은 선례다
- DBTower를 만들면서 답할 수 없는 질문이 쌓였다. "지난 분기 대비 가장 악화된 쿼리 TOP 10은?" "이 인스턴스의 3개월 성장 추세로 볼 때 용량 증설 시점은?" "기종별 장기 레이턴시 분포는?"
- 해법은 실무에서 프로덕션 DB(OLTP)와 데이터 웨어하우스(분석)를 분리하는 원칙 그대로다. 관제는 지금에 최적화된 채로 두고, **버려지기 직전의 스냅샷을 컬럼형 저장소로 내리는 별도 분석 계층**을 만들었다
- **Kafka를 쓰지 않은 이유(비용 판단)**: 스냅샷 원천이라 붙일 이벤트 스트림 자체가 없고, SLA는 일 단위, 소비자는 하나다. 스트리밍 채택 3조건(초~분 신선도가 가치 · 다중 소비자 · 분산시스템 운영 여력)에 전부 미해당이라 배치를 판정으로 선택했다. 준실시간이 필요해져도 풀 Kafka가 아니라 경량 CDC + 별도 수집 계층이 맞다고 근거까지 문서화했다

### 누구에게 도움이 되는가

- **SQL 없이 대시보드로 답을 얻는 DB 운영·성능 담당자**: "지난 구간보다 느려진 쿼리 있어?"에 "instance 8의 Oracle 쿼리가 이틀 새 평균 25.9ms에서 64.5ms로 149% 느려졌다"로 답한다. raw 스냅샷만으로는 낼 수 없던 답이다
- **대시보드 이원화**: 분석 대시보드(데이터를 신뢰한 뒤의 질문)와 운영 대시보드(파이프라인 자체가 건강한가: 마지막 성공 날짜, 게이트 축별 상태)를 분리했다. 실제 수집 정지일이 completeness·freshness FAIL로 표시되는 것까지 확인했다
- **자기 부하 발견**: 악화 랭킹에 오른 인스턴스 하나는 DBTower가 자기 메타 PG에 던지는 스냅샷 적재·조회 쿼리였다. 파이프라인이 준 부하를 파이프라인이 관측한다

![Metabase 분석 대시보드 실물: 인스턴스별 악화 랭킹과 장기 추이](/uploads/project/lakehouse/metabase-dashboard.png)

### 아키텍처

![파이프라인 아키텍처](/uploads/project/lakehouse/architecture.svg)

### 추출에서 감시까지 이어지는 파이프라인 흐름

![파이프라인 흐름: 추출·적재 → 검증·변환 → 발행·서빙·감시](/uploads/project/lakehouse/pipeline-flow.svg)

Airflow DAG 한 줄이 이 셋을 순서대로 지난다: offload → quality_gate → transform → publish → heartbeat. 게이트가 FAIL이면 뒤 단계가 전부 멈춘다(fail-closed). 실패는 webhook 경보로 알리고, "성공의 부재"는 deadman이 역방향으로 잡는다.

### 운영 상세 아키텍처

![상세 아키텍처: 컨테이너 경계·포트, 태스크 체인 5단, 품질 FAIL 시 webhook 분기, heartbeat를 역방향 감시하는 deadman, DuckLake 카탈로그(PG)와 데이터(S3) 분리](/uploads/project/lakehouse/architecture-detail.svg)

### 기능 지도

| 영역 | 기능 |
|---|---|
| 파이프라인 | Airflow DAG(offload → gate → transform → publish → heartbeat) · 멱등 추출 · 아카이브 자기파괴 가드 |
| 품질 | 4축 fail-closed 게이트 · dbt test/unit test · contracts 타입 강제 · CI 3관문(ruff·pytest·dbt 픽스처 e2e) |
| 변환 | staging → fct(증분 delete+insert) → mart · 롤링 윈도우 악화 랭킹(최근 7일 vs 직전 30일) |
| 서빙 | DuckLake(단일 트랜잭션 발행·타임트래블·CHECKPOINT 컴팩션) · Metabase 대시보드 이원화(분석·운영) |
| 감시·문서 | webhook 실패 경보 · deadman(성공의 부재) · RUNBOOK 운영 절차 · VERIFICATION 재현 기록 |

### 데이터 모델

![데이터 모델: 원천 2테이블에서 raw parquet, staging, marts(contract 강제)와 운영 테이블까지의 컬럼 계보. 누적 카운터가 일간 델타로 접히는 변환 지점 표기](/uploads/project/lakehouse/erd.svg)

### 1. 1년치를 만들어 재보고 수치가 요구한 곳만 최적화했다 ([6편](/blog/project/lakehouse/lakehouse-6-scale-and-serve))

- **규모 증명 문제**: 실측이 전부 닫힌 날짜 3개 치(수십만 행)에서 초 단위로 끝났다. "규모에서도 버틴다"고 말하고 싶어지지만 그건 아직 증명이 아니다. 증분부터 도입하는 감 최적화를 거부하고 "먼저 재보고, 수치가 요구할 때만" 순서를 택했다
- **합성 실측**: 닫힌 파티션을 날짜 시프트 복제해 **365일 × 6인스턴스 = 2,190파일(54,479,535행, 396.6MB)**을 실데이터와 격리한 별도 경로에 합성했다. 종료 후 합성 파일은 전부 정리
- **병목 지목**: 단계별로 재보니 병목은 핵심 집계 테이블 전체 재빌드 **407.62s** 하나였다. 상위 마트는 0.31s, 게이트·검증은 파티션 단위 조회라 이력 크기와 무관(8~22ms). 반대로 0.31s인 마트는 증분화하지 않았다. 초 단위인 곳을 최적화하면 복잡도만 는다
- **파티션 프루닝 함정**: 증분 전환 후에도 2분+ 타임아웃이 났다. 기준 시점(워터마크)을 서브쿼리로 주면 실행 시점에야 값이 정해져 파티션 건너뛰기가 안 걸리고 2,190파일을 전부 읽는다. 값을 컴파일 시점 상수로 구워 넣어 해결했다
- **결과**: 하루치만 다시 계산해도 결과가 같다(집계 단위의 날짜 독립성)는 것을 확인한 뒤에야 증분(delete+insert)으로 전환, **407.62s → 4s(약 100배)**. 읽는 파일 2,190개 → 6~12개, 같은 날짜 재실행 멱등(행수 불변)
- **소파일 문제**: 파일 평균 177KB는 실무 타깃 128MB의 **1/741**로, 실무 1순위 고통을 그대로 재현했다. 커밋 누적 소파일은 주간 CHECKPOINT 컴팩션이 값싸게 흡수한다(366파일 → 1파일, 0.47s)

### 2. 아카이브가 자신을 지우는 경로를 재현하고 차단했다 ([5편](/blog/project/lakehouse/lakehouse-5-audit-and-trust))

- **발견**: 원천은 7일 보존이라, 그보다 지난 날짜를 다시 적재(backfill)하면 MinIO의 parquet가 세상에 남은 유일본이 된다. 그런데 멱등 재적재가 "파티션 통째 삭제 후 재작성(delete-first)"이라, 원천 0행이면 유일본을 지우고 아무것도 안 쓴 채 **exit 0 "성공"**으로 끝난다. fail-closed를 읽기 경로(게이트)에는 적용했으면서 쓰기 경로에는 적용하지 않았던 뒷면이다
- **재현**: 실데이터와 무관한 날짜에 가짜 파티션(3행)을 심고 재실행했다. 로그는 "기존 파티션 삭제" → "데이터 없음, 스킵" → "적재 완료 총 0행". 파티션 소멸, 복구 불가를 직접 확인했다
- **가드 설계**: 원칙은 "지울 자격은 다시 쓸 수 있는 자에게만". 원천 0행 + 파티션 존재면 보존 창 밖 재적재로 판정해 삭제를 거부하고 시끄럽게 실패한다(exit 1, webhook 경보 탑승). 자동 우회 플래그는 일부러 만들지 않았다. 데이터를 지우는 일만큼은 사람이 직접 확인하고 지우게 하고 싶었다
- **전/후 실측**: 같은 입력에서 유일본 보존을 확인했고, 정상 경로는 멱등 그대로다(verify ALL MATCH, 149,259 / 79,894행 불변). 유일본을 지운 뒤에 오는 알림은 사후 통보일 뿐이고, 지우기 전에 실패시키는 쪽이 방어다

### 3. 조용한 오답을 막는 신뢰 계층 ([2편](/blog/project/lakehouse/lakehouse-2-transform-and-gate) · [5편](/blog/project/lakehouse/lakehouse-5-audit-and-trust))

**신뢰는 기능이 아니라 계층이다. 네 장치가 각자 다른 실패 모드를 막고, 전부 장애 주입으로 실증했다.**

| 장치 | 막는 실패 모드 | 실증 |
|---|---|---|
| 4축 fail-closed 게이트 | 반쪽 파티션 위의 "조용히 틀린 랭킹". dbt test는 이미 로드된 데이터만 봐서 못 잡는다(없는 행은 not_null을 위반하지 않는다) | 파티션 20,158행 삭제 주입 → 정합·완결성 동시 FAIL, **dbt 미실행 exit 2**, 문제 날짜만 차단 |
| CI 3관문 | 테스트가 "로컬 자산"이 되는 회귀 | 커밋마다 픽스처만으로 dbt build를 e2e 실행, **PASS=26**(unit test 5 포함) |
| dbt contracts | 마트 컬럼 타입이 조용히 바뀌어 대시보드가 런타임에 깨지는 것 | VARCHAR 타입 주입 → **CREATE TABLE 시점에 빌드 차단** |
| deadman heartbeat | "성공의 부재". 실제로 수집기가 21시간 조용히 정지했는데 알림이 0통이었다 | **30h 침묵(기한 26h) → 경보 실수신**, 미실행·pause DAG도 검출 |

- **게이트 자신도 검문했다**: 게이트가 원천 전체를 훑고 있었다(Seq Scan, EXPLAIN 실측 332ms로 65만 행 중 51만 폐기). 인스턴스별 인덱스 등치 루프로 교체해 **332ms → 20ms**(Index Only Scan). "관제가 부하가 되면 안 된다"는 원칙을 게이트 자신에게도 적용한 것이다

![품질 게이트 실측: 정상 통과와 장애 주입 시 FAIL로 다운스트림 차단](/uploads/project/lakehouse/quality-gate.png)

### 4. 파일 직결을 실측으로 실격 판정하고 DuckLake로 서빙한다 ([4편](/blog/project/lakehouse/lakehouse-4-dashboard))

- **실격 사유 실측 2건**: dbt의 DuckDB 파일을 Metabase가 직결로 읽는 가장 쉬운 길은, 같은 호스트에서는 읽기 커넥션의 잠금에 dbt 쓰기가 죽고(Conflicting lock), 컨테이너 경계에서는 잠금이 전파되지 않아 열린 리더 밑에서 파일이 소리 없이 재작성된다. 시끄럽게 죽는 쪽보다 나쁜 실패다
- **DuckLake 재설계**: 마트를 DuckLake로 발행하고 Metabase는 read-only로 DuckLake만 읽는다. 동시성은 파일 잠금이 아니라 PG 트랜잭션(스냅샷 격리)이 중재한다. 카탈로그는 이미 있는 PostgreSQL을 써서 서비스 추가 0
- **무중단 검증**: 발행(쓰기) 도중 0.3초 간격 연속 질의 **41회 전부 온전**. 수치는 3경로(파일 직독·Metabase API·대시보드 화면) 대조로 전부 일치(+149.1% 동일)
- **화면이 깨운 동시성 버그**: 카드를 한 장씩 돌리면 전부 통과하는데, 대시보드가 카드 3장을 동시에 쏘자 2장이 500으로 터졌다. 커넥션 풀마다 실행되는 CREATE OR REPLACE SECRET이 공유 카탈로그에서 경합한 것으로, 세션 로컬 SET 설정으로 공유 상태 자체를 없애 해소했다
- **발행 원자성**: 두 테이블 발행 사이에 장애를 주입해 "새 fct + 이전 mart"라는 존재한 적 없는 혼합 버전을 대시보드가 보는 결함을 재현했다. 발행을 BEGIN...COMMIT 단일 트랜잭션으로 묶고 재주입해 새 스냅샷 0개, 원자성을 증명했다
- **Iceberg 대비 정직한 표기**: DuckDB에서 Iceberg 쓰기는 REST 카탈로그 서버가 추가로 필요하다. "미지원"이 아니라 이 규모에 부적합으로 판정하고, 멀티엔진 시점의 전환 경로를 문서로 남겼다

### 판단과 트레이드오프

- **지문 충돌과 순리셋**: 같은 쿼리 식별자(지문) 아래 두 누적 계열이 뒤섞여 지그재그하는 원인을 규명해 합산으로 단조성을 복원했고(12,743키), 순수하게 리셋된 219개 집계 단위는 0으로 고정해 음수 증가량 0건을 확인했다
- **microbatch 기각**: dbt 공식 증분 전략 중 microbatch는 event_time이 필수고 unique_key 기반 파티션 교체가 안 된다. delete+insert를 선택하고 기각 사유를 문서로 남겼다
- **인접 델타 합산 기각**: Prometheus rate 방식의 인접 델타 합산은 사라졌다 재등장하는 쿼리를 과대계상한다. 총합 22,264,704 vs first-vs-last 3,126,579, **7배 부풀림**을 실측으로 확인하고 기각했다
- **게이트만 retries=0**: 품질 FAIL은 재시도해도 결과가 같은 결정적 실패라 재시도 대신 즉시 알림. 일시 장애용 지수 백오프 재시도(2→4→8분)와는 분리했다
- **롤링 윈도우 재설계**: 전체 이력 first-vs-last 비교는 오래된 개선을 영원히 기억한다. 최근 7일 vs 직전 30일로 재설계하고, 검증 주입 +50/+150이 경계 겹침 때문에 +47.5/+138.1로 나오는 것까지 원인 규명해 정직하게 기록했다

### 대표 수치 (전부 직접 실측, 재현 기록 저장소 보존)

| 항목 | 실측 |
|---|---|
| 정합 검증 | 원천 PG = parquet = DuckDB 3자 일치 (149,259 / 79,894행), 멱등 2회 재실행 불변 |
| 품질 게이트 | 4축 fail-closed, 장애 주입 시 dbt 미실행(exit 2), 게이트 자체 부하는 Seq Scan 332ms → Index Only Scan 20ms |
| 아카이브 가드 | 자기파괴 경로 전/후 재현: 수정 전 유일본 소멸, 수정 후 삭제 거부·보존 |
| 규모 실측 | 365일 · 2,190파일 · 54.5M행 합성, fct 407.62s → 증분 4s(약 100배), 파일 177KB = 128MB 타깃의 1/741 |
| 서빙 | 발행 중 연속 질의 41회 무중단(스냅샷 격리), 파일 직독=API=화면 3자 정합(+149.1% 동일) |
| DuckLake 운영 | 타임트래블·ROLLBACK 원자성 실증, CHECKPOINT 스냅샷 11→2 정리에도 행수 229,153 불변 |
| 감시 | deadman 30h 침묵(기한 26h) 경보 실수신, contracts 위반 주입 시 빌드 차단 |
| 테스트 | pytest 57 passed · CI dbt build PASS=26(unit test 5 포함) |

### 배운 것

- 조용히 틀린 데이터는 없는 것보다 나쁘다. 게이트·CI·contracts·deadman이 각자 다른 실패 모드를 막아야 신뢰가 계층으로 선다.
- 최적화는 규모가 요구할 때만 한다. 1년치를 합성해 재보기 전까지는 증분 전환도 하지 않았고, 실측이 병목 하나(fct 재빌드)만 지목했기에 거기만 고쳤다.
- 멱등은 공짜가 아니다. delete-first 재적재의 경계 조건(보존 창 밖 유일본)을 감사하지 않았다면 편의 장치가 데이터를 지우는 장치가 됐다.

### 링크

- **GitHub 저장소**: [github.com/dj258255/dbtower-lakehouse](https://github.com/dj258255/dbtower-lakehouse) (실측 기록 docs/VERIFICATION.md)
- **블로그 총정리 0편**: [왜 만들었는지부터 규모 실측까지, 시리즈 1~6편](/blog/project/lakehouse/lakehouse-0-why)
- **운영 절차(RUNBOOK)**: [backfill·장애 대응·CHECKPOINT](https://github.com/dj258255/dbtower-lakehouse/blob/main/docs/RUNBOOK.md)

## 관문(gwanmun): 고정길이 전문과 REST 사이의 연계 게이트웨이

**저장소**: [github.com/dj258255/gwanmun](https://github.com/dj258255/gwanmun) · **시리즈 총정리**: [블로그 0편](/blog/project/gwanmun/gwanmun-0-why)

**은행 계정계는 `"0200" + 계좌번호[14] + 공백패딩...`처럼 자릿수가 곧 의미인 고정길이 전문을 TCP로만 말하고, 모바일 앱은 JSON을 REST로만 말한다. 둘 다 고칠 수 없으니 가운데에 통역기를 세웠다.** 마이데이터와 오픈뱅킹이 서 있는 바로 그 자리를, 목업 계정계까지 직접 세워 작게 재현한 프로젝트다.

- TCP는 스트림이라 한 전문이 한 번에 도착한다는 보장이 없다. 프레이밍과 전문 파서를 순수 소켓으로 직접 구현해 그 경계 관리를 몸으로 겪었다
- 계정계를 실제로 죽여 봤다. 서킷브레이커가 OPEN으로 격리한 뒤 즉시 503으로 거절하는데, 죽은 백엔드 앞에서 서킷이 없으면 351 req/s, 있으면 9,425 req/s였다. 빠른 실패의 값을 수치로 확인한 실험이다
- 풀 고갈 예외 하나가 원장 4건을 증발시키는 결함을 전체 감사로 찾아 고쳤고, 같은 멱등키를 두 번 보내도 계정계 호출 1회에 원장 1행(이중거래 0)임을 실측했다
- 게이트웨이 오버헤드 0.21ms, 한계 약 10~12k req/s, 테스트 168건 CI 게이트

## 링크 모음

| 구분 | 주소 |
|---|---|
| GitHub | [github.com/dj258255](https://github.com/dj258255) |
| 기술 블로그 | [dj258255.github.io/IT-Oasis](https://dj258255.github.io/IT-Oasis) |
| DBTower 시리즈 14편 | [총정리 0편](/blog/project/dbtower/dbtower-0-overview) |
| lakehouse 시리즈 7편 | [총정리 0편](/blog/project/lakehouse/lakehouse-0-why) |
| 관문 시리즈 6편 | [총정리 0편](/blog/project/gwanmun/gwanmun-0-why) |

---
title: '범수 포트폴리오 (v2)'
description: 'DBMS 운영 관리 플랫폼 직무를 위해 정리한 포트폴리오입니다. 이기종 5기종 관제 플랫폼 DBTower, 관측 데이터 장기 분석 파이프라인 DBTower-lakehouse, 오픈소스 기여(Spring Boot, Apache Lucene)를 아키텍처와 실측 수치, 재현 기록과 함께 담았습니다.'
date: 2026-07-22T00:00:00.000Z
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

같이 일하는 사람과 사용하는 사람 모두에게 도움이 되고 싶습니다.

- 오픈소스의 문제를 직접 해결해 Spring Boot(4.1.0-M2)·Apache Lucene(main merge)에 기여가 반영됐습니다
- 코딩테스트를 힘들어하는 친구를 위해 CodingTestKit(다운로드 750+)을 만들어 운영합니다

**Database** MySQL, PostgreSQL, Oracle, SQL Server, MongoDB
**Backend** Java 21, Spring Boot, JPA / JdbcTemplate
**Data Pipeline** Python, Airflow, dbt, DuckDB / DuckLake, MinIO(S3), Parquet, Metabase
**Infra / 검증** Docker, Kubernetes(CloudNativePG), Ansible, GitHub Actions CI, k6, Prometheus, JUnit / pytest

모든 수치는 로컬 Docker 위 전/후 실측이며(대규모는 합성 데이터로 검증), 재현 절차는 각 저장소 VERIFICATION에 남겼습니다.

## AI를 쓰는 방식

- **안전 설계**: MCP 서버를 직접 구현하되 AI에는 read-only 도구 화이트리스트만 열어 대상 DB 변경 0을 구조로 보장합니다
- **Plan-First 협업**: 변경 범위·영향·테스트 계획을 먼저 세우고 사람이 승인한 뒤에만 구현합니다
- **컨텍스트 엔지니어링**: 프로젝트 규칙·과거 결정을 CLAUDE.md와 메모리 파일로 관리합니다
- **역할 분리**: 작업한 에이전트가 자기 결과를 채점하지 않도록 탐지·수정·검증을 별도 에이전트로 분리합니다
- **검증이 기본값**: AI가 만든 코드도 같은 관문(테스트 CI·전/후 실측)을 통과해야 채택합니다

## 오픈소스 기여: Spring Boot · Apache Lucene

### Spring Boot: Kotlin 테스트 API 사용성 개선 · [PR #49063](https://github.com/spring-projects/spring-boot/pull/49063)

**reified 확장**으로 `TestEntityManager`의 Kotlin 사용성을 개선했고, 메인테이너 커밋으로 반영되어 **Spring Boot 4.1.0-M2 New Features에 기록**됐습니다.

- **문제**: Kotlin 테스트에서 `find(Foo::class.java, id)`처럼 Java class reference를 직접 전달해야 했습니다
- **해결**: reified 확장 함수(`find<Foo>(id)`, `persistAndGetId<Long>(entity)` 등)를 추가해 간결하고 타입 안전하게 만들었습니다
- **검증**: 각 확장이 기존 API로 올바르게 위임되는지 Mockito 단위 테스트로 증명해 제출했습니다

```kotlin
// before — Java class reference 직접 전달
val foo = testEntityManager.find(Foo::class.java, id)
// after — reified 확장 함수
val foo = testEntityManager.find<Foo>(id)
```

### Apache Lucene: IndexWriter 초기화 실패 시 리소스 누수 수정 · [PR #15675](https://github.com/apache/lucene/pull/15675)

**실패 경로의 스레드 풀 누수**를 잡아 **Apache Lucene main branch에 merge**됐고, **CHANGES.txt에 bug fix로 기록**됐습니다.

- **문제**: `IndexWriter` 생성자 실패 시 writeLock만 닫고 `MergeScheduler`를 닫지 않아 `ThreadPoolExecutor`가 종료되지 않았습니다
- **해결**: 실패 경로에서 `MergeScheduler`까지 함께 정리하도록 수정했습니다
- **검증**: `OpenMode.APPEND`+빈 디렉터리로 초기화 실패를 재현하고, `close()` 호출을 `AtomicBoolean`으로 확인하는 회귀 테스트를 추가했습니다

```java
// 회귀 테스트 요지 — 초기화 실패 재현 후 close 호출 검증
expectThrows(IndexNotFoundException.class, () -> new IndexWriter(emptyDir, cfg));
assertTrue(schedulerClosed.get());
```

## DBTower: 이기종 DBMS 5종 관제·진단 플랫폼

**MySQL부터 MongoDB까지, 이기종 DBMS 5종의 등록·진단·백업·감시를 인터페이스 하나 뒤에서 처리합니다.**

- **기간**: 2026.03 ~ 2026.07 · 개인(100%) · [GitHub](https://github.com/dj258255/dbtower) · [블로그 시리즈 0~9편](/blog/project/dbtower/dbtower-0-overview)
- **스택**: Java 21, Spring Boot, PostgreSQL(메타), JdbcTemplate·Mongo Driver·JDBC batch(적재적소), MCP(JSON-RPC 2.0 직접 구현), Flyway, ShedLock, Docker, k6
- **규모 가정**: 관제 도구라 실사용 트래픽은 수십 RPS를 예상하고 단일 노드 셀프호스트 운용을 전제했습니다. 그래도 배포 전 k6로 부하를 걸어 안정성을 확인했습니다(10 VU 30s: **2,832 req/s**, P95 5.86ms, 실패 0)
- **측정 환경**: 로컬 Docker(Apple Silicon) 위 대상 DB 5기종. 모든 수치는 개선 전을 먼저 재고 고친 뒤 다시 잰 전/후 실측이며, 재현 절차는 [VERIFICATION.md](https://github.com/dj258255/dbtower/blob/main/docs/VERIFICATION.md) 117개 절에 보존했습니다
- **자기 저장소를 PostgreSQL로 고른 이유**: pg_stat_statements, RANGE 파티션 DROP, 풍부한 시스템 뷰를 도그푸딩 대상으로도 쓰기 위해서입니다

### 왜 만들었는가

이 프로젝트가 겨눈 한 가지는 **DBRE**(Database Reliability Engineering)의 문제의식입니다.

정형화된 운영 업무를 자동화해 서비스와 DB가 늘어도 사람 손이 선형으로 늘지 않게 만드는 것입니다.

현직 DBA 지인의 말이 스펙이 됐습니다.

"플랫폼에서 하나의 기능으로 30분 주기 백업하고 싶어 하면, 각 DBMS가 알아서 자기 구문으로 백업하게."

추상 수준에서 정책을 설계하고 인터페이스를 상속받아 기종별로 특화 구현하는 일입니다.

**DB에 이슈가 나면 개발자는 흩어진 도구를 오가다 결국 DBA에게 묻고, DBA는 같은 질문에 반복해서 답합니다. 관리 대상 DB가 늘수록 사람 손이 선형으로 늘어나는 구조를 인터페이스 하나로 끊고 싶었습니다.**

- 지표가 흩어져 있습니다. CPU는 모니터링 대시보드에, 쿼리 통계는 기종마다 다른 시스템 뷰에, 실행계획은 콘솔에 있고, 백업·모니터링·계정 관리 구문도 5기종이 전부 다릅니다
- 업계가 이미 정의한 문제입니다. 국내 대형 서비스 기업들이 사내 DB 어드민 플랫폼을 직접 만들어 운영하고, AWS가 CloudWatch 위에 RDS Performance Insights를 별도 층으로 얹은 이유가 같은 문제의식입니다
- **범위 결정**: 이미 검증돼 널리 쓰이는 메트릭 수집·시각화 스택(Prometheus·Grafana)은 다시 만들지 않았습니다. DBTower가 맡는 건 그 위의 층이라 "그 시각에 어떤 쿼리가 원인이고, 실행계획이 왜 나쁘고, 무엇을 해야 하나"에 답합니다
- **목표 두 줄**: 개발자가 DBA 문의 없이 스스로 분석하고, 개발팀과 DB팀이 다섯 기종을 하나의 툴·같은 화면·같은 용어로 봅니다

문제 정의를 붙잡고 나니 처음 떠올린 "부하 상위 쿼리를 보여주자"가 함정이었다는 걸 알았습니다. 부하 1위 쿼리는 평소에도 1위였을 수 있습니다. 장애의 진짜 범인은 새로 유입된 쿼리거나 평소 대비 급증한 쿼리인 경우가 많습니다. 그래서 관측 자체가 아니라 "평소와 지금의 차이"를 짚는 쪽으로 설계 방향을 틀었고, 그 판단이 시점 비교와 회귀 감지의 뿌리가 됐습니다.

![다섯 기종 여섯 인스턴스가 같은 카드, 같은 그래프, 같은 진단으로 뜨는 대시보드 실물](/uploads/project/dbtower/dashboard.png)

### 아키텍처

![DBTower 전체 구조, 소비자 차이는 채널 뒤로, 기종 차이는 DbmsOperator 뒤로](/uploads/project/dbtower/architecture-full.svg)

소비자 3채널(웹 콘솔·MCP·웹훅)이 같은 코어(수집 폴러·시점비교·회귀감지·헬스스코어)를 부르고, 코어는 `DbmsOperator` 인터페이스 뒤의 기종별 구현체 5개만 봅니다. 바깥 경계는 소비자를 숨기고 안쪽 경계는 기종을 숨깁니다. 채널을 추가하는 동안 코어는 한 줄도 바뀌지 않았습니다.

![상세 아키텍처, 컨테이너 경계·포트, 폴러와 채널의 실제 배선, 메타 DB와 대상 DB 5기종](/uploads/project/dbtower/architecture-detail.svg)

플랫폼 자기 저장소(메타 PG)와 관리 대상 DB는 물리적으로 분리했습니다. 대상 장애가 플랫폼을 죽이면 관제탑이 정작 필요한 순간에 눈이 멀기 때문입니다.

### 판단 1. 경계를 "운영 행위"에 긋고, 실증했습니다

다섯 기종은 쿼리 통계를 주는 방식부터 시간 단위(피코초·밀리초·마이크로초)까지 전부 다릅니다. 경계를 SQL 문법이 아니라 운영 행위(통계 조회·실행계획·백업)에 그으면 SQL이 없는 MongoDB까지 같은 틀에 들어옵니다. 성격이 정반대인 Oracle과 MongoDB를 실제로 추가해 수집·비교·감지·콘솔·MCP **코어 경로 0줄 수정**을 실증했고, 이 경계는 문서가 아니라 빌드(Spring Modulith 순환 의존 실패)가 지킵니다. JPA 통일안도 검토했지만 대상이 런타임에 등록되는 N개의 남의 DB이고 MongoDB엔 JPA가 없어, 추상화를 JPA/JDBC보다 위에 뒀습니다.

### 판단 2. 도구의 선은 판정·기록까지, 실행은 사람 뒤에 둡니다

DBA 손이 반복해서 가는 다섯 지점(설정 드리프트 이력·스키마 리뷰 게이트·인덱스 판정·인시던트 리포트·월간 리포트)을 자동화하되, 전부 읽고 판정·기록까지만 하고 대상 DB는 바꾸지 않습니다. 대상을 실제로 바꾸는 경로는 gh-ost 온라인 스키마 변경 하나뿐이고 ADMIN 전용·기본 dry-run·AI 미노출로 봉인했습니다. AI 채널(MCP 도구 16종)도 read-only 화이트리스트만 열어 kill·backup·DDL은 아예 등록하지 않았습니다.

### 트러블슈팅 1. "인덱스가 있는데 왜 안 타요": 괴리 300배로 형변환을 지목

- **정상 상태**: `code VARCHAR` 컬럼에 B-Tree 인덱스가 있어 쿼리만 봐서는 멀쩡해 보입니다
- **문제**: MySQL에서 `WHERE code = 12345`(따옴표 누락)가 풀스캔을 탑니다. EXPLAIN은 옵티마이저의 추정이라 "풀스캔을 택했다"까지만 보여주고, 왜 속았는지는 보이지 않습니다
- **원인 분석**: 실제 실행계획을 5기종 각자의 경로(EXPLAIN ANALYZE / DISPLAY_CURSOR / STATISTICS XML / executionStats)로 받아 추정 vs 실제 행수 괴리를 계산했습니다. 추정 300행 대 실제 1행, **괴리 300배**입니다. 문자열 컬럼에 숫자 리터럴을 주면 컬럼 쪽이 숫자로 캐스팅돼(컬럼에 함수를 씌운 꼴) 인덱스 정렬을 못 쓰는 원리입니다. MySQL·PG의 actual rows는 루프당 평균이라 loops를 안 곱하면 진단 전체가 틀리는 함정도 단위 테스트로 고정했습니다
- **해결·결과**: 수정안 SQL의 원클릭 재진단으로 괴리 해소와 **Index lookup 전환**을 확인했습니다. 고치고 보니 수정 전의 "1행"은 `'012345'`가 캐스팅으로 잘못 매칭된 행이라, 조회면 오답이고 UPDATE였으면 데이터 사고였습니다. 형변환은 느린 것보다 틀린 게 진짜 문제였습니다

![수정안 원클릭 재진단 before/after, 괴리 300배에서 없음으로, 풀스캔이 Index lookup으로](/uploads/project/dbtower/deep-before-after.png)

### 트러블슈팅 2. 만든 진단 도구를 자기 자신에게 먼저 썼습니다: 343배

- **문제**: 메타 PG를 DBTower 자신의 관리 대상으로 등록하자, 자기 스냅샷 조회 쿼리가 자기 화면의 슬로우 쿼리 목록에 떴습니다(50만 행)
- **원인**: 자기 explain API가 "Seq Scan 발생, 인덱스를 검토하세요"라고 자기 자신을 지적했습니다. 조건은 `instance_id` 등치 + `captured_at` 범위인데 인덱스가 없어 전 행 순차 탐색이었습니다
- **해결·결과**: 등치 컬럼을 선두에 둔 복합 인덱스(B-Tree는 선두로 범위를 좁혀야 뒤 컬럼 조건이 이어집니다)를 추가하고 같은 API로 재진단해 **21.269 → 0.062ms(343배)**를 얻었습니다. 개선을 측정한 도구가 곧 내가 만든 기능이라는 순환이 플랫폼이 동작한다는 증거입니다

### 트러블슈팅 3. 보존 정리가 만든 블로트 404MB를 파티셔닝으로 0으로 만들었습니다

- **문제**: 오래된 스냅샷 200만 행을 벌크 DELETE로 지웠는데 17만 행만 남은 테이블이 404MB를 붙잡고 있었습니다
- **원인**: PostgreSQL의 DELETE는 dead tuple을 남기고, 일반 VACUUM은 파일을 줄여주지 않습니다
- **해결·결과**: 월별 RANGE 파티셔닝(신테이블→복사→스왑)으로 전환했습니다. 만료 삭제가 2백만 행 DELETE(1.9s)에서 파티션 DROP(12.8ms)으로 바뀌고, DROP은 파일 삭제라 블로트가 아예 생기지 않습니다. **블로트 404MB → 0**

### 트러블슈팅 4. 성능 개선이 되살린 풀 경합, 허위 장애 경보로 증폭됐습니다

- **문제**: 인스턴스당 커넥션 풀 max 2에 폴러가 8개(스냅샷·경보·SLO·백업·이상·회귀·Advisor·스코어) 붙자, 3번째 동시 요청부터 대기 → 타임아웃 → "죽은 대상" 오인 → 최대 16분 백오프 + 허위 "수집 정지" 경보로 증폭됐습니다
- **원인**: 직전에 성능을 위해 넣은 수집 병렬화(워커 4)가 경합을 키웠습니다. 자원 경합이 허위 장애 신호로 번역되는 구조였습니다
- **해결·결과**: 풀 상한을 2에서 6으로 올리고 설정값으로 분리해 차단했습니다. 고친 자리 옆이 다시 터진 사례라, 이후 개선마다 인접 경로를 함께 다시 보게 됐습니다

### 대표 수치 (전부 전/후 실측, 재현 기록 VERIFICATION.md 117개 절)

| 항목 | 수치 |
|---|---|
| 새 기종 추가 비용 | 코어 파이프라인 **0줄 수정** (Oracle·MongoDB 추가로 실증) |
| 심층 진단 | 추정 vs 실제 **괴리 300배** 지목 → 원클릭 재진단으로 Index lookup 전환 |
| 자기 진단 | **343배** (21.269 → 0.062ms, 복합 인덱스) |
| 수집·저장 성능 | HikariCP 풀링 **4.0배**(47.1→11.8ms) · JDBC batch **13.8배**(행당 1.51→0.11ms) |
| 보존 정리 | 블로트 404MB → 0 · 만료 삭제 **147배**(DELETE 1.9s → DROP 12.8ms) |
| 부하 검증 | k6 10 VU 30s에서 **2,832 req/s · P95 5.86ms · 실패 0** |
| 백업·복구 | 5기종 병행 정책(FULL 앵커+LOG 체인) · PITR 실제 복원 2기종 · AES-256-GCM |
| 알림→진단 루프 | 이모지 반응 → AI 진단 답글(Discord 특권 인텐트 0) |
| 품질 | 테스트 **515건** CI · 자체 감사 결함 20+건 FIX/SKIP · GHCR 멀티아치 공개 배포 |

못 하는 것은 그대로 표기했습니다. 백업 검증은 VERIFIED/FAILED/UNSUPPORTED 3값이고, p95는 실측·추정·미지원 라벨을 섞지 않으며, Terraform은 RDS 과금이 필요해 validate까지만 확인했다고 문서에 적었습니다.

- 저장소: [github.com/dj258255/dbtower](https://github.com/dj258255/dbtower) (재현 기록 docs/VERIFICATION.md)
- 깊이가 필요하면: [블로그 총정리 0편](/blog/project/dbtower/dbtower-0-overview) (시리즈 0~9편)
- 직접 실행: `docker pull ghcr.io/dj258255/dbtower` (원커맨드 compose, 포트 8080)

## DBTower-lakehouse: 버려지는 관측 데이터의 장기 분석·판정 파이프라인

DBTower가 7일 뒤 삭제하는 관측 데이터를 만료 전에 내려(ELT), 라이브 창으로는 답할 수 없는 장기 질문에 답합니다.

- 2026.04 ~ 진행 중 · 개인(100%) · [GitHub](https://github.com/dj258255/dbtower-lakehouse) · [블로그 0편(왜부터 판정층까지)](/blog/project/lakehouse/lakehouse-0-why)
- Airflow · dbt · DuckDB/DuckLake · MinIO(S3) · PostgreSQL · Metabase · pytest · GitHub Actions
- 규모 가정: 수백 대·수년치(low-TB) 이력을 일 단위 SLA 배치로 단일 노드 DuckDB가 감당하는 것입니다. 시간축 1년치 **54.5M행**·인스턴스축 300대 **52.2M행** 두 축으로 합성 검증했습니다

관제의 7일 보존은 올바른 설계지만 "지난 분기 대비 가장 악화된 쿼리는?" "이 성장 추세면 증설 시점은?" 같은 질문에는 구조적으로 답할 수 없습니다. 그래서 프로덕션 DB와 분석계를 분리하는 원칙 그대로, 버려지기 직전의 스냅샷만 컬럼형 저장소로 내리는 별도 계층을 만들었습니다. Kafka는 쓰지 않았습니다. 스냅샷 원천이라 이벤트 스트림이 없고 SLA가 일 단위에 소비자가 하나라, 스트리밍 채택 3조건에 전부 미해당이라는 판단까지 문서화했습니다.

![Metabase 분석 대시보드 실물, 인스턴스별 악화 랭킹과 장기 추이](/uploads/project/lakehouse/metabase-dashboard.png)

### 아키텍처

![파이프라인 아키텍처](/uploads/project/lakehouse/architecture.svg)

Airflow DAG 한 줄이 offload → quality_gate → transform → publish → heartbeat를 순서대로 지납니다. 게이트가 FAIL이면 뒤 단계가 전부 멈추고(fail-closed), 실패는 webhook 경보로 알리며, "성공의 부재"는 deadman이 역방향으로 잡습니다. 서빙은 DuckLake(카탈로그는 기존 PG 재사용) 위에서 Metabase가 read-only로만 읽습니다.

![파이프라인 흐름: 추출·적재 → 검증·변환 → 발행·서빙·감시](/uploads/project/lakehouse/pipeline-flow.svg)

### 판단 1. 조용히 틀린 데이터는 없는 것보다 나쁩니다

반쪽 파티션 위의 "조용히 틀린 랭킹"을 막으려고 4축 fail-closed 게이트(정합·완결성·신선도·스키마)를 dbt 앞에 세웠습니다. dbt test는 이미 로드된 데이터만 봐서 없는 행을 못 잡기 때문입니다. 파티션 20,158행을 지워 주입하자 게이트가 FAIL을 내고 dbt가 실행되지 않았습니다(exit 2). 마트 컬럼 타입은 dbt contracts가 CREATE TABLE 시점에 막고, 수집기가 21시간 조용히 멈췄는데 알림이 0통이었던 경험은 deadman(30h 침묵 시 경보 실수신 확인)으로 이어졌습니다.

![품질 게이트 실측, 정상 통과와 장애 주입 시 FAIL로 다운스트림 차단](/uploads/project/lakehouse/quality-gate.png)

### 판단 2. 창고가 판정을 내리되, 발화는 남에게 맡깁니다

DBA가 손으로 하던 판정 여섯(용량 D-day·플랜 회귀·백업 RPO·미사용 인덱스·설정 변경 상관·가용성 SLO)을 매일 컬럼으로 계산합니다. 관측이 부족하면 PENDING, 창이 오염되면 AMBIGUOUS로 지어내지 않고, 미사용 인덱스는 삭제 후보까지만 내고 최종 판단은 사람에게 남깁니다. 라이브 실측에서 MSSQL 2대의 uptime 63~64% breach를 실제로 검출했고, 알림 발화는 Metabase·DBTower의 몫으로 두어 두 번째 알림 시스템을 만들지 않았습니다.

### 트러블슈팅 1. 아카이브가 자기 자신을 지우는 경로를 재현하고 차단했습니다

- **문제**: 원천은 7일 보존이라 그보다 지난 날짜를 backfill하면 MinIO의 parquet가 세상에 남은 유일본이 됩니다. 그런데 멱등 재적재가 "파티션 통째 삭제 후 재작성(delete-first)"이라, 원천이 0행이면 유일본을 지우고 아무것도 안 쓴 채 exit 0 "성공"으로 끝납니다
- **원인**: delete-first는 "지운 만큼 다시 쓸 수 있다"를 암묵 전제하는데, 보존 창 밖에서는 delete만 남고 write가 사라집니다. fail-closed를 읽기 경로에는 적용했으면서 쓰기 경로에는 빠뜨린 뒷면이었습니다
- **재현·해결**: 가짜 파티션을 심고 재실행해 "삭제 → 데이터 없음 → 총 0행 완료" 로그로 소멸을 직접 확인했습니다. "지울 자격은 다시 쓸 수 있는 자에게만"이라는 원칙으로, 원천 0행 + 파티션 존재면 삭제를 거부하고 시끄럽게 실패하게 했습니다(exit 1 + webhook 경보). 자동 우회 플래그는 일부러 만들지 않았습니다
- **결과**: 같은 입력에서 유일본을 보존하고, 정상 경로는 멱등 그대로입니다(verify ALL MATCH, 149,259행 불변)

### 트러블슈팅 2. 누적 카운터를 일간 델타로 접다가 만난 지문 충돌 12,743키

- **문제**: raw의 calls는 서버 기동 이후 누적 카운터라 SUM하면 무의미합니다. 하루 양 끝 차분으로 델타를 내려는데, 시간순 정렬에서 302→55→302로 지그재그하는 가짜 리셋이 나왔습니다
- **원인**: 같은 쿼리 지문 아래 두 누적 계열이 얽힌 지문 충돌 **12,743키**였습니다. 이대로 인접 차분하면 302→55가 -247로 잡혀 델타가 통째로 오염됩니다
- **해결**: staging에서 시점별 SUM으로 단조성을 복원하고("단조 비감소 계열의 합도 단조"), 하루 양 끝 차분 + 리셋 클램프로 일간 델타를 냈습니다. 순리셋 219그레인이 0으로 눌렸고 음수 델타 0건입니다
- **대안 기각**: Prometheus rate 방식(인접 양의 델타 합산)도 후보였지만, 쿼리가 잠깐 사라졌다 재등장할 때 유령 증가분을 과대계상해 총합 **7배 부풀림**(22.2M vs 3.1M)을 실측하고 기각했습니다. 심장 로직은 dbt unit test 4건으로 고정했습니다

### 트러블슈팅 3. 규모 실측과 파티션 프루닝 함정: fct 재빌드 100배

- **문제**: fct 마트가 매일 전체 이력을 다시 계산하는데, 시간축 합성 54.5M행에서 **407.62s**가 걸렸습니다. 병목은 단계별로 재보니 이 하나뿐이었습니다(상위 마트 0.31s, 게이트는 파티션 6파일만 봐서 8~22ms)
- **함정**: 증분 전환 후에도 2분+ 타임아웃이 났습니다. 워터마크를 서브쿼리(`select max(dt)`)로 주면 값이 실행 시점에야 정해져 플래너가 hive 경로 프루닝을 못 하고 2,190파일을 전부 읽습니다
- **해결·결과**: 컴파일 타임에 max dt를 뽑아 리터럴로 구워 넣자 경로 프루닝이 걸려 최신 dt만 읽었습니다. **407.62s → 4s(약 100배)**, 읽는 파일 2,190 → 6~12개, 같은 날짜 재실행이 멱등입니다
- **축 회전**: 총량을 고정하고 인스턴스축 300대로 돌려 재보니 증분은 8.03s로 건재했고, 급소는 외삽해 뒀던 소파일이 아니라 full-refresh(769s)로 드러났습니다. 재보지 않은 예측 두 개가 실측에서 뒤집혔습니다

### 대표 수치 (전부 직접 실측, 재현 기록 저장소 보존)

| 항목 | 실측 |
|---|---|
| 정합 검증 | 원천 PG = parquet = DuckDB 3자 일치(149,259행) · 멱등 2회 재실행 불변 |
| 변환 | 지문 충돌 12,743키 SUM 복원 · 인접 합산 대비 **7배 부풀림** 실측 기각 |
| 규모 검증 | 두 축 합성(54.5M·52.2M행) · fct 증분 **407.62s → 4s(약 100배)** |
| 품질 게이트 | 4축 fail-closed · 장애 주입 시 dbt 미실행(exit 2) · 게이트 자체 부하 332→20ms |
| 아카이브 가드 | 자기파괴 경로 전/후 재현: 수정 전 유일본 소멸, 수정 후 삭제 거부 |
| 판정층 | 판정 6종 · 발행 21테이블 · MSSQL 2대 uptime 63~64% breach 실검출 |
| 서빙 | DuckLake 발행 중 연속 질의 41회 무중단(스냅샷 격리) · 타임트래블 실증 |
| 감시·품질 | deadman 30h 침묵 경보 실수신 · pytest 57 · dbt build PASS=129 · CI 3관문 |

- 저장소: [github.com/dj258255/dbtower-lakehouse](https://github.com/dj258255/dbtower-lakehouse) (실측 기록 docs/VERIFICATION.md)
- 깊이가 필요하면: [블로그 총정리 0편](/blog/project/lakehouse/lakehouse-0-why) (시리즈 0~5편)

## 링크 모음

**DBTower**
- GitHub 저장소: [github.com/dj258255/dbtower](https://github.com/dj258255/dbtower)
- 블로그 총정리(0~9편): [dbtower-0-overview](/blog/project/dbtower/dbtower-0-overview)
- 직접 실행(GHCR): `docker pull ghcr.io/dj258255/dbtower`
- 재현 기록: docs/VERIFICATION.md 117개 절

**DBTower-lakehouse**
- GitHub 저장소: [github.com/dj258255/dbtower-lakehouse](https://github.com/dj258255/dbtower-lakehouse)
- 블로그 총정리(0~5편): [lakehouse-0-why](/blog/project/lakehouse/lakehouse-0-why)
- 운영 절차(RUNBOOK): [docs/RUNBOOK.md](https://github.com/dj258255/dbtower-lakehouse/blob/main/docs/RUNBOOK.md)

**오픈소스**
- Spring Boot [PR #49063](https://github.com/spring-projects/spring-boot/pull/49063) · Apache Lucene [PR #15675](https://github.com/apache/lucene/pull/15675)

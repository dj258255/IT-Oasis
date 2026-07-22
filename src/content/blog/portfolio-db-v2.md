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

1. **DBA 병목을 인터페이스 하나로 끊고 싶었습니다.**
   - DB에 이슈가 나면 개발자는 흩어진 도구를 오가다 결국 DBA에게 묻고, DBA는 같은 질문에 반복해서 답합니다. 관리 대상 DB가 늘수록 이 반복은 사람 손이 선형으로 늘어나는 구조가 됩니다.
2. **흩어진 지표가 문제의 뿌리입니다.**
   - CPU는 모니터링 대시보드에, 쿼리 통계는 기종마다 다른 시스템 뷰에, 실행계획은 콘솔에 있고, 백업·모니터링·계정 관리 구문마저 5기종이 전부 다릅니다. 한 번의 진단이 여러 도구와 여러 문법을 오갑니다.
3. **업계가 이미 정의한 문제이고, 그 이름이 DBRE입니다.**
   - 국내 대형 서비스 기업들이 사내 DB 어드민 플랫폼을 직접 만들어 운영하고, AWS가 CloudWatch 위에 RDS Performance Insights를 별도 층으로 얹은 이유가 같은 문제의식입니다. 정형화된 운영 업무를 자동화해 서비스와 DB가 늘어도 사람 손이 선형으로 늘지 않게 만드는 게 DBRE(Database Reliability Engineering)입니다. 현직 DBA 지인의 한마디가 스펙이 됐습니다. "플랫폼에서 하나의 기능으로 30분 주기 백업하고 싶어 하면, 각 DBMS가 알아서 자기 구문으로 백업하게." 추상 수준에서 정책을 설계하고, 인터페이스를 상속받아 기종별로 특화 구현하는 일입니다.
4. **목표는 두 줄입니다.**
   - 개발자가 DBA 문의 없이 스스로 분석하고, 개발팀과 DB팀이 다섯 기종을 하나의 툴·같은 화면·같은 용어로 보는 것입니다.

![다섯 기종 여섯 인스턴스가 같은 카드, 같은 그래프, 같은 진단으로 뜨는 대시보드 실물](/uploads/project/dbtower/dashboard.png)

### 아키텍처

이미 검증된 메트릭 스택(Prometheus·Grafana) 위에서 "그 시각에 어떤 쿼리가 원인이고, 실행계획이 왜 나쁘고, 무엇을 해야 하나"에 답하는 층을 맡았습니다. 소비자 3채널(웹 콘솔·MCP·웹훅)이 같은 코어를 부르고, 코어는 `DbmsOperator` 인터페이스 뒤의 기종별 구현체 5개만 봅니다. 바깥 경계는 소비자를, 안쪽 경계는 기종을 숨깁니다. 플랫폼 자기 저장소(메타 PG)는 관리 대상 DB와 물리적으로 분리했는데, 대상 장애가 플랫폼까지 죽이면 관제탑이 정작 필요한 순간에 눈이 멀기 때문입니다.

![상세 아키텍처, 컨테이너 경계·포트, 폴러와 채널의 실제 배선, 메타 DB와 대상 DB 5기종](/uploads/project/dbtower/architecture-detail.svg)

![메타 DB 데이터 모델, 인스턴스 레지스트리·스냅샷·베이스라인·감사 테이블의 관계](/uploads/project/dbtower/erd.svg)

메타 DB는 PostgreSQL이고 인스턴스 레지스트리·스냅샷·베이스라인·감사 테이블로 나뉩니다. 스냅샷 테이블이 시점 비교의 원료이고, 이 저장소 자신을 관리 대상으로 등록해 도그푸딩했습니다.

### 판단 1. 경계를 "운영 행위"에 긋고, 실증했습니다

1. **다섯 기종은 통계 방식도 시간 단위도 전부 다릅니다.**
   - 쿼리 통계를 주는 방식부터 시간 단위(피코초·밀리초·마이크로초)까지 제각각입니다.
2. **그래서 경계를 "운영 행위"에 그었습니다.**
   - SQL 문법이 아니라 통계 조회·실행계획·백업이라는 운영 행위에 경계를 두면, SQL이 없는 MongoDB까지 같은 틀에 들어옵니다.
3. **새 기종은 구현체(Operator) 하나만 추가하면 됩니다.**
   - Oracle·MongoDB처럼 성격이 정반대인 기종도 인터페이스가 정한 메소드(통계 조회·실행계획·백업 등)만 구현하면 끝이었습니다. 시점비교·회귀감지·콘솔·MCP는 그 메소드를 호출만 하니 기종이 늘어도 그대로입니다.
4. **JPA 통일안은 방향이 반대라 접었습니다.**
   - 대상이 런타임에 등록되는 N개의 남의 DB이고 MongoDB엔 JPA가 없어, 추상화를 JPA/JDBC보다 위에 뒀습니다.

### 판단 2. 도구의 선은 판정·기록까지, 실행은 사람 뒤에 둡니다

1. **DBA 손이 반복해서 가는 다섯 지점을 자동화했습니다.**
   - 설정 드리프트 이력·스키마 리뷰 게이트·인덱스 판정·인시던트 리포트·월간 리포트를 전부 읽고 판정·기록까지만 하며, 대상 DB는 바꾸지 않습니다.
2. **대상을 실제로 바꾸는 경로는 딱 하나만 열어 봉인했습니다.**
   - gh-ost 온라인 스키마 변경 하나뿐이고, ADMIN 전용·기본 dry-run·AI 미노출입니다.
3. **AI 채널도 read-only만 열었습니다.**
   - MCP 도구 16종에 화이트리스트만 노출하고 kill·backup·DDL은 아예 등록하지 않았습니다.

### 판단 3. "평소와 지금의 차이"를 짚습니다

처음 떠올린 "부하 상위 쿼리를 보여주자"가 함정이었습니다. 부하 1위 쿼리는 평소에도 1위였을 수 있기 때문입니다. 장애의 진짜 범인은 새로 유입된 쿼리거나 평소 대비 급증한 쿼리인 경우가 많습니다. 그래서 관측 자체가 아니라 "평소와 지금의 차이"를 짚는 쪽으로 방향을 틀었고, 그 판단이 시점 비교와 회귀 감지의 뿌리가 됐습니다.

### 식별에서 문의까지 이어지는 진단 흐름

![진단 흐름: 문제 쿼리 식별 → 원인 분석 → 공유·DB팀 문의](/uploads/project/dbtower/insight-flow.svg)

**식별의 시작은 통합 헬스 스코어입니다.** 흩어진 신호(이상·Advisors·SLO·백업 신선도)를 인스턴스별 0~100점으로 합산해 나쁜 순으로 정렬하니, 대시보드보다 분류(triage) 큐에 가까운 아침 첫 화면이 됩니다. 그 성격은 설계에서 신경 쓴 세 가지가 만듭니다.

1. **"데이터 부족"과 "나쁨"을 구분합니다.**
   - 신호 없는 신규 인스턴스는 0점이 아니라 INSUFFICIENT_DATA로 둡니다.
2. **접속이 안 되면 치명으로 처리합니다.**
   - 다른 신호가 무의미하니 health 프로브 예외는 down으로 수렴시킵니다.
3. **신호 하나의 실패가 스코어 전체를 죽이지 않습니다.**
   - 신호를 격리(partial)해, 하나의 수집 실패가 나머지를 무너뜨리지 않게 했습니다.

실측에서 canary 인스턴스를 kill하자 F 35점으로 최상단에 부상하는 것을 보고 이 화면의 역할이 분명해졌습니다.

![감점 사유 분해와 나쁜 순 정렬로 아침 첫 화면이 되는 통합 헬스 스코어](/uploads/project/dbtower/health-score.png)

**시점 비교는 "평소 구간"과 "문제 구간"을 같은 화면에서 가릅니다.** CPU 그래프 위 드래그로 조회 구간(초록)과 비교 구간(주황)을 고르면, 신규 쿼리 유입(NEW 뱃지)·호출량 급증·Latency와 rows/call 증가(IN절 폭증류)라는 세 갈래 원인이 갈립니다. 원리는 누적 카운터의 차분입니다.

1. **구간 양 끝 스냅샷의 차분이 그 구간의 실제 발생량입니다.**
   - 쿼리 통계는 서버 기동 이후 누적 카운터라, 스냅샷을 주기로 쌓아 두면 양 끝 차분이 구간 발생량이 됩니다. 구간 길이가 달라도 비교되게 QPS로 정규화하고, 평소 구간에 없던 쿼리는 신규로 표시합니다.
2. **함정은 구간 경계가 스냅샷 시각을 포함해야 한다는 것입니다.**
   - 경계를 스냅샷보다 1초만 늦게 잡아도 그 사이 발생량이 전부 이전 스냅샷에 흡수돼 차분이 0이 됩니다. 레퍼런스가 CPU 그래프를 드래그해 구간을 고르게 만든 이유를 이 경계를 밟으며 몸으로 이해했습니다.
3. **이 비교를 폴러가 스스로 돌리면 회귀 자동 감지가 됩니다.**
   - rows/call은 실행계획 변화나 IN절 파라미터 폭증의 대리 신호이고, 그 값이 테이블 전체 행수와 같으면 풀스캔이라는 뜻입니다. 사람이 아니라 폴러가 "최근 구간 vs 직전 베이스라인"으로 비교하면 회귀가 자동으로 잡힙니다.

![두 구간의 쿼리별 증감률과 신규 쿼리 NEW 뱃지를 보여주는 시점 비교 실물](/uploads/project/dbtower/compare.png)

**"DB팀에 문의" 버튼은 진단 재료를 한 메시지로 묶어 보냅니다.** 현재 패널의 쿼리·실행계획·규칙 지적·AI 분석에, 참조 테이블 구조(기종별 CREATE TABLE 전문·행수·데이터/인덱스 크기·인덱스 카디널리티)까지 서버가 자동 첨부해 Discord/Slack 웹훅으로 보냅니다.

1. **스키마를 붙인 건 실사용자의 지적에서 나왔습니다.**
   - "느려요 + 실행계획"까지 와도 조인 컬럼에 인덱스가 있는지·타입이 맞는지 판단할 재료가 없으면 받는 DB팀이 결국 다시 물어야 합니다. Seq Scan이 찍혀 있어도 어떤 인덱스가 있고 왜 안 탔는지는 구조를 봐야 압니다.
2. **뽑은 테이블은 실제 스키마와 교집합해 검증합니다.**
   - SQL에서 FROM·JOIN 뒤 테이블을 뽑되, 정규식 파싱은 서브쿼리·CTE·별칭에서 오탐이 나므로 후보를 실제 스키마와 대조하고, 못 찾은 건 "구조 미확보"로 정직하게 표기합니다.
3. **DDL은 출처 라벨을 답니다.**
   - MySQL `SHOW CREATE TABLE`처럼 엔진이 준 원문이면 NATIVE, PostgreSQL처럼 단일 명령이 없어 `pg_get_constraintdef`·`pg_get_indexdef`로 조립하면 RECONSTRUCTED입니다. 재구성한 것을 원문인 척 보여주지 않는다는 원칙입니다.

자동 경보(회귀·이상·플랜 플립)가 플랫폼이 미는 push라면, 문의는 사람이 트리거하는 push라 같은 웹훅 어댑터를 재사용합니다.

![DB팀 문의 Discord embed 실물](/uploads/project/dbtower/inquiry-discord.png)

### 기능 지도

| 영역 | 기능 |
|---|---|
| 관측 | 상위 SQL(Load=시간 점유율 순, AAS류)·슬로우 쿼리 수집 폴러 · 테이블 상세(DDL·크기·인덱스 카디널리티) · Wait Event · 복제 상태·레플리케이션 슬롯 · p95(실측/추정/미지원 라벨 분리) |
| 진단 | 통합 헬스 스코어 → 시점 비교(구간 차분) → 회귀·이상 감지(요일x시간대 z-score) → 플랜 플립(60초 내) → 실행계획 규칙 → 심층 진단(추정 vs 실제) → 원클릭 재진단 → 처방·Advisors |
| 운영 | 백업 정책·복원 자동 검증(VERIFIED/FAILED/UNSUPPORTED) · SLO/에러 버짓 · FinOps 신호(미사용 인덱스 관측기간 라벨) · 감사 로그 · 최소 권한 계정 |
| 운영 병목 | 설정 변경 이력(시간축 드리프트) · 스키마 변경 리뷰 게이트(규칙 판정+AI 소견+ADMIN 승인, 실행은 안 함) · 인시던트 리포트(장애 구간 재구성+AI 요약) · 월간 점검 리포트(매월 자동). 전부 읽고 판정·기록까지 하며 대상 DB는 바꾸지 않음 |
| 채널 | 웹 콘솔(의존성 0 정적 SPA, 검색 구동 인스턴스 선택기로 수백~수천 대 확장, SQL·실행계획 구문강조, 차트 호버·드래그 전부 자체 구현) · MCP 도구 16종(JSON-RPC 2.0 직접 구현, OAuth 2.1 브라우저 로그인) · 웹훅 경보와 DB팀 문의(Discord embed) |
| 프로비저닝(IaC) | DB가 태어나는 순간 자동 등록: K8s(CloudNativePG) 프로비저닝→등록→health up e2e 완주 · Ansible 멱등 등록(changed=0) · Terraform validate. 도구 셋이 멱등 등록 PUT 하나로 수렴 |
| 안전 | 쿼리 타임아웃 15s · 지수 백오프 · 인스턴스당 풀 상한 · AI read-only 화이트리스트(kill·backup·online-ddl 제외) · 스택 쿼리 차단 |
| 실행구(유일) | 온라인 스키마 변경(gh-ost, `onlineddl`). ADMIN 전용·기본 dry-run·MySQL 전용·AI 미노출로, 리뷰 게이트(판정)와 분리된 실제 실행 경로 |

### 하나의 백업 정책, 네 갈래 실행 모델

**"30분마다 백업하라"처럼 정책을 한 번 걸면, 각 DB가 자기 방식으로 백업을 돕니다.** 정책(주기·보존·검증)은 플랫폼이 추상 수준에서 관리하고, 실행은 기종별 구현체가 각자 지원하는 방식으로 합니다. 기종은 다섯인데 실행 모델은 네 개로 줄어듭니다. MySQL과 PostgreSQL이 "외부 덤프 CLI에 비밀번호를 환경변수로 넘긴다"는 같은 방식이라 한 모델로 묶여, 추상화가 실제로 중복을 지워냈습니다.

| 실행 모델 | 기종 | 비밀번호 전달 |
|---|---|---|
| 외부 CLI + 환경변수 | MySQL(mysqldump), PostgreSQL(pg_dump) | `MYSQL_PWD` / `PGPASSWORD` |
| 외부 CLI + stdin | MongoDB(mongodump) | `--config /dev/stdin` |
| 서버 사이드 SQL | SQL Server | 필요 없음 (`BACKUP DATABASE`) |
| 서버 사이드 API | Oracle | 필요 없음 (`DBMS_DATAPUMP` PL/SQL) |

1. **비밀번호는 argv 밖으로 뺐습니다.**
   - `ps`로 프로세스 인자를 보면 비밀번호가 노출되니 외부 명령엔 환경변수로만 넘기고 `{password}` 플레이스홀더 자체를 금지했습니다. `MYSQL_PWD`를 안 읽는 xtrabackup은 소유자 전용 임시 conf로 우회해 호스트·컨테이너 어느 argv에도 남지 않게 했습니다.
2. **stdin YAML 주입을 막았습니다.**
   - 비밀번호에 개행을 넣어 mongodump 설정의 다른 키를 주입할 수 있는 구멍을 보안 리뷰로 찾아, 제어 문자를 거부하고 스칼라 이스케이프로 막은 뒤 주입 거부를 테스트로 고정했습니다. 등록자가 관리자라 가능성은 낮지만 관리 플랫폼은 심층 방어가 기본입니다.
3. **성공 판정은 로그가 아니라 복원으로 합니다.**
   - VERIFIED/FAILED/UNSUPPORTED 3값으로 표기하고 3-2-1 원칙의 S3(MinIO) 오프사이트 사본까지 자동화했습니다. "binlog 수집 경로가 없어 못 함"과 "로그 백업이 서버 에러로 깨짐"은 다른 사실이라 UNSUPPORTED를 따로 뒀고, 물리 백업은 격리 컨테이너에서 `xtrabackup --prepare`를 실제 실행해 크래시 복구까지 돼야 VERIFIED입니다.
4. **정책은 (인스턴스, 타입)별로 병행합니다.**
   - "FULL 앵커는 드물게 + LOG 체인은 촘촘하게"를 자동 스케줄로 겁니다. RPO는 로그 주기가, RTO는 앵커 최신성이 정하기 때문입니다. 신선도는 앵커 기준이라 LOG 성공이 FULL 실패를 가리지 못합니다.
5. **증분은 겹침으로, 시점 복구는 실행으로 증명했습니다.**
   - Mongo oplog 증분은 `$gte`로 마지막 엔트리를 한 건 겹쳐 받아, 첫 엔트리가 직전 마커와 일치하면 빈틈이 없다는 물증이 됩니다(1차 215,848 → 2차 7,686바이트, 28분의 1). PITR은 MSSQL STOPAT·PG recovery_target_time으로 목표 시점 직전 정지를 서버 로그로 확인했고, 산출물은 AES-256-GCM으로 암호화해 1비트만 변조돼도 복원이 조용히 오염되는 대신 명확히 실패하게 했습니다.

![백업·PITR 카드 실물, 물리(xbstream) 앵커와 복원 가능 창](/uploads/project/dbtower/xtrabackup-physical.png)

### 고가용성 대비

1. **이중화 상태를 플랫폼에서 바로 관측합니다.**
   - 복제 상태와 레플리케이션 슬롯을 수집에 포함했습니다. `pg_stat_replication`은 연결된 복제만 보여줘 "비활성 슬롯이 WAL을 무한 보존해 디스크를 채우는" 대표 장애를 놓치는데, `pg_replication_slots` 한 줄로 `wal_status='lost'`·`unreserved`를 잡아 그 사각을 메웠습니다.
2. **WAL은 주기 수집이 아니라 실시간 스트리밍으로 받습니다.**
   - `pg_receivewal --slot`으로 수집 주기라는 창 자체를 없애고, 복제 슬롯이 수신자 부재 중의 WAL까지 보존하게 했습니다. 프로세스를 죽여도 재시작 사이 유실이 0인 것을 실측했습니다.
3. **플랫폼 자신의 멀티노드 페일오버를 실측했습니다.**
   - 분산 락(ShedLock) 위에 수집 샤딩을 얹어 2노드가 일을 나눠 들고, 한 노드를 죽이면 남은 노드가 설정 변경 없이 전 샤드를 인수합니다. 스냅샷이 누적 카운터의 차분이라 담당이 바뀌어도 데이터가 안 깨져 consistent hashing 같은 리밸런싱이 필요 없습니다. 분산과 페일오버가 같은 메커니즘이라는 게 이 구조의 값입니다.

![페일오버 실측, 한 노드를 죽인 뒤 node B가 같은 세션 쿠키로 콘솔을 서빙](/uploads/project/dbtower/node-b-survivor.png)

### 프로비저닝: 세 도구가 멱등 등록 하나로 수렴합니다

**K8s·Ansible·Terraform 세 층이 전부 `PUT /api/instances` 하나를 접점으로 씁니다.** IaC는 재실행되는 물건이라 POST로 등록하면 재시도마다 같은 DB가 여러 번 등록됩니다. 이름을 논리 식별자로 삼아 "같은 이름이면 갱신, 없으면 신규"로 만드니, 완전히 다른 세 도구가 잘 정의된 멱등 API 하나로 수렴합니다. 같은 등록 흐름의 완주는 K8s(CloudNativePG e2e)와 Ansible(changed=0)에서 확인했고, Terraform은 apply에 실제 RDS 과금이 필요해 validate까지만 확인했다고 문서에 적었습니다.

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
| 새 기종 추가 비용 | **구현체 1개만 추가**, 공통 코드 무변경 (Oracle·MongoDB로 실증) |
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

![데이터 모델, 원천 2테이블에서 raw parquet·staging·marts(contract 강제)와 운영 테이블까지의 컬럼 계보, 누적 카운터가 일간 델타로 접히는 변환 지점 표기](/uploads/project/lakehouse/erd.svg)

원천 2테이블이 raw parquet에서 staging을 거쳐 marts로 흐르고, marts는 contract로 컬럼 타입을 강제합니다. 이 계보의 심장은 서버 기동 이후 누적 카운터를 하루 양 끝 차분으로 접어 일간 델타로 바꾸는 변환 지점입니다.

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

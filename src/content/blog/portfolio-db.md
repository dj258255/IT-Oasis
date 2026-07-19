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

**같이 일하는 사람과 사용하는 사람 모두에게 도움이 되고 싶습니다.**

- 오픈소스의 문제를 직접 해결해 Spring Boot(4.1.0-M2)·Apache Lucene(main merge)에 기여가 반영됐습니다
- 코딩테스트를 힘들어하는 친구를 위해 CodingTestKit(다운로드 750+)을 만들어 운영합니다

**Database**: MySQL, PostgreSQL, Oracle, SQL Server, MongoDB
**Backend**: Java 21, Spring Boot, JPA / JdbcTemplate
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

- 기간: 2026.03 ~ 2026.07 · 개인(100%) · [GitHub](https://github.com/dj258255/dbtower) · [블로그 시리즈 0~9편](/blog/project/dbtower/dbtower-0-overview)
- 스택: Java 21, Spring Boot, PostgreSQL(메타), JdbcTemplate·Mongo Driver·JDBC batch(적재적소), MCP(JSON-RPC 2.0 직접 구현), Flyway, ShedLock, Docker, k6
- 규모 가정: 관제 도구라 실사용 트래픽은 수십 RPS를 예상하고 단일 노드 셀프호스트 운용을 전제했다. 그래도 배포 전 k6로 부하를 걸어 안정성을 확인했다(10 VU 30s: **2,832 req/s**, P95 5.86ms, 실패 0)
- 측정 환경: 로컬 Docker(Apple Silicon) 위 대상 DB 5기종. 모든 수치는 개선 전을 먼저 재고 고친 뒤 다시 잰 전/후 실측이며, 재현 절차는 VERIFICATION.md 117개 절에 보존

### 왜 만들었는가

**DB에 이슈가 나면 개발자는 흩어진 도구를 오가다 결국 DBA에게 묻고, DBA는 같은 질문에 반복해서 답한다. **관리 대상 DB가 늘수록 사람 손이 선형으로 늘어나는 구조**를 인터페이스 하나로 끊고 싶었다.**

- CPU는 모니터링 대시보드에, 쿼리 통계는 기종마다 다른 시스템 뷰에, 실행계획은 콘솔에 흩어져 있다. 백업·모니터링·계정 관리 구문도 5기종이 전부 다르다
- 업계가 이미 정의한 문제이기도 하다. 국내 대형 서비스 기업들이 사내 DB 어드민 플랫폼을 직접 만들어 운영하고, AWS가 CloudWatch 위에 RDS Performance Insights를 별도 층으로 얹은 이유가 같은 문제의식이다
- **범위 결정**: 메트릭 수집·시각화 스택(Prometheus·Grafana)은 이미 검증돼 널리 쓰이는 것이라 다시 만들지 않았다. **DBTower가 맡는 건 그 위의 층이다. "그 시각에 어떤 쿼리가 원인이고, 실행계획이 왜 나쁘고, 무엇을 해야 하나"에 답한다.** 바퀴를 다시 발명하지 않고 기존 스택이 못 답하는 질문에 집중했다
- **목표 두 줄**: 개발자가 DBA 문의 없이 스스로 분석하고, 개발팀과 DB팀이 다섯 기종을 하나의 툴·같은 화면·같은 용어로 본다

### 누구에게 도움이 되는가

- **DBA에게 반복 문의하던 개발자**: 헬스 스코어(어느 인스턴스가 나쁜가) → 시점 비교(어느 쿼리가 문제인가) → 실행계획 규칙(계획이 왜 나쁜가) → 심층 진단(옵티마이저는 왜 속았나) → 처방(무엇을 고치나)까지 한 화면에서 스스로 분석한다
- **같은 질문에 반복 답하던 DB팀**: "DB팀에 문의" 버튼이 쿼리·실행계획·규칙 지적·AI 분석을 Discord 카드 한 장으로 묶어 보낸다. 받는 쪽이 맥락을 다시 물을 필요가 없다
- **배포 형태**: 설치형(셀프호스트)으로 배포한다. DB 접속 정보를 외부 서비스에 맡기지 않아도 되고 사설망 안의 DB에도 그대로 닿는다. 별도 서버 비용도 들지 않는다(Grafana·PMM과 같은 모델). GHCR 공개 이미지를 받아 compose 한 번이면 뜬다

![다섯 기종 여섯 인스턴스가 같은 카드, 같은 그래프, 같은 진단으로 뜨는 대시보드 실물](/uploads/project/dbtower/dashboard.png)

### 아키텍처

![DBTower 전체 구조, 소비자 차이는 채널 뒤로, 기종 차이는 DbmsOperator 뒤로, 기술 차이는 각자의 제자리로](/uploads/project/dbtower/architecture-full.svg)

- 소비자 3채널(웹 콘솔·MCP·웹훅) → 플랫폼 코어(수집 폴러·시점비교·회귀감지·헬스스코어·자율진단) → `DbmsOperator` 인터페이스 → 기종별 구현체 5개
- 경계는 "운영 행위"에 있다. SQL 없는 MongoDB가 같은 인터페이스로 들어온 것이 그 증거다
- AI 채널은 안전을 구조로 보장한다. MCP 서버를 JSON-RPC 2.0 스펙으로 직접 구현해 도구 16종을 노출하되, AI에는 **read-only 도구 화이트리스트만** 열어 대상 DB 변경 0을 코드 레벨에서 강제했다. 실제로 대상 DB를 바꾸는 유일한 기능(gh-ost 온라인 스키마 변경)은 kill·backup과 함께 화이트리스트에서 빼 MCP 도구로 아예 등록하지 않는다. 인증(OAuth 2.1·화이트리스트 기본 거부), 외부 발신 SQL 리터럴 마스킹까지 단계별 보안 3겹이다

### 운영 상세 아키텍처

![상세 아키텍처, 컨테이너 경계·포트, 폴러와 채널의 실제 배선, 메타 DB와 대상 DB 5기종](/uploads/project/dbtower/architecture-detail.svg)

### 식별에서 문의까지 이어지는 진단 흐름

![진단 흐름: 문제 쿼리 식별 → 원인 분석 → 공유·DB팀 문의](/uploads/project/dbtower/insight-flow.svg)

식별의 시작은 통합 헬스 스코어다. 흩어진 신호(이상·Advisors·SLO·백업 신선도)를 인스턴스별 0~100점으로 합산해 나쁜 순으로 정렬한, 아침에 여는 첫 화면이다.

![감점 사유 분해와 나쁜 순 정렬로 아침 첫 화면이 되는 통합 헬스 스코어](/uploads/project/dbtower/health-score.png)

시점 비교는 CPU 그래프 위 드래그로 조회 구간(초록)과 비교 구간(주황)을 고르고, 신규 쿼리 유입(NEW 뱃지), 호출량 급증, Latency·rows/call 증가(IN절 폭증류)의 세 갈래 원인을 같은 화면에서 가른다.

![두 구간의 쿼리별 증감률과 신규 쿼리 NEW 뱃지를 보여주는 시점 비교 실물](/uploads/project/dbtower/compare.png) 웹 콘솔의 "DB팀에 문의" 버튼은 현재 패널의 쿼리·실행계획·규칙 지적·AI 분석에 참조 테이블 구조(기종별 CREATE TABLE 전문·행수·데이터/인덱스 크기·인덱스 카디널리티, 서버 자동 첨부)까지 한 메시지로 묶어 Discord/Slack 웹훅으로 보낸다.

![DB팀 문의 Discord embed 실물](/uploads/project/dbtower/inquiry-discord.png) 자동 경보(회귀·이상·플랜 플립)가 플랫폼이 사람에게 미는 push라면, 문의는 사람이 트리거하는 push라서 같은 웹훅 어댑터를 재사용한다.

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

**"30분마다 백업하라"처럼 한 번 정책을 걸면, 각 DB가 알아서 자기 방식으로 백업을 돈다.** 백업 정책(주기·보존·검증)은 플랫폼이 추상 수준에서 관리하고, 실행은 기종별 구현체가 각자 지원하는 방식으로 수행한다. 재밌는 건 **기종은 다섯인데 실행 모델은 네 개로 줄어든다**는 점이다. MySQL과 PostgreSQL은 "외부 덤프 CLI에 비밀번호를 환경변수로 넘긴다"는 같은 방식이라 한 모델로 묶인다. 추상화가 실제로 중복을 지워낸 자리다.

| 실행 모델 | 기종 | 비밀번호 전달 |
|---|---|---|
| 외부 CLI + 환경변수 | MySQL(mysqldump), PostgreSQL(pg_dump) | `MYSQL_PWD` / `PGPASSWORD` |
| 외부 CLI + stdin | MongoDB(mongodump) | `--config /dev/stdin` |
| 서버 사이드 SQL | SQL Server | 필요 없음 (`BACKUP DATABASE`) |
| 서버 사이드 API | Oracle | 필요 없음 (`DBMS_DATAPUMP` PL/SQL) |

- **stdin YAML 주입 방어**: 비밀번호에 개행을 넣으면 mongodump 설정의 다른 키를 주입할 수 있는 구멍을 보안 리뷰로 발견, 제어 문자를 거부하고 작은따옴표 스칼라 이스케이프로 막은 뒤 주입 시도가 거부되는 것을 테스트로 고정했다
- **성공 판정은 로그가 아니라 복원**: VERIFIED/FAILED/UNSUPPORTED 3값으로 표기하고, 3-2-1 원칙의 S3(MinIO) 오프사이트 사본까지 자동화했다
- **정책은 (인스턴스, 타입)별 병행**: 현업 정석인 "FULL 앵커는 드물게 + LOG 체인은 촘촘하게"를 자동 스케줄로 건다. 신선도는 앵커 기준이라 LOG 성공이 FULL 실패를 가리지 못한다
- **시점 복구는 실행으로 증명**: MSSQL은 STOPAT으로 6행짜리 현재에서 5행짜리 과거를, PG는 recovery_target_time으로 목표 시점 직전 정지를 서버 로그로 확인했다. 산출물은 AES-256-GCM으로 암호화해 변조가 조용한 오염 대신 명확한 실패가 되게 했다

![백업/PITR 카드 실물 — 물리(xbstream) 앵커와 복원 가능 창](/uploads/project/dbtower/xtrabackup-physical.png)

### 고가용성 대비

- **이중화 관측**: 복제 상태와 레플리케이션 슬롯을 수집 체계에 포함해, 이중화 구성의 상태를 플랫폼에서 바로 관측한다
- **복구선**: 백업의 복원 검증 3값과 3-2-1 원칙의 S3 오프사이트 사본이 가용성의 마지막 방어선이다
- **플랫폼 자신의 멀티노드 실측**: 분산 락(ShedLock) 위에 수집 샤딩(샤드별 락)을 얹어 2노드가 일을 나눠 들고, 한 노드를 죽이면 남은 노드가 설정 변경 없이 전 샤드를 인수하는 것을 실측했다. 세션과 로그인 잠금 카운터도 메타 DB로 옮겨 노드를 오가도 상태가 하나다

![페일오버 실측 — 한 노드를 죽인 뒤 node B가 같은 세션 쿠키로 콘솔을 서빙한다](/uploads/project/dbtower/node-b-survivor.png)

### 데이터 모델

![메타 DB 데이터 모델, 인스턴스 레지스트리·스냅샷·베이스라인·감사 테이블의 관계](/uploads/project/dbtower/erd.svg)

### 1. 새 기종을 추가해도 플랫폼은 그대로이도록 경계를 설계하고 실증했다 ([2편](/blog/project/dbtower/dbtower-2-engines-and-diagnosis))

**이 프로젝트에서 가장 신경 쓴 한 가지. 새 DB를 붙일 때 플랫폼 코드가 같이 커지면, 관리 대상이 늘수록 사람 손도 비례해 늘어난다. 그래서 "무엇을 하느냐(운영 행위)"로 경계를 긋고, "어떻게 하느냐(기종별 문법)"는 각 구현체 뒤에 숨겼다.** 사용하는 쪽은 `백업하라`·`실행계획 보여줘`만 알면 되고, 그게 MySQL이든 MongoDB든 신경 쓸 필요가 없다.

- **문제**: 다섯 DBMS는 같은 "쿼리 통계"를 주는 방식이 전부 다르다(performance_schema / pg_stat_statements / DMV / V$SQL / system.profile). 기종이 늘 때마다 플랫폼 코드가 함께 커지면, 관리 대상이 늘수록 사람 손이 비례해 늘어나는 구조를 도구가 그대로 물려받는다
- **판단**: 경계를 SQL 문법이 아니라 "운영 행위"(통계 조회·실행계획·백업)에 그으면, SQL도 JDBC도 없는 MongoDB까지 같은 틀에 들어온다고 봤다
- **실증**: 성격이 정반대인 Oracle과 MongoDB를 실제로 추가했다. 수집·시점비교·회귀감지·웹 콘솔·MCP 전부 **코어 경로 0줄 수정**. 이후 능력 확장(Wait Event·플랜플립·p95)도 "메서드 1개 추가"의 반복이었다. 경계를 처음에 잘 그어둔 덕을 계속 봤다

### 2. "인덱스가 있는데 왜 안 타요"에 옵티마이저가 속은 이유까지 답했다 ([2편](/blog/project/dbtower/dbtower-2-engines-and-diagnosis))

**DBA가 개발자에게 가장 많이 받는 질문 하나. "겉보기"만 봐서는 못 잡고, DB가 실제로 어떻게 돌렸는지(실제 실행계획)를 봐야 원인이 보인다. DBTower는 그 "왜 속았는지"까지 답하고, 고친 뒤 다시 재서 나아졌음을 보여준다.**

- **정상 상태**: `code VARCHAR` 컬럼에 B-Tree 인덱스. 쿼리만 봐서는 멀쩡해 보인다
- **문제 발견**: `WHERE code = 12345`(따옴표 누락)가 풀스캔을 탄다. 추정 EXPLAIN만으로는 옵티마이저가 "왜 속았는지" 보이지 않는다
- **원인 분석**: 추정 행수와 실제 행수의 괴리를 봐야 한다. 실제 실행계획 취득 경로가 5기종 전부 달라 각각 구현했다(EXPLAIN ANALYZE / ANALYZE,BUFFERS / DISPLAY_CURSOR / STATISTICS XML / executionStats). actual rows는 루프당 평균이라 loops를 곱해야 하는 함정은 단위 테스트로 고정했다
- **해결**: 추정 300행 vs 실제 1행, **괴리 300배**에서 암시적 형변환을 지목. 수정안 SQL의 원클릭 재진단 before/after로 괴리 해소와 **Index lookup 전환**까지 확인했다
- **정합성 위험까지 증명**: 수정 전의 "실제 1행"이 사실 `'012345'`가 캐스팅으로 잘못 매칭된 행이었다. 형변환은 성능 문제로 보이지만 실제로는 정확성 문제였다. 조회면 오답이고, UPDATE/DELETE였으면 데이터 사고다

![심층 원인 진단 실물 — 추정 300행 대 실제 1행, 암시적 형변환 지목과 처방](/uploads/project/dbtower/deep-diagnose.png)

![수정안 원클릭 재진단 before/after — 괴리 300배에서 없음으로, 풀스캔이 Index lookup으로](/uploads/project/dbtower/deep-before-after.png)

### 3. 만든 진단 도구를 자기 자신에게 먼저 쓴다

- **발견**: 메타 저장소 PostgreSQL을 DBTower 자신의 관리 대상으로 등록했더니, 자기 스냅샷 조회 쿼리가 자기 화면의 슬로우 쿼리 목록에 떴다(50만 행 적재 상태)
- **원인**: 자기 explain API로 진단하자 자체 분석기가 "Seq Scan 발생, 인덱스를 검토하세요"라고 자기 자신을 지적했다
- **해결**: 등치 조건인 `instance_id`를 선두에 둔 복합 인덱스를 추가하고 같은 API로 재진단, "규칙에 걸린 비효율 신호가 없습니다"
- **결과**: **21.269ms → 0.062ms(343배)**. 개선을 측정한 도구가 곧 내가 만든 기능이라는 순환이, 이 플랫폼이 실제로 동작한다는 증거다

![도그푸딩 실물 — 자기 쿼리의 풀스캔을 자기 실행계획 화면이 잡아냈다](/uploads/project/dbtower/explain.png)

### 성능 개선 기록

| 문제 | 원인 | 해결 | 전/후 |
|---|---|---|---|
| 수집(폴링)마다 지연 | 매 수집 새 커넥션 생성으로 TCP+인증 핸드셰이크 반복 | 인스턴스별 HikariCP 풀(대상 DB 보호를 위해 max 2) | **47.1 → 11.8ms (4.0배)** |
| 스냅샷 대량 저장이 느림 | JPA saveAll이 행별 INSERT 발행 | JDBC 배치 삽입(한 번에 여러 행 전송) | 행당 **1.51 → 0.11ms (13.8배)** |
| 자기 조회가 슬로우 쿼리 | 50만 행 Seq Scan(인덱스 없음) | `instance_id` 선두 복합 인덱스(서사 3) | **21.269 → 0.062ms (343배)** |
| 긴 쿼리 통계가 하나로 뭉개짐 | `max_digest_length` 1024에서 digest 절단 | 4096 상향(메모리 영향 계산식 문서화) | side-by-side 재현·해소 |
| 보존 정리가 느리고 블로트 잔존 | 200만 행 벌크 DELETE + dead tuple 404MB | 월별 RANGE 파티셔닝(신테이블→복사→스왑) | DELETE **1.9s → DROP 12.8ms (147배)**·블로트 0 |
| 처리 상한을 모름 | 배포 전 부하 검증 부재 | k6 부하 테스트(10 VU 30s) | **2,832 req/s · P95 5.86ms · 실패 0** |

### 판단과 트레이드오프

- **데이터 접근 적재적소**: 메타 CRUD는 JPA, 스냅샷 대량 쓰기는 JDBC batch, SQL이 없는 MongoDB는 드라이버 직접. 하나의 ORM으로 통일하는 편함 대신 경로별 비용으로 선택했다
- **p95 세 라벨**: MySQL은 히스토그램을 구간 차분해 실측(누적 0.48ms가 가리던 최근 구간 0.19ms를 노출), PostgreSQL은 평균+1.645σ 추정 표기, 원자료 없는 기종은 UNSUPPORTED. 그럴듯한 단일 숫자보다 소스가 다른 숫자를 섞지 않는 쪽을 택했다
- **최소 권한 계정**: 권한 0 계정으로 시작해, DB가 돌려주는 권한 에러 원문을 수집하며 필요한 것만 추가해 확정했다. MongoDB는 커스텀 롤을 만들려다 clusterMonitor가 이미 충분함을 확인했고, PostgreSQL은 pg_monitor 전체가 아니라 pg_read_all_stats로 좁혔다. 권한이 부족하면 PG가 에러 대신 HTTP 200에 전 행 insufficient privilege를 채워 조용히 저하되는 함정도 이때 실측으로 잡았다
- **통계 오염(dbid)**: 도그푸딩 중 `sample` DB와 `dbtower` DB가 서로의 쿼리를 자기 화면에서 보고 있었다. `pg_stat_statements`가 클러스터 전역 뷰라 dbid 필터 없이는 다른 DB 쿼리까지 섞인다. 현재 dbid로 필터해 잡았다. DB 내부를 알아야 보이는 지점이다
- **Terraform은 validate까지**: 실제 RDS apply는 AWS 자격증명과 과금이 필요해 실행하지 않았고, 문서에 그대로 적었다. 같은 등록 흐름의 완주는 K8s와 Ansible에서 확인했다

### 4. 결함 20건 이상을 스스로 감사하고 전부 고치지는 않았다 ([4편](/blog/project/dbtower/dbtower-4-deepening))

- **4축 병렬 감사**: 기능이 쌓인 뒤 동시성·기종별 정확성·보안·수명주기 네 축으로 코드를 정독하고 OWASP·CWE·벤더 문서와 대조해 결함 20건 이상을 찾았다
- **FIX/SKIP 분리**: 전부 고치지 않았다. "안 고쳐도 되는 걸 고치는 것도 부채"라서 재검증 후 FIX와 SKIP을 근거와 함께 갈랐다(예: MySQL 5.7 비호환은 8.0+ 명시 지원으로 SKIP). 수정에는 신규 단위 테스트 28건
- **가장 심각한 결함(XXE)**: 데드락·실행계획 XML을 파싱하는 세 곳이 외부 DTD 로드 차단만 걸어놨는데, OWASP가 "불충분"이라 명시한 조합이다. 조작된 XML을 주는 악성 대상 DB가 있으면 DBTower 호스트가 외부로 요청을 날리는 블라인드 SSRF가 가능했다. 같은 저장소의 DeepAnalyzer는 이미 DOCTYPE 선언 자체를 거부(disallow-doctype-decl)하도록 올바르게 막고 있었으니, 설계를 몰랐던 게 아니라 나중에 만든 파서에 기준을 안 옮긴 일관성 누락이었다. 세 곳을 같은 설정으로 통일하고, XXE 페이로드가 파싱에서 거부되는 것(외부 fetch 없음)을 단위 테스트로 고정했다
- **개선이 만든 부채**: 인스턴스당 풀 max 2에 폴러 8개 이상이 붙자 대기 → 타임아웃 → "죽은 대상" 오인 → 허위 "수집 정지" 경보로 증폭됐다. 직전에 성능을 위해 넣은 수집 병렬화가 이 경합을 키웠다. 풀 상한을 2에서 6으로 올리고 설정값으로 분리해 차단했다
- **실측이 감사를 이김**: "slow_log는 마이크로초를 저장 안 해 복구 불가"라는 감사 결론을 원본 테이블 실측이 뒤집었다(`00:00:00.600594` 저장 확인, 0.6초 쿼리를 600.594ms로 정확 표시). 감사 결론도 실측으로 한 번 더 확인해야 했다

![감사 결론을 뒤집은 실측 — sub-second 슬로우 쿼리가 실측 ms(581·750ms)로 표시된다. 구코드는 전부 0이었다](/uploads/project/dbtower/slowquery-subsecond.png)

### 5. 알림에 이모지를 달면 AI가 진단 답글을 단다 ([8편](/blog/project/dbtower/dbtower-8-talking-and-lakehouse))

- **문제**: 경보를 받아도 분석은 콘솔을 따로 열어 처음부터였다. 사내 플랫폼 사례의 "알럿 스레드 이모지 → AI 분석 댓글" 루프를 셀프호스트 제약에서 재현하고 싶었다
- **함정**: 웹훅이 쓴 메시지의 본문을 봇이 읽으려면 Discord의 Message Content 특권 인텐트(심사 필요)가 있어야 한다
- **해결**: 발송 시점에 message_id를 인스턴스에 매핑해 메타 DB에 영속(재시작 생존 e2e 실측). 반응이 오면 조회 한 번으로 대상이 나온다. **특권 인텐트 0개**
- **실측**: 진단 도구가 전부 빈 결과인 죽은 인스턴스 케이스에서 AI 답글이 수집 5단계를 나열하고 "수치를 지어내지 않겠습니다"로 마감했다. 판단 기준을 사람이 문서로 정하는 원칙이 런타임 응답까지 관통한다는 증거다
- 하트비트와 진단이 스레드를 공유해 연결이 반복 종료되던 버그를 로그 실측으로 잡았고, 인증은 정적 토큰 대신 OAuth 2.1 브라우저 로그인으로 대체했다
- 반대 방향 조작도 이모지다. 알림에 음소거 이모지를 달면 그 인스턴스 알림이 1시간 중지된다(웹훅 메시지에는 버튼이 붙지 않는 Discord 제약을 이모지로 대응, 만료 시 자동 재개)

![알림 embed에 돋보기 반응을 달면 봇이 진단을 시작한다](/uploads/project/dbtower/alert-embed-reaction.png)

![봇의 진단 답글 — 근거 다섯 개와 정직한 한계 고지까지 카드 한 장에](/uploads/project/dbtower/bot-diagnosis-reply.png)

### 6. 사람 손이 선형으로 붙던 다섯 지점을 기능으로 끊었다 ([9편](/blog/project/dbtower/dbtower-9-operational-bottlenecks))

**현업 DBA의 병목이 어디에 남는지를 렌즈로 다섯 지점을 골랐다. 다섯 전부 **읽고 판정·기록까지가 도구의 몫**이고, 대상 DB는 바꾸지 않는다.**

- **설정 드리프트 이력**: 파라미터 diff의 공간축("A와 B가 다른가")에 시간축("언제부터 무엇이 바뀌었나")을 붙였다. 거울 테이블+변경 로그로 무변경 주기엔 스냅샷 한 줄만 쌓이고, work_mem 실변경(4096→8192)을 감지해 카드를 쐈다. 검증 중 MongoDB `parameters()`가 `$clusterTime` 같은 응답 gossip 필드를 흘려 매번 오탐 나던 기존 버그도 잡았다
- **스키마 변경 리뷰 게이트**: 배포 전 DDL/대량 DML을 **JSqlParser 구문 트리**로 판정한다(락 위험·DEFAULT 없는 NOT NULL·DROP·WHERE 없는 대량 변경). 정규식 대신 파서를 쓰니 ADD/DROP 컬럼을 추출해 실제 스키마와 대조하고, 실제 행수(8,118행)로 락 위험을 확정한 뒤 AI 1차 소견을 붙여 ADMIN 승인·자동 감사까지 간다. **실행은 하지 않고** gh-ost 경로만 안내한다. 판정·기록까지가 도구의 선이다
- **인덱스 사용 통계 주기 영속**: "이 인덱스 지워도 되나"는 재시작 누적 카운터의 순간값으론 못 답한다. 5기종 스캔 통계를 주기 영속하고(Oracle은 미지원 정직 표기), 분기 창 장기 판정은 lakehouse 마트가 맡는다
- **인시던트 리포트**: 장애 구간을 주면 시점 비교·설정 변경·플랜 플립·대기·가용성을 한 장으로 재구성하고, AI가 **재료 안의 사실만으로** 요약한다
- **월간 점검 리포트**: 헬스·백업·Advisor·용량·낭비·설정 변경을 매월 자동 발행한다

**대상 DB를 실제로 바꾸는 경로는 딱 하나. 그리고 가장 좁게 가뒀다.** 리뷰 게이트가 가리키는 gh-ost 온라인 스키마 변경(`onlineddl` 모듈)이 그 유일한 실행구다. MySQL 전용이라 이기종 정체성과 어긋나는 걸 알기에 헤드라인이 아닌 예외로 두고, 네 겹으로 봉인했다.

- ADMIN 전용(`POST /online-ddl`)
- 기본 dry-run이라 `execute=true`를 명시해야 실제로 적용
- 비밀번호는 argv 대신 소유자 전용 임시 conf로 넘기고 실행 직후 삭제
- **AI/MCP 도구로는 아예 노출하지 않는다**(kill·backup과 함께 화이트리스트에서 제외)

감시·판정은 다섯 갈래로 넓게 열되, 실행은 사람(ADMIN)과 검증된 도구(gh-ost) 뒤에 둔다는 경계다. 관제탑이 대상에 임의 DDL을 실행하는 순간 소유자와 판단이 갈리는 사고가 나기 때문이다.

![변경 리뷰 게이트 실물 — 락 위험·NOT NULL·실제 행수 지적에 AI가 배포 순서·롤백 소견, ADMIN 승인/반려](/uploads/project/dbtower/review-gate.png)

![설정 변경 이력 실물 — work_mem이 언제 바뀌었는지 시간순으로, "누가"는 대상 DB 감사 로그의 몫이라 미표기](/uploads/project/dbtower/config-drift.png)

![인시던트 리포트 실물 — 구간 성능 비교·설정 변경·대기·가용성에 AI 요약을 얹은 한 장](/uploads/project/dbtower/incident-report.png)

### 7. 여럿이 쓰는 관제탑에 팀 경계와 호스트 차원을 넣었다 ([7편](/blog/project/dbtower/dbtower-7-multi-tenancy))

- **팀 경계는 한 곳에서 강제**: 팀 사용자는 자기 팀 인스턴스와 전역만 본다. 남의 팀 인스턴스는 id로 직접 찔러도 **403이 아니라 404**(존재 자체를 숨김). 강제 지점은 RegistryService 단 한 곳이다. 모든 모듈이 registry를 경유하니 컨트롤러마다 뿌리지 않는다
- **잠금 카운터도 메타 DB**: 노드 A에서 두 번, B에서 한 번 틀리자 네 번째가 잠기는 것을 실측했다. 인메모리였다면 LB 뒤에서 임계가 노드 수만큼 벌어졌을 구멍이다
- **디스크 포화 예측은 잔량이 아니라 속도**: 여유가 76.8%나 남았는데 치명 경보가 뜨는 화면을 실쓰기 부하로 직접 만들었다. 초당 17MB씩 줄면 20시간 뒤 장애라서 이 경보가 맞다. node-exporter가 rootfs 마운트 없이 컨테이너 자신만 보던 함정도 이때 잡았다
- **서버 공유 인지**: 등록 단위는 DB인데 물리 단위는 서버다. 같은 서버의 DB 둘이면 세션·복제·데드락 경보를 그룹당 1회로 줄이되 "누구에게 해당하는지"를 명시하고, 위험 귀속(헬스 스코어)은 일부러 dedup하지 않았다

![팀 스코프 실물 — VIEWER(team-a)에게 team-b 인스턴스는 존재하지 않는 것처럼 보인다](/uploads/project/dbtower/lbac-viewer-scope.png)

![디스크 포화 예측 실물 — 여유 76.8%인데 "약 0.7일 내 포화" 치명 경보(속도 기반)](/uploads/project/dbtower/disk-forecast-critical.png)

### 8. 장기 분석 창고와 손잡아 오탐을 지우고, AI에게 마트를 열었다 ([8편](/blog/project/dbtower/dbtower-8-talking-and-lakehouse))

- **받는 쪽**: 별도 프로젝트인 lakehouse(장기 분석계)가 수개월 이력으로 계산한 요일×시간대 베이스라인을 전용 테이블로 받아, 14일 단기 창에 **평균·분산만 받아 원시 관측을 통계적으로 복원(충분통계량)**해 가중 병합한다. 원시 관측을 더한 것과 수학적으로 동일한 병합이다
- **판정이 뒤집히는 실측**: 같은 스파이크(psql 3,000회)의 판정이 장기 테이블 내용에 따라 뒤집혔다. 장기가 "평소 0.2qps"라 하면 통계적으로 명백한 이상(z=7.42)으로 발화하고 관측 수 101(장기 100+단기 1)이 찍힌다. 반대로 평소가 높음을 알면 월요일 피크 오탐이 사라진다. 주간 계절성 오탐을 억제하려는 것이다
- **주는 쪽**: 대기 이벤트(5분마다)·오브젝트 크기(6시간마다)를 꾸준히 쌓아 창고의 원료를 만들고, 실행계획 이력 보존에 최소 48시간 하한을 병행해 "어제 하루창" 추출 전 유실을 막았다
- **AI 에이전트 서빙**: 창고 마트를 MCP 도구 2종으로 에이전트에 연다. `lakehouse_query`(읽기 가드·행 상한 SELECT)와 `lakehouse_card_create`(Metabase 카드 생성, "DBTower AI" 전용 컬렉션 격리). DELETE는 400으로 거부되고, 에이전트가 만든 카드 76이 bar 차트로 **143ms에 렌더**되는 것까지 실측했다

### 미지원은 UNSUPPORTED로 표기하고, 진단 부하는 상한으로 막는다

- **정직한 라벨**: 백업 복원 검증은 VERIFIED/FAILED/**UNSUPPORTED** 3값, p95는 실측·추정·미지원 소스 라벨을 섞지 않는다. 관제 도구의 출력은 운영 결정의 입력이기 때문이다
- **보호장치**: 진단이 부하가 되지 않게 쿼리 타임아웃 15s·지수 백오프·인스턴스당 풀 max 2. MongoDB는 정석인 드라이버 전역 타임아웃(CSOT)이 심층 진단의 명령별 시간 상한(maxTimeMS)을 덮어쓰는 간섭이라 일부러 배제하고, 이유를 코드 주석으로 남겼다

![정직한 라벨 실물 — 같은 p95인데 소스 라벨(실측·직접계산·추정·미지원)이 다른 레이턴시 백분위](/uploads/project/dbtower/latency.png)

### 대표 수치 (성능 항목은 전부 전후 비교 실측, 재현 기록 VERIFICATION.md 117개 절)

| 항목 | 수치 |
|---|---|
| 새 기종 추가 비용 | Operator 구현체 추가만으로 핵심 파이프라인(수집·비교·감지·콘솔·MCP) **0줄 수정** |
| 시점 비교·회귀 감지 | 호출량 **+461%** · 읽은 행수 **+852%** · 신규 쿼리 검출, 같은 비교를 폴러가 자동 실행 |
| 플랜 플립 감지 | 인덱스 드랍을 다음 폴링 주기(60초)에 감지, 동반 레이턴시 회귀 **+23,249%**(PG e2e, 계획 shape 획득은 5기종) |
| 심층 진단 | 추정 300행 vs 실제 1행 괴리 → 형변환 지목 → 원클릭 재진단 before/after |
| 성능 개선 | HikariCP **4.0배**(47.1→11.8ms) · JDBC batch **13.8배**(행당 1.51→0.11ms) · 자기 진단 **343배**(21.269→0.062ms) |
| 배포 전 부하 검증 | k6 10 VU 30s에서 **2,832 req/s, P95 5.86ms, 실패 0** |
| 품질 | 테스트 **515건** CI 게이트 · VERIFICATION **117절** · 자체 감사 결함 20+건 FIX/SKIP |
| 백업·복구 | 5기종 로그 백업 + 병행 정책(FULL 앵커+LOG 체인) · PITR **실제 복원 2기종**(STOPAT·recovery_target_time) · oplog 증분 **28분의 1** · AES-256-GCM 암호화 |
| 알림→진단 루프 | 이모지 반응 → AI 진단 embed 답글(특권 인텐트 0, 매핑 메타 DB 영속·재시작 생존 e2e) |
| 운영 병목 자동화 | 설정 드리프트 카드 실발사(work_mem 4096→8192 감지) · 리뷰 게이트 JSqlParser 판정+실제 행수(8,118) 락 확정+AI 소견+ADMIN 승인 e2e · 인시던트/월간 리포트 자동 발행 |
| 장기 분석 루프 | lakehouse 베이스라인 가중 병합으로 판정 반전 실측(z=7.42·관측 101) · 대기 이벤트·오브젝트 크기 주기 영속 공급 · MCP 마트 서빙(에이전트 생성 카드 **143ms** 렌더) |
| 배포 | GHCR **멀티아치(amd64+arm64) v1.2.0** 공개, 원커맨드 셀프호스트 |

### 배운 것

- **추상화 경계는 기술(SQL)이 아니라 하는 일(운영 행위)에 그어야 이기종이 들어온다.** 경계가 맞는지는 문서로는 알 수 없고, 정반대 성격의 구현체를 실제로 추가해 봐야 증명된다.
- 관제 도구의 출력은 누군가의 운영 결정의 입력이 된다. 못 하는 것을 UNSUPPORTED로 정직하게 표기하는 쪽이 과장된 능력 표기보다 도구의 신뢰를 만든다.
- 진단 기능은 그 자체가 대상에 주는 부하까지 설계 범위다. "측정이 대상을 바꾸면 안 된다"는 감각을 타임아웃·백오프·풀 상한으로 코드에 새겼다.
- 이번엔 성능을 위한 병렬화가 풀 경합을 되살렸다. 고친 자리뿐 아니라 그 옆까지 다시 봐야 했다.
- 사람 손이 선형으로 붙는 지점은 기능으로 끊되, 도구의 선은 판정·기록까지다. 리뷰 게이트가 실행을 안 하고, 인덱스 판정이 삭제 지시가 아니라 후보까지만 내는 이유다. 마지막 판단은 사람에게 남긴다.

<div class="lc-sub">github.com/dj258255/dbtower<br>재현 기록 docs/VERIFICATION.md 117개 절</div>
</a>
<a class="linkcard" href="https://dj258255.github.io/IT-Oasis/blog/project/dbtower/dbtower-0-overview/">
<div class="lc-title">블로그 총정리 (0편)</div>
<div class="lc-sub">설계 판단과 실측 과정 전체<br>시리즈 0~9편</div>
</a>
<a class="linkcard" href="https://github.com/dj258255/dbtower/pkgs/container/dbtower">
<div class="lc-title">직접 실행 (GHCR)</div>
<div class="lc-sub"><code>docker pull ghcr.io/dj258255/dbtower</code><br>원커맨드 compose · 포트 8080</div>
</a>
</div>

## DBTower-lakehouse — 버려지는 관측 데이터의 장기 분석·판정 파이프라인

**DBTower가 **7일 뒤 삭제하는 관측 데이터**를 만료 전에 내려(ELT) 장기 질문에 답한다. 운영계와 분석계를 분리하고, **조용히 틀린 데이터는 fail-closed(이상하면 통과 대신 정지)로 차단**하며, 그 위에서 **DBA가 손으로 하던 판정 여섯을 컬럼으로 자동화**한다.**

- 기간: 2026.04 ~ 진행 중 · 개인(100%) · [GitHub](https://github.com/dj258255/dbtower-lakehouse) · [블로그 시리즈 0~5편](/blog/project/lakehouse/lakehouse-0-why)
- 스택: Airflow · dbt · DuckDB/DuckLake · MinIO(S3) · PostgreSQL · Metabase · pytest · GitHub Actions
- 역할 전부: 멱등 추출(EL) / dbt 변환 / 품질 게이트 / DuckLake 테이블 포맷 / 운영(알림·deadman·CI) / 대시보드 / 규모 검증(2축·합성) / 판정층 6종 / 셀프호스트 어플라이언스 / 원천 되쓰기
- 규모 가정과 측정 환경: 관제 대상은 5기종(MySQL·PostgreSQL·Oracle·MSSQL·MongoDB) 인스턴스이고, 설계 목표는 수백 대·수년치(low-TB) 이력을 일 단위 SLA의 배치로 단일 노드 DuckDB가 감당하는 것. 시간축 1년치 **54.5M행**과 인스턴스축 **300대 52.2M행** 두 축으로 합성 검증했다. 측정은 로컬 Docker(Airflow·MinIO·PostgreSQL·Metabase) 위 전/후 실측, 재현 기록은 VERIFICATION.md에 보존

### 왜 만들었는가

**관제의 시야가 "지금부터 최근 7일"인 것은 관제 도구로서 올바른 설계다. 하지만 그 설계는 **장기 질문에 구조적으로 답할 수 없다**.**

- 7일 삭제는 의도된 설계다. 관측 데이터를 무한히 쌓으면 메타 DB가 관리 대상보다 먼저 포화된다. AWS RDS Performance Insights 무료 티어의 보존 기간이 정확히 7일인 것과 같은 선례다
- DBTower를 만들면서 답할 수 없는 질문이 쌓였다. "지난 분기 대비 가장 악화된 쿼리 TOP 10은?" "이 인스턴스의 3개월 성장 추세로 볼 때 용량 증설 시점은?" "기종별 장기 레이턴시 분포는?"
- 해법은 실무에서 프로덕션 DB(OLTP)와 데이터 웨어하우스(분석)를 분리하는 원칙 그대로다. 관제는 지금에 최적화된 채로 두고, **버려지기 직전의 스냅샷을 컬럼형 저장소로 내리는 별도 분석 계층**을 만들었다
- **Kafka를 쓰지 않은 이유(비용 판단)**: 스냅샷 원천이라 붙일 이벤트 스트림 자체가 없고, SLA는 일 단위, 소비자는 하나다. 스트리밍 채택 3조건(초~분 신선도가 가치 · 다중 소비자 · 분산시스템 운영 여력)에 전부 미해당이라 배치를 판정으로 선택했다. 준실시간이 필요해져도 풀 Kafka가 아니라 경량 CDC + 별도 수집 계층이 맞다고 근거까지 문서화했다

### 누구에게 도움이 되는가

- **SQL 없이 대시보드로 답을 얻는 DB 운영·성능 담당자**: "지난 구간보다 느려진 쿼리 있어?"에 "instance 8의 Oracle 쿼리가 이틀 새 평균 25.9ms에서 64.5ms로 149% 느려졌다"로 답한다. raw 스냅샷만으로는 낼 수 없던 답이다
- **DBA의 반복 판정 자동화**: 용량 증설 시점, 플랜 뒤집힘, 백업 공백, 인덱스 정리 후보, 설정 변경의 성능 영향, 가용성 목표 달성 여부. 사람이 매번 뒤지던 여섯 판정을 매일 자동으로 계산해 둔다
- **대시보드 이원화**: 분석 대시보드(데이터를 신뢰한 뒤의 질문)와 운영 대시보드(파이프라인 자체가 건강한가: 마지막 성공 날짜, 게이트 축별 상태)를 분리했다. 실제 수집 정지일이 completeness·freshness FAIL로 표시되는 것까지 확인했다
- **자기 부하 발견**: 악화 랭킹에 오른 인스턴스 하나는 DBTower가 자기 메타 PG에 던지는 스냅샷 적재·조회 쿼리였다. 파이프라인이 준 부하를 파이프라인이 관측한다

![Metabase 분석 대시보드 실물 — 인스턴스별 악화 랭킹과 장기 추이](/uploads/project/lakehouse/metabase-dashboard.png)

### 아키텍처

![파이프라인 아키텍처](/uploads/project/lakehouse/architecture.svg)

### 추출에서 감시까지 이어지는 파이프라인 흐름

![파이프라인 흐름: 추출·적재 → 검증·변환 → 발행·서빙·감시](/uploads/project/lakehouse/pipeline-flow.svg)

Airflow DAG 한 줄이 이 셋을 순서대로 지난다: offload → quality_gate → transform → publish → heartbeat. 게이트가 FAIL이면 뒤 단계가 전부 멈춘다(fail-closed). 실패는 webhook 경보로 알리고, "성공의 부재"는 deadman이 역방향으로 잡는다.

### 기능 지도

| 영역 | 기능 |
|---|---|
| 파이프라인 | Airflow DAG(offload → gate → transform → publish → heartbeat) · 멱등 추출 · 테이블 스펙 레지스트리(백업·플랜·대기·설정·핑 편입) · 아카이브 자기파괴 가드 |
| 품질 | 4축 fail-closed 게이트(스펙별 프로필) · dbt test/unit test · contracts 타입 강제 · CI 3관문(ruff·pytest·dbt 픽스처 e2e) |
| 변환 | staging → fct(증분 delete+insert) → mart · 롤링 윈도우 악화 랭킹(최근 7일 vs 직전 30일) |
| 판정층 | 용량 D-day · 플랜 회귀 · 백업 RPO · 미사용 인덱스(90일 창) · 설정 변경 상관 · 가용성 SLO(에러버짓) · 기종 축(dim_instance) · 주간 운영 보고, 발행 **21테이블** |
| 서빙 | DuckLake(단일 트랜잭션 발행·타임트래블·CHECKPOINT 컴팩션) · Metabase 대시보드 이원화(분석·운영·판정) |
| 감시·연계 | webhook 실패 경보 · deadman(성공의 부재) · 원천 되쓰기(dow×hour 베이스라인) · AI 에이전트 서빙(DBTower MCP lakehouse_query·card_create) · 셀프호스트 어플라이언스(`--profile demo`) · RUNBOOK·VERIFICATION 문서 |

### 데이터 모델

![데이터 모델 — 원천 2테이블에서 raw parquet, staging, marts(contract 강제)와 운영 테이블까지의 컬럼 계보. 누적 카운터가 일간 델타로 접히는 변환 지점 표기](/uploads/project/lakehouse/erd.svg)

### 1. 원천에 부하를 주지 않는 멱등 EL, 그리고 누적을 일간 델타로 접는 변환 ([1편](/blog/project/lakehouse/lakehouse-1-build))

**추출이 관제 DB를 느리게 하면 관제를 관제하다 관제를 망가뜨리는 자기모순이다. 기본기부터 원리로 눌렀다.**

- **인덱스 선두를 타는 추출**: 원천 인덱스는 복합 `(instance_id, captured_at)`이고, 복합 B-Tree는 선두 컬럼부터 정렬되므로 `captured_at` 단독 범위 조건은 선두를 건너뛰어 Seq Scan에 가까워진다. 원천 인덱스를 바꾸는 대신(관제탑은 최후까지 안 건드린다) **인스턴스별 등치 루프**로 매 쿼리가 선두를 타게 했다. 세션은 `readonly=True`로 열어 쓰기를 트랜잭션 레벨에서 차단하고, 서버사이드 커서(itersize 50,000)로 결과 전체를 메모리에 올리지 않는다
- **계약 먼저**: DAG보다 계약(CONTRACT.md)을 먼저 굳혔다. dt는 UTC 자정 경계의 반열림 구간(`>= dt AND < dt+1`, 겹침·누락 0), parquet는 스키마 명시 선언(타입 추론이 int64를 double로 조용히 바꾸는 사고 차단), 파티션은 `dt=.../instance_id=.../` hive 규약
- **멱등 덮어쓰기**: 파티션 프리픽스를 통째로 지우고 다시 쓴다. 닫힌 dt를 2회 실행해도 79,894행·오브젝트 6개 불변을 실측했고, backfill 날짜 산수(`-s D+1 -e D+1`이 dt=D 처리)까지 실측으로 확정해 RUNBOOK에 적었다
- **3자 일치**: 원천 PG count = parquet 행수 = DuckDB 조회를 dt별로 대조하는 verify를 상시 장치로 뒀다(149,259 / 79,894 ALL MATCH). "유실도 중복도 없다"의 정의를 검증 가능한 형태로 박은 것이다
- **누적→델타 변환(심장)**: raw의 calls는 서버 기동 이후 누적 카운터라 SUM하면 무의미하다. 시간순 정렬에서 302→55→302로 지그재그하는 가짜 리셋의 원인을 파니 **같은 쿼리 지문 아래 두 누적 계열이 얽힌 지문 충돌 12,743키**였다(id는 스냅샷마다 재발번이라 계열 식별자가 못 됨). staging에서 시점별 SUM으로 단조성을 복원("단조 계열의 합도 단조")하고, 하루 양 끝 차분(first-vs-last) + `GREATEST(0,…)` 리셋 클램프로 일간 델타를 냈다. 순리셋 219그레인이 0으로 눌리고 음수 델타 0건
- **대안을 실측으로 기각**: Prometheus rate 방식(인접 양의 델타 합산)도 후보였지만, 쿼리가 사라졌다 재등장하는 유령 증가분을 과대계상해 총합 22,264,704 vs 3,126,579로 **7배 부풀림**을 실측하고 기각했다. first-vs-last는 DBTower 정식 비교 로직(`Math.max(0, end-start)`)과 같은 원리라 교차검증까지 된다

### 2. 두 축으로 재보고 수치가 요구한 곳만 최적화했다 ([3편](/blog/project/lakehouse/lakehouse-3-scale))

- **규모 증명 문제**: 실측이 전부 닫힌 날짜 3개 치(수십만 행)에서 초 단위로 끝났다. "규모에서도 버틴다"고 말하고 싶어지지만 그건 아직 증명이 아니다. 증분부터 도입하는 감 최적화를 거부하고 "먼저 재보고, 수치가 요구할 때만" 순서를 택했다
- **시간축 합성 실측**: 닫힌 파티션을 날짜 시프트 복제해 **365일 × 6인스턴스 = 2,190파일(54,479,535행, 396.6MB)**을 실데이터와 격리한 별도 경로에 합성했다. 종료 후 합성 파일은 전부 정리
- **병목 지목**: 단계별로 재보니 병목은 핵심 집계 테이블 전체 재빌드 **407.62s** 하나였다. 상위 마트는 0.31s, 게이트·검증은 파티션 단위 조회라 이력 크기와 무관(8~22ms). 반대로 0.31s인 마트는 증분화하지 않았다. 초 단위인 곳을 최적화하면 복잡도만 는다
- **파티션 프루닝 함정**: 증분 전환 후에도 2분+ 타임아웃이 났다. 기준 시점(워터마크)을 서브쿼리로 주면 실행 시점에야 값이 정해져 파티션 건너뛰기가 안 걸리고 2,190파일을 전부 읽는다. 값을 컴파일 시점 상수로 구워 넣어 해결했다
- **결과**: 하루치만 다시 계산해도 결과가 같다(집계 단위의 날짜 독립성)는 것을 확인한 뒤에야 증분(delete+insert)으로 전환, **407.62s → 4s(약 100배)**. 읽는 파일 2,190개 → 6~12개, 같은 날짜 재실행 멱등(행수 불변)
- **축을 돌린 두 번째 실측**: 몇백 대를 관제하는 쪽에서 늘어나는 축은 날짜가 아니라 인스턴스 수다. 총량을 고정하고 축만 돌려 **N=300(2,100파일·52.2M행)**을 다시 쟀다. 증분 fct는 **8.03s**로 건재했고, 급소는 로드맵에 외삽해 뒀던 소파일이 아니라 **full-refresh(769s)**로 드러났다. 재보지 않고 외삽했던 예측 두 개가 실측에서 뒤집혔고, 운영 가이드 1순위가 "full-refresh는 dt 청크로 쪼개라"로 바뀌었다
- **원인은 가설로 남김**: 같은 총량에서 769s가 407s의 1.9배인 이유는 "dt당 행수가 50배 집중돼 창 집계의 정렬·해시 압력이 커진다"는 가설까지만 세웠다. EXPLAIN 프로파일링으로 확정하지 않았으므로 단정하지 않고 가설로 표기했다
- **소파일 문제**: 파일 평균 177KB는 실무 타깃 128MB의 **1/741**로, 실무 1순위 고통을 그대로 재현했다. 커밋 누적 소파일은 주간 CHECKPOINT 컴팩션이 값싸게 흡수한다(366파일 → 1파일, 0.47s)

![두 축 규모 실측 — 총량을 고정하고 시간축(dt)에서 인스턴스축(N)으로 축만 돌린 설계](/uploads/project/lakehouse/lh12_axis_rotation.svg)

### 3. 아카이브가 자신을 지우는 경로를 재현하고 차단했다 ([2편](/blog/project/lakehouse/lakehouse-2-trust))

- **발견**: 원천은 7일 보존이라, 그보다 지난 날짜를 다시 적재(backfill)하면 MinIO의 parquet가 세상에 남은 유일본이 된다. 그런데 멱등 재적재가 "파티션 통째 삭제 후 재작성(delete-first)"이라, 원천 0행이면 유일본을 지우고 아무것도 안 쓴 채 **exit 0 "성공"**으로 끝난다. fail-closed를 읽기 경로(게이트)에는 적용했으면서 쓰기 경로에는 적용하지 않았던 뒷면이다
- **재현**: 실데이터와 무관한 날짜에 가짜 파티션(3행)을 심고 재실행했다. 로그는 "기존 파티션 삭제" → "데이터 없음, 스킵" → "적재 완료 총 0행". 파티션 소멸, 복구 불가를 직접 확인했다
- **가드 설계**: 원칙은 "지울 자격은 다시 쓸 수 있는 자에게만". 원천 0행 + 파티션 존재면 보존 창 밖 재적재로 판정해 삭제를 거부하고 시끄럽게 실패한다(exit 1, webhook 경보 탑승). 자동 우회 플래그는 일부러 만들지 않았다. 데이터를 지우는 일만큼은 사람이 직접 확인하고 지우게 하고 싶었다
- **전/후 실측**: 같은 입력에서 유일본 보존을 확인했고, 정상 경로는 멱등 그대로다(verify ALL MATCH, 149,259 / 79,894행 불변). 유일본을 지운 뒤에 오는 알림은 사후 통보일 뿐이고, 지우기 전에 실패시키는 쪽이 방어다

### 4. 조용한 오답을 막는 신뢰 계층 ([1편](/blog/project/lakehouse/lakehouse-1-build) · [2편](/blog/project/lakehouse/lakehouse-2-trust))

**신뢰는 하나의 기능으로 서지 않는다. 네 장치가 각자 다른 실패 모드를 막아 층으로 쌓이고, 전부 장애 주입으로 실증했다.**

| 장치 | 막는 실패 모드 | 실증 |
|---|---|---|
| 4축 fail-closed 게이트 | 반쪽 파티션 위의 "조용히 틀린 랭킹". dbt test는 이미 로드된 데이터만 봐서 못 잡는다(없는 행은 not_null을 위반하지 않는다) | 파티션 20,158행 삭제 주입 → 정합·완결성 동시 FAIL, **dbt 미실행 exit 2**, 문제 날짜만 차단 |
| CI 3관문 | 테스트가 "로컬 자산"이 되는 회귀 | 커밋마다 픽스처만으로 dbt build를 e2e 실행(unit test·contracts 포함) |
| dbt contracts | 마트 컬럼 타입이 조용히 바뀌어 대시보드가 런타임에 깨지는 것 | VARCHAR 타입 주입 → **CREATE TABLE 시점에 빌드 차단** |
| deadman heartbeat | "성공의 부재". 실제로 수집기가 21시간 조용히 정지했는데 알림이 0통이었다 | **30h 침묵(기한 26h) → 경보 실수신**, 미실행·pause DAG도 검출 |

- **게이트 자신도 검문했다**: 게이트가 원천 전체를 훑고 있었다(Seq Scan, EXPLAIN 실측 332ms로 65만 행 중 51만 폐기). 인스턴스별 인덱스 등치 루프로 교체해 **332ms → 20ms**(Index Only Scan, Heap Fetches 0). "관제가 부하가 되면 안 된다"는 원칙을 게이트 자신에게도 적용한 것이다
- **스펙별 게이트 프로필**: 원천을 5종(백업·플랜·대기·설정·핑)으로 일반화하며 게이트를 그대로 재면 정상이 오탐이 된다는 것을 확인했다(백업 안 도는 인스턴스가 completeness FAIL). 검문 축을 테이블 스펙의 일부로 선언하고, 끈 축은 숨기지 않고 **SKIP으로 보고서에 남긴다.** 안 잰 것을 잰 척하지 않는다
- **몸으로 배운 방어**: 원천 스택이 통째로 내려간 날, psycopg2 기본값엔 접속 타임아웃이 없어 연결 시도가 **무한 대기**로 멈췄다. 걸려 멈춘 태스크는 실패도 아니라 재시도도 알림도 못 탄다. 모든 PG DSN에 `connect_timeout=5`를 박았다. 빨리 죽어야 재시도가 산다
- **재시도 정책 분리**: 일시 장애(추출·변환)는 지수 백오프 retries=3, 품질 FAIL은 결정적이라 **게이트만 retries=0**으로 즉시 죽고 즉시 알린다. dbt는 Airflow와 의존성이 충돌하는 조합이라 컨테이너 안 **분리 venv**에 격리하고 subprocess로 부른다

![품질 게이트 실측 — 정상 통과와 장애 주입 시 FAIL로 다운스트림 차단](/uploads/project/lakehouse/quality-gate.png)

### 5. 파일 직결을 실측으로 실격 판정하고 DuckLake로 서빙한다 ([1편](/blog/project/lakehouse/lakehouse-1-build))

- **서빙 도구 선택**: 정적 리포트 계열(빌드 타임에 굽는 방식)은 "인스턴스 8만 보여줘" 같은 탐색형 질문마다 재빌드가 필요해 기각했다. BI 서버 중 Metabase를 고른 근거는 DuckDB 커넥터 존재, 초기 설정부터 대시보드·필터 배선까지 전부 REST API로 재현 가능(브라우저 산출물이 아니라 스크립트 산출물), 컨테이너 하나의 운영 부담 셋이다
- **실격 사유 실측 2건**: dbt의 DuckDB 파일을 Metabase가 직결로 읽는 가장 쉬운 길은, 같은 호스트에서는 읽기 커넥션의 잠금에 dbt 쓰기가 죽고(Conflicting lock), 컨테이너 경계에서는 잠금이 전파되지 않아 열린 리더 밑에서 파일이 소리 없이 재작성된다. 시끄럽게 죽는 쪽보다 나쁜 실패다
- **DuckLake 재설계**: 마트를 DuckLake로 발행하고 Metabase는 read-only로 DuckLake만 읽는다. 동시성은 파일 잠금 대신 PG 트랜잭션(스냅샷 격리)이 중재한다. 카탈로그는 이미 있는 PostgreSQL을 써서 서비스 추가 0
- **무중단 검증**: 발행(쓰기) 도중 0.3초 간격 연속 질의 **41회 전부 온전**. 수치는 3경로(파일 직독·Metabase API·대시보드 화면) 대조로 전부 일치(+149.1% 동일)
- **화면이 깨운 동시성 버그**: 카드를 한 장씩 돌리면 전부 통과하는데, 대시보드가 카드 3장을 동시에 쏘자 2장이 500으로 터졌다. 커넥션 풀마다 실행되는 CREATE OR REPLACE SECRET이 공유 카탈로그에서 경합한 것으로, 세션 로컬 SET 설정으로 공유 상태 자체를 없애 해소했다
- **발행 원자성**: 두 테이블 발행 사이에 장애를 주입해 "새 fct + 이전 mart"라는 존재한 적 없는 혼합 버전을 대시보드가 보는 결함을 재현했다. 발행을 BEGIN...COMMIT 단일 트랜잭션으로 묶고 재주입해 새 스냅샷 0개, 원자성을 증명했다
- **Iceberg 대비 정직한 표기**: DuckDB에서 Iceberg 쓰기는 REST 카탈로그 서버가 추가로 필요하다. "미지원"이 아니라 이 규모에 부적합으로 판정하고, 멀티엔진 시점의 전환 경로를 문서로 남겼다

### 6. 창고만 할 수 있는 여섯 가지 판정 — DBA의 반복 판정을 컬럼으로 ([5편](/blog/project/lakehouse/lakehouse-5-verdicts))

**데이터를 내리기만 하던 창고가 **판정을 내리기 시작했다**. 전부 DBA·DBRE가 손으로 하던 일이고, 라이브 7일 창으로는 구조적으로 불가능하며, 장기 창고라야 컬럼으로 자동화된다.**

| 판정 | 답하는 질문 | 설계 핵심 |
|---|---|---|
| 용량 D-day | 언제 증설해야 하나 | 크기 시계열 선형 추세로 임계까지 잔여일. 7일로는 추세선 표본 자체가 없다 |
| 플랜 회귀 | 언제 플랜이 뒤집혀 느려졌나 | 하루 대표 플랜(그날 마지막 관측)의 뒤집힘을 전후 N일 지연과 겹침. 뒤집힘 당일은 전후가 섞여 양쪽 창에서 제외, 호출 0인 날의 NULL 지연을 0으로 접으면 회귀가 개선으로 둔갑하므로 자연 제외. 관측 부족은 **PENDING**, 창 오염은 **AMBIGUOUS**로 지어내지 않음 |
| 백업 RPO | 백업이 며칠째 없나 | 유니버스를 query 팩트에서 잡아 **기록 없는 인스턴스도 행으로** 드러냄. 기준일은 벽시계가 아닌 창고 최신 날짜(파이프라인 중단과 백업 중단을 섞지 않음) |
| 미사용 인덱스 | 지워도 되나 | 90일 창 실사용 판정. 라이브 즉답은 DBTower(재기동 직후 0회 노이즈에 약함), 확정은 장기 마트로 분업을 문서에 못박음. **후보까지만 내고 삭제는 지시하지 않음**(최종 판단은 사람) |
| 설정 변경 상관 | 어떤 변경 뒤 나빠졌나 | 파라미터 변경 시점과 성능 회귀를 플랜·지연·볼륨 축 우선순위 사다리로 겹침. 변경 소스는 통합 스트림으로 일반화(스키마 변경 자리 예약). **상관이지 인과가 아니라 조언 어휘로만** |
| 가용성 SLO | 목표만큼 떠 있었나 | 1분 핑을 하루로 접어 최근 30일 uptime을 목표와 견주고 SRE 에러버짓 산출(breach / at_risk / meets) |

- **원칙: 판정 컬럼까지만, 발화는 안 한다**. 알림은 Metabase·DBTower의 몫으로 두어 두 번째 알림 시스템을 만들지 않았다
- **라이브 실측(가용성)**: MSSQL 2대가 최근 창 **63.45%·64.28%**(평균 ping 2,132ms·6,897ms)로 breach, MySQL은 **98.86%**로 목표 99.5를 근소 미달(worst 96.83%), PostgreSQL·Mongo·Oracle은 **99.9% meets**, DBTower 자신은 100%. down 샘플의 ping은 타임아웃 값이라 up 샘플로만 평균해 지연 통계 오염을 막았다
- **라이브 실측(설정 상관)**: 인스턴스 2·4의 work_mem 변경 2건이 타임라인에 잡혔고, 나머지 다섯은 변경 0인데 수집은 정상(23사이클)이라 "무변경"과 "미수집"이 한 표에서 갈린다
- **기종 축 회수**: 인스턴스 차원(dim_instance)을 붙여 여러 마트가 달던 "기종은 저쪽에서 보세요" 각주를 회수했다. instance_id 1이 local-mysql(MYSQL)로 읽히고, top 대기 이벤트가 기종과 나란히 선다. MySQL은 `binlog` I/O, PostgreSQL은 `WalSenderMain`(복제), MSSQL은 `RESOURCE_SEMAPHORE_QUERY_COMPILE`, Oracle은 `resmgr:cpu quantum`. 판정들은 주간 운영 보고 한 장으로도 접힌다
- **안 내린 판정**: 저빈도 감사 데이터 기반 change_review는 자리만 열어 뒀다. 관측이 드물어 세우면 대부분 PENDING만 나온다. 안 내리는 것도 판정이다. 가용성을 가져오기 전에 원천 테이블 29개를 전부 대조해 창고의 몫과 관제·인프라(Prometheus)의 몫을 갈랐다. 가용성 샘플은 Prometheus 게이지로도 노출되지 않는 유일한 빈 자리였다

![가용성 SLO 대시보드 실화면 — 기종별 uptime과 에러버짓, MSSQL 2대 breach 검출](/uploads/project/lakehouse/lh21_slo_dashboard.png)

### 7. 남이 그대로 띄우는 어플라이언스, 그리고 원천으로의 되쓰기 ([4편](/blog/project/lakehouse/lakehouse-4-appliance))

- **재현 가능성의 숨은 전제**: "전부 로컬에서 e2e 재현 가능"이라고 여러 번 썼는데, 남이 clone하면 원천이 없어 인스턴스 0개로 조용히 빈 결과가 났다. 결합의 급소는 config 한 줄(카탈로그가 원천 PG를 재사용)이었고, 폴백 하나로 기존 경로를 안 깨고 분리했다. `docker-compose.standalone.yml` + `--profile demo`로 DBTower 없이 offload→게이트→dbt→발행 e2e가 도는 셀프호스트 어플라이언스로 만들었다(격리 실측 외부 의존 0, 시크릿은 `${VAR:?}` 강제로 기본값 없이는 기동 거부)
- **범용화 거부**: 범용 쿼리 분석 도구는 PMM·pgwatch·OpenObserve의 레드오션이고, 범용화하는 순간 원천(DBTower)까지 직접 만든 이 구조의 유일 자산이 죽는다. Prometheus와 Thanos의 관계 그대로, DBTower 셀프호스터가 자기 관제 옆에 창고를 같이 띄우는 것까지가 목표다. 초점을 좁힌 결정이었다
- **테이블 스펙 레지스트리**: 원천을 query_snapshot 하나만 내리던 걸 레지스트리로 일반화해 백업·플랜·대기·설정·핑을 편입했다. 전제가 셋 깨졌다: 대기 이벤트는 영속 테이블이 없고(available=False로 시끄럽게 거부), 플랜은 개수 기반 보존이라 날짜가 닫히기 전 지워질 수 있고(계약 문서에 명기), 백업은 검증이 나중에 UPDATE하는 사후 변이 테이블(D+1 스냅샷 계약, 불변 워터마크). 워터마크·불변성·게이트 프로필을 스펙의 일부로 선언해 해결했다
- **반대 방향의 일(되쓰기)**: DBTower 이상 감지의 7일 베이스라인은 매주 월요일 배치 피크를 오탐한다. 장기 dow×hour 베이스라인(관측 8개 미만 버킷 제외·인스턴스당 상위 500쿼리)을 계산해 원천 쪽으로 되쓴다. readonly 봉인을 깨지 않으려 **별도 역할에 해당 테이블만 권한**을 주고 단일 트랜잭션(PG MVCC라 폴러가 도중에 읽어도 이전 버전)으로 **32,498행 왕복**을 실측했다. 그 역할로 query_snapshot을 읽으면 permission denied가 난다. 봉인이 실제로 잠겨 있다는 뜻이다
- **AI 에이전트 서빙**: 창고 마트를 사람(Metabase)만이 아니라 AI에게도 연다. DBTower의 MCP 도구 2종(`lakehouse_query`는 장기 마트 SELECT에 읽기 가드·행 상한, `lakehouse_card_create`는 "DBTower AI" 전용 컬렉션에 격리된 카드 생성)으로 에이전트가 자연어 질문에서 마트 질의·차트 생성까지 간다. DELETE는 400으로 거부되고, 에이전트가 만든 카드가 실제로 bar 차트로 **143ms에 렌더**되는 것까지 실측했다. 셀프호스트에 없는 Metabot의 대체 경로다

### 판단과 트레이드오프

- **microbatch 기각**: dbt 공식 증분 전략 중 microbatch는 event_time이 필수고 unique_key 기반 파티션 교체가 안 된다. delete+insert를 선택하고 기각 사유를 문서로 남겼다
- **자체 게이트 vs elementary**: dbt 관측성 도구 elementary는 4축 게이트 + webhook과 역할이 겹쳐 도구를 늘리는 대신 게이트를 키웠다. dbt source freshness도 게이트 freshness와 중복이라, 같은 판정을 두 군데서 내려 기준이 갈라지지 않게 게이트를 단일 진실로 뒀다
- **게이트만 retries=0**: 품질 FAIL은 재시도해도 결과가 같은 결정적 실패라 재시도 대신 즉시 알림. 일시 장애용 지수 백오프 재시도(2→4→8분)와는 분리했다
- **롤링 윈도우 재설계**: 전체 이력 first-vs-last 비교는 오래된 개선을 영원히 기억한다. 최근 7일 vs 직전 30일로 재설계하고, 검증 주입 +50/+150이 경계 겹침 때문에 +47.5/+138.1로 나오는 것까지 원인 규명해 정직하게 기록했다. 실데이터 3일치에서는 이 마트를 0행으로 정직하게 비워 둔다(이력이 차면 채워진다)
- **지문 충돌 SUM은 근사**: 서로 다른 물리 쿼리를 한 지문으로 합치는 근사임을 명시했다. id로 계열을 온전히 분리하지 못하는 원천 성질이라, "지문 단위 총 활동"까지가 정직한 그레인의 상한이다
- **비용 관점**: 클라우드 관리형을 하나도 안 쓴다(카탈로그=기존 PG 재사용, 스토리지=MinIO, 엔진=임베디드 DuckDB). BigQuery류 스캔량 과금 구조였다면 fct가 매일 전체 이력(54.5M행)을 다시 읽던 설계는 이력에 비례해 과금됐을 자리다. 증분 전환은 성능뿐 아니라 스캔 과금도 같은 배수로 줄인다. 비용이 성능을 정당화하는 시점이 오면 dbt 어댑터 교체로 이전한다

### 대표 수치 (전부 직접 실측, 재현 기록 저장소 보존)

| 항목 | 실측 |
|---|---|
| 정합 검증 | 원천 PG = parquet = DuckDB 3자 일치 (149,259 / 79,894행), 멱등 2회 재실행 불변 |
| 변환 | 지문 충돌 12,743키 SUM 복원 · 순리셋 219그레인 클램프(음수 0건) · 인접 합산 대비 7배 부풀림 실측 기각 |
| 품질 게이트 | 4축 fail-closed, 장애 주입 시 dbt 미실행(exit 2), 게이트 자체 부하는 Seq Scan 332ms → Index Only Scan 20ms |
| 아카이브 가드 | 자기파괴 경로 전/후 재현: 수정 전 유일본 소멸, 수정 후 삭제 거부·보존 |
| 규모 검증(2축·합성) | 시간축 365일·2,190파일·54.5M행: fct 407.62s → 증분 4s(약 100배) · 인스턴스축 300대·52.2M행: 증분 8.03s, 급소는 full-refresh(769s) |
| 판정층 | 판정 6종 · 발행 21테이블 · 가용성 라이브 MSSQL 2대 63~64% breach(ping 2~7초)·MySQL 98.9% 근소 미달 / PG·Mongo·Oracle 99.9% meets |
| 서빙 | 발행 중 연속 질의 41회 무중단(스냅샷 격리), 파일 직독=API=화면 3자 정합(+149.1% 동일) |
| DuckLake 운영 | 타임트래블·ROLLBACK 원자성 실증, CHECKPOINT 스냅샷 11→2 정리에도 행수 229,153 불변 |
| 되쓰기 | dow×hour 베이스라인 32,498행 단일 트랜잭션 왕복, 역할 분리로 원천 readonly 봉인 유지(permission denied 확인) |
| 감시 | deadman 30h 침묵(기한 26h) 경보 실수신, contracts 위반 주입 시 빌드 차단 |
| 테스트 | pytest 57 passed · dbt build PASS=129(unit test·contracts·데이터 테스트 포함) · CI 3관문 |

### 배운 것

- 조용히 틀린 데이터는 없는 것보다 나쁘다. 게이트·CI·contracts·deadman이 각자 다른 실패 모드를 막아야 신뢰가 계층으로 선다.
- 최적화는 규모가 요구할 때만 한다. 두 축을 합성해 재보기 전까지는 증분 전환도 하지 않았고, 실측이 병목 하나(fct 재빌드)만 지목했기에 거기만 고쳤다. 외삽("소파일이 먼저 무너진다")은 축을 돌린 실측이 바로잡았다.
- 멱등은 공짜가 아니다. delete-first 재적재의 경계 조건(보존 창 밖 유일본)을 감사하지 않았다면 편의 장치가 데이터를 지우는 장치가 됐다.
- 판정은 계산까지, 발화는 남에게. 창고가 PENDING·AMBIGUOUS를 지어내지 않고 남기는 것, 삭제 후보까지만 내고 멈추는 것이 자동화의 신뢰를 만든다.

<div class="lc-sub">github.com/dj258255/dbtower-lakehouse<br>실측 기록 docs/VERIFICATION.md</div>
</a>
<a class="linkcard" href="https://dj258255.github.io/IT-Oasis/blog/project/lakehouse/lakehouse-0-why">
<div class="lc-title">블로그 총정리 (0편)</div>
<div class="lc-sub">왜 만들었는지부터 판정층까지<br>시리즈 0~5편</div>
</a>
<a class="linkcard" href="https://github.com/dj258255/dbtower-lakehouse/blob/main/docs/RUNBOOK.md">
<div class="lc-title">운영 절차 (RUNBOOK)</div>
<div class="lc-sub">backfill·장애 대응·CHECKPOINT<br>docs/RUNBOOK.md</div>
</a>
</div>

## 링크 모음

**DBTower**
- GitHub 저장소: [github.com/dj258255/dbtower](https://github.com/dj258255/dbtower)
- 블로그 총정리(0~9편): [dbtower-0-overview](/blog/project/dbtower/dbtower-0-overview)
- 직접 실행(GHCR): `docker pull ghcr.io/dj258255/dbtower` — 원커맨드 compose, 포트 8080
- 재현 기록: docs/VERIFICATION.md 117개 절

**DBTower-lakehouse**
- GitHub 저장소: [github.com/dj258255/dbtower-lakehouse](https://github.com/dj258255/dbtower-lakehouse)
- 블로그 총정리(0~5편): [lakehouse-0-why](/blog/project/lakehouse/lakehouse-0-why)
- 운영 절차(RUNBOOK): [docs/RUNBOOK.md](https://github.com/dj258255/dbtower-lakehouse/blob/main/docs/RUNBOOK.md)

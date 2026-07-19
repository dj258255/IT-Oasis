---
title: '채널은 갈아끼우고 5기종은 인터페이스 뒤로, 스스로 진단하는 관제탑까지'
titleEn: 'Swapping Channels, Hiding Five Engines Behind One Interface, and a Tower That Diagnoses Itself'
description: '이기종 DBMS 운영 관리 플랫폼 DBTower. 같은 분석 코어를 사람에게는 웹 콘솔로, AI 에이전트에게는 MCP 도구로, 온콜에게는 웹훅 push로 노출하는 채널 설계에서 시작합니다. 이어서 ''새 기종 = Operator 구현체 1개''라는 주장을 검증하러 SQL도 JDBC도 없는 MongoDB와 상용 Oracle을 실제로 추가하고, DBA가 장애 때 가장 먼저 보는 Wait Event를 5기종으로 통합하며 ''JPA로 통일하면 되지 않냐''는 질문에 적재적소로 답합니다. 마지막으로 고정 임계 없는 이상 감지(z=378)부터 암시적 형변환을 code=12345로 지목하는 심층 원인 진단까지, 플랫폼이 스스로 보고 판단하되 대상 DB는 건드리지 않는 자율 진단 스택을 실측과 함께 기록합니다.'
descriptionEn: 'DBTower, a heterogeneous DBMS operations platform. It starts with a channel design that exposes one analysis core three ways: a web console for humans, MCP tools for AI agents, and webhook push for on-call. Then it verifies the claim that a new engine costs exactly one Operator implementation by adding MongoDB (no SQL, no JDBC) and commercial Oracle, unifies Wait Events across five engines, and answers why the Operator layer is not folded under JPA. Finally it records the autonomous diagnosis stack from fixed-threshold-free anomaly detection (z=378) to deep root-cause diagnosis that pinpoints implicit type conversion at code=12345, all read-only: the platform watches and judges but never mutates the target DB.'
date: 2026-05-04
tags:
  - Java
  - Spring Boot
  - DBRE
  - MCP
  - Claude
  - MongoDB
  - Oracle
  - JPA
  - Spring Data
  - SRE
  - Query Optimization
  - Observability
category: personal/DBTower
coverImage: /uploads/project/dbtower/health-score.png
draft: false
series: "DBTower"
seriesOrder: 2
---

## 1. 들어가며, 기능은 다 있는데 쓸 사람이 없다

[1편](/blog/project/dbtower/dbtower-1-design)까지 시점 비교도 회귀 감지도 전부 REST API였습니다. curl을 칠 줄 아는 나만 쓸 수 있었습니다. 레퍼런스 발표에선 기능 목록보다 **화면**이 먼저 눈에 들어왔습니다. CPU 그래프를 드래그해 구간을 고르면 상위 쿼리가 나오고 클릭하면 분석이 나오는 흐름. 기능이 같아도 채널이 없으면 운영 도구가 아닙니다.

이번 편은 채널 이야기입니다. 같은 코어를 세 방향으로 노출했습니다.

- **사람**에게는 웹 콘솔입니다 (그래프 드래그 → 비교 표 → 클릭 분석)
- **AI 에이전트**는 MCP 서버로 붙습니다 (필요할 때 도구로 당겨쓰는 pull)
- **온콜**은 웹훅 알림을 받습니다 (1편에서 만든, 플랫폼이 사람에게 미는 push)

## 2. 프레임워크 없이, 의존성 0으로 만든 웹 콘솔

프론트는 정적 파일 세 개(HTML/CSS/JS)입니다. React를 몰라서가 아니라 이 프로젝트의 본질이 백엔드라서입니다. 빌드 파이프라인 없이 `java -jar` 하나로 API부터 화면까지 다 뜨는 건 운영 도구엔 오히려 장점입니다.

핵심 인터랙션은 레퍼런스에서 배운 그대로입니다. 활동 그래프(QPS 시계열)를 **드래그하면 그 구간이 시점 비교의 조회 구간이 되고** 한 번 더 드래그하면 베이스라인 구간이 됩니다. 마우스 이벤트 세 개(mousedown/mousemove/mouseup)로 SVG에 반투명 사각형을 그리는 90줄 코드입니다. 그런데 "장애 시각을 숫자로 입력하세요"와 "그래프에서 튄 부분을 드래그하세요"는 완전히 다른 도구입니다.

비교 표에는 쿼리마다 증감을 붙였습니다. `12.3 (▲ 460%)` 같은 셀에, base 구간에 없던 쿼리는 NEW 뱃지. 실측 부하(점조회 베이스라인 → 급증 + 신규 LIKE 풀스캔)에서 호출량 +461%, 읽은 행수 +852%, 신규 쿼리 1건이 표에 그대로 잡혔습니다.

### 사소하지만 실전적인 함정 둘

**hidden이 display:flex에 진다.** 요약 스트립을 `el.hidden = true`로 숨겼는데 계속 보였습니다. HTML 표준에서 `hidden`은 UA 스타일시트의 `display: none`으로 구현되는데, 제가 쓴 `.summary-strip { display: flex }`가 **명시도에서 이겨버립니다**. `.summary-strip[hidden] { display: none }`을 추가해 해결했습니다. 표준 문서에도 있는 동작이지만 직접 밟으니 잊히지 않았습니다.

**innerHTML에 넣는 모든 값은 이스케이프.** 비교 표의 쿼리 텍스트는 DB에서 온 값이고, DB에는 무엇이든 들어올 수 있습니다. `esc()` 함수 하나로 innerHTML로 가는 모든 동적 값에 예외 없이 적용했습니다. 내부용이라 방심하기 쉽지만, 내부 도구야말로 세션 권한이 세서 XSS가 치명적입니다.

## 3. AI 에이전트의 채널 MCP, SDK 없이

웹 콘솔이 사람의 채널이라면, AI 에이전트의 채널은 MCP(Model Context Protocol)입니다. Claude 같은 에이전트가 DBTower의 시점 비교와 EXPLAIN, 헬스체크를 **도구로 직접 호출**합니다. "어제 오후에 뭐가 느려졌지?"라고 물으면 에이전트가 compare를 불러 표를 읽고 답하는 그림입니다.

SDK 없이 JSON-RPC 2.0부터 직접 구현했습니다. 프로토콜을 알아야 디버깅이 되기 때문입니다. 구현하며 배운 규약들이 이 프로토콜의 설계 의도를 보여줍니다.

- **id가 없는 메시지는 알림(notification)이고 알림에는 절대 응답하지 않는다.** `notifications/initialized`에 무심코 200과 본문을 돌려주면 스펙 위반입니다. HTTP 전송에서는 202 Accepted + 빈 본문.
- **도구 실행이 실패해도 JSON-RPC error로 던지지 않고 `result.isError: true`로 돌려준다.** 처음엔 이상했지만 이유가 명확합니다. 프로토콜 에러는 클라이언트 코드가 처리하지만, 도구 실패는 **LLM이 읽고 스스로 정정**해야 하기 때문입니다. "없는 인스턴스 id입니다"를 읽은 에이전트가 list_instances를 먼저 부르는 식입니다.
- **stdio 전송은 "한 줄 = 메시지 하나".** 로그를 stdout에 찍는 순간 프로토콜이 깨집니다. 로그는 전부 stderr로.

전송(stdio/HTTP)과 프로토콜 처리를 분리한 덕에 두 전송이 코어 하나를 공유합니다. 웹 콘솔의 MCP 카드에는 등록 명령 복사 버튼과 도구 목록을 그려두었는데, 이 목록은 **화면이 직접 POST /mcp로 tools/list를 호출한 실시간 응답**입니다. 하드코딩이 아닙니다. 목록이 보인다는 것 자체가 엔드포인트가 살아 있다는 증거입니다.

```bash
claude mcp add --transport http dbtower http://localhost:8080/mcp
```

![MCP 연동 카드. 도구 목록은 tools/list 실시간 응답이고, 목록이 보인다는 것 자체가 살아 있다는 증거](/uploads/project/dbtower/mcp.png)

## 4. AI 1차 분석, API 키가 없으면 CLI를 부른다

1편에서 AI 분석은 "API 키 없으면 조용히 비활성화"였습니다. 그런데 로컬 개발 중 매번 키를 발급받기도 애매하고, 이미 Claude 구독으로 claude CLI를 쓰고 있었습니다. 그래서 백엔드를 자동 선택하게 바꿨습니다.

```
ANTHROPIC_API_KEY 있음   → Anthropic Java SDK (운영 구성)
없음 + claude CLI 설치됨 → claude -p headless 호출 (로컬 개발)
둘 다 없음               → 비활성화 (규칙 기반 분석만)
```

CLI 호출에서 배운 것 두 가지가 핵심입니다.

**프롬프트는 argv 대신 stdin으로.** 분석 대상인 SQL과 실행계획에는 따옴표든 개행이든 뭐든 들어옵니다. 인자로 넘기면 어딘가에서 파싱이 깨집니다. stdin으로 흘리면 내용이 무엇이든 무관합니다.

**`--setting-sources ""`로 사용자 설정을 배제.** 처음 돌렸을 때 분석 결과에 제 로컬 Claude 설정의 출력 스타일 블록이 섞여 나왔습니다. CLI가 호출자 개인 설정을 물려받으면 같은 코드가 환경마다 다른 형식을 뱉습니다. 설정 소스를 비워 어떤 로컬에서도 순수한 분석 텍스트가 나오게 고정했습니다. 판단 기준 문서는 `--append-system-prompt`로 주입하니 API 백엔드와 프롬프트가 동일합니다.

실측에서는 LIKE '%...%' 풀스캔 쿼리(8,118행)의 access_type=ALL 원인을 앞 와일드카드로 특정했고, 문서에 없는 수치에는 "주어진 계획만으로 판단할 수 없다"고 답했습니다. "근거 없으면 모른다고 말하라"는 프롬프트 규칙이 지켜지는 것까지 확인하고서야 이 기능을 믿었습니다.

![AI 1차 분석. 판단 기준 문서를 시스템 프롬프트로 쓰는 일관 판정](/uploads/project/dbtower/ai-analysis.png)

## 5. 채널 셋을 놓고 보니

| 채널 | 대상 | 방향 | 쓰는 순간 |
|---|---|---|---|
| 웹 콘솔 | 사람 | pull | "지금 뭐가 느리지?" 하고 직접 볼 때 |
| MCP | AI 에이전트 | pull | 에이전트가 분석 도구로 당겨쓸 때 |
| 웹훅 | 온콜 | push | 플랫폼이 회귀를 먼저 발견했을 때 |

셋 다 시점 비교와 EXPLAIN, 규칙 분석이라는 같은 코어를 부릅니다. 채널을 추가하는 동안 코어는 한 줄도 바뀌지 않았습니다. 기종 차이를 `DbmsOperator` 뒤로 숨긴 것과 같은 구도가 채널에도 성립했습니다. 안쪽 경계는 기종을 숨기고 바깥 경계는 소비자를 숨긴다.

## 6. 주장은 검증 전까지 빚이다

1편부터 같은 문장을 써 왔습니다. "새 기종 지원 = Operator 구현체 1개 추가, 플랫폼 코드는 수정 없음." SQL Server를 세 번째로 붙일 때 확인은 했지만 MySQL·PostgreSQL·SQL Server는 결국 다 SQL이고 다 JDBC입니다. 추상화가 진짜 시험대에 오르는 건 전제가 깨지는 기종이 들어올 때입니다.

그래서 성격이 정반대인 둘을 골랐습니다.

- **Oracle**은 JDBC는 맞지만 통계 소스(V$SQL)와 권한 모델, 백업(Data Pump)이 전부 다른 상용 DB입니다.
- **MongoDB**는 SQL도 JDBC도 없고, 실행계획이 JSON이며, 통계 소스가 시스템 뷰 대신 컬렉션입니다.

## 7. 인터페이스가 SQL을 전제하지 않았는지 MongoDB로 확인하는 시험

`DbmsOperator`의 7개 메서드(health, queryStats, slowQueries, explain, tableStats, backup, replicationState)를 MongoDB로 하나씩 옮겨보면, 추상화 경계를 어디에 그었는지가 드러납니다.

| 운영 행위 | JDBC 계열 | MongoDB |
|---|---|---|
| 쿼리 통계 | performance_schema / V$SQL 조회 | system.profile 컬렉션을 queryHash로 집계 |
| 실행계획 | `EXPLAIN` + SQL 문자열 | `explain` 명령 + **명령 JSON** |
| 읽기 전용 가드 | "SELECT로 시작해야 함" | 첫 키가 find/aggregate/count/distinct인지 검사 |
| 커넥션 관리 | 인스턴스별 HikariCP 풀 | MongoClient 자체가 풀이라 인스턴스별 캐시 |

explain 입력이 SQL이 아니라 `{"find": "users", "filter": {"name": {"$regex": "user123"}}}` 같은 JSON이 되는데도 인터페이스 시그니처는 그대로입니다. 경계를 "SQL을 실행한다"가 아니라 **"실행계획을 받아온다"라는 운영 행위**에 그었기 때문입니다. 규칙 분석기도 같습니다. MySQL의 `access_type=ALL`이 하던 역할을 MongoDB에서는 `COLLSCAN` 스테이지가 합니다. 신호 문자열만 다르지 "인덱스 없이 전부 훑는다"는 판정은 같습니다.

한 가지 성질 차이는 문서에 박아뒀습니다. 다른 기종의 통계는 서버 기동 이후 무한 누적 카운터인데, `system.profile`은 **capped collection**이라 가득 차면 오래된 기록을 덮어씁니다. 합계가 줄어들 수 있다는 뜻인데, 시점 비교가 카운터 리셋 대비로 이미 갖고 있던 음수 클램프가 이 경우도 흡수합니다. 설계 때 넣은 방어가 예상 못 한 기종에서 제값을 한 순간이었습니다.

## 8. 같은 "FULL 백업"이 네 갈래로 갈리고, stdin의 함정까지

1편에서 백업이 세 갈래로 갈라진다고 했는데, 다섯 기종이 되니 실행 모델이 네 가지가 됐습니다.

| 모델 | 기종 | 비밀번호 전달 |
|---|---|---|
| 외부 CLI + 환경변수 | MySQL(mysqldump), PostgreSQL(pg_dump) | `MYSQL_PWD` / `PGPASSWORD` |
| 외부 CLI + stdin | MongoDB(mongodump) | `--config /dev/stdin` |
| 서버 사이드 SQL | SQL Server | 필요 없음 (`BACKUP DATABASE`) |
| 서버 사이드 API | Oracle | 필요 없음 (`DBMS_DATAPUMP` PL/SQL) |

mongodump가 재미있는 경우입니다. 비밀번호 환경변수가 아예 없어서, argv에 싣지 않으려면(ps에 노출되니까) `--config` 파일로 줘야 하는데 임시 파일은 만들기 싫었습니다. `--config /dev/stdin`으로 표준입력에 `password: ...` 한 줄을 흘렸습니다.

그런데 푸시 직후 자동 보안 리뷰가 이 지점을 찔렀습니다. **stdin에 값을 그대로 이어붙이면, 비밀번호에 개행이 들어올 때 YAML의 다른 설정 키를 주입할 수 있다**는 겁니다. `x\nuri: mongodb://공격자서버` 같은 값이면 덤프가 다른 곳으로 갈 수도 있었습니다. 등록자가 관리자라 실현 가능성은 낮지만 관리 플랫폼은 심층 방어가 기본입니다. 제어 문자를 거부하고 YAML 작은따옴표 스칼라로 감싸는(`'` → `''`) 이스케이프를 넣은 뒤, 주입 시도가 거부되는 것을 테스트로 고정했습니다.

Oracle은 반대쪽 극단입니다. expdp CLI 대신 `DBMS_DATAPUMP` PL/SQL API로 **서버가 직접** 덤프를 씁니다. CLI 미설치 환경 제약과 비밀번호 노출 문제가 동시에 사라집니다. SQL Server의 `BACKUP DATABASE`와 같은 "서버 사이드" 모델인데, SQL 한 문장이냐 API 패키지냐만 다릅니다.

## 9. 예상 못 한 곳에서 등록을 막은 Hibernate CHECK 제약

코드를 다 붙이고 MongoDB 인스턴스를 등록하는데 500이 떨어졌습니다.

```
ERROR: new row for relation "database_instance"
       violates check constraint "database_instance_type_check"
```

원인은 코드가 아니라 **메타데이터 DB에 남아 있던 과거**였습니다. Hibernate가 처음 테이블을 만들 때 enum 컬럼에 `CHECK (type IN ('MYSQL','POSTGRESQL','MSSQL'))` 제약을 같이 생성해뒀는데, `ddl-auto: update`는 컬럼은 추가해도 **기존 CHECK 제약은 갱신하지 않습니다**. enum에 값을 추가하는 순간, 배포로 끝날 일이 스키마 마이그레이션으로 바뀝니다.

수동 ALTER로 풀었지만 교훈은 명확했습니다. enum을 DDL 제약으로 내려보내는 순간 enum 확장은 코드 배포만으로 끝나지 않는다. Flyway 같은 마이그레이션 도구가 왜 필요한지를 교과서보다 내 프로젝트에서 먼저 만났습니다.

## 10. 결산, 정말 0줄이었나

정직하게 세어보면 이렇습니다.

- **새로 만든 것**: OracleOperator, MongoOperator, MongoClientCache, 그리고 백업 실행 유틸(BackupCommands, 원래 JDBC 골격 안에 있던 것을 비 JDBC 기종이 생기면서 분리)
- **몇 줄 수정**: enum 값 2개, 팩토리 case 2줄, 규칙 분석기 case 2블록, CSS 색 2줄
- **0줄 수정**: 스냅샷 폴러, 시점 비교, 회귀 감지, 웹 콘솔, MCP 서버

등록하고 부하를 걸자 MongoDB의 활동 그래프에 QPS 급증(0 → 10.67)이 그려지고, 시점 비교가 신규 쿼리 2건을 NEW로 잡고, regex 검색이 호출당 20,000 문서를 훑는다는 것(rowsExamined)까지 수치로 나왔습니다. MCP로도 여섯 인스턴스가 그대로 보입니다. 채널도 코어도 새 기종이 온 것을 모릅니다.

![다섯 기종 여섯 인스턴스를 한 화면에 같은 카드와 같은 그래프로 담은 대시보드](/uploads/project/dbtower/dashboard.png)

마무리로 이 산식들이 회귀하지 않게 단위 테스트 31건(시점 비교 차분·경계, 회귀 감지 임계값·쿨다운, 백업 명령 주입 방어, MCP 프로토콜 규약, 5기종 판정 규칙)을 깔고 GitHub Actions CI를 붙였습니다. 테스트가 실 DB 없이 돌도록 인메모리 H2 설정을 분리한 것까지가 확장의 끝입니다.

## 11. 두 개의 질문으로 들어가며

[3편](/blog/project/dbtower/dbtower-3-production-safety)에서 운영 안전을 닫고 나니 성격이 다른 두 질문이 남았습니다. 하나는 기능입니다. "DBA가 장애 때 실제로 뭘 보는가?" DBTower의 쿼리 통계는 load%, "어떤 쿼리가 시간을 쓰나"를 답해 왔습니다. 하지만 현업 DBA가 장애 순간 가장 먼저 여는 건 그다음입니다. **"그 시간에 무엇을 기다렸나"**, 곧 CPU냐 IO냐 Lock이냐 Latch냐. Wait Event 분석입니다.

다른 하나는 설계입니다. 누군가 물었습니다. "Operator 계층도 JPA + Lombok + Native Query로 추상화하면 더 깔끔하지 않냐?" 제대로 분석해 봤는데 결론은 반대였습니다. 이번 편은 이 두 질문에 답하며 프레임워크를 어디에 쓰고 어디에 안 쓸지 정리한 기록입니다.

## 12. Wait Event로 5기종의 "무엇을 기다렸나"를 묻다

load%가 "누가 시간을 쓰나"라면 Wait Event는 "무엇을 기다렸나"입니다. `DbmsOperator`에 메서드 하나(`waitEvents`)를 추가해 5기종을 통합했습니다. 앞서 5기종을 붙이며 말해온 "새 능력 = 인터페이스 메서드 1개"의 또 한 번의 실측입니다.

그런데 기종마다 **"대기"의 의미론 자체가 다릅니다**. 같은 이름을 달아도 답하는 내용은 제각각입니다.

| 기종 | 소스 | 의미 |
|---|---|---|
| MySQL | events_waits_summary_global_by_event_name | 기동 이후 누적(피코초→ms) |
| PostgreSQL | pg_stat_activity (active 세션) | 현재 순간 스냅샷이라 무부하면 빈 배열 |
| SQL Server | dm_os_wait_stats | 기동 이후 누적, idle/백그라운드 필터 |
| Oracle | v$system_event (Idle 제외) | 기동 이후 누적(마이크로초→ms), wait_class |
| MongoDB | serverStatus 대기 큐 + WT 티켓 | 현재 게이지이며 wait event가 아니라 대기 지표 |

누적 카운터(MySQL·MSSQL·Oracle)와 현재 순간 스냅샷(PostgreSQL·MongoDB)이 섞여 있습니다. PostgreSQL을 무부하 구간에 조회하면 빈 배열이 나오는데, 버그처럼 보여도 스냅샷 방식의 정직한 결과입니다.

```
MySQL:  wait/io/table/sql/handler io count=17,336,000 totalMs=3705.36
PG:     [] — 무부하 구간, 스냅샷 방식의 정직한 결과
Oracle: db file sequential read (User I/O) 24,948회, latch: shared pool 3,093회
Mongo:  globalLock.currentQueue.readers=0, WT concurrentTransactions 티켓
MCP:    도구 9종(wait_events 포함), 웹 콘솔 Monitoring 탭 카드 렌더링
```

이 기능에서 제일 신경 쓴 건 두 가지 **정직성 설계**입니다.

**하나, 관제 도구는 대상 설정을 바꾸면 안 된다.** MySQL은 wait instrument 상당수(349종)가 기본 비활성입니다. 켜면 더 많은 대기가 보이지만 그건 대상 DB의 설정을 바꾸는 행위입니다. 관측하려고 관측 대상을 건드려선 안 됩니다. 그래서 instrument를 켜지 않고, 대신 "비활성 349종은 집계에 없음"이라고 **안 보이는 범위를 응답에 명시**했습니다.

**둘, 필터는 실측으로 보강한다.** SQL Server는 1차 응답에서 `SOS_WORK_DISPATCHER` 같은 idle 대기가 8억 ms로 화면을 도배했습니다. 교과서적인 idle 필터 목록은 있지만, 실제 응답에서 무엇이 노이즈인지 확인한 뒤 필터를 보강했습니다.

![Wait Events로 그 시간에 무엇을 기다렸나를 보고, 비활성 instrument 범위까지 응답에 명시](/uploads/project/dbtower/wait-events.png)

## 13. "JPA + Native Query로 통일하면 되지 않냐"에 대한 답

이제 두 번째 질문입니다. 다섯 기종을 다루니 "Operator도 JPA로 추상화하고 시스템 뷰 조회는 Native Query로 하면 깔끔하지 않냐"는 제안이 자연스러워 보입니다. 하지만 방향이 반대였습니다.

Operator가 붙는 대상은 **런타임에 등록되는 N개의 남의 DB**입니다. JPA는 부팅 시점에 데이터소스가 고정되고 엔티티가 매핑되는 걸 전제하니 근본적으로 안 맞습니다. 게다가 Operator가 읽는 건 `performance_schema`나 `V$SQL` 같은 **시스템 뷰**라 매핑할 엔티티가 없습니다. Native Query는 "JPA가 실행해주는 raw SQL"일 뿐인데, 매핑할 게 없는 시스템 뷰에 얹으면 의식만 늡니다. 결정타는 **MongoDB입니다. JPA 자체가 없습니다.**

그래서 추상화 경계를 JPA/JDBC보다 **위**에 뒀습니다. `DbmsOperator` 인터페이스가 그 경계로, 사실 익숙한 Spring Data의 **Repository + Impl과 같은 모양**입니다. 인터페이스가 능력을 선언하고 기종별 구현체가 각자의 기술로 채웁니다. 경계를 위에 두면 안쪽에서는 각 기술을 제자리에 쓸 수 있습니다.

## 14. Lombok과 JdbcTemplate을 딱 필요한 곳에만 두는 적재적소

경계를 정하니 안쪽 정리는 명쾌했습니다. 두 가지를 손봤습니다.

**Lombok은 JPA 엔티티에만.** 값 객체는 `record`로 불변을 유지하고, Lombok은 JPA 엔티티 6묶음에만 `@Getter`와 `@NoArgsConstructor(PROTECTED)`로 넣었습니다. `@Data`·`@ToString`·`@EqualsAndHashCode`는 엔티티의 lazy 연관과 hashCode에 지뢰가 되니 뺐습니다. 이렇게 손으로 쓴 게터 43개를 지웠습니다. "Lombok을 쓴다"보다 "어디에 쓰면 안전한가"를 정한 것입니다.

**JdbcTemplate은 Operator의 조회 메커니즘에만.** 남아 있던 raw `try-with-resources` + `ResultSet` 루프를 JdbcTemplate으로 바꿨습니다. 중요한 건 **SQL은 한 글자도 안 바꿨다**는 것입니다. 시스템 뷰를 어떻게 읽을지에 대한 통제는 그대로 두고 실행 메커니즘만 정리했습니다. 순 -53줄(283 삭제/230 추가)입니다.

여기서도 무리하지 않았습니다. Oracle의 explain은 세션 지역 `PLAN_TABLE`을 써서 `ConnectionCallback`로 남기고, 서버 사이드 백업은 raw JDBC 그대로 뒀습니다. 억지로 JdbcTemplate에 밀어 넣으면 정확성이 깨지는 지점이기 때문입니다.

## 15. 감사 로그 검색에서 Specification이 찾은 제자리

정리하면서 하나 더 든 게 감사 로그 검색입니다. 앞선 리팩터에서 "정적 쿼리를 커스텀 프래그먼트로 감싸는 건 과설계"라 판단했는데, 그 판단의 **짝**입니다. Specification이 정말 값을 하는 건 **필터가 런타임에 조립되는 동적 쿼리**일 때고, 감사 로그 검색이 정확히 그 경우였습니다.

3편에서 감사 로그가 쌓이니 "누가 무엇을 했나"를 좁혀 볼 방법이 필요했습니다. 필터는 사용자·action·인스턴스·결과코드·기간 6종인데, 어느 것이든 있을 수도 없을 수도 있습니다. 파생 메서드나 `@Query`로 풀면 조합 수만큼 메서드가 폭발합니다(`findByPrincipal`, `findByPrincipalAndOutcome`, ... 2^6).

그래서 `JpaSpecificationExecutor`를 상속하고, 각 빌더는 파라미터가 비면 `null`("이 필터 없음")을 반환하게 했습니다. 컨트롤러가 null을 걸러 AND로 reduce하면, 필터가 늘어도 메서드는 그대로고 조각 하나만 늡니다.

```
무필터:                     9건 전체
action=explain (부분일치):  explain 2건만
outcome=200:                200 응답만
instanceId=8 & action=backup (AND): 인스턴스 8의 백업 계열만
미인증 -> 401, VIEWER -> 403 (ADMIN 전용 유지)
```

이로써 Spring Data가 세 층위에서 제자리를 지킵니다. 파생 메서드(정적 단순), `@Query`(정적 집계·벌크), Specification(동적 필터). "어디에 뭘 쓰나"를 기능이 결정하게 두고, 프레임워크를 과시하려고 억지로 한 곳에 몰지 않는 것입니다.

## 16. 정리를 마치고 본 최종 지도

정리를 끝내고 보니 기술 배치가 이렇게 됐습니다.

- **1층, 플랫폼 자기 저장소**: Spring Data JPA. 파생 메서드(정적 단순) / `@Query`(정적 집계·벌크) / Specification(동적 필터)
- **2층, 대상 DB 조회**: JdbcTemplate(JDBC 계열) + Mongo 드라이버(비 JDBC)
- **경계**: `DbmsOperator` 인터페이스가 기종·기술 차이를 그 뒤로 숨긴다

리팩터 후 실 앱에서 5기종의 health·query-stats(RowMapper)·explain(Oracle은 ConnectionCallback로 TABLE ACCESS FULL 판정)·replication이 전부 리팩터 전과 동일하게 나오는 걸 확인했습니다. 테스트는 91건까지 늘었습니다.

돌아보면 이 프로젝트를 관통한 문장은 하나입니다. "이건 기종마다, 기술마다 어떻게 다른가"를 먼저 묻고 그 차이를 경계 뒤로 밀어 넣는 것. 기종 차이는 `DbmsOperator` 뒤로, 소비자 차이는 채널 뒤로, 기술 차이는 각자의 제자리로. 깔끔함은 각 도구가 제일 잘하는 자리에 있게 두는 데서 나온다는 걸 이번 정리에서 다시 배웠습니다.

## 17. 대시보드는 사람이 봐야만 가치가 있다

[3편](/blog/project/dbtower/dbtower-3-production-safety)까지 만든 DBTower는 좋은 대시보드였습니다. 시점 비교, Wait Event, 실행계획 분석은 전부 **사람이 화면을 열어야** 가치가 나옵니다. 그럼 사람이 안 보는 시간의 조용한 저하는 누가 잡습니까?

방향은 실존 제품들을 근거로 잡았습니다. AWS는 DevOps Guru for RDS로 이상을 자동 감지하고, Percona PMM은 Advisors로 운영 규칙을 점검하고, pganalyze는 AI 보조 진단을 붙였습니다. 업계는 이미 "사람이 모는 대시보드"에서 "스스로 보는 관제탑"으로 이동했습니다. Phase D는 그 이동을 따라가되 시리즈 내내 지킨 가드레일은 유지합니다. **전부 읽고 판단만 한다. 대상 DB를 바꾸는 자동 실행은 없다.** 그 선을 넘으면(자동 인덱스 생성 같은) 다른 제품이 되기 때문입니다.

이 편은 2부 구성입니다. 전반부는 "어디가 이상한가"를 스스로 잡는 자율 진단 8종, 후반부는 그렇게 지목된 쿼리에 "그래서 **왜** 느린가"를 답하는 심층 원인 진단입니다.

## 18. 고정 임계의 한계를 넘어선 이상 자동 감지, 그리고 z=378

기존 회귀 감지(1편)에는 "QPS +200%면 알림" 같은 고정 임계가 있었습니다. 문제는 이 숫자가 **모든 쿼리에 같은 기준**이라는 겁니다. 평소 QPS 0.2인 쿼리가 25가 되면 125배인데, 평소 100인 쿼리 기준의 +200%로는 놓칠 수도, 반대로 트래픽 패턴상 정상인 아침 피크를 오탐할 수도 있습니다.

그래서 스냅샷 이력으로 인스턴스·쿼리별 **(요일 x 시간대) 베이스라인**(평균과 표준편차)을 학습하고, 현재 값이 평소에서 몇 표준편차 벗어났는지(z-score)로 판정합니다. "화요일 오후 3시의 이 쿼리는 평소 어땠나"가 기준입니다.

```
부하 실측: COUNT digest qps 25.0
  베이스라인(같은 요일·시간대): 0.17 ± 0.07
  -> z = 378, 고정 임계 없이 감지
폴러 end-to-end 발화: qps 55.0, 평소 5.17 ± 12.22 -> z = 4.1
```

설계에서 신경 쓴 두 가지. **하나, 고정 임계를 없애지 않고 공존시켰습니다.** 베이스라인은 학습 데이터가 필요한데 갓 등록된 인스턴스에는 없기 때문입니다. **둘, 데이터 부족은 "학습 중"으로 보류합니다.** 관측이 부족한 버킷에서 판정을 내리면 신규 인스턴스마다 오탐이 쏟아집니다. 응답에 `learningCount`를 실어 "아직 판단 안 한다"를 명시합니다. 모르는 것을 모른다고 말하는 것도 감지기의 정직성입니다.

![현재 이상 없음과 함께 학습 중 12건은 관측 8회 미만이라 판정을 보류한 이상 감지 화면](/uploads/project/dbtower/anomaly.png)

## 19. 운영 문서를 코드로 옮긴 Advisors, 인터페이스 변경 0

시리즈를 쓰며 쌓인 운영 문서가 있습니다. digest 테이블이 차면 새 쿼리가 통계에서 사라진다(operations.md), 기종별 최소 권한 목록(least-privilege.md) 같은 것들입니다. 문서의 문제는 **사람이 기억해야 작동한다**는 겁니다. 이 규칙들을 Advisor 6종 코드로 옮겨 일일 스윕(HA 분산 락)으로 자동 점검합니다.

재밌는 건 구현 비용입니다. **operator 인터페이스 변경이 0이었습니다.** 기존 `parameters()`, `describeSchema()`, `tableStats()`, `queryStats()`를 재사용해 판정만 얹어서, "새 능력 = 메서드 1개"조차 필요 없던 케이스입니다. 실측(MySQL)에서 "digest 테이블 포화 위험"과 "위험 파라미터값"이 VIOLATIONS로, 중복 인덱스는 OK로, 기종에 무관한 점검은 UNSUPPORTED로 나뉘어 나옵니다.

![digest 포화 위험을 권고와 함께 지적하고 무관한 점검은 미지원으로 정직하게 표기한 Advisors](/uploads/project/dbtower/advisors.png)

## 20. AI에게 읽기 전용 도구만 쥐여준 자연어 진단

앞서 만든 AI 분석은 단발이었습니다. 사람이 쿼리를 고르고 EXPLAIN 결과를 넘기면 판정하는 구조. 이번엔 **도구 사용 루프**로 승격했습니다. "이 DB 왜 느려?"라고 물으면 AI가 어떤 MCP 도구를 부를지 스스로 정하고, 서버가 실행해 결과를 돌려주고, 그걸 보고 다음 도구를 정하는 반복입니다(최대 5스텝).

여기서 안전장치가 두 겹입니다. MCP 도구 중 **read-only 12종 화이트리스트**만 노출해, kill·backup·online-ddl 같은 쓰기 도구는 루프에 아예 존재하지 않습니다. AI가 아무리 연쇄해도 대상 DB 변경이 0인 게 구조적으로 보장됩니다.

```
질문: "이 DB 왜 느려?"  (LIKE 풀스캔 부하 상태)
AI 연쇄: query_stats -> explain
결론: access_type=ALL, 앞 와일드카드 LIKE는 B+Tree 시작점을
      못 잡는다(판단 기준 문서 인용), confidence=high

질문: "작년 크리스마스 접속자 수는?"  (데이터 없음)
결론: 수치를 지어내지 않고 confidence=low
```

두 번째 실측이 중요합니다. 근거 없는 질문에 그럴듯한 숫자를 만들어내지 않는 것. AI를 1차 분석기에 묶어두고 최종 판단은 맡기지 않는 원칙이 루프에서도 유지되는지 확인한 셈입니다.

## 21. p95의 다섯 얼굴, 그리고 SLO와 에러 버짓

SLO를 만들려면 레이턴시 백분위(p95/p99)가 필요한데, 여기서 이기종의 현실을 또 만났습니다. **같은 "p95"인데 기종마다 낼 수 있는 수준이 다릅니다.**

| 기종 | 방식 | 라벨 |
|---|---|---|
| MySQL | events_statements_summary_by_digest의 QUANTILE_95/99 컬럼 | NATIVE (실측 p95=19.95ms) |
| MongoDB | system.profile 원샘플을 직접 계산 | COMPUTED |
| PostgreSQL | 평균 + 1.645 x 표준편차 (정규분포 가정) | ESTIMATED |
| SQL Server / Oracle | 통계 뷰에 분위수도 표준편차도 없음 | UNSUPPORTED |

![같은 p95인데 소스 라벨(실측·직접계산·추정·미지원)이 다른 레이턴시 백분위](/uploads/project/dbtower/latency.png)

핵심은 **네 라벨을 절대 섞지 않는 것**입니다. ESTIMATED를 NATIVE인 척 보여주면 사용자는 추정치를 실측으로 믿고 결정을 내립니다. 백업 검증의 3값(3편), Terraform validate(3편)와 같은 계열의 정직성입니다.

이 위에 Google SRE의 SLO 모델을 얹었습니다. 원칙은 "인프라 지표(CPU)가 아니라 사용자 경험 지표"입니다. 레이턴시 SLI는 방금의 p95를 재사용하고, UNSUPPORTED 기종은 평균 레이턴시로 폴백하되 `source=AVG_FALLBACK`으로 표기합니다. 가용성 SLI는 헬스 샘플 이력의 up 비율이고, 에러 버짓(허용 다운타임 대비 소진율)과 번 레이트로 EXHAUSTED/WARNING/OK를 판정합니다. 실측에서 MySQL이 NATIVE 기반 BREACHING, Oracle이 AVG_FALLBACK, 가용성은 MEETING으로 나왔습니다.

![레이턴시 SLI 위반과 가용성 충족, 에러 버짓 소진율과 번인 레이트를 보여주는 SLO와 에러 버짓](/uploads/project/dbtower/slo.png)

## 22. 파티션·FinOps·백업 신선도로 신호를 채우다

나머지 세 축은 간결하게 짚습니다.

**파티션 조회(D5)**: `partitions()` 메서드 하나로 4기종(MySQL information_schema, PG relpartbound, Oracle user_tab_partitions, MSSQL sys.partitions), MongoDB는 관계형 파티셔닝 개념이 없어 UNSUPPORTED. 직접 파티션 테이블을 만들어 실조회로 검증했습니다. 조회 전용이고, 생성·자동 관리는 범위 밖입니다.

**FinOps 신호(D6)**: 미사용 인덱스를 실제 사용 카운터(PG idx_scan, MySQL COUNT_STAR 등)로 잡되, **절감액 달러는 계산하지 않습니다.** 스토리지 단가는 환경마다 달라 금액을 찍는 순간 지어낸 숫자가 되기 때문입니다. 신호까지만 내고 판단은 사람에게 넘깁니다. 유니크/PK 인덱스는 미사용이어도 제외했습니다. 제약 조건 역할이라 지우면 안 되기 때문입니다.

**백업 신선도(D7)**: 마지막 성공 백업 경과로 FRESH/STALE/NO_BACKUP을 나눕니다. 설계 포인트는 **메타 DB만 읽고 판정**한다는 겁니다. 대상 DB가 죽었을 때야말로 백업 신선도가 가장 중요한데, 그때 대상에 접속해야 알 수 있다면 앞뒤가 바뀐 것입니다. 실측에서 6개 인스턴스가 FRESH 1·STALE 2·NO_BACKUP 3으로 분류됐습니다.

## 23. 흩어진 신호를 아침 첫 화면으로 모으는 헬스 스코어

전반부의 마지막 조각이 D8입니다. D1~D7이 만든 신호는 흩어져 있습니다. 이상 감지 따로, Advisors 따로, SLO 따로. 운영자가 아침에 열 화면은 모든 걸 나열하기보다 **어디부터 봐야 하는지 알려주는 화면**입니다.

health·이상 감지·Advisors·SLO·백업 신선도를 인스턴스별 0~100점 + 등급으로 합산하고, 감점 사유를 분해해 나쁜 순으로 정렬했습니다. 설계 판단 세 가지:

- 신호가 없는 신규 인스턴스는 0점이 아니라 INSUFFICIENT_DATA로 둬서 **"데이터 부족"과 "나쁨"을 구분**합니다.
- 접속 자체가 안 되면 다른 신호가 무의미하니, **health 프로브 예외는 down으로 수렴**시켜 치명으로 처리했습니다.
- 신호 하나의 수집 실패가 스코어 전체를 죽이지 않도록 **신호를 격리(partial)**했습니다.

```
실측(실 8080): local-mysql / local-mssql -> F 52점, 나머지 B ~ 88점, 나쁜 순 정렬
canary 인스턴스 kill -> F 35점으로 최상단 부상
```

canary를 죽이자마자 최상단에 떠오르는 걸 보고 이 화면의 역할이 분명해졌습니다. 대시보드보다 **분류(triage) 큐**에 가깝습니다.

![감점 사유 분해와 나쁜 순 정렬로 아침에 여는 첫 화면이 되는 통합 헬스 스코어](/uploads/project/dbtower/health-score.png)

여기까지가 "어느 인스턴스의 어느 쿼리가 문제"까지 지목하는 전반부입니다. 그런데 다음 질문이 남습니다. 현업에서 제일 흔한 형태가 이것입니다. **"인덱스가 있는데 왜 안 타요?"**

기존 explain 기능(1편)은 이 질문에 절반만 답합니다. EXPLAIN은 옵티마이저의 **추정**이기 때문입니다. "풀스캔을 택했다"까지는 보여주지만 **왜 그런 선택을 했는지**, 옵티마이저가 무엇에 속았는지는 추정 계획만으로 알 수 없습니다. 그걸 알려면 예상 행수(추정)와 실제 읽은 행수(실측)의 **괴리**를 봐야 합니다. 추정 5행인데 실제 348행이었다면 옵티마이저는 거기서 속은 것입니다. 후반부는 그 마지막 층입니다. 명세는 기종별 공식 문서를 웹서칭으로 검증해 판단 기준 문서(ai-analysis-rules.md)에 "심층 원인 규칙" 절부터 만들었습니다. AI 분석과 코드가 같은 기준을 공유해야 하기 때문입니다.

## 24. "실제 실행 계획"이 다섯 가지로 갈라진다

이 시리즈의 익숙한 패턴이 또 반복됩니다. 같은 "실제 실행 계획"인데 얻는 방법이 기종마다 전부 다릅니다.

| 기종 | 방법 | 특이점 |
|---|---|---|
| MySQL | EXPLAIN ANALYZE (TREE) | 8.4가 FORMAT=JSON을 거부해서 아래 참고 |
| PostgreSQL | EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) | 버퍼 읽기까지 JSON으로 |
| Oracle | /*+ gather_plan_statistics */ 힌트 + DBMS_XPLAN.DISPLAY_CURSOR('ALLSTATS LAST') | 실행과 조회가 **같은 커넥션**이어야 함 |
| SQL Server | SET STATISTICS XML ON | 계획이 **별도 결과셋**으로 오므로 getMoreResults()로 수거 |
| MongoDB | explain의 executionStats verbosity | totalDocsExamined vs nReturned |

구현 디테일 두 개만 봅니다. Oracle은 `DISPLAY_CURSOR`가 "방금 이 세션이 실행한 커서"를 찾는 구조라 풀에서 커넥션을 두 번 빌리면 안 됩니다. `ConnectionCallback`으로 실행과 조회를 한 커넥션에 묶었습니다(앞서 explain에 쓴 것과 같은 패턴). SQL Server는 `SET STATISTICS XML ON`을 켜면 쿼리 결과 **다음에** 계획 XML이 별도 결과셋으로 따라와서, `getMoreResults()`로 넘겨가며 수거해야 합니다.

그리고 MySQL에서 문서가 실측에 진 이야기. 명세 단계에서는 웹 자료를 근거로 `EXPLAIN ANALYZE FORMAT=JSON`으로 적어뒀는데, 구현하며 실제 MySQL 8.4에 던지자 **ERROR 1235로 거부**됐습니다. 구현은 기본 출력인 TREE 파싱으로 갔고, **판단 기준 문서를 실측 결과대로 고쳤습니다.** 명세대로 코드를 끼워맞추는 대신 실측이 명세를 고쳤습니다. 시리즈 내내 지켜온 순서입니다.

## 25. loops를 곱하지 않으면 빠지는 괴리 계산의 함정

괴리를 계산할 때 밟기 쉬운 함정이 있습니다. MySQL과 PostgreSQL의 actual rows는 **루프당 평균**입니다. 중첩 루프 조인의 안쪽 노드가 `rows=3, loops=100`이면 실제로 읽은 건 300행입니다. 3행이 loops만큼 돈 값이니까요. loops를 곱하지 않으면 "추정 3, 실제 3, 괴리 없음"이라는 엉뚱한 결론이 나옵니다.

괴리 판정은 이렇게 했습니다:

- MySQL/PG: 실제 총량 = actual rows x loops로 환산 후 추정과 비교
- Oracle: ALLSTATS LAST의 A-Rows는 이미 총량이라 그대로
- **추정 vs 실제가 10배 이상** 벌어진 노드 중 **최하위(리프에 가까운) 노드**를 지목합니다. 괴리는 아래에서 위로 전파되니 뿌리를 짚어야 처방이 나오기 때문입니다

loops 곱의 정확성은 단위 테스트로 고정했습니다(전체 12건에 포함). 한 번 틀리면 진단 전체가 그럴듯한 거짓말이 되는 지점이기 때문입니다.

## 26. 숫자 하나로 인덱스가 죽는 근본 원인 5종

괴리 노드를 찾았으면 이제 "왜"입니다. 인덱스를 무력화하는 패턴을 다섯 가지로 정리해 판정 규칙에 넣었습니다.

1. **암시적 형변환**. 문자열 컬럼에 숫자 리터럴(`code = 12345`)을 주면, 비교 규칙상 문자열 쪽이 숫자로 캐스팅돼(컬럼에 함수를 씌운 꼴) 인덱스가 무력화됩니다. 게다가 `'012345'` 같은 다른 문자열까지 같은 숫자로 매칭되는 **정합성 위험**까지 있습니다
2. **컬럼에 함수/표현식**. `WHERE UPPER(name) = ...` 같은 경우입니다. 인덱스는 원본 값 순서로 정렬돼 있습니다
3. **앞 와일드카드 LIKE**. `LIKE '%abc'`는 B+Tree 탐색 시작점을 못 잡습니다
4. **복합 인덱스 선두 누락**. (a, b) 인덱스에 b만으로 조건을 건 경우
5. **통계 노후**. 옵티마이저가 낡은 분포로 추정합니다

이 중 1번이 제일 악랄합니다. 쿼리만 봐서는 멀쩡해 보이기 때문입니다. 실측입니다:

```
MySQL, code VARCHAR 컬럼에 인덱스 존재:

WHERE code = 12345      (숫자 리터럴)
  -> 풀스캔. 근본 원인: "암시적 형변환" 정확 지목
  -> 처방: "값을 문자열로 주거나 컬럼 타입을 맞춰라"

WHERE code = '012345'   (문자열 리터럴)
  -> 인덱스 정상 사용. 근본 원인 없음
```

![심층 원인 진단으로 추정 300행과 실제 1행의 괴리에서 암시적 형변환을 지목하고 처방까지 내놓은 화면](/uploads/project/dbtower/deep-diagnose.png)

같은 인덱스, 같은 테이블, 따옴표 하나 차이입니다. "풀스캔입니다"까지만 말해주는 도구와 "형변환 때문이고 이렇게 고치세요"까지 말해주는 도구의 차이가 이 기능의 존재 이유입니다. 다른 기종에서도 같은 틀이 동작합니다. PostgreSQL은 추정 5행 vs 실제 348행(69.6배)에서 앞 와일드카드를, MongoDB는 docsExamined가 반환 문서의 2만 배인 COLLSCAN을 잡았습니다.

발행 후 받은 외부 리뷰가 이 화면을 세 군데 고치게 했습니다. **하나, 카드 순서.** 처음엔 "카디널리티 오추정"이 첫 카드였는데, 괴리는 형변환의 **증상**일 뿐입니다. 첫 카드만 읽은 사용자가 "통계 문제구나" 하고 ANALYZE만 돌리고 끝낼 수 있다는 지적이 정확했습니다. 지금은 근본 원인이 먼저 오고, 괴리는 "위 원인의 부산물이라 통계 갱신으로는 안 풀린다"로 옮겼습니다. **둘, 정합성 경고.** 형변환의 더 무서운 얼굴은 `'012345'`·`'12345 '`·`'12345abc'`가 전부 숫자 12345로 매칭된다는 겁니다. 조회면 오답, UPDATE/DELETE면 데이터 사고인데, 원래 판정문은 성능 얘기만 했습니다. **셋, loops 환산 안내는 loops>1일 때만.** loops=1인 계획에서는 노이즈였기 때문입니다.

그리고 리뷰가 제안한 것 하나를 새로 만들었습니다. **수정안 원클릭 재진단**입니다. 형변환 케이스는 "숫자 리터럴에 따옴표"라는 기계적으로 안전한 수정이 가능해서, 판정이 수정안 SQL을 함께 돌려주고 버튼 한 번으로 재진단해 before/after를 비교합니다.

![수정 전후를 비교하니 괴리가 300배에서 없음으로, 근본원인이 1건에서 0건으로 줄고 Index lookup으로 전환된 화면](/uploads/project/dbtower/deep-before-after.png)

여기서 정합성 경고가 실측으로 증명되는 덤이 있었습니다. 수정 전의 "실제 1행"은 사실 `'012345'`가 숫자 캐스팅으로 **잘못 매칭된 행**이었고, 문자열 `'12345'`로 고치자 정확히 0행이 나왔습니다. 형변환은 느린 것보다 틀린 게 진짜 문제라는 걸 진단 도구가 스스로 보여준 셈입니다.

## 27. "실제 실행"이라는 위험 앞에서 안전을 먼저 설계한다

여기서 심층 진단은 기존 explain과 결정적으로 다릅니다. EXPLAIN ANALYZE는 이름 그대로 **쿼리를 실제로 실행합니다.** 10분짜리 쿼리를 진단하겠다고 던지면 대상 DB에서 10분을 실제로 돕니다. 진단 도구가 부하 유발자가 됩니다.

그래서 안전장치를 기능보다 먼저 설계했습니다:

- **SELECT 전용**. DML은 실행 자체가 대상 변경이라 입구에서 거부합니다
- **타임아웃**. 기종별 수단으로 실행 시간에 상한을 둡니다(예: PG는 statement_timeout). 실측으로 `pg_sleep` 쿼리가 10초에 취소되는 것까지 확인했습니다
- **ADMIN 경계**. 조회·EXPLAIN(추정)은 VIEWER부터지만, 이건 대상에서 워크로드를 실제로 돌리는 행위라 "실행하는 행위는 ADMIN"이라는 3편의 인가 원칙에 따라 ADMIN 전용으로 올렸습니다

"진단은 읽기니까 안전하다"는 통념이 여기서는 성립하지 않습니다. 실제 실행은 읽기여도 부하입니다. 이 인식이 다음 편의 주제(분석 보호장치)로 이어집니다.

## 28. 마치며, 읽기만 하는 자율과 진단의 마지막 층

이번 편으로 진단 스택이 한 줄로 이어졌습니다. **어느 인스턴스가 나쁜가**(헬스 스코어) -> **어느 쿼리가 문제인가**(시점 비교·이상 감지) -> **계획이 왜 나쁜가**(explain + 규칙) -> **옵티마이저는 왜 속았나**(추정 vs 실제 괴리) -> **무엇을 고치면 되나**(근본 원인 5종 + 처방).

그리고 전부 **읽고, 판단하고, 알려줄 뿐** 대상 DB를 건드리지 않습니다. 이상을 감지해도 쿼리를 죽이지 않고, 미사용 인덱스를 찾아도 지우지 않고, SLO가 EXHAUSTED여도 스로틀하지 않습니다. pganalyze가 "AI-assisted but developer-driven"이라고 부르는 그 선입니다. 구현 비용도 한결같았습니다. 여덟 축과 심층 진단 전부가 `DbmsOperator` 메서드 1개 추가(latencyPercentiles·partitions·indexUsage·explainAnalyze) 또는 기존 재사용으로 5기종을 통합했습니다. 1편에서 그은 추상화 경계가 가장 기종 의존적인 기능에서도 버틴 것입니다.

코드와 실측 기록 전체는 [GitHub](https://github.com/dj258255/dbtower)에 있습니다.

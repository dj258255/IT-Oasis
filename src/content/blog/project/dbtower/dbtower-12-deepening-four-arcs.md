---
title: 'v1.0.0 뒤에 더 깊이 — 다섯 기종을 파고든 네 개의 심화 아크 (합본)'
titleEn: 'Deeper After v1.0.0: Four Deepening Arcs Across Five Engines (Omnibus)'
description: "이기종 DBMS 운영 관리 플랫폼 DBTower 12편. 만들 만큼 만들었다 싶었는데 쓰다 보니 필요한 게 계속 보여서, 남겨둔 숙제를 붙잡고 다시 파고든 네 개의 심화 아크를 한 편에 전문 그대로 담았습니다. 아크 1 — 실행계획 변경(plan flip) 감지를 PostgreSQL만 되던 것에서 다섯 기종으로 완성: 계획 형태를 얻는 경로가 기종마다 전혀 달라(MySQL 리터럴 샘플 재EXPLAIN, SQL Server Query Store, Oracle plan_hash_value, Mongo 프로파일러 명령) shape 정규화 한 겹으로 통일하고, 덤으로 PG 복제 슬롯 감시와 블로트 신호까지. 아크 2 — p95의 정직 등급 올리기: 누적을 최근 구간으로(0.48→0.19), 미지원을 추정으로, 프로파일러가 꺼져도 인스턴스 p95를 살리고, 못 올리는 Oracle은 그대로 두어 라벨로 대비. 라이브에서 2^64 센티넬 오버플로와 최소권한 조용한 폴백 버그를 잡음. 아크 3 — 설정 변경 0으로 데드락 읽기: 세 기종의 관측 입도가 다르고, 조사와 정반대로 데드락이 파일이 아니라 링버퍼에만 있던 현실. 아크 4 — 관제가 부하가 되지 않게 하는 스케일 제어 다섯 축(병렬 수집·풀 분리·알림 폭주 제어·격리 토글·스코어 캐시)."
descriptionEn: "Part 12 of DBTower. I thought I had built enough — then real use kept surfacing needs, so I went back to the homework I had left and dug deeper — four deepening arcs, collected here in full. Arc 1: completing plan-flip detection from PostgreSQL-only to all five engines, where the path to obtain a plan shape differs wildly per engine and a single shape-normalization layer unifies them, plus PG replication-slot and bloat signals. Arc 2: raising p95's honesty grade — cumulative to recent-window (0.48 to 0.19), unsupported to estimated, keeping an instance p95 alive with the profiler off, leaving Oracle unraised so labels contrast — with real bugs caught live (a 2^64 sentinel overflow, a least-privilege silent fallback). Arc 3: reading deadlocks with zero config change across three engines of different granularity, where the deadlock lived in the ring buffer, not the file — the opposite of the research. Arc 4: five axes of scale control so the watchtower never becomes the load."
date: 2026-07-07
tags:
  - Java
  - Spring Boot
  - DBRE
  - Query Optimization
  - Observability
  - MySQL
  - SQL Server
  - Oracle
  - MongoDB
category: personal/DBTower
coverImage: /uploads/project/dbtower/cover.svg
draft: false
series: "DBTower"
seriesOrder: 12
---

앞 편까지로 만들 만큼 만들었다 싶었는데, 정직하게 남겨둔 숙제가 있었고 쓰다 보니 필요한 게 계속 보였습니다. 그래서 그 숙제를 붙잡고 다시 파고들었어요. 결과가 **네 개의 심화 아크**입니다. 원래 네 편의 글이었지만 하나의 흐름이라 한 편에 **전문 그대로** 묶습니다 — 관통하는 태도는 같습니다. 못 하는 걸 하는 척하지 않고, 아는 만큼만 정직하게 말하되, 그 아는 것을 라이브로 확인한다.

- **아크 1** — 플랜 플립 감지를 다섯 기종으로 완성 (+ PG 슬롯·블로트)
- **아크 2** — 다섯 p95의 정직 등급을 올리다
- **아크 3** — 설정 변경 0으로 데드락을 읽다
- **아크 4** — 관제가 부하가 되지 않게 (스케일 제어)

---

## 아크 1 — 하나의 기능을 다섯 기종으로: 플랜 플립 완성

### 0. 들어가며 — 반쪽짜리로 남겨둔 기능

[11편](/blog/project/dbtower/dbtower-11-deepening)에서 실행계획 변경(plan flip) 감지를 만들었어요. "쿼리도 데이터도 그대로인데 갑자기 느려짐 = 옵티마이저가 계획을 갈아탐"을 잡는 기능인데, 그때 정직하게 적어둔 한계가 있었습니다 — **PostgreSQL만 완전하다.**

이유는 그 편에서 밟은 벽 그대로예요. 통계 소스의 쿼리 텍스트는 리터럴이 지워진 정규화 형태($1·?)라 그대로 EXPLAIN이 안 되는데, PostgreSQL 16의 `EXPLAIN (GENERIC_PLAN)`이 그걸 정확히 풀어주는 유일한 기능이었죠. 나머지 네 기종은 "플레이스홀더 텍스트는 스킵"하고 넘어갔습니다.

그런데 이 프로젝트를 관통한 원칙이 "새 기능 = 다섯 기종에서 동작"이었어요. 반쪽짜리로 두면 정체성에 흠집입니다. 그래서 다섯 기종 리서치를 돌려([이전 편의 심화 조사](/blog/project/dbtower/dbtower-0-overview)) 각 기종이 "정규화 쿼리로 계획을 얻는 길"을 찾았고, 이번 편은 그 길이 **기종마다 전혀 다르다**는 걸 하나씩 잇는 이야기입니다.

### 1. 설계 — 획득은 기종이, 판정은 공통이

11편의 트래커는 `explainNormalized(text)`를 직접 부르고 그 결과를 shape로 정규화했어요. PG 전용 구조였죠. 다섯 기종으로 넓히면서 경계를 다시 그었습니다.

`DbmsOperator`에 메서드 하나를 추가했어요:

```java
// 정규화 쿼리($1·?)의 실행계획 "형태(shape)"를 기종별 최선 경로로 얻는다.
// 얻을 수 없으면 empty — 지어내지 않는다.
default Optional<String> planShapeForDigest(String queryId, String queryText) {
    return Optional.empty();  // 기본은 미지원
}
```

이제 트래커는 **엔진을 모릅니다.** "이 쿼리의 shape를 다오 → 지난번과 다른가?"만 판정하고, 계획을 어떻게 얻고 어떻게 정규화하는지는 전부 각 Operator가 책임집니다. 1편에서 "추상화 경계는 SQL이 아니라 운영 행위에 긋는다"고 했던 그 원칙이, 가장 기종 의존적인 이 기능에서도 그대로 작동한 거예요.

shape 정규화는 `PlanShapes`라는 유틸 한 곳에 기종별 메서드로 모았습니다. 계획 표현이 기종마다 JSON·XML·해시로 제각각이라, 그 포맷 지식을 한 파일에 가둔 거죠. (이걸 만들다 모듈 순환을 한 번 밟았어요 — 처음엔 alert 모듈에 뒀는데, operator가 이걸 참조하면서 operator↔alert 순환이 생겨 Spring Modulith 빌드가 실패했습니다. shape는 Operator가 만드는 도구이니 operator 모듈로 옮겨 해소했어요. [3편](/blog/project/dbtower/dbtower-6-wait-events-and-right-tool)의 "경계는 빌드가 지킨다"가 또 한 번 배당금을 준 셈입니다.)

### 2. 다섯 개의 다른 길

같은 "계획의 형태"를 얻는 경로가 정말 다섯 갈래로 갈라졌어요.

| 기종 | 획득 경로 | 특이점 |
|---|---|---|
| PostgreSQL | `EXPLAIN (GENERIC_PLAN)` | 11편의 그 기능 — 플레이스홀더 채로 제네릭 플랜 |
| MySQL | `QUERY_SAMPLE_TEXT` → `EXPLAIN FORMAT=JSON` | performance_schema가 저장한 **리터럴 샘플**을 재-explain |
| SQL Server | `sys.query_store_plan` 이력 | Query Store가 축출 없이 보존 — 계획을 다시 안 떠도 됨(NATIVE) |
| Oracle | `v$sqlstats.plan_hash_value` | **plan_hash_value가 곧 계획 식별자** — 정규화조차 불필요 |
| MongoDB | `system.profile` 샘플 명령 → `explain` | 프로파일러가 저장한 실제 명령을 재실행 |

**MySQL — 서버가 이미 답을 갖고 있었다.** MySQL엔 PG의 GENERIC_PLAN 같은 게 없어요(있는지 문서를 뒤졌지만 없었습니다). 대신 performance_schema가 digest마다 **실제로 실행됐던 리터럴 쿼리 샘플**(`QUERY_SAMPLE_TEXT`)을 저장해 둡니다. 정규화 텍스트 대신 이 샘플을 EXPLAIN하면 되죠 — Datadog DBM이 쓰는 방식과 같습니다. 함정은 샘플이 `max_sql_text_length`(기본 1024B)에서 잘릴 수 있다는 것. 잘린 SQL은 EXPLAIN 문법 오류가 나므로, 실패하면 지어내지 않고 스킵합니다.

**SQL Server — 이력이 이미 거기 있었다.** 이건 심지어 계획을 다시 뜰 필요도 없었어요. Query Store는 `query_id`당 여러 `plan_id`를 **이력으로 보존**합니다(플랜 캐시와 달리 축출로 사라지지 않아요). query_hash로 최신 plan을 읽으면 그게 곧 현재 계획 — 가장 NATIVE한 경로입니다. 다만 "있으면 쓴다" 게이트가 필요했어요. Query Store는 켜져 있어야 하고(2022는 신규 DB 기본 ON, 하지만 시스템 DB나 복원된 DB는 OFF), **우리가 켜는 건 대상 변경이라 안 합니다.** 꺼져 있으면 정직하게 스킵. 덤으로 `is_forced_plan`도 읽어서 "누군가 플랜을 강제한 상태"를 `[FORCED]`로 표기합니다(강제 실행 자체는 안 하고 관측만).

**Oracle — 해시가 곧 정체성.** Oracle의 `v$sqlstats`는 (sql_id, plan_hash_value)당 한 행이에요. 즉 plan_hash_value가 바뀌면 계획이 바뀐 겁니다. shape 정규화조차 필요 없이 `PHV:591542025` 같은 문자열이 곧 형태 식별자죠. 라이선스도 확인했어요 — Oracle의 진단 기능 상당수가 유료 Diagnostics Pack인데, `v$sqlstats`는 무료 뷰입니다(팩 대상은 `v$active_session_history`와 `DBA_HIST_*`뿐, 19c 라이선스 매뉴얼로 확인). 유료 뷰를 조회만 해도 라이선스 위반이 되는 함정을 피한 거예요.

**MongoDB — 계획이 SQL이 아니다.** Mongo는 계획이 명령 JSON 기반이라 텍스트 EXPLAIN이 성립하지 않아요. 대신 `system.profile`이 저장한 **실제 명령**을 queryHash로 찾아 `explain`으로 재실행합니다. 함정 하나 — 프로파일러 명령엔 `$db`·`lsid` 같은 세션·라우팅 메타가 섞여 있어 explain 전에 걷어내야 했어요.

### 3. shape — 다섯 포맷을 하나의 비교 가능한 문자열로

계획을 얻었으면 이제 "형태"만 남겨야 합니다. 비용·추정 행수는 통계가 조금만 변해도 흔들려서, 그대로 해시하면 매번 "가짜 변경"이 되거든요. 남길 건 옵티마이저의 실제 선택 — 노드 종류·인덱스·대상뿐입니다.

그런데 계획 표현이 기종마다 완전히 달라요. PG는 JSON 트리, MySQL도 JSON이지만 키가 전혀 다르고(`table`/`access_type`/`key`), SQL Server는 showplan XML, Mongo는 winningPlan JSON. `PlanShapes`가 이 넷을 각각 파싱해 같은 모양의 shape 문자열로 뽑습니다:

```
PG:     Seq Scan(orders) / Nested Loop>[Seq Scan(a),Index Scan(idx_b)]
MySQL:  ALL(products)  vs  ref(products:idx_code)
MSSQL:  Clustered Index Scan(PK_t)  vs  Index Seek(idx_code)
Mongo:  COLLSCAN  vs  FETCH>[IXSCAN(idx_k)]
Oracle: PHV:591542025   (이미 식별자)
```

이 정규화의 정확성 — "같은 구조 다른 추정치 = 같은 shape, 인덱스가 바뀌면 다른 shape" — 을 기종별로 단위 테스트 12건에 고정했어요. shape가 한 번 틀리면 진짜 플립을 놓치거나 가짜 플립을 만드니, 여기가 이 기능의 심장입니다.

### 4. 라이브 — 획득 체인이 진짜 도는가

여기서 정직하게 범위를 나눠 씁니다. **"계획 형태를 얻어서 이전과 비교해 플립을 알린다"는 판정 로직 자체는 11편(PostgreSQL)에서 이미 완전한 before/after로 검증됐습니다** — Index Only Scan이 Seq Scan으로 갈아탄 순간을 알림으로 잡았죠. 이번 편의 새로운 부분은 그 판정에 먹일 **계획 형태를 각 기종에서 실제로 뽑아내는 `planShapeForDigest`** 입니다. 그래서 12편의 실측 초점은 "이 획득 체인이 라이브로 도는가"예요.

가장 다른 두 경로를 실제로 돌렸습니다.

**MySQL** — 회귀가 뜬 products 쿼리(`WHERE code = ?`)에 대해, 트래커가 `performance_schema`의 `QUERY_SAMPLE_TEXT`를 꺼내 `EXPLAIN FORMAT=JSON`을 돌리고 shape `ALL(products)`를 실제로 저장하는 것을 확인했습니다(09:44:56). 샘플 텍스트 조회 → EXPLAIN → `fromMysqlJson` → 저장으로 이어지는 체인이 라이브로 동작한 거죠. 덤으로, DBTower가 자기 자신을 감시하다 회귀가 난 내부 쿼리도 `ALL(events_statements_summary_by_digest)`로 계획추적되면서 같은 체인을 한 번 더 밟았습니다.

정직하게 덧붙이면, 압축된 데모 안에서 **단일 기종의 완전한 before(ref) → after(ALL) 플립 한 쌍**을 깔끔하게 재현하진 못했습니다. 계획추적 트리거가 레이턴시·행수 회귀에 묶여 있어서, 안정적으로 터지는 방향이 "인덱스 드랍으로 스캔 행수가 급증하는" 한 방향뿐이었거든요 — 반대 방향(빠른 ref 기준선)을 먼저 확보하려면 또 다른 회귀를 정확한 타이밍에 유발해야 하는 catch-22였습니다. 이건 코드 결함이 아니라 몇 분짜리 데모 부하로는 두 방향 회귀를 순서대로 만들기 어렵다는 조건의 문제이고, 기준선 저장(`ALL(products)` 실저장)까지는 라이브로 도달했습니다. 플립 비교 로직 자체는 PG로 이미 증명됐으니, 남은 건 "형태를 뽑는 손"이 각 기종에서 도느냐였고 그건 확인됐습니다.

**SQL Server** — Query Store를 켠 사용자 DB를 등록하고, `planShapeForDigest`가 쓰는 획득 SQL(`query_hash` → `sys.query_store_plan` → showplan XML)을 직접 실행해 실제 showplan XML이 돌아오는 것을 확인했습니다. 축출 없이 보존되는 계획 이력을 그대로 읽는 NATIVE 경로가 살아 있다는 실측이에요.

Oracle과 MongoDB는 획득 경로를 라이브로 확인했어요 — Oracle은 `v$sqlstats`에서 plan_hash_value가 조회되는 것(무료 뷰), MongoDB는 프로파일러 레벨 2에서 `system.profile`에 queryHash가 쌓이는 것. 그리고 정직한 실측 하나 — 데모의 `local-mssql`은 시스템 DB(master)에 붙어 Query Store가 없는데, 이때 **게이트가 조용히 스킵**하는 것까지 확인했습니다. "켜져 있으면 쓰고 아니면 스킵"이 실제로 그렇게 도는 거죠.

### 5. 덤으로 판 두 삽 — 슬롯 감시와 블로트

같은 조사에서 나온 PostgreSQL 저비용·고가치 두 개도 함께 넣었어요.

**복제 슬롯 잔량 감시.** PG 운영 최빈 사고 중에 "비활성 복제 슬롯이 WAL을 무한 보존해 디스크를 꽉 채워 DB가 죽는" 게 있습니다. 그런데 지금까지 우리는 `pg_stat_replication`(연결된 복제만)만 봐서 이 사각이 완전히 비어 있었어요. `pg_replication_slots` 하나를 읽는 걸로 채웠습니다 — `wal_status='lost'`면 이미 슬롯 무효, `unreserved`면 직전 경고, 비활성 슬롯이 임계 이상 WAL을 붙잡으면 디스크 고갈 경보. SELECT 한 번이 대표 장애 하나를 막는 거예요.

![복제 슬롯 감시 — 비활성 슬롯이 붙잡은 WAL 보존량, pg_stat_replication이 못 보는 사각](/uploads/project/dbtower/replication-slots.png)

**블로트/통계 노후 신호.** autovacuum이 죽은 튜플을 못 따라가면 테이블이 부풀어 느려지는데, 이 신호가 Advisors에 통째로 없었어요. 재밌는 건 재료가 **이미 읽던 뷰의 안 쓰던 컬럼**이었다는 것 — `pg_stat_user_tables`의 `n_dead_tup`·`last_autovacuum`·`n_mod_since_analyze`. dead ratio가 임계를 넘으면 블로트 후보로 올립니다. 단 이건 통계 추정치라 "삭제 근거"가 아니라 "VACUUM을 점검하라"는 신호로 정직하게 표기했어요.

여기서 실측 중 웃긴 일이 있었어요. 블로트를 만들려고 대량 UPDATE를 했는데 Advisor가 0건을 냈습니다 — **autovacuum이 이미 청소해버린** 거예요. 감지기가 안 도는 게 아니라, PostgreSQL의 autovacuum이 정상 작동하고 있다는 실측이었죠. 그래서 데모 테이블만 autovacuum을 꺼서 죽은 튜플을 남기니 정확히 잡혔습니다.

![블로트 Advisor — 죽은 튜플 비율과 '추정치 — 실측 아님' 정직 표기](/uploads/project/dbtower/bloat-advisor.png)

### 6. 마치며 — 반쪽을 온전하게

이번 편으로 플랜 플립의 계획 획득 경로가 다섯 기종 모두에 생겼고, 그 앞의 플립 판정은 11편에서 PG로 이미 검증된 공통 로직을 그대로 씁니다 — 획득만 채우면 다섯 기종이 같은 판정으로 흐르는 구조죠. 돌아보면 이 작업의 배움은 "다섯 기종 지원"이라는 결과보다 **다섯 개의 서로 다른 길을 하나의 경계 뒤로 숨긴 방법**에 있었습니다. GENERIC_PLAN·리터럴 샘플·Query Store 이력·plan_hash_value·프로파일러 명령 — 공통점이 하나도 없는 다섯 획득 경로가 `planShapeForDigest` 메서드 시그니처 하나 뒤로 들어갔고, 그 앞의 트래커는 다섯 기종을 하나처럼 다룹니다.

그리고 이번에도 정직한 잔여를 남깁니다 — MySQL 샘플 기반 계획은 특정 파라미터 값의 플랜이라 그 digest의 대표 플랜과 다를 수 있고, Oracle의 plan_hash_value는 shared pool에서 age-out되면 과거 계획 본문을 못 봅니다(그래서 우리 스냅샷이 이력의 단일 출처예요). 다음에 팔 곳의 지도죠.

코드와 실측 기록 전체는 [GitHub](https://github.com/dj258255/dbtower)에 있습니다.

---

## 아크 2 — 정직 등급을 올리는 법: 다섯 p95의 다섯 사다리

### 0. 들어가며 — 값은 다 냈는데, 등급이 낮았다

앞선 편에서 레이턴시 백분위(p95/p99)를 다섯 기종에서 뽑았습니다. 겉으로는 표가 다 채워졌죠. 그런데 그 표에는 불편한 진실이 하나 있었어요 — **채워진 값들의 신뢰 등급이 제각각**이라는 것.

- MySQL의 p95는 DB가 직접 계산해주는 진짜 분위수지만, **리셋 이후 누적**이라 오래 뜬 서버일수록 과거에 눌려 "지금 막 느려진" 걸 늦게 반영합니다.
- SQL Server와 Oracle은 아예 **미지원**. 통계 뷰가 min/max/평균/총계만 주고 분위수도 표준편차도 안 주니까요.
- PostgreSQL은 평균+표준편차로 근사한 **추정치**. 실제 레이턴시 분포는 꼬리가 무거워서 이 근사는 대개 과소평가합니다.

그래서 이번 편의 목표는 "값을 더 내자"가 아닙니다. **이미 있는 값의 정직 등급을 한 칸씩 올리자**예요. 그리고 못 올리는 자리는 못 올린 채로 정직하게 남기자.

### 1. 라벨이 곧 계약이다

이 기능의 처음부터 지켜온 원칙이 있습니다 — **값을 절대 섞지 않는다.** 추정치를 실측인 척, 미지원을 지원하는 척하는 순간 이 기능은 거짓말이 됩니다. 그래서 값마다 그게 어디서 왔는지를 `source`로 못 박습니다. 기존엔 네 종류였어요.

`NATIVE`(누적 실측) · `COMPUTED`(원샘플 직접계산) · `ESTIMATED`(평균+표준편차 추정) · `UNSUPPORTED`(원자료 없음).

이번에 두 종류를 새로 팠습니다.

- **`NATIVE_WINDOWED`** — 누적 히스토그램을 직전 스냅샷과 버킷별로 차분해 복원한 "최근 구간" p95. 누적(NATIVE)과 달리 과거에 안 눌립니다. 단, 버킷 상한을 p95로 쓰는 **상한 근사**라 그 사실을 라벨에 새깁니다.
- **`NATIVE_HISTOGRAM`** — DB가 주는 히스토그램 버킷을 보간해 얻은 p95. 쿼리 단위가 아니라 인스턴스/컬렉션 단위일 수 있어 그 범위를 함께 표기합니다.

라벨을 늘린 건 멋있어 보이려는 게 아닙니다. "이 p95가 최근을 반영하나?", "쿼리별인가 인스턴스별인가?", "실측인가 추정인가?" — 이 질문들에 **값이 스스로 답하게** 하려는 겁니다.

### 2. 다섯 사다리

기종마다 원자료가 다르니 등급을 올리는 사다리도 다섯 개가 다 달랐습니다.

#### MySQL — 누적을 최근 구간으로 (NATIVE_WINDOWED)

MySQL은 `events_statements_histogram_by_digest`에 digest당 450개 버킷의 히스토그램을 둡니다. 문제는 이것도 **재기동 이후 누적**이라는 것. 그런데 누적이라는 성질이 오히려 열쇠였어요 — **두 시점의 스냅샷을 버킷별로 빼면 그 사이 구간의 분포**가 됩니다. 거기서 누적 95%가 넘어가는 버킷의 상한(`BUCKET_TIMER_HIGH`)을 구간 p95로 씁니다.

여기엔 유혹이 하나 있습니다. `TRUNCATE`로 히스토그램을 리셋하면 즉시 깨끗한 최근 창을 얻죠. 하지만 그건 대상 DB의 상태를 바꾸는 행위 — DBTower의 "읽고 판단만" 정체성을 깨는 겁니다. **차분 방식이 바로 그 금지의 대안**이에요. 남의 통계를 건드리지 않고, 내 스냅샷 두 장으로 최근을 복원합니다.

Operator는 매 호출 새로 생성되는(상태 없는) 설계라, 직전 스냅샷은 싱글턴 빈(`HistogramSnapshotStore`)에 보관합니다. 여기서 "구간"은 곧 연속한 두 조회 사이예요 — 폴러 주기면 그 주기, 온디맨드면 "마지막으로 본 이후".

#### SQL Server — 미지원을 풀다 (ESTIMATED)

SQL Server는 그동안 정직하게 `UNSUPPORTED`였습니다. 하지만 **Query Store가 켜진 DB**라면 얘기가 달라져요. `query_store_runtime_stats`에 평균과 표준편차가 있거든요. 그럼 PostgreSQL과 똑같은 규약(avg + 1.645×stdev)으로 추정치를 낼 수 있습니다 — 단, 관측된 최대값(max)으로 캡을 씌워서 추정이 실제 최댓값을 넘지 않게.

함정이 하나 있었어요. 활성 interval의 통계는 plan × execution_type별로 여러 행(in-memory + flushed)으로 나뉩니다. 그냥 평균 내면 틀려요. `count_executions`로 가중 재집계해야 맞습니다. 그리고 Query Store가 꺼진 DB(시스템 DB인 master 등)에서는? **게이트가 조용히 UNSUPPORTED로 떨어집니다.** 켜는 행위(`ALTER DATABASE`)는 절대 하지 않아요 — 그건 남의 설정을 바꾸는 거니까.

#### MongoDB — 프로파일러가 꺼져도 (NATIVE_HISTOGRAM)

기존 Mongo p95는 `system.profile`의 원샘플에서 직접 계산(COMPUTED)했습니다. 문제는 **프로파일러가 꺼진 인스턴스에선 이게 전멸**한다는 것. 그런데 MongoDB는 `serverStatus.opLatencies`에 reads/writes/commands별 히스토그램을 **프로파일러와 무관하게** 항상 기록합니다. 이걸 스냅샷 차분 후 보간하면, 프로파일러가 꺼져 있어도 인스턴스 층위의 p95가 나와요. 기존 COMPUTED(쿼리 단위)는 그대로 병행하고요.

#### PostgreSQL — "있으면 승격", Oracle — 못 올린 자리

PostgreSQL은 확장 `pg_stat_monitor`가 **설치돼 있으면** 그 히스토그램(resp_calls)으로 승격하고, 없으면 기존 추정치를 그대로 씁니다. HypoPG나 SQL Server Query Store에서 이미 쓰던 "있으면 쓰고 아니면 게이트" 패턴이죠.

그리고 **Oracle은 끝내 못 올렸습니다.** `v$sqlstats`에 분위수도, 표준편차도, 히스토그램도 없어요. 근사할 원자료 자체가 없습니다. 그래서 `UNSUPPORTED`로 남겼습니다 — 이게 이번 아크의 **정직성 대비군**이에요. 넷은 올리고 하나는 못 올린 걸 라벨이 정직하게 가릅니다.

### 3. 라이브 — 그리고 진짜 버그 두 개

단위 테스트(30건 추가)가 다 초록이어도, 진짜 검증은 라이브입니다. 그리고 라이브에서만 잡히는 버그가 있었어요.

**MySQL 구간 p95**부터. 첫 호출은 직전 스냅샷이 없어 "구간 학습 중"으로 누적값을 보여주고, 부하를 준 뒤 두 번째 호출에서 최근 구간이 나옵니다. 결과가 이 아크의 논지를 한 줄로 압축했어요 — 같은 `products` 쿼리가 **누적 p95=0.48 → 구간 p95=0.19**. 최근 부하가 빠른 인덱스 조회라, 과거에 눌린 누적보다 구간이 낮게 나온 겁니다. "지금 이 순간"을 본다는 게 이런 거죠.

![MySQL 레이턴시 카드 — 실측구간(NATIVE_WINDOWED)과 실측누적 폴백이 라벨로 공존](/uploads/project/dbtower/latency-windowed.png)

그런데 처음엔 모든 행이 "히스토그램 미수집 — 누적값"으로 폴백됐습니다. 제 코드가 히스토그램 조회 실패를 **조용히 삼키고** 있었거든요. 원인을 드러내려고 그 자리에 경고 로그를 심었더니 — 진짜 버그가 튀어나왔어요.

```
Value '18446744073709551615' is outside of valid range for type java.lang.Long
```

`18446744073709551615` = 2^64 − 1. MySQL 히스토그램의 **마지막 버킷 상한이 unsigned bigint 최댓값(무한대 센티넬)**인데, JDBC `getLong()`은 signed long이라 오버플로로 터진 겁니다. 단위 테스트의 합성 버킷엔 이 센티넬이 없었으니, 라이브가 아니면 절대 못 잡았을 버그예요. `BigDecimal`로 받아 해결했습니다.

버그가 하나 더 있었습니다. 모니터링 계정 `dbtower_monitor`가 `events_statements_summary_by_digest`(요약 뷰) 권한만 있고 **히스토그램 뷰 권한이 없었어요.** 그래서 조회가 Access Denied로 실패하고 — 제 코드가 정직하게 누적값으로 폴백한 겁니다. 이건 사실 설계의 승리이기도 해요. 크래시 대신 "이 권한에선 구간을 못 만든다"를 **값으로 표현**했으니까. 새 기능은 새 권한을 요구하고, 그건 최소권한 문서에 명시할 대상이죠. 뷰 읽기 권한(읽기 전용)을 추가하니 곧바로 구간 p95가 나왔습니다.

**MongoDB의 핵심 검증**은 프로파일러를 끄고 보는 거였어요. 프로파일러 레벨을 0으로 내리고 `system.profile`을 비운 뒤 부하를 주니 — **COMPUTED는 완전히 사라졌지만(0건), 인스턴스 히스토그램 p95는 살아남았습니다**(reads 3.78ms, commands 3.02ms). 프로파일러가 꺼진 인스턴스에서 이게 유일한 레이턴시 관측이 된다는 것, 그게 이 축의 존재 이유입니다.

![Mongo 레이턴시 카드 — 히스토그램(프로파일러 무관)과 직접계산이 함께](/uploads/project/dbtower/latency-histogram.png)

(솔직한 뒷이야기 하나. 이 Mongo 검증의 첫 시도는 제가 잘못된 비밀번호를 써서 부하 주입과 프로파일러 끄기가 **조용히 실패**했었습니다. COMPUTED가 안 사라진 걸 보고 "어? 프로파일러가 안 꺼졌나?" 확인하다 발견했죠. 올바른 자격증명으로 다시 검증했습니다 — 안 되는 걸 되는 것처럼 기록하지 않으려고.)

**SQL Server**는 두 방향을 다 봤어요. 시스템 DB인 master는 Query Store가 없어 UNSUPPORTED 게이트로 정직하게 스킵. Query Store를 켠 사용자 DB를 등록하니 미지원이 풀리고 추정치가 나왔습니다(join p95=0.73ms 등).

![MSSQL 레이턴시 카드 — Query Store가 켜지자 미지원이 추정으로 풀렸다](/uploads/project/dbtower/latency-estimated.png)

### 4. 마치며 — 올린 것과 못 올린 것

이번 편의 배움은 "p95를 더 정확하게"가 아니라 **"값의 정직 등급을 어떻게 표현하는가"**에 있었습니다. 같은 레이턴시 카드 안에서 이제 여섯 개의 배지가 갈립니다 — 실측누적·실측구간·히스토그램·직접계산·추정·미지원. 각 배지는 그 숫자가 얼마나 믿을 만한지, 무엇을 보고 무엇을 못 보는지를 한눈에 말해줍니다.

그리고 정직한 잔여를 남깁니다. NATIVE_WINDOWED의 "구간"은 두 조회 사이라 조회가 뜸하면 창이 길어지고, 버킷 상한 근사라 정확한 분위수는 아닙니다. Oracle은 여전히 못 올린 자리예요 — 원자료가 생기지 않는 한 UNSUPPORTED로 남습니다. 이걸 감추지 않는 게 이 기능의 값을 지키는 유일한 길이라고 생각합니다.

다섯 기종에 다섯 개의 사다리를 놓았지만, 하나는 사다리를 못 놓았습니다. 그 사실을 라벨로 정직하게 말하는 것 — 그게 이 아크의 진짜 결과입니다.

코드와 실측 기록 전체는 [GitHub](https://github.com/dj258255/dbtower)에 있습니다.

---

## 아크 3 — 설정 변경 0으로 데드락을 읽다: 세 기종, 세 입도

### 0. 들어가며 — 스스로 낫는데, 왜 봐야 하나

데드락은 묘한 사고입니다. 두 트랜잭션이 서로가 쥔 락을 기다리며 영원히 멈출 것 같지만, DB가 순환 대기를 감지하고 한쪽을 victim으로 골라 롤백합니다. **자체 회복되는 거죠.** 그런데도 봐야 하는 이유는, 롤백된 쪽이 애플리케이션에는 에러(`Deadlock found`, `1205`)로 튀고, 이게 **반복되면 코드의 락 순서가 잘못됐다는 신호**이기 때문입니다.

원칙은 이번에도 같습니다 — **읽고 판단만.** 데드락을 잡겠다고 대상 DB의 확장 이벤트 세션을 새로 켜거나(`ALTER EVENT SESSION`) 설정을 바꾸면 안 됩니다. 다행히 세 기종 모두 데드락의 흔적을 **이미** 남깁니다. 그걸 설정 변경 0으로 읽는 게 이번 아크입니다.

문제는, 그 흔적의 **입도(granularity)가 기종마다 근본적으로 다르다**는 것이었습니다.

### 1. 세 개의 다른 입도

- **SQL Server** — `system_health` 확장 이벤트 세션이 (기본으로 켜진 채) 데드락마다 `xml_deadlock_report`를 남깁니다. victim, 관여한 모든 프로세스의 입력 SQL, 경합한 락 리소스까지 XML로. **가장 풍부합니다.** 여러 건을 읽을 수 있죠.
- **MySQL** — `SHOW ENGINE INNODB STATUS` 출력의 "LATEST DETECTED DEADLOCK" 섹션. 이름 그대로 **가장 최근 1건**만. 그 이전 데드락은 덮여 사라집니다.
- **PostgreSQL** — 개별 데드락 리포트가 뷰에 없습니다. 로그에는 남지만, 통계 뷰에는 `pg_stat_database.deadlocks`라는 **누적 카운터**뿐이에요.

이 차이는 억지로 통일할 수 없습니다. 그래서 축을 둘로 갈랐어요. **MSSQL·MySQL은 `recentDeadlocks()`가 리포트 목록을 반환**하고, **PG는 개별 사건이 없으니 카운터 델타 알림**으로. 공용 레코드 `DeadlockEvent(발생시각·문장들·victim·리소스·source)`에 담되, PG는 이 레코드 대신 카운터를 씁니다. 같은 축을 기종 현실에 맞게 두 갈래로 다룬 거죠.

### 2. 세 경로

**SQL Server** — `sys.fn_xe_file_target_read_file`로 `.xel` 파일에서 `xml_deadlock_report`를 읽어 DOM 파싱합니다. victim-list의 프로세스 id로 어느 쪽이 롤백됐는지 가르고, 각 프로세스의 `inputbuf`에서 SQL을, resource-list에서 경합 객체·인덱스를 뽑습니다. 외부 XML 라이브러리 없이 표준 `javax.xml`만 씁니다(11편의 showplan 파싱과 같은 도구).

**MySQL** — `SHOW ENGINE INNODB STATUS`의 거대한 텍스트(최대 1MB)에서 "LATEST DETECTED DEADLOCK" 블록을 잘라, 두 트랜잭션의 SQL과 `WE ROLL BACK TRANSACTION (N)`의 N번(victim), 경합 인덱스·테이블을 정규식으로 추출합니다. 최대 1건이라는 한계를 응답에 정직하게 답니다.

**PostgreSQL** — `pg_stat_database.deadlocks`의 누적값을 읽고, OpsAlert가 폴 사이 **델타**를 봅니다. 늘었으면 "새 데드락 N건". 단, 첫 관측(직전 값 없음)이나 카운터 감소(통계 리셋)는 알리지 않습니다 — 과거분을 새 사건으로 오인하지 않으려고요.

### 3. 라이브 — 조사와 정반대였던 현실

이 아크의 하이라이트는 SQL Server에서 나왔습니다.

착수 조사 때 "ring_buffer 타깃은 SQL Server 2022에서 `xml_deadlock_report`를 빈 결과로 준다"는 사례를 읽었습니다. 그래서 **파일 타깃으로 고정**했죠. 코드도 그렇게 짰고요.

그런데 실제로 두 세션을 크로스 락으로 데드락시키고(Process 65가 victim으로 롤백, `Msg 1205`) 조회했더니 — **빈 배열**이 돌아왔습니다. 파일 타깃을 직접 세어보니 `xml_deadlock_report` 0건. 그런데 인메모리 링버퍼를 세어보니 **1건**. 조사와 **정반대**였어요. 이 컨테이너(SQL Server 2022 Linux)에서는 방금 발생한 데드락이 **링버퍼엔 즉시 있지만 `.xel` 파일에는 아직 flush되지 않은** 것이었습니다.

정답은 "둘 중 뭘 믿을까"가 아니라 **"둘 다 읽고 내용으로 중복 제거"**였습니다. 파일 타깃(과거 롤오버 포함)과 링버퍼(가장 최근)를 모두 읽어, 시각·victim·리소스로 dedup. 어느 한쪽의 한계(파일은 flush 지연, 링버퍼는 용량 제한)에도 최근 데드락을 놓치지 않게. 고치고 다시 조회하니 정확히 잡혔습니다.

![SQL Server 데드락 카드 — system_health XE에서 victim(spid 65)·경합 PK 인덱스·두 트랜잭션 SQL](/uploads/project/dbtower/deadlock-mssql.png)

MySQL도 같은 방식으로 크로스 락을 걸어 `ERROR 1213`을 유발했고, "LATEST DETECTED DEADLOCK"에서 victim(트랜잭션 2 롤백), 두 UPDATE 문, 경합 리소스(`index PRIMARY of table sample.dl_demo`)를 정확히 파싱했습니다.

![MySQL 데드락 카드 — INNODB STATUS의 최근 1건, victim·PRIMARY 인덱스·문장](/uploads/project/dbtower/deadlock-mysql.png)

PostgreSQL은 같은 크로스 락으로 `deadlock detected`를 유발하니 `pg_stat_database.deadlocks`가 **0에서 1로** 올랐습니다. OpsAlert의 델타 로직(첫 관측은 조용, 증가 시 알림, 반복 억제)은 폴 주기 타이밍에 의존하지 않도록 단위 테스트로 못박았습니다.

### 4. 마치며 — "최근만"이라는 정직

이번에도 배운 건 통일의 방법이 아니라 **차이를 인정하는 방법**이었습니다. 데드락이라는 하나의 축을, 리포트를 주는 두 기종과 카운터만 주는 한 기종으로 갈라 각자의 최선으로 읽었습니다.

그리고 공통의 정직한 한계를 남깁니다 — 세 경로 모두 **롤링/최신 저장**이라 "최근"만 봅니다. MySQL은 아예 1건, MSSQL·PG도 용량 상한이 있어 오래된 데드락은 관측 범위 밖이에요. 과거 전수 이력을 보장하지 않는다는 걸 카드와 응답에 그대로 적었습니다. "지금 막 났고 반복되고 있나"를 보는 데는 충분하고, 그 이상을 보장하는 척하지 않는 게 이 기능의 값을 지키는 길이라고 봤습니다.

조사 문서가 "파일 타깃을 써라"라고 했을 때 그대로 믿고 끝냈다면, 데모에서 데드락이 안 잡히는 걸 "원래 그런가 보다" 하고 넘겼을지도 모릅니다. 라이브로 직접 유발해 보지 않았다면 몰랐을 일이죠 — 실측이 문서를 이깁니다.

코드와 실측 기록 전체는 [GitHub](https://github.com/dj258255/dbtower)에 있습니다.

---

## 아크 4 — 관제가 부하가 되지 않게: 스케일 제어 다섯 축

### 0. 들어가며 — 몇 개일 땐 안 보이던 것들

이 프로젝트에는 처음부터 지켜온 원칙이 하나 있습니다 — **"진단이 부하 유발자가 되면 안 된다."** 대상 DB를 무겁게 조회하지 않고, 죽은 대상을 매 주기 두드리지 않고, 조회에 타임아웃을 건다. 그런데 이 원칙에는 규모의 축이 하나 빠져 있었어요. **관제하는 인스턴스가 많아지면, 관제 플랫폼 자신이 병목이 됩니다.**

인스턴스가 대여섯 개일 땐 안 보이던 것들이 수십 개가 되면 드러납니다.

- **직렬 수집**이 주기를 넘깁니다 — 하나씩 순서대로 훑으면 느린 대상 하나가 뒤 전부를 밀어냅니다.
- **폴러 하나가 느려지면** 뒤에 줄 선 폴러 전부가 밀립니다(Spring 기본 스케줄러는 단일 스레드).
- **대량 장애 때** 알림이 한꺼번에 터져 채널을 도배하고, 정작 중요한 신호가 묻힙니다.
- **대시보드를 열 때마다** 전 인스턴스를 재평가합니다(헬스 스코어는 인스턴스마다 다섯 신호를 모으는 무거운 작업이에요).

이번 아크는 이 넷을 고치고, 하나를 더합니다 — **문제 인스턴스를 잠시 빼는 스위치.**

### 1. 수집을 병렬로, 하지만 노드 안에서만

가장 먼저, 인스턴스별 수집을 고정 크기 워커 풀로 병렬화했습니다. 직렬 for가 워커 4개에 분산되죠. 여기엔 지켜야 할 불변식이 하나 있었습니다 — **ShedLock의 노드 배타.**

DBTower는 HA로 여러 노드를 띄울 수 있고, ShedLock이 "한 시점에 한 노드만 수집한다"를 보장합니다. 병렬화가 이걸 깨면, 여러 노드가 같은 대상 DB를 동시에 두드리게 됩니다. 그래서 **병렬은 "이 노드 안에서만"**입니다. `collect()`는 이번 틱의 모든 워커가 끝날 때까지(`Future.get()`) 기다린 뒤 반환하므로, ShedLock이 잡은 창 안에서 수집이 완료됩니다. 노드 간 배타는 그대로, 노드 안에서만 4배 빨라진 거죠.

한 가지 더 손본 건 백오프 상태였습니다. 연속 실패한 인스턴스를 지수적으로 건너뛰는 A9 백오프 맵이 있는데, 그 값(`int[]`) 갱신이 read-modify-write라 병렬 워커에서 경합할 수 있었어요. 한 틱에선 인스턴스가 서로 달라 같은 상태를 두 워커가 만지지 않지만, 방어적으로 접근을 `synchronized`로 배타화했습니다.

실측에선 인스턴스 14개(같은 컨테이너를 여러 이름으로 등록)를 `dbtower-collect` 워커 스레드들이 나눠 수집해 전체가 1.2초 안에 끝났습니다 — 60초 주기 안에 넉넉히.

### 2. 폴러들이 서로를 막지 않게

Spring의 `@Scheduled`는 **기본이 단일 스레드**입니다. 폴러가 7종(스냅샷·회귀·운영경보·백업신선도·이상감지 등)인데 한 스레드를 나눠 쓰면, 느린 폴러 하나가 자기 차례에서 오래 걸릴 때 뒤에 줄 선 폴러 전부가 함께 밀립니다. 실제로 노트북이 절전에서 깨어난 뒤 한 폴러가 길게 붙잡자 전체 폴러가 동반 정지하는 걸 겪었어요.

`ThreadPoolTaskScheduler` 빈 하나를 등록하니 Spring이 이걸 자동으로 @Scheduled 실행에 씁니다. 폴러들이 서로 다른 스레드로 분산되죠. 로그의 스레드명이 기본 `scheduling-1`이 아니라 `dbtower-sched-2`처럼 나오는 걸로 확인했습니다. 단, 이 풀은 폴러를 **분산**할 뿐 한 폴러의 동시 재진입을 허용하진 않습니다(`fixedDelay`는 이전 실행 완료 후 지연을 재니까요).

### 3. 알림은 버리지 말고 묶어라

대량 장애가 나면 알림이 폭주합니다. 100건이 한꺼번에 웹훅으로 나가면 채널이 도배되고, 정작 봐야 할 알림이 스크롤 위로 사라져요. 흔한 해법은 "초과분을 버린다"지만, 그럼 정보를 잃습니다.

그래서 **버리지 않고 묶었습니다.** 분당 상한(기본 12건)을 두고, 상한 안이면 즉시 보냅니다. 초과하면 전송하지 않되 **억제된 개수만 셉니다.** 그리고 다음 허용 알림이 나갈 때 `"(그동안 억제된 알림 N건 더 발생 — 대시보드 확인)"` 한 줄을 덧붙입니다. 정보는 안 잃고, 채널은 안 막는 절충이죠.

이 로직은 시각(now)을 주입받는 형태로 떼어내 결정적으로 단위 테스트했습니다 — 상한 안에선 다 보내고, 초과분은 억제되고, 60초 뒤 윈도우가 비면 다음 전송에 합산되고, 합산 후 카운트가 리셋되는 것까지.

### 4. 문제 인스턴스를 삭제 없이 격리

폭주하거나 접속이 불안정한 대상 하나가 전체 수집을 느리게 만들 때, 지금까지는 선택지가 "등록을 지운다"뿐이었습니다. 지우면 이력도 사라지고, 안정되면 다시 등록해야 하죠.

그래서 **격리 토글**을 달았습니다. `collectionEnabled` 컬럼(Flyway V9)을 추가하고, 끄면 스냅샷 수집과 운영 경보 폴러가 그 인스턴스를 건너뜁니다 — 등록 정보는 그대로 둔 채. 대시보드의 인스턴스 카드에 배지를 달아 클릭 한 번으로 토글합니다.

![인스턴스 목록 — 전부 '수집중'(초록), 격리한 하나만 '격리됨'(빨강) 배지](/uploads/project/dbtower/collection-toggle.png)

실측에선 한 인스턴스를 격리하니 다음 수집 주기에 그 인스턴스만 수집 0건, 나머지 13개만 수집됐습니다(14 − 1). 삭제하지 않고 관제에서 잠시 뺀 거죠.

### 5. 매번 재계산하지 않기 — 헬스 스코어 캐시

헬스 스코어는 인스턴스마다 다섯 신호(health 프로브·이상감지·Advisor·SLO·백업)를 모아 합산합니다. 그중 health 프로브는 **대상 DB에 실제로 붙어요.** 이걸 대시보드를 열 때마다 전 인스턴스에 대해 다시 하면, 조회가 곧 부하가 됩니다.

그래서 주기 폴러가 미리 계산해 캐시에 담고, 조회는 캐시를 돌려줍니다. 집계 시각은 리포트가 담아 UI에 이미 표기되고 있었고요. 연속으로 두 번 조회하면 같은 집계 시각이 나오는 걸로 캐시 동작을 확인했습니다.

여기서 HA 관련 판단이 하나 있었어요 — **이 캐시에는 ShedLock을 걸지 않았습니다.** 캐시는 노드별 인메모리라, 각 노드가 자기 캐시를 독립적으로 채워야 하거든요. 한 노드만 갱신하게 하면 나머지 노드는 캐시가 비어 매 조회마다 즉석 계산하게 되어 캐시가 무의미해집니다. 프로브는 읽기 전용이라 노드마다 도는 것은 멱등하고, 부하 상한도 갱신 주기로 묶입니다.

### 6. 마치며 — 원칙을 규모의 축으로

이번 아크에 새로운 기능은 거의 없습니다. 대신 **같은 원칙("진단이 부하가 되면 안 된다")을 규모라는 축으로 확장**했어요. 병렬화는 속도를, 풀 분리는 격리를, 레이트리밋은 채널을, 격리 토글은 선택지를, 캐시는 조회 비용을 지켰습니다.

그리고 정직한 한계를 남깁니다 — 병렬은 노드 안에서만이고(노드 간은 여전히 ShedLock), 알림 요약은 다음 알림이 와야 나갑니다(완전 무음이면 요약도 대기). 이 경계들은 감추기보다 문서와 주석에 적어, 다음에 팔 곳의 지도로 남겼습니다.

이것으로 심화 4개 아크(플랜 플립 5기종·p95 정직 등급·데드락 축·스케일 제어)를 마칩니다. 관통하는 하나의 태도가 있었다면 — **못 하는 걸 하는 척하지 않고, 아는 만큼만 정직하게 말하되, 그 아는 것을 라이브로 확인한다**는 것이었습니다.

코드와 실측 기록 전체는 [GitHub](https://github.com/dj258255/dbtower)에 있습니다.

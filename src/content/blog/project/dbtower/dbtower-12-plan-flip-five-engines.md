---
title: '하나의 기능을 다섯 기종으로 — 플랜 플립 감지를 완성하다'
titleEn: 'One Feature, Five Engines: Completing Plan-Flip Detection'
description: "이기종 DBMS 운영 관리 플랫폼 DBTower 12편. 11편에서 만든 실행계획 변경(plan flip) 감지는 PostgreSQL만 완전했습니다 — 정규화 쿼리($1·?)로 계획을 얻는 길이 PG에만 있었기 때문입니다. 이 기능을 다섯 기종으로 완성하면서, 같은 '계획 형태'를 얻는 경로가 기종마다 전혀 다르다는 이기종의 현실을 다시 만났습니다. MySQL은 performance_schema가 저장한 리터럴 샘플(QUERY_SAMPLE_TEXT)을 EXPLAIN하고, SQL Server는 Query Store가 축출 없이 보존하는 plan_id 이력을 그대로 읽고(NATIVE), Oracle은 plan_hash_value가 곧 계획 식별자이며, MongoDB는 프로파일러가 저장한 실제 명령을 explain으로 재실행합니다. 계획 표현이 JSON·XML·해시로 제각각인 걸 shape 정규화 한 겹으로 흡수한 설계, 그리고 덤으로 판 PG 복제 슬롯 감시(디스크 고갈 사각)와 블로트 신호까지 — 전부 라이브 실측으로 기록합니다."
descriptionEn: "Part 12 of DBTower. The plan-flip detection built in Part 11 was complete only for PostgreSQL, because the path to get a plan from a normalized query ($1/?) existed only there. Completing it across five engines surfaced again how differently each engine yields the same plan shape: MySQL re-EXPLAINs the literal sample performance_schema stored (QUERY_SAMPLE_TEXT), SQL Server reads the plan_id history Query Store preserves without cache eviction (NATIVE), Oracle's plan_hash_value is itself the plan identity, and MongoDB re-runs the actual command the profiler captured via explain. A single shape-normalization layer absorbs plans expressed as JSON, XML, and hashes — plus PG replication-slot monitoring (the disk-exhaustion blind spot) and bloat signals, all recorded with live measurement."
date: 2026-07-07
tags:
  - Java
  - Spring Boot
  - DBRE
  - Query Optimization
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

## 0. 들어가며 — 반쪽짜리로 남겨둔 기능

[11편](/blog/project/dbtower/dbtower-11-deepening)에서 실행계획 변경(plan flip) 감지를 만들었어요. "쿼리도 데이터도 그대로인데 갑자기 느려짐 = 옵티마이저가 계획을 갈아탐"을 잡는 기능인데, 그때 정직하게 적어둔 한계가 있었습니다 — **PostgreSQL만 완전하다.**

이유는 그 편에서 밟은 벽 그대로예요. 통계 소스의 쿼리 텍스트는 리터럴이 지워진 정규화 형태($1·?)라 그대로 EXPLAIN이 안 되는데, PostgreSQL 16의 `EXPLAIN (GENERIC_PLAN)`이 그걸 정확히 풀어주는 유일한 기능이었죠. 나머지 네 기종은 "플레이스홀더 텍스트는 스킵"하고 넘어갔습니다.

그런데 이 프로젝트를 관통한 원칙이 "새 기능 = 다섯 기종에서 동작"이었어요. 반쪽짜리로 두면 정체성에 흠집입니다. 그래서 다섯 기종 리서치를 돌려([이전 편의 심화 조사](/blog/project/dbtower/dbtower-0-overview)) 각 기종이 "정규화 쿼리로 계획을 얻는 길"을 찾았고, 이번 편은 그 길이 **기종마다 전혀 다르다**는 걸 하나씩 잇는 이야기입니다.

## 1. 설계 — 획득은 기종이, 판정은 공통이

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

## 2. 다섯 개의 다른 길

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

## 3. shape — 다섯 포맷을 하나의 비교 가능한 문자열로

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

## 4. 라이브 — 획득 체인이 진짜 도는가

여기서 정직하게 범위를 나눠 씁니다. **"계획 형태를 얻어서 이전과 비교해 플립을 알린다"는 판정 로직 자체는 11편(PostgreSQL)에서 이미 완전한 before/after로 검증됐습니다** — Index Only Scan이 Seq Scan으로 갈아탄 순간을 알림으로 잡았죠. 이번 편의 새로운 부분은 그 판정에 먹일 **계획 형태를 각 기종에서 실제로 뽑아내는 `planShapeForDigest`** 입니다. 그래서 12편의 실측 초점은 "이 획득 체인이 라이브로 도는가"예요.

가장 다른 두 경로를 실제로 돌렸습니다.

**MySQL** — 회귀가 뜬 products 쿼리(`WHERE code = ?`)에 대해, 트래커가 `performance_schema`의 `QUERY_SAMPLE_TEXT`를 꺼내 `EXPLAIN FORMAT=JSON`을 돌리고 shape `ALL(products)`를 실제로 저장하는 것을 확인했습니다(09:44:56). 샘플 텍스트 조회 → EXPLAIN → `fromMysqlJson` → 저장으로 이어지는 체인이 라이브로 동작한 거죠. 덤으로, DBTower가 자기 자신을 감시하다 회귀가 난 내부 쿼리도 `ALL(events_statements_summary_by_digest)`로 계획추적되면서 같은 체인을 한 번 더 밟았습니다.

정직하게 덧붙이면, 압축된 데모 안에서 **단일 기종의 완전한 before(ref) → after(ALL) 플립 한 쌍**을 깔끔하게 재현하진 못했습니다. 계획추적 트리거가 레이턴시·행수 회귀에 묶여 있어서, 안정적으로 터지는 방향이 "인덱스 드랍으로 스캔 행수가 급증하는" 한 방향뿐이었거든요 — 반대 방향(빠른 ref 기준선)을 먼저 확보하려면 또 다른 회귀를 정확한 타이밍에 유발해야 하는 catch-22였습니다. 이건 코드 결함이 아니라 몇 분짜리 데모 부하로는 두 방향 회귀를 순서대로 만들기 어렵다는 조건의 문제이고, 기준선 저장(`ALL(products)` 실저장)까지는 라이브로 도달했습니다. 플립 비교 로직 자체는 PG로 이미 증명됐으니, 남은 건 "형태를 뽑는 손"이 각 기종에서 도느냐였고 그건 확인됐습니다.

**SQL Server** — Query Store를 켠 사용자 DB를 등록하고, `planShapeForDigest`가 쓰는 획득 SQL(`query_hash` → `sys.query_store_plan` → showplan XML)을 직접 실행해 실제 showplan XML이 돌아오는 것을 확인했습니다. 축출 없이 보존되는 계획 이력을 그대로 읽는 NATIVE 경로가 살아 있다는 실측이에요.

Oracle과 MongoDB는 획득 경로를 라이브로 확인했어요 — Oracle은 `v$sqlstats`에서 plan_hash_value가 조회되는 것(무료 뷰), MongoDB는 프로파일러 레벨 2에서 `system.profile`에 queryHash가 쌓이는 것. 그리고 정직한 실측 하나 — 데모의 `local-mssql`은 시스템 DB(master)에 붙어 Query Store가 없는데, 이때 **게이트가 조용히 스킵**하는 것까지 확인했습니다. "켜져 있으면 쓰고 아니면 스킵"이 실제로 그렇게 도는 거죠.

## 5. 덤으로 판 두 삽 — 슬롯 감시와 블로트

같은 조사에서 나온 PostgreSQL 저비용·고가치 두 개도 함께 넣었어요.

**복제 슬롯 잔량 감시.** PG 운영 최빈 사고 중에 "비활성 복제 슬롯이 WAL을 무한 보존해 디스크를 꽉 채워 DB가 죽는" 게 있습니다. 그런데 지금까지 우리는 `pg_stat_replication`(연결된 복제만)만 봐서 이 사각이 완전히 비어 있었어요. `pg_replication_slots` 하나를 읽는 걸로 채웠습니다 — `wal_status='lost'`면 이미 슬롯 무효, `unreserved`면 직전 경고, 비활성 슬롯이 임계 이상 WAL을 붙잡으면 디스크 고갈 경보. SELECT 한 번이 대표 장애 하나를 막는 거예요.

![복제 슬롯 감시 — 비활성 슬롯이 붙잡은 WAL 보존량, pg_stat_replication이 못 보는 사각](/uploads/project/dbtower/replication-slots.png)

**블로트/통계 노후 신호.** autovacuum이 죽은 튜플을 못 따라가면 테이블이 부풀어 느려지는데, 이 신호가 Advisors에 통째로 없었어요. 재밌는 건 재료가 **이미 읽던 뷰의 안 쓰던 컬럼**이었다는 것 — `pg_stat_user_tables`의 `n_dead_tup`·`last_autovacuum`·`n_mod_since_analyze`. dead ratio가 임계를 넘으면 블로트 후보로 올립니다. 단 이건 통계 추정치라 "삭제 근거"가 아니라 "VACUUM을 점검하라"는 신호로 정직하게 표기했어요.

여기서 실측 중 웃긴 일이 있었어요. 블로트를 만들려고 대량 UPDATE를 했는데 Advisor가 0건을 냈습니다 — **autovacuum이 이미 청소해버린** 거예요. 감지기가 안 도는 게 아니라, PostgreSQL의 autovacuum이 정상 작동하고 있다는 실측이었죠. 그래서 데모 테이블만 autovacuum을 꺼서 죽은 튜플을 남기니 정확히 잡혔습니다.

![블로트 Advisor — 죽은 튜플 비율과 '추정치 — 실측 아님' 정직 표기](/uploads/project/dbtower/bloat-advisor.png)

## 6. 마치며 — 반쪽을 온전하게

이번 편으로 플랜 플립의 계획 획득 경로가 다섯 기종 모두에 생겼고, 그 앞의 플립 판정은 11편에서 PG로 이미 검증된 공통 로직을 그대로 씁니다 — 획득만 채우면 다섯 기종이 같은 판정으로 흐르는 구조죠. 돌아보면 이 작업의 배움은 "다섯 기종 지원"이라는 결과보다 **다섯 개의 서로 다른 길을 하나의 경계 뒤로 숨긴 방법**에 있었습니다. GENERIC_PLAN·리터럴 샘플·Query Store 이력·plan_hash_value·프로파일러 명령 — 공통점이 하나도 없는 다섯 획득 경로가 `planShapeForDigest` 메서드 시그니처 하나 뒤로 들어갔고, 그 앞의 트래커는 다섯 기종을 하나처럼 다룹니다.

그리고 이번에도 정직한 잔여를 남깁니다 — MySQL 샘플 기반 계획은 특정 파라미터 값의 플랜이라 그 digest의 대표 플랜과 다를 수 있고, Oracle의 plan_hash_value는 shared pool에서 age-out되면 과거 계획 본문을 못 봅니다(그래서 우리 스냅샷이 이력의 단일 출처예요). 다음에 팔 곳의 지도죠.

코드와 실측 기록 전체는 [GitHub](https://github.com/dj258255/dbtower)에 있습니다.

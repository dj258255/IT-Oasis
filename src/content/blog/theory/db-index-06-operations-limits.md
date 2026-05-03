---
title: '데이터베이스 인덱스 ⑥: 운영과 한계'
titleEn: 'Database Index ⑥: Operations and Limits'
description: 인덱스 시리즈 마무리. 운영 환경의 인덱스 작업은 DDL이 DB를 멈출 수 있다는 사실에서 출발해요. CREATE INDEX CONCURRENTLY의 4단계 phase와 제약, 장기 트랜잭션이 클러스터 전반의 VACUUM/IOS에 미치는 영향, 인덱스 bloat과 REINDEX, 수십억 행을 위한 파티셔닝/샤딩, Bloom Filter, 그리고 6가지 안티패턴까지 1차 자료 기준으로 정리합니다.
descriptionEn: Series finale. Operating indexes starts from the fact that DDL can stall the database. Covers the four-phase CREATE INDEX CONCURRENTLY mechanism and its constraints, how a single long-running transaction affects cluster-wide VACUUM and IOS effectiveness, index bloat and REINDEX, partitioning/sharding/Bloom filter for billion-row workloads, and six common antipatterns — grounded in primary sources.
date: 2026-04-27T00:00:00.000Z
tags:
  - Database
  - Index
  - PostgreSQL
  - CONCURRENTLY
  - VACUUM
  - Partitioning
  - Bloom Filter
  - Operations
category: theory/Database
draft: false
coverImage: "/uploads/theory/db-index/cover-6.svg"
series: "데이터베이스 인덱스"
seriesOrder: 6
---

## 0. 들어가며

인덱스 시리즈 6편이자 마지막. [1](/blog/theory/db-index-01-explain-basics)~[5편](/blog/theory/db-index-05-clustered-dbms)이 인덱스의 메커니즘과 설계를 다뤘다면, 이번 편은 **운영 측면** — *인덱스를 실제로 만들고, 갱신하고, 한계에 부딪힐 때 어떻게 다룰 것인가*. 핵심 주제는 `CREATE INDEX CONCURRENTLY`, 장기 트랜잭션의 비용, 파티셔닝/샤딩, Bloom Filter, 인덱스 안티패턴. 그리고 시리즈 마무리.

핵심 메시지: **운영 환경의 인덱스 작업은 *DDL이 데이터베이스를 멈출 수 있다* 는 사실에서 출발해요**. PostgreSQL의 `CREATE INDEX`는 기본적으로 write를 막는 `SHARE` lock을 걸고, `CONCURRENTLY` 옵션을 써야 DML이 지속될 수 있어요 (단 내부적으로 여러 phase와 lock 전환을 거치므로 *완전히 무제한 동작은 아니고*, 제약 + 장기 트랜잭션에 차단됨). 그리고 **장기 트랜잭션 하나가 클러스터 전반의 VACUUM 진행에 영향을 주어 인덱스 bloat과 IOS 효과 상실을 유발** (특히 shared relation과 전역 horizon에 큰 영향)하는 게 가장 흔한 운영 사고. 수십억 행 규모로 가면 단일 인덱스로는 한계가 있어 *파티셔닝, 샤딩, Bloom Filter* 같은 도구로 분할/근사 접근. 결국 *lock과 visibility horizon 이해가 인덱스 운영의 핵심 축 중 하나* 예요 (통계/cache/IO/replication도 함께 봐야 진짜 운영).

![인덱스 시리즈 6편 커버 — Lock과 Visibility Horizon](/uploads/theory/db-index/cover-6.svg)

> **글의 범위**: 이번 편은 *PostgreSQL 운영 관점*. CONCURRENTLY/장기 트랜잭션은 PostgreSQL 고유 메커니즘이고, 파티셔닝/Bloom Filter는 PostgreSQL을 기준으로 다뤄요. 다른 DBMS는 해당 매뉴얼 참고.

## 1. CREATE INDEX의 두 모드 — Lock의 본질

### 일반 CREATE INDEX는 write를 막는다

```sql
CREATE INDEX idx_users_email ON users(email);
```

겉보기엔 평범하지만 *운영 중에 실행하면 사고가 나요*. PostgreSQL 공식 문서에 따르면 — 일반 `CREATE INDEX`는 `SHARE` lock을 걸어 *모든 INSERT/UPDATE/DELETE를 대기시킴*. read는 가능하지만 *쓰기 트래픽이 모두 멈춘다*.

대규모 테이블에서 인덱스 생성은 몇 분~몇 시간. 그동안 write 트래픽이 lock 대기 상태에 들어가 — *workload와 timeout 설정에 따라 사실상 다운타임처럼 동작* 할 수 있어요 (`statement_timeout`에 걸려 에러 폭증, queueing으로 응답 지연 등).

### CREATE INDEX CONCURRENTLY — write 허용

```sql
CREATE INDEX CONCURRENTLY idx_users_email ON users(email);
```

PostgreSQL 18 공식 문서 직접 인용:

> *"PostgreSQL will build the index without taking any locks that prevent concurrent inserts, updates, or deletes on the table"*

대신 `ShareUpdateExclusiveLock`을 걸어 *DDL은 막지만 DML은 허용*. 다만 *완전히 무제한으로 동작하는 것은 아니에요* — 내부적으로 *snapshot synchronization, index state transition, 마지막 phase의 짧은 lock 전환* 등을 거칩니다.

![CREATE INDEX CONCURRENTLY — 4단계로 동작](/uploads/theory/db-index/concurrently-phases.svg)

동작 방식은 multi-phase:

1. 카탈로그에 invalid 인덱스 등록
2. 첫 번째 테이블 스캔 — 인덱스 빌드
3. 두 번째 테이블 스캔 — 1단계 동안 발생한 변경 catch up
4. valid로 마킹

마지막 단계에서 *짧은 `AccessExclusiveLock`* 이 걸리지만 일반적으로 수 ms~수 초 수준.

### CONCURRENTLY의 제약

PostgreSQL 18 공식 문서가 명시:

- **트랜잭션 블록 내 사용 불가** — `BEGIN; CREATE INDEX CONCURRENTLY ...; COMMIT;` 에러 (*"cannot run inside a transaction block"*)
- **테이블당 동시 1개만** (다른 CONCURRENTLY와 직렬화)
- **실패 시 INVALID 인덱스 남음** — 자동 정리 안 됨, 수동 `DROP INDEX` 필요
- **장기 트랜잭션에 차단됨** — 마지막 phase가 기존 트랜잭션 종료를 기다림
- **partitioned table은 직접 불가** — 각 파티션별로 CONCURRENTLY 후 partitioned index를 non-concurrent로 메타데이터만 생성 (PostgreSQL 11+)

### INVALID 인덱스 정리

```sql
-- 실패한 인덱스 찾기
SELECT indexrelid::regclass
FROM pg_index
WHERE NOT indisvalid;

-- 정리
DROP INDEX CONCURRENTLY idx_users_email;
-- 다시 시도
CREATE INDEX CONCURRENTLY idx_users_email ON users(email);
```

`UNIQUE INDEX CONCURRENTLY`는 더 위험 — *생성 중 중복이 들어오면 실패*. 사전에 중복 제거 후 재시도 또는 `NOT VALID + VALIDATE` 패턴.

> **1장 요약** — 운영 중 트래픽이 있는 테이블에는 *CONCURRENTLY가 정공법*. 단 *트랜잭션 블록 불가, 실패 시 INVALID 남음, 장기 트랜잭션에 차단되는 제약* 이 있어요. 작은 테이블이나 명시적 maintenance window가 있으면 일반 CREATE INDEX도 가능.

## 2. 장기 트랜잭션 — 인덱스 운영의 진짜 적

### Visibility Horizon의 본질

PostgreSQL의 MVCC는 **xmin horizon** 이라는 경계로 동작 — *현재 활성 중인 트랜잭션 중 가장 오래된 xmin*. 이 horizon보다 나중에 생성된 dead tuple은 VACUUM이 회수할 수 없어요.

문제는 — *하나의 장기 트랜잭션이 클러스터 전반의 horizon에 영향을 준다*는 것 (특히 shared relation과 전역 horizon에 영향이 큼). CYBERTEC 자료가 명시:

> *"A tuple is not needed if the transaction ID of the deleting transaction is older than the oldest transaction still active in the PostgreSQL database. (Or, in the whole cluster for shared tables)"*

### 가장 흔한 사고 — idle in transaction

```sql
-- 세션 A (개발자 콘솔)
BEGIN;
SELECT * FROM users LIMIT 10;
-- ... 점심 먹으러 감 (1시간)
```

이 한 세션이 — *다른 모든 테이블의 dead tuple 회수를 1시간 동안 차단*. 그 시간 동안:

![xmin horizon — 장기 트랜잭션 하나가 클러스터 전체를 잡는다](/uploads/theory/db-index/xmin-horizon.svg)

- INSERT/UPDATE/DELETE는 정상 작동
- 그러나 VACUUM이 *dead tuple 정리 못 함*
- bloat 누적 + VM 비트 reset 누적 → IOS 효과 사라짐 ([3편](/blog/theory/db-index-03-covering-index-ios))
- autovacuum이 실행되더라도 horizon에 막혀 *효과가 제한적*

### Horizon을 잡는 5가지 원인

PostgreSQL 운영자가 알아야 할 5가지:

1. **활성 트랜잭션** — 가장 흔한, idle in transaction 포함
2. **Replication slot** — 사라진 standby의 slot이 horizon을 *영구적으로* 잡음
3. **Hot standby의 장기 쿼리** — `hot_standby_feedback = on`일 때
4. **Prepared transaction (2PC)** — 미커밋된 prepared transaction
5. **Abandoned cursor** — `WITH HOLD` 커서가 트랜잭션 외부로 살아남음

### 진단

```sql
-- 장기 트랜잭션 찾기
SELECT pid, age(clock_timestamp(), xact_start) AS duration,
       state, query
FROM pg_stat_activity
WHERE state != 'idle'
ORDER BY xact_start;

-- horizon 잡고 있는 세션 식별
SELECT pid, backend_xmin
FROM pg_stat_activity
WHERE backend_xmin IS NOT NULL
ORDER BY backend_xmin;

-- replication slot의 xmin
SELECT slot_name, xmin, catalog_xmin
FROM pg_replication_slots;
```

### 해결책

**예방**:

- `idle_in_transaction_session_timeout` 설정 (예: 5분)
- `statement_timeout` 설정
- 애플리케이션의 connection pool에서 *트랜잭션을 짧게 유지*

**대응**:

```sql
-- 문제 세션 종료
SELECT pg_terminate_backend(pid);

-- 사라진 slot 정리
SELECT pg_drop_replication_slot('dead_slot');
```

> **2장 요약** — 장기 트랜잭션이 클러스터 전반의 VACUUM 진행에 영향을 주어(특히 shared relation과 전역 horizon에 큰 영향) *인덱스 bloat과 IOS 효과 상실을 유발* 하는 게 가장 흔한 운영 사고. `idle_in_transaction_session_timeout` 설정과 horizon 모니터링이 정공법.

## 3. 인덱스 Bloat과 REINDEX

### 인덱스도 bloat된다

PostgreSQL의 table bloat은 잘 알려져 있지만 — 인덱스도 bloat돼요. UPDATE/DELETE가 잦은 테이블에서:

- dead tuple의 인덱스 항목이 누적
- B-tree의 leaf page가 비효율적으로 채워짐
- VACUUM이 dead tuple의 인덱스 항목을 제거하고 free space를 재사용하지만, *B-tree 페이지 자체를 적극적으로 병합하지는 않음* (B-tree 특성)

결과: *인덱스 크기는 그대로인데 실제 활용 가능한 항목은 적어짐* — 인덱스 스캔 비용 증가, IOS 효과 감소.

### REINDEX

```sql
-- 일반 REINDEX (테이블 lock 걸림 — 운영 중 위험)
REINDEX INDEX idx_users_email;

-- PostgreSQL 12+ — CONCURRENTLY 옵션
REINDEX INDEX CONCURRENTLY idx_users_email;

-- 테이블 전체 인덱스 재구축
REINDEX TABLE CONCURRENTLY users;
```

`REINDEX CONCURRENTLY`는 내부적으로 *새 인덱스를 CONCURRENTLY로 만들고, 원본을 교체* 하는 방식. CREATE INDEX CONCURRENTLY와 같은 제약이 있어요 — 장기 트랜잭션에 차단됨, 실패 시 INVALID 남음.

### 인덱스 bloat 모니터링

```sql
-- 큰 인덱스 찾기 + dead tuple 비율 추정
SELECT schemaname, tablename, indexname,
       pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
FROM pg_stat_user_indexes
ORDER BY pg_relation_size(indexrelid) DESC
LIMIT 20;
```

더 정밀한 진단은 `pgstattuple` 확장(extension)으로 *index bloat 비율을 직접 측정* 가능.

> **3장 요약** — 인덱스도 bloat되므로 *bloat이 일정 수준 이상일 때 주기적으로 `REINDEX CONCURRENTLY`* 가 필요. VACUUM이 dead tuple 항목은 제거하고 free space를 재사용하지만 *B-tree 페이지 자체를 적극적으로 병합하지는 않음*. PostgreSQL 12+의 CONCURRENTLY 옵션이 운영 표준.

## 4. 수십억 행 — 파티셔닝과 샤딩

### 단일 인덱스의 한계

테이블이 수억~수십억 행에 도달하면 *단일 B-tree 인덱스로는 한계*:

- 인덱스 크기가 너무 커서 buffer pool에 안 들어감
- REINDEX/VACUUM 시간이 너무 길어짐 (몇 시간~며칠)
- CREATE INDEX CONCURRENTLY 자체가 며칠 걸림
- maintenance window가 사라짐

해법은 **분할** — Partitioning(같은 인스턴스 내) 또는 Sharding(여러 인스턴스 분산).

![수십억 행 — 단일 인덱스의 한계와 분할 전략](/uploads/theory/db-index/partition-strategy.svg)

### Partitioning — Postgres 11+

```sql
-- range partitioning
CREATE TABLE events (
    id BIGSERIAL,
    created_at TIMESTAMP NOT NULL,
    user_id BIGINT,
    payload JSONB
) PARTITION BY RANGE (created_at);

CREATE TABLE events_2026_01 PARTITION OF events
    FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE events_2026_02 PARTITION OF events
    FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
-- ...

-- 인덱스는 각 파티션에 자동 전파
CREATE INDEX ON events (user_id, created_at);
```

이점:

- *각 파티션이 독립적인 작은 테이블*: 인덱스도 작고, REINDEX도 빠름
- *partition pruning*: WHERE 조건에 따라 *불필요한 파티션은 스캔에서 제외*
- *오래된 파티션 archiving*: `DROP TABLE events_2024_*` — 인덱스도 함께 사라짐
- *partitioned table에 CONCURRENTLY는 직접 불가*, 각 파티션별로 CONCURRENTLY → metadata-only로 합치는 방식 (1장 참고)

함정:

- *파티션 키 선택이 critical* — 잘못 선택하면 모든 쿼리가 모든 파티션을 스캔
- *PK가 partition key를 포함해야* unique constraint 보장 (PostgreSQL 제약)
- *cross-partition join이 비싸짐*

### Sharding — 인스턴스 분산

데이터가 단일 인스턴스에 안 들어가는 규모가 되면 sharding. 일반적인 도구:

- **Citus** (PostgreSQL extension) — distributed PostgreSQL
- **Vitess** (MySQL 진영)
- **CockroachDB / Yugabyte** — distributed SQL을 처음부터 설계

샤딩의 본질적 trade-off:

- *cross-shard query/transaction이 비싸짐*
- *unique constraint이 shard key 외에는 보장 어려움*
- *index 운영도 shard별로 독립*

### Composite 전략 — Partition + Index + Cache

수십억 행 워크로드의 현실적인 운영 패턴:

1. **시간 기준 partition** (월/주 단위)
2. **각 파티션의 hot range만** 인덱스 풀로 운영
3. **오래된 파티션은 압축** + 인덱스 최소화
4. **read-heavy 부하는 Redis/Memcached 캐시로 분리** ([Redis 글](/blog/theory/redis-caching-guide) 참고)
5. **검색 부하가 크면 Elasticsearch / OpenSearch 별도** ([ES 메모리 시리즈](/blog/theory/es-memory-05-elasticsearch))

> **4장 요약** — 수십억 행에서는 *단일 인덱스 한계*. 파티셔닝(시간 기준이 일반적) + 적절한 인덱스 + 캐시 + 외부 검색엔진 조합이 현실적인 운영 패턴.

## 5. Bloom Filter — 정확한 인덱스가 아닌 보조 자료구조

### Bloom Filter의 본질

Bloom Filter는 *집합 멤버십을 확률적으로 답하는 자료구조*:

- *"이 값이 집합에 없다"* — 100% 정확
- *"이 값이 집합에 있을 수도 있다"* — false positive 가능

PostgreSQL 18 공식 (bloom extension) 직접 인용:

> *"A signature is a lossy representation of the indexed attribute(s), and as such is prone to reporting false positives ... So index search results must always be rechecked using the actual attribute values from the heap entry"*

즉 Bloom index는 *후보를 빠르게 좁히는 도구*, 정확한 답을 주는 인덱스가 아니에요. *heap에서 recheck가 필수*.

### PostgreSQL Bloom Index — 어떤 경우에 유리한가

PostgreSQL의 bloom extension은 contrib module:

```sql
CREATE EXTENSION bloom;

CREATE INDEX bloom_users_idx ON users
USING bloom (col1, col2, col3, col4, col5)
WITH (length=80, col1=2, col2=2, col3=4, col4=2, col5=2);
```

**유리한 경우**:

- 많은 컬럼(보통 5+)에 *임의 조합으로 equality 검색* 이 잦음
- 각 컬럼별 B-tree를 만들면 수백 MB 차지
- Bloom 하나가 *몇 분의 일 크기*

PostgreSQL 18 공식 예시: 5컬럼 테이블에서 *각 B-tree 88.5 MB × 5 = 531 MB* vs *Bloom 하나 153 MB* (3분의 1).

**한계**:

- *= 연산자만*: range, LIKE, ORDER BY 불가
- NULL 검색 불가
- UNIQUE 미지원
- *단일 컬럼 equality는 B-tree가 더 빠름*

### 왜 정공법이 아닌가

Bloom index는 trade-off가 명확한 *보조 도구*:

- B-tree로 모든 컬럼 인덱스 만들 수 없을 때
- 각 쿼리가 *서로 다른 컬럼 조합* 을 사용할 때
- false positive recheck 비용을 감수할 때

대부분의 실무 워크로드는 — *주력 쿼리 패턴이 명확하니 B-tree 복합 인덱스로 해결* ([4편](/blog/theory/db-index-04-composite-leftmost)). Bloom은 *그것이 안 되는 워크로드의 escape hatch*.

### Bloom Filter의 다른 활용

PostgreSQL의 *내부적으로도* Bloom Filter는 활용돼요 — 예: parallel hash join에서 prefilter. 또한 RDB가 아닌 도구들(Cassandra, HBase, RocksDB 등)에서는 *SSTable의 row 존재 여부 빠르게 확인* 하는 용도로 훨씬 일반적. PostgreSQL의 bloom extension은 *특수 케이스용 인덱스* 에 불과.

> **5장 요약** — Bloom Filter는 *정확한 인덱스가 아닌 확률적 보조 자료구조* 로, 옵티마이저가 비용상 유리하다고 판단할 때만 선택돼요. *false positive O, false negative X*. PostgreSQL bloom extension은 *많은 컬럼 + 임의 조합 equality 검색* 에서만 유리. 대부분 워크로드는 B-tree 복합 인덱스가 정공법.

## 6. 인덱스 안티패턴 — 운영에서 자주 보는 실수

![인덱스 안티패턴 6가지 — 운영에서 자주 보는 실수](/uploads/theory/db-index/index-antipatterns.svg)

### 안티패턴 1 — 일단 만들고 보자

쿼리 느려지면 인덱스 추가. 시간이 지나면 *수십 개의 사용 안 되는 인덱스가 쌓여요*. 비용:

- INSERT/UPDATE/DELETE 비용에 모두 영향
- bloat 누적
- 통계 갱신 비용

진단:

```sql
SELECT schemaname, relname, indexrelname, idx_scan
FROM pg_stat_user_indexes
WHERE idx_scan = 0
ORDER BY pg_relation_size(indexrelid) DESC;
```

`idx_scan = 0`인 인덱스는 사용 안 됨. 단 *replica에서만 쓰이는 경우* 또는 *방금 생성된 경우* 는 예외.

### 안티패턴 2 — 카디널리티 낮은 컬럼에 인덱스

```sql
-- 99%가 'active'인 status 컬럼
CREATE INDEX idx_users_status ON users(status);
```

인덱스가 거의 안 쓰임. 옵티마이저는 Seq Scan을 더 싸다고 판단 ([1편](/blog/theory/db-index-01-explain-basics) 참고). 차라리 *partial index*:

```sql
-- 'inactive'만 인덱싱 (소수)
CREATE INDEX idx_users_inactive ON users(id)
WHERE status = 'inactive';
```

### 안티패턴 3 — 함수 적용한 컬럼에 인덱스 없음

```sql
SELECT * FROM users WHERE LOWER(email) = 'x@y.com';
-- → 일반 idx_email은 못 씀
```

`LOWER(email)`은 함수 결과라 email 컬럼 인덱스가 안 잡혀요. 해결:

```sql
-- expression index
CREATE INDEX idx_users_email_lower ON users(LOWER(email));
```

또는 애플리케이션 단에서 lowercase로 저장.

### 안티패턴 4 — PG 11 이전의 covering index 흉내

PG 11 이전에는 INCLUDE가 없어 *모든 컬럼을 key 컬럼으로* 만들었어요:

```sql
-- PG 10 이전 패턴 (이제 안티패턴)
CREATE UNIQUE INDEX idx_old ON users(id, email, name);
```

문제는:

- uniqueness가 (id, email, name) 조합에 적용 (의도와 다름)
- 모든 컬럼이 navigation node에 들어가 인덱스 비대화
- 복합 인덱스 좌측 컬럼 규칙에 모든 컬럼이 묶임

PG 11+에서는 INCLUDE 절이 정공법 ([3편](/blog/theory/db-index-03-covering-index-ios) 참고):

```sql
CREATE UNIQUE INDEX idx_new ON users(id) INCLUDE (email, name);
```

### 안티패턴 5 — partitioned table에 CONCURRENTLY 직접 시도

```sql
-- 에러
CREATE INDEX CONCURRENTLY ON events_partitioned (user_id);
-- → cannot run on partitioned tables
```

PostgreSQL 11+에서 *partitioned table에 CONCURRENTLY는 직접 불가*. 정공법:

```sql
-- 각 파티션별로 CONCURRENTLY
CREATE INDEX CONCURRENTLY ON events_2026_01 (user_id);
CREATE INDEX CONCURRENTLY ON events_2026_02 (user_id);
-- ...

-- 마지막에 partitioned table 메타데이터 인덱스 (instant)
CREATE INDEX ON events_partitioned (user_id);
```

마지막 단계는 *metadata only 작업이라 빠름*.

### 안티패턴 6 — EXPLAIN만 보고 EXPLAIN ANALYZE 안 봄

EXPLAIN은 *옵티마이저의 추정*. 실제 동작이 추정과 다를 수 있어요:

- 통계 stale
- 데이터 분포 비대칭
- cache 상태

`EXPLAIN (ANALYZE, BUFFERS)`로 실측해야 *진짜 비용을 알아요* ([3편 IOS 진단](/blog/theory/db-index-03-covering-index-ios) 참고).

> **6장 요약** — 인덱스 안티패턴 6가지: *과도한 생성, 낮은 카디널리티, 함수 적용, INCLUDE 누락, partitioned CONCURRENTLY 직접 시도, EXPLAIN ANALYZE 미사용*. *덜 만들고 더 측정* 하는 것이 운영의 핵심 원칙 중 하나.

## 7. 시리즈 마무리 — 인덱스의 6가지 관점

이번 시리즈가 다룬 6가지 관점:

| 편 | 주제 | 핵심 |
|---|---|---|
| [1](/blog/theory/db-index-01-explain-basics) | 인덱스 기초와 EXPLAIN | 인덱스는 자료구조 + 옵티마이저 결정 + 통계의 합. EXPLAIN이 진단의 출발 |
| [2](/blog/theory/db-index-02-scan-types) | 스캔의 종류와 옵티마이저의 선택 | Seq/Index/Index Only/Bitmap의 선택은 selectivity와 cost로 결정. lossy bitmap의 의미 |
| [3](/blog/theory/db-index-03-covering-index-ios) | Covering Index와 IOS | covering + visibility 두 단계 조건. INCLUDE 절 + VACUUM 갱신이 핵심. *index-mostly scan* 이 정확한 명명 |
| [4](/blog/theory/db-index-04-composite-leftmost) | 복합 인덱스 | 컬럼 순서가 인덱스 활용 방식에 결정적 영향. ESR Rule (휴리스틱), skip scan은 PG 18+ 보너스 |
| [5](/blog/theory/db-index-05-clustered-dbms) | 클러스터형 인덱스와 DBMS별 차이 | Heap vs IOT 두 가지 모델. PostgreSQL/MySQL InnoDB/SQL Server/Oracle의 PK/secondary 동작 차이 |
| 6 | 운영과 한계 | CONCURRENTLY/장기 트랜잭션/파티셔닝/Bloom Filter. 덜 만들고 더 측정 |

### 시리즈 전체의 진짜 한 줄

> **인덱스는 마법의 가속기가 아니에요. *데이터 구조 + 옵티마이저 결정 + 통계 + 운영 환경의 합작품* 이고, 각 층의 메커니즘을 이해해야 진짜 활용할 수 있어요.**

### 통합된 답 — 한 단락 정리

인덱스 시리즈 6편은 PostgreSQL 인덱스의 메커니즘과 운영을 깊이 다뤘어요 — 1편의 EXPLAIN 진단에서 출발해 2편의 스캔 종류와 옵티마이저 결정, 3편의 IOS 두 단계 조건과 INCLUDE 절, 4편의 복합 인덱스와 ESR Rule + skip scan, 5편의 DBMS별 저장 구조 차이(heap vs IOT), 그리고 6편의 운영과 한계까지. 운영 측면에서는 `CREATE INDEX CONCURRENTLY`가 운영 표준이지만 *DML이 허용되는 것이지 완전 무제한 동작은 아니에요* (snapshot synchronization, lock 전환 같은 내부 phase 존재) — *트랜잭션 블록 불가/실패 시 INVALID 남음/장기 트랜잭션에 차단되는 제약* 이 있고, 장기 트랜잭션 하나가 클러스터 전반의 VACUUM 진행에 영향을 주어 (특히 shared relation과 전역 horizon에 큰 영향) *인덱스 bloat과 IOS 효과 상실을 유발* 하는 게 가장 흔한 운영 사고예요 — `idle_in_transaction_session_timeout` 설정과 `pg_stat_activity` 모니터링이 정공법. 인덱스도 bloat 발생하므로 *bloat이 일정 수준 이상일 때 주기적으로 `REINDEX CONCURRENTLY`* 가 필요하고 PG 12+의 CONCURRENTLY 옵션이 운영 표준 — VACUUM이 dead tuple 항목은 제거하고 free space는 재사용하지만 *B-tree 페이지 자체를 적극적으로 병합하지는 않으므로* REINDEX가 별도 필요. 수십억 행 규모로 가면 단일 인덱스의 한계에 부딪혀 *파티셔닝(시간 기준 range가 일반적) + 샤딩(Citus 등) + 외부 검색엔진(Elasticsearch)* 같은 분할/위임 도구를 조합. Bloom Filter는 *확률적 보조 자료구조* 로 옵티마이저가 비용상 유리하다고 판단할 때만 선택되며 *false positive O / false negative X*, 많은 컬럼 + 임의 조합 equality 검색에서만 유리하고 *대부분 워크로드는 B-tree 복합 인덱스가 정공법*. 운영에서 자주 보는 6가지 안티패턴은 *과도한 인덱스 생성, 낮은 카디널리티 컬럼 인덱스, 함수 적용 컬럼 미고려, INCLUDE 절 미사용, partitioned table에 CONCURRENTLY 직접 시도, EXPLAIN ANALYZE 미사용* — *덜 만들고 더 측정* 하는 게 핵심 원칙. *lock과 visibility horizon 이해가 인덱스 운영의 핵심 축 중 하나* 지만, 통계(`ANALYZE`), cache, IO, replication도 함께 봐야 진짜 운영이 돼요. 결국 인덱스는 마법의 가속기가 아니라 *데이터 구조 + 옵티마이저 결정 + 통계 + 운영 환경의 합작품* 이고, 각 층의 메커니즘을 이해해야 진짜 활용할 수 있어요.

---

### 글의 범위와 한계

이 글은 *PostgreSQL 운영 관점*. CONCURRENTLY 메커니즘과 xmin horizon 개념은 PostgreSQL 고유예요 — *MySQL InnoDB는 online DDL이 더 다양한 알고리즘(INSTANT/INPLACE/COPY)* 을 가지고 있고, *Oracle은 Online Reorganization* 이 별도 옵션, *SQL Server는 Enterprise Edition의 Online Index Operations* 가 별도 라이선스. 정확한 동작은 각 DBMS의 운영 매뉴얼이 진짜 출처.

또한 이번 편이 인덱스 운영의 모든 주제를 다루지는 않았어요 — *통계 수집(ANALYZE) 튜닝, `autovacuum_freeze_max_age`와 wraparound 방지, vacuum cost-based delay, parallel index build, 외부 도구(pg_repack, pg_squeeze)* 는 분량상 제외. 운영 환경에서는 *공식 문서 + 실측 모니터링* 이 항상 정답.

샤딩 도구(Citus, Vitess, CockroachDB) 부분은 *각 도구의 인덱스 동작이 PostgreSQL과 다를 수 있어* 해당 매뉴얼 우선 참고.

### 참고 (1차 자료 우선)

- [PostgreSQL Documentation — CREATE INDEX](https://www.postgresql.org/docs/current/sql-createindex.html) — CONCURRENTLY 메커니즘 + 제약 공식
- [PostgreSQL Documentation — VACUUM](https://www.postgresql.org/docs/current/sql-vacuum.html) — VACUUM 동작과 옵션
- [PostgreSQL Documentation — Index Locking Considerations](https://www.postgresql.org/docs/current/index-locking.html) — 인덱스 lock 모드 공식
- [PostgreSQL Documentation — bloom](https://www.postgresql.org/docs/current/bloom.html) — Bloom filter index access method 공식
- [PostgreSQL Documentation — Table Partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html) — 파티셔닝 공식
- [CYBERTEC — VACUUM won't remove dead rows: 4 reasons why](https://www.cybertec-postgresql.com/en/reasons-why-vacuum-wont-remove-dead-rows/) — xmin horizon 5가지 원인
- [Bytebase — How to Use Postgres CREATE INDEX CONCURRENTLY](https://www.bytebase.com/blog/postgres-create-index-concurrently/) — CONCURRENTLY lock 모드 분석
- [PlanetScale — Keeping a Postgres queue healthy](https://planetscale.com/blog/postgres-queue-healthy) — MVCC horizon과 dead tuple
- [Percona — Bloom Indexes in PostgreSQL](https://www.percona.com/blog/bloom-indexes-in-postgresql/) — Bloom filter 동작 + 한계
- [Google Cloud — Deep dive into PostgreSQL VACUUM](https://cloud.google.com/blog/products/databases/deep-dive-into-postgresql-vacuum) — VACUUM 메커니즘 종합

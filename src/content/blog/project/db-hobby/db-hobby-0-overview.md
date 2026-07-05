---
title: 'db-hobby 전체 지도 — C로 만든 미니 RDBMS, 39편 읽기 가이드'
titleEn: 'The db-hobby Map — a Mini RDBMS in C, a Reading Guide to 39 Parts'
description: "C로 맨땅에서 만든 미니 관계형 DB db-hobby의 39편 시리즈 전체 지도. 진짜 psql이 붙고, reader가 writer를 안 막는 MVCC 스냅샷 격리, WAL 크래시 복구, VACUUM, 스레드 안전 버퍼 풀, 비용 기반 옵티마이저, 소켓 복제, LSM 엔진, Raft 합의까지 — 페이지 한 장에서 SQL 실행까지 바닥부터 올라간 기록이다. 각 편이 '앞 편이 만든 문제를 다음 편이 푼다'는 장애-해결 사슬로 이어진다. 어디서 시작할지, 무엇이 하이라이트인지, 어떻게 직접 돌려보는지를 한 페이지에 담은 읽기 가이드."
descriptionEn: "The full map of db-hobby, a mini relational database built from scratch in C across 39 parts. A real psql connects to it; MVCC snapshot isolation where readers don't block writers; WAL crash recovery; VACUUM; a thread-safe buffer pool; a cost-based optimizer; socket replication; an LSM engine; Raft consensus — built bottom-up from a single page to running SQL. Each part chains as failure-then-fix: the next part solves the problem the previous one created. A one-page reading guide to where to start, what the highlights are, and how to run it yourself."
date: 2026-07-04
tags:
  - C
  - Database Internals
  - PostgreSQL
  - MySQL
  - Learning
category: study/db-hobby
coverImage: /uploads/project/db-hobby/cover.svg
draft: false
series: "db-hobby"
seriesOrder: 0
---

## db-hobby란

**C로 맨땅에서 만든 미니 관계형 DB**입니다 — 고정 크기 페이지 한 장에서 시작해 SQL 실행까지 바닥부터 쌓았어요. PostgreSQL·MySQL이 안에서 실제로 어떻게 도는지를 손으로 재현해 이해하는 게 목표입니다.

지금 db-hobby는:

- **진짜 `psql`이 붙습니다** — PostgreSQL v3 wire protocol을 말하는 400줄 서버라, psql은 상대가 진짜 PG인지 구분 못 해요.
- **reader가 writer를 안 막습니다** — MVCC 스냅샷 격리. 한 트랜잭션이 미커밋 UPDATE를 쥐고 있어도 다른 쪽은 옛 버전을 막힘 없이 읽어요.
- **WAL 크래시 복구**(steal + no-force), **VACUUM**, **스레드 안전 버퍼 풀**, **비용 기반 옵티마이저**, **소켓으로 도는 primary→replica 복제**, **LSM 저장 엔진**, **Raft 합의**(리더 선출·분단 내성)까지 — 진짜 DB의 거의 모든 축을 한 번씩 만졌습니다.
- **테스트 677개 / 40스위트**, 동시성은 ThreadSanitizer로 검증. 코드: [github.com/dj258255/db-hobby](https://github.com/dj258255/db-hobby)

## 이 시리즈를 읽는 법

핵심은 **각 편이 앞 편이 만든 문제를 푼다**는 겁니다 — steal이 undo를 부르고, DELETE=xmax가 VACUUM을 부르고, 단일 스레드 서버가 스레드 안전을 부르는 식으로. 그래서 순서대로 읽으면 "장애 → 해결 → 새 장애" 사슬을 따라가게 돼요.

바쁘면 **하이라이트만**. 엔진: [14편(steal+undo)](/blog/project/db-hobby/db-hobby-14-steal-undo) → [18편(다중 트랜잭션)](/blog/project/db-hobby/db-hobby-18-multi-txn) → [19편(psql 서버)](/blog/project/db-hobby/db-hobby-19-wire-protocol) → [21편(비용 옵티마이저)](/blog/project/db-hobby/db-hobby-21-cost-optimizer). 분산: [25편(복제)](/blog/project/db-hobby/db-hobby-25-replication) → [28편(Raft 합의)](/blog/project/db-hobby/db-hobby-28-raft-consensus) → [33편(리더가 죽어도 살아남는 HA DB)](/blog/project/db-hobby/db-hobby-33-raft-replicated-db). 이 흐름이 시리즈의 결을 압축합니다.

## 전체 목록

### 1부. 저장에서 SQL까지 — 바닥을 쌓다 (1~10)

| 편 | 제목 | 푸는 문제 |
|---|---|---|
| [1](/blog/project/db-hobby/db-hobby-1-storage) | 저장 계층 — 페이지에서 힙까지 | 디스크를 어떻게 페이지·행으로 다루나 |
| [2](/blog/project/db-hobby/db-hobby-2-sql-engine) | SQL 엔진 — 텍스트에서 행까지 | 손으로 쓴 렉서·파서·실행기 |
| [3](/blog/project/db-hobby/db-hobby-3-index-wal) | 인덱스와 WAL — B+Tree와 크래시 복구 | O(log n) 조회 + 크래시에도 안 깨짐 |
| [4](/blog/project/db-hobby/db-hobby-4-transactions) | 트랜잭션 — BEGIN/COMMIT/ROLLBACK | 원자성·내구성을 직접 짓기 |
| [5](/blog/project/db-hobby/db-hobby-5-join-aggregate) | 조인과 집계 | 중첩 루프·해시 조인, GROUP BY |
| [6](/blog/project/db-hobby/db-hobby-6-between-like) | WHERE 채우기 — BETWEEN·LIKE·IN | 와일드카드 매칭 구현 |
| [7](/blog/project/db-hobby/db-hobby-7-benchmark) | 직접 재보기 | 인덱스는 정말 빠른가, 내구성은 얼마나 비싼가 |
| [8](/blog/project/db-hobby/db-hobby-8-explain) | EXPLAIN 짓기 | 플래너의 결정을 눈에 보이게 |
| [9](/blog/project/db-hobby/db-hobby-9-null-storage) | NULL 저장 | null 비트맵과 3값 논리 |
| [10](/blog/project/db-hobby/db-hobby-10-secondary-index) | 보조 인덱스 | PK가 몰래 기대던 가정 갚기 |

### 2부. 격리와 MVCC의 토대 (11~13)

| 편 | 제목 | 푸는 문제 |
|---|---|---|
| [11](/blog/project/db-hobby/db-hobby-11-isolation) | 격리 — 2PL 잠금 | dirty read·lost update 막기 |
| [12](/blog/project/db-hobby/db-hobby-12-2pl-vs-mvcc) | 잠금이냐 버전이냐 | 2PL vs MVCC, 두 철학 |
| [13](/blog/project/db-hobby/db-hobby-13-mvcc) | MVCC 심기 | 가시성 규칙, 그리고 만난 벽 |

### 3부. 복구를 제대로 (14~15)

| 편 | 제목 | 푸는 문제 |
|---|---|---|
| [14](/blog/project/db-hobby/db-hobby-14-steal-undo) | steal + undo | 버퍼 풀보다 큰 트랜잭션이 왜 못 도나 |
| [15](/blog/project/db-hobby/db-hobby-15-noforce-checkpoint) | FORCE를 버리다 | 커밋을 로그 fsync 하나로, WAL=진실의 원천 |

### 4부. MVCC 완성 (16~18)

| 편 | 제목 | 푸는 문제 |
|---|---|---|
| [16](/blog/project/db-hobby/db-hobby-16-delete-xmax) | DELETE는 지우지 않는다 | tombstone→xmax, 모든 읽기 경로에 게이트 |
| [17](/blog/project/db-hobby/db-hobby-17-vacuum) | VACUUM | 지운 것과 치운 것은 다르다, B+Tree 삭제 |
| [18](/blog/project/db-hobby/db-hobby-18-multi-txn) | 다중 트랜잭션 | reader가 writer를 안 막는 걸 진짜로 |

### 5부. 네트워크·동시성·최적화·복제·저장엔진·합의·캡스톤·HA (19~39)

| 편 | 제목 | 푸는 문제 |
|---|---|---|
| [19](/blog/project/db-hobby/db-hobby-19-wire-protocol) | psql 서버 | 진짜 psql이 붙는 PG wire protocol |
| [20](/blog/project/db-hobby/db-hobby-20-thread-safety) | 스레드 안전 버퍼 풀 | 진짜 스레드를 켜면 뭐가 깨지나 |
| [21](/blog/project/db-hobby/db-hobby-21-cost-optimizer) | 비용 기반 옵티마이저 | 플래너가 멍청한 순간을 통계로 고치기 |
| [22](/blog/project/db-hobby/db-hobby-22-latch-crabbing) | latch crabbing | B+Tree를 동시에 타기 |
| [23](/blog/project/db-hobby/db-hobby-23-clustered-vs-heap) | 힙 vs 클러스터드 | PG vs MySQL을 한 코드에서 벤치 |
| [24](/blog/project/db-hobby/db-hobby-24-join-order) | 조인 순서 최적화 | 여러 테이블을 어느 순서로 조인하나 (Selinger DP) |
| [25](/blog/project/db-hobby/db-hobby-25-replication) | WAL 로그 시핑 복제 | primary→replica, 복구의 redo를 스트림으로 |
| [26](/blog/project/db-hobby/db-hobby-26-tcp-replication) | WAL을 소켓으로 | 복제를 진짜 네트워크로 (walsender/walreceiver) |
| [27](/blog/project/db-hobby/db-hobby-27-lsm-engine) | LSM-Tree | 제자리 안 고치는 쓰기 최적 엔진 (B+Tree 대척점) |
| [28](/blog/project/db-hobby/db-hobby-28-raft-consensus) | Raft 합의 | primary가 죽으면? 리더 선출·로그 복제·안전성 |
| [29](/blog/project/db-hobby/db-hobby-29-raft-persistence) | Raft 지속성 | votedFor를 fsync로 — 이중 투표 방지 |
| [30](/blog/project/db-hobby/db-hobby-30-raft-snapshot) | Raft 스냅샷 | 로그 압축·InstallSnapshot, 그리고 log_base=0의 함정 |
| [31](/blog/project/db-hobby/db-hobby-31-replicated-db) | 캡스톤 — 복제를 엔진에 배선 | 독립 모듈을 진짜 복제되는 DB로 (실엔진 WAL 재생→SELECT) |
| [32](/blog/project/db-hobby/db-hobby-32-raft-membership) | Raft 멤버십 변경 | 돌아가는 중에 노드 추가·제거 (겹치는 과반, §6) |
| [33](/blog/project/db-hobby/db-hobby-33-raft-replicated-db) | Raft로 복제되는 HA DB | 실엔진 쓰기를 Raft로 복제, 리더 죽어도 살아남음 (SMR·failover) |
| [34](/blog/project/db-hobby/db-hobby-34-linearizable-reads) | 선형화 읽기 | 파티션된 옛 리더가 낡은 값 못 주게 (ReadIndex, §8) |
| [35](/blog/project/db-hobby/db-hobby-35-lsm-pk-index) | LSM을 진짜 PK 인덱스로 | `USING lsm` — 왜 인덱스는 단순 key→value가 아닌가(MVCC 멀티값) |
| [36](/blog/project/db-hobby/db-hobby-36-parallel-scan) | 병렬 풀 스캔 | 굵은 engine_mtx를 걷어낼 첫 발판 (버퍼 풀 latch 위, ThreadSanitizer 클린) |
| [37](/blog/project/db-hobby/db-hobby-37-parallel-select) | 병렬 스캔을 진짜 SELECT에 배선 | 워커는 가시성+WHERE 판정, leader는 출력 — 직렬과 바이트 동일 |
| [38](/blog/project/db-hobby/db-hobby-38-parallel-aggregate) | 병렬 집계 | 그리고 조용히 틀리던 집계(materialize cap 절단) 버그를 고침 |
| [39](/blog/project/db-hobby/db-hobby-39-partial-aggregate) | 진짜 부분 집계 | 행을 안 모으고 누적만 — 메모리 O(1) (Partial→Finalize) |

## 직접 돌려보기

```sh
git clone https://github.com/dj258255/db-hobby && cd db-hobby
make test            # 677개 테스트
make repl && ./build/db-hobby my.db   # REPL에서 SQL

# 또는 진짜 psql로 접속:
./build/db-hobby my.db --serve 5433
psql "host=127.0.0.1 port=5433 dbname=db-hobby"
```

psql 두 개를 나란히 띄우면, 위 [18편](/blog/project/db-hobby/db-hobby-18-multi-txn)·[19편](/blog/project/db-hobby/db-hobby-19-wire-protocol)의 "reader가 writer를 안 막는다"를 네트워크 너머에서 직접 볼 수 있어요.

## 정직하게 남긴 것

완성이 아니라 **정직한 경계**를 그은 곳들입니다. 조인 순서 옵티마이저(24)·복제(25·26)·LSM(27)·Raft(합의 28·지속성 29·스냅샷 30·멤버십 32)는 **코어까지** 세우고, 그 너머(더 깊은 엔진 통합·joint consensus·진짜 병렬 실행)는 각 편에서 "여기까지, 그 너머는 이런 이유로"라고 명시해 뒀어요. 특히 22·24·27·28편은 400개 넘는 green 테스트를 지키려 **독립 모듈**로 세웠고, [31편(캡스톤)](/blog/project/db-hobby/db-hobby-31-replicated-db)에서 복제를 실제 엔진에 배선하고, [33편](/blog/project/db-hobby/db-hobby-33-raft-replicated-db)에서 **Raft로 실제 엔진을 복제**해 리더가 죽어도 살아남는 **HA DB**까지 이었습니다. 무엇을 안 했는지를 아는 것도 무엇을 했는지만큼 중요하니까요.

<!-- EN -->

## What db-hobby Is

A **mini relational database built from scratch in C** — stacked bottom-up from a single fixed-size page all the way to running SQL. The goal is to reproduce, by hand, how PostgreSQL and MySQL actually work inside, and understand it.

Today db-hobby:

- **A real `psql` connects to it** — a 400-line server speaking PostgreSQL's v3 wire protocol, so psql can't tell it isn't real PG.
- **Readers don't block writers** — MVCC snapshot isolation. Even while one transaction holds an uncommitted UPDATE, another reads the old version, unblocked.
- **WAL crash recovery** (steal + no-force), **VACUUM**, a **thread-safe buffer pool**, a **cost-based optimizer**, **primary→replica replication over a socket**, an **LSM storage engine**, **Raft consensus** (leader election, partition tolerance) — nearly every axis of a real database, touched by hand.
- **677 tests / 40 suites**, concurrency verified under ThreadSanitizer. Code: [github.com/dj258255/db-hobby](https://github.com/dj258255/db-hobby)

## How to Read This Series

The key idea: **each part solves the problem the previous one created** — steal calls for undo, DELETE=xmax calls for VACUUM, a single-threaded server calls for thread safety. Read in order and you follow a "failure → fix → new failure" chain.

Short on time? **The highlights**. Engine: [Part 14 (steal+undo)](/blog/project/db-hobby/db-hobby-14-steal-undo) → [Part 18 (multi-transaction)](/blog/project/db-hobby/db-hobby-18-multi-txn) → [Part 19 (psql server)](/blog/project/db-hobby/db-hobby-19-wire-protocol) → [Part 21 (cost optimizer)](/blog/project/db-hobby/db-hobby-21-cost-optimizer). Distributed: [Part 25 (replication)](/blog/project/db-hobby/db-hobby-25-replication) → [Part 28 (Raft consensus)](/blog/project/db-hobby/db-hobby-28-raft-consensus) → [Part 33 (an HA DB that survives leader death)](/blog/project/db-hobby/db-hobby-33-raft-replicated-db). This arc compresses the series' spirit.

## The Full List

### Part I. From Storage to SQL — Building the Floor (1–10)

| # | Title | Problem it solves |
|---|---|---|
| [1](/blog/project/db-hobby/db-hobby-1-storage) | Storage — pages to heap | how to treat disk as pages and rows |
| [2](/blog/project/db-hobby/db-hobby-2-sql-engine) | SQL engine — text to rows | hand-written lexer, parser, executor |
| [3](/blog/project/db-hobby/db-hobby-3-index-wal) | Index & WAL — B+Tree, crash recovery | O(log n) lookup + surviving a crash |
| [4](/blog/project/db-hobby/db-hobby-4-transactions) | Transactions — BEGIN/COMMIT/ROLLBACK | building atomicity & durability |
| [5](/blog/project/db-hobby/db-hobby-5-join-aggregate) | Joins & aggregates | nested-loop/hash joins, GROUP BY |
| [6](/blog/project/db-hobby/db-hobby-6-between-like) | Filling out WHERE — BETWEEN·LIKE·IN | wildcard matching |
| [7](/blog/project/db-hobby/db-hobby-7-benchmark) | Measure it yourself | is the index really fast; durability's cost |
| [8](/blog/project/db-hobby/db-hobby-8-explain) | Building EXPLAIN | making the planner's choice visible |
| [9](/blog/project/db-hobby/db-hobby-9-null-storage) | Storing NULL | null bitmap, three-valued logic |
| [10](/blog/project/db-hobby/db-hobby-10-secondary-index) | Secondary indexes | paying back the PK's hidden assumptions |

### Part II. Isolation and the MVCC Foundation (11–13)

| # | Title | Problem it solves |
|---|---|---|
| [11](/blog/project/db-hobby/db-hobby-11-isolation) | Isolation — 2PL locks | preventing dirty read / lost update |
| [12](/blog/project/db-hobby/db-hobby-12-2pl-vs-mvcc) | Locks or versions | 2PL vs MVCC, two philosophies |
| [13](/blog/project/db-hobby/db-hobby-13-mvcc) | Grafting MVCC | the visibility rule, and the wall it hits |

### Part III. Recovery Done Right (14–15)

| # | Title | Problem it solves |
|---|---|---|
| [14](/blog/project/db-hobby/db-hobby-14-steal-undo) | steal + undo | why a transaction bigger than the pool fails |
| [15](/blog/project/db-hobby/db-hobby-15-noforce-checkpoint) | Dropping FORCE | commit = one log fsync, WAL as source of truth |

### Part IV. Completing MVCC (16–18)

| # | Title | Problem it solves |
|---|---|---|
| [16](/blog/project/db-hobby/db-hobby-16-delete-xmax) | DELETE doesn't delete | tombstone→xmax, a gate on every read path |
| [17](/blog/project/db-hobby/db-hobby-17-vacuum) | VACUUM | deleting vs cleaning; B+Tree deletion |
| [18](/blog/project/db-hobby/db-hobby-18-multi-txn) | Multi-transaction | readers really not blocking writers |

### Part V. Network, Concurrency, Optimization, Replication, Storage Engines, Consensus, Capstone, HA (19–39)

| # | Title | Problem it solves |
|---|---|---|
| [19](/blog/project/db-hobby/db-hobby-19-wire-protocol) | psql server | a real psql connects, PG wire protocol |
| [20](/blog/project/db-hobby/db-hobby-20-thread-safety) | Thread-safe buffer pool | what breaks when you turn on real threads |
| [21](/blog/project/db-hobby/db-hobby-21-cost-optimizer) | Cost-based optimizer | fixing the planner's dumb moment with stats |
| [22](/blog/project/db-hobby/db-hobby-22-latch-crabbing) | latch crabbing | traversing a B+Tree concurrently |
| [23](/blog/project/db-hobby/db-hobby-23-clustered-vs-heap) | Heap vs clustered | PG vs MySQL, benchmarked in one codebase |
| [24](/blog/project/db-hobby/db-hobby-24-join-order) | Join order optimization | in what order to join many tables (Selinger DP) |
| [25](/blog/project/db-hobby/db-hobby-25-replication) | WAL log-shipping replication | primary→replica, recovery's redo as a stream |
| [26](/blog/project/db-hobby/db-hobby-26-tcp-replication) | WAL over a socket | replication over a real network (walsender/walreceiver) |
| [27](/blog/project/db-hobby/db-hobby-27-lsm-engine) | LSM-Tree | write-optimized, never-in-place engine (B+Tree's counterpart) |
| [28](/blog/project/db-hobby/db-hobby-28-raft-consensus) | Raft consensus | what if the primary dies? election, log replication, safety |
| [29](/blog/project/db-hobby/db-hobby-29-raft-persistence) | Raft persistence | fsync votedFor — preventing the double vote |
| [30](/blog/project/db-hobby/db-hobby-30-raft-snapshot) | Raft snapshots | log compaction, InstallSnapshot, and the log_base=0 trap |
| [31](/blog/project/db-hobby/db-hobby-31-replicated-db) | Capstone — wiring replication into the engine | from standalone module to a real replicated DB (real-engine WAL replay → SELECT) |
| [32](/blog/project/db-hobby/db-hobby-32-raft-membership) | Raft membership changes | add/remove nodes on a live cluster (overlapping majorities, §6) |
| [33](/blog/project/db-hobby/db-hobby-33-raft-replicated-db) | Raft-replicated HA DB | replicate real-engine writes via Raft, survives leader death (SMR, failover) |
| [34](/blog/project/db-hobby/db-hobby-34-linearizable-reads) | Linearizable reads | stop a partitioned old leader serving stale data (ReadIndex, §8) |
| [35](/blog/project/db-hobby/db-hobby-35-lsm-pk-index) | LSM as a real PK index | `USING lsm` — why an index isn't a simple key→value store (MVCC multi-value) |
| [36](/blog/project/db-hobby/db-hobby-36-parallel-scan) | Parallel sequential scan | the first foothold to peel off the coarse engine_mtx (over the buffer-pool latch, ThreadSanitizer-clean) |
| [37](/blog/project/db-hobby/db-hobby-37-parallel-select) | Wiring the parallel scan into SELECT | workers judge visibility+WHERE, the leader prints — byte-identical to serial |
| [38](/blog/project/db-hobby/db-hobby-38-parallel-aggregate) | Parallel aggregation | and fixing an aggregate that was silently wrong (materialize-cap truncation) |
| [39](/blog/project/db-hobby/db-hobby-39-partial-aggregate) | True partial aggregation | accumulate, never collect — O(1) memory (Partial→Finalize) |

## Run It Yourself

```sh
git clone https://github.com/dj258255/db-hobby && cd db-hobby
make test            # 677 tests
make repl && ./build/db-hobby my.db   # SQL in the REPL

# or connect with a real psql:
./build/db-hobby my.db --serve 5433
psql "host=127.0.0.1 port=5433 dbname=db-hobby"
```

Open two psql clients side by side and you'll see "readers don't block writers" from [Part 18](/blog/project/db-hobby/db-hobby-18-multi-txn) and [Part 19](/blog/project/db-hobby/db-hobby-19-wire-protocol) over the network, live.

## What Was Left Honest

Not "unfinished" but places where an **honest boundary** was drawn. The join-ordering optimizer (24), replication (25–26), LSM (27), and Raft (consensus 28, persistence 29, snapshots 30, membership 32) are built **to their cores**, with everything beyond (deeper engine integration, joint consensus, true parallel execution) marked in each part as "this far, and beyond it for these reasons." Parts 22, 24, 27, and 28 in particular stand as **standalone modules** to keep 400+ green tests safe — and [Part 31 (the capstone)](/blog/project/db-hobby/db-hobby-31-replicated-db) **wires replication into the real engine**, and [Part 33](/blog/project/db-hobby/db-hobby-33-raft-replicated-db) **replicates the real engine through Raft** into an **HA DB that survives leader death.** Knowing what you didn't do matters as much as what you did.

---
title: 'db-hobby 전체 지도 — C로 만든 미니 RDBMS, 23편 읽기 가이드'
titleEn: 'The db-hobby Map — a Mini RDBMS in C, a Reading Guide to 23 Parts'
description: "C로 맨땅에서 만든 미니 관계형 DB db-hobby의 23편 시리즈 전체 지도. 진짜 psql이 붙고, reader가 writer를 안 막는 MVCC 스냅샷 격리, WAL 크래시 복구, VACUUM, 스레드 안전 버퍼 풀, 비용 기반 옵티마이저까지 — 페이지 한 장에서 SQL 실행까지 바닥부터 올라간 기록이다. 각 편이 '앞 편이 만든 문제를 다음 편이 푼다'는 장애-해결 사슬로 이어진다. 어디서 시작할지, 무엇이 하이라이트인지, 어떻게 직접 돌려보는지를 한 페이지에 담은 읽기 가이드."
descriptionEn: "The full map of db-hobby, a mini relational database built from scratch in C across 23 parts. A real psql connects to it; MVCC snapshot isolation where readers don't block writers; WAL crash recovery; VACUUM; a thread-safe buffer pool; a cost-based optimizer — built bottom-up from a single page to running SQL. Each part chains as failure-then-fix: the next part solves the problem the previous one created. A one-page reading guide to where to start, what the highlights are, and how to run it yourself."
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
- **WAL 크래시 복구**(steal + no-force), **VACUUM**, **스레드 안전 버퍼 풀**, **비용 기반 옵티마이저**까지 — 진짜 DB의 거의 모든 축을 한 번씩 만졌습니다.
- **테스트 425개 / 28스위트**, 동시성은 ThreadSanitizer로 검증. 코드: [github.com/dj258255/db-hobby](https://github.com/dj258255/db-hobby)

## 이 시리즈를 읽는 법

핵심은 **각 편이 앞 편이 만든 문제를 푼다**는 겁니다 — steal이 undo를 부르고, DELETE=xmax가 VACUUM을 부르고, 단일 스레드 서버가 스레드 안전을 부르는 식으로. 그래서 순서대로 읽으면 "장애 → 해결 → 새 장애" 사슬을 따라가게 돼요.

바쁘면 **하이라이트만**: [14편(steal+undo)](/blog/project/db-hobby/db-hobby-14-steal-undo) → [18편(다중 트랜잭션)](/blog/project/db-hobby/db-hobby-18-multi-txn) → [19편(psql 서버)](/blog/project/db-hobby/db-hobby-19-wire-protocol) → [21편(비용 옵티마이저)](/blog/project/db-hobby/db-hobby-21-cost-optimizer). 이 네 편이 시리즈의 결을 압축합니다.

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

### 5부. 네트워크·동시성·최적화 (19~23)

| 편 | 제목 | 푸는 문제 |
|---|---|---|
| [19](/blog/project/db-hobby/db-hobby-19-wire-protocol) | psql 서버 | 진짜 psql이 붙는 PG wire protocol |
| [20](/blog/project/db-hobby/db-hobby-20-thread-safety) | 스레드 안전 버퍼 풀 | 진짜 스레드를 켜면 뭐가 깨지나 |
| [21](/blog/project/db-hobby/db-hobby-21-cost-optimizer) | 비용 기반 옵티마이저 | 플래너가 멍청한 순간을 통계로 고치기 |
| [22](/blog/project/db-hobby/db-hobby-22-latch-crabbing) | latch crabbing | B+Tree를 동시에 타기 |
| [23](/blog/project/db-hobby/db-hobby-23-clustered-vs-heap) | 힙 vs 클러스터드 | PG vs MySQL을 한 코드에서 벤치 |

## 직접 돌려보기

```sh
git clone https://github.com/dj258255/db-hobby && cd db-hobby
make test            # 425개 테스트
make repl && ./build/db-hobby my.db   # REPL에서 SQL

# 또는 진짜 psql로 접속:
./build/db-hobby my.db --serve 5433
psql "host=127.0.0.1 port=5433 dbname=db-hobby"
```

psql 두 개를 나란히 띄우면, 위 [18편](/blog/project/db-hobby/db-hobby-18-multi-txn)·[19편](/blog/project/db-hobby/db-hobby-19-wire-protocol)의 "reader가 writer를 안 막는다"를 네트워크 너머에서 직접 볼 수 있어요.

## 정직하게 남긴 것

완성이 아니라 **정직한 경계**를 그은 곳들입니다 — 진짜 병렬 실행(엔진 latch 제거)·조인 순서 옵티마이저·분산(복제·Raft)은 각 편에서 "여기까지, 그 너머는 이런 이유로"라고 명시해 뒀어요. 무엇을 안 했는지를 아는 것도 무엇을 했는지만큼 중요하니까요.

<!-- EN -->

## What db-hobby Is

A **mini relational database built from scratch in C** — stacked bottom-up from a single fixed-size page all the way to running SQL. The goal is to reproduce, by hand, how PostgreSQL and MySQL actually work inside, and understand it.

Today db-hobby:

- **A real `psql` connects to it** — a 400-line server speaking PostgreSQL's v3 wire protocol, so psql can't tell it isn't real PG.
- **Readers don't block writers** — MVCC snapshot isolation. Even while one transaction holds an uncommitted UPDATE, another reads the old version, unblocked.
- **WAL crash recovery** (steal + no-force), **VACUUM**, a **thread-safe buffer pool**, a **cost-based optimizer** — nearly every axis of a real database, touched by hand.
- **425 tests / 28 suites**, concurrency verified under ThreadSanitizer. Code: [github.com/dj258255/db-hobby](https://github.com/dj258255/db-hobby)

## How to Read This Series

The key idea: **each part solves the problem the previous one created** — steal calls for undo, DELETE=xmax calls for VACUUM, a single-threaded server calls for thread safety. Read in order and you follow a "failure → fix → new failure" chain.

Short on time? **The highlights**: [Part 14 (steal+undo)](/blog/project/db-hobby/db-hobby-14-steal-undo) → [Part 18 (multi-transaction)](/blog/project/db-hobby/db-hobby-18-multi-txn) → [Part 19 (psql server)](/blog/project/db-hobby/db-hobby-19-wire-protocol) → [Part 21 (cost optimizer)](/blog/project/db-hobby/db-hobby-21-cost-optimizer). These four compress the series' spirit.

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

### Part V. Network, Concurrency, Optimization (19–23)

| # | Title | Problem it solves |
|---|---|---|
| [19](/blog/project/db-hobby/db-hobby-19-wire-protocol) | psql server | a real psql connects, PG wire protocol |
| [20](/blog/project/db-hobby/db-hobby-20-thread-safety) | Thread-safe buffer pool | what breaks when you turn on real threads |
| [21](/blog/project/db-hobby/db-hobby-21-cost-optimizer) | Cost-based optimizer | fixing the planner's dumb moment with stats |
| [22](/blog/project/db-hobby/db-hobby-22-latch-crabbing) | latch crabbing | traversing a B+Tree concurrently |
| [23](/blog/project/db-hobby/db-hobby-23-clustered-vs-heap) | Heap vs clustered | PG vs MySQL, benchmarked in one codebase |

## Run It Yourself

```sh
git clone https://github.com/dj258255/db-hobby && cd db-hobby
make test            # 425 tests
make repl && ./build/db-hobby my.db   # SQL in the REPL

# or connect with a real psql:
./build/db-hobby my.db --serve 5433
psql "host=127.0.0.1 port=5433 dbname=db-hobby"
```

Open two psql clients side by side and you'll see "readers don't block writers" from [Part 18](/blog/project/db-hobby/db-hobby-18-multi-txn) and [Part 19](/blog/project/db-hobby/db-hobby-19-wire-protocol) over the network, live.

## What Was Left Honest

Not "unfinished" but places where an **honest boundary** was drawn — true parallel execution (dropping the engine latch), a join-ordering optimizer, distribution (replication, Raft) are each marked in their parts as "this far, and beyond it for these reasons." Knowing what you didn't do matters as much as what you did.

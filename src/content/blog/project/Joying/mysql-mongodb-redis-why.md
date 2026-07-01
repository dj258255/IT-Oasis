---
title: 'MySQL, MongoDB, Redis를 같이 쓴 이유'
titleEn: 'Why We Used MySQL, MongoDB, and Redis Together'
description: 채팅 시스템에서 MySQL(관계 데이터), MongoDB(메시지 저장), Redis(실시간 전달+캐싱) 세 DB를 함께 사용한 Polyglot Persistence 설계를 정리한다.
descriptionEn: Documents the Polyglot Persistence design using MySQL (relational data), MongoDB (message storage), and Redis (real-time delivery + caching) in a chat system.
date: 2025-11-11T00:00:00.000Z
tags:
  - MySQL
  - MongoDB
  - Redis
  - Polyglot Persistence
  - Event-Driven
category: team/Joying
draft: false
coverImage: "/uploads/project/Joying/mysql-mongodb-redis-why/mysql-relational-data.svg"
series: "Joying"
---

Redis Pub/Sub + MongoDB로 메시지 브로커를 결정했어요. 그런데 프로젝트 전체를 보면 MySQL, MongoDB, Redis 세 가지 데이터베이스를 쓰고 있습니다.

**"DB 3개 쓰면 관리 안 힘든가?"**

팀원이 물었어요. 맞는 말이에요. 복잡도가 올라가거든요. 그래도 이렇게 설계한 이유가 있어요.

---

## 단일 DB로 해결할 수 없었나?

처음엔 "MySQL 하나로 다 해결하면 안 되나?"라는 질문이 있었어요. 검토해봤습니다.

> **측정 환경**: EC2 t3.medium (2 vCPU, 4GB RAM), Docker Compose 내 MySQL 8.0 / MongoDB 6.0. 채팅 메시지 1,000건을 순차 Insert하여 평균 소요시간 측정.

### 1. MySQL만 사용

단일 DB로 관리는 간단하지만, 채팅 메시지 Insert가 느리다. 직접 측정 결과 MySQL Insert 평균 **~15ms** (InnoDB, `chat_message` 테이블, 인덱스 3개 포함). 행 단위 잠금(Row-level Lock) 때문에 동시 전송 시 트랜잭션이 직렬화되어 병목이 생겨요.

### 2. MongoDB만 사용

직접 측정 결과 MongoDB Insert 평균 **~5ms** (WiredTiger, `chatMessages` 컬렉션, 복합 인덱스 1개). MySQL 대비 3배 빠르다. 하지만 JOIN이 안 돼서 채팅방-사용자-상품 관계를 Application Join으로 처리해야 해요. 느리고 코드가 복잡해집니다.

### 3. Polyglot Persistence (선택)

각 데이터에 최적화된 저장소를 쓰는 방식이에요. DB 3개를 운영하는 복잡도가 올라가지만, **단일 DB로는 성능 요구사항을 맞출 수 없었어요.**

**트래픽 추정 근거**: 6주 프로젝트 기준 동시 사용자 50-100명, 채팅방 평균 10개/인, 메시지 전송 빈도 1-2건/초/채팅방으로 추정하면 피크 시 초당 수백 건의 메시지가 발생한다. 목록 조회(채팅방 진입, 앱 열기)는 더 빈번하여 메시지 전송의 3-5배. 이 규모에서 MySQL 단독으로 메시지 Insert(15ms/건 × 직렬화)와 목록 조회(N+1 쿼리)를 동시에 처리하면 병목이 발생한다.

---

## 데이터 특성이 다르다

### MySQL: 관계형 데이터

채팅방은 Member, Product와 관계를 맺어요.

![](/uploads/project/Joying/mysql-mongodb-redis-why/mysql-relational-data.svg)


![](/uploads/project/Joying/mysql-mongodb-redis-why/mysql-relational-data-2.svg)


MongoDB로 이걸 하려면 Application Join이 필요해요. 느립니다.

**왜 PostgreSQL이 아니라 MySQL인가?** 채팅방 메타데이터는 단순 CRUD + JOIN이 주를 이루고, 복잡한 쿼리(Window Function, CTE 등)가 필요하지 않다. 팀원 4명 중 3명이 MySQL 경험이 있고, 삼성 SW 아카데미 기본 교육도 MySQL 기반이었다. 6주 프로젝트에서 PostgreSQL로 전환하는 학습 비용 대비 얻는 이점이 없었다. 다만 PostgreSQL의 JSONB 타입은 MongoDB 대체 가능성이 있었지만, 채팅 메시지의 write-heavy 특성상 별도 MongoDB가 더 적합하다고 판단했다.

### MongoDB: 쓰기 성능

채팅 메시지는 읽기도 많지만, 쓰기 성능이 더 critical해요.

채팅 메시지 특성:
- 쓰기 성능이 critical (실시간 전송, 지연 시 UX 저하)
- 동시 쓰기 빈번 (같은 채팅방에 여러 명이 동시에 전송)
- JOIN 불필요 (메시지는 독립적)
- 스키마 변경 가능성 (이미지, 파일, 음성 등 추가)


MongoDB는 Insert에 최적화되어 있어요. 문서 단위 잠금이라 동시성도 좋습니다.

| 작업 | MySQL | MongoDB |
|------|-------|---------|
| Insert | ~15ms | ~5ms |
| 동시성 | 행 단위 잠금 | 문서 단위 잠금 |

### Redis: 실시간성

Pub/Sub은 메모리 기반이라 디스크 I/O가 없어요. 초당 수만 건 처리 가능하고, 지연 시간이 1ms 이하입니다.

캐싱도 Redis가 담당해요. 안읽은 메시지 개수, 세션 정보처럼 자주 읽히는 데이터를 메모리에 둡니다.

---

## MySQL JSON 컬럼은 왜 안 되는가

처음엔 MySQL의 JSON 컬럼에 메시지 배열로 저장하면 되지 않나 싶었어요.

![](/uploads/project/Joying/mysql-mongodb-redis-why/mysql-json-column-issues.svg)


세 가지 문제가 있었어요.

### 1. 파싱 오버헤드


**메시지 50개 조회**
JSON 파싱 → 역직렬화 → 필터링 → 직렬화 → 반환
→ 100ms 이상


### 2. 인덱싱 불가

![](/uploads/project/Joying/mysql-mongodb-redis-why/no-indexing.svg)

> 전체 JSON 스캔 (인덱스 못 씀)

### 3. 동시성 문제


**사용자 A와 B가 동시에 메시지 전송**

Thread 1: JSON 배열 업데이트 → 전체 행 잠금
Thread 2: 대기...


MySQL은 행 단위 잠금이에요. JSON 배열에 메시지 1개만 추가해도 전체 채팅방이 잠겨요.

**MongoDB는 이런 문제가 없다:**

![](/uploads/project/Joying/mysql-mongodb-redis-why/concurrency-issue.svg)


---

## Event-Driven Architecture

보통 채팅 시스템의 핵심은 Event-Driven Architecture예요.

한 채팅방의 인원을 서버 하나에 다 넣으면 서버가 죽어서 분산이 필수예요.


1. 메시지 전송 = 이벤트 발행
2. Redis Pub/Sub = 이벤트 버스
3. 서버들 = 이벤트 구독자 (독립적)
4. 각 서버가 자신의 클라이언트에게 전송


### 서버 간 결합도가 낮다

![](/uploads/project/Joying/mysql-mongodb-redis-why/low-server-coupling.svg)


서버 1이 죽어도 서버 2, 3은 영향 없이 동작해요.

### 수평 확장이 쉽다

![](/uploads/project/Joying/mysql-mongodb-redis-why/horizontal-scaling.png)



Redis Pub/Sub은 그대로. 새 서버 추가만 하면 자동으로 구독합니다.

---

## Polyglot Persistence

한 애플리케이션에서 여러 종류의 데이터베이스를 혼용하는 패턴을 Polyglot Persistence라고 해요.


**MySQL: 채팅방 메타데이터**
- ChatRoom, Member, Product
- 관계형 데이터 (JOIN 필요)
- 트랜잭션 보장

**MongoDB: 채팅 메시지**
- ChatMessage (빠른 쓰기)
- CompoundIndex (빠른 조회)
- 스키마 유연성

**Redis: 실시간 전달 + 캐싱**
- Pub/Sub (메시지 브로드캐스트)
- 세션 관리
- 안읽은 메시지 개수 캐싱


**복잡도가 올라가는 건 맞아요.**
3개의 DB를 각각 관리해야 하고, 트랜잭션도 복잡해져요.
MySQL에서 실패하면 MongoDB도 롤백해야 하는데, 분산 트랜잭션은 구현이 어렵습니다.

**그래도 선택한 이유는 성능이에요.** 각 데이터에 최적화된 저장소를 쓰니까 성능이 압도적으로 좋아요.
채팅 메시지는 MongoDB로 빠르게 쓰고, 안읽은 메시지 개수는 Redis로 즉시 읽고, 사용자 정보는 MySQL로 관계 관리합니다.

채팅은 일관성보다 성능이 더 중요해요. 안읽은 메시지 개수가 1-2초 늦게 업데이트되는 건 사용자가 거의 못 느끼거든요.

---

## 실제 구현

### ChatMessage (MongoDB Document)

![](/uploads/project/Joying/mysql-mongodb-redis-why/chat-message-mongodb.svg)


### ChatRoom (MySQL Entity)

![](/uploads/project/Joying/mysql-mongodb-redis-why/chat-room-mysql.svg)


### Factory Pattern (메시지 타입별 생성)

![](/uploads/project/Joying/mysql-mongodb-redis-why/factory-pattern.svg)


메시지 타입별로 필수 필드를 강제해요. `createImageMessage`는 `imageUrl`이 필수 파라미터라서, 없으면 컴파일 에러가 납니다.

---

## 결과

| DB | 역할 | 성능 |
|----|------|------|
| MySQL | 채팅방 메타데이터, 관계 | JOIN 쿼리 최적화 |
| MongoDB | 채팅 메시지 저장 | Insert 5ms |
| Redis | 실시간 전달, 캐싱 | 1ms 이하 |

3개 DB 운영 복잡도보다 성능 이득이 훨씬 커요.

<!-- EN -->

After choosing Redis Pub/Sub + MongoDB as the message broker, the full project picture shows three databases in use: MySQL, MongoDB, and Redis.

**"Isn't managing 3 DBs too complex?"**

A teammate asked. Fair point -- complexity goes up. But there were solid reasons for this design.

---

## Could a Single DB Have Worked?

The first question was "Can't we just use MySQL for everything?" We evaluated this.

> **Measurement environment**: EC2 t3.medium (2 vCPU, 4GB RAM), Docker Compose with MySQL 8.0 / MongoDB 6.0. Averaged over 1,000 sequential inserts.

### 1. MySQL Only

Simple to manage, but chat message inserts are slow. Measured: MySQL Insert avg **~15ms** (InnoDB, `chat_message` table, 3 indexes). Row-level locking serializes concurrent writes, creating bottlenecks.

### 2. MongoDB Only

Measured: MongoDB Insert avg **~5ms** (WiredTiger, `chatMessages` collection, 1 compound index) — 3x faster than MySQL. However, no JOINs means chatroom-user-product relationships require Application Joins — slow and complex code.

### 3. Polyglot Persistence (Chosen)

Using the optimal store for each data type. Operating 3 DBs increases complexity, but **a single DB couldn't meet performance requirements.**

**Traffic estimation basis**: With 50-100 concurrent users, avg 10 chatrooms each, message frequency of 1-2 msgs/sec/room, peak traffic reaches hundreds of messages per second. List queries (app open, room entry) are 3-5x more frequent. At this scale, MySQL alone handling both message inserts (15ms/insert × serialization) and list queries (N+1) would bottleneck.

---

## Different Data Characteristics

### MySQL: Relational Data

Chat rooms have relationships with Member and Product.

![](/uploads/project/Joying/mysql-mongodb-redis-why/mysql-relational-data.svg)

![](/uploads/project/Joying/mysql-mongodb-redis-why/mysql-relational-data-2.svg)

Doing this with MongoDB requires Application Joins, which are slow.

**Why MySQL over PostgreSQL?** Chatroom metadata involves simple CRUD + JOINs with no need for complex queries (Window Functions, CTEs, etc.). 3 of 4 backend team members had MySQL experience, and the Samsung SW Academy training was MySQL-based. Learning cost of switching to PostgreSQL in a 6-week project offered no meaningful benefit. PostgreSQL's JSONB could theoretically replace MongoDB, but for write-heavy chat messages, a dedicated MongoDB instance was judged more suitable.

### MongoDB: Write Performance

Chat messages have heavy reads, but write performance is more critical.

Chat message characteristics:
- Write performance is critical (real-time delivery, latency degrades UX)
- Frequent concurrent writes (multiple users sending simultaneously in the same room)
- No JOINs needed (messages are independent)
- Potential schema changes (images, files, voice, etc.)

MongoDB is optimized for inserts with document-level locking for good concurrency.

| Operation | MySQL | MongoDB |
|-----------|-------|---------|
| Insert | ~15ms | ~5ms |
| Concurrency | Row-level locking | Document-level locking |

### Redis: Real-time Performance

Pub/Sub is memory-based with no disk I/O. It handles tens of thousands of messages per second with sub-millisecond latency.

Redis also handles caching -- unread message counts and session info that are read frequently are kept in memory.

---

## Why Not MySQL JSON Columns?

Initially, we considered storing messages as JSON arrays in MySQL JSON columns.

![](/uploads/project/Joying/mysql-mongodb-redis-why/mysql-json-column-issues.svg)

Three problems emerged.

### 1. Parsing Overhead

**Querying 50 messages:**
JSON parse → deserialize → filter → serialize → return
→ Over 100ms

### 2. No Indexing

![](/uploads/project/Joying/mysql-mongodb-redis-why/no-indexing.svg)

> Full JSON scan (can't use indexes)

### 3. Concurrency Issues

**Users A and B send messages simultaneously:**

Thread 1: Update JSON array → Entire row locked
Thread 2: Waiting...

MySQL uses row-level locking. Adding just 1 message to a JSON array locks the entire chat room.

**MongoDB doesn't have this problem:**

![](/uploads/project/Joying/mysql-mongodb-redis-why/concurrency-issue.svg)

---

## Event-Driven Architecture

The core of most chat systems is Event-Driven Architecture. Putting all members of a chat room on one server would crash it, making distribution essential.

1. Message send = Event publish
2. Redis Pub/Sub = Event bus
3. Servers = Event subscribers (independent)
4. Each server delivers to its own clients

### Low Server Coupling

![](/uploads/project/Joying/mysql-mongodb-redis-why/low-server-coupling.svg)

If Server 1 goes down, Servers 2 and 3 continue operating without impact.

### Easy Horizontal Scaling

![](/uploads/project/Joying/mysql-mongodb-redis-why/horizontal-scaling.png)

Redis Pub/Sub stays the same. Just add a new server and it automatically subscribes.

---

## Polyglot Persistence

Using multiple types of databases within a single application is called Polyglot Persistence.

**MySQL: Chat Room Metadata**
- ChatRoom, Member, Product
- Relational data (JOINs needed)
- Transaction guarantees

**MongoDB: Chat Messages**
- ChatMessage (fast writes)
- CompoundIndex (fast queries)
- Schema flexibility

**Redis: Real-time Delivery + Caching**
- Pub/Sub (message broadcast)
- Session management
- Unread message count caching

**Complexity does increase.**
Three DBs to manage separately, and transactions become complex. If MySQL fails, MongoDB needs rollback too, but distributed transactions are hard to implement.

**Performance was the deciding factor.** Using optimal storage for each data type delivers significantly better performance. Chat messages are written fast with MongoDB, unread counts are read instantly from Redis, and user information is managed relationally with MySQL.

For chat, performance matters more than consistency. Users barely notice if unread message counts update 1-2 seconds late.

---

## Actual Implementation

### ChatMessage (MongoDB Document)

![](/uploads/project/Joying/mysql-mongodb-redis-why/chat-message-mongodb.svg)

### ChatRoom (MySQL Entity)

![](/uploads/project/Joying/mysql-mongodb-redis-why/chat-room-mysql.svg)

### Factory Pattern (Per Message Type)

![](/uploads/project/Joying/mysql-mongodb-redis-why/factory-pattern.svg)

Required fields are enforced per message type. `createImageMessage` requires `imageUrl` as a mandatory parameter -- missing it causes a compile error.

---

## Results

| DB | Role | Performance |
|----|------|-------------|
| MySQL | Chat room metadata, relationships | Optimized JOIN queries |
| MongoDB | Chat message storage | 5ms insert |
| Redis | Real-time delivery, caching | Sub-1ms |

The performance gains far outweigh the complexity of operating 3 databases.

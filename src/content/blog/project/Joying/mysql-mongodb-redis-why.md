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
category: project/Joying
draft: false
---

Redis Pub/Sub + MongoDB로 메시지 브로커를 결정했다. 그런데 프로젝트 전체를 보면 MySQL, MongoDB, Redis 세 가지 데이터베이스를 쓰고 있다.

**"DB 3개 쓰면 관리 안 힘든가?"**

팀원이 물었다. 맞는 말이다. 복잡도가 올라간다. 그래도 이렇게 설계한 이유가 있다.

---

## 단일 DB로 해결할 수 없었나?

처음엔 "MySQL 하나로 다 해결하면 안 되나?"라는 질문이 있었다. 검토해봤다.

### 1. MySQL만 사용

단일 DB로 관리는 간단하지만, 채팅 메시지 Insert가 느리고(~15ms), 행 단위 잠금 때문에 동시 전송 시 병목이 생긴다.

### 2. MongoDB만 사용

메시지 저장은 빠르지만(~5ms), JOIN이 안 돼서 채팅방-사용자-상품 관계를 Application Join으로 처리해야 한다. 느리고 코드가 복잡해진다.

### 3. Polyglot Persistence (선택)

각 데이터에 최적화된 저장소를 쓰는 방식이다. DB 3개를 운영하는 복잡도가 올라가지만, 채팅 메시지가 초당 수백 건 발생하고 목록 조회가 빈번한 상황에서 **단일 DB로는 성능 요구사항을 맞출 수 없었다.**

---

## 데이터 특성이 다르다

### MySQL: 관계형 데이터

채팅방은 Member, Product와 관계를 맺는다.

![](/uploads/project/Joying/mysql-mongodb-redis-why/mysql-relational-data.svg)


![](/uploads/project/Joying/mysql-mongodb-redis-why/mysql-relational-data-2.svg)


MongoDB로 이걸 하려면 Application Join이 필요하다. 느리다.

### MongoDB: 쓰기 성능

채팅 메시지는 읽기도 많지만, 쓰기 성능이 더 critical하다.

채팅 메시지 특성:
- 쓰기 성능이 critical (실시간 전송, 지연 시 UX 저하)
- 동시 쓰기 빈번 (같은 채팅방에 여러 명이 동시에 전송)
- JOIN 불필요 (메시지는 독립적)
- 스키마 변경 가능성 (이미지, 파일, 음성 등 추가)


MongoDB는 Insert에 최적화되어 있다. 문서 단위 잠금이라 동시성도 좋다.

| 작업 | MySQL | MongoDB |
|------|-------|---------|
| Insert | ~15ms | ~5ms |
| 동시성 | 행 단위 잠금 | 문서 단위 잠금 |

### Redis: 실시간성

Pub/Sub은 메모리 기반이라 디스크 I/O가 없다. 초당 수만 건 처리 가능하고, 지연 시간이 1ms 이하다.

캐싱도 Redis가 담당한다. 안읽은 메시지 개수, 세션 정보처럼 자주 읽히는 데이터를 메모리에 둔다.

---

## MySQL JSON 컬럼은 왜 안 되는가

처음엔 MySQL의 JSON 컬럼에 메시지 배열로 저장하면 되지 않나 싶었다.

![](/uploads/project/Joying/mysql-mongodb-redis-why/mysql-json-column-issues.svg)


세 가지 문제가 있었다.

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


MySQL은 행 단위 잠금이다. JSON 배열에 메시지 1개만 추가해도 전체 채팅방이 잠긴다.

**MongoDB는 이런 문제가 없다:**

![](/uploads/project/Joying/mysql-mongodb-redis-why/concurrency-issue.svg)


---

## Event-Driven Architecture

보통 채팅 시스템의 핵심은 Event-Driven Architecture다.

한 채팅방의 인원을 서버 하나에 다 넣으면 서버가 죽어서 분산이 필수다.


1. 메시지 전송 = 이벤트 발행
2. Redis Pub/Sub = 이벤트 버스
3. 서버들 = 이벤트 구독자 (독립적)
4. 각 서버가 자신의 클라이언트에게 전송


### 서버 간 결합도가 낮다

![](/uploads/project/Joying/mysql-mongodb-redis-why/low-server-coupling.svg)


서버 1이 죽어도 서버 2, 3은 영향 없이 동작한다.

### 수평 확장이 쉽다

![](/uploads/project/Joying/mysql-mongodb-redis-why/horizontal-scaling.png)



Redis Pub/Sub은 그대로. 새 서버 추가만 하면 자동으로 구독한다.

---

## Polyglot Persistence

한 애플리케이션에서 여러 종류의 데이터베이스를 혼용하는 패턴을 Polyglot Persistence라고 한다.


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


**복잡도가 올라가는 건 맞다.**
3개의 DB를 각각 관리해야 하고, 트랜잭션도 복잡해진다.
MySQL에서 실패하면 MongoDB도 롤백해야 하는데, 분산 트랜잭션은 구현이 어렵다.

**그래도 선택한 이유는 성능이다.** 각 데이터에 최적화된 저장소를 쓰니까 성능이 압도적으로 좋다.
채팅 메시지는 MongoDB로 빠르게 쓰고, 안읽은 메시지 개수는 Redis로 즉시 읽고, 사용자 정보는 MySQL로 관계 관리한다.

채팅은 일관성보다 성능이 더 중요하다. 안읽은 메시지 개수가 1-2초 늦게 업데이트되는 건 사용자가 거의 못 느낀다.

---

## 실제 구현

### ChatMessage (MongoDB Document)

![](/uploads/project/Joying/mysql-mongodb-redis-why/chat-message-mongodb.svg)


### ChatRoom (MySQL Entity)

![](/uploads/project/Joying/mysql-mongodb-redis-why/chat-room-mysql.svg)


### Factory Pattern (메시지 타입별 생성)

![](/uploads/project/Joying/mysql-mongodb-redis-why/factory-pattern.svg)


메시지 타입별로 필수 필드를 강제한다. `createImageMessage`는 `imageUrl`이 필수 파라미터라서, 없으면 컴파일 에러가 난다.

---

## 결과

| DB | 역할 | 성능 |
|----|------|------|
| MySQL | 채팅방 메타데이터, 관계 | JOIN 쿼리 최적화 |
| MongoDB | 채팅 메시지 저장 | Insert 5ms |
| Redis | 실시간 전달, 캐싱 | 1ms 이하 |

3개 DB 운영 복잡도보다 성능 이득이 훨씬 크다.

<!-- EN -->

After choosing Redis Pub/Sub + MongoDB as the message broker, the full project picture shows three databases in use: MySQL, MongoDB, and Redis.

**"Isn't managing 3 DBs too complex?"**

A teammate asked. Fair point -- complexity goes up. But there were solid reasons for this design.

---

## Could a Single DB Have Worked?

The first question was "Can't we just use MySQL for everything?" We evaluated this.

### 1. MySQL Only

Simple to manage with a single DB, but chat message inserts are slow (~15ms), and row-level locking creates bottlenecks during concurrent sends.

### 2. MongoDB Only

Message storage is fast (~5ms), but no JOINs means chatroom-user-product relationships require Application Joins -- slow and complex code.

### 3. Polyglot Persistence (Chosen)

Using the optimal store for each data type. Operating 3 DBs increases complexity, but with hundreds of chat messages per second and frequent list queries, **a single DB couldn't meet performance requirements.**

---

## Different Data Characteristics

### MySQL: Relational Data

Chat rooms have relationships with Member and Product.

![](/uploads/project/Joying/mysql-mongodb-redis-why/mysql-relational-data.svg)

![](/uploads/project/Joying/mysql-mongodb-redis-why/mysql-relational-data-2.svg)

Doing this with MongoDB requires Application Joins, which are slow.

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

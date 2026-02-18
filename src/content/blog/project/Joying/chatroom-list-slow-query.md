---
title: '채팅방 목록 조회에 1.3초가 걸렸다'
titleEn: 'Chatroom List Query Took 1.3 Seconds'
description: N+1 Query로 1.3초 걸리던 채팅방 목록 조회를 Fetch Join + 배치 조회 + Redis 캐싱(MGET)으로 85ms까지 최적화한 과정을 정리한다.
descriptionEn: Optimizes chatroom list query from 1.3 seconds (N+1 Query) to 85ms using Fetch Join, batch queries, and Redis caching with MGET.
date: 2025-11-26T00:00:00.000Z
tags:
  - N+1 Query
  - Fetch Join
  - Redis
  - MGET
  - Cache
  - MongoDB
category: project/Joying
draft: false
---

MongoDB + Redis Pub/Sub 아키텍처를 설계했다. 이제 채팅방 목록 조회 API를 만들 차례였다.

---

## 문제 상황

채팅방 목록에는 생각보다 많은 정보가 필요했다.


채팅방 목록에 보여줄 정보:
>
1. 채팅방 기본 정보 - MySQL (ChatRoom)
2. 상품 정보 (제목, 썸네일) - MySQL (Product, ProductFile)
3. 상대방 정보 (닉네임, 프로필) - MySQL (Member, profileImage)
4. 마지막 메시지 내용/시간 - MySQL (lastMessage, lastMessageAt)
5. 채팅방 설정 (고정, 알림끄기) - MySQL (ChatRoomMember)
6. 안읽은 메시지 개수 - MongoDB (count 쿼리)


DTO 필드만 해도 이 정도였다:

![](/uploads/project/Joying/chatroom-list-slow-query/problem.svg)



가장 직관적인 방법으로 구현했다.

![](/uploads/project/Joying/chatroom-list-slow-query/problem-2.svg)


테스트 환경을 설정하고 측정했다.


테스트 환경:
- 사용자: 100명
- 총 채팅방: 500개 (사용자당 평균 10개)
- 채팅방당 평균 메시지: 150개
- MongoDB 총 메시지: 75,000개


채팅방 10개를 조회하면:

![](/uploads/project/Joying/chatroom-list-slow-query/problem-3.png)


**1.35초가 걸렸다.** 채팅방이 많아질수록 선형으로 느려졌다.

---

## N+1 Query 문제

핵심 문제는 N+1 Query였다. 채팅방 N개에 대해 여러 종류의 추가 쿼리가 발생했다.

채팅방 10개 조회 시 발생하는 쿼리:
>
1. ChatRoom 목록 조회 (1번)
2. Product 조회: N번 (Lazy Loading)
3. Member 조회: N번 (Lazy Loading)
4. ProductFile 조회: N번 (썸네일)
5. ChatRoomMember 조회: N번 (설정)
6. MongoDB count 조회: N번 (안읽은 개수)
>총 쿼리 수: 1 + 5N


가장 느린 건 MongoDB count 쿼리였다. 쿼리 1번당 평균 100ms가 걸렸다.

>
MongoDB count 쿼리 과정:
1. 네트워크 RTT (서버 -> MongoDB)
2. 인덱스 탐색 (B-Tree 순회)
3. 조건에 맞는 메시지 개수 계산
4. 결과 반환
>-> 디스크 I/O가 병목

MongoDB가 느린 게 아니라, 쿼리를 너무 많이 날리는 것이 문제였다.

### 해결: Fetch Join + 배치 조회 + Redis 캐싱

최적화 후:

1. ChatRoom + Product + Member: 1번 (Fetch Join)
2. ChatRoomMember 설정: 1번 (배치 조회)
3. ProductFile 썸네일: 1번 (배치 조회)
4. 안읽은 개수: 1번 (Redis MGET)

총 쿼리 수: 4번

MySQL N+1은 Fetch Join과 배치 조회로 해결했다. MongoDB N+1은 Redis 캐싱으로 해결했다.

---

## 시도 1: MySQL 반정규화 (실패)

처음엔 MySQL에 `unreadCount` 컬럼을 추가하면 되지 않을까 싶었다.

![](/uploads/project/Joying/chatroom-list-slow-query/mysql-denormalization.svg)


세 가지 문제가 있었다.

### 데이터 정합성 문제


메시지 전송 시:
1. MongoDB에 메시지 저장
2. MySQL unreadCount 증가

MongoDB 저장 성공, MySQL 업데이트 실패?
-> 메시지는 있는데 안읽은 개수는 안 늘어남


### 분산 트랜잭션 필요


MongoDB와 MySQL 간 트랜잭션을 어떻게 보장하나?

2PC (Two-Phase Commit)?
- 구현 복잡
- 성능 오버헤드
- 장애 지점 증가


### 동시성 문제

사용자 A와 B가 동시에 메시지 전송:

Thread 1: unreadCount = 5 읽음
Thread 2: unreadCount = 5 읽음
Thread 1: unreadCount = 6으로 업데이트
Thread 2: unreadCount = 6으로 업데이트
-> 실제론 7이어야 하는데 6


분산 락이 필요하고, 복잡도가 급격히 올라갔다.

---

## 캐싱 전략 검토

N+1 문제를 해결하기 위한 캐싱 방법을 검토했다.

### 1. 애플리케이션 메모리 캐시 (HashMap)

![](/uploads/project/Joying/chatroom-list-slow-query/app-memory-cache.svg)

서버 JVM 힙에 캐시를 두면 빠르지만, 재시작하면 사라지고 서버를 여러 대로 확장하면 동기화가 안 된다.

### 2. MySQL 반정규화

위에서 다뤘듯이 분산 트랜잭션과 동시성 문제가 발생한다.

### 3. MongoDB Aggregation Pipeline

![](/uploads/project/Joying/chatroom-list-slow-query/mongodb-aggregation.svg)

채팅방별로 안읽은 메시지를 한 번에 집계할 수 있지만, 집계 연산 자체가 무겁고 매번 계산하므로 캐싱 효과가 없다.

### 4. Redis 캐싱 (선택)

메모리 기반이라 1ms 미만으로 빠르고, 이미 Redis Pub/Sub을 사용 중이라 추가 인프라가 필요 없다. `INCR/DECR`로 원자적 증감이 가능해서 분산 락도 불필요하다. 캐시와 DB 간 불일치(Eventual Consistency)가 발생할 수 있지만, 안읽은 메시지 개수가 1-2초 늦게 업데이트되어도 사용자가 거의 못 느낀다. 일관성보다 성능이 더 중요한 데이터였다.

---

## 캐시 일관성 전략

캐시 일관성 전략에는 여러 가지가 있다.


**Write-through**
쓰기 시 캐시와 DB 동시 업데이트
**Write-behind**
쓰기 시 캐시만 업데이트, 나중에 DB 반영
**Cache-aside**
읽기 시 캐시 확인 -> 없으면 DB 조회 -> 캐시에 저장


우리는 **Write-through + Cache-aside 혼합**을 선택했다.

- 메시지 전송 시: Redis INCR (Write-through처럼 즉시 반영)
- 읽음 처리 시: Redis DEL (캐시 무효화)
- 조회 시: Redis 확인 -> 없으면 MongoDB에서 계산 후 캐싱 (Cache-aside)

Write-behind는 메시지 유실 위험이 있어서 제외했다. 채팅에서 "안읽은 개수"가 실제보다 적게 보이는 건 치명적이다.

---

## 왜 Redis인가

```
MongoDB 조회: 100ms (디스크 I/O)
Redis 조회: 1ms 미만 (메모리)

-> 100배 빠름
```

추가 인프라 없이 바로 적용 가능했다.

---

## 왜 Redis 캐싱이 효과적인가

채팅방 목록은 같은 사용자가 반복 조회하는 데이터다. 사용자 A가 09:00에 목록을 보고 09:01에 다시 보면, 같은 안읽은 개수를 또 계산할 이유가 없다. 이런 **시간 지역성**이 높은 데이터는 캐싱 효과가 극대화된다.

Redis는 LRU(Least Recently Used)로 캐시를 관리한다. 활성 사용자의 데이터는 자주 조회되어 캐시에 유지되고, 비활성 사용자의 데이터는 자동으로 제거된다.

우리 시스템 기준으로 추산하면:

```
전체 채팅방: 10,000개
활성 채팅방(Working Set): 2,000개 (20%)
Redis 메모리 필요량: 2,000개 x 100 bytes = 200 KB
실제 Redis 할당: 1 GB
-> Working Set이 충분히 메모리에 들어감
-> 캐시 히트율 95% 이상 달성
```

### 캐시 키 설계


Redis Key: "unread:{chatRoomId}:{memberId}"
Value: "5" (안읽은 개수)
TTL: 7일


---

## Redis MGET: 조회 10번을 1번으로

Redis에서 여러 값을 조회할 때 가장 중요한 건 명령 실행 횟수를 줄이는 것이다.

### 잘못된 방식

![](/uploads/project/Joying/chatroom-list-slow-query/wrong-approach.svg)


### 올바른 방식

![](/uploads/project/Joying/chatroom-list-slow-query/right-approach.svg)


### 성능 비교

```
개별 조회 (GET 10번):
- 명령 파싱 x 10
- 결과 반환 x 10
-> 총 10ms

MGET (1번):
- 명령 파싱 x 1
- 결과 배치 반환 x 1
-> 총 1ms

-> 10배 빠름
```

Redis는 싱글 스레드로 동작한다. 명령을 10번 보내면 파싱 오버헤드가 10번 누적된다. MGET은 이걸 1번으로 줄인다.

---

## Cache Warming 전략

Redis 캐싱에서 가장 중요한 건 캐시 히트율이다.


>캐시 히트율 = 캐시에서 찾은 횟수 / 전체 조회 횟수


캐시 미스가 발생하면 MongoDB를 조회해야 해서 느려진다.

### 캐시를 미리 채우는 시점

>
1. 메시지 전송 시: 상대방 안읽은 개수 증가
   -> INCR unread:{chatRoomId}:{receiverId}
2. 읽음 처리 시: Redis 초기화
   -> DEL unread:{chatRoomId}:{memberId}
3. 캐시 미스 시: MongoDB에서 계산 후 Redis에 저장
   -> SET unread:{chatRoomId}:{memberId} {count} EX 604800


### 실제 동작
![](/uploads/project/Joying/chatroom-list-slow-query/actual-behavior.png)

---

## 실제 구현

### UnreadCountService
![](/uploads/project/Joying/chatroom-list-slow-query/unread-count-service.svg)


### 채팅방 목록 조회 개선

![](/uploads/project/Joying/chatroom-list-slow-query/chatroom-list-improvement.svg)

---

## 결과

**테스트 환경**
- 사용자: 100명
- 총 채팅방: 500개 (사용자당 평균 10개)
- 채팅방당 평균 메시지: 150개
- MongoDB 총 메시지: 75,000개

**최적화 후 쿼리 시간**
1. ChatRoom + Product + Member (Fetch Join): 50ms
2. ChatRoomMember 배치 조회: 15ms
3. ProductFile 배치 조회: 15ms
4. Redis MGET (캐시 히트율 95%): 5ms
총: 85ms


| 지표 | Before | After |
|------|--------|-------|
| 채팅방 개수 | 10개 | 10개 |
| 총 쿼리 수 | 51번 | 4번 |
| 총 소요 시간 | 1350ms | 85ms |
| 캐시 히트율 | - | 95% |

**16배 빨라졌다.**

---

## 후기

사실 이게 맞나 싶었다.

안읽은 메시지 개수를 Redis에 캐싱하고, INCR/DEL로 관리하는 게 "정석"인지 확신이 없었다. 혹시 더 좋은 방법이 있는데 모르는 건 아닐까?

### 대규모 서비스에서의 Redis 캐싱 사례

찾아보니 대형 서비스들도 비슷한 패턴을 쓰고 있었다.

**Twitter**는 타임라인 서비스에 Redis를 사용한다. 초당 3,900만 건(39MM QPS)의 요청을 처리하고, 10,000개 이상의 Redis 인스턴스로 105TB의 데이터를 관리한다. 각 사용자의 타임라인에 최근 800개의 트윗 ID를 Redis에 저장하고, 이를 통해 빠른 조회를 제공한다.

> 출처: [How Twitter Uses Redis to Scale - High Scalability](http://highscalability.com/blog/2014/9/8/how-twitter-uses-redis-to-scale-105tb-ram-39mm-qps-10000-ins.html)

**Pinterest**도 수십억 개의 관계 데이터를 Redis에 캐싱한다. 사용자 ID 공간을 8192개의 가상 샤드로 나누고, 여러 Redis 인스턴스에 분산 저장한다. "이 사용자가 이 보드를 팔로우하는가?" 같은 빈번한 조회를 Redis로 처리한다.

> 출처: [Using Redis at Pinterest for Billions of Relationships - VMware Tanzu](https://blogs.vmware.com/tanzu/using-redis-at-pinterest-for-billions-of-relationships/)

### 국내 기업들의 Redis 캐싱 사례

국내 대형 서비스들도 비슷한 패턴을 사용하고 있었다.

**카카오페이**는 로컬 캐시와 Redis를 목적에 따라 구분해서 사용한다. 자주 변하지 않는 조회성 데이터(상품, 통신사, 혜택 등)는 로컬 캐시에, 세션이나 자주 변경되는 동적 데이터는 Redis에 저장한다. Redis Pub/Sub으로 데이터 변경 이벤트를 발행하고, 각 서버가 구독해서 로컬 캐시를 무효화하는 방식으로 최종 일관성(Eventual Consistency)을 달성한다.

> 출처: [분산 시스템에서 로컬 캐시 활용하기 - 카카오페이 기술 블로그](https://tech.kakaopay.com/post/local-caching-in-distributed-systems/)

**토스**는 Redis를 인메모리 캐시로 사용하면서 캐시 쇄도(Cache Stampede), 캐시 관통(Cache Penetration), 핫키 만료 등의 문제를 해결하기 위해 다양한 전략을 적용한다. 특히 핫키 만료 시 Redis의 싱글 스레드 특성을 활용한 레드락(Redlock) 알고리즘으로 분산 락을 구현한다.

> 출처: [캐시 문제 해결 가이드 - 토스 기술 블로그](https://toss.tech/article/cache-traffic-tip)

**올리브영**은 로컬 캐시(Caffeine)와 Redis를 결합한 다중 레이어 캐시를 적용했다. Redis만 사용했을 때 네트워크 송신량이 높아지자, 로컬 캐시를 1차로 두고 Redis를 2차로 두는 구조로 변경했다. 결과적으로 TPS는 478% 증가하고, Redis 네트워크 송신량은 99.1% 감소했다.

> 출처: [고성능 캐시 아키텍처 설계 - 올리브영 테크블로그](https://oliveyoung.tech/2024-12-10/present-promotion-multi-layer-cache/)

안읽은 개수처럼 자주 조회되고, 정확도보다 속도가 중요한 데이터는 Redis 캐싱이 사실상 표준이었다.

### 6주 프로젝트의 한계

다만 현업과 다른 점도 있었다.


#### 6주 프로젝트에서 못 한 것
- 캐시 정합성 모니터링 (Redis와 MongoDB 값이 어긋나면?)
- 캐시 장애 시 폴백 전략 (Redis 죽으면?)
- 부하 테스트 기반 TTL 튜닝
- 캐시 워밍 배치 작업


특히 **캐시 정합성 검증 로직**을 못 만든 게 아쉬웠다. 현재 구현은 "캐시가 항상 맞다"고 가정하는데, 실무에서는 "캐시가 틀릴 수 있다"고 가정하고 검증 로직을 넣는다.

```kotlin
// 만들고 싶었던 검증 배치
@Scheduled(cron = "0 0 4 * * *")  // 매일 새벽 4시
fun validateUnreadCountCache() {
    // 1. 활성 채팅방 목록 조회
    val activeChatRooms = chatRoomRepository.findActiveRooms()

    // 2. Redis 값과 MongoDB 값 비교
    activeChatRooms.forEach { room ->
        val redisCount = redis.get("unread:${room.id}:${room.memberId}")
        val mongoCount = chatMessageRepository.countUnread(room.id, room.memberId)

        if (redisCount != mongoCount) {
            // 3. 불일치 시 MongoDB 기준으로 재동기화
            redis.set("unread:${room.id}:${room.memberId}", mongoCount)
            log.warn("캐시 불일치 발견: room=${room.id}, redis=$redisCount, mongo=$mongoCount")
        }
    }
}
```

이 로직이 있으면 INCR/DEL 과정에서 네트워크 장애로 캐시가 어긋나도 다음 날 새벽에 자동으로 보정된다. 시간이 더 있었다면 불일치율 메트릭까지 수집해서 모니터링 대시보드를 만들고 싶었다.

### 현업에서의 캐시 동기화

현업에서는 캐시 무효화를 자동화하기 위해 CDC(Change Data Capture) 패턴을 많이 사용한다.

**Debezium + Kafka** 조합이 대표적이다. DB의 트랜잭션 로그를 감시하다가 데이터가 변경되면 Kafka로 이벤트를 발행하고, 이를 구독해서 캐시를 무효화한다. 우리 프로젝트처럼 애플리케이션 코드에서 수동으로 캐시를 관리하면 놓치는 케이스가 생길 수 있는데, CDC는 DB 레벨에서 모든 변경을 캡처하므로 누락이 없다.

> 출처: [Automating Cache Invalidation With Change Data Capture - Debezium Blog](https://debezium.io/blog/2018/12/05/automating-cache-invalidation-with-change-data-capture/)

**NATS**도 대안이 될 수 있다. Kafka가 높은 처리량과 메시지 영속성에 최적화되어 있다면, NATS는 저지연과 경량화에 최적화되어 있다. 마이크로서비스 간 실시간 통신이나 캐시 무효화 이벤트 전달처럼 단순한 pub/sub 용도에는 NATS가 더 가볍고 빠르다. Tesla, PayPal, Walmart 같은 기업들이 NATS를 사용 중이다.

> 출처: [NATS and Kafka Compared - Synadia](https://www.synadia.com/blog/nats-and-kafka-compared)
> 출처: [About NATS - NATS.io](https://nats.io/about/)

```
현업에서 추가로 고려할 것:
- CDC로 캐시 자동 동기화 (Debezium + Kafka 또는 NATS)
- Redis Cluster 구성
- 캐시 히트율 메트릭 수집
- Circuit Breaker 패턴
```

### 배운 점

그래도 "왜 Redis를 썼는지", "왜 INCR이 atomic한지", "캐시 일관성 전략이 뭔지" 정도는 설명할 수 있게 됐다. 대규모 서비스들도 같은 패턴을 쓴다는 걸 확인하니 방향은 맞았다고 생각한다. 6주 프로젝트치고는 충분히 깊이 있게 고민했다.

<!-- EN -->

We had designed the MongoDB + Redis Pub/Sub architecture. Now it was time to build the chatroom list query API.

---

## The Problem

The chatroom list required more information than expected.

Information needed for the chatroom list:
>
1. Chatroom basic info - MySQL (ChatRoom)
2. Product info (title, thumbnail) - MySQL (Product, ProductFile)
3. Counterpart info (nickname, profile) - MySQL (Member, profileImage)
4. Last message content/time - MySQL (lastMessage, lastMessageAt)
5. Chatroom settings (pinned, muted) - MySQL (ChatRoomMember)
6. Unread message count - MongoDB (count query)

The DTO fields alone were substantial:

![](/uploads/project/Joying/chatroom-list-slow-query/problem.svg)

We implemented it in the most straightforward way.

![](/uploads/project/Joying/chatroom-list-slow-query/problem-2.svg)

We set up a test environment and measured performance.

Test environment:
- Users: 100
- Total chatrooms: 500 (average 10 per user)
- Average messages per chatroom: 150
- Total MongoDB messages: 75,000

Querying 10 chatrooms:

![](/uploads/project/Joying/chatroom-list-slow-query/problem-3.png)

**It took 1.35 seconds.** It slowed linearly as the number of chatrooms increased.

---

## N+1 Query Problem

The core issue was N+1 queries. Multiple additional queries were fired for each of the N chatrooms.

Queries generated when loading 10 chatrooms:
>
1. ChatRoom list query (1 time)
2. Product query: N times (Lazy Loading)
3. Member query: N times (Lazy Loading)
4. ProductFile query: N times (thumbnails)
5. ChatRoomMember query: N times (settings)
6. MongoDB count query: N times (unread count)
>Total queries: 1 + 5N

The slowest was the MongoDB count query, averaging 100ms per call.

>
MongoDB count query process:
1. Network RTT (Server -> MongoDB)
2. Index traversal (B-Tree)
3. Count matching messages
4. Return result
>-> Disk I/O is the bottleneck

MongoDB wasn't slow -- we were making too many queries.

### Solution: Fetch Join + Batch Queries + Redis Caching

After optimization:

1. ChatRoom + Product + Member: 1 query (Fetch Join)
2. ChatRoomMember settings: 1 query (batch)
3. ProductFile thumbnails: 1 query (batch)
4. Unread counts: 1 call (Redis MGET)

Total queries: 4

MySQL N+1 was solved with Fetch Join and batch queries. MongoDB N+1 was solved with Redis caching.

---

## Attempt 1: MySQL Denormalization (Failed)

Initially, we considered adding an `unreadCount` column to MySQL.

![](/uploads/project/Joying/chatroom-list-slow-query/mysql-denormalization.svg)

Three problems emerged.

### Data Consistency Issue

When sending a message:
1. Save message to MongoDB
2. Increment MySQL unreadCount

What if MongoDB save succeeds but MySQL update fails?
-> Message exists but unread count doesn't increase

### Distributed Transaction Required

How to guarantee transactions between MongoDB and MySQL?

2PC (Two-Phase Commit)?
- Complex implementation
- Performance overhead
- More failure points

### Concurrency Issue

Users A and B send messages simultaneously:

Thread 1: reads unreadCount = 5
Thread 2: reads unreadCount = 5
Thread 1: updates to 6
Thread 2: updates to 6
-> Should be 7, but it's 6

Distributed locks would be needed, dramatically increasing complexity.

---

## Caching Strategy Review

We evaluated caching approaches to solve the N+1 problem.

### 1. Application Memory Cache (HashMap)

![](/uploads/project/Joying/chatroom-list-slow-query/app-memory-cache.svg)

Fast when cached in JVM heap, but lost on restart and impossible to synchronize across multiple servers.

### 2. MySQL Denormalization

As discussed above, causes distributed transaction and concurrency issues.

### 3. MongoDB Aggregation Pipeline

![](/uploads/project/Joying/chatroom-list-slow-query/mongodb-aggregation.svg)

Can aggregate unread messages per chatroom in one query, but the aggregation itself is heavy and recalculated every time -- no caching benefit.

### 4. Redis Caching (Chosen)

Sub-1ms reads (memory-based), no additional infrastructure needed (already using Redis Pub/Sub), and atomic increment/decrement via `INCR/DECR` eliminates the need for distributed locks. Eventual consistency between cache and DB is acceptable -- users barely notice a 1-2 second delay in unread counts. Performance mattered more than strict consistency for this data.

---

## Cache Consistency Strategy

There are several cache consistency strategies.

**Write-through**
Update cache and DB simultaneously on writes
**Write-behind**
Update only cache on writes, sync to DB later
**Cache-aside**
Check cache on read -> if miss, query DB -> store in cache

We chose a **Write-through + Cache-aside hybrid**.

- On message send: Redis INCR (immediate, like write-through)
- On read receipt: Redis DEL (cache invalidation)
- On query: Check Redis -> if miss, compute from MongoDB and cache (cache-aside)

Write-behind was excluded due to message loss risk. Showing fewer unread messages than actual is critical in chat.

---

## Why Redis

```
MongoDB query: 100ms (disk I/O)
Redis query: <1ms (memory)

-> 100x faster
```

Immediately applicable with no additional infrastructure.

---

## Why Redis Caching Is Effective

Chatroom lists are data that the same user queries repeatedly. If user A views the list at 09:00 and again at 09:01, there's no reason to recalculate the same unread counts. Data with high **temporal locality** maximizes caching effectiveness.

Redis manages cache with LRU (Least Recently Used). Active users' data stays cached through frequent access, while inactive users' data is automatically evicted.

Estimated for our system:

```
Total chatrooms: 10,000
Active chatrooms (Working Set): 2,000 (20%)
Redis memory needed: 2,000 x 100 bytes = 200 KB
Actual Redis allocation: 1 GB
-> Working Set fits comfortably in memory
-> Achieves 95%+ cache hit rate
```

### Cache Key Design

Redis Key: "unread:{chatRoomId}:{memberId}"
Value: "5" (unread count)
TTL: 7 days

---

## Redis MGET: 10 Queries to 1

When retrieving multiple values from Redis, reducing the number of commands is crucial.

### Wrong Approach

![](/uploads/project/Joying/chatroom-list-slow-query/wrong-approach.svg)

### Correct Approach

![](/uploads/project/Joying/chatroom-list-slow-query/right-approach.svg)

### Performance Comparison

```
Individual queries (GET x10):
- Command parsing x10
- Result return x10
-> Total 10ms

MGET (x1):
- Command parsing x1
- Batch result return x1
-> Total 1ms

-> 10x faster
```

Redis operates on a single thread. Sending 10 commands accumulates parsing overhead 10 times. MGET reduces this to once.

---

## Cache Warming Strategy

The most important metric in Redis caching is the cache hit rate.

>Cache hit rate = cache hits / total queries

Cache misses require MongoDB queries, causing slowdowns.

### When to Pre-populate the Cache

>
1. On message send: Increment receiver's unread count
   -> INCR unread:{chatRoomId}:{receiverId}
2. On read receipt: Reset Redis
   -> DEL unread:{chatRoomId}:{memberId}
3. On cache miss: Compute from MongoDB and store in Redis
   -> SET unread:{chatRoomId}:{memberId} {count} EX 604800

### Actual Behavior
![](/uploads/project/Joying/chatroom-list-slow-query/actual-behavior.png)

---

## Implementation

### UnreadCountService
![](/uploads/project/Joying/chatroom-list-slow-query/unread-count-service.svg)

### Chatroom List Query Improvement

![](/uploads/project/Joying/chatroom-list-slow-query/chatroom-list-improvement.svg)

---

## Results

**Test Environment**
- Users: 100
- Total chatrooms: 500 (average 10 per user)
- Average messages per chatroom: 150
- Total MongoDB messages: 75,000

**Optimized Query Times**
1. ChatRoom + Product + Member (Fetch Join): 50ms
2. ChatRoomMember batch query: 15ms
3. ProductFile batch query: 15ms
4. Redis MGET (95% hit rate): 5ms
Total: 85ms

| Metric | Before | After |
|------|--------|-------|
| Chatrooms | 10 | 10 |
| Total queries | 51 | 4 |
| Total time | 1350ms | 85ms |
| Cache hit rate | - | 95% |

**16x faster.**

---

## Retrospective

Honestly, I wasn't sure this was the right approach.

I wasn't confident that caching unread message counts in Redis and managing them with INCR/DEL was the "standard" approach. Maybe there was a better method I didn't know about?

### Redis Caching in Large-scale Services

It turned out major services use similar patterns.

**Twitter** uses Redis for its timeline service, handling 39 million QPS with over 10,000 Redis instances managing 105TB of data. They store the 800 most recent tweet IDs per user timeline in Redis for fast retrieval.

> Source: [How Twitter Uses Redis to Scale - High Scalability](http://highscalability.com/blog/2014/9/8/how-twitter-uses-redis-to-scale-105tb-ram-39mm-qps-10000-ins.html)

**Pinterest** caches billions of relationship data in Redis, partitioning the user ID space into 8,192 virtual shards distributed across Redis instances. Frequent queries like "does this user follow this board?" are handled by Redis.

> Source: [Using Redis at Pinterest for Billions of Relationships - VMware Tanzu](https://blogs.vmware.com/tanzu/using-redis-at-pinterest-for-billions-of-relationships/)

### Korean Companies' Redis Caching

Major Korean services also use similar patterns.

**KakaoPay** separates local cache and Redis by purpose. Infrequently changing read-only data (products, carriers, benefits) goes to local cache, while sessions and frequently changing dynamic data goes to Redis. They achieve eventual consistency by publishing change events via Redis Pub/Sub and having each server subscribe to invalidate local caches.

> Source: [Local Caching in Distributed Systems - KakaoPay Tech Blog](https://tech.kakaopay.com/post/local-caching-in-distributed-systems/)

**Toss** uses Redis as an in-memory cache and applies various strategies to handle cache stampede, cache penetration, and hot key expiration. They implement distributed locks using the Redlock algorithm, leveraging Redis's single-threaded nature.

> Source: [Cache Problem Solving Guide - Toss Tech Blog](https://toss.tech/article/cache-traffic-tip)

**Olive Young** applied multi-layer caching combining local cache (Caffeine) with Redis. When network throughput became high with Redis alone, they added local cache as the first layer and Redis as the second. This resulted in a 478% TPS increase and 99.1% reduction in Redis network throughput.

> Source: [High-Performance Cache Architecture Design - Olive Young Tech Blog](https://oliveyoung.tech/2024-12-10/present-promotion-multi-layer-cache/)

For frequently queried data where speed matters more than precision -- like unread counts -- Redis caching is effectively the industry standard.

### Limitations of a 6-week Project

There were differences from production environments.

What we couldn't do in 6 weeks:
- Cache consistency monitoring (what if Redis and MongoDB values diverge?)
- Fallback strategy on cache failure (what if Redis goes down?)
- Load test-based TTL tuning
- Cache warming batch jobs

The biggest regret was not building **cache consistency validation logic**. Our implementation assumes "the cache is always correct," but production systems assume "the cache can be wrong" and include validation.

```kotlin
// The validation batch we wanted to build
@Scheduled(cron = "0 0 4 * * *")  // Daily at 4 AM
fun validateUnreadCountCache() {
    // 1. Get active chatrooms
    val activeChatRooms = chatRoomRepository.findActiveRooms()

    // 2. Compare Redis and MongoDB values
    activeChatRooms.forEach { room ->
        val redisCount = redis.get("unread:${room.id}:${room.memberId}")
        val mongoCount = chatMessageRepository.countUnread(room.id, room.memberId)

        if (redisCount != mongoCount) {
            // 3. Re-sync based on MongoDB on mismatch
            redis.set("unread:${room.id}:${room.memberId}", mongoCount)
            log.warn("Cache inconsistency found: room=${room.id}, redis=$redisCount, mongo=$mongoCount")
        }
    }
}
```

With this logic, even if caches drift due to network failures during INCR/DEL, they'd auto-correct the next morning. Given more time, we would have collected mismatch rate metrics and built a monitoring dashboard.

### Cache Synchronization in Production

Production systems often use the CDC (Change Data Capture) pattern to automate cache invalidation.

The **Debezium + Kafka** combination is a classic approach. It monitors DB transaction logs, publishes events to Kafka on data changes, and subscribers invalidate caches accordingly. Unlike our project's manual cache management in application code, CDC captures all changes at the DB level with zero omissions.

> Source: [Automating Cache Invalidation With Change Data Capture - Debezium Blog](https://debezium.io/blog/2018/12/05/automating-cache-invalidation-with-change-data-capture/)

**NATS** is another alternative. While Kafka is optimized for high throughput and message durability, NATS is optimized for low latency and lightweight operation. For simple pub/sub use cases like inter-microservice communication or cache invalidation events, NATS is lighter and faster. Companies like Tesla, PayPal, and Walmart use NATS.

> Source: [NATS and Kafka Compared - Synadia](https://www.synadia.com/blog/nats-and-kafka-compared)
> Source: [About NATS - NATS.io](https://nats.io/about/)

```
Additional production considerations:
- Automated cache sync via CDC (Debezium + Kafka or NATS)
- Redis Cluster setup
- Cache hit rate metrics collection
- Circuit Breaker pattern
```

### Lessons Learned

At the very least, I can now explain "why we chose Redis," "why INCR is atomic," and "what cache consistency strategies exist." Confirming that large-scale services use the same patterns validated our direction. For a 6-week project, we dug deep enough.

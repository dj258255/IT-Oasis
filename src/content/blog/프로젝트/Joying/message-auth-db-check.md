---
title: '메시지마다 DB 조회하던 권한 체크'
titleEn: 'Permission Checks That Queried DB for Every Message'
description: 채팅 메시지 전송 시 매번 MySQL을 조회하던 권한 체크를 Redis 캐싱으로 최적화하고, lastMessage 업데이트를 비동기로 처리하여 응답 시간을 2배 개선한 과정을 정리한다.
descriptionEn: Optimizes per-message MySQL permission checks with Redis caching and async lastMessage updates, achieving 2x response time improvement.
date: 2025-12-01T00:00:00.000Z
tags:
  - Redis
  - Caching
  - CQRS
  - Permission
  - Async
category: 프로젝트/Joying
draft: false
---

채팅방 목록 조회를 최적화하고 나니, 이번엔 메시지 전송이 느렸다.

---

## 문제 상황

메시지 전송 API 흐름을 분석했다.


**메시지 전송 API**

1. MySQL에서 채팅방 멤버십 확인 (30-50ms)
   → "이 사용자가 이 채팅방에 참여자인가?"
2. MongoDB에 메시지 저장 (50-100ms)
3. Redis Pub/Sub으로 실시간 전달 (1ms)
4. MySQL lastMessage 업데이트 (20-30ms)

총 소요: 106-192ms


메시지 10개를 연속으로 보내면 1-2초가 걸렸다.

---

## 왜 권한 확인이 필요한가

악의적인 사용자가 다른 사람 채팅방에 메시지를 보내려고 할 수 있다.


**공격 시나리오**
- 자기가 참여하지 않은 채팅방에 메시지 전송 시도
- 이미 나간 채팅방에 메시지 전송 시도


그래서 메시지 전송할 때마다 MySQL에서 확인한다.

![](/uploads/프로젝트/Joying/message-auth-db-check/why-permission-check.svg)


**문제는 메시지 보낼 때마다 조회한다는 것이다.**

채팅방 참여자 정보는 거의 변하지 않는다. 1:1 채팅이라 구매자와 판매자가 고정되어 있다. 매번 MySQL을 조회하는 건 낭비였다.

---

## 권한 체크 방법 검토

권한 확인을 빠르게 하기 위한 방법을 검토했다.

### 1. 매번 MySQL 조회 (현재)

항상 정확하지만, 메시지마다 30ms + DB 커넥션을 소모한다.

### 2. Application 메모리 캐시

![](/uploads/프로젝트/Joying/message-auth-db-check/app-memory-cache.svg)

0.01ms로 빠르지만, 서버가 여러 대일 때 동기화가 안 되고 재시작 시 소실된다.

### 3. Redis 캐시 (선택)

이미 Redis Pub/Sub을 사용 중이라 추가 인프라 없이 적용 가능했다. 1:1 채팅이라 권한 정보가 거의 바뀌지 않아서 캐시 히트율이 높고, TTL로 자동 만료도 된다.

---

## 해결: Redis 권한 캐싱

Redis에 권한 정보를 캐싱했다.

### 캐시 키 설계


Redis Key: "chatroom:permission:{chatRoomId}:{memberId}"
Value: "ALLOWED"
TTL: 1시간


### 동작 방식

![](/uploads/프로젝트/Joying/message-auth-db-check/flow-diagram.png)


### 성능 비교


**Before (항상 MySQL)**
- 권한 확인: 30ms
- 메시지 100개 연속 전송: 30ms x 100 = 3000ms

**After (Redis 캐시)**
- 첫 번째 메시지: 30ms (캐시 미스)
- 이후 메시지: 1ms (캐시 히트)

실제 사용 패턴에서는 첫 메시지만 MySQL을 조회하고, 이후 TTL(1시간) 동안은 Redis에서 처리한다. 메시지를 많이 보낼수록 차이가 벌어진다.

---

## 캐시 무효화 전략

언제 캐시를 지우나?

1. 채팅방 나가기: 권한 캐시 삭제
   DEL chatroom:permission:{chatRoomId}:{memberId}

2. TTL 1시간: 자동 삭제

채팅방 참여자는 거의 바뀌지 않으므로 TTL 1시간이면 충분했다.

---

## Cache Warming

첫 메시지부터 빠르게 처리하기 위해 채팅방 생성 시 미리 캐싱했다.

![](/uploads/프로젝트/Joying/message-auth-db-check/cache-warming.svg)

---

## lastMessage 비동기 처리

권한 캐싱 외에 lastMessage 업데이트도 병목이었다.

```
lastMessage란?
채팅방 목록에 보이는 "마지막 메시지 미리보기"

[채팅방 1]
판매자: 홍길동
마지막 메시지: "그럼 빌릴게요" ← 이것
```

메시지를 보낼 때마다 MySQL의 `chat_room` 테이블에 lastMessage를 업데이트했다. 문제는 이게 메시지 전송 응답에 꼭 필요하지 않다는 것이다.

### 동기 vs 비동기


**Before - 동기 처리**

1. 권한 확인 (30ms)
2. MongoDB 저장 (50ms)
3. lastMessage 업데이트 (20ms) ← 여기서 대기
4. Redis Pub/Sub 발행 (1ms)
응답 반환 (총 101ms)

**After - 비동기 처리**

1. 권한 확인 (1ms)
2. MongoDB 저장 (50ms)
3. Redis Pub/Sub 발행 (1ms)
응답 반환 (총 52ms)
**[백그라운드]**
4. lastMessage 업데이트 (20ms)


### 비동기로 한 이유

채팅방 목록 조회는 메시지 전송보다 덜 빈번하다. 사람들이 계속 채팅은 하지만, 목록을 새로고침하는 건 가끔이다.

lastMessage가 1-2초 늦게 업데이트되어도 사용자가 거의 못 느낀다. 메시지 전송 속도가 더 중요했다.

---

## 실제 구현

### ChatRoomPermissionCache
![](/uploads/프로젝트/Joying/message-auth-db-check/chat-room-mysql.svg)


### 메시지 전송 서비스

![](/uploads/프로젝트/Joying/message-auth-db-check/message-send-service.svg)

---


## CQRS 패턴

권한 캐싱은 CQRS(Command Query Responsibility Segregation) 패턴을 적용한 것이다.


***Command (쓰기)***
- MySQL에 채팅방 생성 (Source of Truth)
- 정확성 우선

***Query (읽기)***
- Redis에서 권한 확인 (Cache)
- 성능 우선
- 캐시 미스 시 MySQL에서 복구


읽기와 쓰기를 분리하면 각각을 독립적으로 최적화할 수 있다.



## 결과

| 지표 | Before | After |
|------|--------|-------|
| 권한 확인 | 30ms | 1ms |
| lastMessage 업데이트 | 20ms (동기) | 0ms (비동기) |
| 메시지 전송 총 시간 | 101ms | 52ms |

**2배 빨라졌다.**

<!-- EN -->

After optimizing the chat room list query, message sending turned out to be slow.

---

## Problem

I analyzed the message sending API flow.

**Message Sending API:**
1. Check chat room membership in MySQL (30-50ms)
   → "Is this user a participant in this chat room?"
2. Save message to MongoDB (50-100ms)
3. Real-time delivery via Redis Pub/Sub (1ms)
4. Update MySQL lastMessage (20-30ms)

Total: 106-192ms

Sending 10 consecutive messages took 1-2 seconds.

---

## Why Permission Checks Are Needed

Malicious users could attempt to send messages to other people's chat rooms.

**Attack scenarios:**
- Sending messages to a chat room the user hasn't joined
- Sending messages to a chat room the user has left

So every message send requires a MySQL check.

![](/uploads/프로젝트/Joying/message-auth-db-check/why-permission-check.svg)

**The problem is querying on every single message.**

Chat room participant information rarely changes. In 1:1 chat, the buyer and seller are fixed. Querying MySQL every time is wasteful.

---

## Permission Check Method Evaluation

I evaluated methods to speed up permission checks.

### 1. MySQL Query Every Time (Current)

Always accurate, but costs 30ms + a DB connection per message.

### 2. Application Memory Cache

![](/uploads/프로젝트/Joying/message-auth-db-check/app-memory-cache.svg)

Fast at 0.01ms, but doesn't synchronize across multiple servers and is lost on restart.

### 3. Redis Cache (Selected)

Already using Redis Pub/Sub, so no additional infrastructure needed. In 1:1 chat, permission data rarely changes, ensuring high cache hit rates. TTL provides automatic expiration.

---

## Solution: Redis Permission Caching

Permission information is cached in Redis.

### Cache Key Design

Redis Key: "chatroom:permission:{chatRoomId}:{memberId}"
Value: "ALLOWED"
TTL: 1 hour

### Flow

![](/uploads/프로젝트/Joying/message-auth-db-check/flow-diagram.png)

### Performance Comparison

**Before (always MySQL)**
- Permission check: 30ms
- 100 consecutive messages: 30ms x 100 = 3000ms

**After (Redis cache)**
- First message: 30ms (cache miss)
- Subsequent messages: 1ms (cache hit)

In actual usage patterns, only the first message queries MySQL. For the remainder of the TTL (1 hour), Redis handles it. The more messages sent, the greater the difference.

---

## Cache Invalidation Strategy

When to clear the cache?

1. Leaving a chat room: Delete permission cache
   DEL chatroom:permission:{chatRoomId}:{memberId}

2. TTL 1 hour: Automatic deletion

Since chat room participants rarely change, a 1-hour TTL is sufficient.

---

## Cache Warming

To process the first message quickly, permissions are pre-cached when the chat room is created.

![](/uploads/프로젝트/Joying/message-auth-db-check/cache-warming.svg)

---

## Async lastMessage Update

Beyond permission caching, the lastMessage update was also a bottleneck.

```
What is lastMessage?
The "last message preview" shown in the chat room list

[Chat Room 1]
Seller: Hong Gildong
Last message: "I'll rent it then" ← this
```

Every message send updated lastMessage in MySQL's `chat_room` table. The problem is this isn't required for the message send response.

### Sync vs Async

**Before - Synchronous:**
1. Permission check (30ms)
2. MongoDB save (50ms)
3. lastMessage update (20ms) ← waiting here
4. Redis Pub/Sub publish (1ms)
Response returned (total: 101ms)

**After - Asynchronous:**
1. Permission check (1ms)
2. MongoDB save (50ms)
3. Redis Pub/Sub publish (1ms)
Response returned (total: 52ms)
**[Background]**
4. lastMessage update (20ms)

### Why Async

Chat room list queries are less frequent than message sends. People keep chatting, but refreshing the list is occasional.

A 1-2 second delay in lastMessage updates is barely noticeable. Message send speed mattered more.

---

## Implementation

### ChatRoomPermissionCache
![](/uploads/프로젝트/Joying/message-auth-db-check/chat-room-mysql.svg)

### Message Send Service

![](/uploads/프로젝트/Joying/message-auth-db-check/message-send-service.svg)

---

## CQRS Pattern

Permission caching applies the CQRS (Command Query Responsibility Segregation) pattern.

***Command (Write)***
- Create chat room in MySQL (Source of Truth)
- Accuracy first

***Query (Read)***
- Check permissions in Redis (Cache)
- Performance first
- Fall back to MySQL on cache miss

Separating reads and writes allows independent optimization of each.

## Results

| Metric | Before | After |
|--------|--------|-------|
| Permission check | 30ms | 1ms |
| lastMessage update | 20ms (sync) | 0ms (async) |
| Total message send time | 101ms | 52ms |

**2x faster.**

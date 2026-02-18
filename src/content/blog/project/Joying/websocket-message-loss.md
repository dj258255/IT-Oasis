---
title: 'WebSocket 끊기면 메시지를 잃어버린다'
titleEn: 'Messages Are Lost When WebSocket Disconnects'
description: Redis Pub/Sub의 Fire-and-Forget 특성으로 WebSocket 재연결 시 메시지가 유실되는 문제를 MongoDB 기반 커서 페이지네이션으로 해결한 과정을 정리한다.
descriptionEn: Resolves message loss during WebSocket reconnection caused by Redis Pub/Sub's fire-and-forget nature using MongoDB-based cursor pagination.
date: 2025-12-16T00:00:00.000Z
tags:
  - WebSocket
  - Redis Pub/Sub
  - MongoDB
  - Cursor Pagination
  - Message Recovery
category: project/Joying
draft: false
coverImage: "/uploads/project/Joying/websocket-message-loss/unified-api.svg"
---

성능 문제는 해결했다. 그런데 모바일 테스트 중 예상치 못한 현상이 발견됐다.

---

## 문제 발견

모바일 환경에서 테스트 중 다음과 같은 오류가 보고됐다.

**"채팅하다가 와이파이 끊겼다가 다시 연결하면 중간 메시지가 안 와요."**

```
[사용자 A - 모바일]
10:00:00 - "안녕하세요" 전송 (성공)
10:00:05 - WiFi 끊김 (지하철 터널)

[사용자 B - 웹]
10:00:10 - "네 안녕하세요" 전송
10:00:15 - "이거 대여 가능한가요?" 전송
10:00:20 - "내일 가능하신가요?" 전송

[사용자 A - 모바일]
10:00:25 - WiFi 재연결
10:00:26 - 채팅방 진입
→ "안녕하세요" 이후 메시지가 없음
```

---

## 원인: Redis Pub/Sub의 Fire-and-Forget

Redis Pub/Sub은 메시지를 저장하지 않는다. 현재 구독 중인 클라이언트에게만 전송하고 즉시 폐기한다.


**Redis Pub/Sub 동작**
1. 메시지 발행
2. 현재 연결된 구독자에게 전송
3. 메시지 삭제

> 연결이 끊긴 동안 발행된 메시지는 영영 못 받음


MongoDB에는 모든 메시지가 저장되어 있다. 하지만 WebSocket이 끊긴 동안 발행된 Pub/Sub 메시지는 유실된다.

---

## 메시지 복구 방법 검토

재연결 시 놓친 메시지를 복구하는 방법을 검토했다.

### 1. Kafka Consumer Group

Kafka는 Consumer Group 단위로 Offset을 관리해서 재연결 시 재전송이 완벽하다. 하지만 Kafka 클러스터가 필요하고, 현재 트래픽(초당 100건)에는 과하다.

### 2. Redis Stream

Redis Stream은 메시지를 저장하면서 Consumer Group도 지원한다. 하지만 ACK 처리 로직이 필요하고, **이미 MongoDB에 메시지가 저장되어 있어서 같은 데이터를 두 곳에 저장하는 셈**이다.

### 3. 서버 푸시 큐

서버에서 사용자별로 미전송 메시지 큐를 관리하는 방식이다. 재연결 시 빠르지만, 서버 재시작이나 확장 시 큐가 유실되거나 동기화가 안 되는 문제가 있다.

### 4. MongoDB 조회 (선택)

**이미 MongoDB에 모든 메시지가 저장되어 있다.** 재연결 시 마지막 수신 시간 이후 메시지를 조회하면 된다. 추가 인프라 없이 기존 데이터를 그대로 활용할 수 있고, 재연결 시 50-100ms 지연은 사용자가 체감하기 어려운 수준이다.

---

## 해결: MongoDB 활용


**재연결 시나리오**
1. WebSocket 연결 끊김
2. 마지막으로 받은 메시지 시간 기록 (클라이언트)
3. 네트워크 복구 후 WebSocket 재연결
4. 그 시간 이후 메시지 REST API로 조회
5. 못 받은 메시지 복구


Redis Pub/Sub은 실시간 전달만 담당하고, 메시지 복구는 MongoDB에서 처리한다.

---

## 커서 기반 페이지네이션

재연결 API를 설계하면서 무한 스크롤 API와 합칠 수 있다는 점을 발견했다.


무한 스크롤: before 파라미터로 과거 방향 조회
재연결: after 파라미터로 미래 방향 조회

> 둘 다 커서 기반 조회


### 통합 API

![](/uploads/project/Joying/websocket-message-loss/unified-api.svg)


하나의 API로 두 가지 용도를 처리한다.

### 사용 예시

**무한 스크롤 (과거 메시지 조회)**

GET /api/chat-rooms/123/messages?before=2024-01-01T10:00:00Z&size=20
→ 10:00:00 이전 메시지 20개 (최신순 정렬)


**재연결 (놓친 메시지 조회)**

GET /api/chat-rooms/123/messages?after=2024-01-01T10:00:00Z&size=50
→ 10:00:00 이후 메시지 50개 (오래된순 정렬)


---

## 실제 구현

### ChatMessageService

![](/uploads/project/Joying/websocket-message-loss/chat-message-service.svg)


### MongoDB 인덱스

![](/uploads/project/Joying/websocket-message-loss/mongodb-index.svg)

복합 인덱스로 chatRoomId와 createdAt 기준 조회를 최적화했다.

---

## 클라이언트 재연결 로직

프론트엔드에서 구현해야 할 로직:

![](/uploads/project/Joying/websocket-message-loss/client-reconnection.svg)


---

## 결과

| 시나리오 | Before | After |
|----------|--------|-------|
| 네트워크 끊김 후 재연결 | 중간 메시지 유실 | 모든 메시지 복구 |
| API 개수 | 2개 (스크롤 + 재연결) | 1개 (통합) |

<!-- EN -->

Performance issues were resolved, but an unexpected problem was discovered during mobile testing.

---

## Problem Discovery

During mobile testing, the following bug was reported:

**"If WiFi disconnects during a chat and reconnects, intermediate messages are missing."**

```
[User A - Mobile]
10:00:00 - Sent "Hello" (success)
10:00:05 - WiFi disconnected (subway tunnel)

[User B - Web]
10:00:10 - Sent "Hi there"
10:00:15 - Sent "Is this available for rent?"
10:00:20 - Sent "Are you free tomorrow?"

[User A - Mobile]
10:00:25 - WiFi reconnected
10:00:26 - Entered chat room
→ No messages after "Hello"
```

---

## Cause: Redis Pub/Sub's Fire-and-Forget

Redis Pub/Sub does not store messages. It delivers only to currently subscribed clients and discards immediately.

**Redis Pub/Sub behavior:**
1. Message published
2. Delivered to currently connected subscribers
3. Message deleted

> Messages published while disconnected are permanently lost

All messages are stored in MongoDB, but Pub/Sub messages published while WebSocket was disconnected are lost.

---

## Recovery Method Evaluation

I evaluated methods to recover missed messages on reconnection.

### 1. Kafka Consumer Group

Kafka manages offsets per Consumer Group, enabling perfect redelivery on reconnection. However, it requires a Kafka cluster and is overkill for current traffic (~100 messages/sec).

### 2. Redis Stream

Redis Stream stores messages and supports Consumer Groups, but requires ACK handling logic. Since **MongoDB already stores all messages, this would mean duplicating data in two places**.

### 3. Server Push Queue

A server-side per-user undelivered message queue. Fast on reconnection, but queues are lost on server restart or difficult to synchronize when scaling.

### 4. MongoDB Query (Selected)

**All messages are already stored in MongoDB.** On reconnection, simply query messages after the last received timestamp. No additional infrastructure needed, and the 50-100ms delay on reconnection is imperceptible to users.

---

## Solution: Leveraging MongoDB

**Reconnection scenario:**
1. WebSocket connection drops
2. Client records the timestamp of the last received message
3. After network recovery, WebSocket reconnects
4. Query messages after that timestamp via REST API
5. Recover missed messages

Redis Pub/Sub handles only real-time delivery; message recovery is handled by MongoDB.

---

## Cursor-Based Pagination

While designing the reconnection API, I discovered it could be merged with the infinite scroll API.

- Infinite scroll: query past messages with `before` parameter
- Reconnection: query missed messages with `after` parameter

> Both are cursor-based queries

### Unified API

![](/uploads/project/Joying/websocket-message-loss/unified-api.svg)

A single API serves both purposes.

### Usage Examples

**Infinite scroll (past messages)**

GET /api/chat-rooms/123/messages?before=2024-01-01T10:00:00Z&size=20
→ 20 messages before 10:00:00 (newest first)

**Reconnection (missed messages)**

GET /api/chat-rooms/123/messages?after=2024-01-01T10:00:00Z&size=50
→ 50 messages after 10:00:00 (oldest first)

---

## Implementation

### ChatMessageService

![](/uploads/project/Joying/websocket-message-loss/chat-message-service.svg)

### MongoDB Index

![](/uploads/project/Joying/websocket-message-loss/mongodb-index.svg)

A compound index optimizes queries by chatRoomId and createdAt.

---

## Client Reconnection Logic

Logic to be implemented on the frontend:

![](/uploads/project/Joying/websocket-message-loss/client-reconnection.svg)

---

## Results

| Scenario | Before | After |
|----------|--------|-------|
| Reconnection after network drop | Intermediate messages lost | All messages recovered |
| Number of APIs | 2 (scroll + reconnection) | 1 (unified) |

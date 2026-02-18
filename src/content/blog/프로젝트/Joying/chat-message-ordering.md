---
title: '메시지가 뒤섞이는 채팅은 채팅이 아니다'
titleEn: 'A Chat Where Messages Are Out of Order Is Not a Chat'
description: 분산 환경에서 채팅 메시지 순서를 보장하기 위해 서버 타임스탬프 + 클라이언트 정렬 + MongoDB 정렬 조회 전략을 설계한 과정을 정리한다.
descriptionEn: Designs a message ordering strategy using server timestamps, client-side sorting, and MongoDB sorted queries for chat in distributed environments.
date: 2025-11-21T00:00:00.000Z
tags:
  - Chat
  - Message Ordering
  - Distributed Systems
  - MongoDB
  - Timestamp
category: 프로젝트/Joying
draft: false
---

물품 대여 플랫폼의 1:1 채팅을 맡았다. 채팅은 메시지를 보낸 순서 그대로 상대방에게 보여야 한다. 카카오톡에서 "안녕" 다음에 "뭐해?"를 보냈는데, 상대방 화면에 "뭐해?"가 먼저 뜨면 대화가 안 된다.

Redis Pub/Sub으로 실시간 메시징을 구현하면서, 이 순서 보장이 생각보다 단순하지 않다는 걸 알게 됐다.

---

## 실시간 전달 vs 저장 순서

채팅에서 "순서"는 두 가지를 구분해야 한다.

### 1. 실시간 전달 순서

1:1 채팅에서 각 클라이언트는 하나의 WebSocket 연결을 사용한다. TCP가 단일 연결 내에서 패킷 순서를 보장하므로, 서버 1대일 때는 같은 연결로 받는 메시지 순서가 보장된다.

하지만 서버를 여러 대로 확장하면 상황이 달라진다.

### 2. 저장 순서

DB에 저장된 순서가 정확해야 한다. 클라이언트가 채팅방을 열거나 새로고침하면 DB에서 정렬된 순서로 조회하기 때문이다.

---

## 서버 확장 시 순서 문제

현재는 서버 1대지만, 트래픽이 늘면 서버를 여러 대로 확장해야 한다.

**Redis Pub/Sub**
- 서버 1 (RTT 1ms)  → 1ms 후 수신
- 서버 2 (RTT 5ms)  → 5ms 후 수신
- 서버 3 (RTT 10ms) → 10ms 후 수신


**메시지 A가 서버 1에, 메시지 B가 서버 2에 거의 동시에 도착하면**
- 각 서버의 시계가 미세하게 다를 수 있음 (NTP 동기화 오차)
- 저장 타임스탬프가 의도와 다르게 기록될 수 있음
- Redis Pub/Sub으로 다른 서버에 전달될 때 순서가 뒤바뀔 수 있음


**[A가 보내는 순서]**
"안녕"
"뭐해?"
"밥 먹었어?"

**[B가 실시간으로 받는 순서 - 서버 확장 시]**
"뭐해?"
"안녕"
"밥 먹었어?"


새로고침하면 DB에서 정렬된 순서로 보이지만, 실시간 대화 중에 순서가 뒤바뀌면 UX가 나빠진다.

**해결: 클라이언트에서 정렬**

서버에서 `createdAt`을 함께 전송하고, 클라이언트가 메시지를 받을 때마다 정렬해서 표시한다.

![](/uploads/chat-message-ordering/server-scaling.svg)


네트워크 순서에 의존하지 않고, 서버 타임스탬프 기준으로 정렬한다. 메시지가 늦게 도착해도 올바른 위치에 삽입된다.

---

## 왜 순서가 중요한가

팀 회의에서 멘토님이 이런 질문을 던졌다.

**"채팅 내역은 법적 증거로 사용될 수 있다. 순서가 바뀌면 어떻게 되는가?"**

우리 플랫폼은 물품 대여 서비스다. 대여 약속, 가격 협의, 물품 상태 확인이 전부 채팅으로 이뤄진다. 분쟁이 생기면 채팅 기록이 증거가 된다.


**실제 대화**
빌림자: "이거 대여 가능한가요?"
대여자: "네, 가능합니다"
빌림자: "그럼 내일 빌릴게요"
대여자: "죄송한데 대여 불가능해요"

**순서가 꼬여서 저장된 경우**
빌림자: "그럼 내일 빌릴게요"
대여자: "네, 가능합니다"
대여자: "죄송한데 대여 불가능해요"
빌림자: "이거 대여 가능한가요?"


대화 맥락이 완전히 달라진다. 이 지적을 듣고 나서 순서 보장을 설계 단계부터 확실히 잡아야겠다고 생각했다.

---

## 해결 방법 검토

순서 보장을 위한 몇 가지 방법을 검토했다. Redis 공식 문서의 Pub/Sub 설명과 분산 시스템 관련 자료를 찾아보면서 정리했다.

### 1. 시퀀스 번호 (Sequence Number)

메시지마다 순차적인 번호를 부여하는 방식이다.

```
메시지 1: seq=1
메시지 2: seq=2
메시지 3: seq=3
```

서버가 여러 대로 확장되면 시퀀스 번호 생성기가 병목이 된다. 분산 환경에서 전역적으로 유일한 순차 번호를 생성하려면 분산 락이나 중앙 집중식 카운터가 필요하다.

### 2. 벡터 클락 (Vector Clock)

분산 시스템에서 인과 관계를 추적하는 알고리즘이다. 각 노드가 자신의 카운터를 유지하고, 메시지를 보낼 때 벡터를 함께 전송한다. Lamport의 논문에서 시작된 개념인데, 1:1 채팅에 비해 구현 복잡도가 너무 높았다.

우리는 서버 1대에서 시작하고, 확장해도 Redis를 통해 메시지를 중계하므로 벡터 클락까지는 필요 없었다.

### 3. Kafka 파티션 순서 보장

Kafka는 파티션 단위로 순서를 보장한다. 같은 채팅방의 메시지를 같은 파티션에 넣으면 순서가 보장된다. 하지만 Kafka 자체가 우리 프로젝트에 과했다. 이건 별도 글에서 다룬다.

### 4. 서버 타임스탬프 (선택)

가장 단순한 방법이다. 메시지가 서버에 도착한 시점의 타임스탬프를 기준으로 정렬한다.

서버 시계가 어긋나면 순서가 틀릴 수 있지만, NTP 동기화로 밀리초 수준까지 맞출 수 있다. 1:1 채팅에서 밀리초 단위로 두 사람이 동시에 메시지를 보내는 경우는 현실적으로 거의 없다. Java의 `Instant`은 나노초까지 표현할 수 있지만, 실제 `Instant.now()`의 해상도는 OS에 따라 밀리초 수준이다. 그래도 1:1 채팅에서는 충분하다.

복잡한 알고리즘 대신 단순함을 선택했다. 6주 프로젝트에서 EC2 1대로 시작하는 상황이었고, 추가 인프라 없이 바로 적용할 수 있었다.

---

## 순서 보장과 메시지 전달

멘토님의 질문 이후 분산 시스템의 순서 보장을 더 찾아봤다(Leslie Lamport 논문, Martin Kleppmann의 "Designing Data-Intensive Applications" 참고).

분산 시스템에서 순서 보장에는 Total Order(모든 노드가 같은 순서), Causal Order(인과 관계만 보장), FIFO Order(같은 송신자만 보장) 세 단계가 있다. 1:1 채팅에서는 모든 메시지가 대화의 일부이므로 Total Order가 필요하다. MongoDB의 `createdAt` 타임스탬프를 단일 진실 원천(Source of Truth)으로 삼아서 해결했다.

메시지 전달은 **At-least-once**를 선택했다. MongoDB에 저장되면 유실되지 않고, Redis Pub/Sub이 실패하면 클라이언트가 REST API로 재조회한다. 중복 메시지는 클라이언트에서 메시지 ID로 걸러낸다. Exactly-once는 분산 트랜잭션이 필요한데, 채팅에서 중복은 클라이언트 필터링으로 충분히 처리 가능했다.

---

## 실제 구현

MongoDB의 `createdAt` 타임스탬프를 순서의 유일한 기준으로 삼았다.

### 백엔드: 서버 타임스탬프 설정

![](/uploads/chat-message-ordering/server-timestamp.svg)


핵심은 세 가지다.
- `createdAt`은 저장 전에 서버에서 설정한다
- MongoDB 저장이 완료된 후 Redis Pub/Sub으로 발행한다
- `messageDto`에 `createdAt`이 포함되어 클라이언트에 전달된다

### 프론트엔드: 타임스탬프 기준 정렬

![](/uploads/chat-message-ordering/sort.svg)


### 역할 분리

- **백엔드**: 서버 타임스탬프 설정 + MongoDB 저장 + Redis Pub/Sub 발행
- **프론트엔드**: 수신한 메시지를 `timestamp` 기준 정렬해서 표시
- **MongoDB**: 조회 시 `createdAt` 기준 정렬 (새로고침/채팅방 입장 시)

![](/uploads/chat-message-ordering/role-separation.svg)


실시간 전달 중 네트워크 순서가 어긋나도, 클라이언트가 정렬해서 표시한다. 새로고침하면 MongoDB에서 정렬된 순서로 조회한다.

---

## 결과

- **실시간 전달**: 네트워크 상황에 따라 순서가 다를 수 있음 (허용)
- **저장/조회**: `createdAt` 기준 정렬로 항상 정확한 순서 보장
- **서버 확장**: 모든 서버가 같은 MongoDB를 보므로 순서 일치

MongoDB에 `chatRoomId + createdAt` 복합 인덱스를 추가해서 정렬 비용을 해결했다.

![](/uploads/chat-message-ordering/result.svg)

<!-- EN -->

I was responsible for building 1:1 chat for an item rental platform. Chat messages must appear to the recipient in the exact order they were sent. If you send "Hello" followed by "What's up?" on KakaoTalk but the recipient sees "What's up?" first, the conversation breaks down.

While implementing real-time messaging with Redis Pub/Sub, I discovered that guaranteeing message order is not as simple as it seems.

---

## Real-Time Delivery vs Storage Order

"Order" in chat must be distinguished into two aspects.

### 1. Real-Time Delivery Order

In 1:1 chat, each client uses a single WebSocket connection. Since TCP guarantees packet order within a single connection, message order is preserved with a single server.

However, scaling to multiple servers changes the situation.

### 2. Storage Order

The order stored in the DB must be accurate, because when a client opens a chat room or refreshes, messages are retrieved in sorted order from the DB.

---

## Ordering Issues When Scaling Servers

Currently running a single server, but scaling to multiple servers will be necessary as traffic grows.

**Redis Pub/Sub**
- Server 1 (RTT 1ms) → received after 1ms
- Server 2 (RTT 5ms) → received after 5ms
- Server 3 (RTT 10ms) → received after 10ms

**When message A arrives at Server 1 and message B at Server 2 almost simultaneously:**
- Each server's clock may differ slightly (NTP sync error)
- Stored timestamps may not reflect the intended order
- Order may be reversed when relayed via Redis Pub/Sub

**[Order A sends]**
"Hello"
"What's up?"
"Have you eaten?"

**[Order B receives in real-time - with scaled servers]**
"What's up?"
"Hello"
"Have you eaten?"

After a refresh, messages appear in DB-sorted order, but out-of-order messages during real-time chat degrade UX.

**Solution: Client-Side Sorting**

The server sends `createdAt` with each message, and the client sorts messages by timestamp on receipt.

![](/uploads/chat-message-ordering/server-scaling.svg)

Instead of relying on network order, messages are sorted by server timestamp. Late-arriving messages are inserted at the correct position.

---

## Why Order Matters

During a team meeting, our mentor raised this question:

**"Chat history can be used as legal evidence. What happens if the order is wrong?"**

Our platform is an item rental service. Rental agreements, price negotiations, and item condition confirmations all happen through chat. If a dispute arises, chat records become evidence.

**Actual conversation:**
Borrower: "Is this available for rent?"
Lender: "Yes, it's available"
Borrower: "I'll rent it tomorrow then"
Lender: "Sorry, it's not available"

**If stored out of order:**
Borrower: "I'll rent it tomorrow then"
Lender: "Yes, it's available"
Lender: "Sorry, it's not available"
Borrower: "Is this available for rent?"

The context changes completely. After this feedback, I decided to firmly establish ordering guarantees from the design phase.

---

## Solution Evaluation

I evaluated several approaches for ordering guarantees, referencing Redis official Pub/Sub documentation and distributed systems resources.

### 1. Sequence Number

Assign sequential numbers to each message.

```
Message 1: seq=1
Message 2: seq=2
Message 3: seq=3
```

When scaling to multiple servers, the sequence number generator becomes a bottleneck. Generating globally unique sequential numbers in a distributed environment requires distributed locks or a centralized counter.

### 2. Vector Clock

An algorithm for tracking causality in distributed systems. Each node maintains its own counter and sends the vector with messages. Originating from Lamport's paper, the implementation complexity was too high for 1:1 chat.

Since we start with a single server and relay messages through Redis even when scaling, vector clocks were unnecessary.

### 3. Kafka Partition Ordering

Kafka guarantees order per partition. Routing messages from the same chat room to the same partition ensures order. However, Kafka itself was overkill for our project.

### 4. Server Timestamp (Selected)

The simplest approach. Sort by the timestamp when the message arrives at the server.

Server clocks can drift, but NTP synchronization keeps them accurate to the millisecond level. In 1:1 chat, two people sending messages at the exact same millisecond is practically impossible. Java's `Instant` can represent nanoseconds, but `Instant.now()` resolution depends on the OS and is typically at the millisecond level. Still sufficient for 1:1 chat.

I chose simplicity over complex algorithms. In a 6-week project starting with a single EC2 instance, this could be applied immediately without additional infrastructure.

---

## Ordering Guarantees and Message Delivery

After the mentor's question, I researched ordering guarantees in distributed systems further (referencing Leslie Lamport's paper and Martin Kleppmann's "Designing Data-Intensive Applications").

Distributed systems have three levels of ordering: Total Order (all nodes see the same order), Causal Order (only causal relationships guaranteed), and FIFO Order (only same-sender order guaranteed). In 1:1 chat, all messages are part of the conversation, so Total Order is required. I solved this by using MongoDB's `createdAt` timestamp as the single Source of Truth.

For message delivery, I chose **At-least-once**. Once saved to MongoDB, messages are never lost. If Redis Pub/Sub fails, clients re-fetch via REST API. Duplicate messages are filtered by message ID on the client. Exactly-once requires distributed transactions, but for chat, client-side filtering handles duplicates sufficiently.

---

## Implementation

MongoDB's `createdAt` timestamp serves as the sole ordering criterion.

### Backend: Server Timestamp Assignment

![](/uploads/chat-message-ordering/server-timestamp.svg)

Three key points:
- `createdAt` is set on the server before saving
- Redis Pub/Sub publishes only after MongoDB save completes
- `messageDto` includes `createdAt` for client delivery

### Frontend: Timestamp-Based Sorting

![](/uploads/chat-message-ordering/sort.svg)

### Role Separation

- **Backend**: Server timestamp assignment + MongoDB save + Redis Pub/Sub publish
- **Frontend**: Sort received messages by `timestamp` for display
- **MongoDB**: Sort by `createdAt` on query (refresh/chat room entry)

![](/uploads/chat-message-ordering/role-separation.svg)

Even if network order is disrupted during real-time delivery, the client sorts and displays correctly. On refresh, MongoDB returns messages in sorted order.

---

## Results

- **Real-time delivery**: Order may vary by network conditions (acceptable)
- **Storage/query**: Always guaranteed correct order via `createdAt` sorting
- **Server scaling**: All servers read from the same MongoDB, ensuring consistent order

A compound index on `chatRoomId + createdAt` was added to MongoDB to optimize sorting performance.

![](/uploads/chat-message-ordering/result.svg)

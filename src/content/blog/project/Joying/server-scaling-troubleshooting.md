---
title: '서버 여러 대로 확장하려면 + 자잘한 트러블슈팅'
titleEn: 'Scaling to Multiple Servers + Minor Troubleshooting'
description: SimpleBroker의 수평 확장 한계를 Redis 세션 관리로 해결하고, LocalDateTime→Instant 마이그레이션, 커서 기반 페이지네이션, SockJS Fallback 등 트러블슈팅을 정리한다.
descriptionEn: Resolves SimpleBroker's horizontal scaling limitation with Redis session management, and documents troubleshooting including LocalDateTime to Instant migration, cursor pagination, and SockJS fallback.
date: 2025-12-21T00:00:00.000Z
tags:
  - WebSocket
  - Redis
  - Scale-out
  - Cursor Pagination
  - SockJS
  - Instant
category: project/Joying
draft: false
coverImage: "/uploads/project/Joying/server-scaling-troubleshooting/simple-broker.svg"
---

서버를 여러 대로 확장할 때 필요한 설계를 정리한다.

---

## SimpleBroker의 한계

처음에는 Spring WebSocket의 SimpleBroker를 사용했다.

![](/uploads/project/Joying/server-scaling-troubleshooting/simple-broker.svg)


SimpleBroker는 구독 정보를 서버 메모리에 저장한다.

![](/uploads/project/Joying/server-scaling-troubleshooting/simple-broker-memory.png)


현재는 서버 1대라서 문제가 없다. 하지만 서버를 여러 대로 확장하면 문제가 발생한다.

**[스케일 아웃 시나리오]**

![](/uploads/project/Joying/server-scaling-troubleshooting/scale-out-scenario.png)


SimpleBroker는 서버 확장이 불가능하다.

---

## 세션 관리 방법 검토

서버 확장을 위한 세션 관리 방법을 검토했다.

### 1. SimpleBroker 유지 + Sticky Session

코드 변경은 최소화되지만, 특정 서버에 부하가 집중되고 서버 다운 시 세션이 유실된다. 진정한 수평 확장이 아니다.

### 2. RabbitMQ STOMP Broker

Spring이 공식 지원하는 메시지 브로커 전문 솔루션이지만, 이미 Redis Pub/Sub을 사용 중인데 새로운 인프라를 추가하는 건 운영 부담이었다.

### 3. Redis 세션 관리 (선택)

이미 Redis Pub/Sub, 캐싱으로 Redis를 사용 중이라 추가 인프라 없이 적용 가능했다. SimpleBroker를 제거하고 직접 세션을 관리하는 코드를 작성하는 방향으로 결정했다.

---

## 해결: Redis 세션 관리

SimpleBroker를 제거하고, WebSocket 세션 정보를 Redis에 저장한다.


![](/uploads/project/Joying/server-scaling-troubleshooting/redis-session-management.png)


모든 서버가 Redis Pub/Sub을 구독하므로, 각 서버가 자기에게 연결된 사용자에게 메시지를 전달한다.

---

## 실제 구현

### WebSocketEventListener

![](/uploads/project/Joying/server-scaling-troubleshooting/websocket-event-listener.svg)


### ChatMessageListener

![](/uploads/project/Joying/server-scaling-troubleshooting/chat-message-listener.svg)


**핵심:** `convertAndSendToUser`의 첫 번째 파라미터는 Principal의 name과 매칭된다. WebSocket 연결 시 Principal의 name을 memberId로 설정했으므로, memberId를 전달하면 해당 사용자에게 메시지가 전송된다.

### SimpleBroker 없이 작동하는 원리

SimpleBroker를 제거해도 `convertAndSendToUser`가 작동하는 이유:

**Spring 내부 동작**
>
1. convertAndSendToUser("123", "/queue/chat/1", message) 호출
2. UserDestinationMessageHandler가 "/user/123/queue/chat/1"로 변환
3. 해당 서버의 WebSocket 세션 레지스트리에서 user "123" 검색
4. 연결되어 있으면 직접 전송, 없으면 조용히 무시 (에러 X)


SimpleBroker는 `/topic`, `/queue` prefix를 처리하는 역할이다. `convertAndSendToUser`는 SimpleBroker와 별개로 `UserDestinationMessageHandler`가 처리하므로 SimpleBroker 없이도 작동한다.

**모든 서버가 동일한 메시지를 받아서 `convertAndSendToUser`를 호출하고, 연결된 서버에서만 실제 전송이 성공한다.** 나머지 서버에서는 해당 사용자가 연결되어 있지 않으므로 전송이 무시된다.

---

## 확장 시나리오 비교

### Before (SimpleBroker)


**[서버 1]**
SimpleBroker 메모리: { "/topic/chat/123": [sessionA] }
-> 메시지 발행
-> sessionA에게만 전송 (다른 서버의 세션은 못 받음)


### After (Redis Pub/Sub + memberId 기반 전송)


**[서버 1: userA 연결]**
Redis Pub/Sub 수신 -> convertAndSendToUser("userA") -> 성공
                  -> convertAndSendToUser("userB") -> 실패 (연결 없음)

**[서버 2: userB 연결]**
Redis Pub/Sub 수신 -> convertAndSendToUser("userA") -> 실패 (연결 없음)
                  -> convertAndSendToUser("userB") -> 성공

-> 모든 서버가 Redis Pub/Sub을 구독하므로 확장 가능
-> 각 서버가 자기에게 연결된 사용자에게만 실제 전송


---

## LocalDateTime -> Instant 마이그레이션

재연결 메커니즘을 구현하면서 타임존 문제를 발견했다.

### LocalDateTime의 문제

![](/uploads/project/Joying/server-scaling-troubleshooting/localdatetime-problem.svg)


LocalDateTime은 타임존 정보가 없다. 서버의 로컬 시간 기준이다.

**한국 서버**
LocalDateTime.now() -> 2025-01-10T15:30:00 (KST)

**미국 서버로 확장 시**
LocalDateTime.now() -> 2025-01-10T01:30:00 (EST)

-> 같은 시각인데 시간이 다름
-> 메시지 순서가 엉킴


### Instant로 해결

![](/uploads/project/Joying/server-scaling-troubleshooting/instant-solution.svg)


Instant는 항상 UTC 기준이다. 전 세계 어디서나 동일한 값이다.

![](/uploads/project/Joying/server-scaling-troubleshooting/localdatetime-vs-instant.png)


---

## 커서 기반 페이지네이션

무한 스크롤을 구현하면서 Offset 페이징의 문제를 발견했다.

### Offset 페이징의 문제

![](/uploads/project/Joying/server-scaling-troubleshooting/offset-paging-problem.svg)


페이지가 뒤로 갈수록 스캔하는 Document가 기하급수적으로 늘어난다.

### 커서 페이징으로 해결

![](/uploads/project/Joying/server-scaling-troubleshooting/cursor-paging-solution.svg)


인덱스를 타고 정확한 위치로 바로 점프한다.

### 성능 비교

**MongoDB 10만 개 메시지 환경**

**Offset 방식**
- 첫 페이지: 10ms
- 100번째 페이지: 450ms

**커서 방식**
- 첫 로드: 12ms
- 100번째 로드: 12ms

-> 커서 방식은 몇천 개를 스크롤해도 속도가 일정


---

## SockJS: 브라우저 호환성

오래된 브라우저는 WebSocket을 지원하지 않는다. SockJS로 해결했다.

![](/uploads/project/Joying/server-scaling-troubleshooting/sockjs.svg)


SockJS는 자동으로 최적의 전송 방식을 선택한다.

1순위: WebSocket
2순위: HTTP Streaming
3순위: HTTP Long Polling


---

## 최종 아키텍처

![](/uploads/project/Joying/server-scaling-troubleshooting/final-architecture.png)

---

6주 프로젝트에서 채팅 시스템을 처음부터 구현하면서 실시간 시스템의 복잡함과 트레이드오프를 고려한 설계의 중요성을 깨달았다. 초기 설계의 완성도가 이후 개발 속도에 직접적인 영향을 미친다는 점을 체감했고, 개발 과정에서 설계의 부족한 부분이 여러 차례 드러났다. 설계 역량을 키우는 것이 성장의 핵심이라는 것을 배웠다.

<!-- EN -->

This post covers the design considerations for scaling to multiple servers.

---

## SimpleBroker's Limitation

Initially, we used Spring WebSocket's SimpleBroker.

![](/uploads/project/Joying/server-scaling-troubleshooting/simple-broker.svg)

SimpleBroker stores subscription information in server memory.

![](/uploads/project/Joying/server-scaling-troubleshooting/simple-broker-memory.png)

With a single server, this works fine. But when scaling to multiple servers, problems arise.

**[Scale-out Scenario]**

![](/uploads/project/Joying/server-scaling-troubleshooting/scale-out-scenario.png)

SimpleBroker cannot support server scaling.

---

## Session Management Options

We reviewed session management options for horizontal scaling.

### 1. SimpleBroker + Sticky Session

Minimal code changes, but load concentrates on specific servers and sessions are lost on server failure. Not true horizontal scaling.

### 2. RabbitMQ STOMP Broker

An officially supported message broker solution, but adding new infrastructure when we were already using Redis Pub/Sub would increase operational overhead.

### 3. Redis Session Management (Chosen)

Since we were already using Redis for Pub/Sub and caching, it required no additional infrastructure. We decided to remove SimpleBroker and write custom session management code.

---

## Solution: Redis Session Management

We removed SimpleBroker and stored WebSocket session information in Redis.

![](/uploads/project/Joying/server-scaling-troubleshooting/redis-session-management.png)

All servers subscribe to Redis Pub/Sub, so each server delivers messages to users connected to it.

---

## Implementation

### WebSocketEventListener

![](/uploads/project/Joying/server-scaling-troubleshooting/websocket-event-listener.svg)

### ChatMessageListener

![](/uploads/project/Joying/server-scaling-troubleshooting/chat-message-listener.svg)

**Key point:** The first parameter of `convertAndSendToUser` matches the Principal's name. Since we set the Principal's name to memberId during WebSocket connection, passing the memberId sends messages to that user.

### How It Works Without SimpleBroker

Why `convertAndSendToUser` works even after removing SimpleBroker:

**Spring Internal Behavior**
>
1. convertAndSendToUser("123", "/queue/chat/1", message) is called
2. UserDestinationMessageHandler transforms it to "/user/123/queue/chat/1"
3. Searches for user "123" in the server's WebSocket session registry
4. If connected, sends directly; if not, silently ignores (no error)

SimpleBroker handles `/topic` and `/queue` prefixes. `convertAndSendToUser` is handled by `UserDestinationMessageHandler` independently, so it works without SimpleBroker.

**All servers receive the same message and call `convertAndSendToUser`. Only the server with the active connection succeeds.** Other servers silently ignore the call since the user isn't connected to them.

---

## Scale-out Scenario Comparison

### Before (SimpleBroker)

**[Server 1]**
SimpleBroker memory: { "/topic/chat/123": [sessionA] }
-> Publish message
-> Sends only to sessionA (other servers' sessions can't receive)

### After (Redis Pub/Sub + memberId-based delivery)

**[Server 1: userA connected]**
Redis Pub/Sub received -> convertAndSendToUser("userA") -> Success
                       -> convertAndSendToUser("userB") -> Fail (not connected)

**[Server 2: userB connected]**
Redis Pub/Sub received -> convertAndSendToUser("userA") -> Fail (not connected)
                       -> convertAndSendToUser("userB") -> Success

-> All servers subscribe to Redis Pub/Sub, enabling scaling
-> Each server only delivers to its own connected users

---

## LocalDateTime to Instant Migration

While implementing the reconnection mechanism, we discovered a timezone issue.

### The Problem with LocalDateTime

![](/uploads/project/Joying/server-scaling-troubleshooting/localdatetime-problem.svg)

LocalDateTime has no timezone information. It's based on the server's local time.

**Korean server**
LocalDateTime.now() -> 2025-01-10T15:30:00 (KST)

**When scaling to a US server**
LocalDateTime.now() -> 2025-01-10T01:30:00 (EST)

-> Same moment, different time values
-> Message ordering breaks

### Solution: Instant

![](/uploads/project/Joying/server-scaling-troubleshooting/instant-solution.svg)

Instant is always UTC-based, producing identical values worldwide.

![](/uploads/project/Joying/server-scaling-troubleshooting/localdatetime-vs-instant.png)

---

## Cursor-based Pagination

While implementing infinite scroll, we found problems with offset-based pagination.

### Offset Pagination Problem

![](/uploads/project/Joying/server-scaling-troubleshooting/offset-paging-problem.svg)

As pages go further back, the number of scanned documents grows exponentially.

### Cursor Pagination Solution

![](/uploads/project/Joying/server-scaling-troubleshooting/cursor-paging-solution.svg)

Uses the index to jump directly to the exact position.

### Performance Comparison

**MongoDB environment with 100K messages**

**Offset approach**
- First page: 10ms
- 100th page: 450ms

**Cursor approach**
- First load: 12ms
- 100th load: 12ms

-> Cursor-based pagination maintains constant speed regardless of scroll depth

---

## SockJS: Browser Compatibility

Older browsers don't support WebSocket. We solved this with SockJS.

![](/uploads/project/Joying/server-scaling-troubleshooting/sockjs.svg)

SockJS automatically selects the optimal transport:

1st priority: WebSocket
2nd priority: HTTP Streaming
3rd priority: HTTP Long Polling

---

## Final Architecture

![](/uploads/project/Joying/server-scaling-troubleshooting/final-architecture.png)

---

Building the chat system from scratch in a 6-week project taught us the complexity of real-time systems and the importance of design with trade-offs in mind. We realized that the quality of initial design directly impacts subsequent development speed. The design gaps repeatedly surfaced during development, reinforcing that growing design capabilities is the key to professional growth.

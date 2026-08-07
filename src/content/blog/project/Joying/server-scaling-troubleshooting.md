---
title: '서버 여러 대로 확장하려면 + 자잘한 트러블슈팅'
description: SimpleBroker의 수평 확장 한계를 Redis 세션 관리로 해결하고, LocalDateTime→Instant 마이그레이션, 커서 기반 페이지네이션, SockJS Fallback 등 트러블슈팅을 정리한다.
date: 2025-12-21T00:00:00.000Z
tags:
  - WebSocket
  - Redis
  - Scale-out
  - Cursor Pagination
  - SockJS
  - Instant
category: team/Joying
draft: false
coverImage: "/uploads/project/Joying/server-scaling-troubleshooting/simple-broker.svg"
series: "Joying"
---

서버를 여러 대로 확장할 때 필요한 설계를 정리합니다.

---

## 0. 정상 상태

**서버 환경**: EC2 t3.medium (2 vCPU, 4GB RAM) **1대**, Spring Boot + WebSocket STOMP + SimpleBroker, MySQL 8.0, MongoDB 6.0, Redis 7.x 모두 Docker Compose로 운영.

**동시 접속**: 테스트 환경 기준 20-30명. 서버 1대로 기능은 정상 동작.

**현재 구조의 한계**: 서버 1대로 운영 중이므로 서버 장애 시 전체 서비스 중단. 사용자가 늘어나면 수평 확장이 필요한데, SimpleBroker는 구독 정보를 서버 메모리에 저장하므로 Scale-out이 불가.

---

## 1. SimpleBroker의 한계

처음에는 Spring WebSocket의 SimpleBroker를 사용했습니다.

![](/uploads/project/Joying/server-scaling-troubleshooting/simple-broker.svg)


SimpleBroker는 구독 정보를 서버 메모리에 저장합니다.

![](/uploads/project/Joying/server-scaling-troubleshooting/simple-broker-memory.png)


현재는 서버 1대라서 문제가 없습니다. 하지만 서버를 여러 대로 확장하면 문제가 발생합니다.

**[스케일 아웃 시나리오]**

![](/uploads/project/Joying/server-scaling-troubleshooting/scale-out-scenario.png)


SimpleBroker는 서버 확장이 불가능합니다.

---

## 세션 관리 방법 검토

서버 확장을 위한 세션 관리 방법을 검토했습니다.

### 1. SimpleBroker 유지 + Sticky Session

코드 변경은 최소화되지만, 특정 서버에 부하가 집중되고 서버 다운 시 세션이 유실됩니다. 진정한 수평 확장이 아닙니다.

### 2. RabbitMQ STOMP Broker

Spring이 공식 지원하는 메시지 브로커 전문 솔루션이지만, 이미 Redis Pub/Sub을 사용 중인데 새로운 인프라를 추가하는 건 운영 부담이었습니다.

### 3. Redis 세션 관리 (선택)

이미 Redis Pub/Sub, 캐싱으로 Redis를 사용 중이라 추가 인프라 없이 적용 가능했습니다. SimpleBroker를 제거하고 직접 세션을 관리하는 코드를 작성하는 방향으로 결정했습니다.

---

## 해결: Redis 세션 관리

SimpleBroker를 제거하고, WebSocket 세션 정보를 Redis에 저장합니다.


![](/uploads/project/Joying/server-scaling-troubleshooting/redis-session-management.png)


모든 서버가 Redis Pub/Sub을 구독하므로, 각 서버가 자기에게 연결된 사용자에게 메시지를 전달합니다.

---

## 실제 구현

### WebSocketEventListener

![](/uploads/project/Joying/server-scaling-troubleshooting/websocket-event-listener.svg)


### ChatMessageListener

![](/uploads/project/Joying/server-scaling-troubleshooting/chat-message-listener.svg)


**핵심:** `convertAndSendToUser`의 첫 번째 파라미터는 Principal의 name과 매칭됩니다. WebSocket 연결 시 Principal의 name을 memberId로 설정했으므로, memberId를 전달하면 해당 사용자에게 메시지가 전송됩니다.

### SimpleBroker 없이 작동하는 원리

SimpleBroker를 제거해도 `convertAndSendToUser`가 작동하는 이유:

**Spring 내부 동작**
>
1. convertAndSendToUser("123", "/queue/chat/1", message) 호출
2. UserDestinationMessageHandler가 "/user/123/queue/chat/1"로 변환
3. 해당 서버의 WebSocket 세션 레지스트리에서 user "123" 검색
4. 연결되어 있으면 직접 전송, 없으면 조용히 무시 (에러 X)


SimpleBroker는 `/topic`, `/queue` prefix를 처리하는 역할입니다. `convertAndSendToUser`는 SimpleBroker와 별개로 `UserDestinationMessageHandler`가 처리하므로 SimpleBroker 없이도 작동합니다.

**모든 서버가 동일한 메시지를 받아서 `convertAndSendToUser`를 호출하고, 연결된 서버에서만 실제 전송이 성공합니다.** 나머지 서버에서는 해당 사용자가 연결되어 있지 않으므로 전송이 무시됩니다.

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

재연결 메커니즘을 구현하면서 타임존 문제를 발견했습니다.

### LocalDateTime의 문제

![](/uploads/project/Joying/server-scaling-troubleshooting/localdatetime-problem.svg)


LocalDateTime은 타임존 정보가 없습니다. 서버의 로컬 시간 기준입니다.

**한국 서버**
LocalDateTime.now() -> 2025-01-10T15:30:00 (KST)

**미국 서버로 확장 시**
LocalDateTime.now() -> 2025-01-10T01:30:00 (EST)

-> 같은 시각인데 시간이 다름
-> 메시지 순서가 엉킴


### Instant로 해결

![](/uploads/project/Joying/server-scaling-troubleshooting/instant-solution.svg)


Instant는 항상 UTC 기준입니다. 전 세계 어디서나 동일한 값입니다.

![](/uploads/project/Joying/server-scaling-troubleshooting/localdatetime-vs-instant.png)


---

## 커서 기반 페이지네이션

무한 스크롤을 구현하면서 Offset 페이징의 문제를 발견했습니다.

### Offset 페이징의 문제

![](/uploads/project/Joying/server-scaling-troubleshooting/offset-paging-problem.svg)


페이지가 뒤로 갈수록 스캔하는 Document가 기하급수적으로 늘어납니다.

### 커서 페이징으로 해결

![](/uploads/project/Joying/server-scaling-troubleshooting/cursor-paging-solution.svg)


인덱스를 타고 정확한 위치로 바로 점프합니다.

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

오래된 브라우저는 WebSocket을 지원하지 않습니다. SockJS로 해결했습니다.

![](/uploads/project/Joying/server-scaling-troubleshooting/sockjs.svg)


SockJS는 자동으로 최적의 전송 방식을 선택합니다.

1순위: WebSocket
2순위: HTTP Streaming
3순위: HTTP Long Polling


---

## 최종 아키텍처

![](/uploads/project/Joying/server-scaling-troubleshooting/final-architecture.png)

---

6주 프로젝트에서 채팅 시스템을 처음부터 구현하면서 실시간 시스템의 복잡함과 트레이드오프를 고려한 설계의 중요성을 깨달았습니다. 초기 설계의 완성도가 이후 개발 속도에 직접적인 영향을 미친다는 점을 체감했고, 개발 과정에서 설계의 부족한 부분이 여러 차례 드러났습니다. 설계 역량을 키우는 것이 성장의 핵심이라는 것을 배웠습니다.

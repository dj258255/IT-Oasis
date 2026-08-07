---
title: 'WebSocket 끊기면 메시지를 잃어버린다'
description: Redis Pub/Sub의 Fire-and-Forget 특성으로 WebSocket 재연결 시 메시지가 유실되는 문제를 MongoDB 기반 커서 페이지네이션으로 해결한 과정을 정리한다.
date: 2025-12-16T00:00:00.000Z
tags:
  - WebSocket
  - Redis Pub/Sub
  - MongoDB
  - Cursor Pagination
  - Message Recovery
category: team/Joying
draft: false
coverImage: "/uploads/project/Joying/websocket-message-loss/unified-api.svg"
series: "Joying"
---

성능 문제는 해결했습니다. 그런데 모바일 테스트 중 예상치 못한 현상이 발견됐습니다.

---

## 0. 정상 상태

**서버 환경**: EC2 t3.medium (2 vCPU, 4GB RAM), Spring Boot + WebSocket (STOMP), Redis Pub/Sub으로 실시간 메시지 전달, MongoDB에 메시지 영구 저장.

**동시 접속**: 테스트 환경 기준 10-20명. 모바일(Android) + 웹(React) 혼합 환경.

**정상 동작**: WebSocket 연결이 유지된 상태에서 메시지 전송 → Redis Pub/Sub → 수신까지 평균 5-10ms. 메시지 유실 0건.

---

## 1. 문제 발견

모바일 환경에서 테스트 중 다음과 같은 오류가 보고됐습니다.

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

Redis Pub/Sub은 메시지를 저장하지 않습니다. 현재 구독 중인 클라이언트에게만 전송하고 즉시 폐기합니다.


**Redis Pub/Sub 동작**
1. 메시지 발행
2. 현재 연결된 구독자에게 전송
3. 메시지 삭제

> 연결이 끊긴 동안 발행된 메시지는 영영 못 받음


MongoDB에는 모든 메시지가 저장되어 있습니다. 하지만 WebSocket이 끊긴 동안 발행된 Pub/Sub 메시지는 유실됩니다.

---

## 메시지 복구 방법 검토

재연결 시 놓친 메시지를 복구하는 방법을 검토했습니다.

### 1. Kafka Consumer Group

Kafka는 Consumer Group 단위로 Offset을 관리해서 재연결 시 재전송이 완벽합니다. 하지만 Kafka 클러스터가 필요하고, 현재 트래픽(초당 100건)에는 과합니다.

### 2. Redis Stream

Redis Stream은 메시지를 저장하면서 Consumer Group도 지원합니다. 하지만 ACK 처리 로직이 필요하고, **이미 MongoDB에 메시지가 저장되어 있어서 같은 데이터를 두 곳에 저장하는 셈**입니다.

### 3. 서버 푸시 큐

서버에서 사용자별로 미전송 메시지 큐를 관리하는 방식입니다. 재연결 시 빠르지만, 서버 재시작이나 확장 시 큐가 유실되거나 동기화가 안 되는 문제가 있습니다.

### 4. MongoDB 조회 (선택)

**이미 MongoDB에 모든 메시지가 저장되어 있습니다.** 재연결 시 마지막 수신 시간 이후 메시지를 조회하면 됩니다. 추가 인프라 없이 기존 데이터를 그대로 활용할 수 있고, 재연결 시 50-100ms 지연은 사용자가 체감하기 어려운 수준입니다.

---

## 해결: MongoDB 활용


**재연결 시나리오**
1. WebSocket 연결 끊김
2. 마지막으로 받은 메시지 시간 기록 (클라이언트)
3. 네트워크 복구 후 WebSocket 재연결
4. 그 시간 이후 메시지 REST API로 조회
5. 못 받은 메시지 복구


Redis Pub/Sub은 실시간 전달만 담당하고, 메시지 복구는 MongoDB에서 처리합니다.

---

## 커서 기반 페이지네이션

재연결 API를 설계하면서 무한 스크롤 API와 합칠 수 있다는 점을 발견했습니다.


무한 스크롤: before 파라미터로 과거 방향 조회
재연결: after 파라미터로 미래 방향 조회

> 둘 다 커서 기반 조회


### 통합 API

![](/uploads/project/Joying/websocket-message-loss/unified-api.svg)


하나의 API로 두 가지 용도를 처리합니다.

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

복합 인덱스로 chatRoomId와 createdAt 기준 조회를 최적화했습니다.

---

## 클라이언트 재연결 로직

프론트엔드에서 구현해야 할 로직:

![](/uploads/project/Joying/websocket-message-loss/client-reconnection.svg)


---

## 결과

> **측정 조건**: EC2 t3.medium, 10명 동시 접속, WiFi 끊김 시뮬레이션 (모바일 네트워크 토글)

| 시나리오 | Before | After |
|----------|--------|-------|
| 네트워크 끊김 후 재연결 | 중간 메시지 유실 | 모든 메시지 복구 |
| 재연결 시 복구 소요 시간 | — (복구 불가) | 50-100ms (20건 기준) |
| API 개수 | 2개 (스크롤 + 재연결) | 1개 (통합) |

---
title: '빌려조잉 - 삼성 우수상, 그리고 팀원 이탈 속에서 배운 것들'
titleEn: 'Joying - Samsung Excellence Award and Lessons from Team Member Departures'
description: C2C 공유 플랫폼 빌려조잉을 6주간 개발하며 채팅 시스템 설계, 팀원 이탈 대응, 그리고 삼성 우수상까지의 여정을 정리했습니다.
descriptionEn: A retrospective on building Joying, a C2C sharing platform, covering chat system design, handling team departures, and winning the Samsung Excellence Award.
date: 2025-11-20
tags:
  - Retrospective
  - Spring Boot
  - WebSocket
  - Redis
  - MongoDB
  - Kotlin
category: project/Joying
coverImage: /uploads/project/Joying/retrospective/title.gif
draft: false
---

## 프로젝트 소개

빌려조잉은 **물건을 서로 빌리고 빌려주는 C2C 공유 플랫폼**입니다. 캠핑 텐트(30만원), 빔프로젝터(50만원)처럼 1-2번 쓰고 방치되는 물건을 이웃 간에 대여하면, 빌려주는 사람은 수익을, 빌리는 사람은 저렴한 비용을, 사회는 자원 낭비 감소를 얻을 수 있습니다.

![빌려조잉 아키텍처](/uploads/project/Joying/retrospective/architecture.png)

**기간**: 2025.10.10 - 2025.11.20 (6주)
**팀 구성**: 6명 (프론트엔드 2명, 백엔드 4명)
**수상**: 삼성전자 주식회사 프로젝트 **우수상**
**기술 스택**: Java, Kotlin, Spring Boot, WebSocket, Redis Pub/Sub, MongoDB, MySQL

---

## 내 역할

백엔드(35%) + 프론트엔드(10%)를 담당했습니다. **회원 시스템**(Spring Security + JWT)과 **실시간 채팅 시스템** 전체를 맡았고, 마감 직전에는 프론트엔드 API 연동까지 직접 했습니다.

이 프로젝트에서 가장 많이 성장한 부분은 **분산 시스템에서의 트레이드오프 판단**이었습니다.

---

## 주요 구현

### 실시간 채팅 시스템 (WebSocket + Redis Pub/Sub)

채팅에 폴링은 불필요한 요청이 너무 많고, SSE는 단방향이라 양방향 실시간 통신이 필요한 채팅에 부적합했습니다. WebSocket을 선택했고, 서버 확장을 대비해 SimpleBroker 대신 **Redis Pub/Sub**으로 메시지를 브로드캐스트했습니다. 메시지 유실 방지를 위해 MongoDB에 영속화하고, REST API 폴백으로 재연결 시 누락 메시지를 복구했습니다.

> 상세 분석: [WebSocket 메시지 유실 방지](/blog/project/joying/websocket-message-loss) · [서버 스케일링](/blog/project/joying/server-scaling-troubleshooting)

### AI 자동 게시글 생성 (LangChain)

대여료를 얼마나 받아야 할지 판매자가 정하기 어려운 문제가 있었습니다. GPT-4o Vision으로 이미지에서 물건 상태를 파악하고, 네이버 쇼핑 API로 시세를 조사한 뒤 적정 대여료를 자동 계산하는 **4단계 파이프라인**을 구현했습니다.

![AI 자동 게시글 생성](/uploads/project/Joying/retrospective/langchain.gif)

### Polyglot Persistence 설계

채팅 데이터 특성에 맞게 저장소를 분리했습니다. **MySQL**로 채팅방과 사용자 관계(트랜잭션, 조인 필요), **MongoDB**로 채팅 메시지(쓰기 성능, 스키마 유연성), **Redis**로 Pub/Sub과 안읽은 메시지 수 캐싱(초저지연 조회)을 담당하게 했습니다.

> 상세 분석: [MySQL, MongoDB, Redis 왜 세 가지나 쓰나요?](/blog/project/joying/mysql-mongodb-redis-why)

---

## 기억에 남는 트러블슈팅

### Coroutine + JPA Lazy Loading 충돌 → 401 에러?

가장 기억에 남는 삽질입니다. `suspend fun`에서 `withContext(Dispatchers.IO)`를 쓰면 스레드가 전환되는데, Hibernate Session은 ThreadLocal에 바인딩되어 있어서 새 스레드에서는 Session을 찾을 수 없습니다. 여기까지는 논리적으로 이해가 되는데, 문제는 이 `LazyInitializationException`이 Spring Security에서 **401 Unauthorized**로 변환됐다는 겁니다.

반나절 동안 JWT 토큰 설정, Security 설정을 의심하다가 결국 스택트레이스를 뜯어보고 원인을 찾았습니다. `runBlocking`으로 스레드 전환을 방지하고, Fetch Join으로 필요한 데이터를 미리 로딩하는 이중 안전장치를 적용했습니다.

> 상세 분석: [Coroutine + JPA 401 에러](/blog/project/joying/coroutine-jpa-401)

### 채팅방 목록 N+1 (1.3초 → 65ms)

채팅방 10개 조회 시 각 채팅방의 안읽은 메시지 수를 개별 Redis GET으로 조회하면서 N+1 문제가 발생했습니다. Redis MGET으로 배치 조회하고, 캐시 미스는 Coroutine async로 MongoDB 병렬 조회하니 **1.3초에서 65ms로 95% 개선**됐습니다.

> 상세 분석: [채팅방 목록 느린 쿼리](/blog/project/joying/chatroom-list-slow-query) · [Inbound Thread 최적화](/blog/project/joying/inbound-thread-optimization)

### Redis CVSS 10.0 취약점 긴급 대응

보안 뉴스에서 CVE-2025-49844 "RediShell"(CVSS 10.0) 소식을 접했는데, 우리가 쓰던 Redis 7.0.15가 정확히 취약 버전이었습니다. 즉시 7.2.11로 업그레이드하고, 인증 활성화 + EVAL 명령어 비활성화 + Docker 네트워크 격리까지 **다층 방어**를 적용했습니다.

> 상세 분석: [Redis 취약점 긴급 패치](/blog/project/joying/redis-security-issue)

---

## 팀원 이탈, 그리고 대응

3주차에 에스크로 결제 담당자가 취업으로 팀을 떠났습니다. DB 스키마는 설계되어 있었지만 서비스 로직은 판매 플로우만 구현된 상태였습니다. 남은 팀원 중 아무도 이어받으려 하지 않았습니다.

제가 직접 맡았습니다. 토스페이먼츠 에스크로 문서를 3일간 분석하고, 빌리는 사람 관점의 역방향 로직을 구현해서 양방향 거래 플로우를 완성했습니다.

마감 1주일 전에는 10개 화면 중 7개가 API 연동 없이 하드코딩된 상태라는 걸 발견했습니다. Swagger로 API 문서를 자동 생성한 뒤, 연동이 안 되는 화면은 **직접 React 코드를 수정**해서 배포 전날까지 모든 화면 연동을 완료했습니다.

---

## 느낀 점

### 기다리기보다 직접 움직이기

담당자가 빠진 기능, 연동이 안 되는 화면 - 기다리면 아무것도 해결되지 않습니다. **먼저 손을 들면 프로젝트가 진행됩니다.** 백엔드 개발자가 프론트엔드 코드를 수정할 수 있으면 병목을 해소할 수 있다는 것도 배웠습니다.

### 삼성 우수상

결과적으로 삼성전자 프로젝트 우수상을 받았습니다. 팀원 이탈이라는 위기 속에서도 서비스를 완성한 경험이 심사에서 좋게 평가받은 것 같습니다. 기술적 완성도만큼이나 **위기 대응 능력**이 프로젝트 성패를 가른다는 걸 체감했습니다.

<!-- EN -->

## About the Project

Joying is a **C2C sharing platform where people lend and borrow items from each other**. Items like camping tents (300K KRW) or beam projectors (500K KRW) that sit unused after one or two uses — if neighbors could rent these out, lenders earn income, borrowers save money, and society reduces waste.

![Joying Architecture](/uploads/project/Joying/retrospective/architecture.png)

**Duration**: Oct 10 – Nov 20, 2025 (6 weeks)
**Team**: 6 members (2 Frontend, 4 Backend)
**Award**: Samsung Electronics Project **Excellence Award**
**Tech Stack**: Java, Kotlin, Spring Boot, WebSocket, Redis Pub/Sub, MongoDB, MySQL

---

## My Role

I was responsible for backend (35%) + frontend (10%). I owned the entire **member system** (Spring Security + JWT) and the **real-time chat system**, and in the final stretch, I even handled frontend API integration directly.

The area where I grew the most in this project was **making trade-off decisions in distributed systems**.

---

## Key Implementations

### Real-Time Chat System (WebSocket + Redis Pub/Sub)

Polling generates too many unnecessary requests for chat, and SSE is unidirectional — unsuitable for bidirectional real-time communication. I chose WebSocket, and for server scalability, I used **Redis Pub/Sub** instead of SimpleBroker to broadcast messages. Messages are persisted to MongoDB to prevent loss, with a REST API fallback to recover missed messages on reconnection.

> Detailed analysis: [WebSocket Message Loss Prevention](/blog/project/joying/websocket-message-loss) · [Server Scaling](/blog/project/joying/server-scaling-troubleshooting)

### AI Auto-Generated Listings (LangChain)

Sellers found it difficult to decide how much to charge for rentals. I built a **4-stage pipeline** that uses GPT-4o Vision to assess item condition from images, checks market prices via the Naver Shopping API, then automatically calculates an appropriate rental fee.

![AI Auto-Generated Listings](/uploads/project/Joying/retrospective/langchain.gif)

### Polyglot Persistence Design

I separated storage based on chat data characteristics. **MySQL** for chat rooms and user relationships (transactions, joins needed), **MongoDB** for chat messages (write performance, schema flexibility), and **Redis** for Pub/Sub and unread message count caching (ultra-low latency reads).

> Detailed analysis: [MySQL, MongoDB, Redis — Why Three?](/blog/project/joying/mysql-mongodb-redis-why)

---

## Memorable Troubleshooting

### Coroutine + JPA Lazy Loading Conflict → 401 Error?

This was my most memorable debugging session. Using `withContext(Dispatchers.IO)` in a `suspend fun` switches threads, but the Hibernate Session is bound to ThreadLocal — so the new thread can't find the Session. That part makes logical sense, but the problem was that this `LazyInitializationException` got **transformed into a 401 Unauthorized** by Spring Security.

I spent half a day suspecting JWT token configuration and Security settings, until I finally dug through the stack trace and found the real cause. I applied dual safeguards: `runBlocking` to prevent thread switching, and Fetch Join to eagerly load required data.

> Detailed analysis: [Coroutine + JPA 401 Error](/blog/project/joying/coroutine-jpa-401)

### Chat Room List N+1 (1.3s → 65ms)

When loading 10 chat rooms, fetching each room's unread message count via individual Redis GET calls caused an N+1 problem. By switching to Redis MGET for batch retrieval and using Coroutine async for parallel MongoDB queries on cache misses, I achieved a **95% improvement from 1.3 seconds to 65ms**.

> Detailed analysis: [Chat Room List Slow Query](/blog/project/joying/chatroom-list-slow-query) · [Inbound Thread Optimization](/blog/project/joying/inbound-thread-optimization)

### Redis CVSS 10.0 Vulnerability Emergency Response

I spotted CVE-2025-49844 "RediShell" (CVSS 10.0) in the security news, and our Redis 7.0.15 was exactly the vulnerable version. I immediately upgraded to 7.2.11 and applied **defense-in-depth**: authentication enabled + EVAL command disabled + Docker network isolation.

> Detailed analysis: [Redis Vulnerability Emergency Patch](/blog/project/joying/redis-security-issue)

---

## Team Member Departures and How I Responded

In week 3, the escrow payment developer left the team for a job opportunity. The DB schema was designed, but the service logic only had the seller flow implemented. No one on the remaining team wanted to take it over.

I volunteered. I spent 3 days analyzing the TossPayments escrow documentation, implemented the buyer-side reverse logic, and completed the bidirectional transaction flow.

One week before the deadline, I discovered that 7 out of 10 screens still had hardcoded data with no API integration. I auto-generated API documentation with Swagger, then **directly modified the React code** for screens that weren't connected, completing all screen integrations by the day before deployment.

---

## Takeaways

### Act Instead of Waiting

A feature without an owner, screens without API integration — waiting solves nothing. **Raising your hand first moves the project forward.** I also learned that a backend developer who can modify frontend code can eliminate bottlenecks.

### Samsung Excellence Award

We ended up winning the Samsung Electronics Project Excellence Award. I believe completing the service despite the crisis of team member departures was viewed favorably by the judges. I realized that **crisis response ability** determines project success just as much as technical quality.

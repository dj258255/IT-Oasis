---
title: 'Inbound Thread를 빨리 반환하면 더 많은 요청을 받을 수 있다'
description: Spring WebSocket STOMP의 Inbound Thread가 I/O 대기로 블로킹되는 문제를 분석하고, Kotlin Coroutine으로 스레드를 즉시 반환하도록 개선한 과정을 정리한다.
date: 2025-12-11T00:00:00.000Z
tags:
  - WebSocket
  - STOMP
  - Kotlin
  - Coroutine
  - Thread Pool
  - Non-blocking
category: team/Joying
draft: false
coverImage: "/uploads/project/Joying/inbound-thread-optimization/problem.svg"
series: "Joying"
---

## 배경: Spring WebSocket STOMP의 구조

일반적인 WebSocket 라이브러리(Netty, Ktor 등)는 EventLoop 방식으로 동작해서 Thread Pool 설정이 필요 없습니다. 하지만 Spring WebSocket STOMP는 Inbound/Outbound Channel에 각각 Thread Pool을 사용하는 구조입니다.

**Spring WebSocket STOMP 구조**
- Inbound Thread Pool: 클라이언트 → 서버 메시지 처리
- Outbound Thread Pool: 서버 → 클라이언트 메시지 전송

이 글은 Spring WebSocket STOMP를 사용할 때 Thread Pool을 효율적으로 활용하는 방법을 다룹니다.

---

## 0. 정상 상태

**서버 환경**: EC2 t3.medium (2 vCPU, 4GB RAM), Spring Boot 3.x + WebSocket STOMP.

**Inbound Thread Pool**: Spring WebSocket STOMP의 `clientInboundChannel` 기본 corePoolSize는 `Runtime.getRuntime().availableProcessors() * 2` = **4개** (t3.medium 2 vCPU 기준). 이 4개의 스레드가 모든 클라이언트의 메시지 전송을 처리한다.

**동시 접속**: 테스트 환경 기준 20명, 채팅방 50개. 피크 시 초당 10-20건의 메시지 전송.

**성능 기대치**: 채팅 메시지 전송은 사용자가 즉시 전달되었다고 느껴야 한다. Inbound Thread가 블로킹되면 다른 사용자의 메시지 처리가 밀리면서 **체감 지연**이 발생한다.

---

## 1. 문제: Thread가 I/O 대기 중에 멈춘다

Spring WebSocket STOMP Handler는 기본적으로 동기 방식입니다.

![](/uploads/project/Joying/inbound-thread-optimization/problem.svg)

메시지 한 건을 처리할 때 Inbound Thread가 뭘 하는지 뜯어봤습니다.

**메시지 1건당 Inbound Thread가 거치는 블로킹 I/O**
- MongoDB 영속화: 네트워크 왕복 후 쓰기 완료까지 대기
- Redis Pub/Sub 발행: 네트워크 왕복
- 안읽음 카운터 증가: 네트워크 왕복

정작 CPU가 일하는 시간은 파싱·DTO 변환 정도로 극히 짧고, 나머지는 전부 **I/O 응답을 기다리며 스레드를 붙잡고 있는 시간**입니다.

> 문제의 핵심은 평균 속도가 아니라 **결합(coupling)**입니다. 동기 구조에서 Inbound Pool의 처리 능력은 `스레드 수 ÷ 메시지당 I/O 시간`에 묶입니다. 평소에는 I/O가 밀리초 단위라 티가 안 나지만, MongoDB가 디스크 flush·락 경합·일시 지연으로 한 번 튀는 순간(tail latency) 스레드 4개가 전부 그 지연에 같이 잡히고, **다른 모든 사용자의 메시지 수신이 함께 멈춥니다.**


---

## Blocking I/O의 본질

MongoDB 저장 과정을 자세히 보면:

**MongoDB 저장 한 번의 내부**
1. 네트워크 패킷 전송 ← CPU 사용 (마이크로초 단위)
2. MongoDB 서버 처리·응답 대기 ← CPU 안 씀 (소요 시간의 대부분)
3. 네트워크 응답 수신 ← CPU 사용 (마이크로초 단위)

> 소요 시간의 대부분은 CPU가 노는 '대기'다

운영체제 관점에서 보면:

![](/uploads/project/Joying/inbound-thread-optimization/blocking-io.png)


Thread 1은 대기하는 동안 아무 일도 안 하지만 **Thread Pool의 자리를 차지**합니다. 다른 메시지는 Thread 1이 돌아올 때까지 기다려야 합니다.

---

## 비동기 처리 방법 검토

Blocking I/O 문제를 해결하기 위한 방법을 검토했습니다.

### 1. Spring @Async

![](/uploads/project/Joying/inbound-thread-optimization/spring-async.svg)

별도 Thread Pool을 만들어서 작업을 위임합니다. Inbound Thread는 즉시 반환되지만, I/O 대기 중인 Thread가 @Async Thread Pool로 이동했을 뿐 전체 시스템에서 블로킹되는 Thread 수는 동일합니다. Thread Pool 크기를 N으로 설정하면 동시에 N개까지만 처리 가능하고, 초과 요청은 큐에서 대기한다. Thread 수만 늘어나고 근본적인 해결이 안 됩니다. Coroutine과의 차이: Coroutine은 I/O 대기 중 Thread를 반환하고, I/O 완료 시 다시 Thread를 할당받는 구조라 같은 Thread 수로 더 많은 동시 요청을 처리할 수 있다.

### 2. Project Reactor (Reactive Programming)

![](/uploads/project/Joying/inbound-thread-optimization/project-reactor.svg)

완전한 Non-blocking을 구현할 수 있지만, 기존 JPA, JDBC 코드를 전부 Reactive로 바꿔야 합니다. 6주 프로젝트에서 전체 스택을 바꾸기엔 리스크가 컸습니다.

### 3. Virtual Threads (Java 21)

![](/uploads/project/Joying/inbound-thread-optimization/virtual-threads.svg)

JVM이 관리하는 경량 스레드로 수백만 개 생성 가능합니다. 가장 깔끔한 해결책이지만, 당시 프로젝트가 Java 17 기반이었습니다. Java 21 업그레이드는 Spring Boot 버전 변경과 의존성 충돌 위험이 따랐습니다.

### 4. Kotlin Coroutine (선택)

![](/uploads/project/Joying/inbound-thread-optimization/kotlin-coroutine.svg)

우리 프로젝트가 이미 Kotlin 기반이었기 때문에 `suspend`만 붙이면 기존 코드와 자연스럽게 통합됩니다. JPA, JDBC를 그대로 쓸 수 있고, Reactor보다 학습 곡선이 완만합니다. 다만 JPA Lazy Loading과 충돌할 수 있다는 점은 인지하고 있었습니다(이 문제는 별도 글에서 다룹니다).

---

## Coroutine 적용

Coroutine을 사용하면 Thread를 즉시 반환할 수 있습니다.

![](/uploads/project/Joying/inbound-thread-optimization/coroutine-applied.svg)


**Thread 점유 시간 비교**

**Before (Blocking)**
- Inbound Thread 점유: I/O가 끝날 때까지 이어짐(MongoDB 지연이 튀면 그대로 같이 묶임)

**After (Coroutine)**
- Inbound Thread 점유: 코루틴 디스패치까지만(즉시 반환)
- I/O 작업은 Dispatchers.IO 스레드 풀에서 별도 처리

---

## Java CompletableFuture로도 동일하게 가능하다

사실 Java CompletableFuture로도 **같은 효과**를 낼 수 있습니다.

### Java 버전

![](/uploads/project/Joying/inbound-thread-optimization/java-version.svg)


### Kotlin Coroutine 버전

![](/uploads/project/Joying/inbound-thread-optimization/kotlin-coroutine-2.svg)


둘 다 동일한 효과입니다. Inbound Thread를 빨리 반환하고, I/O 작업은 별도 스레드 풀에서 처리합니다.

---

## 왜 Coroutine을 선택했나

Java CompletableFuture로도 가능한데 Coroutine을 선택한 이유:

1. **채팅 파트는 내가 맡은 영역** - 기술 선택의 자유가 있었습니다
2. **프로젝트가 이미 Kotlin 기반** - 별도 설정 없이 바로 적용 가능했습니다
3. **코드 가독성** - `launch { }` 블록이 CompletableFuture 체이닝보다 직관적

---

## 주의: 진짜 Non-blocking은 아니다

**현재 구현**
- Inbound Thread: 즉시 반환
- Dispatchers.IO Thread: I/O가 끝날 때까지 blocking. 대기가 사라지지 않고 자리만 옮긴 것

**진짜 Non-blocking이 되려면**
- Reactive MongoDB Driver 필요
- suspend 함수 + awaitSingle() 조합


현재 구현은 **Inbound Thread Pool의 처리량을 높이는 것**이 목적입니다. 전체 시스템이 Non-blocking이 된 건 아닙니다.

---

## 실제 구현

### ChatMessageService

![](/uploads/project/Joying/inbound-thread-optimization/chat-message-mongodb.svg)


### WebSocket Controller

![](/uploads/project/Joying/inbound-thread-optimization/websocket-controller.svg)


---

## 결과

이 전환은 수치로 잰 개선이 아니라 **구조가 바뀐 것**이라, 비교도 구조로 정리하는 게 정확합니다.

| 관점 | Before (동기) | After (Coroutine) |
|------|--------|-------|
| Inbound Thread 점유 | I/O 완료까지 대기 | 디스패치 후 즉시 반환 |
| 처리량 상한 | 스레드 수 ÷ 메시지당 I/O 시간에 종속 | I/O 지연과 분리 (CPU 바운드만 남음) |
| MongoDB 지연 스파이크 | 전체 메시지 수신 정체로 전파 | Dispatchers.IO 안에 격리 |
| 실제 병목 지점 | Inbound Thread Pool | MongoDB/Redis I/O 대역폭 |

I/O 작업(MongoDB 저장, Redis 발행)의 총 소요 시간 자체는 그대로다. 하지만 이 작업을 Coroutine이 별도 I/O 스레드에서 비동기로 처리하므로, **Inbound Thread는 즉시 반환되어 다음 메시지를 받을 수 있다.** 병목이 "Thread Pool 크기"에서 "I/O 대역폭"으로 이동한 것이 핵심.

솔직한 한계도 남겨둡니다. 당시 테스트 규모(20명 동시 접속, 초당 10~20건)에서는 동기 구조로도 충분히 버틸 수 있었습니다. 이 전환의 가치는 그 시점의 처리량 숫자가 아니라, **I/O 지연 스파이크가 메시지 수신 경로 전체를 멈추지 못하게 만든 구조**에 있습니다.

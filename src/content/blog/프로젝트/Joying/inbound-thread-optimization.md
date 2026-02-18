---
title: 'Inbound Thread를 빨리 반환하면 더 많은 요청을 받을 수 있다'
titleEn: 'Returning Inbound Threads Faster Allows Handling More Requests'
description: Spring WebSocket STOMP의 Inbound Thread가 I/O 대기로 블로킹되는 문제를 분석하고, Kotlin Coroutine으로 스레드를 즉시 반환하도록 개선한 과정을 정리한다.
descriptionEn: Analyzes the blocking I/O problem in Spring WebSocket STOMP's Inbound Thread and improves it by returning threads immediately using Kotlin Coroutines.
date: 2025-12-11T00:00:00.000Z
tags:
  - WebSocket
  - STOMP
  - Kotlin
  - Coroutine
  - Thread Pool
  - Non-blocking
category: 프로젝트/Joying
draft: false
---

## 배경: Spring WebSocket STOMP의 구조

일반적인 WebSocket 라이브러리(Netty, Ktor 등)는 EventLoop 방식으로 동작해서 Thread Pool 설정이 필요 없다. 하지만 Spring WebSocket STOMP는 Inbound/Outbound Channel에 각각 Thread Pool을 사용하는 구조다.

**Spring WebSocket STOMP 구조**
- Inbound Thread Pool: 클라이언트 → 서버 메시지 처리
- Outbound Thread Pool: 서버 → 클라이언트 메시지 전송

이 글은 Spring WebSocket STOMP를 사용할 때 Thread Pool을 효율적으로 활용하는 방법에 대한 내용이다.

---

## 문제: Thread가 I/O 대기 중에 멈춘다

Spring WebSocket STOMP Handler는 기본적으로 동기 방식이다.

![](/uploads/프로젝트/Joying/inbound-thread-optimization/problem.svg)

Thread가 일하는 시간을 분석했다.


**Inbound Thread 1개**
- MongoDB 저장 대기: 100ms (일 안 함)
- Redis 발행 대기: 10ms (일 안 함)
- 실제로 CPU 쓰는 시간: <1ms

> Thread가 99%의 시간을 그냥 기다리는 데만 씀


---

## Blocking I/O의 본질

MongoDB 저장 과정을 자세히 보면:

**MongoDB 저장 (100ms)**
1. 네트워크 패킷 전송 (1ms) ← CPU 사용
2. MongoDB 서버 응답 대기 (98ms) ← CPU 안 씀
3. 네트워크 응답 수신 (1ms) ← CPU 사용

> 100ms 중 98ms는 CPU가 놀고 있음

운영체제 관점에서 보면:

![](/uploads/프로젝트/Joying/inbound-thread-optimization/blocking-io.png)


Thread 1은 98ms 동안 아무 일도 안 했지만 **Thread Pool의 자리를 차지**한다. 다른 메시지는 Thread 1이 돌아올 때까지 기다려야 한다.

---

## 비동기 처리 방법 검토

Blocking I/O 문제를 해결하기 위한 방법을 검토했다.

### 1. Spring @Async

![](/uploads/프로젝트/Joying/inbound-thread-optimization/spring-async.svg)

별도 Thread Pool을 만들어서 작업을 위임한다. 하지만 I/O 대기 중에도 Thread가 Blocked 상태로 점유되는 건 마찬가지다. Thread 수만 늘어나고 근본적인 해결이 안 된다.

### 2. Project Reactor (Reactive Programming)

![](/uploads/프로젝트/Joying/inbound-thread-optimization/project-reactor.svg)

완전한 Non-blocking을 구현할 수 있지만, 기존 JPA, JDBC 코드를 전부 Reactive로 바꿔야 한다. 6주 프로젝트에서 전체 스택을 바꾸기엔 리스크가 컸다.

### 3. Virtual Threads (Java 21)

![](/uploads/프로젝트/Joying/inbound-thread-optimization/virtual-threads.svg)

JVM이 관리하는 경량 스레드로 수백만 개 생성 가능하다. 가장 깔끔한 해결책이지만, 당시 프로젝트가 Java 17 기반이었다. Java 21 업그레이드는 Spring Boot 버전 변경과 의존성 충돌 위험이 따랐다.

### 4. Kotlin Coroutine (선택)

![](/uploads/프로젝트/Joying/inbound-thread-optimization/kotlin-coroutine.svg)

우리 프로젝트가 이미 Kotlin 기반이었기 때문에 `suspend`만 붙이면 기존 코드와 자연스럽게 통합된다. JPA, JDBC를 그대로 쓸 수 있고, Reactor보다 학습 곡선이 완만하다. 다만 JPA Lazy Loading과 충돌할 수 있다는 점은 인지하고 있었다(이 문제는 별도 글에서 다룬다).

---

## Coroutine 적용

Coroutine을 사용하면 Thread를 즉시 반환할 수 있다.

![](/uploads/프로젝트/Joying/inbound-thread-optimization/coroutine-applied.svg)


**Thread 점유 시간 비교**

**Before (Blocking)**
- Inbound Thread 점유 시간: 150ms (I/O 완료까지 대기)

**After (Coroutine)**
- Inbound Thread 점유 시간: <1ms (즉시 반환)
- I/O 작업은 Dispatchers.IO 스레드 풀에서 별도 처리

---

## Java CompletableFuture로도 동일하게 가능하다

사실 Java CompletableFuture로도 **같은 효과**를 낼 수 있다.

### Java 버전

![](/uploads/프로젝트/Joying/inbound-thread-optimization/java-version.svg)


### Kotlin Coroutine 버전

![](/uploads/프로젝트/Joying/inbound-thread-optimization/kotlin-coroutine-2.svg)


**둘 다 동일한 효과다.** Inbound Thread를 빨리 반환하고, I/O 작업은 별도 스레드 풀에서 처리한다.

---

## 왜 Coroutine을 선택했나

Java CompletableFuture로도 가능한데 Coroutine을 선택한 이유:

1. **채팅 파트는 내가 맡은 영역** - 기술 선택의 자유가 있었다
2. **프로젝트가 이미 Kotlin 기반** - 별도 설정 없이 바로 적용 가능했다
3. **코드 가독성** - `launch { }` 블록이 CompletableFuture 체이닝보다 직관적

---

## 주의: 진짜 Non-blocking은 아니다

**현재 구현**
- Inbound Thread: 즉시 반환
- Dispatchers.IO Thread: 150ms 동안 blocking

**진짜 Non-blocking이 되려면**
- Reactive MongoDB Driver 필요
- suspend 함수 + awaitSingle() 조합


현재 구현은 **Inbound Thread Pool의 처리량을 높이는 것**이 목적이다. 전체 시스템이 Non-blocking이 된 건 아니다.

---

## 실제 구현

### ChatMessageService

![](/uploads/프로젝트/Joying/inbound-thread-optimization/chat-message-mongodb.svg)


### WebSocket Controller

![](/uploads/프로젝트/Joying/inbound-thread-optimization/websocket-controller.svg)


---

## 결과

| 지표 | Before | After |
|------|--------|-------|
| Inbound Thread 점유 시간 | 150ms | <1ms |
| Inbound Thread 활용도 | I/O 대기로 99% 유휴 | 즉시 반환 후 다음 요청 처리 |

※ I/O Thread는 여전히 150ms 동안 blocking됨. Inbound Thread Pool을 더 효율적으로 활용할 수 있게 된 것이 핵심.

<!-- EN -->

## Background: Spring WebSocket STOMP Architecture

Typical WebSocket libraries (Netty, Ktor, etc.) use an EventLoop model that doesn't require Thread Pool configuration. However, Spring WebSocket STOMP uses separate Thread Pools for Inbound/Outbound Channels.

**Spring WebSocket STOMP Structure**
- Inbound Thread Pool: Handles client → server messages
- Outbound Thread Pool: Handles server → client messages

This post covers how to efficiently utilize Thread Pools when using Spring WebSocket STOMP.

---

## Problem: Threads Stall During I/O Waits

Spring WebSocket STOMP Handlers operate synchronously by default.

![](/uploads/프로젝트/Joying/inbound-thread-optimization/problem.svg)

Analyzing a single Inbound Thread's time breakdown:

- MongoDB save wait: 100ms (no work done)
- Redis publish wait: 10ms (no work done)
- Actual CPU time: <1ms

> The thread spends 99% of its time just waiting.

---

## The Nature of Blocking I/O

Looking at the MongoDB save process in detail:

**MongoDB Save (100ms)**
1. Network packet send (1ms) - CPU active
2. MongoDB server response wait (98ms) - CPU idle
3. Network response receive (1ms) - CPU active

> 98ms out of 100ms, the CPU is idle.

From the OS perspective:

![](/uploads/프로젝트/Joying/inbound-thread-optimization/blocking-io.png)

Thread 1 does nothing for 98ms but still **occupies a slot in the Thread Pool**. Other messages must wait until Thread 1 returns.

---

## Evaluating Async Processing Options

Four approaches were evaluated to solve the blocking I/O problem.

### 1. Spring @Async

![](/uploads/프로젝트/Joying/inbound-thread-optimization/spring-async.svg)

Delegates work to a separate Thread Pool. However, threads are still blocked during I/O waits. It just increases the number of threads without fundamentally solving the problem.

### 2. Project Reactor (Reactive Programming)

![](/uploads/프로젝트/Joying/inbound-thread-optimization/project-reactor.svg)

Achieves true Non-blocking, but requires rewriting all JPA/JDBC code to Reactive. Too risky for a 6-week project.

### 3. Virtual Threads (Java 21)

![](/uploads/프로젝트/Joying/inbound-thread-optimization/virtual-threads.svg)

Lightweight JVM-managed threads that can scale to millions. The cleanest solution, but our project was on Java 17. Upgrading to Java 21 risked Spring Boot version changes and dependency conflicts.

### 4. Kotlin Coroutine (Chosen)

![](/uploads/프로젝트/Joying/inbound-thread-optimization/kotlin-coroutine.svg)

Since our project was already Kotlin-based, adding `suspend` integrates naturally with existing code. JPA and JDBC can be used as-is, and the learning curve is gentler than Reactor. The potential conflict with JPA Lazy Loading was noted (covered in a separate post).

---

## Applying Coroutines

With Coroutines, threads can be returned immediately.

![](/uploads/프로젝트/Joying/inbound-thread-optimization/coroutine-applied.svg)

**Thread Occupancy Comparison**

**Before (Blocking)**
- Inbound Thread occupancy: 150ms (waits until I/O completes)

**After (Coroutine)**
- Inbound Thread occupancy: <1ms (returned immediately)
- I/O work handled separately in Dispatchers.IO thread pool

---

## Java CompletableFuture Achieves the Same Effect

Java CompletableFuture can produce the **same result**.

### Java Version

![](/uploads/프로젝트/Joying/inbound-thread-optimization/java-version.svg)

### Kotlin Coroutine Version

![](/uploads/프로젝트/Joying/inbound-thread-optimization/kotlin-coroutine-2.svg)

**Both achieve the same effect.** The Inbound Thread is returned quickly, and I/O work is processed in a separate thread pool.

---

## Why Coroutine Was Chosen

Reasons for choosing Coroutine over Java CompletableFuture:

1. **I owned the chat module** - Freedom in technology choices
2. **Project was already Kotlin-based** - No additional setup required
3. **Code readability** - `launch { }` blocks are more intuitive than CompletableFuture chaining

---

## Caveat: This Is Not True Non-blocking

**Current Implementation**
- Inbound Thread: Returned immediately
- Dispatchers.IO Thread: Blocked for 150ms

**For True Non-blocking**
- Reactive MongoDB Driver required
- suspend functions + awaitSingle() combination

The current implementation aims to **increase Inbound Thread Pool throughput**. The entire system has not become Non-blocking.

---

## Actual Implementation

### ChatMessageService

![](/uploads/프로젝트/Joying/inbound-thread-optimization/chat-message-mongodb.svg)

### WebSocket Controller

![](/uploads/프로젝트/Joying/inbound-thread-optimization/websocket-controller.svg)

---

## Results

| Metric | Before | After |
|--------|--------|-------|
| Inbound Thread occupancy | 150ms | <1ms |
| Inbound Thread utilization | 99% idle on I/O waits | Immediately returned for next request |

Note: I/O Threads are still blocked for 150ms. The key improvement is more efficient utilization of the Inbound Thread Pool.

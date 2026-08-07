---
title: 'Coroutine에서 JPA가 401을 뱉었다'
description: Spring MVC에서 Coroutine의 withContext로 스레드가 전환되면서 Hibernate Session과 SecurityContext가 유실되는 문제를 분석하고, runBlocking + Fetch Join으로 해결한 과정을 정리한다.
date: 2025-12-06T00:00:00.000Z
tags:
  - Kotlin
  - Coroutine
  - JPA
  - Hibernate
  - Spring MVC
  - Fetch Join
category: team/Joying
draft: false
coverImage: "/uploads/project/Joying/coroutine-jpa-401/async-parallel-query.svg"
series: "Joying"
---

WebSocket Handler에 Coroutine을 적용하고 나서, Redis 캐시 미스 시 MongoDB 병렬 조회에도 `async`를 활용했습니다. 잘 되는 줄 알았는데, 이 `suspend fun`을 REST API에서 호출하는 순간 예상치 못한 에러가 터졌습니다.

---

## 배경: 왜 Spring MVC에서 Coroutine을 썼나?

채팅방 목록을 조회할 때 각 채팅방의 **안읽은 메시지 개수**를 Redis에서 가져옵니다. 캐시 미스가 발생하면 MongoDB에서 계산해야 하는데, 채팅방이 10개고 캐시 미스가 5개면 MongoDB 조회를 5번 해야 합니다.

![](/uploads/project/Joying/coroutine-jpa-401/async-parallel-query.svg)


Coroutine의 `async`를 쓰면 5개의 MongoDB 조회를 병렬로 처리할 수 있습니다. 순차로 5번 기다리던 네트워크 왕복이, 가장 오래 걸리는 1번의 왕복 시간으로 줄어듭니다.

문제는 이 `suspend fun`을 호출하려면 코루틴 컨텍스트가 필요하다는 점입니다. 그래서 REST API에서도 코루틴을 도입했는데, 여기서 문제가 시작됐습니다.

---

## 문제 상황

채팅방 생성 API: 정상 동작
채팅방 목록 조회 API: 401 에러


같은 토큰으로 채팅방 생성은 되는데 목록 조회만 안 됐습니다.

---

## 원인 분석

로그를 자세히 보니 실제로는 401이 아니라 `LazyInitializationException`이었습니다. Spring Security 필터 체인에서 인증 처리 중 예외가 발생하면, `ExceptionTranslationFilter`가 이를 `AuthenticationException`으로 간주하고 401을 반환한다. 즉, `LazyInitializationException` → Security 필터에서 catch → 인증 실패로 처리 → 401 응답이 된 거였습니다.

org.hibernate.LazyInitializationException:
could not initialize proxy - no Session


코드를 확인해봤습니다.

![](/uploads/project/Joying/coroutine-jpa-401/lazy-init-exception-code.svg)


---

## Coroutine과 Hibernate Session

Kotlin Coroutine의 `withContext(Dispatchers.IO)`는 스레드를 전환합니다. Hibernate Session은 스레드 로컬에 바인딩되어 있어서, `withContext` 블록을 벗어나면 Session이 종료됩니다.

![](/uploads/project/Joying/coroutine-jpa-401/coroutine-hibernate-session.png)


### 왜 채팅방 생성은 됐을까?

두 API의 차이를 보니 명확했습니다.

![](/uploads/project/Joying/coroutine-jpa-401/create-vs-list-api.svg)


Spring의 `@Transactional`은 Thread-Local 기반이라 Coroutine에서 스레드가 바뀌면 제대로 작동하지 않습니다.

---

## 해결 방법 검토

네 가지 방법을 검토했습니다.

### 1. Eager Loading

![](/uploads/project/Joying/coroutine-jpa-401/eager-loading.svg)

안 쓰는 데이터도 매번 로딩해야 해서 비효율적입니다.

### 2. Batch Query

![](/uploads/project/Joying/coroutine-jpa-401/batch-query.svg)

동작은 하지만 코드가 복잡해집니다.

### 3. Fetch Join

![](/uploads/project/Joying/coroutine-jpa-401/fetch-join.svg)

1개 쿼리로 모든 데이터를 조회합니다. N+1 문제도 함께 해결됩니다.

### 4. runBlocking으로 스레드 전환 방지

![](/uploads/project/Joying/coroutine-jpa-401/run-blocking.svg)

`runBlocking`으로 감싸면 스레드 전환이 발생하지 않아서 Hibernate Session과 SecurityContext가 유지됩니다.

---

## 최종 선택: runBlocking + Fetch Join

runBlocking과 Fetch Join을 함께 적용했습니다.

1. **runBlocking**: 스레드 전환 없이 Session/SecurityContext 유지
2. **Fetch Join**: 혹시 모를 Lazy Loading 문제 방지 (이중 안전장치)

**"runBlocking이면 Coroutine 쓰는 의미가 없는 거 아니야?"**

맞는 지적이다. REST API 경로에서는 `runBlocking`으로 동기 실행하므로 Coroutine의 비동기 이점이 없다. 하지만 Coroutine을 도입한 이유는 REST API가 아니라 **WebSocket Handler에서 MongoDB 병렬 조회**를 위해서였다([Inbound Thread 최적화](/blog/project/joying/inbound-thread-optimization) 참고). REST API에서 같은 `suspend fun`을 호출할 때만 `runBlocking`으로 감싸는 것이고, WebSocket 경로에서는 Coroutine의 `async` 병렬 처리가 그대로 동작한다.

**Virtual Thread(Java 21)가 더 깔끔한 해결책**이라는 것도 인지하고 있었다. Virtual Thread는 ThreadLocal 기반 코드(Hibernate, Security)와 호환되면서 경량 스레드의 이점을 얻을 수 있다. 하지만 프로젝트가 Java 17 기반이었고, 6주 프로젝트에서 Java 21 업그레이드 + Spring Boot 버전 변경은 리스크가 컸다.

우리 경우는 `ChatRoom → Product`, `ChatRoom → Buyer`, `ChatRoom → Seller`가 모두 N:1 관계입니다. N:1 관계에서는 Fetch Join이 가장 효율적입니다.

![](/uploads/project/Joying/coroutine-jpa-401/fetch-join-final.svg)


한 번의 쿼리로 채팅방, 상품, 구매자, 판매자 정보를 모두 가져옵니다.

---

## 1:N 관계는 왜 Batch Query를 유지했나

`ProductFile`은 1개 상품에 여러 이미지가 있는 1:N 관계입니다. Fetch Join을 쓰면 카테시안 곱이 발생합니다.

![](/uploads/project/Joying/coroutine-jpa-401/cartesian-product-1n.svg)


그래서 `ProductFile`은 Batch Query를 유지했습니다.

---

## 최종 구현
![](/uploads/project/Joying/coroutine-jpa-401/final-implementation.svg)

---

## 쿼리 수 비교


**Before (Lazy Loading)**
1. SELECT chat_room (50ms)
2. SELECT product WHERE id = 1 (5ms)
3. SELECT product WHERE id = 2 (5ms)
...
11. SELECT product WHERE id = 10 (5ms)
12. SELECT member WHERE id = ... (여러 번)
총: 20-30개 쿼리, 200ms+

**After (Fetch Join + Batch Query)**
1. SELECT chat_room + product + member (Fetch Join, 50-80ms)
2. SELECT product_file WHERE product_id IN (...) (Batch, 10ms)
3. Redis MGET (안읽은 개수, 5ms)
총: 3개 쿼리, 65-95ms


---

## 결과

| 지표 | Before | After |
|------|--------|-------|
| 쿼리 수 | 20-30개 | 3개 |
| 응답 시간 | 200ms+ | 65-95ms |
| 에러 | LazyInitializationException | 없음 |

---

## 정리

Spring MVC에서 Coroutine을 사용할 때는 Hibernate Session과 SecurityContext의 생명주기를 신경 써야 합니다.


withContext로 스레드 전환 → Session/SecurityContext 유실 → 예외 발생


**해결 방법**
- **runBlocking 사용**: `withContext` 없이 직접 호출하면 스레드 전환 없음
- **Fetch Join**: N:1 관계는 한 번에 조회 (이중 안전장치)
- **Batch Query**: 1:N 관계는 IN 절로 분리 조회


스프링 MVC에 코루틴을 도입해보면서 배운 점이 있습니다.

1. **Spring MVC + Coroutines 조합은 Thread-Local 기반 인프라(Hibernate, Security)와 충돌합니다.** 이 조합을 쓰려면 스레드 전환을 세밀하게 통제해야 합니다.
2. **같은 목적이라면 Virtual Thread가 더 자연스럽습니다.** Virtual Thread는 기존 Thread-Local 기반 코드와 호환되면서 경량 스레드의 이점을 얻을 수 있습니다.

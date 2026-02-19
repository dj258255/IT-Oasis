---
title: 'Spring Security 다중 FilterChain으로 경로별 인증 분리'
titleEn: 'Separating Authentication per Route with Multiple Spring Security FilterChains'
description: Webhook, API, Actuator가 각각 다른 인증 방식을 요구해서 3개의 SecurityFilterChain을 @Order로 분리하고, 경로별 독립적인 보안 정책을 적용한 과정을 정리한다.
descriptionEn: Documents separating three SecurityFilterChains by @Order for Webhook (permitAll), Actuator (Basic Auth), and API (JWT Bearer Token) routes.
date: 2025-09-09T00:00:00.000Z
tags:
  - Spring Security
  - FilterChain
  - JWT
  - OAuth2
  - Authentication
category: project/Orakgarak
draft: false
coverImage: "/uploads/project/Orakgarak/spring-security-multi-filterchain/filterchain-flow.svg"
---

## 한 줄 요약

Webhook, API, Actuator가 각각 다른 인증 방식을 필요로 해서 3개의 SecurityFilterChain을 @Order로 분리하고, OAuth2 + JWT + Refresh Token Rotation을 적용했어요.

---

## 문제 상황

오락가락 서비스의 보안 요구사항은 경로마다 달랐어요.

`/api/webhook/**`은 EventBridge에서 호출하는 내부 엔드포인트예요.
인증 없이 접근 가능해야 해요.
`/api/**`는 사용자 API인데, JWT Bearer Token으로 인증이 필수고요.
`/actuator/**`는 Prometheus가 메트릭을 수집하는 모니터링용 엔드포인트인데, 외부에 노출되면 안 되니 Basic Auth로 보호해야 했어요.

하나의 SecurityFilterChain에 이 세 가지를 넣으려고 하면 충돌해요.
Webhook은 `permitAll()`이어야 하고 API는 `authenticated()`여야 하는데, `/api/webhook/**`이 `/api/**`에 포함되기 때문이에요.
`antMatchers` 순서로 처리하는 방법도 있지만, 인증 방식 자체가 다른 경우(JWT vs Basic Auth)는 Filter 구성이 달라야 해서 하나의 Chain으로는 한계가 있었어요.

---

## 3개의 FilterChain 분리

@Order 어노테이션과 securityMatcher로 경로별 독립적인 FilterChain을 구성했어요.

| 순서 | 경로 | 인증 방식 | 이유 |
|------|------|----------|------|
| @Order(1) | `/api/webhook/**` | 없음 (permitAll) | EventBridge 내부 통신 |
| @Order(2) | `/actuator/**` | Basic Auth | Prometheus 메트릭 수집 |
| @Order(3) | `/api/**` | JWT Bearer Token | 사용자 API |

![](/uploads/project/Orakgarak/spring-security-multi-filterchain/filterchain-flow.svg)

요청이 들어오면 Order가 낮은 Chain부터 securityMatcher를 확인해요.
매칭되면 해당 Chain에서 처리하고, 아니면 다음 Chain으로 넘어가요.
Webhook 경로가 먼저 매칭되니, API Chain의 JWT 필터를 타지 않아요.

---

## Webhook에 인증이 없어도 되는 이유

보안이 없는 엔드포인트가 있다는 게 불안할 수 있어요.
하지만 이 경로는 여러 계층에서 이미 보호되고 있어요.

1. EventBridge Rule이 특정 S3 버킷의 ObjectCreated 이벤트만 트리거해요.
2. EC2가 VPC 내에 있고, Security Group으로 접근을 제한해요.
3. 경로가 `/api/webhook/**`으로 한정되어 있어 다른 API에 영향이 없어요.
4. 핸들러에서 S3 ObjectCreated 이벤트 구조를 검증하고요.
형식이 맞지 않으면 무시해요.

AWS 인프라 레벨의 보안이 앞단에서 걸러주는 구조거든요.
애플리케이션 레벨에서 중복으로 인증을 거는 건 불필요한 복잡도를 더할 뿐이었어요.

---

## 구현 상세

![](/uploads/project/Orakgarak/spring-security-multi-filterchain/security-config.svg)

---

## 참고 자료

- [Spring Security Multiple HttpSecurity](https://docs.spring.io/spring-security/reference/servlet/configuration/java.html#_multiple_httpsecurity)
- [Spring Security Architecture](https://docs.spring.io/spring-security/reference/servlet/architecture.html)

<!-- EN -->

## Summary

Webhook, API, and Actuator endpoints each required different authentication methods, so three SecurityFilterChains were separated using @Order with OAuth2 + JWT + Refresh Token Rotation.

---

## Problem

Security requirements differed by route in the Orak service.

`/api/webhook/**` is an internal endpoint called by EventBridge, requiring no authentication. `/api/**` is the user API requiring JWT Bearer Token authentication. `/actuator/**` is the monitoring endpoint for Prometheus metric collection, protected with Basic Auth.

Putting all three in a single SecurityFilterChain causes conflicts. Webhook needs `permitAll()` while API needs `authenticated()`, but `/api/webhook/**` is a subset of `/api/**`. Even with `antMatchers` ordering, different authentication mechanisms (JWT vs Basic Auth) require different Filter configurations that a single Chain cannot accommodate.

---

## Three FilterChains

Independent FilterChains were configured per route using @Order and securityMatcher.

| Order | Path | Auth Method | Reason |
|-------|------|-------------|--------|
| @Order(1) | `/api/webhook/**` | None (permitAll) | EventBridge internal communication |
| @Order(2) | `/actuator/**` | Basic Auth | Prometheus metric collection |
| @Order(3) | `/api/**` | JWT Bearer Token | User API |

![](/uploads/project/Orakgarak/spring-security-multi-filterchain/filterchain-flow.svg)

Incoming requests are matched against Chains in Order sequence. The first matching Chain handles the request. Since Webhook matches first, it bypasses the API Chain's JWT filter entirely.

---

## Why Webhook Needs No Authentication

An unauthenticated endpoint might seem concerning, but this route is already protected at multiple layers:

1. EventBridge Rule only triggers on specific S3 bucket ObjectCreated events.
2. EC2 is within a VPC with Security Group access restrictions.
3. The path is limited to `/api/webhook/**` with no impact on other APIs.
4. The handler validates S3 ObjectCreated event structure, ignoring malformed requests.

AWS infrastructure-level security filters requests upstream. Adding application-level authentication would only add unnecessary complexity.

---

## Implementation Details

![](/uploads/project/Orakgarak/spring-security-multi-filterchain/security-config.svg)

---

## References

- [Spring Security Multiple HttpSecurity](https://docs.spring.io/spring-security/reference/servlet/configuration/java.html#_multiple_httpsecurity)
- [Spring Security Architecture](https://docs.spring.io/spring-security/reference/servlet/architecture.html)

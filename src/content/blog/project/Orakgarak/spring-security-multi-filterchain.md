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

처음에는 단일 FilterChain에서 `requestMatchers` 순서로 해결하려 했어요.
`/api/webhook/**`을 먼저 `permitAll()`로 설정하고 `/api/**`를 `authenticated()`로 설정하면 경로 우선순위로 동작할 수 있지만, 실제로 Actuator의 Basic Auth(`httpBasic()`)와 API의 JWT Bearer Token은 **Filter 자체가 달라야** 해요.
`httpBasic()`이 활성화된 Chain에서 JWT 요청이 들어오면 Basic Auth 실패로 401이 반환되는 문제가 발생했어요.

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
2. EC2의 Security Group으로 인바운드 접근을 제한해요. (단, EventBridge API Destination은 퍼블릭 인터넷을 경유하므로 VPC 내부 격리가 아닌 Security Group + HTTPS가 보호 계층이에요.)
3. 경로가 `/api/webhook/**`으로 한정되어 있어 다른 API에 영향이 없어요.
4. 핸들러에서 S3 ObjectCreated 이벤트 구조를 검증하고요.
형식이 맞지 않으면 무시해요.

AWS 인프라 레벨의 보안이 앞단에서 걸러주는 구조거든요.

**HMAC 서명 검증은 왜 안 했는가**: EventBridge → HTTP 엔드포인트 호출에서 HMAC 서명을 직접 추가하려면 Lambda를 중간에 끼워야 해요. EventBridge 자체는 HTTP 헤더에 서명을 넣는 기능이 없거든요. AWS API Destination + Connection으로 OAuth/API Key 인증은 가능하지만, Security Group + HTTPS로 접근이 제한된 상태에서 Lambda를 추가하는 건 5주 프로젝트 기준 과잉이라 판단했어요. (EventBridge API Destination은 퍼블릭 인터넷을 경유하므로 VPC 격리가 아닌 Security Group이 보호 계층이에요.)

프로덕션이라면 EventBridge → API Destination에 `Authorization` 헤더를 설정하거나, Webhook 핸들러에서 EventBridge 이벤트의 `source`, `detail-type` 필드를 검증하는 방식이 더 적합해요.

---

## 구현 상세

![](/uploads/project/Orakgarak/spring-security-multi-filterchain/security-config.svg)

---

## 결과

| 경로 | 변경 전 (단일 FilterChain) | 변경 후 (3개 FilterChain) |
|------|------------------------|------------------------|
| `/api/webhook/**` | JWT 필터에 걸려 EventBridge 호출 실패 (401) | `permitAll()` — 정상 처리 |
| `/actuator/**` | JWT 인증 요구 → Prometheus 수집 실패 | Basic Auth — Prometheus 정상 수집 |
| `/api/**` | JWT 인증 정상 (단, httpBasic 충돌 시 401) | JWT Bearer Token 전용 — 충돌 없음 |

각 Chain이 독립된 Filter 구성을 갖기 때문에, 한 경로의 인증 방식이 다른 경로에 영향을 주지 않아요.
새로운 인증 방식이 필요한 경로가 추가돼도 기존 Chain을 수정하지 않고 새 Chain만 추가하면 돼요.

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

Putting all three in a single SecurityFilterChain causes conflicts. Webhook needs `permitAll()` while API needs `authenticated()`, but `/api/webhook/**` is a subset of `/api/**`. Initially tried resolving with `requestMatchers` ordering in a single chain, but Actuator's `httpBasic()` and API's JWT Bearer Token require fundamentally different Filter configurations. With `httpBasic()` enabled, JWT requests received 401 from Basic Auth failure.

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
2. EC2's Security Group restricts inbound access. (Note: EventBridge API Destinations route through the public internet, so the protection layer is Security Group + HTTPS, not VPC-internal isolation.)
3. The path is limited to `/api/webhook/**` with no impact on other APIs.
4. The handler validates S3 ObjectCreated event structure, ignoring malformed requests.

AWS infrastructure-level security filters requests upstream.

**Why no HMAC signature verification**: Adding HMAC signatures to EventBridge → HTTP calls would require a Lambda intermediary, as EventBridge doesn't natively add signatures to HTTP headers. AWS API Destination + Connection supports OAuth/API Key auth, but with Security Group + HTTPS already restricting access (EventBridge API Destinations route through the public internet, not VPC-internal), adding Lambda was excessive for a 5-week project. In production, configuring an `Authorization` header via API Destination or validating EventBridge event `source` and `detail-type` fields would be more appropriate.

---

## Implementation Details

![](/uploads/project/Orakgarak/spring-security-multi-filterchain/security-config.svg)

---

## Results

| Path | Before (Single FilterChain) | After (3 FilterChains) |
|------|---------------------------|----------------------|
| `/api/webhook/**` | JWT filter blocked EventBridge calls (401) | `permitAll()` — works correctly |
| `/actuator/**` | JWT auth required → Prometheus scraping failed | Basic Auth — Prometheus scrapes normally |
| `/api/**` | JWT auth works (but 401 on httpBasic conflict) | JWT Bearer Token only — no conflicts |

Each chain has independent filter configuration, so one path's auth method doesn't affect others. Adding new auth methods only requires a new chain without modifying existing ones.

---

## References

- [Spring Security Multiple HttpSecurity](https://docs.spring.io/spring-security/reference/servlet/configuration/java.html#_multiple_httpsecurity)
- [Spring Security Architecture](https://docs.spring.io/spring-security/reference/servlet/architecture.html)

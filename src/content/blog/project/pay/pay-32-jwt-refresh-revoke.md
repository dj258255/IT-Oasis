---
title: '무상태 토큰을 어떻게 폐기하나 — JWT 갱신·폐기와 Redis denylist'
titleEn: 'How Do You Revoke a Stateless Token? — JWT Refresh/Revocation with a Redis Denylist'
description: 결제 시스템 개선기. JWT를 발급만 해뒀는데, 실서비스라면 만료 전 세션 연장(refresh)과 로그아웃·탈취 시 즉시 폐기가 필요하다. 그런데 무상태 JWT는 서버가 상태를 안 들고 있어 폐기가 어렵다. 짧은 access + 회전하는 refresh, 그리고 Redis denylist로 폐기를 구현한 이야기. 덤으로, 선언만 해두고 안 쓰던 Redis가 드디어 실제로 쓰인다.
descriptionEn: "Payment system improvement log. I had JWT issuance only, but a real service needs session extension (refresh) before expiry and immediate revocation on logout or theft. Stateless JWT is hard to revoke since the server holds no state. A story of short access tokens, rotating refresh tokens, and a Redis denylist for revocation — and as a bonus, Redis finally gets used for real."
date: 2026-10-31T00:00:00.000Z
tags:
  - Payment
  - JWT
  - Security
  - Redis
  - Authentication
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 32
---

*결제 시스템 시리즈. 개선기 — 발급만 하던 토큰에 갱신·폐기를 채우기.*

## 0. 발급은 했는데, 그 다음은?

[JWT로 BCrypt 병목을 없앨 때](/blog/project/pay/pay-20-jwt-removes-bottleneck), 사실 절반만 만들었어요. 로그인하면 토큰을 **발급**하는 것까지요. 그때 글 말미에 이렇게 적었어요.

> JWT 검증도 공짜는 아니고, 실서비스라면 토큰 만료·갱신(refresh)·폐기(블랙리스트)까지 설계해야 해요.

이번 편이 그 "그 다음"이에요. 실서비스 토큰엔 두 가지가 더 필요해요.

- **갱신(refresh)**: access 토큰이 30분 뒤 만료되는데, 사용자가 매번 재로그인(BCrypt)하게 할 순 없어요. 만료 전에 조용히 연장해야죠.
- **폐기(revocation)**: 로그아웃하거나 토큰이 탈취되면, 그 토큰을 **즉시 무효화**해야 해요.

그런데 폐기가 진짜 문제였어요.

## 1. 무상태의 역설 — 폐기가 어렵다

JWT의 장점은 **무상태**예요. 서버가 세션을 안 들고 있어도, 토큰의 서명만 검증하면 되니까요([그래서 BCrypt 병목이 사라졌죠](/blog/project/pay/pay-20-jwt-removes-bottleneck)).

그런데 이 장점이 폐기에선 정확히 **단점**이 돼요.

> 서버가 아무 상태도 안 들고 있으니, 한 번 발급한 토큰을 **"이건 이제 무효야"라고 표시할 곳이 없어요.** 토큰은 만료 시각까지 유효한 서명을 갖고 있고, 서버는 그걸 막을 방법이 없죠. 로그아웃을 눌러도 토큰 자체는 여전히 살아있어요.

이게 무상태 토큰의 역설이에요 — 상태를 안 들어서 빠른데, 바로 그것 때문에 폐기를 못 해요.

해법은 결국 **"폐기된 토큰만" 상태로 들고 있는 것**이에요. 전체를 상태로 관리하면 무상태의 이점이 사라지지만, **폐기 목록(denylist)**만 관리하면 대부분의 토큰은 여전히 무상태로 빠르게 검증되고, 폐기된 소수만 별도로 걸러내요.

그리고 그 denylist를 어디에 둘까 — **Redis**였어요. 마침 이 프로젝트는 Redis를 의존성에 넣어두고 [정작 런타임엔 안 쓰고 있었어요](/blog/project/pay/pay-26-persistence-bug)(멱등은 DB로 했으니까). 이번에 Redis가 드디어 제 일을 하게 됐죠.

## 2. 짧은 access + 회전하는 refresh

먼저 토큰을 둘로 나눴어요.

- **access 토큰**: 짧게(30분). JWT라 서명만 검증 — 빠름. `jti`(토큰 고유 id)를 심어요.
- **refresh 토큰**: 길게(14일). **불투명(opaque) 문자열**(UUID)로, Redis에만 존재해요. JWT가 아니라서 Redis 조회로만 검증돼요.

로그인하면 이 둘을 함께 줘요. access가 만료되면, refresh로 새 access를 받아요.

```
POST /auth/refresh {refreshToken}
→ Redis에서 refresh 조회 → 있으면 새 access + 새 refresh 발급
```

여기서 중요한 게 **회전(rotation)**이에요.

> refresh로 갱신할 때마다, **옛 refresh를 즉시 폐기하고 새 refresh를 발급**해요. 그래서 한 번 쓴 refresh는 다시 못 써요. 만약 refresh가 탈취돼서 공격자가 먼저 갱신하면, 정상 사용자의 다음 갱신이 실패해요 — 그때 "누군가 내 토큰을 썼다"를 감지할 수 있죠. 회전이 없으면 탈취된 refresh를 14일 내내 재사용당해요.

실기동으로 확인했어요.

```
로그인          → access + refresh
refresh로 갱신  → 200, 새 access + 새 refresh
옛 refresh 재사용 → 401   ← 회전으로 무효화됨
```

## 3. 폐기 — Redis denylist를 요청마다 검사

로그아웃(또는 탈취 대응)은 access 토큰을 **즉시** 무효화해야 해요.

```
POST /auth/logout
→ access의 jti를 Redis에 revoked:{jti} 로 등록 (TTL = 토큰 만료까지 남은 시간)
→ 해당 refresh 토큰도 Redis에서 삭제
```

그리고 **요청마다** 이 denylist를 검사해요. JWT 디코더에 검증기를 하나 더 붙였어요.

```java
// 기본 검증(서명·만료) + 폐기 검증
new DelegatingOAuth2TokenValidator<>(JwtValidators.createDefault(), revocationValidator);
```

`revocationValidator`는 토큰의 `jti`가 `revoked:{jti}`에 있으면 거부해요. TTL을 "만료까지 남은 시간"으로 잡은 게 포인트예요 — 어차피 그 시각이 지나면 토큰은 자연 만료되니, denylist에 영원히 둘 필요 없이 **자동으로 청소**돼요.

```
로그아웃          → 200
폐기된 access로 요청 → 401   ← denylist에 걸림
```

## 4. Redis가 죽으면? — fail-open

여기엔 가용성 트레이드오프가 있어요. 이제 **모든 인증 요청이 Redis를 한 번 조회**해요(denylist 검사). 그럼 Redis가 죽으면 인증 전체가 마비될까요?

그렇게 두면 안 돼요. 그래서 **fail-open**으로 했어요.

> denylist 검사에서 Redis 예외가 나면, **통과시키고 경고 로그만 남겨요.** 즉 Redis 장애 시엔 "폐기 검사를 못 하니 일단 유효한 것으로 본다"예요. 폐기의 즉시성을 잃는 대신 **인증 가용성을 지키는** 선택이죠.

이건 정답이 있는 문제는 아니에요. 보안이 극도로 중요하면 fail-closed(Redis 죽으면 전부 거부)가 맞을 수도 있어요. 하지만 결제 서비스에서 "Redis 잠깐 죽었다고 모든 사용자가 로그아웃되는" 건 더 큰 사고라, 가용성을 택했어요. 무엇을 우선할지 **명시적으로 결정하고 주석에 남기는 게** 이런 트레이드오프에선 제일 중요해요.

## 마치며

이번 건 [JWT 편](/blog/project/pay/pay-20-jwt-removes-bottleneck)의 미완성 절반을 채운 거예요. 무상태 토큰의 "폐기가 어렵다"는 역설을, **denylist만 상태로 관리**해서 풀었어요 — 대부분은 무상태로 빠르게, 폐기된 소수만 Redis로 걸러내는.

그리고 계속 미뤄뒀던 숙제도 하나 풀렸어요. 의존성에만 있고 안 쓰이던 Redis가, 토큰 저장소 겸 denylist로 **드디어 실제 역할**을 맡았거든요. 만들다 보면 이렇게 "언젠가 쓰겠지" 했던 게 제 자리를 찾는 순간이 있더라고요.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, 갱신 회전·로그아웃 폐기를 실 Redis로 검증했습니다.*

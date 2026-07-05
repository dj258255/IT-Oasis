---
title: '병목을 지목했으면 제거해야지 — JWT로 요청당 BCrypt를 걷어낸 전후 수치'
titleEn: "You Named the Bottleneck, Now Remove It — Before/After of Cutting Per-Request BCrypt with JWT"
description: 결제 시스템 개선기. 지난 부하테스트가 "요청당 BCrypt가 병목"이라고 정확히 짚어줬다. 이번엔 그걸 실제로 제거했다 — HTTP Basic을 JWT로 바꿔 로그인 때만 BCrypt를 돌리고, 이후 요청은 서명 검증만 하게. 그리고 같은 머신·같은 부하에서 인증 방식 하나만 바꿔 재측정했다. min 110ms→4.17ms, p95 568ms→37ms. 병목 지목에서 제거까지 한 사이클을 닫은 이야기.
descriptionEn: "Payment system improvement log. The last load test pinpointed per-request BCrypt as the bottleneck. This time I actually removed it — swapping HTTP Basic for JWT so BCrypt runs only at login and later requests just verify a signature. Then I re-measured on the same machine under the same load, changing only the auth method. min 110ms→4.17ms, p95 568ms→37ms. Closing the loop from naming a bottleneck to removing it."
date: 2026-08-08T00:00:00.000Z
tags:
  - Payment
  - JWT
  - Performance
  - Load Testing
  - k6
  - Authentication
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 20
---

*결제 시스템 시리즈. 개선기 — 지목한 병목을 실제로 제거하고 재측정.*

## 0. 지난 편의 숙제

[부하테스트 편](/blog/project/pay/pay-17-load-test-finds-bottleneck)에서 p95가 567ms까지 오른 걸 파고들었더니, 범인은 앱 로직이 아니라 **요청마다 도는 BCrypt**였어요.

> HTTP Basic 인증은 무상태예요. 세션이 없으니 요청마다 비밀번호를 다시 검증하고, 비밀번호는 BCrypt로 해싱돼 있는데 BCrypt는 의도적으로 느려요(브루트포스 방어). 측정에서 이게 딱 보였죠 — **최소 응답시간 110ms**. 이 바닥은 순수하게 BCrypt 비용이었어요.

그때 글은 "실서비스는 토큰/세션으로 이걸 없앤다"로 끝났어요. 이번 편은 그 문장을 **실제로 코드로** 옮긴 기록이에요. 병목을 지목만 하고 끝내면 반쪽이잖아요.

## 1. 왜 토큰이 BCrypt를 없애는가

핵심은 **비밀번호 검증을 언제 하느냐**예요.

- **HTTP Basic**: 매 요청에 `id:pw`가 실려 와요. 그러니 서버는 요청마다 저장된 해시와 BCrypt로 대조해요. 요청 100번이면 BCrypt 100번.
- **JWT**: 로그인 때 **딱 한 번** BCrypt로 검증하고, 성공하면 서명된 토큰을 발급해요. 이후 요청은 그 토큰의 **서명만 검증**해요. 서명 검증(HMAC-SHA256)은 BCrypt와 비교하면 거의 공짜예요 — 마이크로초 단위죠.

BCrypt가 느린 건 **버그가 아니라 기능**이에요. 느려야 무차별 대입 공격이 어려우니까요. 그러니 "BCrypt를 빠르게" 만들면 안 되고, **BCrypt를 돌리는 횟수를 줄여야** 해요. 로그인 1회로 몰아넣는 게 정답이에요.

## 2. 구현 — Spring Security OAuth2 Resource Server

Spring Security의 정석대로 갔어요. 자체 발급/검증이라 외부 IdP 없이 대칭키(HS256)로요.

- **로그인**(`POST /api/v1/auth/login`): `AuthenticationManager`로 자격증명을 검증(여기서 BCrypt 1회) → 성공하면 subject에 userId, `roles` 클레임에 권한을 담아 서명된 JWT를 발급.
- **검증**: `oauth2ResourceServer(jwt)`가 요청마다 토큰 서명만 확인. 세션은 `STATELESS`.

미묘하게 신경 쓴 두 가지가 있어요.

**(1) principal이 계속 userId를 가리켜야 한다.** 이 프로젝트는 [주문 소유권 검증](/blog/project/pay/pay-10-composite-payment)을 `principal.getName()`(=userId)으로 해요. 그래서 JWT의 `subject`에 userId를 넣어, 인증 방식을 바꿔도 `Long.parseLong(principal.getName())`이 그대로 동작하게 했어요. 소유권 검증 코드는 한 줄도 안 건드렸죠.

**(2) roles 클레임과 권한 접두사를 정확히 맞물리기.** 로그인 시 `getAuthorities()`가 이미 `ROLE_USER`를 주니 그대로 클레임에 넣고, 검증 측 컨버터는 접두사를 **빈 문자열**로 둬서 클레임 값이 그대로 authority가 되게 했어요. 이래야 `hasRole("USER")`가 정확히 맞아요. 여기 어긋나면 인증은 되는데 인가에서 403이 나요 — 흔한 삽질 포인트죠.

시크릿은 [하드코딩 키를 제거했던 것](/blog/project/pay/pay-15-field-encryption)과 같은 결로, HS256 최소 길이(32바이트) 미만이면 기동을 막았어요(fail-fast).

## 3. 통제된 재측정 — 변수는 인증 하나

이제 중요한 부분. **개선을 주장하려면 변수를 하나만 바꿔야** 해요.

그래서 지난 측정과 **똑같은 조건**으로 맞췄어요 — 같은 노트북, 비슷한 머신 부하(load avg ~6), 같은 50 VU, 같은 주문→승인 시나리오. 딱 하나, **인증 방식만** HTTP Basic→JWT로 바꿨어요. k6 스크립트도 `setup()`에서 한 번 로그인해 토큰을 받고, 이후엔 그 Bearer 토큰을 재사용하게 고쳤죠.

결과예요.

| 지표 | HTTP Basic + BCrypt | **JWT** | 개선 |
|---|---|---|---|
| min | 110ms *(BCrypt 바닥)* | **4.17ms** | ~26배 |
| p95 | 567.84ms | **37.09ms** | ~15배 |
| p99 | 712.27ms | **58.47ms** | ~12배 |
| 오류율 | 0% | 0% | — |

```
✓ 'p(95)<1500'  p(95)=37.09ms
✓ 'p(99)<3000'  p(99)=58.47ms
✓ 'rate<0.01'   rate=0.00%
  http_req_duration: min=4.17ms med=17.53ms max=145.11ms
  http_reqs: 4071 (50 req/s), 오류율 0%
```

**요청당 110ms의 BCrypt 바닥이 통째로 사라졌어요.** min이 110ms→4.17ms로 떨어진 게 그 증거예요 — 이 바닥이 순수 BCrypt 비용이었으니까요.

개선폭이 유독 큰 건, 한 번의 체크아웃이 **주문 + 승인으로 인증을 두 번** 타기 때문이에요. Basic이었을 땐 BCrypt를 두 번 돌렸는데, JWT는 그 둘 다 서명 검증으로 바뀌었죠.

## 4. 무엇을 배웠나

이번 건 새 기능이라기보단 **"측정 → 병목 지목 → 개선 → 재측정"의 한 사이클을 닫은** 거예요.

- 지난 편에서 "min 110ms가 이상하다 → BCrypt다"로 병목을 **지목**했고,
- 이번 편에서 그걸 **제거**하고 **같은 조건에서 재측정**해 효과를 수치로 확인했어요.

성능 개선에서 제일 흔한 함정이 "이것저것 바꾸고 빨라졌다"예요. 그럼 **뭐가 효과였는지** 몰라요. 변수를 인증 하나로 묶어두니, 37ms라는 결과가 온전히 JWT 덕이라고 말할 수 있어요. 카카오페이의 "2.5배 개선기"가 개선을 **하나씩** 넣고 전후를 재는 것도 같은 이유예요.

물론 이게 끝은 아니에요. JWT 검증도 공짜는 아니고(서명 계산·클레임 파싱), 실서비스라면 토큰 만료·갱신(refresh)·폐기(블랙리스트)까지 설계해야 해요. 하지만 "요청당 재해싱"이라는 가장 큰 덩어리는 걷어냈고, 그게 수치로 남았어요.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, 재측정은 실 MySQL·Redis 위에서 k6로 실행했습니다.*

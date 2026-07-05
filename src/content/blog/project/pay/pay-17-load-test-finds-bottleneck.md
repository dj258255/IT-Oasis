---
title: '전체를 실제로 돌려보니 — 부하테스트가 병목을 짚어줬다'
titleEn: "Running the Whole Thing for Real — The Load Test Pointed at the Bottleneck"
description: 결제 시스템 개선기. 확장 모듈을 여러 개 붙이고 나니 앱이 다시 안 떴다 — 새 엔티티들이 스키마에 없어서다. Hibernate로 DDL을 뽑아 Flyway 마이그레이션(V3)을 추가해 실제로 기동시키고, 인증이 걸린 상태로 k6를 돌렸다. 그런데 p95가 확 올라갔다. 원인은 앱 로직이 아니라 요청마다 도는 BCrypt 인증이었다 — 부하테스트가 정확히 "무엇이 느린지"를 짚어준 이야기.
descriptionEn: "Payment system improvement log. After adding several extension modules, the app stopped booting again — the new entities weren't in the schema. I generated the DDL with Hibernate, added a Flyway migration (V3) to actually boot it, and ran k6 with auth enabled. But p95 shot up. The cause wasn't app logic but the BCrypt auth running on every request — a story of the load test pinpointing exactly what was slow."
date: 2026-07-22T00:00:00.000Z
tags:
  - Payment
  - Flyway
  - Load Testing
  - k6
  - Performance
  - Authentication
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 17
---

*결제 시스템 시리즈. 개선기 — 전체 시스템 실기동과 부하테스트.*

## 0. 또, 앱이 안 떴다

확장 모듈 8개(포인트·구독·월렛·FDS·암호화·감사·가상계좌·현금영수증)를 붙이고 나서 앱을 띄우니 — 또 안 떴어요. [7편에서 겪은 것](/blog/project/pay/pay-7-making-it-run)과 같은 문제예요. 확장으로 엔티티가 10개쯤 늘었는데, 그 테이블들이 **Flyway 스키마에 없어서** `validate`가 막았죠.

이번에도 같은 방법으로 풀었어요 — Hibernate한테 엔티티에서 DDL을 파일로 뽑게 하고, 새 테이블만 골라 `V3__extensions.sql`로 만들었어요.

```
Flyway: Migrating schema `pay` to version "1 - init"
Flyway: Migrating schema `pay` to version "2 - seed dev data"
Flyway: Migrating schema `pay` to version "3 - extensions"
Started PayApplication in 6.822 seconds
```

27개 테이블, 13개 모듈이 전부 올라와서 실제로 떴어요. 그리고 인증(ROLE_USER)도 붙은 상태로 스모크를 확인했죠 — 무인증 주문은 401, 인증 주문은 201.

## 1. 그런데 k6가 임계치를 넘었다

이제 [준비해둔 k6](/blog/project/pay/pay-5-lock-comparison)를 다시 돌렸어요. 그런데 처음엔 **임계치를 넘겼어요.**

```
✗ 'p(95)<300ms'  p(95)=3.08s     ← 3초?!
  http_req_failed  rate=0.00%     ← 근데 오류는 0%
```

오류율은 0%인데 p95가 **3초**. 이전 무인증 측정 때는 p95가 96ms였는데 30배가 됐어요. 뭐가 달라졌나?

두 가지였어요.

## 2. 범인 ①: 요청마다 도는 BCrypt

가장 큰 원인은 **인증**이었어요. [보안 수정으로](/blog/project/pay/pay-10-composite-payment) 결제 엔드포인트에 HTTP Basic 인증을 걸었는데 —

> HTTP Basic 인증은 **무상태**예요. 세션이 없으니 **요청마다 비밀번호를 다시 검증**해요. 그리고 비밀번호는 BCrypt로 해싱돼 있는데, **BCrypt는 의도적으로 느려요**(브루트포스 방어). 그래서 매 요청이 BCrypt 한 번씩을 돌리고, 주문+승인 한 번에 BCrypt를 두 번 돌려요.

측정에서 이게 딱 보였어요 — **최소 응답시간이 110ms.** 무인증 때 min이 3.5ms였는데, 이 110ms 바닥은 순수하게 BCrypt 비용이에요. 앱 로직이 아니라 **인증 방식의 값**인 거죠.

이게 바로 **실서비스가 토큰/세션을 쓰는 이유**예요. 로그인 때 한 번만 BCrypt 검증하고, 이후엔 JWT 서명 검증(빠름)이나 세션 조회로 요청당 재해싱을 피해요. 부하테스트가 이 설계 결정의 이유를 **수치로** 보여준 거예요.

## 3. 범인 ②: 머신 부하

두 번째는 환경이었어요. 이 프로젝트를 오래 돌리는 동안 로컬 머신의 로드가 6~7까지 올라가 있었어요(빌드·컨테이너 여파). CPU가 포화된 상태에서 200 VU를 때리니 모든 게 느려졌죠.

그래서 부하를 50 VU로 낮춰서, BCrypt 비용을 감안한 임계치로 다시 쟀어요.

```
✓ 'p(95)<1500ms'  p(95)=567.84ms
✓ 'p(99)<3000ms'  p(99)=712.27ms
✓ 'rate<0.01'     rate=0.00%
  http_reqs: 2778, 오류율 0%
```

**오류율 0%, p95 567ms, p99 712ms.** min 110ms(BCrypt 바닥)를 감안하면 앱 자체는 잘 견디고 있어요.

## 4. 개선의 교훈

이번 건 두 가지를 확인했어요.

- **"테스트 초록불 ≠ 실기동"** (또): 확장 모듈이 다 통과해도, 스키마 마이그레이션이 없으면 안 떠요. [7편](/blog/project/pay/pay-7-making-it-run)과 똑같은 구멍을 확장 때도 메워야 했죠.
- **부하테스트는 병목을 짚어준다**: "p95가 왜 3초지?"를 파고드니 답이 **인증 방식**이었어요. 숫자를 감으로 해석하지 않고 "min이 110ms인 게 이상하다 → BCrypt다"로 좁힌 과정 자체가, 성능 분석이 어떻게 되는지의 사례예요.

> "동시에 많이 결제하면?"에 대한 답이 "우리 앱은 빠릅니다"가 아니라 **"현재 인증이 무상태 BCrypt라 요청당 ~110ms가 들고, 실서비스는 토큰으로 이걸 없앤다"**가 되는 것 — 이게 부하테스트를 실제로 돌려봐야만 나오는 답이에요.

## 마치며

이걸로 결제 시스템을 밑바닥부터 만들고, 확장하고, 실제로 돌리고, 부하까지 준 여정을 마쳐요. 코드는 195개 테스트로 검증돼 있고, 실 MySQL 위에서 27개 테이블·13개 모듈이 라이브로 동작하는 걸 확인했어요. 그리고 만드는 내내 "돌아가는 것"과 "실제로·안전하게 돌아가는 것" 사이의 구멍을 하나씩 메운 기록이었어요.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, 각 개선은 라이브 실측으로 검증했습니다.*

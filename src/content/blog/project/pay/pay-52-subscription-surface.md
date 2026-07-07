---
title: '빌링키도 dunning도 다 만들어놓고 — 구독을 부를 방법이 없었다'
titleEn: 'Billing Keys, Dunning, All Built — but No Way to Actually Start a Subscription'
description: 결제 시스템 개선기. 구독 모듈에 빌링키 암호화·정기청구 배치·dunning(soft/hard decline 재시도·유예)까지 정성껏 만들어놨는데, 정작 그걸 부를 API가 하나도 없었다. 서비스 계층만 있고 외부 표면이 없어, 구독을 개시할 수도 조회할 수도 해지할 수도 없었다. 이 시리즈가 반복해온 "만들고 안 씀"의 마지막 큰 조각을, 사용자 REST 표면과 데모 패널로 완성한 이야기.
descriptionEn: "Payment system improvement log. The subscription module had encrypted billing keys, a recurring-charge batch, and dunning (soft/hard decline retries and grace) — all carefully built, but not a single API to call it. Service layer only, no external surface: you couldn't start, view, or cancel a subscription. A story of completing the last big 'built but unwired' piece with a user REST surface and a demo panel."
date: 2027-03-20T00:00:00.000Z
tags:
  - Payment
  - Subscription
  - Recurring Billing
  - REST API
  - Spring Boot
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 52
---

*결제 시스템 시리즈. 개선기 — 숨어 있던 구독 모듈을 완성하다.*

## 0. 또 "만들고 안 쓴 것" — 이번엔 통째로

[감사](/blog/project/pay/pay-39-settlement-escrow-alignment)와 [재감사](/blog/project/pay/pay-48-settlement-date-key-bug)로 "만들어놓고 배선 안 한 것들"을 계속 잡아왔는데, 전체 기능 관점에서 훑어보니 **모듈 하나가 통째로 숨어 있었어요** — `subscription`(구독)이요.

안을 열어보니 이미 꽤 정성껏 지어져 있었어요.

- **빌링키**: [envelope 암호화 + 블라인드 인덱스](/blog/project/pay/pay-41-encryption-applied)로 저장(카드 토큰이라 민감).
- **정기청구 배치**: `runBillingCycle`이 청구일 도래한 구독을 청구.
- **dunning**: soft decline은 재시도(유예 기간), hard decline은 정지, 재시도 소진 판정까지.

그런데 —

> **이걸 부를 API가 하나도 없었어요.** 컨트롤러 0개. 구독을 **개시할 수도, 조회할 수도, 해지할 수도** 없었죠. 정기청구 배치는 있는데 청구할 구독을 만들 방법이 없으니, 사실상 **아무도 못 쓰는 완성품**이었어요. [금고를 만들고 안 채운 것](/blog/project/pay/pay-41-encryption-applied)처럼, 이번엔 방을 다 지어놓고 문을 안 단 셈이었어요.

구독은 SaaS·멤버십 어디나 있는 **핵심 결제 상품**이라, 이 표면을 완성했어요.

## 1. 사용자 표면 — 개시·조회·해지·즉시청구

REST 표면을 얹었어요.

```
POST /api/v1/subscriptions           구독 개시(빌링키 + 월 금액)
GET  /api/v1/subscriptions           내 구독 목록
GET  /api/v1/subscriptions/{id}      상세 + 청구 이력
POST /api/v1/subscriptions/{id}/cancel     해지
POST /api/v1/subscriptions/{id}/bill-now   즉시 청구(데모/운영)
```

기존 서비스가 이미 `subscribe`·`changePlan`·`runBillingCycle`을 갖고 있어서, 저는 **부족한 조각만** 채우면 됐어요 — `cancel`, 조회(`subscriptionsOf`/`detail`), 그리고 데모용 즉시청구(`billNow`).

여기서 신경 쓴 게 **소유권**이에요. 구독은 회원 개인 자산이라, 남의 구독을 조회·해지하면 안 돼요.

```java
private Subscription requireOwned(Long subscriptionId, long userId) {
    Subscription s = subscriptionRepository.findById(subscriptionId)
            .orElseThrow(() -> SubscriptionException.notFound(subscriptionId));
    if (s.getUserId() != userId) {
        throw new SubscriptionException("SUBSCRIPTION_FORBIDDEN", "본인의 구독만 접근할 수 있습니다.");
    }
    return s;
}
```

[주문에서 IDOR를 막던 것](/blog/project/pay/pay-30-maker-checker)과 똑같은 원칙 — userId는 클라이언트가 아니라 **인증 principal에서** 얻고, 그 무엇보다 먼저 소유권을 검증해요. 실기동으로 user2가 user1의 구독을 조회하면 **403**이 나는 걸 확인했어요.

## 2. 배치와 즉시청구가 한 로직을 공유하게

데모에서 "즉시 청구"를 눌러 dunning을 관찰하고 싶은데, 청구 로직은 배치(`runBillingCycle`) 루프 안에 있었어요. 복붙하면 두 벌이 갈라지죠. 그래서 **한 구독 청구**를 `bill()`로 추출했어요.

```java
private void bill(Subscription subscription, LocalDate today) {
    BillingResult result = billingGateway.charge(subscription.getBillingKey(), subscription.getPlanAmount());
    switch (result) {
        case SUCCESS      -> handleSuccess(subscription);       // renew + 다음 청구일
        case SOFT_DECLINE -> handleSoftDecline(subscription, today);  // 재시도 예약/유예
        case HARD_DECLINE -> handleHardDecline(subscription);   // 정지
    }
    subscriptionRepository.saveAndFlush(subscription);
}
```

이제 배치는 청구일 도래분을 돌며 `bill()`을 부르고, 즉시청구(`billNow`)도 같은 `bill()`을 한 번 불러요. **dunning·상태전이·이력 기록이 한 곳에서만** 일어나니, 배치로 청구하든 버튼으로 청구하든 동작이 정확히 같아요.

## 3. 눌러볼 수 있는 구독

데모 콘솔에 구독 패널을 붙였어요.

![구독 정기결제 데모 — 개시·상태·청구주기·해지](/uploads/project/pay/demo/demo-subscription.png)

빌링키로 구독을 개시하면 `ACTIVE`로 뜨고 다음 청구일이 한 달 뒤로 잡혀요. "즉시 청구"를 누르면 청구가 일어나 다음 청구일이 갱신되고, 상세를 보면 청구 이력(성공/decline)이 쌓여요. 해지하면 `CANCELED`가 되고요. **서비스 계층에만 있던 구독이, 이제 눌러볼 수 있는 기능이 됐어요.**

실기동으로 전 흐름을 확인했어요.

```
구독 개시 → id=1 ACTIVE, 다음 청구 2026-08-07
즉시 청구 → 성공, 다음 청구 2026-09-07로 갱신, 이력[SUCCESS]
해지     → CANCELED
user2가 user1 구독 조회 → 403 (IDOR 차단)
```

## 마치며

이번 건 새 로직이라기보단 **완성**이에요 — 빌링키 암호화도, 정기청구도, dunning도 이미 있었으니까요. 근데 그것들이 **부를 수 없으면 없는 것과 같아요.** 이 시리즈가 반복해서 보여준 "만들었다 ≠ 쓸 수 있다"의, 이번엔 모듈 통째 버전이었죠.

배운 건 하나예요 — **표면(API)이 없으면 도메인 로직이 아무리 정교해도 죽은 코드**라는 것. 그리고 표면을 얹을 때도 소유권 검증 같은 [신뢰 경계](/blog/project/pay/pay-30-maker-checker)는 반사적으로 따라와야 한다는 것. 잘 지어둔 방에 문을 달고 자물쇠를 채우니, 비로소 구독이 **쓸 수 있는 상품**이 됐어요.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, 구독 개시·즉시청구·이력·해지·IDOR 차단을 실 MySQL로 검증했습니다.*

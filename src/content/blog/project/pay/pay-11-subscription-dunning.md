---
title: '구독 결제 — "실패하면 바로 해지하나요?"에 답하는 dunning'
titleEn: "Subscription Billing — Dunning, the Answer to 'Do You Cancel Right After a Failure?'"
description: 결제 시스템 확장 3. 빌링키로 매달 자동결제하는 구독을 만든다. 핵심은 결제가 실패했을 때다 — soft decline(잔액부족)은 유예기간을 주고 재시도(dunning), hard decline(도난·무효 카드)은 즉시 중단하고 재시도하지 않는다(반복 시도는 가맹점 평판을 깎으니까). ACTIVE→유예→정지→만료 상태머신과 proration까지.
descriptionEn: "Payment system extension 3. Building subscriptions that auto-charge monthly via a billing key. The crux is what happens on failure — a soft decline (insufficient funds) gets a grace period and retries (dunning), while a hard decline (stolen/invalid card) is suspended immediately with no retry, because retrying lowers merchant reputation. Plus the ACTIVE→grace→hold→expired state machine and proration."
date: 2026-07-16T00:00:00.000Z
tags:
  - Payment
  - Subscription
  - Dunning
  - State Machine
  - Billing
  - Java
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 11
---

*결제 시스템 시리즈. 확장 3편 — 구독과 dunning.*

## 0. 구독의 진짜 문제는 "실패"다

빌링키로 매달 자동결제하는 구독. 연동 자체는 어렵지 않아요 — 토스페이먼츠 빌링키 발급받고, 매달 승인 API 부르면 되죠. 그런데 [Phase 2에서 배운 것](/blog/project/pay/pay-2-designing-for-failure)처럼, **진짜는 실패했을 때**예요.

> 토스페이먼츠는 **스케줄링을 제공하지 않아요.** 결제 주기 관리, 실패 처리, 상태 전이는 전부 우리 몫이에요. 그리고 "구독 결제가 실패하면 바로 해지하나요?"가 이 도메인의 핵심 질문이고요.

## 1. dunning — soft와 hard를 나눈다

결제 실패엔 두 종류가 있어요. 이걸 구분하는 게 dunning의 핵심이에요.

```java
switch (gateway.charge(billingKey, amount)) {
    case SUCCESS -> subscription.renew(nextMonth);        // 성공 → 다음 주기
    case SOFT_DECLINE -> dunning(subscription);           // 잔액부족 등 → 재시도
    case HARD_DECLINE -> subscription.hold();             // 도난·무효 → 즉시 중단
}
```

| 실패 유형 | 예시 | 처리 |
|---|---|---|
| **SOFT_DECLINE** | 잔액부족, 한도초과 | **재시도.** 유예기간 주고 2일 뒤 다시. 3회 소진하면 정지 |
| **HARD_DECLINE** | 도난·분실·무효 카드 | **즉시 정지, 재시도 없음** |

왜 hard decline은 재시도를 안 할까요?

> **도난·무효 카드를 반복 시도하면 카드사에서 가맹점 평판 점수가 깎여요.** 될 리가 없는 카드를 계속 긁으면 "이 가맹점은 뭔가 이상하다"고 카드사가 보는 거죠. 그래서 hard decline은 재시도 없이 바로 중단하고 사용자에게 카드 변경을 요청해요. 이건 [Phase 2의 "재시도 가능한 에러와 불가능한 에러를 구분한다"](/blog/project/pay/pay-2-designing-for-failure)와 같은 논리예요.

## 2. 유예기간 상태머신 — "바로 해지"하지 않는다

"실패하면 바로 해지"는 나쁜 UX예요. 카드가 잠깐 한도 찼을 뿐인데 구독이 끊기면 화나잖아요. 그래서 유예기간을 두는 상태머신을 만들었어요 (Google Play 구독 모델 참고).

```
ACTIVE ──(soft decline)──> IN_GRACE_PERIOD ──(재시도 소진)──> ON_HOLD ──> EXPIRED
   │                             │
   │                        (결제 성공) → ACTIVE 복귀
   └──(hard decline)──> ON_HOLD (급행: 유예 없이 바로 정지)
```

- **IN_GRACE_PERIOD**: 결제는 실패했지만 아직 서비스는 유지. 재시도 중.
- **ON_HOLD**: 재시도도 소진 / hard decline. 서비스 중단.
- 유예·정지 중에 결제가 성공하면 → **ACTIVE로 복귀.**

[Phase 1의 상태머신](/blog/project/pay/pay-1-order-payment-core)처럼 허용된 전이만 코드로 강제했어요. 그리고 hard decline은 유예를 건너뛰고 `ACTIVE → ON_HOLD` 급행으로 가게 별도 전이를 뒀고요 — "hard는 재시도·유예 없음"이라는 의미를 상태머신에 새긴 거예요.

모든 시도는 `DunningAttempt`로 append-only 기록해서, "이 구독이 몇 번 실패했고 다음 재시도가 언제인지"가 남아요.

## 3. proration — 플랜 바꿀 때 일할계산

구독 중에 플랜을 바꾸면(업그레이드/다운그레이드) 남은 기간을 정산해야 해요.

```java
long net = Math.floorDiv((newAmount - oldAmount) * remainingDays, totalDays);
// 업그레이드 → 양수(추가 청구), 다운그레이드 → 음수(크레딧)
```

남은 기간 비율만큼 차액을 계산해요. 업그레이드는 즉시 차액을 청구하고, 다운그레이드는 크레딧으로 적립(현금 환불 아님). 순수 함수라 월말 경계 같은 엣지 케이스를 테스트로 못 박기 좋았어요.

## 4. 정리

구독도 결국 [이 시리즈의 명제](/blog/project/pay/pay-0-why-and-modulith) 그대로예요 — **차별화는 "실패"에 있다.**

- 빌링키로 매달 긁기(성공 경로)는 흔해요.
- **soft/hard decline 구분, 유예기간 상태머신, dunning 재시도 스케줄, proration** — 이게 "구독을 만들어봤다"와 "구독의 실패를 다뤄봤다"를 가르는 지점이에요.

"결제 실패하면 바로 해지하나요?"에 **"아니요, soft decline이면 유예기간 주고 재시도하고, hard decline이면 즉시 정지하되 재시도는 안 합니다 — 도난카드 반복 시도는 평판을 깎으니까요"**라고 답할 수 있는 거죠.

## 다음 — 선불 월렛

다음은 페이머니 같은 선불 충전 월렛이에요. 복식부기로 잔액을 관리하고, 전금법 기명 200만원 한도를 코드로 넣고, 동시 차감에서 이중지불이 안 나는 걸 실측으로 증명하는. 이어서 씁니다.

---

*확장도 기존 기반(상태머신·재시도 구분·원장 발상) 위에 얹으며, 각 규칙을 테스트로 고정합니다.*

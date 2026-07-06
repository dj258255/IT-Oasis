---
title: '돈을 바로 주지 않는다 — 구매확정 전까지 판매자 정산을 보류하는 에스크로'
titleEn: "Not Paying Out Right Away — Escrow That Holds Seller Settlement Until Purchase Confirmation"
description: 결제 시스템 개선기. 결제가 승인되면 곧장 판매자 정산 대상이 됐는데, 마켓플레이스라면 이게 위험하다. 구매확정 전에 판매자에게 돈이 가면 분쟁·미배송 때 회수가 어렵다. 그래서 결제금을 에스크로에 HELD로 잡아두고, 구매자가 수령을 확정해야 RELEASED, 취소되면 REFUNDED로 푸는 자금 보류 모듈을 붙였다. 그리고 "부분취소는 홀드를 어떻게 하나" 같은 판단들.
descriptionEn: "Payment system improvement log. On approval, funds immediately became settlement-eligible for the seller — risky for a marketplace. If money reaches the seller before the buyer confirms receipt, clawback on dispute or non-delivery is hard. So I added an escrow module that holds funds as HELD, releases only on the buyer's purchase confirmation, and refunds on cancellation. Plus judgment calls like how partial cancels affect the hold."
date: 2026-09-12T00:00:00.000Z
tags:
  - Payment
  - Escrow
  - Spring Modulith
  - Event Driven
  - Domain Design
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 25
---

*결제 시스템 시리즈. 개선기 — 자금을 바로 주지 않고 보류하기.*

## 0. 승인되면 곧장 판매자 돈이 된다

지금까지의 흐름을 보면, 결제가 승인되는 순간 그 돈은 [정산 대상](/blog/project/pay/pay-4-ledger-settlement-reconciliation)으로 쌓였어요. 하루치 배치가 집계해서 판매자에게 지급될 돈으로요.

단일 판매자(자사몰)라면 이게 문제없어요. 그런데 **마켓플레이스**(제3자 판매자가 입점)를 생각하면 위험이 보여요.

> 결제 승인 = 판매자에게 정산이라면, **구매자가 물건을 받기도 전에** 판매자에게 돈이 넘어가요. 만약 판매자가 배송을 안 하거나, 물건이 하자거나, 사기라면? 이미 정산된 돈을 **회수하기가 매우 어려워요.** 판매자가 출금해버리면 끝이죠.

실서비스 마켓플레이스가 **에스크로(escrow, 자금 보류)**를 쓰는 이유가 이거예요. "구매확정" 버튼을 누르기 전까지, 결제금은 **중립 지대에 묶여** 있어요. 판매자도 아직 못 받고, 구매자는 문제가 있으면 돌려받을 수 있고요.

## 1. 생명주기: HELD → RELEASED / REFUNDED

그래서 `escrow` 모듈을 새로 붙였어요. 홀드(hold)의 상태는 셋이에요.

```
결제 승인  → HELD      (자금 보류 — 판매자 미정산)
구매확정   → RELEASED  (판매자에게 정산 가능)
전액취소   → REFUNDED  (구매자에게 환불, 판매자 미정산)
```

기존 모듈을 하나도 안 건드리고 붙일 수 있었어요. [이벤트로 이어져 있으니까요](/blog/project/pay/pay-0-why-and-modulith).

- `PaymentConfirmedEvent`를 구독 → 결제금을 **HELD로 보류** 생성.
- `PaymentCanceledEvent`(전액)를 구독 → 아직 보류 중이면 **REFUNDED**.
- 구매확정 API 호출 → **RELEASED** + `EscrowReleasedEvent` 발행(정산 파이프라인이 이걸 구독하면 그때 판매자에게 지급).

에스크로는 결제·정산 모듈이 자기를 구독하는지도 몰라요. 그냥 결제 이벤트를 듣고 홀드를 만들 뿐이죠.

데모 콘솔에서 승인까지 마치면, 주문 `PAID` · 결제 `DONE`과 함께 에스크로가 `HELD`로 잡히는 걸 볼 수 있어요(오른쪽 상태 카드).

![결제 플로우 데모 — 주문 PAID / 결제 DONE / 에스크로 HELD](/uploads/project/pay/demo/demo-checkout.png)

## 2. 판단 ①: 구매확정은 누가 할 수 있나 — 경계 설계

구매확정은 돈을 판매자에게 풀어주는(RELEASED) 행위예요. 그러니 **아무나 하면 안 되고, 그 주문의 구매자 본인만** 할 수 있어야 해요([IDOR 방지](/blog/project/pay/pay-10-composite-payment)).

문제는 — 소유권 검증은 **주문(order) 모듈**이 해요(userId ↔ 주문 매핑을 order가 소유). 그런데 릴리스는 **에스크로 모듈**의 일이에요. 에스크로가 소유권까지 신경 쓰면 order에 의존해야 하고, 경계가 지저분해져요.

그래서 이렇게 나눴어요.

> **구매확정 진입점(`PurchaseConfirmationService`)을 order 모듈에 뒀어요.** order가 주문을 로드하고 → `verifyOwner`로 소유권을 확인하고 → PAID 상태인지 보고 → **그 다음에** `escrowService.release(orderNo)`를 호출해요. 에스크로는 "이미 검증된 orderNo"만 받아서 상태만 전이하니, **소유권(IDOR)을 전혀 신경 쓰지 않아요.**

의존 방향은 order → escrow 단방향이에요. 에스크로는 order를 모르니 순환도 없고요. "누가 무엇을 책임지는가"를 모듈 경계로 그은 거예요 — order는 사용자·소유권, escrow는 자금 보류 상태.

## 3. 판단 ②: 부분취소는 홀드를 어떻게 하나

이게 이번에 제일 고민한 지점이에요. 전액취소는 명확해요 — 홀드를 통째로 REFUNDED로 환불하면 돼요. 그런데 **부분취소**는요?

`PaymentCanceledEvent`에는 `fullyCanceled` 플래그가 있어요. 처음엔 이걸 무시하고 "취소 이벤트 오면 무조건 환불"로 짰는데, 실기동에서 버그가 드러났어요 — **1만 원 중 3천 원만 부분취소했는데 에스크로 전체(1만 원)가 REFUNDED로 풀려버린** 거예요.

이건 틀렸어요. 에스크로 홀드는 **주문 단위의 all-or-nothing 보류**예요. 3천 원만 돌려줬으면 나머지 7천 원은 여전히 판매자에게 갈 돈으로 **HELD 상태를 유지**해야 해요. 부분 금액 환불이 홀드 전체 회수로 이어지면 안 되죠.

그래서 리스너에 가드를 넣었어요.

```java
@ApplicationModuleListener
void onCanceled(PaymentCanceledEvent event) {
    // 전액 취소만 홀드를 환불한다. 부분취소는 잔여 결제가 살아 있으므로 홀드를 유지한다.
    if (event.fullyCanceled()) {
        escrowService.refundIfHeld(event.orderNo());
    }
}
```

실기동으로 세 시나리오를 다시 확인했어요.

```
전액취소(1만) → 주문 CANCELED,      결제 CANCELED,        에스크로 REFUNDED
부분취소(3천) → 주문 PAID,          결제 PARTIAL_CANCELED, 에스크로 HELD 유지  ← 고쳐짐
구매확정     → 주문 PAID,          결제 DONE,            에스크로 RELEASED
```

"이벤트가 오면 처리한다"가 아니라 **"어떤 종류의 이벤트인가"에 따라 다르게 처리한다** — 이 구분이 도메인 정확성을 갈랐어요. 부분취소에 담긴 `fullyCanceled=false`를 존중하는 게 핵심이었죠.

## 4. 판단 ③: 구매자가 확정을 안 하면

현실에서 구매자는 "구매확정" 버튼을 잘 안 눌러요. 물건을 받고도 그냥 두죠. 그럼 판매자 돈이 영원히 묶일까요?

실서비스는 **자동 구매확정**을 둬요 — 배송완료 후 N일이 지나면 자동으로 RELEASED. 그래서 홀드에 `autoReleaseAt`(예: 승인 + 7일)을 두고, 스케줄러가 기한이 지난 HELD 홀드를 자동 릴리스하게 했어요.

```java
public int autoReleaseDue() {
    // autoReleaseAt이 지난 HELD 홀드를 릴리스. 한 건 실패가 배치를 안 멈추게 per-item 처리.
    ...
}
```

스케줄러는 [보상 태스크](/blog/project/pay/pay-19-compensation-network-cancel)와 같은 방식으로 프로퍼티 게이트(`app.escrow.auto-release.enabled`)로 켜고 꺼요. 기본은 꺼둬서 테스트·로컬에 부작용이 없고요.

## 5. 그리고 — 이걸 붙이다 큰 버그를 하나 잡았다

에스크로를 붙이고 실기동으로 검증하다가, **원래 있던 치명적인 버그**를 발견했어요. 구매확정이 자꾸 "결제 완료 주문만 확정할 수 있습니다"(409)로 막히길래 DB를 봤더니 — 결제 승인 응답은 PAID인데 **DB에는 주문이 PENDING_PAYMENT로 남아 있었어요.** 결제가 실제로는 DB에 확정되지 않고 있던 거예요.

이건 에스크로와 별개인, 훨씬 근본적인 문제였어요. 그 이야기는 [다음 편](/blog/project/pay/pay-26-persistence-bug)에서 따로 다뤄요 — 이번 편의 교훈 하나만 미리 말하면, **"기능을 실제로 끝까지 눌러보는 것(E2E 실기동)이 단위 테스트가 못 잡는 버그를 드러낸다"**는 거예요. 에스크로가 "주문이 PAID여야 한다"는 조건을 실제로 요구했기 때문에, 그동안 숨어 있던 버그가 튀어나왔거든요.

## 마치며

에스크로는 "돈을 언제 최종적으로 넘길 것인가"를 다루는 기능이에요. 승인은 "돈을 받았다"이지 "판매자에게 줘도 된다"가 아니라는 것 — 그 사이에 **구매확정이라는 관문**을 두는 게 마켓플레이스 신뢰의 핵심이에요.

만들면서 배운 건, 경계를 잘 그으면(소유권은 order, 보류는 escrow) 새 기능이 기존을 안 건드리고 얹힌다는 것, 그리고 이벤트의 **플래그 하나(`fullyCanceled`)**를 존중하느냐가 도메인 정확성을 가른다는 거였어요.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, HELD→RELEASED/REFUNDED 전 흐름을 실 MySQL로 검증했습니다.*

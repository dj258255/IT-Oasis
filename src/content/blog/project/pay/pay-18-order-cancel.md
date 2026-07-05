---
title: '취소는 결제의 거울상이 아니었다 — 포인트 우선 환불과 부분취소의 재고 문제'
titleEn: "Cancellation Isn't a Mirror of Payment — Points-First Refunds and the Partial-Cancel Stock Problem"
description: 결제 시스템 개선기. 승인 흐름은 다 만들어놓고 취소를 미뤄뒀는데, 실서비스라면 취소가 없으면 반쪽이다. 취소를 붙이면서 마주친 세 가지 판단 — 환불을 포인트부터 되돌리는 이유(어뷰징 방지), 부분취소가 금액 단위라 수량 단위 재고에 매핑되지 않는 문제, 그리고 재취소 때 이중환불을 막는 정산. 결제를 뒤집는 게 왜 단순 역연산이 아닌지에 대한 기록.
descriptionEn: "Payment system improvement log. I had built the whole approval flow but deferred cancellation — yet for a real service, no cancellation means it's only half-done. Three judgment calls I hit while wiring it up: why refunds unwind points first (abuse prevention), why partial cancels (amount-based) don't map onto quantity-based stock, and the reconciliation that prevents double-refunds on re-cancellation. A record of why reversing a payment isn't a simple inverse operation."
date: 2026-07-25T00:00:00.000Z
tags:
  - Payment
  - Refund
  - Spring Modulith
  - Idempotency
  - Domain Design
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 18
---

*결제 시스템 시리즈. 개선기 — 주문 취소를 붙이며 마주친 판단들.*

## 0. 미뤄둔 숙제

승인 흐름을 만들 때, 취소는 일부러 미뤄뒀어요. [복합결제 편](/blog/project/pay/pay-10-composite-payment)의 `CheckoutService` 하단엔 이런 주석이 붙어 있었죠.

```java
// NOTE: 주문 취소(cancel)는 Phase 2/3으로 미룬다 ...
```

그런데 실서비스 관점에서 보면, 취소가 없는 결제는 반쪽이에요. 사람들은 주문을 **되돌립니다** — 잘못 눌러서, 마음이 바뀌어서, 배송이 안 돼서. 그리고 되돌리는 순간, 결제할 때는 없던 질문들이 한꺼번에 튀어나와요. 이번 편은 그 주석을 지우면서 마주친 판단들의 기록이에요.

처음엔 "취소는 그냥 결제의 역연산 아닌가?" 싶었어요. 결제가 `포인트 차감 + 카드 승인`이면, 취소는 `포인트 복원 + 카드 취소`. 끝. — 그런데 세 군데서 막혔어요.

## 1. 판단 ①: 무엇부터 되돌릴 것인가 — 포인트 우선

[복합결제](/blog/project/pay/pay-10-composite-payment)는 한 주문을 **포인트 + 카드**로 나눠 냈어요. 예를 들어 3만 원짜리를 포인트 5천 + 카드 2만 5천으로요.

그럼 1만 원을 부분취소할 때, 이 1만 원을 **어디서** 빼서 돌려줘야 할까요? 포인트에서? 카드에서? 반반?

결제 역연산으로만 생각하면 답이 안 나와요. 결제는 "포인트 먼저, 모자라면 카드"라는 순서가 있었지만, 취소엔 그 순서가 그대로 적용되지 않거든요. 여기서 **실서비스라면 어떻게 할까**를 생각했어요.

> **포인트를 먼저 되돌립니다.** 이유는 어뷰징 방지예요. 만약 카드를 먼저 환불하면, 사용자는 "카드로 낸 돈은 다 돌려받고, 포인트는 계정에 그대로 남는" 상태를 만들 수 있어요. 적립 포인트가 프로모션으로 준 거라면, 이건 실질적으로 "카드값 전액 환불 + 포인트 공짜 획득"이 되죠. 그래서 **되돌릴 때도 내부 자원(포인트)부터** 회수하는 게 안전해요.

이 배분 규칙을 `RefundAllocator`라는 작은 순수 함수로 뽑았어요. 부수효과 없이 "얼마를 포인트에서, 얼마를 카드에서"만 계산하니 단위 테스트가 쉬워요.

```java
// 포인트 우선: 취소액을 포인트 잔액 한도까지 포인트에서 빼고, 나머지를 카드에서 뺀다
long fromPoint = Math.min(cancelAmount, paidByPoint);
long fromCard  = cancelAmount - fromPoint;
```

`CancelService`는 이 계산 결과를 받아, 포인트 몫은 point 모듈에, 카드 몫은 payment 모듈에 위임해요. 배분(정책)과 실행(각 모듈)을 분리한 거예요.

## 2. 판단 ②: 부분취소는 재고를 되돌릴 수 없다

두 번째가 진짜 까다로웠어요. 전액 취소라면 명확해요 — 주문이 통째로 없던 일이 되니, 차감했던 **재고를 복원**하고 주문을 `CANCELED`로 바꾸면 돼요.

```java
if (fully) {
    for (OrderItem item : order.getItems()) {
        stockDeductionService.restore(item.getProductId(), item.getQuantity());
    }
    order.cancel();
}
```

그런데 **부분취소**는요? 3만 원 주문에서 1만 원만 취소하면, 재고를 얼마나 되돌려야 할까요?

여기서 단위가 안 맞는다는 걸 깨달았어요. **취소는 금액 단위(1만 원)인데, 재고는 수량 단위(책 몇 권)예요.** 1만 원어치가 "책 0.7권"이면, 재고를 0.7권 되돌릴 수는 없죠. 금액 부분취소를 수량 재고에 매핑하는 건 정의 자체가 안 돼요.

그래서 판단은 이랬어요 — **부분취소는 재고를 복원하지 않고, 주문 상태도 `PAID`로 유지한다.** 돈만 일부 돌려주고, 주문은 여전히 "일부 결제가 살아있는" 상태로 두는 거예요. 이 결정을 코드 주석에 명시적으로 남겼어요, 나중에 "왜 부분취소는 재고를 안 건드리지?"가 버그로 오해받지 않게요.

```java
// 부분취소는 금액 단위라 수량 단위 재고에 매핑되지 않아 복원하지 않는다. 주문은 PAID 유지.
```

> 실무에서 "수량 단위 부분취소"(3권 중 1권만 반품)를 하려면, 취소 API 자체를 **금액이 아니라 주문 라인(item) 단위**로 다시 설계해야 해요. 그건 별개의 기능이라, 지금은 "금액 부분취소 = 재고 불변"으로 경계를 명확히 그었어요. 할 수 없는 걸 억지로 흉내 내는 것보다, 못 하는 이유를 코드가 설명하게 두는 게 나아요.

## 3. 판단 ③: 두 번 취소하면 두 번 환불되는가

세 번째는 재취소예요. 부분취소는 한 주문에 **여러 번** 일어날 수 있어요. 1만 원 취소하고, 나중에 또 1만 원 취소하고.

그럼 "환불 가능한 포인트"를 어떻게 알까요? 결제할 때 쓴 포인트만 보면, 이미 한 번 환불한 걸 또 환불해버려요. 그래서 **정산**이 필요해요.

```java
public long refundableAmount(String orderNo) {
    long used     = historyRepository.sumAmountByOrderNoAndType(orderNo, USE);
    long refunded = historyRepository.sumAmountByOrderNoAndType(orderNo, REFUND);
    return Math.max(0, used - refunded);  // 쓴 포인트 - 이미 환불한 포인트
}
```

포인트 이력을 append-only로 쌓아둔 게 여기서 빛을 발했어요. 잔액을 덮어쓰지 않고 `USE`/`REFUND`를 계속 기록하니, "지금까지 얼마 쓰고 얼마 돌려줬는지"를 합산으로 정확히 구할 수 있어요. 카드도 마찬가지로 payment 쪽 `balanceAmount`(취소 가능 잔액)를 봐요.

여기에 취소 API도 [승인과 똑같이](/blog/project/pay/pay-2-designing-for-failure) `Idempotency-Key`로 멱등 처리했어요. 취소 버튼 "따닥" 더블클릭이나, 응답 타임아웃 후 재시도가 **두 번 환불로 이어지지 않게요.** 돈을 돌려주는 쪽이야말로 멱등성이 중요하죠 — 실수로 두 번 주면 그대로 손실이니까요.

## 4. 이벤트가 나머지를 알아서 이어줬다

카드 취소를 실행하면 `PaymentCanceledEvent`를 발행하는데, 이걸 이미 만들어둔 모듈들이 **구독하고 있었어요.**

- [현금영수증 모듈](/blog/project/pay/pay-16-cash-receipt)이 받아서 → 발급했던 영수증을 **연쇄 취소**
- [원장 모듈](/blog/project/pay/pay-4-ledger-settlement-reconciliation)이 받아서 → **역분개**(반대 방향 분개) 기록

`CancelService`는 이것들을 전혀 몰라요. 그냥 "취소됐다"고 이벤트만 쏘면, 영수증 취소도 회계 역분개도 알아서 이어져요. [Spring Modulith 이벤트](/blog/project/pay/pay-0-why-and-modulith)로 모듈을 느슨하게 묶어둔 덕에, 취소라는 새 흐름을 붙일 때 기존 모듈을 건드릴 필요가 없었어요. 이게 모듈 경계를 이벤트로 그은 보상이에요.

## 5. 순서 하나가 보안이다

마지막으로 사소해 보이지만 중요한 것 — **검증 순서.**

`CancelService.cancel`은 이 순서를 지켜요.

1. 취소 금액이 0 이하인지 (방어)
2. 주문 로드
3. **소유권 검증** — 이게 그 무엇보다 먼저
4. 상태 검증 (`PAID`만 취소 가능)
5. 잔액 조회 → 배분 → 환불

3번을 앞에 두는 게 핵심이에요. 소유권을 확인하기 **전에** 잔액을 조회하거나 계산하면, 남의 주문 정보가 응답 시간·에러 메시지로 새어나갈 수 있어요(IDOR). 그래서 "이 주문이 당신 것인가"를 통과하기 전엔 잔액 조회조차 하지 않아요. 테스트에도 이걸 박아뒀어요 — 소유권 위반 케이스에서 `pointService.refundableAmount`가 **한 번도 호출되지 않는지**(`never()`)를 검증해요.

```
✓ 전액취소(포인트+카드): 포인트 우선 환불 + 카드 취소 + 재고 복원 + CANCELED
✓ 전액취소(전액 포인트): 카드 취소 미호출, 포인트만 환불
✓ 부분취소: 포인트만 환불, 재고 복원 안 함, PAID 유지
✓ 소유권 위반: ORDER_FORBIDDEN, 잔액 조회조차 안 함
✓ PAID 아닌 주문: INVALID_STATE_TRANSITION
✓ 취소액 > 잔여: CANCEL_AMOUNT_EXCEEDED
```

## 마치며

취소를 "결제의 역연산"으로 생각하고 시작했는데, 막상 붙여보니 **세 가지 독립적인 판단**이었어요 — 무엇부터 되돌릴지(포인트 우선), 되돌릴 수 없는 게 뭔지(부분취소의 재고), 이미 되돌린 걸 어떻게 뺄지(재취소 정산). 결제가 한 방향이라면 취소는 여러 방향으로 갈라지는 문제였고, 그래서 별도 오케스트레이션이 필요했어요.

이제 결제 시스템이 "받는 것"만이 아니라 "되돌리는 것"까지 온전히 다뤄요. 그리고 되돌리는 쪽이 실은 더 조심스럽다는 걸 — 이중환불 하나가 그대로 손실이 되니까 — 만들면서 다시 배웠어요.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, 취소 로직은 7종의 단위 테스트로 검증했습니다.*

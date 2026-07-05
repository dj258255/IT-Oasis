---
title: '포인트 + 카드 복합결제 — 왜 환불은 포인트부터 하나'
titleEn: "Points + Card Composite Payment — Why Refunds Come Out of Points First"
description: 결제 시스템 확장 2. 포인트와 카드를 같이 쓰는 복합결제를 만든다. 내부 포인트(롤백 확실)를 먼저 선점하고 외부 카드를 승인한 뒤, 카드가 실패하면 포인트를 복원하는 보상 트랜잭션. 그리고 부분취소 시 "왜 포인트부터 환불하는가" — 카드부터 환불하면 무상 포인트를 현금화하는 어뷰징이 가능하기 때문이다.
descriptionEn: "Payment system extension 2. Building composite payment that uses points and card together. Reserve internal points first (rollback is certain), approve the external card, and compensate by restoring points if the card fails. And why partial refunds come out of points first — refunding the card first would let someone cash out free points."
date: 2026-07-15T00:00:00.000Z
tags:
  - Payment
  - Composite Payment
  - Saga
  - Compensation
  - Points
  - Java
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 10
---

*결제 시스템 시리즈. 확장 2편 — 복합결제와 환불 우선순위의 도메인 논리.*

## 0. 내부와 외부를 한 결제에 묶기

"10,000원을 포인트 6,000 + 카드 4,000으로 결제." 이게 복합결제예요. 무신사 공고의 "쿠폰/포인트 benefit 시스템", 배민의 "포인트시스템"이 이거고요.

여기 핵심 문제가 있어요 — **포인트 차감(내부 DB)과 카드 승인(외부 PG)은 한 트랜잭션이 될 수 없어요.** 외부 API 호출은 롤백이 안 되니까요. 그래서 [Phase 2의 보상 트랜잭션](/blog/project/pay/pay-2-designing-for-failure)이 여기서도 나와요.

## 1. 롤백 확실한 것을 먼저 선점한다

순서가 중요해요. **롤백이 확실한 내부 자원(포인트)을 먼저** 잡고, 그다음 외부 카드를 승인해요.

```java
// 2. 금액 검증: 카드 + 포인트 = 주문 총액 (위변조 검증 확장)
order.verifyAmount(Money.of(cardAmount.amount() + pointAmount));

// 4. 포인트 선점 — 롤백이 확실한 내부 자원을 먼저
if (pointAmount > 0) pointService.use(order.getUserId(), pointAmount, orderNo);

// 5. 카드 승인 (외부)
ConfirmResult result = paymentService.confirm(orderNo, paymentKey, cardAmount);

// 6. 카드 실패 → 포인트 복원 (보상 트랜잭션)
if (!cardApproved) {
    pointService.restore(order.getUserId(), pointAmount, orderNo);
    order.revertToPending();
}
```

왜 포인트를 먼저? **포인트는 실패하면 그냥 롤백하면 돼요(확실).** 카드를 먼저 하면 카드 승인 후 포인트 차감이 실패했을 때 카드를 취소해야 하는데, 그건 외부 호출이라 또 실패할 수 있어요. 확실한 걸 먼저 잡고, 불확실한 걸 나중에 하고, 나중 게 실패하면 확실한 걸 되돌리는 거예요.

그리고 금액 검증도 확장했어요 — **카드 + 포인트 = 주문 총액.** 클라이언트가 포인트 6,000 쓴다고 하고 카드는 1원만 보내면? 합이 주문금액과 안 맞으니 [Phase 1의 신뢰 경계](/blog/project/pay/pay-1-order-payment-core)에서 막혀요.

> 그리고 `pointAmount == 0`이면 **기존 순수 카드결제와 완전히 동일**하게 동작해요. 확장이 기존 흐름을 안 건드리게 — 이게 [멀티 PG 때](/blog/project/pay/pay-9-multi-pg-routing)와 같은 "기존 위에 얹기" 원칙이에요.

## 2. 왜 환불은 포인트부터인가 (면접 킬러)

부분취소가 이 도메인에서 제일 재밌는 지점이에요. 10,000원(포인트 3,000 + 카드 7,000) 결제를 5,000원 부분취소하면, **뭘로 5,000을 돌려줄까요?**

정답은 **포인트부터**예요.

```java
public RefundAllocation allocate(long cancelAmount, long paidByPoint, long paidByCard) {
    long fromPoint = Math.min(cancelAmount, paidByPoint);   // 포인트 먼저
    long fromCard  = cancelAmount - fromPoint;
    return new RefundAllocation(fromPoint, fromCard);
}
```

왜냐면 — **카드부터 환불하면 무상 포인트를 현금화하는 어뷰징**이 가능해요.

> 이벤트로 받은 무상 포인트 3,000 + 카드 7,000으로 10,000원짜리를 사고, 7,000원어치를 부분취소한다고 해봐요. 카드부터 환불하면 카드 7,000이 그대로 돌아와요. 결과적으로 3,000원짜리 물건을 **공짜 포인트로만** 산 게 되죠 — 무상 포인트가 현금처럼 빠져나간 거예요. 포인트부터 환불하면 이게 막혀요.

이건 코드 두 줄이지만, **"왜 그렇게 했나"에 어뷰징 방지 논리로 답할 수 있느냐**가 도메인을 아는 사람과 모르는 사람을 가르는 지점이에요. 면접에서 "부분취소 어떻게 하세요?"에 강한 답이 되고요.

## 3. 포인트 원장도 append-only

포인트도 [원장](/blog/project/pay/pay-4-ledger-settlement-reconciliation)의 발상을 따랐어요 — 잔액을 덮어쓰는 게 아니라 이력을 남겨요. `PointHistory`(USE/RESTORE/REFUND)가 append-only로 쌓이고, 각 작업은 `orderNo` 기준 멱등이에요. 그래서 복합결제가 재시도돼도 포인트가 두 번 빠지거나 두 번 복원되지 않아요. 쿠폰 안분도 순수 함수로 "배분 합 = 쿠폰액" 불변식을 테스트로 못 박았고요(끝전은 마지막 라인에 몰아주기).

## 4. 그리고 보안 검토가 또 잡았다 — IDOR

복합결제를 커밋하자 자동 보안 검토가 두 개를 짚었어요. 둘 다 진짜였고요.

**① 소유권 검증이 없었다 (IDOR).** `confirm`이 `orderNo`로 주문을 로드해 `order.getUserId()`의 포인트를 차감하는데, **호출자가 그 주문의 주인인지 확인하지 않았어요.** 특히 전액 포인트 경로(cardAmount=0)로 **남의 주문에 남의 포인트를 소진**시킬 수 있었죠. 게다가 주문 생성 때 `userId`를 요청 본문에서 받고 있었는데, 그것도 스푸핑 가능했어요.

**② 음수 pointAmount.** `pointAmount`가 raw long이라 음수를 넣어 검증을 우회하려는 시도가 가능했고, `PointService`는 `amount <= 0`을 조용히 no-op 처리하고 있었어요.

고쳤어요.

```java
// userId는 요청 본문이 아니라 인증된 principal에서 얻는다
long userId = Long.parseLong(principal.getName());

// confirm 안에서, 검증·차감 그 무엇보다 먼저
order.verifyOwner(authenticatedUserId);   // 주인이 아니면 ORDER_FORBIDDEN

// 음수 방어 + 오버플로 방어
if (pointAmount < 0 || cardAmount.amount() < 0) throw ...;
long total = Math.addExact(cardAmount.amount(), pointAmount);
```

그리고 `/api/v1/orders`·`/payments/confirm`에 사용자 인증(ROLE_USER)을 걸고, **userId를 클라이언트가 아니라 인증 컨텍스트에서** 얻게 했어요. 소유권 위반 테스트(userId 2가 userId 1의 주문 결제 → `ORDER_FORBIDDEN`)로 못 박았고요.

> 이게 [Phase 1의 신뢰 경계](/blog/project/pay/pay-1-order-payment-core)·[Phase 6의 어드민 인증](/blog/project/pay/pay-6-operations)과 **정확히 같은 실수**예요 — "userId를 클라이언트가 보낸 값으로 믿었다." 결제에서 **누가 요청했는가(authentication)와 그 주문의 주인이 맞는가(authorization)**는 클라이언트가 아니라 서버가 정해야 해요. 세 번째로 같은 패턴을 잡으면서, "신뢰 경계를 먼저 긋는다"가 이 프로젝트를 관통하는 규칙이라는 게 분명해졌어요.

## 다음 — 빌링키 정기결제

다음 확장은 구독이에요. 빌링키로 매달 자동결제하고, 실패하면 dunning(soft decline은 재시도, hard decline은 즉시 중단)으로 회수하는. "결제 실패하면 바로 해지하나요?"에 답하는 유예기간 상태머신까지. 이어서 씁니다.

---

*확장도 기존 기반(보상 트랜잭션·신뢰 경계·원장 발상) 위에 얹는 형태로, 각 규칙을 테스트로 고정하며 만듭니다.*

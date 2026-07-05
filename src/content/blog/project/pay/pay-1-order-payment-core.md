---
title: '결제 코어를 만들며 배운 것 — "검증"보다 "무엇을 신뢰하는가"가 먼저다'
titleEn: "Building the Payment Core — Deciding What to Trust Comes Before Validating It"
description: 결제 시스템 Phase 1. 주문·결제 모듈을 Spring Modulith로 만들면서 상태머신, 금액 위변조 검증, 요청·승인 분리를 구현했다. 그런데 커밋 보안 검토가 내 "금액 위변조 검증"을 무력화하는 자기모순을 잡아냈다 — 검증의 기준값 자체를 클라이언트가 보낸 가격으로 계산하고 있었던 것. 방어 코드가 존재하는데도 보안 극장이 되는 순간, 그리고 신뢰 경계(trust boundary)를 먼저 긋는 게 왜 검증 로직보다 중요한지.
descriptionEn: "Payment system Phase 1. Building the order and payment modules in Spring Modulith, I implemented the state machine, amount-tampering verification, and the request/approve split. But a commit-time security review caught a contradiction that neutralized my 'amount-tampering verification' — the baseline it checked against was itself computed from a client-supplied price. The moment defensive code becomes security theater, and why drawing the trust boundary comes before the validation logic."
date: 2026-07-06T00:00:00.000Z
tags:
  - Payment
  - Spring Modulith
  - State Machine
  - Security
  - Domain-Driven Design
  - Java
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 1
---

*결제 도메인 취업을 목표로 실전 결제 시스템을 밑바닥부터 만드는 시리즈. 이 글은 1편 — 주문·결제 코어를 만들며 상태머신·금액 검증·신뢰 경계를 배운 이야기.*

## 0. 이번에 만든 것

[0편](/blog/project/pay/pay-0-why-and-modulith)에서 아키텍처를 Spring Modulith로 잡았어요. 이번 Phase 1에서는 실제 도메인을 채웠습니다 — **order(주문)**와 **payment(결제)** 두 모듈.

- 결제 **상태머신**: `READY → IN_PROGRESS → DONE / UNKNOWN / ABORTED / CANCELED ...`, 허용된 전이만 코드로 강제
- **요청·승인 분리**와 **금액 위변조 검증**
- 승인 결과의 **3-상태 분기** (성공 / 미확정 / 거절)
- 모듈 간 **이벤트 기반 통신**과 경계 검증
- 단위 테스트 41개, 모두 통과

그런데 이번 편의 진짜 이야기는 마지막에 있어요. **커밋 보안 검토가 내 결제 시스템의 심장을 찔렀거든요.** 거기부터 거꾸로 풀어볼게요.

## 1. 상태머신: `UNKNOWN`을 1급 시민으로

결제 상태를 enum 하나로 관리하면 안 되는 이유는, **아무 상태로나 마구 넘어갈 수 있기 때문**이에요. 취소된 결제가 다시 승인되면 안 되잖아요. 그래서 허용된 전이만 선언하고, 위반하면 예외를 던지게 했어요.

```java
public enum PaymentStatus {
    READY, IN_PROGRESS, UNKNOWN, DONE, CANCELED, PARTIAL_CANCELED, ABORTED, EXPIRED;

    private static final Map<PaymentStatus, Set<PaymentStatus>> TRANSITIONS = Map.of(
        READY,       EnumSet.of(IN_PROGRESS, EXPIRED, ABORTED),
        IN_PROGRESS, EnumSet.of(DONE, UNKNOWN, ABORTED, EXPIRED),
        UNKNOWN,     EnumSet.of(DONE, CANCELED, ABORTED),   // 복구 배치가 조회 후 확정/망취소
        DONE,        EnumSet.of(CANCELED, PARTIAL_CANCELED),
        // ...
    );

    public boolean canTransitionTo(PaymentStatus target) {
        return TRANSITIONS.getOrDefault(this, Set.of()).contains(target);
    }
}
```

여기서 눈여겨볼 건 **`UNKNOWN`**이에요. 보통 결제 튜토리얼엔 없는 상태죠. 토스페이먼츠 승인 API를 부르다 **타임아웃**이 나면, 결제가 된 건지 안 된 건지 우리는 몰라요. 이걸 "실패"로 단정하면 — 돈은 빠졌는데 주문은 취소되는 최악의 CS가 생겨요.

그래서 타임아웃은 실패가 아니라 `UNKNOWN`으로 보존해요. (이건 카카오페이 "MSA 네트워크 예외" 글의 성공/실패/**Unknown** 3-상태 모델이에요.) 이 상태를 실제로 어떻게 확정하는지 — 조회·망취소·복구 배치 — 는 다음 Phase 2의 주제예요. Phase 1에서는 **상태를 잃지 않고 보존**하는 것까지.

## 2. 요청·승인은 왜 나누나

토스페이먼츠 결제는 **요청 → 인증 → 승인** 3단계예요. 그리고 승인의 최종 방아쇠는 **우리 서버**가 당겨요. 프론트에서 인증이 끝나면 `paymentKey`를 들고 우리 서버로 돌아오고, 그때 서버가 승인 API를 호출하죠.

왜 이렇게 나눌까요? 토스페이먼츠 공식 답은 "데이터 정합성"인데, 실전에서 체감되는 이유는 이거예요 — **서버가 재고를 확인하고 금액을 검증한 뒤에만 돈이 움직이게** 하려고요.

그래서 승인 흐름을 이렇게 짰어요.

```java
public CheckoutResult confirm(String orderNo, String paymentKey, Money requestedAmount) {
    Order order = orderRepository.findByOrderNo(orderNo).orElseThrow(...);

    order.verifyAmount(requestedAmount);   // ① 금액 위변조 검증
    order.startPayment();                  // ② 이중 지불 차단(상태 전이)
    ConfirmResult result = paymentService.confirm(orderNo, paymentKey, requestedAmount);  // ③ PG 승인

    if (result.isApproved()) {
        deductStock(order);                // ④ 승인 성공 시에만 재고 차감 (ADR-003)
        order.markPaid();
    } else if (result.isUnknown()) {
        // 미확정 — 주문은 그대로 두고 복구 배치에 맡긴다
    } else {
        order.revertToPending();           // 거절 — 재시도 가능하게 복귀
    }
    return ...;
}
```

`verifyAmount`는 successUrl로 돌아온 금액이 주문 금액과 같은지 확인해요. 클라이언트를 거쳐 온 값은 조작될 수 있으니까요. **대부분의 결제 토이프로젝트가 이걸 빼먹는데**, 저는 넣었으니 안전하다고 생각했어요.

그게 착각이었어요.

## 3. 보안 검토가 찌른 곳 — 검증의 기준값이 오염돼 있었다

커밋을 하자 자동 보안 검토가 돌았고, 이런 걸 물어왔어요.

> `OrderLine`이 가격(`unitPrice`)을 클라이언트에서 받고 있습니다.

처음엔 대수롭지 않게 봤어요. "주문 만들 때 상품 가격 받는 거 당연하지." 그런데 흐름을 따라가 보니 등골이 서늘했어요.

```java
// 내가 짰던 것 (문제)
public record OrderLine(long productId, String productName, long unitPrice, int quantity) {}
//                                                          ^^^^^^^^^^^^^^ 클라이언트가 보낸 가격

// 주문 총액 = 클라이언트가 보낸 가격의 합
order.totalAmount = Σ (unitPrice × quantity);

// 그리고 나중에...
order.verifyAmount(requestedAmount);  // requestedAmount == totalAmount 인지 확인
```

보이시나요? **`totalAmount` 자체가 클라이언트가 보낸 가격으로 계산**돼요. 그러니 사용자가 "이 상품 1원"이라고 주문을 만들면, `totalAmount`도 1원이 되고, 승인 때 1원을 보내면 — **검증을 완벽하게 통과해요.** 10만 원짜리를 1원에 결제하는 거죠.

내 `verifyAmount`는 열심히 검증하고 있었어요. **오염된 기준값에 대고서요.**

> 방어 코드가 존재하는데도 무력했어요. 이게 **보안 극장(security theater)**이에요 — 검증하는 시늉은 나는데 실제로는 아무것도 못 막는. 문제는 검증 로직이 아니라, **무엇을 신뢰할 것인가(trust boundary)**를 잘못 그은 거였어요.

## 4. 고친 방법 — 신뢰 경계를 다시 긋다

해법은 단순해요. **가격은 클라이언트에게서 받지 않는다.** 서버가 자기 카탈로그에서 조회한다.

```java
// 고친 것 — 클라이언트는 "무엇을 몇 개"만 보낸다
public record OrderLine(long productId, int quantity) {}

// 서버가 카탈로그에서 가격을 조회해 스냅샷을 만든다
Product product = productRepository.findById(line.productId())
        .orElseThrow(() -> OrderException.productNotFound(line.productId()));
OrderItem.of(product.getProductId(), product.getName(), product.getPrice(), line.quantity());
```

이제 `OrderLine`에는 **가격 필드 자체가 없어요.** 클라이언트가 조작할 방법이 컴파일 타임에 사라진 거예요. 그리고 `totalAmount`는 서버 가격으로만 계산되니, `verifyAmount`가 비로소 진짜 방어가 됩니다.

덤으로 몇 개 더 막았어요.

- `unitPrice × quantity`를 `Math.multiplyExact`로 — 오버플로가 조용히 뒤집히지 않고 예외
- 음수·0 수량, 음수 단가 거부
- 재고 차감에 음수 수량 거부 (음수 차감이 재고를 **늘리는** 버그가 있었어요)

그리고 이걸 테스트로 못 박았어요.

```java
@Test
@DisplayName("클라이언트가 가격을 조작할 방법이 없다 — OrderLine에는 가격 필드 자체가 없다")
void clientCannotSupplyPrice() {
    when(productRepository.findById(999L)).thenReturn(Optional.empty());
    assertThatThrownBy(() -> service.createOrder(1L, List.of(new OrderLine(999L, 1))))
            .satisfies(e -> assertThat(((OrderException) e).code()).isEqualTo("PRODUCT_NOT_FOUND"));
}
```

## 5. 이번 편에서 진짜 남은 것

기능 목록보다 이 교훈이 더 커요.

> **결제 시스템에서 "무엇을 신뢰하는가"를 정하는 건, 검증 로직을 짜는 것보다 먼저다.**

금액, 상품 가격, 재고 — 이런 "돈이 걸린 값"의 **원천(source of truth)이 서버인지 클라이언트인지**를 먼저 못 박아야 해요. 그게 틀리면, 그 위에 아무리 검증을 쌓아도 극장일 뿐이에요. 재밌게도 이건 면접에서 강한 이야기예요 — "금액 검증 어떻게 했나요?"에 "검증 이전에 신뢰 경계부터 봤고, 실제로 그걸 놓쳤다가 잡은 경험이 있다"고 답할 수 있으니까요.

## 6. 모듈 경계는 어떻게 지켰나

order는 payment를 호출하지만(승인 위임), 반대로 payment는 order를 몰라요. 그리고 이 규칙은 말이 아니라 **테스트로 강제**돼요.

```java
// order/package-info.java
@ApplicationModule(allowedDependencies = { "shared", "payment" })
package com.beomsu.pay.order;
```

payment가 실수로 order를 참조하거나, 둘이 순환 의존을 만들면 `ModularityTests.verify()`가 **빌드를 깨뜨려요.** 결제 완료 같은 사건은 payment가 이벤트로 발행하고(Phase 3에서 원장·정산이 구독), 이 이벤트 발행은 [0편에서 말한](/blog/project/pay/pay-0-why-and-modulith) Modulith의 이벤트 레지스트리(=Outbox)로 신뢰성이 보장돼요.

## 다음 — Phase 2: 미확정을 확정하다

이번에 `UNKNOWN`을 보존만 했어요. 다음 Phase 2가 이 시리즈의 ★ 하이라이트예요.

```
멱등키           "따닥" 중복결제 + 타임아웃 후 안전 재시도
UNKNOWN 복구     조회 API로 확정 / 안 되면 망취소
망취소 배치       타임아웃 1분 뒤 취소 (즉시 취소하면 PG에 결제정보가 아직 없어 실패)
서킷브레이커      PG 장애가 우리 전체로 번지지 않게
```

"결제가 실패했을 때"를 본격적으로 만드는 편이에요. 이어서 씁니다.

---

*이 글은 작성 중인 시리즈의 일부예요. 코드와 설계 문서(채용공고 분석·ERD·API 스펙·장애 시나리오)는 별도로 정리하며 진행합니다.*

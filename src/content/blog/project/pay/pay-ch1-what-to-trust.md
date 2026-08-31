---
title: '신뢰 경계: 검증보다 무엇을 신뢰하는지가 먼저다'
description: '금액 검증을 열심히 짜놓고도 기준값이 클라이언트에서 왔다. 10만 원짜리를 1원에 결제할 수 있었다. 검증 로직보다 무엇을 신뢰할지가 먼저였다.'
date: 2026-08-31T00:00:00.000Z
category: study/pay
coverImage: "/uploads/project/pay/thumbs/pay-ch1.svg"
draft: false
series: "결제 시스템 만들기"
seriesOrder: 1
tags:
  - Payment
  - Spring Modulith
  - 동시성
  - 실패 설계
---

*결제 시스템 시리즈 1편. 코어를 만들며 제일 먼저 정한 것이다. 방어 코드는 있었는데 그게 지키는 값이 이미 오염돼 있었다.*

*결제 시스템 시리즈 1편. 처음 코어를 만들면서 정한 판단들만 모았다. 기능 목록은 총정리에 있다.*



## 0. 만든 것

아키텍처를 Spring Modulith로 잡은 뒤 실제 도메인을 채웠다. order(주문)와 payment(결제) 두 모듈이다.

- 결제 **상태머신**: `READY → IN_PROGRESS → DONE / UNKNOWN / ABORTED / CANCELED ...`, 허용된 전이만 코드로 강제
- **요청·승인 분리**와 **금액 위변조 검증**
- 승인 결과의 **3-상태 분기** (성공 / 미확정 / 거절)
- 모듈 간 **이벤트 기반 통신**과 경계 검증
- 단위 테스트 41개, 모두 통과

그런데 이 절의 진짜 이야기는 뒤에 있다. **커밋 보안 검토가 내 결제 시스템의 심장을 찔렀다.** 거기부터 거꾸로 풀어 간다.

## 1. 상태머신: `UNKNOWN`을 1급 시민으로

결제 상태를 enum 하나로 관리하면 안 되는 이유는, **아무 상태로나 마구 넘어갈 수 있기 때문**이다. 취소된 결제가 다시 승인되면 안 된다. 그래서 허용된 전이만 선언하고, 위반하면 예외를 던지게 했다.

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

눈여겨볼 건 `UNKNOWN`이다. 보통 결제 튜토리얼엔 없는 상태다. 토스페이먼츠 승인 API를 부르다 타임아웃이 나면, 결제가 된 건지 안 된 건지 우리는 모른다. 이걸 "실패"로 단정하면 돈은 빠졌는데 주문은 취소되는 최악의 CS가 생긴다.

그래서 타임아웃을 실패로 단정하지 않고 `UNKNOWN`으로 보존한다. (카카오페이 "MSA 네트워크 예외" 글의 성공/실패/Unknown 3-상태 모델이다.) 이 상태를 실제로 어떻게 확정하는지(조회·망취소·복구 배치)는 다음 절의 주제고, 여기서는 상태를 잃지 않고 보존하는 데까지.

## 2. 요청·승인은 왜 나누나

토스페이먼츠 결제는 요청 → 인증 → 승인 3단계고, 승인의 최종 방아쇠는 우리 서버가 당긴다. 프론트에서 인증이 끝나면 `paymentKey`를 들고 우리 서버로 돌아오고, 그때 서버가 승인 API를 호출한다.

왜 나눌까. 토스페이먼츠 공식 답은 "데이터 정합성"인데, 실전에서 체감되는 이유는 따로 있다. 서버가 재고를 확인하고 금액을 검증한 뒤에만 돈이 움직이게 하려는 것이다.

승인 흐름은 이렇게 짰다.

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

`verifyAmount`는 successUrl로 돌아온 금액이 주문 금액과 같은지 확인한다. 클라이언트를 거쳐 온 값은 조작될 수 있으니까. 대부분의 결제 토이프로젝트가 이걸 빼먹는데, 나는 넣었으니 안전하다고 생각했다.

착각이었다.

## 3. 보안 검토가 찌른 곳: 검증의 기준값이 오염돼 있었다

커밋을 하자 자동 보안 검토가 돌았고, 이런 걸 물어왔다.

> `OrderLine`이 가격(`unitPrice`)을 클라이언트에서 받고 있습니다.

처음엔 대수롭지 않게 봤다. "주문 만들 때 상품 가격 받는 거 당연하지." 그런데 흐름을 따라가 보니 등골이 서늘했다.

```java
// 내가 짰던 것 (문제)
public record OrderLine(long productId, String productName, long unitPrice, int quantity) {}
//                                                          ^^^^^^^^^^^^^^ 클라이언트가 보낸 가격

// 주문 총액 = 클라이언트가 보낸 가격의 합
order.totalAmount = Σ (unitPrice × quantity);

// 그리고 나중에...
order.verifyAmount(requestedAmount);  // requestedAmount == totalAmount 인지 확인
```

`totalAmount` 자체가 클라이언트가 보낸 가격으로 계산된다. 사용자가 "이 상품 1원"이라고 주문을 만들면 `totalAmount`도 1원이 되고, 승인 때 1원을 보내면 검증을 그대로 통과한다. 10만 원짜리를 1원에 결제하는 것이다.

내 `verifyAmount`는 열심히 검증하고 있었다. 오염된 기준값에 대고서.

> 방어 코드가 있는데도 무력했다. 보안 극장(security theater)이다. 검증하는 시늉은 나는데 실제로는 아무것도 못 막는다. 문제는 검증 로직 밖에 있었다. 무엇을 신뢰할 것인가(trust boundary)를 잘못 그은 것이다.

## 4. 고친 방법: 신뢰 경계를 다시 긋다

해법은 단순하다. 가격은 클라이언트에게서 받지 않는다. 서버가 자기 카탈로그에서 조회한다.

```java
// 고친 것 — 클라이언트는 "무엇을 몇 개"만 보낸다
public record OrderLine(long productId, int quantity) {}

// 서버가 카탈로그에서 가격을 조회해 스냅샷을 만든다
Product product = productRepository.findById(line.productId())
        .orElseThrow(() -> OrderException.productNotFound(line.productId()));
OrderItem.of(product.getProductId(), product.getName(), product.getPrice(), line.quantity());
```

이제 `OrderLine`에는 가격 필드 자체가 없다. 클라이언트가 조작할 방법이 컴파일 타임에 사라졌다. `totalAmount`도 서버 가격으로만 계산되니, `verifyAmount`가 비로소 진짜 방어가 된다.

덤으로 몇 개 더 막았다.

- `unitPrice × quantity`를 `Math.multiplyExact`로 계산해, 오버플로가 조용히 뒤집히지 않고 예외가 난다
- 음수·0 수량, 음수 단가 거부
- 재고 차감에 음수 수량 거부 (음수 차감이 재고를 늘리는 버그가 있었다)

테스트로 못 박았다.

```java
@Test
@DisplayName("클라이언트가 가격을 조작할 방법이 없다 — OrderLine에는 가격 필드 자체가 없다")
void clientCannotSupplyPrice() {
    when(productRepository.findById(999L)).thenReturn(Optional.empty());
    assertThatThrownBy(() -> service.createOrder(1L, List.of(new OrderLine(999L, 1))))
            .satisfies(e -> assertThat(((OrderException) e).code()).isEqualTo("PRODUCT_NOT_FOUND"));
}
```

## 5. 여기서 진짜 남은 것

기능 목록보다 이게 크다.

> **결제 시스템에서 "무엇을 신뢰하는가"를 정하는 건, 검증 로직을 짜는 것보다 먼저다.**

금액, 상품 가격, 재고처럼 "돈이 걸린 값"의 원천(source of truth)이 서버인지 클라이언트인지를 먼저 못 박아야 한다. 그게 틀리면 그 위에 아무리 검증을 쌓아도 극장이다. 검증 로직은 그다음 문제다.

## 6. 모듈 경계는 어떻게 지켰나

order는 payment를 호출하지만(승인 위임), 반대로 payment는 order를 모른다. 이 규칙도 테스트가 강제한다.

```java
// order/package-info.java
@ApplicationModule(allowedDependencies = { "shared", "payment" })
package com.beomsu.pay.order;
```

payment가 실수로 order를 참조하거나, 둘이 순환 의존을 만들면 `ModularityTests.verify()`가 빌드를 깨뜨린다. 결제 완료 같은 사건은 payment가 이벤트로 발행하고(뒤에서 원장·정산이 구독), 이 발행은 앞서 말한 Modulith의 이벤트 레지스트리(=Outbox)가 신뢰성을 보장한다.

---

## 남는 생각

**돈이 걸린 값의 원천이 서버인지 클라이언트인지를 먼저 못 박아야 한다.**
그게 틀리면 그 위에 아무리 검증을 쌓아도 극장이다.

이 질문은 뒤에서도 계속 나왔다. 유입 제한을 붙이면서 "클라이언트가 준 IP"를 믿을 뻔했고(7편),
웹훅을 받으면서 "PG가 보낸 값"을 믿을 뻔했다. **방어 코드를 짤 때도 신뢰 경계를 착각하면
그게 곧 구멍이 된다.**

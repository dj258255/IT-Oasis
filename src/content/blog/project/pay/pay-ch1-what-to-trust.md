---
title: '금액 검증: 10만 원짜리를 1원에 결제할 수 있었다'
description: '금액 검증을 열심히 짜놓고도 기준값이 클라이언트에서 왔습니다. 10만 원짜리를 1원에 결제할 수 있었습니다. 검증 로직보다 무엇을 신뢰할지가 먼저였습니다.'
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

## 개요

결제 금액을 서버에서 검증하고 있었는데, 그 검증이 대조하는 기준값 자체가 클라이언트에서 넘어온 값이었습니다. **10만 원짜리 주문을 1원에 결제할 수 있었습니다.**

이 글은 그것을 찾아 고치면서 신뢰 경계를 다시 그은 기록입니다. 신뢰 경계란 금액·가격·재고처럼 돈이 걸린 값을 누가 정하느냐를 가르는 선입니다. 결제 코어에서 제일 먼저 정해야 했던 것이 이것이었습니다.

개인 프로젝트로 만든 결제 시스템 pay의 개발 기록입니다. 실무 운영 경험이 아닙니다.


## 0. 만든 것

아키텍처를 Spring Modulith로 잡은 뒤 실제 도메인을 채웠습니다. order(주문)와 payment(결제) 두 모듈입니다.

- 결제 **상태머신**: `READY → IN_PROGRESS → DONE / UNKNOWN / ABORTED / CANCELED ...`, 허용된 전이만 코드로 강제
- **요청·승인 분리**와 **금액 위변조 검증**
- 승인 결과의 **3-상태 분기** (성공 / 미확정 / 거절)
- 모듈 간 **이벤트 기반 통신**과 경계 검증

여기까지 만들고 커밋한 코드를 보안 관점으로 다시 훑었습니다. **금액 위변조를 막으라고 넣은 바로 그 검증이 이미 뚫려 있었습니다.** 거기부터 거꾸로 풀어 갑니다.

## 1. 상태머신: `UNKNOWN`을 1급 시민으로

결제 상태를 enum 값으로만 두고 전이 규칙을 서비스 곳곳에 흩어두면 **허용되지 않은 상태 변경을 막기 어렵습니다.** 취소된 결제가 다시 승인되면 안 됩니다. 그래서 허용된 전이만 선언하고, 위반하면 예외를 던지게 했습니다.

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

눈여겨볼 건 `UNKNOWN`입니다. 토스페이먼츠 승인 API를 부르다 타임아웃이 나면, 결제가 된 건지 안 된 건지 우리는 모릅니다. 이걸 "실패"로 단정하면 돈은 빠졌는데 주문은 취소되는 최악의 CS가 생깁니다.

데이터를 다루는 서버라면 어디든 트랜잭션을 관리하지만, 결제에서는 한 번의 예외가 곧 고객의 돈입니다. **그래서 예외가 터졌다고 무조건 롤백하면 오히려 더 틀어집니다.** PG에서 이미 일어난 승인은 우리 DB를 롤백해도 되돌아오지 않기 때문입니다. 어떤 상황이 생길 수 있는지 먼저 적어두고, 각각을 어디서 막을지 정했습니다.

| 무슨 일이 생기나 | 이 시스템에서 |
|---|---|
| 같은 결제가 두 번 된다 | 멱등키 `INSERT`에 성공한 요청만 진행합니다 |
| 취소 요청 자체가 실패한다 | 되돌리라는 지시를 DB에 먼저 적고, 배치가 성공할 때까지 재시도합니다 |
| 취소했는데 잔액이 안 돌아온다 | 포인트·월렛·카드 순으로 되돌리고, 남은 환불 가능액을 기준으로 멱등하게 처리합니다 |
| 취소가 승인보다 먼저 도착한다 | 순서가 역전되면 조용히 넘기지 않고 예외를 던져 재배달에 맡깁니다 |
| 실패한 결제의 기록이 없다 | 실패도 지우지 않고 상태로 남깁니다 |
| **성공인지 실패인지 알 수 없다** | **이 절의 주제입니다.** 단정하지 않고 `UNKNOWN`으로 남깁니다 |

마지막 줄이 제일 어렵습니다. 앞의 다섯은 무엇이 일어났는지는 아는 상태라 되돌리거나 다시 하면 되는데, 이건 **무엇이 일어났는지 자체를 모르는** 상태입니다.

그래서 타임아웃을 실패로 단정하지 않고 `UNKNOWN`으로 보존합니다. ([카카오페이의 MSA 결제 트랜잭션 관리 글](https://tech.kakaopay.com/post/msa-transaction/)에 나오는 성공·실패·Unknown 3상태 모델입니다.) 이 상태를 실제로 어떻게 확정하는지(조회·망취소·복구 배치)는 다음 절의 주제고, 여기서는 상태를 잃지 않고 보존하는 데까지.

## 2. 요청·승인은 왜 나누나

토스페이먼츠 결제는 요청 → 인증 → 승인 3단계고, 승인의 최종 방아쇠는 우리 서버가 당깁니다. 프론트에서 인증이 끝나면 `paymentKey`를 들고 우리 서버로 돌아오고, 그때 서버가 승인 API를 호출합니다.

왜 나눌까. 토스페이먼츠 공식 답은 "데이터 정합성"인데, 실전에서 체감되는 이유는 따로 있습니다. **서버가 주문 상태와 금액을 검증한 뒤에만** 최종 승인을 요청하려는 것입니다.

*재고는 이 자리에 없습니다. 이 구현은 PG 승인 뒤에 차감하고, 그래서 "승인은 났는데 재고가 없는" 틈이 생깁니다. 그 틈과 망취소는 [실패 설계 편](/blog/project/pay/pay-ch2-failure-design)에서 다룹니다.*

승인 흐름은 이렇게 짰습니다.

```java
public CheckoutResult confirm(String orderNo, String paymentKey, Money requestedAmount) {
    Order order = orderRepository.findByOrderNo(orderNo).orElseThrow(...);

    order.verifyAmount(requestedAmount);   // ① 금액 위변조 검증
    order.startPayment();                  // ② 이중 지불 차단(상태 전이)
    ConfirmResult result = paymentService.confirm(orderNo, paymentKey, requestedAmount);  // ③ PG 승인

*`startPayment()`의 상태 전이만으로는 동시 요청을 못 막는다 — 둘 다 `PENDING`을 읽고 각자 전이시킬 수 있습니다. 실제로 막는 건 `Order`의 **`@Version` 낙관적 락**이고, 그 위에 멱등키가 한 겹 더 있습니다. 상태 전이는 "허용되지 않은 순서"를 막고, 동시성은 버전이 막습니다.*

    if (result.isApproved()) {
        deductStock(order);                // ④ 승인 성공 시에만 재고 차감
        order.markPaid();
    } else if (result.isUnknown()) {
        // 미확정 — 주문은 그대로 두고 복구 배치에 맡깁니다
    } else {
        order.revertToPending();           // 거절 — 재시도 가능하게 복귀
    }
    return ...;
}
```

`verifyAmount`는 successUrl로 돌아온 금액이 주문 금액과 같은지 확인합니다. 클라이언트를 거쳐 온 값은 조작될 수 있으니까. 넣었으니 안전하다고 생각했습니다.

착각이었습니다.

## 3. 보안 검토가 찌른 곳: 검증의 기준값이 오염돼 있었다

커밋을 하자 자동 보안 검토가 돌았고, 이런 걸 물어왔습니다.

> `OrderLine`이 가격(`unitPrice`)을 클라이언트에서 받고 있습니다.

`OrderLine`은 **주문 생성 요청에 실려 오는 항목 한 줄**입니다. 테이블이 아니라 클라이언트가 보낸 JSON이 바인딩되는 자리입니다.

처음엔 대수롭지 않게 봤습니다. "주문 만들 때 상품 가격 받는 거 당연하지." 그런데 흐름을 따라가 보니 등골이 서늘했습니다.

```java
// 내가 짰던 것 (문제)
public record OrderLine(long productId, String productName, long unitPrice, int quantity) {}
//                                                          ^^^^^^^^^^^^^^ 클라이언트가 보낸 가격

// 주문 총액 = 클라이언트가 보낸 가격의 합
order.totalAmount = Σ (unitPrice × quantity);

// 그리고 나중에...
order.verifyAmount(requestedAmount);  // requestedAmount == totalAmount 인지 확인
```

`totalAmount` 자체가 클라이언트가 보낸 가격으로 계산됩니다. 사용자가 "이 상품 1원"이라고 주문을 만들면 `totalAmount`도 1원이 되고, 승인 때 1원을 보내면 검증을 그대로 통과합니다. 10만 원짜리를 1원에 결제하는 것입니다.

내 `verifyAmount`는 열심히 검증하고 있었습니다. 오염된 기준값에 대고서.

#### "검증한 값을 다시 PG에 넘기지 않나"

외부 리뷰에서 이 질문을 받았습니다. 검증을 통과한 금액이라도 출처는 여전히 클라이언트인데,
그걸 그대로 승인에 쓰면 결론과 어긋나지 않느냐는 것입니다. 확인해 보니 **이 구조에서는 성립하지 않았습니다.**

승인 요청은 카드·포인트·월렛 세 몫으로 나뉘어 옵니다. 서버가 검증하는 건 **그 합계**입니다.

```java
requestedTotal = cardAmount + pointAmount + walletAmount;
order.verifyAmount(Money.of(requestedTotal));   // 서버가 계산한 totalAmount 와 대조
```

합계가 서버 금액과 같아야 통과하고, 카드 몫이 그보다 크면 합계가 넘어 걸립니다.
작으면 나머지를 포인트·월렛이 실제로 채워야 하는데 그건 **선점으로 확인**됩니다.
그래서 **총액은 서버가 정하고, 분해만 클라이언트가 고릅니다.**

분해까지 서버가 정할 수는 없습니다. "얼마를 포인트로 낼지"는 본질적으로 사용자의 선택입니다.
여기서 지켜야 할 건 **총액이 서버 값이라는 것**이고, 그건 지켜지고 있었습니다.

> 방어 코드가 있는데도 무력했습니다. 보안 극장(security theater)입니다. 검증하는 시늉은 나는데 실제로는 아무것도 못 막습니다. 문제는 검증 로직 밖에 있었습니다. 무엇을 신뢰할 것인가(trust boundary)를 잘못 그은 것입니다.

## 4. 고친 방법: 신뢰 경계를 다시 긋다

해법은 단순합니다. 가격은 클라이언트에게서 받지 않습니다. 서버가 자기 카탈로그에서 조회합니다.

```java
// 고친 것 — 클라이언트는 "무엇을 몇 개"만 보냅니다
public record OrderLine(long productId, int quantity) {}

// 서버가 카탈로그에서 가격을 조회해 스냅샷을 만듭니다
Product product = productRepository.findById(line.productId())
        .orElseThrow(() -> OrderException.productNotFound(line.productId()));
OrderItem.of(product.getProductId(), product.getName(), product.getPrice(), line.quantity());
```

이 흐름에서 이름이 비슷한 셋이 각각 다른 일을 합니다.

| | 무엇인가 | 가격 |
|---|---|---|
| `OrderLine` | 클라이언트가 보내는 요청 한 줄 | **없습니다** |
| `products` | 서버의 가격 원본 테이블 | 여기가 기준입니다 |
| `order_items` | 주문에 확정돼 저장되는 테이블 | 조회한 값을 스냅샷으로 박습니다 |

주문 시점 가격을 `order_items`에 박아두는 이유는, 나중에 상품 가격이 바뀌어도 이미 만들어진 주문의 금액이 흔들리면 안 되기 때문입니다.

이제 `OrderLine`에는 가격 필드 자체가 없습니다. 클라이언트는 JSON에 `unitPrice`를 넣을 수야 있지만 **바인딩될 자리가 없어 처리 경로에 들어오지 못합니다.** "보낼 방법"이 아니라 "쓰일 방법"이 사라진 것입니다. `totalAmount`도 서버 가격으로만 계산되니, `verifyAmount`가 비로소 진짜 방어가 됩니다.

덤으로 몇 개 더 막았습니다.

- `unitPrice × quantity`를 `Math.multiplyExact`로 계산해, 오버플로가 조용히 뒤집히지 않고 예외가 납니다
- 음수·0 수량, 음수 단가 거부
- 재고 차감에 음수 수량 거부 (음수 차감이 재고를 늘리는 버그가 있었습니다)

테스트로 못 박았습니다.

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

기능 목록보다 이게 큽니다.

> **결제 시스템에서 "무엇을 신뢰하는가"를 정하는 건, 검증 로직을 짜는 것보다 먼저입니다.**

금액, 상품 가격, 재고처럼 돈이 걸린 값을 서버가 정하는지 클라이언트가 정하는지부터 못 박아야 합니다. 그 자리가 틀려 있으면 위에 검증을 몇 겹 올려도 전부 오염된 값을 검사하게 됩니다. 검증 로직은 그다음입니다.

## 6. 모듈 경계는 어떻게 지켰나

order는 payment를 호출하지만(승인 위임), 반대로 payment는 order를 모릅니다. 이 규칙도 테스트가 강제합니다.

```java
// order/package-info.java
@ApplicationModule(allowedDependencies = { "shared", "payment" })
package com.beomsu.pay.order;
```

payment가 실수로 order를 참조하거나, 둘이 순환 의존을 만들면 `ModularityTests.verify()`가 빌드를 깨뜨립니다. 결제 완료 같은 사건은 payment가 이벤트로 발행하고(뒤에서 원장·정산이 구독), 이 발행은 Spring Modulith의 **Event Publication Registry**가 원 트랜잭션에 함께 기록하고, 완료되지 않은 리스너 처리를 추적·재시도할 수 있게 합니다. (Modulith 문서는 이 레지스트리와 실제 outbox 외부화 모드를 구분합니다. 같은 것으로 뭉뚱그리면 안 됩니다.)

---

## 남는 생각

금액을 검증하는 코드는 처음부터 있었습니다. 그런데 그게 대조하는 기준값이 클라이언트에서 온 값이라
검증은 매번 통과했습니다. 통과하는 걸 보면서 "금액 검증 했다"고 적어둔 게 제일 뜨끔했습니다.

그래서 값을 검사하기 전에 그 값이 어디서 왔는지부터 봅니다. 뒤에 붙인 것들에서 같은 실수를 두 번 더
할 뻔했습니다. 유입 제한을 붙일 때 요청 헤더에 실려 온 IP를 그대로 쓸 뻔했고([해싱 비용을 다룬 7편](/blog/project/pay/pay-ch6-auth-cost)),
웹훅을 받을 때 PG가 보낸 금액을 그대로 반영할 뻔했습니다. 둘 다 뭔가를 막으려고 만든 코드였는데,
막는 근거를 바깥에서 받아오고 있었습니다.

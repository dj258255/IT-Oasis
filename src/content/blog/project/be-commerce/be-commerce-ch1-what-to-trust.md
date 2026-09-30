---
title: '결제 금액은 누가 결정해야 하는가: 클라이언트 신뢰 경계'
description: '결제 금액 검증이 대조하는 기준값을 클라이언트에서 받고 있었습니다. 10만 원짜리 주문을 1원에 승인할 수 있었던 경로를 고치고 카드 정보를 받지 않기로 한 범위 결정까지 다룹니다.'
date: 2026-02-16
category: study/be-commerce
coverImage: "/uploads/project/be-commerce/thumbs/be-commerce-ch1.svg"
draft: true
series: "BE-commerce"
seriesOrder: 1
tags:
  - Payment
  - 보안
  - PCI DSS
  - 신뢰 경계
---

## 개요

결제 금액을 서버에서 검증하고 있었는데 그 검증이 대조하는 기준값 자체가 클라이언트에서 넘어온 값이었습니다. **10만 원짜리 주문을 1원에 결제할 수 있었습니다.**

이 글은 그것을 찾아 고치면서 신뢰 경계를 다시 그은 기록입니다. 신뢰 경계란 금액·가격·재고처럼 돈이 걸린 값을 누가 정하느냐를 가르는 선입니다. 결제 코어에서 제일 먼저 정해야 했던 것이 이것이었습니다. 뒤로 가면 신뢰 경계는 금액 검증 한 자리로 끝나지 않고 카드 정보처럼 애초에 받지 않기로 정한 값에도 똑같이 적용됩니다.

## 0. 만든 것

아키텍처를 Spring Modulith로 잡고 order(주문)와 payment(결제) 두 모듈에 실제 도메인을 채웠습니다. 결제 상태머신과 `UNKNOWN`을 1급 시민으로 다루는 이유, 요청과 승인을 나눈 이유는 [실패 설계 편](/blog/project/be-commerce/be-commerce-ch2-failure-design)에서 다뤘습니다.

여기까지 만들고 커밋한 코드를 보안 관점으로 다시 훑었습니다. **금액 위변조를 막으라고 넣은 바로 그 검증이 이미 뚫려 있었습니다.** 거기부터 거꾸로 풀어 갑니다.

## 1. 검증의 기준값이 오염돼 있었다

승인 요청은 카드·포인트·월렛 세 몫으로 나뉘어 옵니다. 서버가 검증하는 건 그 합계입니다.

```java
long requestedTotal;
try {
    requestedTotal = Math.addExact(Math.addExact(cardAmount.minorUnit(), pointAmount), walletAmount);
} catch (ArithmeticException e) {
    throw new OrderException("AMOUNT_OVERFLOW", "결제 금액이 허용 범위를 초과했습니다.");
}
order.verifyAmount(Money.krw(requestedTotal));
```

`verifyAmount`는 이 합계가 주문의 `totalAmount`와 같은지 확인합니다. 클라이언트를 거쳐 온 값은 조작될 수 있기 때문입니다. 넣었으니 안전하다고 생각했습니다.

착각이었습니다.

### 보안 검토가 찌른 곳

커밋을 하자 자동 보안 검토가 돌았고 이런 걸 물어왔습니다.

> `OrderLine`이 가격(`unitPrice`)을 클라이언트에서 받고 있습니다.

`OrderLine`은 **주문 생성 요청에 실려 오는 항목 한 줄**입니다. 테이블이 아닙니다. 클라이언트가 보낸 JSON이 바인딩되는 자리입니다.

처음엔 대수롭지 않게 봤습니다. 주문 만들 때 상품 가격을 받는 건 흔한 형태라고 생각했습니다. 그런데 그 값이 어디까지 가는지 따라가 봤습니다.

```java
// 내가 짰던 것 (문제)
public record OrderLine(long productId, String productName, long unitPrice, int quantity) {}
//                                                          ^^^^^^^^^^^^^^ 클라이언트가 보낸 가격

// 주문 총액 = 클라이언트가 보낸 가격의 합
order.totalAmount = Σ (unitPrice × quantity);

// 그리고 나중에...
order.verifyAmount(requestedAmount);  // requestedAmount == totalAmount 인지 확인
```

`totalAmount` 자체가 클라이언트가 보낸 가격으로 계산됩니다. 사용자가 "이 상품 1원"이라고 주문을 만들면 `totalAmount`도 1원이 되고 승인 때 1원을 보내면 검증을 그대로 통과합니다. 10만 원짜리를 1원에 결제하는 것입니다.

내 `verifyAmount`는 열심히 검증하고 있었습니다. 오염된 기준값에 대고서.

#### "검증한 값을 다시 PG에 넘기지 않나"

외부 리뷰에서 이 질문을 받았습니다. 검증을 통과한 금액이라도 출처는 여전히 클라이언트인데, 그걸 그대로 승인에 쓰면 결론과 어긋나지 않느냐는 것입니다. 확인해 보니 **이 구조에서는 성립하지 않았습니다.**

승인 요청은 카드·포인트·월렛 세 몫으로 나뉘어 옵니다. 서버가 검증하는 건 **그 합계**입니다.

```java
requestedTotal = cardAmount + pointAmount + walletAmount;
order.verifyAmount(Money.krw(requestedTotal));  // 서버가 계산한 totalAmount 와 대조
```

합계가 서버 금액과 같아야 통과하고 카드 몫이 그보다 크면 합계가 넘어 걸립니다. 작으면 나머지를 포인트·월렛이 실제로 채워야 하는데 그건 **선점으로 확인**됩니다. 그래서 **총액은 서버가 정하고 분해만 클라이언트가 고릅니다.**

분해까지 서버가 정할 수는 없습니다. "얼마를 포인트로 낼지"는 본질적으로 사용자의 선택입니다. 여기서 지켜야 할 건 **총액이 서버 값이라는 것**입니다. 그건 지켜지고 있었습니다.

> 방어 코드가 있는데도 무력했습니다. 보안 극장(security theater)입니다. 검증하는 시늉은 나는데 실제로는 아무것도 못 막습니다. 문제는 검증 로직 밖에 있었습니다. 무엇을 신뢰할 것인가(trust boundary)를 잘못 그은 것입니다.

## 2. 고친 방법: 신뢰 경계를 다시 긋다

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

이제 `OrderLine`에는 가격 필드 자체가 없습니다. 클라이언트는 JSON에 `unitPrice`를 넣을 수야 있지만 바인딩될 자리가 없어 처리 경로에 들어오지 못합니다. "보낼 방법"이 사라진 게 아닙니다. "쓰일 방법"이 사라진 것입니다. `totalAmount`도 서버 가격으로만 계산되니, `verifyAmount`가 비로소 진짜 방어가 됩니다.

덤으로 몇 개 더 막았습니다.

- `unitPrice × quantity`를 `Math.multiplyExact`로 계산해, 오버플로가 조용히 뒤집히지 않고 예외가 납니다
- 음수·0 수량, 음수 단가 거부
- 재고 차감에 음수 수량 거부 (음수 차감이 재고를 늘리는 버그가 있었습니다)

테스트로 못 박았습니다.

```java
@Test
@DisplayName("서버 가격 10만원 주문에 1원 승인을 요청하면 거절되고 PG를 부르지 않는다")
void tamperedApprovalAmountIsRejectedBeforePg() {
    when(orderRepository.save(any(Order.class))).thenAnswer(inv -> inv.getArgument(0));
    when(productRepository.findById(100L)).thenReturn(Optional.of(Product.of(100L, "상품A", 100_000)));
    CreateOrderResult created = service.createOrder(1L, List.of(new OrderLine(100L, 1)));
    assertThat(created.totalAmount()).isEqualTo(100_000);

    Order order = Order.create(1L, List.of(OrderItem.of(100L, "상품A", 100_000, 1)));
    when(orderRepository.findByOrderNo(order.getOrderNo())).thenReturn(Optional.of(order));

    assertThatThrownBy(() -> service.confirm(order.getOrderNo(), "pk-1", Money.krw(1), 0, 0, 1L))
            .isInstanceOf(OrderException.class)
            .satisfies(e -> assertThat(((OrderException) e).code()).isEqualTo("AMOUNT_MISMATCH"));

    // 이 테스트의 요점 — PG를 부르기 전에 거절된다
    verify(paymentService, never()).pgApprove(anyString(), anyString(), any(Money.class), anyInt());
}
```

가격 필드가 입력 모델에 없다는 것도 리플렉션으로 고정했습니다.

```java
@Test
@DisplayName("가격 필드는 서버 입력 모델에 아예 없다 — 클라이언트 가격이 처리 경로에 못 들어온다")
void clientPriceCannotEnterTheServerModel() {
    assertThat(OrderLine.class.getRecordComponents())
            .extracting(java.lang.reflect.RecordComponent::getName)
            .containsExactlyInAnyOrder("productId", "quantity");
}
```

첫 번째 테스트 이름은 원래 지금과 달랐습니다. `clientCannotSupplyPrice`라는 이름으로 있었는데 실제로는 존재하지 않는 상품 ID를 조회해 `PRODUCT_NOT_FOUND`가 나는 것만 확인했습니다. 이름은 가격 조작을 막는다고 말했습니다. 실제로 검증한 것은 상품 조회 실패였습니다. 이름과 실제 검증이 어긋나 있었습니다. 10만 원 주문에 1원 승인을 실제로 걸어 PG가 불리지 않는 것까지 확인하도록 다시 짰습니다. 검증 로직 자체를 오염된 기준값이 무력화한 것과, 검증의 이름과 실제 검증 내용이 어긋나 있던 것은 같은 종류의 함정입니다. 확인했다고 적은 것과 실제로 확인한 것이 다를 수 있습니다.

## 3. 여기서 진짜 남은 것

기능 목록보다 이게 큽니다.

> **결제 시스템에서 "무엇을 신뢰하는가"를 정하는 건, 검증 로직을 짜는 것보다 먼저입니다.**

금액, 상품 가격, 재고처럼 돈이 걸린 값을 서버가 정하는지 클라이언트가 정하는지부터 못 박아야 합니다. 그 자리가 틀려 있으면 위에 검증을 몇 겹 올려도 전부 오염된 값을 검사하게 됩니다. 검증 로직은 그다음입니다.

---

## 뒷이야기: 무엇을 받지 않을지 정하는 것도 신뢰 경계입니다

앞에서 검증의 기준값이 오염돼 있었던 경우를 다뤘습니다. 받은 값을 믿었던 게 문제였습니다. 그런데 한 겹 위에 더 근본적인 결정이 있었는데 그걸 어디에도 안 적어 뒀다는 걸 나중에 알았습니다.

**이 서버는 카드번호를 받지 않습니다.**

```
브라우저 → PG 결제창(카드 정보는 여기서 PG로 직접) → paymentKey
                                                        ↓
                                          우리 서버는 이것만 받는다
```

그래서 **PCI DSS 범위 밖**입니다. 통제를 안 만든 게 아닙니다. 통제해야 할 데이터를 애초에 안 받는 쪽을 골랐습니다.

### 범위를 줄이는 게 통제를 잘하는 것보다 쌉니다

카드 데이터를 만지는 순간 저장·전송·접근통제·로그·정기점검이 전부 따라옵니다. 안 받으면 그 전부가 사라집니다.

**이 결정이 코드에 자국을 남겼습니다.**

- 승인 커맨드에도 결제 행에도 **카드 필드가 없습니다**
- **마스킹·암호화 코드가 없습니다.** 있으면 카드 데이터를 받고 있다는 뜻입니다

대가도 분명합니다. **결제창을 우리가 못 그리고 추가 인증(3DS2) 흐름이 없습니다.** 그 구멍이 다른 자리에 자국을 남겼습니다. **FDS가 등급을 넷으로 나눠 놓고 "추가 인증" 등급을 받을 화면이 없습니다.**

### 네트워크 토큰화는 하면 안 되는 일입니다

처음엔 이걸 *"계약이 없어서 못 한 것"*이라고 적었는데 부정확했습니다.

**국내에서는 카드사와 적격 PG를 제외하면 카드정보를 저장할 수 없습니다.** 규정입니다. 네트워크 토큰은 카드 데이터를 다루는 쪽의 일입니다. 가맹점 서버는 **그 자리에 있으면 안 됩니다.**

### 그럼 가맹점은 무엇을 하는가: 빌링키

카드번호를 못 만지는 가맹점이 할 수 있는 토큰화는 **PG가 준 키를 안전하게 보관하는 것**입니다.

```java
@Convert(converter = EncryptedStringConverter.class)
private String billingKey;          // 암호화해서 저장

@Column(nullable = false, unique = true, length = 64)
private String billingKeyIndex;     // 블라인드 인덱스 — 복호화 없이 조회·유니크 보장
```

빌링키 자체가 **카드번호의 대체물**입니다. 2회차부터는 카드 정보 없이 승인이 됩니다. 그걸 평문으로 두면 카드번호를 평문으로 두는 것과 위험이 비슷해지므로 암호화했습니다. 암호화하면 조회가 안 되므로 블라인드 인덱스를 따로 뒀습니다.

### 그런데 발급만 있고 폐기가 없었습니다

대체물이면 **원본이 죽을 때 같이 죽어야** 합니다. 그런데 구멍이 셋이었습니다.

1. **구독을 해지해도 키가 남았습니다.** 해지한 고객의 결제 수단을 계속 들고 있는 것입니다
2. **카드가 거절돼도 `ACTIVE`로 남았습니다.** 같은 죽은 키로 다음 구독을 만들면 또 실패합니다
3. **폐기된 키로 구독을 만들 수 있었습니다.** 아는 실패를 예약하는 셈입니다

고치면서 정한 것들입니다.

- **지우지 않고 상태로 남깁니다.** 지우면 왜 못 쓰게 됐는지를 나중에 답할 수 없습니다
- **"만료"는 상태로 두지 않았습니다.** 카드 유효기간은 카드사가 알고 우리는 결제가 실패한 뒤에야 압니다. 모르는 것을 상태로 만들면 그 상태가 언제 참인지 아무도 답할 수 없습니다
- **두 번째 폐기가 첫 사유를 덮어쓰지 않습니다.** 카드가 죽어 폐기된 키를 나중에 해지로 다시 폐기하면 진짜 이유가 지워집니다. 대응이 다른 두 가지라 구별이 남아야 합니다
- 해지 때는 **같은 키를 쓰는 다른 구독이 남았는지 보고** 폐기합니다. 안 보면 남의 결제 수단을 지웁니다. **카드가 죽은 경우는 안 봅니다.** 어느 구독에서도 못 쓰기 때문입니다

### 할부: 우리 돈을 안 바꾸는데도 저장하는 이유

**할부는 우리가 받을 돈을 바꾸지 않습니다.** 고객이 12개월로 나눠 내도 **카드사가 가맹점에는 일시에 전액을 지급**합니다. 분납은 카드사와 고객 사이의 일입니다. 그래서 정산도 대사도 이 값을 안 봅니다.

그럼에도 저장합니다. **한도 안에서 결제 금액을 키우는 가장 쉬운 수단이 할부**라, 고액과 겹치면 도난 카드에서 흔한 모양이 되기 때문입니다.

그래서 이상거래 판정이 이 값을 보되 **차단하지는 않습니다.** 안마의자 400만원 12개월은 정상입니다. 점수만 얹어 **사람이 들여다볼 이유**를 만듭니다.

그리고 **5만원 미만은 할부가 안 됩니다.** 국내 카드사 공통 조건이라 도메인에서 막았습니다. 승인 요청을 내보낸 뒤 카드사가 거절하면 그때는 이미 우리 쪽에 `IN_PROGRESS` 행이 남습니다. **우리가 미리 알 수 있는 건 미리 막습니다.**

## 남는 생각

금액을 검증하는 코드는 처음부터 있었습니다. 그런데 그게 대조하는 기준값이 클라이언트에서 온 값이라, 조작된 금액도 매번 통과했습니다. 그렇게 통과하는 걸 보고 문서에 "금액 검증 함"이라고 적어뒀습니다.

그래서 값을 검사하기 전에 그 값이 어디서 왔는지부터 봅니다. 뒤에 붙인 것들에서 같은 실수를 두 번 더 할 뻔했습니다. 유입 제한을 붙일 때 요청 헤더에 실려 온 IP를 그대로 쓸 뻔했습니다([IP 신뢰 경계를 다룬 글](/blog/project/be-commerce/be-commerce-ch6-auth-cost)). 웹훅을 받을 때 PG가 보낸 금액을 그대로 반영할 뻔했습니다. 둘 다 뭔가를 막으려고 만든 코드였습니다. 막는 근거를 바깥에서 받아오고 있었습니다.

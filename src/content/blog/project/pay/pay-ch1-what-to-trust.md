---
title: '결제 코어: 무엇을 신뢰할지 먼저 정했다'
description: '결제 코어를 만들며 정한 것들. 검증보다 신뢰 경계가 먼저였고, 타임아웃은 실패가 아니었고, 락은 셋을 재보고 골랐다. 되돌아봐도 이 판단들이 뒤의 전부를 지탱했다.'
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

*결제 시스템 시리즈 1편. 처음 코어를 만들면서 정한 판단들만 모았다. 기능 목록은 [총정리](/blog/project/pay/pay-0-overview)에 있다.*

## 결제 코어를 만들며 배운 것: "검증"보다 "무엇을 신뢰하는가"가 먼저다


### 0. 만든 것

아키텍처를 Spring Modulith로 잡은 뒤 실제 도메인을 채웠다. order(주문)와 payment(결제) 두 모듈이다.

- 결제 **상태머신**: `READY → IN_PROGRESS → DONE / UNKNOWN / ABORTED / CANCELED ...`, 허용된 전이만 코드로 강제
- **요청·승인 분리**와 **금액 위변조 검증**
- 승인 결과의 **3-상태 분기** (성공 / 미확정 / 거절)
- 모듈 간 **이벤트 기반 통신**과 경계 검증
- 단위 테스트 41개, 모두 통과

그런데 이 절의 진짜 이야기는 뒤에 있다. **커밋 보안 검토가 내 결제 시스템의 심장을 찔렀다.** 거기부터 거꾸로 풀어 간다.

### 1. 상태머신: `UNKNOWN`을 1급 시민으로

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

### 2. 요청·승인은 왜 나누나

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

### 3. 보안 검토가 찌른 곳: 검증의 기준값이 오염돼 있었다

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

### 4. 고친 방법: 신뢰 경계를 다시 긋다

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

### 5. 여기서 진짜 남은 것

기능 목록보다 이게 크다.

> **결제 시스템에서 "무엇을 신뢰하는가"를 정하는 건, 검증 로직을 짜는 것보다 먼저다.**

금액, 상품 가격, 재고처럼 "돈이 걸린 값"의 원천(source of truth)이 서버인지 클라이언트인지를 먼저 못 박아야 한다. 그게 틀리면 그 위에 아무리 검증을 쌓아도 극장이다. 면접에서도 "금액 검증 어떻게 했나요?"에 "검증 이전에 신뢰 경계부터 봤고, 실제로 그걸 놓쳤다가 잡은 경험이 있다"고 답할 수 있는 이야기가 됐다.

### 6. 모듈 경계는 어떻게 지켰나

order는 payment를 호출하지만(승인 위임), 반대로 payment는 order를 모른다. 이 규칙도 테스트가 강제한다.

```java
// order/package-info.java
@ApplicationModule(allowedDependencies = { "shared", "payment" })
package com.beomsu.pay.order;
```

payment가 실수로 order를 참조하거나, 둘이 순환 의존을 만들면 `ModularityTests.verify()`가 빌드를 깨뜨린다. 결제 완료 같은 사건은 payment가 이벤트로 발행하고(뒤에서 원장·정산이 구독), 이 발행은 앞서 말한 Modulith의 이벤트 레지스트리(=Outbox)가 신뢰성을 보장한다.

---

## 결제가 실패했을 때: 타임아웃을 실패로 단정하지 않는다


### 0. 여기가 이 시리즈의 이유다

앞서 말했듯 PG 연동해서 "결제 성공"까지 가는 건 흔하고, 차별화는 PG가 책임지지 않는 영역에 있다. 그게 바로 이번 이야기다.

앞 절에서 타임아웃을 `UNKNOWN` 상태로 보존만 했다. 이번엔 그 미확정을 실제로 확정한다. 만든 것은 셋.

```
멱등키         "따닥" 중복결제 + 타임아웃 후 안전 재시도
UNKNOWN 복구    조회 API로 확정 / 안 되면 망취소
서킷브레이커     PG 장애가 우리 전체로 번지지 않게 (단, 승인은 재시도 금지)
```

### 1. 따닥: 멱등키, 그리고 "INSERT가 곧 잠금"

사용자가 결제 버튼을 두 번 누르면(따닥), 승인 요청이 두 번 간다. 프론트에서 버튼 비활성화? UX일 뿐이다. 방어는 서버에 있어야 한다.

멱등키는 이렇게 설계했다. 같은 `Idempotency-Key`로 온 요청은 딱 한 번만 실제 실행되고, 재요청엔 첫 응답을 그대로 재반환한다.

핵심은 동시성 처리다. 따닥은 거의 동시에 도착하는데 어떻게 하나만 통과시키나. **DB 유니크 제약**이다.

```java
// (멱등키 + 경로 + 메서드) 유니크
try {
    record = repository.saveAndFlush(IdempotencyRecord.start(key, path, method, requestHash));
} catch (DataIntegrityViolationException race) {
    // 다른 요청이 같은 순간 먼저 INSERT 함 → 그 결과로 판정
    return handleExisting(reload(key), requestHash, responseType);
}
```

> INSERT에 성공했다는 것 자체가 "처리권을 획득했다"는 뜻이다. 동시에 온 두 요청 중 하나만 INSERT에 성공하고, 나머지는 유니크 위반으로 튕긴다. 별도의 분산락이 필요 없다. DB가 이미 락 역할을 한다.

상태에 따라 응답도 나눈다. 토스페이먼츠와 같은 시맨틱이다.

| 상황 | 응답 |
|---|---|
| 처리 완료된 같은 키 | 저장된 **첫 응답 재반환** (재실행 없음) |
| 처리 중인 같은 키 | `409`: 잠시 후 같은 키로 재시도 |
| 같은 키인데 **본문이 다름** | `422`: 위험한 재사용 |
| 키 없음/형식 오류 | `400` |

"같은 키 다른 본문 = 422"가 중요하다. 멱등키는 "이 요청을 한 번만"이라는 약속인데, 본문이 다르면 약속이 깨진 것이다.

### 2. 타임아웃을 실패로 단정하지 않고 UNKNOWN을 확정하기

여기서 제일 하고 싶은 이야기다.

PG 승인 API를 부르다 타임아웃이 나면, 결제가 된 건지 안 된 건지 우리는 모른다. 흔한 실수가 "타임아웃 = 실패" 처리다. 그러면 카드에서는 돈이 빠졌는데 우리는 실패로 알고 주문을 취소해버린다. 최악의 CS다.

그래서 카카오페이의 3-상태 모델을 따랐다. 성공, 실패, Unknown.

```java
return switch (result.outcome()) {
    case SUCCESS -> { payment.approve(...); /* 완료 이벤트 발행 */ }
    case FAILED  -> { payment.abort(...); }               // 명시적 거절만 실패
    case TIMEOUT -> { payment.markUnknown(reason); }      // 미확정 — 보존한다
};
```

복구 배치가 UNKNOWN을 확정한다. 주기적으로 UNKNOWN 결제를 스캔해서, PG에 조회 API로 실제 상태를 물어본다.

```java
PgQueryResult pg = pgClient.query(payment.getPaymentKey());
switch (pg.status()) {
    case APPROVED  -> payment.confirmByRecovery(pg.method());  // 실제론 됐네 → 전진 복구(DONE)
    case NOT_FOUND -> payment.abortByRecovery("PG에 결제 없음"); // 진짜 안 됐네 → ABORTED
    case CANCELED  -> payment.networkCancel("이미 취소됨");      // 망취소
}
```

여기서 선택이 하나 갈린다. PG에 조회했더니 실제로는 승인돼 있으면, 나는 취소하지 않고 전진 복구(주문을 완료)를 택했다. 사용자가 결제하려던 거였으니 완성시켜주는 게 맞다. 반대 정책(타임아웃이면 무조건 취소, 곧 망취소)도 유효해서 `networkCancel`도 만들어 뒀다. 둘 다 상태머신에 허용 전이로 넣었다(`UNKNOWN → DONE`, `UNKNOWN → CANCELED`).

> 복구 배치는 건별로 실패를 격리한다. 한 결제 복구가 터져도 배치 전체가 멈추지 않고, 다음 주기에 다시 시도된다. 이런 결제는 조용히 사라지면 안 되니까.

이걸 테스트로 못 박았다. FakePgClient를 상태 기반으로 만들어서 "우리는 타임아웃이었지만 PG엔 승인으로 남은" 상황을 재현했다.

```java
@Test
@DisplayName("PG에 승인돼 있으면 전진 복구(DONE) + 완료 이벤트 발행")
void recoverForwardWhenPgApproved() {
    Payment p = unknownPayment("pk-1");
    when(pg.query("pk-1")).thenReturn(new PgQueryResult(APPROVED, "CARD"));
    service.recoverUnknownPayments();
    assertThat(p.getStatus()).isEqualTo(DONE);
}
```

### 3. 서킷브레이커: 승인은 재시도하면 안 된다

국내 상위 PG사도 실제로 한 시간씩 장애가 난다. 그때 우리 서버가 모든 요청을 10초씩 기다리면? 스레드가 고갈되고, PG 장애가 우리 전체 장애로 번진다.

그래서 Resilience4j 서킷브레이커로 PG 호출을 감쌌다. 실패율이 임계치를 넘으면 회로가 **OPEN**되고, 그 뒤엔 PG를 아예 호출하지 않고 즉시 폴백한다.

그런데 결제 도메인만의 함정이 있다. 보통 "장애엔 재시도"가 정석인데,

> 승인(approve)은 재시도하면 안 된다. 멱등키 없이 승인을 재시도하면, 첫 요청이 사실 성공했을 경우 이중결제가 난다. 재시도가 오히려 사고를 만든다.

그래서 이렇게 나눴다.

| PG 호출 | 재시도 | 이유 |
|---|---|---|
| **승인 (approve)** | 안 함 | 멱등키 없는 재시도 = 이중결제. 실패/서킷오픈 시 UNKNOWN으로 돌려 복구 배치에 맡김 |
| **조회 (query)** | 함 (지수 백오프+지터) | 읽기라 몇 번을 불러도 안전 |
| **취소 (cancel)** | 안 함 (서킷만) | 호출부가 실패를 처리 |

```java
public PgApproveResult approve(PgApproveCommand command) {
    try {
        return circuitBreaker.executeSupplier(() -> delegate.approve(command));
    } catch (CallNotPermittedException open) {
        return PgApproveResult.timeout("서킷 오픈: PG 장애로 승인 미확정");  // 재시도 아님 — UNKNOWN
    } catch (RuntimeException ex) {
        return PgApproveResult.timeout("PG 오류로 승인 미확정: " + ex.getMessage());
    }
}
```

승인 예외를 `TIMEOUT`(=UNKNOWN)으로 돌리는 게 핵심이다. PG가 예외를 던져도 실제로 처리됐을 수 있으니 실패로 단정하지 않고, 앞의 복구 배치로 흘려보낸다. 실패 처리의 모든 길이 UNKNOWN → 복구로 모이게 설계했다.

이것도 테스트로 박았다.

```java
@Test
@DisplayName("승인은 재시도하지 않는다 — 멱등키 없는 재시도는 이중결제 위험")
void approveIsNotRetried() {
    flaky.approveError = new RuntimeException("PG 오류");
    client.approve(new PgApproveCommand("pk", "order-1", 10_000));
    assertThat(flaky.approveCalls.get()).isEqualTo(1);   // 딱 한 번
}
```

### 4. 다층 방어로 겹쳐 보면

이번에 만든 걸 겹쳐 보면 실패 처리가 여러 겹이다.

```
1차  멱등키 + 유니크 제약     중복(따닥)을 아예 차단
2차  3-상태 모델 + UNKNOWN    타임아웃을 실패로 단정하지 않고 보존
3차  서킷브레이커             PG 장애 전파 차단
4차  복구 배치               미확정을 조회로 확정 / 망취소
```

모든 실패 경로가 한 곳(UNKNOWN → 복구)으로 수렴하게 만든 게 이번 설계의 핵심이다. 타임아웃이든 PG 예외든 서킷 오픈이든 전부 "미확정"으로 보존됐다가 복구 배치가 조회로 확정한다. 실패의 종류마다 다른 특수 처리를 흩뿌리지 않았다.

지금까지 테스트 53개, 전부 통과. 아직 실제 PG(토스페이먼츠) 대신 상태 기반 FakePgClient로 이 모든 시나리오를 재현하고 있다. 덕분에 네트워크·키 없이도 타임아웃·장애·복구를 결정적으로 테스트할 수 있다.

---

## 멀티 PG 라우팅: 아무 때나 failover하면 안 된다


### 0. PG 하나에 매출을 걸지 않는다

확장의 첫 대상은 PG 자체의 이중화다. 국내 상위 PG사도 실제로 한 시간씩 장애가 난다. 단일 PG만 연동했으면 그 한 시간 동안 **매출이 통째로 멈춘다.** 그래서 여러 PG를 두고, 하나가 죽으면 다른 PG로 넘기는(failover) 게 필요하다.

결제 코어 편에서 PG를 `PgClient`로 추상화하고 서킷브레이커를 붙여둔 덕에, 이건 그 위에 라우터 하나를 얹는 일이다.

```java
RoutingPgClient(List.of(
    PgRoute.of("TOSS", tossAdapter, 10),   // 가중치 높은 PG 먼저
    PgRoute.of("NICE", niceAdapter, 5)));
```

가중치로 우선순위를 준다. 수수료 낮은 PG를 높게 두면 비용 최적화도 된다. 각 PG는 **자체 서킷브레이커**로 보호돼서, 계속 실패하는 PG는 아예 건너뛴다.

### 1. 진짜 어려운 건 "언제 failover하면 안 되는가"

여기가 이 기능의 핵심이다. "장애면 다음 PG로"는 쉽다. 문제는 **아무 때나 넘기면 사고가 난다**는 것. 결과를 네 가지로 나눠서 각각 다르게 처리한다.

```java
try {
    PgApproveResult result = route.circuitBreaker()
            .executeSupplier(() -> route.adapter().approve(command));
    return result;   // ← SUCCESS/FAILED/TIMEOUT 모두 여기서 반환 (failover 안 함)
} catch (RuntimeException e) {
    // PG가 요청을 아예 못 받음(연결 실패/서킷 오픈) → 다음 PG로 failover
}
```

| PG 응답 | failover | 왜 |
|---|---|---|
| **SUCCESS** | 넘기지 않음 | 됐으니까 |
| **FAILED** (카드 거절) | 넘기지 않음 | **다른 PG도 거절한다.** 잔액 부족은 어느 PG로 가도 부족하다 |
| **TIMEOUT** (미확정) | **절대 넘기지 않음** | **이중결제 위험.** 원 PG에서 이미 처리됐을 수 있는데 다른 PG로 또 쏘면 두 번 결제된다 |
| **예외 / 서킷 오픈** | 다음 PG로 넘김 | PG가 **요청을 아예 못 받았다.** 안전하게 다른 PG로 |

> 앞서 다룬 "타임아웃은 실패가 아니다"와 같은 논리다. 타임아웃은 "PG가 처리했는지 모르는" 상태라, 다른 PG로 재시도하는 순간 이중결제 리스크가 생긴다. 그래서 failover는 **"PG가 요청을 못 받은 게 확실할 때"**(연결 실패·서킷 오픈)만 한다. 모든 PG가 안 되면? UNKNOWN으로 돌려서 복구 배치에 맡긴다.

### 2. 테스트로 못 박기

failover 규칙을 시나리오별로 테스트했다. 특히 "failover하면 안 되는" 케이스를 집중적으로.

```java
@Test
@DisplayName("타임아웃(미확정)은 failover하지 않는다 — 이중결제 방지")
void noFailoverOnTimeout() {
    StubPg toss = new StubPg("TOSS").returns(PgApproveResult.timeout("응답 없음"));
    StubPg nice = new StubPg("NICE").returns(PgApproveResult.success("CARD"));
    RoutingPgClient router = new RoutingPgClient(List.of(
        PgRoute.of("TOSS", toss, 10), PgRoute.of("NICE", nice, 5)));

    PgApproveResult r = router.approve(cmd);

    assertThat(r.outcome()).isEqualTo(PgOutcome.TIMEOUT);
    assertThat(nice.approveCalls.get()).isZero();   // NICE로 안 넘어감
}
```

- 주 PG 성공 → 그것만 씀 (보조 PG 호출 0)
- 주 PG **장애(예외)** → 보조 PG로 failover → 성공
- 주 PG **카드 거절** → 그대로 반환, failover 안 함
- 주 PG **타임아웃** → 그대로 반환, failover 안 함 (이중결제 방지)
- 모든 PG 장애 → UNKNOWN
- 주 PG **서킷 오픈** → 건너뛰고 보조 PG

### 3. 개선의 교훈

포트원 같은 결제 대행사도 멀티 PG를 세일즈 포인트로 삼는데("장애 대응 1시간 → 10초"), 보통은 **콘솔 수동 전환**이다. 여기서는 **자동** failover를 만들었고, "언제 failover하면 안 되는지"를 분명히 했다.

> "PG 장애 나면요?"에 "다른 PG로 넘겨요"는 절반의 답이다. 나머지 절반이 **"단, 타임아웃과 카드 거절엔 안 넘긴다. 이중결제와 무의미한 재시도니까"**다. 이 구분이 결제를 아는 사람과 모르는 사람을 가른다.

---

*확장 기능은 기존 기반(PgClient 추상화·서킷브레이커) 위에 얹는 형태로, 각 규칙을 테스트로 고정하며 만든다.*

---

## 남는 생각

이 셋이 뒤에 나오는 모든 것을 지탱했다. **신뢰 경계**는 매 API 마다 다시 물었고, **타임아웃을 실패로 안 본 것**은 복구 배치·대사·미확정 나이 지표로 이어졌고, **failover 조건을 좁힌 것**은 "재시도해도 되는 실패"를 가르는 기준이 됐다(2편).

만들 때는 몰랐는데, 되돌아보니 **초반에 정한 것만큼만 뒤에서 할 수 있었다.**

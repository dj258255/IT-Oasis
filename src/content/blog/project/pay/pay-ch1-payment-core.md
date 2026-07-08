---
title: '결제 코어와 실패 설계'
description: 결제 시스템을 밑바닥부터: PG 연동·결제 코어·실패(타임아웃) 설계·웹훅/아웃박스·원장/정산/대사·재고 락 비교·운영·실기동까지.
date: 2026-07-05T00:00:00.000Z
tags:
  - Payment
  - Spring Boot
  - Spring Modulith
  - 결제 시스템
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 1
---

*결제 시스템 시리즈 — 결제 코어와 실패 설계. (원 연재 여러 편을 한 챕터로 묶었습니다. 각 절이 원래 한 편입니다.)*

## PG 연동은 흔하다 — 그래서 "결제가 실패했을 때"를 만든다

*결제 도메인 취업을 목표로 실전 결제 시스템을 밑바닥부터 만드는 시리즈. 이 글은 0편 — 왜 만드는지, 그리고 아키텍처를 왜 Spring Modulith로 잡았는지.*

### 0. 들어가며

결제 시스템으로 포트폴리오를 만들기로 했어요. 그런데 시작하기 전에 조사부터 했습니다 — **결제 회사들이 실제로 뭘 원하는지**, 그리고 **이미 나와 있는 결제 포트폴리오는 어떤 모습인지**.

결과는 좀 뼈아팠어요. velog·티스토리에 "아임포트/포트원/토스페이먼츠 연동해서 결제하기" 글은 **수십 개**가 있어요. 결제창 띄우고, 승인 API 부르고, 취소 CRUD 만들면 끝. 이건 튜토리얼을 따라 한 거지 차별화가 아니에요. 채용하는 쪽도 그걸 압니다.

그럼 뭘 만들어야 하나. 결제 공고 15곳(토스페이먼츠·카카오페이·네이버페이·교보문고·PG 3사·배민·무신사…)과 카카오페이·토스·우아한형제들 기술블로그를 뒤졌어요. 반복되는 게 보이더라고요.

> 어필이 극대화되는 지점은 전부 **"PG가 책임지지 않는 영역"**이었어요 — 실패 처리, 상태 관리, 정산, 대사, 보상, 금액 배분, 규제 반영.

토스페이먼츠는 승인 API만 줘요. **타임아웃 나면 어떻게 할지, 중복결제를 어떻게 막을지, 서버가 죽었다 살아나면 미확정 결제를 어떻게 정리할지, PG 정산 파일이 내 기록과 안 맞으면 어떻게 할지** — 이건 전부 만드는 사람 몫이에요. 흔한 포트폴리오는 PG가 해주는 부분(연동)만 하고 끝나고, 진짜 도메인은 여기 빈 공간에 있어요.

### 1. 그래서 "실패부터" 만든다

조사에서 뽑은 차별화 축은 5개였어요. 그리고 이게 **결제 면접 단골 질문과 정확히 겹쳐요.**

| # | 만들 것 | 대응하는 면접 질문 |
|---|---|---|
| 1 | 실패 설계 — 멱등키 + 상태머신 + 보상 트랜잭션(망취소) | "PG 승인 후 DB 롤백되면?", "타임아웃 시 중복 환불 어떻게 막나?" |
| 2 | 보안 검증 — 웹훅 서명, 금액 위변조 검증 | "클라이언트가 금액을 조작하면?" |
| 3 | 정산 + 대사 — Spring Batch 정산, 복식부기 원장 | "내 기록과 PG 기록이 다르면?" |
| 4 | 수치 있는 성능 개선 — 부하테스트 리포트 | "동시에 1000명이 결제하면?" |
| 5 | 문서화 — ADR, 트러블슈팅, 장애 재현 실험 | (이력서·포트폴리오 서류 통과 그 자체) |

그래서 이 시리즈의 방향은 명확해요. **"결제 성공"은 1편이면 끝나고, 진짜 알맹이는 "결제가 실패했을 때"부터예요.** 타임아웃을 성공도 실패도 아닌 `UNKNOWN` 상태로 모델링하고, 망취소를 배치로 돌리고, 원장으로 정합성을 수학적으로 증명하는 것.

### 2. 아키텍처: 왜 Spring Modulith인가

첫 결정은 아키텍처였어요. 후보는 셋.

- **물리적 MSA**: 공고가 MSA를 원하니까. 근데 1인 포트폴리오에서 서비스별 배포·DB·네트워크를 처음부터 깔면, 분산 트랜잭션·네트워크 장애 같은 **본질이 아닌 인프라 복잡도**에 시간을 다 써요. 정작 보여줘야 할 도메인 설계가 묻히죠.
- **단일 패키지 모놀리스**: 편하지만 경계가 흐려져서 "결제와 정산이 서로 내부를 직접 호출하는" 스파게티가 돼요.
- **Spring Modulith (모듈형 모놀리스)**: 그 사이.

Modulith를 골랐어요. 이유는 **경계는 지키되 인프라는 단순하게** 가져갈 수 있어서예요.

`com.beomsu.pay` 바로 아래 각 패키지가 하나의 모듈이에요.

```
com.beomsu.pay
├── order          주문 상태머신, 금액 위변조 기준값
├── payment        승인/취소/멱등/상태머신/PG연동  ← 시스템의 심장
├── ledger         복식부기 원장
├── settlement     Spring Batch 정산
├── reconciliation 대사 (최종 방어선)
└── shared         Money 등 공유 값 타입 (OPEN 모듈)
```

핵심은 **모듈끼리 직접 호출하지 않고 도메인 이벤트로만 소통한다**는 거예요. 그리고 이 규칙을 말로만 지키는 게 아니라 `package-info.java`에 허용 의존을 선언하고, 테스트가 위반을 잡으면 **빌드를 깨뜨려요.**

```java
@org.springframework.modulith.ApplicationModule(
        allowedDependencies = { "shared" }   // payment는 shared만 의존 가능
)
package com.beomsu.pay.payment;
```

```java
class ModularityTests {
    static final ApplicationModules modules = ApplicationModules.of(PayApplication.class);

    @Test
    void verifiesModularStructure() {
        modules.verify();   // 순환 의존·불법 접근·내부 침투를 정적으로 검사
    }
}
```

이제 누가 실수로 `payment`에서 `settlement`의 내부 클래스를 가져다 쓰면 **테스트가 빨개져요.** 아키텍처 규칙이 문서가 아니라 코드가 되는 거죠.

### 3. 킬러 디테일: 이벤트 레지스트리가 곧 Outbox다

Modulith를 고른 진짜 이유는 따로 있어요.

결제 완료 이벤트를 원장·정산으로 보낼 때 고전적인 문제가 있어요 — **dual write.** "DB 커밋"과 "이벤트 발행"을 둘 다 성공시켜야 하는데, 순진하게 나눠 쓰면:

- DB 커밋 후 발행 실패 → **이벤트 유실** (결제는 됐는데 원장에 안 남음)
- 발행 후 DB 롤백 → **유령 이벤트** (원장엔 있는데 결제가 없음)

정석 해법이 **Transactional Outbox**예요. 도메인 변경과 이벤트를 하나의 트랜잭션으로 저장하고, 릴레이가 나중에 발행. 보통 이걸 직접 구현하는데 — 폴링 릴레이, 중복 발행 처리, 재시도… 버그 온상이에요.

그런데 **Spring Modulith의 Event Publication Registry가 정확히 이 Outbox예요.**

모듈이 이벤트를 발행하면 Modulith가 **같은 트랜잭션에서 `event_publication` 테이블에 INSERT**하고, 커밋 후 리스너를 호출해요. 리스너가 실패하거나 앱이 죽으면 미완료 이벤트가 테이블에 남고, 재기동 때 재발행되죠.

> 즉 내가 직접 짜려던 `outbox_events` 테이블을, 프레임워크가 검증된 형태로 공짜로 주는 거예요. 대신 원리는 이해하고 있어야 하고(면접에서 "왜 직접 안 짰나"를 물으니까), 그건 [설계 문서](/blog/project/pay)에 따로 정리해뒀어요.

이게 [ADR-002](/blog/project/pay)로 남긴 결정이에요. Outbox는 at-least-once라서, 받는 쪽은 **멱등 컨슈머**로 설계해야 한다는 것까지가 한 세트고요.

### 4. Phase 0에서 실제로 만든 것

말만 하면 안 되니까, 오늘 뼈대를 깔고 빌드를 통과시켰어요.

- **Java 21 + Spring Boot 3.4 + Spring Modulith 1.3**
- 6개 모듈 + 경계 검증 테스트 (`modules.verify()` 통과)
- `Money` 값 객체 — KRW는 `long`(원)으로, 부동소수점 안 쓰고, 음수 금지, 차감 결과가 음수면 예외. 잔액 부족·과다 취소를 **값 타입 수준에서** 막아요.
- MySQL + Redis를 Docker Compose로, Testcontainers로 통합 테스트 기반
- `open-in-view: false` — OSIV 꺼서 긴 트랜잭션/커넥션 점유를 처음부터 차단 (카카오페이 성능 개선기의 교훈을 기본값으로)
- ADR 2건, 모듈 다이어그램 자동 생성

작은 디테일 하나. 원장 테이블은 나중에 append-only(수정·삭제 금지)로 보호할 거라, JPA를 `ddl-auto: validate`로 뒀어요. 스키마는 마이그레이션으로 관리하고 JPA는 검증만 하게. 첫날부터 "실무처럼" 시작하려는 거예요.

### 5. 앞으로의 순서

```
Phase 0  뼈대            Modulith 6모듈 + 경계 검증        ← 오늘 여기
Phase 1  결제 코어        요청→인증→승인, 상태머신, 금액 검증
Phase 2  실패 설계 ★      멱등키, UNKNOWN 3-상태, 망취소, 서킷브레이커
Phase 3  웹훅+이벤트      서명 검증, Outbox→Kafka, 멱등 컨슈머, DLQ
Phase 4  정산+대사+원장 ★  복식부기, Spring Batch, 대사 4분류
Phase 5  성능 ★          부하테스트, 락 3종 비교, 목표→병목→개선 수치
Phase 6  운영            Grafana, 백오피스 어드민
```

이 시리즈는 **각 Phase가 끝날 때마다 여기 기록**하는 식으로 갈 거예요. 별표(★)가 차별화가 큰 구간이고요.

다음 편은 Phase 1 — 결제 코어. 토스페이먼츠 승인 플로우를 붙이면서, "요청과 승인을 왜 분리하는가"와 "금액 위변조를 어디서 막는가"부터 시작할게요.

---

*이 글은 작성 중인 시리즈의 일부예요. 설계 문서 전문(채용공고 분석, ERD, API 스펙, 장애 시나리오)은 별도 저장소에 정리돼 있고, 진행하며 이 시리즈로 풀어냅니다.*

<hr />

## 결제 코어를 만들며 배운 것 — "검증"보다 "무엇을 신뢰하는가"가 먼저다

*결제 도메인 취업을 목표로 실전 결제 시스템을 밑바닥부터 만드는 시리즈. 이 글은 1편 — 주문·결제 코어를 만들며 상태머신·금액 검증·신뢰 경계를 배운 이야기.*

### 0. 이번에 만든 것

[0편](/blog/project/pay/pay-ch1-payment-core)에서 아키텍처를 Spring Modulith로 잡았어요. 이번 Phase 1에서는 실제 도메인을 채웠습니다 — **order(주문)**와 **payment(결제)** 두 모듈.

- 결제 **상태머신**: `READY → IN_PROGRESS → DONE / UNKNOWN / ABORTED / CANCELED ...`, 허용된 전이만 코드로 강제
- **요청·승인 분리**와 **금액 위변조 검증**
- 승인 결과의 **3-상태 분기** (성공 / 미확정 / 거절)
- 모듈 간 **이벤트 기반 통신**과 경계 검증
- 단위 테스트 41개, 모두 통과

그런데 이번 편의 진짜 이야기는 마지막에 있어요. **커밋 보안 검토가 내 결제 시스템의 심장을 찔렀거든요.** 거기부터 거꾸로 풀어볼게요.

### 1. 상태머신: `UNKNOWN`을 1급 시민으로

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

### 2. 요청·승인은 왜 나누나

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

### 3. 보안 검토가 찌른 곳 — 검증의 기준값이 오염돼 있었다

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

### 4. 고친 방법 — 신뢰 경계를 다시 긋다

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

### 5. 이번 편에서 진짜 남은 것

기능 목록보다 이 교훈이 더 커요.

> **결제 시스템에서 "무엇을 신뢰하는가"를 정하는 건, 검증 로직을 짜는 것보다 먼저다.**

금액, 상품 가격, 재고 — 이런 "돈이 걸린 값"의 **원천(source of truth)이 서버인지 클라이언트인지**를 먼저 못 박아야 해요. 그게 틀리면, 그 위에 아무리 검증을 쌓아도 극장일 뿐이에요. 재밌게도 이건 면접에서 강한 이야기예요 — "금액 검증 어떻게 했나요?"에 "검증 이전에 신뢰 경계부터 봤고, 실제로 그걸 놓쳤다가 잡은 경험이 있다"고 답할 수 있으니까요.

### 6. 모듈 경계는 어떻게 지켰나

order는 payment를 호출하지만(승인 위임), 반대로 payment는 order를 몰라요. 그리고 이 규칙은 말이 아니라 **테스트로 강제**돼요.

```java
// order/package-info.java
@ApplicationModule(allowedDependencies = { "shared", "payment" })
package com.beomsu.pay.order;
```

payment가 실수로 order를 참조하거나, 둘이 순환 의존을 만들면 `ModularityTests.verify()`가 **빌드를 깨뜨려요.** 결제 완료 같은 사건은 payment가 이벤트로 발행하고(Phase 3에서 원장·정산이 구독), 이 이벤트 발행은 [0편에서 말한](/blog/project/pay/pay-ch1-payment-core) Modulith의 이벤트 레지스트리(=Outbox)로 신뢰성이 보장돼요.

### 다음 — Phase 2: 미확정을 확정하다

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

<hr />

## 결제가 실패했을 때 — 타임아웃은 실패가 아니다

*결제 도메인 취업을 목표로 실전 결제 시스템을 밑바닥부터 만드는 시리즈. 이 글은 2편 — 이 프로젝트의 진짜 알맹이, "결제가 실패했을 때"를 만든다.*

### 0. 여기가 이 시리즈의 이유다

[0편](/blog/project/pay/pay-ch1-payment-core)에서 말했어요 — PG 연동해서 "결제 성공"까지 가는 건 흔하고, 차별화는 **PG가 책임지지 않는 영역**에 있다고. 그게 바로 이번 Phase 2예요.

[1편](/blog/project/pay/pay-ch1-payment-core)에서 타임아웃을 `UNKNOWN` 상태로 **보존**만 했어요. 이번엔 그 미확정을 실제로 **확정**합니다. 세 가지를 만들었어요.

```
멱등키         "따닥" 중복결제 + 타임아웃 후 안전 재시도
UNKNOWN 복구    조회 API로 확정 / 안 되면 망취소
서킷브레이커     PG 장애가 우리 전체로 번지지 않게 (단, 승인은 재시도 금지)
```

### 1. 따닥 — 멱등키, 그리고 "INSERT가 곧 잠금"

사용자가 결제 버튼을 두 번 누르면(따닥), 승인 요청이 두 번 가요. 프론트에서 버튼 비활성화? 그건 UX일 뿐 방어가 아니에요. 진짜 방어는 서버에 있어야 해요.

멱등키를 이렇게 설계했어요. 같은 `Idempotency-Key`로 온 요청은 **딱 한 번만** 실제 실행되고, 재요청엔 **첫 응답을 그대로 재반환**해요.

핵심은 동시성 처리예요. 따닥은 거의 동시에 도착하는데, 어떻게 하나만 통과시킬까요? **DB 유니크 제약**이에요.

```java
// (멱등키 + 경로 + 메서드) 유니크
try {
    record = repository.saveAndFlush(IdempotencyRecord.start(key, path, method, requestHash));
} catch (DataIntegrityViolationException race) {
    // 다른 요청이 같은 순간 먼저 INSERT 함 → 그 결과로 판정
    return handleExisting(reload(key), requestHash, responseType);
}
```

> **INSERT에 성공했다는 것 자체가 "처리권을 획득했다"는 뜻이에요.** 동시에 온 두 요청 중 하나만 INSERT에 성공하고, 나머지는 유니크 위반으로 튕겨요. 그래서 **별도의 분산락이 필요 없어요.** DB가 이미 락 역할을 하니까요.

그리고 상태에 따라 응답을 나눠요 — 토스페이먼츠와 같은 시맨틱이에요.

| 상황 | 응답 |
|---|---|
| 처리 완료된 같은 키 | 저장된 **첫 응답 재반환** (재실행 없음) |
| 처리 중인 같은 키 | `409` — 잠시 후 같은 키로 재시도 |
| 같은 키인데 **본문이 다름** | `422` — 위험한 재사용 |
| 키 없음/형식 오류 | `400` |

"같은 키 다른 본문 = 422"가 중요해요. 멱등키는 "이 요청을 한 번만"이라는 약속인데, 본문이 다르면 약속이 깨진 거니까요.

### 2. 타임아웃은 실패가 아니다 — UNKNOWN을 확정하기

이게 이번 편에서 제일 하고 싶은 이야기예요.

PG 승인 API를 부르다 타임아웃이 나면, **결제가 된 건지 안 된 건지 우리는 몰라요.** 여기서 흔한 실수가 "타임아웃 = 실패"로 처리하는 거예요. 그러면 — 카드에서는 돈이 빠졌는데 우리는 실패로 알고 주문을 취소해버려요. 최악의 CS죠.

그래서 카카오페이의 3-상태 모델을 따랐어요 — **성공 / 실패 / Unknown.**

```java
return switch (result.outcome()) {
    case SUCCESS -> { payment.approve(...); /* 완료 이벤트 발행 */ }
    case FAILED  -> { payment.abort(...); }               // 명시적 거절만 실패
    case TIMEOUT -> { payment.markUnknown(reason); }      // 미확정 — 보존한다
};
```

그리고 **복구 배치**가 UNKNOWN을 확정해요. 주기적으로 UNKNOWN 결제를 스캔해서, **PG에 조회 API로 실제 상태를 물어봐요.**

```java
PgQueryResult pg = pgClient.query(payment.getPaymentKey());
switch (pg.status()) {
    case APPROVED  -> payment.confirmByRecovery(pg.method());  // 실제론 됐네 → 전진 복구(DONE)
    case NOT_FOUND -> payment.abortByRecovery("PG에 결제 없음"); // 진짜 안 됐네 → ABORTED
    case CANCELED  -> payment.networkCancel("이미 취소됨");      // 망취소
}
```

여기서 재밌는 선택이 있어요. PG에 조회했더니 **실제로는 승인돼 있으면**, 저는 취소하지 않고 **전진 복구**(주문을 완료)를 택했어요. 사용자가 결제하려던 거였으니 완성시켜주는 게 맞죠. 반대 정책(타임아웃이면 무조건 취소 = 망취소)도 유효하고, 그래서 `networkCancel`도 만들어 뒀어요. 둘 다 상태머신에 허용 전이로 넣었고요 (`UNKNOWN → DONE`, `UNKNOWN → CANCELED`).

> 그리고 복구 배치는 **건별로 실패를 격리**해요. 한 결제 복구가 터져도 배치 전체가 멈추지 않고, 다음 주기에 다시 시도돼요. 이런 결제는 **결코 조용히 사라지면 안 되니까요.**

이걸 테스트로 못 박았어요 — FakePgClient를 상태 기반으로 만들어서 "우리는 타임아웃이었지만 PG엔 승인으로 남은" 상황을 재현했죠.

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

### 3. 서킷브레이커 — 그런데 승인은 재시도하면 안 된다

국내 상위 PG사도 실제로 한 시간씩 장애가 나요. 그때 우리 서버가 모든 요청을 10초씩 기다리면? **스레드가 고갈되고, PG 장애가 우리 전체 장애로 번져요.**

그래서 Resilience4j 서킷브레이커로 PG 호출을 감쌌어요. 실패율이 임계치를 넘으면 회로가 **OPEN**되고, 그 뒤엔 PG를 아예 호출하지 않고 즉시 폴백해요.

그런데 여기서 **결제 도메인만의 함정**이 있어요. 보통 "장애엔 재시도"가 정석인데 —

> **승인(approve)은 재시도하면 안 돼요.** 멱등키 없이 승인을 재시도하면, 첫 요청이 사실 성공했을 경우 **이중결제**가 나요. 재시도가 오히려 사고를 만드는 거죠.

그래서 이렇게 나눴어요.

| PG 호출 | 재시도 | 이유 |
|---|---|---|
| **승인 (approve)** | ❌ 안 함 | 멱등키 없는 재시도 = 이중결제. 실패/서킷오픈 시 **UNKNOWN**으로 돌려 복구 배치에 맡김 |
| **조회 (query)** | ✅ 지수 백오프+지터 | 읽기라 몇 번을 불러도 안전 |
| **취소 (cancel)** | ❌ (서킷만) | 호출부가 실패를 처리 |

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

승인 예외를 `TIMEOUT`(=UNKNOWN)으로 돌리는 게 핵심이에요. PG가 예외를 던져도 **실제로 처리됐을 수 있으니** 실패로 단정하지 않고, 2번의 복구 배치로 흘려보내요. 실패 처리의 모든 길이 결국 **UNKNOWN → 복구**로 모이게 설계한 거예요.

테스트로 이것도 박았어요.

```java
@Test
@DisplayName("승인은 재시도하지 않는다 — 멱등키 없는 재시도는 이중결제 위험")
void approveIsNotRetried() {
    flaky.approveError = new RuntimeException("PG 오류");
    client.approve(new PgApproveCommand("pk", "order-1", 10_000));
    assertThat(flaky.approveCalls.get()).isEqualTo(1);   // 딱 한 번
}
```

### 4. 다층 방어로 정리하면

이번 편에서 만든 걸 겹쳐 보면, 실패 처리가 여러 겹이에요.

```
1차  멱등키 + 유니크 제약     중복(따닥)을 아예 차단
2차  3-상태 모델 + UNKNOWN    타임아웃을 실패로 단정하지 않고 보존
3차  서킷브레이커             PG 장애 전파 차단
4차  복구 배치               미확정을 조회로 확정 / 망취소
```

그리고 이 모든 실패 경로가 **한 곳(UNKNOWN → 복구)으로 수렴**하게 만든 게 이번 설계의 핵심이에요. 타임아웃이든, PG 예외든, 서킷 오픈이든 — 전부 "미확정"으로 보존됐다가 복구 배치가 조회로 확정해요. 실패의 종류마다 다른 특수 처리를 흩뿌리는 대신에요.

지금까지 테스트 53개, 전부 통과. 아직 실제 PG(토스페이먼츠) 대신 상태 기반 FakePgClient로 이 모든 시나리오를 재현하고 있어요 — 덕분에 네트워크·키 없이도 타임아웃·장애·복구를 **결정적으로** 테스트할 수 있죠.

### 다음 — Phase 3: 웹훅과 이벤트

다음은 결제 완료를 다른 세계로 전파하는 편이에요.

```
웹훅 수신       서명 검증 + 멱등 처리 + "믿지 말고 조회로 재검증"
Outbox → Kafka  결제 이벤트를 유실 없이 발행 (Modulith 이벤트 레지스트리)
멱등 컨슈머      at-least-once를 안전하게 받기
DLQ            죽은 메시지 격리
```

"웹훅이 두 번 오면? 안 오면? 순서가 뒤집히면?" — 현직자가 제일 파고드는 지점이에요. 이어서 씁니다.

---

*이 글은 작성 중인 시리즈의 일부예요. 코드는 Spring Modulith 기반으로, 각 실패 시나리오를 테스트로 재현하며 진행합니다.*

<hr />

## 웹훅은 믿는 게 아니라 검증하는 것 — 그리고 이벤트를 잃지 않는 법

*결제 도메인 취업을 목표로 실전 결제 시스템을 밑바닥부터 만드는 시리즈. 이 글은 3편 — 웹훅 처리와 이벤트 유실 방지.*

### 0. 이번 편의 두 질문

Phase 3은 결제를 **바깥세상과 잇는** 편이에요. 두 방향이 있어요.

- **들어오는 것 — 웹훅**: PG가 "이 결제 상태가 바뀌었어요"라고 우리한테 알려주는 것
- **나가는 것 — 이벤트**: 결제가 완료됐을 때 원장·정산·알림 같은 다른 모듈에 전파하는 것

그리고 각각에 현직자가 꼭 물어보는 질문이 붙어요.

> 웹훅이 **두 번** 오면? **안** 오면? **순서가 뒤집혀** 오면?
> 결제는 됐는데 이벤트 발행이 실패해서 **원장에 안 남으면**?

### 1. 웹훅 — 페이로드를 믿지 마세요

가장 흔한 실수는 웹훅 페이로드를 **그대로 믿는** 거예요. "웹훅에 `status: DONE`이라고 왔으니 결제 완료 처리하자." 이게 위험해요.

- 웹훅은 **위조**될 수 있어요 (아무나 우리 웹훅 URL로 가짜 요청을 보낼 수 있죠)
- 웹훅은 **순서가 뒤집혀** 올 수 있어요 (나중 상태가 먼저 도착)
- 웹훅은 **중복**으로 와요 (PG가 재전송하니까 — 정상 동작이에요)

그래서 제가 세운 원칙은 하나예요.

> **웹훅은 "뭔가 바뀌었다"는 신호로만 쓰고, 실제 상태는 조회 API로 다시 물어본다.**

수신 파이프라인을 이렇게 짰어요.

```
[서명 검증] → [멱등 수신(중복이면 스킵)] → [원본 저장] → [빠른 200]
                                                    ↓ (그 다음)
                              [조회 API로 재검증 → 상태 확정]
```

#### 서명 검증 — HMAC, constant-time, tolerance

위조를 막으려면 서명을 검증해야 해요. (토스페이먼츠는 웹훅 서명 스펙이 없어서, 자체 Mock PG에 Stripe 방식을 구현했어요.)

```java
// signedPayload = timestamp + "." + rawBody
// HMAC-SHA256 으로 계산한 서명과 헤더의 서명을 비교
boolean valid = MessageDigest.isEqual(expected, provided);   // ← constant-time 비교
```

세 가지가 포인트예요.

- **`MessageDigest.isEqual` (constant-time 비교)**: 일반 `equals`는 앞부터 비교하다 틀리면 바로 끝나서, 응답 시간으로 서명을 한 글자씩 알아내는 **타이밍 공격**이 가능해요. 상수 시간 비교로 막아요.
- **timestamp를 서명에 포함**: 그래서 위조 불가.
- **tolerance 5분**: 오래된(가로챈) 요청을 재전송하는 **replay 공격**을 막아요.

#### 멱등 수신 — 두 번 와도 괜찮게

PG는 응답을 못 받으면 웹훅을 **최대 7회 재전송**해요(토스 기준 약 3일 19시간). 그러니 같은 이벤트가 여러 번 와요. `external_event_id`에 유니크 제약을 걸어서, 이미 받은 이벤트는 조용히 스킵해요.

```java
if (repository.findByExternalEventId(eventId).isPresent()) {
    return; // 중복 웹훅은 정상 — 그냥 넘어간다
}
```

#### 순서 역전 — 조회가 답이다

"순서가 뒤집히면?"의 답도 결국 같아요. 페이로드의 상태 대신 **조회 API로 최신 상태를 다시 읽으니까**, 웹훅이 어떤 순서로 오든 우리는 항상 "지금 PG의 진짜 상태"를 반영해요. 그리고 이 조회-확정 로직은 [Phase 2](/blog/project/pay/pay-ch1-payment-core)의 복구 배치와 **완전히 같은 코드**(`resolveByPaymentKey`)예요. 웹훅이든 배치든, 결국 "PG에 물어봐서 확정한다"는 하나의 길로 모여요.

마지막으로, 컨트롤러는 **항상 200을 반환**해요(서명 실패만 401). 파싱이 실패해도 저장은 됐으니 200을 주죠. 5xx를 주면 PG가 계속 재전송하며 우리를 두들기니까요.

### 2. 나가는 이벤트 — dual-write 문제

이제 반대 방향. 결제가 완료되면 원장에 기록하고, 정산에 반영하고, 알림을 보내야 해요. 이걸 이벤트로 전파하는데, 여기 함정이 있어요 — **dual-write.**

```
결제 DB 커밋  ─┐
              ├─ 둘 다 성공해야 하는데...
이벤트 발행    ─┘
```

- 커밋 후 발행이 실패하면 → **이벤트 유실** (결제는 됐는데 원장에 안 남음)
- 발행 후 커밋이 실패하면 → **유령 이벤트** (원장엔 있는데 결제가 없음)

정석 해법은 **Transactional Outbox**예요. 도메인 변경과 이벤트를 **한 트랜잭션**에 같이 저장하고, 릴레이가 나중에 발행. [0편에서 말했듯이](/blog/project/pay/pay-ch1-payment-core), **Spring Modulith의 이벤트 레지스트리가 바로 이 Outbox예요.**

`@ApplicationModuleListener`로 이벤트를 받으면, Modulith가 발행을 `event_publication` 테이블에 기록해요. 리스너가 성공하면 완료로 마킹하고, 실패하거나 앱이 죽으면 미완료로 남아 재시도되죠. 제가 직접 outbox 테이블과 폴링 릴레이를 짜는 대신, 검증된 구현을 쓰는 거예요.

```java
@Component
class PaymentConfirmedListener {
    @ApplicationModuleListener   // = 커밋 후 + 비동기 + 자체 트랜잭션 + Outbox 기록
    void on(PaymentConfirmedEvent event) {
        notificationService.handlePaymentConfirmed(event);
    }
}
```

### 3. at-least-once를 안전하게 받기 — 멱등 컨슈머 + DLQ

Outbox는 **at-least-once**예요. "적어도 한 번"은 보장하지만, 재시도 때문에 **두 번 이상** 올 수 있어요. 그래서 받는 쪽이 멱등해야 해요.

```java
public void handlePaymentConfirmed(PaymentConfirmedEvent event) {
    String eventKey = "payment-confirmed-" + event.paymentId();
    if (processedEvents.existsByEventKeyAndConsumer(eventKey, CONSUMER)) {
        return;   // 이미 처리함 — 중복 흡수
    }
    try {
        sender.sendPaymentReceipt(...);
        processedEvents.save(ProcessedEvent.of(eventKey, CONSUMER));
    } catch (RuntimeException ex) {
        deadLetters.save(DeadLetter.of("PaymentConfirmedEvent", eventKey, ex.getMessage()));
    }
}
```

두 가지 장치가 있어요.

- **멱등 컨슈머**: `(eventKey, consumer)` 유니크로 "이미 처리했나"를 판별. 같은 이벤트가 두 번 와도 한 번만 처리돼요.
- **DLQ(Dead Letter Queue)**: 처리가 실패하면 **예외를 밖으로 던지지 않고** 죽은 편지함에 격리해요. 왜냐면 리스너가 예외를 던지면 Modulith가 계속 재시도하는데, **포이즌 메시지**(항상 실패하는 이벤트)면 무한 재시도로 막혀버려요. 그래서 실패는 DLQ에 넣고 리스너는 정상 종료시켜, 나중에 배치/운영이 DLQ에서 재처리하게 해요.

> "Kafka는요?" 지금은 Modulith 이벤트 레지스트리를 Outbox 백본으로 써요. 외부 Kafka로 내보내는 건 `spring-modulith-events-kafka` 브릿지를 얹는 **설정 추가**예요 — 도메인 로직은 그대로고, 소비 측을 멱등하게 만들어 둔 게 이미 그 준비예요.

### 4. 정리

이번 편에서 만든 걸 두 방향으로 보면 —

| 방향 | 위협 | 방어 |
|---|---|---|
| 들어오는 웹훅 | 위조 | HMAC 서명 + constant-time + tolerance |
| | 중복 | external_event_id 유니크 |
| | 순서 역전 | 페이로드 대신 조회 API로 재검증 |
| | 유실 | 웹훅 + (Phase 2) 복구 배치 이중화 |
| 나가는 이벤트 | dual-write 유실 | Modulith 이벤트 레지스트리(Outbox) |
| | at-least-once 중복 | 멱등 컨슈머(processed_events) |
| | 포이즌 메시지 | DLQ 격리 |

테스트 64개, 전부 통과. 웹훅도 이벤트도 "실패와 중복이 당연히 일어난다"고 전제하고 설계한 거예요.

### 다음 — Phase 4: 정산·대사·원장 ★

다음이 이 시리즈에서 가장 희소한 편이에요.

```
복식부기 원장     차변 합계 = 대변 합계로 정합성을 수학적으로 증명
Spring Batch 정산  거래 집계 → 수수료 계산 → 지급금 생성
대사(reconciliation) PG 정산 파일 vs 내부 기록 4분류 — "결제의 최종 방어선"
```

취준생 포트폴리오에서 원장·대사까지 가는 경우는 거의 없어요. 이어서 씁니다.

---

*이 글은 작성 중인 시리즈의 일부예요. 실패·중복·순서역전을 각각 테스트로 재현하며 진행합니다.*

<hr />

## 원장·정산·대사 — 돈이 맞는지 수학으로 증명하기

*결제 도메인 취업을 목표로 실전 결제 시스템을 밑바닥부터 만드는 시리즈. 이 글은 4편 — 원장·정산·대사. 취준생 포트폴리오가 거의 안 가는 곳.*

### 0. 여기가 차별화의 끝판이다

[0편](/blog/project/pay/pay-ch1-payment-core)에서 조사한 결론 중 하나 — 결제 포트폴리오에서 **원장·대사까지 가는 경우는 거의 없어요.** PG 연동은 수십 개, 멱등성도 종종 있지만, 복식부기로 정합성을 증명하고 PG 파일과 대사하는 것까지 간 사례는 손에 꼽아요. 그래서 Phase 4가 이 시리즈에서 제일 희소한 편이에요.

세 가지를 만들었어요.

```
복식부기 원장     결제를 차변·대변으로 → "차변 합계 = 대변 합계"로 정합성 증명
정산 배치         하루치 거래 집계 → 수수료 → 지급금
대사             PG 파일 vs 내부 기록 4분류 — 결제의 최종 방어선
```

### 1. 복식부기 원장 — 불균형은 "만들어질 수 없다"

금융 시스템은 잔액을 그냥 숫자로 덮어쓰지 않아요. **모든 자금 이동을 차변(debit)과 대변(credit) 두 줄로 기록**하고, 이 둘의 합계가 항상 같아야 해요. 이게 복식부기예요. (Stripe의 Ledger 시스템이 교과서고요.)

핵심은 **불균형한 거래를 애초에 만들 수 없게** 한 거예요.

```java
static LedgerTransaction of(String txType, ..., List<LedgerEntry> entries) {
    long debit  = entries.stream().filter(e -> e.direction() == DEBIT)...sum();
    long credit = entries.stream().filter(e -> e.direction() == CREDIT)...sum();
    if (debit != credit) {
        throw new IllegalStateException("차변 합계 ≠ 대변 합계: ...");  // ← 존재 불가
    }
    // ...
}
```

그래서 10,000원 결제는 이렇게 기록돼요.

| 계정 | 차변 | 대변 |
|---|---|---|
| PG 미수금 (자산) | 10,000 | |
| 매출 (수익) | | 10,000 |

> 여기서 얻는 게 뭐냐면 — **정합성을 눈이 아니라 수식으로 증명**할 수 있어요. 어딘가 돈이 새면 차변·대변 합계가 안 맞아요. "느낌상 맞는 것 같다"가 아니라, `imbalance() == 0`이라는 **수학적 사실**로 검증되는 거죠.

몇 가지 원칙을 더 박았어요.

- **금액은 항상 양수.** 부호는 방향(DEBIT/CREDIT)으로 표현해요. 음수를 허용하면 방향과 이중 표현이 돼서 버그가 숨어요.
- **append-only.** 취소는 원거래를 지우는 게 아니라 **반대 분개를 추가**해요 (매출 차변 / PG미수금 대변). 이력이 통째로 남죠.
- **멱등.** `(txType, sourceType, sourceId)` 유니크로, 같은 결제 이벤트가 두 번 와도 분개는 한 번만.

그리고 원장은 [Phase 3](/blog/project/pay/pay-ch1-payment-core)의 이벤트를 구독해요 — 결제 완료 이벤트가 오면 자동으로 분개가 쌓여요.

```java
@ApplicationModuleListener
void onConfirmed(PaymentConfirmedEvent event) {
    ledgerService.recordPaymentConfirmed(event);
}
```

### 2. 정산 — 하루치를 모아 수수료를 떼다

정산은 "구매자가 낸 돈에서 수수료를 빼고 판매자에게 줄 돈을 계산"하는 거예요. 결제 채용공고의 절반이 사실상 정산 얘기고, "**오차 없이** 계산"이 요구사항이에요.

결제 완료 이벤트가 올 때마다 정산 항목(`SettlementItem`)을 쌓아 두고, 배치가 하루치를 집계해요.

```java
public Settlement settle(LocalDate date) {
    if (settlementRepo.existsBySettlementDate(date)) return null;   // 재실행 멱등
    var items = itemRepo.findPending(date);
    long gross = items.stream().mapToLong(...).reduce(0, Math::addExact);
    long fee   = gross * 3 / 100;              // 수수료 3% (정수 내림)
    // Settlement(date, gross, fee, net = gross - fee) 저장 + 항목 SETTLED
}
```

여기서 실무 디테일 두 개.

- **배치 재실행 멱등성**: `settlement_date`에 유니크를 걸어서, 같은 날짜로 배치를 두 번 돌려도 정산이 두 번 만들어지지 않아요. 배치는 언제든 재실행될 수 있으니 이게 필수예요.
- **정수 연산**: KRW는 소수점이 없으니 `long`으로만 계산하고, `gross × 3 / 100`으로 내림 시점을 정확히 맞춰요. 부동소수점은 안 써요 — 0.1원의 오차도 정산에선 사고니까요.

(대용량이면 Spring Batch의 청크·커서·파티셔닝으로 확장해요. Phase 4는 서비스 루프로 원리를 먼저.)

### 3. 대사 — 결제의 최종 방어선

여기까지 잘 만들어도, **PG가 실제로 정산해준 내역과 내 기록이 다를 수 있어요.** 승인 → 매입 → 정산 입금이 며칠에 걸쳐 일어나고, 웹훅이 유실되거나 망취소가 실패하면 어긋나요. 그래서 대사(reconciliation)가 필요해요.

> 시스템 설계 책의 표현을 빌리면 — **"조정(대사)은 결제 시스템의 최종 방어선"**이에요.

PG 정산 파일(외부)과 내 기록(내부)을 `orderNo`로 맞춰서 4가지로 분류해요.

```java
// 내부 {A:1000, B:2000, C:3000}  vs  외부 {A:1000, B:2500, D:4000}
```

| 결과 | 뜻 | 처리 |
|---|---|---|
| **MATCHED** (A) | 양쪽 일치 | 자동 확정 |
| **AMOUNT_MISMATCH** (B) | 금액 다름 (2000 vs 2500) | 사람 확인 큐 |
| **INTERNAL_ONLY** (C) | 내부에만 있음 (PG 누락·매입 실패 의심) | 사람 확인 큐 |
| **EXTERNAL_ONLY** (D) | 외부에만 있음 (내부 유실·웹훅 누락 의심) | 사람 확인 큐 |

핵심은 매칭 엔진이 **결정적(deterministic)**이라는 거예요. 같은 입력이면 항상 같은 결과. 그래서 MATCHED(대부분)는 자동으로 확정(AUTO_RESOLVED)하고, 어긋난 것만 사람이 보는 큐(PENDING)로 보내요. "AI가 알아서 맞춰준다"가 아니라 "**결정적으로 맞추고, 못 맞춘 것만 사람**"이 정석이에요 (Modern Treasury의 대사 철학).

그리고 이걸 테스트로 못 박았어요 — 일부러 어긋난 데이터를 넣고 4분류가 정확히 나오는지.

```java
assertThat(byOrderNo("B").result()).isEqualTo(AMOUNT_MISMATCH);
assertThat(byOrderNo("C").result()).isEqualTo(INTERNAL_ONLY);
assertThat(byOrderNo("D").result()).isEqualTo(EXTERNAL_ONLY);
```

### 4. 정리 — 이제 돈의 흐름이 닫힌다

Phase 4로 결제의 자금 흐름이 한 바퀴 닫혔어요.

```
결제 승인 ──이벤트──> 원장(분개)  → 차변=대변으로 정합성 증명
          └─이벤트──> 정산 항목   → 하루치 집계 → 수수료 → 지급금
PG 정산 파일 ─────────> 대사       → 4분류 → 어긋난 것만 사람 확인
```

돈이 어디서 새면 — 원장의 불균형으로, 혹은 대사의 불일치로 **반드시 드러나요.** 조용히 사라지지 않아요. 이게 금융 시스템에서 "장애보다 정합성 깨짐이 더 무섭다"는 말에 대한 답이에요.

테스트 82개, 전부 통과. 여기까지가 결제 시스템의 **코어**예요 — 주문·결제·실패처리·이벤트·원장·정산·대사.

### 다음 — Phase 5·6: 성능과 운영

코어가 끝났으니, 남은 건 이걸 **빠르고 안전하게 운영**하는 거예요.

```
Phase 5  성능    재고 차감 락 3종 비교(수치로), k6 부하테스트, 목표→병목→개선
Phase 6  운영    Grafana 대시보드(결제 성공률·p99), 백오피스 어드민
```

"동시에 1000명이 결제하면?"에 수치로 답하는 편이에요. 이어서 씁니다.

---

*이 글은 작성 중인 시리즈의 일부예요. 원장 불균형·대사 불일치를 각각 테스트로 재현하며 진행합니다.*

<hr />

## 재고 차감 락 3종, 수치로 골랐다 — 조건부 UPDATE가 이겼다

*결제 도메인 취업을 목표로 실전 결제 시스템을 밑바닥부터 만드는 시리즈. 이 글은 5편 — 동시성 락을 수치로 고른 이야기.*

### 0. "동시에 1000명이 결제하면?"

결제·재고 도메인 면접의 단골 질문이에요. [Phase 4](/blog/project/pay/pay-ch1-payment-core)까지 코어를 다 만들었으니, 이제 이걸 **빠르고 안전하게** 만들 차례예요.

재고 차감은 동시 요청이 몰리는 지점이에요 — 선착순, 인기 상품. 여기서 뭐가 무서우냐면 **초과 판매(oversell)**예요. 재고 1개인데 두 명이 동시에 결제에 성공하면, 있지도 않은 물건을 판 거죠. 이걸 막는 방법이 여럿인데, 저는 **셋을 다 만들어서 수치로 골랐어요.**

### 1. 후보 3종

```java
// ① 비관적 락 — 행을 잠그고 차감
SELECT quantity FROM stock WHERE id = 1 FOR UPDATE;
UPDATE stock SET quantity = quantity - 1 WHERE id = 1;

// ② 낙관적 락 — version 비교, 충돌 시 재시도
UPDATE stock SET quantity = quantity - 1, version = version + 1
WHERE id = 1 AND version = :read_version;   // 0 rows면 재시도

// ③ 조건부 UPDATE — 락 없이 원자적
UPDATE stock SET quantity = quantity - 1 WHERE id = 1 AND quantity >= 1;
```

세 방식 모두 "재고가 음수가 되지 않는다"는 **안전성**은 지켜요. 차이는 **성능**과 경합 처리 방식이에요. 그래서 말로 고르지 않고 재봤어요.

### 2. 실제 스레드로 두들긴 실측

`StockLockComparisonTest`를 만들었어요. 재고 20개에 **스레드 30개가 동시에** 1개씩 차감을 시도해요. 모든 스레드가 같은 순간 출발하도록 `CountDownLatch`로 정렬하고요.

```java
CountDownLatch start = new CountDownLatch(1);
for (int i = 0; i < THREADS; i++) pool.submit(() -> {
    ready.countDown();
    start.await();                          // 다 같이 출발
    if (deduct.deductOne()) success.incrementAndGet();
    else failed.incrementAndGet();
});
start.countDown();                          // 땅!
```

그리고 세 가지를 단언해요 — **모든 전략 공통 안전 불변식**이에요.

- 초과판매 없음 (성공 ≤ 재고)
- 재고 음수 없음
- 일관성: 최종재고 = 재고 − 성공건수

결과예요.

| 전략 | 초과판매 | 완판 | 소요 |
|---|---|---|---|
| **조건부 UPDATE** | 0 | 20/20 | **8ms** |
| 낙관적 락 | 0 | 20/20 | 17ms |
| 비관적 락 | 0 | 20/20 | 32ms |

셋 다 초과판매 0, 정확히 20개 완판. **안전성은 모두 통과.** 그런데 속도가 갈렸어요 — **조건부 UPDATE(8ms) < 낙관적(17ms) < 비관적(32ms).**

### 3. 왜 이 순서인가

- **조건부 UPDATE가 최속**이에요. 락도 재시도도 없이 **DB 한 번의 원자적 UPDATE**로 끝나요. `WHERE quantity >= 1` 조건이 차감과 검사를 한 문장에 묶어서, 경합이 있어도 DB가 알아서 직렬화해줘요.
- **비관적 락이 최저속**이에요. 행을 잠그고(SELECT FOR UPDATE), 트랜잭션을 왕복하고, 커넥션을 오래 점유해요. 안전하지만 무거워요.
- **낙관적 락은 중간**인데, 여기 **함정**이 있어요.

> 낙관적 락은 스레드를 150개로 올리면 **미달판매**가 나요. 재시도를 다 소진해서, 재고가 남았는데도 차감에 실패하는 거예요. 초과판매(위험)는 아니지만 손해죠. 그리고 재시도 폭증 자체가 부하예요. **인기 상품 재고처럼 한 행에 몰리는 hot row에는 낙관적 락이 부적합**하다는 게 수치로 드러나요.

### 4. 그래서 조건부 UPDATE를 배선했다

실험 결론을 코드에 반영했어요. `CheckoutService`가 승인 성공 시 조건부 UPDATE 전략을 써요.

```java
if (result.isApproved()) {
    for (OrderItem item : order.getItems()) {
        stockDeductionService.deductConditional(item.getProductId(), item.getQuantity());
    }
    order.markPaid();
}
```

그리고 이 선택을 [ADR-004](/blog/project/pay)로 남겼어요 — "왜 조건부 UPDATE인가"를 수치와 함께. 면접에서 "재고 동시성 어떻게 했나요?"에 **"세 개를 다 만들어 부하테스트로 비교했고, 단일 행 차감엔 조건부 UPDATE가 최속이라 그걸 골랐다"**고 답할 수 있는 거죠. 이게 "그냥 비관적 락 썼어요"보다 훨씬 강해요.

> 단, 멀티 인스턴스에서 DB 부하까지 분산해야 하면 Redis 분산락(Redisson)이 필요해요. 이 프로젝트는 단일 DB 기준이라 조건부 UPDATE가 정답이고, 분산락은 확장 과제로 남겼어요.

### 5. 그리고 엔드투엔드 부하테스트

락 비교가 "한 지점"의 미시 성능이라면, 전체 흐름은 **k6**로 재요. `k6/checkout-load.js`가 주문 생성 → 결제 승인을 실제 사용자 시나리오로 두들겨요. (FakePgClient가 승인을 성공 처리하니 실제 PG 키 없이 부하를 줄 수 있어요.)

```js
export const options = {
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<300', 'p(99)<800'],
  },
};
```

`thresholds`를 걸어서 p95>300ms거나 오류율 1%를 넘으면 k6가 **실패로 종료**해요 — PR마다 소규모 부하로 성능 회귀를 커밋 단위로 잡는 거죠. 개선 스토리는 카카오페이 프레임(목표→한계→병목→개선→전후 수치)으로 [성능 문서](/blog/project/pay)에 정리했어요.

### 다음 — Phase 6: 운영

이제 마지막이에요. 만든 걸 **운영**하는 편.

```
관측성      결제 성공률·p99·서킷 상태를 Micrometer→Prometheus→Grafana로
백오피스     DLQ 재처리 같은 운영 도구
```

"결제는 만들고 나서가 진짜"라는 편이에요. 이어서 마무리합니다.

---

*이 글은 작성 중인 시리즈의 일부예요. 락 비교는 H2 인메모리로 결정적으로 실측했고, 전략 간 상대 우열은 실 DB에서도 동일하게 재현됩니다.*

<hr />

## 결제는 만들고 나서가 진짜 — 관측성과 백오피스로 마무리

*결제 도메인 취업을 목표로 실전 결제 시스템을 밑바닥부터 만드는 시리즈. 이 글은 마지막 6편 — 운영, 그리고 전체 회고.*

### 0. 만든 다음이 진짜다

[Phase 5](/blog/project/pay/pay-ch1-payment-core)까지 결제 코어와 성능을 다 잡았어요. 그런데 결제 시스템은 **배포하고 나서가 진짜**예요. 돌아가는 걸 보고, 문제를 잡고, 새는 걸 메우는 것. 마지막 편은 그 도구예요.

```
관측성      결제 성공률·p99·서킷 상태를 Micrometer → Prometheus → Grafana
백오피스     DLQ 재처리 같은 운영 도구
```

### 1. 관측성 — CPU가 아니라 결제 성공률을 본다

흔한 실수는 CPU·메모리 같은 인프라 지표만 보는 거예요. 결제 시스템에서 진짜 중요한 건 **비즈니스 SLO** — "결제가 잘 되고 있나?"예요.

그래서 승인 결과를 결과별로 계측했어요.

```java
meterRegistry.counter("payment.confirm", "outcome", result.outcome().name().toLowerCase())
        .increment();
```

이 한 줄로 `payment_confirm_total{outcome="success|failed|timeout"}` 메트릭이 쌓여요. 그러면 Grafana에서 **결제 성공률**을 이렇게 계산해요.

```promql
sum(rate(payment_confirm_total{outcome="success"}[5m]))
  / sum(rate(payment_confirm_total[5m]))
```

이걸 테스트로도 박았어요 — `SimpleMeterRegistry`로 카운터가 실제 증가하는지 검증해요.

```java
service.confirm("order-1", "pk-1", Money.of(10_000));
assertThat(meterRegistry.counter("payment.confirm", "outcome", "success").count()).isEqualTo(1.0);
```

Spring Boot Actuator + Micrometer가 나머지도 공짜로 줘요 — p99 레이턴시(`http_server_requests`), HikariCP 풀 사용률, **서킷브레이커 상태**(`resilience4j_circuitbreaker_state`). Grafana 대시보드의 핵심 패널로 묶었어요.

| 패널 | 왜 |
|---|---|
| 결제 성공률 (SLO) | 비즈니스 건강도 |
| p99 레이턴시 | tail latency = 다운스트림 스톨 신호 |
| HikariCP 풀 사용률 | 커넥션 고갈 조기 경보 |
| 서킷브레이커 상태 | PG 장애 감지 |
| UNKNOWN 결제 추이 | 복구 배치 부하 신호 |

`monitoring/`에 `prometheus.yml`과 `dashboard.json`을 아티팩트로 넣어서, 클론하면 바로 띄울 수 있게 했어요.

### 2. 백오피스 — DLQ를 되살리다

[Phase 3](/blog/project/pay/pay-ch1-payment-core)에서 알림 처리가 실패하면 DLQ(Dead Letter Queue)에 격리한다고 했죠. 그런데 격리만 하고 끝이면 반쪽이에요. **누군가 그걸 다시 처리해야** 해요. 그게 백오피스의 일이에요.

> "백오피스"는 결제 채용공고에 **직무명으로 실재**해요 (섹타나인 "PG 시스템 Backend 정산 및 백오피스", 나이스페이먼츠 "PG BO서비스 개발"). 대부분 포트폴리오가 happy path에서 끝나는데, 어드민은 "운영을 안다"는 가장 확실한 증거예요.

DLQ 재처리를 만들었어요. 알림 채널이 복구되면 운영자가 다시 시도해요.

```java
public boolean reprocess(Long deadLetterId) {
    DeadLetter dl = deadLetters.findById(deadLetterId).orElseThrow(...);
    try {
        sender.sendPaymentReceipt(dl.getOrderNo(), dl.getPaymentId(), dl.getAmount());
        processedEvents.save(ProcessedEvent.of(dl.getEventKey(), CONSUMER));  // 멱등 마킹
        deadLetters.delete(dl);                                               // DLQ에서 제거
        return true;
    } catch (RuntimeException ex) {
        dl.incrementRetry();       // 여전히 실패 — 재시도 횟수만 올리고 DLQ에 남긴다
        return false;
    }
}
```

성공하면 DLQ에서 빼고 처리 완료로 마킹하고, 또 실패하면 재시도 횟수만 올려 남겨요. `GET /api/v1/admin/dead-letters`로 목록을 보고, `POST .../{id}/reprocess`로 되살리는 거죠.

그리고 여기서 하나 놓쳤다가 잡은 게 있어요. **어드민 엔드포인트를 인증 없이 열어뒀던 거예요.** 자동 보안 검토가 바로 짚었어요 — "결제 데이터 조회와 상태 변경(재처리)을 아무나 호출할 수 있다"고. 코드 주석엔 "운영에선 인증 붙는다"고 미뤄뒀는데, 검토의 지적이 맞았어요 — **인가를 미래로 미루면 안 되죠.** 그래서 Spring Security로 `/api/v1/admin/**`에 `ROLE_ADMIN`을 요구하고, 재처리엔 호출자를 감사 로그로 남기게 했어요.

```java
.authorizeHttpRequests(auth -> auth
    .requestMatchers("/api/v1/admin/**").hasRole("ADMIN")   // 어드민만
    .requestMatchers("/actuator/**").hasRole("ADMIN")        // 메트릭도 보호
    .anyRequest().permitAll())                              // 결제 흐름·웹훅
```

그리고 이걸 `@WebMvcTest`로 못 박았어요 — 인증 없이 호출하면 401, ROLE_ADMIN이면 200. (운영에선 여기에 **maker-checker(2인 승인)**·감사 테이블이 더 붙어요.)

> 재밌는 게, 이것도 이 시리즈의 교훈이랑 똑같아요 — "happy path는 만들었는데 접근 제어를 미뤘다"가 바로 결제 시스템에서 사고 나는 지점이거든요. 자동 검토가 그걸 커밋 단계에서 잡아준 거죠.

### 3. 회고 — Phase 0부터 6까지 무엇을 증명했나

이걸로 로드맵을 다 돌았어요. 커밋 12개, 테스트 87개. 되돌아보면, 각 Phase가 결제 면접 질문 하나씩에 **코드로** 답해요.

| Phase | 만든 것 | 답하는 질문 |
|---|---|---|
| 0 | Spring Modulith 뼈대 | "MSA 경험은?" → 모듈 경계를 테스트로 강제 |
| 1 | 주문·결제 코어 | "금액 조작 막나요?" → 신뢰 경계부터 |
| 2 | 멱등키·UNKNOWN 복구·서킷 | "따닥은? 타임아웃은? PG 장애는?" |
| 3 | 웹훅·Outbox·DLQ | "웹훅 두 번 오면? 이벤트 유실은?" |
| 4 | 원장·정산·대사 | "돈이 맞는지 어떻게 아나요?" |
| 5 | 락 3종 비교 | "동시에 1000명이 결제하면?" → 수치로 |
| 6 | 관측성·백오피스 | "운영은 어떻게?" |

시리즈를 관통하는 한 문장을 고르라면 이거예요.

> **결제 시스템의 차별화는 "성공"이 아니라 "실패와 정합성"에 있다.**

PG 연동해서 결제 성공까지는 흔해요. 진짜는 타임아웃을 UNKNOWN으로 보존하고, 멱등키로 따닥을 막고, 복식부기로 정합성을 증명하고, 대사로 최후 방어선을 치고, 락을 수치로 고르는 것 — **PG가 책임지지 않는 영역**이에요. 그리고 그게 정확히 현직자가 파고드는 지점이고요.

### 남은 것 (정직하게)

포트폴리오로는 충분히 갖췄지만, 프로덕션까지 가려면 남은 게 있어요.

- **스키마 마이그레이션**: 원장을 append-only로 지키려고 `ddl-auto: validate`를 쓰는데, 실제 기동엔 Flyway 마이그레이션이 필요해요. (다음 작업)
- **실 PG 연동**: 지금은 상태 기반 FakePgClient로 모든 시나리오를 결정적으로 테스트해요. 토스페이먼츠 실 키 연동은 어댑터 하나 추가.
- **실 부하 수치**: 락 비교는 실측했고, 엔드투엔드 k6 스크립트는 준비됐어요. 앱을 띄우고 돌리면 TPS·p99가 나와요.
- **확장 기능**: 멀티 PG 라우팅·구독 결제·선불 월렛·FDS 등은 [설계 문서](/blog/project/pay)에 정리해뒀고, 기존 기반 위에 얹는 형태로 설계했어요.

여기까지, "결제가 실패했을 때"를 제대로 만드는 여정이었어요. 읽어주셔서 고맙습니다.

---

*이 시리즈는 Spring Modulith 기반으로, 각 실패 시나리오를 테스트로 재현하며 만들었어요. 코드는 87개 테스트로 검증돼 있습니다.*

<hr />

## 이제 진짜로 돌린다 — Flyway로 실기동, 그리고 라이브 검증

*결제 도메인 취업을 목표로 실전 결제 시스템을 밑바닥부터 만드는 시리즈. 이 글부터는 개선기예요. 1편 — 실제로 돌게 만들고 라이브로 검증하기.*

### 0. 테스트는 통과하는데, 앱이 안 뜬다

[본편](/blog/project/pay/pay-ch1-payment-core)을 마쳤을 때 테스트 87개가 다 통과했어요. 그런데 정작 `bootRun`으로 앱을 띄우면 — **안 떴어요.**

이유가 좀 아이러니해요. 원장을 append-only로 지키려고 `ddl-auto: validate`를 썼거든요. JPA가 스키마를 함부로 못 바꾸게, "검증만" 하게요. 그런데 **정작 스키마를 만드는 게 없었어요.** validate는 "테이블이 있는지 확인"만 하지 만들진 않으니까, 빈 DB에선 검증 실패로 부팅이 막혀요.

> 테스트는 H2 인메모리랑 Mockito로 도니까 이 구멍을 못 봤어요. "돌아가는 것처럼 보이는데 실제 기동은 안 되는" 상태였던 거죠. 이걸 메우는 게 이번 개선이에요.

### 1. Flyway — 스키마를 코드로 관리한다

해법은 **Flyway 마이그레이션**이에요. `ddl-auto: validate`는 그대로 두고(원장 보호), 스키마 생성은 Flyway가 버전 관리하는 SQL로 해요.

문제는 **정확한 DDL을 손으로 쓰기가 위험**하다는 거예요. 컬럼 하나, 타입 하나 어긋나면 validate가 부팅을 막아요. 그래서 Hibernate한테 시켰어요 — 엔티티에서 DDL을 **파일로 생성**하게요.

```bash
# 실행 안 하고 DDL만 파일로 뽑기
--spring.jpa.properties.jakarta.persistence.schema-generation.scripts.action=create
--spring.jpa.properties.jakarta.persistence.schema-generation.scripts.create-target=build/schema-create.sql
```

MySQL 방언으로 17개 테이블 DDL이 정확하게 나왔어요. 이걸 `V1__init.sql`로 고정하고, 못생긴 자동 생성 제약명만 정리하고, 배치 스캔용 인덱스와 개발용 시드(`V2__seed`)를 더했어요. Modulith의 이벤트 테이블(`event_publication`, = Outbox)도 여기 포함돼서 Flyway가 관리하게 했고요.

그리고 다시 띄웠더니 —

```
Flyway: Migrating schema `pay` to version "1 - init"
Flyway: Migrating schema `pay` to version "2 - seed dev data"
Flyway: Successfully applied 2 migrations
Tomcat started on port 8080
Started PayApplication in 6.525 seconds
```

**떴어요.** Flyway가 스키마를 만들고, JPA validate가 통과하고, 6.5초 만에 기동.

### 2. 라이브로 두들겨 보다

이제 진짜 MySQL 위에서 도는지 curl로 확인했어요. 지금까지 테스트로만 증명하던 것들이 **실제로** 되는지.

**① 서버 권위 가격 + 주문 생성**
```bash
$ curl -X POST /api/v1/orders -d '{"userId":1,"items":[{"productId":1,"quantity":2}]}'
{"orderNo":"01KWSH8JXGJHYKB2MQ35XCCFXQ","totalAmount":20000,...}
```
클라이언트는 `productId`랑 `quantity`만 보냈는데, 서버가 카탈로그에서 가격을 조회해 `totalAmount: 20000`(10,000×2)을 확정했어요. ULID 주문번호도 잘 나오고요.

**② 결제 승인**
```bash
$ curl -X POST /api/v1/payments/confirm -H 'Idempotency-Key: ...' \
    -d '{"paymentKey":"...","orderNo":"01KWSH...","amount":20000}'
{"orderStatus":"PAID","paymentStatus":"DONE","message":"승인 완료"} [200]
```

**③ 멱등키 재사용 (따닥)** — 같은 키로 두 번:
```
1차: {...DONE...} [200]
2차(같은 키): {...DONE...} [200]   ← 재실행 없이 첫 응답 재반환
```

**④ 금액 위변조 (1원으로 조작)**:
```bash
$ curl ... -d '{"orderNo":"01KWSH...","amount":1}'
{"code":"AMOUNT_MISMATCH","message":"...주문 10000, 요청 1"} [403]
```

**⑤ 어드민 인증**:
```
무인증 GET /api/v1/admin/dead-letters → 401
admin 인증 → 200
```

[Phase 1](/blog/project/pay/pay-ch1-payment-core)의 신뢰 경계, [Phase 2](/blog/project/pay/pay-ch1-payment-core)의 멱등키, [Phase 6](/blog/project/pay/pay-ch1-payment-core)의 접근 제어 — 전부 **실제로** 작동해요. 테스트가 거짓말을 안 했다는 거죠.

### 3. 그리고 진짜 부하 수치

앱이 뜨니까 드디어 [준비해뒀던 k6](/blog/project/pay/pay-ch1-payment-core)를 실제로 돌릴 수 있었어요. 주문 생성 → 결제 승인을 최대 **200 VU**로 2분간.

```
█ THRESHOLDS
  http_req_duration
    ✓ 'p(95)<300'  p(95)=96.16ms
    ✓ 'p(99)<800'  p(99)=131.75ms
  http_req_failed
    ✓ 'rate<0.01'  rate=0.00%

█ TOTAL RESULTS
  http_reqs .......: 21112   175.08/s
  http_req_failed .: 0.00%   0 out of 21112
  { name:confirm } : p(95)=111.08ms
```

**21,112 요청, 175 req/s, 오류율 0%, p95 96ms, p99 131ms.** 임계치 전부 통과. 이제 "동시에 많이 결제하면?"에 **실측 수치로** 답할 수 있어요. (로컬 단일 인스턴스 + FakePgClient 기준이라 절대치보단 "임계치를 지키며 견딘다"는 게 포인트예요. 실 PG를 붙이면 PG 레이턴시가 더해지죠 — 그건 다음 개선.)

### 4. 개선의 교훈

이번 건 기능 추가가 아니라 **"검증된 코드"와 "실제 기동" 사이의 구멍**을 메운 거예요.

> 테스트가 다 통과해도, 실제로 띄워보기 전엔 모르는 게 있어요. 이 프로젝트에선 그게 "스키마를 아무도 안 만든다"였죠. 그래서 **라이브 검증(curl + k6)**을 한 번은 꼭 거쳐야 해요 — 테스트 초록불과 실기동은 다른 문제니까요.

그리고 이게 실무에서도 똑같아요. `ddl-auto: validate` + Flyway는 "앱이 멋대로 스키마를 못 바꾸게" 하는 표준 조합이에요. 특히 원장처럼 **한 줄도 훼손되면 안 되는** 테이블이 있으면요.

### 다음 — 실 토스페이먼츠 어댑터

지금은 상태 기반 FakePgClient로 모든 걸 결정적으로 테스트해요. 다음 개선은 그 자리에 **진짜 토스페이먼츠 어댑터**를 끼우는 거예요 — 멱등키를 PG로 전달하고, 실패를 3-상태로 변환하고, 서킷브레이커로 감싸는. 기존 `PgClient` 인터페이스 덕에 **구현 하나만 추가**하면 돼요. 이어서 씁니다.

---

*이 글은 작성 중인 시리즈의 개선기예요. 라이브 검증 수치는 로컬 실기동에서 실제로 뽑은 값입니다.*

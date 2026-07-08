---
title: '결제수단 확장'
description: 실 토스페이먼츠 어댑터와 멀티 PG 라우팅, 복합결제·구독(dunning)·선불 월렛·가상계좌·이상거래탐지·필드 암호화·현금영수증까지 결제수단을 넓히다.
date: 2026-07-13T00:00:00.000Z
tags:
  - Payment
  - Spring Boot
  - Spring Modulith
  - 결제 시스템
category: project/pay
draft: false
series: "결제 시스템 만들기"
seriesOrder: 2
---

*결제 시스템 시리즈 — 결제수단 확장. (원 연재 여러 편을 한 챕터로 묶었습니다. 각 절이 원래 한 편입니다.)*

## 가짜를 진짜로 — 실 토스페이먼츠 어댑터, 구현 하나로 갈아끼우기

*결제 도메인 취업을 목표로 실전 결제 시스템을 밑바닥부터 만드는 시리즈. 개선기 2편 — 가짜 PG를 진짜로 갈아끼우기.*

### 0. 왜 지금까지 가짜였나

이 시리즈 내내 실제 토스페이먼츠 대신 **상태 기반 `FakePgClient`**로 테스트했어요. 이게 게으름이 아니라 **의도**였어요.

[Phase 2](/blog/project/pay/pay-ch1-payment-core)에서 만든 것들 — 타임아웃을 UNKNOWN으로 보존하고, 복구 배치가 조회로 확정하고, 서킷브레이커가 장애를 격리하는 것 — 이걸 실제 PG로 테스트하려면 **실제로 타임아웃을 일으키고 PG를 다운시켜야** 해요. 그건 불가능하죠. 그래서 FakePgClient를 상태 기반으로 만들어서 "우리는 타임아웃이었지만 PG엔 승인으로 남은" 상황까지 **결정적으로** 재현했어요.

덕분에 네트워크·키 없이 CI에서 모든 실패 시나리오가 초록불이에요. 이제 그 위에 진짜를 얹을 차례예요.

### 1. 추상화의 보상 — 구현 하나만 추가

[Phase 1](/blog/project/pay/pay-ch1-payment-core)에서 PG를 이렇게 추상화해뒀어요.

```java
public interface PgClient {
    PgApproveResult approve(PgApproveCommand command);
    PgCancelResult  cancel(String paymentKey, long cancelAmount, String reason);
    PgQueryResult   query(String paymentKey);
}
```

그래서 실 PG로 가는 건 **도메인 로직을 한 줄도 안 건드리고**, 이 인터페이스의 구현 하나(`TossPgClient`)를 추가하는 거예요. `PaymentService`도, 복구 배치도, 서킷브레이커도 그대로예요.

```java
@Component
@Qualifier("pgDelegate")
@Profile("prod")                    // 운영에서만 진짜, 개발/테스트는 Fake
public class TossPgClient implements PgClient {

    public TossPgClient(@Value("${payment.toss.base-url:...}") String baseUrl,
                        @Value("${payment.toss.secret-key:}") String secretKey) {
        String basic = Base64.getEncoder()
                .encodeToString((secretKey + ":").getBytes());   // 토스 Basic 인증
        this.restClient = RestClient.builder().baseUrl(baseUrl)
                .defaultHeader("Authorization", "Basic " + basic).build();
    }
    // approve / cancel / query ...
}
```

프로파일로 택일해요 — 개발·테스트는 `FakePgClient`, 운영은 `TossPgClient`. 둘 다 `@Qualifier("pgDelegate")`를 달아서, [서킷브레이커](/blog/project/pay/pay-ch1-payment-core)를 입히는 `ResilientPgClient`가 **활성 어댑터를 자동으로 감싸요.**

```java
@Autowired
public ResilientPgClient(@Qualifier("pgDelegate") PgClient delegate) {  // Fake 또는 Toss
    this.delegate = delegate;
    ...
}
```

이게 처음부터 어댑터로 분리해둔 값어치예요. "나중에 실 PG 붙이기"가 **리팩토링이 아니라 파일 추가**가 됐어요.

### 2. 여기서도 "예외를 실패로 단정하지 않는다"

실 PG 어댑터를 짜면서 제일 신경 쓴 건 [Phase 2의 원칙](/blog/project/pay/pay-ch1-payment-core) — **타임아웃·5xx를 실패로 단정하지 않는다** — 를 그대로 지키는 거였어요.

```java
public PgApproveResult approve(PgApproveCommand command) {
    try {
        TossPayment resp = restClient.post().uri("/v1/payments/confirm")
                .header("Idempotency-Key", command.orderNo())   // PG에 멱등키 전달
                .body(Map.of("paymentKey", ..., "orderId", ..., "amount", ...))
                .retrieve().body(TossPayment.class);
        return mapConfirm(resp);                    // DONE → SUCCESS
    } catch (HttpClientErrorException e) {
        return PgApproveResult.failed("PG 거절: " + e.getStatusCode());   // 4xx만 명시적 실패
    }
    // 5xx·네트워크 예외는 여기서 안 잡는다 → ResilientPgClient가 UNKNOWN으로 변환
}
```

핵심은 **무엇을 잡고 무엇을 던지느냐**예요.

- **4xx (카드 거절·한도 초과)** → `FAILED`. 재시도해도 소용없는 명시적 거절.
- **5xx·네트워크 예외** → **안 잡고 던진다.** `ResilientPgClient`가 이걸 `UNKNOWN`(TIMEOUT)으로 바꿔서, 복구 배치가 나중에 조회로 확정해요. PG에서 처리됐을 수도 있으니까요.

그리고 승인 때 **`Idempotency-Key`를 PG로 전달**해요. 우리가 [멱등키로 우리 서버를 지키듯이](/blog/project/pay/pay-ch1-payment-core), PG 호출도 멱등해야 타임아웃 후 안전하게 재조회할 수 있으니까요.

### 3. HTTP 없이 매핑을 테스트한다

실 HTTP 호출은 키·네트워크가 필요해 CI에서 못 돌려요. 그래서 **응답 매핑 로직만 순수 함수로 분리**해서 테스트했어요.

```java
static PgApproveResult mapConfirm(TossPayment resp) {
    return "DONE".equals(resp.status())
            ? PgApproveResult.success(resp.method()) : PgApproveResult.failed(...);
}
static PgPaymentStatus mapStatus(String tossStatus) {
    return switch (tossStatus) {
        case "DONE" -> APPROVED;
        case "CANCELED", "PARTIAL_CANCELED" -> CANCELED;
        default -> NOT_FOUND;   // READY/IN_PROGRESS/ABORTED 등
    };
}
```

```java
@Test
void queryStatusMapping() {
    assertThat(TossPgClient.mapStatus("DONE")).isEqualTo(APPROVED);
    assertThat(TossPgClient.mapStatus("CANCELED")).isEqualTo(CANCELED);
    assertThat(TossPgClient.mapStatus("IN_PROGRESS")).isEqualTo(NOT_FOUND);
}
```

HTTP 껍데기는 얇게, 도메인 매핑은 순수 함수로 — 그래야 "토스가 이 상태를 주면 우리는 이렇게 해석한다"가 테스트로 고정돼요. 실제 연동은 토스 샌드박스 키를 넣고 프로파일을 `prod`로 띄우면 돼요.

### 4. 개선의 교훈

이번 건 새 기능이 아니라 **경계를 잘 그어둔 것의 배당금**이에요.

> 처음에 `PgClient` 인터페이스로 PG를 밀어내 둔 덕에, 실 PG 연동이 "시스템을 뜯어고치기"가 아니라 "구현 하나 추가하기"가 됐어요. 그리고 Fake가 단순 스텁이 아니라 **상태 기반**이었던 덕에, 실 PG 없이도 실패·복구 시나리오를 다 검증해둘 수 있었고요.

면접식으로 말하면 — "실 PG 연동을 어떻게 하실 거예요?"에 **"이미 어댑터로 분리해놨고, Fake로 실패 시나리오까지 검증해뒀으니 구현체만 추가하면 됩니다"**라고 답할 수 있는 구조를 처음부터 만들어둔 거예요.

### 마치며

이걸로 이 시리즈의 개선기까지 왔어요. 되짚으면 —

```
본편  Phase 0~6   Modulith 뼈대 → 결제 코어 → 실패 설계 → 이벤트 → 원장·정산·대사 → 성능 → 운영
개선  1. Flyway로 실기동 + 라이브 검증 + k6 실수치
      2. 실 토스페이먼츠 어댑터
```

처음 [0편](/blog/project/pay/pay-ch1-payment-core)에서 세운 명제 그대로였어요 — **결제의 차별화는 "성공"이 아니라 "실패와 정합성"에 있다.** 그리고 그걸 코드로, 테스트로, 실측 수치로 증명하는 여정이었어요. 읽어주셔서 고맙습니다.

---

*이 시리즈는 Spring Modulith 기반, 실 MySQL에서 라이브 검증까지 마쳤어요. 실 PG 매핑은 순수 함수로 테스트되고, 연동은 토스 샌드박스 키로 활성화됩니다.*

<hr />

## 멀티 PG 라우팅 — 그런데 아무 때나 failover하면 안 된다

*결제 시스템 시리즈. 확장 기능 1편 — 멀티 PG 라우팅과 failover의 함정.*

### 0. PG 하나에 매출을 걸지 않는다

국내 상위 PG사도 실제로 한 시간씩 장애가 나요. 단일 PG만 연동했으면 그 한 시간 동안 **매출이 통째로 멈춰요.** 그래서 여러 PG를 두고, 하나가 죽으면 다른 PG로 넘기는(failover) 게 필요해요.

[Phase 2](/blog/project/pay/pay-ch1-payment-core)에서 PG를 `PgClient`로 추상화하고 서킷브레이커를 붙여둔 덕에, 이건 그 위에 라우터 하나를 얹는 일이에요.

```java
RoutingPgClient(List.of(
    PgRoute.of("TOSS", tossAdapter, 10),   // 가중치 높은 PG 먼저
    PgRoute.of("NICE", niceAdapter, 5)));
```

가중치로 우선순위를 줘요(수수료 낮은 PG를 높게 두면 비용 최적화도 되고요). 각 PG는 **자체 서킷브레이커**로 보호돼서, 계속 실패하는 PG는 아예 건너뛰어요.

### 1. 진짜 어려운 건 "언제 failover하면 안 되는가"

여기가 이 기능의 핵심이에요. "장애면 다음 PG로" 는 쉬운데, **아무 때나 넘기면 사고가 나요.** 결과를 네 가지로 나눠서 각각 다르게 처리해요.

```java
try {
    PgApproveResult result = route.circuitBreaker()
            .executeSupplier(() -> route.adapter().approve(command));
    return result;   // ← SUCCESS/FAILED/TIMEOUT 모두 여기서 반환 (failover 안 함)
} catch (RuntimeException e) {
    // PG가 요청을 아예 못 받음(연결 실패/서킷 오픈) → 다음 PG로 failover
}
```

| PG 응답 | failover? | 왜 |
|---|---|---|
| **SUCCESS** | ❌ | 됐으니까 |
| **FAILED** (카드 거절) | ❌ | **다른 PG도 거절해요.** 잔액 부족은 어느 PG로 가도 부족하죠 |
| **TIMEOUT** (미확정) | ❌ **절대** | **이중결제 위험.** 원 PG에서 이미 처리됐을 수 있는데 다른 PG로 또 쏘면 두 번 결제돼요 |
| **예외 / 서킷 오픈** | ✅ | PG가 **요청을 아예 못 받았어요.** 안전하게 다른 PG로 |

> 이게 [Phase 2의 "타임아웃은 실패가 아니다"](/blog/project/pay/pay-ch1-payment-core)와 정확히 같은 논리예요. 타임아웃은 "PG가 처리했는지 모르는" 상태라, 다른 PG로 재시도하는 순간 이중결제 리스크가 생겨요. 그래서 failover는 **"PG가 요청을 못 받은 게 확실할 때"**(연결 실패·서킷 오픈)만 해요. 모든 PG가 안 되면? UNKNOWN으로 돌려서 [복구 배치](/blog/project/pay/pay-ch1-payment-core)에 맡겨요.

### 2. 테스트로 못 박기

failover 규칙을 시나리오별로 테스트했어요. 특히 "failover하면 안 되는" 케이스를요.

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

포트원 같은 결제 대행사도 멀티 PG를 세일즈 포인트로 삼는데("장애 대응 1시간 → 10초"), 보통 **콘솔 수동 전환**이에요. 여기선 **자동** failover를 만들었고, 무엇보다 **"언제 failover하면 안 되는지"**를 명확히 했어요.

> "PG 장애 나면요?"에 "다른 PG로 넘겨요"는 절반의 답이에요. 나머지 절반이 **"단, 타임아웃과 카드 거절엔 안 넘겨요 — 이중결제와 무의미한 재시도니까"**예요. 이 구분이 결제를 아는 사람과 모르는 사람을 가르는 지점이에요.

### 다음 — 복합결제 (포인트 + 카드)

다음 확장은 포인트와 카드를 같이 쓰는 복합결제예요. 내부 포인트와 외부 카드를 한 결제에 묶을 때의 보상 트랜잭션, 그리고 부분취소 시 "포인트부터 환불하는 이유"까지. 이어서 씁니다.

---

*확장 기능도 기존 기반(PgClient 추상화·서킷브레이커) 위에 얹는 형태로, 각 규칙을 테스트로 고정하며 만듭니다.*

<hr />

## 포인트 + 카드 복합결제 — 왜 환불은 포인트부터 하나

*결제 시스템 시리즈. 확장 2편 — 복합결제와 환불 우선순위의 도메인 논리.*

### 0. 내부와 외부를 한 결제에 묶기

"10,000원을 포인트 6,000 + 카드 4,000으로 결제." 이게 복합결제예요. 무신사 공고의 "쿠폰/포인트 benefit 시스템", 배민의 "포인트시스템"이 이거고요.

여기 핵심 문제가 있어요 — **포인트 차감(내부 DB)과 카드 승인(외부 PG)은 한 트랜잭션이 될 수 없어요.** 외부 API 호출은 롤백이 안 되니까요. 그래서 [Phase 2의 보상 트랜잭션](/blog/project/pay/pay-ch1-payment-core)이 여기서도 나와요.

### 1. 롤백 확실한 것을 먼저 선점한다

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

그리고 금액 검증도 확장했어요 — **카드 + 포인트 = 주문 총액.** 클라이언트가 포인트 6,000 쓴다고 하고 카드는 1원만 보내면? 합이 주문금액과 안 맞으니 [Phase 1의 신뢰 경계](/blog/project/pay/pay-ch1-payment-core)에서 막혀요.

> 그리고 `pointAmount == 0`이면 **기존 순수 카드결제와 완전히 동일**하게 동작해요. 확장이 기존 흐름을 안 건드리게 — 이게 [멀티 PG 때](/blog/project/pay/pay-ch2-payment-methods)와 같은 "기존 위에 얹기" 원칙이에요.

### 2. 왜 환불은 포인트부터인가 (면접 킬러)

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

### 3. 포인트 원장도 append-only

포인트도 [원장](/blog/project/pay/pay-ch1-payment-core)의 발상을 따랐어요 — 잔액을 덮어쓰는 게 아니라 이력을 남겨요. `PointHistory`(USE/RESTORE/REFUND)가 append-only로 쌓이고, 각 작업은 `orderNo` 기준 멱등이에요. 그래서 복합결제가 재시도돼도 포인트가 두 번 빠지거나 두 번 복원되지 않아요. 쿠폰 안분도 순수 함수로 "배분 합 = 쿠폰액" 불변식을 테스트로 못 박았고요(끝전은 마지막 라인에 몰아주기).

### 4. 그리고 보안 검토가 또 잡았다 — IDOR

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

> 이게 [Phase 1의 신뢰 경계](/blog/project/pay/pay-ch1-payment-core)·[Phase 6의 어드민 인증](/blog/project/pay/pay-ch1-payment-core)과 **정확히 같은 실수**예요 — "userId를 클라이언트가 보낸 값으로 믿었다." 결제에서 **누가 요청했는가(authentication)와 그 주문의 주인이 맞는가(authorization)**는 클라이언트가 아니라 서버가 정해야 해요. 세 번째로 같은 패턴을 잡으면서, "신뢰 경계를 먼저 긋는다"가 이 프로젝트를 관통하는 규칙이라는 게 분명해졌어요.

### 다음 — 빌링키 정기결제

다음 확장은 구독이에요. 빌링키로 매달 자동결제하고, 실패하면 dunning(soft decline은 재시도, hard decline은 즉시 중단)으로 회수하는. "결제 실패하면 바로 해지하나요?"에 답하는 유예기간 상태머신까지. 이어서 씁니다.

---

*확장도 기존 기반(보상 트랜잭션·신뢰 경계·원장 발상) 위에 얹는 형태로, 각 규칙을 테스트로 고정하며 만듭니다.*

<hr />

## 구독 결제 — "실패하면 바로 해지하나요?"에 답하는 dunning

*결제 시스템 시리즈. 확장 3편 — 구독과 dunning.*

### 0. 구독의 진짜 문제는 "실패"다

빌링키로 매달 자동결제하는 구독. 연동 자체는 어렵지 않아요 — 토스페이먼츠 빌링키 발급받고, 매달 승인 API 부르면 되죠. 그런데 [Phase 2에서 배운 것](/blog/project/pay/pay-ch1-payment-core)처럼, **진짜는 실패했을 때**예요.

> 토스페이먼츠는 **스케줄링을 제공하지 않아요.** 결제 주기 관리, 실패 처리, 상태 전이는 전부 우리 몫이에요. 그리고 "구독 결제가 실패하면 바로 해지하나요?"가 이 도메인의 핵심 질문이고요.

### 1. dunning — soft와 hard를 나눈다

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

> **도난·무효 카드를 반복 시도하면 카드사에서 가맹점 평판 점수가 깎여요.** 될 리가 없는 카드를 계속 긁으면 "이 가맹점은 뭔가 이상하다"고 카드사가 보는 거죠. 그래서 hard decline은 재시도 없이 바로 중단하고 사용자에게 카드 변경을 요청해요. 이건 [Phase 2의 "재시도 가능한 에러와 불가능한 에러를 구분한다"](/blog/project/pay/pay-ch1-payment-core)와 같은 논리예요.

### 2. 유예기간 상태머신 — "바로 해지"하지 않는다

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

[Phase 1의 상태머신](/blog/project/pay/pay-ch1-payment-core)처럼 허용된 전이만 코드로 강제했어요. 그리고 hard decline은 유예를 건너뛰고 `ACTIVE → ON_HOLD` 급행으로 가게 별도 전이를 뒀고요 — "hard는 재시도·유예 없음"이라는 의미를 상태머신에 새긴 거예요.

모든 시도는 `DunningAttempt`로 append-only 기록해서, "이 구독이 몇 번 실패했고 다음 재시도가 언제인지"가 남아요.

### 3. proration — 플랜 바꿀 때 일할계산

구독 중에 플랜을 바꾸면(업그레이드/다운그레이드) 남은 기간을 정산해야 해요.

```java
long net = Math.floorDiv((newAmount - oldAmount) * remainingDays, totalDays);
// 업그레이드 → 양수(추가 청구), 다운그레이드 → 음수(크레딧)
```

남은 기간 비율만큼 차액을 계산해요. 업그레이드는 즉시 차액을 청구하고, 다운그레이드는 크레딧으로 적립(현금 환불 아님). 순수 함수라 월말 경계 같은 엣지 케이스를 테스트로 못 박기 좋았어요.

### 4. 정리

구독도 결국 [이 시리즈의 명제](/blog/project/pay/pay-ch1-payment-core) 그대로예요 — **차별화는 "실패"에 있다.**

- 빌링키로 매달 긁기(성공 경로)는 흔해요.
- **soft/hard decline 구분, 유예기간 상태머신, dunning 재시도 스케줄, proration** — 이게 "구독을 만들어봤다"와 "구독의 실패를 다뤄봤다"를 가르는 지점이에요.

"결제 실패하면 바로 해지하나요?"에 **"아니요, soft decline이면 유예기간 주고 재시도하고, hard decline이면 즉시 정지하되 재시도는 안 합니다 — 도난카드 반복 시도는 평판을 깎으니까요"**라고 답할 수 있는 거죠.

### 다음 — 선불 월렛

다음은 페이머니 같은 선불 충전 월렛이에요. 복식부기로 잔액을 관리하고, 전금법 기명 200만원 한도를 코드로 넣고, 동시 차감에서 이중지불이 안 나는 걸 실측으로 증명하는. 이어서 씁니다.

---

*확장도 기존 기반(상태머신·재시도 구분·원장 발상) 위에 얹으며, 각 규칙을 테스트로 고정합니다.*

<hr />

## 선불 월렛 — 잔액을 덮어쓰지 않는다, 그리고 전금법 한도를 코드로

*결제 시스템 시리즈. 확장 4편 — 선불 월렛.*

### 0. 잔액을 "덮어쓰면" 안 되는 이유

페이머니, 카카오페이머니 같은 선불 충전 월렛. 순진하게 만들면 `UPDATE wallet SET balance = ? WHERE ...`로 잔액을 덮어써요. 그런데 이건 **금융에서 하면 안 되는** 짓이에요.

> 잔액을 덮어쓰면 "언제, 왜, 얼마가 바뀌었는지" 이력이 사라져요. 그리고 동시성에서 read-modify-write 경합으로 잔액이 틀어질 수 있죠. 그래서 [Phase 4의 원장](/blog/project/pay/pay-ch1-payment-core)처럼, **잔액을 덮어쓰는 게 아니라 이동 이력을 append**해요.

`WalletTransaction`(CHARGE/USE/REFUND)이 append-only로 쌓이고, 잔액은 그 파생값이에요. 실무에선 조회 성능을 위해 잔액을 materialized 컬럼으로 두되(+ 낙관적 락), 진실의 원천은 이력이에요.

### 1. 마이너스 잔액은 "만들어질 수 없다"

월렛의 제1 불변식은 **"잔액은 음수가 될 수 없다"**예요. 이걸 두 겹으로 지켜요.

```java
public void use(long amount) {
    if (amount < 0) throw new WalletException("INVALID_AMOUNT", ...);
    if (balance < amount) throw new WalletException("INSUFFICIENT_BALANCE", ...);
    this.balance -= amount;
}
```

그리고 동시성에서는 낙관적 락(`@Version`) + 충돌 시 재시도로 이중차감을 막아요. 이 기법의 정합성 — **동시에 여러 번 차감해도 이중차감·마이너스 잔액이 0건** — 은 [Phase 5의 락 비교 실험](/blog/project/pay/pay-ch1-payment-core)에서 이미 실측했어요. 거기서 조건부 UPDATE(`WHERE balance >= ?`)가 원자적으로 "충분할 때만 차감"하는 걸 실제 스레드로 증명했고, 월렛은 같은 원자 차감 원리를 써요.

> 재밌게도 재고 차감(stock)과 월렛 차감(wallet)은 **완전히 같은 동시성 문제**예요 — "한 자원에서 여러 요청이 동시에 빼가는데 음수가 되면 안 된다." 그래서 [락 비교](/blog/project/pay/pay-ch1-payment-core)에서 고른 조건부 UPDATE 전략이 그대로 적용돼요.

### 2. 전금법 한도를 코드에 박는다

선불 월렛은 **규제 도메인**이에요. 전자금융거래법상 선불전자지급수단의 발행한도가 있어요 — **무기명 50만원, 기명 200만원.** 카카오페이머니 보유한도 200만원이 이 법에서 나와요.

이 규제를 도메인 규칙으로 코드에 박았어요.

```java
private static final long MAX_BALANCE = 2_000_000;  // 전금법 기명 한도

public void charge(long amount) {
    if (amount < 0) throw ...;
    if (balance + amount > MAX_BALANCE) {
        throw new WalletException("LIMIT_EXCEEDED", "충전 한도(200만원)를 초과합니다.");
    }
    this.balance += amount;
}
```

> 이게 포트폴리오에서 차별화 포인트예요. "충전 기능 만들었어요"가 아니라 **"전금법 기명 한도 200만원을 도메인 규칙으로 넣었고, 2024년 개정 전금법의 선불충전금 전액 별도관리도 원장 계정 분리로 반영할 수 있게 설계했어요"** — 라고 하면 "규제를 이해하는 개발자"로 보여요. 핀테크·페이사 지원에서 강하게 먹히는 지점이고요.

### 3. 정리

선불 월렛은 두 가지를 증명해요.

- **원장 발상**: 잔액을 덮어쓰지 않고 이력을 남긴다 → 마이너스 잔액·이중차감을 구조적으로 차단, 감사 가능. (잔액 컬럼 UPDATE식 지갑은 오히려 감점이에요.)
- **규제를 코드로**: 전금법 한도를 도메인 규칙으로. "돈을 다루는 법"을 아는 신호.

그리고 동시성은 [이미 실측 증명한 기법](/blog/project/pay/pay-ch1-payment-core)을 재사용 — 재고든 월렛이든 "한 자원의 동시 차감"은 같은 문제라는 걸 보여주면서요.

### 다음 — 가상계좌

다음은 가상계좌예요. 입금 웹훅, 그리고 문서를 깊게 읽어야만 아는 함정 둘 — **입금기한 만료(EXPIRED)엔 웹훅이 안 온다**(자체 만료 배치 필요), **DONE에서 입금대기로 역전이**하는 은행 케이스. 이어서 씁니다.

---

*확장도 기존 기반(원장 발상·검증된 동시성 기법) 위에 얹으며, 규제를 도메인 규칙으로 새깁니다.*

<hr />

## 가상계좌 — 문서를 깊게 읽어야만 보이는 두 함정

*결제 시스템 시리즈. 확장 5편 — 가상계좌의 함정들.*

### 0. 입금을 기다리는 결제

가상계좌는 "계좌번호를 발급하고 입금을 기다리는" 결제예요. 카드처럼 즉시 승인이 아니라, 사용자가 나중에 그 계좌로 돈을 넣으면 완료되죠. 상태 흐름은 `발급 → 입금대기 → 입금완료`예요.

기본은 [Phase 3의 웹훅](/blog/project/pay/pay-ch1-payment-core)으로 처리해요 — 입금되면 PG가 웹훅을 보내고, 우리는 "믿지 말고 조회로 재검증"해서 완료 처리. 여기까진 쉬워요. 그런데 토스페이먼츠 문서를 **깊게** 읽으면 함정 둘이 나와요.

### 1. 함정 ①: 만료엔 웹훅이 안 온다

입금기한(예: 7일)이 지나면 가상계좌가 만료돼요. 그런데 —

> **EXPIRED 상태로 바뀔 때는 웹훅이 전송되지 않아요.** (토스페이먼츠 문서에 명시돼 있어요.)

이걸 모르면, "웹훅으로 다 처리하니까 만료도 웹훅 오겠지" 하고 방치하게 돼요. 그러면 만료된 가상계좌가 영원히 "입금대기"로 남아, 재고나 쿠폰을 물고 있죠. 그래서 **자체 만료 배치**가 필요해요.

```java
public int expireOverdue(Instant now) {
    // EXPIRED 웹훅이 안 오므로 직접 스캔한다
    List<VirtualAccount> overdue =
        repository.findByStatusAndDueDateBefore(WAITING_FOR_DEPOSIT, now);
    for (VirtualAccount va : overdue) {
        // 만료시키기 전에 PG에 조회 — 입금이 늦게 도착했을 수도 있으니까
        if (pgClient.query(va.getPaymentKey()).isApproved()) {
            va.confirmDeposit();   // 늦은 입금 → 완료 (만료 안 함)
        } else {
            va.expire();
        }
    }
    return overdue.size();
}
```

### 2. 만료-입금 레이스

위 코드에서 눈여겨볼 게 있어요. 만료 배치가 도는 **바로 그 순간에 입금이 도착**할 수 있어요. 그럼 "만료시켜야 하나, 완료시켜야 하나?"

답은 [Phase 3의 원칙](/blog/project/pay/pay-ch1-payment-core) 그대로예요 — **믿지 말고 PG에 조회.** 만료 대상이라도 조회해서 실제로 입금됐으면(APPROVED) 만료시키지 않고 완료 처리해요. dueDate만 보고 기계적으로 만료시키면, 방금 입금한 사용자의 돈이 붕 뜨거든요.

> 이게 "가상계좌 만료 어떻게 처리하세요?"에 대한 강한 답이에요 — "EXPIRED 웹훅이 없어서 배치로 감지하고, 만료 직전에 조회로 재확인해서 늦은 입금과의 레이스를 해소합니다." 문서를 대충 읽으면 절대 안 나오는 디테일이죠.

### 3. 함정 ②: DONE에서 되돌아온다

두 번째 함정은 더 미묘해요.

> 일부 은행(신한 등)은 **입금 실패인데 DONE을 먼저 보낸 뒤, 최대 2분 후 되돌리는** 통보를 해요. 즉 `DONE → 입금대기`로 상태가 역전이돼요.

보통 상태머신은 "완료(DONE)는 최종 상태"라고 가정하는데, 가상계좌는 아니에요. 그래서 상태머신에 **역전이를 허용 전이로** 넣었어요.

```java
DONE → { WAITING_FOR_DEPOSIT, CANCELED }   // 은행 지연 통보로 인한 역전이
```

그리고 역전이가 오면, 이미 보낸 "결제 완료" 후속 처리(알림, 포인트 적립 등)를 되돌려야 해요 — [Phase 1에서 만든](/blog/project/pay/pay-ch1-payment-core) 상태 전이 이력과 [보상 트랜잭션](/blog/project/pay/pay-ch1-payment-core) 발상이 여기서도 쓰여요.

### 4. 정리

가상계좌는 "입금 기다리기"라는 단순해 보이는 기능인데, 실무 함정이 숨어 있어요.

| 함정 | 대응 |
|---|---|
| EXPIRED엔 웹훅 없음 | 자체 만료 배치(dueDate 스캔) |
| 만료-입금 레이스 | 만료 직전 조회로 재확인 |
| DONE→입금대기 역전이 | 상태머신에 역전이 허용 + 후속 처리 보상 |

> 이 세 가지는 전부 **문서를 깊게 읽어야만** 나와요. "가상계좌 붙였어요"와 "가상계좌의 EXPIRED 웹훅 부재와 DONE 역전이를 처리했어요"는 완전히 다른 깊이예요. 그리고 결국 [이 시리즈의 원칙](/blog/project/pay/pay-ch1-payment-core) — "웹훅을 믿지 말고 조회로 확정한다"·"실패/역전이를 상태머신에 새긴다" — 이 그대로 재사용돼요.

### 다음 — 이상거래탐지(FDS)

다음은 FDS예요. velocity check로 단위시간 시도 횟수를 세고, 금액 이상치를 잡고, 룰 가중치로 스코어링해서 ALLOW/CHALLENGE/BLOCK/REVIEW로 나누는. 핵심은 정확도가 아니라 아키텍처 판단이에요. 이어서 씁니다.

---

*확장도 기존 기반(웹훅 조회 재검증·상태머신·보상) 위에 얹으며, 문서의 디테일을 코드로 옮깁니다.*

<hr />

## 이상거래탐지(FDS) — 정확도보다 아키텍처 판단

*결제 시스템 시리즈. 확장 6편 — 이상거래탐지.*

### 0. FDS에서 중요한 건 정확도가 아니다

이상거래탐지(FDS)라고 하면 ML·그래프 분석부터 떠올리는데, 실 서비스에서 먼저 중요한 건 **아키텍처 판단**이에요. 탐지 로직이 정교한지보다, "결제 경로에서 얼마나 빠르게 판정하는가", "룰을 어떻게 무배포로 바꾸는가", "다중 인스턴스에서 카운터를 어떻게 공유하는가" 같은 게 먼저예요.

그래서 여기선 **룰 기반 엔진**을 만들되, 그 세 가지 판단을 코드로 드러냈어요.

### 1. velocity check + 가중치 스코어링

여러 룰의 위험 점수를 합산해 판정해요.

```java
public FraudResult evaluate(FraudCheckRequest req) {
    int score = 0;
    if (cardBlacklist.contains(req.cardKey())) score += 100;     // 블랙리스트
    int attempts = velocityCounter.recordAndCount("card:" + req.cardKey());
    if (attempts > velocityThreshold) score += 40;              // velocity 초과
    if (req.amount() > amountThreshold) score += 30;            // 금액 이상치
    return new FraudResult(score, decide(score), reasons);
}
```

점수 구간으로 4단계 대응을 결정해요.

| 점수 | 판정 | 대응 |
|---|---|---|
| ≥100 | **BLOCK** | 차단 |
| ≥60 | **REVIEW** | 사후 사람 검토 큐 |
| ≥40 | **CHALLENGE** | 추가 인증 요구 |
| < 40 | **ALLOW** | 통과 |

velocity check는 "1분 안에 이 카드로 몇 번 시도했나"를 세요. 도난 카드로 여러 금액을 빠르게 긁는 패턴을 잡죠.

### 2. 룰은 코드가 아니라 데이터

여기가 실무 판단이에요. 임계값과 가중치를 **코드에 박으면**, 룰을 바꿀 때마다 배포해야 해요. 사기 패턴은 실시간으로 바뀌는데 배포 사이클을 기다릴 순 없죠.

```java
@Value("${fds.velocity.threshold:5}")  private int velocityThreshold;
@Value("${fds.amount.threshold:1000000}") private long amountThreshold;
```

임계값을 설정으로 빼서 **무배포로 조정**하고, 블랙리스트도 런타임에 추가해요. 운영에선 이걸 DB나 룰 관리 콘솔로 확장하고요.

### 3. velocity 카운터는 추상화

velocity 카운터를 인터페이스로 뺐어요.

```java
public interface VelocityCounter {
    int recordAndCount(String key);
}
```

지금은 인메모리 슬라이딩 윈도우(`ArrayDeque`로 최근 1분 타임스탬프 유지)로 구현했지만, **다중 인스턴스에서는 카운트를 공유해야** 하니 운영에선 Redis(Sorted Set)로 갈아끼워요. 인터페이스 덕에 구현만 바꾸면 되죠. (시간 소스를 주입 가능하게 해서 윈도우 만료를 테스트로 검증했어요.)

### 4. 동기 vs 비동기

마지막 판단 하나. 이 룰 엔진은 **결제 경로에서 동기로** 빠르게 도는 경량 룰만 담았어요. 무거운 분석(그래프·ML)은 지연 예산 안에서 못 하니 **비동기 사후 탐지**로 분리하는 게 정석이에요. 이 경계를 어디에 긋느냐가 FDS 설계의 핵심이에요.

> "if문 몇 개로 사기를 잡는다"가 아니라, "경량 룰은 동기 인라인, 무거운 건 비동기 사후, 룰은 데이터로 무배포 조정, 카운터는 Redis로 확장" — 이 구조적 판단이 FDS에서 실제로 중요한 부분이에요.

### 다음 — 필드 암호화

다음은 민감정보 필드 암호화예요. 계좌번호를 AES-256-GCM으로 암호화하고, 암호화 컬럼을 검색하기 위한 블라인드 인덱스, 그리고 키를 코드에 두지 않는 법까지. 이어서 씁니다.

---

*확장도 기존 기반 위에 얹으며, 각 판단을 테스트로 고정합니다.*

<hr />

## 필드 암호화 — 키를 코드에 두지 않는다, 그리고 암호화한 걸 검색하는 법

*결제 시스템 시리즈. 확장 7편 — 필드 암호화와 감사 로그.*

### 0. 무엇을, 왜 암호화하나

「개인정보의 안전성 확보조치 기준」은 **신용카드번호·계좌번호**를 암호화 의무 대상으로 정해요. 그래서 이런 필드는 평문으로 저장하면 안 돼요. AES-256-GCM으로 암호화했어요.

```java
Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
cipher.init(ENCRYPT_MODE, key, new GCMParameterSpec(128, iv));  // 무작위 IV
```

**왜 GCM인가** — CBC와 달리 **인증 태그**가 붙어서 변조를 감지해요. 누가 DB의 암호문을 조작하면 복호화가 실패하죠. 그리고 암호문마다 **무작위 IV**를 앞에 붙여서, 같은 계좌번호도 매번 다른 암호문이 돼요(패턴 노출 방지).

JPA에서는 `AttributeConverter`로 붙여서, 엔티티 필드에 `@Convert`만 달면 저장 시 암호화·조회 시 복호화가 투명하게 일어나게 했어요.

### 1. 암호화하면 검색이 안 된다 — 블라인드 인덱스

여기 실무 함정이 있어요. 계좌번호를 암호화하면 매번 암호문이 달라서 **`WHERE account = ?` 검색이 안 돼요.** 그렇다고 평문으로 둘 순 없고요.

해법은 **블라인드 인덱스**예요. 같은 평문이 항상 같은 해시가 되는 HMAC-SHA256 값을 별도 컬럼에 저장해요.

```java
public static String hash(String value, String secret) {
    Mac mac = Mac.getInstance("HmacSHA256");
    mac.init(new SecretKeySpec(secret.getBytes(UTF_8), "HmacSHA256"));
    return hex(mac.doFinal(value.getBytes(UTF_8)));
}
```

이러면 `WHERE account_index = hash(검색어)`로 **동등 검색만** 열려요. (범위 검색은 여전히 불가 — 그건 암호화 컬럼의 본질적 한계예요.) 암호화로 데이터를 보호하면서도 "이 계좌번호로 조회"는 되게 하는 거죠.

### 2. 그리고 보안 검토가 키를 잡았다

암호화 코드를 커밋하자 자동 보안 검토가 짚었어요 — **하드코딩된 암호화 키.**

```java
// 잡힌 것
public AesGcmFieldCipher(@Value("${app.crypto.key:0123456789abcdef...}") String key)
//                                              ^^^^^^^^^^^^^^^^^^ 코드에 박힌 기본 키
```

암호화 키가 코드에 기본값으로 있으면, 누가 `app.crypto.key`를 안 설정하고 배포했을 때 **공개된 키로 데이터를 암호화**하게 돼요. 암호화의 의미가 사라지죠.

고쳤어요 — **기본값을 없애서, 키가 없으면 앱이 아예 안 뜨게** 했어요.

```java
public AesGcmFieldCipher(@Value("${app.crypto.key}") String key) {  // 기본값 없음
    if (key == null || key.isBlank())
        throw new IllegalStateException("app.crypto.key 미설정 — 환경변수/시크릿으로 주입해야 합니다.");
    ...
}
```

키는 환경변수/시크릿 매니저로만 주입하고, 로컬 개발용 값은 설정 파일에 두되 "운영에서 반드시 오버라이드"로 표시했어요.

> 운영에선 이걸 **envelope encryption**으로 한 단계 더 가요 — 데이터는 DEK로 암호화하고, DEK는 KMS 마스터키로 암호화해 함께 저장. 이 코드의 인터페이스는 그대로 두고 키 공급만 KMS로 바꾸면 되게 설계했어요.

### 3. 감사 로그

민감 행위(강제취소, 개인정보 언마스킹 등)는 **append-only 감사 로그**로 남겨요. 전자금융거래법 제22조상 거래기록 5년 보존의 기반이에요. 누가·무엇을·어떤 대상에·언제 했는지를 기록하고, 절대 수정·삭제하지 않아요.

### 4. 정리

민감정보 보호는 세 겹이에요.

- **암호화**: AES-256-GCM(변조 감지 + 무작위 IV), JPA 컨버터로 투명하게
- **검색 가능성**: 블라인드 인덱스(HMAC)로 동등 검색만 허용
- **키 관리**: 키를 코드에 두지 않는다(미설정 시 기동 실패), 운영은 envelope encryption
- **감사**: 민감 행위 append-only 기록(전금법 5년)

그리고 "하드코딩 키"는 자동 보안 검토가 커밋 단계에서 잡아줬어요 — 암호화 코드일수록 이런 검토가 중요하다는 걸 다시 확인했고요.

### 다음 — 현금영수증

마지막 확장은 현금영수증이에요. 카드는 매출전표, 현금성은 현금영수증, B2B는 세금계산서로 증빙을 자동 결정하고, 결제가 취소되면 현금영수증도 연쇄 취소하는. 이어서 씁니다.

---

*확장도 기존 기반 위에 얹으며, 규제와 보안을 코드로 반영합니다.*

<hr />

## 현금영수증 — 결제를 취소하면 영수증도 취소해야 한다

*결제 시스템 시리즈. 확장 8편, 마지막 — 현금영수증과 증빙.*

### 0. 증빙은 국내 도메인이다

현금영수증·세금계산서는 해외 자료로는 못 배우는 **순수 국내 도메인**이에요. 그리고 기술이라기보단 **법적 의무**라, 커머스 결제를 열 때 반드시 챙겨야 해요.

핵심은 결제수단에 따라 증빙이 하나로 정해진다는 거예요.

```java
public static EvidenceType resolve(String method, boolean b2b) {
    if (b2b) return TAX_INVOICE;                        // B2B → 세금계산서
    return switch (method) {
        case "VIRTUAL_ACCOUNT", "TRANSFER" -> CASH_RECEIPT;  // 현금성 → 현금영수증
        default -> SALES_SLIP;                          // 카드 → 매출전표
    };
}
```

카드 결제는 **매출전표**가 법정 증빙이라, 세금계산서를 중복 발행하면 안 돼요. 가상계좌·계좌이체는 현금거래라 **현금영수증** 대상이고요. "가상계좌 = 현금거래 = 현금영수증"이 핵심 도메인 지식이에요.

### 1. 비동기 발급

현금영수증 발급은 즉시 끝나지 않아요. PG에 요청하면 `IN_PROGRESS → COMPLETED/FAILED`로 진행되죠. 그래서 상태머신으로 다뤄요.

```
REQUESTED → ISSUED / FAILED → CANCELED
```

[가상계좌](/blog/project/pay/pay-ch2-payment-methods)나 [결제 승인](/blog/project/pay/pay-ch1-payment-core)처럼, "비동기라 상태를 추적한다"는 같은 패턴이에요.

### 2. 핵심 함정: 결제 취소하면 영수증이 남는다

여기가 이 기능의 진짜 포인트예요. 운영에서 사고가 잦은 지점이거든요.

> 수동 발급한 현금영수증은, **결제를 취소해도 자동으로 취소되지 않아요.** 가맹점이 직접 현금영수증 취소 API를 호출해야 하는데, 이걸 깜빡하면 "결제는 취소됐는데 현금영수증은 발급된 채로" 남아요. 세무상 문제가 되죠.

그래서 [Phase 3의 이벤트](/blog/project/pay/pay-ch1-payment-core)를 써서 자동으로 연쇄 취소하게 했어요.

```java
@ApplicationModuleListener
void onCanceled(PaymentCanceledEvent event) {
    receiptService.cancelByOrder(event.orderNo());   // 결제 취소 → 현금영수증 연쇄 취소
}
```

결제가 취소되면 그 주문의 현금영수증을 찾아 함께 취소해요. 이미 취소된 건 멱등하게 넘어가고요. "결제 취소 → 현금영수증 자동 취소"를 이벤트로 엮어서, 사람이 깜빡할 여지를 없앤 거예요.

### 3. 시리즈를 마치며

이걸로 **본편 7편 + 개선 2편 + 확장 8편**, 총 17편을 마쳐요. 되짚어보면 —

```
본편   결제 코어 → 실패 설계 → 이벤트 → 원장·정산·대사 → 성능 → 운영
개선   실기동(Flyway) → 실 PG 어댑터
확장   멀티PG · 복합결제 · 구독 · 월렛 · 가상계좌 · FDS · 암호화 · 현금영수증
```

처음 [0편](/blog/project/pay/pay-ch1-payment-core)에서 세운 명제 하나가 끝까지 관통했어요 — **결제의 어려움은 "성공"이 아니라 "실패와 정합성"에 있다.** 타임아웃을 UNKNOWN으로 보존하고, 멱등키로 중복을 막고, 복식부기로 정합성을 증명하고, failover는 이중결제를 피해서 하고, 결제 취소는 영수증까지 연쇄로 취소하고 — 전부 "정상 경로 다음"의 이야기였어요.

그리고 만드는 내내 자동 보안 검토가 세 번(가격 위변조, 소유권 IDOR, 하드코딩 키) 사고를 커밋 단계에서 잡아줬어요. "돌아가는 것"과 "안전하게 돌아가는 것"은 다르다는 걸, 코드로 배운 프로젝트였어요. 읽어주셔서 고맙습니다.

---

*전체 코드는 195개 테스트로 검증돼 있고, 실 MySQL 위에서 라이브로 동작을 확인했습니다.*

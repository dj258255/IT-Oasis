---
title: '가짜를 진짜로 — 실 토스페이먼츠 어댑터, 구현 하나로 갈아끼우기'
titleEn: "From Fake to Real — Swapping in a Toss Payments Adapter with a Single Implementation"
description: 결제 시스템 개선기 2. 지금까지 상태 기반 FakePgClient로 모든 시나리오를 결정적으로 테스트했다. 이제 그 자리에 진짜 토스페이먼츠 어댑터를 끼운다. 처음부터 PgClient 인터페이스로 추상화해둔 덕에, 도메인 로직은 한 줄도 안 건드리고 구현 하나만 추가하면 된다. 그리고 "예외를 실패로 단정하지 않고 UNKNOWN으로"라는 설계가 실 PG 어댑터에서 어떻게 살아나는지.
descriptionEn: "Payment system improvement log 2. So far I tested every scenario deterministically with a stateful FakePgClient. Now I swap in a real Toss Payments adapter. Because I abstracted behind a PgClient interface from the start, I touch zero domain logic and just add one implementation. And how the 'don't declare exceptions failures — treat them as UNKNOWN' design carries into the real PG adapter."
date: 2026-07-13T00:00:00.000Z
tags:
  - Payment
  - Toss Payments
  - Adapter Pattern
  - RestClient
  - Spring Boot
  - Java
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 8
---

*결제 도메인 취업을 목표로 실전 결제 시스템을 밑바닥부터 만드는 시리즈. 개선기 2편 — 가짜 PG를 진짜로 갈아끼우기.*

## 0. 왜 지금까지 가짜였나

이 시리즈 내내 실제 토스페이먼츠 대신 **상태 기반 `FakePgClient`**로 테스트했어요. 이게 게으름이 아니라 **의도**였어요.

[Phase 2](/blog/project/pay/pay-2-designing-for-failure)에서 만든 것들 — 타임아웃을 UNKNOWN으로 보존하고, 복구 배치가 조회로 확정하고, 서킷브레이커가 장애를 격리하는 것 — 이걸 실제 PG로 테스트하려면 **실제로 타임아웃을 일으키고 PG를 다운시켜야** 해요. 그건 불가능하죠. 그래서 FakePgClient를 상태 기반으로 만들어서 "우리는 타임아웃이었지만 PG엔 승인으로 남은" 상황까지 **결정적으로** 재현했어요.

덕분에 네트워크·키 없이 CI에서 모든 실패 시나리오가 초록불이에요. 이제 그 위에 진짜를 얹을 차례예요.

## 1. 추상화의 보상 — 구현 하나만 추가

[Phase 1](/blog/project/pay/pay-1-order-payment-core)에서 PG를 이렇게 추상화해뒀어요.

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

프로파일로 택일해요 — 개발·테스트는 `FakePgClient`, 운영은 `TossPgClient`. 둘 다 `@Qualifier("pgDelegate")`를 달아서, [서킷브레이커](/blog/project/pay/pay-2-designing-for-failure)를 입히는 `ResilientPgClient`가 **활성 어댑터를 자동으로 감싸요.**

```java
@Autowired
public ResilientPgClient(@Qualifier("pgDelegate") PgClient delegate) {  // Fake 또는 Toss
    this.delegate = delegate;
    ...
}
```

이게 처음부터 어댑터로 분리해둔 값어치예요. "나중에 실 PG 붙이기"가 **리팩토링이 아니라 파일 추가**가 됐어요.

## 2. 여기서도 "예외를 실패로 단정하지 않는다"

실 PG 어댑터를 짜면서 제일 신경 쓴 건 [Phase 2의 원칙](/blog/project/pay/pay-2-designing-for-failure) — **타임아웃·5xx를 실패로 단정하지 않는다** — 를 그대로 지키는 거였어요.

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

그리고 승인 때 **`Idempotency-Key`를 PG로 전달**해요. 우리가 [멱등키로 우리 서버를 지키듯이](/blog/project/pay/pay-2-designing-for-failure), PG 호출도 멱등해야 타임아웃 후 안전하게 재조회할 수 있으니까요.

## 3. HTTP 없이 매핑을 테스트한다

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

## 4. 개선의 교훈

이번 건 새 기능이 아니라 **경계를 잘 그어둔 것의 배당금**이에요.

> 처음에 `PgClient` 인터페이스로 PG를 밀어내 둔 덕에, 실 PG 연동이 "시스템을 뜯어고치기"가 아니라 "구현 하나 추가하기"가 됐어요. 그리고 Fake가 단순 스텁이 아니라 **상태 기반**이었던 덕에, 실 PG 없이도 실패·복구 시나리오를 다 검증해둘 수 있었고요.

면접식으로 말하면 — "실 PG 연동을 어떻게 하실 거예요?"에 **"이미 어댑터로 분리해놨고, Fake로 실패 시나리오까지 검증해뒀으니 구현체만 추가하면 됩니다"**라고 답할 수 있는 구조를 처음부터 만들어둔 거예요.

## 마치며

이걸로 이 시리즈의 개선기까지 왔어요. 되짚으면 —

```
본편  Phase 0~6   Modulith 뼈대 → 결제 코어 → 실패 설계 → 이벤트 → 원장·정산·대사 → 성능 → 운영
개선  1. Flyway로 실기동 + 라이브 검증 + k6 실수치
      2. 실 토스페이먼츠 어댑터
```

처음 [0편](/blog/project/pay/pay-0-why-and-modulith)에서 세운 명제 그대로였어요 — **결제의 차별화는 "성공"이 아니라 "실패와 정합성"에 있다.** 그리고 그걸 코드로, 테스트로, 실측 수치로 증명하는 여정이었어요. 읽어주셔서 고맙습니다.

---

*이 시리즈는 Spring Modulith 기반, 실 MySQL에서 라이브 검증까지 마쳤어요. 실 PG 매핑은 순수 함수로 테스트되고, 연동은 토스 샌드박스 키로 활성화됩니다.*

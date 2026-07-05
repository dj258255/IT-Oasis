---
title: '결제가 실패했을 때 — 타임아웃은 실패가 아니다'
titleEn: "When Payment Fails — A Timeout Is Not a Failure"
description: 결제 시스템 Phase 2, 이 시리즈의 하이라이트. "결제 성공"은 이미 됐고, 이제 결제가 어긋났을 때를 만든다. 따닥 중복결제를 멱등키로 막고(INSERT 성공이 곧 처리권), PG 승인이 타임아웃 나면 실패로 단정하지 않고 UNKNOWN으로 보존해 복구 배치가 조회로 확정한다. 그리고 서킷브레이커로 PG 장애를 격리하되 — 승인만은 절대 재시도하지 않는다. 멱등키 없는 승인 재시도는 이중결제니까.
descriptionEn: "Payment system Phase 2, the highlight of the series. 'Payment succeeded' is done; now I build what happens when it goes wrong. Blocking double-charges with idempotency keys (a successful INSERT IS the lock), and when the PG approval times out, not declaring it a failure but preserving it as UNKNOWN so a recovery batch resolves it via query. Then isolating PG outages with a circuit breaker — but never retrying the approve call, because retrying an approve without an idempotency key means a double charge."
date: 2026-07-07T00:00:00.000Z
tags:
  - Payment
  - Idempotency
  - Circuit Breaker
  - Resilience4j
  - Fault Tolerance
  - Java
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 2
---

*결제 도메인 취업을 목표로 실전 결제 시스템을 밑바닥부터 만드는 시리즈. 이 글은 2편 — 이 프로젝트의 진짜 알맹이, "결제가 실패했을 때"를 만든다.*

## 0. 여기가 이 시리즈의 이유다

[0편](/blog/project/pay/pay-0-why-and-modulith)에서 말했어요 — PG 연동해서 "결제 성공"까지 가는 건 흔하고, 차별화는 **PG가 책임지지 않는 영역**에 있다고. 그게 바로 이번 Phase 2예요.

[1편](/blog/project/pay/pay-1-order-payment-core)에서 타임아웃을 `UNKNOWN` 상태로 **보존**만 했어요. 이번엔 그 미확정을 실제로 **확정**합니다. 세 가지를 만들었어요.

```
멱등키         "따닥" 중복결제 + 타임아웃 후 안전 재시도
UNKNOWN 복구    조회 API로 확정 / 안 되면 망취소
서킷브레이커     PG 장애가 우리 전체로 번지지 않게 (단, 승인은 재시도 금지)
```

## 1. 따닥 — 멱등키, 그리고 "INSERT가 곧 잠금"

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

## 2. 타임아웃은 실패가 아니다 — UNKNOWN을 확정하기

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

## 3. 서킷브레이커 — 그런데 승인은 재시도하면 안 된다

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

## 4. 다층 방어로 정리하면

이번 편에서 만든 걸 겹쳐 보면, 실패 처리가 여러 겹이에요.

```
1차  멱등키 + 유니크 제약     중복(따닥)을 아예 차단
2차  3-상태 모델 + UNKNOWN    타임아웃을 실패로 단정하지 않고 보존
3차  서킷브레이커             PG 장애 전파 차단
4차  복구 배치               미확정을 조회로 확정 / 망취소
```

그리고 이 모든 실패 경로가 **한 곳(UNKNOWN → 복구)으로 수렴**하게 만든 게 이번 설계의 핵심이에요. 타임아웃이든, PG 예외든, 서킷 오픈이든 — 전부 "미확정"으로 보존됐다가 복구 배치가 조회로 확정해요. 실패의 종류마다 다른 특수 처리를 흩뿌리는 대신에요.

지금까지 테스트 53개, 전부 통과. 아직 실제 PG(토스페이먼츠) 대신 상태 기반 FakePgClient로 이 모든 시나리오를 재현하고 있어요 — 덕분에 네트워크·키 없이도 타임아웃·장애·복구를 **결정적으로** 테스트할 수 있죠.

## 다음 — Phase 3: 웹훅과 이벤트

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

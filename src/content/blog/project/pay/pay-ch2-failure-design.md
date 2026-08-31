---
title: '실패 설계: 실패의 종류마다 되돌리는 법이 달랐다'
description: '타임아웃은 실패가 아니라 미확정이라 보존하고 복구가 확정한다. 이미 나간 승인은 롤백이 안 되니 보상으로 되돌린다. failover는 PG가 요청을 못 받은 게 확실할 때만 하고, 가상계좌는 완료가 최종 상태가 아니라 되돌아오기까지 한다.'
date: 2026-08-31T00:00:00.000Z
category: study/pay
coverImage: "/uploads/project/pay/thumbs/pay-failure.svg"
draft: false
series: "결제 시스템 만들기"
seriesOrder: 2
tags:
  - Payment
  - 실패 설계
  - 멱등성
  - 보상 트랜잭션
  - 결제 시스템
---

## 개요

결제는 성공보다 실패가 어렵다. PG 응답이 안 오면 결제가 된 건지 안 된 건지 알 수 없고, 이미 승인이 나간 뒤에는 DB 롤백으로 되돌릴 수도 없다.

이 글은 실패를 네 종류로 나눠 각각 다르게 다룬 기록이다. 나누는 기준은 하나다. **무엇이 확정됐고 무엇이 미상인가.**


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

## 돈은 나갔는데 주문이 사라지면: 승인 후 재고 부족과 자동 망취소

앞 절이 "결과를 모르는 실패"를 다뤘다면 이번엔 "결과가 확정된 뒤의 실패"다. 카드 승인은 성공했는데 재고 차감이 실패하면 DB 롤백으로는 되돌릴 수 없다. PG에서 이미 일어난 승인은 롤백되지 않기 때문이다. 이 틈을 자동 망취소, 즉 성공할 때까지 재시도하는 보상 트랜잭션으로 메웠다.

### 0. 남겨둔 한 줄

승인 흐름을 만들 때 `CheckoutService`엔 이런 주석이 있었다.

```java
// 차감 실패(품절 경합)는 예외 → 이후 망취소/보상 트랜잭션으로 승격.
```

미뤄둔 데는 이유가 있다. 이게 결제 시스템에서 **가장 위험한 순간** 중 하나이기 때문이다.

### 1. 위험한 순간: 승인 성공 → 재고 부족

주문 승인의 순서를 다시 보자.

1. 포인트 선점
2. **카드 승인** (외부 PG 호출)
3. 재고 차감
4. 주문 PAID

문제는 2와 3 사이다. **카드는 이미 승인됐는데(2), 재고 차감(3)이 품절 경합으로 실패**하면 어떻게 될까?

원래 코드는 재고 차감 실패 시 예외를 던졌고, `@Transactional`이 전부 롤백했다. 그런데 여기에 무서운 구멍이 있다.

> `@Transactional`이 롤백하는 건 **DB뿐**이다. 하지만 2번의 카드 승인은 **PG(외부 시스템)에서 이미 일어났다.** DB를 롤백해도 PG의 승인은 되돌아오지 않는다. 결과는 **고객 카드에서는 돈이 빠져나갔는데 우리 DB엔 주문이 없는** 상태. 고객 입장에선 "결제했는데 아무것도 못 받은" 최악의 경험이다.

이게 분산 트랜잭션의 본질적 문제다. 우리 DB와 PG는 **한 트랜잭션으로 묶을 수 없다.** 그래서 "둘 중 하나가 이미 커밋됐는데 다른 하나가 실패"하는 순간은 **보상(compensation)**으로 풀어야 한다. 롤백으로는 풀 수 없다.

### 2. 해법: 롤백 대신 자동 망취소

방향을 바꿨다. 재고 차감이 실패하면 롤백하지 않는다. 대신 이미 승인된 카드를 **취소(망취소)**하는 걸로 되돌린다.

그런데 망취소도 PG 호출이라 **또 실패할 수 있다.** 네트워크가 끊길 수도, PG가 잠깐 죽었을 수도 있다. 그래서 망취소는 지금 한 번 시도하고 끝내는 대신, **durable하게 적재해두고 성공할 때까지 재시도**하는 구조로 만들었다. 이게 `compensation_tasks` 테이블이다. outbox 패턴의 사촌이다.

흐름은 이렇다.

```
카드 승인 성공 → 재고 차감 시도 → 실패(품절)
  ├─ 이미 차감된 재고가 있으면 원복
  ├─ 선점한 포인트 복원 (내부 자원 — 즉시·확실)
  ├─ compensation_tasks에 "이 카드 망취소해" 태스크 적재
  ├─ 주문 FAILED
  └─ 트랜잭션 커밋 (승인된 결제 + 보상 태스크가 함께 남는다)

[스케줄러] PENDING 태스크를 주기적으로 집어
  → PG 망취소 호출
     ├─ 성공 → DONE
     └─ 실패 → 재시도 카운트++ , 지수 백오프로 다음 시도 예약
        └─ 재시도 소진 → FAILED (운영 개입 알림)
```

핵심은 **"내부적이고 확실한 것"과 "외부적이고 불확실한 것"을 나눈** 것이다. 포인트 복원은 우리 DB 안이라 즉시 확실하게 처리하고, PG 망취소만 durable 재시도 큐로 뺐다. 불확실한 것만 재시도 인프라에 태우는 구조다.

### 3. 진짜 함정: 잡은 예외가 트랜잭션을 오염시킨다

여기서 예상 못 한 벽에 부딪혔다. 처음엔 이렇게 짰다.

```java
try {
    stockDeductionService.deductConditional(productId, qty); // 실패 시 OrderException 던짐
} catch (OrderException e) {
    // 보상 처리...
    compensationService.enqueueNetworkCancel(...);
    order.markFailed();
    // 예외를 안 던지고 정상 리턴 → 커밋되겠지?
}
```

"예외를 잡아서 삼켰으니 트랜잭션은 커밋되겠지" 했는데 **안 됐다.** 최종 커밋에서 `UnexpectedRollbackException`이 터지고, 보상 태스크 적재까지 다 롤백됐다.

원인은 Spring 트랜잭션의 미묘한 규칙이다.

> `deductConditional`은 `@Transactional` 메서드고, 바깥 트랜잭션에 **참여(join)**한다. 이게 예외를 던지는 순간, Spring은 **공유 트랜잭션을 rollback-only로 표시**한다. 바깥에서 그 예외를 잡아도 트랜잭션은 이미 "이건 무조건 롤백"으로 낙인이 찍힌 상태다. 그래서 커밋 시도가 `UnexpectedRollbackException`으로 실패한다.

**"잡았다"고 없던 일이 되는 게 아니다.** 참여 트랜잭션 안에서 던져진 예외는 잡아도 전체를 오염시킨다.

해법은 애초에 **예외를 던지지 않는 것**이었다. 조건부 차감을 boolean으로 바꾼 `tryDeduct`를 새로 만들었다.

```java
/** 예외 없는 조건부 차감 — 성공 true, 재고부족 false. */
@Transactional
public boolean tryDeduct(long productId, int qty) {
    return stockRepository.deductConditionally(productId, qty) > 0;
}
```

이제 체크아웃 경로는 예외 대신 **boolean 분기**로만 흐른다. 트랜잭션을 오염시키는 예외가 없으니 보상 상태(승인된 결제 + 보상 태스크)가 온전히 함께 커밋된다. 기존 `deductConditional`(예외 버전)은 다른 호출부를 위해 그대로 뒀다.

"예외를 잡으면 안전하다"는 직관이 트랜잭션 경계 안에서는 틀린다. 문서로 아는 것과 커밋이 터지는 걸 눈으로 보는 건 달랐다.

### 4. 무한 재시도를 막는 멱등

재시도 구조엔 함정이 하나 더 있다. 망취소를 재시도하다가, 이미 다른 경로로 취소된 결제를 또 취소하려 하면? 이 프로젝트의 취소는 "성공한 결제가 없으면 `PAYMENT_NOT_FOUND`"를 던진다. 이걸 실패로 처리하면 **영원히 재시도**하게 된다. 이미 취소된 걸 계속 취소하려고.

그래서 이렇게 처리했다.

```java
} catch (PaymentException e) {
    if ("PAYMENT_NOT_FOUND".equals(e.code())) {
        task.markDone();   // 취소할 게 없다 = 이미 보상됨 → 완료로 간주(멱등)
    } else {
        throw e;           // 그 외 예외만 재시도 대상
    }
}
```

"취소할 결제가 없다"는 건 **이미 목적이 달성된 상태**다. 실패로 볼 이유가 없다. 보상 작업에서 멱등성은 이렇게 "재시도해도 같은 결과"를 보장하는 안전장치다.

### 5. 소진하면 멈추고 알린다

지수 백오프로 재시도하되, `maxRetries`(5회)를 넘으면 태스크를 `FAILED`로 두고 **더는 자동 재시도하지 않는다.** 대신 `compensation.exhausted` 카운터를 올린다.

```java
if (task.isExhausted()) {
    meterRegistry.counter("compensation.exhausted").increment(); // 알림 룰의 소스
}
```

무한 재시도는 그 자체가 장애를 키운다(죽은 PG를 계속 때리기). 그래서 "자동으로 될 만큼 해보고, 안 되면 사람을 부른다"로 경계를 그었다. 이 카운터가 0보다 크면 운영이 개입해야 한다는 신호다. [운영 관측성 편](/blog/project/pay/pay-ch1-what-to-trust)에서 만든 메트릭 기반 알림의 연장선이다.

스케줄러 자체는 `app.compensation.enabled` 프로퍼티로 켜고 끈다. 기본은 꺼둬서 테스트·로컬 부팅에 부작용이 없고, 운영에서만 환경변수로 켠다. [복구 배치](/blog/project/pay/pay-ch1-what-to-trust)와 같은 방식이다. 배치 로직은 순수 메서드로 두고 테스트는 직접 호출한다.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, 보상 흐름은 14개의 단위 테스트로 검증했다.*

---

## 멀티 PG 라우팅: 규칙을 정하고, 한참 뒤에 배선했다


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

### 3. 그런데 이 라우터가 테스트에서만 살아 있었다

여기까지가 설계다. 한참 뒤 전수 감사에서, 이 라우터가 **어디에도 배선되지 않았다**는 게 나왔다. 금고를 만들고 안 채우고 배치를 만들고 안 부르던 그 패턴이([4편](/blog/project/pay/pay-ch2-runtime-truths)) PG에도 있었다.

`RoutingPgClient`. 여러 PG를 가중치 순으로 시도하고 장애 시 다음 PG로 넘기는(failover) 라우터를 꽤 정성껏 만들어놨다. 서킷브레이커도 PG별로 붙였고 단위 테스트도 촘촘했다. 그런데.

> `grep`해보니 이 라우터를 참조하는 건 **자기 테스트뿐**이었다. 어느 `@Configuration`에서도 빈으로 등록되지 않았고, 실제 결제는 여전히 단일 PG(`ResilientPgClient`가 감싼 하나)로만 흘렀다. failover가 실제 결제 경로엔 없고 **테스트 안에서만 돌고** 있었다.

이번에 배선했다. 다만 "빈으로 등록만 하면 되겠지"로 끝나는 일이 아니었다.

### 4. 진짜 문제는 @Primary였다

결제는 `PgClient` 인터페이스로 PG를 부르고, 그 구현으로 `ResilientPgClient`가 `@Primary`로 주입된다(서킷브레이커·재시도를 입힌 데코레이터). 여기에 라우터를 넣으려니 문제가 걸렸다.

> `RoutingPgClient`를 또 `@Primary`로 두면 **`@Primary`가 둘**이 되어 스프링이 어느 걸 주입할지 못 정한다. 그렇다고 `ResilientPgClient`의 `@Primary`를 떼면 그게 주던 재시도·외곽 서킷을 잃는다.

답은 이미 있던 **seam**에 있었다. `ResilientPgClient`는 자기가 감쌀 대상을 이렇게 주입받고 있었다.

```java
public ResilientPgClient(@Qualifier("pgDelegate") PgClient delegate) { ... }
```

`pgDelegate`라는 이름표(qualifier)가 붙은 PG를 감싼다. 원래는 `FakePgClient`(개발)나 `TossPgClient`(운영)가 프로파일로 그 자리에 들어갔다. 그렇다면 라우터를 바로 그 `pgDelegate` 자리에 끼우면 된다.

```java
@Configuration
@ConditionalOnProperty(name = "app.pg.routing.enabled", havingValue = "true")
class PgRoutingConfig {
    @Bean @Qualifier("pgDelegate")
    PgClient routingPgDelegate() {
        return new RoutingPgClient(List.of(
            PgRoute.of("primary-fake",   new FakePgClient(), 10),
            PgRoute.of("secondary-fake", new FakePgClient(), 5)));
    }
}
```

그러면 계층이 자연스럽게 합성된다.

```
PaymentService → ResilientPgClient(@Primary, 외곽 서킷·query 재시도)
              → RoutingPgClient(pgDelegate, PG별 서킷·failover)
              → [primary PG, secondary PG]
```

`@Primary`는 `ResilientPgClient` 하나로 그대로 두고, 그 아래 `pgDelegate`만 단일 PG에서 라우터로 바뀐다. 데코레이터 패턴의 힘이 여기서 나온다. 바깥 껍질은 안쪽이 하나든 라우터든 모른다.

### 5. qualifier가 둘이 되는 함정

한 가지가 더 걸렸다. `FakePgClient`는 **항상** `@Qualifier("pgDelegate")`였다. 라우터도 `pgDelegate`로 등록하면 **같은 이름표가 둘**이 되어 다시 주입이 모호해진다.

> 그래서 `FakePgClient`의 `pgDelegate` 역할을 **라우팅이 꺼졌을 때만**으로 조건화했다. `@ConditionalOnProperty(name="app.pg.routing.enabled", havingValue="false", matchIfMissing=true)`. 라우팅을 켜면 이 빈은 아예 등록되지 않고 라우터가 유일한 `pgDelegate`가 된다. 라우터 내부 경로는 자체 `new FakePgClient()`로 만든다.

토글 하나로 `FakePgClient`의 등록과 `PgRoutingConfig`의 등록이 **함께** 뒤집힌다. 언제나 하나만 `pgDelegate`가 되는 구조다.

실기동으로 확인했다.

```
APP_PG_ROUTING_ENABLED=true ./gradlew bootRun
→ PgRoutingConfig : 멀티 PG 라우팅 활성화 — 경로 2개 (가중치 순 시도, 장애 시 failover)
→ 결제 승인 → order PAID / payment DONE   (라우터의 primary 경로로 승인)
```

### 6. 남겨둔 한계: 원 PG 라우팅

하나는 남겨뒀다. 취소·조회는 원래 결제를 처리한 **그 PG**로 가야 맞다(A PG로 승인했으면 A PG로 취소). `Payment.pgProvider`에 어느 PG였는지 기록은 돼 있는데, 정작 `PgClient.cancel(paymentKey, ...)` 인터페이스가 provider를 안 받는다. 그래서 지금은 "가용한 첫 PG"로 시도한다.

> 제대로 하려면 인터페이스에 provider 힌트를 넣어 라우터가 원 PG로 보내야 한다. 인터페이스를 건드리는 일이라 [후속 과제로 명시](/blog/project/pay/pay-ch2-runtime-truths)했다. "여기까진 했고 여기부턴 안 했다"를 적는 쪽이 안 한 걸 숨기는 것보다 낫다.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있다. `app.pg.routing.enabled=true`로 라우터가 pgDelegate로 배선되어 결제가 라우팅 경로로 승인되는 것을 실기동으로 확인했다.*

### 7. 개선의 교훈

포트원 같은 결제 대행사도 멀티 PG를 세일즈 포인트로 삼는데("장애 대응 1시간 → 10초"), 보통은 **콘솔 수동 전환**이다. 여기서는 **자동** failover를 만들었고, "언제 failover하면 안 되는지"를 분명히 했다.

> "PG 장애 나면요?"에 "다른 PG로 넘겨요"는 절반의 답이다. 나머지 절반이 **"단, 타임아웃과 카드 거절엔 안 넘긴다. 이중결제와 무의미한 재시도니까"**다. 이 구분이 빠지면 failover 자체가 이중결제 경로가 된다.

---

## 가상계좌: 완료가 최종 상태가 아니었다


### 0. 입금을 기다리는 결제

앞의 셋은 우리가 부른 요청의 실패였다. 가상계좌는 반대로 **상대가 언제 움직일지 모르는** 결제다. 계좌번호를 발급하고 입금을 기다린다. 카드처럼 즉시 승인이 떨어지지 않고, 사용자가 나중에 그 계좌로 돈을 넣어야 완료된다. 상태 흐름은 `발급 → 입금대기 → 입금완료`.

기본은 웹훅 처리으로 처리한다. 입금되면 PG가 웹훅을 보내고, 우리는 "믿지 말고 조회로 재검증"해서 완료 처리한다. 여기까진 쉽다. 토스페이먼츠 문서를 파고들면 함정 둘이 나온다.

### 1. 함정 ①: 만료엔 웹훅이 안 온다

입금기한(예: 7일)이 지나면 가상계좌가 만료된다. 여기에 함정이 있다.

> **EXPIRED 상태로 바뀔 때는 웹훅이 전송되지 않는다.** (토스페이먼츠 문서에 명시돼 있다.)

이걸 모르면 "웹훅으로 다 처리하니까 만료도 웹훅 오겠지" 하고 방치하게 된다. 그러면 만료된 가상계좌가 영원히 "입금대기"로 남아 재고나 쿠폰을 물고 있다. 그래서 **자체 만료 배치**가 필요하다.

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

위 코드에서 눈여겨볼 게 있다. 만료 배치가 도는 **바로 그 순간에 입금이 도착**할 수 있다. 만료시켜야 하나, 완료시켜야 하나?

답은 [앞서 세운 원칙](/blog/project/pay/pay-ch1-what-to-trust) 그대로다. **믿지 말고 PG에 조회.** 만료 대상이라도 조회해서 실제로 입금됐으면(APPROVED) 만료시키지 않고 완료 처리한다. dueDate만 보고 기계적으로 만료시키면 방금 입금한 사용자의 돈이 붕 뜬다.

> "가상계좌 만료 어떻게 처리하세요?"에 대한 답이 이것이다. "EXPIRED 웹훅이 없어서 배치로 감지하고, 만료 직전에 조회로 재확인해서 늦은 입금과의 레이스를 해소합니다." 문서를 대충 읽으면 절대 안 나오는 디테일이다.

### 3. 함정 ②: DONE에서 되돌아온다

두 번째 함정은 더 미묘하다.

> 일부 은행(신한 등)은 **입금 실패인데 DONE을 먼저 보낸 뒤, 최대 2분 후 되돌리는** 통보를 한다. `DONE → 입금대기`로 상태가 역전이되는 것이다.

보통 상태머신은 "완료(DONE)는 최종 상태"라고 가정한다. 가상계좌는 아니다. 그래서 상태머신에 **역전이를 허용 전이로** 넣었다.

```java
DONE → { WAITING_FOR_DEPOSIT, CANCELED }   // 은행 지연 통보로 인한 역전이
```

역전이가 오면 이미 보낸 "결제 완료" 후속 처리(알림, 포인트 적립 등)를 되돌려야 한다. 상태 전이 이력과 [보상 트랜잭션](/blog/project/pay/pay-ch1-what-to-trust) 발상이 여기서도 쓰인다.

### 4. 정리

가상계좌는 "입금 기다리기"라는 단순해 보이는 기능에 실무 함정이 숨어 있다.

| 함정 | 대응 |
|---|---|
| EXPIRED엔 웹훅 없음 | 자체 만료 배치(dueDate 스캔) |
| 만료-입금 레이스 | 만료 직전 조회로 재확인 |
| DONE→입금대기 역전이 | 상태머신에 역전이 허용 + 후속 처리 보상 |

> 세 가지 모두 문서 구석에서 건진 것들이다. "가상계좌 붙였어요"에서 멈추면 이 셋은 만나지 않는다. [이 시리즈의 원칙](/blog/project/pay/pay-ch1-what-to-trust), "웹훅을 믿지 말고 조회로 확정한다"·"실패/역전이를 상태머신에 새긴다"가 그대로 재사용됐다.

---

## 남는 생각

셋 다 같은 질문으로 갈렸다. **무엇이 확정됐고 무엇이 미상인가.**

- **타임아웃**은 결과를 *모르는* 실패다. 그래서 재시도하면 이중결제고, `UNKNOWN`으로 보존해 조회가 확정한다
- **승인 후 재고 부족**은 결과가 *확정된* 실패다. 다만 외부에서 일어나 롤백이 안 되니 보상으로 되돌린다
- **failover**는 PG가 요청을 *못 받은 게 확실할 때만* 한다. 타임아웃과 카드 거절에는 넘기지 않는다
- **가상계좌 만료**는 PG가 *알려주지 않는* 상태다. 배치로 감지하되 만료 직전에 조회로 다시 묻는다

"재시도 가능/불가"라는 이분법으로는 이 셋을 못 가른다. 뒤에서 데드락을 만났을 때
바로 이 기준으로 "재시도해도 되는 실패"라고 판정할 수 있었다(4편).

그리고 모든 실패 경로가 한 곳(`UNKNOWN` → 복구)으로 수렴하게 만든 게 이 설계의 요점이다.
실패의 종류마다 다른 특수 처리를 흩뿌리지 않았다.

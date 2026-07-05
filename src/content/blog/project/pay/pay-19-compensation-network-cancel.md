---
title: '돈은 나갔는데 주문이 사라지면 — 승인 후 재고 부족과 자동 망취소'
titleEn: "When the Money Left but the Order Vanished — Post-Approval Stock Failure and Auto Network-Cancel"
description: 결제 시스템 개선기. 카드 승인은 성공했는데 그 직후 재고 차감이 품절로 실패하면? 트랜잭션을 롤백해봐야 PG에서 이미 빠져나간 카드 승인은 되돌아오지 않는다 — 고객은 결제됐는데 주문은 사라진다. 이 불일치를 durable한 보상 태스크와 자동 망취소로 메운 이야기. 그리고 그 과정에서 만난, "잡은 예외가 트랜잭션을 오염시킨다"는 Spring의 함정.
descriptionEn: "Payment system improvement log. The card was approved, but stock deduction fails right after due to a race. Rolling back the transaction doesn't un-charge the card that already left the PG — the customer paid but the order vanished. A story of closing that gap with a durable compensation task and automatic network-cancel, and the Spring pitfall I hit along the way: a caught exception poisoning the transaction."
date: 2026-08-01T00:00:00.000Z
tags:
  - Payment
  - Compensation
  - Saga
  - Transaction
  - Spring Modulith
  - Resilience
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 19
---

*결제 시스템 시리즈. 개선기 — 보상 트랜잭션과 자동 망취소.*

## 0. 남겨둔 한 줄

승인 흐름을 만들 때, `CheckoutService`엔 이런 주석이 있었어요.

```java
// 차감 실패(품절 경합)는 예외 → Phase 2의 망취소/보상 트랜잭션으로 승격.
```

이번 편은 그 "Phase 2"예요. 왜 이걸 미뤄뒀냐면, 이게 결제 시스템에서 **가장 위험한 순간** 중 하나이기 때문이에요.

## 1. 위험한 순간: 승인 성공 → 재고 부족

주문 승인의 순서를 다시 보면요.

1. 포인트 선점
2. **카드 승인** (PG 호출 — 외부)
3. 재고 차감
4. 주문 PAID

문제는 2와 3 사이예요. **카드는 이미 승인됐는데(2), 재고 차감(3)이 품절 경합으로 실패**하면 어떻게 될까요?

원래 코드는 재고 차감 실패 시 예외를 던졌고, `@Transactional`이 전부 롤백됐어요. 그런데 여기서 무서운 게 있어요.

> `@Transactional`이 롤백하는 건 **DB뿐**이에요. 하지만 2번의 카드 승인은 **PG(외부 시스템)에서 이미 일어났어요.** DB를 롤백해도 PG의 승인은 되돌아오지 않아요. 결과는 — **고객 카드에서는 돈이 빠져나갔는데, 우리 DB엔 주문이 없는** 상태. 고객 입장에선 "결제했는데 아무것도 못 받은" 최악의 경험이죠.

이게 분산 트랜잭션의 본질적 문제예요. 우리 DB와 PG는 **한 트랜잭션으로 묶을 수 없어요.** 그래서 "둘 중 하나가 이미 커밋됐는데 다른 하나가 실패"하는 순간을, 롤백이 아니라 **보상(compensation)**으로 풀어야 해요.

## 2. 해법: 롤백 대신 자동 망취소

방향을 바꿨어요. 재고 차감이 실패하면 —

- 롤백하지 **않고**,
- 이미 승인된 카드를 **취소(망취소)**하는 걸로 되돌려요.

그런데 망취소도 PG 호출이라 **또 실패할 수 있어요.** 네트워크가 끊길 수도, PG가 잠깐 죽었을 수도 있죠. 그래서 망취소를 "지금 한 번 시도하고 끝"이 아니라, **durable하게 적재해두고 성공할 때까지 재시도**하는 구조로 만들었어요. 이게 `compensation_tasks` 테이블이에요 — outbox 패턴의 사촌이죠.

흐름은 이렇게 돼요.

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

핵심은 **"내부적이고 확실한 것"과 "외부적이고 불확실한 것"을 나눈** 거예요. 포인트 복원은 우리 DB 안이라 즉시 확실하게 처리하고, PG 망취소만 durable 재시도 큐로 뺐어요. 불확실한 것만 재시도 인프라에 태우는 거죠.

## 3. 진짜 함정: 잡은 예외가 트랜잭션을 오염시킨다

여기서 예상 못 한 벽에 부딪혔어요. 처음엔 이렇게 짰어요.

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

"예외를 잡아서 삼켰으니 트랜잭션은 커밋되겠지" 했는데 — **안 됐어요.** 최종 커밋에서 `UnexpectedRollbackException`이 터지고, 보상 태스크 적재까지 다 롤백됐어요.

원인은 Spring 트랜잭션의 미묘한 규칙이었어요.

> `deductConditional`은 `@Transactional` 메서드고, 바깥 트랜잭션에 **참여(join)**해요. 이게 예외를 던지는 순간, Spring은 **공유 트랜잭션을 rollback-only로 표시**해요. 바깥에서 그 예외를 잡아도, 트랜잭션은 이미 "이건 무조건 롤백"으로 낙인이 찍힌 상태예요. 그래서 커밋 시도가 `UnexpectedRollbackException`으로 실패하죠.

즉 **"잡았다"고 없던 일이 되는 게 아니에요.** 참여 트랜잭션 안에서 던져진 예외는, 잡아도 전체를 오염시켜요.

해법은 애초에 **예외를 던지지 않는 것**이었어요. 조건부 차감을 boolean으로 바꾼 `tryDeduct`를 새로 만들었죠.

```java
/** 예외 없는 조건부 차감 — 성공 true, 재고부족 false. */
@Transactional
public boolean tryDeduct(long productId, int qty) {
    return stockRepository.deductConditionally(productId, qty) > 0;
}
```

이제 체크아웃 경로는 예외 대신 **boolean 분기**로만 흘러요. 트랜잭션을 오염시키는 예외가 없으니, 보상 상태(승인된 결제 + 보상 태스크)가 온전히 함께 커밋돼요. 기존 `deductConditional`(예외 버전)은 다른 호출부를 위해 그대로 뒀고요.

이건 저한텐 꽤 큰 배움이었어요. "예외를 잡으면 안전하다"는 직관이 **트랜잭션 경계 안에서는 틀린다**는 것 — 문서로 아는 것과 커밋이 터지는 걸 직접 보는 건 다르더라고요.

## 4. 무한 재시도를 막는 멱등

재시도 구조엔 함정이 하나 더 있어요. 망취소를 재시도하다가, 이미 다른 경로로 취소된 결제를 또 취소하려 하면? 이 프로젝트의 취소는 "성공한 결제가 없으면 `PAYMENT_NOT_FOUND`"를 던져요. 이걸 실패로 처리하면 **영원히 재시도**하게 돼요 — 이미 취소된 걸 계속 취소하려고요.

그래서 이렇게 처리했어요.

```java
} catch (PaymentException e) {
    if ("PAYMENT_NOT_FOUND".equals(e.code())) {
        task.markDone();   // 취소할 게 없다 = 이미 보상됨 → 완료로 간주(멱등)
    } else {
        throw e;           // 그 외 예외만 재시도 대상
    }
}
```

"취소할 결제가 없다"는 건 실패가 아니라 **이미 목적이 달성된 상태**예요. 보상 작업에서 멱등성은 이렇게 "재시도해도 같은 결과"를 보장하는 안전장치예요.

## 5. 소진하면 멈춘다 — 그리고 알린다

지수 백오프로 재시도하되, `maxRetries`(5회)를 넘으면 태스크를 `FAILED`로 두고 **더는 자동 재시도하지 않아요.** 대신 `compensation.exhausted` 카운터를 올려요.

```java
if (task.isExhausted()) {
    meterRegistry.counter("compensation.exhausted").increment(); // 알림 룰의 소스
}
```

무한 재시도는 그 자체가 장애를 키워요(죽은 PG를 계속 때리기). 그래서 "자동으로 될 만큼 해보고, 안 되면 사람을 부른다"로 경계를 그었어요. 이 카운터가 0보다 크면 운영이 개입해야 한다는 신호예요 — [운영 관측성 편](/blog/project/pay/pay-6-operations)에서 만든 메트릭 기반 알림의 연장선이죠.

스케줄러 자체는 `app.compensation.enabled` 프로퍼티로 켜고 꺼요. 기본은 꺼둬서 테스트·로컬 부팅에 부작용이 없고, 운영에서만 환경변수로 켜요. [복구 배치](/blog/project/pay/pay-2-designing-for-failure)와 같은 방식이에요 — 배치 로직은 순수 메서드로 두고 테스트는 직접 호출해요.

## 마치며

이번 건 결제 시스템에서 **"두 시스템을 한 트랜잭션으로 묶을 수 없다"**는 현실을 정면으로 다룬 편이었어요. 카드 승인(PG)과 재고 차감(DB)이 각자 다른 세계에 있으니, 둘의 불일치는 롤백이 아니라 보상으로만 풀려요.

그리고 그 보상을 안전하게 만들려다 Spring 트랜잭션의 함정(참여 트랜잭션의 rollback-only 오염)을 정면으로 만났고, "예외를 안 던지는 설계"로 우회했어요. 결제에서 **부분 실패를 어떻게 봉합하느냐**가 결국 신뢰성의 대부분이라는 걸, 이 한 시나리오가 압축해서 보여준 것 같아요.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, 보상 흐름은 14개의 단위 테스트로 검증했습니다.*

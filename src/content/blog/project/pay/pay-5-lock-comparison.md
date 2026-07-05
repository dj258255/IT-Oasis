---
title: '재고 차감 락 3종, 수치로 골랐다 — 조건부 UPDATE가 이겼다'
titleEn: "Choosing Among Three Stock-Deduction Locks by the Numbers — Conditional UPDATE Won"
description: 결제 시스템 Phase 5. "동시에 1000명이 결제하면?"에 감이 아니라 수치로 답한다. 재고 차감을 비관적 락·낙관적 락·조건부 UPDATE 세 방식으로 구현하고, 실제 스레드로 동시에 두들겨 초과판매 여부와 소요 시간을 실측했다. 셋 다 초과판매는 0이었지만 속도는 조건부 UPDATE 8ms < 낙관적 17ms < 비관적 32ms. 그리고 낙관적 락은 고경합에서 미달판매가 나는 함정까지. 그래서 조건부 UPDATE를 기본 전략으로 배선했다.
descriptionEn: "Payment system Phase 5. Answering 'what if 1000 people pay at once?' with numbers, not intuition. I implemented stock deduction three ways — pessimistic lock, optimistic lock, conditional UPDATE — and hammered them with real concurrent threads, measuring oversell and latency. None oversold, but speed was conditional UPDATE 8ms < optimistic 17ms < pessimistic 32ms. Plus the trap where optimistic locking undersells under high contention. So I wired conditional UPDATE in as the default."
date: 2026-07-10T00:00:00.000Z
tags:
  - Payment
  - Concurrency
  - Locking
  - Performance
  - Load Testing
  - Java
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 5
---

*결제 도메인 취업을 목표로 실전 결제 시스템을 밑바닥부터 만드는 시리즈. 이 글은 5편 — 동시성 락을 수치로 고른 이야기.*

## 0. "동시에 1000명이 결제하면?"

결제·재고 도메인 면접의 단골 질문이에요. [Phase 4](/blog/project/pay/pay-4-ledger-settlement-reconciliation)까지 코어를 다 만들었으니, 이제 이걸 **빠르고 안전하게** 만들 차례예요.

재고 차감은 동시 요청이 몰리는 지점이에요 — 선착순, 인기 상품. 여기서 뭐가 무서우냐면 **초과 판매(oversell)**예요. 재고 1개인데 두 명이 동시에 결제에 성공하면, 있지도 않은 물건을 판 거죠. 이걸 막는 방법이 여럿인데, 저는 **셋을 다 만들어서 수치로 골랐어요.**

## 1. 후보 3종

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

## 2. 실제 스레드로 두들긴 실측

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

## 3. 왜 이 순서인가

- **조건부 UPDATE가 최속**이에요. 락도 재시도도 없이 **DB 한 번의 원자적 UPDATE**로 끝나요. `WHERE quantity >= 1` 조건이 차감과 검사를 한 문장에 묶어서, 경합이 있어도 DB가 알아서 직렬화해줘요.
- **비관적 락이 최저속**이에요. 행을 잠그고(SELECT FOR UPDATE), 트랜잭션을 왕복하고, 커넥션을 오래 점유해요. 안전하지만 무거워요.
- **낙관적 락은 중간**인데, 여기 **함정**이 있어요.

> 낙관적 락은 스레드를 150개로 올리면 **미달판매**가 나요. 재시도를 다 소진해서, 재고가 남았는데도 차감에 실패하는 거예요. 초과판매(위험)는 아니지만 손해죠. 그리고 재시도 폭증 자체가 부하예요. **인기 상품 재고처럼 한 행에 몰리는 hot row에는 낙관적 락이 부적합**하다는 게 수치로 드러나요.

## 4. 그래서 조건부 UPDATE를 배선했다

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

## 5. 그리고 엔드투엔드 부하테스트

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

## 다음 — Phase 6: 운영

이제 마지막이에요. 만든 걸 **운영**하는 편.

```
관측성      결제 성공률·p99·서킷 상태를 Micrometer→Prometheus→Grafana로
백오피스     DLQ 재처리 같은 운영 도구
```

"결제는 만들고 나서가 진짜"라는 편이에요. 이어서 마무리합니다.

---

*이 글은 작성 중인 시리즈의 일부예요. 락 비교는 H2 인메모리로 결정적으로 실측했고, 전략 간 상대 우열은 실 DB에서도 동일하게 재현됩니다.*

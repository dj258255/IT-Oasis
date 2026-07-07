---
title: 'ADR로 "안다"고 적어놓고 — 크라운주얼 체크아웃을 진짜 사가로 뜯다'
titleEn: 'I Wrote "I Know" in an ADR — Then Actually Refactored the Crown-Jewel Checkout Into a Saga'
description: 결제 시스템 개선기. 체크아웃이 외부 PG 승인을 DB 트랜잭션 안에서 호출하는 안티패턴을, 처음엔 ADR로 "알지만 모놀리스라 의도적으로 둔다"고 문서화만 했다. 그런데 "그래서 진짜 뜯은 거야?"라는 물음에, 실제로 3단계 사가로 재작성했다 — 예약(tx) → PG 승인(트랜잭션 밖) → 확정/보상(tx). 느린 PG가 커넥션 풀을 말려 앱 전체를 마비시키는 연쇄 장애를 막는다. 그리고 원자성을 포기한 대가인 "멈춘 사가"를 복구하는, 사가의 진짜 어려운 부분까지 코드로.
descriptionEn: "Payment system improvement log. The checkout called the external PG inside a DB transaction — an anti-pattern I first only documented in an ADR as a deliberate monolith trade-off. But asked 'so did you actually pull it out?', I refactored it into a real three-phase saga: reserve (tx) → PG approve (outside tx) → settle/compensate (tx). It stops a slow PG from draining the connection pool and taking down the whole app. And it handles the genuinely hard part — recovering the 'stuck saga' left when you give up atomicity."
date: 2027-03-13T00:00:00.000Z
tags:
  - Payment
  - Saga
  - Transaction
  - Resilience
  - Refactoring
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 51
---

*결제 시스템 시리즈. 개선기 — 문서로 남긴 안티패턴을 코드로 뜯다.*

## 0. "그래서 진짜 뜯은 거야?"

체크아웃이 **외부 PG 승인(HTTP)을 DB 트랜잭션 안에서** 호출하고 있었어요. 이건 [알려진 안티패턴](/blog/project/pay/pay-50-hardening-verified)이라, 처음엔 [ADR](https://github.com/dj258255/payment-system)로 이렇게 정리했어요 — "안티패턴은 알지만, 모놀리스라 ACID 원자성을 위해 의도적으로 단일 트랜잭션을 두고, fast-fail·서킷으로 완화한다."

판단으로는 괜찮았어요. 그런데 되물음이 왔죠.

> "그래서 **진짜 트랜잭션 꺼낸 거야?** ADR만 쓴 거 아니고?"

맞아요, ADR만 썼었어요. 코드는 그대로였고요. "안다"를 적었지 "했다"를 한 게 아니었죠. 그래서 진짜로 뜯었어요. 이번 편은 그 기록이에요.

## 1. 어떤 문제였나 — 구체적으로

평상시엔 아무 문제 없어요. PG가 100ms에 응답하면 커넥션 100ms 점유하고 끝. 문제는 **PG 브라운아웃**(죽진 않고 느려지는 것)이에요.

> 토스가 장애가 아니라 **지연**만 생겨서 응답이 2~3초로 늘어난다고 해봐요. 이제 체크아웃 하나당 DB 커넥션을 2~3초씩 붙잡아요. Hikari 풀은 20개인데, 초당 체크아웃 10건 × 3초면 커넥션이 고갈돼요. 그럼 체크아웃뿐 아니라 **주문 조회·어드민·다른 모든 DB 요청**이 커넥션을 못 얻어 앱 전체가 멈춰요. **느린 PG 하나가 서비스 전체를 다운**시키는 거죠.

제일 뼈아픈 건, 제가 "완화됐다"던 장치들이 이걸 **못 막는다**는 거였어요.

- **서킷브레이커**는 PG가 *에러*를 낼 때만 열려요. 느리지만 성공하는 브라운아웃은 에러가 아니라 안 열려요.
- **fast-fail 3초**는 커넥션을 *얻을 때까지* 기다리는 상한이지, *붙잡는 시간*이 아니에요.

즉 "외부 콜을 트랜잭션 안에 두지 마라"는 규칙은, 실제 장애를 일으키는 진짜 위험이었어요.

## 2. 3단계 사가 — 트랜잭션을 쪼개다

해법은 PG 콜을 트랜잭션 **밖**으로 빼는 거예요. 체크아웃을 3단계로 쪼갰어요.

```java
public CheckoutResult confirm(...) {
    // Phase 1 (tx): 예약 — 검증·주문잠금·포인트선점·결제 IN_PROGRESS 적재. 커밋 후 커넥션 반납.
    var reservation = checkoutTx.reserve(...);

    // Phase 2 (tx 밖): PG 승인 — 이 동안 DB 커넥션 0개 점유
    var outcome = paymentService.pgApprove(...);

    // Phase 3 (tx): 확정/보상 — 결과 반영·재고차감·PAID 또는 롤백
    return checkoutTx.settle(reservation.paymentId(), ..., outcome);
}
```

이제 느린 PG여도 **DB 커넥션을 안 잡으니 풀이 안 말라요.** 체크아웃만 (PG 기다리느라) 느려질 뿐, 앱 전체는 멀쩡해요. 폭발 반경이 격리된 거죠.

배선에서 신경 쓴 건 **모듈 경계**였어요. PG 결과 타입(`PgApproveResult`)은 payment 모듈 내부라, order가 참조하면 [Modulith 경계](/blog/project/pay/pay-21-ci-guards-boundaries)가 깨져요. 그래서 노출용 `ApprovalOutcome`을 payment 루트에 두고, order는 그걸 **불투명하게** Phase 2에서 Phase 3로 건네요. 그리고 `CheckoutService`는 클래스 `@Transactional`을 떼서 오케스트레이터로, 트랜잭션 경계(`reserve`/`settle`)는 별도 빈(`CheckoutTx`)에 뒀어요 — [자기호출이면 트랜잭션이 우회되니까](/blog/project/pay/pay-47-webhook-async).

## 3. 진짜 어려운 부분 — 멈춘 사가 복구

사가엔 공짜가 없어요. **원자성을 포기**하는 순간, 새 크래시 엣지케이스가 생겨요.

> Phase 1에서 포인트 예약이 커밋됐는데, Phase 3 전에 앱이 죽으면? 주문은 `PAYMENT_IN_PROGRESS`로, 결제는 `IN_PROGRESS`로, 포인트는 예약된 채 **어중간하게 멈춘 사가**가 남아요. 단일 트랜잭션이면 크래시 시 깔끔히 롤백됐을 텐데, 사가는 이 멈춘 상태를 **직접 복구**해야 해요. 여기까지 안 하면 오히려 회귀예요 — 포인트가 뜬 채 새어나가니까.

이게 사가의 진짜 비용이에요. 복구 배치를 만들었어요.

```java
// PAYMENT_IN_PROGRESS로 멈춘 주문을 스캔 → 카드 결제를 PG 조회로 확정 → settle 재실행
Optional<StuckPaymentInfo> info = paymentService.resolveStuckPayment(orderNo);
long cardAmount = info.map(amount).orElse(0);
long pointAmount = order.getTotalAmount() - cardAmount;  // 금액 불변식에서 도출
checkoutTx.settle(orderNo, ..., cardAmount, pointAmount, info.map(outcome).orElse(null));
```

PG 조회로 실제 결과를 확정한 뒤, **같은 `settle`을 재실행**해요. 승인됐으면 완결(재고차감·PAID), 실패면 롤백(포인트 복원·PENDING 복귀). `settle`이 재진입 가능한 게 핵심이에요 — 결제 확정(`applyResult`)이 [멱등](/blog/project/pay/pay-49-audit-round2)(IN_PROGRESS일 때만 전이)이라, 복구가 몇 번 돌아도 안전해요.

## 4. 라이브로 증명

말로만 "된다"가 아니라, [실기동으로](/blog/project/pay/pay-26-persistence-bug) 두 경로를 확인했어요.

```
정상 체크아웃 → order PAID / payment DONE           (3단계 사가 정상)
멈춘 사가(주문 IN_PROGRESS + 결제 IN_PROGRESS) 심음
→ 복구 배치 → PG 조회(NOT_FOUND) → 주문 PENDING_PAYMENT / 결제 ABORTED   (롤백 완결)
로그: "멈춘 체크아웃 복구 완료 recovered=1"
```

멈춘 사가가 실제로 롤백되어 재시도 가능 상태로 돌아왔어요. 크래시 복구까지 코드로 도는 걸 확인한 거죠. 테스트 451개, 기존 체크아웃 동작(성공·미확정·거절·재고부족 보상·복합결제)도 같은 단언으로 전부 보존됐고요.

## 마치며

이번 건은 "안다"를 "한다"로 바꾼 거예요. ADR로 안티패턴을 인지한 것도 시니어 시그널이지만, **되물음에 밀려** 크라운주얼을 실제로 사가로 뜯고, 그 대가(멈춘 사가 복구)까지 감당한 게 진짜 배움이었어요.

두 가지가 남아요. 하나는 **판단과 실행은 다른 근육**이라는 것 — "이 규모엔 안 해도 된다"는 판단은 옳았지만, "그래도 할 수 있다"를 코드로 보이는 건 또 다른 일이에요. 다른 하나는 **사가는 공짜가 아니라는 것** — 원자성을 커넥션 점유와 맞바꾸면, 그 순간부터 멈춘 사가를 복구하는 책임이 따라와요. 그 책임까지 져야 비로소 "사가로 풀었다"고 말할 수 있더라고요.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, 3단계 사가 정상 흐름과 멈춘 사가 복구를 실 MySQL로 검증했습니다(ADR-007에 배경·이행 기록).*

---
title: '"승인됐습니다"라고 답했지만 DB엔 없었다 — 실기동이 드러낸 결제 확정 버그'
titleEn: 'It Said "Approved" but the DB Disagreed — A Payment-Persistence Bug the Live Run Exposed'
description: 결제 시스템 개선기. 새 기능을 실기동으로 눌러보다, API는 "결제 완료(PAID)"라고 응답하는데 DB에는 주문이 PENDING_PAYMENT로 남아 있는 걸 발견했다. 결제 승인이 실제로는 확정되지 않고 있었다. 트랜잭션은 커밋되는데 UPDATE SQL이 안 나가는 이 버그의 정체와, 리포지토리를 목으로 둔 단위 테스트가 왜 이걸 못 잡았는지에 대한 기록.
descriptionEn: "Payment system improvement log. While exercising a new feature end-to-end, I found the API responding 'PAID' while the DB kept the order at PENDING_PAYMENT — payment approvals weren't actually being committed. A record of this bug where the transaction commits but no UPDATE is issued, and why repository-mocked unit tests never caught it."
date: 2026-09-19T00:00:00.000Z
tags:
  - Payment
  - JPA
  - Hibernate
  - Debugging
  - Testing
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 26
---

*결제 시스템 시리즈. 개선기 — 실기동이 드러낸 치명 버그.*

## 0. 구매확정이 자꾸 막혔다

[에스크로](/blog/project/pay/pay-25-escrow)를 붙이고 실기동으로 흐름을 눌러봤어요. 주문 생성 → 결제 승인 → **구매확정**. 그런데 구매확정이 자꾸 막혔어요.

```
POST /api/v1/orders/{orderNo}/confirm-purchase
→ 409 "결제 완료 주문만 구매확정할 수 있습니다."
```

이상했어요. 바로 전에 결제 승인 응답은 분명 이랬거든요.

```json
{ "orderNo": "...", "orderStatus": "PAID", "paymentStatus": "DONE", "message": "승인 완료" }
```

**PAID라고 응답했는데, 구매확정은 "PAID가 아니다"라며 막아요.** 뭔가 앞뒤가 안 맞았어요. DB를 직접 열어봤죠.

```sql
SELECT status FROM orders   WHERE order_no='...';  -- PENDING_PAYMENT  (?!)
SELECT status FROM payments WHERE order_no='...';  -- IN_PROGRESS      (?!)
```

응답은 `PAID`/`DONE`인데 **DB는 `PENDING_PAYMENT`/`IN_PROGRESS`.** 결제 승인이 실제로는 **DB에 확정되지 않고 있었어요.** 결제 시스템에서 이건 최악의 종류예요 — "됐다고 답했는데 실제론 안 된" 상태니까요.

## 1. 이상한 단서: 트랜잭션은 커밋되는데 UPDATE가 없다

먼저 상태머신을 의심했어요. 그런데 `PAID → PENDING_PAYMENT`는 우리 상태 전이표상 **불가능한 전이**예요. 즉 "PAID였다가 되돌아간" 게 아니라, **애초에 PAID가 저장된 적이 없다**는 뜻이었어요.

응답의 `orderStatus`는 서비스가 메모리에 들고 있는 `order.getStatus()`로 만들어요. 그건 `PAID`. 그런데 DB엔 반영이 안 됐어요. 그럼 트랜잭션이 롤백됐나?

아니었어요. 트랜잭션 디버그 로그를 켜보니 —

```
Creating new transaction [CheckoutService.confirm]
Participating in existing transaction (...)
Initiating transaction commit
Committing JPA transaction on EntityManager [...]
```

**트랜잭션은 정상적으로 생성되고 커밋**됐어요. 그런데 SQL 로그를 보니 —

```
insert into payments (...)          ← startApproval: IN_PROGRESS
insert into payment_history (...)   ← 이력
insert into payment_history (...)   ← approve()가 남긴 두 번째 이력
update stock ...                    ← 재고 차감(명시 쿼리)
...
(update payments set status=DONE  → 없음!)
(update orders  set status=PAID   → 없음!)
```

**INSERT는 나가는데, 상태를 바꾸는 UPDATE만 안 나가요.** 트랜잭션이 커밋되는데도 dirty-checking이 만들어야 할 UPDATE가 없었어요.

## 2. 왜 INSERT는 되고 UPDATE는 안 될까

여기서 실마리가 잡혔어요. 이 프로젝트의 엔티티는 `@GeneratedValue(strategy = IDENTITY)`를 써요. **IDENTITY 전략은 `persist()` 시점에 즉시 INSERT를 실행**해요(DB가 생성한 ID를 바로 받아와야 하니까). 그래서 신규 엔티티의 INSERT는 flush 여부와 무관하게 즉시 나가요.

반면 **기존 엔티티의 상태 변경(UPDATE)은 커밋 시점의 flush에 의존**해요. 그 flush가 안 일어나면 UPDATE가 안 나가죠.

즉 문제는 **"이 트랜잭션의 영속성 컨텍스트가 커밋 때 변경분을 flush하지 않는다"**였어요. IDENTITY 즉시 INSERT가 이 문제를 가려서, "주문 행은 있으니 저장은 되는 줄" 착각하게 만든 거예요.

원인을 좁히니 두 가지가 얽혀 있었어요.

> 이 프로젝트는 [OSIV를 껐어요](/blog/project/pay/pay-17-load-test-finds-bottleneck)(`open-in-view: false`, 커넥션 점유 방지). 이 환경에서 서비스 트랜잭션 안의 세션이, 코드가 finder로 불러온 엔티티의 변경을 커밋 시 자동으로 flush하지 못하는 상황이 생겼어요. 그래서 `order.markPaid()`, `payment.approve()` 같은 **dirty-checking 변경이 메모리에만 남고 사라진** 거예요.

## 3. 고치기: 애그리거트를 명시적으로 영속

해법의 방향은 분명했어요 — **dirty-checking의 자동 flush에 의존하지 말고, 상태를 바꾼 애그리거트를 명시적으로 저장**하자.

```java
// 상태 전이(approve/abort/markUnknown)를 명시적으로 영속한다.
paymentRepository.saveAndFlush(payment);
```

처음엔 `save()`로 했는데, 여기서 재밌는 걸 발견했어요. **`save()`로 되는 곳과 안 되는 곳이 갈렸어요.**

- `findByOrderNo`로 **불러온(detached)** 엔티티(주문·에스크로 홀드)는 `save()`(=merge)로 확정됐어요.
- 반면 `initiate`로 새로 만들어 persist한 **managed** 엔티티(결제)는 `save()`가 merge no-op이 되어 **확정되지 않았어요.**

이 트랜잭션에서 자동 flush가 신뢰할 수 없다는 게 드러난 거예요. 그래서 **모든 애그리거트 상태 확정 지점을 `saveAndFlush`로 통일**했어요 — merge 여부와 무관하게 flush를 강제하니까요. 결제 시스템에서 "가끔 되고 가끔 안 되는" 저장은 용납할 수 없죠.

같은 버그가 confirm뿐 아니라 **취소·복구 배치·에스크로·가상계좌·구독**에도 다 있었어요("불러와서 상태만 바꾸는" 모든 곳). 전수 조사해서 한꺼번에 고쳤어요.

고친 뒤 실기동으로 다시 확인했어요.

```
승인      → 주문 PAID,     결제 DONE,             에스크로 RELEASED   ✓
전액취소  → 주문 CANCELED, 결제 CANCELED(잔액 0),  에스크로 REFUNDED   ✓
부분취소  → 주문 PAID,     결제 PARTIAL(잔액 7천), 에스크로 HELD 유지   ✓
```

이제 응답과 DB가 일치해요.

## 4. 왜 여태 안 잡혔나 — 테스트의 사각지대

제일 뼈아픈 질문. **테스트가 200개가 넘는데 왜 이걸 못 잡았지?**

답은 테스트의 성격에 있었어요. 이 프로젝트의 단위 테스트는 **리포지토리를 목(mock)으로** 둬요.

```java
OrderRepository orderRepository = mock(OrderRepository.class);
// order.markPaid() 후 상태가 PAID인지 "메모리에서" 검증
assertThat(order.getStatus()).isEqualTo(OrderStatus.PAID);  // 통과!
```

이 테스트는 **"서비스 로직이 order를 PAID로 바꿨는가"**를 검증해요. 그건 맞았어요. 하지만 **"그게 실제 DB에 반영됐는가"**는 목이라서 검증할 수가 없어요. dirty-checking flush 같은 **영속성 계층의 동작은, 진짜 DB를 써야만 드러나거든요.**

그래서 이 버그는 단위 테스트의 사각지대에 정확히 숨어 있었어요. [부하테스트(k6)](/blog/project/pay/pay-17-load-test-finds-bottleneck)도 HTTP 200만 봤지 DB 상태는 안 봤고요. **에스크로가 "주문이 PAID여야 한다"는 조건을 실제로 요구하면서, 실기동에서 처음 터진** 거예요.

교훈을 두 가지로 정리했어요.

- **목 기반 단위 테스트는 "로직"을 검증하지 "영속"을 검증하지 못한다.** 상태 전이가 DB에 남는지는 실 DB 통합 테스트로만 확인된다. 그래서 재발 방지로, 각 수정 지점에 `verify(repo).saveAndFlush(...)` 단언을 넣어 최소한 "명시 저장을 호출한다"는 계약을 고정했어요.
- **기능은 끝까지 눌러봐야 한다.** "API가 200을 준다"와 "DB에 올바르게 남는다"는 다른 얘기예요. E2E 실기동으로 실제 상태를 확인하지 않았다면, 이 버그는 운영에서 "결제됐다는데 주문이 없어요" 문의로 터졌을 거예요.

## 마치며

이번 건 새 기능은 아니에요. 오히려 **이미 있던 가장 위험한 버그를 실기동으로 잡아낸** 편이에요.

결제 시스템에서 "승인됐습니다"라는 응답은 약속이에요. 그 약속이 DB에 확정되지 않으면, 그건 거짓말이 되죠. 트랜잭션이 커밋되는데도 변경이 유실될 수 있다는 것, 그리고 그걸 목 테스트는 못 잡는다는 것 — 이 두 가지를 실제 장애가 아니라 **실기동 검증에서** 만난 게 다행이었어요.

가장 좋은 개선은, 터지기 전에 찾아서 고친 버그더라고요.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, 수정 후 승인/취소/부분취소/구매확정을 실 MySQL로 전수 검증했습니다.*

---
title: '재감사 2회차 — 부분취소만 멱등이 아니었고, 내가 2년 전에 쓴 설명이 틀렸다'
titleEn: 'Audit Round Two — Only Partial Cancels Weren’t Idempotent, and an Explanation I Wrote Two Years Ago Was Wrong'
description: 결제 시스템 개선기. "더 있나?" 재감사를 이어가다 둘을 더 잡았다. 하나는 정산 취소 반영에서 전액취소는 멱등인데 부분취소만 아니어서 재배달 시 이중 차감되던 것. 델타 차감을 취소 후 잔액(절대값) 세팅으로 바꿔 대칭 멱등으로 만들었다. 다른 하나는 더 뼈아팠다 — 예전에 "saveAndFlush가 필요한 건 OSIV를 꺼서다"라고 설명한 블로그가 있는데, 재감사에서 그게 기술적으로 틀렸다는 걸 알았다. 진짜 원인은 OSIV가 아니라 FlushMode였다.
descriptionEn: "Payment system improvement log. Continuing the 'is there more?' audit, I caught two more. One: in settlement cancellation, full cancels were idempotent but partial cancels weren’t, double-deducting on redelivery. I switched delta subtraction to setting the post-cancel absolute balance. The other stung more — a blog I'd written explained that saveAndFlush is needed because OSIV is off, and the audit showed that’s technically wrong. The real cause was FlushMode, not OSIV."
date: 2027-02-27T00:00:00.000Z
tags:
  - Payment
  - Idempotency
  - Transaction
  - Code Review
  - Honesty
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 49
---

*결제 시스템 시리즈. 개선기 — 재감사가 더 찾아낸 둘.*

## 0. 한 번 더 봤더니 또 있었다

[재감사에서 정산 날짜 키 버그를 잡고](/blog/project/pay/pay-48-settlement-date-key-bug) "이제 됐나?" 하고 같은 눈으로 한 번 더 훑었어요. 둘이 더 나왔어요. 하나는 정산의 멱등성 구멍, 다른 하나는 — **제가 예전에 쓴 설명이 틀렸다는 것**이었어요.

## 1. 전액취소는 멱등인데, 부분취소는 아니었다

취소를 정산에 반영하는 코드가 이렇게 갈려 있었어요.

```java
if (event.fullyCanceled()) {
    item.cancel();                       // 전액: status==CANCELED 가드로 재배달 멱등 ✓
} else {
    item.reduce(event.cancelAmount());   // 부분: 델타를 뺀다 → 재배달 시 또 뺀다 ✗
}
```

전액취소는 "이미 CANCELED면 무시" 가드가 있어서 [at-least-once 재배달](/blog/project/pay/pay-3-webhooks-and-outbox)에 안전해요. 그런데 **부분취소는 `reduce`로 델타(취소분)를 빼기만** 해요.

> 이벤트는 아웃박스로 최소 한 번 이상 배달돼요. 리스너가 성공했는데 완료 표시 전에 크래시 나면, 재기동 때 **같은 취소 이벤트가 다시** 와요. 그럼 `reduce(3000)`가 두 번 호출돼서 **6000이 깎여요** — 실제론 3000만 취소했는데. 가맹점이 취소분의 두 배를 덜 받는 거죠. 전액은 멱등, 부분만 아닌 **비대칭**이 문제였어요.

해법은 관점을 바꾸는 거였어요 — **빼지 말고, 되어야 할 값으로 세팅하자.** 결제 엔티티는 이미 `balanceAmount`(취소 후 잔액)를 들고 있었어요. 그걸 이벤트에 실었어요.

```java
// 이벤트가 델타(cancelAmount)만이 아니라 "취소 후 잔액(절대값)"을 함께 나른다
new PaymentCanceledEvent(orderNo, paymentId, cancelAmount, settleableBalance, fullyCanceled);
```

```java
// 정산은 델타를 빼는 대신, 잔액으로 세팅한다 → 몇 번 와도 같은 값
public void applySettleableBalance(long settleableBalance) {
    this.amount = Math.max(0L, settleableBalance);
}
```

이제 같은 취소가 세 번 와도 `amount`는 잔액 그대로예요. **절대값 세팅은 본질적으로 멱등**이니까요(빼기는 아니고). 델타(`cancelAmount`)는 여전히 필요해서(원장 역분개·에스크로 환불이 써요) 같이 실어 보내고, 정산만 절대 잔액을 봐요.

> 멱등성을 "중복을 감지해서 막는다"로 풀 수도 있지만(취소 ID를 저장해 두고 비교), 더 단순한 건 **연산 자체를 멱등하게** 만드는 거예요. "빼기"를 "세팅"으로 바꾸니 감지 로직 없이 멱등이 됐어요. 라이브로 부분취소 10,000을 걸어보니 정산액이 잔액 20,000으로 딱 맞았고요.

## 2. 그리고 — 내가 틀렸던 설명

두 번째는 코드가 아니라 **제 과거 글**이었어요. 재감사가 이런 걸 짚었어요.

> 코드 곳곳에 "`saveAndFlush`가 필요한 건 **OSIV를 꺼서** dirty-check 자동 flush가 안 되기 때문"이라는 주석이 있는데, 이건 **기술적으로 틀렸다.**

찔렸어요. [예전에 영속 유실 버그를 잡은 글](/blog/project/pay/pay-26-persistence-bug)에서 제가 그렇게 설명했거든요. 그런데 다시 보니 —

> **일반적인 read-write 트랜잭션 안에선, OSIV를 켜든 끄든 managed 엔티티의 변경은 커밋 때 dirty-check로 flush돼요.** 증거가 같은 코드베이스에 있었어요 — `settle()`은 `items.forEach(SettlementItem::markSettled)`를 **save 없이** 부르는데 정상 SETTLED돼요. "OSIV off면 자동 flush가 안 된다"면 이게 동작하면 안 되죠. 즉 제 설명은 반증돼요.

그럼 [pay-26의 진짜 원인](/blog/project/pay/pay-26-persistence-bug)은 뭐였을까요?

> 커밋되는데 managed 엔티티가 flush 안 되는 상황의 진짜 원인은 **세션 FlushMode가 AUTO가 아니었던 것** — `@Transactional(readOnly = true)` 조회가 끼면 Hibernate가 FlushMode를 **MANUAL**로 바꿔요. 그러면 이후 dirty 변경이 커밋 때 flush 안 돼요. 거기에 detached 엔티티(merge 필요)가 겹친 거였고요. OSIV off는 detached를 만드는 배경일 뿐, flush를 막는 **직접 원인이 아니었어요.** 재밌는 건, 정작 `CheckoutService`의 다른 주석은 "readOnly 조회로 세션 flush가 MANUAL"이라고 **정확히** 적혀 있었다는 거예요 — 저는 한쪽에선 맞게, 다른 쪽에선 틀리게 설명하고 있었어요.

그래서 정정했어요. 부정확한 주석 12곳을 "readOnly/detached라 자동 flush를 신뢰할 수 없어 명시 영속한다(pay-26 교훈)"로 고치고, pay-26 글에도 **정정 노트**를 달았어요. `saveAndFlush`를 쓰는 정책 자체는 유효해요 — 틀린 건 **이유**였으니까요.

> 이걸 지울 수도 있었어요(어차피 draft고, 아무도 안 봤을 수도 있죠). 근데 안 지웠어요. "예전엔 이렇게 이해했는데 다시 보니 틀렸고, 진짜는 이거다"를 남기는 게, 처음부터 다 맞은 척하는 것보다 정직하니까요. 틀린 걸 고친 흔적도 기록이에요.

## 마치며

이번 편은 새 기능이 아니라 **재감사가 더 캐낸 것들**이에요. 하나는 "빼기를 세팅으로 바꿔 멱등하게", 다른 하나는 "내 과거 설명이 틀렸음을 인정하고 정정"이었죠.

두 번째가 특히 남아요. 결제 시스템을 만들면서 배운 건 코드만이 아니었어요 — **내가 안다고 적은 것도 틀릴 수 있고, 그걸 다시 의심하는 게 감사**라는 것. `settle()`이 save 없이 도는 걸 보고 "어? 그럼 내 OSIV 설명이 틀린 거 아냐?" 하고 멈춘 순간이, 이 라운드에서 제일 값진 순간이었어요. 코드의 정합성만큼, **설명의 정합성**도 결제에선 신뢰의 일부더라고요.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, 부분취소 멱등(잔액 세팅)은 실 MySQL로, OSIV 정정은 `settle()`의 save-less 동작으로 검증했습니다.*

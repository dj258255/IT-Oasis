---
title: '구매확정 전에 정산되고 있었다 — 죽은 이벤트가 가리킨 도메인 모순'
titleEn: 'Settlement Was Happening Before Purchase Confirmation — A Domain Contradiction a Dead Event Pointed To'
description: 결제 시스템 개선기. 전수 감사에서 이상한 걸 발견했다. 에스크로는 "구매확정 전까지 판매자 정산 보류"를 약속하는데, 정작 정산 항목은 결제 승인 즉시 적재되고 있었다. 그리고 구매확정 시 발행되는 EscrowReleasedEvent는 구독자가 아무도 없는 죽은 이벤트였다. 두 모듈이 "돈이 언제 판매자 것이 되는가"를 서로 다르게 알고 있던 이 모순을, 죽은 이벤트를 살려 정렬한 이야기.
descriptionEn: "Payment system improvement log. A full audit found something odd. Escrow promised to hold seller settlement until purchase confirmation, yet settlement items were being queued the instant a payment was approved. And EscrowReleasedEvent, published on confirmation, had no subscribers — a dead event. A story of aligning two modules that disagreed on when money becomes the seller's, by bringing the dead event back to life."
date: 2026-12-19T00:00:00.000Z
tags:
  - Payment
  - Settlement
  - Escrow
  - Event Driven
  - Domain Design
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 39
---

*결제 시스템 시리즈. 개선기 — 감사가 찾아낸 마지막 모순.*

## 0. 감사가 이상한 걸 짚었다

기능이 거의 다 완성된 뒤, 코드베이스를 **전수 감사**했어요("시스템이 암묵적으로 가정하는 것"을 다 찾아내자). 17건이 나왔는데, 그중 하나가 유독 걸렸어요.

> **[3] 정산이 에스크로와 분리** — 정산 적재가 `PaymentConfirmedEvent`(승인 즉시)에서 일어나고, `EscrowReleasedEvent`는 **구독자 0**(죽은 이벤트). "구매확정 전 보류"가 정산에 미반영.

읽고 나서 "아…" 했어요. [에스크로 편](/blog/project/pay/pay-25-escrow)에서 분명히 이렇게 만들었거든요 — 결제금을 **구매확정 전까지 HELD로 보류**하고, 구매자가 확정하면 RELEASED로 풀어 정산 가능하게. 자금이 판매자 것이 되는 건 **구매확정 시점**이라고요.

그런데 [정산 모듈](/blog/project/pay/pay-4-ledger-settlement-reconciliation)은 그걸 몰랐어요. `PaymentSettlementListener`가 **결제 승인 이벤트**를 받아, 승인되자마자 정산 항목을 쌓고 있었죠. 즉 —

> **에스크로는 "구매확정 전엔 못 준다"고 하는데, 정산은 "승인됐으니 지급 목록에 올린다"고 하고 있었어요.** 같은 시스템 안에서 두 모듈이 "돈이 언제 판매자 것이 되는가"를 **정반대로** 알고 있던 거예요.

그리고 그 증거가 **죽은 이벤트**였어요. 구매확정 시 `EscrowReleasedEvent`를 발행하는데, [grep해보니 구독자가 아무도 없었어요.](/blog/project/pay/pay-31-fds-review-queue) "향후 정산 파이프라인이 구독한다"는 주석만 남긴 채, 아무도 듣지 않는 이벤트를 계속 던지고 있던 거죠.

## 1. "돈은 언제 판매자 것이 되는가"

이건 결제 도메인에서 **가장 중요한 질문 중 하나**예요. 마켓플레이스라면 특히요.

- 너무 일찍 (승인 시점) 정산하면 → 미배송·분쟁 때 [이미 나간 돈을 회수 못 해요](/blog/project/pay/pay-25-escrow).
- 그래서 에스크로가 있는 거고, 정산은 **구매확정(에스크로 릴리스)에 맞춰야** 해요.

정답은 명확했어요 — **정산의 트리거를 승인이 아니라 구매확정으로 옮기는 것.** 죽어 있던 `EscrowReleasedEvent`를 정산이 구독하게 하면 돼요.

## 2. 정산 항목에 생명주기를 주다

기존 정산 항목의 상태는 `PENDING → SETTLED` 둘뿐이었어요. 여기에 "구매확정" 관문을 끼워 넣었어요.

```
PENDING_CONFIRMATION   승인됨 · 구매확정 대기 (아직 지급 대상 아님)
       ↓ EscrowReleasedEvent
CONFIRMED              구매확정됨 · 정산 가능
       ↓ 일 단위 배치
SETTLED               집계·지급됨
       (전액취소 시) → CANCELED
```

핵심은 세 곳이에요.

**(1) 승인 → PENDING_CONFIRMATION.** 승인 이벤트는 여전히 정산 항목을 만들지만, 이젠 "지급 대상"이 아니라 "**대기**" 상태로요.

**(2) 구매확정 → CONFIRMED.** 정산이 `EscrowReleasedEvent`를 구독해서, 그 주문의 항목을 CONFIRMED로 전이시켜요. **죽었던 이벤트가 드디어 제 일을 하는 거죠.**

```java
@ApplicationModuleListener
void onEscrowReleased(EscrowReleasedEvent event) {
    settlementService.confirmSettlement(event.orderNo());   // PENDING_CONFIRMATION → CONFIRMED
}
```

**(3) 배치는 CONFIRMED만 집계.** 일 단위 정산 배치가 `PENDING` 대신 **`CONFIRMED`만** 합산해요. 구매확정 안 된 `PENDING_CONFIRMATION` 항목은 지급에서 **자동으로 빠져요.** 이게 "구매확정 전 보류"가 정산에 실제로 반영되는 지점이에요 — 보류가 말이 아니라 동작이 된 거죠.

실기동으로 확인했어요.

```
승인 후        → settlement_items: PENDING_CONFIRMATION  (보류)
구매확정 후    → settlement_items: CONFIRMED             (정산 가능!)
전액취소       → settlement_items: CANCELED              (정산 제외)
부분취소 3000  → settlement_items: amount 7000           (역반영)
```

## 3. 취소는 정산에 어떻게 반영하나 — 그리고 정직한 한계

정산은 취소 이벤트도 구독하게 했어요(`PaymentCanceledEvent`). 그런데 여기 미묘한 경우들이 있어요.

- **확정 전 전액취소** → 항목을 `CANCELED`로. 애초에 지급 안 됨.
- **확정 전 부분취소** → 항목 amount를 줄임.
- **이미 SETTLED(집계·지급됨) 뒤 취소** → …?

마지막 경우가 어려워요. 이미 판매자에게 지급 목록으로 나간 걸 정산 항목에서 되돌리면, 회계가 어긋나요. 그래서 **되돌리지 않기로** 했어요.

> 이미 SETTLED된 항목에 취소가 오면, 금액을 건드리지 않고 `settlement.postsettle.cancel` 카운터만 올려요(운영이 별도 정산 조정으로 처리). 실무에선 이걸 **다음 배치의 음수 조정(clawback)**으로 반영하죠. 지금은 그 신호까지만 남기고, "정산은 재구성 가능한 집계이고 취소의 진짜 이력은 [원장 역분개](/blog/project/pay/pay-18-order-cancel)가 보유한다"는 판단을 주석에 명시했어요.

측정을 부풀리지 않듯([데드락 편 각주처럼](/blog/project/pay/pay-37-deadlock-retry)), 처리 못 하는 케이스도 **"못 한다"고 정직하게** 표시하는 게 나아요. 조용히 틀리게 처리하는 것보다요.

## 4. 경계는 여기서도 단방향

정산이 에스크로 이벤트를 구독하니, `settlement`가 `escrow`에 의존해요. 방향을 확인했어요 — **settlement → escrow 단방향**. 에스크로는 정산을 몰라요(자기 이벤트만 던질 뿐). [모듈 경계](/blog/project/pay/pay-21-ci-guards-boundaries)를 CI가 강제하니, 순환이 생겼으면 빌드가 깨졌을 거예요. 통과했고요.

## 마치며

이번 건 이 시리즈에서 반복된 패턴의 **정점** 같아요. [실기동이](/blog/project/pay/pay-26-persistence-bug), [스파이크가](/blog/project/pay/pay-37-deadlock-retry), [소비자를 붙이는 게](/blog/project/pay/pay-38-kafka-consumer) 숨은 문제를 드러냈듯 — 이번엔 **전수 감사**가 "두 모듈이 같은 사실을 다르게 알고 있는" 도메인 모순을 짚었어요.

그리고 그 모순의 증거가 **죽은 이벤트**였다는 게 인상적이었어요. 아무도 안 듣는 이벤트를 계속 던지고 있었다는 건, 설계 의도(구매확정 시 정산)와 실제 동작(승인 시 정산)이 갈라져 있었다는 신호였거든요. 죽은 이벤트를 살리는 건 단순히 리스너 하나 붙이는 게 아니라, **갈라진 두 모듈의 세계관을 다시 합치는** 일이었어요.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, 승인→보류→구매확정→확정→취소 반영을 실 MySQL로 검증했습니다.*

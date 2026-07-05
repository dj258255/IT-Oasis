---
title: '가상계좌 — 문서를 깊게 읽어야만 보이는 두 함정'
titleEn: "Virtual Accounts — Two Traps You Only See by Reading the Docs Closely"
description: 결제 시스템 확장 5. 가상계좌 입금을 다룬다. 그런데 토스페이먼츠 문서를 깊게 읽으면 함정 둘이 나온다 — 입금기한이 지나 만료(EXPIRED)될 때는 웹훅이 오지 않아서 자체 만료 배치가 필요하고, 일부 은행은 입금 실패인데 DONE을 먼저 보낸 뒤 되돌리는 DONE→입금대기 역전이를 한다. 그리고 만료 처리와 늦은 입금이 겹치는 레이스까지.
descriptionEn: "Payment system extension 5. Handling virtual-account deposits. But reading the Toss Payments docs closely surfaces two traps — when the deposit deadline passes and it expires, no webhook is sent, so you need your own expiry batch; and some banks send DONE first on a failed deposit and then reverse it, a DONE→awaiting-deposit transition. Plus the race between expiring and a late deposit."
date: 2026-07-18T00:00:00.000Z
tags:
  - Payment
  - Virtual Account
  - Webhook
  - Batch
  - State Machine
  - Java
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 13
---

*결제 시스템 시리즈. 확장 5편 — 가상계좌의 함정들.*

## 0. 입금을 기다리는 결제

가상계좌는 "계좌번호를 발급하고 입금을 기다리는" 결제예요. 카드처럼 즉시 승인이 아니라, 사용자가 나중에 그 계좌로 돈을 넣으면 완료되죠. 상태 흐름은 `발급 → 입금대기 → 입금완료`예요.

기본은 [Phase 3의 웹훅](/blog/project/pay/pay-3-webhooks-and-outbox)으로 처리해요 — 입금되면 PG가 웹훅을 보내고, 우리는 "믿지 말고 조회로 재검증"해서 완료 처리. 여기까진 쉬워요. 그런데 토스페이먼츠 문서를 **깊게** 읽으면 함정 둘이 나와요.

## 1. 함정 ①: 만료엔 웹훅이 안 온다

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

## 2. 만료-입금 레이스

위 코드에서 눈여겨볼 게 있어요. 만료 배치가 도는 **바로 그 순간에 입금이 도착**할 수 있어요. 그럼 "만료시켜야 하나, 완료시켜야 하나?"

답은 [Phase 3의 원칙](/blog/project/pay/pay-3-webhooks-and-outbox) 그대로예요 — **믿지 말고 PG에 조회.** 만료 대상이라도 조회해서 실제로 입금됐으면(APPROVED) 만료시키지 않고 완료 처리해요. dueDate만 보고 기계적으로 만료시키면, 방금 입금한 사용자의 돈이 붕 뜨거든요.

> 이게 "가상계좌 만료 어떻게 처리하세요?"에 대한 강한 답이에요 — "EXPIRED 웹훅이 없어서 배치로 감지하고, 만료 직전에 조회로 재확인해서 늦은 입금과의 레이스를 해소합니다." 문서를 대충 읽으면 절대 안 나오는 디테일이죠.

## 3. 함정 ②: DONE에서 되돌아온다

두 번째 함정은 더 미묘해요.

> 일부 은행(신한 등)은 **입금 실패인데 DONE을 먼저 보낸 뒤, 최대 2분 후 되돌리는** 통보를 해요. 즉 `DONE → 입금대기`로 상태가 역전이돼요.

보통 상태머신은 "완료(DONE)는 최종 상태"라고 가정하는데, 가상계좌는 아니에요. 그래서 상태머신에 **역전이를 허용 전이로** 넣었어요.

```java
DONE → { WAITING_FOR_DEPOSIT, CANCELED }   // 은행 지연 통보로 인한 역전이
```

그리고 역전이가 오면, 이미 보낸 "결제 완료" 후속 처리(알림, 포인트 적립 등)를 되돌려야 해요 — [Phase 1에서 만든](/blog/project/pay/pay-1-order-payment-core) 상태 전이 이력과 [보상 트랜잭션](/blog/project/pay/pay-2-designing-for-failure) 발상이 여기서도 쓰여요.

## 4. 정리

가상계좌는 "입금 기다리기"라는 단순해 보이는 기능인데, 실무 함정이 숨어 있어요.

| 함정 | 대응 |
|---|---|
| EXPIRED엔 웹훅 없음 | 자체 만료 배치(dueDate 스캔) |
| 만료-입금 레이스 | 만료 직전 조회로 재확인 |
| DONE→입금대기 역전이 | 상태머신에 역전이 허용 + 후속 처리 보상 |

> 이 세 가지는 전부 **문서를 깊게 읽어야만** 나와요. "가상계좌 붙였어요"와 "가상계좌의 EXPIRED 웹훅 부재와 DONE 역전이를 처리했어요"는 완전히 다른 깊이예요. 그리고 결국 [이 시리즈의 원칙](/blog/project/pay/pay-3-webhooks-and-outbox) — "웹훅을 믿지 말고 조회로 확정한다"·"실패/역전이를 상태머신에 새긴다" — 이 그대로 재사용돼요.

## 다음 — 이상거래탐지(FDS)

다음은 FDS예요. velocity check로 단위시간 시도 횟수를 세고, 금액 이상치를 잡고, 룰 가중치로 스코어링해서 ALLOW/CHALLENGE/BLOCK/REVIEW로 나누는. 핵심은 정확도가 아니라 아키텍처 판단이에요. 이어서 씁니다.

---

*확장도 기존 기반(웹훅 조회 재검증·상태머신·보상) 위에 얹으며, 문서의 디테일을 코드로 옮깁니다.*

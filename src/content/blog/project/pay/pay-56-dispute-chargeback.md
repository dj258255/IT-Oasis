---
title: '결제는 됐는데 그다음이 없었다 — 차지백/분쟁을 상태기계·멱등 웹훅·패소 역분개로'
titleEn: 'The Payment Went Through, but Nothing Came After — Chargebacks as a State Machine, Idempotent Webhook, and Loss Reversal'
description: 결제 시스템 개선기. 카드 결제는 승인으로 끝나지 않는다. 고객이 카드사에 이의를 걸면(차지백) 가맹점은 기한 안에 증빙을 제출해 다퉈야 하고, 지면 원장을 되돌려야 한다. 그런데 우리 시스템엔 그 사후 흐름이 통째로 비어 있었다. 차지백 수신 → 분쟁 개시(OPEN) → 증빙 제출 → 승/패 상태기계, 차지백 식별자를 멱등키로 삼은 웹훅, 그리고 패소 시 원매출을 복식부기로 역분개하는 이야기.
descriptionEn: "Payment system improvement log. A card payment doesn't end at authorization. When a customer disputes with their card issuer (chargeback), the merchant must submit evidence within a deadline, and on a loss must reverse the ledger. That entire post-payment flow was missing. A story about a state machine (chargeback received → OPEN → evidence submitted → won/lost), an idempotent webhook keyed on the chargeback id, and reversing the original sale with double-entry bookkeeping on a loss."
date: 2027-04-17T00:00:00.000Z
tags:
  - Payment
  - Chargeback
  - Webhook
  - Ledger
  - Spring Modulith
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 56
---

*결제 시스템 시리즈. 개선기 — 승인으로 끝난 줄 알았던 결제의 "그다음"을 채운 이야기.*

![분쟁/차지백 데모](/uploads/project/pay/demo/demo-dispute.png)

## 결제는 되는데, 지면 어쩔 건데

데모를 돌리다 문득 이상했다. 결제는 승인되고, 취소도 되고, 정산도 붙는데 — **차지백**이 오면 아무 일도 일어나지 않았다. 카드 결제에서 차지백은 예외가 아니라 일상이다. 고객이 "이거 내가 안 샀다"고 카드사에 이의를 걸면, 카드사는 일단 돈을 고객에게 돌려주고 가맹점에 통보한다. 가맹점은 정해진 기한 안에 "정상 거래였다"는 증빙을 제출해 다퉈야 하고, 지면 그 매출은 사라진다.

승인만 있고 이 사후 흐름이 없으면, 장부는 계속 "매출이 있다"고 우기는데 실제 돈은 빠져나간 상태가 된다. 결제 시스템의 정합성이 조용히 깨지는 지점이다. 그래서 `dispute` 모듈을 새로 만들었다.

## 분쟁은 상태기계다

차지백 대응은 단계가 정해져 있다. 그래서 자유롭게 필드를 바꾸는 대신, **전이만 허용하는 상태기계**로 못 박았다.

```
OPEN ──submitEvidence──▶ EVIDENCE_SUBMITTED
  │                              │
  └──────resolve(win)───────────┴──▶ WON / LOST
```

상태 전이는 서비스가 아니라 **엔티티 메서드**가 강제한다. `submitEvidence()`는 `OPEN`에서만, `resolve()`는 `OPEN`/`EVIDENCE_SUBMITTED`에서만 동작하고, 이미 확정(`WON`/`LOST`)된 분쟁을 다시 건드리면 예외를 던진다.

```java
public void submitEvidence(String memo) {
    if (status != DisputeStatus.OPEN) {
        throw DisputeException.invalidTransition(status, DisputeStatus.EVIDENCE_SUBMITTED);
    }
    this.evidenceMemo = memo;
    this.status = DisputeStatus.EVIDENCE_SUBMITTED;
}

public void resolve(boolean win) {
    if (status != DisputeStatus.OPEN && status != DisputeStatus.EVIDENCE_SUBMITTED) {
        throw DisputeException.invalidTransition(status, win ? DisputeStatus.WON : DisputeStatus.LOST);
    }
    this.status = win ? DisputeStatus.WON : DisputeStatus.LOST;
    this.resolvedAt = Instant.now();
}
```

전이 규칙이 엔티티 안에 있으니, 서비스든 배치든 컨트롤러든 어디서 호출해도 잘못된 전이는 물리적으로 불가능하다. 상태를 문자열로 훑어보며 "지금 이거 해도 되나" 방어 코드를 흩뿌릴 필요가 없다.

## 웹훅은 두 번 온다 — 멱등키는 차지백 식별자

PG 웹훅의 제1원칙: **같은 이벤트가 두 번 온다.** 네트워크가 흔들리거나 우리가 200을 늦게 주면 PG는 재전송한다. 차지백 웹훅을 순진하게 받으면 같은 차지백에 대해 분쟁이 두 건, 세 건 생긴다.

그래서 외부 **차지백 식별자(`chargebackId`)를 멱등키**로 삼았다. 개시는 "이미 있으면 기존 걸 반환"하고, DB에는 `chargeback_id` UNIQUE 제약을 걸어 동시 수신까지 막는다. 이건 [체크아웃 사가](pay-51-checkout-saga)에서 세운 "재시도 가능한 경계는 멱등해야 한다"는 원칙 그대로다.

```java
public DisputeView openFromChargeback(String chargebackId, String orderNo, Long paymentId,
                                      long amount, String reason) {
    var existing = repository.findByChargebackId(chargebackId);
    if (existing.isPresent()) {
        return DisputeView.from(existing.get());   // 멱등: 중복 웹훅 흡수
    }
    try {
        Dispute saved = repository.save(Dispute.open(chargebackId, orderNo, paymentId, amount,
                reason, Instant.now().plus(RESPOND_WINDOW)));
        return DisputeView.from(saved);
    } catch (DataIntegrityViolationException e) {
        // 동시 수신으로 UNIQUE를 스치면 재조회로 흡수
        return repository.findByChargebackId(chargebackId).map(DisputeView::from).orElseThrow(() -> e);
    }
}
```

인증은 기존 PG 웹훅과 **같은 HMAC 서명 검증기**를 그대로 재사용했다. Spring Modulith에서 payment 모듈의 웹훅 서명 검증기를 `webhook` 명명 인터페이스로 노출하고, dispute가 그것만 참조하게 배선했다. 검증기 하나 쓰자고 payment 내부를 통째로 열지 않는다. 서명 위조만 401로 돌려주고, 나머지 처리 예외는 재전송 폭주를 막으려 200으로 흡수하는 것도 기존 웹훅 컨트롤러와 동일하다.

## 지면 되돌린다 — 패소 역분개

핵심은 여기다. **패소(LOST)하면 원매출을 원장에서 되돌려야 한다.** 이 시스템의 원장은 [복식부기](pay-5-lock-comparison)라, 원거래를 지우지 않는다. 대신 반대 방향 분개를 하나 더 쌓아 이력을 보존한다. 결제 승인이 `PG미수금(차변) ↔ 매출(대변)`이었으니, 패소 역분개는 그 반대인 `매출(차변) ↔ PG미수금(대변)` — 결제 취소와 같은 방향이다.

모듈 간 결합을 피하려고 dispute는 ledger를 모른다. 패소가 확정되면 `DisputeLostEvent`만 발행하고, **ledger가 그 이벤트를 구독**해 역분개한다. dispute → ledger 단방향이라 순환이 없다.

```java
@ApplicationModuleListener
void onDisputeLost(DisputeLostEvent event) {
    ledgerService.recordDisputeLost(event);
}
```

```java
@Transactional
public void recordDisputeLost(DisputeLostEvent event) {
    if (repository.existsByTxTypeAndSourceTypeAndSourceId("DISPUTE_LOST", "DISPUTE", event.disputeId())) {
        return; // 멱등: 이미 역분개함
    }
    long amount = event.amount();
    LedgerTransaction tx = LedgerTransaction.of("DISPUTE_LOST", "DISPUTE", event.disputeId(),
            "분쟁 패소 역분개 " + event.orderNo(),
            List.of(LedgerEntry.debit(AccountType.SALES, amount),
                    LedgerEntry.credit(AccountType.PG_RECEIVABLE, amount)));
    repository.save(tx);
}
```

역분개도 멱등이다. `(txType, sourceType, sourceId)` = `(DISPUTE_LOST, DISPUTE, disputeId)` UNIQUE로, 같은 패소 이벤트가 아웃박스에서 재전달돼도 역분개는 딱 한 번만 쌓인다. 이벤트 전달은 Modulith 아웃박스가 유실 없이 보장하고, 원장은 유니크로 중복을 막는다 — at-least-once 전달 위에 얹은 멱등 소비다.

## 남는 이야기

증빙 제출 기한(`respondByDeadline`)은 수신 시점 + 7일로 잡아 두었지만, 실제로 기한을 넘겼을 때 자동으로 패소 처리하는 배치는 아직 없다. 지금은 어드민이 손으로 확정한다. 그리고 부분 차지백(원금 일부만 이의)이나 재분쟁(2차 차지백)은 이번 범위에서 뺐다 — 상태기계가 한 단계 더 깊어지는 주제라 따로 다룰 만하다.

그래도 "승인으로 끝난 줄 알았던 결제"에 그다음을 채웠다. 차지백이 오면 분쟁이 서고, 두 번 와도 하나만 서고, 지면 장부가 스스로 균형을 되찾는다. 결제 시스템이 조금 더 정직해졌다.

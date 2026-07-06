---
title: '판정 엔진은 있는데 심사할 곳이 없었다 — FDS 사후 탐지와 REVIEW 큐'
titleEn: 'The Scoring Engine Existed but Had Nowhere to Review — FDS Post-Hoc Detection and the Review Queue'
description: 결제 시스템 개선기. 이상거래탐지(FDS) 룰 엔진은 만들어뒀는데, 정작 어떤 흐름에도 연결돼 있지 않았고 REVIEW 판정을 담아둘 큐도 어드민 연동도 없었다. 결제 크리티컬 경로는 건드리지 않고, 결제 완료 이벤트를 구독해 비동기 사후로 평가하고 REVIEW/BLOCK을 심사 큐에 적재해 사람이 처리하게 붙인 이야기. 거부하면 카드를 블랙리스트에 넣어 사후 탐지가 사전 차단으로 이어진다.
descriptionEn: "Payment system improvement log. The fraud-detection rule engine existed but wasn't wired into any flow, with no queue for REVIEW verdicts and no admin. Without touching the critical payment path, I subscribed to the payment-confirmed event to evaluate asynchronously post-hoc and queue REVIEW/BLOCK for a human. Rejecting blacklists the card, so post-hoc detection feeds back into up-front blocking."
date: 2026-10-24T00:00:00.000Z
tags:
  - Payment
  - Fraud Detection
  - Event Driven
  - Spring Modulith
  - Operations
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 31
---

*결제 시스템 시리즈. 개선기 — 판정 엔진을 실제로 쓰이게 하기.*

## 0. 만들어뒀는데 안 쓰이던 엔진

[확장 기능들](/blog/project/pay/pay-14-fraud-detection)을 만들 때 이상거래탐지(FDS) 룰 엔진도 넣었어요. 블랙리스트·velocity(속도)·고액을 점수로 매겨 `ALLOW/CHALLENGE/REVIEW/BLOCK`을 결정하는. 임계값도 프로퍼티로 빼서 배포 없이 조정 가능하게요.

그런데 이번에 문서와 코드를 대조하다 깨달았어요 — **이 엔진이 정작 아무 흐름에도 연결돼 있지 않았어요.** `evaluate()`는 단위 테스트만 부르고 있었고, 실제 결제가 이걸 거치지 않았죠. 게다가 `REVIEW`(사람 검토 필요) 판정이 나와도 그걸 **담아둘 큐도, 어드민이 처리할 방법도** 없었어요.

엔진은 있는데 심사할 곳이 없던 거예요.

## 1. 크리티컬 경로는 건드리지 않는다

제일 먼저 정한 원칙이 이거였어요. FDS를 붙인다고 **결제 승인 경로(confirm)를 건드리지 않는다.**

이유는 두 가지예요.

> **(1) 위험**: confirm은 [방금 큰 버그를 잡은](/blog/project/pay/pay-26-persistence-bug) 크리티컬 경로예요. 여기에 FDS 평가를 끼워 넣으면 결제 지연·실패 리스크가 생겨요. **(2) 데이터**: 동기 인라인 판정은 IP·기기ID 같은 요청 시점 신호가 필요한데, 이걸 confirm에 다 흘려보내려면 배관이 커져요.

그래서 방향을 **비동기 사후 탐지(post-hoc)**로 잡았어요. 결제가 완료되면 `PaymentConfirmedEvent`가 울리는데, [이걸 fraud 모듈이 구독](/blog/project/pay/pay-22-kafka-event-externalization)해서 **승인이 끝난 뒤 별도로** 평가하는 거예요.

```java
@ApplicationModuleListener
void onConfirmed(PaymentConfirmedEvent e) {
    String cardKey = paymentService.paymentKeyOf(e.paymentId()).orElse(null);
    if (cardKey == null) return;
    FraudResult r = fraudService.evaluate(
        new FraudCheckRequest(0L, cardKey, null, null, e.amount()));  // 같은 판정 엔진 재사용
    if (r.decision() == REVIEW || r.decision() == BLOCK) {
        reviewRepository.save(FraudReview.flagged(e.orderNo(), e.paymentId(), cardKey, e.amount(), r));
    }
}
```

이게 [Outbox 이벤트](/blog/project/pay/pay-3-webhooks-and-outbox)로 승인 완료 후 비동기로 도니, **결제 지연이나 실패에 전혀 영향을 안 줘요.** 판정 엔진은 그대로 재사용하고, 붙이는 방식만 이벤트 리스너로요.

## 2. 사후 탐지의 신호 한계 — 솔직하게

여기엔 정직하게 짚을 한계가 있어요. `PaymentConfirmedEvent`는 [Zero-Payload](/blog/project/pay/pay-0-why-and-modulith)(식별자·최소 정보만) 지향이라, **IP·기기ID·userId 같은 요청 시점 신호가 없어요.**

그래서 사후 평가는 `userId=0`, `ip=null`, `device=null`로 두고 **cardKey(결제키)와 금액만으로** 판정해요. 다행히 이 프로젝트의 활성 룰(블랙리스트·velocity·고액)이 전부 **cardKey와 금액을 기준**으로 동작해서, 사후에도 정상적으로 점수가 나와요.

> 동기 인라인 판정이라면 IP·기기로 더 촘촘히 볼 수 있지만, 사후 탐지는 그 신호가 없다는 걸 리스너 주석에 명시했어요. "무엇을 못 보는지"를 숨기지 않는 게, 나중에 이 코드를 읽는 사람에게 정직한 거니까요.

cardKey는 이벤트에 없어서 `paymentKeyOf(paymentId)`로 되읽고, 그것도 없으면 조용히 넘어가요. REVIEW/BLOCK만 큐에 넣고, ALLOW/CHALLENGE는 안 넣어요. (BLOCK은 사후엔 이미 결제가 끝나 막을 순 없지만, **긴급 심사 대상**으로 적재해요.)

## 3. 심사 → 거부 → 사전 차단으로 이어지는 루프

큐에 쌓인 REVIEW를 어드민이 처리해요.

```
GET  /admin/fraud-reviews?status=PENDING   → 심사 대기 큐
POST /admin/fraud-reviews/{id}/approve     → 정상 거래로 확인 (APPROVED)
POST /admin/fraud-reviews/{id}/reject      → 사기로 판정 (REJECTED) + 카드 블랙리스트
```

제일 중요한 건 **거부(reject)**예요. 단순히 "사기로 표시"하고 끝나는 게 아니라 —

```java
public FraudReviewView reject(long id, String reviewer) {
    FraudReview review = load(id);
    review.reject(reviewer);
    fraudService.blacklistCard(review.getCardKey());   // 향후 같은 카드는 BLOCK
    repository.saveAndFlush(review);
    ...
}
```

거부하면 그 카드를 **블랙리스트에 넣어요.** 그러면 이후 같은 카드의 결제는 판정 엔진이 `BLOCK`으로 잡아요. 즉 **사후 탐지 → 사람 심사 → 사전 차단**으로 이어지는 피드백 루프가 닫혀요. 한 번 사기로 판정된 카드는 다음번엔 애초에 막히는 거죠.

큐 뷰에서 결제키(cardKey)는 민감하니 **앞 4자리·뒤 4자리만** 보이게 마스킹했고, 모든 승인/거부는 [감사 로그](/blog/project/pay/pay-23-ops-admin)로 남겨요. 그리고 상태 변경엔 [예의 saveAndFlush](/blog/project/pay/pay-26-persistence-bug)를 잊지 않고 적용했고요.

## 마치며

이번 건 "새 엔진을 만든" 게 아니라 **"이미 있던 엔진을 실제로 쓰이게" 연결한** 편이에요. 만들어만 두고 안 쓰이던 판정 엔진이, 이벤트 구독 하나로 실제 거래를 평가하기 시작했어요.

핵심은 세 가지였어요 — 크리티컬 경로를 안 건드리려고 **비동기 사후 탐지**를 택한 것, 사후엔 신호가 부족하다는 **한계를 솔직히 인정**한 것, 그리고 거부가 블랙리스트로 이어져 **탐지가 차단으로 닫히는 루프**를 만든 것. FDS는 한 번 판정하고 끝이 아니라, 사람의 심사를 거쳐 시스템이 조금씩 똑똑해지는 거더라고요.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, V8 마이그레이션·사후 탐지 리스너·심사 어드민을 실 MySQL로 검증했습니다.*

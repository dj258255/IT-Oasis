---
title: '현금영수증 — 결제를 취소하면 영수증도 취소해야 한다'
titleEn: "Cash Receipts — Cancel the Payment, and You Must Cancel the Receipt Too"
description: 결제 시스템 확장 8, 마지막. 국내 증빙을 다룬다. 결제수단에 따라 증빙을 자동 결정하고(카드→매출전표, 현금성→현금영수증, B2B→세금계산서), 현금영수증은 비동기로 발급된다. 핵심 함정은 결제를 취소했을 때 현금영수증을 방치하는 것 — 결제 취소 이벤트를 구독해 자동으로 연쇄 취소한다.
descriptionEn: "Payment system extension 8, the last. Handling Korean tax evidence. Evidence type is auto-resolved by payment method (card→sales slip, cash→cash receipt, B2B→tax invoice), and cash receipts are issued asynchronously. The key trap is leaving the cash receipt dangling when a payment is canceled — so I subscribe to the payment-canceled event and cascade-cancel it automatically."
date: 2026-07-21T00:00:00.000Z
tags:
  - Payment
  - Cash Receipt
  - Tax Evidence
  - Event-Driven
  - Java
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 16
---

*결제 시스템 시리즈. 확장 8편, 마지막 — 현금영수증과 증빙.*

## 0. 증빙은 국내 도메인이다

현금영수증·세금계산서는 해외 자료로는 못 배우는 **순수 국내 도메인**이에요. 그리고 기술이라기보단 **법적 의무**라, 커머스 결제를 열 때 반드시 챙겨야 해요.

핵심은 결제수단에 따라 증빙이 하나로 정해진다는 거예요.

```java
public static EvidenceType resolve(String method, boolean b2b) {
    if (b2b) return TAX_INVOICE;                        // B2B → 세금계산서
    return switch (method) {
        case "VIRTUAL_ACCOUNT", "TRANSFER" -> CASH_RECEIPT;  // 현금성 → 현금영수증
        default -> SALES_SLIP;                          // 카드 → 매출전표
    };
}
```

카드 결제는 **매출전표**가 법정 증빙이라, 세금계산서를 중복 발행하면 안 돼요. 가상계좌·계좌이체는 현금거래라 **현금영수증** 대상이고요. "가상계좌 = 현금거래 = 현금영수증"이 핵심 도메인 지식이에요.

## 1. 비동기 발급

현금영수증 발급은 즉시 끝나지 않아요. PG에 요청하면 `IN_PROGRESS → COMPLETED/FAILED`로 진행되죠. 그래서 상태머신으로 다뤄요.

```
REQUESTED → ISSUED / FAILED → CANCELED
```

[가상계좌](/blog/project/pay/pay-13-virtual-account)나 [결제 승인](/blog/project/pay/pay-2-designing-for-failure)처럼, "비동기라 상태를 추적한다"는 같은 패턴이에요.

## 2. 핵심 함정: 결제 취소하면 영수증이 남는다

여기가 이 기능의 진짜 포인트예요. 운영에서 사고가 잦은 지점이거든요.

> 수동 발급한 현금영수증은, **결제를 취소해도 자동으로 취소되지 않아요.** 가맹점이 직접 현금영수증 취소 API를 호출해야 하는데, 이걸 깜빡하면 "결제는 취소됐는데 현금영수증은 발급된 채로" 남아요. 세무상 문제가 되죠.

그래서 [Phase 3의 이벤트](/blog/project/pay/pay-3-webhooks-and-outbox)를 써서 자동으로 연쇄 취소하게 했어요.

```java
@ApplicationModuleListener
void onCanceled(PaymentCanceledEvent event) {
    receiptService.cancelByOrder(event.orderNo());   // 결제 취소 → 현금영수증 연쇄 취소
}
```

결제가 취소되면 그 주문의 현금영수증을 찾아 함께 취소해요. 이미 취소된 건 멱등하게 넘어가고요. "결제 취소 → 현금영수증 자동 취소"를 이벤트로 엮어서, 사람이 깜빡할 여지를 없앤 거예요.

## 3. 시리즈를 마치며

이걸로 **본편 7편 + 개선 2편 + 확장 8편**, 총 17편을 마쳐요. 되짚어보면 —

```
본편   결제 코어 → 실패 설계 → 이벤트 → 원장·정산·대사 → 성능 → 운영
개선   실기동(Flyway) → 실 PG 어댑터
확장   멀티PG · 복합결제 · 구독 · 월렛 · 가상계좌 · FDS · 암호화 · 현금영수증
```

처음 [0편](/blog/project/pay/pay-0-why-and-modulith)에서 세운 명제 하나가 끝까지 관통했어요 — **결제의 어려움은 "성공"이 아니라 "실패와 정합성"에 있다.** 타임아웃을 UNKNOWN으로 보존하고, 멱등키로 중복을 막고, 복식부기로 정합성을 증명하고, failover는 이중결제를 피해서 하고, 결제 취소는 영수증까지 연쇄로 취소하고 — 전부 "정상 경로 다음"의 이야기였어요.

그리고 만드는 내내 자동 보안 검토가 세 번(가격 위변조, 소유권 IDOR, 하드코딩 키) 사고를 커밋 단계에서 잡아줬어요. "돌아가는 것"과 "안전하게 돌아가는 것"은 다르다는 걸, 코드로 배운 프로젝트였어요. 읽어주셔서 고맙습니다.

---

*전체 코드는 195개 테스트로 검증돼 있고, 실 MySQL 위에서 라이브로 동작을 확인했습니다.*

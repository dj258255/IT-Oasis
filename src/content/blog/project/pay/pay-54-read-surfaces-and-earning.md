---
title: '쌓이기만 하고 안 보이던 것들 — 주문 목록·원장·포인트 적립을 표면으로'
titleEn: 'Accumulating but Invisible — Surfacing Order History, the Ledger, and Point Earning'
description: 결제 시스템 개선기. 주문은 단건 조회만 있고 "내 주문 목록"이 없었고, 복식부기 원장은 분개가 계속 쌓이는데 들여다볼 방법이 없었고, 포인트는 차감만 있고 적립이 없었다. 세 가지 모두 "데이터는 만들어지는데 표면이 없어 죽어 있던" 조각들이다. 소유권은 쿼리 자체로 격리하고, 원장은 차변·대변 균형까지 보여주고, 적립은 실결제액 기준으로 이중적립 없이 붙인 이야기.
descriptionEn: "Payment system improvement log. Orders had single-record lookup but no 'my order list'; the double-entry ledger kept accruing entries with no way to inspect them; points had deduction but no earning. Three pieces where data was being produced but had no surface to be seen. A story about isolating ownership in the query itself, showing debit/credit balance in the ledger, and adding earning on real-paid amounts without double-dipping."
date: 2027-04-03T00:00:00.000Z
tags:
  - Payment
  - REST API
  - Ledger
  - Loyalty Points
  - Spring Boot
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 54
---

*결제 시스템 시리즈. 개선기 — 쌓이는데 안 보이던 세 가지를 표면으로.*

## 0. 또 "만들어지는데 안 보이는 것"

[구독](/blog/project/pay/pay-52-subscription-surface)도 [월렛](/blog/project/pay/pay-53-wallet-payment-method)도 "로직은 있는데 부를 수 없던" 걸 완성했는데, 훑다 보니 결이 조금 다른 셋이 더 있었어요. **데이터는 계속 만들어지는데, 그걸 볼 표면이 없어 죽어 있던** 것들이요.

- **주문**: 단건 조회(`GET /orders/{orderNo}`)만 있고, "내 주문 목록"이 없었어요.
- **원장**: 결제할 때마다 복식부기 분개가 쌓이는데, 들여다볼 방법이 없었어요.
- **포인트**: 차감(USE)·복원·환불만 있고 **적립(EARN)이 없었어요.** 쓸 줄만 알고 줄 줄은 몰랐던 거죠.

셋 다 작지만, "만들었다 ≠ 쓸 수 있다"의 또 다른 얼굴이에요.

## 1. 내 주문 목록 — 소유권을 쿼리로 격리

목록 API를 얹었어요.

```
GET /api/v1/orders     내 주문 목록(최신 50건 요약)
```

여기서 IDOR(남의 주문 조회)를 막는 방식이 [단건 조회 때](/blog/project/pay/pay-30-maker-checker)와 달라요. 단건은 주문을 불러온 뒤 `verifyOwner`로 막지만, 목록은 **쿼리 자체가 본인 것만** 가져와요.

```java
public List<OrderSummaryView> myOrders(long authenticatedUserId) {
    return orderRepository.findTop50ByUserIdOrderByIdDesc(authenticatedUserId).stream()
            .map(OrderSummaryView::from)
            .toList();
}
```

userId는 인증 principal에서 오고, WHERE 절이 그걸로 걸리니 **남의 주문은 애초에 조회 대상이 아니에요.** 검증으로 걸러내는 게 아니라 안 가져오는 것 — IDOR 방어의 가장 단순한 형태죠. 실기동으로 user1은 자기 주문이 최신순으로 뜨고, user2는 0건인 걸 확인했어요. `Top50`으로 상한을 둬 무한 적재도 막았고요.

## 2. 원장 감사 뷰 — 차변·대변 균형까지

[복식부기 원장](/blog/project/pay/pay-5-lock-comparison)은 결제 승인마다 `PG미수금(차변) ↔ 매출(대변)` 분개를 append-only로 쌓아요. 그런데 운영자가 그걸 볼 수가 없었어요. 감사용 어드민 뷰를 얹었어요.

```
GET /api/v1/admin/ledger    최근 원장 트랜잭션 50건(ADMIN 전용)
```

뷰에 **균형 여부**를 함께 실었어요 — 각 트랜잭션의 차변 합과 대변 합이 같은지(`imbalance()==0`).

```java
static LedgerView from(LedgerTransaction tx) {
    return new LedgerView(..., tx.imbalance() == 0, ...,   // balanced
            tx.getEntries().stream().map(EntryView::from).toList());
}
```

감사자가 정합 위반을 한눈에 보라는 거예요. 실기동으로 봤더니 재밌는 게 있었어요 — 카드 14,000 + 월렛 6,000으로 결제한 주문의 원장 분개가 **20,000이 아니라 14,000**이더라고요.

> 월렛 6,000은 **이미 받아둔 선불(prepaid)**이라, 새로 생기는 PG 미수금이 아니에요. 그래서 원장엔 카드분 14,000만 `PG미수금 ↔ 매출`로 잡혀요. [사가에서 본 결제수단의 경제적 의미 차이](/blog/project/pay/pay-53-wallet-payment-method)가, 이번엔 **장부에 그대로 드러난** 거죠. 회계가 맞으려면 이게 맞아야 해요.

비관리자가 이 엔드포인트를 부르면 403이 나는 것도 확인했어요.

## 3. 포인트 적립 — 실결제액 기준, 이중적립 없이

포인트는 쓸 줄만 알았어요(USE). 결제가 끝나면 적립(EARN)이 돼야 하는데 그게 없었죠. 사가의 **성공 분기**(`markPaid`)에 적립을 붙였어요.

```java
if (allDeducted) {
    order.markPaid();
    // 실결제액(카드+월렛, 포인트 사용분 제외) 기준 적립 — 포인트로 포인트를 버는 이중적립 방지.
    long paidByMoney = cardAmount.amount() + walletAmount;
    pointService.earn(order.getUserId(), paidByMoney * EARN_RATE_PERCENT / 100, orderNo);
}
```

두 가지를 신경 썼어요.

- **적립 기준**: 카드 + 월렛(**실제 돈으로 낸 몫**)만. 포인트로 낸 몫은 제외 — 포인트로 포인트를 버는 이중적립을 막아야 하니까요. 전액 포인트 결제는 적립이 0이에요.
- **멱등**: `earn`은 `orderNo`로 멱등이에요(EARN 이력 존재검사). [사가 복구가 성공 분기를 재실행](/blog/project/pay/pay-51-checkout-saga)해도 이중적립되지 않죠. 차감·환불에서 쓰던 계약을 적립에도 똑같이 적용했어요.

조회 표면(`GET /api/v1/points`)도 함께 얹어, 사용자가 잔액·적립 이력을 보게 했어요.

![포인트·월렛 데모 — 적립·잔액·이력](/uploads/project/pay/demo/demo-points.png)

실기동으로 확인했어요.

```
포인트 0 → 30,000 카드결제 → 잔액 300(실결제액의 1%)
이력[EARN 300, order_no 스탬프], MySQL 확인
```

적립률은 지금 정책 상수(1%)로 뒀어요. 쿠폰·등급별 차등 같은 건 이후 정책으로 확장할 자리를 남겨둔 거예요("폴리시는 좀 더 고민"이라는 제 자신에게의 메모이기도 하고요).

## 마치며

셋 다 거창한 로직은 아니에요. 근데 공통점이 뚜렷했어요 — **데이터는 만들어지는데 볼 수가 없었다.** 주문은 쌓이는데 목록이 없고, 분개는 쌓이는데 장부를 못 보고, 결제는 되는데 적립이 안 되고.

배운 건, 백엔드의 "완성"은 **로직이 도는 것**이 아니라 **그 결과가 관측·소비 가능한 것**까지라는 거예요. 그리고 표면을 얹을 때도 [소유권 격리](/blog/project/pay/pay-30-maker-checker)·정합 표시(원장 균형)·이중적립 방지 같은 결제 도메인의 반사신경은 그대로 따라와야 한다는 것. 이걸로 [구독](/blog/project/pay/pay-52-subscription-surface)·[월렛](/blog/project/pay/pay-53-wallet-payment-method)에 이어, "만들고 안 쓰던" 조각들을 한 차례 크게 정리했어요.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, 내 주문 목록(소유격리)·원장 감사 뷰(균형)·포인트 적립(멱등)을 실 MySQL로 검증했습니다.*

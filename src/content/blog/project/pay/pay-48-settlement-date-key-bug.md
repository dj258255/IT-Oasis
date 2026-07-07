---
title: '정산이 조용히 가맹점에 돈을 안 주고 있었다 — 집계 키가 승인일이던 버그, 그리고 같은 날만 확정하던 테스트'
titleEn: 'Settlement Was Quietly Not Paying Merchants — an Aggregation Key Stuck on Approval Date, and Tests That Only Confirmed Same-Day'
description: 결제 시스템 개선기. 재감사에서 조용한 버그를 찾았다. 정산 배치가 "그 날짜에 CONFIRMED된 항목"을 집계하는데, 집계 키(confirmedDate)가 구매확정일이 아니라 승인일이었다. 에스크로는 며칠 홀드되므로, 승인 D일 항목은 D+7에야 CONFIRMED가 되는데 그때 confirmedDate는 여전히 D. settle(D)는 D+1에 이미 지났고 재실행도 멱등 skip. 결과 — 릴리스된 항목이 영구히 정산되지 않고 가맹점은 돈을 못 받는다. 내가 짠 코드였고, 내 테스트는 승인·확정을 같은 날로 맞춰 이 갭을 통째로 가리고 있었다.
descriptionEn: "Payment system improvement log. A fresh audit found a quiet bug. The settlement batch aggregates items CONFIRMED on a given date, but the aggregation key was the approval date, not the purchase-confirmation date. Escrow holds for days, so an item approved on D becomes CONFIRMED at D+7 — with its key still D. settle(D) already ran at D+1, and re-runs are idempotently skipped. The result: released items are never settled and the merchant is never paid. My own code, and my own tests hid the gap by confirming same-day."
date: 2027-02-20T00:00:00.000Z
tags:
  - Payment
  - Settlement
  - Bug
  - Testing
  - Domain Modeling
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 48
---

*결제 시스템 시리즈. 개선기 — 재감사가 찾아낸 조용한 정산 버그.*

## 0. "더 있나?" 하고 다시 봤더니

[정산을 에스크로에 정렬](/blog/project/pay/pay-39-settlement-escrow-alignment)하고, [수수료·부가세·지급예정일까지 고도화](/blog/project/pay/pay-45-settlement-fee-payout)한 뒤였어요. 다 됐다 싶어 코드베이스를 결제 도메인 리뷰어 시각으로 **한 번 더** 훑었어요. 그러다 정산에서 조용한 버그 하나를 만났어요 — 에러도 안 나고, 테스트도 초록불인데, **가맹점에 돈이 안 나가는** 버그를요.

## 1. 집계 키가 잘못된 날짜였다

정산 배치의 핵심은 이 한 줄이에요.

```java
itemRepository.findByStatusAndConfirmedDate(CONFIRMED, date);
// "그 date에 CONFIRMED된 정산 항목"을 집계
```

`status == CONFIRMED` **그리고** `confirmedDate == date` 둘 다 맞는 항목을 모아요. 문제는 이 `confirmedDate`가 뭐냐는 거였어요.

```java
// 적재 시점(결제 승인 이벤트)
LocalDate confirmedDate = LocalDate.ofInstant(event.approvedAt(), UTC);  // ← 승인일
```

이름은 `confirmedDate`("구매확정일")인데, 실제로 담긴 건 **승인일**이었어요. 그리고 항목이 `CONFIRMED`(정산 가능)로 바뀌는 건 [에스크로 릴리스(구매확정)](/blog/project/pay/pay-25-escrow) 시점이고, 그 전이는 `confirmedDate`를 **재스탬프하지 않았어요.**

이게 왜 치명적이냐면 — **에스크로는 며칠 홀드돼요**(기본 7일).

> 결제가 D일에 승인 → 항목 적재(`confirmedDate = D`, PENDING). D+1일에 `settle(D)` 배치가 도는데, 이 항목은 아직 PENDING이라 제외돼요. **D+7일**에 에스크로가 릴리스되어 CONFIRMED가 되지만, `confirmedDate`는 **여전히 D.** 그런데 `settle(D)`는 D+1에 이미 실행됐고, [재실행은 멱등하게 skip](/blog/project/pay/pay-45-settlement-fee-payout)돼요(그 날짜 정산이 이미 있으니까). 스케줄러는 매일 `settle(어제)`만 돌지, 과거를 다시 안 돌아요.
>
> 결과 — 이 항목은 **CONFIRMED인 채로 영원히 집계되지 않아요.** "그 날짜에 CONFIRMED된 항목"이라는 조건을, 어떤 배치도 만족시키지 못해요. `settle(D)`가 돌 땐 PENDING이었고, `settle(D+7)`엔 `confirmedDate`가 안 맞으니까요. **가맹점은 돈을 못 받아요.**

제일 무서운 건, 에스크로 홀드가 본질적으로 며칠짜리라 이게 **예외가 아니라 거의 모든 항목의 기본 경로**라는 거예요. "구매확정 시점 정산"을 하겠다고 한 [바로 그 리워크](/blog/project/pay/pay-39-settlement-escrow-alignment)가, 정작 지급을 막고 있었어요.

## 2. 내 테스트는 왜 못 잡았나

더 뼈아픈 건 테스트였어요. 정산 테스트의 헬퍼가 이랬거든요.

```java
private static SettlementItem confirmedItem(...) {
    SettlementItem item = SettlementItem.of(..., DATE);  // 승인일 = DATE
    item.confirm();                                       // 곧바로 확정
    return item;                                          // confirmedDate == DATE
}
```

**승인하자마자 같은 날 확정**하니, `confirmedDate`와 `settle` 대상 날짜가 늘 일치했어요. 그래서 모든 테스트가 통과했죠. 하지만 실제로 "승인하자마자 같은 날 구매확정"은 **거의 안 일어나요** — 에스크로가 며칠 홀드하니까요.

> 테스트가 "승인일 == 확정일"이라는, 현실에선 드문 조건에서만 돌아서 버그를 통째로 가렸어요. [실기동 검증](/blog/project/pay/pay-26-persistence-bug) 때도 저는 결제 후 **바로** 구매확정을 눌렀거든요. 그러니 그때도 우연히 통과했고요. 승인과 확정 사이의 **시간 간격**이라는 결제 정산의 본질을, 테스트도 저도 좁혀서 안 보고 있던 거예요.

## 3. 고침 — 확정일로 재스탬프

해법은 집계 키를 승인일이 아니라 **구매확정(릴리스)일**로 바꾸는 거였어요. 마침 `EscrowReleasedEvent`가 릴리스 시각을 담고 있었어요.

```java
public void confirm(LocalDate settlementReadyDate) {
    if (this.status == PENDING_CONFIRMATION) {
        this.status = CONFIRMED;
        this.confirmedDate = settlementReadyDate;   // ← 릴리스일로 재스탬프
    }
}
```

```java
void onEscrowReleased(EscrowReleasedEvent event) {
    LocalDate releaseDate = LocalDate.ofInstant(event.releasedAt(), UTC);
    settlementService.confirmSettlement(event.orderNo(), releaseDate);
}
```

이제 릴리스일 R로 재스탬프되니, **R+1의 `settle(R)`이 정확히 이 항목을 집계**해요. 재밌는 건, 이 수정이 필드 이름도 바로잡았다는 거예요 — 이제 `confirmedDate`는 정말로 "구매확정일"이에요(전엔 이름과 달리 승인일이었죠).

그리고 회귀 테스트를 심었어요 — 승인 D일 적재 → D+7 릴리스 → **릴리스일 배치가 잡는지**. 이제 이 테스트가 있으니, 누가 다시 승인일로 되돌리면 빨간불이 떠요.

실 MySQL로 확인했어요.

```
승인일 backdate(2026-06-01) → PENDING (confirmed_date=2026-06-01)
구매확정(에스크로 릴리스) → CONFIRMED, confirmed_date=2026-07-07 (재스탬프!)
settle(2026-07-07) → 집계 → SETTLED, 정산 생성(net 9,703)
```

승인일 6월 1일이던 항목이, 릴리스 시 오늘로 재스탬프되어 오늘 배치에 정확히 잡혀요.

## 마치며

이번 건 "만들었는데 안 돌더라"의 가장 **조용한** 버전이었어요. 컴파일도 되고, 테스트도 통과하고, 데모도 됐어요 — 근데 프로덕션 타이밍(승인과 확정 사이 며칠)에선 가맹점에 돈이 안 나갔죠.

두 가지를 다시 배웠어요. 하나는 **집계 키는 그 상태로 전이되는 시점의 값이어야** 한다는 것 — "그 날짜에 X된 것"을 찾을 거면, X가 일어난 날짜를 키로 삼아야지, 다른 사건(승인)의 날짜를 쓰면 조건이 영영 안 맞아요. 다른 하나는 **테스트가 시간을 압축하면 시간 버그를 못 잡는다**는 것. 같은 날 승인·확정하는 테스트는, 며칠 걸리는 실제 흐름의 버그에 눈을 감아요.

그리고 이걸 잡은 건 새 기능이 아니라, "**다 됐나?" 하고 한 번 더 본** 재감사였어요. 결제처럼 돈이 오가는 도메인에선, 초록불 뒤를 한 번 더 의심하는 게 기능을 하나 더 만드는 것만큼 중요하더라고요.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, 승인일 backdate → 릴리스 재스탬프 → 릴리스일 배치 집계까지 실 MySQL로 검증했습니다.*

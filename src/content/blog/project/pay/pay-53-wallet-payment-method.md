---
title: '결제수단마다 롤백 계약이 다르다 — 월렛을 체크아웃에 배선하며 배운 것'
titleEn: 'Every Payment Method Has a Different Rollback Contract — Wiring a Wallet into Checkout'
description: 결제 시스템 개선기. 선불 월렛(WalletService)은 충전·차감·환불 로직까지 다 있었는데 어디서도 부르지 않는 완전한 고아였다. 사용자 REST 표면을 얹고 체크아웃 복합결제 수단으로 배선하는 과정에서, 포인트와 월렛의 롤백 계약이 근본적으로 다르다는 걸 마주쳤다. 포인트는 트랜잭션에 합류해 자동 롤백되지만, 월렛은 커밋되는 부수효과라 카드처럼 명시적 보상이 필요했다. 사가 재진입에 안전한 orderNo 멱등 환불과, 결제수단 분할을 원장에서 역산하는 복구까지의 이야기.
descriptionEn: "Payment system improvement log. The prepaid wallet had charge/use/refund logic but was a complete orphan — called from nowhere. Adding a REST surface and wiring it as a composite checkout payment method surfaced a fundamental truth: points and wallet have different rollback contracts. Points join the transaction and roll back automatically; the wallet is a committed side-effect needing explicit compensation like the card leg. A story about orderNo-idempotent refunds safe under saga re-entry, and reconstructing the payment split from the append-only ledger during recovery."
date: 2027-03-27T00:00:00.000Z
tags:
  - Payment
  - Wallet
  - Saga
  - Idempotency
  - Spring Boot
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 53
---

*결제 시스템 시리즈. 개선기 — 고아였던 월렛을 결제수단으로 살려내다.*

## 0. 이번 고아는 "표면도 없고 배선도 없는" 완전체였다

[구독 편](/blog/project/pay/pay-52-subscription-surface)에서 "서비스만 있고 부를 API가 없던" 모듈을 완성했는데, 훑다 보니 그보다 더한 게 있었어요 — `wallet`(선불 월렛)이요. `grep`으로 `WalletService`를 찾으면 **월렛 패키지 밖에서는 단 한 번도 안 나와요.** 컨트롤러도 없고, 체크아웃도 안 부르고. 충전·차감·환불·잔액 로직에 낙관적 락 재시도까지 정성껏 있는데, **아무도 안 쓰는 완전한 고아**였죠.

월렛은 토스·카카오페이 어디나 있는 핵심 결제수단이라, 이번엔 두 가지를 했어요.

1. **사용자 표면** — 충전·잔액·이력 REST (`/api/v1/wallet`).
2. **체크아웃 배선** — 카드·포인트와 함께 쓰는 **복합결제 수단**.

그런데 2번을 하다가, 생각보다 깊은 걸 마주쳤어요.

## 1. 표면은 쉬웠다

먼저 표면. 이미 있는 `charge`/`balance`에 이력 조회만 얹으면 됐어요.

```
POST /api/v1/wallet/charge   충전(전금법 기명 한도 검증)
GET  /api/v1/wallet          잔액 + 최근 거래 이력 20건
```

이력은 `findTop20ByUserIdOrderByIdDesc` — `Top20`으로 **DB에서 LIMIT**을 걸어 무한 적재를 막고, `id`(단조증가) 정렬로 같은 시각 거래의 타이순서 흔들림도 없앴어요. userId는 [늘 그렇듯](/blog/project/pay/pay-30-maker-checker) 인증 principal에서 얻어 본인 월렛만 봐요. 실 MySQL로 5만→3만 누적 8만, 이력 2건, 한도초과 409까지 확인했어요. 여기까진 평이했죠.

## 2. 체크아웃에 넣으려다 마주친 것 — 롤백 계약이 다르다

기존 체크아웃은 이미 **카드 + 포인트** 복합결제를 하고 있었어요([사가 편](/blog/project/pay/pay-51-checkout-saga)). "월렛도 세 번째 몫으로 끼우면 되겠네" 하고 포인트를 흉내 내려다, 둘이 **근본적으로 다르다**는 걸 알았어요.

포인트 서비스는 클래스에 `@Transactional`이 걸려 있어요.

```java
@Transactional
public class PointService {
    public void use(long userId, long amount, String orderNo) { ... }
}
```

즉 `pointService.use()`는 예약 트랜잭션(`reserve`)에 **합류**해요. 예약이 뒤에서 롤백되면 포인트 차감도 **자동으로 같이 롤백**되죠. 그래서 사가는 예약 실패 시 포인트를 명시적으로 되돌리지 않아요 — 트랜잭션이 알아서 해주니까.

그런데 월렛은 일부러 `@Transactional`을 **안** 걸었어요.

```java
// 재시도 루프를 단일 @Transactional로 감싸지 않는다 — 첫 낙관적 락 충돌에서
// 트랜잭션이 rollback-only가 되어 재시도가 무의미해지기 때문.
private long mutateWithRetry(...) {
    while (true) {
        try {
            ...
            accountRepository.saveAndFlush(account); // 각 시도가 자체 짧은 tx로 커밋
            ...
        } catch (OptimisticLockException e) { /* 다음 시도 */ }
    }
}
```

낙관적 락 재시도를 하려면 각 시도가 독립적으로 커밋돼야 해요(한 tx로 감싸면 첫 충돌에 rollback-only가 박혀 재시도가 죽어요). 그 결과 —

> **월렛 차감은 "커밋되는 부수효과"예요.** 예약 트랜잭션이 나중에 롤백돼도 월렛 차감은 되돌아오지 않아요. 포인트처럼 취급하면, 카드가 거절됐을 때 **차감된 월렛 잔액이 그대로 증발**하죠(자금 손실).

즉 월렛은 포인트가 아니라 **카드 레그**를 닮았어요. 카드 승인도 커밋되는 외부 효과라, 사가는 실패 시 [망취소를 아웃박스에 적재](/blog/project/pay/pay-51-checkout-saga)해 **명시적으로 보상**하잖아요. 월렛도 똑같이 **명시적 환불**이 필요했어요.

정리하면 세 결제수단의 롤백 계약이 이렇게 갈려요.

| 결제수단 | 트랜잭션 | 실패 시 되돌리기 |
|---|---|---|
| 포인트 | 예약 tx에 **합류** | 자동 롤백 (아무것도 안 함) |
| 카드 | 외부 승인, 커밋됨 | 명시적 **망취소**(아웃박스) |
| 월렛 | 자체 tx, 커밋됨 | 명시적 **환불**(동기, 멱등) |

## 3. 명시적 보상을, 사가 재진입에 안전하게

보상을 넣는 자리는 `settle`의 두 실패 분기예요 — **카드 거절**과 **승인 후 재고 부족**.

```java
} else {
    // 명시적 거절: 선점 포인트·월렛 복원, 주문 PENDING_PAYMENT로 복귀.
    if (pointAmount > 0)  pointService.restore(userId, pointAmount, orderNo);
    if (walletAmount > 0) walletService.refund(userId, walletAmount, orderNo); // 멱등
    order.revertToPending();
}
```

여기서 중요한 게 **멱등**이에요. 사가는 크래시하면 [복구 배치가 `settle`을 다시 돌려요](/blog/project/pay/pay-51-checkout-saga). 환불이 멱등하지 않으면 복구가 **이중 환불**을 해버리죠. 그래서 월렛 차감/환불을 `orderNo`로 멱등화했어요 — 포인트가 이미 쓰던 계약과 똑같이.

```java
// (1) 이력에 같은 (orderNo, type)이 있으면 재적용 안 함
if (orderNo != null && transactionRepository.existsByOrderNoAndType(orderNo, type)) {
    return balance(userId);
}
// ... 차감/환불 ...
// (2) 그 사이 다른 스레드가 먼저 넣어 (order_no, type) 유니크를 위반하면 → 멱등 skip
catch (DataIntegrityViolationException e) { return balance(userId); }
```

존재검사(빠른 경로)와 **`(order_no, type)` 유니크 인덱스**(최후 방어선) 이중으로 막아요. 사가 경로에선 같은 주문의 동시 차감이 [주문 상태전이(`startPayment`)로 상위에서 이미 직렬화](/blog/project/pay/pay-51-checkout-saga)되니, 잔액과 이력이 원자적이지 않아도 이중반영이 안 나요.

그리고 `reserve`에서 월렛 차감을 **맨 마지막**(주문 저장 후)에 뒀어요. 커밋되는 부수효과라, 뒤에 실패할 in-tx 작업이 남아 있으면 그만큼 고아가 될 창이 생기거든요. 맨 뒤에 두면 그 창이 사라져요.

## 4. 복구는 "분할"을 어디서 아는가 — 원장에서 역산

미묘한 게 하나 더 있었어요. 크래시 복구가 `settle`을 재실행하려면 카드·포인트·월렛 **각 몫**을 알아야 하는데, 원 요청의 분할은 **주문에 저장돼 있지 않아요.** 기존 복구는 `포인트 = 총액 - 카드`로 역산했는데, 월렛이 끼면 `총액 - 카드 = 포인트 + 월렛`이라 둘을 못 나눠요.

답은 **append-only 월렛 원장**이었어요. 차감할 때 `order_no`를 남겼으니, 그게 진실의 원천이에요.

```java
long walletAmount = walletService.reservedAmountForOrder(orderNo); // USE 이력에서 역산
long pointAmount  = order.getTotalAmount() - cardAmount - walletAmount;
```

[복식부기 원장](/blog/project/pay/pay-5-lock-comparison)을 "잔액의 파생 근거"로만 보다가, 여기선 **복구가 상태를 재구성하는 근거**로 쓰였어요. 부수효과를 기록으로 남겨두면, 나중에 그 기록이 시스템을 고쳐 세우는 재료가 된다는 걸 체감했죠.

## 5. 눌러볼 수 있는 월렛

데모 콘솔에 월렛 패널을 붙이고, 체크아웃에 월렛 몫을 넣을 수 있게 했어요.

![선불 월렛 데모 — 충전·잔액·이력, 체크아웃 복합결제 수단](/uploads/project/pay/demo/demo-wallet.png)

실 MySQL로 전 흐름을 확인했어요.

```
충전       → 월렛 80,000
주문 20,000 → 카드 14,000 + 월렛 6,000 결제
결과       → 주문 PAID, 카드결제 DONE(14,000)
월렛       → 80,000 → 74,000, USE 이력(order_no 스탬프) 1건
금액불일치  → 월렛 차감 전 403 차단(잔액·이력 불변)
```

카드+월렛이 정확히 합쳐져 결제되고, 월렛이 딱 6,000 줄고, 그 차감엔 `order_no`가 찍혀 있어요. 분할이 안 맞으면 **월렛을 건드리기 전에** 막히고요.

## 마치며

표면 얹는 건 반나절이었는데, 배선은 그렇지 않았어요. **"포인트처럼 하면 되겠지"가 자금 손실 버그였으니까요.** 결제수단마다 트랜잭션과의 관계가 다르고, 그게 곧 실패 시 되돌리는 방법을 결정해요 — 합류하면 자동 롤백, 커밋되면 명시적 보상. 이 계약을 착각하면 돈이 새요.

배운 건 세 가지예요. **(1)** 커밋되는 부수효과는 트랜잭션이 지켜주지 않으니 명시적으로 보상해야 하고, **(2)** 그 보상은 사가 재진입을 견디게 멱등이어야 하며, **(3)** 상태를 재구성할 근거는 append-only 기록에 미리 남겨둬야 한다는 것. 고아 하나 살리는 일이, 결국 사가의 실패 의미론을 한 겹 더 정확하게 만드는 일이었어요.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, 카드+월렛 복합결제·orderNo 멱등 환불·원장 기반 복구를 실 MySQL로 검증했습니다.*

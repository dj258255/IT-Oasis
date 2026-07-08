---
title: '기능 확장과 정밀 감사'
description: 숨어 있던 구독·월렛을 사용자 표면으로, 안 보이던 주문목록·원장·포인트 적립, 진짜 회원 도메인, 차지백/분쟁, 그리고 새 코드를 스스로 감사해 잡은 자금 손실 버그.
date: 2027-03-20T00:00:00.000Z
tags:
  - Payment
  - Spring Boot
  - Spring Modulith
  - 결제 시스템
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 10
---

*결제 시스템 시리즈 — 기능 확장과 정밀 감사. (원 연재 여러 편을 한 챕터로 묶었습니다. 각 절이 원래 한 편입니다.)*

## 빌링키도 dunning도 다 만들어놓고 — 구독을 부를 방법이 없었다

*결제 시스템 시리즈. 개선기 — 숨어 있던 구독 모듈을 완성하다.*

### 0. 또 "만들고 안 쓴 것" — 이번엔 통째로

[감사](/blog/project/pay/pay-ch7-consume-align-harden)와 [재감사](/blog/project/pay/pay-ch8-settlement-pg-webhook)로 "만들어놓고 배선 안 한 것들"을 계속 잡아왔는데, 전체 기능 관점에서 훑어보니 **모듈 하나가 통째로 숨어 있었어요** — `subscription`(구독)이요.

안을 열어보니 이미 꽤 정성껏 지어져 있었어요.

- **빌링키**: [envelope 암호화 + 블라인드 인덱스](/blog/project/pay/pay-ch7-consume-align-harden)로 저장(카드 토큰이라 민감).
- **정기청구 배치**: `runBillingCycle`이 청구일 도래한 구독을 청구.
- **dunning**: soft decline은 재시도(유예 기간), hard decline은 정지, 재시도 소진 판정까지.

그런데 —

> **이걸 부를 API가 하나도 없었어요.** 컨트롤러 0개. 구독을 **개시할 수도, 조회할 수도, 해지할 수도** 없었죠. 정기청구 배치는 있는데 청구할 구독을 만들 방법이 없으니, 사실상 **아무도 못 쓰는 완성품**이었어요. [금고를 만들고 안 채운 것](/blog/project/pay/pay-ch7-consume-align-harden)처럼, 이번엔 방을 다 지어놓고 문을 안 단 셈이었어요.

구독은 SaaS·멤버십 어디나 있는 **핵심 결제 상품**이라, 이 표면을 완성했어요.

### 1. 사용자 표면 — 개시·조회·해지·즉시청구

REST 표면을 얹었어요.

```
POST /api/v1/subscriptions           구독 개시(빌링키 + 월 금액)
GET  /api/v1/subscriptions           내 구독 목록
GET  /api/v1/subscriptions/{id}      상세 + 청구 이력
POST /api/v1/subscriptions/{id}/cancel     해지
POST /api/v1/subscriptions/{id}/bill-now   즉시 청구(데모/운영)
```

기존 서비스가 이미 `subscribe`·`changePlan`·`runBillingCycle`을 갖고 있어서, 저는 **부족한 조각만** 채우면 됐어요 — `cancel`, 조회(`subscriptionsOf`/`detail`), 그리고 데모용 즉시청구(`billNow`).

여기서 신경 쓴 게 **소유권**이에요. 구독은 회원 개인 자산이라, 남의 구독을 조회·해지하면 안 돼요.

```java
private Subscription requireOwned(Long subscriptionId, long userId) {
    Subscription s = subscriptionRepository.findById(subscriptionId)
            .orElseThrow(() -> SubscriptionException.notFound(subscriptionId));
    if (s.getUserId() != userId) {
        throw new SubscriptionException("SUBSCRIPTION_FORBIDDEN", "본인의 구독만 접근할 수 있습니다.");
    }
    return s;
}
```

[주문에서 IDOR를 막던 것](/blog/project/pay/pay-ch5-runtime-truths)과 똑같은 원칙 — userId는 클라이언트가 아니라 **인증 principal에서** 얻고, 그 무엇보다 먼저 소유권을 검증해요. 실기동으로 user2가 user1의 구독을 조회하면 **403**이 나는 걸 확인했어요.

### 2. 배치와 즉시청구가 한 로직을 공유하게

데모에서 "즉시 청구"를 눌러 dunning을 관찰하고 싶은데, 청구 로직은 배치(`runBillingCycle`) 루프 안에 있었어요. 복붙하면 두 벌이 갈라지죠. 그래서 **한 구독 청구**를 `bill()`로 추출했어요.

```java
private void bill(Subscription subscription, LocalDate today) {
    BillingResult result = billingGateway.charge(subscription.getBillingKey(), subscription.getPlanAmount());
    switch (result) {
        case SUCCESS      -> handleSuccess(subscription);       // renew + 다음 청구일
        case SOFT_DECLINE -> handleSoftDecline(subscription, today);  // 재시도 예약/유예
        case HARD_DECLINE -> handleHardDecline(subscription);   // 정지
    }
    subscriptionRepository.saveAndFlush(subscription);
}
```

이제 배치는 청구일 도래분을 돌며 `bill()`을 부르고, 즉시청구(`billNow`)도 같은 `bill()`을 한 번 불러요. **dunning·상태전이·이력 기록이 한 곳에서만** 일어나니, 배치로 청구하든 버튼으로 청구하든 동작이 정확히 같아요.

### 3. 눌러볼 수 있는 구독

데모 콘솔에 구독 패널을 붙였어요.

![구독 정기결제 데모 — 개시·상태·청구주기·해지](/uploads/project/pay/demo/demo-subscription.png)

빌링키로 구독을 개시하면 `ACTIVE`로 뜨고 다음 청구일이 한 달 뒤로 잡혀요. "즉시 청구"를 누르면 청구가 일어나 다음 청구일이 갱신되고, 상세를 보면 청구 이력(성공/decline)이 쌓여요. 해지하면 `CANCELED`가 되고요. **서비스 계층에만 있던 구독이, 이제 눌러볼 수 있는 기능이 됐어요.**

실기동으로 전 흐름을 확인했어요.

```
구독 개시 → id=1 ACTIVE, 다음 청구 2026-08-07
즉시 청구 → 성공, 다음 청구 2026-09-07로 갱신, 이력[SUCCESS]
해지     → CANCELED
user2가 user1 구독 조회 → 403 (IDOR 차단)
```

### 마치며

이번 건 새 로직이라기보단 **완성**이에요 — 빌링키 암호화도, 정기청구도, dunning도 이미 있었으니까요. 근데 그것들이 **부를 수 없으면 없는 것과 같아요.** 이 시리즈가 반복해서 보여준 "만들었다 ≠ 쓸 수 있다"의, 이번엔 모듈 통째 버전이었죠.

배운 건 하나예요 — **표면(API)이 없으면 도메인 로직이 아무리 정교해도 죽은 코드**라는 것. 그리고 표면을 얹을 때도 소유권 검증 같은 [신뢰 경계](/blog/project/pay/pay-ch5-runtime-truths)는 반사적으로 따라와야 한다는 것. 잘 지어둔 방에 문을 달고 자물쇠를 채우니, 비로소 구독이 **쓸 수 있는 상품**이 됐어요.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, 구독 개시·즉시청구·이력·해지·IDOR 차단을 실 MySQL로 검증했습니다.*

<hr />

## 결제수단마다 롤백 계약이 다르다 — 월렛을 체크아웃에 배선하며 배운 것

*결제 시스템 시리즈. 개선기 — 고아였던 월렛을 결제수단으로 살려내다.*

### 0. 이번 고아는 "표면도 없고 배선도 없는" 완전체였다

[구독 편](/blog/project/pay/pay-ch10-features-audit)에서 "서비스만 있고 부를 API가 없던" 모듈을 완성했는데, 훑다 보니 그보다 더한 게 있었어요 — `wallet`(선불 월렛)이요. `grep`으로 `WalletService`를 찾으면 **월렛 패키지 밖에서는 단 한 번도 안 나와요.** 컨트롤러도 없고, 체크아웃도 안 부르고. 충전·차감·환불·잔액 로직에 낙관적 락 재시도까지 정성껏 있는데, **아무도 안 쓰는 완전한 고아**였죠.

월렛은 토스·카카오페이 어디나 있는 핵심 결제수단이라, 이번엔 두 가지를 했어요.

1. **사용자 표면** — 충전·잔액·이력 REST (`/api/v1/wallet`).
2. **체크아웃 배선** — 카드·포인트와 함께 쓰는 **복합결제 수단**.

그런데 2번을 하다가, 생각보다 깊은 걸 마주쳤어요.

### 1. 표면은 쉬웠다

먼저 표면. 이미 있는 `charge`/`balance`에 이력 조회만 얹으면 됐어요.

```
POST /api/v1/wallet/charge   충전(전금법 기명 한도 검증)
GET  /api/v1/wallet          잔액 + 최근 거래 이력 20건
```

이력은 `findTop20ByUserIdOrderByIdDesc` — `Top20`으로 **DB에서 LIMIT**을 걸어 무한 적재를 막고, `id`(단조증가) 정렬로 같은 시각 거래의 타이순서 흔들림도 없앴어요. userId는 [늘 그렇듯](/blog/project/pay/pay-ch5-runtime-truths) 인증 principal에서 얻어 본인 월렛만 봐요. 실 MySQL로 5만→3만 누적 8만, 이력 2건, 한도초과 409까지 확인했어요. 여기까진 평이했죠.

### 2. 체크아웃에 넣으려다 마주친 것 — 롤백 계약이 다르다

기존 체크아웃은 이미 **카드 + 포인트** 복합결제를 하고 있었어요([사가 편](/blog/project/pay/pay-ch9-audit-saga)). "월렛도 세 번째 몫으로 끼우면 되겠네" 하고 포인트를 흉내 내려다, 둘이 **근본적으로 다르다**는 걸 알았어요.

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

즉 월렛은 포인트가 아니라 **카드 레그**를 닮았어요. 카드 승인도 커밋되는 외부 효과라, 사가는 실패 시 [망취소를 아웃박스에 적재](/blog/project/pay/pay-ch9-audit-saga)해 **명시적으로 보상**하잖아요. 월렛도 똑같이 **명시적 환불**이 필요했어요.

정리하면 세 결제수단의 롤백 계약이 이렇게 갈려요.

| 결제수단 | 트랜잭션 | 실패 시 되돌리기 |
|---|---|---|
| 포인트 | 예약 tx에 **합류** | 자동 롤백 (아무것도 안 함) |
| 카드 | 외부 승인, 커밋됨 | 명시적 **망취소**(아웃박스) |
| 월렛 | 자체 tx, 커밋됨 | 명시적 **환불**(동기, 멱등) |

### 3. 명시적 보상을, 사가 재진입에 안전하게

보상을 넣는 자리는 `settle`의 두 실패 분기예요 — **카드 거절**과 **승인 후 재고 부족**.

```java
} else {
    // 명시적 거절: 선점 포인트·월렛 복원, 주문 PENDING_PAYMENT로 복귀.
    if (pointAmount > 0)  pointService.restore(userId, pointAmount, orderNo);
    if (walletAmount > 0) walletService.refund(userId, walletAmount, orderNo); // 멱등
    order.revertToPending();
}
```

여기서 중요한 게 **멱등**이에요. 사가는 크래시하면 [복구 배치가 `settle`을 다시 돌려요](/blog/project/pay/pay-ch9-audit-saga). 환불이 멱등하지 않으면 복구가 **이중 환불**을 해버리죠. 그래서 월렛 차감/환불을 `orderNo`로 멱등화했어요 — 포인트가 이미 쓰던 계약과 똑같이.

```java
// (1) 이력에 같은 (orderNo, type)이 있으면 재적용 안 함
if (orderNo != null && transactionRepository.existsByOrderNoAndType(orderNo, type)) {
    return balance(userId);
}
// ... 차감/환불 ...
// (2) 그 사이 다른 스레드가 먼저 넣어 (order_no, type) 유니크를 위반하면 → 멱등 skip
catch (DataIntegrityViolationException e) { return balance(userId); }
```

존재검사(빠른 경로)와 **`(order_no, type)` 유니크 인덱스**(최후 방어선) 이중으로 막아요. 사가 경로에선 같은 주문의 동시 차감이 [주문 상태전이(`startPayment`)로 상위에서 이미 직렬화](/blog/project/pay/pay-ch9-audit-saga)되니, 잔액과 이력이 원자적이지 않아도 이중반영이 안 나요.

그리고 `reserve`에서 월렛 차감을 **맨 마지막**(주문 저장 후)에 뒀어요. 커밋되는 부수효과라, 뒤에 실패할 in-tx 작업이 남아 있으면 그만큼 고아가 될 창이 생기거든요. 맨 뒤에 두면 그 창이 사라져요.

### 4. 복구는 "분할"을 어디서 아는가 — 원장에서 역산

미묘한 게 하나 더 있었어요. 크래시 복구가 `settle`을 재실행하려면 카드·포인트·월렛 **각 몫**을 알아야 하는데, 원 요청의 분할은 **주문에 저장돼 있지 않아요.** 기존 복구는 `포인트 = 총액 - 카드`로 역산했는데, 월렛이 끼면 `총액 - 카드 = 포인트 + 월렛`이라 둘을 못 나눠요.

답은 **append-only 월렛 원장**이었어요. 차감할 때 `order_no`를 남겼으니, 그게 진실의 원천이에요.

```java
long walletAmount = walletService.reservedAmountForOrder(orderNo); // USE 이력에서 역산
long pointAmount  = order.getTotalAmount() - cardAmount - walletAmount;
```

[복식부기 원장](/blog/project/pay/pay-ch1-payment-core)을 "잔액의 파생 근거"로만 보다가, 여기선 **복구가 상태를 재구성하는 근거**로 쓰였어요. 부수효과를 기록으로 남겨두면, 나중에 그 기록이 시스템을 고쳐 세우는 재료가 된다는 걸 체감했죠.

### 5. 눌러볼 수 있는 월렛

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

### 마치며

표면 얹는 건 반나절이었는데, 배선은 그렇지 않았어요. **"포인트처럼 하면 되겠지"가 자금 손실 버그였으니까요.** 결제수단마다 트랜잭션과의 관계가 다르고, 그게 곧 실패 시 되돌리는 방법을 결정해요 — 합류하면 자동 롤백, 커밋되면 명시적 보상. 이 계약을 착각하면 돈이 새요.

배운 건 세 가지예요. **(1)** 커밋되는 부수효과는 트랜잭션이 지켜주지 않으니 명시적으로 보상해야 하고, **(2)** 그 보상은 사가 재진입을 견디게 멱등이어야 하며, **(3)** 상태를 재구성할 근거는 append-only 기록에 미리 남겨둬야 한다는 것. 고아 하나 살리는 일이, 결국 사가의 실패 의미론을 한 겹 더 정확하게 만드는 일이었어요.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, 카드+월렛 복합결제·orderNo 멱등 환불·원장 기반 복구를 실 MySQL로 검증했습니다.*

<hr />

## 쌓이기만 하고 안 보이던 것들 — 주문 목록·원장·포인트 적립을 표면으로

*결제 시스템 시리즈. 개선기 — 쌓이는데 안 보이던 세 가지를 표면으로.*

### 0. 또 "만들어지는데 안 보이는 것"

[구독](/blog/project/pay/pay-ch10-features-audit)도 [월렛](/blog/project/pay/pay-ch10-features-audit)도 "로직은 있는데 부를 수 없던" 걸 완성했는데, 훑다 보니 결이 조금 다른 셋이 더 있었어요. **데이터는 계속 만들어지는데, 그걸 볼 표면이 없어 죽어 있던** 것들이요.

- **주문**: 단건 조회(`GET /orders/{orderNo}`)만 있고, "내 주문 목록"이 없었어요.
- **원장**: 결제할 때마다 복식부기 분개가 쌓이는데, 들여다볼 방법이 없었어요.
- **포인트**: 차감(USE)·복원·환불만 있고 **적립(EARN)이 없었어요.** 쓸 줄만 알고 줄 줄은 몰랐던 거죠.

셋 다 작지만, "만들었다 ≠ 쓸 수 있다"의 또 다른 얼굴이에요.

### 1. 내 주문 목록 — 소유권을 쿼리로 격리

목록 API를 얹었어요.

```
GET /api/v1/orders     내 주문 목록(최신 50건 요약)
```

여기서 IDOR(남의 주문 조회)를 막는 방식이 [단건 조회 때](/blog/project/pay/pay-ch5-runtime-truths)와 달라요. 단건은 주문을 불러온 뒤 `verifyOwner`로 막지만, 목록은 **쿼리 자체가 본인 것만** 가져와요.

```java
public List<OrderSummaryView> myOrders(long authenticatedUserId) {
    return orderRepository.findTop50ByUserIdOrderByIdDesc(authenticatedUserId).stream()
            .map(OrderSummaryView::from)
            .toList();
}
```

userId는 인증 principal에서 오고, WHERE 절이 그걸로 걸리니 **남의 주문은 애초에 조회 대상이 아니에요.** 검증으로 걸러내는 게 아니라 안 가져오는 것 — IDOR 방어의 가장 단순한 형태죠. 실기동으로 user1은 자기 주문이 최신순으로 뜨고, user2는 0건인 걸 확인했어요. `Top50`으로 상한을 둬 무한 적재도 막았고요.

### 2. 원장 감사 뷰 — 차변·대변 균형까지

[복식부기 원장](/blog/project/pay/pay-ch1-payment-core)은 결제 승인마다 `PG미수금(차변) ↔ 매출(대변)` 분개를 append-only로 쌓아요. 그런데 운영자가 그걸 볼 수가 없었어요. 감사용 어드민 뷰를 얹었어요.

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

> 월렛 6,000은 **이미 받아둔 선불(prepaid)**이라, 새로 생기는 PG 미수금이 아니에요. 그래서 원장엔 카드분 14,000만 `PG미수금 ↔ 매출`로 잡혀요. [사가에서 본 결제수단의 경제적 의미 차이](/blog/project/pay/pay-ch10-features-audit)가, 이번엔 **장부에 그대로 드러난** 거죠. 회계가 맞으려면 이게 맞아야 해요.

비관리자가 이 엔드포인트를 부르면 403이 나는 것도 확인했어요.

### 3. 포인트 적립 — 실결제액 기준, 이중적립 없이

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
- **멱등**: `earn`은 `orderNo`로 멱등이에요(EARN 이력 존재검사). [사가 복구가 성공 분기를 재실행](/blog/project/pay/pay-ch9-audit-saga)해도 이중적립되지 않죠. 차감·환불에서 쓰던 계약을 적립에도 똑같이 적용했어요.

조회 표면(`GET /api/v1/points`)도 함께 얹어, 사용자가 잔액·적립 이력을 보게 했어요.

![포인트·월렛 데모 — 적립·잔액·이력](/uploads/project/pay/demo/demo-points.png)

실기동으로 확인했어요.

```
포인트 0 → 30,000 카드결제 → 잔액 300(실결제액의 1%)
이력[EARN 300, order_no 스탬프], MySQL 확인
```

적립률은 지금 정책 상수(1%)로 뒀어요. 쿠폰·등급별 차등 같은 건 이후 정책으로 확장할 자리를 남겨둔 거예요("폴리시는 좀 더 고민"이라는 제 자신에게의 메모이기도 하고요).

### 마치며

셋 다 거창한 로직은 아니에요. 근데 공통점이 뚜렷했어요 — **데이터는 만들어지는데 볼 수가 없었다.** 주문은 쌓이는데 목록이 없고, 분개는 쌓이는데 장부를 못 보고, 결제는 되는데 적립이 안 되고.

배운 건, 백엔드의 "완성"은 **로직이 도는 것**이 아니라 **그 결과가 관측·소비 가능한 것**까지라는 거예요. 그리고 표면을 얹을 때도 [소유권 격리](/blog/project/pay/pay-ch5-runtime-truths)·정합 표시(원장 균형)·이중적립 방지 같은 결제 도메인의 반사신경은 그대로 따라와야 한다는 것. 이걸로 [구독](/blog/project/pay/pay-ch10-features-audit)·[월렛](/blog/project/pay/pay-ch10-features-audit)에 이어, "만들고 안 쓰던" 조각들을 한 차례 크게 정리했어요.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, 내 주문 목록(소유격리)·원장 감사 뷰(균형)·포인트 적립(멱등)을 실 MySQL로 검증했습니다.*

<hr />

## 데모 계정밖에 없던 인증에 진짜 회원을 붙이다 — 숫자 userId 계약을 지키면서

*결제 시스템 시리즈. 개선기 — 데모 계정뿐이던 인증에 진짜 회원을 붙이기.*

### 0. 로그인은 되는데, "회원"이 없었다

[구독](/blog/project/pay/pay-ch10-features-audit)도 [월렛](/blog/project/pay/pay-ch10-features-audit)도 다 붙였는데, 정작 제일 밑바닥이 비어 있었어요. **실제로 가입한 회원이 없었다는 거요.**

지금까지 로그인은 `SecurityConfig`에 이렇게 박아둔 게 전부였어요.

```java
UserDetails user1 = User.withUsername("1").password(...).roles("USER").build();
UserDetails user2 = User.withUsername("2").password(...).roles("USER").build();
return new InMemoryUserDetailsManager(admin, admin2, user1, user2);
```

데모 유저 "1", "2"와 어드민 둘. 시연에는 충분했지만 "이메일로 가입해서 로그인하는" 진짜 회원은 만들 방법이 없었죠. 이번엔 그걸 붙였어요.

### 1. 겁나게 조심해야 했던 계약 하나

회원을 붙이는 것 자체는 흔한 일이에요. `Member` 엔티티, 저장소, BCrypt 해시, `POST /signup`. 문제는 이 시스템이 **처음부터 깔고 있던 계약** 하나였어요.

시스템 전체가 소유권을 이렇게 검증해요.

```java
long userId = Long.parseLong(principal.getName());
```

주문도, 결제도, 월렛도, 포인트도, 구독도 전부 이 한 줄로 "이 요청의 주인이 누구냐"를 얻어요. 즉 **`principal.getName()`은 반드시 숫자로 파싱돼야** 한다는 거예요. 데모 유저의 username이 왜 하필 `"1"`, `"2"`였는지 여기서 드러나요. username이 곧 userId였던 거죠.

그런데 회원은 이메일로 로그인하고 싶잖아요. `principal.getName()`이 `alice@example.com`이 되어버리면 `Long.parseLong`이 그 자리에서 터지고, **전 모듈의 소유권 검증이 한꺼번에 무너져요.** 이게 이번 작업의 핵심 제약이었어요.

### 2. 복합 UserDetailsService — 이메일로 찾되 숫자로 돌려준다

열쇠는 Spring Security의 동작 하나예요. `DaoAuthenticationProvider`는 인증에 성공하면 **내가 입력한 로그인 식별자가 아니라, 로드된 `UserDetails.getUsername()`을 principal 이름으로 삼아요.** 여기에 답이 있었어요.

로그인 식별자로 회원을 찾을 때, username을 **회원의 숫자 id로 바꿔서** 돌려주면 되는 거예요.

```java
return username -> {
    // (a) 데모 계정 우선 — admin/admin2/"1"/"2"는 인메모리 그대로
    try {
        return inMemory.loadUserByUsername(username);
    } catch (UsernameNotFoundException notDemo) {
        // (b) 실 회원 — 이메일로 조회하되, username은 숫자 id로 만든다
        Member member = memberRepository.findByEmail(username)
                .orElseThrow(() -> new UsernameNotFoundException("사용자를 찾을 수 없습니다: " + username));
        return User.withUsername(String.valueOf(member.getId()))
                .password(member.getPasswordHash())
                .roles(member.getRole())
                .build();
    }
};
```

`alice@example.com`으로 로그인해도, 인증이 끝나면 principal은 `"1000"`이에요. `auth.getName()`이 숫자를 돌려주니 JWT subject도 숫자로 실리고, 이후 `Long.parseLong(principal.getName())`이 그대로 살아요. **소유권 계약을 한 글자도 안 건드린 거죠.**

데모 계정을 먼저 보고 없으면 회원을 보는 순서도 의미가 있어요. `admin`·`"1"`·`"2"`는 인메모리에서 즉시 잡히고(무중단), 데모 계정이 아닐 때만 DB를 한 번 때려요.

### 3. 데모 유저 "1"과 회원 id가 부딪히면?

여기서 미묘한 함정이 하나 있었어요. 회원 id는 `IDENTITY`로 1부터 증가하는데, 인메모리 데모 유저의 principal도 `"1"`, `"2"`예요. 신규 회원이 id 1을 받으면 데모 유저 "1"과 **principal이 겹쳐요.** 소유권이 뒤섞이는 거죠.

그래서 회원 테이블의 시작 번호를 아예 떼어놨어요.

```sql
-- 신규 회원 id는 1000부터 — 인메모리 데모 유저 principal("1"/"2")과 충돌하지 않게
alter table members auto_increment = 1000;
```

첫 회원이 1000번을 받으니 데모 유저 1·2와 영영 안 부딪혀요. 작지만 안 넣었으면 시연 중에 조용히 데이터가 섞였을 자리예요.

스키마는 Flyway로만 만들어요(`ddl-auto: validate`). 그래서 `V14__members.sql`에 테이블·이메일 유니크 인덱스·AUTO_INCREMENT를 한 번에 담았어요.

### 4. 나머지는 관례대로

`member` 모듈은 다른 모듈과 똑같은 뼈대예요. `@ApplicationModule(allowedDependencies = { "shared" })`로 경계를 긋고, 엔티티는 정적 팩토리(`Member.of`)로만 만들고, 노출은 뷰 레코드(`MemberView` — `passwordHash`는 절대 안 실어요)로 해요. 가입 서비스는 이메일 중복이면 `EMAIL_ALREADY_EXISTS`, 비밀번호는 BCrypt로 해시해서만 저장하고요.

예외는 도메인 코드를 HTTP로 매핑하는 `GlobalExceptionHandler`에 두 줄 얹었어요. `EMAIL_ALREADY_EXISTS → 409`, `MEMBER_NOT_FOUND → 404`.

![회원 가입·로그인 데모](/uploads/project/pay/demo/demo-member.png)

### 5. 남은 것

이제 흐름이 이래요. `POST /api/v1/members/signup`으로 이메일 가입 → `POST /api/v1/auth/login`에 그 이메일을 그대로 태움 → 숫자 subject를 가진 JWT 발급 → 주문·결제·월렛이 그 숫자로 소유권을 검증. 데모 계정도 그대로 살아 있고요.

붙이고 나서 제일 마음에 든 건, **기존 계약을 한 줄도 안 고쳤다는 점**이에요. 소유권 검증하는 코드는 전 모듈에 흩어져 있는데, 그걸 다 놔두고 인증 입구에서 username만 숫자로 번역해준 거죠. 계약을 지키는 가장 싼 방법은, 계약이 보는 값을 계약이 기대하는 모양으로 만들어서 넘겨주는 거였어요.

<hr />

## 결제는 됐는데 그다음이 없었다 — 차지백/분쟁을 상태기계·멱등 웹훅·패소 역분개로

*결제 시스템 시리즈. 개선기 — 승인으로 끝난 줄 알았던 결제의 "그다음"을 채운 이야기.*

![분쟁/차지백 데모](/uploads/project/pay/demo/demo-dispute.png)

### 결제는 되는데, 지면 어쩔 건데

데모를 돌리다 문득 이상했다. 결제는 승인되고, 취소도 되고, 정산도 붙는데 — **차지백**이 오면 아무 일도 일어나지 않았다. 카드 결제에서 차지백은 예외가 아니라 일상이다. 고객이 "이거 내가 안 샀다"고 카드사에 이의를 걸면, 카드사는 일단 돈을 고객에게 돌려주고 가맹점에 통보한다. 가맹점은 정해진 기한 안에 "정상 거래였다"는 증빙을 제출해 다퉈야 하고, 지면 그 매출은 사라진다.

승인만 있고 이 사후 흐름이 없으면, 장부는 계속 "매출이 있다"고 우기는데 실제 돈은 빠져나간 상태가 된다. 결제 시스템의 정합성이 조용히 깨지는 지점이다. 그래서 `dispute` 모듈을 새로 만들었다.

### 분쟁은 상태기계다

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

### 웹훅은 두 번 온다 — 멱등키는 차지백 식별자

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

### 지면 되돌린다 — 패소 역분개

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

### 남는 이야기

증빙 제출 기한(`respondByDeadline`)은 수신 시점 + 7일로 잡아 두었지만, 실제로 기한을 넘겼을 때 자동으로 패소 처리하는 배치는 아직 없다. 지금은 어드민이 손으로 확정한다. 그리고 부분 차지백(원금 일부만 이의)이나 재분쟁(2차 차지백)은 이번 범위에서 뺐다 — 상태기계가 한 단계 더 깊어지는 주제라 따로 다룰 만하다.

그래도 "승인으로 끝난 줄 알았던 결제"에 그다음을 채웠다. 차지백이 오면 분쟁이 서고, 두 번 와도 하나만 서고, 지면 장부가 스스로 균형을 되찾는다. 결제 시스템이 조금 더 정직해졌다.

<hr />

## 방금 만든 기능을 스스로 감사했더니 — 자금 손실 버그가 나왔다

*결제 시스템 시리즈. 개선기 — 내 코드를 내가 감사하다.*

### 0. "만들었으니 됐다"가 제일 위험하다

[월렛](/blog/project/pay/pay-ch10-features-audit)·[회원](/blog/project/pay/pay-ch10-features-audit)·[분쟁](/blog/project/pay/pay-ch10-features-audit)을 붙이고 나니 그럴듯했어요. 테스트도 초록불이고요. 그런데 이 시리즈에서 배운 게 하나 있다면, **"동작한다 ≠ 맞다"**예요. 그래서 방금 추가한 세 모듈만 겨냥해 감사를 돌렸어요 — 돈이 새는 경로, 원장이 오염되는 경로, 인증이 뚫리는 경로를 각각.

결과가 뼈아팠어요.

> **자금 손실 2건, 원장 오염 3건, 인증 갭 3건.** 그것도 전부 제가 방금 "완성"했다고 생각한 코드에서요.

가장 아팠던 두 개를 중심으로 풀어볼게요. 신기하게도 근본 원인이 **하나로 수렴**했거든요.

### 1. 취소가 월렛을 몰랐다 (자금 손실 — 사용자 돈 증발)

주문 20,000원을 카드 14,000 + 월렛 6,000으로 결제하고, 전액취소를 눌렀어요. 결과:

```
전액취소 20,000 → CANCEL_AMOUNT_EXCEEDED (잔여 14,000)
카드몫 14,000만 취소 → 주문 CANCELED, fullyCanceled: true
그런데 월렛 잔액: 그대로. 6,000원 증발.
```

`CancelService`를 열어보니 환불 재원을 **포인트·카드만** 조회하고 있었어요. `walletService`는 의존성에도 없었죠. [월렛을 체크아웃 결제수단으로 배선](/blog/project/pay/pay-ch10-features-audit)할 때 *결제* 경로(reserve/settle)만 월렛을 알게 했고, **취소 경로는 월렛의 존재조차 몰랐던** 거예요. 심지어 전액 월렛 결제 주문은 취소 자체가 불가능했어요.

고치는 건 배분기를 3-way로 넓히는 거였어요 — 포인트 → 월렛 → 카드 순.

```java
long paidByPoint  = pointService.refundableAmount(orderNo);
long paidByWallet = walletService.refundableAmount(orderNo);  // ← 새로 추가
long paidByCard   = paymentService.cardBalance(orderNo);
RefundAllocation alloc = RefundAllocator.allocate(cancelAmount, paidByPoint, paidByWallet, paidByCard);
```

(내부 재원인 포인트·월렛을 카드보다 **먼저** 환불하는 건 [무상 포인트 현금화 어뷰징](/blog/project/pay/pay-ch10-features-audit)을 막기 위한 기존 원칙 그대로예요.)

### 2. 거절 → 재시도가 공짜 결제였다 (자금 손실 — 가맹점 몫)

더 무서운 건 이거였어요. 카드가 거절되면 사가는 예약한 월렛·포인트를 되돌리고 주문을 PENDING으로 복귀시켜요([설계상 재시도를 위해](/blog/project/pay/pay-ch9-audit-saga)). 그런데 같은 주문으로 재시도하면:

```
1차: 월렛 6,000 USE → 카드 거절 → 월렛 6,000 되돌림 → 주문 PENDING
2차(같은 주문): 월렛 USE 멱등이 "이미 USE 이력 있음"으로 skip → 실제 차감 0원
     → 카드 승인 → 주문 PAID
결과: 월렛 6,000은 아무도 안 낸 돈. 가맹점 손실.
```

멱등 판정이 **"이 주문을 USE한 적 있나"**였던 게 함정이었어요. 되돌린 예약을 여전히 "썼다"고 본 거죠.

#### 근본 원인: 새 수단을 기존 계약에 대칭시키지 않았다

여기서 깨달음이 왔어요. **포인트는 이 문제가 없었어요.** 왜냐면 포인트는 처음부터 두 개를 구분했거든요 —

- `RESTORE`: 사가 보상(승인 실패)의 예약 해제 — 주문 단위 **멱등**
- `REFUND`: 취소 환불 — 부분취소가 여러 번 오니 **비멱등**

그런데 제가 월렛을 만들 때는 `REFUND` 하나로 사가 보상도 하고 취소 환불도 했어요. 계약을 반만 베낀 거죠. 그래서 두 버그(#1의 부분취소 미반영, #2의 재시도 이중무료)가 **같은 뿌리**에서 나왔어요.

고침은 월렛을 포인트에 **대칭**시키는 것이었어요.

| 계약 | 포인트(원래) | 월렛(수정 후) |
|---|---|---|
| 예약 차감 | USE | USE |
| 사가 보상(멱등) | RESTORE | **RESTORE** (신설) |
| 취소 환불(비멱등) | REFUND | REFUND |
| USE 멱등 기준 | 활성예약 | **활성예약**(USE−RESTORE−REFUND) |

핵심은 USE 멱등을 **"활성 예약이 남아 있나(USE − RESTORE − REFUND {'>'} 0)"**로 바꾼 거예요. 거절로 예약이 RESTORE되면 순예약이 0이 되어 재시도가 **다시 차감**하고, 진짜 중복요청은 순예약이 남아 있어 skip해요. 두 경우가 정확히 갈려요.

> "이거 동시성 안전해?" — 안전해요. 같은 주문의 동시 차감은 상위 `Order.startPayment`의 낙관적 락(@Version)이 직렬화하거든요. 그래서 check-then-mutate가 원자적이지 않아도 이중반영이 안 나요. 이 근거가 있어서 (order_no, type) 유니크 인덱스도 뗄 수 있었어요 — 재시도로 USE가 2건, 부분취소로 REFUND가 여러 건 쌓여야 하니까요.

### 3. 원장을 지키는 세 가지 (분쟁)

분쟁 쪽은 원장 오염이 주제였어요.

- **0원 포이즌**: 웹훅 `amount`가 누락되면 Jackson이 조용히 0을 줘요. 0원 분쟁이 개시되고, 패소 확정 시 `LedgerEntry`의 "금액은 양수" 불변식을 깨 아웃박스 이벤트가 **영구 실패**해요(재시도 스케줄러도 없어서 재기동 전까지 방치). → 개시 시 `amount <= 0` 거부.
- **가짜 차지백**: 원 결제와 대조를 안 해, 존재하지 않는 orderNo나 원결제보다 큰 금액으로 분쟁을 만들 수 있었어요. 패소 확정 순간 **실존하지 않는 매출에 역분개**가 찍히죠. → 실존 승인결제 + 금액 ≤ 원결제 검증.
- **동시 확정 레이스**: `@Version`이 없어, 두 관리자가 같은 분쟁을 동시에 WON/LOST로 확정하면 최종 상태는 WON인데 이미 발행된 LOST 이벤트로 **승소 분쟁에 역분개**가 남을 수 있었어요. → `Dispute`에 `@Version`.

그리고 resolve의 기본값이 **"WON이 아니면 뭐든 LOST"**였던 것도 고쳤어요. 오타 하나가 비가역 역분개로 흐르면 안 되니까, WON/LOST 외에는 400으로 거부해요.

### 4. 내 방어 코드도 감사에 걸렸다

인증 쪽에서 login/signup에 rate limit이 없어(브루트포스·BCrypt DoS·가입 스팸) 추가했는데, **그 코드가 다시 자동 보안 리뷰에 걸렸어요.** 제가 클라이언트 IP를 `X-Forwarded-For` 헤더에서 읽었거든요 — 근데 그건 클라이언트가 위조·회전할 수 있어서 per-IP 한도를 우회할 수 있어요. 헤더 신뢰를 없애고 소켓 피어(`getRemoteAddr`)만 쓰도록 고쳤어요. **방어 코드를 짤 때도 신뢰 경계를 착각하면 그게 곧 구멍**이라는 걸 다시 배웠죠.

### 마치며

감사에서 나온 걸 세어보면 자금 손실 2, 원장 오염 3, 인증 갭 3. 전부 제가 "완성했다"고 생각한 코드에서 나왔어요. 그리고 자금 손실 두 개는 **같은 실수** — 새 결제수단을 기존의 검증된 계약에 대칭시키지 않은 것 — 에서 왔고요.

배운 건 뚜렷해요. **새 결제수단을 추가한다는 건 happy path를 잇는 게 아니라, 기존 수단이 가진 모든 계약(예약·보상·취소·멱등·복구)을 빠짐없이 대칭시키는 일**이라는 것. 하나라도 반만 베끼면 그 틈으로 돈이 새요. 그리고 "동작하니 됐다"는 결제 도메인에서 가장 비싼 착각이라는 것.

전부 회귀 테스트로 고정하고(507개 그린), 마이그레이션은 통합 테스트가 검증해요. 다음엔 이 대칭성을 애초에 강제하는 방법(공통 결제수단 추상)을 고민해볼 참이에요.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, 3-way 취소·활성예약 멱등·차지백 대조·원장 방어를 회귀 테스트로 고정했습니다.*

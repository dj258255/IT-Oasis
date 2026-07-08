---
title: '방금 만든 기능을 스스로 감사했더니 — 자금 손실 버그가 나왔다'
titleEn: 'I Audited the Feature I Just Built — and Found Money-Loss Bugs'
description: 결제 시스템 개선기. 월렛·회원·분쟁을 붙인 직후, 그 새 코드만 겨냥해 감사를 돌렸다. 결과는 자금 손실 2건(취소가 월렛을 몰라 증발, 거절→재시도 이중무료)·원장 오염 3건(0원 차지백 포이즌, 가짜 차지백, 동시 확정 레이스)·인증 갭 3건. 근본 원인은 하나로 수렴했다 — 새 결제수단(월렛)을 기존의 검증된 계약(포인트의 RESTORE/REFUND 분리)에 대칭시키지 않은 것. 대칭을 맞추자 버그가 함께 사라진 이야기.
descriptionEn: "Payment system improvement log. Right after adding wallet/member/dispute, I ran an audit aimed only at that new code. It surfaced two money-loss bugs (cancel didn't know about the wallet; reject-then-retry paid for free), three ledger-pollution bugs (zero-amount chargeback poison, forged chargebacks, concurrent-resolve race), and three auth gaps. The root cause converged on one thing: the new payment method (wallet) wasn't made symmetric with the proven existing contract (point's RESTORE/REFUND split). Making it symmetric made the bugs disappear together."
date: 2027-04-24T00:00:00.000Z
tags:
  - Payment
  - Audit
  - Idempotency
  - Ledger
  - Spring Boot
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 57
---

*결제 시스템 시리즈. 개선기 — 내 코드를 내가 감사하다.*

## 0. "만들었으니 됐다"가 제일 위험하다

[월렛](/blog/project/pay/pay-53-wallet-payment-method)·[회원](/blog/project/pay/pay-55-member-domain)·[분쟁](/blog/project/pay/pay-56-dispute-chargeback)을 붙이고 나니 그럴듯했어요. 테스트도 초록불이고요. 그런데 이 시리즈에서 배운 게 하나 있다면, **"동작한다 ≠ 맞다"**예요. 그래서 방금 추가한 세 모듈만 겨냥해 감사를 돌렸어요 — 돈이 새는 경로, 원장이 오염되는 경로, 인증이 뚫리는 경로를 각각.

결과가 뼈아팠어요.

> **자금 손실 2건, 원장 오염 3건, 인증 갭 3건.** 그것도 전부 제가 방금 "완성"했다고 생각한 코드에서요.

가장 아팠던 두 개를 중심으로 풀어볼게요. 신기하게도 근본 원인이 **하나로 수렴**했거든요.

## 1. 취소가 월렛을 몰랐다 (자금 손실 — 사용자 돈 증발)

주문 20,000원을 카드 14,000 + 월렛 6,000으로 결제하고, 전액취소를 눌렀어요. 결과:

```
전액취소 20,000 → CANCEL_AMOUNT_EXCEEDED (잔여 14,000)
카드몫 14,000만 취소 → 주문 CANCELED, fullyCanceled: true
그런데 월렛 잔액: 그대로. 6,000원 증발.
```

`CancelService`를 열어보니 환불 재원을 **포인트·카드만** 조회하고 있었어요. `walletService`는 의존성에도 없었죠. [월렛을 체크아웃 결제수단으로 배선](/blog/project/pay/pay-53-wallet-payment-method)할 때 *결제* 경로(reserve/settle)만 월렛을 알게 했고, **취소 경로는 월렛의 존재조차 몰랐던** 거예요. 심지어 전액 월렛 결제 주문은 취소 자체가 불가능했어요.

고치는 건 배분기를 3-way로 넓히는 거였어요 — 포인트 → 월렛 → 카드 순.

```java
long paidByPoint  = pointService.refundableAmount(orderNo);
long paidByWallet = walletService.refundableAmount(orderNo);  // ← 새로 추가
long paidByCard   = paymentService.cardBalance(orderNo);
RefundAllocation alloc = RefundAllocator.allocate(cancelAmount, paidByPoint, paidByWallet, paidByCard);
```

(내부 재원인 포인트·월렛을 카드보다 **먼저** 환불하는 건 [무상 포인트 현금화 어뷰징](/blog/project/pay/pay-53-wallet-payment-method)을 막기 위한 기존 원칙 그대로예요.)

## 2. 거절 → 재시도가 공짜 결제였다 (자금 손실 — 가맹점 몫)

더 무서운 건 이거였어요. 카드가 거절되면 사가는 예약한 월렛·포인트를 되돌리고 주문을 PENDING으로 복귀시켜요([설계상 재시도를 위해](/blog/project/pay/pay-51-checkout-saga)). 그런데 같은 주문으로 재시도하면:

```
1차: 월렛 6,000 USE → 카드 거절 → 월렛 6,000 되돌림 → 주문 PENDING
2차(같은 주문): 월렛 USE 멱등이 "이미 USE 이력 있음"으로 skip → 실제 차감 0원
     → 카드 승인 → 주문 PAID
결과: 월렛 6,000은 아무도 안 낸 돈. 가맹점 손실.
```

멱등 판정이 **"이 주문을 USE한 적 있나"**였던 게 함정이었어요. 되돌린 예약을 여전히 "썼다"고 본 거죠.

### 근본 원인: 새 수단을 기존 계약에 대칭시키지 않았다

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

## 3. 원장을 지키는 세 가지 (분쟁)

분쟁 쪽은 원장 오염이 주제였어요.

- **0원 포이즌**: 웹훅 `amount`가 누락되면 Jackson이 조용히 0을 줘요. 0원 분쟁이 개시되고, 패소 확정 시 `LedgerEntry`의 "금액은 양수" 불변식을 깨 아웃박스 이벤트가 **영구 실패**해요(재시도 스케줄러도 없어서 재기동 전까지 방치). → 개시 시 `amount <= 0` 거부.
- **가짜 차지백**: 원 결제와 대조를 안 해, 존재하지 않는 orderNo나 원결제보다 큰 금액으로 분쟁을 만들 수 있었어요. 패소 확정 순간 **실존하지 않는 매출에 역분개**가 찍히죠. → 실존 승인결제 + 금액 ≤ 원결제 검증.
- **동시 확정 레이스**: `@Version`이 없어, 두 관리자가 같은 분쟁을 동시에 WON/LOST로 확정하면 최종 상태는 WON인데 이미 발행된 LOST 이벤트로 **승소 분쟁에 역분개**가 남을 수 있었어요. → `Dispute`에 `@Version`.

그리고 resolve의 기본값이 **"WON이 아니면 뭐든 LOST"**였던 것도 고쳤어요. 오타 하나가 비가역 역분개로 흐르면 안 되니까, WON/LOST 외에는 400으로 거부해요.

## 4. 내 방어 코드도 감사에 걸렸다

인증 쪽에서 login/signup에 rate limit이 없어(브루트포스·BCrypt DoS·가입 스팸) 추가했는데, **그 코드가 다시 자동 보안 리뷰에 걸렸어요.** 제가 클라이언트 IP를 `X-Forwarded-For` 헤더에서 읽었거든요 — 근데 그건 클라이언트가 위조·회전할 수 있어서 per-IP 한도를 우회할 수 있어요. 헤더 신뢰를 없애고 소켓 피어(`getRemoteAddr`)만 쓰도록 고쳤어요. **방어 코드를 짤 때도 신뢰 경계를 착각하면 그게 곧 구멍**이라는 걸 다시 배웠죠.

## 마치며

감사에서 나온 걸 세어보면 자금 손실 2, 원장 오염 3, 인증 갭 3. 전부 제가 "완성했다"고 생각한 코드에서 나왔어요. 그리고 자금 손실 두 개는 **같은 실수** — 새 결제수단을 기존의 검증된 계약에 대칭시키지 않은 것 — 에서 왔고요.

배운 건 뚜렷해요. **새 결제수단을 추가한다는 건 happy path를 잇는 게 아니라, 기존 수단이 가진 모든 계약(예약·보상·취소·멱등·복구)을 빠짐없이 대칭시키는 일**이라는 것. 하나라도 반만 베끼면 그 틈으로 돈이 새요. 그리고 "동작하니 됐다"는 결제 도메인에서 가장 비싼 착각이라는 것.

전부 회귀 테스트로 고정하고(507개 그린), 마이그레이션은 통합 테스트가 검증해요. 다음엔 이 대칭성을 애초에 강제하는 방법(공통 결제수단 추상)을 고민해볼 참이에요.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, 3-way 취소·활성예약 멱등·차지백 대조·원장 방어를 회귀 테스트로 고정했습니다.*

---
title: '가상계좌에서 결제 완료를 최종 상태로 믿으면 안 되는 이유'
description: '토스 문서에 따르면 가상계좌는 입금 기한이 지나도 웹훅이 오지 않고 일부 은행은 입금 완료를 보낸 뒤 최대 2분 뒤에 되돌립니다. BE-commerce는 그 두 자리를 상태머신과 만료 배치로 막았지만 입금 웹훅을 그 상태머신에 잇는 연결은 아직 없습니다. 만든 것과 이어지지 않은 것을 코드 기준으로 나눴습니다.'
date: 2026-09-20
category: study/be-commerce
coverImage: /uploads/covers/project/be-commerce/be-commerce-ch19-virtual-account-reversal.svg
draft: false
series: "BE-commerce"
seriesOrder: 19
tags:
  - Payment
  - 가상계좌
  - 웹훅
  - 상태머신
  - 결제 시스템
---

[결제 실패 설계 글](/blog/project/be-commerce/be-commerce-ch2-failure-design)에서 카드 결제의 미확정(`UNKNOWN`)을 다뤘습니다. 가상계좌는 방향이 반대입니다. 카드는 승인과 응답이 한 호출 안에서 끝나지만 가상계좌는 계좌를 먼저 발급하고 입금을 기다립니다.

```
발급 ──▶ WAITING_FOR_DEPOSIT ──▶ DONE
```

입금이 언제 들어올지 모르니 완료를 알려 주는 통로는 웹훅입니다. 그런데 웹훅만 믿고 상태를 확정하면 두 자리에서 어긋납니다. 둘 다 토스페이먼츠 문서에 적혀 있습니다.

## 결론부터

- 입금 기한이 지나도 웹훅이 오지 않을 수 있으므로 `WAITING_FOR_DEPOSIT`을 자체 만료 배치가 확인합니다.
- 일부 은행에서는 `DONE` 뒤에 다시 `WAITING_FOR_DEPOSIT`이 올 수 있어 완료를 영구 상태로 취급하지 않습니다.
- 구현한 것은 상태머신과 만료 배치까지이며, 실제 입금 웹훅을 상태머신에 연결하는 운영 경로는 아직 남아 있습니다.

가상계좌의 핵심은 “입금 완료 이벤트를 받았는가”가 아니라 **현재 상태를 번복할 수 있는가와 웹훅이 오지 않는 경우를 누가 확인하는가**입니다.

## 함정 1: 입금 기한이 지나도 웹훅이 오지 않습니다

토스페이먼츠의 [가상계좌 웹훅 안내](https://docs.tosspayments.com/blog/virtual-account-webhook)(2023)는 입금 기한 만료를 이렇게 설명합니다.

> 구매자가 가상계좌에 입금을 완료하지 않아 입금 기한이 만료되어 `WAITING_FOR_DEPOSIT` 상태가 유지되는 경우입니다. 웹훅이 전송되지 않습니다.

토스 쪽 상태는 `WAITING_FOR_DEPOSIT` 그대로 남고 알림도 없습니다. 웹훅만 기다리면 만료된 주문이 영원히 입금 대기로 남아 재고와 쿠폰을 붙잡습니다.

그래서 BE-commerce는 만료를 우리 쪽 상태 `EXPIRED`로 따로 두고 자체 만료 배치가 채우게 했습니다. 입금 기한(`dueDate`)이 지난 `WAITING_FOR_DEPOSIT`을 찾되 만료시키기 전에 PG에 한 번 묻습니다. 기한 직전에 들어온 입금이면 완료로 돌립니다.

```java
if (pgClient.query(va.getPaymentKey()).isApproved()) va.confirmDeposit(); // 늦게 들어온 입금은 완료
else va.expire();
```

조회가 승인이면 만료 대신 `DONE`으로 가는 경우는 테스트(`expireOverdueRaceResolvesToDone`)로 고정했습니다. 웹훅이 오지 않는 경로를 배치가 대신 확인한다는 점에서 카드 결제의 `UNKNOWN` 복구와 같은 원칙입니다.

## 함정 2: 완료가 되돌아옵니다

토스페이먼츠 [가상계좌 용어 설명](https://docs.tosspayments.com/resources/glossary/virtual-account)에는 이런 문장이 있습니다.

> 일부 은행(특히 신한)에서는 실제 입금이 되지 않았는데 입금 통보(DONE)가 먼저 오고, 이후 1~2초에서 최대 2분 이상 후에 취소 통보(WAITING_FOR_DEPOSIT)가 오는 경우가 있어요.

토스는 이 문제를 걱정하는 상점에 "2분 지연통보"를 권합니다. 입금 뒤 2분 동안 취소 통보가 없을 때만 상점에 입금을 알려 주는 기능입니다. PG 쪽에서 기다려 주는 방법입니다.

보통 상태머신은 완료를 최종 상태로 봅니다. 가상계좌에서는 그 가정이 깨집니다. `DONE`이 왔다고 재고를 확정하고 쿠폰을 쓰게 하면 되돌아온 뒤에 그 처리를 다시 걷어내야 합니다.

BE-commerce는 우리 쪽 상태머신에 `DONE → WAITING_FOR_DEPOSIT`과 `DONE → CANCELED`를 허용 전이로 넣었습니다(`VaStatus`). 지연통보에 기대지 않고 되돌림을 받을 자리를 만든 것입니다. 전이는 `handleDepositReversal`이 맡고 테스트로 확인했습니다.

## 만든 것과 이어지지 않은 것

코드를 다시 대조해 보니 상태머신과 배치는 있지만 운영 경로에 이어지지 않은 부분이 있었습니다.

| 부분 | 지금 상태 |
|---|---|
| 허용 전이(`DONE`에서 되돌림 포함) | 있음, 단위 테스트 |
| 만료 전 PG 재조회 | 있음, 단위 테스트 |
| 만료 배치 스케줄러 | 있음. `app.va.expiry.enabled` 기본값이 `false`라서 켜야 돎 |
| 입금 웹훅(`DEPOSIT_CALLBACK`) 수신 | 원본 저장과 멱등 키까지 있음 |
| 입금 웹훅에서 가상계좌 상태 전이로 연결 | **없음.** 토스 입금 콜백에는 `paymentKey`가 없어서 웹훅 처리기가 "조회 대상 아님"으로 건너뜀. `confirmDeposit`과 `handleDepositReversal`은 테스트에서만 불림 |
| 되돌림 뒤 알림·포인트 보상 | **없음.** `handleDepositReversal` 주석에 "호출측 책임"으로 적혀 있고 호출하는 쪽이 없음 |

그래서 이 글에서 막았다고 말할 수 있는 것은 상태머신이 되돌림을 받아들이고 만료 전에 한 번 더 묻는다는 규칙까지입니다. 실제 토스 입금 콜백이 들어와 이 규칙을 타는 경로는 아직 없습니다. 다음 작업은 입금 콜백의 `transactionKey`로 가상계좌를 찾아 `confirmDeposit`과 `handleDepositReversal`에 잇고 그 뒤 보상을 붙이는 일입니다.

## 상태 전이가 사라지던 버그

가상계좌 서비스는 한때 상태를 바꾸고도 DB에 남기지 못했습니다. 엔티티를 불러와 상태만 바꾸고 명시적으로 저장하지 않아 변경이 반영되지 않는 문제였습니다. 2025년 12월 13일 커밋에서 가상계좌와 구독 서비스의 상태 전이를 `saveAndFlush`로 바꿨습니다. 입금 완료와 만료, 되돌림 세 자리가 모두 여기에 해당합니다. 이틀 뒤에 만든 에스크로 모듈은 처음부터 같은 방식으로 저장합니다.

## 참고

- [토스페이먼츠 - 가상계좌 연동할 때 웹훅이 꼭 필요한 이유](https://docs.tosspayments.com/blog/virtual-account-webhook)
- [토스페이먼츠 - 가상계좌 용어 설명](https://docs.tosspayments.com/resources/glossary/virtual-account)
- [Stripe - Best practices for using webhooks](https://docs.stripe.com/webhooks#best-practices)

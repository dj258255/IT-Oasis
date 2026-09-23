---
title: '가상계좌에서 결제 완료를 최종 상태로 믿으면 안 되는 이유'
description: '가상계좌는 입금이 나중에 오는 결제라 완료가 최종 상태가 아니다. 만료는 웹훅으로 오지 않고 일부 은행은 입금 실패인데 완료를 먼저 보냈다가 되돌린다. 만료 배치와 역전이 허용 전이로 그 두 자리를 정리한 기록이다.'
date: 2026-09-20
category: study/be-commerce
coverImage: /uploads/covers/project/be-commerce/be-commerce-ch19-virtual-account-reversal.svg
draft: false
unlisted: true
series: "결제 시스템 만들기"
seriesOrder: 19
tags:
  - Payment
  - 가상계좌
  - 웹훅
  - 상태머신
  - 결제 시스템
---

[2편](/blog/project/be-commerce/be-commerce-ch2-failure-design)에서 카드 결제의 미확정(`UNKNOWN`)을 다뤘다. 가상계좌는 방향이 반대다. 승인과 응답이 한 호출 안에서 끝나는 카드와 달리 계좌를 먼저 발급하고 입금을 기다린다.

```
발급 ──▶ WAITING_FOR_DEPOSIT ──▶ DONE
```

입금이 언제 들어올지 모르니 결제 완료를 알리는 통로가 웹훅뿐이다. 그런데 웹훅 하나만 믿고 상태를 확정하면 두 자리에서 어긋난다.

## 함정 1: 만료는 웹훅으로 오지 않는다

> **EXPIRED 상태로 바뀔 때는 웹훅이 전송되지 않습니다.** (토스페이먼츠 문서에 명시돼 있습니다.)

이걸 모르고 웹훅만 기다리면 만료 건이 영원히 "입금대기"로 남아 재고나 쿠폰을 물고 있다. 그 자리를 **자체 만료 배치**가 채운다. `dueDate`가 지난 `WAITING_FOR_DEPOSIT`을 스캔하되, 만료시키기 전에 PG에 한 번 물어본다. 늦게 도착한 입금이면 완료로 돌린다.

```java
if (pgClient.query(va.getPaymentKey()).isApproved()) va.confirmDeposit(); // 늦은 입금 → 완료
else va.expire();
```

웹훅을 받아도 조회로 다시 확인하고 웹훅이 오지 않는 경로는 배치가 대신 확인한다. [2편의 `UNKNOWN` 복구](/blog/project/be-commerce/be-commerce-ch2-failure-design)와 같은 원칙을 방향만 바꿔 적용한 셈이다.

## 함정 2: 완료가 되돌아온다

> 일부 은행(신한 등)은 **입금 실패인데 DONE을 먼저 보낸 뒤, 최대 2분 후 되돌리는** 통보를 합니다.

보통 상태머신은 완료를 최종으로 가정한다. 가상계좌는 그 가정이 깨진다. `DONE`이 왔다는 이유로 재고를 확정하고 쿠폰을 태우면, 되돌아온 뒤에 그 후속 처리를 다시 걷어내야 한다.

그래서 `DONE → WAITING_FOR_DEPOSIT`과 `DONE → CANCELED` **역전이를 허용 전이로** 넣었다. 역전이가 오면 이미 보낸 후속 처리(알림·포인트 적립)를 보상으로 되돌린다. 되돌리는 방법은 [2편의 보상 태스크](/blog/project/be-commerce/be-commerce-ch2-failure-design)와 같다.

## 완료를 처리하는 경로에도 같은 버그가 있었다

가상계좌의 상태를 바꾸는 자리는 [실기동 편](/blog/project/be-commerce/be-commerce-ch2-runtime-truths)에서 찾은 버그에 그대로 걸려 있었다. 엔티티를 불러와 `save()`만 부르면 트랜잭션이 flush되지 않아 상태 변경이 사라지는 문제가 있었고, 그 모양이 `confirm`·취소·복구 배치·에스크로·가상계좌·구독에 모두 있었다.

`DONE`을 받아 입금 완료로 넘기는 경로도 그중 하나였다. 완료 처리가 조용히 사라지면 웹훅은 왔는데 상태는 그대로인 결제가 남는다.

## 남은 것

프로젝트 전체의 남은 구멍은 [2편](/blog/project/be-commerce/be-commerce-ch2-failure-design)에 모아 뒀다. 이 글의 만료·역전이 경로도 실제 토스 대신 상태 기반 `FakePgClient`로 검증한 상태다.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/BE-commerce)에 있습니다.*

## 참고

- 가상계좌 발급과 상태 전이: [토스페이먼츠 Virtual Account API](https://docs.tosspayments.com/reference#가상계좌-발급-요청)
- 웹훅 수신 측 멱등성 설계: [Stripe: Best practices for using webhooks](https://docs.stripe.com/webhooks#best-practices)

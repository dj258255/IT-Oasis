---
title: '한 사람이 남의 돈을 취소하게 두지 않는다 — 강제취소의 2인 승인(maker-checker)'
titleEn: "Nobody Cancels Someone Else's Money Alone — Two-Person Approval for Force-Cancel"
description: 결제 시스템 개선기. 운영이 결제를 강제취소해야 할 때가 있는데, 한 사람이 단독으로 남의 돈을 취소하게 두면 위험하다. 금융 백오피스의 표준인 maker-checker(요청자와 승인자를 반드시 다른 사람으로)를 붙였다. 요청자≠승인자를 어디서 강제해야 우회가 불가능한지, 그리고 승인=실행이 기존 취소 경로를 어떻게 재사용하는지에 대한 기록.
descriptionEn: "Payment system improvement log. Ops sometimes must force-cancel a payment, but letting one person unilaterally cancel someone else's money is dangerous. I added maker-checker — the back-office standard where requester and approver must be different people. A record of where to enforce requester≠approver so it can't be bypassed, and how approve=execute reuses the existing cancel path."
date: 2026-10-17T00:00:00.000Z
tags:
  - Payment
  - Operations
  - Maker-Checker
  - Security
  - Audit
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 30
---

*결제 시스템 시리즈. 개선기 — 강제취소에 2인 승인을 채우기.*

## 0. 강제취소는 필요하지만, 무섭다

운영을 하다 보면 결제를 **강제로 취소**해야 할 때가 있어요. 분쟁 조정, 명백한 오류 정정, 사기 확인 후 환불 같은. 그래서 어드민에 강제취소 기능이 필요해요.

그런데 이건 무서운 권한이에요.

> **한 사람이 단독으로 아무 결제나 취소할 수 있다**는 건, 그 사람의 실수나 악의가 곧바로 남의 돈에 영향을 준다는 뜻이에요. 내부자 부정, 오조작, 계정 탈취 — 어느 하나만 뚫려도 피해가 즉시 발생해요. 금융에서 이건 용납 안 돼요.

그래서 금융 백오피스엔 표준 패턴이 있어요 — **maker-checker(4-eyes)**. 요청하는 사람(maker)과 승인하는 사람(checker)을 **반드시 다른 사람**으로 강제하는 거예요. 두 사람의 눈을 거쳐야 실행되니, 한 명이 뚫려도 단독으론 아무것도 못 해요.

## 1. 흐름: 요청 → (다른 사람) 승인 → 실행

강제취소를 2단계로 나눴어요.

```
POST /admin/payments/{id}/force-cancel        → 요청 생성 (REQUESTED, requestedBy=요청자)
POST /admin/force-cancels/{reqId}/approve     → 다른 어드민이 승인 = 실행 (EXECUTED)
POST /admin/force-cancels/{reqId}/reject      → 거부 (REJECTED)
GET  /admin/force-cancels?status=REQUESTED    → 승인 대기 큐
```

요청은 `force_cancel_requests` 테이블에 남아요(누가 요청했는지, 얼마를, 왜). 그리고 **다른** 어드민이 승인 큐에서 그 요청을 승인하면, 그때 실제 취소가 실행돼요.

## 2. 핵심 질문: 요청자≠승인자를 어디서 강제하나

이게 이번 구현의 진짜 포인트였어요. "요청자와 승인자가 달라야 한다"를 **어느 계층에서** 검사하느냐.

컨트롤러에서? 서비스에서? 둘 다 우회 가능성이 있어요. 그래서 **도메인 엔티티 안**에 넣었어요.

```java
public void approve(String approver) {
    if (this.status != ForceCancelStatus.REQUESTED) {
        throw ... // 이미 처리된 요청
    }
    if (approver.equals(this.requestedBy)) {
        throw new PaymentException("MAKER_CHECKER_VIOLATION",
                "요청자는 자신의 강제취소를 승인할 수 없습니다.");
    }
    this.status = ForceCancelStatus.EXECUTED;
    this.approvedBy = approver;
}
```

> 규칙을 **엔티티의 상태 전이 메서드**에 박으면, 어느 서비스·어느 컨트롤러가 부르든 **우회가 불가능**해요. 나중에 다른 경로에서 approve를 호출해도 이 가드를 반드시 통과해야 하니까요. "비즈니스 규칙은 엔티티가 지킨다"는 원칙([상태머신 가드](/blog/project/pay/pay-2-designing-for-failure)와 같은 결)을 maker-checker에도 적용한 거예요.

그리고 서비스는 이 가드를 **통과한 뒤에만** 실제 취소를 실행해요. 그래서 요청자가 자기 요청을 승인하려 하면, 취소 로직은 아예 호출되지 않아요(테스트에서 `never()`로 검증).

실기동으로 확인했어요.

```
1) admin이 강제취소 요청       → REQUESTED (requestedBy=admin)
2) admin 본인이 승인 시도       → 403 MAKER_CHECKER_VIOLATION   ← 자기 요청 승인 차단
3) admin2가 승인               → 200 EXECUTED (approvedBy=admin2)
4) 결제 실제 상태              → CANCELED, balance 0            ← 진짜로 취소됨
```

(2인 흐름을 시연하려면 어드민이 둘 필요해서, `admin2`를 하나 추가했어요. 어드민이 하나뿐이면 모든 승인이 자기 승인이 되어 항상 막히거든요.)

## 3. 승인 = 실행, 그런데 기존 걸 재사용

승인이 통과하면 실제 취소를 해야 해요. 여기서 새 취소 로직을 또 짜지 않았어요. [이미 있는 `PaymentService.cancel`](/blog/project/pay/pay-18-order-cancel)을 그대로 불렀어요.

```java
public ForceCancelView approve(long requestId, String approver) {
    ForceCancelRequest req = load(requestId);
    req.approve(approver);   // maker-checker 가드 (여기 통과해야 아래로)
    paymentService.cancel(req.getPaymentId(), Money.of(req.getCancelAmount()), req.getReason());
    repository.saveAndFlush(req);
    ...
}
```

`paymentService.cancel`은 결제 취소 + PG 망취소 + [현금영수증 연쇄취소·원장 역분개 이벤트](/blog/project/pay/pay-18-order-cancel)까지 이어주는 경로예요. 강제취소도 이 경로를 타니, 일반 취소와 **똑같이 정합성이 유지**돼요. 그리고 이 전체가 한 트랜잭션이라, PG 취소가 실패하면 롤백되고 요청은 `REQUESTED`로 남아 재시도할 수 있어요.

여기에도 [최근 배운 saveAndFlush](/blog/project/pay/pay-26-persistence-bug)를 잊지 않고 적용했어요. 요청 상태를 EXECUTED로 바꾼 게 실제 DB에 남도록요.

## 4. 누가·언제·무엇을

강제취소는 민감하니 **모든 요청과 승인을 감사 로그**로 남겨요. 요청자, 승인자, 대상 결제, 금액, 시각. `force_cancel_requests` 테이블 자체가 "누가 요청하고 누가 승인했나"(requestedBy/approvedBy)를 들고 있고, 상태 변경 액션은 [감사 로거](/blog/project/pay/pay-23-ops-admin)에도 찍혀요.

이게 중요한 이유는 — maker-checker의 목적이 "사고를 막는 것"만이 아니라 **"사고가 나도 추적 가능하게"**이기 때문이에요. 나중에 "이 취소는 누가 왜 했나"를 반드시 답할 수 있어야 하죠.

## 마치며

이번 건 기능 자체는 단순해요(요청·승인 두 엔드포인트). 하지만 **"위험한 권한을 어떻게 안전하게 주느냐"**라는, 금융 시스템의 본질적인 질문을 다뤘어요.

핵심은 두 가지였어요 — 요청자≠승인자 규칙을 **엔티티에 박아** 우회를 원천 차단한 것, 그리고 승인이 통과하면 **기존 취소 경로를 재사용**해 정합성을 공짜로 얻은 것. 새 권한을 열되, 그 권한이 함부로 쓰일 수 없게 만드는 게 이번 개선이었어요.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, 본인승인 차단→2인 승인→실제 취소를 실 MySQL로 검증했습니다.*

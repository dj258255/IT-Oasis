---
title: '"나중에 확인하세요"라고 해놓고 확인할 곳이 없었다 — 폴링 계약을 완성한 조회 API'
titleEn: 'It Said "Check Later" but Gave Nowhere to Check — The Query API That Completed the Polling Contract'
description: 결제 시스템 개선기. 회고까지 쓰고 나서 API 스펙 문서를 다시 훑어봤더니, 승인 타임아웃이 202 UNKNOWN을 주며 "클라이언트는 폴링으로 확정을 확인하라"고 해놓고 정작 폴링할 조회 API가 없었다. 이 시스템의 간판인 UNKNOWN 3-상태 모델이 확인 경로 없이 반쪽이었던 것. 소유권을 지키며 조회 API를 붙여 계약을 완성한 이야기.
descriptionEn: "Payment system improvement log. After even writing the retrospective, I re-read the API spec and found the approval-timeout path returning 202 UNKNOWN and telling clients to 'poll to confirm' — with no query API to poll. The system's flagship UNKNOWN three-state model was half-finished, promising a check with no place to check. A story of completing that contract with an ownership-guarded query API."
date: 2026-10-03T00:00:00.000Z
tags:
  - Payment
  - REST API
  - Spring Modulith
  - Idempotency
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 28
---

*결제 시스템 시리즈. 개선기 — 회고 뒤에도 남아 있던 반쪽 계약.*

## 0. 끝인 줄 알았는데

[회고편](/blog/project/pay/pay-27-retrospective)까지 쓰고 "이제 됐다" 싶었어요. 그런데 마지막으로 API 스펙 문서(`docs/10`)를 다시 훑어보다가, 이상한 걸 발견했어요.

스펙엔 이런 엔드포인트가 **적혀 있었어요.**

```
GET /api/v1/orders/{orderNo}      — 주문 조회 (결제 상태 포함)
GET /api/v1/payments/{paymentId}  — 결제 조회
```

그런데 코드엔 **하나도 없었어요.** 전체 엔드포인트를 grep해보니 주문·결제에 GET 매핑이 0개. 생성(POST)·승인·취소만 있었죠. "조회쯤이야 나중에" 하고 미뤄뒀던 게, 회고를 쓸 때까지 그대로 빠져 있던 거예요.

문제는 이게 단순히 "편의 기능 누락"이 아니었다는 거예요.

## 1. 이 시스템의 간판이 반쪽이었다

이 프로젝트에서 제일 강조한 설계가 [UNKNOWN 3-상태 모델](/blog/project/pay/pay-2-designing-for-failure)이에요. PG 승인이 타임아웃되면 실패로 단정하지 않고 `UNKNOWN`으로 보존하고 —

```json
// 승인 타임아웃 시 응답
202 Accepted
{ "orderStatus": "PAYMENT_IN_PROGRESS", "paymentStatus": "UNKNOWN",
  "message": "결제 결과를 확인하고 있습니다. 잠시 후 다시 확인해 주세요." }
```

"잠시 후 다시 확인해 주세요"라고 답해요. [복구 배치](/blog/project/pay/pay-23-ops-admin)가 PG 조회로 확정하면, 클라이언트는 **폴링으로 그 확정 결과를 확인**하는 게 계약이에요.

그런데 — **폴링할 조회 API가 없었어요.** "나중에 확인하세요"라고 해놓고 확인할 곳을 안 준 거죠. 간판이던 UNKNOWN 모델이, 정작 사용자가 결말을 볼 방법 없이 **반쪽으로 서 있던** 거예요.

이건 없던 기능을 새로 만드는 게 아니라, **이미 한 약속을 지키는** 일이었어요. 그래서 우선순위가 제일 높았어요.

## 2. 조회에도 소유권은 지킨다

조회 API를 만들 때 제일 신경 쓴 건 **소유권**이에요. 남의 주문·결제를 조회로 훔쳐보면 안 되니까요([IDOR](/blog/project/pay/pay-10-composite-payment)는 조회에도 똑같이 적용돼요).

여기서 모듈 경계 문제가 하나 있었어요. `GET /payments/{paymentId}`는 결제 조회인데, **결제의 소유권 검증은 결제 모듈이 못 해요** — userId ↔ 주문 매핑은 order 모듈이 소유하거든요. payment는 사용자가 누군지 몰라요.

그래서 이렇게 나눴어요.

> **두 조회 모두 order 모듈에서 소유권을 검증**해요. `GET /payments/{paymentId}`는 payment 모듈의 `orderNoOf(paymentId)`(결제→주문번호만 반환)를 부른 뒤, order가 그 주문을 로드해 `verifyOwner`로 확인하고, **통과한 뒤에야** 결제 상세를 조회해요. payment는 "이 결제가 누구 것인지" 몰라도 되고, **남의 결제는 존재 여부조차 안 드러나요**(소유권 실패 시 상세 조회 자체를 안 하니까).

이건 [POST /payments/confirm이 order 모듈의 컨트롤러에 있는 것](/blog/project/pay/pay-21-ci-guards-boundaries)과 같은 결이에요 — 결제 관련이라도 **사용자·소유권이 얽히면 order가 관문**을 맡는 거죠. 경계를 지키면서 IDOR도 막았어요.

## 3. 무엇을 대표 상태로 보여줄까

작은 판단이 하나 있었어요. 한 주문에 결제 시도가 **여러 번** 있을 수 있어요(첫 시도 UNKNOWN, 재시도 등). `GET /orders/{orderNo}`가 결제 상태를 함께 보여줄 때, **어느 결제를 대표로** 보여줘야 할까요?

**최신 시도(`requestedAt` 내림차순)를 대표로** 택했어요. 이래야 "UNKNOWN이던 최신 시도가 복구 배치로 DONE이 됐다"는 진행을 **주문 단위 폴링으로 관측**할 수 있거든요. 성공 건만 보여주면 UNKNOWN→DONE으로 바뀌는 과정을 못 보죠. 이 판단을 메서드 주석과 스펙에 명시했어요.

이제 흐름이 이렇게 닫혀요.

```
승인 요청 → (타임아웃) → 202 UNKNOWN
   ↓  클라이언트 폴링
GET /orders/{orderNo}  →  paymentStatus: "UNKNOWN"   (아직)
   ↓  (복구 배치가 PG 조회로 확정)
GET /orders/{orderNo}  →  paymentStatus: "DONE"      (확정!)
```

응답으로 노출하는 건 전부 **뷰 record**예요 — 엔티티(`Payment`·`PaymentHistory`는 package-private)를 모듈 밖으로 내보내지 않고, 조회에 필요한 필드만 담은 불변 record로요. 결제 상세엔 상태·잔액·상태 전이 이력·취소 투영을 담았어요.

## 마치며

이번 건 화려하지 않아요. GET 두 개니까요. 하지만 **"이미 한 약속을 지킨다"**는 점에서 꽤 중요했어요.

회고까지 써놓고도 스펙을 다시 보니 계약이 반쪽이었다는 것 — 이게 오히려 솔직한 교훈 같아요. **"다 만들었다"는 감각과 "스펙대로 다 됐다"는 사실은 다르다.** 문서에 적어둔 계약을 코드가 실제로 지키는지, 끝났다고 생각한 뒤에도 한 번 더 대조해봐야 한다는 걸 배웠어요.

끝인 줄 알았는데, 스펙이 아직 안 끝났다고 말해줬어요.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, 조회는 소유권 검증 후 뷰 record로만 응답합니다.*

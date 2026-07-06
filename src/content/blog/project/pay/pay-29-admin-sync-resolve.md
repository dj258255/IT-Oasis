---
title: '배치가 도착하기 전에 지금 확정해야 할 때 — 단건 동기화와 수기 대사 확정'
titleEn: 'When It Has to Be Settled Now, Not on the Next Batch — Single-Payment Sync and Manual Reconciliation'
description: 결제 시스템 개선기. 웹훅이 누락되면 결제가 미확정으로 방치될 수 있는데, 전체 복구 배치를 기다리는 것 말곤 방법이 없었다. 그리고 대사가 남긴 불일치는 조회만 될 뿐 "사람이 확인 후 확정"할 경로가 없었다. 운영이 특정 건을 지금 손보게 하는 두 어드민 — 단건 PG 강제 동기화와 수기 대사 확정을 붙인 이야기.
descriptionEn: "Payment system improvement log. A missed webhook can leave a payment unconfirmed, with no option but to wait for the full recovery batch. And reconciliation mismatches could only be viewed, never marked handled by a human. A story of two admin actions that let ops fix a specific case now: single-payment PG force-sync and manual reconciliation resolution."
date: 2026-10-10T00:00:00.000Z
tags:
  - Payment
  - Operations
  - Admin
  - Reconciliation
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 29
---

*결제 시스템 시리즈. 개선기 — 운영이 "지금 이 건"을 손보게 하기.*

## 0. 전체 배치는 있는데, 이 한 건은?

[어드민 편](/blog/project/pay/pay-23-ops-admin)에서 운영 개입 손잡이를 여럿 만들었어요. 그런데 실제 운영 시나리오를 더 그려보니 두 개가 빠져 있었어요. 둘 다 **"특정 한 건을 지금 처리"**하는 경로였어요.

## 1. 단건 PG 강제 동기화 — 배치를 기다릴 수 없을 때

결제 [웹훅](/blog/project/pay/pay-3-webhooks-and-outbox)이 누락되는 일은 실제로 있어요(PG쪽 발송 실패, 네트워크 유실). 그럼 우리 DB엔 결제가 `IN_PROGRESS`나 `UNKNOWN`으로 남고, PG엔 승인이 돼 있는 **불일치**가 생기죠.

[복구 배치](/blog/project/pay/pay-23-ops-admin)가 주기적으로 이런 미확정 건을 PG 조회로 확정해요. 그런데 —

> 고객이 "결제했는데 처리가 안 됐어요" 문의를 지금 넣었어요. 운영자는 **다음 배치 주기를 기다릴 수 없어요.** "그 건 하나만 지금 PG에 물어봐서 확정"하고 싶은데, 전체 스캔 배치(`/admin/payments/recover`)밖에 없었어요.

그래서 단건 동기화를 열었어요.

```
POST /api/v1/admin/payments/{id}/sync
→ { "paymentId": 1, "orderNo": "...", "status": "DONE",
    "message": "PG 조회로 상태를 동기화했습니다" }
```

여기서 좋았던 건, **새 로직을 거의 안 짰다**는 거예요. 이미 [웹훅이 "페이로드를 믿지 말고 조회로 재검증"](/blog/project/pay/pay-3-webhooks-and-outbox)할 때 쓰던 `resolveByPaymentKey(paymentKey)`가 있었거든요 — PG를 조회해서 승인돼 있으면 DONE, 없으면 ABORTED, 취소됐으면 CANCELED로 확정하는. sync는 결제 id로 paymentKey를 찾아 **그걸 그대로 재사용**하고, 확정 뒤 상태를 다시 읽어 응답만 해요.

> 이미 확정된(DONE 등) 건을 sync해도 안전해요. `resolveByPaymentKey`가 UNKNOWN/IN_PROGRESS일 때만 조회하고 나머지는 **멱등 no-op**이거든요. 운영자가 "혹시 몰라" 눌러도 이중 처리가 없어요.

배치(전체 스캔)와 단건 sync가 **같은 확정 로직을 공유**하는 게 핵심이에요. 정기적 자동 확정과 즉시 수동 확정이 서로 다르게 동작하면, 그게 바로 버그의 씨앗이니까요.

## 2. 수기 대사 확정 — 조회만으론 부족하다

두 번째는 [대사(reconciliation)](/blog/project/pay/pay-4-ledger-settlement-reconciliation)예요. 내부 기록과 PG 파일을 맞춰보고, 안 맞으면 4분류(내부만/외부만/금액불일치) 중 하나로 `PENDING`(사람 확인 필요)을 남겨요. 어드민에서 이 예외 큐를 **조회**는 할 수 있었죠.

그런데 조회만 되고 **"확인했다"고 표시할 방법이 없었어요.** 운영자가 불일치를 조사해서 "이건 타이밍 차이였고 실제론 정상"이라고 결론 내려도, 그 건은 영원히 `PENDING`으로 남아요. 다음에 봐도 "아직 안 본 건"인지 "봤는데 처리한 건"인지 구분이 안 되죠.

그래서 수기 확정을 붙였어요.

```
POST /api/v1/admin/reconciliations/{id}/resolve   → PENDING → MANUALLY_RESOLVED
```

`ReconStatus`에 `MANUALLY_RESOLVED`를 추가하고, `PENDING`에서만 이 전이가 되게 가드를 뒀어요(이미 확정된 걸 또 확정 못 하게). 여기서 두 가지 판단이 있었어요.

**(1) 누가·왜 확정했는지는 어디에 남기나.** 엔티티에 `resolvedBy`, `note` 컬럼을 추가할 수도 있었지만, **감사 로그**로 남기는 걸 택했어요. 이 프로젝트엔 이미 상태 변경 어드민이 [감사 로그](/blog/project/pay/pay-23-ops-admin)를 남기는 패턴이 있고, "누가 언제 무엇을 했나"는 append-only 감사 테이블의 몫이거든요. 대사 결과 행은 **최종 상태(MANUALLY_RESOLVED)**만 들고, 이력은 감사가 맡는 분리예요. 덕분에 스키마 변경도 status enum에 값 하나 추가(V6)로 최소화됐고요.

**(2) 상태 변경을 진짜로 저장하기.** 여기서 [바로 앞서 잡은 버그](/blog/project/pay/pay-26-persistence-bug)의 교훈이 그대로 적용됐어요. 이 프로젝트는 OSIV를 꺼서, 불러온 엔티티의 상태만 바꾸면 커밋 때 flush가 안 돼요. `result.resolveManually()`로 상태만 바꾸고 두면 **DB엔 안 남아요.** 그래서 `repository.saveAndFlush(result)`로 명시 영속했어요. 방금 배운 걸 새 코드에 곧바로 적용한 거죠.

## 마치며

이번 두 어드민의 공통점은 **"자동화의 정기 주기와 별개로, 사람이 지금 이 한 건을 손볼 수 있게"**예요. 배치는 전체를 훑고, 어드민은 특정 건을 즉시. 이 둘이 다 있어야 운영이 돌아가요.

그리고 단건 sync가 배치와 **같은 확정 로직을 재사용**한 것, 수기 확정에 방금 배운 saveAndFlush를 곧바로 적용한 것 — 새 기능이 기존 자산(조회 재검증 경로) 위에, 그리고 방금 얻은 교훈 위에 얹힌 게 좋았어요.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, V6 마이그레이션·단건 sync·ROLE_ADMIN 인가를 실 MySQL로 검증했습니다.*

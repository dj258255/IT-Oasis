---
title: '대사 엔진은 있는데 넣을 파일이 없었다 — PG 정산 파일 업로드로 루프 닫기'
titleEn: 'The Reconciliation Engine Existed but Had No File to Feed It — Closing the Loop with PG Settlement Uploads'
description: 결제 시스템 개선기. 내부 기록과 PG 기록을 맞춰 4분류하는 대사 엔진은 만들어뒀는데, 정작 PG 정산 파일을 넣을 경로가 없어 엔진이 돌지 못했다. 실무의 정산 파일(CSV)을 업로드해 파싱하고, 대사를 돌려 불일치를 예외 큐에 쌓고, 사람이 수기 확정하는 루프를 닫은 이야기. 헤더가 제각각이고 요약행·공백이 섞인 진짜 파일을 견고하게 다루는 법.
descriptionEn: "Payment system improvement log. The engine that reconciles internal vs PG records into four categories existed, but there was no way to feed it a PG settlement file, so it never ran. A story of closing the loop: upload a real settlement CSV, parse it, reconcile, queue mismatches, and let a human resolve them — and handling real files with varied headers, summary rows, and blanks robustly."
date: 2026-11-07T00:00:00.000Z
tags:
  - Payment
  - Reconciliation
  - Settlement
  - CSV
  - Operations
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 33
---

*결제 시스템 시리즈. 개선기 — 대사 엔진에 실제 파일을 물리기.*

## 0. 엔진은 도는데, 연료가 없었다

[대사(reconciliation)](/blog/project/pay/pay-4-ledger-settlement-reconciliation)는 우리 내부 기록과 PG가 보내온 기록을 맞춰보고, 안 맞으면 4분류로 남기는 **정합성의 최종 방어선**이에요.

```
MATCHED         내부·외부 둘 다 있고 금액 일치      → 자동 종결
INTERNAL_ONLY   우리에겐 있는데 PG엔 없음          → 사람 확인
EXTERNAL_ONLY   PG엔 있는데 우리에겐 없음          → 사람 확인
AMOUNT_MISMATCH 둘 다 있는데 금액이 다름            → 사람 확인
```

엔진(`reconcile(List<ExternalRecord>)`)은 잘 만들어져 있었어요. 그런데 이번에 보니 — **정작 그 `ExternalRecord`(외부 기록)를 넣을 방법이 없었어요.** PG는 정산을 **파일**(CSV/엑셀)로 주는데, 그걸 파싱해서 엔진에 물리는 경로가 빠져 있던 거죠. 내부 기록은 [결제 완료 이벤트로 자동 적재](/blog/project/pay/pay-4-ledger-settlement-reconciliation)되는데, 외부 쪽 연료가 없어 엔진이 사실상 안 돌았어요.

## 1. 진짜 정산 파일은 지저분하다

"CSV 파싱쯤이야" 싶었는데, 실무 정산 파일을 떠올리니 만만치 않았어요.

> PG마다 **헤더 이름이 달라요.** 어디는 `orderNo`, 어디는 `order_no`, 국내 PG는 `주문번호`. 금액도 `amount`/`결제금액`/`settle_amount`. 게다가 파일엔 우리가 안 쓰는 **부가 컬럼**(거래일시·승인번호·수수료…)이 잔뜩 있고, 맨 아래엔 **요약행**(합계)이나 **빈 줄**이 섞여요. 엑셀로 저장하면 파일 앞에 **BOM**이 붙고, 금액엔 **천단위 콤마**가 들어가요.

그래서 파서를 "관대하되 견고하게" 만들었어요.

- **헤더 기반 매핑**: 첫 줄에서 컬럼명을 정규화(소문자·공백 제거)해 `orderNo`류와 `amount`류의 **위치**를 찾아요. 컬럼 순서나 부가 컬럼에 무관하죠. 두 컬럼이 없으면 "이건 정산 파일이 아니다"로 400 에러.
- **불량행 skip + 카운트**: 컬럼이 모자란 요약행, orderNo가 빈 행, 금액 파싱 실패 행은 **건너뛰고 스킵 수를 집계**해요. 한 줄 이상하다고 전체 대사를 못 돌리면 안 되니까요.
- **자잘한 방어**: BOM 제거, 천단위 콤마·공백 제거, 앞머리 공백줄 건너뛰기.

"업로드했는데 3만 줄 중 1줄이 이상해서 실패"가 아니라, "3만 줄 중 2줄은 요약행이라 건너뛰고 29,998건 대사 완료"가 실무에서 필요한 동작이에요.

## 2. 업로드 → 대사 → 큐 → 확정, 루프가 닫힌다

이제 어드민에서 정산 파일을 올리면 돼요.

```
POST /api/v1/admin/reconciliations/run   (multipart, 정산 CSV)
→ 파싱 → reconcile() → 결과를 타입별 집계해 즉시 응답
```

실제로 한글 헤더 파일로 돌려봤어요 — 하나는 금액 일치, 하나는 금액 불일치(우리 10,000 vs PG 9,000), 하나는 우리에게 없는 유령 주문.

```
업로드 파일:
  주문번호,결제금액,승인번호
  01KWW05F...,10000,A001     ← 일치
  01KWW05G...,9000,A002      ← 금액 불일치(내부 10000)
  ORDER-GHOST-999,5000,A003  ← 외부 단독(우리에겐 없음)

응답:
  { external:3, matched:1, amountMismatch:1, externalOnly:1, pending:2 }
```

불일치 2건은 [예외 큐(PENDING)](/blog/project/pay/pay-23-ops-admin)에 쌓이고, 어드민이 조사한 뒤 [수기 확정](/blog/project/pay/pay-29-admin-sync-resolve)하면 큐에서 빠져요.

```
POST /admin/reconciliations/2/resolve  → 200
확정 후 PENDING 큐 → [3]   ← 확정한 2번은 빠지고 3번만 남음
```

이걸로 **업로드 → 대사 → 불일치 큐 → 수기 확정**의 루프가 완전히 닫혔어요. 그동안 조각조각 있던 것들([대사 엔진](/blog/project/pay/pay-4-ledger-settlement-reconciliation), [불일치 조회·수기 확정](/blog/project/pay/pay-29-admin-sync-resolve))이 파일 인입이라는 마지막 조각으로 이어진 거죠.

## 마치며

이번 건 "엔진에 연료를 물린" 편이에요. 좋은 엔진을 만들어놓고도, 그걸 돌릴 입력 경로가 없으면 쓰이지 못한다는 걸 다시 느꼈어요. [FDS 판정 엔진](/blog/project/pay/pay-31-fds-review-queue)도, 이 대사 엔진도 — 만들어두기만 했지 **실제 트리거가 빠져** 있던 공통점이 있었네요.

그리고 배운 건, **실무 파일은 항상 지저분하다**는 거예요. 깔끔한 CSV를 가정하면 실제 정산 파일 앞에서 바로 깨져요. 헤더가 제각각이고, 요약행이 섞이고, BOM이 붙는 걸 **전제로** 파서를 짜야 실무에서 살아남아요. 관대하되, 무엇을 건너뛰었는지는 숫자로 정직하게 보고하는 것 — 그게 정산처럼 돈이 걸린 데이터에선 특히 중요하더라고요.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, 한글 헤더 정산 CSV 업로드→대사→수기 확정을 실 MySQL로 검증했습니다.*

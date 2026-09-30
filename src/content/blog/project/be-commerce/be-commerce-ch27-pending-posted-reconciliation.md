---
title: '대사 결과가 맞아도 확정하면 안 되는 경우: Pending과 Posted의 경계'
description: 'Modern Treasury는 ACH 입금을 pending 단계에서 잠정 대사해 하루를 앞당기고 posted가 오면 다시 대사합니다. BE-commerce 지급 대사는 금액이 맞아도 posted가 아니면 MATCHED로 올리지 않고, 그 결과가 지급 확정의 유일한 입구입니다. 코드로 강제한 것과 합성 report로만 확인한 것을 나눠 적었습니다.'
date: 2026-09-22
category: study/be-commerce
coverImage: "/uploads/project/be-commerce/diagrams/erd.svg"
draft: false
series: "BE-commerce"
seriesOrder: 27
tags:
  - Payment
  - Reconciliation
  - Ledger
  - 결제 시스템
---

은행과 PG의 거래는 두 번 보입니다. 먼저 아직 게시되지 않은 pending으로 보이고 나중에 최종 게시된 posted로 다시 보입니다. 금액이 맞는 pending을 보고 돈을 확정하면 그 거래가 게시 전에 취소되거나 실패했을 때 되돌릴 방법이 없습니다. 반대로 posted만 기다리면 문제를 늦게 봅니다.

## Modern Treasury는 왜 pending을 먼저 맞추나

Modern Treasury는 2019년 [tentative reconciliation](https://www.moderntreasury.com/journal/tentative-reconciliation)을 소개하면서 ACH 예를 듭니다. 아침에 ACH 출금을 걸면 다음 날 아침 받는 쪽 계좌에 pending 입금이 보입니다. 예전에는 다음 영업일이 시작돼야 대사됐다는 알림을 받을 수 있었습니다. pending 단계에서 잠정 대사하면 돈을 걷은 시점부터 거래처에 지급하는 시점까지를 영업일 하루만큼 줄일 수 있습니다.

대신 한 결제가 두 번 대사됩니다. 거래가 게시되면 Modern Treasury는 pending 기록을 보관 처리하고 posted 거래를 새 기록으로 만든 뒤 다시 대사합니다. 잠정 대사와 최종 대사를 같은 확정으로 취급하지 않는 것이 핵심입니다.

## 빠르게 보여줄 것인가, 최종 확정을 기다릴 것인가

| 선택지 | 장점 | 비용 |
|---|---|---|
| posted만 대사 | 잘못 확정할 일이 적음 | 문제 발견과 대응이 늦음 |
| 잠정 대사 후 posted에서 재대사 | 운영자가 빨리 상황을 봄 | 잠정 결과를 최종으로 오해할 위험 |
| pending과 사람 확인 예외를 한 상태로 통합 | 모델이 단순함 | 외부 미게시와 내부 불일치가 섞임 |

## BE-commerce에서 "PENDING"은 두 가지입니다

같은 단어가 서로 다른 두 곳에서 쓰여서 먼저 구분해 둡니다.

**주문·결제 대사**(`reconciliation` 모듈)의 후속 처리 상태 `ReconStatus`는 셋입니다.

- `AUTO_RESOLVED`: 거래일·주문번호·금액이 결정적으로 맞아 자동 종결
- `PENDING`: 내부 전용·외부 전용·금액 불일치라서 사람이 확인해야 함
- `MANUALLY_RESOLVED`: 사람이 확인한 뒤 수기로 확정

여기서 `PENDING`은 내부와 외부가 어긋나 사람 판단이 필요하다는 뜻이고 외부 거래의 게시 여부와는 관계가 없습니다. 웹훅이 결제 행보다 먼저 도착한 순서 역전은 `WebhookEventStatus.PENDING_PAYMENT`라는 별도 상태로 웹훅 쪽에서 처리하며 이 예외 큐와는 관계가 없습니다.

**판매자 지급 대사**(`settlement` 모듈)는 외부 report의 pending과 posted를 직접 다룹니다. 이 글의 주제는 이쪽입니다.

## 지급 대사는 posted일 때만 MATCHED로 올립니다

정산은 만들어질 때 `payoutInstructionReference`를 발급합니다. 어드민 지급 API는 외부 report에서 온 `payoutReference`, `currency`, `amount`, `posted`를 받아 `PayoutReconciliationEngine`에 넘깁니다. 판정은 다음 순서입니다.

| 조건 | 결과 |
|---|---|
| report의 reference에 맞는 정산이 없음 | `UNMATCHED_PAYOUT` |
| 정산에 맞는 report가 없음 | `UNMATCHED_SETTLEMENT` |
| 같은 reference의 report가 둘 이상 | `DUPLICATE_PAYOUT_REFERENCE` |
| `posted=false` | `PENDING` (금액이 맞아도) |
| 통화가 다름 | `CURRENCY_MISMATCH` |
| 금액이 다름 | `AMOUNT_MISMATCH` |
| 위를 모두 통과 | `MATCHED` |

`Settlement.markPaidOut()`은 대사 결과가 `MATCHED`가 아니면 예외를 던집니다. 그래서 `PAID_OUT` 전이와 `SettlementPaidOutEvent` 발행, 원장 지급 분개는 `MATCHED`에서만 일어납니다. pending이나 불일치 report는 원장에 아무것도 남기지 않습니다.

Modern Treasury와 비교하면 BE-commerce는 두 번째 줄을 반만 택했습니다. pending report를 받아 `PENDING`으로 기록해 두니 운영자는 빨리 봅니다. 그러나 그 결과로 돈을 움직이지는 않습니다. 하루를 앞당기는 이득은 운영 가시성까지만 가져오고 지급 확정은 posted를 기다립니다. 지급이 잘못 나가면 판매자에게서 돈을 되찾아야 하는데 그 비용이 하루 늦게 아는 비용보다 크다고 봤습니다.

실제 PG·은행이 provisional과 posted 상태를 같은 reference로 준다는 계약이 생기면 그때 `TENTATIVE`와 `POSTED`를 따로 둡니다. 계약이 없는 상태에서 상태를 미리 늘리면 이름만 많아지고 의미는 검증되지 않습니다.

## 운영 지표

지급 대사에서 보고 싶은 지표는 넷입니다.

- pending에서 posted까지 걸린 시간
- pending 뒤에 취소·실패로 바뀐 비율
- posted 도착 후 최종 재대사 결과
- 잠정 결과를 근거로 지급된 금액

마지막 항목은 `markPaidOut()`의 검사 때문에 구조상 0입니다. 앞의 셋은 아직 지표로 만들지 않았습니다. 실 report가 없어 pending에서 posted로 넘어가는 사건 자체가 없기 때문입니다. 주문·결제 대사 쪽의 `recon.pending.count`와 가장 오래된 PENDING의 나이는 게이지로 있지만 지급 대사에는 대응하는 지표가 없습니다.

## 코드로 확인한 것과 확인하지 못한 것

`PayoutReconciliationEngineTest`는 스프링과 DB 없이 판정 규칙만 봅니다. exact match, pending이 금액이 맞아도 `MATCHED`가 되지 않는 경우, reference 누락·중복, 금액·통화 불일치를 합성 report로 재현합니다. `SettlementAdminServiceTest`는 저장소를 mock으로 바꾼 서비스 테스트이고 정확히 맞는 posted report만 `PAID_OUT`으로 넘어가는지 확인합니다.

지급 대사 컬럼과 reference 유니크 제약을 추가한 Flyway `V65` 마이그레이션은 MySQL Testcontainers로 도는 다른 테스트에서 전체 마이그레이션 체인과 함께 적용되는 것까지 확인했습니다. 지급 대사 로직 자체를 실제 MySQL에서 돌린 테스트는 없습니다.

실제 PG·은행 report는 검증하지 못했습니다. 그러려면 테스트 계정과 report 샘플, reference의 생명주기, 같은 파일을 다시 받았을 때 식별자가 유지된다는 보장이 필요합니다.

## 참고

- [Modern Treasury - Tentative Reconciliation](https://www.moderntreasury.com/journal/tentative-reconciliation)
- [Adyen - Payout Reconciliation](https://docs.adyen.com/platforms/payout-reconciliation)
- [대사의 pending과 posted 경계 문서](https://github.com/dj258255/BE-commerce/blob/main/docs/35-%EB%8C%80%EC%82%AC%EC%9D%98-pending%EA%B3%BC-posted-%EA%B2%BD%EA%B3%84.md)
- [지급 대사 엔진과 외부 reference](https://github.com/dj258255/BE-commerce/blob/main/docs/38-%EC%A7%80%EA%B8%89-%EB%8C%80%EC%82%AC-%EC%97%94%EC%A7%84%EA%B3%BC-%EC%99%B8%EB%B6%80-reference.md)

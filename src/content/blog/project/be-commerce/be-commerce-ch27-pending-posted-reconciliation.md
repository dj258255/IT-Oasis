---
title: '대사 결과가 맞아도 확정하면 안 되는 경우: Pending과 Posted의 경계'
description: '결제 예외 큐의 PENDING과 외부 금융 거래의 pending은 같은 말이 아니다. 잠정 대사를 빠르게 보여주는 것과 최종 금액을 확정하는 것 사이의 트레이드오프를 BE-commerce의 현재 모델과 함께 정리했다.'
date: 2026-09-22
category: study/be-commerce
coverImage: "/uploads/project/be-commerce/diagrams/erd.svg"
draft: false
unlisted: true
series: "결제 시스템 만들기"
seriesOrder: 27
tags:
  - Payment
  - Reconciliation
  - Ledger
  - 결제 시스템
---

개인 프로젝트로 만든 이커머스 백엔드 BE-commerce의 결제 개발 기록입니다. 실무 운영 경험이 아닙니다.

BE-commerce의 `PENDING`은 내부 기록과 외부 기록이 맞지 않아 사람이 확인해야 하는 예외 상태입니다. 그런데 외부 PG나 은행의 `pending`은 아직 최종 게시되지 않은 거래를 뜻할 수 있습니다. 둘을 하나의 상태로 취급하면 “현재 보이는 값”과 “최종적으로 확정된 값”을 구분할 수 없습니다.

## 빠르게 보여줄 것인가, 최종 확정을 기다릴 것인가

| 선택지 | 장점 | 비용 |
|---|---|---|
| 최종 파일만 대사 | 오판 가능성이 낮음 | 문제 발견과 대응이 늦음 |
| 잠정 대사 후 게시 시 재대사 | 운영자가 빨리 상황을 봄 | 잠정 결과를 최종으로 오해할 위험 |
| PENDING 하나로 통합 | 모델이 단순함 | 사람 예외와 외부 미게시가 섞임 |

Modern Treasury는 pending 거래를 잠정 대사하지만, posted 거래가 도착하면 별도의 최종 기록으로 다시 대사합니다. 잠정 대사와 최종 대사를 같은 확정으로 취급하지 않는 것이 핵심입니다.

현재 BE-commerce는 이 둘을 섞지 않는다. 정규화된 지급 report를 입력으로 받는
`PayoutReconciliationEngine`을 구현했고, 어드민 지급 경로도 이 결과를 통과해야만
`PAID_OUT`으로 전이하도록 연결했다.

- `PENDING`: 사람 확인이 필요한 금액·기록 불일치
- `AUTO_RESOLVED`: 같은 거래일·주문번호·금액이 결정적으로 맞은 대사
- `PENDING_PAYMENT`: 결제 행보다 웹훅이 먼저 온 순서 역전

지급 대사의 `PENDING`은 금액이 맞더라도 `MATCHED`로 승격하지 않는다. `posted=true`이고
reference·통화·금액이 모두 맞을 때만 `MATCHED`가 된다. reference 누락·중복은 각각
`UNMATCHED_PAYOUT`·`DUPLICATE_PAYOUT_REFERENCE`, 금액·통화 차이는 별도 결과로 남긴다.
즉, 이 구현은 실제 은행 지급을 검증한 것이 아니라 실제 report 계약이 들어왔을 때 무엇을
확정하고 무엇을 보류할지에 대한 결정 경계를 먼저 코드로 고정한 것이다. 정산은 생성 시
`payoutInstructionReference`를 만들고, 지급 API는 `payoutReference`, `currency`, `amount`,
`posted`를 받는다. 정확히 `MATCHED`인 경우에만 `SettlementPaidOutEvent`를 발행하므로,
pending이나 불일치 report는 원장 회수 분개를 만들지 않는다.

실제 PG·은행이 provisional/posted 상태와 동일한 reference를 제공할 때만 `TENTATIVE`와 `POSTED`를 추가합니다. 계약이 없는 상태에서 상태를 미리 늘리면 이름만 많아지고 실제 의미는 검증되지 않습니다.

## 운영 지표도 달라진다

- pending→posted 지연 시간
- pending 이후 취소·실패로 바뀐 비율
- posted 도착 후 최종 재대사 결과
- 잠정 결과를 근거로 지급된 금액

마지막 항목이 0이어야 한다는 것이 현재의 보수적인 선택입니다. 빨리 보이는 것은 허용하지만 최종 게시 전에는 돈을 확정하지 않습니다.

## 실제 계약과 합성 검증의 경계

`SettlementAdminServiceTest`와 `PayoutReconciliationEngineTest`에서는 exact match, pending,
reference 누락·중복, 금액·통화 불일치를 합성 report로 재현했다. Flyway `V65`와 MySQL
Testcontainers 기동도 확인했다. 다만 실제 PG·은행 report를 검증한 것은 아니다. 실제 검증에는
테스트 계정, report 샘플, reference 생명주기, 동일 파일 재수집 시 식별자 보장이 필요하다.

## 참고

- [Modern Treasury - Tentative Reconciliation](https://www.moderntreasury.com/journal/tentative-reconciliation)
- [Adyen - Financial Reconciliation](https://www.adyen.com/knowledge-hub/financial-reconciliation)
- [대사의 pending과 posted 경계 문서](https://github.com/dj258255/payment-system/blob/main/docs/35-%EB%8C%80%EC%82%AC%EC%9D%98-pending%EA%B3%BC-posted-%EA%B2%BD%EA%B3%84.md)
- [지급 대사 엔진과 외부 reference](https://github.com/dj258255/payment-system/blob/main/docs/38-%EC%A7%80%EA%B8%89-%EB%8C%80%EC%82%AC-%EC%97%94%EC%A7%84%EA%B3%BC-%EC%99%B8%EB%B6%80-reference.md)

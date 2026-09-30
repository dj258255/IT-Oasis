---
title: '결제 시스템의 정합성을 어떻게 운영 지표로 증명할 것인가'
description: 'Stripe는 원장 품질을 clearing·timeliness·completeness 세 축으로 재고 Adyen은 경로마다 우선순위를 나눕니다. 그 틀을 BE-commerce 규모의 질문 넷으로 줄이고 지금 지표로 있는 것과 목록에만 있는 것을 코드 기준으로 나눴습니다.'
date: 2026-09-22
category: study/be-commerce
coverImage: "/uploads/project/be-commerce/diagrams/erd.svg"
draft: false
series: "BE-commerce"
seriesOrder: 25
tags:
  - Payment
  - 정합성
  - Ledger
  - Reconciliation
  - 운영
  - 결제 시스템
---

결제 시스템에서 "정합하다"는 말은 차변과 대변의 합이 맞는다는 뜻만으로는 부족합니다. 외부 PG와 은행, 웹훅, 정산 파일, 내부 원장이 서로 다른 시각과 형식으로 움직이기 때문입니다. 이 글은 기능을 더 붙이기 전에 **돈이 어디에 있고 무엇이 아직 확인되지 않았으며 어느 시점까지 설명할 수 있는지**를 운영 지표로 다시 정의한 기록입니다. 각 지표가 지금 코드에 실제로 있는지도 함께 적었습니다.

## 큰 결제 회사는 무엇을 재나

**Stripe**의 원장(Ledger)은 하루 50억 건의 사건을 받습니다. Stripe는 이 원장의 데이터 품질을 세 축으로 잽니다.

| 축 | Stripe의 질문 |
|---|---|
| clearing | 자금 흐름이 제대로 끝났는가 |
| timeliness | 데이터가 제때 도착했는가 |
| completeness | 하위 시스템의 사건을 빠짐없이 담았는가 |

explainability는 네 번째 축으로 나오지 않습니다. 세 축을 지킨 결과로 내건 목표이고 Stripe는 데이터가 10배로 늘어나는 동안 자금 이동의 99.9999% 이상을 설명할 수 있었다고 밝혔습니다. 정산 계정 잔액이 0이 아닌 것을 찾는 단순한 쿼리 하나로 정확성 문제를 잡는다는 예도 듭니다.

**Adyen**은 경로마다 우선순위를 다르게 둡니다. 결제 요청 경로는 availability와 낮은 latency를, 회계 경로는 accuracy와 reliability를, 데이터 처리 경로는 throughput을 먼저 봅니다.

**Uber**는 매달 약 12억 건의 정산을 처리하고 50곳이 넘는 PSP에서 연 1,300억 달러의 이동 중 자금을 다룹니다. 정산 회계 시스템을 따로 만든 이유는 회수·환불(Uber가 시작), 차지백(고객이 시작), 수수료·세금(PSP가 시작)처럼 출발점이 다른 사건과 형식이 제각각인 PSP 파일을 한 장부에 맞춰야 했기 때문입니다.

## BE-commerce 규모의 질문 넷

BE-commerce는 PG 한 곳과 합성 트래픽으로 도는 프로젝트라서 이 숫자를 흉내 낼 이유가 없습니다. 위 틀을 참고해 지금 규모에서 관찰할 수 있는 질문 넷으로 줄였습니다. accuracy와 explainability를 별도 질문으로 둔 것은 Stripe의 분류를 옮긴 것이 아닙니다. 우리가 운영자 관점에서 따로 묻고 싶은 질문이라 나눴습니다.

| 질문 | BE-commerce에서 묻는 것 | 코드에 있는 것 |
|---|---|---|
| completeness | 승인·취소·분쟁·지급 사건이 모두 원장에 들어갔는가 | 사건마다 별도 분개, 사건 키 유니크로 멱등 |
| timeliness | 사건이 난 뒤 언제 원장과 대사에 보이는가 | `payment.unknown.oldest.age`, `recon.pending.oldest.age.seconds` 게이지 |
| accuracy | 차변=대변, 내부=외부, 정산=지급이 맞는가 | 불균형 거래 생성 불가, 대사 판정, 지급 대사 `MATCHED` 게이트 |
| explainability | 불일치 금액의 원인과 다음 행동을 설명할 수 있는가 | `recon.pending.unexplained.amount` 게이지, PENDING 사유 |

## 1. 원장이 맞아도 돈의 흐름 전체가 맞는지는 따로 봐야 합니다

승인 분개가 균형이어도 판매자에게 지급할 돈이 맞는지는 알 수 없습니다. 승인 뒤에 부분취소와 환불, 차지백, 수수료, 지급 보류가 올 수 있습니다. 그래서 BE-commerce는 원거래를 덮어쓰지 않고 사건마다 별도 분개를 남깁니다.

지급을 설명하는 식은 다음처럼 나눴습니다.

```text
payout
= settlements
- refunds
- chargebacks
- fees
- reserves
+ adjustments
```

중요한 것은 각 항이 어떤 사건과 reference로 이어지는가입니다. 지급 합계만 맞고 어떤 환불과 수수료가 들어갔는지 되짚지 못하면 운영자는 다시 파일을 눈으로 찾아야 합니다.

지금 코드는 승인(`PAYMENT_APPROVED`), 취소(`PAYMENT_CANCELED`), 차지백 패소(`DISPUTE_LOST`), 정산 지급(`SETTLEMENT_PAID_OUT`)을 각각 분개로 남깁니다. 거래 유형과 출처 ID를 묶은 유니크 키가 있어서 같은 사건을 두 번 적지 못합니다. 차변과 대변 합계가 다르면 `LedgerTransaction`을 만드는 순간 예외가 나고 이 규칙은 테스트로 고정돼 있습니다.

지급 확정도 내부 게이트까지는 닫았습니다. 정산이 만든 `payoutInstructionReference`와 외부 report의 reference·통화·금액·`posted`가 모두 맞는 `MATCHED` 결과에서만 `PAID_OUT`과 지급 원장 이벤트를 허용합니다. 실제 PG 지급 파일과 은행 지급 reference를 맞추는 계약 테스트는 외부 환경이 있어야 해서 아직 하지 못했습니다.

## 2. 재시도는 결과가 확정됐는지부터 묻습니다

모든 실패를 재시도하면 안전할 것 같지만 승인 요청은 다릅니다. 네트워크가 끊긴 순간 PG가 이미 승인했을 수 있어서 승인 재시도는 이중 결제 위험을 만듭니다.

그래서 기준은 "요청이 PG에 닿았을 수 있는가"입니다.

| 상황 | 처리 | 이유 |
|---|---|---|
| 승인 호출 중 예외(타임아웃 등) | `UNKNOWN`으로 보존, 같은 멱등키로만 재전송 | PG가 처리했을 수 있음 |
| 서킷 오픈 | 확정 실패 | 호출이 나가지 않았으므로 PG에 닿지 않은 것이 보장됨 |
| PG 동시 호출 상한 초과 | 확정 실패 | 호출 전에 끊겨 PG에 닿지 않은 것이 보장됨 |
| PG 조회 | 최대 3회, 지수 백오프와 지터 | 읽기라서 반복해도 상태가 바뀌지 않음 |

서킷 오픈은 처음에는 `UNKNOWN`으로 적었습니다. 그러자 복구 배치가 조회할 대상이 없는 미확정 건이 생겼고 #372에서 확정 실패로 바꿨습니다. 거절된 건은 `payment.pg.approval.rejected`에 `reason=circuit_open` 또는 `concurrency_limit`로 따로 셉니다. 재시도 폭풍을 실제로 부하를 걸어 잰 결과는 [결제 재시도 글](/blog/project/be-commerce/be-commerce-ch26-payment-retries-retry-storm)에 있습니다.

PG 조회가 실패했을 때도 같은 원칙을 씁니다. 어느 PG에도 묻지 못했으면 "그런 결제는 없다(NOT_FOUND)"로 답하지 않고 조회하지 못했다는 사실을 그대로 남깁니다.

## 3. 웹훅은 상태를 확정하지 않고 다시 조회할 계기로 씁니다

웹훅은 결제 행보다 먼저 오거나 중복되거나 늦게 올 수 있습니다. 토스는 일반 결제 웹훅에 서명 헤더를 붙이지 않습니다(서명이 붙는 것은 `payout.changed`와 `seller.changed`뿐입니다). 그래서 페이로드의 상태를 그대로 믿지 않습니다.

지금 코드는 원본 이벤트를 외부 이벤트 ID 유니크로 멱등하게 저장하고 결제 행이 없으면 `PENDING_PAYMENT`로 남깁니다. 그 뒤 `paymentKey`로 PG를 다시 조회해 상태를 확정합니다. 왜 페이로드를 믿지 않고 다시 조회하는지, 보류를 언제까지 들고 있는지는 [서명이 없는 결제 웹훅을 어떻게 신뢰할 것인가](/blog/project/be-commerce/be-commerce-ch15-webhook-arrived-first)에 따로 적었습니다.

운영자가 봐야 할 웹훅 지표로는 다음 다섯을 꼽았습니다.

- 웹훅 재시도 횟수
- 가장 오래된 보류 이벤트의 나이
- 마지막 실패 사유
- 다시 실행(replay)한 이벤트 수
- 처리할 수 없는 이벤트(poison)와 일반 이벤트의 분리 여부

**이 다섯 가운데 지금 지표로 나오는 것은 없습니다.** `WebhookEvent`에 재시도 횟수 필드는 있지만 게이지나 카운터로 내보내는 코드가 없습니다. 운영자가 한 건을 골라 다시 실행하는 기능도 아직 없습니다. 대사 쪽 PENDING 건수와 가장 오래된 나이는 게이지로 있고 대시보드에도 올라가 있어서 웹훅 쪽이 한 단계 뒤처져 있습니다. 이 목록은 다음 구현 목표입니다.

## 4. 대사는 맞은 이유까지 남깁니다

대사 결과를 `MATCHED` 한 줄로 끝내면 나중에 근거가 바뀌었을 때 알아채기 어렵습니다. 그래서 승인과 부분취소를 사건별 행으로 보존합니다. 이 결정은 [잔액과 거래 사건을 나눈 글](/blog/project/be-commerce/be-commerce-ch21-cancel-row-overwrite)에 있습니다.

대사 운영의 최소 지표와 지금 상태입니다.

| 지표 | 지금 상태 |
|---|---|
| `PENDING` 건수 | `recon.pending.count` 게이지, 대시보드 패널 |
| 가장 오래된 `PENDING`의 나이 | `recon.pending.oldest.age.seconds` 게이지, 알림 기준([알림을 나이에 거는 이유](/blog/project/be-commerce/be-commerce-ch32-unknown-drain-time)) |
| 설명되지 않은 미해결 금액 합계 | `recon.pending.unexplained.amount` 게이지, 대시보드에는 아직 없음 |
| 내부 전용·외부 전용·금액 불일치 건수 | 대사 실행마다 결과 요약으로 반환, 상시 지표는 아님 |
| 원인과 다음 행동이 비어 있는 건수 | 없음 |

마지막 줄이 explainability에 해당합니다. 자동 분류가 아무리 맞아도 운영자가 다음에 무엇을 확인할지 모르면 정합성의 증거가 되지 못합니다. 이 지표는 아직 만들지 않았습니다.

## 5. 구현했다고 쓰지 않는 것

다음은 구조와 테스트만으로 끝났다고 말할 수 없습니다.

- 두 실 PG 사이의 failover 성공률·수수료·승인율 비교
- 토스 공개 주소로 직접 받는 실 웹훅 전달과 재전송 계약
- 실제 은행 지급 reference와 PG payout report의 대조
- PCI SAQ와 가맹점 책임 범위
- 실 트래픽에서의 데이터 품질 SLO
- 다통화 환율 기준시각과 반올림 비용 귀속

모두 외부 계약과 운영 데이터가 있어야 결정할 수 있는 문제입니다. 합성 데이터 실험과 실제 계약 테스트를 구분해 다음 작업으로 남겼습니다.

## 정리

결제 정합성은 DB 트랜잭션을 잘 쓰는 것만으로 끝나지 않습니다. 다음 네 가지를 각각 재야 합니다.

1. 모든 돈의 이동이 기록됐는가
2. 제시간에 기록됐는가
3. 금액 관계가 맞는가
4. 틀렸을 때 사람이 이유를 되짚을 수 있는가

지금 BE-commerce는 1과 3을 코드로 강제하고 2는 결제·대사 쪽만 게이지로 봅니다. 4는 사유 필드까지만 있고 지표는 없습니다. 어떤 금액을 자동 확정할지, 어느 실패를 `UNKNOWN`으로 남길지, 지급을 보류할지는 도메인 비용과 외부 계약을 함께 보고 사람이 기준을 세웁니다.

## 작업 자체도 검증할 수 있게 남깁니다

혼자 진행하면 기능을 떠오르는 순서대로 붙이기 쉽습니다. 그래서 작업 보드와 Issue·PR 템플릿을 두고 작업마다 목적과 완료 조건, 예상 시간, 예상 산출물, 위험, 검증 명령을 먼저 적게 했습니다. 예상과 실제가 달라지면 완료일과 원인을 고치고 구현 완료와 검증 완료를 나눠 표시합니다.

실 PG 계약이 없으면 두 PG failover를 `Done`으로 두지 않고 `Blocked by external state`로 남깁니다. 지금 권한과 증거로는 결론을 낼 수 없다는 상태를 다른 사람이 계획에 쓸 수 있게 하려는 표시입니다. [프로젝트 작업 보드](https://github.com/dj258255/BE-commerce/blob/main/docs/PROJECT-BOARD.md)에서 카드와 예상 범위, 산출물, 위험을 볼 수 있습니다.

## 참고

- [Stripe Ledger](https://stripe.com/blog/ledger-stripe-system-for-tracking-and-validating-money-movement)
- [Stripe Idempotency](https://stripe.com/blog/idempotency)
- [Uber Next-Gen Payments Platform](https://www.uber.com/us/en/blog/payments-platform/)
- [Uber Settlement Accounting](https://www.uber.com/us/en/blog/ubers-advanced-settlement-accounting-system/)
- [Adyen Architecture Decisions](https://www.adyen.com/knowledge-hub/design-to-duty-adyen-architecture)
- [Adyen Consuming Webhooks](https://www.adyen.com/knowledge-hub/consuming-webhooks)
- [Adyen Payout Reconciliation](https://docs.adyen.com/platforms/payout-reconciliation)

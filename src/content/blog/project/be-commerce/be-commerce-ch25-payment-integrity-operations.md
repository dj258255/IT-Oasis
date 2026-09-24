---
title: '결제 시스템의 정합성을 어떻게 운영 지표로 증명할 것인가'
description: '원장 잔액이 맞는 것만으로는 부족하다. 자금 이동의 completeness·timeliness·accuracy·explainability를 기준으로, BE-commerce에 이미 구현한 것과 아직 외부 계약이 필요한 것을 나눠 정리했다.'
date: 2026-09-22
category: study/be-commerce
coverImage: "/uploads/project/be-commerce/diagrams/erd.svg"
draft: false
unlisted: true
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

결제 시스템에서 “정합하다”는 말은 차변과 대변의 합이 맞는다는 뜻만으로 부족합니다. 외부 PG,
은행, 웹훅, 정산 파일, 내부 원장이 서로 다른 시각과 형식으로 움직이기 때문입니다. 그래서 이번에는
기능을 더 붙이는 대신 **돈이 어디에 있고, 무엇이 아직 확인되지 않았으며, 어느 시점까지 설명할 수 있는지**를
운영 지표로 다시 정의했습니다.

## 해외 결제 시스템에서 반복되는 기준

Stripe는 원장을 단순한 거래 테이블이 아니라 자금 이동을 추적하는 불변 기록으로 두고,
데이터 품질을 completeness·timeliness·accuracy·explainability로 나눠 관리합니다.
Adyen은 결제 요청 경로에서는 availability와 latency를, 회계 경로에서는 accuracy와 reliability를,
데이터 처리 경로에서는 throughput을 우선한다고 설명합니다.

이 기준을 그대로 가져와 “BE-commerce도 대규모 결제 플랫폼이다”라고 주장하지는 않았습니다. 대신 각 기준을
현재 규모에서 관찰할 수 있는 질문으로 줄였습니다.

| 품질 축 | BE-commerce에서 묻는 질문 | 현재 확인한 것 |
|---|---|---|
| completeness | 승인·취소·분쟁·지급 사건이 모두 원장에 들어갔는가 | 원장 이벤트별 분개와 대사 테스트 |
| timeliness | 사건이 발생한 뒤 언제 원장과 대사에 보이는가 | 웹훅 보류·복구·PENDING age |
| accuracy | 차변=대변, 내부=외부, 정산=지급 수식이 맞는가 | 원장 불변식·대사 판정 |
| explainability | 불일치 금액의 원인과 다음 행동을 설명할 수 있는가 | 근거 출처·PENDING 사유·운영 타임라인 |

## 1. 원장이 맞아도 돈의 전체 흐름이 맞는 것은 아니다

승인 분개가 균형이라고 해서 판매자에게 지급할 돈이 맞는 것은 아닙니다. 승인 뒤에 부분취소,
환불, 차지백, 수수료, 지급 보류가 올 수 있습니다. 그래서 BE-commerce는 원거래를 덮어쓰지 않고
각 사건을 별도 분개로 남깁니다.

지급을 설명하는 기준식은 다음처럼 분리했습니다.

```text
payout
= settlements
- refunds
- chargebacks
- fees
- reserves
+ adjustments
```

이 식에서 중요한 것은 숫자 자체보다 **각 항이 어떤 사건과 reference로 연결되는가**입니다.
지급 합계만 맞고 어떤 환불·수수료가 포함됐는지 복원하지 못하면 운영자는 다시 파일을 눈으로
찾아야 합니다.

현재 BE-commerce는 승인·취소·차지백 패소·정산 지급을 별도 원장 분개로 남기고, 차변과 대변이 맞지 않는
거래를 생성하지 않습니다. 지급 확정도 내부 게이트까지는 닫았습니다. 정산이 만든
`payoutInstructionReference`와 외부 report의 reference·통화·금액·`posted`가 모두 맞는
`MATCHED` 결과에서만 `PAID_OUT`과 지급 원장 이벤트를 허용합니다. 반면 실제 PG 지급 파일과
은행 지급 reference까지 맞추는 계약 테스트는 아직 외부 환경이 필요합니다.

## 2. 재시도는 복구 장치이면서 장애 증폭기다

모든 실패를 재시도하면 안전할 것 같지만 승인 요청은 다릅니다. 네트워크가 끊긴 순간 PG가 승인했을
수 있기 때문에 승인 재시도는 이중 결제의 위험을 만듭니다.

그래서 현재 기준은 세 가지입니다.

- 승인 호출 예외·서킷 오픈: `UNKNOWN`으로 보존
- PG 조회: 읽기이므로 최대 3회, exponential backoff+jitter로 재시도
- PG 동시 호출 상한 초과: PG에 닿지 않았음이 보장되므로 확정 실패

이 기준은 “재시도 가능/불가”가 아니라 **결과가 확정됐는가**를 먼저 묻습니다. 이후 retry storm 실험에서는
PG 지연, 도착률, 동시성, retry 간격, 정상 API p95와 connection wait를 함께 관측해야 합니다.

## 3. 웹훅은 진실의 원천이 아니라 수렴을 돕는 신호다

웹훅은 결제 행보다 먼저 오거나, 중복되거나, 늦게 올 수 있습니다. 일부 일반 결제 웹훅에는 서명 헤더가
없으므로 페이로드의 상태를 그대로 믿는 것도 위험합니다.

현재 BE-commerce는 원본 이벤트를 멱등하게 저장하고, 결제 행이 없으면 `PENDING_PAYMENT`로 남기며,
`paymentKey`로 PG 조회를 다시 한 뒤 상태를 확정합니다. 이때 운영자가 봐야 하는 지표는 단순한
처리 성공률이 아닙니다.

- webhook retry count
- 가장 오래된 보류 이벤트 age
- 마지막 실패 사유
- replay된 이벤트 수
- poison event와 일반 이벤트의 분리 여부

현재 구현은 원본 보존·선행 웹훅 보류·보류 재시도까지 닫혀 있습니다. 운영자가 안전하게 한 건을 replay하고
전후 원장·대사 결과를 비교하는 화면은 다음 검증 대상입니다.

## 4. 대사의 목적은 “맞다”가 아니라 “왜 맞는지 설명”하는 것이다

대사 결과가 `MATCHED`라고 끝내면 나중에 그 근거가 바뀌었을 때 알아채기 어렵습니다. 그래서 승인과
부분취소를 사건별 행으로 보존하고, 조회 실패는 “기록 없음”이 아니라 빠진 출처로 표시합니다.

대사 운영의 최소 지표는 다음으로 정했습니다.

- `PENDING` 건수
- 가장 오래된 `PENDING` age
- 미해결 금액 합계
- 내부 전용·외부 전용·금액 불일치 건수
- 원인과 다음 행동이 없는 건수

이 중 마지막 지표가 explainability입니다. 자동 분류 정확도가 높아도 운영자가 다음에 무엇을 확인할지
모르면 결제 정합성의 증거가 되지 않습니다.

## 5. 아직 구현했다고 쓰면 안 되는 것

다음은 구조와 테스트만으로 완료했다고 말할 수 없습니다.

- 두 실 PG 사이의 failover 성공률·수수료·승인율 비교
- 토스 공개 주소로 직접 받는 실 웹훅 전달과 재전송 계약
- 실제 은행 지급 reference와 PG payout report의 대조
- PCI SAQ와 가맹점 책임 범위
- 실 트래픽에서의 데이터 품질 SLO
- 다통화 환율 기준시각과 반올림 비용 귀속

이 범위는 “못 했다”가 아니라 **외부 계약과 운영 데이터가 없으면 결정할 수 없는 문제**입니다.
따라서 합성 데이터 실험과 실제 계약 테스트를 구분해 다음 작업으로 남겼습니다.

## 결론

결제 정합성은 “DB 트랜잭션을 잘 썼다”로 끝나지 않습니다.

1. 모든 돈의 이동이 기록됐는가
2. 제시간에 기록됐는가
3. 금액 관계가 맞는가
4. 틀렸을 때 사람이 이유를 복원할 수 있는가

이 네 가지를 각각 측정해야 합니다. AI는 이 지표를 계산하고 후보를 정리할 수 있지만,
어떤 금액을 자동 확정할지, 어느 실패를 UNKNOWN으로 남길지, 지급을 보류할지 같은 결정은
도메인 비용과 외부 계약을 함께 보고 사람이 기준을 세워야 합니다.

## 작업 자체도 검증 가능하게 남긴다

이런 결정을 혼자 진행하면 기능을 생각나는 순서대로 추가하기 쉽습니다. 그래서 BE-commerce에는 작업 보드와
Issue·PR 템플릿을 둬서 작업마다 목적, 완료 조건, 예상 시간, 예상 산출물, 위험, 검증 명령을 먼저 적게 했습니다.
예상과 실제가 달라지면 완료일과 원인을 갱신하고, 구현 완료와 검증 완료를 분리합니다.

예를 들어 실 PG 계약이 없으면 두 PG failover를 `Done`으로 표시하지 않고 `Blocked by external state`로
남깁니다. 이것은 일을 덜 했다는 표시가 아니라, 현재 권한과 증거로는 결론을 낼 수 없다는 상태를 다른 사람이
계획에 사용할 수 있게 만드는 기록입니다. [프로젝트 작업 보드](https://github.com/dj258255/BE-commerce/blob/main/docs/PROJECT-BOARD.md)에서 현재 카드·예상 범위·산출물·위험을 확인할 수 있습니다.

## 참고

- [Stripe Ledger](https://stripe.com/blog/ledger-stripe-system-for-tracking-and-validating-money-movement)
- [Stripe Idempotency](https://stripe.com/blog/idempotency)
- [Uber Next-Gen Payments Platform](https://www.uber.com/us/en/blog/payments-platform/)
- [Uber Settlement Accounting](https://www.uber.com/us/en/blog/ubers-advanced-settlement-accounting-system/)
- [Adyen Architecture Decisions](https://www.adyen.com/knowledge-hub/design-to-duty-adyen-architecture)
- [Adyen Consuming Webhooks](https://www.adyen.com/knowledge-hub/consuming-webhooks)
- [Adyen Payout Reconciliation](https://docs.adyen.com/platforms/payout-reconciliation)

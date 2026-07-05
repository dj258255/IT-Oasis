---
title: '원장·정산·대사 — 돈이 맞는지 수학으로 증명하기'
titleEn: "Ledger, Settlement, Reconciliation — Proving the Money Adds Up, Mathematically"
description: 결제 시스템 Phase 4, 이 시리즈에서 가장 희소한 편. 취준생 포트폴리오가 거의 안 가는 곳 — 복식부기 원장, 정산 배치, 대사까지 간다. 결제를 차변·대변으로 기록해 "차변 합계 = 대변 합계"로 정합성을 수학적으로 증명하고, 하루치 거래를 집계해 수수료를 떼고 지급금을 만들고, PG 정산 파일과 내부 기록을 4분류로 대사한다 — 대사는 결제의 최종 방어선이다.
descriptionEn: "Payment system Phase 4, the rarest chapter in this series. Where junior portfolios almost never go — a double-entry ledger, a settlement batch, and reconciliation. Recording payments as debits and credits so that 'total debits = total credits' proves integrity mathematically, aggregating a day's transactions to deduct fees and produce payouts, and reconciling the PG settlement file against internal records with a four-way classification — reconciliation is the last line of defense."
date: 2026-07-09T00:00:00.000Z
tags:
  - Payment
  - Double-Entry Ledger
  - Settlement
  - Reconciliation
  - Spring Batch
  - Fintech
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 4
---

*결제 도메인 취업을 목표로 실전 결제 시스템을 밑바닥부터 만드는 시리즈. 이 글은 4편 — 원장·정산·대사. 취준생 포트폴리오가 거의 안 가는 곳.*

## 0. 여기가 차별화의 끝판이다

[0편](/blog/project/pay/pay-0-why-and-modulith)에서 조사한 결론 중 하나 — 결제 포트폴리오에서 **원장·대사까지 가는 경우는 거의 없어요.** PG 연동은 수십 개, 멱등성도 종종 있지만, 복식부기로 정합성을 증명하고 PG 파일과 대사하는 것까지 간 사례는 손에 꼽아요. 그래서 Phase 4가 이 시리즈에서 제일 희소한 편이에요.

세 가지를 만들었어요.

```
복식부기 원장     결제를 차변·대변으로 → "차변 합계 = 대변 합계"로 정합성 증명
정산 배치         하루치 거래 집계 → 수수료 → 지급금
대사             PG 파일 vs 내부 기록 4분류 — 결제의 최종 방어선
```

## 1. 복식부기 원장 — 불균형은 "만들어질 수 없다"

금융 시스템은 잔액을 그냥 숫자로 덮어쓰지 않아요. **모든 자금 이동을 차변(debit)과 대변(credit) 두 줄로 기록**하고, 이 둘의 합계가 항상 같아야 해요. 이게 복식부기예요. (Stripe의 Ledger 시스템이 교과서고요.)

핵심은 **불균형한 거래를 애초에 만들 수 없게** 한 거예요.

```java
static LedgerTransaction of(String txType, ..., List<LedgerEntry> entries) {
    long debit  = entries.stream().filter(e -> e.direction() == DEBIT)...sum();
    long credit = entries.stream().filter(e -> e.direction() == CREDIT)...sum();
    if (debit != credit) {
        throw new IllegalStateException("차변 합계 ≠ 대변 합계: ...");  // ← 존재 불가
    }
    // ...
}
```

그래서 10,000원 결제는 이렇게 기록돼요.

| 계정 | 차변 | 대변 |
|---|---|---|
| PG 미수금 (자산) | 10,000 | |
| 매출 (수익) | | 10,000 |

> 여기서 얻는 게 뭐냐면 — **정합성을 눈이 아니라 수식으로 증명**할 수 있어요. 어딘가 돈이 새면 차변·대변 합계가 안 맞아요. "느낌상 맞는 것 같다"가 아니라, `imbalance() == 0`이라는 **수학적 사실**로 검증되는 거죠.

몇 가지 원칙을 더 박았어요.

- **금액은 항상 양수.** 부호는 방향(DEBIT/CREDIT)으로 표현해요. 음수를 허용하면 방향과 이중 표현이 돼서 버그가 숨어요.
- **append-only.** 취소는 원거래를 지우는 게 아니라 **반대 분개를 추가**해요 (매출 차변 / PG미수금 대변). 이력이 통째로 남죠.
- **멱등.** `(txType, sourceType, sourceId)` 유니크로, 같은 결제 이벤트가 두 번 와도 분개는 한 번만.

그리고 원장은 [Phase 3](/blog/project/pay/pay-3-webhooks-and-outbox)의 이벤트를 구독해요 — 결제 완료 이벤트가 오면 자동으로 분개가 쌓여요.

```java
@ApplicationModuleListener
void onConfirmed(PaymentConfirmedEvent event) {
    ledgerService.recordPaymentConfirmed(event);
}
```

## 2. 정산 — 하루치를 모아 수수료를 떼다

정산은 "구매자가 낸 돈에서 수수료를 빼고 판매자에게 줄 돈을 계산"하는 거예요. 결제 채용공고의 절반이 사실상 정산 얘기고, "**오차 없이** 계산"이 요구사항이에요.

결제 완료 이벤트가 올 때마다 정산 항목(`SettlementItem`)을 쌓아 두고, 배치가 하루치를 집계해요.

```java
public Settlement settle(LocalDate date) {
    if (settlementRepo.existsBySettlementDate(date)) return null;   // 재실행 멱등
    var items = itemRepo.findPending(date);
    long gross = items.stream().mapToLong(...).reduce(0, Math::addExact);
    long fee   = gross * 3 / 100;              // 수수료 3% (정수 내림)
    // Settlement(date, gross, fee, net = gross - fee) 저장 + 항목 SETTLED
}
```

여기서 실무 디테일 두 개.

- **배치 재실행 멱등성**: `settlement_date`에 유니크를 걸어서, 같은 날짜로 배치를 두 번 돌려도 정산이 두 번 만들어지지 않아요. 배치는 언제든 재실행될 수 있으니 이게 필수예요.
- **정수 연산**: KRW는 소수점이 없으니 `long`으로만 계산하고, `gross × 3 / 100`으로 내림 시점을 정확히 맞춰요. 부동소수점은 안 써요 — 0.1원의 오차도 정산에선 사고니까요.

(대용량이면 Spring Batch의 청크·커서·파티셔닝으로 확장해요. Phase 4는 서비스 루프로 원리를 먼저.)

## 3. 대사 — 결제의 최종 방어선

여기까지 잘 만들어도, **PG가 실제로 정산해준 내역과 내 기록이 다를 수 있어요.** 승인 → 매입 → 정산 입금이 며칠에 걸쳐 일어나고, 웹훅이 유실되거나 망취소가 실패하면 어긋나요. 그래서 대사(reconciliation)가 필요해요.

> 시스템 설계 책의 표현을 빌리면 — **"조정(대사)은 결제 시스템의 최종 방어선"**이에요.

PG 정산 파일(외부)과 내 기록(내부)을 `orderNo`로 맞춰서 4가지로 분류해요.

```java
// 내부 {A:1000, B:2000, C:3000}  vs  외부 {A:1000, B:2500, D:4000}
```

| 결과 | 뜻 | 처리 |
|---|---|---|
| **MATCHED** (A) | 양쪽 일치 | 자동 확정 |
| **AMOUNT_MISMATCH** (B) | 금액 다름 (2000 vs 2500) | 사람 확인 큐 |
| **INTERNAL_ONLY** (C) | 내부에만 있음 (PG 누락·매입 실패 의심) | 사람 확인 큐 |
| **EXTERNAL_ONLY** (D) | 외부에만 있음 (내부 유실·웹훅 누락 의심) | 사람 확인 큐 |

핵심은 매칭 엔진이 **결정적(deterministic)**이라는 거예요. 같은 입력이면 항상 같은 결과. 그래서 MATCHED(대부분)는 자동으로 확정(AUTO_RESOLVED)하고, 어긋난 것만 사람이 보는 큐(PENDING)로 보내요. "AI가 알아서 맞춰준다"가 아니라 "**결정적으로 맞추고, 못 맞춘 것만 사람**"이 정석이에요 (Modern Treasury의 대사 철학).

그리고 이걸 테스트로 못 박았어요 — 일부러 어긋난 데이터를 넣고 4분류가 정확히 나오는지.

```java
assertThat(byOrderNo("B").result()).isEqualTo(AMOUNT_MISMATCH);
assertThat(byOrderNo("C").result()).isEqualTo(INTERNAL_ONLY);
assertThat(byOrderNo("D").result()).isEqualTo(EXTERNAL_ONLY);
```

## 4. 정리 — 이제 돈의 흐름이 닫힌다

Phase 4로 결제의 자금 흐름이 한 바퀴 닫혔어요.

```
결제 승인 ──이벤트──> 원장(분개)  → 차변=대변으로 정합성 증명
          └─이벤트──> 정산 항목   → 하루치 집계 → 수수료 → 지급금
PG 정산 파일 ─────────> 대사       → 4분류 → 어긋난 것만 사람 확인
```

돈이 어디서 새면 — 원장의 불균형으로, 혹은 대사의 불일치로 **반드시 드러나요.** 조용히 사라지지 않아요. 이게 금융 시스템에서 "장애보다 정합성 깨짐이 더 무섭다"는 말에 대한 답이에요.

테스트 82개, 전부 통과. 여기까지가 결제 시스템의 **코어**예요 — 주문·결제·실패처리·이벤트·원장·정산·대사.

## 다음 — Phase 5·6: 성능과 운영

코어가 끝났으니, 남은 건 이걸 **빠르고 안전하게 운영**하는 거예요.

```
Phase 5  성능    재고 차감 락 3종 비교(수치로), k6 부하테스트, 목표→병목→개선
Phase 6  운영    Grafana 대시보드(결제 성공률·p99), 백오피스 어드민
```

"동시에 1000명이 결제하면?"에 수치로 답하는 편이에요. 이어서 씁니다.

---

*이 글은 작성 중인 시리즈의 일부예요. 원장 불균형·대사 불일치를 각각 테스트로 재현하며 진행합니다.*

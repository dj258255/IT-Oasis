---
title: '정산이 "총액의 3%"만 떼고 있었다 — 수수료 부가세·지급예정일, 그리고 또 하나의 죽은 배치'
titleEn: 'Settlement Was Just Taking 3% of Gross — Fee VAT, Payout Dates, and Yet Another Dead Batch'
description: 결제 시스템 개선기. 정산이 "총액의 3%"라는 한 줄로 끝나 있었다. 실무 정산은 수수료(정률)에 그 수수료의 부가세 10%를 더 떼고, 지급예정일(정산일+2영업일)까지 계산한다. 붙이면서 정수 화폐 연산을 지키려 수수료율을 bps로 뒀고, 지급확정(PAID_OUT) 상태와 어드민을 더했다. 그런데 정작 정산 배치 settle()은 테스트에서만 불리고 있었다 — 또 하나의 죽은 배치. 그리고 package-info는 쓰지도 않는 Spring Batch를 쓴다고 적어놨다.
descriptionEn: "Payment system improvement log. Settlement ended at a single line: 3% of gross. Real settlement takes a percentage fee, plus 10% VAT on that fee, and computes a payout date (settlement date + 2 business days). Applying it, I kept money in integers by expressing the rate in basis points, added a PAID_OUT state and admin action. But the settle() batch was only ever called from tests — yet another dead batch. And the package-info claimed a Spring Batch it never used."
date: 2027-01-30T00:00:00.000Z
tags:
  - Payment
  - Settlement
  - Domain Modeling
  - Batch
  - Spring Boot
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 45
---

*결제 시스템 시리즈. 개선기 — 정산을 실무에 가깝게.*

## 0. 정산이 한 줄로 끝나 있었다

[에스크로에 정렬한 정산](/blog/project/pay/pay-39-settlement-escrow-alignment)에서 "구매확정된 결제만 집계한다"까지는 맞췄어요. 그런데 정작 **수수료 계산**을 보니 이랬어요.

```java
private static final long FEE_PERCENT = 3;
// fee = gross * 3 / 100
```

총액의 **3%**를 떼는 게 전부였어요. 실무 정산은 이것보다 한 겹 더 있어요.

> PG/가맹점 정산은 **수수료(정률)** 에 그 **수수료의 부가세 10%** 를 더 떼고, 지급이 **언제** 이뤄지는지(**지급예정일**)까지 계산해요. 예를 들어 승인 100,000원이면 — 수수료 2.7%인 2,700원, 거기에 VAT 270원, 그래서 실지급은 97,030원. 그리고 이 돈은 오늘이 아니라 **정산일+2영업일**에 들어와요.

"3%만 떼기"는 이 셋 중 하나만 있고 둘이 빠진 거였죠. 실무형으로 채웠어요.

## 1. 돈은 정수로 — 수수료율을 bps로

수수료율을 `0.027`(double)로 두고 `gross * 0.027`을 하면 편해 보여요. 근데 이 프로젝트는 [KRW를 소수점 없는 정수(long)로만 다룬다](/blog/project/pay/pay-1-order-payment-core)는 원칙이 있어요. 부동소수를 돈 계산에 끼우면 반올림 오차가 쌓이거든요.

그래서 수수료율을 **basis point(bps)** 로 뒀어요 — 270 bps = 2.7%.

```java
long fee    = Math.multiplyExact(gross, feeBps) / 10000;  // 정수 나눗셈(floor)
long feeVat = fee / 10;                                    // 수수료의 10%
long net    = gross - fee - feeVat;
```

검산해보면 gross=100,000 → fee=2,700 → feeVat=270 → net=**97,030**. 부동소수 없이 정확히 떨어져요. 이 검산값을 테스트로 못박아 뒀어요(`settleFeeModelExactValues`) — 수수료 로직은 한 번 틀어지면 돈이 새니까요.

정산 집계의 불변식도 넓혔어요. 기존 `net = gross - fee`에서 **`net = gross - fee - feeVat`** 로요. 재밌는 건, 마이그레이션에서 레거시 정산은 `feeVat = 0`으로 백필하니 **옛 불변식이 그대로 성립**한다는 거예요 — net을 다시 계산할 필요가 없었죠.

## 2. 지급예정일 = 정산일 + 2영업일

지급예정일은 "정산일 + 2일"이 아니라 "**+2영업일**"이에요. 주말엔 정산 지급이 안 되니까요.

```java
// 하루씩 전진하며 토·일을 건너뛰어 N영업일을 센다
LocalDate payoutDate = BusinessDays.plusBusinessDays(settlementDate, 2);
```

금요일 정산이면 +2영업일은 토·일을 건너뛴 **다음 화요일**이에요. 여기서 정직하게 그은 선이 하나 있어요.

> 이 계산은 **주말만** 건너뛰고 **법정공휴일은 반영하지 않아요.** 진짜 정산이라면 공휴일 캘린더(설·추석·대체공휴일…)를 붙여야 정확하죠. 근데 그건 별도 데이터 소스가 필요한 일이라, 여기선 "주말 skip"까지만 하고 **그 한계를 javadoc과 README에 명시**했어요. "공휴일도 처리한다"고 적고 안 하는 것보다, "여기까지만 했다"를 적는 게 [정직하니까요](/blog/project/pay/pay-42-security-hardening).

## 3. 또 하나의 죽은 배치

여기까지 만들고 "지급 확정"을 붙이려는데, 이상한 걸 발견했어요. **정산을 실제로 만드는 `settle()`을 부르는 사람이 없었어요.**

```
$ grep -rn ".settle(" src/
src/test/.../SettlementServiceTest.java:  service.settle(DATE)   ← 테스트뿐
```

[스케줄러 없던 배치들](/blog/project/pay/pay-40-schedulers)과 **똑같은 패턴**이었어요. 정산 로직은 완성돼 있는데, 운영에서 그걸 주기적으로 부르는 스케줄러도, 수동으로 돌릴 어드민도 없었죠. 정산이 영원히 안 만들어지니 "지급 확정"할 대상도 없고요.

그래서 배선했어요 — 기존 [스케줄러 게이트 패턴](/blog/project/pay/pay-40-schedulers)(기본 off) 그대로 일 단위 스케줄러를 달고, 어드민에 조회·수동실행·지급확정을 뒀어요. 정산 상태에 `PAID_OUT`을 추가하고요.

```java
public void markPaidOut() {
    if (this.status == SettlementStatus.CREATED) {   // 멱등: 이미 PAID_OUT이면 무시
        this.status = SettlementStatus.PAID_OUT;
        this.paidOutAt = Instant.now();
    }
}
```

데모 콘솔에도 정산 패널을 붙여, 승인→구매확정→정산 집계→지급 확정까지 눌러볼 수 있게 했어요.

![정산 데모 — 총액 30,000 → 수수료 810 + VAT 81 → 지급액 29,109, 지급예정일 2영업일 뒤](/uploads/project/pay/demo/demo-settlement.png)

총액 30,000이 수수료 810 + VAT 81을 떼고 **29,109**로, 지급예정일은 2영업일 뒤로 찍혀요. `CREATED`를 "지급 확정"하면 `PAID_OUT`이 되고요. 실 MySQL로 이 흐름 전체를 검증했어요(3건 구매확정 → 집계 → 지급확정 → 항목 SETTLED).

## 4. package-info가 또 거짓말을 했다

마지막은 [README가 QueryDSL·Spring Batch 거짓말을 했던 것](/blog/project/pay/pay-42-security-hardening)의 잔당이었어요. 정산 모듈 `package-info`가 이렇게 적혀 있었거든요.

```java
/** <p>Spring Batch 기반 일 단위 거래 집계 → 수수료 계산 → ... */
```

**Spring Batch를 안 쓰는데** 쓴다고 적혀 있었어요(실제론 서비스 루프). README는 앞서 고쳤는데 package-info는 남아 있던 거죠. "서비스 루프 집계, 대용량은 Spring Batch로 확장 여지"로 사실화했어요. 문서의 거짓말은 한 군데만 있는 게 아니더라고요 — 같은 주장을 여기저기 복붙해뒀으면 다 찾아 고쳐야 해요.

## 마치며

정산은 "수수료 떼면 끝"처럼 보이지만, 실은 **수수료 + 그 수수료의 부가세 + 언제 주느냐**가 다 얽힌 도메인이에요. 한 줄로 뭉뚱그렸던 걸 실무 구조로 풀면서, 돈은 정수로 지키고(bps), 지급일은 영업일로 세고, 못 하는 것(공휴일)은 솔직히 적었어요.

그리고 또 만났죠 — **로직은 있는데 부르는 사람이 없는 배치.** 이 시리즈가 반복해서 보여주는, "만들었다 ≠ 동작한다"의 정산 버전이었어요. 도메인을 정교하게 모델링하는 것과, 그게 **실제 운영 흐름에 배선되어 도는 것**은 끝까지 다른 일이더라고요.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, 수수료·부가세·지급예정일·지급확정(PAID_OUT) 전 흐름을 실 MySQL로 검증했습니다(V11 마이그레이션·검산 100,000→97,030 포함).*

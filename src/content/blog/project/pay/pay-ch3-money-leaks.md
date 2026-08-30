---
title: '정산과 취소: 예외 하나 없이 돈이 새던 곳 다섯'
description: '정산이 총액의 3%만 떼고, 집계 키가 승인일이라 가맹점에 돈을 안 주고, 구매확정 전에 정산되고, 취소가 월렛을 몰랐다. 아무도 에러를 안 냈다.'
date: 2026-08-31T00:00:00.000Z
category: study/pay
coverImage: "/uploads/project/pay/thumbs/pay-ch3.svg"
draft: false
series: "결제 시스템 만들기"
seriesOrder: 4
tags:
  - Payment
  - 정산
  - 정합성
  - 취소
---

*결제 시스템 시리즈 4편. 자금이 걸린 버그만 모았다. 전부 예외 하나 안 나고 조용히 틀리고 있었다.*

## 정산이 "총액의 3%"만 떼고 있었다: 수수료 부가세·지급예정일, 그리고 또 하나의 죽은 배치

### 0. 정산이 한 줄로 끝나 있었다

정산 수수료 계산이 상수 한 줄로 끝나 있었다. [에스크로에 정렬한 정산](/blog/project/pay/pay-ch2-runtime-truths)에서 "구매확정된 결제만 집계한다"까지는 맞췄는데, 정작 수수료 쪽을 열어보니 이랬다.

```java
private static final long FEE_PERCENT = 3;
// fee = gross * 3 / 100
```

총액의 **3%**를 떼는 게 전부다. 실무 정산은 여기서 한 겹 더 들어간다.

> PG/가맹점 정산은 **수수료(정률)** 에 그 **수수료의 부가세 10%** 를 더 떼고, 지급이 **언제** 이뤄지는지(**지급예정일**)까지 계산한다. 예를 들어 승인 100,000원이면 수수료 2.7%인 2,700원, 거기에 VAT 270원이 붙어 실지급은 97,030원이다. 그리고 이 돈은 오늘 바로 들어오지 않는다. **정산일+2영업일**에 들어온다.

"3%만 떼기"는 이 셋 중 하나만 있는 셈이다. 빠진 둘을 채웠다.

### 1. 돈은 정수로, 수수료율을 bps로

수수료율은 **basis point(bps)** 정수로 뒀다. 270 bps가 2.7%다. `0.027`(double)로 두고 `gross * 0.027`을 하는 쪽이 편해 보이지만, 이 프로젝트에는 [KRW를 소수점 없는 정수(long)로만 다룬다](/blog/project/pay/pay-ch1-what-to-trust)는 원칙이 있다. 부동소수를 돈 계산에 끼우면 반올림 오차가 쌓인다.

```java
long fee    = Math.multiplyExact(gross, feeBps) / 10000;  // 정수 나눗셈(floor)
long feeVat = fee / 10;                                    // 수수료의 10%
long net    = gross - fee - feeVat;
```

검산하면 gross=100,000 → fee=2,700 → feeVat=270 → net=**97,030**. 부동소수 없이 떨어진다. 이 검산값은 테스트로 못박아 뒀다(`settleFeeModelExactValues`). 수수료 로직은 한 번 틀어지면 돈이 샌다.

정산 집계의 불변식도 기존 `net = gross - fee`에서 **`net = gross - fee - feeVat`** 로 넓혔다. 마이그레이션에서 레거시 정산은 `feeVat = 0`으로 백필하므로 **옛 불변식이 그대로 성립**하고, net을 다시 계산할 필요도 없었다.

### 2. 지급예정일 = 정산일 + 2영업일

지급예정일은 "정산일 + 2일"로 계산하면 틀린다. 주말엔 정산 지급이 안 되기 때문에 "**+2영업일**"로 세야 한다.

```java
// 하루씩 전진하며 토·일을 건너뛰어 N영업일을 센다
LocalDate payoutDate = BusinessDays.plusBusinessDays(settlementDate, 2);
```

금요일 정산이면 +2영업일은 토·일을 건너뛴 **다음 화요일**이다. 여기서 선을 하나 그었다.

> 이 계산은 **주말만** 건너뛰고 **법정공휴일은 반영하지 않는다.** 실제 정산이라면 공휴일 캘린더(설·추석·대체공휴일…)를 붙여야 맞다. 다만 그건 별도 데이터 소스가 필요한 일이라, 여기선 "주말 skip"까지만 하고 **그 한계를 javadoc과 README에 명시**했다. "공휴일도 처리한다"고 적고 안 하는 것보다 "여기까지만 했다"를 적는 쪽이 [정직하다](/blog/project/pay/pay-ch2-runtime-truths).

### 3. 또 하나의 죽은 배치

여기까지 만들고 "지급 확정"을 붙이려다 이상한 걸 발견했다. **정산을 실제로 만드는 `settle()`을 부르는 코드가 없었다.**

```
$ grep -rn ".settle(" src/
src/test/.../SettlementServiceTest.java:  service.settle(DATE)   ← 테스트뿐
```

[스케줄러 없던 배치들](/blog/project/pay/pay-ch2-runtime-truths)과 같은 패턴이다. 정산 로직은 완성돼 있는데, 운영에서 그걸 주기적으로 부르는 스케줄러도 수동으로 돌릴 어드민도 없었다. 정산이 영원히 안 만들어지니 "지급 확정"할 대상도 없다.

그래서 배선했다. 기존 [스케줄러 게이트 패턴](/blog/project/pay/pay-ch2-runtime-truths)(기본 off) 그대로 일 단위 스케줄러를 달고, 어드민에 조회·수동실행·지급확정을 뒀다. 정산 상태에는 `PAID_OUT`을 추가했다.

```java
public void markPaidOut() {
    if (this.status == SettlementStatus.CREATED) {   // 멱등: 이미 PAID_OUT이면 무시
        this.status = SettlementStatus.PAID_OUT;
        this.paidOutAt = Instant.now();
    }
}
```

데모 콘솔에도 정산 패널을 붙여, 승인→구매확정→정산 집계→지급 확정까지 눌러볼 수 있게 했다.

![정산 데모: 총액 30,000 → 수수료 810 + VAT 81 → 지급액 29,109, 지급예정일 2영업일 뒤](/uploads/project/pay/demo/demo-settlement.png)

총액 30,000이 수수료 810 + VAT 81을 떼고 **29,109**로, 지급예정일은 2영업일 뒤로 찍힌다. `CREATED`를 "지급 확정"하면 `PAID_OUT`이 된다. 실 MySQL로 이 흐름 전체를 검증했다(3건 구매확정 → 집계 → 지급확정 → 항목 SETTLED).

### 4. package-info가 또 거짓말을 했다

마지막은 [README가 QueryDSL·Spring Batch 거짓말을 했던 것](/blog/project/pay/pay-ch2-runtime-truths)의 잔당이다. 정산 모듈 `package-info`가 이렇게 적혀 있었다.

```java
/** <p>Spring Batch 기반 일 단위 거래 집계 → 수수료 계산 → ... */
```

**Spring Batch를 안 쓰는데** 쓴다고 적혀 있었다(실제론 서비스 루프). README는 앞서 고쳤는데 package-info엔 같은 주장이 남아 있던 것. "서비스 루프 집계, 대용량은 Spring Batch로 확장 여지"로 사실화했다. 문서의 거짓말은 한 군데에서 끝나지 않는다. 같은 주장을 여러 곳에 복붙해뒀다면 전부 찾아 고쳐야 한다.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있다. 수수료·부가세·지급예정일·지급확정(PAID_OUT) 전 흐름을 실 MySQL로 검증했다(V11 마이그레이션·검산 100,000→97,030 포함).*

---

## 정산이 조용히 가맹점에 돈을 안 주고 있었다: 집계 키가 승인일이던 버그, 그리고 같은 날만 확정하던 테스트

### 0. "더 있나?" 하고 다시 봤더니

여기까지 하고 다 됐다 싶었다. 그 "다 됐다"를 의심하며 코드베이스를 결제 도메인 리뷰어의 눈으로 한 번 더 훑었는데, 정산에서 조용한 버그가 나왔다. 에러도 안 나고 테스트도 초록불인데 **가맹점에 돈이 안 나가는** 버그다. [정산을 에스크로에 정렬](/blog/project/pay/pay-ch2-runtime-truths)하고 수수료·부가세·지급예정일까지 고도화한 바로 그 정산에서.

### 1. 집계 키가 잘못된 날짜였다

정산 배치의 핵심은 이 한 줄이다.

```java
itemRepository.findByStatusAndConfirmedDate(CONFIRMED, date);
// "그 date에 CONFIRMED된 정산 항목"을 집계
```

`status == CONFIRMED` 그리고 `confirmedDate == date` 둘 다 맞는 항목을 모은다. 문제는 이 `confirmedDate`의 정체였다.

```java
// 적재 시점(결제 승인 이벤트)
LocalDate confirmedDate = LocalDate.ofInstant(event.approvedAt(), UTC);  // ← 승인일
```

이름은 `confirmedDate`("구매확정일")인데 실제로 담긴 건 **승인일**이었다. 항목이 `CONFIRMED`(정산 가능)로 바뀌는 건 [에스크로 릴리스(구매확정)](/blog/project/pay/pay-0-overview) 시점인데, 그 전이가 `confirmedDate`를 **재스탬프하지 않았다.**

이게 치명적인 이유는 **에스크로가 며칠 홀드되기 때문이다**(기본 7일).

> 결제가 D일에 승인 → 항목 적재(`confirmedDate = D`, PENDING). D+1일에 `settle(D)` 배치가 도는데, 이 항목은 아직 PENDING이라 제외된다. **D+7일**에 에스크로가 릴리스되어 CONFIRMED가 되지만 `confirmedDate`는 **여전히 D.** 그런데 `settle(D)`는 D+1에 이미 실행됐고, 재실행은 멱등하게 skip된다(그 날짜 정산이 이미 있으니까). 스케줄러는 매일 `settle(어제)`만 돌지 과거를 다시 돌지 않는다.
>
> 결과적으로 이 항목은 **CONFIRMED인 채로 영원히 집계되지 않는다.** "그 날짜에 CONFIRMED된 항목"이라는 조건을 어떤 배치도 만족시키지 못한다. `settle(D)`가 돌 땐 PENDING이었고, `settle(D+7)`엔 `confirmedDate`가 안 맞는다. **가맹점은 돈을 못 받는다.**

무서운 대목은 따로 있다. 에스크로 홀드가 본질적으로 며칠짜리라, 이건 **거의 모든 항목이 타는 기본 경로**다. "구매확정 시점 정산"을 하겠다던 [바로 그 리워크](/blog/project/pay/pay-ch2-runtime-truths)가 정작 지급을 막고 있었다.

### 2. 내 테스트는 왜 못 잡았나

더 뼈아픈 쪽은 테스트다. 정산 테스트의 헬퍼가 이랬다.

```java
private static SettlementItem confirmedItem(...) {
    SettlementItem item = SettlementItem.of(..., DATE);  // 승인일 = DATE
    item.confirm();                                       // 곧바로 확정
    return item;                                          // confirmedDate == DATE
}
```

**승인하자마자 같은 날 확정**하니 `confirmedDate`와 `settle` 대상 날짜가 늘 일치했다. 그래서 모든 테스트가 통과했다. 하지만 "승인하자마자 같은 날 구매확정"은 실제로는 거의 안 일어난다. 에스크로가 며칠 홀드하기 때문이다.

> 테스트가 "승인일 == 확정일"이라는, 현실에선 드문 조건에서만 돌아 버그를 통째로 가렸다. [실기동 검증](/blog/project/pay/pay-ch2-runtime-truths) 때도 나는 결제 후 **바로** 구매확정을 눌렀으니 그때도 우연히 통과했다. 승인과 확정 사이의 **시간 간격**이라는 정산의 본질을, 테스트도 나도 좁혀서 보고 있었다.

### 3. 고침: 확정일로 재스탬프

집계 키를 승인일에서 **구매확정(릴리스)일**로 바꿨다. 마침 `EscrowReleasedEvent`가 릴리스 시각을 담고 있었다.

```java
public void confirm(LocalDate settlementReadyDate) {
    if (this.status == PENDING_CONFIRMATION) {
        this.status = CONFIRMED;
        this.confirmedDate = settlementReadyDate;   // ← 릴리스일로 재스탬프
    }
}
```

```java
void onEscrowReleased(EscrowReleasedEvent event) {
    LocalDate releaseDate = LocalDate.ofInstant(event.releasedAt(), UTC);
    settlementService.confirmSettlement(event.orderNo(), releaseDate);
}
```

이제 릴리스일 R로 재스탬프되니 **R+1의 `settle(R)`이 이 항목을 집계**한다. 필드 이름도 이 수정으로 바로잡혔다. `confirmedDate`가 이름대로 "구매확정일"이 됐다(전엔 이름과 달리 승인일이었다).

회귀 테스트도 심었다. 승인 D일 적재 → D+7 릴리스 → **릴리스일 배치가 잡는지**. 누가 다시 승인일로 되돌리면 빨간불이 뜬다.

실 MySQL로 확인했다.

```
승인일 backdate(2026-06-01) → PENDING (confirmed_date=2026-06-01)
구매확정(에스크로 릴리스) → CONFIRMED, confirmed_date=2026-07-07 (재스탬프!)
settle(2026-07-07) → 집계 → SETTLED, 정산 생성(net 9,703)
```

승인일이 6월 1일이던 항목이 릴리스 시 오늘로 재스탬프되어 오늘 배치에 잡힌다.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있다. 승인일 backdate → 릴리스 재스탬프 → 릴리스일 배치 집계까지 실 MySQL로 검증했다.*

---

## 구매확정 전에 정산되고 있었다: 죽은 이벤트가 가리킨 도메인 모순

구독자 없이 죽어 있던 건 Kafka 토픽만이 아니었다. 코드베이스를 전수 감사하다 구독자 0인 `EscrowReleasedEvent`를 발견했고, 그 끝에는 두 모듈이 "돈이 언제 판매자 것이 되는가"를 정반대로 알고 있던 도메인 모순이 있었다.

### 0. 감사가 이상한 걸 짚었다

기능이 거의 다 완성된 뒤 코드베이스를 전수 감사했다. "시스템이 암묵적으로 가정하는 것"을 다 찾아내자는 취지였다. 17건이 나왔는데 그중 하나가 유독 걸렸다.

> **[3] 정산이 에스크로와 분리**: 정산 적재가 `PaymentConfirmedEvent`(승인 즉시)에서 일어나고, `EscrowReleasedEvent`는 **구독자 0**(죽은 이벤트). "구매확정 전 보류"가 정산에 미반영.

읽고 나서 "아…" 했다. [에스크로 편](/blog/project/pay/pay-0-overview)에서 분명히 이렇게 만들었다. 결제금을 구매확정 전까지 HELD로 보류하고, 구매자가 확정하면 RELEASED로 풀어 정산 가능하게. 자금이 판매자 것이 되는 건 구매확정 시점이라고.

그런데 [정산 모듈](/blog/project/pay/pay-ch1-what-to-trust)은 그걸 몰랐다. `PaymentSettlementListener`가 결제 승인 이벤트를 받아, 승인되자마자 정산 항목을 쌓고 있었다.

> 에스크로는 "구매확정 전엔 못 준다"고 하는데, 정산은 "승인됐으니 지급 목록에 올린다"고 하고 있었다. 같은 시스템 안에서 두 모듈이 "돈이 언제 판매자 것이 되는가"를 정반대로 알고 있었다.

그 증거가 죽은 이벤트였다. 구매확정 시 `EscrowReleasedEvent`를 발행하는데, [grep해보니 구독자가 아무도 없었다.](/blog/project/pay/pay-ch2-runtime-truths) "향후 정산 파이프라인이 구독한다"는 주석만 남긴 채, 아무도 듣지 않는 이벤트를 계속 던지고 있었다.

### 1. "돈은 언제 판매자 것이 되는가"

결제 도메인에서 가장 중요한 질문 중 하나다. 마켓플레이스라면 특히 그렇다.

- 너무 일찍 (승인 시점) 정산하면 → 미배송·분쟁 때 [이미 나간 돈을 회수 못 한다](/blog/project/pay/pay-0-overview).
- 그래서 에스크로가 있는 거고, 정산은 구매확정(에스크로 릴리스)에 맞춰야 한다.

정답은 명확했다. 정산의 트리거를 승인에서 구매확정으로 옮기는 것. 죽어 있던 `EscrowReleasedEvent`를 정산이 구독하게 하면 된다.

### 2. 정산 항목에 생명주기를 주다

기존 정산 항목의 상태는 `PENDING → SETTLED` 둘뿐이었다. 여기에 "구매확정" 관문을 끼워 넣었다.

```
PENDING_CONFIRMATION   승인됨 · 구매확정 대기 (아직 지급 대상 아님)
       ↓ EscrowReleasedEvent
CONFIRMED              구매확정됨 · 정산 가능
       ↓ 일 단위 배치
SETTLED               집계·지급됨
       (전액취소 시) → CANCELED
```

핵심은 세 곳이다.

**(1) 승인 → PENDING_CONFIRMATION.** 승인 이벤트는 여전히 정산 항목을 만들지만, 이젠 "대기" 상태로 만든다. 이 시점엔 아직 지급 대상이 아니다.

**(2) 구매확정 → CONFIRMED.** 정산이 `EscrowReleasedEvent`를 구독해서 그 주문의 항목을 CONFIRMED로 전이시킨다. 죽었던 이벤트가 드디어 제 일을 한다.

```java
@ApplicationModuleListener
void onEscrowReleased(EscrowReleasedEvent event) {
    settlementService.confirmSettlement(event.orderNo());   // PENDING_CONFIRMATION → CONFIRMED
}
```

**(3) 배치는 CONFIRMED만 집계.** 일 단위 정산 배치가 `PENDING` 대신 `CONFIRMED`만 합산한다. 구매확정 안 된 `PENDING_CONFIRMATION` 항목은 지급에서 자동으로 빠진다. "구매확정 전 보류"가 실제 동작으로 정산에 반영되는 지점이다.

실기동으로 확인했다.

```
승인 후        → settlement_items: PENDING_CONFIRMATION  (보류)
구매확정 후    → settlement_items: CONFIRMED             (정산 가능!)
전액취소       → settlement_items: CANCELED              (정산 제외)
부분취소 3000  → settlement_items: amount 7000           (역반영)
```

### 3. 취소는 정산에 어떻게 반영하나: 정직한 한계

정산은 취소 이벤트도 구독하게 했다(`PaymentCanceledEvent`). 그런데 여기 미묘한 경우들이 있다.

- **확정 전 전액취소** → 항목을 `CANCELED`로. 애초에 지급 안 됨.
- **확정 전 부분취소** → 항목 amount를 줄임.
- **이미 SETTLED(집계·지급됨) 뒤 취소** → …?

마지막 경우가 어렵다. 이미 판매자에게 지급 목록으로 나간 걸 정산 항목에서 되돌리면 회계가 어긋난다. 그래서 되돌리지 않기로 했다.

> 이미 SETTLED된 항목에 취소가 오면 금액을 건드리지 않고 `settlement.postsettle.cancel` 카운터만 올린다(운영이 별도 정산 조정으로 처리). 실무에선 이걸 다음 배치의 음수 조정(clawback)으로 반영한다. 지금은 그 신호까지만 남기고, "정산은 재구성 가능한 집계이고 취소의 진짜 이력은 [원장 역분개](/blog/project/pay/pay-0-overview)가 보유한다"는 판단을 주석에 명시했다.

측정을 부풀리지 않았듯([데드락 편 각주처럼](/blog/project/pay/pay-0-overview)), 처리 못 하는 케이스도 "못 한다"고 표시하는 쪽을 택했다. 조용히 틀리게 처리하는 것보다 낫다.

### 4. 경계는 여기서도 단방향

정산이 에스크로 이벤트를 구독하니 `settlement`가 `escrow`에 의존한다. 방향을 확인했다. settlement → escrow 단방향이다. 에스크로는 정산을 모른다(자기 이벤트만 던질 뿐). [모듈 경계](/blog/project/pay/pay-0-overview)를 CI가 강제하니 순환이 생겼으면 빌드가 깨졌을 텐데, 통과했다.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, 승인→보류→구매확정→확정→취소 반영을 실 MySQL로 검증했다.*

---

## 취소가 월렛을 몰랐다: 신규 코드 정밀 감사에서 잡은 자금 버그들

### 0. 기능을 늘렸으면, 그 코드를 의심해야 한다

결과부터. [회원](/blog/project/pay/pay-0-overview)·[분쟁/차지백](/blog/project/pay/pay-0-overview)·[월렛 배선](/blog/project/pay/pay-0-overview)까지 확정 기능을 다 만든 뒤 바로 그 신규 코드를 정면으로 감사했고, **치명 2건 포함 자금·보안 버그 11건**이 나왔다. 지난 감사들이 매번 실 자금 버그를 잡아왔으니, 돈과 인증을 새로 건드린 코드가 무사할 리 없다고 봤는데 역시나였다. 하나씩 보면 전부 "기능은 각자 옳은데, 만나는 지점이 틀린" 종류였다.

### 1. [치명] 취소가 월렛을 몰랐다: 환불 증발

라이브로 재현부터 했다. 주문 20,000원을 카드 14,000 + 월렛 6,000으로 결제하고 취소하면:

```
전액취소 20,000 → CANCEL_AMOUNT_EXCEEDED "잔여 14,000"   (전액취소 자체가 불가)
카드몫만 14,000 취소 → fullyCanceled:true, 주문 CANCELED
월렛 잔액 → 그대로. REFUND 이력 없음. 6,000원 증발.
```

원인은 단순하다. `CancelService`가 환불 재원을 **포인트와 카드만** 조회했다. 월렛은 의존성에도 없었다. 월렛을 결제수단으로 배선할 때 사가(승인 실패 보상)는 챙겼는데, **완료된 결제의 취소 경로**는 빠뜨린 것이다. 전액 월렛 결제 주문은 아예 취소가 불가능했다.

수정은 배분기를 3-way로 확장하는 것.

```java
// 포인트 → 월렛 → 카드 순. 내부 재원(무상 지급 가능성이 있는 것)부터 환불해야
// 카드 환불로 포인트·선불충전분을 현금화하는 어뷰징을 막는다.
RefundAllocation alloc = RefundAllocator.allocate(cancelAmount, paidByPoint, paidByWallet, paidByCard);
```

전액취소 판정(`fully`)도 세 재원 합 기준으로 고쳤다. 재현 시나리오를 다시 돌리면 이제 `refundedWallet:6000`, 월렛 잔액 원복, USE/REFUND 상쇄까지 확인된다.

> **결제수단을 추가하면 그 수단의 전체 수명주기**(예약→확정→취소→복구)를 따라가야 한다. 성공 경로와 사가 보상만 배선하고 끝내면, 취소가 그 수단의 존재를 모른다.

### 2. [치명] 멱등 장치가 공짜 결제를 만들었다

두 번째는 더 미묘하다. 체크아웃 사가는 카드 거절 시 선점한 포인트·월렛을 되돌리고 주문을 `PENDING_PAYMENT`로 복귀시킨다. **재시도하라는 뜻이다.** 그런데:

1. 1차 시도: 월렛 6,000 차감(USE) → 카드 거절 → 월렛 6,000 환불 → 주문 PENDING 복귀
2. 2차 시도(같은 주문): 월렛 차감이 `existsByOrderNoAndType(orderNo, USE)`를 보고 **"이미 차감했네" → skip**
3. 카드 승인 → 주문 PAID. **월렛 몫 6,000은 아무도 안 낸 돈.**

사가 재진입(크래시 복구)의 이중차감을 막으려고 넣은 멱등이, 거절 후 재시도 시나리오에서는 **환불로 죽은 예약을 살아있다고 착각**한 것이다. 한도초과 카드로 1차 거절을 유도하면 누구나 재현할 수 있는 구멍이었다.

수정의 핵심은 멱등의 질문을 바꾸는 것.

```java
// "이미 차감했는가?"(exists)가 아니라 "활성 예약이 남아 있는가?"(순액)
if (refundableAmount(orderNo) > 0) {   // USE − RESTORE − REFUND
    return balance(userId);            // 예약 살아있음 → skip
}
// 예약이 해제됐으면(거절 보상) 재시도 시 다시 차감된다
```

그리고 월렛에 **RESTORE**(사가 보상, 멱등)와 **REFUND**(취소 환불, 부분취소 다회라 비멱등)를 분리했다. 포인트가 원래 쓰던 검증된 계약과 대칭이 되도록. 동시 요청의 이중차감은? 같은 주문의 confirm은 `Order.startPayment()`의 `@Version`이 이미 직렬화하니, check-then-act가 원자적이지 않아도 안전하다.

> **멱등 키의 수명은 예약의 수명과 같아야 한다.** "한 번 기록되면 영원히 skip"은 보상 트랜잭션이 있는 세계에서는 틀린 모델이다.

### 3. [높음] 취소로 포인트 파밍: 적립 회수 부재

[포인트 적립](/blog/project/pay/pay-0-overview)을 만들 때 취소를 잊었다. 100,000원 결제 → 1,000P 적립 → 전액취소(카드 100% 환불) → **적립은 그대로.** 반복하면 무비용 포인트 파밍이다.

취소가 실결제 회수분만큼 적립을 회수하게 했다(`EARN_REVERSAL`). 디테일이 둘 있다.

- **적립분 상한 캡**: 부분취소가 여러 번 와도 적립보다 많이 회수하지 않게 `min(요청, EARN−EARN_REVERSAL)`.
- **음수 잔액 허용**: 이미 적립분을 써버렸어도 회수를 관철해야 파밍이 막힌다. 음수분(적립 채무)은 이후 적립으로 상계된다.

### 4. 분쟁 쪽: 입력을 믿은 죄

분쟁/차지백 모듈은 상태기계와 원장 멱등은 견고했는데, **입력 검증**이 구멍이었다.

- **amount 무검증**: 웹훅 `amount` 누락/문자열이면 Jackson `asLong()`이 조용히 0을 준다. amount=0 분쟁이 생기고, 패소 확정 시 원장 분개가 "금액은 양수" 검증에 걸려 **아웃박스 이벤트가 영구 실패**한다(포이즌). 개시 시점에 양수 가드를 넣었고, 라이브로 amount=0 웹훅이 분쟁 0건인 걸 확인했다.
- **원 결제 미대조**: 존재하지 않는 orderNo, 원 결제보다 큰 금액의 차지백도 그대로 분쟁이 됐다. 어드민이 (PG를 믿고) 패소 확정하는 순간 **실존하지 않는 매출에 역분개**가 찍힌다. 개시 시 승인 완료 결제 실존 + 금액 상한을 대조하게 했다.
- **위험한 기본값**: resolve가 `"WON".equalsIgnoreCase(outcome)`라, 오타든 null이든 **"WON"이 아니면 전부 LOST(비가역 역분개)**였다. WON/LOST 외에는 400으로 거부하게 했다. 라이브로 `"WIN"` 오타가 400, 상태 OPEN 유지 확인.
- **동시 승패 확정**: `@Version`이 없어 두 어드민이 동시에 WON/LOST를 확정하면 최종 상태는 WON인데 LOST 이벤트가 이미 발행될 수 있었다(승소에 역분개). 낙관적 락을 추가했다.

### 5. 인증 쪽: BCrypt가 무기가 된다

login/signup에 rate limit이 전혀 없었다. 두 경로는 요청마다 BCrypt(~110ms CPU)를 태우니, 미인증 공격자에게 **비대칭 DoS**가 된다. 공격자는 요청 한 번으로 서버 CPU 110ms를 강제로 태운다. 알려진 이메일에 비밀번호를 무제한 시도하는 크리덴셜 브루트포스도 열려 있었다. 기존 유입제어(`RateLimitFilter`)는 인증된 쓰기 경로만 막고 미인증은 그냥 통과시켰기 때문이다.

login/signup을 **클라이언트 IP 기준**으로 제한하게 했다. 그런데 여기서 이 방어 코드가 **다시 감사에 걸렸다.** IP를 `X-Forwarded-For` 헤더에서 읽었는데, 그건 클라이언트가 위조·회전할 수 있어 per-IP 한도를 우회할 수 있다. 헤더 신뢰를 걷어내고 소켓 피어(`getRemoteAddr`)만 쓰고, 프록시 뒤 배포는 `forward-headers-strategy`로 신뢰된 프록시에서만 실 IP를 대입하게 문서화했다. 분산 IP 공격은 global 한도가 backstop한다.

여기에 회원 가입 동시성 시 유니크 위반이 500으로 새던 것도 409(EMAIL_ALREADY_EXISTS)로 매핑했다.

> **방어 코드를 짤 때도 신뢰 경계를 착각하면 그게 곧 구멍이 된다.** rate limit을 붙이면서 "클라이언트가 준 IP"를 믿으면, 막으려던 우회를 스스로 열어주는 셈이다.

---

## 돈은 나갔는데 주문이 사라지면: 승인 후 재고 부족과 자동 망취소

두 번째 숙제는 보상이다. 카드 승인은 성공했는데 재고 차감이 실패하면 DB 롤백으로는 되돌릴 수 없다. PG에서 이미 일어난 승인은 롤백되지 않기 때문이다. 이 틈을 자동 망취소, 즉 성공할 때까지 재시도하는 보상 트랜잭션으로 메웠다.

### 0. 남겨둔 한 줄

승인 흐름을 만들 때 `CheckoutService`엔 이런 주석이 있었다.

```java
// 차감 실패(품절 경합)는 예외 → 이후 망취소/보상 트랜잭션으로 승격.
```

미뤄둔 데는 이유가 있다. 이게 결제 시스템에서 **가장 위험한 순간** 중 하나이기 때문이다.

### 1. 위험한 순간: 승인 성공 → 재고 부족

주문 승인의 순서를 다시 보자.

1. 포인트 선점
2. **카드 승인** (외부 PG 호출)
3. 재고 차감
4. 주문 PAID

문제는 2와 3 사이다. **카드는 이미 승인됐는데(2), 재고 차감(3)이 품절 경합으로 실패**하면 어떻게 될까?

원래 코드는 재고 차감 실패 시 예외를 던졌고, `@Transactional`이 전부 롤백했다. 그런데 여기에 무서운 구멍이 있다.

> `@Transactional`이 롤백하는 건 **DB뿐**이다. 하지만 2번의 카드 승인은 **PG(외부 시스템)에서 이미 일어났다.** DB를 롤백해도 PG의 승인은 되돌아오지 않는다. 결과는 **고객 카드에서는 돈이 빠져나갔는데 우리 DB엔 주문이 없는** 상태. 고객 입장에선 "결제했는데 아무것도 못 받은" 최악의 경험이다.

이게 분산 트랜잭션의 본질적 문제다. 우리 DB와 PG는 **한 트랜잭션으로 묶을 수 없다.** 그래서 "둘 중 하나가 이미 커밋됐는데 다른 하나가 실패"하는 순간은 **보상(compensation)**으로 풀어야 한다. 롤백으로는 풀 수 없다.

### 2. 해법: 롤백 대신 자동 망취소

방향을 바꿨다. 재고 차감이 실패하면 롤백하지 않는다. 대신 이미 승인된 카드를 **취소(망취소)**하는 걸로 되돌린다.

그런데 망취소도 PG 호출이라 **또 실패할 수 있다.** 네트워크가 끊길 수도, PG가 잠깐 죽었을 수도 있다. 그래서 망취소는 지금 한 번 시도하고 끝내는 대신, **durable하게 적재해두고 성공할 때까지 재시도**하는 구조로 만들었다. 이게 `compensation_tasks` 테이블이다. outbox 패턴의 사촌이다.

흐름은 이렇다.

```
카드 승인 성공 → 재고 차감 시도 → 실패(품절)
  ├─ 이미 차감된 재고가 있으면 원복
  ├─ 선점한 포인트 복원 (내부 자원 — 즉시·확실)
  ├─ compensation_tasks에 "이 카드 망취소해" 태스크 적재
  ├─ 주문 FAILED
  └─ 트랜잭션 커밋 (승인된 결제 + 보상 태스크가 함께 남는다)

[스케줄러] PENDING 태스크를 주기적으로 집어
  → PG 망취소 호출
     ├─ 성공 → DONE
     └─ 실패 → 재시도 카운트++ , 지수 백오프로 다음 시도 예약
        └─ 재시도 소진 → FAILED (운영 개입 알림)
```

핵심은 **"내부적이고 확실한 것"과 "외부적이고 불확실한 것"을 나눈** 것이다. 포인트 복원은 우리 DB 안이라 즉시 확실하게 처리하고, PG 망취소만 durable 재시도 큐로 뺐다. 불확실한 것만 재시도 인프라에 태우는 구조다.

### 3. 진짜 함정: 잡은 예외가 트랜잭션을 오염시킨다

여기서 예상 못 한 벽에 부딪혔다. 처음엔 이렇게 짰다.

```java
try {
    stockDeductionService.deductConditional(productId, qty); // 실패 시 OrderException 던짐
} catch (OrderException e) {
    // 보상 처리...
    compensationService.enqueueNetworkCancel(...);
    order.markFailed();
    // 예외를 안 던지고 정상 리턴 → 커밋되겠지?
}
```

"예외를 잡아서 삼켰으니 트랜잭션은 커밋되겠지" 했는데 **안 됐다.** 최종 커밋에서 `UnexpectedRollbackException`이 터지고, 보상 태스크 적재까지 다 롤백됐다.

원인은 Spring 트랜잭션의 미묘한 규칙이다.

> `deductConditional`은 `@Transactional` 메서드고, 바깥 트랜잭션에 **참여(join)**한다. 이게 예외를 던지는 순간, Spring은 **공유 트랜잭션을 rollback-only로 표시**한다. 바깥에서 그 예외를 잡아도 트랜잭션은 이미 "이건 무조건 롤백"으로 낙인이 찍힌 상태다. 그래서 커밋 시도가 `UnexpectedRollbackException`으로 실패한다.

**"잡았다"고 없던 일이 되는 게 아니다.** 참여 트랜잭션 안에서 던져진 예외는 잡아도 전체를 오염시킨다.

해법은 애초에 **예외를 던지지 않는 것**이었다. 조건부 차감을 boolean으로 바꾼 `tryDeduct`를 새로 만들었다.

```java
/** 예외 없는 조건부 차감 — 성공 true, 재고부족 false. */
@Transactional
public boolean tryDeduct(long productId, int qty) {
    return stockRepository.deductConditionally(productId, qty) > 0;
}
```

이제 체크아웃 경로는 예외 대신 **boolean 분기**로만 흐른다. 트랜잭션을 오염시키는 예외가 없으니 보상 상태(승인된 결제 + 보상 태스크)가 온전히 함께 커밋된다. 기존 `deductConditional`(예외 버전)은 다른 호출부를 위해 그대로 뒀다.

"예외를 잡으면 안전하다"는 직관이 트랜잭션 경계 안에서는 틀린다. 문서로 아는 것과 커밋이 터지는 걸 눈으로 보는 건 달랐다.

### 4. 무한 재시도를 막는 멱등

재시도 구조엔 함정이 하나 더 있다. 망취소를 재시도하다가, 이미 다른 경로로 취소된 결제를 또 취소하려 하면? 이 프로젝트의 취소는 "성공한 결제가 없으면 `PAYMENT_NOT_FOUND`"를 던진다. 이걸 실패로 처리하면 **영원히 재시도**하게 된다. 이미 취소된 걸 계속 취소하려고.

그래서 이렇게 처리했다.

```java
} catch (PaymentException e) {
    if ("PAYMENT_NOT_FOUND".equals(e.code())) {
        task.markDone();   // 취소할 게 없다 = 이미 보상됨 → 완료로 간주(멱등)
    } else {
        throw e;           // 그 외 예외만 재시도 대상
    }
}
```

"취소할 결제가 없다"는 건 **이미 목적이 달성된 상태**다. 실패로 볼 이유가 없다. 보상 작업에서 멱등성은 이렇게 "재시도해도 같은 결과"를 보장하는 안전장치다.

### 5. 소진하면 멈추고 알린다

지수 백오프로 재시도하되, `maxRetries`(5회)를 넘으면 태스크를 `FAILED`로 두고 **더는 자동 재시도하지 않는다.** 대신 `compensation.exhausted` 카운터를 올린다.

```java
if (task.isExhausted()) {
    meterRegistry.counter("compensation.exhausted").increment(); // 알림 룰의 소스
}
```

무한 재시도는 그 자체가 장애를 키운다(죽은 PG를 계속 때리기). 그래서 "자동으로 될 만큼 해보고, 안 되면 사람을 부른다"로 경계를 그었다. 이 카운터가 0보다 크면 운영이 개입해야 한다는 신호다. [운영 관측성 편](/blog/project/pay/pay-ch1-what-to-trust)에서 만든 메트릭 기반 알림의 연장선이다.

스케줄러 자체는 `app.compensation.enabled` 프로퍼티로 켜고 끈다. 기본은 꺼둬서 테스트·로컬 부팅에 부작용이 없고, 운영에서만 환경변수로 켠다. [복구 배치](/blog/project/pay/pay-ch1-what-to-trust)와 같은 방식이다. 배치 로직은 순수 메서드로 두고 테스트는 직접 호출한다.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, 보상 흐름은 14개의 단위 테스트로 검증했다.*

---

## 남는 생각

다섯 개 다 **예외를 던지지 않았다.** 로그도 안 남았다. 수수료는 계산됐고, 정산은 실행됐고, 취소는 성공했다. **숫자만 틀렸다.**

결제에서 제일 무서운 실패가 이거다. 터지면 알림이 오지만, **조용히 틀리면 아무도 모른 채 장부에 남는다.** 그래서 대사가 최종 방어선이고, 복식부기가 수학으로 증명하는 층이 필요했다.

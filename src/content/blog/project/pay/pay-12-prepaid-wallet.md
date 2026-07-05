---
title: '선불 월렛 — 잔액을 덮어쓰지 않는다, 그리고 전금법 한도를 코드로'
titleEn: "A Prepaid Wallet — Never Overwrite the Balance, and Encode the Law's Limit in Code"
description: 결제 시스템 확장 4. 페이머니 같은 선불 충전 월렛을 만든다. 핵심 둘 — 잔액을 UPDATE로 덮어쓰지 않고 이력을 남기는 원장 발상(마이너스 잔액·이중차감을 원천 차단), 그리고 전자금융거래법의 기명 200만원 한도를 도메인 규칙으로 코드에 박는 것. 동시 차감 정합성은 조건부 UPDATE로 실측 증명한 기법과 등가다.
descriptionEn: "Payment system extension 4. Building a prepaid wallet like a pay-money balance. Two key ideas — a ledger mindset that appends history instead of overwriting the balance (structurally blocking negative balances and double-spends), and encoding the Electronic Financial Transactions Act's KRW 2M named-account limit as a domain rule. Concurrent-deduction integrity is equivalent to the conditional-UPDATE technique proven empirically earlier."
date: 2026-07-17T00:00:00.000Z
tags:
  - Payment
  - Wallet
  - Ledger
  - Concurrency
  - Fintech
  - Regulation
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 12
---

*결제 시스템 시리즈. 확장 4편 — 선불 월렛.*

## 0. 잔액을 "덮어쓰면" 안 되는 이유

페이머니, 카카오페이머니 같은 선불 충전 월렛. 순진하게 만들면 `UPDATE wallet SET balance = ? WHERE ...`로 잔액을 덮어써요. 그런데 이건 **금융에서 하면 안 되는** 짓이에요.

> 잔액을 덮어쓰면 "언제, 왜, 얼마가 바뀌었는지" 이력이 사라져요. 그리고 동시성에서 read-modify-write 경합으로 잔액이 틀어질 수 있죠. 그래서 [Phase 4의 원장](/blog/project/pay/pay-4-ledger-settlement-reconciliation)처럼, **잔액을 덮어쓰는 게 아니라 이동 이력을 append**해요.

`WalletTransaction`(CHARGE/USE/REFUND)이 append-only로 쌓이고, 잔액은 그 파생값이에요. 실무에선 조회 성능을 위해 잔액을 materialized 컬럼으로 두되(+ 낙관적 락), 진실의 원천은 이력이에요.

## 1. 마이너스 잔액은 "만들어질 수 없다"

월렛의 제1 불변식은 **"잔액은 음수가 될 수 없다"**예요. 이걸 두 겹으로 지켜요.

```java
public void use(long amount) {
    if (amount < 0) throw new WalletException("INVALID_AMOUNT", ...);
    if (balance < amount) throw new WalletException("INSUFFICIENT_BALANCE", ...);
    this.balance -= amount;
}
```

그리고 동시성에서는 낙관적 락(`@Version`) + 충돌 시 재시도로 이중차감을 막아요. 이 기법의 정합성 — **동시에 여러 번 차감해도 이중차감·마이너스 잔액이 0건** — 은 [Phase 5의 락 비교 실험](/blog/project/pay/pay-5-lock-comparison)에서 이미 실측했어요. 거기서 조건부 UPDATE(`WHERE balance >= ?`)가 원자적으로 "충분할 때만 차감"하는 걸 실제 스레드로 증명했고, 월렛은 같은 원자 차감 원리를 써요.

> 재밌게도 재고 차감(stock)과 월렛 차감(wallet)은 **완전히 같은 동시성 문제**예요 — "한 자원에서 여러 요청이 동시에 빼가는데 음수가 되면 안 된다." 그래서 [락 비교](/blog/project/pay/pay-5-lock-comparison)에서 고른 조건부 UPDATE 전략이 그대로 적용돼요.

## 2. 전금법 한도를 코드에 박는다

선불 월렛은 **규제 도메인**이에요. 전자금융거래법상 선불전자지급수단의 발행한도가 있어요 — **무기명 50만원, 기명 200만원.** 카카오페이머니 보유한도 200만원이 이 법에서 나와요.

이 규제를 도메인 규칙으로 코드에 박았어요.

```java
private static final long MAX_BALANCE = 2_000_000;  // 전금법 기명 한도

public void charge(long amount) {
    if (amount < 0) throw ...;
    if (balance + amount > MAX_BALANCE) {
        throw new WalletException("LIMIT_EXCEEDED", "충전 한도(200만원)를 초과합니다.");
    }
    this.balance += amount;
}
```

> 이게 포트폴리오에서 차별화 포인트예요. "충전 기능 만들었어요"가 아니라 **"전금법 기명 한도 200만원을 도메인 규칙으로 넣었고, 2024년 개정 전금법의 선불충전금 전액 별도관리도 원장 계정 분리로 반영할 수 있게 설계했어요"** — 라고 하면 "규제를 이해하는 개발자"로 보여요. 핀테크·페이사 지원에서 강하게 먹히는 지점이고요.

## 3. 정리

선불 월렛은 두 가지를 증명해요.

- **원장 발상**: 잔액을 덮어쓰지 않고 이력을 남긴다 → 마이너스 잔액·이중차감을 구조적으로 차단, 감사 가능. (잔액 컬럼 UPDATE식 지갑은 오히려 감점이에요.)
- **규제를 코드로**: 전금법 한도를 도메인 규칙으로. "돈을 다루는 법"을 아는 신호.

그리고 동시성은 [이미 실측 증명한 기법](/blog/project/pay/pay-5-lock-comparison)을 재사용 — 재고든 월렛이든 "한 자원의 동시 차감"은 같은 문제라는 걸 보여주면서요.

## 다음 — 가상계좌

다음은 가상계좌예요. 입금 웹훅, 그리고 문서를 깊게 읽어야만 아는 함정 둘 — **입금기한 만료(EXPIRED)엔 웹훅이 안 온다**(자체 만료 배치 필요), **DONE에서 입금대기로 역전이**하는 은행 케이스. 이어서 씁니다.

---

*확장도 기존 기반(원장 발상·검증된 동시성 기법) 위에 얹으며, 규제를 도메인 규칙으로 새깁니다.*

---
title: '금고를 만들어놓고 아무것도 안 넣었다 — 암호화를 실제 컬럼에, 그리고 조회의 딜레마'
titleEn: 'Built a Vault and Put Nothing In It — Applying Encryption to Real Columns, and the Lookup Dilemma'
description: 결제 시스템 개선기. envelope 암호화(DEK/KEK)까지 정성껏 만들어놓고, 정작 그걸 어느 컬럼에도 안 붙였다는 걸 감사에서 발견했다. 계좌번호도 빌링키도 평문이었다. 컬럼에 붙이면서 진짜 문제를 만났다 — 빌링키는 유니크이고 값으로 조회하는데, 암호문은 매번 달라서 유니크도 조회도 깨진다. 조회되는 비밀 필드를 어떻게 암호화하나. 블라인드 인덱스가 존재하는 이유를 몸으로 배운 이야기.
descriptionEn: "Payment system improvement log. I'd carefully built envelope encryption (DEK/KEK), then an audit found it wasn't applied to any column. Account numbers and billing keys were plaintext. Applying it hit a real problem — billing keys are unique and looked up by value, but ciphertext differs every time, breaking both uniqueness and lookup. How do you encrypt a secret field that's also queried? A story of learning firsthand why blind indexes exist."
date: 2027-01-02T00:00:00.000Z
tags:
  - Payment
  - Encryption
  - Security
  - Blind Index
  - Data Protection
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 41
---

*결제 시스템 시리즈. 개선기 — 만들어둔 암호화를 실제로 쓰다.*

## 0. 금고는 있는데 비어 있었다

[필드 암호화](/blog/project/pay/pay-15-field-encryption)를 만들고, [envelope로 키 로테이션까지](/blog/project/pay/pay-35-envelope-encryption) 정성껏 확장했어요. AES-256-GCM, DEK/KEK, 블라인드 인덱스, JPA 컨버터 — 민감 데이터를 잠글 금고를 완비했죠.

그런데 [감사](/blog/project/pay/pay-39-settlement-escrow-alignment)가 이렇게 짚었어요.

> **[4] 필드 암호화 인프라 전부 미사용** — `@Convert`가 **어느 엔티티 컬럼에도 적용 안 됨**. 가상계좌 계좌번호·빌링키가 평문.

금고를 만들어놓고 **아무것도 안 넣은** 거예요. 계좌번호도, 카드 토큰인 빌링키도 DB에 평문으로 누워 있었죠. [FDS 엔진처럼](/blog/project/pay/pay-31-fds-review-queue), [대사 엔진처럼](/blog/project/pay/pay-33-settlement-file-reconciliation) — 만들고 안 연결한 또 하나였어요.

## 1. 그냥 붙이면 되는 게 아니었다

컬럼에 `@Convert`만 붙이면 될 줄 알았는데, 필드마다 **접근 패턴**이 달라서 그게 안 됐어요.

**계좌번호**는 쉬웠어요. 값으로 조회할 일이 없거든요(주문번호로 가상계좌를 찾지, 계좌번호로 찾지 않아요). 그냥 암호화하면 끝.

```java
@Convert(converter = EncryptedStringConverter.class)
@Column(length = 255)   // 암호문이 길어서 확장
private String accountNumber;
```

문제는 **빌링키**였어요. 코드를 보니 —

```java
Optional<BillingKey> findByBillingKey(String billingKey);   // 값으로 조회
@Column(nullable = false, unique = true, length = 200)      // 유니크
private String billingKey;
```

빌링키는 **유니크**이고, **값으로 조회**돼요. 여기에 암호화를 붙이면 —

> envelope 암호화는 **매번 새 DEK와 IV**를 써요([그래서 안전하죠](/blog/project/pay/pay-35-envelope-encryption) — 같은 값도 매번 다른 암호문). 그런데 그게 바로 문제예요. **같은 빌링키가 저장할 때마다 다른 암호문**이 되니, (1) `WHERE billing_key = '암호화된값'` 조회가 절대 안 맞고, (2) 유니크 제약이 무의미해져요(다른 암호문이라 절대 충돌 안 함). 보안을 위한 암호화가 **조회와 유니크를 깨뜨리는** 거예요.

암호화하면 못 찾고, 못 찾으면 결제를 못 해요. 이 딜레마가 결제 시스템에서 민감 필드를 다룰 때 항상 나오는 벽이에요.

## 2. 블라인드 인덱스가 존재하는 이유

해법은 **결정적 인덱스를 따로 두는** 거예요. 암호문은 못 하는 걸(같은 입력=같은 값) 대신 해주는 컬럼이죠.

```
billing_key         env:v1:...    ← envelope 암호문 (비결정적, 안전)
billing_key_index   a3f9c2...     ← HMAC-SHA256 (결정적, 유니크·조회용)
```

**블라인드 인덱스**는 빌링키를 secret으로 HMAC 해싱한 값이에요. 같은 빌링키는 **항상 같은 인덱스**가 나와요. 그래서 —

- **유니크**를 인덱스 컬럼으로 옮겨요(같은 빌링키 → 같은 인덱스 → 충돌 감지).
- **조회**를 인덱스로 해요: `findByBillingKey(raw)` → `raw`를 해싱 → `findByBillingKeyIndex(hash)`.

```java
public Optional<BillingKey> findByBillingKey(String raw) {
    return repository.findByBillingKeyIndex(indexer.index(raw));   // 원문을 해싱해 조회
}
```

빌링키 자체는 여전히 암호문으로 잠겨 있고(유출돼도 못 읽음), 조회·유니크는 인덱스가 대신해요. **HMAC은 일방향**이라 인덱스만 봐선 빌링키를 역산 못 하고, secret이 없으면 인덱스를 만들 수도 없어요. 이게 [블라인드 인덱스 클래스](/blog/project/pay/pay-15-field-encryption)를 애초에 만든 이유였는데 — 이번에 **실제로 쓰면서** 왜 필요한지 몸으로 알았어요.

정리하면 필드마다 전략이 달라요.

| 필드 | 조회? | 전략 |
|---|---|---|
| 계좌번호 | ✗ | 단순 암호화 |
| 구독의 빌링키 참조 | ✗ (userId로 조회) | 단순 암호화 |
| **빌링키(원본)** | ✓ 유니크·값 조회 | **암호화 + 블라인드 인덱스** |

## 3. 이미 있던 평문은 어쩌나

마지막 현실 문제 — 마이그레이션 전에 저장된 **평문 행**들이요. 그걸 복호화하려 하면 `env:` 형식이 아니라 예외가 나요.

그래서 하위호환 한 줄을 넣었어요.

```java
public String decrypt(String ciphertext) {
    if (!ciphertext.startsWith("env:")) return ciphertext;   // 레거시 평문 → 그대로
    ... // env: 형식만 복호화
}
```

`env:`로 시작 안 하면 "이건 마이그레이션 전 평문이구나" 하고 그대로 돌려줘요. 새로 저장되는 값은 항상 암호화되고, 옛 평문은 읽기만 되고요. 이렇게 하면 **점진적 마이그레이션**이 가능해요 — 한 번에 다 재암호화하지 않고, 읽을 때/쓸 때 자연스럽게 넘어가죠.

## 마치며

이번 건 "만든 걸 실제로 쓰는" 이 시리즈 후반의 패턴이 또 반복된 편이에요. 하지만 붙이는 과정에서 만난 **조회되는 비밀 필드의 딜레마**가 진짜 배움이었어요.

암호화는 "잠그면 끝"이 아니에요. 잠근 걸 여전히 **찾고, 유니크를 지키고, 결제에 써야** 하죠. 그 요구를 암호문 하나로는 못 채우니, 블라인드 인덱스라는 짝을 두는 거예요. 보안 인프라를 만드는 것과, 그걸 **실제 도메인의 조회·제약과 함께** 쓰는 것은 다른 난이도라는 걸 — 금고를 채우면서야 알았어요.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, V10 마이그레이션(컬럼 확장·유니크 이전)은 실 MySQL validate로 검증했습니다.*

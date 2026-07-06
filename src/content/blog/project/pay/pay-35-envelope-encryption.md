---
title: '키를 바꾸려고 수백만 건을 다시 암호화할 순 없다 — Envelope 암호화와 키 로테이션'
titleEn: "You Can't Re-encrypt Millions of Rows Just to Rotate a Key — Envelope Encryption and Key Rotation"
description: 결제 시스템 개선기. 민감 필드를 단일 키로 AES-GCM 암호화해뒀는데, 실서비스에서 그 키를 주기적으로 교체하려면 암호화된 모든 데이터를 다시 암호화해야 한다 — 수백만 건이면 재앙이다. 금융권 표준인 envelope 암호화로 바꿨다. 데이터는 매번 새 DEK로, DEK는 마스터키(KEK)로 감싸 저장하니, 키 로테이션이 "작은 DEK만 다시 감싸기"가 된다. 데이터는 한 바이트도 안 건드리고.
descriptionEn: "Payment system improvement log. I had sensitive fields AES-GCM encrypted with a single key, but rotating that key in production means re-encrypting all the data — a disaster at millions of rows. I switched to envelope encryption, the financial-industry standard. Data is encrypted with a fresh DEK each time, and the DEK is wrapped by a master key (KEK), so key rotation becomes 're-wrapping the small DEKs' — without touching a byte of the data."
date: 2026-11-21T00:00:00.000Z
tags:
  - Payment
  - Encryption
  - Security
  - KMS
  - Key Management
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 35
---

*결제 시스템 시리즈. 개선기 — 키를 바꿀 수 있는 암호화로.*

## 0. 단일 키의 함정 — 키를 못 바꾼다

[필드 암호화 편](/blog/project/pay/pay-15-field-encryption)에서 계좌번호 같은 민감 필드를 AES-256-GCM으로 암호화했어요. 프로퍼티로 주입한 **하나의 키**로요. 그때도 코드 주석에 이렇게 적어뒀어요.

> 운영에서는 envelope encryption으로 교체한다 — 데이터는 DEK로, DEK는 KMS 마스터키(KEK)로 암호화해 함께 저장한다.

왜 단일 키로는 부족할까요? 문제는 **키 로테이션**이에요.

> 보안 표준은 암호화 키를 **주기적으로 교체**하라고 해요(유출 대비, 컴플라이언스). 그런데 단일 키로 모든 데이터를 암호화했다면, 키를 바꾸는 순간 **그 키로 암호화한 모든 데이터를 복호화해서 새 키로 다시 암호화**해야 해요. 계좌번호가 수백만 건이면? 전체를 읽고, 풀고, 다시 잠그는 대공사예요. 그게 무서워서 키를 안 바꾸게 되고, 안 바꾸니 위험이 쌓여요.

단일 키는 "바꿀 수 없는 키"가 되기 쉬워요. 그래서 실서비스는 **envelope**를 써요.

## 1. Envelope — 키를 두 겹으로

핵심 아이디어는 **키를 두 겹으로 나누는** 거예요.

- **DEK (Data Encryption Key)**: 실제 데이터를 암호화하는 키. **암호화할 때마다 새로 생성**해요(무작위).
- **KEK (Key Encryption Key, 마스터키)**: DEK를 암호화(wrap)하는 키. **KMS 안에** 보관하고 밖으로 안 나와요.

암호화 흐름은 이래요.

```
1. DEK = 무작위 32바이트 생성
2. 데이터를 DEK로 암호화        (AES-256-GCM)
3. DEK를 KEK로 감싼다(wrap)      (AES-256-GCM)
4. [감싼 DEK] + [암호화된 데이터] 를 함께 저장
```

복호화는 반대로 — 저장된 감싼 DEK를 KEK로 풀어(unwrap) DEK를 얻고, 그 DEK로 데이터를 풀어요. 암호문 포맷은 이렇게 잡았어요.

```
env:v1:{base64 감싼DEK}:{base64 암호화된데이터}
    ↑ 버전 — 어느 KEK로 감쌌는지
```

버전을 **앞에 박아둔** 게 중요해요. 복호화할 때 "이건 v1 KEK로 감쌌구나"를 알아야 하니까요.

## 2. 그래서 키 로테이션이 값싸진다

이제 마법 같은 부분이에요. KEK를 v1 → v2로 바꾸고 싶으면?

**데이터는 한 바이트도 안 건드려요.** DEK만 다시 감싸면 돼요.

```java
String rewrapToCurrent(String ciphertext) {
    // 옛 KEK로 DEK만 풀어서
    // current KEK로 다시 감싸고
    // 암호화된 데이터(dataBlob)는 그대로 둔다
    return "env:v2:" + newWrappedDek + ":" + 원래dataBlob;   // 데이터 불변!
}
```

> 데이터 암호문(dataBlob)은 그대로예요. 바뀌는 건 **32바이트짜리 감싼 DEK**뿐이죠. 수백만 건이어도, 각 행의 작은 DEK만 옛 KEK로 풀어 새 KEK로 다시 감싸면 끝이에요. **큰 데이터를 다시 암호화하지 않아요.** 이게 envelope의 진짜 이점이에요 — 키 로테이션이 감당 가능한 작업이 되는 것.

테스트로 확인했어요.

```
v1으로 암호화 → env:v1:...
rewrapToCurrent(current=v2) → env:v2:...   ← 프리픽스만 v1→v2
그래도 복호화하면 → 원래 평문 그대로       ← 데이터 부분(dataBlob)은 불변
```

프리픽스는 v2로 바뀌었지만 데이터 조각은 동일하고, 복호화하면 원래 값이 나와요. "키만 갈아끼웠다"가 증명된 거죠.

## 3. KMS는 추상화로, 전환은 설정 한 줄로

마스터키(KEK)를 어디서 가져올까 — 실서비스는 **KMS**(AWS KMS, HashiCorp Vault)에서 가져와요. 마스터키가 애플리케이션 메모리 밖, HSM 안에 사는 거죠. 로컬 데모는 프로퍼티에서 읽고요.

그래서 `MasterKeyProvider`라는 추상화를 뒀어요.

```java
interface MasterKeyProvider {
    String currentVersion();
    SecretKey keyFor(String version);
}
```

로컬은 `PropertyMasterKeyProvider`(프로퍼티에서 버전별 KEK)를, 운영은 이 인터페이스의 KMS 구현으로 교체하면 돼요. 나머지 코드는 그대로고요.

그리고 [기존 단일 키 방식](/blog/project/pay/pay-15-field-encryption)과 **공존**하게 했어요. `FieldCipher` 인터페이스는 그대로 두고, envelope 구현을 `@Primary`로 두되 `mode=envelope`(기본) 설정으로 켜요. `mode=simple`로 두면 옛 단일 키 방식이 쓰이고요. **설정 한 줄로 전환**되고, 인터페이스·JPA 컨버터·도메인 코드는 한 줄도 안 바꿨어요.

## 마치며

이번 건 "암호화를 더 세게"가 아니라 **"암호화를 운영 가능하게"** 만든 편이에요. AES-GCM 자체는 이미 충분히 강했어요. 부족했던 건 **키를 바꿀 수 있느냐**였죠.

Envelope의 통찰은 "키를 두 겹으로 나누면, 자주 바꿔야 하는 것(KEK)과 방대한 것(데이터)을 분리할 수 있다"예요. 그래서 키 로테이션이 데이터 재암호화와 **디커플링**돼요. 보안은 한 번 잘 잠그는 게 아니라, **계속 관리할 수 있게** 만드는 거라는 걸 — 이 마지막 조각에서 다시 배웠어요.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, envelope 암호화·rewrap 로테이션을 단위 테스트와 실기동으로 검증했습니다([ADR-006](https://github.com/dj258255/payment-system/blob/main/docs/adr/ADR-006-envelope-encryption-dek-kek.md)).*

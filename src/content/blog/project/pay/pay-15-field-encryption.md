---
title: '필드 암호화 — 키를 코드에 두지 않는다, 그리고 암호화한 걸 검색하는 법'
titleEn: "Field Encryption — Keep Keys Out of Code, and How to Search What You Encrypted"
description: 결제 시스템 확장 7. 계좌번호 같은 민감정보를 AES-256-GCM으로 암호화한다. GCM으로 변조를 감지하고, 매번 무작위 IV로 같은 평문도 다른 암호문이 되게 한다. 문제는 암호화하면 검색이 안 된다는 것 — 블라인드 인덱스(HMAC)로 동등 검색만 열어준다. 그리고 커밋 보안 검토가 하드코딩된 키를 잡아, 키를 코드 밖으로 뺀 이야기.
descriptionEn: "Payment system extension 7. Encrypting sensitive data like account numbers with AES-256-GCM. GCM detects tampering, and a random IV per encryption makes the same plaintext produce different ciphertext each time. The catch: once encrypted, you can't search it — a blind index (HMAC) opens up equality search only. And how a commit-time security review caught a hardcoded key, so I moved the key out of code."
date: 2026-07-20T00:00:00.000Z
tags:
  - Payment
  - Encryption
  - AES-GCM
  - Security
  - Compliance
  - Java
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 15
---

*결제 시스템 시리즈. 확장 7편 — 필드 암호화와 감사 로그.*

## 0. 무엇을, 왜 암호화하나

「개인정보의 안전성 확보조치 기준」은 **신용카드번호·계좌번호**를 암호화 의무 대상으로 정해요. 그래서 이런 필드는 평문으로 저장하면 안 돼요. AES-256-GCM으로 암호화했어요.

```java
Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
cipher.init(ENCRYPT_MODE, key, new GCMParameterSpec(128, iv));  // 무작위 IV
```

**왜 GCM인가** — CBC와 달리 **인증 태그**가 붙어서 변조를 감지해요. 누가 DB의 암호문을 조작하면 복호화가 실패하죠. 그리고 암호문마다 **무작위 IV**를 앞에 붙여서, 같은 계좌번호도 매번 다른 암호문이 돼요(패턴 노출 방지).

JPA에서는 `AttributeConverter`로 붙여서, 엔티티 필드에 `@Convert`만 달면 저장 시 암호화·조회 시 복호화가 투명하게 일어나게 했어요.

## 1. 암호화하면 검색이 안 된다 — 블라인드 인덱스

여기 실무 함정이 있어요. 계좌번호를 암호화하면 매번 암호문이 달라서 **`WHERE account = ?` 검색이 안 돼요.** 그렇다고 평문으로 둘 순 없고요.

해법은 **블라인드 인덱스**예요. 같은 평문이 항상 같은 해시가 되는 HMAC-SHA256 값을 별도 컬럼에 저장해요.

```java
public static String hash(String value, String secret) {
    Mac mac = Mac.getInstance("HmacSHA256");
    mac.init(new SecretKeySpec(secret.getBytes(UTF_8), "HmacSHA256"));
    return hex(mac.doFinal(value.getBytes(UTF_8)));
}
```

이러면 `WHERE account_index = hash(검색어)`로 **동등 검색만** 열려요. (범위 검색은 여전히 불가 — 그건 암호화 컬럼의 본질적 한계예요.) 암호화로 데이터를 보호하면서도 "이 계좌번호로 조회"는 되게 하는 거죠.

## 2. 그리고 보안 검토가 키를 잡았다

암호화 코드를 커밋하자 자동 보안 검토가 짚었어요 — **하드코딩된 암호화 키.**

```java
// 잡힌 것
public AesGcmFieldCipher(@Value("${app.crypto.key:0123456789abcdef...}") String key)
//                                              ^^^^^^^^^^^^^^^^^^ 코드에 박힌 기본 키
```

암호화 키가 코드에 기본값으로 있으면, 누가 `app.crypto.key`를 안 설정하고 배포했을 때 **공개된 키로 데이터를 암호화**하게 돼요. 암호화의 의미가 사라지죠.

고쳤어요 — **기본값을 없애서, 키가 없으면 앱이 아예 안 뜨게** 했어요.

```java
public AesGcmFieldCipher(@Value("${app.crypto.key}") String key) {  // 기본값 없음
    if (key == null || key.isBlank())
        throw new IllegalStateException("app.crypto.key 미설정 — 환경변수/시크릿으로 주입해야 합니다.");
    ...
}
```

키는 환경변수/시크릿 매니저로만 주입하고, 로컬 개발용 값은 설정 파일에 두되 "운영에서 반드시 오버라이드"로 표시했어요.

> 운영에선 이걸 **envelope encryption**으로 한 단계 더 가요 — 데이터는 DEK로 암호화하고, DEK는 KMS 마스터키로 암호화해 함께 저장. 이 코드의 인터페이스는 그대로 두고 키 공급만 KMS로 바꾸면 되게 설계했어요.

## 3. 감사 로그

민감 행위(강제취소, 개인정보 언마스킹 등)는 **append-only 감사 로그**로 남겨요. 전자금융거래법 제22조상 거래기록 5년 보존의 기반이에요. 누가·무엇을·어떤 대상에·언제 했는지를 기록하고, 절대 수정·삭제하지 않아요.

## 4. 정리

민감정보 보호는 세 겹이에요.

- **암호화**: AES-256-GCM(변조 감지 + 무작위 IV), JPA 컨버터로 투명하게
- **검색 가능성**: 블라인드 인덱스(HMAC)로 동등 검색만 허용
- **키 관리**: 키를 코드에 두지 않는다(미설정 시 기동 실패), 운영은 envelope encryption
- **감사**: 민감 행위 append-only 기록(전금법 5년)

그리고 "하드코딩 키"는 자동 보안 검토가 커밋 단계에서 잡아줬어요 — 암호화 코드일수록 이런 검토가 중요하다는 걸 다시 확인했고요.

## 다음 — 현금영수증

마지막 확장은 현금영수증이에요. 카드는 매출전표, 현금성은 현금영수증, B2B는 세금계산서로 증빙을 자동 결정하고, 결제가 취소되면 현금영수증도 연쇄 취소하는. 이어서 씁니다.

---

*확장도 기존 기반 위에 얹으며, 규제와 보안을 코드로 반영합니다.*

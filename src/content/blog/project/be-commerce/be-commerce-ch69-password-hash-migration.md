---
title: '비밀번호 해시의 점진 이관'
description: '저장된 값이 해시뿐이라 bcrypt에서 Argon2id로 배치 이관은 불가능하고 로그인 성공 시점에 다시 해싱한다. 접두사 부여, 기본 인코더 교체, 컬럼 길이 확장, 레거시 해시 수 게이지로 이관 종료를 확인하는 순서를 정리한다.'
date: 2026-06-11
category: web/Tradeoffs
topics:
  - performance
draft: false
series: "웹 개발 트레이드오프"
seriesOrder: 1.1
tags:
  - 보안
  - 인증
  - Spring Security
  - 결제 시스템
---

비밀번호 해시의 점진 이관은 알고리즘을 바꾼 뒤 기존 사용자의 해시를 그 사용자가 로그인하는 순간에 하나씩 새 알고리즘으로 바꾸는 방식입니다. 저장된 값이 단방향 해시뿐이라 원문 비밀번호는 로그인 요청을 처리하는 순간에만 서버에 들어오고 그래서 배치로는 이관할 수 없습니다. 이관은 로그인이 일어나는 속도로만 진행되고 로그인하지 않는 계정은 옛 해시로 남습니다.

BE-commerce에서는 [bcrypt와 Argon2id의 비용을 재고 파라미터를 정한](/blog/project/be-commerce/be-commerce-ch6-auth-cost) 뒤 저장된 `$2a$10$...` 해시를 바꿔야 했습니다. 바로 바꿀 수 없는 조건이 둘 있었습니다. `Argon2PasswordEncoder`는 BouncyCastle을 요구하는데 이 시스템에는 해당 의존이 없었고 저장된 해시에는 접두사가 없어 코드가 알고리즘을 식별할 방법이 없었습니다. 이 상태에서 알고리즘을 바꾸면 모든 사용자에게 비밀번호 재설정을 요구해야 합니다.

## 결론부터

- 전환은 `DelegatingPasswordEncoder`로 접두사를 부여하는 데서 시작하고 그 단계에서는 강도가 오르지 않습니다.
- 기본 인코더를 Argon2id로 바꾸면 접두사 없는 레거시, `{bcrypt}`, `{argon2}` 세 세대를 동시에 검증합니다.
- 해시 문자열이 68자에서 105자로 길어지므로 컬럼을 100자에서 255자로 늘려야 가입이 실패하지 않습니다.
- 로그인 성공 시점에 재해싱하고 레거시 해시 수 게이지가 0이 되면 레거시 인코더를 뺍니다. 이관 실패는 로그인을 막지 않습니다.

![저장된 해시 세 세대가 어떤 인코더로 검증되고 로그인에 성공하면 Argon2id로 다시 저장되는 흐름](/uploads/project/be-commerce/diagrams/flow-password-migration.svg)

## 1. 왜 접두사부터 붙일까?

알고리즘은 유지하고 접두사만 먼저 부여합니다.

```java
DelegatingPasswordEncoder delegating = new DelegatingPasswordEncoder(
        "bcrypt", Map.of("bcrypt", new BCryptPasswordEncoder()));
delegating.setDefaultPasswordEncoderForMatches(new BCryptPasswordEncoder());
```

새로 생성하는 해시에는 `{bcrypt}`가 붙고 이미 저장된 접두사 없는 해시는 `setDefaultPasswordEncoderForMatches`가 계속 검증합니다. 강도는 상승하지 않습니다. 이 단계는 뒤의 교체를 위한 준비입니다.

## 2. 기본 인코더는 어떻게 바꿀까?

맵에 항목을 추가하고 기본 id를 바꾸는 것으로 끝납니다.

```java
String encodingId = "argon2";
PasswordEncoder argon2 = new Argon2PasswordEncoder(16, 32, 1, 19456, 2);

DelegatingPasswordEncoder delegating = new DelegatingPasswordEncoder(
        encodingId, Map.of(encodingId, argon2, "bcrypt", bcrypt));
delegating.setDefaultPasswordEncoderForMatches(bcrypt);
```

이제 세 세대의 해시를 모두 검증합니다.

| 저장된 형태 | 검증 주체 |
|---|---|
| `{argon2}$argon2id$...` | 맵의 argon2 (신규 가입) |
| `{bcrypt}$2a$...` | 맵의 bcrypt (이관 중간 세대) |
| `$2a$...` | `setDefaultPasswordEncoderForMatches` (가장 오래된 것) |

기존 회원의 비밀번호 재설정은 필요하지 않습니다. 이 조건은 테스트로 고정했습니다. 하나라도 깨지면 해당 세대의 사용자 전원이 로그인하지 못합니다.

## 3. 컬럼 길이는 충분할까?

인코더 테스트가 통과해도 저장할 해시 문자열의 길이는 따로 재야 합니다.

```
{bcrypt}$2a$10$...                            68자
{argon2}$argon2id$v=19$m=19456,t=2,p=1$...   105자
```

`password_hash` 컬럼은 `varchar(100)`이었습니다. 105자는 들어가지 않고 실제 가입에서는 `Data too long`으로 실패했을 것입니다. 인코더 단위 테스트는 인코딩과 검증만 확인하고 데이터베이스까지 거치지 않으므로 컬럼 길이는 검증 대상 밖입니다. 알고리즘 교체에는 스키마 변경도 따라옵니다. 컬럼은 255로 확장했습니다. 이후 파라미터를 상향하면 문자열이 더 길어지므로 마이그레이션을 매번 추가하는 대신 한 번에 여유를 둔 값입니다.

## 4. 이관은 언제 끝날까?

남은 레거시 해시 수가 0이 되는 시점입니다. 신규 가입은 Argon2id로 처리되고 기존 bcrypt 해시를 가진 회원은 로그인에 성공한 순간 새 알고리즘으로 다시 해싱합니다. Spring Security는 이 흐름을 위한 확장 지점을 제공합니다.

```
로그인 성공
  → DaoAuthenticationProvider가 PasswordEncoder.upgradeEncoding(저장된해시) 질의
  → 참이면 UserDetailsPasswordService.updatePassword(user, 새로_인코딩된_해시)
```

`DelegatingPasswordEncoder`는 저장된 해시 앞의 표식을 보고 어떤 알고리즘으로 검증할지 선택하고 현재 알고리즘과 다르면 `upgradeEncoding()`이 참을 돌려줍니다. `{bcrypt}`와 접두사 없는 레거시가 모두 대상이고 Argon2id 인코더는 파라미터가 변경될 때도 참을 반환하므로 이후 상향 시에도 같은 경로로 이관됩니다. 이 기능은 기존 운영 코드를 예기치 않게 바꾸지 않도록 옵트인으로 남겨 둔 설계라 `UserDetailsPasswordService`를 직접 등록해야 켜집니다.

구현 원칙은 하나입니다.

> 이관 실패가 로그인을 막지 않습니다.

회원을 찾지 못하거나 데모 계정이면 이관을 건너뛰고 인증은 통과시킵니다. 이관은 편의이고 인증은 기능이므로 이관 로직의 버그가 전체 로그인을 막아서는 안 됩니다. 이 조건도 테스트로 고정했습니다.

종료 조건은 따로 정해야 합니다. 로그인하지 않는 계정은 옛 해시로 남고 원문 비밀번호 없이는 재인코딩할 수 없으므로 코드만으로 이관을 끝낼 수 없습니다. 해당 사용자가 로그인하거나 비밀번호를 재설정하는 방법뿐입니다. 레거시 인코더를 제거하면 재설정이 강제되지만 이 시스템에는 비밀번호 재설정 플로우가 없어 그런 상태에서 제거하면 계정이 잠깁니다. 그래서 남은 레거시 해시 수를 게이지 `password_hash_legacy_count`로 노출합니다. 이 값이 0이 되면 레거시 인코더를 제거할 수 있고 7일 이상 남아 있으면 `info` 심각도로 알립니다. 이 알림은 종료 시점을 확인하기 위한 용도입니다.

## 정리

알고리즘 교체는 인코더 한 줄을 바꾸는 일로 끝나지 않았습니다. 접두사 부여, 기본 인코더 교체, 컬럼 확장, 로그인 시점 재해싱의 네 단계가 따라왔고 각 단계는 그 앞 단계가 있어야 안전합니다. 이관이 끝나는 시점은 사용자의 로그인이 정하므로 레거시 해시 수 게이지가 이관의 종료를 알려 줍니다.

## 참고

- [ADR-009 비밀번호 해시와 이관 경로](https://github.com/dj258255/BE-commerce/blob/main/docs/adr/ADR-009-password-hashing-and-migration-path.md)
- [Spring Security Password Storage](https://docs.spring.io/spring-security/reference/features/authentication/password-storage.html): `DelegatingPasswordEncoder`와 `upgradeEncoding()`의 동작.

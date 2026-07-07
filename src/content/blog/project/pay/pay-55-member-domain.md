---
title: '데모 계정밖에 없던 인증에 진짜 회원을 붙이다 — 숫자 userId 계약을 지키면서'
titleEn: 'Adding Real Members to a Demo-Only Auth — While Preserving the Numeric userId Contract'
description: 결제 시스템 개선기. 인증이라곤 InMemoryUserDetailsManager에 박아둔 데모 계정(admin/admin2/"1"/"2")뿐이라 실제로 "가입한 회원"이 없었다. JPA 회원 가입/로그인을 붙이되, 시스템 전체가 principal.getName()을 Long.parseLong으로 파싱해 소유권을 검증한다는 계약을 깨뜨리지 않는 게 관건이었다. 회원은 이메일로 로그인하지만 JWT subject는 숫자 회원 id로 유지하는 복합 UserDetailsService를 배선한 이야기.
descriptionEn: "Payment system improvement log. The only auth was demo accounts baked into an InMemoryUserDetailsManager (admin/admin2/\"1\"/\"2\") — there were no actual signed-up members. The task was to add JPA signup/login without breaking the contract that the whole system parses principal.getName() via Long.parseLong to verify ownership. A story about wiring a composite UserDetailsService where members log in by email but the JWT subject stays a numeric member id."
date: 2027-04-10T00:00:00.000Z
tags:
  - Payment
  - Authentication
  - Spring Security
  - JWT
  - Spring Boot
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 55
---

*결제 시스템 시리즈. 개선기 — 데모 계정뿐이던 인증에 진짜 회원을 붙이기.*

## 0. 로그인은 되는데, "회원"이 없었다

[구독](/blog/project/pay/pay-52-subscription-surface)도 [월렛](/blog/project/pay/pay-53-wallet-payment-method)도 다 붙였는데, 정작 제일 밑바닥이 비어 있었어요. **실제로 가입한 회원이 없었다는 거요.**

지금까지 로그인은 `SecurityConfig`에 이렇게 박아둔 게 전부였어요.

```java
UserDetails user1 = User.withUsername("1").password(...).roles("USER").build();
UserDetails user2 = User.withUsername("2").password(...).roles("USER").build();
return new InMemoryUserDetailsManager(admin, admin2, user1, user2);
```

데모 유저 "1", "2"와 어드민 둘. 시연에는 충분했지만 "이메일로 가입해서 로그인하는" 진짜 회원은 만들 방법이 없었죠. 이번엔 그걸 붙였어요.

## 1. 겁나게 조심해야 했던 계약 하나

회원을 붙이는 것 자체는 흔한 일이에요. `Member` 엔티티, 저장소, BCrypt 해시, `POST /signup`. 문제는 이 시스템이 **처음부터 깔고 있던 계약** 하나였어요.

시스템 전체가 소유권을 이렇게 검증해요.

```java
long userId = Long.parseLong(principal.getName());
```

주문도, 결제도, 월렛도, 포인트도, 구독도 전부 이 한 줄로 "이 요청의 주인이 누구냐"를 얻어요. 즉 **`principal.getName()`은 반드시 숫자로 파싱돼야** 한다는 거예요. 데모 유저의 username이 왜 하필 `"1"`, `"2"`였는지 여기서 드러나요. username이 곧 userId였던 거죠.

그런데 회원은 이메일로 로그인하고 싶잖아요. `principal.getName()`이 `alice@example.com`이 되어버리면 `Long.parseLong`이 그 자리에서 터지고, **전 모듈의 소유권 검증이 한꺼번에 무너져요.** 이게 이번 작업의 핵심 제약이었어요.

## 2. 복합 UserDetailsService — 이메일로 찾되 숫자로 돌려준다

열쇠는 Spring Security의 동작 하나예요. `DaoAuthenticationProvider`는 인증에 성공하면 **내가 입력한 로그인 식별자가 아니라, 로드된 `UserDetails.getUsername()`을 principal 이름으로 삼아요.** 여기에 답이 있었어요.

로그인 식별자로 회원을 찾을 때, username을 **회원의 숫자 id로 바꿔서** 돌려주면 되는 거예요.

```java
return username -> {
    // (a) 데모 계정 우선 — admin/admin2/"1"/"2"는 인메모리 그대로
    try {
        return inMemory.loadUserByUsername(username);
    } catch (UsernameNotFoundException notDemo) {
        // (b) 실 회원 — 이메일로 조회하되, username은 숫자 id로 만든다
        Member member = memberRepository.findByEmail(username)
                .orElseThrow(() -> new UsernameNotFoundException("사용자를 찾을 수 없습니다: " + username));
        return User.withUsername(String.valueOf(member.getId()))
                .password(member.getPasswordHash())
                .roles(member.getRole())
                .build();
    }
};
```

`alice@example.com`으로 로그인해도, 인증이 끝나면 principal은 `"1000"`이에요. `auth.getName()`이 숫자를 돌려주니 JWT subject도 숫자로 실리고, 이후 `Long.parseLong(principal.getName())`이 그대로 살아요. **소유권 계약을 한 글자도 안 건드린 거죠.**

데모 계정을 먼저 보고 없으면 회원을 보는 순서도 의미가 있어요. `admin`·`"1"`·`"2"`는 인메모리에서 즉시 잡히고(무중단), 데모 계정이 아닐 때만 DB를 한 번 때려요.

## 3. 데모 유저 "1"과 회원 id가 부딪히면?

여기서 미묘한 함정이 하나 있었어요. 회원 id는 `IDENTITY`로 1부터 증가하는데, 인메모리 데모 유저의 principal도 `"1"`, `"2"`예요. 신규 회원이 id 1을 받으면 데모 유저 "1"과 **principal이 겹쳐요.** 소유권이 뒤섞이는 거죠.

그래서 회원 테이블의 시작 번호를 아예 떼어놨어요.

```sql
-- 신규 회원 id는 1000부터 — 인메모리 데모 유저 principal("1"/"2")과 충돌하지 않게
alter table members auto_increment = 1000;
```

첫 회원이 1000번을 받으니 데모 유저 1·2와 영영 안 부딪혀요. 작지만 안 넣었으면 시연 중에 조용히 데이터가 섞였을 자리예요.

스키마는 Flyway로만 만들어요(`ddl-auto: validate`). 그래서 `V14__members.sql`에 테이블·이메일 유니크 인덱스·AUTO_INCREMENT를 한 번에 담았어요.

## 4. 나머지는 관례대로

`member` 모듈은 다른 모듈과 똑같은 뼈대예요. `@ApplicationModule(allowedDependencies = { "shared" })`로 경계를 긋고, 엔티티는 정적 팩토리(`Member.of`)로만 만들고, 노출은 뷰 레코드(`MemberView` — `passwordHash`는 절대 안 실어요)로 해요. 가입 서비스는 이메일 중복이면 `EMAIL_ALREADY_EXISTS`, 비밀번호는 BCrypt로 해시해서만 저장하고요.

예외는 도메인 코드를 HTTP로 매핑하는 `GlobalExceptionHandler`에 두 줄 얹었어요. `EMAIL_ALREADY_EXISTS → 409`, `MEMBER_NOT_FOUND → 404`.

![회원 가입·로그인 데모](/uploads/project/pay/demo/demo-member.png)

## 5. 남은 것

이제 흐름이 이래요. `POST /api/v1/members/signup`으로 이메일 가입 → `POST /api/v1/auth/login`에 그 이메일을 그대로 태움 → 숫자 subject를 가진 JWT 발급 → 주문·결제·월렛이 그 숫자로 소유권을 검증. 데모 계정도 그대로 살아 있고요.

붙이고 나서 제일 마음에 든 건, **기존 계약을 한 줄도 안 고쳤다는 점**이에요. 소유권 검증하는 코드는 전 모듈에 흩어져 있는데, 그걸 다 놔두고 인증 입구에서 username만 숫자로 번역해준 거죠. 계약을 지키는 가장 싼 방법은, 계약이 보는 값을 계약이 기대하는 모양으로 만들어서 넘겨주는 거였어요.

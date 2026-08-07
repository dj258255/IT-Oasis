---
title: '웹에서 쿠키 JWT 했는데, 모바일은 왜 이렇게 다를까?'
description: 웹의 HttpOnly Cookie 인증과 모바일 앱 인증의 차이, 모바일에서 JWT + Redis Refresh Token 전략을 설계한 과정을 정리한다.
date: 2025-12-11T00:00:00.000Z
tags:
  - JWT
  - Mobile Auth
  - Cookie
  - Redis
  - Refresh Token
  - Spring Security
category: personal/Tymee
draft: false
coverImage: "/uploads/project/Tymee/mobile-jwt-auth/xss-attack-diagram.png"
series: "Tymee"
---

## 들어가며

이전 프로젝트에서 웹용으로 HttpOnly Cookie + JWT로 인증을 구현했었습니다.

```java
// 백엔드 3줄
cookie.setHttpOnly(true);
cookie.setSecure(true);
cookie.setAttribute("SameSite", "Lax");
```

```javascript
// 프론트 2줄
axios.create({ baseURL: '/api/v1', withCredentials: true });
```

브라우저가 알아서 쿠키 보내주고, XSS도 막아주고, 편했습니다.

이번에 1인 개발로 모바일 앱 백엔드를 만들면서 웹과 모바일의 인증 구조가 많이 다르다는 걸 알게 됐습니다.

---

## 웹 vs 모바일: 핵심 차이점

| 구분 | 웹 (쿠키 기반) | 모바일 (현재 구현) |
|------|---------------|-------------------|
| **토큰 저장** | HttpOnly 쿠키 (브라우저) | Keychain/Keystore (앱) + Redis (서버) |
| **Refresh Token** | 쿠키에 저장 | Redis에 저장 + 클라이언트 보관 |
| **토큰 탈취 감지** | 어려움 (쿠키는 자동 전송) | **가능** (Redis 값과 비교) |
| **즉시 로그아웃** | 어려움 (토큰 자체가 유효) | **가능** (Redis 삭제) |
| **멀티 디바이스** | 세션 기반으로 복잡 | **네이티브 지원** (deviceId별 토큰) |
| **CSRF 방어** | 필요 (쿠키 자동 전송) | 불필요 (Authorization 헤더) |

### 현업에서도 비슷하게 한다

검색해보니 다른 기업들도 비슷한 구조를 사용하고 있었습니다.

> "For native apps, use platform-secure storage APIs. For example, in iOS, use Keychain, and in Android, use Keystore."
>
> — [Curity - OAuth for Mobile Apps Best Practices](https://curity.io/resources/learn/oauth-for-mobile-apps-best-practices/)

> "Mobile clients should not use JWT access tokens since they are easily readable by attackers. The authorization server should enable you to issue access tokens in a confidential and unreadable format."
>
> — [Duende Software - JWT Best Practices](https://duendesoftware.com/learn/best-practices-using-jwts-with-web-and-mobile-apps)

Redis로 Refresh Token을 관리하는 것도 업계 표준입니다.

> "After a user has successfully entered their login credentials, mobile banking apps use a token stored in Redis for the duration of a user session. Redis provides < 1ms latency at incredibly high throughput which makes authentication and session data access much faster."
>
> — [Redis - Mobile Banking Session Management](https://redis.io/learn/howtos/solutions/mobile-banking/session-management)

---

## 왜 모바일은 쿠키를 안 쓸까?

### 1. 네이티브 앱에는 쿠키 개념이 없다

웹 브라우저는 쿠키를 자동으로 관리합니다. 하지만 iOS/Android 네이티브 앱은 브라우저가 아닙니다.

```
웹: 브라우저 -> 쿠키 자동 전송 -> 서버
모바일: 앱 -> ??? -> 서버
```

모바일 앱에서 쿠키를 쓰려면 직접 CookieManager를 관리해야 하는데, 이건 웹뷰에서나 쓰는 방식입니다.

네이티브 앱은 보통 **Authorization 헤더**를 씁니다.

### 2. 모바일은 XSS가 없다

웹에서 HttpOnly Cookie를 쓰는 가장 큰 이유가 XSS 방어입니다.

![xss-attack-diagram](/uploads/project/Tymee/mobile-jwt-auth/xss-attack-diagram.png)

근데 네이티브 앱은 **JavaScript 실행 환경이 아닙니다**. 악성 스크립트가 실행될 수가 없습니다.

대신 모바일은 다른 위협이 있다:
- 기기 분실/도난
- 루팅/탈옥된 기기
- 앱 디컴파일

그래서 **OS 레벨 보안 저장소**(Keychain, Keystore)를 씁니다.

> "Never store JWTs in local storage or session storage. For mobile apps, use secure, encrypted storage like Keychain on iOS or Keystore on Android."
>
> — [Compile7 - JWT Best Practices for Mobile Apps](https://compile7.org/decompile/jwt-best-practices-for-mobile-apps)

### 3. 멀티 디바이스 지원이 필수입니다

웹은 보통 하나의 브라우저에서 로그인합니다. 근데 모바일은?

```
사용자 A
iPhone (아침 출근길)
iPad (집에서)
```

각 기기마다 **독립적인 세션**이 필요합니다. 쿠키는 브라우저 단위라 이걸 처리하기 어렵습니다.

---

## 구현하면서 힘들었던 부분들

### 1. 1인 개발자에게 OAuth 설정은 지옥입니다

웹에서는 OAuth Redirect 방식을 썼습니다. 구글 콘솔에서 클라이언트 ID 만들고, redirect URI 등록하면 끝이었습니다.

**모바일은 설정이 번거롭습니다.**

#### Google OAuth 설정


1. Google Cloud Console 접속
2. OAuth 2.0 클라이언트 ID 생성 (iOS용, Android용 각각!)
3. iOS: Bundle ID 등록
4. Android: 패키지명 + SHA-1 지문 등록
   - debug용 SHA-1
   - release용 SHA-1
   - Google Play 서명용 SHA-1 (또 다름!)
5. google-services.json / GoogleService-Info.plist 다운로드
6. 앱에 SDK 연동


SHA-1 지문 구하는 것만 해도:

```bash
# debug용
keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android -keypass android

# release용
keytool -list -v -keystore your-release-key.keystore -alias your-alias

# Google Play 앱 서명 쓰면 또 다른 SHA-1...
```

#### Apple Sign In 설정 (진짜 복잡)


1. Apple Developer 계정 필요 (연 $99)
2. App ID 생성 + Sign In with Apple 활성화
3. Services ID 생성 (웹용)
4. Private Key 생성 (.p8 파일 다운로드)
5. Key ID, Team ID 기록
6. 백엔드에서 JWT 생성해서 client_secret 만들기


Apple의 client_secret은 고정값이 아니라 **JWT**입니다. 백엔드에서 직접 생성해야 합니다:

![apple-client-secret-jwt](/uploads/project/Tymee/mobile-jwt-auth/apple-client-secret-jwt.png)


> "Apple's OAuth2 implementation seems to be a lot different and quite challenging for a lot of developers to implement."
>
> — [DEV.to - Complete Guide to Apple OAuth 2.0](https://dev.to/varsilias/complete-guide-to-implementing-apple-oauth-20sign-in-with-apple-authentication-in-a-nodeexpress-application-4hf)

#### Kakao OAuth 설정


1. Kakao Developers 앱 생성
2. 플랫폼 등록 (iOS, Android 각각)
3. iOS: Bundle ID
4. Android: 패키지명 + 키 해시
5. 동의항목 설정 (이메일 등)
6. Redirect URI 등록 (웹용)


**웹에서는 redirect URI 하나 등록하면 끝이었는데**, 모바일은 플랫폼마다 설정이 다르고, 인증서/키 관리까지 해야 합니다.

Google + Apple + Kakao 세 개를 전부 설정하는 데 하루 이상 걸렸습니다.




### 2. OAuth 토큰 검증 방식이 제공자마다 다름

웹에서는 OAuth Redirect 방식을 썼습니다.


1. 프론트 -> 구글 로그인 페이지로 redirect
2. 사용자 로그인
3. 구글 -> 백엔드 callback URL로 redirect (authorization code 포함)
4. 백엔드 -> 구글에 code로 토큰 교환
5. 백엔드 -> 프론트로 JWT 발급


**모바일은 다르다**

1. 앱 -> 구글 SDK로 로그인 (앱 내에서 처리)
2. 구글 SDK -> 앱에 idToken 반환
3. 앱 -> 백엔드로 idToken 전송
4. 백엔드 -> idToken 직접 검증 (redirect 없음!)
5. 백엔드 -> 앱에 JWT 발급


**redirect가 없습니다!** 백엔드가 직접 토큰을 검증해야 합니다.

> "For mobile apps, if an ID Token is provided from Google on the client-side, no redirection will happen, and the user can be signed in directly on the server."
>
> — [Google Developers - Verify Google ID Token](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)

문제는 제공자마다 검증 방식이 다르다는 것입니다.

| 제공자 | 토큰 타입 | 검증 방식 |
|--------|----------|----------|
| **Google** | `idToken` (JWT) | 공개키로 서명 검증 |
| **Apple** | `identityToken` (JWT) | 공개키 fetch + 24시간 캐싱 |
| **Kakao** | `accessToken` (불투명) | API 호출로 사용자 정보 조회 |

```java
// Google - 라이브러리 사용
GoogleIdToken googleIdToken = verifier.verify(idToken);

// Apple - 직접 JWT 파싱 + 공개키 관리
PublicKey publicKey = getApplePublicKey(kid);

// Kakao - REST API 호출
restTemplate.exchange("https://kapi.kakao.com/v2/user/me", ...);
```

**Apple이 제일 힘들었습니다.** 공개키 로테이션까지 처리해야 해서 24시간 캐싱 로직을 직접 구현했습니다.

> "Before using the token, you need to make sure that it was signed by Apple's private key. To do that, you need Apple's public key to verify the signature. You can get the public key from Apple's endpoint."
>
> — [Sarunw - Sign in with Apple: Backend Token Verification](https://sarunw.com/posts/sign-in-with-apple-3/)

#### Apple 공개키 로테이션, 왜 이렇게까지 해야 하나?

**Google은 라이브러리가 알아서 해준다:**

```java
// Google - 한 줄이면 끝
GoogleIdToken googleIdToken = verifier.verify(idToken);
```

Google API Client 라이브러리가 공개키 fetch, 캐싱, 로테이션 대응까지 전부 처리해줍니다.

**Apple은 공식 Java 라이브러리가 없다:**

```java
// Apple - 직접 구현해야 함
String kid = extractKidFromHeader(idToken);  // JWT 헤더 파싱
PublicKey publicKey = getApplePublicKey(kid); // 공개키 fetch + 캐싱
Claims claims = Jwts.parser().verifyWith(publicKey)...  // 검증
```

Apple은 iOS/macOS SDK만 제공하고, **서버 사이드 Java 라이브러리를 제공하지 않습니다.** 그래서 직접 구현해야 합니다:

1. JWT 헤더에서 `kid` (Key ID) 추출
2. Apple JWKS 엔드포인트(`https://appleid.apple.com/auth/keys`)에서 공개키 fetch
3. `kid`가 일치하는 키로 RSA 공개키 생성
4. JWT 서명 검증

**왜 캐싱이 필요한가?**

매 요청마다 Apple 서버에 공개키를 요청하면:
- 네트워크 레이턴시 추가 (해외 서버라 느림)
- Apple 서버 장애 시 우리 서비스도 장애
- 불필요한 외부 API 호출

그래서 **24시간 캐싱**을 구현했습니다:

![apple-public-key-cache](/uploads/project/Tymee/mobile-jwt-auth/apple-public-key-cache.png)


**왜 키 로테이션 대응이 필요한가?**

Apple은 보안상 주기적으로 서명 키를 교체합니다. 새 키가 생기면:

```
1. 새 JWT에는 새로운 kid가 포함됨
2. 캐시에 해당 kid가 없음 -> Apple에서 새로 fetch
3. 새 키를 캐시에 저장
4. 검증 성공
```

24시간마다 캐시를 클리어해서 오래된 키(Apple이 폐기한 키)가 남아있지 않게 했습니다.

**Google vs Apple 비교:**

| 항목 | Google | Apple |
|------|--------|-------|
| **공식 라이브러리** | 있음 | 없음 (Java) |
| **공개키 관리** | 라이브러리가 처리 | 직접 구현 |
| **캐싱** | 자동 | 직접 구현 |
| **키 로테이션** | 자동 | 직접 대응 |
| **구현 난이도** | 쉬움 (1줄) | 어려움 (50줄+) |

1인 개발자 입장에서 Apple Sign In이 제일 힘들었던 이유입니다.

---

### 3. Refresh Token 탈취 감지 로직

웹에서는 HttpOnly 쿠키라 JavaScript로 접근 자체가 불가능했습니다. 탈취 감지가 필요 없었습니다.

**모바일은 다릅니다.** 앱 저장소가 탈취되면 토큰이 노출될 수 있습니다.

Refresh Token 저장소로 DB(MySQL)와 Redis를 비교했습니다. DB에 저장하면 추가 인프라가 필요 없지만, 토큰 갱신은 매 Access Token 만료마다 발생해서 읽기/쓰기가 빈번합니다. MySQL은 디스크 기반이라 단순 키-값 조회에도 수 ms가 걸리고, 커넥션 풀을 소비합니다. Redis는 인메모리라 같은 작업이 sub-ms로 끝나고, TTL 설정으로 만료된 토큰이 자동 삭제됩니다. Oracle Cloud Free Tier에서 Redis를 직접 설치해서 추가 비용 없이 운영하고 있습니다.

그래서 **Redis에 Refresh Token을 저장**하고, 요청마다 비교합니다:

![refresh-token-reuse-detection](/uploads/project/Tymee/mobile-jwt-auth/refresh-token-reuse-detection.png)


Refresh Token Rotation + Reuse Detection은 OAuth 2.0 보안 권장사항입니다.

> "With refresh token rotation, you can detect if a token is being reused (which suggests theft), and immediately revoke the session. When a used token shows up again, it's a massive red flag. If RT_1 is used a second time, the server knows a breach happened. It should immediately revoke the entire token family."
>
> — [WorkOS - Why Your App Needs Refresh Tokens](https://workos.com/blog/why-your-app-needs-refresh-tokens-and-how-they-work)

> "Like passwords, treat refresh tokens as secrets: Store a hashed version (e.g., SHA-256) of the token. When validating, hash the incoming token and compare it with the stored hash."
>
> — [Serverion - Refresh Token Rotation Best Practices](https://www.serverion.com/uncategorized/refresh-token-rotation-best-practices-for-developers/)

**동작 원리**

**정상 사용자**
1. Refresh Token 발급 -> Redis에 저장
2. 토큰 갱신 요청 -> Redis 값과 비교 -> 일치 -> 새 토큰 발급

**토큰 탈취 시**
1. 공격자가 Refresh Token 탈취
2. 정상 사용자가 먼저 갱신 -> Redis에 새 토큰 저장
3. 공격자가 이전 토큰으로 갱신 시도 -> Redis 값과 불일치!
4. -> 모든 기기 강제 로그아웃

웹에서는 생각도 못했던 로직입니다.

---

### 4. 디바이스별 세션 관리

웹은 쿠키가 브라우저 단위라 세션 관리가 단순했습니다.

모바일은 **deviceId별로 독립 세션**을 관리해야 합니다:


**Redis 키 구조**
refresh_token:{userId}:{deviceId} -> "eyJ..."
user_devices:{userId} -> {device1, device2, ...}


> "Tokens can be stored with a key pattern `{userID}:{tokenID}`. This allows using a Redis SCAN operation to invalidate all of a user's refresh tokens if needed, which would be necessary if the user wanted to sign out of all devices."
>
> — [DEV.to - Store Refresh Tokens in Redis](https://dev.to/jacobsngoodwin/12-store-refresh-tokens-in-redis-1k5d)

**세 가지 로그아웃 시나리오:**

![device-logout-scenarios](/uploads/project/Tymee/mobile-jwt-auth/device-logout-scenarios.png)


---

### 5. 사용자 상태 관리 복잡도

웹에서는 단순했습니다. 로그인/로그아웃만 관리하면 됐습니다.

모바일은 **상태 머신**이 복잡합니다:

![user-state-machine](/uploads/project/Tymee/mobile-jwt-auth/user-state-machine.png)


---

### 6. Swagger 테스트 환경 - DevAuthController

웹에서는 브라우저로 직접 로그인하면 쿠키가 저장되니까 Swagger 테스트도 쉬웠습니다.

**모바일 OAuth는 앱에서만 동작합니다.** Swagger에서 테스트할 방법이 없습니다.

Google OAuth Playground로 토큰 발급받아서 테스트하려고 했는데:

```
Google token verification failed
```

**왜?** OAuth Playground의 client_id가 우리 앱의 client_id와 다르기 때문이다.

```
우리 앱: 123456789.apps.googleusercontent.com
OAuth Playground: 407408718192.apps.googleusercontent.com
```

JWT의 `aud` 클레임 검증에서 실패합니다.

**해결책: DevAuthController**

![dev-auth-controller](/uploads/project/Tymee/mobile-jwt-auth/dev-auth-controller.png)


로컬/테스트 환경에서만 동작하는 개발용 로그인 API를 만들었습니다.

> "You can use Spring Profiles to enable/disable security configuration based on the environment. Disabling Spring Security is useful in the development and testing phases to quickly bypass authentication layers. However, it should be avoided in production environments."
>
> — [Baeldung - Disable Security for a Profile](https://www.baeldung.com/spring-security-disable-profile)

> "There are two ways to fake OAuth2 SSO in Spring: bypass the authentication altogether, or mock the authorization server. `@Profile(Profiles.NO_AUTH)` annotation is used to disable authentication only when the application is run with the 'noauth' profile."
>
> — [Baeldung - Faking OAuth2 Single Sign-on](https://www.baeldung.com/spring-oauth2-mock-sso)

Mock OAuth 서버를 쓰는 방법도 있지만, 1인 개발에선 DevAuthController가 가장 간단합니다:

> "Beeceptor's mock OAuth 2.0 server gives you a fully functional, no-setup-required OAuth provider. You don't need client secrets, you don't even need valid credentials. The mock server accepts any input and gives you back a realistic access token."
>
> — [Beeceptor - OAuth 2.0 Mock Usage](https://beeceptor.com/docs/tutorials/oauth-2-0-mock-usage/)

---

## 아키텍처 흐름도

### 웹 (쿠키 기반)

![web-cookie-flow](/uploads/project/Tymee/mobile-jwt-auth/web-cookie-flow.png)

### 모바일 (현재 구현)

![mobile-auth-flow](/uploads/project/Tymee/mobile-jwt-auth/mobile-auth-flow.png)

---

## 웹과 다르게 신경 써야 했던 것들 정리

| 항목 | 웹 (쿠키) | 모바일 (헤더) |
|------|----------|--------------|
| **OAuth 설정** | redirect URI 하나 | 플랫폼별 설정 + 인증서/키 관리 |
| **OAuth 검증** | 서버가 code로 토큰 교환 | 서버가 직접 토큰 서명 검증 |
| **토큰 저장** | 브라우저가 관리 | 앱이 Keychain에 저장 |
| **토큰 전송** | 자동 (쿠키) | 수동 (Authorization 헤더) |
| **탈취 감지** | 불필요 (HttpOnly) | Redis 값 비교 필수 |
| **세션 관리** | 브라우저 단위 | deviceId 단위 |
| **로그아웃** | 쿠키 삭제 | Redis 토큰 삭제 |
| **Swagger 테스트** | 브라우저 로그인 | DevAuthController 필요 |

---

## 결론

같은 JWT인데 환경에 따라 완전히 다른 아키텍처가 필요합니다.
웹에서는 HttpOnly Cookie로 XSS를 방어하고 브라우저가 쿠키를 자동 관리해주지만, 모바일은 네이티브 앱에 쿠키 개념이 없어서 Authorization 헤더를 쓰고 OS 레벨 보안 저장소(Keychain/Keystore)에 토큰을 저장합니다.

웹 개발할 때는 "HttpOnly 쿠키 쓰면 끝"이었는데, 모바일은 OAuth 설정만 해도 Google/Apple/Kakao 각각 플랫폼별로 다르고 인증서 관리까지 해야 합니다.
각 환경의 위협 모델을 이해하고 그에 맞는 방어 전략을 선택하는 게 핵심입니다.

---

## 참고 자료

### JWT & OAuth 보안
- [Curity - OAuth for Mobile Apps Best Practices](https://curity.io/resources/learn/oauth-for-mobile-apps-best-practices/)
- [Duende Software - JWT Best Practices for Web & Mobile Apps](https://duendesoftware.com/learn/best-practices-using-jwts-with-web-and-mobile-apps)
- [Compile7 - JWT Best Practices for Mobile Apps](https://compile7.org/decompile/jwt-best-practices-for-mobile-apps)
- [WorkOS - OAuth and JWT Best Practices](https://workos.com/blog/oauth-and-jwt-how-to-use-and-best-practices)

### Refresh Token & Redis
- [Redis - Mobile Banking Session Management](https://redis.io/learn/howtos/solutions/mobile-banking/session-management)
- [Redis - Authentication Token Storage](https://redis.io/solutions/authentication-token-storage/)
- [WorkOS - Why Your App Needs Refresh Tokens](https://workos.com/blog/why-your-app-needs-refresh-tokens-and-how-they-work)
- [Serverion - Refresh Token Rotation Best Practices](https://www.serverion.com/uncategorized/refresh-token-rotation-best-practices-for-developers/)
- [DEV.to - Store Refresh Tokens in Redis](https://dev.to/jacobsngoodwin/12-store-refresh-tokens-in-redis-1k5d)

### Apple Sign In
- [Apple Developer - Token Validation](https://developer.apple.com/documentation/signinwithapplerestapi/generate-and-validate-tokens)
- [Apple Developer - Verifying a User](https://developer.apple.com/documentation/signinwithapple/verifying-a-user)
- [Sarunw - Sign in with Apple: Backend Token Verification](https://sarunw.com/posts/sign-in-with-apple-3/)
- [DEV.to - Complete Guide to Apple OAuth 2.0](https://dev.to/varsilias/complete-guide-to-implementing-apple-oauth-20sign-in-with-apple-authentication-in-a-nodeexpress-application-4hf)

### Google OAuth
- [Google Developers - OAuth 2.0 for iOS & Desktop Apps](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Google Developers - Verify Google ID Token](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)

### 개발 환경 테스트
- [Baeldung - Faking OAuth2 Single Sign-on](https://www.baeldung.com/spring-oauth2-mock-sso)
- [Baeldung - Disable Security for a Profile](https://www.baeldung.com/spring-security-disable-profile)
- [Beeceptor - OAuth 2.0 Mock Usage](https://beeceptor.com/docs/tutorials/oauth-2-0-mock-usage/)
- [GitHub - navikt/mock-oauth2-server](https://github.com/navikt/mock-oauth2-server)

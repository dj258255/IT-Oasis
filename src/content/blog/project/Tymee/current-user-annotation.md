---
title: '@CurrentUser 커스텀 어노테이션을 사용하는 이유'
titleEn: 'Why Use a @CurrentUser Custom Annotation'
description: Spring Security에서 로그인 사용자 정보를 가져오는 방법을 비교하고, @CurrentUser 커스텀 어노테이션으로 의존성을 관리한 과정을 정리한다.
descriptionEn: Compares methods for retrieving logged-in user info in Spring Security and documents managing dependencies with a @CurrentUser custom annotation.
date: 2025-12-03T00:00:00.000Z
tags:
  - Spring Security
  - JWT
  - Authentication
  - Custom Annotation
  - ArgumentResolver
category: project/Tymee
draft: false
coverImage: "/uploads/project/Tymee/current-user-annotation/security-context-holder-direct.png"
---

Spring Security로 JWT 인증을 구현하면서 로그인한 사용자 정보를 컨트롤러에서 어떻게 가져올지 고민했어요. 여러 방법을 비교해보고 `@CurrentUser` 커스텀 어노테이션을 만들어서 사용하기로 했는데, 그 과정을 정리해봤습니다.

---

## 로그인 객체를 가져오는 방법들

### 1. SecurityContextHolder에서 직접 가져오기

![security-context-holder-direct](/uploads/project/Tymee/current-user-annotation/security-context-holder-direct.png)

가장 원시적인 방법인데, 매번 이 코드를 작성해야 해서 귀찮아요. null 체크도 직접 해야 하고, 테스트 코드 짜기도 번거롭습니다.

### 2. Controller 파라미터로 Principal 받기

![principal-parameter](/uploads/project/Tymee/current-user-annotation/principal-parameter.png)

`Principal`은 Java 표준 인터페이스라서 `getName()` 밖에 없어요. userId나 role 같은 커스텀 정보를 쓸 수가 없어서 실용성이 떨어집니다.

### 3. @AuthenticationPrincipal 사용

![authentication-principal](/uploads/project/Tymee/current-user-annotation/authentication-principal.png)

Spring Security 3.2부터 지원하는 방식이에요. 커스텀 로그인 객체를 바로 주입받을 수 있어서 제일 편합니다.

---

## @AuthenticationPrincipal은 어떻게 동작할까?

### AuthenticationPrincipalArgumentResolver

![argument-resolver](/uploads/project/Tymee/current-user-annotation/argument-resolver.png)

결국 내부적으로는 `SecurityContextHolder.getContext().getAuthentication().getPrincipal()`을 호출해요. 그냥 Spring이 이 과정을 자동으로 해주는 것뿐이에요.

### JWT 환경에서의 흐름

![jwt-auth-flow](/uploads/project/Tymee/current-user-annotation/jwt-auth-flow.png)

---

## 실제 구현 코드

### UserPrincipal

![user-principal](/uploads/project/Tymee/current-user-annotation/user-principal.png)

### JwtUtil

![jwt-util](/uploads/project/Tymee/current-user-annotation/jwt-util.png)

### JwtAuthenticationFilter

![jwt-authentication-filter](/uploads/project/Tymee/current-user-annotation/jwt-authentication-filter.png)

JWT 토큰에서 claim을 파싱해서 `UserPrincipal`을 만들고, `SecurityContextHolder`에 저장해요. 여기서 DB 조회는 전혀 없습니다.

### @CurrentUser 커스텀 어노테이션

![current-user-annotation](/uploads/project/Tymee/current-user-annotation/current-user-annotation.png)

`@AuthenticationPrincipal`을 메타 어노테이션으로 감싸서 `@CurrentUser`를 만들었어요.

### Controller에서 사용

![controller-usage](/uploads/project/Tymee/current-user-annotation/controller-usage.png)

---

## 근데 @CurrentUser를 왜 써?

셋 다 결국 `SecurityContextHolder`에서 principal을 가져오는 건 똑같아요.

```java
SecurityContextHolder.getContext().getAuthentication().getPrincipal();
```

그럼 왜 굳이 커스텀 어노테이션을 만들었냐면, `@AuthenticationPrincipal`을 직접 쓰면 모든 컨트롤러에 Spring Security import가 들어가거든요. `@CurrentUser`로 감싸면 그 의존성이 어노테이션 파일 하나에만 집중돼요. 나중에 Principal 구조가 바뀌어도 한 곳만 고치면 되니까 편합니다.

Spring Security 공식 문서에서도 이 방식을 권장해요:

> "You can further remove your dependency on Spring Security by making `@AuthenticationPrincipal` a meta annotation on your own annotation."

---

## 주의할 점: NPE

인증이 필요 없는 API에서 `@CurrentUser`를 쓰면 null이 들어와요.

```java
@GetMapping("/public/info")
public ApiResponse<Info> getPublicInfo(
        @CurrentUser UserPrincipal currentUser) {
    // 토큰 없이 요청하면 currentUser가 null
    Long userId = currentUser.userId();  // NPE!
}
```

### 해결법: @PreAuthorize랑 같이 쓰기

```java
@GetMapping("/{id}")
@PreAuthorize("isAuthenticated()")  // 인증 안 되면 여기서 막힘
public ApiResponse<UserResponse> getUser(
        @CurrentUser UserPrincipal currentUser,  // null 아님 보장
        @PathVariable Long id) {
    // ...
}
```

`@PreAuthorize`는 인증 안 된 요청을 차단하고, `@CurrentUser`는 principal을 주입해줘요. 그래서 인증 필수 API에서는 둘 다 붙여주는 게 안전합니다.

### 선택적 인증이 필요하면?

로그인 안 해도 되는데 로그인하면 추가 정보를 보여주는 API가 있다면 (예: 인스타그램 게시글 - 비로그인은 그냥 보기, 로그인하면 좋아요 눌렀는지 표시), 커스텀 ArgumentResolver를 만들어서 null 처리를 해주면 돼요.

지금 프로젝트는 모바일 앱 전용이라 거의 다 인증 필수라서 안 만들었습니다.

---

## 속도는?

JWT라서 DB 조회가 없어요. 토큰 파싱만 하면 끝이라 0.1ms 정도 걸립니다. 세션 방식은 매 요청마다 DB나 Redis를 조회해야 해서 5~20ms 정도 걸리는데, 비교하면 꽤 차이나요. 물론 세션도 장점이 있지만 (토큰 탈취 시 즉시 무효화 등), 모바일 앱에서는 JWT가 더 맞는 것 같습니다.

---

## 전체 흐름

```
[로그인]
POST /auth/login
  -> AuthService.login()
  -> JwtUtil.generateTokenPair(userId, email, role)
  -> 클라이언트에 토큰 반환

[API 요청]
GET /users/{id} (Authorization: Bearer {token})
  -> JwtAuthenticationFilter
     -> 토큰 파싱 -> UserPrincipal 생성 -> SecurityContext에 저장
  -> AuthenticationPrincipalArgumentResolver
     -> SecurityContext에서 principal 꺼내서 @CurrentUser에 주입
  -> UserController.getUser() 실행
```

---

## 정리

`@AuthenticationPrincipal`은 결국 `SecurityContextHolder`에서 가져오는 거고, `@CurrentUser`로 감싸면 의존성 관리가 좀 더 깔끔해져요. 인증 필수 API에서는 `@PreAuthorize`랑 같이 쓰면 NPE 걱정 없이 쓸 수 있습니다.

---

## 참고

- [Spring Security - AuthenticationPrincipal](https://docs.spring.io/spring-security/site/docs/current/api/org/springframework/security/core/annotation/AuthenticationPrincipal.html)
- [Baeldung - Retrieve User Information in Spring Security](https://www.baeldung.com/get-user-in-spring-security)
- [@AuthenticationPrincipal 동작 원리 - Jian's Tech Blog](https://codevang.tistory.com/273)

<!-- EN -->

While implementing JWT authentication with Spring Security, I had to figure out how to retrieve the logged-in user's information in controllers. After comparing several approaches, I decided to create and use a `@CurrentUser` custom annotation. Here is a summary of that process.

---

## Ways to Retrieve the Logged-In Object

### 1. Directly from SecurityContextHolder

![security-context-holder-direct](/uploads/project/Tymee/current-user-annotation/security-context-holder-direct.png)

This is the most primitive approach. You have to write this code every time, which is tedious. You also have to handle null checks yourself, and writing tests becomes cumbersome.

### 2. Receiving Principal as a Controller Parameter

![principal-parameter](/uploads/project/Tymee/current-user-annotation/principal-parameter.png)

`Principal` is a Java standard interface that only has `getName()`. You cannot access custom information like userId or role, which limits its practicality.

### 3. Using @AuthenticationPrincipal

![authentication-principal](/uploads/project/Tymee/current-user-annotation/authentication-principal.png)

This approach has been available since Spring Security 3.2. It lets you inject a custom principal object directly, making it the most convenient option.

---

## How Does @AuthenticationPrincipal Work?

### AuthenticationPrincipalArgumentResolver

![argument-resolver](/uploads/project/Tymee/current-user-annotation/argument-resolver.png)

Under the hood, it calls `SecurityContextHolder.getContext().getAuthentication().getPrincipal()`. Spring simply automates this process for you.

### Flow in a JWT Environment

![jwt-auth-flow](/uploads/project/Tymee/current-user-annotation/jwt-auth-flow.png)

---

## Actual Implementation Code

### UserPrincipal

![user-principal](/uploads/project/Tymee/current-user-annotation/user-principal.png)

### JwtUtil

![jwt-util](/uploads/project/Tymee/current-user-annotation/jwt-util.png)

### JwtAuthenticationFilter

![jwt-authentication-filter](/uploads/project/Tymee/current-user-annotation/jwt-authentication-filter.png)

It parses the claims from the JWT token, creates a `UserPrincipal`, and stores it in the `SecurityContextHolder`. There is no DB lookup involved here at all.

### @CurrentUser Custom Annotation

![current-user-annotation](/uploads/project/Tymee/current-user-annotation/current-user-annotation.png)

I wrapped `@AuthenticationPrincipal` as a meta-annotation to create `@CurrentUser`.

### Usage in Controller

![controller-usage](/uploads/project/Tymee/current-user-annotation/controller-usage.png)

---

## But Why Use @CurrentUser?

All three approaches ultimately do the same thing -- they retrieve the principal from `SecurityContextHolder`.

```java
SecurityContextHolder.getContext().getAuthentication().getPrincipal();
```

So why bother creating a custom annotation? If you use `@AuthenticationPrincipal` directly, every controller ends up with a Spring Security import. By wrapping it with `@CurrentUser`, that dependency is concentrated in a single annotation file. If the Principal structure changes later, you only need to modify one place.

The Spring Security official documentation also recommends this approach:

> "You can further remove your dependency on Spring Security by making `@AuthenticationPrincipal` a meta annotation on your own annotation."

---

## Watch Out: NPE

If you use `@CurrentUser` on an API that does not require authentication, null gets injected.

```java
@GetMapping("/public/info")
public ApiResponse<Info> getPublicInfo(
        @CurrentUser UserPrincipal currentUser) {
    // If requested without a token, currentUser is null
    Long userId = currentUser.userId();  // NPE!
}
```

### Solution: Use It Together with @PreAuthorize

```java
@GetMapping("/{id}")
@PreAuthorize("isAuthenticated()")  // Blocks unauthenticated requests here
public ApiResponse<UserResponse> getUser(
        @CurrentUser UserPrincipal currentUser,  // Guaranteed non-null
        @PathVariable Long id) {
    // ...
}
```

`@PreAuthorize` blocks unauthenticated requests, and `@CurrentUser` injects the principal. So for APIs that require authentication, using both is the safe approach.

### What If Optional Authentication Is Needed?

If there is an API where login is optional but logged-in users see extra information (e.g., an Instagram post -- non-logged-in users can just view it, logged-in users see whether they liked it), you can create a custom ArgumentResolver to handle the null case.

In this project, since it is a mobile-app-only API where almost everything requires authentication, I did not build one.

---

## Performance?

Since it uses JWT, there is no DB lookup. Token parsing is all it takes, which runs in about 0.1ms. Session-based approaches require a DB or Redis lookup on every request, taking around 5-20ms -- a significant difference. Sessions do have their advantages (like immediate token revocation upon theft), but for a mobile app, JWT seems like the better fit.

---

## End-to-End Flow

```
[Login]
POST /auth/login
  -> AuthService.login()
  -> JwtUtil.generateTokenPair(userId, email, role)
  -> Return token to client

[API Request]
GET /users/{id} (Authorization: Bearer {token})
  -> JwtAuthenticationFilter
     -> Parse token -> Create UserPrincipal -> Store in SecurityContext
  -> AuthenticationPrincipalArgumentResolver
     -> Extract principal from SecurityContext and inject into @CurrentUser
  -> UserController.getUser() executes
```

---

## Summary

`@AuthenticationPrincipal` ultimately retrieves the principal from `SecurityContextHolder`, and wrapping it with `@CurrentUser` makes dependency management cleaner. For APIs that require authentication, combining it with `@PreAuthorize` eliminates NPE concerns.

---

## References

- [Spring Security - AuthenticationPrincipal](https://docs.spring.io/spring-security/site/docs/current/api/org/springframework/security/core/annotation/AuthenticationPrincipal.html)
- [Baeldung - Retrieve User Information in Spring Security](https://www.baeldung.com/get-user-in-spring-security)
- [@AuthenticationPrincipal 동작 원리 - Jian's Tech Blog](https://codevang.tistory.com/273)

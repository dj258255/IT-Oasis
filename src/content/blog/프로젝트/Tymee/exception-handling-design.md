---
title: '예외 처리 설계'
titleEn: 'Exception Handling Design'
description: Spring의 여러 예외 처리 방법을 비교하고, @ControllerAdvice + 커스텀 에러 코드 + 통일된 응답 포맷을 선택한 이유를 정리한다.
descriptionEn: Compares Spring exception handling approaches and explains the choice of @ControllerAdvice with custom error codes and unified response format.
date: 2025-11-17T00:00:00.000Z
tags:
  - Spring
  - Exception Handling
  - ControllerAdvice
  - Error Code
  - RFC 9457
  - REST API
category: 프로젝트/Tymee
draft: false
---

> 왜 이 방식을 선택했는가

---

## 1. 다른 방법들과 비교

Spring에서 예외를 처리하는 방법은 여러 가지가 있다. 검토한 것들을 정리한다.

**@ResponseStatus**: 간단하지만 `sendError()`로 HTML 에러 페이지가 반환되어 REST API에 부적합하다.

**ResponseStatusException**: 프로토타이핑에 빠르지만, 여러 컨트롤러에서 같은 로직이 반복되고 Service 레이어에서 던지기 애매하다.

**@ExceptionHandler (컨트롤러 레벨)**: 해당 컨트롤러 안에서는 잘 동작하지만, 다른 컨트롤러에서 재사용이 안 된다.

**@ControllerAdvice (전역)**: 모든 컨트롤러에 적용되고 통일된 응답 포맷을 보장한다. 예외가 어디서 처리되는지 추적이 약간 어려울 수 있지만, Spring 개발자라면 익숙한 패턴이다.

**Zalando Problem**: RFC 9457을 완벽 지원하고 기본 핸들러 20개 이상을 제공하지만, 외부 라이브러리 의존성이 추가되고 1인 프로젝트에는 과하다.

**Vavr Either/Try**: 함수형으로 에러를 값으로 반환하는 방식. 명시적이지만 러닝 커브가 높고 Spring 생태계와 맞지 않는다.

---

## 2. @ControllerAdvice + 커스텀 예외를 선택했다.

### 선택 기준

| 항목 | 중요도 |
|------|--------|
| 구현 단순함 | 1등 |
| 외부 의존성 최소화 | 2등 |
| 일관된 응답 포맷 | 3등 |
| 확장 가능성 | 4등 |
| 표준 준수 (RFC 9457) | 5등 |

### 결정

```
ResponseStatusException  -> 코드 중복, 통일성 없음
Zalando Problem         -> 외부 라이브러리, 오버스펙
Vavr Either             -> 러닝 커브, Spring과 안 맞음
@ControllerAdvice       -> 단순하고, 표준적이고, 확장 가능
```

1인 프로젝트에서 **가장 실용적인 선택**은 Spring 기본 기능인 `@ControllerAdvice`다.

- 외부 라이브러리 없음
- Spring 개발자라면 누구나 이해
- 필요하면 나중에 RFC 9457로 마이그레이션 가능

---

## 3. 내부 동작 원리

`@ControllerAdvice`가 어떻게 동작하는지 구현하면서 알게 된 부분을 정리한다.

### 예외 해결 순서

예외가 발생하면 Spring의 `HandlerExceptionResolverComposite`가 순서대로 Resolver를 실행한다:

1. **ExceptionHandlerExceptionResolver** (order = 0): `@ExceptionHandler` 메서드 실행
2. **ResponseStatusExceptionResolver** (order = 1): `@ResponseStatus` 어노테이션 확인
3. **DefaultHandlerExceptionResolver** (order = MAX_VALUE): Spring 내장 예외를 HTTP 상태 코드로 변환

같은 예외를 처리하는 핸들러가 여러 개면 Controller 내부 `@ExceptionHandler`가 최우선이고, 그다음 `@ControllerAdvice`다.

### @ControllerAdvice 예외 매칭

```java
throw new EntityNotFoundException("User not found");
```
이 예외가 발생하면 정확히 일치하는 핸들러를 먼저 찾고, 없으면 `EntityNotFoundException → BusinessException → RuntimeException → Exception` 순서로 상위 클래스를 타고 올라가며 가장 구체적인 핸들러가 선택된다.

### Filter 예외는 별도 처리가 필요하다

`@ControllerAdvice`는 **DispatcherServlet 이후**에만 동작한다. JWT 인증 필터 같은 Filter에서 발생한 예외는 `@ControllerAdvice`로 잡히지 않는다.

![filter-exception-scope](/uploads/exception-handling-design/filter-exception-scope.png)

Filter에서는 직접 try-catch로 에러 응답을 작성하거나, `/error`로 포워딩해서 `BasicErrorController`가 처리하게 해야 한다.

![filter-exception-handling](/uploads/exception-handling-design/filter-exception-handling.png)

---

## 4. 커스텀 에러 코드가 필요한 이유

### HTTP 상태 코드만으로는 부족하다

REST API에서 에러가 발생하면 HTTP 상태 코드를 반환한다.

```
400 Bad Request
401 Unauthorized
404 Not Found
500 Internal Server Error
```

문제는 **같은 상태 코드여도 원인이 다를 수 있다**는 것.

```
404 Not Found
├── 사용자를 찾을 수 없음
├── 파일을 찾을 수 없음
└── 게시글을 찾을 수 없음
```

클라이언트 입장에서 404만 받으면 **뭐가 없는 건지 알 수 없다**.

Google API Design 가이드에서도 "Errors therefore become a key tool providing context and visibility into how to use an API"라고 강조한다.

> 출처: [RESTful API Design: What About Errors? - Google Cloud Blog](https://cloud.google.com/blog/products/api-management/restful-api-design-what-about-errors)

---

### 클라이언트가 에러를 구분할 수 있다

```json
{
  "success": false,
  "error": {
    "code": "U001",
    "message": "사용자를 찾을 수 없습니다"
  }
}
```

```json
{
  "success": false,
  "error": {
    "code": "F001",
    "message": "파일을 찾을 수 없습니다"
  }
}
```

같은 404여도 `U001`과 `F001`로 구분할 수 있다.

### 에러 코드로 분기 처리 가능

```javascript
// 클라이언트 코드
if (error.code === 'A002') {
  // 토큰 만료 → 리프레시 토큰으로 재발급 시도
  await refreshToken();
} else if (error.code === 'A003') {
  // 유효하지 않은 토큰 → 로그인 페이지로 이동
  navigateTo('/login');
}
```

HTTP 상태 코드만으로는 이런 세밀한 분기가 어렵다.

### 다국어 지원이 쉽다

```javascript
const errorMessages = {
  'U001': {
    ko: '사용자를 찾을 수 없습니다',
    en: 'User not found'
  },
  'A002': {
    ko: '토큰이 만료되었습니다',
    en: 'Token has expired'
  }
};
```

에러 코드를 키로 사용해서 다국어 메시지를 매핑할 수 있다.

> 출처: [Best Practices for API Error Handling - Postman Blog](https://blog.postman.com/best-practices-for-api-error-handling/)

---

## 5. RFC 9457 (Problem Details) 표준

현대 API는 **RFC 9457 Problem Details** 표준을 따르는 것이 권장된다. Spring Framework 6.0+에서 기본 지원한다.

```json
{
  "type": "https://example.com/errors/user-not-found",
  "title": "User Not Found",
  "status": 404,
  "detail": "사용자 ID 123을 찾을 수 없습니다",
  "instance": "/users/123"
}
```

Spring Boot에서 활성화:
```yaml
spring:
  mvc:
    problemdetails:
      enabled: true
```

이 프로젝트에서는 RFC 9457을 완전히 따르지 않고, 단순화된 커스텀 응답 포맷을 사용한다. 필요시 마이그레이션 가능.

> 출처: [Error Responses - Spring Framework 공식 문서](https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-ann-rest-exceptions.html)

---

## 6. 에러 코드 네이밍 규칙

```
[도메인 prefix][순번]
```

| Prefix | 도메인 | 예시 |
|--------|--------|------|
| C | Common (공통) | C001, C002 |
| A | Auth (인증) | A001, A002 |
| U | User (사용자) | U001, U002 |
| F | File/Upload (파일) | F001, F002 |

### 현재 정의된 에러 코드

**Common (C)**

| 코드 | HTTP | 설명 |
|------|------|------|
| C001 | 400 | 잘못된 입력값 |
| C002 | 404 | 엔티티를 찾을 수 없음 |
| C003 | 500 | 서버 내부 오류 |
| C004 | 405 | 허용되지 않은 HTTP 메서드 |
| C005 | 403 | 접근 권한 없음 |

**Auth (A)**

| 코드 | HTTP | 설명 |
|------|------|------|
| A001 | 401 | 이메일/비밀번호 불일치 |
| A002 | 401 | 토큰 만료 |
| A003 | 401 | 유효하지 않은 토큰 |
| A004 | 401 | 리프레시 토큰 없음 |
| A005 | 401 | 인증 필요 |

**User (U)**

| 코드 | HTTP | 설명 |
|------|------|------|
| U001 | 404 | 사용자 없음 |
| U002 | 409 | 이메일 중복 |
| U003 | 409 | 닉네임 중복 |
| U004 | 400 | 이미 탈퇴한 사용자 |
| U005 | 403 | 정지된 사용자 |
| U006 | 403 | 차단된 사용자 |

**Upload (F)**

| 코드 | HTTP | 설명 |
|------|------|------|
| F001 | 404 | 파일 없음 |
| F002 | 400 | 파일 크기 초과 |
| F003 | 400 | 지원하지 않는 형식 |
| F004 | 500 | 업로드 실패 |
| F005 | 400 | 이미 삭제된 파일 |

> 출처: [REST API Error Codes 101 - REST Case](https://blog.restcase.com/rest-api-error-codes-101/)

---

## 7. 예외 클래스 구조

```
RuntimeException
    └── BusinessException (비즈니스 예외 기본 클래스)
            └── EntityNotFoundException (404 전용)
```

### BusinessException

모든 비즈니스 예외의 부모 클래스.

![business-exception-class](/uploads/exception-handling-design/business-exception-class.png)


### 사용 예시

```java
// 서비스 레이어
if (userRepository.existsByEmail(email)) {
    throw new BusinessException(ErrorCode.DUPLICATE_EMAIL);
}

// 404 전용
User user = userRepository.findById(id)
    .orElseThrow(() -> new EntityNotFoundException(ErrorCode.USER_NOT_FOUND));
```

> 출처: [Exception Handling in Spring MVC - Spring 공식 블로그](https://spring.io/blog/2013/11/01/exception-handling-in-spring-mvc/)

---

## 8. GlobalExceptionHandler

`@RestControllerAdvice`는 모든 컨트롤러에서 발생하는 예외를 **한 곳에서 처리**할 수 있게 해준다.

![global-exception-handler](/uploads/exception-handling-design/global-exception-handler.png)


### 처리하는 예외 목록

| 예외 | HTTP | 설명 |
|------|------|------|
| EntityNotFoundException | 404 | 엔티티 없음 |
| BusinessException | 동적 | 비즈니스 로직 예외 |
| MethodArgumentNotValidException | 400 | @Valid 검증 실패 |
| MissingServletRequestParameterException | 400 | 필수 파라미터 누락 |
| MethodArgumentTypeMismatchException | 400 | 파라미터 타입 불일치 |
| IllegalArgumentException | 400 | 잘못된 인자 |
| IllegalStateException | 409 | 잘못된 상태 |
| AccessDeniedException | 403 | 접근 거부 |
| AuthenticationException | 401 | 인증 실패 |
| HttpRequestMethodNotSupportedException | 405 | HTTP 메서드 불일치 |
| MaxUploadSizeExceededException | 400 | 파일 크기 초과 |
| Exception | 500 | 그 외 모든 예외 |

> 출처: [Spring Boot Global Exception Handling with @RestControllerAdvice - Jose López](https://josealopez.dev/en/blog/spring-boot-global-exception-handling)

---

## 9. 통일된 응답 포맷

### ApiResponse

![api-response-class](/uploads/exception-handling-design/api-response-class.png)


### 성공 응답

```json
{
  "success": true,
  "data": {
    "id": 1,
    "nickname": "홍길동"
  },
  "timestamp": "2024-01-15T10:30:00"
}
```

### 실패 응답

```json
{
  "success": false,
  "error": {
    "code": "U002",
    "message": "이미 사용 중인 이메일입니다"
  },
  "timestamp": "2024-01-15T10:30:00"
}
```

### Validation 실패 응답 (상세 정보 포함)

```json
{
  "success": false,
  "error": {
    "code": "C001",
    "message": "입력값 검증에 실패했습니다",
    "details": {
      "email": "이메일 형식이 올바르지 않습니다",
      "password": "비밀번호는 8자 이상이어야 합니다"
    }
  },
  "timestamp": "2024-01-15T10:30:00"
}
```

> 출처: [Best Practices for Consistent API Error Handling - Zuplo](https://zuplo.com/learning-center/best-practices-for-api-error-handling)

---

## 10. 보안 고려사항

프로덕션 환경에서는 내부 정보 노출에 주의해야 한다.

### 하지 말아야 할 것

```json
{
  "error": "NullPointerException at UserService.java:42",
  "stackTrace": "..."
}
```

스택 트레이스, 파일 경로, 라이브러리 버전 등이 노출되면 공격자에게 취약점 정보를 제공하게 된다.

### 해야 할 것

```json
{
  "code": "C003",
  "message": "서버 내부 오류가 발생했습니다"
}
```

내부적으로는 로그에 상세 정보를 남기고, 클라이언트에는 일반적인 메시지만 반환한다.

> 출처: [REST API Error Handling Best Practices - Speakeasy](https://www.speakeasy.com/api-design/errors)

---

## 11. 에러 코드 추가 방법

새로운 도메인이 생기면:

### 1. ErrorCode에 추가

```java
public enum ErrorCode {
    // ... 기존 코드

    // Study (새 도메인)
    STUDY_NOT_FOUND(404, "S001", "스터디를 찾을 수 없습니다"),
    STUDY_ALREADY_STARTED(400, "S002", "이미 시작된 스터디입니다");
}
```

### 2. 서비스에서 사용

```java
throw new BusinessException(ErrorCode.STUDY_NOT_FOUND);
```

GlobalExceptionHandler는 수정할 필요 없음. BusinessException을 상속하면 자동으로 처리된다.

---

## 참고 자료

- [Spring Rest - Exception Handling - DEV Community](https://dev.to/noelopez/spring-rest-exception-handling-part-1-1jj2)
- [Exception Handling in Spring MVC - Spring 공식 블로그](https://spring.io/blog/2013/11/01/exception-handling-in-spring-mvc/)
- [Spring Boot @ControllerAdvice & @ExceptionHandler - BezKoder](https://www.bezkoder.com/spring-boot-controlleradvice-exceptionhandler/)
- [zalando/problem-spring-web - GitHub](https://github.com/zalando/problem-spring-web)
- [Vavr User Guide](https://docs.vavr.io/)
- [RESTful API Design: What About Errors? - Google Cloud Blog](https://cloud.google.com/blog/products/api-management/restful-api-design-what-about-errors)
- [Best Practices for API Error Handling - Postman Blog](https://blog.postman.com/best-practices-for-api-error-handling/)
- [Error Responses - Spring Framework 공식 문서](https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-ann-rest-exceptions.html)
- [Spring Boot Global Exception Handling - Jose López](https://josealopez.dev/en/blog/spring-boot-global-exception-handling)
- [REST API Error Codes 101 - REST Case](https://blog.restcase.com/rest-api-error-codes-101/)
- [Best Practices for Consistent API Error Handling - Zuplo](https://zuplo.com/learning-center/best-practices-for-api-error-handling)
- [REST API Error Handling Best Practices - Speakeasy](https://www.speakeasy.com/api-design/errors)

<!-- EN -->

> Why this approach was chosen

---

## 1. Comparison with Other Approaches

Spring offers several ways to handle exceptions. Here are the approaches that were evaluated.

**@ResponseStatus**: Simple, but it calls `sendError()` which returns an HTML error page, making it unsuitable for REST APIs.

**ResponseStatusException**: Quick for prototyping, but the same logic gets repeated across multiple controllers, and it's awkward to throw from the Service layer.

**@ExceptionHandler (controller-level)**: Works well within a specific controller, but cannot be reused across other controllers.

**@ControllerAdvice (global)**: Applies to all controllers and guarantees a unified response format. Tracking where an exception is handled can be slightly difficult, but it's a familiar pattern for Spring developers.

**Zalando Problem**: Fully supports RFC 9457 and provides over 20 built-in handlers, but it adds an external library dependency and is overkill for a solo project.

**Vavr Either/Try**: A functional approach that returns errors as values. It's explicit, but has a steep learning curve and doesn't fit well with the Spring ecosystem.

---

## 2. Chose @ControllerAdvice + Custom Exceptions

### Selection Criteria

| Criterion | Priority |
|-----------|----------|
| Simplicity of implementation | 1st |
| Minimize external dependencies | 2nd |
| Consistent response format | 3rd |
| Extensibility | 4th |
| Standards compliance (RFC 9457) | 5th |

### Decision

```
ResponseStatusException  -> Code duplication, no consistency
Zalando Problem         -> External library, overengineered
Vavr Either             -> Learning curve, doesn't fit Spring
@ControllerAdvice       -> Simple, standard, extensible
```

For a solo project, the **most practical choice** is Spring's built-in `@ControllerAdvice`.

- No external libraries
- Any Spring developer can understand it
- Can migrate to RFC 9457 later if needed

---

## 3. How It Works Internally

Here are the implementation details learned while building with `@ControllerAdvice`.

### Exception Resolution Order

When an exception occurs, Spring's `HandlerExceptionResolverComposite` runs resolvers in order:

1. **ExceptionHandlerExceptionResolver** (order = 0): Executes `@ExceptionHandler` methods
2. **ResponseStatusExceptionResolver** (order = 1): Checks for `@ResponseStatus` annotations
3. **DefaultHandlerExceptionResolver** (order = MAX_VALUE): Converts Spring built-in exceptions to HTTP status codes

If multiple handlers exist for the same exception, the controller-internal `@ExceptionHandler` takes highest priority, followed by `@ControllerAdvice`.

### @ControllerAdvice Exception Matching

```java
throw new EntityNotFoundException("User not found");
```
When this exception is thrown, an exact match handler is searched first. If none is found, it traverses up the class hierarchy — `EntityNotFoundException → BusinessException → RuntimeException → Exception` — and the most specific handler is selected.

### Filter Exceptions Require Separate Handling

`@ControllerAdvice` only works **after DispatcherServlet**. Exceptions thrown in Filters, such as JWT authentication filters, are not caught by `@ControllerAdvice`.

![filter-exception-scope](/uploads/exception-handling-design/filter-exception-scope.png)

In Filters, you need to write error responses directly with try-catch, or forward to `/error` so that `BasicErrorController` handles it.

![filter-exception-handling](/uploads/exception-handling-design/filter-exception-handling.png)

---

## 4. Why Custom Error Codes Are Needed

### HTTP Status Codes Alone Are Not Enough

When a REST API error occurs, an HTTP status code is returned.

```
400 Bad Request
401 Unauthorized
404 Not Found
500 Internal Server Error
```

The problem is that **the same status code can have different causes**.

```
404 Not Found
├── User not found
├── File not found
└── Post not found
```

From the client's perspective, receiving only 404 makes it **impossible to know what's missing**.

Google's API Design guide also emphasizes: "Errors therefore become a key tool providing context and visibility into how to use an API."

> Source: [RESTful API Design: What About Errors? - Google Cloud Blog](https://cloud.google.com/blog/products/api-management/restful-api-design-what-about-errors)

---

### Clients Can Distinguish Errors

```json
{
  "success": false,
  "error": {
    "code": "U001",
    "message": "User not found"
  }
}
```

```json
{
  "success": false,
  "error": {
    "code": "F001",
    "message": "File not found"
  }
}
```

Even with the same 404, `U001` and `F001` can be distinguished.

### Error Code-Based Branching

```javascript
// Client code
if (error.code === 'A002') {
  // Token expired → attempt refresh token renewal
  await refreshToken();
} else if (error.code === 'A003') {
  // Invalid token → navigate to login page
  navigateTo('/login');
}
```

Such fine-grained branching is difficult with HTTP status codes alone.

### Easy Internationalization

```javascript
const errorMessages = {
  'U001': {
    ko: '사용자를 찾을 수 없습니다',
    en: 'User not found'
  },
  'A002': {
    ko: '토큰이 만료되었습니다',
    en: 'Token has expired'
  }
};
```

Error codes can be used as keys to map multilingual messages.

> Source: [Best Practices for API Error Handling - Postman Blog](https://blog.postman.com/best-practices-for-api-error-handling/)

---

## 5. RFC 9457 (Problem Details) Standard

Modern APIs are recommended to follow the **RFC 9457 Problem Details** standard. It is natively supported in Spring Framework 6.0+.

```json
{
  "type": "https://example.com/errors/user-not-found",
  "title": "User Not Found",
  "status": 404,
  "detail": "Cannot find user with ID 123",
  "instance": "/users/123"
}
```

Enabling in Spring Boot:
```yaml
spring:
  mvc:
    problemdetails:
      enabled: true
```

This project does not fully follow RFC 9457 and uses a simplified custom response format. Migration is possible when needed.

> Source: [Error Responses - Spring Framework Official Documentation](https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-ann-rest-exceptions.html)

---

## 6. Error Code Naming Convention

```
[Domain prefix][Sequence number]
```

| Prefix | Domain | Examples |
|--------|--------|----------|
| C | Common | C001, C002 |
| A | Auth | A001, A002 |
| U | User | U001, U002 |
| F | File/Upload | F001, F002 |

### Currently Defined Error Codes

**Common (C)**

| Code | HTTP | Description |
|------|------|-------------|
| C001 | 400 | Invalid input |
| C002 | 404 | Entity not found |
| C003 | 500 | Internal server error |
| C004 | 405 | Method not allowed |
| C005 | 403 | Access denied |

**Auth (A)**

| Code | HTTP | Description |
|------|------|-------------|
| A001 | 401 | Email/password mismatch |
| A002 | 401 | Token expired |
| A003 | 401 | Invalid token |
| A004 | 401 | Refresh token missing |
| A005 | 401 | Authentication required |

**User (U)**

| Code | HTTP | Description |
|------|------|-------------|
| U001 | 404 | User not found |
| U002 | 409 | Duplicate email |
| U003 | 409 | Duplicate nickname |
| U004 | 400 | Already withdrawn user |
| U005 | 403 | Suspended user |
| U006 | 403 | Blocked user |

**Upload (F)**

| Code | HTTP | Description |
|------|------|-------------|
| F001 | 404 | File not found |
| F002 | 400 | File size exceeded |
| F003 | 400 | Unsupported format |
| F004 | 500 | Upload failed |
| F005 | 400 | Already deleted file |

> Source: [REST API Error Codes 101 - REST Case](https://blog.restcase.com/rest-api-error-codes-101/)

---

## 7. Exception Class Structure

```
RuntimeException
    └── BusinessException (base class for business exceptions)
            └── EntityNotFoundException (dedicated for 404)
```

### BusinessException

Parent class of all business exceptions.

![business-exception-class](/uploads/exception-handling-design/business-exception-class.png)


### Usage Example

```java
// Service layer
if (userRepository.existsByEmail(email)) {
    throw new BusinessException(ErrorCode.DUPLICATE_EMAIL);
}

// 404 dedicated
User user = userRepository.findById(id)
    .orElseThrow(() -> new EntityNotFoundException(ErrorCode.USER_NOT_FOUND));
```

> Source: [Exception Handling in Spring MVC - Spring Official Blog](https://spring.io/blog/2013/11/01/exception-handling-in-spring-mvc/)

---

## 8. GlobalExceptionHandler

`@RestControllerAdvice` allows handling exceptions from all controllers **in one place**.

![global-exception-handler](/uploads/exception-handling-design/global-exception-handler.png)


### Handled Exceptions

| Exception | HTTP | Description |
|-----------|------|-------------|
| EntityNotFoundException | 404 | Entity not found |
| BusinessException | Dynamic | Business logic exception |
| MethodArgumentNotValidException | 400 | @Valid validation failure |
| MissingServletRequestParameterException | 400 | Required parameter missing |
| MethodArgumentTypeMismatchException | 400 | Parameter type mismatch |
| IllegalArgumentException | 400 | Invalid argument |
| IllegalStateException | 409 | Invalid state |
| AccessDeniedException | 403 | Access denied |
| AuthenticationException | 401 | Authentication failure |
| HttpRequestMethodNotSupportedException | 405 | HTTP method mismatch |
| MaxUploadSizeExceededException | 400 | File size exceeded |
| Exception | 500 | All other exceptions |

> Source: [Spring Boot Global Exception Handling with @RestControllerAdvice - Jose Lopez](https://josealopez.dev/en/blog/spring-boot-global-exception-handling)

---

## 9. Unified Response Format

### ApiResponse

![api-response-class](/uploads/exception-handling-design/api-response-class.png)


### Success Response

```json
{
  "success": true,
  "data": {
    "id": 1,
    "nickname": "John"
  },
  "timestamp": "2024-01-15T10:30:00"
}
```

### Failure Response

```json
{
  "success": false,
  "error": {
    "code": "U002",
    "message": "Email already in use"
  },
  "timestamp": "2024-01-15T10:30:00"
}
```

### Validation Failure Response (with details)

```json
{
  "success": false,
  "error": {
    "code": "C001",
    "message": "Input validation failed",
    "details": {
      "email": "Invalid email format",
      "password": "Password must be at least 8 characters"
    }
  },
  "timestamp": "2024-01-15T10:30:00"
}
```

> Source: [Best Practices for Consistent API Error Handling - Zuplo](https://zuplo.com/learning-center/best-practices-for-api-error-handling)

---

## 10. Security Considerations

In production environments, be careful about exposing internal information.

### What NOT to Do

```json
{
  "error": "NullPointerException at UserService.java:42",
  "stackTrace": "..."
}
```

Exposing stack traces, file paths, and library versions provides vulnerability information to attackers.

### What to Do

```json
{
  "code": "C003",
  "message": "An internal server error occurred"
}
```

Log detailed information internally, but return only generic messages to clients.

> Source: [REST API Error Handling Best Practices - Speakeasy](https://www.speakeasy.com/api-design/errors)

---

## 11. How to Add Error Codes

When a new domain is introduced:

### 1. Add to ErrorCode

```java
public enum ErrorCode {
    // ... existing codes

    // Study (new domain)
    STUDY_NOT_FOUND(404, "S001", "Study not found"),
    STUDY_ALREADY_STARTED(400, "S002", "Study has already started");
}
```

### 2. Use in Services

```java
throw new BusinessException(ErrorCode.STUDY_NOT_FOUND);
```

No changes needed to GlobalExceptionHandler. If it extends BusinessException, it's handled automatically.

---

## References

- [Spring Rest - Exception Handling - DEV Community](https://dev.to/noelopez/spring-rest-exception-handling-part-1-1jj2)
- [Exception Handling in Spring MVC - Spring Official Blog](https://spring.io/blog/2013/11/01/exception-handling-in-spring-mvc/)
- [Spring Boot @ControllerAdvice & @ExceptionHandler - BezKoder](https://www.bezkoder.com/spring-boot-controlleradvice-exceptionhandler/)
- [zalando/problem-spring-web - GitHub](https://github.com/zalando/problem-spring-web)
- [Vavr User Guide](https://docs.vavr.io/)
- [RESTful API Design: What About Errors? - Google Cloud Blog](https://cloud.google.com/blog/products/api-management/restful-api-design-what-about-errors)
- [Best Practices for API Error Handling - Postman Blog](https://blog.postman.com/best-practices-for-api-error-handling/)
- [Error Responses - Spring Framework Official Documentation](https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-ann-rest-exceptions.html)
- [Spring Boot Global Exception Handling - Jose Lopez](https://josealopez.dev/en/blog/spring-boot-global-exception-handling)
- [REST API Error Codes 101 - REST Case](https://blog.restcase.com/rest-api-error-codes-101/)
- [Best Practices for Consistent API Error Handling - Zuplo](https://zuplo.com/learning-center/best-practices-for-api-error-handling)
- [REST API Error Handling Best Practices - Speakeasy](https://www.speakeasy.com/api-design/errors)

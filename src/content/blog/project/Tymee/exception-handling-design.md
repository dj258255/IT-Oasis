---
title: '예외 처리 설계'
description: Spring의 여러 예외 처리 방법을 비교하고, @ControllerAdvice + 커스텀 에러 코드 + 통일된 응답 포맷을 선택한 이유를 정리한다.
date: 2025-11-17T00:00:00.000Z
tags:
  - Spring
  - Exception Handling
  - ControllerAdvice
  - Error Code
  - RFC 9457
  - REST API
category: personal/Tymee
draft: false
coverImage: "/uploads/project/Tymee/exception-handling-design/filter-exception-scope.png"
series: "Tymee"
---

> 왜 이 방식을 선택했는가

---

## 1. 다른 방법들과 비교

Spring에서 예외를 처리하는 방법은 여러 가지가 있습니다. 검토한 것들을 정리합니다.

**@ResponseStatus**: 간단하지만 `sendError()`로 HTML 에러 페이지가 반환되어 REST API에 부적합합니다.

**ResponseStatusException**: 프로토타이핑에 빠르지만, 여러 컨트롤러에서 같은 로직이 반복되고 Service 레이어에서 던지기 애매합니다.

**@ExceptionHandler (컨트롤러 레벨)**: 해당 컨트롤러 안에서는 잘 동작하지만, 다른 컨트롤러에서 재사용이 안 됩니다.

**@ControllerAdvice (전역)**: 모든 컨트롤러에 적용되고 통일된 응답 포맷을 보장합니다. 예외가 어디서 처리되는지 추적이 약간 어려울 수 있지만, Spring 개발자라면 익숙한 패턴입니다.

**Zalando Problem**: RFC 9457을 완벽 지원하고 기본 핸들러 20개 이상을 제공하지만, 외부 라이브러리 의존성이 추가되고 1인 프로젝트에는 과합니다.

**Vavr Either/Try**: 함수형으로 에러를 값으로 반환하는 방식입니다. 명시적이지만 러닝 커브가 높고 Spring 생태계와 맞지 않습니다.

---

## 2. @ControllerAdvice + 커스텀 예외 선택

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

1인 프로젝트에서 **가장 실용적인 선택**은 Spring 기본 기능인 `@ControllerAdvice`입니다.

- 외부 라이브러리 없음
- Spring 개발자라면 누구나 이해
- 필요하면 나중에 RFC 9457로 마이그레이션 가능

---

## 3. 내부 동작 원리

`@ControllerAdvice`가 어떻게 동작하는지 구현하면서 알게 된 부분을 정리합니다.

### 예외 해결 순서

예외가 발생하면 Spring의 `HandlerExceptionResolverComposite`가 순서대로 Resolver를 실행한다:

1. **ExceptionHandlerExceptionResolver** (order = 0): `@ExceptionHandler` 메서드 실행
2. **ResponseStatusExceptionResolver** (order = 1): `@ResponseStatus` 어노테이션 확인
3. **DefaultHandlerExceptionResolver** (order = MAX_VALUE): Spring 내장 예외를 HTTP 상태 코드로 변환

같은 예외를 처리하는 핸들러가 여러 개면 Controller 내부 `@ExceptionHandler`가 최우선이고, 그다음이 `@ControllerAdvice`입니다.

### @ControllerAdvice 예외 매칭

```java
throw new EntityNotFoundException("User not found");
```
이 예외가 발생하면 정확히 일치하는 핸들러를 먼저 찾고, 없으면 `EntityNotFoundException → BusinessException → RuntimeException → Exception` 순서로 상위 클래스를 타고 올라가며 가장 구체적인 핸들러가 선택됩니다.

### Filter 예외는 별도 처리가 필요합니다

`@ControllerAdvice`는 **DispatcherServlet 이후**에만 동작합니다. JWT 인증 필터 같은 Filter에서 발생한 예외는 `@ControllerAdvice`로 잡히지 않습니다.

![filter-exception-scope](/uploads/project/Tymee/exception-handling-design/filter-exception-scope.png)

Filter에서는 직접 try-catch로 에러 응답을 작성하거나, `/error`로 포워딩해서 `BasicErrorController`가 처리하게 해야 합니다.

![filter-exception-handling](/uploads/project/Tymee/exception-handling-design/filter-exception-handling.png)

---

## 4. 커스텀 에러 코드가 필요한 이유

### HTTP 상태 코드만으로는 부족합니다

REST API에서 에러가 발생하면 HTTP 상태 코드를 반환합니다.

```
400 Bad Request
401 Unauthorized
404 Not Found
500 Internal Server Error
```

문제는 **같은 상태 코드여도 원인이 다를 수 있다**는 것입니다.

```
404 Not Found
├── 사용자를 찾을 수 없음
├── 파일을 찾을 수 없음
└── 게시글을 찾을 수 없음
```

클라이언트 입장에서 404만 받으면 **뭐가 없는 건지 알 수 없습니다**.

Google API Design 가이드에서도 "Errors therefore become a key tool providing context and visibility into how to use an API"라고 강조합니다.

> 출처: [RESTful API Design: What About Errors? - Google Cloud Blog](https://cloud.google.com/blog/products/api-management/restful-api-design-what-about-errors)

---

### 클라이언트가 에러를 구분할 수 있습니다

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

같은 404여도 `U001`과 `F001`로 구분할 수 있습니다.

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

HTTP 상태 코드만으로는 이런 세밀한 분기가 어렵습니다.

### 다국어 지원이 쉽습니다

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

에러 코드를 키로 사용해서 다국어 메시지를 매핑할 수 있습니다.

> 출처: [Best Practices for API Error Handling - Postman Blog](https://blog.postman.com/best-practices-for-api-error-handling/)

---

## 5. RFC 9457 (Problem Details) 표준

현대 API는 **RFC 9457 Problem Details** 표준을 따르는 것이 권장됩니다. Spring Framework 6.0+에서 기본 지원합니다.

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

이 프로젝트에서는 RFC 9457을 완전히 따르지 않고, 단순화된 커스텀 응답 포맷을 사용합니다. 필요시 마이그레이션 가능합니다.

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

![business-exception-class](/uploads/project/Tymee/exception-handling-design/business-exception-class.png)


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

`@RestControllerAdvice`는 모든 컨트롤러에서 발생하는 예외를 **한 곳에서 처리**할 수 있게 해줍니다.

![global-exception-handler](/uploads/project/Tymee/exception-handling-design/global-exception-handler.png)


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

![api-response-class](/uploads/project/Tymee/exception-handling-design/api-response-class.png)


### 성공 응답

```json
{
  "success": true,
  "data": {
    "id": 1,
    "nickname": "홍길동"
  },
  "timestamp": "2025-12-15T10:30:00"
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
  "timestamp": "2025-12-15T10:30:00"
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
  "timestamp": "2025-12-15T10:30:00"
}
```

> 출처: [Best Practices for Consistent API Error Handling - Zuplo](https://zuplo.com/learning-center/best-practices-for-api-error-handling)

---

## 10. 보안 고려사항

프로덕션 환경에서는 내부 정보 노출에 주의해야 합니다.

### 하지 말아야 할 것

```json
{
  "error": "NullPointerException at UserService.java:42",
  "stackTrace": "..."
}
```

스택 트레이스, 파일 경로, 라이브러리 버전 등이 노출되면 공격자에게 취약점 정보를 제공하게 됩니다.

### 해야 할 것

```json
{
  "code": "C003",
  "message": "서버 내부 오류가 발생했습니다"
}
```

내부적으로는 로그에 상세 정보를 남기고, 클라이언트에는 일반적인 메시지만 반환합니다.

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

GlobalExceptionHandler는 수정할 필요 없습니다. BusinessException을 상속하면 자동으로 처리됩니다.

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

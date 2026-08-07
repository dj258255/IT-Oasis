---
title: 'Spring Boot 4 API Versioning과 Swagger UI의 충돌'
description: Spring Boot 4의 API Versioning이 Swagger UI와 충돌하는 문제의 원인을 분석하고, ApiVersionCustomizer로 해결한 과정을 정리한다.
date: 2025-12-26T00:00:00.000Z
tags:
  - Spring Boot 4
  - Swagger
  - OpenAPI
  - API Versioning
  - Troubleshooting
category: personal/Tymee
draft: false
coverImage: "/uploads/project/Tymee/spring-boot4-swagger-conflict/security-config-swagger.png"
series: "Tymee"
---

## 문제 상황

Spring Boot 4.0.1 + Spring Framework 7.0.2 환경에서 새롭게 도입된 API Versioning 기능을 사용하려고 했습니다.
그런데 Swagger UI (`/swagger-ui.html`)에 접근하면 HTTP 400 에러가 발생했습니다.

```
InvalidApiVersionException: 400 BAD_REQUEST "Invalid API version: 'No path segment at index 1'."
```

Spring Boot 4에서 처음 도입된 기능이라 레퍼런스가 거의 없었습니다.
구글링해도 대부분 Spring Boot 3 이하 버전 기준의 글들뿐이었습니다.

---

## 환경

- Spring Boot 4.0.1
- Spring Framework 7.0.2
- springdoc-openapi-starter-webmvc-ui 3.0.1
- Java 25

---

## 첫 번째 시도: SecurityConfig에 Swagger 경로 추가

처음에는 단순히 Spring Security에서 막는 건가 싶었습니다. SecurityConfig에 Swagger 관련 경로를 permitAll로 추가해봤습니다.

![security-config-swagger](/uploads/project/Tymee/spring-boot4-swagger-conflict/security-config-swagger.png)

**결과: 실패**

여전히 같은 에러가 발생했습니다.
에러 메시지를 다시 보니 `InvalidApiVersionException`이라고 되어 있었습니다.
Security가 아니라 API Versioning 쪽 문제였습니다.

---

## 두 번째 시도: WebConfig로 springdoc 패키지 제외

"Spring Boot 4 API versioning springdoc swagger"로 검색해봤습니다.
springdoc-openapi GitHub에서 [이슈 #3163](https://github.com/springdoc/springdoc-openapi/issues/3163)을 발견했습니다.
나랑 똑같은 문제를 겪고 있는 사람이 있었습니다.

이슈에서 maintainer가 제안한 해결책은 `WebMvcConfigurer`의 `addPathPrefix`에서 springdoc을 제외하라는 것이었습니다.

`WebConfig`를 만들어서 springdoc 패키지를 API versioning에서 제외하려고 했습니다.

![webconfig-exclude-springdoc](/uploads/project/Tymee/spring-boot4-swagger-conflict/webconfig-exclude-springdoc.png)

**결과: 실패**

`addPathPrefix`는 URL prefix만 관리하는 거지, API version parsing 자체를 제어하지 않았습니다.
에러 메시지가 조금 바뀌긴 했지만 여전히 400 에러였습니다.

GitHub 이슈를 다시 읽어보니, `addPathPrefix` 외에 **커스텀 ApiVersionParser**도 언급되어 있었습니다.
Swagger UI 리소스(.html, .css, .js)에 대해서는 버전 파싱 자체를 건너뛰어야 한다고 했습니다.

---

## 세 번째 시도: 기존 ApiVersionConfig 수정

WebConfig파일을 삭제하고 다시 기존 파일을 수정하는 방향으로 갔습니다.

![api-version-config-original](/uploads/project/Tymee/spring-boot4-swagger-conflict/api-version-config-original.png)

여기서 `configureApiVersioning`으로 path segment versioning을 활성화하고 있었습니다.
문제는 **모든 요청**에 대해 버전 파싱을 시도한다는 것입니다.
`/swagger-ui.html` 같은 요청도 path segment index 1에서 버전을 찾으려고 하니 당연히 실패합니다.

---

## 네 번째 시도: 커스텀 ApiVersionResolver로 Swagger 경로 제외 (블랙리스트 방식)

[Spring Framework 공식 문서](https://docs.spring.io/spring-framework/reference/web/webmvc-versioning.html)를 찾아봤습니다.
`ApiVersionResolver`라는 인터페이스가 있고, 요청에서 버전을 추출하는 역할을 한다고 되어 있었습니다.

그리고 [Dan Vega의 블로그](https://www.danvega.dev/blog/spring-boot-4-api-versioning)에서 `useVersionResolver()`로 커스텀 resolver를 설정할 수 있다는 걸 알게 됐습니다.

GitHub 이슈의 힌트와 조합해서, Swagger 경로에 대해서는 `null`을 반환하면 버전 파싱을 스킵할 수 있지 않을까 싶었습니다.

![blacklist-version-resolver](/uploads/project/Tymee/spring-boot4-swagger-conflict/blacklist-version-resolver.png)

**결과: 부분 성공**

Swagger UI 경로는 해결됐지만, 새로운 에러가 나왔습니다.

```
InvalidApiVersionException: 400 BAD_REQUEST "Invalid API version: 'auth'."
```

블랙리스트 방식의 문제점이 드러났습니다. `/auth/login/google` 같은 경로에서 `auth`를 버전으로 파싱하려다가 실패한 것입니다.
제외해야 할 경로가 계속 늘어나면서 관리가 어려워졌습니다.

---

## 다섯 번째 시도: 화이트리스트 방식으로 전환

블랙리스트(제외할 경로 나열)보다 **화이트리스트(API 경로만 버전 추출)** 방식이 더 깔끔하다는 걸 깨달았습니다.

`/api/v{N}/...` 패턴에 매칭되는 경로에서만 버전을 추출하고, 나머지는 모두 `null`을 반환하도록 변경했습니다.

![whitelist-version-resolver](/uploads/project/Tymee/spring-boot4-swagger-conflict/whitelist-version-resolver.png)


### 정규표현식 설명

`^/api/v(\d+)/.+`가 뭔지 궁금할 수 있습니다.

| 부분 | 의미 |
|------|------|
| `^` | 문자열 시작 |
| `/api/v` | 리터럴 문자 `/api/v` |
| `(\d+)` | 숫자 1개 이상 캡처 (그룹1) |
| `/` | 리터럴 `/` |
| `.+` | 아무 문자 1개 이상 |

**매칭 예시:**

| 경로 | 매칭? | 캡처된 버전 |
|------|-------|-------------|
| `/api/v1/users` | O | `1` |
| `/api/v2/auth/login` | O | `2` |
| `/swagger-ui.html` | X | - |
| `/api/v1` | X | (`/` 뒤에 뭔가 있어야 함) |

**결과: 실패**

```
MissingApiVersionException: 400 BAD_REQUEST "API version is required."
```

`null`을 반환해도 `DefaultApiVersionStrategy`가 버전이 필수라고 판단해서 예외를 던지고 있었습니다.

---

## 여섯 번째 시도: setVersionRequired(false) 추가

다시 Spring Framework 문서와 [Piotr's TechBlog](https://piotrminkowski.com/2025/12/01/spring-boot-built-in-api-versioning/)를 찾아봤습니다.

> By default, a version is required when API versioning is enabled, and MissingApiVersionException is raised resulting in a 400 response if not present. You can make it optional...

아, 기본적으로 버전이 **필수**로 설정되어 있었습니다.
`null`을 반환해도 "버전 없음"으로 처리되니까 예외가 발생하는 것이었습니다.

`ApiVersionConfigurer`에 `setVersionRequired(false)`를 추가해서 버전이 없는 요청도 허용하도록 했습니다.

**결과: Swagger UI 로드 성공, 하지만 API 목록이 비어있음**

```
No operations defined in spec!
```

Swagger가 버전별 API를 제대로 인식하지 못하고 있었습니다.

---

## 일곱 번째 시도: OpenApiConfig에 GroupedOpenApi 설정

springdoc이 `@RequestMapping(version = "1.0")` 어노테이션을 인식해서 버전별로 API를 그룹화하도록 설정해야 했습니다.

![grouped-openapi-config](/uploads/project/Tymee/spring-boot4-swagger-conflict/grouped-openapi-config.png)

**결과: 성공!**

드디어 Swagger UI에서 API v1 / API v2 그룹을 선택할 수 있게 됐습니다.

---

## 여덟 번째 시도 (최종): 공식 예제 스타일 ApiVersionParser 적용

처음에는 `addSupportedVersions("1", "2")` 형태로 사용했는데, Spring Framework 공식 예제를 보니 시맨틱 버저닝(`"1.0"`, `"2.0"`)을 사용하고 있었습니다.

공식 스타일에 맞춰서 `SimpleVersionParser`를 추가했습니다.
이 파서는 `v1` → `1.0`, `1` → `1.0`으로 변환해줍니다.

![simple-version-parser](/uploads/project/Tymee/spring-boot4-swagger-conflict/simple-version-parser.png)



컨트롤러의 버전 어노테이션도 `"1.0"` 형태로 변경:

![controller-version-annotation](/uploads/project/Tymee/spring-boot4-swagger-conflict/controller-version-annotation.png)

**결과 :** 성공

---

## 최종 코드

### ApiVersionConfig.java

![final-api-version-config](/uploads/project/Tymee/spring-boot4-swagger-conflict/final-api-version-config.png)


### OpenApiConfig.java (버전별 그룹 설정)

![final-openapi-config](/uploads/project/Tymee/spring-boot4-swagger-conflict/final-openapi-config.png)


### 컨트롤러 예시

![controller-example](/uploads/project/Tymee/spring-boot4-swagger-conflict/controller-example.png)


---

## 핵심 포인트 정리

| 설정 | 역할 |
|------|------|
| `ApiPathVersionResolver` | `/api/v{N}/...` 패턴에서만 버전 추출 (화이트리스트 방식) |
| `SimpleVersionParser` | `v1` → `1.0` 변환 (공식 예제 스타일) |
| `setVersionRequired(false)` | Swagger 등 버전 없는 경로 허용 |
| `addPathPrefix` + `negate()` | springdoc 패키지는 prefix에서 제외 |
| `GroupedOpenApi` | Swagger에서 v1/v2 API 그룹 선택 가능 |

---

## 블랙리스트 vs 화이트리스트

이 문제를 해결하는 방법은 크게 두 가지가 있습니다.

### 블랙리스트 방식 (springdoc 이슈에서 제안)

[springdoc GitHub 이슈 #3163](https://github.com/springdoc/springdoc-openapi/issues/3163)에서 제안된 방식입니다.
제외할 경로를 하나씩 나열합니다.

```java
public class ApiVersionParser implements org.springframework.web.accept.ApiVersionParser {
    @Override
    public Comparable parseVersion(String version) {
        if("api-docs".equals(version) || "swagger-ui-bundle.js".equals(version))
            return null;
        return version;
    }
}
```

**단점**: Swagger, actuator, 에러 페이지 등 제외할 경로가 계속 늘어납니다.

### 화이트리스트 방식 (내가 선택한 방식)

공식 문서나 다른 블로그에서 명시적으로 권장하는 방식은 아니지만, `/api/v{N}/...` 패턴만 버전 추출하는 방식이 더 깔끔합니다.

```java
private static final Pattern VERSION_PATTERN = Pattern.compile("^/api/v(\\d+)/.+");
```

**장점**: 새로운 경로가 추가돼도 수정할 필요가 없습니다.

> **참고**: [Spring Framework 공식 문서](https://docs.spring.io/spring-framework/reference/web/webmvc-versioning.html)에는 화이트리스트/블랙리스트 필터링에 대한 명시적인 가이드가 없다. 커스텀 `ApiVersionResolver`를 사용할 수 있다는 것만 언급되어 있다.

---

## 삽질하면서 배운 것들

1. **블랙리스트보다 화이트리스트**: Swagger, actuator, 에러 페이지 등 제외할 경로가 계속 늘어납니다. `/api/v{N}/...` 패턴만 버전 추출하는 화이트리스트 방식이 훨씬 깔끔합니다.

2. **`addPathPrefix`만으로는 부족합니다**: URL prefix 설정과 API version parsing은 완전히 별개의 기능입니다. prefix를 제외해도 version parsing은 여전히 모든 요청에 적용됩니다.

3. **커스텀 ApiVersionResolver가 핵심**: API 경로에서만 버전을 추출하고 나머지는 `null`을 반환해서 버전 파싱 자체를 우회해야 합니다.

4. **`setVersionRequired(false)` 필수**: 이게 제일 찾기 어려웠습니다. `null`을 반환해도 기본 설정상 버전이 필수라서 `MissingApiVersionException`이 발생합니다.

5. **GroupedOpenApi로 버전별 API 문서 분리**: `addOpenApiMethodFilter`에서 `@RequestMapping(version = "X.0")`을 체크해서 버전별로 API를 그룹화합니다.

6. **공식 예제 스타일 따르기**: `"1"` 대신 `"1.0"` 시맨틱 버저닝을 사용하고, `SimpleVersionParser`로 변환하는 게 표준적인 방법입니다.

7. **Spring Boot 4 + springdoc은 아직 불안정합니다**: 이건 나만 겪는 문제가 아니라 알려진 호환성 이슈입니다. springdoc 쪽에서 fix가 나올 수도 있지만, 당분간은 이런 workaround가 필요합니다.

---

## 참고 자료

- [HTTP 400 with Spring Boot 4 API versioning enabled - springdoc/springdoc-openapi#3163](https://github.com/springdoc/springdoc-openapi/issues/3163)
- [First-Class API Versioning in Spring Boot 4 - Dan Vega](https://www.danvega.dev/blog/spring-boot-4-api-versioning)
- [Spring Boot Built-in API Versioning - Piotr's TechBlog](https://piotrminkowski.com/2025/12/01/spring-boot-built-in-api-versioning/)
- [API Versioning :: Spring Framework](https://docs.spring.io/spring-framework/reference/web/webmvc-versioning.html)

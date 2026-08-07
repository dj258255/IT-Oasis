---
title: 'Gradle 멀티모듈 의존성 관리'
description: 멀티모듈 프로젝트에서 의존성 버전 관리 방법 5가지를 비교하고, Version Catalog + Spring BOM 하이브리드 방식을 선택한 이유를 정리한다.
date: 2025-11-09T00:00:00.000Z
tags:
  - Gradle
  - Multi-Module
  - Version Catalog
  - Spring BOM
  - Build Management
category: personal/Tymee
draft: false
coverImage: "/uploads/project/Tymee/gradle-multimodule-dependency/direct-version.svg"
series: "Tymee"
---

> 멀티모듈 프로젝트에서 의존성 버전을 하드코딩하니까 관리가 번거롭고, 보안 이슈 발생 시 빠르게 버전을 바꿀 수 있는 방법이 필요했다.

---

## 의존성 관리가 왜 어려운가?

멀티모듈 프로젝트에서 각 모듈이 서로 다른 라이브러리 버전을 사용하면:
- 런타임에 `NoSuchMethodError`, `ClassNotFoundException` 발생
- 같은 코드가 모듈마다 다르게 동작
- 보안 취약점이 있는 버전이 일부 모듈에 남아있음

하지만 버전 관리를 강하게 중앙화하면:
- 한 모듈의 업그레이드가 전체에 영향
- 특정 모듈만 새 버전 테스트하기 어려움
- 의존성 충돌 해결이 더 복잡해질 수 있음

---

## 방법 1: 직접 버전 명시

![direct-version](/uploads/project/Tymee/gradle-multimodule-dependency/direct-version.svg)

자주 썼던 방식입니다.
6주 프로젝트나 토이프로젝트에서는 괜찮았습니다.

직관적이고 빌드 스크립트만 보면 모든 정보를 확인할 수 있습니다.
하지만 모듈이 늘어나면 버전이 여러 파일에 흩어지고, 전체 업그레이드 시 모든 파일을 수정해야 합니다.
단일 모듈이나 레거시 유지보수에 적합합니다.



---

## 방법 2: ext 변수 사용

![ext-variable](/uploads/project/Tymee/gradle-multimodule-dependency/ext-variable.svg)

AWS 관련 의존성 충돌 때문에 자주 썼던 방식입니다.

버전을 한 곳에서 정의할 수 있어서 직접 명시보다 낫지만, IDE 자동완성이 약하고 타입 안전성이 없어서 오타를 잡기 어렵습니다.
Version Catalog 도입 전 중간 단계로 적합합니다.

---

## 방법 3: Spring BOM만 사용

![spring-bom](/uploads/project/Tymee/gradle-multimodule-dependency/spring-bom.svg)

starter-web에서 자주 썼던 방식입니다.

Spring 생태계 내 라이브러리 간 호환성을 BOM이 보장해주고, 버전 명시 없이 깔끔하게 선언할 수 있습니다.
다만 Flyway, jjwt 같은 Spring BOM 밖의 라이브러리는 별도로 관리해야 합니다.
순수 Spring 프로젝트에 적합합니다.

---

## 방법 4: Gradle Version Catalog만 사용

[Gradle 공식 문서](https://docs.gradle.org/current/userguide/version_catalogs.html)에서 소개하는 방식입니다.

![version-catalog-toml](/uploads/project/Tymee/gradle-multimodule-dependency/version-catalog-toml.svg)


![version-catalog-usage](/uploads/project/Tymee/gradle-multimodule-dependency/version-catalog-usage.svg)


IDE 자동완성이 완벽하게 지원되고, 오타 시 컴파일 에러가 나서 타입 안전합니다.
멀티모듈에서 자동 공유되고 Dependabot 같은 자동화 도구도 지원합니다.

다만 Version Catalog만 단독으로 쓰면 Spring 내부 라이브러리 간 호환성을 직접 맞춰야 합니다.
`spring-boot-starter-web`이 의존하는 `spring-core` 버전을 수동으로 관리해야 하는 식입니다.
Spring 외 라이브러리가 많거나 비-Spring 프로젝트에 적합합니다.

---

## 방법 5: Version Catalog + Spring BOM (하이브리드)

![hybrid-toml](/uploads/project/Tymee/gradle-multimodule-dependency/hybrid-toml.svg)


![hybrid-usage](/uploads/project/Tymee/gradle-multimodule-dependency/hybrid-usage.svg)

Spring 호환성은 BOM이 보장하고, Flyway나 jjwt 같은 외부 라이브러리는 Version Catalog로 중앙 관리합니다.
두 가지 시스템을 모두 이해해야 하고 어떤 라이브러리가 어디에서 관리되는지 구분이 필요하다는 점은 있지만, Spring 기반 멀티모듈에서는 이 조합이 가장 실용적입니다.

---



## Bundle 활용 - 장단점

![bundle-toml](/uploads/project/Tymee/gradle-multimodule-dependency/bundle-toml.svg)

![bundle-usage](/uploads/project/Tymee/gradle-multimodule-dependency/bundle-usage.svg)


항상 함께 쓰는 라이브러리를 그룹화해서 누락을 방지할 수 있습니다.
다만 번들 내 개별 라이브러리의 scope를 다르게 지정할 수 없습니다.
예를 들어 `jjwt-api`는 `api`로, 나머지는 `implementation`으로 하고 싶을 때 번들은 쓸 수 없습니다.

---

## 네이밍 컨벤션

[Gradle 공식 블로그](https://blog.gradle.org/best-practices-naming-version-catalog-entries)의 권장 사항:

commons_lang3       -> commons-lang3
apache-commonsLang  -> commons-lang3
failsafe-failsafe   -> failsafe


**주의:** 대시(-)는 Kotlin에서 점(.)으로 변환됩니다.

```toml
spring-boot-starter-web  # toml에서
```
```kotlin
libs.spring.boot.starter.web  // Kotlin에서
```

---

## 멀티모듈 구조에서의 적용

```
backend/
├── gradle/libs.versions.toml  <- 한 곳에서 버전 정의
├── core/build.gradle.kts      <- libs.xxx 사용
├── user/build.gradle.kts      <- libs.xxx 사용 (동일 버전 보장)
├── auth/build.gradle.kts      <- libs.xxx 사용 (동일 버전 보장)
└── bootstrap/build.gradle.kts <- libs.xxx 사용 (동일 버전 보장)
```

[Medium 블로그](https://medium.com/@rohitloke/gradle-multi-module-dependency-management-using-version-catalogs-379f3988da5b)에 따르면:

> "Updating a dependency version is as simple as changing it in the libs.versions.toml file. This change propagates across all modules that use that dependency."

---

## buildSrc에서 Version Catalog 사용

buildSrc에서는 기본적으로 상위 빌드의 Version Catalog에 접근할 수 없습니다.

**settings.gradle.kts (buildSrc 내부)**

![buildsrc-settings](/uploads/project/Tymee/gradle-multimodule-dependency/buildsrc-settings.svg)


- Catalog 공유로 일관성 확보
- buildSrc 빌드 시간 증가 가능
- 순환 참조 주의 필요

---

## 결론: 무엇을 선택할까?

**프로젝트 상황에 따른 선택:**

- **단일 모듈, 빠른 시작**: 직접 버전 명시 또는 Spring BOM만
- **멀티모듈, Spring 기반**: Version Catalog + Spring BOM
- **멀티모듈, 비-Spring 또는 다양한 외부 라이브러리**: Version Catalog만
- **레거시 마이그레이션 중**: ext 변수로 시작 -> 점진적으로 Catalog 도입

**기억할 점**
- 도구는 문제를 해결하기 위해 존재
- 팀이 이해하고 유지보수할 수 있는 수준으로 선택
- 단순함도 가치

---

## 참고 자료

- [Version Catalogs - Gradle 공식 문서](https://docs.gradle.org/current/userguide/version_catalogs.html)
- [Best Practices for Naming Version Catalog Entries - Gradle Blog](https://blog.gradle.org/best-practices-naming-version-catalog-entries)
- [Gradle multi module dependency management using Version Catalogs - Medium](https://medium.com/@rohitloke/gradle-multi-module-dependency-management-using-version-catalogs-379f3988da5b)
- [Thoughtworks Technology Radar - Gradle Version Catalog](https://www.thoughtworks.com/radar/tools/gradle-version-catalog)

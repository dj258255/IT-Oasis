---
title: 'Gradle 멀티모듈 의존성 관리'
titleEn: 'Gradle Multi-Module Dependency Management'
description: 멀티모듈 프로젝트에서 의존성 버전 관리 방법 5가지를 비교하고, Version Catalog + Spring BOM 하이브리드 방식을 선택한 이유를 정리한다.
descriptionEn: Compares five dependency version management approaches in multi-module projects and explains why Version Catalog + Spring BOM hybrid was chosen.
date: 2025-11-09T00:00:00.000Z
tags:
  - Gradle
  - Multi-Module
  - Version Catalog
  - Spring BOM
  - Build Management
category: project/Tymee
draft: false
coverImage: "/uploads/project/Tymee/gradle-multimodule-dependency/direct-version.svg"
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

자주 썼던 방식이다. 6주 프로젝트나 토이프로젝트에서는 괜찮았다.

직관적이고 빌드 스크립트만 보면 모든 정보를 확인할 수 있다. 하지만 모듈이 늘어나면 버전이 여러 파일에 흩어지고, 전체 업그레이드 시 모든 파일을 수정해야 한다. 단일 모듈이나 레거시 유지보수에 적합하다.



---

## 방법 2: ext 변수 사용

![ext-variable](/uploads/project/Tymee/gradle-multimodule-dependency/ext-variable.svg)

AWS 관련 의존성 충돌 때문에 자주 썼던 방식이다.

버전을 한 곳에서 정의할 수 있어서 직접 명시보다 낫지만, IDE 자동완성이 약하고 타입 안전성이 없어서 오타를 잡기 어렵다. Version Catalog 도입 전 중간 단계로 적합하다.

---

## 방법 3: Spring BOM만 사용

![spring-bom](/uploads/project/Tymee/gradle-multimodule-dependency/spring-bom.svg)

starter-web에서 자주 썼던 방식이다.

Spring 생태계 내 라이브러리 간 호환성을 BOM이 보장해주고, 버전 명시 없이 깔끔하게 선언할 수 있다. 다만 Flyway, jjwt 같은 Spring BOM 밖의 라이브러리는 별도로 관리해야 한다. 순수 Spring 프로젝트에 적합하다.

---

## 방법 4: Gradle Version Catalog만 사용

[Gradle 공식 문서](https://docs.gradle.org/current/userguide/version_catalogs.html)에서 소개하는 방식입니다.

![version-catalog-toml](/uploads/project/Tymee/gradle-multimodule-dependency/version-catalog-toml.svg)


![version-catalog-usage](/uploads/project/Tymee/gradle-multimodule-dependency/version-catalog-usage.svg)


IDE 자동완성이 완벽하게 지원되고, 오타 시 컴파일 에러가 나서 타입 안전하다. 멀티모듈에서 자동 공유되고 Dependabot 같은 자동화 도구도 지원한다.

다만 Version Catalog만 단독으로 쓰면 Spring 내부 라이브러리 간 호환성을 직접 맞춰야 한다. `spring-boot-starter-web`이 의존하는 `spring-core` 버전을 수동으로 관리해야 하는 식이다. Spring 외 라이브러리가 많거나 비-Spring 프로젝트에 적합하다.

---

## 방법 5: Version Catalog + Spring BOM (하이브리드)

![hybrid-toml](/uploads/project/Tymee/gradle-multimodule-dependency/hybrid-toml.svg)


![hybrid-usage](/uploads/project/Tymee/gradle-multimodule-dependency/hybrid-usage.svg)

Spring 호환성은 BOM이 보장하고, Flyway나 jjwt 같은 외부 라이브러리는 Version Catalog로 중앙 관리한다. 두 가지 시스템을 모두 이해해야 하고 어떤 라이브러리가 어디에서 관리되는지 구분이 필요하다는 점은 있지만, Spring 기반 멀티모듈에서는 이 조합이 가장 실용적이다.

---



## Bundle 활용 - 장단점

![bundle-toml](/uploads/project/Tymee/gradle-multimodule-dependency/bundle-toml.svg)

![bundle-usage](/uploads/project/Tymee/gradle-multimodule-dependency/bundle-usage.svg)


항상 함께 쓰는 라이브러리를 그룹화해서 누락을 방지할 수 있다. 다만 번들 내 개별 라이브러리의 scope를 다르게 지정할 수 없다. 예를 들어 `jjwt-api`는 `api`로, 나머지는 `implementation`으로 하고 싶을 때 번들은 쓸 수 없다.

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

<!-- EN -->

> Hardcoding dependency versions in a multi-module project made management cumbersome, and I needed a way to quickly change versions when security issues arose.

---

## Why Is Dependency Management Hard?

When each module in a multi-module project uses different library versions:
- `NoSuchMethodError`, `ClassNotFoundException` at runtime
- Same code behaves differently across modules
- Vulnerable versions remain in some modules

However, strong centralization of version management causes:
- One module's upgrade affects everything
- Difficult to test a new version on only one module
- Dependency conflict resolution can become more complex

---

## Approach 1: Direct Version Declaration

![direct-version](/uploads/project/Tymee/gradle-multimodule-dependency/direct-version.svg)

This was my go-to approach. It worked fine for 6-week projects or toy projects.

It is intuitive and all information is visible just from the build script. However, as modules grow, versions scatter across multiple files and upgrading requires editing every file. Suitable for single modules or legacy maintenance.



---

## Approach 2: Using ext Variables

![ext-variable](/uploads/project/Tymee/gradle-multimodule-dependency/ext-variable.svg)

I used this approach frequently because of AWS-related dependency conflicts.

Being able to define versions in one place is better than direct declaration, but IDE autocomplete is weak and there is no type safety, making it hard to catch typos. Suitable as an intermediate step before adopting Version Catalog.

---

## Approach 3: Spring BOM Only

![spring-bom](/uploads/project/Tymee/gradle-multimodule-dependency/spring-bom.svg)

I frequently used this approach with starter-web.

The BOM guarantees compatibility among libraries within the Spring ecosystem, and you can declare dependencies cleanly without specifying versions. However, libraries outside the Spring BOM like Flyway and jjwt need to be managed separately. Suitable for pure Spring projects.

---

## Approach 4: Gradle Version Catalog Only

This is the approach introduced in the [official Gradle documentation](https://docs.gradle.org/current/userguide/version_catalogs.html).

![version-catalog-toml](/uploads/project/Tymee/gradle-multimodule-dependency/version-catalog-toml.svg)


![version-catalog-usage](/uploads/project/Tymee/gradle-multimodule-dependency/version-catalog-usage.svg)


IDE autocomplete is fully supported, and typos cause compile errors, providing type safety. It is automatically shared across multi-module projects and supports automation tools like Dependabot.

However, using Version Catalog alone requires manually ensuring compatibility among Spring internal libraries. For example, you would need to manually manage the `spring-core` version that `spring-boot-starter-web` depends on. Suitable for non-Spring projects or those with many non-Spring libraries.

---

## Approach 5: Version Catalog + Spring BOM (Hybrid)

![hybrid-toml](/uploads/project/Tymee/gradle-multimodule-dependency/hybrid-toml.svg)


![hybrid-usage](/uploads/project/Tymee/gradle-multimodule-dependency/hybrid-usage.svg)

The BOM handles Spring compatibility, while external libraries like Flyway and jjwt are centrally managed through Version Catalog. You need to understand both systems and distinguish which library is managed where, but for Spring-based multi-module projects, this combination is the most practical.

---



## Using Bundles - Pros and Cons

![bundle-toml](/uploads/project/Tymee/gradle-multimodule-dependency/bundle-toml.svg)

![bundle-usage](/uploads/project/Tymee/gradle-multimodule-dependency/bundle-usage.svg)


You can group libraries that are always used together to prevent omissions. However, you cannot assign different scopes to individual libraries within a bundle. For example, if you want `jjwt-api` as `api` and the rest as `implementation`, bundles cannot be used.

---

## Naming Conventions

Recommendations from the [official Gradle blog](https://blog.gradle.org/best-practices-naming-version-catalog-entries):

commons_lang3       -> commons-lang3
apache-commonsLang  -> commons-lang3
failsafe-failsafe   -> failsafe


**Note:** Dashes (-) are converted to dots (.) in Kotlin.

```toml
spring-boot-starter-web  # in toml
```
```kotlin
libs.spring.boot.starter.web  // in Kotlin
```

---

## Applying to a Multi-Module Structure

```
backend/
├── gradle/libs.versions.toml  <- Define versions in one place
├── core/build.gradle.kts      <- Uses libs.xxx
├── user/build.gradle.kts      <- Uses libs.xxx (same version guaranteed)
├── auth/build.gradle.kts      <- Uses libs.xxx (same version guaranteed)
└── bootstrap/build.gradle.kts <- Uses libs.xxx (same version guaranteed)
```

According to a [Medium blog post](https://medium.com/@rohitloke/gradle-multi-module-dependency-management-using-version-catalogs-379f3988da5b):

> "Updating a dependency version is as simple as changing it in the libs.versions.toml file. This change propagates across all modules that use that dependency."

---

## Using Version Catalog in buildSrc

By default, buildSrc cannot access the parent build's Version Catalog.

**settings.gradle.kts (inside buildSrc)**

![buildsrc-settings](/uploads/project/Tymee/gradle-multimodule-dependency/buildsrc-settings.svg)


- Catalog sharing ensures consistency
- May increase buildSrc build time
- Watch out for circular references

---

## Conclusion: What Should You Choose?

**Choosing based on project circumstances:**

- **Single module, quick start**: Direct version declaration or Spring BOM only
- **Multi-module, Spring-based**: Version Catalog + Spring BOM
- **Multi-module, non-Spring or diverse external libraries**: Version Catalog only
- **During legacy migration**: Start with ext variables -> gradually adopt Catalog

**Key takeaways**
- Tools exist to solve problems
- Choose a level that the team can understand and maintain
- Simplicity has value too

---

## References

- [Version Catalogs - Gradle Official Documentation](https://docs.gradle.org/current/userguide/version_catalogs.html)
- [Best Practices for Naming Version Catalog Entries - Gradle Blog](https://blog.gradle.org/best-practices-naming-version-catalog-entries)
- [Gradle multi module dependency management using Version Catalogs - Medium](https://medium.com/@rohitloke/gradle-multi-module-dependency-management-using-version-catalogs-379f3988da5b)
- [Thoughtworks Technology Radar - Gradle Version Catalog](https://www.thoughtworks.com/radar/tools/gradle-version-catalog)

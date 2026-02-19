---
title: 'QueryDSL 구현체를 Infrastructure 레이어로 이동하면서 발생한 오류'
titleEn: 'Error from Moving QueryDSL Implementation to Infrastructure Layer'
description: Spring Data JPA의 Custom Repository 구현체를 레이어 이동할 때 발생한 쿼리 메서드 파싱 오류와 해결 과정을 정리한다.
descriptionEn: Documents the query method parsing error that occurred when moving a Spring Data JPA Custom Repository implementation across layers and the resolution.
date: 2025-08-06T00:00:00.000Z
tags:
  - Spring Data JPA
  - QueryDSL
  - Layered Architecture
  - Dependency Inversion
  - Repository Pattern
category: project/EduMeet
draft: false
coverImage: "/uploads/project/EduMeet/file-move-error/file-moveerror.png"
---

## 정상 상태

레이어드 아키텍처에서 인터페이스는 Application 레이어에, 그 구현체는 Infrastructure 레이어에 위치해야 해요.
이렇게 해야 의존성 역전 원칙(DIP)이 지켜지고, Application 레이어가 특정 기술(QueryDSL, JPA 등)에 직접 의존하지 않는 구조가 돼요.

---

## 문제 상황

![](/uploads/project/EduMeet/file-move-error/file-moveerror.png)

개발 중에 QueryDSL 기반 검색 기능을 구현하면서, `BoardSearch`(인터페이스)와 `BoardSearchImpl`(구현체)을 모두 Application 레이어에 두고 있었어요.

이 구조의 문제를 인식하고, 두 가지 작업을 진행했어요.

**1단계: 이름 정리**

`BoardSearch`와 `BoardSearchImpl`이라는 이름은 역할이 불명확했어요.
QueryDSL을 사용하는 Repository 구현체인 만큼, 이름을 아래처럼 변경했어요.

- `BoardSearch` → `BoardSearchRepository`
- `BoardSearchImpl` → `BoardSearchRepositoryImpl`

**2단계: 구현체를 Infrastructure 레이어로 이동**

인터페이스는 Application 레이어에 유지하고, 구현체인 `BoardSearchRepositoryImpl`을 Infrastructure 레이어로 옮겼어요.

![](/uploads/project/EduMeet/file-move-error/file-moveerror-02.png)
![](/uploads/project/EduMeet/file-move-error/file-moveerror-03.png)
![](/uploads/project/EduMeet/file-move-error/file-moveerror-04.png)
![](/uploads/project/EduMeet/file-move-error/file-moveerror-05.png)
![](/uploads/project/EduMeet/file-move-error/file-moveerror-06.png)

그런데 이동 직후, 애플리케이션이 실행되지 않았어요.

![](/uploads/project/EduMeet/file-move-error/file-moveerror-07.png)

---

## 원인 분석

오류 메시지를 확인해보니, Spring Data JPA가 `BoardJpaRepository`에서 `searchAll(...)` 메서드를 자동 구현하려다 실패한 거였어요.

![](/uploads/project/EduMeet/file-move-error/file-moveerror-08.png)

Spring Data JPA의 쿼리 메서드 자동 생성 규칙을 확인해봤어요.
[Spring Data JPA 공식 문서](https://docs.spring.io/spring-data/jpa/reference/jpa/query-methods.html)에 따르면, JPA는 `findBy`, `findAllBy`, `countBy`, `deleteBy` 등의 **규약된 접두사**와 엔티티 프로퍼티명의 조합으로 쿼리를 자동 생성해요.

```
findByTitleContaining(String keyword)  → 자동 생성 가능
findAllByTagIn(List<String> tags)      → 자동 생성 가능
searchAll(...)                          → 규약에 없음 → 자동 생성 불가
```

![](/uploads/project/EduMeet/file-move-error/file-moveerror-09.png)

문제의 근본 원인은 `BoardJpaRepository`가 `BoardSearchRepository` 인터페이스를 **extends**로 확장하고 있었기 때문이에요.
Spring Data JPA는 `BoardJpaRepository`에 선언된 모든 메서드(상속받은 것 포함)를 쿼리 메서드로 해석하려 하거든요.
`searchAll`은 JPA 쿼리 메서드 규약에 맞지 않으므로 파싱 실패가 발생한 거예요.

정리하면:
1. `BoardJpaRepository`가 `BoardSearchRepository`를 extends → JPA가 `searchAll`을 자동 구현하려 시도
2. `searchAll`은 JPA 쿼리 메서드 명명 규칙에 없는 이름 → 파싱 실패
3. 기존에는 `BoardSearchImpl`이 같은 패키지에 있어서 Spring Data JPA가 Custom Repository Implementation으로 인식했지만, Infrastructure 레이어로 이동하면서 이 연결이 끊어진 것

---

## 해결

`BoardSearchRepositoryImpl`을 Infrastructure로 이동했으므로, `BoardJpaRepository`가 `BoardSearchRepository`를 extends할 이유가 없어요.
각각 독립된 빈으로 관리하는 것이 더 적절하죠.

![](/uploads/project/EduMeet/file-move-error/file-moveerror-10.png)

**1단계**: `BoardJpaRepository`에서 `BoardSearchRepository` extends 제거

![](/uploads/project/EduMeet/file-move-error/file-moveerror-11.png)

**2단계**: `BoardSearchRepositoryImpl`에 `@Repository` 어노테이션 추가

`@Component`로 선언해도 빈 등록은 되지만, `@Repository`를 선택한 이유는 두 가지예요.
1. **의미적 명확성**: 데이터 접근 계층임을 명시
2. **예외 변환**: Spring이 데이터 접근 예외를 `DataAccessException`으로 자동 변환

![](/uploads/project/EduMeet/file-move-error/file-moveerror-12.png)

**3단계**: Service에서 `BoardSearchRepository`를 직접 주입받아 사용

---

## 해결 후 구조

| 컴포넌트 | 변경 내용 |
|----------|----------|
| `BoardJpaRepository` | `BoardSearchRepository` extends 제거. 순수 JPA 엔티티 관리만 담당 |
| `BoardSearchRepositoryImpl` | `@Repository`로 독립 빈 등록. QueryDSL 기반 복잡 쿼리 담당 |
| `BoardServiceImpl` | `BoardSearchRepository`를 `private final`로 직접 주입 |

결과적으로 `BoardJpaRepository`는 JPA 엔티티 관리만, `BoardSearchRepositoryImpl`은 QueryDSL 기반 복잡 쿼리만 담당하게 되어 **관심사 분리(SRP)**가 달성됐어요.
인터페이스 기반의 의존성 역전도 유지되고요.

---

## 번외: AI가 제안한 방법과의 차이

![](/uploads/project/EduMeet/file-move-error/bonus.png)

같은 문제를 AI에게 물어봤을 때, AI는 2가지 방법만 제안했어요.
하지만 제가 선택한 방법은 달랐어요.
extends에서 분리하고 `private final BoardSearchRepository`로 직접 주입하는 방식이에요.

AI가 제안한 방법이 틀린 건 아닐 수 있지만, 현재 프로젝트의 레이어 구조와 의존성 방향을 고려했을 때 분리하는 것이 더 적절하다고 판단했어요.

AI의 답변을 무조건 수용하기보다, 현재 아키텍처의 맥락에서 검증하고 판단하는 과정이 중요하다고 생각해요.
AI가 제시하는 것이 모든 방법의 전부가 아니라는 전제로, 스스로 근거를 갖고 선택하는 것이 더 나은 결과를 만들어요.

---

## Reference

- [Spring Data JPA - Query Methods](https://docs.spring.io/spring-data/jpa/reference/jpa/query-methods.html)
- [Baeldung - Spring Data JPA Custom Repository](https://www.baeldung.com/spring-data-jpa-custom-queries)

<!-- EN -->

## Normal Behavior

In layered architecture, interfaces belong in the Application layer, and their implementations belong in the Infrastructure layer. This ensures the Dependency Inversion Principle (DIP) is upheld, preventing the Application layer from directly depending on specific technologies (QueryDSL, JPA, etc.).

---

## The Problem

![](/uploads/project/EduMeet/file-move-error/file-moveerror.png)

While implementing QueryDSL-based search functionality during development, both `BoardSearch` (interface) and `BoardSearchImpl` (implementation) were placed in the Application layer.

Recognizing the structural issue, two steps were taken.

**Step 1: Name Cleanup**

The names `BoardSearch` and `BoardSearchImpl` didn't clearly convey their roles. Since they're Repository implementations using QueryDSL, the names were changed:

- `BoardSearch` → `BoardSearchRepository`
- `BoardSearchImpl` → `BoardSearchRepositoryImpl`

**Step 2: Move Implementation to Infrastructure Layer**

The interface stayed in the Application layer, while the implementation `BoardSearchRepositoryImpl` was moved to the Infrastructure layer.

![](/uploads/project/EduMeet/file-move-error/file-moveerror-02.png)
![](/uploads/project/EduMeet/file-move-error/file-moveerror-03.png)
![](/uploads/project/EduMeet/file-move-error/file-moveerror-04.png)
![](/uploads/project/EduMeet/file-move-error/file-moveerror-05.png)
![](/uploads/project/EduMeet/file-move-error/file-moveerror-06.png)

However, immediately after the move, the application failed to start.

![](/uploads/project/EduMeet/file-move-error/file-moveerror-07.png)

---

## Root Cause Analysis

The error message revealed that Spring Data JPA failed while trying to auto-implement the `searchAll(...)` method in `BoardJpaRepository`.

![](/uploads/project/EduMeet/file-move-error/file-moveerror-08.png)

According to the [Spring Data JPA official documentation](https://docs.spring.io/spring-data/jpa/reference/jpa/query-methods.html), JPA auto-generates queries using **conventional prefixes** like `findBy`, `findAllBy`, `countBy`, `deleteBy` combined with entity property names.

```
findByTitleContaining(String keyword)  → Auto-generation possible
findAllByTagIn(List<String> tags)      → Auto-generation possible
searchAll(...)                          → Not in convention → Cannot auto-generate
```

![](/uploads/project/EduMeet/file-move-error/file-moveerror-09.png)

The root cause was that `BoardJpaRepository` was **extending** the `BoardSearchRepository` interface. Spring Data JPA tries to interpret all methods in `BoardJpaRepository` (including inherited ones) as query methods. Since `searchAll` doesn't follow JPA query method naming conventions, parsing failed.

In summary:
1. `BoardJpaRepository` extends `BoardSearchRepository` → JPA tries to auto-implement `searchAll`
2. `searchAll` doesn't match JPA query method naming conventions → Parsing failure
3. Previously, `BoardSearchImpl` being in the same package let Spring Data JPA recognize it as a Custom Repository Implementation, but moving to the Infrastructure layer broke this connection

---

## Solution

Since `BoardSearchRepositoryImpl` was moved to Infrastructure, there's no reason for `BoardJpaRepository` to extend `BoardSearchRepository`. Managing them as independent beans is more appropriate.

![](/uploads/project/EduMeet/file-move-error/file-moveerror-10.png)

**Step 1**: Remove `BoardSearchRepository` extends from `BoardJpaRepository`

![](/uploads/project/EduMeet/file-move-error/file-moveerror-11.png)

**Step 2**: Add `@Repository` annotation to `BoardSearchRepositoryImpl`

While `@Component` would also register the bean, `@Repository` was chosen for two reasons:
1. **Semantic clarity**: Explicitly indicates a data access layer
2. **Exception translation**: Spring automatically converts data access exceptions to `DataAccessException`

![](/uploads/project/EduMeet/file-move-error/file-moveerror-12.png)

**Step 3**: Inject `BoardSearchRepository` directly in the Service

---

## Post-Fix Structure

| Component | Change |
|-----------|--------|
| `BoardJpaRepository` | Removed `BoardSearchRepository` extends. Handles only pure JPA entity management |
| `BoardSearchRepositoryImpl` | Registered as independent bean with `@Repository`. Handles QueryDSL-based complex queries |
| `BoardServiceImpl` | Directly injects `BoardSearchRepository` via `private final` |

As a result, `BoardJpaRepository` handles only JPA entity management, while `BoardSearchRepositoryImpl` handles only QueryDSL-based complex queries, achieving **separation of concerns (SRP)**. Interface-based dependency inversion is also maintained.

---

## Aside: Difference from AI-Suggested Approach

![](/uploads/project/EduMeet/file-move-error/bonus.png)

When asking AI about the same problem, it suggested only 2 approaches. But my chosen approach was different — separating the extends and directly injecting via `private final BoardSearchRepository`.

The AI's suggestions may not be wrong, but considering the current project's layer structure and dependency directions, separation was more appropriate in my judgment.

Rather than unconditionally accepting AI answers, it's important to verify and judge them in the context of the current architecture. The premise should be that AI doesn't present all possible solutions — making evidence-based choices yourself leads to better outcomes.

---

## Reference

- [Spring Data JPA - Query Methods](https://docs.spring.io/spring-data/jpa/reference/jpa/query-methods.html)
- [Baeldung - Spring Data JPA Custom Repository](https://www.baeldung.com/spring-data-jpa-custom-queries)

---
title: 'Lazy 로딩에서 발생한 No Session 오류'
titleEn: 'No Session Error from Lazy Loading'
description: JPA Lazy 로딩에서 발생한 LazyInitializationException의 원인과 @EntityGraph를 이용한 해결 과정을 정리한다.
descriptionEn: Analyzes the cause of LazyInitializationException in JPA lazy loading and the solution using @EntityGraph.
date: 2025-07-21T00:00:00.000Z
tags:
  - JPA
  - Lazy Loading
  - EntityGraph
  - Hibernate
  - Spring Data JPA
category: project/EduMeet
draft: false
coverImage: "/uploads/project/EduMeet/lazy-loading-no-session/lazy-no-session-error.png"
---

## 정상 상태

Board(게시글)와 BoardImage(첨부파일)는 `@OneToMany` 관계로 매핑되어 있어요.
`@OneToMany`의 기본 fetch 전략은 `FetchType.LAZY`로, 게시글을 조회하면 Board 엔티티만 먼저 로딩되고, BoardImage는 실제로 접근하는 시점에 별도 SELECT가 실행되는 구조예요.

즉, Board 조회 → BoardImage 접근 순서로 **총 2번의 SELECT**가 실행되어야 정상이에요.

---

## 문제 상황

단위 테스트에서 Board를 조회한 뒤 BoardImage에 접근하려 하자, `LazyInitializationException: no session` 오류가 발생했어요.

![](/uploads/project/EduMeet/lazy-loading-no-session/lazy-no-session-error.png)

실행 결과를 보면 Board까지의 출력은 정상적으로 끝났지만, 그 직후 BoardImage를 SELECT하려는 시점에 DB 세션이 이미 닫혀 있었어요.

---

## 원인 분석

Lazy 로딩은 **영속성 컨텍스트(Persistence Context)가 살아 있는 동안에만 동작**해요.
영속성 컨텍스트는 트랜잭션 범위와 생명주기가 같기 때문에, 트랜잭션이 없는 테스트 메서드에서는 첫 번째 SELECT(Board 조회)가 끝나는 즉시 영속성 컨텍스트가 닫혀요.

이 상태에서 BoardImage에 접근하면, Hibernate가 프록시 객체를 초기화하려고 하지만 이미 세션이 없으므로 `no session` 오류가 발생해요.

핵심은 **Lazy 로딩 = 프록시 초기화 = 영속성 컨텍스트 필요**라는 점이에요.
테스트 코드에 트랜잭션이 없으면 이 전제가 깨지죠.

---

## 해결 과정

### 1차 시도: @Transactional 추가

가장 단순한 해결책은 테스트 메서드에 `@Transactional`을 추가하는 거예요.
이 어노테이션이 적용되면 메서드 전체가 하나의 트랜잭션으로 감싸지므로, 메서드 내에서 추가 쿼리를 여러 번 실행할 수 있어요.

하지만 이 방법은 **테스트 환경에서만 유효한 우회책**이에요.
실제 서비스 코드에서는 트랜잭션 범위 밖에서 Lazy 엔티티에 접근하는 상황이 동일하게 발생할 수 있거든요.

### 2차 시도: @EntityGraph 적용

근본적인 해결을 위해 `@EntityGraph`를 적용했어요.
`@EntityGraph`는 JPA가 제공하는 어노테이션으로, 지정한 연관 엔티티를 **조회 시점에 함께 로딩**(Eager)하도록 선언할 수 있어요.

![](/uploads/project/EduMeet/lazy-loading-no-session/solutions-entitygraph.png)

`@EntityGraph`의 `attributePaths`에 `imageSet`을 명시하여, Board 조회 시 BoardImage를 한 번에 가져오도록 설정했어요.

단위 테스트를 다시 실행한 결과:

![](/uploads/project/EduMeet/lazy-loading-no-session/solutions-entitygraph-02.png)

실행 결과의 쿼리를 보면, Board 테이블과 BoardImage 테이블이 **LEFT JOIN으로 한 번에 조회**됐어요.
별도의 추가 SELECT 없이 게시글과 첨부파일을 동시에 처리할 수 있게 된 거예요.

---

## 정리

| 구분 | @Transactional | @EntityGraph |
|------|---------------|--------------|
| 해결 방식 | 트랜잭션 범위 확장 | 조인으로 한 번에 조회 |
| 쿼리 수 | 2회 (Board + BoardImage) | 1회 (JOIN) |
| 적용 범위 | 테스트 한정 우회 | 서비스 코드에서도 적용 가능 |
| 근본 해결 | 아님 | 맞음 |

`@OneToMany` 구조에서 Lazy 로딩을 유지하면서도, 필요한 시점에 `@EntityGraph`로 Eager 전환을 선언할 수 있다는 점이 핵심이에요.
하위 엔티티의 로딩 전략을 **상황에 따라 유연하게 제어**할 수 있죠.

---

## Reference

- [Hibernate ORM 6.0 Migration Guide - DISTINCT](https://docs.jboss.org/hibernate/orm/6.0/migration-guide/migration-guide.html#query-sqm-distinct)
- [Vlad Mihalcea - The best way to handle the LazyInitializationException](https://vladmihalcea.com/the-best-way-to-handle-the-lazyinitializationexception/)

<!-- EN -->

## Normal Behavior

Board (post) and BoardImage (attachment) are mapped with a `@OneToMany` relationship. The default fetch strategy for `@OneToMany` is `FetchType.LAZY`, meaning when a post is retrieved, only the Board entity is loaded first, and BoardImage triggers a separate SELECT when actually accessed.

In other words, Board retrieval → BoardImage access should result in **2 SELECT queries total**.

---

## The Problem

In a unit test, after retrieving a Board and trying to access its BoardImage, a `LazyInitializationException: no session` error occurred.

![](/uploads/project/EduMeet/lazy-loading-no-session/lazy-no-session-error.png)

The execution output showed that Board was printed successfully, but at the point of trying to SELECT BoardImage, the DB session had already closed.

---

## Root Cause Analysis

Lazy loading **only works while the Persistence Context is alive**. Since the Persistence Context shares its lifecycle with the transaction, in a test method without a transaction, the Persistence Context closes immediately after the first SELECT (Board retrieval).

When BoardImage is accessed in this state, Hibernate tries to initialize the proxy object but fails because the session no longer exists, resulting in the `no session` error.

The key insight is: **Lazy loading = Proxy initialization = Persistence Context required**. Without a transaction in test code, this premise breaks.

---

## Resolution

### First Attempt: Adding @Transactional

The simplest fix is adding `@Transactional` to the test method. This wraps the entire method in a single transaction, allowing multiple queries within the method.

However, this approach is **only a workaround valid in the test environment**. In actual service code, the same situation of accessing Lazy entities outside the transaction scope can occur.

### Second Attempt: Applying @EntityGraph

For a fundamental solution, `@EntityGraph` was applied. `@EntityGraph` is a JPA annotation that declares specified related entities to be **loaded eagerly at query time**.

![](/uploads/project/EduMeet/lazy-loading-no-session/solutions-entitygraph.png)

By specifying `imageSet` in `@EntityGraph`'s `attributePaths`, Board retrieval now fetches BoardImage in a single query.

Re-running the unit test:

![](/uploads/project/EduMeet/lazy-loading-no-session/solutions-entitygraph-02.png)

The query log shows that Board and BoardImage tables were **retrieved in a single LEFT JOIN**. Posts and attachments can now be processed simultaneously without additional SELECTs.

---

## Summary

| Aspect | @Transactional | @EntityGraph |
|--------|---------------|--------------|
| Approach | Extend transaction scope | Join in single query |
| Query Count | 2 (Board + BoardImage) | 1 (JOIN) |
| Applicability | Test-only workaround | Applicable in service code too |
| Fundamental Fix | No | Yes |

The key takeaway is that while maintaining Lazy loading in a `@OneToMany` structure, you can declare Eager fetching with `@EntityGraph` when needed. This allows **flexible control over child entity loading strategies based on the situation**.

---

## Reference

- [Hibernate ORM 6.0 Migration Guide - DISTINCT](https://docs.jboss.org/hibernate/orm/6.0/migration-guide/migration-guide.html#query-sqm-distinct)
- [Vlad Mihalcea - The best way to handle the LazyInitializationException](https://vladmihalcea.com/the-best-way-to-handle-the-lazyinitializationexception/)

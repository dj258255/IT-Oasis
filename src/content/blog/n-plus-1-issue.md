---
title: 'N+1 문제 분석과 해결'
titleEn: 'N+1 Problem Analysis and Resolution'
description: JPA N+1 문제의 4가지 해결 방법(FetchJoin, EntityGraph, SUBSELECT, BatchSize)을 실측 비교하고 최적 전략을 선택한 과정을 정리한다.
descriptionEn: Compares four N+1 solutions (FetchJoin, EntityGraph, SUBSELECT, BatchSize) with real benchmarks and documents the optimal strategy selection.
date: 2025-07-29T00:00:00.000Z
tags:
  - JPA
  - N+1
  - FetchJoin
  - EntityGraph
  - BatchSize
  - Hibernate
  - Performance
category: 프로젝트/EduMeet
draft: false
---

## 정상 상태

Board(게시글)와 BoardImage(첨부파일)는 `@OneToMany` 관계이며, `FetchType.LAZY`로 설정되어 있다. 게시글 목록 조회 시 페이징된 Board 데이터를 가져오는 **1개의 쿼리**가 실행되고, 필요한 시점에 하위 엔티티를 조회하는 것이 정상 동작이다.

---

## 문제 상황

더미 데이터 100건을 넣고 Board와 Reply를 left join하는 단위 테스트를 작성했다.

![](/uploads/n-plus-1-issue/n1-occurred-background.png)

![](/uploads/n-plus-1-issue/n1-occurred-background-02.png)

페이지 사이즈를 10으로 설정하고 테스트를 실행했는데, 실행 속도가 비정상적으로 느렸다.

![](/uploads/n-plus-1-issue/n1-occurred-background-03.png)

실행된 쿼리 로그를 확인해보니, 목록을 가져오는 쿼리 1건 외에 **각 게시글마다 board_image를 조회하는 쿼리가 개별 실행**되고 있었다.

![](/uploads/n-plus-1-issue/n1-occurred-background-04.png)

---

## 원인 분석

이 현상은 **N+1 문제**다. 목록을 가져오는 쿼리 1건(+1)과, 각 게시글마다 연관 엔티티를 조회하는 쿼리 N건이 발생하는 것이다.

실행 순서를 정리하면:

1. 게시판에 대한 페이징 처리가 실행되면서 `LIMIT`으로 10건 조회
2. `System.out.println()`으로 게시판 ID 출력
3. 게시판 객체의 `imageSet`에 접근하면서 `board_image` 테이블을 조회하는 쿼리 실행
4. 2~3을 반복

연관 엔티티를 `FetchType.LAZY`로 설정하면, 하위 필드에 접근할 때마다 Hibernate가 프록시 객체를 초기화하면서 추가 쿼리가 발생한다. 이 문제는 `FetchType.EAGER`로 바꾼다고 해결되지 않는다. Eager 전략이더라도 연관 엔티티를 개별 쿼리로 로딩하는 것은 동일하기 때문이다.

N+1 문제의 해결 방법은 4가지가 있다.

---

## 해결 방법 4가지

### 1. FetchJoin

JPQL의 `JOIN FETCH` 키워드를 사용하여 연관 엔티티를 한 번의 쿼리로 함께 조회하는 방법이다.

- `JOIN FETCH`: Inner Join 쿼리 실행
- `LEFT JOIN FETCH`: Left Outer Join 쿼리 실행

Inner Join이 Left Join보다 검색 범위가 좁아 성능이 우수하므로, 하위 엔티티가 반드시 존재하는 경우에는 Inner Join을 사용하는 것이 좋다.

**장점:** 한 번의 쿼리로 연관 엔티티를 모두 조회, DB 왕복 횟수 최소화, `LazyInitializationException` 방지

**단점:** 페이징 처리 시 메모리에서 처리, 1:N 조인으로 데이터 중복 발생, 여러 `@OneToMany` 컬렉션을 동시에 Fetch Join할 수 없음

**주의사항:**

1. **별칭 사용 주의** — Left Join Fetch에서 별칭을 사용하면 DB와의 데이터 일관성을 해칠 수 있다.

![](/uploads/n-plus-1-issue/cautions.png)

2. **카테시안 곱 중복 발생** — `@OneToMany` 컬렉션을 Fetch Join할 때 발생한다. **Hibernate 6부터는 자동으로 중복을 필터링**하지만, 명시적으로 `DISTINCT`를 선언하는 편이 의도가 명확하다.

![](/uploads/n-plus-1-issue/cautions-02.png)

3. **컬렉션 2개 이상 동시 Fetch Join 금지** — `@XToMany` 컬렉션 필드는 **하나만** Fetch Join 가능하다. 두 개 이상이면 `MultipleBagFetchException` 발생. List 대신 Set을 사용하면 회피 가능하다.

**변경 전 (에러 발생)**
![](/uploads/n-plus-1-issue/cautions-03.png)

**변경 후 (에러 해결)**
![](/uploads/n-plus-1-issue/cautions-04.png)

4. **페이징 금지** — `@XToMany` 컬렉션을 Fetch Join한 상태에서 페이징하면, Hibernate가 **모든 데이터를 메모리에 로드 후 애플리케이션 레벨에서 페이징**을 수행한다.

> **결론**: 현재 게시판은 페이징이 필수이므로, FetchJoin 단독 사용은 부적합하다.

---

### 2. EntityGraph

`@EntityGraph`는 JPA가 제공하는 어노테이션으로, Fetch Join을 선언적으로 사용하는 방법이다. 내부적으로 **Left Join** 기반으로 동작한다.

**장점:** 쿼리 메서드만으로 구현 가능, 동적 fetch 전략 변경 가능, Named Graph로 재사용 가능

**단점:** 항상 Left Join으로 동작, Fetch Join과 동일한 제약사항 (페이징 불가, 카테시안 곱 문제)

---

### 3. @Fetch(FetchMode.SUBSELECT)

첫 번째 쿼리로 부모 엔티티를 조회한 후, 두 번째 쿼리에서 서브쿼리를 사용하여 연관된 모든 자식 엔티티를 한 번에 조회하는 방식이다.

**장점:** 서브쿼리로 한 번에 연관 데이터 로딩 (총 2개 쿼리), 중복 데이터 없음

**단점:** 첫 번째 쿼리 결과 전체를 기반으로 두 번째 쿼리가 실행, 대용량 데이터에서 비효율적

---

### 4. @BatchSize

여러 개의 프록시 객체를 조회할 때, WHERE 절이 같은 여러 SELECT 쿼리들을 하나의 **IN 쿼리**로 합쳐주는 옵션이다.

**장점:** 페이징과 완벽 호환, N+1 문제를 N/size로 완화, 메모리 효율적, 중복 데이터 없음

**단점:** 완전한 해결은 아님 (여전히 추가 쿼리 실행), 최적의 batch size 튜닝 필요

---

## 실측 비교

각 전략의 실제 성능을 비교하기 위해 Hibernate 통계 기능을 활성화했다.

### 기존 N+1 상태

![](/uploads/n-plus-1-issue/stats.png)
![](/uploads/n-plus-1-issue/stats-02.png)

### FetchJoin 적용

![](/uploads/n-plus-1-issue/fetch-join.png)
![](/uploads/n-plus-1-issue/fetch-join-02.png)

테스트 결과:

![](/uploads/n-plus-1-issue/fetch-join-03.png)
![](/uploads/n-plus-1-issue/fetch-join-04.png)

N+1은 해결되었지만 메모리 페이징 경고가 발생했다.

![](/uploads/n-plus-1-issue/fetch-join-05.png)

`HHH90003004: firstResult/maxResults specified with collection fetch; applying in memory`

### EntityGraph 적용

![](/uploads/n-plus-1-issue/entitygraph.png)
![](/uploads/n-plus-1-issue/entitygraph-02.png)

![](/uploads/n-plus-1-issue/entitygraph-03.png)
![](/uploads/n-plus-1-issue/entitygraph-04.png)

FetchJoin과 동일하게 메모리 페이징 경고 발생.

![](/uploads/n-plus-1-issue/entitygraph-05.png)

**FetchJoin과 EntityGraph의 핵심 차이: COUNT 쿼리**

FetchJoin의 COUNT 쿼리는 `left join board_image`를 포함하지만, EntityGraph의 COUNT 쿼리는 `board` 테이블만 조회한다. EntityGraph가 COUNT 쿼리에서 불필요한 JOIN을 하지 않아 더 효율적이다.

![](/uploads/n-plus-1-issue/diff.png)
![](/uploads/n-plus-1-issue/diff-02.png)

### SUBSELECT 적용

![](/uploads/n-plus-1-issue/fetchfetchmodesubselect.png)

기대와 달리 쿼리가 대량으로 실행됐다. 총 75개의 JDBC statements가 실행되었다.

![](/uploads/n-plus-1-issue/fetchfetchmodesubselect-02.png)
![](/uploads/n-plus-1-issue/fetchfetchmodesubselect-03.png)
![](/uploads/n-plus-1-issue/fetchfetchmodesubselect-04.png)
![](/uploads/n-plus-1-issue/fetchfetchmodesubselect-05.png)

**실패 원인:** Spring Data JPA의 Page 인터페이스가 COUNT와 데이터 쿼리를 별도 Session에서 실행하여 SUBSELECT 최적화 조건을 위반했다.

![](/uploads/n-plus-1-issue/hibernate-subselect-optimization.png)
![](/uploads/n-plus-1-issue/hibernate-subselect-optimization-02.png)
![](/uploads/n-plus-1-issue/hibernate-subselect-optimization-03.png)

수동 Session 관리를 시도했으나, 전체 Parent ID 기준으로 SUBSELECT가 실행되는 문제가 발생했다.

![](/uploads/n-plus-1-issue/solution.png)
![](/uploads/n-plus-1-issue/solution-02.png)
![](/uploads/n-plus-1-issue/solution-03.png)

**결론**: SUBSELECT는 Spring Data JPA의 페이징 처리 방식과 근본적으로 호환되지 않는다.

### BatchSize 적용

![](/uploads/n-plus-1-issue/batchsize.png)

`@BatchSize(size = 20)` 적용 결과 **4개 쿼리만 실행**되었다:

```sql
-- 1번째: 목록 조회 쿼리
SELECT b.id, b.content, b.mod_date, b.reg_date, b.title, b.writer
FROM board b LEFT JOIN reply r ON r.board_id = b.id
ORDER BY b.id DESC LIMIT 10;

-- 2번째: BatchSize가 작동한 이미지 조회 쿼리
SELECT is1_0.board_id, is1_0.uuid, is1_0.filename, is1_0.ord
FROM board_image is1_0
WHERE is1_0.board_id IN (100, 99, 98, 97, 96, 95, 94, 93, 92, 91);

-- 3번째: findAll 쿼리
-- 4번째: COUNT 쿼리
```

![](/uploads/n-plus-1-issue/stats-03.png)
![](/uploads/n-plus-1-issue/stats-04.png)

---

## 전체 비교

### 성능 비교 표 (단위: ms)

| 전략 | Conn. | Prep. | Exec. | Pre-Flush | Flush | Total Time |
| --- | --- | --- | --- | --- | --- | --- |
| **N+1 (기본)** | 0.49 | 2.29 | 14.99 | 12.47 | 8.09 | **38.33** ms |
| `@FetchJoin` | 0.36 | 0.24 | 6.42 | 7.42 | 5.97 | **20.41** ms |
| `@EntityGraph` | 0.42 | 0.26 | 40.02 | 6.35 | 4.73 | **51.78** ms |
| `@Fetch(SUBSELECT)` | 0.35 | 6.16 | 28.93 | 2.54 | 3.04 | **40.99** ms |
| `@BatchSize(20)` | 0.39 | 0.50 | 3.77 | 5.04 | 2.96 | **12.66** ms |

### 성능 개선율 (기준: N+1 = 38.33ms)

| 전략 | Total(ms) | 개선율 |
| --- | --- | --- |
| N+1 | 38.33 | - |
| `@FetchJoin` | 20.41 | **46.7% 개선** |
| `@EntityGraph` | 51.78 | 성능 악화 (+35.1%) |
| `@Fetch(SUBSELECT)` | 40.99 | 성능 저하 (+6.9%) |
| `@BatchSize(20)` | 12.66 | **66.9% 개선** |

---

## 적용: @BatchSize 선택

이 프로젝트에서는 `@BatchSize(size = 20)`로 N+1 문제를 해결했다.

선택 이유:
1. **페이징 호환**: Spring Data JPA의 Page 인터페이스와 완벽하게 호환
2. **성능**: 66.9% 개선으로 4가지 중 가장 우수
3. **안정성**: 쿼리 수가 일정하게 유지되고, 메모리 효율적
4. **적용 용이성**: 어노테이션 하나로 적용 가능

---

## 상황별 최적 전략

**게시글 목록 조회 (페이징 필요)** → BatchSize 권장

![](/uploads/n-plus-1-issue/board-query-paging.png)

**단일 게시글 상세 조회** → EntityGraph 권장

![](/uploads/n-plus-1-issue/board-query.png)

**특정 게시글 소량 조회 (페이징 불필요)** → FetchJoin 권장

![](/uploads/n-plus-1-issue/board-querypaging.png)

---

## N+1은 왜 ORM 차원에서 해결하지 않는가

N+1은 "버그"가 아니라 **트레이드오프**다.

Lazy 로딩은 "필요한 시점에 필요한 데이터만 로드한다"는 설계 원칙을 따른다. 문제가 되는 것은 "목록 조회 후 연관 엔티티에 접근"하는 패턴이 빈번하기 때문이다. Hibernate는 FetchJoin, EntityGraph, BatchSize 등 **상황에 맞는 최적화 도구를 제공**하여 개발자가 선택할 수 있도록 하고 있다.

ORM이 모든 경우를 자동으로 최적화하면, 반대로 불필요한 데이터까지 로드하는 문제가 생긴다. 사용자에게 선택권을 주는 것이 올바른 설계 판단이다.

---

## Reference

- [Hibernate ORM 6.0 Migration Guide - DISTINCT](https://docs.jboss.org/hibernate/orm/6.0/migration-guide/migration-guide.html#query-sqm-distinct)
- [Baeldung - Hibernate FetchMode](https://www.baeldung.com/hibernate-fetchmode)

<!-- EN -->

## Normal Behavior

Board (post) and BoardImage (attachment) have a `@OneToMany` relationship with `FetchType.LAZY`. When retrieving a post list, **a single query** should fetch paginated Board data, with child entities loaded on demand.

---

## The Problem

After inserting 100 dummy records and writing a unit test with Board and Reply left join, the page size was set to 10 and the test ran abnormally slowly.

![](/uploads/n-plus-1-issue/n1-occurred-background.png)
![](/uploads/n-plus-1-issue/n1-occurred-background-02.png)
![](/uploads/n-plus-1-issue/n1-occurred-background-03.png)

The query log revealed that beyond the list query, **individual queries for board_image were being executed for each post**.

![](/uploads/n-plus-1-issue/n1-occurred-background-04.png)

---

## Root Cause

This is the **N+1 problem**: 1 query to fetch the list (+1) and N queries to fetch related entities for each post.

Setting related entities to `FetchType.LAZY` means Hibernate initializes proxy objects with additional queries each time a child field is accessed. Switching to `FetchType.EAGER` doesn't solve this — Eager strategy still loads related entities with individual queries.

There are 4 solutions to the N+1 problem.

---

## Four Solutions

### 1. FetchJoin

Uses JPQL's `JOIN FETCH` keyword to retrieve related entities in a single query.

**Pros:** Single query for all related entities, minimized DB round trips

**Cons:** In-memory pagination, data duplication from 1:N joins, cannot simultaneously Fetch Join multiple `@OneToMany` collections

**Critical: Pagination is forbidden** with `@XToMany` collection Fetch Join — Hibernate loads all data into memory and paginates at the application level.

### 2. EntityGraph

JPA annotation for declarative Fetch Join. Operates on **Left Join** internally.

**Pros:** Simple implementation with query methods, dynamic fetch strategy changes

**Cons:** Always Left Join, same constraints as Fetch Join

### 3. @Fetch(FetchMode.SUBSELECT)

After the first query fetches parent entities, a second query uses a subquery to load all related child entities at once.

**Pros:** Single subquery for all related data (2 queries total), no duplicates

**Cons:** Second query runs based on entire first query result, inefficient with large datasets

### 4. @BatchSize

Combines multiple SELECT queries with identical WHERE clauses into a single **IN query**.

**Pros:** Perfect pagination compatibility, reduces N+1 to N/size, memory efficient, no duplicates

**Cons:** Not a complete solution (still executes additional queries), requires batch size tuning

---

## Real Benchmarks

Hibernate statistics were enabled to compare actual performance of each strategy.

### Performance Comparison (unit: ms)

| Strategy | Conn. | Prep. | Exec. | Pre-Flush | Flush | Total Time |
| --- | --- | --- | --- | --- | --- | --- |
| **N+1 (default)** | 0.49 | 2.29 | 14.99 | 12.47 | 8.09 | **38.33** ms |
| `@FetchJoin` | 0.36 | 0.24 | 6.42 | 7.42 | 5.97 | **20.41** ms |
| `@EntityGraph` | 0.42 | 0.26 | 40.02 | 6.35 | 4.73 | **51.78** ms |
| `@Fetch(SUBSELECT)` | 0.35 | 6.16 | 28.93 | 2.54 | 3.04 | **40.99** ms |
| `@BatchSize(20)` | 0.39 | 0.50 | 3.77 | 5.04 | 2.96 | **12.66** ms |

### Improvement Rate (baseline: N+1 = 38.33ms)

| Strategy | Total(ms) | Improvement |
| --- | --- | --- |
| N+1 | 38.33 | - |
| `@FetchJoin` | 20.41 | **46.7% faster** |
| `@EntityGraph` | 51.78 | Degraded (+35.1%) |
| `@Fetch(SUBSELECT)` | 40.99 | Degraded (+6.9%) |
| `@BatchSize(20)` | 12.66 | **66.9% faster** |

**Key findings:**
- **SUBSELECT** is fundamentally incompatible with Spring Data JPA's pagination — the Page interface runs COUNT and data queries in separate Sessions, violating SUBSELECT's optimization conditions.
- **FetchJoin vs EntityGraph**: The core difference is in COUNT queries. EntityGraph's COUNT query only scans the `board` table, while FetchJoin's includes unnecessary joins.

---

## Applied: @BatchSize Selected

This project solved the N+1 problem with `@BatchSize(size = 20)`.

Reasons:
1. **Pagination compatible**: Works perfectly with Spring Data JPA's Page interface
2. **Performance**: Best improvement at 66.9%
3. **Stability**: Consistent query count, memory efficient
4. **Ease of use**: Applied with a single annotation

---

## Optimal Strategy by Scenario

- **Post list with pagination** → BatchSize recommended
- **Single post detail view** → EntityGraph recommended
- **Small batch retrieval without pagination** → FetchJoin recommended

---

## Why Doesn't ORM Solve N+1 Automatically?

N+1 is not a "bug" — it's a **trade-off**.

Lazy loading follows the design principle of "load only the data you need, when you need it." The problem arises because the pattern of "fetching a list then accessing related entities" is so common. Hibernate provides **optimization tools for different situations** (FetchJoin, EntityGraph, BatchSize), letting developers choose.

If ORM automatically optimized every case, it would conversely cause problems by loading unnecessary data. Giving users the choice is the correct design decision.

---

## Reference

- [Hibernate ORM 6.0 Migration Guide - DISTINCT](https://docs.jboss.org/hibernate/orm/6.0/migration-guide/migration-guide.html#query-sqm-distinct)
- [Baeldung - Hibernate FetchMode](https://www.baeldung.com/hibernate-fetchmode)

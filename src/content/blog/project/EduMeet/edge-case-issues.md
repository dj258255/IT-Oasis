---
title: '에지 케이스 테스트에서 발견한 버그들'
titleEn: 'Bugs Found Through Edge Case Testing'
description: 에지 케이스 테스트로 발견한 게시글과 댓글 관련 버그 12가지의 원인 분석과 해결 과정을 정리한다.
descriptionEn: Documents root cause analysis and resolution of 12 bugs found in posts and comments through edge case testing.
date: 2025-08-30T00:00:00.000Z
tags:
  - Edge Case
  - Unit Test
  - Bug Fix
  - Validation
  - Spring
  - JPA
category: project/EduMeet
draft: false
---

> 정상 동작하는 테스트 코드는 생략하고, 실패 사례와 그 해결 과정만 정리했다.

---

# 게시글

## 1. 제목이 없는 게시글 등록

### 정상 상태
게시글 등록 시 제목은 필수값이다. 제목이 비어 있으면 등록이 거부되어야 한다.

### 문제
제목 없이 게시글을 등록하는 테스트를 작성했는데, 예외 없이 정상 등록되었다.

![](/uploads/project/EduMeet/edge-case-issues/title-board-register-edge-test.png)

### 분석
검증 로직의 위치를 고민했다.

![](/uploads/project/EduMeet/edge-case-issues/title-board-register-edge-test-02.png)

레이어드 아키텍처의 책임 분리 원칙에 따르면:
- **Controller**: 요청 형식 검증 (`@Valid`, 타입 체크)
- **Service**: 비즈니스 규칙 검증 (도메인 규칙, 상태 검증)
- **Repository**: 순수 데이터 접근만

제목 필수 여부는 비즈니스 규칙이므로 Service에 넣는 것이 맞다고 판단했다.

### 해결
Service에 제목 검증 로직을 추가했다.

![](/uploads/project/EduMeet/edge-case-issues/title-board-register-edge-test-03.png)
![](/uploads/project/EduMeet/edge-case-issues/title-board-register-edge-test-04.png)
![](/uploads/project/EduMeet/edge-case-issues/title-board-register-edge-test-05.png)

---

## 2. 좋아요 토글 - 정수 오버플로우

### 문제
좋아요 수가 `Integer.MAX_VALUE`일 때 한 번 더 증가시키면 오버플로우가 발생했다.

![](/uploads/project/EduMeet/edge-case-issues/like-edge-test-processing.png)

### 해결
좋아요 증가 메서드에 오버플로우 방지 로직을 추가했다.

![](/uploads/project/EduMeet/edge-case-issues/like-edge-test-processing-02.png)

---

## 3. 매우 긴 제목의 게시글 등록

### 문제
제목 길이 제한 없이 등록을 시도하면, DB 컬럼 제한에 걸려 `DataIntegrityViolationException`이 발생했다.

![](/uploads/project/EduMeet/edge-case-issues/long-title-board-register-edge-test.png)

### 해결
Service의 제목 검증 메서드에 최대 길이 체크를 추가하여, DB에 도달하기 전에 예외를 던지도록 했다.

![](/uploads/project/EduMeet/edge-case-issues/long-title-board-register-edge-test-02.png)
![](/uploads/project/EduMeet/edge-case-issues/long-title-board-register-edge-test-03.png)

---

## 4. 논리적 삭제(Soft Delete) 기능이 동작하지 않음

### 정상 상태
게시글을 삭제하면 `deleted_at` 컬럼에 삭제 시각이 기록되고, 조회 시 `deleted_at IS NULL` 조건으로 삭제된 게시글이 제외되어야 한다.

### 문제
삭제 처리를 했는데, 삭제된 게시글이 여전히 조회됐다.

![](/uploads/project/EduMeet/edge-case-issues/logical-delete.png)

### 분석
원인이 2가지였다.

**원인 1**: 조회 쿼리에 `deleted_at IS NULL` 조건이 빠져 있었다.

![](/uploads/project/EduMeet/edge-case-issues/logical-delete-02.png)

**원인 2**: 순수 도메인 엔티티에 `deletedAt` 필드가 없었다.

![](/uploads/project/EduMeet/edge-case-issues/logical-delete-03.png)

### 해결
1. 도메인 엔티티에 `deletedAt` 필드 추가
2. 조회 쿼리에 `WHERE deleted_at IS NULL` 조건 추가

![](/uploads/project/EduMeet/edge-case-issues/logical-delete-04.png)
![](/uploads/project/EduMeet/edge-case-issues/logical-delete-05.png)
![](/uploads/project/EduMeet/edge-case-issues/logical-delete-06.png)

---

## 5. 카테고리별 게시글 조회 실패

### 문제
특정 카테고리의 게시글만 조회하려 했는데, 카테고리와 무관하게 전체 게시글이 반환됐다.

![](/uploads/project/EduMeet/edge-case-issues/category-board-query.png)

### 원인
QueryDSL의 WHERE 절에 카테고리 조건이 빠져 있었다.

![](/uploads/project/EduMeet/edge-case-issues/category-board-query-02.png)

### 해결
WHERE 절에 카테고리 필터 조건을 추가했다.

![](/uploads/project/EduMeet/edge-case-issues/category-board-query-03.png)

---

## 6. 좋아요/싫어요 토글에서 싫어요만 작동하지 않음

### 문제
UPDATE 문이 실행되지 않고, 새로운 엔티티로 INSERT하고 있었다.

![](/uploads/project/EduMeet/edge-case-issues/board-like-dislike.png)
![](/uploads/project/EduMeet/edge-case-issues/board-like-dislike-02.png)
![](/uploads/project/EduMeet/edge-case-issues/board-like-dislike-03.png)
![](/uploads/project/EduMeet/edge-case-issues/board-like-dislike-04.png)

### 해결
좋아요와 싫어요를 하나의 공통 메서드로 통합하여 동일한 로직을 사용하도록 했다.

![](/uploads/project/EduMeet/edge-case-issues/board-like-dislike-05.png)
![](/uploads/project/EduMeet/edge-case-issues/board-like-dislike-06.png)
![](/uploads/project/EduMeet/edge-case-issues/board-like-dislike-07.png)

---

## 7. 빈 게시글의 계층형 댓글 목록 조회 시 NPE

### 문제
`PageResponseDTO` 생성자에서 `total <= 0`일 때 early return하면 모든 필드가 초기화되지 않아 NPE가 발생했다.

![](/uploads/project/EduMeet/edge-case-issues/empty-hierarchical-reply-query-test.png)

### 해결
`total <= 0`일 때도 빈 결과에 대한 기본값을 설정한 뒤 return하도록 수정했다.

![](/uploads/project/EduMeet/edge-case-issues/empty-hierarchical-reply-query-test-02.png)

---

## 8. 게시글 타입 변경이 반영되지 않음

### 문제
게시글 타입을 변경하는 API를 호출했는데, 타입이 바뀌지 않았다.

![](/uploads/project/EduMeet/edge-case-issues/board-type-change-test.png)
![](/uploads/project/EduMeet/edge-case-issues/board-type-change-test-02.png)

### 원인
`change()` 메서드가 제목과 내용만 변경하고, `boardType`은 변경하지 않고 있었다.

![](/uploads/project/EduMeet/edge-case-issues/board-type-change-test-03.png)

### 해결
`change()` 메서드에 `boardType` 변경 로직을 추가했다.

![](/uploads/project/EduMeet/edge-case-issues/board-type-change-test-04.png)
![](/uploads/project/EduMeet/edge-case-issues/board-type-change-test-05.png)
![](/uploads/project/EduMeet/edge-case-issues/board-type-change-test-06.png)

---

## 9. 존재하지 않는 카테고리에 게시글 등록 가능

### 문제
존재하지 않는 카테고리 ID를 넣어도 게시글이 등록됐다.

![](/uploads/project/EduMeet/edge-case-issues/category-board-register-test.png)

### 원인
Service에서 카테고리 존재 여부를 검증하는 로직이 없었다.

![](/uploads/project/EduMeet/edge-case-issues/category-board-register-test-02.png)

### 해결
게시글 등록 전에 카테고리 존재 여부를 확인하고, 없으면 예외를 던지도록 했다.

![](/uploads/project/EduMeet/edge-case-issues/category-board-register-test-03.png)
![](/uploads/project/EduMeet/edge-case-issues/category-board-register-test-04.png)
![](/uploads/project/EduMeet/edge-case-issues/category-board-register-test-05.png)

---

## 10. 유효하지 않은 페이지 번호 처리

### 문제
`page=0`이나 `page=-1`을 넣어도 쿼리가 그대로 실행되어 예측할 수 없는 결과가 나왔다.

![](/uploads/project/EduMeet/edge-case-issues/valid-page-number-test.png)

### 해결
`PageRequestDTO`에 기본값과 범위 제한을 추가했다.

![](/uploads/project/EduMeet/edge-case-issues/valid-page-number-test-02.png)
![](/uploads/project/EduMeet/edge-case-issues/valid-page-number-test-03.png)
![](/uploads/project/EduMeet/edge-case-issues/valid-page-number-test-04.png)
![](/uploads/project/EduMeet/edge-case-issues/valid-page-number-test-05.png)
![](/uploads/project/EduMeet/edge-case-issues/valid-page-number-test-06.png)
![](/uploads/project/EduMeet/edge-case-issues/valid-page-number-test-07.png)
![](/uploads/project/EduMeet/edge-case-issues/valid-page-number-test-08.png)

---

# 댓글

## 1. 내용이 없는 댓글 등록 가능

### 문제
빈 문자열로 댓글을 등록할 수 있었다.

![](/uploads/project/EduMeet/edge-case-issues/content-reply-test.png)
![](/uploads/project/EduMeet/edge-case-issues/content-reply-test-02.png)

### 해결
Service에서 빈 내용과 최대 길이를 함께 검증하도록 했다.

![](/uploads/project/EduMeet/edge-case-issues/content-reply-test-03.png)
![](/uploads/project/EduMeet/edge-case-issues/content-reply-test-04.png)
![](/uploads/project/EduMeet/edge-case-issues/content-reply-test-05.png)
![](/uploads/project/EduMeet/edge-case-issues/content-reply-test-06.png)
![](/uploads/project/EduMeet/edge-case-issues/content-reply-test-07.png)

---

## 2. 다른 게시글의 댓글에 대댓글 등록

### 문제
다른 게시글의 댓글 ID를 부모 댓글로 지정해도 대댓글이 등록됐다.

![](/uploads/project/EduMeet/edge-case-issues/board-reply-reply-register-test.png)

### 해결
대댓글 등록 시, 부모 댓글이 현재 게시글에 속하는지 검증하는 로직을 추가했다.

![](/uploads/project/EduMeet/edge-case-issues/board-reply-reply-register-test-02.png)
![](/uploads/project/EduMeet/edge-case-issues/board-reply-reply-register-test-03.png)

---

## 3. 매우 긴 내용의 댓글 등록 시 예외 타입 불일치

### 문제
댓글 최대 길이 초과 시 `IllegalArgumentException`을 던지도록 구현했는데, 테스트에서 `InvalidDataAccessApiUsageException`이 발생했다.

![](/uploads/project/EduMeet/edge-case-issues/long-content-reply-register-test.png)
![](/uploads/project/EduMeet/edge-case-issues/long-content-reply-register-test-02.png)

### 원인
Spring Data JPA의 Repository 프록시가 `IllegalArgumentException`을 `InvalidDataAccessApiUsageException`으로 자동 변환하고 있었다.

![](/uploads/project/EduMeet/edge-case-issues/long-content-reply-register-test-03.png)

### 해결
테스트 코드의 기대 예외 타입을 `InvalidDataAccessApiUsageException`으로 변경했다.

![](/uploads/project/EduMeet/edge-case-issues/long-content-reply-register-test-04.png)
![](/uploads/project/EduMeet/edge-case-issues/long-content-reply-register-test-05.png)

<!-- EN -->

> Only failed test cases and their resolution processes are documented here; passing tests are omitted.

---

# Posts

## 1. Registering a Post Without a Title

### Normal Behavior
Title is required for post registration. Empty titles should be rejected.

### Problem
A test registering a post without a title succeeded without any exception.

![](/uploads/project/EduMeet/edge-case-issues/title-board-register-edge-test.png)

### Analysis
Considered where to place validation logic.

![](/uploads/project/EduMeet/edge-case-issues/title-board-register-edge-test-02.png)

Following the layered architecture's separation of concerns:
- **Controller**: Request format validation (`@Valid`, type checking)
- **Service**: Business rule validation (domain rules, state verification)
- **Repository**: Pure data access only

Title requirement is a business rule, so Service was the appropriate location.

### Fix
Added title validation logic to the Service.

![](/uploads/project/EduMeet/edge-case-issues/title-board-register-edge-test-03.png)
![](/uploads/project/EduMeet/edge-case-issues/title-board-register-edge-test-04.png)
![](/uploads/project/EduMeet/edge-case-issues/title-board-register-edge-test-05.png)

---

## 2. Like Toggle - Integer Overflow

### Problem
When the like count was at `Integer.MAX_VALUE`, incrementing once more caused an overflow.

![](/uploads/project/EduMeet/edge-case-issues/like-edge-test-processing.png)

### Fix
Added overflow prevention logic to the like increment method.

![](/uploads/project/EduMeet/edge-case-issues/like-edge-test-processing-02.png)

---

## 3. Registering a Post with an Extremely Long Title

### Problem
Attempting to register without a title length limit triggered `DataIntegrityViolationException` from the DB column constraint.

![](/uploads/project/EduMeet/edge-case-issues/long-title-board-register-edge-test.png)

### Fix
Added maximum length validation to the Service's title validation method, throwing an exception before reaching the DB.

![](/uploads/project/EduMeet/edge-case-issues/long-title-board-register-edge-test-02.png)
![](/uploads/project/EduMeet/edge-case-issues/long-title-board-register-edge-test-03.png)

---

## 4. Soft Delete Not Working

### Normal Behavior
Deleting a post should record the deletion time in the `deleted_at` column, and queries should exclude deleted posts with `deleted_at IS NULL`.

### Problem
After deletion, deleted posts were still appearing in queries.

![](/uploads/project/EduMeet/edge-case-issues/logical-delete.png)

### Analysis
Two causes were identified:

**Cause 1**: The query was missing the `deleted_at IS NULL` condition.

![](/uploads/project/EduMeet/edge-case-issues/logical-delete-02.png)

**Cause 2**: The pure domain entity was missing the `deletedAt` field.

![](/uploads/project/EduMeet/edge-case-issues/logical-delete-03.png)

### Fix
1. Added `deletedAt` field to domain entity
2. Added `WHERE deleted_at IS NULL` condition to queries

![](/uploads/project/EduMeet/edge-case-issues/logical-delete-04.png)
![](/uploads/project/EduMeet/edge-case-issues/logical-delete-05.png)
![](/uploads/project/EduMeet/edge-case-issues/logical-delete-06.png)

---

## 5. Category-Filtered Post Query Failure

### Problem
Attempting to query posts by specific category returned all posts regardless of category.

![](/uploads/project/EduMeet/edge-case-issues/category-board-query.png)

### Cause
The QueryDSL WHERE clause was missing the category filter condition.

![](/uploads/project/EduMeet/edge-case-issues/category-board-query-02.png)

### Fix
Added category filter condition to the WHERE clause.

![](/uploads/project/EduMeet/edge-case-issues/category-board-query-03.png)

---

## 6. Like/Dislike Toggle - Only Dislike Broken

### Problem
Instead of UPDATE, new entities were being INSERTed.

![](/uploads/project/EduMeet/edge-case-issues/board-like-dislike.png)
![](/uploads/project/EduMeet/edge-case-issues/board-like-dislike-02.png)
![](/uploads/project/EduMeet/edge-case-issues/board-like-dislike-03.png)
![](/uploads/project/EduMeet/edge-case-issues/board-like-dislike-04.png)

### Fix
Unified like and dislike into a single shared method using identical logic.

![](/uploads/project/EduMeet/edge-case-issues/board-like-dislike-05.png)
![](/uploads/project/EduMeet/edge-case-issues/board-like-dislike-06.png)
![](/uploads/project/EduMeet/edge-case-issues/board-like-dislike-07.png)

---

## 7. NPE When Querying Hierarchical Comments on Empty Post

### Problem
In `PageResponseDTO` constructor, early return when `total <= 0` left all fields uninitialized, causing NPE.

![](/uploads/project/EduMeet/edge-case-issues/empty-hierarchical-reply-query-test.png)

### Fix
Modified to set default values for empty results before returning when `total <= 0`.

![](/uploads/project/EduMeet/edge-case-issues/empty-hierarchical-reply-query-test-02.png)

---

## 8. Post Type Change Not Applied

### Problem
After calling the API to change post type, the type remained unchanged.

![](/uploads/project/EduMeet/edge-case-issues/board-type-change-test.png)
![](/uploads/project/EduMeet/edge-case-issues/board-type-change-test-02.png)

### Cause
The `change()` method only updated title and content, ignoring `boardType`.

![](/uploads/project/EduMeet/edge-case-issues/board-type-change-test-03.png)

### Fix
Added `boardType` update logic to the `change()` method.

![](/uploads/project/EduMeet/edge-case-issues/board-type-change-test-04.png)
![](/uploads/project/EduMeet/edge-case-issues/board-type-change-test-05.png)
![](/uploads/project/EduMeet/edge-case-issues/board-type-change-test-06.png)

---

## 9. Post Registration with Non-Existent Category

### Problem
Posts could be registered with non-existent category IDs.

![](/uploads/project/EduMeet/edge-case-issues/category-board-register-test.png)

### Cause
The Service lacked category existence verification logic.

![](/uploads/project/EduMeet/edge-case-issues/category-board-register-test-02.png)

### Fix
Added category existence check before post registration, throwing an exception if not found.

![](/uploads/project/EduMeet/edge-case-issues/category-board-register-test-03.png)
![](/uploads/project/EduMeet/edge-case-issues/category-board-register-test-04.png)
![](/uploads/project/EduMeet/edge-case-issues/category-board-register-test-05.png)

---

## 10. Invalid Page Number Handling

### Problem
Providing `page=0` or `page=-1` executed the query as-is, producing unpredictable results.

![](/uploads/project/EduMeet/edge-case-issues/valid-page-number-test.png)

### Fix
Added default values and range limits to `PageRequestDTO`.

![](/uploads/project/EduMeet/edge-case-issues/valid-page-number-test-02.png)
![](/uploads/project/EduMeet/edge-case-issues/valid-page-number-test-03.png)
![](/uploads/project/EduMeet/edge-case-issues/valid-page-number-test-04.png)
![](/uploads/project/EduMeet/edge-case-issues/valid-page-number-test-05.png)
![](/uploads/project/EduMeet/edge-case-issues/valid-page-number-test-06.png)
![](/uploads/project/EduMeet/edge-case-issues/valid-page-number-test-07.png)
![](/uploads/project/EduMeet/edge-case-issues/valid-page-number-test-08.png)

---

# Comments

## 1. Registering Empty Comments

### Problem
Comments could be registered with empty strings.

![](/uploads/project/EduMeet/edge-case-issues/content-reply-test.png)
![](/uploads/project/EduMeet/edge-case-issues/content-reply-test-02.png)

### Fix
Added validation for both empty content and maximum length in the Service.

![](/uploads/project/EduMeet/edge-case-issues/content-reply-test-03.png)
![](/uploads/project/EduMeet/edge-case-issues/content-reply-test-04.png)
![](/uploads/project/EduMeet/edge-case-issues/content-reply-test-05.png)
![](/uploads/project/EduMeet/edge-case-issues/content-reply-test-06.png)
![](/uploads/project/EduMeet/edge-case-issues/content-reply-test-07.png)

---

## 2. Replying to Comments from Different Posts

### Problem
Reply comments could be created using parent comment IDs from different posts.

![](/uploads/project/EduMeet/edge-case-issues/board-reply-reply-register-test.png)

### Fix
Added validation to verify the parent comment belongs to the current post during reply registration.

![](/uploads/project/EduMeet/edge-case-issues/board-reply-reply-register-test-02.png)
![](/uploads/project/EduMeet/edge-case-issues/board-reply-reply-register-test-03.png)

---

## 3. Exception Type Mismatch for Long Comment Content

### Problem
Implemented `IllegalArgumentException` for exceeding maximum comment length, but tests received `InvalidDataAccessApiUsageException`.

![](/uploads/project/EduMeet/edge-case-issues/long-content-reply-register-test.png)
![](/uploads/project/EduMeet/edge-case-issues/long-content-reply-register-test-02.png)

### Cause
Spring Data JPA's Repository proxy was automatically converting `IllegalArgumentException` to `InvalidDataAccessApiUsageException`.

![](/uploads/project/EduMeet/edge-case-issues/long-content-reply-register-test-03.png)

### Fix
Changed the expected exception type in the test code to `InvalidDataAccessApiUsageException`.

![](/uploads/project/EduMeet/edge-case-issues/long-content-reply-register-test-04.png)
![](/uploads/project/EduMeet/edge-case-issues/long-content-reply-register-test-05.png)

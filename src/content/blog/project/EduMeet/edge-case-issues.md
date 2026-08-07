---
title: '에지 케이스 테스트에서 발견한 버그들'
description: 에지 케이스 테스트로 발견한 게시글과 댓글 관련 버그 12가지의 원인 분석과 해결 과정을 정리한다.
date: 2025-08-30T00:00:00.000Z
tags:
  - Edge Case
  - Unit Test
  - Bug Fix
  - Validation
  - Spring
  - JPA
category: team/EduMeet
draft: false
coverImage: "/uploads/project/EduMeet/edge-case-issues/title-board-register-edge-test.png"
series: "EduMeet"
---

> 정상 동작하는 테스트 코드는 생략하고, 실패 사례와 그 해결 과정만 정리했습니다.

---

## 왜 에지 케이스 테스트를 이렇게 많이 작성했는가

게시판 CRUD 기능은 3일 만에 구현했습니다. "동작한다"고 생각하고 넘어갈 수 있었지만, **"동작한다"와 "안전하다"는 다르다**는 전제로 에지 케이스를 체계적으로 탐색했습니다.

탐색 기준은 간단했습니다.
- **입력 경계값**: 빈 문자열, 최대 길이 초과, 음수, Integer.MAX_VALUE
- **존재하지 않는 참조**: 없는 카테고리 ID, 다른 게시글의 댓글 ID
- **상태 불일치**: 삭제된 게시글 조회, 타입 변경 미반영

이 12건의 버그는 "검증 로직을 안 넣었다"는 단순한 실수가 아닙니다. 각각이 **어느 레이어에서 검증해야 하는가**(Controller의 형식 검증 vs Service의 비즈니스 규칙 검증)를 결정하는 설계 판단을 포함하고 있습니다.

---

# 게시글

## 1. 제목이 없는 게시글 등록

### 정상 상태
게시글 등록 시 제목은 필수값입니다.
제목이 비어 있으면 등록이 거부되어야 합니다.

### 문제
제목 없이 게시글을 등록하는 테스트를 작성했는데, 예외 없이 정상 등록됐습니다.

![](/uploads/project/EduMeet/edge-case-issues/title-board-register-edge-test.png)

### 분석
검증 로직의 위치를 고민했습니다.

![](/uploads/project/EduMeet/edge-case-issues/title-board-register-edge-test-02.png)

레이어드 아키텍처의 책임 분리 원칙에 따르면:
- **Controller**: 요청 형식 검증 (`@Valid`, 타입 체크)
- **Service**: 비즈니스 규칙 검증 (도메인 규칙, 상태 검증)
- **Repository**: 순수 데이터 접근만

제목 필수 여부는 비즈니스 규칙이므로 Service에 넣는 것이 맞다고 판단했습니다.

### 해결
Service에 제목 검증 로직을 추가했습니다.

![](/uploads/project/EduMeet/edge-case-issues/title-board-register-edge-test-03.png)
![](/uploads/project/EduMeet/edge-case-issues/title-board-register-edge-test-04.png)
![](/uploads/project/EduMeet/edge-case-issues/title-board-register-edge-test-05.png)

---

## 2. 좋아요 토글 - 정수 오버플로우

### 문제
좋아요 수가 `Integer.MAX_VALUE`일 때 한 번 더 증가시키면 오버플로우가 발생했습니다.

![](/uploads/project/EduMeet/edge-case-issues/like-edge-test-processing.png)

### 해결
좋아요 증가 메서드에 오버플로우 방지 로직을 추가했습니다.

![](/uploads/project/EduMeet/edge-case-issues/like-edge-test-processing-02.png)

---

## 3. 매우 긴 제목의 게시글 등록

### 문제
제목 길이 제한 없이 등록을 시도하면, DB 컬럼 제한에 걸려 `DataIntegrityViolationException`이 발생했습니다.

![](/uploads/project/EduMeet/edge-case-issues/long-title-board-register-edge-test.png)

### 해결
Service의 제목 검증 메서드에 최대 길이 체크를 추가해서, DB에 도달하기 전에 예외를 던지도록 했습니다.

![](/uploads/project/EduMeet/edge-case-issues/long-title-board-register-edge-test-02.png)
![](/uploads/project/EduMeet/edge-case-issues/long-title-board-register-edge-test-03.png)

---

## 4. 논리적 삭제(Soft Delete) 기능이 동작하지 않음

### 정상 상태
게시글을 삭제하면 `deleted_at` 컬럼에 삭제 시각이 기록되고, 조회 시 `deleted_at IS NULL` 조건으로 삭제된 게시글이 제외되어야 합니다.

### 문제
삭제 처리를 했는데, 삭제된 게시글이 여전히 조회되고 있었습니다.

![](/uploads/project/EduMeet/edge-case-issues/logical-delete.png)

### 분석
원인이 2가지였습니다.

**원인 1**: 조회 쿼리에 `deleted_at IS NULL` 조건이 빠져 있었습니다.

![](/uploads/project/EduMeet/edge-case-issues/logical-delete-02.png)

**원인 2**: 순수 도메인 엔티티에 `deletedAt` 필드가 없었습니다.

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
특정 카테고리의 게시글만 조회하려 했는데, 카테고리와 무관하게 전체 게시글이 반환됐습니다.

![](/uploads/project/EduMeet/edge-case-issues/category-board-query.png)

### 원인
QueryDSL의 WHERE 절에 카테고리 조건이 빠져 있었습니다.

![](/uploads/project/EduMeet/edge-case-issues/category-board-query-02.png)

### 해결
WHERE 절에 카테고리 필터 조건을 추가했습니다.

![](/uploads/project/EduMeet/edge-case-issues/category-board-query-03.png)

---

## 6. 좋아요/싫어요 토글에서 싫어요만 작동하지 않음

### 문제
UPDATE 문이 실행되지 않고, 새로운 엔티티로 INSERT하고 있었습니다.

![](/uploads/project/EduMeet/edge-case-issues/board-like-dislike.png)
![](/uploads/project/EduMeet/edge-case-issues/board-like-dislike-02.png)
![](/uploads/project/EduMeet/edge-case-issues/board-like-dislike-03.png)
![](/uploads/project/EduMeet/edge-case-issues/board-like-dislike-04.png)

### 해결
좋아요와 싫어요를 하나의 공통 메서드로 통합해서 동일한 로직을 사용하도록 했습니다.

![](/uploads/project/EduMeet/edge-case-issues/board-like-dislike-05.png)
![](/uploads/project/EduMeet/edge-case-issues/board-like-dislike-06.png)
![](/uploads/project/EduMeet/edge-case-issues/board-like-dislike-07.png)

---

## 7. 빈 게시글의 계층형 댓글 목록 조회 시 NPE

### 문제
`PageResponseDTO` 생성자에서 `total <= 0`일 때 early return하면 모든 필드가 초기화되지 않아 NPE가 발생했습니다.

![](/uploads/project/EduMeet/edge-case-issues/empty-hierarchical-reply-query-test.png)

### 해결
`total <= 0`일 때도 빈 결과에 대한 기본값을 설정한 뒤 return하도록 수정했습니다.

![](/uploads/project/EduMeet/edge-case-issues/empty-hierarchical-reply-query-test-02.png)

---

## 8. 게시글 타입 변경이 반영되지 않음

### 문제
게시글 타입을 변경하는 API를 호출했는데, 타입이 바뀌지 않았습니다.

![](/uploads/project/EduMeet/edge-case-issues/board-type-change-test.png)
![](/uploads/project/EduMeet/edge-case-issues/board-type-change-test-02.png)

### 원인
`change()` 메서드가 제목과 내용만 변경하고, `boardType`은 변경하지 않고 있었습니다.

![](/uploads/project/EduMeet/edge-case-issues/board-type-change-test-03.png)

### 해결
`change()` 메서드에 `boardType` 변경 로직을 추가했습니다.

![](/uploads/project/EduMeet/edge-case-issues/board-type-change-test-04.png)
![](/uploads/project/EduMeet/edge-case-issues/board-type-change-test-05.png)
![](/uploads/project/EduMeet/edge-case-issues/board-type-change-test-06.png)

---

## 9. 존재하지 않는 카테고리에 게시글 등록 가능

### 문제
존재하지 않는 카테고리 ID를 넣어도 게시글이 등록됐습니다.

![](/uploads/project/EduMeet/edge-case-issues/category-board-register-test.png)

### 원인
Service에서 카테고리 존재 여부를 검증하는 로직이 없었습니다.

![](/uploads/project/EduMeet/edge-case-issues/category-board-register-test-02.png)

### 해결
게시글 등록 전에 카테고리 존재 여부를 확인하고, 없으면 예외를 던지도록 했습니다.

![](/uploads/project/EduMeet/edge-case-issues/category-board-register-test-03.png)
![](/uploads/project/EduMeet/edge-case-issues/category-board-register-test-04.png)
![](/uploads/project/EduMeet/edge-case-issues/category-board-register-test-05.png)

---

## 10. 유효하지 않은 페이지 번호 처리

### 문제
`page=0`이나 `page=-1`을 넣어도 쿼리가 그대로 실행되어 예측할 수 없는 결과가 나왔습니다.

![](/uploads/project/EduMeet/edge-case-issues/valid-page-number-test.png)

### 해결
`PageRequestDTO`에 기본값과 범위 제한을 추가했습니다.

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
빈 문자열로 댓글을 등록할 수 있었습니다.

![](/uploads/project/EduMeet/edge-case-issues/content-reply-test.png)
![](/uploads/project/EduMeet/edge-case-issues/content-reply-test-02.png)

### 해결
Service에서 빈 내용과 최대 길이를 함께 검증하도록 했습니다.

![](/uploads/project/EduMeet/edge-case-issues/content-reply-test-03.png)
![](/uploads/project/EduMeet/edge-case-issues/content-reply-test-04.png)
![](/uploads/project/EduMeet/edge-case-issues/content-reply-test-05.png)
![](/uploads/project/EduMeet/edge-case-issues/content-reply-test-06.png)
![](/uploads/project/EduMeet/edge-case-issues/content-reply-test-07.png)

---

## 2. 다른 게시글의 댓글에 대댓글 등록

### 문제
다른 게시글의 댓글 ID를 부모 댓글로 지정해도 대댓글이 등록됐습니다.

![](/uploads/project/EduMeet/edge-case-issues/board-reply-reply-register-test.png)

### 해결
대댓글 등록 시, 부모 댓글이 현재 게시글에 속하는지 검증하는 로직을 추가했습니다.

![](/uploads/project/EduMeet/edge-case-issues/board-reply-reply-register-test-02.png)
![](/uploads/project/EduMeet/edge-case-issues/board-reply-reply-register-test-03.png)

---

## 3. 매우 긴 내용의 댓글 등록 시 예외 타입 불일치

### 문제
댓글 최대 길이 초과 시 `IllegalArgumentException`을 던지도록 구현했는데, 테스트에서 `InvalidDataAccessApiUsageException`이 발생했습니다.

![](/uploads/project/EduMeet/edge-case-issues/long-content-reply-register-test.png)
![](/uploads/project/EduMeet/edge-case-issues/long-content-reply-register-test-02.png)

### 원인
Spring Data JPA의 Repository 프록시가 `IllegalArgumentException`을 `InvalidDataAccessApiUsageException`으로 자동 변환하고 있었습니다.

![](/uploads/project/EduMeet/edge-case-issues/long-content-reply-register-test-03.png)

### 해결
테스트 코드의 기대 예외 타입을 `InvalidDataAccessApiUsageException`으로 변경했습니다.

![](/uploads/project/EduMeet/edge-case-issues/long-content-reply-register-test-04.png)
![](/uploads/project/EduMeet/edge-case-issues/long-content-reply-register-test-05.png)

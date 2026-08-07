---
title: '@OneToMany에서 의도하지 않은 중간 테이블이 생성된 문제'
description: JPA @OneToMany의 기본 동작으로 생성된 불필요한 중간 테이블을 mappedBy로 제거한 과정을 정리한다.
date: 2025-07-13T00:00:00.000Z
tags:
  - JPA
  - OneToMany
  - mappedBy
  - Hibernate
  - Entity Mapping
category: team/EduMeet
draft: false
coverImage: "/uploads/project/EduMeet/onetomany-join-table/onetomany-join-table-creation.png"
series: "EduMeet"
---

## 정상 상태

게시글(Board)과 첨부파일(BoardImage)은 1:N 관계입니다.
Board 하나에 여러 개의 BoardImage가 연결되며, 데이터베이스에는 `board` 테이블과 `board_image` 테이블만 존재하고, `board_image` 테이블의 외래키(`board_id`)로 관계를 표현하는 것이 정상입니다.

---

## 문제 상황

Board 엔티티에서 BoardImage에 대한 참조를 `@OneToMany`로 설정하고 프로젝트를 실행했더니, 예상과 다른 테이블이 생성됐습니다.

![](/uploads/project/EduMeet/onetomany-join-table/onetomany-join-table-creation.png)

`board`와 `board_image` 외에 **`board_image_set`이라는 중간 테이블(조인 테이블)이** 추가로 생성된 것입니다.

---

## 원인 분석

[JPA 스펙(JSR 338)](https://jakarta.ee/specifications/persistence/3.1/)과 [Vlad Mihalcea의 분석 글](https://vladmihalcea.com/the-best-way-to-map-a-onetomany-association-with-jpa-and-hibernate/)을 확인해보니, `@OneToMany`의 기본 동작이 원인이었습니다.

`@OneToMany`만 선언하고 `mappedBy`나 `@JoinColumn`을 지정하지 않으면, JPA는 양쪽 엔티티가 독립적인 테이블을 갖고 그 사이를 중간 테이블로 연결하는 전략을 기본으로 사용합니다.
이는 객체 지향 관점에서는 자연스럽지만, 데이터베이스 관점에서는 불필요한 테이블이 생기고 조인 비용이 증가합니다.

중간 테이블을 제거하는 방법은 두 가지입니다.

1. 단방향 `@OneToMany`에 `@JoinColumn`을 추가하는 방법
2. 양방향 매핑에서 `mappedBy` 속성을 사용하는 방법

---

## 해결: mappedBy 적용

2번 방법을 선택했습니다. 이유는 다음과 같습니다.

- 게시물(Board) 관점에서 보면, 첨부파일은 별개의 존재입니다. 단방향 `@OneToMany` + `@JoinColumn`을 사용하면 부모 엔티티가 자식 테이블의 외래키를 관리하게 되는데, 이 경우 INSERT 후 별도의 UPDATE 쿼리가 추가로 발생합니다.
- 첨부파일(BoardImage) 관점에서 보면, 하나의 게시물을 참조하는 `@ManyToOne` 관계가 자연스럽습니다. `mappedBy`를 사용하면 외래키의 주인이 BoardImage 쪽이 되어, INSERT 한 번으로 관계가 설정됩니다.

`mappedBy`는 "이 컬렉션의 매핑 주인은 상대 엔티티의 이 필드다"라고 선언하는 것입니다.
[Baeldung - @JoinColumn vs mappedBy](https://www.baeldung.com/jpa-joincolumn-vs-mappedby)에서도 양방향 `@OneToMany`에서는 `mappedBy` 사용을 권장합니다.

적용 후 프로젝트를 실행하니, 중간 테이블 없이 `board_image` 테이블에 `board_id` 외래키가 생성됐습니다.

![](/uploads/project/EduMeet/onetomany-join-table/onetomany-join-table-creation-02.png)

`@ManyToOne` 구조처럼 외래키 기반의 테이블이 정상적으로 생성된 것을 확인할 수 있습니다.

---

## 정리

| 항목 | mappedBy 적용 전 | mappedBy 적용 후 |
|------|-----------------|-----------------|
| 테이블 수 | 3개 (board, board_image, board_image_set) | 2개 (board, board_image) |
| 관계 표현 | 중간 테이블의 두 외래키 | board_image.board_id 외래키 |
| 조인 비용 | 2번 조인 필요 | 1번 조인으로 충분 |
| 데이터 정합성 | 중간 테이블까지 관리 필요 | 외래키 제약으로 자동 보장 |

1. `@OneToMany`는 `mappedBy`나 `@JoinColumn` 없이 단독 사용하면 기본적으로 중간 테이블을 생성합니다. 이것이 JPA의 기본 전략입니다.
2. `mappedBy`로 연관관계의 주인을 명시하면, 중간 테이블 없이 외래키 기반의 자연스러운 테이블 구조를 만들 수 있습니다.
3. 중간 테이블 제거는 단순히 테이블 수를 줄이는 데 그치지 않고, 조인 연산 복잡도와 데이터 정합성 관리 비용까지 줄여줍니다.

### 왜 이 문제를 일찍 잡는 것이 중요한가

중간 테이블이 생기면 다음과 같은 문제가 따라옵니다.
- 게시글과 이미지를 조회할 때 `board → board_image_set → board_image`로 2번 조인이 필요합니다. 데이터가 늘어나면 쿼리 성능에 직접 영향을 줍니다
- N+1 문제와 결합되면 쿼리 수가 더 폭발적으로 증가합니다 (이후 N+1 해결 과정에서 이 구조를 먼저 정리한 것이 도움이 됐습니다)
- `ddl-auto=update`로 운영하다가 이미 중간 테이블에 데이터가 쌓인 후에 발견하면, 데이터 마이그레이션까지 필요해져 수정 비용이 기하급수적으로 증가합니다

이 경험 이후 JPA 엔티티 매핑 시 `ddl-auto=create`로 테이블을 생성한 뒤, 반드시 ERD와 실제 생성된 DDL을 비교 검증하는 절차를 팀 규칙으로 정했습니다.

JPA 연관관계 매핑은 어노테이션 하나로 끝나지 않고, 도메인 관계의 방향성과 데이터베이스 설계 원칙을 함께 고려해야 합니다.

---

## Reference

- [Vlad Mihalcea - The best way to map a @OneToMany association](https://vladmihalcea.com/the-best-way-to-map-a-onetomany-association-with-jpa-and-hibernate/)
- [Baeldung - @JoinColumn vs mappedBy](https://www.baeldung.com/jpa-joincolumn-vs-mappedby)
- [Thorben Janssen - Best Practices for Many-To-One and One-To-Many Association Mappings](https://thorben-janssen.com/best-practices-many-one-one-many-associations-mappings/)

---
title: '@OneToMany에서 의도하지 않은 중간 테이블이 생성된 문제'
titleEn: 'Unintended Join Table Created by @OneToMany'
description: JPA @OneToMany의 기본 동작으로 생성된 불필요한 중간 테이블을 mappedBy로 제거한 과정을 정리한다.
descriptionEn: Documents how an unnecessary join table created by JPA @OneToMany's default behavior was eliminated using mappedBy.
date: 2025-07-13T00:00:00.000Z
tags:
  - JPA
  - OneToMany
  - mappedBy
  - Hibernate
  - Entity Mapping
category: 프로젝트/EduMeet
draft: false
---

## 정상 상태

게시글(Board)과 첨부파일(BoardImage)은 1:N 관계다. Board 하나에 여러 개의 BoardImage가 연결되며, 데이터베이스에는 `board` 테이블과 `board_image` 테이블만 존재하고, `board_image` 테이블의 외래키(`board_id`)로 관계를 표현하는 것이 정상이다.

---

## 문제 상황

Board 엔티티에서 BoardImage에 대한 참조를 `@OneToMany`로 설정하고 프로젝트를 실행했더니, 예상과 다른 테이블이 생성됐다.

![](/uploads/프로젝트/EduMeet/onetomany-join-table/onetomany-join-table-creation.png)

`board`와 `board_image` 외에 **`board_image_set`이라는 중간 테이블(조인 테이블)**이 추가로 생성된 것이다.

---

## 원인 분석

[JPA 스펙(JSR 338)](https://jakarta.ee/specifications/persistence/3.1/)과 [Vlad Mihalcea의 분석 글](https://vladmihalcea.com/the-best-way-to-map-a-onetomany-association-with-jpa-and-hibernate/)을 확인해보니, `@OneToMany`의 기본 동작이 원인이었다.

`@OneToMany`만 선언하고 `mappedBy`나 `@JoinColumn`을 지정하지 않으면, JPA는 **양쪽 엔티티가 독립적인 테이블을 갖고, 그 사이를 중간 테이블로 연결하는 전략**을 기본으로 사용한다. 이는 객체 지향 관점에서는 자연스럽지만, 데이터베이스 관점에서는 불필요한 테이블이 생기고 조인 비용이 증가한다.

중간 테이블을 제거하는 방법은 두 가지다.

1. 단방향 `@OneToMany`에 `@JoinColumn`을 추가하는 방법
2. 양방향 매핑에서 `mappedBy` 속성을 사용하는 방법

---

## 해결: mappedBy 적용

2번 방법을 선택했다. 이유는 다음과 같다.

- 게시물(Board) 관점에서 보면, 첨부파일은 별개의 존재다. 단방향 `@OneToMany` + `@JoinColumn`을 사용하면 **부모 엔티티가 자식 테이블의 외래키를 관리**하게 되는데, 이 경우 INSERT 후 별도의 UPDATE 쿼리가 추가로 발생한다.
- 첨부파일(BoardImage) 관점에서 보면, 하나의 게시물을 참조하는 `@ManyToOne` 관계가 자연스럽다. `mappedBy`를 사용하면 **외래키의 주인이 BoardImage 쪽**이 되어, INSERT 한 번으로 관계가 설정된다.

`mappedBy`는 "이 컬렉션의 매핑 주인은 상대 엔티티의 이 필드다"라고 선언하는 것이다. [Baeldung - @JoinColumn vs mappedBy](https://www.baeldung.com/jpa-joincolumn-vs-mappedby)에서도 양방향 `@OneToMany`에서는 `mappedBy` 사용을 권장하고 있다.

적용 후 프로젝트를 실행하니, 중간 테이블 없이 `board_image` 테이블에 `board_id` 외래키가 생성되었다.

![](/uploads/프로젝트/EduMeet/onetomany-join-table/onetomany-join-table-creation-02.png)

`@ManyToOne` 구조처럼 외래키 기반의 테이블이 정상적으로 생성된 것을 확인할 수 있다.

---

## 정리

| 항목 | mappedBy 적용 전 | mappedBy 적용 후 |
|------|-----------------|-----------------|
| 테이블 수 | 3개 (board, board_image, board_image_set) | 2개 (board, board_image) |
| 관계 표현 | 중간 테이블의 두 외래키 | board_image.board_id 외래키 |
| 조인 비용 | 2번 조인 필요 | 1번 조인으로 충분 |
| 데이터 정합성 | 중간 테이블까지 관리 필요 | 외래키 제약으로 자동 보장 |

1. `@OneToMany`는 `mappedBy`나 `@JoinColumn` 없이 단독 사용하면 **기본적으로 중간 테이블을 생성**한다. 이것이 JPA의 기본 전략이다.
2. `mappedBy`로 연관관계의 주인을 명시하면, 중간 테이블 없이 **외래키 기반의 자연스러운 테이블 구조**를 만들 수 있다.
3. 중간 테이블 제거는 단순히 테이블 수를 줄이는 것이 아니라, **조인 연산 복잡도와 데이터 정합성 관리 비용을 줄이는 것**이다.

JPA 연관관계 매핑은 어노테이션 하나로 끝나는 게 아니라, 도메인 관계의 방향성과 데이터베이스 설계 원칙을 함께 고려해야 한다.

---

## Reference

- [Vlad Mihalcea - The best way to map a @OneToMany association](https://vladmihalcea.com/the-best-way-to-map-a-onetomany-association-with-jpa-and-hibernate/)
- [Baeldung - @JoinColumn vs mappedBy](https://www.baeldung.com/jpa-joincolumn-vs-mappedby)
- [Thorben Janssen - Best Practices for Many-To-One and One-To-Many Association Mappings](https://thorben-janssen.com/best-practices-many-one-one-many-associations-mappings/)

<!-- EN -->

## Normal Behavior

Board (post) and BoardImage (attachment) have a 1:N relationship. Multiple BoardImages are linked to a single Board, and the database should only contain `board` and `board_image` tables, with the relationship expressed through a foreign key (`board_id`) in the `board_image` table.

---

## The Problem

After setting up the reference from Board to BoardImage with `@OneToMany` and running the project, unexpected tables were created.

![](/uploads/프로젝트/EduMeet/onetomany-join-table/onetomany-join-table-creation.png)

In addition to `board` and `board_image`, a **join table called `board_image_set`** was created.

---

## Root Cause Analysis

After checking the [JPA spec (JSR 338)](https://jakarta.ee/specifications/persistence/3.1/) and [Vlad Mihalcea's analysis](https://vladmihalcea.com/the-best-way-to-map-a-onetomany-association-with-jpa-and-hibernate/), the default behavior of `@OneToMany` turned out to be the cause.

When `@OneToMany` is declared without `mappedBy` or `@JoinColumn`, JPA defaults to a strategy where **both entities have independent tables connected by a join table**. This is natural from an object-oriented perspective, but from a database perspective, it creates unnecessary tables and increases join costs.

There are two ways to eliminate the join table:

1. Adding `@JoinColumn` to a unidirectional `@OneToMany`
2. Using the `mappedBy` attribute in a bidirectional mapping

---

## Solution: Applying mappedBy

Option 2 was chosen for the following reasons:

- From the Board's perspective, attachments are separate entities. Using unidirectional `@OneToMany` + `@JoinColumn` means the **parent entity manages the child table's foreign key**, which generates an additional UPDATE query after INSERT.
- From the BoardImage's perspective, referencing a single post with `@ManyToOne` is natural. Using `mappedBy` makes **BoardImage the owner of the foreign key**, so a single INSERT establishes the relationship.

`mappedBy` declares "the mapping owner of this collection is this field in the other entity." [Baeldung - @JoinColumn vs mappedBy](https://www.baeldung.com/jpa-joincolumn-vs-mappedby) also recommends using `mappedBy` for bidirectional `@OneToMany`.

After applying the fix and running the project, the `board_image` table was created with a `board_id` foreign key without any join table.

![](/uploads/프로젝트/EduMeet/onetomany-join-table/onetomany-join-table-creation-02.png)

The foreign key-based table structure, similar to a `@ManyToOne` setup, was successfully created.

---

## Summary

| Aspect | Before mappedBy | After mappedBy |
|--------|----------------|----------------|
| Table count | 3 (board, board_image, board_image_set) | 2 (board, board_image) |
| Relationship | Two foreign keys in join table | board_image.board_id foreign key |
| Join cost | 2 joins required | 1 join sufficient |
| Data integrity | Join table management needed | Automatically guaranteed by FK constraint |

1. `@OneToMany` used alone without `mappedBy` or `@JoinColumn` **creates a join table by default**. This is JPA's default strategy.
2. Specifying the relationship owner with `mappedBy` creates a **natural foreign key-based table structure** without a join table.
3. Eliminating the join table isn't just about reducing table count — it's about **reducing join operation complexity and data integrity management costs**.

JPA relationship mapping isn't just about a single annotation — it requires considering both the directionality of domain relationships and database design principles.

---

## Reference

- [Vlad Mihalcea - The best way to map a @OneToMany association](https://vladmihalcea.com/the-best-way-to-map-a-onetomany-association-with-jpa-and-hibernate/)
- [Baeldung - @JoinColumn vs mappedBy](https://www.baeldung.com/jpa-joincolumn-vs-mappedby)
- [Thorben Janssen - Best Practices for Many-To-One and One-To-Many Association Mappings](https://thorben-janssen.com/best-practices-many-one-one-many-associations-mappings/)

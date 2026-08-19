---
title: 'EduMeet 개발기: 첫 팀 프로젝트 6주의 기록'
description: >-
  청각장애인을 위한 온라인 교육 플랫폼 EduMeet을 6인 팀으로 6주간 만들며 겪은 것을
  시간순으로 모았습니다. 레이어드 아키텍처 진화, JPA 매핑 실수에서 N+1까지 이어진 흐름,
  S3 업로드 최적화, 단위 테스트 DB를 H2로 옮긴 이유, 그리고 에지 케이스에서 찾아낸
  버그 13가지를 담았습니다.
date: 2025-08-30
tags:
  - EduMeet
  - Team Project
  - Spring Boot
  - JPA
  - QueryDSL
  - MySQL
  - AWS S3
  - Testing
  - Performance
  - Retrospective
category: team/EduMeet
coverImage: /uploads/project/EduMeet/retrospective/title.png
draft: false
series: "EduMeet"
seriesOrder: 1
---

EduMeet은 실시간 음성 자막 변환으로 청각장애인의 학습을 돕는 온라인 교육 플랫폼입니다. 한국수어통역사협회 자료에 따르면 수화 통역사 대비 청각장애인 비율이 1대 300입니다. 온라인 강의에서 자막이 없으면 학습이 사실상 불가능한데, AI 음성인식으로 실시간 자막을 붙이면 이 간극을 크게 줄일 수 있다고 봤습니다.

![EduMeet 아키텍처](/uploads/project/EduMeet/retrospective/architecture.png)

| | |
|---|---|
| **기간** | 2025.07.07 ~ 2025.08.15 (6주) |
| **팀 구성** | 6명 (프론트엔드 3명, 백엔드 3명) |
| **기술 스택** | Java, Spring Boot, JPA, QueryDSL, MySQL, AWS S3, Docker |

백엔드를 맡아 게시판 CRUD API 설계와 구현, S3 이미지 업로드 파이프라인, 127개 단위 테스트 작성, 레이어드 아키텍처 설계를 담당했습니다. 첫 팀 프로젝트라 기능 구현에만 매달릴 줄 알았는데, 실제로는 방어 로직과 테스트 코드에 훨씬 많은 시간을 썼습니다.

만드는 동안의 기록을 편마다 나눠 올렸는데, 흩어져 있으니 앞뒤가 끊겼습니다. 특히 2장부터 4장까지는 하나로 이어진 이야기입니다. `mappedBy`를 빠뜨려 유령 중간테이블이 생겼고, 그걸 없애자 `LazyInitializationException`이 났고, `@EntityGraph`로 고치며 Lazy 로딩의 동작을 파악한 덕에 N+1의 원인을 빨리 짚을 수 있었습니다. 글이 따로 있으면 이 인과가 보이지 않습니다. 그래서 시간순 아홉 장으로 합쳤습니다.

각 장 머리에는 원문 발행일을 남겨 개발 순서를 알 수 있게 했습니다.

---

## 1. 아키텍처 선택과 레이어드 진화

*원문 발행일 2025-07-05*

기획 단계에서 팀원들과 아키텍처를 논의했습니다. 후보는 셋이었습니다. Controller와 Service, DTO, DAO로 나누는 전통적 구조, Presentation과 Application, Domain, Infrastructure로 나누는 레이어드, 그리고 헥사고날입니다.

아키텍처의 정의를 찾아보다가 공통으로 걸리는 문장을 하나 건졌습니다. 아키텍처는 제약 조건을 통해 목적을 달성한다는 것입니다. 해도 되는 일과 하지 말아야 할 일을 미리 정해서, 하지 말아야 할 일이 개발 중에 아예 일어나지 않게 막는 장치라고 이해했습니다. 목적은 결합도를 낮추고 응집도를 높이는 데 있습니다.

| 항목 | 레이어드 | 클린 | 헥사고날 |
|------|----------|--------------|----------|
| 핵심 개념 | 계층 분리 | 의존성은 안쪽으로만 | 포트와 어댑터 |
| 도메인 위치 | 중간 레이어 | 최중심 | 최중심 |
| 복잡도 | 낮음 | 중간에서 높음 | 높음 |
| 학습 비용 | 낮음 | 중간 | 높음 |

클린과 헥사고날이 유연한 건 분명합니다. 다만 우리는 모놀리식이었고, 팀원 대부분이 첫 팀 프로젝트였으며, 6주 안에 기획부터 배포까지 끝내야 했습니다. 도메인 로직이 복잡한 서비스도 아니라 게시판 CRUD가 중심이었습니다. 이 조건에서 포트와 어댑터를 깔면 파일 수만 늘고 팀원마다 이해도가 갈립니다. 레이어드로 갔습니다.

![](/uploads/project/EduMeet/architecture-evolution/layered-hexagonal.png)

레이어드로 정하고 나서도 한 번 더 나눴습니다. 처음에는 Repository 인터페이스와 QueryDSL 구현체가 같은 자리에 있었는데, 구현 세부사항이 도메인 쪽에 섞여 있는 모양이었습니다. 인터페이스는 도메인에 두고 구현체는 Infrastructure로 내리기로 했습니다.

이 결정이 [5장](#5-querydsl-구현체를-옮기다-난-오류)에서 오류로 돌아옵니다. 원칙대로 옮겼더니 프레임워크 규칙과 부딪혔습니다.

---

## 2. @OneToMany가 만든 유령 중간테이블

*원문 발행일 2025-07-13*

### 정상 상태

게시글(Board)과 첨부파일(BoardImage)은 1:N 관계입니다.
Board 하나에 여러 개의 BoardImage가 연결되며, 데이터베이스에는 `board` 테이블과 `board_image` 테이블만 존재하고, `board_image` 테이블의 외래키(`board_id`)로 관계를 표현하는 것이 정상입니다.

---

### 문제 상황

Board 엔티티에서 BoardImage에 대한 참조를 `@OneToMany`로 설정하고 프로젝트를 실행했더니, 예상과 다른 테이블이 생성됐습니다.

![](/uploads/project/EduMeet/onetomany-join-table/onetomany-join-table-creation.png)

`board`와 `board_image` 외에 **`board_image_set`이라는 중간 테이블(조인 테이블)이** 추가로 생성된 것입니다.

---

### 원인 분석

[JPA 스펙(JSR 338)](https://jakarta.ee/specifications/persistence/3.1/)과 [Vlad Mihalcea의 분석 글](https://vladmihalcea.com/the-best-way-to-map-a-onetomany-association-with-jpa-and-hibernate/)을 확인해보니, `@OneToMany`의 기본 동작이 원인이었습니다.

`@OneToMany`만 선언하고 `mappedBy`나 `@JoinColumn`을 지정하지 않으면, JPA는 양쪽 엔티티가 독립적인 테이블을 갖고 그 사이를 중간 테이블로 연결하는 전략을 기본으로 사용합니다.
이는 객체 지향 관점에서는 자연스럽지만, 데이터베이스 관점에서는 불필요한 테이블이 생기고 조인 비용이 증가합니다.

중간 테이블을 제거하는 방법은 두 가지입니다.

1. 단방향 `@OneToMany`에 `@JoinColumn`을 추가하는 방법
2. 양방향 매핑에서 `mappedBy` 속성을 사용하는 방법

---

### 해결: mappedBy 적용

2번 방법을 선택했습니다. 이유는 다음과 같습니다.

- 게시물(Board) 관점에서 보면, 첨부파일은 별개의 존재입니다. 단방향 `@OneToMany` + `@JoinColumn`을 사용하면 부모 엔티티가 자식 테이블의 외래키를 관리하게 되는데, 이 경우 INSERT 후 별도의 UPDATE 쿼리가 추가로 발생합니다.
- 첨부파일(BoardImage) 관점에서 보면, 하나의 게시물을 참조하는 `@ManyToOne` 관계가 자연스럽습니다. `mappedBy`를 사용하면 외래키의 주인이 BoardImage 쪽이 되어, INSERT 한 번으로 관계가 설정됩니다.

`mappedBy`는 "이 컬렉션의 매핑 주인은 상대 엔티티의 이 필드다"라고 선언하는 것입니다.
[Baeldung - @JoinColumn vs mappedBy](https://www.baeldung.com/jpa-joincolumn-vs-mappedby)에서도 양방향 `@OneToMany`에서는 `mappedBy` 사용을 권장합니다.

적용 후 프로젝트를 실행하니, 중간 테이블 없이 `board_image` 테이블에 `board_id` 외래키가 생성됐습니다.

![](/uploads/project/EduMeet/onetomany-join-table/onetomany-join-table-creation-02.png)

`@ManyToOne` 구조처럼 외래키 기반의 테이블이 정상적으로 생성된 것을 확인할 수 있습니다.

---

### 정리

| 항목 | mappedBy 적용 전 | mappedBy 적용 후 |
|------|-----------------|-----------------|
| 테이블 수 | 3개 (board, board_image, board_image_set) | 2개 (board, board_image) |
| 관계 표현 | 중간 테이블의 두 외래키 | board_image.board_id 외래키 |
| 조인 비용 | 2번 조인 필요 | 1번 조인으로 충분 |
| 데이터 정합성 | 중간 테이블까지 관리 필요 | 외래키 제약으로 자동 보장 |

1. `@OneToMany`는 `mappedBy`나 `@JoinColumn` 없이 단독 사용하면 기본적으로 중간 테이블을 생성합니다. 이것이 JPA의 기본 전략입니다.
2. `mappedBy`로 연관관계의 주인을 명시하면, 중간 테이블 없이 외래키 기반의 자연스러운 테이블 구조를 만들 수 있습니다.
3. 중간 테이블 제거는 단순히 테이블 수를 줄이는 데 그치지 않고, 조인 연산 복잡도와 데이터 정합성 관리 비용까지 줄여줍니다.

#### 왜 이 문제를 일찍 잡는 것이 중요한가

중간 테이블이 생기면 다음과 같은 문제가 따라옵니다.
- 게시글과 이미지를 조회할 때 `board → board_image_set → board_image`로 2번 조인이 필요합니다. 데이터가 늘어나면 쿼리 성능에 직접 영향을 줍니다
- N+1 문제와 결합되면 쿼리 수가 더 폭발적으로 증가합니다 (이후 N+1 해결 과정에서 이 구조를 먼저 정리한 것이 도움이 됐습니다)
- `ddl-auto=update`로 운영하다가 이미 중간 테이블에 데이터가 쌓인 후에 발견하면, 데이터 마이그레이션까지 필요해져 수정 비용이 기하급수적으로 증가합니다

이 경험 이후 JPA 엔티티 매핑 시 `ddl-auto=create`로 테이블을 생성한 뒤, 반드시 ERD와 실제 생성된 DDL을 비교 검증하는 절차를 팀 규칙으로 정했습니다.

JPA 연관관계 매핑은 어노테이션 하나로 끝나지 않고, 도메인 관계의 방향성과 데이터베이스 설계 원칙을 함께 고려해야 합니다.

---

### Reference

- [Vlad Mihalcea - The best way to map a @OneToMany association](https://vladmihalcea.com/the-best-way-to-map-a-onetomany-association-with-jpa-and-hibernate/)
- [Baeldung - @JoinColumn vs mappedBy](https://www.baeldung.com/jpa-joincolumn-vs-mappedby)
- [Thorben Janssen - Best Practices for Many-To-One and One-To-Many Association Mappings](https://thorben-janssen.com/best-practices-many-one-one-many-associations-mappings/)

---

## 3. Lazy 로딩에서 터진 No Session

*원문 발행일 2025-07-21*

### 정상 상태

Board(게시글)와 BoardImage(첨부파일)는 `@OneToMany` 관계로 매핑되어 있습니다.
`@OneToMany`의 기본 fetch 전략은 `FetchType.LAZY`로, 게시글을 조회하면 Board 엔티티만 먼저 로딩되고, BoardImage는 실제로 접근하는 시점에 별도 SELECT가 실행되는 구조입니다.

즉, Board 조회 → BoardImage 접근 순서로 **총 2번의 SELECT**가 실행되어야 정상입니다.

---

### 문제 상황

단위 테스트에서 Board를 조회한 뒤 BoardImage에 접근하려 하자, `LazyInitializationException: no session` 오류가 발생했습니다.

![](/uploads/project/EduMeet/lazy-loading-no-session/lazy-no-session-error.png)

실행 결과를 보면 Board까지의 출력은 정상적으로 끝났지만, 그 직후 BoardImage를 SELECT하려는 시점에 DB 세션이 이미 닫혀 있었습니다.

---

### 원인 분석

Lazy 로딩은 **영속성 컨텍스트(Persistence Context)가 살아 있는 동안에만 동작**합니다.
영속성 컨텍스트는 트랜잭션 범위와 생명주기가 같기 때문에, 트랜잭션이 없는 테스트 메서드에서는 첫 번째 SELECT(Board 조회)가 끝나는 즉시 영속성 컨텍스트가 닫힙니다.

이 상태에서 BoardImage에 접근하면, Hibernate가 프록시 객체를 초기화하려고 하지만 이미 세션이 없으므로 `no session` 오류가 발생합니다.

핵심은 **Lazy 로딩 = 프록시 초기화 = 영속성 컨텍스트 필요**라는 점입니다.
테스트 코드에 트랜잭션이 없으면 이 전제가 깨집니다.

---

### 해결 과정

#### 1차 시도: @Transactional 추가

가장 단순한 해결책은 테스트 메서드에 `@Transactional`을 추가하는 것입니다.
이 어노테이션이 적용되면 메서드 전체가 하나의 트랜잭션으로 감싸지므로, 메서드 내에서 추가 쿼리를 여러 번 실행할 수 있습니다.

하지만 이 방법은 **테스트 환경에서만 유효한 우회책**입니다.
실제 서비스 코드에서는 트랜잭션 범위 밖에서 Lazy 엔티티에 접근하는 상황이 동일하게 발생할 수 있습니다.

#### 2차 시도: @EntityGraph 적용

근본적인 해결을 위해 `@EntityGraph`를 적용했습니다.
`@EntityGraph`는 JPA가 제공하는 어노테이션으로, 지정한 연관 엔티티를 **조회 시점에 함께 로딩**(Eager)하도록 선언할 수 있습니다.

![](/uploads/project/EduMeet/lazy-loading-no-session/solutions-entitygraph.png)

`@EntityGraph`의 `attributePaths`에 `imageSet`을 명시하여, Board 조회 시 BoardImage를 한 번에 가져오도록 설정했습니다.

단위 테스트를 다시 실행한 결과:

![](/uploads/project/EduMeet/lazy-loading-no-session/solutions-entitygraph-02.png)

실행 결과의 쿼리를 보면, Board 테이블과 BoardImage 테이블이 **LEFT JOIN으로 한 번에 조회**됐습니다.
별도의 추가 SELECT 없이 게시글과 첨부파일을 동시에 처리할 수 있게 됐습니다.

---

### 정리

| 구분 | @Transactional | @EntityGraph |
|------|---------------|--------------|
| 해결 방식 | 트랜잭션 범위 확장 | 조인으로 한 번에 조회 |
| 쿼리 수 | 2회 (Board + BoardImage) | 1회 (JOIN) |
| 적용 범위 | 테스트 한정 우회 | 서비스 코드에서도 적용 가능 |
| 근본 해결 | 아님 | 맞음 |

#### 왜 @Transactional이 아닌 @EntityGraph인가

`@Transactional`을 테스트에 추가하면 당장은 동작하지만, 두 가지 문제가 있습니다.

1. **서비스 코드의 실제 동작을 검증하지 못함**: 테스트에서 트랜잭션을 열어주면, 서비스 코드가 트랜잭션 없이도 잘 동작하는 것처럼 보이는 **거짓 양성(false positive)**이 발생합니다. 실제 운영 환경에서 Controller → Service 호출 시 트랜잭션 범위 밖에서 Lazy 엔티티에 접근하면 동일한 `no session` 에러가 터집니다.
2. **문제를 숨기는 것이지 해결하는 것이 아님**: 테스트가 통과했다고 해서 코드가 안전한 게 아닙니다. Open Session in View(OSIV) 패턴에 의존하는 것과 같은 맥락입니다.

`@EntityGraph`는 필요한 연관 엔티티를 **쿼리 시점에 명시적으로 선언**하는 방식이라, 어떤 환경에서든 동일하게 동작합니다. 이 경험 이후 프로젝트 전체에서 Lazy 엔티티에 접근하는 모든 Repository 메서드에 로딩 전략을 명시하는 습관이 생겼습니다.

#### 이 문제에서 배운 원칙

`@OneToMany` 구조에서 Lazy 로딩을 유지하면서도, 필요한 시점에 `@EntityGraph`로 Eager 전환을 선언할 수 있다는 점이 핵심입니다. 이후 N+1 문제를 분석할 때도 이 경험이 바탕이 됐습니다. Lazy 로딩의 동작 원리(프록시 초기화 → 영속성 컨텍스트 필요)를 이해하고 있었기 때문에, N+1의 근본 원인을 빠르게 파악할 수 있었습니다.

---

### Reference

- [Hibernate ORM 6.0 Migration Guide - DISTINCT](https://docs.jboss.org/hibernate/orm/6.0/migration-guide/migration-guide.html#query-sqm-distinct)
- [Vlad Mihalcea - The best way to handle the LazyInitializationException](https://vladmihalcea.com/the-best-way-to-handle-the-lazyinitializationexception/)

---

## 4. N+1 문제 분석과 해결

*원문 발행일 2025-07-29*

3장에서 `@EntityGraph`를 붙이며 Lazy 로딩이 언제 쿼리를 쏘는지 알게 됐습니다. 그 이해가 바로 다음 문제에서 쓰였습니다.

게시판은 Board와 BoardImage, Reply 세 테이블을 씁니다. Board 대 BoardImage가 1대 N이고 Board 대 Reply도 1대 N입니다. 더미 데이터 100건을 넣고 페이지 사이즈 10으로 목록을 조회하는 테스트를 짰는데, Hibernate 통계로 보니 JDBC statement가 12개 나가고 있었습니다. 목록 조회 1개, COUNT 1개, 그리고 게시글마다 `board_image`를 따로 읽는 쿼리 10개였습니다.

100건에서 38ms 자체는 문제가 아닙니다. 문제는 구조입니다. 페이지 사이즈를 50으로 올리면 쿼리가 52개가 됩니다. 데이터가 늘어서가 아니라 페이지 사이즈에 비례해 쿼리가 늘어납니다. 여기에 Board가 Tag나 Category를 더 갖게 되면 곱으로 불어납니다.

원인은 프록시였습니다. `@OneToMany(fetch = FetchType.LAZY)`에서 하위 엔티티는 프록시로 대체되고, 실제 필드에 접근하는 순간 Hibernate가 `SELECT`를 날려 초기화합니다. 루프 안에서 접근하니 매 반복마다 쿼리가 나간 것입니다.

`FetchType.EAGER`로 바꾼다고 풀리지 않습니다. JPQL은 엔티티의 fetch 전략을 무시하고 SQL을 그대로 실행하기 때문에, Eager여도 연관 엔티티를 개별 쿼리로 읽는 건 같습니다.

### 네 가지 해법을 놓고 고른 것

`JOIN FETCH`는 한 번의 쿼리로 연관 엔티티를 다 가져옵니다. 다만 `@XToMany` 컬렉션을 Fetch Join한 채로 페이징하면 Hibernate가 전부 메모리에 올린 뒤 애플리케이션에서 자릅니다. 컬렉션을 두 개 이상 동시에 Fetch Join할 수도 없어서 `MultipleBagFetchException`이 납니다. 게시판은 페이징이 필수라 단독으로는 못 씁니다.

`@EntityGraph`는 Fetch Join을 선언적으로 쓰는 방식이라 쿼리 메서드만으로 되지만, 항상 Left Join으로 동작하고 페이징 제약은 똑같이 따라옵니다.

`@Fetch(FetchMode.SUBSELECT)`는 부모를 읽은 뒤 서브쿼리로 자식을 한 번에 가져옵니다. 총 두 개 쿼리로 끝나고 중복도 없습니다.

`@BatchSize`는 연관 엔티티를 지정한 개수만큼 `IN` 절로 묶어 읽습니다. 페이징과 같이 쓸 수 있는 게 결정적이었습니다.

목록 조회에는 `@BatchSize`를 걸었습니다.

| 지표 | Before | After |
|------|--------|-------|
| 페이지 요청 1건당 JDBC statement | 12개 | 4개 |
| 감소율 | | 약 67% |

동시 사용자가 10명이면 N+1에서는 120개 쿼리가 한꺼번에 DB에 들어가지만 BatchSize에서는 40개입니다. 이 차이가 운영에서 RDS 인스턴스 스펙 선정에 직접 영향을 줍니다.

용도에 따라 답이 다릅니다. 페이징이 필요한 목록 조회에는 BatchSize, 단일 게시글 상세 조회에는 EntityGraph, 페이징이 없는 소량 조회에는 FetchJoin이 맞았습니다.

### N+1을 ORM이 알아서 없애주지 않는 이유

N+1은 버그가 아니라 트레이드오프입니다. Lazy 로딩은 필요한 시점에 필요한 데이터만 읽는다는 원칙을 따르고 있고, 목록을 조회한 뒤 연관 엔티티에 접근하는 패턴이 잦아서 문제로 보일 뿐입니다. ORM이 전부 자동으로 최적화하면 반대로 안 쓸 데이터까지 끌고 오게 됩니다. 도구를 여럿 주고 개발자가 고르게 하는 쪽이 맞는 설계라고 봅니다.

---

## 5. QueryDSL 구현체를 옮기다 난 오류

*원문 발행일 2025-08-06*

1장에서 정한 대로 QueryDSL 구현체 `BoardSearchImpl`을 Infrastructure 레이어로 옮겼습니다. 그러자 애플리케이션이 뜨지 않았습니다.

Spring Data JPA가 `BoardJpaRepository`의 `searchAll(...)` 메서드를 자동 구현하려다 실패한 것이었습니다.

Spring Data JPA는 `findBy`나 `countBy` 같은 규약된 접두사와 엔티티 프로퍼티명의 조합으로 쿼리를 만듭니다.

```
findByTitleContaining(String keyword)  → 자동 생성 가능
findAllByTagIn(List<String> tags)      → 자동 생성 가능
searchAll(...)                          → 규약에 없음 → 자동 생성 불가
```

`BoardJpaRepository`가 `BoardSearchRepository`를 extends하고 있었기 때문에, JPA가 상속받은 메서드까지 전부 쿼리 메서드로 해석하려 들었습니다. 원래는 `BoardSearchImpl`이 같은 패키지에 있어서 Custom Repository Implementation으로 인식됐는데, Infrastructure로 옮기면서 그 연결이 끊긴 것입니다.

여기서 아키텍처 원칙과 프레임워크 규칙이 정면으로 부딪혔습니다. 구현체는 Infrastructure에 있어야 한다는 원칙과, 커스텀 구현체는 인터페이스와 같은 위치에서 찾는다는 Spring Data JPA의 규칙입니다.

`@EnableJpaRepositories`의 스캔 범위를 조정해서 양쪽을 만족시켰습니다. 인터페이스는 도메인에 남기고 구현체는 Infrastructure에 두되, Spring이 그 짝을 찾을 수 있게 경로를 알려주는 방식입니다.

프레임워크의 규칙은 대개 이유가 있습니다. 원칙을 지키려면 그 규칙을 우회하는 게 아니라 규칙이 무엇을 전제하는지 먼저 읽어야 한다는 걸 배웠습니다.

---

## 6. S3 이미지 업로드 최적화

*원문 발행일 2025-08-14*

게시판에 이미지를 붙이면서 두 가지를 정해야 했습니다. 업로드된 파일을 무엇으로 식별할 것인가, 그리고 원본을 그대로 저장할 것인가입니다.

### 파일 식별자를 UUID로 둔 이유와 그 대가

파일명은 UUID로 잡았습니다. 사용자가 올린 이름을 그대로 쓰면 충돌하고, 한글이나 특수문자가 섞이면 S3 키에서 문제가 됩니다.

다만 이 UUID를 DB의 PK로도 쓰는 건 다른 이야기입니다. InnoDB는 PK 순서로 클러스터드 인덱스를 만드는데, UUID v4는 완전 랜덤이라 이미 꽉 찬 페이지 중간에 끼어들며 페이지 분할을 일으킵니다. 순차 삽입이 페이지를 94%까지 채우는 반면 랜덤 삽입은 50% 남짓만 채웁니다. 세컨더리 인덱스에도 PK가 포인터로 들어가니 PK가 클수록 인덱스 전체가 부풀어 오릅니다. `VARCHAR(36)`으로 저장하면 BIGINT 대비 4.5배, `BINARY(16)`으로 줄여도 2배입니다.

그래서 파일 식별자는 UUID로 두되, 테이블 PK는 그대로 Auto Increment를 썼습니다. 단일 서버 내부 시스템에서는 그게 가장 단순하고 빠릅니다. 분산 환경으로 간다면 Snowflake ID처럼 시간순으로 증가하면서 충돌하지 않는 방식이 필요했을 겁니다.

### 원본을 그대로 저장하지 않기로 했다

스마트폰으로 찍은 사진은 4032×3024에 5MB 정도입니다. 게시판 목록에 뿌릴 썸네일로는 과합니다. 업로드 시점에 800×600으로 리사이징해서 저장했습니다.

| 지표 | Before | After | 개선율 |
|------|--------|-------|--------|
| 이미지 용량 | 약 5MB (원본) | 약 410KB (리사이징) | 91.8% 감소 |
| 해상도 | 4032×3024 | 800×600 | 목록 표시에 충분 |

상세 페이지에서는 원본을 따로 제공하므로 썸네일 품질이 다른 용도를 해치지 않습니다.

스토리지 비용으로 보면 게시글 100건에 이미지 2장씩 200장 기준으로 원본은 1GB에 월 $0.025, 리사이징본은 80MB에 월 $0.002입니다. 6주 프로젝트 규모에서 절대 금액은 작습니다. 실제로 체감된 건 로딩 속도였습니다. 목록에서 썸네일 10장을 받을 때 50MB가 4.1MB로 줄어드니 전송 시간이 눈에 띄게 짧아졌습니다.

---

## 7. 단위 테스트 DB를 MySQL에서 H2로

*원문 발행일 2025-08-22*

127개 단위 테스트를 MySQL에 붙여 돌리고 있었는데 점점 느려졌습니다. 테스트가 느리면 개발자가 실행을 피하게 되고, 결국 테스트 없이 커밋하는 습관이 붙습니다.

MySQL을 유지하면서 푸는 방법도 봤습니다. 트랜잭션을 매번 롤백하는 방식은 데이터는 깨끗해지지만 쿼리 자체의 디스크 I/O와 네트워크 왕복은 그대로입니다. 별도 테스트 DB를 세우는 방식은 팀원 각자가 로컬에 하나씩 띄워야 하고 CI에도 컨테이너가 하나 더 붙습니다.

단위 테스트는 H2 인메모리로, 통합 테스트는 MySQL로 역할을 나눴습니다. Spring Profile로 분리해서 같은 코드가 프로필에 따라 다른 DB를 보게 했습니다.

| 항목 | MySQL | H2 | 차이 |
|------|-------|-----|------|
| 전체 테스트 수행 시간 | 9.57초 | 5.23초 | 45.34% 단축 |

읽기 위주 테스트에서 차이가 특히 컸습니다. MySQL은 매 쿼리마다 디스크 I/O와 TCP 왕복이 붙지만 H2 인메모리는 JVM 힙에서 바로 처리합니다.

4.34초 차이가 왜 중요하냐면, 절대 시간보다 심리적 임계점 때문입니다. 하루 20~30회 실행하면 누적으로 1.5~2분이고 6주간 3명이면 서너 시간입니다. 그런데 진짜 문제는 그게 아닙니다. 테스트가 10초를 넘으면 개발자가 느리다고 느끼고 다음 코드를 먼저 쓰기 시작하다가 결국 실행 자체를 건너뜁니다. 5.23초는 기다릴 수 있는 시간이고 9.57초는 딴짓을 시작하는 시간입니다.

대신 호환성 리스크를 안고 갑니다. H2는 MySQL과 문법과 타입 처리가 완전히 같지 않아서, H2에서 통과한 쿼리가 MySQL에서 다르게 동작할 수 있습니다. 그래서 실제 쿼리를 검증하는 통합 테스트는 MySQL에 남겨뒀습니다. 빠른 피드백은 H2가, 진짜 검증은 MySQL이 맡는 구조입니다.

---

## 8. 에지 케이스에서 찾아낸 버그 13가지

*원문 발행일 2025-08-30*

> 정상 동작하는 테스트 코드는 생략하고, 실패 사례와 그 해결 과정만 정리했습니다.

---

### 왜 에지 케이스 테스트를 이렇게 많이 작성했는가

게시판 CRUD 기능은 3일 만에 구현했습니다. "동작한다"고 생각하고 넘어갈 수 있었지만, **"동작한다"와 "안전하다"는 다르다**는 전제로 에지 케이스를 체계적으로 탐색했습니다.

탐색 기준은 간단했습니다.
- **입력 경계값**: 빈 문자열, 최대 길이 초과, 음수, Integer.MAX_VALUE
- **존재하지 않는 참조**: 없는 카테고리 ID, 다른 게시글의 댓글 ID
- **상태 불일치**: 삭제된 게시글 조회, 타입 변경 미반영

이 12건의 버그는 "검증 로직을 안 넣었다"는 단순한 실수가 아닙니다. 각각이 **어느 레이어에서 검증해야 하는가**(Controller의 형식 검증 vs Service의 비즈니스 규칙 검증)를 결정하는 설계 판단을 포함하고 있습니다.

---

# 게시글

### 1. 제목이 없는 게시글 등록

게시글 등록 시 제목은 필수값입니다.
제목이 비어 있으면 등록이 거부되어야 합니다.

제목 없이 게시글을 등록하는 테스트를 작성했는데, 예외 없이 정상 등록됐습니다.

![](/uploads/project/EduMeet/edge-case-issues/title-board-register-edge-test.png)

검증 로직의 위치를 고민했습니다.


레이어드 아키텍처의 책임 분리 원칙에 따르면:
- **Controller**: 요청 형식 검증 (`@Valid`, 타입 체크)
- **Service**: 비즈니스 규칙 검증 (도메인 규칙, 상태 검증)
- **Repository**: 순수 데이터 접근만

제목 필수 여부는 비즈니스 규칙이므로 Service에 넣는 것이 맞다고 판단했습니다.

Service에 제목 검증 로직을 추가했습니다.


---

### 2. 좋아요 토글 - 정수 오버플로우

좋아요 수가 `Integer.MAX_VALUE`일 때 한 번 더 증가시키면 오버플로우가 발생했습니다.

![](/uploads/project/EduMeet/edge-case-issues/like-edge-test-processing.png)

좋아요 증가 메서드에 오버플로우 방지 로직을 추가했습니다.


---

### 3. 매우 긴 제목의 게시글 등록

제목 길이 제한 없이 등록을 시도하면, DB 컬럼 제한에 걸려 `DataIntegrityViolationException`이 발생했습니다.

![](/uploads/project/EduMeet/edge-case-issues/long-title-board-register-edge-test.png)

Service의 제목 검증 메서드에 최대 길이 체크를 추가해서, DB에 도달하기 전에 예외를 던지도록 했습니다.


---

### 4. 논리적 삭제(Soft Delete) 기능이 동작하지 않음

게시글을 삭제하면 `deleted_at` 컬럼에 삭제 시각이 기록되고, 조회 시 `deleted_at IS NULL` 조건으로 삭제된 게시글이 제외되어야 합니다.

삭제 처리를 했는데, 삭제된 게시글이 여전히 조회되고 있었습니다.

![](/uploads/project/EduMeet/edge-case-issues/logical-delete.png)

원인이 2가지였습니다.

**원인 1**: 조회 쿼리에 `deleted_at IS NULL` 조건이 빠져 있었습니다.


**원인 2**: 순수 도메인 엔티티에 `deletedAt` 필드가 없었습니다.


1. 도메인 엔티티에 `deletedAt` 필드 추가
2. 조회 쿼리에 `WHERE deleted_at IS NULL` 조건 추가


---

### 5. 카테고리별 게시글 조회 실패

특정 카테고리의 게시글만 조회하려 했는데, 카테고리와 무관하게 전체 게시글이 반환됐습니다.

![](/uploads/project/EduMeet/edge-case-issues/category-board-query.png)

QueryDSL의 WHERE 절에 카테고리 조건이 빠져 있었습니다.


WHERE 절에 카테고리 필터 조건을 추가했습니다.


---

### 6. 좋아요/싫어요 토글에서 싫어요만 작동하지 않음

UPDATE 문이 실행되지 않고, 새로운 엔티티로 INSERT하고 있었습니다.

![](/uploads/project/EduMeet/edge-case-issues/board-like-dislike.png)

좋아요와 싫어요를 하나의 공통 메서드로 통합해서 동일한 로직을 사용하도록 했습니다.


---

### 7. 빈 게시글의 계층형 댓글 목록 조회 시 NPE

`PageResponseDTO` 생성자에서 `total <= 0`일 때 early return하면 모든 필드가 초기화되지 않아 NPE가 발생했습니다.

![](/uploads/project/EduMeet/edge-case-issues/empty-hierarchical-reply-query-test.png)

`total <= 0`일 때도 빈 결과에 대한 기본값을 설정한 뒤 return하도록 수정했습니다.


---

### 8. 게시글 타입 변경이 반영되지 않음

게시글 타입을 변경하는 API를 호출했는데, 타입이 바뀌지 않았습니다.

![](/uploads/project/EduMeet/edge-case-issues/board-type-change-test.png)

`change()` 메서드가 제목과 내용만 변경하고, `boardType`은 변경하지 않고 있었습니다.


`change()` 메서드에 `boardType` 변경 로직을 추가했습니다.


---

### 9. 존재하지 않는 카테고리에 게시글 등록 가능

존재하지 않는 카테고리 ID를 넣어도 게시글이 등록됐습니다.

![](/uploads/project/EduMeet/edge-case-issues/category-board-register-test.png)

Service에서 카테고리 존재 여부를 검증하는 로직이 없었습니다.


게시글 등록 전에 카테고리 존재 여부를 확인하고, 없으면 예외를 던지도록 했습니다.


---

### 10. 유효하지 않은 페이지 번호 처리

`page=0`이나 `page=-1`을 넣어도 쿼리가 그대로 실행되어 예측할 수 없는 결과가 나왔습니다.

![](/uploads/project/EduMeet/edge-case-issues/valid-page-number-test.png)

`PageRequestDTO`에 기본값과 범위 제한을 추가했습니다.


---

# 댓글

### 1. 내용이 없는 댓글 등록 가능

빈 문자열로 댓글을 등록할 수 있었습니다.

![](/uploads/project/EduMeet/edge-case-issues/content-reply-test.png)

Service에서 빈 내용과 최대 길이를 함께 검증하도록 했습니다.


---

### 2. 다른 게시글의 댓글에 대댓글 등록

다른 게시글의 댓글 ID를 부모 댓글로 지정해도 대댓글이 등록됐습니다.

![](/uploads/project/EduMeet/edge-case-issues/board-reply-reply-register-test.png)

대댓글 등록 시, 부모 댓글이 현재 게시글에 속하는지 검증하는 로직을 추가했습니다.


---

### 3. 매우 긴 내용의 댓글 등록 시 예외 타입 불일치

댓글 최대 길이 초과 시 `IllegalArgumentException`을 던지도록 구현했는데, 테스트에서 `InvalidDataAccessApiUsageException`이 발생했습니다.

![](/uploads/project/EduMeet/edge-case-issues/long-content-reply-register-test.png)

Spring Data JPA의 Repository 프록시가 `IllegalArgumentException`을 `InvalidDataAccessApiUsageException`으로 자동 변환하고 있었습니다.


테스트 코드의 기대 예외 타입을 `InvalidDataAccessApiUsageException`으로 변경했습니다.


---
## 9. 6주가 남긴 것

*원문 발행일 2025-08-15*

### 기능보다 방어 로직이 오래 걸린다

게시판 CRUD 기능은 3일 만에 끝났습니다. 그런데 테스트를 쓰면서 비정상 상황을 하나씩 따져보니 방어 로직에 5일이 더 걸렸습니다. 기능이 동작한다와 서비스가 안전하다는 다르다는 걸 여기서 처음 체감했습니다. 8장의 버그 열세 개가 그 5일의 결과입니다.

### 코드 리뷰가 남긴 습관

GitLab MR 기반 코드 리뷰를 도입했습니다. 왜 이렇게 구현했냐는 질문에 답하려면 공식 문서를 확인하고 근거를 정리해야 했습니다. 번거로웠지만 덕분에 모든 코드에 왜 이렇게 했는지를 준비해두는 습관이 생겼습니다. 5장에서 아키텍처 원칙과 프레임워크 규칙이 부딪혔을 때 근거를 대며 결론을 낼 수 있었던 것도 이 습관 덕이었습니다.

### 완성해본 경험

2주차에 기능 목록이 일정 대비 많다는 걸 깨닫고 핵심부터 완성하자고 제안했습니다. 게시판 CRUD, 이미지 업로드, WebRTC 순으로 우선순위를 정하고 매일 작은 단위로 끝냈습니다. 6주 안에 기획부터 배포까지 마무리한 첫 경험이었습니다.

---


---
title: 'QueryDSL 구현체를 Infrastructure 레이어로 이동하면서 발생한 오류'
description: Spring Data JPA의 Custom Repository 구현체를 레이어 이동할 때 발생한 쿼리 메서드 파싱 오류와 해결 과정을 정리한다.
date: 2025-08-06T00:00:00.000Z
tags:
  - Spring Data JPA
  - QueryDSL
  - Layered Architecture
  - Dependency Inversion
  - Repository Pattern
category: team/EduMeet
draft: false
coverImage: "/uploads/project/EduMeet/file-move-error/file-moveerror.png"
series: "EduMeet"
---

## 정상 상태

레이어드 아키텍처에서 인터페이스는 Application 레이어에, 그 구현체는 Infrastructure 레이어에 위치해야 합니다.
이렇게 해야 의존성 역전 원칙(DIP)이 지켜지고, Application 레이어가 특정 기술(QueryDSL, JPA 등)에 직접 의존하지 않는 구조가 됩니다.

---

## 문제 상황

![](/uploads/project/EduMeet/file-move-error/file-moveerror.png)

개발 중에 QueryDSL 기반 검색 기능을 구현하면서, `BoardSearch`(인터페이스)와 `BoardSearchImpl`(구현체)을 모두 Application 레이어에 두고 있었습니다.

이 구조의 문제를 인식하고, 두 가지 작업을 진행했습니다.

**1단계: 이름 정리**

`BoardSearch`와 `BoardSearchImpl`이라는 이름은 역할이 불명확했습니다.
QueryDSL을 사용하는 Repository 구현체인 만큼, 이름을 아래처럼 변경했습니다.

- `BoardSearch` → `BoardSearchRepository`
- `BoardSearchImpl` → `BoardSearchRepositoryImpl`

**2단계: 구현체를 Infrastructure 레이어로 이동**

인터페이스는 Application 레이어에 유지하고, 구현체인 `BoardSearchRepositoryImpl`을 Infrastructure 레이어로 옮겼습니다.

![](/uploads/project/EduMeet/file-move-error/file-moveerror-02.png)
![](/uploads/project/EduMeet/file-move-error/file-moveerror-03.png)
![](/uploads/project/EduMeet/file-move-error/file-moveerror-04.png)
![](/uploads/project/EduMeet/file-move-error/file-moveerror-05.png)
![](/uploads/project/EduMeet/file-move-error/file-moveerror-06.png)

그런데 이동 직후, 애플리케이션이 실행되지 않았습니다.

![](/uploads/project/EduMeet/file-move-error/file-moveerror-07.png)

---

## 원인 분석

오류 메시지를 확인해보니, Spring Data JPA가 `BoardJpaRepository`에서 `searchAll(...)` 메서드를 자동 구현하려다 실패한 것이었습니다.

![](/uploads/project/EduMeet/file-move-error/file-moveerror-08.png)

Spring Data JPA의 쿼리 메서드 자동 생성 규칙을 확인해봤습니다.
[Spring Data JPA 공식 문서](https://docs.spring.io/spring-data/jpa/reference/jpa/query-methods.html)에 따르면, JPA는 `findBy`, `findAllBy`, `countBy`, `deleteBy` 등의 **규약된 접두사**와 엔티티 프로퍼티명의 조합으로 쿼리를 자동 생성합니다.

```
findByTitleContaining(String keyword)  → 자동 생성 가능
findAllByTagIn(List<String> tags)      → 자동 생성 가능
searchAll(...)                          → 규약에 없음 → 자동 생성 불가
```

![](/uploads/project/EduMeet/file-move-error/file-moveerror-09.png)

문제의 근본 원인은 `BoardJpaRepository`가 `BoardSearchRepository` 인터페이스를 **extends**로 확장하고 있었기 때문입니다.
Spring Data JPA는 `BoardJpaRepository`에 선언된 모든 메서드(상속받은 것 포함)를 쿼리 메서드로 해석하려 합니다.
`searchAll`은 JPA 쿼리 메서드 규약에 맞지 않으므로 파싱 실패가 발생한 것입니다.

정리하면:
1. `BoardJpaRepository`가 `BoardSearchRepository`를 extends → JPA가 `searchAll`을 자동 구현하려 시도
2. `searchAll`은 JPA 쿼리 메서드 명명 규칙에 없는 이름 → 파싱 실패
3. 기존에는 `BoardSearchImpl`이 같은 패키지에 있어서 Spring Data JPA가 Custom Repository Implementation으로 인식했지만, Infrastructure 레이어로 이동하면서 이 연결이 끊어진 것

---

## 해결

`BoardSearchRepositoryImpl`을 Infrastructure로 이동했으므로, `BoardJpaRepository`가 `BoardSearchRepository`를 extends할 이유가 없습니다.
각각 독립된 빈으로 관리하는 것이 더 적절합니다.

![](/uploads/project/EduMeet/file-move-error/file-moveerror-10.png)

**1단계**: `BoardJpaRepository`에서 `BoardSearchRepository` extends 제거

![](/uploads/project/EduMeet/file-move-error/file-moveerror-11.png)

**2단계**: `BoardSearchRepositoryImpl`에 `@Repository` 어노테이션 추가

`@Component`로 선언해도 빈 등록은 되지만, `@Repository`를 선택한 이유는 두 가지입니다.
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

결과적으로 `BoardJpaRepository`는 JPA 엔티티 관리만, `BoardSearchRepositoryImpl`은 QueryDSL 기반 복잡 쿼리만 담당하게 되어 **관심사 분리(SRP)**가 달성됐습니다.
인터페이스 기반의 의존성 역전도 유지됩니다.

---

## 번외: AI가 제안한 방법과의 차이

![](/uploads/project/EduMeet/file-move-error/bonus.png)

같은 문제를 AI에게 물어봤을 때, AI는 2가지 방법을 제안했습니다:
1. `BoardSearchRepositoryImpl` 클래스명을 관례에 맞게 변경
2. `@Repository` 스캔 범위를 확장

하지만 제가 선택한 방법은 달랐습니다. extends에서 분리하고 `private final BoardSearchRepository`로 직접 주입하는 방식입니다.

**왜 AI의 제안을 채택하지 않았는가:**
- 방법 1(이름 변경)은 구현체를 다시 같은 패키지에 두는 것을 전제로 합니다. 그러면 Infrastructure 레이어로 분리한 의미가 없어집니다.
- 방법 2(스캔 범위 확장)는 `BoardJpaRepository`가 여전히 `BoardSearchRepository`를 extends하는 구조를 유지합니다. JPA가 `searchAll`을 쿼리 메서드로 해석하려는 근본 문제가 남습니다.
- 제 선택(extends 분리 + 독립 빈)은 각 Repository가 단일 책임을 갖고, 레이어 간 의존성 방향도 지켜지는 구조입니다.

실제로 AI의 방법 1(이름 변경 + 같은 패키지)도 시도해봤습니다. 동작은 했지만, 구현체가 Application 레이어에 다시 돌아가게 되어 레이어 분리를 한 의미가 사라졌습니다. 방법 2(스캔 범위 확장)도 테스트했는데, 빈 등록은 되지만 `BoardJpaRepository`가 여전히 `searchAll`을 쿼리 메서드로 해석하려는 경고가 남았습니다.

AI의 답변은 "Spring Data JPA의 Custom Repository 규칙 안에서 문제를 해결"하는 관점이었고, 제 선택은 "애초에 extends로 묶을 이유가 없다"는 아키텍처 관점이었습니다. 세 가지 모두 동작하지만, 현재 프로젝트의 레이어 구조와 의존성 방향을 고려했을 때 분리가 가장 깔끔했습니다.

---

## Reference

- [Spring Data JPA - Query Methods](https://docs.spring.io/spring-data/jpa/reference/jpa/query-methods.html)
- [Baeldung - Spring Data JPA Custom Repository](https://www.baeldung.com/spring-data-jpa-custom-queries)

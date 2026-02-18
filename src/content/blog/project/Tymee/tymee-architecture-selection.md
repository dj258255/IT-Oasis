---
title: '1인 프로젝트의 아키텍처 선택기'
titleEn: 'Architecture Selection for a Solo Project'
description: 헥사고날 아키텍처를 왜 선택하지 않았는지, 도메인 기반 멀티모듈 + 레이어드 아키텍처로 결정한 이유를 정리한다.
descriptionEn: Explains why hexagonal architecture was not chosen and the decision to use domain-based multi-module + layered architecture.
date: 2025-11-05T00:00:00.000Z
tags:
  - Architecture
  - Layered Architecture
  - Hexagonal Architecture
  - Multi-Module
  - DDD
  - Spring Boot
category: project/Tymee
draft: false
---

> 레이어드 아키텍처를 기본으로, 헥사고날은 왜 고려하지 않았는가

---

## 1. 당연히 레이어드 아키텍처

1인 프로젝트를 시작할 때 아키텍처 선택은 사실 고민할 것도 없었다.

**레이어드 아키텍처**. 단순하고, 익숙하고, 빠르게 개발할 수 있다.

```
Controller -> Service -> Repository -> Database
```

Spring Boot로 개발하는 대부분의 프로젝트가 이 구조를 따른다. 튜토리얼도 이 구조고, 실무에서도 이 구조다. 굳이 다른 걸 선택할 이유가 없었다.

> 출처: [Layered Architecture - Martin Fowler](https://martinfowler.com/bliki/PresentationDomainDataLayering.html)

---

## 2. 그런데 요즘 기술 블로그를 보면...

개발 공부를 하다 보면 **헥사고날 아키텍처** 얘기가 자주 나온다.

카카오뱅크, 카카오페이, 우아한형제들 등 국내 기술 블로그에서 "포트와 어댑터", "클린 아키텍처" 키워드를 심심찮게 볼 수 있다. 그래서 한번 찾아봤다.

### 헥사고날 아키텍처란?

Alistair Cockburn이 제안한 아키텍처로, **포트와 어댑터(Ports and Adapters)** 아키텍처라고도 불린다.
![hexagonal-architecture](/uploads/architecture-selection/hexagonal-architecture.png)



핵심은 **비즈니스 로직을 외부 세계로부터 격리**시키는 것. UI나 Database도 "외부 요소"로 취급한다.

> 출처: [Hexagonal Architecture - Alistair Cockburn](https://alistair.cockburn.us/hexagonal-architecture/)

### 장점은 분명하다

기술 교체가 쉽다. Redis를 PostgreSQL로, REST를 gRPC로 바꿔도 도메인 로직은 그대로다. Port 인터페이스만 Mocking하면 테스트도 간단하다. 카카오뱅크 메시지 허브 팀도 헥사고날로 다양한 서버나 인프라 연결을 쉽게 구성했다고 한다.

> 출처: [유일한 멀티모듈 헥사고날 아키텍처 - 카카오뱅크](https://tech.kakaobank.com/posts/2311-hexagonal-architecture-in-messaging-hub/)

---

## 3. 근데 나한테 필요할까?

결론부터 말하면, **전혀 필요 없다**.

### 파일 수가 2배

로그인 기능 하나 만드는데

```
헥사고날 (10개+ 파일)
├── LoginUseCase.java (port/in)
├── LoginUseCaseImpl.java (usecase)
├── JwtPort.java (port/out)
├── TokenPort.java (port/out)
├── JwtAdapter.java (infrastructure)
├── RedisTokenAdapter.java (infrastructure)
├── AuthController.java (presentation)
├── LoginRequest.java (dto)
├── TokenResponse.java (dto)
├── TokenPair.java (domain)
└── RefreshToken.java (domain)
```

```
레이어드 (5~6개 파일)
├── AuthController.java
├── AuthService.java
├── JwtUtil.java
├── RedisTokenRepository.java
├── TokenPair.java (domain)
└── dto/ (Request, Response)
```

파일 수가 거의 **2배 차이**. 1인 프로젝트에서 이건 치명적이다.

### 카카오페이도 제거했다

카카오페이 홈 서비스팀은 헥사고날을 적용했다가 **제거**했다.

> "이미 연동 인터페이스가 외부 변화를 막아주는 훌륭한 방파제 역할을 하고 있었기 때문에 헥사고날 아키텍처의 핵심인 '도메인 로직 보호'라는 장점이 퇴색될 수밖에 없었습니다."

PR 기준 **8000줄 이상의 코드가 줄어들었다**고 한다.

> 출처: [Hexagonal Architecture, 진짜 하실 건가요? - 카카오페이](https://tech.kakaopay.com/post/home-hexagonal-architecture/)

### 내 상황

헥사고날이 빛나는 건 gRPC + REST + WebSocket을 동시에 지원하거나, 저장소 교체가 잦거나, 대규모 팀이 협업할 때다. 이 프로젝트는 HTTP + WebSocket 정도만 쓰고, 저장소 교체 가능성도 낮고, 1인 개발이다. 오버엔지니어링이 확실하다.

---

## 4. 최종 선택: 도메인 기반 멀티모듈 + 레이어드

### 모듈 구조

```
backend/
├── auth/       # 인증 도메인
├── user/       # 사용자 도메인
├── upload/     # 파일 업로드 도메인
├── core/       # 공통 유틸, 예외 처리
└── bootstrap/  # 앱 실행
```

### 모듈 내부 구조 (기술 기반 패키지)

```
user/
├── controller/       # REST API
├── service/          # 비즈니스 로직
├── repository/       # 데이터 접근
├── entity/           # JPA Entity
├── domain/           # 도메인 모델
│   └── vo/           # Value Objects
└── dto/              # Request, Response
```

### 의존성 방향

![dependency-direction](/uploads/architecture-selection/dependency-direction.png)


단순하다. 레이어드 아키텍처의 기본.

> 출처: [Best practices for multi-module projects with Spring Boot - Bootify](https://bootify.io/multi-module/best-practices-for-spring-boot-multi-module.html)

---

## 5. 그래도 멀티모듈은 유지한 이유

헥사고날은 선택하지 않았지만, **도메인 기반 멀티모듈 구조는 유지**했다.

### 도메인 경계가 명확하다

각 모듈이 하나의 책임을 가진다. auth는 인증만, user는 사용자만.

### 코드 찾기 쉽다

"로그인 버그 수정해주세요" → auth 모듈만 보면 됨.

### 의존성 관리가 쉽다

각 모듈이 필요한 의존성만 가진다. upload 모듈에 Redis 의존성 필요 없음.

### 나중에 분리 가능

서비스가 커지면 특정 모듈만 마이크로서비스로 분리할 수 있다.

> 출처: [멀티모듈 설계 이야기 with Spring, Gradle - 우아한형제들](https://techblog.woowahan.com/2637/)

---

## 6. DDD는 필요한 것만

### 적용한 것

**1. 엔티티(Entity) vs 값 객체(Value Object)**

![entity-vs-value-object](/uploads/architecture-selection/entity-vs-value-object.png)


> 출처: [Entity vs Value Object: the ultimate list of differences - Enterprise Craftsmanship](https://enterprisecraftsmanship.com/posts/entity-vs-value-object-the-ultimate-list-of-differences/)

**2. 도메인 모델에 비즈니스 로직 배치**
![domain-logic-placement](/uploads/architecture-selection/domain-logic-placement.png)


Service에서 모든 로직을 처리하는 게 아니라, 도메인 객체가 자신의 행위를 책임진다.

> 출처: [마틴 파울러 - AnemicDomainModel](https://martinfowler.com/bliki/AnemicDomainModel.html)

**3. 다른 애그리거트는 ID로 참조**
![aggregate-id-reference](/uploads/architecture-selection/aggregate-id-reference.svg)


> 출처: [DDD - 애그리거트, 애그리거트 루트](https://assu10.github.io/dev/2024/04/06/ddd-aggregate/)

### 적용하지 않은 것

- **유비쿼터스 언어** - 1인 프로젝트라 의미 없음
- **Port/Adapter** - 오버엔지니어링
- **CQRS** - 복잡도 증가 대비 이점 적음

---

## 7. 결론

### 아키텍처 스펙트럼

```
[단순 레이어드] ──── [멀티모듈] ──── [헥사고날] ──── [MSA]
                         ↑
                    내가 선택한 지점
```

### 핵심

도메인별 모듈 분리, Entity/VO 구분, 도메인 모델에 로직 배치, ID 참조로 느슨한 결합은 가져갔다. Port/Adapter 인터페이스, UseCase 인터페이스, 과도한 추상화, 유비쿼터스 언어는 버렸다.

1인 프로젝트에서 헥사고날은 오버엔지니어링이다. **레이어드 + 멀티모듈**이면 충분하다. 출시가 먼저고, 리팩토링은 나중이다.

---

## 참고 자료

- [PresentationDomainDataLayering - Martin Fowler](https://martinfowler.com/bliki/PresentationDomainDataLayering.html)
- [Hexagonal Architecture - Alistair Cockburn](https://alistair.cockburn.us/hexagonal-architecture/)
- [유일한 멀티모듈 헥사고날 아키텍처 - 카카오뱅크](https://tech.kakaobank.com/posts/2311-hexagonal-architecture-in-messaging-hub/)
- [Hexagonal Architecture, 진짜 하실 건가요? - 카카오페이](https://tech.kakaopay.com/post/home-hexagonal-architecture/)
- [멀티모듈 설계 이야기 with Spring, Gradle - 우아한형제들](https://techblog.woowahan.com/2637/)
- [Best practices for multi-module projects with Spring Boot - Bootify](https://bootify.io/multi-module/best-practices-for-spring-boot-multi-module.html)
- [Entity vs Value Object - Enterprise Craftsmanship](https://enterprisecraftsmanship.com/posts/entity-vs-value-object-the-ultimate-list-of-differences/)
- [AnemicDomainModel - Martin Fowler](https://martinfowler.com/bliki/AnemicDomainModel.html)
- [DDD - 애그리거트, 애그리거트 루트](https://assu10.github.io/dev/2024/04/06/ddd-aggregate/)

<!-- EN -->

> Layered architecture as the foundation, and why hexagonal was not considered

---

## 1. Layered Architecture, Obviously

When starting a solo project, the architecture choice was a no-brainer.

**Layered architecture**. Simple, familiar, and enables rapid development.

```
Controller -> Service -> Repository -> Database
```

Most projects built with Spring Boot follow this structure. Tutorials use it, and production systems use it. There was no reason to choose anything else.

> Source: [Layered Architecture - Martin Fowler](https://martinfowler.com/bliki/PresentationDomainDataLayering.html)

---

## 2. But Looking at Recent Tech Blogs...

While studying development, **hexagonal architecture** comes up frequently.

Korean tech blogs from companies like KakaoBank, KakaoPay, and Woowa Brothers (Baemin) regularly mention "ports and adapters" and "clean architecture." So I looked into it.

### What Is Hexagonal Architecture?

An architecture proposed by Alistair Cockburn, also known as **Ports and Adapters** architecture.
![hexagonal-architecture](/uploads/architecture-selection/hexagonal-architecture.png)



The core idea is **isolating business logic from the outside world**. Even UI and database are treated as "external elements."

> Source: [Hexagonal Architecture - Alistair Cockburn](https://alistair.cockburn.us/hexagonal-architecture/)

### The Advantages Are Clear

Technology swaps are easy. Switch Redis to PostgreSQL, or REST to gRPC, and the domain logic stays the same. Testing is straightforward too -- just mock the Port interfaces. KakaoBank's messaging hub team reportedly used hexagonal architecture to easily connect to various servers and infrastructure.

> Source: [Hexagonal Architecture in Messaging Hub - KakaoBank](https://tech.kakaobank.com/posts/2311-hexagonal-architecture-in-messaging-hub/)

---

## 3. But Do I Actually Need It?

The short answer: **absolutely not**.

### Twice the Number of Files

Just to build a login feature:

```
Hexagonal (10+ files)
├── LoginUseCase.java (port/in)
├── LoginUseCaseImpl.java (usecase)
├── JwtPort.java (port/out)
├── TokenPort.java (port/out)
├── JwtAdapter.java (infrastructure)
├── RedisTokenAdapter.java (infrastructure)
├── AuthController.java (presentation)
├── LoginRequest.java (dto)
├── TokenResponse.java (dto)
├── TokenPair.java (domain)
└── RefreshToken.java (domain)
```

```
Layered (5-6 files)
├── AuthController.java
├── AuthService.java
├── JwtUtil.java
├── RedisTokenRepository.java
├── TokenPair.java (domain)
└── dto/ (Request, Response)
```

The file count is nearly **double**. For a solo project, this is critical.

### Even KakaoPay Removed It

KakaoPay's Home Service team adopted hexagonal architecture and then **removed it**.

> "The integration interfaces were already serving as excellent barriers against external changes, so the core benefit of hexagonal architecture -- 'protecting domain logic' -- was inevitably diminished."

They reported that **over 8,000 lines of code were reduced** in the PR.

> Source: [Hexagonal Architecture, Are You Really Going to Do It? - KakaoPay](https://tech.kakaopay.com/post/home-hexagonal-architecture/)

### My Situation

Hexagonal shines when you need to support gRPC + REST + WebSocket simultaneously, when storage swaps are frequent, or when large teams are collaborating. This project only uses HTTP + WebSocket, storage changes are unlikely, and it is a solo effort. It is clearly over-engineering.

---

## 4. Final Choice: Domain-Based Multi-Module + Layered

### Module Structure

```
backend/
├── auth/       # Authentication domain
├── user/       # User domain
├── upload/     # File upload domain
├── core/       # Shared utilities, exception handling
└── bootstrap/  # App execution
```

### Internal Module Structure (Technology-Based Packages)

```
user/
├── controller/       # REST API
├── service/          # Business logic
├── repository/       # Data access
├── entity/           # JPA Entity
├── domain/           # Domain model
│   └── vo/           # Value Objects
└── dto/              # Request, Response
```

### Dependency Direction

![dependency-direction](/uploads/architecture-selection/dependency-direction.png)


Simple. The basics of layered architecture.

> Source: [Best practices for multi-module projects with Spring Boot - Bootify](https://bootify.io/multi-module/best-practices-for-spring-boot-multi-module.html)

---

## 5. Why Multi-Module Was Still Kept

I did not choose hexagonal, but I kept the **domain-based multi-module structure**.

### Clear Domain Boundaries

Each module has a single responsibility. auth handles only authentication, user handles only users.

### Easy to Find Code

"Please fix the login bug" -> Just look at the auth module.

### Easy Dependency Management

Each module only has the dependencies it needs. The upload module does not need a Redis dependency.

### Future Separation Possible

If the service grows, specific modules can be extracted into microservices.

> Source: [Multi-Module Design Story with Spring, Gradle - Woowa Brothers](https://techblog.woowahan.com/2637/)

---

## 6. DDD -- Only What's Needed

### What Was Applied

**1. Entity vs Value Object**

![entity-vs-value-object](/uploads/architecture-selection/entity-vs-value-object.png)


> Source: [Entity vs Value Object: the ultimate list of differences - Enterprise Craftsmanship](https://enterprisecraftsmanship.com/posts/entity-vs-value-object-the-ultimate-list-of-differences/)

**2. Placing Business Logic in Domain Models**
![domain-logic-placement](/uploads/architecture-selection/domain-logic-placement.png)


Instead of handling all logic in the Service, domain objects take responsibility for their own behavior.

> Source: [Martin Fowler - AnemicDomainModel](https://martinfowler.com/bliki/AnemicDomainModel.html)

**3. Referencing Other Aggregates by ID**
![aggregate-id-reference](/uploads/architecture-selection/aggregate-id-reference.svg)


> Source: [DDD - Aggregates and Aggregate Roots](https://assu10.github.io/dev/2024/04/06/ddd-aggregate/)

### What Was Not Applied

- **Ubiquitous Language** - Meaningless for a solo project
- **Port/Adapter** - Over-engineering
- **CQRS** - Benefits do not justify the added complexity

---

## 7. Conclusion

### Architecture Spectrum

```
[Simple Layered] ──── [Multi-Module] ──── [Hexagonal] ──── [MSA]
                           ↑
                    Where I landed
```

### Key Takeaways

What I kept: domain-based module separation, Entity/VO distinction, business logic in domain models, and loose coupling through ID references. What I discarded: Port/Adapter interfaces, UseCase interfaces, excessive abstraction, and ubiquitous language.

Hexagonal is over-engineering for a solo project. **Layered + multi-module** is sufficient. Ship first, refactor later.

---

## References

- [PresentationDomainDataLayering - Martin Fowler](https://martinfowler.com/bliki/PresentationDomainDataLayering.html)
- [Hexagonal Architecture - Alistair Cockburn](https://alistair.cockburn.us/hexagonal-architecture/)
- [Hexagonal Architecture in Messaging Hub - KakaoBank](https://tech.kakaobank.com/posts/2311-hexagonal-architecture-in-messaging-hub/)
- [Hexagonal Architecture, Are You Really Going to Do It? - KakaoPay](https://tech.kakaopay.com/post/home-hexagonal-architecture/)
- [Multi-Module Design Story with Spring, Gradle - Woowa Brothers](https://techblog.woowahan.com/2637/)
- [Best practices for multi-module projects with Spring Boot - Bootify](https://bootify.io/multi-module/best-practices-for-spring-boot-multi-module.html)
- [Entity vs Value Object - Enterprise Craftsmanship](https://enterprisecraftsmanship.com/posts/entity-vs-value-object-the-ultimate-list-of-differences/)
- [AnemicDomainModel - Martin Fowler](https://martinfowler.com/bliki/AnemicDomainModel.html)
- [DDD - Aggregates and Aggregate Roots](https://assu10.github.io/dev/2024/04/06/ddd-aggregate/)

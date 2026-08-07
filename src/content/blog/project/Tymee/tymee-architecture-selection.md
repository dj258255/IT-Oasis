---
title: '1인 프로젝트의 아키텍처 선택기'
description: 헥사고날 아키텍처를 왜 선택하지 않았는지, 도메인 기반 멀티모듈 + 레이어드 아키텍처로 결정한 이유를 정리한다.
date: 2025-11-05T00:00:00.000Z
tags:
  - Architecture
  - Layered Architecture
  - Hexagonal Architecture
  - Multi-Module
  - DDD
  - Spring Boot
category: personal/Tymee
draft: false
coverImage: "/uploads/architecture-selection/hexagonal-architecture.png"
series: "Tymee"
---

> 레이어드 아키텍처를 기본으로, 헥사고날은 왜 고려하지 않았는가

---

## 1. 당연히 레이어드 아키텍처

1인 프로젝트를 시작할 때 아키텍처 선택은 사실 고민할 것도 없었습니다.

**레이어드 아키텍처**. 단순하고, 익숙하고, 빠르게 개발할 수 있습니다.

```
Controller -> Service -> Repository -> Database
```

Spring Boot로 개발하는 대부분의 프로젝트가 이 구조를 따릅니다.
튜토리얼도 이 구조고, 실무에서도 이 구조입니다. 굳이 다른 걸 선택할 이유가 없었습니다.

> 출처: [Layered Architecture - Martin Fowler](https://martinfowler.com/bliki/PresentationDomainDataLayering.html)

---

## 2. 그런데 요즘 기술 블로그를 보면...

개발 공부를 하다 보면 **헥사고날 아키텍처** 얘기가 자주 나옵니다.

카카오뱅크, 카카오페이, 우아한형제들 등 국내 기술 블로그에서 "포트와 어댑터", "클린 아키텍처" 키워드를 심심찮게 볼 수 있습니다. 그래서 한번 찾아봤습니다.

### 헥사고날 아키텍처란?

Alistair Cockburn이 제안한 아키텍처로, **포트와 어댑터(Ports and Adapters)** 아키텍처라고도 불립니다.
![hexagonal-architecture](/uploads/architecture-selection/hexagonal-architecture.png)



핵심은 **비즈니스 로직을 외부 세계로부터 격리**하는 것입니다. UI나 Database도 "외부 요소"로 취급합니다.

> 출처: [Hexagonal Architecture - Alistair Cockburn](https://alistair.cockburn.us/hexagonal-architecture/)

### 장점은 분명합니다

기술 교체가 쉽습니다. Redis를 PostgreSQL로, REST를 gRPC로 바꿔도 도메인 로직은 그대로입니다.
Port 인터페이스만 Mocking하면 테스트도 간단합니다.
카카오뱅크 메시지 허브 팀도 헥사고날로 다양한 서버나 인프라 연결을 쉽게 구성했다고 합니다.

> 출처: [유일한 멀티모듈 헥사고날 아키텍처 - 카카오뱅크](https://tech.kakaobank.com/posts/2311-hexagonal-architecture-in-messaging-hub/)

---

## 3. 근데 나한테 필요할까?

결론부터 말하면, **전혀 필요 없습니다**.

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

파일 수가 거의 **2배 차이**. 1인 프로젝트에서 이건 치명적입니다.

### 카카오페이도 제거했습니다

카카오페이 홈 서비스팀은 헥사고날을 적용했다가 **제거**했습니다.

> "이미 연동 인터페이스가 외부 변화를 막아주는 훌륭한 방파제 역할을 하고 있었기 때문에 헥사고날 아키텍처의 핵심인 '도메인 로직 보호'라는 장점이 퇴색될 수밖에 없었습니다."

PR 기준 **8000줄 이상의 코드가 줄어들었다**고 합니다.

> 출처: [Hexagonal Architecture, 진짜 하실 건가요? - 카카오페이](https://tech.kakaopay.com/post/home-hexagonal-architecture/)

### 내 상황

헥사고날이 빛나는 건 gRPC + REST + WebSocket을 동시에 지원하거나, 저장소 교체가 잦거나, 대규모 팀이 협업할 때입니다.
이 프로젝트는 HTTP + WebSocket 정도만 쓰고, 저장소 교체 가능성도 낮고, 1인 개발입니다.
오버엔지니어링이 확실합니다.

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


단순합니다. 레이어드 아키텍처의 기본입니다.

> 출처: [Best practices for multi-module projects with Spring Boot - Bootify](https://bootify.io/multi-module/best-practices-for-spring-boot-multi-module.html)

---

## 5. 그래도 멀티모듈은 유지한 이유

헥사고날은 선택하지 않았지만, **도메인 기반 멀티모듈 구조는 유지**했습니다.

### 도메인 경계가 명확합니다

각 모듈이 하나의 책임을 가집니다. auth는 인증만, user는 사용자만.

### 코드 찾기 쉽습니다

"로그인 버그 수정해주세요" → auth 모듈만 보면 됨.

### 의존성 관리가 쉽습니다

각 모듈이 필요한 의존성만 가집니다. upload 모듈에 Redis 의존성 필요 없음.

### 나중에 분리 가능

서비스가 커지면 특정 모듈만 마이크로서비스로 분리할 수 있습니다.

> 출처: [멀티모듈 설계 이야기 with Spring, Gradle - 우아한형제들](https://techblog.woowahan.com/2637/)

---

## 6. DDD는 필요한 것만

### 적용한 것

**1. 엔티티(Entity) vs 값 객체(Value Object)**

![entity-vs-value-object](/uploads/architecture-selection/entity-vs-value-object.png)


> 출처: [Entity vs Value Object: the ultimate list of differences - Enterprise Craftsmanship](https://enterprisecraftsmanship.com/posts/entity-vs-value-object-the-ultimate-list-of-differences/)

**2. 도메인 모델에 비즈니스 로직 배치**
![domain-logic-placement](/uploads/architecture-selection/domain-logic-placement.png)


Service에서 모든 로직을 처리하지 않고, 도메인 객체가 자신의 행위를 책임집니다.

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

도메인별 모듈 분리, Entity/VO 구분, 도메인 모델에 로직 배치, ID 참조로 느슨한 결합은 가져갔습니다.
Port/Adapter 인터페이스, UseCase 인터페이스, 과도한 추상화, 유비쿼터스 언어는 버렸습니다.

1인 프로젝트에서 헥사고날은 오버엔지니어링입니다. **레이어드 + 멀티모듈**이면 충분합니다.
출시가 먼저고, 리팩토링은 나중입니다.

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

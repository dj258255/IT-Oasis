---
title: '아키텍처 선택과 레이어드 아키텍처 진화'
titleEn: 'Architecture Selection and Layered Architecture Evolution'
description: 레이어드 아키텍처를 선택한 이유와 의존성 역전으로 헥사고날 아키텍처까지 진화시키는 과정을 정리한다.
descriptionEn: Explains why layered architecture was chosen and how it evolves into hexagonal architecture through dependency inversion.
date: 2025-07-05T00:00:00.000Z
tags:
  - Architecture
  - Layered Architecture
  - Hexagonal Architecture
  - Dependency Inversion
  - Clean Architecture
  - Spring
category: 프로젝트/EduMeet
draft: false
---

> 프로젝트 기획 단계에서 팀원들과 아키텍처를 논의하며 정리한 내용

---

## 1. 아키텍처란?

팀원들과 아키텍처를 논의하면서 여러 선택지가 나왔다:
1. Controller - Service - DTO - DAO (전통적 MVC)
2. Presentation - Application - Domain - Infrastructure (레이어드)
3. 헥사고날 아키텍처

아키텍처에 대한 정확한 정의를 찾기 어려웠지만, 공통적으로 언급되는 핵심이 있었다:

> **"아키텍처는 제약 조건을 통해 목적을 달성한다."**

**내가 내린 정의:**
- 아키텍처는 "해도 되는 것"과 "하지 말아야 하는 것"을 결정
- 해서는 안 되는 일이 개발 단계에서 일어나지 않도록 원천 차단
- 궁극적 목적: **결합도를 낮추고 응집도를 높이는 것**

---

## 2. 왜 레이어드 아키텍처를 선택했나?

### 아키텍처 비교: 레이어드 vs 클린 vs 헥사고날

| 항목 | 레이어드 | 클린 아키텍처 | 헥사고날 |
|------|----------|--------------|----------|
| **핵심 개념** | 계층 분리 | 의존성 규칙 (안쪽으로만) | 포트-어댑터 |
| **의존 방향** | 위 → 아래 | 바깥 → 안쪽 (동심원) | 외부 → 내부 |
| **도메인 위치** | 중간 레이어 | **최중심** | **최중심** |
| **복잡도** | 낮음 | 중간~높음 | 높음 |
| **학습 비용** | 낮음 | 중간 | 높음 |
| **유연성** | 중간 | 높음 | 매우 높음 |

**클린 아키텍처란?**

로버트 C. 마틴(엉클 밥)이 제안한 아키텍처로, 핵심 원칙은 **"의존성은 안쪽으로만 향한다"**:

```
[Frameworks & Drivers] → [Interface Adapters] → [Use Cases] → [Entities]
        (외부)                                                    (중심)
```

- Entities: 핵심 비즈니스 규칙 (도메인)
- Use Cases: 애플리케이션 비즈니스 규칙
- Interface Adapters: Controller, Presenter, Gateway
- Frameworks & Drivers: DB, Web, UI 등 외부 세부사항

### 왜 클린/헥사고날 대신 레이어드를 선택했나?

| 고려 사항 | 판단 | 이유 |
|----------|------|------|
| MSA 구조인가? | 아니다 | 모놀리식에서 헥사고날은 오버헤드 |
| 도메인 복잡도 | 높지 않다 | 클린 아키텍처의 계층 분리가 과함 |
| 개발 기간 | 6주 (촉박) | 학습 + 구현 시간 부족 |
| 팀 역량 | 레이어드 익숙 | 새 아키텍처 학습 비용 |
| 외부 시스템 연동 | 적음 | 포트-어댑터 패턴 필요성 낮음 |

**결론:** 클린/헥사고날은 **도메인 복잡도가 높거나**, **외부 시스템 연동이 많거나**, **장기 유지보수**가 필요할 때 빛을 발한다. 6주 프로젝트에서는 레이어드로 충분하고, 필요시 의존성 역전을 부분 적용하는 전략을 선택했다.

### 전통적 MVC vs 레이어드

**Presentation - Application - Domain - Infrastructure 구조를 선택한 이유:**

| 장점 | 설명 |
|------|------|
| 역할/책임 명확 | 각 레이어가 단일 책임을 가짐 |
| 관심사 분리 | UI, 비즈니스 로직, 도메인, 인프라 분리 |
| 테스트 용이 | 레이어별 단위 테스트 작성 가능 |
| 변경/확장 용이 | 한 레이어 변경이 다른 레이어에 영향 최소화 |

**레이어드 아키텍처의 핵심 규칙:**
1. 레이어 구조 사용
2. **레이어 간 의존 방향은 단방향** (양방향이면 레이어의 의미 상실)

---

## 3. 개발 접근법: 무엇부터 만들까?

레이어드 아키텍처에서 개발 순서는 크게 두 가지로 나뉜다:
- **하향식(Top-Down)**: Presentation → Application → Domain → Infrastructure
- **상향식(Bottom-Up)**: Infrastructure → Domain → Application → Presentation

### 접근법 1: JPA 엔티티부터 (상향식, DB 중심)

![JPA 엔티티 우선 접근](/uploads/프로젝트/EduMeet/architecture-evolution/approach-1-jpa-entity-db.png)

Infrastructure(DB)부터 시작하는 상향식 접근. JPA 엔티티부터 만든다는 건 DDL(테이블)을 먼저 설계하겠다는 것과 같다.

**문제점:**
- DDL이 만들어지기 전까지 다른 개발자가 대기해야 함
- 업무 병렬 처리 불가
- **DB에 종속된 개발** → 요구사항에 맞는 DB 선정이 아닌, DB에 맞는 기능 개발

### 접근법 2: API 엔드포인트부터 (하향식, 프레임워크 중심)

![API 엔드포인트 우선 접근](/uploads/프로젝트/EduMeet/architecture-evolution/approach-2-api.png)

Presentation(Controller)부터 시작하는 하향식 접근. RequestBody/ResponseEntity를 먼저 고민하는 방식.

**문제점:**
- 도메인 분석 전에 기술 스펙(Spring Web, JPA, JWT 등)을 먼저 결정
- **프레임워크에 종속된 개발**
- 웹소켓, gRPC, 메시지 큐 등 다른 선택지를 배제

> **"스프링 API 서버 개발자가 아니라 백엔드 개발자다"**

### 올바른 접근: 도메인부터 (도메인 중심)

```
1. 도메인 개발
2. 애플리케이션 서비스 개발
3. 서비스가 사용할 인터페이스 구성
4. 컨트롤러, JPA 등 구현체 작성
```

**핵심:**
- "이 프로젝트는 스프링과 JPA를 사용하네" (X)
- "이 프로젝트는 이런 도메인을 다루고 있네" (O)

---

## 4. 의존성 역전으로 레이어드 진화시키기

### 기존 구조의 문제

![JPA 강결합 구조](/uploads/프로젝트/EduMeet/architecture-evolution/before-problem.png)

**Service가 JpaRepository에 직접 의존하면:**
- 10년 뒤 JPA를 대체하는 기술이 나와도 교체 불가
- "JPA 버전 X.X.X에 강결합되어 변경 불가능"

### 해결: 의존성 역전 적용

![의존성 역전 적용](/uploads/프로젝트/EduMeet/architecture-evolution/solution-dependency-inversion-applied.png)

**Application과 Infrastructure 사이에 인터페이스 도입:**

```
Before: Service → JpaRepository (직접 의존)
After:  Service → Repository (인터페이스) ← JpaRepositoryImpl
```

**효과:**
- Service가 JPA에 의존하지 않음
- Repository 구현체를 자유롭게 교체 가능 (JPA → MyBatis, MongoDB 등)
- RDB가 아닌 NoSQL도 선택 가능

### Presentation에도 의존성 역전 적용

![Presentation 의존성 역전](/uploads/프로젝트/EduMeet/architecture-evolution/presentation-dependency-inversion-applied.png)

**긍정적 측면:**
- Presentation 컴포넌트 테스트 용이
- 외부/내부 모든 경계에 일관된 패턴 적용
- 경계 강제 가능

**부정적 측면:**
- 실효성이 모호할 수 있음
- Application → Presentation 의존이 부자연스럽다는 의견
- 의존성 역전 없이도 도메인은 이미 독립적이라는 반론

---

## 5. 레이어드 → 헥사고날: 본질은 같다

![헥사고날 비교](/uploads/프로젝트/EduMeet/architecture-evolution/layered-hexagonal.png)

의존성 역전을 적용한 레이어드 아키텍처는 **헥사고날 아키텍처와 본질적으로 동일**하다.

**깨달은 점:**
- 헥사고날의 "포트-어댑터 패턴" = 의존성 역전의 다른 이름
- 아키텍처는 암기가 아니라 **원리의 이해**
- 레이어드를 진화시키면 자연스럽게 헥사고날이 됨

> **"spring-web과의 결합이 끊어진 것이지, Spring Framework와 결합이 끊어진 건 아니다. @Service, @Repository 같은 애너테이션은 여전히 사용한다. Spring의 핵심 가치는 IoC 컨테이너와 DI 지원이기 때문이다."**

---

## 6. 도메인 모델과 영속성 객체: 분리할까?

### 분리하지 않는다

| 장점 | 단점 |
|------|------|
| from(), toModel() 같은 변환 메서드 불필요 | 클래스 책임이 불명확 |
| 개발 속도 빠름 | DB 위주 사고 유발 |
| ORM의 본래 목적에 충실 | 도메인 커질수록 관리 어려움 |

### 분리한다

| 장점 | 단점 |
|------|------|
| 도메인과 영속성 라이브러리 분리 | 작성 코드량 증가 |
| SRP(단일 책임 원칙) 준수 | ORM 혜택 활용 어려움 |
| DB 라이브러리 교체 용이 | 변환 로직 필요 |

**핵심 원칙:**
- 도메인 로직(change, validate 등)은 **Domain 클래스**에
- 영속성 객체(JpaEntity)에는 **데이터 영속화 관련 코드만**
- 도메인 레이어는 **순수 자바 코드**로 작성 (@Entity, @Service 등 외부 의존 X)

---

## 7. 결론

### 핵심 정리

1. **아키텍처의 본질**
   - 제약 조건으로 결합도를 낮추고 응집도를 높임
   - 정답 없음, 트레이드오프의 영역

2. **개발 순서**
   ```
   도메인 → 애플리케이션 서비스 → 인터페이스 → 구현체
   ```
   - JPA나 API 엔드포인트부터 시작하면 특정 기술에 종속

3. **의존성 역전**
   - 도메인 중심 레이어드 아키텍처 구성
   - 기술 스택 변경에 유연하게 대응
   - 결과적으로 헥사고날 아키텍처와 동일한 구조

### 의사결정 프로세스

```
1. 문제 발생
2. 선택 가능한 방법 나열
3. 각각 장단점 비교 (트레이드오프 분석)
4. 상황에 맞는 선택
```

> **"소프트웨어 개발의 모든 의사결정은 트레이드오프 싸움이다."**

---

## Reference

- [자바/스프링 개발자를 위한 실용주의 프로그래밍](https://product.kyobobook.co.kr/detail/S000213447953) - 김우근 저
- [클린 아키텍처: 소프트웨어 구조와 설계의 원칙](https://product.kyobobook.co.kr/detail/S000001033082) - 로버트 C. 마틴 저
- [API-First Design | Swagger](https://swagger.io/resources/articles/adopting-an-api-first-approach) - API 우선 설계 방법론

<!-- EN -->

> Notes from discussing architecture with the team during the project planning phase

---

## 1. What is Architecture?

While discussing architecture with the team, several options came up:
1. Controller - Service - DTO - DAO (Traditional MVC)
2. Presentation - Application - Domain - Infrastructure (Layered)
3. Hexagonal Architecture

Although a precise definition of architecture was hard to pin down, there was a common thread:

> **"Architecture achieves its goals through constraints."**

**My definition:**
- Architecture determines what is allowed and what is not
- It prevents things that shouldn't happen from occurring during development
- Ultimate goal: **reduce coupling and increase cohesion**

---

## 2. Why Layered Architecture?

### Comparison: Layered vs Clean vs Hexagonal

| Aspect | Layered | Clean Architecture | Hexagonal |
|--------|---------|-------------------|-----------|
| **Core Concept** | Layer separation | Dependency rule (inward only) | Port-Adapter |
| **Dependency Direction** | Top → Bottom | Outside → Inside (concentric) | External → Internal |
| **Domain Position** | Middle layer | **Innermost** | **Innermost** |
| **Complexity** | Low | Medium-High | High |
| **Learning Cost** | Low | Medium | High |
| **Flexibility** | Medium | High | Very High |

**What is Clean Architecture?**

Proposed by Robert C. Martin (Uncle Bob), the core principle is **"dependencies point inward only"**:

```
[Frameworks & Drivers] → [Interface Adapters] → [Use Cases] → [Entities]
        (outer)                                                    (center)
```

- Entities: Core business rules (domain)
- Use Cases: Application business rules
- Interface Adapters: Controller, Presenter, Gateway
- Frameworks & Drivers: DB, Web, UI, and other external details

### Why Layered Instead of Clean/Hexagonal?

| Consideration | Assessment | Reason |
|--------------|------------|--------|
| MSA structure? | No | Hexagonal is overhead for monolithic |
| Domain complexity | Not high | Clean Architecture's layer separation is excessive |
| Development period | 6 weeks (tight) | Insufficient time for learning + implementation |
| Team capability | Familiar with layered | Learning cost for new architecture |
| External system integration | Minimal | Low need for port-adapter pattern |

**Conclusion:** Clean/Hexagonal shine when **domain complexity is high**, **external system integration is extensive**, or **long-term maintenance** is needed. For a 6-week project, layered is sufficient, with the strategy of partially applying dependency inversion as needed.

### Traditional MVC vs Layered

**Why Presentation - Application - Domain - Infrastructure:**

| Advantage | Description |
|-----------|-------------|
| Clear roles/responsibilities | Each layer has single responsibility |
| Separation of concerns | UI, business logic, domain, infra separated |
| Testability | Unit tests per layer |
| Ease of change/extension | Changes in one layer minimally affect others |

**Core rules of layered architecture:**
1. Use layer structure
2. **Dependency direction between layers is unidirectional** (bidirectional defeats the purpose)

---

## 3. Development Approach: What to Build First?

In layered architecture, development order falls into two categories:
- **Top-Down**: Presentation → Application → Domain → Infrastructure
- **Bottom-Up**: Infrastructure → Domain → Application → Presentation

### Approach 1: JPA Entities First (Bottom-Up, DB-Centric)

![JPA entity-first approach](/uploads/프로젝트/EduMeet/architecture-evolution/approach-1-jpa-entity-db.png)

A bottom-up approach starting from Infrastructure (DB). Starting with JPA entities is essentially designing DDL (tables) first.

**Problems:**
- Other developers must wait until DDL is created
- Cannot parallelize work
- **Development tied to DB** → building features to fit the DB, not requirements

### Approach 2: API Endpoints First (Top-Down, Framework-Centric)

![API endpoint-first approach](/uploads/프로젝트/EduMeet/architecture-evolution/approach-2-api.png)

A top-down approach starting from Presentation (Controller). Thinking about RequestBody/ResponseEntity first.

**Problems:**
- Deciding technical specs (Spring Web, JPA, JWT, etc.) before analyzing the domain
- **Development tied to framework**
- Excluding alternatives like WebSocket, gRPC, message queues

> **"You're a backend developer, not a Spring API server developer."**

### The Right Approach: Domain First (Domain-Centric)

```
1. Develop domain
2. Develop application services
3. Define interfaces for services
4. Implement controllers, JPA, etc.
```

**Key insight:**
- "This project uses Spring and JPA" (X)
- "This project deals with this domain" (O)

---

## 4. Evolving Layered Architecture with Dependency Inversion

### Problem with the Existing Structure

![JPA tight coupling](/uploads/프로젝트/EduMeet/architecture-evolution/before-problem.png)

**When Service directly depends on JpaRepository:**
- Even if a technology replacing JPA emerges in 10 years, replacement is impossible
- "Tightly coupled to JPA version X.X.X, cannot be changed"

### Solution: Apply Dependency Inversion

![Dependency inversion applied](/uploads/프로젝트/EduMeet/architecture-evolution/solution-dependency-inversion-applied.png)

**Introduce an interface between Application and Infrastructure:**

```
Before: Service → JpaRepository (direct dependency)
After:  Service → Repository (interface) ← JpaRepositoryImpl
```

**Benefits:**
- Service no longer depends on JPA
- Repository implementation can be freely swapped (JPA → MyBatis, MongoDB, etc.)
- NoSQL becomes an option too

### Applying Dependency Inversion to Presentation

![Presentation dependency inversion](/uploads/프로젝트/EduMeet/architecture-evolution/presentation-dependency-inversion-applied.png)

**Positive aspects:**
- Easier testing of Presentation components
- Consistent pattern across all boundaries
- Enforced boundaries

**Negative aspects:**
- Practical value may be unclear
- Application → Presentation dependency feels unnatural to some
- Argument that the domain is already independent without DIP

---

## 5. Layered → Hexagonal: Same Essence

![Hexagonal comparison](/uploads/프로젝트/EduMeet/architecture-evolution/layered-hexagonal.png)

Layered architecture with dependency inversion is **essentially identical to hexagonal architecture**.

**Key takeaways:**
- Hexagonal's "port-adapter pattern" = another name for dependency inversion
- Architecture is about **understanding principles**, not memorization
- Evolving layered architecture naturally leads to hexagonal

> **"It's the coupling with spring-web that's broken, not with Spring Framework itself. Annotations like @Service and @Repository are still used. Spring's core value is IoC container and DI support."**

---

## 6. Domain Model and Persistence Object: To Separate or Not?

### Not Separating

| Pros | Cons |
|------|------|
| No need for conversion methods like from(), toModel() | Unclear class responsibilities |
| Faster development | Promotes DB-centric thinking |
| Stays true to ORM's original purpose | Harder to manage as domain grows |

### Separating

| Pros | Cons |
|------|------|
| Domain separated from persistence library | More code to write |
| SRP compliance | Harder to leverage ORM benefits |
| Easy to swap DB library | Conversion logic needed |

**Core principles:**
- Domain logic (change, validate, etc.) belongs in **Domain classes**
- Persistence objects (JpaEntity) should contain **only data persistence code**
- Domain layer should be **pure Java code** (no external dependencies like @Entity, @Service)

---

## 7. Conclusion

### Key Takeaways

1. **Essence of Architecture**
   - Reduce coupling and increase cohesion through constraints
   - No single right answer — it's all about trade-offs

2. **Development Order**
   ```
   Domain → Application Service → Interfaces → Implementations
   ```
   - Starting with JPA or API endpoints leads to technology lock-in

3. **Dependency Inversion**
   - Builds a domain-centric layered architecture
   - Enables flexible response to technology stack changes
   - Ultimately results in the same structure as hexagonal architecture

### Decision-Making Process

```
1. Problem identified
2. List available options
3. Compare pros and cons (trade-off analysis)
4. Choose based on the situation
```

> **"Every decision in software development is a battle of trade-offs."**

---

## Reference

- [Pragmatic Programming for Java/Spring Developers](https://product.kyobobook.co.kr/detail/S000213447953) - by Kim Woo-geun
- [Clean Architecture: A Craftsman's Guide to Software Structure and Design](https://product.kyobobook.co.kr/detail/S000001033082) - by Robert C. Martin
- [API-First Design | Swagger](https://swagger.io/resources/articles/adopting-an-api-first-approach) - API-first design methodology

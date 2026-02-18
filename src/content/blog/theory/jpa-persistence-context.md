---
title: 'JPA 영속성 컨텍스트와 트랜잭션 이해하기'
titleEn: 'Understanding JPA Persistence Context and Transactions'
description: '@Transactional의 프록시 동작 원리, 영속성 컨텍스트의 1차 캐시와 더티 체킹, 전파 속성, 그리고 실무에서 자주 발생하는 함정까지 정리한다.'
descriptionEn: 'Covers @Transactional proxy mechanics, persistence context 1st-level cache and dirty checking, propagation attributes, and common production pitfalls.'
date: 2025-12-23T00:00:00.000Z
tags:
  - JPA
  - Persistence Context
  - Transaction
  - Spring
  - Hibernate
  - Dirty Checking
category: theory
draft: false
coverImage: "/uploads/theory/jpa-persistence-context/transaction-basics.png"
---

사이드 프로젝트를 진행하면서 Spring 트랜잭션에 대해 배운 것들을 정리했다.
배우면서 햇갈렸던 것들을 다시 재정립 해서 내 지식으로 만들고 싶었다.

---

## @Transactional 기초

계좌 이체처럼 여러 DB 작업이 하나의 단위로 묶여야 할 때 트랜잭션을 쓴다.
출금은 됐는데 입금이 안 되면 큰일나니까.

![](/uploads/theory/jpa-persistence-context/transaction-basics.png)


**꼭 써야 하는 경우:**
- 여러 DB 작업이 하나의 단위로 실행되어야 할 때
- 데이터 일관성이 중요한 비즈니스 로직
- 롤백이 필요한 작업

**안 써도 되는 경우:**
- 단순 조회 (단, `readOnly = true`로 쓰면 최적화 이점이 있음)
- 단일 INSERT/UPDATE (자동 커밋으로 처리 가능)

> [Spring Transaction Management](https://docs.spring.io/spring-framework/reference/data-access/transaction.html)

---

## @Transactional은 어떻게 동작할까?

`@Transactional`을 붙이면 마법처럼 트랜잭션이 관리되는데, 내부적으로는 프록시 패턴을 쓴다.

Spring은 `@Transactional`이 붙은 클래스에 대해 프록시 객체를 만들고, 이 프록시가 메서드 호출을 가로채서 트랜잭션을 시작/커밋/롤백한다.

![](/uploads/theory/jpa-persistence-context/proxy-pattern.png)


### 프록시 생성 방식

Spring Boot는 CGLIB를 기본으로 쓴다. CGLIB는 바이트코드를 조작해서 런타임에 클래스를 상속받아 프록시를 만든다.

| 방식 | 설명 | 사용 조건 |
|------|------|-----------|
| JDK Dynamic Proxy | 인터페이스 기반 프록시 | 인터페이스 있을 때 |
| CGLIB Proxy | 클래스 상속 기반 프록시 | Spring Boot 기본 |

### 개념적으로 보면

![](/uploads/theory/jpa-persistence-context/proxy-conceptual.png)


### 그래서 주의할 점

CGLIB은 상속으로 프록시를 만들기 때문에:
- **private 메서드**: 상속 안 되니까 `@Transactional` 적용 불가
- **final 클래스/메서드**: 오버라이드 안 되니까 `@Transactional` 적용 불가

### 내부 호출 함정

이거 처음에 진짜 헷갈렸다.

![](/uploads/theory/jpa-persistence-context/internal-call-trap.png)


같은 클래스 안에서 메서드를 호출하면 프록시를 안 거치고 직접 호출된다.

그래서 `@Transactional`이 동작 안 한다.

해결하려면 별도 서비스 클래스로 분리하면 된다.

> **참고:**
> - [AOP와 @Transactional의 동작 원리](https://velog.io/@ann0905/AOP와-Transactional의-동작-원리)
> - [Spring Boot - @Transactional과 프록시 패턴](https://velog.io/@kyu0/Spring-Boot-Transactional과-속성들-프록시-패턴)

---

## readOnly = true는 왜 쓰나?

조회 메서드에 `readOnly = true`를 붙이면 몇 가지 이점이 있다.

![](/uploads/theory/jpa-persistence-context/readonly-declaration.png)


이렇게 선언하면 Spring과 JPA는 "이 메서드에서 쓰기 연산(persist, merge, remove)이 없을 것"이라고 가정하고 최적화를 수행한다.

### JPA 레벨 최적화: Dirty Checking 생략

JPA는 엔티티를 조회하면 영속성 컨텍스트에 저장하고, 이 객체가 변경되었는지 추적한다(Dirty Checking). 이때 원본 스냅샷을 만들어서 비교한다.

```
1. 엔티티 조회 -> 영속성 컨텍스트에 저장 + 스냅샷 생성
2. 트랜잭션 커밋 시점 -> 현재 상태 vs 스냅샷 비교
3. 변경 있으면 -> UPDATE 쿼리 생성
```

근데 `readOnly = true`면 이 과정 자체가 생략된다:

- FlushMode가 MANUAL로 바뀜
- 스냅샷 안 만듦
- flush() 호출 안 함
- Dirty Checking 안 함

불필요한 객체 복사와 추적 로직이 사라지니까 **메모리 사용량과 CPU 연산이 줄어든다**.

### DB 레벨 최적화: READ ONLY 힌트 전달

`readOnly = true`는 JPA 내부에서만 끝나는 게 아니다.

JDBC 트랜잭션을 통해 DB에도 "이 트랜잭션은 데이터를 변경하지 않는다"는 힌트를 전달한다.

```java
connection.setReadOnly(true);  // JDBC 레벨에서 설정됨
```

PostgreSQL, Oracle, H2 등 일부 DB는 이 힌트를 통해 내부 처리를 최적화한다.

**1. 락 경합(Lock Contention) 감소**

일반 트랜잭션은 데이터 수정 가능성이 있으니까 쓰기 락(Write Lock)을 잡는다.

근데 read-only 트랜잭션은 변경이 없다고 명시됐으니까 락을 최소화하거나 안 건다.

결과적으로 동시에 여러 SELECT가 들어와도 락 충돌 없이 병렬 처리가 가능해진다.

고부하 환경에서 특히 효과적.

**2. Undo/Redo 로그 감소**

모든 트랜잭션은 롤백/복구를 위해 Undo/Redo 로그를 생성한다.

근데 read-only 트랜잭션은 변경할 게 없으니까 복구할 것도 없다.

DB가 이 로그 생성을 최소화하거나 건너뛰면서 디스크 I/O와 메모리 사용량이 줄어든다.

### DB Replication 환경에서 유용

Master-Slave 구조라면 `readOnly = true` 쿼리를 자동으로 Slave로 라우팅할 수 있다. Master 부하를 줄이고 읽기 성능을 높이는 효과.

### 내가 쓰는 패턴

클래스에 기본으로 `readOnly = true` 걸어두고, 쓰기 메서드에만 `@Transactional`로 오버라이드한다.

![](/uploads/theory/jpa-persistence-context/readonly-pattern.png)


### 주의: 낙관적 락(@Version)과의 충돌

`readOnly = true`를 무분별하게 쓰면 안 되는 이유가 있다. **낙관적 락(Optimistic Lock)**이 무력화될 수 있다.

JPA는 `@Version`으로 동시성을 제어한다:

![](/uploads/theory/jpa-persistence-context/version-optimistic-lock.png)

수정 시점에 version을 비교해서, 다른 트랜잭션이 먼저 수정했으면 `OptimisticLockException`을 던진다.

근데 `readOnly = true`에서 엔티티를 수정하면?

![](/uploads/theory/jpa-persistence-context/readonly-version-conflict.png)


- flush() 호출 안 됨
- Dirty Checking 안 됨
- @Version 비교도 안 됨
- **충돌이 발생해도 감지 못함**

최악의 경우, 다른 트랜잭션의 수정 내용을 조용히 덮어써버릴 수 있다. 그것도 아무 에러 없이.

### 결론

`readOnly = true`는 **진짜로 읽기만 할 때만** 써야 한다.

| 상황 | readOnly 사용 |
|------|:------------:|
| 순수 조회 (목록, 상세) | O |
| 조회 후 수정 가능성 있음 | X |
| @Version 있는 엔티티 수정 | X |
| 조회 결과로 비즈니스 판단만 | O |

"조회니까 무조건 readOnly" 가 아니라, **수정 가능성이 조금이라도 있으면 쓰면 안 된다**.

> **참고:** [JPA Transactional 잘 알고 쓰고 계신가요? - 카카오페이](https://tech.kakaopay.com/post/jpa-transactional-bri/)

---

## 트랜잭션 전파 (Propagation)

트랜잭션 안에서 다른 트랜잭션 메서드를 호출하면 어떻게 될까? 기존 트랜잭션에 참여할지, 새로 만들지를 결정하는 게 전파 속성이다.

처음에 이 개념이 헷갈렸는데, 물리 트랜잭션과 논리 트랜잭션을 구분하면 이해가 쉬워진다.

### 물리 트랜잭션 vs 논리 트랜잭션

**물리 트랜잭션**은 실제 DB 커넥션을 통한 트랜잭션이다. 커밋/롤백하면 진짜 DB에 반영된다.

**논리 트랜잭션**은 스프링이 트랜잭션 매니저를 통해 관리하는 단위다. 여러 논리 트랜잭션이 하나의 물리 트랜잭션을 공유할 수 있다.

![](/uploads/theory/jpa-persistence-context/physical-logical-transaction.png)


원칙은 단순하다:
- **모든 논리 트랜잭션이 커밋되어야** 물리 트랜잭션이 커밋됨
- **하나라도 롤백되면** 물리 트랜잭션도 롤백됨

### 전파 속성 종류

| 속성 | 기존 트랜잭션 없을 때 | 기존 트랜잭션 있을 때 |
|------|---------------------|---------------------|
| **REQUIRED** | 새로 생성 | 참여 |
| **REQUIRES_NEW** | 새로 생성 | 새로 생성 (기존건 보류) |
| **SUPPORTS** | 없이 진행 | 참여 |
| **NOT_SUPPORTED** | 없이 진행 | 보류시키고 없이 진행 |
| **MANDATORY** | 예외 발생 | 참여 |
| **NEVER** | 없이 진행 | 예외 발생 |
| **NESTED** | 새로 생성 | 중첩 트랜잭션 생성 |

실무에서는 REQUIRED랑 REQUIRES_NEW만 주로 쓴다.

### REQUIRED (기본값)

가장 많이 쓰는 기본 속성이다. 기존 트랜잭션이 있으면 참여하고, 없으면 새로 만든다.

![](/uploads/theory/jpa-persistence-context/required-propagation.png)


둘이 같은 물리 트랜잭션을 쓰기 때문에:
- inner()에서 예외 터지면 -> outer()도 같이 롤백
- outer()에서 예외 터지면 -> inner()도 같이 롤백

inner()에서 롤백이 필요한데 outer()는 커밋하려고 하면? 스프링이 `UnexpectedRollbackException`을 던져서 "야 롤백해야 돼"라고 알려준다.

### REQUIRES_NEW

항상 새 트랜잭션을 만든다. 기존 트랜잭션이 있어도 완전히 별개로 동작한다.

![](/uploads/theory/jpa-persistence-context/requires-new-propagation.png)


![](/uploads/theory/jpa-persistence-context/requires-new-detail.png)




inner()가 실행되는 동안 outer()의 커넥션은 대기 상태가 된다. 그래서 **커넥션 2개를 동시에 쓴다**.

주의할 점:
- 커넥션 풀 고갈 가능성이 있어서 남용하면 안됨
- 같은 클래스 안에서 호출하면 프록시를 안 거쳐서 동작 안함

### 언제 REQUIRES_NEW를 쓰나?

내부 트랜잭션의 성공/실패가 외부 트랜잭션에 영향을 주면 안 될 때 쓴다.

예를 들어 주문 처리 중 알림 발송이 실패해도 주문은 성공해야 하는 경우:

![](/uploads/theory/jpa-persistence-context/requires-new-usecase.png)


근데 REQUIRES_NEW 없이도 해결 가능하면 그게 더 낫다. 별도 서비스로 분리하거나 이벤트로 처리하는 방법도 있다.

실제로 내가 만드는 프로젝트에선

[파일 업로드 시스템에서의 고아파일 정리](https://velog.io/@dj258255/%ED%8C%8C%EC%9D%BC-%EC%97%85%EB%A1%9C%EB%93%9C-%EC%8B%9C%EC%8A%A4%ED%85%9C%EC%97%90%EC%84%9C%EC%9D%98-%EA%B3%A0%EC%95%84%ED%8C%8C%EC%9D%BC-%EC%A0%95%EB%A6%AC) 에서 활용을 했다.

### SUPPORTS

트랜잭션이 있으면 참여하고, 없으면 트랜잭션 없이 실행한다.

![](/uploads/theory/jpa-persistence-context/supports-propagation.png)

단순 조회인데 호출하는 쪽에 트랜잭션이 있으면 그걸 쓰고, 없으면 그냥 실행. 조회 메서드에서 가끔 쓴다.

### NOT_SUPPORTED

트랜잭션 없이 실행한다. 기존 트랜잭션이 있으면 보류시킨다.

![](/uploads/theory/jpa-persistence-context/not-supported-propagation.png)


트랜잭션이 필요 없는 작업(외부 API 호출, 파일 처리 등)에서 사용. 트랜잭션을 보류시키면 커넥션을 잡고 있지 않아서 리소스 낭비를 줄일 수 있다.

### MANDATORY

반드시 기존 트랜잭션 안에서 실행되어야 한다. 트랜잭션 없이 호출하면 예외 발생.

![](/uploads/theory/jpa-persistence-context/mandatory-propagation.png)


"이 메서드는 단독으로 호출하면 안 돼"라는 제약을 걸 때 사용. 실수로 트랜잭션 없이 호출하면 바로 에러가 나니까 버그를 빨리 잡을 수 있다.

### NEVER

트랜잭션 없이 실행한다. 기존 트랜잭션이 있으면 예외 발생.

![](/uploads/theory/jpa-persistence-context/never-propagation.png)


MANDATORY의 반대. "이 메서드는 트랜잭션 안에서 호출하면 안 돼"라는 제약. 거의 안 쓴다.

### NESTED

얘는 좀 특이하다. 부모 트랜잭션 안에 자식 트랜잭션을 만드는 건데:
- 자식이 롤백되어도 부모는 커밋 가능
- 부모가 롤백되면 자식도 같이 롤백

JDBC savepoint 기능을 쓰는 거라 JPA에서는 사용 못한다. 그래서 잘 안 쓴다.

> **참고:** [MangKyu - 스프링의 트랜잭션 전파 속성](https://mangkyu.tistory.com/269)



---

## 롤백 규칙

기본적으로 RuntimeException이 터지면 롤백, Checked Exception은 롤백 안 된다.

![](/uploads/theory/jpa-persistence-context/rollback-rules.png)


왜 이런 규칙이냐면, EJB 시절부터 내려온 관례다:
- RuntimeException: 시스템 오류라서 복구 불가능하니까 롤백
- Checked Exception: 비즈니스 예외로 예상된 상황이니까 커밋 후 처리

Checked Exception에서도 롤백하고 싶으면:

![](/uploads/theory/jpa-persistence-context/rollback-checked-exception.png)


그리고 예외를 catch해서 삼키면 롤백 안 된다. 롤백하려면 다시 던지거나 `setRollbackOnly()` 호출해야 함.

> **참고:** [Rolling Back a Declarative Transaction - Spring Docs](https://docs.spring.io/spring-framework/reference/data-access/transaction/declarative/rolling-back.html)

---

## 배운점

이번에 트랜잭션 관련 내용을 정리하면서 가장 크게 깨달은 건 **"트랜잭션의 경계"**에 대한 이해였다.

### 외부 시스템은 트랜잭션 밖이다

R2나 S3 같은 외부 스토리지는 DB 트랜잭션 안에 포함되지 않는다. 당연한 얘기지만, 직접 부딪혀보기 전까지는 크게 신경 쓰지 않았던 부분이다.

```java
@Transactional
public void updateProfile(...) {
    user.updateProfileImage(newImageId);  // ① DB 업데이트
    r2Service.deleteFile(oldImagePath);   // ② R2 삭제 (외부 시스템!)
    return userRepository.save(user);     // ③ 커밋
}
```

만약 ①②가 성공하고 ③에서 예외가 터지면? DB는 롤백되는데 R2 파일은 이미 삭제됨. 데이터 불일치.

그래서 `@TransactionalEventListener(AFTER_COMMIT)`을 써서 DB 커밋이 성공한 후에만 외부 시스템 작업을 하도록 했다.

### AFTER_COMMIT의 함정

근데 여기서 또 한 가지 함정이 있었다. AFTER_COMMIT 시점에서 `@Transactional` 메서드를 호출하면 당연히 새 트랜잭션이 시작될 줄 알았는데, 실제로는 DB에 반영이 안 됐다.

알고 보니 DB 트랜잭션은 이미 종료됐지만 스프링 트랜잭션 컨텍스트는 아직 정리 전이라서, 기본 전파 속성(REQUIRED)으로는 "이미 종료된 트랜잭션에 참여"하려고 시도하기 때문이었다.

`REQUIRES_NEW`로 명시적으로 새 트랜잭션을 시작해야 한다는 걸 배웠다.

### readOnly는 양날의 검

`@Transactional(readOnly = true)`가 성능에 좋다고 해서 무분별하게 쓰면 안 된다는 것도 알게 됐다.

- Dirty Checking 생략 → 성능 향상
- 근데 `@Version` 기반 낙관적 락도 무력화됨
- 실수로 수정해도 에러 안 나고 조용히 무시됨

**"조회니까 무조건 readOnly"가 아니라, 수정 가능성이 조금이라도 있으면 쓰면 안 된다.**

### 전파 속성은 실제로 몇 개만 쓴다

7가지 전파 속성을 다 정리했지만, 실무에서는 거의 `REQUIRED`랑 `REQUIRES_NEW`만 쓴다. 나머지는 특수한 상황에서나 쓰고, 대부분은 기본값으로 충분하다.

근데 `REQUIRES_NEW`를 쓸 때 **커넥션 2개를 동시에 쓴다**는 점은 알고 있어야 한다. 남용하면 커넥션 풀 고갈될 수 있음.

### 결론

결국 이번 정리를 통해 **"@Transactional 하나 붙이면 끝"이 아니라, 내부 동작 원리를 알아야 제대로 쓸 수 있다**는 걸 깨달았다. 특히 프록시 동작 방식, 물리/논리 트랜잭션 구분, 외부 시스템과의 경계 등은 알고 있어야 디버깅할 때 헤매지 않는다.

---

## 참고

- [Spring Transaction Management](https://docs.spring.io/spring-framework/reference/data-access/transaction.html)
- [카카오페이 - JPA Transactional 잘 알고 쓰고 계신가요?](https://tech.kakaopay.com/post/jpa-transactional-bri/)
- [Vlad Mihalcea - The best way to use Spring Transactional](https://vladmihalcea.com/spring-transactional-annotation/)
- [MangKyu - 스프링의 트랜잭션 전파 속성](https://mangkyu.tistory.com/269)

<!-- EN -->

I organized what I learned about Spring transactions while working on a side project. I wanted to consolidate the concepts that confused me and make them my own.

---

## @Transactional Basics

You use transactions when multiple DB operations need to be treated as a single unit, like a bank transfer. If the withdrawal succeeds but the deposit fails, that would be a disaster.

![](/uploads/theory/jpa-persistence-context/transaction-basics.png)


**When you must use it:**
- When multiple DB operations must execute as a single unit
- Business logic where data consistency is critical
- Operations that require rollback

**When you can skip it:**
- Simple reads (though using `readOnly = true` provides optimization benefits)
- Single INSERT/UPDATE (can be handled by auto-commit)

> [Spring Transaction Management](https://docs.spring.io/spring-framework/reference/data-access/transaction.html)

---

## How Does @Transactional Work?

When you add `@Transactional`, transactions are managed as if by magic, but internally it uses the proxy pattern.

Spring creates a proxy object for the class annotated with `@Transactional`, and this proxy intercepts method calls to begin/commit/rollback the transaction.

![](/uploads/theory/jpa-persistence-context/proxy-pattern.png)


### Proxy Generation Methods

Spring Boot uses CGLIB by default. CGLIB manipulates bytecode to create proxies by subclassing classes at runtime.

| Method | Description | Condition |
|--------|-------------|-----------|
| JDK Dynamic Proxy | Interface-based proxy | When an interface exists |
| CGLIB Proxy | Class inheritance-based proxy | Spring Boot default |

### Conceptual View

![](/uploads/theory/jpa-persistence-context/proxy-conceptual.png)


### Things to Watch Out For

Because CGLIB creates proxies through inheritance:
- **private methods**: Cannot be inherited, so `@Transactional` does not apply
- **final classes/methods**: Cannot be overridden, so `@Transactional` does not apply

### The Internal Call Trap

This one really confused me at first.

![](/uploads/theory/jpa-persistence-context/internal-call-trap.png)


When you call a method within the same class, it is invoked directly without going through the proxy.

That means `@Transactional` does not take effect.

The solution is to extract the method into a separate service class.

> **References:**
> - [How AOP and @Transactional Work](https://velog.io/@ann0905/AOP와-Transactional의-동작-원리)
> - [Spring Boot - @Transactional and the Proxy Pattern](https://velog.io/@kyu0/Spring-Boot-Transactional과-속성들-프록시-패턴)

---

## Why Use readOnly = true?

Adding `readOnly = true` to query methods provides several benefits.

![](/uploads/theory/jpa-persistence-context/readonly-declaration.png)


When declared this way, Spring and JPA assume that no write operations (persist, merge, remove) will occur in this method and perform optimizations.

### JPA-Level Optimization: Skipping Dirty Checking

When JPA loads an entity, it stores it in the persistence context and tracks whether the object has changed (Dirty Checking). It creates a snapshot of the original for comparison.

```
1. Entity loaded -> Stored in persistence context + snapshot created
2. At transaction commit -> Compare current state vs snapshot
3. If changed -> Generate UPDATE query
```

With `readOnly = true`, this entire process is skipped:

- FlushMode switches to MANUAL
- No snapshot is created
- flush() is not called
- Dirty Checking is not performed

By eliminating unnecessary object copying and tracking logic, **memory usage and CPU computation are reduced**.

### DB-Level Optimization: Passing the READ ONLY Hint

`readOnly = true` does not stop at the JPA level.

Through JDBC transactions, a hint is also passed to the database indicating "this transaction will not modify data."

```java
connection.setReadOnly(true);  // Set at the JDBC level
```

Some databases like PostgreSQL, Oracle, and H2 use this hint to optimize their internal processing.

**1. Reduced Lock Contention**

Normal transactions acquire write locks because data modifications are possible.

However, read-only transactions are explicitly declared as non-modifying, so locks are minimized or not acquired at all.

As a result, even when multiple SELECT queries arrive simultaneously, they can be processed in parallel without lock contention.

This is especially effective in high-traffic environments.

**2. Reduced Undo/Redo Logs**

Every transaction generates undo/redo logs for rollback and recovery purposes.

But read-only transactions have nothing to change, so there is nothing to recover.

The DB minimizes or skips log generation, reducing disk I/O and memory usage.

### Useful in DB Replication Environments

In a Master-Slave architecture, queries marked with `readOnly = true` can be automatically routed to Slave replicas. This reduces Master load and improves read performance.

### The Pattern I Use

I set `readOnly = true` at the class level by default, and override with `@Transactional` only for write methods.

![](/uploads/theory/jpa-persistence-context/readonly-pattern.png)


### Caution: Conflict with Optimistic Locking (@Version)

There is a reason you should not use `readOnly = true` recklessly. It can neutralize **optimistic locking**.

JPA controls concurrency with `@Version`:

![](/uploads/theory/jpa-persistence-context/version-optimistic-lock.png)

At the time of modification, the version is compared, and if another transaction modified the data first, an `OptimisticLockException` is thrown.

But what happens when you modify an entity under `readOnly = true`?

![](/uploads/theory/jpa-persistence-context/readonly-version-conflict.png)


- flush() is not called
- Dirty Checking is not performed
- @Version comparison is not performed
- **Conflicts go undetected**

In the worst case, another transaction's modifications can be silently overwritten, with no error at all.

### Conclusion

`readOnly = true` should only be used **when you truly only read**.

| Scenario | Use readOnly |
|----------|:----------:|
| Pure queries (list, detail) | O |
| Possible modification after query | X |
| Modifying entities with @Version | X |
| Business decisions based on query results only | O |

It is not "always use readOnly for queries" -- **if there is even the slightest chance of modification, do not use it**.

> **Reference:** [Are You Using JPA Transactional Correctly? - Kakaopay](https://tech.kakaopay.com/post/jpa-transactional-bri/)

---

## Transaction Propagation

What happens when a transactional method calls another transactional method? The propagation attribute determines whether to join the existing transaction or create a new one.

This concept confused me at first, but distinguishing between physical transactions and logical transactions made it much easier to understand.

### Physical Transaction vs Logical Transaction

A **physical transaction** is the actual transaction through a DB connection. When committed or rolled back, it is truly applied to the DB.

A **logical transaction** is a unit managed by Spring's transaction manager. Multiple logical transactions can share a single physical transaction.

![](/uploads/theory/jpa-persistence-context/physical-logical-transaction.png)


The rules are simple:
- **All logical transactions must commit** for the physical transaction to commit
- **If any one rolls back**, the physical transaction also rolls back

### Propagation Types

| Type | No existing transaction | Existing transaction present |
|------|------------------------|------------------------------|
| **REQUIRED** | Create new | Join |
| **REQUIRES_NEW** | Create new | Create new (suspend existing) |
| **SUPPORTS** | Run without | Join |
| **NOT_SUPPORTED** | Run without | Suspend existing, run without |
| **MANDATORY** | Throw exception | Join |
| **NEVER** | Run without | Throw exception |
| **NESTED** | Create new | Create nested transaction |

In practice, only REQUIRED and REQUIRES_NEW are commonly used.

### REQUIRED (Default)

The most commonly used default attribute. Joins an existing transaction if one exists, otherwise creates a new one.

![](/uploads/theory/jpa-persistence-context/required-propagation.png)


Since both share the same physical transaction:
- If inner() throws an exception -> outer() also rolls back
- If outer() throws an exception -> inner() also rolls back

What if inner() needs to roll back but outer() tries to commit? Spring throws an `UnexpectedRollbackException` to signal that a rollback is required.

### REQUIRES_NEW

Always creates a new transaction. Even if an existing transaction is present, it operates completely independently.

![](/uploads/theory/jpa-persistence-context/requires-new-propagation.png)


![](/uploads/theory/jpa-persistence-context/requires-new-detail.png)



While inner() is executing, outer()'s connection enters a waiting state. This means **two connections are used simultaneously**.

Things to watch out for:
- Connection pool exhaustion is possible, so avoid overuse
- Calling within the same class bypasses the proxy and does not work

### When to Use REQUIRES_NEW

Use it when the success or failure of the inner transaction must not affect the outer transaction.

For example, when notification delivery fails during order processing, the order should still succeed:

![](/uploads/theory/jpa-persistence-context/requires-new-usecase.png)


However, if you can solve the problem without REQUIRES_NEW, that is preferable. You can also extract into a separate service or use event-driven approaches.

In my actual project, I used it for [Orphan File Cleanup in a File Upload System](https://velog.io/@dj258255/%ED%8C%8C%EC%9D%BC-%EC%97%85%EB%A1%9C%EB%93%9C-%EC%8B%9C%EC%8A%A4%ED%85%9C%EC%97%90%EC%84%9C%EC%9D%98-%EA%B3%A0%EC%95%84%ED%8C%8C%EC%9D%BC-%EC%A0%95%EB%A6%AC).

### SUPPORTS

Joins an existing transaction if one exists, otherwise runs without a transaction.

![](/uploads/theory/jpa-persistence-context/supports-propagation.png)

For simple queries, it uses the caller's transaction if one exists, otherwise just runs. Occasionally used for query methods.

### NOT_SUPPORTED

Runs without a transaction. Suspends the existing transaction if one is present.

![](/uploads/theory/jpa-persistence-context/not-supported-propagation.png)


Used for operations that do not need transactions (external API calls, file processing, etc.). Suspending the transaction releases the connection hold, reducing resource waste.

### MANDATORY

Must run within an existing transaction. Throws an exception if called without one.

![](/uploads/theory/jpa-persistence-context/mandatory-propagation.png)


Use this to enforce the constraint: "this method must not be called standalone." If accidentally called without a transaction, an immediate error is raised, helping you catch bugs early.

### NEVER

Runs without a transaction. Throws an exception if an existing transaction is present.

![](/uploads/theory/jpa-persistence-context/never-propagation.png)


The opposite of MANDATORY. Enforces: "this method must not be called inside a transaction." Rarely used.

### NESTED

This one is somewhat special. It creates a child transaction within the parent transaction:
- Even if the child rolls back, the parent can commit
- If the parent rolls back, the child also rolls back

It uses JDBC's savepoint feature, so it cannot be used with JPA. Hence, it is rarely used.

> **Reference:** [MangKyu - Spring Transaction Propagation](https://mangkyu.tistory.com/269)



---

## Rollback Rules

By default, a RuntimeException triggers a rollback, while a Checked Exception does not.

![](/uploads/theory/jpa-persistence-context/rollback-rules.png)


The reason for this rule dates back to the EJB era:
- RuntimeException: System errors that are unrecoverable, so rollback
- Checked Exception: Business exceptions that are expected situations, so commit and handle

To force rollback on a Checked Exception:

![](/uploads/theory/jpa-persistence-context/rollback-checked-exception.png)


Also, if you catch and swallow an exception, no rollback occurs. You must either re-throw it or call `setRollbackOnly()` for a rollback.

> **Reference:** [Rolling Back a Declarative Transaction - Spring Docs](https://docs.spring.io/spring-framework/reference/data-access/transaction/declarative/rolling-back.html)

---

## Lessons Learned

The biggest takeaway from organizing this material was understanding **"transaction boundaries."**

### External Systems Are Outside the Transaction

External storage services like R2 or S3 are not included in DB transactions. It sounds obvious, but I did not pay much attention to it until I ran into problems firsthand.

```java
@Transactional
public void updateProfile(...) {
    user.updateProfileImage(newImageId);  // ① DB update
    r2Service.deleteFile(oldImagePath);   // ② R2 delete (external system!)
    return userRepository.save(user);     // ③ Commit
}
```

If steps 1 and 2 succeed but step 3 throws an exception, the DB rolls back but the R2 file is already deleted. Data inconsistency.

That is why I used `@TransactionalEventListener(AFTER_COMMIT)` to perform external system operations only after the DB commit succeeds.

### The AFTER_COMMIT Pitfall

But there was another trap here. I assumed that calling a `@Transactional` method during AFTER_COMMIT would naturally start a new transaction, but the changes were not actually persisted to the DB.

It turned out that although the DB transaction was already complete, the Spring transaction context had not yet been cleaned up, so with the default propagation (REQUIRED), it tried to "join the already-finished transaction."

I learned that you must explicitly start a new transaction with `REQUIRES_NEW`.

### readOnly Is a Double-Edged Sword

I also learned that `@Transactional(readOnly = true)` should not be used indiscriminately just because it is good for performance.

- Dirty Checking is skipped -> Performance improvement
- But @Version-based optimistic locking is also neutralized
- Accidental modifications silently go unnoticed

**"readOnly for all queries" is wrong -- if there is even the slightest chance of modification, do not use it.**

### In Practice, Only a Few Propagation Types Are Used

I documented all 7 propagation types, but in practice, almost only `REQUIRED` and `REQUIRES_NEW` are used. The rest are for special situations, and the default is sufficient for most cases.

However, you should be aware that `REQUIRES_NEW` **uses two connections simultaneously**. Overuse can lead to connection pool exhaustion.

### Conclusion

Ultimately, this exercise taught me that **adding a single @Transactional is not enough -- you need to understand the internal mechanics to use it correctly**. In particular, understanding proxy behavior, the distinction between physical and logical transactions, and boundaries with external systems will save you from debugging headaches.

---

## References

- [Spring Transaction Management](https://docs.spring.io/spring-framework/reference/data-access/transaction.html)
- [Kakaopay - Are You Using JPA Transactional Correctly?](https://tech.kakaopay.com/post/jpa-transactional-bri/)
- [Vlad Mihalcea - The best way to use Spring Transactional](https://vladmihalcea.com/spring-transactional-annotation/)
- [MangKyu - Spring Transaction Propagation](https://mangkyu.tistory.com/269)
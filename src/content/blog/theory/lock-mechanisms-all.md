---
title: '락 메커니즘의 모든 것 - 하드웨어부터 분산 시스템까지'
titleEn: 'Lock Mechanisms: From Hardware to Distributed Systems'
description: CPU의 원자 명령어(CAS, TAS)부터 OS 레벨 락, 애플리케이션 락, DB 락, 분산 락까지 락 메커니즘의 전체 스펙트럼을 정리한다.
descriptionEn: Covers the full spectrum of lock mechanisms from CPU atomic instructions (CAS, TAS) through OS locks, application locks, DB locks, to distributed locks.
date: 2025-09-18T00:00:00.000Z
tags:
  - Lock
  - CAS
  - Distributed Lock
  - Database Lock
  - Concurrency
  - Redis
category: theory
draft: false
---


## 들어가며

애플리케이션을 개발하다 보면 "락(Lock)"이라는 용어를 여러 곳에서 마주치게 됩니다. Java의 `synchronized`, 데이터베이스의 `SELECT FOR UPDATE`, Redis의 분산 락... 모두 "락"이라고 부르지만, 동작하는 레벨과 방식이 완전히 다릅니다.

이 글에서는 **하드웨어 락(Hardware Lock)**부터 시작해서 **OS 락**, **애플리케이션 락**, **데이터베이스 락**, **분산 락**까지 락 메커니즘의 전체 스펙트럼을 다뤄보려 합니다.

> 출처: [GeeksforGeeks - Introduction to Lock](https://www.geeksforgeeks.org/lock-variable-synchronization-mechanism/)

## 1. 하드웨어 락 (Hardware Lock)

> **핵심 요약:** 소프트웨어만으로는 진정한 원자성을 보장할 수 없기 때문에 CPU가 제공하는 원자 명령어가 필요합니다.

### 1.1 왜 하드웨어의 도움이 필요한가?

소프트웨어만으로는 **원자성(Atomicity)**을 보장할 수 없습니다. 가장 간단한 예를 보겠습니다.

```java
// 소프트웨어로 락 구현 시도 (잘못된 방법)
class BrokenLock {
    private boolean locked = false;

    public void lock() {
        // 문제: 이 코드는 원자적이지 않다!
        while (locked) {
            // 대기
        }
        locked = true;  // 여러 스레드가 동시에 실행 가능!
    }

    public void unlock() {
        locked = false;
    }
}
```

**문제점:**
![](/uploads/theory/lock-mechanisms-all/11-why-hardware-help-needed.png)


두 스레드가 동시에 `locked == false`를 확인하고 둘 다 락을 획득합니다. 이를 해결하려면 **하드웨어의 도움**이 필요합니다.

> 출처: [Wikipedia - Lock (computer science)](https://en.wikipedia.org/wiki/Lock_(computer_science)), [Embedded - Implementing Locks](https://www.embedded.com/implementing-a-lock/)

### 1.2 Test-and-Set (TAS)

> **핵심 요약:** 값을 읽고 설정하는 동작을 하나의 원자적 명령어로 수행합니다.

가장 간단한 하드웨어 원자 명령어입니다.

```c
// 하드웨어가 제공하는 원자 명령어
bool test_and_set(bool *target) {
    bool old_value = *target;
    *target = true;
    return old_value;
    // 이 세 줄이 원자적으로 실행됨 (중간에 끼어들 수 없음)
}
```

**사용 예시:**
```c
class TASLock {
    bool locked = false;

    void lock() {
        // old_value가 false일 때까지 반복 (락 획득 성공)
        while (test_and_set(&locked)) {
            // 바쁜 대기 (busy waiting)
        }
    }

    void unlock() {
        locked = false;
    }
}
```

**동작 과정:**
![](/uploads/theory/lock-mechanisms-all/12-test-and-set-tas.png)


> 출처: [Wikipedia - Test-and-Set](https://en.wikipedia.org/wiki/Test-and-set)

### 1.3 Compare-and-Swap (CAS)

> **핵심 요약:** 기대값과 실제 값을 비교해서 일치하면 새로운 값으로 교체하는 원자적 연산입니다.

현대 프로세서가 제공하는 더 강력한 원자 명령어입니다.

```c
// 하드웨어 CAS 명령어
bool compare_and_swap(int *ptr, int expected, int new_value) {
    int actual = *ptr;
    if (actual == expected) {
        *ptr = new_value;
        return true;
    }
    return false;
    // 이 모든 과정이 원자적으로 실행됨
}
```

**Java에서의 CAS:**
```java
import java.util.concurrent.atomic.AtomicInteger;

class CASExample {
    private AtomicInteger value = new AtomicInteger(0);

    public void increment() {
        int oldValue, newValue;
        do {
            oldValue = value.get();
            newValue = oldValue + 1;
        } while (!value.compareAndSet(oldValue, newValue));
        // CAS 실패 시 재시도 (낙관적 접근)
    }
}
```

**동작 과정:**
![](/uploads/theory/lock-mechanisms-all/13-compare-and-swap-cas.png)



**CAS의 장점:**
- **락 프리(Lock-free)**: 락 없이 동시성 제어
- **성능**: 락보다 빠름 (대기하지 않고 재시도)
- **데드락 없음**: 락을 사용하지 않으므로

**CAS의 단점:**
- **ABA 문제**: A → B → A로 변경되면 감지 못함
- **스핀 오버헤드**: 재시도 횟수가 많으면 CPU 낭비

> 출처: [Wikipedia - Compare-and-Swap](https://en.wikipedia.org/wiki/Compare-and-swap), [Baeldung - Compare and Swap in Java](https://www.baeldung.com/java-compare-and-swap), [Oracle - AtomicInteger](https://docs.oracle.com/javase/8/docs/api/java/util/concurrent/atomic/AtomicInteger.html)

### 1.4 Memory Barrier (메모리 장벽)

멀티코어 CPU에서는 각 코어가 **자체 캐시**를 가지고 있어서, 메모리 일관성 문제가 발생할 수 있습니다.

```java
class Singleton {
    private static Singleton instance;

    // 잘못된 구현 (Double-Checked Locking 문제)
    public static Singleton getInstance() {
        if (instance == null) {  // 1. 첫 번째 체크
            synchronized (Singleton.class) {
                if (instance == null) {  // 2. 두 번째 체크
                    instance = new Singleton();  // 문제 발생 지점!
                }
            }
        }
        return instance;
    }
}
```

**문제점:**
![](/uploads/theory/lock-mechanisms-all/14-memory-barrier-memory-barrier.png)


**해결: volatile 키워드 (Memory Barrier)**
```java
class Singleton {
    // volatile: 캐시 무시, 항상 메인 메모리에서 읽기/쓰기
    private static volatile Singleton instance;

    public static Singleton getInstance() {
        if (instance == null) {
            synchronized (Singleton.class) {
                if (instance == null) {
                    instance = new Singleton();
                    // volatile이 메모리 장벽 역할
                    // → 생성자 호출이 완전히 끝난 후에만 instance에 할당
                }
            }
        }
        return instance;
    }
}
```

**volatile의 역할:**
1. **가시성(Visibility)**: 모든 스레드가 최신 값을 봄
2. **순서 보장(Ordering)**: 명령어 재배치 방지

> 출처: [Wikipedia - Memory Barrier](https://en.wikipedia.org/wiki/Memory_barrier), [Baeldung - Guide to the Volatile Keyword](https://www.baeldung.com/java-volatile), [Java Language Specification - volatile](https://docs.oracle.com/javase/specs/jls/se8/html/jls-8.html#jls-8.3.1.4)

## 2. 스핀락 (Spinlock)

### 2.1 스핀락이란?

스핀락은 **락을 획득할 때까지 계속 확인**하는 방식이다.

```java
class Spinlock {
    private AtomicBoolean locked = new AtomicBoolean(false);

    public void lock() {
        // 락을 획득할 때까지 계속 시도 (바쁜 대기)
        while (!locked.compareAndSet(false, true)) {
            // CPU를 계속 사용하면서 대기!
        }
    }

    public void unlock() {
        locked.set(false);
    }
}
```

**동작 방식:**
![](/uploads/theory/lock-mechanisms-all/21-spinlock.png)


> 출처: [Wikipedia - Spinlock](https://en.wikipedia.org/wiki/Spinlock), [GeeksforGeeks - Spinlock](https://www.geeksforgeeks.org/spinlock-vs-semaphore/)

### 2.2 스핀락 vs Mutex

| 비교 항목 | 스핀락 (Spinlock) | 뮤텍스 (Mutex) |
|---------|-----------------|--------------|
| **대기 방식** | 바쁜 대기 (CPU 계속 사용) | 잠들기 (CPU 양보) |
| **컨텍스트 스위칭** | 없음 | 발생 |
| **적합한 상황** | 임계영역이 매우 짧음 (수 마이크로초) | 임계영역이 김 (밀리초 이상) |
| **CPU 사용률** | 높음 (대기 중에도 100%) | 낮음 (대기 중 0%) |
| **응답 시간** | 빠름 (즉시 재개) | 느림 (깨어나는 시간 필요) |

**언제 스핀락을 사용할까?**
```java
// 좋은 예: 매우 짧은 임계영역
class Counter {
    private Spinlock lock = new Spinlock();
    private int count = 0;

    public void increment() {
        lock.lock();
        count++;  // 단 하나의 명령어 (나노초 단위)
        lock.unlock();
    }
}

// 나쁜 예: 긴 임계영역
class FileProcessor {
    private Spinlock lock = new Spinlock();

    public void processFile() {
        lock.lock();
        readFromDisk();   // 수 밀리초 소요
        parseData();      // 수십 밀리초 소요
        writeToDatabase(); // 수백 밀리초 소요
        lock.unlock();    // 다른 스레드는 계속 CPU 낭비!
    }
}
```

**Linux 커널의 스핀락:**
```c
// Linux 커널에서 실제 사용되는 스핀락
spinlock_t my_lock = SPIN_LOCK_UNLOCKED;

spin_lock(&my_lock);
// 매우 짧은 임계영역 (보통 수십 나노초)
critical_section();
spin_unlock(&my_lock);
```

> 출처: [Linux Kernel Documentation - Spinlock](https://www.kernel.org/doc/html/latest/locking/spinlocks.html), [Baeldung - Spinlock vs Mutex](https://www.baeldung.com/cs/spinlock-vs-mutex)

## 3. 데이터베이스 락 (Database Lock)

### 3.1 MySQL/InnoDB의 락

#### Shared Lock (공유 락, S-Lock)

여러 트랜잭션이 **읽기 전용**으로 동시 접근 가능하다.

```sql
-- Shared Lock 획득
SELECT * FROM users WHERE id = 1 LOCK IN SHARE MODE;
```

**동작:**
```
트랜잭션 A: SELECT * FROM users WHERE id = 1 LOCK IN SHARE MODE;
  → Shared Lock 획득

트랜잭션 B: SELECT * FROM users WHERE id = 1 LOCK IN SHARE MODE;
  → Shared Lock 획득 (가능!)

트랜잭션 C: UPDATE users SET name = 'Kim' WHERE id = 1;
  → Exclusive Lock 시도 → 대기 (Shared Lock이 있음)
```

#### Exclusive Lock (배타 락, X-Lock)

**오직 하나의 트랜잭션만** 접근 가능하다.

```sql
-- Exclusive Lock 획득
SELECT * FROM users WHERE id = 1 FOR UPDATE;
```

**동작:**
```
트랜잭션 A: SELECT * FROM users WHERE id = 1 FOR UPDATE;
  → Exclusive Lock 획득

트랜잭션 B: SELECT * FROM users WHERE id = 1 FOR UPDATE;
  → 대기 (Exclusive Lock이 있음)

트랜잭션 C: SELECT * FROM users WHERE id = 1 LOCK IN SHARE MODE;
  → 대기 (Exclusive Lock이 있음)
```

**락 호환성 매트릭스:**
```
        S-Lock  X-Lock
S-Lock    O       X
X-Lock    X       X

O: 호환 (동시 획득 가능)
X: 비호환 (대기 필요)
```

> 출처: [MySQL Documentation - InnoDB Locking](https://dev.mysql.com/doc/refman/8.0/en/innodb-locking.html)

#### 실무 예제: 재고 차감

```java
@Service
@Transactional
public class OrderService {

    // 잘못된 방법: 경쟁 상태 발생
    public void createOrderWrong(Long productId, int quantity) {
        Product product = productRepository.findById(productId);

        if (product.getStock() >= quantity) {
            product.decreaseStock(quantity);  // 여러 트랜잭션이 동시 실행 가능!
            productRepository.save(product);
        }
    }

    // 올바른 방법: Exclusive Lock 사용
    @Query("SELECT p FROM Product p WHERE p.id = :id FOR UPDATE")
    Product findByIdForUpdate(@Param("id") Long id);

    public void createOrderCorrect(Long productId, int quantity) {
        // Exclusive Lock으로 다른 트랜잭션 차단
        Product product = productRepository.findByIdForUpdate(productId);

        if (product.getStock() >= quantity) {
            product.decreaseStock(quantity);
            productRepository.save(product);
        }
    }
}
```

**시나리오:**

**잘못된 방법**

![](/uploads/theory/lock-mechanisms-all/practical-example-stock-deduction.png)

**옳바른 방법**

![](/uploads/theory/lock-mechanisms-all/practical-example-stock-deduction-2.png)



> 출처: [Baeldung - Pessimistic Locking in JPA](https://www.baeldung.com/jpa-pessimistic-locking), [Vlad Mihalcea - How does MVCC work](https://vladmihalcea.com/how-does-mvcc-multi-version-concurrency-control-work/)

### 3.2 MongoDB의 재미있는 락 메커니즘

MongoDB는 MySQL과 완전히 다른 방식으로 락을 관리한다.

#### Intent Locks (의도 락)

MongoDB는 **계층적 락** 구조를 사용한다.

![](/uploads/theory/lock-mechanisms-all/intent-locks-intent-lock.png)


**Intent Lock의 종류:**
- **IS (Intent Shared)**: 하위 레벨에서 S-Lock을 획득할 의도
- **IX (Intent Exclusive)**: 하위 레벨에서 X-Lock을 획득할 의도

```javascript
// 예시: 도큐먼트 업데이트
db.users.updateOne(
    { _id: ObjectId("...") },
    { $set: { name: "Kim" } }
)

// 락 획득 순서:
// 1. 글로벌: IS (Intent Shared)
// 2. 데이터베이스: IX (Intent Exclusive)
// 3. 컬렉션: IX (Intent Exclusive)
// 4. 도큐먼트: X (Exclusive)
```

**왜 Intent Lock이 필요할까?**

Intent Lock 없이 글로벌 X-Lock을 확인하려면:
```
글로벌 X-Lock을 걸려면:
→ 모든 데이터베이스 확인
  → 모든 컬렉션 확인
    → 모든 도큐먼트 확인 (수백만 개!)

→ 너무 느림!
```

Intent Lock 사용 시:
```
글로벌 X-Lock을 걸려면:
→ 글로벌의 Intent Lock만 확인
→ IS나 IX가 있으면 대기
→ 없으면 즉시 획득

→ 빠름!
```

> 출처: [MongoDB Documentation - FAQ Concurrency](https://www.mongodb.com/docs/manual/faq/concurrency/), [MongoDB - Locking](https://www.mongodb.com/docs/v4.2/reference/glossary/#term-lock)

#### Collection-level vs Document-level Locking

**MongoDB 3.0 이전: Collection-level Lock**
```javascript
// 트랜잭션 A
db.users.updateOne({ _id: 1 }, { $set: { name: "Kim" } })
// → 전체 users 컬렉션에 X-Lock!

// 트랜잭션 B
db.users.updateOne({ _id: 2 }, { $set: { name: "Lee" } })
// → 대기 (같은 컬렉션)
```

**MongoDB 3.0+: Document-level Lock (WiredTiger)**
```javascript
// 트랜잭션 A
db.users.updateOne({ _id: 1 }, { $set: { name: "Kim" } })
// → 도큐먼트 1에만 X-Lock

// 트랜잭션 B
db.users.updateOne({ _id: 2 }, { $set: { name: "Lee" } })
// → 도큐먼트 2에 X-Lock (동시 실행 가능!)
```

**성능 비교:**
```
10,000개 도큐먼트 동시 업데이트:

Collection-level Lock: 순차 실행 → 10초
Document-level Lock: 병렬 실행 → 0.5초
```

> 출처: [MongoDB WiredTiger Concurrency](https://source.wiredtiger.com/develop/arch-transaction.html)

### 3.3 낙관적 락 (Optimistic Lock) vs 비관적 락 (Pessimistic Lock)

#### 비관적 락: "충돌이 자주 일어날 것이다"

```java
// JPA Pessimistic Lock
@Lock(LockModeType.PESSIMISTIC_WRITE)
@Query("SELECT p FROM Product p WHERE p.id = :id")
Product findByIdWithPessimisticLock(@Param("id") Long id);

@Transactional
public void updateStock(Long productId, int quantity) {
    Product product = productRepository.findByIdWithPessimisticLock(productId);
    // 여기서 Exclusive Lock이 걸림
    // 다른 트랜잭션은 대기

    product.decreaseStock(quantity);
    productRepository.save(product);
    // 커밋 시 락 해제
}
```

**SQL:**
```sql
SELECT * FROM product WHERE id = 1 FOR UPDATE;
-- 다른 트랜잭션은 이 row를 읽거나 쓸 수 없음
```

#### 낙관적 락: "충돌이 거의 없을 것이다"

```java
@Entity
public class Product {
    @Id
    private Long id;

    private String name;
    private int stock;

    @Version  // 낙관적 락용 버전 컬럼
    private Long version;
}

@Transactional
public void updateStock(Long productId, int quantity) {
    Product product = productRepository.findById(productId);
    // 락 없이 읽기
    // version = 1

    product.decreaseStock(quantity);
    productRepository.save(product);
    // UPDATE product SET stock = ?, version = version + 1
    //  WHERE id = ? AND version = 1
}
```

**동작 과정:**
![](/uploads/theory/lock-mechanisms-all/optimistic-lock.png)


**재시도 로직:**
```java
@Transactional
public void updateStockWithRetry(Long productId, int quantity) {
    int maxRetries = 3;
    int attempt = 0;

    while (attempt < maxRetries) {
        try {
            Product product = productRepository.findById(productId);
            product.decreaseStock(quantity);
            productRepository.save(product);
            return;  // 성공
        } catch (OptimisticLockException e) {
            attempt++;
            if (attempt >= maxRetries) {
                throw new RuntimeException("재고 업데이트 실패: 동시성 충돌");
            }
            // 잠시 대기 후 재시도
            Thread.sleep(100);
        }
    }
}
```

#### 낙관적 락 vs 비관적 락 비교

| 비교 항목 | 낙관적 락 | 비관적 락 |
|---------|---------|---------|
| **락 획득 시점** | 커밋 시 (version 체크) | 조회 시 (SELECT FOR UPDATE) |
| **충돌 감지** | 커밋 시 | 락 획득 시 |
| **성능 (충돌 적음)** | 빠름 (락 없음) | 느림 (대기) |
| **성능 (충돌 많음)** | 느림 (재시도 많음) | 빠름 (순차 처리) |
| **데드락** | 없음 | 가능 |
| **적합한 경우** | 읽기 많고 쓰기 적음 | 쓰기 많고 충돌 빈번 |
| **예시** | 게시글 조회수 증가 | 은행 계좌 이체, 재고 차감 |

> 출처: [Baeldung - JPA Optimistic Locking](https://www.baeldung.com/jpa-optimistic-locking), [Vlad Mihalcea - Optimistic vs Pessimistic Locking](https://vladmihalcea.com/optimistic-vs-pessimistic-locking/)

## 4. 분산 락 (Distributed Lock)

### 4.1 왜 분산 락이 필요한가?

마이크로서비스 환경에서는 **여러 인스턴스**가 동시에 실행된다.


![](/uploads/theory/lock-mechanisms-all/41-why-distributed-lock-needed.png)



**문제:**
```java
// 서버 A
@Transactional
public void processCoupon(String couponCode) {
    Coupon coupon = couponRepository.findByCode(couponCode);
    if (coupon.getUsageCount() < coupon.getMaxUsage()) {
        coupon.incrementUsage();  // 사용 횟수 증가
        couponRepository.save(coupon);
    }
}

// 서버 B (동시 실행)
@Transactional
public void processCoupon(String couponCode) {
    Coupon coupon = couponRepository.findByCode(couponCode);
    if (coupon.getUsageCount() < couponMaxUsage()) {
        coupon.incrementUsage();  // 중복 사용!
        couponRepository.save(coupon);
    }
}
```

DB 락으로는 **다른 서버 인스턴스**를 막을 수 없다. **분산 락**이 필요하다!

> 출처: [Martin Kleppmann - How to do distributed locking](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html)

### 4.2 Redis를 이용한 분산 락

#### 기본 구현

```java
@Component
public class RedisLockService {

    @Autowired
    private RedisTemplate<String, String> redisTemplate;

    public boolean tryLock(String key, String value, long timeoutSeconds) {
        // SET key value NX EX timeout
        // NX: key가 없을 때만 설정 (원자적)
        // EX: 만료 시간 설정 (초 단위)
        return redisTemplate.opsForValue()
            .setIfAbsent(key, value, timeoutSeconds, TimeUnit.SECONDS);
    }

    public void unlock(String key, String value) {
        // Lua 스크립트로 원자적 삭제
        String script =
            "if redis.call('get', KEYS[1]) == ARGV[1] then " +
            "    return redis.call('del', KEYS[1]) " +
            "else " +
            "    return 0 " +
            "end";

        redisTemplate.execute(
            new DefaultRedisScript<>(script, Long.class),
            Collections.singletonList(key),
            value
        );
    }
}
```

**사용 예시:**
```java
@Service
public class CouponService {

    @Autowired
    private RedisLockService lockService;

    public void processCoupon(String couponCode) {
        String lockKey = "coupon:lock:" + couponCode;
        String lockValue = UUID.randomUUID().toString();

        try {
            // 락 획득 시도 (30초 타임아웃)
            if (lockService.tryLock(lockKey, lockValue, 30)) {
                try {
                    // 임계영역
                    Coupon coupon = couponRepository.findByCode(couponCode);
                    if (coupon.getUsageCount() < coupon.getMaxUsage()) {
                        coupon.incrementUsage();
                        couponRepository.save(coupon);
                    }
                } finally {
                    // 반드시 락 해제
                    lockService.unlock(lockKey, lockValue);
                }
            } else {
                throw new RuntimeException("락 획득 실패: 다른 서버가 처리 중");
            }
        } catch (Exception e) {
            log.error("쿠폰 처리 실패", e);
            throw e;
        }
    }
}
```

**동작 과정:**
![](/uploads/theory/lock-mechanisms-all/basic-impl.png)


> 출처: [Redis Documentation - Distributed locks](https://redis.io/docs/manual/patterns/distributed-locks/), [Baeldung - Distributed Lock with Redis](https://www.baeldung.com/spring-redis-distributed-lock)

#### Redisson을 이용한 고급 락

> **핵심 요약:** Redisson은 Redis 기반의 락에 자동 갱신, 재진입, 공정성 등 고급 기능을 추가한 라이브러리입니다.

기본 Redis 락은 다음과 같은 한계가 있습니다:
- 락 만료 시간을 정확히 예측하기 어려움
- 작업이 길어지면 락이 먼저 만료될 수 있음
- 스핀락 방식으로 Redis에 부하 발생

Redisson의 **고급 락**은 이런 문제를 해결합니다:
- **자동 갱신(Watchdog)**: 작업이 진행 중이면 락 만료 시간을 자동으로 연장
- **재진입 가능(Reentrant)**: 같은 스레드가 락을 여러 번 획득 가능
- **Pub/Sub 대기**: 스핀락 대신 효율적인 이벤트 기반 대기

```java
@Configuration
public class RedissonConfig {

    @Bean
    public RedissonClient redissonClient() {
        Config config = new Config();
        config.useSingleServer()
            .setAddress("redis://localhost:6379");
        return Redisson.create(config);
    }
}

@Service
public class CouponService {

    @Autowired
    private RedissonClient redissonClient;

    public void processCoupon(String couponCode) {
        RLock lock = redissonClient.getLock("coupon:lock:" + couponCode);

        try {
            // 락 획득 시도 (대기 10초, 해제 30초)
            if (lock.tryLock(10, 30, TimeUnit.SECONDS)) {
                try {
                    // 임계영역
                    Coupon coupon = couponRepository.findByCode(couponCode);
                    if (coupon.getUsageCount() < coupon.getMaxUsage()) {
                        coupon.incrementUsage();
                        couponRepository.save(coupon);
                    }
                } finally {
                    lock.unlock();
                }
            } else {
                throw new RuntimeException("락 획득 타임아웃");
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new RuntimeException("락 획득 중단", e);
        }
    }
}
```

**Redisson의 장점:**
1. **자동 갱신**: 임계영역이 오래 걸리면 락 자동 연장
2. **재진입 가능**: 같은 스레드가 여러 번 락 획득 가능
3. **공정성**: 대기 순서대로 락 획득
4. **Redlock 지원**: 여러 Redis 인스턴스에 분산 락

> 출처: [Redisson Documentation](https://github.com/redisson/redisson/wiki/8.-Distributed-locks-and-synchronizers), [Baeldung - Guide to Redisson](https://www.baeldung.com/redis-redisson)

### 4.3 Redlock 알고리즘

단일 Redis 인스턴스는 **SPOF (Single Point of Failure)** 문제가 있다.

```
Redis 인스턴스 다운 → 모든 락 사라짐!
```

**Redlock**: 여러 Redis 인스턴스에 분산 락을 획득한다.

![](/uploads/theory/lock-mechanisms-all/43-redlock-algorithm.png)


**알고리즘:**
![](/uploads/theory/lock-mechanisms-all/43-redlock-algorithm-2.png)

```java
// Redisson Redlock 사용
@Service
public class CouponService {

    @Autowired
    private RedissonClient redisson1;
    @Autowired
    private RedissonClient redisson2;
    @Autowired
    private RedissonClient redisson3;

    public void processCoupon(String couponCode) {
        RLock lock1 = redisson1.getLock("coupon:lock:" + couponCode);
        RLock lock2 = redisson2.getLock("coupon:lock:" + couponCode);
        RLock lock3 = redisson3.getLock("coupon:lock:" + couponCode);

        // RedLock: 3개 중 2개 이상 획득해야 성공
        RedissonRedLock redLock = new RedissonRedLock(lock1, lock2, lock3);

        try {
            if (redLock.tryLock(10, 30, TimeUnit.SECONDS)) {
                try {
                    // 임계영역
                    processCouponInternal(couponCode);
                } finally {
                    redLock.unlock();
                }
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
```

**장점:**
- Redis 1개가 다운되어도 락 유지
- 과반수만 살아있으면 작동

**단점:**
- 네트워크 지연으로 인한 복잡성
- 시계 동기화 문제 (NTP)
- 성능 오버헤드

> 출처: [Redis Redlock](https://redis.io/docs/manual/patterns/distributed-locks/#the-redlock-algorithm), [Antirez - Is Redlock safe?](http://antirez.com/news/101), [Martin Kleppmann - Redlock criticism](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html)

## 5. 락의 문제점과 해결 방법

### 5.1 데드락 (Deadlock)

#### 발생 조건

```java
// 데드락 발생 예제
class BankAccount {
    private Lock lock = new ReentrantLock();
    private int balance;

    public void transfer(BankAccount target, int amount) {
        this.lock.lock();
        try {
            target.lock.lock();  // 데드락 가능!
            try {
                this.balance -= amount;
                target.balance += amount;
            } finally {
                target.lock.unlock();
            }
        } finally {
            this.lock.unlock();
        }
    }
}

// 사용
BankAccount accountA = new BankAccount(1000);
BankAccount accountB = new BankAccount(1000);

// 스레드 1
accountA.transfer(accountB, 100);  // A락 → B락 대기

// 스레드 2 (동시 실행)
accountB.transfer(accountA, 200);  // B락 → A락 대기

// 데드락!
```

**동작 과정:**
![](/uploads/theory/lock-mechanisms-all/occurrence-condition.png)


#### 해결 방법 1: 락 순서 지정

```java
class BankAccount {
    private final long id;
    private Lock lock = new ReentrantLock();
    private int balance;

    public void transfer(BankAccount target, int amount) {
        // 항상 작은 ID부터 락 획득
        BankAccount first = this.id < target.id ? this : target;
        BankAccount second = this.id < target.id ? target : this;

        first.lock.lock();
        try {
            second.lock.lock();
            try {
                this.balance -= amount;
                target.balance += amount;
            } finally {
                second.lock.unlock();
            }
        } finally {
            first.lock.unlock();
        }
    }
}
```

#### 해결 방법 2: tryLock 사용

```java
public boolean transfer(BankAccount target, int amount) {
    if (this.lock.tryLock()) {
        try {
            if (target.lock.tryLock()) {
                try {
                    this.balance -= amount;
                    target.balance += amount;
                    return true;
                } finally {
                    target.lock.unlock();
                }
            }
        } finally {
            this.lock.unlock();
        }
    }
    return false;  // 실패 시 재시도
}
```

> 출처: [Wikipedia - Deadlock](https://en.wikipedia.org/wiki/Deadlock), [GeeksforGeeks - Deadlock Prevention](https://www.geeksforgeeks.org/deadlock-prevention/)

### 5.2 락 누수 (Lock Leak)

```java
// 잘못된 코드: 락 해제 누락
public void badMethod() {
    lock.lock();

    if (someCondition) {
        return;  // 락 해제 안 됨!
    }

    doSomething();
    lock.unlock();
}

// 올바른 코드: finally 사용
public void goodMethod() {
    lock.lock();
    try {
        if (someCondition) {
            return;  // finally에서 해제됨
        }
        doSomething();
    } finally {
        lock.unlock();  // 항상 실행됨
    }
}
```

> 출처: [Java Documentation - Lock](https://docs.oracle.com/javase/8/docs/api/java/util/concurrent/locks/Lock.html), [Baeldung - Guide to java.util.concurrent.Locks](https://www.baeldung.com/java-concurrent-locks)

### 5.3 우선순위 역전 (Priority Inversion)

이미 [세마포어와 뮤텍스](https://velog.io/@dj258255/%EC%84%B8%EB%A7%88%ED%8F%AC%EC%96%B4%EC%99%80-%EB%AE%A4%ED%85%8D%EC%8A%A4-%EB%8F%99%EA%B8%B0%ED%99%94-%EB%A9%94%EC%BB%A4%EB%8B%88%EC%A6%98%EC%9D%98-%EC%9D%B4%ED%95%B4)에서 다룬 내용이므로 간단히 요약:

![](/uploads/theory/lock-mechanisms-all/53-priority-inversion-priority-inversion.png)


**해결: Priority Inheritance** (우선순위 상속)

> 출처: [Wikipedia - Priority Inversion](https://en.wikipedia.org/wiki/Priority_inversion)

## 6. 실무 사례: 한국 IT 기업의 락 구현

### 6.1 하이퍼커넥트: Redis 분산 락과 성능 최적화

하이퍼커넥트의 아자르 API팀은 전 세계 트래픽을 받는 멀티 서버 환경에서 분산 락을 구현했다.

#### 문제 상황

단일 서버의 로컬 락으로는 여러 서버 간 동기화를 보장할 수 없었다. "공통된 저장소를 이용하여 자원이 사용 중인지 체크"하는 분산 락이 필수적이었다.

#### 초기 구현의 3가지 문제점

**1. 타임아웃 부재**
```java
// 잘못된 구현
public void processWithLock(String key) {
    while (!tryLock(key)) {
        // 무한 대기 가능!
    }
    try {
        doSomething();
    } finally {
        unlock(key);
    }
}
```

어플리케이션 오류로 락을 해제하지 못하면 다른 모든 서버가 **무한 대기** 상태에 빠진다.

**2. 무한 스핀락의 비효율성**

성능 분석:
```
작업 시간: 300ms
동시 요청: 100개
락 요청 시도: 594회
초당 Redis 요청: 2000회

→ Redis 과부하!
```

**3. try-finally 구조의 오류**
```java
// 잘못된 코드
boolean locked = tryLock(key);
try {
    if (locked) {
        doSomething();
    }
} finally {
    unlock(key);  // locked == false일 때도 실행!
}
```

락 획득 실패 시에도 finally에서 락을 해제하여 동기화가 깨진다.

#### Redisson의 3가지 핵심 솔루션

**1. 타임아웃 설정**
```java
RLock lock = redissonClient.getLock("myLock");

// waitTime: 락 획득을 대기할 최대 시간
// leaseTime: 락이 자동으로 만료되는 시간
if (lock.tryLock(10, 30, TimeUnit.SECONDS)) {
    try {
        doSomething();
    } finally {
        lock.unlock();
    }
} else {
    throw new RuntimeException("락 획득 실패");
}
```

어플리케이션 장애 시에도 `leaseTime` 후 자동으로 락이 해제된다.

**2. Pub/Sub 기반 알림**

스핀락 대신 **Pub/Sub** 메커니즘 사용:


**기존 스핀락**

![](/uploads/theory/lock-mechanisms-all/redisson-3.png)


**[Redisson Pub/Sub 방식]**

![](/uploads/theory/lock-mechanisms-all/redisson-3-2.png)


**성능 개선:**
```
기존: 초당 2000회 Redis 요청
Pub/Sub: 초당 2회 Redis 요청 (1000배 감소!)
```

**3. Lua 스크립트로 원자성 보장**

여러 Redis 명령을 **하나의 원자적 연산**으로 실행:

```lua
-- Redisson의 락 획득 Lua 스크립트
if (redis.call('exists', KEYS[1]) == 0) then
    redis.call('hset', KEYS[1], ARGV[2], 1);
    redis.call('pexpire', KEYS[1], ARGV[1]);
    return nil;
end;
if (redis.call('hexists', KEYS[1], ARGV[2]) == 1) then
    redis.call('hincrby', KEYS[1], ARGV[2], 1);
    redis.call('pexpire', KEYS[1], ARGV[1]);
    return nil;
end;
return redis.call('pttl', KEYS[1]);
```

**효과:**
- 존재 확인 + 설정 + 만료 시간 설정이 **한 번에** 실행
- 레이스 컨디션 방지
- Redis 요청 횟수 감소

#### 성능 최적화 결과

**Redisson의 락 획득 프로세스:**

![](/uploads/theory/lock-mechanisms-all/optimization.png)


**핵심 교훈:**
> Redis의 고급 기능(Lua, Pub/Sub)을 활용하면 어플리케이션 레벨 스핀락보다 훨씬 효율적인 분산 락을 구현할 수 있다.

> 출처: [하이퍼커넥트 - 레디스와 분산 락(1/2)](https://hyperconnect.github.io/2019/11/15/redis-distributed-lock-1.html)

### 6.2 컬리: Redisson 분산락으로 재고 관리

컬리의 풀필먼트 입고 서비스팀은 입고관리 시스템(RMS)에서 발생한 동시성 문제를 Redisson으로 해결했다.

#### 발생한 동시성 문제

**1. 중복 발주 수신**
```java
// 카프카로 동시에 들어오는 중복된 발주를 수신
// → 동일한 발주가 여러 번 등록됨
```

**2. 중복 요청**
```java
// 검수/검품 이슈 등록 시:
// - 더블 클릭
// - 네트워크 지연으로 인한 재시도
// → 중복 이슈 생성
```

**3. 동시 버튼 클릭**
```java
// 여러 작업자가 동시에 버튼 클릭
// → 잘못된 재고 트랜잭션 생성
```

**문제점:**
- 단일 인스턴스 레벨의 예외 처리만으로는 부족
- 멀티 인스턴스 환경에서 공통 락 필요

#### Redisson vs Lettuce 선택

| 비교 항목 | Lettuce | Redisson |
|---------|---------|----------|
| **구현 방식** | 직접 SETNX/SETEX 구현 | Lock 인터페이스 제공 |
| **대기 방식** | 스핀락 (계속 요청) | Pub/Sub (알림 대기) |
| **Redis 부하** | 높음 | 낮음 |
| **구현 복잡도** | 높음 | 낮음 |

**선택 이유:**
- 기존 기술 스택(Redis) 활용 → 추가 인프라 불필요
- Pub/Sub 방식으로 효율적 처리
- Lock 인터페이스로 간편한 사용

#### 구현: 어노테이션 기반 AOP

**핵심 아키텍처:**

```java
// 1. 어노테이션 정의
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
public @interface DistributedLock {
    String key();           // 락 이름 (SpEL 지원)
    long waitTime();        // 대기 시간 (초)
    long leaseTime();       // 임차 시간 (초)
    TimeUnit timeUnit() default TimeUnit.SECONDS;
}

// 2. 사용 예시
@DistributedLock(key = "#lockName", waitTime = 5, leaseTime = 3)
public void shipment(String lockName) {
    // 비즈니스 로직
    // lockName 값이 락 키로 사용됨 (예: "order:12345")
}
```

**AOP 구현:**

```java
@Aspect
@Component
public class DistributedLockAop {
    private final RedissonClient redissonClient;
    private final AopForTransaction aopForTransaction;

    @Around("@annotation(distributedLock)")
    public Object lock(ProceedingJoinPoint joinPoint,
                       DistributedLock distributedLock) throws Throwable {

        // SpEL로 동적 락 키 생성
        String key = CustomSpringELParser.getDynamicValue(
            joinPoint.getSignature(),
            joinPoint.getArgs(),
            distributedLock.key()
        );

        RLock lock = redissonClient.getLock(key);

        try {
            // 락 획득 시도
            boolean available = lock.tryLock(
                distributedLock.waitTime(),
                distributedLock.leaseTime(),
                distributedLock.timeUnit()
            );

            if (!available) {
                throw new InterruptedException("락 획득 실패: " + key);
            }

            // 트랜잭션과 락을 함께 처리
            return aopForTransaction.proceed(joinPoint);

        } catch (InterruptedException e) {
            throw new RuntimeException("락 획득 중단", e);
        } finally {
            // 락 소유자인 경우에만 해제
            if (lock.isHeldByCurrentThread()) {
                lock.unlock();
            }
        }
    }
}
```

**트랜잭션 처리:**

```java
@Component
public class AopForTransaction {

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public Object proceed(ProceedingJoinPoint joinPoint) throws Throwable {
        return joinPoint.proceed();
    }
}
```

**핵심: "트랜잭션 커밋 이후 락 해제"**

올바른 방법 (트랜잭션 커밋 후 락 해제)
![](/uploads/theory/lock-mechanisms-all/impl-aop.png)

잘못된 방법 (트랜잭션 커밋 전 락 해제)
![](/uploads/theory/lock-mechanisms-all/impl-aop-2.png)


#### 적용 결과: 테스트 검증

**쿠폰 차감 테스트:**
```java
초기 쿠폰: 100개
동시 요청: 100명

[분산락 미적용]
최종 쿠폰: 21개 (79개만 차감, 21개 중복 차감 실패)

[분산락 적용]
최종 쿠폰: 0개 (정확히 100개 차감)
```

**중복 발주 테스트:**
```java
동일 발주 10건 동시 수신

[분산락 미적용]
등록된 발주: 3~5건 (중복 등록)

[분산락 적용]
등록된 발주: 1건 (정확!)
```

#### 개발 생산성 향상

**Before: 복잡한 락 코드**
```java
public void processOrder(String orderId) {
    RLock lock = redissonClient.getLock("order:" + orderId);
    try {
        if (lock.tryLock(10, 30, TimeUnit.SECONDS)) {
            try {
                // 비즈니스 로직
                validateOrder(orderId);
                updateStock(orderId);
                createShipment(orderId);
            } finally {
                lock.unlock();
            }
        } else {
            throw new RuntimeException("락 획득 실패");
        }
    } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
        throw new RuntimeException(e);
    }
}
```

**After: 간결한 어노테이션**
```java
@DistributedLock(key = "'order:' + #orderId", waitTime = 10, leaseTime = 30)
public void processOrder(String orderId) {
    // 비즈니스 로직만 집중!
    validateOrder(orderId);
    updateStock(orderId);
    createShipment(orderId);
}
```

**효과:**
- 비즈니스 로직과 락 처리 **완전 분리**
- 코드 가독성 대폭 향상
- 재사용 가능한 공통 컴포넌트화

> 출처: [컬리 기술 블로그 - 풀필먼트 입고 서비스팀에서 분산락을 사용하는 방법](https://helloworld.kurly.com/blog/distributed-redisson-lock/)

### 6.3 우아한형제들: WMS 재고 이관 분산 락

우아한형제들은 WMS(Warehouse Management System) 재고 이관 과정에서 분산 락을 사용했다.

#### 문제 상황

여러 프로세스가 동일한 자원(재고)에 접근할 때 충돌이 발생했다. 분산 환경에서 데이터 정합성을 유지하기 위해 분산 락이 필수적이었다.

#### 해결 방법

Redis 기반 분산 락을 구현하여:
- 여러 서버가 동시에 재고를 수정하는 것을 방지
- 트랜잭션 기반 재고 사용 관리
- 데이터 정합성 보장

**핵심 아키텍처:**
- RDB에 전체 재고 저장
- Redis의 빠른 인메모리 DB로 트랜잭션 기반 재고 사용 관리
- Redis Set 자료구조 활용 (구매 번호 저장, 중복 불가)
- 거래 시점에 RDB와 동기화하여 데이터 손실 방지

#### 시스템 안정성 향상

분산 락 도입으로:
- 재고 충돌 방지
- 시스템 안정성 대폭 향상
- 데이터 정합성 보장

> 출처: [우아한형제들 - WMS 재고 이관을 위한 분산 락 사용기](https://techblog.woowahan.com/17416/), [우아한형제들 - 선물하기 시스템의 상품 재고 관리](https://techblog.woowahan.com/2709/)

## 정리

락 메커니즘은 여러 레벨에서 작동한다:

**1. 하드웨어 락**
- Test-and-Set, CAS
- 메모리 장벽 (volatile)
- 가장 낮은 레벨, 가장 빠름

**2. OS 락**
- 스핀락: 바쁜 대기, 짧은 임계영역
- 뮤텍스/세마포어: 잠들기, 긴 임계영역

**3. 데이터베이스 락**
- MySQL: Shared Lock, Exclusive Lock
- MongoDB: Intent Lock, Document-level Lock
- 낙관적 락 vs 비관적 락

**4. 분산 락**
- Redis 분산 락
- Redisson, Redlock
- 마이크로서비스 환경

**선택 기준:**
- **임계영역 길이**: 짧으면 스핀락, 길면 뮤텍스
- **충돌 빈도**: 낮으면 낙관적 락, 높으면 비관적 락
- **분산 환경**: Redis 분산 락, Redlock
- **성능 vs 안정성**: 트레이드오프 고려

## 참고 자료

### 공식 문서
- [Java Documentation - synchronized](https://docs.oracle.com/javase/tutorial/essential/concurrency/sync.html) - Java 동기화
- [Java Documentation - AtomicInteger](https://docs.oracle.com/javase/8/docs/api/java/util/concurrent/atomic/AtomicInteger.html) - Java Atomic 클래스
- [MySQL Documentation - InnoDB Locking](https://dev.mysql.com/doc/refman/8.0/en/innodb-locking.html) - MySQL InnoDB 락 메커니즘
- [MongoDB Manual - Locking](https://www.mongodb.com/docs/manual/reference/glossary/#std-term-lock) - MongoDB 락 용어
- [Redisson Documentation - Locks and Synchronizers](https://redisson.pro/docs/data-and-services/locks-and-synchronizers/) - Redisson 분산 락 가이드

### 이론 및 학술 자료
- [Wikipedia - Lock (computer science)](https://en.wikipedia.org/wiki/Lock_(computer_science)) - 락의 기본 개념과 종류
- [Wikipedia - Test-and-Set](https://en.wikipedia.org/wiki/Test-and-set) - TAS 원자 명령어
- [Wikipedia - Compare-and-Swap](https://en.wikipedia.org/wiki/Compare-and-swap) - CAS 원자 명령어
- [Wikipedia - Memory Barrier](https://en.wikipedia.org/wiki/Memory_barrier) - 메모리 장벽과 순서 보장
- [Wikipedia - Spinlock](https://en.wikipedia.org/wiki/Spinlock) - 스핀락 동작 원리
- [Wikipedia - Deadlock](https://en.wikipedia.org/wiki/Deadlock) - 데드락의 4가지 조건
- [Wikipedia - Priority Inversion](https://en.wikipedia.org/wiki/Priority_inversion) - 우선순위 역전 문제

### 기술 자료
- [GeeksforGeeks - Lock Variable Synchronization](https://www.geeksforgeeks.org/lock-variable-synchronization-mechanism/) - 락 변수 동기화 메커니즘
- [GeeksforGeeks - Spinlock vs Semaphore](https://www.geeksforgeeks.org/spinlock-vs-semaphore/) - 스핀락과 세마포어 비교
- [GeeksforGeeks - Deadlock Prevention](https://www.geeksforgeeks.org/deadlock-prevention/) - 데드락 예방 기법
- [Baeldung - Compare and Swap in Java](https://www.baeldung.com/java-compare-and-swap) - Java에서 CAS 사용하기
- [Baeldung - Guide to the Volatile Keyword](https://www.baeldung.com/java-volatile) - Java volatile 키워드 가이드
- [Baeldung - JPA Pessimistic Locking](https://www.baeldung.com/jpa-pessimistic-locking) - JPA 비관적 락 사용법
- [Baeldung - JPA Optimistic Locking](https://www.baeldung.com/jpa-optimistic-locking) - JPA 낙관적 락과 버전 관리

### 데이터베이스 전문가
- [Vlad Mihalcea - MVCC (Multi-Version Concurrency Control)](https://vladmihalcea.com/how-does-mvcc-multi-version-concurrency-control-work/) - MVCC 동작 원리와 PostgreSQL 구현
- [Vlad Mihalcea - Optimistic vs Pessimistic Locking](https://vladmihalcea.com/optimistic-vs-pessimistic-locking/) - 낙관적 락과 비관적 락 비교

### 분산 시스템
- [Martin Kleppmann - How to do distributed locking](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html) - Redlock 알고리즘 비판과 fencing token
- [Antirez - Is Redlock safe?](http://antirez.com/news/101) - Redis 창시자의 Redlock 방어 논문

### 한국 기술 블로그
- [우아한형제들 - WMS 재고 이관을 위한 분산 락 사용기](https://techblog.woowahan.com/17416/) - Redis 기반 분산 락으로 재고 관리 동시성 제어
- [우아한형제들 - 선물하기 시스템의 상품 재고 관리](https://techblog.woowahan.com/2709/) - Redis Set을 활용한 재고 관리와 데이터 정합성
- [하이퍼커넥트 - 레디스와 분산 락(1/2)](https://hyperconnect.github.io/2019/11/15/redis-distributed-lock-1.html) - Redisson Pub/Sub과 Lua 스크립트를 활용한 성능 최적화
- [컬리 - 풀필먼트 입고 서비스팀에서 분산락을 사용하는 방법](https://helloworld.kurly.com/blog/distributed-redisson-lock/) - Redisson AOP 어노테이션 기반 분산락 구현

<!-- EN -->

## Introduction

When developing applications, you encounter the term "Lock" in many different contexts. Java's `synchronized`, database `SELECT FOR UPDATE`, Redis distributed locks... They are all called "locks," but they operate at completely different levels and in completely different ways.

In this article, we will cover the full spectrum of lock mechanisms, from **Hardware Locks** through **OS Locks**, **Application Locks**, **Database Locks**, to **Distributed Locks**.

> Source: [GeeksforGeeks - Introduction to Lock](https://www.geeksforgeeks.org/lock-variable-synchronization-mechanism/)

## 1. Hardware Lock

> **Key Takeaway:** Software alone cannot guarantee true atomicity, which is why CPU-provided atomic instructions are necessary.

### 1.1 Why Do We Need Hardware Support?

Software alone cannot guarantee **atomicity**. Let's look at the simplest example.

```java
// Attempting to implement a lock in software (incorrect approach)
class BrokenLock {
    private boolean locked = false;

    public void lock() {
        // Problem: This code is NOT atomic!
        while (locked) {
            // wait
        }
        locked = true;  // Multiple threads can execute this simultaneously!
    }

    public void unlock() {
        locked = false;
    }
}
```

**The Problem:**
![](/uploads/theory/lock-mechanisms-all/11-why-hardware-help-needed.png)


Two threads simultaneously check that `locked == false` and both acquire the lock. To solve this, we need **hardware support**.

> Source: [Wikipedia - Lock (computer science)](https://en.wikipedia.org/wiki/Lock_(computer_science)), [Embedded - Implementing Locks](https://www.embedded.com/implementing-a-lock/)

### 1.2 Test-and-Set (TAS)

> **Key Takeaway:** Reads and sets a value as a single atomic instruction.

This is the simplest hardware atomic instruction.

```c
// Atomic instruction provided by hardware
bool test_and_set(bool *target) {
    bool old_value = *target;
    *target = true;
    return old_value;
    // These three lines execute atomically (cannot be interrupted)
}
```

**Usage Example:**
```c
class TASLock {
    bool locked = false;

    void lock() {
        // Repeat until old_value is false (lock acquisition success)
        while (test_and_set(&locked)) {
            // busy waiting
        }
    }

    void unlock() {
        locked = false;
    }
}
```

**How It Works:**
![](/uploads/theory/lock-mechanisms-all/12-test-and-set-tas.png)


> Source: [Wikipedia - Test-and-Set](https://en.wikipedia.org/wiki/Test-and-set)

### 1.3 Compare-and-Swap (CAS)

> **Key Takeaway:** An atomic operation that compares the expected value with the actual value and replaces it with a new value if they match.

This is a more powerful atomic instruction provided by modern processors.

```c
// Hardware CAS instruction
bool compare_and_swap(int *ptr, int expected, int new_value) {
    int actual = *ptr;
    if (actual == expected) {
        *ptr = new_value;
        return true;
    }
    return false;
    // This entire process executes atomically
}
```

**CAS in Java:**
```java
import java.util.concurrent.atomic.AtomicInteger;

class CASExample {
    private AtomicInteger value = new AtomicInteger(0);

    public void increment() {
        int oldValue, newValue;
        do {
            oldValue = value.get();
            newValue = oldValue + 1;
        } while (!value.compareAndSet(oldValue, newValue));
        // Retry on CAS failure (optimistic approach)
    }
}
```

**How It Works:**
![](/uploads/theory/lock-mechanisms-all/13-compare-and-swap-cas.png)



**Advantages of CAS:**
- **Lock-free**: Concurrency control without locks
- **Performance**: Faster than locks (retries instead of waiting)
- **No deadlock**: Since no locks are used

**Disadvantages of CAS:**
- **ABA Problem**: Cannot detect changes from A to B and back to A
- **Spin Overhead**: Wastes CPU when retries are frequent

> Source: [Wikipedia - Compare-and-Swap](https://en.wikipedia.org/wiki/Compare-and-swap), [Baeldung - Compare and Swap in Java](https://www.baeldung.com/java-compare-and-swap), [Oracle - AtomicInteger](https://docs.oracle.com/javase/8/docs/api/java/util/concurrent/atomic/AtomicInteger.html)

### 1.4 Memory Barrier

In multi-core CPUs, each core has its **own cache**, which can cause memory consistency issues.

```java
class Singleton {
    private static Singleton instance;

    // Incorrect implementation (Double-Checked Locking issue)
    public static Singleton getInstance() {
        if (instance == null) {  // 1. First check
            synchronized (Singleton.class) {
                if (instance == null) {  // 2. Second check
                    instance = new Singleton();  // Problem point!
                }
            }
        }
        return instance;
    }
}
```

**The Problem:**
![](/uploads/theory/lock-mechanisms-all/14-memory-barrier-memory-barrier.png)


**Solution: volatile Keyword (Memory Barrier)**
```java
class Singleton {
    // volatile: bypass cache, always read/write from main memory
    private static volatile Singleton instance;

    public static Singleton getInstance() {
        if (instance == null) {
            synchronized (Singleton.class) {
                if (instance == null) {
                    instance = new Singleton();
                    // volatile acts as a memory barrier
                    // → instance is assigned only after the constructor completes fully
                }
            }
        }
        return instance;
    }
}
```

**Role of volatile:**
1. **Visibility**: All threads see the latest value
2. **Ordering**: Prevents instruction reordering

> Source: [Wikipedia - Memory Barrier](https://en.wikipedia.org/wiki/Memory_barrier), [Baeldung - Guide to the Volatile Keyword](https://www.baeldung.com/java-volatile), [Java Language Specification - volatile](https://docs.oracle.com/javase/specs/jls/se8/html/jls-8.html#jls-8.3.1.4)

## 2. Spinlock

### 2.1 What Is a Spinlock?

A spinlock **keeps checking** until the lock is acquired.

```java
class Spinlock {
    private AtomicBoolean locked = new AtomicBoolean(false);

    public void lock() {
        // Keep trying until the lock is acquired (busy waiting)
        while (!locked.compareAndSet(false, true)) {
            // Continuously uses the CPU while waiting!
        }
    }

    public void unlock() {
        locked.set(false);
    }
}
```

**How It Works:**
![](/uploads/theory/lock-mechanisms-all/21-spinlock.png)


> Source: [Wikipedia - Spinlock](https://en.wikipedia.org/wiki/Spinlock), [GeeksforGeeks - Spinlock](https://www.geeksforgeeks.org/spinlock-vs-semaphore/)

### 2.2 Spinlock vs Mutex

| Comparison | Spinlock | Mutex |
|---------|-----------------|--------------|
| **Waiting Method** | Busy waiting (keeps using CPU) | Sleep (yields CPU) |
| **Context Switching** | None | Occurs |
| **Best For** | Very short critical sections (microseconds) | Long critical sections (milliseconds or more) |
| **CPU Usage** | High (100% even while waiting) | Low (0% while waiting) |
| **Response Time** | Fast (resumes immediately) | Slow (wake-up time needed) |

**When should you use a spinlock?**
```java
// Good example: Very short critical section
class Counter {
    private Spinlock lock = new Spinlock();
    private int count = 0;

    public void increment() {
        lock.lock();
        count++;  // A single instruction (nanosecond scale)
        lock.unlock();
    }
}

// Bad example: Long critical section
class FileProcessor {
    private Spinlock lock = new Spinlock();

    public void processFile() {
        lock.lock();
        readFromDisk();   // Takes milliseconds
        parseData();      // Takes tens of milliseconds
        writeToDatabase(); // Takes hundreds of milliseconds
        lock.unlock();    // Other threads waste CPU the entire time!
    }
}
```

**Spinlocks in the Linux Kernel:**
```c
// Spinlock as actually used in the Linux kernel
spinlock_t my_lock = SPIN_LOCK_UNLOCKED;

spin_lock(&my_lock);
// Very short critical section (typically tens of nanoseconds)
critical_section();
spin_unlock(&my_lock);
```

> Source: [Linux Kernel Documentation - Spinlock](https://www.kernel.org/doc/html/latest/locking/spinlocks.html), [Baeldung - Spinlock vs Mutex](https://www.baeldung.com/cs/spinlock-vs-mutex)

## 3. Database Lock

### 3.1 MySQL/InnoDB Locks

#### Shared Lock (S-Lock)

Multiple transactions can access data simultaneously in **read-only** mode.

```sql
-- Acquire Shared Lock
SELECT * FROM users WHERE id = 1 LOCK IN SHARE MODE;
```

**Behavior:**
```
Transaction A: SELECT * FROM users WHERE id = 1 LOCK IN SHARE MODE;
  → Acquires Shared Lock

Transaction B: SELECT * FROM users WHERE id = 1 LOCK IN SHARE MODE;
  → Acquires Shared Lock (allowed!)

Transaction C: UPDATE users SET name = 'Kim' WHERE id = 1;
  → Attempts Exclusive Lock → Waits (Shared Lock exists)
```

#### Exclusive Lock (X-Lock)

**Only one transaction** can access the data.

```sql
-- Acquire Exclusive Lock
SELECT * FROM users WHERE id = 1 FOR UPDATE;
```

**Behavior:**
```
Transaction A: SELECT * FROM users WHERE id = 1 FOR UPDATE;
  → Acquires Exclusive Lock

Transaction B: SELECT * FROM users WHERE id = 1 FOR UPDATE;
  → Waits (Exclusive Lock exists)

Transaction C: SELECT * FROM users WHERE id = 1 LOCK IN SHARE MODE;
  → Waits (Exclusive Lock exists)
```

**Lock Compatibility Matrix:**
```
        S-Lock  X-Lock
S-Lock    O       X
X-Lock    X       X

O: Compatible (can be acquired simultaneously)
X: Incompatible (must wait)
```

> Source: [MySQL Documentation - InnoDB Locking](https://dev.mysql.com/doc/refman/8.0/en/innodb-locking.html)

#### Practical Example: Inventory Deduction

```java
@Service
@Transactional
public class OrderService {

    // Incorrect approach: Race condition occurs
    public void createOrderWrong(Long productId, int quantity) {
        Product product = productRepository.findById(productId);

        if (product.getStock() >= quantity) {
            product.decreaseStock(quantity);  // Multiple transactions can execute simultaneously!
            productRepository.save(product);
        }
    }

    // Correct approach: Use Exclusive Lock
    @Query("SELECT p FROM Product p WHERE p.id = :id FOR UPDATE")
    Product findByIdForUpdate(@Param("id") Long id);

    public void createOrderCorrect(Long productId, int quantity) {
        // Block other transactions with Exclusive Lock
        Product product = productRepository.findByIdForUpdate(productId);

        if (product.getStock() >= quantity) {
            product.decreaseStock(quantity);
            productRepository.save(product);
        }
    }
}
```

**Scenarios:**

**Incorrect Approach**

![](/uploads/theory/lock-mechanisms-all/practical-example-stock-deduction.png)

**Correct Approach**

![](/uploads/theory/lock-mechanisms-all/practical-example-stock-deduction-2.png)



> Source: [Baeldung - Pessimistic Locking in JPA](https://www.baeldung.com/jpa-pessimistic-locking), [Vlad Mihalcea - How does MVCC work](https://vladmihalcea.com/how-does-mvcc-multi-version-concurrency-control-work/)

### 3.2 MongoDB's Interesting Lock Mechanism

MongoDB manages locks in a completely different way from MySQL.

#### Intent Locks

MongoDB uses a **hierarchical lock** structure.

![](/uploads/theory/lock-mechanisms-all/intent-locks-intent-lock.png)


**Types of Intent Locks:**
- **IS (Intent Shared)**: Intent to acquire an S-Lock at a lower level
- **IX (Intent Exclusive)**: Intent to acquire an X-Lock at a lower level

```javascript
// Example: Document update
db.users.updateOne(
    { _id: ObjectId("...") },
    { $set: { name: "Kim" } }
)

// Lock acquisition order:
// 1. Global: IS (Intent Shared)
// 2. Database: IX (Intent Exclusive)
// 3. Collection: IX (Intent Exclusive)
// 4. Document: X (Exclusive)
```

**Why Are Intent Locks Needed?**

Without Intent Locks, checking for a global X-Lock would require:
```
To acquire a global X-Lock:
→ Check every database
  → Check every collection
    → Check every document (millions!)

→ Too slow!
```

With Intent Locks:
```
To acquire a global X-Lock:
→ Check only the global Intent Lock
→ If IS or IX exists, wait
→ If none, acquire immediately

→ Fast!
```

> Source: [MongoDB Documentation - FAQ Concurrency](https://www.mongodb.com/docs/manual/faq/concurrency/), [MongoDB - Locking](https://www.mongodb.com/docs/v4.2/reference/glossary/#term-lock)

#### Collection-level vs Document-level Locking

**Before MongoDB 3.0: Collection-level Lock**
```javascript
// Transaction A
db.users.updateOne({ _id: 1 }, { $set: { name: "Kim" } })
// → X-Lock on the entire users collection!

// Transaction B
db.users.updateOne({ _id: 2 }, { $set: { name: "Lee" } })
// → Waits (same collection)
```

**MongoDB 3.0+: Document-level Lock (WiredTiger)**
```javascript
// Transaction A
db.users.updateOne({ _id: 1 }, { $set: { name: "Kim" } })
// → X-Lock only on document 1

// Transaction B
db.users.updateOne({ _id: 2 }, { $set: { name: "Lee" } })
// → X-Lock on document 2 (can execute concurrently!)
```

**Performance Comparison:**
```
10,000 concurrent document updates:

Collection-level Lock: Sequential execution → 10 seconds
Document-level Lock: Parallel execution → 0.5 seconds
```

> Source: [MongoDB WiredTiger Concurrency](https://source.wiredtiger.com/develop/arch-transaction.html)

### 3.3 Optimistic Lock vs Pessimistic Lock

#### Pessimistic Lock: "Conflicts will happen frequently"

```java
// JPA Pessimistic Lock
@Lock(LockModeType.PESSIMISTIC_WRITE)
@Query("SELECT p FROM Product p WHERE p.id = :id")
Product findByIdWithPessimisticLock(@Param("id") Long id);

@Transactional
public void updateStock(Long productId, int quantity) {
    Product product = productRepository.findByIdWithPessimisticLock(productId);
    // Exclusive Lock is acquired here
    // Other transactions must wait

    product.decreaseStock(quantity);
    productRepository.save(product);
    // Lock is released on commit
}
```

**SQL:**
```sql
SELECT * FROM product WHERE id = 1 FOR UPDATE;
-- Other transactions cannot read or write this row
```

#### Optimistic Lock: "Conflicts will rarely happen"

```java
@Entity
public class Product {
    @Id
    private Long id;

    private String name;
    private int stock;

    @Version  // Version column for optimistic locking
    private Long version;
}

@Transactional
public void updateStock(Long productId, int quantity) {
    Product product = productRepository.findById(productId);
    // Read without locking
    // version = 1

    product.decreaseStock(quantity);
    productRepository.save(product);
    // UPDATE product SET stock = ?, version = version + 1
    //  WHERE id = ? AND version = 1
}
```

**How It Works:**
![](/uploads/theory/lock-mechanisms-all/optimistic-lock.png)


**Retry Logic:**
```java
@Transactional
public void updateStockWithRetry(Long productId, int quantity) {
    int maxRetries = 3;
    int attempt = 0;

    while (attempt < maxRetries) {
        try {
            Product product = productRepository.findById(productId);
            product.decreaseStock(quantity);
            productRepository.save(product);
            return;  // Success
        } catch (OptimisticLockException e) {
            attempt++;
            if (attempt >= maxRetries) {
                throw new RuntimeException("Stock update failed: concurrency conflict");
            }
            // Wait briefly before retrying
            Thread.sleep(100);
        }
    }
}
```

#### Optimistic Lock vs Pessimistic Lock Comparison

| Comparison | Optimistic Lock | Pessimistic Lock |
|---------|---------|---------|
| **Lock Timing** | At commit (version check) | At query (SELECT FOR UPDATE) |
| **Conflict Detection** | At commit | At lock acquisition |
| **Performance (few conflicts)** | Fast (no locks) | Slow (waiting) |
| **Performance (many conflicts)** | Slow (many retries) | Fast (sequential processing) |
| **Deadlock** | None | Possible |
| **Best For** | Read-heavy, write-light | Write-heavy, frequent conflicts |
| **Examples** | Post view counter | Bank transfers, inventory deduction |

> Source: [Baeldung - JPA Optimistic Locking](https://www.baeldung.com/jpa-optimistic-locking), [Vlad Mihalcea - Optimistic vs Pessimistic Locking](https://vladmihalcea.com/optimistic-vs-pessimistic-locking/)

## 4. Distributed Lock

### 4.1 Why Are Distributed Locks Needed?

In a microservice environment, **multiple instances** run simultaneously.


![](/uploads/theory/lock-mechanisms-all/41-why-distributed-lock-needed.png)



**The Problem:**
```java
// Server A
@Transactional
public void processCoupon(String couponCode) {
    Coupon coupon = couponRepository.findByCode(couponCode);
    if (coupon.getUsageCount() < coupon.getMaxUsage()) {
        coupon.incrementUsage();  // Increment usage count
        couponRepository.save(coupon);
    }
}

// Server B (concurrent execution)
@Transactional
public void processCoupon(String couponCode) {
    Coupon coupon = couponRepository.findByCode(couponCode);
    if (coupon.getUsageCount() < couponMaxUsage()) {
        coupon.incrementUsage();  // Duplicate usage!
        couponRepository.save(coupon);
    }
}
```

DB locks cannot block **other server instances**. We need a **distributed lock**!

> Source: [Martin Kleppmann - How to do distributed locking](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html)

### 4.2 Distributed Lock with Redis

#### Basic Implementation

```java
@Component
public class RedisLockService {

    @Autowired
    private RedisTemplate<String, String> redisTemplate;

    public boolean tryLock(String key, String value, long timeoutSeconds) {
        // SET key value NX EX timeout
        // NX: Set only if key does not exist (atomic)
        // EX: Set expiration time (in seconds)
        return redisTemplate.opsForValue()
            .setIfAbsent(key, value, timeoutSeconds, TimeUnit.SECONDS);
    }

    public void unlock(String key, String value) {
        // Atomic deletion using Lua script
        String script =
            "if redis.call('get', KEYS[1]) == ARGV[1] then " +
            "    return redis.call('del', KEYS[1]) " +
            "else " +
            "    return 0 " +
            "end";

        redisTemplate.execute(
            new DefaultRedisScript<>(script, Long.class),
            Collections.singletonList(key),
            value
        );
    }
}
```

**Usage Example:**
```java
@Service
public class CouponService {

    @Autowired
    private RedisLockService lockService;

    public void processCoupon(String couponCode) {
        String lockKey = "coupon:lock:" + couponCode;
        String lockValue = UUID.randomUUID().toString();

        try {
            // Attempt to acquire lock (30-second timeout)
            if (lockService.tryLock(lockKey, lockValue, 30)) {
                try {
                    // Critical section
                    Coupon coupon = couponRepository.findByCode(couponCode);
                    if (coupon.getUsageCount() < coupon.getMaxUsage()) {
                        coupon.incrementUsage();
                        couponRepository.save(coupon);
                    }
                } finally {
                    // Always release the lock
                    lockService.unlock(lockKey, lockValue);
                }
            } else {
                throw new RuntimeException("Lock acquisition failed: another server is processing");
            }
        } catch (Exception e) {
            log.error("Coupon processing failed", e);
            throw e;
        }
    }
}
```

**How It Works:**
![](/uploads/theory/lock-mechanisms-all/basic-impl.png)


> Source: [Redis Documentation - Distributed locks](https://redis.io/docs/manual/patterns/distributed-locks/), [Baeldung - Distributed Lock with Redis](https://www.baeldung.com/spring-redis-distributed-lock)

#### Advanced Locking with Redisson

> **Key Takeaway:** Redisson is a library that adds advanced features such as auto-renewal, reentrancy, and fairness to Redis-based locks.

Basic Redis locks have the following limitations:
- Difficult to predict the exact lock expiration time
- If the task takes too long, the lock may expire prematurely
- Spinlock approach puts load on Redis

Redisson's **advanced lock** solves these problems:
- **Auto-renewal (Watchdog)**: Automatically extends lock expiration while the task is in progress
- **Reentrant**: The same thread can acquire the lock multiple times
- **Pub/Sub Waiting**: Efficient event-based waiting instead of spinlocks

```java
@Configuration
public class RedissonConfig {

    @Bean
    public RedissonClient redissonClient() {
        Config config = new Config();
        config.useSingleServer()
            .setAddress("redis://localhost:6379");
        return Redisson.create(config);
    }
}

@Service
public class CouponService {

    @Autowired
    private RedissonClient redissonClient;

    public void processCoupon(String couponCode) {
        RLock lock = redissonClient.getLock("coupon:lock:" + couponCode);

        try {
            // Attempt to acquire lock (wait 10s, release after 30s)
            if (lock.tryLock(10, 30, TimeUnit.SECONDS)) {
                try {
                    // Critical section
                    Coupon coupon = couponRepository.findByCode(couponCode);
                    if (coupon.getUsageCount() < coupon.getMaxUsage()) {
                        coupon.incrementUsage();
                        couponRepository.save(coupon);
                    }
                } finally {
                    lock.unlock();
                }
            } else {
                throw new RuntimeException("Lock acquisition timeout");
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new RuntimeException("Lock acquisition interrupted", e);
        }
    }
}
```

**Advantages of Redisson:**
1. **Auto-renewal**: Automatically extends the lock if the critical section takes a long time
2. **Reentrant**: The same thread can acquire the lock multiple times
3. **Fairness**: Locks are acquired in the order threads wait
4. **Redlock support**: Distributed locks across multiple Redis instances

> Source: [Redisson Documentation](https://github.com/redisson/redisson/wiki/8.-Distributed-locks-and-synchronizers), [Baeldung - Guide to Redisson](https://www.baeldung.com/redis-redisson)

### 4.3 Redlock Algorithm

A single Redis instance has a **SPOF (Single Point of Failure)** problem.

```
Redis instance goes down → All locks are lost!
```

**Redlock**: Acquires distributed locks across multiple Redis instances.

![](/uploads/theory/lock-mechanisms-all/43-redlock-algorithm.png)


**Algorithm:**
![](/uploads/theory/lock-mechanisms-all/43-redlock-algorithm-2.png)

```java
// Using Redisson Redlock
@Service
public class CouponService {

    @Autowired
    private RedissonClient redisson1;
    @Autowired
    private RedissonClient redisson2;
    @Autowired
    private RedissonClient redisson3;

    public void processCoupon(String couponCode) {
        RLock lock1 = redisson1.getLock("coupon:lock:" + couponCode);
        RLock lock2 = redisson2.getLock("coupon:lock:" + couponCode);
        RLock lock3 = redisson3.getLock("coupon:lock:" + couponCode);

        // RedLock: Must acquire at least 2 out of 3 to succeed
        RedissonRedLock redLock = new RedissonRedLock(lock1, lock2, lock3);

        try {
            if (redLock.tryLock(10, 30, TimeUnit.SECONDS)) {
                try {
                    // Critical section
                    processCouponInternal(couponCode);
                } finally {
                    redLock.unlock();
                }
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
```

**Advantages:**
- Lock is maintained even if one Redis instance goes down
- Works as long as a majority is alive

**Disadvantages:**
- Complexity due to network latency
- Clock synchronization issues (NTP)
- Performance overhead

> Source: [Redis Redlock](https://redis.io/docs/manual/patterns/distributed-locks/#the-redlock-algorithm), [Antirez - Is Redlock safe?](http://antirez.com/news/101), [Martin Kleppmann - Redlock criticism](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html)

## 5. Lock Problems and Solutions

### 5.1 Deadlock

#### Occurrence Conditions

```java
// Deadlock example
class BankAccount {
    private Lock lock = new ReentrantLock();
    private int balance;

    public void transfer(BankAccount target, int amount) {
        this.lock.lock();
        try {
            target.lock.lock();  // Deadlock possible!
            try {
                this.balance -= amount;
                target.balance += amount;
            } finally {
                target.lock.unlock();
            }
        } finally {
            this.lock.unlock();
        }
    }
}

// Usage
BankAccount accountA = new BankAccount(1000);
BankAccount accountB = new BankAccount(1000);

// Thread 1
accountA.transfer(accountB, 100);  // Lock A → Waiting for Lock B

// Thread 2 (concurrent execution)
accountB.transfer(accountA, 200);  // Lock B → Waiting for Lock A

// Deadlock!
```

**How It Works:**
![](/uploads/theory/lock-mechanisms-all/occurrence-condition.png)


#### Solution 1: Lock Ordering

```java
class BankAccount {
    private final long id;
    private Lock lock = new ReentrantLock();
    private int balance;

    public void transfer(BankAccount target, int amount) {
        // Always acquire the lock with the smaller ID first
        BankAccount first = this.id < target.id ? this : target;
        BankAccount second = this.id < target.id ? target : this;

        first.lock.lock();
        try {
            second.lock.lock();
            try {
                this.balance -= amount;
                target.balance += amount;
            } finally {
                second.lock.unlock();
            }
        } finally {
            first.lock.unlock();
        }
    }
}
```

#### Solution 2: Using tryLock

```java
public boolean transfer(BankAccount target, int amount) {
    if (this.lock.tryLock()) {
        try {
            if (target.lock.tryLock()) {
                try {
                    this.balance -= amount;
                    target.balance += amount;
                    return true;
                } finally {
                    target.lock.unlock();
                }
            }
        } finally {
            this.lock.unlock();
        }
    }
    return false;  // Retry on failure
}
```

> Source: [Wikipedia - Deadlock](https://en.wikipedia.org/wiki/Deadlock), [GeeksforGeeks - Deadlock Prevention](https://www.geeksforgeeks.org/deadlock-prevention/)

### 5.2 Lock Leak

```java
// Incorrect code: Missing lock release
public void badMethod() {
    lock.lock();

    if (someCondition) {
        return;  // Lock is NOT released!
    }

    doSomething();
    lock.unlock();
}

// Correct code: Using finally
public void goodMethod() {
    lock.lock();
    try {
        if (someCondition) {
            return;  // Released in finally
        }
        doSomething();
    } finally {
        lock.unlock();  // Always executes
    }
}
```

> Source: [Java Documentation - Lock](https://docs.oracle.com/javase/8/docs/api/java/util/concurrent/locks/Lock.html), [Baeldung - Guide to java.util.concurrent.Locks](https://www.baeldung.com/java-concurrent-locks)

### 5.3 Priority Inversion

This topic was already covered in [Semaphores and Mutexes](https://velog.io/@dj258255/%EC%84%B8%EB%A7%88%ED%8F%AC%EC%96%B4%EC%99%80-%EB%AE%A4%ED%85%8D%EC%8A%A4-%EB%8F%99%EA%B8%B0%ED%99%94-%EB%A9%94%EC%BB%A4%EB%8B%88%EC%A6%98%EC%9D%98-%EC%9D%B4%ED%95%B4), so here is a brief summary:

![](/uploads/theory/lock-mechanisms-all/53-priority-inversion-priority-inversion.png)


**Solution: Priority Inheritance**

> Source: [Wikipedia - Priority Inversion](https://en.wikipedia.org/wiki/Priority_inversion)

## 6. Real-World Cases: Lock Implementations in Korean IT Companies

### 6.1 Hyperconnect: Redis Distributed Lock and Performance Optimization

Hyperconnect's Azar API team implemented distributed locks in a multi-server environment handling global traffic.

#### The Problem

Local locks on a single server could not guarantee synchronization across multiple servers. A distributed lock that "checks whether a resource is in use through a shared storage" was essential.

#### Three Problems with the Initial Implementation

**1. Missing Timeout**
```java
// Incorrect implementation
public void processWithLock(String key) {
    while (!tryLock(key)) {
        // Can wait forever!
    }
    try {
        doSomething();
    } finally {
        unlock(key);
    }
}
```

If the lock is not released due to an application error, all other servers enter an **infinite wait** state.

**2. Inefficiency of Infinite Spinlock**

Performance analysis:
```
Task duration: 300ms
Concurrent requests: 100
Lock acquisition attempts: 594
Redis requests per second: 2000

→ Redis overloaded!
```

**3. Flawed try-finally Structure**
```java
// Incorrect code
boolean locked = tryLock(key);
try {
    if (locked) {
        doSomething();
    }
} finally {
    unlock(key);  // Executes even when locked == false!
}
```

The lock is released in finally even when lock acquisition failed, breaking synchronization.

#### Redisson's Three Key Solutions

**1. Timeout Configuration**
```java
RLock lock = redissonClient.getLock("myLock");

// waitTime: Maximum time to wait for lock acquisition
// leaseTime: Time after which the lock automatically expires
if (lock.tryLock(10, 30, TimeUnit.SECONDS)) {
    try {
        doSomething();
    } finally {
        lock.unlock();
    }
} else {
    throw new RuntimeException("Lock acquisition failed");
}
```

Even in case of application failure, the lock is automatically released after the `leaseTime`.

**2. Pub/Sub-Based Notification**

Uses a **Pub/Sub** mechanism instead of spinlocks:


**Previous Spinlock Approach**

![](/uploads/theory/lock-mechanisms-all/redisson-3.png)


**[Redisson Pub/Sub Approach]**

![](/uploads/theory/lock-mechanisms-all/redisson-3-2.png)


**Performance Improvement:**
```
Previous: 2000 Redis requests per second
Pub/Sub: 2 Redis requests per second (1000x reduction!)
```

**3. Atomicity with Lua Scripts**

Executes multiple Redis commands as **a single atomic operation**:

```lua
-- Redisson's lock acquisition Lua script
if (redis.call('exists', KEYS[1]) == 0) then
    redis.call('hset', KEYS[1], ARGV[2], 1);
    redis.call('pexpire', KEYS[1], ARGV[1]);
    return nil;
end;
if (redis.call('hexists', KEYS[1], ARGV[2]) == 1) then
    redis.call('hincrby', KEYS[1], ARGV[2], 1);
    redis.call('pexpire', KEYS[1], ARGV[1]);
    return nil;
end;
return redis.call('pttl', KEYS[1]);
```

**Benefits:**
- Existence check + set + expiration are executed **all at once**
- Prevents race conditions
- Reduces Redis request count

#### Performance Optimization Results

**Redisson's Lock Acquisition Process:**

![](/uploads/theory/lock-mechanisms-all/optimization.png)


**Key Lesson:**
> By leveraging Redis's advanced features (Lua, Pub/Sub), you can implement distributed locks that are far more efficient than application-level spinlocks.

> Source: [Hyperconnect - Redis and Distributed Locks (1/2)](https://hyperconnect.github.io/2019/11/15/redis-distributed-lock-1.html)

### 6.2 Kurly: Inventory Management with Redisson Distributed Lock

Kurly's Fulfillment Receiving Service team solved concurrency issues in their Receiving Management System (RMS) using Redisson.

#### Concurrency Issues Encountered

**1. Duplicate Order Reception**
```java
// Duplicate orders arriving simultaneously via Kafka
// → The same order gets registered multiple times
```

**2. Duplicate Requests**
```java
// During inspection/quality check issue registration:
// - Double clicks
// - Retries due to network latency
// → Duplicate issues are created
```

**3. Simultaneous Button Clicks**
```java
// Multiple workers clicking buttons simultaneously
// → Incorrect inventory transactions created
```

**The Problem:**
- Single-instance-level exception handling was insufficient
- A common lock across multiple instances was needed

#### Redisson vs Lettuce Selection

| Comparison | Lettuce | Redisson |
|---------|---------|----------|
| **Implementation** | Manual SETNX/SETEX | Lock interface provided |
| **Waiting Method** | Spinlock (continuous requests) | Pub/Sub (event-based waiting) |
| **Redis Load** | High | Low |
| **Implementation Complexity** | High | Low |

**Reasons for Selection:**
- Leveraged existing tech stack (Redis) with no additional infrastructure
- Efficient processing with Pub/Sub mechanism
- Simple usage through the Lock interface

#### Implementation: Annotation-Based AOP

**Core Architecture:**

```java
// 1. Annotation definition
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
public @interface DistributedLock {
    String key();           // Lock name (SpEL supported)
    long waitTime();        // Wait time (seconds)
    long leaseTime();       // Lease time (seconds)
    TimeUnit timeUnit() default TimeUnit.SECONDS;
}

// 2. Usage example
@DistributedLock(key = "#lockName", waitTime = 5, leaseTime = 3)
public void shipment(String lockName) {
    // Business logic
    // lockName value is used as the lock key (e.g., "order:12345")
}
```

**AOP Implementation:**

```java
@Aspect
@Component
public class DistributedLockAop {
    private final RedissonClient redissonClient;
    private final AopForTransaction aopForTransaction;

    @Around("@annotation(distributedLock)")
    public Object lock(ProceedingJoinPoint joinPoint,
                       DistributedLock distributedLock) throws Throwable {

        // Generate dynamic lock key with SpEL
        String key = CustomSpringELParser.getDynamicValue(
            joinPoint.getSignature(),
            joinPoint.getArgs(),
            distributedLock.key()
        );

        RLock lock = redissonClient.getLock(key);

        try {
            // Attempt to acquire lock
            boolean available = lock.tryLock(
                distributedLock.waitTime(),
                distributedLock.leaseTime(),
                distributedLock.timeUnit()
            );

            if (!available) {
                throw new InterruptedException("Lock acquisition failed: " + key);
            }

            // Handle transaction and lock together
            return aopForTransaction.proceed(joinPoint);

        } catch (InterruptedException e) {
            throw new RuntimeException("Lock acquisition interrupted", e);
        } finally {
            // Release only if held by current thread
            if (lock.isHeldByCurrentThread()) {
                lock.unlock();
            }
        }
    }
}
```

**Transaction Handling:**

```java
@Component
public class AopForTransaction {

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public Object proceed(ProceedingJoinPoint joinPoint) throws Throwable {
        return joinPoint.proceed();
    }
}
```

**Key Point: "Release the Lock After Transaction Commit"**

Correct approach (release lock after transaction commit)
![](/uploads/theory/lock-mechanisms-all/impl-aop.png)

Incorrect approach (release lock before transaction commit)
![](/uploads/theory/lock-mechanisms-all/impl-aop-2.png)


#### Results: Test Verification

**Coupon Deduction Test:**
```java
Initial coupons: 100
Concurrent requests: 100

[Without distributed lock]
Remaining coupons: 21 (only 79 deducted, 21 duplicate deduction failures)

[With distributed lock]
Remaining coupons: 0 (exactly 100 deducted)
```

**Duplicate Order Test:**
```java
10 identical orders received simultaneously

[Without distributed lock]
Registered orders: 3-5 (duplicates registered)

[With distributed lock]
Registered orders: 1 (correct!)
```

#### Developer Productivity Improvement

**Before: Complex lock code**
```java
public void processOrder(String orderId) {
    RLock lock = redissonClient.getLock("order:" + orderId);
    try {
        if (lock.tryLock(10, 30, TimeUnit.SECONDS)) {
            try {
                // Business logic
                validateOrder(orderId);
                updateStock(orderId);
                createShipment(orderId);
            } finally {
                lock.unlock();
            }
        } else {
            throw new RuntimeException("Lock acquisition failed");
        }
    } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
        throw new RuntimeException(e);
    }
}
```

**After: Clean annotation**
```java
@DistributedLock(key = "'order:' + #orderId", waitTime = 10, leaseTime = 30)
public void processOrder(String orderId) {
    // Focus only on business logic!
    validateOrder(orderId);
    updateStock(orderId);
    createShipment(orderId);
}
```

**Benefits:**
- **Complete separation** of business logic and lock handling
- Greatly improved code readability
- Reusable as a common component

> Source: [Kurly Tech Blog - How the Fulfillment Receiving Service Team Uses Distributed Locks](https://helloworld.kurly.com/blog/distributed-redisson-lock/)

### 6.3 Woowa Brothers (Baemin): WMS Inventory Transfer Distributed Lock

Woowa Brothers used distributed locks in the WMS (Warehouse Management System) inventory transfer process.

#### The Problem

Conflicts occurred when multiple processes accessed the same resource (inventory). Distributed locks were essential to maintain data consistency in a distributed environment.

#### The Solution

Implemented a Redis-based distributed lock to:
- Prevent multiple servers from modifying inventory simultaneously
- Manage transaction-based inventory usage
- Ensure data consistency

**Core Architecture:**
- Store total inventory in RDB
- Manage transaction-based inventory usage with Redis's fast in-memory DB
- Leverage Redis Set data structure (store purchase numbers, preventing duplicates)
- Synchronize with RDB at transaction time to prevent data loss

#### System Stability Improvements

With distributed locks:
- Inventory conflicts prevented
- System stability significantly improved
- Data consistency guaranteed

> Source: [Woowa Brothers - Distributed Lock for WMS Inventory Transfer](https://techblog.woowahan.com/17416/), [Woowa Brothers - Gift Service Product Inventory Management](https://techblog.woowahan.com/2709/)

## Summary

Lock mechanisms operate at multiple levels:

**1. Hardware Lock**
- Test-and-Set, CAS
- Memory Barrier (volatile)
- Lowest level, fastest

**2. OS Lock**
- Spinlock: Busy waiting, short critical sections
- Mutex/Semaphore: Sleep, long critical sections

**3. Database Lock**
- MySQL: Shared Lock, Exclusive Lock
- MongoDB: Intent Lock, Document-level Lock
- Optimistic Lock vs Pessimistic Lock

**4. Distributed Lock**
- Redis Distributed Lock
- Redisson, Redlock
- Microservice environments

**Selection Criteria:**
- **Critical section length**: Short = Spinlock, Long = Mutex
- **Conflict frequency**: Low = Optimistic Lock, High = Pessimistic Lock
- **Distributed environment**: Redis Distributed Lock, Redlock
- **Performance vs Stability**: Consider the trade-offs

## References

### Official Documentation
- [Java Documentation - synchronized](https://docs.oracle.com/javase/tutorial/essential/concurrency/sync.html) - Java synchronization
- [Java Documentation - AtomicInteger](https://docs.oracle.com/javase/8/docs/api/java/util/concurrent/atomic/AtomicInteger.html) - Java Atomic classes
- [MySQL Documentation - InnoDB Locking](https://dev.mysql.com/doc/refman/8.0/en/innodb-locking.html) - MySQL InnoDB lock mechanisms
- [MongoDB Manual - Locking](https://www.mongodb.com/docs/manual/reference/glossary/#std-term-lock) - MongoDB lock terminology
- [Redisson Documentation - Locks and Synchronizers](https://redisson.pro/docs/data-and-services/locks-and-synchronizers/) - Redisson distributed lock guide

### Theory and Academic Resources
- [Wikipedia - Lock (computer science)](https://en.wikipedia.org/wiki/Lock_(computer_science)) - Basic lock concepts and types
- [Wikipedia - Test-and-Set](https://en.wikipedia.org/wiki/Test-and-set) - TAS atomic instruction
- [Wikipedia - Compare-and-Swap](https://en.wikipedia.org/wiki/Compare-and-swap) - CAS atomic instruction
- [Wikipedia - Memory Barrier](https://en.wikipedia.org/wiki/Memory_barrier) - Memory barriers and ordering guarantees
- [Wikipedia - Spinlock](https://en.wikipedia.org/wiki/Spinlock) - Spinlock operation principles
- [Wikipedia - Deadlock](https://en.wikipedia.org/wiki/Deadlock) - Four conditions for deadlock
- [Wikipedia - Priority Inversion](https://en.wikipedia.org/wiki/Priority_inversion) - Priority inversion problem

### Technical Resources
- [GeeksforGeeks - Lock Variable Synchronization](https://www.geeksforgeeks.org/lock-variable-synchronization-mechanism/) - Lock variable synchronization mechanism
- [GeeksforGeeks - Spinlock vs Semaphore](https://www.geeksforgeeks.org/spinlock-vs-semaphore/) - Spinlock and semaphore comparison
- [GeeksforGeeks - Deadlock Prevention](https://www.geeksforgeeks.org/deadlock-prevention/) - Deadlock prevention techniques
- [Baeldung - Compare and Swap in Java](https://www.baeldung.com/java-compare-and-swap) - Using CAS in Java
- [Baeldung - Guide to the Volatile Keyword](https://www.baeldung.com/java-volatile) - Java volatile keyword guide
- [Baeldung - JPA Pessimistic Locking](https://www.baeldung.com/jpa-pessimistic-locking) - Using JPA pessimistic locks
- [Baeldung - JPA Optimistic Locking](https://www.baeldung.com/jpa-optimistic-locking) - JPA optimistic locking and version management

### Database Experts
- [Vlad Mihalcea - MVCC (Multi-Version Concurrency Control)](https://vladmihalcea.com/how-does-mvcc-multi-version-concurrency-control-work/) - MVCC operation principles and PostgreSQL implementation
- [Vlad Mihalcea - Optimistic vs Pessimistic Locking](https://vladmihalcea.com/optimistic-vs-pessimistic-locking/) - Optimistic lock vs pessimistic lock comparison

### Distributed Systems
- [Martin Kleppmann - How to do distributed locking](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html) - Redlock algorithm criticism and fencing tokens
- [Antirez - Is Redlock safe?](http://antirez.com/news/101) - Redis creator's defense of Redlock

### Korean Tech Blogs
- [Woowa Brothers - Distributed Lock for WMS Inventory Transfer](https://techblog.woowahan.com/17416/) - Concurrency control for inventory management with Redis-based distributed locks
- [Woowa Brothers - Gift Service Product Inventory Management](https://techblog.woowahan.com/2709/) - Inventory management and data consistency using Redis Sets
- [Hyperconnect - Redis and Distributed Locks (1/2)](https://hyperconnect.github.io/2019/11/15/redis-distributed-lock-1.html) - Performance optimization with Redisson Pub/Sub and Lua scripts
- [Kurly - How the Fulfillment Receiving Service Team Uses Distributed Locks](https://helloworld.kurly.com/blog/distributed-redisson-lock/) - Annotation-based distributed lock implementation with Redisson AOP
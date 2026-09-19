---
title: '세마포어와 뮤텍스 - 동기화 메커니즘의 이해'
description: 임계영역, 세마포어, 뮤텍스의 개념과 차이를 OS 레벨부터 Java 구현까지 정리하고, 실무에서 흔히 혼동하는 부분을 명확히 해봤습니다.
date: 2025-06-04T00:00:00.000Z
tags:
  - Semaphore
  - Mutex
  - Synchronization
  - OS
  - Concurrency
  - Java
category: theory/Concurrency
draft: false
coverImage: "/uploads/theory/semaphore-mutex-sync/critical-section-critical-section.svg"
series: "동시성과 락"
seriesOrder: 1
---


## 들어가며

멀티스레드 프로그래밍에서 가장 어려운 문제 중 하나는 **동기화(Synchronization)**입니다. 여러 스레드가 동시에 공유 자원에 접근하면 데이터 불일치, 경쟁 상태(Race Condition), 교착 상태(Deadlock) 같은 문제가 발생합니다. 이를 방지하기 위해 운영체제는 세마포어(Semaphore)와 뮤텍스(Mutex)라는 동기화 기법을 제공합니다.

면접에서 "세마포어와 뮤텍스의 차이"는 단골 질문입니다. 두 개념 모두 임계영역(Critical Section)을 보호하지만, **소유권**, **사용 목적**, **카운팅 방식**에서 근본적인 차이가 있습니다.

> 출처: [GeeksforGeeks - Mutex vs Semaphore](https://www.geeksforgeeks.org/mutex-vs-semaphore/), [Baeldung - Semaphore vs. Mutex](https://www.baeldung.com/java-mutex)

## 임계영역과 동기화 문제

### 임계영역 (Critical Section)

임계영역은 **여러 프로세스/스레드가 공유하는 자원에 접근하는 코드 영역**입니다. 동시에 두 개 이상의 스레드가 임계영역에 진입하면 데이터 불일치가 발생합니다.

```java
// 은행 계좌 출금 예시 (임계영역)
class BankAccount {
    private int balance = 1000;

    public void withdraw(int amount) {
        // === 임계영역 시작 ===
        if (balance >= amount) {           // 1. 잔액 확인
            System.out.println("출금 시작");
            balance -= amount;              // 2. 잔액 감소
            System.out.println("출금 완료: " + amount);
        }
        // === 임계영역 끝 ===
    }
}
```

**경쟁 상태 (Race Condition) 발생:**
![](/uploads/theory/semaphore-mutex-sync/critical-section-critical-section.svg)



스레드 A와 B가 동시에 잔액을 확인했기 때문에, 둘 다 출금 가능하다고 판단했습니다. 이런 문제를 방지하려면 **임계영역을 보호**해야 합니다.

> 출처: [Wikipedia - Race Condition](https://en.wikipedia.org/wiki/Race_condition), [GeeksforGeeks - Race Condition](https://www.geeksforgeeks.org/introduction-of-process-synchronization/)

### 동기화의 필요성

동기화는 여러 프로세스/스레드가 공유 자원에 **순차적으로 접근**하도록 보장하는 메커니즘입니다.

**동기화의 조건:**

1. **상호 배제 (Mutual Exclusion)**: 한 번에 하나의 프로세스만 임계영역 진입
2. **진행 (Progress)**: 임계영역이 비어있으면 진입 대기 중인 프로세스가 진입 가능
3. **한정 대기 (Bounded Waiting)**: 무한정 대기하지 않음 (기아 상태 방지)

> 출처: [Wikipedia - Critical Section](https://en.wikipedia.org/wiki/Critical_section), [GeeksforGeeks - Process Synchronization](https://www.geeksforgeeks.org/introduction-of-process-synchronization/)

## 뮤텍스 (Mutex)

### 뮤텍스란

뮤텍스(Mutual Exclusion)는 **상호 배제를 구현하기 위한 잠금 메커니즘**입니다. 공유 자원에 대한 접근을 동시에 **오직 하나의 스레드만** 가능하게 제한합니다.

**핵심 특징:**
- **소유권(Ownership)이 있다**: Lock을 건 스레드만 Unlock 가능
- **이진(Binary) 상태**: Locked(1) 또는 Unlocked(0)
- **소유권**: 락을 획득한 스레드만 해제 가능. 재진입은 구현에 따라 다름. Java의 synchronized와 ReentrantLock은 재진입 가능하지만, POSIX PTHREAD_MUTEX_NORMAL은 재진입 시 데드락 발생

> 출처: [Velog - [OS]뮤텍스(Mutex)와 세마포어(Semaphore)](https://velog.io/@dodozee/뮤텍스Mutex와-세마포어Semaphore), [GeeksforGeeks - Mutex vs Semaphore](https://www.geeksforgeeks.org/mutex-vs-semaphore/)

### 뮤텍스 동작 원리
![](/uploads/theory/semaphore-mutex-sync/mutex-operation-principle.svg)

**중요:** 스레드 B는 스레드 A의 Lock을 해제할 수 없습니다. 오직 소유자인 스레드 A만 Unlock 가능합니다.

> 출처: [Baeldung - Using a Mutex Object in Java](https://www.baeldung.com/java-mutex), [GeeksforGeeks - Mutual Exclusion in Synchronization](https://www.geeksforgeeks.org/operating-systems/mutual-exclusion-in-synchronization/)

### Java에서의 뮤텍스 구현

#### 1. synchronized 키워드

```java
class BankAccount {
    private int balance = 1000;

    // 메서드 전체를 동기화
    public synchronized void withdraw(int amount) {
        if (balance >= amount) {
            balance -= amount;
            System.out.println("출금 완료: " + amount);
        } else {
            System.out.println("잔액 부족");
        }
    }
}
```

`synchronized` 키워드는 메서드나 블록에 대한 암묵적 뮤텍스를 제공합니다. 한 스레드가 `synchronized` 메서드를 실행 중이면, 다른 스레드는 대기해야 합니다.

참고: Java의 synchronized도 재진입 가능하다. synchronized 메서드 안에서 같은 객체의 다른 synchronized 메서드를 호출해도 데드락이 발생하지 않는다.

> 출처: [Java Documentation - synchronized](https://docs.oracle.com/javase/tutorial/essential/concurrency/sync.html), [Baeldung - Guide to synchronized](https://www.baeldung.com/java-synchronized)

#### 2. ReentrantLock (명시적 뮤텍스)

```java
import java.util.concurrent.locks.Lock;
import java.util.concurrent.locks.ReentrantLock;

class BankAccount {
    private int balance = 1000;
    private Lock lock = new ReentrantLock();

    public void withdraw(int amount) {
        lock.lock();  // 잠금 획득
        try {
            if (balance >= amount) {
                balance -= amount;
                System.out.println("출금 완료: " + amount);
            } else {
                System.out.println("잔액 부족");
            }
        } finally {
            lock.unlock();  // 반드시 잠금 해제
        }
    }
}
```

`ReentrantLock`은 명시적 뮤텍스로, `synchronized`보다 세밀한 제어가 가능합니다.

**ReentrantLock의 장점:**
- 공정성(Fairness) 설정 가능: 대기 시간이 긴 스레드에 우선권 부여
- 타임아웃 설정 가능: `tryLock(timeout)`
- 인터럽트 가능: 대기 중인 스레드를 깨울 수 있음

```java
Lock fairLock = new ReentrantLock(true);  // 공정한 락
if (lock.tryLock(1, TimeUnit.SECONDS)) {  // 1초 대기
    try {
        // 임계영역
    } finally {
        lock.unlock();
    }
} else {
    System.out.println("락 획득 실패");
}
```

> 출처: [Baeldung - Binary Semaphore vs Reentrant Lock](https://www.baeldung.com/java-binary-semaphore-vs-reentrant-lock), [Java Documentation - ReentrantLock](https://docs.oracle.com/javase/8/docs/api/java/util/concurrent/locks/ReentrantLock.html)

### 재진입 가능 (Reentrant)

`ReentrantLock`이라는 이름에서 알 수 있듯이, 같은 스레드가 이미 소유한 Lock을 다시 획득할 수 있습니다.

```java
Lock lock = new ReentrantLock();

public void outerMethod() {
    lock.lock();
    try {
        System.out.println("Outer method");
        innerMethod();  // 같은 스레드가 lock을 다시 요청
    } finally {
        lock.unlock();
    }
}

public void innerMethod() {
    lock.lock();  // 재진입 성공 (카운터 증가)
    try {
        System.out.println("Inner method");
    } finally {
        lock.unlock();  // 카운터 감소
    }
}
```

**동작 과정:**
![](/uploads/theory/semaphore-mutex-sync/reentrant-possible-reentrant.svg)


재진입이 불가능하다면, `innerMethod()`에서 데드락이 발생합니다.

> 출처: [Medium - Mutex and Semaphore](https://medium.com/@irfanhaydararman/mutex-and-semaphore-e223321ddd7c), [Oracle - Lock Interface](https://docs.oracle.com/javase/8/docs/api/java/util/concurrent/locks/Lock.html)

## 세마포어 (Semaphore)

### 세마포어란

세마포어는 **신호 메커니즘(Signaling Mechanism)**으로, **여러 프로세스/스레드가 제한된 개수의 자원에 접근**할 수 있도록 제어합니다.

**핵심 특징:**
- **소유권이 없다**: 어떤 스레드든 signal() 호출 가능
- **카운터 기반**: 사용 가능한 자원의 개수를 추적
- **두 가지 연산**: wait(P 연산)와 signal(V 연산)

> 출처: [Wikipedia - Semaphore (programming)](https://en.wikipedia.org/wiki/Semaphore_(programming)), [GeeksforGeeks - Semaphores in Process Synchronization](https://www.geeksforgeeks.org/operating-systems/semaphores-in-process-synchronization/)

### 세마포어 동작 원리

세마포어는 정수형 카운터로 구현됩니다.


![](/uploads/theory/semaphore-mutex-sync/semaphore-operation-principle.svg)


**주요 연산:**
- **wait() (P 연산, acquire)**: 카운터 감소, 0이면 대기
- **signal() (V 연산, release)**: 카운터 증가, 대기 중인 프로세스 깨우기

> 출처: [GeeksforGeeks - Semaphores in Process Synchronization](https://www.geeksforgeeks.org/operating-systems/semaphores-in-process-synchronization/), [Wikipedia - Semaphore](https://en.wikipedia.org/wiki/Semaphore_(programming))

### 세마포어의 종류

#### 1. 이진 세마포어 (Binary Semaphore)

카운터가 0 또는 1만 가질 수 있는 세마포어입니다.

```c
// 이진 세마포어 의사코드
semaphore binary_sem = 1;  // 초기값: 1

wait(binary_sem) {
    // 주의: 실제 구현에서는 while 검사와 binary_sem-- 사이의 원자성이
    // 보장되어야 한다 (하드웨어 CAS 명령어 또는 인터럽트 비활성화를 사용)
    while (binary_sem <= 0) {
        // 대기
    }
    binary_sem--;  // 1 → 0
}

signal(binary_sem) {
    binary_sem++;  // 0 → 1
}
```

**뮤텍스와의 차이:**
- 이진 세마포어는 **신호 메커니즘**입니다 (소유권 없음)
- 뮤텍스는 **잠금 메커니즘**입니다 (소유권 있음)

```java
// 이진 세마포어 예시
Semaphore binarySem = new Semaphore(1);

// 스레드 A
binarySem.acquire();  // 카운터: 0
// 임계영역

// 스레드 B (다른 스레드)
binarySem.release();  // 카운터: 1 (가능!)
// 스레드 A가 acquire했지만, 스레드 B가 release 가능
```

> **주의: Java `Semaphore`는 "0/1" 상한을 강제하지 않습니다.** `release()`는 대응하는 `acquire()`가 없어도 **항상 카운터를 1 증가**시킵니다(상한은 사실상 `Integer.MAX_VALUE`). 즉 `new Semaphore(1)`이라도 누군가 `release()`를 한 번 더 부르면 카운터가 2가 되어 "이진"이 깨지고, 버그로 두 번 release하면 **이진 세마포어가 영영 열린 채로** 남습니다. 소유권으로 이런 실수를 막아주는 뮤텍스와의 결정적 차이입니다. (출처: [Baeldung - Semaphores in Java](https://www.baeldung.com/java-semaphore), [OpenJDK JDK-8255491](https://bugs.openjdk.org/browse/JDK-8255491))

반면 뮤텍스는 Lock을 건 스레드만 Unlock할 수 있습니다.

> 출처: [Velog - [OS] 세마포어와 뮤텍스](https://velog.io/@conatuseus/OS-세마포어와-뮤텍스), [Baeldung - Binary Semaphore vs Reentrant Lock](https://www.baeldung.com/java-binary-semaphore-vs-reentrant-lock)

#### 2. 카운팅 세마포어 (Counting Semaphore)

카운터가 0 이상의 임의의 정수 값을 가질 수 있습니다.

```java
// 카운팅 세마포어 예시: 주차장 (5개의 주차 공간)
Semaphore parkingLot = new Semaphore(5);

class Car extends Thread {
    private String name;

    public void run() {
        try {
            System.out.println(name + " 주차 대기");
            parkingLot.acquire();  // 주차 공간 확보
            System.out.println(name + " 주차 완료");
            Thread.sleep(2000);    // 주차 중
        } catch (InterruptedException e) {
            e.printStackTrace();
        } finally {
            System.out.println(name + " 출차");
            parkingLot.release();  // 주차 공간 반환
        }
    }
}
```

**실행 결과:**


![](/uploads/theory/semaphore-mutex-sync/2-counting-semaphore-counting-semaphore.svg)



> 출처 :  [Java Documentation - Semaphore](https://docs.oracle.com/javase/8/docs/api/java/util/concurrent/Semaphore.html)

### Java에서의 세마포어 구현

```java
import java.util.concurrent.Semaphore;

class DatabaseConnectionPool {
    private Semaphore semaphore;
    private static final int MAX_CONNECTIONS = 10;

    public DatabaseConnectionPool() {
        semaphore = new Semaphore(MAX_CONNECTIONS);
    }

    public Connection getConnection() throws InterruptedException {
        semaphore.acquire();  // 연결 획득 (카운터 감소)
        return createConnection();
    }

    public void releaseConnection(Connection conn) {
        closeConnection(conn);
        semaphore.release();  // 연결 반환 (카운터 증가)
    }
}

// 사용 예시
DatabaseConnectionPool pool = new DatabaseConnectionPool();

// 스레드 A
Connection conn = pool.getConnection();  // 카운터: 9
// SQL 쿼리 실행
pool.releaseConnection(conn);            // 카운터: 10

// 11번째 요청이 오면 대기
```

세마포어는 **제한된 자원의 풀(Pool)**을 관리할 때 유용합니다.

> 출처: [Baeldung - Java Concurrency – Semaphore](https://www.baeldung.com/java-semaphore), [Oracle - Semaphore](https://docs.oracle.com/javase/8/docs/api/java/util/concurrent/Semaphore.html)

## 뮤텍스 vs 세마포어: 핵심 차이

| 비교 항목 | 뮤텍스 (Mutex) | 세마포어 (Semaphore) |
|---------|--------------|-------------------|
| **메커니즘** | 잠금 메커니즘 (Locking) | 신호 메커니즘 (Signaling) |
| **소유권** | 있음 (Lock을 건 스레드만 Unlock) | 없음 (어떤 스레드든 signal 가능) |
| **카운터** | 이진 (0 또는 1) | 정수 (0 이상) |
| **목적** | 상호 배제 (Mutual Exclusion) | 자원 개수 제한 |
| **사용 시나리오** | 임계영역 보호 | 자원 풀 관리 |
| **재진입** | 가능 (ReentrantLock) | 불가능 (카운터만 증감) |
| **범위** | 기본적으로 프로세스 내 (단, POSIX PTHREAD_PROCESS_SHARED나 Windows Named Mutex로 프로세스 간 공유 가능) | 구현에 따라 프로세스 내(Java) 또는 시스템 범위(POSIX named semaphore) |
| **예시** | synchronized, ReentrantLock | Semaphore(n) |

> 출처: [GeeksforGeeks - Mutex vs Semaphore](https://www.geeksforgeeks.org/mutex-vs-semaphore/), [Stack Overflow - What is the difference between lock, mutex and semaphore?](https://stackoverflow.com/questions/2332765/)

### 소유권의 중요성

**뮤텍스 (소유권 O):**
```java
Lock lock = new ReentrantLock();

// 스레드 A
lock.lock();        // 스레드 A가 소유
// 임계영역
lock.unlock();      // 스레드 A만 해제 가능

// 스레드 B
lock.unlock();      // 에러! 스레드 B는 소유자가 아님
```

**세마포어 (소유권 X):**
```java
Semaphore sem = new Semaphore(1);

// 스레드 A
sem.acquire();      // 카운터: 0

// 스레드 B (다른 스레드)
sem.release();      // 카운터: 1 (가능!)
```

이 차이는 **프로세스 간 동기화**에서 중요합니다. 세마포어는 프로세스 A가 wait()하고 프로세스 B가 signal()할 수 있지만, 뮤텍스는 같은 프로세스/스레드가 Lock과 Unlock을 담당해야 합니다.

> 출처: [Velog - 뮤텍스(Mutex)와 세마포어(Semaphore)의 차이](https://velog.io/@heetaeheo/뮤텍스Mutex와-세마포어Semaphore의-차이), [Baeldung - Semaphore vs. Mutex](https://www.baeldung.com/cs/semaphore-vs-mutex)

## 실전 예제: 식사하는 철학자 문제

### 문제 설명

1965년 다익스트라가 제안한 **식사하는 철학자 문제(Dining Philosophers Problem)**는 교착 상태를 설명하기 위한 고전적 문제입니다.

**상황:**
- 5명의 철학자가 원탁에 앉아 있습니다
- 각 철학자 사이에 포크가 1개씩 (총 5개)
- 스파게티를 먹으려면 양손에 포크를 하나씩 들어야 합니다
- 철학자는 생각하거나 먹습니다

```
        포크0
    철학자0  철학자1
포크4            포크1
    철학자4  철학자2
        철학자3
      포크3  포크2
```

> 출처: [Wikipedia - Dining Philosophers Problem](https://en.wikipedia.org/wiki/Dining_philosophers_problem), [GeeksforGeeks - Dining Philosopher Problem Using Semaphores](https://www.geeksforgeeks.org/dining-philosopher-problem-using-semaphores/)

### 잘못된 구현 (데드락 발생)

```java
class Philosopher extends Thread {
    private int id;
    private Semaphore leftFork;
    private Semaphore rightFork;

    public void run() {
        try {
            while (true) {
                think();

                // 왼쪽 포크 집기
                leftFork.acquire();
                System.out.println("철학자 " + id + " 왼쪽 포크 획득");

                // 오른쪽 포크 집기
                rightFork.acquire();
                System.out.println("철학자 " + id + " 오른쪽 포크 획득");

                eat();

                // 포크 내려놓기
                leftFork.release();
                rightFork.release();
            }
        } catch (InterruptedException e) {
            e.printStackTrace();
        }
    }
}
```

**데드락 발생 시나리오:**

![](/uploads/theory/semaphore-mutex-sync/wrong-impl-deadlock-occurrence.svg)


모든 철학자가 왼쪽 포크를 들고 오른쪽 포크를 기다리므로, 아무도 식사할 수 없게 됩니다.

> 출처: [Wikipedia - Dining Philosophers Problem](https://en.wikipedia.org/wiki/Dining_philosophers_problem), [GeeksforGeeks - Deadlock in Operating System](https://www.geeksforgeeks.org/introduction-of-deadlock-in-operating-system/)

### 데드락 발생의 4가지 필요조건 (Coffman)

데드락이 발생하려면 다음 4가지 조건이 **동시에** 성립해야 합니다:

1. **상호 배제 (Mutual Exclusion)**: 포크는 한 번에 한 철학자만 사용 가능
2. **점유 대기 (Hold and Wait)**: 왼쪽 포크를 든 채 오른쪽 포크를 기다림
3. **비선점 (No Preemption)**: 다른 철학자의 포크를 강제로 빼앗을 수 없음
4. **순환 대기 (Circular Wait)**: 철학자 0→1→2→3→4→0 순환 대기 구조

해결 방법은 이 4가지 중 **하나를 깨뜨리는 것**입니다.

### 해결 방법 1: 홀수/짝수 철학자 분리 (순환 대기 제거)

```java
class Philosopher extends Thread {
    private int id;
    private Semaphore leftFork;
    private Semaphore rightFork;

    public void run() {
        try {
            while (true) {
                think();

                if (id % 2 == 0) {
                    // 짝수: 왼쪽 → 오른쪽
                    leftFork.acquire();
                    rightFork.acquire();
                } else {
                    // 홀수: 오른쪽 → 왼쪽
                    rightFork.acquire();
                    leftFork.acquire();
                }

                eat();

                leftFork.release();
                rightFork.release();
            }
        } catch (InterruptedException e) {
            e.printStackTrace();
        }
    }
}
```

대칭성을 깨뜨려서 데드락을 방지하는 방식입니다.

> 출처: [Velog - [Philosophers] 예시/예제로 보는 뮤텍스와 세마포어의 차이](https://velog.io/@hidaehyunlee/Philosophers-예시예제로-보는-뮤텍스와-세마포어의-차이), [GeeksforGeeks - Dining Philosopher Problem Using Semaphores](https://www.geeksforgeeks.org/dining-philosopher-problem-using-semaphores/)

### 해결 방법 2: 세마포어로 동시 식사 인원 제한

```java
class DiningPhilosophers {
    private Semaphore[] forks = new Semaphore[5];
    private Semaphore maxDiners = new Semaphore(4);  // 최대 4명만 동시 식사

    public DiningPhilosophers() {
        for (int i = 0; i < 5; i++) {
            forks[i] = new Semaphore(1);
        }
    }

    public void dine(int id) throws InterruptedException {
        maxDiners.acquire();  // 식탁에 앉기

        forks[id].acquire();         // 왼쪽 포크
        forks[(id + 1) % 5].acquire(); // 오른쪽 포크

        System.out.println("철학자 " + id + " 식사 중");

        forks[id].release();
        forks[(id + 1) % 5].release();

        maxDiners.release();  // 식탁에서 일어나기
    }
}
```

최대 4명만 동시에 앉을 수 있으므로, 적어도 1명은 포크 2개를 집을 수 있습니다.

> 출처: [GeeksforGeeks - Dining Philosopher Problem Using Semaphores](https://www.geeksforgeeks.org/dining-philosopher-problem-using-semaphores/), [Wikipedia - Dining Philosophers Problem](https://en.wikipedia.org/wiki/Dining_philosophers_problem)

## 실무 문제: 우선순위 역전 (Priority Inversion)

### 문제 설명

우선순위 역전은 **낮은 우선순위의 스레드가 높은 우선순위 스레드보다 먼저 실행**되는 현상입니다.

**시나리오:**
![](/uploads/theory/semaphore-mutex-sync/problem-description.svg)


> 출처: [Wikipedia - Priority Inversion](https://en.wikipedia.org/wiki/Priority_inversion), [GeeksforGeeks - Priority Inversion in Operating Systems](https://www.geeksforgeeks.org/priority-inversion-what-the-heck/)

### 화성 탐사선 사례 (Mars Pathfinder)

1997년 NASA의 Mars Pathfinder 탐사선에서 실제로 발생한 사건입니다.

**문제 상황:**
- 정보 수집 스레드(낮은 우선순위): 버스 관리 뮤텍스 Lock
- 통신 스레드(높은 우선순위): 버스 관리 뮤텍스 대기
- 기상 관측 스레드(중간 우선순위): 긴 작업 실행
- 결과: 통신 스레드가 타임아웃으로 시스템 리셋

**해결 방법:**
NASA는 VxWorks 운영체제의 **우선순위 상속(Priority Inheritance)** 기능을 활성화했습니다.

> 출처: [Rapita Systems - What Really Happened on Mars Pathfinder?](https://www.rapitasystems.com/blog/what-really-happened-software-mars-pathfinder-spacecraft), [Embedded.com - Maximizing visibility through logging](https://www.embedded.com/maximizing-visibility-through-logging-as-on-mars-pathfinder/)

### 우선순위 상속 (Priority Inheritance)

낮은 우선순위 스레드가 뮤텍스를 소유하고 있을 때, 높은 우선순위 스레드가 대기하면 **소유자의 우선순위를 일시적으로 높여줍니다**.
![](/uploads/theory/semaphore-mutex-sync/priority-inheritance-priority-inheritance.svg)


Java에서는 직접 구현해야 하지만, RTOS(Real-Time OS)에서는 기본 제공합니다.

> 출처: [FreeRTOS Documentation - Priority Inheritance](https://www.freertos.org/Real-time-embedded-RTOS-mutexes.html), [Wikipedia - Priority Inheritance](https://en.wikipedia.org/wiki/Priority_inheritance)

## 실무 사례: 한국 IT 기업의 동시성 제어

### 우아한형제들: MySQL을 이용한 분산 락

우아한형제들은 광고 시스템에서 여러 서버에 걸친 동시성 문제를 해결하기 위해 MySQL의 **User-Level Lock**을 활용했습니다.

#### 문제 상황
여러 서버가 동일한 자원에 접근할 때, 단일 서버의 뮤텍스나 세마포어로는 해결할 수 없는 **분산 환경의 동시성 문제**가 발생했습니다.

#### 해결 방법: MySQL GET_LOCK

**선택 이유:**
- 이미 사용 중인 MySQL 인프라를 활용하여 추가 비용 없음
- ZooKeeper, Redis 같은 별도 시스템 도입의 인프라 구축/유지보수 비용 절감
- 잠금에 이름을 지정하여 애플리케이션 단에서 세밀한 제어 가능

**구현 코드:**
```java
public class MySQLDistributedLock {
    private DataSource dataSource;

    public void executeWithLock(String lockName, Runnable task) {
        // Connection을 직접 관리하여 동일 연결에서 lock/unlock
        try (Connection conn = dataSource.getConnection()) {
            // 락 획득
            String getLockQuery = "SELECT GET_LOCK(?, 10)";  // 10초 대기
            try (PreparedStatement ps = conn.prepareStatement(getLockQuery)) {
                ps.setString(1, lockName);
                ResultSet rs = ps.executeQuery();

                if (rs.next() && rs.getInt(1) == 1) {
                    try {
                        // 비즈니스 로직 실행
                        task.run();
                    } finally {
                        // 락 해제
                        String releaseLockQuery = "SELECT RELEASE_LOCK(?)";
                        try (PreparedStatement ps2 = conn.prepareStatement(releaseLockQuery)) {
                            ps2.setString(1, lockName);
                            ps2.executeQuery();
                        }
                    }
                }
            }
        } catch (SQLException e) {
            throw new RuntimeException("Failed to acquire lock", e);
        }
    }
}
```

**주의사항:**
- JdbcTemplate을 사용하면 연결 풀 재사용으로 인해 `GET_LOCK`과 `RELEASE_LOCK`이 다른 연결을 사용할 수 있음
- 반드시 DataSource에서 직접 Connection을 관리하여 동일 연결 보장
- try-with-resources로 Connection 생명주기 관리

**장단점:**

| 장점 | 단점 |
|-----|-----|
| 기존 인프라 활용으로 추가 비용 없음 | 대기 순서 보장 불가 |
| 명명된 잠금으로 세밀한 제어 가능 | MySQL 버전에 따른 제약 (5.7 이전: 동시 1개만) |
| 구현이 간단함 | 별도 연결 관리의 복잡성 |

> 출처: [우아한형제들 - MySQL을 이용한 분산락으로 여러 서버에 걸친 동시성 관리](https://techblog.woowahan.com/2631/)

### 카카오페이: Redis 분산 락으로 따닥 이슈 해결

카카오페이에서는 사용자 혜택 서비스를 개발하면서 발생한 "따닥 이슈"를 Redis 분산 락으로 해결했습니다.

#### 문제 상황: 따닥 이슈
사용자가 버튼을 한 순간에 여러 번 클릭하여 **API 호출이 중복**으로 일어나는 문제가 발생했습니다. 혜택 서비스에서 페이포인트를 지급하는데, 동시 요청이 비즈니스 로직을 모두 통과하면서 **포인트가 중복 지급**될 위험이 있었습니다.

#### 해결 방법: Redis SETNX를 이용한 분산 락

**선택 이유:**
- 애플리케이션 단에서 처리하여 유지보수 용이
- Controller 단에서 예외를 즉시 던져 빠른 실패(Fail-Fast) 가능
- DB 락보다 가볍고 빠름

**구현 코드:**
```java
// 1. LockManager: Redis 락 관리
@Component
public class LockManager {
    private final StringRedisTemplate redisTemplate;
    private static final int LOCK_TTL_SECONDS = 3;

    public String acquireLock(String key) {
        String lockKey = key + ":lock";
        String lockValue = UUID.randomUUID().toString();
        Boolean success = redisTemplate.opsForValue()
            .setIfAbsent(lockKey, lockValue,
                         Duration.ofSeconds(LOCK_TTL_SECONDS));
        return Boolean.TRUE.equals(success) ? lockValue : null;
    }

    public void releaseLock(String key, String lockValue) {
        String lockKey = key + ":lock";
        // Lua 스크립트로 자신의 락인지 확인 후 삭제 (원자적)
        String script = "if redis.call('get', KEYS[1]) == ARGV[1] then " +
                        "return redis.call('del', KEYS[1]) " +
                        "else return 0 end";
        redisTemplate.execute(new DefaultRedisScript<>(script, Long.class),
            List.of(lockKey), lockValue);
    }
}

// 2. RedisLockUtil: 락 획득 및 실행
public class RedisLockUtil {
    public static <T> T acquireAndRunLock(
            String lockKey,
            Supplier<T> supplier,
            LockManager lockManager) {

        // 락 획득 시도 (UUID 반환, 실패 시 null)
        String lockValue = lockManager.acquireLock(lockKey);
        if (lockValue == null) {
            throw new BusinessException("동시 요청이 발생했습니다");
        }

        try {
            // 비즈니스 로직 실행
            return supplier.get();
        } finally {
            // 락 해제 (자신의 락인지 확인 후 삭제)
            lockManager.releaseLock(lockKey, lockValue);
        }
    }
}

// 3. Controller에서 사용
@PostMapping("/benefit/reward")
public ResponseEntity<?> claimReward(@RequestBody RewardRequest request) {
    String lockKey = "benefit:reward:" + request.getUserId();

    RewardResponse response = RedisLockUtil.acquireAndRunLock(
        lockKey,
        () -> benefitService.claimReward(request),
        lockManager
    );

    return ResponseEntity.ok(response);
}
```

**동작 과정:**
![](/uploads/theory/semaphore-mutex-sync/solution-method-redis-setnx-distributed-lock.svg)


**핵심 포인트:**
- `SETNX` (SET if Not eXists): 키가 없을 때만 설정 성공
- TTL 3초 설정으로 락이 영구히 남는 것 방지 (장애 대응)
- `finally` 블록에서 반드시 락 해제

> 출처: [카카오페이 - 주니어 서버 개발자가 유저향 서비스를 개발하며 마주쳤던 이슈와 해결 방안](https://tech.kakaopay.com/post/troubleshooting-logs-as-a-junior-developer/)

### LINE: 비동기 서버와 이벤트 루프 기반 동시성

참고: 아래 사례는 뮤텍스/세마포어와는 다른 동시성 패러다임이지만, 락 없이 동시성을 달성하는 대안적 접근으로 비교 참고할 만하다.

LINE Engineering에서는 비동기 서버에서 이벤트 루프를 활용한 동시성 처리를 상세히 설명했습니다.

#### 멀티플렉싱 기반 동시성

전통적인 멀티스레드 방식과 달리, **이벤트 루프**는 단일 스레드로 수만 개의 연결을 동시에 처리할 수 있습니다.

**멀티플렉싱이란?**
하나의 프로세스/스레드에서 입력과 출력을 모두 다룰 수 있는 기술입니다. 각 요청마다 별도 스레드를 할당하지 않고, 준비된 I/O만 처리합니다.

**이벤트 루프 동작 원리:**

![](/uploads/theory/semaphore-mutex-sync/multiplexing-based-concurrency.svg)


```java
while (true) {
    events = epoll_wait()    // <- I/O 준비 대기
    
    for(event in events){
      if(readable){
        handleRead(event) // <- 논블로킹 처리
      }
      if(writable){
        handleWrite(event)
      }
    }
  }
```

**전통적 멀티스레드 vs 이벤트 루프:**

| 멀티스레드 방식 | 이벤트 루프 방식 |
|--------------|---------------|
| 요청당 1개 스레드 | 단일 스레드 |
| 컨텍스트 스위칭 비용 높음 | 이벤트 루프 내 사용자 레벨 컨텍스트 스위칭 없음 |
| 메모리 사용량 많음 (스레드 스택) | 메모리 효율적 |
| 동기 I/O (블로킹) | 비동기 I/O (논블로킹) |
| 동시 연결 수: 수백~수천 | 동시 연결 수: 수만~수십만 |

#### 블로킹의 위험성

이벤트 루프 스레드에서 블로킹 작업을 수행하면 **전체 서버가 멈춥니다**.

**잘못된 예시:**
```java
// Armeria 이벤트 루프 스레드에서 실행
public CompletableFuture<HttpResponse> serve(ServiceRequestContext ctx,
                                             HttpRequest req) {
    //  블로킹 I/O - 이벤트 루프가 멈춤!
    String data = blockingHttpClient.get("https://api.example.com");

    return HttpResponse.of(data);
}
```

**올바른 예시:**
```java
// 블로킹 작업은 별도 스레드 풀에서 실행
public CompletableFuture<HttpResponse> serve(ServiceRequestContext ctx,
                                             HttpRequest req) {
    //  비동기 처리
    return CompletableFuture.supplyAsync(() -> {
        // 블로킹 작업은 별도 스레드에서
        return blockingHttpClient.get("https://api.example.com");
    }, blockingExecutor)
    .thenApply(data -> HttpResponse.of(data));
}
```

**블로킹 시 문제:**
![](/uploads/theory/semaphore-mutex-sync/blocking-danger.svg)


**핵심 원칙:**
- 이벤트 루프 스레드에서는 절대 블로킹하지 말 것
- DB 쿼리, HTTP 호출, 파일 I/O는 모두 비동기로 처리
- 불가피한 블로킹 작업은 별도 스레드 풀 사용

> 출처: [LINE Engineering - 비동기 서버에서 이벤트 루프를 블록하면 안 되는 이유 1부](https://engineering.linecorp.com/ko/blog/do-not-block-the-event-loop-part1/)

## 뮤텍스와 세마포어 선택 기준

### 뮤텍스를 사용해야 하는 경우

1. **단일 공유 자원 보호**
   ```java
   // 파일 쓰기는 한 번에 하나만
   Lock fileLock = new ReentrantLock();
   fileLock.lock();
   try {
       writeToFile(data);
   } finally {
       fileLock.unlock();
   }
   ```

2. **소유권이 중요한 경우**
   ```java
   // Lock을 건 스레드만 Unlock
   Lock lock = new ReentrantLock();
   lock.lock();
   try {
       criticalSection();
   } finally {
       lock.unlock();  // 반드시 같은 스레드가 해제
   }
   ```

3. **재진입이 필요한 경우**
   ```java
   Lock lock = new ReentrantLock();
   public void outer() {
       lock.lock();
       try {
           inner();  // 재진입
       } finally {
           lock.unlock();
       }
   }
   ```

> 출처: [Stack Overflow - When to use mutex vs semaphore](https://stackoverflow.com/questions/34519/), [Baeldung - Semaphore vs. Mutex](https://www.baeldung.com/cs/semaphore-vs-mutex)

### 세마포어를 사용해야 하는 경우

1. **여러 개의 자원 관리**
   ```java
   // 데이터베이스 연결 풀 (10개)
   Semaphore dbPool = new Semaphore(10);
   dbPool.acquire();
   try {
       executeQuery();
   } finally {
       dbPool.release();
   }
   ```

2. **프로세스 간 동기화**
   ```c
   // 프로세스 A
   sem_wait(&shared_sem);
   // 공유 메모리 접근

   // 프로세스 B
   sem_post(&shared_sem);  // 다른 프로세스가 signal
   ```

3. **신호 메커니즘**
   ```java
   // 생산자-소비자
   Semaphore items = new Semaphore(0);  // 초기 아이템 0개

   // 생산자
   produceItem();
   items.release();  // 신호: 아이템 생산됨

   // 소비자
   items.acquire();  // 대기: 아이템이 있을 때까지
   consumeItem();
   ```

> 출처: [GeeksforGeeks - Mutex vs Semaphore](https://www.geeksforgeeks.org/mutex-vs-semaphore/), [Baeldung - Java Concurrency – Semaphore](https://www.baeldung.com/java-semaphore)

## 정리

뮤텍스와 세마포어는 모두 동기화를 위한 도구지만, 목적과 특성이 다릅니다.

**뮤텍스 (Mutex):**
- **잠금 메커니즘** (Locking Mechanism)
- 소유권이 있음 (Lock을 건 스레드만 Unlock)
- 이진 상태 (Locked/Unlocked)
- 단일 자원 보호
- 재진입은 구현에 따라 다름 (Java ReentrantLock: 가능, POSIX NORMAL: 불가)
- 예시: `synchronized`, `ReentrantLock`

**세마포어 (Semaphore):**
- **신호 메커니즘** (Signaling Mechanism)
- 소유권이 없음 (어떤 스레드든 signal 가능)
- 카운터 기반 (0 이상의 정수)
- 여러 자원 관리
- 프로세스 간 동기화
- 예시: `Semaphore(n)`

**선택 기준:**
- 임계영역 보호: 뮤텍스
- 자원 풀 관리: 세마포어
- 소유권 필요: 뮤텍스
- 프로세스 간 신호: 세마포어

**주의사항:**
- 데드락 방지 (순환 대기 제거)
- 우선순위 역전 (Priority Inheritance로 해결)
- 항상 Lock 해제 (finally 블록 사용)

## 참고 자료

### 공식 문서
- [Java Documentation - synchronized](https://docs.oracle.com/javase/tutorial/essential/concurrency/sync.html) - Java 동기화
- [Java Documentation - ReentrantLock](https://docs.oracle.com/javase/8/docs/api/java/util/concurrent/locks/ReentrantLock.html) - 재진입 가능 Lock
- [Java Documentation - Semaphore](https://docs.oracle.com/javase/8/docs/api/java/util/concurrent/Semaphore.html) - Java Semaphore
- [Oracle - Lock Interface](https://docs.oracle.com/javase/8/docs/api/java/util/concurrent/locks/Lock.html) - Lock 인터페이스
- [FreeRTOS Documentation - Priority Inheritance](https://www.freertos.org/Real-time-embedded-RTOS-mutexes.html) - RTOS 우선순위 상속

### 이론 및 개념
- [Wikipedia - Critical Section](https://en.wikipedia.org/wiki/Critical_section) - 임계영역 개념
- [Wikipedia - Mutual Exclusion](https://en.wikipedia.org/wiki/Mutual_exclusion) - 상호 배제
- [Wikipedia - Semaphore (programming)](https://en.wikipedia.org/wiki/Semaphore_(programming)) - 세마포어 이론
- [Wikipedia - Race Condition](https://en.wikipedia.org/wiki/Race_condition) - 경쟁 상태
- [Wikipedia - Priority Inversion](https://en.wikipedia.org/wiki/Priority_inversion) - 우선순위 역전
- [Wikipedia - Priority Inheritance](https://en.wikipedia.org/wiki/Priority_inheritance) - 우선순위 상속

### 기술 자료
- [GeeksforGeeks - Mutex vs Semaphore](https://www.geeksforgeeks.org/mutex-vs-semaphore/) - 뮤텍스 vs 세마포어
- [GeeksforGeeks - Process Synchronization](https://www.geeksforgeeks.org/introduction-of-process-synchronization/) - 프로세스 동기화
- [GeeksforGeeks - Semaphores in Process Synchronization](https://www.geeksforgeeks.org/operating-systems/semaphores-in-process-synchronization/) - 세마포어 활용
- [GeeksforGeeks - Race Condition](https://www.geeksforgeeks.org/introduction-of-process-synchronization/) - 경쟁 상태
- [GeeksforGeeks - Priority Inversion in Operating Systems](https://www.geeksforgeeks.org/priority-inversion-what-the-heck/) - 우선순위 역전 문제
- [Baeldung - Semaphore vs. Mutex](https://www.baeldung.com/cs/semaphore-vs-mutex) - 차이점 비교
- [Baeldung - Guide to synchronized](https://www.baeldung.com/java-synchronized) - synchronized 가이드
- [Baeldung - Binary Semaphore vs Reentrant Lock](https://www.baeldung.com/java-binary-semaphore-vs-reentrant-lock) - 이진 세마포어 vs Lock
- [Baeldung - Java Concurrency – Semaphore](https://www.baeldung.com/java-semaphore) - Java 세마포어
- [Medium - Mutex and Semaphore](https://medium.com/@irfanhaydararman/mutex-and-semaphore-e223321ddd7c) - 동기화 메커니즘

### 실무 사례
- [Rapita Systems - What Really Happened on Mars Pathfinder?](https://www.rapitasystems.com/blog/what-really-happened-software-mars-pathfinder-spacecraft) - Mars Pathfinder 우선순위 역전
- [UNC - What Really Happened on Mars?](https://www.cs.unc.edu/~anderson/teach/comp790/papers/mars_pathfinder_long_version.html) - 화성 탐사선 사례

### 고전 문제
- [Wikipedia - Dining Philosophers Problem](https://en.wikipedia.org/wiki/Dining_philosophers_problem) - 식사하는 철학자 문제
- [GeeksforGeeks - Dining Philosopher Problem Using Semaphores](https://www.geeksforgeeks.org/dining-philosopher-problem-using-semaphores/) - 철학자 문제 해결
- [GeeksforGeeks - Deadlock in Operating System](https://www.geeksforgeeks.org/introduction-of-deadlock-in-operating-system/) - 데드락

### 한글 자료
- [Velog - [OS]뮤텍스(Mutex)와 세마포어(Semaphore)](https://velog.io/@dodozee/뮤텍스Mutex와-세마포어Semaphore) - 뮤텍스와 세마포어
- [Velog - 뮤텍스(Mutex)와 세마포어(Semaphore)의 차이](https://velog.io/@heetaeheo/뮤텍스Mutex와-세마포어Semaphore의-차이) - 차이점 설명
- [Velog - [기술 면접] 세마포어와 뮤텍스 차이](https://velog.io/@logandev/세마포어와-뮤텍스-차이) - 이진 세마포어와 뮤텍스 차이
- [Velog - [Philosophers] 예시/예제로 보는 뮤텍스와 세마포어의 차이](https://velog.io/@hidaehyunlee/Philosophers-예시예제로-보는-뮤텍스와-세마포어의-차이) - 철학자 문제

### 한국 IT 기업 기술 블로그
- [우아한형제들 - WMS 재고 이관을 위한 분산 락 사용기](https://techblog.woowahan.com/17416/) - Redis 기반 분산 락을 통한 동시성 제어
- [우아한형제들 - MySQL을 이용한 분산락으로 여러 서버에 걸친 동시성 관리](https://techblog.woowahan.com/2631/) - MySQL GET_LOCK을 활용한 분산 락 구현
- [카카오페이 - 주니어 서버 개발자가 유저향 서비스를 개발하며 마주쳤던 이슈와 해결 방안](https://tech.kakaopay.com/post/troubleshooting-logs-as-a-junior-developer/) - 동시성 이슈와 Redis 분산 락 해결 방법
- [LINE Engineering - 비동기 서버에서 이벤트 루프를 블록하면 안 되는 이유 1부](https://engineering.linecorp.com/ko/blog/do-not-block-the-event-loop-part1/) - 멀티플렉싱 기반의 다중 접속 서버와 동시성
- [LINE Engineering - 비동기 서버에서 이벤트 루프를 블록하면 안 되는 이유 2부](https://engineering.linecorp.com/ko/blog/do-not-block-the-event-loop-part2/) - Java NIO와 멀티플렉싱
- [LINE Engineering - 비동기 서버에서 이벤트 루프를 블록하면 안 되는 이유 3부](https://engineering.linecorp.com/ko/blog/do-not-block-the-event-loop-part3/) - Reactor 패턴과 이벤트 루프
- [LINE Engineering - Don't block the event loop!](https://engineering.linecorp.com/ko/blog/dont-block-the-event-loop/) - JavaScript 비동기 처리와 동시성 제어

### 커뮤니티
- [Stack Overflow - What is the difference between lock, mutex and semaphore?](https://stackoverflow.com/questions/2332765/) - Lock, Mutex, Semaphore 차이
- [Stack Overflow - When to use mutex vs semaphore](https://stackoverflow.com/questions/34519/) - 선택 기준

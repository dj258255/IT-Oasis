---
title: 'JVM과 Garbage Collection 이해하기'
description: JVM 메모리 시리즈의 출발점. Class Loader, Runtime Data Areas, Execution Engine, JIT 컴파일러까지 JVM 아키텍처 전반을 정리하고, Heap 구조·GC 알고리즘 같은 메모리 세부 주제는 ①~⑤편으로 이어갑니다.
date: 2026-01-09T00:00:00.000Z
tags:
  - JVM
  - Garbage Collection
  - Java
  - G1 GC
  - ZGC
  - Memory Management
category: theory/JVM-Memory
draft: false
coverImage: "/uploads/theory/es-memory/cover-0.svg"
series: "JVM 메모리"
seriesOrder: 0
---

## 0. 이 글의 위치

이 글은 JVM이 어떻게 생겼는지를 한 그림으로 잡습니다. 목표는 딱 이것입니다:

- JVM이 `.class` 파일을 메모리에 어떻게 얹고(Class Loader)
- 프로그램 실행 중 어떤 메모리 영역을 쓰고(Runtime Data Areas)
- 바이트코드를 어떻게 기계어로 바꿔서 돌리는지(Execution Engine, JIT)
- 객체는 Heap 안에서 어떻게 배치되는지(Object Layout)

이 전반을 "한 그림"으로 잡아두는 것입니다.

---

## 1. JVM 아키텍처 개요

JVM(Java Virtual Machine)은 Java 바이트코드를 실행하는 가상 머신입니다. "Write Once, Run Anywhere"를 가능하게 하는 핵심 컴포넌트입니다.

![](/uploads/theory/jvm-and-gc/jvm-architecture.png)

> 출처: [The Java Virtual Machine Specification, Java SE 21](https://docs.oracle.com/javase/specs/jvms/se21/html/jvms-2.html)

크게 세 개의 서브시스템으로 나눠서 볼 수 있습니다.

1. **Class Loader Subsystem**: `.class` 파일을 읽어 메모리에 얹고 링크하는 역할
2. **Runtime Data Areas**: 실행 중에 쓰는 메모리 (Method Area, Heap, Stack, PC Register, Native Method Stack)
3. **Execution Engine**: 바이트코드를 해석(Interpreter)하거나 네이티브로 컴파일(JIT)해서 실행

---

## 2. Class Loader Subsystem

![](/uploads/theory/jvm-and-gc/class-loader-subsystem.png)

### 2.1 3단계 Class Loader 계층 (JDK 9+)

Java 9 모듈 시스템 도입 이후 built-in class loader가 다음 3개로 재정의됐습니다. **Extension class loader가 Platform class loader로 교체**된 게 핵심 변화입니다.

| 계층 | 이름 | 역할 |
|---|---|---|
| 1 | **Bootstrap** | JDK 내부 핵심 클래스(`java.lang.*` 등) 로딩. 부모 없음 (`null`). |
| 2 | **Platform** (JDK 9+) | Java SE Platform API와 JDK 런타임 클래스 로딩 (구 Extension 대체) |
| 3 | **Application (System)** | 애플리케이션 classpath/모듈 path의 클래스 로딩 |

```java
System.out.println(String.class.getClassLoader());      // null (Bootstrap)
System.out.println(javax.sql.DataSource.class.getClassLoader()); // PlatformClassLoader
System.out.println(MyClass.class.getClassLoader());     // AppClassLoader
```

> 출처: [ClassLoader — Java SE 17 API](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/lang/ClassLoader.html)

### 2.2 Parent Delegation Model

![](/uploads/theory/jvm-and-gc/parent-delegation-model.png)

**동작 방식**:

1. 클래스 로드 요청이 들어오면 **부모에게 먼저 위임**
2. 부모가 찾지 못하면 자신이 로드 시도
3. 어디서도 못 찾으면 `ClassNotFoundException`

**왜 이렇게 하나?**

- **보안**: 악의적인 `java.lang.String` 로드 방지 (언제나 Bootstrap이 먼저 집어감)
- **일관성**: 핵심 클래스는 항상 같은 버전이 쓰이도록 보장

> 출처: [Class Loaders in Java - Baeldung](https://www.baeldung.com/java-classloaders)

### 2.3 Loading → Linking → Initialization

![](/uploads/theory/jvm-and-gc/linking-process.png)

**Loading**: `.class` 바이트 읽어서 Method Area에 클래스 구조 생성.

**Linking** (3단계)

1. **Verify**: 바이트코드가 JVM 명세에 맞는지 검증 (보안·타입 안전성 체크)
2. **Prepare**: static 변수 메모리 할당, 기본값 초기화 (`0`, `null`, `false` 등)
3. **Resolve**: 심볼릭 참조 → 실제 메모리 주소 (lazy하게 수행될 수 있음)

**Initialization**

![](/uploads/theory/jvm-and-gc/initialization.png)

static 변수에 **실제 값** 할당, `static {}` 블록 실행. 이 시점부터 클래스가 "사용 가능" 상태가 됩니다.

---

## 3. Runtime Data Areas

JVM이 프로그램 실행 중 사용하는 메모리 영역들입니다.

![](/uploads/theory/jvm-and-gc/runtime-data-areas.png)
![](/uploads/theory/jvm-and-gc/runtime-data-areas-2.png)

스레드 공유 영역과 스레드별 영역으로 나뉩니다.

- **모든 스레드 공유**: Method Area(Metaspace), Heap
- **스레드별 생성**: JVM Stack, PC Register, Native Method Stack

### 3.1 Method Area (Metaspace)

- **Java 8 이전**: PermGen (Permanent Generation)
- **Java 8 이후**: **Metaspace** (Native Memory 사용)

저장 내용:

- 클래스 구조 (필드/메서드 정보)
- Runtime Constant Pool
- 메서드 바이트코드
- static 변수

```bash
# Metaspace 크기 설정 (Java 8+)
-XX:MetaspaceSize=128m        # 초기 크기
-XX:MaxMetaspaceSize=256m     # 최대 크기 (기본: 무제한)
```

**PermGen → Metaspace 변경 이유**

- PermGen은 Heap의 일부로 관리됐고 크기 제한 때문에 `OutOfMemoryError: PermGen space`가 자주 발생했습니다.
- Metaspace는 Native Memory를 써서 자동으로 확장 가능합니다.

![](/uploads/theory/jvm-and-gc/permgen-to-metaspace.png)

> 참고: Java 7부터 static 변수의 참조는 Heap으로 이동했습니다. Metaspace에는 클래스 메타데이터만 남아 있습니다.

> 출처: [About G1 Garbage Collector, Permanent Generation, and Metaspace - Oracle](https://blogs.oracle.com/poonam/post/about-g1-garbage-collector-permanent-generation-and-metaspace)

### 3.2 Heap

모든 객체와 배열이 할당되는 영역이며, **GC의 주요 대상**입니다.

```java
User user = new User();   // Heap에 생성
int[] arr = new int[10];  // 배열도 Heap에 생성
```

Heap의 **세대별 구조**(Young/Old/Eden/Survivor), **Minor GC → Promotion → Full GC** 흐름, **NewRatio/SurvivorRatio** 같은 튜닝 파라미터는 이 시리즈의 ①편에서 1차 소스 기준으로 자세히 다뤘습니다.

[**① JVM Heap의 세대별 구조**](/blog/theory/es-memory-01-jvm-heap)

### 3.3 JVM Stack (스레드별)

각 스레드마다 별도로 생성되며 **Stack Frame**들의 집합입니다.

![](/uploads/theory/jvm-and-gc/jvm-stack.png)

**Stack Frame 구성요소**:

1. **Local Variables Array**: 지역 변수, 메서드 파라미터
2. **Operand Stack**: 연산 중간값
3. **Frame Data**: 리턴 주소, 예외 테이블 참조 등

```java
public int calculate(int a, int b) {
    int sum = a + b;    // Local Variables: [this, a, b, sum]
    return sum * 2;
}

// 바이트코드 (Operand Stack 사용)
// iload_1        // a를 Operand Stack에 push
// iload_2        // b를 Operand Stack에 push
// iadd           // pop 2개, 더해서 push
// istore_3       // pop해서 sum(index 3)에 저장
```

**스택 크기 설정**:

```bash
-Xss512k   # 스레드당 스택 크기 (기본: 1MB)
```

**StackOverflowError**:

```java
void infinite() {
    infinite();  // 무한 재귀 → Stack Frame 계속 쌓임 → overflow
}
```

> 출처: [The Java Virtual Machine Specification — §2.5 Run-Time Data Areas](https://docs.oracle.com/javase/specs/jvms/se21/html/jvms-2.html#jvms-2.5)

### 3.4 PC Register & Native Method Stack

**PC Register**: 현재 실행 중인 명령어의 주소를 저장. 스레드마다 별도로 존재합니다. (Native 메서드 실행 중이면 undefined)

**Native Method Stack**: JNI(Java Native Interface)로 호출되는 네이티브 메서드(C/C++)용 스택.

![](/uploads/theory/jvm-and-gc/native-method-stack.png)

---

## 4. Execution Engine

![](/uploads/theory/jvm-and-gc/execution-engine.png)

바이트코드를 실제 기계어로 변환해서 실행합니다. **Interpreter + JIT Compiler** 조합이 HotSpot의 핵심입니다.

### 4.1 Interpreter

바이트코드를 한 줄씩 읽어서 실행합니다. **시작은 빠르지만 반복 실행 시 느립니다**.

![](/uploads/theory/jvm-and-gc/interpreter.png)

### 4.2 JIT Compiler (Just-In-Time)

![](/uploads/theory/jvm-and-gc/jit-compiler.png)

자주 실행되는 코드(**Hot Spot**)를 **네이티브 코드로 컴파일**하여 캐싱합니다.

![](/uploads/theory/jvm-and-gc/jit-compilation-flow.png)

1. 바이트코드 (인터프리터로 실행)
2. 프로파일링 (실행 횟수 측정: 메서드/루프)
3. Hot Spot 감지 (임계값 초과)
4. 컴파일 (네이티브 코드 생성)

→ 다음 호출부터:

1. 메서드 호출
2. 코드 캐시 확인
3. 네이티브 코드 직접 실행

### 4.3 Tiered Compilation

![](/uploads/theory/jvm-and-gc/tiered-compilation.png)

HotSpot은 두 개의 JIT 컴파일러를 **단계적으로** 결합합니다.

| Tier | 컴파일러 | 용도 |
|---|---|---|
| 0 | Interpreter | 초기 실행, 프로파일링 |
| 1~3 | **C1** (Client) | 빠른 컴파일, 가벼운 최적화, 프로파일링 데이터 수집 |
| 4 | **C2** (Server) | 공격적 최적화, 오랜 컴파일 시간, 최고 성능 |

코드는 0 → 3 → 4 식으로 단계적으로 승급됩니다. 초반엔 C1으로 빠르게 돌리다가 정말 뜨거운 코드만 C2로 재컴파일됩니다.

### 4.4 JIT 최적화 기법

**1) Inlining**: 메서드 호출을 본문으로 대체

![](/uploads/theory/jvm-and-gc/inlining.png)

**2) Loop Unrolling**: 루프 반복 줄이기

![](/uploads/theory/jvm-and-gc/loop-unrolling.png)

**3) Escape Analysis**: 객체가 메서드 밖으로 탈출하지 않으면 스택에 할당

![](/uploads/theory/jvm-and-gc/escape-analysis.png)

**4) Dead Code Elimination**: 사용되지 않는 코드 제거

```bash
# JIT 관련 옵션
-XX:+PrintCompilation              # 컴파일되는 메서드 출력
-XX:CompileThreshold=10000         # 컴파일 임계값 (Tiered 꺼졌을 때만 유효)
-XX:-TieredCompilation             # Tiered Compilation 비활성화
```

> 참고: Tiered Compilation이 활성화된 상태(Java 8+ 기본값)에서는 `CompileThreshold`가 무시됩니다. 각 레벨별로 별도 임계값이 쓰입니다.

> 출처: [Java HotSpot Virtual Machine Performance Enhancements - Oracle](https://docs.oracle.com/en/java/javase/17/vm/java-hotspot-virtual-machine-performance-enhancements.html)

---

## 5. Object Memory Layout

Java 객체가 Heap에서 어떻게 저장되는지 살펴보겠습니다.

![](/uploads/theory/jvm-and-gc/object-memory-layout.png)

객체는 대략 세 부분으로 구성됩니다.

1. **Object Header** (12~16 byte): Mark Word(락·GC 정보) + Class Pointer
2. **Instance Data**: 필드 값들 (alignment 맞춰 정렬)
3. **Padding**: 8-byte alignment 맞추기 위한 채움

![](/uploads/theory/jvm-and-gc/object-size-example.png)

**Compressed OOPs (Ordinary Object Pointers)**:

- Heap 크기가 **32GB 미만이면 자동 활성화**
- 64-bit 포인터를 32-bit narrow oop로 압축 → 메모리 절약 + 캐시 효율 향상

```bash
-XX:+UseCompressedOops     # 기본 활성화 (힙 < 32GB)
-XX:-UseCompressedOops     # 비활성화
```

> 왜 정확히 32GB까지 가능한지, Elasticsearch가 "힙 26~30GB에서 끊어라"라고 권고하는 이유(zero-based compressed oops)는 ⑤편의 [Compressed OOPs와 32GB 한계](/blog/theory/es-memory-05-elasticsearch#3-원칙-2-compressed-oops와-32gb-한계) 섹션에서 깊게 다뤘습니다.

> 출처: [HotSpot Glossary - OpenJDK](https://openjdk.org/groups/hotspot/docs/HotSpotGlossary.html)

---

## 6. String Pool과 Interning

String은 특별 취급됩니다. **String Pool**에서 중복을 제거합니다.

![](/uploads/theory/jvm-and-gc/string-pool.png)

```java
String s1 = "hello";              // String Pool에서 가져옴
String s2 = "hello";              // 같은 객체 참조
String s3 = new String("hello");  // 새 객체 생성 (Pool 아님)
String s4 = s3.intern();          // Pool에 있는 객체 반환

System.out.println(s1 == s2);     // true (같은 참조)
System.out.println(s1 == s3);     // false (다른 객체)
System.out.println(s1 == s4);     // true (intern으로 Pool 참조)
```

**Java 7+**: String Pool이 PermGen에서 Heap으로 이동 → GC 대상이 됨.

```bash
-XX:StringTableSize=60013   # String Pool 해시 테이블 크기 (기본 60013)
```

> 출처: [String Constant Pool - Baeldung](https://www.baeldung.com/java-string-pool)

---

## 7. Garbage Collection의 존재 이유

프로그래머가 직접 메모리를 해제하지 않아도 **JVM이 사용하지 않는 객체를 자동 회수**해주는 시스템이 GC입니다.

![](/uploads/theory/jvm-and-gc/gc-overview.png)

편하지만 공짜는 아닙니다. GC가 돌 때 **Stop-the-World(STW)**라는 성능 비용이 발생합니다. 그래서 JVM 튜닝의 핵심이 GC 튜닝입니다.

이 시리즈는 GC를 두 편으로 나눠서 다뤘습니다.

- [**① JVM Heap의 세대별 구조**](/blog/theory/es-memory-01-jvm-heap): 어디서 객체가 살고 죽는지 (Generational Hypothesis, Young/Old, TLAB, Promotion, Premature Promotion)
- [**② GC 알고리즘과 Stop-the-World**](/blog/theory/es-memory-02-gc): 어떻게 회수하는지 (Safepoint, Mark-Sweep-Compact, Serial/Parallel/G1/ZGC/Shenandoah, JDK 17 default)

그 다음 편들은 GC 영역 바깥까지 확장합니다:

- [**③ JVM Off-heap과 Direct Memory**](/blog/theory/es-memory-03-off-heap): Heap 바깥의 DirectByteBuffer, mmap, Foreign Memory API
- [**④ OS Page Cache가 ES 성능을 결정하는 이유**](/blog/theory/es-memory-04-page-cache): Linux 커널 관점
- [**⑤ 힙 50% 룰 · mmap · Circuit Breaker**](/blog/theory/es-memory-05-elasticsearch): Elasticsearch 운영 맥락으로 통합

---

## 8. 정리: JVM을 한 문장으로

> "JVM은 **Class Loader가 `.class`를 메모리에 얹고**, **Runtime Data Areas에 객체·스택·메타데이터를 배치**하고, **Execution Engine(인터프리터 + JIT)이 바이트코드를 기계어로 번역·실행**하는 가상 머신이며, 그 과정에서 Heap에 남은 쓰레기를 **GC가 주기적으로 회수**한다."

이 한 문장이 성립한다면 0편의 목표는 달성된 것입니다. 구체적인 메모리 내부와 성능 튜닝은 ①편부터 이어서 읽으면 됩니다.

---

## 참고 문헌

- [The Java Virtual Machine Specification, Java SE 21](https://docs.oracle.com/javase/specs/jvms/se21/html/jvms-2.html)
- [ClassLoader — Java SE 17 API](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/lang/ClassLoader.html)
- [Class Loaders in Java - Baeldung](https://www.baeldung.com/java-classloaders)
- [About G1, PermGen, Metaspace - Oracle Blogs](https://blogs.oracle.com/poonam/post/about-g1-garbage-collector-permanent-generation-and-metaspace)
- [Java HotSpot Virtual Machine Performance Enhancements - Oracle](https://docs.oracle.com/en/java/javase/17/vm/java-hotspot-virtual-machine-performance-enhancements.html)
- [HotSpot Glossary - OpenJDK](https://openjdk.org/groups/hotspot/docs/HotSpotGlossary.html)
- [String Constant Pool - Baeldung](https://www.baeldung.com/java-string-pool)

---

**이어지는 글**: [① JVM Heap의 세대별 구조](/blog/theory/es-memory-01-jvm-heap)

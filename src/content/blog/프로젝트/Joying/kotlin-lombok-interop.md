---
title: 'Lombok이 코틀린이랑 연동이 쉽지 않은 이유'
titleEn: 'Why Lombok and Kotlin Interop Is Not Easy'
description: Kotlin + Java + Lombok 환경에서 발생하는 빌드 순서 문제와 Enum 호환성 이슈를 분석하고, kotlin-plugin-lombok + io.freefair.lombok + delombok 조합으로 해결한 과정을 정리한다.
descriptionEn: Analyzes build order issues and Enum compatibility problems in Kotlin + Java + Lombok environments, and resolves them with kotlin-plugin-lombok, io.freefair.lombok, and delombok.
date: 2025-11-01T00:00:00.000Z
tags:
  - Kotlin
  - Java
  - Lombok
  - Gradle
  - delombok
category: 프로젝트/Joying
draft: false
---

## 들어가며

이번 프로젝트에서 채팅 기능을 새로 개발하게 됐다.
기존 코드는 전부 Java + Lombok으로 되어있는데, 새 기능은 Kotlin으로 작성하기로 했다.
Kotlin이 Java와 100% 호환된다고 하니까 문제없을 줄 알았다.

근데 아니었다.

## 문제 발견: Lombok이 안 보인다고?

채팅방 컨트롤러를 Kotlin으로 작성하다가 기존 Java 엔티티를 사용하려고 했다.

![](/uploads/kotlin-lombok-interop/problem-found.svg)


이런식으로 다른 팀원이 만든 코드에 접근하려고 했다.

그런데 빌드하니까 이런 에러가 떴다.

```
e: Unresolved reference 'getProductId'.
e: Unresolved reference 'getTitle'.
e: Unresolved reference 'getMemberId'.
```

Java 엔티티는 분명히 Lombok `@Getter`를 사용하고 있었다.

![](/uploads/kotlin-lombok-interop/problem-found-2.svg)


왜 Kotlin이 이걸 못 찾는거지?

## 첫 번째 시도: 프로퍼티 접근으로 바꿔보자

Kotlin은 getter를 자동으로 프로퍼티로 변환해준다고 했으니까, 이렇게 바꿔봤다.

![](/uploads/kotlin-lombok-interop/first-attempt.svg)


결과는?


e: Cannot access 'field productId: Long!': it is private in 'Product'

당연히 안된다. Lombok이 getter를 만들어주기 전이니까 private 필드에 직접 접근하려고 하는 거였다.

## 두 번째 시도: kapt에 Lombok 추가

Kotlin annotation processing을 사용하면 되지 않을까 싶어서 kapt에 Lombok을 추가해봤다.

![](/uploads/kotlin-lombok-interop/second-attempt.svg)


이것도 안됐다. kapt는 Kotlin annotation processing이지 Java annotation processing이 아니었다.

그리고 생각해보니 빌드 순서의 문제인가?

`--dry-run`으로 확인해봤다.

```bash
./gradlew compileJava --dry-run
```

```
:kaptGenerateStubsKotlin SKIPPED
:kaptKotlin SKIPPED
:compileKotlin SKIPPED
:compileJava SKIPPED
```

순서를 보면

1. **kapt 실행** (Kotlin annotation processing)
2. **Kotlin 소스 컴파일** (`compileKotlin`)
3. **Java annotation processing 실행** (Lombok 등)
4. **Java 소스 컴파일** (`compileJava`)

인데 알아보니 Gradle에서 Kotlin과 Java를 함께 사용할 때 기본 빌드 순서는 저런식으로 작동한다.

Kotlin이 먼저 컴파일되는데, 그 시점에는 Lombok이 getter를 아직 안 만들어놨으니 당연히 못 찾는거였다.


### 빌드 순서 문제를 좀 더 자세히 알아보자


![](/uploads/kotlin-lombok-interop/build-order.svg)


![](/uploads/kotlin-lombok-interop/build-order-2.svg)


타이밍이 안 맞는다. Kotlin이 너무 일찍 컴파일되는 거다.

## 세 번째 시도: 빌드 순서를 바꿔보자

그럼 Java를 먼저 컴파일하면 되지 않을까? Kotlin 컴파일 태스크가 Java 컴파일을 기다리게 만들어봤다.

![](/uploads/kotlin-lombok-interop/third-attempt.svg)


결과는?

```
FAILURE: Build failed with an exception.
* What went wrong:
Circular dependency between the following tasks:
:compileJava
+--- :compileKotlin
     \--- :compileJava (*)
```

순환 의존성이 발생했다. Java도 Kotlin 코드를 참조하니까 서로 기다리는 상황이 된 거다.

```
compileKotlin → compileJava를 기다림
compileJava → compileKotlin을 기다림
...무한 대기...
```

막막했다. 빌드 순서를 바꿀 수도 없고, kapt로도 안되고... 이거 어떻게 해결하지?

## 진짜 해결책: Kotlin Lombok 플러그인

찾아보니까 Kotlin 1.7.20 버전부터 Lombok 플러그인을 공식 지원한다고 한다.

![](/uploads/kotlin-lombok-interop/solution.svg)


이 플러그인을 추가하니까 Kotlin 컴파일러가 Lombok 어노테이션을 인식할 수 있게 됐다.

### kotlin("plugin.lombok")이 뭘 하는거지?

이 플러그인은 Kotlin 컴파일러가 Java 소스의 Lombok 어노테이션을 미리 읽고, 마치 getter/setter가 이미 존재하는 것처럼 처리하게 만든다.

![](/uploads/kotlin-lombok-interop/kotlinpluginlombok.svg)


Kotlin 컴파일러가 이걸 보면:

![](/uploads/kotlin-lombok-interop/kotlinpluginlombok-2.svg)


그래서 Kotlin 코드에서 `getProductId()`를 호출해도 컴파일 에러가 안 난다.

```
BUILD SUCCESSFUL in 1s
```

드디어 Kotlin 컴파일이 성공했다!

...근데 기뻐한 것도 잠시, 또 다른 에러가 떴다.

## 또 다른 문제: Java 컴파일도 실패한다

```
> Task :compileJava FAILED
error: cannot find symbol
  symbol:   method getProductId()
  location: class Product

error: cannot find symbol
  symbol:   method builder()
  location: class Member
```

이번엔 Java 컴파일이 실패했다. Java 파일에서 Lombok getter를 못 찾는다고?

`build/generated/sources` 디렉토리를 확인해보니 비어있었다. Lombok이 코드를 생성하지 않은 거였다.

Gradle에서 Java annotation processor가 제대로 실행되지 않았다.

### 왜 Java annotation processing이 안 됐을까?

`kotlin("plugin.lombok")`은 **Kotlin 컴파일러만** 도와준다. Java 컴파일에는 영향을 주지 않는다.

Java 컴파일을 위해서는 여전히 Lombok annotation processor가 제대로 실행되어야 하는데, Gradle 설정이 부족했던 거다.

IntelliJ로 빌드하면 되긴 했다. IntelliJ는 자체적으로 Lombok 플러그인이 있어서 IDE에서 빌드하면 잘 됐다.

하지만 그건 해결책이 아니었다. **배포 CI/CD 환경에서도 통해야 하는데, 거기서는 Gradle만 사용하니까.**

## 완벽한 해결: io.freefair.lombok 플러그인

Gradle에서 Java Lombok annotation processing을 제대로 처리하려면 또 다른 플러그인이 필요했다.

![](/uploads/kotlin-lombok-interop/solution-2.svg)


### 두 개의 플러그인이 필요한 이유

이제 정리하면:

| 플러그인 | 역할 | 대상 |
|---------|------|------|
| `kotlin("plugin.lombok")` | Kotlin 컴파일러가 Lombok을 "인식"하게 함 | Kotlin 컴파일 |
| `io.freefair.lombok` | Java annotation processing을 실제로 "실행"함 | Java 컴파일 |

두 플러그인은 **각자 다른 역할**을 한다:
- 첫 번째는 Kotlin이 "getter가 있을 거야"라고 가정하게 만듦
- 두 번째는 Java에서 실제로 getter를 생성함

이 플러그인을 추가하니까 Java 컴파일도 성공했다.

```
BUILD SUCCESSFUL in 4s
```

드디어! 끝났다고 생각했는데...

## 세 번째 문제: Enum이 또 터졌다

```
> Task :compileJava FAILED
error: constructor UploadType in enum UploadType cannot be applied to given types;
    BORROW("구해요"),
          ^
  required: no arguments
  found:    String
  reason: actual and formal argument lists differ in length
```

이번엔 Enum이 문제였다. 프로젝트에 있는 모든 Enum이 이런 식으로 작성되어 있었다.

![](/uploads/kotlin-lombok-interop/third-problem.svg)

![](/uploads/kotlin-lombok-interop/third-problem-2.svg)


Enum에 `@RequiredArgsConstructor`를 썼는데, Lombok이 생성자를 안 만들어주는 거였다.

### 왜 Enum에서 안 될까?

일반 클래스에서는 `@RequiredArgsConstructor`가 잘 작동했다. 근데 Enum에서만 안됐다.

원인은 `kotlin("plugin.lombok")` 플러그인과의 호환성 문제였다. 이 플러그인은 Enum의 `@RequiredArgsConstructor`를 제대로 처리하지 못한다.

### 일반적인 해결 방법

보통은 Enum에서 Lombok을 쓰지 않고 직접 생성자를 작성한다.

![](/uploads/kotlin-lombok-interop/solution-3.svg)


하지만 내 상황에서는 **Java 파일을 건드릴 수 없었다. 왜냐하면 내가 맡은 역할도 아니고 수정했다가 여기저기 터질 수도 있기 때문이다**. 기존 코드를 수정하지 않고 해결해야 했다.

## Enum 문제 해결: delombok으로 우회

Java 파일을 수정하지 않으려면 다른 방법이 필요했다.

### delombok이 뭐지?

`delombok`은 Lombok 어노테이션을 실제 Java 코드로 변환해주는 도구다.

![](/uploads/kotlin-lombok-interop/delombok.svg)


delombok을 실행하면:

![](/uploads/kotlin-lombok-interop/delombok-2.svg)


보다시피 **생성자가 제대로 만들어졌다.**

### delombok 실행해보기

`io.freefair.lombok` 플러그인은 자동으로 `delombok` 태스크를 제공한다.

```bash
./gradlew delombok
```

```
> Task :generateEffectiveLombokConfig UP-TO-DATE
> Task :delombok

BUILD SUCCESSFUL in 2s
```

생성된 파일을 확인해보니:

```bash
ls build/generated/sources/delombok/java/main/com/joying/product/domain/
```

```
Product.java
UploadType.java
RentMethod.java
...
```

모든 Java 파일이 Lombok 어노테이션 없이 순수 Java 코드로 변환되어 있었다!

### Java 컴파일이 delombok된 소스를 사용하게 만들기

이제 Java 컴파일 태스크가 원본 소스 대신 delombok된 소스를 사용하도록 설정만 바꾸면 된다.
![](/uploads/kotlin-lombok-interop/delombok-3.svg)


이렇게 하면:

1. Java 컴파일 전에 자동으로 `delombok` 실행
2. 원본 소스(`src/main/java`) 대신 변환된 소스(`build/generated/...`) 사용
3. 변환된 소스에는 이미 생성자가 있으니 컴파일 성공!

### 최종 빌드 실행

```bash
./gradlew clean build -x test
```

```
> Task :delombok
> Task :compileKotlin
> Task :compileJava
> Task :classes
> Task :bootJar
> Task :assemble
> Task :build

BUILD SUCCESSFUL in 8s
```

**완벽하게 성공했다!**

## 정리 및 최종 설정

최종적으로 정리한 `build.gradle.kts` 설정은 이렇다.
![](/uploads/kotlin-lombok-interop/summary.svg)


### 중요한 포인트 정리

1. **두 개의 Lombok 플러그인 모두 필요**
   - `kotlin("plugin.lombok")`: Kotlin 컴파일용
   - `io.freefair.lombok`: Java 컴파일용

2. **수동으로 Lombok 의존성 추가 불필요**
   - `io.freefair.lombok` 플러그인이 알아서 처리
   - `compileOnly("org.projectlombok:lombok")` 같은 거 필요 없음

3. **delombok으로 Enum 문제 해결**
   - Java 원본 코드를 수정하지 않음
   - 컴파일 시 delombok된 소스 사용

4. **CI/CD 환경에서도 동일하게 작동**
   - IntelliJ 의존성 없음
   - Gradle만으로 완벽하게 빌드

5. **불필요한 configurations 블록 제거**
   - 오히려 충돌 발생시킬 수 있음

## 빌드 순서 다이어그램

최종 빌드 순서는 이렇게 된다:


![](/uploads/kotlin-lombok-interop/build-order.png)


### 각 단계별 설명

**1단계**: Lombok 설정 파일 생성 (lombok.config가 없으면 기본값 사용)

**2단계**: 모든 Java 소스의 Lombok 어노테이션을 실제 코드로 변환
- `@Getter` → `public String getXxx()` 메서드 생성
- `@RequiredArgsConstructor` → 생성자 생성
- `@Builder` → builder() 메서드와 Builder 클래스 생성

**3단계**: Kotlin annotation processing (kapt) 스텁 생성

**4단계**: Kotlin 소스 컴파일
- `kotlin("plugin.lombok")` 덕분에 Java Lombok getter를 인식
- `chatRoom.product.getProductId()` 같은 코드가 컴파일됨

**5단계**: Java 소스 컴파일
- 원본 소스가 아닌 delombok된 소스 사용
- 이미 모든 코드가 생성되어 있어서 에러 없음

**6~8단계**: 클래스 파일 패키징 및 빌드

## 결론

Kotlin과 Java의 상호 운용성은 런타임에서는 거의 완벽하지만, **컴파일 타임에는 여전히 함정이 있다.** 특히 Lombok처럼 annotation processing에 의존하는 라이브러리를 사용할 때는 더욱 그렇다.

### 핵심 문제: 빌드 순서

```
Kotlin 컴파일 (2단계) → Java annotation processing (3단계) → Java 컴파일 (4단계)
```

Kotlin이 먼저 컴파일되는데, 그 시점에는 Lombok이 getter를 아직 생성하지 않았다. 그래서 Kotlin이 Java Lombok getter를 찾지 못하는 것이다.

### 최종 해결책: 3가지 조합

1. **kotlin("plugin.lombok")**: Kotlin 컴파일러가 Lombok 어노테이션을 미리 인식
2. **io.freefair.lombok**: Gradle에서 Java annotation processing 올바르게 실행
3. **delombok + source 변경**: Enum의 `@RequiredArgsConstructor` 문제 우회

이 세 가지를 모두 적용해야 완벽하게 작동한다.

### 트레이드오프

Java 원본 코드를 수정하지 않고 CI/CD에서 Gradle만으로 빌드할 수 있게 됐다. 대신 빌드 설정이 복잡해졌고, delombok 때문에 빌드 시간이 약간 늘어난다(첫 빌드만 체감됨, 이후는 캐시). 새 팀원이 이 설정을 이해하려면 설명이 필요하다는 점도 고려해야 한다.

`kotlin("plugin.lombok")`은 Kotlin 2.0부터 Stable이지만, 이번 Enum 문제처럼 모든 Lombok 기능을 완벽히 지원하지는 않는다.

---

## 참고 자료

- [Kotlin Lombok Compiler Plugin (공식 문서)](https://kotlinlang.org/docs/lombok.html)
- [io.freefair.lombok Gradle Plugin](https://plugins.gradle.org/plugin/io.freefair.lombok)
- [Kotlin 1.7.20 Release Notes](https://kotlinlang.org/docs/whatsnew1720.html#support-for-the-lombok-compiler-plugin)
- [Lombok delombok 사용법](https://projectlombok.org/features/delombok)

## 환경

- Kotlin 2.1.0
- Spring Boot 3.5.6
- Gradle 8.x
- Java 17
- Lombok (버전은 io.freefair.lombok 플러그인이 자동 관리)

<!-- EN -->

## Introduction

A new chat feature was being developed for the project. The existing codebase was entirely in Java + Lombok, but the new feature was to be written in Kotlin. Since Kotlin is supposedly 100% compatible with Java, there shouldn't be any problems.

But there were.

## Problem Discovery: Lombok Is Invisible?

While writing the chatroom controller in Kotlin, I tried to use existing Java entities.

![](/uploads/kotlin-lombok-interop/problem-found.svg)

I was trying to access code written by another team member.

But when building, these errors appeared:

```
e: Unresolved reference 'getProductId'.
e: Unresolved reference 'getTitle'.
e: Unresolved reference 'getMemberId'.
```

The Java entities were clearly using Lombok `@Getter`.

![](/uploads/kotlin-lombok-interop/problem-found-2.svg)

Why can't Kotlin find them?

## First Attempt: Switch to Property Access

Since Kotlin automatically converts getters to properties, I tried this:

![](/uploads/kotlin-lombok-interop/first-attempt.svg)

Result?

e: Cannot access 'field productId: Long!': it is private in 'Product'

Of course it didn't work. Since Lombok hasn't created the getters yet, it was trying to directly access private fields.

## Second Attempt: Add Lombok to kapt

I thought using Kotlin annotation processing might work, so I added Lombok to kapt.

![](/uploads/kotlin-lombok-interop/second-attempt.svg)

This didn't work either. kapt is for Kotlin annotation processing, not Java annotation processing.

Then I thought — could this be a build order problem?

I checked with `--dry-run`:

```bash
./gradlew compileJava --dry-run
```

```
:kaptGenerateStubsKotlin SKIPPED
:kaptKotlin SKIPPED
:compileKotlin SKIPPED
:compileJava SKIPPED
```

The order is:

1. **kapt execution** (Kotlin annotation processing)
2. **Kotlin source compilation** (`compileKotlin`)
3. **Java annotation processing** (Lombok etc.)
4. **Java source compilation** (`compileJava`)

Kotlin compiles first, but at that point Lombok hasn't generated the getters yet — so naturally they can't be found.

### Understanding the Build Order Problem

![](/uploads/kotlin-lombok-interop/build-order.svg)

![](/uploads/kotlin-lombok-interop/build-order-2.svg)

The timing doesn't match. Kotlin compiles too early.

## Third Attempt: Change the Build Order

What if Java compiles first? I made the Kotlin compile task depend on Java compilation.

![](/uploads/kotlin-lombok-interop/third-attempt.svg)

Result?

```
FAILURE: Build failed with an exception.
* What went wrong:
Circular dependency between the following tasks:
:compileJava
+--- :compileKotlin
     \--- :compileJava (*)
```

A circular dependency occurred. Since Java also references Kotlin code, they end up waiting for each other.

## The Real Solution: Kotlin Lombok Plugin

It turns out that since Kotlin 1.7.20, there's official Lombok plugin support.

![](/uploads/kotlin-lombok-interop/solution.svg)

This plugin lets the Kotlin compiler read Lombok annotations from Java sources and treat them as if the getters/setters already exist.

![](/uploads/kotlin-lombok-interop/kotlinpluginlombok.svg)

![](/uploads/kotlin-lombok-interop/kotlinpluginlombok-2.svg)

```
BUILD SUCCESSFUL in 1s
```

Kotlin compilation succeeded! But then another error appeared.

## Another Problem: Java Compilation Also Fails

```
> Task :compileJava FAILED
error: cannot find symbol
  symbol:   method getProductId()
  location: class Product
```

`kotlin("plugin.lombok")` only helps the **Kotlin compiler**. It has no effect on Java compilation. The `io.freefair.lombok` plugin was needed to properly run Java annotation processing in Gradle.

![](/uploads/kotlin-lombok-interop/solution-2.svg)

| Plugin | Role | Target |
|--------|------|--------|
| `kotlin("plugin.lombok")` | Makes Kotlin compiler "recognize" Lombok | Kotlin compilation |
| `io.freefair.lombok` | Actually "runs" Java annotation processing | Java compilation |

## Third Problem: Enums Broke Too

```
> Task :compileJava FAILED
error: constructor UploadType in enum UploadType cannot be applied to given types;
```

Enums using `@RequiredArgsConstructor` failed due to a compatibility issue with the `kotlin("plugin.lombok")` plugin.

![](/uploads/kotlin-lombok-interop/third-problem.svg)

I couldn't modify the Java files since they weren't my responsibility and changes could break things elsewhere.

## Enum Fix: Workaround with delombok

`delombok` converts Lombok annotations into actual Java code.

![](/uploads/kotlin-lombok-interop/delombok.svg)

![](/uploads/kotlin-lombok-interop/delombok-2.svg)

The constructor was properly generated. By making Java compilation use the delombok'd sources instead of the originals:

![](/uploads/kotlin-lombok-interop/delombok-3.svg)

```bash
./gradlew clean build -x test
```

```
BUILD SUCCESSFUL in 8s
```

## Summary and Final Configuration

![](/uploads/kotlin-lombok-interop/summary.svg)

### Key Points

1. **Both Lombok plugins are required** — `kotlin("plugin.lombok")` for Kotlin, `io.freefair.lombok` for Java
2. **No manual Lombok dependency needed** — the freefair plugin handles it
3. **delombok solves the Enum problem** — without modifying original Java code
4. **Works identically in CI/CD** — no IntelliJ dependency

## Build Order Diagram

![](/uploads/kotlin-lombok-interop/build-order.png)

## Conclusion

Kotlin-Java interoperability is nearly perfect at runtime, but **compile-time still has pitfalls**, especially with annotation processing libraries like Lombok.

### The Core Issue: Build Order

```
Kotlin compilation → Java annotation processing → Java compilation
```

Kotlin compiles first, but Lombok hasn't generated getters at that point.

### Final Solution: 3-Part Combination

1. **kotlin("plugin.lombok")**: Kotlin compiler pre-recognizes Lombok annotations
2. **io.freefair.lombok**: Properly runs Java annotation processing in Gradle
3. **delombok + source swap**: Workaround for Enum `@RequiredArgsConstructor` issues

### Trade-offs

The build configuration became more complex, and delombok adds slight build time overhead (first build only, cached afterwards). But Java source code remains untouched and builds work purely with Gradle in CI/CD.

---

## References

- [Kotlin Lombok Compiler Plugin (Official Docs)](https://kotlinlang.org/docs/lombok.html)
- [io.freefair.lombok Gradle Plugin](https://plugins.gradle.org/plugin/io.freefair.lombok)
- [Kotlin 1.7.20 Release Notes](https://kotlinlang.org/docs/whatsnew1720.html#support-for-the-lombok-compiler-plugin)
- [Lombok delombok Usage](https://projectlombok.org/features/delombok)

## Environment

- Kotlin 2.1.0
- Spring Boot 3.5.6
- Gradle 8.x
- Java 17
- Lombok (version managed by io.freefair.lombok plugin)

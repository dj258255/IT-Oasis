---
title: '왜 JVM을 직접 만드나, 그리고 어떻게 나눌까'
titleEn: 'Why Build a JVM — and How to Split It'
description: Java가 안에서 바이트코드를 어떻게 실행하는지 제대로 알고 싶어서, C로 바닥부터 만들기 시작한 토이 JVM. 첫 글은 코드를 한 줄도 쓰기 전에 끝내야 했던 설계 결정들을 정리한다 — JVM·컴파일러·JIT가 각각 무엇인지, 왜 C인지, 그리고 실제 OpenJDK(openjdk/jdk)를 닮아 VM·컴파일러·표준 라이브러리를 한 레포에 두기로 한 이유까지.
descriptionEn: "A toy JVM built from scratch in C to really understand how Java runs bytecode inside. This first post covers the design decisions that had to be settled before writing a single line of code — what the JVM, the compiler, and the JIT each are, why C, and why the layout mirrors the real OpenJDK (openjdk/jdk) by keeping the VM, compiler, and standard library in one repo."
date: 2026-07-01T00:00:00.000Z
tags:
  - JVM
  - C
  - Bytecode
  - OpenJDK
  - Compiler
  - JIT
category: study/java-hobby
draft: true
series: "C로 만드는 토이 JVM"
seriesOrder: 1
---

*바닥부터 직접 만드는 토이 JVM 연재. 이 글은 1편 — 코드 이전에 끝낸 설계 결정들.*

## 0. 들어가며

[C로 토이 커널](/blog/hobby/kernel-hobby-00-boot-to-paging)을 만들고, [C로 미니 RDBMS](/blog/project/db-hobby/db-internals-01-storage)를 만들면서 생각이 하나로 모였어요 — **"전부 내가 만든 것 위에서 실제 웹 애플리케이션을 돌려보자."**

그 스택의 가운데가 비어 있었어요. 커널(아래)과 DB(옆)는 있는데, 그 위에서 코드를 실제로 **실행**할 런타임이 없었죠. 그래서 이번엔 **JVM을 C로 바닥부터** 만들기로 했어요. 최종 그림은 이렇습니다.

```
        웹 애플리케이션 (.java)
              | 위에서 돈다
        자작 톰캣 / 서블릿 (.java)        ← 별도 프로젝트(앱)
              | 위에서 돈다
   ┌──────────────────────────────────────┐
   │   자작 JVM (C)   ← 이번 프로젝트         │
   │   바이트코드 인터프리터 · GC · JIT        │
   └──────────┬────────────────────┬───────┘
              | socket/file         | 직접 C 호출
              v                     v
        자작 커널 (C)           자작 DB (C)   ← 이게 우리의 "JDBC"
```

그런데 막상 시작하려니, **코드를 한 줄도 쓰기 전에 풀어야 할 질문**이 잔뜩 쏟아졌어요. "JVM을 만든다"는 게 정확히 뭘 만든다는 거지? 컴파일러도 만들어야 하나? JIT는? 무슨 언어로? 레포는 어떻게 나누지? 이 글은 그 **설계 결정들의 회고**예요. (실제 코드는 [2편](/blog/hobby/java-hobby-01-classfile-header-parser)부터 시작합니다.)

전체 진행 상황과 로드맵은 [저장소 README](https://github.com/dj258255/java-hobby#readme)에 정리돼 있어요.

## 1. JVM이 무엇인지부터 — 그리고 무엇이 아닌지

가장 먼저 헷갈렸던 게 이거였어요. **"JVM을 만든다 = Java를 만든다"가 아니에요.**

Java라는 플랫폼은 사실 세 덩어리예요.

| 부품 | 하는 일 | 영역 |
|---|---|---|
| **컴파일러(javac)** | `.java` 소스 → `.class` 바이트코드 | 언어 이론(문법·타입·AST) |
| **JVM(런타임)** | `.class` 바이트코드를 **실행** | 시스템(메모리·스택·GC) |
| **표준 라이브러리** | `java.lang`, `java.util` … 실제 클래스들 | 라이브러리 |

**JVM은 그중 런타임 한 조각**이에요. 그리고 결정적으로, JVM은 "Java"를 몰라요.

> JVM이 아는 건 오직 **바이트코드(.class)** 뿐이에요. `if`, `class`, 제네릭 같은 Java 문법은 JVM에 닿기 전에 javac가 이미 바이트코드로 바꿔버려요. 그래서 같은 바이트코드를 뱉기만 하면 **Kotlin·Scala·Clojure·Groovy도 똑같은 JVM이 실행**합니다. JVM은 언어 중립적이에요.

그래서 첫 결정이 명확해졌어요 — **컴파일러(javac)는 (적어도 처음엔) 만들지 않는다.** 실제 `javac`로 `.class`를 뽑고, 내 JVM이 그걸 실행하면 돼요. JVM을 만들면서 컴파일러까지 동시에 만들면 둘 다 흐지부지되거든요.

```
.java  ──[ javac (실제 거 사용) ]──>  .class  ──[ 내 JVM (C) ]──>  실행
        프론트엔드 (안 만듦)                      런타임 (이걸 만든다)
```

## 2. 인터프리터 vs JIT vs javac — 셋은 다른 자리

다음으로 머릿속에서 뒤엉켜 있던 세 단어를 떼어냈어요.

- **인터프리터**: 바이트코드를 **한 줄(opcode)씩 해석**하며 실행. JVM의 기본 엔진. 느리지만 항상 동작.
- **JIT 컴파일러**: 실행 중에 **자주 도는 부분만** 골라 기계어로 번역해 캐시. JVM **안의** 선택 부품. 속도 최적화.
- **javac**: 소스를 바이트코드로. JVM **바깥의** 별개 프로그램.

| | javac | 인터프리터 | JIT |
|---|---|---|---|
| 입력→출력 | 소스→바이트코드 | 바이트코드 실행(해석) | 바이트코드→기계어 |
| 시점 | 실행 전 | 실행 중(한 줄씩) | 실행 중(핫스팟만) |
| 위치 | JVM 바깥 | JVM 안 | JVM 안 |
| 필수? | (소스 컴파일용) | **JVM의 본체** | 선택(속도용) |

여기서 헷갈리기 쉬운 함정 하나 — **"JIT가 있으면 javac는 필요 없나?"** 아니에요. 정반대예요.

> JIT는 **바이트코드를 입력으로** 받아요. 그 바이트코드는 javac가 만들어주고요. 즉 JIT는 javac의 **결과물 위에서** 도는 거라, javac를 대체할 수 없어요. 둘은 "둘 중 하나"가 아니라 파이프라인의 **다른 칸**(1번 주자 javac, 3번 주자 JIT)이에요.

결정: **인터프리터부터 만들고, JIT는 인터프리터가 완전히 안정된 뒤 맨 마지막에.** JIT 없이도 JVM은 (느리지만) 완벽히 돌아가거든요.

## 3. 부트스트랩 — 닭과 달걀

표준 라이브러리(`java.lang.Object` 같은)는 `.java`로 쓸 건데, 그걸 `.class`로 만들려면 컴파일러가 필요해요. 그런데 내 컴파일러는 아직 없죠. 이 닭-달걀을 **부트스트랩**으로 풀어요.

> 처음엔 **실제 javac**로 내 `.java`들을 컴파일해서 내 JVM에 올려요. 나중에 자작 컴파일러가 완성되면 **자기 자신으로 갈아탑니다**(self-hosting). 모든 자기 호스팅 툴체인이 겪는 통과의례예요.

그래서 세 부품의 "내 것" 시점이 달라요 — `.java` 작성과 실행(JVM)은 **처음부터 내 것**, 컴파일만 초기에 실제 javac를 빌렸다가 나중에 내 걸로 바꾸는 거죠.

## 4. 왜 C인가

커널·DB를 C로 만들었으니 후보는 C·C++·Rust·Go였어요. 결정 기준은 두 가지였어요 — **(1) 자작 커널/DB와 통합되는가, (2) GC를 직접 손으로 구현하는 학습이 남는가.**

| 후보 | 장점 | 결정적 문제 |
|---|---|---|
| **C (선택)** | 자작 커널/DB와 링크·통합 가능, freestanding으로 커널 위 구동, GC 직접 구현 | 메모리 안전망 없음(직접 디버깅) |
| Rust | 메모리 안전 | 자작 C 스택과 통합 시 외딴 섬 |
| Go | 자료 풍부 | **GC가 언어 내장 → GC 직접 구현 학습이 사라짐**, 커널 통합 불가 |

> Go로 짜면 "내 JVM 객체의 GC"가 호스트(Go) GC에 얹혀 버려서, 정작 배우고 싶은 **GC 직접 구현이 통째로 사라져요.** C는 `malloc/free` 위에 mark-sweep을 손으로 올려야 하고, 그게 커널에서 메모리 관리하던 감각과 그대로 이어져요.

그리고 "JVM은 객체를 다루니 OO 언어(C++)가 필요하지 않나?"라는 오해도 정리했어요. **실행되는 객체는 힙에 있는 Java 객체**이고, 그건 C 구조체 + 함수 포인터 테이블(vtable)로 표현하면 돼요. 구현 언어가 OO일 필요는 없어요. 오히려 커널 포팅을 생각하면 C++ 런타임(예외·RTTI·STL)이 freestanding에서 골치라, C가 더 맞아요.

## 5. 구조 — 실제 OpenJDK를 닮기로

마지막 큰 결정은 레포 구조였어요. JVM·javac·표준 라이브러리·톰캣을 어떻게 나눌까? 처음엔 "전부 따로 vs 전부 하나"를 두고 한참 헤맸는데, **실제 OpenJDK가 어떻게 하나** 찾아보니 답이 나왔어요.

> OpenJDK는 단일 저장소 `openjdk/jdk` 안에 VM·컴파일러·라이브러리가 **함께** 있어요. `src/hotspot`(VM, C++), `src/java.base`(라이브러리, Java), `src/jdk.compiler`(javac, Java). 예전엔 8개로 쪼개져 있었는데(JDK Forest) 분리가 불편해서 **JEP 296으로 하나로 합쳤어요.** 즉 Java 프로젝트 자신이 폴리레포 → 모노레포로 이동한 거죠.

그래서 똑같이 하기로 했어요. 묶는 기준은 **"관련 있으니까"가 아니라 "같이 변하니까"** 예요. VM·javac·라이브러리는 `.class` 포맷과 표준 라이브러리라는 **계약을 공유**하니 한 레포. 반면 **톰캣은 그 위에서 도는 앱**이라(실제 Apache Tomcat도 OpenJDK 밖이듯) 별도. 커널·DB도 같은 이유로 별도예요.

```
java-hobby/                    (openjdk/jdk 에 대응 — 한 레포)
└── src/
    ├── hotspot/        JVM (C)              [openjdk: src/hotspot]
    │   ├── share/      포터블 코어 (파서·인터프리터·GC·JIT)
    │   ├── os/         PAL: os/host, os/<내커널>   ← 커널 포팅 지점
    │   └── cpu/        CPU별 JIT codegen (후반)
    ├── java.base/      표준 라이브러리          [openjdk: src/java.base]
    │   └── share/{classes(.java), native(C)}
    └── jdk.compiler/   javac (C)            [openjdk: src/jdk.compiler]
tomcat-hobby/                  (Apache Tomcat 에 대응 — 별도)
```

그리고 이 구조에서 공짜로 따라오는 선물이 하나 있어요 — **`share`/`os`/`cpu` 분리가 곧 PAL(플랫폼 추상화 계층)** 이에요. OS 의존부를 `os/`로 격리해 두면, 리눅스에서 개발하다가 나중에 `os/<내커널>/`만 갈아끼워 **자작 커널로 포팅**할 수 있어요. share의 인터프리터·GC는 한 줄도 안 건드리고요. 커널 짤 때 익숙했던 그 추상화 그대로예요.

### 표준 라이브러리는 직접, 필요한 만큼만

한 가지 더. OpenJDK의 `java.base`(.class)는 glibc/리눅스 syscall에 깊게 묶여 있어서 자작 커널 위에선 못 써요. 그래서 **웹앱이 실제로 쓰는 클래스만** 직접 Java로 작성하고(`Object`·`String`·`ArrayList`·`Socket`…), 바닥의 `native` 메서드는 PAL을 거쳐 커널 syscall로 연결할 거예요. 전체 표준 라이브러리를 미리 만들지 않고, 필요할 때 한 클래스씩 늘립니다.

## 6. 로드맵

`src/hotspot`(JVM 본체)을 이 순서로 쌓아요. 각 단계는 그 자체로 눈에 보이는 산출물이 있어요.

| Phase | 한 줄 | 산출물 |
|---|---|---|
| 0–1 | `.class` 파서 | 클래스/메서드 덤프 |
| 2 | 인터프리터 골격 | **Hello / 산술 루프** |
| 3 | 객체 모델 | 다형성 디스패치(vtable) |
| 4 | **GC** | 무한 할당 루프 생존 |
| 5 | 예외 | try-catch-finally |
| 6 | 자작 stdlib | ArrayList/HashMap |
| 7 | I/O·소켓·스레드 | **순수 JVM TCP 서버** |
| 8 | 커널 포팅 | 전 스택 자작 부팅 |
| 9 | JIT | 핫 메서드 가속 |

현실적인 1차 목표는 **Phase 7**(순수 내 JVM만으로 TCP 서버가 뜨는 것)이에요. 거기까지 가면 그 위에 톰캣과 웹앱을 올릴 토대가 완성돼요.

## 7. 마무리

설계만으로 글 하나가 나왔지만, 사실 이게 제일 중요한 단계였어요. **"무엇을 만들고 무엇을 안 만들지"** 를 못 박으니 길이 또렷해졌거든요 — 인터프리터부터, javac·JIT는 나중에, C로, OpenJDK를 닮은 한 레포로.

다음 글부터 진짜 코드예요. 첫 단추는 **`.class` 파일을 읽는 것** — 전원 들어온 CPU에서 첫 글자를 찍던 커널처럼, JVM의 첫 글자는 `0xCAFEBABE`를 읽어내는 거예요. → [2편: .class 파일을 읽다](/blog/hobby/java-hobby-01-classfile-header-parser)

---
title: 'JVM 메모리 ①: Heap 세대 구조'
titleEn: 'JVM Memory ①: Heap Internals'
description: JVM Heap이 Young/Old Generation, Eden/Survivor로 나뉘는 이유와 NewRatio·SurvivorRatio 같은 튜닝 파라미터를 Oracle JDK 17 공식 문서 기준으로 뜯어봤어요. G1에서 이 파라미터들을 왜 건드리면 안 되는지까지.
descriptionEn: Why the JVM heap is split into Young/Old Generations with Eden/Survivor spaces, and what NewRatio/SurvivorRatio actually control — grounded in Oracle JDK 17 docs. Including why these should not be touched under G1.
date: 2026-01-10T00:00:00.000Z
tags:
  - JVM
  - Heap
  - Young Generation
  - Old Generation
  - Elasticsearch
  - Memory Management
category: theory/JVM-Memory
draft: false
coverImage: "/uploads/theory/es-memory/cover-1.svg"
series: "JVM 메모리"
seriesOrder: 1
---

> 본 문서는 **Oracle JDK 17 HotSpot VM** 기준이에요. 버전에 따라 default 값이 다르므로, 다른 버전을 쓸 경우 각 버전 문서를 교차 확인해야 해요. JVM 아키텍처 전반(클래스 로더, Runtime Data Areas, Execution Engine, JIT 등)은 [0편](/blog/theory/jvm-and-gc)에서 다뤘고, 이 글은 그중에서 **Elasticsearch 운영에 직결되는 Heap 구조**만 발췌·심화한 버전이에요.

## 1. 왜 이 이론을 알아야 하는가

Elasticsearch는 JVM 위에서 돌아가는 Java 애플리케이션이에요. Elasticsearch 노드가 메모리 이슈로 죽거나 느려지는 원인의 **대부분이 JVM Heap과 GC에서 발생**해요. 그래서 ES의 "heap은 전체 RAM의 50% 이하로 설정하라"는 가이드는 JVM Heap이 무엇인지, 어떻게 쓰이는지를 이해해야 왜 그런지 설명할 수 있어요.

즉, 이 문서는 `Xms`, `Xmx`, `Young/Old Generation`, `Eden/Survivor` 같은 용어가 **구조상 어디에 위치한 무엇을 의미하는지** 1차 소스 기준으로 정리해요.

## 2. JVM 메모리의 큰 그림

JVM 프로세스의 메모리는 크게 두 덩어리로 나뉘어요.

1. **Heap 영역** — `new`로 생성된 **객체가 저장되는 영역**. GC의 대상이 이 영역이에요.
2. **Non-heap 영역** — 클래스 메타데이터(Metaspace), 스레드 스택, 코드 캐시(JIT), Direct Memory, GC 자체 구조 등.

`-Xms`, `-Xmx`가 조절하는 것은 **Heap 영역의 크기만**이에요. 따라서 "Xmx 8g를 줬는데 JVM 프로세스가 12g를 쓴다"는 건 Non-heap 영역이 추가로 잡혀 있기 때문이고, 이건 버그가 아니에요. (Non-heap의 대표 항목인 Direct Buffer는 [Off-heap Memory 편](/blog/theory/es-memory-03-off-heap) 참조)

## 3. Heap의 세대별 구조 (Generational Hypothesis)

HotSpot은 **"대부분의 객체는 금방 죽는다"** 라는 **세대별 가설(Generational Hypothesis)** 에 기반해서 Heap을 두 세대로 나눠요.

![JVM Heap 구조 — Young Generation(Eden, S0, S1)과 Old Generation](/uploads/theory/es-memory/heap-structure.svg)

> 위 그림은 Serial/Parallel GC 같은 **고전적 세대 collector** 의 물리적 레이아웃이에요. **G1 GC는 Young/Old를 고정된 연속 메모리로 두지 않고, 동일 크기 region들에 "young"/"old" 라벨을 붙이는 방식**을 써요. 즉 개념적으로는 같은 두 세대지만 레이아웃이 달라요. 자세한 내용은 [GC 알고리즘 편](/blog/theory/es-memory-02-gc) 참조.

### 3-1. Young Generation (신세대)

Oracle 공식 문서(JDK 8 GC Tuning Guide, "Generations" 챕터)의 정의:

> "The young generation consists of eden and two survivor spaces. ... One survivor space is empty at any time, and serves as the destination of any live objects in eden; the other survivor space is the destination during the next copying collection." — [Oracle JDK 8 GC Tuning Guide — Generations](https://docs.oracle.com/javase/8/docs/technotes/guides/vm/gctuning/generations.html)

이 구조 설명은 JDK 8 문서가 가장 직설적이라 인용했어요. 같은 개념은 JDK 17 문서의 ["Factors Affecting Garbage Collection Performance"](https://docs.oracle.com/en/java/javase/17/gctuning/factors-affecting-garbage-collection-performance.html)에도 eden/survivor 튜닝 문맥으로 등장해요.

정리하면:

- **Eden**: 새로 `new`된 객체가 처음 할당되는 곳이에요.
- **Survivor 0 / Survivor 1 (S0 / S1)**: 두 개의 동일한 크기 공간. 한 쪽은 항상 비어 있어요.
- **Young GC (Minor GC)**: Eden이 꽉 차면 발생해요. Eden과 현재 사용 중인 Survivor의 **살아있는 객체**만 다음 Survivor로 **복사**하고, 나머지는 한 번에 버려요.
- **Promotion(승격)**: Young GC를 일정 횟수 이상 살아남은 객체는 Old Generation으로 옮겨져요. 이 횟수를 **tenuring threshold** 라고 하며, GC가 동적으로 조정해요.

### 3-2. Old Generation (구세대)

장수 객체(live data)가 모이는 영역이에요. **Major GC(또는 Full GC)** 의 대상이에요. Young GC 대비 훨씬 비싸고 STW(Stop-the-World) 시간이 길어요.

### 3-3. Metaspace (세대가 아님)

Java 8부터 PermGen이 사라지고 **Metaspace** 로 대체됐어요. Metaspace는 **Heap이 아니라 Native Memory**에 위치하며, 클래스 메타데이터(메서드 정보, 상수풀 등)를 저장해요. `-Xmx`와 별개로 관리돼요.

## 4. 핵심 튜닝 파라미터 (JDK 17 기준)

> **중요**: 아래 파라미터들은 **Parallel GC / Serial GC 같은 "고전적 세대 collector"** 를 전제로 서술된 문서에서 나온 것이에요. JDK 17의 default collector인 **G1 GC에서는 `NewRatio`, `NewSize`, `Xmn` 사용을 공식적으로 권장하지 않아요.** 자세한 이유는 이 절의 4-2에서 다룰게요.

다음 값들은 Oracle 공식 GC Tuning Guide에서 직접 확인한 내용이에요.

| 파라미터 | Default | 의미 |
|---|---|---|
| `-Xms` / `-Xmx` | 시스템/ergonomics 의존 | 초기/최대 Heap 크기. 운영에서는 같은 값으로 고정 권장 |
| `-XX:NewRatio` | `2` (Parallel/Serial) | Young:Old = 1:N. `2`이면 Young이 전체 Heap의 1/3 |
| `-XX:SurvivorRatio` | `8` | Eden:Survivor = N:1. `8`이면 각 Survivor가 Eden의 1/8 |
| `-XX:NewSize`, `-XX:MaxNewSize` | ergonomics 의존 | Young Generation의 하한/상한 (명시적 값은 버전·플랫폼마다 다르므로 단일 숫자로 표기하지 않음) |
| `-XX:MinHeapFreeRatio` | `40%` | Heap free 공간이 이보다 낮으면 확장 시도 |
| `-XX:MaxHeapFreeRatio` | `70%` | Heap free 공간이 이보다 높으면 축소 시도 |

> "Setting `-XX:NewRatio=3` means that the ratio between the young and old generation is 1:3. In other words, the combined size of the eden and survivor spaces will be one-fourth of the total heap size." — [Oracle JDK 17 GC Tuning Guide](https://docs.oracle.com/en/java/javase/17/gctuning/factors-affecting-garbage-collection-performance.html)

> "Setting `-XX:SurvivorRatio=6` sets the ratio between eden and a survivor space to 1:6. In other words, each survivor space will be one-sixth of the size of eden, and thus one-eighth of the size of the young generation (not one-seventh, because there are two survivor spaces)." — 같은 출처

### 4-1. 트레이드오프

공식 문서가 직접 짚는 트레이드오프는 다음과 같아요.

> "The bigger the young generation, the less often minor collections occur. However, for a bounded heap size, a larger young generation implies a smaller old generation, which will increase the frequency of major collections." — [Oracle JDK 17 GC Tuning Guide](https://docs.oracle.com/en/java/javase/17/gctuning/factors-affecting-garbage-collection-performance.html)

즉, Young을 키우면 Minor GC 빈도가 줄지만 Major GC 빈도가 늘어나요. 무조건 크게 잡는다고 좋지 않아요.

### 4-2. G1에서는 NewRatio / NewSize / Xmn을 쓰지 말라 (공식 권고)

Oracle JDK 17 G1 Tuning Guide의 명시적 경고:

> "Avoid limiting the young generation size to particular values by using options like `-Xmn`, `-XX:NewRatio` and others because the young generation size is the main means for G1 to allow it to meet the pause-time. Setting the young generation size to a single value overrides and practically disables pause-time control." — [Oracle JDK 17 — G1 Garbage Collector Tuning](https://docs.oracle.com/en/java/javase/17/gctuning/garbage-first-garbage-collector-tuning.html)

이유:

- G1은 pause-time 목표(`-XX:MaxGCPauseMillis`, default 200ms)를 맞추기 위해 **매 young collection마다 Young Generation 크기를 동적으로 재조정**해요.
- `NewRatio`/`Xmn`으로 Young 크기를 고정하면 이 자동 조정을 **비활성화**하는 셈이 되어 pause-time 제어 기능 자체가 무력화돼요.

따라서 G1을 쓰는 환경(= JDK 9+ 기본, 대부분의 Elasticsearch 운영)에서는 위 표의 파라미터 중 **`Xms`/`Xmx`와 `MaxGCPauseMillis`만 건드리고 나머지는 default를 그대로 둬야** 해요. `NewRatio`/`SurvivorRatio` 파라미터를 여기서 먼저 설명한 것은 개념 이해용이며, 실전 튜닝에서 G1 환경에선 건드리지 말라는 뜻이에요.

## 5. 객체 할당과 승격 흐름 (life cycle)

1. `new Foo()` → **TLAB(Thread Local Allocation Buffer)** 을 통해 Eden에 할당.
2. Eden이 꽉 참 → **Minor GC** 발생.
    - 살아남은 객체는 현재 비어있는 Survivor(S1)로 복사.
    - Eden과 다른 Survivor(S0)는 한 번에 비워져요.
3. 다음 Minor GC에서 S1 → S0로 복사되며 age 카운트가 올라가요.
4. age가 **tenuring threshold** 를 넘으면 → **Old Generation으로 Promotion**.
5. Old Generation이 꽉 참 → **Major GC(혹은 Full GC)**.

> "At each garbage collection, the virtual machine chooses a threshold number, which is the number of times an object can be copied before it's old. This threshold is chosen to keep the survivors half full." — [Oracle JDK 17 GC Tuning Guide](https://docs.oracle.com/en/java/javase/17/gctuning/factors-affecting-garbage-collection-performance.html)

### 5-1. Survivor가 너무 작으면?

> "If survivor spaces are too small, then the copying collection overflows directly into the old generation." — 같은 출처

즉 Survivor가 작으면 원래 Young에서 수명을 다 채워야 할 객체가 **조기 승격(premature promotion)** 돼서 Old Generation이 빨리 차고, Major GC가 빨라져요. 이게 Full GC 빈도가 비정상적으로 높은 애플리케이션의 전형적 원인 중 하나예요.

## 6. Elasticsearch 관점에서의 의미

1. **ES는 Heap을 최대 ~26~30GB 이하로 권장**해요. 이유는 GC 비용과 compressed OOPs 때문이고, 이는 [Elasticsearch 메모리 모델 편](/blog/theory/es-memory-05-elasticsearch)에서 자세히 다룰게요.
2. **ES의 Heap 50% 룰**은 "나머지 50%는 OS Page Cache용으로 남겨라" 라는 뜻이에요. 즉 `Xmx`가 JVM Heap에만 해당하고, **나머지 메모리는 OS가 Lucene 인덱스 파일을 캐싱하는 데 쓴다**는 전제가 깔려있어요. Page Cache 개념은 [OS Page Cache 편](/blog/theory/es-memory-04-page-cache) 참조.
3. Heap이 커질수록 **GC STW 시간이 길어지고**, 그 사이 ES 노드는 heartbeat를 못 보내서 클러스터에서 빠질 수 있어요.

## 참고 문헌 (1차 소스)

- [Oracle JDK 17 HotSpot VM Garbage Collection Tuning Guide — Factors Affecting GC Performance](https://docs.oracle.com/en/java/javase/17/gctuning/factors-affecting-garbage-collection-performance.html)
- [Oracle JDK 17 HotSpot VM GC Tuning Guide — Available Collectors](https://docs.oracle.com/en/java/javase/17/gctuning/available-collectors.html)
- [Oracle JDK 17 — G1 Garbage Collector Tuning](https://docs.oracle.com/en/java/javase/17/gctuning/garbage-first-garbage-collector-tuning.html)
- [Oracle JDK 8 GC Tuning Guide — Generations (세대별 가설 원문 설명)](https://docs.oracle.com/javase/8/docs/technotes/guides/vm/gctuning/generations.html)
- [Oracle JDK 8 GC Tuning Guide — Sizing the Generations](https://docs.oracle.com/javase/8/docs/technotes/guides/vm/gctuning/sizing.html)
- [OpenJDK HotSpot Runtime Overview](https://openjdk.org/groups/hotspot/docs/RuntimeOverview.html)

---

**이어지는 글**: [JVM의 GC 알고리즘과 Stop-the-World](/blog/theory/es-memory-02-gc)

<!-- EN -->

> This document is based on **Oracle JDK 17 HotSpot VM**. Default values vary by version, so cross-check with the docs for whichever version you are on. The broader JVM architecture (class loaders, Runtime Data Areas, Execution Engine, JIT) is covered in [Part 0](/blog/theory/jvm-and-gc); this post is an excerpted, deeper take focused on the **Heap structure that directly affects Elasticsearch operations**.

## 1. Why You Need This Theory

Elasticsearch is a Java application running on the JVM. **Most of the cases where an Elasticsearch node dies or slows down due to memory issues come from the JVM Heap and GC.** That is why the ES guideline *"set heap to at most 50% of total RAM"* only makes sense once you understand what the JVM Heap is and how it is used.

In other words, this document organizes terms like `Xms`, `Xmx`, `Young/Old Generation`, and `Eden/Survivor` — **what they are and where they sit structurally** — based on primary sources.

## 2. The Big Picture of JVM Memory

A JVM process's memory is split into two big chunks.

1. **Heap area** — the area where **objects created with `new` live**. This is what GC operates on.
2. **Non-heap area** — class metadata (Metaspace), thread stacks, code cache (JIT), Direct Memory, GC's own structures, etc.

What `-Xms` and `-Xmx` control is **only the size of the Heap area**. So when you say *"I gave Xmx 8g but the JVM process is using 12g"*, that is the non-heap area being allocated on top — it is not a bug. (For Direct Buffer, the headline non-heap item, see the [Off-heap Memory part](/blog/theory/es-memory-03-off-heap).)

## 3. Generational Heap Structure (Generational Hypothesis)

HotSpot splits the Heap into two generations based on the **Generational Hypothesis** — *"most objects die young."*

![JVM Heap structure — Young Generation (Eden, S0, S1) and Old Generation](/uploads/theory/es-memory/heap-structure.svg)

> The image above is the physical layout of **classic generational collectors** like Serial/Parallel GC. **G1 GC does not keep Young/Old as fixed contiguous memory; it labels equal-size regions as "young"/"old"** instead. Conceptually the same two generations, but the layout differs. See the [GC Algorithms part](/blog/theory/es-memory-02-gc) for details.

### 3-1. Young Generation

From the Oracle official docs (JDK 8 GC Tuning Guide, "Generations" chapter):

> "The young generation consists of eden and two survivor spaces. ... One survivor space is empty at any time, and serves as the destination of any live objects in eden; the other survivor space is the destination during the next copying collection." — [Oracle JDK 8 GC Tuning Guide — Generations](https://docs.oracle.com/javase/8/docs/technotes/guides/vm/gctuning/generations.html)

I cited the JDK 8 doc because that structural description is the most direct one. The same concept appears in the JDK 17 doc's ["Factors Affecting Garbage Collection Performance"](https://docs.oracle.com/en/java/javase/17/gctuning/factors-affecting-garbage-collection-performance.html) in the context of eden/survivor tuning.

To summarize:

- **Eden**: where newly `new`-ed objects are first allocated.
- **Survivor 0 / Survivor 1 (S0 / S1)**: two equally-sized spaces. One side is always empty.
- **Young GC (Minor GC)**: triggered when Eden fills up. Only the **live objects** in Eden and the currently-used Survivor are **copied** to the other Survivor; everything else is discarded in one shot.
- **Promotion**: objects that survive enough Young GCs are moved to the Old Generation. The threshold is called the **tenuring threshold** and the GC adjusts it dynamically.

### 3-2. Old Generation

The area where long-lived (live data) objects collect. Subject to **Major GC (or Full GC)**, which is much more expensive than Young GC and has longer STW (Stop-the-World) pauses.

### 3-3. Metaspace (not a generation)

Starting with Java 8, PermGen was removed and replaced by **Metaspace**. Metaspace lives in **Native Memory, not Heap**, and stores class metadata (method info, constant pool, etc.). It is managed independently of `-Xmx`.

## 4. Key Tuning Parameters (JDK 17)

> **Important**: the parameters below come from docs that assume **classic generational collectors like Parallel GC / Serial GC**. **In G1 GC — the default collector in JDK 17 — Oracle officially advises against using `NewRatio`, `NewSize`, or `Xmn`.** The reason is in section 4-2.

The values below are confirmed directly against Oracle's official GC Tuning Guide.

| Parameter | Default | Meaning |
|---|---|---|
| `-Xms` / `-Xmx` | system / ergonomics-dependent | Initial / maximum Heap size. In production, pinning both to the same value is recommended |
| `-XX:NewRatio` | `2` (Parallel/Serial) | Young:Old = 1:N. `2` means Young is 1/3 of total Heap |
| `-XX:SurvivorRatio` | `8` | Eden:Survivor = N:1. `8` means each Survivor is 1/8 of Eden |
| `-XX:NewSize`, `-XX:MaxNewSize` | ergonomics-dependent | Lower / upper bound of Young Generation (explicit values vary across version and platform, so no single number is given) |
| `-XX:MinHeapFreeRatio` | `40%` | Heap tries to expand if free space falls below this |
| `-XX:MaxHeapFreeRatio` | `70%` | Heap tries to shrink if free space rises above this |

> "Setting `-XX:NewRatio=3` means that the ratio between the young and old generation is 1:3. In other words, the combined size of the eden and survivor spaces will be one-fourth of the total heap size." — [Oracle JDK 17 GC Tuning Guide](https://docs.oracle.com/en/java/javase/17/gctuning/factors-affecting-garbage-collection-performance.html)

> "Setting `-XX:SurvivorRatio=6` sets the ratio between eden and a survivor space to 1:6. In other words, each survivor space will be one-sixth of the size of eden, and thus one-eighth of the size of the young generation (not one-seventh, because there are two survivor spaces)." — same source

### 4-1. Trade-off

The trade-off the official doc itself calls out:

> "The bigger the young generation, the less often minor collections occur. However, for a bounded heap size, a larger young generation implies a smaller old generation, which will increase the frequency of major collections." — [Oracle JDK 17 GC Tuning Guide](https://docs.oracle.com/en/java/javase/17/gctuning/factors-affecting-garbage-collection-performance.html)

So if you grow Young, Minor GC frequency drops but Major GC frequency rises. Bigger is not unconditionally better.

### 4-2. On G1, do not use NewRatio / NewSize / Xmn (official guidance)

Explicit warning from the Oracle JDK 17 G1 Tuning Guide:

> "Avoid limiting the young generation size to particular values by using options like `-Xmn`, `-XX:NewRatio` and others because the young generation size is the main means for G1 to allow it to meet the pause-time. Setting the young generation size to a single value overrides and practically disables pause-time control." — [Oracle JDK 17 — G1 Garbage Collector Tuning](https://docs.oracle.com/en/java/javase/17/gctuning/garbage-first-garbage-collector-tuning.html)

Why:

- G1 **dynamically resizes the Young Generation on every young collection** to meet its pause-time goal (`-XX:MaxGCPauseMillis`, default 200ms).
- Pinning Young size with `NewRatio`/`Xmn` effectively **disables** that auto-tuning, which neuters pause-time control itself.

So in environments using G1 (= JDK 9+ default, which covers most Elasticsearch operations), you should **only touch `Xms`/`Xmx` and `MaxGCPauseMillis` from the table above and leave the rest at default**. The reason `NewRatio`/`SurvivorRatio` were explained first is for conceptual understanding — in real G1 tuning, do not touch them.

## 5. Object Allocation and Promotion Flow (Life Cycle)

1. `new Foo()` → allocated in Eden via the **TLAB (Thread Local Allocation Buffer)**.
2. Eden fills up → **Minor GC** triggers.
    - Surviving objects are copied to the currently empty Survivor (S1).
    - Eden and the other Survivor (S0) are wiped at once.
3. On the next Minor GC, S1 → S0 copy happens and the age count goes up.
4. When age exceeds the **tenuring threshold** → **promoted to the Old Generation**.
5. Old Generation fills up → **Major GC (or Full GC)**.

> "At each garbage collection, the virtual machine chooses a threshold number, which is the number of times an object can be copied before it's old. This threshold is chosen to keep the survivors half full." — [Oracle JDK 17 GC Tuning Guide](https://docs.oracle.com/en/java/javase/17/gctuning/factors-affecting-garbage-collection-performance.html)

### 5-1. What if Survivor is too small?

> "If survivor spaces are too small, then the copying collection overflows directly into the old generation." — same source

So if Survivor is too small, objects that should have lived out their life in Young are **prematurely promoted**, the Old Generation fills up faster, and Major GC accelerates. This is one of the classic causes of an application showing abnormally high Full GC frequency.

## 6. What This Means From an Elasticsearch Angle

1. **ES recommends a Heap of at most ~26-30GB.** The reason is GC cost and compressed OOPs, covered in detail in the [Elasticsearch Memory Model part](/blog/theory/es-memory-05-elasticsearch).
2. **The ES Heap 50% rule** means *"leave the other 50% for OS Page Cache."* That is, `Xmx` only governs the JVM Heap; the rest of memory is assumed to be **used by the OS to cache Lucene index files**. For the Page Cache concept, see the [OS Page Cache part](/blog/theory/es-memory-04-page-cache).
3. The bigger the Heap, the longer the **GC STW pause**, and during that window the ES node may fail to send heartbeats and get dropped from the cluster.

## References (Primary Sources)

- [Oracle JDK 17 HotSpot VM Garbage Collection Tuning Guide — Factors Affecting GC Performance](https://docs.oracle.com/en/java/javase/17/gctuning/factors-affecting-garbage-collection-performance.html)
- [Oracle JDK 17 HotSpot VM GC Tuning Guide — Available Collectors](https://docs.oracle.com/en/java/javase/17/gctuning/available-collectors.html)
- [Oracle JDK 17 — G1 Garbage Collector Tuning](https://docs.oracle.com/en/java/javase/17/gctuning/garbage-first-garbage-collector-tuning.html)
- [Oracle JDK 8 GC Tuning Guide — Generations (original explanation of the generational hypothesis)](https://docs.oracle.com/javase/8/docs/technotes/guides/vm/gctuning/generations.html)
- [Oracle JDK 8 GC Tuning Guide — Sizing the Generations](https://docs.oracle.com/javase/8/docs/technotes/guides/vm/gctuning/sizing.html)
- [OpenJDK HotSpot Runtime Overview](https://openjdk.org/groups/hotspot/docs/RuntimeOverview.html)

---

**Next**: [GC Algorithms and Stop-the-World on the JVM](/blog/theory/es-memory-02-gc)

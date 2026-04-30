---
title: 'JVM 메모리 ②: GC 알고리즘과 Stop-the-World'
titleEn: 'JVM Memory ②: GC Algorithms and Stop-the-World'
description: Serial/Parallel/G1/ZGC/Shenandoah 각각이 언제 STW로 멈추고 언제 concurrent로 돌아가는지 OpenJDK JEP와 Oracle JDK 17 공식 문서 기준으로 정리했어요. Shenandoah가 Oracle JDK 빌드에 빠져있다는 사실까지.
descriptionEn: When each GC (Serial/Parallel/G1/ZGC/Shenandoah) pauses (STW) vs runs concurrently, based on OpenJDK JEPs and Oracle JDK 17 docs. Including the fact that Shenandoah is absent from Oracle JDK builds.
date: 2026-01-11T00:00:00.000Z
tags:
  - JVM
  - Garbage Collection
  - G1 GC
  - ZGC
  - Shenandoah
  - Elasticsearch
  - Stop-the-World
category: theory/JVM-Memory
draft: false
coverImage: "/uploads/theory/es-memory/cover-2.svg"
series: "JVM 메모리"
seriesOrder: 2
---

> 본 문서는 **Oracle JDK 17 HotSpot VM** + OpenJDK JEP 1차 소스 기준이에요. Safepoint·Mark-Sweep 같은 **일반론**은 [0편](/blog/theory/jvm-and-gc)에서 간단히 다뤘고, 이 글은 **Elasticsearch 운영에 직접 영향을 주는 G1/ZGC/Shenandoah**와 **Oracle JDK 빌드 포함 여부** 같은 실무 관점에 집중해요.

## 1. 왜 이 이론을 알아야 하는가

Elasticsearch 운영에서 가장 자주 만나는 장애 유형이 **"GC 오래 걸려서 노드가 이탈했다"** 예요. Elastic 공식 문서도 heap size 가이드를 설명할 때 **"Larger heaps can also cause longer garbage collection pauses"** 라고 직접적으로 경고해요. ([Elastic — Advanced configuration](https://www.elastic.co/guide/en/elasticsearch/reference/current/advanced-configuration.html))

그래서 "무슨 GC가 있고, 각각 언제/왜 멈추는지" 는 Elasticsearch 운영의 최소 조건이에요.

## 2. GC가 해야 하는 일

GC는 **더 이상 참조되지 않는 객체(garbage)를 찾아 회수**하는 것이 전부예요. 이걸 "안전하게" 하려면 애플리케이션 스레드가 객체 그래프를 수정하는 도중 GC가 탐색하면 안 돼요. 그래서 HotSpot은 **Safepoint** 라는 동기화 지점을 써요.

### 2-1. Safepoint와 Stop-the-World (STW)

OpenJDK HotSpot Glossary의 공식 정의:

> "safepoint: A point during program execution at which all GC roots are known and all heap object contents are consistent. From a global point of view, all threads must block at a safepoint before the GC can run. (As a special case, threads running JNI code can continue to run, because they use only handles. During a safepoint they must block instead of loading the contents of the handle.) From a local point of view, a safepoint is a distinguished point in a block of code where the executing thread may block for the GC." — [OpenJDK HotSpot Glossary](https://openjdk.org/groups/hotspot/docs/HotSpotGlossary.html)

즉 **Stop-the-World** 는 GC가 실행되기 전에 모든 Java 스레드를 safepoint에서 블록시킨 상태를 말해요. JNI 네이티브 코드는 handle만 쓰므로 계속 돌 수 있지만, handle 내용을 건드리려 하면 역시 블록돼요. GC의 성능은 대부분 **"STW 구간을 얼마나 짧게 하느냐"** 로 판가름 나요.

추가 참고: [OpenJDK HotSpot Runtime Overview](https://openjdk.org/groups/hotspot/docs/RuntimeOverview.html) 는 VM 전체 런타임 구조에서 safepoint의 쓰임새를 설명해요(VM 종료 시 "Stop VM thread, it will bring the remaining VM to a safepoint" 등).

## 3. HotSpot이 제공하는 Collector 목록 (JDK 17)

Oracle JDK 17 공식 문서 ["Available Collectors"](https://docs.oracle.com/en/java/javase/17/gctuning/available-collectors.html) 에서 명시된 것만 정리해요.

| Collector | Flag | 성격 | 목적 | Oracle JDK 17 포함 여부 |
|---|---|---|---|---|
| Serial GC | `-XX:+UseSerialGC` | 싱글스레드 STW | 작은 데이터셋 / 단일 CPU | O |
| Parallel GC | `-XX:+UseParallelGC` | 멀티스레드 STW | throughput 최대화 | O |
| G1 GC | `-XX:+UseG1GC` | **mostly concurrent** | pause time 예측성 (default) | O |
| Z GC | `-XX:+UseZGC` | **fully concurrent** | 초저지연 (수 ms) | O (JDK 15부터 production) |
| Shenandoah | `-XX:+UseShenandoahGC` | **fully concurrent** | 힙 크기와 무관한 pause | **X (Oracle JDK 빌드는 미포함)** |

**JDK 17에서 default는 G1** 이에요. Oracle 문서: *"G1 is selected by default on most hardware and operating system configurations"* ([Oracle JDK 17 — Available Collectors](https://docs.oracle.com/en/java/javase/17/gctuning/available-collectors.html))

> G1이 default가 된 것은 **JDK 9부터**이고, 그 근거는 [OpenJDK JEP 248 — Make G1 the Default Garbage Collector](https://openjdk.org/jeps/248) 이에요. 이전(JDK 8 이하)의 default는 Parallel GC였어요.

> 참고: **JEP 523**은 JDK 25를 타깃으로 "G1을 모든 환경(클라이언트 포함)에서 default로" 확정하려는 제안이에요. ([OpenJDK JEP 523](https://openjdk.org/jeps/523))

### 3-1. Shenandoah는 Oracle JDK에 들어있지 않아요 (중요)

Shenandoah는 OpenJDK 상류(upstream)에는 포함되어 있지만 **Oracle이 배포하는 Oracle JDK 빌드에서는 빌드 시 제외**돼요. 즉:

- **Oracle JDK 17 설치 후 `-XX:+UseShenandoahGC` 를 주면 실행 실패**해요.
- Shenandoah를 쓰려면 **Red Hat build of OpenJDK, Eclipse Temurin, Azul Zulu, Amazon Corretto** 등 OpenJDK 기반 배포판을 써야 해요.

Shenandoah의 상태 관련 JEP:

- [JEP 189 — Shenandoah (Experimental, JDK 12)](https://openjdk.org/jeps/189)
- [JEP 379 — Shenandoah: Production (JDK 15)](https://openjdk.org/jeps/379)

Elasticsearch는 기본 번들 JDK로 Eclipse Temurin 계열 OpenJDK를 포함하기 때문에 Shenandoah 사용이 이론상 가능하지만, **운영 권장 GC는 여전히 G1이며 Shenandoah/ZGC는 특수 상황용**이에요.

## 4. 주요 Collector 상세

### 4-1. Serial GC

> "The serial collector uses a single thread to perform all garbage collection work, which makes it relatively efficient because there is no communication overhead between threads." — [Oracle JDK 17 — Available Collectors](https://docs.oracle.com/en/java/javase/17/gctuning/available-collectors.html)

- 싱글스레드 STW.
- Young은 복사, Old는 **mark-sweep-compact**.
- 작은 힙(~100MB)이나 컨테이너/단일 CPU 환경에서 의미가 있어요. Elasticsearch에서는 쓸 일이 거의 없어요.

### 4-2. Parallel GC (Throughput Collector)

> "The parallel collector is also known as throughput collector, it's a generational collector similar to the serial collector. The primary difference between the serial and parallel collectors is that the parallel collector has multiple threads that are used to speed up garbage collection." — [Oracle JDK 17 — Available Collectors](https://docs.oracle.com/en/java/javase/17/gctuning/available-collectors.html)

- 여러 스레드로 Young/Old 모두 병렬 STW.
- **throughput**(단위시간 대비 application 실행 비율)이 목적. pause time은 길 수 있음.
- 배치·오프라인 처리에 적합. 검색엔진(실시간 쿼리)에는 부적합.

### 4-3. G1 GC (Garbage-First) — JDK 17 default

G1은 가장 중요한 collector이므로 Oracle 공식 문서 ["Garbage-First (G1) Garbage Collector"](https://docs.oracle.com/en/java/javase/17/gctuning/garbage-first-g1-garbage-collector1.html)의 정의를 그대로 인용해요.

#### 구조

> "G1 partitions the heap into a set of equally sized heap regions, each a contiguous range of virtual memory."

즉, Young/Old를 **고정된 연속 메모리 블록으로 나누지 않고, 같은 크기의 region 집합**으로 쪼개요. region은 1~32MB이며, **전체 약 2048개 region**이 되도록 자동 계산돼요.

region은 다음 중 하나의 역할을 해요:

- **Eden region**
- **Survivor region**
- **Old region**
- **Humongous region** — region 크기의 절반 이상인 큰 객체 전용. 여러 region을 연속으로 차지해요.

#### 수거 방식

> "G1 reclaims space mostly by using evacuation: live objects found within selected memory areas to collect are copied into new memory areas, compacting them in the process." — 같은 출처

- **evacuation(대피)**: 회수 대상 region에서 살아있는 객체만 다른 region으로 복사. 이 과정에서 자연스럽게 **compaction**이 이뤄져요.
- **Collection Set(CSet)**: 이번 GC에서 회수할 region들의 집합. 이 개념 덕분에 **"비용 대비 수거량이 많은 region부터 고를 수 있다"** → 이게 G1 이름의 유래(Garbage-First)예요.
- **Remembered Set(RSet)**: region 밖에서 region 안으로 들어오는 참조를 기록. 전체 heap을 스캔하지 않고 region 단위로 GC 가능.

#### 페이즈

1. **Young-only phase** — Eden/Survivor만 모으는 일반 young collection.
2. **Concurrent Start** — Old Generation 점유율이 IHOP(Initiating Heap Occupancy Percent)에 도달하면 concurrent marking 시작.
3. **Remark / Cleanup** — 마킹 마무리, 완전히 빈 region 즉시 회수.
4. **Space-Reclamation phase (Mixed GC)** — Young + 일부 Old region을 같이 evacuation.
5. **Full GC** — 비상 수단. 힙 전체를 STW compaction. 되도록 안 일어나는 것이 G1의 설계 목적이에요.

#### Pause time 목표

> "G1 tries to meet set pause-time targets with high probability over a longer time, but not always with absolute certainty for a given pause." — 같은 출처

default 목표: `-XX:MaxGCPauseMillis=200` (200ms).

#### 마킹 알고리즘

> "It takes a virtual snapshot of the heap at the time of the Initial Mark pause, when all objects that were live at the start of marking are considered live for the remainder of marking." — 같은 출처

이걸 **SATB(Snapshot-At-The-Beginning)** 이라고 해요.

> 용어 변경 주의: 과거(JDK 8~9 시절)에는 이 페이즈를 **"Initial Mark"** 라고 불렀지만, JDK 10 이후 Oracle 문서에서는 **"Concurrent Start"** 라는 용어로 바뀌었어요. 위 인용은 옛 용어를 그대로 쓰고 있는데, 최신 G1 설명에서 "Concurrent Start" 가 나오면 같은 것을 가리키는 거예요.

### 4-4. ZGC (Z Garbage Collector)

> "The Z Garbage Collector (ZGC) is a scalable low latency garbage collector. ZGC performs all expensive work concurrently, without stopping the execution of application threads." — [Oracle JDK 17 — Available Collectors](https://docs.oracle.com/en/java/javase/17/gctuning/available-collectors.html)

OpenJDK 제안 문서의 목표 (JEP 333, 도입 당시):

- pause time < 10ms
- **pause time이 heap 크기나 live set 크기와 무관**
- 최대 heap 수 TB 단위 지원 (도입 시 4TB 목표, 이후 16TB까지 확장)

ZGC 상태 변천:

- [JEP 333 (JDK 11)](https://openjdk.org/jeps/333) — **Experimental**로 도입.
- [JEP 377 (JDK 15)](https://openjdk.org/jeps/377) — **Production ready** 선언. `-XX:+UnlockExperimentalVMOptions` 가 더 이상 필요없게 됨.
- [JEP 439 — Generational ZGC](https://openjdk.org/jeps/439) — JDK 21부터 Young/Old 세대 분리 버전 도입.

구현 핵심:

- **Colored Pointers** — 64비트 포인터에 metadata(mark, remap 플래그)를 박아넣어 load barrier로 상태 판단.
- **Load Barrier** — 참조를 읽을 때마다 barrier를 통해 포인터 상태를 보정.

### 4-5. Shenandoah

OpenJDK **JEP 189**의 핵심 목표(Red Hat 주도):

> "Pause times with Shenandoah are independent of heap size, meaning you will have the same consistent pause times whether your heap is 200 MB or 200 GB." — [OpenJDK JEP 189 — Shenandoah: A Low-Pause-Time Garbage Collector (Experimental)](https://openjdk.org/jeps/189)

- **marking과 compaction을 concurrent로 수행**.
- 구조는 G1과 유사하게 region 기반이지만, G1처럼 "STW evacuation"을 하지 않고 **mutator와 동시에 복사**.
- 과거에는 Brooks pointer(forwarding pointer)를 썼다가, 이후 load-reference barrier로 개선.

## 5. STW vs Concurrent 비교 표

| Collector | Young STW | Old STW | Concurrent 영역 | 용도 |
|---|---|---|---|---|
| Serial | O | O | 없음 | 소형/단일 CPU |
| Parallel | O | O | 없음 | throughput |
| G1 | O | 일부 STW + 일부 concurrent | marking | balanced (JDK 17 default) |
| ZGC | 매우 짧은 STW (root scan) | 대부분 concurrent | 거의 전부 | 저지연 대형 힙 |
| Shenandoah | 매우 짧은 STW | 대부분 concurrent | 거의 전부 | 저지연 |

## 6. Elasticsearch 관점에서의 의미

1. **최근 Elasticsearch 버전의 기본 GC는 G1**. JDK 9부터 HotSpot 자체의 default가 G1으로 바뀌었기 때문에, Elasticsearch도 번들 JDK 교체와 함께 자연스럽게 G1으로 전환됐어요. 관련 Elastic Labs 문서: [Elasticsearch heap size usage and JVM garbage collection](https://www.elastic.co/search-labs/blog/elasticsearch-heap-size-jvm-garbage-collection)
2. **STW 장시간 발생 시 노드가 클러스터에서 제거**돼요. master가 fault detection ping에 응답이 없으면 해당 노드를 비정상으로 봐요.
3. **힙이 커질수록 G1의 CSet/RSet 관리 비용이 커져요** → pause time도 길어질 가능성 → ES가 heap을 크게 주지 말라고 하는 근거 중 하나예요.
4. ES가 `-XX:+UseG1GC` 대신 ZGC를 쓰는 경우도 있지만, 일반 운영 권장은 여전히 G1이에요.

## 7. 자주 혼동되는 포인트

- "Full GC = Major GC = Old GC" 아니에요. **G1의 Full GC는 "비상 STW"** 이고, Major GC는 Old를 건드리는 광의의 표현이에요.
- "Minor GC는 짧다" 도 절대적이지 않아요. Young이 비정상적으로 크면 Minor도 길어져요.
- **CMS(Concurrent Mark Sweep)는 JDK 9부터 deprecated, JDK 14부터 제거**됐어요. 아직도 CMS를 언급하는 블로그는 과거 버전 기준이에요.

## 참고 문헌 (1차 소스)

- [Oracle JDK 17 — Available Collectors](https://docs.oracle.com/en/java/javase/17/gctuning/available-collectors.html)
- [Oracle JDK 17 — Garbage-First (G1) Garbage Collector](https://docs.oracle.com/en/java/javase/17/gctuning/garbage-first-g1-garbage-collector1.html)
- [Oracle JDK 21 — The Z Garbage Collector](https://docs.oracle.com/en/java/javase/21/gctuning/z-garbage-collector.html)
- [OpenJDK JEP 333 — ZGC: A Scalable Low-Latency Garbage Collector](https://openjdk.org/jeps/333)
- [OpenJDK JEP 377 — ZGC Production](https://openjdk.org/jeps/377)
- [OpenJDK JEP 189 — Shenandoah: A Low-Pause-Time Garbage Collector](https://openjdk.org/jeps/189)
- [OpenJDK JEP 379 — Shenandoah Production](https://openjdk.org/jeps/379)
- [OpenJDK JEP 439 — Generational ZGC](https://openjdk.org/jeps/439)
- [OpenJDK JEP 248 — Make G1 the Default Garbage Collector](https://openjdk.org/jeps/248)
- [OpenJDK JEP 523 — Make G1 the Default Garbage Collector in All Environments](https://openjdk.org/jeps/523)
- [OpenJDK HotSpot Glossary (Safepoint 정의)](https://openjdk.org/groups/hotspot/docs/HotSpotGlossary.html)
- [OpenJDK HotSpot Runtime Overview](https://openjdk.org/groups/hotspot/docs/RuntimeOverview.html)
- [Elastic Labs — Elasticsearch heap size and GC](https://www.elastic.co/search-labs/blog/elasticsearch-heap-size-jvm-garbage-collection)

---

**앞선 글**: [JVM Heap의 세대별 구조](/blog/theory/es-memory-01-jvm-heap)

**이어지는 글**: [JVM Off-heap과 Direct Memory](/blog/theory/es-memory-03-off-heap)

<!-- EN -->

> This document is based on **Oracle JDK 17 HotSpot VM** + OpenJDK JEP primary sources. The general theory like Safepoint and Mark-Sweep is briefly covered in [Part 0](/blog/theory/jvm-and-gc); this post focuses on what directly affects Elasticsearch operations: **G1/ZGC/Shenandoah** and **what is actually included in the Oracle JDK build**.

## 1. Why You Need This Theory

The most common incident category in Elasticsearch operations is *"GC took too long, the node got dropped from the cluster."* Even Elastic's official docs explicitly warn, **"Larger heaps can also cause longer garbage collection pauses"** when explaining heap sizing. ([Elastic — Advanced configuration](https://www.elastic.co/guide/en/elasticsearch/reference/current/advanced-configuration.html))

So *"what GCs exist, and when/why each pauses"* is a baseline requirement for ES operations.

## 2. What GC Has to Do

GC's whole job is to **find objects that are no longer referenced (garbage) and reclaim them**. To do this safely, GC must not traverse the object graph while application threads are mutating it. So HotSpot uses a synchronization point called **Safepoint**.

### 2-1. Safepoint and Stop-the-World (STW)

Official definition from the OpenJDK HotSpot Glossary:

> "safepoint: A point during program execution at which all GC roots are known and all heap object contents are consistent. From a global point of view, all threads must block at a safepoint before the GC can run. (As a special case, threads running JNI code can continue to run, because they use only handles. During a safepoint they must block instead of loading the contents of the handle.) From a local point of view, a safepoint is a distinguished point in a block of code where the executing thread may block for the GC." — [OpenJDK HotSpot Glossary](https://openjdk.org/groups/hotspot/docs/HotSpotGlossary.html)

So **Stop-the-World** is the state where all Java threads are blocked at a safepoint before GC runs. JNI native code uses only handles so it can keep running, but the moment it touches handle contents, it blocks too. GC performance is mostly judged by **"how short you can keep the STW window."**

Further reading: [OpenJDK HotSpot Runtime Overview](https://openjdk.org/groups/hotspot/docs/RuntimeOverview.html) explains the role of safepoint in the broader VM runtime architecture (e.g., on VM shutdown, *"Stop VM thread, it will bring the remaining VM to a safepoint"*).

## 3. The Collectors HotSpot Provides (JDK 17)

Only the ones explicitly named in Oracle's JDK 17 official ["Available Collectors"](https://docs.oracle.com/en/java/javase/17/gctuning/available-collectors.html):

| Collector | Flag | Character | Purpose | In Oracle JDK 17? |
|---|---|---|---|---|
| Serial GC | `-XX:+UseSerialGC` | single-threaded STW | small datasets / single CPU | yes |
| Parallel GC | `-XX:+UseParallelGC` | multi-threaded STW | maximize throughput | yes |
| G1 GC | `-XX:+UseG1GC` | **mostly concurrent** | predictable pause time (default) | yes |
| Z GC | `-XX:+UseZGC` | **fully concurrent** | ultra-low latency (a few ms) | yes (production-ready since JDK 15) |
| Shenandoah | `-XX:+UseShenandoahGC` | **fully concurrent** | pauses independent of heap size | **no (not built into Oracle JDK)** |

**G1 is the default in JDK 17.** Oracle doc: *"G1 is selected by default on most hardware and operating system configurations"* ([Oracle JDK 17 — Available Collectors](https://docs.oracle.com/en/java/javase/17/gctuning/available-collectors.html))

> G1 became the default starting with **JDK 9**, per [OpenJDK JEP 248 — Make G1 the Default Garbage Collector](https://openjdk.org/jeps/248). Before that (JDK 8 and earlier), the default was Parallel GC.

> Note: **JEP 523** targets JDK 25 and aims to make G1 the default *"in all environments (including client)."* ([OpenJDK JEP 523](https://openjdk.org/jeps/523))

### 3-1. Shenandoah Is Not in Oracle JDK (Important)

Shenandoah is included in OpenJDK upstream but is **excluded from the Oracle JDK build at build time**. So:

- **After installing Oracle JDK 17, passing `-XX:+UseShenandoahGC` will fail at startup.**
- To use Shenandoah, you have to use an OpenJDK-based distribution like **Red Hat build of OpenJDK, Eclipse Temurin, Azul Zulu, or Amazon Corretto**.

Shenandoah-related JEPs:

- [JEP 189 — Shenandoah (Experimental, JDK 12)](https://openjdk.org/jeps/189)
- [JEP 379 — Shenandoah: Production (JDK 15)](https://openjdk.org/jeps/379)

Elasticsearch ships its bundled JDK as Eclipse Temurin-family OpenJDK, so Shenandoah is theoretically usable, but **the recommended production GC is still G1; Shenandoah/ZGC are for special cases**.

## 4. Detailed Look at the Main Collectors

### 4-1. Serial GC

> "The serial collector uses a single thread to perform all garbage collection work, which makes it relatively efficient because there is no communication overhead between threads." — [Oracle JDK 17 — Available Collectors](https://docs.oracle.com/en/java/javase/17/gctuning/available-collectors.html)

- Single-threaded STW.
- Young uses copying; Old uses **mark-sweep-compact**.
- Makes sense for tiny heaps (~100MB) or container/single-CPU environments. Almost never used in Elasticsearch.

### 4-2. Parallel GC (Throughput Collector)

> "The parallel collector is also known as throughput collector, it's a generational collector similar to the serial collector. The primary difference between the serial and parallel collectors is that the parallel collector has multiple threads that are used to speed up garbage collection." — [Oracle JDK 17 — Available Collectors](https://docs.oracle.com/en/java/javase/17/gctuning/available-collectors.html)

- Parallel STW for both Young and Old via multiple threads.
- Optimizes **throughput** (ratio of application execution per unit time). Pause time can be long.
- Good for batch / offline processing. Bad fit for a search engine (real-time queries).

### 4-3. G1 GC (Garbage-First) — JDK 17 default

G1 is the most important collector, so I am quoting Oracle's official ["Garbage-First (G1) Garbage Collector"](https://docs.oracle.com/en/java/javase/17/gctuning/garbage-first-g1-garbage-collector1.html) directly.

#### Structure

> "G1 partitions the heap into a set of equally sized heap regions, each a contiguous range of virtual memory."

So instead of carving Young/Old as **fixed contiguous memory blocks**, it splits the heap into **a set of equal-sized regions**. Region size is 1-32MB, auto-computed so that **total region count is around 2048**.

A region serves one of these roles:

- **Eden region**
- **Survivor region**
- **Old region**
- **Humongous region** — dedicated to large objects bigger than half a region. Spans multiple consecutive regions.

#### Reclamation Approach

> "G1 reclaims space mostly by using evacuation: live objects found within selected memory areas to collect are copied into new memory areas, compacting them in the process." — same source

- **Evacuation**: copy only live objects from the regions being collected into new regions. **Compaction** happens naturally as part of this.
- **Collection Set (CSet)**: the set of regions to reclaim in this GC. This concept is what lets G1 **"pick the regions with the most garbage per unit cost first"** — and that is the origin of the name *Garbage-First*.
- **Remembered Set (RSet)**: tracks references coming into a region from outside. Lets GC operate per-region without scanning the whole heap.

#### Phases

1. **Young-only phase** — ordinary young collection on Eden/Survivor.
2. **Concurrent Start** — when Old Generation occupancy hits IHOP (Initiating Heap Occupancy Percent), concurrent marking begins.
3. **Remark / Cleanup** — finish marking; reclaim fully empty regions immediately.
4. **Space-Reclamation phase (Mixed GC)** — evacuate Young + some Old regions together.
5. **Full GC** — emergency fallback. Whole-heap STW compaction. By design, G1 wants this never to happen.

#### Pause-time Goal

> "G1 tries to meet set pause-time targets with high probability over a longer time, but not always with absolute certainty for a given pause." — same source

Default goal: `-XX:MaxGCPauseMillis=200` (200ms).

#### Marking Algorithm

> "It takes a virtual snapshot of the heap at the time of the Initial Mark pause, when all objects that were live at the start of marking are considered live for the remainder of marking." — same source

This is called **SATB (Snapshot-At-The-Beginning)**.

> Terminology note: in older docs (JDK 8-9 era) this phase was called **"Initial Mark"**, but since JDK 10 Oracle's docs call it **"Concurrent Start"**. The quote above uses the old term — when newer G1 material says *"Concurrent Start,"* it is the same thing.

### 4-4. ZGC (Z Garbage Collector)

> "The Z Garbage Collector (ZGC) is a scalable low latency garbage collector. ZGC performs all expensive work concurrently, without stopping the execution of application threads." — [Oracle JDK 17 — Available Collectors](https://docs.oracle.com/en/java/javase/17/gctuning/available-collectors.html)

Goals from the OpenJDK proposal (JEP 333, at introduction):

- pause time < 10ms
- **pause time independent of heap size or live set size**
- supports heaps up to TB-scale (initial target was 4TB; later extended to 16TB)

ZGC status timeline:

- [JEP 333 (JDK 11)](https://openjdk.org/jeps/333) — introduced as **Experimental**.
- [JEP 377 (JDK 15)](https://openjdk.org/jeps/377) — declared **Production ready**. `-XX:+UnlockExperimentalVMOptions` no longer required.
- [JEP 439 — Generational ZGC](https://openjdk.org/jeps/439) — generational variant introduced in JDK 21.

Implementation core:

- **Colored Pointers** — metadata bits (mark, remap flags) embedded in 64-bit pointers; load barrier reads them to determine state.
- **Load Barrier** — every reference read goes through a barrier that fixes up the pointer state.

### 4-5. Shenandoah

The core goal of OpenJDK **JEP 189** (Red Hat-led):

> "Pause times with Shenandoah are independent of heap size, meaning you will have the same consistent pause times whether your heap is 200 MB or 200 GB." — [OpenJDK JEP 189 — Shenandoah: A Low-Pause-Time Garbage Collector (Experimental)](https://openjdk.org/jeps/189)

- Performs **marking and compaction concurrently**.
- Region-based structure similar to G1, but instead of doing G1's "STW evacuation," it copies **concurrently with the mutator**.
- Used to use Brooks pointers (forwarding pointers); later improved to load-reference barriers.

## 5. STW vs Concurrent Comparison

| Collector | Young STW | Old STW | Concurrent area | Use case |
|---|---|---|---|---|
| Serial | yes | yes | none | small / single-CPU |
| Parallel | yes | yes | none | throughput |
| G1 | yes | partly STW + partly concurrent | marking | balanced (JDK 17 default) |
| ZGC | very short STW (root scan) | mostly concurrent | nearly everything | low-latency large heap |
| Shenandoah | very short STW | mostly concurrent | nearly everything | low-latency |

## 6. What This Means From an Elasticsearch Angle

1. **The default GC of recent Elasticsearch versions is G1.** Since JDK 9, HotSpot itself defaults to G1, so Elasticsearch transitioned naturally with its bundled JDK upgrades. Related Elastic Labs post: [Elasticsearch heap size usage and JVM garbage collection](https://www.elastic.co/search-labs/blog/elasticsearch-heap-size-jvm-garbage-collection)
2. **A long STW gets the node removed from the cluster.** If the master sees no fault-detection ping response, it marks the node unhealthy.
3. **The bigger the heap, the more G1's CSet/RSet management costs** → pause time may grow → one of the reasons ES tells you not to give it a giant heap.
4. Some setups run ZGC instead of `-XX:+UseG1GC`, but the standard production recommendation is still G1.

## 7. Commonly Confused Points

- *"Full GC = Major GC = Old GC"* is wrong. **G1's Full GC is an "emergency STW"**, while Major GC is a loose term for anything touching Old.
- *"Minor GC is short"* is not absolute either. If Young is abnormally large, Minor gets long too.
- **CMS (Concurrent Mark Sweep) was deprecated in JDK 9 and removed in JDK 14.** Blog posts that still talk about CMS are based on older versions.

## References (Primary Sources)

- [Oracle JDK 17 — Available Collectors](https://docs.oracle.com/en/java/javase/17/gctuning/available-collectors.html)
- [Oracle JDK 17 — Garbage-First (G1) Garbage Collector](https://docs.oracle.com/en/java/javase/17/gctuning/garbage-first-g1-garbage-collector1.html)
- [Oracle JDK 21 — The Z Garbage Collector](https://docs.oracle.com/en/java/javase/21/gctuning/z-garbage-collector.html)
- [OpenJDK JEP 333 — ZGC: A Scalable Low-Latency Garbage Collector](https://openjdk.org/jeps/333)
- [OpenJDK JEP 377 — ZGC Production](https://openjdk.org/jeps/377)
- [OpenJDK JEP 189 — Shenandoah: A Low-Pause-Time Garbage Collector](https://openjdk.org/jeps/189)
- [OpenJDK JEP 379 — Shenandoah Production](https://openjdk.org/jeps/379)
- [OpenJDK JEP 439 — Generational ZGC](https://openjdk.org/jeps/439)
- [OpenJDK JEP 248 — Make G1 the Default Garbage Collector](https://openjdk.org/jeps/248)
- [OpenJDK JEP 523 — Make G1 the Default Garbage Collector in All Environments](https://openjdk.org/jeps/523)
- [OpenJDK HotSpot Glossary (Safepoint definition)](https://openjdk.org/groups/hotspot/docs/HotSpotGlossary.html)
- [OpenJDK HotSpot Runtime Overview](https://openjdk.org/groups/hotspot/docs/RuntimeOverview.html)
- [Elastic Labs — Elasticsearch heap size and GC](https://www.elastic.co/search-labs/blog/elasticsearch-heap-size-jvm-garbage-collection)

---

**Previous**: [Generational Heap Structure on the JVM](/blog/theory/es-memory-01-jvm-heap)

**Next**: [JVM Off-heap and Direct Memory](/blog/theory/es-memory-03-off-heap)

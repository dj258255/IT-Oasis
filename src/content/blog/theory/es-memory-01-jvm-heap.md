---
title: 'JVM 메모리 ①: Heap 세대 구조'
description: JVM Heap이 Young/Old Generation, Eden/Survivor로 나뉘는 이유와 NewRatio·SurvivorRatio 같은 튜닝 파라미터를 Oracle JDK 17 공식 문서 기준으로 뜯어봤습니다. G1에서 이 파라미터들을 왜 건드리면 안 되는지까지 짚습니다.
date: 2026-04-10T00:00:00.000Z
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

> 본 문서는 **Oracle JDK 17 HotSpot VM** 기준입니다. 버전에 따라 default 값이 다르므로, 다른 버전을 쓴다면 각 버전 문서를 교차 확인해야 합니다. JVM 아키텍처 전반(클래스 로더, Runtime Data Areas, Execution Engine, JIT 등)은 [0편](/blog/theory/jvm-and-gc)에서 다뤘고, 이 글은 그중에서 **Elasticsearch 운영에 직결되는 Heap 구조**만 발췌해 심화한 버전입니다.

## 1. 왜 이 이론을 알아야 하는가

Elasticsearch는 JVM 위에서 돌아가는 Java 애플리케이션입니다. Elasticsearch 노드가 메모리 이슈로 죽거나 느려지는 원인은 **대부분 JVM Heap과 GC에서 발생**합니다. 그래서 ES의 "heap은 전체 RAM의 50% 이하로 설정하라"는 가이드도, JVM Heap이 무엇이고 어떻게 쓰이는지를 이해해야 왜 그런지 설명할 수 있습니다.

즉, 이 문서는 `Xms`, `Xmx`, `Young/Old Generation`, `Eden/Survivor` 같은 용어가 **구조상 어디에 위치한 무엇을 의미하는지** 1차 소스 기준으로 정리합니다.

## 2. JVM 메모리의 큰 그림

JVM 프로세스의 메모리는 크게 두 덩어리로 나뉩니다.

1. **Heap 영역**: `new`로 생성된 **객체가 저장되는 영역**입니다. GC의 대상이 바로 이 영역입니다.
2. **Non-heap 영역**: 클래스 메타데이터(Metaspace), 스레드 스택, 코드 캐시(JIT), Direct Memory, GC 자체 구조 등입니다.

`-Xms`, `-Xmx`가 조절하는 것은 **Heap 영역의 크기뿐**입니다. 따라서 "Xmx 8g를 줬는데 JVM 프로세스가 12g를 쓴다"는 것은 Non-heap 영역이 추가로 잡혀 있기 때문이고, 버그가 아닙니다. (Non-heap의 대표 항목인 Direct Buffer는 [Off-heap Memory 편](/blog/theory/es-memory-03-off-heap) 참조)

## 3. Heap의 세대별 구조 (Generational Hypothesis)

HotSpot은 **"대부분의 객체는 금방 죽는다"** 라는 **세대별 가설(Generational Hypothesis)** 에 기반해서 Heap을 두 세대로 나눕니다.

![JVM Heap 구조: Young Generation(Eden, S0, S1)과 Old Generation](/uploads/theory/es-memory/heap-structure.svg)

> 위 그림은 Serial/Parallel GC 같은 **고전적 세대 collector** 의 물리적 레이아웃입니다. **G1 GC는 Young/Old를 고정된 연속 메모리로 두지 않고, 동일 크기 region들에 "young"/"old" 라벨을 붙이는 방식**을 씁니다. 개념적으로는 같은 두 세대지만 레이아웃이 다릅니다. 자세한 내용은 [GC 알고리즘 편](/blog/theory/es-memory-02-gc) 참조.

### 3-1. Young Generation (신세대)

Oracle 공식 문서(JDK 8 GC Tuning Guide, "Generations" 챕터)의 정의:

> "The young generation consists of eden and two survivor spaces. ... One survivor space is empty at any time, and serves as the destination of any live objects in eden; the other survivor space is the destination during the next copying collection." — [Oracle JDK 8 GC Tuning Guide — Generations](https://docs.oracle.com/javase/8/docs/technotes/guides/vm/gctuning/generations.html)

이 구조 설명은 JDK 8 문서가 가장 직설적이라 인용했습니다. 같은 개념은 JDK 17 문서의 ["Factors Affecting Garbage Collection Performance"](https://docs.oracle.com/en/java/javase/17/gctuning/factors-affecting-garbage-collection-performance.html)에도 eden/survivor 튜닝 문맥으로 등장합니다.

정리하면:

- **Eden**: 새로 `new`된 객체가 처음 할당되는 곳입니다.
- **Survivor 0 / Survivor 1 (S0 / S1)**: 두 개의 동일한 크기 공간이며, 한 쪽은 항상 비어 있습니다.
- **Young GC (Minor GC)**: Eden이 꽉 차면 발생합니다. Eden과 현재 사용 중인 Survivor의 **살아있는 객체**만 다음 Survivor로 **복사**하고, 나머지는 한 번에 버립니다.
- **Promotion(승격)**: Young GC를 일정 횟수 이상 살아남은 객체는 Old Generation으로 옮겨집니다. 이 횟수를 **tenuring threshold** 라고 하며, GC가 동적으로 조정합니다.

### 3-2. Old Generation (구세대)

장수 객체(live data)가 모이는 영역입니다. **Major GC**(Old 영역 회수)의 대상이고, Young GC 대비 훨씬 비싸며 STW(Stop-the-World) 시간이 깁니다. (Major GC는 Old 영역만, **Full GC**는 Young+Old 전체 힙을 STW로 쓸어담는 별개 개념입니다. 자세한 내용은 ②편에서 다룹니다.)

### 3-3. Metaspace (세대가 아님)

Java 8부터 PermGen이 사라지고 **Metaspace** 로 대체됐습니다. Metaspace는 Heap이 아닌 **Native Memory**에 위치하며, 클래스 메타데이터(메서드 정보, 상수풀 등)를 저장합니다. `-Xmx`와는 별개로 관리됩니다.

## 4. 핵심 튜닝 파라미터 (JDK 17 기준)

> **중요**: 아래 파라미터들은 **Parallel GC / Serial GC 같은 "고전적 세대 collector"** 를 전제로 서술된 문서에서 나온 것입니다. JDK 17의 default collector인 **G1 GC에서는 `NewRatio`, `NewSize`, `Xmn` 사용을 공식적으로 권장하지 않습니다.** 자세한 이유는 이 절의 4-2에서 다룹니다.

다음 값들은 Oracle 공식 GC Tuning Guide에서 직접 확인한 내용입니다.

| 파라미터 | Default | 의미 |
|---|---|---|
| `-Xms` / `-Xmx` | 시스템/ergonomics 의존 | 초기/최대 Heap 크기. 운영에서는 같은 값으로 고정 권장 |
| `-XX:NewRatio` | `2` (Parallel/Serial) | Young:Old = 1:N. `2`이면 Young이 전체 Heap의 1/3 |
| `-XX:SurvivorRatio` | `8` | Eden:Survivor = N:1. `8`이면 각 Survivor가 Eden의 1/8 |
| `-XX:NewSize`, `-XX:MaxNewSize` | ergonomics 의존 | Young Generation의 하한/상한 (명시적 값은 버전·플랫폼마다 다르므로 단일 숫자로 표기하지 않음) |
| `-XX:MinHeapFreeRatio` | `40%` | Heap free 공간이 이보다 낮으면 확장 시도 |
| `-XX:MaxHeapFreeRatio` | `70%` | Heap free 공간이 이보다 높으면 축소 시도 |

> "Setting `-XX:NewRatio=3` means that the ratio between the young and old generation is 1:3. In other words, the combined size of the eden and survivor spaces will be one-fourth of the total heap size." — [Oracle JDK 17 GC Tuning Guide](https://docs.oracle.com/en/java/javase/17/gctuning/factors-affecting-garbage-collection-performance.html)

> "Setting `-XX:SurvivorRatio=6` sets the ratio between eden and a survivor space to 1:6. In other words, each survivor space will be one-sixth of the size of eden, and thus one-eighth of the size of the young generation (not one-seventh, because there are two survivor spaces).", 같은 출처

### 4-1. 트레이드오프

공식 문서가 직접 짚는 트레이드오프는 다음과 같습니다.

> "The bigger the young generation, the less often minor collections occur. However, for a bounded heap size, a larger young generation implies a smaller old generation, which will increase the frequency of major collections." — [Oracle JDK 17 GC Tuning Guide](https://docs.oracle.com/en/java/javase/17/gctuning/factors-affecting-garbage-collection-performance.html)

즉, Young을 키우면 Minor GC 빈도가 줄지만 Major GC 빈도가 늘어납니다. 무조건 크게 잡는다고 좋은 것은 아닙니다.

### 4-2. G1에서는 NewRatio / NewSize / Xmn을 쓰지 말라 (공식 권고)

Oracle JDK 17 G1 Tuning Guide의 명시적 경고:

> "Avoid limiting the young generation size to particular values by using options like `-Xmn`, `-XX:NewRatio` and others because the young generation size is the main means for G1 to allow it to meet the pause-time. Setting the young generation size to a single value overrides and practically disables pause-time control." — [Oracle JDK 17 — G1 Garbage Collector Tuning](https://docs.oracle.com/en/java/javase/17/gctuning/garbage-first-garbage-collector-tuning.html)

이유:

- G1은 pause-time 목표(`-XX:MaxGCPauseMillis`, default 200ms)를 맞추기 위해 **매 young collection마다 Young Generation 크기를 동적으로 재조정**합니다.
- `NewRatio`/`Xmn`으로 Young 크기를 고정하면 이 자동 조정을 **비활성화**하는 셈이 되어 pause-time 제어 기능 자체가 무력화됩니다.

따라서 G1을 쓰는 환경(= JDK 9+ 기본, 대부분의 Elasticsearch 운영)에서는 위 표의 파라미터 중 **`Xms`/`Xmx`와 `MaxGCPauseMillis`만 건드리고 나머지는 default를 그대로 둬야** 합니다. `NewRatio`/`SurvivorRatio` 파라미터를 여기서 먼저 설명한 것은 개념 이해를 돕기 위함이며, 실전 튜닝에서 G1 환경이라면 건드리지 말아야 한다는 뜻입니다.

## 5. 객체 할당과 승격 흐름 (life cycle)

1. `new Foo()` → **TLAB(Thread Local Allocation Buffer)** 을 통해 Eden에 할당.
2. Eden이 꽉 참 → **Minor GC** 발생.
    - 살아남은 객체는 현재 비어있는 Survivor(S1)로 복사.
    - Eden과 다른 Survivor(S0)는 한 번에 비워집니다.
3. 다음 Minor GC에서 S1 → S0로 복사되며 age 카운트가 올라갑니다.
4. age가 **tenuring threshold** 를 넘으면 → **Old Generation으로 Promotion**.
5. Old Generation이 꽉 참 → **Major GC**(필요 시 전체 힙 **Full GC**).

> "At each garbage collection, the virtual machine chooses a threshold number, which is the number of times an object can be copied before it's old. This threshold is chosen to keep the survivors half full." — [Oracle JDK 17 GC Tuning Guide](https://docs.oracle.com/en/java/javase/17/gctuning/factors-affecting-garbage-collection-performance.html)

### 5-1. Survivor가 너무 작으면?

> "If survivor spaces are too small, then the copying collection overflows directly into the old generation.", 같은 출처

즉 Survivor가 작으면 원래 Young에서 수명을 다 채워야 할 객체가 **조기 승격(premature promotion)** 돼서 Old Generation이 빨리 차고, Major GC가 빨라집니다. 이것이 Full GC 빈도가 비정상적으로 높은 애플리케이션의 전형적 원인 중 하나입니다.

## 6. Elasticsearch 관점에서의 의미

1. **ES는 Heap을 최대 ~26~30GB 이하로 권장**합니다. GC 비용과 compressed OOPs 때문이며, 이는 [Elasticsearch 메모리 모델 편](/blog/theory/es-memory-05-elasticsearch)에서 자세히 다룹니다.
2. **ES의 Heap 50% 룰**은 "나머지 50%는 OS Page Cache용으로 남겨라"라는 뜻입니다. 즉 `Xmx`가 JVM Heap에만 해당하고, **나머지 메모리는 OS가 Lucene 인덱스 파일을 캐싱하는 데 쓴다**는 전제가 깔려 있습니다. Page Cache 개념은 [OS Page Cache 편](/blog/theory/es-memory-04-page-cache) 참조.
3. Heap이 커질수록 **GC STW 시간이 길어지고**, 그 사이 ES 노드는 heartbeat를 못 보내서 클러스터에서 빠질 수 있습니다.

## 참고 문헌 (1차 소스)

- [Oracle JDK 17 HotSpot VM Garbage Collection Tuning Guide — Factors Affecting GC Performance](https://docs.oracle.com/en/java/javase/17/gctuning/factors-affecting-garbage-collection-performance.html)
- [Oracle JDK 17 HotSpot VM GC Tuning Guide — Available Collectors](https://docs.oracle.com/en/java/javase/17/gctuning/available-collectors.html)
- [Oracle JDK 17 — G1 Garbage Collector Tuning](https://docs.oracle.com/en/java/javase/17/gctuning/garbage-first-garbage-collector-tuning.html)
- [Oracle JDK 8 GC Tuning Guide — Generations (세대별 가설 원문 설명)](https://docs.oracle.com/javase/8/docs/technotes/guides/vm/gctuning/generations.html)
- [Oracle JDK 8 GC Tuning Guide — Sizing the Generations](https://docs.oracle.com/javase/8/docs/technotes/guides/vm/gctuning/sizing.html)
- [OpenJDK HotSpot Runtime Overview](https://openjdk.org/groups/hotspot/docs/RuntimeOverview.html)

---

**이어지는 글**: [JVM의 GC 알고리즘과 Stop-the-World](/blog/theory/es-memory-02-gc)

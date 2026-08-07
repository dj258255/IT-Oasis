---
title: 'JVM 메모리 ⑤: Elasticsearch 메모리 모델'
description: 앞선 0~4편의 JVM/OS 메모리 이론을 Elasticsearch 운영 맥락 하나로 묶는 캡스톤 편. 왜 Heap이 26~30GB에서 끊기는지(compressed oops), hybridfs가 어떤 파일만 mmap하는지, circuit breaker가 heap 40/60/95%에 왜 걸려있는지 공식 문서로 정리했습니다.
date: 2026-04-14T00:00:00.000Z
tags:
  - Elasticsearch
  - JVM
  - Compressed OOPs
  - mmap
  - Circuit Breaker
  - hybridfs
  - Memory Management
category: theory/JVM-Memory
draft: false
coverImage: "/uploads/theory/es-memory/cover-5.svg"
series: "JVM 메모리"
seriesOrder: 5
---

> 본 문서는 **Elastic 공식 reference** 와 **Elastic 엔지니어가 작성한 기술 블로그** 를 1차 소스로 합니다. 문서 버전은 Elasticsearch 8.x 기준입니다. 0~4편에서 쌓은 JVM/OS 이론을 **Elasticsearch 운영 맥락 하나로 묶는 캡스톤** 편입니다.

## 1. 왜 이 이론을 알아야 하는가

앞선 네 글([JVM Heap의 세대별 구조](/blog/theory/es-memory-01-jvm-heap), [JVM의 GC 알고리즘과 Stop-the-World](/blog/theory/es-memory-02-gc), [JVM Off-heap과 Direct Memory](/blog/theory/es-memory-03-off-heap), [OS Page Cache가 ES 성능을 결정하는 이유](/blog/theory/es-memory-04-page-cache))를 **Elasticsearch 맥락 하나로 묶는 글**입니다.

Elasticsearch의 메모리 모델은 다음 네 가지 원칙을 모두 동시에 만족시키기 위한 설계입니다.

1. GC STW를 짧게 유지한다 → **Heap을 너무 키우지 말자**
2. compressed oops를 유지한다 → **Heap을 32GB 근처에서 끊자**
3. Lucene은 OS page cache에 얹어 쓴다 → **RAM의 반은 OS에 주자**
4. OOM으로 노드가 죽지 않도록 한다 → **circuit breaker로 요청 단위 보호**

## 2. 원칙 1: Xms = Xmx, RAM의 50% 이하

Elastic 공식 문서의 직접 지시:

> "Set `Xms` and `Xmx` to no more than 50% of the total memory available to each Elasticsearch node. Elasticsearch requires memory for purposes other than the JVM heap. For example, Elasticsearch uses off-heap buffers for efficient network communication and relies on the operating system's filesystem cache for efficient access to files." — [Elastic — Advanced configuration](https://www.elastic.co/guide/en/elasticsearch/reference/current/advanced-configuration.html)

정리:

- `Xms`와 `Xmx`는 **반드시 같은 값**으로 세팅 (*"The minimum and maximum values must be the same."*).
- **RAM의 50% 이하**로 두는 이유 두 가지:
  1. **off-heap buffer** (Netty 네트워크 버퍼 등): [JVM Off-heap과 Direct Memory](/blog/theory/es-memory-03-off-heap)
  2. **filesystem cache**: [OS Page Cache가 ES 성능을 결정하는 이유](/blog/theory/es-memory-04-page-cache)

왜 `Xms = Xmx`여야 할까요? JVM이 실행 중에 Heap을 동적으로 늘렸다 줄였다 하면 reserved memory 재계산, GC region 재조정 등의 비용이 발생합니다. ES는 이걸 피합니다.

## 3. 원칙 2: Compressed OOPs와 32GB 한계

### 3-1. Compressed OOPs란?

OOP = **Ordinary Object Pointer** (Java 객체에 대한 참조 포인터).

64-bit JVM에서 포인터 하나가 원래 8바이트입니다. 객체가 많으면 포인터 메모리 오버헤드가 엄청 커집니다. **Compressed OOPs** 는 **heap 내부의 포인터를 4바이트로 저장**하고 실제 접근 시 8바이트 주소로 디코딩하는 최적화입니다.

OpenJDK HotSpot Wiki의 공식 설명을 기반으로 정확히 정리하면:

1. HotSpot은 **모든 객체를 8-byte alignment** 에 맞춰 할당합니다. 즉 객체 주소의 하위 3비트가 항상 `000`입니다.
2. 그 3비트를 저장할 필요가 없으므로 **32비트(narrow oop)로 저장**하고, 접근할 때 `<< 3` (× 8) 연산으로 복원합니다.
3. 디코딩 공식:
    ```
    real_address = narrow_oop_base + (narrow_oop << 3) + field_offset
    ```
4. 32비트로 표현 가능한 값의 수가 2^32 = 약 42억, 각 값이 8바이트 단위 주소를 가리키므로:
    ```
    2^32 × 8 byte = 32 GByte
    ```
    가 최대 addressable 힙이 됩니다. ([OpenJDK HotSpot — CompressedOops](https://wiki.openjdk.org/display/HotSpot/CompressedOops))

Elastic 엔지니어링 블로그 *"A Heap of Trouble"* 는 같은 내용을 다음과 같이 서술합니다:

> "keep all objects aligned on 8-byte boundaries and then we can assume the last three bits of 35-bit oops are zeros." — [Elastic Blog — A Heap of Trouble](https://www.elastic.co/blog/a-heap-of-trouble)

여기서 "35-bit oops" 는 **저장은 32비트지만 실제 표현하는 주소 공간이 2^35 = 32GB 이기 때문** 에 나온 표현입니다. 저장 비트 수와 표현 가능한 주소 범위를 구분해서 이해해야 합니다.

### 3-2. 32GB를 넘으면 무슨 일이 일어나는가

Heap이 32GB를 넘으면 JVM은 compressed oops를 **끌 수밖에 없습니다**. 그 순간:

- 모든 포인터가 4바이트 → 8바이트로 2배 늘어납니다.
- 그래서 예를 들어 **33GB heap을 줬는데 실제 유효 공간은 30GB보다 작다** 는 역전 현상이 발생합니다.
- "32GB를 넘기느니 차라리 31GB로 둬라" 가 여기서 나옵니다.

### 3-3. Zero-Based Compressed OOPs: 왜 26GB가 "안전한" 숫자인가

같은 Elastic 블로그에서 추가 최적화를 설명합니다:

> "a simple 3-bit shift is all that is needed for encoding and decoding between native 64-bit pointers and compressed oops." — [Elastic Blog — A Heap of Trouble](https://www.elastic.co/blog/a-heap-of-trouble)

Heap이 주소 0부터 시작하면 압축 포인터 계산이 **3-bit shift 하나**로 끝납니다(= zero-based compressed oops).

하지만 OS 메모리 할당 상황에 따라 JVM이 **0번지에서 시작 못 하는 경우**가 있고, 그러면:

> "a null check" and additional arithmetic operations, causing "a significant drop in performance." — 같은 출처

그래서 Elastic은 보수적으로 **"26GB는 어디서든 안전, 30GB까지 가능"** 이라고 권고합니다:

> "Set `Xms` and `Xmx` to no more than the threshold for compressed ordinary object pointers (oops). The exact threshold varies but 26GB is safe on most systems and can be as large as 30GB on some systems." — [Elastic — Advanced configuration](https://www.elastic.co/guide/en/elasticsearch/reference/current/advanced-configuration.html)

확인 방법: ES 기동 로그에 `compressed ordinary object pointers [true]` 가 찍히는지 봅니다.

### 3-4. 두 제약의 교집합

실제 운영에서는 두 룰을 **같이** 적용해야 합니다.

```
Xmx = min( RAM × 0.5, 30GB 근처 )
```

예:

- RAM 64GB → `min(32, 30) = 30GB`
- RAM 128GB → `min(64, 30) = 30GB` (남는 98GB는 전부 page cache로)

## 4. 원칙 3: Lucene 파일은 mmap으로 Page Cache에 얹는다

### 4-1. Store type: hybridfs (default)

Elastic 공식 문서:

> "The default file system implementation ... is currently `hybridfs` on all supported systems." — [Elastic — Index store settings](https://www.elastic.co/guide/en/elasticsearch/reference/current/index-modules-store.html)

> "The `hybridfs` type is a hybrid of `niofs` and `mmapfs`, which chooses the best file system type for each type of file based on the read access pattern. Currently only the Lucene term dictionary, norms and doc values files are memory mapped." — 같은 출처

즉 Elasticsearch의 default는 **Lucene의 일부 파일만 mmap** 하고 나머지는 NIO로 읽는 하이브리드 전략입니다.

| 파일 타입 | 접근 방식 | 이유 |
|---|---|---|
| **Term dictionary** (`.tim`, `.tip`) | **mmap** | 랜덤 접근이 매우 많고, 반복 접근되므로 Page Cache에 올려두는 이득이 큼 |
| **Doc values** (`.dvd`, `.dvm`) | **mmap** | 정렬/집계 시 column-wise 랜덤 접근 |
| **Norms** (`.nvd`, `.nvm`) | **mmap** | 스코어링에 필수로 자주 접근 |
| **Postings**, **stored fields** 등 | **NIO(niofs)** | 대부분 순차 접근, mmap 이점이 상대적으로 작음 |

### 4-2. 왜 mmap을 "일부만"에 쓰는가

- mmap은 **가상 주소 공간을 파일 크기만큼 차지**합니다. 전체를 다 mmap하면 주소 공간 압박이 커집니다.
- 용량이 큰 postings를 통째로 mmap하면 **Page Cache 회전**이 잦아집니다. 오히려 NIO로 필요한 만큼만 읽는 게 유리한 경우가 있습니다.

### 4-3. vm.max_map_count

Elasticsearch가 mmap 기반으로 동작하기 때문에 **Linux 커널의 mmap 상한**이 낮으면 문제가 됩니다. ES 문서가 공식적으로 요구하는 설정:

```
sysctl -w vm.max_map_count=262144
```

이건 mmap으로 만들 수 있는 VMA(Virtual Memory Area)의 최대 개수입니다. 대부분의 Linux 배포판 default는 6만대 수준(예: 65530)이고, 대형 인덱스나 샤드가 많을 때 부족해집니다. 그래서 ES는 공식적으로 `262144` 이상을 요구합니다. ([Elastic — Virtual memory check](https://www.elastic.co/guide/en/elasticsearch/reference/current/vm-max-map-count.html))

## 5. 원칙 4: Circuit Breaker

Circuit breaker는 **요청이 heap을 먹어치우는 걸 사전 차단**하는 장치입니다.

Elastic 공식 정의 (troubleshooting 문서):

> "Elasticsearch uses circuit breakers to prevent nodes from running out of JVM heap memory. If Elasticsearch estimates an operation would exceed a circuit breaker, it stops the operation and returns an error." — [Elastic — Circuit breaker errors (Troubleshoot)](https://www.elastic.co/docs/troubleshoot/elasticsearch/circuit-breaker-errors)

Reference 문서의 요약도 같은 취지로 다음과 같이 서술합니다:

> "Elasticsearch contains multiple circuit breakers used to prevent operations from using an excessive amount of memory. Each breaker tracks the memory used by certain operations and specifies a limit for how much memory it may track." — [Elastic — Circuit breaker settings](https://www.elastic.co/guide/en/elasticsearch/reference/current/circuit-breaker.html)

### 5-1. Circuit Breaker 종류와 default 값 (ES 8.x 기준)

아래 값은 Elasticsearch 현재 reference 문서에서 직접 확인했습니다. ([Elastic — Circuit breaker settings](https://www.elastic.co/guide/en/elasticsearch/reference/current/circuit-breaker.html))

| Breaker | Default 한계 | 용도 |
|---|---|---|
| **Parent** | JVM heap의 **95%** (real memory 모드, default) / 70% (non-real memory) | 모든 하위 breaker의 상위 한계 |
| **Field data** | JVM heap의 **40%** | `text` 필드 sort/aggregation 등에서 fielddata 로드 시 |
| **Request** | JVM heap의 **60%** | 단일 요청 처리에 필요한 메모리(집계 중간 결과 등) |
| **In-flight requests** | JVM heap의 **100%** (overhead 2) | 전송 중/대기 중인 요청 |
| **EQL sequence** | JVM heap의 **50%** | EQL 시퀀스 쿼리 실행 중 메모리 |
| **Machine learning** | JVM heap의 **50%** | ML 작업 전용 |
| **Script compilation** | **150회 / 5분** (비율 아님) | 스크립트 컴파일 폭주 방지 |
| **Regex** | `script.painless.regex.limit-factor` 기반 | 정규식 복잡도 제한 |
| **Synonym** | parent breaker 한계를 따름 | synonym 분석 로드 시 |

> **주의**: 예전(7.x 초반) 문서에 있던 **"Accounting circuit breaker"** 는 **현재(8.x) 공식 breaker 목록에서 빠져 있습니다.** 7.x 시절 블로그/답변을 참고할 때 함께 따라오는 "accounting breaker = 100%" 라는 서술은 **현재 문서 기준으로는 공식 값이 아닙니다.** 본 문서는 최신 docs에 기재된 breaker만 공식 표로 싣습니다.

### 5-2. `indices.breaker.total.use_real_memory`

> "Determines whether the parent breaker should take real memory usage into account (`true`) or only consider the amount that is reserved by child circuit breakers (`false`). Defaults to `true`." — [Elastic — Circuit breaker settings](https://www.elastic.co/guide/en/elasticsearch/reference/current/circuit-breaker.html)

- `true` (default): JVM이 실제로 쓰고 있는 메모리(`HeapUsed`)를 기반으로 판단 → 더 현실적.
- `false`: 각 child breaker가 reserve한 값의 합만 보고 판단 → 실제 할당과 괴리.

현대적 ES 운영에서는 `true`가 default이며, 이걸 **real memory circuit breaker** 라고 부릅니다. Elastic 블로그: [Improving Node Resiliency with the Real Memory Circuit Breaker](https://www.elastic.co/blog/improving-node-resiliency-with-the-real-memory-circuit-breaker).

### 5-3. 발동 시 동작

한계를 넘을 것으로 추정되면:

- 해당 요청이 거절되고,
- `CircuitBreakingException`이 클라이언트에 반환됩니다.

이건 **node를 보호하기 위한 의도된 실패**입니다. 에러 메시지에 `circuit_breaking_exception` 이 뜨면 로그·쿼리·집계·샤드 크기 중 뭐가 heap을 과소비하는지 추적해야 합니다.

## 6. 전체 그림: ES 노드 한 대의 메모리 배분

![Elasticsearch 노드 한 대의 Host RAM 메모리 배분: JVM Heap, Off-heap, OS Page Cache](/uploads/theory/es-memory/host-ram-breakdown.svg)

## 7. 자주 혼동되는 포인트

- **"heap을 키우면 검색이 빨라진다"**: 틀렸습니다. 오히려 Page Cache가 좁아져서 느려지고, GC STW가 길어집니다.
- **"RAM 128GB면 heap도 64GB 주면 된다"**: 틀렸습니다. **30GB에서 끊습니다.** 나머지는 Page Cache로.
- **"fielddata는 off-heap이다"**: 기본적으로 **heap에 로드됩니다.** `text` 필드에 sort/aggs를 걸면 매우 위험한 이유입니다.
- **"mmapfs가 무조건 빠르다"**: 아닙니다. 파일 종류별 trade-off 때문에 ES default는 **hybridfs**입니다.

## 8. 1분 요약

> "Elasticsearch 노드의 메모리는 JVM Heap과 OS Page Cache로 양분해서 이해하고 있습니다. Heap은 인덱싱 버퍼, 쿼리 캐시, 집계 연산용으로 쓰이고 G1 GC의 대상이라 너무 크면 STW가 길어집니다. 또한 32GB를 넘으면 compressed oops 최적화가 꺼지기 때문에 실질적으로는 26~30GB가 상한입니다. 반면 Lucene 인덱스 파일은 hybridfs의 mmap을 통해 OS Page Cache에 올라가는데, 이 영역이 클수록 디스크 I/O 없이 검색이 가능하므로 '나머지 RAM 50%를 OS에 남겨야 한다'는 가이드가 나옵니다. 이 두 영역 사이의 예산 배분이 ES 튜닝의 핵심이고, 한 요청이 heap을 과점유하지 못하도록 field data · request · parent circuit breaker가 heap 기준 40/60/95%로 걸려 있습니다."

## 참고 문헌 (1차 소스)

### Elasticsearch 공식 reference

- [Elastic — Advanced configuration (JVM heap, 50% rule, compressed oops 임계치)](https://www.elastic.co/guide/en/elasticsearch/reference/current/advanced-configuration.html)
- [Elastic — Index store settings (hybridfs, mmapfs, niofs)](https://www.elastic.co/guide/en/elasticsearch/reference/current/index-modules-store.html)
- [Elastic — Circuit breaker settings](https://www.elastic.co/guide/en/elasticsearch/reference/current/circuit-breaker.html)
- [Elastic — Circuit breaker errors (troubleshooting)](https://www.elastic.co/docs/troubleshoot/elasticsearch/circuit-breaker-errors)
- [Elastic — High JVM memory pressure (troubleshooting)](https://www.elastic.co/docs/troubleshoot/elasticsearch/high-jvm-memory-pressure)
- [Elastic — Preloading data into the file system cache](https://www.elastic.co/guide/en/elasticsearch/reference/current/preload-data-to-file-system-cache.html)
- [Elastic — Virtual memory check (vm.max_map_count)](https://www.elastic.co/guide/en/elasticsearch/reference/current/vm-max-map-count.html)

### Elastic 엔지니어링 블로그

- [A Heap of Trouble: Managing Elasticsearch's Managed Heap (compressed oops 원리)](https://www.elastic.co/blog/a-heap-of-trouble)
- [Improving Node Resiliency with the Real Memory Circuit Breaker](https://www.elastic.co/blog/improving-node-resiliency-with-the-real-memory-circuit-breaker)
- [Elasticsearch heap size usage and JVM garbage collection (Elastic Labs)](https://www.elastic.co/search-labs/blog/elasticsearch-heap-size-jvm-garbage-collection)
- [Elasticsearch caching deep dive](https://www.elastic.co/blog/elasticsearch-caching-deep-dive-boosting-query-speed-one-cache-at-a-time)

### OpenJDK

- [OpenJDK HotSpot — CompressedOops](https://wiki.openjdk.org/display/HotSpot/CompressedOops)

---

**앞선 글**: [OS Page Cache가 ES 성능을 결정하는 이유](/blog/theory/es-memory-04-page-cache)

### 같이 읽으면 좋은 글

- [JVM Heap의 세대별 구조](/blog/theory/es-memory-01-jvm-heap): Young/Old Gen, Eden/Survivor 출발점
- [JVM의 GC 알고리즘과 Stop-the-World](/blog/theory/es-memory-02-gc): G1 / ZGC / Shenandoah 비교
- [JVM Off-heap과 Direct Memory](/blog/theory/es-memory-03-off-heap): Netty·Lucene이 Heap 밖에서 쓰는 메모리
- [OS Page Cache가 ES 성능을 결정하는 이유](/blog/theory/es-memory-04-page-cache): Linux 커널 관점
- [JVM과 Garbage Collection 이해하기](/blog/theory/jvm-and-gc): JVM 아키텍처 전반을 다루는 교과서식 정리

---
title: 'JVM 메모리 ④: OS Page Cache'
description: JVM 프로세스 바깥, OS 커널이 관리하는 Page Cache가 무엇이고 애플리케이션 성능에 어떤 영향을 주는지 Linux 커널 공식 문서 기반으로 정리했습니다. mmap, reclaim, OOM killer, 그리고 ES가 "Heap을 RAM 50% 이하로 두라"고 하는 진짜 이유까지.
date: 2026-04-13T00:00:00.000Z
tags:
  - Linux
  - Page Cache
  - mmap
  - Filesystem
  - Elasticsearch
  - Kernel
category: theory/JVM-Memory
draft: false
coverImage: "/uploads/theory/es-memory/cover-4.svg"
series: "JVM 메모리"
seriesOrder: 4
---

> 본 문서는 **docs.kernel.org Linux Kernel 공식 문서** 와 **man7.org의 Linux manual page** 를 1차 소스로 합니다. 1~3편이 JVM 프로세스 안에서 본 메모리라면, 이 글은 한 단계 아래인 **OS 커널 관점**에서 메모리를 봅니다.

## 1. 왜 이 이론을 알아야 하는가

Elasticsearch가 "힙을 50% 이하로 두라"고 하는 진짜 이유는 **"나머지를 OS Page Cache에 쓰라"** 는 것입니다. Elastic 공식 문서:

> "Elasticsearch ... relies on the operating system's filesystem cache for efficient access to files." — [Elastic — Advanced configuration](https://www.elastic.co/guide/en/elasticsearch/reference/current/advanced-configuration.html)

> "The heap size should be based on the available RAM ... The smaller that you can set the heap ... the more physical memory that will be available for the filesystem cache.", 같은 출처

즉 ES 성능의 핵심 중 하나가 **filesystem cache = Page Cache** 입니다. 이게 뭔지 OS 수준에서 정리합니다.

## 2. Page Cache란 무엇인가

Linux 커널 공식 정의:

> "The page cache is the primary way that the user and the rest of the kernel interact with filesystems. Whenever a file is read, the data is put into the page cache to avoid expensive disk access on the subsequent reads." — [Linux Kernel — Memory Management Concepts Overview](https://docs.kernel.org/admin-guide/mm/concepts.html)

> "The page cache is the primary way that the user and the rest of the kernel interact with filesystems ... normal reads, writes and mmaps go through the page cache." — [Linux Kernel — Page Cache](https://docs.kernel.org/mm/page_cache.html)

정리하면:

- **디스크에서 한 번 읽힌 파일 데이터는 커널이 자동으로 RAM에 보관**합니다.
- 같은 파일의 같은 부분을 다시 읽으면 디스크에 가지 않고 RAM에서 꺼냅니다.
- `read()`, `write()`, `mmap()` 이 **모두** Page Cache를 경유합니다 (O_DIRECT 예외).

## 3. 물리 메모리는 어떻게 사용되는가

Linux 커널은 물리 페이지를 크게 두 종류로 분류합니다.

### 3-1. File-backed pages

> 파일과 연결된 페이지 = Page Cache의 내용물.

### 3-2. Anonymous pages

> "The read accesses will result in creation of a page table entry that references a special physical page filled with zeroes. When the program performs a write, a regular physical page will be allocated to hold the written data." — [Linux Kernel — Concepts overview](https://docs.kernel.org/admin-guide/mm/concepts.html)

프로세스의 힙, 스택, malloc 영역 등 **파일에 매핑되지 않은** 메모리입니다. JVM의 Java Heap은 **anonymous pages** 로 올라옵니다.

### 3-3. Reclaim (재확보)

> "Pages that can be freed at any time, either because they cache the data available elsewhere like on a hard disk, or because they can be swapped out to the hard disk, are called reclaimable, and the most notable categories of the reclaimable pages are page cache and anonymous memory.", 같은 출처

핵심 포인트:

- **Page Cache는 언제든 회수 가능**합니다. 디스크에 원본이 있기 때문에 그냥 버리면 됩니다 (dirty page는 flush 후 버림).
- 메모리 부족 시 커널은 `kswapd`를 통해 **비동기로** 회수하고, 그래도 모자라면 요청 스레드를 멈추고 **동기(direct reclaim)** 으로 회수합니다.

## 4. mmap: JVM에서 Page Cache를 쓰는 통로

Elasticsearch/Lucene이 인덱스 파일을 Page Cache에 올리는 주요 수단이 **mmap** 입니다.

`mmap`은 파일을 **가상 메모리 주소 공간에 매핑**합니다. 핵심 성질:

- 파일 내용이 그대로 주소 공간에 "보이게" 되므로 `read()` 시스템 콜 없이 포인터로 접근 가능합니다.
- 실제 물리 메모리에 올라오는 시점은 **페이지 폴트 시** (lazy loading).
- 올라온 페이지는 **Page Cache 그 자체**. 즉 같은 파일을 여러 프로세스가 mmap 해도 **물리 RAM은 공유**됩니다.

### 4-1. madvise / readahead

> "`readahead()` initiates readahead on a file so that subsequent reads from that file will be satisfied from the cache, and not block on disk I/O ..." — [man7 — readahead(2)](https://man7.org/linux/man-pages/man2/readahead.2.html)

`readahead`, `posix_fadvise`, `madvise(MADV_WILLNEED)` 같은 힌트로 **커널에게 "이 파일을 곧 읽을 거니 미리 캐시에 올려둬"** 라고 알려줄 수 있습니다. 이게 Elasticsearch의 `index.store.preload` 옵션 동작의 내부 원리입니다.

### 4-2. Sequential vs Random

커널은 접근 패턴을 관찰해서 **순차 접근(sequential)** 이면 **readahead를 공격적으로** 해 줍니다. Lucene의 posting list scan 같은 순차 I/O가 Page Cache와 궁합이 좋은 이유입니다.

## 5. Page Cache 상태를 관찰하는 법

Linux에서 보통 다음 명령으로 확인합니다.

```bash
# free 명령의 "buff/cache" 컬럼이 Page Cache + 커널 버퍼
free -h

# /proc/meminfo
cat /proc/meminfo
#   MemTotal, MemFree, Cached, Buffers 등이 보여요
```

`Cached` 값이 Page Cache 점유량의 가장 직관적인 지표입니다.

> 주의: "Cached 값이 크면 메모리 부족" 이라는 오해는 틀렸습니다. **Page Cache는 필요 시 즉시 회수되므로, 큰 게 좋은 상태입니다.** ES 문서가 말하는 "filesystem cache가 크면 좋다"가 이 뜻입니다.

## 6. OS OOM Killer와의 관계

메모리가 진짜 부족해서 reclaim으로도 해결 안 되면 커널은 **OOM Killer** 를 발동합니다. JVM 프로세스는 보통 `-Xmx`만큼 가상주소를 예약하고, 쓰이는 만큼 **실제 RAM을 소비(RSS)** 합니다.

문제는:

- JVM이 Heap + Direct Memory + Stack 으로 RSS가 커지고,
- Page Cache를 reclaim해도 메모리가 모자라면,
- 커널은 **OOM Killer** 로 특정 프로세스를 선택해 죽입니다.

OOM Killer의 선택 기준은 `/proc/<pid>/oom_score` 값이고, 단순히 "가장 큰 프로세스"가 아니라 **RSS + 점유율 + oom_score_adj 가중치** 등을 종합해서 점수가 가장 높은 대상을 고릅니다. 하지만 실무에서는 대개 **가장 메모리를 많이 쓰는 JVM** 이 후보 1순위가 됩니다.

ES가 "Xmx 50% 이하" 를 강하게 권하는 이유 중 하나가 이 OOM Killer 회피입니다.

## 7. Elasticsearch 관점에서의 의미

1. **Lucene 인덱스는 hybridfs 전략에 따라 일부 파일(term dictionary, norms, doc values)이 mmap으로 올라가고, 나머지는 NIO로 읽습니다** (상세는 [Elasticsearch 노드의 메모리 배분 전략](/blog/theory/es-memory-05-elasticsearch) 참고). 어느 쪽이든 **OS가 Page Cache에 자동으로 캐싱**합니다. mmap은 "접근을 포인터 연산으로 만든다"는 성질이고, Page Cache에 올라가는 것 자체는 NIO read도 동일합니다.
2. Page Cache **히트율이 높을수록** ES 쿼리 latency가 낮아집니다. cold cache에서 첫 검색이 느린 현상이 여기서 나옵니다.
3. ES가 `index.store.preload` 같은 기능을 제공하는 이유가 **기동 직후 Page Cache를 미리 채워놓기 위함**입니다.
4. Heap을 RAM의 50%로 제한하는 이유는 **나머지 50%가 Page Cache를 위한 예산**이기 때문입니다. Heap을 과도하게 잡으면 Page Cache가 좁아지고, 그만큼 Lucene이 **디스크 I/O로 떨어집니다** → latency 폭증.

## 8. 자주 혼동되는 포인트

- "free 명령의 used가 크면 위험" → 틀렸습니다. **`available` 열을 봐야 합니다.** 최근(`procps-ng` 기반) `free`는 `used`, `buff/cache`, `available` 을 분리해서 보여주며, `available` 은 "필요하면 reclaim 가능한 양을 이미 고려한 실제 여유 메모리" 를 뜻합니다. used가 커도 available이 충분하면 정상입니다.
- "Page Cache는 JVM 메모리" → 아닙니다. **OS 커널이 관리**합니다. JVM은 그냥 페이지 폴트로 간접 접근할 뿐입니다.
- "mmap 하면 무조건 RAM에 올라간다" → 아닙니다. **접근하는 페이지만** lazy로 올라옵니다.

## 참고 문헌 (1차 소스)

- [Linux Kernel — Memory Management Concepts Overview](https://docs.kernel.org/admin-guide/mm/concepts.html)
- [Linux Kernel — Page Cache](https://docs.kernel.org/mm/page_cache.html)
- [man7 — readahead(2)](https://man7.org/linux/man-pages/man2/readahead.2.html)
- [kernel.org — Linux readahead: less tricks for more (OLS 2007 paper)](https://www.kernel.org/doc/ols/2007/ols2007v2-pages-273-284.pdf)
- [Elastic — Advanced configuration (filesystem cache 언급)](https://www.elastic.co/guide/en/elasticsearch/reference/current/advanced-configuration.html)
- [Elastic — Preloading data into the file system cache](https://www.elastic.co/guide/en/elasticsearch/reference/current/preload-data-to-file-system-cache.html)

---

**앞선 글**: [JVM Off-heap과 Direct Memory](/blog/theory/es-memory-03-off-heap)

**이어지는 글**: [Elasticsearch 노드의 메모리 배분 전략](/blog/theory/es-memory-05-elasticsearch)

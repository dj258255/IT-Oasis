---
title: '직접 재보기: 인덱스는 정말 빠른가, 내구성은 얼마나 비싼가'
titleEn: 'Measuring It: Is the Index Really Faster, and How Expensive Is Durability?'
description: "관계형 DB를 C로 밑바닥부터 만든 minidb를 말로 설명하는 대신 실제로 측정한다. 같은 한 행을 찾을 때 B+Tree 점 조회(O(log n))와 풀 스캔(O(n))의 지연을 테이블 크기 1천->1만->10만으로 키우며 재고(10만 행에서 416배), 커밋을 행마다 하느냐 묶느냐로 fsync 비용을 재서 WAL 내구성의 가격(23배)을 드러낸다. 측정 코드·환경·한계까지 정직하게."
descriptionEn: "Instead of explaining minidb in words, I measure it. Point lookup via B+Tree (O(log n)) vs full scan (O(n)) for the same single-row lookup, as the table grows 1k->10k->100k (416x at 100k rows), and the cost of WAL durability via fsync by committing per-row vs batched (23x). With the benchmark code, environment, and honest limitations."
date: 2026-06-12
tags:
  - C
  - Database Internals
  - Benchmark
  - B-Tree
  - WAL
  - Learning
category: project/minidb
coverImage: /uploads/project/minidb/cover.svg
draft: false
series: "minidb"
seriesOrder: 7
---

[3편](/blog/project/minidb/minidb-3-index-wal)에서 "인덱스는 O(n)을 O(log n)으로 줄인다", "WAL은 커밋마다 `fsync`로 내구성을 산다"고 썼다.
그런데 다시 읽어보니 전부 **말로만** 한 주장이었다.
진짜 그런지 minidb 자신을 재본 적이 없다.
그래서 벤치마크를 짰다.
설명하는 글에서 증명하는 글로 한 칸 옮기는 작업이다.

## 무엇을, 어떻게 쟀나

두 가지 질문만 잡았다.

1. **같은 한 행을 찾을 때, 인덱스 점 조회와 풀 스캔은 실제로 얼마나 차이 나나? 그리고 테이블이 커지면 그 차이는 어떻게 벌어지나?**
2. **WAL의 내구성은 얼마나 비싼가?** 즉 커밋마다 `fsync`하는 비용은 처리량을 얼마나 깎나.

방법은 단순하다.
`t(id INT, name TEXT)`에 `1..N`을 넣고(`id`가 PK라 자동 인덱싱), 같은 한 행을 두 가지 길로 찾는다.

- **인덱스 점 조회**: `SELECT * FROM t WHERE id = <랜덤>` — PK 조건이라 [3편의 플래너](/blog/project/minidb/minidb-3-index-wal)가 B+Tree 점 조회로 보낸다(`used_index=1`).
- **풀 스캔**: `SELECT * FROM t WHERE name = <랜덤>` — 같은 행을 가리키지만 비PK 조건이라 전 행을 훑는다(`used_index=0`).

둘 다 결과는 한 행으로 같고, 길만 다르다.
그래서 순수하게 "어떻게 찾느냐"의 비용만 비교된다.
측정은 `clock_gettime(CLOCK_MONOTONIC)`로 수천 번 반복해 평균 냈고, `SELECT` 출력은 `/dev/null`로 버려 인쇄 비용을 뺐다.
난수는 고정 시드 xorshift라 재현된다.
`make bench` 한 줄로 누구나 돌릴 수 있다([코드](https://github.com/dj258255/minidb)의 `tests/bench.c`).

**측정 환경** (수치는 환경 없이는 의미가 없으니 박아둔다): Apple M2 Pro, 32GB RAM, macOS 26.3.1(arm64), Apple clang 21, `-O2` 컴파일.
모든 데이터가 OS 페이지 캐시에 올라온 warm 상태의 in-process 단일 스레드 측정이다.

## [1] 인덱스 vs 풀 스캔 — 그리고 N이 커질 때

| 테이블 크기 N | 인덱스 점 조회 | 풀 스캔 | 배율 |
|---|---|---|---|
| 1,000 | 3.25 us | 34.21 us | 11배 |
| 10,000 | 5.05 us | 274.28 us | 54배 |
| 100,000 | 7.52 us | 3,126.74 us | 416배 |

숫자 하나하나보다 **두 열이 자라는 모양**이 핵심이다.

- **풀 스캔 열**: N이 10배 될 때마다 34 -> 274 -> 3,127로 거의 정확히 10배씩 뛴다. 이게 **O(n)** 이다. 행이 늘면 늘어난 만큼 더 훑는다. 정직하게 선형이다.
- **인덱스 열**: N이 100배(1천->10만) 되는 동안 3.25 -> 7.52로 **2.3배밖에** 안 늘었다. 이게 **O(log n)** 이다. 데이터가 100배가 돼도 트리 높이는 몇 단 더 깊어질 뿐이라, 조회 비용이 거의 안 움직인다.

그래서 배율이 11배 -> 54배 -> 416배로 벌어진다.
흥미로운 건 이 격차가 **N이 클수록 더 벌어진다**는 것이다.
작은 테이블(1천 행)에선 인덱스가 11배 빠른 정도라 "굳이?" 싶지만, 10만 행에서는 416배다.
인덱스의 가치는 데이터가 많아질수록 커진다 — 정확히 인덱스가 필요해지는 그 지점에서.
100만, 1000만 행이면 이 곡선은 더 극단으로 간다.
[WikiEngine](/blog/project/WikiEngine/lucene-decision)에서 1,215만 행에 인덱스 없는 검색이 5초 타임아웃 났던 게 바로 이 O(n) 열의 맨 끝이었다.

> 더 깊이: 실제 옵티마이저가 "언제 인덱스를 타고 언제 풀 스캔이 오히려 빠른지"를 비용으로 고르는 이야기는 [DB 인덱스 ②: 스캔의 종류와 옵티마이저의 선택](/blog/theory/db-index-02-scan-types). (그렇다. 행을 거의 다 읽을 거면 풀 스캔이 더 빠를 때도 있다.)

## [2] 내구성의 가격 — fsync는 공짜가 아니다

[3편](/blog/project/minidb/minidb-3-index-wal)·[4편](/blog/project/minidb/minidb-4-transactions)에서 커밋은 WAL에 로그를 적고 `fsync`로 디스크에 강제하는 순간 "내구"해진다고 했다.
그 `fsync`가 실제로 얼마인지, 5천 행을 두 가지로 적재해 봤다.

| 적재 방식 | 시간 | 처리량 | fsync 횟수 |
|---|---|---|---|
| 행마다 커밋 | 1.483 s | 3,372 rows/s | 5,000회 |
| 50행씩 묶어 커밋 | 0.063 s | 79,039 rows/s | 약 100회 |

**같은 5천 행인데 묶음이 23배 빠르다.** 한 일은 똑같다 — 5천 행을 인코딩해 힙과 인덱스에 넣는 것.
유일한 차이는 `fsync`를 5,000번 하느냐 100번 하느냐다.
즉 이 23배 격차의 대부분이 **순수한 `fsync` 비용**이다.
디스크에 "정말 내려갔는지" 확인받는 그 한 번이, CPU가 하는 실제 일보다 압도적으로 비싸다.

이게 왜 중요하냐면 — 내구성(D)은 공짜 속성이 아니라 **명시적으로 지불하는 비용**이라는 뜻이기 때문이다.
그리고 진짜 DB가 가진 기능 절반이 이 비용을 깎는 장치다.
여러 트랜잭션의 `fsync`를 한 번에 모는 **group commit**, 커밋 시 `fsync`를 매번 할지 1초에 한 번 할지 고르는 MySQL `innodb_flush_log_at_trx_commit`이나 PostgreSQL `synchronous_commit` 같은 손잡이가 전부 "내구성 granularity를 처리량과 맞바꾸는" 다이얼이다.
minidb의 "행당 vs 묶음"은 그 다이얼의 가장 거친 두 칸인 셈이다.
위 표가 곧 그 다이얼을 돌렸을 때 처리량이 23배 움직이는 모습이다.

## 정직한 한계

수치는 정직할 때만 쓸모 있으니, 이 벤치마크가 **말하지 않는 것**도 적어둔다.

- **macOS의 `fsync`는 진짜 디스크까지 안 내려간다.** macOS에서 일반 `fsync()`는 드라이브 캐시까지만 밀고, 정전에도 살아남는 platter 강제는 `F_FULLFSYNC`라는 별도 호출이 필요하다. minidb는 평범한 `fsync`를 쓰므로, 위 "행당 커밋 3,372 rows/s"는 사실 **낙관적인 하한**이다. 진짜 내구성을 보장하는 환경(`F_FULLFSYNC`나 배터리 없는 리눅스 서버)이라면 행당 커밋은 훨씬 더 느려지고, 묶음의 우위는 23배보다 더 벌어진다.
- **규모가 작다.** 10만 행은 수 MB라 통째로 메모리/페이지 캐시에 든다. 실제 디스크 I/O가 병목이 되는 수십 GB 영역은 안 건드렸다. 여기 숫자는 "구조의 모양(O 표기)"을 보여주는 마이크로 측정이지, 프로덕션 처리량이 아니다.
- **내 B+Tree 노드는 일부러 작다.** [3편](/blog/project/minidb/minidb-3-index-wal)에서 노드당 키 8개로 잡아 분할이 자주 보이게 했다. 진짜 DB는 노드당 수백 개라 같은 행 수에 트리가 훨씬 얕다. 그래서 위 인덱스 절대 지연은 비관적인 편이지만, **O(log n)이라는 모양 자체는 노드 크기와 무관**하게 유지된다 — 표의 인덱스 열이 거의 안 자라는 게 그 증거다.
- 풀 스캔 측정엔 쿼리마다 SQL 파싱 비용이 끼어 있다(작고 상수라 O(n) 결론은 안 바뀐다). 단일 스레드, 동시성 없음.

## 닫으며

3편에서 말로 적은 두 주장 — "인덱스는 O(log n)", "내구성은 `fsync` 값을 치른다" — 을 이제 숫자로 봤다.
인덱스 열이 N=100배에도 2.3배밖에 안 자라는 걸 직접 보니, "정렬 구조라 빠르다"가 추상이 아니라 측정 가능한 사실로 손에 잡혔다.
그리고 `fsync` 하나가 23배를 가른다는 걸 보고 나니, 진짜 DB들이 왜 커밋 정책에 그렇게 많은 손잡이를 두는지가 비로소 납득됐다.

만들면서 "왜 이렇게 하는지"를 이해했다면, 재보면서는 "정말 그런지"를 확인한다.
다음에 새 기능을 넣을 때도 — 말로 끝내지 말고 `make bench`에 한 줄 더 보태 재볼 생각이다.

> **시리즈**: [1. 저장 계층](/blog/project/minidb/minidb-1-storage) · [2. SQL 엔진](/blog/project/minidb/minidb-2-sql-engine) · [3. 인덱스와 WAL](/blog/project/minidb/minidb-3-index-wal) · [4. 트랜잭션](/blog/project/minidb/minidb-4-transactions) · [5. 조인과 집계](/blog/project/minidb/minidb-5-join-aggregate) · [6. BETWEEN과 LIKE](/blog/project/minidb/minidb-6-between-like) · 7. 직접 재보기 · [코드(GitHub)](https://github.com/dj258255/minidb)

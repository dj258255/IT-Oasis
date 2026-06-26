---
title: '직접 재보기 — 인덱스는 정말 빠른가, 내구성은 얼마나 비싼가'
titleEn: 'Measuring It — Is the Index Really Faster, and How Expensive Is Durability?'
description: "관계형 DB를 C로 밑바닥부터 만든 minidb 시리즈 7편. 앞 편들에서 말로만 주장했던 두 가지 — '인덱스는 O(n)을 O(log n)으로 줄인다', 'WAL은 커밋마다 fsync로 내구성을 산다' — 를 직접 측정해 확인합니다. B+Tree 점 조회(O(log n))와 풀 스캔(O(n))의 지연을 테이블 크기 1천->1만->10만으로 키우며 재고(10만 행에서 416배), 커밋을 행마다 하느냐 묶느냐로 fsync 비용을 재서 내구성의 가격(23배)을 드러냅니다. 측정 코드·환경·정직한 한계까지."
descriptionEn: "Part 7 of minidb, a relational database built from scratch in C. I measure the two claims earlier parts only asserted in words — 'an index turns O(n) into O(log n)' and 'WAL buys durability with an fsync per commit'. Point lookup via B+Tree (O(log n)) vs full scan (O(n)) for the same single-row lookup as the table grows 1k->10k->100k (416x at 100k rows), and the cost of durability via fsync by committing per-row vs batched (23x). With the benchmark code, environment, and honest limitations."
date: 2026-05-31
tags:
  - C
  - Database Internals
  - Benchmark
  - B-Tree
  - WAL
  - Performance
  - Learning
category: project/minidb
coverImage: /uploads/project/minidb/cover.svg
draft: false
series: "minidb"
seriesOrder: 7
---

## 0. 들어가며 — 말로 한 주장을 숫자로 옮기기

[3편](/blog/project/minidb/minidb-3-index-wal)에서 "인덱스는 O(n)을 O(log n)으로 줄인다", "WAL은 커밋마다 `fsync`로 내구성을 산다"고 썼어요. 그런데 시리즈를 다시 읽어 보니 그게 전부 **말로만** 한 주장이더라고요. 정작 minidb 자신을 한 번도 재본 적이 없었습니다.

그래서 벤치마크를 짰어요. 이번 편은 minidb를 새로 만드는 게 아니라, **앞에서 "이래서 빠르다/비싸다"고 설명한 것이 정말 그런지 측정으로 확인**하는 작업입니다. 설명하는 글에서 증명하는 글로 한 칸 옮기는 거죠.

> **왜 굳이 재보나**: "정렬 구조라 빠르다", "fsync는 비싸다" 같은 말은 안 틀리지만, 안 틀린다는 게 손에 잡힌다는 뜻은 아니에요. 11배인지 400배인지, 2배인지 20배인지는 재봐야 압니다. 그리고 그 **자릿수**가 곧 진짜 DB가 왜 그렇게 설계됐는지를 설명해 줍니다.

질문은 딱 두 개로 잡았습니다.

1. **같은 한 행을 찾을 때, 인덱스 점 조회와 풀 스캔은 실제로 얼마나 차이 나나? 그리고 테이블이 커지면 그 차이는 어떻게 벌어지나?** (1절)
2. **WAL의 내구성은 얼마나 비싼가?** 즉 커밋마다 `fsync`하는 비용이 처리량을 얼마나 깎나. (2절)

## 1. 측정 방법 — 같은 행, 다른 두 길

방법은 단순해요. `t(id INT, name TEXT)`에 `1..N`을 넣고(`id`가 PK라 [3편](/blog/project/minidb/minidb-3-index-wal)에서 만든 B+Tree로 자동 인덱싱됨), **똑같은 한 행을 두 가지 길로** 찾습니다.

| 길 | 쿼리 | 플래너 판정 | 비용 모양 |
|---|---|---|---|
| **인덱스 점 조회** | `SELECT * FROM t WHERE id = <랜덤>` | PK 조건 -> B+Tree (`used_index=1`) | O(log n) |
| **풀 스캔** | `SELECT * FROM t WHERE name = <랜덤>` | 비PK 조건 -> 전 행 훑음 (`used_index=0`) | O(n) |

둘 다 결과는 한 행으로 같고, **길만 다릅니다**. 그래서 순수하게 "어떻게 찾느냐"의 비용만 비교돼요. PK 조건이냐 아니냐로 [3편의 플래너](/blog/project/minidb/minidb-3-index-wal)가 길을 갈라주는 걸 그대로 이용한 겁니다.

> **방법론**: 측정은 `clock_gettime(CLOCK_MONOTONIC)`로, 인덱스 점 조회는 5,000회·풀 스캔은 N에 따라 300~3,000회 반복한 **평균**입니다(중앙값·표준편차는 따로 안 냈고, 적재 직후 warm 상태라 별도 워밍업 루프는 두지 않았어요 — 블로그용 마이크로 측정 수준의 단순함입니다). cold cache는 OS 페이지 캐시·저장장치 상태에 크게 휘둘려 재현성이 낮아서, 엔진 자체의 자료구조 비용만 보려고 warm만 비교했습니다. `SELECT` 출력은 `/dev/null`로 버려 인쇄 비용을 뺐고(엔진 시간만 잰다), 난수는 고정 시드 xorshift64라 매번 같은 행을 같은 순서로 찾아 재현됩니다. `make bench` 한 줄이면 누구나 똑같이 돌려볼 수 있어요([코드](https://github.com/dj258255/db-hobby)의 `tests/bench.c`).

측정 루프의 핵심은 이렇게 생겼어요 — 두 길 모두 같은 범위에서 랜덤 키를 뽑고, 차이는 `WHERE` 절뿐입니다.

```c
/* 인덱스 점 조회: WHERE id = <랜덤 PK> */
for (int k = 0; k < iter_idx; k++) {
    int id = 1 + (int)(xorshift() % (unsigned long)n);
    snprintf(sql, sizeof sql, "SELECT * FROM t WHERE id = %d", id);
    ex(&db, sql);
}
double idx_us = (now_sec() - t0) / iter_idx * 1e6;

/* 풀 스캔: WHERE name = 'u<랜덤>' (비PK라 전 행 훑음) */
for (int k = 0; k < iter_scan; k++) {
    int id = 1 + (int)(xorshift() % (unsigned long)n);
    snprintf(sql, sizeof sql, "SELECT * FROM t WHERE name = 'u%d'", id);
    ex(&db, sql);
}
double scan_us = (now_sec() - t0) / iter_scan * 1e6;
```

수치는 환경 없이는 의미가 없으니 박아둡니다.

| 항목 | 값 |
|---|---|
| CPU | Apple M2 Pro |
| RAM | 32GB |
| OS | macOS 26.3.1 (arm64) |
| 컴파일러 | Apple clang 21, `-O2` |
| 상태 | 모든 데이터가 OS 페이지 캐시에 올라온 warm, in-process 단일 스레드 |

## 2. 인덱스 vs 풀 스캔 — 그리고 N이 커질 때

먼저 첫 질문이에요. 같은 한 행을 두 길로 찾으면 얼마나 차이 나고, 테이블이 커지면 그 차이는 어떻게 벌어질까요. 테이블 크기 N을 1천 -> 1만 -> 10만으로 키우며 쟀습니다.

| 테이블 크기 N | 인덱스 점 조회 | 풀 스캔 | 배율 |
|---|---|---|---|
| 1,000 | 3.25 us | 34.21 us | 11배 |
| 10,000 | 5.05 us | 274.28 us | 54배 |
| 100,000 | 7.52 us | 3,126.74 us | 416배 |

숫자 하나하나보다 **두 열이 자라는 모양**이 핵심이에요(실행 시간엔 캐시·파싱·할당 비용도 섞여 있어 순수 복잡도 그 자체는 아니지만, 증가 *양상* 은 복잡도 모양을 그대로 드러냅니다).

- **풀 스캔 열**: N이 10배 될 때마다 34 -> 274 -> 3,127로 거의 정확히 10배씩 뜁니다. 이 선형 증가가 곧 **O(n)** 의 모양이에요. 행이 늘면 늘어난 만큼 더 훑으니까요.
- **인덱스 열**: N이 100배(1천->10만) 되는 동안 3.25 -> 7.52로 **2.3배밖에** 안 늘었어요. 이 거의-평평한 증가가 **O(log n)** 의 로그 곡선에 들어맞습니다. 데이터가 100배가 돼도 트리 높이는 몇 단 더 깊어질 뿐이라, 조회 비용이 거의 안 움직여요.

그래서 배율이 11배 -> 54배 -> 416배로 벌어집니다. O(log n)과 O(n)을 나란히 표로 보면 모양 차이가 또렷해요.

| N 증가 | 인덱스 O(log n) | 풀 스캔 O(n) |
|---|---|---|
| 1천 -> 1만 (x10) | x1.6 | x8.0 |
| 1만 -> 10만 (x10) | x1.5 | x11.4 |
| 1천 -> 10만 (x100) | x2.3 | x91 |

> **실무/면접 포인트**: 흥미로운 건 이 격차가 **N이 클수록 더 벌어진다**는 거예요. 작은 테이블(1천 행)에선 인덱스가 11배 빠른 정도라 "굳이?" 싶지만, 10만 행에선 (이 환경·이 데이터에선) 416배까지 벌어졌습니다. 인덱스의 가치는 데이터가 많아질수록 커집니다 — 정확히 인덱스가 필요해지는 그 지점에서요. 100만, 1000만 행이면 이 곡선은 더 극단으로 갑니다. [WikiEngine](/blog/project/WikiEngine/lucene-decision)에서 1,215만 행에 인덱스 없는 검색이 5초 타임아웃 났던 게 바로 이 O(n) 열의 맨 끝이었어요.

> 더 깊이: 실제 옵티마이저가 "언제 인덱스를 타고 언제 풀 스캔이 오히려 빠른지"를 비용으로 고르는 이야기는 [DB 인덱스 ②: 스캔의 종류와 옵티마이저의 선택](/blog/theory/db-index-02-scan-types). (그렇습니다. 행을 거의 다 읽을 거면 풀 스캔이 더 빠를 때도 있어요.)

## 3. 내구성의 가격 — fsync는 공짜가 아니다

두 번째 질문으로 갑니다. [3편](/blog/project/minidb/minidb-3-index-wal)·[4편](/blog/project/minidb/minidb-4-transactions)에서 커밋은 WAL에 로그를 적고 `fsync`로 디스크에 강제하는 순간 "내구"해진다고 했어요. 그 `fsync`가 실제로 얼마인지, 5천 행을 두 가지 방식으로 적재해 봤습니다.

- **행마다 커밋**: `BEGIN`/`COMMIT` 없이 문장별 autocommit이라 행마다 `fsync`가 한 번씩 일어납니다(5,000회).
- **50행씩 묶어 커밋**: `BEGIN ... 50개 INSERT ... COMMIT`이라 `fsync`가 묶음당 한 번뿐이에요(약 100회).

| 적재 방식 | 시간 | 처리량 | fsync 횟수 |
|---|---|---|---|
| 행마다 커밋 | 1.483 s | 3,372 rows/s | 5,000회 |
| 50행씩 묶어 커밋 | 0.063 s | 79,039 rows/s | 약 100회 |

**같은 5천 행인데 묶음이 23배 빠릅니다.** 한 일은 똑같아요 — 5천 행을 인코딩해 힙과 인덱스에 넣는 것. 유일한 차이는 `fsync`를 5,000번 하느냐 100번 하느냐예요. 즉 이 23배 격차의 대부분이 **`fsync`와 커밋 동기화 비용**입니다(트랜잭션 begin/end·로그 버퍼 같은 부수 비용도 섞여 있지만, 대부분은 fsync예요). 디스크에 "정말 내려갔는지" 확인받는 그 한 번이, CPU가 하는 실제 일보다 압도적으로 비싸요.

> **방법론**: 묶음 쪽은 `i % 50 == 1`에서 `BEGIN`, `i % 50 == 0`에서 `COMMIT`을 거는 식으로 50행마다 한 트랜잭션을 끊었습니다(50을 고른 건 minidb 스테이징 한계 64 안쪽이라). 행당 쪽은 트랜잭션을 전혀 열지 않아 문장 하나하나가 곧 한 트랜잭션 = 한 fsync가 되고요. 두 경로 모두 같은 `load`/`INSERT` 코드를 타므로, 인코딩·힙 삽입·인덱스 갱신 비용은 양쪽이 동일합니다.

이게 왜 중요하냐면 — 내구성(ACID의 D)은 공짜 속성이 아니라 **명시적으로 지불하는 비용**이라는 뜻이기 때문이에요. 그리고 진짜 DB가 가진 기능의 절반이 이 비용을 깎는 장치입니다.

| 다이얼 | 무엇을 하나 | minidb 대응 |
|---|---|---|
| **group commit** | 여러 트랜잭션의 `fsync`를 한 번에 몰아서 | "50행 묶음"이 거친 수동 버전 |
| MySQL `innodb_flush_log_at_trx_commit` | 커밋마다 fsync할지 1초에 한 번 할지 | "행당 vs 묶음"의 두 칸 |
| PostgreSQL `synchronous_commit` | 커밋이 fsync를 기다릴지 말지 | 〃 |

전부 "내구성 granularity를 처리량과 맞바꾸는" 다이얼이에요. minidb의 "행당 vs 묶음"은 그 다이얼의 가장 거친 두 칸인 셈이고, 위 표가 곧 그 다이얼을 돌렸을 때 처리량이 23배 움직이는 모습입니다.

## 4. 정직한 한계

수치는 정직할 때만 쓸모 있으니, 이 벤치마크가 **말하지 않는 것**도 적어둡니다.

> **정직한 한계 — macOS의 `fsync`는 진짜 디스크까지 안 내려간다.** macOS에서 일반 `fsync()`는 드라이브 캐시까지만 밀고, 정전에도 살아남는 platter 강제는 `F_FULLFSYNC`라는 별도 호출이 필요해요. minidb는 평범한 `fsync`를 쓰므로, 위 "행당 커밋 3,372 rows/s"는 사실 **낙관적인 하한**입니다. 진짜 내구성을 보장하는 환경(`F_FULLFSYNC`나 배터리 없는 리눅스 서버)이라면 행당 커밋은 훨씬 더 느려지고, 묶음의 우위는 23배보다 더 벌어집니다.

나머지 한계도 짚어둘게요.

- **규모가 작다.** 10만 행은 수 MB라 통째로 메모리/페이지 캐시에 듭니다. 실제 디스크 I/O가 병목이 되는 수십 GB 영역은 안 건드렸어요. 여기 숫자는 "구조의 모양(O 표기)"을 보여주는 마이크로 측정이지, 프로덕션 처리량이 아닙니다.
- **내 B+Tree 노드는 일부러 작다.** [3편](/blog/project/minidb/minidb-3-index-wal)에서 노드당 키 8개로 잡아 분할이 자주 보이게 했어요. 진짜 DB는 노드당 수백 개라 같은 행 수에 트리가 훨씬 얕습니다. 그래서 위 인덱스 절대 지연은 비관적인 편이지만, **O(log n)이라는 모양 자체는 노드 크기와 무관**하게 유지돼요 — 표의 인덱스 열이 거의 안 자라는 게 그 증거입니다.
- 풀 스캔 측정엔 쿼리마다 SQL 파싱 비용이 끼어 있습니다(작고 상수라 O(n) 결론은 안 바뀝니다). 단일 스레드, 동시성 없음.

## 5. 정리

3편에서 말로 적은 두 주장 — "인덱스는 O(log n)", "내구성은 `fsync` 값을 치른다" — 을 이제 숫자로 봤습니다.

- **인덱스 vs 풀 스캔**: 같은 한 행을 찾을 때 인덱스 열은 N=100배에도 2.3배밖에 안 자라고(O(log n)), 풀 스캔 열은 10배마다 10배씩 자랍니다(O(n)). 그래서 배율이 11배 -> 54배 -> 416배로 벌어져요. "정렬 구조라 빠르다"는 설명이, 이번 측정에선 실제 실행 시간의 증가 양상으로도 확인됐습니다.
- **내구성의 가격**: `fsync` 하나가 행당 vs 묶음을 23배로 가릅니다. 진짜 DB들이 왜 커밋 정책(group commit, `synchronous_commit` 등)에 그렇게 많은 손잡이를 두는지가 비로소 납득됐어요.
- **정직하게**: macOS의 `fsync`는 `F_FULLFSYNC`가 아니라 위 처리량은 낙관적 하한이고, 규모도 작은 마이크로 측정입니다.

만들면서 "왜 이렇게 하는지"를 이해했다면, 재보면서는 "정말 그런지"를 확인합니다. 다음에 새 기능을 넣을 때도 — 말로 끝내지 말고 `make bench`에 한 줄 더 보태 재볼 생각이에요.

## 참고

- [PostgreSQL Documentation: synchronous_commit](https://www.postgresql.org/docs/current/runtime-config-wal.html)
- [MySQL Documentation: innodb_flush_log_at_trx_commit](https://dev.mysql.com/doc/refman/8.0/en/innodb-parameters.html#sysvar_innodb_flush_log_at_trx_commit)
- [Apple Developer Documentation: fcntl(2) — F_FULLFSYNC](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/fcntl.2.html)
- 본 블로그: [DB 인덱스 ②: 스캔의 종류와 옵티마이저의 선택](/blog/theory/db-index-02-scan-types)
- [minidb 코드 (GitHub)](https://github.com/dj258255/db-hobby) — `tests/bench.c`, `make bench`

<!-- EN -->

## 0. Introduction — Moving a Claim from Words to Numbers

In [Part 3](/blog/project/minidb/minidb-3-index-wal) I wrote "an index turns O(n) into O(log n)" and "WAL buys durability with an `fsync` per commit". But rereading the series, those were all claims made **in words only**. I had never once measured minidb itself.

So I wrote a benchmark. This part is not about building something new in minidb, but about **checking, by measurement, whether what I explained earlier ("this is why it is fast / expensive") is actually true**. It is moving one step from explaining to proving.

> **Why bother measuring**: "it is fast because it is a sorted structure" and "fsync is expensive" are not wrong, but not-wrong is not the same as tangible. Whether it is 11x or 400x, 2x or 20x — you only know by measuring. And that **order of magnitude** is exactly what explains why real DBs are designed the way they are.

I picked just two questions.

1. **When finding the same single row, how much do an index point lookup and a full scan actually differ? And as the table grows, how does that gap widen?** (Section 1)
2. **How expensive is WAL durability?** That is, how much does an `fsync` per commit cut throughput? (Section 2)

## 1. The Method — Same Row, Two Different Paths

The method is simple. Insert `1..N` into `t(id INT, name TEXT)` (`id` is the PK, so it is auto-indexed by the B+Tree built in [Part 3](/blog/project/minidb/minidb-3-index-wal)), then find **the same single row by two paths**.

| Path | Query | Planner verdict | Cost shape |
|---|---|---|---|
| **Index point lookup** | `SELECT * FROM t WHERE id = <random>` | PK condition -> B+Tree (`used_index=1`) | O(log n) |
| **Full scan** | `SELECT * FROM t WHERE name = <random>` | non-PK condition -> scans all rows (`used_index=0`) | O(n) |

Both return the same single row; only the **path differs**. So we compare purely the cost of "how you find it". It directly exploits how [Part 3's planner](/blog/project/minidb/minidb-3-index-wal) splits the path by whether the condition is on the PK.

> **Methodology**: timing uses `clock_gettime(CLOCK_MONOTONIC)`, the **mean** of 5,000 iterations for the index point lookup and 300-3,000 for the full scan depending on N (no median/stddev, and no separate warmup loop since it measures warm right after loading — micro-measurement simple, blog-grade). cold cache is heavily swayed by the OS page cache and storage state and reproduces poorly, so to see the engine's own data-structure cost I compared warm only. `SELECT` output is dumped to `/dev/null` to remove print cost (engine time only), and the randomness is a fixed-seed xorshift64, so it finds the same rows in the same order every run — reproducible. One `make bench` lets anyone run the exact same thing ([`tests/bench.c`](https://github.com/dj258255/db-hobby) in the code).

The core of the measurement loop looks like this — both paths draw a random key from the same range; the only difference is the `WHERE` clause.

```c
/* Index point lookup: WHERE id = <random PK> */
for (int k = 0; k < iter_idx; k++) {
    int id = 1 + (int)(xorshift() % (unsigned long)n);
    snprintf(sql, sizeof sql, "SELECT * FROM t WHERE id = %d", id);
    ex(&db, sql);
}
double idx_us = (now_sec() - t0) / iter_idx * 1e6;

/* Full scan: WHERE name = 'u<random>' (non-PK -> scans all rows) */
for (int k = 0; k < iter_scan; k++) {
    int id = 1 + (int)(xorshift() % (unsigned long)n);
    snprintf(sql, sizeof sql, "SELECT * FROM t WHERE name = 'u%d'", id);
    ex(&db, sql);
}
double scan_us = (now_sec() - t0) / iter_scan * 1e6;
```

Numbers are meaningless without the environment, so I pin it down.

| Item | Value |
|---|---|
| CPU | Apple M2 Pro |
| RAM | 32GB |
| OS | macOS 26.3.1 (arm64) |
| Compiler | Apple clang 21, `-O2` |
| State | warm (all data in OS page cache), in-process, single-threaded |

## 2. Index vs Full Scan — and When N Grows

First question. Finding the same single row by two paths — how much do they differ, and how does the gap widen as the table grows? I measured with N at 1k -> 10k -> 100k.

| Table size N | Index point lookup | Full scan | Ratio |
|---|---|---|---|
| 1,000 | 3.25 us | 34.21 us | 11x |
| 10,000 | 5.05 us | 274.28 us | 54x |
| 100,000 | 7.52 us | 3,126.74 us | 416x |

More than any single number, the **shape of how the two columns grow** is the point (run time also mixes in cache, parse, and allocation cost, so it is not pure complexity itself — but the *growth pattern* still reflects the complexity shape).

- **Full scan column**: every time N goes 10x, it jumps 34 -> 274 -> 3,127, almost exactly 10x each. This linear growth is the shape of **O(n)**. More rows, more to scan, proportionally.
- **Index column**: while N goes 100x (1k->100k), it grows 3.25 -> 7.52, only **2.3x**. This nearly-flat growth fits the logarithmic curve of **O(log n)**. Even at 100x the data, the tree height only gets a few levels deeper, so lookup cost barely moves.

That is why the ratio widens 11x -> 54x -> 416x. Laying O(log n) and O(n) side by side as a table makes the shape difference sharp.

| N increase | Index O(log n) | Full scan O(n) |
|---|---|---|
| 1k -> 10k (x10) | x1.6 | x8.0 |
| 10k -> 100k (x10) | x1.5 | x11.4 |
| 1k -> 100k (x100) | x2.3 | x91 |

> **Practical/interview note**: the interesting part is that the gap **widens the larger N gets**. On a small table (1k rows) the index is only ~11x faster, so you might think "really, why bother?" — but at 100k rows it widened to 416x (in this environment, on this data). An index's value grows as the data grows — at exactly the point you start needing one. At 1M, 10M rows this curve goes more extreme. In [WikiEngine](/blog/project/WikiEngine/lucene-decision), an unindexed search over 12.15M rows timing out at 5 seconds was the far end of this very O(n) column.

> Deeper: how a real optimizer picks "when to take the index and when a full scan is actually faster" by cost is in [DB Index ②: Scan Types and the Optimizer's Choice](/blog/theory/db-index-02-scan-types). (Yes. If you are going to read almost all the rows, a full scan is sometimes faster.)

## 3. The Price of Durability — fsync Is Not Free

On to the second question. In [Part 3](/blog/project/minidb/minidb-3-index-wal) and [Part 4](/blog/project/minidb/minidb-4-transactions) I said a commit becomes "durable" the moment it writes a log to the WAL and forces it to disk with `fsync`. To see what that `fsync` actually costs, I loaded 5,000 rows two ways.

- **Commit per row**: no `BEGIN`/`COMMIT`, so each statement autocommits and there is one `fsync` per row (5,000 times).
- **Commit per 50 rows**: `BEGIN ... 50 INSERTs ... COMMIT`, so there is only one `fsync` per batch (~100 times).

| Load method | Time | Throughput | fsync count |
|---|---|---|---|
| Commit per row | 1.483 s | 3,372 rows/s | 5,000 |
| Commit per 50 rows | 0.063 s | 79,039 rows/s | ~100 |

**Same 5,000 rows, yet the batch is 23x faster.** The work is identical — encode 5,000 rows and put them into the heap and the index. The only difference is doing `fsync` 5,000 times vs 100. So most of this 23x gap is **`fsync` plus commit-synchronization cost** (some incidental cost like transaction begin/end and log buffering is mixed in too, but it is mostly fsync). That one confirmation that it "really hit the disk" is overwhelmingly more expensive than the actual work the CPU does.

> **Methodology**: the batch side cuts one transaction every 50 rows — `BEGIN` at `i % 50 == 1`, `COMMIT` at `i % 50 == 0` (50 chosen because it is within minidb's staging limit of 64). The per-row side opens no transaction at all, so each statement is its own transaction = one fsync. Both paths run the same `load`/`INSERT` code, so encoding, heap insert, and index update cost are identical on both sides.

Why does this matter? Because durability (the D in ACID) is not a free property but a cost you **pay explicitly**. And half of what a real DB does is machinery to shave that cost down.

| Dial | What it does | minidb equivalent |
|---|---|---|
| **group commit** | herds many transactions' `fsync` into one | the manual, coarse "50-row batch" |
| MySQL `innodb_flush_log_at_trx_commit` | fsync per commit vs once a second | the two notches of "per-row vs batch" |
| PostgreSQL `synchronous_commit` | whether a commit waits for fsync | same |

They are all dials that "trade durability granularity for throughput". minidb's "per-row vs batch" is the two coarsest notches of that dial, and the table above is what happens to throughput — 23x — when you turn it.

## 4. Honest Limitations

Numbers are only useful when honest, so I note what this benchmark **does not** say.

> **Honest limitation — macOS's `fsync` does not go all the way to disk.** On macOS a plain `fsync()` only pushes to the drive cache; forcing the platter (surviving a power loss) needs a separate call, `F_FULLFSYNC`. minidb uses plain `fsync`, so the "commit-per-row 3,372 rows/s" above is actually an **optimistic lower bound**. In an environment that truly guarantees durability (`F_FULLFSYNC`, or a battery-less Linux server), commit-per-row gets much slower, and the batch's edge widens beyond 23x.

The rest of the limitations too.

- **The scale is small.** 100k rows is a few MB, so it all fits in memory / page cache. I did not touch the tens-of-GB region where real disk I/O becomes the bottleneck. These numbers are a micro-measurement showing "the shape of the structure (the O notation)", not production throughput.
- **My B+Tree node is deliberately small.** In [Part 3](/blog/project/minidb/minidb-3-index-wal) I set 8 keys per node so splits show up often. Real DBs put hundreds per node, so the tree is far shallower at the same row count. So the absolute index latencies above are on the pessimistic side, but **the O(log n) shape itself holds regardless of node size** — the barely-growing index column in the table is the proof.
- The full scan measurement includes SQL parse cost per query (small and constant, so the O(n) conclusion does not change). Single-threaded, no concurrency.

## 5. Wrap-up

The two claims I wrote in words in Part 3 — "an index is O(log n)" and "durability pays the `fsync` price" — we have now seen as numbers.

- **Index vs full scan**: finding the same single row, the index column grows only 2.3x at N=100x (O(log n)), while the full scan column grows 10x per 10x (O(n)). That is why the ratio widens 11x -> 54x -> 416x. The explanation "it is fast because it is a sorted structure" was, in this measurement, also confirmed by the growth pattern of actual run time.
- **The price of durability**: one `fsync` splits per-row vs batch by 23x. It finally clicked why real DBs put so many knobs on commit policy (group commit, `synchronous_commit`, and so on).
- **Honestly**: macOS's `fsync` is not `F_FULLFSYNC`, so the throughput above is an optimistic lower bound, and it is a small-scale micro-measurement.

If building taught me "why it is done this way", measuring confirms "whether it is really so". Next time I add a feature, I plan not to stop at words — I will add one more line to `make bench` and measure.

## References

- [PostgreSQL Documentation: synchronous_commit](https://www.postgresql.org/docs/current/runtime-config-wal.html)
- [MySQL Documentation: innodb_flush_log_at_trx_commit](https://dev.mysql.com/doc/refman/8.0/en/innodb-parameters.html#sysvar_innodb_flush_log_at_trx_commit)
- [Apple Developer Documentation: fcntl(2) — F_FULLFSYNC](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/fcntl.2.html)
- This blog: [DB Index ②: Scan Types and the Optimizer's Choice](/blog/theory/db-index-02-scan-types)
- [minidb on GitHub](https://github.com/dj258255/db-hobby) — `tests/bench.c`, `make bench`

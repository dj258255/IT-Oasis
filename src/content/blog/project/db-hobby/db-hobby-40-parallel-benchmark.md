---
title: '병렬 실행, 진짜 빨라졌나? — 실측과 그 천장'
titleEn: 'Did Parallelism Actually Help? — Measuring, and Its Ceiling'
description: "36~39편에서 병렬 스캔·SELECT·집계·부분 집계를 잔뜩 만들었다. 그런데 정말 빨라졌을까? 이 편은 기능을 더 얹는 대신 자로 잰다. 같은 집계 쿼리를 워커 1·2·4·8로 돌려 wall-clock을 재고 1워커(직렬 기준) 대비 speedup을 낸다. 워커 수를 런타임에 바꾸도록 db_set_parallel_workers를 더했다. 12코어에서 실측 결과: 워밍(테이블이 버퍼 풀에 상주)이면 per-row 작업이 클수록 speedup이 커져, 무거운 다중 집계+WHERE가 4워커에서 2.16x, COUNT+WHERE가 1.98x, 가벼운 SUM은 2워커에서 1.58x. 그런데 12코어인데 ~2x다 — 선형이 전혀 아니고, 2~4워커에서 정점을 찍은 뒤 8워커에선 오히려 느려진다. 왜? 세 가지 천장이다: sub-ms 쿼리라 스레드 생성 오버헤드가 크고, 굵은 버퍼 풀 latch가 페이지 fetch를 직렬화하며, 메모리 대역폭이 걸린다. 콜드 체제(테이블이 풀보다 큼)가 두 번째를 증명한다 — pager_read가 풀 latch 안에서 직렬화돼 8워커가 0.65x로 떨어진다. 천장은 CPU가 아니라 공유 latch다. 이 측정이 다음 프론티어(더 크고 세밀한 per-page latch 버퍼 풀, engine_mtx 완전 제거)의 동기를 숫자로 보여준다. test_parworkers로 워커 수와 무관하게 결과가 바이트 동일함을 못박는다. 682 checks / 41스위트."
descriptionEn: "Across Parts 36–39 I built a lot of parallelism — parallel scan, SELECT, aggregate, partial aggregate. But did it actually get faster? Instead of adding features, this part measures. It runs the same aggregate query with 1/2/4/8 workers, times the wall-clock, and reports speedup vs 1 worker (the serial baseline). I added db_set_parallel_workers to change the worker count at runtime. On 12 cores: in the warm regime (the table resident in the buffer pool), more per-row work means more speedup — a heavy multi-aggregate+WHERE hits 2.16x at 4 workers, COUNT+WHERE 1.98x, a light SUM 1.58x at 2 workers. But on 12 cores that's ~2x — nowhere near linear, and after peaking at 2–4 workers it gets slower at 8. Why? Three ceilings: sub-ms queries make thread-spawn overhead significant, the coarse buffer-pool latch serializes page fetches, and memory bandwidth. The cold regime (table bigger than the pool) proves the second — pager_read serializes inside the pool latch, dropping 8 workers to 0.65x. The ceiling isn't CPU, it's the shared latch. This measurement gives the next frontiers (a bigger, finer-grained per-page-latched pool, full removal of engine_mtx) a number-backed motivation. test_parworkers pins down that results are byte-identical regardless of worker count. 682 checks / 41 suites."
date: 2026-07-05
tags:
  - C
  - Database Internals
  - Parallel Query
  - Benchmark
  - Concurrency
  - Learning
category: study/db-hobby
coverImage: /uploads/project/db-hobby/cover.svg
draft: false
series: "db-hobby"
seriesOrder: 40
---

## 0. 들어가며 — 만들었으면 재봐야지

[36](/blog/project/db-hobby/db-hobby-36-parallel-scan)~[39편](/blog/project/db-hobby/db-hobby-39-partial-aggregate)에서 병렬 스캔·SELECT·집계·부분 집계를 잔뜩 만들었어요. 그런데 **정말 빨라졌을까요?** 기능을 하나 더 얹기 전에, 이 편은 **자로 잽니다.** ([7편](/blog/project/db-hobby/db-hobby-7-benchmark)에서 "인덱스는 정말 빠른가"를 쟀듯이요.)

방법은 간단해요. 같은 집계 쿼리를 **워커 1·2·4·8**로 돌려 wall-clock을 재고, **1워커(직렬 기준) 대비 speedup**을 냅니다. 워커 수를 런타임에 바꾸도록 `db_set_parallel_workers`를 더했어요.

```c
void db_set_parallel_workers(int n);   // 1이면 사실상 직렬 기준선
```

## 1. 결과 — 빨라진다, 그런데 modest하게

12코어 머신, 최소시간(노이즈 최소화). **워밍 체제**(테이블이 버퍼 풀에 다 올라온 CPU-bound):

| 워크로드 | 1워커 | 2워커 | 4워커 | 8워커 |
|---|---|---|---|---|
| `SUM(v)` (가벼운 per-row) | 1.00x | **1.58x** | 1.27x | 0.98x |
| `COUNT(*) WHERE v>7500` | 1.00x | 1.66x | **1.98x** | 1.45x |
| `COUNT,SUM,MIN,MAX WHERE` (무거운) | 1.00x | 1.66x | **2.16x** | 1.55x |

![병렬 실행 실측: 최고 2.16x, 이상적 선형(12x)과 큰 격차, 천장은 공유 latch](/uploads/project/db-hobby/parallel-benchmark.svg)

두 가지가 또렷해요:

1. **per-row 작업이 클수록 speedup이 커진다.** 가벼운 `SUM`은 1.58x, 무거운 다중 집계+WHERE는 **2.16x**. 병렬화가 돕는 건 **행마다 드는 CPU 작업**(가시성 판정 + WHERE 평가 + 누적)이니까요.
2. **2~4워커에서 정점을 찍고 하락한다.** 12코어인데 **8워커는 항상 4워커보다 느려요.** 선형(12x) 근처도 못 갑니다.

## 2. 왜 12코어인데 ~2x인가 — 천장 셋

정직하게 원인을 짚어요.

**① sub-ms 쿼리 — 스레드 생성 오버헤드.** 워밍 워크로드는 0.3~0.5ms예요. 워커 4개를 `pthread_create`/`join` 하는 고정 비용이 이 짧은 일에선 무시 못 할 몫이에요. 8워커면 스레드 관리 비용이 일보다 커져 오히려 느려지죠.

**② 굵은 버퍼 풀 latch — fetch 직렬화.** [20편](/blog/project/db-hobby/db-hobby-20-thread-safety)에서 버퍼 풀에 latch 하나를 달았어요. 워커가 페이지를 `bufpool_fetch` 할 때마다 그 latch를 잡습니다. 워밍이면 fetch가 O(1)이라 잠깐이지만, **콜드면 이 latch 안에서 `pager_read`(디스크 I/O)까지 일어나** 완전히 직렬화돼요.

**③ 메모리 대역폭.** 가벼운 `SUM`처럼 per-row 계산이 값싸면, 여러 코어가 같은 메모리를 훑는 대역폭이 병목이라 코어를 늘려도 안 빨라져요.

## 3. 콜드 체제가 ②를 증명한다

우리 엔진의 테이블 버퍼 풀은 `WAL_MAX_STAGED`(64프레임)로 작아요. 그래서 **64페이지를 넘는 테이블은 스캔마다 thrash**하죠. 12만 행(~360페이지)으로 재보면:

| 워크로드 | 1워커 | 2워커 | 4워커 | 8워커 |
|---|---|---|---|---|
| `SUM(v)` 콜드(>풀) | 1.00x | 1.70x | 1.26x | **0.65x** |

8워커가 **0.65x** — 직렬보다 **느려요.** 워커 넷이 64프레임 풀에 몰려 latch 앞에 줄 서고, `pager_read`가 그 안에서 직렬화되고, 서로의 페이지를 evict 하며 thrash 하니까요.

> 천장은 **CPU가 아니라 공유 latch**예요. 이게 이 측정의 핵심 결론이에요.

## 4. 결과는 워커 수와 무관하게 같다

speedup을 재려면 먼저 **워커 수를 바꿔도 답이 같아야** 해요(안 그럼 비교가 무의미). `test_parworkers`(신규, 5 checks)가 워커 1·2·4·8로 같은 쿼리를 돌려 출력이 **바이트 단위로 동일**함을 못박아요 — 부분 집계·GROUP BY 수집·병렬 스트리밍 SELECT 경로 모두. 전체는 **682 checks / 41스위트, FAIL 0.**

```
  ok   부분 집계 COUNT/SUM/MIN/MAX: 워커 1·2·4·8 결과 동일
  ok   GROUP BY(수집 경로): 워커 무관 동일
  ok   병렬 스트리밍 SELECT: 워커 무관 동일(페이지 순서)
```

## 5. 이 숫자가 가리키는 다음

measure가 다음 프론티어의 **동기를 숫자로** 줘요:

- **더 크고 세밀한 버퍼 풀**: 지금 풀은 64프레임 공유 latch예요. per-page(또는 샤딩된) latch로 바꾸면 콜드 스캔의 fetch 직렬화(②)가 풀려 병렬 I/O가 가능해져요.
- **engine_mtx 완전 제거**: 이 벤치는 **한 쿼리 안의 병렬(intra-query)**만 쟀어요. 서로 다른 트랜잭션을 동시에 돌리는 **inter-query 동시성**은 여전히 `engine_mtx`가 막고 있고, 그게 진짜 멀티코어 확장의 프론티어예요.
- **더 큰 작업 단위**: sub-ms 쿼리는 스레드 오버헤드에 불리해요. 큰 배치·큰 스캔일수록 병렬이 유리한데, 그건 풀 크기(①과 ②)가 풀려야 커져요.

세 프론티어가 사실 **하나로 수렴**해요 — 굵은 공유 latch(풀 latch·engine_mtx)를 걷어내는 것.

## 6. 마무리

- 36~39편의 병렬 작업을 **숫자로 검증**했다 — 워밍 CPU-bound에서 **최고 2.16x**(무거운 per-row일수록↑).
- 하지만 12코어에서 ~2x, 2~4워커 정점 후 하락 — **선형이 아니다.** 천장은 CPU가 아니라 **공유 latch**(+스레드 오버헤드·메모리 대역폭).
- **콜드 체제**가 latch 병목을 증명(8워커 0.65x). 측정이 다음 프론티어(세밀한 풀·engine_mtx 제거)의 동기를 숫자로 준다.
- `test_parworkers`로 결과가 워커 수와 무관하게 동일함을 못박았다.

<!-- EN -->

## 0. Intro — If You Built It, Measure It

Across Parts [36](/blog/project/db-hobby/db-hobby-36-parallel-scan)–[39](/blog/project/db-hobby/db-hobby-39-partial-aggregate) I built a lot of parallelism — parallel scan, SELECT, aggregate, partial aggregate. But **did it actually get faster?** Before adding one more feature, this part **measures** (the way [Part 7](/blog/project/db-hobby/db-hobby-7-benchmark) measured "is the index really fast").

The method is simple: run the same aggregate query with **1/2/4/8 workers**, time the wall-clock, and report **speedup vs 1 worker (the serial baseline)**. I added `db_set_parallel_workers` to change the count at runtime.

```c
void db_set_parallel_workers(int n);   // 1 is effectively the serial baseline
```

## 1. Results — Faster, but Modestly

A 12-core machine, min time (to cut noise). **Warm regime** (the table fully resident in the buffer pool, CPU-bound):

| Workload | 1 worker | 2 | 4 | 8 |
|---|---|---|---|---|
| `SUM(v)` (light per-row) | 1.00x | **1.58x** | 1.27x | 0.98x |
| `COUNT(*) WHERE v>7500` | 1.00x | 1.66x | **1.98x** | 1.45x |
| `COUNT,SUM,MIN,MAX WHERE` (heavy) | 1.00x | 1.66x | **2.16x** | 1.55x |

![Parallel benchmark: peaks at 2.16x, far from ideal linear (12x); the ceiling is the shared latch](/uploads/project/db-hobby/parallel-benchmark.svg)

Two things stand out:

1. **More per-row work → more speedup.** Light `SUM` is 1.58x; a heavy multi-aggregate+WHERE is **2.16x**. Parallelism helps the **CPU work per row** (visibility check + WHERE eval + accumulate).
2. **It peaks at 2–4 workers, then drops.** On 12 cores, **8 workers is always slower than 4.** Nowhere near linear (12x).

## 2. Why Only ~2x on 12 Cores — Three Ceilings

Honestly, the causes:

**① Sub-ms queries — thread-spawn overhead.** The warm workloads are 0.3–0.5 ms. The fixed cost of `pthread_create`/`join` on 4 workers is a non-trivial fraction of such short work. At 8 workers the thread-management cost exceeds the work, so it gets slower.

**② The coarse buffer-pool latch — serialized fetches.** In [Part 20](/blog/project/db-hobby/db-hobby-20-thread-safety) I put one latch on the buffer pool. Every `bufpool_fetch` takes it. Warm, a fetch is O(1) so it's brief; **cold, `pager_read` (disk I/O) happens inside that latch**, fully serializing.

**③ Memory bandwidth.** When the per-row compute is cheap (like light `SUM`), several cores sweeping the same memory are bandwidth-bound, so adding cores doesn't help.

## 3. The Cold Regime Proves ②

Our table buffer pool is small — `WAL_MAX_STAGED` (64 frames). So a **table over 64 pages thrashes on each scan.** Measured at 120k rows (~360 pages):

| Workload | 1 worker | 2 | 4 | 8 |
|---|---|---|---|---|
| `SUM(v)` cold (>pool) | 1.00x | 1.70x | 1.26x | **0.65x** |

8 workers is **0.65x** — **slower than serial.** Four workers crowd a 64-frame pool, queue on the latch, `pager_read` serializes inside it, and they evict each other's pages and thrash.

> The ceiling is **the shared latch, not the CPU.** That's the key conclusion of this measurement.

## 4. Results Are Identical Regardless of Worker Count

To measure speedup, the answer must first be **the same across worker counts** (else the comparison is meaningless). `test_parworkers` (new, 5 checks) runs the same query at 1/2/4/8 workers and pins down that the output is **byte-identical** — across the partial-aggregate, GROUP-BY collection, and parallel streaming SELECT paths. The whole suite is **682 checks / 41 suites, FAIL 0.**

```
  ok   partial aggregate COUNT/SUM/MIN/MAX: identical at 1/2/4/8 workers
  ok   GROUP BY (collection path): identical regardless of workers
  ok   parallel streaming SELECT: identical (page order preserved)
```

## 5. Where These Numbers Point

The measurement gives the next frontiers a **number-backed motivation**:

- **A bigger, finer-grained buffer pool**: today the pool is a 64-frame shared latch. A per-page (or sharded) latch would unblock the cold-scan fetch serialization (②) and allow parallel I/O.
- **Full removal of engine_mtx**: this bench measured only **intra-query** parallelism. Running **different transactions at once (inter-query)** is still blocked by `engine_mtx` — the real frontier for multicore scaling.
- **Larger units of work**: sub-ms queries are penalized by thread overhead. Bigger batches/scans favor parallelism, which requires the pool size (① and ②) to be unblocked.

The three frontiers actually **converge on one** — peeling off the coarse shared latches (the pool latch and engine_mtx).

## 6. Wrap-up

- **Validated** Parts 36–39's parallelism with numbers — up to **2.16x** on warm CPU-bound work (higher the heavier the per-row work).
- But ~2x on 12 cores, peaking at 2–4 workers then dropping — **not linear.** The ceiling isn't CPU, it's the **shared latch** (+ thread overhead, memory bandwidth).
- The **cold regime** proves the latch bottleneck (8 workers at 0.65x). The measurement gives the next frontiers (finer-grained pool, engine_mtx removal) a number-backed motivation.
- `test_parworkers` pins down that results are identical regardless of worker count.

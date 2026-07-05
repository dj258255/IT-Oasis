---
title: '읽기 I/O를 버퍼 풀 latch 밖으로 — 40편이 잰 병목을 닫다'
titleEn: 'Read I/O Out of the Buffer-Pool Latch — Closing the Bottleneck Part 40 Measured'
description: "40편에서 병렬 실행을 실측하며 천장이 CPU가 아니라 공유 latch임을 숫자로 짚었다 — 콜드 스캔에서 버퍼 풀 latch가 pager_read(디스크 I/O)를 직렬화해 8워커가 0.62x로 직렬보다 느려졌다. 그런데 이 병목은 bufpool.c의 latch 주석이 스스로 지목해 둔 프론티어였다: '진짜 DB는 read-in-progress 상태로 I/O를 latch 밖으로 뺀다.' 41편이 그걸 한다. miss가 나면 victim 프레임을 io_pending으로 예약하고(pin해서 로딩 중 축출을 막고) latch를 놓은 뒤 pager_read를 밖에서 한다. 끝나면 latch를 재획득해 io_pending을 지우고 broadcast한다. 같은 페이지를 동시에 miss한 다른 스레드는 io_cond에서 기다렸다 깨어나 hit로 잡으므로 중복 로드가 없고, pin+io_pending이 로딩 중 프레임을 지켜 데이터 레이스가 없다(dirty victim 쓰기는 아직 latch 안 — 스테이징 경로라 스캔에선 드물다). 검증은 airtight하다: bufpool_set_io_in_latch로 같은 프로세스·같은 워밍에서 latch 안/밖만 바꿔 A/B를 재면, 콜드 SUM 스캔이 I/O를 latch 안에 두면 4워커 1.08x·8워커 0.62x, 밖으로 빼면 4워커 2.39x·8워커 1.36x로 올라간다 — I/O 직렬화가 천장이었음을 확증한다. test_iobypass가 콜드 70k행 8워커 동시 로딩이 수학적 정답과 일치함을, 축출 폭풍을 ThreadSanitizer로 data race 0을 못박는다. 686 checks / 42스위트. 남은 천장: 스레드 오버헤드·작은 풀(64프레임)·dirty 쓰기 latch·engine_mtx."
descriptionEn: "Measuring parallelism in Part 40, I pinned down with numbers that the ceiling isn't CPU but the shared latch — on a cold scan, the buffer-pool latch serializes pager_read (disk I/O), so 8 workers dropped to 0.62x, slower than serial. But this bottleneck was a frontier bufpool.c's own latch comment had named: 'a real DB moves I/O out of the latch with a read-in-progress state.' Part 41 does that. On a miss, it reserves the victim frame as io_pending (pinned so it can't be evicted during the load), releases the latch, and does pager_read outside. When done it re-acquires the latch, clears io_pending, and broadcasts. Another thread that missed the same page waits on io_cond and wakes to grab it as a hit, so there's no duplicate load, and pin+io_pending guard the loading frame so there's no data race (the dirty-victim write is still under the latch — it's the staging path, rare on scans). Verification is airtight: with bufpool_set_io_in_latch, an A/B in the same process with the same warm-up (the only variable being in-latch vs out) shows the cold SUM scan going from 1.08x (4w) / 0.62x (8w) with I/O in the latch to 2.39x / 1.36x with it out — confirming I/O serialization was the ceiling. test_iobypass pins down that a cold 70k-row 8-worker concurrent load matches the math oracle, and ThreadSanitizer confirms zero data races under an eviction storm. 686 checks / 42 suites. Remaining ceilings: thread overhead, the small pool (64 frames), the dirty-write latch, and engine_mtx."
date: 2026-07-05
tags:
  - C
  - Database Internals
  - Buffer Pool
  - Concurrency
  - Parallel Query
  - Learning
category: study/db-hobby
coverImage: /uploads/project/db-hobby/cover.svg
draft: false
series: "db-hobby"
seriesOrder: 41
---

## 0. 들어가며 — 측정이 가리킨 곳을 판다

[40편](/blog/project/db-hobby/db-hobby-40-parallel-benchmark)에서 병렬 실행을 실측하며, 천장이 **CPU가 아니라 공유 latch**임을 숫자로 짚었어요. 콜드 스캔에서 8워커가 **0.62x** — 직렬보다 느렸죠. 원인은 버퍼 풀 latch가 `pager_read`(디스크 I/O)까지 감싸 **I/O를 직렬화**하는 것이었어요.

그런데 이 병목은 사실 `bufpool.c`의 latch 주석이 **스스로 지목**해 둔 프론티어였어요:

> "I/O(pager_read/write)도 이 latch 안에서 한다: 직렬화되지만 단순하고 정확하다. **(진짜 DB는 "read-in-progress" 상태로 I/O를 latch 밖으로 뺀다.)**"

41편이 바로 그걸 합니다. [27편→35편](/blog/project/db-hobby/db-hobby-35-lsm-pk-index)이 lsm 주석의 프론티어를 닫았듯, 코드가 남긴 TODO를 측정이 우선순위로 끌어올린 거예요.

## 1. 문제 — latch가 I/O를 삼킨다

miss가 나면 옛 `fetch_locked`는 이렇게 했어요(전부 latch 안):

```c
f = pick_frame(bp);                       // victim 고르기
pager_read(bp->pager, page_id, f->data);  // ← 디스크 I/O를 latch 잡은 채로!
f->page_id = page_id; f->valid = 1; ...
```

워밍(페이지가 다 상주)이면 miss가 드물어 괜찮아요. 하지만 **콜드**(테이블 > 풀 64프레임)면 스캔마다 miss가 쏟아지고, 워커 넷이 이 latch 앞에 줄 서서 `pager_read`를 **한 번에 하나씩** 합니다. 코어가 12개여도 I/O는 1차선인 거죠.

## 2. 고침 — read-in-progress로 I/O를 latch 밖에

발상은 간단해요: **프레임을 먼저 '예약'하고 latch를 놓은 뒤 읽는다.**

```c
// (latch 보유) miss:
f = pick_frame(bp);
f->page_id = page_id; f->valid = 1;
f->io_pending = 1;    // "로딩 중" 표시
f->pin_count = 1;     // pin -> 로딩 중 축출 금지

pthread_mutex_unlock(&bp->latch);          // ← latch 놓고
int rc = pager_read(bp->pager, page_id, f->data);  //   I/O를 밖에서 (병렬!)
pthread_mutex_lock(&bp->latch);            // ← 다시 잡고

f->io_pending = 0;
pthread_cond_broadcast(&bp->io_cond);      // 기다리던 스레드 깨움
```

`io_pending`으로 예약해 두면, latch를 놓은 사이에 다른 워커가 이 프레임을 만져도 안전해요. 워커들이 **각자 다른 페이지**를 읽으면 I/O가 진짜 병렬로 겹칩니다.

![읽기 I/O를 latch 밖으로: before는 I/O 직렬(4w 1.08x), after는 병렬(4w 2.39x)](/uploads/project/db-hobby/io-out-of-latch.svg)

## 3. 함정 — 같은 페이지를 동시에 miss하면?

두 워커가 **같은 콜드 페이지**를 동시에 원하면? 둘 다 읽어 오면 프레임 하나가 두 번 로드되고 낭비 + 꼬여요. 그래서 `io_pending`이 두 번째 역할을 해요:

```c
Frame *f = find_frame(bp, page_id);
if (f && f->io_pending) {
    // 다른 스레드가 바로 이 페이지를 로딩 중 — 끝날 때까지 기다린다
    pthread_cond_wait(&bp->io_cond, &bp->latch);  // latch 원자적으로 놓고 잠
    continue;  // 깨어나면 재시도 -> 이제 hit
}
```

먼저 온 워커가 프레임을 `io_pending`으로 예약해 두면, 같은 페이지를 원한 두 번째 워커는 그걸 발견하고 **`io_cond`에서 기다려요.** 첫 워커가 로딩을 마치고 `broadcast`하면, 두 번째 워커는 깨어나 재시도해서 이제 **hit**로 잡습니다. **중복 로드 없음.** (`cond_wait`이 latch를 원자적으로 놓고 자므로 데드락도 없어요.)

레이스가 없는 근거: 로딩 중 프레임은 **pin + io_pending**이라, `pick_frame`이 안 건드리고(pin된 프레임 제외) 다른 fetch는 대기해요. 그래서 `f->data`를 쓰는 건 로딩 스레드 하나뿐이고, 읽는 건 latch 동기화 뒤예요 — happens-before가 성립해 ThreadSanitizer도 깨끗합니다. (dirty victim을 디스크로 **쓰는** I/O는 아직 latch 안에 뒀어요 — 스테이징 경로라 읽기 스캔에선 드물거든요. 정직한 경계.)

## 4. 검증 — 같은 프로세스 A/B

speedup을 정직하게 재려면 **변수가 하나여야** 해요. 그래서 `bufpool_set_io_in_latch`로 I/O를 latch 안/밖으로 토글하는 스위치를 두고, **같은 프로세스·같은 워밍 상태**에서 before/after를 잽니다(CPU 상태 차이까지 제거).

콜드 `SELECT SUM(v)` 스캔(12코어):

| | 1워커 | 2워커 | 4워커 | 8워커 |
|---|---|---|---|---|
| **before** (I/O를 latch 안) | 1.00x | 1.76x | 1.08x | **0.62x** |
| **after** (I/O를 latch 밖) | 1.00x | 1.74x | **2.39x** | **1.36x** |

- 4워커: **1.08x → 2.39x** (2.2배)
- 8워커: **0.62x(직렬보다 느림) → 1.36x**

변수는 딱 하나(latch 안/밖)뿐이니, **I/O 직렬화가 콜드 병목이었다는 걸 확증**해요. 40편이 "천장은 공유 latch"라 했는데, 그 한 조각을 걷어내니 콜드가 정말 살아났습니다.

## 5. 정확성 — 콜드 동시 로딩 + 레이스 0

`test_iobypass`(신규, 4 checks)가 새 경로를 콜드로 두들겨요. 7만 행(~210페이지 > 풀 64프레임)을 8워커로 훑으면 워커들이 **같은/다른 페이지를 동시에 miss**해 read-in-progress 경로를 강하게 밟죠:

```
  ok   8워커 콜드 SUM = 2450035000 (동시 로딩 정확)
  ok   I/O latch 밖(41편) vs 안(이전): 결과 바이트 동일
  ok   콜드 병렬 스트리밍 SELECT: 정확한 행(69996..70000)
```

- **정확성**: 8워커 동시 로딩 결과가 **수학적 정답**(SUM 1..70000 = 2450035000)과 일치.
- **A/B 동치**: I/O를 밖으로 빼든 안에 두든 결과가 바이트 동일(둘 다 정확).
- **레이스 0**: `test_iobypass_tsan`과 `test_concurrency_tsan`(축출 폭풍)이 ThreadSanitizer로 **data race 0**을 확인. 전체 **686 checks / 42스위트, FAIL 0.**

## 6. 남긴 천장

콜드 I/O 한 조각을 걷었지만, [40편](/blog/project/db-hobby/db-hobby-40-parallel-benchmark)이 짚은 나머지 천장은 남아요:

- **스레드 오버헤드**: sub-ms 쿼리는 여전히 8워커가 4워커보다 느려요(스레드 생성 비용).
- **작은 풀(64프레임)**: 콜드는 여전히 thrash해요. 읽기는 병렬이 됐지만 풀이 작아 재적재가 잦죠. 풀 크기를 WAL 스테이징 한계와 분리하는 게 다음 조각.
- **dirty 쓰기는 아직 latch 안**: 쓰기 I/O는 여전히 직렬. 쓰기 병렬화는 별개의 프론티어.
- **engine_mtx**: 서로 다른 트랜잭션 동시 실행은 여전히 막혀 있어요 — 가장 큰 조각.

넷 다 결국 **굵은 공유 latch를 계층별로 걷어내는** 같은 여정이에요. 41편은 그중 '콜드 읽기 I/O' 한 장을 실제로 걷어냈고요.

## 7. 마무리

- 40편이 **숫자로 짚은 병목**(콜드에서 풀 latch가 I/O 직렬화)을, `bufpool.c` 주석이 스스로 지목한 프론티어(read-in-progress)로 닫았다.
- miss 시 프레임을 **io_pending + pin으로 예약**하고 latch를 놓고 `pager_read` → 병렬 I/O. 같은 페이지 동시 miss는 `io_cond` 대기로 중복 로드 방지.
- **같은 프로세스 A/B**로 확증: 콜드 4워커 1.08x→2.39x, 8워커 0.62x→1.36x. 변수는 latch 안/밖 하나뿐.
- 콜드 동시 로딩 정확성 + 축출 폭풍 ThreadSanitizer 클린. 남은 천장(작은 풀·dirty 쓰기·engine_mtx)은 같은 여정의 다음 장.

<!-- EN -->

## 0. Intro — Dig Where the Measurement Points

Measuring parallelism in [Part 40](/blog/project/db-hobby/db-hobby-40-parallel-benchmark), I pinned down with numbers that the ceiling is **not the CPU but the shared latch**. On a cold scan, 8 workers dropped to **0.62x** — slower than serial. The cause: the buffer-pool latch wraps `pager_read` (disk I/O) too, **serializing the I/O**.

But this bottleneck was a frontier `bufpool.c`'s own latch comment had **named**:

> "I/O (pager_read/write) is also done inside this latch: serialized but simple and correct. **(A real DB moves I/O out of the latch with a 'read-in-progress' state.)**"

Part 41 does exactly that. Like [Part 27→35](/blog/project/db-hobby/db-hobby-35-lsm-pk-index) closed the lsm comment's frontier, a measurement promoted a TODO the code left behind.

## 1. The Problem — the Latch Swallows the I/O

On a miss, the old `fetch_locked` did this (all under the latch):

```c
f = pick_frame(bp);                       // choose a victim
pager_read(bp->pager, page_id, f->data);  // ← disk I/O while holding the latch!
f->page_id = page_id; f->valid = 1; ...
```

Warm (all pages resident), misses are rare, so it's fine. But **cold** (table > the 64-frame pool), each scan floods misses, and four workers queue at the latch to do `pager_read` **one at a time**. Twelve cores, but the I/O is a single lane.

## 2. The Fix — read-in-progress Puts I/O Outside the Latch

The idea is simple: **reserve the frame first, release the latch, then read.**

```c
// (holding the latch) miss:
f = pick_frame(bp);
f->page_id = page_id; f->valid = 1;
f->io_pending = 1;    // mark "loading"
f->pin_count = 1;     // pin -> can't be evicted mid-load

pthread_mutex_unlock(&bp->latch);          // ← drop the latch
int rc = pager_read(bp->pager, page_id, f->data);  //   I/O outside (parallel!)
pthread_mutex_lock(&bp->latch);            // ← re-acquire

f->io_pending = 0;
pthread_cond_broadcast(&bp->io_cond);      // wake waiters
```

Reserving with `io_pending` makes it safe for another worker to touch the frame while the latch is dropped. When workers read **different pages**, the I/O genuinely overlaps.

![Read I/O out of the latch: before serializes I/O (4w 1.08x), after parallelizes it (4w 2.39x)](/uploads/project/db-hobby/io-out-of-latch.svg)

## 3. The Trap — What if Two Threads Miss the Same Page?

If two workers want the **same cold page** at once, both loading it wastes a frame and tangles things. So `io_pending` plays a second role:

```c
Frame *f = find_frame(bp, page_id);
if (f && f->io_pending) {
    // another thread is loading this very page — wait for it
    pthread_cond_wait(&bp->io_cond, &bp->latch);  // atomically drop latch + sleep
    continue;  // on wake, retry -> now a hit
}
```

Once the first worker reserves the frame as `io_pending`, a second worker wanting the same page finds it and **waits on `io_cond`.** When the first finishes and `broadcast`s, the second wakes, retries, and grabs it as a **hit.** **No duplicate load.** (`cond_wait` atomically drops the latch while sleeping, so no deadlock.)

Why it's race-free: a loading frame is **pinned + io_pending**, so `pick_frame` won't touch it (it skips pinned frames) and other fetches wait. So only the loading thread writes `f->data`, and readers only read it after latch synchronization — happens-before holds, ThreadSanitizer stays clean. (The dirty-victim **write** I/O is still under the latch — it's the staging path, rare on read scans. An honest boundary.)

## 4. Verification — a Same-Process A/B

To measure speedup honestly, **only one variable may change.** So I added a `bufpool_set_io_in_latch` switch to toggle I/O in/out of the latch, and measured before/after **in the same process with the same warm-up** (removing even CPU-state differences).

Cold `SELECT SUM(v)` scan (12 cores):

| | 1 worker | 2 | 4 | 8 |
|---|---|---|---|---|
| **before** (I/O in the latch) | 1.00x | 1.76x | 1.08x | **0.62x** |
| **after** (I/O out of the latch) | 1.00x | 1.74x | **2.39x** | **1.36x** |

- 4 workers: **1.08x → 2.39x** (2.2×)
- 8 workers: **0.62x (slower than serial) → 1.36x**

With a single variable (latch in/out), this **confirms I/O serialization was the cold bottleneck.** Part 40 said "the ceiling is the shared latch"; peeling off one piece of it really did revive the cold case.

## 5. Correctness — Concurrent Cold Loading + Zero Races

`test_iobypass` (new, 4 checks) hammers the new path cold. Scanning 70k rows (~210 pages > the 64-frame pool) with 8 workers makes them **miss the same/different pages concurrently**, exercising the read-in-progress path hard:

```
  ok   8-worker cold SUM = 2450035000 (concurrent loading correct)
  ok   I/O out of latch (Part 41) vs in (before): byte-identical results
  ok   cold parallel streaming SELECT: correct rows (69996..70000)
```

- **Correctness**: the 8-worker concurrent-load result matches the **math oracle** (SUM 1..70000 = 2450035000).
- **A/B equivalence**: whether I/O is in or out of the latch, results are byte-identical (both correct).
- **Zero races**: `test_iobypass_tsan` and `test_concurrency_tsan` (eviction storm) confirm **zero data races** under ThreadSanitizer. The whole suite is **686 checks / 42 suites, FAIL 0.**

## 6. Ceilings Left

I peeled off one piece — cold read I/O — but [Part 40](/blog/project/db-hobby/db-hobby-40-parallel-benchmark)'s other ceilings remain:

- **Thread overhead**: sub-ms queries still make 8 workers slower than 4 (thread-spawn cost).
- **The small pool (64 frames)**: cold still thrashes. Reads are parallel now, but the small pool reloads often. Decoupling pool size from the WAL staging limit is the next piece.
- **Dirty writes still under the latch**: write I/O is still serialized. Parallelizing writes is a separate frontier.
- **engine_mtx**: running different transactions at once is still blocked — the biggest piece.

All four are the same journey — **peeling off coarse shared latches layer by layer.** Part 41 actually removed one page: cold read I/O.

## 7. Wrap-up

- Closed the bottleneck **Part 40 measured** (the pool latch serializing cold I/O) via the frontier `bufpool.c`'s own comment named (read-in-progress).
- On a miss, **reserve the frame with io_pending + pin**, drop the latch, `pager_read` → parallel I/O. Concurrent misses of the same page wait on `io_cond`, preventing duplicate loads.
- Confirmed with a **same-process A/B**: cold 4 workers 1.08x→2.39x, 8 workers 0.62x→1.36x. The only variable is latch in/out.
- Correct under concurrent cold loading, ThreadSanitizer-clean under an eviction storm. The remaining ceilings (small pool, dirty writes, engine_mtx) are the next chapters of the same journey.

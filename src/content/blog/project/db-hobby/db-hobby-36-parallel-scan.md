---
title: '병렬 풀 스캔 — 굵은 engine_mtx를 걷어낼 첫 발판'
titleEn: 'Parallel Sequential Scan — the First Foothold to Peel Off the Coarse engine_mtx'
description: "19편에서 진짜 psql이 붙는 스레드 서버를 만들 때, 정직하게 이렇게 적어뒀다 — 커넥션마다 OS 스레드를 띄우지만 실행 자체는 굵은 engine_mtx 하나로 직렬화한다(실행기 계층이 아직 단일 스레드 가정이라). MVCC로 논리적으론 reader가 writer를 안 막아도, 물리적 실행은 한 줄로 선다. 그 주석은 동시에 길도 가리켰다 — 버퍼 풀은 트랙 D에서 이미 자체 latch로 스레드 안전하니, 그게 굵은 latch를 계층별로 걷어낼 첫 발판이다. 이 편이 그 발판을 밟는다. read-only 풀 스캔을 nworkers 스레드로 병렬화한다: 워커들이 heap의 disjoint 페이지 범위를 동시에 훑고, 각자 자기만의 지역 결과에 RID를 모으고(락 없음), leader가 페이지 순서로 병합한다. PostgreSQL parallel sequential scan의 축소판이다. 안전한 이유: 버퍼 풀의 fetch/unpin이 latch 아래 pin_count를 관리하고 eviction이 pin된 프레임을 배제하므로, 같은 풀에서 여러 스레드가 read-only로 페이지를 fetch/unpin해도 레이스가 없다. 1~16 워커 모두 직렬 heap_scan과 RID 집합·순서까지 동일하고, ThreadSanitizer가 data race 0을 확인한다. 정직한 경계: read-only 스캔만 병렬화한다. engine_mtx를 통째로 걷어내 서로 다른 트랜잭션을 동시에 돌리려면 카탈로그·테이블 WAL·MVCC txn 상태까지 스레드 안전해야 하고, 그게 프론티어다."
descriptionEn: "Building the threaded server a real psql connects to in Part 19, I honestly noted it: each connection gets an OS thread, but execution itself is serialized by a single coarse engine_mtx (the executor layers still assume a single thread). Even though MVCC means readers don't block writers logically, physical execution runs in one line. That comment also pointed the way — the buffer pool is already thread-safe (its own latch, from Track D), so it's the first foothold to peel the coarse latch off layer by layer. This part takes that foothold. It parallelizes a read-only sequential scan across nworkers threads: workers sweep disjoint page ranges of the heap concurrently, each collecting RIDs into its own local result (no lock), and the leader merges in page order. It's a miniature of PostgreSQL's parallel sequential scan. Why it's safe: the buffer pool's fetch/unpin manage pin_count under a latch and eviction skips pinned frames, so many threads doing read-only fetch/unpin on the same pool never race. All of 1–16 workers match serial heap_scan down to the RID set and order, and ThreadSanitizer confirms zero data races. Honest boundary: only read-only scans are parallelized. Peeling off engine_mtx entirely to run different transactions at once needs the catalog, per-table WAL, and MVCC txn state all made thread-safe — that's the frontier."
date: 2026-07-05
tags:
  - C
  - Database Internals
  - Parallel Query
  - Concurrency
  - Buffer Pool
  - Threads
  - Learning
category: study/db-hobby
coverImage: /uploads/project/db-hobby/cover.svg
draft: false
series: "db-hobby"
seriesOrder: 36
---

## 0. 들어가며 — 19편이 남긴 직렬화

[19편](/blog/project/db-hobby/db-hobby-19-wire-protocol)에서 진짜 `psql`이 붙는 스레드 서버를 만들 때, 코드에 정직하게 이렇게 적어뒀어요(`server.c`):

> "커넥션마다 OS 스레드를 하나 띄운다(진짜 병렬 accept/네트워크 I/O). **실행 자체는 전역 엔진 latch(`engine_mtx`)로 직렬화한다** — 실행기 전 계층이 아직 스레드 안전하지 않으므로(단일 스레드 가정), 우선 한 개의 굵은 latch로 정확성을 산다. 버퍼 풀은 이미 자체 latch가 있어(트랙 D) **이 굵은 latch를 계층별로 걷어낼 첫 발판이다.**"

이게 지금 우리 엔진의 한계예요. [MVCC](/blog/project/db-hobby/db-hobby-18-snapshot)로 "reader가 writer를 안 막는다"를 **논리적으로는** 얻었지만, 두 클라이언트의 쿼리는 `engine_mtx` 때문에 **물리적으로는 절대 동시에 못 돌아요.** 멀티코어 머신을 한 코어처럼 쓰는 셈이죠.

이 편은 그 주석이 가리킨 발판을 밟습니다 — **버퍼 풀 위에서 한 뜨거운 계층(스캔)을 진짜 병렬로.**

## 1. 왜 스캔부터인가 — 걷어내기 가장 쉬운 계층

`engine_mtx`를 통째로 걷어내려면 카탈로그·테이블 WAL·MVCC txn 상태까지 전부 스레드 안전해야 해요. 그건 가장 큰 재작성이라 한 편에 안 들어가요(§5 프론티어).

대신 **read-only 풀 스캔**을 봅시다. 이건 세 가지가 겹쳐서 유별나게 병렬화하기 쉬워요:

1. **자명하게 분할된다.** `heap_scan`은 페이지 `[first_page, num_pages)`를 차례로 훑어요. 워커 w에게 페이지 블록 하나씩 주면 끝이에요.
2. **공유 가변 상태가 없다.** 읽기만 하니 heap을 안 바꿔요. 스냅샷·스키마·WHERE는 불변(읽기 전용)이고요.
3. **밑바닥이 이미 스레드 안전하다.** 버퍼 풀이 트랙 D에서 자체 latch를 얻었어요.

PostgreSQL이 병렬 쿼리를 넣을 때 **parallel sequential scan**(워커들이 페이지 블록을 나눠 스캔하고 leader가 모으는)부터 시작한 것과 같은 이유예요.

## 2. 왜 안전한가 — 버퍼 풀 latch가 진짜 발판

여러 스레드가 **같은 버퍼 풀**에서 페이지를 동시에 fetch/unpin해도 괜찮은 이유를 정확히 짚어야 해요. `bufpool.c`를 보면:

- `bufpool_fetch`/`bufpool_unpin`이 **둘 다 `bp->latch`를 잡고** `pin_count`를 관리한다.
- eviction victim은 **pin된 프레임(`pin_count != 0`)을 건너뛴다.** 모두 pin이면 NULL을 준다.

그래서:

- 워커 A가 fetch한 페이지는 **pin되어 있어** 워커 B의 fetch가 그걸 못 쫓아낸다.
- 워커 둘이 **같은 페이지를 동시에 read**해도 read-only라 안전하다(둘 다 pin, 둘 다 unpin).
- 서로 **다른 페이지**를 fetch하면 latch는 bookkeeping만 잠깐 직렬화하고 곧 놓는다.

> 딱 하나 제약: 각 워커가 한 번에 **페이지 하나를 pin**하므로, 풀 프레임 수가 `nworkers` 이상이어야 해요(안 그러면 fetch가 victim을 못 찾아 NULL). 이건 헤더에 정직하게 적었어요.

## 3. 구현 — 워커별 지역 결과, leader가 병합

`src/parscan.c`. 각 워커는 **자기만의 지역 결과**에 RID를 모아요 — 워커 간 공유 쓰기가 없으니 **락이 아예 필요 없어요.**

```c
static void *worker_main(void *arg) {
    Worker *w = arg;
    for (page_id_t pid = w->lo; pid < w->hi; pid++) {   // 내 페이지 블록만
        void *page = bufpool_fetch(w->h->bp, pid);      // latch 아래 pin
        uint16_t n = slotpage_num_slots(page);
        for (uint16_t s = 0; s < n; s++) {
            const void *rec; uint16_t len;
            if (slotpage_get(page, s, &rec, &len) == 0)  // 삭제 슬롯 스킵
                if (!w->pred || w->pred((RID){pid,s}, rec, len, w->ctx))
                    result_push(&w->res, (RID){pid, s}); // 지역 결과(락 없음)
        }
        bufpool_unpin(w->h->bp, pid, 0);
    }
    return NULL;
}
```

`parscan_collect`는 페이지 범위를 **연속 블록**으로 나눠(워커 0 = 앞 블록, …) 스레드를 띄우고, `pthread_join` 뒤 **워커 순서로 병합**해요. 연속 블록 + 워커 순서 병합이라 결과가 **직렬 스캔과 똑같은 페이지 순서**로 나옵니다.

![병렬 풀 스캔: 워커가 disjoint 페이지 범위를 스레드 안전 버퍼 풀 위에서 동시에 훑고 leader가 페이지 순서로 병합](/uploads/project/db-hobby/parallel-scan.svg)

술어(`pred`)는 페이지가 **pin된 동안** `rec`를 인라인으로 평가해요(pin이 풀리면 `rec` 포인터가 무효). `ctx`는 "읽기 전용 공유"라는 계약이라 워커들이 병렬로 호출해도 안전하고요.

## 4. 검증 — 직렬과 완전 동일 + 레이스 없음

`test_parscan`(신규, 11 checks)이 두 가지를 봐요.

**정확성**: 6,000행(18페이지)에 `key % 3 == 0` 술어로, **1·2·3·4·8·16 워커** 모두 직렬 `heap_scan`과 **RID 집합·순서까지 완전히 동일**한지.

```
  info N=6000 rows over 18 pages
  ok   병렬 스캔(1워커): 직렬과 RID 집합·순서 완전 동일
  ok   병렬 스캔(4워커): 직렬과 RID 집합·순서 완전 동일
  ok   병렬 스캔(16워커): 직렬과 RID 집합·순서 완전 동일
  ok   병렬 전체 스캔(pred=NULL, 8워커): 전체 N행
  ok   nworkers=0 클램프(=1): 직렬과 동일
```

**레이스 부재**: `test_parscan_tsan`(ThreadSanitizer 빌드)으로 같은 시나리오를 돌려 **data race 0**을 확인해요. 이게 "버퍼 풀 latch 위에서 read-only 병렬은 안전"이라는 주장의 진짜 증거예요.

전체 스위트는 이제 **645 checks / 37스위트, FAIL 0.**

### 어디서 이득이 나나 (정직하게)

버퍼 풀 latch는 페이지 fetch를 직렬화해요 — 캐시 미스 시 `pager_read`(디스크 I/O)도 그 latch 안에서 일어나거든요. 그래서:

- **콜드 캐시**: 디스크 I/O가 풀 latch로 직렬화돼 이득이 작아요. per-page latch로 I/O까지 병렬화하는 건 더 세밀한 풀 설계의 몫(프론티어).
- **워밍된 캐시**(테이블이 다 올라온): fetch는 latch 아래 O(1) bookkeeping뿐이고, 그 뒤 **슬롯 스캔·술어 평가·가시성 판정이 코어 수만큼 병렬**로 돌아 이득이 커요. PostgreSQL의 병렬 스캔도 CPU 바운드 필터에서 가장 빛나죠.

## 5. 남긴 프론티어

- **실행기 미배선**: [22편 cbtree](/blog/project/db-hobby/db-hobby-22-latch-crabbing)·[27편 lsm](/blog/project/db-hobby/db-hobby-27-lsm-engine)처럼 이 모듈도 독립으로 서요. `exec_select`의 풀 스캔 경로에 배선하려면 워커가 `decode_row`·`rec_visible`·결과 수집을 스레드 안전하게 해야 하고(출력은 leader가), 그건 다음 발판.
- **engine_mtx 완전 제거**: '서로 다른 트랜잭션'을 동시에 돌리는 게 진짜 목표인데, 그러려면 카탈로그·테이블 WAL·MVCC txn 상태가 전부 스레드 안전해야 해요. 계층별로 하나씩 — 버퍼 풀(트랙 D)·이 스캔 다음의 긴 여정.
- **병렬 조인/집계**: parallel hash join, parallel aggregate는 이 스캔을 입력으로 얹으면 자연스러운 다음 수순.

## 6. 마무리

- 19편이 남긴 직렬화(`engine_mtx`)의 한계를 정면으로 봤다 — 물리 실행이 한 줄로 선다.
- 걷어내기 가장 쉬운 계층 **read-only 스캔**부터: 자명한 페이지 분할 + 공유 가변 상태 없음 + 스레드 안전 버퍼 풀.
- 워커별 **지역 결과 → leader 페이지 순서 병합**이라 락 없이 직렬과 동일한 결과.
- **안전의 근거는 버퍼 풀 latch**: fetch/unpin이 pin_count를 관리하고 eviction이 pin된 프레임을 배제 — read-only 동시 접근에 레이스가 없다(ThreadSanitizer로 실증).
- 정직한 경계: read-only 스캔만. engine_mtx 완전 제거는 프론티어 — 계층별로 걷어내는 그 길의 첫 발판을 놓았다.

<!-- EN -->

## 0. Intro — the Serialization Part 19 Left

Building the threaded server a real `psql` connects to in [Part 19](/blog/project/db-hobby/db-hobby-19-wire-protocol), I honestly wrote this into the code (`server.c`):

> "Each connection gets its own OS thread (truly parallel accept / network I/O). **Execution itself is serialized by a global engine latch (`engine_mtx`)** — since the whole executor stack still isn't thread-safe (single-thread assumption), we buy correctness with one coarse latch first. The buffer pool already has its own latch (Track D), so it's **the first foothold to peel this coarse latch off layer by layer.**"

That's the limit of our engine today. [MVCC](/blog/project/db-hobby/db-hobby-18-snapshot) gives us "readers don't block writers" **logically**, but two clients' queries can **never physically run at once** because of `engine_mtx`. We use a multicore machine like a single core.

This part takes the foothold that comment pointed to — **one hot layer (the scan), truly parallel, on top of the buffer pool.**

## 1. Why the Scan First — the Easiest Layer to Peel

Peeling off `engine_mtx` entirely needs the catalog, per-table WAL, and MVCC txn state all made thread-safe. That's the biggest rewrite; it doesn't fit one part (§5, frontier).

Instead, look at a **read-only sequential scan.** Three things line up to make it unusually easy to parallelize:

1. **Trivially partitioned.** `heap_scan` walks pages `[first_page, num_pages)` in order. Give each worker one block of pages and you're done.
2. **No shared mutable state.** It only reads, so it doesn't change the heap. The snapshot, schema, and WHERE are immutable (read-only).
3. **The floor is already thread-safe.** The buffer pool got its own latch in Track D.

It's the same reason PostgreSQL started its parallel query work with the **parallel sequential scan** (workers split page blocks; a leader gathers).

## 2. Why It's Safe — the Buffer Pool Latch Is the Real Foothold

I need to pin down exactly why many threads fetching/unpinning pages on the **same buffer pool** concurrently is fine. Looking at `bufpool.c`:

- `bufpool_fetch`/`bufpool_unpin` **both take `bp->latch`** and manage `pin_count` under it.
- The eviction victim **skips pinned frames (`pin_count != 0`)**, returning NULL if all are pinned.

So:

- A page worker A fetched is **pinned**, so worker B's fetch can't evict it.
- Two workers **reading the same page** concurrently is safe (read-only; both pin, both unpin).
- Fetching **different pages**, the latch serializes only the brief bookkeeping and is released.

> Exactly one constraint: each worker **pins one page at a time**, so the pool must have at least `nworkers` frames (else a fetch can't find a victim and returns NULL). I spelled that out honestly in the header.

## 3. The Implementation — Per-Worker Local Results, Leader Merges

`src/parscan.c`. Each worker collects RIDs into its **own local result** — no cross-worker writes, so **no lock at all.**

```c
static void *worker_main(void *arg) {
    Worker *w = arg;
    for (page_id_t pid = w->lo; pid < w->hi; pid++) {   // only my block of pages
        void *page = bufpool_fetch(w->h->bp, pid);      // pin under the latch
        uint16_t n = slotpage_num_slots(page);
        for (uint16_t s = 0; s < n; s++) {
            const void *rec; uint16_t len;
            if (slotpage_get(page, s, &rec, &len) == 0)  // skip deleted slots
                if (!w->pred || w->pred((RID){pid,s}, rec, len, w->ctx))
                    result_push(&w->res, (RID){pid, s}); // local result (no lock)
        }
        bufpool_unpin(w->h->bp, pid, 0);
    }
    return NULL;
}
```

`parscan_collect` splits the page range into **contiguous blocks** (worker 0 = first block, …), spawns threads, and after `pthread_join` **merges in worker order.** Contiguous blocks + worker-order merge means the result comes out in the **same page order as a serial scan.**

![Parallel sequential scan: workers sweep disjoint page ranges concurrently over the thread-safe buffer pool; the leader merges in page order](/uploads/project/db-hobby/parallel-scan.svg)

The predicate (`pred`) is evaluated inline **while the page is pinned** (once unpinned, the `rec` pointer is invalid). `ctx` is contracted as "read-only shared," so workers calling it in parallel is safe.

## 4. Verification — Identical to Serial + No Races

`test_parscan` (new, 11 checks) checks two things.

**Correctness**: over 6,000 rows (18 pages) with a `key % 3 == 0` predicate, that **1·2·3·4·8·16 workers** all match serial `heap_scan` **down to the RID set and order.**

```
  info N=6000 rows over 18 pages
  ok   parallel scan (1 worker): identical RID set & order to serial
  ok   parallel scan (4 workers): identical RID set & order to serial
  ok   parallel scan (16 workers): identical RID set & order to serial
  ok   parallel full scan (pred=NULL, 8 workers): all N rows
  ok   nworkers=0 clamped (=1): identical to serial
```

**No races**: `test_parscan_tsan` (a ThreadSanitizer build) runs the same scenarios and confirms **zero data races.** That's the real evidence for the claim "read-only parallelism over the buffer pool latch is safe."

The whole suite is now **645 checks / 37 suites, FAIL 0.**

### Where the Win Comes From (Honestly)

The buffer pool latch serializes page fetches — on a cache miss, `pager_read` (disk I/O) happens under that latch too. So:

- **Cold cache**: disk I/O is serialized by the pool latch, so the win is small. Parallelizing I/O too (with per-page latching) is a finer-grained pool's job (frontier).
- **Warm cache** (the table fully resident): a fetch is just O(1) bookkeeping under the latch, and after it the **slot scan, predicate evaluation, and visibility checks run parallel across cores** — a big win. PostgreSQL's parallel scan also shines most on CPU-bound filters.

## 5. Frontiers Left

- **Not wired into the executor**: like [Part 22's cbtree](/blog/project/db-hobby/db-hobby-22-latch-crabbing) and [Part 27's lsm](/blog/project/db-hobby/db-hobby-27-lsm-engine), this module stands alone. Wiring it into `exec_select`'s scan path needs the workers' `decode_row`/`rec_visible`/result-collection made thread-safe (with the leader doing output) — the next foothold.
- **Full removal of engine_mtx**: the real goal is running **different transactions** at once, which needs the catalog, per-table WAL, and MVCC txn state all thread-safe. Layer by layer — the buffer pool (Track D) and this scan are early steps on a long road.
- **Parallel join/aggregate**: a parallel hash join and parallel aggregate follow naturally by feeding on this scan.

## 6. Wrap-up

- Faced the limit Part 19 left (`engine_mtx`) head-on — physical execution runs in one line.
- Started with the easiest layer to peel, the **read-only scan**: trivial page partitioning + no shared mutable state + a thread-safe buffer pool.
- **Per-worker local results → leader merge in page order** means no locks and results identical to serial.
- **Safety rests on the buffer pool latch**: fetch/unpin manage pin_count and eviction skips pinned frames — no races on read-only concurrent access (shown by ThreadSanitizer).
- Honest boundary: read-only scans only. Full removal of engine_mtx is the frontier — this laid the first foothold on the peel-it-layer-by-layer road.

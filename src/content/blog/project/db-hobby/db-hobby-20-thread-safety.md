---
title: '진짜 스레드를 켜다 — 단일 스레드 가정이 무너지는 곳, 버퍼 풀 latch'
titleEn: 'Turning On Real Threads — Where the Single-Threaded Assumption Collapses, and the Buffer Pool Latch'
description: "19편의 psql 서버는 여러 커넥션을 받았지만 단일 스레드 poll 루프라 진짜 병렬이 아니었다. 커넥션마다 OS 스레드를 띄우는 순간, 20편까지 '단일 스레드라 안전하다'고 공짜로 누리던 모든 가정이 무너진다 — 가장 먼저 깨지는 건 모든 계층이 밟고 선 버퍼 풀이다. 두 스레드가 같은 프레임 테이블을 동시에 건드리면 pin 카운트가 꼬이고 축출이 엉뚱한 페이지를 디스크에 쓴다. 이 편은 그 data race를 ThreadSanitizer로 잡아 보이고, 버퍼 풀에 latch를 달아 고친다. 핵심은 pin 프로토콜 — latch는 프레임 메타데이터만 지키고, 반환된 페이지 데이터 자체는 pin(pin>0이면 축출 불가)이 지킨다는 분업이다. 그리고 서버를 커넥션당 스레드로 바꿔 진짜 psql 두 개가 OS 스레드로 붙게 하되, 실행은 아직 굵은 엔진 latch로 직렬화한다는 한계와, 그 latch를 계층별로 걷어내는 것이 다음 프론티어(B+Tree crabbing, 블로킹 락 매니저)임을 정직하게 짚는다."
descriptionEn: "Part 19's psql server accepted many connections but was a single-threaded poll loop — not truly parallel. The moment you spawn an OS thread per connection, every assumption we'd enjoyed for free through Part 20 ('safe because single-threaded') collapses — and the first thing to break is the buffer pool, which every layer stands on. Two threads touching the same frame table corrupt pin counts and let eviction write the wrong page to disk. This part catches that data race with ThreadSanitizer and fixes it with a latch on the buffer pool. The key is the pin protocol — the latch guards only the frame metadata, while the returned page data itself is guarded by the pin (a pinned frame can't be evicted). We switch the server to thread-per-connection so two real psql clients attach as OS threads, while being honest that execution is still serialized by one coarse engine latch, and that peeling that latch off layer by layer (B+Tree crabbing, a blocking lock manager) is the next frontier."
date: 2026-07-03
tags:
  - C
  - Database Internals
  - Concurrency
  - Threads
  - Buffer Pool
  - ThreadSanitizer
  - Learning
category: study/db-hobby
coverImage: /uploads/project/db-hobby/cover.svg
draft: false
series: "db-hobby"
seriesOrder: 20
---

## 0. 들어가며 — 19편이 남긴 빚

[19편](/blog/project/db-hobby/db-hobby-19-wire-protocol)에서 db-hobby에 진짜 psql이 붙었어요. 그런데 그 서버엔 정직하게 적어 둔 한계가 있었죠 — **단일 스레드 `poll()` 루프**. 커넥션을 여러 개 받고 세션으로 인터리브하지만, 한 순간엔 한 쿼리만 돌아요. CPU가 여러 개인데 하나만 쓰고, 무거운 쿼리 하나가 다른 모든 커넥션을 막습니다.

이번 편은 그 빚을 갚습니다 — **커넥션마다 진짜 OS 스레드**를 띄워요. 그런데 그 순간, [1편](/blog/project/db-hobby/db-hobby-1-storage)부터 20편까지 우리가 **공짜로 누려 온 가정**이 통째로 무너집니다: "단일 스레드니까 자료구조를 아무렇게나 건드려도 안전하다."

## 1. 장애 — 가장 먼저 깨지는 건 버퍼 풀이다

스레드를 켜면 어디가 먼저 깨질까요? **버퍼 풀**입니다 — SELECT든 INSERT든 B+Tree 탐색이든, 모든 연산이 페이지를 읽으려면 반드시 버퍼 풀을 거치니까요([1편](/blog/project/db-hobby/db-hobby-1-storage)). 모든 계층이 밟고 선 바닥이에요.

버퍼 풀의 `fetch`를 다시 보면, 스레드 둘이 동시에 부르면 터지는 곳이 한눈에 보입니다.

```c
void *bufpool_fetch(BufferPool *bp, page_id_t page_id) {
    Frame *f = find_frame(bp, page_id);
    if (f) {
        bp->hits++;              /* ← 둘이 동시에 증가시키면 하나를 잃는다 */
        f->pin_count++;          /* ← pin 카운트가 꼬인다: 축출 보호가 깨짐 */
        f->last_used = ++bp->clock;
        return f->data;
    }
    f = pick_frame(bp);          /* ← 둘이 같은 victim을 골라 같은 프레임에 서로 다른 페이지를 로드 */
    ...
}
```

`pin_count++`가 원자적이지 않으면, 두 스레드가 각자 pin을 걸었는데 카운트는 1만 오를 수 있어요. 그럼 한쪽이 `unpin`할 때 카운트가 0이 되고, 그 페이지를 아직 쓰고 있는 다른 스레드 밑에서 **프레임이 축출**됩니다 — 쓰던 데이터가 디스크의 딴 페이지로 갈리고, 엉뚱한 페이지가 그 프레임에 올라와요. 데이터 교차 오염입니다.

이건 추측이 아니라 **측정 가능한 사실**이에요. `ThreadSanitizer`(TSan)로 컴파일해 스레드 스트레스 테스트를 돌리면, latch 없는 버퍼 풀은 `WARNING: ThreadSanitizer: data race on Frame::pin_count` 같은 경고를 쏟아냅니다.

## 2. 해결 — latch, 그리고 pin 프로토콜의 분업

고치는 방법은 단순해요 — 버퍼 풀에 **latch**(mutex)를 달아 프레임 테이블을 건드리는 모든 연산을 임계구역으로 감쌉니다.

```c
struct BufferPool {
    ...
    pthread_mutex_t latch;   /* 프레임 테이블(메타데이터)을 보호 */
};

void *bufpool_fetch(BufferPool *bp, page_id_t page_id) {
    pthread_mutex_lock(&bp->latch);
    Frame *f = fetch_locked(bp, page_id);   /* find/pick/load/pin 전부 latch 안 */
    void *ret = f ? f->data : NULL;
    pthread_mutex_unlock(&bp->latch);
    return ret;                             /* ← 반환된 데이터는 latch 밖에서 쓴다 */
}
```

여기서 이 편의 핵심 통찰이 나옵니다. **latch를 풀고 반환한 `f->data`를, 호출자는 latch 없이 씁니다.** 그동안 다른 스레드가 그 프레임을 축출해 버리면 어떡하죠?

**축출되지 않습니다 — pin이 막으니까요.** `fetch`는 pin을 걸고 반환하고, `pick_frame`은 `pin_count != 0`인 프레임을 victim으로 절대 안 고릅니다. 즉 **분업**이에요:

- **latch**는 프레임 *메타데이터*(pin 카운트, valid/dirty, LRU 시계, page↔frame 매핑)를 지킨다.
- **pin**은 반환된 *페이지 데이터*를 지킨다 — pin된 프레임은 축출 대상이 아니므로, latch 밖에서 오래 읽고 써도 그 자리에 그대로 있다.

이게 **pin 프로토콜**입니다. 이 분업 덕에, 무거운 연산(B+Tree 한 페이지를 붙들고 오래 처리)이 버퍼 풀 latch를 오래 쥐지 않아요 — pin만 잡고 latch는 즉시 놓습니다. 진짜 DB(PostgreSQL의 buffer pin + content lock, InnoDB의 buf_page pin)가 정확히 이 두 겹 구조를 씁니다.

> **정직한 단순화**: db-hobby는 디스크 I/O(`pager_read`/`pager_write`)도 latch 안에서 합니다 — I/O가 직렬화돼 느리지만 코드가 단순하고 정확해요. 진짜 DB는 "read-in-progress" 상태를 두어 I/O를 latch 밖으로 빼고 그동안 다른 스레드가 다른 페이지를 처리하게 합니다. 그건 상태 기계가 복잡해지는 최적화라 이 편의 범위 밖이에요.

## 3. 증명 — ThreadSanitizer로 "레이스 없음"을 계측한다

동시성 코드에서 "테스트가 통과했다"는 약한 증거예요 — 레이스는 대부분의 실행에서 안 터지고 어쩌다 한 번 터지니까요. 그래서 **ThreadSanitizer**로 레이스 자체를 계측했습니다. 스트레스 테스트는 프레임(16개)보다 훨씬 많은 페이지(300개)를 두어 축출이 끊임없이 일어나는 상황에서, 8스레드가 동시에 두들깁니다.

```
$ make test-tsan     # -fsanitize=thread로 빌드해 실행
  ok   동시 읽기 40000×8: 항상 그 페이지의 데이터 (교차 오염 0)
  ok   hit+miss 카운트가 최소 전체 접근 수 이상 (원자적 갱신)
  ok   읽기 폭풍 뒤 모든 페이지 재조회 성공 (pin 누수 없음)
  ok   동시 쓰기 뒤 디스크의 모든 페이지 스탬프 정확 (축출/flush 무결성)

전체 통과       ← ThreadSanitizer 경고 0
```

테스트가 검증하는 계약은 두 가지예요.

- **교차 오염 0** — 각 페이지엔 자기 `page_id`가 스탬프돼 있고, 축출 폭풍 속에서도 `fetch(p)`는 **항상 페이지 p의 데이터**를 돌려준다. 프레임이 레이스로 뒤섞이면 이게 깨집니다.
- **디스크 무결성** — 스레드마다 *서로 다른* 페이지에 쓰고(같은 페이지 내용의 동시 쓰기 직렬화는 버퍼 풀이 아니라 상위 계층의 몫이니까), 축출·flush를 거친 뒤 디스크에서 직접 읽어 모든 스탬프가 온전한지 확인한다.

TSan이 경고를 안 냈다는 건, 단지 "이번엔 안 터졌다"가 아니라 **관측된 실행에 data race가 실제로 없었다**는 뜻입니다. 훨씬 강한 증거예요.

## 4. 서버 — 커넥션당 진짜 스레드

버퍼 풀이 스레드 안전해졌으니, 19편의 `poll()` 루프를 **커넥션당 OS 스레드**로 바꿉니다.

```c
for (;;) {
    int cfd = accept(lfd, NULL, NULL);
    int sess = 세션_배정();                 /* 세션 테이블은 별도 mutex로 보호 */
    pthread_create(&th, NULL, conn_thread, arg);  /* 커넥션마다 스레드 하나 */
    pthread_detach(th);
}
```

각 스레드가 자기 커넥션의 startup 핸드셰이크와 네트워크 I/O를 **진짜 병렬로** 처리해요. 느린 클라이언트가 자기 메시지를 질질 보내도, 다른 커넥션의 스레드는 멀쩡히 돕니다 — 19편의 "느린 클라 하나가 서버 전체를 막는" 한계가 사라졌어요.

하지만 여기서 정직해야 합니다. **SQL 실행 자체는 아직 하나의 굵은 엔진 latch로 직렬화**합니다.

```c
pthread_mutex_lock(&engine_mtx);
db->cur_session = sess;      /* 이 커넥션의 세션 */
db_exec(db, query, out);     /* 한 번에 한 쿼리만 */
pthread_mutex_unlock(&engine_mtx);
```

왜냐면 실행기 전 계층(B+Tree 루트 포인터, 카탈로그, 트랜잭션 로그, 락 매니저…)이 아직 스레드 안전하지 않거든요. 전부 "단일 스레드라 안전"을 가정하고 짰으니까요. 그래서 **우선 한 개의 굵은 latch로 정확성을 삽니다** — 이건 부끄러운 게 아니라 실제 시스템이 동시성을 도입하는 정석적인 첫 단계예요(SQLite가 오래 이렇게 동작했죠). 그리고 방금 만든 **버퍼 풀 latch가, 이 굵은 latch를 계층별로 걷어낼 첫 발판**입니다.

## 5. 그래서 — 진짜 스레드로 붙는 두 psql

19편의 인터리브 데모를, 이제 **진짜 커넥션당 스레드** 서버로 다시 돌립니다. 겉보기 동작은 같지만, 두 psql이 각자 OS 스레드에 얹혀 있어요.

```
$ ./build/db-hobby my.db --serve 5433
db-hobby: 127.0.0.1:5433 에서 대기 중 (커넥션당 스레드) ...
```

**터미널 A**: `BEGIN; UPDATE t SET v=999 WHERE id=1;` (미커밋)
**터미널 B** (다른 스레드):
```
db-hobby=> SELECT * FROM t WHERE id = 1;
 1 | 100                         -- 안 막힘. 스냅샷의 옛 버전
db-hobby=> UPDATE t SET v = 555 WHERE id = 1;
ERROR:  테이블 't'가 다른 트랜잭션에 잠겨 있습니다 (쓰기 충돌)
```
A가 `COMMIT` 하면 B는 999를 봅니다. 이것도 실제 psql 두 개를 스레드 서버에 붙여 잡은 출력이에요. 실행은 직렬이지만 네트워크·세션은 진짜 병렬 — 그리고 그 밑에서 **버퍼 풀은 여러 스레드가 동시에 두들겨도 안 깨지는** 상태가 됐습니다.

## 6. 정리 — 그리고 굵은 latch를 걷어내는 길

| 항목 | db-hobby | 비고 |
|---|---|---|
| 버퍼 풀 스레드 안전 (D1) | O | 풀별 latch + pin 프로토콜, **TSan 클린** |
| 커넥션당 스레드 서버 (D4 부분) | O | 진짜 OS 스레드, psql로 검증 |
| 엔진 실행 직렬화 | 굵은 latch | 정확하지만 병렬 아님 — 첫 단계 |
| B+Tree latch crabbing (D2) | X | 루트→리프 lock coupling — 다음 계층 |
| 블로킹 락 매니저 (D3) | X | 엔진 latch 걷어낸 뒤에야 의미 |

이 편은 "진짜 스레드를 켜면 무엇이 깨지는가"를 버퍼 풀에서 직면하고, latch + pin 프로토콜로 고쳤습니다. 그리고 `ThreadSanitizer`로 "레이스 없음"을 계측했어요 — 동시성에서 통과보다 강한 증거를요.

남은 길은 명확합니다. 지금의 **굵은 엔진 latch를 계층별로 걷어내는 것** — B+Tree에 latch crabbing을 달아(루트→리프로 내려가며 안전하면 조상 latch를 조기 해제) 트리 탐색이 병렬로 돌게 하고, 락 매니저를 "즉시 거부"에서 "대기 큐 + 조건변수 블로킹"으로 바꿔([11편](/blog/project/db-hobby/db-hobby-11-isolation)의 wait-for 교착 탐지가 그제야 진짜로 필요해집니다) 진짜 동시 실행으로 가는 거예요. 버퍼 풀이 그 첫 계단을 놓았습니다.

> **한 줄 요약**: 좋은 동시성은 "큰 락 하나로 정확성을 사고, 계층마다 그 락을 잘게 쪼개 병렬성을 되사는" 과정입니다. db-hobby는 지금 첫 문장 — 정확성 — 을 마쳤고, 그 밑바닥(버퍼 풀)부터 락을 쪼개기 시작했어요.

![스레드 안전 버퍼 풀 — 여러 커넥션 스레드가 동시에 fetch하면 latch가 프레임 메타데이터(pin·LRU·매핑)를 임계구역으로 지키고, 반환된 페이지 데이터는 pin(pin>0이면 축출 불가)이 latch 밖에서 지킨다. 실행은 아직 굵은 엔진 latch로 직렬화 — 버퍼 풀 latch가 그걸 걷어낼 첫 발판](/uploads/project/db-hobby/thread-safe-bufpool.svg)

## 참고

- [PostgreSQL: Buffer Manager (pin, content lock)](https://www.interdb.jp/pg/pgsql08.html)
- [CMU 15-445 Database Systems — Project 1 (Buffer Pool Manager), latching](https://15445.courses.cs.cmu.edu/)
- [ThreadSanitizer (Clang) — data race detection](https://clang.llvm.org/docs/ThreadSanitizer.html)
- 본 시리즈: [1편 저장·버퍼 풀](/blog/project/db-hobby/db-hobby-1-storage) · [11편 2PL](/blog/project/db-hobby/db-hobby-11-isolation) · [19편 wire protocol 서버](/blog/project/db-hobby/db-hobby-19-wire-protocol)

<!-- EN -->

## 0. Introduction — the Debt Part 19 Left

In [Part 19](/blog/project/db-hobby/db-hobby-19-wire-protocol), a real psql connected to db-hobby. But that server had an honestly-noted limit — a **single-threaded `poll()` loop**. It accepts many connections and interleaves them by session, but runs one query at any instant. With several CPUs, it uses one, and one heavy query blocks every other connection.

This part pays that debt — **a real OS thread per connection**. And the moment you do, an assumption we'd enjoyed for free from [Part 1](/blog/project/db-hobby/db-hobby-1-storage) through Part 20 collapses wholesale: "single-threaded, so I can touch data structures however I like."

## 1. The Failure — the Buffer Pool Breaks First

Turn on threads, and what breaks first? The **buffer pool** — every operation, SELECT or INSERT or B+Tree descent, must go through it to read a page ([Part 1](/blog/project/db-hobby/db-hobby-1-storage)). It's the floor every layer stands on.

Look again at the buffer pool's `fetch`, and the spot that explodes under two concurrent callers is obvious.

```c
void *bufpool_fetch(BufferPool *bp, page_id_t page_id) {
    Frame *f = find_frame(bp, page_id);
    if (f) {
        bp->hits++;              /* ← two concurrent increments lose one */
        f->pin_count++;          /* ← pin count corrupts: eviction protection breaks */
        f->last_used = ++bp->clock;
        return f->data;
    }
    f = pick_frame(bp);          /* ← two threads pick the same victim, load different pages into it */
    ...
}
```

If `pin_count++` isn't atomic, two threads each add a pin but the count rises by only one. Then when one `unpin`s, the count hits zero, and the frame gets **evicted out from under** the other thread still using that page — its data goes to the wrong disk page, and a different page loads into that frame. Cross-contamination.

This isn't speculation — it's **measurable**. Compile with `ThreadSanitizer` (TSan) and run a threaded stress test, and the latch-less buffer pool pours out `WARNING: ThreadSanitizer: data race on Frame::pin_count`.

## 2. The Fix — a Latch, and the Division of Labor in the Pin Protocol

The fix is simple — put a **latch** (mutex) on the buffer pool and wrap every frame-table operation in a critical section.

```c
struct BufferPool {
    ...
    pthread_mutex_t latch;   /* guards the frame table (metadata) */
};

void *bufpool_fetch(BufferPool *bp, page_id_t page_id) {
    pthread_mutex_lock(&bp->latch);
    Frame *f = fetch_locked(bp, page_id);   /* find/pick/load/pin all under the latch */
    void *ret = f ? f->data : NULL;
    pthread_mutex_unlock(&bp->latch);
    return ret;                             /* ← the returned data is used outside the latch */
}
```

Here's this part's key insight. **The caller uses the returned `f->data` with the latch released.** What if another thread evicts that frame meanwhile?

**It can't — the pin prevents it.** `fetch` returns with a pin held, and `pick_frame` never chooses a frame with `pin_count != 0` as a victim. So it's a **division of labor**:

- The **latch** guards the frame *metadata* (pin count, valid/dirty, the LRU clock, the page↔frame mapping).
- The **pin** guards the returned *page data* — a pinned frame isn't an eviction candidate, so you can read and write it outside the latch for a long time and it stays put.

This is the **pin protocol**. Thanks to this split, a heavy operation (holding a B+Tree page and processing it for a while) doesn't hold the buffer-pool latch for long — it holds only the pin and releases the latch immediately. Real databases (PostgreSQL's buffer pin + content lock, InnoDB's buf_page pin) use exactly this two-layer structure.

> **Honest simplification**: db-hobby does disk I/O (`pager_read`/`pager_write`) inside the latch too — I/O serializes and slows down, but the code is simple and correct. Real databases keep a "read-in-progress" state to move I/O outside the latch and let other threads work other pages meanwhile. That's a state-machine complication, out of scope here.

## 3. Proof — Measuring "No Races" with ThreadSanitizer

In concurrent code, "the test passed" is weak evidence — races don't fire in most runs, only occasionally. So we measured the races themselves with **ThreadSanitizer**. The stress test keeps far more pages (300) than frames (16), so eviction is constant, and 8 threads hammer it at once.

```
$ make test-tsan     # build with -fsanitize=thread and run
  ok   concurrent reads 40000×8: always THAT page's data (zero cross-contamination)
  ok   hit+miss count is at least the total accesses (atomic updates)
  ok   after the read storm, every page re-fetches (no pin leak)
  ok   after concurrent writes, every page's stamp on disk is correct (eviction/flush integrity)

all passed       ← zero ThreadSanitizer warnings
```

The test verifies two contracts:

- **Zero cross-contamination** — each page is stamped with its own `page_id`, and even in the eviction storm `fetch(p)` **always returns page p's data**. If frames get scrambled by a race, this breaks.
- **Disk integrity** — each thread writes *different* pages (serializing concurrent writes to the same page's content is the upper layer's job, not the buffer pool's), and after eviction and flush we read straight from disk to check every stamp survived.

TSan raising no warning means not "it didn't break this time" but **there was genuinely no data race in the observed execution** — far stronger evidence.

## 4. The Server — a Real Thread per Connection

With the buffer pool thread-safe, we swap Part 19's `poll()` loop for **one OS thread per connection**.

```c
for (;;) {
    int cfd = accept(lfd, NULL, NULL);
    int sess = assign_session();            /* the session table has its own mutex */
    pthread_create(&th, NULL, conn_thread, arg);  /* a thread per connection */
    pthread_detach(th);
}
```

Each thread handles its connection's startup handshake and network I/O **truly in parallel**. A slow client dribbling out its message no longer freezes the others — Part 19's "one slow client blocks the whole server" is gone.

But we must be honest. **SQL execution itself is still serialized by one coarse engine latch.**

```c
pthread_mutex_lock(&engine_mtx);
db->cur_session = sess;      /* this connection's session */
db_exec(db, query, out);     /* one query at a time */
pthread_mutex_unlock(&engine_mtx);
```

Because every executor layer (the B+Tree root pointer, the catalog, the transaction log, the lock manager…) isn't thread-safe yet — all written assuming a single thread. So we **buy correctness first with one coarse latch** — not shameful but the textbook first step for introducing concurrency (SQLite worked this way for a long time). And the **buffer pool latch we just built is the first foothold for peeling that coarse latch off, layer by layer.**

## 5. So — Two psql Clients on Real Threads

We rerun Part 19's interleave demo on the now truly-thread-per-connection server. The visible behavior is the same, but the two psql clients ride on separate OS threads.

```
$ ./build/db-hobby my.db --serve 5433
db-hobby: waiting on 127.0.0.1:5433 (thread per connection) ...
```

**Terminal A**: `BEGIN; UPDATE t SET v=999 WHERE id=1;` (uncommitted)
**Terminal B** (another thread):
```
db-hobby=> SELECT * FROM t WHERE id = 1;
 1 | 100                         -- not blocked. the old version from the snapshot
db-hobby=> UPDATE t SET v = 555 WHERE id = 1;
ERROR:  table 't' is locked by another transaction (write conflict)
```
When A `COMMIT`s, B sees 999. Again, actual output from two real psql clients on the threaded server. Execution is serial, but the network and sessions are truly parallel — and beneath them, the **buffer pool now survives being hammered by many threads at once.**

## 6. Wrap-up — and the Path to Peeling Off the Coarse Latch

| Item | db-hobby | Note |
|---|---|---|
| Buffer pool thread safety (D1) | O | per-pool latch + pin protocol, **TSan-clean** |
| Thread-per-connection server (part of D4) | O | real OS threads, verified with psql |
| Engine execution serialization | coarse latch | correct but not parallel — the first step |
| B+Tree latch crabbing (D2) | X | root→leaf lock coupling — the next layer |
| Blocking lock manager (D3) | X | meaningful only after the engine latch is gone |

This part faced "what breaks when you turn on real threads" at the buffer pool and fixed it with a latch plus the pin protocol. And it measured "no races" with `ThreadSanitizer` — stronger evidence than a passing test.

The path ahead is clear: **peel the coarse engine latch off, layer by layer** — add latch crabbing to the B+Tree (descend root→leaf, releasing ancestor latches early when it's safe) so tree traversal runs in parallel, and change the lock manager from "reject immediately" to "wait queue + condition-variable blocking" (at which point [Part 11](/blog/project/db-hobby/db-hobby-11-isolation)'s wait-for deadlock detection finally becomes truly necessary), moving toward real concurrent execution. The buffer pool laid that first step.

> **One-line summary**: good concurrency is the process of "buying correctness with one big lock, then buying parallelism back by splitting that lock finer at each layer." db-hobby has finished the first clause — correctness — and started splitting the lock from the very bottom, the buffer pool.

![Thread-safe buffer pool — when many connection threads fetch at once, the latch guards the frame metadata (pin, LRU, mapping) in a critical section, while the returned page data is guarded outside the latch by the pin (a pinned frame can't be evicted). Execution is still serialized by one coarse engine latch — the buffer pool latch is the first foothold for peeling it off](/uploads/project/db-hobby/thread-safe-bufpool.svg)

## References

- [PostgreSQL: Buffer Manager (pin, content lock)](https://www.interdb.jp/pg/pgsql08.html)
- [CMU 15-445 Database Systems — Project 1 (Buffer Pool Manager), latching](https://15445.courses.cs.cmu.edu/)
- [ThreadSanitizer (Clang) — data race detection](https://clang.llvm.org/docs/ThreadSanitizer.html)
- This series: [Part 1 Storage & Buffer Pool](/blog/project/db-hobby/db-hobby-1-storage) · [Part 11 2PL](/blog/project/db-hobby/db-hobby-11-isolation) · [Part 19 Wire Protocol Server](/blog/project/db-hobby/db-hobby-19-wire-protocol)

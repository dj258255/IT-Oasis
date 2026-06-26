---
title: '격리는 어떻게 구현되는가 — 단일 스레드 DB에서 트랜잭션 사이를 지키기'
titleEn: 'How Is Isolation Implemented? — Guarding Between Transactions in a Single-Threaded DB'
description: "관계형 DB를 C로 밑바닥부터 만든 minidb 시리즈 11편. 4편에서 '안 만든 가장 어려운 절반'이라고 인정했던 ACID의 I(격리)를 만듭니다. minidb는 단일 스레드라 진짜 동시성이 없는데 무엇을 격리하나 — 그 긴장이 설계를 정합니다. 인터리브된 in-process 트랜잭션 + 2PL 테이블 락으로, 충돌을 (블록 대신) 거부해 dirty read와 lost update를 막고, wait-for 그래프로 교착(deadlock) 순환을 탐지합니다. S/X 호환 행렬, rigorous 2PL, 거부 vs 블록, 그리고 2PL vs MVCC를 표로 비교하며 실제 코드로 짚습니다."
descriptionEn: "Part 11 of building a relational database from scratch in C. We build the I in ACID (isolation) — the half Part 4 admitted was the hardest and left out. minidb is single-threaded, so what is there to isolate? That tension drives the design: interleaved in-process transactions plus 2PL table locks, where a conflict is rejected (not blocked on) to prevent dirty reads and lost updates, and a wait-for graph detects deadlock cycles. We compare the S/X matrix, rigorous 2PL, reject vs block, and 2PL vs MVCC in tables, grounded in real code."
date: 2026-06-13
tags:
  - C
  - Database Internals
  - Transactions
  - Concurrency
  - Locking
  - Learning
category: project/minidb
coverImage: /uploads/project/minidb/cover.svg
draft: false
series: "minidb"
seriesOrder: 11
---

## 0. 들어가며 — 가장 어려운 절반

[4편](/blog/project/minidb/minidb-4-transactions)에서 ACID 중 A(원자성)와 D(내구성)는 만들었지만, **I(격리)는 "안 만든 가장 어려운 절반"이라고 솔직히 적었어요.** 이번 편은 그 절반을 만듭니다.

그런데 시작하자마자 벽에 부딪혀요 — minidb는 단일 스레드입니다. 트랜잭션이 한 번에 하나씩만 도는데, **대체 무엇을 격리하나?** 이 질문이 이 글의 설계를 전부 정했어요. 그래서 이 편은 "락을 어떻게 짜느냐"보다 **"단일 스레드라는 제약이 격리를 어떻게 비추는가"** 를 따라갑니다.

> **이번 편의 목표**: 인터리브된 in-process 트랜잭션 사이의 충돌을 2PL 테이블 락으로 잡아 dirty read·lost update를 막고, wait-for 그래프로 교착을 탐지하기까지. 진짜 동시성(MVCC)은 아니지만, 격리의 **메커니즘** 자체를 손으로 만져 봅니다. 실제 코드는 [`lock.c`](https://github.com/dj258255/minidb)와 실행기 배선([`db.c`](https://github.com/dj258255/minidb))입니다.

## 1. 단일 스레드인데 격리할 게 있나

격리는 본질적으로 **트랜잭션 "사이"** 의 문제예요. T1이 어떤 행을 고치는 도중에 T2가 그 행을 읽으면 안 되고(dirty read), 둘이 같은 값을 동시에 고치면 한쪽 수정이 사라지면 안 됩니다(lost update). 이런 이상현상은 두 트랜잭션이 **겹쳐 돌 때만** 생겨요. 그런데 minidb는 트랜잭션을 하나씩만 도니, 겹칠 일이 없어 격리할 것도 없어 보입니다.

게다가 더 깊은 문제가 있었어요. [3편·4편의 WAL](/blog/project/minidb/minidb-4-transactions)은 "커밋 시 그 테이블의 dirty 페이지를 **전부** flush"하는 모델입니다. 만약 두 트랜잭션이 같은 테이블에 동시에 쓰면, 한쪽이 커밋할 때 다른 쪽의 미완성 변경까지 디스크에 박혀요. 즉 **저장 계층부터가 "한 테이블에 writer 하나"를 전제로** 짜여 있었습니다.

진짜 동시 쓰기를 지원하려면 행 버전 관리(MVCC)나 undo 로그(ARIES)가 필요한데, 그건 엔진을 통째로 다시 쓰는 일이에요. 그래서 방향을 정했습니다.

> **설계 결정**: 진짜 OS 동시성을 흉내 내는 대신, **인터리브된 in-process 트랜잭션 사이의 충돌을 "감지"** 하는 데 집중한다. T1을 좀 진행하고, T2를 좀 진행하고 — 이렇게 번갈아 도는 두 논리적 트랜잭션이 같은 자원을 건드리면 막는다.

이게 격리의 핵심인 **충돌 직렬화**예요. "동시에 도는 것처럼 보이지만 실제로는 줄 세운다"는 게 격리의 본질이니까요.

## 2. 락 매니저 — 충돌 행렬이 전부다

격리의 고전적 도구는 **락**입니다. 읽으려면 공유 락(S, Shared), 쓰려면 배타 락(X, eXclusive)을 잡아요. 규칙은 작은 호환 행렬 하나가 전부입니다.

| | 보유 S | 보유 X |
|---|---|---|
| **요청 S** | OK | 충돌 |
| **요청 X** | 충돌 | 충돌 |

읽기끼리(S-S)는 호환돼요 — 여러 트랜잭션이 같은 걸 동시에 읽어도 안전하니까요. 하지만 쓰기(X)는 누구와도 충돌합니다 — 쓰는 중인 걸 읽거나 같이 쓰면 위험하니까요. 같은 트랜잭션은 자기 자신과 충돌하지 않고, S를 쥔 채 X로 올리는 **업그레이드**는 다른 보유자가 없을 때만 됩니다.

이걸 `(테이블, 키)` 단위로 추적하는 작은 락 매니저로 만들었어요. 핵심은 `lock_acquire` 한 함수에 다 들어 있습니다 — 같은 트랜잭션이 이미 쥔 락을 찾고, 다른 트랜잭션들의 락 모드를 모은 뒤, 위 행렬로 판정해요.

```c
int lock_acquire(LockManager *lm, int txn, const char *table, long key, LockMode mode) {
    /* 1) 같은 txn이 이미 쥔 락을 찾고, 다른 txn의 락 모드(S/X)를 모은다. */
    LockEntry *mine = NULL;
    int other_s = 0, other_x = 0;
    /* ... 루프: e->txn == txn 이면 mine, 아니면 other_s/other_x 표시 ... */

    if (mine) {                                  /* 이미 보유 중 */
        if (mode == LOCK_S || mine->mode == LOCK_X) return 0;   /* 충분함 */
        if (other_s || other_x) return -1;       /* S->X 업그레이드: 단독일 때만 */
        mine->mode = LOCK_X;
        return 0;
    }
    /* 2) 새 락: 호환 행렬 검사 */
    if (mode == LOCK_X && (other_s || other_x)) return -1;  /* 쓰기는 누구와도 충돌 */
    if (mode == LOCK_S && other_x) return -1;              /* 읽기는 X와 충돌 */
    /* 3) 부여: 빈 칸에 기록 */
    /* ... */
    return 0;
}
```

충돌이면 **블록하지 않고 `-1`** 을 돌려준다는 게 핵심입니다(왜 그런지는 다음 절). 그리고 **락 단위를 테이블로 잡은 건 우연이 아니에요.**

> **설계 선택 — 왜 테이블 단위 락인가**: 앞 절의 WAL 제약("한 테이블에 writer 하나") 때문이다. 테이블 X 락이 그걸 강제하니, **저장 계층을 한 줄도 안 고치고** 격리를 얹을 수 있었다. 행 단위 락이 더 세밀하지만, 그러면 같은 테이블에 두 writer가 생겨 WAL이 깨진다. "세밀함(행 락) vs 저장 계층 불변(테이블 락)"의 트레이드오프에서, minidb는 토대를 안 건드리는 쪽을 골랐다.

## 3. 거부, 블록이 아니라

이제 락을 실행기에 연결합니다. `INSERT`/`UPDATE`/`DELETE`는 그 테이블에 X 락을, `SELECT`는 S 락을 잡아요. 명시적 트랜잭션(`BEGIN`)이면 그 락을 — 읽기(S)든 쓰기(X)든 — **`COMMIT`/`ROLLBACK`까지 쥡니다.** autocommit 문장이면 문장 끝에 바로 풀고요. X뿐 아니라 S까지 끝까지 쥐므로, 정확히는 strict 2PL보다 한 단계 강한 **rigorous 2PL(strong strict 2PL)** 이에요 — strict 2PL은 X(쓰기) 락만 커밋까지 유지하고 S(읽기)는 더 일찍 풀 수도 있는 변형입니다.

실행기 배선([`db.c`](https://github.com/dj258255/minidb))은 이렇게 갈려요.

```c
/* 격리(2PL): 명시적 트랜잭션이면 그 txn id로 잡아 COMMIT/ROLLBACK까지 쥐고,
 * autocommit이면 임시 id로 잡았다가 문장 끝에 푼다. */
lock_txn = db->in_txn ? db->cur_txn : db->next_txn++;
lock_autorelease = !db->in_txn;
if (acquire_stmt_locks(db, &st, lock_txn, out) != 0) {  /* 충돌이면 여기서 거부 */
    if (lock_autorelease) lock_release_all(&db->lm, lock_txn);
    statement_free(&st);
    return -1;                                            /* 문장이 ERROR로 떨어짐 */
}
```

여기서 단일 스레드의 특성이 드러나요. 진짜 DB라면 충돌하는 락은 **블록**됩니다 — 앞 트랜잭션이 풀 때까지 기다려요. 그런데 minidb엔 기다릴 스레드가 없습니다. 그래서 충돌을 **거부**로 바꿨어요 — 락을 못 잡으면 그 문장이 `ERROR`로 떨어집니다.

| | 진짜 DB (블록) | minidb (거부) |
|---|---|---|
| 충돌 시 | 앞 트랜잭션이 풀 때까지 대기 | 즉시 `ERROR` 반환 |
| 필요한 것 | 대기할 스레드 | 없음(단일 스레드) |
| 교착 가능성 | 있음(대기 순환) | **없음**(대기가 없음) |
| 충돌 직렬화 | 대기로 줄 세움 | 거부로 줄 세움 (목적은 같지만 사용자는 재시도해야) |

이걸로 진짜 엔진에서 격리를 시연할 수 있어요. 다른 트랜잭션(T99)이 테이블 `t`에 X 락을 쥔 상황을 만들어 두고:

```sql
-- T99가 t를 쓰는 중(X 락 보유)
SELECT * FROM t WHERE id = 1;   -- ERROR: t가 잠겨 있습니다 (읽기 충돌)
INSERT INTO t VALUES (3, 30);   -- ERROR: t가 잠겨 있습니다 (쓰기 충돌)
```

각 거부가 정확히 어떤 이상현상을 막는지 정리하면:

| 이상현상 | 상황 | 무엇이 막나 |
|---|---|---|
| **dirty read** | T99가 쓰는 테이블을 다른 트랜잭션이 읽으려 함 | S 요청이 X와 충돌 -> 거부 (커밋 안 된 값을 못 봄) |
| **lost update** | 같은 테이블에 두 트랜잭션이 쓰려 함 | X 요청이 X와 충돌 -> 거부 (한쪽 쓰기가 사라지지 않음) |
| (이상현상 아님) | T99가 S만 쥐고, 다른 `SELECT`가 읽으려 함 | S-S 호환 -> 통과 (reader는 reader를 안 막음) |

경합이 없을 땐 락이 완전히 투명해서, 격리를 붙이기 전의 [테스트 300여 개](/blog/project/minidb/minidb-1-storage)가 한 줄도 안 깨졌어요.

> 더 깊이: 격리 수준(Read Committed, Repeatable Read 등)과 dirty read·lost update·write skew 같은 이상현상이 무엇인지는 [트랜잭션 ACID ②: Isolation은 어떻게 구현되는가](/blog/theory/transaction-acid-02-isolation). 락 자체가 하드웨어부터 분산까지 어떻게 작동하는지는 [락 메커니즘의 모든 것](/blog/theory/lock-mechanisms-all).

## 4. 교착 — 거부 모델엔 없지만, 있어야 할 것

여기서 흥미로운 일이 생깁니다. **거부 모델에선 교착(deadlock)이 아예 안 생겨요.** 교착은 T1이 A를 쥐고 B를 기다리고, T2가 B를 쥐고 A를 기다리며 서로 영원히 못 푸는 상황인데 — minidb는 "기다림"이 없습니다. 못 잡으면 즉시 거부하니, 순환이 만들어질 틈이 없어요.

그래도 교착 탐지를 만들었어요. **"만약 거부 대신 기다린다면" 필요해지는 것**을 보이기 위해서입니다. 누가 누구를 기다리는지를 그래프로 적어요 — **wait-for 그래프**. T1이 (T2가 쥔) B를 기다리면 `T1 -> T2` 간선을 긋습니다. 이 그래프에 **순환**이 있으면 교착이에요.

![wait-for 그래프 — T1⇄T2 2중 순환과 T1→T2→T3→T1 3중 순환은 둘 다 교착](/uploads/project/minidb/wait-for-graph.svg)

순환은 DFS로 찾아요. `dfs_cycle`이 경로(`path`)를 따라가다 같은 트랜잭션이 다시 나오면 순환으로 판정해 그 victim을 돌려줍니다.

```c
/* path를 따라 wait-for 그래프를 DFS. txn이 path에 다시 나오면 순환 -> 그 txn 반환. */
static int dfs_cycle(const LockManager *lm, int txn, int *path, int depth) {
    for (int i = 0; i < depth; i++)
        if (path[i] == txn) return txn;        /* 이미 경로에 있음 = 순환 */
    path[depth] = txn;
    int targets[LOCK_MAX];
    int nt = wait_targets(lm, txn, targets, LOCK_MAX);  /* txn이 기다리는 트랜잭션들 */
    for (int i = 0; i < nt; i++) {
        int v = dfs_cycle(lm, targets[i], path, depth + 1);
        if (v) return v;
    }
    return 0;
}
```

순환이 있으면 그 안의 한 트랜잭션(victim)을 골라 돌려줘요 — 실제 DB라면 그 victim을 abort해 순환을 끊습니다. 단방향 대기(T2가 T1을 기다리지만 T1은 안 기다림)는 순환이 아니라 교착이 아니고, 한 대기만 풀려도 순환이 사라지는 걸 테스트로 확인했어요.

> **실무/면접 포인트**: 교착 처리에는 두 갈래가 있다 — **탐지 후 victim abort**(PostgreSQL: wait-for 그래프 순환 탐지)와 **타임아웃 후 abort**(MySQL InnoDB의 `innodb_lock_wait_timeout`, 단 InnoDB도 wait-for 그래프 탐지를 함께 씀). minidb가 만든 건 전자의 축소판이다. "거부 모델이라 교착이 원천적으로 안 생기는데도 탐지기를 만든 이유"는, **격리의 메커니즘을 완성도 있게 보이기 위해서**다 — 진짜 락 기반 DB가 피할 수 없는 비용(교착)이 무엇인지 코드로 만져 보려는 것.

## 5. 이건 진짜 동시성이 아니다

정직하게 말하면, 내가 만든 건 **진짜 동시 실행이 아니에요.** 스레드도 없고, 두 트랜잭션이 물리적으로 같이 돌지도 않습니다. PostgreSQL이 쓰는 MVCC(다중 버전 동시성 제어) — 각 트랜잭션이 자기 시점의 스냅샷을 보고, 행마다 여러 버전을 두는 방식 — 은 행 버전 관리가 필요해 엔진을 다시 써야 해요. 내가 만든 건 그 반대편 고전 기법인 **2PL 잠금**의, 그것도 단일 스레드 축소판입니다.

두 기법은 격리를 정반대 철학으로 풀어요.

| | 2PL (잠금, 이번 편) | MVCC (버전, [13편](/blog/project/minidb/minidb-13-mvcc)) |
|---|---|---|
| 철학 | 충돌을 **미리 막는다** (비관적) | 버전을 **갈라 피한다** (낙관적) |
| 읽기/쓰기 | 서로 막는다(S/X 충돌) | 읽기가 쓰기를 안 막는다 |
| 핵심 자료구조 | 락 테이블 | xmin/xmax + 트랜잭션 상태 |
| 대가 | 동시성 저하, 교착 | 죽은 버전 누적, VACUUM |
| minidb 구현 | 테이블 락 + 거부 | 가시성 규칙(토대까지) |

하지만 격리의 **메커니즘**은 다 들어 있어요. S/X 락과 호환 행렬, 트랜잭션이 S·X를 끝까지 쥐는 rigorous 2PL, 충돌로 거부되는 dirty read·lost update, 그리고 wait-for 그래프로 보는 교착.

"트랜잭션 사이"라는, 단일 트랜잭션 엔진엔 없던 개념을 처음부터 발명해야 했어요 — 락 소유자 id, 충돌 규칙, 대기 그래프 전부가 "다른 트랜잭션이 존재한다"를 코드로 표현한 것입니다. 4편에서 가장 어렵다고 미뤘던 절반이 왜 어려운지, 만들면서 알았어요.

> **핵심 통찰**: 격리는 무언가를 하는 게 아니라, **다른 누군가가 동시에 무언가를 할 때 무슨 일이 일어나는가**에 관한 것이다. 그래서 단일 스레드라는 제약이 오히려 "격리가 정확히 무엇을 막는 것인가"를 더 또렷이 보게 해 줬다.

## 6. 정리

이걸로 minidb는 ACID 네 글자를 다 건드렸어요.

| 글자 | 무엇 | minidb에서 | 어느 편 |
|---|---|---|---|
| **A** 원자성 | 전부 아니면 전무 | 롤백(WAL truncate) | [4편](/blog/project/minidb/minidb-4-transactions) |
| **C** 일관성 | 제약 위반 차단 | NOT NULL 제약 | [9편](/blog/project/minidb/minidb-9-null-storage) |
| **I** 격리 | 트랜잭션 사이 보호 | 2PL 테이블 락 + 거부 (락 기반 *메커니즘*; 격리 수준·스냅샷은 아님) | 이번 편 |
| **D** 내구성 | 커밋은 안 사라짐 | WAL | [3편](/blog/project/minidb/minidb-3-index-wal) |

어느 하나도 "진짜 DB만큼"은 아니지만(특히 I는 락 기반 메커니즘이지 격리 수준·스냅샷까지는 아니에요), 각 글자가 코드로 무엇을 뜻하는지는 이제 손에 잡혀요. 4편에서 가장 어렵다고 미뤘던 절반이 왜 어려운지도 만들며 알았고요. 다음 [12편](/blog/project/minidb/minidb-12-2pl-vs-mvcc)에서 2PL과 MVCC를 개념으로 비교하고, [13편](/blog/project/minidb/minidb-13-mvcc)에서 그 MVCC를 minidb에 실제 코드로 심어 봐요.

## 참고

- [PostgreSQL Documentation: Explicit Locking (Lock Modes, Deadlocks)](https://www.postgresql.org/docs/current/explicit-locking.html)
- [PostgreSQL Documentation: Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
- [MySQL Reference Manual: Deadlock Detection](https://dev.mysql.com/doc/refman/8.0/en/innodb-deadlock-detection.html)
- 본 블로그: [트랜잭션 ACID ②: Isolation은 어떻게 구현되는가](/blog/theory/transaction-acid-02-isolation) · [락 메커니즘의 모든 것](/blog/theory/lock-mechanisms-all)
- [minidb 코드 (GitHub)](https://github.com/dj258255/minidb)

<!-- EN -->

## 0. Introduction — the Hardest Half

In [Part 4](/blog/project/minidb/minidb-4-transactions) I built A (atomicity) and D (durability) of ACID, but I honestly wrote that **I (isolation) was "the hardest half, left unbuilt."** This part builds that half.

And right away there is a wall — minidb is single-threaded. Transactions run one at a time, so **what is there to isolate?** That question drove the entire design of this post. So this part follows not "how to write a lock" but **"how the single-threaded constraint illuminates isolation."**

> **Goal of this part**: catch conflicts between interleaved in-process transactions with 2PL table locks to prevent dirty reads and lost updates, and detect deadlocks with a wait-for graph. It is not real concurrency (MVCC), but it makes the **mechanism** of isolation tangible by hand. The real code is [`lock.c`](https://github.com/dj258255/minidb) and the executor wiring ([`db.c`](https://github.com/dj258255/minidb)).

## 1. Single-Threaded — Is There Anything to Isolate?

Isolation is essentially a problem **"between" transactions**. While T1 is editing a row, T2 must not read it (dirty read); if both edit the same value at once, one edit must not be lost (lost update). These anomalies arise **only when two transactions overlap**. But minidb runs transactions one at a time, so there is no overlap and seemingly nothing to isolate.

There was also a deeper problem. The [WAL of Parts 3-4](/blog/project/minidb/minidb-4-transactions) follows a model of "on commit, flush **all** dirty pages of that table." If two transactions wrote to the same table at once, one's commit would pin the other's unfinished changes onto disk. In other words, **the storage layer itself assumed "one writer per table."**

Supporting true concurrent writes needs row versioning (MVCC) or an undo log (ARIES), which means rewriting the engine wholesale. So I set the direction.

> **Design decision**: instead of mimicking real OS concurrency, focus on **"detecting" conflicts between interleaved in-process transactions**. Advance T1 a bit, advance T2 a bit — if these two alternating logical transactions touch the same resource, block it.

This is **conflict serialization**, the core of isolation. "Looks concurrent but is actually lined up" is the essence of isolation.

## 2. The Lock Manager — the Conflict Matrix Is Everything

The classic tool of isolation is the **lock**. To read you take a shared lock (S), to write an exclusive lock (X). The rule is one small compatibility matrix.

| | Holds S | Holds X |
|---|---|---|
| **Requests S** | OK | conflict |
| **Requests X** | conflict | conflict |

Reads (S-S) are compatible — many transactions reading the same thing at once is safe. But a write (X) conflicts with everyone — reading or writing something mid-write is dangerous. A transaction never conflicts with itself, and **upgrading** from a held S to X is allowed only when no one else holds it.

I built a small lock manager that tracks this per `(table, key)`. The heart is one function, `lock_acquire` — it finds the lock this transaction already holds, gathers other transactions' lock modes, then judges by the matrix above.

```c
int lock_acquire(LockManager *lm, int txn, const char *table, long key, LockMode mode) {
    /* 1) find the lock this txn holds, gather others' modes (S/X). */
    LockEntry *mine = NULL;
    int other_s = 0, other_x = 0;
    /* ... loop: e->txn == txn -> mine, else mark other_s/other_x ... */

    if (mine) {                                  /* already holds something */
        if (mode == LOCK_S || mine->mode == LOCK_X) return 0;   /* enough */
        if (other_s || other_x) return -1;       /* S->X upgrade: only if alone */
        mine->mode = LOCK_X;
        return 0;
    }
    /* 2) new lock: compatibility check */
    if (mode == LOCK_X && (other_s || other_x)) return -1;  /* write conflicts with anyone */
    if (mode == LOCK_S && other_x) return -1;              /* read conflicts with X */
    /* 3) grant: record in a free slot */
    /* ... */
    return 0;
}
```

The key is that a conflict **returns `-1` instead of blocking** (why, in the next section). And **making the lock granularity a table was not an accident.**

> **Design choice — why table-level locks**: because of the prior section's WAL constraint ("one writer per table"). A table X lock enforces it, so I could add isolation **without changing a single line of the storage layer**. Row-level locks are finer, but they would put two writers on the same table and break the WAL. In the trade-off of "fineness (row lock) vs storage-layer invariance (table lock)," minidb chose not to touch the foundation.

## 3. Reject, Not Block

Now I wire the locks into the executor. `INSERT`/`UPDATE`/`DELETE` take an X lock on the table, `SELECT` an S lock. In an explicit transaction (`BEGIN`), it **holds the lock — S for reads, X for writes — until `COMMIT`/`ROLLBACK`**; an autocommit statement releases right at statement end. Since it holds S as well as X to the end, this is more precisely **rigorous 2PL (strong strict 2PL)**, one notch stronger than strict 2PL (which keeps only X locks to commit and may release S earlier).

The executor wiring ([`db.c`](https://github.com/dj258255/minidb)) splits like this.

```c
/* isolation (2PL): in an explicit txn, lock under that txn id and hold to COMMIT/ROLLBACK;
 * in autocommit, lock under a temp id and release at statement end. */
lock_txn = db->in_txn ? db->cur_txn : db->next_txn++;
lock_autorelease = !db->in_txn;
if (acquire_stmt_locks(db, &st, lock_txn, out) != 0) {  /* conflict -> reject here */
    if (lock_autorelease) lock_release_all(&db->lm, lock_txn);
    statement_free(&st);
    return -1;                                            /* statement falls to ERROR */
}
```

Here the single-threaded nature shows. A real DB would **block** a conflicting lock — wait until the prior transaction releases. But minidb has no thread to wait on. So I turned the conflict into a **rejection** — fail to take the lock and that statement falls to `ERROR`.

| | Real DB (block) | minidb (reject) |
|---|---|---|
| On conflict | wait until prior txn releases | return `ERROR` immediately |
| Needs | a thread to wait | none (single-threaded) |
| Deadlock possible | yes (wait cycles) | **no** (no waiting) |
| Conflict serialization | lines them up by waiting | lines them up by rejecting (same goal, but the user must retry) |

This lets me demonstrate isolation on the real engine. Set up another transaction (T99) holding an X lock on table `t`:

```sql
-- T99 is writing t (holds X lock)
SELECT * FROM t WHERE id = 1;   -- ERROR: t is locked (read conflict)
INSERT INTO t VALUES (3, 30);   -- ERROR: t is locked (write conflict)
```

Which anomaly each rejection prevents:

| Anomaly | Situation | What blocks it |
|---|---|---|
| **dirty read** | another txn tries to read a table T99 is writing | S request conflicts with X -> reject (can't see uncommitted values) |
| **lost update** | two txns try to write the same table | X request conflicts with X -> reject (no write is lost) |
| (not an anomaly) | T99 holds only S, another `SELECT` reads | S-S compatible -> pass (readers don't block readers) |

When there is no contention, locks are completely transparent, so the [300+ tests](/blog/project/minidb/minidb-1-storage) from before isolation did not break a single line.

> Deeper: for isolation levels (Read Committed, Repeatable Read, etc.) and anomalies like dirty read, lost update, write skew, see [Transaction ACID ②: How Isolation Is Implemented](/blog/theory/transaction-acid-02-isolation). For how locks themselves work from hardware to distributed systems, [Everything About Lock Mechanisms](/blog/theory/lock-mechanisms-all).

## 4. Deadlock — Absent in the Reject Model, but It Should Exist

Here something interesting happens. **The reject model can never deadlock.** Deadlock is when T1 holds A and waits for B, T2 holds B and waits for A, and neither ever releases — but minidb has no "waiting." Fail to acquire and it rejects immediately, so no cycle can form.

I built deadlock detection anyway, to show **what becomes necessary "if we waited instead of rejecting."** I record who waits for whom as a graph — the **wait-for graph**. If T1 waits for B (held by T2), draw a `T1 -> T2` edge. A **cycle** in this graph is a deadlock.

![wait-for graph — a T1⇄T2 2-cycle and a T1→T2→T3→T1 3-cycle are both deadlocks](/uploads/project/minidb/wait-for-graph.svg)

I find cycles with DFS. `dfs_cycle` walks a `path` and, if the same transaction appears again, declares a cycle and returns that victim.

```c
/* DFS the wait-for graph along path. If txn recurs in path -> cycle -> return that txn. */
static int dfs_cycle(const LockManager *lm, int txn, int *path, int depth) {
    for (int i = 0; i < depth; i++)
        if (path[i] == txn) return txn;        /* already in path = cycle */
    path[depth] = txn;
    int targets[LOCK_MAX];
    int nt = wait_targets(lm, txn, targets, LOCK_MAX);  /* txns this one waits for */
    for (int i = 0; i < nt; i++) {
        int v = dfs_cycle(lm, targets[i], path, depth + 1);
        if (v) return v;
    }
    return 0;
}
```

If there is a cycle, it picks one transaction (the victim) in it and returns it — a real DB would abort that victim to break the cycle. A one-way wait (T2 waits for T1 but T1 doesn't wait) is not a cycle and not a deadlock, and I confirmed by test that clearing just one wait makes the cycle vanish.

> **Practical/interview note**: deadlock handling has two branches — **detect then abort a victim** (PostgreSQL: cycle detection on the wait-for graph) and **abort after a timeout** (MySQL InnoDB's `innodb_lock_wait_timeout`, though InnoDB also runs wait-for graph detection). What minidb built is a miniature of the former. The reason I built a detector even though the reject model can never deadlock is **to show the mechanism of isolation completely** — to touch in code what cost (deadlock) a real lock-based DB cannot avoid.

## 5. This Is Not Real Concurrency

Honestly, what I built is **not real concurrent execution.** There are no threads, and two transactions never physically run together. PostgreSQL's MVCC (multi-version concurrency control) — each transaction sees a snapshot at its point in time, with multiple versions per row — needs row versioning and an engine rewrite. What I built is the opposite classic technique, **2PL locking**, and a single-threaded miniature at that.

The two techniques solve isolation with opposite philosophies.

| | 2PL (locks, this part) | MVCC (versions, [Part 13](/blog/project/minidb/minidb-13-mvcc)) |
|---|---|---|
| Philosophy | **prevent** conflicts up front (pessimistic) | **avoid** by splitting versions (optimistic) |
| Read/write | block each other (S/X conflict) | reads don't block writes |
| Key structure | lock table | xmin/xmax + transaction status |
| Cost | low concurrency, deadlocks | dead-version buildup, VACUUM |
| minidb impl | table locks + reject | visibility rule (foundation only) |

But the **mechanism** of isolation is all here. S/X locks and the compatibility matrix, rigorous 2PL where a transaction holds both S and X to the end, dirty read and lost update rejected on conflict, and deadlock seen through the wait-for graph.

I had to invent from scratch the concept of "between transactions," which a single-transaction engine never had — the lock owner id, the conflict rules, the wait graph are all "another transaction exists" expressed in code. Building it, I understood why the half I deferred in Part 4 as the hardest is hard.

> **Key insight**: isolation is not about doing something, but about **what happens when someone else does something at the same time.** That is why the single-threaded constraint actually made it clearer to see exactly what isolation prevents.

## 6. Wrap-up

With this, minidb has touched all four letters of ACID.

| Letter | What | In minidb | Which part |
|---|---|---|---|
| **A** atomicity | all or nothing | rollback (WAL truncate) | [Part 4](/blog/project/minidb/minidb-4-transactions) |
| **C** consistency | block constraint violations | NOT NULL constraints | [Part 9](/blog/project/minidb/minidb-9-null-storage) |
| **I** isolation | protect between transactions | 2PL table locks + reject (a lock-based *mechanism*; not isolation levels or snapshots) | this part |
| **D** durability | commits don't vanish | WAL | [Part 3](/blog/project/minidb/minidb-3-index-wal) |

None of them is "as much as a real DB" (for I in particular, it's a lock-based mechanism, not isolation levels or snapshots), but what each letter means in code is now graspable — and building it, I saw why the half I deferred in Part 4 as the hardest is hard. Next, [Part 12](/blog/project/minidb/minidb-12-2pl-vs-mvcc) compares 2PL and MVCC at the concept level, and [Part 13](/blog/project/minidb/minidb-13-mvcc) grafts that MVCC onto minidb with real code.

## References

- [PostgreSQL Documentation: Explicit Locking (Lock Modes, Deadlocks)](https://www.postgresql.org/docs/current/explicit-locking.html)
- [PostgreSQL Documentation: Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
- [MySQL Reference Manual: Deadlock Detection](https://dev.mysql.com/doc/refman/8.0/en/innodb-deadlock-detection.html)
- This blog: [Transaction ACID ②: How Isolation Is Implemented](/blog/theory/transaction-acid-02-isolation) · [Everything About Lock Mechanisms](/blog/theory/lock-mechanisms-all)
- [minidb on GitHub](https://github.com/dj258255/minidb)

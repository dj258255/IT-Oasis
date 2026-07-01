---
title: '잠금이냐 버전이냐 — 2PL과 MVCC, 격리의 두 길'
titleEn: 'Locks or Versions? — 2PL and MVCC, Two Roads to Isolation'
description: "관계형 DB를 C로 밑바닥부터 만든 db-hobby 시리즈 12편. 11편에서 2PL 잠금으로 격리를 만들었는데, 진짜 PostgreSQL은 잠금이 아니라 MVCC(다중 버전)를 쓴다. 같은 목표(격리)에 정반대 철학의 두 길을 나란히 놓고 본다 — 2PL은 충돌을 미리 막고(비관적, 읽기가 쓰기를 막음), MVCC는 쓰면 새 버전을 만들고 읽으면 자기 스냅샷을 봐서 충돌을 피한다(읽기가 쓰기를 안 막음). 각 방식이 dirty read·lost update·non-repeatable read를 어떻게 막는지, 그 대가가 무엇인지(교착 vs VACUUM), 그리고 db-hobby의 저장 구조가 왜 이미 MVCC에 맞는지까지."
descriptionEn: "Part 12 of building a relational database from scratch in C. In part 11 we built isolation with 2PL locks, but real PostgreSQL uses MVCC (multi-version) instead. We put the two opposite philosophies side by side: 2PL prevents conflicts up front (pessimistic, readers block writers), while MVCC creates a new version on write and reads from a snapshot, so it avoids conflicts (readers don't block writers). How each prevents dirty reads, lost updates, and non-repeatable reads; what each costs (deadlocks vs VACUUM); and why db-hobby's storage is already shaped for MVCC."
date: 2026-06-16
tags:
  - C
  - Database Internals
  - Transactions
  - Concurrency
  - MVCC
  - Learning
category: study/db-hobby
coverImage: /uploads/project/db-hobby/cover.svg
draft: false
series: "db-hobby"
seriesOrder: 12
---

## 0. 들어가며 — 같은 격리, 정반대의 두 철학

[11편](/blog/project/db-hobby/db-hobby-11-isolation)에서 **2PL 잠금**으로 격리를 만들었어요. 그런데 정작 우리가 따라가던 PostgreSQL은 잠금이 아니라 **MVCC(다중 버전 동시성 제어)** 를 씁니다. 같은 목표 — 트랜잭션이 겹쳐 돌아도 서로를 안전하게 지키기 — 에 **정반대 철학의 두 길**이 있는 거예요.

이번 편은 코드를 거의 다루지 않습니다. db-hobby의 현재(2PL)와 PostgreSQL의 길(MVCC)을 **나란히 놓고 그 차이를 개념으로** 보는 비교 글이에요. 앞으로 db-hobby에 MVCC를 만들 텐데([13편](/blog/project/db-hobby/db-hobby-13-mvcc)), 이 글이 그 설계도이기도 합니다.

> **핵심 사실**: 2PL과 MVCC는 둘 다 "격리"를 만들지만, **2PL은 충돌을 미리 막고(비관적) MVCC는 버전을 갈라 읽기-쓰기 충돌을 피한다(낙관적)**. 이 한 줄의 갈림이 나머지 모든 차이를 낳는다.

## 1. 갈림길 — 충돌을 막을까, 피할까

두 트랜잭션이 같은 행을 동시에 건드린다고 해봐요. 하나는 읽고 하나는 씁니다. 어떻게 안전하게 만들까요? 답이 둘이에요.

**2PL(잠금) — 충돌을 미리 막는다.**
읽으려면 공유 락(S), 쓰려면 배타 락(X)을 잡습니다. 누가 잠근 건 못 건드려요. "충돌이 날 수 있으니 아예 못 만나게 줄을 세운다." 비관적(pessimistic) 접근입니다.

**MVCC(버전) — 충돌을 피한다.**
쓰면 데이터를 덮어쓰는 대신 **새 버전**을 만듭니다. 읽으면 자기 트랜잭션이 시작한 시점의 **스냅샷** — 그때 커밋돼 있던 버전들 — 을 봐요. 그래서 읽는 쪽과 쓰는 쪽이 서로 다른 버전을 보고, 막을 일이 없습니다. 같은 행의 서로 다른 버전을 서로 다른 트랜잭션이 보는 이 **가시성(visibility)** 규칙이 읽기-쓰기 충돌을 없애는 거예요.

| | 2PL (잠금) | MVCC (버전) |
|---|---|---|
| 기본 발상 | 충돌을 미리 막는다 | 버전을 갈라 읽기-쓰기 충돌을 피한다 |
| 성향 | 비관적(pessimistic) | 버전을 갈라 피함 |
| 핵심 자료구조 | 락 테이블(S/X) | 버전 + 트랜잭션 상태 |
| 읽기/쓰기 | 서로 막는다 | 서로 안 막는다 |

## 2. MVCC의 한 줄 — 읽기가 쓰기를 막지 않는다

MVCC의 핵심을 한 줄로 줄이면 이렇습니다.

> **읽기는 쓰기를 막지 않고, 쓰기는 읽기를 막지 않는다.**

2PL에선 reader가 writer를 막아요 — 내가 S 락을 쥐고 있으면 남이 X(쓰기)를 못 잡습니다. writer도 reader를 막고요 — X 락을 쥐면 남이 S(읽기)조차 못 잡아요. [11편](/blog/project/db-hobby/db-hobby-11-isolation)에서 db-hobby가 정확히 이랬습니다 — T99가 테이블을 쓰는 중이면 다른 `SELECT`가 거부됐어요. 이게 잠금 방식의 동시성 천장입니다.

MVCC에선 그 천장이 사라져요. reader는 옛 버전(자기 스냅샷)을 보면 되니 writer가 새 버전을 쓰든 말든 기다릴 필요가 없습니다. writer는 새 버전을 따로 쓰니 reader가 옛 버전을 읽든 말든 기다릴 필요가 없고요. PostgreSQL의 높은 읽기 동시성이 여기서 나옵니다(물론 PG의 성능엔 플래너·인덱스·버퍼·VACUUM도 같이 작용해요).

> **실무/면접 포인트**: "MVCC가 빠르다"보다 정확한 설명은 **"MVCC는 읽기-쓰기 충돌을 없앤다"** 예요. 일반 SELECT가 읽기 락 없이 스냅샷을 읽으니 reader가 writer를, writer가 reader를 기다리지 않습니다(`FOR UPDATE`·`FOR SHARE` 같은 명시적 락은 예외). 다만 쓰기-쓰기 충돌은 MVCC에서도 남아요(3절 lost update).

## 3. 같은 이상현상, 다른 처방

[11편](/blog/project/db-hobby/db-hobby-11-isolation)에서 본 이상현상들을 두 방식이 각각 어떻게 막는지 보면 차이가 또렷해져요.

| 이상현상 | 2PL (잠금) | MVCC (버전) |
|---|---|---|
| **dirty read** | X 잠긴 행을 못 읽음 | 항상 "마지막으로 커밋된 버전"을 보니 커밋 안 된 건 애초에 안 보임 |
| **lost update** | X 락으로 쓰기를 직렬화 | UPDATE 시 행 락으로 한쪽이 상대 커밋을 기다렸다가, 진 쪽이 재평가/직렬화 실패(first-updater-wins) |
| **non-repeatable read** | S 락을 커밋까지 쥠 | 스냅샷이 시작 시점에 고정 -> 같은 걸 다시 읽어도 똑같음 |

같은 문제를 한쪽은 "잠가서", 한쪽은 "버전을 갈라서" 풀어요. 특히 non-repeatable read에서 갈리는데 — 2PL은 "남이 못 바꾸게 잠가서" 같은 값을 보장하고, MVCC는 "남이 바꿔도 나는 내 시점만 보니까" 같은 값을 봅니다. 전자는 동시성을 깎아 안전을 얻고, 후자는 버전을 쌓아 안전을 얻어요.

> **주의**: MVCC라고 모든 이상현상이 공짜로 사라지는 건 아니에요. lost update(쓰기-쓰기 충돌)는 MVCC도 그냥 못 넘어가서, UPDATE 시점에 행 락으로 충돌을 감지해 상대 커밋을 기다렸다가 한쪽을 처리합니다(first-updater-wins — Read Committed면 재평가 후 갱신, Repeatable Read·Serializable이면 직렬화 실패로 abort). "읽기가 쓰기를 안 막는다"는 어디까지나 **읽기-쓰기** 사이의 얘기예요.

## 4. 공짜 점심은 없다 — 두 방식의 대가

두 방식 다 대가가 있습니다.

**2PL의 대가는 동시성과 교착이에요.**
잠금이 서로를 막으니 처리량이 떨어지고, 서로의 락을 기다리다 [교착(deadlock)](/blog/project/db-hobby/db-hobby-11-isolation)이 생겨 탐지·abort가 필요해요. 대신 저장은 단순합니다 — 행당 버전 하나면 돼요.

**MVCC의 대가는 공간과 청소예요.**
쓸 때마다 새 버전을 만드니 옛 버전(dead tuple)이 쌓여요. 이걸 안 치우면 테이블·인덱스가 부풀어(bloat) 느려집니다. 그래서 PostgreSQL은 죽은 버전을 회수하는 **VACUUM**(autovacuum)을 떠안고 살고, 그게 PG 운영의 큰 부분이에요. 읽기 락 없는 높은 읽기 동시성의 값이, 끝없이 쌓이는 죽은 버전과 그걸 청소하는 부담인 셈입니다.

| | 2PL (잠금) | MVCC (버전) |
|---|---|---|
| 얻는 것 | 단순한 저장(행당 버전 1개) | 높은 읽기 동시성(읽기가 쓰기 안 막음) |
| 치르는 비용 | 동시성 저하, 교착 탐지·abort | dead tuple 누적, VACUUM |
| 비용 청구 시점 | 실행 중(락 대기·교착) | 나중에 백그라운드(VACUUM) |

> **더 깊이**: PostgreSQL의 append-only MVCC와 InnoDB의 in-place + Undo Log가 원자성·가시성을 어떻게 다르게 구현하는지는 [트랜잭션 ACID ①: Atomicity는 어떻게 구현되는가](/blog/theory/transaction-acid-01-atomicity). 격리 수준과 이상현상 자체는 [② Isolation](/blog/theory/transaction-acid-02-isolation).

## 5. db-hobby의 저장 구조는 이미 MVCC 쪽이다

재밌는 건, db-hobby가 2PL을 만들었는데도 **저장 구조는 이미 MVCC 쪽**이라는 점이에요. [1편에서 PostgreSQL식 힙](/blog/project/db-hobby/db-hobby-1-storage)을 골랐고, PostgreSQL의 저장 모델이 애초에 MVCC를 위해 만들어졌기 때문입니다.

- db-hobby의 `UPDATE`는 [이미 "옛 행 tombstone + 새 행 삽입"](/blog/project/db-hobby/db-hobby-10-secondary-index)이에요 -> 이게 정확히 MVCC가 **새 버전**을 만드는 방식입니다.
- `DELETE`가 남기는 tombstone -> MVCC의 dead tuple 그 자체예요.

그러니 MVCC로 가는 건 "처음부터 다시"가 아니라 **빠진 조각 끼우기**입니다. 빠진 건 넷이에요.

1. 버전마다 **`xmin`/`xmax`** — "이 버전을 만든 트랜잭션 / 지운 트랜잭션"(지금의 tombstone 비트를 트랜잭션 id로 승격).
2. **트랜잭션 상태 로그** — 어떤 트랜잭션이 커밋됐는지.
3. **스냅샷 + 가시성 판정** — SELECT가 "내 스냅샷에서 보이는 버전"만 거르기.
4. **다중 트랜잭션 핸들** — 실행기가 트랜잭션을 하나가 아니라 여럿 열어 진짜로 인터리브.

가장 큰 건 4번이에요 — [11편](/blog/project/db-hobby/db-hobby-11-isolation)에서 실행기가 트랜잭션을 하나씩만 열던 그 한계를 넘는 일입니다.

| 저장 모델 | 옛 버전 위치 | UPDATE 방식 | MVCC 친화도 |
|---|---|---|---|
| **db-hobby** (PG식 힙) | 같은 힙 | 옛 행 tombstone + 새 행 삽입 | 높음(저장이 MVCC와 잘 맞음) |
| **PostgreSQL** | 같은 힙(튜플 헤더) | 새 튜플 append | 네이티브 |
| **InnoDB** | 별도 Undo Log | in-place + before-image | 다른 길 |

> **실무/면접 포인트**: "어느 저장 모델이 MVCC에 유리한가"는 곧 "옛 버전을 같은 힙에 두느냐(PG·db-hobby) 별도 Undo Log에 두느냐(InnoDB)"의 문제예요. db-hobby가 PG식 힙을 골랐다는 1편의 결정이, MVCC의 **저장 토대**를 공짜로 깔아 둔 셈입니다(스냅샷·가시성·트랜잭션 상태·VACUUM 같은 나머지는 여전히 만들 일이에요). **토대 설계가 곧 나중의 기능 가능성**이라는 게 이 시리즈의 반복되는 교훈이에요([13편](/blog/project/db-hobby/db-hobby-13-mvcc)에서 코드로 부딪힙니다).

## 6. 왜 2PL을 먼저 했나

그럼 처음부터 MVCC를 하지 그랬냐 싶지만, 2PL을 먼저 한 데는 이유가 있어요. 저장을 안 바꾸고, 잠금 규칙(S/X·충돌·교착)이라는 격리의 **고전 골격**을 또렷이 보여줄 수 있어서입니다. MVCC는 그 위에서 "잠그는 대신 버전을 가른다"로 도약하는, 시리즈의 클라이맥스 같은 주제예요.

순서를 정리하면 이렇습니다 — [11편](/blog/project/db-hobby/db-hobby-11-isolation)에서 잠금으로 "격리가 **무엇을** 막는가"를 봤고, 이번 12편에서 잠금과 버전의 두 철학을 **개념으로 비교**했고, [13편](/blog/project/db-hobby/db-hobby-13-mvcc)에서 그 버전(MVCC)을 **실제 코드로** 심습니다.

## 7. 정리

같은 "격리"인데, 한쪽은 **잠그고**(2PL) 한쪽은 **버전을 쌓아요**(MVCC). 비관 대 낙관, 막기 대 피하기죠. 핵심을 다시 모으면:

- **갈림길** — 2PL은 충돌을 미리 막고(비관적), MVCC는 버전을 갈라 읽기-쓰기 충돌을 피한다(낙관적).
- **MVCC의 한 줄** — 읽기가 쓰기를 안 막는다. PostgreSQL의 높은 읽기 동시성이 여기서 나온다(단, 쓰기-쓰기 충돌은 남는다).
- **이상현상** — 같은 dirty read·lost update·non-repeatable read를, 한쪽은 잠가서 한쪽은 버전을 갈라서 푼다.
- **대가** — 2PL은 동시성 저하·교착, MVCC는 dead tuple·VACUUM. 공짜 점심은 없다.
- **db-hobby** — 저장이 이미 PG식 힙(UPDATE = tombstone + 새 행)이라 MVCC의 저장 토대가 공짜. 빠진 건 xmin/xmax·상태 로그·가시성·다중 트랜잭션.

PostgreSQL이 버전의 길을 골랐기에 그 높은 읽기 동시성을 얻고 dead tuple과 VACUUM을 떠안았고, db-hobby가 그 길을 따라가면 같은 이득과 같은 짐을 지게 됩니다. 지금까지 잠금으로 "격리가 무엇을 막는가"를 봤다면, [다음 편](/blog/project/db-hobby/db-hobby-13-mvcc)은 버전으로 "격리를 어떻게 매끄럽게 하는가"를 실제 코드로 만들 차례예요.

## 참고

- [PostgreSQL Documentation: Concurrency Control — MVCC Introduction](https://www.postgresql.org/docs/current/mvcc-intro.html)
- [PostgreSQL Documentation: Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
- [PostgreSQL Documentation: Routine Vacuuming](https://www.postgresql.org/docs/current/routine-vacuuming.html)
- [The Internals of PostgreSQL: Concurrency Control (xmin/xmax, clog, visibility)](https://www.interdb.jp/pg/pgsql05.html)
- 본 시리즈: [트랜잭션 ACID ①: Atomicity](/blog/theory/transaction-acid-01-atomicity) · [② Isolation](/blog/theory/transaction-acid-02-isolation)
- [db-hobby 코드 (GitHub)](https://github.com/dj258255/db-hobby)

<!-- EN -->

## 0. Introduction — Same Isolation, Two Opposite Philosophies

In [Part 11](/blog/project/db-hobby/db-hobby-11-isolation) we built isolation with **2PL locks**. But the PostgreSQL we have been following does not use locks — it uses **MVCC (multi-version concurrency control)**. The same goal — keeping overlapping transactions safe from each other — has **two roads of opposite philosophy**.

This part has almost no code. It is a comparison piece that puts db-hobby's present (2PL) and PostgreSQL's road (MVCC) **side by side and contrasts them at the concept level**. We will build MVCC into db-hobby soon ([Part 13](/blog/project/db-hobby/db-hobby-13-mvcc)), and this article is also its blueprint.

> **Key fact**: 2PL and MVCC both produce "isolation", but **2PL prevents conflicts up front (pessimistic) while MVCC splits versions to avoid read-write conflicts (optimistic)**. This one-line fork gives rise to every other difference.

## 1. The Fork — Prevent the Conflict, or Avoid It?

Suppose two transactions touch the same row at once. One reads, one writes. How do you make it safe? There are two answers.

**2PL (locks) — prevent the conflict up front.**
To read, take a shared lock (S); to write, take an exclusive lock (X). You cannot touch what someone has locked. "A conflict could happen, so line everyone up so they never meet." A pessimistic approach.

**MVCC (versions) — avoid the conflict.**
On a write, instead of overwriting the data, create a **new version**. On a read, you see the **snapshot** from when your transaction started — the versions committed at that moment. So the reader and the writer see different versions, and there is nothing to block. It is this **visibility** rule — different transactions seeing different versions of the same row — that removes the read-write conflict.

| | 2PL (locks) | MVCC (versions) |
|---|---|---|
| Core idea | prevent the conflict up front | split versions to avoid read-write conflicts |
| Disposition | pessimistic | avoid by splitting versions |
| Key structure | lock table (S/X) | versions + transaction status |
| Read/write | block each other | do not block each other |

## 2. The One Line of MVCC — Reads Do Not Block Writes

Boil MVCC's core down to one line:

> **Reads do not block writes, and writes do not block reads.**

In 2PL a reader blocks a writer — while I hold an S lock, no one else can take X (write). A writer blocks a reader too — while I hold X, no one else can even take S (read). db-hobby was exactly like this in [Part 11](/blog/project/db-hobby/db-hobby-11-isolation) — while T99 was writing the table, other `SELECT`s were rejected. That is the concurrency ceiling of locking.

In MVCC that ceiling disappears. A reader just looks at the old version (its own snapshot), so it need not wait whether the writer writes a new version or not. A writer writes a new version separately, so it need not wait whether the reader reads the old version or not. PostgreSQL's high read concurrency comes from here (PG's performance also owes to the planner, indexes, buffers, and VACUUM, of course).

> **Practical/interview note**: more precise than "MVCC is fast" is **"MVCC eliminates the read-write conflict."** A plain SELECT reads a snapshot without a read lock, so readers do not wait on writers and writers do not wait on readers (explicit locks like `FOR UPDATE`/`FOR SHARE` are the exception). But write-write conflicts still remain even under MVCC (lost update, section 3).

## 3. Same Anomalies, Different Cures

Looking at how each approach prevents the anomalies from [Part 11](/blog/project/db-hobby/db-hobby-11-isolation) makes the difference sharp.

| Anomaly | 2PL (locks) | MVCC (versions) |
|---|---|---|
| **dirty read** | cannot read an X-locked row | always sees the "last committed version", so an uncommitted one is invisible to begin with |
| **lost update** | serializes writes via the X lock | on UPDATE a row lock makes one side wait for the other's commit, then the loser re-evaluates / fails to serialize (first-updater-wins) |
| **non-repeatable read** | holds the S lock until commit | the snapshot is fixed at start time -> reading the same thing again gives the same result |

The same problem is solved by "locking" on one side and "splitting versions" on the other. The split is sharpest at non-repeatable read — 2PL guarantees the same value "by locking so no one can change it", while MVCC sees the same value "because even if someone changes it, I only see my point in time." The former trades concurrency for safety; the latter stacks versions for safety.

> **Caveat**: MVCC does not make every anomaly vanish for free. Lost update (a write-write conflict) is something MVCC cannot just skip past — on UPDATE a row lock detects the conflict, waits for the other's commit, and handles one side (first-updater-wins — under Read Committed it re-evaluates and updates; under Repeatable Read/Serializable it aborts with a serialization failure). "Reads do not block writes" is strictly about the **read-write** relationship.

## 4. No Free Lunch — What Each Approach Costs

Both approaches have a price.

**2PL's cost is concurrency and deadlocks.**
Locks block each other, so throughput drops, and waiting on each other's locks creates a [deadlock](/blog/project/db-hobby/db-hobby-11-isolation) that needs detection and abort. In exchange, storage is simple — one version per row is enough.

**MVCC's cost is space and cleanup.**
Every write creates a new version, so old versions (dead tuples) pile up. Left uncleaned, tables and indexes bloat and slow down. That is why PostgreSQL lives with **VACUUM** (autovacuum) reclaiming dead versions, and that is a big part of operating PG. The price of read-lock-free high read concurrency is the endlessly accumulating dead versions and the burden of cleaning them.

| | 2PL (locks) | MVCC (versions) |
|---|---|---|
| What you gain | simple storage (1 version per row) | high read concurrency (reads don't block writes) |
| What you pay | low concurrency, deadlock detection·abort | dead-tuple buildup, VACUUM |
| When billed | during execution (lock waits·deadlocks) | later, in the background (VACUUM) |

> **Deeper**: how PostgreSQL's append-only MVCC and InnoDB's in-place + Undo Log implement atomicity and visibility differently is in [Transaction ACID ①: How Is Atomicity Implemented?](/blog/theory/transaction-acid-01-atomicity). Isolation levels and the anomalies themselves are in [② Isolation](/blog/theory/transaction-acid-02-isolation).

## 5. db-hobby's Storage Is Already on the MVCC Side

The fun part is that even though db-hobby built 2PL, its **storage structure is already on the MVCC side**. We chose a [PostgreSQL-style heap in Part 1](/blog/project/db-hobby/db-hobby-1-storage), and PostgreSQL's storage model was made for MVCC in the first place.

- db-hobby's `UPDATE` is [already "tombstone the old row + insert a new row"](/blog/project/db-hobby/db-hobby-10-secondary-index) -> that is exactly how MVCC creates a **new version**.
- The tombstone left by `DELETE` -> that is the MVCC dead tuple itself.

So moving to MVCC is not "start over" but **fitting in the missing pieces**. Four are missing:

1. **`xmin`/`xmax`** per version — "the transaction that created / deleted this version" (promote today's tombstone bit to a transaction id).
2. A **transaction status log** — which transaction committed.
3. **Snapshot + visibility check** — SELECT filtering only "versions visible in my snapshot".
4. **Multiple transaction handles** — the executor opening many transactions, not one, to truly interleave.

The biggest is #4 — getting past the limit in [Part 11](/blog/project/db-hobby/db-hobby-11-isolation) where the executor opened transactions one at a time.

| Storage model | Old version location | UPDATE | MVCC affinity |
|---|---|---|---|
| **db-hobby** (PG-style heap) | same heap | tombstone old row + insert new row | high (storage fits MVCC well) |
| **PostgreSQL** | same heap (tuple header) | append a new tuple | native |
| **InnoDB** | separate Undo Log | in-place + before-image | a different road |

> **Practical/interview note**: "which storage model favors MVCC" is exactly the question of "do you keep the old version in the same heap (PG·db-hobby) or in a separate Undo Log (InnoDB)." Part 1's decision to pick a PG-style heap is what laid the **storage foundation** of MVCC for free (the rest — snapshots, visibility, transaction status, VACUUM — is still to build). **Foundation design is later feature possibility** — a recurring lesson of this series (we hit it in code in [Part 13](/blog/project/db-hobby/db-hobby-13-mvcc)).

## 6. Why 2PL First?

Why not do MVCC from the start, then? There was a reason to do 2PL first. It changes nothing in storage and lets the **classic skeleton** of isolation — lock rules (S/X·conflict·deadlock) — show clearly. MVCC is the series' climax that leaps from there to "split versions instead of locking".

To lay out the order: in [Part 11](/blog/project/db-hobby/db-hobby-11-isolation) we saw, via locking, **what** isolation prevents; in this Part 12 we **compared at the concept level** the two philosophies of locking and versioning; in [Part 13](/blog/project/db-hobby/db-hobby-13-mvcc) we graft that versioning (MVCC) **with real code**.

## 7. Wrap-up

Same "isolation", but one side **locks** (2PL) and the other **stacks versions** (MVCC). Pessimistic vs optimistic, prevent vs avoid. Pulling the core back together:

- **The fork** — 2PL prevents the conflict up front (pessimistic); MVCC splits versions to avoid read-write conflicts (optimistic).
- **MVCC's one line** — reads do not block writes. PostgreSQL's high read concurrency comes from here (but write-write conflicts remain).
- **Anomalies** — the same dirty read·lost update·non-repeatable read are solved by locking on one side and by splitting versions on the other.
- **Cost** — 2PL pays in low concurrency·deadlocks, MVCC in dead tuples·VACUUM. No free lunch.
- **db-hobby** — its storage is already a PG-style heap (UPDATE = tombstone + new row), so MVCC's storage foundation is free. The missing pieces are xmin/xmax·status log·visibility·multiple transactions.

PostgreSQL chose the road of versions, so it gained that high read concurrency and took on dead tuples and VACUUM; if db-hobby follows that road it carries the same gain and the same burden. Where we have seen, via locking, what isolation prevents, [the next part](/blog/project/db-hobby/db-hobby-13-mvcc) is where we build, via versions and real code, how to make isolation smooth.

## References

- [PostgreSQL Documentation: Concurrency Control — MVCC Introduction](https://www.postgresql.org/docs/current/mvcc-intro.html)
- [PostgreSQL Documentation: Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
- [PostgreSQL Documentation: Routine Vacuuming](https://www.postgresql.org/docs/current/routine-vacuuming.html)
- [The Internals of PostgreSQL: Concurrency Control (xmin/xmax, clog, visibility)](https://www.interdb.jp/pg/pgsql05.html)
- This series: [Transaction ACID ①: Atomicity](/blog/theory/transaction-acid-01-atomicity) · [② Isolation](/blog/theory/transaction-acid-02-isolation)
- [db-hobby on GitHub](https://github.com/dj258255/db-hobby)

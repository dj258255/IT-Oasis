---
title: 'Raft로 복제되는 db-hobby — 리더가 죽어도 살아남는 진짜 고가용 DB'
titleEn: 'A Raft-Replicated db-hobby — a Truly Highly-Available DB That Survives Leader Death'
description: "28~32편의 Raft는 시뮬레이션 네트워크에서만 도는 독립 모듈이었고, 31편의 복제는 primary가 고정이었다. 이 편이 둘을 잇는다 — 실제 db.c 엔진의 쓰기를 Raft 합의로 복제해 진짜 고가용 DB를 만든다. 방식은 정석인 상태기계 복제(SMR): 클라이언트 쓰기(SQL)를 리더가 '바로 실행하지 않고' Raft 로그에 제안하고, 과반이 복제·커밋하면, 모든 노드가 커밋된 명령을 같은 순서로 자기 엔진에 db_exec로 적용한다. 같은 명령을 같은 순서로 적용하니 세 엔진이 완전히 수렴하고 — SELECT 결과가 노드 간에 완전히 일치한다. 그리고 리더가 죽어도 남은 노드가 새 리더를 뽑아 이어받아 계속 쓰며, 커밋된 데이터는 Leader Completeness가 지킨다(진짜 failover). 정직한 단순화: 인프로세스 시뮬레이션이라 Raft 로그는 명령의 seq(정수)만 나르고 SQL 바이트는 공유 메모리에 둔다 — 합의의 본질(전역 순서·과반 커밋·failover)은 전부 진짜 Raft가 하고 바이트 전송만 생략했다(그래서 raft.c는 한 줄도 안 고침). 정직한 경계: 낡은 읽기(선형화 읽기는 다음 편), 크래시 노드 rejoin(엔진에 applied-index 영속화가 전제)은 프론티어."
descriptionEn: "The Raft of Parts 28–32 was a standalone module running only on a simulated network, and Part 31's replication had a fixed primary. This part joins them — replicating the real db.c engine's writes through Raft consensus to make a truly highly-available DB. The method is textbook state-machine replication (SMR): the leader does NOT execute a client write (SQL) directly; it proposes it to the Raft log, and once a majority replicates and commits, every node applies the committed command to its own engine via db_exec, in the same order. Applying the same commands in the same order makes the three engines fully converge — SELECT results are identical across nodes. And when the leader dies, the survivors elect a new leader and keep writing; committed data is preserved by Leader Completeness (real failover). Honest simplification: because it's an in-process simulation, the Raft log carries only a command's sequence number (an integer) while the SQL bytes live in shared memory — the essence of consensus (global order, majority commit, failover) is all real Raft, only the byte transport is elided (so raft.c isn't touched at all). Honest boundary: stale reads (linearizable reads are next), and crashed-node rejoin (which needs the engine to persist its applied index) are frontiers."
date: 2026-07-05
tags:
  - C
  - Database Internals
  - Raft
  - Replication
  - High Availability
  - Distributed Systems
  - Learning
category: study/db-hobby
coverImage: /uploads/project/db-hobby/cover.svg
draft: false
series: "db-hobby"
seriesOrder: 33
---

## 0. 들어가며 — 마지막 통합

여기까지 오면서 두 갈래가 나란히 자랐어요:

- [28~32편](/blog/project/db-hobby/db-hobby-28-raft-consensus): **Raft**(합의·지속성·스냅샷·멤버십) — 하지만 **시뮬레이션 네트워크**에서만 도는 독립 모듈. db-hobby의 진짜 데이터를 복제하진 않았죠.
- [31편](/blog/project/db-hobby/db-hobby-31-replicated-db): 복제를 엔진에 배선 — 하지만 **primary가 고정**(파일 복사 + WAL 재생), 리더가 죽으면 끝.

이 편이 그 둘을 **하나로 잇습니다.** 목표는 하나예요:

> 실제 `db_exec` 쓰기가 **Raft 합의로 복제**되고, **리더가 죽어도** 남은 노드가 이어받아 데이터가 일관되는 — 진짜 **고가용(HA) DB.**

## 1. 상태기계 복제 (SMR) — 명령을 복제한다

핵심 발상은 정석인 **상태기계 복제**입니다. 순서를 뒤집는 게 관건이에요:

> 클라이언트 쓰기를 리더가 **바로 실행하지 않는다.** 먼저 Raft에 **제안**하고, **커밋된 뒤에야** 모든 노드가 그 명령을 자기 엔진에 적용한다.

세 단계로 흐릅니다:

1. 클라이언트가 리더에 `INSERT ...`를 보냄 → 리더는 그걸 **Raft 로그에 append**(제안). **아직 자기 엔진에도 실행 안 함.**
2. Raft가 과반에 복제 → **커밋**.
3. 커밋된 엔트리를 **모든 노드**(리더 포함)가 순서대로 **자기 db-hobby 엔진에 `db_exec`** 로 적용.

![Raft로 복제되는 db-hobby: 쓰기를 Raft에 제안 → 과반 커밋 → 모든 노드가 자기 엔진에 적용 → 수렴, 그리고 failover](/uploads/project/db-hobby/raft-replicated-db.svg)

**모든 노드가 같은 명령을 같은 순서로 적용**하니, 세 엔진은 완전히 수렴합니다. 결정적 포인트: **리더도 커밋 후에야** 적용해요(제안 때가 아니라). 그래야 "리더가 실행했는데 합의는 실패" 같은 갈라짐이 없죠. 클라이언트의 `raftdb_write`는 **제안만** 하고, 실제 실행은 커밋 후 모든 노드에서 동시에 일어납니다.

검증: 3노드에 CREATE + INSERT 5개를 쓰고, **세 노드의 `SELECT * FROM t` 결과가 완전히 동일**한지 문자열로 비교합니다.

```
  ok   노드0/1/2 엔진에 5행 복제됨
  ok   세 노드 엔진의 SELECT 결과가 완전히 일치(SMR 수렴)
```

## 2. raft.c를 한 줄도 안 고친 이유 — 정직한 단순화

여기서 정직하게 짚을 게 있어요. 이건 **인프로세스 시뮬레이션 클러스터**입니다(합의 검증엔 [28편과 같은 이유로](/blog/project/db-hobby/db-hobby-28-raft-consensus) 결정적 시뮬이 맞아요). 그래서 한 가지를 생략했습니다:

> Raft 로그 엔트리는 명령의 **seq(정수)** 만 나른다. SQL 바이트는 공유 배열 `cmds[]`에 둔다. 노드들이 한 프로세스라 payload가 물리적으로 이동할 필요가 없으니까.

즉 리더가 `cmds[seq] = "INSERT..."`를 저장하고 Raft엔 `seq`만 제안 → 각 노드는 커밋된 `seq`로 `cmds[seq]`를 찾아 `db_exec`. **합의의 본질 — 전역 순서, 과반 커밋, 리더 선출, failover — 은 전부 진짜 Raft([raft.c](/blog/project/db-hobby/db-hobby-28-raft-consensus))가** 하고, 오직 **명령 바이트 전송만** 생략한 거예요. 진짜 이기종 클러스터라면 `seq` 대신 SQL 바이트가 엔트리에 실려 [26편의 소켓](/blog/project/db-hobby/db-hobby-26-tcp-replication)으로 흐릅니다.

이 단순화 덕에 **`raft.c`를 한 줄도 안 고쳤어요** — 기존 apply 콜백(커밋 시 각 노드에서 호출)을 그대로 재사용합니다. 통합 계층 `raftdb.c`는 순수하게 "Raft 위에 엔진을 얹는" 접착제죠.

## 3. failover — 리더가 죽어도

진짜 HA의 시험대는 **리더가 죽었을 때**입니다. 테스트가 그걸 정면으로 겨눠요:

1. 리더(노드0)를 **크래시**(다운)시킨다.
2. 남은 `{1,2}`가 하트비트가 끊기자 타임아웃 → **새 리더 선출**(더 높은 term).
3. 클라이언트가 새 리더에 계속 쓴다 → 이어서 복제.
4. 생존 노드들이 여전히 **일관**(8행)한지 확인.

```
  ok   failover: 새 리더가 이어받음
  ok   failover 후: 생존 노드가 8행(계속 복제됨)
  ok   failover 후: 두 생존 노드가 여전히 일치
```

여기서 **커밋된 데이터가 안 사라지는** 건 우연이 아니에요. [28편의 Leader Completeness](/blog/project/db-hobby/db-hobby-28-raft-consensus)(커밋된 엔트리를 가진 노드만 리더가 될 수 있다)가 그걸 보장합니다. 새 리더는 반드시 옛 리더가 커밋한 걸 다 갖고 있으니까요. 28~30편에서 그렇게 공들여 세운 안전성이, 여기서 "리더 죽어도 데이터 안 잃음"으로 **현금화**됩니다.

## 4. 정직한 경계

- **낡은 읽기(stale read).** 읽기는 아무 노드 엔진에서 직접 실행해요 — 그 노드가 뒤처져 있으면 낡은 값을 볼 수 있습니다. 읽기가 최신 커밋을 보장하게 하는 **선형화 읽기(leader lease/ReadIndex)** 가 바로 **다음 편**의 주제예요. 이 편이 그 문제를 만들고, 다음 편이 풉니다.
- **크래시 노드의 재합류(rejoin) 없음.** 크래시된 노드를 되살리면, 엔진이 "내가 어느 Raft 인덱스까지 적용했나"를 **durable하게 추적하지 않아서**, 커밋 로그를 재적용하면 INSERT가 **중복**됩니다([레지스터 SM](/blog/project/db-hobby/db-hobby-28-raft-consensus)과 달리 SQL 적용은 idempotent가 아니에요). 엔진에 applied-index 영속화를 넣는 게 rejoin의 전제 — 프론티어. 그래서 이 편은 failover(이어받기)까지.
- **인프로세스 시뮬 네트워크.** 위에서 말한 seq/공유메모리 단순화. 소켓 배선은 [26편](/blog/project/db-hobby/db-hobby-26-tcp-replication) 위에.
- **apply 실패를 드러낸다(적대적 리뷰가 잡은 것).** 독립 서브에이전트 리뷰가 실제 구멍을 찾았어요: apply 콜백이 `db_exec`의 실패를 **삼키면** Raft의 `last_applied`만 전진하고 엔진은 안 바뀌어 그 노드가 **영구 발산**합니다(디스크 풀 같은 노드-로컬 오류 시). SMR의 전제 "apply는 결정적"이 파일 I/O 부작용 때문에 깨질 수 있는 자리죠. 실패를 세어(`apply_errors`) **검출**하도록 고쳤습니다 — 진짜 시스템은 그런 노드를 멈추거나 재동기화하고(그 재동기화가 rejoin 프론티어), 여기선 발산을 숨기지 않고 드러내는 데까지.

## 5. 정리 — 분산 축의 완성

- 28~32편의 **Raft(합의)** 와 db.c의 **엔진**을 **상태기계 복제**로 배선했다 — "독립 모듈"이 아니라 **진짜 복제되는 HA DB.**
- 정석 SMR: 쓰기를 **제안**만 하고 **커밋 후 모든 노드가 같은 순서로** 엔진에 적용 → 완전 수렴.
- **리더가 죽어도** 새 리더가 이어받고, [Leader Completeness](/blog/project/db-hobby/db-hobby-28-raft-consensus)가 커밋된 데이터를 지킨다 — 진짜 failover.
- 정직한 단순화(인프로세스 seq/공유메모리)로 **raft.c 무수정**. 정직한 경계: 낡은 읽기(→다음 편)·rejoin은 프론티어.

25편에서 시작한 **분산 축**이 여기서 정점을 찍습니다 — 복제(25·26) → 합의(28~30) → 멤버십(32) → 그리고 그 모두를 실제 엔진에 얹은 **HA DB(33)**. "DB를 만들었다"는 대부분의 프로젝트가 멈추는 지점에서, db-hobby는 **리더가 죽어도 살아남는 DB**까지 손으로 짚어 봤어요.

<!-- EN -->

## 0. Intro — The Last Integration

Two strands grew side by side to get here:

- [Parts 28–32](/blog/project/db-hobby/db-hobby-28-raft-consensus): **Raft** (consensus, persistence, snapshots, membership) — but a standalone module running only on a **simulated network.** It didn't replicate db-hobby's real data.
- [Part 31](/blog/project/db-hobby/db-hobby-31-replicated-db): replication wired into the engine — but with a **fixed primary** (file copy + WAL replay); if the leader dies, it's over.

This part joins the two. One goal:

> A truly **highly-available (HA) DB** where real `db_exec` writes are **replicated through Raft consensus**, and **even if the leader dies** the survivors take over with consistent data.

## 1. State-Machine Replication (SMR) — Replicate the Command

The core idea is textbook **state-machine replication.** The trick is inverting the order:

> The leader does NOT execute a client write directly. It first **proposes** it to Raft, and only **after it commits** does every node apply that command to its own engine.

Three stages:

1. A client sends `INSERT ...` to the leader → the leader **appends it to the Raft log** (propose). **It hasn't run it on its own engine yet.**
2. Raft replicates to a majority → **commit.**
3. **Every node** (leader included) applies the committed entry, in order, to **its own db-hobby engine via `db_exec`.**

![A Raft-replicated db-hobby: propose the write to Raft → majority commit → every node applies to its own engine → converge, and failover](/uploads/project/db-hobby/raft-replicated-db.svg)

Because **every node applies the same commands in the same order**, the three engines fully converge. The decisive point: **the leader too applies only after commit** (not on propose). That avoids divergence like "the leader ran it but consensus failed." The client's `raftdb_write` only **proposes**; the actual execution happens after commit, on all nodes at once.

Verification: write CREATE + 5 INSERTs to 3 nodes, and string-compare that **all three nodes' `SELECT * FROM t` results are identical.**

```
  ok   5 rows replicated to nodes 0/1/2 engines
  ok   all three engines' SELECT results fully match (SMR convergence)
```

## 2. Why raft.c Wasn't Touched — an Honest Simplification

Here's something to state honestly. This is an **in-process simulation cluster** (a deterministic sim is right for verifying consensus, for [the same reason as Part 28](/blog/project/db-hobby/db-hobby-28-raft-consensus)). So one thing is elided:

> A Raft log entry carries only the command's **sequence number** (an integer). The SQL bytes live in a shared array `cmds[]`. Since the nodes are one process, the payload needn't physically move.

So the leader stores `cmds[seq] = "INSERT..."` and proposes only `seq` to Raft → each node looks up `cmds[seq]` on the committed `seq` and `db_exec`s it. **The essence of consensus — global order, majority commit, leader election, failover — is all real Raft ([raft.c](/blog/project/db-hobby/db-hobby-28-raft-consensus))**, and only the **command-byte transport** is elided. A real heterogeneous cluster would carry the SQL bytes in the entry, flowing over [Part 26's socket](/blog/project/db-hobby/db-hobby-26-tcp-replication) instead of `seq`.

Thanks to this simplification, **`raft.c` isn't touched at all** — it reuses the existing apply callback (invoked on each node at commit). The integration layer `raftdb.c` is pure glue: "an engine on top of Raft."

## 3. Failover — When the Leader Dies

The real test of HA is **when the leader dies.** The test aims squarely at it:

1. **Crash** the leader (node 0).
2. The survivors `{1,2}`, their heartbeats cut off, time out → **elect a new leader** (higher term).
3. The client keeps writing to the new leader → replication continues.
4. Confirm the surviving nodes are still **consistent** (8 rows).

```
  ok   failover: a new leader takes over
  ok   after failover: survivors have 8 rows (replication continues)
  ok   after failover: the two survivors still match
```

That **committed data isn't lost** is no accident. [Part 28's Leader Completeness](/blog/project/db-hobby/db-hobby-28-raft-consensus) (only a node holding the committed entries can become leader) guarantees it — the new leader necessarily has everything the old leader committed. The safety built so carefully in Parts 28–30 is **cashed out** here as "no data loss even when the leader dies."

## 4. The Honest Boundary

- **Stale reads.** Reads run directly on some node's engine — if that node lags, you can see a stale value. Making reads guarantee the latest commit — **linearizable reads (leader lease/ReadIndex)** — is exactly the **next part's** topic. This part creates that problem; the next solves it.
- **No crashed-node rejoin.** Reviving a crashed node would re-apply the committed log, and since the engine **doesn't durably track "which Raft index it has applied,"** INSERTs would **duplicate** (unlike the [register SM](/blog/project/db-hobby/db-hobby-28-raft-consensus), SQL application isn't idempotent). Persisting an applied-index in the engine is the prerequisite for rejoin — a frontier. So this part goes as far as failover (takeover).
- **In-process simulated network.** The seq/shared-memory simplification above. Socket wiring sits on [Part 26](/blog/project/db-hobby/db-hobby-26-tcp-replication).
- **Apply failures are surfaced (caught by adversarial review).** An independent subagent review found a real hole: if the apply callback **swallows** `db_exec`'s failure, Raft's `last_applied` advances while the engine doesn't change, so that node **diverges permanently** (on a node-local error like a full disk). SMR's premise "apply is deterministic" can break because of file-I/O side effects. I fixed it to **detect** failures via an `apply_errors` count — a real system would halt or re-sync such a node (that re-sync is the rejoin frontier); here it goes as far as not hiding the divergence.

## 5. Wrap-up — Completing the Distributed Axis

- Wired Parts 28–32's **Raft (consensus)** and db.c's **engine** together via **state-machine replication** — not a "standalone module" but a **genuinely replicated HA DB.**
- Textbook SMR: only **propose** the write, then **all nodes apply in the same order after commit** → full convergence.
- **Even when the leader dies**, a new leader takes over and [Leader Completeness](/blog/project/db-hobby/db-hobby-28-raft-consensus) preserves committed data — real failover.
- An honest simplification (in-process seq/shared memory) kept **raft.c untouched**. Honest boundary: stale reads (→ next part) and rejoin are frontiers.

The **distributed axis** that began in Part 25 peaks here — replication (25–26) → consensus (28–30) → membership (32) → and, layering all of it onto the real engine, an **HA DB (33)**. Where most "I built a database" projects stop, db-hobby traced out, by hand, **a database that survives leader death.**

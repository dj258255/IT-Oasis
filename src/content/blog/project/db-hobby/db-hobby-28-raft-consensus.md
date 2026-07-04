---
title: 'Raft 합의 — primary가 죽으면 누가 대신 서나, split-brain은 어떻게 막나'
titleEn: 'Raft Consensus — Who Takes Over When the Primary Dies, and How to Prevent Split-Brain'
description: "25·26편의 복제는 primary가 '이미 정해진' 상태에서 WAL을 replica로 흘렸다. 하지만 primary가 죽으면 누가 대신 서나? 두 노드가 서로 리더라 우기는 split-brain은 어떻게 막나? 이건 복제가 아니라 '합의(consensus)'의 문제고, Raft(Ongaro & Ousterhout 2014)가 푼다. 이 편은 Raft §5의 세 조각을 구현한다: 리더 선출(term·RequestVote·과반), 로그 복제(AppendEntries·prev 검사·과반 커밋), 안전성 5종(Election Safety·Leader Append·Log Matching·Leader Completeness·State Machine Safety). 핵심 설계 결정: 26편은 복제를 진짜 소켓으로 날랐지만 Raft는 일부러 결정적 시뮬레이션 네트워크 위에서 돈다 — 합의의 정확성은 분단·크래시·재정렬 같은 적대적 스케줄링에서 증명해야 하는데 벽시계 소켓으론 그걸 결정적으로 재현할 수 없기 때문이다(6.824 방식). 노드는 순수 로직(tick+recv), 테스트 하버스가 논리 시계·라우터·분단 행렬을 소유한다. 검증: 분단→새 리더→옛 리더 강등→로그 화해, 선거 제약, 크래시 재시작 복구. 정직한 경계: 스냅샷·멤버십 변경·디스크 지속성 배선·선형화 읽기는 프론티어."
descriptionEn: "The replication of Parts 25 and 26 streamed WAL from a primary that was 'already decided.' But who takes over when the primary dies? How do you stop split-brain, where two nodes both claim to be leader? That's not replication but consensus, and Raft (Ongaro & Ousterhout 2014) solves it. This part implements Raft §5's three pieces: leader election (terms, RequestVote, majority), log replication (AppendEntries, prev checks, majority commit), and the five safety properties (Election Safety, Leader Append, Log Matching, Leader Completeness, State Machine Safety). The key design decision: Part 26 carried replication over real sockets, but Raft deliberately runs on a deterministic simulated network — because consensus correctness must be proven under adversarial scheduling (partitions, crashes, reorderings), which wall-clock sockets can't reproduce deterministically (the MIT 6.824 approach). Nodes are pure logic (tick + recv); the test harness owns the logical clock, router, and partition matrix. Verified: partition→new leader→old leader demotion→log reconciliation, election restriction, crash-restart recovery. Honest boundary: snapshots, membership changes, disk persistence wiring, and linearizable reads are frontiers."
date: 2026-07-04
tags:
  - C
  - Database Internals
  - Raft
  - Consensus
  - Distributed Systems
  - Fault Tolerance
  - Learning
category: study/db-hobby
coverImage: /uploads/project/db-hobby/cover.svg
draft: false
series: "db-hobby"
seriesOrder: 28
---

## 0. 들어가며 — 복제가 대답 못 하는 질문

[25편](/blog/project/db-hobby/db-hobby-25-replication)·[26편](/blog/project/db-hobby/db-hobby-26-tcp-replication)에서 복제를 놓았어요. primary가 WAL을 흘리면 replica가 따라옵니다. 하지만 그 복제는 한 가지를 **전제**하고 있었죠 — "primary가 누구인지 이미 정해져 있다."

그럼 이런 질문엔 어떻게 답할까요?

- **primary가 죽으면 누가 대신 서나?** 남은 replica 중 하나가 승격해야 하는데, 누가?
- 두 노드가 각자 "내가 primary다"라고 우기면(**split-brain**) 어떻게 막나? 둘 다 쓰기를 받으면 데이터가 갈라집니다.
- 네트워크가 분단돼 한쪽만 살아 있을 때, 그 한쪽이 안전하게 진행해도 되나?

이건 복제로는 못 풉니다. **합의(consensus)** 의 문제예요 — 여러 노드가 "무엇이 진실인지"에 **동의**하는 것. 2014년 Diego Ongaro와 John Ousterhout가 이해하기 쉽게 설계한 **Raft**가 이걸 풉니다. 이 편은 그 핵심을 구현해요.

## 1. Raft의 세 조각

Raft(논문 §5)는 큰 문제를 세 조각으로 나눕니다.

### ① 리더 선출

모든 노드는 셋 중 하나예요: **Follower · Candidate · Leader.** 그리고 시간은 **term**(임기)이라는 논리적 시대로 나뉩니다.

- 평소 Follower는 Leader의 하트비트를 받습니다.
- 하트비트가 **선거 타임아웃**만큼 안 오면(리더가 죽었나?), Follower는 **Candidate**가 되어 `term`을 +1 하고 자기에게 투표한 뒤, 남들에게 `RequestVote`를 보냅니다.
- **과반**의 표를 받으면 **Leader**가 됩니다. 한 term에 리더는 **최대 하나**(Election Safety) — 과반은 겹칠 수 없으니까요.

![Raft: 역할 전이 · 로그 복제와 과반 커밋 · 분단 안전성](/uploads/project/db-hobby/raft-consensus.svg)

### ② 로그 복제

리더는 클라이언트 명령을 자기 **로그**에 append하고, `AppendEntries`로 팔로워에게 퍼뜨립니다. 각 팔로워는 **prevLogIndex/prevLogTerm** 검사로 "내 로그가 리더와 여기까지 일치하나"를 확인하고, 어긋나면 거절해요. 리더는 거절받으면 `nextIndex`를 한 칸 낮춰 재시도하며, 결국 일치하는 지점을 찾아 그 뒤 **갈린 꼬리를 리더 것으로 덮어씁니다**(Log Matching).

엔트리가 **과반**에 복제되면 리더는 그걸 **커밋**하고 상태기계에 적용합니다.

### ③ 안전성 — 커밋된 것은 안 뒤집힌다

가장 미묘한 부분이에요. 두 규칙이 이걸 보장합니다:

- **선거 제약**(§5.4.1): 후보의 로그가 투표자만큼 **최신이 아니면 표를 안 준다.** 그래서 커밋된 엔트리를 가진 노드만 리더가 될 수 있어요 — 커밋된 데이터가 사라지지 않습니다(Leader Completeness).
- **현재-term 커밋 규칙**(§5.4.2): 리더는 **자기 현재 term의 엔트리**가 과반에 닿을 때만 커밋합니다. 옛 term의 엔트리를 과반 복제됐다고 성급히 커밋하면 나중에 뒤집힐 수 있는 미묘한 경우를 막아요.

## 2. 핵심 설계 결정 — 왜 소켓이 아니라 시뮬레이션인가

[26편](/blog/project/db-hobby/db-hobby-26-tcp-replication)은 복제를 **진짜 소켓**으로 날랐어요. 그런데 Raft는 일부러 **결정적 시뮬레이션 네트워크** 위에서 돌립니다. 이게 이 편에서 가장 중요한 판단이에요.

> 합의의 정확성은 **적대적 스케줄링** — 네트워크 분단, 노드 크래시, 메시지 재정렬·지연 — 에서 증명해야 한다. 그런데 실제 소켓 + 벽시계 타이머로는 그 시나리오를 **결정적으로 재현할 수 없다.**

"노드3을 정확히 이 순간 고립시키고, 이 메시지를 저 메시지보다 늦게 배달하고, 리더를 크래시시킨 뒤 되살린다" — 이런 걸 소켓으로 하면 매번 타이밍이 달라져 재현이 안 됩니다. 실제로 [26편의 소켓 테스트](/blog/project/db-hobby/db-hobby-26-tcp-replication)는 스레드 조율 하나가 어긋나 교착에 빠졌었죠.

그래서 MIT 6.824를 비롯한 검증된 Raft들이 택하는 길을 그대로 갑니다:

- **Raft 노드는 순수 로직이다** — `raft_tick`(논리 시계 한 칸)과 `raft_recv`(RPC 처리)뿐. 소켓도 스레드도 벽시계도 모릅니다.
- **테스트 하버스가 세계를 소유한다** — 논리 시계, 메시지 라우터, **분단 행렬**(`connected[i][j]`), 노드 생사(`alive[i]`)를 단일 스레드로 굴립니다. 원하는 어떤 스케줄이든 결정적으로 재현할 수 있어요.

정리하면: **소켓(26편)은 프로덕션 운반 수단, 이 시뮬레이터는 프로토콜이 옳음을 증명하는 도구.** 둘은 배타적이지 않아요 — 검증된 Raft 로직을 26편 같은 소켓 위에 얹으면 진짜 분산 시스템이 됩니다(그 배선이 프론티어).

## 3. 가장 어려운 시나리오 — 분단과 화해

`test_raft`(26 checks)의 백미는 **네트워크 분단**입니다. 5노드 클러스터에서:

1. 노드0이 리더(term 1). 엔트리 하나를 커밋.
2. **리더를 소수파로 고립**: 노드0 ↔ {1,2,3,4} 단절.
3. 고립된 노드0에 새 커맨드를 넣지만 — **과반이 없어 영영 커밋 안 됨.** 노드0은 자기가 여전히 리더인 줄 알아요(Raft에서 이건 **정확한** 동작 — 더 높은 term을 들어야 물러납니다).
4. 다수파 {1,2,3,4}는 하트비트가 끊기자 타임아웃 → **term 2로 새 리더** 선출 → 계속 커밋.
5. **치유**(재연결): 옛 리더 노드0은 더 높은 term(2)을 보고 **즉시 팔로워로 강등**. 새 리더의 `AppendEntries`가 노드0의 **갈린 꼬리를 덮어써** 모두가 동일 로그로 수렴합니다.

이 시나리오 하나가 Raft의 핵심 불변식들을 한꺼번에 증명해요:

```
  ok   분단: 다수파에서 새 리더 선출
  ok   분단: 고립된 옛 리더는 (새 값을) 커밋 못 함
  ok   치유: 옛 리더가 팔로워로 강등
  ok   치유: 옛 리더의 갈린 꼬리가 리더 로그로 덮어써짐(Log Matching)
  ok   치유: 모든 노드가 동일 로그로 수렴(SM Safety)
```

여기서 배운 교훈 하나: 처음엔 테스트가 "새 리더 선출"에서 실패했는데, 알고 보니 **구현이 아니라 테스트가 틀렸어요.** `find_leader()`가 노드0부터 스캔해 **고립된 옛 리더(여전히 LEADER 역할)** 를 집었던 거죠. Raft 불변식은 "전체에 리더 하나"가 아니라 **"한 term에 리더 하나"** 입니다 — 분단 중 두 리더(옛 term1·새 term2)의 공존은 정상이에요. 그래서 "가장 높은 term의 리더"를 찾도록 고쳤습니다. 분산 시스템의 불변식을 정확히 이해해야 테스트도 옳게 쓸 수 있다는 걸 몸으로 배운 지점이에요.

그 밖에 검증한 것: **선거 제약**(로그가 뒤진 후보는 표를 못 받음) · **크래시 재시작**(다운됐던 노드가 되살아나 커밋 로그를 재적용해 따라잡음, redo가 idempotent라 안전 — [14편](/blog/project/db-hobby/db-hobby-14-steal-undo)과 같은 성질).

## 4. 정직한 경계 — 어디까지가 Raft이고 어디부터가 프론티어인가

이건 Raft의 **합의 코어**(§5)입니다. 진짜 프로덕션 Raft까지는 아직 멀어요:

- **스냅샷/로그 압축 없음**(§7). 로그가 무한히 자랍니다. 실제 시스템은 주기적으로 상태기계를 스냅샷하고 그 앞 로그를 버려요.
- **멤버십 변경 없음**(§6). 클러스터 크기가 고정입니다. 노드를 안전하게 추가/제거하려면 joint consensus가 필요해요.
- **디스크 지속성은 모델링만.** `currentTerm`·`votedFor`·`log`는 크래시에도 살아남아야 하는데(안 그러면 안전성이 깨짐), 여기선 구조체로 두고 `crash_restart`가 휘발 상태만 리셋해 그걸 흉내 냅니다. db-hobby 본체엔 [WAL이 있으니](/blog/project/db-hobby/db-hobby-15-noforce-checkpoint) 그 지속 상태를 실제로 fsync하는 배선이 자연스러운 다음 일이에요.
- **클라이언트 상호작용 없음** — 선형화 읽기(리더 리스), 중복 요청 제거 등은 없습니다. 상태기계는 테스트가 관찰하는 `int64` 커맨드 열이에요.
- **엔진 미배선.** [22·24·27편](/blog/project/db-hobby/db-hobby-27-lsm-engine)처럼 독립 모듈입니다. 이 Raft로 db-hobby의 WAL 자체를 복제해 진짜 고가용 DB로 만드는 건 — 25~28편이 그 조각들을 다 깔아 뒀지만 — 통합이라는 별도의 큰 산입니다.

## 5. 정리 — 그리고 분산 축을 닫으며

- 복제(25·26편)는 "primary가 정해져 있다"를 전제했다. **primary가 죽으면?** 은 합의의 문제 — Raft가 푼다.
- Raft 세 조각: **리더 선출**(term·과반) · **로그 복제**(prev 검사·과반 커밋) · **안전성**(선거 제약·현재-term 규칙).
- 핵심 설계: **소켓이 아니라 결정적 시뮬레이션** — 합의 정확성은 적대적 스케줄링에서 증명해야 하니까. 소켓(26편)=운반, 시뮬=증명.
- 분단 시나리오가 5대 안전성을 한꺼번에 증명한다: 새 리더 선출 · 옛 리더 강등 · 로그 화해 · 합의 수렴.
- 정직한 경계: 스냅샷·멤버십 변경·디스크 지속성 배선·선형화 읽기·엔진 통합은 프론티어.

25편에서 시작한 **분산 축**(H 트랙)이 여기서 한 바퀴를 돕니다 — 로그 시핑 복제(25) → 네트워크 전송(26) → 그리고 그 위의 합의(28). "DB를 만들었다"는 프로젝트 대부분에 없는, 진짜 분산 시스템의 뼈대까지 손으로 짚어 봤어요.

<!-- EN -->

## 0. Intro — The Question Replication Can't Answer

In [Part 25](/blog/project/db-hobby/db-hobby-25-replication) and [Part 26](/blog/project/db-hobby/db-hobby-26-tcp-replication) I laid down replication. The primary streams WAL, the replica follows. But that replication **assumed** one thing — "who the primary is, is already decided."

So how do we answer these?

- **Who takes over when the primary dies?** One of the surviving replicas must be promoted — but which?
- If two nodes each claim "I'm the primary" (**split-brain**), how do we stop it? If both take writes, the data diverges.
- When the network partitions and only one side is alive, may that side safely make progress?

Replication can't solve this. It's a problem of **consensus** — multiple nodes **agreeing** on "what is true." **Raft**, designed for understandability by Diego Ongaro and John Ousterhout in 2014, solves it. This part implements its core.

## 1. Raft's Three Pieces

Raft (paper §5) splits the big problem into three.

### ① Leader Election

Every node is one of three: **Follower · Candidate · Leader.** And time is divided into logical eras called **terms.**

- Normally a Follower receives the Leader's heartbeats.
- If no heartbeat arrives within an **election timeout** (is the leader dead?), the Follower becomes a **Candidate**, bumps its `term` by 1, votes for itself, and sends `RequestVote` to the others.
- Winning a **majority** of votes makes it the **Leader**. There is **at most one** leader per term (Election Safety) — majorities can't overlap.

![Raft: role transitions · log replication and majority commit · partition safety](/uploads/project/db-hobby/raft-consensus.svg)

### ② Log Replication

The leader appends a client command to its **log** and spreads it via `AppendEntries`. Each follower uses the **prevLogIndex/prevLogTerm** check to confirm "does my log match the leader up to here," and rejects if not. On rejection the leader lowers `nextIndex` by one and retries, eventually finding the matching point and **overwriting the divergent tail with its own** (Log Matching).

Once an entry is replicated to a **majority**, the leader **commits** it and applies it to the state machine.

### ③ Safety — Committed Means Never Overturned

The subtlest part. Two rules guarantee it:

- **Election restriction** (§5.4.1): a candidate is **denied a vote if its log isn't as up-to-date** as the voter's. So only a node holding the committed entries can become leader — committed data never disappears (Leader Completeness).
- **Current-term commit rule** (§5.4.2): a leader commits only when an entry **from its own current term** reaches a majority. Committing an old-term entry just because it's majority-replicated could be overturned later — this rule blocks that subtle case.

## 2. The Key Design Decision — Why a Simulation, Not Sockets

[Part 26](/blog/project/db-hobby/db-hobby-26-tcp-replication) carried replication over **real sockets.** Yet Raft deliberately runs on a **deterministic simulated network.** This is the most important call in this part.

> Consensus correctness must be proven under **adversarial scheduling** — network partitions, node crashes, message reordering and delay. But real sockets + wall-clock timers **cannot reproduce those scenarios deterministically.**

"Isolate node 3 at exactly this moment, deliver this message after that one, crash the leader and revive it" — do that over sockets and the timing differs every run, so it isn't reproducible. In fact [Part 26's socket test](/blog/project/db-hobby/db-hobby-26-tcp-replication) fell into a deadlock from a single thread-coordination slip.

So I take the path taken by battle-tested Raft implementations including MIT 6.824:

- **A Raft node is pure logic** — just `raft_tick` (one logical clock step) and `raft_recv` (RPC handling). It knows nothing of sockets, threads, or wall clocks.
- **The test harness owns the world** — the logical clock, the message router, the **partition matrix** (`connected[i][j]`), and node liveness (`alive[i]`), all single-threaded. Any schedule you want is reproducible deterministically.

In short: **the socket (Part 26) is the production transport, this simulator is the tool that proves the protocol correct.** They aren't exclusive — putting the verified Raft logic on top of Part 26's sockets makes a real distributed system (that wiring is a frontier).

## 3. The Hardest Scenario — Partition and Reconciliation

The centerpiece of `test_raft` (26 checks) is a **network partition.** In a 5-node cluster:

1. Node 0 is leader (term 1). One entry is committed.
2. **Isolate the leader into the minority**: cut node 0 ↔ {1,2,3,4}.
3. New commands go to the isolated node 0 — but **never commit, having no majority.** Node 0 still thinks it's the leader (in Raft this is **correct** — it steps down only upon hearing a higher term).
4. The majority {1,2,3,4}, its heartbeats cut off, times out → elects a **new leader at term 2** → keeps committing.
5. **Heal** (reconnect): the old leader node 0, seeing the higher term (2), **immediately demotes to follower.** The new leader's `AppendEntries` **overwrites node 0's divergent tail** so everyone converges to the same log.

This one scenario proves Raft's core invariants all at once:

```
  ok   partition: a new leader elected in the majority
  ok   partition: the isolated old leader can't commit (the new value)
  ok   heal: the old leader demotes to follower
  ok   heal: the old leader's divergent tail is overwritten by the leader's log (Log Matching)
  ok   heal: all nodes converge to the same log (SM Safety)
```

One lesson here: at first the test failed at "new leader elected," and it turned out **the test was wrong, not the implementation.** `find_leader()` scanned from node 0 and picked the **isolated old leader (still in the LEADER role).** The Raft invariant isn't "one leader overall" but **"one leader per term"** — two leaders coexisting during a partition (old term 1, new term 2) is normal. So I fixed it to find "the leader with the highest term." A hands-on lesson that you must understand a distributed system's invariant precisely to even write its test correctly.

Also verified: the **election restriction** (a candidate with a lagging log gets no votes) · **crash restart** (a downed node revives and catches up by re-applying the committed log, safe because redo is idempotent — the same property as [Part 14](/blog/project/db-hobby/db-hobby-14-steal-undo)).

## 4. The Honest Boundary — Where Raft Ends and the Frontier Begins

This is Raft's **consensus core** (§5). It's still far from production Raft:

- **No snapshot / log compaction** (§7). The log grows unbounded. Real systems periodically snapshot the state machine and discard the log before it.
- **No membership changes** (§6). The cluster size is fixed. Safely adding/removing nodes needs joint consensus.
- **Disk persistence is only modeled.** `currentTerm`, `votedFor`, and `log` must survive a crash (or safety breaks); here they live in a struct and `crash_restart` resets only the volatile state to imitate that. db-hobby's core [already has a WAL](/blog/project/db-hobby/db-hobby-15-noforce-checkpoint), so actually fsyncing that persistent state is a natural next step.
- **No client interaction** — linearizable reads (leader leases), duplicate-request dedup, etc. The state machine is an `int64` command sequence the test observes.
- **Not wired into the engine.** Like [Parts 22, 24, 27](/blog/project/db-hobby/db-hobby-27-lsm-engine), it's a standalone module. Using this Raft to replicate db-hobby's own WAL into a truly highly-available DB — though Parts 25–28 laid all the pieces — is a separate large mountain of integration.

## 5. Wrap-up — and Closing the Distributed Axis

- Replication (Parts 25–26) assumed "the primary is decided." **What if the primary dies?** is a consensus problem — Raft solves it.
- Raft's three pieces: **leader election** (terms, majority) · **log replication** (prev checks, majority commit) · **safety** (election restriction, current-term rule).
- Key design: **a deterministic simulation, not sockets** — because consensus correctness must be proven under adversarial scheduling. Socket (Part 26) = transport, simulation = proof.
- The partition scenario proves all five safety properties at once: new leader elected · old leader demoted · log reconciled · consensus converges.
- Honest boundary: snapshots, membership changes, disk persistence wiring, linearizable reads, and engine integration are frontiers.

The **distributed axis** (Track H) that began in Part 25 comes full circle here — log-shipping replication (25) → network transport (26) → and consensus on top (28). The skeleton of a real distributed system, absent from most "I built a database" projects, traced out by hand.

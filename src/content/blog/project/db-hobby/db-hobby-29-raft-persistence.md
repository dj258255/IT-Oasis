---
title: 'Raft 지속성 — votedFor 한 줄이 안 남으면 리더가 둘 생긴다'
titleEn: 'Raft Persistence — Lose One votedFor Line and You Get Two Leaders'
description: "28편에서 Raft의 지속 상태(currentTerm·votedFor·log)는 '크래시에도 살아남아야 한다'고 적었지만, 실제로는 구조체로 모델링만 했다. 이 편은 그걸 진짜 디스크에 fsync한다. 왜 중요한가? votedFor 한 줄이 크래시에서 안 남으면, 한 노드가 같은 term에 후보 A에게 투표하고 크래시한 뒤 (기억 없이) 재시작해 같은 term에 후보 B에게도 투표할 수 있다 — 그러면 A와 B가 둘 다 과반을 얻어 리더가 둘 생기고, Election Safety가 붕괴한다(split-brain). 이 편은 raft_save/raft_load로 지속 3종을 파일에 fsync 저장·복구하고, '진짜 디스크 라운드트립'(구조체를 처음부터 다시 만들고 디스크에서 복구)으로 이중 투표 방지를 증명한다. 이건 15편 WAL의 no-force 철학과 같은 뿌리다 — 무엇을 언제 fsync하느냐가 정확성의 경계이고, 표는 '응답 전에' 내구화돼야 한다. 정직한 경계: 스냅샷(§7)·멤버십 변경(§6)·핸들러 안에서의 자동 persist 배선은 프론티어."
descriptionEn: "In Part 28 I wrote that Raft's persistent state (currentTerm, votedFor, log) 'must survive a crash,' but in reality it was only modeled with a struct. This part actually fsyncs it to disk. Why does it matter? If a single votedFor line doesn't survive a crash, a node can vote for candidate A in a term, crash, restart (with no memory), and vote for candidate B in the same term — then A and B both win a majority and you get two leaders, collapsing Election Safety (split-brain). This part saves and restores the persistent triple to a file via raft_save/raft_load, and proves double-vote prevention with a 'real disk round-trip' (rebuild the struct from scratch and restore from disk). This shares a root with Part 15's no-force WAL — what you fsync and when is the boundary of correctness, and a vote must be durable 'before the reply.' Honest boundary: snapshots (§7), membership changes (§6), and auto-persist wiring inside the handlers are frontiers."
date: 2026-07-04
tags:
  - C
  - Database Internals
  - Raft
  - Consensus
  - Durability
  - Distributed Systems
  - Learning
category: study/db-hobby
coverImage: /uploads/project/db-hobby/cover.svg
draft: false
series: "db-hobby"
seriesOrder: 29
---

## 0. 들어가며 — 28편이 미룬 한 줄

[28편](/blog/project/db-hobby/db-hobby-28-raft-consensus)에서 Raft를 만들며 정직하게 적었어요:

> "디스크 지속성은 모델링만. `currentTerm`·`votedFor`·`log`는 크래시에도 살아남아야 하는데(안 그러면 안전성이 깨짐), 여기선 구조체로 두고 `crash_restart`가 휘발 상태만 리셋해 그걸 흉내 냅니다."

`crash_restart`는 **인메모리 구조체**의 지속 필드를 그냥 놔뒀을 뿐이에요 — 진짜 프로세스가 죽으면 그 메모리도 다 사라지는데 말이죠. 이 편은 그 흉내를 **진짜 디스크**로 바꿉니다. 짧지만, **안 하면 합의 전체가 무너지는** 한 줄에 관한 이야기예요.

## 1. votedFor 한 줄이 왜 목숨인가

Raft는 지속 상태 셋을 요구합니다: `currentTerm`(현재 임기), `votedFor`(이번 term에 누구에게 표를 줬나), `log`(엔트리들). 이 셋은 **디스크에 내구화된 뒤에야** RPC에 응답해야 해요(§5.1). 나머지(commitIndex, 리더 상태 등)는 휘발이라 크래시 때 잃어도 재구성됩니다.

왜 하필 이 셋이 목숨일까요? `votedFor`로 시나리오를 그려 봅시다:

1. 노드 V가 **term 5**에서 후보 A에게 투표합니다(`votedFor = A`).
2. V가 **크래시**합니다.
3. V가 재시작하는데 — `votedFor`를 **안 남겼다면** 기억이 없어요(`votedFor = 없음`).
4. 후보 B가 **같은 term 5**에서 표를 구합니다. V는 "난 아직 이 term에 투표 안 했지"라며 **B에게도 투표**합니다.
5. 결과: A는 (V 포함) 과반을, B도 (V 포함) 과반을 얻어 **term 5에 리더가 둘.**

리더가 둘이면 둘 다 쓰기를 받아 데이터가 갈라집니다 — **split-brain.** Raft의 첫 번째 안전성인 **Election Safety(한 term에 리더 하나)** 가 무너지는 거죠. 그 붕괴를 막는 유일한 것이, 크래시를 살아남는 `votedFor` **한 줄**입니다.

![votedFor를 fsync로 남기면 크래시 후 재시작해도 같은 term 두 번째 후보에게 표를 거절한다](/uploads/project/db-hobby/raft-persistence.svg)

## 2. raft_save / raft_load — fsync가 경계다

구현은 단순합니다. `raft_save`는 지속 3종을 파일에 쓰고 **fsync**해요:

```c
int raft_save(const Raft *r, const char *path) {
    int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    write(fd, &r->current_term, 8);
    write(fd, &r->voted_for, 4);
    write(fd, &r->log_len, 8);
    write(fd, r->log, r->log_len * sizeof(RaftEntry));
    fsync(fd);   /* ← 여기를 지나야 '저장됨'. 내구성의 지점. */
    close(fd);
}
```

`raft_load`는 그 반대 — 초기화된 노드에 디스크의 지속 상태를 되읽습니다. **휘발 상태는 건드리지 않아요**(init 기본값 그대로): 크래시 시 휘발은 잃어도 되니까(§5.1).

이 `fsync`가 어디서 많이 본 얼굴이죠? [15편의 no-force WAL](/blog/project/db-hobby/db-hobby-15-noforce-checkpoint)입니다.

> **무엇을, 언제 fsync하느냐가 정확성의 경계다.**

15편에서 커밋의 내구성 지점이 로그 fsync 하나였듯, Raft에서 표의 내구성 지점은 `raft_save`의 fsync 하나예요. 그리고 규칙도 같은 결입니다 — 표는 **응답을 보내기 전에** 내구화돼야 합니다(그래야 "투표했다"고 답한 뒤 크래시해도 그 표가 살아 있죠). db-hobby가 1편부터 붙들어 온 "로그가 진실의 원천"이라는 주제가, 분산 합의에서도 똑같이 성립하는 겁니다.

## 3. 검증 — 진짜 디스크 라운드트립

여기서 테스트를 **정직하게** 짜는 게 중요했어요. `crash_restart`처럼 인메모리 필드를 놔두는 걸론 "지속성"을 증명 못 합니다 — 그건 애초에 안 죽은 거니까요. 그래서 **진짜 크래시**를 흉내 냈습니다:

```c
/* V가 term5에서 후보 0에게 투표하고 디스크에 저장 */
raft_recv(V, &request_vote_from_0, ...);   /* votedFor = 0 */
raft_save(V, path);                         /* fsync */

/* 진짜 크래시: 구조체를 '처음부터 다시' 만들고(메모리 완전히 날림) 디스크에서 복구 */
Raft V2;
raft_init(&V2, ...);                         /* votedFor = -1 (기억 없음) */
raft_load(&V2, path);                        /* votedFor = 0 되살림 */

/* 같은 term5에서 후보 2가 표를 구한다 -> 거절돼야 한다 */
raft_recv(&V2, &request_vote_from_2, &rep, ...);
assert(rep.vote_granted == 0);              /* 이미 0에게 줬다 */
```

`raft_init`으로 **완전히 새 구조체**를 만든 뒤 `raft_load`로 디스크에서 되살리는 게 핵심이에요. 이러면 인메모리 상태가 진짜로 0에서 시작하므로, 표가 살아남은 건 **오직 디스크 덕분**임이 증명됩니다.

```
  ok   지속성: 새 노드는 votedFor 없음(-1)
  ok   지속성: 디스크에서 지속 상태 복구
  ok   지속성: term5·votedFor=0가 크래시를 살아남음
  ok   지속성: 복구 후 같은 term 다른 후보엔 표 거절(이중 투표 방지 → Election Safety)
```

그리고 **커밋된 로그**도 디스크 라운드트립을 그대로 살아남는지 봅니다(엔트리 순서·값·term 보존). 합쳐서 지속성 11개 체크가 붙어, Raft 스위트는 **37개**가 됐어요.

## 4. 정직한 경계

- **핸들러 안에서 자동 persist는 안 했다.** 진짜 Raft는 `raft_save`를 RPC 핸들러 **안에서**, 응답을 내보내기 직전에 부릅니다(표가 내구화된 뒤 응답). 여기선 코어(`raft_recv`)를 순수하게 유지하려고 하버스가 크래시 지점에서 `raft_save`를 호출하는 방식으로 모델링했어요 — 디스크 라운드트립 자체는 진짜입니다.
- **스냅샷/로그 압축 없음**(§7). 지속 파일이 로그 전체를 담으니, 로그가 자라면 저장 비용도 커집니다. 주기적 스냅샷으로 앞 로그를 버리는 게 다음 일 — 28편에서 이미 프론티어로 짚었죠.
- **멤버십 변경 없음**(§6), **선형화 읽기 없음**은 여전합니다.
- **db-hobby의 WAL과 미배선.** 이 지속성은 자체 파일 포맷을 씁니다. [15편의 WAL](/blog/project/db-hobby/db-hobby-15-noforce-checkpoint)에 Raft 상태를 실어 하나의 내구성 계층으로 합치는 건 자연스러운 통합이지만, 별도 작업이에요.

## 5. 정리

- 28편이 미룬 것: 지속 상태를 **진짜 디스크**에 남기기. 이 편이 `raft_save`/`raft_load`로 닫았다.
- **votedFor 한 줄**이 안 남으면 같은 term에 이중 투표 → 리더 둘 → **Election Safety 붕괴**. 지속성은 장식이 아니라 안전성의 뿌리.
- **fsync가 경계**다 — [15편 no-force WAL](/blog/project/db-hobby/db-hobby-15-noforce-checkpoint)과 같은 철학. 표는 응답 전에 내구화.
- **진짜 디스크 라운드트립**(구조체 재생성 + load)으로 이중 투표 방지를 증명. Raft 스위트 37 checks.
- 정직한 경계: 핸들러 자동 persist·스냅샷·멤버십 변경·WAL 통합은 프론티어.

<!-- EN -->

## 0. Intro — The One Line Part 28 Deferred

Building Raft in [Part 28](/blog/project/db-hobby/db-hobby-28-raft-consensus), I honestly wrote:

> "Disk persistence is only modeled. `currentTerm`, `votedFor`, and `log` must survive a crash (or safety breaks); here they live in a struct and `crash_restart` resets only the volatile state to imitate that."

`crash_restart` merely left the **in-memory struct's** persistent fields untouched — but when a real process dies, that memory is gone too. This part swaps the imitation for **real disk.** Short, but a story about one line whose absence collapses the whole of consensus.

## 1. Why One votedFor Line Is Life or Death

Raft requires three persistent fields: `currentTerm` (the current term), `votedFor` (whom you voted for this term), and `log` (the entries). These three must be **durable on disk before** you reply to an RPC (§5.1). The rest (commitIndex, leader state, etc.) is volatile — lost on a crash but reconstructible.

Why exactly these three? Let's draw the scenario with `votedFor`:

1. Node V votes for candidate A in **term 5** (`votedFor = A`).
2. V **crashes.**
3. V restarts — and if it **didn't persist** `votedFor`, it has no memory (`votedFor = none`).
4. Candidate B asks for a vote in the **same term 5.** V thinks "I haven't voted this term yet" and **votes for B too.**
5. Result: A wins a majority (with V), and B wins a majority (with V) — **two leaders in term 5.**

Two leaders means both take writes and the data diverges — **split-brain.** Raft's first safety property, **Election Safety (one leader per term)**, collapses. The only thing preventing that collapse is a single `votedFor` line that survives the crash.

![Persist votedFor via fsync and even after a restart the node denies the second candidate in the same term](/uploads/project/db-hobby/raft-persistence.svg)

## 2. raft_save / raft_load — fsync Is the Boundary

The implementation is simple. `raft_save` writes the persistent triple to a file and **fsyncs**:

```c
int raft_save(const Raft *r, const char *path) {
    int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    write(fd, &r->current_term, 8);
    write(fd, &r->voted_for, 4);
    write(fd, &r->log_len, 8);
    write(fd, r->log, r->log_len * sizeof(RaftEntry));
    fsync(fd);   /* ← only past this line is it "saved." The durability point. */
    close(fd);
}
```

`raft_load` does the reverse — reading the disk's persistent state into an initialized node. It **doesn't touch the volatile state** (leaves init defaults): volatile may be lost on a crash (§5.1).

Where have we seen this `fsync` before? [Part 15's no-force WAL](/blog/project/db-hobby/db-hobby-15-noforce-checkpoint).

> **What you fsync, and when, is the boundary of correctness.**

Just as Part 15's durability point for a commit was a single log fsync, Raft's durability point for a vote is the single fsync in `raft_save`. And the rule has the same grain — a vote must be durable **before the reply** goes out (so if you crash after answering "I voted," that vote is still there). The theme db-hobby has held since Part 1 — "the log is the source of truth" — holds identically in distributed consensus.

## 3. Verification — A Real Disk Round-Trip

Writing the test **honestly** mattered here. Leaving in-memory fields alone like `crash_restart` can't prove "persistence" — that never died in the first place. So I imitated a **real crash**:

```c
/* V votes for candidate 0 in term 5 and saves to disk */
raft_recv(V, &request_vote_from_0, ...);   /* votedFor = 0 */
raft_save(V, path);                         /* fsync */

/* real crash: rebuild the struct from scratch (memory wiped) and restore from disk */
Raft V2;
raft_init(&V2, ...);                         /* votedFor = -1 (no memory) */
raft_load(&V2, path);                        /* votedFor = 0 restored */

/* candidate 2 asks for a vote in the same term 5 -> must be denied */
raft_recv(&V2, &request_vote_from_2, &rep, ...);
assert(rep.vote_granted == 0);              /* already gave it to 0 */
```

Making a **completely fresh struct** with `raft_init` and then reviving it from disk with `raft_load` is the point. This way the in-memory state genuinely starts from zero, proving the vote survived **only thanks to disk.**

```
  ok   persistence: a fresh node has no votedFor (-1)
  ok   persistence: persistent state restored from disk
  ok   persistence: term5 · votedFor=0 survived the crash
  ok   persistence: after restore, deny another candidate in the same term (double-vote prevention → Election Safety)
```

It also checks that the **committed log** survives the disk round-trip intact (entry order, values, terms preserved). Together, 11 persistence checks bring the Raft suite to **37.**

## 4. The Honest Boundary

- **No auto-persist inside the handlers.** Real Raft calls `raft_save` **inside** the RPC handler, right before sending the reply (persist the vote, then answer). Here, to keep the core (`raft_recv`) pure, I modeled it with the harness calling `raft_save` at the crash point — the disk round-trip itself is real.
- **No snapshot / log compaction** (§7). The persistent file holds the whole log, so as the log grows, the save cost grows too. Periodically snapshotting to discard the old log is next — already flagged as a frontier in Part 28.
- **No membership changes** (§6), **no linearizable reads** — still true.
- **Not wired into db-hobby's WAL.** This persistence uses its own file format. Carrying Raft state on [Part 15's WAL](/blog/project/db-hobby/db-hobby-15-noforce-checkpoint) as one durability layer is a natural integration, but a separate effort.

## 5. Wrap-up

- What Part 28 deferred: putting the persistent state on **real disk.** This part closed it with `raft_save`/`raft_load`.
- If **one votedFor line** doesn't survive, a double vote in the same term → two leaders → **Election Safety collapses.** Persistence isn't decoration; it's the root of safety.
- **fsync is the boundary** — the same philosophy as [Part 15's no-force WAL](/blog/project/db-hobby/db-hobby-15-noforce-checkpoint). A vote is durable before the reply.
- Proved double-vote prevention with a **real disk round-trip** (rebuild struct + load). Raft suite at 37 checks.
- Honest boundary: handler auto-persist, snapshots, membership changes, and WAL integration are frontiers.

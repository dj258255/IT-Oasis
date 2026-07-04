---
title: 'Raft 멤버십 변경 — 돌아가는 중에 노드를 더하고 빼기, 그리고 겹치는 과반'
titleEn: 'Raft Membership Changes — Adding and Removing Nodes Live, and Overlapping Majorities'
description: "28~31편으로 Raft가 합의·지속성·스냅샷·엔진 배선까지 왔지만, 클러스터 크기는 여전히 고정이었다 — 죽은 서버 교체도, 스케일 업도, 롤링 업그레이드도 못 한다. 이 편은 멤버십 변경(§6)을 구현한다. 핵심 위험: 3→5노드로 한꺼번에 바꾸면 옛 과반(3중 2)과 새 과반(5중 3)이 안 겹치는 순간이 생겨 각 구성이 서로 다른 리더를 뽑아 split-brain이 된다. 해법은 '단일 서버 변경' — 한 번에 한 노드만 add/remove하면 옛·새 과반이 수학적으로 항상 겹쳐 joint consensus 없이도 안전하다(etcd 방식). 구현은 고정 n_nodes를 member_mask 비트마스크로 바꿔 과반·투표·복제 대상을 전부 그 마스크로 계산하고, config 엔트리를 '커밋 때가 아니라 로그에 보자마자' 적용한다(§6 안전 규칙). 그런데 member_mask=full이면 예전과 동일이라 기존 57개 테스트가 버그를 못 잡는다 — 그래서 새 테스트가 partial 마스크(추가·제거)를 반드시 관통하고, 독립 서브에이전트가 적대적으로 리뷰했다. 정직한 경계: 제거된 노드가 live면 선거를 일으키는 §6의 유명한 disruption과 joint consensus는 프론티어(리뷰가 찾은 4건은 모두 수정됨)."
descriptionEn: "Parts 28–31 brought Raft to consensus, persistence, snapshots, and engine wiring — but the cluster size was still fixed: you couldn't replace a dead server, scale up, or do a rolling upgrade. This part implements membership changes (§6). The core risk: changing 3→5 nodes at once creates a moment where the old majority (2 of 3) and new majority (3 of 5) don't overlap, so each configuration elects a different leader — split-brain. The fix is single-server change — add/remove one node at a time so old and new majorities always overlap mathematically, safe without joint consensus (the etcd approach). The implementation swaps the fixed n_nodes for a member_mask bitmask, computing majority, votes, and replication targets over it, and adopts a config entry as soon as it appears in the log (not on commit — the §6 safety rule). But with member_mask==all, behavior is identical to before, so the existing 57 tests can't catch a bug — so a new test must drive partial masks (add and remove), and an independent subagent reviewed it adversarially. Honest boundary: a removed live node triggering elections (the famous §6 disruption) and joint consensus are frontiers (the four issues the review found are all fixed)."
date: 2026-07-05
tags:
  - C
  - Database Internals
  - Raft
  - Consensus
  - Membership
  - Distributed Systems
  - Learning
category: study/db-hobby
coverImage: /uploads/project/db-hobby/cover.svg
draft: false
series: "db-hobby"
seriesOrder: 32
---

## 0. 들어가며 — 고정된 클러스터의 한계

[28편(합의)](/blog/project/db-hobby/db-hobby-28-raft-consensus)·[29편(지속성)](/blog/project/db-hobby/db-hobby-29-raft-persistence)·[30편(스냅샷)](/blog/project/db-hobby/db-hobby-30-raft-snapshot)으로 Raft가 꽤 진짜에 가까워졌지만, 한 가지가 계속 고정돼 있었어요 — **클러스터 크기**. 3노드로 시작하면 영원히 3노드입니다. 그런데 실제 운영에선:

- 서버가 죽으면 **교체**해야 하고,
- 부하가 늘면 노드를 **추가**해야 하고,
- 무중단 업그레이드를 하려면 노드를 하나씩 **빼고 넣어야** 합니다.

이걸 돌아가는 클러스터에서 안전하게 하는 게 **멤버십 변경(§6)** 이에요. 그리고 "안전하게"가 생각보다 까다롭습니다.

## 1. 핵심 위험 — 겹치지 않는 과반

3노드 클러스터를 5노드로 **한꺼번에** 바꾼다고 해봅시다. 전환 순간에:

- 옛 구성 `{0,1,2}`의 과반은 **2**(3중 2).
- 새 구성 `{0,1,2,3,4}`의 과반은 **3**(5중 3).

문제는 이 둘이 **안 겹치는** 순간이 생긴다는 거예요. 노드 `{0,1}`은 옛 과반을 이루고(2), 노드 `{2,3,4}`는 새 과반을 이룹니다(3). 두 집합이 disjoint! 그러면 `{0,1}`이 옛 구성 기준으로 리더 A를 뽑고, `{2,3,4}`가 새 구성 기준으로 리더 B를 뽑아 — **같은 term에 리더가 둘**, split-brain입니다. [28편에서 그렇게 지키려 애쓴 Election Safety](/blog/project/db-hobby/db-hobby-28-raft-consensus)가 무너져요.

![Raft 멤버십: 단일 서버 변경으로 옛·새 과반이 겹치게, config 엔트리는 로그에 보자마자 적용](/uploads/project/db-hobby/raft-membership.svg)

## 2. 해법 — 한 번에 한 노드

Raft 논문의 답은 두 가지인데, 저자의 박사논문이 **더 단순한 쪽을 권합니다**: **단일 서버 변경(single-server change)** — 한 번에 **한 노드만** add하거나 remove한다.

왜 이게 안전할까요? 집합에서 원소 하나만 더하거나 빼면, **옛 과반과 새 과반은 반드시 겹칩니다.** 3→4로 갈 때 옛 과반은 2, 새 과반은 3인데, 3중 2(옛 과반)와 4중 3(새 과반)은 비둘기집 원리로 **적어도 한 노드를 공유**해요. 그 공유 노드가 "두 리더 동시 당선"을 막습니다. 그래서 joint consensus(옛·새 과반을 둘 다 요구하는 과도기 설정)라는 복잡한 장치 없이도 안전합니다. etcd를 비롯한 많은 구현이 이 방식이에요.

구현에서도 이걸 **강제**합니다:

```c
int64_t raft_change_config(Raft *r, uint32_t new_mask) {
    uint32_t diff = r->member_mask ^ new_mask;
    if (diff == 0 || (diff & (diff - 1)) != 0)
        return -1;   // 정확히 한 비트만 바뀌어야 함 (단일 서버)
    ...
}
```

`diff & (diff - 1)`가 0이 아니면 비트가 둘 이상 바뀐 것 — 거부합니다. 이 한 줄이 겹치는 과반을 보장해요.

## 3. member_mask — 핫패스를 비트마스크로

지금까지 Raft는 클러스터를 `n_nodes`라는 **고정 숫자**로 알았어요. 과반은 `n_nodes/2+1`, 복제 대상은 `0..n_nodes-1`. 멤버십이 바뀌려면 이걸 **동적인 집합**으로 바꿔야 합니다 — `member_mask` 비트마스크(비트 i = 노드 i가 구성원).

이제 모든 핫패스가 이 마스크로 돕니다:

- **과반** = `popcount(member_mask)/2 + 1`
- **투표 요청·하트비트** = 마스크에 켜진 노드에게만
- **커밋 카운트** = 마스크 구성원 중 `match_index >= N`인 수
- **선거 시작** = 자기가 구성원일 때만(`is_member(self)`)

### 로그에 보자마자 적용한다

가장 미묘한 규칙: config 엔트리는 **커밋될 때가 아니라 로그에 append되는 즉시** 적용합니다(§6). 커밋을 기다리면, 그 사이 옛 구성으로 판단하다 안전성이 깨질 수 있어요.

```c
static void maybe_adopt_config(Raft *r, const RaftEntry *e) {
    if (e->is_config) r->member_mask = (uint32_t)e->command;
}
// log_append 안에서 매 append마다 호출 -> 리더든 팔로워든 보자마자 채택
```

그래서 리더가 config 엔트리를 추가하는 순간 리더의 과반이 새 구성 기준으로 바뀌고, 팔로워도 그 엔트리를 받는 순간 바뀝니다.

## 4. 노드 추가 — passive 조인에서 구성원으로

3-멤버 `{0,1,2}`에 노드 3을 추가하는 흐름:

1. 노드 3은 처음엔 **passive**(member_mask=0) — 선거도 안 하고, 리더가 보내주지도 않아요.
2. 리더가 `raft_change_config`로 새 마스크 `{0,1,2,3}`를 config 엔트리로 추가 → 리더의 마스크가 즉시 바뀌고, 노드 3에 복제 시작점(`next_index`)을 세팅.
3. 다음 하트비트부터 리더가 노드 3에 `AppendEntries`를 보냄 → 노드 3이 그 엔트리(config 포함)를 받아 **로그에 보자마자 구성원**이 되고, 밀린 로그를 따라잡음.
4. 이제 과반은 4중 3. 노드 3도 커밋에 기여합니다.

```
  ok   멤버십: 노드3이 구성원으로 채택(로그에 보자마자)
  ok   멤버십: 추가된 노드3이 로그를 따라잡음
  ok   멤버십: 4-멤버로 새 엔트리 전원 커밋
```

## 5. 노드 제거 — 그리고 §6의 유명한 함정

노드 2를 빼는 것도 대칭적이에요: 리더가 `{0,1,3}` 마스크를 config 엔트리로 추가 → 과반이 3중 2로 재계산 → 남은 `{0,1,3}`가 계속 커밋.

그런데 여기 **§6의 유명한 함정**이 있습니다:

> 노드 2를 제거하면 리더는 더 이상 노드 2에 아무것도 안 보낸다(구성원이 아니니까). 그래서 노드 2는 **자기가 제거됐다는 config 엔트리를 못 받는다.** 노드 2는 여전히 자기가 구성원인 줄 알고, 하트비트가 안 오니 타임아웃 → 더 높은 term으로 선거를 시작해 **멀쩡한 클러스터를 방해**한다.

이건 실제 Raft가 씨름하는 문제예요. 해법은 (a) 제거 엔트리가 커밋될 때까지 리더가 그 노드에도 계속 보내거나, (b) "최근에 리더 하트비트를 받았으면 투표 안 한다"는 leader-stickiness/PreVote를 더하는 겁니다. 이 편에선 정직하게 **제거된 노드를 decommission**(종료)하는 모델로 테스트했어요 — 운영에서도 "구성에서 빼고 나서 서버를 내린다"가 자연스럽죠. live 제거 시의 disruption 방지는 **프론티어**로 남깁니다.

```
  ok   멤버십: 한 번에 여러 노드 변경은 거부(단일 서버 안전)
  ok   멤버십: 노드2 없이 {0,1,3}로 계속 커밋
  ok   멤버십: 남은 {0,1,3}가 합의 유지
```

## 6. member_mask=full의 함정 — 또 한 번

[30편의 스냅샷](/blog/project/db-hobby/db-hobby-30-raft-snapshot)에서 배운 교훈이 여기서도 그대로였어요:

> **member_mask가 "전체 노드"이면, 그건 예전 `n_nodes` 동작과 정확히 같다.** 그래서 기존 57개 Raft 테스트는 전부 full 마스크로 돌아서, 멤버십 로직에 버그가 있어도 **못 잡는다.**

30편의 `log_base=0`과 똑같은 함정이죠. 그래서 (1) 새 테스트가 반드시 **partial 마스크**(추가·제거)를 관통하게 하고, (2) 핫패스 변경을 **독립 서브에이전트에게 적대적으로 리뷰**시켰습니다.

그리고 리뷰어가 `/tmp`에서 직접 repro를 만들어 **실제 버그 4건**을 파냈어요 — 전부 `member_mask=full` 테스트로는 안 드러나는 것들:

1. **C1 — InstallSnapshot이 `member_mask`를 안 실었다.** 스냅샷으로 합류한 노드는 자기를 추가한 config 엔트리가 이미 압축돼 사라져서, 그걸 "로그에서 볼" 기회가 없어 **영구 passive**로 갇힘. 30편의 교훈("새 축을 다른 경로에서 전파하는 걸 빠뜨림")이 그대로 재발한 자리 → 스냅샷 메시지에 멤버십을 실어 설치하도록 수정.
2. **C2 — truncation 시 config를 안 되돌렸다.** 미커밋 config를 adopt-on-append로 채택한 뒤 그 엔트리가 리더 교체로 덮어써지면, `member_mask`가 롤백된 값에 남아 **소수파가 자기를 다수로 착각**할 수 있음. adopt-on-append의 대칭 짝 — truncation 시 로그로부터 `member_mask`를 재계산하도록 수정.
3. **L1 — commit-wait이 없었다.** 단일-비트 가드가 "현재 마스크"만 봐서, 직전 변경이 미커밋인데 두 번째 변경이 통과됨(§6 단일-서버의 알려진 결함). 직전 config가 커밋될 때까지 다음 변경을 금지하도록 수정.
4. **L2 — 자기 제거한 리더가 안 물러났다.** 제거 config가 **커밋된 뒤** 리더가 강등하도록 수정(커밋 전엔 그 엔트리를 새 구성에 복제해야 하므로 계속 리더로 남아야 함).

넷 다 고치고 각각 검증 테스트를 붙였습니다. **위험한 리팩터일수록, 작성자와 다른 눈이 정확히 위험한 곳(부분 마스크)을 파는지가 전부예요** — 30편은 사후 리뷰가 1건, 32편은 4건을 잡았습니다.

## 7. 정리

- Raft가 마침내 **동적 멤버십**을 갖췄다 — 돌아가는 중에 노드를 더하고 뺀다.
- 핵심 위험은 **겹치지 않는 과반**(split-brain). **단일 서버 변경**은 옛·새 과반의 겹침을 수학적으로 보장한다 — 코드가 단일 비트 delta만 허용.
- 구현: 고정 `n_nodes`를 **`member_mask` 비트마스크**로, config 엔트리는 **로그에 보자마자 적용**(§6).
- 또 한 번의 교훈: **member_mask=full은 예전과 동일** → 기존 테스트가 못 잡음 → 새 테스트가 partial 마스크 관통 + 독립 서브에이전트 리뷰.
- 정직한 경계: 제거된 live 노드의 선거 disruption과 joint consensus는 프론티어. 리뷰가 찾은 4건(C1·C2·L1·L2)은 모두 수정.

이로써 Raft는 **합의(28)·지속성(29)·스냅샷(30)·엔진 배선(31)·멤버십(32)** 까지, 프로덕션 Raft의 주요 조각을 한 바퀴 돌았어요. 남은 건 그 조각들을 실제 서비스로 묶는 통합의 영역입니다.

<!-- EN -->

## 0. Intro — The Limit of a Fixed Cluster

Parts [28 (consensus)](/blog/project/db-hobby/db-hobby-28-raft-consensus), [29 (persistence)](/blog/project/db-hobby/db-hobby-29-raft-persistence), and [30 (snapshots)](/blog/project/db-hobby/db-hobby-30-raft-snapshot) brought Raft close to the real thing — but one thing stayed fixed: the **cluster size**. Start with 3 nodes and it's 3 forever. Yet in production you must:

- **replace** a dead server,
- **add** nodes as load grows,
- **swap** nodes one at a time for a zero-downtime upgrade.

Doing this safely on a running cluster is **membership change (§6)**. And "safely" is trickier than it sounds.

## 1. The Core Risk — Non-Overlapping Majorities

Say you change a 3-node cluster to 5 nodes **all at once**. At the transition:

- The old config `{0,1,2}`'s majority is **2** (2 of 3).
- The new config `{0,1,2,3,4}`'s majority is **3** (3 of 5).

The problem: there's a moment where these **don't overlap.** Nodes `{0,1}` form an old majority (2), and nodes `{2,3,4}` form a new majority (3). The two sets are disjoint! So `{0,1}` elects leader A by the old config while `{2,3,4}` elects leader B by the new — **two leaders in the same term**, split-brain. The [Election Safety we fought so hard for in Part 28](/blog/project/db-hobby/db-hobby-28-raft-consensus) collapses.

![Raft membership: single-server changes keep old/new majorities overlapping; a config entry applies as soon as it's in the log](/uploads/project/db-hobby/raft-membership.svg)

## 2. The Fix — One Node at a Time

The Raft paper has two answers, and the author's thesis **recommends the simpler**: **single-server change** — add or remove **one node at a time**.

Why is it safe? Add or remove a single element from a set and the **old and new majorities must overlap.** Going 3→4, the old majority is 2 and the new is 3, and any 2-of-3 (old majority) and 3-of-4 (new majority) share **at least one node** by pigeonhole. That shared node prevents "two leaders elected at once." So it's safe without the complex machinery of joint consensus (a transitional config requiring both old and new majorities). etcd and many implementations use this.

The code **enforces** it:

```c
int64_t raft_change_config(Raft *r, uint32_t new_mask) {
    uint32_t diff = r->member_mask ^ new_mask;
    if (diff == 0 || (diff & (diff - 1)) != 0)
        return -1;   // exactly one bit must change (single server)
    ...
}
```

If `diff & (diff - 1)` isn't zero, more than one bit changed — reject. This one line guarantees overlapping majorities.

## 3. member_mask — the Hot Path as a Bitmask

Until now Raft knew the cluster as a **fixed number** `n_nodes`. Majority was `n_nodes/2+1`, replication targets were `0..n_nodes-1`. For membership to change, this must become a **dynamic set** — a `member_mask` bitmask (bit i = node i is a member).

Now every hot path runs off this mask:

- **majority** = `popcount(member_mask)/2 + 1`
- **vote requests / heartbeats** = only to nodes set in the mask
- **commit counting** = members with `match_index >= N`
- **starting an election** = only if you're a member (`is_member(self)`)

### Apply as soon as it's in the log

The subtlest rule: a config entry is applied **the moment it's appended to the log, not when it commits** (§6). Waiting for commit could let a node judge by the old config in between and break safety.

```c
static void maybe_adopt_config(Raft *r, const RaftEntry *e) {
    if (e->is_config) r->member_mask = (uint32_t)e->command;
}
// called inside log_append on every append -> leader or follower adopts on sight
```

So the moment the leader appends a config entry its majority shifts to the new config, and each follower shifts the moment it receives that entry.

## 4. Adding a Node — From Passive Joiner to Member

The flow to add node 3 to the 3-member `{0,1,2}`:

1. Node 3 starts **passive** (member_mask=0) — it neither holds elections nor gets sent to.
2. The leader `raft_change_config`s the new mask `{0,1,2,3}` as a config entry → the leader's mask shifts immediately, and it sets a replication start point (`next_index`) for node 3.
3. From the next heartbeat, the leader sends `AppendEntries` to node 3 → node 3 receives the entry (config included), becomes a **member the moment it's in its log**, and catches up on the backlog.
4. Now the majority is 3 of 4. Node 3 contributes to commits.

```
  ok   membership: node 3 adopted as a member (as soon as it's in the log)
  ok   membership: the added node 3 catches up on the log
  ok   membership: with 4 members, a new entry commits on all
```

## 5. Removing a Node — and §6's Famous Trap

Removing node 2 is symmetric: the leader adds a `{0,1,3}` mask as a config entry → the majority recomputes to 2 of 3 → the remaining `{0,1,3}` keeps committing.

But here's **§6's famous trap**:

> Remove node 2 and the leader no longer sends it anything (it's not a member). So node 2 **never receives the config entry that removed it.** Node 2 still thinks it's a member, gets no heartbeats, times out → starts an election at a higher term and **disrupts the healthy cluster.**

This is a problem real Raft wrestles with. The fixes are (a) the leader keeps sending to the node until the removal entry commits, or (b) add leader-stickiness/PreVote ("don't vote if you heard from the leader recently"). Here I tested honestly with a model where the **removed node is decommissioned** (shut down) — which is also natural in operations: "remove from config, then take the server down." Preventing disruption from a live removed node is left a **frontier.**

```
  ok   membership: changing more than one node at once is rejected (single-server safety)
  ok   membership: without node 2, {0,1,3} keeps committing
  ok   membership: the remaining {0,1,3} keeps consensus
```

## 6. The member_mask=full Trap — Once More

The lesson from [Part 30's snapshots](/blog/project/db-hobby/db-hobby-30-raft-snapshot) held again here:

> **When member_mask is "all nodes," it's exactly the old `n_nodes` behavior.** So the existing 57 Raft tests all run at a full mask and **can't catch** a bug in the membership logic.

The same trap as Part 30's `log_base=0`. So I (1) made the new test drive **partial masks** (add and remove), and (2) had an **independent subagent adversarially review** the hot-path change.

And the reviewer dug out **four real bugs** by building repros in `/tmp` — all invisible to `member_mask=full` tests:

1. **C1 — InstallSnapshot didn't carry `member_mask`.** A node joining via snapshot never gets to "see in its log" the config entry that added it (it was compacted away), so it stays **permanently passive**. Exactly Part 30's lesson recurring ("forgot to propagate the new axis through another path") → fixed by carrying membership in the snapshot message and installing it.
2. **C2 — truncation didn't revert the config.** After adopting an uncommitted config on append, if that entry gets overwritten by a new leader, `member_mask` stays at the rolled-back value — a **minority could mistake itself for a majority.** The symmetric partner of adopt-on-append → fixed by recomputing `member_mask` from the log on truncation.
3. **L1 — no commit-wait.** The single-bit guard only checked the "current mask," so a second change slipped through while the previous was uncommitted (the known flaw of single-server §6) → fixed by forbidding the next change until the previous config commits.
4. **L2 — a self-removing leader didn't step down.** Fixed to step down **after** the removal commits (before commit it must stay leader to replicate that entry to the new config).

All four fixed, each with a verifying test. **The more dangerous the refactor, the more everything hinges on a different set of eyes digging precisely where the danger lives (the partial mask)** — Part 30's post-hoc review caught one; Part 32's caught four.

## 7. Wrap-up

- Raft finally has **dynamic membership** — add and remove nodes on a running cluster.
- The core risk is **non-overlapping majorities** (split-brain). **Single-server change** guarantees old/new majority overlap mathematically — the code allows only a single-bit delta.
- Implementation: swap fixed `n_nodes` for a **`member_mask` bitmask**; a config entry is **applied as soon as it's in the log** (§6).
- Another lesson: **member_mask=full is the old behavior** → existing tests can't catch it → the new test drives partial masks + an independent subagent review.
- Honest boundary: a removed live node's election disruption and joint consensus are frontiers. The four issues the review found (C1, C2, L1, L2) are all fixed.

With this, Raft has circled the main pieces of production Raft — **consensus (28), persistence (29), snapshots (30), engine wiring (31), membership (32).** What remains is the integration of tying those pieces into a real service.

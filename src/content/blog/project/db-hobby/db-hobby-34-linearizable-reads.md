---
title: '선형화 읽기 — 파티션된 옛 리더가 낡은 값을 주지 않게 (ReadIndex)'
titleEn: 'Linearizable Reads — Stopping a Partitioned Old Leader From Serving Stale Data (ReadIndex)'
description: "33편에서 Raft로 복제되는 HA DB를 만들며 정직하게 남긴 경계가 하나 있었다 — 읽기는 아무 노드 엔진에서나 직접 실행돼 낡을 수 있다. 특히 무서운 건 파티션된 옛 리더다: 자기가 강등된 걸 모른 채 자기 상태기계에서 읽으면, 새 리더가 이미 커밋한 쓰기를 놓쳐 낡은 값을 준다. 이 편은 그 문제를 Raft의 선형화 읽기(ReadIndex, §8)로 푼다. 리더는 읽기를 서빙하기 전에 ① 현재 commit_index를 read index로 잡고, ② 과반 하트비트 ack로 '지금도 내가 리더'임을 확인하고, ③ 그 read index까지 상태기계가 적용된 뒤에야 자기 엔진에서 읽는다. 결정적 안전성: 파티션된 옛 리더는 과반 ack를 못 받아 확인이 영영 안 되므로 읽기가 거부된다 — 낡은 데이터를 서빙하지 않는다. 시계 가정이 필요한 leader-lease 대신 ReadIndex를 쓴 건 결정적 시뮬레이션에 맞아서다. 테스트로 확인된 리더에선 최신을 서빙하고, 고립시킨 리더에선 읽기가 거부됨을 증명한다. 정직한 경계: 새 리더의 no-op 커밋(§8)·leader-lease 최적화·joint consensus는 프론티어."
descriptionEn: "Building the Raft-replicated HA DB in Part 33, I left one honest boundary — reads run directly on some node's engine and can be stale. The scary case is a partitioned old leader: unaware it's been deposed, reading from its own state machine misses writes the new leader already committed, serving a stale value. This part solves it with Raft's linearizable reads (ReadIndex, §8). Before serving a read, the leader ① captures the current commit_index as the read index, ② confirms it's still the leader via a heartbeat quorum ack, and ③ serves from its own engine only after the state machine has applied up to that read index. The decisive safety: a partitioned old leader never gets a quorum ack, so its read is refused — it serves no stale data. Using ReadIndex rather than a clock-dependent leader lease fits the deterministic simulation. The test proves a confirmed leader serves the latest, while an isolated leader has its read refused. Honest boundary: a new leader's no-op commit (§8), the leader-lease optimization, and joint consensus are frontiers."
date: 2026-07-05
tags:
  - C
  - Database Internals
  - Raft
  - Linearizability
  - Consistency
  - Distributed Systems
  - Learning
category: study/db-hobby
coverImage: /uploads/project/db-hobby/cover.svg
draft: false
series: "db-hobby"
seriesOrder: 34
---

## 0. 들어가며 — 33편이 남긴 문제

[33편](/blog/project/db-hobby/db-hobby-33-raft-replicated-db)에서 Raft로 복제되는 HA DB를 만들며, 정직하게 이렇게 적었어요:

> "읽기는 아무 노드 엔진에서 직접 실행해요 — 그 노드가 뒤처져 있으면 낡은 값을 볼 수 있습니다. … 선형화 읽기가 바로 **다음 편**의 주제예요. 이 편이 그 문제를 만들고, 다음 편이 풉니다."

이 편이 그 다음 편입니다. 읽기가 왜 위험한지부터 짚죠.

## 1. 가장 무서운 경우 — 파티션된 옛 리더

읽기가 낡을 수 있는 경로는 여럿이에요(뒤처진 팔로워 등). 그런데 **가장 무서운 건 파티션된 옛 리더**입니다.

시나리오: 리더 A가 네트워크 분단으로 소수파에 고립됐어요. 다수파는 [28편에서 봤듯](/blog/project/db-hobby/db-hobby-28-raft-consensus) 새 리더 B를 뽑고 계속 커밋합니다. 그런데 **A는 자기가 강등된 걸 몰라요** — 하트비트가 다수파에 안 닿을 뿐, 여전히 자기가 리더인 줄 압니다. 이때 클라이언트가 A에게 읽기를 보내면?

> A가 그냥 자기 상태기계에서 읽어주면, **B가 이미 커밋한 새 쓰기들을 놓친 낡은 값**을 준다. 클라이언트는 최신인 줄 알지만 과거를 본 거예요 — 선형화(linearizability) 위반.

"리더에서 읽으면 최신"이라는 순진한 가정이 여기서 깨집니다. 리더라는 **직함만으론 부족**해요.

![선형화 읽기: 확인된 리더는 서빙, 파티션된 옛 리더는 과반 확인 실패로 거부](/uploads/project/db-hobby/raft-linearizable-read.svg)

## 2. ReadIndex — 읽기 전에 '지금도 리더'를 확인한다

Raft 논문 §8의 답이 **ReadIndex**입니다. 리더는 읽기를 서빙하기 전에 세 단계를 밟아요:

1. **read index를 잡는다**: 지금 `commit_index`를 read index로 기록. "이 읽기는 최소한 여기까지 반영해야 한다."
2. **과반으로 '아직 내가 리더'를 확인한다**: 하트비트 한 라운드를 보내 **과반이 응답**하는지 본다. 과반이 이번 term에 응답하면, 그 순간 나보다 높은 term의 리더는 존재할 수 없다 — 내가 진짜 리더다.
3. **read index까지 적용된 뒤 읽는다**: 상태기계가 read index까지 적용됐으면(`last_applied >= read_index`), 그제야 자기 엔진에서 읽는다.

핵심은 **2번**이에요. 왜 이게 안전을 주냐면:

> 파티션된 옛 리더는 하트비트가 다수파에 안 닿아 **과반 ack를 영영 못 받는다.** 그래서 확인이 안 되고, 읽기는 **거부**된다.

낡은 값을 주느니 **거부**하는 거죠. 그리고 확인에 성공했다면, 과반이 이번 term에 나를 리더로 인정한 것이므로 그 사이 더 최신 상태가 다른 곳에서 커밋됐을 수 없어요 — 그래서 내 상태기계가 최신입니다.

## 3. 구현 — raft.c의 read-barrier

`raft.c`에 작은 상태를 더했어요:

```c
int64_t read_barrier_index;   // 진행 중 읽기의 read index (-1 = 없음)
uint32_t read_ack_mask;       // 이번 barrier에 ack한 구성원(자기 포함)
int64_t read_confirmed_index; // 과반 확인된 read index (-1 = 미확인)
```

`raft_read_index`는 read index를 잡고 하트비트를 뿌립니다:

```c
int64_t raft_read_index(Raft *r, RaftOutbox *out) {
    if (r->role != RAFT_LEADER) return -1;
    r->read_barrier_index = r->commit_index;   // read index
    r->read_ack_mask = (1u << r->id);          // 자기 자신은 당연히 ack
    r->read_confirmed_index = -1;
    /* 모든 구성원에게 하트비트 -> 응답을 세러 나선다 */
    for (each member i != self) send_append_entries(r, i, out);
    return r->commit_index;
}
```

그리고 `AppendEntries` 응답이 올 때마다, barrier가 진행 중이면 그 응답자를 센다 — 과반이 되면 확인:

```c
// handle_append_entries_reply 안, success && 같은 term일 때:
if (read_barrier_index >= 0) {
    read_ack_mask |= (1u << from);
    if (popcount(members ∩ read_ack_mask) >= majority)
        read_confirmed_index = read_barrier_index;  // 확인 완료!
}
```

리더에서 물러나면(`become_follower`) barrier를 무효화합니다 — 고립된 옛 리더의 읽기가 뒤늦게 확인되는 걸 막아요.

상위 계층(`raftdb`)의 선형화 읽기는 이걸 엮습니다:

```c
int raftdb_query_linearizable(...) {
    ri = raft_read_index(leader, ...);       // barrier 시작
    for (steps) {
        raftdb_step(...);
        if (leader가 강등됨) return -1;        // 리더십 잃음 -> 거부
        if (raft_read_confirmed(leader) >= ri && last_applied >= ri) {
            db_exec(leader_engine, sql, out); // 확인+적용 완료 -> 선형화 읽기
            return 0;
        }
    }
    return -1;  // 과반 확인 실패(고립된 리더 등) -> 거부
}
```

## 4. 검증 — 확인되면 서빙, 고립되면 거부

`test_raftdb`가 두 얼굴을 다 봅니다:

- **확인된 리더**: 선형화 읽기가 과반 확인을 받아 최신 8행을 서빙(rc=0).
- **고립된 리더**: 리더를 파티션시키면, 과반 ack가 안 와 확인 실패 → 읽기 **거부**(rc=-1). 낡은 값을 주지 않는다.
- **대조**: 비선형화 직접 읽기(`raftdb_query`)는 확인 없이 그냥 응답한다 — 낡을 수 있는 것.

```
  ok   선형화 읽기: 과반 확인된 리더에서 서빙됨
  ok   선형화 읽기: 최신 8행 반환
  ok   선형화 읽기: 고립된 리더는 과반 확인 실패 -> 거부
```

## 5. 정직한 경계

- **새 리더의 no-op 커밋(§8)을 안 넣었다.** 갓 뽑힌 리더는 자기 term의 엔트리를 하나 커밋하기 전엔 `commit_index`가 실제 커밋 지점을 완전히 반영 못 할 수 있어요(§5.4.2의 현재-term 커밋 규칙 때문). 진짜 Raft는 리더가 되자마자 no-op 엔트리를 커밋해 이를 메웁니다. 여기선 쓰기가 먼저 커밋된 안정된 리더에서 읽어 그 창을 피하지만, no-op 배선은 **프론티어**로 남겨요.
- **leader-lease 최적화 없음.** ReadIndex는 읽기마다 하트비트 라운드를 돈다. leader-lease는 시계 기반으로 그 왕복을 줄이지만 시계 가정이 필요해요 — 결정적 시뮬엔 ReadIndex가 맞습니다.
- **stale in-flight ack — 적대적 리뷰가 잡아 제대로 고침.** 처음엔 "barrier 이후 응답만 센다"는 걸 하버스가 매 스텝 큐를 비워 우연히 보장했는데, 독립 리뷰어가 지적했어요: *안전이 코드가 아니라 하버스 불변식에 걸려 있다.* 재정렬이 있는 스케줄러나 실소켓으로 옮기면, 배리어 **이전** 하트비트의 응답이 뒤늦게 도착해 오확인(false confirmation)되어 고립된 옛 리더가 낡은 값을 서빙할 수 있죠. 그래서 배리어마다 증가하는 **read epoch**를 하트비트에 실어, 팔로워가 그 epoch를 되돌려준 응답만 세도록 고쳤습니다 — 이제 스케줄러와 무관하게 프리미티브 자체가 올바릅니다(pre-barrier 응답 주입 테스트로 증명).
- **joint consensus.** 멤버십 일반화(§6 joint)는 [32편](/blog/project/db-hobby/db-hobby-32-raft-membership)의 단일 서버 변경 위의 프론티어.

## 6. 정리

- 33편이 만든 문제 — **읽기가 낡을 수 있다** — 를 이 편이 **ReadIndex(§8)** 로 닫았다.
- 가장 무서운 건 **파티션된 옛 리더**: 직함만 믿고 자기 상태기계에서 읽으면 낡은 값을 준다.
- ReadIndex: ① read index=commit_index ② **과반 하트비트로 '지금도 리더' 확인** ③ 적용 후 읽기. 파티션된 리더는 확인 실패 → **거부**(낡은 읽기 안 함).
- 정직한 경계: no-op 커밋(§8)·leader-lease·epoch 태깅·joint consensus는 프론티어.

이로써 Raft가 **읽기까지 선형화**됐어요 — 쓰기 합의(28~30)·복제(33)에 이어, 클라이언트가 보는 읽기도 최신을 보장하는 데까지. 진짜 합의 시스템이 갖춰야 할 조각을 하나 더 손으로 짚었습니다.

<!-- EN -->

## 0. Intro — The Problem Part 33 Left

Building the Raft-replicated HA DB in [Part 33](/blog/project/db-hobby/db-hobby-33-raft-replicated-db), I honestly wrote:

> "Reads run directly on some node's engine — if that node lags, you can see a stale value. … Linearizable reads are exactly the **next part's** topic. This part creates that problem; the next solves it."

This is that next part. Let's start with why reads are dangerous.

## 1. The Scariest Case — a Partitioned Old Leader

There are several ways a read can be stale (a lagging follower, etc.). But **the scariest is a partitioned old leader.**

Scenario: leader A is isolated into a minority by a network partition. The majority, [as in Part 28](/blog/project/db-hobby/db-hobby-28-raft-consensus), elects a new leader B and keeps committing. But **A doesn't know it's been deposed** — its heartbeats just don't reach the majority; it still thinks it's the leader. Now a client sends A a read?

> If A simply reads from its own state machine, it returns a **stale value missing the new writes B already committed.** The client thinks it's fresh but saw the past — a linearizability violation.

The naive assumption "read from the leader = fresh" breaks here. The **title of "leader" alone isn't enough.**

![Linearizable reads: a confirmed leader serves, a partitioned old leader is refused for failing the quorum confirmation](/uploads/project/db-hobby/raft-linearizable-read.svg)

## 2. ReadIndex — Confirm "Still the Leader" Before Reading

The answer from Raft paper §8 is **ReadIndex.** Before serving a read, the leader takes three steps:

1. **Capture the read index**: record the current `commit_index` as the read index. "This read must reflect at least up to here."
2. **Confirm via a quorum that it's still the leader**: send a heartbeat round and see if a **majority** replies. If a majority replies in this term, then no leader of a higher term can exist right now — I really am the leader.
3. **Read after applying up to the read index**: once the state machine has applied up to the read index (`last_applied >= read_index`), read from its own engine.

Step **2** is the heart. Why it's safe:

> A partitioned old leader's heartbeats don't reach the majority, so it **never gets a quorum ack.** So it isn't confirmed, and the read is **refused.**

Better to **refuse** than serve a stale value. And if confirmation succeeds, a majority acknowledged you as leader in this term, so nothing more recent could have been committed elsewhere in between — your state machine is the latest.

## 3. Implementation — a read-barrier in raft.c

I added small state to `raft.c`:

```c
int64_t read_barrier_index;   // read index of an in-flight read (-1 = none)
uint32_t read_ack_mask;       // members who acked this barrier (self included)
int64_t read_confirmed_index; // the quorum-confirmed read index (-1 = unconfirmed)
```

`raft_read_index` captures the read index and fires heartbeats:

```c
int64_t raft_read_index(Raft *r, RaftOutbox *out) {
    if (r->role != RAFT_LEADER) return -1;
    r->read_barrier_index = r->commit_index;   // the read index
    r->read_ack_mask = (1u << r->id);          // self acks trivially
    r->read_confirmed_index = -1;
    /* heartbeat every member -> go collect acks */
    for (each member i != self) send_append_entries(r, i, out);
    return r->commit_index;
}
```

And on every `AppendEntries` reply, if a barrier is in flight, count the replier — confirm once a majority acks:

```c
// inside handle_append_entries_reply, on success && same term:
if (read_barrier_index >= 0) {
    read_ack_mask |= (1u << from);
    if (popcount(members ∩ read_ack_mask) >= majority)
        read_confirmed_index = read_barrier_index;  // confirmed!
}
```

Stepping down (`become_follower`) invalidates the barrier — preventing a deposed old leader's read from being confirmed late.

The upper layer (`raftdb`) ties it together for a linearizable read:

```c
int raftdb_query_linearizable(...) {
    ri = raft_read_index(leader, ...);       // start the barrier
    for (steps) {
        raftdb_step(...);
        if (leader stepped down) return -1;   // lost leadership -> refuse
        if (raft_read_confirmed(leader) >= ri && last_applied >= ri) {
            db_exec(leader_engine, sql, out); // confirmed + applied -> linearizable read
            return 0;
        }
    }
    return -1;  // quorum confirmation failed (isolated leader) -> refuse
}
```

## 4. Verification — Confirmed Serves, Isolated Refuses

`test_raftdb` sees both faces:

- **Confirmed leader**: the linearizable read gets a quorum confirmation and serves the latest 8 rows (rc=0).
- **Isolated leader**: partition the leader, and no quorum ack arrives → confirmation fails → the read is **refused** (rc=-1). No stale value served.
- **Contrast**: a non-linearizable direct read (`raftdb_query`) just responds without confirmation — potentially stale.

```
  ok   linearizable read: served from a quorum-confirmed leader
  ok   linearizable read: returns the latest 8 rows
  ok   linearizable read: an isolated leader fails the quorum -> refused
```

## 5. The Honest Boundary

- **No new-leader no-op commit (§8).** A freshly elected leader's `commit_index` may not fully reflect the true commit point until it commits an entry from its own term (because of §5.4.2's current-term commit rule). Real Raft commits a no-op entry right after election to close this. Here I read from a stable leader where writes already committed, avoiding that window, but wiring the no-op is a **frontier.**
- **No leader-lease optimization.** ReadIndex does a heartbeat round per read. A leader lease cuts that round-trip using clocks, but needs clock assumptions — ReadIndex fits the deterministic sim.
- **Stale in-flight ack — caught by adversarial review, then fixed properly.** At first, "only count acks after the barrier" was accidentally guaranteed by the harness draining the queue each step. An independent reviewer flagged it: *the safety was riding on a harness invariant, not the code.* On a reordering scheduler or a real socket, a reply to a heartbeat sent *before* the barrier could arrive late and cause a false confirmation, letting a partitioned old leader serve a stale value. So I tag each barrier with an incrementing **read epoch** carried in the heartbeat, and count only replies that echo the current epoch — now the primitive is correct regardless of scheduler (proven by a test that injects pre-barrier replies).
- **Joint consensus.** The membership generalization (§6 joint) is a frontier on top of [Part 32](/blog/project/db-hobby/db-hobby-32-raft-membership)'s single-server change.

## 6. Wrap-up

- The problem Part 33 created — **reads can be stale** — is closed here with **ReadIndex (§8).**
- The scariest is a **partitioned old leader**: trusting the title and reading from its own state machine returns a stale value.
- ReadIndex: ① read index = commit_index ② **confirm "still the leader" via a heartbeat quorum** ③ read after applying. A partitioned leader fails confirmation → **refused** (no stale read).
- Honest boundary: the no-op commit (§8), leader lease, epoch tagging, and joint consensus are frontiers.

With this, Raft is **linearizable down to reads** — after write consensus (28–30) and replication (33), the reads a client sees are guaranteed fresh too. One more piece of a real consensus system, traced out by hand.

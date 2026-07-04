---
title: 'Raft 스냅샷 — 로그가 무한히 자라는 걸 막다, 그리고 log_base=0의 함정'
titleEn: 'Raft Snapshots — Stopping the Log From Growing Forever, and the log_base=0 Trap'
description: "28편에서 Raft를 만들며 '로그가 무한히 자란다(스냅샷 없음)'고 프론티어로 남겼다. 이 편이 그걸 닫는다 — 로그 압축(§7): 이미 커밋·적용된 로그 prefix를 버리고 스냅샷 하나로 대체하고, 그렇게 압축돼 사라진 부분이 필요한 뒤처진 팔로워에겐 AppendEntries 대신 InstallSnapshot으로 스냅샷을 통째로 보낸다. 하지만 이 편의 진짜 이야기는 그 구현이 아니라 '위험'이다. 스냅샷은 로그 인덱스에 base 오프셋(log_base)을 도입하는데 — 모든 log[i]가 log[i-log_base]가 돼야 한다 — log_base=0이면 이 변환이 무연산이다. 즉 기존 37개 Raft 테스트는 전부 log_base=0에서 돌아, 변환을 하나 빠뜨려도 여전히 통과한다. 진짜 안전망이 못 된다. 그래서 (1) 모든 로그 접근을 헬퍼로 정확히 바꾸고, (2) 새 테스트가 반드시 log_base>0 경로(압축 후 복제·커밋·InstallSnapshot·apply)를 전부 관통하게 하고, (3) 독립 서브에이전트로 index 변환 버그를 적대적으로 리뷰했다. 정직한 경계: 팔로워는 스냅샷 설치 시 로그 전체를 폐기(꼬리 보존 안 함), 멤버십 변경(§6)은 여전히 프론티어."
descriptionEn: "In Part 28, building Raft, I left 'the log grows unbounded (no snapshot)' as a frontier. This part closes it — log compaction (§7): discard an already-committed-and-applied log prefix and replace it with a single snapshot, and for a lagging follower that needs the compacted-away part, send the whole snapshot via InstallSnapshot instead of AppendEntries. But the real story of this part isn't the implementation — it's the risk. Snapshots introduce a base offset (log_base) into the log index — every log[i] must become log[i-log_base] — and when log_base==0 that translation is a no-op. So all 37 existing Raft tests run at log_base==0 and still pass even if you miss a translation. That's not a real safety net. So I (1) converted every log access through helpers, (2) made the new tests drive log_base>0 through every path (post-compaction replication, commit, InstallSnapshot, apply), and (3) had an independent subagent adversarially review the index-translation for bugs. Honest boundary: the follower discards its whole log on snapshot install (no tail retention), and membership changes (§6) remain a frontier."
date: 2026-07-04
tags:
  - C
  - Database Internals
  - Raft
  - Consensus
  - Snapshot
  - Testing
  - Learning
category: study/db-hobby
coverImage: /uploads/project/db-hobby/cover.svg
draft: false
series: "db-hobby"
seriesOrder: 30
---

## 0. 들어가며 — 28편이 남긴 마지막 프론티어

[28편](/blog/project/db-hobby/db-hobby-28-raft-consensus)에서 Raft를 만들며 정직하게 적었어요:

> "스냅샷/로그 압축 없음(§7). 로그가 무한히 자랍니다. 실제 시스템은 주기적으로 상태기계를 스냅샷하고 그 앞 로그를 버려요."

Raft 로그는 커밋된 명령을 **영원히** 쌓습니다. 100만 개를 커밋하면 100만 개가 다 남죠. 재시작 때 그걸 다 replay하는 건 느리고, 디스크도 낭비예요. 해법이 **로그 압축(log compaction)** — 이미 상태기계에 적용된 prefix는 "그 시점의 상태 스냅샷" 하나로 갈음하고 버립니다.

이 편은 그걸 구현해요. 그런데 **진짜 이야기는 구현이 아니라 위험**입니다. 스냅샷은 이 시리즈에서 가장 위험한 종류의 리팩터를 요구하거든요.

## 1. 스냅샷의 두 조각

### ① 로그 압축 (raft_snapshot)

이미 커밋·적용된 인덱스 `index`까지를 버리고, 그 자리에 스냅샷 마커를 둡니다:

```
압축 전:  [1][2][3][4][5]
압축 후:  [snapshot ≤3][4][5]     log_base = 3
```

핵심은 `log_base`라는 오프셋이에요. 이제 **논리 인덱스 4는 물리 배열의 1번 칸**에 삽니다. `log[0]`은 "인덱스 3까지 스냅샷됐다"는 마커(그 term = lastIncludedTerm)가 되고요.

### ② InstallSnapshot

문제가 생깁니다. 어떤 팔로워가 한참 뒤처져 인덱스 1~3이 필요한데, 리더는 그걸 **이미 버렸어요.** `AppendEntries`로는 못 보내죠. 그래서 리더는 **스냅샷을 통째로** 보냅니다 — `InstallSnapshot` RPC. 팔로워는 자기 로그를 버리고 `log_base`를 스냅샷 지점으로 점프시킨 뒤, 상태기계에 스냅샷을 얹어 **단번에 따라잡습니다.**

![Raft 스냅샷: 로그 압축과 log_base 오프셋, 뒤처진 팔로워에게 InstallSnapshot](/uploads/project/db-hobby/raft-snapshot.svg)

## 2. 진짜 위험 — log_base=0은 무연산이다

여기가 이 편의 심장입니다. `log_base`를 도입하면 코드 전체에서 **모든 `log[i]`가 `log[i - log_base]`가 돼야 해요.** 로그를 읽는 곳이 여덟 군데쯤 됩니다 — `send_append_entries`, `handle_append_entries`의 term 검사와 append 루프, `leader_advance_commit`, `apply_committed`…

문제는 이겁니다:

> **`log_base`가 0이면 `log[i - log_base]`는 그냥 `log[i]`다. 변환은 무연산(no-op)이다.**

그리고 [28편](/blog/project/db-hobby/db-hobby-28-raft-consensus)·[29편](/blog/project/db-hobby/db-hobby-29-raft-persistence)의 기존 37개 Raft 테스트는 **전부 log_base=0에서** 돕니다(아무도 압축을 안 했으니까). 그러니 내가 변환을 **하나 빠뜨려도**, 기존 테스트는 **여전히 초록불**이에요. 버그가 조용히 숨습니다.

이건 테스트가 주는 안전감이 **가짜**일 수 있다는 얘기예요. "기존 테스트 다 통과하니 괜찮겠지"가 여기선 안 통합니다. 그래서 세 가지로 방어했어요.

### 방어 1 — 모든 접근을 헬퍼로

`log[i]`를 흩뿌리는 대신 두 헬퍼로 강제했습니다:

```c
static uint64_t term_at(const Raft *r, int64_t i) { return r->log[i - r->log_base].term; }
static RaftEntry *ent(Raft *r, int64_t i)         { return &r->log[i - r->log_base]; }
```

이제 로그를 만지려면 이 함수를 거쳐야 하고, 변환을 빠뜨릴 여지가 줄어듭니다.

### 방어 2 — 테스트가 반드시 log_base>0을 관통하게

이게 결정적이에요. 새 스냅샷 테스트는 압축을 **한 다음에**:

- **새 엔트리를 복제·커밋**합니다 → `send_append_entries`·`handle_append_entries`·`leader_advance_commit`·`apply`가 전부 `log_base>0`에서 돌아요.
- **뒤처진 팔로워를 InstallSnapshot으로 따라잡게** 합니다 → 압축된 경계를 넘는 경로를 관통.

```
  ok   스냅샷: 압축 후 새 엔트리(6) 커밋
  ok   스냅샷: 압축 후에도 모든 노드 SM 수렴(999)
  ok   InstallSnapshot: 팔로워가 스냅샷 설치(log_base 점프)
  ok   InstallSnapshot: 팔로워 SM이 리더와 일치(catch-up)
```

log_base=0에서만 도는 테스트는 이 리팩터를 검증하지 못합니다. **버그를 잡으려면 테스트가 버그가 사는 곳(log_base>0)에 반드시 들어가야** 해요.

### 방어 3 — 독립 서브에이전트의 적대적 리뷰

마지막으로, index 변환 같은 실수는 작성자가 자기 눈으로 놓치기 쉽습니다. 그래서 **독립적인 리뷰어**에게 "빠뜨린 `log[i]` 변환, `raft_snapshot`의 off-by-one, `prev < log_base` 엣지, InstallSnapshot의 경계"를 적대적으로 파헤치게 맡겼어요.

그리고 **진짜 버그를 하나 찾았습니다.** index 변환 자체는 깨끗했지만, **지속성+스냅샷 통합에 구멍**이 있었어요: `raft_load`가 스냅샷 노드를 디스크에서 되읽을 때 `snapshot_value`를 구조체엔 넣지만 **상태기계엔 시드하지 않았습니다.** `log_base>0`이면 `1..log_base` 엔트리는 압축돼 사라졌으니 재적용으로도 못 채우고 — 재기동한 노드의 SM에 그 구간 상태가 **영구히 비는** 조용한 발산이었죠. 리뷰어는 이걸 `/tmp`에서 직접 실험(commit 미만 스냅샷, 디스크 재적재)해 파냈습니다. 정확히 예상했던 함정 — **log_base=0 테스트로는 절대 못 잡고, 인메모리 크래시 재시작은 SM이 우연히 살아 있어 가려지는** 자리였어요. `raft_load`가 `log_base>0`이면 `snap_install`로 SM을 시드하도록 고치고, 그걸 검증하는 테스트를 새로 추가했습니다.

리뷰어는 그 밖에 두 개의 latent 결함도 지적했어요(현재는 불변식이 발화를 막지만 핸들러 단독으론 위험한 것 — InstallSnapshot의 idempotent 경로가 `match_index`를 과다보고하는 것과 commit을 무조건 하향하는 것). 둘 다 방어적으로 강화했습니다. 사람이든 에이전트든, **작성자와 다른 눈**이 이런 조용한 버그엔 가장 강력한 그물입니다 — 그리고 이번엔 그 그물이 실제로 물고기를 잡았어요.

## 3. 압축의 미묘함 — 커밋된 걸 지우지 않기

로그 압축에서 실수하기 쉬운 지점이 `handle_append_entries`의 append 루프예요. 팔로워가 스냅샷을 가진 상태에서 리더가 `prev_log_index`가 팔로워의 `log_base`보다 **작은** AppendEntries를 보낼 수 있습니다(경계 상황). 이때:

- `prev < log_base`면 그 지점은 이미 팔로워의 스냅샷 안이라 term을 검증할 수 없어요. 스냅샷이 그 prefix를 이미 보장하므로 통과시키되,
- append 루프에서 `idx <= log_base`인 엔트리는 **건너뜁니다**(이미 스냅샷에 담김). 이걸 안 하면 스냅샷된 인덱스에 엉뚱하게 덮어쓸 수 있어요.

그리고 절단(`log_len = idx - log_base`)도 물리 길이로 정확히 계산해야 하고요. 이런 경계 하나하나가 "커밋된 것은 안 뒤집힌다"는 Raft의 안전성을 지키는 자리입니다.

## 4. 정직한 경계

- **팔로워는 스냅샷 설치 시 로그를 통째로 버린다.** 진짜 Raft는 팔로워가 이미 가진 꼬리가 스냅샷과 일치하면 그 뒤를 **보존**하지만, 여기선 단순화를 위해 전부 버리고 새로 받습니다 — **안전하되** 약간 비효율(이미 가진 걸 다시 받을 수 있음)이에요.
- **압축 시점은 테스트에서 commit_index로 고정.** `raft_snapshot`은 `index < commit_index`도 받도록 짰지만, 테스트는 주로 `commit_index`에서 압축합니다. 언제·얼마나 자주 스냅샷할지의 정책(로그 크기 임계 등)은 프론티어예요.
- **멤버십 변경(§6)** 은 여전히 남았습니다. 클러스터 크기가 고정이에요.
- **엔진 미배선.** 이 스냅샷 값은 학습용 레지스터 SM(값 하나)입니다. 진짜 상태기계(db-hobby의 테이블 데이터)를 직렬화해 스냅샷하는 건 통합 작업이고요.

## 5. 정리

- 28편이 남긴 **로그 무한 성장** 프론티어를 로그 압축(§7)으로 닫았다: 압축 + InstallSnapshot.
- 스냅샷은 인덱스에 **log_base 오프셋**을 도입한다 — 논리 i는 물리 `log[i-log_base]`.
- **진짜 교훈**: `log_base=0`에서 변환은 무연산이라, 기존 테스트가 리팩터 버그를 **못 잡는다**. 테스트가 주는 안전감이 가짜일 수 있다.
- 세 겹 방어: **헬퍼로 접근 강제** · **테스트가 log_base>0을 반드시 관통** · **독립 서브에이전트의 적대적 리뷰**.
- 정직한 경계: 스냅샷 설치 시 로그 전체 폐기, 멤버십 변경(§6), 엔진 통합은 프론티어.

이 편은 "무엇을 만들었나"보다 **"어떻게 스스로를 속지 않았나"** 에 관한 이야기예요. 위험한 리팩터일수록, 테스트가 정확히 위험한 곳을 겨냥하는지가 전부입니다.

<!-- EN -->

## 0. Intro — The Last Frontier Part 28 Left

Building Raft in [Part 28](/blog/project/db-hobby/db-hobby-28-raft-consensus), I honestly wrote:

> "No snapshot / log compaction (§7). The log grows unbounded. Real systems periodically snapshot the state machine and discard the log before it."

A Raft log stacks committed commands **forever.** Commit a million and all million remain. Replaying them all at restart is slow and wastes disk. The fix is **log compaction** — replace an already-applied prefix with a single "state snapshot at that point" and discard it.

This part implements that. But **the real story isn't the implementation — it's the risk.** Snapshots demand the most dangerous kind of refactor in this whole series.

## 1. The Two Pieces of a Snapshot

### ① Log compaction (raft_snapshot)

Discard everything up to an already-committed-and-applied `index`, and put a snapshot marker in its place:

```
before:  [1][2][3][4][5]
after:   [snapshot ≤3][4][5]     log_base = 3
```

The key is an offset called `log_base`. Now **logical index 4 lives in physical slot 1** of the array. `log[0]` becomes the marker for "snapshotted through index 3" (its term = lastIncludedTerm).

### ② InstallSnapshot

A problem arises. A follower that's fallen far behind needs indices 1–3 — but the leader has **already discarded them.** It can't send them via `AppendEntries`. So the leader sends the **whole snapshot** — the `InstallSnapshot` RPC. The follower discards its log, jumps `log_base` to the snapshot point, installs the snapshot into its state machine, and **catches up in one shot.**

![Raft snapshots: log compaction and the log_base offset, InstallSnapshot to a lagging follower](/uploads/project/db-hobby/raft-snapshot.svg)

## 2. The Real Risk — log_base=0 Is a No-Op

Here is the heart of this part. Introducing `log_base` means that across the whole codebase, **every `log[i]` must become `log[i - log_base]`.** There are about eight places that read the log — `send_append_entries`, the term check and append loop in `handle_append_entries`, `leader_advance_commit`, `apply_committed`…

The catch:

> **When `log_base` is 0, `log[i - log_base]` is just `log[i]`. The translation is a no-op.**

And all 37 existing Raft tests from [Part 28](/blog/project/db-hobby/db-hobby-28-raft-consensus) and [Part 29](/blog/project/db-hobby/db-hobby-29-raft-persistence) run at **log_base=0** (nobody compacted). So even if I **miss a translation**, those tests stay **green.** The bug hides silently.

This means the safety a test suite gives you can be **fake.** "All existing tests pass, so it's fine" does not hold here. So I defended with three things.

### Defense 1 — Force all access through helpers

Instead of scattering `log[i]`, I funneled it through two helpers:

```c
static uint64_t term_at(const Raft *r, int64_t i) { return r->log[i - r->log_base].term; }
static RaftEntry *ent(Raft *r, int64_t i)         { return &r->log[i - r->log_base]; }
```

Now touching the log has to go through these, shrinking the room to miss a translation.

### Defense 2 — Make the tests drive log_base>0

This is decisive. The new snapshot test, **after compacting**:

- **replicates and commits new entries** → `send_append_entries`, `handle_append_entries`, `leader_advance_commit`, `apply` all run at `log_base>0`.
- **catches up a lagging follower via InstallSnapshot** → exercising the path across the compacted boundary.

```
  ok   snapshot: new entry (6) committed after compaction
  ok   snapshot: all nodes' SM converge (999) even after compaction
  ok   InstallSnapshot: follower installs the snapshot (log_base jump)
  ok   InstallSnapshot: follower SM matches the leader (catch-up)
```

A test that only runs at log_base=0 cannot verify this refactor. **To catch the bug, the test must go where the bug lives (log_base>0).**

### Defense 3 — Adversarial review by an independent subagent

Finally, index-translation slips are easy to miss with your own eyes. So I handed an **independent reviewer** the task of adversarially digging for "a missed `log[i]` translation, off-by-one in `raft_snapshot`, the `prev < log_base` edge, the InstallSnapshot boundaries."

And it **found a real bug.** The index translation itself was clean, but there was a **hole in the persistence + snapshot integration**: when `raft_load` restores a snapshotted node from disk, it put `snapshot_value` into the struct but **didn't seed it into the state machine.** With `log_base>0`, entries `1..log_base` are compacted away, so re-application can't fill them either — the restarted node's SM was **permanently missing** that prefix's state, a silent divergence. The reviewer dug this out by actually experimenting in `/tmp` (snapshot below commit, disk reload). Exactly the trap I'd predicted — the spot that **log_base=0 tests can never catch, and that in-memory crash-restart masks because the SM happens to survive.** I fixed `raft_load` to seed the SM via `snap_install` when `log_base>0`, and added a test that verifies it.

The reviewer also flagged two latent defects (currently masked by invariants but dangerous for the handler standalone — the InstallSnapshot idempotent path over-reporting `match_index`, and unconditionally lowering commit). I hardened both defensively. Human or agent, **a different set of eyes than the author's** is the strongest net for this kind of silent bug — and this time the net actually caught a fish.

## 3. A Subtlety of Compaction — Don't Erase the Committed

An easy place to slip in log compaction is the append loop in `handle_append_entries`. With the follower holding a snapshot, the leader can send an AppendEntries whose `prev_log_index` is **smaller** than the follower's `log_base` (a boundary case). Then:

- If `prev < log_base`, that point is already inside the follower's snapshot, so the term can't be verified. Since the snapshot already guarantees that prefix, let it pass, but
- in the append loop, **skip** entries with `idx <= log_base` (already in the snapshot). Without this, you could wrongly overwrite a snapshotted index.

And the truncation (`log_len = idx - log_base`) must be computed exactly in physical length. Each of these boundaries is where Raft's safety — "committed entries are never overturned" — is upheld.

## 4. The Honest Boundary

- **The follower discards its whole log on snapshot install.** Real Raft **retains** the tail if the follower's existing entries match the snapshot; here, for simplicity, it drops everything and re-fetches — **safe** but slightly inefficient (it may re-receive what it already had).
- **The compaction point is fixed to commit_index in the tests.** `raft_snapshot` accepts `index < commit_index` too, but the tests mostly compact at `commit_index`. The policy of when/how often to snapshot (log-size threshold, etc.) is a frontier.
- **Membership changes (§6)** still remain. Cluster size is fixed.
- **Not wired into the engine.** The snapshot value here is a learning register SM (a single value). Serializing a real state machine (db-hobby's table data) into a snapshot is integration work.

## 5. Wrap-up

- Closed the **unbounded-log** frontier Part 28 left, with log compaction (§7): compaction + InstallSnapshot.
- Snapshots introduce a **log_base offset** into the index — logical i is physical `log[i-log_base]`.
- **The real lesson**: at `log_base=0` the translation is a no-op, so existing tests **can't catch** the refactor's bugs. The safety a test suite gives can be fake.
- Three layers of defense: **force access through helpers** · **make the tests drive log_base>0** · **adversarial review by an independent subagent**.
- Honest boundary: whole-log discard on install, membership changes (§6), and engine integration are frontiers.

This part is less about "what I built" and more about **"how I kept from fooling myself."** The more dangerous the refactor, the more everything hinges on whether the test aims precisely at the danger.

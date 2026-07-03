---
title: 'WAL 로그 시핑 복제 — 복구의 redo를 스트림으로, primary에서 replica로'
titleEn: 'WAL Log-Shipping Replication — Turning Recovery''s Redo into a Stream, Primary to Replica'
description: "지금까지 db-hobby는 단일 노드였다. 이 편은 처음으로 '분산' 축을 건드린다 — 복제. 그런데 놀랍게도 복제는 거의 공짜로 나온다. 15편에서 만든 WAL이 이미 커밋마다 REC_PAGE(after-image)들과 REC_COMMIT 마커를 로그에 남기고 있고, 크래시 복구의 redo Pass가 바로 '커밋된 after-image를 순서대로 데이터에 재적용'하는 일이기 때문이다. replica가 할 일은 그 redo를 '파괴적 복구'가 아니라 '증분·연속'으로 돌리는 것뿐이다 — primary의 WAL을 tail하며 커밋된 구간을 자기 데이터 파일에 재생한다. 이것이 PostgreSQL 스트리밍 복제(walreceiver)의 핵심 구조다. 페이지 전체 물리 로깅이라 redo가 idempotent라서, lsn으로 이미 적용한 커밋만 거르면 체크포인트로 로그가 잘려 오프셋이 되감겨도 안전하게 이어 붙는다. 정직한 경계: TCP 전송(walsender/walreceiver)·복제 슬롯·자동 failover(Raft)는 프론티어로 명시한다."
descriptionEn: "Until now db-hobby was a single node. This part touches the 'distributed' axis for the first time — replication. Surprisingly, replication comes almost for free. The WAL from Part 15 already leaves REC_PAGE (after-image) records and a REC_COMMIT marker in the log on every commit, and crash recovery's redo pass is exactly 'reapply committed after-images to the data in order.' All the replica does is run that redo incrementally and continuously instead of destructively — tailing the primary's WAL and replaying committed segments into its own data file. This is the core structure of PostgreSQL streaming replication (walreceiver). Because whole-page physical logging makes redo idempotent, filtering already-applied commits by lsn lets it safely resume even after a checkpoint truncates the log and rewinds the offset. Honest boundary: TCP transport (walsender/walreceiver), replication slots, and automatic failover (Raft) are marked as frontiers."
date: 2026-07-04
tags:
  - C
  - Database Internals
  - Replication
  - WAL
  - Distributed Systems
  - PostgreSQL
  - Learning
category: study/db-hobby
coverImage: /uploads/project/db-hobby/cover.svg
draft: false
series: "db-hobby"
seriesOrder: 25
---

## 0. 들어가며 — 처음으로 노드를 하나 더

24편까지 db-hobby는 **단일 노드**였어요. 한 프로세스가 한 데이터 파일을 쥐고 읽고 씁니다. 하지만 진짜 DB의 절반은 "노드가 죽어도, 노드가 하나론 부족해도 어떻게 하나"에 있죠. 이 편은 그 첫걸음 — **복제(replication)** 를 놓습니다.

복제의 가장 기본형은 **primary → replica**입니다. primary가 쓰기를 받고, 그 변경을 replica(들)에 흘려보내면, replica는 같은 데이터를 갖게 돼 **읽기를 나눠 받거나**(read scaling) primary가 죽었을 때 **대신 설 수** 있어요.

그런데 이걸 어떻게 흘려보낼까요? 놀랍게도, db-hobby는 **이미 그 도구를 갖고 있습니다.**

## 1. 복제는 거의 공짜다 — WAL이 이미 스트림이니까

[15편](/blog/project/db-hobby/db-hobby-15-noforce-checkpoint)에서 no-force WAL을 만들면서, 커밋은 이런 로그를 남기게 됐어요:

```
REC_PAGE(pid, after-image)   ← 이 트랜잭션이 바꾼 페이지의 최종 모습
REC_PAGE(pid, after-image)
...
REC_COMMIT                    ← 여기가 내구성 지점(fsync)
```

그리고 [크래시 복구](/blog/project/db-hobby/db-hobby-14-steal-undo)의 **redo Pass**가 하는 일은 정확히 이거예요: *"커밋 마커가 붙은 구간의 after-image들을 순서대로 데이터에 재적용한다."*

여기서 결정적인 관찰:

> **replica가 할 일 = 그 redo를, '파괴적 복구'가 아니라 '증분·연속'으로 돌리는 것.**

primary의 WAL을 계속 tail하면서, 커밋된 구간이 도착할 때마다 그 after-image를 **자기** 데이터 파일에 적용하면 — replica는 primary를 뒤따라옵니다. 이것이 PostgreSQL 스트리밍 복제에서 **walreceiver가 WAL을 replay**하는 것과 같은 구조예요. 새 알고리즘이 아니라, **이미 있는 redo를 다른 각도로 다시 쓴** 겁니다.

![WAL 로그 시핑 복제: replica가 커밋된 after-image를 tail하며 재생, 미완 꼬리는 보류](/uploads/project/db-hobby/wal-replication.svg)

## 2. replica의 apply 루프

`src/replica.c`의 핵심은 `replica_apply` 하나입니다. 로그를 `apply_off`(적용 완료한 바이트 위치)부터 훑어요:

```c
for (;;) {
    uint8_t type;
    if (read_exact(fd, &type, 1) != 0) break;   /* EOF/미완 → 다음 호출로 미룸 */
    uint64_t lsn; read_exact(fd, &lsn, 8);

    if (type == REC_PAGE) {
        /* after-image를 버퍼에 모아둔다 (아직 커밋 확정 아님) */
        read pid; read PAGE_SIZE into pend_img[npend++];
    } else if (type == REC_COMMIT) {
        /* 구간 끝 = 커밋됨 → 모은 after-image를 데이터에 적용 */
        if (lsn > applied_lsn) {              /* 이미 적용한 커밋이면 건너뜀 */
            for (i in pend) pager_write(&data, pend_pid[i], pend_img[i]);
            applied_lsn = lsn; commits_applied++;
        }
        npend = 0;
        apply_off = 현재_오프셋;              /* 오프셋 전진은 커밋 경계에서만 */
    } else { /* REC_BEGIN, REC_UNDO는 replay에 불필요 → 건너뜀 */ }
}
```

세 가지 설계 결정이 중요해요.

### (a) 오프셋 전진은 **커밋 경계에서만**

`apply_off`는 `REC_COMMIT`을 처리한 직후에만 앞으로 갑니다. 그래서 로그 꼬리에 **아직 커밋 마커가 안 붙은 미완 구간**(primary가 쓰는 중)이 있으면, replica는 그걸 버퍼에만 담고 **적용하지 않은 채** EOF에서 멈춰요. 다음 `replica_apply` 호출 때 마커가 도착해 있으면 그제야 적용합니다. → **replica는 항상 커밋된 상태만 보인다**(읽기 일관성).

### (b) `REC_UNDO`·`REC_BEGIN`은 건너뛴다

이 둘은 [steal/undo](/blog/project/db-hobby/db-hobby-14-steal-undo)의 흔적(before-image, 트랜잭션 시작 페이지 수)이라 **replay에는 쓸모가 없어요**. replica는 "커밋된 최종 모습"만 필요하고, 그건 `REC_PAGE`의 after-image가 다 담고 있습니다. 그래서 파싱만 하고 버립니다.

### (c) `lsn`으로 중복을 거른다 — 체크포인트를 견디는 열쇠

primary는 로그가 4MB를 넘으면 [체크포인트](/blog/project/db-hobby/db-hobby-15-noforce-checkpoint)로 로그를 **truncate**해요(데이터 fsync 후 로그 비움). 그러면 replica의 `apply_off`가 파일 크기보다 커지죠. 이때 replica는 **오프셋을 0으로 되감아** 처음부터 다시 훑습니다. 그런데 앞부분엔 이미 적용한 커밋들이 있잖아요? 여기서 `lsn > applied_lsn` 검사가 구원합니다 — **이미 적용한 커밋(작거나 같은 lsn)은 건너뛰고**, 새 것만 적용해요.

이게 안전한 근본 이유는 [14편에서 이미 증명한](/blog/project/db-hobby/db-hobby-14-steal-undo) 성질이에요:

> **페이지 전체 물리 로깅이라 redo는 idempotent다.** 같은 after-image를 두 번 써도 결과가 같다.

즉 최악의 경우 중복 적용해도 데이터는 안 틀립니다. `lsn` 필터는 정확성이 아니라 **효율**(안 해도 될 일을 안 하기)을 위한 거예요. 이 idempotency가 없었다면 복제는 훨씬 어려웠을 겁니다.

## 3. 검증 — 커밋된 것만, 뒤처지되 틀리지 않게

`test_replica`는 primary를 진짜 WAL로 굴리고 replica가 따라오는지 봅니다(18 checks):

- **기본 복제** — primary가 pid0=0xAA를 커밋 → `replica_apply` → replica의 pid0 == primary의 pid0.
- **증분 catch-up** — primary가 2건 더 커밋 → replica는 **새 2건만** 추가 적용(앞 건 재적용 안 함), 복제 위치(lsn) 전진.
- **덮어쓰기 복제** — 같은 pid의 새 버전(0xAA→0xDD)도 흐른다.
- **미완 꼬리 미적용** — 커밋 마커 없이 페이지 로그만 남기고 멈추면(=커밋 전 크래시), replica는 그 구간을 **적용하지 않는다**. replica엔 그 페이지가 아직 없다.
- **되감기 후 중복 없음** — `apply_off`를 0으로 강제로 되감아(체크포인트 truncate 모사) 다시 훑어도, 이미 적용한 커밋은 건너뛰고 데이터는 그대로.

```
  ok   pid1: replica == primary (0xBB)
  ok   새 커밋 2건만 추가 적용(앞 건 재적용 안 함)
  ok   미완(커밋 마커 없는) 구간은 적용 안 됨
  ok   되감아 다시 훑어도 이미 적용한 커밋은 재적용 안 함(idempotent)
```

## 4. 정직한 경계 — 어디까지가 복제이고 어디부터가 프론티어인가

이 편은 22·23·24편과 결이 다릅니다. 그 셋은 엔진에 배선 안 된 독립 모듈이었지만, **복제는 진짜 엔진의 WAL을 그대로 씁니다** — primary가 쓴 실제 로그를 replica가 읽어요. 그래도 여전히 "여기까지"를 명확히 그어야 합니다:

1. **네트워크 전송이 없다.** 이 모듈은 *십된(shipped) 로그 파일*을 읽습니다. 진짜 시스템은 primary의 **walsender**가 TCP로 WAL 바이트를 흘리고 replica의 **walreceiver**가 받죠. db-hobby엔 [19편의 psql wire 서버](/blog/project/db-hobby/db-hobby-19-wire-protocol)가 이미 있으니, 그 위에 복제 프로토콜을 얹는 게 다음 일 — 하지만 그건 별도의 큰 작업입니다.
2. **복제 슬롯(replication slot)이 없다.** primary가 replica의 catch-up보다 **먼저** 체크포인트로 로그를 truncate하면, 그 사이 커밋 구간을 놓칠 수 있어요. 진짜 시스템은 슬롯으로 "가장 뒤처진 replica가 읽을 때까지" 로그를 붙잡아 둡니다. db-hobby는 로그가 작아 실전에선 잘 안 나지만, **구조적 한계로 명시**합니다.
3. **자동 failover·합의가 없다.** primary가 죽었을 때 어느 replica가 승격하나, split-brain을 어떻게 막나 — 이건 **합의 알고리즘(Raft)** 의 영역이고 트랙 H2로 분리했어요. 이 편은 딱 **read replica**까지입니다.

이 세 경계를 아는 것이, 복제를 "구현했다"고 뭉뚱그리는 것보다 정확합니다. 복제의 **데이터 흐름**(redo 재생)은 옳게 서 있고, **분산 시스템으로서의 견고함**(전송·슬롯·합의)은 그 위에 쌓을 다음 층이라는 것.

## 5. 정리

- db-hobby가 처음으로 **분산 축**을 건드렸다 — primary → replica 복제.
- 복제는 거의 공짜였다: **WAL이 이미 redo 스트림**이고, replica는 [크래시 복구의 redo](/blog/project/db-hobby/db-hobby-14-steal-undo)를 증분·연속으로 돌릴 뿐이다(= PostgreSQL walreceiver 구조).
- **커밋 경계에서만 적용** → replica는 커밋된 상태만 본다(읽기 일관성). **미완 꼬리는 보류.**
- **redo의 idempotency**(페이지 전체 물리 로깅) 덕에 `lsn` 필터로 중복만 거르면 체크포인트 truncate·되감기에도 견딘다.
- 정직한 경계: TCP 전송·복제 슬롯·자동 failover(Raft, H2)는 프론티어로 남겼다. 이건 read replica까지다.

<!-- EN -->

## 0. Intro — One More Node, for the First Time

Through Part 24, db-hobby was a **single node** — one process holding one data file, reading and writing. But half of a real database lives in "what happens when a node dies, or when one node isn't enough." This part takes the first step: **replication**.

The most basic form is **primary → replica**. The primary takes writes and streams those changes to replica(s), which then hold the same data and can **share reads** (read scaling) or **stand in** when the primary dies.

But how do we stream them? Surprisingly, db-hobby **already has the tool.**

## 1. Replication Is Almost Free — Because the WAL Is Already a Stream

When we built the no-force WAL in [Part 15](/blog/project/db-hobby/db-hobby-15-noforce-checkpoint), a commit came to leave this log:

```
REC_PAGE(pid, after-image)   ← the final shape of a page this txn changed
REC_PAGE(pid, after-image)
...
REC_COMMIT                    ← the durability point (fsync)
```

And the **redo pass** of [crash recovery](/blog/project/db-hobby/db-hobby-14-steal-undo) does exactly this: *"reapply, in order, the after-images of segments with a commit marker."*

The decisive observation:

> **What the replica does = run that redo incrementally and continuously, not destructively.**

Keep tailing the primary's WAL, and every time a committed segment arrives, apply its after-images to **its own** data file — the replica trails the primary. This is the same structure as **walreceiver replaying WAL** in PostgreSQL streaming replication. Not a new algorithm — the **existing redo rewritten from another angle.**

![WAL log-shipping replication: the replica tails and replays committed after-images; the uncommitted tail is held back](/uploads/project/db-hobby/wal-replication.svg)

## 2. The Replica's Apply Loop

The heart of `src/replica.c` is a single `replica_apply`. It scans the log from `apply_off` (the byte position applied so far):

```c
for (;;) {
    uint8_t type;
    if (read_exact(fd, &type, 1) != 0) break;   /* EOF/partial → defer to next call */
    uint64_t lsn; read_exact(fd, &lsn, 8);

    if (type == REC_PAGE) {
        /* buffer the after-image (not yet confirmed committed) */
        read pid; read PAGE_SIZE into pend_img[npend++];
    } else if (type == REC_COMMIT) {
        /* segment end = committed → apply the buffered after-images */
        if (lsn > applied_lsn) {              /* skip an already-applied commit */
            for (i in pend) pager_write(&data, pend_pid[i], pend_img[i]);
            applied_lsn = lsn; commits_applied++;
        }
        npend = 0;
        apply_off = current_offset;           /* advance offset only at commit boundaries */
    } else { /* REC_BEGIN, REC_UNDO not needed for replay → skip */ }
}
```

Three design decisions matter.

### (a) Advance the offset **only at commit boundaries**

`apply_off` moves forward only right after processing a `REC_COMMIT`. So if the log tail has an **uncommitted segment** with no marker yet (the primary is mid-write), the replica only buffers it and stops at EOF **without applying**. On the next `replica_apply`, if the marker has arrived, it applies then. → **The replica always shows only committed state** (read consistency).

### (b) Skip `REC_UNDO` / `REC_BEGIN`

These are traces of [steal/undo](/blog/project/db-hobby/db-hobby-14-steal-undo) (before-images, the txn's starting page count) and are **useless for replay**. The replica only needs the "final committed shape," and the `REC_PAGE` after-images fully carry it. So it parses and discards them.

### (c) Filter duplicates by `lsn` — the key to surviving checkpoints

When the log exceeds 4MB, the primary [checkpoints](/blog/project/db-hobby/db-hobby-15-noforce-checkpoint) and **truncates** it (fsync data, then empty the log). Now the replica's `apply_off` is larger than the file. So the replica **rewinds the offset to 0** and rescans from the top. But the front holds commits it already applied — here `lsn > applied_lsn` saves it: **skip already-applied commits (lsn ≤)** and apply only the new ones.

The reason this is safe is a property [already proven in Part 14](/blog/project/db-hobby/db-hobby-14-steal-undo):

> **Whole-page physical logging makes redo idempotent.** Writing the same after-image twice yields the same result.

So even a duplicate application can't corrupt the data. The `lsn` filter is for **efficiency** (not doing needless work), not correctness. Without this idempotency, replication would have been far harder.

## 3. Verification — Only Committed, Lagging but Never Wrong

`test_replica` drives a primary over the real WAL and checks the replica keeps up (18 checks):

- **Basic replication** — primary commits pid0=0xAA → `replica_apply` → replica's pid0 == primary's.
- **Incremental catch-up** — primary commits two more → replica applies **only the 2 new** (not reapplying the earlier), position (lsn) advances.
- **Overwrite replication** — a new version of the same pid (0xAA→0xDD) flows through too.
- **Uncommitted tail not applied** — leaving page records with no commit marker (a pre-commit crash), the replica **does not apply** that segment; the page isn't there yet.
- **No duplicates after rewind** — forcing `apply_off` to 0 (simulating a checkpoint truncate) and rescanning still skips already-applied commits, data unchanged.

```
  ok   pid1: replica == primary (0xBB)
  ok   only the 2 new commits applied (earlier not reapplied)
  ok   uncommitted (no marker) segment not applied
  ok   rescanning after rewind does not reapply (idempotent)
```

## 4. The Honest Boundary — Where Replication Ends and the Frontier Begins

This part differs in grain from Parts 22–24. Those were standalone modules not wired into the engine; **replication uses the real engine's WAL directly** — the replica reads the actual log the primary wrote. Still, I must draw "this far" clearly:

1. **No network transport.** This module reads a *shipped* log file. A real system has the primary's **walsender** stream WAL bytes over TCP and the replica's **walreceiver** take them. db-hobby already has [Part 19's psql wire server](/blog/project/db-hobby/db-hobby-19-wire-protocol), so layering a replication protocol on top is the next step — but a separate large effort.
2. **No replication slot.** If the primary checkpoints and truncates the log **before** the replica catches up, it can miss the segments in between. A real system uses a slot to pin the log "until the most-lagging replica has read it." db-hobby's log is small so it rarely bites in practice, but I **name it as a structural limit.**
3. **No automatic failover / consensus.** When the primary dies, which replica gets promoted, and how do you prevent split-brain — that's the domain of a **consensus algorithm (Raft)**, split off as Track H2. This part goes exactly as far as a **read replica.**

Knowing these three boundaries is more accurate than lumping it as "implemented replication." The **data flow** of replication (redo replay) stands correct; the **robustness as a distributed system** (transport, slots, consensus) is the next layer to stack on top.

## 5. Wrap-up

- db-hobby touched the **distributed axis** for the first time — primary → replica replication.
- It was almost free: **the WAL is already a redo stream**, and the replica just runs [crash recovery's redo](/blog/project/db-hobby/db-hobby-14-steal-undo) incrementally and continuously (= the walreceiver structure).
- **Apply only at commit boundaries** → the replica sees only committed state (read consistency). **Uncommitted tail held back.**
- Thanks to **redo's idempotency** (whole-page physical logging), an `lsn` filter that drops duplicates survives checkpoint truncation and rewinds.
- Honest boundary: TCP transport, replication slots, and automatic failover (Raft, H2) are left as frontiers. This goes as far as a read replica.

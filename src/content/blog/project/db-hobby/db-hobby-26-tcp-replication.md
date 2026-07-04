---
title: 'WAL을 소켓으로 — 25편의 마지막 프론티어를 닫다 (walsender/walreceiver)'
titleEn: 'WAL Over a Socket — Closing Part 25''s Last Frontier (walsender/walreceiver)'
description: "25편의 복제는 replica가 primary와 '같은 파일 시스템'의 WAL 파일을 tail해야 했다 — 진짜 복제가 아니라 파일 공유 흉내였다. 25편이 스스로 남긴 1번 프론티어가 '네트워크 전송 없음'이었고, 이 편이 그걸 닫는다. 핵심은 replica.c를 한 줄도 안 고친다는 것: 네트워크 계층(walsender/walreceiver)은 primary WAL의 새 바이트를 [길이][바이트] 프레임으로 소켓에 실어 나르고, 수신 측은 그걸 자기 로컬 로그 파일에 append할 뿐이다. 그 다음은 25편의 replica_apply가 그대로 그 로컬 로그를 tail한다. 전송(바이트 나르기)과 정확성(lsn 게이트·idempotent redo)의 관심사가 깨끗하게 분리된다 — PostgreSQL이 walsender로 WAL을 스트리밍하고 startup 프로세스가 replay하는 것과 같은 역할 분리다. 소켓 위에서 sender/receiver 스레드가 락스텝으로 도는 결정적 테스트로 커밋 복제·증분 catch-up·완전 catch-up·클린 EOF를 검증한다. 정직한 경계: 복제 슬롯·동기 커밋(quorum ack)·재연결·TLS는 프론티어."
descriptionEn: "Part 25's replication required the replica to tail a WAL file on the 'same file system' as the primary — not real replication, a file-sharing imitation. The #1 frontier Part 25 named for itself was 'no network transport,' and this part closes it. The key is that replica.c is not touched at all: the network layer (walsender/walreceiver) carries the primary WAL's new bytes over a socket as [length][bytes] frames, and the receiver just appends them to its own local log file. From there, Part 25's replica_apply tails that local log unchanged. Transport (moving bytes) and correctness (the lsn gate, idempotent redo) are cleanly separated — the same split of roles as PostgreSQL streaming WAL via walsender and replaying it in the startup process. A deterministic test with sender/receiver threads in lockstep over a socket verifies commit replication, incremental catch-up, full catch-up, and clean EOF. Honest boundary: replication slots, synchronous commit (quorum ack), reconnection, and TLS are frontiers."
date: 2026-07-04
tags:
  - C
  - Database Internals
  - Replication
  - WAL
  - Distributed Systems
  - Sockets
  - Learning
category: study/db-hobby
coverImage: /uploads/project/db-hobby/cover.svg
draft: false
series: "db-hobby"
seriesOrder: 26
---

## 0. 들어가며 — 25편이 스스로 남긴 숙제

[25편](/blog/project/db-hobby/db-hobby-25-replication)에서 복제를 놓았지만, 마지막에 이렇게 정직하게 적었어요:

> "이 모듈은 *십된(shipped) 로그 파일*을 읽습니다. 진짜 시스템은 primary의 **walsender**가 TCP로 WAL 바이트를 흘리고 replica의 **walreceiver**가 받죠. … 그건 별도의 큰 작업입니다."

즉 25편의 replica는 primary와 **같은 파일 시스템의 WAL 파일**을 tail해야 했습니다. 두 노드가 사실상 한 디스크를 공유하는 셈이라, 엄밀히는 복제가 아니라 "파일 공유 흉내"였죠. 이 편은 25편이 **1번 프론티어**로 못 박은 그것 — 네트워크 전송 — 을 닫습니다.

## 1. 핵심 결정 — replica.c를 한 줄도 안 고친다

가장 쉬운 유혹은 "복제 로직을 소켓용으로 다시 쓰는" 겁니다. 하지만 그건 25편에서 애써 맞춘 정확성(lsn 게이트, idempotent redo)을 네트워크 코드에 뒤섞는 실수예요.

그래서 정반대로 갔습니다:

> **네트워크 계층은 오직 '바이트를 옮기는 파이프'다.** primary WAL의 바이트를 replica의 *로컬* 로그 파일로 옮기기만 하면, 그 다음은 25편의 `replica_apply`가 그 로컬 파일을 tail하며 알아서 재생한다.

관심사가 둘로 갈립니다:

- **전송** (`replnet.c`, 새 파일): 바이트를 소켓으로 나른다. WAL이 뭔지, 커밋이 뭔지 **모른다.**
- **정확성** (`replica.c`, 25편 그대로): 커밋 경계에서만 적용, lsn으로 중복 거르기, idempotent redo. **소켓이 뭔지 모른다.**

![WAL을 소켓으로: walsender가 새 바이트를 프레임으로 보내고 walreceiver가 로컬 로그에 append, 그 뒤 replica_apply가 그대로 재생](/uploads/project/db-hobby/tcp-replication.svg)

이건 PostgreSQL의 역할 분리와 정확히 같아요 — **walsender**가 WAL을 스트리밍하고, **startup(복구) 프로세스**가 그걸 replay합니다. 전송자는 replay를 모르고, replay는 전송을 모릅니다.

## 2. 프레이밍 — 스트림엔 경계가 없다

소켓은 **바이트 스트림**이라 "여기서 한 덩어리가 끝난다"는 표시가 없어요. 그래서 프레임을 씌웁니다:

```
[길이 8B][그 길이만큼의 WAL 바이트]
```

`walsender_send`는 primary WAL에서 `sent_off`부터 EOF까지 새 바이트를 읽어, 길이 헤더를 먼저 보내고 그 바이트를 보냅니다. `walreceiver_recv`는 길이를 먼저 읽어 **정확히 그만큼**을 받아 로컬 로그에 append하고요. 부분 read/write는 [wal.c와 같은](/blog/project/db-hobby/db-hobby-15-noforce-checkpoint) `write_all`/`read_exact` 루프로 처리합니다:

```c
int walsender_send(int sock, int log_fd, off_t *sent_off) {
    off_t eof = lseek(log_fd, 0, SEEK_END);
    if (eof < *sent_off) *sent_off = 0;   /* 체크포인트 truncate → 되감기 */
    off_t avail = eof - *sent_off;
    if (avail <= 0) return 0;             /* 새 바이트 없음 */
    ... read avail bytes from *sent_off ...
    uint64_t len = chunk;
    write_all(sock, &len, 8);            /* 길이 먼저 */
    write_all(sock, buf, chunk);         /* 그 다음 바이트 */
    *sent_off += chunk;
}
```

`sent_off`가 파일 크기보다 커지면(=primary가 체크포인트로 로그를 truncate) 0으로 되감아 다시 흘려보냅니다. 중복 전송이 되지만 [25편에서 봤듯](/blog/project/db-hobby/db-hobby-25-replication) 수신 측 `replica_apply`가 lsn으로 이미 적용한 커밋을 걸러내니 **안전**해요. 전송 계층이 정확성을 걱정하지 않아도 되는 건, 정확성이 아래층에 이미 박혀 있기 때문입니다.

## 3. 수신 측의 함정 — 읽기 fd에 쓸 순 없다

여기서 실제로 한 번 **교착(deadlock)에 빠졌습니다.** 25편의 `replica_open`은 로그 fd를 `O_RDONLY`로 엽니다 — replica는 로그를 **읽기만** 하니까요. 그런데 수신자가 받은 바이트를 바로 그 읽기 전용 fd에 `write`하려 하면 실패하고, sender는 ack를 영원히 기다리고 receiver는 다음 프레임을 영원히 기다리는 교착이 됩니다.

교훈은 실제 시스템의 구조 그대로였어요:

> **walreceiver(쓰기)와 replay(읽기)는 같은 WAL 파일을 보되 별도의 fd를 쓴다.**

수신자는 로컬 로그에 append할 **쓰기 fd**를 따로 열고, `replica_apply`는 25편의 **읽기 fd**로 그 파일을 tail합니다. 같은 파일, 두 개의 열림. PostgreSQL에서도 walreceiver가 WAL 세그먼트를 쓰고 startup 프로세스가 그걸 읽어 replay하죠.

## 4. 결정적 테스트 — 소켓 위 락스텝

동시성 테스트의 적은 **비결정성**입니다. 스레드 두 개가 자유롭게 달리면 "이번에 몇 커밋이 적용됐나"가 실행마다 달라져 검증이 흔들려요. 그래서 **락스텝**으로 묶었습니다:

- **socketpair**로 프로세스 내 양방향 스트림을 만든다(포트 flakiness 없음 — 진짜 TCP로 바꿔도 흐르는 바이트는 동일).
- **sender 스레드**: 한 라운드의 커밋을 하고 → 프레임을 보내고 → receiver의 1바이트 ack를 기다림.
- **receiver 스레드**: 프레임을 받고 → 로컬 로그에 append → `replica_apply` → 1바이트 ack를 되돌림.

ack가 라운드 경계를 강제하므로 "라운드 r에 정확히 몇 커밋이 적용됐는가"가 확정적이에요(이 ack는 **테스트 동기화용**일 뿐 — `walsender_send` 자체는 ack를 안 기다리는 비동기입니다). 결과는 공유 구조체에 적고, 스레드 join 후 **메인이 단일 스레드로** 검증해 `failures` 카운터에 경쟁이 없습니다.

검증(15 checks): 커밋된 페이지가 소켓을 타고 복제됨 · 증분 catch-up(새 커밋만 추가 적용) · 덮어쓰기 복제 · **복제 위치 == primary의 마지막 커밋 lsn**(완전 catch-up) · sender 종료를 receiver가 EOF로 감지(클린 셧다운).

```
  ok   R1: 새 커밋 2건만 적용(앞 건 재적용 안 함)
  ok   복제 위치 == primary 마지막 커밋 lsn (완전 catch-up)
  ok   sender 종료를 receiver가 EOF(recv==0)로 감지
```

## 5. 정직한 경계 — 아직 프론티어인 것

25편의 세 프론티어 중 **하나(네트워크 전송)를 닫았습니다.** 남은 것은 정직하게:

- **동기 복제 아님.** `walsender_send`는 보내기만 하고 replica의 apply ack를 기다려 커밋을 막지 않아요(비동기·최종 일관성). 동기 커밋(replica가 받았다고 답해야 커밋 확정 = quorum ack)은 다음 일.
- **복제 슬롯 없음.** primary가 replica의 catch-up 전에 체크포인트로 로그를 truncate하면 그 사이 구간을 놓칠 수 있습니다([25편과 같은 한계](/blog/project/db-hobby/db-hobby-25-replication)).
- **재연결·흐름 제어·TLS·인증 없음.** 학습용 최소 전송이에요. 진짜 이기종 TCP라면 길이 헤더도 고정 바이트 순서(htonll)가 필요하고요 — 다만 흐르는 바이트 자체는 어떤 SOCK_STREAM 위에서도 동일합니다.
- **자동 failover는 여전히 [Raft(H2)](/blog/project/db-hobby/db-hobby-25-replication)의 영역.** 이 편도 read replica까지입니다.

## 6. 정리

- 25편이 스스로 못 박은 **1번 프론티어(네트워크 전송)를 닫았다.**
- 핵심은 **replica.c 미수정** — 네트워크는 '바이트를 옮기는 파이프', 정확성은 아래층이 책임. 전송과 정확성의 관심사 분리(= PostgreSQL walsender/replay 구조).
- 스트림엔 경계가 없어 **[길이][바이트] 프레이밍**이 필요하다.
- 실제 교착으로 배운 것: **walreceiver(쓰기)와 replay(읽기)는 같은 파일, 별도 fd.**
- **락스텝 ack**로 동시성 테스트를 결정적으로 만들었다.
- 정직한 경계: 동기 커밋·복제 슬롯·재연결·TLS·failover(Raft)는 프론티어.

<!-- EN -->

## 0. Intro — The Homework Part 25 Left Itself

Part 25 laid down replication, but I honestly wrote at the end:

> "This module reads a *shipped* log file. A real system has the primary's **walsender** stream WAL bytes over TCP and the replica's **walreceiver** take them. … a separate large effort."

So Part 25's replica had to tail a WAL file **on the same file system** as the primary. The two nodes effectively shared one disk — strictly not replication, a "file-sharing imitation." This part closes what Part 25 nailed down as its **#1 frontier**: network transport.

## 1. The Key Decision — Don't Touch replica.c At All

The easy temptation is to "rewrite the replication logic for sockets." But that mixes the correctness (the lsn gate, idempotent redo) I carefully got right in Part 25 into the network code.

So I went the opposite way:

> **The network layer is only a 'pipe that moves bytes.'** Just move the primary WAL's bytes to the replica's *local* log file, and then Part 25's `replica_apply` tails that local file and replays it on its own.

Concerns split in two:

- **Transport** (`replnet.c`, new): carries bytes over a socket. It **doesn't know** what a WAL or a commit is.
- **Correctness** (`replica.c`, unchanged from Part 25): apply only at commit boundaries, filter duplicates by lsn, idempotent redo. It **doesn't know** what a socket is.

![WAL over a socket: walsender sends new bytes as frames, walreceiver appends to a local log, then replica_apply replays it unchanged](/uploads/project/db-hobby/tcp-replication.svg)

This is exactly PostgreSQL's split of roles — **walsender** streams WAL, and the **startup (recovery) process** replays it. The sender doesn't know replay; replay doesn't know the sender.

## 2. Framing — A Stream Has No Boundaries

A socket is a **byte stream**, with no marker for "a chunk ends here." So we wrap frames:

```
[length 8B][that many WAL bytes]
```

`walsender_send` reads new bytes from `sent_off` to EOF, sends the length header first, then the bytes. `walreceiver_recv` reads the length first and receives **exactly that much**, appending to the local log. Partial read/write is handled with the same [`write_all`/`read_exact`](/blog/project/db-hobby/db-hobby-15-noforce-checkpoint) loops as wal.c:

```c
int walsender_send(int sock, int log_fd, off_t *sent_off) {
    off_t eof = lseek(log_fd, 0, SEEK_END);
    if (eof < *sent_off) *sent_off = 0;   /* checkpoint truncate → rewind */
    off_t avail = eof - *sent_off;
    if (avail <= 0) return 0;             /* no new bytes */
    ... read avail bytes from *sent_off ...
    uint64_t len = chunk;
    write_all(sock, &len, 8);            /* length first */
    write_all(sock, buf, chunk);         /* then the bytes */
    *sent_off += chunk;
}
```

If `sent_off` exceeds the file size (the primary checkpointed and truncated the log), it rewinds to 0 and re-streams. That duplicates transmission, but as [seen in Part 25](/blog/project/db-hobby/db-hobby-25-replication) the receiving `replica_apply` filters already-applied commits by lsn, so it's **safe**. The transport layer needn't worry about correctness because correctness is already baked into the layer below.

## 3. The Receiver Trap — You Can't Write to a Read fd

I actually hit a **deadlock** here. Part 25's `replica_open` opens the log fd `O_RDONLY` — the replica only **reads** the log. But when the receiver tries to `write` received bytes to that read-only fd, it fails, and then the sender waits forever for an ack while the receiver waits forever for the next frame.

The lesson was exactly the real systems' structure:

> **walreceiver (writing) and replay (reading) look at the same WAL file but use separate fds.**

The receiver opens a separate **write fd** to append to the local log, while `replica_apply` tails that file through Part 25's **read fd**. One file, two opens. In PostgreSQL too, walreceiver writes WAL segments and the startup process reads and replays them.

## 4. A Deterministic Test — Lockstep Over a Socket

The enemy of a concurrency test is **nondeterminism**. Two threads running freely make "how many commits applied this time" vary per run, so assertions wobble. So I bound them in **lockstep**:

- Use **socketpair** for an in-process bidirectional stream (no port flakiness — swap in real TCP and the bytes flowing are identical).
- **sender thread**: commit a round → send a frame → wait for the receiver's 1-byte ack.
- **receiver thread**: receive a frame → append to local log → `replica_apply` → send back a 1-byte ack.

The ack forces round boundaries, so "exactly how many commits applied in round r" is deterministic (this ack is only for **test synchronization** — `walsender_send` itself doesn't wait for acks; it's asynchronous). Results go into a shared struct, and after joining the threads the **main thread verifies single-threaded**, so the `failures` counter has no race.

Verification (15 checks): committed pages replicate over the socket · incremental catch-up (only new commits applied) · overwrite replication · **replication position == the primary's last commit lsn** (full catch-up) · the receiver detects the sender's shutdown as EOF (clean shutdown).

```
  ok   R1: only the 2 new commits applied (earlier not reapplied)
  ok   replication position == primary's last commit lsn (full catch-up)
  ok   receiver detects sender shutdown as EOF (recv==0)
```

## 5. The Honest Boundary — Still Frontiers

Of Part 25's three frontiers, I **closed one (network transport).** The rest, honestly:

- **Not synchronous replication.** `walsender_send` only sends; it doesn't hold the commit waiting for the replica's apply ack (async, eventual consistency). Synchronous commit (a commit finalizes only after the replica acks receipt = quorum ack) is next.
- **No replication slot.** If the primary checkpoints and truncates the log before the replica catches up, it can miss the segments in between ([same limit as Part 25](/blog/project/db-hobby/db-hobby-25-replication)).
- **No reconnection, flow control, TLS, or auth.** A minimal learning transport. Real heterogeneous TCP would also need a fixed byte order for the length header (htonll) — though the bytes flowing are the same on any SOCK_STREAM.
- **Automatic failover is still the domain of [Raft (H2)](/blog/project/db-hobby/db-hobby-25-replication).** This part, too, goes as far as a read replica.

## 6. Wrap-up

- Closed the **#1 frontier (network transport)** Part 25 nailed down for itself.
- The key was **not touching replica.c** — the network is a 'byte-moving pipe,' correctness is the layer below's job. Transport/correctness separation (= PostgreSQL's walsender/replay structure).
- A stream has no boundaries, so **[length][bytes] framing** is needed.
- Learned from a real deadlock: **walreceiver (write) and replay (read) — same file, separate fds.**
- **Lockstep acks** made the concurrency test deterministic.
- Honest boundary: synchronous commit, replication slots, reconnection, TLS, failover (Raft) are frontiers.

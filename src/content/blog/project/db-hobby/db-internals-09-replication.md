---
title: 'DB 내부 ⑨: 복제 — 복구의 redo를 스트림으로, base backup + WAL 스트리밍까지'
titleEn: 'DB Internals ⑨: Replication — Streaming Recovery''s Redo, All the Way to Base Backup + WAL Streaming'
description: "복제의 첫 통찰은 '복제가 거의 공짜'라는 것 — no-force WAL이 이미 커밋의 순차 스트림이라, replica가 할 일은 크래시 복구의 redo를 '파괴적 일회성'이 아니라 '증분·연속'으로 돌리는 것뿐이다. PostgreSQL walreceiver가 WAL을 replay하는 그 구조. 이를 소켓에 올리면 walsender/walreceiver가 되는데, 스트림엔 경계가 없어 길이 프레이밍이 필요하고, 수신자는 읽기 전용 fd에 쓸 수 없어 실제로 교착을 밟았다. 마지막은 캡스톤 — 진짜 엔진의 커밋이 복제본에서 SELECT되기까지. 코드보다 어려웠던 건 조용히 깨지는 landmine 셋: 재오픈이 WAL을 truncate하고 LSN을 리셋해 replica가 신규 커밋을 조용히 스킵하는 것, base 스냅샷에 steal된 미커밋 페이지가 딸려오는 것, 카탈로그의 낡은 next_txn이 복제된 행을 미커밋으로 보이게 하는 것. 셋을 정리하면 필연적으로 실제 시스템과 같은 모델 — pg_basebackup + streaming replication — 에 도달한다. 구조가 그렇게 강제한다."
descriptionEn: "Replication's first insight: it's almost free — the no-force WAL is already a sequential stream of commits, so a replica merely runs crash recovery's redo 'incrementally and continuously' instead of 'destructively once.' The very structure of PostgreSQL's walreceiver replaying WAL. Put it on a socket and you get walsender/walreceiver — where streams have no boundaries (length framing required) and the receiver can't write to a read-only fd (we hit a real deadlock). The finale is the capstone: a real engine's commit becoming SELECTable on a replica. Harder than the code were three silently-breaking landmines: reopen truncating the WAL and resetting LSNs (making the replica silently skip new commits), stolen uncommitted pages riding along in the base snapshot, and a stale catalog next_txn rendering replicated rows uncommitted-invisible. Sort out all three and you arrive, inevitably, at the same model as real systems — pg_basebackup + streaming replication. The structure forces it."
date: 2026-07-05T00:00:00.000Z
tags:
  - Database Internals
  - Replication
  - WAL
  - PostgreSQL
  - Distributed Systems
  - C
category: study/db-hobby
coverImage: /uploads/project/db-hobby/cover.svg
draft: false
series: "미니 DB로 이해하는 DB 내부"
seriesOrder: 9
---

## 0. 들어가며 — 처음으로 노드를 하나 더

여기까지의 엔진은 단일 노드였어요. 노드가 죽으면 서비스도 죽습니다. 첫 번째 탈출구가 **복제(replication)** — primary의 변경을 replica가 뒤따라오게 해서, 읽기를 분산하고 장애 대비 사본을 두는 것.

이 편의 순서는 세 겹이에요: ① 복제의 핵심 통찰(놀랍게도 [3편의 WAL](/blog/project/db-hobby/db-internals-03-wal-recovery)이 이미 다 준비해 뒀습니다) → ② 그걸 진짜 소켓에 올리기 → ③ 진짜 엔진에 배선해 "커밋이 복제본에서 SELECT되기까지". 각 단계에서 실제로 밟은 함정이 그대로 교훈이 됩니다.

## 1. 복제는 거의 공짜다 — WAL이 이미 스트림이니까

[3편](/blog/project/db-hobby/db-internals-03-wal-recovery)의 no-force WAL에서 커밋은 이런 로그를 남깁니다:

```
REC_PAGE(pid, after-image)   ← 이 트랜잭션이 바꾼 페이지의 최종 모습
REC_PAGE(pid, after-image)
REC_COMMIT                    ← 내구성 지점 (fsync)
```

그리고 크래시 복구의 **redo pass**가 하는 일은 정확히 "커밋 마커가 붙은 구간의 after-image들을 순서대로 재적용"이었죠. 여기서 결정적인 관찰:

> **replica가 할 일 = 그 redo를, '파괴적 일회성 복구'가 아니라 '증분·연속'으로 돌리는 것.**

primary의 WAL을 계속 tail하면서 커밋된 구간이 도착할 때마다 after-image를 **자기** 데이터 파일에 적용하면, replica는 primary를 뒤따라옵니다. PostgreSQL 스트리밍 복제에서 walreceiver가 WAL을 replay하는 것과 같은 구조예요. **새 알고리즘이 아니라, 이미 있는 redo를 다른 각도로 다시 쓴 것** — "no-force로 로그가 진실의 원천이 되면 복제·PITR까지 받친다"던 3편의 문장이 여기서 현금화됩니다.

![WAL 로그 시핑 복제 — replica가 커밋된 after-image를 tail하며 재생, 미완 꼬리는 보류](/uploads/project/db-hobby/wal-replication.svg)

apply 루프의 정확성 규칙은 둘뿐이에요:

- **커밋 마커까지 모았다가 적용** — 미완의 꼬리(커밋 안 된 구간)는 절대 적용하지 않고 다음 호출로 미룬다. replica는 **뒤처질 순 있어도 틀리면 안 된다.**
- **LSN 필터** — 각 커밋의 LSN을 기억해(`applied_lsn`), 이미 적용한 커밋이 다시 오면 건너뛴다. 이 멱등성이 아래층의 온갖 재전송을 안전하게 만든다(다음 절에서 바로 써먹어요).

## 2. 소켓에 올리기 — walsender / walreceiver

같은 머신의 파일 tail을 진짜 네트워크로 바꿉니다. 이때의 핵심 결정 — **apply 로직(replica.c)을 한 줄도 안 고친다.** 전송 계층은 "primary의 WAL 바이트를 replica의 로컬 로그 파일로 옮기는 일"만 하고, 옮겨진 로그에 기존 apply를 그대로 돌려요. 계층 분리가 또 배당금을 줍니다.

**함정 1 — 스트림엔 경계가 없다.** 소켓은 바이트 스트림이라 "여기서 한 덩어리가 끝난다"는 표시가 없어요. `[길이 8B][그 길이만큼의 WAL 바이트]` 프레임을 씌우고, 부분 read/write를 `write_all`/`read_exact` 루프로 처리합니다. 그리고 primary가 체크포인트로 로그를 truncate하면 `sent_off`를 0으로 되감아 다시 흘려보내는데 — **중복 전송이지만 안전합니다.** 1절의 LSN 필터가 이미 적용한 커밋을 걸러 주니까요. 전송 계층이 정확성을 걱정하지 않는 건, 정확성이 아래층에 이미 박혀 있기 때문이에요.

**함정 2 — 읽기 fd에 쓸 순 없다.** 여기서 실제로 **교착**에 빠졌습니다. replica는 로그를 읽기만 하니 `O_RDONLY`로 열었는데, 수신자가 받은 바이트를 그 fd에 쓰려니 실패 — sender는 ack를, receiver는 다음 프레임을 영원히 기다리는 교착. 교훈은 실제 시스템 구조 그대로예요: **수신(쓰기)과 적용(읽기)은 다른 역할이니 fd도 다르다.** PostgreSQL의 walreceiver(쓰는 자)와 startup process(재생하는 자)가 분리돼 있는 것과 같은 이유입니다.

![TCP 복제 — walsender가 길이 프레임으로 WAL 바이트를 보내고, walreceiver가 로컬 로그에 append, apply는 기존 replica 코드 그대로](/uploads/project/db-hobby/tcp-replication.svg)

## 3. 캡스톤 — 진짜 커밋이 복제본에서 SELECT되기까지

여기까지는 "WAL 바이트가 옮겨지고 재생된다"였어요. 진짜 목표는: **실제 엔진에서 `INSERT`가 커밋되면, 복제본을 열어 `SELECT`로 그 행이 보이는 것.** 배선 코드 자체는 짧았는데, 진짜 어려움은 **naive하게 짜면 조용히 깨지는 landmine**을 아는 거였습니다. 코드를 짜기 전에 엔진의 WAL·테이블·카탈로그 구조를 먼저 지도로 그려 셋을 찾았어요.

**landmine 1 — 재오픈이 WAL을 truncate하고 LSN을 리셋한다.** `wal_open`은 열 때마다 복구를 돌리고 로그를 비우며 `next_lsn`을 1로 리셋해요([3편](/blog/project/db-hobby/db-internals-03-wal-recovery)의 "여는 것 자체가 체크포인트"). 그래서 primary를 재오픈하면 replica의 `applied_lsn`은 이미 10, 20인데 새 커밋이 lsn=1로 와서, **멱등성 필터가 신규 커밋을 조용히 전부 스킵**합니다. 테스트는 초록인데 복제가 안 되는, 가장 무서운 종류의 버그. → 대응: primary를 한 세션 내내 열어두고 살아있는 WAL을 tail한다(연속 스트리밍 모델 — 진짜 스트리밍 복제가 primary를 계속 켜두는 이유이기도).

**landmine 2 — base 스냅샷은 조용한 시점에만.** 데이터 파일엔 커밋본뿐 아니라 [steal](/blog/project/db-hobby/db-internals-03-wal-recovery)된 **미커밋 페이지**도 섞일 수 있어요. 활성 writer 도중에 복사하면 미커밋 데이터가 딸려옵니다. → writer가 없는 조용한 시점에만 복사.

**landmine 3 — 카탈로그의 낡은 next_txn.** 복제된 행이 SELECT에 **보이려면** xmin이 "커밋됨"으로 판정돼야 하는데([4편의 가시성](/blog/project/db-hobby/db-internals-04-mvcc)), 그 기준인 `next_txn`이 카탈로그에 낡은 채로 복사되면 복제된 행이 **미커밋으로 보여 사라집니다.** → `next_txn`을 확정해 쓴 뒤에 복사.

### 그래서 이건 base backup + WAL 스트리밍이다

세 landmine을 정리하면 필연적으로 실제 시스템과 같은 모델에 도달해요:

1. **base 스냅샷** — 조용한 시점의 데이터 파일(+카탈로그+인덱스)을 복제본으로 복사. PostgreSQL의 **pg_basebackup**.
2. **WAL 스트리밍** — 그 뒤의 커밋을 tail·재생. PostgreSQL의 **streaming replication**.

우연이 아니라 **구조가 강제**합니다. WAL은 유한·휘발성 로그(체크포인트로 잘림)라 그것만으론 전체 상태를 못 주고, 진짜 상태의 원천은 데이터 파일이니까 — 어느 시점의 데이터 파일을 기준으로 잡고 이후 로그를 얹는 수밖에요. 실제 DB가 base backup + WAL을 쓰는 이유를, 내 엔진에서 landmine을 밟으며 재발견한 셈입니다.

![복제되는 DB — base 스냅샷 + 살아있는 WAL tail·재생, 복제본이 완전한 DB로 열려 SELECT를 서빙](/uploads/project/db-hobby/replicated-db.svg)

끝-대-끝 검증: 실제 엔진에서 CREATE/INSERT 커밋 → 소켓으로 WAL 스트리밍 → 복제본을 완전한 DB로 열어 `SELECT` → **primary와 행 단위로 동일.**

## 4. 정직한 경계

- **단방향, 커밋 후 전송(비동기)** — primary가 커밋을 클라이언트에 답한 뒤 replica로 가므로, primary가 그 직후 죽으면 replica엔 마지막 커밋이 없을 수 있어요. PostgreSQL의 `synchronous_commit = on`(replica ack까지 대기)이 이 갭을 메우는 다이얼.
- **failover 없음** — primary가 죽었을 때 replica를 승격하고, 클라이언트를 갈아태우고, 옛 primary가 살아 돌아왔을 때(split-brain)를 다루는 건 전혀 다른 차원의 문제입니다. 그게 [10편(Raft)](/blog/project/db-hobby/db-internals-10-raft)의 주제예요 — "primary가 죽으면 누가 결정하는가"는 결국 **합의(consensus)** 문제거든요.
- **물리 복제** — 페이지 이미지를 나르는 물리(physical) 복제라, 이기종 버전·부분 테이블 복제가 안 됩니다. PostgreSQL의 logical replication이 그 다음 층.

## 5. 정리

- **복제 = redo의 스트림화.** no-force WAL이 이미 커밋의 순차 스트림이라, replica는 복구의 redo를 증분·연속으로 돌릴 뿐. 새 알고리즘이 아니다.
- **정확성 규칙 둘**: 커밋 마커까지만 적용(뒤처져도 틀리지 않게), LSN 멱등성(중복 전송을 안전하게). 전송 계층은 이 위에서 마음 편히 재전송한다.
- **소켓의 교훈**: 스트림엔 경계가 없다(길이 프레이밍), 수신과 적용은 역할이 달라 fd도 다르다(실제 교착으로 배움).
- **landmine 셋** — 재오픈의 WAL truncate/LSN 리셋, base의 미커밋 오염, 낡은 next_txn. 전부 "테스트는 초록인데 조용히 깨지는" 종류로, 구조 이해가 곧 안전판이었다.
- **필연적 수렴**: base backup + WAL 스트리밍 — pg_basebackup + streaming replication의 모델에 구조가 강제로 데려간다.

다음 편은 이 복제의 최대 약점 — **primary가 죽으면?** — 을 정면으로 다룹니다. 리더 선출, 로그 합의, 그리고 리더가 죽어도 살아남는 HA 구성까지, **Raft**입니다.

## 참고 (1차 자료 우선)

- [PostgreSQL Documentation: Log-Shipping Standby Servers / Streaming Replication](https://www.postgresql.org/docs/current/warm-standby.html)
- [PostgreSQL Documentation: pg_basebackup](https://www.postgresql.org/docs/current/app-pgbasebackup.html)
- [MySQL 8.0 Reference: Replication](https://dev.mysql.com/doc/refman/8.0/en/replication.html) — binlog 기반 논리 복제와의 대조
- 본 블로그: [트랜잭션 ACID ④: Durability](/blog/theory/transaction-acid-04-durability) · [MySQL 스토리지 스케일링](/blog/theory/mysql-storage-scaling)
- [db-hobby 코드 (GitHub)](https://github.com/dj258255/db-hobby) — `replica.c` · `replnet.c`

<!-- EN -->

## 0. Introduction — One More Node, for the First Time

The engine so far was a single node: node dies, service dies. The first way out is **replication** — a replica trailing the primary's changes, spreading reads and keeping a copy for disasters.

Three layers in order: ① replication's core insight (astonishingly, [Part 3's WAL](/blog/project/db-hobby/db-internals-03-wal-recovery) already prepared everything) → ② putting it on a real socket → ③ wiring it into the real engine until "a commit becomes SELECTable on the replica." The traps actually stepped on become the lessons.

## 1. Replication Is Almost Free — the WAL Is Already a Stream

In [Part 3](/blog/project/db-hobby/db-internals-03-wal-recovery)'s no-force WAL, a commit leaves:

```
REC_PAGE(pid, after-image)   ← final state of a page this txn changed
REC_PAGE(pid, after-image)
REC_COMMIT                    ← the durability point (fsync)
```

And crash recovery's **redo pass** does exactly: "re-apply the after-images of commit-marked ranges in order." The decisive observation:

> **A replica's job = running that redo 'incrementally and continuously' instead of 'destructively once.'**

Keep tailing the primary's WAL, and whenever a committed range arrives, apply its after-images to **your own** data file — the replica trails the primary. The same structure as PostgreSQL's walreceiver replaying WAL. **Not a new algorithm — the existing redo rewritten from another angle.** Part 3's line — "with no-force, the log becomes the source of truth underpinning replication and PITR" — is cashed in here.

![WAL log-shipping replication — the replica tails and replays committed after-images, holding back the unfinished tail](/uploads/project/db-hobby/wal-replication.svg)

The apply loop has just two correctness rules:

- **Buffer until the commit marker** — never apply an unfinished tail; defer it. A replica **may lag but must never be wrong.**
- **The LSN filter** — remember each commit's LSN (`applied_lsn`) and skip commits already applied. This idempotence makes every retransmission below safe (used immediately in the next section).

## 2. Onto the Socket — walsender / walreceiver

Replace same-machine file tailing with a real network. The key decision: **don't touch the apply logic at all.** The transport layer only "moves the primary's WAL bytes into the replica's local log file," and the existing apply runs on that log. Layering pays again.

**Trap 1 — streams have no boundaries.** A socket is a byte stream with no "this chunk ends here." Frame it as `[length 8B][that many WAL bytes]`, handling partial reads/writes with `write_all`/`read_exact` loops. When the primary's checkpoint truncates the log, rewind `sent_off` to 0 and resend — **duplicate transmission, but safe**: §1's LSN filter skips already-applied commits. The transport never worries about correctness because correctness is already embedded a layer below.

**Trap 2 — you can't write to a read-only fd.** We hit a real **deadlock** here. The replica opens its log `O_RDONLY` (it only reads it) — then the receiver tries writing incoming bytes to that fd and fails; the sender waits forever for an ack, the receiver forever for the next frame. The lesson mirrors real systems: **receiving (writing) and applying (reading) are different roles, so they use different fds** — the same reason PostgreSQL separates the walreceiver (writer) from the startup process (replayer).

![TCP replication — walsender ships WAL bytes in length frames; walreceiver appends to a local log; apply is the untouched replica code](/uploads/project/db-hobby/tcp-replication.svg)

## 3. The Capstone — a Real Commit, SELECTable on the Replica

So far, "WAL bytes move and replay." The real goal: **commit an `INSERT` on the actual engine, open the replica, and see the row in a `SELECT`.** The wiring code was short; the real difficulty was knowing the **landmines that break silently if coded naively.** Mapping the engine's WAL/table/catalog structure before coding surfaced three:

**Landmine 1 — reopen truncates the WAL and resets LSNs.** `wal_open` runs recovery on every open, clears the log, and resets `next_lsn` to 1 ([Part 3](/blog/project/db-hobby/db-internals-03-wal-recovery)'s "opening is itself a checkpoint"). Reopen the primary and the replica's `applied_lsn` sits at 10, 20 — while new commits arrive at lsn=1, so **the idempotence filter silently skips every new commit.** Green tests, broken replication — the scariest kind of bug. → Keep the primary open for the whole session and tail its live WAL (the continuous-streaming model — also why real streaming replication keeps the primary up).

**Landmine 2 — base snapshots only at quiet moments.** The data file can contain [stolen](/blog/project/db-hobby/db-internals-03-wal-recovery) **uncommitted pages** alongside committed ones. Copy during an active writer and uncommitted data rides along. → Copy only when no writer is active.

**Landmine 3 — a stale catalog next_txn.** For replicated rows to be **visible**, their xmin must judge as "committed" ([Part 4's visibility](/blog/project/db-hobby/db-internals-04-mvcc)) — and the yardstick is the catalog's `next_txn`. Copy it stale and replicated rows **look uncommitted and vanish from SELECTs.** → Copy after `next_txn` is finalized and written.

### So It's Base Backup + WAL Streaming

Sort out the three landmines and you inevitably arrive at the real systems' model:

1. **Base snapshot** — copy the data files (+catalog+indexes) at a quiet moment. PostgreSQL's **pg_basebackup**.
2. **WAL streaming** — tail and replay commits thereafter. PostgreSQL's **streaming replication**.

Not a coincidence — **the structure forces it.** The WAL is a finite, volatile log (trimmed by checkpoints), so it alone can't convey full state; the source of committed state is the data file — so you must anchor on a point-in-time data file and layer the log on top. The reason real DBs use base backup + WAL, rediscovered by stepping on landmines in one's own engine.

![The replicated DB — base snapshot + live WAL tail/replay; the replica opens as a full DB serving SELECTs](/uploads/project/db-hobby/replicated-db.svg)

End-to-end verification: commit CREATE/INSERT on the real engine → stream WAL over the socket → open the replica as a full DB → `SELECT` — **row-for-row identical with the primary.**

## 4. Honest Boundaries

- **One-way, send-after-commit (async)** — the primary acknowledges the commit before it reaches the replica, so a crash right after can lose the last commit on the replica. PostgreSQL's `synchronous_commit = on` (wait for replica ack) is the dial that closes this gap.
- **No failover** — promoting a replica when the primary dies, repointing clients, and handling the old primary's return (split-brain) is a different dimension entirely. That's [Part 10 (Raft)](/blog/project/db-hobby/db-internals-10-raft) — "who decides, when the primary dies" is ultimately a **consensus** problem.
- **Physical replication** — page images are shipped, so cross-version or partial-table replication is out. PostgreSQL's logical replication is the next layer.

## 5. Wrap-up

- **Replication = redo, streamed.** The no-force WAL is already a sequential stream of commits; the replica just runs recovery's redo incrementally. No new algorithm.
- **Two correctness rules**: apply only up to commit markers (lag, never lie), and LSN idempotence (making retransmission safe). The transport retransmits with a clear conscience on top.
- **Socket lessons**: streams have no boundaries (length framing); receiving and applying are different roles with different fds (learned via a real deadlock).
- **Three landmines** — reopen's WAL truncate/LSN reset, uncommitted contamination of the base, stale next_txn. All of the "tests green, silently broken" kind; structural understanding was the safety net.
- **Inevitable convergence**: base backup + WAL streaming — the structure marches you to pg_basebackup + streaming replication.

Next, this replication's greatest weakness — **what if the primary dies?** — head-on. Leader election, log consensus, and an HA configuration that survives leader death: **Raft.**

## References (primary sources first)

- [PostgreSQL Documentation: Log-Shipping Standby Servers / Streaming Replication](https://www.postgresql.org/docs/current/warm-standby.html)
- [PostgreSQL Documentation: pg_basebackup](https://www.postgresql.org/docs/current/app-pgbasebackup.html)
- [MySQL 8.0 Reference: Replication](https://dev.mysql.com/doc/refman/8.0/en/replication.html)
- This blog: [Transaction ACID ④: Durability](/blog/theory/transaction-acid-04-durability) · [MySQL Storage Scaling](/blog/theory/mysql-storage-scaling)
- [db-hobby source (GitHub)](https://github.com/dj258255/db-hobby) — `replica.c` · `replnet.c`

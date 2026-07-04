---
title: '캡스톤 — "독립 모듈"을 "진짜 복제되는 DB"로 배선하다'
titleEn: 'Capstone — Wiring the "Standalone Modules" Into a Real Replicated Database'
description: "22·24·27·28~30편에서 만든 고급 축들(동시성 B+Tree·조인 옵티마이저·LSM·Raft·복제)은 전부 '엔진 옆에 선 독립 모듈'이었다. 400개 넘는 green 테스트를 지키려는 정직한 선택이었지만, 동시에 이 프로젝트의 가장 큰 약점이기도 했다 — '다 데모 아니냐'. 이 캡스톤은 그중 복제를 실제 db.c 엔진에 배선해 그 비판을 정면으로 없앤다: 진짜 db_exec로 CREATE TABLE + INSERT를 커밋하면 실제 엔진이 .wal에 REC_PAGE+REC_COMMIT을 쓰고, 25편의 replica.c가 바로 그 '실엔진 WAL'을 tail·재생해 replica의 힙이 primary와 바이트 동일해지며, 그 복제본을 진짜 Database로 열면 SELECT가 복제된 행을 그대로 반환한다(PK 인덱스 점 조회까지). 모델은 pg_basebackup + WAL 스트리밍이다. 그리고 이 편의 절반은 리서치 서브에이전트가 파낸 landmine 이야기다 — wal_open이 재오픈마다 .wal을 truncate하고 LSN을 1로 리셋해서, primary를 재오픈하면 신규 커밋이 조용히 스킵된다. 그래서 primary는 한 세션 내내 열어두고 base 스냅샷은 조용한 시점에, 카탈로그는 db_close로 next_txn을 확정한 뒤 복사한다."
descriptionEn: "The advanced axes from Parts 22, 24, 27, 28–30 (concurrent B+Tree, join optimizer, LSM, Raft, replication) were all 'standalone modules standing next to the engine.' An honest choice to keep 400+ green tests safe — but also this project's biggest weakness: 'aren't these all just demos?' This capstone wires one of them — replication — into the real db.c engine to kill that critique head-on: a real db_exec commits CREATE TABLE + INSERT, the actual engine writes REC_PAGE+REC_COMMIT to the .wal, Part 25's replica.c tails that very real-engine WAL and replays it so the replica's heap becomes byte-identical to the primary, and opening that replica as a real database returns the replicated rows from SELECT (down to a PK index point lookup). The model is pg_basebackup + WAL streaming. And half of this part is the landmine a research subagent dug out: wal_open truncates the .wal and resets the LSN to 1 on every reopen, so reopening the primary silently skips new commits. So the primary stays open across one session, the base snapshot is taken at a quiet point, and the catalog is copied after db_close finalizes next_txn."
date: 2026-07-04
tags:
  - C
  - Database Internals
  - Replication
  - WAL
  - Distributed Systems
  - Integration
  - Learning
category: study/db-hobby
coverImage: /uploads/project/db-hobby/cover.svg
draft: false
series: "db-hobby"
seriesOrder: 31
---

## 0. 들어가며 — 30편의 가장 큰 약점

여기까지 오면서 정직하게 반복한 문장이 있어요. [22편](/blog/project/db-hobby/db-hobby-22-latch-crabbing)·[24편](/blog/project/db-hobby/db-hobby-24-join-order)·[27편](/blog/project/db-hobby/db-hobby-27-lsm-engine)·[28~30편](/blog/project/db-hobby/db-hobby-28-raft-consensus)의 고급 축들 — 동시성 B+Tree, 조인 옵티마이저, LSM, Raft, 복제 — 을 만들 때마다 이렇게 적었죠:

> "이건 엔진에 배선 안 된 **독립 모듈**입니다. 400개 넘는 green 테스트를 지키려는 선택이에요."

정직한 결정이었지만, 동시에 이 프로젝트의 **가장 큰 약점**이기도 합니다. 냉정한 리뷰어라면 이렇게 말할 거예요 — *"그래서 그거 다 DB 옆에 세워둔 데모 아니냐?"* 맞는 지적이에요. `raft.c`가 아무리 정확해도, db-hobby의 실제 트랜잭션을 복제하지 않으면 "Raft를 붙인 DB"가 아니라 "Raft 모듈과 DB가 한 폴더에 있는 것"일 뿐이죠.

이 캡스톤은 그중 **복제**를 실제 `db.c` 엔진에 배선해, 그 비판을 정면으로 없앱니다.

## 1. 목표 — 진짜 커밋이 복제본에서 SELECT되기까지

증명하고 싶은 건 딱 하나예요:

> primary에서 **진짜 `db_exec`로 INSERT**한 데이터가, [25편의 replica.c](/blog/project/db-hobby/db-hobby-25-replication)를 통해 복제본으로 흘러, 그 **복제본을 진짜 Database로 열면 SELECT로 보인다.**

합성 WAL이 아니라 **실제 엔진이 커밋한 WAL**이어야 합니다. 그래야 "replica.c가 진짜 이 DB를 복제한다"가 증명되니까요.

![캡스톤: 실제 db_exec 커밋이 쓴 WAL을 replica가 재생해 복제본이 SELECT를 서빙](/uploads/project/db-hobby/replicated-db.svg)

## 2. 배선 — 실엔진 WAL을 그대로 tail

다행히 [25편](/blog/project/db-hobby/db-hobby-25-replication)에서 replica.c를 만들 때, 그것이 소비하는 레코드 포맷을 [wal.c](/blog/project/db-hobby/db-hobby-15-noforce-checkpoint)가 쓰는 포맷과 **똑같이** 맞춰 뒀어요(`REC_PAGE`/`REC_COMMIT`을 `wal.h`에서 공유). 그래서 실제 엔진이 `INSERT` 커밋 때 테이블의 `.wal`에 쓰는 바이트를, replica.c가 **한 줄도 안 고치고** 그대로 읽을 수 있습니다.

흐름은 이렇습니다:

```c
// 1) primary: 진짜 엔진으로 스키마 + 데이터
Database prim; db_open(&prim, "primary.db");
db_exec(&prim, "CREATE TABLE t (id INT, name TEXT)", out);
for (i=1..10) db_exec(&prim, "INSERT INTO t VALUES (i, 'name_i')", out);
db_close(&prim);   // 카탈로그(next_txn) 확정. 닫기는 .wal을 안 지운다.

// 2) replica.c가 primary의 '실엔진 .wal'을 재생
WalReplica r;
replica_open(&r, "replica.t.tbl", "primary.t.wal");
while (replica_apply(&r) > 0) ;   // 커밋된 세그먼트를 전부 redo

// 3) 복제본을 '진짜 Database'로 열어 SELECT
Database rep; db_open(&rep, "replica.db");
db_exec(&rep, "SELECT * FROM t", out);   // -> name_1 .. name_10
```

결과: replica의 힙(`.tbl`)이 primary와 **바이트 동일**해지고, 복제본을 열어 `SELECT * FROM t`를 하면 복제된 10개 행이 그대로 나옵니다. PK 인덱스까지 복사하니 `WHERE id = 7` 점 조회도 동작하고요.

```
  ok   복제: replica 힙이 primary와 바이트 동일(실엔진 WAL 재생)
  ok   복제본 SELECT가 10개 행 전부 반환
  ok   복제본에서 PK 인덱스 점 조회도 동작(id=7)
```

## 3. 이 편의 절반 — 리서치가 파낸 landmine

배선 코드 자체는 짧아요. 진짜 어려움은 **"naive하게 짜면 조용히 깨지는 곳"** 을 아는 거였고, 그건 코드를 짜기 전에 **리서치 서브에이전트**에게 엔진의 WAL·테이블·파일 구조를 먼저 지도로 그리게 해서 찾았습니다. 세 개의 landmine이 나왔어요.

### landmine 1 — wal_open이 재오픈마다 .wal을 truncate + LSN 리셋

이게 치명적이었어요. `wal_open`은 열 때마다 크래시 복구(`wal_recover`)를 돌리고, 그 끝에서 **로그를 통째로 truncate**합니다. 게다가 `next_lsn`을 **1로 리셋**해요. 그래서:

> primary를 **재오픈**하면, 그 순간 `.wal`이 비워지고 새 커밋의 LSN이 다시 1부터 시작한다. replica의 `applied_lsn`은 이미 10, 20…까지 올라가 있는데, 재시작 후 커밋이 lsn=1로 오면 replica의 `lsn > applied_lsn` 필터가 **거짓**이 돼서 신규 커밋을 **조용히 전부 스킵**한다.

테스트가 초록불인데 실제 복제는 안 되는, 가장 무서운 종류의 버그죠. 대응: **primary를 재오픈하지 않는다.** 한 세션 내내 열어두고, 그 살아있는 `.wal`을 실시간으로 tail합니다(연속 스트리밍 모델). 이게 진짜 스트리밍 복제가 primary를 계속 켜두는 이유이기도 해요.

### landmine 2 — base 스냅샷은 조용한 시점에만

`.tbl`에는 no-force로 커밋된 페이지뿐 아니라 [steal](/blog/project/db-hobby/db-hobby-14-steal-undo)된 **미커밋 페이지**도 섞일 수 있습니다. 활성 writer 트랜잭션 도중에 base 복사를 뜨면 미커밋 데이터가 딸려와요. → `writer_txn == 0`인 조용한 시점에만 복사.

### landmine 3 — 카탈로그의 next_txn과 MVCC 가시성

복제본을 열어 SELECT가 행을 **보려면**, 그 행들의 `xmin`이 "커밋됨"으로 판정돼야 합니다([16·18편의 가시성 게이트](/blog/project/db-hobby/db-hobby-16-delete-xmax)). 그 판정 기준이 카탈로그에 저장된 `next_txn`이에요. 그런데 세션 도중의 카탈로그는 `next_txn`이 낡아 있을 수 있어서, 그대로 복사하면 복제된 행이 **미커밋으로 보여 SELECT에서 사라집니다.** 대응: `db_close`가 `next_txn`을 확정해 카탈로그에 쓴 **뒤**에 복사한다(닫기는 `.wal`을 안 지우므로 안전).

세 landmine 모두 **테스트만으론 안 드러나는** 종류예요 — 리서치로 구조를 정확히 이해한 게 그대로 설계의 안전판이 됐습니다. ([30편](/blog/project/db-hobby/db-hobby-30-raft-snapshot)에서 적대적 리뷰가 실버그를 잡았듯, 이번엔 사전 리서치가 landmine을 미리 치웠어요.)

## 4. 그래서 이건 base-backup + WAL 스트리밍이다

세 landmine을 정리하면, 결국 진짜 시스템과 같은 모델에 도달합니다:

1. **base 스냅샷** — 조용한 시점의 `.tbl`(+카탈로그+인덱스)을 복제본으로 복사. PostgreSQL의 `pg_basebackup`.
2. **WAL 스트리밍** — 그 뒤 primary가 커밋하는 `.wal`을 replica가 tail·재생. PostgreSQL의 streaming replication.

우연이 아니라 **구조가 그렇게 강제한** 거예요. `.wal`은 유한·휘발성 로그(체크포인트로 잘림)라 그것만으론 전체 상태를 못 주고, 진짜 커밋 상태의 원천은 `.tbl`이니까 — 어느 시점 `.tbl`을 기준으로 잡고 이후 로그를 얹는 수밖에 없습니다. 실제 DB가 base backup + WAL을 쓰는 이유를, 내 엔진에서 landmine을 밟으며 다시 발견한 셈이에요.

## 5. 정직한 경계

- **단일 테이블·단일 세션 데모.** 여러 테이블·인덱스의 `.wal`을 각각 스트리밍하고, primary 재시작을 넘나드는 LSN 영속화(landmine 1의 근본 해결)까지 가면 진짜 운영 복제예요. 여기선 그 뼈대를 증명하는 데까지.
- **복제 슬롯 없음.** primary가 catch-up 전에 체크포인트로 `.wal`을 truncate하면 그 사이 구간 유실([25편과 같은 한계](/blog/project/db-hobby/db-hobby-25-replication)).
- **live 소켓 모드(`--replica`)는 안 만듦.** [26편의 소켓 전송](/blog/project/db-hobby/db-hobby-26-tcp-replication)을 이 배선 위에 얹으면 두 프로세스가 실제로 복제하는 CLI가 되지만, 그건 다음 정거장.
- **Raft·LSM은 여전히 독립 모듈.** 이 캡스톤은 복제 하나만 엔진에 배선했어요. Raft로 실제 WAL을 복제하고 LSM을 저장 엔진으로 꽂는 건 각각 또 하나의 캡스톤입니다.

## 6. 정리

- 30편의 가장 큰 약점 — 고급 축들이 **엔진 옆의 독립 모듈** — 을, 그중 **복제를 실제 db.c에 배선**해 정면으로 없앴다.
- 진짜 `db_exec` 커밋이 쓴 `.wal`을 [replica.c](/blog/project/db-hobby/db-hobby-25-replication)가 재생 → 힙 바이트 동일 → **복제본을 열어 SELECT가 복제된 행을 본다.**
- 이 편의 절반은 **리서치 서브에이전트가 파낸 landmine** — wal_open의 truncate+LSN 리셋, steal된 미커밋 페이지, 카탈로그 next_txn 가시성 — 을 피한 이야기다. 테스트만으론 안 드러나는 것들.
- 구조가 강제한 모델 = **base-backup + WAL 스트리밍**(pg_basebackup + streaming replication을 landmine 밟으며 재발견).
- 정직한 경계: 단일 테이블·세션 데모, 복제 슬롯·다중 테이블·live 소켓·Raft/LSM 배선은 프론티어.

30편을 쌓아 올린 이 시리즈에서, 마지막으로 한 조각을 **"옆에 선 데모"에서 "엔진의 일부"로** 옮겼습니다. 무엇을 만들었는지만큼, 만든 걸 어떻게 **진짜로 이어 붙이는지**가 엔지니어링이니까요.

<!-- EN -->

## 0. Intro — The Biggest Weakness of 30 Parts

Coming this far, there's a sentence I honestly repeated. Building the advanced axes of [Part 22](/blog/project/db-hobby/db-hobby-22-latch-crabbing), [24](/blog/project/db-hobby/db-hobby-24-join-order), [27](/blog/project/db-hobby/db-hobby-27-lsm-engine), [28–30](/blog/project/db-hobby/db-hobby-28-raft-consensus) — concurrent B+Tree, join optimizer, LSM, Raft, replication — I always wrote:

> "This is a **standalone module** not wired into the engine. A choice to keep 400+ green tests safe."

An honest decision, but also this project's **biggest weakness.** A cold reviewer would say — *"so aren't these all demos parked next to the DB?"* Fair. However correct `raft.c` is, if it doesn't replicate db-hobby's real transactions, it's not "a DB with Raft" but "a Raft module and a DB in the same folder."

This capstone wires one of them — **replication** — into the real `db.c` engine to kill that critique head-on.

## 1. The Goal — From a Real Commit to a SELECT on the Replica

There's exactly one thing to prove:

> Data **`INSERT`ed via a real `db_exec`** on the primary flows through [Part 25's replica.c](/blog/project/db-hobby/db-hobby-25-replication) to a replica, and **opening that replica as a real database shows it via SELECT.**

It must be the WAL a **real engine committed**, not a synthetic one. Only then is "replica.c actually replicates this DB" proven.

![Capstone: a replica replays the WAL a real db_exec committed, then serves SELECT](/uploads/project/db-hobby/replicated-db.svg)

## 2. The Wiring — Tail the Real-Engine WAL As-Is

Fortunately, when I built replica.c in [Part 25](/blog/project/db-hobby/db-hobby-25-replication), I made the record format it consumes **identical** to what [wal.c](/blog/project/db-hobby/db-hobby-15-noforce-checkpoint) writes (`REC_PAGE`/`REC_COMMIT` shared from `wal.h`). So the bytes the real engine writes to a table's `.wal` on an `INSERT` commit can be read by replica.c **without changing a line**.

The flow:

```c
// 1) primary: schema + data via the real engine
Database prim; db_open(&prim, "primary.db");
db_exec(&prim, "CREATE TABLE t (id INT, name TEXT)", out);
for (i=1..10) db_exec(&prim, "INSERT INTO t VALUES (i, 'name_i')", out);
db_close(&prim);   // finalize the catalog (next_txn). close does NOT wipe the .wal.

// 2) replica.c replays the primary's real-engine .wal
WalReplica r;
replica_open(&r, "replica.t.tbl", "primary.t.wal");
while (replica_apply(&r) > 0) ;   // redo every committed segment

// 3) open the replica as a real Database and SELECT
Database rep; db_open(&rep, "replica.db");
db_exec(&rep, "SELECT * FROM t", out);   // -> name_1 .. name_10
```

Result: the replica's heap (`.tbl`) becomes **byte-identical** to the primary, and opening the replica for `SELECT * FROM t` returns the 10 replicated rows. Copy the PK index too and `WHERE id = 7` point lookups work.

```
  ok   replication: replica heap byte-identical to primary (real-engine WAL replay)
  ok   replica SELECT returns all 10 rows
  ok   PK index point lookup works on the replica (id=7)
```

## 3. Half of This Part — The Landmines Research Dug Out

The wiring code is short. The real difficulty was knowing **where a naive version silently breaks**, and I found that by first having a **research subagent** map the engine's WAL/table/file structure before writing any code. Three landmines surfaced.

### Landmine 1 — wal_open truncates the .wal and resets the LSN on every reopen

This was the deadly one. `wal_open` runs crash recovery (`wal_recover`) on open, and at the end **truncates the whole log**. Worse, it **resets `next_lsn` to 1**. So:

> **Reopening** the primary wipes the `.wal` and restarts new commits' LSNs from 1. The replica's `applied_lsn` is already at 10, 20…, so a post-restart commit arriving with lsn=1 fails the replica's `lsn > applied_lsn` filter and gets **silently skipped entirely.**

The scariest kind of bug — green tests, but replication doesn't actually work. The fix: **never reopen the primary.** Keep it open across the session and tail its live `.wal` in real time (the continuous streaming model). This is exactly why real streaming replication keeps the primary up.

### Landmine 2 — the base snapshot only at a quiet point

The `.tbl` can contain not just no-force-committed pages but also [stolen](/blog/project/db-hobby/db-hobby-14-steal-undo) **uncommitted pages**. Copying the base during an active writer transaction drags in uncommitted data. → Copy only at a quiet point where `writer_txn == 0`.

### Landmine 3 — the catalog's next_txn and MVCC visibility

For a SELECT on the replica to **see** the rows, their `xmin` must be judged "committed" (the [Part 16/18 visibility gate](/blog/project/db-hobby/db-hobby-16-delete-xmax)). That judgment uses `next_txn` stored in the catalog. But the catalog mid-session can hold a stale `next_txn`, so copying it as-is makes the replicated rows look **uncommitted and vanish from SELECT.** The fix: copy the catalog **after** `db_close` finalizes `next_txn` (close doesn't wipe the `.wal`, so it's safe).

All three are the kind that **tests alone won't reveal** — understanding the structure precisely through research became the design's safety net. (Just as [Part 30](/blog/project/db-hobby/db-hobby-30-raft-snapshot)'s adversarial review caught a real bug, this time up-front research cleared the landmines in advance.)

## 4. So This Is base-backup + WAL Streaming

Put the three landmines together and you arrive at the same model as real systems:

1. **Base snapshot** — copy the `.tbl` (+ catalog + index) at a quiet point to the replica. PostgreSQL's `pg_basebackup`.
2. **WAL streaming** — then the replica tails and replays the `.wal` the primary commits afterward. PostgreSQL's streaming replication.

Not by coincidence — the **structure forces it.** The `.wal` is a finite, volatile log (trimmed by checkpoints), so it can't hand over the full state alone; the source of true committed state is the `.tbl` — so you must anchor on the `.tbl` at some point and layer the log on top. I rediscovered why real DBs use base backup + WAL, by stepping on the landmines in my own engine.

## 5. The Honest Boundary

- **Single-table, single-session demo.** Streaming each table's/index's `.wal` separately, and persisting the LSN across primary restarts (the root fix for landmine 1), gets you real operational replication. Here I prove the skeleton.
- **No replication slot.** If the primary checkpoints and truncates the `.wal` before catch-up, the gap is lost ([same limit as Part 25](/blog/project/db-hobby/db-hobby-25-replication)).
- **No live socket mode (`--replica`).** Layering [Part 26's socket transport](/blog/project/db-hobby/db-hobby-26-tcp-replication) on this wiring gives a CLI where two processes actually replicate, but that's the next stop.
- **Raft and LSM are still standalone.** This capstone wired in only replication. Replicating the real WAL through Raft, and plugging LSM in as a storage engine, are each another capstone.

## 6. Wrap-up

- Killed 30 parts' biggest weakness — the advanced axes being **standalone modules beside the engine** — by **wiring replication into the real db.c**.
- The `.wal` a real `db_exec` committed is replayed by [replica.c](/blog/project/db-hobby/db-hobby-25-replication) → byte-identical heap → **opening the replica, SELECT sees the replicated rows.**
- Half this part is avoiding the **landmines a research subagent dug out** — wal_open's truncate+LSN reset, stolen uncommitted pages, catalog next_txn visibility — none of which tests alone reveal.
- The model the structure forced = **base-backup + WAL streaming** (rediscovering pg_basebackup + streaming replication by stepping on landmines).
- Honest boundary: single-table/session demo; replication slots, multi-table, a live socket, and Raft/LSM wiring are frontiers.

In a series stacked 30 parts high, I finally moved one piece **from "a demo beside it" to "part of the engine."** Because engineering is as much about how you truly **wire things together** as about what you build.

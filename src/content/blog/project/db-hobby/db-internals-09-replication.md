---
title: 'DB 내부 ⑨: 복제 — 복구의 redo를 스트림으로, base backup + WAL 스트리밍까지'
titleEn: 'DB Internals ⑨: Replication — Streaming Recovery''s Redo, All the Way to Base Backup + WAL Streaming'
description: "복제의 첫 통찰은 '복제가 거의 공짜'라는 것 — no-force WAL이 이미 커밋의 순차 스트림이라, replica가 할 일은 크래시 복구의 redo를 '파괴적 일회성'이 아니라 '증분·연속'으로 돌리는 것뿐이다. PostgreSQL에서 walreceiver가 WAL을 받아 쓰고 startup process가 replay하는 그 구조. 이를 소켓에 올리면 walsender/walreceiver가 되는데, 스트림엔 경계가 없어 길이 프레이밍이 필요하고, 수신자는 읽기 전용 fd에 쓸 수 없어 실제로 교착을 밟았다. 마지막은 캡스톤 — 진짜 엔진의 커밋이 복제본에서 SELECT되기까지. 코드보다 어려웠던 건 조용히 깨지는 landmine 셋: 재오픈이 WAL을 truncate하고 LSN을 리셋해 replica가 신규 커밋을 조용히 스킵하는 것, base 스냅샷에 steal된 미커밋 페이지가 딸려오는 것, 카탈로그의 낡은 next_txn이 복제된 행을 미커밋으로 보이게 하는 것. 셋을 정리하면 필연적으로 실제 시스템과 같은 모델 — pg_basebackup + streaming replication — 에 도달한다. 구조가 그렇게 강제한다."
descriptionEn: "Replication's first insight: it's almost free — the no-force WAL is already a sequential stream of commits, so a replica merely runs crash recovery's redo 'incrementally and continuously' instead of 'destructively once.' The very structure of PostgreSQL's walreceiver writing WAL down and the startup process replaying it. Put it on a socket and you get walsender/walreceiver — where streams have no boundaries (length framing required) and the receiver can't write to a read-only fd (we hit a real deadlock). The finale is the capstone: a real engine's commit becoming SELECTable on a replica. Harder than the code were three silently-breaking landmines: reopen truncating the WAL and resetting LSNs (making the replica silently skip new commits), stolen uncommitted pages riding along in the base snapshot, and a stale catalog next_txn rendering replicated rows uncommitted-invisible. Sort out all three and you arrive, inevitably, at the same model as real systems — pg_basebackup + streaming replication. The structure forces it."
date: 2026-06-18T00:00:00.000Z
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

primary의 WAL을 계속 tail하면서 커밋된 구간이 도착할 때마다 after-image를 **자기** 데이터 파일에 적용하면, replica는 primary를 뒤따라옵니다. PostgreSQL 스트리밍 복제에서 walreceiver가 WAL을 받아 디스크에 쓰고 **startup process**가 replay하는 것과 같은 구조예요. **새 알고리즘이 아니라, 이미 있는 redo를 다른 각도로 다시 쓴 것** — "no-force로 로그가 진실의 원천이 되면 복제·PITR까지 받친다"던 3편의 문장이 여기서 현금화됩니다.

![WAL 로그 시핑 복제 — replica가 커밋된 after-image를 tail하며 재생, 미완 꼬리는 보류](/uploads/project/db-hobby/wal-replication.svg)

apply 루프의 정확성 규칙은 둘뿐이에요:

- **커밋 마커까지 모았다가 적용** — 미완의 꼬리(커밋 안 된 구간)는 절대 적용하지 않고 다음 호출로 미룬다. replica는 **뒤처질 순 있어도 틀리면 안 된다.**
- **LSN 필터** — 각 커밋의 LSN을 기억해(`applied_lsn`), 이미 적용한 커밋이 다시 오면 건너뛴다. 이 멱등성이 아래층의 온갖 재전송을 안전하게 만든다(다음 절에서 바로 써먹어요).

## 2. 소켓에 올리기 — walsender / walreceiver

같은 머신의 파일 tail을 진짜 네트워크로 바꿉니다. 이때의 핵심 결정 — **apply 로직(replica.c)을 한 줄도 안 고친다.** 전송 계층은 "primary의 WAL 바이트를 replica의 로컬 로그 파일로 옮기는 일"만 하고, 옮겨진 로그에 기존 apply를 그대로 돌려요. 계층 분리가 또 배당금을 줍니다.

**함정 1 — 스트림엔 경계가 없다.** 소켓은 바이트 스트림이라 "여기서 한 덩어리가 끝난다"는 표시가 없어요. `[길이 8B][그 길이만큼의 WAL 바이트]` 프레임을 씌우고, 부분 read/write를 `write_all`/`read_exact` 루프로 처리합니다. 그리고 primary가 체크포인트로 로그를 truncate하면 `sent_off`를 0으로 되감아 다시 흘려보내는데 — **중복 전송이지만 안전합니다.** 1절의 LSN 필터가 이미 적용한 커밋을 걸러 주니까요. 전송 계층이 정확성을 걱정하지 않는 건, 정확성이 아래층에 이미 박혀 있기 때문이에요.

그런데 되감아 다시 보낼 로그가 **아직 남아 있어야** 이 이야기가 성립합니다. 실제 PostgreSQL에서 문제가 되는 게 바로 이 지점이에요 — replica가 느리거나 잠시 끊긴 사이 체크포인트가 오래된 WAL 세그먼트를 치워 버리면, replica가 다시 붙었을 때 이런 에러를 만납니다:

```
ERROR: requested WAL segment 0000000100000000000000XX has already been removed
```

§3에서 볼 landmine 1("체크포인트가 WAL을 자른다")이 실제 시스템에서 갖는 얼굴이에요. PG의 해법이 **physical replication slot** — replica가 어디까지 받았는지를 primary가 기억하고, 그보다 뒤의 WAL 세그먼트를 지우지 않게 보존합니다. 반대급부도 정확히 그 보존입니다: replica가 죽었는데 슬롯이 남아 있으면 WAL이 **무한히 쌓여 primary 디스크가 차요.** 그래서 `max_slot_wal_keep_size`로 보존량에 상한을 둡니다.

**함정 2 — 읽기 fd에 쓸 순 없다.** 여기서 실제로 **교착**에 빠졌습니다. replica는 로그를 읽기만 하니 `O_RDONLY`로 열었는데, 수신자가 받은 바이트를 그 fd에 쓰려니 실패 — sender는 ack를, receiver는 다음 프레임을 영원히 기다리는 교착. 교훈은 실제 시스템 구조 그대로예요: **수신(쓰기)과 적용(읽기)은 다른 역할이니 fd도 다르다.** PostgreSQL의 walreceiver(쓰는 자)와 startup process(재생하는 자)가 분리돼 있는 것과 같은 이유입니다.

![TCP 복제 — walsender가 길이 프레임으로 WAL 바이트를 보내고, walreceiver가 로컬 로그에 append, apply는 기존 replica 코드 그대로](/uploads/project/db-hobby/tcp-replication.svg)

## 3. 캡스톤 — 진짜 커밋이 복제본에서 SELECT되기까지

여기까지는 "WAL 바이트가 옮겨지고 재생된다"였어요. 진짜 목표는: **실제 엔진에서 `INSERT`가 커밋되면, 복제본을 열어 `SELECT`로 그 행이 보이는 것.** 배선 코드 자체는 짧았는데, 진짜 어려움은 **naive하게 짜면 조용히 깨지는 landmine**을 아는 거였습니다. 코드를 짜기 전에 엔진의 WAL·테이블·카탈로그 구조를 먼저 지도로 그려 셋을 찾았어요.

**landmine 1 — 재오픈이 WAL을 truncate하고 LSN을 리셋한다.** `wal_open`은 열 때마다 복구를 돌리고 로그를 비우며 `next_lsn`을 1로 리셋해요([3편](/blog/project/db-hobby/db-internals-03-wal-recovery)의 "여는 것 자체가 체크포인트"). 그래서 primary를 재오픈하면 replica의 `applied_lsn`은 이미 10, 20인데 새 커밋이 lsn=1로 와서, **멱등성 필터가 신규 커밋을 조용히 전부 스킵**합니다. 테스트는 초록인데 복제가 안 되는, 가장 무서운 종류의 버그. → 대응: primary를 한 세션 내내 열어두고 살아있는 WAL을 tail한다(연속 스트리밍 모델). 참고로 실제 PostgreSQL은 LSN이 재시작을 넘어 **영구히 단조 증가**해요 — 리셋이 없으니 primary를 재시작해도 복제가 안 깨집니다. 내 엔진은 재오픈 시 LSN이 리셋되는 구조라, 켜둔 채로 유지하는 우회를 택한 거예요.

**landmine 2 — base 스냅샷은 조용한 시점에만.** 데이터 파일엔 커밋본뿐 아니라 [steal](/blog/project/db-hobby/db-internals-03-wal-recovery)된 **미커밋 페이지**도 섞일 수 있어요. 활성 writer 도중에 복사하면 미커밋 데이터가 딸려옵니다. → writer가 없는 조용한 시점에만 복사.

**landmine 3 — 카탈로그의 낡은 next_txn.** 복제된 행이 SELECT에 **보이려면** xmin이 "커밋됨"으로 판정돼야 하는데([4편의 가시성](/blog/project/db-hobby/db-internals-04-mvcc)), 그 기준인 `next_txn`이 카탈로그에 낡은 채로 복사되면 복제된 행이 **미커밋으로 보여 사라집니다.** → `next_txn`을 확정해 쓴 뒤에 복사.

### 그래서 이건 base backup + WAL 스트리밍이다

세 landmine을 정리하면 필연적으로 실제 시스템과 같은 모델에 도달해요:

1. **base 스냅샷** — 어느 시점의 데이터 파일(+카탈로그+인덱스)을 복제본으로 복사. PostgreSQL의 **pg_basebackup**.
2. **WAL 스트리밍** — 그 뒤의 커밋을 tail·재생. PostgreSQL의 **streaming replication**.

우연이 아니라 **구조가 강제**합니다. WAL은 재활용(recycle)되는 유한 로그 — 체크포인트가 지나면 오래된 세그먼트를 잘라내거나 재사용해요 — 라 그것만으론 전체 상태를 못 주고, 진짜 상태의 원천은 데이터 파일이니까 — 어느 시점의 데이터 파일을 기준으로 잡고 이후 로그를 얹는 수밖에요. 실제 DB가 base backup + WAL을 쓰는 이유를, 내 엔진에서 landmine을 밟으며 재발견한 셈입니다.

다만 한 가지는 정확히 해 둘게요 — pg_basebackup의 진짜 핵심은 오히려 **조용한 시점이 필요 없다**는 데 있습니다. 쓰기가 진행 중인 데이터 파일을 그대로(fuzzy) 복사한 뒤, 백업 시작 체크포인트 이후의 WAL을 replay해서(full-page write의 도움으로 찢어진 페이지까지) 일관된 상태로 끌어올리고, 딸려온 미커밋 데이터는 MVCC 가시성과 clog가 걸러내요. writer가 없어야만 성립하는 내 엔진의 quiescent 스냅샷은 그 직전 단계인 셈입니다.

![복제되는 DB — base 스냅샷 + 살아있는 WAL tail·재생, 복제본이 완전한 DB로 열려 SELECT를 서빙](/uploads/project/db-hobby/replicated-db.svg)

끝-대-끝 검증: 실제 엔진에서 CREATE/INSERT 커밋 → 소켓으로 WAL 스트리밍 → 복제본을 완전한 DB로 열어 `SELECT` → **primary와 행 단위로 동일.**

## 4. 정직한 경계

- **단방향, 커밋 후 전송(비동기)** — primary가 커밋을 클라이언트에 답한 뒤 replica로 가므로, primary가 그 직후 죽으면 replica엔 마지막 커밋이 없을 수 있어요. PostgreSQL도 기본은 같습니다 — 문서 표현 그대로 *"Streaming replication is asynchronous by default"*. 이 갭을 메우는 게 동기 복제인데, 켜는 스위치는 `synchronous_commit`이 아니라 **`synchronous_standby_names`** 예요. standby를 거기 등록해야 비로소 동기 복제가 되고, 그때 `synchronous_commit`은 **커밋 ack가 어느 지점까지 기다릴지의 레벨**이 됩니다: `remote_write`(standby OS 버퍼 도달) < `on`(standby WAL flush — 디스크엔 있지만 아직 **적용**은 아니라서 replica 읽기엔 안 보일 수 있음) < `remote_apply`(적용까지 — 이때야 replica에서 읽힘). quorum 지정도 돼요 — `synchronous_standby_names = 'ANY 1 (s1, s2)'`. 운영 함정 하나: 동기 standby가 전부 죽으면 primary의 커밋이 **멈춥니다** — 내구성 계약을 지킬 수 없으니까요.
- **replica 읽기의 함정** — 비동기 replica로 읽기를 분산하면 방금 쓴 데이터가 replica엔 아직 없을 수 있어요(**read-after-write 위반**). 어디까지 갔는지는 `pg_stat_replication`이 sent/write/flush/replay **4단계 LSN**으로 보여 주고, 세션 단위 보장이 필요하면 `remote_apply`를 쓰거나 replay LSN을 확인한 뒤 읽는 장치가 필요합니다.
- **failover 없음** — primary가 죽었을 때 replica를 승격하고, 클라이언트를 갈아태우고, 옛 primary가 살아 돌아왔을 때(split-brain)를 다루는 건 전혀 다른 차원의 문제입니다. 게다가 비동기 replica를 승격하면 primary가 이미 ack한 커밋이 유실될 수 있어요(RPO > 0). 그게 [10편(Raft)](/blog/project/db-hobby/db-internals-10-raft)의 주제예요 — "primary가 죽으면 누가 결정하는가"는 결국 **합의(consensus)** 문제거든요.
- **물리 복제** — 페이지 이미지를 나르는 물리(physical) 복제라, 이기종 버전·부분 테이블 복제가 안 됩니다. PostgreSQL의 logical replication이 그 다음 층.

> **흔한 오해 정정**: *"synchronous_commit=on이면 replica에서도 바로 보인다?"* — 두 겹으로 틀립니다. 첫째, `synchronous_standby_names`가 비어 있으면 `on`은 **primary 로컬 WAL flush만** 기다리고 replica는 전혀 기다리지 않아요. 둘째, 동기 복제를 켰더라도 `on`은 standby가 커밋 레코드를 *"flushed it to durable storage"* 한 시점까지만 기다립니다 — 내구성 보장이지 replay 보장이 아니라서, 직후에 replica에서 SELECT하면 아직 안 보일 수 있어요. 읽기 가시성까지 원하면 `remote_apply` — 문서 정의로 *"applied it, so that it has become visible to queries"* — 를 써야 합니다.

복제 보장을 "커밋 ack 시점에 어디까지 보장되는가(RPO)" 축으로 놓으면:

| 방식 | 커밋 ack 시점의 보장 | 유실 위험(RPO) |
|---|---|---|
| PG async (기본) | primary 로컬 WAL flush만 | 승격 시 최근 커밋 유실 가능 |
| PG sync | 레벨별 — `remote_write`(standby OS 버퍼) / `on`(standby WAL flush) / `remote_apply`(적용, 읽기 가시); quorum(`ANY n`) 가능 | `on` 이상이면 단일 장애에서 0 |
| MySQL async binlog (기본) | source의 binlog 기록만 | replica 유실 가능 |
| MySQL semi-sync | replica 1대 이상이 binlog **수신**(relay log) ack — `AFTER_SYNC`는 ack 후에 커밋을 공개, `AFTER_COMMIT`은 공개 후 ack(유실 창 존재) | `AFTER_SYNC`면 근소 |

> **실무 안티패턴**: ① replication slot을 만들어 두고 replica를 폐기하는 것 — 슬롯이 WAL을 영원히 붙잡아 primary 디스크가 찹니다(`pg_replication_slots`를 모니터링하고 안 쓰는 슬롯은 지울 것). ② 쓰기 직후의 읽기를 무조건 replica로 라우팅하는 것 — read-after-write가 깨져 "방금 저장했는데 없다"가 됩니다. 지연을 허용하는 읽기(목록·통계)부터 replica로 보내고, read-your-writes가 필요한 경로는 primary나 `remote_apply` 쪽에 남겨 두세요.

## 5. 정리

- **복제 = redo의 스트림화.** no-force WAL이 이미 커밋의 순차 스트림이라, replica는 복구의 redo를 증분·연속으로 돌릴 뿐. 새 알고리즘이 아니다.
- **정확성 규칙 둘**: 커밋 마커까지만 적용(뒤처져도 틀리지 않게), LSN 멱등성(중복 전송을 안전하게). 전송 계층은 이 위에서 마음 편히 재전송한다.
- **소켓의 교훈**: 스트림엔 경계가 없다(길이 프레이밍), 수신과 적용은 역할이 달라 fd도 다르다(실제 교착으로 배움).
- **landmine 셋** — 재오픈의 WAL truncate/LSN 리셋, base의 미커밋 오염, 낡은 next_txn. 전부 "테스트는 초록인데 조용히 깨지는" 종류로, 구조 이해가 곧 안전판이었다.
- **필연적 수렴**: base backup + WAL 스트리밍 — pg_basebackup + streaming replication의 모델에 구조가 강제로 데려간다.

> **실무/면접 포인트**: 복제는 **WAL redo의 스트림화**로 요약돼요. sync/async의 본질은 "커밋 ack가 어느 내구성 지점을 기다리는가"이고, PostgreSQL은 그걸 `synchronous_commit` 레벨(`remote_write`/`on`/`remote_apply`)로 세분화합니다 — 동기 복제여도 `remote_apply`가 아니면 replica **읽기 가시성**은 보장되지 않는다는 게 한 단계 깊은 포인트.

다음 편은 이 복제의 최대 약점 — **primary가 죽으면?** — 을 정면으로 다룹니다. 리더 선출, 로그 합의, 그리고 리더가 죽어도 살아남는 HA 구성까지, **Raft**입니다.

## 참고 (1차 자료 우선)

- [PostgreSQL Documentation: Log-Shipping Standby Servers / Streaming Replication](https://www.postgresql.org/docs/current/warm-standby.html) — replication slot 포함
- [PostgreSQL Documentation: pg_basebackup](https://www.postgresql.org/docs/current/app-pgbasebackup.html)
- [PostgreSQL Documentation: synchronous_commit (Write Ahead Log 설정)](https://www.postgresql.org/docs/current/runtime-config-wal.html#GUC-SYNCHRONOUS-COMMIT) — remote_write/on/remote_apply 레벨 정의
- [PostgreSQL Documentation: pg_stat_replication](https://www.postgresql.org/docs/current/monitoring-stats.html#MONITORING-PG-STAT-REPLICATION-VIEW) — sent/write/flush/replay LSN
- [MySQL 8.0 Reference: Replication](https://dev.mysql.com/doc/refman/8.0/en/replication.html) — binlog 기반 논리 복제와의 대조
- [MySQL 8.0 Reference: Semisynchronous Replication](https://dev.mysql.com/doc/refman/8.0/en/replication-semisync.html) — AFTER_SYNC vs AFTER_COMMIT
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

Keep tailing the primary's WAL, and whenever a committed range arrives, apply its after-images to **your own** data file — the replica trails the primary. The same structure as PostgreSQL streaming replication, where the walreceiver receives and writes the WAL and the **startup process** replays it. **Not a new algorithm — the existing redo rewritten from another angle.** Part 3's line — "with no-force, the log becomes the source of truth underpinning replication and PITR" — is cashed in here.

![WAL log-shipping replication — the replica tails and replays committed after-images, holding back the unfinished tail](/uploads/project/db-hobby/wal-replication.svg)

The apply loop has just two correctness rules:

- **Buffer until the commit marker** — never apply an unfinished tail; defer it. A replica **may lag but must never be wrong.**
- **The LSN filter** — remember each commit's LSN (`applied_lsn`) and skip commits already applied. This idempotence makes every retransmission below safe (used immediately in the next section).

## 2. Onto the Socket — walsender / walreceiver

Replace same-machine file tailing with a real network. The key decision: **don't touch the apply logic at all.** The transport layer only "moves the primary's WAL bytes into the replica's local log file," and the existing apply runs on that log. Layering pays again.

**Trap 1 — streams have no boundaries.** A socket is a byte stream with no "this chunk ends here." Frame it as `[length 8B][that many WAL bytes]`, handling partial reads/writes with `write_all`/`read_exact` loops. When the primary's checkpoint truncates the log, rewind `sent_off` to 0 and resend — **duplicate transmission, but safe**: §1's LSN filter skips already-applied commits. The transport never worries about correctness because correctness is already embedded a layer below.

But this story only holds while the log to rewind into **still exists**. That's exactly where real PostgreSQL gets bitten — if a checkpoint recycles old WAL segments while a replica is slow or briefly disconnected, the returning replica hits:

```
ERROR: requested WAL segment 0000000100000000000000XX has already been removed
```

This is the real-world face of §3's landmine 1 ("checkpoints trim the WAL"). PG's answer is the **physical replication slot** — the primary remembers how far the replica has received and preserves every WAL segment beyond that point. The flip side is precisely that preservation: a dead replica with a leftover slot makes WAL **pile up without bound until the primary's disk fills.** Hence `max_slot_wal_keep_size` capping the retention.

**Trap 2 — you can't write to a read-only fd.** We hit a real **deadlock** here. The replica opens its log `O_RDONLY` (it only reads it) — then the receiver tries writing incoming bytes to that fd and fails; the sender waits forever for an ack, the receiver forever for the next frame. The lesson mirrors real systems: **receiving (writing) and applying (reading) are different roles, so they use different fds** — the same reason PostgreSQL separates the walreceiver (writer) from the startup process (replayer).

![TCP replication — walsender ships WAL bytes in length frames; walreceiver appends to a local log; apply is the untouched replica code](/uploads/project/db-hobby/tcp-replication.svg)

## 3. The Capstone — a Real Commit, SELECTable on the Replica

So far, "WAL bytes move and replay." The real goal: **commit an `INSERT` on the actual engine, open the replica, and see the row in a `SELECT`.** The wiring code was short; the real difficulty was knowing the **landmines that break silently if coded naively.** Mapping the engine's WAL/table/catalog structure before coding surfaced three:

**Landmine 1 — reopen truncates the WAL and resets LSNs.** `wal_open` runs recovery on every open, clears the log, and resets `next_lsn` to 1 ([Part 3](/blog/project/db-hobby/db-internals-03-wal-recovery)'s "opening is itself a checkpoint"). Reopen the primary and the replica's `applied_lsn` sits at 10, 20 — while new commits arrive at lsn=1, so **the idempotence filter silently skips every new commit.** Green tests, broken replication — the scariest kind of bug. → Keep the primary open for the whole session and tail its live WAL (the continuous-streaming model). Note that real PostgreSQL's LSNs are **permanently monotonic across restarts** — no reset, so restarting the primary doesn't break replication. My engine resets LSNs on reopen, hence the keep-it-open workaround.

**Landmine 2 — base snapshots only at quiet moments.** The data file can contain [stolen](/blog/project/db-hobby/db-internals-03-wal-recovery) **uncommitted pages** alongside committed ones. Copy during an active writer and uncommitted data rides along. → Copy only when no writer is active.

**Landmine 3 — a stale catalog next_txn.** For replicated rows to be **visible**, their xmin must judge as "committed" ([Part 4's visibility](/blog/project/db-hobby/db-internals-04-mvcc)) — and the yardstick is the catalog's `next_txn`. Copy it stale and replicated rows **look uncommitted and vanish from SELECTs.** → Copy after `next_txn` is finalized and written.

### So It's Base Backup + WAL Streaming

Sort out the three landmines and you inevitably arrive at the real systems' model:

1. **Base snapshot** — copy the data files (+catalog+indexes) as of some point in time. PostgreSQL's **pg_basebackup**.
2. **WAL streaming** — tail and replay commits thereafter. PostgreSQL's **streaming replication**.

Not a coincidence — **the structure forces it.** The WAL is a finite, **recycled** log — past a checkpoint, old segments get trimmed or reused — so it alone can't convey full state; the source of committed state is the data file — so you must anchor on a point-in-time data file and layer the log on top. The reason real DBs use base backup + WAL, rediscovered by stepping on landmines in one's own engine.

One thing worth being precise about, though — pg_basebackup's real point is the opposite: it **needs no quiet moment.** It copies the data files fuzzily while writes are in flight, then replays the WAL from the backup's starting checkpoint (with full-page writes covering even torn pages) to lift the copy into a consistent state; any uncommitted data that rode along is filtered out by MVCC visibility and the clog. My engine's quiescent snapshot — valid only with no writer active — is the step just before that.

![The replicated DB — base snapshot + live WAL tail/replay; the replica opens as a full DB serving SELECTs](/uploads/project/db-hobby/replicated-db.svg)

End-to-end verification: commit CREATE/INSERT on the real engine → stream WAL over the socket → open the replica as a full DB → `SELECT` — **row-for-row identical with the primary.**

## 4. Honest Boundaries

- **One-way, send-after-commit (async)** — the primary acknowledges the commit before it reaches the replica, so a crash right after can lose the last commit on the replica. PostgreSQL's default is the same — in the docs' own words, *"Streaming replication is asynchronous by default."* The dial that closes the gap is synchronous replication, and the switch that turns it on is not `synchronous_commit` but **`synchronous_standby_names`** — only with standbys registered there does replication become synchronous, at which point `synchronous_commit` becomes **the level of how far the commit ack waits**: `remote_write` (reached the standby's OS buffers) < `on` (standby WAL flushed — on disk, but not yet **applied**, so possibly not visible to replica reads) < `remote_apply` (applied — only now readable on the replica). Quorum works too — `synchronous_standby_names = 'ANY 1 (s1, s2)'`. One operational trap: if all synchronous standbys die, commits on the primary **stall** — the durability contract can't be honored.
- **The replica-read trap** — spread reads to an async replica and data you just wrote may not be there yet (a **read-after-write violation**). `pg_stat_replication` shows how far things got as **four LSN stages** — sent/write/flush/replay — and per-session guarantees need `remote_apply` or a check-the-replay-LSN-then-read scheme.
- **No failover** — promoting a replica when the primary dies, repointing clients, and handling the old primary's return (split-brain) is a different dimension entirely. Moreover, promoting an async replica can lose commits the primary already acknowledged (RPO > 0). That's [Part 10 (Raft)](/blog/project/db-hobby/db-internals-10-raft) — "who decides, when the primary dies" is ultimately a **consensus** problem.
- **Physical replication** — page images are shipped, so cross-version or partial-table replication is out. PostgreSQL's logical replication is the next layer.

> **Common misconception, corrected**: *"With synchronous_commit=on, it's immediately visible on the replica too?"* — wrong on two counts. First, with `synchronous_standby_names` empty, `on` waits only for the **primary's local WAL flush** — no replica involved at all. Second, even with synchronous replication enabled, `on` waits only until the standby has *"flushed it to durable storage"* — a durability guarantee, not a replay guarantee, so a SELECT on the replica right after may not see it yet. For read visibility you need `remote_apply` — by the docs' definition, *"applied it, so that it has become visible to queries."*

Putting replication guarantees on the axis of "what is guaranteed at commit-ack time (RPO)":

| Scheme | Guarantee at commit ack | Loss risk (RPO) |
|---|---|---|
| PG async (default) | primary's local WAL flush only | recent commits can be lost on promotion |
| PG sync | per level — `remote_write` (standby OS buffers) / `on` (standby WAL flush) / `remote_apply` (applied, read-visible); quorum (`ANY n`) available | zero for single failures at `on` and above |
| MySQL async binlog (default) | source's binlog write only | replicas can lose data |
| MySQL semi-sync | at least one replica acks binlog **receipt** (relay log) — `AFTER_SYNC` exposes the commit after the ack; `AFTER_COMMIT` acks after exposing (loss window exists) | marginal with `AFTER_SYNC` |

> **Anti-pattern in practice**: ① creating a replication slot and then abandoning the replica — the slot pins WAL forever until the primary's disk fills (monitor `pg_replication_slots` and drop unused slots). ② routing reads-right-after-writes to a replica — read-after-write breaks and "I just saved it and it's gone." Send latency-tolerant reads (lists, stats) to replicas first, and keep read-your-writes paths on the primary or behind `remote_apply`.

## 5. Wrap-up

- **Replication = redo, streamed.** The no-force WAL is already a sequential stream of commits; the replica just runs recovery's redo incrementally. No new algorithm.
- **Two correctness rules**: apply only up to commit markers (lag, never lie), and LSN idempotence (making retransmission safe). The transport retransmits with a clear conscience on top.
- **Socket lessons**: streams have no boundaries (length framing); receiving and applying are different roles with different fds (learned via a real deadlock).
- **Three landmines** — reopen's WAL truncate/LSN reset, uncommitted contamination of the base, stale next_txn. All of the "tests green, silently broken" kind; structural understanding was the safety net.
- **Inevitable convergence**: base backup + WAL streaming — the structure marches you to pg_basebackup + streaming replication.

> **Practice/interview point**: replication compresses to **WAL redo, streamed.** The essence of sync vs async is "which durability point does the commit ack wait for," and PostgreSQL refines that into `synchronous_commit` levels (`remote_write`/`on`/`remote_apply`) — the one-level-deeper point being that even synchronous replication guarantees no replica **read visibility** unless it's `remote_apply`.

Next, this replication's greatest weakness — **what if the primary dies?** — head-on. Leader election, log consensus, and an HA configuration that survives leader death: **Raft.**

## References (primary sources first)

- [PostgreSQL Documentation: Log-Shipping Standby Servers / Streaming Replication](https://www.postgresql.org/docs/current/warm-standby.html) — including replication slots
- [PostgreSQL Documentation: pg_basebackup](https://www.postgresql.org/docs/current/app-pgbasebackup.html)
- [PostgreSQL Documentation: synchronous_commit (Write Ahead Log settings)](https://www.postgresql.org/docs/current/runtime-config-wal.html#GUC-SYNCHRONOUS-COMMIT) — remote_write/on/remote_apply level definitions
- [PostgreSQL Documentation: pg_stat_replication](https://www.postgresql.org/docs/current/monitoring-stats.html#MONITORING-PG-STAT-REPLICATION-VIEW) — sent/write/flush/replay LSNs
- [MySQL 8.0 Reference: Replication](https://dev.mysql.com/doc/refman/8.0/en/replication.html)
- [MySQL 8.0 Reference: Semisynchronous Replication](https://dev.mysql.com/doc/refman/8.0/en/replication-semisync.html) — AFTER_SYNC vs AFTER_COMMIT
- This blog: [Transaction ACID ④: Durability](/blog/theory/transaction-acid-04-durability) · [MySQL Storage Scaling](/blog/theory/mysql-storage-scaling)
- [db-hobby source (GitHub)](https://github.com/dj258255/db-hobby) — `replica.c` · `replnet.c`

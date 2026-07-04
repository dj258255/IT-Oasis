---
title: 'LSM-Tree — 제자리에서 절대 안 고치는 저장 엔진, B+Tree의 대척점'
titleEn: 'LSM-Tree — a Storage Engine That Never Updates In Place, the Counterpart to the B+Tree'
description: "db-hobby는 3편부터 B+Tree였다 — 키가 갈 페이지를 찾아가 그 페이지를 랜덤하게 읽고, 고치고, 다시 쓰는 '제자리 갱신(in-place)' 저장. 읽기엔 좋지만 쓰기는 랜덤 I/O에 페이지 분할까지라 비싸다(PostgreSQL/InnoDB 계열). 이 편은 정반대 내기를 거는 LSM-Tree를 독립 모듈로 만든다. LSM은 '제자리에서 절대 안 고친다': 모든 쓰기는 인메모리 정렬 구조(memtable)에 append되고, 임계치를 넘으면 통째로 정렬된 불변 파일(SSTable)로 순차 flush되며, 나중에 여러 SSTable을 background merge(compaction)로 정리한다. 삭제조차 제자리 삭제가 아니라 tombstone(묘비) 마커를 새로 쓴다 — 이 프로젝트의 MVCC DELETE(xmax)와 VACUUM이 했던 그 지연 삭제와 똑같은 발상이다. 대가는 읽기다: 한 키를 찾으려면 memtable→최신 SSTable→…순으로 여러 겹을 뒤진다(read amplification), 최신이 옛것을 가린다. RocksDB/LevelDB/Cassandra의 내부다. 정직한 경계: db.c 저장계층 미배선(독립 모듈), bloom filter 없음, leveled 계층화 없음."
descriptionEn: "db-hobby has been a B+Tree since Part 3 — 'in-place' storage that finds the page a key belongs to, reads it randomly, edits it, and writes it back. Great for reads, but writes are expensive: random I/O plus page splits (the PostgreSQL/InnoDB family). This part builds, as a standalone module, an LSM-Tree that makes the opposite bet. LSM 'never updates in place': every write appends to an in-memory sorted structure (memtable), which flushes wholesale as a sorted immutable file (SSTable) once it crosses a threshold, and multiple SSTables are later tidied by a background merge (compaction). Even a delete isn't in-place — it writes a tombstone marker — the same deferred-deletion idea as this project's MVCC DELETE (xmax) and VACUUM. The price is reads: finding one key searches layers, memtable→newest SSTable→…, with newer shadowing older (read amplification). This is the internals of RocksDB/LevelDB/Cassandra. Honest boundary: not wired into db.c's storage layer (standalone module), no bloom filter, no leveled tiering."
date: 2026-07-04
tags:
  - C
  - Database Internals
  - LSM-Tree
  - Storage Engine
  - RocksDB
  - Compaction
  - Learning
category: study/db-hobby
coverImage: /uploads/project/db-hobby/cover.svg
draft: false
series: "db-hobby"
seriesOrder: 27
---

## 0. 들어가며 — 저장의 반대편 철학

db-hobby는 [3편](/blog/project/db-hobby/db-hobby-3-index-wal)부터 줄곧 **B+Tree**였어요. 키가 갈 페이지를 찾아가, 그 페이지를 읽고, 고치고, 다시 씁니다 — **제자리 갱신(in-place)**. 읽기엔 최고예요(O(log n)에 한 페이지만 만지면 되니까). 하지만 쓰기는 비쌉니다: 랜덤한 위치의 페이지를 건드리고, 꽉 차면 **페이지 분할**까지 일어나죠. PostgreSQL·InnoDB가 이 계열입니다.

[23편](/blog/project/db-hobby/db-hobby-23-clustered-vs-heap)에서 "힙 vs 클러스터드"로 저장 구조를 대조했다면, 이 편은 더 근본적인 대조 — **B+Tree vs LSM-Tree**를 놓습니다. RocksDB·LevelDB·Cassandra·HBase가 사는 세계예요.

## 1. LSM의 내기 — "제자리에서 절대 안 고친다"

LSM(Log-Structured Merge)은 정반대에 겁니다:

> **어떤 쓰기도 기존 데이터를 제자리에서 고치지 않는다. 늘 새로 append한다.**

세 단계로 흐릅니다:

1. **memtable** — 모든 쓰기(put/delete)는 먼저 **인메모리 정렬 구조**에 들어간다. 디스크를 안 만진다 = 매우 빠름.
2. **flush** — memtable이 임계치를 넘으면, 통째로 **정렬된 불변 파일(SSTable)** 로 **순차** 쓰기 한 번에 내보낸다. 랜덤 I/O가 아니라 순차 append.
3. **compaction** — 시간이 지나 SSTable이 쌓이면, background로 **여러 SSTable을 merge**해 정리한다.

![LSM-Tree: 쓰기는 memtable→SSTable 순차 flush, 읽기는 최신부터 여러 겹 탐색, compaction이 merge](/uploads/project/db-hobby/lsm-tree.svg)

핵심은 쓰기가 전부 **순차**라는 것. 디스크(특히 SSD·LSM이 태어난 배경)는 랜덤 쓰기보다 순차 쓰기가 훨씬 빠르니, LSM은 쓰기 부하에서 B+Tree를 이깁니다.

## 2. 삭제도 안 고친다 — tombstone, 낯익은 발상

가장 흥미로운 지점: **삭제조차 제자리 삭제가 아닙니다.** 키를 지우려면, 옛 값을 찾아가 없애는 게 아니라 **tombstone(묘비) 마커를 새로 씁니다.** 나중에 읽을 때 tombstone을 먼저 만나면 "이 키는 삭제됨"으로 판정하고요.

이 발상, 이 시리즈에서 이미 봤어요:

- [16편 MVCC DELETE](/blog/project/db-hobby/db-hobby-16-delete-xmax): DELETE가 행을 지우지 않고 `xmax`를 찍어 **논리적으로만** 삭제.
- [17편 VACUUM](/blog/project/db-hobby/db-hobby-17-vacuum): 실제 청소는 **나중에** 몰아서.

LSM의 tombstone은 정확히 같은 **지연 삭제(deferred deletion)** 예요. "지우는 것"과 "치우는 것"을 분리하죠. 그리고 실제 청소는 compaction이 합니다 — 옛 값이 전부 사라져 tombstone이 더 이상 아무것도 가릴 게 없어지면, 그때 tombstone도 버려요. VACUUM이 죽은 버전을 청소하듯.

## 3. 대가는 읽기 — read amplification

공짜 점심은 없습니다. LSM이 쓰기를 얻은 대가는 **읽기**예요. 한 키를 찾으려면 최신 데이터가 어디 있는지 모르니, **여러 겹을 순서대로** 뒤져야 합니다:

```
lsm_get(key):
  1) memtable 확인        (가장 최신)
  2) SSTable 최신 → 오래된 순으로
  → 처음 만난 버전이 이긴다(shadow). tombstone이면 "삭제됨".
```

이걸 **read amplification**(읽기 증폭)이라 불러요 — 논리적으로 한 번의 조회가 물리적으로 여러 파일 탐색이 됩니다. "최신이 옛것을 가린다(shadow)"는 규칙이 정확성의 핵심이에요: 같은 키의 여러 버전이 여러 SSTable에 흩어져 있어도, **최신 것 하나**만 이기면 되니까.

compaction이 이 읽기 비용을 낮춰줍니다 — SSTable을 하나로 합치면 뒤질 겹이 줄어드니까. 그래서 LSM은 **쓰기(순차·빠름)와 읽기(다층·느림) 사이의 균형을 compaction 정책으로 조율**하는 엔진이에요. write amplification(compaction이 데이터를 반복해 다시 씀) vs read amplification의 삼각 트레이드오프가 LSM 튜닝의 본질입니다.

## 4. 구현과 검증

`src/lsm.c`는 이 뼈대를 순수하게 담았어요(키/값은 B+Tree처럼 `int64_t` 고정):

- **memtable**: 인메모리 정렬 배열. put은 최신 버전으로 치환/삽입, delete는 tombstone 삽입.
- **SSTable**: flush가 memtable을 정렬된 불변 파일로 쓴다. reopen 시 디스크의 `*.sst`를 발견해 read path에 편입(persistence).
- **read path**: memtable → SSTable 최신→오래된, 처음 만난 버전이 승리.
- **compaction**: 모든 SSTable을 하나로 merge, 키당 최신만 남기고 tombstone 청소, 개수 축소.
- **scan**: 정렬된 run들을 merge해 `[lo,hi]` 범위를 오름차순으로.

`test_lsm`(24 checks)이 검증합니다: 기본 put/get·없는 키 not-found · **flush 경계 넘어 최신이 옛 SSTable을 가림** · tombstone이 옛 값을 가림 · 여러 SSTable에서 전 키 정확 조회 · **compaction 후 라이브 키 정확 + 삭제 키 gone + tombstone 청소 + SSTable 개수 축소** · reopen 후 persistence · scan 오름차순·삭제 키 제외.

```
  ok   flush 경계 넘어 갱신: memtable(222)이 SSTable(111)을 가림
  ok   flush된 tombstone도 여전히 옛 SSTable 값을 가린다
  ok   compaction 후 39개 라이브 키 정확 + 삭제키 gone (tombstone 청소)
  ok   reopen 후 flush된 데이터 전부 생존(persistence)
```

## 5. 정직한 경계 — 무엇을 안 했나

[22·24편](/blog/project/db-hobby/db-hobby-24-join-order)처럼 이 LSM도 **독립 모듈**입니다. db.c의 저장 계층(힙/B+Tree) 뒤에 "또 하나의 테이블 저장 엔진"으로 꽂는 것 — MySQL의 **MyRocks**가 InnoDB 옆에 RocksDB를 꽂듯 — 이 프론티어예요. SQL 계층이 테이블마다 저장 엔진을 고르게 하려면 카탈로그·실행기 대수술이 필요하고, 그건 400개 넘는 green 테스트를 지키며 할 별도의 큰 작업입니다.

그리고 단순화한 것들:

- **Bloom filter 없음.** 진짜 LSM은 SSTable마다 "이 키가 여기 없다"를 O(1)로 답하는 bloom filter를 둬 read amplification을 크게 줄입니다. 여기선 매번 실제로 뒤져요.
- **Leveled/tiered compaction 없음.** compaction은 "전부 하나로 merge"하는 가장 단순한 형태입니다. RocksDB의 레벨별 compaction(L0/L1/…)은 없어요.
- **memtable에 WAL 없음.** flush 안 된 memtable은 close 시 버려집니다(내구성 원하면 flush 필요). 진짜 LSM은 memtable도 WAL로 보호하죠 — db-hobby 본체엔 [WAL이 있으니](/blog/project/db-hobby/db-hobby-15-noforce-checkpoint) 붙이는 건 자연스러운 다음 일.
- **단일 스레드·고정 값 타입.**

## 6. 정리

- B+Tree는 **제자리 갱신**(읽기 최적, 랜덤 쓰기), LSM은 **절대 제자리 안 고침**(쓰기 최적, 순차 append + merge).
- LSM 3단계: memtable → 임계치 flush → 불변 SSTable, 그리고 compaction merge.
- **삭제 = tombstone**은 이 프로젝트의 [MVCC DELETE](/blog/project/db-hobby/db-hobby-16-delete-xmax)·[VACUUM](/blog/project/db-hobby/db-hobby-17-vacuum) 지연 삭제와 같은 발상.
- 대가는 **read amplification** — 최신이 옛것을 가리며 여러 겹 탐색. compaction이 이를 낮춘다.
- 정직한 경계: db.c 미배선(독립 모듈), bloom filter·leveled compaction·memtable WAL은 프론티어.

<!-- EN -->

## 0. Intro — The Opposite Philosophy of Storage

db-hobby has been a **B+Tree** all the way since [Part 3](/blog/project/db-hobby/db-hobby-3-index-wal). It finds the page a key belongs to, reads it, edits it, writes it back — **in-place update**. Best for reads (O(log n), touching one page). But writes are expensive: touching pages at random locations, and **page splits** when they fill up. PostgreSQL and InnoDB are this family.

Where [Part 23](/blog/project/db-hobby/db-hobby-23-clustered-vs-heap) contrasted storage layouts as "heap vs clustered," this part draws a more fundamental contrast — **B+Tree vs LSM-Tree.** The world where RocksDB, LevelDB, Cassandra, and HBase live.

## 1. LSM's Bet — "Never Update In Place"

LSM (Log-Structured Merge) bets the opposite:

> **No write ever edits existing data in place. It always appends anew.**

It flows in three stages:

1. **memtable** — every write (put/delete) first enters an **in-memory sorted structure**. No disk touched = very fast.
2. **flush** — once the memtable crosses a threshold, it's written wholesale as a **sorted immutable file (SSTable)** in one **sequential** write. Sequential append, not random I/O.
3. **compaction** — over time, as SSTables pile up, a background **merge of multiple SSTables** tidies them.

![LSM-Tree: writes flush sequentially memtable→SSTable, reads search layers newest-first, compaction merges](/uploads/project/db-hobby/lsm-tree.svg)

The key is that all writes are **sequential**. Disks (especially SSDs, LSM's birthplace) are far faster at sequential than random writes, so LSM beats the B+Tree under write load.

## 2. Deletes Aren't In-Place Either — Tombstones, a Familiar Idea

The most interesting point: **even a delete isn't in-place.** To delete a key, instead of finding and erasing the old value, you **write a tombstone marker.** On a later read, meeting a tombstone first means "this key is deleted."

We've seen this idea in this series already:

- [Part 16 MVCC DELETE](/blog/project/db-hobby/db-hobby-16-delete-xmax): DELETE doesn't erase the row; it stamps `xmax` to delete it **only logically.**
- [Part 17 VACUUM](/blog/project/db-hobby/db-hobby-17-vacuum): the actual cleanup happens **later**, in a sweep.

LSM's tombstone is exactly the same **deferred deletion** — separating "deleting" from "cleaning." And the actual cleanup is done by compaction: once all old values are gone so the tombstone has nothing left to shadow, the tombstone itself is dropped. Just as VACUUM cleans dead versions.

## 3. The Price Is Reads — Read Amplification

No free lunch. What LSM pays for its writes is **reads.** To find one key, not knowing where the newest data is, you must search **layers in order**:

```
lsm_get(key):
  1) check memtable        (newest)
  2) SSTables newest → oldest
  → first version found wins (shadow). If a tombstone, "deleted."
```

This is **read amplification** — one logical lookup becomes several physical file searches. The "newer shadows older" rule is the heart of correctness: even with a key's many versions scattered across SSTables, only the **single newest** needs to win.

Compaction lowers this read cost — merging SSTables into one reduces the layers to search. So LSM is an engine that **tunes the balance between writes (sequential, fast) and reads (layered, slow) via its compaction policy.** The three-way trade-off of write amplification (compaction rewrites data repeatedly) vs read amplification is the essence of LSM tuning.

## 4. Implementation and Verification

`src/lsm.c` captures this skeleton purely (keys/values fixed `int64_t` like the B+Tree):

- **memtable**: an in-memory sorted array. put replaces/inserts the newest version, delete inserts a tombstone.
- **SSTable**: flush writes the memtable as a sorted immutable file. On reopen, it discovers `*.sst` on disk and folds them into the read path (persistence).
- **read path**: memtable → SSTables newest→oldest, first version found wins.
- **compaction**: merges all SSTables into one, keeps only the newest per key, cleans tombstones, shrinks the count.
- **scan**: merges sorted runs to walk `[lo,hi]` in ascending order.

`test_lsm` (24 checks) verifies: basic put/get · missing key not-found · **newer shadows an older SSTable across a flush boundary** · a tombstone shadows an old value · all keys read correctly across multiple SSTables · **after compaction: live keys correct + deleted keys gone + tombstones cleaned + SSTable count shrinks** · persistence after reopen · scan ascending, excluding deleted keys.

```
  ok   update across flush boundary: memtable(222) shadows SSTable(111)
  ok   a flushed tombstone still shadows the old SSTable value
  ok   after compaction: 39 live keys correct + deleted key gone (tombstones cleaned)
  ok   flushed data all survives after reopen (persistence)
```

## 5. The Honest Boundary — What Wasn't Done

Like [Parts 22 and 24](/blog/project/db-hobby/db-hobby-24-join-order), this LSM is a **standalone module.** Plugging it behind db.c's storage layer (heap/B+Tree) as "another table storage engine" — the way MySQL's **MyRocks** plugs RocksDB in next to InnoDB — is the frontier. Letting the SQL layer pick a storage engine per table needs major catalog/executor surgery, and doing that while keeping 400+ green tests is a separate large effort.

And the simplifications:

- **No bloom filter.** A real LSM puts a bloom filter on each SSTable to answer "this key isn't here" in O(1), sharply cutting read amplification. Here we actually search every time.
- **No leveled/tiered compaction.** Compaction is the simplest form — "merge everything into one." RocksDB's leveled compaction (L0/L1/…) isn't here.
- **No WAL for the memtable.** An unflushed memtable is discarded on close (flush for durability). A real LSM protects the memtable with a WAL too — and db-hobby's core [already has a WAL](/blog/project/db-hobby/db-hobby-15-noforce-checkpoint), so bolting it on is a natural next step.
- **Single-threaded, fixed value type.**

## 6. Wrap-up

- The B+Tree does **in-place update** (read-optimal, random writes); LSM **never updates in place** (write-optimal, sequential append + merge).
- LSM's three stages: memtable → threshold flush → immutable SSTable, plus compaction merge.
- **Delete = tombstone** is the same deferred-deletion idea as this project's [MVCC DELETE](/blog/project/db-hobby/db-hobby-16-delete-xmax) and [VACUUM](/blog/project/db-hobby/db-hobby-17-vacuum).
- The price is **read amplification** — newer shadows older across searched layers. Compaction lowers it.
- Honest boundary: not wired into db.c (standalone module); bloom filter, leveled compaction, and memtable WAL are frontiers.

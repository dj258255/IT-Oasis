---
title: 'DELETE는 지우지 않는다 — tombstone에서 xmax로, 모든 읽기 경로에 가시성 게이트'
titleEn: "DELETE Doesn't Delete — From Tombstone to xmax, and a Visibility Gate on Every Read Path"
description: "15편 끝에서 예고한 다음 편은 CLR·퍼지 체크포인트·3-패스 ARIES였다. 조사하러 갔다가 결론이 뒤집혔다 — 셋 다 지금의 db-hobby에는 '필요를 만드는 문제'가 없다. CLR이 지키는 성질(undo 도중 재크래시에도 복구가 수렴)은 페이지 전체 물리 로깅의 idempotent undo가 공짜로 주고 있었고, 크래시 주입 테스트로 그걸 증명한 뒤 트랙 E를 정직하게 닫았다. 그리고 진짜 다음 문제로 갔다: 13편 정리표에 남아 있던 X — DELETE가 아직 tombstone(물리 삭제)이라 MVCC가 반쪽이라는 것. DELETE와 UPDATE의 옛 버전이 xmax를 새기는 논리 삭제로 바꾸고, 그 대가로 힙을 읽는 아홉 갈래 경로 전부에 가시성 게이트를 다는 과정. DELETE를 ROLLBACK하면 행이 되살아나고, 대신 죽은 버전이 힙에 쌓이기 시작한다 — 다음 편 VACUUM이 필요해지는 이유까지."
descriptionEn: "Part 15 closed by promising CLR, fuzzy checkpoints, and 3-pass ARIES. Investigating them flipped the conclusion — none of the three has, in today's db-hobby, a problem that makes it necessary. The property CLR protects (recovery converging even when re-crashed mid-undo) comes free from whole-page physical logging's idempotent undo; we prove it with a crash-injection test and honestly close Track E. Then we go to the real next problem: the X left in Part 13's wrap-up table — DELETE was still a tombstone (physical removal), leaving MVCC half-done. We convert DELETE (and UPDATE's old version) to logical deletion by stamping xmax, and pay the price: a visibility gate on all nine paths that read the heap. Roll back a DELETE and the row comes back to life — and in exchange, dead versions start piling up in the heap, which is exactly why the next part needs VACUUM."
date: 2026-07-03
tags:
  - C
  - Database Internals
  - MVCC
  - Transaction
  - Recovery
  - PostgreSQL
  - Learning
category: study/db-hobby
coverImage: /uploads/project/db-hobby/cover.svg
draft: false
series: "db-hobby"
seriesOrder: 16
---

## 0. 들어가며 — 예고를 깨는 이유

[15편](/blog/project/db-hobby/db-hobby-15-noforce-checkpoint) 끝에서 다음 편을 예고했었어요 — CLR, 퍼지 체크포인트, 3-패스 ARIES로 트랙 E(복구)를 마무리하겠다고. 그 셋을 구현하려고 조사하다가, 결론이 뒤집혔습니다. **셋 다 지금의 db-hobby에는 "필요를 만드는 문제"가 없어요.**

15편에서 pageLSN을 뺄 때 세운 원칙이 있었죠 — *모든 장치는 자기를 필요하게 만든 문제와 함께 등장한다. 필요 없는 기계를 모양만 이식하는 건 화물숭배다.* 그 원칙을 지키려면 예고를 깨야 했습니다. 이번 편은 그래서 두 부분이에요: ① 트랙 E를 **증명과 함께 정직하게 닫고**, ② 진짜 다음 문제 — [13편](/blog/project/db-hobby/db-hobby-13-mvcc) 정리표에 남아 있던 X, "**DELETE를 xmax가 주도: X (지금은 tombstone)**" — 를 풉니다.

## 1. 트랙 E 매듭 — 세 장치와, 그것을 부르는 전제

교과서 ARIES의 남은 세 장치를 하나씩 조사했어요. 각각 "무엇을 지키는가"와 "무엇이 그걸 필요하게 만드는가"를 분리해서요.

| 장치 | 지키는 것 | 필요하게 만드는 전제 | db-hobby에 그 전제가? |
|---|---|---|---|
| **CLR** (보상 로그) | undo 도중 재크래시해도 복구가 수렴 | undo가 **비-idempotent** (physiological 로깅) | 없음 — before-image 덮어쓰기는 idempotent |
| **퍼지 체크포인트** | 운영을 멈추지 않고 체크포인트 | **동시 운영** (멈출 수 없음) | 없음 — 단일 스레드, 커밋 끝 조용한 순간이 공짜 |
| **3-패스 Analysis** | 여러 loser를 로그에서 가려냄 | **다중 동시 트랜잭션** (loser가 흩어짐) | 없음 — 트랜잭션이 하나라 loser는 항상 로그 꼬리 |

핵심은 CLR이에요. CLR이 지키는 성질 — "undo를 하다가 또 크래시해도, 다음 복구가 정확한 상태로 수렴한다" — 는 진짜로 중요합니다. 그래서 **그 성질 자체를 테스트로 증명**했어요. 복구의 undo가 before-image를 딱 하나만 적용하고 죽도록 크래시를 주입하고(`wal_test_crash_in_undo`), 반쯤 되돌린 위험한 상태에서 다시 열었습니다.

```
ok   1차 복구(중단됨): 페이지1은 되돌아감
ok   1차 복구(중단됨): 페이지2는 아직 미커밋 값 (반쯤 undo)
ok   2차 복구: 페이지1 정확 (idempotent 재적용)
ok   2차 복구: 페이지2도 복원 — CLR 없이 수렴
```

두 번째 복구가 같은 undo를 **처음부터 다시** 돌려도 정확히 수렴합니다. before-image 덮어쓰기는 몇 번을 해도 같으니까요(idempotent). CLR이 지키려는 성질을, 페이지 전체 물리 로깅이 공짜로 주고 있었던 거예요 — pageLSN 때와 정확히 같은 구조의 결론입니다. 퍼지 체크포인트는 트랙 D(멀티스레드)가, Analysis 패스는 다중 트랜잭션이 올 때 "필요해서" 들어올 겁니다. **트랙 E는 이 엔진 기준으로 완성입니다.**

> **이 절의 교훈**: "교과서에 있으니 넣는다"와 "교과서가 그걸 넣은 이유가 우리에게도 있는가"는 다른 질문입니다. 후자를 물어야 자기 시스템의 단순화가 **무엇을 공짜로 주고 있는지**가 보여요. db-hobby의 페이지 물리 로깅은 로그 크기를 대가로 pageLSN과 CLR 둘을 면제받고 있었습니다.

## 2. 진짜 다음 문제 — DELETE가 MVCC를 반쪽으로 만든다

[13편](/blog/project/db-hobby/db-hobby-13-mvcc) 정리표를 다시 보면, O 사이에 X가 하나 박혀 있었어요.

> | DELETE를 xmax가 주도 | **X** | 지금은 tombstone(코어 모델 충돌) |

INSERT와 UPDATE는 버전(xmin)을 다는데, DELETE만 **슬롯을 물리적으로 지웠습니다**(tombstone). 이게 왜 문제냐면:

1. **MVCC 롤백이 반쪽** — INSERT 롤백은 "xmin 무효 → 안 보임"으로 우아하게 되는데, DELETE 롤백은 페이지 이미지를 통째로 되돌리는 물리 복원에만 기대요. 13편의 standalone 데모(`mvcc.c`)에선 "DELETE를 abort하면 행이 되살아난다"가 됐지만, **엔진의 SQL에선 그 우아함이 없었습니다.**
2. **읽기 경로가 MVCC를 모른다** — tombstone 세계에선 "지워진 행 = 물리적으로 없는 행"이라 `heap_get`이 알아서 걸러 줬어요. 그래서 13편에서 가시성 게이트를 **풀스캔 경로 하나에만** 달고도 무사했죠. 인덱스 조회·조인·집계는 전부 "지워진 건 어차피 없다"는 가정 위에 서 있었습니다.
3. **다음 산의 관문** — 진짜 동시 MVCC(reader가 writer의 DELETE를 못 보면서 옛 버전을 읽는 것)도, VACUUM(죽은 버전 청소)도, DELETE가 버전으로 남아 있어야 시작됩니다.

즉 DELETE를 xmax로 바꾸는 순간, **힙을 읽는 모든 경로가 가시성을 알아야** 해요. 전환과 게이트 통일은 한 몸입니다.

## 3. 구현 1 — 지우지 말고 도장을 찍어라

행 헤더는 [13편](/blog/project/db-hobby/db-hobby-13-mvcc)에서 이미 `[xmin(4B)][xmax(4B)]`로 깔아 뒀으니, DELETE는 이제 슬롯을 지우는 대신 **xmax 4바이트만 제자리에서 덮어쓰면** 됩니다. 길이가 안 변하니 슬롯 페이지의 이웃을 침범할 일도 없어요.

```c
/* DELETE/UPDATE의 옛 버전 처리: 행을 지우지 않고 xmax만 새긴다(PostgreSQL식 논리 삭제). */
static int stamp_xmax(Table *t, RID rid, int32_t xmax) {
    uint8_t rec[PAGE_SIZE];
    uint16_t len;
    if (heap_get(&t->heap, rid, rec, &len) != 0) return -1;
    memcpy(rec + 4, &xmax, 4); /* MVCC 헤더 = [xmin(4)][xmax(4)] */
    return heap_overwrite(&t->heap, rid, rec, len); /* 같은 길이 제자리 덮어쓰기 */
}
```

```c
/* exec_delete — heap_delete(슬롯 제거)가 stamp_xmax(도장)로 바뀌었다 */
for (int i = 0; i < ctx.count; i++) {
    stamp_xmax(t, ctx.rids[i], db->cur_txn);
}
```

UPDATE도 같은 결로 완성됩니다 — 옛 버전에 `stamp_xmax`, 새 버전을 새 RID로 삽입. PostgreSQL이 UPDATE를 다루는 방식 그대로예요([13편 2절](/blog/project/db-hobby/db-hobby-13-mvcc)의 표가 이제 코드로 참이 됐습니다). 버퍼 풀·WAL은 건드릴 게 없었어요 — 헤더 덮어쓰기도 결국 페이지 dirty라, 14·15편이 만든 steal/undo/no-force 기계가 그대로 지켜 줍니다.

## 4. 구현 2 — 아홉 갈래 길, 하나의 게이트

이제 대가를 치를 차례. "지워진 행이 물리적으로 존재"하게 됐으니, 힙을 읽는 **모든** 경로가 버전을 걸러야 합니다. 게이트는 한 줄이에요.

```c
/* 힙을 읽는 '모든' 경로가 이 게이트를 지난다 */
static int rec_visible(Database *db, const void *rec) {
    return row_visible(db, db_rec_xmin(rec), db_rec_xmax(rec), db->cur_txn);
}
```

문제는 이 한 줄을 **어디에 다 달아야 하는지**였습니다. 힙을 읽는 길을 전부 세어 보니 아홉 갈래였어요.

| 읽기 경로 | 게이트 전 (tombstone 시절) | 게이트 |
|---|---|---|
| 풀스캔 (`select_visit`) | 13편에서 이미 게이트 | (기존) |
| PK 점 조회 (`WHERE id = n`) | `heap_get` 실패에 의존 | 추가 |
| PK 범위 스캔 (`WHERE id > n`) | 〃 | 추가 |
| 보조 인덱스 스캔 | 〃 | 추가 |
| 조인 — 풀스캔 (중첩 루프) | 없음 | 추가 |
| 조인 — 해시 빌드 | 없음 (빌드 때 걸러야 탐사가 안전) | 추가 |
| 조인 — 인덱스 NLJ | `heap_get` 실패에 의존 | 추가 |
| 집계/정렬 (materialize) · 서브쿼리 | 없음 | 추가 |
| DML 수집 (DELETE/UPDATE 대상) · CREATE INDEX 빌드 | 없음 | 추가 |

여기서 인덱스에 관한 관찰 하나가 중요해요. **인덱스는 MVCC를 모릅니다.** B+Tree는 (키 → RID)만 알지, 그 RID의 행이 어느 트랜잭션에 보이는지 몰라요. 그래서 모든 인덱스 경로가 "인덱스로 후보를 찾고 → 힙에서 행을 읽고 → **게이트로 판정**"하는 2단 구조가 됩니다. PostgreSQL의 인덱스 스캔이 힙에 들러 가시성을 확인하는 것(그리고 그걸 아끼려고 visibility map을 두는 것)과 같은 이유예요.

DML 수집 게이트는 정확성에도 필수입니다 — 이미 지워진(xmax) 행을 DELETE가 또 지우거나 UPDATE가 되살리면 안 되니까요. 그리고 재밌는 소득: **B+Tree 삭제가 없다는 기존 한계가 더 자연스러워졌어요.** 지워진 행의 stale 인덱스 항목은 이제 "사라진 슬롯"이 아니라 "안 보이는 버전"으로, 같은 게이트가 일관되게 거릅니다.

## 5. 얻은 것 — DELETE 롤백이 되살아난다

이 전환의 우아함이 드러나는 순간이 롤백이에요. `test_mvcc_dml`(신설, 18 시나리오)에서:

```
ok   트랜잭션 안: 내가 지운 행은 나에게도 안 보임
ok   ROLLBACK -> 지운 행이 되살아남 (MVCC 롤백)
ok   UPDATE 롤백 -> 옛 값으로 복귀
ok   재삽입한 PK: 새 행만 보임
ok   재오픈 후에도 커밋된 DELETE는 안 보임
```

DELETE를 ROLLBACK하면 행이 **되살아납니다** — xmax를 찍은 트랜잭션이 아보트됐으니 가시성 규칙이 그 도장을 무효로 치는 거예요. 13편에서 standalone으로만 보여줬던 "abort 한 번에 DELETE가 롤백된다"가 이제 엔진의 SQL에서 그대로 성립합니다. 재오픈 후에도 커밋된 DELETE가 숨는 건 13편의 `committed_below` 트릭이 xmax에도 똑같이 적용되기 때문이고요.

전체 스위트는 **363개 테스트 / 22스위트 green** — 기존 338개가 한 줄도 안 깨진 채로요. DELETE의 물리적 의미가 완전히 바뀌었는데 겉보기 동작이 그대로라는 건, tombstone 시절의 모든 가정이 게이트로 정확히 대체됐다는 뜻입니다.

## 6. 새로 생긴 문제 — 일부러 만든 쓰레기

14편에서 steal이 "디스크에 미커밋이 샌다"는 새 문제를 데려왔듯, 이번 전환도 새 문제를 **일부러** 만듭니다. 지워진 행이 이제 **영원히 힙에 남아요.**

```
ok   힙엔 여전히 3행이 물리적으로 있다 (xmax 논리 삭제)
ok   UPDATE가 버전을 하나 더 쌓음 (옛 버전은 힙에 남음)
ok   재오픈 후에도 죽은 버전들이 힙에 남아 있다 (VACUUM 전)
```

DELETE 한 번마다 죽은 버전 하나, UPDATE 한 번마다 죽은 버전 하나. 테이블 파일은 줄어들 줄 모르고 자라기만 합니다 — **bloat**. 스캔은 죽은 버전을 읽고 게이트에서 버리니 갈수록 느려지고요. PostgreSQL이 정확히 이 문제를 안고 살고, 그래서 **VACUUM**(과 autovacuum)이 있는 겁니다.

> **실무/면접 포인트**: "PostgreSQL에서 DELETE를 많이 했는데 디스크가 안 줄어요"는 버그가 아니라 MVCC의 설계 그 자체입니다. DELETE는 xmax 도장이고, 공간 회수는 VACUUM의 일이에요(그마저도 파일 끝 축소는 조건부고, 보통은 재사용 가능 공간으로 표시). `n_dead_tup`, autovacuum 튜닝, HOT update가 전부 이 한 문장 — "지우는 것과 치우는 것은 다른 작업이다" — 에서 나옵니다.

db-hobby도 이제 그 문제를 정면으로 갖게 됐어요. 죽은 버전(안 보이는 옛 버전)의 힙 공간을 회수하고, 죽은 인덱스 항목을 지우는(= 드디어 **B+Tree 삭제**가 필요해지는) 일 — **VACUUM이 다음 편의 장애 서사입니다.** "장치는 필요와 함께 등장한다"의 원칙대로, 이번 편이 그 필요를 만들었어요.

![DELETE의 두 방식 — tombstone(슬롯 제거)은 물리 삭제라 읽기 경로가 MVCC를 몰라도 됐지만, xmax(논리 삭제)는 행이 남으므로 힙을 읽는 아홉 갈래 경로 전부가 하나의 가시성 게이트(rec_visible)를 지나야 한다. 대가는 죽은 버전의 누적(VACUUM의 동기)](/uploads/project/db-hobby/mvcc-xmax-gate.svg)

## 7. 정리 — 그리고 다음 편

13편 정리표의 그 X가 O가 됐습니다.

| 항목 | 13편 | 이번 편 |
|---|---|---|
| 가시성 규칙 · 행 버전 헤더 · abort 롤백(개념) | O | O |
| SELECT가 가시성으로 거름 | 풀스캔만 | **아홉 갈래 전부** |
| DELETE를 xmax가 주도 | **X** (tombstone) | **O** (논리 삭제, 롤백 시 부활) |
| UPDATE 옛 버전 | tombstone | **xmax** (PG식 버전 사슬) |
| 죽은 버전 청소 (VACUUM) | — | **X** ← 다음 편 |
| reader가 writer를 안 막는 동시성 | X | X (A1-3, 그 다음) |
| 트랙 E (steal·undo·no-force·복구) | 진행 중 | **매듭** (CLR·퍼지·3-패스는 전제와 함께 올 것) |

이번 편은 두 가지를 했어요. 예고했던 트랙 E의 나머지를 **"필요 없음을 증명하고" 닫았고**, 그 대신 13편이 남긴 진짜 숙제 — DELETE의 MVCC화 — 를 풀었습니다. 그리고 그 해법이 다음 문제(bloat → VACUUM)를 낳는 것까지, 이 시리즈가 지키려는 서사 그대로예요.

## 참고

- [PostgreSQL Documentation: Routine Vacuuming (dead tuples, bloat)](https://www.postgresql.org/docs/current/routine-vacuuming.html)
- [The Internals of PostgreSQL: Concurrency Control — DELETE and xmax](https://www.interdb.jp/pg/pgsql05.html)
- [ARIES: A Transaction Recovery Method (Mohan et al., 1992) — CLR·Analysis 패스의 원전](https://cs.stanford.edu/people/chrismre/cs345/rl/aries.pdf)
- 본 시리즈: [13편 MVCC](/blog/project/db-hobby/db-hobby-13-mvcc) · [14편 steal+undo](/blog/project/db-hobby/db-hobby-14-steal-undo) · [15편 no-force](/blog/project/db-hobby/db-hobby-15-noforce-checkpoint)

<!-- EN -->

## 0. Introduction — Why We're Breaking a Promise

[Part 15](/blog/project/db-hobby/db-hobby-15-noforce-checkpoint) ended with a preview: CLR, the fuzzy checkpoint, and 3-pass ARIES would finish Track E (recovery). While investigating them for implementation, the conclusion flipped. **None of the three has, in today's db-hobby, a problem that makes it necessary.**

Part 15 set a principle when it dropped pageLSN — *every mechanism arrives together with the problem that made it necessary; transplanting machinery you don't need, for the shape of it, is cargo cult.* Keeping that principle meant breaking the promise. So this part has two halves: ① close Track E **honestly, with proof**, and ② solve the real next problem — the X left in [Part 13](/blog/project/db-hobby/db-hobby-13-mvcc)'s wrap-up table: "**DELETE governed by xmax: X (still a tombstone)**".

## 1. Closing Track E — Three Mechanisms and Their Preconditions

I examined each remaining ARIES mechanism, separating "what it protects" from "what makes it necessary."

| Mechanism | What it protects | Precondition that demands it | Does db-hobby have it? |
|---|---|---|---|
| **CLR** (compensation log) | recovery converges even when re-crashed mid-undo | **non-idempotent** undo (physiological logging) | No — overwriting a before-image is idempotent |
| **Fuzzy checkpoint** | checkpointing without stopping the world | **concurrent operation** (can't stop) | No — single-threaded; the quiet moment at commit-end is free |
| **3-pass Analysis** | identifying multiple losers in the log | **multiple concurrent transactions** (losers scattered) | No — one transaction, so the loser is always the log's tail |

CLR is the crux. The property it protects — "crash again during undo, and the next recovery still converges" — genuinely matters. So we **proved the property itself with a test**: inject a crash so recovery's undo applies exactly one before-image and dies (`wal_test_crash_in_undo`), then reopen from that dangerous half-undone state.

```
ok   1st recovery (interrupted): page 1 restored
ok   1st recovery (interrupted): page 2 still uncommitted (half-undone)
ok   2nd recovery: page 1 exact (idempotent reapply)
ok   2nd recovery: page 2 restored too — convergence without CLR
```

The second recovery replays the same undo **from the beginning** and converges exactly, because overwriting a before-image gives the same result no matter how many times you do it. The property CLR protects was already free — courtesy of whole-page physical logging, the same structural conclusion as pageLSN. The fuzzy checkpoint will enter when Track D (multithreading) does; the Analysis pass when multiple transactions do. **Track E is complete for this engine.**

> **The lesson of this section**: "the textbook has it, so add it" and "does the textbook's reason for it apply to us?" are different questions. Only the latter shows you what your system's simplifications are giving you **for free**. db-hobby's whole-page logging pays in log size and is exempted from both pageLSN and CLR.

## 2. The Real Next Problem — DELETE Leaves MVCC Half-Done

Look at [Part 13](/blog/project/db-hobby/db-hobby-13-mvcc)'s wrap-up table again — one X sitting among the O's.

> | DELETE governed by xmax | **X** | still a tombstone (collides with core model) |

INSERT and UPDATE carry versions (xmin), but DELETE **physically erased the slot** (tombstone). Why that's a problem:

1. **Rollback is half-MVCC** — an INSERT rollback works elegantly ("xmin invalid → invisible"), but a DELETE rollback relied entirely on physically restoring page images. Part 13's standalone demo (`mvcc.c`) showed "abort a DELETE and the row comes back", but **the engine's SQL never had that elegance.**
2. **Read paths don't know MVCC** — in the tombstone world, "deleted row = physically absent row", so `heap_get` filtered for free. That's why Part 13 got away with a visibility gate on **only the full-scan path**. Index lookups, joins, aggregates all stood on the assumption "the deleted are simply gone."
3. **It gates the next mountains** — true concurrent MVCC (a reader seeing the old version while a writer deletes) and VACUUM (cleaning dead versions) both require DELETE to leave a version behind.

So the moment DELETE becomes xmax, **every path that reads the heap must understand visibility.** The conversion and the gate unification are one move.

## 3. Implementation 1 — Stamp, Don't Erase

The row header has carried `[xmin(4B)][xmax(4B)]` since [Part 13](/blog/project/db-hobby/db-hobby-13-mvcc), so DELETE now just **overwrites 4 bytes in place** instead of erasing the slot. The length doesn't change, so no neighbor in the slotted page is at risk.

```c
/* Old-version handling for DELETE/UPDATE: stamp xmax instead of erasing (PostgreSQL-style). */
static int stamp_xmax(Table *t, RID rid, int32_t xmax) {
    uint8_t rec[PAGE_SIZE];
    uint16_t len;
    if (heap_get(&t->heap, rid, rec, &len) != 0) return -1;
    memcpy(rec + 4, &xmax, 4); /* MVCC header = [xmin(4)][xmax(4)] */
    return heap_overwrite(&t->heap, rid, rec, len); /* same-length in-place overwrite */
}
```

```c
/* exec_delete — heap_delete (slot removal) became stamp_xmax (a stamp) */
for (int i = 0; i < ctx.count; i++) {
    stamp_xmax(t, ctx.rids[i], db->cur_txn);
}
```

UPDATE completes the same way — `stamp_xmax` on the old version, insert the new version at a new RID. Exactly how PostgreSQL handles UPDATE ([Part 13 §2](/blog/project/db-hobby/db-hobby-13-mvcc)'s table is now true in code). Buffer pool and WAL needed nothing: a header overwrite is just a dirty page, so the steal/undo/no-force machinery from Parts 14–15 protects it as-is.

## 4. Implementation 2 — Nine Roads, One Gate

Now the price. Deleted rows **physically exist**, so **every** heap-reading path must filter versions. The gate is one line:

```c
/* EVERY path that reads the heap passes through this gate */
static int rec_visible(Database *db, const void *rec) {
    return row_visible(db, db_rec_xmin(rec), db_rec_xmax(rec), db->cur_txn);
}
```

The work was finding **everywhere it belongs**. Counting the roads into the heap: nine.

| Read path | Before (tombstone era) | Gate |
|---|---|---|
| Full scan (`select_visit`) | gated since Part 13 | (existing) |
| PK point lookup (`WHERE id = n`) | relied on `heap_get` failing | added |
| PK range scan (`WHERE id > n`) | 〃 | added |
| Secondary index scan | 〃 | added |
| Join — full scan (nested loop) | none | added |
| Join — hash build | none (filter at build so probes stay safe) | added |
| Join — index NLJ | relied on `heap_get` failing | added |
| Aggregate/sort (materialize) · subquery | none | added |
| DML collection (DELETE/UPDATE targets) · CREATE INDEX build | none | added |

One observation about indexes matters here: **indexes don't know MVCC.** A B+Tree knows (key → RID), not which transactions can see that RID's row. So every index path becomes two-step: find candidates by index → read the row from the heap → **judge with the gate**. Same reason PostgreSQL's index scans visit the heap for visibility (and keep a visibility map to skip it when possible).

The DML-collection gate is also a correctness requirement — DELETE must not re-delete an already-xmax'd row, and UPDATE must not resurrect one. And a pleasant side effect: **the old "no B+Tree deletion" limitation got more principled.** A deleted row's stale index entry is now filtered as "an invisible version" by the same gate, not as "a vanished slot."

## 5. What We Gained — a Rolled-Back DELETE Comes Back to Life

The elegance shows at rollback. From the new `test_mvcc_dml` (18 scenarios):

```
ok   inside txn: the row I deleted is invisible to me too
ok   ROLLBACK -> the deleted row comes back to life (MVCC rollback)
ok   UPDATE rollback -> old value returns
ok   re-inserted PK: only the new row is visible
ok   after reopen, a committed DELETE stays hidden
```

Roll back a DELETE and the row **comes back** — the transaction that stamped xmax aborted, so the visibility rule voids the stamp. What Part 13 could only show standalone ("one abort rolls back a DELETE") now holds in the engine's SQL. Committed DELETEs stay hidden across reopen because Part 13's `committed_below` trick applies to xmax identically.

The full suite is **363 tests / 22 suites green** — with the original 338 untouched. DELETE's physical meaning changed completely while observable behavior didn't: every tombstone-era assumption was replaced exactly by the gate.

## 6. The New Problem — Garbage We Made on Purpose

Just as Part 14's steal brought a new problem ("uncommitted data leaks to disk"), this conversion **deliberately** creates one: deleted rows now stay in the heap **forever.**

```
ok   the heap still physically holds 3 rows (xmax logical delete)
ok   UPDATE stacks one more version (old version stays in the heap)
ok   dead versions remain in the heap after reopen (pre-VACUUM)
```

Every DELETE leaves a dead version; every UPDATE leaves another. The table file only grows — **bloat** — and scans keep reading dead versions just to discard them at the gate. PostgreSQL lives with exactly this, which is why **VACUUM** (and autovacuum) exists.

> **Practical/interview note**: "I deleted a lot in PostgreSQL but disk didn't shrink" is not a bug — it's MVCC by design. DELETE is an xmax stamp; reclaiming space is VACUUM's job (and even then, file truncation is conditional — space is usually just marked reusable). `n_dead_tup`, autovacuum tuning, and HOT updates all follow from one sentence: "deleting and cleaning are different jobs."

db-hobby now owns that problem squarely. Reclaiming dead versions' heap space and removing dead index entries (finally making **B+Tree deletion** necessary) — **VACUUM is the next part's failure narrative.** True to the principle, this part manufactured the need.

![Two ways to DELETE — a tombstone (slot removal) is physical, so read paths could ignore MVCC; an xmax stamp (logical delete) leaves the row, so all nine heap-reading paths must pass one visibility gate (rec_visible). The price: dead versions accumulate — the motivation for VACUUM](/uploads/project/db-hobby/mvcc-xmax-gate.svg)

## 7. Wrap-up — and What's Next

That X in Part 13's table is now an O.

| Item | Part 13 | This part |
|---|---|---|
| Visibility rule · row version header · abort rollback (concept) | O | O |
| SELECT filters by visibility | full scan only | **all nine roads** |
| DELETE governed by xmax | **X** (tombstone) | **O** (logical delete; resurrects on rollback) |
| UPDATE's old version | tombstone | **xmax** (PG-style version chain) |
| Cleaning dead versions (VACUUM) | — | **X** ← next part |
| Reads-don't-block-writes concurrency | X | X (A1-3, after that) |
| Track E (steal·undo·no-force·recovery) | in progress | **closed** (CLR/fuzzy/3-pass will come with their preconditions) |

This part did two things: closed the promised remainder of Track E by **proving it unnecessary**, and solved the real homework Part 13 left — making DELETE MVCC-native. And that solution breeds the next problem (bloat → VACUUM), exactly the narrative this series tries to keep.

## References

- [PostgreSQL Documentation: Routine Vacuuming (dead tuples, bloat)](https://www.postgresql.org/docs/current/routine-vacuuming.html)
- [The Internals of PostgreSQL: Concurrency Control — DELETE and xmax](https://www.interdb.jp/pg/pgsql05.html)
- [ARIES: A Transaction Recovery Method (Mohan et al., 1992) — the origin of CLR and the Analysis pass](https://cs.stanford.edu/people/chrismre/cs345/rl/aries.pdf)
- This series: [Part 13 MVCC](/blog/project/db-hobby/db-hobby-13-mvcc) · [Part 14 Steal+Undo](/blog/project/db-hobby/db-hobby-14-steal-undo) · [Part 15 No-Force](/blog/project/db-hobby/db-hobby-15-noforce-checkpoint)

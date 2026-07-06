---
title: 'DB 내부 ③: WAL과 크래시 복구 — redo-only에서 steal + no-force까지'
titleEn: 'DB Internals ③: WAL and Crash Recovery — From redo-only to steal + no-force'
description: "쓰다가 전원이 꺼지면 어떻게 되는가. WAL 프로토콜의 본질(데이터보다 로그 먼저, fsync 한 번이 내구성의 분기점)에서 시작해, 복구 규칙이 'redo 아니면 discard' 하나로 끝나는 가장 단순한 형태를 짓고 — 그 단순함의 대가(버퍼 풀보다 큰 트랜잭션이 죽는다)에 부딪혀 steal을 켜고(before-image·undo의 필연), 마지막으로 no-force(커밋 = 로그 fsync 하나)로 옮겨 로그가 진실의 원천이 되기까지. STEAL/FORCE 사분면이 어떤 복구 로직을 필수로 만드는지, 진짜 ARIES(physiological 로깅·pageLSN·CLR·3-패스)와의 거리는 어디인지, fsync의 가격(같은 5천 행 적재가 23배 차이)은 얼마인지 — 크래시를 실제로 주입한 테스트와 실측으로 확인하며 정리해요."
descriptionEn: "What happens when the power dies mid-write? Starting from the essence of the WAL protocol (log before data; one fsync is the durability watershed), we build the simplest form whose recovery rule is just 'redo or discard' — then hit the price of that simplicity (transactions larger than the buffer pool die), turn on steal (before-images; undo becomes inevitable), and finally move to no-force (commit = one log fsync), where the log becomes the source of truth. Which recovery logic each STEAL/FORCE quadrant makes mandatory, how far this is from real ARIES (physiological logging, pageLSN, CLR, 3-pass), and the price of fsync (the same 5,000-row load differing by 23×) — verified with crash-injection tests and measurements."
date: 2026-03-05T00:00:00.000Z
tags:
  - Database Internals
  - WAL
  - Crash Recovery
  - ARIES
  - PostgreSQL
  - InnoDB
  - C
category: study/db-hobby
coverImage: /uploads/project/db-hobby/cover.svg
draft: false
series: "미니 DB로 이해하는 DB 내부"
seriesOrder: 3
---

## 0. 들어가며 — 쓰다가 전원이 꺼지면

[2편](/blog/project/db-hobby/db-internals-02-btree-index)까지로 "빠르게"는 얻었어요. 이번엔 정반대 정체성 — **안 깨지게**(내구성 Durability, 원자성 Atomicity)입니다.

문제는 이렇습니다. 한 트랜잭션이 여러 페이지를 고치는데, 데이터 파일에 하나씩 쓰는 도중 전원이 꺼지면? 일부 페이지만 반영되고 일부는 안 돼 트랜잭션이 **반쪽만 남아요(partial update).** 게다가 디스크 쓰기는 `write()` 했다고 끝이 아닙니다 — OS 페이지 캐시에 머물 수 있어서, `fsync()`로 강제로 내려야 진짜 디스크에 닿아요.

이 편은 그 문제를 세 단계로 풉니다. 가장 단순한 WAL(redo-only)을 짓고 → 그 단순함의 **대가**에 부딪혀 steal을 켜고 → 마지막으로 no-force로 옮겨 **로그가 진실의 원천**이 되기까지. 각 단계에서 "어떤 버퍼 정책이 어떤 복구 로직을 필수로 만드는가"라는 프레임이 반복돼요 — [트랜잭션 ACID ①(Atomicity)](/blog/theory/transaction-acid-01-atomicity)에서 이론으로 정리한 그 틀을, 여기선 구현하며 하나씩 밟습니다.

## 1. WAL 프로토콜 — 데이터보다 로그를 먼저

**WAL(Write-Ahead Log)** 의 아이디어는 단순해요. 데이터 파일을 고치기 **전에**, 바뀔 내용을 **로그에 먼저 순차로 적고 fsync**합니다.

> **핵심 정의**: WAL은 "데이터 파일을 고치기 전에 그 변경을 로그에 먼저 적고 fsync한다"는 프로토콜이다. 데이터 파일은 흩어진 페이지에 **무작위 쓰기**지만 로그는 끝에 이어 붙이는 **순차 쓰기**라 빠르고, 한 번의 fsync로 트랜잭션 전체를 원자적으로 "확정"할 수 있다. (db-hobby는 단순함을 위해 바뀐 페이지 **전체**를 적는 physical page logging이다. PostgreSQL은 보통 변경 *내용*만 적는 WAL 레코드를 쓰되, full-page image라는 예외를 둔다 — `full_page_writes`가 켜져 있으면 공식 문서 표현 그대로 *"writes the entire content of each disk page to WAL during the first modification of that page after a checkpoint"*, 즉 체크포인트 후 그 페이지의 **첫 수정 때만** 페이지 전체를 WAL에 적는다. 반쯤 쓰인 페이지 위에서도 redo를 시작할 발판을 만들기 위해서다. InnoDB는 redo 로그에 FPI를 쓰지 않는다 — torn page 방어는 **doublewrite buffer**라는 별도 장치의 몫이다.)

![WAL 흐름 — stage → 로그+커밋마커 fsync(내구성 분기점) → 데이터 적용 → 로그 비움](/uploads/project/db-hobby/wal-flow.svg)

```c
int wal_commit(Wal *w) {
    /* 1) 바뀐 페이지들을 로그에 쓴다 (write-ahead) */
    /* 2) 커밋 마커 + fsync — 이 줄을 지나면 "내구"하다 */
    write_all(w->log_fd, &commit_marker, 1);
    fsync(w->log_fd);                          /* ← 내구성 분기점 */
    /* 3) 데이터 파일에 실제로 적용 */
    /* 4) 로그 비움 */
}
```

**커밋 마커 + fsync 한 줄이 내구성의 분기점**이에요. 그 줄을 지나야 "이 트랜잭션은 살아남는다"가 보장됩니다. 그리고 복구 규칙은 놀랍도록 단순해요:

> **복구 규칙(1단계)**: 로그에 커밋 마커가 **있으면 redo**(데이터에 재적용), **없으면 discard**(버림). 그게 전부.

이걸 증명하려고 테스트에서 **정확히 두 위험한 순간에 크래시를 주입**했어요.

| 크래시 시점 | 로그 상태 | 복구 동작 | 보장하는 성질 |
|---|---|---|---|
| 커밋 마커 fsync **직후** (데이터 적용 전) | 마커 있음 | **redo** | 내구성 |
| 커밋 마커 **전** | 마커 없음 | **discard** | 원자성 |

전자는 "커밋했다고 답한 변경이 살아남는가", 후자는 "커밋 안 된 절반이 찢어진 채 남지 않는가". 전원이 꺼져도 안 깨진다는 걸 **실제로 크래시를 일으켜** 증명하는 게 이 계층 테스트의 본질입니다.

## 2. 내구성의 가격 — fsync는 공짜가 아니다

WAL의 fsync가 실제로 얼마인지, 5천 행을 두 방식으로 적재해 쟀어요. 행마다 커밋(fsync 5,000회) vs 50행씩 묶어 커밋(fsync 약 100회):

| 적재 방식 | 시간 | 처리량 | fsync 횟수 |
|---|---|---|---|
| 행마다 커밋 | 1.483 s | 3,372 rows/s | 5,000회 |
| 50행씩 묶어 커밋 | 0.063 s | 79,039 rows/s | 약 100회 |

**같은 5천 행인데 23배 차이.** 한 일은 똑같아요 — 인코딩해 힙과 인덱스에 넣는 것. 유일한 차이는 fsync 횟수입니다. 디스크에 "정말 내려갔는지" 확인받는 그 한 번이, CPU가 하는 실제 일보다 압도적으로 비싸요.

이게 중요한 이유 — 내구성(ACID의 D)은 공짜 속성이 아니라 **명시적으로 지불하는 비용**이고, 진짜 DB가 가진 기능의 절반이 이 비용을 깎는 장치이기 때문이에요.

| 다이얼 | 무엇을 하나 |
|---|---|
| **group commit** | 여러 트랜잭션의 fsync를 한 번에 몰아서 (위의 "묶음"이 거친 수동 버전) |
| MySQL `innodb_flush_log_at_trx_commit` | **1** = 커밋마다 write+flush (기본) · **2** = 커밋마다 write, flush는 ~1초마다 (OS 크래시에 마지막 ~1초 유실 가능) · **0** = write·flush 모두 ~1초마다 (mysqld 크래시만으로도 유실 가능) |
| PostgreSQL `synchronous_commit` | 커밋이 fsync를 기다릴지 말지 |

전부 "내구성 granularity를 처리량과 맞바꾸는" 다이얼이에요.

덧붙일 것 하나 — 위 실험의 "묶음"은 사용자가 트랜잭션을 직접 묶은 것이지만, 실제 DB의 group commit은 **사용자가 안 묶어도** 동시에 도착한 커밋들의 fsync를 자동으로 합칩니다(PostgreSQL `commit_delay`, InnoDB group commit). 동시성이 높은 서버에선 fsync 한 번이 여러 트랜잭션에 분할 상환되는 거예요.

> **실무 안티패턴**: ORM이 행마다 flush/commit을 날리는 패턴(flush-per-row). 위 실측의 "행마다 커밋" 행이 정확히 그 모드예요 — 같은 일에 23배를 내고 있을 수 있습니다. 대량 적재의 첫 번째 처방은 배치 커밋이에요.

> **흔한 오해 정정**: *"fsync가 실패하면 재시도하면 된다?"* — 2018년 PostgreSQL 커뮤니티를 뒤흔든 **fsyncgate**가 보여준 함정이에요. 리눅스를 비롯한 여러 커널에서 fsync가 실패하면 커널이 dirty 페이지를 **clean으로 표시해 버려서**, 재시도한 fsync는 태연히 성공을 돌려줍니다 — 데이터는 디스크에 안 내려갔는데도요. 그래서 PostgreSQL 12부터는 fsync 실패 시 재시도하지 않고 **PANIC으로 즉시 내려갑니다** — 재시작해서 WAL redo부터 다시 밟는 것만이 안전한 경로거든요.

> 더 깊이: [트랜잭션 ACID ④: Durability](/blog/theory/transaction-acid-04-durability) — group commit·doublewrite buffer·체크포인트까지, 실제 DB 관점의 전체 그림.

## 3. 사전 지식 — STEAL / FORCE 사분면

여기서부터가 이 편의 본론이에요. 복구 정책은 두 축으로 나뉩니다.

- **STEAL**: 커밋 전의 dirty 페이지를 디스크에 써도 되는가?
- **FORCE**: 커밋 시 모든 dirty 페이지를 디스크에 강제로 내리는가?

두 축을 교차하면 사분면이 나오고, 각 사분면이 필요로 하는 복구가 달라져요.

| | **FORCE** (커밋 시 데이터도 전부 flush) | **NO-FORCE** (커밋 시 로그만 flush) |
|---|---|---|
| **NO-STEAL** (미커밋 페이지 못 내림) | undo 불필요 · redo 최소 — 가장 단순 (1절의 db-hobby) | undo 불필요 · **redo 필요** |
| **STEAL** (미커밋 페이지 내려도 됨) | **undo 정보 필요** · redo 최소 | **redo + undo 정보 둘 다 필요** (PostgreSQL·InnoDB — 그리고 이 편의 종착지) |

> **핵심 프레임**: **"어느 버퍼 정책을 고르느냐가 어떤 복구 로직을 필수로 만든다."** STEAL은 UNDO 정보를 데려오고(미커밋이 디스크에 새니까), NO-FORCE는 REDO를 데려온다(커밋본이 디스크에 없을 수 있으니까). 진짜 DB는 대개 **(steal, no-force)** — 가장 유연하지만 redo·undo 정보를 다 갖춰야 한다.

> **흔한 오해 정정**: *"steal이면 크래시 복구에 반드시 undo 패스가 있다?"* — 정확히는 **undo "정보"가 필요**한 것이고, 그 정보를 어디에 두고 언제 쓰느냐는 DB마다 다릅니다. InnoDB는 undo log에 두고 복구 때 미커밋 변경을 롤백해요. 반면 PostgreSQL은 steal인데도 **크래시 복구에 undo 패스가 없습니다** — MVCC가 행의 옛 버전을 힙에 그대로 두니, 미커밋 트랜잭션이 디스크에 남긴 새 버전 튜플은 clog에서 abort로 판정되어 **아무에게도 안 보이고**, 물리적 청소는 나중에 VACUUM이 하면 그만이거든요. "undo 정보를 어디에 두느냐"의 답이 InnoDB는 undo log, PostgreSQL은 **힙의 옛 버전 자체**인 셈이에요 — 이 구조는 [4편(MVCC)](/blog/project/db-hobby/db-internals-04-mvcc)에서 본격적으로 다룹니다.

1절의 WAL은 **(no-steal, force)** 였어요. no-steal이면 디스크엔 **커밋된 페이지만** 존재하니, 복구가 redo/discard로 끝납니다 — 되돌릴 게 아예 없거든요. 이 단순함은 공짜가 아니었습니다.

## 4. 벽 — 버퍼 풀보다 큰 트랜잭션은 죽는다

작은 트랜잭션은 잘 돕니다. 그런데 한 트랜잭션 안에서 수천 행을 넣으면, 커밋에 도달하지도 못하고 중간에 크래시가 나요. 원인을 좇으면:

```c
BTNode *r = (BTNode *)bufpool_new_page(bt->bp, &rpid);
r->is_leaf = 1;   /* ← bufpool_new_page가 NULL을 돌려줘 여기서 크래시 */
```

버퍼 풀에 자리가 없다는 뜻이에요. 트랜잭션이 페이지를 하나씩 더럽히면, **no-steal 때문에 그 dirty 페이지들이 전부 풀에 남습니다** — 쫓아낼 수 없으니까요. 풀이 다 dirty로 차는 순간 다음 페이지 요청은 NULL. 즉:

> **no-steal의 대가**: 트랜잭션 크기가 버퍼 풀 크기에 못 박힌다. "버퍼 풀보다 큰 트랜잭션이 왜 도는가?"라는 면접 단골 질문의 답이 곧 **STEAL**이다.

## 5. steal을 켜다 — 그리고 undo의 필연

자리가 없으면 dirty 페이지를 **쫓아내되 디스크로 안전하게** 내보내면 됩니다. 단, 그냥 쓰면 미커밋 데이터가 디스크에 남으니 **되돌릴 정보(before-image)를 로그에 먼저** 남겨야 해요 — 이것도 WAL 규칙입니다.

```c
int wal_steal(Wal *w, page_id_t pid, const void *buf) {
    if (!spilled_contains(w, pid)) {
        if (pid < w->base_pages) {             /* 기존 페이지 = 디스크는 아직 커밋본 */
            pager_read(&w->data, pid, before); /* 이게 before-image */
            write_rec(w, REC_UNDO, pid, before);
        }
        spilled_add(w, pid);                   /* 페이지당 한 번만 (first-write-wins) */
    }
    fsync(w->log_fd);                          /* WAL 규칙: undo가 내구된 뒤에야 */
    pager_write(&w->data, pid, buf);           /* 데이터를 바꾼다 */
}
```

두 가지 정확성 포인트가 있어요.

- **최초 steal에서 디스크를 읽으면 그게 곧 커밋본**입니다 — 아직 이 트랜잭션이 그 페이지를 디스크에 쓴 적이 없으니까. 그 순간을 놓치지 않고 잡는 게 핵심이고, `spilled` 집합이 "페이지당 한 번만"을 강제해요(first-write-wins).
- 트랜잭션이 **새로 할당한** 페이지(`>= base_pages`)는 before-image가 필요 없어요 — undo가 그냥 파일을 시작 크기로 truncate하면 되니까.

이제 큰 트랜잭션이 커밋됩니다. 그런데 — **steal을 켠 순간 디스크에 커밋 안 된 변경이 존재하게 됐어요.** 트랜잭션 도중 크래시가 나면 redo-only 복구는 이걸 못 고칩니다. "커밋 마커가 없으니 버린다"고 했지만, 버릴 대상이 이미 디스크에 박혀 버렸거든요.

> **인과의 반전**: no-steal일 땐 "되돌릴 게 없어서" redo만으로 충분했다. steal을 켜면 "되돌릴 게 생겨서" **undo가 필연**이 된다. 정책이 복구를 결정한다는 3절의 프레임이 몸으로 확인되는 순간.

복구는 두 갈래가 됩니다 — 커밋 마커가 있으면 after-image를 redo, 없으면 before-image로 undo하고 새 페이지를 truncate. 그리고 `ROLLBACK`도 **정확히 같은 undo 경로**를 씁니다 — 크래시 복구와 롤백이 한 메커니즘으로 통일돼요.

![steal + undo 복구 — 트랜잭션 중 steal은 before-image를 로그에 남기고, 크래시 시 커밋 마커 유무가 redo와 undo를 가른다](/uploads/project/db-hobby/aries-steal-recovery.svg)

검증: ① 2000행(버퍼 풀 초과) 트랜잭션이 커밋되고 재오픈에도 유지(내구성), ② 큰 트랜잭션 롤백 시 before-image 원복으로 기존 행만 정확히 남음(원자성), ③ steal 후 커밋 전 크래시 → 재오픈 시 undo(크래시 원자성).

## 6. no-force — 커밋을 로그 fsync 하나로

남은 건 FORCE예요. 지금 커밋은 로그 fsync 후 **모든 페이지를 데이터 파일에도 fsync**합니다. 이걸 고치는 동기는 속도보다 **구조** 세 가지였어요.

1. 커밋 비용이 dirty 페이지 수에 **비례**한다 — 트랜잭션이 클수록 커밋이 느려지는 모델.
2. 로그를 커밋마다 버린다 — WAL이 "일어난 일의 기록"이 아니라 일회용 임시 버퍼. PostgreSQL의 WAL은 복제·PITR까지 받치는 **진실의 원천(source of truth)** 인데 말이죠. (MySQL은 복제가 redo 로그가 아니라 별도의 **binlog**로 돕니다 — 그래서 커밋마다 InnoDB redo와 binlog를 내부 2단계 커밋으로 정합시켜요.)
3. 체크포인트·MVCC 같은 다음 단계들이 전부 "로그가 쌓이고 데이터는 게으르게 따라가는" 모델을 전제한다.

원리는 단순합니다 — **내구성은 로그가 책임진다.** after-image가 로그에 fsync됐다면, 데이터 파일이 크래시로 못 따라왔어도 복구가 로그에서 redo하면 돼요. 그럼 커밋은 로그 fsync에서 끝나도 됩니다.

```c
int wal_commit(Wal *w) {
    /* 1) after-image + 커밋 마커 fsync — 유일한 내구성 지점 (no-force) */
    fsync(w->log_fd);
    /* 2) 데이터 파일에 반영은 하되 fsync하지 않는다 — 복구의 redo가 책임 */
    for (...) pager_write(&w->data, ...);
    /* 3) 로그는 자르지 않는다 — 커밋 이력이 곧 진실의 원천 */
}
```

"로그를 안 자른다"에서 연쇄가 시작돼요.

- **연쇄 1 — 복구는 역사의 재생이 된다.** 로그엔 커밋 이력이 쌓입니다: `[커밋1][커밋2][커밋3][미완의 꼬리?]`. 복구는 커밋 구간을 **커밋 순서 그대로** redo하고(같은 페이지를 여러 커밋이 썼어도 순서대로 덮으면 마지막 상태가 정확히 나옴), 마지막 커밋 뒤의 꼬리만 undo합니다. 그리고 복구가 끝나면 데이터 fsync + 로그 truncate — **"DB를 여는 것 자체가 체크포인트"** 예요.
- **연쇄 2 — 롤백은 '내 구간'만.** 로그 앞부분은 남의 커밋 이력이라 건드리면 안 돼요. 트랜잭션 시작 시 로그 끝 오프셋(`txn_log_start`)을 기억해 두고, 롤백은 거기서부터만 undo하고 거기로 되돌립니다.
- **연쇄 3 — 로그가 무한히 자란다: 체크포인트.** 안 자르면 디스크도 문제지만 더 아픈 건 **복구 시간**이에요. 그래서 주기적으로 "데이터가 로그를 따라잡았음"을 선언하고 로그를 비웁니다. 순서가 전부예요 — **데이터 fsync가 먼저, 로그 truncate가 나중.** 반대로 하면 "로그는 버렸는데 데이터는 안 내려간" 구멍이 생깁니다.

> **실무/면접 포인트**: PostgreSQL 튜닝의 `max_wal_size`·`checkpoint_timeout`이 중요한 이유가 정확히 이 트레이드오프다. 체크포인트를 자주 하면 복구가 빠르지만 flush I/O가 몰리고, 드물게 하면 런타임은 가볍지만 복구가 길어진다. **"no-force가 만든 빚(로그)을 언제 갚느냐"** 로 이해하면 그 파라미터들이 한 줄로 꿰인다.

이 트레이드오프는 운영 로그에서 실물로 만납니다 — PostgreSQL이 `LOG: checkpoints are occurring too frequently (9 seconds apart)` 를 찍고 있다면, 쓰기 부하가 `max_wal_size`를 계속 뚫어 체크포인트가 강제로 앞당겨지고 있다는 신호예요.

여기까지로 db-hobby는 진짜 DB와 같은 **(steal, no-force)** 사분면에 도착했습니다. 커밋 = 순차 로그 하나에 fsync 한 번. 데이터 페이지 수십 개에 무작위 fsync 하던 시절과 구조적으로 달라요.

## 7. 진짜 ARIES와의 거리 — 정직한 경계

위 구현은 **ARIES의 발상**을 미니 DB 규모로 옮긴 것이지, 교과서 ARIES 그대로가 아니에요. 그리고 "진짜 DB"의 복구도 하나가 아닙니다 — 흔히 "PostgreSQL·InnoDB는 ARIES 계열"로 뭉뚱그리는데, 그것부터 부정확해요. **교과서 ARIES에 가장 가까운 건 SQL Server**(Analysis→Redo→Undo 3-패스, CLR)고, **InnoDB가 그다음**(redo 로그로 재적용 + undo log로 미커밋 롤백)이며, **PostgreSQL은 ARIES가 아닙니다** — 복구가 redo 단일 패스로 끝나고, undo 패스도 CLR도 없어요. 미커밋 데이터의 뒤처리는 복구가 아니라 MVCC(힙의 옛 버전 + clog 가시성 판정)와 VACUUM의 몫이거든요(3절의 상자). 복구 아키텍처를 나란히 놓으면:

| | db-hobby | PostgreSQL | InnoDB | SQL Server |
|---|---|---|---|---|
| 로깅 단위 | 페이지 **전체** (물리) | physiological WAL 레코드 (+ 체크포인트 후 첫 수정 시 FPI) | physiological redo + 별도 undo log | physiological |
| pageLSN | 없음 | 있음 | 있음 | 있음 |
| 복구 패스 | redo/undo 2-패스 | **redo 단일 패스** | redo 후 undo log로 미커밋 롤백 | Analysis → Redo → Undo 3-패스 |
| 미커밋 잔재 처리 | before-image로 undo | MVCC 옛 버전 + VACUUM (복구 밖에서) | undo log 롤백 | Undo 패스 |
| CLR (보상 로그) | 없음 | 없음 (undo 패스 자체가 없음) | 유사 장치 | 있음 |

여기서 중요한 통찰이 하나 있어요 — **pageLSN과 CLR이 "없어도 되는" 이유가 있습니다.** db-hobby는 페이지 전체를 물리 로깅하므로 redo가 **멱등(idempotent)** 이에요. 전체 페이지를 덮어쓰는 건 몇 번을 해도 같으니까, "이 페이지에 이 로그가 이미 적용됐나"를 판정하는 pageLSN이 필요 없고, undo 도중 재크래시해도 같은 undo를 다시 하면 그만이라 CLR도 필요 없어요. 진짜 DB는 로그를 작게 하려고 physiological 로깅을 쓰고, **그래서** pageLSN이 필요해집니다 — 전체 페이지 덮어쓰기가 아니니 redo의 멱등성이 공짜로 오지 않거든요. CLR까지 필요한지는 복구에 undo 패스가 있느냐로 갈려요 — SQL Server는 있어서 CLR이 필수고, PostgreSQL은 undo 패스 자체가 없으니 CLR도 없습니다.

> **실무/면접 포인트**: "PostgreSQL 크래시 복구엔 왜 undo 패스가 없는가?"는 steal/no-force를 제대로 이해했는지 가르는 질문이에요. 답의 뼈대 — steal로 미커밋 튜플이 디스크에 남아도, MVCC 세계에선 그건 "지워야 할 오염"이 아니라 "커밋 안 된 버전"일 뿐입니다. clog에 abort로 기록되는 순간 모든 스냅샷에서 안 보이게 되고, 물리적 청소는 VACUUM이 나중에 해요. undo를 복구 시점에 하느냐(InnoDB·SQL Server), 평상시에 게으르게 하느냐(PostgreSQL)의 차이입니다.

정직한 경계가 하나 더 있어요 — **torn page**. db-hobby는 "페이지 쓰기는 통째로 되거나 통째로 안 된다"는 원자성을 가정하지만, 실제 디스크는 페이지를 512B~4KB 섹터로 나눠 쓰다 전원이 꺼지면 **반쯤 쓰인 페이지**를 남길 수 있습니다. 실제 DB는 이걸 이중으로 방어해요 — WAL 레코드엔 CRC를 달아 로그의 유효한 끝을 판별하고, 데이터 페이지 쪽은 PostgreSQL이 `full_page_writes`(1절 상자의 FPI)로, InnoDB가 doublewrite buffer로 막습니다.

> **화물숭배 금지**: 기법은 그게 필요해지는 문제가 나타날 때 들여온다. CLR·퍼지 체크포인트·3-패스는 "이 엔진에선 불필요"를 (크래시 주입 테스트로) 증명하고 닫았다 — physiological 로깅과 동시 운영이 등장하면 그때 "필요해서" 들어온다. 이 구분이 ARIES를 외우는 것과 이해하는 것의 차이다.

## 8. 정리

- **WAL 프로토콜** — 데이터보다 로그 먼저, 커밋 마커+fsync 한 줄이 내구성의 분기점. 무작위 쓰기를 순차 쓰기 하나로 바꾼다.
- **fsync는 비싸다** — 같은 5천 행이 커밋 granularity에 따라 **23배** 차이. group commit 계열 다이얼의 존재 이유.
- **STEAL/FORCE 사분면이 복구를 결정한다** — no-steal은 redo만으로 충분하지만 트랜잭션 크기가 버퍼 풀에 못 박히고, steal은 그 벽을 없애는 대신 **undo를 필연**으로 만든다.
- **no-force** — 커밋 = 로그 fsync 하나. 로그가 진실의 원천이 되고, 복구는 역사의 재생이 되며, 체크포인트가 "빚을 갚는" 장치로 필요해진다.
- **ARIES와의 거리** — 페이지 전체 물리 로깅이라 redo가 멱등 → pageLSN·CLR이 불필요. physiological 로깅으로 가면 pageLSN이 "필요해서" 들어온다. 그리고 진짜 DB의 복구도 하나가 아니다 — SQL Server는 교과서 ARIES, InnoDB는 redo+undo log, **PostgreSQL은 redo 단일 패스**(미커밋 뒤처리는 MVCC·VACUUM의 몫).

이제 크래시엔 안 깨져요. 다음 문제는 **동시에 여럿이 쓸 때**입니다 — 잠금이냐 버전이냐, 2PL에서 MVCC 스냅샷 격리까지.

## 참고 (1차 자료 우선)

- C. Mohan et al., *ARIES: A Transaction Recovery Method Supporting Fine-Granularity Locking and Partial Rollbacks Using Write-Ahead Logging* (ACM TODS, 1992)
- [PostgreSQL Documentation: WAL — Reliability and the Write-Ahead Log](https://www.postgresql.org/docs/current/wal.html)
- [PostgreSQL Documentation: WAL Configuration (`full_page_writes` · `commit_delay`)](https://www.postgresql.org/docs/current/runtime-config-wal.html)
- [MySQL 8.0 Reference: InnoDB Redo Log](https://dev.mysql.com/doc/refman/8.0/en/innodb-redo-log.html)
- [MySQL 8.0 Reference: InnoDB Doublewrite Buffer](https://dev.mysql.com/doc/refman/8.0/en/innodb-doublewrite-buffer.html)
- [MySQL 8.0 Reference: `innodb_flush_log_at_trx_commit`](https://dev.mysql.com/doc/refman/8.0/en/innodb-parameters.html#sysvar_innodb_flush_log_at_trx_commit)
- [MySQL 8.0 Reference: The Binary Log](https://dev.mysql.com/doc/refman/8.0/en/binary-log.html)
- [LWN: PostgreSQL's fsync() surprise](https://lwn.net/Articles/752063/) — fsyncgate (2018)
- Hellerstein, Stonebraker & Hamilton, *Architecture of a Database System* (2007) — §6 (Transactions: Concurrency Control and Recovery)
- 본 블로그: [트랜잭션 ACID ①: Atomicity](/blog/theory/transaction-acid-01-atomicity) · [④: Durability](/blog/theory/transaction-acid-04-durability)
- [db-hobby 코드 (GitHub)](https://github.com/dj258255/db-hobby) — `wal.c` · `bufpool.c`

<!-- EN -->

## 0. Introduction — When the Power Dies Mid-Write

Through [Part 2](/blog/project/db-hobby/db-internals-02-btree-index) we got "fast." Now the opposite identity — **not breaking** (Durability, Atomicity).

The problem: a transaction modifies several pages, and the power dies while they're being written to the data file one by one. Some pages land, some don't — the transaction survives **in half (partial update).** Worse, a disk write isn't done when `write()` returns — it can sit in the OS page cache, and only `fsync()` forces it to real disk.

This part solves that in three stages: build the simplest WAL (redo-only) → hit the **price** of that simplicity and turn on steal → finally move to no-force, where **the log becomes the source of truth.** One frame repeats at every stage: "which buffer policy makes which recovery logic mandatory" — the frame laid out theoretically in [Transaction ACID ① (Atomicity)](/blog/theory/transaction-acid-01-atomicity), here walked step by step in an implementation.

## 1. The WAL Protocol — Log Before Data

The idea of the **Write-Ahead Log** is simple: **before** touching the data file, append the changes to a log **and fsync it.**

> **Key definition**: WAL is the protocol "write the change to the log and fsync it before modifying the data file." The data file takes **random writes** to scattered pages, but the log is an **appending sequential write** — fast — and one fsync atomically "confirms" the whole transaction. (db-hobby logs entire changed pages for simplicity — physical page logging. PostgreSQL usually writes WAL records describing just the *change*, with one exception, the full-page image: with `full_page_writes` on, in the official docs' words, it *"writes the entire content of each disk page to WAL during the first modification of that page after a checkpoint"* — only the **first** modification after a checkpoint, to give redo solid ground even atop a half-written page. InnoDB puts no FPIs in its redo log — torn-page defense is the job of a separate mechanism, the **doublewrite buffer**.)

![WAL flow — stage → log + commit marker fsync (durability watershed) → apply to data → clear log](/uploads/project/db-hobby/wal-flow.svg)

```c
int wal_commit(Wal *w) {
    /* 1) write the changed pages to the log (write-ahead) */
    /* 2) commit marker + fsync — past this line, it's durable */
    write_all(w->log_fd, &commit_marker, 1);
    fsync(w->log_fd);                          /* ← durability watershed */
    /* 3) apply to the data file */
    /* 4) clear the log */
}
```

**The commit marker + fsync line is the durability watershed.** And the recovery rule is astonishingly simple:

> **Recovery rule (stage 1)**: if the log has a commit marker, **redo** (re-apply to data); if not, **discard.** That's all.

To prove it, the tests **inject crashes at exactly the two dangerous moments**:

| Crash point | Log state | Recovery | Property guaranteed |
|---|---|---|---|
| right **after** marker fsync (before data apply) | marker present | **redo** | Durability |
| **before** the marker | no marker | **discard** | Atomicity |

The former: "does a change we acknowledged as committed survive?" The latter: "does an uncommitted half not remain torn?" Proving "power loss doesn't corrupt" by **actually crashing** is the essence of testing this layer.

## 2. The Price of Durability — fsync Is Not Free

How much does that fsync cost? Loading 5,000 rows two ways — commit per row (5,000 fsyncs) vs batches of 50 (about 100 fsyncs):

| Load method | Time | Throughput | fsyncs |
|---|---|---|---|
| commit per row | 1.483 s | 3,372 rows/s | 5,000 |
| batches of 50 | 0.063 s | 79,039 rows/s | ~100 |

**The same 5,000 rows, 23× apart.** The work is identical — encode, insert into heap and index. The only difference is the fsync count. That one "did it really reach disk?" confirmation costs overwhelmingly more than the actual CPU work.

Why this matters: durability (the D in ACID) isn't a free property but **a cost you explicitly pay** — and half of a real DB's features are dials for trimming it:

| Dial | What it does |
|---|---|
| **group commit** | batch several transactions' fsyncs into one (the manual "batching" above, refined) |
| MySQL `innodb_flush_log_at_trx_commit` | **1** = write+flush at every commit (default) · **2** = write at every commit, flush ~once a second (an OS crash can lose the last ~second) · **0** = write and flush both ~once a second (even a mysqld crash can lose data) |
| PostgreSQL `synchronous_commit` | whether a commit waits for the fsync |

All are dials trading durability granularity for throughput.

One more note — the "batching" in the experiment above was the user grouping transactions by hand, but real DBs' group commit merges the fsyncs of concurrently arriving commits **even when the user doesn't batch anything** (PostgreSQL `commit_delay`, InnoDB group commit). On a highly concurrent server, one fsync amortizes across many transactions.

> **Real-world anti-pattern**: the ORM flush-per-row pattern — a flush/commit fired for every row. The "commit per row" line in the measurement above is exactly that mode: you may be paying 23× for the same work. The first prescription for bulk loads is batched commits.

> **Common misconception, corrected**: *"if fsync fails, just retry it?"* — The trap exposed by **fsyncgate**, which shook the PostgreSQL community in 2018. On Linux and several other kernels, when fsync fails the kernel **marks the dirty pages clean anyway**, so a retried fsync blithely returns success — even though the data never reached disk. That's why, since PostgreSQL 12, an fsync failure is not retried but triggers an immediate **PANIC** — restarting and replaying WAL redo from scratch is the only safe path.

> Deeper: [Transaction ACID ④: Durability](/blog/theory/transaction-acid-04-durability) — group commit, the doublewrite buffer, checkpoints, from the real-DB perspective.

## 3. Prerequisites — the STEAL / FORCE Quadrant

Now the main act. Recovery policy splits along two axes:

- **STEAL**: may uncommitted dirty pages be written to disk?
- **FORCE**: must all dirty pages be forced to disk at commit?

Cross the two axes and you get quadrants, each demanding different recovery:

| | **FORCE** (flush all data at commit) | **NO-FORCE** (flush only the log at commit) |
|---|---|---|
| **NO-STEAL** (uncommitted pages never written) | no undo · minimal redo — simplest (the db-hobby of §1) | no undo · **redo required** |
| **STEAL** (uncommitted pages may be written) | **undo information required** · minimal redo | **both redo + undo information** (PostgreSQL · InnoDB — and this part's destination) |

> **Key frame**: **"the buffer policy you choose determines which recovery logic is mandatory."** STEAL brings UNDO information (uncommitted data leaks to disk); NO-FORCE brings REDO (committed data may not be on disk). Real DBs are usually **(steal, no-force)** — the most flexible, at the cost of needing both.

> **Common misconception, corrected**: *"steal implies an undo pass in crash recovery?"* — Precisely speaking, steal requires **undo *information***; where that information lives and when it's used differs per DB. InnoDB keeps it in the undo log and rolls back uncommitted changes during recovery. PostgreSQL, though, is steal and yet has **no undo pass in crash recovery** — MVCC keeps old row versions in the heap, so the new-version tuples an uncommitted transaction left on disk are judged aborted via clog, become **visible to no one**, and physical cleanup is simply VACUUM's job later. The answer to "where does the undo information live" is the undo log for InnoDB and **the old versions in the heap themselves** for PostgreSQL — a structure treated in earnest in [Part 4 (MVCC)](/blog/project/db-hobby/db-internals-04-mvcc).

The WAL of §1 was **(no-steal, force)**: with no-steal, the disk contains **only committed pages**, so recovery ends at redo/discard — there's nothing to undo. That simplicity was not free.

## 4. The Wall — Transactions Larger Than the Buffer Pool Die

Small transactions run fine. Insert thousands of rows in one transaction and it crashes before reaching commit:

```c
BTNode *r = (BTNode *)bufpool_new_page(bt->bp, &rpid);
r->is_leaf = 1;   /* ← bufpool_new_page returned NULL; crash here */
```

The buffer pool is out of room. As the transaction dirties pages one by one, **no-steal keeps every dirty page in the pool** — they can't be evicted. The moment the pool fills with dirty pages, the next request gets NULL.

> **The price of no-steal**: transaction size is nailed to buffer-pool size. The answer to the classic interview question — "why can a transaction larger than the buffer pool run?" — is **STEAL.**

## 5. Turning On Steal — and the Inevitability of Undo

When there's no room, evict dirty pages — but safely. Writing them raw would leave uncommitted data on disk, so **log the undo information (before-image) first.** That, too, is the WAL rule.

```c
int wal_steal(Wal *w, page_id_t pid, const void *buf) {
    if (!spilled_contains(w, pid)) {
        if (pid < w->base_pages) {             /* existing page: disk still holds committed state */
            pager_read(&w->data, pid, before); /* this IS the before-image */
            write_rec(w, REC_UNDO, pid, before);
        }
        spilled_add(w, pid);                   /* once per page (first-write-wins) */
    }
    fsync(w->log_fd);                          /* WAL rule: undo durable first */
    pager_write(&w->data, pid, buf);           /* then modify the data */
}
```

Two correctness points:

- **On the first steal of a page, reading the disk yields exactly the committed state** — this transaction hasn't written that page to disk yet. Capturing that moment is the crux, and the `spilled` set enforces "once per page" (first-write-wins).
- Pages the transaction **newly allocated** (`>= base_pages`) need no before-image — undo just truncates the file back to its starting size.

Large transactions now commit. But — **the moment steal is on, uncommitted changes exist on disk.** If a crash lands mid-transaction, redo-only recovery can't fix it: "no marker, so discard" — but what should be discarded has already been applied to disk.

> **The causal reversal**: under no-steal, redo sufficed because "there was nothing to undo." Turn on steal and "there is now something to undo" — **undo becomes inevitable.** The frame of §3, confirmed in the flesh.

Recovery forks: with a commit marker, redo the after-images; without one, undo via before-images and truncate new pages. And `ROLLBACK` uses **exactly the same undo path** — crash recovery and rollback unify into one mechanism.

![steal + undo recovery — steals log before-images; at crash, the commit marker's presence separates redo from undo](/uploads/project/db-hobby/aries-steal-recovery.svg)

Verified: ① a 2,000-row (pool-exceeding) transaction commits and survives reopen (durability); ② rolling back a large transaction restores before-images so exactly the pre-existing rows remain (atomicity); ③ crash after steal but before commit → undo on reopen (crash atomicity).

## 6. No-Force — Commit Becomes One Log Fsync

FORCE remains. Commit currently fsyncs the log and then **fsyncs every page to the data file too.** The motivation to fix it is structural, threefold:

1. Commit cost is **proportional to dirty page count** — bigger transactions mean slower commits, by design.
2. The log is discarded at every commit — the WAL is a disposable buffer, not "the record of what happened." PostgreSQL's WAL, by contrast, is the **source of truth** underpinning replication and PITR. (MySQL replication runs not on the redo log but on a separate log, the **binlog** — which is why every commit reconciles InnoDB redo and the binlog through an internal two-phase commit.)
3. Everything that follows (checkpoints, MVCC) presumes the "log accumulates, data lazily follows" model.

The principle is simple — **the log owns durability.** If the after-images are fsynced in the log, recovery can redo them even if the data file never caught up. So commit may end at the log fsync:

```c
int wal_commit(Wal *w) {
    /* 1) after-images + commit marker fsync — the only durability point (no-force) */
    fsync(w->log_fd);
    /* 2) write back to the data file but do NOT fsync — recovery's redo owns it */
    for (...) pager_write(&w->data, ...);
    /* 3) do not truncate the log — the commit history is the source of truth */
}
```

"Don't truncate the log" starts a cascade:

- **Cascade 1 — recovery becomes a replay of history.** The log accumulates: `[commit1][commit2][commit3][unfinished tail?]`. Recovery redoes commit ranges **in commit order** (even if several commits wrote the same page, replaying in order yields exactly the final state), then undoes only the tail. When recovery finishes: data fsync + log truncate — **"opening the DB is itself a checkpoint."**
- **Cascade 2 — rollback touches only "my range."** The front of the log is other transactions' commit history. Remember the log-end offset at `BEGIN` (`txn_log_start`); rollback undoes from there only and truncates back to it.
- **Cascade 3 — the log grows without bound: checkpoints.** The real pain isn't disk, it's **recovery time.** Periodically declare "data has caught up with the log" and clear it. Order is everything — **data fsync first, log truncate second.** The reverse leaves a hole: "log discarded, data never landed."

> **Practical/interview point**: this is precisely why `max_wal_size` and `checkpoint_timeout` matter in PostgreSQL tuning. Frequent checkpoints → fast recovery but bursty flush I/O; rare ones → light runtime but long recovery. Read them as **"when do you repay the debt (the log) that no-force created"** and the parameters string onto one line.

You meet this trade-off in the flesh in production logs — if PostgreSQL is printing `LOG: checkpoints are occurring too frequently (9 seconds apart)`, write load keeps blowing through `max_wal_size` and checkpoints are being forced early.

db-hobby has now arrived in the same **(steal, no-force)** quadrant as real DBs. Commit = one fsync on one sequential log.

## 7. The Distance to Real ARIES — an Honest Boundary

This implementation carries **the idea of ARIES** at mini-DB scale; it is not textbook ARIES. And "real DB" recovery isn't one thing either — the common shorthand "PostgreSQL and InnoDB are ARIES-family" is itself inaccurate. **Closest to textbook ARIES is SQL Server** (Analysis→Redo→Undo 3-pass, CLRs); **InnoDB comes next** (redo log for re-application + undo log for rolling back uncommitted work); and **PostgreSQL is not ARIES** — its recovery finishes in a single redo pass, with no undo pass and no CLRs. Cleaning up uncommitted data is the job not of recovery but of MVCC (old heap versions + clog visibility) and VACUUM (the box in §3). Side by side:

| | db-hobby | PostgreSQL | InnoDB | SQL Server |
|---|---|---|---|---|
| Logging unit | whole **pages** (physical) | physiological WAL records (+ FPI on first post-checkpoint modification) | physiological redo + separate undo log | physiological |
| pageLSN | none | yes | yes | yes |
| Recovery passes | redo/undo, 2-pass | **single redo pass** | redo, then undo-log rollback of uncommitted work | Analysis → Redo → Undo, 3-pass |
| Uncommitted residue | undone via before-images | MVCC old versions + VACUUM (outside recovery) | undo-log rollback | Undo pass |
| CLR (compensation log) | none | none (no undo pass at all) | analogous machinery | yes |

One insight matters here — **there is a reason pageLSN and CLR can be absent.** Because db-hobby logs whole pages physically, redo is **idempotent**: overwriting a full page any number of times yields the same result. So no pageLSN is needed to ask "was this log already applied to this page," and re-crashing during undo just repeats the same undo — no CLR needed. Real DBs use physiological logging to keep logs small, and **that** is what makes pageLSN necessary — without full-page overwrites, redo's idempotence no longer comes free. Whether CLRs are needed too splits on whether recovery has an undo pass — SQL Server does, so CLRs are essential; PostgreSQL has no undo pass at all, hence no CLRs.

> **Practical/interview point**: "Why does PostgreSQL crash recovery have no undo pass?" is the question that separates people who truly understand steal/no-force. The skeleton of the answer — even though steal leaves uncommitted tuples on disk, in an MVCC world they are not "contamination to erase" but merely "versions that never committed." The moment the transaction is recorded as aborted in clog, they become invisible to every snapshot, and physical cleanup falls to VACUUM later. It's the difference between undoing at recovery time (InnoDB, SQL Server) and undoing lazily during normal operation (PostgreSQL).

One more honest boundary — the **torn page**. db-hobby assumes page writes are all-or-nothing, but real disks write a page in 512B–4KB sectors, and losing power mid-way can leave a **half-written page**. Real DBs defend in two layers — WAL records carry CRCs to find the log's valid end, and on the data-page side PostgreSQL uses `full_page_writes` (the FPI from the box in §1) while InnoDB uses the doublewrite buffer.

> **No cargo-culting**: bring in a technique when the problem that demands it appears. CLR, fuzzy checkpoints, and 3-pass were closed with a proof (crash-injection tests) that "this engine doesn't need them" — they enter when physiological logging and concurrent operation arrive, *because needed*. That distinction is the difference between memorizing ARIES and understanding it.

## 8. Wrap-up

- **The WAL protocol** — log before data; the marker+fsync line is the durability watershed. Random writes become one sequential write.
- **fsync is expensive** — the same 5,000 rows differ **23×** by commit granularity. Hence the group-commit family of dials.
- **The STEAL/FORCE quadrant determines recovery** — no-steal keeps redo-only recovery but nails transaction size to the pool; steal removes that wall at the price of making **undo inevitable.**
- **No-force** — commit = one log fsync. The log becomes the source of truth, recovery becomes a replay of history, and checkpoints appear as the debt-repayment device.
- **The distance to ARIES** — whole-page physical logging makes redo idempotent → pageLSN/CLR unnecessary. Move to physiological logging and pageLSN enters *because needed*. And real-DB recovery isn't one thing — SQL Server is textbook ARIES, InnoDB is redo + undo log, **PostgreSQL is a single redo pass** (uncommitted cleanup belongs to MVCC and VACUUM).

Crashes no longer corrupt us. The next problem is **many writers at once** — locks or versions: from 2PL to MVCC snapshot isolation.

## References (primary sources first)

- C. Mohan et al., *ARIES: A Transaction Recovery Method Supporting Fine-Granularity Locking and Partial Rollbacks Using Write-Ahead Logging* (ACM TODS, 1992)
- [PostgreSQL Documentation: Reliability and the Write-Ahead Log](https://www.postgresql.org/docs/current/wal.html)
- [PostgreSQL Documentation: WAL Configuration (`full_page_writes` · `commit_delay`)](https://www.postgresql.org/docs/current/runtime-config-wal.html)
- [MySQL 8.0 Reference: InnoDB Redo Log](https://dev.mysql.com/doc/refman/8.0/en/innodb-redo-log.html)
- [MySQL 8.0 Reference: InnoDB Doublewrite Buffer](https://dev.mysql.com/doc/refman/8.0/en/innodb-doublewrite-buffer.html)
- [MySQL 8.0 Reference: `innodb_flush_log_at_trx_commit`](https://dev.mysql.com/doc/refman/8.0/en/innodb-parameters.html#sysvar_innodb_flush_log_at_trx_commit)
- [MySQL 8.0 Reference: The Binary Log](https://dev.mysql.com/doc/refman/8.0/en/binary-log.html)
- [LWN: PostgreSQL's fsync() surprise](https://lwn.net/Articles/752063/) — fsyncgate (2018)
- Hellerstein, Stonebraker & Hamilton, *Architecture of a Database System* (2007), §6
- This blog: [Transaction ACID ①: Atomicity](/blog/theory/transaction-acid-01-atomicity) · [④: Durability](/blog/theory/transaction-acid-04-durability)
- [db-hobby source (GitHub)](https://github.com/dj258255/db-hobby) — `wal.c` · `bufpool.c`

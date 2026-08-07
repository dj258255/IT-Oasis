---
title: 'DB 내부 ③: WAL과 크래시 복구, redo-only에서 steal + no-force까지'
description: "쓰다가 전원이 꺼지면 어떻게 되는가. WAL 프로토콜의 본질(데이터보다 로그 먼저, fsync 한 번이 내구성의 분기점)에서 시작해, 복구 규칙이 'redo 아니면 discard' 하나로 끝나는 가장 단순한 형태를 짓고, 그 단순함의 대가(버퍼 풀보다 큰 트랜잭션이 죽는다)에 부딪혀 steal을 켜고(before-image·undo의 필연), 마지막으로 no-force(커밋 = 로그 fsync 하나)로 옮겨 로그가 진실의 원천이 되기까지. STEAL/FORCE 사분면이 어떤 복구 로직을 필수로 만드는지, 진짜 ARIES(physiological 로깅·pageLSN·CLR·3-패스)와의 거리는 어디인지, fsync의 가격(같은 5천 행 적재가 23배 차이)은 얼마인지, 크래시를 실제로 주입한 테스트와 실측으로 확인하며 정리합니다."
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

## 0. 들어가며: 쓰다가 전원이 꺼지면

[2편](/blog/project/db-hobby/db-internals-02-btree-index)까지로 "빠르게"는 얻었습니다. 이번엔 정반대 정체성, **안 깨지게**(내구성 Durability, 원자성 Atomicity)입니다.

문제는 이렇습니다. 한 트랜잭션이 여러 페이지를 고치는데, 데이터 파일에 하나씩 쓰는 도중 전원이 꺼지면? 일부 페이지만 반영되고 일부는 안 돼 트랜잭션이 **반쪽만 남습니다(partial update).** 게다가 디스크 쓰기는 `write()` 했다고 끝이 아닙니다. OS 페이지 캐시에 머물 수 있어서, `fsync()`로 강제로 내려야 진짜 디스크에 닿습니다.

이 편은 그 문제를 세 단계로 풉니다. 가장 단순한 WAL(redo-only)을 짓고 → 그 단순함의 **대가**에 부딪혀 steal을 켜고 → 마지막으로 no-force로 옮겨 **로그가 진실의 원천**이 되기까지. 각 단계에서 "어떤 버퍼 정책이 어떤 복구 로직을 필수로 만드는가"라는 프레임이 반복됩니다. [트랜잭션 ACID ①(Atomicity)](/blog/theory/transaction-acid-01-atomicity)에서 이론으로 정리한 그 틀을, 여기선 구현하며 하나씩 밟습니다.

## 1. WAL 프로토콜: 데이터보다 로그를 먼저

**WAL(Write-Ahead Log)** 의 아이디어는 단순합니다. 데이터 파일을 고치기 **전에**, 바뀔 내용을 **로그에 먼저 순차로 적고 fsync**합니다.

> **핵심 정의**: WAL은 "데이터 파일을 고치기 전에 그 변경을 로그에 먼저 적고 fsync한다"는 프로토콜이다. 데이터 파일은 흩어진 페이지에 **무작위 쓰기**지만 로그는 끝에 이어 붙이는 **순차 쓰기**라 빠르고, 한 번의 fsync로 트랜잭션 전체를 원자적으로 "확정"할 수 있다. (db-hobby는 단순함을 위해 바뀐 페이지 **전체**를 적는 physical page logging이다. PostgreSQL은 보통 변경 *내용*만 적는 WAL 레코드를 쓰되, full-page image라는 예외를 둔다. `full_page_writes`가 켜져 있으면 공식 문서 표현 그대로 *"writes the entire content of each disk page to WAL during the first modification of that page after a checkpoint"*, 즉 체크포인트 후 그 페이지의 **첫 수정 때만** 페이지 전체를 WAL에 적는다. 반쯤 쓰인 페이지 위에서도 redo를 시작할 발판을 만들기 위해서다. InnoDB는 redo 로그에 FPI를 쓰지 않는다. torn page 방어는 **doublewrite buffer**라는 별도 장치의 몫이다.)

![WAL 흐름: stage → 로그+커밋마커 fsync(내구성 분기점) → 데이터 적용 → 로그 비움](/uploads/project/db-hobby/wal-flow.svg)

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

**커밋 마커 + fsync 한 줄이 내구성의 분기점**입니다. 그 줄을 지나야 "이 트랜잭션은 살아남는다"가 보장됩니다. 그리고 복구 규칙은 놀랍도록 단순합니다:

> **복구 규칙(1단계)**: 로그에 커밋 마커가 **있으면 redo**(데이터에 재적용), **없으면 discard**(버림). 그게 전부.

이걸 증명하려고 테스트에서 **정확히 두 위험한 순간에 크래시를 주입**했습니다.

| 크래시 시점 | 로그 상태 | 복구 동작 | 보장하는 성질 |
|---|---|---|---|
| 커밋 마커 fsync **직후** (데이터 적용 전) | 마커 있음 | **redo** | 내구성 |
| 커밋 마커 **전** | 마커 없음 | **discard** | 원자성 |

전자는 "커밋했다고 답한 변경이 살아남는가", 후자는 "커밋 안 된 절반이 찢어진 채 남지 않는가". 전원이 꺼져도 안 깨진다는 걸 **실제로 크래시를 일으켜** 증명하는 게 이 계층 테스트의 본질입니다.

## 2. 내구성의 가격: fsync는 공짜가 아니다

WAL의 fsync가 실제로 얼마인지, 5천 행을 두 방식으로 적재해 쟀습니다. 행마다 커밋(fsync 5,000회) vs 50행씩 묶어 커밋(fsync 약 100회):

| 적재 방식 | 시간 | 처리량 | fsync 횟수 |
|---|---|---|---|
| 행마다 커밋 | 1.483 s | 3,372 rows/s | 5,000회 |
| 50행씩 묶어 커밋 | 0.063 s | 79,039 rows/s | 약 100회 |

**같은 5천 행인데 23배 차이.** 한 일은 똑같습니다. 인코딩해 힙과 인덱스에 넣는 것입니다. 유일한 차이는 fsync 횟수입니다. 디스크에 "정말 내려갔는지" 확인받는 그 한 번이, CPU가 하는 실제 일보다 압도적으로 비쌉니다.

이게 중요한 이유는 이렇습니다. 내구성(ACID의 D)은 공짜 속성이 아니라 **명시적으로 지불하는 비용**이고, 진짜 DB가 가진 기능의 절반이 이 비용을 깎는 장치이기 때문입니다.

| 다이얼 | 무엇을 하나 |
|---|---|
| **group commit** | 여러 트랜잭션의 fsync를 한 번에 몰아서 (위의 "묶음"이 거친 수동 버전) |
| MySQL `innodb_flush_log_at_trx_commit` | **1** = 커밋마다 write+flush (기본) · **2** = 커밋마다 write, flush는 ~1초마다 (OS 크래시에 마지막 ~1초 유실 가능) · **0** = write·flush 모두 ~1초마다 (mysqld 크래시만으로도 유실 가능) |
| PostgreSQL `synchronous_commit` | 커밋이 fsync를 기다릴지 말지 |

전부 "내구성 granularity를 처리량과 맞바꾸는" 다이얼입니다.

덧붙일 것이 하나 있습니다. 위 실험의 "묶음"은 사용자가 트랜잭션을 직접 묶은 것이지만, 실제 DB의 group commit은 **사용자가 안 묶어도** 동시에 도착한 커밋들의 fsync를 자동으로 합칩니다(PostgreSQL `commit_delay`, InnoDB group commit). 동시성이 높은 서버에선 fsync 한 번이 여러 트랜잭션에 분할 상환됩니다.

> **실무 안티패턴**: ORM이 행마다 flush/commit을 날리는 패턴(flush-per-row). 위 실측의 "행마다 커밋" 행이 정확히 그 모드입니다. 같은 일에 23배를 내고 있을 수 있습니다. 대량 적재의 첫 번째 처방은 배치 커밋입니다.

> **흔한 오해 정정**: *"fsync가 실패하면 재시도하면 된다?"* 2018년 PostgreSQL 커뮤니티를 뒤흔든 **fsyncgate**가 보여준 함정입니다. 리눅스를 비롯한 여러 커널에서 fsync가 실패하면 커널이 dirty 페이지를 **clean으로 표시해 버려서**, 재시도한 fsync는 태연히 성공을 돌려줍니다. 데이터는 디스크에 안 내려갔는데도 말입니다. 그래서 PostgreSQL 12부터는 fsync 실패 시 재시도하지 않고 **PANIC으로 즉시 내려갑니다**. 재시작해서 WAL redo부터 다시 밟는 것만이 안전한 경로입니다.

> 더 깊이: [트랜잭션 ACID ④: Durability](/blog/theory/transaction-acid-04-durability)에서 group commit·doublewrite buffer·체크포인트까지, 실제 DB 관점의 전체 그림.

## 3. 사전 지식: STEAL / FORCE 사분면

여기서부터가 이 편의 본론입니다. 복구 정책은 두 축으로 나뉩니다.

- **STEAL**: 커밋 전의 dirty 페이지를 디스크에 써도 되는가?
- **FORCE**: 커밋 시 모든 dirty 페이지를 디스크에 강제로 내리는가?

두 축을 교차하면 사분면이 나오고, 각 사분면이 필요로 하는 복구가 달라집니다.

| | **FORCE** (커밋 시 데이터도 전부 flush) | **NO-FORCE** (커밋 시 로그만 flush) |
|---|---|---|
| **NO-STEAL** (미커밋 페이지 못 내림) | undo 불필요 · redo 최소, 가장 단순 (1절의 db-hobby) | undo 불필요 · **redo 필요** |
| **STEAL** (미커밋 페이지 내려도 됨) | **undo 정보 필요** · redo 최소 | **redo + undo 정보 둘 다 필요** (PostgreSQL·InnoDB, 그리고 이 편의 종착지) |

> **핵심 프레임**: **"어느 버퍼 정책을 고르느냐가 어떤 복구 로직을 필수로 만든다."** STEAL은 UNDO 정보를 데려오고(미커밋이 디스크에 새니까), NO-FORCE는 REDO를 데려온다(커밋본이 디스크에 없을 수 있으니까). 진짜 DB는 대개 **(steal, no-force)**이며, 가장 유연하지만 redo·undo 정보를 다 갖춰야 한다.

> **흔한 오해 정정**: *"steal이면 크래시 복구에 반드시 undo 패스가 있다?"* 정확히는 **undo "정보"가 필요**한 것이고, 그 정보를 어디에 두고 언제 쓰느냐는 DB마다 다릅니다. InnoDB는 undo log에 두고 복구 때 미커밋 변경을 롤백합니다. 반면 PostgreSQL은 steal인데도 **크래시 복구에 undo 패스가 없습니다**. MVCC가 행의 옛 버전을 힙에 그대로 두니, 미커밋 트랜잭션이 디스크에 남긴 새 버전 튜플은 clog에서 abort로 판정되어 **아무에게도 안 보이고**, 물리적 청소는 나중에 VACUUM이 하면 그만입니다. "undo 정보를 어디에 두느냐"의 답이 InnoDB는 undo log, PostgreSQL은 **힙의 옛 버전 자체**인 셈입니다. 이 구조는 [4편(MVCC)](/blog/project/db-hobby/db-internals-04-mvcc)에서 본격적으로 다룹니다.

1절의 WAL은 **(no-steal, force)** 였습니다. no-steal이면 디스크엔 **커밋된 페이지만** 존재하니, 복구가 redo/discard로 끝납니다. 되돌릴 게 아예 없기 때문입니다. 이 단순함은 공짜가 아니었습니다.

## 4. 벽: 버퍼 풀보다 큰 트랜잭션은 죽는다

작은 트랜잭션은 잘 돕니다. 그런데 한 트랜잭션 안에서 수천 행을 넣으면, 커밋에 도달하지도 못하고 중간에 크래시가 납니다. 원인을 좇으면:

```c
BTNode *r = (BTNode *)bufpool_new_page(bt->bp, &rpid);
r->is_leaf = 1;   /* ← bufpool_new_page가 NULL을 돌려줘 여기서 크래시 */
```

버퍼 풀에 자리가 없다는 뜻입니다. 트랜잭션이 페이지를 하나씩 더럽히면, **no-steal 때문에 그 dirty 페이지들이 전부 풀에 남습니다**. 쫓아낼 수 없기 때문입니다. 풀이 다 dirty로 차는 순간 다음 페이지 요청은 NULL. 즉:

> **no-steal의 대가**: 트랜잭션 크기가 버퍼 풀 크기에 못 박힌다. "버퍼 풀보다 큰 트랜잭션이 왜 도는가?"라는 면접 단골 질문의 답이 곧 **STEAL**이다.

## 5. steal을 켜다: 그리고 undo의 필연

자리가 없으면 dirty 페이지를 **쫓아내되 디스크로 안전하게** 내보내면 됩니다. 단, 그냥 쓰면 미커밋 데이터가 디스크에 남으니 **되돌릴 정보(before-image)를 로그에 먼저** 남겨야 합니다. 이것도 WAL 규칙입니다.

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

두 가지 정확성 포인트가 있습니다.

- **최초 steal에서 디스크를 읽으면 그게 곧 커밋본**입니다. 아직 이 트랜잭션이 그 페이지를 디스크에 쓴 적이 없기 때문입니다. 그 순간을 놓치지 않고 잡는 게 핵심이고, `spilled` 집합이 "페이지당 한 번만"을 강제합니다(first-write-wins).
- 트랜잭션이 **새로 할당한** 페이지(`>= base_pages`)는 before-image가 필요 없습니다. undo가 그냥 파일을 시작 크기로 truncate하면 되기 때문입니다.

이제 큰 트랜잭션이 커밋됩니다. 그런데 **steal을 켠 순간 디스크에 커밋 안 된 변경이 존재하게 됐습니다.** 트랜잭션 도중 크래시가 나면 redo-only 복구는 이걸 못 고칩니다. "커밋 마커가 없으니 버린다"고 했지만, 버릴 대상이 이미 디스크에 박혀 버렸기 때문입니다.

> **인과의 반전**: no-steal일 땐 "되돌릴 게 없어서" redo만으로 충분했다. steal을 켜면 "되돌릴 게 생겨서" **undo가 필연**이 된다. 정책이 복구를 결정한다는 3절의 프레임이 몸으로 확인되는 순간.

복구는 두 갈래가 됩니다. 커밋 마커가 있으면 after-image를 redo, 없으면 before-image로 undo하고 새 페이지를 truncate. 그리고 `ROLLBACK`도 **정확히 같은 undo 경로**를 씁니다. 크래시 복구와 롤백이 한 메커니즘으로 통일됩니다.

![steal + undo 복구: 트랜잭션 중 steal은 before-image를 로그에 남기고, 크래시 시 커밋 마커 유무가 redo와 undo를 가른다](/uploads/project/db-hobby/aries-steal-recovery.svg)

검증: ① 2000행(버퍼 풀 초과) 트랜잭션이 커밋되고 재오픈에도 유지(내구성), ② 큰 트랜잭션 롤백 시 before-image 원복으로 기존 행만 정확히 남음(원자성), ③ steal 후 커밋 전 크래시 → 재오픈 시 undo(크래시 원자성).

## 6. no-force: 커밋을 로그 fsync 하나로

남은 건 FORCE입니다. 지금 커밋은 로그 fsync 후 **모든 페이지를 데이터 파일에도 fsync**합니다. 이걸 고치는 동기는 속도보다 **구조** 세 가지였습니다.

1. 커밋 비용이 dirty 페이지 수에 **비례**한다. 트랜잭션이 클수록 커밋이 느려지는 모델.
2. 로그를 커밋마다 버린다. WAL이 "일어난 일의 기록"이 아니라 일회용 임시 버퍼다. PostgreSQL의 WAL은 복제·PITR까지 받치는 **진실의 원천(source of truth)**인데 말이다. (MySQL은 복제가 redo 로그가 아니라 별도의 **binlog**로 돕니다. 그래서 커밋마다 InnoDB redo와 binlog를 내부 2단계 커밋으로 정합시킵니다.)
3. 체크포인트·MVCC 같은 다음 단계들이 전부 "로그가 쌓이고 데이터는 게으르게 따라가는" 모델을 전제한다.

원리는 단순합니다. **내구성은 로그가 책임진다.** after-image가 로그에 fsync됐다면, 데이터 파일이 크래시로 못 따라왔어도 복구가 로그에서 redo하면 됩니다. 그럼 커밋은 로그 fsync에서 끝나도 됩니다.

```c
int wal_commit(Wal *w) {
    /* 1) after-image + 커밋 마커 fsync — 유일한 내구성 지점 (no-force) */
    fsync(w->log_fd);
    /* 2) 데이터 파일에 반영은 하되 fsync하지 않는다 — 복구의 redo가 책임 */
    for (...) pager_write(&w->data, ...);
    /* 3) 로그는 자르지 않는다 — 커밋 이력이 곧 진실의 원천 */
}
```

"로그를 안 자른다"에서 연쇄가 시작됩니다.

- **연쇄 1: 복구는 역사의 재생이 된다.** 로그엔 커밋 이력이 쌓입니다: `[커밋1][커밋2][커밋3][미완의 꼬리?]`. 복구는 커밋 구간을 **커밋 순서 그대로** redo하고(같은 페이지를 여러 커밋이 썼어도 순서대로 덮으면 마지막 상태가 정확히 나옴), 마지막 커밋 뒤의 꼬리만 undo합니다. 그리고 복구가 끝나면 데이터 fsync + 로그 truncate, **"DB를 여는 것 자체가 체크포인트"**입니다.
- **연쇄 2: 롤백은 '내 구간'만.** 로그 앞부분은 남의 커밋 이력이라 건드리면 안 됩니다. 트랜잭션 시작 시 로그 끝 오프셋(`txn_log_start`)을 기억해 두고, 롤백은 거기서부터만 undo하고 거기로 되돌립니다.
- **연쇄 3, 로그가 무한히 자란다: 체크포인트.** 안 자르면 디스크도 문제지만 더 아픈 건 **복구 시간**입니다. 그래서 주기적으로 "데이터가 로그를 따라잡았음"을 선언하고 로그를 비웁니다. 순서가 전부입니다. **데이터 fsync가 먼저, 로그 truncate가 나중.** 반대로 하면 "로그는 버렸는데 데이터는 안 내려간" 구멍이 생깁니다.

> **실무/면접 포인트**: PostgreSQL 튜닝의 `max_wal_size`·`checkpoint_timeout`이 중요한 이유가 정확히 이 트레이드오프다. 체크포인트를 자주 하면 복구가 빠르지만 flush I/O가 몰리고, 드물게 하면 런타임은 가볍지만 복구가 길어진다. **"no-force가 만든 빚(로그)을 언제 갚느냐"** 로 이해하면 그 파라미터들이 한 줄로 꿰인다.

이 트레이드오프는 운영 로그에서 실물로 만납니다. PostgreSQL이 `LOG: checkpoints are occurring too frequently (9 seconds apart)` 를 찍고 있다면, 쓰기 부하가 `max_wal_size`를 계속 뚫어 체크포인트가 강제로 앞당겨지고 있다는 신호입니다.

여기까지로 db-hobby는 진짜 DB와 같은 **(steal, no-force)** 사분면에 도착했습니다. 커밋 = 순차 로그 하나에 fsync 한 번. 데이터 페이지 수십 개에 무작위 fsync 하던 시절과 구조적으로 다릅니다.

## 7. 진짜 ARIES와의 거리: 정직한 경계

위 구현은 **ARIES의 발상**을 미니 DB 규모로 옮긴 것이지, 교과서 ARIES 그대로가 아닙니다. 그리고 "진짜 DB"의 복구도 하나가 아닙니다. 흔히 "PostgreSQL·InnoDB는 ARIES 계열"로 뭉뚱그리는데, 그것부터 부정확합니다. **교과서 ARIES에 가장 가까운 건 SQL Server**(Analysis→Redo→Undo 3-패스, CLR)고, **InnoDB가 그다음**(redo 로그로 재적용 + undo log로 미커밋 롤백)이며, **PostgreSQL은 ARIES가 아닙니다.** 복구가 redo 단일 패스로 끝나고, undo 패스도 CLR도 없습니다. 미커밋 데이터의 뒤처리는 복구가 아니라 MVCC(힙의 옛 버전 + clog 가시성 판정)와 VACUUM의 몫입니다(3절의 상자). 복구 아키텍처를 나란히 놓으면:

| | db-hobby | PostgreSQL | InnoDB | SQL Server |
|---|---|---|---|---|
| 로깅 단위 | 페이지 **전체** (물리) | physiological WAL 레코드 (+ 체크포인트 후 첫 수정 시 FPI) | physiological redo + 별도 undo log | physiological |
| pageLSN | 없음 | 있음 | 있음 | 있음 |
| 복구 패스 | redo/undo 2-패스 | **redo 단일 패스** | redo 후 undo log로 미커밋 롤백 | Analysis → Redo → Undo 3-패스 |
| 미커밋 잔재 처리 | before-image로 undo | MVCC 옛 버전 + VACUUM (복구 밖에서) | undo log 롤백 | Undo 패스 |
| CLR (보상 로그) | 없음 | 없음 (undo 패스 자체가 없음) | 유사 장치 | 있음 |

여기서 중요한 통찰이 하나 있습니다. **pageLSN과 CLR이 "없어도 되는" 이유가 있습니다.** db-hobby는 페이지 전체를 물리 로깅하므로 redo가 **멱등(idempotent)**입니다. 전체 페이지를 덮어쓰는 건 몇 번을 해도 같으니까, "이 페이지에 이 로그가 이미 적용됐나"를 판정하는 pageLSN이 필요 없고, undo 도중 재크래시해도 같은 undo를 다시 하면 그만이라 CLR도 필요 없습니다. 진짜 DB는 로그를 작게 하려고 physiological 로깅을 쓰고, **그래서** pageLSN이 필요해집니다. 전체 페이지 덮어쓰기가 아니니 redo의 멱등성이 공짜로 오지 않기 때문입니다. CLR까지 필요한지는 복구에 undo 패스가 있느냐로 갈립니다. SQL Server는 있어서 CLR이 필수고, PostgreSQL은 undo 패스 자체가 없으니 CLR도 없습니다.

> **실무/면접 포인트**: "PostgreSQL 크래시 복구엔 왜 undo 패스가 없는가?"는 steal/no-force를 제대로 이해했는지 가르는 질문입니다. 답의 뼈대는 이렇습니다. steal로 미커밋 튜플이 디스크에 남아도, MVCC 세계에선 그건 "지워야 할 오염"이 아니라 "커밋 안 된 버전"일 뿐입니다. clog에 abort로 기록되는 순간 모든 스냅샷에서 안 보이게 되고, 물리적 청소는 VACUUM이 나중에 합니다. undo를 복구 시점에 하느냐(InnoDB·SQL Server), 평상시에 게으르게 하느냐(PostgreSQL)의 차이입니다.

정직한 경계가 하나 더 있습니다. 바로 **torn page**입니다. db-hobby는 "페이지 쓰기는 통째로 되거나 통째로 안 된다"는 원자성을 가정하지만, 실제 디스크는 페이지를 512B~4KB 섹터로 나눠 쓰다 전원이 꺼지면 **반쯤 쓰인 페이지**를 남길 수 있습니다. 실제 DB는 이걸 이중으로 방어합니다. WAL 레코드엔 CRC를 달아 로그의 유효한 끝을 판별하고, 데이터 페이지 쪽은 PostgreSQL이 `full_page_writes`(1절 상자의 FPI)로, InnoDB가 doublewrite buffer로 막습니다.

> **화물숭배 금지**: 기법은 그게 필요해지는 문제가 나타날 때 들여온다. CLR·퍼지 체크포인트·3-패스는 "이 엔진에선 불필요"를 (크래시 주입 테스트로) 증명하고 닫았다. physiological 로깅과 동시 운영이 등장하면 그때 "필요해서" 들어온다. 이 구분이 ARIES를 외우는 것과 이해하는 것의 차이다.

## 8. 정리

- **WAL 프로토콜**: 데이터보다 로그 먼저, 커밋 마커+fsync 한 줄이 내구성의 분기점. 무작위 쓰기를 순차 쓰기 하나로 바꾼다.
- **fsync는 비싸다**: 같은 5천 행이 커밋 granularity에 따라 **23배** 차이. group commit 계열 다이얼의 존재 이유.
- **STEAL/FORCE 사분면이 복구를 결정한다**: no-steal은 redo만으로 충분하지만 트랜잭션 크기가 버퍼 풀에 못 박히고, steal은 그 벽을 없애는 대신 **undo를 필연**으로 만든다.
- **no-force**: 커밋 = 로그 fsync 하나. 로그가 진실의 원천이 되고, 복구는 역사의 재생이 되며, 체크포인트가 "빚을 갚는" 장치로 필요해진다.
- **ARIES와의 거리**: 페이지 전체 물리 로깅이라 redo가 멱등 → pageLSN·CLR이 불필요. physiological 로깅으로 가면 pageLSN이 "필요해서" 들어온다. 그리고 진짜 DB의 복구도 하나가 아니다. SQL Server는 교과서 ARIES, InnoDB는 redo+undo log, **PostgreSQL은 redo 단일 패스**(미커밋 뒤처리는 MVCC·VACUUM의 몫).

이제 크래시엔 안 깨집니다. 다음 문제는 **동시에 여럿이 쓸 때**입니다. 잠금이냐 버전이냐, 2PL에서 MVCC 스냅샷 격리까지.

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

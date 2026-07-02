---
title: 'FORCE를 버리다 — 커밋은 로그 fsync 하나로, WAL은 진실의 원천으로'
titleEn: 'Dropping FORCE — One Log Fsync per Commit, and the WAL Becomes the Source of Truth'
description: "14편에서 steal을 심었지만 커밋 정책은 그대로 FORCE였다 — 커밋마다 모든 dirty 페이지를 데이터 파일에 쓰고 fsync하고, 로그는 매번 버렸다. 이번 편은 그 반쪽을 마저 넘는다. 커밋의 내구성 지점을 '로그 fsync 하나'로 줄이는 no-force로 옮기면, 세 가지가 연쇄로 필요해진다: ① 로그를 커밋마다 못 자르니 복구가 다중 트랜잭션 로그를 커밋 순서대로 redo해야 하고, ② 롤백은 로그에서 '내 트랜잭션 구간'만 되돌려야 하며, ③ 무한히 자라는 로그를 체크포인트가 잘라야 한다. 전부 db-hobby 코드로 심고 338개 테스트로 증명한다. 그리고 이 편의 정직한 하이라이트 — 교과서 ARIES의 핵심인 pageLSN을 '일부러 안 넣은' 이유: 페이지 전체 물리 로깅에선 redo가 idempotent라 필요가 없고, 필요 없는 기계를 이식하는 건 화물숭배다."
descriptionEn: "Part 14 grafted steal, but commit stayed FORCE — every commit wrote all dirty pages to the data file, fsynced it, and threw the log away. This part crosses the other half: moving to no-force, where a single log fsync is the commit's only durability point. Three things then become necessary in a chain: ① the log can't be truncated at commit, so recovery must redo a multi-transaction log in commit order; ② rollback must undo only 'my transaction's segment' of the log; ③ a checkpoint must trim the ever-growing log. We graft all of it into db-hobby and prove it with 338 tests. And this part's honest highlight — why we deliberately did NOT add pageLSN, the centerpiece of textbook ARIES: with whole-page physical logging, redo is idempotent, so it isn't needed — and transplanting machinery you don't need is cargo cult."
date: 2026-07-02
tags:
  - C
  - Database Internals
  - Recovery
  - WAL
  - ARIES
  - Checkpoint
  - Transaction
  - PostgreSQL
  - Learning
category: study/db-hobby
coverImage: /uploads/project/db-hobby/cover.svg
draft: false
series: "db-hobby"
seriesOrder: 15
---

## 0. 들어가며

[14편](/blog/project/db-hobby/db-hobby-14-steal-undo)에서 no-steal의 벽을 넘었어요 — dirty 페이지를 before-image 로깅과 함께 커밋 전에 내보내는 **steal**을 심어, 트랜잭션이 버퍼 풀 크기에서 풀려났죠. 그런데 그때 표의 한 칸을 일부러 남겨 뒀습니다. **커밋 정책은 여전히 FORCE** — 커밋할 때마다 모든 페이지를 디스크에 강제로 내리고 있었어요.

이번 편은 그 반쪽을 마저 넘습니다. 커밋을 **로그 fsync 하나**로 끝내는 **no-force**로 옮기고, 그 대가로 생기는 세 가지 연쇄 문제 — 상시 redo, 롤백 스코프, 로그 비대화 — 를 풉니다. 끝나면 db-hobby는 STEAL/FORCE 2×2에서 PostgreSQL·InnoDB와 같은 칸, **(steal, no-force)** 에 도착해요. 배경 이론은 [트랜잭션 ACID ④: Durability](/blog/theory/transaction-acid-04-durability) 참고.

## 1. 지금 커밋은 무엇을 하나 — FORCE의 실체

14편이 끝난 시점의 `wal_commit`은 세 단계였어요.

```c
int wal_commit(Wal *w) {
    /* 1) after-image들을 로그에 쓰고, 커밋 마커 + fsync  <- 내구성 지점 */
    /* 2) 모든 페이지를 데이터 파일에 적용하고 fsync      <- FORCE */
    /* 3) 로그를 비운다(truncate)                        <- 로그는 일회용 */
}
```

솔직하게 짚고 갈 게 있어요. 이걸 고치는 동기가 "느려서"라고 하고 싶었는데, 실측하니 이 개발 머신(macOS)에선 자동커밋 기준 **커밋당 0.273ms**였습니다. 아프긴 한데 극적이진 않아요(macOS의 `fsync`는 디스크 캐시까지 강제하지 않아서 저렴한 탓도 있습니다). 그래서 이 편의 진짜 동기는 속도가 아니라 **구조** 세 가지예요.

1. **커밋 비용이 dirty 페이지 수에 비례**한다 — 원리적으로 트랜잭션이 클수록 커밋이 느려지는 모델.
2. **로그를 커밋마다 버린다** — WAL이 "일어난 일의 기록"이 아니라 커밋 한 번 쓰고 버리는 임시 버퍼. 진짜 DB의 WAL은 복제·PITR·감사까지 받치는 **진실의 원천(source of truth)** 인데, 우리 건 그게 아니었어요.
3. **다음 목표들의 전제**다 — 퍼지 체크포인트·3-패스 복구([16편 예고](#8-정리--그리고-다음-편)), 그리고 [13편](/blog/project/db-hobby/db-hobby-13-mvcc)이 남긴 진짜 동시 MVCC 모두 "로그가 계속 쌓이고 데이터는 게으르게 따라가는" 모델을 전제합니다.

14편의 STEAL/FORCE 표를 다시 보면, 우리는 지금 한 칸만 남았어요.

| | FORCE (커밋 시 전부 flush) | NO-FORCE (커밋 시 로그만) |
|---|---|---|
| **NO-STEAL** | ~13편의 db-hobby | — |
| **STEAL** | **14편의 db-hobby** ← 지금 여기 | **PostgreSQL·InnoDB** ← 이번 편의 목표 |

## 2. no-force — 커밋을 로그 fsync 하나로

원리는 단순해요. **내구성은 로그가 책임진다.** after-image가 로그에 fsync됐다면, 데이터 파일이 크래시로 못 따라왔어도 복구가 로그에서 다시 적용(redo)하면 되니까요. 그럼 커밋은 로그 fsync에서 끝나도 됩니다.

```c
int wal_commit(Wal *w) {
    /* 1) after-image + 커밋 마커를 로그에 쓰고 fsync — 유일한 내구성 지점(no-force) */
    ...
    fsync(w->log_fd);
    w->flushed_lsn = w->next_lsn - 1;

    /* 2) 데이터 파일에 반영은 하되 fsync하지 않는다 — 내구성은 로그가 책임.
     *    크래시가 나도 복구의 redo가 로그에서 재적용한다. */
    for (int i = 0; i < w->num_staged; i++)
        pager_write(&w->data, s[i].page_id, s[i].data);

    /* 3) 로그는 자르지 않는다 — 커밋 이력이 곧 진실의 원천. */
    ...
}
```

여기서 db-hobby다운 절충을 하나 했어요. 교과서의 no-force는 페이지를 커밋 때 **아예 안 씁니다** — 버퍼 풀에 dirty로 뒀다가 축출·체크포인트 때만 내리죠. db-hobby는 **파일에 write-back은 하되 `fsync`만 안 하는** 쪽을 골랐습니다(OS 페이지 캐시에 얹힘). 내구성 관점에선 똑같이 no-force예요 — 안정 저장소를 보장하는 fsync는 로그에만 하니까. 대신 이 절충 덕에 "디스크(캐시)에서 읽으면 = 최신 커밋본"이라는 불변식이 유지돼서, **14편 steal의 before-image 캡처(디스크에서 읽기), 버퍼 풀, 트랜잭션 코드를 한 줄도 안 바꿨습니다.** 기능 하나를 심을 때 건드리는 표면적을 최소로 — 13편에서 배운 교훈의 실천이에요.

그런데 3)에서 멈칫하셨을 거예요. **로그를 안 자른다고?** 여기서부터 연쇄가 시작됩니다.

## 3. 연쇄 1 — 로그에 역사가 쌓인다: 복구는 역사를 반복한다

커밋마다 로그를 자르던 시절엔, 로그엔 언제나 **마지막 한 트랜잭션**만 있었어요. 이제 로그엔 커밋 이력이 순서대로 쌓입니다: `[커밋1][커밋2][커밋3][...미완의 꼬리?]`. 복구가 완전히 달라져야 해요.

```c
/* Pass 1: 커밋 구간마다 after-image를 '커밋 순서대로' 재적용(redo) */
for (each record) {
    if (type == REC_PAGE)   { redo 버퍼에 수집; }
    if (type == REC_COMMIT) {
        for (수집한 after-image들) pager_write(...);  /* 이 구간은 커밋됨 -> redo */
        loser_start = 현재 오프셋;                     /* 커밋 마커 직후를 기억 */
    }
}
/* Pass 2: 마지막 커밋 뒤의 꼬리 = 미완(loser) -> before-image로 undo + 새 페이지 truncate */
```

핵심은 **커밋 순서 그대로 반복**한다는 것 — 복구는 "역사의 재생"입니다. 같은 페이지를 커밋1이 쓰고 커밋3이 또 썼어도, 순서대로 덮어쓰면 마지막 상태가 정확히 나와요. 그리고 복구가 끝나면 데이터를 fsync하고 로그를 비웁니다. 즉 **"DB를 여는 것 자체가 체크포인트"** 예요.

14편에서 만든 undo는 그대로 pass 2가 됩니다 — 마지막 커밋 마커 뒤에 남은 꼬리(steal된 미커밋 변경)만 before-image로 되돌리고, 그 트랜잭션이 할당한 새 페이지는 잘라내요. redo와 undo가 "구간"으로 자연스럽게 나뉘는 구조입니다.

## 4. 연쇄 2 — 롤백은 이제 '내 구간'만 되돌린다

로그가 일회용이던 시절, `ROLLBACK`의 undo는 로그를 **처음부터** 훑으면 됐어요 — 로그 전체가 곧 내 트랜잭션이었으니까. 이제는 로그 앞부분에 **남의(앞선 트랜잭션들의) 커밋 이력**이 있습니다. 그걸 건드리면 안 돼요.

```c
void wal_begin(Wal *w) {
    ...
    /* 내 트랜잭션의 기록은 여기부터 — 롤백(undo)이 이 오프셋부터만 훑는다. */
    w->txn_log_start = lseek(w->log_fd, 0, SEEK_END);
}

int wal_undo(Wal *w) {
    /* 로그 앞부분은 앞선 트랜잭션들의 커밋 이력(no-force) — 내 것만 훑는다. */
    lseek(w->log_fd, w->txn_log_start, SEEK_SET);
    ... before-image 원복 + 새 페이지 truncate ...
    /* 아보트한 내 기록만 잘라낸다 — 앞선 커밋 이력은 보존(진실의 원천). */
    ftruncate(w->log_fd, w->txn_log_start);
}
```

트랜잭션을 시작할 때 **로그 끝 오프셋을 기억**해 두고, 롤백은 거기서부터만 undo하고 거기로 로그를 되돌립니다. 커밋 이력은 그대로 — 크래시가 나도 복구의 pass 1이 그 이력을 재생해 줍니다.

## 5. 연쇄 3 — 로그가 무한히 자란다: 체크포인트

로그가 진실의 원천이 되면 새 문제가 생겨요. **안 자르면 무한히 자랍니다.** 디스크도 문제지만 더 아픈 건 **복구 시간** — 로그가 길수록 재생할 역사가 길어져요. 그래서 주기적으로 "데이터 파일이 로그를 따라잡았음"을 선언하고 로그 앞부분을 버리는 **체크포인트**가 필요합니다.

db-hobby의 첫 체크포인트는 단순하게:

```c
/* 커밋 끝에서: 로그가 임계(4MB)를 넘으면 체크포인트 */
if (lseek(w->log_fd, 0, SEEK_END) > (off_t)WAL_CHECKPOINT_BYTES) {
    fsync(w->data.fd);        /* 데이터가 로그를 따라잡았음을 내구화 */
    ftruncate(w->log_fd, 0);  /* 이제 로그 앞부분은 필요 없다 */
}
```

순서가 전부예요 — **데이터 fsync가 먼저, 로그 truncate가 나중.** 반대로 하면 크래시 시 "로그는 버렸는데 데이터는 안 내려간" 구멍이 생깁니다. 3절의 "여는 것 자체가 체크포인트"(복구 끝의 fsync+truncate)와 합치면, 로그 수명은 "한 세션 안에서 최대 4MB"로 묶여요.

> **실무/면접 포인트**: PostgreSQL 튜닝에서 `max_wal_size`·`checkpoint_timeout`이 중요한 이유가 정확히 이 트레이드오프입니다. 체크포인트를 자주 하면 → 복구가 빠르지만 데이터 flush I/O가 몰리고, 드물게 하면 → 런타임은 가볍지만 WAL이 커지고 복구가 길어져요. "no-force가 만든 빚(로그)을 언제 갚느냐"의 문제로 이해하면 그 파라미터들이 전부 한 줄로 꿰집니다.

db-hobby의 체크포인트는 커밋 끝의 조용한 순간에 하니 사실상 stop-the-world인데 단일 스레드라 공짜입니다. 진짜 DB는 돌아가는 도중에 찍어야 해서 **퍼지(fuzzy) 체크포인트**(dirty page table + active txn 스냅샷)가 필요하고 — 그게 16편이에요.

## 6. pageLSN을 넣지 *않은* 이유 — 정직한 생략

교과서 ARIES를 아는 분이라면 물을 거예요. "**pageLSN은 어디 갔죠?**" 페이지마다 '마지막으로 반영된 로그 LSN'을 새겨 두고, redo가 `pageLSN < recLSN`일 때만 재적용하는 그 장치요. 14편 기획 때는 넣을 계획이었는데, 구현하면서 **일부러 뺐습니다.**

이유는 로깅 단위에 있어요. 진짜 ARIES의 **physiological 로깅**은 "페이지 5의 슬롯 3에 X를 삽입"처럼 **연산**을 기록합니다. 이미 삽입된 페이지에 또 삽입하면 데이터가 깨지니, "이 페이지에 이 로그가 이미 반영됐나"를 반드시 판정해야 하고 — 그게 pageLSN이 **정확성에 필수**인 이유예요. 반면 db-hobby는 **페이지 전체를 물리 로깅**합니다. 같은 after-image를 몇 번을 덮어써도 결과가 같아요(idempotent). 커밋 순서만 지키면 판정 자체가 필요 없습니다.

| | 페이지 전체 물리 로깅 (db-hobby) | physiological 로깅 (진짜 ARIES) |
|---|---|---|
| 로그 레코드 크기 | 페이지 통째(4KB+) — 크다 | 연산+데이터 — 작다 |
| redo 재적용 | 몇 번이든 안전 (idempotent) | 중복 적용 시 깨짐 |
| pageLSN | **불필요** | **필수** (반영 여부 판정) |
| 얻는 것 | 단순함 | 로그 크기·성능 |

즉 pageLSN은 "ARIES니까 넣는 부품"이 아니라 **physiological 로깅의 대가로 필요해지는 부품**이에요. 우리는 로그 크기를 대가로 치르고 단순함을 샀으니, pageLSN 없이도 안전합니다. 필요 없는 기계를 모양만 이식하는 건 화물숭배(cargo cult)죠. 언젠가 로그를 physiological로 줄이는 편을 쓰게 되면, 그때 pageLSN이 "진짜 필요해서" 등장할 겁니다 — 그게 이 시리즈가 지키려는 서사예요: **모든 장치는 자기를 필요하게 만든 문제와 함께 등장한다.**

아래 그림이 이번 편 전체 흐름입니다 — 커밋마다 로그에 구간이 쌓이고, 크래시 복구는 커밋 구간을 순서대로 redo한 뒤 꼬리만 undo하며, 체크포인트가 로그를 자릅니다.

![no-force — 커밋은 로그 fsync 하나로 끝나고 로그에 커밋 구간이 쌓인다. 복구는 커밋 구간을 순서대로 redo하고 꼬리(loser)만 undo하며, 로그가 임계를 넘으면 체크포인트(데이터 fsync 후 로그 truncate)가 자른다](/uploads/project/db-hobby/noforce-log-checkpoint.svg)

## 7. 검증 — 새 의미론은 새 테스트로

동작이 바뀌었으니(로그가 안 잘림, 복구가 다중 구간) 기존 테스트만으론 부족해요. `test_wal`에 no-force 고유의 시나리오를 추가했습니다.

- **다중 커밋 로그 redo** — 커밋 두 개가 로그에 쌓인 채(두 번째는 데이터 적용 전) 크래시 → 재오픈이 구간들을 커밋 순서대로 재적용 → 마지막 커밋 값.
- **롤백 후 이력 보존** — 커밋 이력 위에서 steal이 일어난 트랜잭션을 롤백 → before-image로 원복되고, **앞선 커밋 이력은 로그에 그대로** → 재오픈해도 커밋 값 유지.

기존 시나리오들(14편의 큰 트랜잭션 내구성·롤백·크래시 원자성 포함)도 전부 무회귀 — **338개 테스트 / 21스위트 green**입니다. 커밋의 의미(내구성 지점)가 바뀌었는데 밖에서 보이는 행동은 그대로라는 것 자체가, WAL 규칙이 제대로 서 있다는 증거예요.

## 8. 정리 — 그리고 다음 편

| 항목 | db-hobby | 왜 (가능 / 한계) |
|---|---|---|
| no-force 커밋 (로그 fsync 하나) | O | 내구성은 로그가 책임, 페이지는 게으른 write-back |
| WAL = 진실의 원천 | O | 커밋 시 truncate 안 함, 이력 축적 |
| 다중 트랜잭션 로그 복구 | O | 커밋 구간별 redo(역사 재생) → 꼬리 undo |
| 롤백 스코프 | O | `txn_log_start`부터만 undo, 이력 보존 |
| 체크포인트 | 부분 | 크기 임계(4MB) 단순형 — 퍼지 아님 |
| pageLSN | 불필요 | 페이지 물리 로깅 = idempotent redo (정직한 생략) |
| CLR · 퍼지 체크포인트 · 3-패스 | X | 16편 |

이로써 db-hobby는 STEAL/FORCE 2×2에서 **(steal, no-force)** — PostgreSQL·InnoDB와 같은 칸에 도착했어요. [14편](/blog/project/db-hobby/db-hobby-14-steal-undo)이 "버퍼 풀보다 큰 트랜잭션"이라는 눈에 보이는 장애를 넘었다면, 이번 편은 눈에 안 보이는 **모델의 격**을 올린 편입니다 — 커밋의 내구성 지점이 로그 하나로 서고, WAL이 일회용 버퍼에서 진실의 원천이 됐어요.

다음 16편은 트랙 E의 마무리 — **CLR(undo 중 재크래시 안전)·퍼지 체크포인트·3-패스(Analysis→Redo→Undo) 정식화**. 그게 끝나면 [13편](/blog/project/db-hobby/db-hobby-13-mvcc)이 "코어 재작성 프론티어"로 남겨 둔 **진짜 동시 MVCC**의 전제(steal·abort-롤백·로그 중심 복구)가 모두 갖춰집니다.

## 참고

- [ARIES: A Transaction Recovery Method Supporting Fine-Granularity Locking and Partial Rollbacks Using Write-Ahead Logging (Mohan et al., 1992)](https://cs.stanford.edu/people/chrismre/cs345/rl/aries.pdf)
- [PostgreSQL Documentation: Reliability and the Write-Ahead Log](https://www.postgresql.org/docs/current/wal-intro.html)
- [PostgreSQL Documentation: WAL Configuration (checkpoints, max_wal_size)](https://www.postgresql.org/docs/current/wal-configuration.html)
- [The Internals of PostgreSQL: Write Ahead Logging](https://www.interdb.jp/pg/pgsql09.html)
- 본 시리즈: [트랜잭션 ACID ④: Durability](/blog/theory/transaction-acid-04-durability)
- db-hobby: [14편 steal + undo](/blog/project/db-hobby/db-hobby-14-steal-undo) · [13편 MVCC](/blog/project/db-hobby/db-hobby-13-mvcc)

<!-- EN -->

## 0. Introduction

In [Part 14](/blog/project/db-hobby/db-hobby-14-steal-undo) we broke the no-steal wall — grafting **steal**, which evicts dirty pages before commit with before-image logging, freeing transactions from the buffer-pool size. But we deliberately left one cell of the table untouched: **commit stayed FORCE** — every commit still forced all pages to disk.

This part crosses the other half. We move commit to **no-force**, where a **single log fsync** finishes it, and solve the three problems that cascade from that — always-on redo, rollback scoping, and log growth. By the end, db-hobby lands in the same STEAL/FORCE cell as PostgreSQL and InnoDB: **(steal, no-force)**. Background theory: [Transaction ACID ④: Durability](/blog/theory/transaction-acid-04-durability).

## 1. What Commit Does Today — FORCE, Concretely

At the end of Part 14, `wal_commit` had three steps.

```c
int wal_commit(Wal *w) {
    /* 1) write after-images to the log, commit marker + fsync  <- durability point */
    /* 2) apply every page to the data file and fsync it        <- FORCE */
    /* 3) truncate the log                                      <- log is disposable */
}
```

Let's be honest about motivation. I wanted to say "because it's slow," but measurement on this dev machine (macOS) showed **0.273 ms per autocommit**. Noticeable, not dramatic (macOS `fsync` doesn't force the disk cache, so it's cheap here). So the real motivation is **structural**, three ways:

1. **Commit cost scales with dirty page count** — by design, bigger transactions commit slower.
2. **The log is thrown away at every commit** — our WAL was a disposable buffer, not "the record of what happened." A real database's WAL is the **source of truth** that underpins replication, PITR, and auditing. Ours wasn't.
3. **It's the prerequisite for what's next** — the fuzzy checkpoint and 3-pass recovery ([Part 16 preview](#8-wrap-up--and-whats-next)), and the true concurrent MVCC that [Part 13](/blog/project/db-hobby/db-hobby-13-mvcc) left behind, all presume a model where the log accumulates and data follows lazily.

Revisiting Part 14's STEAL/FORCE table, only one cell remains.

| | FORCE (flush all at commit) | NO-FORCE (log only at commit) |
|---|---|---|
| **NO-STEAL** | db-hobby up to Part 13 | — |
| **STEAL** | **db-hobby at Part 14** ← we are here | **PostgreSQL, InnoDB** ← this part's goal |

## 2. No-Force — One Log Fsync per Commit

The principle is simple: **the log owns durability.** Once after-images are fsynced in the log, the data file can lag — recovery redoes from the log. So commit may end at the log fsync.

```c
int wal_commit(Wal *w) {
    /* 1) after-images + commit marker to the log, fsync — the only durability point */
    ...
    fsync(w->log_fd);
    w->flushed_lsn = w->next_lsn - 1;

    /* 2) write pages back to the data file, but do NOT fsync — the log owns
     *    durability. On crash, recovery's redo reapplies from the log. */
    for (int i = 0; i < w->num_staged; i++)
        pager_write(&w->data, s[i].page_id, s[i].data);

    /* 3) the log is NOT truncated — committed history is the source of truth. */
    ...
}
```

One db-hobby-style compromise here. Textbook no-force doesn't write pages at commit **at all** — they stay dirty in the buffer pool until eviction or checkpoint. db-hobby chose to **write them back but skip the `fsync`** (they land in the OS page cache). Durability-wise it's equally no-force — the only fsync that guarantees stable storage goes to the log. In exchange, the invariant "reading from disk(cache) = latest committed copy" survives, so **Part 14's steal (which captures before-images by reading disk), the buffer pool, and the transaction code needed zero changes.** Minimal surface per feature — Part 13's lesson, practiced.

But step 3 should make you pause. **Not truncating the log?** That's where the cascade begins.

## 3. Cascade 1 — History Piles Up: Recovery Replays History

When the log was truncated per commit, it always held **exactly one transaction**. Now committed history accumulates in order: `[commit1][commit2][commit3][...unfinished tail?]`. Recovery must change completely.

```c
/* Pass 1: for each committed segment, reapply after-images IN COMMIT ORDER (redo) */
for (each record) {
    if (type == REC_PAGE)   { collect into redo buffer; }
    if (type == REC_COMMIT) {
        for (collected after-images) pager_write(...);  /* this segment committed -> redo */
        loser_start = current offset;                    /* remember: just past the marker */
    }
}
/* Pass 2: the tail after the last commit = loser -> undo before-images + truncate new pages */
```

The crux: **replay in commit order** — recovery is "history playback." Even if commit 1 and commit 3 both wrote the same page, overwriting in order yields exactly the final state. And when recovery finishes, it fsyncs the data and empties the log — **opening the database is itself a checkpoint.**

Part 14's undo becomes pass 2 verbatim — only the tail after the last commit marker (stolen uncommitted changes) is reverted by before-images, and pages that transaction allocated are truncated. Redo and undo split naturally by segment.

## 4. Cascade 2 — Rollback Now Reverts Only "My Segment"

When the log was disposable, `ROLLBACK`'s undo could scan **from the beginning** — the whole log was my transaction. Now the front of the log holds **other (earlier) transactions' committed history**. That must not be touched.

```c
void wal_begin(Wal *w) {
    ...
    /* my transaction's records start here — undo scans only from this offset. */
    w->txn_log_start = lseek(w->log_fd, 0, SEEK_END);
}

int wal_undo(Wal *w) {
    /* the front of the log is earlier committed history (no-force) — scan mine only. */
    lseek(w->log_fd, w->txn_log_start, SEEK_SET);
    ... restore before-images + truncate new pages ...
    /* cut only my aborted records — committed history is preserved (source of truth). */
    ftruncate(w->log_fd, w->txn_log_start);
}
```

At transaction start, **remember the log-end offset**; rollback undoes from there and truncates the log back to it. Committed history stays — and if we crash, recovery's pass 1 replays it.

## 5. Cascade 3 — The Log Grows Forever: Checkpoint

Once the log is the source of truth, a new problem: **it grows without bound.** Disk is one issue; the sharper one is **recovery time** — the longer the log, the longer the history to replay. So periodically we must declare "the data file has caught up with the log" and discard the log's prefix: a **checkpoint**.

db-hobby's first checkpoint is deliberately simple:

```c
/* at the end of commit: checkpoint if the log exceeds the threshold (4MB) */
if (lseek(w->log_fd, 0, SEEK_END) > (off_t)WAL_CHECKPOINT_BYTES) {
    fsync(w->data.fd);        /* make "data caught up with the log" durable */
    ftruncate(w->log_fd, 0);  /* the log's prefix is no longer needed */
}
```

Order is everything — **data fsync first, log truncate second.** Reversed, a crash leaves a hole: log discarded, data never persisted. Combined with Section 3's "opening is a checkpoint" (recovery ends with fsync+truncate), log lifetime is bounded to "at most 4MB within a session."

> **Practical/interview note**: this trade-off is exactly why `max_wal_size` and `checkpoint_timeout` matter in PostgreSQL tuning. Frequent checkpoints → fast recovery but bursty flush I/O; rare checkpoints → light runtime but a big WAL and long recovery. Frame it as "when do you repay the debt (the log) that no-force created?" and those parameters all line up.

db-hobby checkpoints in the quiet moment at the end of commit — effectively stop-the-world, which is free in a single-threaded engine. A real database must checkpoint while running, which requires a **fuzzy checkpoint** (dirty page table + active transaction snapshot) — that's Part 16.

## 6. Why We Did NOT Add pageLSN — an Honest Omission

If you know textbook ARIES, you'll ask: "**where's pageLSN?**" — the per-page 'last applied log LSN' that lets redo reapply only when `pageLSN < recLSN`. It was in the Part 14 plan, and while implementing we **left it out on purpose.**

The reason is the logging unit. Real ARIES uses **physiological logging** — records like "insert X into slot 3 of page 5", i.e., **operations**. Applying an insert twice corrupts the page, so "has this record already been applied to this page?" must be decided — that's why pageLSN is **essential for correctness** there. db-hobby logs **whole pages physically**. Overwriting with the same after-image any number of times gives the same result (idempotent). Keep commit order, and there's nothing to decide.

| | whole-page physical logging (db-hobby) | physiological logging (real ARIES) |
|---|---|---|
| log record size | whole page (4KB+) — big | operation + data — small |
| redo reapply | safe any number of times (idempotent) | corrupts on double-apply |
| pageLSN | **unnecessary** | **essential** (applied-or-not test) |
| what you buy | simplicity | log size, performance |

So pageLSN is not "a part you add because it's ARIES" — it's **a part made necessary by the price of physiological logging.** We paid in log size and bought simplicity, so we're safe without it. Transplanting machinery you don't need, for the shape of it, is cargo cult. If this series someday shrinks the log to physiological records, pageLSN will enter **because it's genuinely needed** — which is the narrative this series tries to keep: **every mechanism arrives together with the problem that made it necessary.**

The diagram below is this part's whole flow — commits pile segments into the log, crash recovery redoes committed segments in order and undoes only the tail, and the checkpoint trims the log.

![No-force — commit ends at one log fsync and committed segments accumulate in the log. Recovery redoes committed segments in order and undoes only the loser tail; when the log exceeds the threshold, a checkpoint (data fsync, then log truncate) trims it](/uploads/project/db-hobby/noforce-log-checkpoint.svg)

## 7. Verification — New Semantics, New Tests

Behavior changed (the log persists; recovery is multi-segment), so existing tests weren't enough. `test_wal` gained no-force-specific scenarios:

- **Multi-commit log redo** — two commits piled in the log (the second not yet applied to data) then crash → reopen replays segments in commit order → the last committed value.
- **History preserved across rollback** — roll back a transaction that stole pages on top of committed history → before-images restore it, and **the earlier committed history stays in the log** → the committed value survives reopen.

All prior scenarios (including Part 14's big-transaction durability, rollback, and crash atomicity) pass unchanged — **338 tests / 21 suites green**. The fact that the *meaning* of commit (its durability point) changed while externally visible behavior didn't is itself evidence the WAL rule is standing where it should.

## 8. Wrap-up — and What's Next

| Item | db-hobby | Why (possible / limit) |
|---|---|---|
| No-force commit (one log fsync) | O | the log owns durability; pages write back lazily |
| WAL = source of truth | O | no truncate at commit; history accumulates |
| Multi-transaction log recovery | O | per-segment redo (history replay) → tail undo |
| Rollback scoping | O | undo from `txn_log_start` only; history preserved |
| Checkpoint | partial | simple size-threshold (4MB) — not fuzzy |
| pageLSN | unnecessary | whole-page physical logging = idempotent redo (honest omission) |
| CLR · fuzzy checkpoint · 3-pass | X | Part 16 |

db-hobby has now arrived at **(steal, no-force)** in the STEAL/FORCE grid — the same cell as PostgreSQL and InnoDB. Where [Part 14](/blog/project/db-hobby/db-hobby-14-steal-undo) broke a *visible* failure ("a transaction bigger than the buffer pool"), this part raised the *invisible* caliber of the model — commit's durability point stands on the log alone, and the WAL went from a disposable buffer to the source of truth.

Part 16 finishes Track E — **CLR (re-crash safety during undo), the fuzzy checkpoint, and a proper 3-pass (Analysis → Redo → Undo)**. With that done, every prerequisite of the **true concurrent MVCC** that [Part 13](/blog/project/db-hobby/db-hobby-13-mvcc) left as a "core-rewrite frontier" — steal, abort-rollback, log-centric recovery — will be in place.

## References

- [ARIES: A Transaction Recovery Method Supporting Fine-Granularity Locking and Partial Rollbacks Using Write-Ahead Logging (Mohan et al., 1992)](https://cs.stanford.edu/people/chrismre/cs345/rl/aries.pdf)
- [PostgreSQL Documentation: Reliability and the Write-Ahead Log](https://www.postgresql.org/docs/current/wal-intro.html)
- [PostgreSQL Documentation: WAL Configuration (checkpoints, max_wal_size)](https://www.postgresql.org/docs/current/wal-configuration.html)
- [The Internals of PostgreSQL: Write Ahead Logging](https://www.interdb.jp/pg/pgsql09.html)
- This series: [Transaction ACID ④: Durability](/blog/theory/transaction-acid-04-durability)
- db-hobby: [Part 14 Steal + Undo](/blog/project/db-hobby/db-hobby-14-steal-undo) · [Part 13 MVCC](/blog/project/db-hobby/db-hobby-13-mvcc)

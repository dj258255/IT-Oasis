---
title: '트랜잭션은 어떻게 동작하는가 — BEGIN / COMMIT / ROLLBACK을 직접 짓기'
titleEn: 'How Do Transactions Work? — Building BEGIN / COMMIT / ROLLBACK by Hand'
description: "관계형 DB를 C로 밑바닥부터 만든 db-hobby 시리즈 4편. WAL이 준 원자성·내구성의 원리를 SQL 레벨로 끌어올립니다. steal/force라는 버퍼 관리 정책 4분면에서 db-hobby가 고른 no-steal + 커밋 시 force가 왜 가장 단순하고 안전한지 보고, 그 정책으로 BEGIN/COMMIT/ROLLBACK을 구현합니다. 롤백 시 힙과 B+Tree 인덱스를 둘 다 원상복구해 되돌린 INSERT가 행도 인덱스 항목도 남기지 않게 하고, PostgreSQL·InnoDB(ARIES)와 표로 비교합니다."
descriptionEn: "Part 4 of db-hobby, a relational database built from scratch in C. We lift WAL's atomicity and durability up to the SQL level. In the steal/force buffer-policy quadrant we see why db-hobby's pick — no-steal + force-at-commit — is the simplest and safest, and implement BEGIN/COMMIT/ROLLBACK with it. Rollback reverts both the heap and the B+Tree index so an undone INSERT leaves neither a row nor an index entry, compared with PostgreSQL and InnoDB (ARIES) in tables."
date: 2026-05-21
tags:
  - C
  - Database Internals
  - Transactions
  - WAL
  - PostgreSQL
  - InnoDB
  - Learning
category: project/db-hobby
coverImage: /uploads/project/db-hobby/cover.svg
draft: false
series: "db-hobby"
seriesOrder: 4
---

## 0. 들어가며 — WAL의 원리를 SQL로 끌어올리기

[3편](/blog/project/db-hobby/db-hobby-3-index-wal)에서 WAL로 원자성·내구성의 *원리*를 손에 넣었어요 — 로그 먼저, 커밋 마커, 그 다음 데이터, 크래시 땐 마커 유무로 redo/버림(자세한 복습은 3편에).

그런데 거기까지는 "페이지 한 묶음을 원자적으로 디스크에 박는" 저수준 기계였어요. 사용자가 실제로 쓰는 건 SQL이죠. 이번 편은 그 원리를 **SQL 레벨에서 쓸 수 있게 묶습니다** — 여러 변경을 한 단위로 묶어 전부 확정(`COMMIT`)하거나 전부 되돌리는(`ROLLBACK`) 것, 즉 트랜잭션입니다.

> **핵심 사실**: 트랜잭션의 원자성·내구성을 어떻게 구현하느냐는, 결국 **버퍼 풀을 언제 디스크에 쓰느냐**의 문제로 귀결된다. 그래서 BEGIN/COMMIT/ROLLBACK을 짓기 전에 "버퍼 관리 정책"부터 정해야 한다.

## 1. 버퍼 관리 정책 — steal/force라는 네 갈래

교과서는 트랜잭션의 버퍼 관리를 두 축으로 가릅니다. 둘 다 "버퍼 풀의 dirty 페이지를 언제 디스크로 내보내느냐"에 대한 질문이에요.

> **steal**: 커밋 *전*에 dirty 페이지를 디스크로 내보낼 수 있나? 가능하면(steal) 메모리는 아끼지만, 커밋 안 된 변경이 디스크에 박히니 롤백·크래시 때 **undo**(되돌리기)가 필요하다.

> **force**: 커밋 *시점*에 그 트랜잭션의 dirty 페이지를 **데이터 파일까지** 반드시 기록하나? force면 커밋 직후 데이터 파일이 최신이라 redo가 필요 없지만 random write가 많아 느리다. no-force면 빠르지만 크래시 후 **redo**(재적용)가 필요하다. (내구성 자체는 force가 아니라 WAL+`fsync`만으로도 확보된다 — force는 "데이터 파일까지 언제 따라잡나"의 문제다.)

두 축을 곱하면 네 분면이 나오고, 각 칸이 "undo가 필요한가 / redo가 필요한가"를 결정합니다.

| | **force** (커밋 시 다 flush) | **no-force** (나중에 flush) |
|---|---|---|
| **no-steal** (커밋 전 안 내보냄) | undo X, redo X — 가장 안전·단순, **가장 느림** | undo X, redo O — **db-hobby** |
| **steal** (커밋 전 내보냄) | undo O, redo X | undo O, redo O — **PostgreSQL·InnoDB**, 가장 빠름 |

양 극단을 보면 트레이드오프가 분명해져요.

**no-steal + force**는 가장 안전하고 단순합니다 — 커밋 안 된 건 디스크에 없으니(undo 불필요), 커밋하면 다 디스크에 있으니(redo 불필요) 양쪽 로그가 다 필요 없어요. 대신 끔찍하게 느립니다. 커밋마다 그 트랜잭션의 모든 dirty 페이지를 흩어진 위치에 random write로 강제 flush해야 하고, 큰 트랜잭션은 버퍼 풀에 통째로 들고 있어야 하니 메모리도 터져요.

정반대인 **steal + no-force**는 가장 빠릅니다 — 메모리가 빠듯하면 커밋 전이라도 페이지를 내보내고(steal), 커밋은 로그만 적고 데이터 적용은 나중으로 미뤄요(no-force). 그래서 InnoDB·PostgreSQL 같은 진짜 DB가 이걸 쓰는데, 대가로 **undo와 redo 로그가 둘 다** 필요합니다. 크래시 후 "커밋 안 됐는데 디스크에 새어나간 변경"을 undo하고 "커밋됐는데 아직 데이터에 없는 변경"을 redo해야 하니까요 — 이 둘을 정교하게 엮은 게 그 유명한 **ARIES** 알고리즘이에요.

> **실무/면접 포인트**: "거의 모든 현대 DB는 왜 steal + no-force를 쓰나?"의 답은 **성능**입니다. steal이 없으면 버퍼 풀보다 큰 트랜잭션을 못 돌리고, no-force가 없으면 매 커밋마다 무차별 random I/O가 터져요. 대신 그 자유의 값으로 undo·redo를 둘 다 갖춰야 하고, 그 복구 표준이 ARIES입니다. 이 steal/force 4분면은 [트랜잭션 ACID ①: Atomicity](/blog/theory/transaction-acid-01-atomicity)에서 PostgreSQL·InnoDB·SQL Server 기준으로 더 깊이 다뤄요.

## 2. db-hobby의 선택 — no-steal + WAL redo

db-hobby는 그 4분면에서 학습용으로 **no-steal(커밋 시 force) + WAL redo**를 골랐어요. 진짜 DB가 가는 steal + no-force의 정반대 코너입니다. 왜 일부러 "가장 느린" 코너를 골랐을까요? — **복잡도를 절반 들어내려고**요.

no-steal로 커밋 전 dirty 페이지를 [1편 버퍼 풀](/blog/project/db-hobby/db-hobby-1-storage)에 묶어 두면, "디스크에 샌 미완성 변경"이 아예 없습니다. 그러니 **undo 로그를 만들 필요가 없어요.** ARIES의 절반(undo phase·rollback segment·before-image)을 통째로 들어낸 셈이에요.

대신 force로 매 커밋마다 무차별 flush하는 대신, [3편 WAL](/blog/project/db-hobby/db-hobby-3-index-wal)로 redo만 합니다 — 로그에 먼저 적고, 커밋 마커를 찍고(`fsync`), 그 다음 데이터에 적용. 정확히는 "커밋 시 그 트랜잭션의 변경을 WAL에 force-flush하되, 데이터 파일 적용은 같은 커밋 안에서 순서대로" 하는 구조라, 표의 `no-steal` 행에 앉되 redo의 이점(로그만 fsync하면 내구)을 빌려옵니다. 그래서 db-hobby는 교과서적인 force/no-force 어느 쪽에도 딱 안 들어가요 — 정통 force 구현은 아니지만 데이터 적용을 같은 커밋 흐름 안에서 끝내므로, 여기서는 force 쪽 성격에 가깝게 봅니다.

> **주의 — no-steal의 값**: 큰 트랜잭션이 버퍼 풀 용량을 넘으면 못 받습니다(커밋 전엔 한 페이지도 못 내보내니까). 진짜 DB가 steal을 쓰는 바로 그 이유예요. 하지만 학습용으로는 "undo 없이 WAL의 본질(redo로 원자·내구)만" 또렷하게 보여주기에 이 조합이 딱이었어요. 코드가 복잡해질수록 정작 배우려는 원리가 가려지니까요.

| | db-hobby | PostgreSQL·InnoDB |
|---|---|---|
| 정책 | no-steal + 커밋 시 force | steal + no-force |
| 미커밋 변경이 디스크에 | 안 감 (버퍼 풀에 묶임) | 갈 수 있음 |
| undo 로그 | **불필요** | 필요 |
| redo | WAL로 | WAL로 |
| 롤백 방식 | dirty 버리고 truncate | undo 역재생(InnoDB) / 가시성 규칙(PG) |
| 한계 | 버퍼 풀보다 큰 트랜잭션 X | (없음) |

## 3. BEGIN / COMMIT / ROLLBACK — 세 명령 구현

이 정책 위에서 세 명령을 짓습니다. 핵심은 세 명령이 전부 "버퍼 풀의 no-steal을 켜고/끄고, dirty 페이지를 WAL로 보내거나 버리는" 일로 환원된다는 거예요.

- **`BEGIN`** — 모든 테이블의 버퍼 풀에 no-steal을 켜고, 롤백에 대비해 현재 파일 페이지 수를 스냅샷해 둡니다(트랜잭션이 새로 할당한 페이지를 나중에 잘라내려고). 이게 켜진 뒤로는 INSERT를 아무리 여러 번 해도 그 변경이 **아직 확정되지 않고** 버퍼 풀 안에만 머물러요 — `COMMIT`을 만나야 비로소 WAL을 거쳐 디스크에 반영됩니다. 그래서 BEGIN이 "지금부터 한 묶음"의 경계가 돼요.
- **`COMMIT`** — 트랜잭션 동안 메모리에 쌓인 dirty 데이터 페이지를 [3편 WAL](/blog/project/db-hobby/db-hobby-3-index-wal)에 stage -> `wal_commit`(로그+커밋 마커+`fsync` -> 데이터 적용 -> 로그 비움)으로 **원자적으로** 확정합니다. 여러 문장을 묶었어도 커밋 마커 하나로 전부 또는 전무가 돼요.
- **`ROLLBACK`** — 아무것도 로그에 안 적었으니 그냥 버리면 됩니다. dirty 프레임을 디스크에 안 쓰고 무효화하고(`bufpool_discard_dirty`), 트랜잭션이 할당했던 새 페이지를 잘라(`pager_truncate`) 파일을 BEGIN 시점으로 되돌려요.

`BEGIN`은 no-steal을 켜고 "현재 페이지 수"를 적어 둡니다. 이 스냅샷이 롤백 때 "여기까지가 트랜잭션 이전"이라는 경계가 돼요.

```c
static int exec_begin(Database *db, FILE *out) {
    db->in_txn = 1;
    for (int i = 0; i < db->num_tables; i++) {
        Table *t = &db->tables[i];
        bufpool_set_no_steal(t->bp, 1);          // 커밋 전 dirty 유출 차단
        wal_begin(&t->wal);
        t->txn_data_pages = t->wal.data.num_pages; // 롤백용 페이지 수 스냅샷
        // ... 인덱스·보조 인덱스도 동일하게 ...
    }
    return 0;
}
```

`COMMIT`은 dirty 페이지를 모아 WAL로 원자 커밋하고 no-steal을 끕니다. 데이터·인덱스가 각자의 WAL을 가지므로 각각 커밋해요.

```c
static int exec_commit(Database *db, FILE *out) {
    for (int i = 0; i < db->num_tables; i++) {
        Table *t = &db->tables[i];
        wal_flush_commit(t->bp, &t->wal);   // dirty -> WAL stage -> wal_commit
        bufpool_set_no_steal(t->bp, 0);
        // ... 인덱스·보조 인덱스도 각자의 WAL로 ...
    }
    return 0;
}
```

여기서 `wal_commit`이 [3편](/blog/project/db-hobby/db-hobby-3-index-wal)에서 만든 그 원자적 커밋이에요 — 바뀐 페이지를 로그에 쓰고(write-ahead), 커밋 마커 + `fsync`("이 줄을 지나면 내구하다"), 데이터 파일에 적용, 마지막으로 로그를 비웁니다(체크포인트). 여러 INSERT/UPDATE를 묶은 트랜잭션이라도 커밋 마커는 **딱 하나**라, 마커 직전에 크래시가 나면 전부 버려지고 마커 직후면 전부 redo됩니다 — 이게 "전부 또는 전무"의 물리적 정체예요.

`ROLLBACK`은 가장 단순합니다. no-steal 덕에 로그에 아무것도 안 적혔으니, 메모리의 dirty를 버리고 늘어난 페이지를 잘라내면 끝이에요. **여기가 이 편의 핵심이에요** — undo 로그를 재생해 되돌리는 게 아니라, 애초에 디스크에 안 썼으니 메모리만 버리면 끝납니다. "undo가 왜 필요 없는가"의 답이 바로 이 한 줄이에요.

```c
static int exec_rollback(Database *db, FILE *out) {
    for (int i = 0; i < db->num_tables; i++) {
        Table *t = &db->tables[i];
        bufpool_discard_dirty(t->bp);                       // dirty를 디스크에 안 쓰고 버림
        pager_truncate(&t->wal.data, t->txn_data_pages);    // BEGIN 시점 페이지 수로 자름
        bufpool_set_no_steal(t->bp, 0);
        if (t->has_index) {
            bufpool_discard_dirty(t->index.bp);
            pager_truncate(&t->index.wal.data, t->txn_index_pages);
            btree_reload_root(&t->index);   // 루트가 분할로 바뀌었을 수 있으니 다시 읽음
            bufpool_set_no_steal(t->index.bp, 0);
        }
        // ... 보조 인덱스도 동일하게 ...
    }
    return 0;
}
```

## 4. 핵심 — 힙과 B+Tree 인덱스를 둘 다 되돌린다

롤백 코드에서 가장 중요한 건 **힙(데이터)과 B+Tree 인덱스를 둘 다 원상복구한다**는 점이에요. 한쪽만 되돌리면 일관성이 깨집니다.

생각해 보면 분명해요. 롤백한 `INSERT`가 행만 지우고 인덱스 항목을 남기면, 그 인덱스가 **빈 자리를 가리키는** 댕글링 포인터가 돼요 — 인덱스로 조회하면 있지도 않은 행이 나오는 셈이죠. 그래서 데이터 버퍼 풀뿐 아니라 인덱스 버퍼 풀도 같이 discard하고, 인덱스 파일도 BEGIN 시점으로 truncate합니다.

한 가지 더 까다로운 게 있어요. 트랜잭션 도중 INSERT가 B+Tree 노드를 **분할**시켜 루트가 바뀌었을 수 있습니다. 그 새 루트 페이지는 방금 truncate로 사라졌으니, 메모리에 들고 있던 루트 포인터는 무효예요. 그래서 `btree_reload_root`로 메타 페이지에서 루트를 **다시 읽어 옵니다**.

![db-hobby 트랜잭션 세션 — BEGIN 후 INSERT한 lee를 ROLLBACK하면 SELECT에 1행(kim)만 남는다](/uploads/project/db-hobby/txn-session.svg)

`BEGIN`으로 시작해 `lee`를 넣고 `ROLLBACK`하니, `SELECT`에는 `kim` 한 줄만 남습니다. `lee`는 행도 인덱스도 흔적 없이 사라졌어요 — **원자성(A)이 동작한 것**입니다. 행 하나를 넣는 단순한 동작이지만, 그 뒤에서 데이터 힙·기본 인덱스·보조 인덱스 세 파일이 동시에 BEGIN 시점으로 되감겼어요.

## 5. db-hobby에 없는 것 — 격리(I)

여기서 솔직하게 짚고 갈 게 있어요. ACID 네 글자 중 이번 편으로 우리가 만든 건 **A(원자성)** 와 **D(내구성)** 입니다.

| ACID | db-hobby가 구현했나 | 어떻게 |
|---|---|---|
| **A** 원자성 | O | no-steal + WAL: 커밋 마커 하나로 전부 또는 전무 |
| **C** 일관성 | △ | A·I·D가 받쳐주면 따라오지만 일관성의 전부는 아님 — 제약조건·외래키·CHECK·트리거·애플리케이션 규칙까지 포함하는 개념이라 db-hobby는 NOT NULL 등 일부만 본다 |
| **I** 격리 | **X** | 단일 스레드 — 동시 트랜잭션 자체가 없음 |
| **D** 내구성 | O | WAL `fsync` + 마커 이후 redo |

빠진 건 **I(격리, Isolation)** 예요. db-hobby는 한 번에 한 트랜잭션만 도는 단일 스레드라, 동시 트랜잭션이 서로를 어떻게 보느냐는 문제 자체가 없습니다.

> **주의**: 진짜 DB는 바로 이 I에서 가장 복잡해집니다 — MVCC(다중 버전), 스냅샷 격리, 락, 그리고 dirty read·non-repeatable read·phantom 같은 이상현상을 격리 수준으로 막는 일. 우리가 안 만든 그 절반이 사실 DB 엔지니어링에서 가장 어려운 부분이에요. 이 시리즈 후반([11편 격리](/blog/project/db-hobby/db-hobby-11-isolation)·[13편 MVCC](/blog/project/db-hobby/db-hobby-13-mvcc))에서 락과 MVCC로 격리에 도전하는데, 거기서 "no-steal로 단순하게 짠 이 코어"가 동시 MVCC와 정면충돌하는 벽을 만납니다 — 즉 격리는 위에 끼워넣는 기능이 아니라 처음부터 그걸 위해 설계해야 하는 토대예요.

> **더 깊이, ACID 네 글자 전부**: [① Atomicity는 어떻게 구현되는가](/blog/theory/transaction-acid-01-atomicity)(PostgreSQL의 append-only MVCC vs InnoDB의 in-place + Undo Log — 우리가 안 만든 undo가 여기 나와요) · [② Isolation](/blog/theory/transaction-acid-02-isolation)(우리가 통째로 건너뛴 격리 — 스냅샷 격리, write skew, lost update) · [③ Consistency](/blog/theory/transaction-acid-03-consistency)(ACID의 C와 CAP의 C는 다른 개념) · [④ Durability](/blog/theory/transaction-acid-04-durability). 그리고 격리의 바탕이 되는 락은 [락 메커니즘의 모든 것](/blog/theory/lock-mechanisms-all), 트랜잭션과 커넥션의 실무는 [DB 커넥션 풀](/blog/theory/db-connection-pool)에서.

## 6. 정리

트랜잭션은 결국 **버퍼 풀을 언제 디스크에 쓰느냐**의 문제였어요. 그 선택이 undo·redo의 필요 여부를, 나아가 원자성·내구성의 구현 방식을 통째로 결정합니다.

- **steal/force 4분면** — undo가 필요한가(steal), redo가 필요한가(no-force)를 가르는 두 축. 진짜 DB는 성능을 위해 steal + no-force(+ ARIES)를 쓴다.
- **db-hobby는 no-steal + WAL redo** — 커밋 전 dirty를 버퍼 풀에 묶어 undo를 통째로 들어내고, redo만 WAL로. 단순함의 대가로 버퍼 풀보다 큰 트랜잭션은 못 받는다.
- **BEGIN/COMMIT/ROLLBACK** — 전부 no-steal 토글 + WAL stage/버리기로 환원된다. 커밋 마커 하나가 "전부 또는 전무"의 물리적 정체.
- **힙·인덱스 둘 다 롤백** — 한쪽만 되돌리면 인덱스가 빈 자리를 가리켜 깨진다. 분할로 바뀐 B+Tree 루트는 다시 읽어 온다.
- **A·D는 만들고 I는 비웠다** — 단일 스레드라 격리 문제가 없다. 그 절반이 DB의 가장 어려운 부분.

여기까지가 "한 테이블짜리 DB"의 완성형이에요 — 저장·SQL·인덱스·내구성·트랜잭션. 이제 저장·실행·트랜잭션까지 갖춘 이 DB 위에, [마지막 편](/blog/project/db-hobby/db-hobby-5-join-aggregate)에선 **여러 테이블을 연결하고 SQL의 표현력을 넓힙니다** — 다중 테이블, JOIN(중첩 루프·인덱스·해시), 그리고 집계(GROUP BY·HAVING)와 서브쿼리까지.

## 참고

- [PostgreSQL Documentation: Write-Ahead Logging (WAL)](https://www.postgresql.org/docs/current/wal-intro.html)
- [PostgreSQL Documentation: Reliability and the Write-Ahead Log](https://www.postgresql.org/docs/current/wal-reliability.html)
- ARIES: A Transaction Recovery Method (Mohan et al., 1992)
- 본 블로그: [트랜잭션 ACID ①: Atomicity](/blog/theory/transaction-acid-01-atomicity) · [② Isolation](/blog/theory/transaction-acid-02-isolation) · [③ Consistency](/blog/theory/transaction-acid-03-consistency) · [④ Durability](/blog/theory/transaction-acid-04-durability) · [락 메커니즘의 모든 것](/blog/theory/lock-mechanisms-all) · [DB 커넥션 풀](/blog/theory/db-connection-pool)
- [db-hobby 코드 (GitHub)](https://github.com/dj258255/db-hobby)

<!-- EN -->

## 0. Introduction — Lifting WAL's Principle Up to SQL

In [Part 3](/blog/project/db-hobby/db-hobby-3-index-wal) we built WAL and got the *principle* of atomicity and durability in hand — log first, commit marker, then data, and on a crash the marker decides redo vs discard (full refresher in Part 3).

But that was a low-level machine that "atomically pins one batch of pages to disk". What users actually use is SQL. This part **bundles that principle so it can be used at the SQL level** — grouping several changes into one unit and either committing them all (`COMMIT`) or undoing them all (`ROLLBACK`). That is a transaction.

> **Key fact**: how you implement a transaction's atomicity and durability ultimately reduces to **when you write the buffer pool to disk**. So before building BEGIN/COMMIT/ROLLBACK, we must settle the "buffer management policy" first.

## 1. Buffer Management Policy — the steal/force Quadrant

The textbook splits transaction buffer management along two axes. Both ask "when do you flush the buffer pool's dirty pages to disk?".

> **steal**: can a dirty page be flushed to disk *before* commit? If yes (steal), you save memory, but uncommitted changes land on disk, so rollback/crash needs **undo**.

> **force**: at commit *time*, are that transaction's dirty pages necessarily written **all the way to the data file**? With force, the data file is current right after commit so no redo is needed, but it is slow due to scattered random writes. With no-force it is fast, but a crash needs **redo**. (Durability itself is secured by WAL + `fsync` alone, not by force — force is about *when the data file catches up*.)

Multiply the two axes and you get four quadrants, each cell deciding "is undo needed / is redo needed".

| | **force** (flush all at commit) | **no-force** (flush later) |
|---|---|---|
| **no-steal** (don't flush before commit) | undo X, redo X — safest/simplest, **slowest** | undo X, redo O — **db-hobby** |
| **steal** (flush before commit) | undo O, redo X | undo O, redo O — **PostgreSQL·InnoDB**, fastest |

Look at the extremes and the trade-off is clear.

**no-steal + force** is the safest and simplest — uncommitted changes are not on disk (no undo), and committed changes are all on disk (no redo), so neither log is needed. But it is horribly slow. Every commit must force-flush all of that transaction's dirty pages as scattered random writes, and a big transaction must be held whole in the buffer pool, so memory blows up too.

The opposite, **steal + no-force**, is the fastest — when memory is tight you can evict pages even before commit (steal), and commit only writes the log and defers data application (no-force). That is why real DBs like InnoDB and PostgreSQL use it, at the cost of needing **both undo and redo logs**. After a crash you must undo "uncommitted changes that leaked to disk" and redo "committed changes not yet in the data" — the elaborate weaving of those two is the famous **ARIES** algorithm.

> **Practical/interview note**: the answer to "why does nearly every modern DB use steal + no-force?" is **performance**. Without steal you cannot run a transaction larger than the buffer pool; without no-force every commit triggers indiscriminate random I/O. The price of that freedom is needing both undo and redo, and ARIES is the recovery standard for it. This steal/force quadrant is covered more deeply, against PostgreSQL/InnoDB/SQL Server, in [Transaction ACID ①: Atomicity](/blog/theory/transaction-acid-01-atomicity).

## 2. db-hobby's Choice — no-steal + WAL redo

In that quadrant db-hobby chose, for learning, **no-steal (force at commit) + WAL redo** — the opposite corner from the steal + no-force that real DBs take. Why deliberately pick the "slowest" corner? — to **lift out half the complexity**.

With no-steal, dirty pages are pinned in the [Part 1 buffer pool](/blog/project/db-hobby/db-hobby-1-storage) before commit, so there is no "half-finished change leaked to disk" at all. Hence **you do not need an undo log**. That excises half of ARIES (the undo phase, rollback segments, before-images) wholesale.

And instead of force-flushing indiscriminately on every commit, we do only redo with the [Part 3 WAL](/blog/project/db-hobby/db-hobby-3-index-wal) — write to the log first, stamp the commit marker (`fsync`), then apply to data. Precisely, it "force-flushes that transaction's changes to the WAL at commit, then applies to the data file in order within the same commit", so it sits on the `no-steal` row of the table while borrowing redo's benefit (only the log needs fsync for durability). So db-hobby does not fall cleanly into the textbook force/no-force boxes — it is not a classic force implementation, but since it finishes applying to data within the same commit flow, we treat it as closer to the force side here.

> **Caveat — the price of no-steal**: a transaction larger than the buffer pool capacity cannot be served (not a single page can be evicted before commit). That is exactly why real DBs use steal. But for learning, this combo is perfect for showing "the essence of WAL (atomicity/durability via redo) with no undo" cleanly. The more complex the code gets, the more the principle you came to learn gets hidden.

| | db-hobby | PostgreSQL·InnoDB |
|---|---|---|
| Policy | no-steal + force at commit | steal + no-force |
| Uncommitted change to disk | never (pinned in buffer pool) | possible |
| undo log | **not needed** | needed |
| redo | via WAL | via WAL |
| Rollback | discard dirty + truncate | replay undo (InnoDB) / visibility rules (PG) |
| Limit | no transaction bigger than buffer pool | (none) |

## 3. BEGIN / COMMIT / ROLLBACK — Implementing the Three Commands

On top of this policy we build the three commands. The key is that all three reduce to "toggle the buffer pool's no-steal, and send dirty pages to the WAL or discard them".

- **`BEGIN`** — turn on no-steal for every table's buffer pool, and snapshot the current file page count in case of rollback (to truncate pages the transaction newly allocates). Once it is on, no matter how many times you INSERT, those changes are **not yet committed** — they stay inside the buffer pool, and only when `COMMIT` arrives do they reach disk via the WAL. So BEGIN marks "the batch starts here".
- **`COMMIT`** — stage the dirty data pages accumulated in memory during the transaction to the [Part 3 WAL](/blog/project/db-hobby/db-hobby-3-index-wal) -> commit **atomically** via `wal_commit` (log + commit marker + `fsync` -> apply to data -> clear log). Even bundling many statements, a single commit marker makes it all-or-nothing.
- **`ROLLBACK`** — since nothing was written to the log, just throw it away. Invalidate dirty frames without writing them to disk (`bufpool_discard_dirty`), and truncate the new pages the transaction allocated (`pager_truncate`) to rewind the file to the BEGIN point.

`BEGIN` turns on no-steal and records the "current page count". This snapshot becomes the "everything before here is pre-transaction" boundary at rollback time.

```c
static int exec_begin(Database *db, FILE *out) {
    db->in_txn = 1;
    for (int i = 0; i < db->num_tables; i++) {
        Table *t = &db->tables[i];
        bufpool_set_no_steal(t->bp, 1);          // block pre-commit dirty leakage
        wal_begin(&t->wal);
        t->txn_data_pages = t->wal.data.num_pages; // snapshot page count for rollback
        // ... same for index / secondary indexes ...
    }
    return 0;
}
```

`COMMIT` gathers dirty pages, commits them atomically via WAL, and turns off no-steal. Since data and index each have their own WAL, each is committed separately.

```c
static int exec_commit(Database *db, FILE *out) {
    for (int i = 0; i < db->num_tables; i++) {
        Table *t = &db->tables[i];
        wal_flush_commit(t->bp, &t->wal);   // dirty -> WAL stage -> wal_commit
        bufpool_set_no_steal(t->bp, 0);
        // ... index / secondary indexes each via their own WAL ...
    }
    return 0;
}
```

Here `wal_commit` is that atomic commit from [Part 3](/blog/project/db-hobby/db-hobby-3-index-wal) — write the changed pages to the log (write-ahead), commit marker + `fsync` ("past this line it is durable"), apply to the data file, and finally clear the log (checkpoint). Even a transaction bundling many INSERT/UPDATEs has **exactly one** commit marker, so a crash just before the marker discards everything and just after redoes everything — that is the physical identity of "all-or-nothing".

`ROLLBACK` is the simplest. Thanks to no-steal nothing was written to the log, so discarding the in-memory dirty and truncating the grown pages is all it takes. **This is the heart of this part** — we do not replay an undo log to reverse anything; since nothing was written to disk in the first place, throwing away memory is the whole job. That one line is the answer to "why no undo log is needed".

```c
static int exec_rollback(Database *db, FILE *out) {
    for (int i = 0; i < db->num_tables; i++) {
        Table *t = &db->tables[i];
        bufpool_discard_dirty(t->bp);                       // drop dirty without writing to disk
        pager_truncate(&t->wal.data, t->txn_data_pages);    // cut back to BEGIN-time page count
        bufpool_set_no_steal(t->bp, 0);
        if (t->has_index) {
            bufpool_discard_dirty(t->index.bp);
            pager_truncate(&t->index.wal.data, t->txn_index_pages);
            btree_reload_root(&t->index);   // root may have changed via a split, reread it
            bufpool_set_no_steal(t->index.bp, 0);
        }
        // ... same for secondary indexes ...
    }
    return 0;
}
```

## 4. The Core — Reverting Both the Heap and the B+Tree Index

The most important thing in the rollback code is that it **reverts both the heap (data) and the B+Tree index**. Reverting only one breaks consistency.

Think it through and it is obvious. If a rolled-back `INSERT` removes only the row but leaves the index entry, that index becomes a **dangling pointer to an empty slot** — querying via the index returns a row that does not exist. So we discard not just the data buffer pool but the index buffer pool too, and truncate the index file back to the BEGIN point.

One more tricky bit. An INSERT during the transaction may have **split** a B+Tree node and changed the root. That new root page just vanished with the truncate, so the root pointer held in memory is invalid. Hence `btree_reload_root` **rereads** the root from the meta page.

![db-hobby transaction session — after BEGIN, INSERT lee, then ROLLBACK, SELECT keeps only one row (kim)](/uploads/project/db-hobby/txn-session.svg)

Start with `BEGIN`, insert `lee`, then `ROLLBACK`, and `SELECT` keeps only the single row `kim`. `lee` vanished without a trace from both the row and the index — **atomicity (A) at work**. It is the simple act of inserting one row, but behind it three files — the data heap, the primary index, and the secondary index — were simultaneously rewound to the BEGIN point.

## 5. What db-hobby Lacks — Isolation (I)

Here is something to state honestly. Of the four ACID letters, what we built in this part is **A (atomicity)** and **D (durability)**.

| ACID | Did db-hobby build it | How |
|---|---|---|
| **A** Atomicity | O | no-steal + WAL: one commit marker = all-or-nothing |
| **C** Consistency | △ | follows when A·I·D hold, but not the whole story — consistency spans constraints, foreign keys, CHECKs, triggers, and application rules, of which db-hobby does only some (e.g. NOT NULL) |
| **I** Isolation | **X** | single-threaded — no concurrent transactions at all |
| **D** Durability | O | WAL `fsync` + redo after the marker |

What is missing is **I (Isolation)**. db-hobby is single-threaded, running one transaction at a time, so the question of how concurrent transactions see each other simply does not exist.

> **Caveat**: real DBs get most complex exactly at this I — MVCC (multi-version), snapshot isolation, locks, and blocking anomalies like dirty read, non-repeatable read, and phantom via isolation levels. That half we did not build is in fact the hardest part of DB engineering. Later in this series ([Part 11 Isolation](/blog/project/db-hobby/db-hobby-11-isolation), [Part 13 MVCC](/blog/project/db-hobby/db-hobby-13-mvcc)) we take on isolation with locks and MVCC, and there "this core written simply with no-steal" hits a wall colliding head-on with concurrent MVCC — that is, isolation is not a feature you bolt on top but a foundation you must design for from the start.

> **Deeper, all four ACID letters**: [① How Atomicity Is Implemented](/blog/theory/transaction-acid-01-atomicity) (PostgreSQL's append-only MVCC vs InnoDB's in-place + Undo Log — the undo we did not build shows up here) · [② Isolation](/blog/theory/transaction-acid-02-isolation) (the isolation we skipped entirely — snapshot isolation, write skew, lost update) · [③ Consistency](/blog/theory/transaction-acid-03-consistency) (ACID's C and CAP's C are different concepts) · [④ Durability](/blog/theory/transaction-acid-04-durability). And the locks that underpin isolation are in [Everything About Lock Mechanisms](/blog/theory/lock-mechanisms-all); the practice of transactions and connections is in [DB Connection Pool](/blog/theory/db-connection-pool).

## 6. Wrap-up

A transaction came down to **when you write the buffer pool to disk**. That choice decides whether undo/redo are needed and, in turn, the whole implementation of atomicity and durability.

- **The steal/force quadrant** — two axes deciding whether undo is needed (steal) and whether redo is needed (no-force). Real DBs use steal + no-force (+ ARIES) for performance.
- **db-hobby is no-steal + WAL redo** — pins pre-commit dirty in the buffer pool to excise undo entirely, with redo only via WAL. The price of simplicity is no transaction bigger than the buffer pool.
- **BEGIN/COMMIT/ROLLBACK** — all reduce to a no-steal toggle + WAL stage/discard. One commit marker is the physical identity of "all-or-nothing".
- **Roll back both heap and index** — reverting only one breaks things as the index points to an empty slot. A B+Tree root changed by a split is reread.
- **Built A·D, left I empty** — single-threaded, so no isolation problem. That half is the hardest part of a DB.

This is the complete form of a "single-table DB" — storage, SQL, index, durability, transactions. Now, on top of this DB that has storage, execution, and transactions, the [final part](/blog/project/db-hobby/db-hobby-5-join-aggregate) **connects multiple tables and widens SQL's expressive power** — multi-table, JOIN (nested loop, index, hash), and aggregation (GROUP BY, HAVING) and subqueries.

## References

- [PostgreSQL Documentation: Write-Ahead Logging (WAL)](https://www.postgresql.org/docs/current/wal-intro.html)
- [PostgreSQL Documentation: Reliability and the Write-Ahead Log](https://www.postgresql.org/docs/current/wal-reliability.html)
- ARIES: A Transaction Recovery Method (Mohan et al., 1992)
- This blog: [Transaction ACID ①: Atomicity](/blog/theory/transaction-acid-01-atomicity) · [② Isolation](/blog/theory/transaction-acid-02-isolation) · [③ Consistency](/blog/theory/transaction-acid-03-consistency) · [④ Durability](/blog/theory/transaction-acid-04-durability) · [Everything About Lock Mechanisms](/blog/theory/lock-mechanisms-all) · [DB Connection Pool](/blog/theory/db-connection-pool)
- [db-hobby on GitHub](https://github.com/dj258255/db-hobby)

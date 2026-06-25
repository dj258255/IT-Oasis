---
title: '트랜잭션: BEGIN / COMMIT / ROLLBACK'
titleEn: 'Transactions: BEGIN / COMMIT / ROLLBACK'
description: "관계형 DB를 C로 밑바닥부터 만든 minidb 시리즈 4편. WAL이 준 원자성·내구성의 원리를 SQL 레벨로 끌어올린다. no-steal + 커밋 시 force 정책으로 BEGIN/COMMIT/ROLLBACK을 구현하고, 롤백 시 힙과 B+Tree 인덱스를 둘 다 원상복구해 되돌린 INSERT가 행도 인덱스 항목도 남기지 않게 한다."
descriptionEn: "Part 4 of building a relational database from scratch in C. We lift WAL's atomicity/durability up to the SQL level: BEGIN/COMMIT/ROLLBACK with a no-steal + force-at-commit policy, where rollback reverts both the heap and the B+Tree index so an undone INSERT leaves neither a row nor an index entry."
date: 2026-06-22
tags:
  - C
  - Database Internals
  - Transactions
  - WAL
  - Learning
category: project/minidb
coverImage: /uploads/project/minidb/cover.svg
draft: false
series: "minidb"
seriesOrder: 4
---

[3편](/blog/project/minidb/minidb-3-index-wal)의 WAL이 원자성·내구성의 원리를 줬다. 이제 그걸 SQL 레벨에서 쓸 수 있게 묶는다 — 여러 변경을 한 단위로 묶어 전부 확정(`COMMIT`)하거나 전부 되돌린다(`ROLLBACK`).

## 버퍼 관리 정책 — steal/force라는 네 갈래

트랜잭션의 원자성·내구성을 어떻게 구현하느냐는 사실 **버퍼 풀을 언제 디스크에 쓰느냐**의 문제로 귀결된다. 교과서는 이걸 두 축으로 가른다:

- **steal** — 커밋 *전*에 dirty 페이지를 디스크로 내보낼 수 있나? 가능하면(steal) 메모리는 아끼지만, 커밋 안 된 변경이 디스크에 박히니 롤백·크래시 때 **undo**(되돌리기)가 필요하다.
- **force** — 커밋 *시점*에 그 트랜잭션의 모든 변경을 디스크로 강제하나? force면 커밋 즉시 내구성이 보장되지만 random write가 많아 느리다. no-force면 빠르지만 크래시 후 **redo**(재적용)가 필요하다.

네 조합 중 양 극단을 보면 트레이드오프가 분명해진다. **no-steal + force**는 가장 안전하고 단순하다 — 커밋 안 된 건 디스크에 없고(undo 불필요), 커밋하면 다 디스크에 있다(redo 불필요). 대신 끔찍하게 느리다. 커밋마다 그 트랜잭션의 모든 dirty 페이지를 흩어진 위치에 random write로 강제 flush해야 하고, 큰 트랜잭션은 버퍼 풀에 다 들고 있어야 하니 메모리도 터진다. 정반대인 **steal + no-force**는 가장 빠르다 — 메모리가 빠듯하면 커밋 전이라도 페이지를 내보내고(steal), 커밋은 로그만 적고 데이터 적용은 나중에 미룬다(no-force). 그래서 InnoDB·PostgreSQL 같은 진짜 DB가 이걸 쓰는데, 대가로 **undo와 redo 로그가 둘 다** 필요하다. 크래시 후 "커밋 안 됐는데 디스크에 새어나간 변경"을 undo하고 "커밋됐는데 아직 데이터에 없는 변경"을 redo해야 하니까 — 이 둘을 정교하게 엮은 게 그 유명한 **ARIES** 알고리즘이다.

minidb는 그 가운데서 학습용으로 **no-steal + WAL redo**를 골랐다. no-steal로 커밋 전 dirty 페이지를 [1편 버퍼 풀](/blog/project/minidb/minidb-1-storage)에 묶어 두면 "디스크에 샌 미완성 변경"이 아예 없으니 **undo 로그를 안 만들어도 된다.** 절반의 복잡도를 통째로 들어낸 셈이다. 대신 force는 안 하고 [3편 WAL](/blog/project/minidb/minidb-3-index-wal)로 redo만 한다 — 로그에 먼저 적고 커밋 마커를 찍은 뒤 데이터에 적용. 큰 트랜잭션이 버퍼 풀을 넘으면 못 받는다는 한계가 따라오지만(no-steal의 값), 학습용으론 "undo 없이 WAL의 본질(redo로 원자·내구)만" 보여주기에 이 조합이 딱이었다.

## BEGIN / COMMIT / ROLLBACK

이 정책으로 세 명령을 구현한다.

- **`BEGIN`** — 모든 테이블의 버퍼 풀에 no-steal을 켜고, 롤백에 대비해 현재 파일 페이지 수를 스냅샷해 둔다(트랜잭션이 새로 할당한 페이지를 나중에 잘라내기 위해).
- **`COMMIT`** — 트랜잭션 동안 메모리에 쌓인 dirty 데이터 페이지를 [3편 WAL](/blog/project/minidb/minidb-3-index-wal)에 stage -> `wal_commit`(로그+커밋 마커+`fsync` -> 데이터 적용)으로 **원자적으로** 확정한다. 여러 문장을 묶었어도 커밋 마커 하나로 전부 또는 전무가 된다.
- **`ROLLBACK`** — 아무것도 로그에 안 적었으니 그냥 버리면 된다. dirty 프레임을 디스크에 안 쓰고 무효화하고(`bufpool_discard_dirty`), 트랜잭션이 할당했던 새 페이지를 잘라(`pager_truncate`) 파일을 BEGIN 시점으로 되돌린다.

핵심은 **힙과 B+Tree 인덱스를 둘 다 되돌린다**는 것이다. 롤백한 `INSERT`가 행만 지우고 인덱스 항목을 남기면, 그 인덱스가 빈 자리를 가리켜 일관성이 깨진다. 그래서 인덱스 버퍼 풀도 같이 discard하고, B+Tree 루트는 분할로 바뀌었을 수 있으니 메타 페이지에서 다시 읽어 온다.

![minidb 트랜잭션 세션 — BEGIN 후 INSERT한 lee를 ROLLBACK하면 SELECT에 1행(kim)만 남는다](/uploads/project/minidb/txn-session.svg)

`BEGIN` 으로 시작해 `lee` 를 넣고 `ROLLBACK` 하니, `SELECT` 에는 `kim` 한 줄만 남는다. `lee` 는 행도 인덱스도 흔적 없이 사라졌다 — 원자성(A)이 동작한 것이다.

## minidb에 없는 것 — 격리(I)

ACID 중 우리가 만든 건 A(원자성)와 D(내구성)다. 빠진 건 **I(격리, Isolation)** — minidb는 한 번에 한 트랜잭션만 도는 단일 스레드라, 동시 트랜잭션이 서로를 어떻게 보느냐는 문제 자체가 없다. 진짜 DB는 여기서 가장 복잡해진다: MVCC(다중 버전), 스냅샷 격리, 락, 그리고 dirty read·non-repeatable read·phantom 같은 이상현상을 격리 수준으로 막는다. 우리가 안 만든 그 절반이 사실 DB 엔지니어링의 가장 어려운 부분이다.

> 더 깊이, ACID 네 글자 전부: [① Atomicity는 어떻게 구현되는가](/blog/theory/transaction-acid-01-atomicity)(PostgreSQL의 append-only MVCC vs InnoDB의 in-place + Undo Log — 우리가 안 만든 undo가 여기 나온다) · [② Isolation](/blog/theory/transaction-acid-02-isolation)(우리가 통째로 건너뛴 격리 — 스냅샷 격리, write skew, lost update) · [③ Consistency](/blog/theory/transaction-acid-03-consistency)(ACID의 C와 CAP의 C는 다른 개념) · [④ Durability](/blog/theory/transaction-acid-04-durability). 그리고 격리의 바탕이 되는 락은 [락 메커니즘의 모든 것](/blog/theory/lock-mechanisms-all), 트랜잭션과 커넥션의 실무는 [DB 커넥션 풀](/blog/theory/db-connection-pool)에서.

---

여기까지가 "한 테이블짜리 DB"의 완성형이다 — 저장·SQL·인덱스·내구성·트랜잭션. [마지막 편](/blog/project/minidb/minidb-5-join-aggregate)에선 테이블을 여러 개 두고 잇는다 — 다중 테이블, JOIN(중첩 루프·인덱스·해시), 그리고 집계(GROUP BY·HAVING)와 서브쿼리까지.

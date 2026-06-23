---
title: 'minidb — 트랜잭션: BEGIN / COMMIT / ROLLBACK'
titleEn: 'minidb — Transactions: BEGIN / COMMIT / ROLLBACK'
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

## BEGIN / COMMIT / ROLLBACK

구현은 **no-steal + 커밋 시 force** 정책이다. 트랜잭션 중 바뀐 페이지는 버퍼 풀 메모리에만 두고 디스크엔 안 흘린다(no-steal). `COMMIT`이면 flush + fsync 해서 확정하고, `ROLLBACK`이면 dirty 프레임을 버리고 트랜잭션이 할당한 페이지를 잘라 디스크 원본 상태로 되돌린다. 핵심은 **힙과 B+Tree 인덱스를 둘 다 되돌린다**는 것 — 그래야 롤백한 INSERT가 행도, 인덱스 항목도 남기지 않는다.

![minidb 트랜잭션 세션 — BEGIN 후 INSERT한 lee를 ROLLBACK하면 SELECT에 1행(kim)만 남는다](/uploads/project/minidb/txn-session.svg)

`BEGIN` 으로 시작해 `lee` 를 넣고 `ROLLBACK` 하니, `SELECT` 에는 `kim` 한 줄만 남는다. `lee` 는 행도 인덱스도 흔적 없이 사라졌다. (학습용이라 격리 수준·동시성 — ACID의 I — 은 없다. 한 번에 한 트랜잭션이다.)

---

여기까지가 "한 테이블짜리 DB"의 완성형이다 — 저장·SQL·인덱스·내구성·트랜잭션. [마지막 편](/blog/project/minidb/minidb-5-join-aggregate)에선 테이블을 여러 개 두고 잇는다 — 다중 테이블, JOIN(중첩 루프·인덱스·해시), 그리고 집계(GROUP BY).

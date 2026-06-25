---
title: '잠금이냐 버전이냐: 2PL과 MVCC, 격리의 두 길'
titleEn: 'Locks or Versions: 2PL and MVCC, Two Roads to Isolation'
description: "관계형 DB를 C로 밑바닥부터 만든 minidb 시리즈. 11편에서 2PL 잠금으로 격리를 만들었는데, 진짜 PostgreSQL은 잠금이 아니라 MVCC(다중 버전)를 쓴다. 같은 목표(격리)에 정반대 철학의 두 길을 나란히 놓고 본다 - 2PL은 충돌을 미리 막고(비관적, 읽기가 쓰기를 막음), MVCC는 쓰면 새 버전을 만들고 읽으면 자기 스냅샷을 봐서 충돌을 피한다(읽기가 쓰기를 안 막음). 각 방식이 dirty read·lost update·non-repeatable read를 어떻게 막는지, 그 대가가 무엇인지(교착 vs VACUUM), 그리고 minidb의 저장 구조가 왜 이미 MVCC에 맞는지까지."
descriptionEn: "Part 12 of building a relational database from scratch in C. In part 11 we built isolation with 2PL locks, but real PostgreSQL uses MVCC (multi-version) instead. We put the two opposite philosophies side by side: 2PL prevents conflicts up front (pessimistic, readers block writers), while MVCC creates a new version on write and reads from a snapshot, so it avoids conflicts (readers don't block writers). How each prevents dirty reads, lost updates, and non-repeatable reads; what each costs (deadlocks vs VACUUM); and why minidb's storage is already shaped for MVCC."
date: 2026-06-26
tags:
  - C
  - Database Internals
  - Transactions
  - Concurrency
  - MVCC
  - Learning
category: project/minidb
coverImage: /uploads/project/minidb/cover.svg
draft: false
series: "minidb"
seriesOrder: 12
---

[11편](/blog/project/minidb/minidb-11-isolation)에서 **2PL 잠금**으로 격리를 만들었다.
그런데 정작 우리가 따라가던 PostgreSQL은 잠금이 아니라 **MVCC(다중 버전 동시성 제어)** 를 쓴다.
같은 목표 - 트랜잭션이 겹쳐 돌아도 서로를 안전하게 지키기 - 에 **정반대 철학의 두 길**이 있는 것이다.
이번 편은 minidb의 현재(2PL)와 PostgreSQL의 길(MVCC)을 나란히 놓고 그 차이를 본다.
앞으로 minidb에 MVCC를 만들 텐데, 이 글이 그 설계도이기도 하다.

## 갈림길: 충돌을 막을까, 피할까

두 트랜잭션이 같은 행을 동시에 건드린다.
하나는 읽고 하나는 쓴다.
어떻게 안전하게 만들까?
답이 둘이다.

**2PL(잠금) - 충돌을 미리 막는다.**
읽으려면 공유 락(S), 쓰려면 배타 락(X)을 잡는다.
누가 잠근 건 못 건드린다.
"충돌이 날 수 있으니 아예 못 만나게 줄을 세운다."
비관적(pessimistic) 접근이다.

**MVCC(버전) - 충돌을 피한다.**
쓰면 데이터를 덮어쓰는 대신 **새 버전**을 만든다.
읽으면 자기 트랜잭션이 시작한 시점의 **스냅샷** - 그때 커밋돼 있던 버전들 - 을 본다.
그래서 읽는 쪽과 쓰는 쪽이 서로 다른 버전을 보고, 막을 일이 없다.
"충돌할 상황 자체를 안 만든다."

## MVCC의 한 줄: 읽기가 쓰기를 막지 않는다

MVCC의 핵심을 한 줄로 줄이면 이렇다.

> **읽기는 쓰기를 막지 않고, 쓰기는 읽기를 막지 않는다.**

2PL에선 reader가 writer를 막는다 - 내가 S 락을 쥐고 있으면 남이 X(쓰기)를 못 잡는다.
writer도 reader를 막는다 - X 락을 쥐면 남이 S(읽기)조차 못 잡는다.
[11편](/blog/project/minidb/minidb-11-isolation)에서 minidb가 정확히 이랬다 - T99가 테이블을 쓰는 중이면 다른 `SELECT`가 거부됐다.
이게 잠금 방식의 동시성 천장이다.

MVCC에선 그 천장이 사라진다.
reader는 옛 버전(자기 스냅샷)을 보면 되니 writer가 새 버전을 쓰든 말든 기다릴 필요가 없다.
writer는 새 버전을 따로 쓰니 reader가 옛 버전을 읽든 말든 기다릴 필요가 없다.
PostgreSQL의 그 매끈한 동시성이 여기서 나온다.

## 같은 이상현상, 다른 처방

[11편](/blog/project/minidb/minidb-11-isolation)에서 본 이상현상들을 두 방식이 각각 어떻게 막는지 보면 차이가 또렷하다.

| 이상현상 | 2PL(잠금) | MVCC(버전) |
|---|---|---|
| **dirty read** | X 잠긴 행을 못 읽음 | 항상 "마지막으로 커밋된 버전"을 보니 커밋 안 된 건 애초에 안 보임 |
| **lost update** | X 락으로 쓰기를 직렬화 | 쓰기-쓰기 충돌을 커밋 때 잡음(first-updater-wins, 진 쪽은 직렬화 실패로 abort) |
| **non-repeatable read** | S 락을 커밋까지 쥠 | 스냅샷이 시작 시점에 고정 -> 같은 걸 다시 읽어도 똑같음 |

같은 문제를 한쪽은 "잠가서", 한쪽은 "버전을 갈라서" 푼다.
특히 non-repeatable read에서 갈리는데 - 2PL은 "남이 못 바꾸게 잠가서" 같은 값을 보장하고, MVCC는 "남이 바꿔도 나는 내 시점만 보니까" 같은 값을 본다.
전자는 동시성을 깎아 안전을 얻고, 후자는 버전을 쌓아 안전을 얻는다.

## 공짜 점심은 없다

두 방식 다 대가가 있다.

**2PL의 대가는 동시성과 교착이다.**
잠금이 서로를 막으니 처리량이 떨어지고, 서로의 락을 기다리다 [교착(deadlock)](/blog/project/minidb/minidb-11-isolation)이 생겨 탐지·abort가 필요하다.
대신 저장은 단순하다 - 행당 버전 하나면 된다.

**MVCC의 대가는 공간과 청소다.**
쓸 때마다 새 버전을 만드니 옛 버전(dead tuple)이 쌓인다.
이걸 안 치우면 테이블·인덱스가 부풀어(bloat) 느려진다.
그래서 PostgreSQL은 죽은 버전을 회수하는 **VACUUM**(autovacuum)을 떠안고 살고, 그게 PG 운영의 큰 부분이다.
읽기 락이 없는 매끈한 동시성의 값이, 끝없이 쌓이는 죽은 버전과 그걸 청소하는 부담인 셈이다.

> 더 깊이: PostgreSQL의 append-only MVCC와 InnoDB의 in-place + Undo Log가 원자성·가시성을 어떻게 다르게 구현하는지는 [트랜잭션 ACID ①: Atomicity는 어떻게 구현되는가](/blog/theory/transaction-acid-01-atomicity). 격리 수준과 이상현상 자체는 [② Isolation](/blog/theory/transaction-acid-02-isolation).

## minidb는 이미 절반쯤 MVCC다

재밌는 건, minidb가 2PL을 만들었는데도 **저장 구조는 이미 MVCC 쪽**이라는 점이다.
[1편에서 PostgreSQL식 힙](/blog/project/minidb/minidb-1-storage)을 골랐고, PostgreSQL의 저장 모델이 애초에 MVCC를 위해 만들어졌기 때문이다.

- minidb의 `UPDATE`는 [이미 "옛 행 tombstone + 새 행 삽입"](/blog/project/minidb/minidb-10-secondary-index)이다 -> 이게 정확히 MVCC가 **새 버전**을 만드는 방식이다.
- `DELETE`가 남기는 tombstone -> MVCC의 dead tuple 그 자체다.

그러니 MVCC로 가는 건 "처음부터 다시"가 아니라 **빠진 조각 끼우기**다.
빠진 건 넷이다.

1. 버전마다 **`xmin`/`xmax`** - "이 버전을 만든 트랜잭션 / 지운 트랜잭션" (지금의 tombstone 비트를 트랜잭션 id로 승격).
2. **트랜잭션 상태 로그** - 어떤 트랜잭션이 커밋됐는지.
3. **스냅샷 + 가시성 판정** - SELECT가 "내 스냅샷에서 보이는 버전"만 거르기.
4. **다중 트랜잭션 핸들** - 실행기가 트랜잭션을 하나가 아니라 여럿 열어 진짜로 인터리브.

가장 큰 건 4번 - [11편](/blog/project/minidb/minidb-11-isolation)에서 실행기가 트랜잭션을 하나씩만 열던 그 한계를 넘는 일이다.

## 왜 2PL을 먼저 했나

그럼 처음부터 MVCC를 하지 그랬냐 싶지만, 2PL을 먼저 한 데는 이유가 있다.
저장을 안 바꾸고, 잠금 규칙(S/X·충돌·교착)이라는 격리의 **고전 골격**을 또렷이 보여줄 수 있어서다.
MVCC는 그 위에서 "잠그는 대신 버전을 가른다"로 도약하는, 시리즈의 클라이맥스 같은 주제다.

## 닫으며

같은 "격리"인데, 한쪽은 **잠그고**(2PL) 한쪽은 **버전을 쌓는다**(MVCC).
비관 대 낙관, 막기 대 피하기.
PostgreSQL이 버전의 길을 골랐기에 그 매끈한 동시성을 얻고 dead tuple과 VACUUM을 떠안았고, minidb가 그 길을 따라가면 같은 이득과 같은 짐을 지게 된다.
지금까지는 잠금으로 "격리가 무엇을 막는가"를 봤다면, 다음은 버전으로 "격리를 어떻게 매끄럽게 하는가"를 만들 차례다.

> **시리즈**: [1. 저장 계층](/blog/project/minidb/minidb-1-storage) · [2. SQL 엔진](/blog/project/minidb/minidb-2-sql-engine) · [3. 인덱스와 WAL](/blog/project/minidb/minidb-3-index-wal) · [4. 트랜잭션](/blog/project/minidb/minidb-4-transactions) · [5. 조인과 집계](/blog/project/minidb/minidb-5-join-aggregate) · [6. BETWEEN과 LIKE](/blog/project/minidb/minidb-6-between-like) · [7. 직접 재보기](/blog/project/minidb/minidb-7-benchmark) · [8. EXPLAIN](/blog/project/minidb/minidb-8-explain) · [9. NULL 저장](/blog/project/minidb/minidb-9-null-storage) · [10. 보조 인덱스](/blog/project/minidb/minidb-10-secondary-index) · [11. 격리](/blog/project/minidb/minidb-11-isolation) · 12. 2PL과 MVCC · [코드(GitHub)](https://github.com/dj258255/minidb)

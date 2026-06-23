---
title: 'minidb — 인덱스와 WAL: B+Tree와 크래시 복구'
titleEn: 'minidb — Index and WAL: B+Tree and Crash Recovery'
description: "관계형 DB를 C로 밑바닥부터 만든 minidb 시리즈 3편. 풀 스캔 O(n)을 O(log n)으로 줄이는 디스크 기반 B+Tree 인덱스를 노드 분할까지 직접 구현하고, 연산자에 따라 점 조회·범위 스캔·풀 스캔을 가르는 플래너의 첫 형태를 만든다. 그리고 전원이 꺼져도 데이터가 안 깨지도록 WAL(쓰기 선행 로그)을 붙이고, 크래시를 실제로 주입해 redo/discard 복구를 증명한다."
descriptionEn: "Part 3 of building a relational database from scratch in C. We implement a disk-based B+Tree index (with node splits) to turn O(n) scans into O(log n), add a tiny planner that routes operators to point lookup / range scan / full scan, and bolt on a write-ahead log — proving crash recovery (redo/discard) by actually injecting crashes."
date: 2026-06-22
tags:
  - C
  - Database Internals
  - B-Tree
  - WAL
  - Learning
category: project/minidb
coverImage: /uploads/project/minidb/cover.svg
draft: false
series: "minidb"
seriesOrder: 3
---

[2편](/blog/project/minidb/minidb-2-sql-engine)에서 SQL이 돌기 시작했지만, `WHERE` 는 매번 모든 행을 훑는 O(n)이다. 이번 편은 그걸 O(log n)으로 줄이는 **B+Tree 인덱스** 를 짓고, 전원이 꺼져도 파일이 안 깨지게 하는 **WAL** 을 붙인다 — DB를 "빠르고 안 깨지게" 만드는 두 계층이다.

## B+Tree 인덱스 — 풀 스캔을 피하기

`WHERE` 가 모든 행을 훑으면 O(n)이다. **인덱스** 로 O(log n)에 찾아간다. B+Tree는 내부 노드(길잡이: 키 + 자식)와 리프 노드(실제 키·값, 옆으로 연결됨)로 된 균형 트리다.

![B+Tree 구조 — 내부 노드에서 리프로 내려가는 검색 경로](/uploads/project/minidb/btree-diagram.svg)

어려운 부분은 **노드 분할(split)** 이다. 리프가 꽉 차면 반으로 쪼개고 가운데 키를 부모로 올린다. 루트까지 올라가 루트가 쪼개지면 트리 높이가 1 자란다 — 그래서 모든 리프가 항상 같은 깊이에 있고, 트리가 한쪽으로 안 기운다. 디스크에 저장되는 B+Tree를 직접 짜고, 키 1000개를 넣어 다단계 분할을 일으킨 뒤 오름차순 스캔으로 구조 무결성을 증명했다.

그리고 이 인덱스를 실행기에 연결했다. INSERT는 `(PK -> RID)` 를 인덱스에 등록하고, `WHERE id = 2` 처럼 인덱스된 컬럼을 쓰면 풀 스캔 대신 `btree_search` -> `heap_get` 한 줄만 읽는다. "쓸 수 있으면 인덱스를 쓴다"는 이 분기가 **쿼리 플래너의 가장 단순한 형태** 다. `WHERE`는 `=` 외에 `<` `>` `<=` `>=` `!=` 도 받는데, `=` 는 인덱스 점 조회로 한 줄을 집고, `<` `>` `<=` `>=` 는 B+Tree의 연결된 리프 체인을 따라 **범위 스캔**한다 — 리프를 옆으로 이어둔 게 이때 빛난다(`id > 5`면 5의 리프로 내려가 거기서부터 옆으로 읽으면 끝). `!=`·비PK·복합 조건은 풀 스캔. 연산자에 따라 실행 계획이 갈리는 게 곧 플래너가 하는 일이다. 조건은 `AND`로 묶고 `OR`로 이을 수도 있다(`a AND b OR c` 는 AND가 먼저 묶인다 — DNF). `ORDER BY <컬럼> [DESC]` 로 정렬하고 `LIMIT` 으로 자르는 것도 붙였는데, 정렬은 마지막 행까지 봐야 첫 출력 순서가 정해져 스트리밍이 안 되니 행을 모았다가 처리하는 별도 경로(PostgreSQL의 Sort 노드)로 보낸다.

## WAL — 쓰다가 전원이 꺼져도

마지막 정체성, 내구성과 원자성. 데이터 파일을 고치는 도중 전원이 꺼지면 파일이 깨질 수 있다. **WAL(Write-Ahead Log)** 은 데이터를 고치기 전에 바뀔 내용을 로그에 먼저 적고 fsync 한다.

![WAL 흐름 — stage -> 로그+커밋마커 fsync(내구성 분기점) -> 데이터 적용 -> 로그 비움](/uploads/project/minidb/wal-flow.svg)

복구 규칙은 단 하나다. 재시작 시 로그에 **커밋 마커가 있으면 데이터에 재적용(redo), 없으면 버린다(rollback).** 테스트에서 정확히 두 위험한 순간에 크래시를 주입했다 — 커밋 마커 fsync 직후(데이터 적용 전)에 멈추면 복구가 redo하고(내구성), 커밋 마커 전에 멈추면 복구가 버린다(원자성). 전원이 꺼져도 데이터가 안 깨진다는 걸 실제로 크래시를 일으켜 증명했다.

![WAL 테스트 — 커밋 후 크래시 redo, 커밋 전 크래시 discard 6개 통과](/uploads/project/minidb/wal-test-output.svg)

---

WAL이 원자성·내구성의 "원리"를 줬다. [다음 편](/blog/project/minidb/minidb-4-transactions)에선 이걸 SQL 레벨로 끌어올려 `BEGIN`/`COMMIT`/`ROLLBACK` 으로 묶음 작업을 다룬다.

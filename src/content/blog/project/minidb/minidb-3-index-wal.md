---
title: '인덱스와 WAL: B+Tree와 크래시 복구'
titleEn: 'Index and WAL: B+Tree and Crash Recovery'
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

`WHERE`가 모든 행을 훑으면 O(n)이다. 100만 행에서 한 줄 찾자고 100만 번 비교한다. **인덱스**는 이걸 O(log n)으로 줄인다 — 정렬된 탐색 구조에 "키 -> 그 행의 주소(RID)"를 담아 두는 것이다.

왜 그냥 이진 탐색 트리가 아니라 **B+Tree**일까? 핵심은 "디스크"다. 인덱스도 페이지 단위로 디스크에 산다. 이진 트리는 노드 하나에 키 하나라 높이가 log₂(n)으로 깊고, 한 단계 내려갈 때마다 페이지 한 번을 읽으니 디스크 접근이 많다. B+Tree는 **노드 하나(=페이지 하나)에 키를 수십~수백 개** 담아 부채살처럼(high fan-out) 갈라지므로 높이가 매우 낮다(보통 3~4단). 100만 행도 디스크 3~4번이면 닿는다. 구조는 두 종류의 노드로 나뉜다:

- **내부 노드** — 길잡이만 한다. "키 + 자식 포인터"를 들고, "찾는 키가 17보다 작으면 왼쪽, 크면 오른쪽 자식으로" 식으로 내려보낸다. 실제 값은 없다.
- **리프 노드** — 진짜 "키 -> 값(RID)"이 여기 있고, **옆 리프와 사슬로 연결**돼 있다(`next_leaf`). 이 사슬이 범위 스캔의 핵심이다(아래).

![B+Tree 구조 — 내부 노드에서 리프로 내려가는 검색 경로](/uploads/project/minidb/btree-diagram.svg)

가장 어려운 부분은 **노드 분할(split)** 이다. 리프가 꽉 차면(minidb는 노드당 키 8개로 작게 잡아 분할이 자주 보이게 했다. 진짜 DB는 페이지를 꽉 채워 수백 개) 반으로 쪼개고, 가운데(분리) 키를 부모에게 올린다. 부모도 꽉 차면 부모가 또 쪼개지고, 이게 루트까지 전파돼 루트가 쪼개지면 비로소 트리 높이가 1 자란다. **위에서가 아니라 아래(리프)에서 자라기 때문에** 모든 리프가 항상 같은 깊이에 있고(균형), 한쪽으로 기울지 않는다 — 그래서 "Balanced tree"다. 디스크에 저장되는 B+Tree를 직접 짜고, 키 1000개를 넣어 다단계 분할을 일으킨 뒤 리프 사슬을 따라 오름차순으로 끝까지 훑어 "정렬이 깨지지 않았는지"로 구조 무결성을 증명했다.

인덱스를 꼭 B+Tree로 해야 하는 건 아니다. 갈림길이 둘 더 있는데, 왜 안 골랐는지가 오히려 B+Tree를 잘 설명해 준다.

- **해시 인덱스** — 키를 해시해 바로 버킷으로 가니 점 조회(`= 5`)는 B+Tree보다도 빠른 O(1)이다. 그런데 해시는 순서를 안 지킨다. `id > 5`나 `ORDER BY id` 같은 **범위·정렬이 통째로 안 된다.** PostgreSQL에 해시 인덱스가 있긴 하지만 거의 안 쓰이는 이유다. SQL은 범위 질의가 너무 흔해서, "점 조회 + 범위 + 정렬"을 한 구조로 다 받는 B+Tree가 기본값이 된다.
- **LSM-tree** — RocksDB·Cassandra·ScyllaDB가 쓰는 구조다. B+Tree는 INSERT마다 트리 곳곳을 고치는 **무작위 쓰기**라, 쓰기가 폭주하는 워크로드에선 디스크(특히 SSD)가 버거워한다. LSM은 쓰기를 일단 메모리(memtable)와 append-only 로그에 쌓았다가 정렬된 덩어리(SSTable)로 한꺼번에 내리며 **무작위 쓰기를 순차 쓰기로 바꾼다.** 쓰기 처리량은 좋지만 읽기는 여러 덩어리를 뒤져야 해 더 느리다(read amplification). 그래서 "읽기·쓰기 균형 + 트랜잭션"이면 B+Tree(MySQL·PostgreSQL), "쓰기 폭주 + 로그성"이면 LSM으로 갈린다.

minidb는 PK 점 조회와 범위 조회를 둘 다 단순하게 보여주고 싶었고, 트랜잭션도 붙일 거라 B+Tree가 맞았다. 이것도 "정답"이 아니라 워크로드에 따른 선택이다.

이제 이 인덱스를 실행기에 연결하면 **쿼리 플래너의 씨앗**이 생긴다. `INSERT`는 `(PK -> RID)`를 인덱스에 등록하고, `WHERE id = 2`처럼 인덱스된 PK를 쓰면 실행기가 풀 스캔 대신 `btree_search`(O(log n)) -> `heap_get` 한 줄만 읽는다. "쓸 수 있으면 인덱스를 쓴다"는 이 분기가 곧 플래너다. 연산자에 따라 계획이 갈린다:

- `=` -> **점 조회(point lookup)**: 리프까지 내려가 한 줄을 집는다.
- `<` `>` `<=` `>=` -> **범위 스캔(range scan)**: 시작 키의 리프로 내려간 뒤, 아까 만든 **리프 사슬을 따라 옆으로** 읽는다. `id > 5`면 5가 있는 리프로 한 번 내려가고, 거기서부터 `next_leaf`를 타고 끝까지 — 트리를 다시 탐색할 필요가 없다. 리프를 옆으로 이어둔 게 바로 이때 빛난다.
- `!=`·비PK·복합 조건 -> 인덱스가 안 통하니 **풀 스캔**으로 떨어진다.

연산자 하나로 실행 계획이 갈리는 이 모습이 곧 옵티마이저가 하는 일의 축소판이다. 조건은 `AND`로 묶고 `OR`로 이을 수도 있는데(`a AND b OR c`는 AND가 OR보다 먼저 묶이는 **DNF**로 파싱), 복합 조건은 인덱스를 안 쓰고 풀 스캔으로 평가한다. `ORDER BY <컬럼> [DESC]`·`LIMIT`도 붙였는데, 정렬은 마지막 행까지 봐야 첫 출력 순서가 정해져 스트리밍이 안 되니 행을 모았다가 정렬하는 별도 경로(PostgreSQL의 **Sort 노드**)로 보낸다. (참고로 우리 인덱스는 단일 PK 컬럼만 — 진짜 DB의 복합 인덱스·커버링 인덱스·인덱스 온리 스캔은 아래 링크에서.)

> 더 깊이, 실제 DB의 인덱스: [DB 인덱스 ①: 기초와 EXPLAIN 읽기](/blog/theory/db-index-01-explain-basics) · [② 스캔의 종류와 옵티마이저의 선택](/blog/theory/db-index-02-scan-types)(Seq/Index/Index-Only/Bitmap 스캔과 비용 기반 선택) · [③ Covering Index와 Index-Only Scan](/blog/theory/db-index-03-covering-index-ios) · [④ 복합 인덱스와 좌측 컬럼 규칙](/blog/theory/db-index-04-composite-leftmost). 그리고 실전에서 B-Tree 인덱스로 자동완성을 푼 [자동완성 B-Tree 인덱스 걸기](/blog/project/WikiEngine/autocomplete-btree-index), B-Tree의 한계를 만나 역색인(FULLTEXT)으로 넘어간 [FULLTEXT ngram 인덱스](/blog/project/WikiEngine/fulltext-ngram-index)도.

## WAL — 쓰다가 전원이 꺼져도

마지막 정체성, 내구성(Durability)과 원자성(Atomicity). 문제는 이렇다 — 한 트랜잭션이 여러 페이지를 고치는데, 그걸 데이터 파일에 하나씩 쓰는 도중 전원이 꺼지면? 일부 페이지만 반영되고 일부는 안 돼 파일이 **찢어진다(torn).** 게다가 디스크 쓰기는 `write()` 했다고 끝이 아니라 OS 페이지 캐시에 머물 수 있어, `fsync()`로 강제로 내려야 진짜 디스크에 닿는다. **WAL(Write-Ahead Log)** 의 아이디어는 단순하다: 데이터 파일을 고치기 전에, 바뀔 내용을 **로그에 먼저 순차로 적고 `fsync`** 한다. 데이터 파일은 흩어진 페이지에 무작위 쓰기(random write)지만 로그는 끝에 이어 붙이는 순차 쓰기(sequential write)라 빠르고, 한 번의 `fsync`로 트랜잭션 전체를 원자적으로 "확정"할 수 있다.

![WAL 흐름 — stage -> 로그+커밋마커 fsync(내구성 분기점) -> 데이터 적용 -> 로그 비움](/uploads/project/minidb/wal-flow.svg)

복구 규칙은 단 하나다. 재시작 시 로그에 **커밋 마커가 있으면 데이터에 재적용(redo), 없으면 버린다(rollback).** 테스트에서 정확히 두 위험한 순간에 크래시를 주입했다 — 커밋 마커 fsync 직후(데이터 적용 전)에 멈추면 복구가 redo하고(내구성), 커밋 마커 전에 멈추면 복구가 버린다(원자성). 전원이 꺼져도 데이터가 안 깨진다는 걸 실제로 크래시를 일으켜 증명했다.

![WAL 테스트 — 커밋 후 크래시 redo, 커밋 전 크래시 discard 6개 통과](/uploads/project/minidb/wal-test-output.svg)

처음엔 이 WAL이 독립 모듈이었지만, 나중에 **실제 쓰기 경로에 연결**했다(이게 최근 작업이다). 지금은 모든 커밋(명시적 `COMMIT` 이든 문장별 autocommit이든)이 — 데이터 파일에 직접 쓰는 대신 — 버퍼 풀의 바뀐(dirty) 페이지를 WAL에 stage하고, 커밋 마커+`fsync` 뒤에야 데이터에 적용한다. 그래서 여러 페이지를 거는 커밋이 **원자적**이 됐고(중간에 꺼져도 찢어지지 않음), 테이블을 열 때 `wal_open`이 로그를 보고 redo/discard로 복구한다.

핵심 제약이 하나 있다 — **커밋 전 dirty 페이지가 로그보다 먼저 디스크로 새면 안 된다.** 이 WAL은 redo만 있고 undo(되돌리기 로그)가 없어서, 로그에 안 적힌 변경이 데이터에 먼저 박히면 복구할 방법이 없다. 그래서 [1편 버퍼 풀](/blog/project/minidb/minidb-1-storage)에서 예고한 **no-steal**을 WAL 쓰기 내내 켜 둔다 — 커밋 안 된 dirty 페이지를 victim으로 안 골라, 디스크로 빠져나가지 못하게 막는 것이다. 이게 교과서적인 steal/no-steal × WAL 상호작용이고(왜 이 정책을 골랐는지는 [4편](/blog/project/minidb/minidb-4-transactions)에서 자세히), 진짜 `INSERT` 도중에 크래시를 주입해 재시작 시 redo(내구성)/discard(원자성)가 도는 걸 테스트로 증명했다. 처음엔 데이터(`.tbl`)만 WAL로 감쌌다가, 같은 방식으로 인덱스(`.idx`)도 자기 WAL(`.idx.wal`)로 감쌌다 — 그래서 크래시 후 재시작하면 데이터뿐 아니라 인덱스 항목까지 redo되고, 복구된 행을 `WHERE id = N` 인덱스 조회로도 다시 찾을 수 있다.

> 더 깊이: [트랜잭션 ACID ④: Durability는 어떻게 디스크까지 살아남는가](/blog/theory/transaction-acid-04-durability) — WAL·`fsync`·group commit·doublewrite buffer·체크포인트, 그리고 PostgreSQL `synchronous_commit` / MySQL `innodb_flush_log_at_trx_commit` 의 성능-내구성 트레이드오프까지. 우리가 만든 게 그 세계의 가장 단순한 형태다.

---

WAL이 원자성·내구성의 "원리"를 줬다. [다음 편](/blog/project/minidb/minidb-4-transactions)에선 이걸 SQL 레벨로 끌어올려 `BEGIN`/`COMMIT`/`ROLLBACK` 으로 묶음 작업을 다룬다.

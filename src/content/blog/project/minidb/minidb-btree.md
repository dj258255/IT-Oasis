---
title: '풀 스캔을 피하는 법 — B+Tree 인덱스'
titleEn: 'Avoiding the Full Scan — The B+Tree Index'
description: "지금 WHERE는 모든 행을 훑는다(O(n)). 진짜 DB는 인덱스로 O(log n)에 찾아간다. 디스크에 저장되는 B+Tree를 C로 직접 만든다 — 노드가 꽉 차면 반으로 쪼개고 가운데 키를 부모로 올리는 split이 트리를 항상 균형 잡히게 한다. InnoDB·PostgreSQL 인덱스의 핵심."
descriptionEn: "Right now WHERE scans every row (O(n)). Real databases use an index to find rows in O(log n). We build an on-disk B+Tree in C — when a node fills, it splits in half and pushes the middle key up, which keeps the tree balanced. This is the core of InnoDB and PostgreSQL indexes."
date: 2026-06-22
tags:
  - C
  - Database Internals
  - B-Tree
  - Index
  - Devlog
category: project/minidb
coverImage: /uploads/project/minidb/cover.svg
draft: false
series: "minidb"
seriesOrder: 7
---

[6편](/blog/project/minidb/minidb-executor)에서 `SELECT * FROM users WHERE id = 2` 가 돌게 만들었다. 그런데 그 `WHERE`는 정직하게 **모든 행을 훑는다**. 행이 백만 개면 백만 번 본다. O(n)이다. 진짜 DB는 그러지 않는다. **인덱스**로 단번에 찾아간다. 이번엔 그 인덱스, **B+Tree**를 만든다.

## B+Tree — 길잡이와 데이터, 그리고 리프 체인

B+Tree는 두 종류의 노드로 된 균형 트리다.

- **내부 노드**: 길잡이다. 키와 자식 포인터만 있다. "이 키보다 작으면 왼쪽, 크면 오른쪽."
- **리프 노드**: 실제 데이터(키, 값)가 여기 있다. 그리고 리프끼리 옆으로 연결돼 있어(`next_leaf`) 정렬된 순서로 훑을 수 있다.

![B+Tree 구조 — 내부 노드(길잡이)에서 리프로 내려가는 검색 경로, 리프끼리 연결된 체인](/uploads/project/minidb/btree-diagram.svg)

검색은 루트에서 시작해 길잡이를 따라 리프까지 내려간다. 트리 높이만큼만 내려가면 되니 **O(log n)** 이다. 1000개 키라도 높이가 3~4면 서너 번 만에 도달한다.

## 어려운 부분 — 노드 분할(split)

B+Tree의 진짜 묘수는 "어떻게 항상 균형을 유지하나"다. 답은 split이다.

- 리프에 키를 넣다가 꽉 차면(여기선 8개 초과), **반으로 쪼갠다.** 뒤 절반을 새 리프로 옮기고, 그 첫 키를 부모에게 "분리키"로 올린다.
- 부모(내부 노드)도 꽉 차면 또 쪼갠다. 이번엔 가운데 키를 위로 **올린다**(복사가 아니라 이동).
- 이게 루트까지 올라가서 루트가 쪼개지면, 새 루트가 생기며 **트리 높이가 1 자란다.**

높이가 자라는 건 오직 루트 split일 때뿐이다. 그래서 모든 리프가 항상 같은 깊이에 있다 — 트리가 한쪽으로 기울지 않는다. 삽입 코드는 "자식에게 넣어보고, 자식이 쪼개졌으면 분리키를 내 자리에 끼우고, 나도 넘치면 또 쪼갠다"는 재귀로 이걸 그대로 표현한다.

```c
int sp = node_insert(bt, child, key, val, &sep, &cr);  // 자식에 삽입
if (sp == 1) {                  // 자식이 쪼개졌다
    insert_separator(n, i, sep, cr);   // 분리키 sep과 새 자식 cr을 끼운다
    if (overflow(n)) split(n, ...);    // 나도 넘치면 쪼개서 위로 전파
}
```

(노드당 키를 8개로 작게 잡아 분할이 잘 보이게 했다. 진짜 DB는 페이지를 꽉 채워 수백 개를 담는다 — 그래서 높이가 더 낮다. 알고리즘은 똑같다.)

인덱스 노드는 테이블 데이터와 **별도 파일(.idx)** 에 저장한다. 같은 파일에 섞으면 힙 스캔이 B+Tree 노드 페이지를 행으로 오해해 깨지기 때문이다. (page 0은 루트 위치를 적어두는 메타 페이지다.)

## 검증 — 1000개를 넣어도 안 깨지나

키 1000개를 넣어 다단계 분할을 일으켰다. 전부 검색되는지, 없는 키는 못 찾는지, 값 갱신이 되는지 확인했다. 그리고 결정적으로 **리프 체인을 따라 훑어 키가 오름차순으로 나오는지** 봤다 — 이게 어긋나면 split 어딘가가 트리를 망가뜨린 것이다. 마지막으로 닫고 다시 열어도 되는지(영속성).

![make test 결과 — B+Tree 테스트 9개 통과, 1000키 검색·오름차순 스캔·재오픈 포함](/uploads/project/minidb/btree-test-output.svg)

`스캔이 오름차순 (트리 구조 정상)` 이 통과한다는 건, 천 번의 삽입과 수많은 분할을 거치고도 트리가 완벽히 정렬된 균형 구조를 유지한다는 뜻이다.

## 다음

이제 인덱스가 따로 있으니, 남은 건 실행기가 `WHERE id = 2` 를 만났을 때 풀 스캔 대신 이 B+Tree를 쓰게 잇는 것이다(쿼리 플래너의 가장 단순한 형태). 그리고 마지막 큰 산은 [9] **WAL과 트랜잭션** — 쓰다가 전원이 꺼져도 복구되는 내구성, 그리고 여러 작업이 동시에 안전하게 도는 동시성. 거기까지 가면 "데이터베이스"라는 이름값을 거의 다 한다.

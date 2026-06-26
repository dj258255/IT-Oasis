---
title: '인덱스와 WAL은 어떻게 동작하는가 — B+Tree와 크래시 복구'
titleEn: 'How Do Indexes and the WAL Work? — B+Tree and Crash Recovery'
description: "관계형 DB를 C로 밑바닥부터 만든 minidb 시리즈 3편. 풀 스캔 O(n)을 O(log n)으로 줄이는 디스크 기반 B+Tree 인덱스를 노드 분할·범위 스캔까지 직접 구현하고, 연산자에 따라 점 조회·범위 스캔·풀 스캔을 가르는 플래너의 첫 형태를 만듭니다. 그리고 전원이 꺼져도 데이터가 안 깨지도록 WAL(쓰기 선행 로그)을 붙이고, 크래시를 실제로 주입해 redo/discard 복구를 증명합니다. B+Tree vs 해시 vs LSM-tree, no-steal vs steal 같은 설계 선택을 PostgreSQL·InnoDB와 비교합니다."
descriptionEn: "Part 3 of minidb, a relational database built from scratch in C. We implement a disk-based B+Tree index (with node splits and range scans) to turn O(n) scans into O(log n), build the first shape of a planner that routes operators to point lookup / range scan / full scan, and bolt on a write-ahead log — proving crash recovery (redo/discard) by actually injecting crashes. We compare design choices like B+Tree vs hash vs LSM-tree and no-steal vs steal against PostgreSQL and InnoDB."
date: 2026-05-17
tags:
  - C
  - Database Internals
  - B-Tree
  - WAL
  - Crash Recovery
  - PostgreSQL
  - InnoDB
  - Learning
category: project/minidb
coverImage: /uploads/project/minidb/cover.svg
draft: false
series: "minidb"
seriesOrder: 3
---

## 0. 들어가며 — 빠르게, 그리고 안 깨지게

[2편](/blog/project/minidb/minidb-2-sql-engine)에서 드디어 SQL이 돌기 시작했어요. 하지만 한 가지 약점이 있었습니다 — `WHERE`가 매번 모든 행을 훑는 O(n)이라는 점이에요. 100만 행에서 한 줄을 찾자고 100만 번을 비교하죠.

이번 편은 그 약점을 정면으로 칩니다. 두 계층을 새로 얹어요.

- **B+Tree 인덱스** — 풀 스캔 O(n)을 O(log n)으로 줄여 DB를 "빠르게" 만드는 계층.
- **WAL(쓰기 선행 로그)** — 전원이 꺼져도 파일이 안 깨지게 해 DB를 "안 깨지게" 만드는 계층.

이 둘은 성격이 정반대예요. 인덱스는 **속도**(성능)를, WAL은 **안전**(내구성·원자성)을 책임집니다. 그런데 둘 다 결국 [1편](/blog/project/minidb/minidb-1-storage)에서 만든 **고정 크기 페이지** 위에서 돌아간다는 공통점이 있어요. 인덱스도 페이지에 살고, WAL도 페이지를 통째로 로그에 적습니다. 그래서 한 편에 묶었습니다.

## 1. 인덱스는 왜 필요한가 — O(n)이라는 벽

`WHERE id = 2`를 실행하면 [1편](/blog/project/minidb/minidb-1-storage)에서 본 **풀 스캔(sequential scan)** 이 돌아요. 힙의 모든 페이지, 페이지 안의 모든 슬롯을 훑는 이중 루프죠. 행이 100만 개면 100만 번을 봅니다 — O(n).

**인덱스**는 이걸 O(log n)으로 줄여요. 아이디어는 단순합니다 — 정렬된 탐색 구조에 "키 -> 그 행의 주소(RID)"를 담아 두는 것이에요. [1편](/blog/project/minidb/minidb-1-storage)에서 만든 그 `RID = (page_id, slot)`이 여기서 다시 등장합니다. 인덱스는 값을 들고 있지 않고, "그 값을 가진 행이 힙 어디에 있는지"만 가리켜요.

> **핵심 정의**: 인덱스는 "키 -> RID" 매핑을 담은, **데이터와 분리된 정렬 탐색 구조**다. 힙은 순서 없이 행을 쌓아두고(O(n) 스캔), 인덱스가 그 위에 정렬된 길을 따로 깔아 O(log n) 조회를 가능하게 한다.

## 2. 왜 이진 트리가 아니라 B+Tree인가 — 디스크가 답이다

정렬된 탐색 구조라면 이진 탐색 트리(BST)도 되지 않을까요? 핵심은 **"디스크"** 입니다.

인덱스도 페이지 단위로 디스크에 살아요. 이진 트리는 노드 하나에 키가 하나라, 높이가 log₂(n)으로 깊습니다. 한 단계 내려갈 때마다 페이지를 한 번 읽으니 디스크 접근이 그만큼 많아져요. 100만 행이면 약 20단계, 즉 디스크를 20번 때립니다.

**B+Tree**는 **노드 하나(=페이지 하나)에 키를 수십~수백 개** 담아 부채살처럼(high fan-out) 갈라져요. 그래서 높이가 매우 낮습니다(보통 3~4단). 100만 행도 디스크 3~4번이면 닿아요. "한 번의 디스크 I/O로 가능한 많은 키를 본다"가 B+Tree의 전부입니다.

구조는 두 종류의 노드로 나뉘어요.

- **내부 노드(internal node)** — 길잡이만 합니다. "키 + 자식 포인터"를 들고, "찾는 키가 17보다 작으면 왼쪽, 크면 오른쪽 자식으로" 식으로 내려보내요. 실제 값(RID)은 없습니다.
- **리프 노드(leaf node)** — 진짜 "키 -> 값(RID)"이 여기 있고, **옆 리프와 사슬로 연결**돼 있어요(`next_leaf`). 이 사슬이 곧 범위 스캔의 핵심입니다(4절).

![B+Tree 구조 — 내부 노드에서 리프로 내려가는 검색 경로](/uploads/project/minidb/btree-diagram.svg)

minidb의 노드는 페이지에 그대로 덮어 해석하는 구조체예요. 내부 노드의 자식 배열과 리프 노드의 값 배열을 `union`으로 같은 자리에 겹쳐 둡니다.

```c
#define BT_MAX_KEYS 8   /* 학습용으로 작게: 분할/다단계가 잘 보이게 */

typedef struct {
    uint8_t  is_leaf;
    uint16_t num_keys;
    uint64_t next_leaf;            /* 리프 형제 페이지 id (0=없음). 내부 노드는 미사용 */
    bkey_t   keys[BT_MAX_KEYS + 1];
    union {
        bval_t   values[BT_MAX_KEYS + 1];     /* 리프: 키 -> RID */
        uint64_t children[BT_MAX_KEYS + 2];   /* 내부: 자식 페이지 id들 */
    } u;
} BTNode;
```

> **주의**: minidb는 노드당 키를 8개로 작게 잡았어요. 진짜 DB는 페이지를 꽉 채워 수백 개를 담습니다. 작게 잡은 이유는 **분할이 자주 일어나 눈에 잘 보이게** 하려는 학습용 선택이에요 — 키가 적든 많든 알고리즘은 한 글자도 안 바뀝니다.

## 3. 가장 어려운 부분 — 노드 분할(split)

B+Tree에서 제일 까다로운 게 **노드 분할**이에요. 리프가 꽉 차면(키 9개째가 들어오면) 반으로 쪼개고, 가운데(분리) 키를 부모에게 올립니다. 부모도 꽉 차면 부모가 또 쪼개지고, 이게 루트까지 전파돼요. 루트가 쪼개지면 비로소 트리 높이가 1 자랍니다.

여기서 B+Tree가 "균형(Balanced)"을 유지하는 비밀이 나와요. **위에서가 아니라 아래(리프)에서 자라기 때문에** 모든 리프가 항상 같은 깊이에 있습니다. 한쪽으로 절대 기울지 않아요 — 그래서 이름이 "Balanced tree"입니다.

리프 분할 코드를 보면, 뒤 절반을 새 리프로 옮기고 그 첫 키를 위로 **복사**합니다(리프는 실제 값이 있으니 키가 양쪽에 남아야 해요).

```c
/* 리프 분할: 뒤 절반을 새 리프로 옮기고 첫 키를 위로 복사 */
int total = n->num_keys;
int left  = total / 2;
int right = total - left;
BTNode *r = bufpool_new_page(bt->bp, &rpid);
r->is_leaf = 1;
for (int j = 0; j < right; j++) {
    r->keys[j]     = n->keys[left + j];
    r->u.values[j] = n->u.values[left + j];
}
r->next_leaf = n->next_leaf;   /* 새 리프가 사슬을 이어받고 */
n->next_leaf = rpid;           /* 옛 리프는 새 리프를 가리킨다 */
*sep_out   = r->keys[0];       /* 부모로 올라갈 분리 키 */
*right_out = rpid;
```

내부 노드 분할은 미묘하게 달라요. 가운데 키를 **복사가 아니라 위로 올려보냅니다(push up)** — 내부 노드의 키는 길잡이일 뿐이라 양쪽에 둘 필요가 없거든요. 리프는 키를 복사(copy up), 내부는 키를 올림(push up) — 이 차이가 B+Tree(리프에 모든 값이 있고 옆으로 연결됨)와 B-Tree(값이 모든 노드에 흩어짐)를 가르는 지점이기도 합니다.

루트가 쪼개질 때만 트리가 위로 자라요.

```c
if (sp == 1) {   /* 루트가 쪼개짐 -> 새 루트(높이 +1) */
    BTNode *root = bufpool_new_page(bt->bp, &nr);
    root->is_leaf      = 0;
    root->num_keys     = 1;
    root->keys[0]      = sep;
    root->u.children[0] = bt->root;   /* 옛 루트가 왼쪽 자식 */
    root->u.children[1] = right;      /* 새 오른쪽이 오른쪽 자식 */
    bt->root = nr;
    write_root(bt, nr);               /* page 0(메타)에 새 루트 id 기록 */
}
```

디스크에 저장되는 이 B+Tree에 **키 1000개를 넣어 다단계 분할을 일으킨 뒤**, 리프 사슬(`next_leaf`)을 따라 오름차순으로 끝까지 훑어 "정렬이 한 번도 깨지지 않았는지"로 구조 무결성을 증명했어요. 분할이 루트까지 전파돼도 리프 전체는 여전히 하나의 정렬된 사슬이라는 게 핵심입니다.

## 4. 인덱스라고 다 B+Tree는 아니다 — 해시 vs LSM-tree

인덱스를 꼭 B+Tree로 해야 하는 건 아니에요. 갈림길이 둘 더 있는데, **왜 그걸 안 골랐는지가 오히려 B+Tree를 잘 설명해 줍니다.**

| | B+Tree (minidb·PG·InnoDB) | 해시 인덱스 | LSM-tree (RocksDB·Cassandra) |
|---|---|---|---|
| 점 조회 `= 5` | O(log n) | **O(1)** (가장 빠름) | 여러 덩어리 탐색 (느림) |
| 범위·정렬 `> 5`, `ORDER BY` | 됨 (리프 사슬) | **안 됨** (순서 없음) | 됨 (정렬된 SSTable) |
| 쓰기 패턴 | 무작위 쓰기 | 무작위 쓰기 | **순차 쓰기** (append) |
| 읽기 비용 | 낮음 | 낮음 | 높음 (read amplification) |
| 적합 워크로드 | 읽기·쓰기 균형 + 트랜잭션 | 점 조회 전용 | 쓰기 폭주 + 로그성 |

- **해시 인덱스** — 키를 해시해 바로 버킷으로 가니 점 조회는 B+Tree보다도 빠른 O(1)이에요. 그런데 해시는 순서를 안 지킵니다. `id > 5`나 `ORDER BY id` 같은 **범위·정렬이 통째로 안 돼요.** PostgreSQL에 해시 인덱스가 있긴 하지만 거의 안 쓰이는 이유예요. SQL은 범위 질의가 너무 흔해서, "점 조회 + 범위 + 정렬"을 한 구조로 다 받는 B+Tree가 기본값이 됩니다.
- **LSM-tree** — RocksDB·Cassandra·ScyllaDB가 쓰는 구조예요. B+Tree는 INSERT마다 트리 곳곳을 고치는 **무작위 쓰기**라, 쓰기가 폭주하는 워크로드에선 디스크(특히 SSD)가 버거워합니다. LSM은 쓰기를 일단 메모리(memtable)와 append-only 로그에 쌓았다가 정렬된 덩어리(SSTable)로 한꺼번에 내리며 **무작위 쓰기를 순차 쓰기로 바꿔요.** 쓰기 처리량은 좋지만 읽기는 여러 덩어리를 뒤져야 해 더 느립니다(read amplification).

> **설계 선택**: minidb는 PK 점 조회와 범위 조회를 둘 다 단순하게 보여주고 싶었고, 트랜잭션도 붙일 거라 B+Tree가 맞았어요. 이것도 "정답"이 아니라 워크로드에 따른 선택입니다 — "읽기·쓰기 균형 + 트랜잭션"이면 B+Tree(MySQL·PostgreSQL), "쓰기 폭주 + 로그성"이면 LSM으로 갈립니다.

## 5. 인덱스를 실행기에 연결하기 — 플래너의 씨앗

이제 이 인덱스를 실행기에 연결하면 **쿼리 플래너의 씨앗**이 생깁니다. `INSERT`는 `(PK -> RID)`를 인덱스에 등록하고, `WHERE id = 2`처럼 인덱스된 PK를 쓰면 실행기가 풀 스캔 대신 `btree_search`(O(log n)) -> `heap_get`으로 한 줄만 읽어요.

"쓸 수 있으면 인덱스를 쓴다"는 이 분기가 곧 플래너입니다. **연산자 하나로 실행 계획이 갈려요.**

| WHERE 조건 | 실행 계획 | 동작 |
|---|---|---|
| `id = 2` | **점 조회 (point lookup)** | `btree_search`로 리프까지 내려가 한 줄 |
| `id > 5`, `id >= 5` | **범위 스캔 (range scan)** | `btree_seek_scan` — 시작 리프로 내려간 뒤 사슬을 옆으로 |
| `id < 5`, `id <= 5` | **범위 스캔** | `btree_scan` — 맨 왼쪽 리프부터 사슬을 훑으며 거름 |
| `!=`·비PK·복합 조건 | **풀 스캔 (full scan)** | 인덱스가 안 통해 힙 전체를 훑음 |

실제 분기 코드는 이렇게 생겼어요. PK 단일 조건일 때만 인덱스로 가고, 연산자에 따라 함수가 갈립니다.

```c
if (pk_cond && c0->op == CMP_EQ) {
    /* = -> 점 조회 O(log n) */
    btree_search(&t->index, c0->val.int_val, &encoded);
    heap_get(&t->heap, rid_decode(encoded), recbuf, &len);
} else if (pk_cond && (c0->op == CMP_GT || c0->op == CMP_GE ||
                       c0->op == CMP_LT || c0->op == CMP_LE)) {
    /* <, >, <=, >= -> 인덱스 범위 스캔 (리프 체인) */
    if (c0->op == CMP_GT || c0->op == CMP_GE)
        btree_seek_scan(&t->index, c0->val.int_val, range_visit, &rc);
    else
        btree_scan(&t->index, range_visit, &rc);
} else {
    /* 그 외 -> 풀 스캔 */
    heap_scan(&t->heap, select_visit, &ctx);
}
```

여기서 **리프 사슬이 빛나는 순간**이 범위 스캔이에요. `id > 5`면 5가 들어갈 리프로 **한 번만** 내려간 뒤(`btree_seek_scan`), 거기서부터 `next_leaf`를 타고 끝까지 옆으로 읽습니다 — 트리를 다시 탐색할 필요가 전혀 없어요. 3절에서 리프를 옆으로 이어둔 게 바로 이때를 위해서였습니다.

```c
int btree_seek_scan(BTree *bt, bkey_t start, btree_visit_fn visit, void *ctx) {
    /* 1) start가 들어갈 리프로 바로 내려간다 (O(log n)) */
    /* 2) 그 리프부터 next_leaf 체인을 따라가며, start 미만 키만 건너뛴다 */
    while (pid != 0) {
        BTNode *n = fetch(bt, pid);
        for (int i = 0; i < n->num_keys; i++) {
            if (n->keys[i] < start) continue;
            visit(n->keys[i], n->u.values[i], ctx);
        }
        pid = n->next_leaf;   /* 옆 리프로 */
    }
}
```

연산자 하나로 실행 계획이 갈리는 이 모습이 곧 옵티마이저가 하는 일의 축소판이에요. 조건은 `AND`로 묶고 `OR`로 이을 수도 있는데(`a AND b OR c`는 AND가 OR보다 먼저 묶이는 **DNF**로 파싱), 복합 조건은 인덱스를 안 쓰고 풀 스캔으로 평가합니다. `ORDER BY <컬럼> [DESC]`·`LIMIT`도 붙였는데, 정렬은 마지막 행까지 봐야 첫 출력 순서가 정해져 스트리밍이 안 되니 행을 모았다가 정렬하는 별도 경로(PostgreSQL의 **Sort 노드**)로 보냈어요.

> **실무/면접 포인트**: 우리 인덱스는 단일 PK 컬럼만 다뤄요. 진짜 DB의 복합 인덱스·커버링 인덱스·인덱스 온리 스캔은 아래 링크에서. 옵티마이저가 "어떤 인덱스를 쓸지, 아니면 풀 스캔이 더 싼지"를 비용으로 따져 고르는 게 비용 기반 최적화(CBO)인데, minidb는 "쓸 수 있으면 무조건 쓴다"는 규칙 기반(RBO)의 가장 단순한 형태예요.

> 더 깊이, 실제 DB의 인덱스: [DB 인덱스 ①: 기초와 EXPLAIN 읽기](/blog/theory/db-index-01-explain-basics) · [② 스캔의 종류와 옵티마이저의 선택](/blog/theory/db-index-02-scan-types)(Seq/Index/Index-Only/Bitmap 스캔과 비용 기반 선택) · [③ Covering Index와 Index-Only Scan](/blog/theory/db-index-03-covering-index-ios) · [④ 복합 인덱스와 좌측 컬럼 규칙](/blog/theory/db-index-04-composite-leftmost). 그리고 실전에서 B-Tree 인덱스로 자동완성을 푼 [자동완성 B-Tree 인덱스 걸기](/blog/project/WikiEngine/autocomplete-btree-index), B-Tree의 한계를 만나 역색인(FULLTEXT)으로 넘어간 [FULLTEXT ngram 인덱스](/blog/project/WikiEngine/fulltext-ngram-index)도.

## 6. WAL — 쓰다가 전원이 꺼져도

이제 정반대 정체성으로 갑니다 — 내구성(Durability)과 원자성(Atomicity)이에요.

문제는 이렇습니다. 한 트랜잭션이 여러 페이지를 고치는데, 그걸 데이터 파일에 하나씩 쓰는 도중 전원이 꺼지면? 일부 페이지만 반영되고 일부는 안 돼 파일이 **찢어져요(torn).** 게다가 디스크 쓰기는 `write()` 했다고 끝이 아니라 OS 페이지 캐시에 머물 수 있어서([1편에서 본 이중 캐시](/blog/project/minidb/minidb-1-storage)), `fsync()`로 강제로 내려야 진짜 디스크에 닿습니다.

**WAL(Write-Ahead Log)** 의 아이디어는 단순해요. 데이터 파일을 고치기 **전에**, 바뀔 내용을 **로그에 먼저 순차로 적고 `fsync`** 합니다. "Write-Ahead" — 데이터보다 로그를 앞서 쓴다는 뜻이에요.

> **핵심 정의**: WAL은 "데이터 파일을 고치기 전에, 그 변경을 로그에 먼저 적고 fsync한다"는 프로토콜이다. 데이터 파일은 흩어진 페이지에 **무작위 쓰기**지만 로그는 끝에 이어 붙이는 **순차 쓰기**라 빠르고, 한 번의 `fsync`로 트랜잭션 전체를 원자적으로 "확정"할 수 있다.

![WAL 흐름 — stage -> 로그+커밋마커 fsync(내구성 분기점) -> 데이터 적용 -> 로그 비움](/uploads/project/minidb/wal-flow.svg)

minidb의 `wal_commit`은 정확히 네 단계예요. 핵심은 **커밋 마커 + fsync 한 줄이 "내구성의 분기점"** 이라는 점입니다 — 그 줄을 지나야 비로소 "이 트랜잭션은 살아남는다"가 보장돼요.

```c
int wal_commit(Wal *w) {
    /* 1) 바뀐 페이지들을 로그에 쓴다 (write-ahead) */
    for (int i = 0; i < w->num_staged; i++) {
        write_all(w->log_fd, &type /*'P'*/, 1);
        write_all(w->log_fd, &pid, sizeof(pid));
        write_all(w->log_fd, s[i].data, PAGE_SIZE);   /* 페이지 통째로 */
    }
    /* 2) 커밋 마커 + fsync — 이 줄을 지나면 "내구"하다 */
    write_all(w->log_fd, &commit_marker /*'C'*/, 1);
    fsync(w->log_fd);                                 /* <- 내구성 분기점 */
    /* 3) 데이터 파일에 실제로 적용 */
    for (int i = 0; i < w->num_staged; i++)
        pager_write(&w->data, s[i].page_id, s[i].data);
    fsync(w->data.fd);
    /* 4) 로그 비움(체크포인트) */
    ftruncate(w->log_fd, 0);
}
```

## 7. 복구 규칙은 단 하나 — redo 아니면 discard

재시작했을 때 복구 규칙은 놀랍도록 단순합니다. **로그에 커밋 마커가 있으면 데이터에 재적용(redo), 없으면 버린다(discard).** 그게 전부예요.

```c
static int wal_recover(Wal *w) {
    for (;;) {
        read_exact(w->log_fd, &type, 1);
        if (type == REC_PAGE) {
            /* 페이지를 pending에 모아둔다 (아직 커밋 안 됨) */
            pending[np++] = ...;
        } else if (type == REC_COMMIT) {
            /* 커밋 마커 도달 -> 여기까지를 데이터에 redo */
            for (int i = 0; i < np; i++)
                pager_write(&w->data, pending[i].page_id, pending[i].data);
            np = 0;
        }
    }
    /* 남은 pending = 커밋 마커를 못 만남 -> 버린다(discard) */
    ftruncate(w->log_fd, 0);   /* 로그 비우고 */
    fsync(w->data.fd);
}
```

이걸 증명하려고 테스트에서 **정확히 두 위험한 순간에 크래시를 주입**했어요.

| 크래시 시점 | 로그 상태 | 복구 동작 | 보장하는 성질 |
|---|---|---|---|
| 커밋 마커 fsync **직후** (데이터 적용 전) | 커밋 마커 있음 | **redo** (데이터에 재적용) | 내구성(Durability) |
| 커밋 마커 **전** | 커밋 마커 없음 | **discard** (버림) | 원자성(Atomicity) |

전자는 "커밋했다고 사용자에게 답한 변경이 살아남는가"(내구성), 후자는 "커밋 안 된 절반의 변경이 찢어진 채 남지 않는가"(원자성)예요. 전원이 꺼져도 데이터가 안 깨진다는 걸 **실제로 크래시를 일으켜** 증명했습니다.

![WAL 테스트 — 커밋 후 크래시 redo, 커밋 전 크래시 discard 6개 통과](/uploads/project/minidb/wal-test-output.svg)

## 8. WAL을 실제 쓰기 경로에 연결하기 — 그리고 no-steal

처음엔 이 WAL이 독립 모듈이었어요. 나중에 **실제 쓰기 경로에 연결**했습니다(이게 최근 작업이에요). 지금은 모든 커밋(명시적 `COMMIT`이든 문장별 autocommit이든)이 — 데이터 파일에 직접 쓰는 대신 — 버퍼 풀의 바뀐(dirty) 페이지를 WAL에 stage하고, 커밋 마커+`fsync` 뒤에야 데이터에 적용해요. 그래서 여러 페이지를 거는 커밋이 **원자적**이 됐고(중간에 꺼져도 찢어지지 않음), 테이블을 열 때 `wal_open`이 로그를 보고 redo/discard로 복구합니다.

핵심 제약이 하나 있어요 — **커밋 전 dirty 페이지가 로그보다 먼저 디스크로 새면 안 됩니다.** 이 WAL은 redo만 있고 undo(되돌리기 로그)가 없어서, 로그에 안 적힌 변경이 데이터에 먼저 박히면 복구할 방법이 없거든요.

그래서 [1편 버퍼 풀](/blog/project/minidb/minidb-1-storage)에서 예고한 **no-steal**을 WAL 쓰기 내내 켜 둡니다 — 커밋 안 된 dirty 페이지를 victim으로 안 골라, 디스크로 빠져나가지 못하게 막는 것이에요. 이게 교과서적인 steal/no-steal × WAL 상호작용입니다.

| 버퍼 정책 | 미커밋 dirty 페이지를 디스크에? | 복구에 필요한 것 | 채택 |
|---|---|---|---|
| **steal + no-force** (ARIES) | 쓸 수 있음 | redo **+ undo** | PostgreSQL·InnoDB |
| **no-steal + force** | 못 씀 / 커밋 시 강제 flush | (거의) 불필요 | (느려서 잘 안 씀) |
| **no-steal + no-force** (minidb) | 못 씀 (커밋까지 메모리에 묶음) | **redo만** (undo 불필요) | minidb |

minidb가 **no-steal**을 고른 덕에 undo 로그 없이 redo만으로 복구가 끝나요. 대신 큰 트랜잭션은 dirty 페이지를 전부 메모리에 들고 있어야 한다는 대가가 있는데, 학습용으로는 이 단순함이 압도적으로 유리합니다. 왜 진짜 DB는 거꾸로 steal+no-force(=ARIES)를 고르는지, 그 트레이드오프는 [4편](/blog/project/minidb/minidb-4-transactions)에서 자세히 다뤄요.

진짜 `INSERT` 도중에 크래시를 주입해 재시작 시 redo(내구성)/discard(원자성)가 도는 걸 테스트로 증명했어요. 처음엔 데이터(`.tbl`)만 WAL로 감쌌다가, 같은 방식으로 인덱스(`.idx`)도 자기 WAL(`.idx.wal`)로 감쌌습니다 — 그래서 크래시 후 재시작하면 데이터뿐 아니라 인덱스 항목까지 redo되고, 복구된 행을 `WHERE id = N` 인덱스 조회로도 다시 찾을 수 있어요.

> **실무/면접 포인트**: "WAL이 있으면 fsync는 로그에만 하면 된다"가 핵심이에요. 데이터 페이지 수십 개에 무작위 fsync를 하는 대신, 순차 로그 하나에만 fsync하니 빠릅니다. 진짜 DB의 `synchronous_commit`(PG)·`innodb_flush_log_at_trx_commit`(MySQL)이 바로 이 "커밋 시 fsync를 얼마나 빡세게 할까" 다이얼이에요.

> 더 깊이: [트랜잭션 ACID ④: Durability는 어떻게 디스크까지 살아남는가](/blog/theory/transaction-acid-04-durability) — WAL·`fsync`·group commit·doublewrite buffer·체크포인트, 그리고 PostgreSQL `synchronous_commit` / MySQL `innodb_flush_log_at_trx_commit`의 성능-내구성 트레이드오프까지. 우리가 만든 게 그 세계의 가장 단순한 형태입니다.

## 9. 정리

이번 편은 성격이 정반대인 두 계층을 얹었어요 — **속도**의 인덱스와 **안전**의 WAL.

- **B+Tree 인덱스** — 인덱스는 "키 -> RID" 정렬 구조로 O(n) 풀 스캔을 O(log n)으로 줄인다. 이진 트리가 아니라 B+Tree인 건 **디스크** 때문 — 노드 하나에 키 수백 개를 담아(high fan-out) 높이가 3~4단으로 낮다.
- **노드 분할** — 리프에서 자라 위로 전파되므로 모든 리프가 같은 깊이(균형). 리프는 키 복사, 내부는 키 push up.
- **인덱스 ≠ B+Tree** — 점 조회 전용이면 해시, 쓰기 폭주면 LSM. "점 조회+범위+정렬"을 다 받아서 B+Tree가 기본값.
- **플래너의 씨앗** — 연산자 하나(`=` / `<>` / 복합)로 점 조회·범위 스캔·풀 스캔이 갈린다. 범위 스캔은 리프 사슬 덕에 트리를 한 번만 탄다.
- **WAL** — 데이터보다 로그를 먼저 쓰고 fsync. 복구 규칙은 "커밋 마커 있으면 redo, 없으면 discard" 하나. minidb는 **no-steal + no-force**라 undo 없이 redo만으로 복구한다.

인덱스가 "빠르게"를, WAL이 "안 깨지게"를 줬어요. 특히 WAL이 원자성·내구성의 **"원리"** 를 손에 쥐여줬습니다. [다음 편](/blog/project/minidb/minidb-4-transactions)에선 이걸 SQL 레벨로 끌어올려 `BEGIN`/`COMMIT`/`ROLLBACK`으로 묶음 작업을 다뤄요 — no-steal을 왜 골랐는지, ARIES와 무엇이 다른지도 거기서 깊이 들어갑니다.

## 참고

- [PostgreSQL Documentation: Write-Ahead Logging (WAL)](https://www.postgresql.org/docs/current/wal-intro.html)
- [PostgreSQL Documentation: Index Types (B-tree, Hash, etc.)](https://www.postgresql.org/docs/current/indexes-types.html)
- [PostgreSQL Documentation: B-Tree Indexes](https://www.postgresql.org/docs/current/btree.html)
- Douglas Comer, *The Ubiquitous B-Tree* (ACM Computing Surveys, 1979)
- ARIES: A Transaction Recovery Method (Mohan et al., 1992)
- 본 블로그: [DB 인덱스 ①: 기초와 EXPLAIN](/blog/theory/db-index-01-explain-basics) · [② 스캔의 종류](/blog/theory/db-index-02-scan-types) · [③ Covering Index](/blog/theory/db-index-03-covering-index-ios) · [④ 복합 인덱스](/blog/theory/db-index-04-composite-leftmost) · [트랜잭션 ACID ④: Durability](/blog/theory/transaction-acid-04-durability)
- 본 시리즈: [1편 저장 계층](/blog/project/minidb/minidb-1-storage) · [2편 SQL 엔진](/blog/project/minidb/minidb-2-sql-engine) · [4편 트랜잭션](/blog/project/minidb/minidb-4-transactions). WikiEngine 실전편: [자동완성 B-Tree 인덱스](/blog/project/WikiEngine/autocomplete-btree-index) · [FULLTEXT ngram 인덱스](/blog/project/WikiEngine/fulltext-ngram-index)
- [minidb 코드 (GitHub)](https://github.com/dj258255/minidb)

<!-- EN -->

## 0. Introduction — Fast, and Crash-Proof

In [Part 2](/blog/project/minidb/minidb-2-sql-engine) SQL finally started running. But it had one weakness — `WHERE` was an O(n) scan over every row each time. To find one row out of a million, it compared a million times.

This part attacks that weakness head-on. We stack two new layers.

- **B+Tree index** — the layer that makes the DB "fast" by turning an O(n) full scan into O(log n).
- **WAL (write-ahead log)** — the layer that makes the DB "crash-proof" so the file never corrupts even on a power loss.

These two have opposite personalities. The index is about **speed** (performance); the WAL is about **safety** (durability, atomicity). Yet both ultimately run on the same **fixed-size pages** we built in [Part 1](/blog/project/minidb/minidb-1-storage) — the index lives in pages, and the WAL logs whole pages. That is why they share one part.

## 1. Why Indexes Exist — the O(n) Wall

Running `WHERE id = 2` triggers the **sequential scan** from [Part 1](/blog/project/minidb/minidb-1-storage) — a double loop over every page of the heap and every slot in a page. A million rows means a million comparisons — O(n).

An **index** cuts that to O(log n). The idea is simple — keep a "key -> the row's address (RID)" mapping in a sorted search structure. That `RID = (page_id, slot)` from [Part 1](/blog/project/minidb/minidb-1-storage) returns here. The index does not hold the values; it only points at "where in the heap the row with that value lives."

> **Definition**: an index is a **sorted search structure separate from the data**, holding a "key -> RID" mapping. The heap piles rows unordered (O(n) scan); the index lays a separate sorted path on top to enable O(log n) lookups.

## 2. Why a B+Tree, Not a Binary Tree — Disk Is the Answer

If we just need a sorted search structure, would a binary search tree (BST) do? The key is **"disk."**

The index lives on disk in pages too. A binary tree holds one key per node, so its height is log₂(n) — deep. Each step down reads one page, so disk accesses pile up. A million rows is about 20 steps — 20 disk hits.

A **B+Tree** packs **tens to hundreds of keys per node (= per page)**, fanning out like a paper fan (high fan-out). So its height is very low (usually 3-4 levels). A million rows is reachable in 3-4 disk hits. "See as many keys as possible per disk I/O" is the whole of the B+Tree.

It splits into two node kinds.

- **Internal node** — just a guide. It holds "key + child pointer" and routes "if the key is below 17 go left, else go right." No actual values (RIDs).
- **Leaf node** — the real "key -> value (RID)" lives here, and it is **chained to its sibling leaf** (`next_leaf`). That chain is the heart of range scans (section 4).

![B+Tree structure — search path from internal nodes down to a leaf](/uploads/project/minidb/btree-diagram.svg)

minidb's node is a struct reinterpreted directly over a page. The internal node's child array and the leaf node's value array overlap in the same place via a `union`.

```c
#define BT_MAX_KEYS 8   /* small for learning: splits/multi-level stay visible */

typedef struct {
    uint8_t  is_leaf;
    uint16_t num_keys;
    uint64_t next_leaf;            /* sibling leaf page id (0=none); unused in internals */
    bkey_t   keys[BT_MAX_KEYS + 1];
    union {
        bval_t   values[BT_MAX_KEYS + 1];     /* leaf: key -> RID */
        uint64_t children[BT_MAX_KEYS + 2];   /* internal: child page ids */
    } u;
} BTNode;
```

> **Note**: minidb caps keys per node at 8. Real DBs fill a page with hundreds. The small cap is a learning choice — it makes **splits happen often and stay visible**. Few keys or many, the algorithm does not change one line.

## 3. The Hardest Part — Node Splits

The trickiest thing in a B+Tree is the **node split**. When a leaf fills (the 9th key arrives), it splits in half and pushes the middle (separator) key up to the parent. If the parent is full too, it splits as well, and this propagates up to the root. Only when the root splits does the tree grow one level taller.

Here is the secret of how a B+Tree stays "Balanced." **Because it grows from the bottom (the leaves), not the top**, all leaves are always at the same depth. It never leans to one side — hence "Balanced tree."

In the leaf-split code, the back half moves into a new leaf and its first key is **copied** up (leaves hold real values, so the key must remain on both sides).

```c
/* Leaf split: move the back half into a new leaf, copy its first key up */
int total = n->num_keys;
int left  = total / 2;
int right = total - left;
BTNode *r = bufpool_new_page(bt->bp, &rpid);
r->is_leaf = 1;
for (int j = 0; j < right; j++) {
    r->keys[j]     = n->keys[left + j];
    r->u.values[j] = n->u.values[left + j];
}
r->next_leaf = n->next_leaf;   /* the new leaf inherits the chain, */
n->next_leaf = rpid;           /* and the old leaf points to the new one */
*sep_out   = r->keys[0];       /* separator key to push to the parent */
*right_out = rpid;
```

The internal-node split is subtly different. The middle key is **pushed up, not copied** — an internal key is only a guide, so it need not stay on both sides. Leaf copies the key up (copy-up), internal pushes it up (push-up) — this difference is also what separates a B+Tree (all values in the leaves, chained sideways) from a B-Tree (values scattered across all nodes).

Only when the root splits does the tree grow upward.

```c
if (sp == 1) {   /* root split -> new root (height +1) */
    BTNode *root = bufpool_new_page(bt->bp, &nr);
    root->is_leaf      = 0;
    root->num_keys     = 1;
    root->keys[0]      = sep;
    root->u.children[0] = bt->root;   /* old root becomes left child */
    root->u.children[1] = right;      /* new right becomes right child */
    bt->root = nr;
    write_root(bt, nr);               /* record the new root id in page 0 (meta) */
}
```

I proved the structural integrity of this disk-resident B+Tree by **inserting 1000 keys to force multi-level splits**, then walking the leaf chain (`next_leaf`) in ascending order to the end and checking "the ordering never broke." The point is that even after a split propagates to the root, the whole set of leaves is still one sorted chain.

## 4. Not Every Index Is a B+Tree — Hash vs LSM-tree

An index does not have to be a B+Tree. Two other forks exist, and **why we did not pick them explains the B+Tree well.**

| | B+Tree (minidb·PG·InnoDB) | Hash index | LSM-tree (RocksDB·Cassandra) |
|---|---|---|---|
| Point lookup `= 5` | O(log n) | **O(1)** (fastest) | search several runs (slow) |
| Range/sort `> 5`, `ORDER BY` | yes (leaf chain) | **no** (unordered) | yes (sorted SSTables) |
| Write pattern | random writes | random writes | **sequential writes** (append) |
| Read cost | low | low | high (read amplification) |
| Best workload | balanced read/write + transactions | point lookups only | write-heavy + log-like |

- **Hash index** — hashing a key jumps straight to a bucket, so point lookups are O(1), even faster than a B+Tree. But hashes do not keep order. `id > 5` or `ORDER BY id` — **ranges and sorting are entirely out**. That is why PostgreSQL has a hash index that is barely used. SQL has range queries so often that the B+Tree, which takes "point + range + sort" in one structure, becomes the default.
- **LSM-tree** — used by RocksDB, Cassandra, ScyllaDB. A B+Tree does **random writes**, fixing the tree all over on every INSERT, so a write-heavy workload strains the disk (especially SSDs). LSM piles writes into memory (memtable) and an append-only log first, then flushes them as sorted runs (SSTables) all at once, **turning random writes into sequential writes**. Write throughput is great, but reads are slower because they must dig through several runs (read amplification).

> **A design choice**: minidb wanted to show PK point lookups and range lookups both simply, and it would add transactions, so a B+Tree fit. This too is not "the answer" but a workload choice — "balanced read/write + transactions" goes B+Tree (MySQL, PostgreSQL), "write-heavy + log-like" goes LSM.

## 5. Wiring the Index into the Executor — the Seed of a Planner

Wire this index into the executor and you get **the seed of a query planner**. `INSERT` registers `(PK -> RID)` in the index, and a query like `WHERE id = 2` on an indexed PK has the executor read one row via `btree_search` (O(log n)) -> `heap_get` instead of a full scan.

This branch — "use the index if you can" — is the planner. **One operator splits the execution plan.**

| WHERE condition | Plan | Action |
|---|---|---|
| `id = 2` | **point lookup** | `btree_search` down to a leaf, one row |
| `id > 5`, `id >= 5` | **range scan** | `btree_seek_scan` — descend to start leaf, walk the chain sideways |
| `id < 5`, `id <= 5` | **range scan** | `btree_scan` — from the leftmost leaf, walk the chain and filter |
| `!=`·non-PK·compound | **full scan** | index does not apply, scan the whole heap |

The actual branch looks like this. It uses the index only for a single PK condition, and the function splits by operator.

```c
if (pk_cond && c0->op == CMP_EQ) {
    /* = -> point lookup O(log n) */
    btree_search(&t->index, c0->val.int_val, &encoded);
    heap_get(&t->heap, rid_decode(encoded), recbuf, &len);
} else if (pk_cond && (c0->op == CMP_GT || c0->op == CMP_GE ||
                       c0->op == CMP_LT || c0->op == CMP_LE)) {
    /* <, >, <=, >= -> index range scan (leaf chain) */
    if (c0->op == CMP_GT || c0->op == CMP_GE)
        btree_seek_scan(&t->index, c0->val.int_val, range_visit, &rc);
    else
        btree_scan(&t->index, range_visit, &rc);
} else {
    /* otherwise -> full scan */
    heap_scan(&t->heap, select_visit, &ctx);
}
```

The **moment the leaf chain shines** is the range scan. For `id > 5`, it descends **just once** to the leaf where 5 would land (`btree_seek_scan`), then reads sideways via `next_leaf` to the end — no need to traverse the tree again. Chaining the leaves sideways in section 3 was exactly for this.

```c
int btree_seek_scan(BTree *bt, bkey_t start, btree_visit_fn visit, void *ctx) {
    /* 1) descend straight to the leaf where start would land (O(log n)) */
    /* 2) from that leaf, follow the next_leaf chain, skipping keys below start */
    while (pid != 0) {
        BTNode *n = fetch(bt, pid);
        for (int i = 0; i < n->num_keys; i++) {
            if (n->keys[i] < start) continue;
            visit(n->keys[i], n->u.values[i], ctx);
        }
        pid = n->next_leaf;   /* to the sibling leaf */
    }
}
```

One operator splitting the execution plan is a miniature of what an optimizer does. Conditions can be grouped with `AND` and joined with `OR` (`a AND b OR c` parses as **DNF**, with AND binding before OR); compound conditions skip the index and are evaluated with a full scan. `ORDER BY <column> [DESC]` and `LIMIT` are in too, but sorting cannot stream — the first output order is only known after the last row — so it goes through a separate gather-then-sort path (PostgreSQL's **Sort node**).

> **Practical/interview note**: our index handles only a single PK column. Real DBs' composite indexes, covering indexes, and index-only scans are in the links below. An optimizer weighing "which index to use, or whether a full scan is cheaper" by cost is cost-based optimization (CBO); minidb is the simplest rule-based form (RBO) — "use it if you can."

> Deeper, real-DB indexes: [DB Index ①: Basics and Reading EXPLAIN](/blog/theory/db-index-01-explain-basics) · [② Scan Types and the Optimizer's Choice](/blog/theory/db-index-02-scan-types) · [③ Covering Index and Index-Only Scan](/blog/theory/db-index-03-covering-index-ios) · [④ Composite Index and the Leftmost Rule](/blog/theory/db-index-04-composite-leftmost). And from the field: [Autocomplete with a B-Tree Index](/blog/project/WikiEngine/autocomplete-btree-index) and, hitting the B-Tree's limits, [FULLTEXT ngram Index](/blog/project/WikiEngine/fulltext-ngram-index).

## 6. WAL — When the Power Cuts Mid-Write

Now to the opposite identity — Durability and Atomicity.

The problem is this. A transaction modifies several pages, and the power cuts while writing them to the data file one by one? Some pages land and some do not, so the file **tears (torn).** And a disk write is not done just because `write()` returned — it can linger in the OS page cache (the [double cache from Part 1](/blog/project/minidb/minidb-1-storage)), so only `fsync()` forces it to truly reach disk.

The **WAL (Write-Ahead Log)** idea is simple. **Before** modifying the data file, **write the change to the log first, sequentially, and `fsync`**. "Write-Ahead" — log ahead of data.

> **Definition**: WAL is the protocol "before modifying the data file, write the change to the log first and fsync." The data file is **random writes** to scattered pages, but the log is **sequential writes** appended at the end, so it is fast, and a single `fsync` atomically "commits" the whole transaction.

![WAL flow — stage -> log + commit marker fsync (durability point) -> apply to data -> clear log](/uploads/project/minidb/wal-flow.svg)

minidb's `wal_commit` is exactly four steps. The key is that the **commit marker + fsync line is "the durability boundary"** — only past that line is "this transaction survives" guaranteed.

```c
int wal_commit(Wal *w) {
    /* 1) write changed pages to the log (write-ahead) */
    for (int i = 0; i < w->num_staged; i++) {
        write_all(w->log_fd, &type /*'P'*/, 1);
        write_all(w->log_fd, &pid, sizeof(pid));
        write_all(w->log_fd, s[i].data, PAGE_SIZE);   /* whole page */
    }
    /* 2) commit marker + fsync — past this line it is "durable" */
    write_all(w->log_fd, &commit_marker /*'C'*/, 1);
    fsync(w->log_fd);                                 /* <- durability boundary */
    /* 3) actually apply to the data file */
    for (int i = 0; i < w->num_staged; i++)
        pager_write(&w->data, s[i].page_id, s[i].data);
    fsync(w->data.fd);
    /* 4) clear the log (checkpoint) */
    ftruncate(w->log_fd, 0);
}
```

## 7. The Recovery Rule Is Just One — redo or discard

On restart the recovery rule is shockingly simple. **If the log has a commit marker, reapply to the data (redo); if not, throw it away (discard).** That is all.

```c
static int wal_recover(Wal *w) {
    for (;;) {
        read_exact(w->log_fd, &type, 1);
        if (type == REC_PAGE) {
            /* gather pages into pending (not committed yet) */
            pending[np++] = ...;
        } else if (type == REC_COMMIT) {
            /* reached a commit marker -> redo everything up to here */
            for (int i = 0; i < np; i++)
                pager_write(&w->data, pending[i].page_id, pending[i].data);
            np = 0;
        }
    }
    /* leftover pending = never met a commit marker -> discard */
    ftruncate(w->log_fd, 0);   /* clear the log and */
    fsync(w->data.fd);
}
```

To prove this, the test **injects a crash at exactly the two dangerous moments.**

| Crash moment | Log state | Recovery action | Property guaranteed |
|---|---|---|---|
| **right after** the commit-marker fsync (before applying data) | marker present | **redo** (reapply to data) | Durability |
| **before** the commit marker | no marker | **discard** | Atomicity |

The former is "does a change we told the user was committed survive" (durability); the latter is "does half of an uncommitted change not remain torn" (atomicity). I proved the data does not corrupt on power loss **by actually causing crashes.**

![WAL tests — redo on post-commit crash, discard on pre-commit crash, 6 pass](/uploads/project/minidb/wal-test-output.svg)

## 8. Wiring the WAL into the Real Write Path — and no-steal

At first this WAL was a standalone module. Later I **wired it into the real write path** (recent work). Now every commit (explicit `COMMIT` or per-statement autocommit) — instead of writing to the data file directly — stages the buffer pool's dirty pages into the WAL and applies them to the data only after the commit marker + `fsync`. So a commit touching several pages became **atomic** (it does not tear if power cuts mid-way), and when a table opens, `wal_open` reads the log and recovers via redo/discard.

There is one core constraint — **before commit, a dirty page must not leak to disk ahead of the log.** This WAL has only redo, no undo (rollback log), so if a change not yet logged lands in the data first, there is no way to recover.

So we keep **no-steal**, foreshadowed in the [Part 1 buffer pool](/blog/project/minidb/minidb-1-storage), on throughout WAL writes — never pick an uncommitted dirty page as a victim, so it cannot escape to disk. This is the textbook steal/no-steal × WAL interaction.

| Buffer policy | Uncommitted dirty page to disk? | Recovery needs | Adoption |
|---|---|---|---|
| **steal + no-force** (ARIES) | allowed | redo **+ undo** | PostgreSQL·InnoDB |
| **no-steal + force** | not allowed / force-flush at commit | (almost) none | (slow, rarely used) |
| **no-steal + no-force** (minidb) | not allowed (pinned until commit) | **redo only** (no undo) | minidb |

Because minidb chose **no-steal**, recovery finishes with redo alone, no undo log. The price is that a big transaction must hold all its dirty pages in memory — but for learning this simplicity wins overwhelmingly. Why real DBs choose the opposite, steal + no-force (= ARIES), and that trade-off, is covered in detail in [Part 4](/blog/project/minidb/minidb-4-transactions).

I proved redo (durability) / discard (atomicity) run on restart by injecting a crash mid-real-`INSERT`. At first only the data (`.tbl`) was wrapped in a WAL; then, the same way, the index (`.idx`) got its own WAL (`.idx.wal`) — so after a crash-restart, not only data but index entries get redone, and a recovered row is findable again via a `WHERE id = N` index lookup.

> **Practical/interview note**: the key is "with a WAL, you only fsync the log." Instead of random fsyncs across dozens of data pages, you fsync one sequential log — fast. Real DBs' `synchronous_commit` (PG) and `innodb_flush_log_at_trx_commit` (MySQL) are exactly this "how hard to fsync at commit" dial.

> Deeper: [Transaction ACID ④: How Durability Survives to Disk](/blog/theory/transaction-acid-04-durability) — WAL, `fsync`, group commit, doublewrite buffer, checkpoints, and the performance-durability trade-offs of PostgreSQL `synchronous_commit` / MySQL `innodb_flush_log_at_trx_commit`. What we built is the simplest form of that world.

## 9. Wrap-up

This part stacked two layers of opposite personality — the **speed** of the index and the **safety** of the WAL.

- **B+Tree index** — an index is a sorted "key -> RID" structure that cuts an O(n) full scan to O(log n). It is a B+Tree, not a binary tree, because of **disk** — hundreds of keys per node (high fan-out) keep the height to 3-4 levels.
- **Node split** — it grows at the leaves and propagates up, so all leaves are at equal depth (balanced). Leaves copy the key up, internals push it up.
- **Index ≠ B+Tree** — point-lookup-only goes hash, write-heavy goes LSM. Taking "point + range + sort" all at once makes the B+Tree the default.
- **The seed of a planner** — one operator (`=` / `<>` / compound) splits point lookup, range scan, full scan. The range scan traverses the tree only once thanks to the leaf chain.
- **WAL** — log ahead of data, then fsync. The recovery rule is just one: "marker present, redo; absent, discard." minidb is **no-steal + no-force**, so it recovers with redo alone, no undo.

The index gave "fast," the WAL gave "crash-proof." In particular the WAL handed us the **"principle"** of atomicity and durability. [Next](/blog/project/minidb/minidb-4-transactions) we lift this to the SQL level and handle batched work with `BEGIN`/`COMMIT`/`ROLLBACK` — and go deep there on why we picked no-steal and how it differs from ARIES.

## References

- [PostgreSQL Documentation: Write-Ahead Logging (WAL)](https://www.postgresql.org/docs/current/wal-intro.html)
- [PostgreSQL Documentation: Index Types (B-tree, Hash, etc.)](https://www.postgresql.org/docs/current/indexes-types.html)
- [PostgreSQL Documentation: B-Tree Indexes](https://www.postgresql.org/docs/current/btree.html)
- Douglas Comer, *The Ubiquitous B-Tree* (ACM Computing Surveys, 1979)
- ARIES: A Transaction Recovery Method (Mohan et al., 1992)
- This blog: [DB Index ①: Basics and EXPLAIN](/blog/theory/db-index-01-explain-basics) · [② Scan Types](/blog/theory/db-index-02-scan-types) · [③ Covering Index](/blog/theory/db-index-03-covering-index-ios) · [④ Composite Index](/blog/theory/db-index-04-composite-leftmost) · [Transaction ACID ④: Durability](/blog/theory/transaction-acid-04-durability)
- This series: [Part 1 Storage](/blog/project/minidb/minidb-1-storage) · [Part 2 SQL Engine](/blog/project/minidb/minidb-2-sql-engine) · [Part 4 Transactions](/blog/project/minidb/minidb-4-transactions). WikiEngine field posts: [Autocomplete B-Tree Index](/blog/project/WikiEngine/autocomplete-btree-index) · [FULLTEXT ngram Index](/blog/project/WikiEngine/fulltext-ngram-index)
- [minidb on GitHub](https://github.com/dj258255/minidb)

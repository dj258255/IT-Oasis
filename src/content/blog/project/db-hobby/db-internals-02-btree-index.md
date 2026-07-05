---
title: 'DB 내부 ②: B+Tree 인덱스 — O(log n), 그리고 인덱스는 왜 단순 key→value가 아닌가'
titleEn: 'DB Internals ②: The B+Tree Index — O(log n), and Why an Index Isn''t a Simple key→value Map'
description: "인덱스는 왜 이진 트리가 아니라 B+Tree인가 — 답은 디스크다(노드=페이지, fan-out이 높이를 무너뜨린다). 가장 어려운 노드 분할(리프는 copy-up, 내부는 push-up), 범위 스캔을 공짜로 만드는 리프 사슬, 그리고 유일성을 내려놓는 순간 부딪히는 문제들 — 중복 키의 하한 탐색(>= 한 글자가 조용히 틀린 결과를 만든다), '인덱스는 후보일 뿐, 진실은 힙에 있다'는 재검사(recheck)까지. 인덱스 vs 풀 스캔을 실측하면 1천 행에서 11배, 10만 행에서 416배로 벌어진다 — O(log n)과 O(n)의 모양 그 자체. 해시·LSM과의 갈림길, PostgreSQL·InnoDB 대조를 C 구현으로 확인하며 정리해요."
descriptionEn: "Why is an index a B+Tree and not a binary tree? The answer is the disk — node = page, and fan-out collapses the height. The hardest part, node splits (leaves copy up, internals push up); the leaf chain that makes range scans free; and the problems you hit the moment you give up uniqueness — lower-bound search for duplicate keys (one '>=' silently loses rows) and the recheck principle: 'the index only narrows candidates; the truth lives in the heap.' Measured, index vs full scan diverges from 11× at 1k rows to 416× at 100k — the very shape of O(log n) vs O(n). With the hash/LSM fork and PostgreSQL/InnoDB contrasts, verified on a C implementation."
date: 2026-02-10T00:00:00.000Z
tags:
  - Database Internals
  - Index
  - B+Tree
  - PostgreSQL
  - InnoDB
  - C
category: study/db-hobby
coverImage: /uploads/project/db-hobby/cover.svg
draft: false
series: "미니 DB로 이해하는 DB 내부"
seriesOrder: 2
---

## 0. 들어가며 — O(n)이라는 벽

[1편](/blog/project/db-hobby/db-internals-01-storage)에서 힙 파일까지 지었어요. `WHERE id = 2`를 실행하면 **풀 스캔**이 돕니다 — 모든 페이지의 모든 슬롯을 훑는 이중 루프, 행이 100만 개면 100만 번, O(n).

**인덱스**는 이걸 O(log n)으로 줄여요. 아이디어는 단순합니다 — 정렬된 탐색 구조에 "키 → 그 행의 주소(RID)"를 담아 두는 것.

> **핵심 정의**: (PostgreSQL·db-hobby 같은 힙 기반에서) 인덱스는 "키 → RID" 매핑을 담은, **데이터와 분리된 정렬 탐색 구조**다. 힙은 순서 없이 행을 쌓아두고, 인덱스가 그 위에 정렬된 길을 따로 깔아 O(log n) 조회를 만든다. (InnoDB의 클러스터드 인덱스는 리프에 데이터 자체가 있어 이 정의가 조금 다르다 — [7편](/blog/project/db-hobby/db-internals-07-storage-engines)에서 대조.)

말이 아니라 숫자부터 봅시다. 같은 한 행을 두 길로 찾으며 테이블 크기 N을 키워 실측하면(C 구현, `-O2`):

| 테이블 크기 N | 인덱스 점 조회 | 풀 스캔 | 배율 |
|---|---|---|---|
| 1,000 | 3.25 µs | 34.21 µs | 11배 |
| 10,000 | 5.05 µs | 274.28 µs | 54배 |
| 100,000 | 7.52 µs | 3,126.74 µs | **416배** |

숫자 하나하나보다 **두 열이 자라는 모양**이 핵심이에요. 풀 스캔 열은 N이 10배 될 때마다 거의 10배씩 뜁니다 — O(n)의 모양. 인덱스 열은 N이 100배 되는 동안 2.3배밖에 안 늘어요 — O(log n)의 로그 곡선. 그래서 격차가 **N이 클수록 벌어집니다.** 인덱스의 가치는 데이터가 많아질수록 커져요 — 정확히 인덱스가 필요해지는 그 지점에서요.

이 편은 그 인덱스를 실제로 지으며 확인한 것들입니다 — 왜 하필 B+Tree인지, 뭐가 가장 어려운지, 그리고 **유일성을 내려놓는 순간**(보조 인덱스) 어떤 가정들이 깨지는지.

## 1. 왜 이진 트리가 아니라 B+Tree인가 — 디스크가 답이다

정렬된 탐색 구조라면 이진 탐색 트리(BST)도 되지 않을까요? 핵심은 **디스크**입니다.

인덱스도 페이지 단위로 디스크에 살아요. 이진 트리는 노드 하나에 키가 하나라 높이가 log₂(n)으로 깊습니다. 한 단계 내려갈 때마다 페이지를 한 번 읽어야 하니, 100만 행이면 최악의 경우 약 20번 페이지를 읽어요(버퍼 풀에 올라온 페이지는 예외지만요).

**B+Tree**는 **노드 하나(=페이지 하나)에 키를 수십~수백 개** 담아 부채살처럼 갈라져요(high fan-out, f). 높이가 log₂N이 아니라 **log_f N** — 같은 100만 행이라도 fan-out이 수백이면 대략 3~4단에 그칩니다(8KB 페이지 기준). **"한 번의 디스크 I/O로 가능한 많은 키를 본다"** — 이게 B+Tree의 전부예요.

구조는 두 종류의 노드로 나뉩니다.

- **내부 노드** — 길잡이만. "키 + 자식 포인터"를 들고 찾는 키를 아래로 내려보내요. 실제 값(RID)은 없습니다.
- **리프 노드** — 진짜 "키 → RID"가 여기 있고, **옆 리프와 사슬로 연결**돼 있어요(`next_leaf`). 이 사슬이 범위 스캔의 핵심입니다(3절).

![B+Tree 구조 — 내부 노드에서 리프로 내려가는 검색 경로](/uploads/project/db-hobby/btree-diagram.svg)

```c
#define BT_MAX_KEYS 8   /* 학습용으로 작게: 분할/다단계가 잘 보이게 */

typedef struct {
    uint8_t  is_leaf;
    uint16_t num_keys;
    uint64_t next_leaf;            /* 리프 형제 페이지 id. 내부 노드는 미사용 */
    bkey_t   keys[BT_MAX_KEYS + 1];
    union {
        bval_t   values[BT_MAX_KEYS + 1];     /* 리프: 키 -> RID */
        uint64_t children[BT_MAX_KEYS + 2];   /* 내부: 자식 페이지 id들 */
    } u;
} BTNode;
```

> **주의**: db-hobby는 노드당 키를 8개로 작게 잡았어요 — **분할이 자주 일어나 눈에 잘 보이게** 하려는 학습용 선택. 진짜 DB는 페이지를 꽉 채워 수백 개를 담습니다. 키가 적든 많든 알고리즘은 한 글자도 안 바뀝니다.

## 2. 가장 어려운 부분 — 노드 분할

B+Tree에서 제일 까다로운 게 **노드 분할(split)** 이에요. 리프가 꽉 차면 반으로 쪼개고 가운데(분리) 키를 부모에게 올립니다. 부모도 꽉 차면 부모가 또 쪼개지고, 루트까지 전파돼요. **루트가 쪼개질 때만 트리 높이가 1 자랍니다.**

여기서 B+Tree가 "균형(Balanced)"을 유지하는 비밀이 나와요 — AVL처럼 회전으로 맞추는 게 아니라, **위가 아니라 아래(리프)에서 자라기 때문에** 모든 리프가 항상 같은 깊이입니다. 한쪽으로 절대 기울지 않아요.

리프 분할은 뒤 절반을 새 리프로 옮기고, 그 첫 키를 부모로 **복사(copy up)** 합니다 — 리프엔 실제 값이 있으니 키가 양쪽에 남아야 하거든요.

```c
/* 리프 분할: 뒤 절반을 새 리프로 옮기고 첫 키를 위로 복사 */
r->next_leaf = n->next_leaf;   /* 새 리프가 사슬을 이어받고 */
n->next_leaf = rpid;           /* 옛 리프는 새 리프를 가리킨다 */
*sep_out = r->keys[0];         /* 부모로 올라갈 분리 키 (복사) */
```

내부 노드 분할은 미묘하게 달라요 — 가운데 키를 복사가 아니라 **위로 올려보냅니다(push up).** 내부 노드의 키는 길잡이일 뿐이라 양쪽에 둘 필요가 없거든요.

> **핵심 구분**: 리프는 copy up, 내부는 push up. 이 차이가 **B+Tree**(값은 리프에만, 리프끼리 옆으로 연결)와 **B-Tree**(값이 내부 노드에도 들어감)를 가르는 지점이기도 하다. PostgreSQL nbtree·InnoDB 모두 B+Tree 계열이다.

디스크에 저장되는 이 트리에 키 1000개를 넣어 다단계 분할을 일으킨 뒤, 리프 사슬을 따라 끝까지 훑어 "정렬이 한 번도 깨지지 않았는지"로 구조 무결성을 검증했어요. 분할이 루트까지 전파돼도 **리프 전체는 여전히 하나의 정렬된 사슬**이라는 게 핵심입니다.

## 3. 범위 스캔 — 리프 사슬이 빛나는 순간

`WHERE id = 2` 같은 점 조회는 루트에서 리프로 내려가 한 줄(O(log n)). **리프 사슬이 빛나는 순간**은 범위 스캔이에요. `id > 5`면 5가 들어갈 리프로 **한 번만** 내려간 뒤, 거기서부터 `next_leaf`를 타고 옆으로 끝까지 읽습니다 — 트리를 다시 탐색할 필요가 전혀 없어요.

```c
int btree_seek_scan(BTree *bt, bkey_t start, btree_visit_fn visit, void *ctx) {
    /* 1) start가 들어갈 리프로 바로 내려간다 (O(log n)) */
    /* 2) 그 리프부터 next_leaf 체인을 따라가며 start 미만 키만 건너뛴다 */
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

해시 인덱스가 절대 못 하는 게 바로 이거예요 — 해시는 순서를 안 지키니 `>`도 `ORDER BY`도 통째로 안 됩니다. SQL은 범위 질의가 너무 흔해서, "점 조회 + 범위 + 정렬"을 한 구조로 다 받는 B+Tree가 기본값이 된 거예요.

| | B+Tree (PG·InnoDB·db-hobby) | 해시 인덱스 | LSM-tree (RocksDB·Cassandra) |
|---|---|---|---|
| 점 조회 `= 5` | O(log n) | **O(1)** | 여러 덩어리 탐색 (느림) |
| 범위·정렬 | 됨 (리프 사슬) | **안 됨** | 됨 (정렬된 SSTable) |
| 쓰기 패턴 | 무작위 쓰기 | 무작위 쓰기 | **순차 쓰기** (append) |
| 적합 워크로드 | 읽기·쓰기 균형 + 트랜잭션 | 점 조회 전용 | 쓰기 폭주 + 로그성 |

LSM은 무작위 쓰기를 순차 쓰기로 바꾸는 정반대 내기인데, 이 갈림길은 [7편(저장 엔진의 세 철학)](/blog/project/db-hobby/db-internals-07-storage-engines)에서 직접 구현해 대조합니다.

## 4. 유일성을 내려놓으면 — 중복 키와 하한 탐색

여기까지의 인덱스는 PK(유일 키) 전용이에요. 그런데 실무에서 인덱스를 거는 컬럼은 대부분 PK가 아닙니다 — `email`, `status`, `created_at` 같은, **유일하지 않은** 컬럼이죠. "보조 인덱스가 어렵다"의 정체가 바로 이 비유니크성이에요. PK 인덱스가 "유일하다"는 사실에 기대 조용히 넘어가던 가정들이 하나씩 깨집니다.

| | PK 인덱스 | 보조 인덱스 |
|---|---|---|
| 키 | 유일 | 중복 가능 |
| 한 키의 RID | 하나 | 여럿 |
| 탐색 | 하나 찾으면 끝 | **하한 탐색 + 사슬 훑기** |
| 조회 후 | 바로 사용 | **힙 재검사 필요** |

### 쓰기는 플래그 하나, 읽기가 진짜 문제

나이 20인 사람이 셋이면 키 20에 RID가 셋 달려야 해요. 쓰기는 "같은 키면 덮어쓴다"를 "같은 키도 새 항목으로 추가한다"로 바꾸는 플래그 하나로 끝납니다(`btree_insert_dup`). **진짜 문제는 읽기예요.** 중복 키는 리프 분할 때문에 **여러 리프에 흩어집니다.**

20이 잔뜩 쌓여 리프가 쪼개지면 분리키가 하필 20이 될 수 있어요. 그러면 20짜리 항목이 왼쪽 리프에도 오른쪽 리프에도 걸칩니다. 유니크 검색처럼 "분리키와 같으면 오른쪽으로(`>=`)" 내려가면 **왼쪽에 흩어진 20들을 놓쳐요.**

그래서 **하한 탐색(lower bound)** 이 필요합니다 — 분리키와 같으면 오른쪽으로 넘어가지 않고(`>` 비교) 왼쪽 자식으로 내려가, 20이 시작될 수 있는 **가장 왼쪽 리프**에 닿은 뒤, 리프 사슬을 오른쪽으로 훑으며 20을 다 모으고 21을 만나면 멈춥니다.

```c
while (i < n->num_keys && key > n->keys[i]) {  /* '>=' 아니라 '>' */
    i++;
}
```

> **주의**: `>=`를 `>`로 바꾸는 한 글자가 전부처럼 보이지만, 이게 안 되면 결과가 **조용히 일부만** 나온다. 에러도 안 나고 그냥 행 몇 개가 빠진다. 인덱스 버그 중 가장 잡기 어려운 종류 — **"틀린 결과를 멀쩡한 얼굴로 돌려주는" 버그**다. 같은 키 50개를 일부러 여러 리프로 쪼갠 뒤 전부 찾아지는지가 이 코드의 회귀 테스트다.

참고로 인덱스는 재시작에도 살아남아야 하므로, "이 테이블엔 age_idx가 age 컬럼에 있다"는 정의를 카탈로그에 적고 인덱스 자체는 별도 파일에 둡니다 — PostgreSQL이 `pg_class`/`pg_index`에 메타데이터를 적고 인덱스를 별도 relation(relfilenode 파일)에 두는 것과 같은 분리예요.

## 5. 인덱스는 후보일 뿐 — 재검사, 진실은 힙에 있다

보조 인덱스가 준 RID를 곧이곧대로 믿으면 안 됩니다. 이유가 셋이에요.

| # | 왜 RID를 못 믿나 | 어떻게 거르나 |
|---|---|---|
| 1 | 삭제된 행의 stale 항목이 남아 있을 수 있음 | `heap_get` 실패로 걸러짐 |
| 2 | UPDATE로 값이 바뀌어 옛 항목이 남아 있을 수 있음 | WHERE 재평가로 거름 |
| 3 | 빈 슬롯을 새 행이 재사용하면 옛 RID가 엉뚱한 행을 가리킴 | WHERE 재평가로 거름 |

그래서 후보 RID마다 힙에서 행을 읽고 **WHERE를 다시 평가**해 진짜 맞는 행만 내보냅니다. 이게 **재검사(recheck)** 예요.

> **핵심**: **"인덱스는 후보를 좁히고, 진실은 힙에 있다"** — 이게 인덱스 스캔의 본질이다. 이 원칙 덕에 B+Tree에 삭제 기능이 없어도, stale 항목이 남아 있어도 결과는 정확하다.

실제 DB와의 대조를 정확히 하면 — PostgreSQL의 recheck는 인덱스가 후보만 보장하는 lossy 케이스(GIN/GiST/BRIN, Bitmap Heap Scan)에서 주로 나오고 B-tree 등식 스캔엔 보통 recheck가 없어요. db-hobby의 재검사는 stale RID(tombstone·슬롯 재사용) 때문이라 *이유*는 다르지만, "인덱스는 좁히고 최종 판정은 실제 행으로"라는 아이디어는 같습니다.

그리고 이 원칙은 나중에 더 크게 돌아와요. [4편(MVCC)](/blog/project/db-hobby/db-internals-04-mvcc)에서 UPDATE가 행의 새 버전을 만들기 시작하면, **PK 인덱스조차 한 키에 여러 RID(버전들)를 매다는 멀티맵**이 됩니다 — 인덱스는 버전 후보들을 주고, 어느 버전이 "보이는지"는 힙의 가시성 게이트가 판정해요. "인덱스는 단순 key→value가 아니다"라는 이 편의 부제가 그 얘기입니다.

## 6. 플래너의 씨앗 — 연산자 하나로 실행 계획이 갈린다

인덱스를 실행기에 연결하면 쿼리 플래너의 씨앗이 생깁니다.

| WHERE 조건 | 실행 계획 |
|---|---|
| `id = 2` | 점 조회 (`btree_search` → `heap_get`) |
| `id > 5`, `>=` | 범위 스캔 (`btree_seek_scan` — 리프 사슬) |
| `id < 5`, `<=` | 범위 스캔 (맨 왼쪽 리프부터) |
| `age = 20` (보조) | `find_all` + 힙 재검사 |
| 그 외 (`!=`·복합) | 풀 스캔 |

다만 이건 "쓸 수 있으면 무조건 인덱스"라는 **규칙 기반(RBO)** 의 가장 단순한 형태예요. 진짜 플래너는 통계로 선택도를 추정해 **비용**으로 고릅니다 — `id > 1`처럼 대부분 행이 걸리는 조건이면 풀 스캔이 오히려 빠르거든요. 그 얘기는 [6편(비용 기반 옵티마이저)](/blog/project/db-hobby/db-internals-06-optimizer)에서 규칙이 실제로 틀리는 순간부터 시작합니다.

## 7. 정리

- **B+Tree인 이유는 디스크** — 노드=페이지, fan-out이 높이를 log_f N으로 무너뜨린다. "한 번의 I/O로 최대한 많은 키를."
- **분할이 균형의 비밀** — 리프에서 위로 자라니 모든 리프가 같은 깊이. 리프는 copy up, 내부는 push up(B+Tree vs B-Tree의 갈림).
- **리프 사슬**이 범위 스캔을 공짜로 만든다 — 내려가긴 한 번, 나머진 옆으로. 해시가 못 하는 것.
- **유일성을 내려놓으면** 하한 탐색이 필요하다 — `>=` 한 글자가 조용히 행을 잃게 만든다.
- **인덱스는 후보일 뿐, 진실은 힙에** — 재검사가 stale 항목을 무해화한다. MVCC가 오면 이 원칙이 인덱스의 생존 조건이 된다.
- **실측**: 인덱스 vs 풀 스캔 격차는 1천 행 11배 → 10만 행 416배. O(log n)의 가치는 N과 함께 자란다.

다음 편은 쓰기 경로의 대사건 — **쓰다가 전원이 꺼지면?** WAL과 크래시 복구, 그리고 fsync의 가격(같은 5천 행 적재가 23배 차이 나는 이유)입니다.

## 참고 (1차 자료 우선)

- [PostgreSQL Documentation: B-Tree Indexes (nbtree)](https://www.postgresql.org/docs/current/btree.html)
- [PostgreSQL Documentation: Index Access Method Interface](https://www.postgresql.org/docs/current/indexam.html)
- [MySQL 8.0 Reference: InnoDB Index Types](https://dev.mysql.com/doc/refman/8.0/en/innodb-index-types.html)
- Goetz Graefe, *Modern B-Tree Techniques* (Foundations and Trends in Databases, 2011)
- 본 블로그: [DB 인덱스 ①: 기초와 EXPLAIN](/blog/theory/db-index-01-explain-basics) · [②: 스캔의 종류](/blog/theory/db-index-02-scan-types) · [③: Covering Index](/blog/theory/db-index-03-covering-index-ios) · [④: 복합 인덱스](/blog/theory/db-index-04-composite-leftmost) · [⑤: 클러스터형](/blog/theory/db-index-05-clustered-dbms)
- [db-hobby 코드 (GitHub)](https://github.com/dj258255/db-hobby) — `btree.c`

<!-- EN -->

## 0. Introduction — the O(n) Wall

[Part 1](/blog/project/db-hobby/db-internals-01-storage) built up to the heap file. Run `WHERE id = 2` and a **full scan** executes — a double loop over every slot of every page. A million rows means a million looks: O(n).

An **index** turns that into O(log n). The idea is simple — keep a "key → row address (RID)" mapping in a sorted search structure.

> **Key definition**: (in heap-based systems like PostgreSQL and db-hobby) an index is a **sorted search structure separate from the data**, holding "key → RID." The heap piles rows unordered; the index lays a sorted road on top for O(log n) lookups. (InnoDB's clustered index keeps the data itself in the leaves, so the definition shifts — contrasted in [Part 7](/blog/project/db-hobby/db-internals-07-storage-engines).)

Numbers first. Finding the same single row two ways while growing table size N (C implementation, `-O2`):

| Table size N | Index point lookup | Full scan | Ratio |
|---|---|---|---|
| 1,000 | 3.25 µs | 34.21 µs | 11× |
| 10,000 | 5.05 µs | 274.28 µs | 54× |
| 100,000 | 7.52 µs | 3,126.74 µs | **416×** |

What matters is **the shape of the two columns**, not the individual numbers. The full-scan column multiplies ~10× every time N does — the shape of O(n). The index column grows just 2.3× while N grows 100× — the log curve of O(log n). So the gap **widens as N grows.** An index's value grows with the data — precisely where you need it.

This part builds that index and records what you learn by building it — why a B+Tree, what's hardest, and what assumptions break **the moment you give up uniqueness** (secondary indexes).

## 1. Why a B+Tree, Not a Binary Tree — the Disk Is the Answer

Wouldn't a binary search tree do? The crux is the **disk.**

An index also lives on disk in pages. A binary tree holds one key per node, so its height is log₂(n) — one page read per level. A million rows ≈ 20 levels ≈ up to 20 page reads (minus buffer-pool hits).

A **B+Tree** packs **dozens to hundreds of keys into one node (= one page)**, fanning out wide (fan-out f). Height becomes **log_f N** instead of log₂N — for the same million rows, with fan-out in the hundreds it's roughly 3–4 levels (8KB pages). **"See as many keys as possible per disk I/O"** — that's the whole point of a B+Tree.

Two node kinds:

- **Internal nodes** — guides only: "key + child pointer," routing the search downward. No values (RIDs).
- **Leaf nodes** — the real "key → RID" lives here, and leaves are **chained sideways** (`next_leaf`). That chain is the heart of range scans (§3).

![B+Tree structure — the search path descending from internal nodes to a leaf](/uploads/project/db-hobby/btree-diagram.svg)

```c
#define BT_MAX_KEYS 8   /* small on purpose: splits and multi-level growth stay visible */

typedef struct {
    uint8_t  is_leaf;
    uint16_t num_keys;
    uint64_t next_leaf;            /* leaf sibling page id; unused for internals */
    bkey_t   keys[BT_MAX_KEYS + 1];
    union {
        bval_t   values[BT_MAX_KEYS + 1];     /* leaf: key -> RID */
        uint64_t children[BT_MAX_KEYS + 2];   /* internal: child page ids */
    } u;
} BTNode;
```

> **Note**: db-hobby caps keys at 8 per node — a learning choice so **splits happen often and stay visible.** Real DBs pack hundreds per page. The algorithm doesn't change by a single character either way.

## 2. The Hardest Part — Node Splits

The trickiest thing in a B+Tree is the **split.** When a leaf fills, split it in half and promote the middle (separator) key to the parent. If the parent is full, it splits too, propagating up to the root. **Only when the root splits does the tree grow taller by one.**

Here's the secret of how a B+Tree stays balanced — not by rotations like AVL, but because **it grows from the bottom (leaves), not the top**, every leaf is always at the same depth. It can never lean.

A leaf split moves the back half to a new leaf and **copies** the first key up (leaves hold real values, so the key must remain on both sides):

```c
/* leaf split: move the back half to a new leaf; copy its first key up */
r->next_leaf = n->next_leaf;   /* new leaf inherits the chain */
n->next_leaf = rpid;           /* old leaf points at the new one */
*sep_out = r->keys[0];         /* separator key promoted (copied) to the parent */
```

An internal split differs subtly — the middle key is **pushed up**, not copied: internal keys are guides only, no need to keep them on both sides.

> **Key distinction**: leaves copy up, internals push up. That difference is also what separates a **B+Tree** (values only in leaves, leaves chained) from a **B-Tree** (values in internal nodes too). PostgreSQL's nbtree and InnoDB are both B+Tree-family.

Integrity was verified by inserting 1,000 keys to force multi-level splits, then walking the leaf chain end to end checking the ordering never breaks. Even as splits propagate to the root, **the leaves remain one sorted chain.**

## 3. Range Scans — Where the Leaf Chain Shines

A point lookup descends root→leaf for one row (O(log n)). The **leaf chain shines** on range scans: for `id > 5`, descend **once** to the leaf where 5 would live, then read sideways along `next_leaf` to the end — no re-descending, ever.

```c
int btree_seek_scan(BTree *bt, bkey_t start, btree_visit_fn visit, void *ctx) {
    /* 1) descend straight to the leaf where `start` would live (O(log n)) */
    /* 2) from there, follow the next_leaf chain, skipping keys < start */
    while (pid != 0) {
        BTNode *n = fetch(bt, pid);
        for (int i = 0; i < n->num_keys; i++) {
            if (n->keys[i] < start) continue;
            visit(n->keys[i], n->u.values[i], ctx);
        }
        pid = n->next_leaf;   /* sideways */
    }
}
```

This is exactly what a hash index can never do — hashes keep no order, so `>` and `ORDER BY` are impossible wholesale. SQL is so full of range queries that the B+Tree — point + range + order in one structure — became the default.

| | B+Tree (PG · InnoDB · db-hobby) | Hash index | LSM-tree (RocksDB · Cassandra) |
|---|---|---|---|
| Point lookup `= 5` | O(log n) | **O(1)** | searches multiple runs (slower) |
| Range/order | yes (leaf chain) | **no** | yes (sorted SSTables) |
| Write pattern | random writes | random writes | **sequential** (append) |
| Fits | balanced R/W + transactions | point-lookup-only | write-heavy, log-like |

The LSM is the opposite bet — turning random writes into sequential ones — built and contrasted head-on in [Part 7](/blog/project/db-hobby/db-internals-07-storage-engines).

## 4. Giving Up Uniqueness — Duplicate Keys and Lower-Bound Search

So far the index served the PK (unique keys). But in practice most indexed columns aren't PKs — they're `email`, `status`, `created_at`: **not unique.** That's the real identity of "secondary indexes are hard." Assumptions the PK index quietly leaned on break one by one:

| | PK index | Secondary index |
|---|---|---|
| Key | unique | duplicates allowed |
| RIDs per key | one | many |
| Search | find one, done | **lower bound + chain sweep** |
| After lookup | use directly | **heap recheck required** |

### Writes Are One Flag; Reads Are the Real Problem

If three people are age 20, key 20 must carry three RIDs. Writing is a one-flag change ("same key overwrites" → "same key appends," `btree_insert_dup`). **The real problem is reading.** Duplicate keys get **scattered across leaves** by splits.

Pile up enough 20s and a leaf splits with the separator key happening to be 20 — now 20-entries straddle both the left and right leaf. Descend like the unique search does ("if equal to separator, go right," `>=`) and **you miss the 20s on the left.**

Hence **lower-bound search**: when equal to a separator, do *not* go right (`>` comparison, not `>=`) — descend left to reach the **leftmost leaf** where 20 could start, then sweep the leaf chain rightward collecting 20s until a 21 appears.

```c
while (i < n->num_keys && key > n->keys[i]) {  /* '>' — not '>=' */
    i++;
}
```

> **Warning**: changing `>=` to `>` looks like one character, but without it results come back **silently partial.** No error — just missing rows. The hardest class of index bug: **one that returns wrong results with a straight face.** The regression test plants 50 identical keys deliberately split across leaves and asserts all 50 are found.

Since indexes must also survive restarts, the definition ("table t has age_idx on column age") goes into the catalog and the index lives in its own file — the same separation as PostgreSQL recording metadata in `pg_class`/`pg_index` while the index lives in its own relation (relfilenode) file.

## 5. The Index Only Narrows — Recheck; the Truth Lives in the Heap

You must not take a secondary index's RIDs at face value. Three reasons:

| # | Why the RID can't be trusted | How it's filtered |
|---|---|---|
| 1 | stale entries of deleted rows may remain | `heap_get` fails |
| 2 | old entries may remain after UPDATE changed the value | WHERE re-evaluation |
| 3 | a freed slot reused by a new row makes the old RID point at the wrong row | WHERE re-evaluation |

So for each candidate RID, read the row from the heap and **re-evaluate WHERE**, emitting only true matches. That's the **recheck.**

> **Key principle**: **"the index narrows candidates; the truth lives in the heap."** That's the essence of an index scan. Thanks to it, results stay correct even with no B+Tree delete and with stale entries lying around.

To be precise about the real-DB contrast: PostgreSQL's recheck appears mainly where the index is lossy (GIN/GiST/BRIN, Bitmap Heap Scan); plain B-tree equality scans usually need none. db-hobby's recheck exists because of stale RIDs (tombstones, slot reuse) — different *reason*, same idea: the index narrows, the actual row decides.

And this principle returns in a bigger way: in [Part 4 (MVCC)](/blog/project/db-hobby/db-internals-04-mvcc), once UPDATE starts creating new row versions, **even the PK index becomes a multimap hanging several RIDs (versions) off one key** — the index yields version candidates, and the heap's visibility gate decides which one is "visible." That's what this part's subtitle — "why an index isn't a simple key→value map" — is about.

## 6. The Seed of a Planner — One Operator Changes the Plan

Wiring the index into the executor plants the seed of a query planner:

| WHERE condition | Plan |
|---|---|
| `id = 2` | point lookup (`btree_search` → `heap_get`) |
| `id > 5`, `>=` | range scan (`btree_seek_scan` — leaf chain) |
| `id < 5`, `<=` | range scan (from the leftmost leaf) |
| `age = 20` (secondary) | `find_all` + heap recheck |
| everything else (`!=`, compound) | full scan |

But this is the crudest **rule-based (RBO)** form: "use an index whenever possible." A real planner estimates selectivity from statistics and chooses by **cost** — for a condition like `id > 1` matching most rows, a full scan is actually faster. That story starts in [Part 6 (Cost-Based Optimizer)](/blog/project/db-hobby/db-internals-06-optimizer), at the exact moment the rule goes wrong.

## 7. Wrap-up

- **The reason it's a B+Tree is the disk** — node = page; fan-out collapses height to log_f N. "As many keys per I/O as possible."
- **Splits are the secret of balance** — growing upward from the leaves keeps all leaves at equal depth. Leaves copy up, internals push up (the B+Tree vs B-Tree fork).
- The **leaf chain** makes range scans free — descend once, go sideways. What hashes can't do.
- **Give up uniqueness** and you need lower-bound search — one `>=` silently loses rows.
- **The index only narrows; the truth lives in the heap** — recheck neutralizes stale entries. Under MVCC this principle becomes the index's survival condition.
- **Measured**: index vs full scan widens from 11× (1k rows) to 416× (100k). O(log n)'s value grows with N.

Next: the write path's great event — **what if the power dies mid-write?** WAL and crash recovery, and the price of fsync (why loading the same 5,000 rows differs by 23×).

## References (primary sources first)

- [PostgreSQL Documentation: B-Tree Indexes (nbtree)](https://www.postgresql.org/docs/current/btree.html)
- [PostgreSQL Documentation: Index Access Method Interface](https://www.postgresql.org/docs/current/indexam.html)
- [MySQL 8.0 Reference: InnoDB Index Types](https://dev.mysql.com/doc/refman/8.0/en/innodb-index-types.html)
- Goetz Graefe, *Modern B-Tree Techniques* (Foundations and Trends in Databases, 2011)
- This blog: [DB Index ①–⑤](/blog/theory/db-index-01-explain-basics)
- [db-hobby source (GitHub)](https://github.com/dj258255/db-hobby) — `btree.c`

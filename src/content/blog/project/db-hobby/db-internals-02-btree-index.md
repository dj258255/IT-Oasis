---
title: 'DB 내부 ②: B+Tree 인덱스와 O(log n), 그리고 인덱스는 왜 단순 key→value가 아닌가'
description: "인덱스는 왜 이진 트리가 아니라 B+Tree인가. 답은 디스크다(노드=페이지, fan-out이 높이를 무너뜨린다). 가장 어려운 노드 분할(리프는 copy-up, 내부는 push-up), 범위 스캔을 공짜로 만드는 리프 사슬, 그리고 유일성을 내려놓는 순간 부딪히는 문제들, 곧 중복 키의 하한 탐색(>= 한 글자가 조용히 틀린 결과를 만든다)과 '인덱스는 후보일 뿐, 진실은 힙에 있다'는 재검사(recheck)까지. 인덱스 vs 풀 스캔을 실측하면 1천 행에서 11배, 10만 행에서 416배로 벌어진다. O(log n)과 O(n)의 모양 그 자체다. 해시·LSM과의 갈림길, PostgreSQL·InnoDB 대조를 C 구현으로 확인하며 정리한다."
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

## 0. 들어가며: O(n)이라는 벽

[1편](/blog/project/db-hobby/db-internals-01-storage)에서 힙 파일까지 지었습니다. `WHERE id = 2`를 실행하면 **풀 스캔**이 돕니다. 모든 페이지의 모든 슬롯을 훑는 이중 루프라, 행이 100만 개면 100만 번, O(n)입니다.

**인덱스**는 이걸 O(log n)으로 줄입니다. 아이디어는 단순합니다. 정렬된 탐색 구조에 "키 → 그 행의 주소(RID)"를 담아 두는 것입니다.

> **핵심 정의**: (PostgreSQL·db-hobby 같은 힙 기반에서) 인덱스는 "키 → RID" 매핑을 담은, **데이터와 분리된 정렬 탐색 구조**다. 힙은 순서 없이 행을 쌓아두고, 인덱스가 그 위에 정렬된 길을 따로 깔아 O(log n) 조회를 만든다. (InnoDB의 클러스터드 인덱스는 리프에 데이터 자체가 있어 이 정의가 조금 다르다. [7편](/blog/project/db-hobby/db-internals-07-storage-engines)에서 대조한다.)

말보다 숫자부터 봅시다. 같은 한 행을 두 길로 찾으며 테이블 크기 N을 키워 실측하면(C 구현, `-O2`):

| 테이블 크기 N | 인덱스 점 조회 | 풀 스캔 | 배율 |
|---|---|---|---|
| 1,000 | 3.25 µs | 34.21 µs | 11배 |
| 10,000 | 5.05 µs | 274.28 µs | 54배 |
| 100,000 | 7.52 µs | 3,126.74 µs | **416배** |

(이 수치는 warm 캐시, 즉 페이지가 버퍼 풀에 상주한 상태 기준입니다. 콜드 캐시에서 진짜 디스크 I/O가 끼면 격차는 더 벌어집니다.)

숫자 하나하나보다 **두 열이 자라는 모양**이 핵심입니다. 풀 스캔 열은 N이 10배 될 때마다 거의 10배씩 뛰는, O(n)의 모양입니다. 인덱스 열은 N이 100배 되는 동안 2.3배밖에 안 느는, O(log n)의 로그 곡선입니다. 그래서 격차가 **N이 클수록 벌어집니다.** 인덱스의 가치는 데이터가 많아질수록 커집니다. 정확히 인덱스가 필요해지는 그 지점에서 말입니다.

이 편은 그 인덱스를 실제로 지으며 확인한 것들입니다. 왜 하필 B+Tree인지, 뭐가 가장 어려운지, 그리고 **유일성을 내려놓는 순간**(보조 인덱스) 어떤 가정들이 깨지는지 살펴봅니다.

## 1. 왜 이진 트리가 아니라 B+Tree인가: 디스크가 답이다

정렬된 탐색 구조라면 이진 탐색 트리(BST)도 되지 않을까요? 핵심은 **디스크**입니다.

인덱스도 페이지 단위로 디스크에 삽니다. 이진 트리를 **노드 = 페이지로 순진하게 저장하면**, 노드 하나에 키가 하나라 높이가 log₂(n)으로 깊습니다. 한 단계 내려갈 때마다 페이지를 한 번 읽어야 하니, 100만 행이면 최악의 경우 약 20번 페이지를 읽습니다(버퍼 풀에 올라온 페이지는 예외지만요).

**B+Tree**는 **노드 하나(=페이지 하나)에 키를 수십~수백 개** 담아 부채살처럼 갈라집니다(high fan-out, f). 높이가 log₂N이 아니라 **log_f N**입니다. 같은 100만 행이라도 fan-out이 수백이면 대략 3~4단에 그칩니다(8KB 페이지 기준). **"한 번의 디스크 I/O로 가능한 많은 키를 본다"**, 이게 B+Tree의 전부입니다.

> **실무/면접 포인트**: 이 "3~4단"은 암산으로 나옵니다. 8KB 페이지에 엔트리(키+포인터) 하나가 수십 바이트면 fan-out은 수백입니다. 300으로 잡으면 300³ ≈ 2,700만, 300⁴ ≈ 81억. 그래서 "수천만~수십억 행도 트리 높이는 3~4"라는 감이 섭니다. 게다가 루트·내부 노드는 거의 항상 버퍼 풀에 상주하니, 점 조회의 실제 디스크 I/O는 리프 근처 1~2번입니다.

구조는 두 종류의 노드로 나뉩니다.

- **내부 노드**는 길잡이만 합니다. "키 + 자식 포인터"를 들고 찾는 키를 아래로 내려보냅니다. 실제 값(RID)은 없습니다.
- **리프 노드**에는 진짜 "키 → RID"가 여기 있고, **옆 리프와 사슬로 연결**돼 있습니다(`next_leaf`). 이 사슬이 범위 스캔의 핵심입니다(3절).

![B+Tree 구조: 내부 노드에서 리프로 내려가는 검색 경로](/uploads/project/db-hobby/btree-diagram.svg)

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

> **주의**: db-hobby는 노드당 키를 8개로 작게 잡았다. **분할이 자주 일어나 눈에 잘 보이게** 하려는 학습용 선택이다. 진짜 DB는 페이지를 꽉 채워 수백 개를 담는다. 키가 적든 많든 알고리즘은 한 글자도 안 바뀐다.

## 2. 가장 어려운 부분: 노드 분할

B+Tree에서 제일 까다로운 게 **노드 분할(split)** 입니다. 리프가 꽉 차면 반으로 쪼개고 가운데(분리) 키를 부모에게 올립니다. 부모도 꽉 차면 부모가 또 쪼개지고, 루트까지 전파됩니다. **루트가 쪼개질 때만 트리 높이가 1 자랍니다.**

여기서 B+Tree가 "균형(Balanced)"을 유지하는 비밀이 나옵니다. AVL처럼 회전으로 맞추는 게 아니라, **위가 아니라 아래(리프)에서 자라기 때문에** 모든 리프가 항상 같은 깊이입니다. 한쪽으로 절대 기울지 않습니다.

리프 분할은 뒤 절반을 새 리프로 옮기고, 그 첫 키를 부모로 **복사(copy up)** 합니다. 리프엔 실제 값이 있으니 키가 양쪽에 남아야 하기 때문입니다.

```c
/* 리프 분할: 뒤 절반을 새 리프로 옮기고 첫 키를 위로 복사 */
r->next_leaf = n->next_leaf;   /* 새 리프가 사슬을 이어받고 */
n->next_leaf = rpid;           /* 옛 리프는 새 리프를 가리킨다 */
*sep_out = r->keys[0];         /* 부모로 올라갈 분리 키 (복사) */
```

내부 노드 분할은 미묘하게 다릅니다. 가운데 키를 복사가 아니라 **위로 올려보냅니다(push up).** 내부 노드의 키는 길잡이일 뿐이라 양쪽에 둘 필요가 없습니다.

> **핵심 구분**: 리프는 copy up, 내부는 push up. 이 차이가 **B+Tree**(값은 리프에만, 리프끼리 옆으로 연결)와 **B-Tree**(값이 내부 노드에도 들어감)를 가르는 지점이기도 하다. PostgreSQL nbtree·InnoDB 모두 B+Tree 계열이다. 더 정확히 말하면 PostgreSQL nbtree는 **Lehman-Yao B-link tree**로, 모든 노드가 우측 형제로 가는 링크를 하나 더 들고, 분할과 동시 탐색이 겹치는 순간을 이 링크가 구한다. 그 latch 이야기는 [8편(병렬 실행)](/blog/project/db-hobby/db-internals-08-parallel)에서 다룬다.

분할 "비율"도 실전 다이얼입니다. db-hobby는 항상 반반으로 쪼개지만, PostgreSQL은 **최우측 리프**가 차면 90/10으로 쪼갭니다. 단조 증가 키(AUTO_INCREMENT, 타임스탬프)의 삽입은 항상 오른쪽 끝에서만 일어나니, 왼쪽에 반을 남겨봐야 영영 채워지지 않습니다.

> **실무 안티패턴**: 랜덤 UUIDv4를 InnoDB PK로 쓰는 것. InnoDB는 데이터 자체가 PK 순서로 정렬된 클러스터드 구조라, 랜덤 키는 삽입을 트리 전역에 흩뿌려 **분할 폭풍과 버퍼 풀 오염**(사실상 모든 리프가 워킹셋)을 부릅니다. 대안은 순차성 있는 키, 곧 AUTO_INCREMENT나 시간 정렬 UUIDv7입니다. 힙 vs 클러스터드가 이 비용을 어떻게 가르는지는 [7편](/blog/project/db-hobby/db-internals-07-storage-engines)에서 실측합니다.

디스크에 저장되는 이 트리에 키 1000개를 넣어 다단계 분할을 일으킨 뒤, 리프 사슬을 따라 끝까지 훑어 "정렬이 한 번도 깨지지 않았는지"로 구조 무결성을 검증했습니다. 분할이 루트까지 전파돼도 **리프 전체는 여전히 하나의 정렬된 사슬**이라는 게 핵심입니다.

## 3. 범위 스캔: 리프 사슬이 빛나는 순간

`WHERE id = 2` 같은 점 조회는 루트에서 리프로 내려가 한 줄(O(log n))입니다. **리프 사슬이 빛나는 순간**은 범위 스캔입니다. `id > 5`면 5가 들어갈 리프로 **한 번만** 내려간 뒤, 거기서부터 `next_leaf`를 타고 옆으로 끝까지 읽습니다. 트리를 다시 탐색할 필요가 전혀 없습니다.

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

정직한 경계가 하나 있습니다. db-hobby의 리프 사슬은 `next_leaf` **단방향**이라, 역방향 스캔(`ORDER BY ... DESC`)은 이 구조로 못 받습니다. PostgreSQL의 리프는 양방향 링크라 거꾸로도 훑습니다.

해시 인덱스가 절대 못 하는 게 바로 이겁니다. 해시는 순서를 안 지키니 `>`도 `ORDER BY`도 통째로 안 됩니다. SQL은 범위 질의가 너무 흔해서, "점 조회 + 범위 + 정렬"을 한 구조로 다 받는 B+Tree가 기본값이 됐습니다.

| | B+Tree (PG·InnoDB·db-hobby) | 해시 인덱스 | LSM-tree (RocksDB·Cassandra) |
|---|---|---|---|
| 점 조회 `= 5` | O(log n) | **O(1)** | 여러 SSTable 후보 탐색(Bloom filter로 완화), 최악은 느림 |
| 범위·정렬 | 됨 (리프 사슬) | **안 됨** | 됨 (정렬된 SSTable) |
| 쓰기 패턴 | 무작위 쓰기 | 무작위 쓰기 | **순차 쓰기** (append) |
| 적합 워크로드 | 읽기·쓰기 균형 + 트랜잭션 | 점 조회 전용 | 쓰기 폭주 + 로그성 |

> **흔한 오해 정정**: *"PostgreSQL 해시 인덱스는 쓰면 안 되는 물건이다?"* 이건 10 이전 얘기입니다. 그때는 해시 인덱스가 WAL 로깅이 안 돼 크래시에 유실되고 복제도 안 됐지만, PostgreSQL 10부터는 WAL 로깅되어 크래시에 안전하고 복제도 됩니다. 다만 등호 조회밖에 못 받는 건 구조 그대로라, 범위나 정렬이 하나라도 필요하면 여전히 B-Tree입니다.

LSM은 무작위 쓰기를 순차 쓰기로 바꾸는 정반대 내기인데, 이 갈림길은 [7편(저장 엔진의 세 철학)](/blog/project/db-hobby/db-internals-07-storage-engines)에서 직접 구현해 대조합니다.

## 4. 유일성을 내려놓으면: 중복 키와 하한 탐색

여기까지의 인덱스는 PK(유일 키) 전용입니다. 그런데 실무에서 인덱스를 거는 컬럼은 대부분 PK가 아닙니다. `email`, `status`, `created_at` 같은, **유일하지 않은** 컬럼입니다. "보조 인덱스가 어렵다"의 정체가 바로 이 비유니크성입니다. PK 인덱스가 "유일하다"는 사실에 기대 조용히 넘어가던 가정들이 하나씩 깨집니다.

| | PK 인덱스 | 보조 인덱스 |
|---|---|---|
| 키 | 유일 | 중복 가능 |
| 한 키의 RID | 하나 | 여럿 |
| 탐색 | 하나 찾으면 끝 | **하한 탐색 + 사슬 훑기** |
| 조회 후 | 바로 사용 | **힙 재검사 필요** |

### 쓰기는 플래그 하나, 읽기가 진짜 문제

나이 20인 사람이 셋이면 키 20에 RID가 셋 달려야 합니다. 쓰기는 "같은 키면 덮어쓴다"를 "같은 키도 새 항목으로 추가한다"로 바꾸는 플래그 하나로 끝납니다(`btree_insert_dup`). **진짜 문제는 읽기입니다.** 중복 키는 리프 분할 때문에 **여러 리프에 흩어집니다.**

20이 잔뜩 쌓여 리프가 쪼개지면 분리키가 하필 20이 될 수 있습니다. 그러면 20짜리 항목이 왼쪽 리프에도 오른쪽 리프에도 걸칩니다. 유니크 검색처럼 "분리키와 같으면 오른쪽으로(`>=`)" 내려가면 **왼쪽에 흩어진 20들을 놓칩니다.**

그래서 **하한 탐색(lower bound)** 이 필요합니다. 분리키와 같으면 오른쪽으로 넘어가지 않고(`>` 비교) 왼쪽 자식으로 내려가, 20이 시작될 수 있는 **가장 왼쪽 리프**에 닿은 뒤, 리프 사슬을 오른쪽으로 훑으며 20을 다 모으고 21을 만나면 멈춥니다.

```c
while (i < n->num_keys && key > n->keys[i]) {  /* '>=' 아니라 '>' */
    i++;
}
```

> **주의**: `>=`를 `>`로 바꾸는 한 글자가 전부처럼 보이지만, 이게 안 되면 결과가 **조용히 일부만** 나온다. 에러도 안 나고 그냥 행 몇 개가 빠진다. 인덱스 버그 중 가장 잡기 어려운 종류, 곧 **"틀린 결과를 멀쩡한 얼굴로 돌려주는" 버그**다. 같은 키 50개를 일부러 여러 리프로 쪼갠 뒤 전부 찾아지는지가 이 코드의 회귀 테스트다.

> **흔한 오해 정정**: *"실제 DB도 중복 키를 이렇게 하한 탐색으로 푼다?"* 방향이 반대입니다. db-hobby는 유일성을 **내려놓고** 읽기 쪽(하한 탐색)을 고치는 길을 갔지만, 실제 DB는 유일성을 **인공적으로 복원**합니다. PostgreSQL은 12부터 모든 인덱스 엔트리에 heap TID를 마지막 정렬 컬럼처럼 붙입니다. nbtree README의 표현 그대로 *"heap TID is treated as a tiebreaker column"*이라, 트리 안의 모든 엔트리가 (키, TID) 조합으로 다시 유일해지고, "같은 키 어디로 내려가지?"라는 문제 자체가 사라집니다. 13부터는 같은 키의 엔트리들을 deduplication으로 압축까지 합니다. InnoDB는 보조 인덱스 키 뒤에 PK를 suffix로 붙여 같은 효과를 냅니다.

| | db-hobby | PostgreSQL (12+) | InnoDB |
|---|---|---|---|
| 중복 키 전략 | 중복 허용 + 하한 탐색 | heap TID를 tiebreaker 컬럼으로 → 전 엔트리 유일 | 보조 인덱스 키 + PK suffix → 유일 |
| 추가 장치 | 없음 | 13+ deduplication 압축 | 없음 |

참고로 인덱스는 재시작에도 살아남아야 하므로, "이 테이블엔 age_idx가 age 컬럼에 있다"는 정의를 카탈로그에 적고 인덱스 자체는 별도 파일에 둡니다. PostgreSQL이 `pg_class`/`pg_index`에 메타데이터를 적고 인덱스를 별도 relation(relfilenode 파일)에 두는 것과 같은 분리입니다.

## 5. 인덱스는 후보일 뿐: 재검사, 진실은 힙에 있다

보조 인덱스가 준 RID를 곧이곧대로 믿으면 안 됩니다. 이유가 셋입니다.

| # | 왜 RID를 못 믿나 | 어떻게 거르나 |
|---|---|---|
| 1 | 삭제된 행의 stale 항목이 남아 있을 수 있음 | `heap_get` 실패로 걸러짐 |
| 2 | UPDATE로 값이 바뀌어 옛 항목이 남아 있을 수 있음 | WHERE 재평가로 거름 |
| 3 | 빈 슬롯을 새 행이 재사용하면 옛 RID가 엉뚱한 행을 가리킴 | WHERE 재평가로 거름 |

그래서 후보 RID마다 힙에서 행을 읽고 **WHERE를 다시 평가**해 진짜 맞는 행만 내보냅니다. 이게 **재검사(recheck)** 입니다.

> **핵심**: **"인덱스는 후보를 좁히고, 진실은 힙에 있다."** 이게 인덱스 스캔의 본질이다. 이 원칙 덕에 B+Tree에 삭제 기능이 없어도, stale 항목이 남아 있어도 결과는 정확하다.

실제 DB와의 대조를 정확히 하면, PostgreSQL의 recheck는 인덱스가 후보만 보장하는 lossy 케이스(GIN/GiST/BRIN, Bitmap Heap Scan)에서 주로 나오고 B-tree 등식 스캔엔 보통 recheck가 없습니다. db-hobby의 재검사는 stale RID(tombstone·슬롯 재사용) 때문이라 *이유*는 다르지만, "인덱스는 좁히고 최종 판정은 실제 행으로"라는 아이디어는 같습니다.

그리고 이 원칙은 나중에 더 크게 돌아옵니다. [4편(MVCC)](/blog/project/db-hobby/db-internals-04-mvcc)에서 UPDATE가 행의 새 버전을 만들기 시작하면, **PK 인덱스조차 한 키에 여러 RID(버전들)를 매다는 멀티맵**이 됩니다. 인덱스는 버전 후보들을 주고, 어느 버전이 "보이는지"는 힙의 가시성 게이트가 판정합니다. "인덱스는 단순 key→value가 아니다"라는 이 편의 부제가 그 얘기입니다.

## 6. 플래너의 씨앗: 연산자 하나로 실행 계획이 갈린다

인덱스를 실행기에 연결하면 쿼리 플래너의 씨앗이 생깁니다.

| WHERE 조건 | 실행 계획 |
|---|---|
| `id = 2` | 점 조회 (`btree_search` → `heap_get`) |
| `id > 5`, `>=` | 범위 스캔 (`btree_seek_scan`, 리프 사슬) |
| `id < 5`, `<=` | 범위 스캔 (맨 왼쪽 리프부터) |
| `age = 20` (보조) | `find_all` + 힙 재검사 |
| 그 외 (`!=`·복합) | 풀 스캔 |

다만 이건 "쓸 수 있으면 무조건 인덱스"라는 **규칙 기반(RBO)** 의 가장 단순한 형태입니다. 진짜 플래너는 통계로 선택도를 추정해 **비용**으로 고릅니다. `id > 1`처럼 대부분 행이 걸리는 조건이면 풀 스캔이 오히려 빠릅니다. 그 얘기는 [6편(비용 기반 옵티마이저)](/blog/project/db-hobby/db-internals-06-optimizer)에서 규칙이 실제로 틀리는 순간부터 시작합니다.

그리고 인덱스 자체도 공짜가 아닙니다. 인덱스가 하나 늘 때마다 모든 INSERT/UPDATE/DELETE가 그 B+Tree까지 함께 고쳐야 하니, 읽기 한 종류를 빠르게 하려고 **쓰기 전부에 세금을 매기는** 셈입니다. "일단 다 걸어두자"가 안 되는 이유입니다.

## 7. 정리

- **B+Tree인 이유는 디스크**: 노드=페이지, fan-out이 높이를 log_f N으로 무너뜨린다. "한 번의 I/O로 최대한 많은 키를."
- **분할이 균형의 비밀**: 리프에서 위로 자라니 모든 리프가 같은 깊이. 리프는 copy up, 내부는 push up(B+Tree vs B-Tree의 갈림).
- **리프 사슬**이 범위 스캔을 공짜로 만든다: 내려가긴 한 번, 나머진 옆으로. 해시가 못 하는 것.
- **유일성을 내려놓으면** 하한 탐색이 필요하다: `>=` 한 글자가 조용히 행을 잃게 만든다.
- **인덱스는 후보일 뿐, 진실은 힙에**: 재검사가 stale 항목을 무해화한다. MVCC가 오면 이 원칙이 인덱스의 생존 조건이 된다.
- **실측**: 인덱스 vs 풀 스캔 격차는 1천 행 11배 → 10만 행 416배. O(log n)의 가치는 N과 함께 자란다.

다음 편은 쓰기 경로의 대사건입니다. **쓰다가 전원이 꺼지면?** WAL과 크래시 복구, 그리고 fsync의 가격(같은 5천 행 적재가 23배 차이 나는 이유)을 다룹니다.

## 참고 (1차 자료 우선)

- [PostgreSQL Documentation: B-Tree Indexes (nbtree)](https://www.postgresql.org/docs/current/btree.html)
- [PostgreSQL Documentation: Index Access Method Interface](https://www.postgresql.org/docs/current/indexam.html)
- [PostgreSQL Documentation: Hash Indexes](https://www.postgresql.org/docs/current/hash-index.html)
- [PostgreSQL source: nbtree README](https://github.com/postgres/postgres/blob/master/src/backend/access/nbtree/README) — heap TID tiebreaker · deduplication · Lehman-Yao
- [MySQL 8.0 Reference: InnoDB Index Types](https://dev.mysql.com/doc/refman/8.0/en/innodb-index-types.html)
- Lehman & Yao, *Efficient Locking for Concurrent Operations on B-Trees* (ACM TODS, 1981)
- Goetz Graefe, *Modern B-Tree Techniques* (Foundations and Trends in Databases, 2011)
- 본 블로그: [DB 인덱스 ①: 기초와 EXPLAIN](/blog/theory/db-index-01-explain-basics) · [②: 스캔의 종류](/blog/theory/db-index-02-scan-types) · [③: Covering Index](/blog/theory/db-index-03-covering-index-ios) · [④: 복합 인덱스](/blog/theory/db-index-04-composite-leftmost) · [⑤: 클러스터형](/blog/theory/db-index-05-clustered-dbms)
- [db-hobby 코드 (GitHub)](https://github.com/dj258255/db-hobby) — `btree.c`

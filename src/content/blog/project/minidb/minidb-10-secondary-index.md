---
title: '보조 인덱스: PK가 몰래 기대던 가정들을 갚기'
titleEn: 'Secondary Indexes: Paying Back the Assumptions the PK Quietly Leaned On'
description: "관계형 DB를 C로 밑바닥부터 만든 minidb 시리즈. 3편의 B+Tree 인덱스는 첫 컬럼(PK)에만 걸렸다. 진짜 DB처럼 아무 컬럼에나 CREATE INDEX를 걸려면 네 단계가 필요했다 - 비유니크 키를 받는 B+Tree(중복이 분할로 흩어지는 문제와 하한 탐색), 기존 행으로 인덱스를 짓고 카탈로그에 영속화, INSERT/UPDATE가 인덱스를 함께 갱신하고 트랜잭션 롤백 시 되돌리는 WAL, 그리고 플래너가 그 인덱스를 골라 find_all + heap_get + WHERE 재검사로 거르는 인덱스 스캔. PK 인덱스가 유니크라서 조용히 기대던 가정들을 하나씩 갚는 과정이다."
descriptionEn: "Part 10 of building a relational database from scratch in C. The part-3 B+Tree only indexed the first column (PK). To CREATE INDEX on any column like a real DB took four stages: a B+Tree that accepts duplicate keys (and the lower-bound search needed because duplicates scatter across leaves on split), building the index from existing rows and persisting it in the catalog, INSERT/UPDATE maintaining it with transaction rollback via WAL, and the planner picking it for an index scan with find_all + heap_get + WHERE recheck. It's all about paying back the assumptions the unique PK index quietly relied on."
date: 2026-06-10
tags:
  - C
  - Database Internals
  - B-Tree
  - Index
  - Learning
category: project/minidb
coverImage: /uploads/project/minidb/cover.svg
draft: false
series: "minidb"
seriesOrder: 10
---

## 0. 들어가며 — 유일성이라는 특권을 내려놓을 때

[3편](/blog/project/minidb/minidb-3-index-wal)에서 B+Tree 인덱스를 만들었어요. 그런데 그 인덱스는 **첫 컬럼(PK)에만** 걸렸습니다. `WHERE id = 5`는 인덱스를 타도, `WHERE age = 20`은 풀 스캔이었죠. 진짜 DB는 `CREATE INDEX`로 아무 컬럼에나 인덱스를 겁니다. minidb에도 그걸 붙이는 데 네 단계가 걸렸는데, 단계가 많았던 이유가 흥미로워요.

> **이번 편의 테마**: **PK 인덱스가 "유니크하다"는 사실에 기대 조용히 넘어가던 가정들이, 보조 인덱스에선 하나씩 깨졌다.** 키가 안 겹친다는 가정, 한 키에 RID 하나라는 가정, 삭제·갱신해도 인덱스가 알아서 맞다는 착각. 보조 인덱스는 이 가정들을 하나씩 갚아 나가는 과정이었습니다.

보조 인덱스를 4단계로 짓습니다. 먼저 전체 지도부터 보고 가요.

| 단계 | 무엇을 갚는가 | 핵심 |
|---|---|---|
| **1. 중복 키 B+Tree** | "한 키에 값 하나" 가정 | `btree_insert_dup` + 하한 탐색(lower bound) |
| **2. CREATE INDEX + 카탈로그** | "한 번 짓고 끝" 가정 | 기존 행으로 빌드 + 재시작 영속화 |
| **3. DML 유지보수 + WAL** | "인덱스가 알아서 맞다" 착각 | INSERT/UPDATE 갱신, 인덱스 WAL |
| **4. 플래너 + 재검사** | "RID를 곧이곧대로 믿는다" 가정 | find_all + heap_get + WHERE recheck |

> **왜 보조 인덱스인가**: 실무에서 인덱스를 거는 컬럼은 대부분 PK가 아니에요. 자주 검색하는 `email`, `status`, `created_at` 같은 컬럼이죠. 이것들은 유니크하지 않고, 끊임없이 INSERT/UPDATE/DELETE의 영향을 받습니다. "보조 인덱스가 어렵다"의 정체가 바로 이 비유니크성과 유지보수예요. 실제 코드는 [btree.c](https://github.com/dj258255/db-hobby)와 db.c에 있습니다.

PK 인덱스와 보조 인덱스가 어디서 갈리는지 한눈에:

| | PK 인덱스 | 보조 인덱스 |
|---|---|---|
| 키 | 유일 | 중복 가능 |
| 탐색 | `btree_find`(하나) | `btree_find_all`(하한 탐색) |
| 한 키의 RID | 하나 | 여럿 |
| 조회 후 | 바로 사용 | 힙 재검사 필요 |
| UPDATE(RID 변경) | 영향 적음 | 모든 보조 인덱스 갱신 |

## 1. 같은 값이 여럿이다 — 중복 키 B+Tree

PK는 유일해요. 그래서 3편의 B+Tree는 "키 하나에 값 하나"였고, `btree_insert`는 같은 키가 들어오면 **덮어썼습니다**. PK에선 같은 키가 두 번 올 일이 없으니 이 덮어쓰기가 문제될 일도 없었죠.

그런데 `age` 같은 보조 인덱스 컬럼은 다릅니다. 나이 20인 사람이 셋이면, 키 20에 RID가 셋 달려야 해요. 덮어쓰면 둘이 사라집니다. 그래서 덮어쓰지 않고 같은 키도 새 항목으로 추가하는 `btree_insert_dup`을 만들었어요.

```c
int btree_insert(BTree *bt, bkey_t key, bval_t val) {
    return insert_root(bt, key, val, 0); /* 유니크: 같은 키는 갱신 */
}

int btree_insert_dup(BTree *bt, bkey_t key, bval_t val) {
    return insert_root(bt, key, val, 1); /* 비유니크: 같은 키도 새 항목으로 */
}
```

둘은 `allow_dup` 플래그 하나만 다릅니다. 리프에서 같은 키를 만났을 때 유니크면 값을 갱신하고 끝, 비유니크면 그 자리를 그냥 통과해 새 항목으로 끼워 넣어요.

```c
if (!allow_dup && i < n->num_keys && n->keys[i] == key) {
    n->u.values[i] = val; /* 유니크: 갱신. (비유니크면 아래로 떨어져 새 항목으로 삽입) */
    bufpool_unpin(bt->bp, pid, 1);
    return 0;
}
```

### 진짜 어려운 건 읽기였다

쓰기는 플래그 하나로 끝났는데, **읽기**에서 막혔어요. 키 20인 항목을 다 찾으려는데, 중복은 리프 분할 때문에 **여러 리프에 흩어집니다.**

20이 잔뜩 쌓여 리프가 쪼개지면, 분할의 경계 키(분리키)가 하필 20이 될 수 있어요. 그러면 20짜리 항목이 왼쪽 리프에도, 오른쪽 리프에도 걸칩니다. 3편의 검색은 분리키와 같으면 오른쪽으로 갔는데(`>=`), 그러면 왼쪽에 흩어진 20들을 놓쳐요.

> **핵심**: 같은 키가 하나뿐이면(유니크) 그 하나만 찾으면 그만이라 "어느 한쪽"만 가도 됐다. 비유니크에선 같은 키가 두 리프에 걸쳐 있을 수 있어서, "가장 왼쪽 후보부터 시작해 같은 값이 끝날 때까지 훑어야" 한다.

그래서 **하한 탐색(lower bound)** 이 필요했어요. 분리키와 같으면 오른쪽으로 넘어가지 않고(`>`, `>=` 아님) 왼쪽 자식으로 내려가, 20이 시작될 수 있는 가장 왼쪽 리프에 닿습니다.

```c
int btree_find_all(BTree *bt, bkey_t key, btree_visit_fn visit, void *ctx) {
    /* 하한 탐색: 같은 키가 여러 리프에 흩어질 수 있으니, 분리키와 같으면 오른쪽으로 넘어가지
     * 않고(>, >= 아님) 왼쪽 자식으로 내려가 가장 왼쪽 후보 리프에 닿는다. */
    page_id_t pid = bt->root;
    for (;;) {
        BTNode *n = fetch(bt, pid);
        if (n->is_leaf) { bufpool_unpin(bt->bp, pid, 0); break; }
        int i = 0;
        while (i < n->num_keys && key > n->keys[i]) { /* '>=' 아니라 '>' */
            i++;
        }
        page_id_t c = n->u.children[i];
        bufpool_unpin(bt->bp, pid, 0);
        pid = c;
    }
    /* 리프 체인을 오른쪽으로 훑으며 key와 같은 값만 모은다. key보다 커지면 끝. */
    while (pid != 0) {
        BTNode *n = fetch(bt, pid);
        for (int i = 0; i < n->num_keys; i++) {
            if (n->keys[i] < key) continue;
            if (n->keys[i] > key) { /* 정렬돼 있으니 더 볼 것 없음 */
                bufpool_unpin(bt->bp, pid, 0);
                return 0;
            }
            int r = visit(n->keys[i], n->u.values[i], ctx);
            if (r != 0) { bufpool_unpin(bt->bp, pid, 0); return r; }
        }
        page_id_t nxt = n->next_leaf;
        bufpool_unpin(bt->bp, pid, 0);
        pid = nxt;
    }
    return 0;
}
```

거기서부터 리프 체인을 오른쪽으로 훑으며 20을 다 모으고, 21을 만나면 멈춰요(정렬돼 있으니 더 볼 게 없으니까). 3편에서 만든 리프 체인(`next_leaf`)이 여기서 빛을 봅니다.

검증으로 같은 키 50개를 주변 키와 섞어 일부러 여러 리프로 쪼갠 뒤, `find_all`이 50개를 전부 찾는지 확인했어요.

> **주의**: `>=` 한 글자를 `>`로 바꾸는 게 전부처럼 보이지만, 이게 안 되면 결과가 **조용히 일부만** 나옵니다. 에러도 안 나고 그냥 행 몇 개가 빠져요. 인덱스 버그 중 가장 잡기 어려운 종류 — "틀린 결과를 멀쩡한 얼굴로 돌려주는" 버그입니다.

> 더 깊이: 인덱스가 데이터를 어떻게 정렬·탐색하는지, 클러스터형 인덱스와 보조 인덱스가 행을 가리키는 방식이 어떻게 다른지는 [DB 인덱스 ⑤: 클러스터형 인덱스와 DBMS별 차이](/blog/theory/db-index-05-clustered-dbms).

## 2. 한 번 짓고, 살아남기 — CREATE INDEX와 카탈로그

`CREATE INDEX age_idx ON t(age)`를 받으면, 그 시점에 **이미 들어 있는 행들**로 인덱스를 채워야 해요. 빈 인덱스를 만들고 "지금부터 들어오는 것만" 색인하면 기존 행이 영영 안 잡히니까요. 힙을 한 번 훑으며 각 행의 `age` 값과 RID를 `btree_insert_dup`으로 등록합니다.

```c
/* CREATE INDEX: 기존 행을 훑어 보조 인덱스를 채우는 콜백 */
static int secidx_build_visit(RID rid, const void *rec, uint16_t len, void *ctx_) {
    /* ... 행을 디코드해서 c->col 컬럼 값을 꺼낸 뒤 ... */
    btree_insert_dup(&c->si->tree, row[c->col].int_val, rid_encode(rid));
    return 0;
}
/* ... */
heap_scan(&t->heap, secidx_build_visit, &bc); /* 힙 전체를 한 번 훑어 빌드 */
```

### 재시작해도 살아남아야 한다

그다음이 중요해요 — **인덱스는 재시작해도 살아남아야 합니다.** 프로세스를 껐다 켜면 메모리에 있던 B+Tree는 사라지죠. 테이블 스키마가 카탈로그에 저장되듯, "이 테이블엔 age_idx라는 인덱스가 age 컬럼에 있다"도 카탈로그에 적어야, 다시 열 때 그 인덱스 파일을 도로 엽니다.

[2편](/blog/project/minidb/minidb-2-sql-engine)에서 카탈로그가 스키마 구조체를 통째로 파일에 직렬화한다고 했는데, 거기에 인덱스 정의(이름 + 컬럼)를 덧붙이는 것으로 영속화가 끝났어요.

인덱스는 자기 파일(`<db>.<테이블>.<인덱스명>.idx`)을 따로 씁니다. 파일을 어떻게 나눠 두었는지 정리하면:

| 구성요소 | 파일 |
|---|---|
| 테이블 데이터(힙) | `<db>.<테이블>.tbl` |
| PK 인덱스 | `<db>.<테이블>.idx` |
| 보조 인덱스 | `<db>.<테이블>.<인덱스명>.idx` |

힙·PK 인덱스와 똑같이 파일 단위로 분리해 두니, 코드를 거의 안 고치고 인덱스를 하나 더 얹을 수 있었어요. 1편에서 "테이블 하나 = 파일 하나"로 단순화한 설계가 여기서 배당금을 줍니다.

> **실무/면접 포인트**: PostgreSQL도 인덱스를 별도 relation(별도 파일)으로 둔다. `pg_class`/`pg_index` 카탈로그에 인덱스 메타데이터가 적히고, 인덱스 자체는 자기 relfilenode 파일에 산다. minidb의 "카탈로그에 정의를 적고 + 별도 .idx 파일에 데이터를 둔다"는 정확히 같은 분리다.

여기까지면 인덱스는 만들어지고 재오픈에도 살아남지만, 아직 **박제** 상태예요. 만든 순간의 행만 담겨 있고, 이후 INSERT는 인덱스를 모릅니다.

## 3. 계속 맞아야 한다 — DML 유지보수와 WAL

인덱스는 만든 순간 정확한 게 의미 없어요. 데이터가 바뀔 때마다 **계속** 맞아야 합니다. INSERT/UPDATE/DELETE 셋을 차례로 봐요.

### INSERT — 쉽다

새 행을 넣을 때 PK 인덱스에 등록하던 자리에서, 보조 인덱스에도 `(컬럼값 -> RID)`를 등록하면 끝이에요.

```c
btree_insert_dup(&t->sec[k].tree, in->values[col].int_val, rid_encode(rid));
```

### UPDATE — 여기서 한 번 데었다

minidb의 UPDATE는 가변 길이라 제자리 수정이 안 돼서, **옛 행을 지우고(tombstone) 새 행을 삽입**합니다. 즉 RID가 바뀌어요.

처음엔 "바뀐 컬럼의 인덱스만 갱신하면 되겠지" 했는데, 아니었어요. RID가 통째로 바뀌니, **인덱싱한 컬럼이 안 바뀌었어도** 그 인덱스가 옛 RID(이제 tombstone)를 가리키게 됩니다. 그러면 그 행이 검색에서 사라져요.

> **핵심**: 보조 인덱스는 "컬럼값 -> RID"의 매핑이다. RID가 **물리 위치**인 minidb(힙 모델)에선 UPDATE가 RID를 바꾸면 컬럼값이 그대로여도 그 매핑의 오른쪽(RID)이 낡는다. 그래서 UPDATE는 바뀐 컬럼과 무관하게 **모든 보조 인덱스에 새 RID를 다시 등록**해야 한다(InnoDB처럼 PK 값을 가리키는 구조라면 안 그래도 된다 — 아래 표).

```c
for (모든 보조 인덱스 k) {
    btree_insert_dup(&t->sec[k].tree, row[col].int_val, rid_encode(newrid));
}
```

이건 minidb가 RID를 물리 위치로 쓰는(힙 모델) 데서 오는 비용이에요. InnoDB처럼 보조 인덱스가 PK 값을 가리킨다면, UPDATE로 행이 옮겨져도 PK가 안 바뀌는 한 보조 인덱스를 건드릴 필요가 없죠. 두 모델의 트레이드오프가 여기서 드러납니다.

| | minidb·PostgreSQL (RID 모델) | InnoDB (PK 모델) |
|---|---|---|
| 보조 인덱스가 가리키는 것 | RID(물리 위치) | PK 값 |
| 행이 옮겨지면(UPDATE) | 모든 보조 인덱스 갱신 필요 | PK 안 바뀌면 그대로 |
| 보조 인덱스 조회 | 보조 -> RID -> 힙 (1번 점프) | 보조 -> PK -> 클러스터드 (PK 재탐색) |

### DELETE — 아무것도 안 해도 됐다

DELETE는 minidb에선 인덱스를 거의 안 건드려도 됐어요 — 정확히는 **지연 삭제(lazy deletion)** 를 택한 거예요. 삭제는 힙 행을 tombstone 처리할 뿐 인덱스 항목은 그냥 두고, 나중에 그 stale 항목을 따라가도 `heap_get`이 tombstone을 만나 걸러요(4단계). 다만 이건 보조 인덱스의 일반 성질이 아니라 구현 선택이에요 — 진짜 DB는 그 죽은 항목을 언젠가 VACUUM/purge로 정리해 공간을 회수합니다.

> **주의**: 이게 작동하는 건 **힙을 항상 최종 진실로 삼는 구조**(tombstone + 4단계 재검사) 덕분이다. 인덱스에 stale 항목이 남아 있어도 최종 판정을 인덱스가 아니라 실제 행으로 하니 결과가 정확하다. 그래서 minidb는 **B+Tree 물리 삭제를 구현하지 않아도 됐다**(PK 인덱스가 줄곧 그래 온 것과 같다) — 어디까지나 minidb의 구현 선택이고, 진짜 DB는 죽은 엔트리를 결국 정리·회수한다.

### WAL — 인덱스도 함께 묶기

마지막으로 **WAL**이에요. [3편·4편](/blog/project/minidb/minidb-4-transactions)에서 데이터와 PK 인덱스를 WAL로 묶어 트랜잭션이 원자적으로 커밋·롤백되게 했는데, 보조 인덱스도 자기 WAL로 똑같이 묶었습니다.

그래서 트랜잭션 안에서 INSERT한 인덱스 항목이, `ROLLBACK`하면 인덱스에서도 함께 사라져요. 데이터만 롤백되고 인덱스엔 항목이 남으면, 없는 행을 가리키는 인덱스가 되니까요. begin/commit/rollback과 autocommit 경로의 다섯 군데에, 데이터·PK 인덱스를 다루던 코드 옆에 보조 인덱스 루프를 나란히 더하는 일이었습니다.

> **실무/면접 포인트**: "인덱스도 트랜잭션의 원자성에 포함된다"가 핵심이다. 실제 DB에서 인덱스는 데이터와 같은 WAL(또는 redo log) 흐름에 들어가, 데이터와 인덱스가 따로 노는 순간이 없다. minidb는 데이터·PK·보조 인덱스가 각자 파일·WAL을 갖되, 커밋 시점에 함께 묶이는 구조로 이걸 흉내 냈다.

## 4. 드디어 빨라진다 — 플래너와 재검사

이제 쿼리가 실제로 인덱스를 쓰게 합니다. `WHERE age = 20`처럼 보조 인덱스 컬럼에 `=` 조건이 걸리면, 플래너가 그 인덱스를 골라 `find_all(20)`로 후보 RID들을 모아요.

```c
} else if (sec_index_for(t, tname, c0, pk_cond) >= 0) {
    /* 비PK 컬럼 = 값 -> 보조 인덱스 find_all + heap_get + WHERE 재검사 */
    int sk = sec_index_for(t, tname, c0, pk_cond);
    btree_find_all(&t->sec[sk].tree, c0->val.int_val, sec_scan_visit, &sc);
}
```

### 재검사(recheck) — PK 점 조회와 결정적으로 다른 한 가지

그런데 여기서 PK 점 조회와 결정적으로 다른 한 가지가 있어요 — **재검사(recheck)** 가 필요합니다. 보조 인덱스가 준 RID를 곧이곧대로 믿으면 안 돼요. 이유가 셋입니다.

| # | 왜 RID를 못 믿나 | 어떻게 거르나 |
|---|---|---|
| 1 | 삭제된 행의 stale 항목이 RID를 주는데 그 RID는 tombstone | `heap_get`이 실패해 걸러짐 |
| 2 | UPDATE로 값이 바뀌어 남은 옛 항목이 있을 수 있음 | WHERE를 다시 평가해 거름 |
| 3 | 삭제로 빈 슬롯을 새 행이 재사용하면, 옛 RID가 엉뚱한 행을 가리킴 | WHERE를 다시 평가해 거름 |

그래서 후보 RID마다 `heap_get`으로 행을 읽고, **WHERE를 다시 평가**해 진짜 맞는 행만 내보냅니다.

```c
static int sec_scan_visit(bkey_t key, bval_t val, void *ctx_) {
    SecScanCtx *s = ctx_;
    uint8_t recbuf[PAGE_SIZE];
    uint16_t len;
    if (heap_get(&s->t->heap, rid_decode(val), recbuf, &len) != 0) {
        return 0; /* 삭제된(tombstone) 행 -> 거름 (이유 1) */
    }
    Value row[SQL_MAX_COLS];
    decode_row(&s->t->schema, recbuf, row);
    if (where_matches(&s->t->schema, s->tname, s->where, row)) { /* 재검사 (이유 2·3) */
        print_row(s->out, &s->t->schema, row);
        s->count++;
    }
    return 0;
}
```

이건 실제 DB의 Bitmap Heap Scan 등에서 보이는 recheck와 **비슷한 아이디어**예요 — 인덱스는 "후보를 좁혀주는" 역할이고 최종 판정은 실제 행으로 한 번 더. 덕분에 B+Tree에 삭제 기능이 없어도, stale 항목이 남아 있어도 결과는 정확해요. 다만 *이유*는 좀 달라요: PostgreSQL의 recheck는 인덱스가 후보만 보장하는 lossy 인덱스(GIN/GiST/BRIN, Bitmap)에서 주로 나오고 B-tree 등식 스캔엔 보통 recheck가 없는데, minidb의 재검사는 stale RID(tombstone·슬롯 재사용) 때문이거든요.

> **핵심**: "인덱스는 후보를 좁히고, 진실은 힙에 있다"가 인덱스 스캔의 본질이다. 3단계에서 DELETE에 손 안 대도 됐던 것, B+Tree 삭제를 안 만들어도 됐던 것 모두 이 재검사가 받쳐 줬기에 가능했다.

### EXPLAIN과 일관성

그리고 [8편의 EXPLAIN](/blog/project/minidb/minidb-8-explain)에 이걸 드러냈어요.

```
EXPLAIN SELECT * FROM t WHERE age = 20;
Index Scan using age_idx on t  (age = 20, recheck)
```

EXPLAIN과 실행기가 "어떤 인덱스를 쓸지" 판단하는 함수(`sec_index_for`)를 **공유**하게 했습니다.

```c
} else if (can_index && sec_index_for(t, tname, c0, pk_cond) >= 0) {
    int sk = sec_index_for(t, tname, c0, pk_cond);
    fprintf(out, "Index Scan using %s on %s  (%s = %ld, recheck)\n", ...);
}
```

8편에서 세운 원칙 — 플랜이 실제 실행과 절대 안 어긋난다 — 을 여기서도 지켰어요. EXPLAIN이 "Index Scan"이라 말하면 실행기도 반드시 같은 인덱스를 씁니다. 둘이 같은 함수를 보니까요.

> 더 깊이: 옵티마이저가 인덱스 스캔과 풀 스캔 중 무엇을 고르는지, 인덱스만으로 끝내는 커버링 인덱스는 무엇인지는 [DB 인덱스 ②: 스캔의 종류와 옵티마이저의 선택](/blog/theory/db-index-02-scan-types)과 [③ Covering Index](/blog/theory/db-index-03-covering-index-ios).

## 5. 정직한 한계

지금까지가 다는 아니에요. 학습용이라 일부러 안 한 것, 못 한 것을 솔직히 적습니다.

- **INT 컬럼만.** B+Tree 키가 int64라, TEXT 컬럼 인덱스는 문자열 키 B+Tree가 필요해 아직 못 했습니다.
- **`=` 조건만.** 보조 인덱스로 범위(`age > 20`)는 아직 안 탑니다(PK는 됨). find_all을 범위 버전으로 확장하면 되는 다음 숙제예요.
- **NULL은 색인 안 함.** minidb는 단순화를 위해 NULL을 인덱싱하지 않습니다 — B+Tree 자체가 NULL을 못 담는 건 아니에요(실제 PostgreSQL·InnoDB는 NULL도 인덱스에 넣고, NULL 정렬 위치만 따로 정합니다).
- **비용 모델이 없음.** 인덱스가 항상 이득이라 가정하고 씁니다. 전체의 90%가 걸리는 조건이면 풀 스캔이 더 빠른데, 그 판단은 [DB 인덱스 ②](/blog/theory/db-index-02-scan-types)의 영역이에요.

## 6. 정리

보조 인덱스를 만들며 계속 마주친 건, **PK 인덱스가 유니크라서 그냥 넘어가던 것들**이었어요. 키가 안 겹친다는 가정, 한 키에 RID 하나라는 가정, 삭제·갱신해도 인덱스가 알아서 맞다는 착각. 보조 인덱스는 그 가정들을 하나씩 깨고 갚아 나가는 과정이었습니다.

네 단계로 정리하면:

- **중복 키 B+Tree** — `btree_insert_dup`으로 같은 키도 담고, 중복이 리프 분할로 흩어지니 **하한 탐색**으로 가장 왼쪽 후보부터 다 찾는다.
- **CREATE INDEX + 카탈로그** — 기존 행을 힙 스캔으로 빌드하고, 인덱스 정의를 카탈로그에 적어 재시작에 살아남는다(별도 .idx 파일).
- **DML 유지보수 + WAL** — INSERT는 쉽고, UPDATE는 RID가 바뀌어 **모든 보조 인덱스 갱신**, DELETE는 안 건드림(재검사가 거름). 인덱스도 트랜잭션 WAL에 묶인다.
- **플래너 + 재검사** — find_all로 후보를 모으고, **heap_get + WHERE recheck**로 진짜 행만 거른다. "인덱스는 후보를 좁히고, 진실은 힙에 있다."

같은 B+Tree인데, 유일성이라는 특권을 내려놓으니 할 일이 이렇게 많아진다는 걸 손으로 배웠어요.

## 참고

- [PostgreSQL Documentation: Index Access Method Interface (recheck, lossy)](https://www.postgresql.org/docs/current/indexam.html)
- [PostgreSQL Documentation: CREATE INDEX](https://www.postgresql.org/docs/current/sql-createindex.html)
- [PostgreSQL Documentation: Indexes (pg_index, secondary index as separate relation)](https://www.postgresql.org/docs/current/indexes.html)
- 본 블로그: [DB 인덱스 ②: 스캔의 종류와 옵티마이저의 선택](/blog/theory/db-index-02-scan-types) · [③ Covering Index](/blog/theory/db-index-03-covering-index-ios) · [⑤ 클러스터형 인덱스와 DBMS별 차이](/blog/theory/db-index-05-clustered-dbms)
- [minidb 코드 (GitHub)](https://github.com/dj258255/db-hobby)

<!-- EN -->

## 0. Introduction — When You Set Down the Privilege of Uniqueness

In [Part 3](/blog/project/minidb/minidb-3-index-wal) I built a B+Tree index. But that index only covered the **first column (the PK)**. `WHERE id = 5` used the index, while `WHERE age = 20` was a full scan. A real DB indexes any column with `CREATE INDEX`. Adding that to minidb took four stages, and why it took so many is the interesting part.

> **The theme of this part**: **the assumptions the PK index quietly leaned on because it is "unique" each broke, one by one, for a secondary index.** The assumption that keys never collide, that one key has one RID, the illusion that the index stays correct on its own through deletes and updates. A secondary index is the process of paying back those assumptions one at a time.

We build the secondary index in four stages. Here is the whole map first.

| Stage | What it pays back | Core |
|---|---|---|
| **1. Duplicate-key B+Tree** | "one value per key" | `btree_insert_dup` + lower-bound search |
| **2. CREATE INDEX + catalog** | "build once, done" | build from existing rows + survive restart |
| **3. DML maintenance + WAL** | "the index stays correct on its own" | INSERT/UPDATE upkeep, index WAL |
| **4. Planner + recheck** | "trust the RID as-is" | find_all + heap_get + WHERE recheck |

> **Why secondary indexes**: in practice the columns you index are mostly not the PK. They are columns you search often — `email`, `status`, `created_at`. These are not unique and are constantly hit by INSERT/UPDATE/DELETE. The essence of "secondary indexes are hard" is exactly this non-uniqueness and maintenance. The real code is in [btree.c](https://github.com/dj258255/db-hobby) and db.c.

Where the PK index and a secondary index part ways, at a glance:

| | PK index | Secondary index |
|---|---|---|
| Key | unique | duplicates allowed |
| Search | `btree_find` (one) | `btree_find_all` (lower bound) |
| RIDs per key | one | many |
| After lookup | use directly | heap recheck needed |
| UPDATE (RID change) | little impact | every secondary index updates |

## 1. The Same Value Appears Many Times — Duplicate-Key B+Tree

A PK is unique. So Part 3's B+Tree was "one value per key", and `btree_insert` **overwrote** when the same key came in. Since a PK never sees the same key twice, that overwrite never caused trouble.

But a secondary-index column like `age` is different. If three people are 20, key 20 must carry three RIDs. Overwriting loses two of them. So I made `btree_insert_dup`, which does not overwrite but adds the same key as a new entry.

```c
int btree_insert(BTree *bt, bkey_t key, bval_t val) {
    return insert_root(bt, key, val, 0); /* unique: same key updates */
}

int btree_insert_dup(BTree *bt, bkey_t key, bval_t val) {
    return insert_root(bt, key, val, 1); /* non-unique: same key as a new entry */
}
```

The two differ by a single `allow_dup` flag. When the leaf hits the same key, unique updates the value and stops; non-unique passes that spot through and inserts a new entry.

```c
if (!allow_dup && i < n->num_keys && n->keys[i] == key) {
    n->u.values[i] = val; /* unique: update. (non-unique falls through to insert as new) */
    bufpool_unpin(bt->bp, pid, 1);
    return 0;
}
```

### The Truly Hard Part Was Reading

Writing was one flag. **Reading** is where I got stuck. To find every entry with key 20, the catch is that duplicates **scatter across several leaves** because of leaf splits.

When lots of 20s pile up and a leaf splits, the split's boundary key (the separator) can end up being 20. Then entries of 20 straddle both the left and right leaf. Part 3's search went right when it equaled the separator (`>=`), and that misses the 20s scattered on the left.

> **Key point**: when there's only one entry per key (unique), finding that one is enough, so going to "either side" worked. With non-unique, the same key can straddle two leaves, so you must "start from the leftmost candidate and sweep until the value ends".

So I needed a **lower-bound search**. When it equals the separator, it does not cross right (`>`, not `>=`) but descends the left child, landing on the leftmost leaf where 20 could begin.

```c
int btree_find_all(BTree *bt, bkey_t key, btree_visit_fn visit, void *ctx) {
    /* Lower bound: duplicates may scatter across leaves, so on equal-to-separator do not
     * cross right (>, not >=) but descend the left child to the leftmost candidate leaf. */
    page_id_t pid = bt->root;
    for (;;) {
        BTNode *n = fetch(bt, pid);
        if (n->is_leaf) { bufpool_unpin(bt->bp, pid, 0); break; }
        int i = 0;
        while (i < n->num_keys && key > n->keys[i]) { /* '>', not '>=' */
            i++;
        }
        page_id_t c = n->u.children[i];
        bufpool_unpin(bt->bp, pid, 0);
        pid = c;
    }
    /* Sweep the leaf chain rightward, gathering only values equal to key. Stop past key. */
    while (pid != 0) {
        BTNode *n = fetch(bt, pid);
        for (int i = 0; i < n->num_keys; i++) {
            if (n->keys[i] < key) continue;
            if (n->keys[i] > key) { /* sorted, so nothing more to see */
                bufpool_unpin(bt->bp, pid, 0);
                return 0;
            }
            int r = visit(n->keys[i], n->u.values[i], ctx);
            if (r != 0) { bufpool_unpin(bt->bp, pid, 0); return r; }
        }
        page_id_t nxt = n->next_leaf;
        bufpool_unpin(bt->bp, pid, 0);
        pid = nxt;
    }
    return 0;
}
```

From there it sweeps the leaf chain rightward, gathers all the 20s, and stops on meeting 21 (sorted, so nothing more to see). The leaf chain (`next_leaf`) built in Part 3 pays off here.

To verify, I mixed 50 entries of the same key with surrounding keys to deliberately split them across several leaves, then confirmed `find_all` finds all 50.

> **Caution**: changing one character, `>=` to `>`, looks like the whole fix, but if it is wrong the result comes back **silently partial**. No error — just a few rows missing. The nastiest kind of index bug: one that returns a wrong result with a straight face.

> Deeper: how an index sorts and searches data, and how clustered vs secondary indexes differ in pointing at rows: [DB Index ⑤: Clustered Index and Per-DBMS Differences](/blog/theory/db-index-05-clustered-dbms).

## 2. Build Once, and Survive — CREATE INDEX and the Catalog

When `CREATE INDEX age_idx ON t(age)` arrives, you must fill the index with **the rows already present** at that moment. If you make an empty index and only index "what comes from now on", existing rows are never caught. We scan the heap once and register each row's `age` value and RID via `btree_insert_dup`.

```c
/* CREATE INDEX: callback that scans existing rows to fill the secondary index */
static int secidx_build_visit(RID rid, const void *rec, uint16_t len, void *ctx_) {
    /* ... decode the row, pull out column c->col's value ... */
    btree_insert_dup(&c->si->tree, row[c->col].int_val, rid_encode(rid));
    return 0;
}
/* ... */
heap_scan(&t->heap, secidx_build_visit, &bc); /* one full heap scan to build */
```

### It Must Survive a Restart

Next comes the important part — **the index must survive a restart.** Restart the process and the in-memory B+Tree is gone. Just as the table schema is stored in the catalog, "this table has an index named age_idx on the age column" must also be written to the catalog, so on reopen we reopen that index file.

In [Part 2](/blog/project/minidb/minidb-2-sql-engine) I said the catalog serializes the whole schema struct to a file; appending the index definition (name + column) finished the persistence.

The index uses its own file (`<db>.<table>.<index>.idx`). Here is how the files split:

| Component | File |
|---|---|
| Table data (heap) | `<db>.<table>.tbl` |
| PK index | `<db>.<table>.idx` |
| Secondary index | `<db>.<table>.<index>.idx` |

Splitting per file just like the heap and PK index meant I could bolt on one more index with almost no code changes. The Part-1 "one table = one file" simplification pays dividends here.

> **Practical/interview note**: PostgreSQL also keeps an index as a separate relation (a separate file). Index metadata is written in the `pg_class`/`pg_index` catalogs, and the index itself lives in its own relfilenode file. minidb's "write the definition in the catalog + keep the data in a separate .idx file" is exactly the same split.

This far, the index is built and survives reopen, but it is still **taxidermied**. It holds only the rows as of build time, and later INSERTs know nothing of it.

## 3. It Must Stay Correct — DML Maintenance and WAL

An index being correct only at build time is meaningless. It must stay correct **continuously** as data changes. Let's walk INSERT/UPDATE/DELETE in turn.

### INSERT — Easy

Right where you register a new row in the PK index, also register `(column value -> RID)` in the secondary index. Done.

```c
btree_insert_dup(&t->sec[k].tree, in->values[col].int_val, rid_encode(rid));
```

### UPDATE — This Burned Me Once

minidb's UPDATE cannot edit in place (variable length), so it **deletes the old row (tombstone) and inserts a new one** — meaning the RID changes.

At first I thought "I only need to update the index for the changed column." Wrong. Since the RID changes wholesale, **even if the indexed column did not change**, that index ends up pointing at the old RID (now a tombstone). And then that row vanishes from search.

> **Key point**: a secondary index is a mapping "column value -> RID". In minidb, where the RID is a **physical location** (the heap model), when UPDATE changes the RID the right side (RID) of that mapping goes stale even if the column value is unchanged. So UPDATE must **re-register the new RID in every secondary index**, regardless of which column changed (a structure that points at the PK value, like InnoDB, avoids this — see the table below).

```c
for (every secondary index k) {
    btree_insert_dup(&t->sec[k].tree, row[col].int_val, rid_encode(newrid));
}
```

This is the cost of minidb using the RID as a physical location (the heap model). If a secondary index pointed at the PK value like InnoDB, there would be no need to touch it on an UPDATE-induced move as long as the PK is unchanged. The trade-off of the two models shows here.

| | minidb·PostgreSQL (RID model) | InnoDB (PK model) |
|---|---|---|
| What the secondary index points at | RID (physical location) | PK value |
| When a row moves (UPDATE) | every secondary index must update | unchanged if PK unchanged |
| Secondary lookup | secondary -> RID -> heap (one jump) | secondary -> PK -> clustered (re-search by PK) |

### DELETE — Nothing to Do

DELETE, in minidb, barely touches the index — more precisely, it's a **lazy-deletion** choice. A delete just tombstones the heap row and leaves the index entry alone, and even if you later follow that stale entry, `heap_get` meets the tombstone and filters it (Stage 4). But this is an implementation choice, not a general property of secondary indexes — a real DB eventually cleans up those dead entries via VACUUM/purge and reclaims the space.

> **Caution**: this works thanks to a **structure that always treats the heap as the final truth** (tombstone + the Stage-4 recheck). The result stays correct even with stale entries because the final verdict is made on the real row, not the index. That is why minidb **did not have to implement physical B+Tree deletion** (exactly as the PK index has done all along) — but that is minidb's implementation choice; a real DB eventually cleans up and reclaims dead entries.

### WAL — Bind the Index In Too

Finally, **WAL**. In [Parts 3 and 4](/blog/project/minidb/minidb-4-transactions) I bound data and the PK index with WAL so transactions commit/rollback atomically; I bound the secondary index the same way with its own WAL.

So an index entry INSERTed inside a transaction also disappears from the index on `ROLLBACK`. If only the data rolled back and the entry stayed, the index would point at a nonexistent row. It was a matter of adding a secondary-index loop alongside the data/PK-index code at five spots across the begin/commit/rollback and autocommit paths.

> **Practical/interview note**: the key is "the index is part of the transaction's atomicity". In a real DB the index joins the same WAL (or redo log) stream as the data, so there is never a moment where data and index drift apart. minidb mimics this by giving data, PK, and secondary indexes their own files/WAL but binding them together at commit.

## 4. Finally It Gets Fast — Planner and Recheck

Now we make a query actually use the index. When a `=` condition lands on a secondary-index column like `WHERE age = 20`, the planner picks that index and gathers candidate RIDs with `find_all(20)`.

```c
} else if (sec_index_for(t, tname, c0, pk_cond) >= 0) {
    /* non-PK column = value -> secondary index find_all + heap_get + WHERE recheck */
    int sk = sec_index_for(t, tname, c0, pk_cond);
    btree_find_all(&t->sec[sk].tree, c0->val.int_val, sec_scan_visit, &sc);
}
```

### Recheck — The One Thing Decisively Different from a PK Point Lookup

Here is the one thing decisively different from a PK point lookup — a **recheck** is needed. You must not trust the RID the secondary index gives as-is. Three reasons.

| # | Why the RID can't be trusted | How it's filtered |
|---|---|---|
| 1 | a deleted row's stale entry gives an RID that is a tombstone | `heap_get` fails and filters it |
| 2 | an old entry left behind by an UPDATE may remain | re-evaluate WHERE and drop it |
| 3 | if a new row reuses an emptied slot, the old RID points at the wrong row | re-evaluate WHERE and drop it |

So for each candidate RID we read the row with `heap_get` and **re-evaluate WHERE**, emitting only the truly matching rows.

```c
static int sec_scan_visit(bkey_t key, bval_t val, void *ctx_) {
    SecScanCtx *s = ctx_;
    uint8_t recbuf[PAGE_SIZE];
    uint16_t len;
    if (heap_get(&s->t->heap, rid_decode(val), recbuf, &len) != 0) {
        return 0; /* deleted (tombstone) row -> filtered (reason 1) */
    }
    Value row[SQL_MAX_COLS];
    decode_row(&s->t->schema, recbuf, row);
    if (where_matches(&s->t->schema, s->tname, s->where, row)) { /* recheck (reasons 2·3) */
        print_row(s->out, &s->t->schema, row);
        s->count++;
    }
    return 0;
}
```

This is a **similar idea** to the recheck seen in a real DB's Bitmap Heap Scan — the index "narrows candidates", and the final verdict is made once more on the real row. Thanks to that, the result is correct even without B+Tree deletion and even with stale entries lying around. The *reason* differs, though: PostgreSQL's recheck shows up mainly with lossy indexes (GIN/GiST/BRIN, Bitmap) that only guarantee candidates, and a B-tree equality scan usually has no recheck — whereas minidb's recheck is for stale RIDs (tombstones, slot reuse).

> **Key point**: "the index narrows candidates, the truth lives in the heap" is the essence of an index scan. Not touching DELETE in Stage 3, not implementing B+Tree deletion — all of it was possible because this recheck backs it up.

### EXPLAIN and Consistency

And I surfaced this in [Part 8's EXPLAIN](/blog/project/minidb/minidb-8-explain).

```
EXPLAIN SELECT * FROM t WHERE age = 20;
Index Scan using age_idx on t  (age = 20, recheck)
```

I made EXPLAIN and the executor **share** the function that decides "which index to use" (`sec_index_for`).

```c
} else if (can_index && sec_index_for(t, tname, c0, pk_cond) >= 0) {
    int sk = sec_index_for(t, tname, c0, pk_cond);
    fprintf(out, "Index Scan using %s on %s  (%s = %ld, recheck)\n", ...);
}
```

This upholds the principle set in Part 8 — the plan never diverges from actual execution. If EXPLAIN says "Index Scan", the executor must use the same index, because both look at the same function.

> Deeper: how the optimizer chooses between an index scan and a full scan, and what a covering index that finishes with the index alone is: [DB Index ②: Scan Types and the Optimizer's Choice](/blog/theory/db-index-02-scan-types) and [③ Covering Index](/blog/theory/db-index-03-covering-index-ios).

## 5. Honest Limits

This is not the whole story. Let me be honest about what I deliberately skipped or could not do, this being a learning project.

- **INT columns only.** The B+Tree key is int64, so a TEXT-column index needs a string-key B+Tree, which I have not done yet.
- **`=` conditions only.** A secondary index does not yet take ranges (`age > 20`) (the PK does). Extending find_all to a range version is the next homework.
- **NULL is not indexed.** minidb skips indexing NULL for simplicity — it's not that a B+Tree can't hold NULL (real PostgreSQL/InnoDB do index NULLs, just deciding where NULL sorts).
- **No cost model.** It assumes an index is always a win. If a condition matches 90% of everything, a full scan is faster — but that judgment belongs to [DB Index ②](/blog/theory/db-index-02-scan-types).

## 6. Wrap-up

Building the secondary index, what I kept running into were **the things the unique PK index just glossed over**. The assumption that keys do not collide, that one key has one RID, the illusion that the index stays correct on its own through deletes and updates. A secondary index was the process of breaking and paying back those assumptions one by one.

In four stages:

- **Duplicate-key B+Tree** — `btree_insert_dup` holds the same key too, and since duplicates scatter on leaf splits, a **lower-bound search** finds them all from the leftmost candidate.
- **CREATE INDEX + catalog** — build by heap-scanning existing rows, and write the index definition into the catalog to survive a restart (a separate .idx file).
- **DML maintenance + WAL** — INSERT is easy, UPDATE changes the RID so **every secondary index updates**, DELETE is left alone (recheck filters it). The index is bound into the transaction WAL.
- **Planner + recheck** — gather candidates with find_all, then keep only real rows with **heap_get + WHERE recheck**. "The index narrows candidates, the truth lives in the heap."

It is the same B+Tree, yet setting down the privilege of uniqueness made the work multiply this much — and I learned it by hand.

## References

- [PostgreSQL Documentation: Index Access Method Interface (recheck, lossy)](https://www.postgresql.org/docs/current/indexam.html)
- [PostgreSQL Documentation: CREATE INDEX](https://www.postgresql.org/docs/current/sql-createindex.html)
- [PostgreSQL Documentation: Indexes (pg_index, secondary index as separate relation)](https://www.postgresql.org/docs/current/indexes.html)
- This blog: [DB Index ②: Scan Types and the Optimizer's Choice](/blog/theory/db-index-02-scan-types) · [③ Covering Index](/blog/theory/db-index-03-covering-index-ios) · [⑤ Clustered Index and Per-DBMS Differences](/blog/theory/db-index-05-clustered-dbms)
- [minidb on GitHub](https://github.com/dj258255/db-hobby)
</content>
</invoke>

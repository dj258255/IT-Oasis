---
title: 'B+Tree를 동시에 타기 — latch crabbing(게처럼 기어가기)'
titleEn: 'Traversing a B+Tree Concurrently — Latch Crabbing'
description: "20편은 굵은 엔진 latch로 실행을 직렬화하며 끝났다. 그걸 계층별로 걷어내려면, 여러 스레드가 같은 B+Tree를 동시에 타도 안 깨지게 만들어야 한다. 그런데 트리는 버퍼 풀보다 어렵다 — 노드마다 latch를 걸어도, 순진하게 잡으면 교착이 나거나, reader가 '반쯤 쪼개진 트리'를 보고 엉뚱한 리프로 샌다. 해법이 latch crabbing(lock coupling)이다: 게가 앞다리로 바위를 잡고 뒷다리를 놓듯, 자식 latch를 먼저 잡은 뒤에야 부모 latch를 놓으며 내려간다. 삽입은 한 걸음 더 — 자식이 '안전'(여유 있어 안 쪼개짐)하면 조상 latch를 전부 놓고, 안 안전하면 붙들었다가 분할을 위로 전파한다. 이 알고리즘을 저장 세부 없이 격리한 인메모리 모듈로 구현하고, 분할 폭풍 속 8스레드 동시 삽입 + 읽기/쓰기 혼합을 ThreadSanitizer로 검증한다. 15-445 Project 2의 그 crabbing이다."
descriptionEn: "Part 20 ended by serializing execution behind one coarse engine latch. To peel that off layer by layer, many threads must be able to traverse the same B+Tree at once without corruption. But the tree is harder than the buffer pool — even with a latch per node, naive locking deadlocks, or a reader sees a 'half-split tree' and wanders into the wrong leaf. The answer is latch crabbing (lock coupling): like a crab gripping the next rock with its front legs before releasing its back legs, you latch the child before releasing the parent as you descend. Insert goes one step further — if the child is 'safe' (has room, won't split), release all ancestor latches; if not, hold them and propagate the split upward. We implement this algorithm as an in-memory module isolated from storage, and verify concurrent inserts under a split-storm plus mixed read/write with ThreadSanitizer. It's the crabbing from CMU 15-445 Project 2."
date: 2026-07-03
tags:
  - C
  - Database Internals
  - Concurrency
  - B+Tree
  - Latch Crabbing
  - ThreadSanitizer
  - Learning
category: study/db-hobby
coverImage: /uploads/project/db-hobby/cover.svg
draft: false
series: "db-hobby"
seriesOrder: 22
---

## 0. 들어가며 — 굵은 latch를 걷어내는 다음 계층

[20편](/blog/project/db-hobby/db-hobby-20-thread-safety)은 진짜 스레드를 켜되, SQL 실행을 **하나의 굵은 엔진 latch로 직렬화**하며 끝났어요. 커넥션은 병렬로 받지만 실행은 한 번에 하나. 그때 이렇게 적었죠 — *"이 굵은 latch를 계층별로 걷어내는 게 다음 일이고, 버퍼 풀 latch가 그 첫 발판이다."*

굵은 latch를 걷어내려면, 그 아래 자료구조들이 스스로 동시 접근을 견뎌야 합니다. 버퍼 풀은 20편에서 했어요(mutex 하나로 단순). 그런데 **B+Tree는 훨씬 어렵습니다** — 여러 스레드가 트리를 동시에 타고 내려가고, 그중 누군가는 노드를 쪼개거든요. 이 편은 그 문제의 정석 해법 — **latch crabbing** — 을 구현합니다. CMU 15-445 Project 2가 적대적 멀티스레드로 채점하는 바로 그 알고리즘이에요.

## 1. 왜 트리가 버퍼 풀보다 어려운가

버퍼 풀은 "프레임 테이블"이라는 **평평한 배열** 하나였어요 — mutex 하나로 감싸면 끝. 그런데 B+Tree는 **여러 노드를 순서대로 타고 내려가는** 구조입니다. 순진한 방법 둘 다 실패해요.

- **트리 전체에 락 하나**: 정확하지만 트리를 타는 동안 아무도 못 들어와요 — 굵은 엔진 latch를 트리 하나에 다시 만든 꼴. 병렬성 0.
- **노드마다 락, 그때그때 잡고 놓기**: reader가 루트를 읽고 놓은 뒤 자식으로 내려가는 사이에, writer가 그 자식을 **쪼개면** — reader는 옛 경로를 따라 **엉뚱한 리프**에 도착합니다. 찾는 키가 방금 생긴 오른쪽 형제로 옮겨갔을 수도 있어요. "반쯤 쪼개진 트리"를 본 겁니다.

핵심은 **"내려가는 도중 트리가 내 밑에서 바뀌면 안 된다"** 예요. 그렇다고 통째로 잠그면 병렬성이 죽고. 이 딜레마를 푸는 게 crabbing입니다.

## 2. 게처럼 기어가기 — 읽기 crabbing

**latch crabbing**(lock coupling)의 이름은 게(crab)에서 왔어요. 게가 절벽을 기어갈 때 **앞다리로 다음 바위를 꽉 잡은 뒤에야 뒷다리를 놓습니다** — 한 순간도 완전히 떨어지지 않아요. 트리 탐색도 똑같이 합니다: **자식 latch를 먼저 잡은 뒤에야 부모 latch를 놓는다.**

```c
int cbtree_search(CBTree *t, int64_t key, int64_t *out) {
    rlock(t->header);
    Node *cur = t->header->child[0];
    rlock(cur);
    unlock(t->header);
    while (!cur->is_leaf) {
        Node *c = cur->child[child_idx(cur, key)];
        rlock(c);       /* 자식을 먼저 잡고 */
        unlock(cur);    /* 그다음 부모를 놓는다 (lock coupling) */
        cur = c;
    }
    /* cur = 리프(rlatch 보유). 여기서 키를 찾고 놓는다. */
}
```

`rlock(c)` 다음에 `unlock(cur)` — 순서가 전부예요. 자식을 잡기 전까진 부모를 놓지 않으니, 내가 딛고 있는 경로가 내 밑에서 사라지지 않습니다. writer가 이 노드를 쪼개려면 write latch가 필요한데, 내가 read latch를 쥐고 있으면 writer는 내가 놓을 때까지 기다려요. 그리고 나는 자식으로 내려가며 부모를 즉시 놓으니, writer는 오래 안 기다립니다. **한 번에 최대 두 노드(부모+자식)만 latch를 쥐죠.**

그리고 항상 **루트→리프 한 방향**으로만 latch를 잡습니다. 위로 거슬러 잡는 일이 없으니 **교착(deadlock)이 원천적으로 불가능**해요 — lock ordering이 트리 깊이로 자연히 정해집니다.

## 3. 삽입은 한 걸음 더 — "안전한 노드"에서 조상을 놓는다

읽기는 노드를 안 바꾸니 두 노드만 잡으면 됐어요. 그런데 **삽입은 분할이 위로 번질 수 있습니다.** 리프가 꽉 차 쪼개지면 부모에 새 키가 끼고, 부모도 꽉 차면 또 쪼개지고… 루트까지 올라가면 트리 높이가 자라요([3편](/blog/project/db-hobby/db-hobby-3-index-wal)). 그래서 삽입은 **분할이 번질 수 있는 조상들의 latch를 미리 붙들고** 있어야 합니다.

그런데 무조건 루트부터 다 붙들면 병렬성이 죽어요. 열쇠는 **"안전한 노드"** 개념입니다:

> **안전(safe)하다** = 이 노드가 여유가 있어서(키가 꽉 안 참), 자식이 쪼개져 새 키가 올라와도 **이 노드는 안 쪼개진다.** 그러면 분할이 이 노드 위로는 절대 안 번진다.

내려가다가 **안전한 자식을 만나면, 그 위의 조상 latch를 전부 놓아도 됩니다** — 분할이 거기서 흡수될 게 확실하니까요.

```c
while (!cur->is_leaf) {
    Node *c = cur->child[child_idx(cur, key)];
    wlock(c);
    if (c->n < ORDER) {                 /* 안전: 여유 있음 -> 위로 안 번진다 */
        for (int k = 0; k < sp; k++) unlock(stack[k]);
        sp = 0;                          /* 붙들던 조상 latch를 전부 해제 */
    }
    stack[sp++] = c;                     /* 이 노드는 (혹시 몰라) 스택에 붙든다 */
    cur = c;
}
```

`c->n < ORDER`(꽉 안 참)면 스택의 조상들을 다 놓고 스택을 비웁니다. 안 안전하면(꽉 참) 조상을 계속 붙들죠. 그래서 리프에 도착했을 때 **스택엔 "분할이 번질 수 있는 연속된 조상들 + 리프"만** 남습니다. 리프에서 실제로 분할이 나면, 그 붙들어 둔 스택을 따라 위로 새 키를 전파해요.

대부분의 삽입은 리프가 안 꽉 차서 **latch를 두어 개만 쥐고 끝납니다.** 분할이 실제로 위로 번지는 드문 경우에만 여러 조상을 붙들고요. 이게 crabbing이 병렬성을 지키는 방식이에요 — 최악을 대비하되, 평상시엔 가볍게.

## 4. 루트가 쪼개질 때 — header 노드 트릭

분할이 루트까지 번지면 트리 높이가 자라고 **루트 포인터가 바뀝니다.** 여러 스레드가 동시에 루트를 참조하는데 그걸 어떻게 안전하게 갈아끼울까요? 우아한 트릭은 **가짜 header 노드**예요.

```c
struct CBTree {
    Node *header;   /* header->child[0] 이 진짜 루트 */
};
```

진짜 루트를 `header->child[0]`에 두고, 루트를 읽거나 바꾸려면 **항상 header latch를 먼저** 잡습니다. 그러면 루트 분할도 특별할 게 없어요 — header latch를 쥔 채 `header->child[0]`에 새 루트 포인터를 꽂으면 끝입니다.

```c
if (up_right) {                 /* 루트까지 분할이 번짐 */
    Node *nr = node_new(0);     /* 새 루트(높이 +1) */
    nr->key[0] = up_key;
    nr->child[0] = t->header->child[0];  /* 옛 루트 */
    nr->child[1] = up_right;             /* 쪼개져 생긴 오른쪽 */
    t->header->child[0] = nr;            /* header latch 아래에서 교체 */
}
```

삽입은 header부터 crabbing으로 내려오니, 루트가 분할될 상황이면 header가 스택 맨 아래에 latch된 채 남아 있어요 — 그래서 루트 교체가 언제나 안전합니다. "루트 포인터가 어디에도 안 매여 붕 뜨는" 특수 케이스가 사라지죠.

## 5. 증명 — 분할 폭풍 속에서 TSan으로

crabbing이 맞는지 어떻게 확신할까요? [20편](/blog/project/db-hobby/db-hobby-20-thread-safety)처럼 **ThreadSanitizer + 스트레스 테스트**입니다. 노드당 키를 4개로 작게 잡아 **분할이 끊임없이** 일어나게 하고, 8스레드가 동시에 삽입합니다.

```
$ make test-tsan
  ok   동시 삽입 8스레드×1000키: 전부 정확히 조회됨 (crabbing 무결성)
  ok   범위 스캔 총합 = N (리프 체인 온전)
  ok   쓰기 도중 읽기: 커밋된 키는 항상 찾힌다 (읽기가 분할에 안 깨짐)
전체 통과       ← ThreadSanitizer 경고 0
```

세 가지를 봅니다:

- **동시 삽입 무결성** — 8스레드가 분할을 유발하며 마구 넣어도, 끝나면 모든 키가 정확한 값으로 조회됩니다. crabbing이 틀려서 트리가 반쯤 쪼개진 채 굳으면 여기서 키가 사라져요.
- **리프 체인 온전** — 범위 스캔(리프 체인을 옆으로 훑기)의 총합이 정확. 분할이 `next` 포인터를 잘못 이으면 깨집니다.
- **읽기가 분할에 안 깨짐** — writer가 트리를 쪼개는 동안 reader가 이미 커밋된 키를 계속 찾는데, **한 번도 놓치지 않아요.** 읽기 crabbing이 "반쯤 쪼개진 트리"를 막는다는 증거입니다.

![latch crabbing — 읽기는 자식을 잡은 뒤에야 부모를 놓아(한 번에 최대 2노드) 반쯤 쪼개진 트리를 안 본다. 삽입은 자식이 안전(여유 있음)하면 조상 latch를 전부 놓고, 안 안전하면 붙들었다가 분할을 위로 전파한다. 루트 분할은 header 노드 트릭으로 포인터만 교체. 루트→리프 단방향이라 교착 불가](/uploads/project/db-hobby/latch-crabbing.svg)

## 6. 정직한 경계 — 아직 엔진엔 안 붙였다

솔직히 짚을 게 있어요. 이 동시성 B+Tree(`cbtree`)는 **엔진의 `btree.c`와 별개인 독립 모듈**입니다. 인메모리이고(디스크·버퍼 풀 없음), 엔진은 여전히 20편의 **굵은 엔진 latch로 직렬 실행**해요. 그럼 왜 이렇게 만들었냐면:

- **알고리즘을 격리하려고**. latch crabbing은 *저장*이 아니라 *노드 래칭*의 문제예요. 디스크·버퍼 풀·페이지 포맷을 걷어내고 crabbing만 순수하게 보이는 게 학습 가치가 큽니다.
- **회귀 위험 0**. 엔진의 `btree.c`를 안 건드리니, 400개 넘는 기존 테스트가 한 줄도 안 깨져요. 동시성 버그(재현이 지옥인)를 안정된 코어에 심을 위험을 피했습니다.

그래서 이건 "굵은 엔진 latch를 걷어낼 때 필요한 **기법을 독립적으로 증명한 것**"이에요. 진짜로 엔진의 디스크 B+Tree에 crabbing을 배선하려면, 노드 latch를 **버퍼 풀 프레임과 묶고**(페이지 latch), WAL·no-steal과의 상호작용까지 풀어야 합니다 — 그게 20편에서 말한 "여러 세션짜리 큰 재작성"의 정체예요. 이 편은 그 산을 오르기 위한 **로프를 먼저 묶은 것**입니다.

## 7. 정리 — 그리고 남은 산

| 항목 | db-hobby | 비고 |
|---|---|---|
| 읽기 crabbing (자식 잡고 부모 놓기) | O | 한 번에 최대 2노드, 교착 불가(단방향) |
| 쓰기 crabbing (안전 노드에서 조상 해제) | O | 평상시 가볍게, 분할 시만 조상 붙듦 |
| 루트 분할 (header 노드 트릭) | O | 루트 포인터 교체가 특수 케이스 아님 |
| 분할 폭풍 동시 삽입 + 혼합 읽기 | O | **ThreadSanitizer 클린** |
| 엔진 btree.c에 배선 | X | 페이지 latch + WAL 상호작용 = 큰 재작성 |
| 블로킹 락 매니저 | X | 엔진 latch 걷어낸 뒤에야 의미 |

이 편은 "여러 스레드가 같은 트리를 어떻게 안 깨고 타는가"라는, 동시성 자료구조의 대표 난제를 crabbing으로 풀었습니다. 게가 앞다리로 잡고 뒷다리를 놓듯 — 자식을 잡은 뒤에야 부모를 놓는 그 한 순서가 전부였어요. 그리고 삽입의 "안전한 노드에서 조상을 놓는다"가 병렬성과 정확성을 동시에 지키는 핵심이었고요.

[20편](/blog/project/db-hobby/db-hobby-20-thread-safety)의 버퍼 풀 latch, 이 편의 B+Tree crabbing — 굵은 엔진 latch를 걷어낼 **두 계층의 기법**이 이제 손에 있습니다. 남은 건 이것들을 엔진에 실제로 배선하고(페이지 latch·WAL 동시성), 락 매니저를 "즉시 거부"에서 "진짜 블로킹 대기"로 바꾸는 것 — 트랙 D의 마지막이자, 여러 세션에 걸친 큰 재작성이에요. db-hobby는 그 산의 로프를 하나씩 묶어 가고 있습니다.

## 참고

- [CMU 15-445/645 Database Systems — Project 2 (B+Tree Concurrent Index), latch crabbing](https://15445.courses.cs.cmu.edu/)
- [Lehman & Yao, "Efficient Locking for Concurrent Operations on B-Trees" (1981)](https://dl.acm.org/doi/10.1145/319628.319663)
- [The Internals of PostgreSQL: Concurrency in nbtree](https://www.interdb.jp/pg/index.html)
- 본 시리즈: [3편 B+Tree 인덱스](/blog/project/db-hobby/db-hobby-3-index-wal) · [20편 스레드 안전 버퍼 풀](/blog/project/db-hobby/db-hobby-20-thread-safety)

<!-- EN -->

## 0. Introduction — the Next Layer to Peel Off the Coarse Latch

[Part 20](/blog/project/db-hobby/db-hobby-20-thread-safety) turned on real threads but ended by **serializing SQL execution behind one coarse engine latch**. Connections are accepted in parallel, but execution runs one at a time. We wrote then: *"peeling that coarse latch off, layer by layer, is next — and the buffer pool latch is the first foothold."*

To peel the coarse latch off, the structures beneath it must survive concurrent access on their own. The buffer pool did in Part 20 (one simple mutex). But the **B+Tree is much harder** — many threads descend the tree at once, and some of them split nodes. This part implements the textbook answer — **latch crabbing** — the very algorithm CMU 15-445 Project 2 grades under adversarial multithreading.

## 1. Why the Tree Is Harder Than the Buffer Pool

The buffer pool was one **flat array** (the frame table) — wrap it in one mutex, done. But a B+Tree is a structure you **descend node by node**. Both naive approaches fail.

- **One lock on the whole tree**: correct, but nobody else can enter while you traverse — you've recreated the coarse engine latch on one tree. Zero parallelism.
- **A lock per node, grabbed and released as you go**: between a reader reading the root and descending to a child, a writer **splits that child** — and the reader follows the old path to the **wrong leaf**. The key it wants may have moved to the newly-created right sibling. It saw a "half-split tree."

The crux is **"the tree must not change under me while I descend."** But locking the whole thing kills parallelism. Crabbing resolves this dilemma.

## 2. Crawling Like a Crab — Read Crabbing

The name **latch crabbing** (lock coupling) comes from the crab. As a crab climbs a cliff, it **grips the next rock with its front legs before releasing its back legs** — never fully detached for even a moment. Tree traversal does the same: **latch the child before releasing the parent.**

```c
int cbtree_search(CBTree *t, int64_t key, int64_t *out) {
    rlock(t->header);
    Node *cur = t->header->child[0];
    rlock(cur);
    unlock(t->header);
    while (!cur->is_leaf) {
        Node *c = cur->child[child_idx(cur, key)];
        rlock(c);       /* grab the child first */
        unlock(cur);    /* then release the parent (lock coupling) */
        cur = c;
    }
    /* cur = leaf (rlatch held). find the key and release. */
}
```

`rlock(c)` then `unlock(cur)` — the order is everything. You never release the parent until the child is held, so the path you stand on never vanishes under you. For a writer to split this node it needs a write latch, and while you hold a read latch it must wait until you release. And you release the parent immediately as you descend, so the writer doesn't wait long. **You hold at most two nodes (parent + child) at once.**

And you always latch **root→leaf, one direction only**. You never latch upward, so **deadlock is structurally impossible** — the lock ordering is naturally the tree depth.

## 3. Insert Goes One Step Further — Release Ancestors at a "Safe Node"

Reads don't modify nodes, so two latches sufficed. But **inserts can propagate splits upward.** A full leaf splits, a new key goes into the parent, and if the parent is full it splits too… reach the root and the tree grows taller ([Part 3](/blog/project/db-hobby/db-hobby-3-index-wal)). So insert must **hold the latches of ancestors a split might reach.**

But holding everything from the root down kills parallelism. The key is the notion of a **"safe node":**

> A node is **safe** = it has room (not full), so even if its child splits and pushes up a new key, **this node won't split.** Then a split will never propagate above this node.

While descending, **when you meet a safe child, you can release all ancestor latches above it** — the split is guaranteed to be absorbed there.

```c
while (!cur->is_leaf) {
    Node *c = cur->child[child_idx(cur, key)];
    wlock(c);
    if (c->n < ORDER) {                 /* safe: has room -> won't propagate up */
        for (int k = 0; k < sp; k++) unlock(stack[k]);
        sp = 0;                          /* release all held ancestors */
    }
    stack[sp++] = c;                     /* keep this node on the stack (just in case) */
    cur = c;
}
```

If `c->n < ORDER` (not full), release the ancestors on the stack and empty it. If not safe (full), keep holding them. So when you reach the leaf, **the stack holds only "a contiguous run of ancestors a split could reach, plus the leaf."** If the leaf actually splits, you propagate the new key upward along that held stack.

Most inserts hit a non-full leaf and **finish holding just a couple of latches.** Only in the rare case where a split truly propagates do you hold several ancestors. That's how crabbing preserves parallelism — prepared for the worst, light in the common case.

## 4. When the Root Splits — the Header Node Trick

When a split reaches the root, the tree grows taller and **the root pointer changes.** How do you swap it safely while many threads reference the root? The elegant trick is a **dummy header node.**

```c
struct CBTree {
    Node *header;   /* header->child[0] is the real root */
};
```

Keep the real root at `header->child[0]`, and **always latch the header first** to read or change the root. Then a root split is nothing special — hold the header latch and plug the new root pointer into `header->child[0]`.

```c
if (up_right) {                 /* the split reached the root */
    Node *nr = node_new(0);     /* new root (height + 1) */
    nr->key[0] = up_key;
    nr->child[0] = t->header->child[0];  /* old root */
    nr->child[1] = up_right;             /* the right sibling from the split */
    t->header->child[0] = nr;            /* swap under the header latch */
}
```

Insert crabs down from the header, so if the root is about to split, the header remains latched at the bottom of the stack — making the root swap always safe. The special case of "the root pointer floating, tied to nothing" disappears.

## 5. Proof — Under a Split Storm, with TSan

How do we trust crabbing is correct? Like [Part 20](/blog/project/db-hobby/db-hobby-20-thread-safety), **ThreadSanitizer + a stress test.** With only 4 keys per node so **splits happen constantly**, 8 threads insert at once.

```
$ make test-tsan
  ok   concurrent inserts 8 threads × 1000 keys: all found with correct values (crabbing integrity)
  ok   range-scan total = N (leaf chain intact)
  ok   reads during writes: committed keys are always found (reads not broken by splits)
all passed       ← zero ThreadSanitizer warnings
```

Three checks:

- **Concurrent-insert integrity** — even as 8 threads hammer inserts that trigger splits, afterward every key reads back with the correct value. If crabbing were wrong and the tree froze half-split, keys would vanish here.
- **Leaf chain intact** — the range scan (walking the leaf chain sideways) totals correctly. A mis-linked `next` pointer from a split would break it.
- **Reads unbroken by splits** — while writers split the tree, readers keep looking up already-committed keys and **never miss one.** Evidence that read crabbing prevents the "half-split tree."

![Latch crabbing — a read latches the child before releasing the parent (at most 2 nodes at once), so it never sees a half-split tree. An insert releases all ancestor latches when the child is safe (has room), and holds them to propagate a split upward when not. A root split just swaps a pointer via the header-node trick. Root→leaf, one direction, so deadlock is impossible](/uploads/project/db-hobby/latch-crabbing.svg)

## 6. An Honest Boundary — Not Wired Into the Engine Yet

Let me be honest. This concurrent B+Tree (`cbtree`) is a **standalone module separate from the engine's `btree.c`.** It's in-memory (no disk, no buffer pool), and the engine still runs **serially behind Part 20's coarse engine latch**. Why build it this way:

- **To isolate the algorithm.** Latch crabbing is about *node latching*, not *storage*. Stripping away disk, buffer pool, and page format to show crabbing purely has real learning value.
- **Zero regression risk.** Not touching the engine's `btree.c` means the 400+ existing tests don't break a line. It avoids planting a concurrency bug (a nightmare to reproduce) into a stable core.

So this is "an independent proof of the **technique** needed to peel off the coarse engine latch." Actually wiring crabbing into the engine's on-disk B+Tree means tying node latches to **buffer pool frames** (page latches) and untangling the interaction with the WAL and no-steal — that's the "multi-session big rewrite" Part 20 mentioned. This part **tied the first rope** for climbing that mountain.

## 7. Wrap-up — and the Mountain That Remains

| Item | db-hobby | Note |
|---|---|---|
| Read crabbing (grab child, release parent) | O | ≤ 2 nodes at once, deadlock-free (one direction) |
| Write crabbing (release ancestors at a safe node) | O | light in the common case, holds ancestors only on split |
| Root split (header node trick) | O | root-pointer swap is no longer a special case |
| Split-storm concurrent insert + mixed reads | O | **ThreadSanitizer-clean** |
| Wired into the engine's btree.c | X | page latches + WAL interaction = big rewrite |
| Blocking lock manager | X | meaningful only after the engine latch is gone |

This part solved the classic hard problem of concurrent data structures — "how do many threads traverse the same tree without breaking it" — with crabbing. Like a crab gripping with its front legs before releasing its back, the single ordering of "latch the child before releasing the parent" was the whole trick. And insert's "release ancestors at a safe node" was the key to keeping parallelism and correctness at once.

[Part 20](/blog/project/db-hobby/db-hobby-20-thread-safety)'s buffer pool latch and this part's B+Tree crabbing — the **techniques for two layers** of peeling off the coarse engine latch are now in hand. What remains is actually wiring them into the engine (page latches, WAL concurrency) and turning the lock manager from "reject immediately" into "truly block and wait" — the finale of Track D, and a multi-session big rewrite. db-hobby is tying the ropes up that mountain, one at a time.

## References

- [CMU 15-445/645 Database Systems — Project 2 (Concurrent B+Tree Index), latch crabbing](https://15445.courses.cs.cmu.edu/)
- [Lehman & Yao, "Efficient Locking for Concurrent Operations on B-Trees" (1981)](https://dl.acm.org/doi/10.1145/319628.319663)
- [The Internals of PostgreSQL: nbtree concurrency](https://www.interdb.jp/pg/index.html)
- This series: [Part 3 B+Tree Index](/blog/project/db-hobby/db-hobby-3-index-wal) · [Part 20 Thread-Safe Buffer Pool](/blog/project/db-hobby/db-hobby-20-thread-safety)

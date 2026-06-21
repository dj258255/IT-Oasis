---
title: 'O(1) 브랜치를 코드로 증명하기 — BranchDB의 심장'
titleEn: 'Proving O(1) Branching in Code — The Heart of BranchDB'
description: "포크 1000개를 떠도 메모리가 안 터지는 이유. 영속 불변 트리와 copy-on-write insert를 Rust로 직접 짜고, '안 건드린 부분 트리가 진짜로 공유된다'를 테스트로 증명한다."
descriptionEn: "Why forking 1000 branches doesn't blow up memory. We implement a persistent immutable tree and a copy-on-write insert in Rust, then prove with a test that untouched subtrees are genuinely shared."
date: 2026-06-22
tags:
  - Rust
  - Database
  - Copy-on-Write
  - Persistent Data Structure
  - Devlog
category: project/BranchDB
coverImage: /uploads/project/BranchDB/cover.svg
draft: false
series: "BranchDB"
seriesOrder: 2
---

[지난 글](/blog/project/branchdb/branchdb-why-i-build-it)에서 무엇을 만들지 정했다. AI 에이전트가 데이터셋을 수천 갈래로 포크해서 탐색하는 워크로드, 그걸 임베디드 라이브러리로. 무기는 **O(1) 브랜치**라고 했는데, 말로만 하면 의미가 없다. 이번 글에서 그걸 코드로 짓고, 테스트로 증명한다.

## 핵심은 트리 하나다

브랜치가 공짜가 되려면 데이터 구조가 **불변(immutable)** 이어야 한다. 한 번 만든 노드는 절대 바뀌지 않는다. 수정이 필요하면 바뀐 부분만 새 노드로 만들고, 안 바뀐 부분은 옛 노드를 그대로 가리킨다(공유한다).

Rust에서 이 "공유"를 공짜로 주는 게 `Arc`다. 원자적 참조 카운팅 포인터인데, 복제(clone)해도 데이터를 복사하지 않고 카운터만 1 올린다.

```rust
#[derive(Debug)]
pub struct Node {
    pub key: Key,
    pub value: Value,
    pub left: Tree,
    pub right: Tree,
}

/// 트리 전체는 그냥 루트 노드를 가리키는 선택적 공유 포인터다.
pub type Tree = Option<Arc<Node>>;
```

`Tree`가 `Option<Arc<Node>>`인 게 전부다. `None`이 빈 트리, `Some(arc)`가 루트를 가진 트리. 그리고 **브랜치란 이 `Tree` 하나**다. 포크는 이 `Arc`를 복제하는 것 — O(1)이고 데이터 복사가 0이다.

## 심장: copy-on-write insert

이 프로젝트에서 가장 중요한 함수. 키를 넣되, **입력 트리는 손대지 않고** 새 트리를 반환한다.

```rust
pub fn insert(tree: &Tree, key: Key, value: Value) -> Tree {
    match tree {
        // 빈 자리: 새 트리는 리프 하나다.
        None => Some(Node::leaf(key, value)),
        // 자리가 차 있음: 이 노드를 다시 만들되, 한쪽으로만 내려가고 다른 쪽은 공유.
        Some(node) => Some(match key.cmp(&node.key) {
            Ordering::Less    => node.with_left(insert(&node.left, key, value)),
            Ordering::Greater => node.with_right(insert(&node.right, key, value)),
            Ordering::Equal   => node.with_value(value),
        }),
    }
}
```

포인트는 `with_left`/`with_right` 안에 숨어 있다. 왼쪽으로 내려갈 때 이 헬퍼는 새 노드를 만들면서 **오른쪽 부분 트리는 `self.right.clone()`으로 공유**한다.

```rust
fn with_left(&self, left: Tree) -> Arc<Node> {
    Arc::new(Node {
        key: self.key.clone(),
        value: self.value.clone(),
        left,
        right: self.right.clone(), // <-- 복사가 아니라 공유, O(1)
    })
}
```

그래서 `insert` 한 번에 새로 만들어지는 노드는 **루트에서 변경 지점까지의 경로 위 노드뿐**이다. 트리 높이만큼, 즉 O(log n)개. 나머지 가지는 옛 트리와 새 트리가 동시에 가리킨다. 이게 경로 복사(path copying)이고, Git이 커밋을 저장하는 방식이다.

## 진짜 공유되는지, 어떻게 믿나

"공유된다"는 주장은 믿을 게 못 된다. 그래서 기계가 증명하게 만들었다. 핵심 테스트는 삽입 후에 **건드리지 않은 부분 트리가 같은 메모리 주소**인지를 `Arc::ptr_eq`로 확인한다.

```rust
// 루트의 오른쪽으로 가는 키를 삽입한다 — 왼쪽 부분 트리는 절대 건드리지 않음.
let after = insert(&base, k("p"), k("P"));

// 같은 할당 -> 공유 성공(왼쪽 부분 트리 복사 0).
assert!(Arc::ptr_eq(left_before, left_after));
```

전체를 돌려보면 트리 4개, DB 5개, 합쳐서 9개 테스트가 통과한다.

![cargo test 결과 — 9개 테스트 모두 통과](/uploads/project/BranchDB/test-output.svg)

저 `structural_sharing_is_real` 한 줄이 이 프로젝트에서 가장 자랑스러운 코드다. "공유한다고 주장"이 아니라 "주소가 같음을 단언"하니까.

## 라이브러리의 얼굴: BranchDB

트리는 엔진이고, 사람이 쓰는 건 그 위의 `BranchDB`다. 브랜치는 **이름 → 트리의 루트** 매핑일 뿐이라, 구현이 놀랄 만큼 짧다. 가장 중요한 `fork`는 이게 전부다.

```rust
pub fn fork(&mut self, from: &str, to: &str) -> Result<(), Error> {
    let root = self.branches
        .get(from).ok_or_else(|| Error::NoSuchBranch(from.into()))?
        .clone(); // <-- Arc 복제, O(1), 데이터 0
    if self.branches.contains_key(to) {
        return Err(Error::BranchExists(to.into()));
    }
    self.branches.insert(to.into(), root);
    Ok(())
}
```

데이터셋이 1GB든 1TB든 `fork`는 똑같이 빠르다. 복제하는 건 루트 포인터 하나니까.

## 1000개 포크, 할당 1번

말보다 데모다. main 브랜치에 값 하나 넣고, 1000개로 포크하고, 그중 `try-7` 하나만 바꾼다.

```rust
let mut db = BranchDB::new();
db.put("main", b("user:1"), b("alice"))?;

for i in 0..1000 {
    db.fork("main", &format!("try-{i}"))?;   // 전부 O(1)
}

db.put("try-7", b("user:1"), b("bob"))?;     // 이 갈래만 갈라진다
```

결과:

![데모 출력 — main은 alice 그대로, try-7만 bob, 총 1001개 브랜치](/uploads/project/BranchDB/demo-output.svg)

`try-7`만 `bob`으로 바뀌고 `main`과 `try-42`는 `alice` 그대로다. 브랜치가 1001개나 있지만, 실제로 새로 저장된 노드는 `try-7`이 갈라지면서 만든 한 줌뿐이다. 나머지 1000개는 전부 같은 노드를 공유한다.

이게 SQLite로는 안 되는 일이다. SQLite에서 포크는 파일 전체 복사라, 1000개면 1000배 용량이다. 우리는 데이터 구조 자체를 불변으로 깔았기 때문에 그 비용이 사라진다.

## 지금까지와 다음

여기까지 만든 것은 영속 불변 트리(`insert` / `get` / `remove`), 구조 공유를 증명하는 테스트, 그리고 그 위에 얹은 `BranchDB` API(`fork` / `put` / `get` / `delete`)다.

남은 것은 네 가지다. 두 브랜치를 비교·병합하는 `diff`와 `merge`, 디스크에 영구 저장하는 content-addressed 스토리지, 지금은 최악 O(n)인 트리를 균형 잡는 AVL, 그리고 에이전트 개발자가 실제로 쓰려면 필요한 Python/JS 바인딩.

다음 글에서는 `diff`와 `merge`를 붙인다. 두 브랜치가 무엇이 다른지 알아내고, 좋은 갈래를 main에 합치는 것 — 에이전트가 "여러 우주를 돌려보고 제일 좋은 우주만 남긴다"의 마지막 조각이다.

---
title: '삭제 전파, 균형, 그리고 47,524배 — 코어를 단단하게 그리고 손에 닿게'
titleEn: 'Deletion Propagation, Balance, and 47,524x — Hardening the Core and Making It Reachable'
description: "union 병합을 진짜 3-way merge로(삭제까지 전파), 최악 O(n)이던 트리를 AVL로 균형 잡고, 'fork는 데이터 크기와 무관하게 일정하다'를 벤치마크로 증명한다. 마지막으로 의존성 0 원칙을 지키며 PyO3로 파이썬에서 쓸 수 있게 했다."
descriptionEn: "Turning union merge into a real 3-way merge that propagates deletions, balancing the worst-case-O(n) tree with AVL, and proving with a benchmark that forking is constant regardless of dataset size — then making it reachable from Python via PyO3 without touching the zero-dependency core."
date: 2026-06-22
tags:
  - Rust
  - Database
  - AVL Tree
  - Benchmark
  - PyO3
  - Devlog
category: project/BranchDB
coverImage: /uploads/project/BranchDB/cover.svg
draft: false
series: "BranchDB"
seriesOrder: 4
---

[3편](/blog/project/branchdb/branchdb-diff-merge-and-disk)까지 오면서 `fork`, `diff`, `merge`, 디스크 저장이 갖춰졌다. 한 바퀴는 돈다. 이번 글은 그 한 바퀴를 **단단하게**(제대로 된 병합과 균형 트리) 만들고, 무기를 **숫자로 증명**하고, 마지막으로 파이썬에서 **손에 닿게** 하는 이야기다.

## 1. union 병합을 진짜 3-way merge로

3편의 `merge`는 정직하게 한계를 적어뒀었다. "from의 항목을 into에 적용"하는 단순 합집합이라, **from에서 지운 키는 전파되지 않았다.** 갈래에서 무언가를 삭제하고 main에 합쳐도 main에는 그대로 남는 문제다.

진짜 3-way 병합은 공통 조상이 필요하다. 다행히 트리가 영속적이라, 포크 시점의 루트를 기억해두면 그게 곧 조상이다. 추가 비용이 거의 없다.

```rust
// 각 브랜치가 갈라져 나온 시점의 루트(공통 조상)를 기억해둔다.
bases: HashMap<String, Tree>,
```

이제 병합은 "from이 조상 대비 무엇을 바꿨나"만 골라서 into에 적용한다. 추가·수정뿐 아니라 **삭제까지** 반영된다.

```rust
for change in tree::diff(&ancestor, &from_tree) {
    into_tree = match change {
        Change::Added { key, value } | Change::Modified { key, new: value, .. } => {
            tree::insert(&into_tree, key, value)
        }
        Change::Removed { key } => tree::remove(&into_tree, &key), // 삭제 전파
    };
}
```

테스트로 못 박는다. 갈래에서 키를 지우고 병합하면, main에서도 사라져야 한다.

```rust
db.fork("main", "cleanup");
db.delete("cleanup", b"doomed");
db.merge("cleanup", "main");
assert_eq!(db.get("main", b"doomed").unwrap(), None); // 삭제가 전파됨
```

## 2. 최악 O(n)을 AVL로

지금까지 트리는 균형을 잡지 않는 평범한 BST였다. 정렬된 키를 순서대로 넣으면 사실상 연결 리스트가 되어 높이가 데이터 개수만큼 자란다. 1편에서 "다음 단계"로 적어뒀던 약점이다.

그래서 AVL 균형을 넣었다. 핵심은 회전(rotation)인데, **회전도 copy-on-write로** 한다. 관련된 몇 노드만 새로 만들고 나머지 부분 트리는 그대로 공유한다. 균형과 구조 공유가 양립한다.

```rust
// 오른쪽 회전: 왼쪽 자식을 새 루트로 끌어올린다.
// l.left 와 node.right 는 복사 없이 그대로 공유된다.
fn rotate_right(node: &Node) -> Arc<Node> {
    let l = node.left.as_ref().unwrap();
    let new_right = make(node.key.clone(), node.value.clone(), l.right.clone(), node.right.clone());
    make(l.key.clone(), l.value.clone(), l.left.clone(), Some(new_right))
}
```

`height`는 자식에서 유도되므로 디스크에는 저장하지 않는다. 불러올 때 다시 계산하면 되니 파일 포맷도 안 바뀐다.

효과는 테스트로 증명한다. 정렬된 키 1000개를 순서대로 넣는다. 균형이 없으면 높이 1000의 연결 리스트가 될 상황이다.

```rust
let mut t = empty();
for i in 0..1000 {
    t = insert(&t, format!("{i:05}").into_bytes(), k("v"));
}
assert!(height(&t) < 20); // AVL이면 로그 높이(약 15). 1000이 아니다.
```

걱정했던 건 2편의 구조 공유 증명 테스트였다. 회전이 일어나면 그 테스트가 깨질까 봐. 다행히 "루트보다 큰 키를 삽입"하면 오른쪽으로만 내려가서 왼쪽 부분 트리는 회전과 무관하게 그대로 공유된다. 테스트는 그대로 통과한다.

## 3. 무기를 숫자로 — fork vs 전체 복사

말로 "O(1)"이라고 하는 것과 숫자로 보여주는 건 다르다. 같은 작업, "데이터셋을 1000개의 독립된 갈래로 나누기"를 두 방식으로 쟀다. `BranchDB::fork`(루트 포인터만 복제)와, 갈래마다 데이터 전체를 새로 만드는 순진한 복사(파일 복사로 포크하는 것과 같은 비용)다.

![벤치마크 — fork는 데이터 크기와 무관하게 ~220µs로 일정, 전체 복사는 71ms에서 10.71s로 선형 증가, 10000개에서 47,524배 차이](/uploads/project/BranchDB/bench-output.svg)

fork는 데이터가 100개든 10,000개든 ~220µs로 **일정하다.** 반면 전체 복사는 데이터가 10배 커질 때마다 대략 10배씩 느려진다. 10,000개에서 이미 47,524배 차이고, 측정해보면 100,000개에서는 fork가 여전히 ~220µs인데 복사는 약 132초로, 격차가 **60만 배**까지 벌어진다.

이 한 장이 이 데이터베이스가 존재하는 이유 전부다. 에이전트가 데이터셋을 수천 번 포크하는 워크로드라면, 포크 비용이 데이터 크기에 비례하느냐 일정하느냐가 곧 가능하냐 불가능하냐를 가른다.

## 4. 파이썬에서 쓸 수 있게 — 단, 코어는 안 건드리고

에이전트 개발자 대부분은 파이썬에 산다. `cargo add`만으로는 그들에게 닿지 못한다. 그래서 PyO3로 파이썬 바인딩을 붙였다.

여기서 원칙 하나를 지켰다. 코어 크레이트는 **의존성이 0개**라는 것. PyO3는 무거운 의존성이라, 코어에 직접 넣으면 그 강점이 사라진다. 그래서 바인딩을 **별도 크레이트**로 분리하고 워크스페이스에서 제외했다. 코어의 `cargo test`와 의존성 0 약속은 그대로다.

```python
from branchdb import BranchDB

db = BranchDB()
db.put("main", b"user:1", b"alice")
db.fork("main", "experiment")          # O(1)
db.put("experiment", b"user:1", b"bob")

db.diff("main", "experiment")          # [("modified", b"user:1", b"bob")]
db.merge("experiment", "main")
db.save("agent.db")
```

`maturin develop` 한 번이면 abi3 휠로 빌드되어 파이썬 3.9부터 3.14까지 그대로 돌아간다. 실제로 파이썬 3.14에서 위 예제가 초록불로 통과하는 걸 확인했다.

## 지금까지와 다음

이제 BranchDB는 균형 잡힌 영속 트리 위에서 `fork`(O(1)) · `put` · `get` · `delete` · `diff` · 3-way `merge` · `save` · `open`을 제공하고, 파이썬에서도 쓸 수 있다. 무기는 벤치마크로 증명됐다. 임베디드 브랜치 키-값 저장소로서 보여주고 싶었던 한 바퀴가 단단하게 닫혔다.

남은 건 더 멀리 닿는 일이다. 브라우저·Node 에이전트를 위한 JS/WASM 바인딩, 매번 전체 스냅샷을 쓰는 대신 바뀐 부분만 덧붙이는 증분 디스크 저장, 그리고 crates.io 배포. 큰 산 하나는 넘었으니, 다음은 사람들 손에 더 가까이 가져다 놓는 쪽이다.

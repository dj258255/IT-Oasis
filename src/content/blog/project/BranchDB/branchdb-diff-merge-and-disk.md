---
title: '비교하고, 채택하고, 껐다 켜도 살아남기: diff·merge와 디스크 저장'
titleEn: 'Compare, Adopt, and Survive a Restart — diff, merge, and On-Disk Storage'
description: "포크한 갈래가 무엇을 바꿨는지 알아내는 diff, 좋은 갈래를 main에 합치는 merge, 그리고 메모리의 구조 공유를 디스크로 그대로 옮겨 '포크 1000개를 저장해도 트리는 한 번만 기록되는' 영속성까지. 의존성 없이 순수 std로."
descriptionEn: "diff to see what a forked branch changed, merge to adopt the good one into main, and on-disk persistence that carries structural sharing to disk so 1000 forks store the tree only once — all in pure std, no dependencies."
date: 2026-06-22
tags:
  - Rust
  - Database
  - Persistence
  - Copy-on-Write
  - Devlog
category: project/BranchDB
coverImage: /uploads/project/BranchDB/cover.svg
draft: false
series: "BranchDB"
seriesOrder: 3
---

[2편](/blog/project/branchdb/branchdb-building-the-core)에서 포크가 O(1)로 동작하는 걸 코드로 증명했다. 이제 브랜치를 격리해서 따로 수정할 수 있다. 그런데 에이전트의 작업 루프를 완성하려면 두 가지가 더 필요하다. 갈래가 **무엇을 바꿨는지** 알아내는 `diff`, 그리고 좋은 갈래를 **채택하는** `merge`. 마지막으로, 프로그램을 껐다 켜도 데이터가 살아남아야 하니 디스크 저장까지.

## diff: 두 갈래가 무엇이 다른가

`diff(a, b)`는 `a`에서 `b`로 갈 때의 변화를 돌려준다. 추가됐는지, 삭제됐는지, 값이 바뀌었는지.

```rust
#[derive(Debug, PartialEq, Eq)]
pub enum Change {
    Added { key: Key, value: Value },
    Removed { key: Key },
    Modified { key: Key, old: Value, new: Value },
}
```

구현은 트리의 성질 하나를 공짜로 빌린다. **BST의 중위 순회는 항상 정렬된 순서를 준다.** 그래서 두 트리를 각각 정렬된 목록으로 펼친 뒤, 두 포인터로 한 번에 훑으면 된다. 정렬 비용 없이 O(n) 비교다.

```rust
match ea[i].0.cmp(&eb[j].0) {
    Ordering::Less    => { /* a에만 있음 -> 삭제됨 */ }
    Ordering::Greater => { /* b에만 있음 -> 추가됨 */ }
    Ordering::Equal   => { /* 값이 다르면 수정됨 */ }
}
```

## merge: 좋은 갈래를 채택한다

`merge(from, into)`는 `from`의 모든 키-값을 `into`에 적용한다. 충돌하면 `from`이 이긴다.

```rust
for (key, value) in tree::entries(&from_tree) {
    into_tree = tree::insert(&into_tree, key, value);
}
```

정직하게 말하면 이건 **단순 합집합 병합**이다. `from`에서 *삭제된* 키는 전파하지 않는다. 진짜 3-way 병합(삭제까지 반영)을 하려면 포크할 때 공통 조상 포인터를 저장해서 "base에서 from으로의 변화"만 골라 적용해야 한다. 다행히 트리가 영속적이라 base 버전이 메모리에 그대로 살아있으니, 다음 단계에서 깔끔하게 붙일 수 있다. 일단은 한계를 분명히 적어두고 넘어간다.

이제 에이전트의 작업 루프가 코드로 완성된다. 포크해서 갈래마다 시도하고, diff로 무엇이 달라졌는지 보고, 좋으면 merge로 채택한다.

![demo 출력: fork로 1000갈래, diff로 user:1이 alice에서 bob으로 바뀐 걸 확인, merge로 main에 채택](/uploads/project/BranchDB/demo-loop-output.svg)

## 디스크 저장: 구조 공유를 그대로 디스크로

여기까지는 전부 메모리 안의 이야기였다. 프로그램을 끄면 사라진다. 이제 파일에 저장해야 하는데, 여기서 이 프로젝트에서 가장 마음에 드는 설계가 나온다.

메모리에서 노드를 `Arc`로 공유했듯이, **디스크에서도 공유시킨다.** 방법은 이렇다. 노드를 파일에 한 번만 쓰고, 자식은 그 노드의 **파일 오프셋**으로 가리킨다. 저장하는 동안 `Arc` 포인터로 "이미 쓴 노드인가?"를 확인해서, 이미 썼으면 그 오프셋을 재사용한다.

```rust
fn write_node(tree, buf, written) -> Option<u64> {
    let node = tree.as_ref()?;
    let id = Arc::as_ptr(node) as usize;
    if let Some(&off) = written.get(&id) {
        return Some(off); // 이미 기록됨 -> 재사용 (디스크에서도 공유)
    }
    let left = write_node(&node.left, buf, written);
    let right = write_node(&node.right, buf, written);
    let off = buf.len() as u64;
    // [key][value][left ref][right ref] 를 한 번만 기록
    ...
}
```

자식을 먼저 쓰니 부모는 항상 자기보다 앞선 오프셋만 참조한다. 전방 참조가 없어서 단순한 단일 패스 파일이 된다. Git식 content-address(해시)가 아니라 **오프셋 주소**를 쓰는 덕분에 해시 라이브러리도 필요 없다. 실제로 이 데이터베이스는 **외부 의존성이 0개**다. 순수 std로만 돌아간다.

불러올 때도 같은 오프셋을 캐시한다. 같은 노드를 같은 `Arc`로 복원하니, 저장 전의 공유 구조가 메모리에 그대로 되살아난다. 껐다 켜도 O(1) 브랜치 성질이 유지되는 것이다.

### 1001개 브랜치, 트리는 한 번만

말보다 파일 크기다. 키 다섯 개짜리 트리를 만들어 저장하면 126바이트. 그걸 1000번 포크(분기 없음)하고 다시 저장하면?

![persistence 출력: 브랜치 1개일 때 126 bytes, 1001개여도 17016 bytes](/uploads/project/BranchDB/persistence-output.svg)

1001개를 저장했는데도 17KB다. 트리가 복제됐다면 1001배인 126KB가 됐을 것이다. 17KB의 거의 전부는 브랜치 **이름표**(`main`, `f0`, `f1`, ...)이고, 정작 트리는 단 한 번만 기록됐다. 메모리에서 `Arc`로 공유하던 노드가 디스크에서도 한 번만 저장된 것이다.

저장은 임시 파일에 먼저 쓰고 `rename`으로 교체한다. 저장 도중에 프로그램이 죽어도 기존 파일이 깨지지 않게 하는 흔한 기법이다.

## 지금까지와 다음

이제 `BranchDB`는 `fork`(O(1)), `put`, `get`, `delete`, `diff`, `merge`, `save`, `open`을 갖췄다. 임베디드 브랜치 키-값 저장소로서 한 바퀴가 돌아간다. 껐다 켜도 살아남고, 포크는 여전히 공짜다.

남은 큰 조각은 셋이다. 공통 조상을 이용해 삭제까지 반영하는 진짜 3-way `merge`, 지금 최악 O(n)인 트리를 O(log n)으로 만드는 AVL 균형, 그리고 에이전트 개발자가 실제로 쓰려면 필요한 Python/JS 바인딩. 그다음엔 "포크 1000개 vs 파일 전체 복사"를 숫자로 비교하는 벤치마크를 붙여서, 이 데이터베이스가 왜 존재하는지를 수치로 못 박을 생각이다.

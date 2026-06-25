---
title: 'Copy-on-Write fork — 복사를 미루는 기술'
titleEn: 'Copy-on-Write fork — the Art of Deferring the Copy'
description: fork는 주소공간을 통째로 복사한다. 하지만 대부분의 자식은 곧장 exec해 그 복사본을 버린다. Copy-on-Write는 이 낭비를 없앤다 — fork 때는 페이지를 복사하지 않고 부모와 읽기 전용으로 공유하다가, 누군가 쓰는 "그 순간"에만 복제한다. 물리 페이지 참조 카운트와 쓰기 페이지 폴트로 이걸 구현하고, 우리 커널만의 설계 제약(스택은 공유 못 한다)과 그 트레이드오프까지 짚는다.
descriptionEn: "fork copies the whole address space. But most children immediately exec and throw that copy away. Copy-on-Write removes the waste — at fork time pages aren't copied but shared read-only with the parent, and the copy happens only at the moment someone writes. We implement it with physical-page reference counts and a write page fault, and walk through our kernel's own design constraint (the stack can't be shared) and its trade-off."
date: 2026-06-26T00:00:00.000Z
tags:
  - OS
  - C
  - Kernel
  - RISC-V
  - xv6
  - QEMU
category: project/hobby-kernel
coverImage: "/uploads/hobby/hobby-kernel-c/cover.svg"
draft: false
series: "C로 만드는 토이 커널"
seriesOrder: 8
---


## 들어가며

[2편에서 만든 `fork`](/blog/hobby/hobby-kernel-01-usermode-to-processes)는 정직하지만 무식해요.
부모의 주소공간을 **통째로 복사**하거든요 — 코드 페이지, 스택 페이지, 힙 전부.

그런데 현실의 fork는 대부분 이렇게 쓰여요.

```c
if (fork() == 0) {
    exec("프로그램");   // 자식: 방금 복사한 주소공간을 곧바로 버리고 새 프로그램으로 교체
}
```

자식은 `fork`로 복사한 페이지를 **한 번도 안 쓰고 exec로 덮어써요**.
그 복사가 통째로 낭비인 거죠.

**Copy-on-Write(COW)** 는 이 낭비를 없애는 고전적인 최적화예요.
핵심 아이디어는 한 문장이에요 — **"복사를 쓰기 시점까지 미룬다."**
fork 때는 부모와 자식이 같은 물리 페이지를 **읽기 전용으로 공유**하고, 누군가 그 페이지에 **쓰려고 할 때 비로소** 복제해요.

이건 [5편의 demand paging](/blog/hobby/hobby-kernel-04-paging-mmap-writable-fs)과 같은 철학이에요.
"필요해질 때까지 일을 미룬다." — 거기선 페이지 할당을 미뤘고, 여기선 페이지 복사를 미뤄요.
그래서 그때 만든 페이지 폴트 핸들러를 거의 그대로 재사용해요.

## 1. 토대 — 물리 페이지 참조 카운트

페이지를 공유하려면, 먼저 **"이 물리 페이지를 몇 개의 주소공간이 가리키나"** 를 알아야 해요.
부모와 자식이 같은 페이지를 공유하다가, 한쪽이 떠나도 다른 쪽이 아직 쓰고 있으면 그 페이지를 반납하면 안 되니까요.

그래서 물리 페이지마다 **참조 카운트**를 둬요.

```c
void kfree(void *pa) {
    int i = refidx(pa);
    if (refcnt[i] > 1) {     // 아직 다른 주소공간이 공유 중 → 반납하지 않음
        refcnt[i]--;
        return;
    }
    refcnt[i] = 0;
    // ... 진짜로 free list에 되돌린다
}
```

규칙은 단순해요.

- `kalloc`은 새 페이지의 카운트를 **1**로 둬요(소유자 한 명).
- 공유가 시작되면 `kref_inc`로 **+1**.
- `kfree`는 **-1**, 그리고 **0이 될 때만** 진짜로 반납.

이 한 겹이 깔리면, 여러 주소공간이 같은 페이지를 안전하게 공유하고 마지막 소유자가 떠날 때만 메모리가 풀려요.

## 2. fork를 COW로

이제 fork에서 페이지를 복사하는 대신 공유해요.
요령은 **양쪽 모두 읽기 전용으로 만들고, "원래 쓰기 가능했다"는 표시를 숨겨두는** 거예요.

RISC-V의 PTE에는 비트 8-9가 **소프트웨어 예약(RSW)** 으로 비어 있어요.
여기에 `PTE_COW`라는 우리만의 표시를 달아요.

```c
// 부모의 쓰기 가능 페이지를 자식과 공유(복사하지 않음)
if (flags & PTE_W) {
    flags = (flags & ~PTE_W) | PTE_COW;   // 쓰기 비트를 떼고 COW 표시를 단다
    *parent_pte = PA2PTE(pa) | flags;     // 부모도 읽기 전용 COW가 된다
}
mappages(child, va, PGSIZE, pa, flags);   // 자식도 같은 물리 페이지를 같은 권한으로
kref_inc((void *)pa);                      // 공유 시작 → 참조 카운트 +1
```

이제 부모도 자식도 그 페이지를 **읽을 순 있지만 쓸 수는 없어요**.
누군가 쓰려고 하면 하드웨어가 **쓰기 페이지 폴트**(RISC-V scause=15)를 일으켜요.
그게 복제의 방아쇠예요.

```c
// 쓰기 폴트가 COW 페이지에서 났다면 → 복제
int uvm_cow_fault(pagetable_t pt, uint64 va) {
    pte_t *pte = walk(pt, va, 0);
    if (!(*pte & PTE_COW)) return 0;          // COW 페이지가 아니면 패스

    uint64 old = PTE2PA(*pte);                 // 공유 중인 옛 물리 페이지
    char *fresh = kalloc();                     // 새 페이지를 받아
    memcopy(fresh, (void *)old, PGSIZE);        // 내용을 복사하고
    uint64 flags = (PTE_FLAGS(*pte) & ~PTE_COW) | PTE_W;  // 다시 쓰기 가능으로
    *pte = PA2PTE(fresh) | flags;
    kfree((void *)old);                         // 옛 공유 페이지의 참조 카운트 -1
    return 1;
}
```

이 흐름이 COW의 전부예요.
**fork는 가벼워지고**(복사 없음), **복사는 정말 필요할 때 한 번만** 일어나요.
fork 직후 곧장 exec하는 자식은 그 페이지에 쓸 일이 없으니, 복사가 **아예 안 일어나죠**.

페이지 폴트 핸들러에선 이 검사를 demand paging보다 **먼저** 둬야 해요.
COW 페이지는 이미 매핑돼 있어서, "빈 페이지를 새로 할당"하는 demand 분기로 가면 안 되거든요.

```c
// 쓰기 폴트면 COW부터 — 이미 매핑된 페이지이므로 demand 분기보다 우선
if (store && uvm_cow_fault(p->pagetable, a)) return 1;
```

## 3. 우리만의 제약 — 스택은 공유할 수 없다

여기서 우리 커널만의 재미있는 트레이드오프가 나와요.
**우리는 스택 페이지를 COW로 공유하지 못해요.** 코드와 힙만 공유하고, 스택은 예전처럼 통째 복사해요.

왜냐면 우리 fork는 자식의 **트랩 프레임을 유저 스택 위에서 직접 고쳐 쓰거든요**.

```c
// 자식의 fork() 반환값을 0으로, 복귀 지점을 ecall 다음으로
struct regframe *cf = (struct regframe *)(ustack + off);
cf->a0 = 0;
cf->sepc = f->sepc + 4;
```

만약 스택을 COW로 공유한다면, 이 두 줄이 **부모의 스택까지 망가뜨려요**(같은 물리 페이지니까).
그래서 스택만큼은 사적 복사를 유지해야 해요.

이건 [xv6와 다른 설계](/blog/hobby/hobby-kernel-02-fork-elf-filesystem)에서 온 비용이에요.
xv6는 트랩 프레임을 **별도의 커널 페이지**(trapframe)에 두지만, 우리는 트램폴린을 단순화하려고 유저 스택 위에 뒀어요.
그 단순함의 대가가 "스택은 COW 못 함"인 거죠.

그래도 손해는 작아요.
스택은 보통 한 페이지고, 정작 큰 건 힙과 코드인데 그건 COW로 공유하니까요.
**"설계의 단순함 ↔ 최적화의 완전함"** 사이에서 우리는 단순함을 택했고, 그 경계를 정확히 아는 게 중요해요.

## 4. 눈으로 확인하기

`cowtest`는 힙에 42를 쓰고 fork한 뒤, 자식이 99를 써요.
COW가 맞다면 자식의 쓰기는 부모에게 안 보여야 해요.

```
cowtest: heap에 42를 쓰고 fork
[pagefault] demand-allocated a heap page at va=0x10000   ← 부모가 42 쓸 때 페이지 할당
  child: 공유된 p[0]=42                                    ← 자식이 공유값 42를 봄 (복사 안 함)
[cow] copied a shared page on write at va=0x10000        ← 자식이 쓰는 "그 순간" 복제
 -> 99 기록 후 p[0]=99                                    ← 자식만의 사본에 99
  parent: p[0]=42 (42여야 격리 성공)                       ← 부모는 여전히 42
```

여기서 가장 중요한 줄은 **`[cow] copied ... on write`** 예요.
복제가 **fork 시점이 아니라 자식이 쓰는 시점**에 일어났다는 증거거든요.
그게 바로 "copy-on-**write**"라는 이름의 의미예요.

메모리 누수도 확인했어요.
`hello`(fork+exec)를 반복하고 `cowtest`를 돌려도 빈 페이지 수가 **32058에서 그대로** 예요.
참조 카운트 덕에, 공유한 페이지든 복제한 페이지든 마지막 소유자가 떠날 때 정확히 한 번 반납돼요.

## 마치며

Copy-on-Write는 작은 코드로 큰 효과를 내는, OS의 우아한 최적화 중 하나예요.
참조 카운트 한 겹과 쓰기 폴트 한 번으로, fork가 "주소공간 통째 복사"에서 "포인터 몇 개 공유"로 가벼워졌어요.

돌아보면 이번 작업은 **이미 가진 부품의 재조합**이었어요.
페이지 폴트 핸들러(5편), 페이지 테이블 조작(1편), 물리 할당기(1편) — 전부 있던 걸 참조 카운트로 엮으니 COW가 됐죠.
"새 기능은 대개 기존 메커니즘의 새로운 조합"이라는 걸 다시 느꼈어요.

> 코드: [github.com/dj258255/hobby-kernel](https://github.com/dj258255/hobby-kernel)

### 참고 자료

- [xv6: a simple, Unix-like teaching operating system (MIT 6.S081)](https://pdos.csail.mit.edu/6.828/2023/xv6.html) — COW 랩
- 관련 글: [demand paging과 mmap](/blog/hobby/hobby-kernel-04-paging-mmap-writable-fs) · [fork와 ELF 로더](/blog/hobby/hobby-kernel-02-fork-elf-filesystem)

<!-- EN -->

## Introduction

The [`fork` we built in Part 2](/blog/hobby/hobby-kernel-01-usermode-to-processes) is honest but brute-force.
It **copies the parent's entire address space** — code page, stack page, the whole heap.

But real-world fork is mostly used like this.

```c
if (fork() == 0) {
    exec("program");   // child: immediately throws away the freshly copied address space and replaces it
}
```

The child **overwrites the pages copied by `fork` via exec without ever using them**.
That whole copy is wasted.

**Copy-on-Write (COW)** is the classic optimization that removes this waste.
The core idea is one sentence — **"defer the copy until the write."**
At fork time the parent and child **share the same physical pages read-only**, and only when someone **tries to write** is the page copied.

This is the same philosophy as [demand paging in Part 5](/blog/hobby/hobby-kernel-04-paging-mmap-writable-fs).
"Defer the work until it's actually needed." — there we deferred page allocation; here we defer page copying.
So we reuse the page fault handler we built back then almost verbatim.

## 1. The foundation — physical page reference counts

To share a page, you first need to know **"how many address spaces point at this physical page."**
If the parent and child share a page and one leaves while the other is still using it, you mustn't reclaim that page.

So each physical page gets a **reference count**.

```c
void kfree(void *pa) {
    int i = refidx(pa);
    if (refcnt[i] > 1) {     // still shared by another address space → don't reclaim
        refcnt[i]--;
        return;
    }
    refcnt[i] = 0;
    // ... actually return it to the free list
}
```

The rules are simple.

- `kalloc` sets a new page's count to **1** (one owner).
- When sharing begins, `kref_inc` does **+1**.
- `kfree` does **-1**, and reclaims for real **only when it hits 0**.

With this one layer in place, multiple address spaces can safely share a page, and memory is freed only when the last owner leaves.

## 2. Turning fork into COW

Now, instead of copying pages in fork, we share them.
The trick is to **make both sides read-only and hide a "this was originally writable" marker**.

In a RISC-V PTE, bits 8-9 are reserved for software (**RSW**) and sit empty.
We put our own marker there, `PTE_COW`.

```c
// share the parent's writable page with the child (no copy)
if (flags & PTE_W) {
    flags = (flags & ~PTE_W) | PTE_COW;   // drop the write bit, set the COW marker
    *parent_pte = PA2PTE(pa) | flags;     // the parent becomes read-only COW too
}
mappages(child, va, PGSIZE, pa, flags);   // child maps the same physical page, same perms
kref_inc((void *)pa);                      // sharing begins → refcount +1
```

Now both parent and child **can read but not write** that page.
When one tries to write, the hardware raises a **store page fault** (RISC-V scause=15).
That's the trigger for the copy.

```c
// if a write fault hit a COW page → copy it
int uvm_cow_fault(pagetable_t pt, uint64 va) {
    pte_t *pte = walk(pt, va, 0);
    if (!(*pte & PTE_COW)) return 0;          // not a COW page → pass

    uint64 old = PTE2PA(*pte);                 // the old, shared physical page
    char *fresh = kalloc();                     // grab a new page,
    memcopy(fresh, (void *)old, PGSIZE);        // copy the contents, and
    uint64 flags = (PTE_FLAGS(*pte) & ~PTE_COW) | PTE_W;  // make it writable again
    *pte = PA2PTE(fresh) | flags;
    kfree((void *)old);                         // drop the old shared page's refcount
    return 1;
}
```

This flow is all there is to COW.
**fork gets lighter** (no copy), and **the copy happens exactly once, only when truly needed**.
A child that immediately execs after fork never writes those pages, so the copy **never happens at all**.

In the page fault handler this check must come **before** demand paging.
A COW page is already mapped, so it must not fall into the "allocate a fresh page" demand branch.

```c
// on a write fault, COW first — the page is already mapped, so it precedes demand
if (store && uvm_cow_fault(p->pagetable, a)) return 1;
```

## 3. Our own constraint — the stack can't be shared

Here comes an interesting trade-off specific to our kernel.
**We can't share the stack page as COW.** We share only code and heap; the stack is copied whole as before.

That's because our fork **edits the child's trap frame directly on the user stack**.

```c
// set the child's fork() return value to 0, and the return point to after the ecall
struct regframe *cf = (struct regframe *)(ustack + off);
cf->a0 = 0;
cf->sepc = f->sepc + 4;
```

If we shared the stack as COW, these two lines would **corrupt the parent's stack too** (it's the same physical page).
So the stack alone must stay a private copy.

This is a cost that comes from a [design different from xv6's](/blog/hobby/hobby-kernel-02-fork-elf-filesystem).
xv6 keeps the trap frame in a **separate kernel page** (trapframe), but we put it on the user stack to simplify the trampoline.
The price of that simplicity is "the stack can't be COW."

Still, the loss is small.
The stack is usually one page, while the big things — heap and code — are shared via COW.
Between **"simplicity of design ↔ completeness of optimization"** we chose simplicity, and knowing exactly where that boundary lies is what matters.

## 4. Seeing it with your own eyes

`cowtest` writes 42 to the heap, forks, and then the child writes 99.
If COW is correct, the child's write must be invisible to the parent.

```
cowtest: write 42 to heap, then fork
[pagefault] demand-allocated a heap page at va=0x10000   ← page allocated when the parent writes 42
  child: shared p[0]=42                                   ← child sees the shared value 42 (no copy)
[cow] copied a shared page on write at va=0x10000        ← copied at the very moment the child writes
 -> after writing 99, p[0]=99                            ← 99 in the child's own copy
  parent: p[0]=42 (must be 42 for isolation)             ← parent still sees 42
```

The most important line here is **`[cow] copied ... on write`**.
It's proof that the copy happened **at the child's write, not at fork**.
That's exactly what the name "copy-on-**write**" means.

I also checked for memory leaks.
Repeating `hello` (fork+exec) and running `cowtest`, the free page count **stays at 32058**.
Thanks to reference counting, whether a page was shared or copied, it's reclaimed exactly once when the last owner leaves.

## Closing

Copy-on-Write is one of those elegant OS optimizations that achieve a lot with little code.
With one layer of reference counting and a single write fault, fork went from "copy the whole address space" to "share a few pointers."

Looking back, this work was a **recombination of parts we already had**.
The page fault handler (Part 5), page table manipulation (Part 1), the physical allocator (Part 1) — tying them together with reference counts gave us COW.
It reminded me again that "a new feature is usually a new combination of existing mechanisms."

> Code: [github.com/dj258255/hobby-kernel](https://github.com/dj258255/hobby-kernel)

### References

- [xv6: a simple, Unix-like teaching operating system (MIT 6.S081)](https://pdos.csail.mit.edu/6.828/2023/xv6.html) — the COW lab
- Related: [demand paging and mmap](/blog/hobby/hobby-kernel-04-paging-mmap-writable-fs) · [fork and the ELF loader](/blog/hobby/hobby-kernel-02-fork-elf-filesystem)

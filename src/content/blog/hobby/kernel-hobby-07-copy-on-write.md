---
title: 'Copy-on-Write fork — 복사를 미루는 기술'
titleEn: 'Copy-on-Write fork — the Art of Deferring the Copy'
description: fork는 주소공간을 통째로 복사한다. 하지만 대부분의 자식은 곧장 exec해 그 복사본을 버린다. Copy-on-Write는 이 낭비를 없앤다 — fork 때는 페이지를 복사하지 않고 부모와 읽기 전용으로 공유하다가, 누군가 쓰는 "그 순간"에만 복제한다. 물리 페이지 참조 카운트와 쓰기 페이지 폴트로 이걸 구현하고, 우리 커널만의 설계 제약(스택은 공유 못 한다)과 그 트레이드오프까지 짚는다.
descriptionEn: "fork copies the whole address space. But most children immediately exec and throw that copy away. Copy-on-Write removes the waste — at fork time pages aren't copied but shared read-only with the parent, and the copy happens only at the moment someone writes. We implement it with physical-page reference counts and a write page fault, and walk through our kernel's own design constraint (the stack can't be shared) and its trade-off."
date: 2026-06-14T00:00:00.000Z
tags:
  - OS
  - C
  - Kernel
  - RISC-V
  - xv6
  - QEMU
category: project/kernel-hobby
coverImage: "/uploads/hobby/kernel-hobby-c/cover.svg"
draft: false
series: "C로 만드는 토이 커널"
seriesOrder: 8
---


*바닥부터 직접 만드는 RISC-V 토이 커널 연재. 이 글은 8편 — Copy-on-Write fork(복사를 쓰기 시점까지 미루기).*

## 0. 들어가며

[2편에서 만든 `fork`](/blog/hobby/kernel-hobby-01-usermode-to-processes)는 정직하지만 무식해요.
부모의 주소공간을 **통째로 복사**하거든요 — 코드 페이지, 스택 페이지, 힙 전부.

이 글은 그 `fork`를 **Copy-on-Write(COW)** 로 다시 짜는 과정을 정리합니다.
COW의 핵심 아이디어는 한 문장이에요 — **"복사를 쓰기 시점까지 미룬다."**
fork 때는 부모와 자식이 같은 물리 페이지를 **읽기 전용으로 공유**하고, 누군가 그 페이지에 **쓰려고 할 때 비로소** 복제해요.

이걸 구현하는 데 필요한 부품은 딱 두 개예요 — 물리 페이지마다 **참조 카운트**를 달고, **쓰기 페이지 폴트**가 났을 때 그 페이지만 복제하는 것.
그리고 우리 커널만의 재미있는 제약도 하나 나와요 — **(우리 구현에선) 스택은 COW로 공유하지 못한다.** (리눅스·xv6 같은 일반 커널은 스택도 COW 하지만, 우리 설계에선 못 해요 — 이유는 4절에서.)
그 제약이 왜 생기고, 그게 어떤 트레이드오프인지까지 정확히 짚어볼게요.

> 왜 지금 COW인가: 이건 [5편의 demand paging](/blog/hobby/kernel-hobby-04-paging-mmap-writable-fs)과 정확히 같은 철학이에요 — "필요해질 때까지 일을 미룬다." 거기선 페이지 **할당**을 미뤘고, 여기선 페이지 **복사**를 미뤄요. 그래서 그때 만든 페이지 폴트 핸들러를 거의 그대로 재사용합니다. COW는 **새 메커니즘이 아니라, 기존 페이지 폴트 메커니즘 위에 얹은 새 정책**에 가까워요 — 페이지 폴트·페이지 테이블·참조 카운트라는 있던 부품의 재조합이죠.

## 1. Copy-on-Write가 풀어야 하는 진짜 문제

> `fork`는 부모 주소공간을 통째로 복사합니다. 그런데 그 복사본의 대부분은 자식이 **한 번도 안 쓰고 버려요.** 이 낭비를 어떻게 없앨까요?

현실의 `fork`는 압도적으로 이 패턴으로 쓰여요.

```c
if (fork() == 0) {
    exec("프로그램");   // 자식: 방금 복사한 주소공간을 곧바로 버리고 새 프로그램으로 교체
}
```

자식은 `fork`로 복사한 페이지를 **한 줄도 안 읽고 exec로 통째 덮어써요**.
부모가 힙 1MB, 코드 수십 KB를 들고 있었다면, fork는 그걸 전부 복제하느라 시간과 RAM을 쓰는데 — 자식은 `exec` 한 번에 그 사본을 전부 폐기합니다.
**복사한 만큼이 고스란히 낭비**인 거죠.

여기서 핵심 관찰은 이거예요.

- fork 직후 부모와 자식의 페이지 내용은 **완전히 똑같다.**
- 둘 중 **누군가 그 페이지에 쓰기 전까지는** 사본이 따로 필요 없다.
- 대부분의 페이지는 **아무도 안 쓴 채로** 자식의 `exec`/`exit`에서 사라진다.

그러니 똑똑한 전략은 명확해요 — **fork 시점엔 복사하지 말고, 일단 같이 보게 하다가, 쓰는 그 순간에만 그 페이지 하나를 복제한다.**
이게 Copy-on-Write입니다.

### fork 시 전체 복사 vs Copy-on-Write

핵심 차이는 **"비용을 언제 치르느냐"** 예요. 1편의 페이징·5편의 demand paging과 똑같은 구도입니다.

| 구분 | fork 시 전체 복사 | Copy-on-Write |
|------|----------------|---------------|
| fork의 비용 | 모든 페이지 `kalloc` + `memcpy` (무거움) | 페이지 복사 없이 PTE 권한 수정 + refcount++ (가벼움) |
| 복사 시점 | **fork 그 순간** (선불) | **누군가 쓰는 순간** (후불, 페이지 단위) |
| fork 후 곧 exec | 복사 → 즉시 폐기 (전부 낭비) | 복사 **아예 안 일어남** |
| 안 쓰는 페이지 | 그래도 복사됨 | 끝까지 공유, 복사 0회 |
| 추가로 필요한 것 | 없음 | 참조 카운트 + 쓰기 폴트 핸들러 |
| 비용 청구 시점 | 지금 즉시, 무조건 | 진짜 쓸 때만, 딱 그 페이지만 |

> **흔한 오해 정정**: *"COW는 fork 때 페이지를 복사한다"* 고 생각하기 쉬운데, 정확히 반대예요. **fork 때는 복사를 안 합니다** — 같은 물리 페이지를 읽기 전용으로 공유할 뿐이에요. 복사는 누군가 **쓰는 시점(write)** 에 일어나고, 그래서 이름이 copy-on-**write** 입니다. fork 직후 exec하는 자식에겐 복사가 **단 한 번도 안 일어나요.**

## 2. 토대 — 물리 페이지 참조 카운트

페이지를 공유하려면, 먼저 **"이 물리 페이지를 몇 개의 주소공간이 가리키나"** 를 알아야 해요.
부모와 자식이 같은 페이지를 공유하다가 한쪽이 떠나도, 다른 쪽이 아직 쓰고 있으면 그 페이지를 반납하면 안 되니까요.
"마지막 한 명이 떠날 때만 반납한다"를 알려면 **머릿수를 세야** 합니다.

### 핵심 질문

> 물리 페이지 하나를 여러 주소공간이 공유할 때, 언제 그 페이지를 진짜로 반납해도 안전할까요?

답은 **참조 카운트**예요. 물리 페이지마다 "지금 몇 명이 이 페이지를 쓰나"를 세는 카운터를 둡니다.
[1편의 할당기](/blog/hobby/kernel-hobby-00-boot-to-paging)에 이미 깔아둔 `refcnt` 배열이 그거예요.

```c
// kalloc.c — 물리 페이지마다 참조 카운트. 인덱스 = (pa - RAMBASE) / 4096.
#define RAMBASE 0x80000000UL
#define NPAGES  ((PHYSTOP - RAMBASE) / PGSIZE)
static uint8 refcnt[NPAGES];
static int refidx(void *pa) { return (int)(((uint64)pa - RAMBASE) >> 12); }
```

물리주소를 페이지 번호로 바꾸는 게 `refidx`예요 — RAM 시작(`0x8000_0000`)을 빼고 12비트 오른쪽으로 밀면(`>>12`, 즉 4096으로 나누면) 그 페이지의 배열 인덱스가 나와요.
`uint8` 한 바이트씩, 페이지마다 한 칸이죠.

반납 규칙은 `kfree` 안에 들어 있어요.

```c
// kalloc.c — refcount가 1보다 크면 반납하지 않고 카운트만 깎는다.
void kfree(void *pa) {
    acquire(&kmem_lock);
    int i = refidx(pa);
    if (refcnt[i] > 1) {          // 아직 다른 주소공간이 공유 중 → 반납하지 않음
        refcnt[i]--;
        release(&kmem_lock);
        return;
    }
    refcnt[i] = 0;                 // 마지막 소유자였다 → 진짜로 반납
    struct run *r = (struct run *)pa;
    r->next = freelist;           // free list 머리에 끼운다
    freelist = r;
    freecnt++;
    release(&kmem_lock);
}
```

세 가지 규칙으로 요약돼요.

- `kalloc`은 새로 떼어 준 페이지의 카운트를 **1**로 둬요(소유자 한 명).
- 공유가 시작되면 `kref_inc`로 **+1**.
- `kfree`는 **-1**, 그리고 **0이 될 때만** 진짜로 free list에 되돌려요.

```c
// kalloc.c — 공유 시작: 이 페이지를 가리키는 주소공간이 하나 늘었다.
void kref_inc(void *pa) {
    acquire(&kmem_lock);
    refcnt[refidx(pa)]++;
    release(&kmem_lock);
}
```

재밌는 디테일 하나 — `kinit`(부팅 때 빈 RAM을 free list로 미는 초기화)도 이 규칙 위에서 돌아요.

```c
// kalloc.c — 초기화: refcnt를 1로 둔 뒤 kfree(→0, 반납)해서 경로를 하나로 통일.
void kinit(void) {
    initlock(&kmem_lock);
    uint64 p = PGROUNDUP((uint64)end);
    for (; p + PGSIZE <= PHYSTOP; p += PGSIZE) {
        refcnt[refidx((void *)p)] = 1;   // 1로 두고
        kfree((void *)p);                // kfree가 1→0으로 보고 진짜 반납
    }
}
```

`refcnt`를 먼저 1로 세팅한 뒤 `kfree`를 부르는 게 핵심이에요.
그러면 "반납"이 언제나 `kfree`라는 **한 경로**를 통하게 돼서, 초기화든 평소 해제든 코드가 갈라지지 않아요.

> **흔한 오해 정정**: `refcnt`를 보고 *"가비지 컬렉터냐?"* 고 묶기 쉬운데, 아니에요. GC는 *"아무도 안 가리키는 객체를 런타임이 추적해서 자동으로 찾아 회수"* 하는 거고, 여기 참조 카운트는 그냥 **공유한 사람이 직접 +1, 떠나는 사람이 직접 -1** 하는 명시적 카운터예요. **"누가 마지막인지 세는 도구"** 그 이상도 이하도 아닙니다.

> **핵심 교훈**: 공유의 전제는 **수명 관리**예요. "같이 쓰자"는 쉽지만, "그럼 언제 버리지?"가 진짜 문제고, 참조 카운트가 그 답이에요. 이 한 겹이 깔려야 그 위에 COW를 안전하게 올릴 수 있어요.

## 3. fork를 COW로 — 공유하고, 표시를 숨겨둔다

이제 토대가 깔렸으니, fork에서 페이지를 복사하는 대신 공유해요.
요령은 **양쪽 모두 읽기 전용으로 만들고, "원래는 쓰기 가능했다"는 표시를 PTE에 숨겨두는** 거예요.

### 핵심 질문

> 부모와 자식이 같은 물리 페이지를 공유하는데, 둘 다 그 페이지에 "쓰기"가 허용돼 있었어요. 누가 쓰려는 순간을 어떻게 **하드웨어가 알아채서** 우리에게 알려줄까요?

답은 PTE의 **쓰기 비트를 일부러 떼는** 거예요.
쓰기 가능 페이지의 `PTE_W`를 떼면, 그 페이지에 쓰려는 순간 CPU가 **쓰기 페이지 폴트**를 일으켜요.
그 폴트가 곧 "지금 누군가 이 공유 페이지에 쓰려 한다"는 하드웨어의 신호예요.

그런데 `PTE_W`를 그냥 떼기만 하면, 나중에 "이게 원래 쓰기 가능했던 COW 페이지인지, 아니면 진짜 읽기 전용 코드 페이지인지" 구분을 못 해요.
그래서 **"이건 COW 공유 페이지다"** 라는 표시를 따로 남겨야 합니다.
RISC-V는 친절하게도 PTE에 **소프트웨어가 마음대로 쓰라고 비워둔 비트(RSW)** 를 줘요.

```c
// vm.h — PTE 플래그. RSW(소프트웨어 예약) 비트 하나를 COW 표시로 쓴다.
#define PTE_V   (1L << 0)
#define PTE_R   (1L << 1)
#define PTE_W   (1L << 2)
#define PTE_X   (1L << 3)
#define PTE_U   (1L << 4)
#define PTE_COW (1L << 8)   // RSW(bit 8): copy-on-write 공유 페이지 표시
```

`PTE_COW = (1 << 8)`이 그 표시예요.
하드웨어는 이 비트를 **번역에 전혀 안 써요**(주소 변환에도, 권한 검사에도 안 봄). 순수하게 우리 커널이 읽으려고 둔 메모예요.

이제 공유 로직이에요. `uvm_cow_share`가 부모의 `[start, end)` 범위 페이지들을 자식과 잇습니다.

```c
// vm.c — 부모의 [start,end) 매핑 페이지를 자식과 읽기전용으로 공유한다(복사 X).
int uvm_cow_share(pagetable_t parent, pagetable_t child, uint64 start, uint64 end) {
    for (uint64 a = start; a < end; a += PGSIZE) {
        pte_t *pte = walk(parent, a, 0);
        if (pte == 0 || !(*pte & PTE_V))
            continue;                         // 아직 폴트 안 난 페이지 → 자식이 따로 demand
        uint64 pa = PTE2PA(*pte);
        uint64 flags = PTE_FLAGS(*pte);
        if (flags & PTE_W) {                  // 쓰기 가능 → COW로 전환
            flags = (flags & ~PTE_W) | PTE_COW;
            *pte = PA2PTE(pa) | flags;        // 부모도 읽기전용 COW가 된다
        }
        if (mappages(child, a, PGSIZE, pa, flags) != 0)
            return -1;
        kref_inc((void *)pa);                 // 이제 두 주소공간이 공유 → refcount +1
    }
    sfence_vma();
    return 0;
}
```

세 가지를 눈여겨봐요.

1. **쓰기 가능 페이지만 COW로 바꿔요.** `flags & PTE_W`가 참일 때만 `PTE_W`를 떼고 `PTE_COW`를 달아요. 읽기 전용 페이지(예: 코드의 `R|X`)는 어차피 쓰기 폴트가 안 나니 그대로 공유해요.
2. **부모의 PTE도 같이 고쳐요.** `*pte`를 다시 쓰는 한 줄이 그거예요 — 부모도 이제 그 페이지를 읽기 전용 COW로 보게 돼요. 안 그러면 부모가 쓸 때 자식 모르게 공유 페이지를 망가뜨려요.
3. **물리 페이지는 복사 안 하고 `kref_inc`만 해요.** 이게 COW의 본질이에요 — fork가 `memcpy` 없이 카운터 증가 한 번으로 끝나요.

아직 폴트가 안 나서 매핑조차 없는 페이지(`!(*pte & PTE_V)`)는 그냥 건너뛰어요 — 그런 페이지는 자식이 나중에 접근하면 demand paging이 알아서 만들어 주거든요.

### 쓰기 폴트 → 복제

이제 부모도 자식도 그 페이지를 **읽을 순 있지만 쓸 수는 없어요**.
누군가 쓰려고 하면 하드웨어가 **쓰기(store) 페이지 폴트**(RISC-V `scause=15`)를 일으켜요.
그게 복제의 방아쇠예요.

```c
// vm.c — COW 쓰기 폴트: va가 COW 페이지면 새 페이지에 복사하고 쓰기가능으로 되돌린다.
// 1=처리됨(명령 재시도), 0=COW 페이지 아님(호출자가 계속 처리).
int uvm_cow_fault(pagetable_t pt, uint64 va) {
    uint64 a = PGROUNDDOWN(va);
    pte_t *pte = walk(pt, a, 0);
    if (pte == 0 || !(*pte & PTE_V) || !(*pte & PTE_COW))
        return 0;                             // COW 페이지가 아니면 패스
    uint64 old = PTE2PA(*pte);                // 공유 중인 옛 물리 페이지
    char *fresh = (char *)kalloc();           // 새 페이지를 받아
    if (fresh == 0)
        return 0;                             // 메모리 부족 → 진짜 폴트로
    memcopy(fresh, (void *)old, PGSIZE);      // 내용을 복사하고
    uint64 flags = (PTE_FLAGS(*pte) & ~PTE_COW) | PTE_W;  // COW 표시 제거 + 다시 쓰기 가능
    *pte = PA2PTE(fresh) | flags;
    sfence_vma();                             // 매핑 바꿨으니 TLB flush
    kfree((void *)old);                       // 옛 공유 페이지의 참조 카운트 -1
    return 1;
}
```

순서대로 — 새 페이지를 `kalloc`으로 받아서, 옛 공유 페이지 내용을 `memcopy`로 복사하고, PTE를 새 페이지로 바꾸면서 `PTE_COW`를 떼고 `PTE_W`를 복원해요.
마지막에 `kfree(old)`로 옛 공유 페이지의 참조 카운트를 깎아요 — 이제 이 주소공간은 옛 페이지를 안 보니까요.
중간의 `sfence_vma()`는 TLB를 비우는 건데 — CPU가 옛 PTE(읽기 전용 COW 매핑)를 TLB에 캐시해 뒀을 수 있어서, 새 PTE(쓰기 가능)가 곧바로 보이도록 하려는 거예요.

여기서 `kfree`가 **무조건 반납이 아니라는 점**이 빛나요.
부모와 자식이 공유 중이었다면 옛 페이지의 `refcnt`는 2였고, `kfree`는 1로 깎기만 하고 페이지는 살려둬요 — 아직 다른 쪽이 쓰고 있으니까요.
2절의 참조 카운트가 정확히 여기서 일을 합니다.

### demand paging보다 먼저 검사해야 한다

페이지 폴트 핸들러에선 이 COW 검사를 demand paging보다 **먼저** 둬야 해요.

```c
// proc.c — proc_pagefault: 쓰기 폴트면 COW부터.
//  COW 페이지는 이미 매핑돼 있으므로, "빈 페이지 새로 할당"하는 demand 분기보다 우선.
if (store && uvm_cow_fault(p->pagetable, a)) {
    uart_puts("[cow] copied a shared page on write at va=");
    uart_hex(a); uart_putc('\n');
    return 1;
}

if (a >= HEAPBASE && a < p->heap_top) {     // --- 힙: 빈 페이지 (demand paging) ---
    char *mem = kalloc();
    // ...
}
```

순서가 왜 중요하냐면 — COW 페이지는 **이미 물리 페이지가 매핑돼 있는** 상태예요(읽기 전용으로).
그런데 폴트 주소가 힙 영역이기도 해서, COW를 먼저 안 보고 demand 분기로 가면 "빈 페이지를 새로 할당"해서 **이미 있던 공유 데이터(42 같은 값)를 0으로 덮어써** 버려요.
"이미 매핑된 페이지의 쓰기 폴트"(=COW)와 "매핑이 아예 없는 페이지의 폴트"(=demand)는 다른 사건이고, COW가 더 구체적인 경우라 먼저 걸러야 합니다.

순서를 뒤집으면(demand를 먼저 검사하면) 어떻게 깨지는지 그림으로 보면:

![순서를 뒤집어 demand를 먼저 검사하면, 값 42의 읽기전용 공유 페이지가 store 폴트 후 demand로 오인돼 0으로 덮여 42가 사라진다 — 그래서 COW를 먼저 검사해야 한다](/uploads/hobby/kernel-hobby-c/cow-wrong-order.svg)

> **핵심 교훈**: COW의 전부는 이 흐름이에요 — **fork는 가벼워지고**(복사 0회), **복사는 진짜 쓰는 순간, 쓰는 쪽이 그 페이지의 사본을 하나 만드는 것**뿐이에요(쓰기 한 번 = 사본 한 장). fork 직후 곧장 exec하는 자식은 공유 페이지에 쓸 일이 없으니 복사가 **아예 안 일어나죠.** 1절에서 본 낭비가 정확히 사라집니다.

## 4. fork가 실제로 무엇을 공유하나 — 코드·힙·스택

이제 `proc_fork`가 세 종류의 페이지를 **각각 다르게** 다루는 걸 봐요.
**코드는 COW 공유, 힙도 COW 공유, 그런데 스택만은 통째 복사** — 여기에 우리 커널만의 트레이드오프가 숨어 있어요.

```c
// proc.c — proc_fork에서 페이지를 다루는 부분
//  코드: COW 공유 / 힙: COW 공유 / 스택: 사적 복사
char *ustack = kalloc();
copybytes(ustack, parent->ustack, PGSIZE);             // 스택만 통째 복사
kref_inc(parent->ucode);                                // 코드는 공유 → refcount++
child->ucode = parent->ucode;
child->ustack = ustack;
child->pagetable = proc_pagetable((uint64)parent->ucode, (uint64)ustack);

// 힙 페이지: COW로 공유(쓰기 시 비로소 복제). 부모가 이미 건드린 힙만 대상.
uvm_cow_share(parent->pagetable, child->pagetable, HEAPBASE, parent->heap_top);
```

- **코드 페이지**는 `R|X|U`라 쓰기 폴트가 날 일이 없어요. 그래서 (우리 구현에선) `PTE_COW` 표시도 필요 없이 그냥 같은 물리 페이지를 자식 테이블에 매핑하고 `kref_inc`만 해요. 가장 단순한 공유예요.
- **힙 페이지**는 `R|W`라 쓰기 폴트가 날 수 있어요. 그래서 `uvm_cow_share`로 양쪽 다 `PTE_W`를 떼고 `PTE_COW`를 달아 3절의 복제 흐름에 태워요. `HEAPBASE`부터 `parent->heap_top`까지, **부모가 실제로 건드린 힙만** 대상이에요(아직 안 만든 힙은 자식이 demand로 따로 받음).
- **스택 페이지**만 옛날 방식 그대로 `kalloc` + `copybytes`로 통째 복사해요. 왜 스택만 특별 취급일까요?

### 우리만의 제약 — 스택은 COW로 공유할 수 없다

> 코드·힙은 COW로 공유하는데, 왜 스택만 통째 복사할까요?

우리 fork가 자식의 **트랩 프레임을 유저 스택 위에서 직접 고쳐 쓰기** 때문이에요.

```c
// proc.c — 자식의 fork() 반환값을 0으로, 복귀 지점을 ecall 다음 명령으로
uint64 off = (uint64)f - USERSTACK;
struct regframe *cf = (struct regframe *)(ustack + off);
cf->a0 = 0;             // 자식의 fork() 반환값 = 0
cf->sepc = f->sepc + 4; // ecall 다음 명령부터(부모는 자식 pid를 받고, 자식은 0을 받음)
```

`fork`는 부모에게 자식 pid를, 자식에게 0을 돌려줘야 해요.
부모와 자식의 차이가 바로 이 두 줄 — 자식의 트랩 프레임에서 `a0`(반환 레지스터)을 0으로, `sepc`(복귀 주소)를 `ecall` 다음으로 고치는 거예요.
그런데 이 트랩 프레임이 **유저 스택 위에 얹혀 있어요**(`cf = ustack + off`).

만약 스택을 COW로 공유한다면, 이 두 줄이 **부모의 스택까지 망가뜨려요** — 같은 물리 페이지니까요.
자식 fork() 반환값을 0으로 쓰는 순간 부모의 반환값도 0이 돼버리는 거죠.
게다가 이 수정은 **fork가 끝나기 전, 자식이 한 번도 안 도는 시점**에 일어나서 COW 폴트로 잡아낼 기회조차 없어요.
그래서 스택만큼은 **사적 복사**를 유지해야 합니다.

### 단순함 ↔ 최적화 완전함 사이의 선택

이건 [xv6와 다른 설계](/blog/hobby/kernel-hobby-02-fork-elf-filesystem)에서 온 비용이에요.

| 구분 | xv6 | 우리 커널 |
|------|-----|----------|
| 트랩 프레임 위치 | 별도의 커널 페이지(trapframe) | 유저 스택 위 |
| 트램폴린 복잡도 | 더 복잡(전용 매핑 관리) | 더 단순 |
| 스택 COW 가능? | 가능(프레임이 스택 밖이라) | **불가**(프레임이 스택 안이라) |

xv6는 트랩 프레임을 스택 밖 **별도 커널 페이지**에 둬서 스택도 COW로 공유할 수 있어요.
우리는 트램폴린을 단순화하려고 프레임을 유저 스택 위에 얹었고, 그 단순함의 대가가 "스택은 COW 못 함"이에요. 즉 이건 COW의 보편적 한계가 아니라 **우리 설계 선택의 결과**예요 — 리눅스나 xv6는 스택도 COW로 공유합니다.

그래도 손해는 작아요.
스택은 보통 **한 페이지**고, 정작 덩치 큰 힙과 코드는 COW로 공유하니까요.
**"설계의 단순함 ↔ 최적화의 완전함"** 사이에서 우리는 단순함을 택했고, **그 경계가 정확히 어디인지를 아는 것**이 핵심이에요.

> **핵심 교훈**: 최적화에는 거의 항상 전제 조건이 숨어 있어요. COW의 전제는 "공유한 페이지를 누가 쓰면 그걸 폴트로 잡을 수 있어야 한다"인데, 스택은 fork 도중 커널이 폴트 없이 직접 고쳐 쓰니 그 전제가 깨져요. **최적화를 어디까지 적용할 수 있는지는 그 전제가 어디서 깨지는지로 결정**돼요.

## 5. 눈으로 확인하기

`cowtest`는 힙에 42를 쓰고 fork한 뒤, 자식이 99를 써요.
COW가 맞다면 자식의 쓰기는 부모에게 **안 보여야** 해요.

```c
// user/cowtest.c — 핵심 부분
char *p = (char *)sys_sbrk(4096);   // 힙 한 페이지(폴트 시 할당)
p[0] = 42;                          // 여기서 demand-alloc(쓰기 가능)
long pid = sys_fork();             // 이 시점에 힙 페이지가 COW 공유된다
if (pid == 0) {                    // 자식
    /* p[0]을 읽으면 42 (공유) */
    p[0] = 99;                     // 쓰기 → COW 복제 발생
    /* p[0]은 이제 99 (자식만의 사본) */
} else {                           // 부모
    sys_wait();
    /* p[0]은 여전히 42 (격리 성공) */
}
```

실제 출력이에요.

```
cowtest: heap에 42를 쓰고 fork
[pagefault] demand-allocated a heap page at va=0x10000   ← ① 부모가 42 쓸 때 힙 페이지 할당
  child: 공유된 p[0]=42                                    ← ② 자식이 공유값 42를 봄 (복사 안 함)
[cow] copied a shared page on write at va=0x10000        ← ③ 자식이 쓰는 "그 순간" 복제
 -> 99 기록 후 p[0]=99                                    ← ④ 자식만의 사본에 99
  parent: p[0]=42 (42여야 격리 성공)                       ← ⑤ 부모는 여전히 42
```

다섯 줄이 COW의 생애를 순서대로 보여줘요.

- **① demand-allocated** — 부모가 `p[0]=42`를 쓸 때, 5편의 demand paging이 힙 페이지를 처음 할당해요. (아직 COW와 무관.)
- **② child: 42** — fork 후 자식이 `p[0]`을 **읽기만** 하면 공유값 42가 그대로 보여요. 복사가 **안 일어났다**는 증거예요.
- **③ [cow] copied ... on write** — 자식이 `p[0]=99`를 쓰는 순간, 바로 그때 복제가 일어나요. **이 줄이 이 글의 핵심**이에요.
- **④ 자식 p[0]=99** — 자식은 이제 자기만의 사본을 봐요.
- **⑤ 부모 p[0]=42** — 부모는 여전히 42. 자식의 쓰기가 부모에게 **격리**됐어요.

가장 중요한 줄은 **③ `[cow] copied ... on write`** 예요.
복제가 **fork 시점(②)이 아니라 자식이 쓰는 시점(③)** 에 일어났다는 증거거든요.
②와 ③ 사이의 시간차가 바로 "copy-on-**write**"라는 이름의 의미예요 — 만약 fork 때 복사했다면 ③ 같은 줄은 영원히 안 떴겠죠.

### 누수 없음 — 참조 카운트의 마지막 증명

메모리 누수도 확인했어요.
`hello`(fork+exec를 반복)를 돌리고 `cowtest`까지 돌려도, 빈 페이지 수가 **32058에서 한 칸도 안 움직여요.**

```
hobby> mem
free pages: 32058
hobby> cowtest
... (위 출력) ...
hobby> mem
free pages: 32058     ← 정확히 원래대로 복귀
```

이게 왜 중요하냐면, COW에는 **누수가 끼어들 자리가 많거든요.**

- 공유한 페이지를 양쪽이 다 `kfree`해서 **두 번 반납**하면? → free list가 깨져요.
- 복제한 새 페이지를 아무도 `kfree` 안 하면? → 누수예요.
- 공유 중인 페이지를 한쪽이 `kfree`했다고 진짜 반납해버리면? → 다른 쪽이 죽은 페이지를 봐요.

참조 카운트가 이걸 전부 막아요.
공유한 페이지든 복제한 페이지든, **마지막 소유자가 떠날 때 정확히 한 번** 반납돼요.
`32058 → 32058`이라는 숫자가 그 불변식이 지켜졌다는 정량적 증거예요.

> **흔한 오해 정정**: *"공유 페이지를 둘 다 `kfree`하면 더블 프리 아니냐"* 는 걱정은 정확히 참조 카운트가 푸는 문제예요. 첫 `kfree`는 `refcnt 2→1`로 깎기만 하고 페이지는 살려둬요. 두 번째 `kfree`가 와서야 `1→0`이 되며 진짜 반납돼요. **`kfree`는 "반납"이 아니라 "참조 하나 놓기"** 라고 읽어야 정확해요.

## 6. 정리

Copy-on-Write는 작은 코드로 큰 효과를 내는, OS의 우아한 최적화예요.
fork가 "주소공간 통째 복사"에서 "포인터 몇 개 공유 + 카운터 증가"로 가벼워졌고, 정작 복사는 진짜 쓸 때 딱 그 페이지만 한 번 일어나요.

- **풀려는 문제** — fork는 주소공간을 통째 복사하는데, 대부분의 자식은 곧장 exec해 그 복사본을 버려요. 복사한 만큼이 낭비.
- **토대(참조 카운트)** — 물리 페이지마다 "몇 명이 공유하나"를 세요. `kalloc`=1, `kref_inc`=+1, `kfree`=−1이고 **0일 때만** 진짜 반납. GC가 아니라 명시적 카운터예요.
- **fork를 COW로** — 쓰기 가능 페이지의 `PTE_W`를 떼고 RSW 비트 `PTE_COW`(1<<8)를 달아 양쪽이 읽기 전용 공유. 쓰기 폴트(`scause=15`)가 나면 `uvm_cow_fault`가 그 페이지만 복제하고 쓰기 권한을 복원해요. 이 검사는 demand paging보다 **먼저** 와야 해요.
- **우리만의 제약** — 코드·힙은 COW 공유하지만 **스택은 통째 복사**해요. fork가 트랩 프레임을 유저 스택 위에서 직접 고쳐 쓰는데, 공유하면 부모 스택까지 망가지거든요. 단순한 트램폴린 설계의 대가예요.
- **검증** — `cowtest`에서 자식 99 / 부모 42로 격리가 확인되고, 빈 페이지가 **32058에서 고정**돼 누수가 없어요.

돌아보면 이번 작업은 **이미 가진 부품의 재조합**이었어요.
페이지 폴트 핸들러(5편), 페이지 테이블 조작(1편), 물리 할당기와 참조 카운트(1편) — 전부 있던 걸 엮으니 COW가 됐죠.
*"새 기능은 대개 기존 메커니즘의 새로운 조합"* 이라는 걸 다시 느꼈어요. COW는 페이지 복사 알고리즘을 새로 만든 게 아니라, **페이지 폴트·페이지 테이블·참조 카운트라는 기존 메커니즘을 조합한 결과**예요.

> 코드: [github.com/dj258255/kernel-hobby](https://github.com/dj258255/kernel-hobby)
> 다음 글: **멀티코어 (예정)**

## 참고 (1차 자료 우선)

- [RISC-V Privileged Specification](https://riscv.org/technical/specifications/) — PTE의 **RSW(소프트웨어 예약) 비트**(`PTE_COW`가 여기 얹힘), store 페이지 폴트(`scause=15`), `sfence.vma`의 1차 정의
- [xv6: a simple, Unix-like teaching operating system (MIT 6.S081)](https://pdos.csail.mit.edu/6.828/2023/xv6.html) — **COW fork 랩**. `kalloc`의 참조 카운트, `uvmcopy`/usertrap의 COW 분기가 1:1로 대응
- 관련 글: [부팅부터 페이징까지(할당기·참조 카운트)](/blog/hobby/kernel-hobby-00-boot-to-paging) · [demand paging과 mmap](/blog/hobby/kernel-hobby-04-paging-mmap-writable-fs) · [fork와 ELF 로더](/blog/hobby/kernel-hobby-02-fork-elf-filesystem)
- [OSDev Wiki](https://wiki.osdev.org/) — 보조 자료

<!-- EN -->

*A RISC-V toy kernel built from scratch — a blog series. This is Part 8: Copy-on-Write fork (deferring the copy until the write).*

## 0. Introduction

The [`fork` we built in Part 2](/blog/hobby/kernel-hobby-01-usermode-to-processes) is honest but brute-force.
It **copies the parent's entire address space** — code page, stack page, the whole heap.

This post rewrites that `fork` as **Copy-on-Write (COW)**.
The core idea is one sentence — **"defer the copy until the write."**
At fork time the parent and child **share the same physical pages read-only**, and only when someone **tries to write** is the page copied.

We need exactly two parts to build this — a **reference count** on each physical page, and a **write page fault** that copies just that one page. And there's an interesting constraint unique to our kernel — **in our implementation, the stack can't be shared via COW.** (General kernels like Linux and xv6 do COW their stacks; ours can't — why is in §4.) We'll walk through why that constraint exists and what trade-off it represents.

> Why COW now: this is exactly the same philosophy as [demand paging in Part 5](/blog/hobby/kernel-hobby-04-paging-mmap-writable-fs) — "defer the work until it's actually needed." There we deferred page **allocation**; here we defer page **copying**. So we reuse the page fault handler we built back then almost verbatim. COW isn't a new mechanism so much as **a new policy laid on top of the existing page-fault mechanism** — a recombination of parts we already have: page faults, page tables, and reference counts.

## 1. The Real Problem Copy-on-Write Has to Solve

> `fork` copies the parent's entire address space. But most of that copy is **thrown away by the child without ever being used.** How do we remove the waste?

Real-world `fork` is overwhelmingly used in this pattern.

```c
if (fork() == 0) {
    exec("program");   // child: immediately throws away the freshly copied address space and replaces it
}
```

The child **overwrites the pages copied by `fork` via exec without reading a single line of them**.
If the parent held 1MB of heap and tens of KB of code, fork spends time and RAM duplicating all of it — and the child discards the whole copy with one `exec`.
**Everything copied is pure waste.**

The key observation here:

- Right after fork, the parent's and child's page contents are **identical.**
- No separate copy is needed **until one of them writes** to a page.
- Most pages **vanish, never written**, at the child's `exec`/`exit`.

So the smart strategy is clear — **don't copy at fork time; let them share for now, and copy that single page only at the moment it's written.**
That's Copy-on-Write.

### Full copy at fork vs Copy-on-Write

The crux is **"when do you pay the cost."** Same structure as paging in Part 1 and demand paging in Part 5.

| Aspect | Full copy at fork | Copy-on-Write |
|--------|-------------------|---------------|
| Cost of fork | `kalloc` + `memcpy` every page (heavy) | no page copy — tweak PTE permissions + refcount++ (light) |
| When the copy happens | **at the fork instant** (up front) | **the moment someone writes** (deferred, per page) |
| fork then exec | copy → discard immediately (all wasted) | copy **never happens** |
| pages never written | copied anyway | shared to the end, copied 0 times |
| extra machinery needed | none | reference count + write fault handler |
| When you're billed | now, unconditionally | only on a real write, only that page |

> **Common misconception fix**: it's easy to think *"COW copies pages at fork time"* — it's exactly the opposite. **At fork time nothing is copied** — the same physical page is merely shared read-only. The copy happens at the **moment of a write**, which is why it's called copy-on-**write**. For a child that execs right after fork, the copy happens **not even once.**

## 2. The Foundation — Physical Page Reference Counts

To share a page, you first need to know **"how many address spaces point at this physical page."**
If the parent and child share a page and one leaves, you mustn't reclaim it while the other is still using it.
To know "reclaim only when the last one leaves," you have to **count heads.**

### Key question

> When several address spaces share one physical page, when is it actually safe to reclaim that page?

The answer is a **reference count**. Each physical page gets a counter for "how many are using this page right now."
The `refcnt` array we already laid down in [Part 1's allocator](/blog/hobby/kernel-hobby-00-boot-to-paging) is exactly that.

```c
// kalloc.c — a reference count per physical page. index = (pa - RAMBASE) / 4096.
#define RAMBASE 0x80000000UL
#define NPAGES  ((PHYSTOP - RAMBASE) / PGSIZE)
static uint8 refcnt[NPAGES];
static int refidx(void *pa) { return (int)(((uint64)pa - RAMBASE) >> 12); }
```

`refidx` turns a physical address into a page number — subtract the RAM base (`0x8000_0000`) and shift right by 12 (`>>12`, i.e. divide by 4096), and you get that page's array index.
One `uint8` byte per page, one slot each.

The reclaim rule lives inside `kfree`.

```c
// kalloc.c — if refcount > 1, don't reclaim; just decrement.
void kfree(void *pa) {
    acquire(&kmem_lock);
    int i = refidx(pa);
    if (refcnt[i] > 1) {          // still shared by another address space → don't reclaim
        refcnt[i]--;
        release(&kmem_lock);
        return;
    }
    refcnt[i] = 0;                 // was the last owner → reclaim for real
    struct run *r = (struct run *)pa;
    r->next = freelist;           // push onto the free list head
    freelist = r;
    freecnt++;
    release(&kmem_lock);
}
```

Three rules sum it up.

- `kalloc` sets a freshly handed-out page's count to **1** (one owner).
- When sharing begins, `kref_inc` does **+1**.
- `kfree` does **−1**, and returns it to the free list for real **only when it hits 0**.

```c
// kalloc.c — sharing begins: one more address space points at this page.
void kref_inc(void *pa) {
    acquire(&kmem_lock);
    refcnt[refidx(pa)]++;
    release(&kmem_lock);
}
```

A nice detail — `kinit` (the boot-time init that pushes free RAM onto the list) also runs on this rule.

```c
// kalloc.c — init: set refcnt to 1, then kfree (→0, reclaim) to unify the path.
void kinit(void) {
    initlock(&kmem_lock);
    uint64 p = PGROUNDUP((uint64)end);
    for (; p + PGSIZE <= PHYSTOP; p += PGSIZE) {
        refcnt[refidx((void *)p)] = 1;   // set to 1, then
        kfree((void *)p);                // kfree sees 1→0 and reclaims for real
    }
}
```

The point is setting `refcnt` to 1 *first*, then calling `kfree`.
That way "reclaim" always goes through the **single path** of `kfree`, so init and ordinary frees never branch into separate code.

> **Common misconception fix**: seeing `refcnt`, it's tempting to lump it in as *"a garbage collector?"* — it's not. GC means *"the runtime tracks objects nobody points at and reclaims them automatically"*; this reference count is just an explicit counter where the **sharer does +1 and the leaver does −1** by hand. It's **"a tool to count who's last"**, nothing more, nothing less.

> **Key lesson**: the prerequisite for sharing is **lifetime management.** "Let's share" is easy; the real question is "so when do we throw it away?", and the reference count is the answer. Only with this one layer in place can you safely stack COW on top.

## 3. Turning fork into COW — Share, and Hide a Marker

Now that the foundation is laid, in fork we share pages instead of copying them.
The trick is to **make both sides read-only and hide a "this was originally writable" marker in the PTE**.

### Key question

> The parent and child share the same physical page, and both had "write" permitted on it. How does the **hardware notice** the instant one tries to write, and tell us?

The answer is to **deliberately drop the write bit** in the PTE.
Strip `PTE_W` from a writable page, and the moment someone writes to it the CPU raises a **write page fault**.
That fault is the hardware's signal that "someone is trying to write this shared page right now."

But if you only strip `PTE_W`, you later can't tell "was this an originally-writable COW page, or a genuinely read-only code page?"
So you have to leave a separate marker that says **"this is a COW shared page."**
RISC-V kindly gives the PTE bits **reserved for software (RSW)** to use however we like.

```c
// vm.h — PTE flags. We use one RSW (software-reserved) bit as the COW marker.
#define PTE_V   (1L << 0)
#define PTE_R   (1L << 1)
#define PTE_W   (1L << 2)
#define PTE_X   (1L << 3)
#define PTE_U   (1L << 4)
#define PTE_COW (1L << 8)   // RSW (bit 8): marks a copy-on-write shared page
```

`PTE_COW = (1 << 8)` is that marker.
The hardware **never uses this bit for translation** (neither for address translation nor permission checks). It's purely a note our kernel left for itself to read.

Now the sharing logic. `uvm_cow_share` links the parent's pages in `[start, end)` to the child.

```c
// vm.c — share the parent's [start,end) mapped pages with the child read-only (no copy).
int uvm_cow_share(pagetable_t parent, pagetable_t child, uint64 start, uint64 end) {
    for (uint64 a = start; a < end; a += PGSIZE) {
        pte_t *pte = walk(parent, a, 0);
        if (pte == 0 || !(*pte & PTE_V))
            continue;                         // not yet faulted in → child demands it separately
        uint64 pa = PTE2PA(*pte);
        uint64 flags = PTE_FLAGS(*pte);
        if (flags & PTE_W) {                  // writable → convert to COW
            flags = (flags & ~PTE_W) | PTE_COW;
            *pte = PA2PTE(pa) | flags;        // the parent becomes read-only COW too
        }
        if (mappages(child, a, PGSIZE, pa, flags) != 0)
            return -1;
        kref_inc((void *)pa);                 // now two address spaces share it → refcount +1
    }
    sfence_vma();
    return 0;
}
```

Three things to watch.

1. **Only writable pages become COW.** Only when `flags & PTE_W` is true do we strip `PTE_W` and set `PTE_COW`. Read-only pages (e.g. code's `R|X`) never write-fault, so they're shared as-is.
2. **The parent's PTE is edited too.** That re-write of `*pte` is the line — the parent now sees the page as read-only COW as well. Otherwise the parent could corrupt the shared page behind the child's back when it writes.
3. **The physical page isn't copied — just `kref_inc`.** This is the essence of COW — fork finishes with a single counter increment, no `memcpy`.

Pages not yet faulted in, with no mapping at all (`!(*pte & PTE_V)`), are simply skipped — the child's demand paging will create those later on access.

### Write fault → copy

Now both parent and child **can read but not write** that page.
When one tries to write, the hardware raises a **store page fault** (RISC-V `scause=15`).
That's the trigger for the copy.

```c
// vm.c — COW write fault: if va is a COW page, copy it to a fresh page and restore write.
// 1 = handled (retry the instruction), 0 = not a COW page (caller keeps handling).
int uvm_cow_fault(pagetable_t pt, uint64 va) {
    uint64 a = PGROUNDDOWN(va);
    pte_t *pte = walk(pt, a, 0);
    if (pte == 0 || !(*pte & PTE_V) || !(*pte & PTE_COW))
        return 0;                             // not a COW page → pass
    uint64 old = PTE2PA(*pte);                // the old, shared physical page
    char *fresh = (char *)kalloc();           // grab a new page,
    if (fresh == 0)
        return 0;                             // out of memory → fall through to a real fault
    memcopy(fresh, (void *)old, PGSIZE);      // copy the contents, and
    uint64 flags = (PTE_FLAGS(*pte) & ~PTE_COW) | PTE_W;  // drop COW + make writable again
    *pte = PA2PTE(fresh) | flags;
    sfence_vma();                             // mapping changed → flush TLB
    kfree((void *)old);                       // drop the old shared page's refcount
    return 1;
}
```

In order — grab a new page with `kalloc`, copy the old shared page's contents with `memcopy`, point the PTE at the new page while stripping `PTE_COW` and restoring `PTE_W`.
The `sfence_vma()` in the middle flushes the TLB — the CPU may still be caching the old PTE (the read-only COW mapping), so we flush to make the new PTE (now writable) visible immediately.
Finally `kfree(old)` decrements the old shared page's reference count — this address space no longer looks at the old page.

Here's where `kfree` being **not an unconditional reclaim** shines.
If parent and child were sharing, the old page's `refcnt` was 2, and `kfree` only drops it to 1, keeping the page alive — the other side is still using it.
Section 2's reference count does its job exactly here.

### It must be checked before demand paging

In the page fault handler this COW check must come **before** demand paging.

```c
// proc.c — proc_pagefault: on a write fault, COW first.
//  A COW page is already mapped, so it precedes the "allocate a fresh page" demand branch.
if (store && uvm_cow_fault(p->pagetable, a)) {
    uart_puts("[cow] copied a shared page on write at va=");
    uart_hex(a); uart_putc('\n');
    return 1;
}

if (a >= HEAPBASE && a < p->heap_top) {     // --- heap: fresh page (demand paging) ---
    char *mem = kalloc();
    // ...
}
```

Why order matters — a COW page **already has a physical page mapped** (read-only).
But the fault address is also in the heap region, so if we don't check COW first and fall into the demand branch, it would "allocate a fresh page" and **overwrite the existing shared data (a value like 42) with zeros.**
"A write fault on an already-mapped page" (COW) and "a fault on a page with no mapping at all" (demand) are different events, and COW is the more specific case, so it must be filtered first.

Here's how it breaks if you reverse the order (check demand first):

![Reversing the order to check demand first: the read-only shared page holding 42 takes a store fault, is mistaken for demand, overwritten with zeros, and 42 is lost — so COW must be checked first](/uploads/hobby/kernel-hobby-c/cow-wrong-order-en.svg)

> **Key lesson**: all of COW is this flow — **fork gets lighter** (0 copies), and **the copy happens at the moment of a real write, where the writing side makes its own copy of that one page** (one write = one copy). A child that execs right after fork never writes the shared pages, so the copy happens **not even once.** The waste from Section 1 vanishes exactly.

## 4. What fork Actually Shares — Code, Heap, Stack

Now let's see how `proc_fork` treats three kinds of pages **each differently.**
**Code is COW-shared, heap is COW-shared, but the stack alone is copied whole** — this is where our kernel's own trade-off hides.

```c
// proc.c — the page-handling part of proc_fork
//  code: COW share / heap: COW share / stack: private copy
char *ustack = kalloc();
copybytes(ustack, parent->ustack, PGSIZE);             // stack: copy whole
kref_inc(parent->ucode);                                // code: share → refcount++
child->ucode = parent->ucode;
child->ustack = ustack;
child->pagetable = proc_pagetable((uint64)parent->ucode, (uint64)ustack);

// heap pages: COW share (copied only on write). Only the heap the parent actually touched.
uvm_cow_share(parent->pagetable, child->pagetable, HEAPBASE, parent->heap_top);
```

- **Code pages** are `R|X|U`, so they'll never write-fault. So they need no `PTE_COW` marker — just map the same physical page into the child's table and `kref_inc`. The simplest sharing.
- **Heap pages** are `R|W`, so they can write-fault. So `uvm_cow_share` strips `PTE_W` and sets `PTE_COW` on both sides, putting them on Section 3's copy flow. From `HEAPBASE` to `parent->heap_top` — **only the heap the parent actually touched** (heap not yet created is demanded separately by the child).
- **Stack pages** alone are copied whole the old way, `kalloc` + `copybytes`. Why is the stack the special case?

### Our own constraint — the stack can't be COW-shared

> Code and heap are COW-shared, so why is the stack copied whole?

Because our fork **edits the child's trap frame directly on the user stack.**

```c
// proc.c — set the child's fork() return value to 0, return point to after the ecall
uint64 off = (uint64)f - USERSTACK;
struct regframe *cf = (struct regframe *)(ustack + off);
cf->a0 = 0;             // child's fork() return value = 0
cf->sepc = f->sepc + 4; // from the instruction after ecall (parent gets the child pid, child gets 0)
```

`fork` must return the child pid to the parent and 0 to the child.
The difference between parent and child is exactly these two lines — in the child's trap frame, set `a0` (the return register) to 0 and `sepc` (the return address) to just after the `ecall`.
And this trap frame **sits on the user stack** (`cf = ustack + off`).

If we shared the stack as COW, these two lines would **corrupt the parent's stack too** — it's the same physical page.
The instant we write 0 as the child's fork() return value, the parent's return value becomes 0 as well.
Worse, this edit happens **before fork even finishes, at a point where the child has never run once**, so there isn't even a chance to catch it with a COW fault.
So the stack alone must stay a **private copy.**

### A choice between simplicity and completeness of optimization

This is a cost that comes from a [design different from xv6's](/blog/hobby/kernel-hobby-02-fork-elf-filesystem).

| Aspect | xv6 | Our kernel |
|--------|-----|------------|
| Trap frame location | a separate kernel page (trapframe) | on the user stack |
| Trampoline complexity | more complex (manage a dedicated mapping) | simpler |
| Stack COW possible? | yes (frame is outside the stack) | **no** (frame is inside the stack) |

xv6 keeps the trap frame in a **separate kernel page** outside the stack, so it can COW-share the stack too.
We put the frame on the user stack to simplify the trampoline, and the price of that simplicity is "the stack can't be COW." So this isn't a universal limit of COW but **a consequence of our design choice** — Linux and xv6 do COW-share the stack.

Still, the loss is small.
The stack is usually **one page**, while the bulky heap and code are shared via COW.
Between **"simplicity of design ↔ completeness of optimization"** we chose simplicity, and **knowing exactly where that boundary lies** is what matters.

> **Key lesson**: an optimization almost always hides a precondition. COW's precondition is "if someone writes a shared page, we must be able to catch it as a fault" — but the stack is edited directly by the kernel during fork, without a fault, so that precondition breaks. **How far an optimization can be applied is decided by where its precondition breaks.**

## 5. Seeing It With Your Own Eyes

`cowtest` writes 42 to the heap, forks, and then the child writes 99.
If COW is correct, the child's write must be **invisible** to the parent.

```c
// user/cowtest.c — the core
char *p = (char *)sys_sbrk(4096);   // one heap page (allocated on fault)
p[0] = 42;                          // demand-alloc here (writable)
long pid = sys_fork();             // at this point the heap page is COW-shared
if (pid == 0) {                    // child
    /* reading p[0] gives 42 (shared) */
    p[0] = 99;                     // write → COW copy fires
    /* p[0] is now 99 (the child's own copy) */
} else {                           // parent
    sys_wait();
    /* p[0] is still 42 (isolation succeeded) */
}
```

The actual output.

```
cowtest: write 42 to heap, then fork
[pagefault] demand-allocated a heap page at va=0x10000   ← ① heap page allocated when parent writes 42
  child: shared p[0]=42                                   ← ② child sees the shared value 42 (no copy)
[cow] copied a shared page on write at va=0x10000        ← ③ copied at the very moment the child writes
 -> after writing 99, p[0]=99                            ← ④ 99 in the child's own copy
  parent: p[0]=42 (must be 42 for isolation)             ← ⑤ parent still sees 42
```

Five lines show COW's whole life in order.

- **① demand-allocated** — when the parent writes `p[0]=42`, Part 5's demand paging allocates the heap page for the first time. (Still nothing to do with COW.)
- **② child: 42** — after fork, when the child only **reads** `p[0]`, the shared value 42 shows through. Proof that **no copy happened.**
- **③ [cow] copied ... on write** — the instant the child writes `p[0]=99`, that's when the copy happens. **This line is the heart of this post.**
- **④ child p[0]=99** — the child now sees its own copy.
- **⑤ parent p[0]=42** — the parent is still 42. The child's write was **isolated** from the parent.

The most important line is **③ `[cow] copied ... on write`**.
It's proof that the copy happened **at the child's write (③), not at fork (②).**
The time gap between ② and ③ is exactly what the name "copy-on-**write**" means — had we copied at fork, a line like ③ would never have appeared.

### No leaks — the final proof of reference counting

I also checked for memory leaks.
Running `hello` (which repeats fork+exec) and then `cowtest`, the free page count **doesn't move a single slot from 32058.**

```
hobby> mem
free pages: 32058
hobby> cowtest
... (the output above) ...
hobby> mem
free pages: 32058     ← back exactly where it started
```

This matters because COW has **plenty of room for leaks.**

- If both sides `kfree` a shared page and it gets **double-freed**? → the free list corrupts.
- If nobody `kfree`s a copied new page? → that's a leak.
- If reclaiming a still-shared page for real because one side `kfree`d it? → the other side sees a dead page.

Reference counting prevents all of these.
Whether a page was shared or copied, it's reclaimed **exactly once, when the last owner leaves.**
The number `32058 → 32058` is quantitative proof that the invariant held.

> **Common misconception fix**: the worry that *"if both sides `kfree` a shared page, isn't that a double free?"* is exactly the problem reference counting solves. The first `kfree` only drops `refcnt 2→1` and keeps the page alive. Only the second `kfree` takes it `1→0` and reclaims it for real. Read **`kfree` as "drop one reference," not "free"** to get it right.

## 6. Wrap-up

Copy-on-Write is one of those elegant OS optimizations that achieve a lot with little code.
fork went from "copy the whole address space" to "share a few pointers + bump a counter," and the copy itself happens once, only for the one page actually written.

- **The problem** — fork copies the address space whole, but most children exec right away and throw the copy out. Everything copied is waste.
- **The foundation (reference count)** — count "how many share" per physical page. `kalloc`=1, `kref_inc`=+1, `kfree`=−1, and reclaim for real **only at 0**. An explicit counter, not GC.
- **fork into COW** — strip `PTE_W` from writable pages and set the RSW bit `PTE_COW` (1<<8) so both sides share read-only. On a write fault (`scause=15`), `uvm_cow_fault` copies just that page and restores write. This check must come **before** demand paging.
- **Our own constraint** — code and heap are COW-shared, but the **stack is copied whole.** fork edits the trap frame directly on the user stack, and sharing would corrupt the parent's stack. The price of a simple trampoline design.
- **Verification** — `cowtest` confirms isolation with child 99 / parent 42, and free pages **stay fixed at 32058**, so there's no leak.

Looking back, this work was a **recombination of parts we already had.** COW didn't invent a new page-copying algorithm — it's the result of combining existing mechanisms: page faults, page tables, and reference counts.
The page fault handler (Part 5), page table manipulation (Part 1), the physical allocator and reference count (Part 1) — tying them together gave us COW.
It reminded me again that *"a new feature is usually a new combination of existing mechanisms."*

> Code: [github.com/dj258255/kernel-hobby](https://github.com/dj258255/kernel-hobby)
> Next post: **Multicore (coming soon)**

## References (Primary Sources First)

- [RISC-V Privileged Specification](https://riscv.org/technical/specifications/) — the primary definition of the PTE's **RSW (reserved-for-software) bits** (where `PTE_COW` rides), the store page fault (`scause=15`), and `sfence.vma`
- [xv6: a simple, Unix-like teaching operating system (MIT 6.S081)](https://pdos.csail.mit.edu/6.828/2023/xv6.html) — the **COW fork lab**; `kalloc`'s reference count and the COW branches in `uvmcopy`/usertrap map 1:1
- Related: [From Boot to Paging (allocator and reference count)](/blog/hobby/kernel-hobby-00-boot-to-paging) · [demand paging and mmap](/blog/hobby/kernel-hobby-04-paging-mmap-writable-fs) · [fork and the ELF loader](/blog/hobby/kernel-hobby-02-fork-elf-filesystem)
- [OSDev Wiki](https://wiki.osdev.org/) — supplementary reference

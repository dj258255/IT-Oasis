---
title: 'demand paging, mmap, 그리고 쓰기 가능 파일시스템'
description: 작은 유닉스 위에 메모리 관리를 깊이 올린다. 예외 핸들러를 "출력만 하던 것"에서 "실제로 페이지를 만드는 것"으로 키워, sbrk 기반 지연 할당(demand paging)과 파일을 메모리처럼 읽는 mmap을 구현한다. 그리고 읽기 전용이던 파일시스템을 블록 할당과 디스크 쓰기로 쓰기 가능하게 만들어, 파일이 재부팅에도 살아남게 한다. 페이지 폴트가 RISC-V에서 어떻게 S-mode로 전달되는지(medeleg)부터 차근히.
date: 2026-06-06T00:00:00.000Z
tags:
  - OS
  - C
  - Kernel
  - RISC-V
  - xv6
  - QEMU
category: study/kernel-hobby
coverImage: "/uploads/hobby/kernel-hobby-c/cover.svg"
draft: false
series: "C로 만드는 토이 커널"
seriesOrder: 5
---


*바닥부터 직접 만드는 RISC-V 토이 커널 연재. 이 글은 5편, demand paging·mmap·쓰기 가능 파일시스템 편입니다.*

## 0. 들어가며

[4편](/blog/hobby/kernel-hobby-03-exec-and-shell)까지 와서 작은 유닉스가 완성됐습니다. 부팅, 페이징, 프로세스, fork/exec/wait, 파일시스템, 유저공간 셸까지 갖췄습니다.
그런데 거기까지의 메모리 관리는 좀 단순했습니다.
**프로세스를 만들 때 필요한 페이지를 미리 다 잡아주고, 페이지 폴트가 나면 그냥 정보를 찍고 멈췄습니다.**

이 글의 한 줄 주제는 **"페이지 폴트를 예외에서 메커니즘으로 키운다"** 입니다.
폴트가 나면 멈추는 대신, 그 순간 커널이 *필요한 일을 한다*. 이 발상 하나가 세 가지를 풀어줍니다.

1. **demand paging (지연 할당)**: 메모리를 미리 안 주고, 처음 건드릴 때 준다
2. **mmap**: 파일을 주소공간에 매핑해, `read()` 없이 메모리처럼 읽는다
3. **쓰기 가능 파일시스템**: (이건 폴트와 별개지만) 읽기 전용 FS를 블록 할당으로 쓰기 가능하게

앞의 둘은 **페이지 폴트 핸들러**가 공통 토대입니다.
이 글은 그 핸들러가 풀어야 하는 진짜 문제부터 짚고, 그 위에 세 응용을 하나씩 올립니다.

> 이 글의 코드는 전부 QEMU `virt`(RISC-V rv64)에서 직접 돌려 검증한 것만 실었습니다. 참고서는 [xv6(MIT 6.S081)](https://pdos.csail.mit.edu/6.828/2023/xv6.html).

## 1. 페이지 폴트 핸들러가 풀어야 하는 진짜 문제

> 유저 프로그램이 매핑 안 된 주소를 건드렸습니다. CPU는 그 명령을 끝낼 수 없습니다. 이 "실패"를 누가, 어느 권한에서, 어떤 정보를 들고 받아서, 어떻게 처리해야 할까요?

이 질문은 셋으로 쪼갤 수 있습니다. **(a) 누구에게 전달되는가**, **(b) 무슨 정보가 따라오는가**, **(c) 처리한 뒤 어떻게 복귀하는가**. 셋 다 답해야 핸들러를 키울 수 있습니다.

### (a) 폴트는 어떻게 우리 손에 들어오나: medeleg

RISC-V는 예외가 기본적으로 가장 높은 권한인 **M-mode**(OpenSBI)로 갑니다.
그런데 우리 커널은 **S-mode**에서 도니까, 폴트가 M-mode까지 올라갔다 내려오면 느리고 번거롭습니다.
그래서 RISC-V엔 **`medeleg`(machine exception delegation)** 레지스터가 있어서, "이런 예외는 S-mode가 직접 처리해라"라고 위임할 수 있습니다.
OpenSBI가 부팅 때 이걸 세팅해 줍니다. 부팅 로그를 보면:

```
Boot HART MEDELEG : 0x0000000000f0b509
```

이 값의 비트를 까보면 비트 12(instruction page fault), 13(load page fault), 15(store/AMO page fault)가 켜져 있습니다(`0xb000` 부분).
즉 **페이지 폴트는 S-mode로 위임**돼서, 1편에서 만든 그 트랩 핸들러가 직접 받습니다.

### (b) 어떤 정보가 따라오나: scause와 stval

폴트가 트랩 핸들러로 들어오면, 두 CSR이 "무슨 일이 났는지"를 알려줍니다.

`scause`(예외 원인) 코드로 종류를 구분합니다.

| scause | 의미 |
|---|---|
| 12 | instruction page fault (실행하려는 코드가 매핑 안 됨) |
| 13 | load page fault (읽으려는 주소가 매핑 안 됨) |
| 15 | store/AMO page fault (쓰려는 주소가 매핑 안 됨) |

그리고 `stval`에 **폴트가 난 가상주소**가 담깁니다.
이 둘만 있으면 "누가 어디를 건드리다, 읽다가/쓰다가 폴트났는지"를 다 알 수 있습니다. 우리 커널은 13/15(로드/스토어)만 직접 처리합니다.

### (c) 처리한 뒤 어떻게 복귀하나: sepc를 건드리지 않는다

기존 트랩 핸들러는 이런 예외를 만나면 그냥 정보를 찍고 멈췄습니다(디버깅용 안전망).
여기에 "우리가 처리할 수 있는 폴트면 처리하고, 아니면 그때 멈춰라"를 끼워 넣습니다.

```c
// trap.c — kerneltrap() 안
} else if ((cause == SCAUSE_LOAD_FAULT || cause == SCAUSE_STORE_FAULT) &&
           proc_pagefault(r_stval(), cause == SCAUSE_STORE_FAULT)) {
    // 처리됨 → sepc를 그대로 두면 그 명령이 자동으로 재시도된다
} else {
    // 우리 영역이 아닌 진짜 폴트 → 정보 출력 후 정지
}
```

핵심은 **`sepc`를 건드리지 않는다**는 것입니다.
시스템콜(`ecall`)을 처리할 땐 `sepc += 4`로 다음 명령으로 넘어갔지만(`ecall`은 이미 실행됐으니까), 페이지 폴트는 정반대입니다. **"그 명령을 다시 실행"** 해야 합니다.
폴트난 load/store 명령은 아직 *성공하지 못한* 명령입니다.
우리가 페이지를 만들어 매핑해두고 `sepc`를 그대로 둔 채 복귀하면, 그 명령이 다시 실행되고, 이번엔 페이지가 있으니 성공합니다.
유저 프로그램은 자기가 잠깐 멈췄다 온 줄도 모릅니다.

> **흔한 오해 정정**: "폴트 = 프로그램이 잘못한 것"이라고만 생각하기 쉬운데, 폴트는 둘로 갈립니다. **고칠 수 있는 폴트**(우리가 페이지를 만들어주면 되는 것, 즉 힙·mmap 영역)와 **진짜 폴트**(매핑할 근거가 없는 것, 널 포인터나 범위 밖). `proc_pagefault`가 1을 반환하면 전자라 재시도하고, 0이면 후자라 멈춥니다. 같은 하드웨어 예외가 "정상 동작의 일부"일 수도, "버그"일 수도 있다는 게 demand paging의 출발점입니다.

> **이 글에선 다루지 않는 분기**: 실제 `proc_pagefault` 코드를 보면 맨 앞에 "이미 매핑돼 있는데 쓰기 폴트가 난" 경우를 가로채는 분기가 하나 더 있습니다. 그건 같은 물리 페이지를 공유하다 쓸 때 복제하는 **copy-on-write**인데, 연재상 [8편 Copy-on-Write](/blog/hobby/kernel-hobby-07-copy-on-write)의 주제라 여기선 넘어갑니다. 이 글의 두 분기(힙·mmap)는 둘 다 "**매핑이 아예 없던** 주소"를 다루는, 더 단순한 경우입니다.

## 2. demand paging이 풀어야 하는 진짜 문제

> 프로그램이 `malloc`으로 1MB를 달라고 합니다. 그런데 실제로는 앞쪽 몇 KB만 씁니다. 커널이 요청 즉시 1MB(256페이지)를 물리 RAM에서 떼어 주면, 안 쓰는 250여 페이지는 어떻게 되나요?

낭비됩니다. 그리고 그 256페이지를 `kalloc`으로 떼고 0으로 미는 비용도 요청 즉시 다 치러야 합니다. `sbrk`가 느려집니다.
**대부분의 프로그램은 요청한 메모리를 다 쓰지 않는다**는 게 핵심 관찰입니다.

해결책은 한 줄로 요약됩니다. **약속만 해두고, 실제 접근할 때 준다.**
`sbrk(n)`은 "힙이 n바이트 커졌다"고 *기록만* 하고 물리 페이지는 한 장도 안 줍니다.
진짜로 그 메모리를 건드리는 순간 폴트가 나고, 그제서야 1편에서 키운 핸들러가 페이지를 할당합니다.
리눅스를 포함한 현대 OS가 다 이렇게 합니다.

### 즉시 할당(eager) vs 지연 할당(lazy)

> 메모리를 "요청 시점"에 줄까, "접근 시점"에 줄까?

**다만 공짜는 아닙니다.** 트레이드오프를 정리하면:

| | 즉시 할당(eager) | 지연 할당(lazy, 우리 선택) |
|---|---|---|
| `sbrk` 비용 | 요청 즉시 N페이지 할당(느림) | 포인터만 +N (빠름) |
| 실제 메모리 사용 | 안 써도 다 점유(낭비) | 건드린 만큼만 점유 |
| 첫 접근 | 바로 성공 | 페이지 폴트 1회(약간의 오버헤드) |
| 위험 | 없음 | **오버커밋**: 약속은 했는데 실제 물리 페이지가 부족하면, 나중에 접근할 때 줄 게 없다 |

마지막 줄이 핵심입니다.
lazy allocation은 "있지도 않은 메모리를 약속"할 수 있습니다(overcommit).
리눅스가 이래서 메모리가 진짜 바닥나면 **OOM Killer**로 프로세스를 죽이는 것입니다.
우리 학습 커널은 물리 메모리가 넉넉해서(125MB) 그 지경까진 안 가지만, "약속과 실제는 다르다"는 게 lazy의 본질적 비용입니다.
그래도 첫 접근의 폴트 1회 오버헤드보다 메모리 절약·빠른 `sbrk`의 이득이 압도적이라 lazy를 택했습니다.

### 구현: sbrk는 약속만, 폴트가 페이지를 만든다

먼저 프로세스마다 힙의 끝(`heap_top`)을 기억하고, `sbrk`는 그걸 늘리기만 합니다.
힙은 유저 주소공간에 따로 잡아둔 구간이고(`HEAPBASE = 0x10000`부터 위로 자람), 페이지는 한 장도 안 만듭니다.

```c
// proc.c — sbrk: 힙을 n바이트 키운다. 물리 페이지는 할당하지 않는다.
uint64 proc_sbrk(int n) {
    struct proc *p = current_proc();
    uint64 old = p->heap_top;
    if (n > 0)
        p->heap_top += (uint64)n;   // 약속만 늘림 — 페이지는 안 만든다
    return old;                      // 새로 얻은 영역의 시작 주소
}
```

폴트가 이 힙 구간(`HEAPBASE ≤ a < heap_top`)에서 나면 그제서야 빈 페이지를 만들어 매핑합니다.
권한은 `R|W|U`(읽기·쓰기, 유저 접근)입니다. 힙은 프로그램이 자유롭게 읽고 써야 하기 때문입니다.

```c
// proc.c — proc_pagefault() 힙 분기
if (a >= HEAPBASE && a < p->heap_top) {              // 힙 영역 안의 폴트라면
    char *mem = kalloc();                            // 빈 물리 페이지 하나
    if (!mem) return 0;
    zero(mem, PGSIZE);                               // 새 힙 페이지는 0으로
    if (uvm_map(p->pagetable, a, (uint64)mem,
                PTE_R | PTE_W | PTE_U) != 0) {       // 읽기/쓰기/유저로 매핑
        kfree(mem);
        return 0;
    }
    return 1;                                        // 처리됨 → 명령 재시도
}
```

`zero()`로 미는 데는 보안 이유도 있습니다. 새 힙 페이지는 직전에 다른 프로세스가 쓰던 RAM일 수 있으니, 그 내용이 비치지 않게 0으로 덮습니다.

시연용으로 디스크에 작은 프로그램 `lazytest`를 올렸습니다.
`sbrk(8192)`로 힙을 2페이지 늘리고, 그 메모리를 건드립니다.

```c
// user/lazytest.c
char *p = (char *)sys_sbrk(8192);   // 힙만 늘림 (물리 페이지 0장)
p[0]    = 42;                        // 첫 페이지 첫 바이트 → 폴트 → 할당
p[4096] = 99;                        // 둘째 페이지 → 또 폴트 → 할당
```

실행하면:

```
$ mem
free pages: 32085
$ lazytest
lazytest: sbrk(8192) -- grow heap by 2 pages
touching page 0 and page 1 (each triggers a page fault)...
[pagefault] demand-allocated a heap page at va=0x0000000000010000
[pagefault] demand-allocated a heap page at va=0x0000000000011000
read back: OK
$ mem
free pages: 32085
```

`sbrk` 직후엔 페이지가 줄지 않습니다.
`p[0]`을 쓰는 순간 첫 폴트가 나서 `0x10000` 페이지가 할당되고, `p[4096]`에서 둘째 폴트로 `0x11000`이 할당됩니다.
읽어보면 쓴 값이 그대로 있습니다(`OK`).
종료 후 `mem`이 그대로인 건, 프로세스가 끝날 때 그 힙 페이지들까지 회수하기 때문입니다(누수 없음).

> **demand paging의 한 줄**: "건드릴 때 가져온다." 이 패턴은 사실 컴퓨터 곳곳에 있습니다. CPU 캐시도, DB 버퍼 풀도 "지금 필요한 것만 빠른 저장소로 올린다"는 같은 아이디어입니다. demand paging은 그걸 "가상 메모리 ↔ 물리 메모리" 사이에서 하는 겁니다.

## 3. mmap이 풀어야 하는 진짜 문제

> 파일 내용을 메모리에서 읽고 싶습니다. 보통은 `read(fd, buf, n)`을 부릅니다. 그런데 커널은 그 데이터를 **디스크 → 커널 버퍼 → 유저 버퍼**로 두 번 복사합니다. 복사 없이, 그냥 포인터로 파일을 읽을 수는 없을까요?

있습니다. 핵심 관찰은 이렇습니다. **2절에서 폴트 핸들러가 "빈 페이지"를 만들 수 있었다면, "파일 내용으로 채운 페이지"도 만들 수 있다**는 것입니다.
그게 `mmap`입니다.

`mmap("motd.txt")`은 파일을 주소공간의 한 영역(`MMAPBASE = 0x100000`)에 *매핑하겠다고 약속*만 합니다(역시 페이지는 0장).
프로그램이 그 주소를 읽는 순간 폴트가 나고, 커널은 **폴트 주소 → 파일 오프셋**을 계산해 그 블록을 디스크에서 읽어 페이지에 담습니다.

```c
// proc.c — mmap: 파일을 주소공간에 매핑. 페이지는 폴트 시 적재.
uint64 proc_mmap(const char *path) {
    struct proc *p = current_proc();
    unsigned start, size;
    if (fs_stat(path, &start, &size) != 0)
        return (uint64)-1;          // 파일 없으면 실패
    p->mmap_base  = MMAPBASE;        // 어느 VA에 매핑할지
    p->mmap_start = start;           // 파일의 시작 블록
    p->mmap_size  = size;            // 파일 크기
    return MMAPBASE;                 // 페이지는 아직 0장 — 약속만
}
```

폴트가 이 mmap 구간에서 나면, 빈 페이지 대신 **파일 블록으로 채워서** 매핑합니다.

```c
// proc.c — proc_pagefault()의 mmap 분기
if (p->mmap_base) {
    uint64 mend = p->mmap_base + roundup(p->mmap_size, PGSIZE);
    if (a >= p->mmap_base && a < mend) {
        char *mem = kalloc();
        if (!mem) return 0;
        fs_read_page(p->mmap_start, p->mmap_size,
                     (a - p->mmap_base), mem);            // 파일 오프셋의 한 페이지를 읽어 채움
        if (uvm_map(p->pagetable, a, (uint64)mem,
                    PTE_R | PTE_U) != 0) {                 // 읽기 전용 매핑(W 없음)
            kfree(mem);
            return 0;
        }
        return 1;
    }
}
```

힙 분기와 비교하면 **폴트 메커니즘은 똑같습니다**. 차이는 딱 둘입니다:

1. `zero(mem)` 대신 `fs_read_page(...)`: 빈 페이지 대신 **파일 블록**으로 채운다
2. 권한이 `R|W|U`가 아닌 **`R|U`**: 읽기 전용(왜 그런지는 아래)

유저 프로그램은 `read()` 시스템콜을 한 번도 안 부르고, 그냥 메모리를 읽습니다.

```c
// user/mmaptest.c
char *p = (char *)sys_mmap("motd.txt");
for (int i = 0; i < 4096 && p[i]; i++)   // 메모리 읽기 = 사실은 파일 읽기
    sys_putchar(p[i]);
```

```
$ mmaptest
mmaptest: mmap("motd.txt")
reading the file as memory (no read() -- page faults load it):
[pagefault] mmap loaded a file page at va=0x0000000000100000
Welcome to kernel-hobby (C / RISC-V).
This text lives on a virtio-blk disk and was read by the kernel's
own filesystem driver -- not baked into the kernel image.
```

첫 글자 `p[0]`을 읽는 순간 폴트가 나고, 커널이 `motd.txt`의 첫 블록을 디스크에서 읽어 그 페이지에 담습니다.
그 뒤로는 메모리 읽기만으로 파일 내용이 줄줄 나옵니다.
이게 mmap이 보여주는 것입니다. **파일과 메모리의 경계가 사라지는** 순간입니다.

### read()로 복사 vs mmap으로 직접 접근

> 같은 파일을 읽는데, 커널이 복사해 줄까(`read`), 주소공간에 직접 매핑할까(`mmap`)?

| | `read(fd, buf, n)` | `mmap` (우리 선택) |
|---|---|---|
| 데이터 경로 | 디스크 → 커널 버퍼 → 유저 버퍼 (복사 2회) | 파일 페이지를 유저 공간에 직접 매핑 (zero-copy) |
| 페이지 적재 | 호출 즉시 n바이트 다 읽음 | 건드린 페이지만 폴트로 적재(지연) |
| 비용 구조 | 복사 비용 | 페이지마다 폴트 1회 |
| 잘 맞는 경우 | 순차로 한 번 쭉 읽기 | 랜덤 접근, 큰 파일, 일부만 읽기 |
| 코드 복잡도 | 단순 | 폴트 핸들러·매핑 관리 필요 |

순차로 한 번 쭉 읽을 거면 `read()`가 단순하고 충분합니다.
우린 "파일=메모리"라는 개념을 보여주는 게 목적이라, 그리고 2절의 폴트 메커니즘을 그대로 재활용할 수 있어서 mmap을 골랐습니다.

### 왜 읽기 전용으로 매핑했나

PTE에 `PTE_W`를 주지 않았습니다(`PTE_R | PTE_U`만).
**쓰기 가능하게 하면 유저가 매핑된 메모리를 수정했을 때 그걸 디스크로 다시 써주는(write-back) 로직이 필요합니다.** 언제 쓸지(매 수정마다? 언매핑 시?), 어느 페이지가 더럽혀졌는지(dirty page) 추적, 그 페이지를 파일의 어느 블록에 되돌릴지… 복잡도가 확 올라갑니다.
읽기 전용은 그 전부를 피하면서 mmap의 핵심(폴트로 파일 적재)을 그대로 보여줘서, 학습 목적엔 이게 딱 맞는 선택이었습니다.

> **흔한 오해 정정**: "읽기 전용 mmap이면 유저가 거기 쓰면 어떻게 되냐"고 묻는다면, `PTE_W`가 없으니 그 쓰기는 **스토어 페이지 폴트(scause 15)** 가 나고, `proc_pagefault`의 두 분기 어디에도 안 걸려 0을 반환 → "진짜 폴트"로 멈춥니다. 즉 읽기 전용은 **하드웨어가 강제**하는 것입니다. 단순히 "안 쓰기를 바라는" 수준이 아닙니다. PTE 권한 비트가 곧 보호라는, 1편에서 깔아둔 그 원리입니다.

## 4. 쓰기 가능 파일시스템이 풀어야 하는 진짜 문제

여기서부터는 메모리를 떠나 **저장장치**를 다룹니다.

> [4편](/blog/hobby/kernel-hobby-03-exec-and-shell)의 파일시스템은 읽기 전용이었습니다. 디스크에 미리 구운 파일을 `ls`/`cat`만 했습니다. 셸에서 새 파일을 만들려면, 빈 디스크 공간을 찾아 데이터를 쓰고, "이 파일이 여기 있다"는 사실까지 디스크에 박아야 합니다. 무엇을, 어떤 순서로 써야 재부팅 후에도 파일이 살아남을까요?

우리 온디스크 포맷은 단순합니다(자세한 구조는 [3편](/blog/hobby/kernel-hobby-02-fork-elf-filesystem)에서).

```
블록 0      슈퍼블록 (magic, 파일 수, next_free)
블록 1      디렉터리 (이름, 크기, 시작 블록)
블록 2..    파일 데이터
```

파일 생성은 세 단계의 묶음입니다. **빈 블록 찾기 → 데이터 쓰기 → 메타데이터 갱신.**
슈퍼블록에 "다음 빈 블록"(`next_free`)을 두고, 거기서부터 연속 블록을 할당합니다.

```c
// fs.c — fs_create() (개념 골자)
uint32 start = next_free;
// 1) 데이터 블록을 디스크에 쓴다
for (int b = 0; b < nblocks; b++)
    virtio_disk_rw(start + b, data_block, /*write=*/1);
// 2) 디렉터리 항목 추가 (메모리)
dir[slot] = (name, size, start);
nfiles++; next_free += nblocks;
// 3) 디렉터리(블록1)와 슈퍼블록(블록0)을 디스크에 다시 쓴다 → 영속
virtio_disk_rw(DIRBLOCK, dir_block, 1);
virtio_disk_rw(0, super_block, 1);
```

여기서 **디스크 쓰기**가 처음 나옵니다.
virtio-blk 드라이버에 write 경로가 있긴 했지만(3편), 실제로 써본 건 이번이 처음입니다.
디스크립터의 방향만 바꾸면 됩니다. 읽기는 "디바이스가 버퍼에 쓴다", 쓰기는 "디바이스가 버퍼를 읽어 디스크에 쓴다"입니다.

핵심은 **3단계가 끝나면 디스크에 영구히 박힌다**는 것입니다.
디렉터리(블록1)와 슈퍼블록(블록0)까지 디스크에 다시 써야 파일의 존재가 영속됩니다. 메모리 안의 `dir[]`만 바꾸면 재부팅 때 사라지기 때문입니다.

셸에 `write` 내장 명령을 붙였습니다.

```
$ write greeting.txt hello from a writable fs
$ ls
  motd.txt  (162 bytes)
  ...
  greeting.txt  (24 bytes)        ← 새로 생김
$ cat greeting.txt
hello from a writable fs
```

진짜 영속하는지 확인하려면 **같은 디스크 이미지로 재부팅**해 보면 됩니다.

```
(재부팅 후)
[ok] filesystem mounted: 6 files   ← 5 + greeting.txt
$ cat greeting.txt
hello from a writable fs           ← 디스크에 박혀 살아남았다
```

메모리에만 있지 않고 디스크 블록에 박혔기 때문에, 커널을 껐다 켜도 `greeting.txt`가 그대로 마운트됩니다.
이게 "쓰기 가능"의 진짜 의미입니다. 휘발성 RAM 대신 영속 저장장치에 사실을 남기는 것입니다.

### 막혔던 버그: 딱 맞는 디스크

처음엔 `write`가 되는 것 같은데 `cat`이 이상한 바이너리를 뱉었습니다.
원인은 허무했습니다. **디스크 이미지가 데이터에 딱 맞는 54블록**이었던 것입니다.
새 파일을 블록 54에 쓰려는데 그게 이미지 범위(0~53) 밖이라, virtio가 그 쓰기를 **조용히 드롭**했습니다.
그리고 `cat`이 범위 밖 블록을 읽으니 엉뚱한 데이터(직전에 읽었던 슈퍼블록)가 나온 것입니다.

해결은 mkfs가 디스크 이미지를 **여유 있게(256블록) 패딩**하게 한 것입니다.
파일시스템엔 "쓸 빈 공간"이 있어야 한다는, 당연하지만 직접 막혀봐야 와닿는 교훈이었습니다.

### 단순화의 대가: 세 가지 트레이드오프

이 파일시스템은 "동작하는 가장 단순한 것"을 목표로 했습니다.
그 대가로 포기한 것들을 정직하게 적어 둡니다.
각각이 진짜 파일시스템(예: ext4, xv6의 fs)이 왜 더 복잡한지를 거꾸로 알려줍니다.

| 우리 선택 | 단순함의 이득 | 포기한 것 | 진짜 FS는 |
|---|---|---|---|
| write-once (생성 시 내용 확정) | 빈 블록 회수·단편화 관리 불필요 | 파일을 키우거나 고치거나 지울 수 없음 | 빈 블록을 비트맵으로 관리·회수 |
| 연속 블록 할당 | 메타데이터가 "시작 블록 + 크기" 둘뿐 | 큰 파일이 "연속된 빈 공간"에 묶임(단편화) | inode + 간접 블록으로 흩어진 블록 구성 |
| 단일 쓰기(원자성 없음) | 코드가 짧음 | 쓰기 도중 크래시에 취약 | 저널/로그로 쓰기를 원자화 |

- **write-once (생성 시 내용 확정)**: 파일을 만들 때 내용을 다 받아 한 번에 쓰고, 그 뒤엔 수정·추가를 하지 않습니다. 그래서 "빈 블록 회수"나 "단편화" 관리가 필요 없어 코드가 짧습니다. 대신 파일을 **키우거나 고치거나 지울 수 없습니다.** 진짜 FS는 파일이 자라고 줄어드니, 빈 블록을 비트맵으로 관리하고 회수해야 합니다.
- **연속 블록 할당 (vs inode/간접 블록)**: 파일을 `start`부터 연속된 블록에 담습니다. 순차 읽기가 빠르고 메타데이터가 "시작 블록 + 크기" 둘뿐이라 단순합니다. 대신 **파일 크기가 "연속된 빈 공간"에 묶이고**, 파일들이 생기고 지워지면 중간에 구멍(단편화)이 나서 큰 파일을 못 넣게 됩니다. 그래서 유닉스 FS는 **inode + 간접 블록**(데이터 블록의 주소들을 따로 모은 블록)을 써서, 흩어진 블록들로 큰 파일을 구성합니다.
- **단일 쓰기(크래시에 취약)**: 파일 생성은 ① 데이터 ② 디렉터리 ③ 슈퍼블록을 **순서대로** 디스크에 씁니다. 만약 ②와 ③ 사이에 전원이 나가면? 디렉터리엔 파일이 있는데 슈퍼블록의 `next_free`는 안 갱신돼서 **파일시스템이 어긋납니다.** 이 묶음을 "전부 적용되거나 전혀 안 된 것처럼" 원자화하는 게 **저널링**인데, 그건 연재상 [9편 저널링 파일시스템](/blog/hobby/kernel-hobby-08-journaling-filesystem)의 주제입니다. 이 글의 FS는 그 앞 단계인 **단일 쓰기(write-once)** 수준이고, 우린 단일 사용자·학습용이라 이 위험을 감수하고 단순함을 택했습니다.

세 가지 다 "단순함 ↔ 견고함/유연함"의 트레이드오프입니다.
학습 커널에선 단순함이 이기지만, 어떤 복잡함을 *왜* 감수해야 하는지를 알고 포기하는 것과, 몰라서 안 하는 건 전혀 다릅니다.

> **핵심 교훈**: "쓰기 가능"은 한 번에 완성되지 않습니다. 이 글은 **빈 블록 할당 + 데이터 쓰기 + 메타데이터 갱신 → 재부팅 영속**이라는 가장 기본 골격(write-once)까지입니다. 그 쓰기를 **트랜잭션으로 원자화**해서 크래시에도 깨지지 않게 하는 건 [9편 저널링 파일시스템](/blog/hobby/kernel-hobby-08-journaling-filesystem)에서 이어집니다. 트랜잭션의 ACID와 정확히 같은 발상입니다.

## 정리

이 글은 페이지 폴트 핸들러를 **"출력하고 멈추던 것"에서 "필요한 페이지를 만드는 메커니즘"으로** 키우고, 그 위에 세 응용을 올렸습니다.

- **페이지 폴트 핸들러 (1절)**: `medeleg`로 폴트가 S-mode에 위임되고, `scause`(13/15)·`stval`로 "어디서 읽다/쓰다 폴트났는지"를 안다. **`sepc`를 안 올려서** 폴트난 그 명령을 재시도하는 게 핵심. 1을 반환하면 고칠 수 있는 폴트, 0이면 진짜 폴트.
- **demand paging (2절)**: `sbrk`는 `heap_top`만 키우고 페이지는 0장. 힙 영역 폴트에서 `kalloc + zero + uvm_map(R|W|U)`. eager의 낭비를 피하는 대신 오버커밋이라는 본질적 비용을 진다.
- **mmap (3절)**: 폴트 메커니즘은 힙과 똑같고, 빈 페이지 대신 `fs_read_page`로 **파일 블록을 채우고** `uvm_map(R|U)`로 **읽기 전용** 매핑. `read()`의 복사를 없애고 "파일=메모리"를 보여준다.
- **쓰기 가능 FS (4절)**: 빈 블록 할당 → 데이터 쓰기 → 디렉터리·슈퍼블록 갱신 → 재부팅 영속. write-once 수준의 가장 단순한 골격.

공통 줄기는 **"필요할 때, 필요한 만큼만"** 입니다. 힙도 파일도 미리 다 잡지 않고 폴트 순간에 만듭니다.

**demand paging도 mmap도 결국 같은 페이지 폴트 핸들러의 두 분기**입니다. 둘 다 "빈 페이지를 하나 만들어 매핑한다"는 똑같은 일을 하고, **차이는 그 페이지를 무엇으로 채우느냐 하나뿐**입니다(힙은 `zero`, mmap은 `fs_read_page`). 전혀 다른 기술처럼 보이지만, 커널 입장에선 한 핸들러의 분기 둘입니다.

![페이지 폴트가 proc_pagefault 한 핸들러의 세 분기로 갈린다: 힙=kalloc+zero, mmap=kalloc+fs_read_page(읽기전용), 그 외=0 반환 kill. 1 반환 시 같은 명령 재실행](/uploads/hobby/kernel-hobby-c/pagefault-branch.svg)

그리고 매 단계가 *일부러* 단순한 길을 골랐습니다. 정석을 알고도 포기한 선택이라, 쓰기 가능 mmap, COW, 저널링은 다음 글들의 몫으로 남겨뒀습니다.

> 가상메모리와 파일시스템은 여기서 끝이 아닙니다. 같은 물리 페이지를 공유하다 쓸 때 복제하는 **copy-on-write**는 [8편](/blog/hobby/kernel-hobby-07-copy-on-write), 파일 쓰기를 트랜잭션으로 원자화하는 **저널링**은 [9편](/blog/hobby/kernel-hobby-08-journaling-filesystem)에서 이어집니다.

> 코드: [github.com/dj258255/kernel-hobby](https://github.com/dj258255/kernel-hobby)

## 참고 (1차 자료 우선)

- [RISC-V Privileged Specification](https://riscv.org/technical/specifications/): 페이지 폴트와 `scause`/`stval`/`sepc`, 예외 위임(`medeleg`)의 1차 정의
- [xv6: a simple, Unix-like teaching operating system (MIT 6.S081)](https://pdos.csail.mit.edu/6.828/2023/xv6.html): 이 커널의 참고서. lazy allocation·mmap·writable fs가 각각 독립 랩 주제
- [MIT 6.1810(xv6) 랩 일정](https://pdos.csail.mit.edu/6.828/2023/schedule.html): lazy alloc / mmap / fs 랩의 원본 구성
- [OpenSBI Documentation](https://github.com/riscv-software-src/opensbi): 부팅 시 `medeleg` 설정, M→S 예외 위임
- [QEMU `virt` machine](https://www.qemu.org/docs/master/system/riscv/virt.html): virtio-blk 디스크, MMIO 주소 배치
- 관련 글: [캐시와 버퍼](/blog/theory/cache-and-buffer) · [DB 스토리지 내부 ①](/blog/theory/db-storage-01-heap-page-index) · [JVM 메모리 ③: Off-heap](/blog/theory/es-memory-03-off-heap)

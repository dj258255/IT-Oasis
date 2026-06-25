---
title: 'demand paging, mmap, 그리고 쓰기 가능 파일시스템'
titleEn: 'Demand Paging, mmap, and a Writable Filesystem'
description: 작은 유닉스 위에 메모리 관리를 깊이 올린다. 예외 핸들러를 "출력만 하던 것"에서 "실제로 페이지를 만드는 것"으로 키워, sbrk 기반 지연 할당(demand paging)과 파일을 메모리처럼 읽는 mmap을 구현한다. 그리고 읽기 전용이던 파일시스템을 블록 할당과 디스크 쓰기로 쓰기 가능하게 만들어, 파일이 재부팅에도 살아남게 한다. 페이지 폴트가 RISC-V에서 어떻게 S-mode로 전달되는지(medeleg)부터 차근히.
descriptionEn: "Deepening memory management on top of a small Unix. The exception handler grows from merely printing to actually creating pages — implementing sbrk-based demand paging (lazy allocation) and mmap that reads a file as if it were memory. Then the read-only filesystem becomes writable via block allocation and disk writes, so files survive a reboot. Starting from how page faults are delegated to S-mode on RISC-V (medeleg)."
date: 2026-06-18T00:00:00.000Z
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
seriesOrder: 5
---


## 들어가며

[4편](/blog/hobby/hobby-kernel-03-exec-and-shell)까지 와서 작은 유닉스가 완성됐어요 — 부팅, 페이징, 프로세스, fork/exec/wait, 파일시스템, 유저공간 셸.
그런데 거기까지의 메모리 관리는 좀 단순했어요.
**프로세스를 만들 때 필요한 페이지를 미리 다 잡아주고, 페이지 폴트가 나면 그냥 출력하고 멈췄거든요.**

이번 글의 한 줄 주제는 이거예요 — **"페이지 폴트를 예외에서 메커니즘으로 키운다."** 폴트가 나면 멈추는 대신, 그 순간 커널이 *필요한 일을 한다*.
이 발상 하나로 세 가지가 풀려요.

1. **Lazy allocation (demand paging)** — 메모리를 미리 안 주고, 처음 건드릴 때 준다
2. **mmap** — 파일을 주소공간에 매핑해, `read()` 없이 메모리처럼 읽는다
3. **쓰기 가능 파일시스템** — (이건 폴트와 별개지만) 읽기 전용 FS를 블록 할당으로 쓰기 가능하게

앞의 둘은 **페이지 폴트 핸들러**가 공통 토대예요.
"필요할 때 가져온다"는 발상은 사실 컴퓨터 곳곳에 있어요 — 캐시도, DB 버퍼 풀도 같은 아이디어죠([캐시와 버퍼: 속도 차이를 극복하는 두 가지 방법](/blog/theory/cache-and-buffer)에서 메모리 계층 관점으로 정리한 적이 있어요).

> 이 글의 코드는 전부 QEMU `virt`(RISC-V rv64)에서 직접 돌려 검증한 것만 실었어요. 참고서는 [xv6(MIT 6.S081)](https://pdos.csail.mit.edu/6.828/2023/xv6.html).

## 1. 페이지 폴트는 어떻게 우리 손에 들어오나

먼저 짚어야 할 게 있어요.
유저 프로그램이 매핑 안 된 메모리를 건드리면 **페이지 폴트**라는 예외가 나는데, 이게 누구한테 가느냐예요.

RISC-V는 예외가 기본적으로 가장 높은 권한인 **M-mode**(OpenSBI)로 가요.
그런데 우리 커널은 **S-mode**에서 도니까, 폴트가 M-mode까지 올라갔다 내려오면 느리고 번거로워요.
그래서 RISC-V엔 **`medeleg`(machine exception delegation)** 레지스터가 있어서, "이런 예외는 S-mode가 직접 처리해라"라고 위임할 수 있어요.
OpenSBI가 부팅 때 이걸 세팅해 줘요.
부팅 로그를 보면:

```
Boot HART MEDELEG : 0x0000000000f0b509
```

이 값의 비트를 까보면 — 비트 12(instruction page fault), 13(load page fault), 15(store/AMO page fault)가 켜져 있어요(`0xb000` 부분).
즉 **페이지 폴트는 S-mode로 위임**돼서, 우리 트랩 핸들러가 직접 받아요.
1편에서 만든 그 트랩 핸들러요.

`scause`(예외 원인) 코드로 종류를 구분해요.

| scause | 의미 |
|---|---|
| 12 | instruction page fault (실행하려는 코드가 매핑 안 됨) |
| 13 | load page fault (읽으려는 주소가 매핑 안 됨) |
| 15 | store/AMO page fault (쓰려는 주소가 매핑 안 됨) |

그리고 `stval`에 **폴트가 난 가상주소**가 담겨요.
이 둘만 있으면 "누가 어디를 건드리다 폴트났는지" 알 수 있어요.

기존 트랩 핸들러는 이런 예외를 만나면 그냥 정보를 찍고 멈췄어요(디버깅용 안전망).
여기에 "우리가 처리할 수 있는 폴트면 처리하고, 아니면 그때 멈춰라"를 끼워 넣어요.

```c
// trap.c — kerneltrap() 안
} else if ((cause == SCAUSE_LOAD_FAULT || cause == SCAUSE_STORE_FAULT) &&
           proc_pagefault(r_stval(), cause == SCAUSE_STORE_FAULT)) {
    // 처리됨 → sepc를 그대로 두면 그 명령이 자동으로 재시도된다
} else {
    // 우리 영역이 아닌 진짜 폴트 → 정보 출력 후 정지
}
```

핵심은 **`sepc`를 건드리지 않는다**는 거예요.
시스템콜(`ecall`)을 처리할 땐 `sepc += 4`로 다음 명령으로 넘어갔지만, 페이지 폴트는 "그 명령을 다시 실행"해야 해요.
우리가 페이지를 만들어 매핑해두고 그대로 복귀하면, 폴트났던 그 load/store 명령이 다시 실행되고, 이번엔 페이지가 있으니 성공해요.
유저 프로그램은 자기가 잠깐 멈췄다 온 줄도 몰라요.

## 2. Lazy allocation (demand paging)

이제 첫 응용.
**프로그램이 `sbrk(n)`으로 힙을 키워도, 물리 페이지는 한 장도 안 준다.** 진짜로 그 메모리를 건드릴 때 폴트가 나고, 그제서야 페이지를 할당해요.

왜 이렇게 하냐 — **대부분의 프로그램은 요청한 메모리를 다 쓰지 않거든요.** 1MB를 달라고 해놓고 앞쪽 몇 KB만 쓰는 경우가 흔해요.
미리 1MB를 다 잡아주면 낭비고, 할당도 느려요.
"약속만 해두고, 실제 접근할 때 준다"가 훨씬 효율적이에요.
리눅스를 포함한 현대 OS가 다 이렇게 해요.

**다만 공짜는 아니에요.** 트레이드오프를 정리하면:

| | 즉시 할당(eager) | 지연 할당(lazy, 우리 선택) |
|---|---|---|
| `sbrk` 비용 | 요청 즉시 N페이지 할당(느림) | 포인터만 +N (빠름) |
| 실제 메모리 사용 | 안 써도 다 점유(낭비) | 건드린 만큼만 점유 |
| 첫 접근 | 바로 성공 | 페이지 폴트 1회(약간의 오버헤드) |
| 위험 | 없음 | **오버커밋** — 약속은 했는데 실제 물리 페이지가 부족하면, 나중에 접근할 때 줄 게 없다 |

마지막 줄이 핵심이에요.
lazy allocation은 "있지도 않은 메모리를 약속"할 수 있어요(overcommit).
리눅스가 이래서 메모리가 진짜 바닥나면 **OOM Killer**로 프로세스를 죽이는 거예요.
우리 학습 커널은 물리 메모리가 넉넉해서(125MB) 그 지경까진 안 가지만, "약속과 실제는 다르다"는 게 lazy의 본질적 비용이에요.
그래도 신입 프로그램 한둘에겐 첫 접근의 폴트 1회 오버헤드보다 메모리 절약·빠른 `sbrk`의 이득이 압도적이라 lazy를 택했어요.

먼저 프로세스마다 힙의 끝(`heap_top`)을 기억하고, `sbrk`는 그걸 늘리기만 해요.

```c
// proc.c
uint64 proc_sbrk(int n) {
    struct proc *p = current_proc();
    uint64 old = p->heap_top;
    if (n > 0)
        p->heap_top += (uint64)n;   // 약속만 늘림 — 페이지는 안 만든다
    return old;                      // 새로 얻은 영역의 시작 주소
}
```

힙 영역은 유저 주소공간에 따로 잡아둔 구간이에요(우린 `0x10000`부터 위로 자라게 했어요).
폴트가 이 구간에서 나면 — 그제서야 빈 페이지를 만들어 매핑해요.

```c
// proc.c — proc_pagefault()
uint64 a = va & ~(PGSIZE - 1);                  // 폴트 주소를 페이지 경계로
if (a >= HEAPBASE && a < p->heap_top) {         // 힙 영역 안의 폴트라면
    char *mem = kalloc();                       // 빈 물리 페이지 하나
    zero(mem, PGSIZE);
    uvm_map(p->pagetable, a, (uint64)mem, PTE_R | PTE_W | PTE_U);  // 매핑
    return 1;                                   // 처리됨 → 명령 재시도
}
```

시연용으로 디스크에 작은 프로그램 `lazytest`를 올렸어요.
`sbrk(8192)`로 힙을 2페이지 늘리고, 그 메모리를 건드려요.

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

`sbrk` 직후엔 페이지가 안 줄어요.
`p[0]`을 쓰는 순간 첫 폴트가 나서 `0x10000` 페이지가 할당되고, `p[4096]`에서 둘째 폴트로 `0x11000`이 할당돼요.
읽어보면 쓴 값이 그대로 있고요(`OK`).
종료 후 `mem`이 그대로인 건, 프로세스가 끝날 때 그 힙 페이지들까지 회수하기 때문이에요(누수 없음).

> "건드릴 때 가져온다"는 이 패턴은 [캐시와 버퍼](/blog/theory/cache-and-buffer)에서 다룬 메모리 계층의 작동 방식과 똑같아요 — CPU 캐시도, DB 버퍼 풀도 "지금 필요한 것만 빠른 저장소로 올린다"죠. demand paging은 그걸 "가상 메모리 ↔ 물리 메모리" 사이에서 하는 거예요.

## 3. mmap — 파일을 메모리처럼 읽기

폴트 핸들러가 빈 페이지를 만들 수 있으면, **파일 내용으로 채운 페이지**도 만들 수 있어요.
그게 `mmap`이에요.

`mmap("motd.txt")`은 파일을 주소공간의 한 영역에 *매핑하겠다고 약속*만 해요(역시 페이지는 0장).
프로그램이 그 주소를 읽는 순간 폴트가 나고, 커널은 **폴트 주소 → 파일 오프셋**을 계산해 그 블록을 디스크에서 읽어 페이지에 담아요.

```c
// proc.c — proc_pagefault()의 mmap 분기
if (a >= p->mmap_base && a < p->mmap_base + roundup(p->mmap_size)) {
    char *mem = kalloc();
    fs_read_page(p->mmap_start, p->mmap_size,
                 (a - p->mmap_base), mem);          // 파일 오프셋의 한 페이지를 읽어 채움
    uvm_map(p->pagetable, a, (uint64)mem, PTE_R | PTE_U);  // 읽기 전용 매핑
    return 1;
}
```

lazy allocation과 **폴트 메커니즘은 똑같아요**.
차이는 단 하나 — 빈 페이지 대신 **파일 블록으로 채운다**는 것.
유저 프로그램은 `read()` 시스템콜을 한 번도 안 부르고, 그냥 메모리를 읽어요.

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
Welcome to hobby-kernel (C / RISC-V).
This text lives on a virtio-blk disk and was read by the kernel's
own filesystem driver -- not baked into the kernel image.
```

첫 글자 `p[0]`을 읽는 순간 폴트가 나고, 커널이 `motd.txt`의 첫 블록을 디스크에서 읽어 그 페이지에 담아요.
그 뒤로는 메모리 읽기만으로 파일 내용이 줄줄 나와요.
이게 mmap의 매력이에요 — **파일과 메모리의 경계가 사라지는** 거죠.

**여기서 두 가지 선택을 했어요.**

- **`mmap` vs `read()`** — 같은 파일을 읽는데 왜 mmap이냐. `read(fd, buf, n)`은 커널이 디스크 → 커널 버퍼 → 유저 버퍼로 **복사**해요(복사 2번). mmap은 파일 페이지를 유저 주소공간에 **직접 매핑**해서 복사가 없어요(zero-copy). 대신 페이지마다 폴트 비용이 있고, 랜덤 접근·큰 파일에 유리해요. 순차로 한 번 쭉 읽을 거면 `read()`가 단순하고 충분하고요. 우린 "파일=메모리"라는 개념을 보여주는 게 목적이라 mmap을 골랐어요.
- **읽기 전용으로 매핑** — PTE에 `PTE_W`를 안 줬어요(`PTE_R | PTE_U`만). 쓰기 가능하게 하면 유저가 매핑된 메모리를 수정했을 때 그걸 **디스크로 다시 써주는(write-back)** 로직이 필요해요 — 언제 쓸지(매 수정마다? 언매핑 시?), 더티 페이지 추적 등 복잡도가 확 올라가요. 읽기 전용은 그 전부를 피하면서 mmap의 핵심(폴트로 파일 적재)을 그대로 보여줘서, 학습 목적엔 이게 딱 맞는 선택이었어요. 쓰기 가능 mmap은 정제 단계로 남겨뒀고요.

> 이건 JVM의 [Off-heap과 Direct Memory](/blog/theory/es-memory-03-off-heap)에서 다룬 `MappedByteBuffer`(메모리 맵 파일)와 정확히 같은 메커니즘이에요. 그쪽은 JVM 위에서 OS의 mmap을 쓰는 거고, 여기선 그 OS 쪽을 직접 만든 셈이에요.

## 4. 쓰기 가능 파일시스템

여기서부턴 메모리가 아니라 **저장장치**예요.
[4편](/blog/hobby/hobby-kernel-03-exec-and-shell)의 파일시스템은 읽기 전용이었어요 — 디스크에 미리 구운 파일을 `ls`/`cat`만 했죠.
이번엔 **셸에서 파일을 만들고 쓰고, 재부팅해도 남게** 만들어요.

우리 온디스크 포맷은 단순해요(자세한 구조는 [3편](/blog/hobby/hobby-kernel-02-fork-elf-filesystem)에서).
"페이지·블록 단위로 데이터를 담는다"는 발상 자체는 DB 스토리지와 똑같아요([DB 스토리지 내부 ①: Heap, Page, Index](/blog/theory/db-storage-01-heap-page-index)에서 정리한 적 있어요).

```
블록 0      슈퍼블록 (magic, 파일 수, next_free)
블록 1      디렉터리 (이름, 크기, 시작 블록)
블록 2..    파일 데이터
```

파일 생성은 세 단계의 묶음이에요 — **빈 블록 찾기 → 데이터 쓰기 → 메타데이터 갱신.** 슈퍼블록에 "다음 빈 블록"(`next_free`)을 두고, 거기서부터 연속 블록을 할당해요.

```c
// fs.c — fs_create()
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

여기서 **디스크 쓰기**가 처음 나와요.
virtio-blk 드라이버에 write 경로가 있긴 했지만(3편), 실제로 써본 건 이번이 처음이에요.
디스크립터의 방향만 바꾸면 돼요 — 읽기는 "디바이스가 버퍼에 쓴다", 쓰기는 "디바이스가 버퍼를 읽어 디스크에 쓴다".

셸에 `write` 내장 명령을 붙였어요.

```
$ write greeting.txt hello from a writable fs
$ ls
  motd.txt  (162 bytes)
  ...
  greeting.txt  (24 bytes)        ← 새로 생김
$ cat greeting.txt
hello from a writable fs
```

진짜 영속하는지 확인하려면 — **같은 디스크 이미지로 재부팅**해 보면 돼요.

```
(재부팅 후)
[ok] filesystem mounted: 6 files   ← 5 + greeting.txt
$ cat greeting.txt
hello from a writable fs           ← 디스크에 박혀 살아남았다
```

### 막혔던 버그: 딱 맞는 디스크

처음엔 `write`가 되는 것 같은데 `cat`이 이상한 바이너리를 뱉었어요.
원인은 허무했어요 — **디스크 이미지가 데이터에 딱 맞는 54블록**이었던 거예요.
새 파일을 블록 54에 쓰려는데 그게 이미지 범위(0~53) 밖이라, virtio가 그 쓰기를 **조용히 드롭**했어요.
그리고 `cat`이 범위 밖 블록을 읽으니 엉뚱한 데이터(직전에 읽었던 슈퍼블록)가 나온 거고요.

해결은 mkfs가 디스크 이미지를 **여유 있게(256블록) 패딩**하게 한 거예요.
파일시스템엔 "쓸 빈 공간"이 있어야 한다는, 당연하지만 직접 막혀봐야 와닿는 교훈이었어요.

### 단순화의 대가 — 세 가지 트레이드오프

이 파일시스템은 "동작하는 가장 단순한 것"을 목표로 했어요.
그 대가로 포기한 것들을 정직하게 적어둘게요.
각각이 진짜 파일시스템(예: ext4, xv6의 fs)이 왜 더 복잡한지를 거꾸로 알려줘요.

- **write-once (생성 시 내용 확정)** — 파일을 만들 때 내용을 다 받아 한 번에 쓰고, 그 뒤엔 수정·추가를 안 해요. 그래서 "빈 블록 회수"나 "단편화" 관리가 필요 없어 코드가 짧아요. 대신 파일을 **키우거나 고치거나 지울 수 없어요.** 진짜 FS는 파일이 자라고 줄어드니, 빈 블록을 비트맵으로 관리하고 회수해야 해요.
- **연속 블록 할당 (vs inode/간접 블록)** — 파일을 `start`부터 연속된 블록에 담아요. 순차 읽기가 빠르고 메타데이터가 "시작 블록 + 크기" 둘뿐이라 단순해요. 대신 **파일 크기가 "연속된 빈 공간"에 묶이고**, 파일들이 생기고 지워지면 중간에 구멍(단편화)이 나서 큰 파일을 못 넣게 돼요. 그래서 유닉스 FS는 **inode + 간접 블록**(데이터 블록의 주소들을 따로 모은 블록)을 써서, 흩어진 블록들로 큰 파일을 구성해요. 우린 "한 페이지 프로그램"처럼 "연속 작은 파일"로 단순화한 거예요.
- **로깅(journaling) 없음 — 크래시에 취약** — 파일 생성은 ① 데이터 ② 디렉터리 ③ 슈퍼블록을 **순서대로** 디스크에 써요. 만약 ②와 ③ 사이에 전원이 나가면? 디렉터리엔 파일이 있는데 슈퍼블록의 `next_free`는 안 갱신돼서 — **파일시스템이 깨져요.** 진짜 FS는 이걸 막으려고 **저널(로그)** 에 "이 묶음을 통째로 적용한다"를 먼저 적고, 다 적용되면 지워요(원자성). 크래시가 나도 재부팅 때 로그를 보고 복구하죠. 이건 트랜잭션의 ACID와 정확히 같은 발상이에요([트랜잭션 ACID ④: 지속성(Durability)](/blog/theory/transaction-acid-04-durability)에서 WAL/로그 관점으로 다룬 적 있어요). 우린 단일 사용자·학습용이라 이 위험을 감수하고 단순함을 택했어요.

세 가지 다 "단순함 ↔ 견고함/유연함"의 트레이드오프예요.
학습 커널에선 단순함이 이기지만, 어떤 복잡함을 *왜* 감수해야 하는지를 알고 포기하는 것과, 몰라서 안 하는 건 전혀 달라요.

## 5. 되짚기 — 이 연재의 핵심 설계 결정들

이왕 트레이드오프 이야기를 꺼낸 김에, 연재 내내 했던 굵직한 선택들을 한자리에 모아볼게요.
토이 커널이라도 **매 단계가 "다른 길도 있는데 왜 이 길인가"의 연속**이었어요.

- **언어: Rust vs C → C** ([1편](/blog/hobby/hobby-kernel-00-boot-to-paging)) — Rust는 메모리 안전성이 강점이지만, 커널 바닥에선 결국 `unsafe`로 하드웨어를 직접 만져야 해서 그 이점이 줄어요. 무엇보다 참고서 xv6가 C/RISC-V라 **코드가 1:1로 매핑**돼 마찰이 가장 적었어요. "안전성"보다 "참고서와의 정합성 + 커널의 정석 언어"를 택한 거예요.

- **트랩 처리: 트램폴린 vs SUM 비트 → SUM** ([2편](/blog/hobby/hobby-kernel-01-usermode-to-processes)) — xv6는 유저↔커널 전환을 **트램폴린**(모든 주소공간에 같은 VA로 매핑된 작은 코드)으로 우아하게 풀어요. 우린 유저 프로세스의 트랩을 **유저 스택 위에서** 처리하고(`SUM` 비트로 커널이 유저 페이지 접근), 트램폴린을 생략했어요. **이득**: 트램폴린/프로세스별 커널 스택 설계를 통째로 안 만들어도 됨. **대가**: `SUM`이 항상 1이어야 하고(2편에서 이것 때문에 무한 폴트로 한참 헤맴), 유저 스택에서 커널 코드가 도는 건 정석이 아니에요. 단순함을 위해 견고함을 일부 내준 거죠.

- **프로세스 주소공간: 커널을 모든 페이지 테이블에 복제** ([2편](/blog/hobby/hobby-kernel-01-usermode-to-processes)) — 트램폴린을 안 쓰니, 트랩 핸들러(커널 코드)가 모든 프로세스 페이지 테이블에 같은 주소로 있어야 했어요. 그래서 **커널 전체를 프로세스마다 식별 매핑**했어요. **대가**: 프로세스 하나당 페이지 테이블 구조에 ~66페이지(128MB를 4KB로 매핑)를 써요. 트램폴린(1페이지)에 비하면 사치스럽지만, 코드가 훨씬 단순해요. (이 비용 때문에 fork가 비싸지고, 그래서 [정제 단계에서 자원 회수](/blog/hobby/hobby-kernel-03-exec-and-shell)가 중요해졌어요.)

- **fork: 즉시 복사 vs Copy-on-Write → 즉시 복사** ([3편](/blog/hobby/hobby-kernel-02-fork-elf-filesystem)) — 진짜 OS는 fork에서 페이지를 공유하고 쓸 때만 복사(COW)해요. 우린 즉시 복사를 택했는데, 두 가지 이유예요. ① 우리 프로세스는 코드+스택 **2페이지뿐**이라 COW로 아낄 게 거의 없어요. ② 우리 fork는 트랩 프레임을 유저 스택에 두는 단순화 때문에, 자식 프레임을 수정하려면 스택을 어차피 복사해야 해서 COW와 충돌해요. "이득이 작고 설계와 안 맞으니 안 한다" — 안 하는 것도 근거가 있는 선택이에요.

- **디스크 I/O: 폴링 vs 인터럽트 → 폴링** ([3편](/blog/hobby/hobby-kernel-02-fork-elf-filesystem)) — virtio 디스크를 인터럽트로 처리하면 I/O 대기 중 CPU를 다른 일에 쓸 수 있어요(효율적). 우린 **폴링**(완료될 때까지 루프)으로 했어요. **대가**: 디스크 읽는 동안 CPU가 놀아요. **이득**: 디스크용 인터럽트 핸들러·대기 큐를 안 만들어도 되고, 흐름이 위에서 아래로 읽혀 디버깅이 쉬워요. 단일 사용자 학습 커널에선 폴링의 단순함이 합리적이었어요.

- **exec: 새 주소공간 vs 재사용 → 재사용** ([4편](/blog/hobby/hobby-kernel-03-exec-and-shell)) — exec로 프로그램을 교체할 때, 새 페이지 테이블을 만들어 `satp`을 바꾸는 게 일반적이에요. 그런데 그러면 **유저 스택이 통째로 바뀌어** exec 함수의 지역변수가 깨지는 골치 아픈 문제가 생겨요. 우린 **페이지 테이블·스택은 재사용하고 코드 페이지만 교체**해서, `satp` 전환 자체를 없앴어요. 덕분에 스택 깨짐 문제가 사라지고 옛 페이지 누수도 없어졌어요 — 제약(트랩 프레임이 유저 스택에 있음)을 역이용한 선택이었어요.

공통점이 보이죠 — **거의 다 "단순함을 위해 무언가를 내준" 선택**이에요.
토이 커널의 목적이 "동작하는 걸 만들며 원리를 손으로 이해하기"라서, 매 갈림길에서 정석(트램폴린·COW·인터럽트·저널)을 알되 *일부러* 단순한 길을 골랐어요.
정석을 몰라서 못 한 게 아니라, **알고 포기한 것**이라는 게 핵심이에요.

## 마치며 — 어디까지 왔나

이번 글로 커널의 메모리 관리가 한 단계 깊어졌어요.

- **페이지 폴트 핸들러**가 "출력하고 멈추던 것"에서 "필요한 페이지를 만드는 것"으로
- **demand paging** — `sbrk`는 약속만, 페이지는 접근 시 할당
- **mmap** — 파일을 메모리처럼, 폴트가 파일 블록을 적재
- **쓰기 가능 FS** — 블록 할당 + 디스크 쓰기로 파일 생성·영속

[MIT 6.1810(xv6) 랩](https://pdos.csail.mit.edu/6.828/2023/schedule.html) 기준으로 보면, lazy allocation·mmap·writable fs는 각각 독립된 랩 주제예요.
핵심 메모리 관리 랩을 손으로 만져본 셈이에요.

솔직히 남은 것도 적어둘게요.
**Copy-on-Write fork**는 우리 fork가 트랩 프레임을 유저 스택에 두는 단순화 때문에 잘 안 맞았고(코드 페이지만 공유 가능해 폴트 데모가 빈약), **유저 스레드(uthread)**는 우리 단일 페이지 프로그램 모델(전역을 코드 페이지에, 스택을 힙에)에서 컨텍스트 스위치가 미묘하게 어긋나 일단 보류했어요.
**멀티코어(SMP)와 네트워크 스택**은 각각 커널 전체를 건드리는 큰 작업이라 별도 여정이고요.
— 학습 커널이라 "안 된 것"도 솔직히 남겨두는 게 맞다고 봐요.

부팅부터 메모리 관리까지, "OS가 어떻게 도는가"를 책이 아니라 손으로 만져 이해하는 게 이 프로젝트의 목적이었어요.
그 목적은 충분히 이뤘어요.

> 코드: [github.com/dj258255/hobby-kernel](https://github.com/dj258255/hobby-kernel)

### 참고 자료

- [xv6: a simple, Unix-like teaching operating system (MIT 6.S081)](https://pdos.csail.mit.edu/6.828/2023/xv6.html)
- [RISC-V Privileged Specification — 예외/위임(medeleg), scause 코드](https://riscv.org/technical/specifications/)
- 관련 글: [캐시와 버퍼](/blog/theory/cache-and-buffer) · [DB 스토리지 내부 ①](/blog/theory/db-storage-01-heap-page-index) · [JVM 메모리 ③: Off-heap](/blog/theory/es-memory-03-off-heap)

<!-- EN -->

## Introduction

By [Part 4](/blog/hobby/hobby-kernel-03-exec-and-shell) we had a small Unix up and running — boot, paging, processes, fork/exec/wait, a filesystem, and a user-space shell.
But the memory management up to that point was fairly naive.
**When a process was created, we allocated every page it might need up front, and when a page fault occurred we simply printed it and stopped.**

The one-line theme of this post is this — **"grow the page fault from an exception into a mechanism."** Instead of stopping when a fault happens, the kernel *does the work it needs to do* at that moment.
This single idea unlocks three things.

1. **Lazy allocation (demand paging)** — don't hand out memory in advance; hand it out the first time it's touched
2. **mmap** — map a file into the address space and read it like memory, without `read()`
3. **A writable filesystem** — (this one is separate from faults) turn a read-only FS into a writable one via block allocation

The first two share the **page fault handler** as a common foundation.
The idea of "fetch it when you need it" actually shows up all over computing — caches do it, DB buffer pools do it (I once organized this from a memory-hierarchy angle in [Cache and Buffer: Two Ways to Bridge a Speed Gap](/blog/theory/cache-and-buffer)).

> Every piece of code in this post was actually run and verified on QEMU `virt` (RISC-V rv64). The reference is [xv6 (MIT 6.S081)](https://pdos.csail.mit.edu/6.828/2023/xv6.html).

## 1. How a Page Fault Lands in Our Hands

There's something we need to pin down first.
When a user program touches unmapped memory, an exception called a **page fault** occurs — and the question is who that goes to.

On RISC-V, exceptions go by default to the highest privilege, **M-mode** (OpenSBI).
But our kernel runs in **S-mode**, so if a fault has to climb all the way up to M-mode and back down, it's slow and clunky.
That's why RISC-V has the **`medeleg` (machine exception delegation)** register, which lets us delegate "let S-mode handle these exceptions directly." OpenSBI sets this up at boot time.
Looking at the boot log:

```
Boot HART MEDELEG : 0x0000000000f0b509
```

Cracking open the bits of this value — bit 12 (instruction page fault), 13 (load page fault), and 15 (store/AMO page fault) are set (the `0xb000` part).
In other words, **page faults are delegated to S-mode** and our trap handler receives them directly.
That's the very trap handler we built in Part 1.

We distinguish the type by the `scause` (exception cause) code.

| scause | meaning |
|---|---|
| 12 | instruction page fault (the code being executed isn't mapped) |
| 13 | load page fault (the address being read isn't mapped) |
| 15 | store/AMO page fault (the address being written isn't mapped) |

And `stval` holds the **virtual address that faulted**.
With just these two, we know "who faulted while touching where."

The old trap handler, when it met such an exception, just printed the info and stopped (a debugging safety net).
Into this we wedge "if it's a fault we can handle, handle it; otherwise, stop at that point."

```c
// trap.c — inside kerneltrap()
} else if ((cause == SCAUSE_LOAD_FAULT || cause == SCAUSE_STORE_FAULT) &&
           proc_pagefault(r_stval(), cause == SCAUSE_STORE_FAULT)) {
    // 처리됨 → sepc를 그대로 두면 그 명령이 자동으로 재시도된다
} else {
    // 우리 영역이 아닌 진짜 폴트 → 정보 출력 후 정지
}
```

The key is that **we don't touch `sepc`**.
When handling a syscall (`ecall`) we advanced to the next instruction with `sepc += 4`, but a page fault has to "re-execute that instruction." Once we've created and mapped the page and return as-is, the load/store instruction that faulted runs again, and this time it succeeds because the page is there.
The user program doesn't even know it briefly stalled.

## 2. Lazy allocation (demand paging)

Now the first application.
**Even when a program grows its heap with `sbrk(n)`, we hand out not a single physical page.** Only when it actually touches that memory does a fault occur, and only then do we allocate the page.

Why do it this way — **most programs don't use all the memory they request.** It's common to ask for 1MB and use only the first few KB.
Grabbing the whole 1MB up front is wasteful, and the allocation is slow too.
"Promise it, and give it out at actual access time" is far more efficient.
Every modern OS, Linux included, works this way.

**It's not free, though.** Laying out the trade-offs:

| | eager allocation | lazy allocation (our choice) |
|---|---|---|
| `sbrk` cost | allocate N pages on request (slow) | just bump the pointer by +N (fast) |
| actual memory use | occupies everything even unused (waste) | occupies only what's touched |
| first access | succeeds immediately | one page fault (slight overhead) |
| risk | none | **overcommit** — you promised, but if physical pages run short, there's nothing to give at later access |

That last line is the crux.
Lazy allocation can "promise memory that doesn't even exist" (overcommit).
This is exactly why, when Linux truly runs out of memory, it kills processes with the **OOM Killer**.
Our teaching kernel has ample physical memory (125MB) so it never gets that bad, but "the promise differs from the reality" is the intrinsic cost of lazy.
Even so, for one or two simple programs the savings in memory and the fast `sbrk` overwhelmingly outweigh the one-time fault overhead on first access, so we chose lazy.

First, each process remembers the end of its heap (`heap_top`), and `sbrk` only grows it.

```c
// proc.c
uint64 proc_sbrk(int n) {
    struct proc *p = current_proc();
    uint64 old = p->heap_top;
    if (n > 0)
        p->heap_top += (uint64)n;   // 약속만 늘림 — 페이지는 안 만든다
    return old;                      // 새로 얻은 영역의 시작 주소
}
```

The heap region is a span carved out separately in the user address space (we made it grow upward from `0x10000`).
When a fault occurs in this region — only then do we make an empty page and map it.

```c
// proc.c — proc_pagefault()
uint64 a = va & ~(PGSIZE - 1);                  // 폴트 주소를 페이지 경계로
if (a >= HEAPBASE && a < p->heap_top) {         // 힙 영역 안의 폴트라면
    char *mem = kalloc();                       // 빈 물리 페이지 하나
    zero(mem, PGSIZE);
    uvm_map(p->pagetable, a, (uint64)mem, PTE_R | PTE_W | PTE_U);  // 매핑
    return 1;                                   // 처리됨 → 명령 재시도
}
```

For a demo, we put a small program `lazytest` on the disk.
It grows the heap by 2 pages with `sbrk(8192)`, then touches that memory.

```c
// user/lazytest.c
char *p = (char *)sys_sbrk(8192);   // 힙만 늘림 (물리 페이지 0장)
p[0]    = 42;                        // 첫 페이지 첫 바이트 → 폴트 → 할당
p[4096] = 99;                        // 둘째 페이지 → 또 폴트 → 할당
```

Running it:

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

Right after `sbrk`, the page count doesn't drop.
The moment we write `p[0]`, the first fault occurs and the `0x10000` page gets allocated, and at `p[4096]` a second fault allocates `0x11000`.
Reading it back, the written values are still there (`OK`).
The reason `mem` is unchanged after exit is that we reclaim those heap pages too when the process ends (no leak).

> This "fetch it when you touch it" pattern works exactly like the memory hierarchy covered in [Cache and Buffer](/blog/theory/cache-and-buffer) — CPU caches and DB buffer pools both "bring only what's needed right now into fast storage." Demand paging does that between "virtual memory ↔ physical memory."

## 3. mmap — Reading a File Like Memory

If the fault handler can make an empty page, it can also make a **page filled with file contents**.
That's `mmap`.

`mmap("motd.txt")` only *promises to map* a file into a region of the address space (again, zero pages).
The moment the program reads that address, a fault occurs, and the kernel computes **fault address -> file offset**, reads that block from disk, and fills the page.

```c
// proc.c — proc_pagefault()의 mmap 분기
if (a >= p->mmap_base && a < p->mmap_base + roundup(p->mmap_size)) {
    char *mem = kalloc();
    fs_read_page(p->mmap_start, p->mmap_size,
                 (a - p->mmap_base), mem);          // 파일 오프셋의 한 페이지를 읽어 채움
    uvm_map(p->pagetable, a, (uint64)mem, PTE_R | PTE_U);  // 읽기 전용 매핑
    return 1;
}
```

The **fault mechanism is identical** to lazy allocation.
The only difference is that instead of an empty page, we **fill it with a file block**.
The user program never calls the `read()` syscall once; it just reads memory.

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
Welcome to hobby-kernel (C / RISC-V).
This text lives on a virtio-blk disk and was read by the kernel's
own filesystem driver -- not baked into the kernel image.
```

The moment we read the first character `p[0]`, a fault occurs and the kernel reads the first block of `motd.txt` from disk into that page.
After that, the file's contents pour out from memory reads alone.
This is the charm of mmap — **the boundary between file and memory disappears.**

**Here we made two choices.**

- **`mmap` vs `read()`** — why mmap when we're reading the same file? `read(fd, buf, n)` has the kernel **copy** disk -> kernel buffer -> user buffer (two copies). mmap **maps the file pages directly** into the user address space, so there's no copy (zero-copy). In exchange there's a per-page fault cost, and it favors random access and large files. If you're going to read once straight through sequentially, `read()` is simpler and sufficient. Our goal was to show the concept of "file = memory," so we picked mmap.
- **Mapping read-only** — we didn't grant `PTE_W` on the PTE (just `PTE_R | PTE_U`). Making it writable requires logic to **write back** to disk when the user modifies the mapped memory — when to write (on every modification? at unmap?), dirty-page tracking, and so on, all of which jacks up the complexity. Read-only avoids all of that while still showing the heart of mmap (loading a file on fault), so for learning purposes this was exactly the right choice. We left writable mmap as a refinement step.

> This is exactly the same mechanism as `MappedByteBuffer` (memory-mapped files) covered in the JVM's [Off-heap and Direct Memory](/blog/theory/es-memory-03-off-heap). That side uses the OS's mmap on top of the JVM; here, we built that OS side ourselves.

## 4. A Writable Filesystem

From here on it's not memory but **storage**.
The filesystem from [Part 4](/blog/hobby/hobby-kernel-03-exec-and-shell) was read-only — we could only `ls`/`cat` files pre-baked onto the disk.
This time we make it so you can **create and write files from the shell, and have them survive a reboot**.

Our on-disk format is simple (for the detailed structure, see [Part 3](/blog/hobby/hobby-kernel-02-fork-elf-filesystem)).
The very idea of "store data in page/block units" is the same as DB storage (I once organized it in [Inside DB Storage ①: Heap, Page, Index](/blog/theory/db-storage-01-heap-page-index)).

```
블록 0      슈퍼블록 (magic, 파일 수, next_free)
블록 1      디렉터리 (이름, 크기, 시작 블록)
블록 2..    파일 데이터
```

File creation is a bundle of three steps — **find a free block -> write the data -> update the metadata.** We keep a "next free block" (`next_free`) in the superblock and allocate contiguous blocks starting from there.

```c
// fs.c — fs_create()
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

This is where **disk writes** show up for the first time.
The virtio-blk driver did have a write path (Part 3), but this is the first time we actually used it.
You just flip the direction of the descriptor — a read is "the device writes into the buffer," a write is "the device reads the buffer and writes it to disk."

We attached a `write` built-in command to the shell.

```
$ write greeting.txt hello from a writable fs
$ ls
  motd.txt  (162 bytes)
  ...
  greeting.txt  (24 bytes)        ← 새로 생김
$ cat greeting.txt
hello from a writable fs
```

To confirm it really persists — just **reboot with the same disk image**.

```
(재부팅 후)
[ok] filesystem mounted: 6 files   ← 5 + greeting.txt
$ cat greeting.txt
hello from a writable fs           ← 디스크에 박혀 살아남았다
```

### The Bug That Stumped Me: A Disk Sized Exactly

At first `write` seemed to work, but `cat` spat out weird binary.
The cause was anticlimactic — **the disk image was 54 blocks, sized exactly to the data.** When we tried to write a new file to block 54, that was outside the image range (0–53), so virtio **silently dropped** the write.
And when `cat` read an out-of-range block, it got bogus data (the superblock it had read just before).

The fix was to have mkfs **pad the disk image generously (256 blocks)**.
A filesystem needs "free space to write into" — an obvious lesson, but one that only sinks in once you've hit it yourself.

### The Price of Simplicity — Three Trade-offs

This filesystem aimed for "the simplest thing that works." Let me honestly note what we gave up as the price.
Each one tells you, in reverse, why a real filesystem (e.g. ext4, xv6's fs) is more complex.

- **write-once (contents fixed at creation)** — when a file is created we take all its contents and write them at once, and after that we don't modify or append. So we need no "free block reclamation" or "fragmentation" management, which keeps the code short. In exchange, you **can't grow, edit, or delete a file.** A real FS has files grow and shrink, so it has to manage free blocks with a bitmap and reclaim them.
- **contiguous block allocation (vs inode/indirect blocks)** — we store a file in contiguous blocks starting from `start`. Sequential reads are fast and the metadata is just two things, "start block + size," so it's simple. In exchange, **a file's size is tied to "contiguous free space,"** and as files are created and deleted, holes (fragmentation) open up in the middle so large files no longer fit. That's why Unix FSes use **inode + indirect blocks** (a block that separately gathers the addresses of data blocks) to compose large files out of scattered blocks. We simplified to "contiguous small files," much like "one-page programs."
- **no journaling — fragile to crashes** — file creation writes ① data ② directory ③ superblock to disk **in order**. What if power is lost between ② and ③? The directory has the file but the superblock's `next_free` isn't updated — so **the filesystem breaks.** To prevent this, a real FS first writes "apply this bundle as a whole" to a **journal (log)**, and erases it once fully applied (atomicity). Even if a crash happens, it consults the log at reboot and recovers. This is exactly the same idea as a transaction's ACID (I once covered it from a WAL/log angle in [Transaction ACID ④: Durability](/blog/theory/transaction-acid-04-durability)). Being single-user and for learning, we accepted this risk and chose simplicity.

All three are "simplicity ↔ robustness/flexibility" trade-offs.
In a teaching kernel simplicity wins, but knowing *why* you'd take on a given complexity and choosing to forgo it is entirely different from not doing it because you didn't know.

## 5. Looking Back — The Series' Core Design Decisions

Since we're on the subject of trade-offs anyway, let me gather in one place the big choices made throughout the series.
Even for a toy kernel, **every step was a succession of "there's another path too, so why this one."**

- **Language: Rust vs C → C** ([Part 1](/blog/hobby/hobby-kernel-00-boot-to-paging)) — Rust's strength is memory safety, but down at the kernel floor you end up touching hardware directly with `unsafe`, which shrinks that advantage. Above all, the reference xv6 is C/RISC-V, so **the code maps 1:1** with the least friction. We chose "alignment with the reference + the canonical language of kernels" over "safety."

- **Trap handling: trampoline vs SUM bit → SUM** ([Part 2](/blog/hobby/hobby-kernel-01-usermode-to-processes)) — xv6 elegantly solves the user↔kernel transition with a **trampoline** (a small piece of code mapped at the same VA in every address space). We handle a user process's trap **on the user stack** (the kernel accesses user pages via the `SUM` bit) and skip the trampoline. **Gain**: we don't have to build the whole trampoline/per-process kernel-stack design. **Price**: `SUM` has to always be 1 (in Part 2 this caused us to flounder for a while with infinite faults), and kernel code running on the user stack isn't canonical. We gave up some robustness for simplicity.

- **Process address space: replicating the kernel into every page table** ([Part 2](/blog/hobby/hobby-kernel-01-usermode-to-processes)) — since we don't use a trampoline, the trap handler (kernel code) had to live at the same address in every process's page table. So we **identity-map the entire kernel per process**. **Price**: each process spends ~66 pages on the page-table structure (mapping 128MB at 4KB). Compared to a trampoline (1 page) it's extravagant, but the code is much simpler. (Because of this cost, fork became expensive, which is why [resource reclamation in the refinement step](/blog/hobby/hobby-kernel-03-exec-and-shell) became important.)

- **fork: eager copy vs Copy-on-Write → eager copy** ([Part 3](/blog/hobby/hobby-kernel-02-fork-elf-filesystem)) — a real OS shares pages on fork and copies only on write (COW). We chose eager copy, for two reasons. ① Our processes are **just 2 pages** (code + stack), so there's almost nothing for COW to save. ② Our fork puts the trap frame on the user stack as a simplification, so to modify the child's frame we have to copy the stack anyway, which conflicts with COW. "The gain is small and it doesn't fit the design, so we don't do it" — not doing something is also a choice with a rationale.

- **Disk I/O: polling vs interrupt → polling** ([Part 3](/blog/hobby/hobby-kernel-02-fork-elf-filesystem)) — handling the virtio disk with interrupts lets the CPU do other work while waiting on I/O (efficient). We did it with **polling** (loop until complete). **Price**: the CPU idles while reading the disk. **Gain**: we don't have to build a disk interrupt handler and wait queue, and the flow reads top-to-bottom so debugging is easy. In a single-user teaching kernel, polling's simplicity was reasonable.

- **exec: new address space vs reuse → reuse** ([Part 4](/blog/hobby/hobby-kernel-03-exec-and-shell)) — when replacing a program via exec, it's common to make a new page table and switch `satp`. But then **the user stack changes wholesale** and exec's local variables break, a nasty problem. We **reuse the page table and stack and replace only the code pages**, eliminating the `satp` switch itself. Thanks to that the stack-breaking problem disappears and there's no old-page leak — a choice that turned a constraint (the trap frame being on the user stack) to our advantage.

You can see the common thread — **almost all of them are choices that "gave up something for simplicity."** Because a toy kernel's purpose is to "build something that works and understand the principles by hand," at every fork in the road we knew the canonical approach (trampoline, COW, interrupt, journal) and *deliberately* chose the simple path.
The key is that it wasn't done out of ignorance — it was **forgone knowingly.**

## Wrapping Up — How Far We've Come

With this post, the kernel's memory management got one level deeper.

- **The page fault handler** went from "printing and stopping" to "making the page that's needed"
- **demand paging** — `sbrk` is just a promise; pages are allocated at access time
- **mmap** — a file like memory, with faults loading file blocks
- **A writable FS** — file creation and persistence via block allocation + disk writes

By the standard of the [MIT 6.1810 (xv6) labs](https://pdos.csail.mit.edu/6.828/2023/schedule.html), lazy allocation, mmap, and writable fs are each their own independent lab topics.
We've effectively gotten our hands on the core memory-management labs.

Let me honestly note what's left, too.
**Copy-on-Write fork** didn't fit well because our fork puts the trap frame on the user stack as a simplification (only code pages can be shared, so the fault demo is thin), and **user threads (uthread)** were put on hold because context switching is subtly off in our single-page program model (globals in the code page, stack in the heap).
**Multicore (SMP) and a network stack** are each a big undertaking that touches the whole kernel, so they're separate journeys.
— Since this is a teaching kernel, I think it's right to honestly leave the "not done" parts on record too.

From boot to memory management, the purpose of this project was to understand "how an OS runs" by hand rather than from a book.
That purpose has been amply fulfilled.

> Code: [github.com/dj258255/hobby-kernel](https://github.com/dj258255/hobby-kernel)

### References

- [xv6: a simple, Unix-like teaching operating system (MIT 6.S081)](https://pdos.csail.mit.edu/6.828/2023/xv6.html)
- [RISC-V Privileged Specification — exceptions/delegation (medeleg), scause codes](https://riscv.org/technical/specifications/)
- Related posts: [Cache and Buffer](/blog/theory/cache-and-buffer) · [Inside DB Storage ①](/blog/theory/db-storage-01-heap-page-index) · [JVM Memory ③: Off-heap](/blog/theory/es-memory-03-off-heap)

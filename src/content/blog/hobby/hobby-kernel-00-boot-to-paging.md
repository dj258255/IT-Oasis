---
title: '부팅부터 페이징까지'
titleEn: 'From Boot to Paging'
description: OS를 깊이 이해하려고 C로 바닥부터 만든 RISC-V 토이 커널. QEMU virt에서 S-mode 부팅, UART 출력, 트랩/타이머 인터럽트, PLIC 기반 키보드 입력과 커널 셸, 물리 페이지 할당기, 그리고 Sv39 페이징까지 직접 구현한 과정을 정리한다. xv6(MIT 6.S081)를 참고서로 진행.
descriptionEn: "A RISC-V toy kernel built from scratch in C to understand OS internals — S-mode boot on QEMU virt, UART output, trap/timer interrupts, PLIC-based keyboard input and a kernel shell, a physical page allocator, and Sv39 paging. Following xv6 (MIT 6.S081)."
date: 2026-05-28T00:00:00.000Z
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
seriesOrder: 1
---


![hobby-kernel 유저공간 셸 데모](/uploads/hobby/hobby-kernel-c/demo.svg)

*바닥부터 직접 만드는 RISC-V 토이 커널 연재. 이 글은 1편 — 부팅과 페이징(가상메모리).*

## 들어가며

운영체제가 안에서 어떻게 도는지 제대로 알고 싶어서, **C로 바닥부터 커널을 만들기로** 했어요.
타겟은 RISC-V(rv64), 에뮬레이터는 QEMU의 `virt` 머신, 참고서는 [xv6(MIT 6.S081)](https://pdos.csail.mit.edu/6.828/2023/xv6.html)예요.

> 왜 C/RISC-V인가: 커널의 정석 언어는 C이고(리눅스·xv6·BSD 전부 C), 참고서 xv6도 C/RISC-V라 코드가 1:1로 매핑돼 마찰이 가장 적어요. RISC-V는 ISA가 단순해 학습에 좋고, 맥(애플 실리콘)에서 `riscv64-elf-gcc`로 툴체인도 깔끔하게 잡혀요.

이 연재는 **xv6의 학습 랩을 직접 구현해온 기록**이에요.
부팅·페이징부터 프로세스·시스템콜·파일시스템, 그 위의 demand paging·mmap·copy-on-write, 멀티코어와 네트워크(UDP·TCP), 유저 스레드까지 — OS의 핵심을 한 조각씩 손으로 만들어 봐요.
(전체 진행 상황과 앞으로의 주제는 [저장소 README의 로드맵](https://github.com/dj258255/hobby-kernel#readme)에 정리돼 있어요.)

이번 글은 그 첫 글 — **부팅과 페이징**으로 커널의 골격을 세워요.
RISC-V의 좋은 점 하나: `-nographic`으로 돌리면 UART가 그대로 터미널 stdout으로 나와서, 스크린샷 없이 출력을 바로 확인할 수 있어요.

## 1. 부팅 + UART 출력

애플 실리콘 맥이라 크로스 컴파일러가 필요해요.

```bash
brew install riscv64-elf-gcc qemu
```

QEMU virt를 켜면 **OpenSBI**(펌웨어)가 먼저 M-mode 셋업을 끝내고, 우리 커널을 `0x8020_0000`으로 **S-mode**에서 점프시켜요.
그래서 커널은 그 주소에 링크하고, 진입점에서 스택만 잡아 C로 넘어가요.

```asm
# entry.S
_entry:
        la      sp, stack_top   # 스택 설정
        call    kmain           # C 커널 시작
```

화면 출력은 가장 원초적인 방법 — **메모리 매핑된 UART**(`0x1000_0000`)에 직접 써요.
OpenSBI가 이미 초기화해 둬서 송신 레지스터에 쓰기만 하면 돼요.

```c
// uart.c
#define UART0 0x10000000L
void uart_putc(char c) {
    while ((uart[UART_LSR] & LSR_TX_IDLE) == 0) ;  // 송신 버퍼 빌 때까지
    uart[UART_THR] = c;
}
```

```
OpenSBI v1.5.1 ...
Domain0 Next Address : 0x0000000080200000   ← 우리 커널로
Domain0 Next Mode    : S-mode
========================================
  hobby-kernel v0.1  (C / RISC-V)
========================================
Hello from a C kernel!
```

## 2. 트랩/인터럽트 + 타이머

CPU가 인터럽트/예외를 만나면 `stvec`가 가리키는 핸들러로 점프해요.
거기서 레지스터를 전부 저장하고 C 핸들러를 부른 뒤, 복원하고 `sret`로 복귀해요.

```c
// trap.c — kernelvec.S가 레지스터 저장 후 호출
void kerneltrap(void) {
    uint64 cause = r_scause();
    if (cause & SCAUSE_INTERRUPT) {
        if ((cause & 0xff) == SCAUSE_S_TIMER) {
            ticks++;
            w_stimecmp(r_time() + TIMER_INTERVAL);  // 다음 타이머 예약
        }
        // ...
    }
}
```

타이머는 RISC-V의 **sstc 확장**(`stimecmp` CSR)으로 "다음 인터럽트 시각"을 직접 써서 주기 틱을 만들어요.
`scause`의 최상위 비트가 인터럽트/예외를 구분하고, 코드 5가 S-mode 타이머예요.

## 3. 키보드 입력 + 셸

키보드(UART 입력)는 **PLIC**(인터럽트 컨트롤러)를 거쳐 S-mode 외부 인터럽트로 들어와요.
인터럽트 핸들러는 PLIC에서 누가 인터럽트를 걸었는지 받아(claim), UART라면 받은 글자를 읽어 셸에 넘기고, 처리 완료를 알려요(complete).

```c
// trap.c
} else if ((cause & 0xff) == SCAUSE_S_EXTERNAL) {
    int irq = plic_claim();
    if (irq == UART0_IRQ) uart_intr();   // 받은 글자 → shell_input()
    if (irq) plic_complete(irq);
}
```

셸은 글자를 모아 줄을 만들고 Enter에서 명령을 실행해요.
libc가 없으니 문자열 비교도 직접 짜요.

```
type 'help' for commands.
hobby> help
commands: help, about, uptime, mem, clear, whoami, echo <text>
hobby> uptime
uptime: 3 sec
```

`uptime`이 동작한다는 건, 셸이 입력을 처리하는 동안 **타이머 인터럽트가 동시에 돌며 틱을 세고 있다**는 뜻이에요.

## 4. 물리 페이지 할당기 — RAM을 나눠 쓰는 법

가상메모리로 가기 전에, 먼저 **물리 메모리(RAM)** 를 다룰 줄 알아야 해요.

물리 메모리는 그냥 **거대한 바이트 배열**이에요.
QEMU `virt`는 128MB를 주는데, 주소로 보면 `0x8000_0000`부터 `0x8800_0000`까지죠.
그 앞부분엔 OpenSBI(펌웨어)와 우리 커널 이미지가 이미 들어앉아 있고, 그 뒤(`end`부터 `PHYSTOP`까지)가 우리가 자유롭게 쓸 수 있는 빈 RAM이에요.

문제는 "이 빈 RAM을 누구에게 얼마나 줄지" 관리하는 거예요.
페이지 테이블도, 프로세스 스택도, 나중엔 유저 페이지도 전부 여기서 한 덩어리씩 떼어 가거든요.

그래서 빈 RAM을 **4KB짜리 "물리 페이지(physical page)"** 단위로 잘게 쪼개요.
왜 하필 4KB냐면, 곧 만들 페이징의 단위가 4KB라서 둘을 맞추면 관리가 깔끔하거든요.
잘라낸 페이지들을 **free list**(빈 페이지를 잇는 연결 리스트)로 엮어두고, 필요하면 앞에서 하나 떼주고(`kalloc`) 다 쓰면 다시 앞에 끼워 넣어요(`kfree`).

리스트의 `next` 포인터를 어디 둘까요?
영리하게도 **빈 페이지 그 자체의 첫 8바이트**에 둬요 — 어차피 빈 메모리니까 따로 메타데이터 공간이 필요 없죠.

```c
// kalloc.c — 빈 페이지 하나를 free list에서 떼어 준다
struct run { struct run *next; };   // 빈 페이지 첫 8바이트 = 다음 빈 페이지 주소
static struct run *freelist;

void *kalloc(void) {
    struct run *r = freelist;
    if (r) { freelist = r->next; freecnt--; }  // 맨 앞 페이지를 꺼낸다
    return (void *)r;                           // 0이면 메모리 부족
}
```

이게 `Vec` 같은 동적 자료구조의 밑바닥이에요 — "메모리를 달라"는 요청에 RAM 한 조각을 떼주는 가장 기초적인 할당기죠.

```
hobby> mem
free pages: 32238  (~125 MB free)
```

128MB RAM에서 OpenSBI와 커널을 뺀 약 125MB가 **32238개의 물리 페이지**로 잡혔어요.
이 페이지들이 다음 절에서 가상주소가 가리킬 "진짜 RAM"이 됩니다.

## 5. 페이징 (Sv39) — 가상메모리의 토대

이제 이 커널의 가장 중요한 개념, **가상메모리(virtual memory)** 예요.

### 왜 가상메모리가 필요할까

방금까지 우리는 주소를 **물리주소 그대로** 썼어요.
`0x8020_0000`이라고 하면 진짜 그 RAM 칸을 가리키는 거죠.
프로그램이 하나뿐일 땐 괜찮아요.
그런데 프로그램(프로세스)이 여럿이면 문제가 터져요.

- **충돌**: 두 프로그램이 둘 다 주소 `0x1000`에 변수를 두고 싶어 하면? 같은 물리 칸을 두고 싸워요.
- **보호**: 프로그램 A의 버그가 `0x8020_0000`에 막 쓰면 커널이나 프로그램 B의 메모리를 망가뜨려요.
- **유연성**: "연속된 큰 메모리가 필요한데 RAM은 조각조각 흩어져 있다"면?

해결책은 한 줄로 요약돼요 — **각 프로그램에게 "나만의 메모리"라는 환상을 준다.**
프로그램은 `0x1000`부터 시작하는 깨끗한 자기만의 주소공간을 보지만, 그 주소는 **진짜 주소가 아니라 가짜(가상)** 예요.
CPU가 메모리에 접근할 때마다 이 **가상주소를 실제 물리주소로 몰래 번역**해줘요.
A의 `0x1000`과 B의 `0x1000`은 서로 다른 물리 페이지로 번역되니, 같은 주소를 써도 안 부딪혀요.
이 "각자에게 사적인 주소공간을 주고, 접근 때마다 번역한다"가 **가상메모리**예요.

### 페이징 — 번역의 메커니즘

그 번역을 **페이지 단위**로 하는 게 **페이징(paging)** 이에요.
가상 주소공간도, 물리 RAM도 똑같이 4KB **페이지**로 나누고, "어느 가상 페이지가 어느 물리 페이지로 가는지"를 적은 표 — **페이지 테이블** — 를 둬요.

```
[가상 페이지]        [페이지 테이블]            [물리 페이지 (4절의 그 RAM 조각들)]
 va 0x1000   ──────▶  "0x1000 → 0x8021_3000"  ──────▶  실제 RAM 0x8021_3000
 va 0x2000   ──────▶  "0x2000 → 0x8019_a000"  ──────▶  실제 RAM 0x8019_a000
```

표의 한 칸이 **PTE(Page Table Entry)** 예요.
PTE에는 "이 가상 페이지가 가리킬 물리 페이지 번호" + **권한 비트**가 들어 있어요.

- `V`(valid): 이 매핑이 유효한가
- `R`/`W`/`X`: 읽기/쓰기/실행 허용
- `U`: 유저 모드에서 접근 가능 (← 나중에 프로세스 격리의 핵심)

권한 비트가 보호를 담당해요.
코드 페이지는 `R|X`(읽기·실행, 쓰기 금지)로, 데이터는 `R|W`로 매핑하면, 코드를 실수로 덮어쓰는 버그가 폴트로 잡혀요.

### Sv39 — 왜 3단계인가

RISC-V의 **Sv39**는 39비트 가상주소를 쓰고, 페이지 테이블을 **3단계 트리**로 둬요.
왜 한 장의 큰 표가 아니라 3단계일까요?
39비트 주소공간을 4KB로 나누면 페이지가 1억 개가 넘어요 — 그걸 한 표로 만들면 표 자체가 기가바이트급이죠.
하지만 실제로 프로그램이 쓰는 주소는 **드문드문(sparse)** 해요(코드 조금, 스택 조금, 힙 조금).
3단계 트리로 두면 **실제로 쓰는 가지만 만들면 되니** 표가 작아져요.
`walk()`가 가상주소를 9비트씩 쪼개 트리를 세 번 따라 내려가 PTE를 찾고, 중간 노드가 없으면 그때그때 `kalloc`으로 만들어요.

### 이 글에선 — 커널 식별 매핑

가상메모리의 진짜 힘(프로세스마다 다른 번역)은 유저 프로세스가 생기는 다음 글부터예요.
이번 글에선 **커널 자신**을 위한 페이지 테이블 한 장만 만들어요.
그런데 여기엔 함정이 있어요 — 페이징을 켜는 순간부터 모든 주소가 번역되는데, 지금 실행 중인 커널 코드의 주소도 갑자기 바뀌면 그 다음 명령을 못 찾아 죽어요.

그래서 커널은 **식별 매핑(identity mapping, va == pa)** 을 써요.
"가상주소 `0x8020_0000` → 물리주소 `0x8020_0000`"처럼 **번역해도 같은 주소가 나오게** 매핑하는 거죠.
그러면 페이징을 켜도 커널 입장에선 아무것도 안 바뀐 것처럼 매끄럽게 이어져요.

```c
// vm.c — 커널 페이지 테이블에 "va == pa"로 매핑(권한만 영역별로 다르게)
kvmmap(kpt, UART0,    UART0,    PGSIZE,  PTE_R|PTE_W);          // UART: 읽기/쓰기
kvmmap(kpt, PLIC,     PLIC,     0x400000,PTE_R|PTE_W);          // 인터럽트 컨트롤러
kvmmap(kpt, KERNBASE, KERNBASE, etext-KERNBASE, PTE_R|PTE_X);   // 커널 코드: 읽기/실행
kvmmap(kpt, etext,    etext,    PHYSTOP-etext,  PTE_R|PTE_W);   // 데이터+빈 RAM: 읽기/쓰기
```

매핑을 다 만들었으면, 페이지 테이블의 물리주소를 **`satp` 레지스터**에 적재하는 순간 페이징이 켜져요.
`sfence.vma`는 CPU가 캐시해 둔 옛 번역(TLB)을 비우는 명령이에요 — 매핑을 바꿨으니 옛 캐시를 버리라는 거죠.

```c
void kvminithart(void) {
    sfence_vma();
    w_satp(MAKE_SATP(kernel_pagetable));  // 이 줄에서 페이징 ON
    sfence_vma();
}
```

```
[ok] paging enabled (Sv39 kernel page table)
hobby> mem
free pages: 32169  (~125 MB free)
```

페이징을 켠 뒤에도 셸·타이머·입출력이 **전부 그대로** 동작해요 — 식별 매핑이라 주소가 안 바뀌었으니까요.
빈 페이지가 32238 → 32169로 약 69개 줄었는데, 그게 바로 **페이지 테이블 트리를 짓는 데 쓴 물리 페이지들**이에요.
4절에서 만든 물리 페이지 할당기가 여기서 처음으로 진짜 일을 한 거죠.

### 한 장으로 정리

- **물리 페이지** = 진짜 RAM 4KB 조각 (`kalloc`이 떼어 줌)
- **가상 페이지** = 프로세스가 보는 주소공간의 4KB 조각 (가짜 주소)
- **페이지 테이블 / PTE** = 가상 페이지 → 물리 페이지 번역 + 권한
- **페이징** = 그 번역을 페이지 단위로 하는 *메커니즘*
- **가상메모리** = 페이징으로 얻는 *추상화*(격리·보호·유연성)

> 가상메모리는 한 글로 끝나지 않아요. 프로세스마다 **다른 번역 표**를 줘서 격리하는 건 [2편](/blog/hobby/hobby-kernel-01-usermode-to-processes), 페이지를 미리 안 주고 접근할 때 만드는 **demand paging·mmap**은 [5편](/blog/hobby/hobby-kernel-04-paging-mmap-writable-fs), 같은 물리 페이지를 공유하다 쓸 때 복제하는 **copy-on-write**는 [8편](/blog/hobby/hobby-kernel-07-copy-on-write)에서 이어집니다.

## 마치며

여기까지가 커널의 **골격**이에요.

- S-mode 부팅 + UART 출력
- 트랩/타이머 인터럽트
- PLIC 키보드 입력 + 커널 셸
- 물리 페이지 할당기
- Sv39 페이징

`make run`으로 직접 부팅해 명령어를 칠 수 있는 인터랙티브 커널이 됐어요.
다음 글에서는 OS의 진짜 핵심 — **유저모드와 시스템콜**로 들어가요.
지금은 모든 코드가 커널 권한(S-mode)에서 도는데, "유저 프로그램이 커널에 부탁(syscall)하는 경계"를 만드는 거예요.
이게 OS를 OS답게 만드는 부분이에요.

> 코드: [github.com/dj258255/hobby-kernel](https://github.com/dj258255/hobby-kernel)
> 다음 글: **유저모드 + 시스템콜 (예정)**

### 참고 자료

- [xv6: a simple, Unix-like teaching operating system (MIT 6.S081)](https://pdos.csail.mit.edu/6.828/2023/xv6.html)
- [OSDev Wiki](https://wiki.osdev.org/)
- [RISC-V Privileged Specification](https://riscv.org/technical/specifications/)

<!-- EN -->

![hobby-kernel userspace shell demo](/uploads/hobby/hobby-kernel-c/demo.svg)

*A RISC-V toy kernel built from scratch — a blog series. This is Part 1: booting and paging (virtual memory).*

## Introduction

I wanted to really understand how an operating system works under the hood, so I decided to **build a kernel from scratch in C**.
The target is RISC-V (rv64), the emulator is QEMU's `virt` machine, and the reference is [xv6 (MIT 6.S081)](https://pdos.csail.mit.edu/6.828/2023/xv6.html).

> Why C/RISC-V: C is the canonical language for kernels (Linux, xv6, and BSD are all C), and since the xv6 reference is also C/RISC-V, the code maps 1:1 with the least friction. RISC-V has a simple ISA that's great for learning, and on a Mac (Apple Silicon) the toolchain sets up cleanly with `riscv64-elf-gcc`.

This series is a **record of implementing the xv6 learning labs from scratch**.
From boot and paging through processes, system calls, and a filesystem, then demand paging, mmap, copy-on-write, multicore, networking (UDP·TCP), and user threads — building the core of an OS one piece at a time.
(Overall progress and upcoming topics are tracked in the [repo's README roadmap](https://github.com/dj258255/hobby-kernel#readme).)

This first post sets up the skeleton of the kernel — **booting and paging**.
One nice thing about RISC-V: running with `-nographic` sends UART straight to the terminal's stdout, so you can check the output directly without screenshots.

## 1. Boot + UART output

Since this is an Apple Silicon Mac, a cross-compiler is needed.

```bash
brew install riscv64-elf-gcc qemu
```

When you start QEMU virt, **OpenSBI** (the firmware) first finishes the M-mode setup, then jumps to our kernel at `0x8020_0000` in **S-mode**.
So the kernel is linked at that address, and at the entry point it just sets up a stack and hands off to C.

```asm
# entry.S
_entry:
        la      sp, stack_top   # 스택 설정
        call    kmain           # C 커널 시작
```

For screen output, the most primitive approach — writing directly to the **memory-mapped UART** (`0x1000_0000`).
OpenSBI has already initialized it, so you only need to write to the transmit register.

```c
// uart.c
#define UART0 0x10000000L
void uart_putc(char c) {
    while ((uart[UART_LSR] & LSR_TX_IDLE) == 0) ;  // 송신 버퍼 빌 때까지
    uart[UART_THR] = c;
}
```

```
OpenSBI v1.5.1 ...
Domain0 Next Address : 0x0000000080200000   ← 우리 커널로
Domain0 Next Mode    : S-mode
========================================
  hobby-kernel v0.1  (C / RISC-V)
========================================
Hello from a C kernel!
```

## 2. Traps/interrupts + timer

When the CPU hits an interrupt/exception, it jumps to the handler pointed to by `stvec`.
There it saves all the registers, calls the C handler, then restores them and returns with `sret`.

```c
// trap.c — kernelvec.S가 레지스터 저장 후 호출
void kerneltrap(void) {
    uint64 cause = r_scause();
    if (cause & SCAUSE_INTERRUPT) {
        if ((cause & 0xff) == SCAUSE_S_TIMER) {
            ticks++;
            w_stimecmp(r_time() + TIMER_INTERVAL);  // 다음 타이머 예약
        }
        // ...
    }
}
```

The timer uses RISC-V's **sstc extension** (the `stimecmp` CSR) to write the "time of the next interrupt" directly, producing periodic ticks.
The top bit of `scause` distinguishes interrupt from exception, and code 5 is the S-mode timer.

## 3. Keyboard input + shell

Keyboard input (UART input) comes in as an S-mode external interrupt through the **PLIC** (interrupt controller).
The interrupt handler asks the PLIC who raised the interrupt (claim); if it's the UART, it reads the received character and passes it to the shell, then signals that handling is done (complete).

```c
// trap.c
} else if ((cause & 0xff) == SCAUSE_S_EXTERNAL) {
    int irq = plic_claim();
    if (irq == UART0_IRQ) uart_intr();   // 받은 글자 → shell_input()
    if (irq) plic_complete(irq);
}
```

The shell collects characters into a line and runs the command on Enter.
With no libc, even string comparison is written by hand.

```
type 'help' for commands.
hobby> help
commands: help, about, uptime, mem, clear, whoami, echo <text>
hobby> uptime
uptime: 3 sec
```

The fact that `uptime` works means that **while the shell is processing input, the timer interrupt is running concurrently and counting ticks**.

## 4. Physical page allocator — how to share out RAM

Before virtual memory, we first need to handle **physical memory (RAM)**.

Physical memory is just a **giant array of bytes**.
QEMU `virt` gives 128MB, which in addresses runs from `0x8000_0000` to `0x8800_0000`.
The front part is already occupied by OpenSBI (firmware) and our kernel image; the rest (from `end` to `PHYSTOP`) is free RAM we can use however we like.

The problem is managing "who gets how much of that free RAM."
Page tables, process stacks, and later user pages all carve a chunk out of here.

So we slice the free RAM into 4KB **"physical pages."**
Why 4KB? Because the paging we're about to build uses a 4KB unit, and matching the two keeps management clean.
We string the sliced pages into a **free list** (a linked list of free pages), handing one off the front when needed (`kalloc`) and pushing it back when done (`kfree`).

Where do we store the list's `next` pointer?
Cleverly, in the **first 8 bytes of the free page itself** — it's free memory anyway, so we need no separate metadata.

```c
// kalloc.c — hand one free page off the free list
struct run { struct run *next; };   // first 8 bytes of a free page = address of next free page
static struct run *freelist;

void *kalloc(void) {
    struct run *r = freelist;
    if (r) { freelist = r->next; freecnt--; }  // take the front page
    return (void *)r;                           // 0 means out of memory
}
```

This is the bedrock under a dynamic structure like `Vec` — the most basic allocator that hands out a chunk of RAM in response to "give me memory."

```
hobby> mem
free pages: 32238  (~125 MB free)
```

Of the 128MB of RAM, about 125MB (after OpenSBI and the kernel) becomes **32238 physical pages**.
These pages are the "real RAM" that virtual addresses will point at in the next section.

## 5. Paging (Sv39) — the foundation of virtual memory

Now the most important concept in this kernel — **virtual memory**.

### Why do we need virtual memory

Until now we used addresses as **physical addresses directly**.
Say `0x8020_0000` and you mean that actual RAM cell.
With only one program that's fine.
But with several programs (processes) it falls apart.

- **Collision**: if two programs both want a variable at address `0x1000`, they fight over the same physical cell.
- **Protection**: a bug in program A writing all over `0x8020_0000` corrupts the kernel or program B.
- **Flexibility**: what if you need a large contiguous region but RAM is scattered in fragments?

The fix is one line — **give each program the illusion of "memory that's all mine."**
A program sees its own clean address space starting at `0x1000`, but those addresses aren't real — they're **fake (virtual)**.
Every time the CPU touches memory, it **quietly translates this virtual address into a real physical one**.
A's `0x1000` and B's `0x1000` translate to different physical pages, so they never collide even using the same address.
This "give each one a private address space and translate on every access" is **virtual memory**.

### Paging — the translation mechanism

Doing that translation in **page-sized units** is **paging**.
Both the virtual address space and physical RAM are split into 4KB **pages**, and a table — the **page table** — records "which virtual page maps to which physical page."

```
[virtual page]      [page table]               [physical page (the RAM chunks from §4)]
 va 0x1000   ──────▶  "0x1000 → 0x8021_3000"  ──────▶  real RAM 0x8021_3000
 va 0x2000   ──────▶  "0x2000 → 0x8019_a000"  ──────▶  real RAM 0x8019_a000
```

One slot of the table is a **PTE (Page Table Entry)**.
A PTE holds "the physical page number this virtual page points at" plus **permission bits**.

- `V` (valid): is this mapping valid
- `R`/`W`/`X`: read / write / execute allowed
- `U`: accessible from user mode (← later, the key to process isolation)

The permission bits provide protection.
Map code pages as `R|X` (read/execute, no write) and data as `R|W`, and a bug that accidentally overwrites code gets caught as a fault.

### Sv39 — why 3 levels

RISC-V's **Sv39** uses 39-bit virtual addresses and a **3-level tree** of page tables.
Why a tree instead of one big table?
Splitting a 39-bit space into 4KB pages gives over 100 million pages — one flat table for that would itself be gigabytes.
But a program's actually-used addresses are **sparse** (a little code, a little stack, a little heap).
With a 3-level tree you **only build the branches you actually use**, so the table stays small.
`walk()` chops the virtual address into 9-bit slices, descends the tree three times to find the PTE, and creates a missing intermediate node on the fly with `kalloc`.

### In this post — kernel identity mapping

Virtual memory's real power (a different translation per process) starts in the next post, once user processes exist.
Here we build just one page table, for the **kernel itself**.
And there's a trap: the moment paging turns on, *every* address gets translated — including the address of the kernel code currently running. If that suddenly changes, the next instruction can't be found and we die.

So the kernel uses **identity mapping (va == pa)**.
Map "virtual `0x8020_0000` → physical `0x8020_0000`" so that **translation yields the same address**.
Then turning paging on is seamless — from the kernel's point of view nothing changed.

```c
// vm.c — map the kernel "va == pa" (only the permissions differ per region)
kvmmap(kpt, UART0,    UART0,    PGSIZE,  PTE_R|PTE_W);          // UART: read/write
kvmmap(kpt, PLIC,     PLIC,     0x400000,PTE_R|PTE_W);          // interrupt controller
kvmmap(kpt, KERNBASE, KERNBASE, etext-KERNBASE, PTE_R|PTE_X);   // kernel code: read/execute
kvmmap(kpt, etext,    etext,    PHYSTOP-etext,  PTE_R|PTE_W);   // data + free RAM: read/write
```

Once the mapping is built, loading the page table's physical address into the **`satp` register** turns paging on at that instant.
`sfence.vma` flushes the CPU's cached old translations (the TLB) — we changed the mapping, so throw away the old cache.

```c
void kvminithart(void) {
    sfence_vma();
    w_satp(MAKE_SATP(kernel_pagetable));  // this line turns paging ON
    sfence_vma();
}
```

```
[ok] paging enabled (Sv39 kernel page table)
hobby> mem
free pages: 32169  (~125 MB free)
```

Even after paging is on, the shell, timer, and I/O all keep working **exactly as before** — identity mapping kept the addresses unchanged.
Free pages dropped from 32238 to 32169, about 69 — and those are precisely the **physical pages spent building the page table tree**.
The physical page allocator from §4 just did its first real work here.

### One screen to sum up

- **Physical page** = a real 4KB chunk of RAM (handed out by `kalloc`)
- **Virtual page** = a 4KB chunk of the address space a process sees (fake addresses)
- **Page table / PTE** = virtual page → physical page translation + permissions
- **Paging** = the *mechanism* that does that translation per page
- **Virtual memory** = the *abstraction* paging buys you (isolation, protection, flexibility)

> Virtual memory doesn't end in one post. Isolating processes by giving each a **different translation table** is [Part 2](/blog/hobby/hobby-kernel-01-usermode-to-processes); not handing pages out until they're touched (**demand paging / mmap**) is [Part 5](/blog/hobby/hobby-kernel-04-paging-mmap-writable-fs); sharing a physical page and copying only on write (**copy-on-write**) is [Part 8](/blog/hobby/hobby-kernel-07-copy-on-write).

## Wrapping up

That's the **skeleton** of the kernel.

- S-mode boot + UART output
- Trap/timer interrupts
- PLIC keyboard input + kernel shell
- Physical page allocator
- Sv39 paging

With `make run` it boots into an interactive kernel where you can type commands.
In the next post we get into the real heart of an OS — **user mode and system calls**.
Right now all code runs at kernel privilege (S-mode); the goal is to build the boundary where "a user program asks the kernel for a favor (syscall)." This is the part that makes an OS an OS.

> Code: [github.com/dj258255/hobby-kernel](https://github.com/dj258255/hobby-kernel)
> Next post: **User mode + system calls (coming soon)**

### References

- [xv6: a simple, Unix-like teaching operating system (MIT 6.S081)](https://pdos.csail.mit.edu/6.828/2023/xv6.html)
- [OSDev Wiki](https://wiki.osdev.org/)
- [RISC-V Privileged Specification](https://riscv.org/technical/specifications/)

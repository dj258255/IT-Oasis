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

*부팅부터 유저공간 셸까지 — 이 연재(4편)에서 바닥부터 만드는 것.*

## 들어가며

운영체제가 안에서 어떻게 도는지 제대로 알고 싶어서, **C로 바닥부터 커널을 만들기로** 했어요.
타겟은 RISC-V(rv64), 에뮬레이터는 QEMU의 `virt` 머신, 참고서는 [xv6(MIT 6.S081)](https://pdos.csail.mit.edu/6.828/2023/xv6.html)예요.

> 왜 C/RISC-V인가: 커널의 정석 언어는 C이고(리눅스·xv6·BSD 전부 C), 참고서 xv6도 C/RISC-V라 코드가 1:1로 매핑돼 마찰이 가장 적어요. RISC-V는 ISA가 단순해 학습에 좋고, 맥(애플 실리콘)에서 `riscv64-elf-gcc`로 툴체인도 깔끔하게 잡혀요.

이번 글은 **부팅부터 페이징까지** — 커널의 골격을 세우는 과정이에요.
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

## 4. 물리 페이지 할당기

`Vec`이나 동적 자료구조의 토대는 **메모리 할당기**예요.
커널 끝(`end`)부터 RAM 끝(`PHYSTOP`)까지의 빈 메모리를 4KB 페이지로 쪼개 free list로 관리해요(xv6의 `kalloc`).

```c
// kalloc.c
void *kalloc(void) {
    struct run *r = freelist;
    if (r) { freelist = r->next; freecnt--; }
    return (void *)r;
}
```

```
hobby> mem
free pages: 32238  (~125 MB free)
```

128MB RAM 중 OpenSBI와 커널을 뺀 약 125MB가 페이지 단위로 잡혀요.

## 5. 페이징 (Sv39)

마지막.
**Sv39**는 39비트 가상주소를 3단계 페이지 테이블로 번역해요.
커널은 **식별 매핑(va == pa)** 으로 매핑해서, 페이징을 켜도 주소가 그대로 유지돼 실행이 끊기지 않아요.

```c
// vm.c — 커널 페이지 테이블 매핑
kvmmap(kpt, UART0,    UART0,    PGSIZE,  PTE_R|PTE_W);          // UART
kvmmap(kpt, PLIC,     PLIC,     0x400000,PTE_R|PTE_W);          // PLIC
kvmmap(kpt, KERNBASE, KERNBASE, etext-KERNBASE, PTE_R|PTE_X);   // 텍스트 R/X
kvmmap(kpt, etext,    etext,    PHYSTOP-etext,  PTE_R|PTE_W);   // 데이터 R/W
```

`walk()`로 3단계 테이블을 따라가며 PTE를 찾고, 중간 테이블이 없으면 `kalloc`으로 만들어요.
매핑이 끝나면 `satp` 레지스터에 페이지 테이블을 적재하고 `sfence.vma`로 TLB를 비워 페이징을 켜요.

```c
void kvminithart(void) {
    sfence_vma();
    w_satp(MAKE_SATP(kernel_pagetable));  // 페이징 ON
    sfence_vma();
}
```

```
[ok] paging enabled (Sv39 kernel page table)
hobby> mem
free pages: 32169  (~125 MB free)
```

페이징을 켠 뒤에도 셸·타이머·입출력이 전부 그대로 동작해요(주소를 그대로 매핑했으니까).
`mem`이 32238에서 32169로 줄어든 건, 페이지 테이블 구조에 약 69페이지를 썼기 때문이에요.

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

*From boot to a userspace shell — what this 4-part series builds from scratch.*

## Introduction

I wanted to really understand how an operating system works under the hood, so I decided to **build a kernel from scratch in C**.
The target is RISC-V (rv64), the emulator is QEMU's `virt` machine, and the reference is [xv6 (MIT 6.S081)](https://pdos.csail.mit.edu/6.828/2023/xv6.html).

> Why C/RISC-V: C is the canonical language for kernels (Linux, xv6, and BSD are all C), and since the xv6 reference is also C/RISC-V, the code maps 1:1 with the least friction. RISC-V has a simple ISA that's great for learning, and on a Mac (Apple Silicon) the toolchain sets up cleanly with `riscv64-elf-gcc`.

This post covers **from boot to paging** — building the skeleton of the kernel.
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

## 4. Physical page allocator

The foundation for a `Vec` or any dynamic data structure is the **memory allocator**.
The free memory from the end of the kernel (`end`) to the end of RAM (`PHYSTOP`) is split into 4KB pages and managed as a free list (xv6's `kalloc`).

```c
// kalloc.c
void *kalloc(void) {
    struct run *r = freelist;
    if (r) { freelist = r->next; freecnt--; }
    return (void *)r;
}
```

```
hobby> mem
free pages: 32238  (~125 MB free)
```

Of the 128MB of RAM, about 125MB remains after subtracting OpenSBI and the kernel, managed in page-sized units.

## 5. Paging (Sv39)

Last.
**Sv39** translates a 39-bit virtual address through a 3-level page table.
The kernel maps everything with **identity mapping (va == pa)**, so even after paging is turned on the addresses stay the same and execution doesn't break.

```c
// vm.c — 커널 페이지 테이블 매핑
kvmmap(kpt, UART0,    UART0,    PGSIZE,  PTE_R|PTE_W);          // UART
kvmmap(kpt, PLIC,     PLIC,     0x400000,PTE_R|PTE_W);          // PLIC
kvmmap(kpt, KERNBASE, KERNBASE, etext-KERNBASE, PTE_R|PTE_X);   // 텍스트 R/X
kvmmap(kpt, etext,    etext,    PHYSTOP-etext,  PTE_R|PTE_W);   // 데이터 R/W
```

`walk()` follows the 3-level table to find the PTE, and if an intermediate table is missing it creates one with `kalloc`.
Once mapping is done, the page table is loaded into the `satp` register and `sfence.vma` flushes the TLB to turn paging on.

```c
void kvminithart(void) {
    sfence_vma();
    w_satp(MAKE_SATP(kernel_pagetable));  // 페이징 ON
    sfence_vma();
}
```

```
[ok] paging enabled (Sv39 kernel page table)
hobby> mem
free pages: 32169  (~125 MB free)
```

Even after paging is enabled, the shell, timer, and I/O all keep working exactly as before (because the addresses are mapped identically).
The drop in `mem` from 32238 to 32169 is because about 69 pages went into the page table structure.

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

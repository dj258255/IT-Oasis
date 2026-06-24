---
title: '유저모드에서 프로세스까지'
titleEn: 'From User Mode to Processes'
description: 커널의 골격 위에 OS의 진짜 핵심을 올린다. 유저모드(U-mode) 진입과 시스템콜(ecall) 경계, 컨텍스트 스위치와 선점형 라운드로빈 스케줄러, 그리고 프로세스별 페이지 테이블로 주소공간을 격리한 유저 프로세스까지. 디버깅에서 만난 공유 CSR 문제와 SUM 비트 이야기도 함께 정리한다.
descriptionEn: "Building the real heart of an OS on top of the kernel skeleton — entering user mode (U-mode) and the system-call boundary via ecall, context switching with a preemptive round-robin scheduler, and user processes isolated by per-process page tables. Plus two debugging lessons: the shared-CSR trap-frame problem and the SUM bit."
date: 2026-06-24T00:00:00.000Z
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
seriesOrder: 2
---


## 들어가며

[1편](/blog/hobby/hobby-kernel-00-boot-to-paging)에서 커널의 **골격**을 세웠어요 — 부팅, UART 출력, 트랩/타이머, 키보드+셸, 페이지 할당기, Sv39 페이징. 그런데 거기까진 **모든 코드가 커널 권한(S-mode)에서** 돌아요. 운영체제를 운영체제답게 만드는 건, "권한이 낮은 유저 프로그램이 커널에 일을 부탁한다"는 **경계**예요.

이번 글은 그 경계를 만들고, 그 위에 **프로세스**를 올리는 과정이에요. 셋으로 나뉘어요.

1. **유저모드 + 시스템콜** — U-mode로 내려가서 `ecall`로 커널을 부른다
2. **프로세스 + 선점형 스케줄러** — 컨텍스트 스위치로 여러 실행 흐름을 번갈아 돌린다
3. **유저 프로세스** — 프로세스마다 페이지 테이블을 줘서 주소공간을 격리한다

마지막엔 이걸 만들며 디버깅에서 배운 두 가지(공유 CSR, SUM 비트)를 정리해요. 솔직히 이 두 버그가 이번 단계에서 제일 많이 배운 부분이에요.

> 참고서는 여전히 [xv6(MIT 6.S081)](https://pdos.csail.mit.edu/6.828/2023/xv6.html). 다만 트램폴린/프로세스별 트랩프레임 같은 정석 구조는 한 번에 다 넣지 않고, 동작하는 가장 단순한 길로 먼저 갔어요(아래서 그 대가도 만나요).

## 1. 유저모드 + 시스템콜

RISC-V는 권한 레벨이 M(머신) > S(슈퍼바이저) > U(유저)예요. 커널은 S-mode, 유저 프로그램은 U-mode에서 돌아요. U-mode는 CSR도 못 만지고 장치 메모리도 못 건드려요. 그럼 화면 출력 같은 건 어떻게 하냐 — **커널에 부탁**해요. 그게 시스템콜이고, RISC-V에선 `ecall` 명령으로 트랩을 일으켜요.

유저 프로그램은 이렇게 생겼어요. 인자를 레지스터(`a7`=콜 번호, `a0`=인자)에 넣고 `ecall`.

```asm
li a7, 1      # SYS_putchar
li a0, 85     # 'U'
ecall         # 커널아, 이 글자 좀 찍어줘
```

`ecall`을 U-mode에서 하면 `scause`가 8(U-mode ecall)인 트랩이 나요. 1편에서 만든 트랩 핸들러에 한 갈래만 추가하면 돼요.

```c
// trap.c
} else if (cause == SCAUSE_U_ECALL) {
    syscall(f);        // a7로 분기해서 처리(아래)
    f->sepc += 4;      // ecall(4바이트) 다음 명령으로 복귀
}
```

```c
// user.c — 시스템콜 디스패치
void syscall(struct regframe *f) {
    switch (f->a7) {
    case SYS_putchar: uart_putc((char)f->a0); break;  // 유저가 부탁한 글자 출력
    case SYS_print:   uart_puts("Hello from user mode!\n"); break;
    // ...
    }
}
```

U-mode로 "내려가는" 건 `sret` 한 방이에요. `sstatus`의 비트를 세팅하고(이 부분이 나중에 사고를 칩니다), 복귀 주소(`sepc`)를 유저 진입점으로 두고 `sret`하면 CPU가 U-mode로 떨어져요.

```c
s &= ~SSTATUS_SPP;   // SPP=0 → sret 시 U-mode로
s |= SSTATUS_SPIE;   // U-mode에서 인터럽트 enable
w_sepc(USERVA);      // 유저 진입점
// ... sret
```

```
[kernel] entering user mode (U-mode)...
Hello from user mode! (printed by the kernel, requested via ecall)
```

U-mode에서 도는 프로그램이 `ecall`로 부탁하고 커널이 처리한 거예요. 별것 아닌 한 줄 같지만, **권한 경계를 처음 넘은 순간**이라 의미가 커요.

## 2. 프로세스 + 선점형 스케줄러

하나의 프로그램만 도는 건 아직 OS가 아니에요. **여러 실행 흐름을 번갈아** 돌려야죠. 핵심은 **컨텍스트 스위치** — 지금 흐름의 레지스터를 저장하고, 다른 흐름의 레지스터를 복원하는 거예요.

저장할 건 callee-saved 레지스터 + `ra`(복귀 주소) + `sp`(스택)뿐이에요. 어셈블리 14줄.

```asm
# swtch.S — void swtch(struct context *old, struct context *new)
swtch:
    sd ra, 0(a0)        # 현재 흐름 저장
    sd sp, 8(a0)
    sd s0, 16(a0)       # ... s1~s11
    ld ra, 0(a1)        # 새 흐름 복원
    ld sp, 8(a1)
    ld s0, 16(a1)       # ...
    ret                 # ra(=새 흐름)로 점프 → 갈아탔다
```

`ret`이 새 흐름의 `ra`로 점프하는 게 마법이에요. 함수를 호출했는데 **다른 실행 흐름에서 깨어나요**.

스케줄러는 실행 가능한(`RUNNABLE`) 프로세스를 골라 `swtch`로 진입시키고, 그 프로세스가 양보(`yield`)하면 돌아와서 다음 프로세스를 골라요(라운드로빈).

```c
void scheduler(void) {
    for (;;)
        for (each proc p)
            if (p->state == RUNNABLE) {
                p->state = RUNNING; cur = p;
                swtch(&sched_context, &p->context);  // p 실행 → yield 시 복귀
            }
}
```

"선점형"의 핵심은 **타이머**예요. 프로세스가 자발적으로 양보하지 않아도, 타이머 인터럽트가 강제로 `yield`를 불러 다음 프로세스로 넘겨요. 1편에서 만든 타이머에 한 줄만 더하면 돼요.

```c
// trap.c — 타이머 인터럽트
ticks++;
w_stimecmp(r_time() + TIMER_INTERVAL);
if (current_proc()) yield();   // 실행 중인 프로세스를 강제로 양보(선점)
```

셸도 다시 살렸어요. 셸은 UART 인터럽트로 동작하니 어느 프로세스가 돌든 응답해요. 그리고 두 스레드가 진짜로 동시에 도는지 보려고 `ps` 명령을 추가했어요 — 각 스레드가 스핀하며 카운터를 올리는데, 타이머가 둘을 번갈아 선점하면 두 카운터가 함께 늘어나요.

```
hobby> ps
threads (preemptively scheduled):
  spinA: ticks=34888638
  spinB: ticks=31213595
hobby> ps                      (1.2초 후)
  spinA: ticks=64687087        +30M
  spinB: ticks=61305716        +30M
```

두 카운터가 1.2초 동안 각각 ~30M씩 늘었어요. **선점형 멀티태스킹**이 도는 거예요.

## 3. 유저 프로세스 = 격리된 주소공간

지금까지의 "프로세스"는 사실 커널 스레드(S-mode, 페이지 테이블 공유)였어요. 진짜 프로세스는 **자기만의 주소공간**을 가져요. 그래서 프로세스마다 **페이지 테이블**을 따로 줘요.

각 프로세스 페이지 테이블 = 커널 영역(식별 매핑) + 그 프로세스의 유저 코드/스택(`PTE_U`).

```c
// vm.c
pagetable_t proc_pagetable(uint64 ucode_pa, uint64 ustack_pa) {
    pagetable_t pt = kalloc_zeroed();
    map_kernel(pt);                                       // 커널을 모든 테이블에 식별 매핑
    mappages(pt, USERVA,    PGSIZE, ucode_pa,  PTE_R|PTE_X|PTE_U);
    mappages(pt, USERSTACK, PGSIZE, ustack_pa, PTE_R|PTE_W|PTE_U);
    return pt;
}
```

> **왜 커널을 모든 페이지 테이블에 매핑하나?** 트램폴린 없이 가는 단순화의 핵심이에요. U-mode에서 트랩이 나면 `satp`은 여전히 그 프로세스 테이블을 가리켜요. 그 안에 커널 코드(트랩 핸들러)가 같은 주소로 매핑돼 있어야, `satp`을 안 바꾸고도 핸들러가 그대로 실행돼요. xv6는 이걸 트램폴린 한 페이지로 우아하게 풀지만, 우린 "커널을 모든 테이블에 복제"하는 더 단순한 길을 택했어요.

스케줄러는 프로세스로 진입하기 직전에 `satp`을 그 프로세스 테이블로 바꿔, **주소공간까지 함께 전환**해요.

```c
switch_satp(p->pagetable);          // 이 프로세스 주소공간으로
swtch(&sched_context, &p->context); // 실행
switch_satp(kernel_pt());           // 복귀 후 커널 주소공간으로
```

커널 스레드와 유저 프로세스를 **같은 `swtch`로 통합**한 게 깔끔해요. 차이는 첫 진입점(`context.ra`)뿐 — 커널 스레드는 그냥 함수로, 유저 프로세스는 `sret`으로 U-mode에 떨어지는 함수로 들어가요.

데모는 커널 스레드 1개 + 유저 프로세스 1개를 함께 스케줄해요. 유저 프로세스는 인사 한 번 하고, 틱을 40번 세며 잠깐 일하다가, `SYS_exit`으로 종료돼요.

```
hobby> ps
threads (preemptively scheduled):
  spinK: ticks=22453788        ← 커널 스레드(S-mode)
  userP: ticks=9               ← 유저 프로세스(U-mode, 자체 페이지 테이블)
hobby> ps                      (1.5초 후)
  spinK: ticks=59812260
  userP: ticks=23              ← 카운터 증가 중
hobby> ps                      (4초 후)
  spinK: ticks=215041281
                               ← userP가 SYS_exit으로 종료 → 사라짐
```

격리된 주소공간을 가진 유저 프로세스가, 커널 스레드와 함께, 선점적으로 스케줄되고, 일을 마치면 깔끔히 사라져요. **작은 OS의 골격**이 섰어요.

## 4. 디버깅에서 배운 두 가지

3번은 한 번에 되지 않았어요. 유저 프로세스가 인사만 출력하고 **멈춰버렸어요**(폴트도 없이). 여기서 OS의 깊은 원리 두 개를 배웠어요.

### (1) CSR은 하나뿐이다 — 트랩 프레임에 저장하라

처음엔 트랩 진입점에서 일반 레지스터 31개만 저장하고 `sepc`(복귀 PC)·`sstatus`(모드 비트)는 안 저장했어요. **`sepc`/`sstatus`는 CSR 한 개**라서, 프로세스 A의 트랩 처리 도중 스케줄러가 프로세스 B로 넘어가 B가 또 트랩을 일으키면, A의 `sepc`가 B 값으로 덮여요. 그럼 A로 돌아올 때 엉뚱한 곳으로 `sret`해서 페이지 폴트가 나요.

커널 스레드만 있던 단계(2번)에선 이게 안 터졌어요 — 스레드들이 *같은 코드*를 돌아서 복귀 PC가 어디든 상관없었거든요(운이 좋았던 거예요). 그런데 U-mode 유저 프로세스와 S-mode 커널 스레드가 섞이니 바로 드러났어요.

해결은 **트랩 프레임에 `sepc`/`sstatus`도 함께 저장/복원**하는 것 — 트랩마다 자기 복귀 상태를 독립적으로 갖게요. 이게 사실 xv6 트랩프레임의 핵심이에요.

```asm
# kernelvec.S — 레지스터 저장 후
csrr t0, sepc
sd   t0, 240(sp)       # 복귀 PC도 프레임에 (트랩마다 독립 → 인터리빙 안전)
csrr t0, sstatus
sd   t0, 248(sp)       # 모드 비트도
```

### (2) SUM 비트 — 커널이 유저 페이지를 만질 권한

그래도 멈췄어요. 이번엔 **출력도, 폴트 메시지도 없는 완전한 hang**. 계측용으로 커널 스레드가 주기적으로 점(`.`)을 찍게 했더니, 점도 안 찍혔어요 — 스케줄러가 유저 프로세스에서 영영 못 빠져나오고 있었어요.

원인은 `SUM` 비트. 저는 단순화를 위해 **유저 프로세스의 트랩 핸들러를 유저 스택 위에서** 돌렸어요(별도 커널 스택 없이). 그런데 S-mode가 유저(U) 페이지에 접근하려면 `sstatus.SUM=1`이 필요해요. 그런데 (1)에서 `sstatus`를 트랩마다 저장/복원하게 만들었더니, SUM이 프로세스마다 달라졌어요. 커널 스레드가 SUM=0으로 돌다 멈추고, 스케줄러가 유저 프로세스의 트랩 핸들러(유저 스택에서 실행 중)를 재개하는 순간 SUM=0 → **유저 스택 접근이 폴트** → 그 폴트를 처리하려다 또 폴트 → 출력 없는 무한 재폴트(=hang)였어요.

해결은 **SUM을 부팅 때 켜고 항상 1로 유지**하는 것. 학습 커널이라 단순하게 갔어요(xv6는 별도 커널 스택과 `sscratch`로 더 정석으로 풀어요).

```c
// trap_init() — 한 번만
w_sstatus(r_sstatus() | SSTATUS_SUM);  // 커널이 항상 유저 페이지 접근 가능
```

두 줄짜리 수정이지만, 여기까지 오면서 트랩/CSR/권한의 상호작용을 손으로 만져보며 이해하게 됐어요. 책으로 읽을 땐 그냥 넘어갔던 부분이에요.

## 마치며

골격 위에 OS의 심장을 올렸어요.

- 유저모드(U-mode) + 시스템콜(`ecall`) 경계
- 컨텍스트 스위치 + 선점형 라운드로빈 스케줄러
- 프로세스별 페이지 테이블 = 주소공간 격리
- 프로세스 생명주기(`SYS_exit`)

이제 **여러 프로그램이 각자 격리된 주소공간에서, 선점적으로, 생성·종료되는** 작은 운영체제가 됐어요. 다음은 진짜 프로그램을 다루는 쪽 — **fork/exec + ELF 로더**(지금은 임베드된 프로그램), 그리고 **파일시스템**으로 가요.

> 코드: [github.com/dj258255/hobby-kernel](https://github.com/dj258255/hobby-kernel)
> 다음 글: **fork/exec + 파일시스템 (예정)**

### 참고 자료

- [xv6: a simple, Unix-like teaching operating system (MIT 6.S081)](https://pdos.csail.mit.edu/6.828/2023/xv6.html)
- [RISC-V Privileged Specification](https://riscv.org/technical/specifications/)
- [OSDev Wiki](https://wiki.osdev.org/)

<!-- EN -->

## Introduction

In [Part 1](/blog/hobby/hobby-kernel-00-boot-to-paging) I built the **skeleton** of the kernel — boot, UART output, traps/timer, keyboard + shell, page allocator, Sv39 paging. But up to that point, **every line of code runs with kernel privilege (S-mode)**. What actually makes an operating system an operating system is the **boundary**: "a low-privilege user program asks the kernel to do work on its behalf."

This post is about building that boundary and putting **processes** on top of it. It splits into three parts.

1. **User mode + system calls** — drop into U-mode and call the kernel via `ecall`
2. **Processes + a preemptive scheduler** — alternate between multiple execution flows via context switching
3. **User processes** — give each process its own page table to isolate its address space

At the end I'll go over the two things I learned from debugging while building this (shared CSRs, the SUM bit). Honestly, those two bugs were where I learned the most in this stage.

> The reference is still [xv6 (MIT 6.S081)](https://pdos.csail.mit.edu/6.828/2023/xv6.html). But rather than dropping in the textbook structures like a trampoline and per-process trap frames all at once, I took the simplest path that works first (and you'll see the price of that below).

## 1. User Mode + System Calls

On RISC-V the privilege levels are M (machine) > S (supervisor) > U (user). The kernel runs in S-mode, user programs run in U-mode. U-mode can't touch CSRs or device memory. So how does something like screen output happen? It **asks the kernel**. That's a system call, and on RISC-V you trigger a trap with the `ecall` instruction.

A user program looks like this. Put the arguments in registers (`a7` = call number, `a0` = argument) and `ecall`.

```asm
li a7, 1      # SYS_putchar
li a0, 85     # 'U'
ecall         # 커널아, 이 글자 좀 찍어줘
```

Doing `ecall` from U-mode raises a trap with `scause` = 8 (U-mode ecall). You only need to add one branch to the trap handler built in Part 1.

```c
// trap.c
} else if (cause == SCAUSE_U_ECALL) {
    syscall(f);        // a7로 분기해서 처리(아래)
    f->sepc += 4;      // ecall(4바이트) 다음 명령으로 복귀
}
```

```c
// user.c — 시스템콜 디스패치
void syscall(struct regframe *f) {
    switch (f->a7) {
    case SYS_putchar: uart_putc((char)f->a0); break;  // 유저가 부탁한 글자 출력
    case SYS_print:   uart_puts("Hello from user mode!\n"); break;
    // ...
    }
}
```

"Dropping" into U-mode is a single `sret`. Set the bits in `sstatus` (this part causes trouble later), put the return address (`sepc`) at the user entry point, and `sret` — the CPU falls into U-mode.

```c
s &= ~SSTATUS_SPP;   // SPP=0 → sret 시 U-mode로
s |= SSTATUS_SPIE;   // U-mode에서 인터럽트 enable
w_sepc(USERVA);      // 유저 진입점
// ... sret
```

```
[kernel] entering user mode (U-mode)...
Hello from user mode! (printed by the kernel, requested via ecall)
```

A program running in U-mode made a request via `ecall` and the kernel handled it. It may look like a trivial one-liner, but it matters: it's **the first time we crossed the privilege boundary**.

## 2. Processes + a Preemptive Scheduler

Running just one program isn't an OS yet. You need to **alternate between multiple execution flows**. The key is the **context switch** — saving the current flow's registers and restoring another flow's registers.

All you need to save are the callee-saved registers + `ra` (return address) + `sp` (stack). 14 lines of assembly.

```asm
# swtch.S — void swtch(struct context *old, struct context *new)
swtch:
    sd ra, 0(a0)        # 현재 흐름 저장
    sd sp, 8(a0)
    sd s0, 16(a0)       # ... s1~s11
    ld ra, 0(a1)        # 새 흐름 복원
    ld sp, 8(a1)
    ld s0, 16(a1)       # ...
    ret                 # ra(=새 흐름)로 점프 → 갈아탔다
```

The magic is `ret` jumping to the new flow's `ra`. You call a function, but **you wake up in a different execution flow**.

The scheduler picks a runnable (`RUNNABLE`) process, enters it via `swtch`, and when that process yields (`yield`), control returns and it picks the next process (round-robin).

```c
void scheduler(void) {
    for (;;)
        for (each proc p)
            if (p->state == RUNNABLE) {
                p->state = RUNNING; cur = p;
                swtch(&sched_context, &p->context);  // p 실행 → yield 시 복귀
            }
}
```

The heart of "preemptive" is the **timer**. Even if a process never yields voluntarily, the timer interrupt forces a `yield` and hands off to the next process. Just one more line on top of the timer built in Part 1.

```c
// trap.c — 타이머 인터럽트
ticks++;
w_stimecmp(r_time() + TIMER_INTERVAL);
if (current_proc()) yield();   // 실행 중인 프로세스를 강제로 양보(선점)
```

I brought the shell back too. The shell runs off UART interrupts, so it responds no matter which process is running. And to actually see two threads running concurrently, I added a `ps` command — each thread spins incrementing a counter, and when the timer preempts back and forth between them, both counters climb together.

```
hobby> ps
threads (preemptively scheduled):
  spinA: ticks=34888638
  spinB: ticks=31213595
hobby> ps                      (1.2초 후)
  spinA: ticks=64687087        +30M
  spinB: ticks=61305716        +30M
```

Over 1.2 seconds both counters grew by ~30M each. **Preemptive multitasking** is running.

## 3. User Processes = Isolated Address Spaces

The "processes" so far were really kernel threads (S-mode, sharing the same page table). A real process has **its own address space**. So we give each process a separate **page table**.

Each process's page table = the kernel region (identity mapping) + that process's user code/stack (`PTE_U`).

```c
// vm.c
pagetable_t proc_pagetable(uint64 ucode_pa, uint64 ustack_pa) {
    pagetable_t pt = kalloc_zeroed();
    map_kernel(pt);                                       // 커널을 모든 테이블에 식별 매핑
    mappages(pt, USERVA,    PGSIZE, ucode_pa,  PTE_R|PTE_X|PTE_U);
    mappages(pt, USERSTACK, PGSIZE, ustack_pa, PTE_R|PTE_W|PTE_U);
    return pt;
}
```

> **Why map the kernel into every page table?** It's the core of going without a trampoline. When a trap fires in U-mode, `satp` still points at that process's table. The kernel code (the trap handler) has to be mapped at the same address inside that table, so the handler runs as-is without changing `satp`. xv6 solves this elegantly with a single trampoline page, but we took the simpler path of "replicating the kernel into every table."

Right before entering a process, the scheduler switches `satp` to that process's table, **switching the address space along with it**.

```c
switch_satp(p->pagetable);          // 이 프로세스 주소공간으로
swtch(&sched_context, &p->context); // 실행
switch_satp(kernel_pt());           // 복귀 후 커널 주소공간으로
```

What's clean is that kernel threads and user processes are **unified under the same `swtch`**. The only difference is the initial entry point (`context.ra`) — a kernel thread enters as a plain function, while a user process enters a function that drops into U-mode via `sret`.

The demo schedules 1 kernel thread + 1 user process together. The user process greets once, counts 40 ticks while doing a bit of work, then terminates via `SYS_exit`.

```
hobby> ps
threads (preemptively scheduled):
  spinK: ticks=22453788        ← 커널 스레드(S-mode)
  userP: ticks=9               ← 유저 프로세스(U-mode, 자체 페이지 테이블)
hobby> ps                      (1.5초 후)
  spinK: ticks=59812260
  userP: ticks=23              ← 카운터 증가 중
hobby> ps                      (4초 후)
  spinK: ticks=215041281
                               ← userP가 SYS_exit으로 종료 → 사라짐
```

A user process with an isolated address space gets preemptively scheduled alongside a kernel thread, and cleanly disappears once it's done. The **skeleton of a small OS** is standing.

## 4. Two Things I Learned from Debugging

Part 3 didn't work on the first try. The user process only printed its greeting and then **froze** (with no fault). Here I learned two deep OS principles.

### (1) There's Only One CSR — Save It in the Trap Frame

At first, my trap entry point saved only the 31 general-purpose registers and didn't save `sepc` (the return PC) or `sstatus` (the mode bits). But **`sepc`/`sstatus` are a single CSR each**, so if the scheduler switches from process A to process B mid-way through A's trap handling and B raises another trap, A's `sepc` gets overwritten with B's value. Then when you return to A, you `sret` to the wrong place and a page fault occurs.

In the kernel-thread-only stage (Part 2) this never blew up — the threads ran *the same code*, so the return PC didn't matter wherever it pointed (we just got lucky). But once a U-mode user process and an S-mode kernel thread were mixed together, it surfaced immediately.

The fix is to **save/restore `sepc`/`sstatus` in the trap frame too**, so each trap holds its own return state independently. This is in fact the core of the xv6 trap frame.

```asm
# kernelvec.S — 레지스터 저장 후
csrr t0, sepc
sd   t0, 240(sp)       # 복귀 PC도 프레임에 (트랩마다 독립 → 인터리빙 안전)
csrr t0, sstatus
sd   t0, 248(sp)       # 모드 비트도
```

### (2) The SUM Bit — the Kernel's Permission to Touch User Pages

It still froze. This time it was a complete hang with **no output and no fault message**. When I made the kernel thread periodically print a dot (`.`) for instrumentation, even the dots stopped printing — the scheduler could never escape from the user process.

The cause was the `SUM` bit. For simplicity I ran **the user process's trap handler on the user stack** (with no separate kernel stack). But for S-mode to access a user (U) page, you need `sstatus.SUM=1`. And once I made `sstatus` save/restore per trap in (1), SUM started varying per process. The kernel thread would run with SUM=0 and stall, and the moment the scheduler resumed the user process's trap handler (running on the user stack), SUM=0 → **accessing the user stack faulted** → trying to handle that fault faulted again → an endless re-fault with no output (= hang).

The fix is to **turn SUM on at boot and always keep it 1**. Since this is a learning kernel I kept it simple (xv6 solves it more properly with a separate kernel stack and `sscratch`).

```c
// trap_init() — 한 번만
w_sstatus(r_sstatus() | SSTATUS_SUM);  // 커널이 항상 유저 페이지 접근 가능
```

It's a two-line fix, but getting here let me understand the interplay of traps/CSRs/permissions by working it out hands-on. It's the part I'd just skim past when reading a book.

## Closing

I put the heart of an OS on top of the skeleton.

- User mode (U-mode) + the system-call (`ecall`) boundary
- Context switching + a preemptive round-robin scheduler
- Per-process page tables = address-space isolation
- The process lifecycle (`SYS_exit`)

Now it's a small operating system where **multiple programs are created and terminated, preemptively, each in its own isolated address space**. Next up is the side that deals with real programs — **fork/exec + an ELF loader** (right now the programs are embedded), and then a **filesystem**.

> Code: [github.com/dj258255/hobby-kernel](https://github.com/dj258255/hobby-kernel)
> Next post: **fork/exec + filesystem (coming soon)**

### References

- [xv6: a simple, Unix-like teaching operating system (MIT 6.S081)](https://pdos.csail.mit.edu/6.828/2023/xv6.html)
- [RISC-V Privileged Specification](https://riscv.org/technical/specifications/)
- [OSDev Wiki](https://wiki.osdev.org/)

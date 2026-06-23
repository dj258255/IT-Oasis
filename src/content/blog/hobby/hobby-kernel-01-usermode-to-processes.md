---
title: 'C로 만드는 RISC-V 토이 커널 — 유저모드에서 프로세스까지'
titleEn: 'A RISC-V Toy Kernel in C — From User Mode to Processes'
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
category: OS-취미
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

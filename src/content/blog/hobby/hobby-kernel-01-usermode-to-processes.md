---
title: '유저모드에서 프로세스까지'
titleEn: 'From User Mode to Processes'
description: 커널의 골격 위에 OS의 진짜 핵심을 올린다. 유저모드(U-mode) 진입과 시스템콜(ecall) 경계, 컨텍스트 스위치와 선점형 라운드로빈 스케줄러, 그리고 프로세스별 페이지 테이블로 주소공간을 격리한 유저 프로세스까지. 디버깅에서 만난 공유 CSR 문제와 SUM 비트 이야기도 함께 정리한다.
descriptionEn: "Building the real heart of an OS on top of the kernel skeleton — entering user mode (U-mode) and the system-call boundary via ecall, context switching with a preemptive round-robin scheduler, and user processes isolated by per-process page tables. Plus two debugging lessons: the shared-CSR trap-frame problem and the SUM bit."
date: 2026-06-04T00:00:00.000Z
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

[1편](/blog/hobby/hobby-kernel-00-boot-to-paging)에서 커널의 **골격**을 세웠어요 — 부팅, UART 출력, 트랩/타이머, 키보드+셸, 페이지 할당기, Sv39 페이징.
그런데 거기까진 **모든 코드가 커널 권한(S-mode)에서** 돌아요.
운영체제를 운영체제답게 만드는 건, "권한이 낮은 유저 프로그램이 커널에 일을 부탁한다"는 **경계**예요.

이번 글은 그 경계를 만들고, 그 위에 **프로세스**를 올리는 과정이에요.
셋으로 나뉘어요.

1. **유저모드 + 시스템콜** — U-mode로 내려가서 `ecall`로 커널을 부른다
2. **프로세스 + 선점형 스케줄러** — 컨텍스트 스위치로 여러 실행 흐름을 번갈아 돌린다
3. **유저 프로세스** — 프로세스마다 페이지 테이블을 줘서 주소공간을 격리한다

마지막엔 이걸 만들며 디버깅에서 배운 두 가지(공유 CSR, SUM 비트)를 정리해요.
솔직히 이 두 버그가 이번 단계에서 제일 많이 배운 부분이에요.

> 참고서는 여전히 [xv6(MIT 6.S081)](https://pdos.csail.mit.edu/6.828/2023/xv6.html). 다만 트램폴린/프로세스별 트랩프레임 같은 정석 구조는 한 번에 다 넣지 않고, 동작하는 가장 단순한 길로 먼저 갔어요(아래서 그 대가도 만나요).

## 1. 유저모드 + 시스템콜

### 왜 유저모드가 필요할까

RISC-V는 권한 레벨이 M(머신) > S(슈퍼바이저) > U(유저) 셋이에요.
지금까지 우리 커널은 **전부 S-mode**에서 돌았어요 — 셸도, 타이머도, 페이지 할당기도요.
S-mode는 사실상 못 하는 게 없어요.
CSR을 마음껏 읽고 쓰고, 장치 메모리(UART·PLIC)에 직접 접근하고, 페이지 테이블도 갈아끼워요.

문제는 "프로그램"을 이 권한으로 돌리면 곤란하다는 거예요.
유저가 짠 프로그램에 버그가 하나 있어서 엉뚱한 주소에 쓰기라도 하면, 커널 자체가 무너져요.
그래서 OS는 유저 프로그램을 **권한이 가장 낮은 U-mode**에 가둬요.
U-mode는 CSR도 못 만지고, 장치 메모리도 못 건드리고, `PTE_U`가 안 달린 페이지(=커널 페이지)엔 접근만 해도 폴트가 나요.

그럼 화면 출력 같은 진짜 일은 어떻게 하냐 — **커널에 부탁**해요.
이게 시스템콜이에요.
비유하자면 U-mode 프로그램은 손님이고 커널은 주방이에요.
손님이 직접 주방에 들어가 불을 만질 순 없으니, 주문서를 적어 종업원에게 건네는 거죠.
RISC-V에서 그 "주문"이 `ecall`(environment call) 명령이에요.

### 메커니즘 — ecall이 일으키는 트랩

유저가 커널에 뭘 부탁하려면, 약속된 자리에 인자를 놓아야 해요.
우리는 xv6처럼 **`a7`에 콜 번호, `a0`부터 인자**를 두기로 했어요.

```asm
li a7, 1      # a7 = SYS_putchar (콜 번호)
li a0, 85     # a0 = 'U' (인자)
ecall         # "커널아, 이 글자 좀 찍어줘"
```

`ecall`을 U-mode에서 실행하면 CPU가 **트랩**을 일으켜요.
1편에서 본 그 트랩 메커니즘 그대로예요 — `stvec`이 가리키는 핸들러(`kernelvec`)로 점프하고, S-mode로 올라가요.
다만 이번엔 `scause`가 **8(Environment call from U-mode)** 로 들어와요.
그래서 1편에서 만든 트랩 핸들러에 갈래 하나만 더 달면 끝이에요.

```c
// trap.c — kerneltrap()
} else if (cause == SCAUSE_U_ECALL) {
    // 유저 프로그램이 ecall로 커널에 '부탁'한 것 = 시스템콜.
    syscall(f);
    f->sepc += 4;  // ecall(4바이트) '다음' 명령으로 복귀
}
```

여기서 `f->sepc += 4`가 중요해요.
`sepc`엔 트랩을 일으킨 `ecall` 명령 **자기 자신의 주소**가 들어 있어요.
그대로 복귀하면 같은 `ecall`을 또 실행해서 무한 루프에 빠져요.
RISC-V 명령은 4바이트니까, `sepc`에 4를 더해 **그 다음 명령**으로 복귀시켜요.
(그런데 왜 `f->sepc`지 `w_sepc()`가 아닐까요? 그 이유가 4절의 첫 번째 디버깅 이야기예요.)

콜 번호로 분기하는 디스패처는 `user.c`에 있어요.
실제 코드는 시스템콜이 17개나 되지만(`fork`/`exec`/`read`/`mmap`/`tcp`...), 골격만 보면 이래요.

```c
// user.c — 시스템콜 디스패치 (커널 측)
void syscall(struct regframe *f) {
    switch (f->a7) {                      // a7 = 콜 번호로 분기
    case SYS_putchar:
        uart_putc((char)f->a0);           // a0 = 유저가 부탁한 글자
        f->a0 = 0;                        // 반환값을 프레임의 a0에 써둔다
        break;
    case SYS_print:
        uart_puts("...hello from user...\n");
        f->a0 = 0;
        break;
    // SYS_fork / SYS_exec / SYS_read / ...
    }
}
```

눈여겨볼 건 **반환값을 `f->a0`에 쓴다**는 점이에요.
`f`는 트랩 프레임 — 트랩 진입할 때 유저의 레지스터를 통째로 저장해 둔 사본이에요.
여기 `a0`을 고쳐두면, 트랩에서 복귀할 때 그 값이 유저의 `a0` 레지스터로 복원돼요.
유저 입장에선 "`ecall` 했더니 `a0`에 결과가 들어와 있다" — 딱 함수 호출처럼 보이는 거죠.

### 우리 코드는 — sret 한 방으로 U-mode 진입

부탁을 받는 길은 만들었으니, 이제 **유저 프로그램을 U-mode로 처음 내려보내는** 길이 필요해요.
이건 의외로 단순해요 — `sret` 명령 하나면 돼요.

`sret`은 원래 "트랩에서 복귀" 명령이에요.
CPU는 `sret`을 보면 `sstatus.SPP` 비트를 보고 "트랩 직전에 어느 모드였지?"를 판단해, 그 모드로 돌아가요.
그래서 우리가 **마치 U-mode에서 트랩이 났던 것처럼 상태를 꾸며두고** `sret`하면, CPU는 군말 없이 U-mode로 "복귀"해요.
실제로는 한 번도 U-mode에 있던 적이 없는데 말이죠.

우리 코드에선 `enter_user()`가 그 일을 해요.

```c
// proc.c — 유저 프로세스가 처음 실행될 때 거치는 래퍼
static void enter_user(void) {
    release(&pt_lock);       // 스케줄러가 잡은 락을 놓는다(첫 실행)
    uint64 s = r_sstatus();
    s &= ~SSTATUS_SPP;       // SPP=0 → sret 시 U-mode로 떨어진다
    s |= SSTATUS_SPIE;       // U-mode에서 인터럽트 enable(= 선점 가능)
    s |= SSTATUS_SUM;        // 커널이 유저 페이지 접근 가능(4절에서 다시 만남)
    w_sstatus(s);
    w_sepc(USERVA);          // 복귀 주소 = 유저 진입점
    // sp를 유저 스택 top으로 잡고 sret. 돌아오지 않는다.
    asm volatile("mv sp, %0\n sret\n" :: "r"((uint64)USERSTACKTOP));
}
```

`SPP=0`이 "직전이 U-mode였다"는 거짓말이고, `SPIE`가 "U-mode에선 인터럽트를 켜라"(이게 있어야 타이머가 유저를 선점해요), `sepc=USERVA`가 "여기로 복귀하라"예요.
`sret`을 때리면 CPU는 권한을 U-mode로 낮추고 `USERVA`로 점프해요 — 유저 프로그램의 첫 명령이 거기 있죠.

```
[kernel] entering user mode (U-mode)...
Hello from user mode! (printed by the kernel, requested via ecall)
```

U-mode로 떨어진 프로그램이 `ecall`로 부탁하고, 커널이 받아서 처리한 거예요.
별것 아닌 한 줄 같지만, **권한 경계를 처음 넘은 순간**이라 의미가 커요.
지금까지 한 덩어리였던 "커널"이, 비로소 "커널"과 "그 위에서 도는 프로그램"으로 갈라진 거니까요.

## 2. 프로세스 + 선점형 스케줄러

### 왜 컨텍스트 스위치가 필요할까

하나의 프로그램만 도는 건 아직 OS가 아니에요.
운영체제다움은 **여러 실행 흐름을 번갈아** 돌리는 데서 와요 — 셸이 입력을 기다리는 동안 다른 프로그램이 계산을 돌리고, 그게 또 멈추면 세 번째가 끼어들고.
CPU 코어는 하나(혹은 몇 개)뿐인데 실행 흐름은 여럿이니, 비결은 **빠르게 번갈아 태우는** 거예요.

그러려면 흐름을 멈췄다 **나중에 정확히 그 자리에서** 다시 시작할 수 있어야 해요.
실행 흐름의 "현재 상태"는 결국 **레지스터들**에 다 들어 있어요 — 지금 어느 함수의 어디까지 왔는지(`ra`), 스택은 어디인지(`sp`), 계산 중이던 값들(`s0`~`s11`).
그래서 컨텍스트 스위치는 **지금 흐름의 레지스터를 어딘가 저장하고, 다른 흐름의 레지스터를 복원하는** 게 전부예요.
저장해 둔 레지스터 묶음을 우리는 `struct context`라 부르고, 프로세스마다 하나씩 갖고 있어요.

### 메커니즘 — swtch가 저장하는 건 14개뿐

그런데 레지스터가 31개나 되는데, 전부 저장할 필요는 없어요.
`swtch`는 **평범한 C 함수처럼** 호출되거든요.
C 호출 규약(calling convention)상, 함수를 호출하면 `a0`~`a7`이나 `t0`~`t6` 같은 caller-saved 레지스터는 호출한 쪽이 이미 알아서 스택에 대피시켜요.
그러니 `swtch`가 따로 챙길 건 **callee-saved 레지스터(`s0`~`s11`) + `ra`(복귀 주소) + `sp`(스택 포인터)** — 딱 14개예요.

```asm
# swtch.S — void swtch(struct context *old, struct context *new)
#   a0 = old(저장할 곳), a1 = new(복원할 곳)
swtch:
        sd  ra,   0(a0)     # 현재 흐름의 ra/sp/s0~s11을 old에 저장
        sd  sp,   8(a0)
        sd  s0,  16(a0)
        sd  s1,  24(a0)
        # ... s2 ~ s11 (offset 32 ~ 104) ...
        sd  s11,104(a0)

        ld  ra,   0(a1)     # 새 흐름의 값을 new에서 복원
        ld  sp,   8(a1)
        ld  s0,  16(a1)
        # ... s1 ~ s11 ...
        ld  s11,104(a1)

        ret                 # ra(=새 흐름의 복귀 주소)로 점프 → 갈아탔다
```

마법은 마지막 `ret`이에요.
`ret`은 "`ra`가 가리키는 곳으로 돌아가라"는 명령인데, 방금 `ra`를 **새 흐름의 값**으로 덮어썼잖아요.
그래서 `swtch`라는 함수를 호출했는데, 정작 **return은 전혀 다른 실행 흐름에서 나와요**.
A가 `swtch`를 부르면 함수가 "안 돌아오고", 한참 뒤 B가 양보하며 `swtch`를 부르는 순간 비로소 A의 `swtch`가 return하는 거예요.
한 함수 호출의 입구와 출구가 서로 다른 스레드에 걸쳐 있는 셈이죠.

### 우리 코드는 — 스케줄러와 yield의 핑퐁

스케줄러는 단순해요.
프로세스 테이블을 돌며 실행 가능한(`RUNNABLE`) 프로세스를 찾으면, `RUNNING`으로 바꾸고 `swtch`로 그 안에 진입해요.
그 프로세스가 양보(`yield`)하면 `swtch`가 return하면서 스케줄러로 돌아오고, 다음 프로세스를 찾아 또 진입하죠(라운드로빈).

```c
// proc.c — 스케줄러 (각 코어가 무한 루프)
void scheduler(void) {
    int id = r_tp();                          // 이 코어 번호
    for (;;) {
        acquire(&pt_lock);
        for (int i = 0; i < NPROC; i++) {
            struct proc *p = &proctable[i];
            if (p->state == RUNNABLE) {
                p->state = RUNNING;
                cpu_proc[id] = p;
                switch_satp(p->pagetable);             // 주소공간 전환(3절)
                swtch(&cpu_sched[id], &p->context);    // p 실행 → 양보 시 복귀
                switch_satp(kernel_pt());              // 복귀 후 커널 주소공간으로
                cpu_proc[id] = 0;
            }
        }
        release(&pt_lock);
    }
}
```

반대편엔 `yield()`가 있어요 — 프로세스가 CPU를 스케줄러에 돌려주는 함수예요.
스케줄러의 `swtch`와 `yield`의 `swtch`가 **서로의 `ra`로 핑퐁**하면서 두 흐름이 번갈아 깨어나는 구조예요.

```c
// proc.c — 현재 proc이 CPU를 스케줄러에 양보
void yield(void) {
    int id = r_tp();
    struct proc *p = cpu_proc[id];
    acquire(&pt_lock);
    if (p->state == RUNNING)
        p->state = RUNNABLE;                  // 다시 스케줄될 수 있게
    swtch(&p->context, &cpu_sched[id]);       // 스케줄러로 → 나중에 여기로 복귀
    release(&pt_lock);
}
```

> `pt_lock`을 `swtch`를 가로질러 들고 다니는 게 보일 거예요 — 스케줄러가 락을 든 채로 프로세스에 진입하고, 프로세스는 첫 실행 시 `thread_start`/`enter_user`에서 그 락을 놓아요(`release(&pt_lock)`). 일종의 **바통 넘기기**예요. 멀티코어(`NCPU`)에서 프로세스 테이블이 동시에 망가지지 않게 지키는 장치인데, 자세한 건 멀티코어 편에서 다뤄요.

### 선점 — 타이머가 강제로 양보시킨다

여기까지는 프로세스가 **자발적으로** `yield`를 불러야 전환돼요(협력형, cooperative).
그런데 무한 루프를 도는 프로그램은 영영 양보를 안 하겠죠.
그래서 진짜 OS는 **선점(preemption)** — 양보를 안 해도 강제로 빼앗는 — 을 해요.
열쇠는 **타이머 인터럽트**예요.

1편에서 만든 주기 타이머에 딱 한 줄만 더하면 선점형이 돼요.
타이머가 울릴 때마다, 지금 프로세스가 돌고 있으면 대신 `yield()`를 불러주는 거예요.

```c
// trap.c — 타이머 인터럽트 처리
ticks++;
w_stimecmp(r_time() + TIMER_INTERVAL);    // 다음 타이머 예약
if (current_proc())
    yield();   // 실행 중인 스레드를 스케줄러에 강제 양보(= 선점)
```

프로세스 입장에선 자기가 잘 돌다가 어느 순간 멈췄고, 한참 뒤 아무 일 없었다는 듯 그 자리에서 재개돼요.
그 "한참" 사이에 다른 프로세스가 타이머 몫만큼 돌았던 거죠 — 본인은 전혀 몰라요.
이게 멀티태스킹의 환상이에요.

셸도 다시 살렸어요.
셸은 UART 인터럽트로 동작하니 어느 프로세스가 돌든 키 입력에 응답해요.
그리고 두 스레드가 진짜로 번갈아 도는지 눈으로 보려고 `ps` 명령을 추가했어요 — 각 스레드가 스핀하며 카운터를 올리는데, 타이머가 둘을 번갈아 선점하면 두 카운터가 **함께** 늘어나요.

```
hobby> ps
threads (preemptively scheduled):
  spinA: ticks=34888638
  spinB: ticks=31213595
hobby> ps                      (1.2초 후)
  spinA: ticks=64687087        +30M
  spinB: ticks=61305716        +30M
```

두 카운터가 1.2초 동안 각각 ~30M씩 늘었어요.
한쪽만 도는 게 아니라 **둘 다** 비슷하게 자라는 게 핵심이에요 — 타이머가 공평하게 번갈아 태우고 있다는 증거죠.
**선점형 멀티태스킹**이 도는 거예요.

## 3. 유저 프로세스 = 격리된 주소공간

### 왜 페이지 테이블을 프로세스마다 주나

2절의 "프로세스"는 사실 **커널 스레드**였어요 — S-mode에서 돌고, 페이지 테이블도 다 같이 공유했죠.
같은 주소공간을 보니까 서로의 메모리를 마음껏 덮어쓸 수 있어요.
이건 진짜 프로세스가 아니에요.

진짜 프로세스의 핵심은 **격리**예요.
1편 5절에서 가상메모리를 만들 때 약속했던 "프로세스마다 다른 번역 표"가 바로 여기서 실현돼요.
프로세스 A의 `0x1000`과 B의 `0x1000`이 서로 다른 물리 페이지로 번역되면, 둘은 같은 주소를 써도 안 부딪히고 서로를 망가뜨릴 수도 없어요.
그러려면 **프로세스마다 페이지 테이블을 따로** 줘야 해요.

### 우리 코드는 — proc_pagetable

각 프로세스의 페이지 테이블은 두 부분으로 이뤄져요.
**커널 영역(식별 매핑)** + **그 프로세스만의 유저 코드·스택**(`PTE_U` 달림)이에요.

```c
// vm.c — 프로세스별 페이지 테이블
pagetable_t proc_pagetable(uint64 ucode_pa, uint64 ustack_pa) {
    pagetable_t pt = (pagetable_t)kalloc();
    memset(pt, 0, PGSIZE);
    map_kernel(pt);                                              // 커널을 이 테이블에도 식별 매핑
    mappages(pt, USERVA,    PGSIZE, ucode_pa,  PTE_R|PTE_X|PTE_U); // 코드: 읽기·실행, 유저 접근
    mappages(pt, USERSTACK, PGSIZE, ustack_pa, PTE_R|PTE_W|PTE_U); // 스택: 읽기·쓰기, 유저 접근
    return pt;
}
```

코드 페이지는 `R|X`(읽기·실행, 쓰기 금지), 스택은 `R|W`(읽기·쓰기, 실행 금지)예요 — 1편에서 본 권한 비트가 여기서 보호 역할을 해요.
그리고 둘 다 `PTE_U`가 붙어 있어요.
이게 있어야 U-mode 프로그램이 이 페이지에 접근할 수 있어요(커널 페이지엔 `PTE_U`가 없으니 유저가 건드리면 폴트).

> **왜 커널을 모든 페이지 테이블에 매핑하나?** 이게 우리 단순화의 핵심이에요. U-mode에서 트랩(`ecall`·타이머)이 나는 순간엔 `satp`이 **여전히 그 프로세스 테이블**을 가리켜요. 그런데 트랩 핸들러(`kernelvec`)도 결국 메모리에 있는 코드라, 그 주소가 지금 페이지 테이블에 매핑돼 있어야 실행이 돼요. 그래서 모든 프로세스 테이블에 커널을 **같은 주소(식별 매핑)** 로 복제해 둬요 — 그러면 `satp`을 바꾸지 않고도 핸들러가 그대로 돌아가요. xv6는 이걸 **트램폴린** 한 페이지로 우아하게 풀지만(커널 전체가 아니라 진입 코드 한 장만 양쪽에 매핑), 우린 학습용이라 "커널을 통째로 복제"하는 더 단순한 길을 택했어요. 대신 페이지 테이블마다 커널 매핑이 들어가니 메모리를 좀 더 써요.

### 주소공간까지 함께 전환 — switch_satp

페이지 테이블을 따로 줬으면, 프로세스를 바꿀 때 **어느 테이블을 쓸지도 바꿔야** 해요.
그게 `satp` 레지스터예요(1편에서 페이징을 켰던 그 레지스터).
스케줄러가 프로세스에 진입하기 직전에 `satp`을 그 프로세스 테이블로 바꾸고, 양보받아 돌아오면 다시 커널 테이블로 되돌려요.

```c
// proc.c — scheduler() 안
switch_satp(p->pagetable);             // 이 프로세스 주소공간으로 (satp 교체 + TLB flush)
swtch(&cpu_sched[id], &p->context);    // 실행 → 양보 시 복귀
switch_satp(kernel_pt());              // 복귀 후 커널 주소공간으로
```

```c
// vm.c
void switch_satp(pagetable_t pt) {
    w_satp(MAKE_SATP(pt));   // satp에 새 페이지 테이블의 물리주소
    sfence_vma();            // TLB(옛 번역 캐시) flush
}
```

`sfence_vma()`를 잊으면 안 돼요 — 주소 번역을 통째로 갈아끼웠으니, CPU가 캐시해 둔 옛 번역(TLB)을 비워야 새 테이블이 진짜로 적용돼요.

### 커널 스레드와 유저 프로세스를 같은 swtch로

여기서 우리 설계의 깔끔한 점이 드러나요.
커널 스레드든 유저 프로세스든 **똑같은 `swtch`로 진입**해요.
차이는 단 하나, **첫 진입점(`context.ra`)** 뿐이에요.

```c
// proc.c — make_thread(): 커널 스레드
p->context.ra = (uint64)thread_start;  // 첫 swtch는 그냥 함수로 진입

// proc.c — make_user_proc(): 유저 프로세스
p->context.ra = (uint64)enter_user;    // 첫 swtch는 U-mode로 떨어지는 함수로
```

스케줄러가 처음 이 프로세스에 `swtch`로 들어가면, `ret`이 `context.ra`로 점프해요.
커널 스레드면 `thread_start`(락 놓고 본체 함수 호출), 유저 프로세스면 `enter_user`(1절의 그 `sret`으로 U-mode 진입)로 가는 거죠.
한쪽은 그냥 S-mode 함수로 계속 돌고, 다른 쪽은 U-mode로 떨어져 유저 프로그램이 돼요 — **같은 메커니즘에 진입점만 다른** 거예요.

### 한 장으로 정리

- **커널 스레드** = S-mode 함수 + 자기 커널 스택. 페이지 테이블은 커널 것 공유. 진입점 `thread_start`.
- **유저 프로세스** = 자체 페이지 테이블(격리된 주소공간) + 유저 코드/스택(`PTE_U`) + 커널 스택. 진입점 `enter_user`(`sret`로 U-mode).
- **전환** = `switch_satp`(주소공간) + `swtch`(레지스터). 둘이 한 쌍.
- **공통점** = 둘 다 같은 `swtch`로 진입. 차이는 `context.ra` 하나.

데모는 커널 스레드 1개 + 유저 프로세스 1개를 함께 스케줄해요.
유저 프로세스는 인사 한 번 하고, 틱을 40번 세며 잠깐 일하다가, `SYS_exit`으로 종료돼요.

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

격리된 주소공간을 가진 유저 프로세스가, 커널 스레드와 함께, 선점적으로 스케줄되고, 일을 마치면 깔끔히 사라져요.
**작은 OS의 골격**이 섰어요.

## 4. 디버깅에서 배운 두 가지

3번은 한 번에 되지 않았어요.
유저 프로세스가 인사만 출력하고 **멈춰버렸어요**(폴트도 없이).
여기서 OS의 깊은 원리 두 개를 배웠어요.

### (1) CSR은 코어에 하나뿐이다 — 트랩 프레임에 저장하라

처음 트랩 진입점은 일반 레지스터 31개만 스택에 저장했어요.
복귀 PC인 `sepc`와 모드 비트인 `sstatus`는 **CSR이니 알아서 잘 있겠지** 하고 안 건드렸죠.
그런데 여기에 함정이 있어요 — **`sepc`/`sstatus`는 코어마다 딱 한 개씩 있는 레지스터**예요.

이게 왜 문제냐면, 트랩 처리 도중에 또 전환이 일어나거든요.
프로세스 A가 트랩에 들어와 처리하던 중에 타이머가 울려 `yield`로 B에 넘어가고, B가 또 트랩(`ecall`이든 타이머든)을 일으키면, 그 **하나뿐인 `sepc`가 B의 값으로 덮여요**.
나중에 A로 돌아와 `sret`하면, A는 자기 복귀 주소가 아니라 B가 남긴 주소로 점프해요 — 엉뚱한 곳으로 날아가 페이지 폴트.

재밌는 건 **커널 스레드만 있던 2절에선 이게 안 터졌다**는 거예요.
스레드들이 *전부 같은 코드*(`spinA`/`spinB`는 사실상 같은 함수)를 돌아서, 복귀 PC가 누구 값으로 덮이든 우연히 맞아떨어졌거든요.
순전히 운이었죠.
그런데 U-mode 유저 프로세스(복귀 주소 = 유저 코드)와 S-mode 커널 스레드(복귀 주소 = 커널 코드)가 **섞이는 순간**, 서로의 `sepc`를 덮으며 바로 터졌어요.

해결은 일반 레지스터처럼 **`sepc`/`sstatus`도 트랩 프레임에 저장/복원**하는 것 — 트랩마다 자기 복귀 상태를 독립적으로 갖게요.
실제 `kernelvec.S`를 보면, 일반 레지스터 31개를 오프셋 0~232에 저장한 뒤, 그 두 CSR을 240·248에 이어 저장해요(프레임 총 256바이트).

```asm
# kernelvec.S — 일반 레지스터(0~232)를 저장한 직후
        csrr    t0, sepc
        sd      t0,  240(sp)    # 복귀 PC도 프레임에
        csrr    t0, sstatus
        sd      t0,  248(sp)    #  (트랩마다 독립 → 여러 프로세스 인터리빙 안전)

        csrr    tp, sscratch    # 덤: tp(코어 번호)도 복구 — 유저가 tp를 덮었을 수 있어서
```

복귀할 때(`trapret`)는 반대로 프레임의 240·248을 읽어 `sepc`/`sstatus`로 되돌린 뒤 `sret`해요.
이렇게 하니 1절에서 `w_sepc()`가 아니라 **`f->sepc += 4`** 로 프레임을 고쳤던 이유도 분명해져요 — CSR을 직접 만지면 인터리빙에 휩쓸리지만, **프레임 사본**을 고치면 그 트랩만의 복귀 상태로 안전하게 남거든요.
이게 xv6 트랩프레임의 핵심이에요.

### (2) SUM 비트 — 커널이 유저 페이지를 만질 권한

(1)을 고쳤는데 그래도 멈췄어요.
이번엔 더 고약한, **출력도 폴트 메시지도 없는 완전한 hang**이었어요.
계측하려고 커널 스레드가 주기적으로 점(`.`)을 찍게 했더니 점조차 안 찍혔어요 — 스케줄러가 유저 프로세스 안에서 **영영 못 빠져나오고** 있었던 거예요.

범인은 `SUM`(Supervisor User Memory access) 비트였어요.
저는 단순화를 위해 **유저 프로세스의 트랩도 유저 스택 위에서** 처리했어요 — 트랩 프레임을 별도 커널 스택이 아니라 그냥 유저 스택에 쌓은 거죠.
그런데 보안상 기본적으로 **S-mode는 `PTE_U` 달린 유저 페이지를 못 만져요**(커널이 실수로 유저 메모리를 건드리는 걸 막는 장치예요).
S-mode가 유저 페이지에 접근하려면 `sstatus.SUM=1`이 필요해요.

문제는 (1)에서 **`sstatus`를 트랩마다 저장/복원**하게 만든 것과 충돌했다는 거예요.
SUM도 `sstatus`의 한 비트니까, 이제 프로세스마다 SUM 값이 달라져요.
커널 스레드는 SUM=0으로 돌다 멈췄는데, 스케줄러가 유저 프로세스의 트랩 핸들러(유저 스택에서 실행 중)를 재개하는 순간 그 SUM=0 상태로 깨어나요.
→ **유저 스택 접근이 폴트** → 그 폴트를 처리하려고 또 유저 스택을 건드리니 **또 폴트** → 출력 한 줄 못 내고 무한 재폴트, 즉 hang이었어요.

해결은 **SUM을 부팅 때 켜고 항상 1로 유지**하는 것.
`trap_init()`에서 한 번 켜두고, U-mode로 내려가는 `enter_user`/`exec`의 `sstatus` 세팅에도 `SUM`을 늘 포함시켜서, 어떤 트랩이 깨어나도 SUM=1이 보장되게 했어요.

```c
// trap.c — trap_init()에서 한 번만
w_sstatus(r_sstatus() | SSTATUS_SUM);  // SUM=1 고정: 커널이 항상 유저 페이지 접근 가능

// proc.c — enter_user() / proc_exec()의 sstatus 세팅에도 항상 포함
s |= SSTATUS_SUM;
```

이건 학습 커널다운 단순화예요.
xv6는 트랩을 **별도 커널 스택**에서 처리하고 `sscratch`로 유저/커널 스택을 교체해서, 애초에 트랩 핸들러가 유저 페이지를 만질 일이 없게 더 정석으로 풀어요.
우린 "유저 스택에서 트랩 처리 + SUM 항상 1"이라는 지름길을 택한 거고, 그 대가로 이 버그를 만난 거죠.

두 버그 다 수정 자체는 두어 줄이지만, 여기까지 오며 **트랩 ↔ CSR ↔ 권한**이 어떻게 얽히는지 손으로 만져보며 이해하게 됐어요.
책으로 읽을 땐 그냥 넘겼던 부분이에요.

## 마치며

골격 위에 OS의 심장을 올렸어요.

- 유저모드(U-mode) + 시스템콜(`ecall`) 경계
- 컨텍스트 스위치 + 선점형 라운드로빈 스케줄러
- 프로세스별 페이지 테이블 = 주소공간 격리
- 프로세스 생명주기(`SYS_exit`)

이제 **여러 프로그램이 각자 격리된 주소공간에서, 선점적으로, 생성·종료되는** 작은 운영체제가 됐어요.
다음은 진짜 프로그램을 다루는 쪽 — **fork/exec + ELF 로더**(지금은 임베드된 프로그램), 그리고 **파일시스템**으로 가요.

> 코드: [github.com/dj258255/hobby-kernel](https://github.com/dj258255/hobby-kernel)
> 다음 글: **fork/exec + 파일시스템 (예정)**

### 참고 자료

- [xv6: a simple, Unix-like teaching operating system (MIT 6.S081)](https://pdos.csail.mit.edu/6.828/2023/xv6.html)
- [RISC-V Privileged Specification](https://riscv.org/technical/specifications/)
- [OSDev Wiki](https://wiki.osdev.org/)

<!-- EN -->

## Introduction

In [Part 1](/blog/hobby/hobby-kernel-00-boot-to-paging) I built the **skeleton** of the kernel — boot, UART output, traps/timer, keyboard + shell, page allocator, Sv39 paging.
But up to that point, **every line of code runs with kernel privilege (S-mode)**.
What actually makes an operating system an operating system is the **boundary**: "a low-privilege user program asks the kernel to do work on its behalf."

This post is about building that boundary and putting **processes** on top of it.
It splits into three parts.

1. **User mode + system calls** — drop into U-mode and call the kernel via `ecall`
2. **Processes + a preemptive scheduler** — alternate between multiple execution flows via context switching
3. **User processes** — give each process its own page table to isolate its address space

At the end I'll go over the two things I learned from debugging while building this (shared CSRs, the SUM bit).
Honestly, those two bugs were where I learned the most in this stage.

> The reference is still [xv6 (MIT 6.S081)](https://pdos.csail.mit.edu/6.828/2023/xv6.html). But rather than dropping in the textbook structures like a trampoline and per-process trap frames all at once, I took the simplest path that works first (and you'll see the price of that below).

## 1. User Mode + System Calls

### Why do we need user mode

On RISC-V the privilege levels are M (machine) > S (supervisor) > U (user).
Until now our whole kernel ran in **S-mode** — the shell, the timer, the page allocator, all of it.
S-mode can do basically anything: read and write CSRs freely, touch device memory (UART, PLIC), swap out page tables.

The problem is that running a "program" with that much power is dangerous.
One bug in a user's program that writes to the wrong address could take down the kernel itself.
So an OS confines user programs to the **lowest-privilege U-mode**.
U-mode can't touch CSRs, can't touch device memory, and faults the instant it even reads a page without `PTE_U` (i.e. a kernel page).

So how does real work like screen output happen?
It **asks the kernel**.
That's a system call.
Think of a U-mode program as a diner and the kernel as the kitchen.
The diner can't walk into the kitchen and work the stove, so they write an order on a slip and hand it to the waiter.
On RISC-V that "order" is the `ecall` (environment call) instruction.

### The mechanism — the trap `ecall` raises

To ask the kernel for something, the user has to put the arguments in agreed-upon places.
Like xv6, we settled on **`a7` for the call number and `a0` onward for arguments**.

```asm
li a7, 1      # a7 = SYS_putchar (call number)
li a0, 85     # a0 = 'U' (argument)
ecall         # "kernel, please print this character"
```

Running `ecall` from U-mode makes the CPU raise a **trap**.
It's the exact trap mechanism from Part 1 — it jumps to the handler pointed to by `stvec` (`kernelvec`) and rises into S-mode.
The only difference is that `scause` comes in as **8 (Environment call from U-mode)**.
So we just add one branch to the trap handler built in Part 1.

```c
// trap.c — kerneltrap()
} else if (cause == SCAUSE_U_ECALL) {
    // A user program 'asked' the kernel via ecall = a system call.
    syscall(f);
    f->sepc += 4;  // return to the instruction *after* the ecall (4 bytes)
}
```

That `f->sepc += 4` matters.
`sepc` holds the address of the `ecall` instruction **itself**.
Returning as-is would re-run the same `ecall` and spin forever.
RISC-V instructions are 4 bytes, so we add 4 to `sepc` to return to **the next instruction**.
(But why `f->sepc` and not `w_sepc()`? That's the first debugging story in §4.)

The dispatcher that branches on the call number lives in `user.c`.
The real code has 17 syscalls (`fork`/`exec`/`read`/`mmap`/`tcp`...), but the skeleton looks like this.

```c
// user.c — system-call dispatch (kernel side)
void syscall(struct regframe *f) {
    switch (f->a7) {                      // branch on a7 = call number
    case SYS_putchar:
        uart_putc((char)f->a0);           // a0 = the character the user asked for
        f->a0 = 0;                        // write the return value into the frame's a0
        break;
    case SYS_print:
        uart_puts("...hello from user...\n");
        f->a0 = 0;
        break;
    // SYS_fork / SYS_exec / SYS_read / ...
    }
}
```

The thing to notice is that **the return value is written into `f->a0`**.
`f` is the trap frame — a copy of the user's registers saved on trap entry.
Patch `a0` here, and when we return from the trap that value gets restored into the user's `a0` register.
From the user's side it's "I did an `ecall` and the result is sitting in `a0`" — exactly like a function call.

### Our code — dropping into U-mode with a single `sret`

We built the path that receives a request; now we need the path that **first sends a user program down into U-mode**.
This is surprisingly simple — a single `sret`.

`sret` is normally the "return from a trap" instruction.
When the CPU sees `sret`, it checks `sstatus.SPP` to decide "which mode was I in before the trap?" and returns to that mode.
So if we **fake the state as though a trap had fired from U-mode** and then `sret`, the CPU happily "returns" to U-mode — even though we were never actually there.

In our code `enter_user()` does exactly that.

```c
// proc.c — wrapper a user process goes through on its first run
static void enter_user(void) {
    release(&pt_lock);       // drop the lock the scheduler held (first run)
    uint64 s = r_sstatus();
    s &= ~SSTATUS_SPP;       // SPP=0 → sret drops to U-mode
    s |= SSTATUS_SPIE;       // enable interrupts in U-mode (= preemptible)
    s |= SSTATUS_SUM;        // kernel may touch user pages (we meet this again in §4)
    w_sstatus(s);
    w_sepc(USERVA);          // return address = user entry point
    // set sp to the top of the user stack and sret. Never returns.
    asm volatile("mv sp, %0\n sret\n" :: "r"((uint64)USERSTACKTOP));
}
```

`SPP=0` is the lie "the previous mode was U-mode," `SPIE` says "enable interrupts once in U-mode" (you need this for the timer to preempt the user), and `sepc=USERVA` says "return here."
Hitting `sret` drops privilege to U-mode and jumps to `USERVA`, where the user program's first instruction lives.

```
[kernel] entering user mode (U-mode)...
Hello from user mode! (printed by the kernel, requested via ecall)
```

A program dropped into U-mode made a request via `ecall`, and the kernel received and handled it.
It may look like a trivial one-liner, but it matters: it's **the first time we crossed the privilege boundary**.
What used to be a single blob called "the kernel" has finally split into "the kernel" and "a program running on top of it."

## 2. Processes + a Preemptive Scheduler

### Why do we need a context switch

Running just one program isn't an OS yet.
The OS-ness comes from **alternating between multiple execution flows** — while the shell waits for input, another program crunches numbers, and when that stalls a third one cuts in.
There's only one core (or a few) but many flows, so the trick is to **rapidly take turns** on the CPU.

To do that, you have to be able to stop a flow and **resume it later at exactly the same spot**.
A flow's "current state" lives entirely in its **registers** — how far it got in which function (`ra`), where its stack is (`sp`), the values it was computing (`s0`–`s11`).
So a context switch is nothing more than **saving the current flow's registers somewhere and restoring another flow's registers**.
We call that saved register bundle a `struct context`, and each process has one.

### The mechanism — `swtch` only saves 14 registers

There are 31 general registers, but you don't need to save all of them.
`swtch` is called **like an ordinary C function**.
By the C calling convention, when you call a function the caller has already spilled the caller-saved registers (`a0`–`a7`, `t0`–`t6`) to the stack itself.
So all `swtch` has to preserve is the **callee-saved registers (`s0`–`s11`) + `ra` (return address) + `sp` (stack pointer)** — exactly 14.

```asm
# swtch.S — void swtch(struct context *old, struct context *new)
#   a0 = old (where to save), a1 = new (where to restore)
swtch:
        sd  ra,   0(a0)     # save current flow's ra/sp/s0~s11 into old
        sd  sp,   8(a0)
        sd  s0,  16(a0)
        sd  s1,  24(a0)
        # ... s2 ~ s11 (offsets 32 ~ 104) ...
        sd  s11,104(a0)

        ld  ra,   0(a1)     # restore the new flow's values from new
        ld  sp,   8(a1)
        ld  s0,  16(a1)
        # ... s1 ~ s11 ...
        ld  s11,104(a1)

        ret                 # jump to ra (= new flow's return address) → switched
```

The magic is that final `ret`.
`ret` means "go back to where `ra` points," but we just overwrote `ra` with **the new flow's value**.
So you call a function named `swtch`, yet the **return comes out of a completely different execution flow**.
When A calls `swtch` the function "doesn't return"; much later, the moment B yields by calling `swtch`, A's `swtch` finally returns.
A single function call's entry and exit straddle two different threads.

### Our code — the scheduler/yield ping-pong

The scheduler is simple.
It scans the process table, and when it finds a runnable (`RUNNABLE`) process it flips it to `RUNNING` and enters it via `swtch`.
When that process yields (`yield`), `swtch` returns to the scheduler, which finds the next process and enters it too (round-robin).

```c
// proc.c — scheduler (each core runs this loop forever)
void scheduler(void) {
    int id = r_tp();                          // this core's id
    for (;;) {
        acquire(&pt_lock);
        for (int i = 0; i < NPROC; i++) {
            struct proc *p = &proctable[i];
            if (p->state == RUNNABLE) {
                p->state = RUNNING;
                cpu_proc[id] = p;
                switch_satp(p->pagetable);             // switch address space (§3)
                swtch(&cpu_sched[id], &p->context);    // run p → returns when it yields
                switch_satp(kernel_pt());              // back to kernel address space
                cpu_proc[id] = 0;
            }
        }
        release(&pt_lock);
    }
}
```

On the other side is `yield()` — the function by which a process hands the CPU back to the scheduler.
The scheduler's `swtch` and `yield`'s `swtch` **ping-pong off each other's `ra`**, so the two flows wake each other in turn.

```c
// proc.c — current proc yields the CPU to the scheduler
void yield(void) {
    int id = r_tp();
    struct proc *p = cpu_proc[id];
    acquire(&pt_lock);
    if (p->state == RUNNING)
        p->state = RUNNABLE;                  // so it can be scheduled again
    swtch(&p->context, &cpu_sched[id]);       // to the scheduler → later resumes here
    release(&pt_lock);
}
```

> You'll notice `pt_lock` is carried *across* the `swtch` — the scheduler enters a process holding the lock, and the process drops it on first run inside `thread_start`/`enter_user` (`release(&pt_lock)`). It's a kind of **baton pass**. On multicore (`NCPU`) it keeps the process table from being corrupted concurrently; the details belong to the multicore post.

### Preemption — the timer forces a yield

So far a switch only happens if a process **voluntarily** calls `yield` (cooperative scheduling).
But a program stuck in an infinite loop would never yield.
So a real OS does **preemption** — taking the CPU away even without a yield.
The key is the **timer interrupt**.

Just one more line on top of the periodic timer from Part 1 makes it preemptive.
Every time the timer fires, if a process is running, we call `yield()` on its behalf.

```c
// trap.c — timer interrupt handling
ticks++;
w_stimecmp(r_time() + TIMER_INTERVAL);    // schedule the next timer
if (current_proc())
    yield();   // force the running thread to yield to the scheduler (= preempt)
```

From the process's view it was running along, paused at some instant, and resumed at the same spot a while later as if nothing happened.
In that "while" some other process ran for the timer's slice — and it never knew.
That's the illusion of multitasking.

I brought the shell back too.
The shell runs off UART interrupts, so it responds to keystrokes no matter which process is running.
And to actually see two threads taking turns, I added a `ps` command — each thread spins incrementing a counter, and when the timer preempts back and forth between them, both counters climb **together**.

```
hobby> ps
threads (preemptively scheduled):
  spinA: ticks=34888638
  spinB: ticks=31213595
hobby> ps                      (1.2s later)
  spinA: ticks=64687087        +30M
  spinB: ticks=61305716        +30M
```

Over 1.2 seconds both counters grew by ~30M each.
The point is that **both** grow at a similar rate, not just one — proof that the timer is fairly taking turns between them.
**Preemptive multitasking** is running.

## 3. User Processes = Isolated Address Spaces

### Why give each process its own page table

The "processes" in §2 were really **kernel threads** — they ran in S-mode and all shared one page table.
Seeing the same address space, they could freely overwrite each other's memory.
That's not a real process.

The essence of a real process is **isolation**.
The "a different translation table per process" we promised back in §5 of Part 1 comes true right here.
If process A's `0x1000` and B's `0x1000` translate to different physical pages, the two can use the same address without colliding — and can't corrupt each other.
For that, you have to give each process **its own page table**.

### Our code — `proc_pagetable`

Each process's page table is made of two parts.
The **kernel region (identity mapping)** + **that process's own user code and stack** (marked `PTE_U`).

```c
// vm.c — per-process page table
pagetable_t proc_pagetable(uint64 ucode_pa, uint64 ustack_pa) {
    pagetable_t pt = (pagetable_t)kalloc();
    memset(pt, 0, PGSIZE);
    map_kernel(pt);                                              // identity-map the kernel here too
    mappages(pt, USERVA,    PGSIZE, ucode_pa,  PTE_R|PTE_X|PTE_U); // code: read/exec, user-accessible
    mappages(pt, USERSTACK, PGSIZE, ustack_pa, PTE_R|PTE_W|PTE_U); // stack: read/write, user-accessible
    return pt;
}
```

The code page is `R|X` (read/exec, no write) and the stack is `R|W` (read/write, no exec) — the permission bits from Part 1 doing their protection job here.
Both carry `PTE_U`.
That bit is what lets a U-mode program access these pages (kernel pages have no `PTE_U`, so a user touching one faults).

> **Why map the kernel into every page table?** This is the core of our simplification. The instant a trap (`ecall`, timer) fires in U-mode, `satp` **still points at that process's table**. But the trap handler (`kernelvec`) is just code in memory too, and its address has to be mapped in the current page table to execute. So we replicate the kernel into every process table at **the same address (identity mapping)** — then the handler runs as-is without changing `satp`. xv6 solves this elegantly with a single **trampoline** page (only the entry stub, not the whole kernel, is mapped in both), but since this is a learning kernel we took the simpler "replicate the whole kernel" path. The cost is that every page table carries the kernel mapping, so we use a bit more memory.

### Switching the address space too — `switch_satp`

Once each process has its own table, switching processes also means **switching which table is active**.
That's the `satp` register (the one we used to turn paging on in Part 1).
Right before entering a process the scheduler points `satp` at that process's table, and once it yields back, points it at the kernel table again.

```c
// proc.c — inside scheduler()
switch_satp(p->pagetable);             // into this process's address space (set satp + flush TLB)
swtch(&cpu_sched[id], &p->context);    // run → returns on yield
switch_satp(kernel_pt());              // back to kernel address space
```

```c
// vm.c
void switch_satp(pagetable_t pt) {
    w_satp(MAKE_SATP(pt));   // satp = physical address of the new page table
    sfence_vma();            // flush the TLB (old translation cache)
}
```

Don't forget `sfence_vma()` — we swapped out the whole address translation, so the CPU's cached old translations (the TLB) must be flushed for the new table to actually take effect.

### Kernel threads and user processes under one `swtch`

Here's the clean part of our design.
Kernel thread or user process, **both enter through the same `swtch`**.
The only difference is the **initial entry point (`context.ra`)**.

```c
// proc.c — make_thread(): kernel thread
p->context.ra = (uint64)thread_start;  // first swtch enters a plain function

// proc.c — make_user_proc(): user process
p->context.ra = (uint64)enter_user;    // first swtch enters a function that drops to U-mode
```

When the scheduler first enters this process via `swtch`, the `ret` jumps to `context.ra`.
For a kernel thread that's `thread_start` (drop the lock, call the body function); for a user process it's `enter_user` (the `sret` into U-mode from §1).
One keeps running as an S-mode function, the other drops into U-mode and becomes a user program — **the same mechanism, just a different entry point**.

### One screen to sum up

- **Kernel thread** = an S-mode function + its own kernel stack. Shares the kernel's page table. Entry point `thread_start`.
- **User process** = its own page table (isolated address space) + user code/stack (`PTE_U`) + a kernel stack. Entry point `enter_user` (`sret` into U-mode).
- **Switching** = `switch_satp` (address space) + `swtch` (registers). The two come as a pair.
- **Shared** = both enter through the same `swtch`. The only difference is `context.ra`.

The demo schedules 1 kernel thread + 1 user process together.
The user process greets once, counts 40 ticks while doing a bit of work, then terminates via `SYS_exit`.

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

A user process with an isolated address space gets preemptively scheduled alongside a kernel thread, and cleanly disappears once it's done.
The **skeleton of a small OS** is standing.

## 4. Two Things I Learned from Debugging

Part 3 didn't work on the first try.
The user process only printed its greeting and then **froze** (with no fault).
Here I learned two deep OS principles.

### (1) There's Only One CSR per Core — Save It in the Trap Frame

My first trap entry point saved only the 31 general-purpose registers onto the stack.
The return PC `sepc` and the mode bits `sstatus` are CSRs, so I figured **they'd just stay put** and left them alone.
There's a trap hiding there — **`sepc`/`sstatus` are a single register per core**.

Why is that a problem? Because another switch can happen *while* a trap is being handled.
Process A enters a trap, and mid-handling the timer fires and `yield`s to B; if B then raises its own trap (an `ecall` or a timer), the **one and only `sepc` gets overwritten with B's value**.
Later, returning to A, the `sret` jumps not to A's return address but to the one B left behind — off into the weeds, page fault.

The funny thing is that **the kernel-thread-only stage (§2) never blew up**.
The threads all ran *the same code* (`spinA`/`spinB` are essentially the same function), so whoever's value overwrote the return PC, it happened to line up.
Pure luck.
But **the moment** a U-mode user process (return address = user code) and an S-mode kernel thread (return address = kernel code) mixed, they overwrote each other's `sepc` and it broke instantly.

The fix is to **save/restore `sepc`/`sstatus` in the trap frame** just like the general registers — so each trap holds its own return state independently.
In the real `kernelvec.S`, after saving the 31 general registers at offsets 0–232, it saves those two CSRs at 240 and 248 (the frame is 256 bytes total).

```asm
# kernelvec.S — right after saving the general registers (0~232)
        csrr    t0, sepc
        sd      t0,  240(sp)    # return PC into the frame too
        csrr    t0, sstatus
        sd      t0,  248(sp)    #  (per-trap → safe interleaving across processes)

        csrr    tp, sscratch    # bonus: restore tp (core id) — a user may have clobbered it
```

On the way out (`trapret`) it reads back 240/248 into `sepc`/`sstatus` before `sret`.
This also makes clear why in §1 we patched **`f->sepc += 4`** instead of `w_sepc()` — touching the CSR directly gets swept up in the interleaving, but editing the **frame copy** safely keeps that one trap's return state.
This is the heart of the xv6 trap frame.

### (2) The SUM Bit — the Kernel's Permission to Touch User Pages

I fixed (1) and it still froze.
This time it was nastier: a complete hang with **no output and no fault message**.
For instrumentation I made the kernel thread periodically print a dot (`.`) — and even the dots stopped, meaning the scheduler was **never escaping** the user process.

The culprit was the `SUM` (Supervisor User Memory access) bit.
For simplicity I handled **the user process's trap on the user stack too** — pushing the trap frame onto the user stack rather than a separate kernel stack.
But by default, for security, **S-mode can't touch a `PTE_U` user page** (it guards against the kernel accidentally poking at user memory).
For S-mode to access a user page you need `sstatus.SUM=1`.

The trouble is this collided with making **`sstatus` save/restore per trap** in (1).
SUM is just one bit of `sstatus`, so now its value varied per process.
The kernel thread stalled while running with SUM=0, and the instant the scheduler resumed the user process's trap handler (running on the user stack), it woke up with that SUM=0.
→ **accessing the user stack faulted** → handling that fault touched the user stack again → **faulted again** → an endless re-fault that never prints a line, i.e. a hang.

The fix is to **turn SUM on at boot and keep it 1 forever**.
Set it once in `trap_init()`, and always include `SUM` in the `sstatus` setup in `enter_user`/`exec` that drops to U-mode, so whichever trap wakes up, SUM=1 is guaranteed.

```c
// trap.c — once in trap_init()
w_sstatus(r_sstatus() | SSTATUS_SUM);  // SUM=1 pinned: kernel can always touch user pages

// proc.c — always included in enter_user() / proc_exec()'s sstatus setup
s |= SSTATUS_SUM;
```

This is a learning-kernel simplification.
xv6 handles traps on a **separate kernel stack** and swaps user/kernel stacks via `sscratch`, so its trap handler never needs to touch user pages in the first place — the proper way.
We took the shortcut of "handle traps on the user stack + keep SUM always 1," and met this bug as the price.

Both fixes are only a couple of lines, but getting here let me feel, hands-on, how **traps ↔ CSRs ↔ permissions** tangle together.
It's the part I'd just skim past when reading a book.

## Closing

I put the heart of an OS on top of the skeleton.

- User mode (U-mode) + the system-call (`ecall`) boundary
- Context switching + a preemptive round-robin scheduler
- Per-process page tables = address-space isolation
- The process lifecycle (`SYS_exit`)

Now it's a small operating system where **multiple programs are created and terminated, preemptively, each in its own isolated address space**.
Next up is the side that deals with real programs — **fork/exec + an ELF loader** (right now the programs are embedded), and then a **filesystem**.

> Code: [github.com/dj258255/hobby-kernel](https://github.com/dj258255/hobby-kernel)
> Next post: **fork/exec + filesystem (coming soon)**

### References

- [xv6: a simple, Unix-like teaching operating system (MIT 6.S081)](https://pdos.csail.mit.edu/6.828/2023/xv6.html)
- [RISC-V Privileged Specification](https://riscv.org/technical/specifications/)
- [OSDev Wiki](https://wiki.osdev.org/)

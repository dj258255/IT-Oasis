---
title: '유저 스레드 — 커널 없이 갈아타기'
titleEn: 'User Threads — Switching Without the Kernel'
description: 스레드는 꼭 커널이 만들어줘야 할까. 한 프로세스 안에서, 커널의 도움 없이 유저 공간만으로 실행 흐름을 갈아타는 협조적 유저 스레드를 만든다. 이건 이 시리즈에서 한 번 실패했다 되돌렸던 주제다. 진짜 원인 — 단일 페이지 모델의 전역 변수 제약, 그리고 힙 스택 위에 트랩 프레임을 저장하다 나는 커널 페이지 폴트 — 을 찾아내고, 커널을 전혀 바꾸지 않고 두 가지 우회로 해결한다.
descriptionEn: "Must the kernel be the one to create threads? Inside a single process, with no help from the kernel, we build cooperative user threads that switch execution flows purely in user space. This is a topic I once failed at and reverted in this series. We track down the real causes — the single-page model's ban on globals, and a kernel page fault from saving a trap frame on a heap stack — and solve them with two workarounds, changing the kernel not at all."
date: 2026-06-20T00:00:00.000Z
tags:
  - OS
  - C
  - Kernel
  - RISC-V
  - xv6
  - QEMU
  - Thread
category: project/hobby-kernel
coverImage: "/uploads/hobby/hobby-kernel-c/cover.svg"
draft: false
series: "C로 만드는 토이 커널"
seriesOrder: 11
---


*바닥부터 직접 만드는 RISC-V 토이 커널 연재. 이 글은 마지막 편 — 협조적 유저 스레드(uthread).*

## 0. 들어가며

지금까지 이 커널에서 "동시에 도는 것"은 전부 **커널이** 만들어 줬어요.
[4편의 스케줄러](/blog/hobby/hobby-kernel-03-exec-and-shell)가 프로세스를 갈아탔고, [6편의 멀티코어](/blog/hobby/hobby-kernel-05-smp-multicore-locks)가 코어를 나눠 가졌죠.
둘 다 공통점이 하나 있어요 — **갈아타는 결정을 커널이 내린다**는 점입니다. 타이머 인터럽트가 커널로 들어오고, 커널의 `swtch`가 다음 흐름으로 점프하고, 커널이 페이지 테이블을 바꿔요.

이 글은 그 전제를 한 번 뒤집어 봅니다.
**커널의 도움 없이, 한 프로세스 안에서, 유저 공간만으로** 실행 흐름을 갈아탈 수 있을까?
답은 "있다"이고, 그게 **유저 스레드**(user-level thread, green thread)예요. 커널은 이걸 그냥 평범한 한 프로세스로만 알고, 그 안에서 여러 흐름이 자기들끼리 번갈아 도는 거죠.

그런데 이 주제는 솔직히 말하면 이 시리즈에서 **한 번 실패하고 되돌렸던** 거예요.
"교과서대로 짜면 되겠지" 하고 덤볐다가, 워커가 엉뚱한 스택에서 돌다 죽었고, 원인이 안 보여서 통째로 revert 했었습니다.
이번 글은 그 실패를 다시 꺼내 **진짜 원인 두 가지**를 끝까지 추적하고, 커널은 한 줄도 안 고치고 푸는 이야기예요.
연재의 마지막 편이라, 끝에는 부팅부터 여기까지 온 여정도 함께 돌아봅니다.

## 1. 유저 스레드가 풀어야 하는 진짜 문제

> 커널의 도움을 전혀 받지 않고, 한 프로세스 안에서 실행 흐름을 어떻게 갈아탈까요? "지금 함수 A를 실행 중인 CPU"를 "함수 B를 실행 중이던 CPU"로 바꿔치기하는 일을, 시스템콜 한 번 없이 할 수 있을까요?

스레드라고 하면 보통 커널이 만들어 주는 걸 떠올려요 — `clone`/`pthread_create`가 시스템콜로 커널에 들어가, 커널이 새 커널 스택과 스케줄링 엔트리를 만들죠.
하지만 "실행 흐름을 갈아탄다"는 일의 **본질**만 보면, 커널이 꼭 필요하진 않아요.

CPU의 실행 흐름이란 결국 **레지스터 한 묶음**이에요 — 지금 어느 명령을 실행 중인지(`pc`/`ra`), 스택이 어디인지(`sp`), 그리고 살아있는 값들(`s0`~`s11` 같은 callee-saved 레지스터).
그러니 "흐름을 갈아탄다"는 건 **이 레지스터 묶음을 메모리에 저장하고, 다른 묶음을 불러오는 일**일 뿐이에요. 이건 유저 코드도 충분히 할 수 있어요. 특권 명령이 하나도 안 들어가거든요.

그런데 우리 커널에서 이걸 실제로 짜 보니, 교과서엔 안 나오는 **우리 설계만의 벽 두 개**에 정통으로 부딪혔어요.

1. **전역 변수를 못 쓴다** — 유저 프로그램 코드가 단일 페이지(`R|X`)로만 매핑돼서, 스레드 테이블을 둘 `.data`/`.bss`가 쓰기 가능하지 않았어요.
2. **스레드가 `ecall`만 하면 커널이 죽는다** — 우리 트랩 진입 코드가 트랩 프레임을 유저 스택 바로 밑에 저장하는데, 그 자리가 아직 매핑 안 된 힙 페이지라 **커널이** 페이지 폴트를 냈어요.

두 벽 다 처음 실패의 원인이었고, 정적으로 코드만 읽어선 안 보였어요 — 직접 돌려 크래시를 추적하고 나서야 보였습니다.
이 글의 절반은 이 두 벽을 추적하고 우회하는 이야기예요.

## 2. 첫 번째 벽 — 전역 변수의 함정

### 배경: 교과서 구현은 전역을 쓴다

> 스레드 시스템은 "스레드들의 목록"과 "지금 누가 도는지"를 어딘가에 들고 있어야 해요. 교과서는 그걸 어디에 둘까요?

유저 스레드의 표준 구현(xv6의 uthread 랩)은 이걸 전부 **전역 변수**에 둬요.

```c
struct thread all_thread[NTHREAD];   // 전역
struct thread *current_thread;       // 전역
```

전역은 프로그램 어디서든 같은 한 곳을 가리키니, 스레드 테이블을 두기에 자연스러운 자리예요.
보통 환경에선 아무 문제가 없습니다 — `.data`/`.bss`가 당연히 쓰기 가능하니까요.

### 그런데 우리 커널에선 그게 깨졌다

우리만의 설계가 발목을 잡았어요 — **유저 프로그램은 코드가 단일 페이지(`R|X`)로만 매핑**돼요.
[1편에서 봤듯](/blog/hobby/hobby-kernel-00-boot-to-paging) 페이지 권한은 영역별로 다르게 줄 수 있고, 코드 페이지는 `R|X`(읽기·실행, **쓰기 금지**)예요.
그런데 우리 유저 프로그램은 그 코드 페이지 하나가 전부라, 전역 변수가 사는 `.data`/`.bss`도 결국 같은 `R|X` 페이지에 얹혀요.

결과는 명확해요 — **전역에 쓰는 순간 쓰기 금지 폴트**가 나요.
처음 실패가 딱 이거였어요. 전역 `current_thread`에 값을 넣는 순간 스레드 컨텍스트(특히 `sp`)가 엉뚱한 값으로 채워졌고, 워커가 쓰레기 `sp`를 들고 잘못된 스택에서 돌다 죽었습니다.
증상(엉뚱한 스택)과 원인(전역 쓰기 금지)이 한참 떨어져 있어서, 한 번에 안 보였어요.

> **흔한 오해 정정**: *"전역 변수는 그냥 메모리니까 항상 쓸 수 있다"* 고 생각하기 쉬운데, 아니에요. 전역이 **어느 페이지에, 어떤 권한으로 매핑됐는지**가 전부예요. 보통 OS는 `.data`/`.bss`를 `R|W` 세그먼트로 따로 매핑해 주기 때문에 안 보일 뿐이고, 우리처럼 코드 한 페이지만 주는 미니멀 모델에선 *"전역에 쓰기"* 가 곧 *"코드 페이지에 쓰기"* 라 막혀요.

### 갈림길: 커널을 고칠까, 안 고칠까

해법은 두 갈래였어요.

| 선택지 | 무엇을 하나 | 비용 | 의미 |
|--------|------------|------|------|
| ① 데이터 세그먼트 추가 | 유저 주소공간에 `R|W` `.data`/`.bss`를 따로 매핑 | **커널·로더를 고쳐야 함** | "정석". 하지만 이번 글의 전제(커널 무수정)를 깬다 |
| ② 전역을 안 쓴다 | 상태를 쓰기 가능한 힙에 둔다 | 코드 트릭 하나면 됨 | 커널을 한 줄도 안 건드리고 푼다 |

저는 **②번**을 택했어요.
이미 [5편에서 demand paging 힙](/blog/hobby/hobby-kernel-04-paging-mmap-writable-fs)을 만들어 뒀고, 그 힙은 `R|W`로 매핑돼서 쓰기 가능하거든요.
그러니 스레드 상태를 전역 대신 **힙에 통째로 올리면**, 단일 페이지 제약을 정면으로 피해 가요.

> **핵심 교훈**: 제약을 만났을 때 항상 시스템을 고쳐야 하는 건 아니에요. *"무엇이 쓰기 가능한가"* 를 먼저 따져 보면, 이미 있는 자원(여기선 힙)으로 우회할 길이 보일 때가 많습니다.

## 3. 전역 없이 — 힙의 고정 주소라는 트릭

핵심 트릭은 이거예요.
스레드 시스템 구조체 전체를 힙의 **고정 주소**(우리 힙의 시작점 `0x10000`)에 둬요.

```c
#define HEAPBASE 0x10000UL
#define NTHREAD  3
#define STACKSZ  2048

struct ctx    { unsigned long ra, sp, s[12]; };   // ra, sp, s0..s11 = 14개(112바이트)
struct thread { struct ctx ctx; int state; };     // state: 0=종료/미사용, 1=runnable
struct sys {
    struct ctx     sched;                          // 스케줄러 컨텍스트
    struct thread  t[NTHREAD];
    int            current;                         // 현재 스레드 인덱스
    unsigned char  stacks[NTHREAD][STACKSZ];        // 스레드별 스택(힙)
};
#define S ((volatile struct sys *)HEAPBASE)
```

여기서 마법은 마지막 `#define`에 있어요.
`(struct sys *)0x10000` 은 **전역 변수가 아니라 포인터 상수**예요.
컴파일러 입장에서 이건 "주소 0x10000이라는 숫자"를 즉시값(immediate)으로 레지스터에 박는 일이라, **`.data`에 아무것도 안 들어가요.** 그러니 `R|X` 코드 페이지에서도 멀쩡히 동작해요 — 쓰기를 안 하니까요.
그리고 그 포인터가 *가리키는* 0x10000은 힙이라 쓰기 가능하죠.

이제 모든 상태를 이 하나의 포인터로 접근해요 — `S->current`, `S->t[i].state`, `S->stacks[i]` 처럼.
구조체 자신도, 스레드별 스택도 전부 `struct sys` 안에 들어가 있어서, 힙 한 덩어리가 곧 스레드 시스템 전체예요.

이게 왜 통하는지 한 줄로 보면 — 빌드하면 **전역이 0개**예요(`bss=0, data=0`).
교과서가 전역으로 풀던 걸 전부 "힙 위 고정 주소 + 포인터 상수"로 옮긴 거죠. 단일 페이지 제약을 정면으로 피해 갑니다.

| 구분 | 교과서(xv6 uthread) | 우리 커널(uthread.c) |
|------|--------------------|---------------------|
| 스레드 테이블 위치 | 전역 `.data`/`.bss` | 힙 고정 주소 `0x10000` |
| 접근 방법 | `all_thread[i]` (전역 심볼) | `S->t[i]` (포인터 상수 → 힙) |
| 필요한 페이지 권한 | `.data`가 `R\|W`라 전제 | 코드 `R\|X` + 힙 `R\|W` |
| 전역 변수 개수 | 여러 개 | **0개** (`bss=0, data=0`) |
| 커널 수정 | (랩 환경이 데이터 세그먼트 제공) | **불필요** |

## 4. 두 번째 벽 — 힙 스택 위의 트랩 프레임

### 전역을 없앴더니 새 크래시가 나타났다

전역을 힙으로 옮기니 스레드가 드디어 돌기 시작했어요.
`"  [thread A] step 1"` 이 화면에 찍혔죠. 첫 흐름이 자기 힙 스택 위에서 살아 움직인 순간이었어요.
그런데 다음 스레드로 넘어가다 **커널 모드에서** 페이지 폴트가 터졌어요.

```
[trap] EXCEPTION  scause=0xf  sepc=0x8020003e  stval=0x11000
```

이 한 줄을 읽는 게 핵심이에요.
- `scause=0xf` → store/AMO page fault (쓰다가 난 폴트)
- `stval=0x11000` → 폴트가 난 주소는 유저 힙 영역
- `sepc=0x8020003e` → **폴트를 낸 명령이 커널 주소(0x8020...)에 있다**

마지막 줄이 결정적이에요. 유저 코드가 아니라 **커널이** 유저 힙 주소에 쓰다가 폴트를 냈다는 뜻이거든요.

### 범인: 우리 트랩 진입 방식

범인은 우리 [트랩 처리 방식](/blog/hobby/hobby-kernel-01-usermode-to-processes)이에요.
우리 커널은 트랩이 나면 **그 순간의 `sp` 바로 아래에 트랩 프레임을 저장**해요. `kernelvec.S`의 첫 줄이 그걸 합니다.

```asm
# kernelvec.S — 트랩이 나면 가장 먼저
kernelvec:
        addi    sp, sp, -256    # 지금 sp에서 256바이트 내려 프레임 자리를 잡고
        sd      ra,    0(sp)    # 거기에 레지스터를 전부 저장한다
        sd      gp,    8(sp)
        ...                     # ra, gp, tp, t0..t6, s0..s11, a0..a7, sepc, sstatus
```

평소 프로세스에선 이 `sp`가 커널 스택이라 아무 문제 없어요. 그런데 유저 스레드는 **유저 모드의 `sp`가 힙 스택을 가리키는 채로** `ecall`을 해요.
스레드가 힙 스택(예: `0x111E0`)에서 돌다가 `sys_putchar`를 부르려고 `ecall`하면, 커널은 그 `sp`에서 256을 빼 `0x110E0`부터 프레임을 쓰기 시작해요.
그런데 그 힙 페이지가 아직 [demand paging](/blog/hobby/hobby-kernel-04-paging-mmap-writable-fs)으로 **매핑되기 전**이면, 커널의 `sd` 명령이 미매핑 주소에 쓰다가 폴트를 내요.

즉 **유저 스택 demand paging**과 **"커널이 유저 스택 위에 트랩 프레임을 저장한다"는 우리 설계**가 정면충돌한 거예요.
보통 OS라면 트랩 프레임을 커널 스택(항상 매핑됨)에 따로 저장하니 이 충돌이 안 나는데, 우리 미니멀 모델은 그 둘을 한 스택에서 처리하다 보니 이런 골목이 생겼어요.

> **흔한 오해 정정**: 페이지 폴트라고 하면 *"유저 프로그램의 버그"* 부터 떠올리기 쉬운데, 여기선 폴트를 낸 게 **커널**이에요(`sepc`가 커널 주소). demand paging은 폴트가 **유저 모드**에서 날 걸 전제로 만든 메커니즘인데, 트랩 프레임 저장은 **이미 커널 모드로 들어온 직후**에 일어나요. 그 순간의 폴트는 보통 "진짜 폴트"로 취급돼 복구가 안 돼요. 그래서 demand paging에 기대지 말고 **미리 매핑**해 둬야 했어요.

### 해법: 힙 페이지 pre-fault

해법은 의외로 단순해요 — 스레드를 돌리기 *전에* **힙 페이지를 미리 만져(touch)** 전부 매핑해 두는 거예요.

```c
sys_sbrk(16384);                                  // 힙을 16KB 키운다(주소만 확보, 물리 페이지는 아직)
for (unsigned long a = 0; a < 16384; a += 4096)   // 각 4KB 페이지를 미리 touch
    *((volatile unsigned char *)(HEAPBASE + a)) = 0;
```

작동 원리는 우리 [demand paging 분기](/blog/hobby/hobby-kernel-04-paging-mmap-writable-fs)에 정확히 맞물려요.
`sys_sbrk(16384)`는 `heap_top`만 올려 주소 범위를 확보하고 물리 페이지는 아직 안 줘요(지연 할당).
그다음 루프가 각 페이지를 한 번씩 건드리면, **유저 모드에서** 안전하게 폴트가 나고, `proc_pagefault`가 힙 분기로 들어가 빈 페이지를 `R|W|U`로 매핑해 줘요.

```c
// proc.c — 힙 영역 폴트면 빈 페이지를 그 자리에서 매핑(demand paging)
if (a >= HEAPBASE && a < p->heap_top) {
    char *mem = kalloc();
    if (!mem) return 0;
    zero(mem, PGSIZE);
    uvm_map(p->pagetable, a, (uint64)mem, PTE_R | PTE_W | PTE_U);
    return 1;
}
```

이렇게 16KB를 전부 미리 매핑해 두면, 나중에 스레드가 `ecall`할 때 트랩 프레임 저장 영역(`sp-256`)이 **이미 매핑돼 있어** 커널이 폴트를 안 내요.
실제 OS도 비슷한 처리를 해요 — 스레드 스택을 미리 커밋(commit)하거나, 스택 끝에 가드 페이지를 둬서 폴트를 제어된 방식으로 잡죠.
우리가 한 pre-fault는 그 "미리 커밋"의 가장 단순한 형태예요.

## 5. 유저 공간 컨텍스트 스위치 — uswitch

두 벽을 다 넘었으니, 이제 진짜 핵심인 **흐름 갈아타기**예요.

### 커널 swtch와 같은 원리

스레드를 갈아타는 건 [커널의 `swtch`](/blog/hobby/hobby-kernel-03-exec-and-shell)와 **완전히 똑같은 원리**예요.
callee-saved 레지스터와 `ra`, `sp`를 메모리에 저장하고 다른 묶음에서 복원하면, 마지막 `ret`이 **다른 실행 흐름**으로 점프해요.
다른 점은 단 하나 — 이건 커널이 아니라 **유저 공간에서 도는 `uswitch`**라는 것뿐이에요. 특권 명령이 하나도 없어서 유저 모드에서 그대로 돌아갑니다.

```asm
uswitch:                  # uswitch(old, new)  — old=a0, new=a1
  sd ra,0(a0); sd sp,8(a0)                      # old에 ra, sp 저장
  sd s0,16(a0); sd s1,24(a0) ... sd s11,104(a0) # old에 s0~s11 저장
  ld ra,0(a1); ld sp,8(a1)                      # new에서 ra, sp 복원
  ld s0,16(a1); ld s1,24(a1) ... ld s11,104(a1) # new에서 s0~s11 복원
  ret                     # new->ra로 점프 → 다른 흐름으로
```

저장/복원하는 레지스터는 정확히 14개예요 — `ra`, `sp`, 그리고 `s0`~`s11`.
왜 이 14개만일까요? `a0`~`a7`이나 `t0`~`t6` 같은 caller-saved 레지스터는 **함수 호출 규약(ABI)상 호출자가 알아서 저장**하기로 약속돼 있어서, `uswitch`를 함수로 부르는 순간 이미 컴파일러가 챙겼거든요.
그래서 `swtch`/`uswitch`는 **callee-saved만** 저장하면 충분해요. 이게 RISC-V calling convention을 그대로 활용하는 부분이에요.

### uyield / texit — 스케줄러에 양보하기

스레드는 두 가지 방법으로 흐름을 내려놔요.

```c
// 현재 스레드 → 스케줄러로 양보(나중에 스케줄러가 이 자리로 다시 들어온다)
static void uyield(void) {
    int c = S->current;
    uswitch(&S->t[c].ctx, &S->sched);   // 내 ctx 저장, 스케줄러 ctx 복원
}

// 스레드 종료: 상태를 끄고 스케줄러로(다시 돌아오지 않는다)
static void texit(void) {
    int c = S->current;
    S->t[c].state = 0;                  // 더는 runnable이 아니라고 표시
    uswitch(&S->t[c].ctx, &S->sched);
}
```

`uyield()`는 자기 ctx를 저장하고 스케줄러 ctx로 갈아타요. 나중에 스케줄러가 이 스레드를 다시 고르면, 저장해 둔 ctx에서 복원되어 **`uyield()` 다음 줄부터** 이어 달려요.
`texit()`는 거의 같지만 자기 `state`를 0으로 꺼서, 스케줄러가 다신 이 스레드를 안 고르게 해요.

### 스케줄러 — round-robin

스케줄러는 그냥 runnable 스레드를 한 바퀴씩 돌아가며 깨우는 루프예요.

```c
for (;;) {
    int ran = 0;
    for (int i = 0; i < NTHREAD; i++) {
        if (S->t[i].state == 1) {
            S->current = i;
            uswitch(&S->sched, &S->t[i].ctx);   // 스레드로 진입
            ran = 1;                             // 스레드가 양보/종료하면 여기로 복귀
        }
    }
    if (!ran) break;                             // 모두 종료되면 끝
}
```

`uswitch(&S->sched, &S->t[i].ctx)`로 스레드에 들어가면, 그 스레드가 `uyield()`나 `texit()`로 다시 `&S->sched`를 복원할 때까지 스케줄러는 그 한 줄에 "멈춰" 있어요.
스레드가 양보하면 바로 그 자리로 돌아와 다음 `i`로 넘어가죠. 이게 협조적 스케줄링의 전부예요 — **양보 지점이 곧 전환 지점**이에요.

### 새 스레드는 어떻게 "시작"되나

마지막 퍼즐 — 한 번도 안 돌아본 스레드를 어떻게 처음 깨울까요?

```c
static void tcreate(int i, void (*fn)(void)) {
    S->t[i].state = 1;
    S->t[i].ctx.ra = (unsigned long)fn;                              // 복귀 주소 = 스레드 함수
    S->t[i].ctx.sp = ((unsigned long)&S->stacks[i][STACKSZ]) & ~15UL; // sp = 자기 스택 꼭대기(16B 정렬)
    for (int k = 0; k < 12; k++) S->t[i].ctx.s[k] = 0;
}
```

트릭은 **ctx를 "이미 한 번 멈춘 적 있는 스레드"인 척 위조**하는 거예요.
`ra`를 스레드 함수 주소로, `sp`를 그 스레드의 힙 스택 꼭대기로 세팅해 두면, 스케줄러가 처음 `uswitch`로 이 ctx를 복원하는 순간 — `ret`이 `ra`(=함수)로 점프하고, `sp`는 깨끗한 자기 스택을 가리켜요.
스레드 입장에선 마치 자기 함수로 "복귀"한 것처럼 자연스럽게 시작돼요. 스택이 16바이트 정렬인 것도 RISC-V ABI 요구사항이라 맞춰 줍니다.

## 6. 눈으로 확인하기

셸에서 `uthread`를 돌리면, 세 스레드가 협조적으로 번갈아 돌아요.

```
hobby> uthread
uthread: cooperative user threads (state on heap, no kernel changes)
  [thread A] step 1
  [thread B] step 1
  [thread C] step 1
  [thread A] step 2
  [thread B] step 2
  [thread C] step 2
  [thread A] step 3
  [thread B] step 3
  [thread C] step 3
  [thread A] done
  [thread B] done
  [thread C] done
uthread: all threads finished
```

`A→B→C→A→B→C...` 깔끔한 round-robin이에요.
출력 한 줄 한 줄을 따라가 보면 전체 그림이 보여요 — A가 step 1을 찍고 `uyield()`로 양보하면, 스케줄러가 B를 깨우고, B도 한 번 찍고 양보하고… 세 스레드가 각자 자기 힙 스택 위에서 자기 진도(`step 1→2→3→done`)를 들고 번갈아 달려요.
각 스레드가 `done`을 찍고 `texit()`로 `state`를 끄면, 스케줄러는 다음 바퀴에서 그 스레드를 건너뛰고, 셋 다 꺼지면 루프가 끝나 `all threads finished`가 찍혀요.

여기서 가장 중요한 사실 — **커널은 이게 한 프로세스인 줄만 알아요.**
세 흐름의 교대는 전부 유저 공간에서, 우리가 만든 `uswitch` 한 함수로 일어났어요. 커널 스케줄러는 이 셋의 존재조차 모릅니다.
스레드가 `sys_putchar`로 `ecall`할 때만 잠깐 커널에 들어가는데, 그건 글자 하나 찍으려는 거지 흐름을 갈아타려는 게 아니에요.

## 7. 되짚기 — 협조적 vs 선점적, 그리고 M:N

### 우리가 만든 건 협조적 스레드다

우리 유저 스레드는 **협조적(cooperative)** 이에요.
스레드가 **스스로** `uyield()`를 불러야 다른 스레드가 돌 기회를 얻어요.
어떤 스레드가 양보를 안 하고 무한 루프를 돌면? 나머지는 영영 못 돌아요. 전환을 강제할 수단이 유저 공간엔 없거든요.

[커널 스케줄러(4편)](/blog/hobby/hobby-kernel-03-exec-and-shell)는 달랐죠 — 그건 **선점적(preemptive)** 이었어요.
타이머 인터럽트가 주기적으로 커널에 들어와 `yield()`를 강제로 불러, 양보 안 하는 프로세스도 CPU를 빼앗았어요.

| 구분 | 협조적 (이 글의 uthread) | 선점적 (4편 커널 스케줄러) |
|------|------------------------|--------------------------|
| 전환을 누가 일으키나 | 스레드 스스로 `uyield()` | 타이머 인터럽트가 강제 |
| 전환 비용 | 싸다 (레지스터 14개, 커널 진입 없음) | 비싸다 (트랩 진입+프레임 저장) |
| 폭주 스레드 | 한 스레드가 멈추면 전부 멈춤 | 강제로 빼앗아 격리됨 |
| 필요한 장치 | 없음 (유저 코드만) | 타이머 인터럽트 + 커널 |

유저 스레드를 선점적으로 만들려면 타이머 시그널(유닉스의 `SIGALRM` 같은)을 유저 공간으로 배달해야 하는데, 그건 **시그널 메커니즘**이라는 또 다른 큰 주제예요.

### 유저 스레드 vs 커널 스레드

| 구분 | 유저 스레드(M) | 커널 스레드(N) |
|------|---------------|---------------|
| 누가 만들고 스케줄링하나 | 유저 런타임 | 커널 |
| 커널이 보는 흐름 수 | 1 (한 프로세스) | N (스레드마다) |
| 전환 비용 | 매우 쌈 (유저 공간 레지스터 교체) | 트랩+커널 스케줄러 |
| 블로킹 시스템콜 | 하나가 막히면 **전부** 막힘 | 하나만 막히고 나머지는 진행 |
| 멀티코어 활용 | 불가 (커널엔 한 프로세스=한 코어) | 가능 (커널이 코어에 분산) |

**유저 스레드의 트레이드오프**가 여기서 선명해져요.

- **장점**: 전환이 싸다(커널 진입 없이 레지스터 14개만). 커널은 스레드의 존재조차 모른다. 스레드를 수천 개 만들어도 커널 자원을 안 먹는다.
- **단점**: 한 스레드가 블로킹 시스템콜을 하면 프로세스 전체가 멈춘다(커널은 한 흐름만 보니까). 멀티코어를 못 쓴다(커널에겐 한 프로세스라 한 코어).

> **흔한 오해 정정**: *"유저 스레드가 커널 스레드보다 무조건 빠르다"* 는 절반만 맞아요. **전환**은 분명 싸지만, **블로킹 I/O와 멀티코어**에서 손해를 봐요. 그래서 둘 중 하나를 고르는 문제가 아니라, 둘을 **겹쳐 쓰는** 게 현대적 답이에요.

### M:N 하이브리드 — 그리고 우리가 만든 것

그래서 현대 런타임(Go의 고루틴 등)은 유저 스레드(M개)를 커널 스레드(N개) 위에 얹는 **M:N 하이브리드**를 써요.
가볍고 빠른 유저 스레드를 수천 개 만들되, 그걸 몇 개의 커널 스레드에 분산해 멀티코어도 쓰고 블로킹도 우회해요.

우리가 만든 건 그 M:N의 **'M' 쪽 — 가장 밑바닥의 협조적 전환**이에요.
`uswitch`로 흐름을 갈아타는 이 핵심 메커니즘이, 화려한 런타임 스케줄러들의 맨 아래에 깔린 바로 그 부품이에요.

> **핵심 교훈**: 고루틴 같은 화려한 추상화도, 맨 밑바닥은 결국 *"레지스터 한 묶음을 저장하고 다른 묶음을 불러오는"* `uswitch`예요. 그 한 함수를 직접 짜 보면, 그 위에 쌓인 모든 게 덜 마법처럼 보입니다.

## 정리

이 글은 **커널의 도움 없이 한 프로세스 안에서 실행 흐름을 갈아타는** 협조적 유저 스레드를 만들었어요. 핵심을 다시 모으면:

- **문제** — "흐름을 갈아탄다"는 건 본질적으로 **레지스터 한 묶음(ra/sp/s0~s11)을 저장하고 복원하는 일**이라, 특권 명령이 없어 유저 공간에서도 가능하다.
- **첫 번째 벽(전역)** — 코드가 단일 페이지(`R|X`)라 `.data`/`.bss`에 못 쓴다. 전역 대신 **힙 고정 주소 `(struct sys*)0x10000`**(전역이 아니라 포인터 상수라 `.data` 미사용)에 상태를 올려 우회했다.
- **두 번째 벽(트랩 프레임)** — 스레드가 `ecall`하면 커널이 트랩 프레임을 `sp-256`(힙 스택)에 저장하다 미매핑 페이지를 만나 **커널** 페이지 폴트를 냈다. `sbrk` 후 힙 페이지를 **pre-fault**해 미리 매핑해 풀었다.
- **uswitch** — 커널 `swtch`와 같은 원리로 callee-saved 14개를 저장/복원 후 `ret`. `uyield`/`texit`로 양보하고, round-robin 스케줄러가 깨운다.
- **트레이드오프** — 협조적이라 전환은 싸지만 폭주·블로킹·멀티코어에 약하다. 그래서 현대 런타임은 M:N으로 겹쳐 쓰고, 우리가 만든 건 그 'M' 쪽 밑바닥이다.

두 벽 모두 처음 실패의 원인이었고, **커널을 한 줄도 안 고치고** 두 가지 우회로 풀었어요.

### 연재 전체 회고 — 부팅부터 유저 스레드까지

부팅의 첫 글자(`1편`)부터 여기까지 왔어요.
[부팅·페이징](/blog/hobby/hobby-kernel-00-boot-to-paging), [유저모드·프로세스](/blog/hobby/hobby-kernel-01-usermode-to-processes), 시스템콜, fork/exec, [선점형 스케줄러](/blog/hobby/hobby-kernel-03-exec-and-shell), 파일시스템, [demand paging·mmap](/blog/hobby/hobby-kernel-04-paging-mmap-writable-fs), [멀티코어와 락](/blog/hobby/hobby-kernel-05-smp-multicore-locks), 네트워크(UDP·TCP), [copy-on-write](/blog/hobby/hobby-kernel-07-copy-on-write), 저널링, 그리고 이 유저 스레드까지.
교과서의 그림들을 하나하나 직접 코드로 만져봤어요.

이 마지막 작업이 특히 의미 있었던 건, **한 번 실패했던 걸 되돌아와 풀었기** 때문이에요.
실패의 진짜 원인(전역 제약 + 트랩 프레임 폴트)은 코드만 읽어선 안 보였고, 직접 돌려 크래시 로그(`scause`/`sepc`/`stval`)를 한 줄씩 읽어야 보였어요.
"OS가 안에서 어떻게 도는가"를 알고 싶어 시작한 여정에서, **가장 많이 배운 건 언제나 막히고, 깨지고, 추적한 지점들**이었어요.
잘 도는 코드는 빠르게 지나갔지만, 죽은 코드 앞에서 `sepc`가 왜 커널 주소인지 따져 묻던 순간들이 진짜 공부였습니다.

좋은 지도(xv6)를 따라왔지만, 그 지도에 없는 우리만의 골목들 — 단일 페이지 모델, 유저 스택 위의 트랩 프레임, 락 baton, `tp` 복구 — 을 직접 헤쳐 나온 게 가장 남는 부분이에요.
지도는 길을 알려주지만, 길을 걸어 본 사람만 그 길의 진짜 모양을 알아요.

읽어주셔서 고마워요.
여기까지가 **C로 만드는 토이 커널**, 부팅부터 유저 스레드까지의 기록이에요.

> 코드: [github.com/dj258255/hobby-kernel](https://github.com/dj258255/hobby-kernel)

## 참고 (1차 자료 우선)

- [xv6: a simple, Unix-like teaching operating system (MIT 6.S081)](https://pdos.csail.mit.edu/6.828/2023/xv6.html) — 이 글의 직접 출발점인 **uthread 랩**(유저 공간 스레드 전환의 표준 교보재)
- [RISC-V Calling Convention / ABI (psABI)](https://github.com/riscv-non-isa/riscv-elf-psabi-doc) — callee-saved(`s0`~`s11`) vs caller-saved, `sp` 16바이트 정렬 규칙의 1차 정의 (`uswitch`가 왜 14개만 저장하는지의 근거)
- [RISC-V Privileged Specification](https://riscv.org/technical/specifications/) — `scause`/`sepc`/`stval` 트랩 CSR의 정의 (크래시 추적에 읽은 그 값들)
- 관련 글: [부팅부터 페이징까지](/blog/hobby/hobby-kernel-00-boot-to-paging) · [선점형 스케줄러](/blog/hobby/hobby-kernel-03-exec-and-shell) · [demand paging·mmap](/blog/hobby/hobby-kernel-04-paging-mmap-writable-fs) · [멀티코어와 락](/blog/hobby/hobby-kernel-05-smp-multicore-locks)

<!-- EN -->

*A RISC-V toy kernel built from scratch — a blog series. This is the final part: cooperative user threads (uthread).*

## 0. Introduction

So far in this kernel, everything that "runs concurrently" was created **by the kernel**.
[The scheduler in Part 4](/blog/hobby/hobby-kernel-03-exec-and-shell) switched processes; [multicore in Part 6](/blog/hobby/hobby-kernel-05-smp-multicore-locks) split the cores.
Both share one thing — **the kernel makes the decision to switch.** A timer interrupt enters the kernel, the kernel's `swtch` jumps to the next flow, the kernel swaps page tables.

This post flips that premise once.
Can we switch execution flows **with no help from the kernel, inside a single process, purely in user space**?
The answer is yes, and that's a **user thread** (user-level thread, green thread). The kernel just sees it as one ordinary process, while several flows take turns among themselves inside it.

Honestly, this topic is one I **failed at and reverted** earlier in this series.
I charged in thinking "just write it the textbook way," watched the worker run on a bogus stack and die, couldn't see the cause, and reverted the whole thing.
This post pulls that failure back out, tracks down **the two real causes** to the end, and solves them without changing the kernel by a single line.
Since this is the final part of the series, at the end I also look back on the whole journey from boot to here.

## 1. The Real Problem User Threads Have to Solve

> With no help at all from the kernel, how do you switch execution flows inside a single process? Can you turn "the CPU currently running function A" into "the CPU that was running function B" without a single system call?

When we say "thread," we usually picture the kernel making it — `clone`/`pthread_create` enters the kernel via a system call, and the kernel builds a new kernel stack and a scheduling entry.
But if you look at the **essence** of "switching execution flows," the kernel isn't strictly required.

A CPU's execution flow is, in the end, **one bundle of registers** — which instruction it's running (`pc`/`ra`), where its stack is (`sp`), and the live values (callee-saved registers like `s0`~`s11`).
So "switching flows" is just **saving this register bundle to memory and loading another one**. User code can do that perfectly well — no privileged instruction is involved.

But when I actually wrote it in our kernel, I ran straight into **two walls specific to our design** that aren't in any textbook.

1. **Globals don't work** — the user program's code is mapped as a single page (`R|X`), so the `.data`/`.bss` where the thread table would live isn't writable.
2. **The kernel dies the moment a thread does `ecall`** — our trap entry saves the trap frame just below the user stack, and that spot is a not-yet-mapped heap page, so the **kernel** took a page fault.

Both walls caused the original failure, and neither was visible from reading the code statically — they only showed up after I ran it and traced the crash.
Half this post is the story of tracing and routing around those two walls.

## 2. The First Wall — the Trap of Globals

### Background: the textbook implementation uses globals

> A thread system has to hold "the list of threads" and "who is running now" somewhere. Where does the textbook put it?

The standard user-thread implementation (xv6's uthread lab) puts all of that in **global variables**.

```c
struct thread all_thread[NTHREAD];   // global
struct thread *current_thread;       // global
```

A global points at the same single place from anywhere in the program, so it's a natural home for the thread table.
In an ordinary environment there's no problem — `.data`/`.bss` is of course writable.

### But it broke in our kernel

Our own design tripped us — **a user program's code is mapped as a single page (`R|X`) only**.
As we saw in [Part 1](/blog/hobby/hobby-kernel-00-boot-to-paging), page permissions can differ per region, and a code page is `R|X` (read/execute, **no write**).
But our user program *is* just that one code page, so the `.data`/`.bss` where globals live ends up riding on the same `R|X` page.

The result is plain — **the moment you write to a global, you get a write-protection fault.**
The original failure was exactly this. Writing to the global `current_thread` filled the thread context (especially `sp`) with the wrong value, the worker grabbed garbage `sp`, ran on a bogus stack, and died.
The symptom (bogus stack) and the cause (globals not writable) were far apart, so it didn't show up at a glance.

> **Common misconception fix**: it's easy to think *"a global is just memory, so it's always writable."* It isn't. What matters is **which page a global is mapped on, with what permissions.** Ordinary OSes map `.data`/`.bss` as a separate `R|W` segment, so you never notice; in a minimal model like ours that hands out only one code page, *"write to a global"* *is* *"write to the code page,"* and it's blocked.

### The fork: change the kernel, or not?

There were two ways out.

| Option | What it does | Cost | Meaning |
|--------|-------------|------|---------|
| ① Add a data segment | Map a separate `R|W` `.data`/`.bss` into the user address space | **Have to change the kernel/loader** | "The proper way." But it breaks this post's premise (no kernel changes) |
| ② Don't use globals | Put the state on the writable heap | One code trick | Solve it without touching the kernel at all |

I chose **option ②**.
We already built a [demand-paging heap in Part 5](/blog/hobby/hobby-kernel-04-paging-mmap-writable-fs), and that heap is mapped `R|W`, so it's writable.
So if we put all the thread state on the **heap** instead of in globals, we sidestep the single-page constraint head-on.

> **Key takeaway**: hitting a constraint doesn't always mean you have to change the system. If you first ask *"what is writable here,"* you'll often find a way around using a resource you already have (the heap, in this case).

## 3. Without Globals — the Fixed Heap Address Trick

The key trick is this.
Place the entire thread-system struct at a **fixed address** in the heap (our heap's start, `0x10000`).

```c
#define HEAPBASE 0x10000UL
#define NTHREAD  3
#define STACKSZ  2048

struct ctx    { unsigned long ra, sp, s[12]; };   // ra, sp, s0..s11 = 14 regs (112 bytes)
struct thread { struct ctx ctx; int state; };     // state: 0=exited/unused, 1=runnable
struct sys {
    struct ctx     sched;                          // scheduler context
    struct thread  t[NTHREAD];
    int            current;                         // current thread index
    unsigned char  stacks[NTHREAD][STACKSZ];        // per-thread stack (on heap)
};
#define S ((volatile struct sys *)HEAPBASE)
```

The magic is in that last `#define`.
`(struct sys *)0x10000` is **not a global variable but a pointer constant**.
To the compiler this is "stamp the number 0x10000 into a register as an immediate," so **nothing lands in `.data`.** It therefore works fine even on an `R|X` code page — because nothing is written there.
And the 0x10000 the pointer *points to* is the heap, which is writable.

Now all state is accessed through this single pointer — `S->current`, `S->t[i].state`, `S->stacks[i]`, and so on.
The struct itself *and* the per-thread stacks all live inside `struct sys`, so one chunk of heap *is* the whole thread system.

The one-line reason this works — build it, and there are **zero globals** (`bss=0, data=0`).
Everything the textbook solved with globals is moved to "fixed address on the heap + a pointer constant." It sidesteps the single-page constraint head-on.

| Aspect | Textbook (xv6 uthread) | Our kernel (uthread.c) |
|--------|------------------------|------------------------|
| Where the thread table lives | global `.data`/`.bss` | fixed heap address `0x10000` |
| How it's accessed | `all_thread[i]` (global symbol) | `S->t[i]` (pointer constant → heap) |
| Page permission needed | assumes `.data` is `R\|W` | code `R\|X` + heap `R\|W` |
| Number of globals | several | **zero** (`bss=0, data=0`) |
| Kernel change | (lab env provides a data segment) | **none** |

## 4. The Second Wall — a Trap Frame on a Heap Stack

### Killing the globals revealed a new crash

Once globals were moved to the heap, the threads finally started running.
`"  [thread A] step 1"` printed on screen — the moment the first flow came alive on its own heap stack.
But switching to the next thread blew up with a page fault **in kernel mode**.

```
[trap] EXCEPTION  scause=0xf  sepc=0x8020003e  stval=0x11000
```

Reading this one line is the whole game.
- `scause=0xf` → store/AMO page fault (a fault while writing)
- `stval=0x11000` → the faulting address is in the user heap region
- `sepc=0x8020003e` → **the instruction that faulted is at a kernel address (0x8020...)**

That last line is decisive. It means **the kernel**, not user code, faulted while writing to a user heap address.

### The culprit: our trap-entry path

The culprit is our [trap handling](/blog/hobby/hobby-kernel-01-usermode-to-processes).
On a trap, our kernel **saves the trap frame just below the current `sp`.** The very first line of `kernelvec.S` does it.

```asm
# kernelvec.S — the very first thing on a trap
kernelvec:
        addi    sp, sp, -256    # drop 256 bytes from the current sp for the frame
        sd      ra,    0(sp)    # and save all registers there
        sd      gp,    8(sp)
        ...                     # ra, gp, tp, t0..t6, s0..s11, a0..a7, sepc, sstatus
```

For an ordinary process this `sp` is the kernel stack, so no problem. But a user thread does its `ecall` **with the user-mode `sp` pointing at a heap stack.**
When a thread running on a heap stack (say `0x111E0`) calls `sys_putchar` via `ecall`, the kernel subtracts 256 from that `sp` and starts writing the frame at `0x110E0`.
But if that heap page hasn't been mapped yet by [demand paging](/blog/hobby/hobby-kernel-04-paging-mmap-writable-fs), the kernel's `sd` instruction faults writing to an unmapped address.

In other words, **user-stack demand paging** and **our design where "the kernel saves the trap frame onto the user stack"** collided head-on.
An ordinary OS saves the trap frame on a separate kernel stack (always mapped), so this collision never happens; our minimal model handles both on one stack, which is how this alleyway appeared.

> **Common misconception fix**: "page fault" makes you think *"a bug in the user program"* first, but here the one who faulted is the **kernel** (`sepc` is a kernel address). Demand paging is built assuming the fault happens in **user mode**, but the trap-frame save happens **right after we've already entered kernel mode.** A fault at that instant is usually treated as a "real fault" and not recoverable. So instead of relying on demand paging, we had to **map it ahead of time.**

### The fix: pre-fault the heap pages

The fix is surprisingly simple — *before* running the threads, **touch the heap pages up front** to map them all.

```c
sys_sbrk(16384);                                  // grow the heap by 16KB (reserve addresses; no physical pages yet)
for (unsigned long a = 0; a < 16384; a += 4096)   // touch each 4KB page up front
    *((volatile unsigned char *)(HEAPBASE + a)) = 0;
```

The mechanism dovetails exactly with our [demand-paging branch](/blog/hobby/hobby-kernel-04-paging-mmap-writable-fs).
`sys_sbrk(16384)` only bumps `heap_top` to reserve the address range; it doesn't hand out physical pages yet (lazy allocation).
Then the loop touches each page once, so a fault happens safely **in user mode**, and `proc_pagefault` takes the heap branch and maps a fresh page as `R|W|U`.

```c
// proc.c — if the fault is in the heap region, map a fresh page on the spot (demand paging)
if (a >= HEAPBASE && a < p->heap_top) {
    char *mem = kalloc();
    if (!mem) return 0;
    zero(mem, PGSIZE);
    uvm_map(p->pagetable, a, (uint64)mem, PTE_R | PTE_W | PTE_U);
    return 1;
}
```

Once all 16KB is mapped ahead of time, later when a thread does an `ecall`, the trap-frame save area (`sp-256`) is **already mapped**, so the kernel doesn't fault.
Real OSes do similar things — pre-committing thread stacks, or putting a guard page at the stack's edge to catch faults in a controlled way.
Our pre-fault is the simplest form of that "pre-commit."

## 5. The User-Space Context Switch — uswitch

With both walls cleared, now the real heart of it — **switching flows.**

### Same principle as the kernel's swtch

Switching threads works **exactly** like [the kernel's `swtch`](/blog/hobby/hobby-kernel-03-exec-and-shell).
Save the callee-saved registers, `ra`, and `sp` to memory, restore them from another bundle, and the final `ret` jumps into **a different execution flow**.
The only difference is one thing — this is **`uswitch`, running in user space**, not the kernel. There's not a single privileged instruction, so it runs in user mode as-is.

```asm
uswitch:                  # uswitch(old, new)  — old=a0, new=a1
  sd ra,0(a0); sd sp,8(a0)                      # save ra, sp to old
  sd s0,16(a0); sd s1,24(a0) ... sd s11,104(a0) # save s0~s11 to old
  ld ra,0(a1); ld sp,8(a1)                      # restore ra, sp from new
  ld s0,16(a1); ld s1,24(a1) ... ld s11,104(a1) # restore s0~s11 from new
  ret                     # jump to new->ra → into the other flow
```

The saved/restored registers are exactly 14 — `ra`, `sp`, and `s0`~`s11`.
Why only these 14? Caller-saved registers like `a0`~`a7` and `t0`~`t6` are, by the **calling convention (ABI), the caller's responsibility to save**, so the moment you call `uswitch` as a function the compiler already took care of them.
That's why `swtch`/`uswitch` only need to save the **callee-saved** set. This is where we lean directly on the RISC-V calling convention.

### uyield / texit — yielding to the scheduler

A thread sets down its flow in two ways.

```c
// current thread → yield to the scheduler (the scheduler re-enters this spot later)
static void uyield(void) {
    int c = S->current;
    uswitch(&S->t[c].ctx, &S->sched);   // save my ctx, restore the scheduler ctx
}

// thread exit: turn off the state and go to the scheduler (never returning here)
static void texit(void) {
    int c = S->current;
    S->t[c].state = 0;                  // mark "no longer runnable"
    uswitch(&S->t[c].ctx, &S->sched);
}
```

`uyield()` saves its own ctx and switches to the scheduler ctx. Later, when the scheduler picks this thread again, it restores from the saved ctx and resumes **from the line after `uyield()`.**
`texit()` is almost the same but turns its own `state` to 0, so the scheduler never picks this thread again.

### The scheduler — round-robin

The scheduler is just a loop that wakes runnable threads one at a time, in turns.

```c
for (;;) {
    int ran = 0;
    for (int i = 0; i < NTHREAD; i++) {
        if (S->t[i].state == 1) {
            S->current = i;
            uswitch(&S->sched, &S->t[i].ctx);   // enter the thread
            ran = 1;                             // we return here when it yields/exits
        }
    }
    if (!ran) break;                             // all threads exited → done
}
```

When we enter a thread with `uswitch(&S->sched, &S->t[i].ctx)`, the scheduler "stops" on that line until the thread restores `&S->sched` again via `uyield()` or `texit()`.
When the thread yields, we return to exactly that spot and move on to the next `i`. That's all of cooperative scheduling — **the yield point is the switch point.**

### How a fresh thread "starts"

The last puzzle — how do you first wake a thread that has never run?

```c
static void tcreate(int i, void (*fn)(void)) {
    S->t[i].state = 1;
    S->t[i].ctx.ra = (unsigned long)fn;                              // return address = thread function
    S->t[i].ctx.sp = ((unsigned long)&S->stacks[i][STACKSZ]) & ~15UL; // sp = top of its own stack (16B aligned)
    for (int k = 0; k < 12; k++) S->t[i].ctx.s[k] = 0;
}
```

The trick is to **forge a ctx that pretends to be a thread that has already stopped once.**
Set `ra` to the thread-function address and `sp` to the top of that thread's heap stack, and the moment the scheduler first restores this ctx with `uswitch` — `ret` jumps to `ra` (the function), and `sp` points at a clean, private stack.
From the thread's point of view it starts naturally, as if it "returned" into its own function. The 16-byte stack alignment is a RISC-V ABI requirement, so we honor it.

## 6. Seeing It With Your Own Eyes

Running `uthread` from the shell, three threads take turns cooperatively.

```
hobby> uthread
uthread: cooperative user threads (state on heap, no kernel changes)
  [thread A] step 1
  [thread B] step 1
  [thread C] step 1
  [thread A] step 2
  [thread B] step 2
  [thread C] step 2
  [thread A] step 3
  [thread B] step 3
  [thread C] step 3
  [thread A] done
  [thread B] done
  [thread C] done
uthread: all threads finished
```

`A→B→C→A→B→C...` a clean round-robin.
Follow the output line by line and the whole picture appears — A prints step 1 and yields with `uyield()`, the scheduler wakes B, B prints once and yields… three threads each run on their own heap stack, carrying their own progress (`step 1→2→3→done`), taking turns.
When each thread prints `done` and turns off its `state` with `texit()`, the scheduler skips it on the next lap, and once all three are off the loop ends and `all threads finished` prints.

The most important fact here — **the kernel only knows it's one process.**
The interleaving of three flows all happened in user space, through the single `uswitch` function we built. The kernel scheduler doesn't even know these three exist.
The only time a thread briefly enters the kernel is for `sys_putchar`'s `ecall` — and that's to print one character, not to switch flows.

## 7. Looking Back — Cooperative vs Preemptive, and M:N

### What we built is a cooperative thread

Our user threads are **cooperative.**
A thread must call `uyield()` **itself** for any other thread to get a chance to run.
What if a thread never yields and spins forever? The rest never run. There's no way to force a switch from user space.

The [kernel scheduler (Part 4)](/blog/hobby/hobby-kernel-03-exec-and-shell) was different — that one was **preemptive.**
A timer interrupt periodically entered the kernel and forcibly called `yield()`, taking the CPU even from a process that wouldn't give it up.

| Aspect | Cooperative (this post's uthread) | Preemptive (Part 4 kernel scheduler) |
|--------|-----------------------------------|--------------------------------------|
| Who triggers the switch | the thread itself via `uyield()` | a timer interrupt, forcibly |
| Switch cost | cheap (14 registers, no kernel entry) | expensive (trap entry + frame save) |
| Runaway thread | one stalling stalls all | forcibly preempted, isolated |
| Hardware needed | none (user code only) | timer interrupt + kernel |

To make user threads preemptive you'd have to deliver a timer signal (like Unix's `SIGALRM`) into user space — and that's the whole other big topic of **signal mechanisms.**

### User threads vs kernel threads

| Aspect | User thread (M) | Kernel thread (N) |
|--------|-----------------|-------------------|
| Who creates and schedules | the user runtime | the kernel |
| Flows the kernel sees | 1 (one process) | N (one per thread) |
| Switch cost | very cheap (swap registers in user space) | trap + kernel scheduler |
| Blocking system call | one blocks → **all** block | one blocks, the rest proceed |
| Multicore use | impossible (one process = one core to the kernel) | possible (kernel spreads across cores) |

The **trade-offs of user threads** come into sharp focus here.

- **Pros**: switching is cheap (no kernel entry, just 14 registers). The kernel doesn't even know the threads exist. You can make thousands of threads without eating kernel resources.
- **Cons**: if one thread makes a blocking system call, the whole process stalls (the kernel sees only one flow). You can't use multiple cores (to the kernel it's one process, one core).

> **Common misconception fix**: *"user threads are always faster than kernel threads"* is only half true. **Switching** is indeed cheap, but you lose on **blocking I/O and multicore.** So it's not a pick-one problem — the modern answer is to **layer them together.**

### The M:N hybrid — and what we built

That's why modern runtimes (Go's goroutines, etc.) use an **M:N hybrid**, layering user threads (M) over kernel threads (N).
They make thousands of light, fast user threads but spread them across a few kernel threads, so they get multicore *and* route around blocking.

What we built is the **'M' side of that M:N — the lowest-level cooperative switch.**
This core mechanism, switching flows with `uswitch`, is the very part that sits at the bottom of all those fancy runtime schedulers.

> **Key takeaway**: even a fancy abstraction like a goroutine is, at the very bottom, just `uswitch` — *"save one register bundle and load another."* Write that one function yourself and everything stacked on top of it looks a lot less magical.

## Wrap-up

This post built cooperative user threads that **switch execution flows inside a single process with no help from the kernel.** Pulling the core back together:

- **The problem** — "switching flows" is essentially **saving and restoring one register bundle (ra/sp/s0~s11)**, and since there's no privileged instruction, user space can do it.
- **The first wall (globals)** — code is a single page (`R|X`), so you can't write to `.data`/`.bss`. We routed around it by putting state at the **fixed heap address `(struct sys*)0x10000`** (a pointer constant, not a global, so no `.data` use).
- **The second wall (trap frame)** — when a thread does `ecall`, the kernel saves the trap frame at `sp-256` (a heap stack) and hits an unmapped page, taking a **kernel** page fault. We fixed it by **pre-faulting** the heap pages after `sbrk` to map them ahead of time.
- **uswitch** — same principle as the kernel's `swtch`: save/restore the 14 callee-saved registers, then `ret`. Threads yield via `uyield`/`texit`, and a round-robin scheduler wakes them.
- **Trade-offs** — being cooperative, switching is cheap but it's weak to runaways, blocking, and multicore. So modern runtimes layer them as M:N, and what we built is the bottom of that 'M' side.

Both walls caused the original failure, and we solved them with two workarounds, **changing the kernel not at all.**

### Looking back on the whole series — from boot to user threads

From the first character of boot (`Part 1`) to here.
[Boot and paging](/blog/hobby/hobby-kernel-00-boot-to-paging), [user mode and processes](/blog/hobby/hobby-kernel-01-usermode-to-processes), system calls, fork/exec, [the preemptive scheduler](/blog/hobby/hobby-kernel-03-exec-and-shell), the filesystem, [demand paging and mmap](/blog/hobby/hobby-kernel-04-paging-mmap-writable-fs), [multicore and locks](/blog/hobby/hobby-kernel-05-smp-multicore-locks), networking (UDP·TCP), [copy-on-write](/blog/hobby/hobby-kernel-07-copy-on-write), journaling, and this user thread.
I got to touch the textbook diagrams as real code, one by one.

This last piece was especially meaningful because it was **coming back to something I'd failed at and solving it.**
The real causes of the failure (the global constraint + the trap-frame fault) weren't visible from reading the code; I had to run it and read the crash logs (`scause`/`sepc`/`stval`) line by line to see them.
On a journey that began wanting to know "how an OS runs inside," **what I learned most from was always the places where I got stuck, broke things, and traced them down.**
Working code flew by, but the moments standing in front of dead code asking *why is `sepc` a kernel address?* were the real studying.

I followed a good map (xv6), but what stayed with me most was fighting through our own alleyways that weren't on it — the single-page model, the trap frame on the user stack, the lock baton, the `tp` restore.
A map tells you the way, but only someone who has walked it knows the road's real shape.

Thank you for reading.
This is the end of **A Toy Kernel in C**, the record from boot to user threads.

> Code: [github.com/dj258255/hobby-kernel](https://github.com/dj258255/hobby-kernel)

## References (Primary Sources First)

- [xv6: a simple, Unix-like teaching operating system (MIT 6.S081)](https://pdos.csail.mit.edu/6.828/2023/xv6.html) — the direct starting point for this post, the **uthread lab** (the standard teaching material for user-space thread switching)
- [RISC-V Calling Convention / ABI (psABI)](https://github.com/riscv-non-isa/riscv-elf-psabi-doc) — the primary definition of callee-saved (`s0`~`s11`) vs caller-saved and the 16-byte `sp` alignment rule (why `uswitch` saves only 14 registers)
- [RISC-V Privileged Specification](https://riscv.org/technical/specifications/) — the definition of the `scause`/`sepc`/`stval` trap CSRs (the very values we read while tracing the crash)
- Related: [From boot to paging](/blog/hobby/hobby-kernel-00-boot-to-paging) · [The preemptive scheduler](/blog/hobby/hobby-kernel-03-exec-and-shell) · [Demand paging and mmap](/blog/hobby/hobby-kernel-04-paging-mmap-writable-fs) · [Multicore and locks](/blog/hobby/hobby-kernel-05-smp-multicore-locks)

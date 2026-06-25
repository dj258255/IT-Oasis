---
title: '유저 스레드 — 커널 없이 갈아타기'
titleEn: 'User Threads — Switching Without the Kernel'
description: 스레드는 꼭 커널이 만들어줘야 할까. 한 프로세스 안에서, 커널의 도움 없이 유저 공간만으로 실행 흐름을 갈아타는 협조적 유저 스레드를 만든다. 이건 이 시리즈에서 한 번 실패했다 되돌렸던 주제다. 진짜 원인 — 단일 페이지 모델의 전역 변수 제약, 그리고 힙 스택 위에 트랩 프레임을 저장하다 나는 커널 페이지 폴트 — 을 찾아내고, 커널을 전혀 바꾸지 않고 두 가지 우회로 해결한다.
descriptionEn: "Must the kernel be the one to create threads? Inside a single process, with no help from the kernel, we build cooperative user threads that switch execution flows purely in user space. This is a topic I once failed at and reverted in this series. We track down the real causes — the single-page model's ban on globals, and a kernel page fault from saving a trap frame on a heap stack — and solve them with two workarounds, changing the kernel not at all."
date: 2026-07-02T00:00:00.000Z
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


## 들어가며

지금까지 "동시 실행"은 전부 **커널이** 해줬어요.
[4편의 스케줄러](/blog/hobby/hobby-kernel-03-exec-and-shell)가 프로세스를 갈아탔고, [6편의 멀티코어](/blog/hobby/hobby-kernel-05-smp-multicore-locks)가 코어를 나눴죠.

그런데 스레드를 꼭 커널이 만들어줘야 할까요?
**유저 공간만으로**, 한 프로세스 안에서 실행 흐름을 갈아탈 수 있다면요?
그게 **유저 스레드**(user-level thread, green thread)예요.
커널은 이게 한 프로세스인 줄만 알고, 그 안에서 여러 흐름이 협조적으로 번갈아 도는 거예요.

사실 이 주제는 이 시리즈에서 **한 번 실패하고 되돌렸던** 거예요.
이번 글은 그 실패의 진짜 원인을 찾아내고, 커널을 전혀 건드리지 않고 해결하는 이야기예요.

## 1. 왜 처음엔 실패했나 — 전역 변수의 함정

유저 스레드의 교과서 구현(xv6의 uthread)은 **전역 배열**로 스레드들을 관리해요.

```c
struct thread all_thread[NTHREAD];   // 전역
struct thread *current_thread;       // 전역
```

그런데 우리 커널에서 이게 깨졌어요.
원인은 우리만의 설계에 있었어요 — **유저 프로그램은 코드가 단일 페이지(R\|X)로만 매핑**돼요.
즉 `.data`/`.bss`(전역 변수가 사는 곳)가 **쓰기 가능한 페이지에 없어요.**
전역에 쓰는 순간 실패하고, 스레드 컨텍스트(특히 `sp`)가 엉뚱한 값으로 채워져, 워커가 잘못된 스택에서 돌다 죽었어요.

해법은 두 갈래였어요.

1. 유저 주소공간에 **쓰기 가능한 데이터 세그먼트**를 추가한다 (커널을 고친다).
2. 전역을 **아예 안 쓴다** — 상태를 힙(쓰기 가능)에 둔다 (커널을 안 고친다).

저는 2번을 택했어요.
이미 만든 [demand paging 힙](/blog/hobby/hobby-kernel-04-paging-mmap-writable-fs)이 쓰기 가능하니, 거기에 스레드 상태를 통째로 올리면 돼요.

## 2. 전역 없이 — 힙의 고정 주소

핵심 트릭은 이거예요.
힙의 **고정 주소**(우리 힙 시작점 `0x10000`)에 스레드 시스템 구조체를 둬요.

```c
#define HEAPBASE 0x10000UL
struct sys { struct ctx sched; struct thread t[NTHREAD]; int current; ... };
#define S ((volatile struct sys *)HEAPBASE)
```

`(struct sys *)0x10000` 은 전역 변수가 아니라 **포인터 상수**예요.
주소 0x10000을 그냥 즉시값으로 만드는 거라 `.data`에 안 들어가고, R\|X 코드 페이지에서도 멀쩡히 동작해요.
그리고 그 주소가 가리키는 곳은 힙이라 쓰기 가능하죠.
`S->current`, `S->t[i].state` 처럼 모든 상태를 이 하나의 포인터로 접근해요.
전역이 0개라서(`bss=0, data=0`) 단일 페이지 제약을 정면으로 피해 가요.

## 3. 두 번째 함정 — 힙 스택 위의 트랩 프레임

전역을 없애니 스레드가 드디어 돌기 시작했어요.
"[thread A] step 1"이 찍혔죠.
그런데 다음 스레드로 넘어가다 **커널 모드에서** 페이지 폴트가 났어요.

```
[trap] EXCEPTION  scause=0xf  sepc=0x8020003e  stval=0x11000
```

`sepc`가 커널 주소(0x8020...)예요 — 커널이 유저 힙 주소 `0x11000`에 쓰다가 폴트가 난 거예요.
범인은 우리 [트랩 처리 방식](/blog/hobby/hobby-kernel-01-usermode-to-processes)이에요.
우리 커널은 트랩이 나면 **그 순간의 `sp` 바로 아래(sp-256)에 트랩 프레임을 저장**해요.

스레드가 힙 스택(예: `0x111E0`)에서 돌다가 `sys_putchar`로 `ecall`하면, 커널이 `0x110E0`부터 프레임을 써요.
그런데 그 힙 페이지가 아직 demand paging으로 **매핑되기 전**이면, 커널의 `sd` 명령이 폴트를 내요.
유저 스택 demand paging과 "커널이 유저 스택에 프레임을 쓴다"는 우리 설계가 정면충돌한 거죠.

해법은 단순해요 — 스레드를 돌리기 전에 **힙 페이지를 미리 만져(pre-fault) 전부 매핑**해두는 거예요.

```c
sys_sbrk(16384);                                  // 힙 확보
for (unsigned long a = 0; a < 16384; a += 4096)   // 각 페이지를 미리 touch
    *((volatile unsigned char *)(HEAPBASE + a)) = 0;
```

이러면 스레드가 `ecall`할 때 프레임 저장 영역이 이미 매핑돼 있어 커널 폴트가 안 나요.
실제 OS도 스레드 스택을 미리 커밋하거나 가드 페이지를 두는 등 비슷한 처리를 해요.

## 4. 유저 공간 컨텍스트 스위치

스레드를 갈아타는 건 [커널의 `swtch`](/blog/hobby/hobby-kernel-03-exec-and-shell)와 똑같은 원리예요 — callee-saved 레지스터와 `ra`, `sp`를 저장하고 복원하면, `ret`이 **다른 실행 흐름**으로 점프해요.
다만 이번엔 유저 공간에서 도는 `uswitch`예요.

```asm
uswitch:                  # uswitch(old, new)
  sd ra,0(a0); sd sp,8(a0); sd s0,16(a0) ... sd s11,104(a0)   # old에 저장
  ld ra,0(a1); ld sp,8(a1); ld s0,16(a1) ... ld s11,104(a1)   # new에서 복원
  ret                     # new->ra로 점프 → 다른 흐름으로
```

스레드는 `uyield()`로 스케줄러에 양보하고(자기 ctx 저장, 스케줄러 ctx 복원), 스케줄러는 다음 runnable 스레드로 `uswitch`해요.
새 스레드를 만들 땐 ctx의 `ra`를 스레드 함수로, `sp`를 그 스레드의 힙 스택 꼭대기로 세팅해요.
그러면 첫 `uswitch`가 그 함수로 "복귀"하며 자기 스택에서 시작해요.

## 5. 눈으로 확인하기

셸에서 `uthread`를 돌리면, 세 스레드가 협조적으로 번갈아 돌아요.

```
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

A→B→C→A→B→C... 깔끔한 round-robin이에요.
커널은 이게 한 프로세스인 줄만 알아요.
세 흐름의 교대는 전부 유저 공간에서, 우리가 만든 `uswitch`로 일어났어요.

## 6. 되짚기 — 협조적 vs 선점

우리 유저 스레드는 **협조적(cooperative)** 이에요.
스레드가 스스로 `uyield()`를 불러야 다른 스레드가 돌아요.
어떤 스레드가 양보 안 하고 무한 루프를 돌면, 나머지는 영영 못 돌아요.

[커널 스케줄러(4편)](/blog/hobby/hobby-kernel-03-exec-and-shell)는 **선점적**이었죠 — 타이머 인터럽트가 강제로 빼앗았어요.
유저 스레드를 선점적으로 만들려면 타이머 시그널(유닉스의 `SIGALRM` 같은)이 필요한데, 그건 시그널 메커니즘이라는 또 다른 큰 주제예요.

**유저 스레드의 트레이드오프**는 명확해요.

- **장점**: 전환이 싸다(커널 진입 없이 레지스터 몇 개만). 커널은 스레드의 존재조차 모른다.
- **단점**: 한 스레드가 블로킹 시스템콜을 하면 프로세스 전체가 멈춘다(커널은 한 흐름만 보니까). 멀티코어를 못 쓴다(커널에겐 한 프로세스라 한 코어).

그래서 현대 런타임(Go의 고루틴 등)은 유저 스레드(M개)를 커널 스레드(N개) 위에 얹는 **M:N 하이브리드**를 써요.
우리가 만든 건 그 M:N의 'M' 쪽 — 가장 밑바닥의 협조적 전환이에요.

## 마치며 — 그리고 여정의 끝

부팅의 첫 글자(`1편`)부터 여기까지 왔어요.
페이징, 프로세스, 시스템콜, fork/exec, 파일시스템, demand paging, mmap, 멀티코어, 네트워크(UDP·TCP), copy-on-write, 저널링, 그리고 유저 스레드까지.
교과서의 모든 그림을 직접 코드로 만져봤어요.

이 마지막 작업이 특히 의미 있었던 건, **한 번 실패했던 걸 되돌아와 풀었기** 때문이에요.
실패의 진짜 원인(전역 제약 + 트랩 프레임 폴트)은 정적 분석만으론 안 보였고, 직접 돌려 크래시를 추적해야 보였어요.
"OS가 안에서 어떻게 도는가"를 알고 싶어 시작한 여정에서, 가장 많이 배운 건 언제나 **막히고, 깨지고, 추적한** 지점들이었어요.

좋은 지도(xv6)를 따라왔지만, 그 지도에 없는 우리만의 골목들 — 단일 페이지 모델, 유저 스택 위의 트랩 프레임, 락 baton, tp 복구 — 을 직접 헤쳐 나온 게 진짜 공부였어요.

읽어주셔서 고마워요.
여기까지가 **C로 만드는 토이 커널**, 부팅부터 유저 스레드까지의 기록이에요.

> 코드: [github.com/dj258255/hobby-kernel](https://github.com/dj258255/hobby-kernel)

### 참고 자료

- [xv6: a simple, Unix-like teaching operating system (MIT 6.S081)](https://pdos.csail.mit.edu/6.828/2023/xv6.html) — uthread
- 관련 글: [선점형 스케줄러](/blog/hobby/hobby-kernel-03-exec-and-shell) · [멀티코어와 락](/blog/hobby/hobby-kernel-05-smp-multicore-locks)

<!-- EN -->

## Introduction

So far, all "concurrent execution" was done **by the kernel**.
[The scheduler in Part 4](/blog/hobby/hobby-kernel-03-exec-and-shell) switched processes, and [multicore in Part 6](/blog/hobby/hobby-kernel-05-smp-multicore-locks) split the cores.

But must the kernel be the one to create threads?
What if we could switch execution flows **purely in user space**, inside a single process?
That's a **user thread** (user-level thread, green thread).
The kernel only knows it's one process, while several flows take turns cooperatively inside it.

This topic is one I actually **failed at and reverted** earlier in this series.
This post is the story of tracking down the real cause of that failure and solving it without touching the kernel at all.

## 1. Why it failed at first — the trap of globals

The textbook implementation of user threads (xv6's uthread) manages threads with a **global array**.

```c
struct thread all_thread[NTHREAD];   // global
struct thread *current_thread;       // global
```

But this broke in our kernel.
The cause was our own design — **a user program's code is mapped as a single page (R\|X) only**.
That means `.data`/`.bss` (where globals live) is **not on a writable page**.
The moment you write to a global it fails, the thread context (especially `sp`) gets filled with the wrong value, and the worker runs on a bogus stack and dies.

There were two ways out.

1. Add a **writable data segment** to the user address space (change the kernel).
2. **Don't use globals at all** — put the state on the heap (writable) (don't change the kernel).

I chose option 2.
The [demand-paging heap](/blog/hobby/hobby-kernel-04-paging-mmap-writable-fs) we already built is writable, so we put all the thread state up there.

## 2. Without globals — a fixed heap address

The key trick is this.
Place the thread-system struct at a **fixed address** in the heap (our heap's start, `0x10000`).

```c
#define HEAPBASE 0x10000UL
struct sys { struct ctx sched; struct thread t[NTHREAD]; int current; ... };
#define S ((volatile struct sys *)HEAPBASE)
```

`(struct sys *)0x10000` is not a global variable but a **pointer constant**.
It just forms the address 0x10000 as an immediate, so it doesn't land in `.data` and works fine even on an R\|X code page.
And what that address points to is the heap, which is writable.
All state is accessed through this single pointer — `S->current`, `S->t[i].state`, and so on.
With zero globals (`bss=0, data=0`), it sidesteps the single-page constraint head-on.

## 3. The second trap — a trap frame on a heap stack

Once globals were gone, the threads finally started running.
"[thread A] step 1" printed.
But switching to the next thread caused a page fault **in kernel mode**.

```
[trap] EXCEPTION  scause=0xf  sepc=0x8020003e  stval=0x11000
```

`sepc` is a kernel address (0x8020...) — the kernel faulted writing to the user heap address `0x11000`.
The culprit is our [trap handling](/blog/hobby/hobby-kernel-01-usermode-to-processes).
On a trap, our kernel **saves the trap frame just below the current `sp` (sp-256)**.

When a thread running on a heap stack (say `0x111E0`) does an `ecall` via `sys_putchar`, the kernel writes the frame from `0x110E0`.
If that heap page hasn't been mapped yet by demand paging, the kernel's `sd` instruction faults.
User-stack demand paging and "the kernel writes the frame onto the user stack" collided head-on.

The fix is simple — **pre-fault all the heap pages** by touching them before running the threads.

```c
sys_sbrk(16384);                                  // grow the heap
for (unsigned long a = 0; a < 16384; a += 4096)   // touch each page up front
    *((volatile unsigned char *)(HEAPBASE + a)) = 0;
```

Now when a thread does an `ecall`, the frame-save area is already mapped, so no kernel fault.
Real OSes do similar things — pre-committing thread stacks, placing guard pages, and so on.

## 4. A user-space context switch

Switching threads works exactly like [the kernel's `swtch`](/blog/hobby/hobby-kernel-03-exec-and-shell) — save the callee-saved registers, `ra`, and `sp`, restore them, and `ret` jumps into **a different execution flow**.
Only this time it's `uswitch`, running in user space.

```asm
uswitch:                  # uswitch(old, new)
  sd ra,0(a0); sd sp,8(a0); sd s0,16(a0) ... sd s11,104(a0)   # save to old
  ld ra,0(a1); ld sp,8(a1); ld s0,16(a1) ... ld s11,104(a1)   # restore from new
  ret                     # jump to new->ra → into the other flow
```

A thread yields to the scheduler with `uyield()` (save its own ctx, restore the scheduler ctx), and the scheduler `uswitch`es to the next runnable thread.
When creating a new thread, we set the ctx's `ra` to the thread function and `sp` to the top of that thread's heap stack.
Then the first `uswitch` "returns" into that function, starting on its own stack.

## 5. Seeing it with your own eyes

Running `uthread` from the shell, three threads take turns cooperatively.

```
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

A→B→C→A→B→C... a clean round-robin.
The kernel only knows it's one process.
The interleaving of three flows all happened in user space, with the `uswitch` we built.

## 6. Looking back — cooperative vs preemptive

Our user threads are **cooperative**.
A thread must call `uyield()` itself for another thread to run.
If a thread never yields and spins forever, the rest never run.

The [kernel scheduler (Part 4)](/blog/hobby/hobby-kernel-03-exec-and-shell) was **preemptive** — a timer interrupt forcibly took over.
Making user threads preemptive needs a timer signal (like Unix's `SIGALRM`), and that's the whole other big topic of signal mechanisms.

The **trade-offs of user threads** are clear.

- **Pros**: switching is cheap (no kernel entry, just a few registers). The kernel doesn't even know the threads exist.
- **Cons**: if one thread makes a blocking system call, the whole process stalls (the kernel sees only one flow). Can't use multiple cores (to the kernel it's one process, one core).

That's why modern runtimes (Go's goroutines, etc.) use an **M:N hybrid**, layering user threads (M) over kernel threads (N).
What we built is the 'M' side of that M:N — the lowest-level cooperative switch.

## Closing — and the end of the journey

From the first character of boot (`Part 1`) to here.
Paging, processes, system calls, fork/exec, the filesystem, demand paging, mmap, multicore, networking (UDP·TCP), copy-on-write, journaling, and user threads.
I got to touch every textbook diagram as real code.

This last piece was especially meaningful because it was **coming back to something I'd failed at and solving it**.
The real causes of the failure (the global constraint + the trap-frame fault) weren't visible from static analysis alone; I had to run it and trace the crash to see them.
On a journey that began wanting to know "how an OS runs inside," what I learned most from was always the places where I **got stuck, broke things, and traced them down**.

I followed a good map (xv6), but the real studying was fighting through our own alleyways that weren't on it — the single-page model, the trap frame on the user stack, the lock baton, the tp restore.

Thank you for reading.
This is the end of **A Toy Kernel in C**, the record from boot to user threads.

> Code: [github.com/dj258255/hobby-kernel](https://github.com/dj258255/hobby-kernel)

### References

- [xv6: a simple, Unix-like teaching operating system (MIT 6.S081)](https://pdos.csail.mit.edu/6.828/2023/xv6.html) — uthread
- Related: [The preemptive scheduler](/blog/hobby/hobby-kernel-03-exec-and-shell) · [Multicore and locks](/blog/hobby/hobby-kernel-05-smp-multicore-locks)

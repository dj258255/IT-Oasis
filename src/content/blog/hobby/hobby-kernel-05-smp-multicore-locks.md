---
title: '멀티코어로 가다 — SMP와 락'
titleEn: 'Going Multicore — SMP and Locks'
description: 단일 코어 커널을 여러 코어가 함께 도는 SMP 커널로 키운다. SBI HSM으로 보조 코어를 깨워 부팅하고, 스핀락으로 공유 자료구조를 보호하고, 컨텍스트 스위치를 가로지르며 락을 넘기는 baton 방식으로 멀티코어 스케줄러를 만든다. 그 과정에서 만난 가장 고약한 버그 — 유저가 tp 레지스터를 덮어 코어 번호가 틀어지던 문제 — 와 그 해결까지.
descriptionEn: "Growing a single-core kernel into an SMP kernel that runs on several cores at once. Booting secondary cores via SBI HSM, protecting shared structures with spinlocks, and building a multicore scheduler with a lock baton handed across the context switch. Plus the nastiest bug along the way — a clobbered tp register that corrupted the core id — and how it was fixed."
date: 2026-06-20T00:00:00.000Z
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
seriesOrder: 6
---


## 들어가며

지금까지의 커널은 **코어 하나**를 전제로 짜였어요.
프로세스가 동시에 도는 것처럼 보여도, 사실은 한 코어가 빠르게 번갈아 돌린 거였죠([4편의 선점형 스케줄러](/blog/hobby/hobby-kernel-03-exec-and-shell)).

이번 글의 주제는 **진짜 동시 실행** — 여러 코어(RISC-V에선 hart)가 같은 커널을 함께 도는 거예요.
이게 OS에서 제일 어려운 부분 중 하나예요.
왜냐하면 두 코어가 같은 자료구조를 동시에 만지면, 단일 코어에선 멀쩡하던 코드가 비결정적으로 깨지거든요.

순서는 이래요.

1. **멀티코어 부팅** — 보조 코어를 깨워 커널에 합류시킨다
2. **스핀락** — 공유 자원을 한 번에 하나만 만지게 한다
3. **멀티코어 스케줄러** — 여러 코어가 공유 runqueue에서 프로세스를 가져다 돈다
4. **가장 고약했던 버그** — 코어 번호가 틀어지던 문제

> 참고서는 여전히 [xv6(MIT 6.S081)](https://pdos.csail.mit.edu/6.828/2023/xv6.html).
> 락의 기초(뮤텍스/세마포어)는 [세마포어와 뮤텍스](/blog/theory/semaphore-mutex-sync)에서 다룬 적이 있어요.

## 1. 멀티코어 부팅

QEMU에 `-smp 3`을 주면 코어가 3개예요.
그런데 부팅 때 커널로 점프하는 건 **하나(부팅 하트)** 뿐이에요.
나머지는 OpenSBI(펌웨어) 안에서 깨워주길 기다리고 있어요.

부팅 하트가 초기화를 다 끝낸 뒤, **SBI HSM**(Hart State Management) 확장으로 나머지를 깨워요.
"이 hart를, 이 주소에서, S-mode로 시작해라"라고 `ecall` 하는 거예요.

```c
// SBI HSM hart_start: a0=hartid, a1=시작주소, a7="HSM"
static long sbi_hart_start(uint64 hartid, uint64 addr) {
    register uint64 a0 asm("a0") = hartid;
    register uint64 a1 asm("a1") = addr;
    register uint64 a7 asm("a7") = 0x48534D;   // "HSM"
    asm volatile("ecall" : "+r"(a0) : "r"(a1), "r"(a7) : "memory");
    return (long)a0;
}
```

코어마다 자기 스택이 필요해요(한 스택을 둘이 쓰면 바로 깨져요).
그래서 `entry.S`에서 hartid로 스택을 나눠 잡아요.

```asm
# entry.S — 코어별 스택: sp = stacks + (hartid+1) * 4096
mv      tp, a0             # tp = hartid
la      sp, stacks
li      t0, 4096
addi    t1, a0, 1
mul     t0, t0, t1
add     sp, sp, t0
```

### 함정: 부팅 하트가 0이 아닐 수 있다

처음엔 "hartid가 0이면 부팅 하트, 아니면 보조 코어"로 분기했어요.
그런데 돌려보니 OpenSBI가 **부팅 하트를 2번**으로 고른 적이 있었어요.
부팅 하트 번호는 정해져 있지 않아요.

그래서 "hartid 0"이 아니라 **"가장 먼저 진입한 하트가 부팅 하트"** 로 바꿨어요.
원자적 플래그 하나로 첫 진입자를 가려내요.

```c
static int boot_taken = 0;
void kmain(void) {
    if (__sync_lock_test_and_set(&boot_taken, 1) != 0) {
        hart_main();   // 이미 부팅 하트가 있다 → 나는 보조 코어
        for (;;) asm volatile("wfi");
    }
    // 첫 진입자 = 부팅 하트 → 전체 초기화 후 나머지를 깨운다
    ...
}
```

## 2. 스핀락

여러 코어가 같은 자료구조(페이지 할당기 프리리스트, 프로세스 표 등)를 동시에 만지면 깨져요.
그래서 **한 번에 하나만** 들어가게 막는 장치가 필요해요.
그게 스핀락이에요.

핵심은 **원자적 교환**(`amoswap`)이에요.
"잠금 변수를 1로 바꾸면서 이전 값을 본다"를 한 명령으로 해요.
이전 값이 0이었으면 내가 잠근 거고, 1이었으면 남이 쥐고 있으니 풀릴 때까지 빙빙 돈다(spin)는 뜻이에요.

```c
void acquire(struct spinlock *lk) {
    push_off();   // 인터럽트 끄기
    while (__sync_lock_test_and_set(&lk->locked, 1) != 0)
        ;         // 잠길 때까지 스핀
    __sync_synchronize();
}
```

락을 쥔 동안엔 **인터럽트를 꺼야** 해요.
안 그러면 같은 코어에서 인터럽트 핸들러가 같은 락을 또 잡으려다 자기 자신과 데드락에 빠져요.
`push_off`/`pop_off`가 그 인터럽트 끄기를 **중첩 카운트**로 관리해요(가장 바깥에서 끄고, 가장 바깥에서 켠다).

## 3. 멀티코어 스케줄러 — 락 baton

이게 이번 글의 진짜 핵심이에요.
가장 어려운 건 **"프로세스를 컨텍스트 스위치하는 그 찰나"** 예요.

이런 레이스를 상상해보세요.
코어 A가 프로세스 P를 RUNNABLE로 바꾸고 P에서 빠져나가는 도중에, 코어 B가 P를 발견하고 실행해버려요.
그러면 **두 코어가 같은 P를 동시에** 돌리고, P의 스택이 박살나요.

해결은 락을 **컨텍스트 스위치를 가로질러** 쥐는 거예요.
스케줄러가 락을 잡고 P로 swtch해 들어가면, 그 락을 P가 (첫 실행이나 yield 지점에서) 놓아요.
P가 빠져나갈 땐 다시 락을 잡고 swtch하고, 스케줄러가 그 락을 놓고요.
마치 **배턴을 주고받듯**, 락이 스위치 양쪽으로 넘어가요.
그동안엔 다른 코어가 P를 절대 못 집어요.

```c
// 스케줄러: 락을 잡고 RUNNABLE을 점유한 뒤, 락을 든 채로 swtch
void scheduler(void) {
    int id = r_tp();
    for (;;) {
        acquire(&pt_lock);
        for (each proc p) if (p->state == RUNNABLE) {
            p->state = RUNNING;
            swtch(&cpu_sched[id], &p->context);  // pt_lock 든 채로 들어감
            // ... 돌아오면 pt_lock을 다시 들고 있다
        }
        release(&pt_lock);
    }
}
```

새로 만든 프로세스가 **처음** 실행될 땐(첫 진입), yield 지점이 아니라 진입 함수에서 시작해요.
그래서 그 진입 함수들(`enter_user`, `forkret` 등)이 맨 처음에 락을 놓아줘야 해요.

```c
static void enter_user(void) {
    release(&pt_lock);   // 스케줄러가 잡은 락을 놓는다(첫 실행)
    // ... sret로 U-mode 진입
}
```

`sleep`/`wakeup`도 이 락 위에서 동작해요.
`read()`가 입력을 기다릴 때, "버퍼가 비었나" 검사와 `sleep`이 같은 락 아래 묶여 있어야 **잃어버린 wakeup**이 없어요.
다른 코어의 인터럽트가 그 사이에 끼어들어 깨움을 놓치는 일을 막는 거죠.

## 4. 가장 고약했던 버그 — 사라진 코어 번호

보조 코어를 스케줄러에 넣자마자, `hello`를 실행하면 **간헐적으로** 크래시가 났어요.
어떤 실행은 멀쩡하고 어떤 실행은 죽는, 전형적인 레이스 증상이었어요.

폴트 주소를 따라가 보니 `proc_fork`의 한 줄이었어요.

```
[trap] EXCEPTION  scause=0xd  sepc=0x80201e10  stval=0x00000000000000a8
```

`stval=0xa8`(168) — 거의 null인 포인터의 168번째 바이트를 읽다 폴트.
디스어셈블해 보니 `current_proc()`가 **null**을 반환하고 있었어요.

원인은 정말 미묘했어요.
우리 커널은 **`tp` 레지스터에 코어 번호(hartid)** 를 담아요.
그런데 유저 프로그램이 `tp`를 자기 용도로 덮어쓸 수 있어요.
트랩이 나면 `kernelvec`이 유저의 `tp`를 저장했다가 복원하는데, **커널 코드가 도는 동안엔 `tp`가 유저 값** 이었던 거예요.

그래서 `r_tp()`가 엉뚱한 값을 반환하고, `cpu_proc[엉뚱한 인덱스]` → null → 크래시.

단일 코어(4편까지)에선 안 터졌어요.
부팅 하트가 0이고 유저 `tp`도 0이라, 우연히 `r_tp()=0`이 맞아떨어졌거든요.
그런데 멀티코어에선 프로세스가 1번·2번 코어에서 돌면, 유저 `tp`(0)와 실제 코어 번호(1, 2)가 달라서 바로 드러났어요.

해결은 xv6와 같아요.
코어 번호를 `sscratch`(S-mode 스크래치 CSR)에도 보관하고, 트랩에 진입할 때 `tp`를 거기서 **복구**해요.

```asm
# entry.S — 부팅 시 코어마다
csrw    sscratch, a0       # sscratch = hartid

# kernelvec.S — 트랩 진입 시
csrr    tp, sscratch       # tp = hartid 복구 (유저가 덮었어도)
```

이 두 줄로 크래시가 사라졌어요.
"레지스터 하나의 의미를 누가 소유하는가"가 멀티코어에선 이렇게 중요해져요.

## 5. 나머지 공유 자원 잠그기

스케줄러가 안정되니, 남은 공유 자원들도 락을 채웠어요.

- **페이지 할당기**(`kalloc`) — 여러 코어가 동시에 페이지를 할당/해제하므로 프리리스트를 락으로 보호.
- **콘솔 버퍼** — 입력 버퍼와 `sleep`/`wakeup`을 스케줄러 락으로 보호(잃어버린 wakeup 방지).
- **UART 출력** — 락이 없으면 두 코어의 출력이 글자 단위로 섞여요. 메시지 단위로 직렬화하는 락을 추가.

여기서 **락 순서**가 중요해요.
`pt_lock`을 쥔 채로 `uart_lock`을 잡는 경로는 있어도, 그 반대는 없어야 데드락이 안 나요.
UART 락을 항상 **가장 안쪽**(다른 락을 더 잡지 않는 leaf)으로 두면 그 규칙이 지켜져요.

## 마치며

이제 `-smp 3`으로 부팅하면 **3개 코어가 공유 runqueue에서 프로세스를 가져다 동시에** 돌려요.

```
[ok] boot hart 0 up; waking other cores + starting shell
hobby-kernel userspace shell. try: ls, cat motd.txt, hello
$ [ok] hart 2 online -> joining scheduler
[ok] hart 1 online -> joining scheduler
$ hello
  [hello] I am a separate program, exec'd from disk!
```

셸·fork·exec·cat이 여러 코어에 분산돼 돌아도 크래시 없이 동작해요.

돌아보면, 멀티코어는 **새 기능이라기보다 "정확성"의 싸움**이었어요.
단일 코어 코드를 거의 그대로 두고도, "두 코어가 동시에 이 줄을 밟으면?"이라는 질문을 모든 공유 지점에 던져야 했어요.
락 baton, `tp` 복구, 락 순서 — 전부 그 질문에 대한 답이었고요.

남은 정제거리도 적어둘게요.
파일시스템(virtio+버퍼)은 단일 사용자 셸이라 동시 접근이 안 생겨 아직 락이 없고요(일반적으론 필요).
유저 스레드(uthread)는 우리 단일 페이지 프로그램 모델 제약으로 보류, 네트워크 스택은 별도의 큰 여정이에요.

부팅부터 멀티코어까지, "OS가 어떻게 도는가"를 손으로 만져 이해하는 여정은 여기서 한 매듭을 지어요.

> 코드: [github.com/dj258255/hobby-kernel](https://github.com/dj258255/hobby-kernel)

### 참고 자료

- [xv6: a simple, Unix-like teaching operating system (MIT 6.S081)](https://pdos.csail.mit.edu/6.828/2023/xv6.html)
- [RISC-V SBI Specification — HSM 확장](https://github.com/riscv-non-isa/riscv-sbi-doc)
- 관련 글: [세마포어와 뮤텍스](/blog/theory/semaphore-mutex-sync)

<!-- EN -->

## Introduction

Up to now the kernel assumed a **single core**.
Processes looked concurrent, but really one core was switching between them quickly ([the preemptive scheduler in Part 4](/blog/hobby/hobby-kernel-03-exec-and-shell)).

This post is about **true concurrent execution** — several cores (harts, in RISC-V) running the same kernel together.
This is one of the hardest parts of an OS.
When two cores touch the same data structure at once, code that was perfectly fine on a single core breaks nondeterministically.

The plan:

1. **Multicore boot** — wake the secondary cores and bring them into the kernel
2. **Spinlocks** — let only one core touch a shared resource at a time
3. **A multicore scheduler** — several cores pull processes from a shared runqueue
4. **The nastiest bug** — a corrupted core id

> The reference is still [xv6 (MIT 6.S081)](https://pdos.csail.mit.edu/6.828/2023/xv6.html).
> The basics of locking (mutex/semaphore) are covered in [Semaphores and Mutexes](/blog/theory/semaphore-mutex-sync).

## 1. Multicore boot

Passing `-smp 3` to QEMU gives us 3 cores.
But at boot only **one** (the boot hart) jumps into the kernel.
The rest wait inside OpenSBI (the firmware) to be woken up.

After the boot hart finishes initialization, it wakes the others with the **SBI HSM** (Hart State Management) extension.
We `ecall` saying "start this hart, at this address, in S-mode."

```c
// SBI HSM hart_start: a0=hartid, a1=start address, a7="HSM"
static long sbi_hart_start(uint64 hartid, uint64 addr) {
    register uint64 a0 asm("a0") = hartid;
    register uint64 a1 asm("a1") = addr;
    register uint64 a7 asm("a7") = 0x48534D;   // "HSM"
    asm volatile("ecall" : "+r"(a0) : "r"(a1), "r"(a7) : "memory");
    return (long)a0;
}
```

Each core needs its own stack (two cores sharing one stack corrupts it immediately).
So `entry.S` carves out a per-hart stack by hartid.

```asm
# entry.S — per-core stack: sp = stacks + (hartid+1) * 4096
mv      tp, a0             # tp = hartid
la      sp, stacks
li      t0, 4096
addi    t1, a0, 1
mul     t0, t0, t1
add     sp, sp, t0
```

### Pitfall: the boot hart may not be 0

At first I branched on "hartid 0 means boot hart, otherwise secondary."
But in practice OpenSBI once picked **hart 2** as the boot hart.
The boot hart number is not fixed.

So instead of "hartid 0" I switched to **"the first hart to enter is the boot hart."**
A single atomic flag picks the first arrival.

```c
static int boot_taken = 0;
void kmain(void) {
    if (__sync_lock_test_and_set(&boot_taken, 1) != 0) {
        hart_main();   // a boot hart already exists → I am a secondary core
        for (;;) asm volatile("wfi");
    }
    // first arrival = boot hart → full init, then wake the rest
    ...
}
```

## 2. Spinlocks

When several cores touch the same structure (the page allocator free list, the process table, …) it breaks.
So we need something that lets **only one in at a time**.
That's a spinlock.

The heart of it is an **atomic exchange** (`amoswap`).
"Set the lock variable to 1 and read its previous value" happens in one instruction.
If the previous value was 0, I locked it; if it was 1, someone else holds it, so I spin until it's free.

```c
void acquire(struct spinlock *lk) {
    push_off();   // disable interrupts
    while (__sync_lock_test_and_set(&lk->locked, 1) != 0)
        ;         // spin until acquired
    __sync_synchronize();
}
```

While holding a lock we must **disable interrupts**.
Otherwise an interrupt handler on the same core could try to grab the same lock and deadlock against itself.
`push_off`/`pop_off` manage that with a **nesting count** (disable at the outermost, re-enable at the outermost).

## 3. The multicore scheduler — the lock baton

This is the real heart of the post.
The hardest moment is **the instant a process is context-switched**.

Picture this race.
Core A marks process P as RUNNABLE and is on its way out of P, while core B spots P and starts running it.
Now **two cores run the same P at once**, and P's stack is destroyed.

The fix is to hold the lock **across the context switch**.
The scheduler grabs the lock and `swtch`es into P; P releases that lock (at its first run, or at a yield point).
When P leaves, it grabs the lock again and `swtch`es, and the scheduler releases it.
Like **passing a baton**, the lock crosses to both sides of the switch.
During that window no other core can ever pick up P.

```c
// scheduler: grab the lock, claim a RUNNABLE proc, swtch while holding it
void scheduler(void) {
    int id = r_tp();
    for (;;) {
        acquire(&pt_lock);
        for (each proc p) if (p->state == RUNNABLE) {
            p->state = RUNNING;
            swtch(&cpu_sched[id], &p->context);  // enter while holding pt_lock
            // ... back here, we hold pt_lock again
        }
        release(&pt_lock);
    }
}
```

When a freshly created process runs for the **first** time, it starts in an entry function rather than at a yield point.
So those entry functions (`enter_user`, `forkret`, …) must release the lock at their very start.

```c
static void enter_user(void) {
    release(&pt_lock);   // release the lock the scheduler held (first run)
    // ... sret into U-mode
}
```

`sleep`/`wakeup` ride on this lock too.
When `read()` waits for input, the "is the buffer empty?" check and the `sleep` must be under the same lock, or you get a **lost wakeup**.
That prevents another core's interrupt from slipping in between and losing the wakeup.

## 4. The nastiest bug — the vanished core id

The moment I added the secondary cores to the scheduler, running `hello` crashed **intermittently**.
Some runs were fine, some died — the classic race symptom.

Following the fault address led to a single line in `proc_fork`.

```
[trap] EXCEPTION  scause=0xd  sepc=0x80201e10  stval=0x00000000000000a8
```

`stval=0xa8` (168) — a fault reading byte 168 of a near-null pointer.
Disassembling showed `current_proc()` returning **null**.

The cause was very subtle.
Our kernel keeps the **core id (hartid) in the `tp` register**.
But a user program can clobber `tp` for its own use.
On a trap, `kernelvec` saves and restores the user's `tp` — so **while kernel code runs, `tp` was the user's value**.

So `r_tp()` returned garbage, `cpu_proc[garbage index]` → null → crash.

On a single core (through Part 4) it never blew up.
The boot hart was 0 and the user `tp` was 0, so `r_tp()=0` happened to be correct by luck.
On multicore, when a process ran on core 1 or 2, the user `tp` (0) differed from the real core id (1, 2), and it surfaced immediately.

The fix is the same as xv6's.
Keep the core id in `sscratch` (the S-mode scratch CSR) too, and **restore** `tp` from there on trap entry.

```asm
# entry.S — at boot, per core
csrw    sscratch, a0       # sscratch = hartid

# kernelvec.S — on trap entry
csrr    tp, sscratch       # restore tp = hartid (even if the user clobbered it)
```

These two lines made the crash disappear.
"Who owns the meaning of a single register" becomes this important on multicore.

## 5. Locking the remaining shared resources

Once the scheduler was stable, I locked the remaining shared resources.

- **Page allocator** (`kalloc`) — several cores allocate/free pages at once, so the free list is lock-protected.
- **Console buffer** — the input buffer and `sleep`/`wakeup` are protected by the scheduler lock (lost-wakeup prevention).
- **UART output** — without a lock, two cores' output interleaves character by character. Added a lock that serializes per message.

**Lock ordering** matters here.
There may be a path that holds `pt_lock` and then grabs `uart_lock`, but never the reverse — otherwise deadlock.
Keeping the UART lock as the **innermost** leaf (it grabs no further lock) keeps that rule.

## Closing

Now booting with `-smp 3` runs **3 cores pulling processes from a shared runqueue and running them at once**.

```
[ok] boot hart 0 up; waking other cores + starting shell
hobby-kernel userspace shell. try: ls, cat motd.txt, hello
$ [ok] hart 2 online -> joining scheduler
[ok] hart 1 online -> joining scheduler
$ hello
  [hello] I am a separate program, exec'd from disk!
```

The shell, fork, exec, and cat all run distributed across cores without crashing.

Looking back, multicore was **less about new features and more a fight for "correctness."**
Leaving the single-core code almost untouched, I had to ask "what if two cores step on this line at once?" at every shared point.
The lock baton, the `tp` restore, the lock ordering — all of them were answers to that question.

A note on what's left.
The filesystem (virtio + buffer) still has no lock, because a single-user shell never triggers concurrent access (in general it would need one).
User threads (uthread) are on hold due to our single-page program model, and the network stack is a separate big journey.

From boot to multicore, this hands-on journey of understanding "how an OS actually runs" reaches a milestone here.

> Code: [github.com/dj258255/hobby-kernel](https://github.com/dj258255/hobby-kernel)

### References

- [xv6: a simple, Unix-like teaching operating system (MIT 6.S081)](https://pdos.csail.mit.edu/6.828/2023/xv6.html)
- [RISC-V SBI Specification — HSM extension](https://github.com/riscv-non-isa/riscv-sbi-doc)
- Related: [Semaphores and Mutexes](/blog/theory/semaphore-mutex-sync)

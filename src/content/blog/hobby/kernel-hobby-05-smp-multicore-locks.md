---
title: '멀티코어로 가다: SMP와 락'
titleEn: 'Going Multicore — SMP and Locks'
description: 단일 코어 커널을 여러 코어가 함께 도는 SMP 커널로 키운다. SBI HSM으로 보조 코어를 깨워 부팅하고, 스핀락으로 공유 자료구조를 보호하고, 컨텍스트 스위치를 가로지르며 락을 넘기는 baton 방식으로 멀티코어 스케줄러를 만든다. 그 과정에서 만난 가장 고약한 버그, 곧 유저가 tp 레지스터를 덮어 코어 번호가 틀어지던 문제와 그 해결까지 다룬다.
descriptionEn: "Growing a single-core kernel into an SMP kernel that runs on several cores at once. Booting secondary cores via SBI HSM, protecting shared structures with spinlocks, and building a multicore scheduler with a lock baton handed across the context switch. Plus the nastiest bug along the way — a clobbered tp register that corrupted the core id — and how it was fixed."
date: 2026-06-08T00:00:00.000Z
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
seriesOrder: 6
---


*바닥부터 직접 만드는 RISC-V 토이 커널 연재. 이 글은 6편: 멀티코어(SMP)와 락.*

## 0. 들어가며

지금까지의 커널은 **코어 하나**를 전제로 짜였습니다.
프로세스가 동시에 도는 것처럼 보여도, 사실은 한 코어가 빠르게 번갈아 돌린 것이었습니다([4편의 선점형 스케줄러](/blog/hobby/kernel-hobby-03-exec-and-shell)).
타이머가 울릴 때마다 `yield()`로 실행 중인 프로세스를 갈아끼웠으니까, **시분할(time-sharing)** 이었지 진짜 병렬이 아니었습니다.

이번 글의 주제는 **진짜 동시 실행**입니다. 여러 코어(RISC-V에선 **hart**, 곧 "HARdware Thread"인 CPU 코어 하나)가 같은 커널을 같은 순간에 함께 도는 것입니다.
이게 OS에서 제일 어려운 부분 중 하나입니다.
왜냐하면 두 코어가 같은 자료구조를 정말로 동시에 만지면, 단일 코어에선 평생 멀쩡하던 코드가 비결정적으로 깨지기 때문입니다.

이 글의 흐름은 한 방향으로 쌓입니다.

1. **멀티코어 부팅**: 보조 코어를 깨워 커널에 합류시킨다
2. **스핀락**: 공유 자원을 한 번에 하나만 만지게 한다
3. **멀티코어 스케줄러**: 여러 코어가 공유 proctable에서 프로세스를 가져다 돈다 (이 글의 진짜 핵심)
4. **가장 고약했던 버그**: 코어 번호가 틀어지던 문제
5. **나머지 공유 자원 잠그기**

쌓는 순서는 **부팅 → 스핀락 → 락 baton**이고, 그 이유는 각 단계가 다음의 전제이기 때문입니다. 부팅이 돼야 코어가 여럿이 되고, 스핀락이 있어야 공유 자료구조를 지키고, 그 스핀락을 컨텍스트 스위치를 가로질러 넘길 줄 알아야 스케줄러가 멀티코어에서 안 깨집니다.
**스케줄러가 한가운데 오는 건, 그 앞의 모든 것(부팅·스핀락)을 전제로 깔기 때문**입니다.

> 참고서는 여전히 [xv6(MIT 6.S081)](https://pdos.csail.mit.edu/6.828/2023/xv6.html).
> 락의 기초(뮤텍스/세마포어)는 [세마포어와 뮤텍스](/blog/theory/semaphore-mutex-sync)에서 다룬 적이 있습니다.

## 1. 멀티코어 부팅: 잠든 코어를 깨우기

### 멀티코어 부팅이 풀어야 하는 진짜 문제

> QEMU에 `-smp 3`을 줬으니 코어가 3개입니다. 그런데 전원이 들어왔을 때 커널로 점프하는 건 **딱 하나**뿐입니다. 나머지 둘은 어디 있고, 누가, 어떻게 데려와야 할까요?

부팅 직후의 상황을 정확히 그려보겠습니다.
QEMU virt에서 OpenSBI가 M-mode 셋업을 끝내고 우리 커널을 `0x8020_0000`으로 점프시키는데, 그 점프를 받는 건 **부팅 하트(boot hart) 하나**뿐입니다.
나머지 코어들은 아직 OpenSBI(펌웨어) 안에서 *"누가 나를 깨워주길"* 기다리며 멈춰 있습니다.

그러니 멀티코어로 가는 첫걸음은 명확합니다. 부팅 하트가 초기화를 다 끝낸 뒤, **나머지를 명시적으로 깨워서** 우리 커널 코드로 데려오는 것입니다.

### 배경 개념: SBI HSM (Hart State Management)

> 한 코어가 다른 코어에게 "이 주소에서, 이 모드로 실행을 시작해라"라고 어떻게 명령할까요?

이걸 우리가 직접 하려면 IPI(코어 간 인터럽트)를 쏘고 깨운 코어의 초기 상태를 맞춰주는 저수준 작업을 해야 하는데, RISC-V는 이걸 **SBI HSM**(Hart State Management) 확장으로 표준화해 뒀습니다.
`hart_start`라는 호출 하나로 *"hartid 번 코어를, 이 주소에서, S-mode로 시작해라"* 를 `ecall`로 펌웨어에 부탁하면 됩니다.

```c
// main.c — SBI HSM 확장으로 보조 하트를 깨운다(start_addr=_entry, a0=hartid로 진입).
static long sbi_hart_start(uint64 hartid, uint64 addr) {
    register uint64 a0 asm("a0") = hartid;
    register uint64 a1 asm("a1") = addr;
    register uint64 a2 asm("a2") = 0;
    register uint64 a6 asm("a6") = 0;          // FID 0 = hart_start
    register uint64 a7 asm("a7") = 0x48534D;   // EID "HSM"
    asm volatile("ecall" : "+r"(a0), "+r"(a1) : "r"(a2), "r"(a6), "r"(a7) : "memory");
    return (long)a0;   // SBI error code (0=성공)
}
```

`a7`에 EID `0x48534D`("HSM"의 ASCII)를, `a6`에 FID 0(`hart_start`)을 넣고 `ecall`을 때리는 게 전부입니다.
깨워진 코어는 `addr`(우리는 `_entry`를 넘김)에서 S-mode로 깨어납니다. 이때 **`a0`·`a1`은 OpenSBI가 채워 줍니다**(`a0`=hartid, `a1`=우리가 넘긴 opaque 값). 우리가 `a0`에 hartid를 손수 넣는 게 아니라, 펌웨어가 새 하트를 시작시키며 SBI 규약대로 넣어 주는 것입니다. 부팅 하트가 처음 진입했던 바로 그 경로 그대로입니다.

### 코어마다 자기 스택: 한 스택을 둘이 쓰면 즉사

깨어난 코어가 `_entry`로 들어오면 가장 먼저 할 일은 **자기 스택을 잡는 것**입니다.
이게 왜 중요하냐면, 두 코어가 같은 스택을 쓰면 한 코어가 `push`한 값을 다른 코어가 덮어쓰면서 호출 프레임이 통째로 박살나기 때문입니다.
그래서 `entry.S`에서 hartid로 스택 영역을 나눠 잡습니다.

```asm
# entry.S — tp에 hartid, 코어별 스택: sp = stacks + (hartid+1) * 4096
_entry:
        mv      tp, a0             # tp = hartid (SBI가 a0로 전달)
        csrw    sscratch, a0       # sscratch에도 hartid 보관(트랩 때 tp 복구용)
        la      sp, stacks
        li      t0, 4096
        addi    t1, a0, 1
        mul     t0, t0, t1
        add     sp, sp, t0         # sp = 이 코어 전용 4KB 스택의 top
        call    kmain
```

`stacks`는 `.bss`에 `4096 * 4`(NCPU=4)로 잡아 둔 한 덩어리고, hartid에 4KB씩 곱해 각 코어가 겹치지 않는 자기 구간의 top을 잡습니다. 스택은 그 top에서 **아래 방향으로** 자랍니다(`stacks`는 배열 시작이고 `sp`는 끝으로 가야 하기 때문입니다).
여기서 `csrw sscratch, a0` 한 줄을 눈여겨볼 필요가 있습니다. 지금은 그냥 "hartid를 한 군데 더 백업해 둔다" 정도지만, **4절의 가장 고약한 버그를 막는 핵심**이 됩니다.

### 흔한 오해 정정: "부팅 하트는 항상 0번"

처음엔 자연스럽게 *"hartid가 0이면 부팅 하트, 아니면 보조 코어"* 로 분기했습니다.
그런데 돌려보니 OpenSBI가 **부팅 하트를 2번으로** 고른 적이 있었습니다.

> **흔한 오해 정정**: *"hartid 0번이 항상 먼저 부팅된다"* 는 보장은 어디에도 없습니다. 어느 하트를 부팅 하트로 쓸지는 **OpenSBI(펌웨어)가 비결정적으로** 정합니다. 0번을 가정하고 분기하면, 펌웨어가 2번을 골랐을 때 부팅 코드가 통째로 안 돕니다.

그래서 "hartid 0"이라는 **번호**가 아니라 **"가장 먼저 진입한 하트가 부팅 하트"** 라는 **순서**로 기준을 바꿨습니다.
원자적 플래그 하나로 첫 진입자를 가려냅니다. 여러 코어가 동시에 `kmain`에 들어와도, `__sync_lock_test_and_set`이 *"내가 0을 1로 바꾼 첫 번째 코어인가"* 를 한 명령으로 판정해 줍니다.

```c
// main.c
static int boot_taken = 0;   // 0이면 아직 부팅 하트 없음

void kmain(void) {
    // 먼저 진입한 하트가 부팅 하트(부팅 하트 id는 OpenSBI가 정하며 0이 아닐 수 있다).
    if (__sync_lock_test_and_set(&boot_taken, 1) != 0) {
        hart_main();             // 이미 부팅 하트가 있다 → 나는 보조 코어
        for (;;) asm volatile("wfi");
    }
    // 첫 진입자 = 부팅 하트 → 전체 초기화(트랩·페이징·디스크·셸)
    ...
    // 마지막에 자신을 제외한 모든 하트를 SBI HSM으로 깨운다
    for (int h = 0; h < NHART; h++)
        if ((uint64)h != r_tp())
            sbi_hart_start(h, (uint64)_entry);
    scheduler();    // 부팅 하트도 스케줄러에 합류(돌아오지 않음)
}
```

부팅 하트는 트랩·페이징·디스크·파일시스템·셸을 **혼자 다** 세운 뒤, 마지막에 보조 코어들을 깨웁니다.
깨어난 보조 코어는 `boot_taken`이 이미 1이라 `hart_main`으로 빠지고, 거기서 자기 코어의 satp·트랩·타이머만 잡고 곧장 스케줄러에 합류합니다.

```c
// main.c — 보조 하트 진입점(entry.S → kmain → 여기로)
void hart_main(void) {
    kvminithart();   // 이 코어의 satp에 (부팅 하트가 만든) 커널 페이지 테이블 적재
    trap_init();     // 이 코어의 stvec + 타이머/외부 인터럽트 enable
    timer_init();    // 이 코어의 타이머 시작(선점)
    acquire(&pr_lock);
    uart_puts("[ok] hart "); uart_dec(r_tp());
    uart_puts(" online -> joining scheduler\n");
    release(&pr_lock);
    scheduler();     // 공유 proctable에서 RUNNABLE을 골라 실행(돌아오지 않음)
}
```

> **핵심 교훈**: 멀티코어 부팅의 골자는 *"초기화는 한 코어가 다 하고, 나머지는 깨워서 곧장 스케줄러에 밀어 넣는다"* 입니다. 초기화를 코어마다 중복으로 돌리면 디스크·페이지 테이블이 두 번 만들어져 깨지기 때문입니다.

## 2. 스핀락: 한 번에 하나만

### 스핀락이 풀어야 하는 진짜 문제

> 코어가 둘이 되면, 두 코어가 **같은 순간에** 같은 변수를 고칠 수 있습니다. 단일 코어에선 한 줄씩 차례로 도니까 상관없던 코드가, 왜 갑자기 깨질까요?

구체적인 레이스를 하나 보겠습니다.
페이지 할당기의 프리리스트에서 페이지 하나를 떼는 `kalloc`은 본질적으로 이런 두 줄입니다.

```
r = freelist;          // (1) 맨 앞 페이지를 본다
freelist = r->next;    // (2) 머리를 다음으로 옮긴다
```

코어 A와 코어 B가 동시에 들어왔다고 해봅시다.
A가 (1)에서 `freelist`(페이지 X)를 읽고, B도 (1)에서 **같은 X**를 읽습니다.
둘 다 X를 반환하고, 둘 다 `freelist`를 `X->next`로 옮깁니다.
결과는 이렇습니다. **두 코어가 같은 물리 페이지 X를 자기 것이라 믿고** 페이지 테이블이든 스택이든 거기에 씁니다. 곧 메모리가 박살납니다.

이런 *"읽고-고치고-쓰는(read-modify-write)"* 구간을 **임계구역(critical section)** 이라 하고, 여기에 **한 번에 하나의 코어만** 들어가게 막는 장치가 스핀락입니다.

### 배경 개념: 원자적 교환 (amoswap)

> "잠금 변수가 풀려 있으면 내가 잠근다"를 두 동작(읽기 + 쓰기)으로 나눠 하면, 그 사이에 또 레이스가 납니다. 어떻게 **쪼갤 수 없는 한 동작**으로 만들까요?

해답이 RISC-V의 **원자적 교환** 명령 `amoswap`입니다.
*"잠금 변수를 1로 바꾸면서, 바뀌기 전 값을 본다"* 를 하드웨어가 **한 명령**으로, 다른 코어가 끼어들 틈 없이 처리합니다.
C에선 GCC 내장 `__sync_lock_test_and_set`이 보통 이 `amoswap`(정확히는 `amoswap.w.aq` 같은 acquire 변형)으로 컴파일됩니다. 타깃·최적화에 따라 `LR/SC` 루프가 나올 수도 있지만, 보장되는 건 "원자적 교환"이라는 **의미**입니다.

이전 값이 0이었으면 *"풀려 있던 걸 내가 잠갔다"* 는 뜻이고, 1이었으면 *"남이 쥐고 있다"* 는 뜻이라 풀릴 때까지 제자리에서 빙빙 돕니다(spin).

```c
// spinlock.c
void acquire(struct spinlock *lk) {
    push_off();   // 인터럽트 끄기
    // amoswap: locked를 1로 바꾸고 이전 값을 본다. 0이었으면 내가 잡은 것.
    while (__sync_lock_test_and_set(&lk->locked, 1) != 0)
        ;         // 잠길 때까지 스핀
    __sync_synchronize();    // 임계구역 진입 — 이후 메모리 접근이 앞서가지 않게
}

void release(struct spinlock *lk) {
    __sync_synchronize();    // 임계구역의 쓰기가 락 해제보다 먼저 보이게
    __sync_lock_release(&lk->locked);  // amoswap으로 0
    pop_off();
}
```

`__sync_synchronize()`는 **메모리 배리어**입니다.
컴파일러나 CPU가 성능을 위해 메모리 접근 순서를 바꿀 수 있는데, 락 안에서 그게 일어나면 *"락을 풀었는데도 임계구역의 쓰기가 다른 코어에 아직 안 보이는"* 일이 생길 수 있습니다. 배리어가 그 재배치를 막아 순서를 못 박아 줍니다. (참고로 `__sync_lock_test_and_set`/`__sync_lock_release` 자체도 acquire/release 의미를 가져서, 이 배리어는 그 위에 순서를 한 번 더 분명히 못 박는 셈입니다.)

### 락 없음(레이스) vs 스핀락

| 구분 | 락 없음 | 스핀락 |
|------|--------|--------|
| 임계구역 동시 진입 | 가능 (두 코어가 같은 줄을 밟음) | 불가능 (한 명만 들어감) |
| read-modify-write | 쪼개져서 깨짐 | `amoswap`으로 원자적 |
| 같은 페이지 이중 할당 | 발생 (위의 `kalloc` 레이스) | 차단 |
| 메모리 가시성 | 재배치로 옛 값이 보일 수 있음 | `__sync_synchronize` 배리어로 보장 |
| 비용 | 0 | 스핀(대기) + 배리어 + 인터럽트 끄기 |

### 흔한 오해 정정: "락 잡는 동안 인터럽트는 그대로 둬도 된다"

스핀락에서 정작 까다로운 건 `amoswap`이 아니라 `push_off()`/`pop_off()`입니다.

> **흔한 오해 정정**: *"락은 다른 코어를 막는 거니까, 내 코어의 인터럽트는 켜둬도 되지 않나?"* 안 됩니다. 락을 쥔 채로 인터럽트가 들어와 그 핸들러가 **같은 락**을 또 잡으려 하면, 자기 자신이 풀어주길 영원히 기다리는 **자기 자신과의 데드락**에 빠집니다. 그래서 락을 쥔 동안엔 그 코어의 인터럽트를 꺼야 합니다.

문제는 락이 **중첩**될 수 있다는 점입니다(락 A를 쥔 채 락 B를 잡는 경우).
이때 안쪽 락 B를 놓자마자 인터럽트를 켜버리면, 아직 바깥 락 A를 쥐고 있는데 인터럽트가 들어와 위험해집니다.
그래서 `push_off`/`pop_off`가 인터럽트 끄기를 **중첩 카운트(noff)** 로 관리합니다. *가장 바깥에서 끄고, 가장 바깥에서만 켠다.*

```c
// spinlock.c — 코어별 인터럽트 끔 중첩 횟수(noff) + 끄기 전 원래 상태(intena)
struct cpu { int noff; int intena; };
static struct cpu cpus[NCPU];
static struct cpu *mycpu(void) { return &cpus[r_tp()]; }

void push_off(void) {
    int old = intr_get();
    intr_off();
    struct cpu *c = mycpu();
    if (c->noff == 0)
        c->intena = old;     // 가장 바깥에서만 원래 상태 기억
    c->noff += 1;
}

void pop_off(void) {
    struct cpu *c = mycpu();
    c->noff -= 1;
    if (c->noff == 0 && c->intena)
        intr_on();           // 가장 바깥 release에서만 복원
}
```

여기서 `mycpu()`가 `cpus[r_tp()]`로 **자기 코어의** 카운터를 찾는다는 점, 그리고 그게 `r_tp()`(=hartid)에 전적으로 의존한다는 점을 기억해 둘 필요가 있습니다. 4절에서 `r_tp()`가 틀어지면 이 카운터까지 통째로 엉뚱한 코어 것을 만지게 됩니다.

## 3. 멀티코어 스케줄러: 락 baton

이게 이번 글의 진짜 핵심입니다.
스핀락으로 *"가만히 있는 자료구조"* 는 지킬 수 있게 됐는데, 가장 어려운 건 **"프로세스를 컨텍스트 스위치하는 그 찰나"**입니다.

### 컨텍스트 스위치의 레이스가 풀어야 하는 진짜 문제

> 스케줄러가 프로세스 P를 골라 실행하고, 나중에 P가 양보(yield)하면 다시 스케줄러로 돌아옵니다. 이 "골라서 들어가고, 양보하며 나오는" 전환의 한가운데에서, **다른 코어가 같은 P를 집어가면** 어떻게 될까요?

이런 레이스를 상상해 봅시다.
코어 A의 프로세스 P가 yield하면서 자기 상태를 RUNNABLE로 바꾸고 **P의 스택에서 스케줄러 스택으로 빠져나가는 도중**입니다.
바로 그 찰나에 코어 B의 스케줄러가 proctable을 훑다 *"어, P가 RUNNABLE이네"* 하고 P를 RUNNING으로 점유한 뒤 **P의 컨텍스트로 swtch해 들어갑니다.**

그러면 **두 코어가 같은 P의 같은 커널 스택을** 동시에 쓰게 됩니다.
A는 아직 그 스택에서 빠져나가는 중이고, B는 그 스택으로 들어오는 중이라, P의 스택이 그대로 박살납니다.
스핀락만으로는 이게 안 막힙니다. 전환은 *"자료구조를 잠깐 만지는 일"* 이 아니라 *"스택과 PC를 통째로 갈아타는 일"* 이라 임계구역이 `swtch` 양쪽으로 걸쳐 있기 때문입니다.

### 배경 개념: 직접 thread-to-thread vs 스케줄러 경유

> P가 양보할 때 다음 프로세스 Q로 **곧장** swtch하면 안 되나요? 왜 굳이 매번 스케줄러를 거칠까요?

| 구분 | 직접 thread-to-thread | 스케줄러 경유 (이 커널) |
|------|---------------------|----------------------|
| 전환 경로 | P → Q 직접 swtch | P → 스케줄러 → Q |
| "다음에 뭘 돌릴지" 결정 | P가 직접 골라야 함 | 스케줄러 한 곳이 결정 |
| 멀티코어 안전성 | P가 Q를 고르는 사이 또 레이스 | 락을 한 지점(스케줄러)에서 통제 |
| 락 넘기기 | 짝이 불규칙해 어려움 | swtch 양쪽이 항상 스케줄러 ↔ proc |

이 커널은 **항상 스케줄러를 경유**합니다(xv6와 같음).
P는 자기가 다음 프로세스를 고르지 않고, 무조건 스케줄러 컨텍스트(`cpu_sched[id]`)로 돌아간 뒤 스케줄러가 다음을 고릅니다.
이러면 전환의 한쪽 끝이 **항상 스케줄러**라, 락을 "스케줄러 ↔ proc" 한 쌍 사이에서만 주고받으면 돼서 규칙이 단순해집니다.

### 해결: 락을 swtch를 가로질러 든다 (baton)

핵심 아이디어는 이것입니다. **`pt_lock`(proctable 보호 락)을 컨텍스트 스위치를 가로질러 쥔 채로 넘긴다.**

마치 **배턴을 주고받듯**, 락이 swtch의 양쪽으로 넘어갑니다.

- 스케줄러가 `pt_lock`을 **잡고**, P를 RUNNING으로 점유한 뒤, **락을 든 채로** P로 `swtch`해 들어갑니다.
- P는 (첫 실행 지점이나 yield 지점에서) 그 **락을 놓습니다.**
- P가 다시 양보할 땐 **락을 잡고** `swtch`로 스케줄러에 돌아오고, 스케줄러가 그 **락을 놓습니다.**

이 baton 동안엔 `pt_lock`이 한순간도 풀리지 않으니, **다른 코어가 P를 절대 못 집습니다.** P가 전환을 완전히 끝낼 때까지 P는 락 뒤에 숨어 있는 셈입니다.

```c
// proc.c — 스케줄러: pt_lock을 잡고 RUNNABLE을 점유한 뒤, 락을 든 채로 swtch
void scheduler(void) {
    int id = r_tp();
    cpu_proc[id] = 0;
    for (;;) {
        intr_on();   // 이 코어가 인터럽트/wakeup을 받을 수 있게
        acquire(&pt_lock);
        for (int i = 0; i < NPROC; i++) {
            struct proc *p = &proctable[i];
            if (p->state == RUNNABLE) {
                p->state = RUNNING;
                cpu_proc[id] = p;
                switch_satp(p->pagetable);
                swtch(&cpu_sched[id], &p->context);  // pt_lock 든 채로 진입(proc이 놓음)
                switch_satp(kernel_pt());
                cpu_proc[id] = 0;                    // 복귀 시 pt_lock 다시 들고 있음
            }
        }
        release(&pt_lock);
    }
}
```

반대편(proc 쪽)에서 `yield`는 거울상입니다. 락을 **잡고** swtch로 나가고, 스케줄러가 잡아줬던 락을 다음에 스케줄될 때 자기가 풉니다.

```c
// proc.c — 현재 proc이 CPU를 스케줄러에 양보. pt_lock을 든 채로 swtch.
void yield(void) {
    int id = r_tp();
    struct proc *p = cpu_proc[id];
    if (!p) return;
    acquire(&pt_lock);
    if (p->state == RUNNING)
        p->state = RUNNABLE;
    swtch(&p->context, &cpu_sched[id]);  // pt_lock 든 채로 스케줄러로(스케줄러가 놓음)
    release(&pt_lock);                   // 다시 스케줄되면 여기서 락 해제
}
```

### 첫 실행은 yield 지점이 아니다: 진입 함수가 락을 놓는다

여기 함정이 하나 있습니다.
이미 한 번 돌던 프로세스는 `yield` 안의 `swtch`에서 멈췄다가 거기서 깨어나니, 깨어난 직후의 `release(&pt_lock)`가 baton을 받아 풀어줍니다.
그런데 **갓 만들어진 프로세스가 처음 실행될 때**는 yield 지점이 아니라 **진입 함수의 맨 처음**에서 시작합니다. 그래서 그 진입 함수들이 스케줄러가 쥐여 준 락을 직접 놓아줘야 baton이 끊기지 않습니다.

이 커널엔 진입 함수가 셋 있고, 셋 다 첫 줄이 `release(&pt_lock)`입니다.

```c
// proc.c — 유저 프로세스가 처음 실행될 때: S-mode → U-mode 진입
static void enter_user(void) {
    release(&pt_lock);   // 스케줄러가 잡은 락을 놓는다(첫 실행)
    uint64 s = r_sstatus();
    s &= ~SSTATUS_SPP;   // SPP=0 → sret 시 U-mode로
    s |= SSTATUS_SPIE;   // U-mode에서 인터럽트 enable(선점 가능)
    s |= SSTATUS_SUM;
    w_sstatus(s);
    w_sepc(USERVA);
    asm volatile("mv sp, %0\n sret\n" :: "r"((uint64)USERSTACKTOP));
}

// fork된 자식의 첫 실행: 락을 놓고 부모가 만들어 둔 트랩 프레임으로 복귀
void forkret(void) {
    release(&pt_lock);
    struct proc *p = cpu_proc[r_tp()];
    trapret_from(p->tf_va);
}

// 커널 스레드의 첫 실행: 락을 놓고 본체 호출
static void thread_start(void) {
    release(&pt_lock);
    intr_on();
    current_proc()->fn();
    proc_exit();
    for (;;) ;
}
```

새 프로세스의 `context.ra`를 이 함수들 중 하나로 세팅해 두니(예: `p->context.ra = (uint64)enter_user`), 첫 `swtch`가 곧장 진입 함수로 점프하고, 그 첫 줄이 baton을 받아 락을 풉니다.

### sleep/wakeup도 같은 락 위에서: 잃어버린 wakeup 막기

`pt_lock`은 스케줄링만 지키는 게 아닙니다. `sleep`/`wakeup`도 이 같은 락 위에서 돕니다.
이게 왜 중요하냐면, **잃어버린 wakeup(lost wakeup)** 이라는 고전적 레이스를 막기 때문입니다.

`read()`가 콘솔 입력을 기다리는 상황을 봅시다.

```
1. "입력 버퍼가 비었나?" 검사 — 비었다
2. sleep(버퍼)  — 잠든다
```

(1)과 (2) 사이에 다른 코어의 UART 인터럽트가 끼어들어 글자를 채우고 `wakeup(버퍼)`을 호출하면?
아직 잠들기 전이라 그 wakeup은 **아무도 못 받고 허공으로 사라지고**, 그 직후 (2)에서 잠들어 **영원히 안 깨어납니다.**

해결은 *"검사와 sleep을 같은 락 아래 원자적으로 묶는 것"* 입니다.
호출자가 `pt_lock`을 **쥔 채로** `sleep`에 들어오고, `sleep`은 그 락을 든 채로 swtch합니다. `wakeup`도 같은 락을 쥐어야 하니, 검사~sleep 구간엔 wakeup이 끼어들 수 없습니다.

```c
// proc.c — chan에서 잠든다. 호출자가 pt_lock을 쥐고 들어온다(검사↔sleep 원자성).
void sleep(void *chan) {
    int id = r_tp();
    struct proc *p = cpu_proc[id];
    if (!p) return;
    p->chan = chan;
    p->state = SLEEPING;
    swtch(&p->context, &cpu_sched[id]);  // pt_lock held → 스케줄러로(스케줄러가 놓음)
    p->chan = 0;                         // 깨어나면(pt_lock held) 여기서 재개
}

// chan에서 자는 모든 프로세스를 RUNNABLE로. 호출자가 pt_lock을 쥐고 있어야 한다.
void wakeup(void *chan) {
    for (int i = 0; i < NPROC; i++) {
        struct proc *p = &proctable[i];
        if (p->state == SLEEPING && p->chan == chan)
            p->state = RUNNABLE;
    }
}
```

`proc_wait`가 좋은 예시입니다. `acquire(&pt_lock)` 한 번 잡은 뒤, 그 락 안에서 *"종료한 자식이 있나"* 검사하고, 없으면 같은 락을 든 채로 `sleep(p)` 합니다. 자식이 `proc_exit`에서 `wakeup(부모)`을 부르는 것도 같은 락 아래라, 그 사이에 깨움을 흘릴 일이 없습니다.

> **핵심 교훈**: 멀티코어 스케줄러의 정확성은 *"`pt_lock` 하나가 컨텍스트 스위치를 가로질러 끊김 없이 넘어간다"* 는 단 하나의 불변식에 달려 있습니다. 스케줄러가 잡고 → proc이 놓고 → proc이 잡고 → 스케줄러가 놓고. 이 baton이 한 번이라도 끊기면 두 코어가 같은 proc을 밟습니다.

## 4. 가장 고약했던 버그: 사라진 코어 번호

### 증상: 간헐적 크래시

보조 코어를 스케줄러에 넣자마자, `hello`를 실행하면 **간헐적으로** 크래시가 났습니다.
어떤 실행은 멀쩡하고 어떤 실행은 죽는, 전형적인 레이스 증상이었습니다.
폴트 로그를 따라가 보니 `proc_fork`의 한 줄이었습니다.

```
[trap] EXCEPTION  scause=0xd  sepc=0x80201e10  stval=0x00000000000000a8
```

`scause=0xd`는 **load page fault**, `stval=0xa8`(168)은 폴트가 난 주소입니다.
거의 null인 포인터의 168번째 바이트를 읽다 죽은 것입니다.
디스어셈블해 보니 `current_proc()`가 **null**을 반환하고 있었습니다.

### 원인: tp는 그냥 hartid가 아니다

`current_proc()`를 보면 원인이 보입니다.

```c
// proc.c
static struct proc *cpu_proc[NCPU];   // 코어별 현재 proc
struct proc *current_proc(void) { return cpu_proc[r_tp()]; }
```

`r_tp()`(=hartid)를 인덱스로 *"이 코어가 지금 돌리는 proc"* 을 꺼냅니다.
그런데 `r_tp()`가 엉뚱한 값을 반환하면, `cpu_proc[엉뚱한 인덱스]`가 0(null)이 나오고, 그 null의 168번째 바이트(`proc` 구조체의 어떤 필드)를 읽다 폴트가 나는 것입니다.

원인은 정말 미묘했습니다.

> **흔한 오해 정정**: *"`tp` 레지스터는 그냥 hartid다"* 라고 믿었던 게 함정이었습니다. `tp`는 ABI상 **유저 프로그램의 스레드 포인터**라, 유저가 자기 용도로 언제든 덮어쓸 수 있는 레지스터입니다. 우리가 거기에 hartid를 넣어 뒀다고 해서 유저가 안 건드린다는 보장은 전혀 없습니다.

우리 커널은 부팅 때 `entry.S`에서 `tp`에 hartid를 담아 뒀습니다(`mv tp, a0`).
그런데 유저 프로그램이 U-mode에서 돌다 `tp`를 자기 스레드 포인터로 덮어씁니다.
그 상태에서 트랩(타이머·시스템콜)이 나면 커널로 들어오는데, **커널 코드가 도는 동안에도 `tp`엔 여전히 유저가 써 놓은 값**이 들어 있습니다.
그래서 `r_tp()`가 hartid가 아닌 유저 쓰레기 값을 반환하고 → `cpu_proc[쓰레기]` → null → 크래시.

### 왜 단일 코어에선 안 터졌나

이 버그는 4편까지 단 한 번도 안 터졌습니다.
단일 코어에선 부팅 하트가 우연히 0번이고, 유저 프로그램의 `tp` 초기값도 (ABI가 보장하는 값은 아니지만) 우연히 0이라서, **유저가 덮어써도 `r_tp()`가 0** → `cpu_proc[0]`이 맞는 답이라 *우연히* 맞아떨어졌습니다.

그런데 멀티코어에선 프로세스가 1번·2번 코어에서 돕니다.
유저 `tp`(0)와 실제 코어 번호(1, 2)가 달라지는 순간, `cpu_proc[0]`은 *그 코어의* 현재 proc이 아니라 엉뚱한 슬롯이라 바로 드러났습니다.
"단일 코어에선 우연히 맞던 값이 멀티코어에서 진실을 드러낸다", 멀티코어 버그의 전형입니다.

### 해결: sscratch로 tp를 복구

해결은 xv6와 같습니다.
hartid의 **진짜 출처**를 유저가 못 건드리는 곳에 따로 둬야 합니다. 그게 1절에서 봐 둔 `sscratch`(S-mode 스크래치 CSR)입니다. U-mode에선 접근조차 못 하니 유저가 덮을 수 없습니다. (CSR은 **privilege가 다르면 읽고 쓸 수 없습니다.** `sscratch`는 S-mode 것이라 U-mode에선 건드릴 방법이 아예 없습니다.)

부팅 때 hartid를 `sscratch`에도 박아 두고(1절의 `csrw sscratch, a0`), **트랩에 진입하는 순간 `tp`를 거기서 복구**합니다.

```asm
# entry.S — 부팅 시 코어마다 (1절에서 본 그 줄)
csrw    sscratch, a0       # sscratch = hartid (유저는 S-mode CSR을 못 건드림)

# kernelvec.S — 트랩 진입, 레지스터 저장 직후
csrr    tp, sscratch       # tp = hartid 복구 (유저가 tp를 덮었어도)
```

`kernelvec`은 트랩 당한 코드의 `tp`를 일단 스택 프레임에 저장한 뒤(`sd tp, 16(sp)`), 곧바로 `csrr tp, sscratch`로 **커널이 쓸 `tp`를 hartid로 되돌려** 놓습니다.
그래야 그 뒤로 호출되는 `kerneltrap` → `current_proc()` → `mycpu()`가 전부 올바른 코어 번호를 봅니다.
복귀할 땐 `trapret`이 프레임에 저장해 둔 유저의 `tp`(`ld tp, 16(sp)`)를 그대로 되돌려 주니, 유저는 자기가 써 둔 값을 그대로 받습니다.

이 두 줄로 크래시가 깨끗이 사라졌습니다.
*"레지스터 하나의 의미를 누가 소유하는가"*, 유저 ABI의 `tp`와 커널의 hartid가 같은 레지스터를 두고 충돌하는 문제였고, 그 경계를 트랩 진입/복귀에서 명확히 그어 준 게 답이었습니다.

## 5. 나머지 공유 자원 잠그기

스케줄러가 안정되고 `tp`까지 바로잡으니, 남은 공유 자원들도 차례로 락을 채웠습니다.
원칙은 하나입니다. *"두 코어가 동시에 이 줄을 밟으면?"* 이라는 질문을 모든 공유 지점에 던지는 것입니다.

- **페이지 할당기**(`kalloc`/`kfree`): 2절 도입부의 그 프리리스트 레이스를 막으려고 전용 `kmem_lock`으로 보호합니다. 여러 코어가 동시에 페이지를 떼고 돌려줘도 같은 페이지가 두 번 나가지 않습니다.
- **콘솔 버퍼**: 입력 버퍼와 `sleep`/`wakeup`을 스케줄러 락(`pt_lock`)으로 함께 보호합니다. 3절의 잃어버린 wakeup을 막는 게 핵심입니다.
- **UART 출력**: 락이 없으면 두 코어의 출력이 **글자 단위로 섞입니다**(보조 코어가 *"[ok] hart ..."* 를 찍는 사이 다른 코어가 끼어드는 식). 메시지 단위로 직렬화하는 `pr_lock`을 둬서 한 줄이 통째로 나가게 했습니다.

### 락 순서: 데드락을 막는 규칙

여기서 **락 순서(lock ordering)** 가 중요해집니다.
두 락을 중첩해서 잡을 때, 코어 A가 `pt_lock → uart_lock` 순서로 잡는데 코어 B가 `uart_lock → pt_lock` 순서로 잡으면, A는 uart를 B는 pt를 쥔 채 서로를 기다리는 **데드락**에 빠집니다.

규칙은 단순합니다. **모든 코어가 항상 같은 순서로 락을 잡는다.**
`pt_lock`을 쥔 채로 `uart_lock`을 잡는 경로는 있어도, 그 반대는 절대 없게 했습니다.
UART 락을 항상 **가장 안쪽(leaf)**, 곧 그 락을 쥔 동안엔 다른 락을 더 잡지 않는 위치에 두면 이 규칙이 자연히 지켜집니다.

## 정리

이 글은 단일 코어 커널을 **3개 코어가 함께 도는 SMP 커널**로 키웠습니다.
다섯 조각이 한 방향으로 쌓입니다.

- **멀티코어 부팅**: 부팅 하트 하나가 전체 초기화를 끝내고, SBI HSM `hart_start`로 나머지를 깨워 곧장 스케줄러에 합류시킵니다. 부팅 하트 번호는 비결정적이라 **원자 플래그(`boot_taken`)로 첫 진입자**를 부팅 하트로 삼습니다.
- **스핀락**: `amoswap`(`__sync_lock_test_and_set`)으로 임계구역에 한 코어만 들이고, `__sync_synchronize` 배리어로 가시성을 보장합니다. 락을 쥔 동안엔 `push_off`/`pop_off`가 **중첩 카운트**로 인터럽트를 끕니다(자기 자신과의 데드락 방지).
- **멀티코어 스케줄러(락 baton)**: `pt_lock`을 **컨텍스트 스위치를 가로질러** 든 채로 넘겨, 전환의 찰나에 다른 코어가 같은 proc을 못 집게 합니다. 첫 실행은 `enter_user`/`forkret`/`thread_start`가 락을 놓고, `sleep`/`wakeup`도 같은 락으로 잃어버린 wakeup을 막습니다.
- **`tp`/`sscratch` 버그**: 유저가 `tp`를 덮어 `r_tp()`가 틀어지던 간헐적 크래시를, hartid를 `sscratch`에 두고 **트랩 진입 때 `csrr tp, sscratch`로 복구**해 해결했습니다. 단일 코어에선 우연히 0이 맞아 안 터졌던 버그입니다.
- **나머지 공유 자원**: 페이지 할당기·콘솔·UART에 락을 채우고, **락 순서**(UART를 leaf로)로 데드락을 막았습니다.

이제 `-smp 3`으로 부팅하면 **3개 코어가 공유 proctable에서 프로세스를 가져다 동시에** 돌립니다.

```
[ok] boot hart 0 up; waking other cores + starting shell
kernel-hobby userspace shell. try: ls, cat motd.txt, hello
$ [ok] hart 2 online -> joining scheduler
[ok] hart 1 online -> joining scheduler
$ hello
  [hello] I am a separate program, exec'd from disk!
```

셸·fork·exec·cat이 여러 코어에 분산돼 돌아도 크래시 없이 동작합니다.

돌아보면, 멀티코어는 **새 기능이라기보다 "정확성"의 싸움**이었습니다.
단일 코어 코드를 거의 그대로 두고도, *"두 코어가 동시에 이 줄을 밟으면?"* 이라는 질문을 모든 공유 지점에 던져야 했습니다.
락 baton, `tp` 복구, 락 순서, 전부 그 질문에 대한 답이었습니다.

남은 정제거리도 적어두겠습니다.
파일시스템(virtio+버퍼)은 단일 사용자 셸이라 동시 접근이 안 생겨 아직 락이 없습니다(일반적으론 필요).
유저 스레드(uthread)는 우리 단일 페이지 프로그램 모델 제약으로 보류, 네트워크 스택은 별도의 큰 여정입니다.

지금까지 만든 건 부팅·유저 프로그램 실행·시스템콜·가상메모리·선점형 스케줄링, 그리고 이제 SMP까지 갖춘 **작은 유닉스 계열 커널**입니다. 파일시스템 확장과 네트워크처럼 갈 길은 남았지만, **운영체제의 핵심 골격은 이제 거의 다 손으로 직접 만든 셈**입니다. "OS가 어떻게 도는가"를 손으로 만져 이해하는 이 여정이 여기서 한 매듭을 짓습니다.

> 코드: [github.com/dj258255/kernel-hobby](https://github.com/dj258255/kernel-hobby)

## 참고 (1차 자료 우선)

- [RISC-V Privileged Specification](https://riscv.org/technical/specifications/): `sscratch`/`stvec`/`scause`, `amoswap`(A 확장), `tp`의 의미와 S-mode CSR의 1차 정의
- [RISC-V SBI Specification: HSM 확장](https://github.com/riscv-non-isa/riscv-sbi-doc): `hart_start`(EID 0x48534D, FID 0)로 보조 하트를 깨우는 표준 호출
- [xv6: a simple, Unix-like teaching operating system (MIT 6.S081)](https://pdos.csail.mit.edu/6.828/2023/xv6.html): 스핀락·`push_off`/`pop_off`·락 baton 스케줄러·`sscratch` tp 복구가 1:1로 대응
- [OpenSBI Documentation](https://github.com/riscv-software-src/opensbi): 부팅 하트 선택이 비결정적인 이유, M-mode → S-mode 인계
- 관련 글: [세마포어와 뮤텍스](/blog/theory/semaphore-mutex-sync)

<!-- EN -->

*A RISC-V toy kernel built from scratch — a blog series. This is Part 6: multicore (SMP) and locks.*

## 0. Introduction

Up to now the kernel assumed a **single core**.
Processes looked concurrent, but really one core was switching between them quickly ([the preemptive scheduler in Part 4](/blog/hobby/kernel-hobby-03-exec-and-shell)).
Every timer tick called `yield()` to swap out the running process — so it was **time-sharing**, not true parallelism.

This post is about **true concurrent execution** — several cores (**harts** in RISC-V — "HARdware Thread", a single CPU core) running the same kernel at the very same instant.
This is one of the hardest parts of an OS.
Because when two cores really do touch the same data structure at once, code that was fine on a single core forever breaks nondeterministically.

The flow stacks in one direction.

1. **Multicore boot** — wake the secondary cores and bring them into the kernel
2. **Spinlocks** — let only one core touch a shared resource at a time
3. **A multicore scheduler** — several cores pull processes from a shared proctable (the real heart of this post)
4. **The nastiest bug** — a corrupted core id
5. **Locking the remaining shared resources**

We build in the order **boot → spinlocks → lock baton**, because each is a prerequisite for the next: you need boot before there are several cores, spinlocks to guard shared structures, and the ability to hand a spinlock across a context switch before the scheduler stops breaking on multicore.
**The scheduler sits in the middle precisely because it stands on everything before it (boot and spinlocks).**

> The reference is still [xv6 (MIT 6.S081)](https://pdos.csail.mit.edu/6.828/2023/xv6.html).
> The basics of locking (mutex/semaphore) are covered in [Semaphores and Mutexes](/blog/theory/semaphore-mutex-sync).

## 1. Multicore boot — waking the sleeping cores

### The real problem multicore boot has to solve

> We passed `-smp 3` to QEMU, so there are 3 cores. But when power comes on, **exactly one** jumps into the kernel. Where are the other two, and who brings them in, and how?

Let me paint the picture right after boot.
On QEMU virt, OpenSBI finishes the M-mode setup and jumps our kernel to `0x8020_0000` — but only the **boot hart** receives that jump.
The other cores are still parked inside OpenSBI (the firmware), waiting for *someone to wake them.*

So the first step toward multicore is clear — after the boot hart finishes initialization, it must **explicitly wake the rest** and bring them into our kernel code.

### Background — SBI HSM (Hart State Management)

> How does one core tell another "start executing at this address, in this mode"?

Doing this ourselves would mean firing IPIs (inter-core interrupts) and setting up the woken core's initial state by hand — but RISC-V standardizes it behind the **SBI HSM** (Hart State Management) extension.
One call, `hart_start`, lets us `ecall` the firmware to say *"start hart number `hartid`, at this address, in S-mode."*

```c
// main.c — wake a secondary hart via SBI HSM (enters at start_addr=_entry with a0=hartid).
static long sbi_hart_start(uint64 hartid, uint64 addr) {
    register uint64 a0 asm("a0") = hartid;
    register uint64 a1 asm("a1") = addr;
    register uint64 a2 asm("a2") = 0;
    register uint64 a6 asm("a6") = 0;          // FID 0 = hart_start
    register uint64 a7 asm("a7") = 0x48534D;   // EID "HSM"
    asm volatile("ecall" : "+r"(a0), "+r"(a1) : "r"(a2), "r"(a6), "r"(a7) : "memory");
    return (long)a0;   // SBI error code (0 = success)
}
```

Putting EID `0x48534D` (ASCII for "HSM") in `a7`, FID 0 (`hart_start`) in `a6`, and issuing `ecall` is all there is to it.
The woken core comes up at `addr` (we pass `_entry`) in S-mode — and **OpenSBI fills `a0` and `a1`** (`a0` = hartid, `a1` = the opaque value we passed). We don't put hartid in `a0` ourselves; the firmware sets it per the SBI convention as it starts the new hart — exactly the path the boot hart first took.

### A stack per core — sharing one stack is instant death

When a woken core enters `_entry`, the very first thing it does is **claim its own stack.**
Why does this matter? Because if two cores share one stack, one core's `push` overwrites the other's, and entire call frames get destroyed.
So `entry.S` carves out a per-hart stack by hartid.

```asm
# entry.S — tp = hartid, per-core stack: sp = stacks + (hartid+1) * 4096
_entry:
        mv      tp, a0             # tp = hartid (SBI passes it in a0)
        csrw    sscratch, a0       # also keep hartid in sscratch (to restore tp on trap)
        la      sp, stacks
        li      t0, 4096
        addi    t1, a0, 1
        mul     t0, t0, t1
        add     sp, sp, t0         # sp = top of this core's private 4KB stack
        call    kmain
```

`stacks` is one `.bss` block of `4096 * 4` (NCPU=4), and we multiply hartid by 4KB so each core gets the top of its own non-overlapping slice. The stack then grows **downward** from that top (`stacks` is the array's start, while `sp` must sit at the end).
Note that one line, `csrw sscratch, a0` — right now it's just "back up hartid in one more place," but it becomes **the key to defeating the nastiest bug in §4.**

### Common misconception fix — "the boot hart is always hart 0"

At first I naturally branched on *"hartid 0 means boot hart, otherwise secondary."*
But in practice OpenSBI once picked **hart 2** as the boot hart.

> **Common misconception fix**: there's no guarantee anywhere that *"hart 0 always boots first."* Which hart serves as the boot hart is decided **nondeterministically by OpenSBI (the firmware).** Branch on the assumption of 0, and when the firmware picks 2, your boot code simply doesn't run.

So I changed the criterion from a **number** ("hartid 0") to an **order** (*"the first hart to enter is the boot hart"*).
A single atomic flag picks the first arrival — even if several cores enter `kmain` at once, `__sync_lock_test_and_set` decides *"am I the first core to flip 0 to 1?"* in one instruction.

```c
// main.c
static int boot_taken = 0;   // 0 = no boot hart yet

void kmain(void) {
    // The first to enter is the boot hart (its id is chosen by OpenSBI and may not be 0).
    if (__sync_lock_test_and_set(&boot_taken, 1) != 0) {
        hart_main();             // a boot hart already exists → I am a secondary core
        for (;;) asm volatile("wfi");
    }
    // first arrival = boot hart → full init (traps, paging, disk, shell)
    ...
    // finally wake every hart except myself via SBI HSM
    for (int h = 0; h < NHART; h++)
        if ((uint64)h != r_tp())
            sbi_hart_start(h, (uint64)_entry);
    scheduler();    // the boot hart joins the scheduler too (never returns)
}
```

The boot hart raises traps, paging, disk, filesystem, and the shell **all by itself**, then wakes the secondary cores last.
A woken core finds `boot_taken` already 1, falls into `hart_main`, brings up only its own core's satp/traps/timer, and joins the scheduler right away.

```c
// main.c — secondary hart entry (entry.S → kmain → here)
void hart_main(void) {
    kvminithart();   // load the (boot hart's) kernel page table into this core's satp
    trap_init();     // this core's stvec + timer/external interrupt enable
    timer_init();    // start this core's timer (preemption)
    acquire(&pr_lock);
    uart_puts("[ok] hart "); uart_dec(r_tp());
    uart_puts(" online -> joining scheduler\n");
    release(&pr_lock);
    scheduler();     // pick RUNNABLE from the shared proctable and run it (never returns)
}
```

> **Key takeaway**: the gist of multicore boot is *"one core does all the init, and the rest are woken and pushed straight into the scheduler."* Run init redundantly per core and you build the disk and page tables twice, and it breaks.

## 2. Spinlocks — one at a time

### The real problem spinlocks have to solve

> Once there are two cores, two cores can modify the **same variable at the same instant**. Code that was fine when one core ran line by line — why does it suddenly break?

Let me show a concrete race.
`kalloc`, which pops a page off the allocator's free list, is essentially these two lines.

```
r = freelist;          // (1) look at the front page
freelist = r->next;    // (2) move the head to the next
```

Suppose cores A and B enter at once.
A reads `freelist` (page X) at (1), and B reads the **same X** at (1) too.
Both return X, and both move `freelist` to `X->next`.
The result — **two cores each believe page X is theirs** and write a page table or a stack into it. Memory gets shredded immediately.

That *"read-modify-write"* region is a **critical section**, and a spinlock is what lets **only one core at a time** enter it.

### Background — atomic exchange (amoswap)

> If "lock it if it's free" is split into two steps (read + write), another race sneaks in between. How do we make it **one indivisible action**?

The answer is RISC-V's **atomic exchange** instruction, `amoswap`.
*"Set the lock variable to 1 and read its pre-change value"* is done by hardware as **one instruction**, with no window for another core to slip in.
In C, GCC's builtin `__sync_lock_test_and_set` usually compiles to this `amoswap` (precisely an acquire variant like `amoswap.w.aq`) — depending on the target and optimization it may instead emit an `LR/SC` loop, but what's guaranteed is the *meaning*: an atomic exchange.

If the previous value was 0, it means *"it was free and I locked it"*; if it was 1, *"someone else holds it,"* so we spin in place until it frees up.

```c
// spinlock.c
void acquire(struct spinlock *lk) {
    push_off();   // disable interrupts
    // amoswap: set locked to 1 and read its old value. If it was 0, I got it.
    while (__sync_lock_test_and_set(&lk->locked, 1) != 0)
        ;         // spin until acquired
    __sync_synchronize();    // entering the critical section — keep later accesses from racing ahead
}

void release(struct spinlock *lk) {
    __sync_synchronize();    // make the critical-section writes visible before the unlock
    __sync_lock_release(&lk->locked);  // amoswap to 0
    pop_off();
}
```

`__sync_synchronize()` is a **memory barrier**.
The compiler and CPU may reorder memory accesses for performance, and if that happens inside the lock you can get *"the critical section's writes still aren't visible to other cores even though the lock is released."* The barrier blocks that reordering and pins the order down. (Note that `__sync_lock_test_and_set`/`__sync_lock_release` themselves carry acquire/release semantics, so this barrier just makes the ordering even more explicit on top of that.)

### No lock (race) vs spinlock

| Aspect | No lock | Spinlock |
|--------|---------|----------|
| Concurrent entry to critical section | possible (two cores step on the same line) | impossible (only one enters) |
| read-modify-write | torn apart, breaks | atomic via `amoswap` |
| double-allocating one page | happens (the `kalloc` race above) | blocked |
| memory visibility | reordering can expose stale values | guaranteed by the `__sync_synchronize` barrier |
| cost | 0 | spin (wait) + barrier + disabling interrupts |

### Common misconception fix — "leave interrupts on while holding a lock"

The truly tricky part of a spinlock isn't `amoswap` — it's `push_off()`/`pop_off()`.

> **Common misconception fix**: *"the lock blocks other cores, so surely I can leave my own core's interrupts on?"* — no. If an interrupt arrives while you hold the lock and its handler tries to grab the **same lock**, you fall into a **deadlock against yourself**, waiting forever for yourself to release it. So while holding a lock, that core's interrupts must be off.

The catch is that locks can **nest** (hold lock A while grabbing lock B).
If you re-enable interrupts the moment you release the inner lock B while still holding the outer lock A, an interrupt can slip in dangerously.
So `push_off`/`pop_off` manage interrupt-disabling with a **nesting count (noff)** — *disable at the outermost, and only re-enable at the outermost.*

```c
// spinlock.c — per-core interrupt-off nesting count (noff) + pre-disable state (intena)
struct cpu { int noff; int intena; };
static struct cpu cpus[NCPU];
static struct cpu *mycpu(void) { return &cpus[r_tp()]; }

void push_off(void) {
    int old = intr_get();
    intr_off();
    struct cpu *c = mycpu();
    if (c->noff == 0)
        c->intena = old;     // remember the original state only at the outermost
    c->noff += 1;
}

void pop_off(void) {
    struct cpu *c = mycpu();
    c->noff -= 1;
    if (c->noff == 0 && c->intena)
        intr_on();           // restore only at the outermost release
}
```

Note that `mycpu()` finds **this core's** counter via `cpus[r_tp()]`, and that it depends entirely on `r_tp()` (= hartid) — if `r_tp()` is wrong in §4, this counter ends up touching some other core's entirely.

## 3. The multicore scheduler — the lock baton

This is the real heart of the post.
Spinlocks let us protect *"data structures sitting still,"* but the hardest moment is **the instant a process is context-switched.**

### The real problem the context-switch race has to solve

> The scheduler picks process P and runs it; later, when P yields, control returns to the scheduler. In the middle of this "pick and enter, yield and leave" transition, what happens if **another core grabs the same P**?

Picture this race.
Core A's process P is yielding — marking itself RUNNABLE and **on its way out of P's stack into the scheduler stack.**
At that very instant core B's scheduler, scanning the proctable, goes *"oh, P is RUNNABLE,"* claims P as RUNNING, and **`swtch`es into P's context.**

Now **two cores use the same P's same kernel stack** at once.
A is still on the way out of that stack and B is on the way in, so P's stack is destroyed.
A spinlock alone can't stop this — the transition isn't *"briefly touch a data structure,"* it's *"swap out the whole stack and PC,"* so the critical section straddles both sides of `swtch`.

### Background — direct thread-to-thread vs going through the scheduler

> When P yields, can't it `swtch` **straight** to the next process Q? Why go through the scheduler every single time?

| Aspect | Direct thread-to-thread | Through the scheduler (this kernel) |
|--------|------------------------|-------------------------------------|
| transition path | P → Q direct swtch | P → scheduler → Q |
| "what runs next" decision | P has to pick itself | one place (the scheduler) decides |
| multicore safety | another race while P picks Q | lock controlled at one point (scheduler) |
| handing off the lock | the pairing is irregular, hard | both sides of swtch are always scheduler ↔ proc |

This kernel **always goes through the scheduler** (like xv6).
P doesn't pick the next process; it unconditionally returns to the scheduler context (`cpu_sched[id]`), and the scheduler picks next.
Then one end of every transition is **always the scheduler**, so the lock only ever passes between a "scheduler ↔ proc" pair, which keeps the rule simple.

### The fix — hold the lock across swtch (a baton)

The core idea is this — **hold `pt_lock` (the proctable lock) across the context switch and hand it over.**

Like **passing a baton**, the lock crosses to both sides of the switch.

- The scheduler **grabs** `pt_lock`, claims P as RUNNING, and `swtch`es into P **while holding the lock.**
- P **releases** that lock (at its first-run point or at a yield point).
- When P yields again it **grabs** the lock and `swtch`es back to the scheduler, and the scheduler **releases** it.

During this baton, `pt_lock` is never free for a moment, so **no other core can ever pick up P.** P hides behind the lock until it has fully finished the transition.

```c
// proc.c — scheduler: grab pt_lock, claim a RUNNABLE proc, swtch while holding it
void scheduler(void) {
    int id = r_tp();
    cpu_proc[id] = 0;
    for (;;) {
        intr_on();   // so this core can receive interrupts/wakeups
        acquire(&pt_lock);
        for (int i = 0; i < NPROC; i++) {
            struct proc *p = &proctable[i];
            if (p->state == RUNNABLE) {
                p->state = RUNNING;
                cpu_proc[id] = p;
                switch_satp(p->pagetable);
                swtch(&cpu_sched[id], &p->context);  // enter holding pt_lock (proc releases it)
                switch_satp(kernel_pt());
                cpu_proc[id] = 0;                    // back here, we hold pt_lock again
            }
        }
        release(&pt_lock);
    }
}
```

The other side (the proc side), `yield`, is the mirror image — it **grabs** the lock and `swtch`es out, and releases the lock the scheduler held when it next gets scheduled.

```c
// proc.c — the current proc yields the CPU to the scheduler. swtch holding pt_lock.
void yield(void) {
    int id = r_tp();
    struct proc *p = cpu_proc[id];
    if (!p) return;
    acquire(&pt_lock);
    if (p->state == RUNNING)
        p->state = RUNNABLE;
    swtch(&p->context, &cpu_sched[id]);  // to the scheduler holding pt_lock (it releases)
    release(&pt_lock);                   // when scheduled again, release here
}
```

### First run isn't a yield point — entry functions release the lock

There's a catch here.
A process that has already run once stopped inside `yield`'s `swtch` and wakes there, so the `release(&pt_lock)` right after waking takes the baton and frees it.
But a **freshly created process running for the first time** starts not at a yield point but at the **very start of an entry function.** So those entry functions must release the lock the scheduler handed them, or the baton breaks.

This kernel has three entry functions, and all three begin with `release(&pt_lock)`.

```c
// proc.c — a user process running for the first time: enter U-mode from S-mode
static void enter_user(void) {
    release(&pt_lock);   // release the lock the scheduler held (first run)
    uint64 s = r_sstatus();
    s &= ~SSTATUS_SPP;   // SPP=0 → sret into U-mode
    s |= SSTATUS_SPIE;   // enable interrupts in U-mode (preemptible)
    s |= SSTATUS_SUM;
    w_sstatus(s);
    w_sepc(USERVA);
    asm volatile("mv sp, %0\n sret\n" :: "r"((uint64)USERSTACKTOP));
}

// a forked child's first run: release the lock and return to the trap frame the parent set up
void forkret(void) {
    release(&pt_lock);
    struct proc *p = cpu_proc[r_tp()];
    trapret_from(p->tf_va);
}

// a kernel thread's first run: release the lock and call the body
static void thread_start(void) {
    release(&pt_lock);
    intr_on();
    current_proc()->fn();
    proc_exit();
    for (;;) ;
}
```

We set a new process's `context.ra` to one of these (e.g. `p->context.ra = (uint64)enter_user`), so the first `swtch` jumps straight into the entry function, and its first line takes the baton and frees the lock.

### sleep/wakeup ride the same lock — preventing lost wakeups

`pt_lock` doesn't just guard scheduling. `sleep`/`wakeup` ride on this same lock.
Why does that matter? Because it prevents the classic race of a **lost wakeup.**

Consider `read()` waiting for console input.

```
1. "is the input buffer empty?" check — yes, empty
2. sleep(buffer)  — go to sleep
```

If another core's UART interrupt slips in between (1) and (2), fills a character, and calls `wakeup(buffer)`?
We aren't asleep yet, so that wakeup **lands on no one and vanishes into thin air**, and right after, at (2), we go to sleep and **never wake up.**

The fix is *"bind the check and the sleep atomically under the same lock."*
The caller enters `sleep` **already holding** `pt_lock`, and `sleep` `swtch`es while holding it. Since `wakeup` must also hold the same lock, no wakeup can slip into the check-to-sleep window.

```c
// proc.c — sleep on chan. The caller enters holding pt_lock (check↔sleep atomicity).
void sleep(void *chan) {
    int id = r_tp();
    struct proc *p = cpu_proc[id];
    if (!p) return;
    p->chan = chan;
    p->state = SLEEPING;
    swtch(&p->context, &cpu_sched[id]);  // pt_lock held → to scheduler (it releases)
    p->chan = 0;                         // on wakeup (pt_lock held) resume here
}

// wake every process sleeping on chan. The caller must hold pt_lock.
void wakeup(void *chan) {
    for (int i = 0; i < NPROC; i++) {
        struct proc *p = &proctable[i];
        if (p->state == SLEEPING && p->chan == chan)
            p->state = RUNNABLE;
    }
}
```

`proc_wait` is a good example — it grabs `pt_lock` once, checks *"is there a terminated child?"* under that lock, and if not, `sleep(p)`s while still holding the same lock. Since the child's `proc_exit` calls `wakeup(parent)` under the same lock too, there's no window to drop the wakeup.

> **Key takeaway**: the correctness of the multicore scheduler hinges on a single invariant — *"one `pt_lock` is handed across the context switch without ever breaking."* Scheduler grabs → proc releases → proc grabs → scheduler releases. Break this baton even once and two cores step on the same proc.

## 4. The nastiest bug — the vanished core id

### Symptom — intermittent crashes

The moment I added the secondary cores to the scheduler, running `hello` crashed **intermittently.**
Some runs were fine, some died — the classic race symptom.
Following the fault log led to a single line in `proc_fork`.

```
[trap] EXCEPTION  scause=0xd  sepc=0x80201e10  stval=0x00000000000000a8
```

`scause=0xd` is a **load page fault**, and `stval=0xa8` (168) is the faulting address.
It died reading byte 168 of a near-null pointer.
Disassembling showed `current_proc()` returning **null.**

### Cause — tp is not just hartid

Looking at `current_proc()` reveals the cause.

```c
// proc.c
static struct proc *cpu_proc[NCPU];   // current proc per core
struct proc *current_proc(void) { return cpu_proc[r_tp()]; }
```

It indexes by `r_tp()` (= hartid) to fetch *"the proc this core is running."*
But if `r_tp()` returns garbage, `cpu_proc[garbage index]` comes out 0 (null), and reading byte 168 of that null (some field of `struct proc`) faults.

The cause was very subtle.

> **Common misconception fix**: the trap was believing *"the `tp` register is just hartid."* By ABI, `tp` is the **user program's thread pointer**, a register the user can clobber for its own use at any time. The fact that we stashed hartid there gives no guarantee the user leaves it alone.

At boot, `entry.S` loads hartid into `tp` (`mv tp, a0`).
But a user program running in U-mode overwrites `tp` with its own thread pointer.
When a trap (timer/syscall) fires in that state, we enter the kernel — and **while kernel code runs, `tp` still holds the value the user wrote.**
So `r_tp()` returns the user's garbage instead of hartid → `cpu_proc[garbage]` → null → crash.

### Why it never blew up on a single core

This bug never fired once through Part 4.
On a single core the boot hart happened to be 0 and the user program's initial `tp` also happened to be 0 (nothing in the ABI guarantees that), so **even after the user clobbered it, `r_tp()` was 0** → `cpu_proc[0]` was the right answer, *by luck.*

On multicore, processes run on cores 1 and 2.
The moment the user `tp` (0) diverged from the real core id (1, 2), `cpu_proc[0]` was no longer *that core's* current proc but a wrong slot, and it surfaced immediately.
"A value that happened to be right on a single core reveals the truth on multicore" — the archetype of a multicore bug.

### The fix — restore tp from sscratch

The fix is the same as xv6's.
We must keep the **true source** of hartid somewhere the user can't touch. That's `sscratch` (the S-mode scratch CSR) we set aside in §1 — U-mode can't even access it, so the user can't clobber it. (A CSR **can't be read or written from a different privilege level** — `sscratch` belongs to S-mode, so U-mode has no way to touch it.)

We stamp hartid into `sscratch` at boot (§1's `csrw sscratch, a0`), and **restore `tp` from there the instant we enter a trap.**

```asm
# entry.S — at boot, per core (the line we saw in §1)
csrw    sscratch, a0       # sscratch = hartid (the user can't touch an S-mode CSR)

# kernelvec.S — on trap entry, right after saving registers
csrr    tp, sscratch       # restore tp = hartid (even if the user clobbered tp)
```

`kernelvec` first saves the trapped code's `tp` into the stack frame (`sd tp, 16(sp)`), then immediately does `csrr tp, sscratch` to **reset the `tp` the kernel will use back to hartid.**
That way the subsequent `kerneltrap` → `current_proc()` → `mycpu()` all see the correct core id.
On return, `trapret` restores the user's `tp` saved in the frame (`ld tp, 16(sp)`), so the user gets back exactly the value it wrote.

These two lines made the crash vanish cleanly.
*"Who owns the meaning of a single register"* — it was a clash over the same register between the user ABI's `tp` and the kernel's hartid, and the answer was drawing that boundary clearly at trap entry/exit.

## 5. Locking the remaining shared resources

Once the scheduler was stable and `tp` was fixed, I locked the remaining shared resources one by one.
The principle is single — ask *"what if two cores step on this line at once?"* at every shared point.

- **Page allocator** (`kalloc`/`kfree`) — to stop the very free-list race from the top of §2, it's protected by a dedicated `kmem_lock`. Even with several cores popping and returning pages at once, the same page never goes out twice.
- **Console buffer** — the input buffer and `sleep`/`wakeup` are protected together by the scheduler lock (`pt_lock`). Preventing §3's lost wakeup is the point.
- **UART output** — without a lock, two cores' output **interleaves character by character** (one core printing *"[ok] hart ..."* while another cuts in). A `pr_lock` serializes per message so a whole line goes out intact.

### Lock ordering — the rule that prevents deadlock

Here **lock ordering** becomes important.
When grabbing two locks nested, if core A takes them `pt_lock → uart_lock` while core B takes them `uart_lock → pt_lock`, A holds uart and B holds pt, each waiting on the other — a **deadlock.**

The rule is simple — **every core always grabs locks in the same order.**
There may be a path that holds `pt_lock` and then grabs `uart_lock`, but never the reverse.
Keeping the UART lock as the **innermost leaf** — a position where it grabs no further lock — keeps that rule naturally.

## Wrap-up

This post grew a single-core kernel into an **SMP kernel running on 3 cores together.**
Five pieces stack in one direction.

- **Multicore boot** — one boot hart finishes all init, then wakes the rest via SBI HSM `hart_start` and pushes them straight into the scheduler. Since the boot hart number is nondeterministic, an **atomic flag (`boot_taken`) makes the first arrival** the boot hart.
- **Spinlocks** — `amoswap` (`__sync_lock_test_and_set`) lets one core into the critical section, and the `__sync_synchronize` barrier guarantees visibility. While holding a lock, `push_off`/`pop_off` disable interrupts with a **nesting count** (preventing a deadlock against yourself).
- **The multicore scheduler (lock baton)** — hold `pt_lock` **across the context switch** and hand it over, so no other core can grab the same proc in the transitional instant. First runs have `enter_user`/`forkret`/`thread_start` release the lock, and `sleep`/`wakeup` use the same lock to prevent lost wakeups.
- **The `tp`/`sscratch` bug** — an intermittent crash where the user clobbered `tp` and `r_tp()` went wrong, fixed by keeping hartid in `sscratch` and **restoring it with `csrr tp, sscratch` on trap entry.** A bug that never fired on a single core because 0 happened to be right.
- **The remaining shared resources** — locked the page allocator, console, and UART, and prevented deadlock with **lock ordering** (UART as the leaf).

Now booting with `-smp 3` runs **3 cores pulling processes from a shared proctable and running them at once.**

```
[ok] boot hart 0 up; waking other cores + starting shell
kernel-hobby userspace shell. try: ls, cat motd.txt, hello
$ [ok] hart 2 online -> joining scheduler
[ok] hart 1 online -> joining scheduler
$ hello
  [hello] I am a separate program, exec'd from disk!
```

The shell, fork, exec, and cat all run distributed across cores without crashing.

Looking back, multicore was **less about new features and more a fight for "correctness."**
Leaving the single-core code almost untouched, I had to ask *"what if two cores step on this line at once?"* at every shared point.
The lock baton, the `tp` restore, the lock ordering — all of them were answers to that question.

A note on what's left.
The filesystem (virtio + buffer) still has no lock, because a single-user shell never triggers concurrent access (in general it would need one).
User threads (uthread) are on hold due to our single-page program model, and the network stack is a separate big journey.

What we've built is a **small Unix-like kernel** with boot, user-program execution, system calls, virtual memory, preemptive scheduling, and now SMP. There's still road ahead — a richer filesystem, networking — but **the core skeleton of an operating system is now almost entirely hand-built.** From boot to multicore, this hands-on journey of understanding "how an OS actually runs" reaches a milestone here.

> Code: [github.com/dj258255/kernel-hobby](https://github.com/dj258255/kernel-hobby)

## References (Primary Sources First)

- [RISC-V Privileged Specification](https://riscv.org/technical/specifications/) — the primary definition of `sscratch`/`stvec`/`scause`, `amoswap` (the A extension), the meaning of `tp`, and S-mode CSRs
- [RISC-V SBI Specification — HSM extension](https://github.com/riscv-non-isa/riscv-sbi-doc) — the standard `hart_start` call (EID 0x48534D, FID 0) that wakes secondary harts
- [xv6: a simple, Unix-like teaching operating system (MIT 6.S081)](https://pdos.csail.mit.edu/6.828/2023/xv6.html) — spinlocks, `push_off`/`pop_off`, the lock-baton scheduler, and the `sscratch` tp restore map 1:1
- [OpenSBI Documentation](https://github.com/riscv-software-src/opensbi) — why boot-hart selection is nondeterministic, the M-mode → S-mode handoff
- Related: [Semaphores and Mutexes](/blog/theory/semaphore-mutex-sync)

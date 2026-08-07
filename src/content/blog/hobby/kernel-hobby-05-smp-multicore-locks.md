---
title: '멀티코어로 가다: SMP와 락'
description: 단일 코어 커널을 여러 코어가 함께 도는 SMP 커널로 키운다. SBI HSM으로 보조 코어를 깨워 부팅하고, 스핀락으로 공유 자료구조를 보호하고, 컨텍스트 스위치를 가로지르며 락을 넘기는 baton 방식으로 멀티코어 스케줄러를 만든다. 그 과정에서 만난 가장 고약한 버그, 곧 유저가 tp 레지스터를 덮어 코어 번호가 틀어지던 문제와 그 해결까지 다룬다.
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

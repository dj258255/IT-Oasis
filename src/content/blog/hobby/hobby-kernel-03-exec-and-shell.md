---
title: 'exec와 유저공간 셸'
titleEn: 'exec and a Userspace Shell'
description: 작은 유닉스의 마지막 조각. 실행 중인 프로세스를 디스크의 다른 프로그램으로 바꾸는 런타임 exec(), 그리고 sleep/wakeup·read·wait로 커널 밖에서 도는 유저공간 셸까지. 셸이 fork+exec로 디스크 프로그램을 띄우는 유닉스의 핵심 루프를 완성한다.
descriptionEn: "The last piece of a small Unix — a runtime exec() that swaps a running process for another program from disk, and a userspace shell built on sleep/wakeup, read, and wait. Completing the Unix core loop where a shell launches disk programs via fork+exec."
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
seriesOrder: 4
---


## 0. 들어가며

[3편](/blog/hobby/hobby-kernel-02-fork-elf-filesystem)에서 fork, ELF 로더, 파일시스템까지 왔어요.
이제 마지막 조각 두 개로 "작은 유닉스"를 완성합니다.

1. **런타임 exec()** — 실행 중인 프로세스를 디스크의 다른 프로그램으로 교체
2. **유저공간 셸** — 커널 밖에서 도는 셸이 명령을 받아 프로그램을 실행

이 둘이 합쳐지면 **유닉스가 모든 명령을 실행하는 방식** — 셸이 `fork`하고, 자식이 `exec`로 프로그램이 되고, 부모가 `wait`로 기다리는 — 그 핵심 루프가 돼요.
이 글은 그 루프를 세 가지 어려운 문제로 쪼개서, 우리 커널이 실제 코드에서 각각을 어떻게 푸는지 봅니다.

- **exec** — "달리는 차의 엔진 갈기" 문제: 자기가 올라타 있는 주소공간을 자기 손으로 갈아엎기
- **블로킹 read** — "바쁜 대기 없이 입력 기다리기" 문제: sleep/wakeup과 잃어버린 wakeup
- **wait/exit** — "자기 시신을 자기가 못 치우는" 문제: 좀비와 부모의 자원 회수

## 1. exec가 풀어야 하는 진짜 문제

> 실행 중인 프로세스를, 그 프로세스를 죽이지 않고, 디스크의 다른 프로그램으로 통째로 바꿔치기하라.

지금까지 유저 프로그램은 부팅 때 딱 한 번, `make_user_proc`이 커널에 임베드된 ELF를 코드 페이지에 적재하면서 만들어졌어요.
그런데 셸이 `hello`를 치면 어떻게 될까요?
셸은 자기 자신이지, hello가 아니에요.
누군가는 **이미 돌고 있는 프로세스를 디스크의 다른 프로그램으로 바꿔치기**해야 하고, 그게 `exec()`입니다.

유닉스의 관용구는 `fork` + `exec`예요.
셸이 `fork`로 자기 복제본(자식)을 하나 만들고, 그 자식이 `exec("hello")`로 **내용물만 hello로 갈아끼웁니다**.
부모(셸)는 그대로 살아서 자식이 끝나길 기다려요.
"왜 fork부터 하지?" 싶지만, 이래야 셸 자신은 사라지지 않으면서 새 프로그램을 띄울 수 있어요.

진짜 까다로움은 다른 데 있어요.
exec는 "달리는 차의 엔진을 바꾸는 것"입니다.
프로세스가 자기 주소공간을 헐고 새 프로그램을 올리는데, **그 작업을 하는 코드 자체가 바로 그 주소공간 위에서 돌고 있거든요**.
특히 위험한 건 **유저 스택**이에요.
`proc_exec` 함수의 지역변수(`newcode`, `entry`, `oldcode` …)는 스택에 사는데, 주소공간을 통째로 갈아엎다가 스택까지 날려버리면 자기 발밑이 꺼지는 셈입니다.

### 사전 지식 — exec가 건드려야 하는 것 세 가지

exec 한 번에 바뀌어야 하는 상태를 분리해서 보면 설계 선택지가 또렷해져요.

#### 코드 페이지

> 새 프로그램의 명령어는 어디에 올리고, 옛 코드 페이지는 누가 회수하는가?

새 ELF를 디스크에서 읽어 새 물리 페이지(`newcode`)에 적재해요.
옛 코드 페이지(`oldcode`)는 더 이상 쓰이지 않으니 `kfree`로 돌려줘야 누수가 안 납니다 — 단, **회수 시점**이 함정인데 뒤에서 다뤄요.

#### 스택

> 유저 스택을 통째로 갈아엎을 것인가, 재사용할 것인가?

갈아엎으면 "깨끗한 새 프로그램"이라는 의미엔 충실하지만, exec를 수행 중인 `proc_exec`의 지역변수가 죽어요.
우리 커널은 **스택 페이지를 재사용**하되 `sp`만 top으로 리셋해요 — 옛 스택 내용을 지우는 게 아니라, `sp`를 맨 위로 되돌려 새 스택처럼 쓰는 거죠(그 아래에 남은 옛 데이터는 새 프로그램이 건드리지 않습니다).

#### 주소공간(satp)

> 페이지 테이블을 통째로 새로 만들 것인가, 기존 것을 유지하고 일부만 remap할 것인가?

`satp`를 바꾸는 순간 유저 스택 자체가 다른 물리 페이지로 바뀝니다.
우리 커널은 **satp를 유지**하고 코드 페이지만 remap하는 더 가벼운 길을 택했어요.

### 경우 2가지 — satp 교체 vs 코드 페이지만 remap

같은 exec를 두 가지로 구현할 수 있고, 우리는 후자를 택했습니다.

| 구분 | fork 후 주소공간 통째 교체(정통) | 코드 페이지만 remap (우리) |
|------|-------------------------------|--------------------------|
| 페이지 테이블 | 새로 만들고 satp 교체 | 기존 것 유지 |
| 유저 스택 | 새 스택 페이지 | 기존 스택 재사용(`sp`만 리셋) |
| 유저 진입 방식 | `userret_to(entry, sp, satp)` — 레지스터만 | 인라인 `mv sp; sret` |
| 전환 후 스택 접근 | **절대 금지**(다른 물리 페이지) | 자유(같은 주소공간) |
| 비용 | 페이지 테이블 빌드 + `sfence.vma` | remap 1회 + `sfence.vma` (페이지 테이블 빌드 없음) |
| 격리 수준 | 옛 매핑이 한 톨도 안 남음 | 코드만 갈리고 나머지 매핑 유지 |

정통 경로가 더 깨끗하지만(옛 프로그램의 매핑이 완전히 사라짐), 우리 목적엔 코드 페이지 remap만으로 충분하고 훨씬 가벼워요.

> 한 가지 주의: remap도 **PTE를 바꾸는 것**이라, satp가 그대로여도 옛 번역이 TLB에 남을 수 있어 `sfence.vma`로 비워야 해요(실제 `remap_user_code`가 그렇게 합니다). 가벼운 건 "TLB flush가 없어서"가 아니라 **페이지 테이블을 새로 짓지 않아서**예요.

### 우리 코드 — proc_exec()

실제 `proc_exec`은 한 줄 요약보다 일을 꼼꼼히 합니다.
새 코드를 올리기 **전에**, 옛 프로그램이 쓰던 힙과 mmap 영역부터 회수해요(안 그러면 페이지가 샙니다).

```c
// proc.c — proc_exec()  (실제 코드에서 발췌)
int sz = fs_read(path, elfbuf, sizeof(elfbuf));   // 디스크에서 ELF 읽기
if (sz < 0) return -1;                            // 그런 파일 없음 → 실패

char *newcode = kalloc();
zero(newcode, PGSIZE);                            // .bss 대비 미리 0
uint64 entry;
if (load_elf((const char *)elfbuf, newcode, &entry) != 0) {
    kfree(newcode);
    return -1;                                    // ELF 깨짐 → 실패(셸은 살아 있음)
}

struct proc *p = current_proc();
char *oldcode = p->ucode;
vm_free_range(p->pagetable, HEAPBASE, p->heap_top);  // 옛 프로그램 힙 회수
p->heap_top = HEAPBASE;                          // 새 프로그램은 빈 힙
if (p->mmap_base) {                              // 옛 mmap 영역도 같은 식으로 회수
    uint64 mend = p->mmap_base + ((p->mmap_size + PGSIZE - 1) & ~(uint64)(PGSIZE - 1));
    vm_free_range(p->pagetable, p->mmap_base, mend);
    p->mmap_base = 0;
}

remap_user_code(p->pagetable, (uint64)newcode);  // USERVA → 새 코드로 갈아끼움
p->ucode = newcode;
if (oldcode) kfree(oldcode);                      // 옛 코드 페이지 회수(누수 없음)

// U-mode로 진입. satp(주소공간)는 그대로라 스택이 안 바뀐다 → 스택 재사용.
uint64 s = r_sstatus();
s &= ~SSTATUS_SPP;   // sret 시 U-mode로
s |= SSTATUS_SPIE;   // U-mode에서 인터럽트 enable(선점 가능)
s |= SSTATUS_SUM;    // 트랩 시 커널이 유저 스택에 프레임 저장 가능
w_sstatus(s);
w_sepc(entry);       // 새 프로그램의 진입점
asm volatile("mv sp, %0\n sret\n" :: "r"((uint64)USERSTACKTOP));  // 스택 top + sret
return -1;           // 여기 도달하면 버그(sret이 돌아오지 않으므로)
```

마지막 두 줄이 핵심이에요.
`mv sp, USERSTACKTOP`으로 스택 포인터를 top으로 리셋하고, 곧장 `sret`으로 U-mode로 떨어집니다.
`sepc`에 새 프로그램의 `entry`를 미리 넣어뒀으니, `sret` 직후 CPU는 hello의 첫 명령부터 실행해요.
`exec`가 성공하면 **이 함수는 영영 돌아오지 않습니다** — 호출자였던 자식 프로세스가 이미 hello가 돼버렸으니까요.

### satp까지 바꾸는 정통 경로 — userret_to

위 표의 왼쪽(정통 경로)도 kernelvec.S에 준비해 뒀어요.
satp까지 바꿔야 한다면 `mv sp; sret` 인라인으론 부족합니다.
satp를 바꾸는 순간 유저 스택 자체가 다른 물리 페이지로 바뀌어서, 그 뒤로는 스택을 **단 한 번도** 건드리면 안 되거든요.
그래서 어셈블리 헬퍼 `userret_to(entry, sp, satp)`는 satp 전환 → `sfence.vma`(TLB 비우기) → `sepc`/`sp` 세팅 → `sret`까지 **전부 레지스터만으로** 합니다.
전환 후엔 메모리(스택)를 안 만지고 곧장 유저로 떨어지죠.

```asm
# kernelvec.S — userret_to(entry, sp, satp) [a0, a1, a2]
# satp를 바꾸면 유저 스택이 통째로 바뀌므로, 전환 후엔 스택을 절대 건드리지
# 않고 레지스터만으로 sret한다. (sstatus는 호출 전에 C에서 미리 세팅)
userret_to:
        csrw    satp, a2          # 주소공간 전환
        sfence.vma zero, zero     # 옛 번역(TLB) 비우기
        csrw    sepc, a0          # 새 진입점
        mv      sp, a1            # 새 스택 top
        sret                      # U-mode로 (돌아오지 않음)
```

### 함정 — exec 실패는 죽으면 안 된다

exec에서 제일 흔한 함정은 "실패했을 때"예요.
없는 파일을 치거나(`fs_read`가 -1) ELF가 깨졌으면, exec는 **현재 프로세스를 망가뜨리지 않고** 그냥 `-1`을 반환해야 합니다.
그래서 실제 코드는 옛 코드 페이지를 `kfree`하기 **전에** `load_elf`까지 다 성공시켜 놓아요.
중간에 실패하면 새로 잡은 `newcode`만 버리고 옛 상태 그대로 돌아갑니다.
이게 셸에서 오타를 쳐도 셸이 안 죽고 `command not found`만 뜨는 비결이에요(셸의 fork된 자식이 exec에 실패하면, 자식이 그 메시지를 찍고 `exit`).

> **흔한 오해 정정**: *"먼저 옛것을 다 지우고 새것을 올리면 깔끔하다"* — 아니에요. 옛 코드를 먼저 `kfree`해 버리면 `load_elf`가 실패했을 때 돌아갈 곳이 없어요. **새 상태를 끝까지 성공시킨 뒤에야 옛 자원을 회수**하는 순서가 실패 안전성의 핵심입니다. 우리 코드가 `kfree(oldcode)`를 `remap_user_code` *뒤*에 두는 게 바로 이 이유예요.

> 실패해도 프로세스가 멀쩡히 살아남는 exec — 이게 셸이 영원히 도는 비결입니다.

## 2. 블로킹 read가 풀어야 하는 진짜 문제

> 입력이 아직 없을 때, CPU를 태우지 않고 기다리다가, 글자가 들어오는 *바로 그 순간* 깨어나라.

지금까지 셸은 커널 안(S-mode)에 있었어요(1편의 `hobby>` 셸).
진짜 유닉스에선 셸도 그냥 **유저 프로그램** 하나예요.
셸을 커널 밖으로 내리려면, 셸이 `read()`로 키보드 입력을 기다릴 수 있어야 합니다.
그런데 사용자가 아직 아무것도 안 쳤으면?

### 경우 2가지 — 바쁜 대기 vs sleep/wakeup

| 구분 | 바쁜 대기(busy-wait) | sleep/wakeup (우리) |
|------|--------------------|--------------------|
| 입력 없을 때 | `while (입력 없음) ;` 빙빙 | CPU 양보 후 SLEEPING |
| CPU 점유 | 100%, 무의미하게 태움 | 0%, 다른 프로세스가 씀 |
| CPU 사용 | 100% 태우며 헛돌아 전력·효율 낭비 | wfi로 쉬다 인터럽트로 깨어남 |
| 깨어나는 방식 | (애초에 못 깨어남) | 채널 매칭으로 정확히 깨움 |
| 위험 | 데드락성 기아 | 잃어버린 wakeup(아래에서 해결) |

바쁜 대기는 비효율적이에요 — 셸이 CPU를 100% 잡고 빙빙 돌며 아무 유용한 일도 못 한 채 전력만 태웁니다. (우리 커널은 선점형이라 타이머 인터럽트가 끼어들어 핸들러·다른 프로세스가 굶지는 않아요 — 문제는 입력이 올 때까지 CPU를 통째로 낭비한다는 점이에요.)
올바른 답은 **블록(block)**: 입력이 없으면 CPU를 양보하고 잠들었다가, 글자가 들어오면 깨어나는 거예요.

### 사전 지식 — 채널

> 잠든 쪽과 깨우는 쪽이 어떻게 "같은 이벤트"를 약속하는가?

이 "잠들기 / 깨우기"가 **sleep / wakeup**입니다.
핵심 아이디어는 **채널(channel)** — 그냥 아무 포인터값이에요.
잠드는 쪽과 깨우는 쪽이 **같은 주소**를 약속어로 쓰면, 그 주소로 자는 애들만 골라 깨울 수 있어요.
여기선 입력 버퍼 주소 `&inbuf`를 채널로 씁니다.

```c
// proc.c — 실제 코드
void sleep(void *chan) {
    struct proc *p = cpu_proc[r_tp()];
    p->chan = chan;                      // 이 채널에서 잔다고 표시
    p->state = SLEEPING;
    swtch(&p->context, &cpu_sched[id]);  // pt_lock 든 채로 스케줄러에 넘김
    p->chan = 0;                         // 깨어나면(pt_lock 다시 든 채) 여기서 재개
}
void wakeup(void *chan) {
    for (int i = 0; i < NPROC; i++) {
        struct proc *p = &proctable[i];
        if (p->state == SLEEPING && p->chan == chan)
            p->state = RUNNABLE;         // 같은 채널에서 자는 애를 깨운다
    }
}
```

`read()`(`console_read`)는 입력 버퍼가 비었으면(`in_r == in_w`) `sleep(&inbuf)`로 잠들어요.
한편 UART 인터럽트(`console_intr`)는 글자를 버퍼에 쌓고 화면에 에코하다가, 한 줄이 완성되면(`\n`) `wakeup(&inbuf)`로 잠든 read를 깨웁니다.

```c
// console.c — 실제 코드(요지)
int console_read(char *dst, int n) {
    int i = 0;
    acquire(&pt_lock);                  // (A) 락을 먼저 잡는다
    while (i < n) {
        while (in_r == in_w)
            sleep(&inbuf);              // (B) 입력 없으면 잠든다(락 든 채)
        char c = inbuf[in_r % INBUF];
        in_r++;
        dst[i++] = c;
        if (c == '\n') break;           // 줄 끝
    }
    release(&pt_lock);
    return i;
}
```

```c
// console.c — 인터럽트 쪽
void console_intr(char c) {
    if (c == '\r') c = '\n';
    acquire(&pt_lock);                  // read와 같은 락
    // (DEL/Backspace, 버퍼 가득 처리는 생략)
    inbuf[in_w % INBUF] = c;
    in_w++;
    uart_putc(c);                       // 입력 에코
    if (c == '\n')
        wakeup(&inbuf);                 // 줄 완성 → read를 깨움
    release(&pt_lock);
}
```

### 함정 — 잃어버린 wakeup(lost wakeup)

여기에 운영체제 교과서가 꼭 짚는 고전적인 함정이 있어요.
`read`가 "버퍼가 비었나?"를 검사하고(`in_r == in_w`) 잠들기로(`sleep`) 마음먹은 **그 찰나에**, 마침 인터럽트가 끼어들어 글자를 넣고 `wakeup`을 쏘면 어떻게 될까요?
read는 "비었네" → (인터럽트가 글자 넣고 wakeup) → `sleep`(잠듦) 순서가 되고, **이미 지나간 wakeup을 놓쳐서 영영 못 깨어납니다**.
이게 **잃어버린 wakeup**이에요.

핵심은 "검사 → sleep"을 **원자적으로** 묶어서, 그 사이에 wakeup이 끼어들 틈을 없애는 거예요.
우리 코드의 방식은 **스핀락 `pt_lock`** 입니다.
`console_read`는 (A)에서 락을 먼저 잡고, 그 락을 **든 채로** 검사하고 `sleep`까지 들어가요.
그런데 깨우는 쪽 `console_intr`도 같은 `pt_lock`을 잡아야 버퍼에 글자를 넣고 `wakeup`을 쏠 수 있습니다.
그러니 read가 락을 들고 있는 동안엔 인터럽트 핸들러가 **버퍼를 만지지도, wakeup을 쏘지도 못해요** — 락 앞에서 기다려야 하죠.

마법은 `sleep` 안에 있어요.
`sleep`은 **락을 든 채로** `swtch`로 스케줄러에 넘어갑니다(위 `sleep` 코드를 보세요 — 락을 풀지 않아요).
프로세스가 SLEEPING으로 표시되고 CPU에서 내려간 **다음에야** 스케줄러 쪽에서 락이 풀려요.
즉 "잠들었다고 표시 + CPU 양보"가 끝나기 전엔 누구도 락을 못 잡으니, wakeup이 그 사이를 비집고 들어올 수 없습니다.
검사부터 실제로 잠드는 순간까지가 한 덩어리로 보호되는 거예요.

> **흔한 오해 정정**: *"트랩 중엔 인터럽트가 꺼져 있으니(SIE=0) 잃어버린 wakeup은 SIE만 끄면 막힌다"* — 단일 코어에선 그럴듯하지만 틀린 일반화예요. 우리 커널은 멀티코어를 염두에 둡니다 — **다른 코어**의 인터럽트가 동시에 `console_intr`을 돌릴 수 있죠. 그러니 자기 코어의 인터럽트를 끄는 것만으론 부족하고, **공유 데이터(`inbuf`, `in_w`, 프로세스 상태)를 스핀락으로 감싸 검사~sleep을 한 덩어리로 묶는 게** 진짜 방어선입니다. 이래서 `console_intr`도 굳이 `pt_lock`을 잡는 거예요.

셸이 잠들고 다른 돌릴 프로세스도 없으면, 스케줄러는 할 일이 없어요.
이때 스케줄러가 훑어 **RUNNABLE이 하나도 없을 때만** 코어가 `wfi`(wait-for-interrupt)로 전력을 아끼며 쉬다가, 콘솔/타이머 인터럽트가 들어오면 깨어나 다시 스캔합니다.
방금 그 콘솔 인터럽트가 `wakeup`으로 셸을 RUNNABLE로 만들어 놨으니, 스케줄러는 셸을 다시 골라 돌려요.

> 검사와 sleep을 같은 락 아래 묶는다 — 동기화의 절반은 "원자적으로 묶어야 할 두 동작이 무엇인가"를 찾는 일입니다.

## 3. wait/exit가 풀어야 하는 진짜 문제

> 끝난 자식의 자원을 누가, 언제 회수하는가? 자식은 **자기가 올라타 있는 커널 스택을 자기 손으로 반납할 수 없다.**

셸은 명령을 실행하면 그게 **끝날 때까지 기다려야** 해요.
안 그러면 hello의 출력과 다음 `$ ` 프롬프트가 뒤섞여서 엉망이 됩니다.
또 끝난 자식의 자원(유저 페이지, 페이지 테이블, 커널 스택…)을 **누군가는 회수**해야 하는데, 그걸 부모가 `wait`에서 해줘요.

### 사전 지식 — 좀비

> 죽은 자식이 곧장 사라지지 못하는 이유는?

자식이 `exit`할 때 자기 자원을 스스로 다 정리하긴 어려워요 — 예컨대 자기가 지금 쓰고 있는 커널 스택을 자기 손으로 반납할 순 없죠(반납하는 순간 발밑이 꺼집니다).
그래서 자식은 `exit` 시 곧장 사라지지 않고 **ZOMBIE** 상태로 잠깐 남아요.
"죽었다고 표시는 했지만 아직 시신은 안 치운" 상태죠.
그리고 부모를 `wakeup`으로 깨워 "나 끝났어, 와서 치워줘"라고 알립니다.
부모의 `wait`는 좀비가 된 자식을 발견하면 자원을 회수(reap)하고 그 자리를 `UNUSED`로 비운 뒤, 그 pid를 반환해요. (실제 유닉스의 `wait`는 자식의 **종료 코드**도 함께 회수하지만, 우리 구현은 pid만 돌려줍니다.)

```c
// proc.c — 실제 코드
void proc_exit(void) {
    struct proc *p = cpu_proc[r_tp()];
    acquire(&pt_lock);
    if (p->parent)
        wakeup(p->parent);              // wait 중인 부모를 깨운다(부모를 채널로)
    p->state = ZOMBIE;                  // 시신만 남기고
    swtch(&p->context, &cpu_sched[id]); // pt_lock 든 채로 스케줄러에. 안 돌아온다.
    for (;;) ;                          // (도달 불가)
}

int proc_wait(void) {
    struct proc *p = cpu_proc[r_tp()];
    acquire(&pt_lock);
    for (;;) {
        int kids = 0;
        for (int i = 0; i < NPROC; i++) {
            struct proc *q = &proctable[i];
            if (q->parent != p) continue;
            kids = 1;
            if (q->state == ZOMBIE) {       // 좀비 자식 발견
                int pid = q->pid;
                proc_freeimage(q);          // 유저 페이지+페이지테이블+스택 회수
                q->parent = 0;
                q->state = UNUSED;          // 슬롯을 비운다
                release(&pt_lock);
                return pid;
            }
        }
        if (!kids) { release(&pt_lock); return -1; }  // 자식이 없음
        sleep(p);                           // 자식이 깨울 때까지 잔다(자기를 채널로)
    }
}
```

### 채널 = 부모 proc

여기서 **채널이 `p`(부모 자신)** 라는 점에 주목하세요.
부모는 `sleep(p)`로 "나 자신"을 약속어 삼아 잠들고, 자식은 `proc_exit`에서 `wakeup(p->parent)` — 즉 부모를 채널로 깨웁니다.
같은 주소(부모 proc)를 약속어로 쓰니 정확히 그 부모만 깨어나죠.
2절에서 `&inbuf`를 채널로 썼던 것과 **똑같은 메커니즘**이에요 — 채널은 그냥 "약속한 주소"일 뿐이고, 입력 버퍼든 부모 구조체든 상관없습니다.
이것도 sleep/wakeup이 같은 `pt_lock` 아래서 돌기 때문에, "좀비 검사 → sleep" 사이에 자식의 exit가 끼어들어도 wakeup을 잃지 않아요(2절의 잃어버린 wakeup 방어가 그대로 재사용됩니다).

> **흔한 오해 정정**: *"exit하면 자식이 스스로 다 정리하면 되지 않나?"* — 안 됩니다. 자식은 지금 **자기 커널 스택 위에서 `proc_exit`을 실행 중**이라, 그 스택을 자기 손으로 `kfree`하면 즉시 발밑이 꺼져요. 그래서 자식은 ZOMBIE로 시신만 남기고, **부모의 `proc_freeimage`가** 커널 스택을 포함한 나머지를 회수합니다. "회수 주체"가 자식이 아니라 부모인 건 우연이 아니라 필연이에요.

자원 회수(`proc_freeimage`)는 실제로 유저 코드/스택 페이지, 지연 할당된 힙·mmap 페이지, 커널 스택, 그리고 페이지 테이블 트리까지 전부 `kfree`로 free list에 돌려줍니다.
이게 1편에서 만든 물리 페이지 할당기가 "받은 페이지를 다시 돌려받는" 마지막 고리예요.

## 4. 다 합치면 — 유저공간 셸

셸은 이제 평범한 C 프로그램이에요(`user/init.c`).
프롬프트를 찍고, 한 줄 읽고, 내장 명령(`ls`/`cat`/`help`/`rm`/`write`/`mem`)은 직접 처리하고, 그 외엔 **디스크 프로그램**으로 보고 `fork` → 자식이 `exec` → 부모가 `wait` 합니다.

```c
// user/init.c — 유저공간 셸(요지)
for (;;) {
    puts("$ ");
    long n = sys_read(line, sizeof(line) - 1);   // 블로킹 read(없으면 sleep)  ← §2
    if (n <= 0) continue;
    if (line[n - 1] == '\n') line[n - 1] = 0;    // 개행 제거

    if (streq(line, "ls"))  { sys_ls();  continue; }       // 내장 명령
    if (startswith(line, "cat ")) { sys_cat(line + 4); continue; }
    // ... help / rm / write / mem 등도 내장

    long pid = sys_fork();                        // 외부 명령
    if (pid == 0) {                               // 자식
        sys_exec(line);                           // 디스크 프로그램으로 변신  ← §1
        puts(line);
        puts(": command not found\n");            // exec 실패 시에만 여기 도달
        sys_exit();
    }
    sys_wait();                                   // 부모: 자식이 끝날 때까지 대기  ← §3
}
```

세 절이 한 루프에 모입니다.
`sys_read`는 §2의 블로킹 read, `sys_exec`는 §1의 주소공간 교체, `sys_wait`는 §3의 좀비 회수예요.

자식 분기를 잘 보세요.
`sys_exec(line)`이 성공하면 그 자식은 이미 다른 프로그램이 돼버려서 **다음 줄로 돌아오지 않습니다**.
`command not found`가 찍히는 건 오직 `exec`가 실패해서 돌아왔을 때뿐이에요.
이게 §1에서 본 "exec 실패는 프로세스를 죽이지 말고 -1을 반환한다"가 셸에서 어떻게 쓰이는지 보여줍니다.

부팅하면 커널이 이 셸을 첫 유저 프로세스로 띄워요.

```
hobby-kernel userspace shell. try: ls, cat motd.txt, hello
$ ls
  motd.txt  (162 bytes)
  readme.txt  (240 bytes)
  hello  (7352 bytes)
$ hello
  [hello] I am a separate program, exec'd from disk!
$ cat motd.txt
Welcome to hobby-kernel (C / RISC-V). ...
$ nope
nope: command not found
```

`hello`를 치면 — 셸이 fork하고, 자식이 디스크의 hello를 exec해서 그 프로그램이 되고, hello가 출력하고 exit하면, 셸의 wait가 돌아와 프롬프트를 다시 띄웁니다.
**유닉스가 명령을 실행하는 바로 그 메커니즘**이 동작해요.

이 한 장이면 fork → exec → wait의 흐름이 한눈에 들어와요.

![셸이 fork해 부모·자식으로 갈리고, 자식이 exec로 hello가 되어 실행 후 exit(ZOMBIE)하며 부모를 wakeup, 부모 wait가 자식 pid를 반환한 뒤 다음 프롬프트 출력](/uploads/hobby/hobby-kernel-c/fork-exec-wait.svg)

## 5. 정리

작은 유닉스의 마지막 루프는 결국 **세 가지 "자기 발밑" 문제**의 모음이었어요.

- **exec** — 자기가 올라타 있는 주소공간을 갈아엎는 문제. 우리는 satp를 유지하고 코드 페이지만 remap한 뒤 인라인 `mv sp; sret`으로 진입했고, 정통 satp 교체 경로는 `userret_to`가 레지스터만으로 처리해요. 실패 안전성의 핵심은 **새 상태를 끝까지 성공시킨 뒤에야 옛 코드를 `kfree`**하는 순서입니다.
- **블로킹 read** — 바쁜 대기 대신 sleep/wakeup. 잃어버린 wakeup은 SIE를 끄는 게 아니라 **스핀락 `pt_lock`으로 검사~sleep을 묶어** 막습니다(`sleep`은 락을 든 채 `swtch`).
- **wait/exit** — 자식은 자기 커널 스택을 자기 손으로 못 치우므로 ZOMBIE로 남고, 채널=부모 proc으로 부모를 깨워 **부모의 `proc_freeimage`가** 회수합니다.

세 문제 모두 sleep/wakeup·채널·스핀락이라는 같은 도구로 풀린다는 점, 그리고 "회수 주체와 회수 시점"을 잘못 잡으면 발밑이 꺼진다는 점이 핵심이에요.

부팅부터 여기까지, 운영체제의 골격이 다 섰습니다.

```
부팅 → 트랩/타이머 → 키보드 → 페이지 할당기 → 페이징(Sv39)
→ 유저모드+syscall → 프로세스+선점 스케줄러 → 유저 프로세스(격리)
→ fork → ELF 로더 → 파일시스템 → 런타임 exec → 유저공간 셸
```

- CPU — 트랩, 인터럽트, 선점형 스케줄링, sleep/wakeup
- 메모리 — Sv39 페이징, 프로세스별 주소공간 격리
- 프로세스 — fork, exec, wait, 생명주기
- 저장장치 — virtio-blk 디스크, 파일시스템
- 인터페이스 — 유저공간 셸이 디스크 프로그램을 fork+exec

"OS가 어떻게 도는가"를 책으로 읽는 것과, `volatile` 한 줄 때문에 한 시간을 헤매고 `SUM` 비트 하나에 막혀보는 건 전혀 다른 이해였어요.
바닥부터 C로 짜며 그걸 손으로 만진 게 이 프로젝트의 전부입니다.

남은 건 전부 정제 — 쓰기 가능한 파일시스템, inode, exit 시 완전한 자원 회수, 셸 파이프/리다이렉트.
새 핵심 기능이 아니라 다듬기예요.
4편에 걸친 연재는 여기서 매듭짓습니다.

> 코드: [github.com/dj258255/hobby-kernel](https://github.com/dj258255/hobby-kernel)

## 참고 (1차 자료 우선)

- [xv6 book — Chapter 1 (exec), Chapter 7 (Scheduling: sleep/wakeup, exit/wait)](https://pdos.csail.mit.edu/6.828/2023/xv6/book-riscv-rev3.pdf)
- [xv6 source — `exec.c`, `proc.c` (sleep/wakeup, wait/exit), `kernelvec.S`](https://github.com/mit-pdos/xv6-riscv)
- [The RISC-V Instruction Set Manual, Volume II: Privileged Architecture (satp, sstatus SPP/SPIE/SUM, sret, sfence.vma)](https://riscv.org/technical/specifications/)
- [xv6: a simple, Unix-like teaching operating system (MIT 6.S081)](https://pdos.csail.mit.edu/6.828/2023/xv6.html)

<!-- EN -->

## 0. Introduction

In [Part 3](/blog/hobby/hobby-kernel-02-fork-elf-filesystem) we got all the way to fork, an ELF loader, and a filesystem.
Now two final pieces complete our "small Unix."

1. **Runtime exec()** — replacing a running process with a different program from disk
2. **Userspace shell** — a shell running outside the kernel that takes commands and runs programs

Put together, these become **the way Unix runs every command** — the shell `fork`s, the child becomes a program via `exec`, and the parent waits with `wait`.
This post splits that loop into three hard problems and shows how our kernel solves each in real code.

- **exec** — the "swap an engine on a moving car" problem: tearing down the very address space you're standing on
- **blocking read** — the "wait for input without busy-waiting" problem: sleep/wakeup and the lost wakeup
- **wait/exit** — the "you can't clear your own corpse" problem: zombies and the parent's reclamation

## 1. The Real Problem exec Has to Solve

> Replace a running process with a different program from disk, **without killing it.**

Until now, user programs were created just once, at boot, when `make_user_proc` loaded a kernel-embedded ELF into a code page.
But what happens when the shell types `hello`?
The shell is itself, not hello.
Somebody has to **swap an already-running process for a different program from disk**, and that's `exec()`.

The Unix idiom is `fork` + `exec`.
The shell `fork`s a copy of itself (a child), and that child `exec("hello")`s to **swap only its contents** for hello.
The parent (the shell) stays alive and waits for the child to finish.
"Why fork first?" — because this is how the shell launches a new program without disappearing itself.

The real difficulty lies elsewhere.
exec is like "swapping the engine of a moving car."
A process tears down its own address space and loads a new program, while **the very code doing that runs on top of that same address space**.
The truly dangerous one is the **user stack**.
`proc_exec`'s locals (`newcode`, `entry`, `oldcode`, …) live on the stack, and if you blow away the whole address space and take the stack with it, the floor drops out from under you.

### Background — the three things exec must touch

Separating the state that one exec must change makes the design choices clear.

#### The code page

> Where do the new program's instructions go, and who reclaims the old code page?

We read the new ELF from disk and load it into a fresh physical page (`newcode`).
The old code page (`oldcode`) is no longer used, so it must go back via `kfree` to avoid a leak — but the **timing** of that reclaim is a trap, covered below.

#### The stack

> Replace the user stack wholesale, or reuse it?

Replacing it honors the "clean new program" semantics, but it kills the locals of `proc_exec`, which is mid-exec.
Our kernel **reuses the stack page** and merely resets `sp` to the top — it doesn't erase the old stack contents; it just rewinds `sp` to the top and uses it like a fresh stack (the leftover data below is never touched by the new program).

#### The address space (satp)

> Build a whole new page table, or keep the existing one and remap a part?

The instant you change `satp`, the user stack itself becomes a different physical page.
Our kernel **keeps satp** and remaps only the code page — the lighter path.

### Two cases — swap satp vs remap only the code page

The same exec can be implemented two ways, and we chose the latter.

| Aspect | Swap address space after fork (textbook) | Remap only the code page (ours) |
|--------|------------------------------------------|---------------------------------|
| Page table | Build new, switch satp | Keep existing |
| User stack | New stack page | Reuse existing (`sp` reset only) |
| User entry | `userret_to(entry, sp, satp)` — registers only | Inline `mv sp; sret` |
| Stack access after switch | **Forbidden** (different physical page) | Free (same address space) |
| Cost | Page-table build + `sfence.vma` | One remap + `sfence.vma` (no page-table build) |
| Isolation | Not a single old mapping remains | Only code swaps; rest of mappings kept |

The textbook path is cleaner (the old program's mappings vanish entirely), but for our purposes remapping the code page is enough and far lighter.

> One caveat: a remap also **changes a PTE**, so even with satp unchanged the old translation may linger in the TLB and must be flushed with `sfence.vma` (which is exactly what `remap_user_code` does). It's lighter not because "there's no TLB flush" but because **we don't build a new page table.**

### Our code — proc_exec()

The real `proc_exec` does more than the one-line summary.
**Before** loading the new code, it reclaims the heap and mmap regions the old program used (otherwise those pages leak).

```c
// proc.c — proc_exec()  (excerpt from the real code)
int sz = fs_read(path, elfbuf, sizeof(elfbuf));   // read the ELF from disk
if (sz < 0) return -1;                            // no such file -> fail

char *newcode = kalloc();
zero(newcode, PGSIZE);                            // pre-zero for .bss
uint64 entry;
if (load_elf((const char *)elfbuf, newcode, &entry) != 0) {
    kfree(newcode);
    return -1;                                    // broken ELF -> fail (shell survives)
}

struct proc *p = current_proc();
char *oldcode = p->ucode;
vm_free_range(p->pagetable, HEAPBASE, p->heap_top);  // reclaim old program's heap
p->heap_top = HEAPBASE;                          // new program gets an empty heap
if (p->mmap_base) {                              // reclaim old mmap region the same way
    uint64 mend = p->mmap_base + ((p->mmap_size + PGSIZE - 1) & ~(uint64)(PGSIZE - 1));
    vm_free_range(p->pagetable, p->mmap_base, mend);
    p->mmap_base = 0;
}

remap_user_code(p->pagetable, (uint64)newcode);  // re-point USERVA -> new code
p->ucode = newcode;
if (oldcode) kfree(oldcode);                      // reclaim old code page (no leak)

// Enter U-mode. satp (address space) is unchanged, so the stack survives -> reuse it.
uint64 s = r_sstatus();
s &= ~SSTATUS_SPP;   // sret will land in U-mode
s |= SSTATUS_SPIE;   // enable interrupts in U-mode (preemptible)
s |= SSTATUS_SUM;    // kernel may save a trap frame on the user stack
w_sstatus(s);
w_sepc(entry);       // the new program's entry point
asm volatile("mv sp, %0\n sret\n" :: "r"((uint64)USERSTACKTOP));  // top + sret
return -1;           // reaching here is a bug (sret never returns)
```

The last two lines are the heart of it.
`mv sp, USERSTACKTOP` resets the stack pointer to the top, then `sret` drops straight into U-mode.
We pre-loaded `sepc` with the new program's `entry`, so right after `sret` the CPU starts at hello's first instruction.
When `exec` succeeds, **this function never returns** — the child process that called it has already become hello.

### The textbook path that swaps satp too — userret_to

The left column of the table (the textbook path) is ready in kernelvec.S as well.
If you also have to swap satp, the inline `mv sp; sret` isn't enough.
The instant you change satp, the user stack itself becomes a different physical page, and from then on you must **never** touch the stack again.
So the assembly helper `userret_to(entry, sp, satp)` does satp switch -> `sfence.vma` (flush the TLB) -> set `sepc`/`sp` -> `sret`, **all in registers**.
After the switch it touches no memory (no stack) and drops straight into user mode.

```asm
# kernelvec.S — userret_to(entry, sp, satp) [a0, a1, a2]
# Changing satp swaps the whole user stack, so after the switch we never touch
# the stack and sret using registers only. (sstatus is set up in C beforehand.)
userret_to:
        csrw    satp, a2          # switch address space
        sfence.vma zero, zero     # flush old translations (TLB)
        csrw    sepc, a0          # new entry point
        mv      sp, a1            # new stack top
        sret                      # into U-mode (never returns)
```

### The pitfall — a failed exec must not kill the process

The most common pitfall in exec is "what happens on failure."
If you type a nonexistent file (`fs_read` returns -1) or the ELF is broken, exec must **not damage the current process** — it just returns `-1`.
That's why the real code makes `load_elf` fully succeed **before** it `kfree`s the old code page.
If anything fails midway, it discards only the freshly-allocated `newcode` and leaves the old state intact.
This is the secret to the shell surviving a typo and merely printing `command not found` (when the shell's forked child fails to exec, the child prints that message and `exit`s).

> **Common misconception fix**: *"Wipe the old stuff first, then load the new — cleaner that way"* — no. If you `kfree` the old code first, there's nowhere to go back to when `load_elf` fails. The key to failure-safety is to **reclaim old resources only after the new state has fully succeeded**. That's exactly why our code puts `kfree(oldcode)` *after* `remap_user_code`.

> An exec that survives failure with the process intact — that's what keeps the shell running forever.

## 2. The Real Problem Blocking read Has to Solve

> When there's no input yet, wait without burning the CPU, and wake up *the instant* a character arrives.

Until now the shell lived inside the kernel (S-mode) — the `hobby>` shell from Part 1.
In real Unix, the shell is just **another user program**.
To move the shell out of the kernel, it has to be able to wait for keyboard input via `read()`.
But what if the user hasn't typed anything yet?

### Two cases — busy-wait vs sleep/wakeup

| Aspect | Busy-wait | sleep/wakeup (ours) |
|--------|-----------|---------------------|
| When no input | `while (no input) ;` spinning | Yield the CPU, go SLEEPING |
| CPU usage | 100%, burned for nothing | 0%, used by other processes |
| CPU use | Burns 100% spinning, wasting power and cycles | Rests on wfi, woken by interrupt |
| How it wakes | (can't wake at all) | Woken precisely by channel match |
| Risk | Deadlock-like starvation | Lost wakeup (solved below) |

Busy-wait is inefficient — the shell pins the CPU at 100%, spinning while doing no useful work and just burning power. (Our kernel is preemptive, so the timer interrupt still cuts in and handlers/other processes don't starve — the problem is that the CPU is wasted wholesale until input arrives.)
The right answer is to **block**: when there's no input, yield the CPU and sleep, then wake up when a character arrives.

### Background — the channel

> How do the sleeper and the waker agree on "the same event"?

This "sleep / wake up" is **sleep / wakeup**.
The core idea is a **channel** — just an arbitrary pointer value.
If the sleeper and the waker agree on the **same address** as a rendezvous token, you can wake exactly the sleepers waiting on it.
Here we use the input buffer's address `&inbuf` as the channel.

```c
// proc.c — the real code
void sleep(void *chan) {
    struct proc *p = cpu_proc[r_tp()];
    p->chan = chan;                      // mark: sleeping on this channel
    p->state = SLEEPING;
    swtch(&p->context, &cpu_sched[id]);  // hand off to scheduler holding pt_lock
    p->chan = 0;                         // on wakeup (pt_lock held again) resume here
}
void wakeup(void *chan) {
    for (int i = 0; i < NPROC; i++) {
        struct proc *p = &proctable[i];
        if (p->state == SLEEPING && p->chan == chan)
            p->state = RUNNABLE;         // wake those sleeping on this channel
    }
}
```

`read()` (`console_read`) sleeps with `sleep(&inbuf)` when the input buffer is empty (`in_r == in_w`).
Meanwhile the UART interrupt (`console_intr`) accumulates characters into the buffer and echoes them, and once a line is complete (`\n`) it wakes the sleeping read with `wakeup(&inbuf)`.

```c
// console.c — the real code (gist)
int console_read(char *dst, int n) {
    int i = 0;
    acquire(&pt_lock);                  // (A) take the lock first
    while (i < n) {
        while (in_r == in_w)
            sleep(&inbuf);              // (B) no input -> sleep (lock held)
        char c = inbuf[in_r % INBUF];
        in_r++;
        dst[i++] = c;
        if (c == '\n') break;           // end of line
    }
    release(&pt_lock);
    return i;
}
```

```c
// console.c — the interrupt side
void console_intr(char c) {
    if (c == '\r') c = '\n';
    acquire(&pt_lock);                  // same lock as read
    // (DEL/Backspace and buffer-full handling omitted)
    inbuf[in_w % INBUF] = c;
    in_w++;
    uart_putc(c);                       // echo the input
    if (c == '\n')
        wakeup(&inbuf);                 // line complete -> wake read
    release(&pt_lock);
}
```

### The pitfall — the lost wakeup

Here's the classic pitfall every OS textbook flags.
What if, in the **instant** `read` checks "is the buffer empty?" (`in_r == in_w`) and decides to `sleep`, an interrupt slips in, inserts a character, and fires `wakeup`?
The order becomes: read sees "empty" -> (interrupt inserts a char and wakes) -> `sleep` (now asleep), and **it misses a wakeup that has already gone by, so it never wakes up**.
That's a **lost wakeup**.

The key is to bind "check -> sleep" **atomically** so no wakeup can slip in between.
Our approach is the spinlock **`pt_lock`**.
`console_read` takes the lock at (A), and **holding** that lock it does the check and enters `sleep`.
But the waker, `console_intr`, must also acquire the same `pt_lock` to put a character in the buffer and fire `wakeup`.
So while read holds the lock, the interrupt handler can **neither touch the buffer nor fire wakeup** — it waits at the lock.

The magic is inside `sleep`.
`sleep` crosses into the scheduler via `swtch` **still holding the lock** (look at the `sleep` code above — it doesn't release it).
Only **after** the process is marked SLEEPING and has come off the CPU does the lock get released on the scheduler side.
So until "mark as sleeping + yield the CPU" completes, no one else can grab the lock, and a wakeup can't wedge into that gap.
Everything from the check to actually falling asleep is protected as one unit.

> **Common misconception fix**: *"Interrupts are off during a trap (SIE=0), so a lost wakeup is prevented just by clearing SIE"* — plausible on a single core, but a wrong generalization. Our kernel is written with multicore in mind — **another core's** interrupt could run `console_intr` concurrently. So clearing your own core's interrupts isn't enough; the real defense is to **wrap the shared data (`inbuf`, `in_w`, process state) in a spinlock so check~sleep is one unit**. That's why `console_intr` bothers to acquire `pt_lock` too.

When the shell sleeps and there's no other process to run, the scheduler has nothing to do.
At that point, **only when the scheduler scans and finds nothing RUNNABLE**, the core rests with `wfi` (wait-for-interrupt) to save power, and wakes when a console/timer interrupt comes in.
That console interrupt has just made the shell RUNNABLE via `wakeup`, so the scheduler picks the shell and runs it again.

> Bind the check and the sleep under the same lock — half of synchronization is finding *which two actions must be made atomic*.

## 3. The Real Problem wait/exit Has to Solve

> Who reclaims a finished child's resources, and when? A child **cannot free the very kernel stack it's standing on.**

When the shell runs a command, it has to **wait until that command finishes**.
Otherwise hello's output and the next `$ ` prompt would get interleaved into a mess.
Also, **someone** has to reclaim a finished child's resources (user pages, page table, kernel stack…), and the parent does that in `wait`.

### Background — the zombie

> Why can't a dead child vanish at once?

A child can't fully clean up its own resources at `exit` — for instance, it can't free the very kernel stack it's currently running on (free it and the floor drops out).
So at `exit` the child doesn't vanish; it lingers briefly in the **ZOMBIE** state.
"Marked as dead, but the body isn't cleared yet."
And it wakes its parent via `wakeup` to say "I'm done, come clean me up."
The parent's `wait`, on finding a zombie child, reaps its resources, frees the slot to `UNUSED`, and returns its pid. (Real Unix's `wait` also collects the child's **exit code**, but our implementation only returns the pid.)

```c
// proc.c — the real code
void proc_exit(void) {
    struct proc *p = cpu_proc[r_tp()];
    acquire(&pt_lock);
    if (p->parent)
        wakeup(p->parent);              // wake a waiting parent (parent as channel)
    p->state = ZOMBIE;                  // leave only the body
    swtch(&p->context, &cpu_sched[id]); // into the scheduler, pt_lock held. No return.
    for (;;) ;                          // (unreachable)
}

int proc_wait(void) {
    struct proc *p = cpu_proc[r_tp()];
    acquire(&pt_lock);
    for (;;) {
        int kids = 0;
        for (int i = 0; i < NPROC; i++) {
            struct proc *q = &proctable[i];
            if (q->parent != p) continue;
            kids = 1;
            if (q->state == ZOMBIE) {       // found a zombie child
                int pid = q->pid;
                proc_freeimage(q);          // reclaim user pages + page table + stack
                q->parent = 0;
                q->state = UNUSED;          // free the slot
                release(&pt_lock);
                return pid;
            }
        }
        if (!kids) { release(&pt_lock); return -1; }  // no children
        sleep(p);                           // sleep until a child wakes us (self as chan)
    }
}
```

### Channel = the parent proc

Notice the **channel is `p` (the parent itself)**.
The parent sleeps on "itself" as the token with `sleep(p)`, and the child wakes it in `proc_exit` with `wakeup(p->parent)` — the parent as channel.
Since they use the same address (the parent proc) as the token, exactly that parent wakes.
It's the **exact same mechanism** as using `&inbuf` as the channel in §2 — a channel is just "an agreed-upon address," whether it's an input buffer or a parent struct.
And because sleep/wakeup again run under the same `pt_lock`, even if the child's exit slips in between the "zombie check" and the `sleep`, no wakeup is lost (the lost-wakeup defense from §2 is reused as-is).

> **Common misconception fix**: *"On exit, can't the child just clean everything up itself?"* — no. The child is currently **running `proc_exit` on its own kernel stack**, so if it `kfree`s that stack with its own hands, the floor drops out immediately. That's why the child leaves only the body as a ZOMBIE, and **the parent's `proc_freeimage`** reclaims the rest, kernel stack included. The reclaimer being the parent rather than the child isn't a coincidence — it's a necessity.

Resource reclamation (`proc_freeimage`) actually returns the user code/stack pages, the demand-allocated heap and mmap pages, the kernel stack, and even the page-table tree, all back to the free list via `kfree`.
This is the final link where the physical page allocator from Part 1 "gets back the pages it handed out."

## 4. Putting it all together — the userspace shell

The shell is now an ordinary C program (`user/init.c`).
It prints a prompt, reads a line, handles built-in commands (`ls`/`cat`/`help`/`rm`/`write`/`mem`) directly, and treats everything else as a **disk program** with `fork` -> child `exec`s -> parent `wait`s.

```c
// user/init.c — the userspace shell (gist)
for (;;) {
    puts("$ ");
    long n = sys_read(line, sizeof(line) - 1);   // blocking read (sleeps if empty)  <- §2
    if (n <= 0) continue;
    if (line[n - 1] == '\n') line[n - 1] = 0;    // strip newline

    if (streq(line, "ls"))  { sys_ls();  continue; }       // built-in
    if (startswith(line, "cat ")) { sys_cat(line + 4); continue; }
    // ... help / rm / write / mem are also built-in

    long pid = sys_fork();                        // external command
    if (pid == 0) {                               // child
        sys_exec(line);                           // morph into the disk program  <- §1
        puts(line);
        puts(": command not found\n");            // reached only if exec failed
        sys_exit();
    }
    sys_wait();                                   // parent: wait until child finishes  <- §3
}
```

The three sections converge in one loop.
`sys_read` is §2's blocking read, `sys_exec` is §1's address-space swap, and `sys_wait` is §3's zombie reclamation.

Look closely at the child branch.
If `sys_exec(line)` succeeds, that child has already become a different program, so it **never returns to the next line**.
`command not found` prints only when `exec` failed and returned.
This shows how "a failed exec returns -1 instead of killing the process" from §1 is actually used by the shell.

At boot, the kernel launches this shell as the first user process.

```
hobby-kernel userspace shell. try: ls, cat motd.txt, hello
$ ls
  motd.txt  (162 bytes)
  readme.txt  (240 bytes)
  hello  (7352 bytes)
$ hello
  [hello] I am a separate program, exec'd from disk!
$ cat motd.txt
Welcome to hobby-kernel (C / RISC-V). ...
$ nope
nope: command not found
```

Type `hello` and — the shell forks, the child execs hello from disk to become that program, hello prints and exits, the shell's wait returns and the prompt comes back.
**The very mechanism by which Unix runs commands** is working.

This one picture captures the whole fork → exec → wait flow at a glance.

![The shell forks into parent and child; the child execs hello, runs, exits (ZOMBIE) and wakes the parent, whose wait returns the child pid before printing the next prompt](/uploads/hobby/hobby-kernel-c/fork-exec-wait-en.svg)

## 5. Wrap-up

The last loop of a small Unix turned out to be a collection of **three "floor under your feet" problems.**

- **exec** — tearing down the address space you're standing on. We keep satp, remap only the code page, and enter via inline `mv sp; sret`; the textbook satp-swapping path is handled register-only by `userret_to`. The key to failure-safety is the ordering: **`kfree` the old code only after the new state has fully succeeded.**
- **blocking read** — sleep/wakeup instead of busy-wait. The lost wakeup is prevented not by clearing SIE but by **binding check~sleep with the spinlock `pt_lock`** (`sleep` does `swtch` while holding the lock).
- **wait/exit** — a child can't free its own kernel stack, so it lingers as a ZOMBIE and wakes the parent (channel = parent proc); **the parent's `proc_freeimage`** reclaims it.

What stands out is that all three are solved with the same tools — sleep/wakeup, channels, and the spinlock — and that getting "who reclaims, and when" wrong drops the floor out from under you.

From boot to here, the skeleton of an operating system is fully in place.

```
부팅 → 트랩/타이머 → 키보드 → 페이지 할당기 → 페이징(Sv39)
→ 유저모드+syscall → 프로세스+선점 스케줄러 → 유저 프로세스(격리)
→ fork → ELF 로더 → 파일시스템 → 런타임 exec → 유저공간 셸
```

- CPU — traps, interrupts, preemptive scheduling, sleep/wakeup
- Memory — Sv39 paging, per-process address space isolation
- Processes — fork, exec, wait, lifecycle
- Storage — virtio-blk disk, filesystem
- Interface — a userspace shell launches disk programs via fork+exec

Reading "how an OS runs" in a book, versus spending an hour stuck because of one missing `volatile` line and getting blocked by a single `SUM` bit — those were entirely different kinds of understanding.
Building it from the ground up in C and touching it with my own hands is what this whole project was about.

What's left is all refinement — a writable filesystem, inodes, full resource reclamation on exit, shell pipes and redirection.
Not new core features, just polish.
This four-part series wraps up here.

> Code: [github.com/dj258255/hobby-kernel](https://github.com/dj258255/hobby-kernel)

## References (Primary Sources First)

- [xv6 book — Chapter 1 (exec), Chapter 7 (Scheduling: sleep/wakeup, exit/wait)](https://pdos.csail.mit.edu/6.828/2023/xv6/book-riscv-rev3.pdf)
- [xv6 source — `exec.c`, `proc.c` (sleep/wakeup, wait/exit), `kernelvec.S`](https://github.com/mit-pdos/xv6-riscv)
- [The RISC-V Instruction Set Manual, Volume II: Privileged Architecture (satp, sstatus SPP/SPIE/SUM, sret, sfence.vma)](https://riscv.org/technical/specifications/)
- [xv6: a simple, Unix-like teaching operating system (MIT 6.S081)](https://pdos.csail.mit.edu/6.828/2023/xv6.html)

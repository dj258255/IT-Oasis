---
title: 'C로 만드는 RISC-V 토이 커널 — exec와 유저공간 셸'
titleEn: 'A RISC-V Toy Kernel in C — exec and a Userspace Shell'
description: 작은 유닉스의 마지막 조각. 실행 중인 프로세스를 디스크의 다른 프로그램으로 바꾸는 런타임 exec(), 그리고 sleep/wakeup·read·wait로 커널 밖에서 도는 유저공간 셸까지. 셸이 fork+exec로 디스크 프로그램을 띄우는 유닉스의 핵심 루프를 완성한다.
descriptionEn: "The last piece of a small Unix — a runtime exec() that swaps a running process for another program from disk, and a userspace shell built on sleep/wakeup, read, and wait. Completing the Unix core loop where a shell launches disk programs via fork+exec."
date: 2026-06-25T00:00:00.000Z
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


## 들어가며

[3편](/blog/hobby/hobby-kernel-02-fork-elf-filesystem)에서 fork, ELF 로더, 파일시스템까지 왔어요. 이제 마지막 조각 두 개로 "작은 유닉스"를 완성해요.

1. **런타임 exec()** — 실행 중인 프로세스를 디스크의 다른 프로그램으로 교체
2. **유저공간 셸** — 커널 밖에서 도는 셸이 명령을 받아 프로그램을 실행

이 둘이 합쳐지면 **유닉스가 모든 명령을 실행하는 방식** — 셸이 `fork`하고, 자식이 `exec`로 프로그램이 되고, 부모가 `wait`로 기다리는 — 그 핵심 루프가 돼요.

## 1. 런타임 exec()

지금까지 유저 프로그램은 부팅 때 한 번 적재됐어요. `exec()`는 **실행 중인 프로세스가 자신을 디스크의 다른 프로그램으로 바꾸는** 시스템콜이에요. 셸이 `hello`를 칠 때, 자식 프로세스가 `exec("hello")`로 hello 프로그램이 되는 거죠.

exec의 까다로움은 "달리는 차의 엔진을 바꾸는 것"이에요. 프로세스가 자기 주소공간을 헐고 새 프로그램을 올리는데, 그 코드 자체가 그 주소공간에서 돌아요. 특히 **유저 스택을 건드리면** exec 함수의 지역변수가 깨져요.

그래서 한 가지 트릭을 써요 — 페이지 테이블과 스택은 **그대로 두고, 코드 페이지만 교체**해요. 디스크에서 새 프로그램을 읽어 새 코드 페이지에 적재하고, 기존 페이지 테이블의 `USERVA` 매핑만 새 코드로 갈아끼워요. 스택은 재사용하되 `sp`를 top으로 리셋. 주소공간(`satp`)이 안 바뀌니 스택도 안 깨지고, 옛 코드 페이지는 회수돼요.

```c
// proc.c — proc_exec()
int sz = fs_read(path, elfbuf, sizeof(elfbuf));   // 디스크에서 프로그램 읽기
char *newcode = kalloc();
load_elf(elfbuf, newcode, &entry);                // ELF 적재

remap_user_code(p->pagetable, (uint64)newcode);   // USERVA → 새 코드로 리매핑
kfree(p->ucode);                                  // 옛 코드 회수
p->ucode = newcode;

// 스택 재사용 + U-mode 진입 (satp 그대로라 스택이 안 바뀜)
w_sepc(entry);
asm volatile("mv sp, %0\n sret\n" :: "r"(USERSTACKTOP));
```

## 2. 유저공간 셸 — sleep / wakeup

지금까지 셸은 커널 안(S-mode)에 있었어요. 진짜 유닉스에선 셸도 그냥 **유저 프로그램**이에요. 셸을 커널 밖으로 내리려면, 셸이 `read()`로 입력을 기다릴 수 있어야 해요. 그런데 입력이 아직 없으면? **블록**돼야 해요 — CPU를 다른 프로세스에 양보하고 잠들었다가, 입력이 오면 깨어나야죠.

이게 **sleep / wakeup**이에요.

```c
// proc.c
void sleep(void *chan) {
    cur->chan = chan;
    cur->state = SLEEPING;
    swtch(&cur->context, &sched_context);  // 깨어날 때까지 스케줄러로
}
void wakeup(void *chan) {
    for (each proc p)
        if (p->state == SLEEPING && p->chan == chan)
            p->state = RUNNABLE;
}
```

`read()`는 입력 버퍼가 비었으면 `sleep(&inbuf)`로 잠들어요. UART 인터럽트가 글자를 버퍼에 쌓고, 한 줄이 완성되면(`\n`) `wakeup(&inbuf)`로 깨워요.

```c
// console.c
int console_read(char *dst, int n) {
    int i = 0;
    while (i < n) {
        while (in_r == in_w)
            sleep(&inbuf);          // 입력 없으면 잠든다
        char c = inbuf[in_r++ % INBUF];
        dst[i++] = c;
        if (c == '\n') break;
    }
    return i;
}
```

> **잃어버린 wakeup**을 어떻게 막을까요? "버퍼가 비었나" 검사와 `sleep` 사이에 인터럽트가 끼어들어 `wakeup`을 놓치면 영영 못 깨어나요. 핵심은 — `read()`는 시스템콜(트랩) 안에서 도는데, **트랩 처리 중엔 인터럽트가 꺼져 있어요(SIE=0)**. 그래서 "검사 → sleep"이 원자적이라, 그 사이에 콘솔 인터럽트가 끼어들 수 없어요.

셸이 잠들면 스케줄러는 돌릴 프로세스가 없어요. 이때는 `wfi`(wait-for-interrupt)로 쉬다가, 콘솔/타이머 인터럽트가 깨우면 다시 돌아요.

## 3. wait() — 자식을 기다리다

셸은 명령을 실행하면 그게 **끝날 때까지 기다려야** 해요. 안 그러면 프로그램 출력과 다음 프롬프트가 뒤섞여요. 그게 `wait()`예요.

자식이 `exit`하면 곧장 사라지는 게 아니라 **ZOMBIE**가 되고 부모를 깨워요. 부모의 `wait()`는 좀비가 된 자식을 발견하면 회수(자원 반납)하고 그 pid를 반환해요.

```c
void proc_exit(void) {
    wakeup(cur->parent);    // wait 중인 부모 깨우기
    cur->state = ZOMBIE;
    swtch(&cur->context, &sched_context);  // 다신 안 돌아옴
}
int proc_wait(void) {
    for (;;) {
        for (each child q of cur)
            if (q->state == ZOMBIE) { reap(q); return q->pid; }
        sleep(cur);         // 자식이 깨울 때까지
    }
}
```

## 4. 다 합치면 — 유저공간 셸

셸은 이제 평범한 C 프로그램이에요. 프롬프트를 찍고, 한 줄 읽고, 내장 명령(`ls`/`cat`)은 직접, 그 외엔 `fork` → 자식이 `exec` → 부모가 `wait`.

```c
// user/init.c — 유저공간 셸
for (;;) {
    puts("$ ");
    sys_read(line, sizeof(line));
    if (streq(line, "ls"))  { sys_ls();  continue; }       // 내장
    long pid = sys_fork();
    if (pid == 0) {
        sys_exec(line);                                    // 디스크 프로그램으로
        puts("command not found\n");
        sys_exit();
    }
    sys_wait();                                            // 끝날 때까지 대기
}
```

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

`hello`를 치면 — 셸이 fork하고, 자식이 디스크의 hello를 exec해서 그 프로그램이 되고, hello가 출력하고 exit하면, 셸의 wait가 돌아와 프롬프트를 다시 띄워요. **유닉스가 명령을 실행하는 바로 그 메커니즘**이 동작합니다.

## 마치며 — 작은 유닉스 완성

부팅부터 여기까지, 운영체제의 골격이 다 섰어요.

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

"OS가 어떻게 도는가"를 책으로 읽는 것과, `volatile` 한 줄 때문에 한 시간을 헤매고 `SUM` 비트 하나에 막혀보는 건 전혀 다른 이해였어요. 바닥부터 C로 짜며 그걸 손으로 만진 게 이 프로젝트의 전부예요.

남은 건 전부 정제 — 쓰기 가능한 파일시스템, inode, exit 시 완전한 자원 회수, 셸 파이프/리다이렉트. 새 핵심 기능이 아니라 다듬기예요. 4편에 걸친 연재는 여기서 매듭지어요.

> 코드: [github.com/dj258255/hobby-kernel](https://github.com/dj258255/hobby-kernel)

### 참고 자료

- [xv6: a simple, Unix-like teaching operating system (MIT 6.S081)](https://pdos.csail.mit.edu/6.828/2023/xv6.html)
- [xv6 book — Chapter 7 (Scheduling), Chapter 1 (exec)](https://pdos.csail.mit.edu/6.828/2023/xv6/book-riscv-rev3.pdf)

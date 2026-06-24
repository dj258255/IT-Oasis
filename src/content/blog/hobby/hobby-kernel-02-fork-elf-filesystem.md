---
title: 'C로 만드는 RISC-V 토이 커널 — fork, ELF 로더, 그리고 파일시스템'
titleEn: 'A RISC-V Toy Kernel in C — fork, an ELF Loader, and a Filesystem'
description: 프로세스 모델을 완성하고 저장장치를 붙인다. 주소공간을 복사하는 fork(), 따로 컴파일한 진짜 ELF 프로그램을 파싱해 적재하는 로더, 그리고 virtio-blk 디스크 위에 올린 읽기 전용 파일시스템(ls/cat)까지. 디버깅에서 만난 volatile과 virtio 기능 협상 이야기를 곁들인다.
descriptionEn: "Completing the process model and attaching storage — fork() that duplicates an address space, a loader that parses a real separately-compiled ELF program, and a read-only filesystem on a virtio-blk disk (ls/cat). With debugging notes on volatile and virtio feature negotiation."
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
seriesOrder: 3
---


## 들어가며

[2편](/blog/hobby/hobby-kernel-01-usermode-to-processes)에서 유저 프로세스까지 왔어요 — U-mode, 시스템콜, 선점형 스케줄러, 프로세스별 주소공간. 이번 글은 그 위에 유닉스 프로세스 모델의 나머지와, 완전히 새로운 축인 **저장장치**를 붙여요.

1. **fork()** — 프로세스가 자신을 복제한다
2. **ELF 로더** — 인라인 어셈블리 대신 따로 컴파일한 진짜 프로그램을 적재한다
3. **파일시스템** — virtio-blk 디스크를 읽어 `ls` / `cat`

3번은 한 번에 안 됐어요. virtio 드라이버를 디버깅하며 만난 `volatile` 한 줄이 이번 글의 하이라이트예요.

## 1. fork() — 프로세스 복제

`fork()`는 유닉스의 상징이에요. 호출하면 프로세스가 둘이 되고, **부모에겐 자식의 pid를, 자식에겐 0을** 반환해요. 똑같은 코드의 같은 지점에서 갈라지죠.

구현의 우아함은 "자식의 유저 스택이 부모의 복사본"이라는 데서 나와요. 부모가 `fork` `ecall`을 하면 트랩 프레임이 부모의 유저 스택에 저장돼요. 그 스택 페이지를 통째로 복사하면, 자식의 스택에도 **같은 가상주소에** 동일한 프레임이 들어가요. 그래서 자식은 부모와 똑같은 지점으로 복귀하면 되고, 단 하나 — 반환값 `a0`만 0으로 바꿔주면 끝이에요.

```c
// proc.c — proc_fork() 핵심
char *code = kalloc(), *ustack = kalloc();
copybytes(code,   parent->ucode,  PGSIZE);   // 코드 페이지 복사
copybytes(ustack, parent->ustack, PGSIZE);   // 스택 페이지 복사(트랩 프레임 포함)
child->pagetable = proc_pagetable((uint64)code, (uint64)ustack);

// 복사된 스택 안의 트랩 프레임을 손본다
struct regframe *cf = (struct regframe *)(ustack + ((uint64)f - USERSTACK));
cf->a0   = 0;             // 자식의 fork() 반환값 = 0
cf->sepc = f->sepc + 4;   // ecall 다음 명령부터(부모와 같은 지점)

child->context.ra = (uint64)forkret;   // 자식 첫 진입점
child->context.s0 = (uint64)f;          // 프레임 VA(자식에서도 동일)
```

자식이 처음 스케줄되면 `forkret`로 들어가, `s0`(프레임 VA)로 `sp`를 잡고 **트랩 복귀 공통 경로**(`trapret`)를 타요. 결국 부모와 같은 `sret` 메커니즘으로 U-mode에 떨어지는데, 반환값만 0이죠.

```
  [parent] fork() returned a child; we are two now.
  [child]  hello -- I was created by fork().
hobby> ps
  spinK  (kernel pid=0): ticks=7945564
  userP  (user pid=1):   ticks=13        ← 부모
  userP+ (user pid=2):   ticks=10        ← fork로 태어난 자식
```

하나였던 유저 프로세스가 둘이 되어, 커널 스레드와 함께 셋이 선점 스케줄돼요.

## 2. ELF 로더 — 진짜 프로그램 적재

지금까지 유저 프로그램은 커널 안에 인라인 어셈블리로 박혀 있었어요. 이걸 **따로 컴파일한 진짜 ELF 바이너리**로 바꿔요. 유저 공간(`user/init.c`)을 별도로 컴파일하고, 빌드된 ELF를 `.incbin`으로 커널 이미지에 임베드한 뒤, 커널이 부팅 때 파싱해 적재해요.

exec의 본질은 "ELF의 지도를 보고 주소공간을 그리는 것"이에요. ELF의 **프로그램 헤더** 각 `PT_LOAD` 항목이 "파일의 이 부분을, 이 가상주소에, 이만큼 적재하라"는 지시예요.

```c
// elf.c — PT_LOAD 세그먼트 적재
for (int i = 0; i < eh->e_phnum; i++) {
    const struct elf64_phdr *ph = ...;
    if (ph->p_type != PT_LOAD) continue;
    uint64 off = ph->p_vaddr - USERVA;
    copyb(codepage + off, img + ph->p_offset, ph->p_filesz);
    // p_memsz > p_filesz 부분(.bss)은 codepage가 미리 0이라 자동 처리
}
```

유저 프로그램을 USERVA(`0x1000`)에 링크해 한 페이지에 담으면, 1편부터 써온 주소 배치와 fork(페이지 복사)에도 그대로 호환돼요. 이제 `user/init.c`는 평범한 C 프로그램이에요.

```c
// user/init.c
void _start(void) {
    long pid = sys_fork();   // 자신을 복제
    sys_print(pid);          // 부모/자식 메시지
    for (int i = 0; i < 25; i++) { sys_tick(); /* busy wait */ }
    sys_exit();
}
```

## 3. 파일시스템 — virtio-blk 디스크

마지막은 완전히 새로운 축, **저장장치**예요. QEMU의 virtio-blk 디스크를 붙이고, 그 위에 아주 단순한 읽기 전용 파일시스템을 올려요.

```
블록 0   슈퍼블록 (magic + 파일 수)
블록 1   디렉터리 (이름, 크기, 시작 블록)
블록 2.. 파일 데이터
```

호스트(맥)에서 `mkfs` 도구로 디스크 이미지를 만들고, QEMU에 붙여요. 커널은 자기 드라이버로 디스크를 읽어 `ls` / `cat`을 제공해요.

virtio는 "게스트와 호스트가 공유 메모리 링으로 대화하는" 표준이에요. 디스크에 직접 명령을 쓰는 게 아니라, 메모리에 **디스크립터 체인**(요청 헤더 + 데이터 버퍼 + 상태 바이트)을 만들어 available 링에 넣고, MMIO 레지스터를 한 번 두드려(notify) 알린 뒤, **used 링**이 갱신될 때까지 폴링해요.

```c
// virtio.c — 한 블록 읽기
desc[0] = {요청헤더, NEXT→1};
desc[1] = {데이터버퍼, WRITE|NEXT→2};   // 디바이스가 여기에 데이터를 씀
desc[2] = {상태바이트, WRITE};
avail->ring[avail->idx % NUM] = 0;
avail->idx += 1;
R32(MMIO_QUEUE_NOTIFY) = 0;             // 디바이스에 알림
while (used->idx == used_seen) ;        // 완료까지 폴링
```

```
[ok] virtio-blk disk ready
[ok] filesystem mounted: 2 files
hobby> ls
  motd.txt  (162 bytes)
  readme.txt  (240 bytes)
hobby> cat motd.txt
Welcome to hobby-kernel (C / RISC-V).
This text lives on a virtio-blk disk and was read by the kernel's
own filesystem driver -- not baked into the kernel image.
```

이 텍스트는 진짜로 디스크 이미지 안에 있고, 커널이 제 드라이버로 읽어 출력한 거예요. 커널 이미지에 들어있는 게 아니고요.

### 디버깅: 왜 멈췄을까

이 단계는 세 번 막혔어요. 전부 교과서적인 함정이었어요.

- **virtio MMIO 매핑** — 페이징을 켠 뒤 `0x10001000`(virtio 레지스터)을 안 매핑해서 첫 접근에 페이지 폴트. 커널 페이지 테이블에 추가.
- **모던 vs 레거시** — QEMU virtio-mmio는 기본이 레거시(version 1). 제 드라이버는 모던(version 2)이라 `-global virtio-mmio.force-legacy=false`로 강제. 그리고 모던은 드라이버가 `VIRTIO_F_VERSION_1`(기능 비트 32, **상위 워드**)을 수락해야 큐가 동작해요.
- **`volatile`** — 이게 제일 좋았어요. 디바이스는 요청을 성공적으로 처리했는데(`used->idx`가 1로, 상태 바이트가 0으로 바뀜) 폴링 루프가 영원히 안 끝났어요. 원인은 `used`가 `volatile`이 아니라 컴파일러가 `used->idx`를 레지스터에 캐시해 메모리 변화를 못 본 것. 하드웨어가 비동기로 갱신하는 메모리는 반드시 `volatile`로 읽어야 해요.

```c
static volatile struct virtq_used *used;  // 디바이스가 비동기 갱신 → volatile
```

책으로 "MMIO는 volatile" 한 줄 읽을 땐 그냥 넘어갔는데, 직접 한 시간 헤매고 나니 왜 그런지 몸으로 알겠더라고요.

## 마치며

여기까지 오면서 운영체제의 **다섯 축**이 전부 동작해요.

- CPU — 트랩, 인터럽트, 선점형 스케줄링
- 메모리 — Sv39 페이징, 프로세스별 주소공간 격리
- 프로세스 — fork, ELF 적재, 생명주기
- 저장장치 — virtio-blk 디스크, 파일시스템
- 인터페이스 — 인터랙티브 커널 셸

부팅해서 명령을 치고, 여러 프로그램이 격리된 채 동시에 돌고, 디스크에서 파일을 읽는 — 작지만 진짜 운영체제가 됐어요. xv6를 참고서 삼아 바닥부터 C로 짜며, "OS가 어떻게 도는가"를 손으로 만져 이해하는 게 목표였는데, 그 목표는 이룬 것 같아요.

다음으로 더 간다면 유저공간 셸(셸 자체를 디스크의 프로그램으로 내리고 파일에서 `exec`), 쓰기 가능한 파일시스템, 런타임 `exec()` 시스템콜이 남아 있어요. 하지만 한 호흡은 여기서.

> 코드: [github.com/dj258255/hobby-kernel](https://github.com/dj258255/hobby-kernel)

### 참고 자료

- [xv6: a simple, Unix-like teaching operating system (MIT 6.S081)](https://pdos.csail.mit.edu/6.828/2023/xv6.html)
- [Virtio 1.1 Specification (OASIS)](https://docs.oasis-open.org/virtio/virtio/v1.1/virtio-v1.1.html)
- [ELF-64 Object File Format](https://uclibc.org/docs/elf-64-gen.pdf)

<!-- EN -->

## Introduction

In [part 2](/blog/hobby/hobby-kernel-01-usermode-to-processes) we got all the way to user processes — U-mode, syscalls, a preemptive scheduler, per-process address spaces. This post builds on that foundation, adding the rest of the Unix process model and a brand-new pillar: **storage**.

1. **fork()** — a process duplicates itself
2. **ELF loader** — load a real, separately-compiled program instead of inline assembly
3. **filesystem** — read a virtio-blk disk to provide `ls` / `cat`

Number 3 didn't work on the first try. The single line of `volatile` I ran into while debugging the virtio driver is the highlight of this post.

## 1. fork() — process duplication

`fork()` is the icon of Unix. Call it and the process becomes two; it returns **the child's pid to the parent, and 0 to the child**. The same code branches at the very same point.

The elegance of the implementation comes from the fact that "the child's user stack is a copy of the parent's." When the parent does a `fork` `ecall`, the trap frame is saved on the parent's user stack. Copy that whole stack page, and the child's stack ends up with the same frame **at the same virtual address**. So the child just needs to return to the exact same point as the parent — with a single exception: change the return value `a0` to 0, and that's it.

```c
// proc.c — proc_fork() 핵심
char *code = kalloc(), *ustack = kalloc();
copybytes(code,   parent->ucode,  PGSIZE);   // 코드 페이지 복사
copybytes(ustack, parent->ustack, PGSIZE);   // 스택 페이지 복사(트랩 프레임 포함)
child->pagetable = proc_pagetable((uint64)code, (uint64)ustack);

// 복사된 스택 안의 트랩 프레임을 손본다
struct regframe *cf = (struct regframe *)(ustack + ((uint64)f - USERSTACK));
cf->a0   = 0;             // 자식의 fork() 반환값 = 0
cf->sepc = f->sepc + 4;   // ecall 다음 명령부터(부모와 같은 지점)

child->context.ra = (uint64)forkret;   // 자식 첫 진입점
child->context.s0 = (uint64)f;          // 프레임 VA(자식에서도 동일)
```

When the child is first scheduled, it enters `forkret`, sets `sp` from `s0` (the frame VA), and takes the **common trap-return path** (`trapret`). It ultimately drops into U-mode through the same `sret` mechanism as the parent — only the return value is 0.

```
  [parent] fork() returned a child; we are two now.
  [child]  hello -- I was created by fork().
hobby> ps
  spinK  (kernel pid=0): ticks=7945564
  userP  (user pid=1):   ticks=13        ← 부모
  userP+ (user pid=2):   ticks=10        ← fork로 태어난 자식
```

What was a single user process becomes two, and together with the kernel thread, all three are preemptively scheduled.

## 2. ELF loader — loading a real program

Until now the user program was embedded inside the kernel as inline assembly. We replace that with a **real, separately-compiled ELF binary**. We compile user space (`user/init.c`) on its own, embed the built ELF into the kernel image with `.incbin`, and have the kernel parse and load it at boot.

The essence of exec is "drawing the address space by reading the ELF's map." Each `PT_LOAD` entry in the ELF's **program header** is an instruction: "load this part of the file, at this virtual address, this much."

```c
// elf.c — PT_LOAD 세그먼트 적재
for (int i = 0; i < eh->e_phnum; i++) {
    const struct elf64_phdr *ph = ...;
    if (ph->p_type != PT_LOAD) continue;
    uint64 off = ph->p_vaddr - USERVA;
    copyb(codepage + off, img + ph->p_offset, ph->p_filesz);
    // p_memsz > p_filesz 부분(.bss)은 codepage가 미리 0이라 자동 처리
}
```

If you link the user program at USERVA (`0x1000`) and keep it within one page, it stays compatible with the address layout we've used since part 1 and with fork (page copying). Now `user/init.c` is an ordinary C program.

```c
// user/init.c
void _start(void) {
    long pid = sys_fork();   // 자신을 복제
    sys_print(pid);          // 부모/자식 메시지
    for (int i = 0; i < 25; i++) { sys_tick(); /* busy wait */ }
    sys_exit();
}
```

## 3. Filesystem — virtio-blk disk

The last piece is a completely new pillar: **storage**. We attach QEMU's virtio-blk disk and put a very simple read-only filesystem on top of it.

```
블록 0   슈퍼블록 (magic + 파일 수)
블록 1   디렉터리 (이름, 크기, 시작 블록)
블록 2.. 파일 데이터
```

On the host (a Mac) we build the disk image with an `mkfs` tool and attach it to QEMU. The kernel reads the disk with its own driver to provide `ls` / `cat`.

virtio is a standard where "guest and host talk over shared-memory rings." Rather than writing commands directly to the disk, you build a **descriptor chain** in memory (request header + data buffer + status byte), put it in the available ring, knock once on an MMIO register (notify) to signal the device, and then poll until the **used ring** is updated.

```c
// virtio.c — 한 블록 읽기
desc[0] = {요청헤더, NEXT→1};
desc[1] = {데이터버퍼, WRITE|NEXT→2};   // 디바이스가 여기에 데이터를 씀
desc[2] = {상태바이트, WRITE};
avail->ring[avail->idx % NUM] = 0;
avail->idx += 1;
R32(MMIO_QUEUE_NOTIFY) = 0;             // 디바이스에 알림
while (used->idx == used_seen) ;        // 완료까지 폴링
```

```
[ok] virtio-blk disk ready
[ok] filesystem mounted: 2 files
hobby> ls
  motd.txt  (162 bytes)
  readme.txt  (240 bytes)
hobby> cat motd.txt
Welcome to hobby-kernel (C / RISC-V).
This text lives on a virtio-blk disk and was read by the kernel's
own filesystem driver -- not baked into the kernel image.
```

This text really does live inside the disk image, and the kernel read it with its own driver and printed it — it is not baked into the kernel image.

### Debugging: why did it hang?

This stage got stuck three times. All of them were textbook pitfalls.

- **virtio MMIO mapping** — After turning on paging, I hadn't mapped `0x10001000` (the virtio registers), so the first access caused a page fault. Added it to the kernel page table.
- **modern vs legacy** — QEMU's virtio-mmio defaults to legacy (version 1). My driver is modern (version 2), so I forced it with `-global virtio-mmio.force-legacy=false`. And in modern mode, the queue only works once the driver accepts `VIRTIO_F_VERSION_1` (feature bit 32, in the **upper word**).
- **`volatile`** — This was my favorite. The device had successfully processed the request (`used->idx` became 1 and the status byte became 0), yet the polling loop never finished. The cause: `used` wasn't `volatile`, so the compiler cached `used->idx` in a register and never saw the memory change. Memory that hardware updates asynchronously must always be read as `volatile`.

```c
static volatile struct virtq_used *used;  // 디바이스가 비동기 갱신 → volatile
```

When I read the one-liner "MMIO is volatile" in a book, I glossed right over it — but after wandering lost for an hour myself, I now understand why in my bones.

## Wrapping up

By getting here, all **five pillars** of an operating system are working.

- CPU — traps, interrupts, preemptive scheduling
- Memory — Sv39 paging, per-process address-space isolation
- Process — fork, ELF loading, lifecycle
- Storage — virtio-blk disk, filesystem
- Interface — an interactive kernel shell

Boot up, type commands, run multiple programs concurrently in isolation, read files from disk — it has become a small but genuine operating system. My goal was to write it from the ground up in C using xv6 as a reference, and to understand "how an OS runs" hands-on; I think I've reached that goal.

If I were to go further, what remains is a userspace shell (moving the shell itself onto disk as a program and `exec`-ing it from a file), a writable filesystem, and a runtime `exec()` syscall. But this is a good place to pause for breath.

> Code: [github.com/dj258255/hobby-kernel](https://github.com/dj258255/hobby-kernel)

### References

- [xv6: a simple, Unix-like teaching operating system (MIT 6.S081)](https://pdos.csail.mit.edu/6.828/2023/xv6.html)
- [Virtio 1.1 Specification (OASIS)](https://docs.oasis-open.org/virtio/virtio/v1.1/virtio-v1.1.html)
- [ELF-64 Object File Format](https://uclibc.org/docs/elf-64-gen.pdf)

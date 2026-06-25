---
title: '저널링 파일시스템 — 절반만 쓰이지 않게'
titleEn: 'A Journaling Filesystem — Never Half-Written'
description: 쓰기 도중 전원이 나가면 파일시스템은 어떻게 될까. 데이터는 썼는데 디렉터리는 못 썼다면 디스크가 깨진다. 저널링(write-ahead log)은 이걸 막는다 — 변경을 제자리에 바로 쓰지 않고 먼저 로그에 모은 뒤, 커밋 표시를 찍고, 그제서야 설치한다. 크래시가 나도 "전부 반영" 또는 "전혀 반영 안 됨" 둘 중 하나라 디스크는 항상 일관적이다. 여기에 삭제(rm)와 빈 블록 재사용까지 더해 읽기 전용이던 FS를 진짜 읽기-쓰기로 키운다.
descriptionEn: "What happens to a filesystem if the power dies mid-write? If the data was written but the directory wasn't, the disk is corrupt. Journaling (a write-ahead log) prevents this — changes aren't written in place but gathered in a log first, marked committed, and only then installed. Even on a crash it's all-or-nothing, so the disk is always consistent. Adding delete (rm) and free-block reuse turns a read-only FS into a real read-write one."
date: 2026-06-28T00:00:00.000Z
tags:
  - OS
  - C
  - Kernel
  - RISC-V
  - xv6
  - QEMU
  - Filesystem
category: project/hobby-kernel
coverImage: "/uploads/hobby/hobby-kernel-c/cover.svg"
draft: false
series: "C로 만드는 토이 커널"
seriesOrder: 9
---


## 들어가며

[3편에서 만든 파일시스템](/blog/hobby/hobby-kernel-02-fork-elf-filesystem)과 [5편에서 더한 쓰기](/blog/hobby/hobby-kernel-04-paging-mmap-writable-fs)에는 숨은 위험이 있었어요.
파일 하나를 만들 때 우리는 디스크에 **여러 번** 써요 — 데이터 블록, 디렉터리, 슈퍼블록.

그런데 그 사이에 전원이 나가면요?

데이터는 썼는데 디렉터리는 못 썼다면, 그 블록은 "쓰였지만 아무도 모르는" 유령이 돼요.
디렉터리는 썼는데 슈퍼블록(빈 블록 위치)은 못 썼다면, 다음 파일이 같은 블록을 덮어써요.
**여러 번의 쓰기 중간에 죽으면 파일시스템이 깨지는** 거예요.

이번 글은 이걸 막는 고전적 기법, **저널링(journaling)** 이에요.
그리고 읽기 위주였던 FS에 **삭제(`rm`)와 빈 블록 재사용**을 더해 진짜 읽기-쓰기 파일시스템으로 키워요.

## 1. 핵심 아이디어 — 먼저 로그에, 나중에 제자리에

저널링의 아이디어는 데이터베이스의 트랜잭션과 똑같아요([트랜잭션 ACID 글](/blog/theory/transaction-acid-04-durability)과 같은 원리).
변경을 **제자리에 바로 쓰지 않아요.**
대신 이렇게 해요.

1. 바꿀 블록들을 **로그 영역**에 먼저 모은다 (아직 제자리는 그대로).
2. 로그 헤더에 **"커밋"** 표시를 찍는다 — 이게 원자적 분기점.
3. 그제서야 로그의 블록들을 **제자리에 설치**(install)한다.
4. 설치가 끝나면 로그를 비운다.

이러면 어느 시점에 죽어도 안전해요.

- **커밋 전에** 죽으면? 로그는 미완성이고 제자리는 손도 안 댔으니, 그냥 **없던 일**이 돼요.
- **커밋 후에** 죽으면? 재부팅 때 로그를 보고 **설치를 마저** 끝내요(replay).

즉 **"전부 반영" 또는 "전혀 반영 안 됨"** — 절반만 쓰인 상태가 없어요.
이게 원자성(atomicity)이고, 파일시스템 일관성의 핵심이에요.

디스크 레이아웃에 로그 영역을 넣었어요.

```
블록 0       : 슈퍼블록
블록 1       : 디렉터리
블록 2       : 로그 헤더  (committed, n, blk[])
블록 3..18   : 로그 데이터 (한 트랜잭션 최대 16블록)
블록 19..    : 파일 데이터
```

## 2. 트랜잭션 구현

쓰기 API는 셋이에요 — `log_begin` → `log_write`(여러 번) → `log_commit`.

`log_write`는 데이터를 **로그 영역에 먼저** 적고, 그 데이터가 갈 **목적지 블록 번호**를 기억해둬요.

```c
static void log_write(uint32 dst, const uint8 *data) {
    virtio_disk_rw(LOGSTART + log_n, data, 1);  // 로그에 먼저 기록
    log_blk[log_n] = dst;                        // 목적지를 기억
    log_n++;
}
```

`log_commit`이 핵심이에요.
**커밋 표시를 찍는 순간**이 "이제부터는 되돌릴 수 없다"는 분기점이에요.

```c
static void log_commit(void) {
    write_loghdr(1, log_n, log_blk);   // (1) committed=1 → 원자적 커밋 포인트
    log_install(log_n, log_blk);       // (2) 로그 → 제자리에 설치
    write_loghdr(0, 0, 0);             // (3) 로그 비움
}
```

파일 생성은 이제 **데이터·디렉터리·슈퍼블록을 한 트랜잭션으로** 묶어요.
이 셋은 "전부 함께" 반영돼야 의미가 있으니까요.

```c
log_begin();
for (블록마다)  log_write(start + b, 데이터);   // 데이터 블록들
log_write(DIRBLOCK, 디렉터리이미지);             // 디렉터리
log_write(0,        슈퍼블록이미지);             // 슈퍼블록
log_commit();                                    // 셋을 원자적으로 설치
```

## 3. 복구 — 재부팅 때 마무리

크래시가 커밋 후에 났다면, 디스크엔 `committed=1`인 로그가 남아 있어요.
마운트할 때 이걸 보고 설치를 **다시** 끝내요.

```c
static void recover(void) {
    로그_헤더_읽기();
    if (!committed) return;          // 커밋 안 됨 → 무시(없던 일)
    log_install(n, blk);             // 커밋됨 → 설치 마저 완료
    write_loghdr(0, 0, 0);           // 로그 비움
    uart_puts("[fs] recovered a committed log transaction\n");
}
```

여기서 중요한 성질은 **멱등성(idempotency)** 이에요.
설치를 여러 번 반복해도 결과가 같아요(같은 데이터를 같은 자리에 또 쓸 뿐).
그래서 "설치 도중에 또 죽어도" 다음 부팅에 또 설치하면 되니까, 복구 자체가 크래시에 안전해요.

## 4. 삭제와 블록 재사용

기존 FS는 블록을 **앞으로만** 할당했어요(`next_free`가 증가만).
삭제가 없으니 지운 자리를 재사용할 방법도 없었죠.

해법은 **빈 블록 비트맵**이에요.
그런데 비트맵을 디스크에 또 두면 그것도 트랜잭션으로 관리해야 해서 복잡해져요.
다행히 우리 **디렉터리 자체가 할당 정보**예요(각 파일이 `start`, `size`를 가지니까).
그래서 비트맵을 디스크에 두지 않고, **마운트할 때 디렉터리를 훑어 메모리에서 재구성**해요.

```c
static void build_bitmap(void) {
    // 메타데이터(슈퍼블록/디렉터리/로그)와 각 파일의 블록을 '사용중'으로 표시
    used[0] = used[DIRBLOCK] = used[LOGHDR] = 1;
    for (로그 블록)  used[...] = 1;
    for (파일마다)   for (그 파일의 블록마다) used[...] = 1;
}
```

이제 `rm`은 파일의 블록을 비트맵에서 지우고(`used[...] = 0`), 디렉터리에서 항목을 빼는 트랜잭션을 돌려요.
지운 블록은 다음 `write`가 **first-fit으로 재사용**해요.

## 5. 눈으로 확인하기

셸에서 만들고, 보고, 지워봤어요.

```
$ write hi.txt journaled-write-works
$ ls
  ... hi.txt  (21 bytes)
$ cat hi.txt
journaled-write-works
$ rm hi.txt
$ ls
  (hi.txt 사라짐)
```

그리고 **재부팅**해도 살아남아요.
한 번 부팅에서 파일을 쓰고, 같은 디스크로 다시 부팅하면 그대로 있어요.

```
RUN 1: [ok] filesystem mounted (journaled): 6 files   → write persist.txt
RUN 2: [ok] filesystem mounted (journaled): 7 files   → persist.txt 그대로!
```

커밋→설치가 디스크에 영속됐고, 마운트 복구도 깨끗하게(남은 로그 없음) 끝났다는 뜻이에요.

## 6. 되짚기 — 어디까지, 왜 거기까지

이 FS는 **연속 할당**이에요(한 파일 = 연속된 블록들).
그래서 큰 파일이나 조각난 디스크에선 약하고, **inode의 간접 블록**(파일을 흩어진 블록들로 표현)은 일부러 안 만들었어요.

이유는 학습 목표예요.
이번 글의 주제는 **"여러 번의 쓰기를 어떻게 원자적으로 만드나"** 였고, 그건 연속 할당 위에서도 완전히 보여줄 수 있어요.
간접 블록은 "큰 파일을 어떻게 표현하나"라는 다른 축의 문제라, 저널링의 본질을 흐리지 않으려고 분리했어요.

또 하나, 우리 로그는 **블록 단위 물리 로깅**이에요(바뀐 블록 통째를 로그에 둠).
실제 파일시스템(ext4 등)은 메타데이터만 로깅하거나 논리 로깅으로 로그를 줄이지만, 토이 커널에선 물리 로깅이 가장 단순하고 정확해요.
**"단순함 ↔ 효율"** 에서 또 단순함을 택한 거죠.

## 마치며

전원이 언제 나가도 디스크가 깨지지 않는다 — 당연해 보이는 이 성질이, 사실은 "먼저 로그에, 나중에 제자리에"라는 한 줄 규칙에서 나와요.
데이터베이스의 WAL, 파일시스템의 저널, 둘 다 같은 아이디어예요.
크래시 일관성이라는 추상적인 말이, 로그 영역 몇 블록과 커밋 비트 하나로 손에 잡히는 게 이번 작업의 수확이었어요.

> 코드: [github.com/dj258255/hobby-kernel](https://github.com/dj258255/hobby-kernel)

### 참고 자료

- [xv6: a simple, Unix-like teaching operating system (MIT 6.S081)](https://pdos.csail.mit.edu/6.828/2023/xv6.html) — logging
- 관련 글: [트랜잭션 ACID ④ 지속성](/blog/theory/transaction-acid-04-durability) · [쓰기 가능 파일시스템](/blog/hobby/hobby-kernel-04-paging-mmap-writable-fs)

<!-- EN -->

## Introduction

The [filesystem from Part 3](/blog/hobby/hobby-kernel-02-fork-elf-filesystem) and the [writes added in Part 5](/blog/hobby/hobby-kernel-04-paging-mmap-writable-fs) had a hidden danger.
Creating a single file writes to disk **several times** — data blocks, the directory, the superblock.

But what if the power dies in between?

If the data was written but the directory wasn't, those blocks become ghosts — "written but unknown to anyone."
If the directory was written but the superblock (free-block location) wasn't, the next file overwrites the same blocks.
**Dying in the middle of several writes corrupts the filesystem.**

This post is about the classic technique that prevents this — **journaling**.
And it grows the read-mostly FS into a real read-write one by adding **delete (`rm`) and free-block reuse**.

## 1. The core idea — log first, install later

The idea of journaling is exactly a database transaction (the same principle as the [transaction ACID post](/blog/theory/transaction-acid-04-durability)).
You **don't write changes in place.**
Instead, you do this.

1. Gather the blocks you'll change into a **log region** first (the in-place blocks untouched).
2. Mark the log header **"committed"** — this is the atomic branch point.
3. Only then **install** the logged blocks into their real places.
4. Once installed, clear the log.

This way, dying at any point is safe.

- Die **before** the commit? The log is incomplete and the real blocks were never touched, so it's simply **as if nothing happened**.
- Die **after** the commit? On reboot, see the log and **finish the install** (replay).

So it's **all-or-nothing** — there's no half-written state.
That's atomicity, and it's the heart of filesystem consistency.

I put a log region into the disk layout.

```
block 0       : superblock
block 1       : directory
block 2       : log header   (committed, n, blk[])
block 3..18   : log data      (up to 16 blocks per transaction)
block 19..    : file data
```

## 2. Implementing the transaction

The write API is three calls — `log_begin` → `log_write` (many times) → `log_commit`.

`log_write` writes the data to the **log region first**, and remembers the **destination block** that data is bound for.

```c
static void log_write(uint32 dst, const uint8 *data) {
    virtio_disk_rw(LOGSTART + log_n, data, 1);  // write to the log first
    log_blk[log_n] = dst;                        // remember the destination
    log_n++;
}
```

`log_commit` is the crux.
**The moment the commit mark is written** is the branch point of "from here, there's no going back."

```c
static void log_commit(void) {
    write_loghdr(1, log_n, log_blk);   // (1) committed=1 → the atomic commit point
    log_install(log_n, log_blk);       // (2) log → install in place
    write_loghdr(0, 0, 0);             // (3) clear the log
}
```

File creation now bundles **data, directory, and superblock into one transaction**.
The three only make sense if they're reflected "all together."

```c
log_begin();
for (each block)  log_write(start + b, data);   // data blocks
log_write(DIRBLOCK, directory_image);            // directory
log_write(0,        superblock_image);           // superblock
log_commit();                                    // install the three atomically
```

## 3. Recovery — finishing up on reboot

If a crash happened after commit, a log with `committed=1` is left on disk.
On mount, we see it and **finish** the install again.

```c
static void recover(void) {
    read_log_header();
    if (!committed) return;          // not committed → ignore (never happened)
    log_install(n, blk);             // committed → complete the install
    write_loghdr(0, 0, 0);           // clear the log
    uart_puts("[fs] recovered a committed log transaction\n");
}
```

The important property here is **idempotency**.
Repeating the install any number of times gives the same result (it just writes the same data to the same place).
So even if it "dies during the install again," the next boot just installs again — recovery itself is crash-safe.

## 4. Delete and block reuse

The old FS allocated blocks **forward only** (`next_free` only grew).
With no delete, there was no way to reuse freed spots either.

The solution is a **free-block bitmap**.
But putting the bitmap on disk too would mean managing it with transactions as well, which gets complicated.
Luckily our **directory itself is the allocation info** (each file has a `start` and `size`).
So instead of keeping the bitmap on disk, we **rebuild it in memory by scanning the directory at mount**.

```c
static void build_bitmap(void) {
    // mark metadata (superblock/directory/log) and each file's blocks as used
    used[0] = used[DIRBLOCK] = used[LOGHDR] = 1;
    for (log blocks)  used[...] = 1;
    for (each file)   for (each of its blocks) used[...] = 1;
}
```

Now `rm` runs a transaction that clears the file's blocks from the bitmap (`used[...] = 0`) and removes the directory entry.
Freed blocks are **reused first-fit** by the next `write`.

## 5. Seeing it with your own eyes

I created, listed, and deleted from the shell.

```
$ write hi.txt journaled-write-works
$ ls
  ... hi.txt  (21 bytes)
$ cat hi.txt
journaled-write-works
$ rm hi.txt
$ ls
  (hi.txt is gone)
```

And it survives a **reboot**.
Write a file in one boot, boot again with the same disk, and it's still there.

```
RUN 1: [ok] filesystem mounted (journaled): 6 files   → write persist.txt
RUN 2: [ok] filesystem mounted (journaled): 7 files   → persist.txt still there!
```

That means the commit→install persisted to disk, and mount recovery finished cleanly (no log left over).

## 6. Looking back — how far, and why there

This FS uses **contiguous allocation** (one file = consecutive blocks).
So it's weak for large files or a fragmented disk, and I deliberately didn't build **inode indirect blocks** (representing a file as scattered blocks).

The reason is the learning goal.
This post's theme was **"how do you make several writes atomic,"** and that can be shown completely on top of contiguous allocation.
Indirect blocks are a different axis — "how do you represent a large file" — so I separated them to keep the essence of journaling clear.

One more thing: our log is **physical, block-level logging** (the whole changed block goes into the log).
Real filesystems (ext4 etc.) log only metadata or use logical logging to shrink the log, but in a toy kernel physical logging is the simplest and most correct.
Between **"simplicity ↔ efficiency"** I again chose simplicity.

## Closing

The disk never corrupts no matter when the power dies — this seemingly obvious property actually comes from one rule: "log first, install later."
A database's WAL and a filesystem's journal are the same idea.
Watching the abstract phrase "crash consistency" become tangible — a few log blocks and a single commit bit — was the reward of this work.

> Code: [github.com/dj258255/hobby-kernel](https://github.com/dj258255/hobby-kernel)

### References

- [xv6: a simple, Unix-like teaching operating system (MIT 6.S081)](https://pdos.csail.mit.edu/6.828/2023/xv6.html) — logging
- Related: [Transaction ACID ④ Durability](/blog/theory/transaction-acid-04-durability) · [Writable filesystem](/blog/hobby/hobby-kernel-04-paging-mmap-writable-fs)

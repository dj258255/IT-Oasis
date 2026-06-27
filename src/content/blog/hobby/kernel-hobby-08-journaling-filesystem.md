---
title: '저널링 파일시스템 — 절반만 쓰이지 않게'
titleEn: 'A Journaling Filesystem — Never Half-Written'
description: 쓰기 도중 전원이 나가면 파일시스템은 어떻게 될까. 데이터는 썼는데 디렉터리는 못 썼다면 디스크가 깨진다. 저널링(write-ahead log)은 이걸 막는다 — 변경을 제자리에 바로 쓰지 않고 먼저 로그에 모은 뒤, 커밋 표시를 찍고, 그제서야 설치한다. 크래시가 나도 "전부 반영" 또는 "전혀 반영 안 됨" 둘 중 하나라 디스크는 항상 일관적이다. 여기에 삭제(rm)와 빈 블록 재사용까지 더해 읽기 전용이던 FS를 진짜 읽기-쓰기로 키운다.
descriptionEn: "What happens to a filesystem if the power dies mid-write? If the data was written but the directory wasn't, the disk is corrupt. Journaling (a write-ahead log) prevents this — changes aren't written in place but gathered in a log first, marked committed, and only then installed. Even on a crash it's all-or-nothing, so the disk is always consistent. Adding delete (rm) and free-block reuse turns a read-only FS into a real read-write one."
date: 2026-06-16T00:00:00.000Z
tags:
  - OS
  - C
  - Kernel
  - RISC-V
  - xv6
  - QEMU
  - Filesystem
category: project/kernel-hobby
coverImage: "/uploads/hobby/kernel-hobby-c/cover.svg"
draft: false
series: "C로 만드는 토이 커널"
seriesOrder: 9
---


*바닥부터 직접 만드는 RISC-V 토이 커널 연재. 이 글은 9편 — 저널링 파일시스템(write-ahead log, 크래시 일관성).*

## 0. 들어가며

[3편에서 만든 파일시스템](/blog/hobby/kernel-hobby-02-fork-elf-filesystem)과 [5편에서 더한 쓰기](/blog/hobby/kernel-hobby-04-paging-mmap-writable-fs)에는 숨은 위험이 있었어요.
파일 하나를 만들 때 우리는 디스크에 **여러 번** 씁니다 — 데이터 블록들, 디렉터리, 슈퍼블록.
이 셋은 "전부 함께" 반영돼야 의미가 있는데, 디스크 쓰기는 한 블록씩 따로 일어나요.
그 사이에 전원이 나가면 파일시스템이 **절반만 쓰인** 상태로 깨집니다.

이건 데이터베이스가 트랜잭션으로 푸는 문제와 **원자성(atomicity) 측면에서 같은 문제**예요(DB는 격리·동시성까지 다루지만, 그중 "전부 아니면 전무"라는 원자성만큼은 똑같아요).
DB가 `UPDATE` 두 개를 "전부 아니면 전무"로 묶는 것과, 파일시스템이 데이터+디렉터리+슈퍼블록을 묶는 것은 같은 원자성(atomicity) 요구입니다.
그래서 해법도 같아요 — **WAL(write-ahead log)**, 파일시스템 용어로는 **저널링(journaling)**.
이 글에선 [트랜잭션 ACID ①](/blog/theory/transaction-acid-01-atomicity)에서 본 WAL 아이디어를 **토이 커널의 실제 코드**(`src/fs.c`)로 손에 잡히게 구현합니다.

그리고 읽기 위주였던 FS에 **삭제(`rm`)와 빈 블록 재사용**을 더해 진짜 읽기-쓰기 파일시스템으로 키워요.
순서대로 가봅시다 — 문제 → 로그 레이아웃 → 트랜잭션 3종 API → 마운트 복구 → 삭제·비트맵 → 재부팅으로 눈으로 확인.

> 이 커널의 참고서는 [xv6(MIT 6.S081)](https://pdos.csail.mit.edu/6.828/2023/xv6.html)이고, 저널링은 xv6의 `log.c`에 1:1로 대응해요. 다만 우리 FS는 inode·간접 블록 없이 **연속 할당**이라 로그도 더 단순합니다. 그 단순함이 오히려 "WAL의 본질"을 더 또렷이 보여줘요.

## 1. 저널링이 풀어야 하는 진짜 문제

> 파일 하나를 만드는 데 디스크 쓰기가 여러 번 일어난다. 그 도중에 전원이 나가면, "절반만 쓰인" 상태를 어떻게 막을까?

말은 단순한데 구현은 까다로워요.
우리 FS에서 `write hi.txt ...` 한 줄이 디스크에 일으키는 쓰기를 풀어보면 이래요.

```
1) 데이터 블록(들)   ← 파일 내용
2) 디렉터리 블록      ← "hi.txt는 블록 19부터 21바이트" 라는 항목
3) 슈퍼블록          ← next_free(다음 빈 블록) 갱신
```

이 셋이 **한 번에** 디스크에 박히지 않는다는 게 핵심이에요.
한 블록을 쓰고 다음 블록을 쓰는 사이에는 항상 틈이 있고, 그 틈에서 전원이 나갈 수 있습니다.
어디서 죽느냐에 따라 디스크가 이렇게 깨져요.

- **데이터는 썼는데 디렉터리는 못 썼다면**: 그 블록은 "쓰였지만 아무도 모르는" 유령이 돼요. 디렉터리에 항목이 없으니 영영 못 찾고, 그렇다고 빈 블록으로 잡히지도 않습니다.
- **디렉터리는 썼는데 슈퍼블록은 못 썼다면**: 디렉터리는 "블록 19를 hi.txt가 쓴다"는데, 슈퍼블록의 `next_free`는 여전히 19를 가리켜요. 다음 파일이 **같은 블록 19를 덮어씁니다.** 두 파일이 한 블록을 공유하는 손상이에요.

DB의 [Atomicity 글](/blog/theory/transaction-acid-01-atomicity)에서 봤던 그 시나리오와 똑같죠 — "부분 성공의 흔적을 어떻게 지울 것인가."
파일시스템이 보장해야 하는 건 결국 하나예요.

> **여러 번의 쓰기가 "전부 반영" 또는 "전혀 반영 안 됨" 둘 중 하나로만 끝나야 한다.** 절반만 쓰인 중간 상태가 디스크에 영구히 남으면 안 된다.

이게 크래시 일관성(crash consistency)이고, 저널링이 푸는 진짜 문제예요.

## 2. 사전 지식 — 왜 "먼저 로그에, 나중에 제자리에"인가

### 제자리에 바로 쓰기 vs 로그 먼저(WAL)

> 변경을 데이터의 진짜 위치에 곧장 쓰면 안 되는 이유가 뭘까?

가장 순진한 방법은 **제자리에 직접 쓰기(in-place)** 예요 — 데이터 블록, 디렉터리, 슈퍼블록을 차례로 진짜 위치에 덮어쓰는 거죠.
문제는 1절에서 봤듯, 이게 **여러 번의 독립적 쓰기**라서 중간에 죽으면 복구할 단서가 없다는 거예요.
디렉터리만 새 값, 슈퍼블록은 옛 값 — 어느 게 맞는지 디스크만 봐선 알 수 없어요.

WAL의 발상은 한 줄이에요 — **진짜 위치를 건드리기 전에, 바꿀 내용 전부를 별도의 로그 영역에 먼저 적는다.**
그리고 "이제 다 모았다"는 **커밋 표시**를 원자적으로 찍은 다음, 그제서야 로그의 내용을 진짜 위치로 옮겨요(install).

| 구분 | 제자리 직접 쓰기(in-place) | 로그 먼저(WAL / 저널링) |
|------|--------------------------|------------------------|
| 변경을 어디에 먼저 쓰나 | 데이터의 진짜 위치에 곧장 | 별도 로그 영역에 먼저 모음 |
| 원자적 분기점 | 없음 (쓰기마다 따로) | 커밋 비트 하나 (한 블록 쓰기) |
| 중간에 죽으면 | 절반만 쓰임 → 복구 단서 없음 | 커밋 전=무시 / 커밋 후=replay |
| 디스크 쓰기 횟수 | N번 | 대략 두 배 (로그 N + 제자리 N + 헤더 2) |
| 크래시 일관성 | 보장 못 함 | 보장됨 (전부 또는 전무) |

핵심은 **커밋 비트 하나**예요.
이 글은 **"블록 하나의 쓰기는 원자적"이라는 저장장치 모델을 가정**해요(섹터 단위 쓰기는 안 깨진다고 봄 — 실제론 write cache·flush 순서·FUA·전원보호 같은 전제가 더 필요해요). WAL은 그 가정 위에서 **여러 블록 쓰기를 원자적으로 보이게** 만드는 기법이에요.
그 원자적인 한 블록 쓰기에 "이 트랜잭션은 완성됐다"는 신호를 담으면, 그 한 줄이 **전부/전무를 가르는 분기점**이 됩니다.
커밋 비트가 0인 채로 죽으면 → 없던 일. 1로 박힌 뒤 죽으면 → 마저 끝내면 됨.

> **흔한 오해 정정 — "로그를 쓰면 두 번 쓰니 느리지 않나?"**: 맞아요, 같은 데이터를 로그에 한 번, 제자리에 한 번, 총 두 번 써요. 그런데 그 대가로 얻는 건 *"디스크가 절대 깨지지 않는다"* 는 보장이에요. 게다가 실제 파일시스템은 메타데이터만 로깅하거나(데이터는 한 번만), 로그 쓰기를 모아서(group commit) 순차 I/O로 만들어 비용을 줄여요. 우리 토이 커널은 그 최적화 없이 **물리 로깅으로 정확함만** 택했습니다 — 단순함 ↔ 효율에서 또 단순함이에요.

### 디스크 레이아웃 — 로그 영역을 끼워 넣는다

이걸 구현하려면 디스크에 **로그를 둘 자리**가 필요해요.
[3편/5편](/blog/hobby/kernel-hobby-04-paging-mmap-writable-fs)의 레이아웃에 블록 몇 개를 추가했습니다(`src/fsformat.h`).

```
블록 0            : 슈퍼블록   (magic, nfiles, next_free, total_blocks)
블록 1            : 디렉터리   (fs_dirent 8개)
블록 2            : 로그 헤더   (committed, n, blk[16])   ← 저널링
블록 3..18        : 로그 데이터 (한 트랜잭션 최대 16블록 = LOGN)
블록 19(DATASTART)..: 파일 데이터 (각 파일 = start부터 연속된 블록들)
```

`src/fsformat.h`의 실제 정의예요.

```c
#define LOGHDR     2            // 로그 헤더 블록
#define LOGSTART   3            // 로그 데이터 블록 시작
#define LOGN       16           // 로그 데이터 블록 수(한 트랜잭션 최대 16블록)
#define DATASTART  (LOGSTART + LOGN)  // 파일 데이터 시작(= 19)

// 로그 헤더: 커밋된 트랜잭션이 어느 블록들을 바꾸는지 기록한다.
//   committed=1 이면 로그 데이터 블록 i를 blk[i]로 설치해야 한다(복구 시 replay).
struct fs_loghdr {
    unsigned int committed;     // 1=커밋됨(설치 대기), 0=비어 있음
    unsigned int n;             // 로그된 블록 수
    unsigned int blk[LOGN];     // 각 로그 블록의 목적지 블록 번호
};
```

`fs_loghdr` 한 구조체가 저널링의 전부예요.
`committed`가 아까 말한 **그 커밋 비트**, `blk[i]`가 "로그 데이터 블록 i는 진짜로는 어디로 가야 하나"를 적은 **목적지 표**입니다.
이 헤더 한 블록(블록 2)을 쓰는 게 원자적이라, 거기에 커밋을 담는 거예요.

## 3. 트랜잭션 구현 — log_begin → log_write → log_commit

쓰기 API는 셋이에요 — `log_begin`(시작) → `log_write`(여러 번) → `log_commit`(원자적 마무리).
[ACID 글의 `BEGIN ... COMMIT`](/blog/theory/transaction-acid-01-atomicity)과 모양이 똑같죠.

### log_write — 제자리가 아니라 로그에 먼저

`log_write`는 데이터를 **로그 영역에 먼저** 적고, 그 데이터가 갈 **목적지 블록 번호**를 메모리에 기억해둬요.
아직 진짜 위치(`dst`)는 손도 안 댑니다.

```c
// 진행 중 트랜잭션의 목적지 블록들(메모리). log_write가 채우고 log_commit이 설치.
static uint32 log_blk[LOGN];
static int    log_n;

static void log_begin(void) { log_n = 0; }

// 목적지 dst로 갈 데이터를 로그 데이터 블록에 먼저 적어둔다(아직 제자리엔 안 씀).
static void log_write(uint32 dst, const uint8 *data) {
    if (log_n >= LOGN) return;                  // 트랜잭션이 로그보다 크면 무시(상한)
    for (int j = 0; j < BSIZE; j++) fsbuf[j] = data[j];
    virtio_disk_rw(LOGSTART + log_n, fsbuf, 1); // 로그에 기록
    log_blk[log_n] = dst;                        // 목적지를 기억
    log_n++;
}
```

`log_n`번째 `log_write`는 데이터를 디스크 블록 `LOGSTART + log_n`(로그 영역)에 쓰고, `log_blk[log_n] = dst`로 "이건 나중에 `dst`로 가야 해"를 적어둬요.

> **상한 처리**: 로그(16블록)보다 큰 트랜잭션은 *부분만* 커밋하면 디스크가 깨져요. 그래서 `fs_create`가 **트랜잭션을 시작하기 전에 크기를 검사해 `-1`로 거부**하고(메모리도 안 건드려 롤백이 필요 없음), 그 `-1`이 셸까지 올라가 `write: failed`로 표시돼요. 만에 하나 그 검사를 지나치더라도, `log_commit`이 오버플로 트랜잭션을 **통째로 abort**(부분 커밋 방지)하는 2차 방어선을 둡니다.
이 시점에 죽어도 안전해요 — 진짜 위치는 아직 옛 값 그대로니까요.

### log_commit — 커밋 비트를 찍는 그 한 순간

`log_commit`이 핵심이에요. 세 단계로 움직입니다.

```c
// 커밋: (1) 헤더에 committed=1 기록 → 원자적 커밋 포인트, (2) 설치, (3) 헤더 비움.
static void log_commit(void) {
    if (log_n == 0) return;
    write_loghdr(1, log_n, log_blk);   // (1) 커밋(이 순간 이후엔 크래시 나도 복구가 완성)
    log_install(log_n, log_blk);       // (2) 로그 → 제자리에 설치
    write_loghdr(0, 0, 0);             // (3) 로그 비움(설치 끝)
    log_n = 0;
}
```

**(1) `write_loghdr(1, ...)` 이 한 줄이 원자적 분기점이에요.**
`committed=1`과 목적지 표 `blk[]`를 로그 헤더(블록 2)에 한 번에 씁니다.
이 블록 쓰기가 디스크에 박히는 순간 — 그 직전까지는 "없던 일"이고, 그 직후부터는 "반드시 완성될 일"이 돼요.
ACID 글에서 *"커밋 보장은 WAL의 fsync로 결정된다"* 던 그 지점이 여기예요.

**(2) `log_install`은 로그의 블록들을 각자의 목적지로 복사**해요. `fsbuf`는 임시 버퍼 하나라, 매 반복마다 로그 블록 하나를 **읽어 `fsbuf`에 담고 곧바로 목적지에 써요**(읽기 → 덮어쓰기 → 쓰기의 반복이지, 첫 블록만 계속 쓰는 게 아니에요).

```c
// 로그 데이터 블록들을 각자의 목적지로 복사(install).
static void log_install(int n, const uint32 *blks) {
    for (int i = 0; i < n; i++) {
        virtio_disk_rw(LOGSTART + i, fsbuf, 0);  // 로그에서 읽어
        virtio_disk_rw(blks[i], fsbuf, 1);       // 제자리에 쓴다
    }
}
```

**(3)** 설치가 다 끝나면 `write_loghdr(0,0,0)`으로 헤더를 비워요 — `committed=0`. "이 트랜잭션은 처리 완료, 더 할 일 없음."

### fs_create — 데이터·디렉터리·슈퍼블록을 한 트랜잭션으로

이제 파일 생성은 1절에서 본 세 쓰기를 **한 트랜잭션으로 묶어요.**
`src/fs.c`의 `fs_create`예요(요지만).

```c
int fs_create(const char *name, const char *data, int size) {
    // ... 중복 검사, 공간 확보(balloc_contig) ...
    log_begin();
    // 1) 데이터 블록들 → 로그
    for (int b = 0; b < nblocks; b++) {
        /* tmp ← data의 b번째 블록(나머지는 0 패딩) */
        log_write((uint32)(start + b), tmp);
    }
    // 2) 디렉터리 항목 추가(메모리) + 비트맵 갱신
    /* dir[slot] = {name, size, start}; nfiles++; used[...] = 1; */
    // 3) 메타데이터 → 로그, 커밋
    log_dir();      // 디렉터리 블록 이미지 → 로그(목적지 DIRBLOCK)
    log_super();    // 슈퍼블록 이미지   → 로그(목적지 0)
    log_commit();   // 셋을 원자적으로 설치
    return 0;
}
```

`log_dir`/`log_super`는 메모리의 디렉터리·슈퍼블록을 블록 이미지로 만들어 로그에 넣는 헬퍼예요.

```c
// 디렉터리 블록 이미지를 트랜잭션 로그에 추가.
static void log_dir(void) {
    uint8 *db = (uint8 *)dir;
    uint8 tmp[BSIZE];
    for (int j = 0; j < BSIZE; j++) tmp[j] = (j < (int)sizeof(dir)) ? db[j] : 0;
    log_write(DIRBLOCK, tmp);                 // 목적지 = 디렉터리 블록(1)
}
```

결과적으로 한 트랜잭션 안에 데이터 블록들 + 디렉터리(목적지 1) + 슈퍼블록(목적지 0)이 전부 로그에 모이고, `log_commit`의 커밋 비트 하나로 **셋이 동시에** 진짜가 돼요.
중간에 죽어도 "데이터만, 디렉터리 없이" 같은 반쪽 상태는 절대 디스크에 남지 않습니다.

## 4. 복구 — 재부팅 때 마무리하기(replay)

> 커밋 비트를 찍은 직후(`committed=1`), 아직 install이 다 끝나기 전에 죽으면? 디스크엔 "커밋됐지만 설치 안 된" 로그가 남는다. 다음 부팅이 이걸 어떻게 처리할까?

이게 WAL의 **redo**, 파일시스템 용어로 **replay**예요.
마운트할 때 로그 헤더를 보고, `committed=1`이면 설치를 **다시** 끝내요.

```c
// 마운트 시 복구: 커밋만 되고(=committed=1) 설치가 끝나지 않은 트랜잭션을 replay.
static void recover(void) {
    virtio_disk_rw(LOGHDR, fsbuf, 0);
    struct fs_loghdr *h = (struct fs_loghdr *)fsbuf;
    if (!h->committed) return;                          // 커밋 안 됨 → 무시(없던 일)
    uint32 n = h->n;
    if (n > LOGN) n = LOGN;
    uint32 blks[LOGN];
    for (uint32 i = 0; i < n; i++) blks[i] = h->blk[i];  // fsbuf 재사용 전에 추출
    log_install((int)n, blks);                          // 커밋됨 → 설치 마저 완료
    write_loghdr(0, 0, 0);                              // 로그 비움
    uart_puts("[fs] recovered a committed log transaction\n");
}
```

`recover()`는 `fs_init`(마운트)의 맨 앞에서 불려요. 두 경우로 갈립니다.

- **`committed`가 0**: 커밋 전에 죽었거나, 정상적으로 비워진 로그. → 그냥 무시. 진짜 위치는 옛 값 그대로니 *"없던 일"* 이에요.
- **`committed`가 1**: 커밋 후에 죽음. → `blk[]`를 따라 로그를 제자리에 설치하고 헤더를 비워요. 트랜잭션이 *"마저 완성"* 됩니다.

### 멱등성(idempotency) — 복구 자체도 크래시에 안전하다

여기서 가장 중요한 성질은 **멱등성**이에요.
`log_install`을 한 번 하든 열 번 하든 결과가 같아요 — *"같은 데이터를 같은 자리에 또 쓸 뿐"* 이니까요.
복구를 마치면 `write_loghdr(0,0,0)`으로 헤더를 비우는데, 이게 중요해요 — 안 그러면 `committed=1`이 남아 **부팅할 때마다 같은 트랜잭션을 또 replay**하거든요.

그래서 **"복구 도중에 또 죽어도"** 안전해요.
설치를 절반 하다 죽으면? 헤더는 아직 `committed=1`이니, 다음 부팅이 또 `recover()`를 돌려 처음부터 다시 설치합니다.
이미 설치된 블록은 같은 값으로 또 덮어쓰일 뿐, 손상되지 않아요.
ACID 글의 **Redo phase**가 멱등이라 몇 번이고 재시작할 수 있던 것과 똑같은 원리예요.

우리 로그는 **redo-only**예요 — 커밋 안 된 변경은 애초에 제자리에 안 쓰고 로그에만 모으니, 되돌릴(undo) 게 없거든요. (ARIES가 undo까지 두는 건 커밋 전 더티 페이지를 제자리에 미리 쓰는 STEAL 정책 때문인데, 우리는 그렇게 안 합니다.)

> **흔한 오해 정정 — "fsync 한 번이면 원자성 끝 아닌가?"**: `fsync`(디스크에 강제로 쓰기)는 *"이 한 블록이 디스크에 확실히 박혔다"* 만 보장하지, *"여러 블록이 함께/전혀"* 는 보장 못 해요. 원자성은 **여러 쓰기를 묶는 프로토콜**(로그에 모으고 → 커밋 비트 → 설치)에서 나오지, 개별 쓰기의 내구성 하나로는 안 나옵니다. 우리 코드에서 그 프로토콜을 떠받치는 단 하나의 원자적 단위가 "로그 헤더 한 블록 쓰기"예요.

## 5. 삭제와 빈 블록 재사용 — 비트맵을 디스크 밖에 두기

저널링으로 안전한 쓰기가 생겼으니, 이제 **삭제(`rm`)** 를 더해 진짜 읽기-쓰기 FS로 만들어요.

### 빈 블록을 어떻게 추적할까

> 파일을 지우면 그 블록은 다시 비어야 한다. 그런데 "어느 블록이 비었는지"를 어떻게 기억할까?

기존 FS는 블록을 **앞으로만** 할당했어요(`next_free`가 증가만).
삭제가 없으니 지운 자리를 재사용할 방법도 없었죠.
표준 해법은 **빈 블록 비트맵**(블록마다 사용중/빈 1비트)이에요.
그런데 비트맵을 **디스크에** 두면, 그것도 바뀔 때마다 트랜잭션으로 보호해야 해서 로그가 더 복잡해져요.

다행히 우리 FS엔 영리한 지름길이 있어요 — **디렉터리 자체가 이미 할당 정보**거든요.
슈퍼블록의 `nfiles`와 디렉터리를 함께 읽으면, 각 파일의 `start`(시작 블록)·`size`(크기)로 "어느 블록이 어느 파일 거"인지 다 계산할 수 있어요.
그래서 비트맵을 디스크에 영구 저장하지 않고, **마운트할 때 디렉터리를 훑어 메모리에서 재구성**합니다.

| 구분 | 비트맵을 디스크에 저장 | 디렉터리에서 메모리 재구성(우리 방식) |
|------|----------------------|--------------------------------------|
| 디스크 공간 | 비트맵 블록 추가 필요 | 0 (디렉터리 재사용) |
| 트랜잭션 부담 | 비트맵도 매번 로깅해야 | 없음 (메모리에만 존재) |
| 진실의 원천(source of truth) | 비트맵과 디렉터리 둘 (불일치 위험) | 디렉터리 하나뿐 |
| 비용 | 적음 | 마운트 때 O(파일 수) 스캔 |

진실의 원천이 **디렉터리 하나**라는 게 큰 장점이에요 — **디스크엔 디렉터리만** 저장되니, 영속 상태에서 두 메타데이터가 어긋날 일이 없어요(메모리 비트맵은 재구성 전까지 디렉터리와 다를 수 있지만, *디스크에는 진실이 하나뿐*이라는 뜻이에요 — ACID 글의 *"진실의 원천이 갈리면 일관성 위반"* 과 같은 맥락).

### build_bitmap — 마운트 때 메모리에서 재구성

```c
static void build_bitmap(void) {
    for (uint32 i = 0; i < MAXBLK; i++) used[i] = 0;
    used[0] = used[DIRBLOCK] = used[LOGHDR] = 1;           // 메타데이터 블록(슈퍼/디렉터리/로그헤더)
    for (int i = 0; i < LOGN; i++) used[LOGSTART + i] = 1; // 로그 영역
    for (int f = 0; f < nfiles; f++) {                     // 각 파일의 데이터 블록
        int nb = (dir[f].size + BSIZE - 1) / BSIZE;
        for (int k = 0; k < nb; k++) {
            uint32 b = dir[f].start + k;
            if (b < MAXBLK) used[b] = 1;
        }
    }
}
```

메타데이터(블록 0/1/2)와 로그 영역(블록 3..18)을 먼저 "사용중"으로 박고, 그다음 디렉터리의 각 파일이 차지하는 블록을 표시해요.
남은 0들이 곧 빈 블록이에요.
새 파일을 만들 땐 `balloc_contig`가 이 비트맵에서 연속된 빈 자리를 **first-fit**으로 찾아요(없으면 -1).

```c
// 연속 nblocks개의 빈 블록을 first-fit으로 찾는다. 없으면 -1.
static int balloc_contig(int nblocks) {
    if (nblocks == 0) return DATASTART;
    for (uint32 s = DATASTART; s + nblocks <= total_blocks && s + nblocks <= MAXBLK; s++) {
        int ok = 1;
        for (int k = 0; k < nblocks; k++)
            if (used[s + k]) { ok = 0; break; }
        if (ok) return (int)s;
    }
    return -1;
}
```

### fs_delete — 블록 해제도 한 트랜잭션으로

이제 `rm`은 파일의 블록을 비트맵에서 풀고(`used[...] = 0`), 디렉터리에서 항목을 빼는 트랜잭션을 돌려요.

```c
int fs_delete(const char *name) {
    // ... idx 찾기 ...
    int nblocks = (dir[idx].size + BSIZE - 1) / BSIZE;
    for (int b = 0; b < nblocks; b++) {            // 블록 해제(재사용 가능해짐)
        uint32 blk = dir[idx].start + b;
        if (blk < MAXBLK) used[blk] = 0;
    }
    for (int j = idx; j < nfiles - 1; j++)         // 디렉터리 배열 압축
        dir[j] = dir[j + 1];
    /* 마지막 슬롯 비우기; nfiles--; */

    log_begin();
    log_dir();       // 바뀐 디렉터리 → 로그
    log_super();     // 바뀐 슈퍼블록 → 로그
    log_commit();    // 원자적으로 설치
    return 0;
}
```

눈여겨볼 점 — 비트맵(`used[]`)은 **메모리에만** 갱신하고, 디스크엔 디렉터리·슈퍼블록만 트랜잭션으로 써요.
다음 부팅 때 `build_bitmap`이 새 디렉터리에서 비트맵을 다시 만들 거니까요.
지운 블록은 다음 `write`가 `balloc_contig`로 **재사용**합니다. 앞으로만 가던 할당이 드디어 자리를 되돌려 받아요.

## 6. 눈으로 확인하기 — 셸과 재부팅

셸에서 만들고, 보고, 지워봤어요.

```
$ write hi.txt journaled-write-works
$ ls
  hi.txt  (21 bytes)
$ cat hi.txt
journaled-write-works
$ rm hi.txt
$ ls
  (hi.txt 사라짐)
```

진짜 시험은 **재부팅**이에요.
한 번 부팅에서 파일을 쓰고, 같은 디스크 이미지로 다시 부팅하면 그대로 살아 있어야 해요 — 커밋→설치가 디스크에 영속됐다는 증거니까요.

```
RUN 1: [ok] filesystem mounted (journaled): 6 files   → write persist.txt
RUN 2: [ok] filesystem mounted (journaled): 7 files   → persist.txt 그대로!
```

`fs_init`(마운트)이 찍는 `[ok] ... mounted (journaled): N files`는 매 부팅 첫 줄이에요.
RUN 1에서 6개였다가 `write` 후 RUN 2에서 7개로 늘었고, **남은 로그가 없어** `[fs] recovered ...` 메시지는 안 떴어요 — 정상 종료(헤더 비움까지)였다는 뜻이에요.
만약 커밋 직후·설치 전에 죽였다면, RUN 2의 마운트에서 `recover()`가 `[fs] recovered a committed log transaction`을 찍고 그 트랜잭션을 마저 완성한 뒤 7개를 보여줬을 거예요.
어느 쪽이든 결과는 같아요 — **절반만 쓰인 상태는 없다.**

## 7. 되짚기 — 어디까지, 왜 거기까지

이 FS는 **연속 할당**이에요(한 파일 = 연속된 블록들).
그래서 큰 파일이나 조각난 디스크에선 약하고, **inode의 간접 블록**(파일을 흩어진 블록들로 표현)은 일부러 안 만들었어요.

이유는 학습 목표예요.
이번 글의 주제는 **"여러 번의 쓰기를 어떻게 원자적으로 만드나"** 였고, 그건 연속 할당 위에서도 완전히 보여줄 수 있어요.
간접 블록은 "큰 파일을 어떻게 표현하나"라는 다른 축의 문제라, 저널링의 본질을 흐리지 않으려고 분리했어요.

### 물리 로깅 vs 논리 로깅

또 하나, 우리 로그는 **블록 단위 물리 로깅**이에요(바뀐 블록 통째를 로그에 둠).

| 구분 | 물리 로깅(우리 방식) | 논리 로깅 |
|------|--------------------|----------|
| 로그에 담는 것 | 바뀐 블록 전체(512바이트) | "어떤 연산을 했나"(예: "블록 19에 hi.txt 추가") |
| 로그 크기 | 큼(블록마다 한 칸) | 작음(연산 기술만) |
| 복구의 복잡도 | 단순(블록을 그대로 복사) | 복잡(연산을 재실행, 멱등성 관리 필요) |
| 멱등성 | 자명(같은 블록 덮어쓰기) | 직접 보장해야 함 |

실제 파일시스템은 로그를 줄이려고 여러 최적화를 써요 — 예를 들어 ext4(JBD2)는 기본값에서 **메타데이터만**(데이터는 저널 안 함) 물리 저널링하고, 어떤 시스템은 변경을 "연산"으로 적는 논리 로깅을 쓰기도 하죠. 토이 커널에선 **블록 통째 물리 로깅이 가장 단순하고 정확**해서 그걸 택했어요.
블록을 통째로 베껴 두면 복구가 그냥 "복사"라 멱등성이 공짜로 따라와요(4절).
**"단순함 ↔ 효율"** 에서 또 단순함을 택한 거죠 — 이 연재의 일관된 선택이에요([1편의 free list](/blog/hobby/kernel-hobby-00-boot-to-paging)도 같은 정신).

## 정리

전원이 언제 나가도 디스크가 깨지지 않는다 — 당연해 보이는 이 성질이, 사실은 **"먼저 로그에, 나중에 제자리에"** 라는 한 줄 규칙에서 나와요.
이번 글의 골격을 한 화면으로 정리하면 이래요.

- **문제** — 파일 하나를 만드는 데 디스크 쓰기가 여러 번(데이터/디렉터리/슈퍼블록). 중간에 죽으면 절반만 쓰여 깨진다.
- **WAL** — 진짜 위치를 건드리기 전에 바꿀 내용을 로그 영역에 먼저 모으고(`log_write`), 로그 헤더에 **커밋 비트 하나**를 원자적으로 찍은 뒤(`write_loghdr(1,...)`), 그제서야 제자리에 설치(`log_install`).
- **복구** — 마운트 때 `recover()`가 헤더를 본다. `committed=0`이면 무시(없던 일), `1`이면 설치를 마저 끝낸다(replay). `log_install`이 **멱등**이라 복구 도중 또 죽어도 안전.
- **삭제·재사용** — 비트맵을 디스크에 두지 않고 `build_bitmap`이 마운트 때 디렉터리에서 재구성. `rm`은 메모리 비트맵을 풀고 디렉터리·슈퍼블록만 트랜잭션으로 쓴다. 지운 블록은 `balloc_contig`가 first-fit으로 재사용.

데이터베이스의 WAL([트랜잭션 ACID](/blog/theory/transaction-acid-01-atomicity))과 파일시스템의 저널은 **글자 그대로 같은 아이디어**예요 — 로그에 모으고, 커밋 포인트를 찍고, 멱등하게 재생.
크래시 일관성이라는 추상적인 말이, 로그 영역 16블록과 커밋 비트 하나로 손에 잡히는 게 이번 작업의 수확이었어요.
다음 글에서는 이 FS 위에서 더 큰 OS 조각으로 이어갑니다.

> 코드: [github.com/dj258255/kernel-hobby](https://github.com/dj258255/kernel-hobby)

## 참고 (1차 자료 우선)

- [xv6: a simple, Unix-like teaching operating system (MIT 6.S081)](https://pdos.csail.mit.edu/6.828/2023/xv6.html) — 이 커널의 참고서. `log.c`(logging)가 우리 `fs.c`의 저널링과 1:1로 대응
- ARIES: A Transaction Recovery Method (Mohan et al., 1992) — WAL·redo·멱등 복구의 1차 정의(파일시스템 저널의 이론적 뿌리)
- [PostgreSQL Documentation: Write-Ahead Logging (WAL)](https://www.postgresql.org/docs/current/wal-intro.html) — "로그 먼저, 데이터 나중"의 표준 서술
- 관련 글: [트랜잭션 ACID ① 원자성](/blog/theory/transaction-acid-01-atomicity) · [트랜잭션 ACID ④ 지속성](/blog/theory/transaction-acid-04-durability) · [쓰기 가능 파일시스템](/blog/hobby/kernel-hobby-04-paging-mmap-writable-fs)

<!-- EN -->

*A RISC-V toy kernel built from scratch — a blog series. This is Part 9: a journaling filesystem (write-ahead log, crash consistency).*

## 0. Introduction

The [filesystem from Part 3](/blog/hobby/kernel-hobby-02-fork-elf-filesystem) and the [writes added in Part 5](/blog/hobby/kernel-hobby-04-paging-mmap-writable-fs) had a hidden danger.
Creating a single file writes to disk **several times** — data blocks, the directory, the superblock.
The three only make sense if they land "all together," yet disk writes happen one block at a time.
If the power dies in between, the filesystem is left **half-written** and corrupt.

This is **the same problem databases solve with transactions, in terms of atomicity** (a DB also handles isolation and concurrency, but the "all-or-nothing" atomicity is identical).
A DB bundling two `UPDATE`s as "all-or-nothing" and a filesystem bundling data + directory + superblock are the same atomicity requirement.
So the solution is the same too — **WAL (write-ahead log)**, called **journaling** in filesystem terms.
This post implements the WAL idea from [Transaction ACID ①](/blog/theory/transaction-acid-01-atomicity) in **the toy kernel's actual code** (`src/fs.c`), making it tangible.

And it grows the read-mostly FS into a real read-write one by adding **delete (`rm`) and free-block reuse**.
Let's go in order — the problem → the log layout → the three-call transaction API → mount recovery → delete and the bitmap → seeing it survive a reboot.

> This kernel's reference is [xv6 (MIT 6.S081)](https://pdos.csail.mit.edu/6.828/2023/xv6.html), and the journaling maps 1:1 to xv6's `log.c`. But our FS uses **contiguous allocation** with no inodes or indirect blocks, so the log is even simpler — and that simplicity shows the "essence of WAL" all the more clearly.

## 1. The Real Problem Journaling Has to Solve

> Creating one file triggers several disk writes. If the power dies mid-way, how do you prevent a "half-written" state?

Simple to state, tricky to implement.
Unpacking what a single `write hi.txt ...` does to disk in our FS:

```
1) data block(s)    ← the file contents
2) directory block  ← the entry "hi.txt starts at block 19, 21 bytes"
3) superblock       ← update next_free (the next free block)
```

The crux is that these three do **not** land on disk at once.
Between writing one block and the next there's always a gap, and the power can die in that gap.
Depending on where it dies, the disk corrupts like this:

- **Data written, directory not**: those blocks become ghosts — "written but unknown to anyone." With no directory entry they're never found, yet they aren't marked free either.
- **Directory written, superblock not**: the directory says "hi.txt owns block 19," but the superblock's `next_free` still points at 19. The next file **overwrites the same block 19.** That's the corruption of two files sharing one block.

It's the same scenario as in the DB [Atomicity post](/blog/theory/transaction-acid-01-atomicity) — "how do you erase the traces of partial success?"
What the filesystem must guarantee boils down to one thing.

> **Several writes must end as either "all reflected" or "none reflected."** A half-written intermediate state must never persist on disk.

That's crash consistency, and it's the real problem journaling solves.

## 2. Background — Why "Log First, Install Later"

### Writing in place vs logging first (WAL)

> Why not just write changes straight to the data's real location?

The naive way is **in-place writing** — overwrite the data block, directory, and superblock at their real locations in turn.
The problem, as §1 showed, is that this is **several independent writes**, so dying in between leaves no clue to recover from.
Directory has the new value, superblock the old one — looking at the disk alone, you can't tell which is right.

The WAL idea is one line — **before touching the real location, write all the changes to a separate log region first.**
Then atomically stamp a **commit mark** ("everything's gathered now"), and only then move the log's contents to their real places (install).

| Aspect | In-place writing | Log first (WAL / journaling) |
|--------|------------------|------------------------------|
| Where changes go first | straight to the real location | gathered in a separate log region |
| Atomic branch point | none (each write separate) | one commit bit (one block write) |
| If it dies mid-way | half-written → no recovery clue | before commit = ignore / after = replay |
| Disk write count | N | roughly double (log N + in place N + header 2) |
| Crash consistency | not guaranteed | guaranteed (all or nothing) |

The key is **one commit bit**.
This post **assumes a storage model where "a single block write is atomic"** (a sector-sized write is never torn — in reality this also needs write-cache, flush ordering, FUA, power-loss protection). WAL is the technique that, on top of that assumption, makes **multi-block writes appear atomic.**
If that atomic single-block write carries the signal "this transaction is complete," that one line becomes the **branch point that splits all-or-nothing**.
Die with the commit bit at 0 → as if nothing happened. Die after it's stamped 1 → just finish the rest.

> **Common misconception fix — "writing the log means writing twice, isn't that slow?"**: Yes, the same data is written once to the log and once in place, twice total. But the price buys the guarantee that *"the disk never corrupts."* And real filesystems shrink the cost by logging only metadata (data written once) or batching log writes (group commit) into sequential I/O. Our toy kernel skips those optimizations and picks **physical logging for correctness only** — simplicity over efficiency, again.

### Disk layout — slotting in a log region

To implement this we need **a place on disk for the log**.
I added a few blocks to the [Part 3 / Part 5](/blog/hobby/kernel-hobby-04-paging-mmap-writable-fs) layout (`src/fsformat.h`).

```
block 0             : superblock   (magic, nfiles, next_free, total_blocks)
block 1             : directory    (8 fs_dirent)
block 2             : log header   (committed, n, blk[16])   ← journaling
block 3..18         : log data     (up to 16 blocks per transaction = LOGN)
block 19(DATASTART)..: file data   (each file = consecutive blocks from start)
```

The actual definitions from `src/fsformat.h`:

```c
#define LOGHDR     2            // the log header block
#define LOGSTART   3            // start of the log data blocks
#define LOGN       16           // number of log data blocks (max 16 per transaction)
#define DATASTART  (LOGSTART + LOGN)  // file data start (= 19)

// log header: records which blocks a committed transaction changes.
//   if committed=1, log data block i must be installed to blk[i] (replay on recovery).
struct fs_loghdr {
    unsigned int committed;     // 1=committed (awaiting install), 0=empty
    unsigned int n;             // number of logged blocks
    unsigned int blk[LOGN];     // destination block number for each log block
};
```

This one `fs_loghdr` struct is the whole of journaling.
`committed` is **that commit bit** I mentioned, and `blk[i]` is the **destination table** recording "where log data block i really belongs."
Writing this one header block (block 2) is atomic, which is why the commit lives there.

## 3. Implementing the Transaction — log_begin → log_write → log_commit

The write API is three calls — `log_begin` (start) → `log_write` (many times) → `log_commit` (atomic finish).
Exactly the shape of [the ACID post's `BEGIN ... COMMIT`](/blog/theory/transaction-acid-01-atomicity).

### log_write — to the log first, not in place

`log_write` writes the data to the **log region first**, and remembers in memory the **destination block** that data is bound for.
The real location (`dst`) is untouched.

```c
// destination blocks of the in-progress transaction (memory). log_write fills, log_commit installs.
static uint32 log_blk[LOGN];
static int    log_n;

static void log_begin(void) { log_n = 0; }

// write data bound for dst into a log data block first (not in place yet).
static void log_write(uint32 dst, const uint8 *data) {
    if (log_n >= LOGN) return;                  // transaction bigger than the log → ignore (cap)
    for (int j = 0; j < BSIZE; j++) fsbuf[j] = data[j];
    virtio_disk_rw(LOGSTART + log_n, fsbuf, 1); // write to the log
    log_blk[log_n] = dst;                        // remember the destination
    log_n++;
}
```

The `log_n`-th `log_write` writes data to disk block `LOGSTART + log_n` (the log region) and records `log_blk[log_n] = dst` ("this goes to `dst` later").

> **Size cap**: a transaction larger than the log (16 blocks) would corrupt the disk if only *partially* committed. So `fs_create` **checks the size before starting the transaction and rejects it with `-1`** (without touching memory, so no rollback is needed), and that `-1` propagates up to the shell as `write: failed`. As a second line of defense, even if that check were bypassed, `log_commit` **aborts** an overflowing transaction outright (no partial commit).
Dying at this point is safe — the real location still holds its old value.

### log_commit — the single moment the commit bit is stamped

`log_commit` is the crux. It moves in three steps.

```c
// commit: (1) write committed=1 to the header → atomic commit point, (2) install, (3) clear the header.
static void log_commit(void) {
    if (log_n == 0) return;
    write_loghdr(1, log_n, log_blk);   // (1) commit (after this instant, a crash still completes via recovery)
    log_install(log_n, log_blk);       // (2) log → install in place
    write_loghdr(0, 0, 0);             // (3) clear the log (install done)
    log_n = 0;
}
```

**(1) `write_loghdr(1, ...)` — this one line is the atomic branch point.**
It writes `committed=1` and the destination table `blk[]` into the log header (block 2) in one go.
The instant that block write lands on disk — everything before it is "as if nothing happened," and everything after is "guaranteed to complete."
This is exactly the spot where the ACID post said *"the commit guarantee is decided by WAL fsync."*

**(2) `log_install` copies the log's blocks to their destinations.** `fsbuf` is a single temp buffer, so each iteration **reads one log block into `fsbuf` and immediately writes it to the destination** (read → overwrite → write, repeated — it isn't writing the first block over and over).

```c
// copy log data blocks to their respective destinations (install).
static void log_install(int n, const uint32 *blks) {
    for (int i = 0; i < n; i++) {
        virtio_disk_rw(LOGSTART + i, fsbuf, 0);  // read from the log
        virtio_disk_rw(blks[i], fsbuf, 1);       // write in place
    }
}
```

**(3)** Once install is done, `write_loghdr(0,0,0)` clears the header — `committed=0`. "This transaction is fully handled, nothing left to do."

### fs_create — data, directory, and superblock as one transaction

Now file creation bundles §1's three writes into **one transaction**.
From `src/fs.c`'s `fs_create` (gist only):

```c
int fs_create(const char *name, const char *data, int size) {
    // ... duplicate check, reserve space (balloc_contig) ...
    log_begin();
    // 1) data blocks → log
    for (int b = 0; b < nblocks; b++) {
        /* tmp ← the b-th block of data (rest zero-padded) */
        log_write((uint32)(start + b), tmp);
    }
    // 2) add the directory entry (memory) + update the bitmap
    /* dir[slot] = {name, size, start}; nfiles++; used[...] = 1; */
    // 3) metadata → log, commit
    log_dir();      // directory block image → log (destination DIRBLOCK)
    log_super();    // superblock image     → log (destination 0)
    log_commit();   // install the three atomically
    return 0;
}
```

`log_dir` / `log_super` are helpers that turn the in-memory directory and superblock into block images and put them in the log.

```c
// add the directory block image to the transaction log.
static void log_dir(void) {
    uint8 *db = (uint8 *)dir;
    uint8 tmp[BSIZE];
    for (int j = 0; j < BSIZE; j++) tmp[j] = (j < (int)sizeof(dir)) ? db[j] : 0;
    log_write(DIRBLOCK, tmp);                 // destination = directory block (1)
}
```

The result: within one transaction the data blocks + directory (destination 1) + superblock (destination 0) all gather in the log, and `log_commit`'s single commit bit makes **all three real at once**.
Even if it dies mid-way, a half state like "data only, no directory" never persists on disk.

## 4. Recovery — Finishing Up on Reboot (replay)

> What if it dies right after stamping the commit bit (`committed=1`) but before install finishes? A "committed but not installed" log is left on disk. How does the next boot handle it?

This is WAL's **redo**, called **replay** in filesystem terms.
On mount, look at the log header, and if `committed=1`, finish the install **again**.

```c
// recovery on mount: replay a transaction that was committed (committed=1) but not fully installed.
static void recover(void) {
    virtio_disk_rw(LOGHDR, fsbuf, 0);
    struct fs_loghdr *h = (struct fs_loghdr *)fsbuf;
    if (!h->committed) return;                          // not committed → ignore (never happened)
    uint32 n = h->n;
    if (n > LOGN) n = LOGN;
    uint32 blks[LOGN];
    for (uint32 i = 0; i < n; i++) blks[i] = h->blk[i];  // extract before reusing fsbuf
    log_install((int)n, blks);                          // committed → complete the install
    write_loghdr(0, 0, 0);                              // clear the log
    uart_puts("[fs] recovered a committed log transaction\n");
}
```

`recover()` is called at the very front of `fs_init` (mount). It splits two ways.

- **`committed` is 0**: died before commit, or a cleanly emptied log. → just ignore. The real location holds its old value, so it's *"as if nothing happened."*
- **`committed` is 1**: died after commit. → follow `blk[]` to install the log in place and clear the header. The transaction is *"finished off."*

### Idempotency — recovery itself is crash-safe

The most important property here is **idempotency**.
Running `log_install` once or ten times gives the same result — it *"just writes the same data to the same place."*
After recovery, `write_loghdr(0,0,0)` clears the header — and that matters: otherwise `committed=1` lingers and the **same transaction would replay on every boot.**

So even **"dying again during recovery"** is safe.
Die halfway through the install? The header is still `committed=1`, so the next boot runs `recover()` again and reinstalls from the start.
Already-installed blocks are simply overwritten with the same value, never corrupted.
Same principle as the ACID post's **Redo phase** being idempotent, which is what let it restart any number of times.

Our log is **redo-only** — uncommitted changes are never written in place to begin with (they only sit in the log), so there's nothing to undo. (ARIES keeps undo too because of its STEAL policy, which writes dirty pages in place before commit; we don't.)

> **Common misconception fix — "isn't one fsync the whole of atomicity?"**: `fsync` (forcing a write to disk) only guarantees *"this one block definitely landed on disk,"* not *"several blocks together or not at all."* Atomicity comes from a **protocol that bundles several writes** (gather in the log → commit bit → install), not from the durability of any single write. In our code the one atomic unit that props up that protocol is "writing the one log-header block."

## 5. Delete and Free-Block Reuse — Keeping the Bitmap Off Disk

Now that journaling gives us safe writes, we add **delete (`rm`)** to make it a real read-write FS.

### How to track free blocks

> Deleting a file should free its blocks. But how do we remember "which blocks are free"?

The old FS allocated blocks **forward only** (`next_free` only grew).
With no delete, there was no way to reuse freed spots.
The standard solution is a **free-block bitmap** (one used/free bit per block).
But putting the bitmap **on disk** means protecting it with a transaction every time it changes too, making the log more complex.

Luckily our FS has a clever shortcut — **the directory itself is already the allocation info.**
Reading the superblock's `nfiles` together with the directory, each file's `start` and `size` lets us compute exactly "which block belongs to which file."
So instead of persisting the bitmap on disk, we **rebuild it in memory by scanning the directory at mount**.

| Aspect | Bitmap on disk | Rebuild in memory from directory (our way) |
|--------|----------------|--------------------------------------------|
| Disk space | needs extra bitmap blocks | 0 (reuses the directory) |
| Transaction burden | bitmap must be logged each time | none (memory only) |
| Source of truth | both bitmap and directory (risk of mismatch) | the directory alone |
| Cost | low | an O(#files) scan at mount |

Having a **single source of truth** (the directory) is the big win — **only the directory is stored on disk**, so in the persistent state the two metadata can never get out of sync (the in-memory bitmap may differ from the directory until it's rebuilt, but *on disk there's only one truth* — the same logic as the ACID post's *"a split source of truth is a consistency violation"*).

### build_bitmap — rebuild in memory at mount

```c
static void build_bitmap(void) {
    for (uint32 i = 0; i < MAXBLK; i++) used[i] = 0;
    used[0] = used[DIRBLOCK] = used[LOGHDR] = 1;           // metadata blocks (super/dir/log header)
    for (int i = 0; i < LOGN; i++) used[LOGSTART + i] = 1; // the log region
    for (int f = 0; f < nfiles; f++) {                     // each file's data blocks
        int nb = (dir[f].size + BSIZE - 1) / BSIZE;
        for (int k = 0; k < nb; k++) {
            uint32 b = dir[f].start + k;
            if (b < MAXBLK) used[b] = 1;
        }
    }
}
```

It first marks the metadata (blocks 0/1/2) and the log region (blocks 3..18) as used, then marks the blocks each directory file occupies.
The remaining 0s are the free blocks.
When creating a new file, `balloc_contig` finds a contiguous free run in this bitmap **first-fit** (or -1 if none).

```c
// find nblocks contiguous free blocks first-fit. -1 if none.
static int balloc_contig(int nblocks) {
    if (nblocks == 0) return DATASTART;
    for (uint32 s = DATASTART; s + nblocks <= total_blocks && s + nblocks <= MAXBLK; s++) {
        int ok = 1;
        for (int k = 0; k < nblocks; k++)
            if (used[s + k]) { ok = 0; break; }
        if (ok) return (int)s;
    }
    return -1;
}
```

### fs_delete — freeing blocks, also as one transaction

Now `rm` runs a transaction that clears the file's blocks from the bitmap (`used[...] = 0`) and removes the directory entry.

```c
int fs_delete(const char *name) {
    // ... find idx ...
    int nblocks = (dir[idx].size + BSIZE - 1) / BSIZE;
    for (int b = 0; b < nblocks; b++) {            // free the blocks (reusable now)
        uint32 blk = dir[idx].start + b;
        if (blk < MAXBLK) used[blk] = 0;
    }
    for (int j = idx; j < nfiles - 1; j++)         // compact the directory array
        dir[j] = dir[j + 1];
    /* clear the last slot; nfiles--; */

    log_begin();
    log_dir();       // changed directory → log
    log_super();     // changed superblock → log
    log_commit();    // install atomically
    return 0;
}
```

Note — the bitmap (`used[]`) is updated **in memory only**; only the directory and superblock are written to disk as a transaction.
The next boot's `build_bitmap` will rebuild the bitmap from the new directory anyway.
Freed blocks are **reused** by the next `write` via `balloc_contig`. Allocation, once forward-only, finally reclaims its ground.

## 6. Seeing It With Your Own Eyes — Shell and Reboot

I created, listed, and deleted from the shell.

```
$ write hi.txt journaled-write-works
$ ls
  hi.txt  (21 bytes)
$ cat hi.txt
journaled-write-works
$ rm hi.txt
$ ls
  (hi.txt is gone)
```

The real test is a **reboot**.
Write a file in one boot, boot again with the same disk image, and it must still be there — proof that the commit→install persisted to disk.

```
RUN 1: [ok] filesystem mounted (journaled): 6 files   → write persist.txt
RUN 2: [ok] filesystem mounted (journaled): 7 files   → persist.txt still there!
```

The `[ok] ... mounted (journaled): N files` that `fs_init` (mount) prints is the first line of every boot.
It was 6 in RUN 1, and after `write` it's 7 in RUN 2, and **no log was left over**, so the `[fs] recovered ...` message did not appear — meaning a clean shutdown (down to clearing the header).
Had I killed it right after commit but before install, RUN 2's mount would have printed `[fs] recovered a committed log transaction`, finished that transaction off, then shown 7.
Either way the outcome is the same — **there is no half-written state.**

## 7. Looking Back — How Far, and Why There

This FS uses **contiguous allocation** (one file = consecutive blocks).
So it's weak for large files or a fragmented disk, and I deliberately didn't build **inode indirect blocks** (representing a file as scattered blocks).

The reason is the learning goal.
This post's theme was **"how do you make several writes atomic,"** and that can be shown completely on top of contiguous allocation.
Indirect blocks are a different axis — "how do you represent a large file" — so I separated them to keep the essence of journaling clear.

### Physical logging vs logical logging

One more thing: our log is **physical, block-level logging** (the whole changed block goes into the log).

| Aspect | Physical logging (our way) | Logical logging |
|--------|----------------------------|-----------------|
| What goes in the log | the whole changed block (512 bytes) | "what operation happened" (e.g. "add hi.txt at block 19") |
| Log size | large (one slot per block) | small (just the operation description) |
| Recovery complexity | simple (copy the block as-is) | complex (re-run the operation, must manage idempotency) |
| Idempotency | trivial (overwrite the same block) | must be guaranteed by hand |

Real filesystems use various optimizations to shrink the log — e.g. ext4 (JBD2) by default physically journals **only metadata** (data isn't journaled), while some systems use logical logging that records changes as "operations." In a toy kernel **whole-block physical logging is the simplest and most correct**, so that's what we picked.
Copying the whole block makes recovery a plain "copy," so idempotency comes for free (§4).
Between **"simplicity ↔ efficiency"** I again chose simplicity — the consistent choice of this series (the [free list in Part 1](/blog/hobby/kernel-hobby-00-boot-to-paging) shares the same spirit).

## Wrap-up

The disk never corrupts no matter when the power dies — this seemingly obvious property actually comes from one rule: **"log first, install later."**
Summing up this post's skeleton on one screen:

- **The problem** — creating one file means several disk writes (data / directory / superblock). Dying mid-way leaves it half-written and corrupt.
- **WAL** — before touching the real location, gather the changes in the log region (`log_write`), atomically stamp **one commit bit** in the log header (`write_loghdr(1,...)`), and only then install in place (`log_install`).
- **Recovery** — on mount `recover()` reads the header. `committed=0` → ignore (never happened); `1` → finish the install (replay). Because `log_install` is **idempotent**, dying again during recovery is safe.
- **Delete and reuse** — the bitmap isn't on disk; `build_bitmap` rebuilds it from the directory at mount. `rm` clears the memory bitmap and writes only the directory and superblock as a transaction. Freed blocks are reused first-fit by `balloc_contig`.

A database's WAL ([Transaction ACID](/blog/theory/transaction-acid-01-atomicity)) and a filesystem's journal are **literally the same idea** — gather in a log, stamp a commit point, replay idempotently.
Watching the abstract phrase "crash consistency" become tangible — 16 log blocks and a single commit bit — was the reward of this work.
The next post builds on this FS toward a bigger piece of the OS.

> Code: [github.com/dj258255/kernel-hobby](https://github.com/dj258255/kernel-hobby)

## References (Primary Sources First)

- [xv6: a simple, Unix-like teaching operating system (MIT 6.S081)](https://pdos.csail.mit.edu/6.828/2023/xv6.html) — this kernel's reference; `log.c` (logging) maps 1:1 to our `fs.c` journaling
- ARIES: A Transaction Recovery Method (Mohan et al., 1992) — the primary definition of WAL, redo, and idempotent recovery (the theoretical root of filesystem journals)
- [PostgreSQL Documentation: Write-Ahead Logging (WAL)](https://www.postgresql.org/docs/current/wal-intro.html) — the standard account of "log first, data later"
- Related: [Transaction ACID ① Atomicity](/blog/theory/transaction-acid-01-atomicity) · [Transaction ACID ④ Durability](/blog/theory/transaction-acid-04-durability) · [Writable filesystem](/blog/hobby/kernel-hobby-04-paging-mmap-writable-fs)

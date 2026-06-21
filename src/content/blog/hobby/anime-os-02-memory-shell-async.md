---
title: '취미 OS 만들기 #2 — 메모리 관리, 셸, 그리고 비동기 멀티태스킹'
titleEn: 'Building a Hobby OS #2 — Memory, a Shell, and Async Multitasking'
description: 키보드 입력까지 받던 토이 커널에 힙 할당기를 붙여 Box/Vec을 쓰고, 그 위에 명령어를 입력받는 간단한 셸을 올린 뒤, async/await 실행기로 셸과 다른 태스크를 동시에 돌리기까지의 과정을 정리한다.
descriptionEn: Adding a heap allocator to use Box/Vec, building a small command shell on top, and finally running the shell concurrently with another task using an async/await executor.
date: 2026-06-05T00:00:00.000Z
tags:
  - OS
  - Rust
  - Kernel
  - Heap
  - Async
  - Shell
category: OS-취미
coverImage: "/uploads/hobby/anime-os-02/async-shell.png"
draft: false
series: "취미 OS 만들기"
seriesOrder: 3
---


## 들어가며

[지난 #1](/blog/hobby/anime-os-01-build-kernel)에서 토이 커널이 부팅해 키보드 입력을 받는 데까지 왔어요. 하지만 아직 고정 크기 데이터만 다룰 수 있었죠. 이번 글에서는 세 가지를 더해요.

1. **메모리 관리** — 힙 할당기를 만들어 `Box`/`Vec` 같은 동적 할당을 쓴다
2. **셸** — 명령어를 입력받아 반응하는 간단한 커널 셸을 올린다
3. **비동기 멀티태스킹** — async/await 실행기로 셸과 다른 태스크를 동시에 돌린다

최종 모습은 이래요. 부팅 직후 동시 태스크가 한 줄 출력하고, 그 아래에서 셸이 명령어를 받아요.

![async 실행기 위에서 셸이 동작하고 동시 태스크가 함께 도는 모습](/uploads/hobby/anime-os-02/async-shell.png)

---

## 1. 메모리 관리: 힙 할당기

`Vec`, `String`, `Box`처럼 실행 중에 크기가 변하는 자료구조는 **힙 할당기**가 있어야 동작해요. 그 힙을 만들려면 먼저 페이징으로 가상 메모리를 다룰 수 있어야 하죠.

> 부트로더가 넘겨준 '물리 메모리 지도'를 받아서, 빈 물리 프레임을 찾고, 가상 주소 공간의 힙 영역에 매핑한 뒤, 그 위에 할당기를 얹는 순서예요. 부트로더의 `map_physical_memory` 기능을 켜면 전체 물리 메모리가 가상 주소에 미리 매핑돼서 페이지 테이블을 다루기 쉬워져요.

핵심은 두 모듈이에요. `memory.rs`는 현재 페이지 테이블에 접근하고 부트로더 메모리 지도에서 빈 프레임을 나눠줘요.

```rust
pub unsafe fn init(physical_memory_offset: VirtAddr) -> OffsetPageTable<'static> {
    let level_4_table = active_level_4_table(physical_memory_offset);
    OffsetPageTable::new(level_4_table, physical_memory_offset)
}
```

`allocator.rs`는 힙 영역을 빈 프레임에 매핑하고 `linked_list_allocator`를 전역 할당기로 등록해요.

```rust
#[global_allocator]
static ALLOCATOR: LockedHeap = LockedHeap::empty();

pub const HEAP_START: usize = 0x_4444_4444_0000;
pub const HEAP_SIZE: usize = 100 * 1024; // 100 KiB
```

> `#[global_allocator]`는 Rust에게 "동적 할당은 이 객체에 맡겨라"고 등록하는 거예요. 이게 끝나면 `extern crate alloc;`만 선언하면 `Box`, `Vec`, `String`, `BTreeMap` 같은 게 전부 커널에서 동작해요. "고정 데이터만"의 한계를 벗어나는 순간이죠.

`Box::new(41)`을 만들면 우리가 지정한 힙 주소(`0x4444_4444_0000`)에 할당되고, `Vec`도 정상 동작해요.

![Box와 Vec 동적 할당이 동작하는 모습](/uploads/hobby/anime-os-02/heap.png)

---

## 2. 셸: 입력을 받아 반응하기

힙이 생겼으니 이제 입력 한 줄을 `String`에 모아 명령어로 처리할 수 있어요. 셸을 설계할 때 중요한 원칙이 하나 있어요.

> 키보드 인터럽트 핸들러는 짧아야 해요. 그래서 핸들러는 글자(스캔코드)를 큐에 넣기만 하고 끝내고, 실제 줄 조립과 명령 실행은 메인 쪽에서 해요. 인터럽트 컨텍스트에서 힙 할당이나 락을 잡는 걸 피하는 안전 설계예요. 큐는 고정 크기 락-프리 자료구조(`ArrayQueue`)를 써서 인터럽트 중에도 안전해요.

명령어는 줄을 공백으로 잘라 첫 토큰을 명령으로, 나머지를 인자로 처리해요.

```rust
fn execute(line: &str) {
    let mut parts = line.splitn(2, ' ');
    let cmd = parts.next().unwrap_or("");
    let args = parts.next().unwrap_or("");
    match cmd {
        "help"   => { /* 명령 목록 */ }
        "echo"   => println!("{}", args),
        "uptime" => println!("timer ticks since boot: {}", interrupts::ticks()),
        "mem"    => { /* 힙 사용량 */ }
        "clear"  => vga_buffer::clear_screen(),
        _        => println!("unknown command: '{}'", cmd),
    }
}
```

`help`, `echo`, `about`, `uptime`, `mem`, `clear`, `whoami` 같은 명령을 붙이니, 처음으로 "OS를 쓰는 느낌"이 났어요.

![help 명령으로 셸 명령 목록을 출력한 모습](/uploads/hobby/anime-os-02/shell.png)

---

## 3. 비동기 멀티태스킹

지금 셸은 메인에서 무한 루프로 도는데, 그러면 다른 일을 할 수가 없어요. 여러 작업을 동시에 진행시키려면 **실행기(executor)** 가 필요해요.

> 실행기는 여러 future(태스크)를 번갈아 폴링해요. 태스크가 입력을 기다리며 `Pending`을 반환하면 잠들고, 키보드 인터럽트가 `Waker`를 통해 깨우면 다시 실행 큐에 올려요. 단일 코어에서 협력적으로 돌아가는 멀티태스킹이에요.

키보드를 비동기 스트림으로 바꾸는 게 핵심이에요. 인터럽트 핸들러는 스캔코드를 큐에 넣고 `Waker`를 깨우고, 셸 태스크는 그 스트림을 `await`로 소비해요.

```rust
impl Stream for ScancodeStream {
    type Item = u8;
    fn poll_next(self: Pin<&mut Self>, cx: &mut Context) -> Poll<Option<u8>> {
        let queue = SCANCODE_QUEUE.try_get().expect("큐 미초기화");
        if let Some(scancode) = queue.pop() {
            return Poll::Ready(Some(scancode));
        }
        WAKER.register(cx.waker());      // 비면 깨워달라고 등록
        match queue.pop() {              // 등록과 pop 사이 경합 재확인
            Some(scancode) => { WAKER.take(); Poll::Ready(Some(scancode)) }
            None => Poll::Pending,
        }
    }
}
```

이제 셸은 `while let Some(scancode) = scancodes.next().await` 형태의 async 함수가 돼요. 실행기에 셸 태스크와 별도의 예제 태스크를 함께 올리면, 둘이 동시에 진행돼요.

```rust
let mut executor = Executor::new();
executor.spawn(Task::new(example_task())); // 한 번 실행되고 끝남
executor.spawn(Task::new(shell::run()));   // 키 입력을 await
executor.run();
```

> 위 스크린샷에서 부팅 직후 `[task] concurrent async task computed: 42`가 셸 배너 위에 찍혀요. 예제 태스크가 셸과 같은 실행기에서 동시에 돌아 결과를 출력한 거예요. 거기에 타이머 인터럽트가 계속 틱을 세고 있어서, `uptime` 명령으로 그 동시성을 직접 확인할 수 있어요.

---

## 마치며

이번 글에서 커널이 꽤 "OS다워졌어요".

- 힙 할당기로 `Box`/`Vec` 같은 동적 할당 지원
- 명령어를 입력받아 반응하는 셸
- async/await 실행기로 셸과 다른 태스크를 동시 실행

처음 "OS는 뭐로 만드나"라는 질문에서 시작해, 부팅부터 메모리 관리·셸·멀티태스킹까지 핵심 골격을 전부 손으로 만들어봤어요. 토이 커널 학습 트랙은 여기서 한 단락을 지어요.

다음엔 원래 목표였던 **덕질 테마 OS**(검증된 리눅스를 커스텀하는 실용 트랙) 쪽으로 넘어가 볼까 해요. 토이 커널이 "OS가 안에서 어떻게 도는지"를 가르쳐줬다면, 그쪽은 "실제로 쓰는 OS를 어떻게 빚는지"의 이야기가 될 거예요.

### 참고 자료

- [Writing an OS in Rust — Heap Allocation](https://os.phil-opp.com/heap-allocation/)
- [Writing an OS in Rust — Async/Await](https://os.phil-opp.com/async-await/)
- [OSDev Wiki](https://wiki.osdev.org/)

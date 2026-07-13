---
title: '취미 OS 만들기 #1: 부팅부터 키보드 입력까지'
titleEn: 'Building a Hobby OS #1 — From Boot to Keyboard Input'
description: Rust 토이 커널을 부팅시키고, VGA로 화면에 출력하고, println! 매크로를 직접 만들고, CPU 예외와 하드웨어 인터럽트를 처리해 키보드 입력까지 받는 과정을 한 번에 정리한다. 부트로더 PIE 디버깅 같은 실전 삽질도 함께.
descriptionEn: A single walkthrough — booting a Rust toy kernel, printing to the VGA screen, implementing the println! macro, handling CPU exceptions and hardware interrupts, and finally receiving keyboard input. Including real debugging like the bootloader PIE issue.
date: 2026-06-22T00:00:00.000Z
tags:
  - OS
  - Rust
  - Kernel
  - VGA
  - Interrupt
  - Keyboard
category: OS-취미
coverImage: "/uploads/hobby/anime-os-04/keyboard-input.png"
draft: false
series: "취미 OS 만들기"
seriesOrder: 2
---


## 들어가며

[지난 0편](/blog/hobby/anime-os-00-why-rust)에서는 언어를 Rust로 정하고 `std` 없이 컴파일되는 베어메탈 바이너리까지 만들었습니다. 하지만 화면엔 아무것도 안 떴습니다. `_start`가 그냥 무한 대기 중이었기 때문입니다.

이번 글에서는 그 빈 커널을 **부팅해서 키보드 입력을 받는 단계까지** 한 번에 끌고 갑니다. 순서는 이렇습니다.

1. 부팅 + VGA로 첫 글자 출력 (+ 부트로더 디버깅)
2. `println!` 매크로 직접 만들기
3. CPU 예외 처리 (IDT/GDT)
4. 하드웨어 인터럽트 + 키보드 입력

최종 결과부터 보면, 키보드로 `hello anime os`를 입력하니 화면에 그대로 찍힙니다.

![키보드 입력 hello anime os가 화면에 출력된 모습](/uploads/hobby/anime-os-04/keyboard-input.png)

---

## 1. 부팅과 첫 화면 출력

### 1.1 x86_64 베어메탈 타겟으로 전환

0편에선 컴파일만 확인하려고 임베디드 타겟으로 빌드했습니다. 이제 실제 PC 환경인 x86_64로 바꿔야 하는데, 베어메탈 타겟엔 미리 컴파일된 `core` 라이브러리가 없어서 소스에서 직접 빌드하도록 설정합니다.

```toml
# .cargo/config.toml
[unstable]
build-std = ["core", "compiler_builtins"]
build-std-features = ["compiler-builtins-mem"]

[build]
target = "x86_64-anime_os.json"
```

> 평소엔 rustup이 타겟별로 미리 빌드된 표준 라이브러리를 받아 줍니다. 그런데 우리 같은 듣도 보도 못한 커스텀 타겟엔 그게 없습니다. `build-std`는 `core`를 내 타겟에 맞춰 그 자리에서 컴파일하라는 뜻이고, 0편에서 깔아둔 `rust-src` 컴포넌트가 이때 쓰입니다.

### 1.2 VGA 텍스트 버퍼에 직접 쓰기

화면 출력의 가장 원초적인 방법입니다. 메모리 주소 `0xb8000`부터가 화면에 보이는 글자들의 저장소(VGA 텍스트 버퍼)라, 여기에 값을 쓰면 그대로 화면에 나타납니다.

```rust
static HELLO: &[u8] = b"Hello World! anime_os booted :)";

#[no_mangle]
pub extern "C" fn _start() -> ! {
    let vga_buffer = 0xb8000 as *mut u8;
    for (i, &byte) in HELLO.iter().enumerate() {
        unsafe {
            *vga_buffer.offset(i as isize * 2) = byte;      // 글자(아스키)
            *vga_buffer.offset(i as isize * 2 + 1) = 0xb;   // 색상: 밝은 청록
        }
    }
    loop {}
}
```

> VGA 텍스트 모드는 글자 1개가 2바이트입니다. `[아스키 코드][색상]`이 짝을 이룹니다. `0xb8000`에 쓰는 건 메모리에 쓰는 행위처럼 보이지만 실제론 화면 하드웨어를 건드리는 거라, 안전 보장이 불가능해서 `unsafe` 블록이 필요합니다. 추상화 없이 하드웨어 주소를 날것으로 조작하는 것, 이게 OS의 본질입니다.

부트로더(`bootloader` 크레이트)와 `bootimage` 도구로 부팅 이미지를 만들어 QEMU로 실행하면, 첫 화면이 뜹니다.

![anime_os가 부팅해 Hello World를 출력한 모습](/uploads/hobby/anime-os-01/boot-hello-world.png)

### 1.3 디버깅 무용담: 부트로더가 죽었다

사실 처음엔 빨간 화면이 떴습니다.

```
panicked at src/page_table.rs:105: failed to map segment starting at
Page(0x1000) ... PageAlreadyMapped(PhysFrame(0x400000))
```

내 커널이 아니라 부트로더가 패닉한 거였습니다. 커널 ELF의 프로그램 헤더를 까보니 `DYNAMIC` 세그먼트가 있었는데, 이건 커널이 **PIE(위치독립 실행파일)** 로 빌드됐다는 뜻입니다.

> Rust 내장 타겟 `x86_64-unknown-none`은 커널을 PIE로 빌드합니다. 그런데 부트로더 0.9는 PIE를 못 읽습니다. 고정 주소 정적 바이너리만 기대하기 때문입니다. 그래서 매핑이 꼬여서 패닉이 난 거였습니다.

해결책은 **PIE를 끈 커스텀 타겟**을 만드는 거였습니다. `position-independent-executables: false`, `relocation-model: static`으로 설정하니 `DYNAMIC` 세그먼트가 사라지고 커널이 `0x200000`에 깔끔하게 정렬됐습니다. 정적 비-PIE 바이너리가 곧 부트로더가 읽을 수 있는 형태입니다.

> 최신 nightly는 `.json` 커스텀 타겟에 `-Zjson-target-spec` 플래그를 요구하고, 스펙의 숫자 필드를 진짜 숫자로 받는 등 몇 년 전 튜토리얼과 미묘하게 달라진 부분이 있었습니다. 이런 버전 드리프트를 직접 메꾸는 게 OS 개발의 일상입니다.

---

## 2. println! 매크로 직접 만들기

1.2의 날코드를 재사용 가능한 출력 시스템으로 발전시킵니다. 핵심은 세 가지입니다.

**Volatile로 최적화 막기.** VGA 버퍼는 쓰기만 하고 다시 안 읽어서, 컴파일러가 "의미 없는 쓰기"로 보고 지워버릴 수 있습니다.

> 그 의미 없어 보이는 쓰기가 바로 화면 출력이라, 지워지면 화면에 아무것도 안 뜹니다. 그래서 `Volatile`(휘발성)로 감싸서 "이 쓰기는 부수효과가 있으니 절대 생략하지 마"라고 컴파일러에 강제합니다.

**글자와 색상을 타입으로 모델링.**

```rust
#[repr(u8)]
pub enum Color { Black = 0, /* ... */ Yellow = 14, White = 15 }

#[repr(transparent)]
struct ColorCode(u8); // 상위 4비트 배경 + 하위 4비트 글자색

#[repr(C)]
struct ScreenChar { ascii_character: u8, color_code: ColorCode }
```

**`println!` 재현.** `core::fmt::Write`를 구현하면 `{}` 포맷팅이 공짜로 따라오고, `lazy_static` + `Mutex`로 전역 `WRITER`를 만들어 매크로에서 호출합니다.

```rust
#[macro_export]
macro_rules! println {
    () => ($crate::print!("\n"));
    ($($arg:tt)*) => ($crate::print!("{}\n", format_args!($($arg)*)));
}
```

> `WRITER`는 `0xb8000` 포인터를 역참조해야 해서 실행 시점에 초기화돼야 하는데, 일반 `static`은 컴파일 타임 상수만 되기 때문입니다. 그래서 `lazy_static`으로 "처음 쓸 때 한 번 초기화"하게 했습니다. `format_args!`는 std가 `println!`에서 쓰는 바로 그 장치로, 숫자·문자열 포맷팅을 처리해 우리 `Writer`로 흘려보냅니다.

이제 줄바꿈·스크롤·색상·숫자 포맷팅이 다 됩니다.

![println! 매크로로 여러 줄과 숫자 포맷팅을 출력한 모습](/uploads/hobby/anime-os-02/println-macro.png)

---

## 3. CPU 예외 처리 (IDT/GDT)

지금 커널은 0으로 나누기 같은 CPU 예외가 나면 에러 한 줄 없이 리부팅 무한 반복(triple fault)으로 죽습니다. 안전망을 만들 차례입니다.

**IDT(Interrupt Descriptor Table)** 는 예외/인터럽트 번호마다 어떤 핸들러를 부를지 적어둔 표입니다.

```rust
idt.breakpoint.set_handler_fn(breakpoint_handler);

extern "x86-interrupt" fn breakpoint_handler(stack_frame: InterruptStackFrame) {
    println!("EXCEPTION: BREAKPOINT\n{:#?}", stack_frame);
}
```

> `extern "x86-interrupt"`는 인터럽트 핸들러 전용 호출 규약입니다. 일반 함수와 달리 모든 레지스터를 보존하고 `iretq`로 복귀하는 특수 방식이 필요해서 컴파일러에게 이걸 명시해 줍니다.

까다로운 건 **더블 폴트**입니다. 예외 처리 중 또 예외가 나는 상황인데, 스택이 망가진 게 원인이라면 핸들러마저 그 스택을 쓰다 죽어서 트리플 폴트로 이어집니다. 그래서 **GDT/TSS의 IST(Interrupt Stack Table)** 에 보장된 깨끗한 비상 스택을 등록하고, 더블 폴트 핸들러가 그걸 쓰게 합니다.

> GDT는 원래 메모리 세그먼트를 나누던 옛 메커니즘이라 64비트 모드에선 거의 안 쓰는데, TSS를 등록하는 통로로는 여전히 필요합니다. IST는 "이 인터럽트는 무조건 이 주소의 스택에서 처리하라"를 하드웨어 수준에서 보장하는 핵심 장치입니다.

브레이크포인트 예외를 일부러 발생시켜 보면, 핸들러가 잡아 정보를 출력하고 그 아래 코드까지 정상 실행됩니다. 안전망이 작동하는 것입니다.

![브레이크포인트 예외를 잡아 정보를 출력하고 정상 복귀한 모습](/uploads/hobby/anime-os-03/exceptions-idt.png)

---

## 4. 하드웨어 인터럽트와 키보드 입력

마지막입니다. IDT 위에 하드웨어 인터럽트를 붙여 키보드 입력을 받습니다. 키를 누르면 하드웨어가 CPU에 인터럽트를 쏘고, CPU는 하던 일을 멈추고 키보드 핸들러로 점프합니다.

> 대안인 폴링은 CPU가 계속 "키 눌렸나?" 확인하는 거라 비효율적입니다. 인터럽트는 키가 눌릴 때만 하드웨어가 CPU를 깨우니까, 평소엔 CPU가 쉴 수 있습니다(`hlt`). "전화벨"과 "5초마다 전화 왔나 확인"의 차이라고 보면 됩니다.

하드웨어 인터럽트는 **8259 PIC** 칩을 거쳐 CPU에 도착합니다. 0~31번은 CPU 예외가 쓰니 PIC 인터럽트는 32번(타이머), 33번(키보드)부터 매핑합니다. 키보드 핸들러는 포트 `0x60`에서 스캔코드를 읽어 글자로 변환합니다.

```rust
extern "x86-interrupt" fn keyboard_interrupt_handler(_f: InterruptStackFrame) {
    let scancode: u8 = unsafe { Port::new(0x60).read() };
    if let Ok(Some(ev)) = KEYBOARD.lock().add_byte(scancode) {
        if let Some(key) = KEYBOARD.lock().process_keyevent(ev) {
            if let DecodedKey::Unicode(c) = key { print!("{}", c); }
        }
    }
    unsafe { PICS.lock().notify_end_of_interrupt(KEYBOARD_INT); }
}
```

> 핸들러는 끝날 때 반드시 PIC에 "처리 끝(EOI)"을 알려야 합니다. 안 그러면 PIC가 다음 인터럽트를 안 보내서 시스템이 멈춰버립니다. 그리고 스캔코드는 눌림·뗌이 따로 있고 Shift 조합 같은 상태도 있어서, `pc-keyboard` 크레이트가 이 복잡한 상태 기계를 처리해 최종 글자로 변환해 줍니다.

인터럽트를 활성화하고(`sti`) 메인 루프를 `hlt`로 재우면, 키 입력이 올 때마다 깨어나 처리합니다. 맨 위 스크린샷의 `hello anime os`가 그 결과입니다.

---

## 마치며

여기까지가 커널의 **기본 골격**입니다.

- 부팅 + VGA 화면 출력 (+ PIE 디버깅)
- `println!` 매크로 + 스크롤·색상
- CPU 예외 처리(IDT) + GDT 비상 스택
- 하드웨어 인터럽트 + 키보드 입력

부팅해서 사용자 입력을 받는 데까지 왔지만, 아직 갈 길이 멉니다. 다음 글에서는 **메모리 관리(페이징 + 힙 할당)** 를 붙여서, `Vec`이나 `Box` 같은 동적 할당을 쓸 수 있게 만들 겁니다. 그래야 커널이 진짜 "프로그램다운" 일을 할 수 있기 때문입니다.

> 다음 글: **취미 OS 만들기 #2: 메모리 관리(페이징과 힙 할당) (예정)**

### 참고 자료

- [Writing an OS in Rust — Philipp Oppermann](https://os.phil-opp.com/)
- [OSDev Wiki](https://wiki.osdev.org/)

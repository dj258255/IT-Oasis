---
title: '취미 OS 만들기 #4: 하드웨어 인터럽트와 키보드 입력 (졸업)'
titleEn: 'Building a Hobby OS #4 — Hardware Interrupts and Keyboard Input (Graduation)'
description: 토이 커널의 졸업 편. 8259 PIC로 하드웨어 인터럽트를 받고, 타이머와 키보드 인터럽트를 처리한다. 포트 0x60에서 스캔코드를 읽어 글자로 변환해, 드디어 사용자 입력을 화면에 출력한다.
descriptionEn: The graduation chapter. Receiving hardware interrupts via the 8259 PIC, handling timer and keyboard interrupts, reading scancodes from port 0x60 and decoding them — finally printing user input to the screen.
date: 2026-06-22T00:00:00.000Z
tags:
 - OS
 - Rust
 - Kernel
 - Interrupt
 - Keyboard
 - PIC
category: OS-취미
coverImage: "/uploads/hobby/anime-os-04/keyboard-input.png"
draft: false
series: "취미 OS 만들기"
seriesOrder: 5
---


## 들어가며

드디어 졸업 편입니다. [3편](#)에서 만든 IDT 안전망 위에, 이번엔 **하드웨어 인터럽트**를 붙입니다. 지금까지 커널은 일방적으로 출력만 했는데, 이제 **키보드 입력을 받아 사용자와 상호작용**합니다.

결과부터 보면, 키보드로 `hello anime os`를 입력하니 화면에 그대로 찍혔습니다.

![키보드 입력 hello anime os가 화면에 출력된 모습](/uploads/hobby/anime-os-04/keyboard-input.png)

이 순간이 토이 커널의 졸업 지점입니다. "부팅해서 키보드 입력을 받는 OS", 핵심 골격이 완성됐습니다.

## 1. 인터럽트란: CPU의 "잠깐만요"

키를 누르면 키보드 하드웨어가 CPU에 신호를 보냅니다. CPU는 하던 일을 **잠깐 멈추고** 키보드 핸들러로 점프해 키를 처리한 뒤, 다시 원래 하던 일로 돌아옵니다. 이게 **인터럽트**입니다.

> 대안은 폴링입니다. CPU가 계속 "키 눌렸나? 키 눌렸나?" 확인하는 건데, 비효율적이고 CPU를 100% 잡아먹습니다. 인터럽트는 키가 눌릴 때만 하드웨어가 CPU를 깨우니까, 평소엔 CPU가 쉴 수 있습니다(`hlt`). "전화벨"과 "5초마다 전화 왔나 확인"의 차이라고 보면 됩니다.

## 2. PIC: 인터럽트를 CPU로 전달하는 교환원

하드웨어 인터럽트는 **8259 PIC(Programmable Interrupt Controller)** 라는 칩을 거쳐 CPU에 도착합니다. 타이머·키보드 등 여러 장치의 신호를 모아 CPU에 순서대로 전달하는 교환원입니다.

```rust
pub const PIC_1_OFFSET: u8 = 32;
pub const PIC_2_OFFSET: u8 = PIC_1_OFFSET + 8;

pub static PICS: Mutex<ChainedPics> =
 Mutex::new(unsafe { ChainedPics::new(PIC_1_OFFSET, PIC_2_OFFSET) });

#[repr(u8)]
pub enum InterruptIndex {
 Timer = PIC_1_OFFSET, // 32
 Keyboard, // 33
}
```

> 왜 32부터일까요? 0~31번은 CPU 예외(3편의 그것)가 이미 쓰고 있어서, PIC 인터럽트를 32번부터 매핑해 충돌을 피합니다. 그리고 핸들러는 끝날 때 반드시 PIC에 "처리 끝(EOI)"을 알려야 하는데, 안 그러면 PIC가 다음 인터럽트를 안 보내서 시스템이 멈춰버립니다.

## 3. 타이머 인터럽트: 인터럽트가 켜졌다는 증거

타이머는 주기적으로 인터럽트를 발생시킵니다. 지금은 화면을 어지럽히지 않으려고 조용히 EOI만 보냅니다. 이 핸들러가 죽지 않고 도는 것 자체가 "인터럽트가 활성화됐다"는 증거입니다.

```rust
extern "x86-interrupt" fn timer_interrupt_handler(_stack_frame: InterruptStackFrame) {
 unsafe {
 PICS.lock().notify_end_of_interrupt(InterruptIndex::Timer.as_u8());
 }
}
```

## 4. 키보드 인터럽트: 스캔코드를 글자로

이번 편의 핵심입니다. 키를 누르면 키보드는 **스캔코드**(키의 하드웨어 번호)를 포트 `0x60`에 올려둡니다. 핸들러는 이걸 읽어 실제 글자로 변환합니다.

```rust
extern "x86-interrupt" fn keyboard_interrupt_handler(_stack_frame: InterruptStackFrame) {
 use pc_keyboard::{layouts, DecodedKey, HandleControl, Keyboard, ScancodeSet1};
 use x86_64::instructions::port::Port;

 lazy_static! {
 static ref KEYBOARD: Mutex<Keyboard<layouts::Us104Key, ScancodeSet1>> =
 Mutex::new(Keyboard::new(
 ScancodeSet1::new(), layouts::Us104Key, HandleControl::Ignore));
 }

 let mut keyboard = KEYBOARD.lock();
 let mut port = Port::new(0x60);
 let scancode: u8 = unsafe { port.read() }; // 포트에서 스캔코드 읽기

 if let Ok(Some(key_event)) = keyboard.add_byte(scancode) {
 if let Some(key) = keyboard.process_keyevent(key_event) {
 match key {
 DecodedKey::Unicode(character) => print!("{}", character),
 DecodedKey::RawKey(key) => print!("{:?}", key),
 }
 }
 }

 unsafe {
 PICS.lock().notify_end_of_interrupt(InterruptIndex::Keyboard.as_u8());
 }
}
```

> 스캔코드는 키의 눌림과 뗌이 따로 있고 Shift 조합 같은 상태도 있습니다. `pc-keyboard` 크레이트가 이 복잡한 상태 기계를 처리해 최종 글자(`DecodedKey`)로 변환해 줍니다. `port.read()`가 `unsafe`인 이유는, 하드웨어 포트 입출력은 무슨 일이 일어날지 컴파일러가 보장 못 하니 우리가 책임진다는 표시입니다.

## 5. 인터럽트 켜기 + 절전 루프

마지막으로 인터럽트를 활성화하고(`sti`), 메인 루프는 `hlt`로 CPU를 재웁니다. 인터럽트가 오면 깨어나 핸들러를 실행하고 다시 잠듭니다.

```rust
pub fn init() {
 IDT.load();
 unsafe { PICS.lock().initialize() };
 x86_64::instructions::interrupts::enable(); // sti
}
```

```rust
// main.rs — 바쁜 대기 대신 절전
loop {
 x86_64::instructions::hlt();
}
```

## 마치며: 졸업!

```
- 0단계: 환경 세팅 + 베어메탈 컴파일
- 1단계: 부팅 + VGA 첫 화면
- 2단계: println! 매크로 + 스크롤·색상
- 3단계: CPU 예외 처리(IDT) + GDT 안전 스택
- 4단계: 하드웨어 인터럽트 + 키보드 입력 ← 지금!
```

총 **362줄, 4개 모듈**로 "부팅해서 키보드 입력을 받는 진짜 커널"을 완성했습니다. 처음 "OS는 뭐로 만드나"라는 질문에서 출발해 여기까지 왔습니다.

돌아보면 가장 값진 건 **튜토리얼대로 안 흘러간 순간들**이었습니다. 부트로더가 PIE 때문에 패닉났을 때 ELF 헤더를 까서 원인을 찾고, 최신 nightly와 옛 튜토리얼 사이의 버전 드리프트(`json-target-spec` 플래그, 스키마 변경)를 직접 메꿨습니다. 이게 진짜 OS 개발이었습니다.

이 너머에는 **메모리 관리(페이징·힙 할당)**, **멀티태스킹(async/await)** 같은 더 깊은 세계가 있습니다. 토이 커널의 핵심 골격은 여기서 일단락하고, 다음엔 처음 목표였던 **"덕질 테마 OS"(리눅스 커스텀)** 트랙으로 넘어가 볼까 합니다.

> 시리즈 완결. 읽어주셔서 감사합니다!

### 참고 자료

- [Writing an OS in Rust — Hardware Interrupts](https://os.phil-opp.com/hardware-interrupts/)
- [OSDev Wiki — 8259 PIC](https://wiki.osdev.org/8259_PIC)
- [OSDev Wiki — PS/2 Keyboard](https://wiki.osdev.org/PS/2_Keyboard)

---
title: '취미 OS 만들기 #2: println! 매크로 직접 만들기'
titleEn: 'Building a Hobby OS #2 — Implementing the println! Macro'
description: 1단계의 날코드(VGA 버퍼에 직접 쓰기)를 제대로 된 출력 모듈로 발전시킨다. Volatile로 최적화를 막고, Writer로 줄바꿈·스크롤·색상을 구현하고, std의 println!을 베어메탈용으로 직접 재현한다.
descriptionEn: Turning the raw VGA buffer writes from part 1 into a proper output module — using Volatile to prevent optimization, implementing a Writer with newline/scroll/color, and reimplementing std's println! macro for bare metal.
date: 2026-06-22T00:00:00.000Z
tags:
 - OS
 - Rust
 - Kernel
 - VGA
 - Macro
category: OS-취미
coverImage: "/uploads/hobby/anime-os-02/println-macro.png"
draft: false
series: "취미 OS 만들기"
seriesOrder: 3
---


## 들어가며

[지난 1편](#)에서는 VGA 버퍼(`0xb8000`)에 글자를 찍어 화면 출력에 성공했습니다. 하지만 코드가 `_start`에 이렇게 박혀 있었습니다.

```rust
*vga_buffer.offset(i as isize * 2) = byte;
*vga_buffer.offset(i as isize * 2 + 1) = 0xb;
```

이건 한 줄 출력하기도 번거롭고, 줄바꿈·스크롤·색상도 안 됩니다. 이번 2편에서는 이걸 **`println!`처럼 편하게 쓰는 출력 시스템**으로 만듭니다. 결과는 이렇습니다.

![println! 매크로로 여러 줄과 숫자 포맷팅을 출력한 모습](/uploads/hobby/anime-os-02/println-macro.png)

빈 줄, 여러 줄, 그리고 `2 + 3 = 5` 같은 **숫자 포맷팅**까지 전부 직접 만든 매크로로 처리했습니다.

## 1. Volatile: 컴파일러의 과잉 최적화 막기

VGA 버퍼는 평범한 메모리처럼 보이지만 사실 **화면 하드웨어**입니다. 여기에 값을 쓰면 화면이 바뀝니다. 문제는, 우리는 이 메모리를 **쓰기만 하고 다시 읽지 않는다**는 겁니다.

> 컴파일러는 "이 메모리에 쓰기만 하고 다시 안 읽네? 그럼 이 쓰기는 의미 없으니 지워도 되겠다"라고 최적화할 수 있습니다. 하지만 그 의미 없어 보이는 쓰기가 바로 화면 출력이라, 지워지면 화면에 아무것도 안 뜹니다. 그래서 `Volatile`(휘발성)로 감싸서 "이 쓰기는 부수효과가 있으니 절대 생략하지 마"라고 컴파일러에 강제합니다.

```rust
use volatile::Volatile;

#[repr(transparent)]
struct Buffer {
 chars: [[Volatile<ScreenChar>; BUFFER_WIDTH]; BUFFER_HEIGHT],
}
```

## 2. 글자와 색상을 타입으로 표현

VGA의 한 칸은 `[아스키 1바이트][색상 1바이트]`입니다. 이걸 Rust 타입으로 정확히 모델링합니다.

```rust
#[repr(u8)]
pub enum Color {
 Black = 0, Blue = 1, Green = 2, Cyan = 3,
 Red = 4, /* ... */ Yellow = 14, White = 15,
}

// 색상 1바이트 = 상위 4비트(배경) + 하위 4비트(글자색)
#[repr(transparent)]
struct ColorCode(u8);

impl ColorCode {
 fn new(foreground: Color, background: Color) -> ColorCode {
 ColorCode((background as u8) << 4 | (foreground as u8))
 }
}

// 화면 글자 1칸. repr(C)로 메모리 순서를 보장
#[repr(C)]
struct ScreenChar {
 ascii_character: u8,
 color_code: ColorCode,
}
```

> `#[repr(u8)]`은 enum을 정확히 1바이트 숫자로 만듭니다(`Color::Yellow`는 14). `#[repr(C)]`는 필드 순서를 C처럼 고정해서 하드웨어가 기대하는 `[아스키][색상]` 순서가 깨지지 않게 해 줍니다. `#[repr(transparent)]`는 래퍼 타입이 내부 값과 똑같은 메모리 레이아웃을 갖게 해서 추상화 비용을 0으로 만듭니다.

## 3. Writer: 줄바꿈과 스크롤

`Writer`가 실제로 글자를 찍는 주체입니다. 핵심은 **항상 맨 아랫줄에 쓰고, 줄바꿈 때 전체를 한 칸 위로 밀어 올리는(스크롤)** 방식입니다.

```rust
fn new_line(&mut self) {
 // 모든 줄을 한 칸 위로 복사 (스크롤)
 for row in 1..BUFFER_HEIGHT {
 for col in 0..BUFFER_WIDTH {
 let character = self.buffer.chars[row][col].read();
 self.buffer.chars[row - 1][col].write(character);
 }
 }
 self.clear_row(BUFFER_HEIGHT - 1); // 맨 아랫줄 비우기
 self.column_position = 0;
}
```

## 4. println! 매크로 재현

이제 하이라이트입니다. `std`의 `println!`을 우리 `Writer`용으로 직접 만듭니다. 핵심은 두 가지입니다.

**(1) `core::fmt::Write` 구현**입니다. 이걸 구현하면 `{}` 포맷팅, 숫자 출력이 공짜로 따라옵니다.

```rust
impl fmt::Write for Writer {
 fn write_str(&mut self, s: &str) -> fmt::Result {
 self.write_string(s);
 Ok(())
 }
}
```

**(2) 전역 Writer + 매크로**

```rust
lazy_static! {
 pub static ref WRITER: Mutex<Writer> = Mutex::new(Writer {
 column_position: 0,
 color_code: ColorCode::new(Color::Yellow, Color::Black),
 buffer: unsafe { &mut *(0xb8000 as *mut Buffer) },
 });
}

#[macro_export]
macro_rules! println {
 () => ($crate::print!("\n"));
 ($($arg:tt)*) => ($crate::print!("{}\n", format_args!($($arg)*)));
}
```

> `WRITER`는 `0xb8000` 포인터를 역참조해야 해서 실행 시점에 초기화돼야 하는데, 일반 `static`은 컴파일 타임 상수만 되기 때문입니다. 그래서 `lazy_static`으로 "처음 쓸 때 한 번 초기화"하게 했습니다. `Mutex`(스핀락)는 지금은 단일 스레드지만, 나중에 인터럽트 핸들러와 메인 코드가 동시에 `WRITER`를 건드릴 수 있어 미리 락으로 보호한 겁니다. 그리고 `format_args!`는 std가 `println!`에서 쓰는 바로 그 장치로, 숫자·문자열 포맷팅을 처리해 우리 `Writer`로 흘려보냅니다.

이제 `main.rs`가 이렇게 깔끔해집니다.

```rust
println!("Hello World{}", "!");
println!(" println! works -> {} + {} = {}", 2, 3, 2 + 3);
```

## 마치며

1단계의 날코드를 **재사용 가능한 출력 시스템**으로 발전시켰습니다.

- Volatile로 화면 출력이 최적화로 사라지지 않게 보장
- Color/ColorCode/ScreenChar를 타입으로 정확히 모델링
- Writer로 줄바꿈·스크롤·색상 구현
- `core::fmt::Write` + `lazy_static` + 매크로로 `println!` 재현

가장 인상 깊은 건 **std가 평소 해주던 일을 직접 만들어본 것**입니다. 우리가 무심코 쓰던 `println!` 한 줄 뒤에 이런 장치들이 숨어 있었던 것입니다.

다음 3편에서는 **CPU 예외 처리(IDT)** 를 붙입니다. 지금은 0으로 나누기 같은 오류가 나면 커널이 그냥 죽는데, 이걸 잡아내는 안전망을 만들 겁니다.

> 다음 글: **취미 OS 만들기 #3: CPU 예외 처리와 안전망 (IDT/GDT)**

### 참고 자료

- [Writing an OS in Rust — VGA Text Mode](https://os.phil-opp.com/vga-text-mode/)
- [OSDev Wiki — Printing to Screen](https://wiki.osdev.org/Printing_to_Screen)

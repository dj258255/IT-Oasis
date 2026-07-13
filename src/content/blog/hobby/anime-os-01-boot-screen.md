---
title: '취미 OS 만들기 #1: 부팅과 첫 화면 출력'
titleEn: 'Building a Hobby OS #1 — Booting and First Screen Output'
description: 직접 만든 토이 커널이 QEMU에서 부팅해 화면에 첫 글자를 출력하기까지. x86_64 베어메탈 타겟 전환, VGA 텍스트 버퍼에 직접 쓰기, 부트로더 연결, 그리고 부트로더가 패닉한 PIE 문제를 ELF 헤더까지 까서 해결한 디버깅 과정을 정리한다.
descriptionEn: How my toy kernel booted in QEMU and printed its first characters to screen. Switching to an x86_64 bare-metal target, writing directly to the VGA text buffer, wiring up the bootloader, and debugging a bootloader panic caused by PIE.
date: 2026-06-22T00:00:00.000Z
tags:
 - OS
 - Rust
 - Kernel
 - VGA
 - Bootloader
 - QEMU
category: OS-취미
coverImage: "/uploads/hobby/anime-os-01/boot-hello-world.png"
draft: false
series: "취미 OS 만들기"
seriesOrder: 2
---


## 들어가며

[지난 0편](#)에서는 언어를 Rust로 정하고 **`std` 없이 컴파일되는 베어메탈 바이너리**까지 만들었습니다. 하지만 화면엔 아무것도 안 떴습니다. `_start`가 그냥 무한 대기 중이었기 때문입니다.

이번 1편의 목표는 단 하나, QEMU 창에 진짜로 글자를 띄우는 것입니다. 결론부터 보여드리겠습니다.

![anime_os가 부팅해 화면에 Hello World를 출력한 모습](/uploads/hobby/anime-os-01/boot-hello-world.png)

밝은 청록색으로 `Hello World! anime_os booted :)`. 직접 만든 OS가 부팅해서 화면에 글자를 찍은 순간입니다. 이게 어떻게 가능했는지, 그리고 중간에 부트로더가 **패닉으로 죽었다가** 어떻게 살려냈는지 풀어보겠습니다.

## 1. x86_64 베어메탈 타겟으로 전환

0편에선 컴파일만 확인하려고 임베디드 타겟(`thumbv7em-none-eabihf`)으로 빌드했습니다. 이제 실제 PC 환경인 **x86_64**로 바꿔야 합니다.

문제는, 베어메탈 타겟엔 **미리 컴파일된 `core` 라이브러리가 없다**는 겁니다. 그래서 `core`를 소스에서 직접 빌드하도록 설정합니다.

```toml
# .cargo/config.toml
[unstable]
build-std = ["core", "compiler_builtins"]
build-std-features = ["compiler-builtins-mem"]

[build]
target = "x86_64-anime_os.json"
```

> 평소엔 rustup이 타겟별로 미리 빌드된 표준 라이브러리를 받아 줍니다. 그런데 우리 같은 듣도 보도 못한 커스텀 타겟엔 그게 없습니다. `build-std`는 `core`를 내 타겟에 맞춰 그 자리에서 컴파일하라는 뜻이고, 0편에서 깔아둔 `rust-src` 컴포넌트가 이때 쓰입니다.

## 2. VGA 텍스트 버퍼에 직접 쓰기

화면 출력의 가장 원초적인 방법입니다. **메모리 주소 `0xb8000`** 부터가 화면에 보이는 글자들의 저장소(VGA 텍스트 버퍼)입니다. 여기에 값을 쓰면 그대로 화면에 나타납니다.

```rust
#![no_std]
#![no_main]

use core::panic::PanicInfo;

static HELLO: &[u8] = b"Hello World! anime_os booted :)";

#[no_mangle]
pub extern "C" fn _start() -> ! {
 let vga_buffer = 0xb8000 as *mut u8;

 for (i, &byte) in HELLO.iter().enumerate() {
 unsafe {
 *vga_buffer.offset(i as isize * 2) = byte; // 글자(아스키)
 *vga_buffer.offset(i as isize * 2 + 1) = 0xb; // 색상: 밝은 청록
 }
 }
 loop {}
}

#[panic_handler]
fn panic(_info: &PanicInfo) -> ! {
 loop {}
}
```

> VGA 텍스트 모드는 글자 1개가 2바이트입니다. `[아스키 코드][색상]`이 짝을 이룹니다. 그래서 i번째 글자는 offset `i*2`에, 색상은 `i*2+1`에 씁니다. `0xb8000`에 쓰는 건 메모리에 쓰는 행위처럼 보이지만 실제론 화면 하드웨어를 건드리는 거라, 안전 보장이 불가능해서 `unsafe` 블록이 필요합니다. 추상화 없이 하드웨어 주소를 날것으로 조작하는 것, 이게 OS의 본질입니다.

## 3. 부트로더 연결

커널 알맹이(ELF)만으론 컴퓨터가 부팅을 못 합니다. BIOS가 우리 커널을 메모리에 올리고 `_start`로 점프하게 해주는 **부트로더**라는 다리가 필요합니다.

직접 짜면 어셈블리 지옥이라(0편에서 말한 "어셈블리는 양념" 원칙), 검증된 `bootloader` 크레이트를 빌려 씁니다.

```toml
# Cargo.toml
[dependencies]
bootloader = "0.9.23"
```

그리고 `bootimage` 도구가 **[부트로더 + 커널]을 합쳐** QEMU가 부팅할 수 있는 디스크 이미지로 만들어 줍니다.

```bash
cargo install bootimage
cargo bootimage # → bootimage-anime_os.bin 생성
```

## 4. 그리고 부트로더가 죽었다: 디버깅 무용담

자, 부팅 이미지를 만들고 QEMU로 실행했더니... **빨간 화면**이 떴습니다.

```
panicked at src/page_table.rs:105: failed to map segment starting at
Page(0x1000) ... PageAlreadyMapped(PhysFrame(0x400000))
```

내 커널이 아니라 **부트로더가** 패닉한 겁니다. "세그먼트를 메모리에 매핑하려는데 이미 매핑된 자리"라는 뜻입니다. 여기서 진짜 OS 디버깅이 시작됐습니다.

### 4.1 범인 찾기: ELF 헤더 까보기

부트로더가 못 읽는 형태로 커널이 만들어졌다는 의심이 들어, 커널 ELF의 **프로그램 헤더**를 들여다봤습니다.

```bash
llvm-objdump -p target/.../anime_os
```

```
LOAD vaddr 0x0000000000000000 ...
LOAD vaddr 0x00000000000017c0 ...
LOAD vaddr 0x0000000000003508 ...
DYNAMIC off 0x00000000000015d8 ... ← 이게 문제!
```

`DYNAMIC` 세그먼트가 있다는 건 이 커널이 **PIE(Position-Independent Executable, 위치독립 실행파일)** 라는 뜻입니다. 타겟 설정을 확인해 보니:

```
"position-independent-executables": true ← x86_64-unknown-none 내장 타겟의 기본값
```

> Rust 내장 타겟 `x86_64-unknown-none`은 커널을 PIE로 빌드합니다. 그런데 부트로더 0.9는 PIE를 못 읽습니다. 고정 주소 정적 바이너리만 기대하기 때문입니다. 그래서 매핑이 꼬여서 패닉이 난 겁니다. phil-opp 튜토리얼이 커스텀 타겟 JSON을 쓴 이유가 바로 이것입니다. PIE를 끄려는 것입니다.

### 4.2 해결: PIE를 끈 커스텀 타겟

내장 타겟 설정을 그대로 복사하되 **PIE만 끈** 커스텀 타겟을 만들었습니다.

```json
// x86_64-anime_os.json (일부)
{
 "llvm-target": "x86_64-unknown-none-elf",
 "position-independent-executables": false,
 "static-position-independent-executables": false,
 "relocation-model": "static",
 "panic-strategy": "abort",
 "disable-redzone": true,
 "features": "-mmx,-sse,...,+soft-float"
}
```

다시 빌드하니 `DYNAMIC` 세그먼트가 사라지고, 커널이 `0x200000`에 깔끔하게 정렬됐습니다. 정적 비-PIE 바이너리가 곧 부트로더가 읽을 수 있는 형태입니다.

> 참고로 최신 nightly는 `.json` 커스텀 타겟에 `-Zjson-target-spec` 플래그를 요구하고, 스펙의 숫자 필드를 문자열이 아닌 진짜 숫자로 받는 등 **튜토리얼(몇 년 전 작성)과 미묘하게 달라진 부분**이 있었습니다. 이런 버전 드리프트를 직접 메꾸는 게 OS 개발의 일상입니다.

### 4.3 부활

```bash
cargo bootimage
qemu-system-x86_64 -drive format=raw,file=target/.../bootimage-anime_os.bin
```

그리고 맨 위의 그 화면, `Hello World! anime_os booted :)`가 떴습니다.

## 마치며

이번 편에서 한 일을 정리하면:

- x86_64 베어메탈 타겟으로 전환 (`build-std`로 `core` 직접 빌드)
- VGA 텍스트 버퍼(`0xb8000`)에 직접 써서 화면 출력
- 부트로더 연결 + 부팅 이미지 생성
- 부트로더 패닉(PIE 문제)을 ELF 헤더까지 까서 진단·해결

가장 값진 건 마지막 디버깅이었습니다. **"빨간 화면 → 에러 메시지 해석 → ELF 헤더 분석 → 근본 원인(PIE) 발견 → 커스텀 타겟으로 해결"** 이 흐름이야말로 진짜 OS 개발의 맛입니다.

다음 2편에서는 지금 `_start`에 박혀있는 글자 쓰기 코드를, `println!`처럼 편하게 쓸 수 있는 **제대로 된 VGA 출력 모듈**로 발전시킬 겁니다. 줄바꿈·스크롤·색상까지 지원하는 모듈입니다.

> 다음 글: **취미 OS 만들기 #2: println! 매크로 직접 만들기 (예정)**

### 참고 자료

- [Writing an OS in Rust — A Minimal Rust Kernel](https://os.phil-opp.com/minimal-rust-kernel/)
- [Writing an OS in Rust — VGA Text Mode](https://os.phil-opp.com/vga-text-mode/)
- [OSDev Wiki — Bare Bones](https://wiki.osdev.org/Bare_Bones)

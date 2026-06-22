---
title: '취미 OS 만들기 #0 — 왜 Rust로 토이 커널을 시작했나'
titleEn: 'Building a Hobby OS #0 — Why I Started a Toy Kernel in Rust'
description: 덕질 테마 OS를 만들겠다는 목표에서 출발해, 진짜 커널을 바닥부터 짜보기로 한 학습 여정. C·C++·어셈블리·Rust를 비교하고 Rust를 고른 이유, 그리고 macOS(애플 실리콘)에서 첫 베어메탈 빌드 환경을 세팅하기까지를 정리한다.
descriptionEn: The start of a learning journey to build a toy OS kernel from scratch. Comparing C, C++, assembly, and Rust, why I chose Rust, and setting up the first bare-metal build environment on macOS (Apple Silicon).
date: 2026-04-28T00:00:00.000Z
tags:
 - OS
 - Rust
 - Kernel
 - Bare Metal
 - OSDev
category: OS-취미
coverImage: "/uploads/hobby/anime-os-00/cover.svg"
draft: false
series: "취미 OS 만들기"
seriesOrder: 1
---


## 들어가며

"내가 좋아하는 걸 덕질하는 사람들을 위한 OS를 만들고 싶다." 시작은 이 한 문장이었어요.

그런데 막상 "OS를 만든다"가 뭘 의미하는지 파보니, 완전히 다른 두 갈래가 있더라고요.

1. **리눅스 커스텀 배포판** — 우분투·아치 같은 검증된 리눅스에 애니 테마·앱·마스코트를 얹어 "나만의 OS"를 만드는 길. 실제 [Nyarch Linux](https://nyarchlinux.moe/) 같은 "웹덕(weeb)용 배포판"이 다 이 방식이에요.
2. **바닥부터 진짜 커널** — 부팅·메모리·화면 출력부터 C/어셈블리/Rust로 직접 짜는 길.

실제로 쓸 "덕질 테마 OS"는 1번이 정답이에요. 하지만 저는 **OS 내부가 어떻게 도는지 제대로 배우고 싶었어요.** 그래서 이 연재는 두 트랙으로 갑니다.

- **메인 트랙**: 실제 쓸 덕질 테마 OS (리눅스 커스텀) — 나중에
- **학습 트랙**: 토이 커널 바닥부터 (이 글의 주제) — 지금부터

이번 0편은 그 **학습 트랙의 출발점** — 언어 선택과 환경 세팅이에요.

> 이 글은 실제로 제가 환경을 세팅하며 기록한 내용이에요. 명령어와 출력은 macOS(Apple Silicon) 기준입니다.

## 1. OS는 보통 무슨 언어로 만드나

먼저 큰 오해 하나를 풀어야 해요. **어셈블리는 "선택지"가 아니라 "필수 양념"** 입니다.

```
구조는 항상: [메인 언어 거의 전부] + [어셈블리 한 줌]
(실제 리눅스 커널도 C ~98%, 어셈블리는 1%대뿐)
```

뭘 메인으로 쓰든, 부팅 초기나 CPU 레지스터 직접 제어처럼 **고급 언어로 도저히 안 되는 곳**에만 어셈블리를 몇십 줄 끼워 넣어요. "어셈블리로 OS 전체를 짠다"는 건 1970년대 방식이라 요즘은 아무도 안 합니다.

그래서 진짜 고민은 **메인 언어로 C냐, C++이냐, Rust냐** 였어요.

### 1.1 C — 검증된 표준

리눅스 커널이 실제로 쓰는 언어예요(윈도우 NT 커널은 C에 C++도 섞어 씀). [OSDev Wiki](https://wiki.osdev.org/Languages)도 지금까지 C를 1순위로 추천해요.

- **장점**: 자료가 압도적(20년치), 단순해서 "한 줄 한 줄 뭐가 도는지" 예측 가능
- **단점**: 메모리 안전을 컴파일러가 안 지켜줌 → 버그가 "QEMU 무한 리부팅" 같은 형태로 나타나 디버깅이 지옥일 때가 있음

### 1.2 C++ — OS 영역에선 의외로 기피

기능은 C보다 많은데, **커널에선 오히려 피합니다.** 리누스 토르발스가 커널에서 C++을 거부한 이유가 유명해요.

- **숨은 제어 흐름(hidden control flow)**: 소멸자·연산자 오버로딩이 코드에 안 보이는 데서 멋대로 실행됨. 커널은 "정확히 뭐가 도는지"가 생명이라 이게 치명적
- 표준 라이브러리가 불안정 + C와 미묘한 비호환

> 출처: [Why did Linux choose Rust not C++? (Lobsters)](https://lobste.rs/s/bzcqjr/why_did_linux_choose_rust_not_c)

### 1.3 Rust — 현대적, 안전성이 무기

- **장점**: 빠르면서 **메모리 안전을 동시에** 제공. 댕글링·널 포인터를 컴파일 단계에서 차단. **리눅스 커널이 새 서브시스템에 공식 채택한 유일한 신규 언어**예요
- **단점**: 문법 학습 곡선, 가이드 밖으로 나가면 자료가 C보다 적음

## 2. 그래서 왜 Rust였나

세 가지 기준이 전부 한 방향을 가리켰어요.

| 기준 | 결론 |
|---|---|
| **OS 학습용으로** | C 또는 Rust (C++은 OS에 안 맞음) |
| **범용성·미래성** | Rust ("신규 프로그래머는 future-proof를 위해 Rust 우선") |
| **내 환경(애플 실리콘 맥)** | Rust (툴체인 마찰 0) |

특히 **환경 문제**가 결정적이었어요.

> 내 맥은 ARM 칩인데, OS 튜토리얼은 99%가 x86(인텔) 기준이에요. C로 가면 x86용 크로스 컴파일러(i686-elf-gcc)를 직접 구해야 하는데, ARM 맥에선 소스 빌드까지 가는 삽질이 흔해요. 반면 Rust는 `--target` 플래그 한 줄로 타겟을 바꿔서 별도 컴파일러가 필요 없어요. 애플 실리콘에선 이 차이가 결정적이었죠.

여기에 [Philipp Oppermann의 "Writing an OS in Rust"](https://os.phil-opp.com/) 2판이 **Windows·macOS·Linux에서 "Rust 외 의존성 0개"로 빌드**된다는 점이 쐐기를 박았어요(빌드엔 Rust 툴체인만 있으면 되고, 실행에만 QEMU가 필요해요). 전통적으로 OS 입문의 첫날 절반을 잡아먹던 "환경 세팅 지옥"을 통째로 없앤 거죠.

> 결론: 객관적 "최고의 언어"는 없어요. 하지만 **"애플 실리콘 + OS 첫 도전 + 학습 목적"** 이라는 내 상황에선 Rust가 명확한 정답이었습니다.

## 3. 환경 세팅 (0단계)

목표는 단순해요. **`std`(표준 라이브러리) 없이 컴파일되는 베어메탈 바이너리**를 만드는 것.

### 3.1 왜 `std`를 떼어내야 하나

> 평소 Rust 프로그램은 맨 위에 안 보이는 `std`가 깔려 있어요. `println!`, `Vec`, `String` 모두 std가 OS한테 부탁해서 동작하죠. 그런데 우리가 만드는 게 바로 그 OS라서 부탁할 대상이 없어요. 그래서 std를 떼어내야(`#![no_std]`) 하는데, 이게 OS 코딩의 첫 관문입니다.

### 3.2 Rust 설치 (rustup)

Rust는 brew로도 깔 수 있지만, OS 개발은 **반드시 `rustup`** 으로 깔아야 해요. 베어메탈 커널은 nightly 컴파일러 + 특수 컴포넌트가 필요한데, 이 전환을 rustup만 관리해주거든요.

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
. "$HOME/.cargo/env"

# 베어메탈 빌드용 nightly + 컴포넌트
rustup toolchain install nightly --profile minimal
rustup component add rust-src --toolchain nightly # core 라이브러리 소스
rustup component add llvm-tools-preview --toolchain nightly # 부트이미지 생성용
```

여기에 가상 머신 `QEMU`만 있으면 돼요. (`brew install qemu`)

> 진짜 하드웨어 대신 QEMU를 쓰는 이유는 간단해요. 커널이 죽어도 창만 닫으면 되거든요. 실기로 하면 매번 USB를 굽고 재부팅해야 해서 개발이 거의 불가능해요. 결국 "QEMU로 x86 컴퓨터를 흉내 내고, 그 안에서 내 커널을 돌린다"는 구조입니다.

### 3.3 프로젝트 골격

세 파일이면 출발선에 서요.

**`Cargo.toml`** — 패닉 시 "스택 되감기(unwinding)"를 끕니다. 되감기는 std/OS 기능이라 베어메탈에선 못 써요.

```toml
[profile.dev]
panic = "abort"

[profile.release]
panic = "abort"
```

**`rust-toolchain.toml`** — 이 폴더에선 자동으로 nightly를 쓰게 고정.

```toml
[toolchain]
channel = "nightly"
components = ["rust-src", "llvm-tools-preview"]
```

**`src/main.rs`** — 커널의 심장.

```rust
#![no_std] // std를 떼어낸다
#![no_main] // Rust의 일반 시작 절차도 떼어낸다

use core::panic::PanicInfo;

// 커널의 진짜 시작점.
// no_mangle: 이름을 "_start" 그대로 유지(부트로더가 이 이름을 찾음)
// extern "C": C 호출 규약 사용
// -> ! : 절대 리턴하지 않음(돌아갈 OS가 없으니까)
#[no_mangle]
pub extern "C" fn _start() -> ! {
 loop {}
}

// std가 제공하던 패닉 핸들러를 직접 만들어야 한다.
#[panic_handler]
fn panic(_info: &PanicInfo) -> ! {
 loop {}
}
```

### 3.4 여기서 배우는 진짜 교훈

이 짧은 코드에 OS 코딩의 본질이 들어있어요.

- **`-> !` (never type)**: `_start`도 `panic`도 "절대 리턴하지 않음"을 타입으로 강제해요. 일반 프로그램은 끝나면 OS로 돌아가지만, 커널은 **돌아갈 곳이 자기 자신**이라 끝이 없어요.
- **패닉 핸들러를 직접 짠다**: 일반 앱은 패닉나면 std가 에러 찍고 종료시켜줘요. 커널은 종료시켜줄 OS가 없으니 **"무한 루프로 멈춘다"는 안전망을 직접** 만들어야 해요.

> 커널엔 안전망이 없어요. std도, "프로그램 종료"도, 돌아갈 상위 시스템도 없죠. 이 감각을 코드 몇 줄로 처음 체감하는 게 0단계의 진짜 수확이에요.

## 마치며

0단계 완료 — **언어를 정하고(Rust), 베어메탈 빌드 환경을 세웠어요.** 아직 화면엔 아무것도 안 떠요. `_start`가 그냥 무한 대기 중이거든요.

다음 1편에서는 드디어 **화면에 글자를 띄웁니다.** 부트로더가 내 `_start`로 점프하게 만들고, VGA 텍스트 버퍼에 직접 글자를 써서 QEMU 창에 첫 메시지를 출력할 거예요. "Hello World"가 이렇게 감격스러운 분야도 드뭅니다.

> 다음 글: **취미 OS 만들기 #1 — 부팅부터 키보드 입력까지**

### 참고 자료

- [Writing an OS in Rust — Philipp Oppermann](https://os.phil-opp.com/)
- [OSDev Wiki](https://wiki.osdev.org/)
- [Nyarch Linux (애니 테마 배포판 사례)](https://nyarchlinux.moe/)

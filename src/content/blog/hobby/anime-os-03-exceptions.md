---
title: '취미 OS 만들기 #3: CPU 예외 처리와 안전망 (IDT/GDT)'
titleEn: 'Building a Hobby OS #3 — CPU Exceptions and Safety Nets (IDT/GDT)'
description: 커널이 0으로 나누기 같은 CPU 예외에 그냥 죽지 않도록 안전망을 만든다. IDT에 예외 핸들러를 등록하고, GDT/TSS로 더블 폴트용 비상 스택을 마련해 트리플 폴트(리부팅)를 막는다.
descriptionEn: Building a safety net so the kernel does not just die on CPU exceptions like divide-by-zero. Registering exception handlers in the IDT, and setting up a dedicated double-fault stack via GDT/TSS to prevent triple faults.
date: 2026-06-22T00:00:00.000Z
tags:
 - OS
 - Rust
 - Kernel
 - IDT
 - GDT
 - Exception
category: OS-취미
coverImage: "/uploads/hobby/anime-os-03/exceptions-idt.png"
draft: false
series: "취미 OS 만들기"
seriesOrder: 4
---


## 들어가며

[2편](#)까지 화면 출력은 완성됐습니다. 하지만 우리 커널엔 치명적 약점이 있었습니다. **0으로 나누기, 잘못된 메모리 접근 같은 CPU 예외가 나면 그냥 죽어버린다**는 겁니다. 그것도 에러 메시지 한 줄 없이 리부팅 무한 반복(triple fault)으로요.

이번 3편의 목표는 **안전망 만들기**입니다. CPU 예외가 나도 커널이 잡아서 메시지를 출력하고 (가능하면) 복귀하게 만듭니다. 결과부터 보면:

![브레이크포인트 예외를 잡아 스택 정보를 출력하고 정상 복귀한 모습](/uploads/hobby/anime-os-03/exceptions-idt.png)

브레이크포인트 예외를 일부러 발생시켰는데, 핸들러가 잡아서 스택 정보를 출력하고 **그 아래 "It did not crash"까지 정상 실행**됐습니다. 예외를 처리하고 복귀한 겁니다.

## 1. IDT: "이 예외엔 이 함수를 불러라"

**IDT(Interrupt Descriptor Table)** 는 256개의 예외/인터럽트 번호마다 "어떤 핸들러를 부를지" 적어둔 표입니다. CPU가 예외를 만나면 이 표를 보고 해당 함수로 점프합니다.

```rust
lazy_static! {
 static ref IDT: InterruptDescriptorTable = {
 let mut idt = InterruptDescriptorTable::new();
 idt.breakpoint.set_handler_fn(breakpoint_handler);
 idt
 };
}

extern "x86-interrupt" fn breakpoint_handler(stack_frame: InterruptStackFrame) {
 println!("EXCEPTION: BREAKPOINT\n{:#?}", stack_frame);
}
```

> `extern "x86-interrupt"`는 인터럽트 핸들러 전용 호출 규약입니다. 일반 함수와 달리 모든 레지스터를 보존하고 `iretq`로 복귀하는 특수 방식이 필요해서, 컴파일러에게 이걸 명시해 줍니다. 핸들러가 받는 `InterruptStackFrame`엔 예외가 난 시점의 명령어 주소, 스택 포인터, CPU 플래그 등이 담겨서 디버깅의 핵심 단서가 됩니다.

## 2. 더블 폴트: 예외 처리 중 또 예외나면?

여기서 까다로운 문제가 있습니다. **예외 핸들러를 실행하는 도중에 또 예외가 나면?** 예를 들어 스택이 망가진 상태라면, 핸들러가 그 망가진 스택을 쓰려다 또 죽습니다. 이게 **더블 폴트**고, 더블 폴트 처리 중 또 죽으면 **트리플 폴트(리부팅)** 입니다.

> 스택이 망가진 게 원인인 예외인데 핸들러마저 그 망가진 스택을 쓴다면, 핸들러조차 죽어서 트리플 폴트(리부팅)로 이어집니다. 그래서 더블 폴트 핸들러만큼은 보장된 깨끗한 별도 스택에서 실행되게 해야 합니다.

## 3. GDT/TSS: 비상 스택 마련

이 "보장된 깨끗한 스택"을 마련하는 게 **GDT(Global Descriptor Table)** 와 **TSS(Task State Segment)** 의 역할입니다. TSS의 **IST(Interrupt Stack Table)** 에 비상 스택을 등록하고, 더블 폴트 핸들러가 그걸 쓰도록 지정합니다.

```rust
// gdt.rs — 더블 폴트용 비상 스택(20KB)을 IST 0번에 등록
tss.interrupt_stack_table[DOUBLE_FAULT_IST_INDEX as usize] = {
 const STACK_SIZE: usize = 4096 * 5;
 static mut STACK: [u8; STACK_SIZE] = [0; STACK_SIZE];
 let stack_start = VirtAddr::from_ptr(&raw const STACK);
 stack_start + STACK_SIZE as u64
};
```

```rust
// interrupts.rs — 더블 폴트 핸들러가 그 비상 스택을 쓰도록 지정
unsafe {
 idt.double_fault
 .set_handler_fn(double_fault_handler)
 .set_stack_index(gdt::DOUBLE_FAULT_IST_INDEX);
}
```

> GDT는 원래 메모리 세그먼트를 나누던 옛 메커니즘이라 64비트 모드에선 거의 안 쓰는데, TSS를 등록하는 통로로는 여전히 필요합니다. IST는 "이 인터럽트는 무조건 이 주소의 스택에서 처리하라"를 하드웨어 수준에서 보장하는데, 망가진 스택을 우회하는 핵심 장치입니다.

## 4. 조립

`main.rs`에서 순서대로 초기화하고, 브레이크포인트 예외를 일부러 발생시켜 테스트합니다.

```rust
gdt::init(); // GDT/TSS 로드 (비상 스택 등록)
interrupts::init_idt(); // 예외 핸들러 등록

x86_64::instructions::interrupts::int3(); // 브레이크포인트 예외 발생!

println!("It did not crash :)"); // 핸들러가 복귀하면 여기 도달
```

맨 위 스크린샷이 그 결과입니다. 예외 → 핸들러 → 복귀 → 다음 코드 실행. 안전망이 작동합니다.

## 마치며

- IDT에 브레이크포인트 예외 핸들러 등록
- 더블 폴트 핸들러 + GDT/TSS 비상 스택으로 트리플 폴트 방지
- 예외를 잡아 정보를 출력하고 정상 복귀하는 흐름 검증

이제 커널이 예외에 죽지 않고 **대응**할 수 있습니다. 그리고 이 IDT 인프라는 다음 편의 핵심 토대가 됩니다.

다음 4편은 **졸업 편**입니다. 이 IDT 위에 **하드웨어 인터럽트와 키보드 입력**을 붙여서, 드디어 사용자와 상호작용하는 "진짜 OS"를 만듭니다.

> 다음 글: **취미 OS 만들기 #4: 하드웨어 인터럽트와 키보드 입력 (졸업)**

### 참고 자료

- [Writing an OS in Rust — CPU Exceptions](https://os.phil-opp.com/cpu-exceptions/)
- [Writing an OS in Rust — Double Faults](https://os.phil-opp.com/double-fault-exceptions/)
- [OSDev Wiki — Interrupt Descriptor Table](https://wiki.osdev.org/Interrupt_Descriptor_Table)

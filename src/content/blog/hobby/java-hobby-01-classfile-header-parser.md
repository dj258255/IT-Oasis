---
title: '.class 파일을 읽다: 헤더 파서 첫 코드'
description: 토이 JVM의 첫 코드. .class 파일의 맨 앞 16바이트를 직접 읽어 매직 넘버 0xCAFEBABE, 버전, constant pool 개수를 꺼낸다. 헥스 덤프로 포맷을 눈으로 확인하고, .class의 모든 정수가 빅엔디언이라는 점에서 출발해 u1/u2/u4 바이트 리더를 세운 뒤, C로 헤더 파서와 빌드 골격(Makefile)까지 만든 과정을 정리한다.
date: 2026-07-02T00:00:00.000Z
tags:
  - JVM
  - C
  - Bytecode
  - Class File
category: study/java-hobby
draft: true
series: "C로 만드는 토이 JVM"
seriesOrder: 2
---

*바닥부터 직접 만드는 토이 JVM 연재. 이 글은 2편, 첫 코드인 `.class` 헤더 파서. ([1편: 설계 결정들](/blog/hobby/java-hobby-00-why-and-architecture))*

## 0. 들어가며

커널의 첫 단추가 "전원 들어온 CPU에서 첫 글자 찍기"였다면, JVM의 첫 단추는 **`.class` 파일에서 첫 숫자를 읽어내는 것**입니다. JVM이 하는 모든 일, 그러니까 인터프리터·GC·JIT는 전부 "`.class`를 메모리 위 구조로 읽는" 위에 쌓이기 때문입니다. 그래서 가장 작지만 토대가 되는 이 단계부터 시작했습니다.

이번 글의 목표는 딱 하나입니다. **`.class` 파일의 맨 앞 헤더를 읽어, 이게 진짜 클래스 파일인지 확인하고 버전과 constant pool 개수를 찍는 것**입니다.

## 1. 먼저 `.class`를 하나 만든다

파싱 대상이 있어야 하니, 가장 단순한 클래스를 [1편에서 정한 대로](/blog/hobby/java-hobby-00-why-and-architecture#3-부트스트랩-닭과-달걀) **실제 javac로** 컴파일했습니다.

```java
// test/Hello.java
public class Hello {
    public static void main(String[] args) {
        System.out.println("Hello");
    }
}
```

```sh
$ javac test/Hello.java     # 실제 javac로 .class 생성 (부트스트랩)
$ ls test/Hello.class
```

## 2. 포맷을 눈으로 본다: 헥스 덤프

`.class`는 잘 정의된 바이너리 포맷입니다(커널에서 본 ELF랑 비슷한 감각). 손으로 한번 읽어보는 게 제일 빠릅니다.

```sh
$ xxd test/Hello.class | head -2
00000000: cafe babe 0000 0045 001c 0a00 0200 0307  .......E........
00000010: 0004 0c00 0500 0601 0010 6a61 7661 2f6c  ..........java/l
```

[JVM 명세 4장](https://docs.oracle.com/javase/specs/jvms/se21/html/jvms-4.html)에 따르면 `ClassFile`은 이렇게 시작합니다. 앞 10바이트를 끊어 읽어 보겠습니다.

```
ca fe ba be   magic              = 0xCAFEBABE   ← "진짜 .class다"
00 00         minor_version      = 0
00 45         major_version      = 0x45 = 69     ← Java 25 (69 - 44)
00 1c         constant_pool_count= 0x1c = 28
```

세 가지가 눈에 들어옵니다.

- **`0xCAFEBABE`**: 모든 `.class`의 첫 4바이트입니다. 자바 초창기 개발자들의 농담 섞인 매직 넘버입니다("cafe babe"). 이게 아니면 클래스 파일이 아닙니다.
- **major_version 69**: `major - 44`가 Java 버전입니다(52=Java 8, 61=Java 17, 69=Java 25). 컴파일에 쓴 javac가 25라 69가 나왔습니다.
- **constant_pool_count 28**: 곧 만날 상수 풀의 크기인데, 여기 **첫 함정**이 있습니다.

> `constant_pool_count`는 실제 엔트리 수보다 1 큰 값, 즉 **"엔트리 수 + 1"** 입니다. 상수 풀이 **1번부터** 시작하는 1-기반 인덱스라서 그렇습니다(0번은 "없음"용으로 비워둠). 그래서 28이면 실제 엔트리는 27개입니다. 이 +1, 그리고 Long/Double이 슬롯을 2개 먹는 규칙이 초심자 파서를 가장 많이 무너뜨리는 두 함정입니다. (상수 풀은 [다음 글](#7-마무리)에서 본격적으로 다룹니다.)

## 3. 핵심 감각: `.class`는 빅엔디언이다

코드를 짜기 전에 딱 하나만 짚고 가겠습니다. **`.class`의 모든 정수는 빅엔디언(big-endian)** 입니다. 상위 바이트가 먼저 저장된다는 뜻입니다.

2바이트 값 `0xCAFE`를 보면, 파일엔 `0xCA`(상위)·`0xFE`(하위) 순서로 들어 있습니다. 이걸 하나의 숫자로 되돌리려면 **먼저 읽은 바이트를 더 높은 자리로 올려서** 합쳐야 합니다.

```
바이트열:   0xCA   0xFE
            ↑상위   ↑하위
합치기:     (0xCA << 8) | 0xFE  =  0xCAFE
```

이 한 줄이 `.class` 파싱 전체의 토대입니다. 매직 4바이트도, constant pool 인덱스 2바이트도, 메서드 바이트코드 길이 4바이트도 전부 이 규칙으로 읽기 때문입니다. 그래서 제일 먼저 **바이트 커서 + u1/u2/u4 리더**를 만들었습니다.

## 4. 코드: 바이트 리더와 헤더 파서

구조는 OpenJDK를 닮아 `src/hotspot/share/` 아래 뒀습니다([1편의 구조](/blog/hobby/java-hobby-00-why-and-architecture#5-구조-실제-openjdk를-닮기로) 참고).

### 바이트 커서

```c
// src/hotspot/share/classfile/reader.h
typedef struct {
    const uint8_t *data;  // 파일 전체 바이트
    size_t len;           // 전체 길이
    size_t pos;           // 현재 읽는 위치
} Reader;

uint8_t  read_u1(Reader *r);
uint16_t read_u2(Reader *r);  // 빅엔디언
uint32_t read_u4(Reader *r);  // 빅엔디언
```

`read_u1`은 한 바이트 읽고 커서를 한 칸 전진시키는 게 전부입니다. 그 위에서 `u2`·`u4`를 빅엔디언으로 합칩니다.

```c
// src/hotspot/share/classfile/reader.c
uint8_t read_u1(Reader *r) {
    if (r->pos >= r->len) return 0;     // 범위 밖이면 0 (검증은 추후 강화)
    return r->data[r->pos++];
}

uint16_t read_u2(Reader *r) {
    uint16_t b1 = read_u1(r);           // 먼저 읽은 바이트가 상위
    uint16_t b2 = read_u1(r);
    return (b1 << 8) | b2;
}

uint32_t read_u4(Reader *r) {
    uint32_t b1 = read_u1(r);
    uint32_t b2 = read_u1(r);
    uint32_t b3 = read_u1(r);
    uint32_t b4 = read_u1(r);
    return (b1 << 24) | (b2 << 16) | (b3 << 8) | b4;
}
```

> 사소해 보이지만 `u4`에서 `(uint32_t)`로 폭을 키워 두는 게 중요합니다. `uint8_t`끼리 `<< 24`를 하면 중간 계산이 `int`로 좁아져 상위 비트가 날아갈 수 있기 때문입니다. 매직 `0xCAFEBABE`는 최상위 비트가 켜져 있어서, 폭을 안 키우면 값이 깨집니다.

### 헤더 파서

이제 커서로 헤더를 순서대로 읽습니다. 명세 순서(`magic → minor → major → cp_count`)를 그대로 따라가면 됩니다.

```c
// src/hotspot/share/classfile/classfile.c
#define CLASSFILE_MAGIC 0xCAFEBABEu

int classfile_parse_header(const uint8_t *data, size_t len, ClassFileHeader *out) {
    Reader r = { data, len, 0 };

    out->magic = read_u4(&r);
    if (out->magic != CLASSFILE_MAGIC) {
        return -1;                      // 0xCAFEBABE가 아니면 .class가 아니다
    }
    out->minor_version       = read_u2(&r);
    out->major_version       = read_u2(&r);
    out->constant_pool_count = read_u2(&r);
    return 0;
}
```

`main`은 파일을 통째로 버퍼에 읽고, 이 함수를 불러 결과를 찍습니다(파일 읽기·출력은 평범한 C라 본문에선 생략).

## 5. 빌드 골격: Makefile

빌드는 레포 루트의 `Makefile` 하나로 시작했습니다. 지금은 `hotspot`만, 나중에 `java.base`·`jdk.compiler` 타깃을 붙일 자리입니다.

```make
CFLAGS = -std=c11 -Wall -Wextra -g -Isrc/hotspot/share
HOTSPOT_SRC = $(wildcard src/hotspot/share/*.c src/hotspot/share/classfile/*.c)

hotspot: jvm                 ## JVM 빌드 -> ./jvm
jvm: $(HOTSPOT_SRC:.c=.o)
	$(CC) $(CFLAGS) -o $@ $^
```

## 6. 실행: 첫 글자를 읽다

```sh
$ make hotspot
$ ./jvm test/Hello.class
magic               = 0xCAFEBABE
minor_version       = 0
major_version       = 69  (Java 25)
constant_pool_count = 28
```

헥스 덤프에서 손으로 읽었던 값(`cafe babe`, `0045`=69, `001c`=28)이 그대로 찍힙니다. 작아 보여도, 이게 **"내 JVM이 진짜 `.class`를 읽는다"** 는 첫 증거입니다. 매직이 안 맞으면 이렇게 거부하고요.

```sh
$ ./jvm Makefile
.class 파일이 아닙니다 (magic=0x6F742023, 기대=0xCAFEBABE)
```

## 7. 마무리

회고하면, 이 단계의 진짜 알맹이는 헤더 4개 필드보다 **빅엔디언 리더 두 함수**에 있었습니다. 앞으로 constant pool, 필드, 메서드, 바이트코드까지 전부 이 `read_u2`/`read_u4` 위에 쌓이기 때문입니다. 토대를 먼저 단단히 깐 셈입니다.

다음 글은 **constant pool**입니다. `.class`에서 가장 크고, 모든 이름·문자열·참조가 모여 사는 곳입니다. 여기서 그 악명 높은 두 함정(1-기반 인덱스, Long/Double 2슬롯)을 정면으로 만납니다. 거기까지 읽으면 클래스 이름과 메서드 목록을 진짜로 꺼낼 수 있게 됩니다.

(코드 전체는 [저장소](https://github.com/dj258255/java-hobby)의 `src/hotspot/share/classfile`에 있습니다.)

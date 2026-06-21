---
title: '진짜 데이터베이스를 C로 밑바닥부터 해부하기 — minidb를 시작하며'
titleEn: 'Dissecting a Real Database from Scratch in C — Starting minidb'
description: "PostgreSQL·MySQL이 내부에서 어떻게 동작하는지 제대로 이해하고 싶어서, 그 구조를 C로 한 겹씩 직접 구현하기로 했다. 새로운 걸 발명하려는 게 아니라 진짜를 정확히 재현하는 학습 프로젝트. 첫 글은 모든 것이 그 위에 쌓이는 맨 밑바닥 — 페이지와 디스크 관리자(Pager)."
descriptionEn: "To really understand how PostgreSQL and MySQL work inside, I decided to rebuild their structure in C, one layer at a time. Not to invent something new, but to reproduce the real thing accurately. This first post covers the very bottom that everything else sits on: pages and the disk manager (Pager)."
date: 2026-06-22
tags:
  - C
  - Database Internals
  - Storage Engine
  - Learning
  - Devlog
category: project/minidb
coverImage: /uploads/project/minidb/cover.svg
draft: false
series: "minidb"
seriesOrder: 1
---

데이터베이스를 직접 만들어보고 싶었다. 처음엔 "세상에 없는 새로운 DB"를 찾아 한참 헤맸는데, 파고들수록 분명해진 게 있다. DB든 검색엔진이든 인프라 영역은 거의 다 누군가 이미 잘 만들어놨고, "아무도 안 한 빈칸"은 사실상 유니콘이다. 그래서 목표를 바꿨다. 새로운 걸 발명하는 대신, **이미 있는 진짜를 정확히 재현하면서 그 구조를 손으로 이해하기.**

그렇게 시작한 게 minidb다. PostgreSQL·MySQL 같은 관계형 DB가 내부에서 어떻게 동작하는지를, C로 한 겹씩 직접 구현하며 해부하는 학습 프로젝트다.

## 진짜 DB를 해부하면 나오는 계층들

DB는 한 덩어리가 아니라 여러 계층의 합이다. 위에서 아래로 이렇게 쌓여 있다.

```
 SQL 텍스트
   │
   ▼ [1] Parser      토크나이저 + 파서 → AST
   ▼ [2] Planner     AST → 실행 계획 (풀스캔 vs 인덱스)
   ▼ [3] Executor    계획 실행 (Volcano/iterator 모델)
   │
   ▼ [4] Catalog     시스템 테이블 (스키마 메타데이터)        ← pg_catalog
   │
   ▼ [5] Access      Heap(테이블) + B-Tree(인덱스)
   ▼ [6] Buffer Pool 페이지 캐시 + 교체(LRU)                  ← InnoDB buffer pool
   ▼ [7] Page        슬롯 페이지: 행을 고정 크기 페이지에 패킹
   ▼ [8] Pager/Disk  페이지 ↔ 단일 파일 (고정 크기 I/O)
   │
   ▼ [9] WAL/Txn     쓰기 선행 로그 + MVCC/락 (고급)
```

핵심 사실 하나만 기억하면 된다. **모든 것은 "고정 크기 페이지" 위에 쌓인다.** PostgreSQL은 8KB, MySQL InnoDB는 16KB, SQLite는 4KB 페이지가 기본이다. 디스크는 페이지 단위로만 읽고 쓰고, 그 위에 슬롯 페이지 → 힙/B-Tree → 버퍼풀 → 실행기가 차곡차곡 얹힌다. 그래서 맨 아래(Pager)부터 짓는다. 위층이 전부 이걸 딛고 서니까.

## 왜 C인가

언어를 한참 고민했는데, 목표가 "진짜 구조를 있는 그대로 해부"라면 답은 명확했다. **진짜 DB가 쓰는 언어로 하는 것.** PostgreSQL·SQLite·MySQL이 전부 C/C++다.

DB 내부는 메모리·포인터·바이트 레이아웃이 곧 학습 내용이다. "페이지를 버퍼에 올리고, 슬롯에 바이트를 패킹하고, 포인터로 B-Tree를 따라간다" — 이게 DB의 본질인데, 언어가 이걸 추상화로 가려버리면 정작 배우려는 걸 못 본다. C는 아무것도 안 가린다. segfault와 씨름하는 것조차 "DB가 왜 이렇게 메모리를 다루나"를 몸으로 배우는 과정이다.

## 1단계 — Pager: 페이지를 디스크에 어떻게 읽고 쓰나

가장 밑바닥. Pager는 딱 하나만 책임진다. *"page_id로 페이지를 읽고 쓴다."*

페이지를 고정 크기로 잡으면, N번 페이지가 파일의 어디에 사는지는 곱셈 한 번으로 정해진다.

```c
off_t offset = (off_t)page_id * PAGE_SIZE;   // N번 페이지 = N * 4096 바이트 위치
```

읽기·쓰기는 `pread`/`pwrite`로 그 위치를 직접 지정한다. `lseek`로 위치를 옮기고 `read`하는 것과 달리, offset을 인자로 줘서 한 번에 끝낸다(스레드 안전하기도 하다).

```c
int pager_read(Pager *pager, page_id_t page_id, void *buf) {
    off_t offset = (off_t)page_id * PAGE_SIZE;
    ssize_t n = pread(pager->fd, buf, PAGE_SIZE, offset);
    return (n == (ssize_t)PAGE_SIZE) ? 0 : -1;
}

int pager_write(Pager *pager, page_id_t page_id, const void *buf) {
    off_t offset = (off_t)page_id * PAGE_SIZE;
    ssize_t n = pwrite(pager->fd, buf, PAGE_SIZE, offset);
    return (n == (ssize_t)PAGE_SIZE) ? 0 : -1;
}
```

다섯 줄짜리지만, 이 곱셈 하나가 PostgreSQL·MySQL·SQLite가 전부 그 위에 서 있는 토대다. 새 페이지 할당은 그냥 파일 끝에 빈 페이지를 한 장 더 쓰는 것이고, 파일 크기를 페이지 크기로 나누면 현재 페이지 수가 나온다.

검증은 두 가지를 본다. 쓴 내용이 그대로 읽히는가(라운드트립), 그리고 프로그램을 껐다 켜도 살아있는가(영속성). 후자가 메모리 자료구조와 DB를 가르는 지점이다.

![make test 결과 — pager 테스트 11개 모두 통과, 재오픈 후 내용 유지 포함](/uploads/project/minidb/pager-test-output.svg)

`재오픈 시 2 페이지`, `재오픈 후 페이지 0 내용 유지` 가 통과한다는 건, 파일에 진짜로 영속화됐다는 뜻이다. 이게 데이터베이스의 출발점이다.

## 다음

다음은 [2] 슬롯 페이지다. 지금은 페이지가 그냥 4096바이트 덩어리지만, 실제 DB는 그 안을 *슬롯 디렉터리 + 가변 길이 행*으로 나눠 여러 레코드를 패킹한다. 행을 어떻게 페이지에 욱여넣고, 지우고, 빈 공간을 추적하는지 — PostgreSQL과 InnoDB의 페이지 레이아웃을 그대로 따라 만들어볼 생각이다.

> 이 시리즈는 진짜 DB의 내부 구조를 C로 한 겹씩 재현하며 기록한다. 목표는 새로움이 아니라, 끝까지 내려가 보는 것이다.

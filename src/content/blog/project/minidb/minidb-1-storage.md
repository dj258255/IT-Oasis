---
title: '저장 계층: 페이지에서 힙까지'
titleEn: 'The Storage Layer: From Pages to the Heap'
description: "PostgreSQL·MySQL이 내부에서 어떻게 동작하는지 이해하려고 관계형 DB를 C로 밑바닥부터 만든 minidb 시리즈. 1편은 가장 아래 저장 계층 — 고정 크기 페이지를 디스크에 읽고 쓰는 페이저, 가변 길이 행을 페이지에 욱여넣는 슬롯 페이지, 디스크를 매번 때리지 않게 하는 버퍼 풀(pin/dirty/LRU), 그리고 이 셋을 묶어 만든 첫 테이블인 힙 파일까지 직접 구현한다."
descriptionEn: "minidb is a relational database built from scratch in C to understand how PostgreSQL and MySQL work inside. Part 1 builds the storage layer from the bottom: a pager that reads/writes fixed-size pages, slotted pages that pack variable-length rows, a buffer pool (pin/dirty/LRU), and the heap file that ties them into a first table."
date: 2026-06-22
tags:
  - C
  - Database Internals
  - Storage Engine
  - Buffer Pool
  - Learning
category: project/minidb
coverImage: /uploads/project/minidb/cover.svg
draft: false
series: "minidb"
seriesOrder: 1
---

데이터베이스를 직접 만들어보고 싶었다. 처음엔 "세상에 없는 새로운 DB"를 찾아 한참 헤맸는데, 파고들수록 분명해진 게 있다. 인프라 영역은 거의 다 누군가 이미 잘 만들어놨고, "아무도 안 한 빈칸"은 사실상 유니콘이다. 그래서 목표를 바꿨다. 새로운 걸 발명하는 대신, **이미 있는 진짜를 정확히 재현하면서 그 구조를 손으로 이해하기.**

그렇게 만든 게 **minidb** 다. PostgreSQL·MySQL 같은 관계형 DB가 내부에서 어떻게 동작하는지를, C로 한 겹씩 직접 구현하며 해부한 학습 프로젝트다. 이 시리즈는 페이저부터 트랜잭션·조인·집계까지 밑바닥부터 쌓아 올린 전 과정을 다섯 편으로 나눠 담는다(전 계층 테스트 209개). 그 첫 편인 이 글은 맨 아래 — 바이트를 디스크에 얹는 **저장 계층** 을 짓는다.

## 전체 지도

DB는 한 덩어리가 아니라 여러 계층의 합이다. 위에서 아래로 이렇게 쌓인다.

![minidb 계층 지도 — SQL 텍스트가 파서·플래너·실행기를 거쳐 카탈로그·접근(힙/B-Tree)·버퍼풀·페이지·페이저로 내려가고, WAL이 내구성을 받친다](/uploads/project/minidb/layer-map.svg)

핵심 사실: **모든 것은 고정 크기 페이지 위에 쌓인다.** (PostgreSQL 8KB, MySQL InnoDB 16KB, SQLite 4KB.) 그래서 맨 아래(페이저)부터 짓는다. 이번 편은 [8]~[5] 네 계층을 만든다.

**왜 C인가.** 목표가 "진짜 구조를 있는 그대로 해부"라면, 진짜 DB가 쓰는 언어로 하는 게 맞다. DB 내부는 메모리·포인터·바이트 레이아웃이 곧 학습 내용인데, 언어가 이걸 추상화로 가리면 정작 배우려는 걸 못 본다. C는 아무것도 안 가린다.

---

## 페이저 — 페이지를 디스크에 읽고 쓰기

가장 밑바닥. 페이저는 "page_id로 페이지를 읽고 쓴다"만 책임진다. 페이지를 고정 크기로 잡으면 N번 페이지의 디스크 위치는 곱셈 한 번으로 정해진다.

```c
int pager_read(Pager *p, page_id_t id, void *buf) {
    off_t offset = (off_t)id * PAGE_SIZE;   // N번 페이지 = N * 4096
    ssize_t n = pread(p->fd, buf, PAGE_SIZE, offset);
    return (n == (ssize_t)PAGE_SIZE) ? 0 : -1;
}
```

다섯 줄짜리 이 곱셈이 PostgreSQL·MySQL·SQLite가 전부 그 위에 서 있는 토대다.

![페이저 테스트 — 라운드트립 + 재오픈 영속성 11개 통과](/uploads/project/minidb/pager-test-output.svg)

## 슬롯 페이지 — 4096바이트 안에 행 욱여넣기

페이지는 아직 그냥 바이트 덩어리다. 가변 길이 행 여러 개를 한 페이지에 넣으려면 **슬롯 페이지** 가 필요하다. PostgreSQL heap·InnoDB 페이지가 이 구조다. 헤더 뒤로 슬롯 배열이 아래로 자라고, 레코드는 끝에서 위로 자라며, 가운데가 빈 공간이다.

![슬롯 페이지 레이아웃 — 슬롯 배열은 아래로, 레코드는 위로, 가운데 빈 공간](/uploads/project/minidb/slotted-page-layout.svg)

묘수는 **슬롯 번호가 행의 안정적인 주소**가 된다는 것이다. 레코드가 페이지 안에서 옮겨져도 슬롯 번호는 안 바뀐다 — 이게 PostgreSQL의 TID, InnoDB 레코드 포인터의 기반이다.

## 버퍼 풀 — 디스크를 매번 때리지 않기

페이지를 매번 디스크에서 읽으면 느리다. 버퍼 풀은 자주 쓰는 페이지를 메모리에 캐시하고 꽉 차면 LRU로 교체한다(InnoDB buffer pool). 단순 캐시와 DB 버퍼 풀의 차이는 세 가지다: **pin count**(쓰는 중인 페이지는 못 쫓아냄), **dirty 플래그**(수정된 페이지는 쫓겨나기 전에 디스크로 flush), **LRU**(가장 안 쓴 걸 victim으로).

![버퍼 풀 — 프레임(page/pin/dirty/LRU), miss는 디스크 로드, dirty면 evict 시 flush](/uploads/project/minidb/buffer-pool.svg)

이 셋이 "캐시인데 데이터가 안 깨지는" 비결이다.

## 힙 파일 — 드디어 테이블

페이저·슬롯 페이지·버퍼 풀을 묶으면 **테이블** 이 나온다. 힙 파일은 순서 없는 페이지들의 모음이다. 행을 넣으면 마지막 페이지에 들어가고, 꽉 차면 새 페이지를 할당한다. 행의 주소는 **RID = (page_id, slot)**.

![힙 파일 — 여러 페이지에 행이 슬롯으로 담기고, full scan은 모든 페이지를 훑는다](/uploads/project/minidb/heap-file.svg)

`SELECT * FROM t` 의 가장 기본 형태인 풀 스캔은 모든 페이지의 모든 슬롯을 훑는 이중 루프다. 모든 관계형 DB의 출발점이고, 나중에 인덱스를 붙이는 이유가 바로 이걸 피하기 위해서다.

---

여기까지가 "바이트를 디스크에 안전하게 얹고, 행 단위로 다루는" 저장 계층이다. 아직 SQL은 한 글자도 안 받았다. [다음 편](/blog/project/minidb/minidb-2-sql-engine)에선 그 위에 SQL을 얹는다 — 텍스트를 파싱하고, 실행기가 이 힙을 훑어 행을 돌려주기까지.

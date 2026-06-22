---
title: '4096바이트 안에 행을 욱여넣기 — 슬롯 페이지'
titleEn: 'Packing Rows into 4096 Bytes — The Slotted Page'
description: "1편의 페이저는 페이지를 '4096바이트 덩어리'로만 다뤘다. 그런데 가변 길이 행 여러 개를 한 페이지에 어떻게 넣을까? PostgreSQL·InnoDB가 쓰는 슬롯 페이지 구조를 C로 직접 구현한다 — 슬롯 배열은 위에서 아래로, 레코드는 끝에서 위로 자라고, 슬롯 번호가 행의 안 바뀌는 주소가 된다."
descriptionEn: "Layer 1's pager treated a page as a raw 4096-byte blob. But how do you fit many variable-length rows into one page? We implement the slotted page layout that PostgreSQL and InnoDB use — the slot array grows down, records grow up, and the slot number becomes a stable address for each row."
date: 2026-06-22
tags:
  - C
  - Database Internals
  - Storage Engine
  - Slotted Page
  - Devlog
category: project/minidb
coverImage: /uploads/project/minidb/cover.svg
draft: false
series: "minidb"
seriesOrder: 2
---

[1편](/blog/project/minidb/minidb-dissecting-a-database)에서 페이저를 만들었다. 이제 `page_id`로 4096바이트 페이지를 읽고 쓸 수 있다. 그런데 페이지는 아직 그냥 바이트 덩어리다. 진짜 테이블이 되려면 질문 하나에 답해야 한다. **가변 길이 행 여러 개를 한 페이지에 어떻게 넣을까?**

"id" 5바이트, 이름 7바이트, 다음 행은 12바이트... 길이가 제각각인 레코드를 4096바이트 안에 빈틈없이 채우고, 지우고, 다시 채워야 한다. 정답이 **슬롯 페이지(slotted page)** 이고, PostgreSQL heap 페이지와 InnoDB 페이지가 정확히 이 구조다.

## 슬롯 배열은 아래로, 레코드는 위로

핵심 아이디어는 페이지를 양쪽 끝에서 가운데로 채우는 것이다.

- 페이지 맨 앞: **헤더**(슬롯 개수, 빈 공간 경계).
- 헤더 바로 뒤: **슬롯 배열**이 위에서 아래로 자란다. 각 슬롯은 `(offset, length)` — 레코드가 페이지 내 어디에 얼마나 있는지.
- 페이지 맨 끝: **레코드**가 끝에서 위로 자란다.
- 둘 사이가 **빈 공간**. 슬롯 배열과 레코드가 서로를 향해 다가오다 만나면 페이지가 꽉 찬 것이다.

![슬롯 페이지 레이아웃 — 헤더, 아래로 자라는 슬롯 배열, 위로 자라는 레코드, 가운데 빈 공간](/uploads/project/minidb/slotted-page-layout.svg)

이 구조의 진짜 묘수는 **슬롯 번호가 행의 안정적인 주소**가 된다는 점이다. 레코드가 페이지 안에서 물리적으로 옮겨져도(나중에 compaction 할 때) 슬롯 번호는 그대로다. 그래서 상위 계층은 `(page_id, slot)` 쌍으로 행을 가리킬 수 있다 — 이게 PostgreSQL의 TID, InnoDB의 레코드 포인터다.

## 페이지 버퍼에 구조체를 덮어쓰기

C에서는 페이지 버퍼(그냥 `uint8_t[4096]`)에 구조체 포인터를 그대로 덮어서 해석한다. PostgreSQL이 `PageHeaderData`로 하는 바로 그 방식이다.

```c
typedef struct {
    uint16_t num_slots; /* 슬롯 개수 */
    uint16_t free_end;  /* 레코드 영역의 시작. 초기값 4096, 레코드가 쌓일수록 줄어든다 */
} SlotPageHeader;

typedef struct {
    uint16_t offset;    /* 레코드의 페이지 내 위치 (0 = 삭제된 빈 슬롯) */
    uint16_t length;
} Slot;
```

삽입은 세 줄로 요약된다. 빈 공간이 충분한지 보고, 레코드를 끝에서 아래로 써 넣고, 슬롯 하나를 배열 끝에 추가한다.

```c
uint16_t rec_off = h->free_end - len;          // 레코드는 끝에서 아래로
memcpy((uint8_t *)page + rec_off, rec, len);
h->free_end = rec_off;
Slot *s = slot_at(page, h->num_slots);          // 슬롯은 배열 끝에 추가
s->offset = rec_off; s->length = len;
h->num_slots++;
```

삭제는 슬롯의 `offset`을 0으로 표시만 한다(tombstone). 차지하던 공간은 당장 회수하지 않는다 — 진짜 DB도 똑같이, 나중에 compaction이나 VACUUM으로 몰아서 정리한다. 즉시 회수하면 매 삭제마다 페이지를 재정렬해야 해서 비싸기 때문이다.

## 검증 — 그리고 디스크까지 한 번에

조회·삭제·공간 소진을 테스트하고, 마지막엔 1편의 페이저와 묶었다. 페이지에 레코드를 넣고 → `pager_write`로 디스크에 쓰고 → 프로그램을 새로 켠 셈 치고 `pager_read`로 읽어서 → 레코드가 그대로인지 확인한다. 두 계층이 함께 동작하는지 보는 거다.

![make test 결과 — 슬롯 페이지 테스트 12개 통과, 디스크 왕복 후에도 레코드 유지 포함](/uploads/project/minidb/page-test-output.svg)

`디스크 왕복 후에도 슬롯 1 유지` 가 통과한다는 건, 슬롯 페이지가 페이저 위에 제대로 얹혔다는 뜻이다. 이제 "여러 행을 담은 페이지"를 디스크에 저장하고 복원할 수 있다.

## 다음

다음은 [3] 버퍼 풀이다. 지금은 페이지가 필요할 때마다 디스크에서 읽는데, 진짜 DB는 자주 쓰는 페이지를 메모리에 캐시하고 교체(LRU)한다 — InnoDB buffer pool이 하는 일이다. 그다음 [4] 힙 파일에서 "테이블 = 페이지들의 모음"으로 묶어, 드디어 행을 테이블에 넣고 전체를 스캔하게 된다.

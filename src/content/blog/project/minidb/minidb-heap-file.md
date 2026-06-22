---
title: '드디어 테이블 — 힙 파일과 풀 스캔'
titleEn: 'Finally a Table — The Heap File and Full Scan'
description: "페이저·슬롯 페이지·버퍼 풀을 묶어 드디어 '테이블'을 만든다. 테이블 = 페이지들의 모음이고, 행을 넣으면 마지막 페이지에 들어가고 꽉 차면 새 페이지를 붙인다. 행의 주소는 RID = (page_id, slot) — PostgreSQL의 TID 그대로. 그리고 테이블 전체를 훑는 풀 스캔."
descriptionEn: "We tie the pager, slotted page, and buffer pool together into a table. A table is a collection of pages; inserting a row appends to the last page (or a new one), and each row's address is a RID = (page_id, slot) — exactly PostgreSQL's TID. Plus the full table scan."
date: 2026-06-22
tags:
  - C
  - Database Internals
  - Heap File
  - Full Scan
  - Devlog
category: project/minidb
coverImage: /uploads/project/minidb/cover.svg
draft: false
series: "minidb"
seriesOrder: 4
---

세 계층을 만들었다. [페이저](/blog/project/minidb/minidb-dissecting-a-database)로 페이지를 읽고 쓰고, [슬롯 페이지](/blog/project/minidb/minidb-slotted-page)로 한 페이지에 여러 행을 담고, [버퍼 풀](/blog/project/minidb/minidb-buffer-pool)로 페이지를 메모리에 캐시했다. 이제 셋을 묶으면 드디어 **테이블**이 나온다.

## 테이블 = 페이지들의 모음

힙 파일(heap file)은 순서 없는 페이지들의 모음으로 한 테이블의 행을 저장한다. PostgreSQL의 heap이 정확히 이거다. 규칙은 단순하다.

- 행을 넣으면 **마지막 페이지**의 슬롯에 들어간다.
- 마지막 페이지가 꽉 찼으면 **새 페이지를 할당**해 거기 넣는다.
- 모든 페이지 접근은 버퍼 풀을 거친다(캐시 적용).

![힙 파일 — 여러 페이지에 행이 슬롯으로 담기고, full scan은 모든 페이지를 훑는다. 한 행의 주소 = RID(page_id, slot)](/uploads/project/minidb/heap-file.svg)

행의 주소는 **RID = (page_id, slot)** 이다. PostgreSQL의 TID와 같다. 슬롯 페이지 편에서 봤듯 슬롯 번호는 행이 페이지 안에서 옮겨져도 안 바뀌므로, 이 쌍이 행의 영구 주소가 된다. 나중에 B-Tree 인덱스가 "키 → RID"로 이걸 가리키게 된다.

삽입은 "마지막 페이지에 먼저 시도, 안 되면 새 페이지" 그대로다.

```c
// 1) 마지막 페이지에 먼저 넣어본다
if (pager->num_pages > 0) {
    page = bufpool_fetch(bp, last_page);
    int slot = slotpage_insert(page, rec, len);
    if (slot >= 0) { unpin(dirty); return RID{last_page, slot}; }
    unpin(clean);                       // 꽉 찼다
}
// 2) 새 페이지를 할당해 넣는다
page = bufpool_new_page(bp, &new_page);
slotpage_init(page);
int slot = slotpage_insert(page, rec, len);
return RID{new_page, slot};
```

(학습용 단순화: 빈 공간을 빨리 찾는 free space map은 없다. 그냥 마지막 페이지만 시도한다. 진짜 DB는 FSM으로 중간 페이지의 빈자리도 찾는다.)

## 풀 스캔 — 모든 페이지를 처음부터 끝까지

`SELECT * FROM t` 의 가장 기본 형태가 풀 스캔(full table scan)이다. 인덱스가 없으면 DB는 테이블의 모든 페이지를, 각 페이지의 모든 슬롯을 차례로 훑는다.

```c
for (page_id_t pid = 0; pid < num_pages; pid++) {
    page = bufpool_fetch(bp, pid);
    for (uint16_t s = 0; s < slotpage_num_slots(page); s++) {
        if (slotpage_get(page, s, &rec, &len) == 0)  // 삭제된 슬롯은 건너뜀
            visit(RID{pid, s}, rec, len);
    }
    bufpool_unpin(bp, pid, 0);
}
```

이 단순한 이중 루프가 모든 관계형 DB의 출발점이다. 나중에 인덱스를 붙이는 이유가 바로 이걸 피하기 위해서다.

## 검증 — 멀티 페이지, 삭제, 그리고 재시작

행 세 개를 넣고 RID로 꺼내봤다. 그다음 64바이트 행을 200개 더 넣어 **여러 페이지에 걸치게** 하고, 풀 스캔이 203행을 다 찾는지 확인했다. 하나를 삭제하면 스캔에서 빠지고 조회도 실패해야 한다. 마지막으로 버퍼 풀을 flush하고 모든 걸 완전히 새로 연 뒤에도 202행이 그대로 있어야 한다.

![make test 결과 — 힙 파일 테스트 12개 통과, 203행 멀티 페이지·삭제·재오픈 영속성 포함](/uploads/project/minidb/heap-test-output.svg)

`스캔 203행 (멀티 페이지)`, `재오픈 후에도 202행` 이 통과한다는 건, 네 계층(페이저·슬롯 페이지·버퍼 풀·힙)이 하나로 묶여 진짜 테이블처럼 동작한다는 뜻이다. 이제 행을 넣고, 전부 훑고, 지우고, 껐다 켜도 남는다.

## 다음

저장 계층은 한 바퀴 돌았다. 다음은 위로 올라간다. [5] 카탈로그 — 테이블의 스키마(컬럼 이름·타입)를 *어디에 저장하나*. PostgreSQL은 `pg_catalog`라는 시스템 테이블에 메타데이터를 자기 자신의 테이블로 저장한다. 그다음 [6] SQL 파서와 [7] 실행기를 붙이면, 드디어 `CREATE TABLE` / `INSERT` / `SELECT ... WHERE` 를 진짜 SQL 텍스트로 받게 된다.

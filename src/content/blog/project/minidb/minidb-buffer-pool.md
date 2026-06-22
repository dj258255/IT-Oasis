---
title: '디스크를 매번 때리지 않기 — 버퍼 풀'
titleEn: "Not Hitting Disk Every Time — The Buffer Pool"
description: "지금까지는 페이지가 필요할 때마다 디스크를 읽었다. 진짜 DB는 자주 쓰는 페이지를 메모리에 캐시하고, 꽉 차면 LRU로 교체한다 — InnoDB buffer pool이 하는 일. pin count·dirty 플래그·LRU 세 장치로 '캐시인데 데이터가 안 깨지는' 버퍼 풀을 C로 만든다."
descriptionEn: "Until now every page access went to disk. Real databases cache hot pages in memory and evict by LRU when full — that's the InnoDB buffer pool. We build one in C with three safeguards — pin counts, a dirty flag, and LRU — so it's a cache that never loses data."
date: 2026-06-22
tags:
  - C
  - Database Internals
  - Buffer Pool
  - Caching
  - Devlog
category: project/minidb
coverImage: /uploads/project/minidb/cover.svg
draft: false
series: "minidb"
seriesOrder: 3
---

[1편](/blog/project/minidb/minidb-dissecting-a-database)의 페이저로 페이지를 읽고 쓰고, [2편](/blog/project/minidb/minidb-slotted-page)의 슬롯 페이지로 한 페이지에 여러 행을 담았다. 그런데 문제가 있다. **페이지가 필요할 때마다 매번 디스크를 읽는다.** 디스크는 메모리보다 수만 배 느리다. 같은 페이지를 백 번 읽으면 백 번 디스크에 간다.

진짜 DB는 그러지 않는다. 자주 쓰는 페이지를 메모리에 들고 있다가 재사용하고, 메모리가 꽉 차면 가장 안 쓰는 걸 내보낸다. 이게 **버퍼 풀(buffer pool)** 이고, InnoDB buffer pool·PostgreSQL shared buffers가 정확히 이 계층이다.

## 프레임, 그리고 hit/miss

버퍼 풀은 고정 개수의 **프레임**(페이지 크기 버퍼)을 들고 있다. 페이지를 요청하면 둘 중 하나다.

- **hit**: 이미 프레임에 있으면 디스크 안 가고 그대로 반환.
- **miss**: 없으면 디스크에서 읽어 빈 프레임에 올린다. 빈 프레임이 없으면 victim을 골라 내보내고 그 자리를 쓴다.

![버퍼 풀 구조 — 메모리 프레임들(page/pin/dirty/LRU), 디스크에서 miss 로드, dirty면 evict 시 flush, hit는 바로 반환](/uploads/project/minidb/buffer-pool.svg)

## 캐시인데 데이터가 안 깨지는 비결 — 세 장치

단순 캐시와 DB 버퍼 풀의 차이는 세 가지다.

1. **pin count.** 누군가 페이지를 쓰는 중(pin>0)이면 절대 내보내지 않는다. 안 그러면 내가 보고 있는 페이지가 발밑에서 사라진다.
2. **dirty 플래그.** 메모리에서 수정된 페이지는 내보내기 전에 반드시 디스크로 flush한다. 안 그러면 수정이 증발한다.
3. **LRU.** victim은 pin 안 된 것 중 가장 오래 안 쓴 프레임. 곧 다시 쓸 페이지를 내보내는 낭비를 줄인다.

victim을 고르는 코드가 이 셋을 그대로 담는다.

```c
// 1) 빈 프레임이 있으면 그걸 쓴다
// 2) 없으면 pin 안 된 것 중 last_used가 가장 작은 프레임을 victim으로
Frame *victim = NULL;
for (each frame f)
    if (f->pin_count == 0)                      // pin된 건 후보 제외
        if (!victim || f->last_used < victim->last_used)
            victim = f;
if (!victim) return NULL;                        // 전부 pin됨 → 자리 없음
if (victim->dirty)                               // 내보내기 전에
    pager_write(pager, victim->page_id, victim->data);  // 디스크로 flush
```

(학습용이라 page_id → frame 조회를 선형 탐색으로 둔다. 진짜 DB는 해시 테이블을 쓴다. LRU도 InnoDB는 midpoint insertion 같은 변형을 쓰지만, 핵심 아이디어는 같다.)

## 검증 — 쫓겨난 dirty 페이지가 살아남는가

버퍼 풀에서 가장 중요한 건 "교체가 일어나도 데이터가 안 깨진다"는 것이다. 그래서 프레임 2개짜리 작은 풀에 페이지 3개를 만들어 교체를 강제로 일으켰다. dirty 페이지가 쫓겨난 뒤 다시 요청하면, **miss가 나면서도 내용은 그대로**여야 한다 — 쫓겨날 때 디스크에 제대로 flush됐다는 증거다. 그리고 두 프레임을 모두 pin하면 세 번째 요청은 자리가 없어 NULL을 받아야 한다.

![make test 결과 — 버퍼 풀 테스트 7개 통과, 쫓겨난 dirty 페이지 디스크 flush·pin 보호 포함](/uploads/project/minidb/bufpool-test-output.svg)

`쫓겨난 dirty 페이지가 디스크에 flush됐다`, `모두 pin되면 자리 없음(NULL)` 이 통과한다는 건, 세 장치가 다 제대로 동작한다는 뜻이다. 이제 디스크 접근을 캐시가 가려준다.

## 다음

다음은 [4] 힙 파일이다. 지금까지 만든 페이저·슬롯 페이지·버퍼 풀을 묶어, 드디어 **"테이블"** 이라는 개념을 만든다. 테이블 = 페이지들의 모음이고, 행을 넣으면 마지막 페이지에 슬롯으로 들어가며 공간이 없으면 새 페이지를 할당한다. 그리고 테이블 전체를 처음부터 끝까지 훑는 풀 스캔(full table scan)도 여기서 나온다.

---
title: '저장 계층은 어떻게 동작하는가 — 페이지에서 힙까지'
titleEn: 'How Does the Storage Layer Work? — From Pages to the Heap'
description: "PostgreSQL·MySQL이 내부에서 어떻게 동작하는지 이해하려고 관계형 DB를 C로 밑바닥부터 만든 db-hobby 시리즈 1편. 가장 아래 저장 계층 — 고정 크기 페이지를 디스크에 읽고 쓰는 페이저, 가변 길이 행을 페이지에 담는 슬롯 페이지, 디스크를 매번 때리지 않게 하는 버퍼 풀(pin/dirty/LRU), 그리고 이 셋을 묶은 힙 파일까지를 실제 코드로 짓고, 페이지 크기·슬롯 페이지·힙 vs 클러스터드 같은 설계 선택을 PostgreSQL·InnoDB와 비교합니다."
descriptionEn: "Part 1 of db-hobby, a relational database built from scratch in C to understand how PostgreSQL and MySQL work inside. We build the bottom storage layer with real code — a pager that reads/writes fixed-size pages, slotted pages that pack variable-length rows, a buffer pool (pin/dirty/LRU), and the heap file that ties them together — and compare design choices like page size, slotted pages, and heap vs clustered against PostgreSQL and InnoDB."
date: 2026-05-11
tags:
  - C
  - Database Internals
  - Storage Engine
  - Buffer Pool
  - PostgreSQL
  - InnoDB
  - Learning
category: study/db-hobby
coverImage: /uploads/project/db-hobby/cover.svg
draft: false
series: "db-hobby"
seriesOrder: 1
---

## 0. 들어가며 — DB는 OS 위에 데이터 계층을 다시 쌓은 것

데이터베이스를 직접 만들어보고 싶었던 계기는 OS였어요. 운영체제를 공부하다 보면 페이지, 캐시, 동시성, 파일에 바이트를 얹고 다시 읽는 법 같은 기본 개념들이 계속 나오는데, **DB라는 게 결국 운영체제가 주는 파일·메모리·동시성 같은 기본 위에, 데이터를 효율적으로 저장하고 찾기 위한 계층을 다시 쌓아 올린 시스템**이더라고요(관계형 DB는 거기에 SQL이라는 인터페이스를 얹고요). 그러니 DB를 밑바닥부터 한 겹씩 만들어 보면, OS의 그 개념들이 실제로 어떻게 맞물려 돌아가는지, 그리고 무엇보다 **이걸 만든 사람들이 무슨 고민 끝에 왜 이렇게 설계했는지**를 손으로 따라가 볼 수 있겠다 싶었습니다.

그렇게 만든 게 **db-hobby** 예요. PostgreSQL·MySQL 같은 관계형 DB가 내부에서 어떻게 동작하는지를 C로 한 겹씩 직접 구현하며 해부한 학습 프로젝트입니다(전 계층 테스트 300개 이상). 이 1편은 맨 아래 — 바이트를 디스크에 얹는 **저장 계층**을 짓습니다.

## 1. 전체 지도 — 모든 것은 고정 크기 페이지 위에

DB는 한 덩어리가 아니라 여러 계층의 합이에요. 위에서 아래로 이렇게 쌓입니다.

![db-hobby 계층 지도 — SQL 텍스트가 파서·플래너·실행기를 거쳐 카탈로그·접근(힙/B-Tree)·버퍼풀·페이지·페이저로 내려가고, WAL이 내구성을 받친다](/uploads/project/db-hobby/layer-map.svg)

> **핵심 사실**: 페이지 기반 관계형 DB에선 거의 모든 것이 **고정 크기 페이지** 위에 쌓인다 — db-hobby·PostgreSQL·InnoDB가 그렇다. 그래서 맨 아래(페이저)부터 짓는다. (반대로 RocksDB·Cassandra 같은 LSM 계열은 페이지 중심이 아니다 — [3편](/blog/project/db-hobby/db-hobby-3-index-wal)에서 비교한다.)

DB마다 그 "한 페이지"의 크기가 다릅니다.

| DB | 페이지 크기 |
|---|---|
| **db-hobby** | 4KB |
| PostgreSQL | 8KB |
| MySQL InnoDB | 16KB |
| SQLite | 기본값 4KB (3.12.0/2016~, 그 전 기본은 1KB · 512B~64KB 설정 가능) |

이번 편은 이 지도의 맨 아래 네 계층 — 페이저, 슬롯 페이지, 버퍼 풀, 힙 — 을 만듭니다.

> **왜 C인가**: 목표가 "진짜 구조를 있는 그대로 해부"라면 진짜 DB가 쓰는 언어로 하는 게 맞아요. DB 내부는 메모리·포인터·바이트 레이아웃이 곧 학습 내용인데, 언어가 이걸 추상화로 가리면 정작 배우려는 걸 못 봅니다. C는 아무것도 안 가려요.

## 2. 페이저 — 페이지를 디스크에 읽고 쓰기

가장 밑바닥의 페이저는 단 하나만 책임집니다 — "`page_id`로 4096바이트 페이지 하나를 디스크에서 읽고 쓴다".

> **왜 행이 아니라 페이지 단위인가**: 디스크(그리고 OS·SSD 컨트롤러)는 바이트가 아니라 블록 단위로 I/O를 한다. 1바이트를 읽어도 그 바이트가 속한 블록 전체가 올라온다. 그러니 DB도 처음부터 블록(페이지)을 작업 단위로 잡는 게 맞다.

페이지를 **고정 크기**로 잡으면 선물이 따라와요 — N번 페이지의 파일 내 위치가 곱셈 한 번으로 정해집니다.

```c
int pager_read(Pager *p, page_id_t id, void *buf) {
    off_t offset = (off_t)id * PAGE_SIZE;   // N번 페이지 = N * 4096
    ssize_t n = pread(p->fd, buf, PAGE_SIZE, offset);
    return (n == (ssize_t)PAGE_SIZE) ? 0 : -1;
}
```

`read`/`write` 대신 `pread`/`pwrite`를 쓴 것도 의도가 있어요. 보통의 `read`/`write`는 파일의 "현재 위치"를 들고 다녀서 엉뚱한 데를 읽으려면 `lseek`로 먼저 옮겨야 하는데, `pread(fd, buf, len, offset)`는 오프셋을 인자로 받으니 그 단계가 없습니다. 페이지 위치가 곱셈 하나로 나오는 우리 모델엔 이게 더 자연스럽고, 덤으로 멀티스레드에서도 안전해요 — 정확히는 파일의 공유 오프셋(shared file offset)을 건드리지 않아서, 한 스레드의 `lseek`와 다른 스레드의 읽기가 위치를 꼬이게 만드는 race가 없거든요(우린 단일 스레드라 덤일 뿐이지만).

페이지를 왜 하필 4KB로 잡았을까요. 사실 정답은 없고 DB마다 다른데, 페이지 크기를 고민할 때 자주 인용되는 게 1987년 Jim Gray와 Gianfranco Putzolu의 **5분 규칙(Five-Minute Rule)** 이에요 — "디스크에서 읽어온 페이지를 메모리에 얼마나 들고 있어야 본전인가"를 디스크값·램값으로 따지는 경제학적 계산인데, **한 페이지를 크게 잡는 게 왜 이득인지**를 설명해 줍니다. 다만 실제 DB의 선택이 이 하나로 정해진 건 아니에요 — 1980년대 Berkeley POSTGRES가 8KB를 고른 데는 당시 Unix 가상 메모리 페이지 크기, I/O 효율 등 여러 요소가 함께 작용했고(당시 일반적인 VM 페이지 크기와도 잘 맞았어요), PostgreSQL 문서가 "5분 규칙 때문에 8KB"라고 직접 말하지도 않습니다.

> **실무/면접 포인트**: 큰 페이지는 메타데이터 오버헤드가 적은 대신 일부 SSD에선 IOPS가 떨어질 수 있고(예컨대 어떤 인텔 SSD 벤치마크에선 4KB로 75,000 IOPS이던 게 8KB에선 47,500으로 ~37% 낮아졌습니다 — IOPS는 SSD·큐 깊이·랜덤/순차·컨트롤러에 따라 달라지니 일반 법칙은 아니에요), 같은 캐시 메모리에 들어가는 페이지 수도 절반이 됩니다. "페이지 크기는 메타데이터 오버헤드 vs IOPS·캐시 효율의 트레이드오프"가 정확한 설명이에요. db-hobby는 학습용이라 "한 페이지에 행 몇 개"가 눈에 잘 들어오게 작은 4KB로 갔습니다 — 어떤 크기든 "고정 크기"이기만 하면 위 코드는 안 바뀌니까요.

![페이저 테스트 — 라운드트립 + 재오픈 영속성 11개 통과](/uploads/project/db-hobby/pager-test-output.svg)

> 더 깊이: [DB 스토리지 내부 ①: Heap, Page, Index, B-Tree](/blog/theory/db-storage-01-heap-page-index) — 왜 행이 아니라 페이지가 DB의 작업 단위인지, PostgreSQL 8KB / InnoDB 16KB 페이지가 어떻게 얽히는지 실제 DB 관점에서.

## 3. 슬롯 페이지 — 4096바이트 안에 가변 길이 행 담기

페이지는 아직 그냥 4096바이트 덩어리일 뿐이에요. 여기에 **가변 길이** 행을 여러 개 담으려면 문제가 하나 있습니다. `'kim'`은 3바이트, `'alexander'`는 9바이트예요. 길이가 제각각인 행을 어디서부터 어디까지인지 어떻게 알고, 중간 행이 지워지거나 길이가 바뀌면 어떻게 정리할까요? 답이 **슬롯 페이지(slotted page)** 입니다. PostgreSQL heap 페이지, InnoDB 페이지가 전부 이 구조예요.

레이아웃은 양쪽에서 가운데로 자라는 모양입니다. 페이지 **앞**에는 헤더 뒤로 **슬롯 배열**(각 슬롯 = "이 행은 페이지 안 offset 몇, 길이 몇")이 아래로 자라고, 페이지 **끝**에서는 실제 레코드 바이트가 위로 자라요. 가운데가 빈 공간이고, 둘이 만나면 그 페이지는 꽉 찬 겁니다.

![슬롯 페이지 레이아웃 — 슬롯 배열은 아래로, 레코드는 위로, 가운데 빈 공간](/uploads/project/db-hobby/slotted-page-layout.svg)

더 간단한 길도 있었어요. 모든 행을 같은 길이로 못 박아두면(고정 길이 레코드) 슬롯 배열이 필요 없습니다 — N번 행은 그냥 `헤더 + N * 행크기` 위치에 있으니까요. 옛날 DB나 일부 임베디드 시스템이 이렇게 해요. 둘을 비교하면:

| | 슬롯 페이지 (db-hobby·PG·InnoDB) | 고정 길이 레코드 |
|---|---|---|
| 가변 길이 TEXT | 자연스럽게 담음 | 가장 긴 길이에 맞춰야 해 공간 낭비 |
| 행 위치 | 슬롯 배열이 가리킴 | `헤더 + N * 크기` 곱셈 |
| 삭제·compact | 슬롯 번호 유지, offset만 수정 | 자리 재사용 어려움 |
| 채택 | 거의 모든 관계형 DB | 옛날·일부 임베디드 |

> **슬롯 페이지의 두 가지 값어치**: 하나는 **가변 길이 행을 한 페이지에 자연스럽게 담는다**는 것이고, 다른 하나는 — 어쩌면 더 중요한 — **슬롯 번호가 행의 안정적인 주소**가 된다는 것이다. 행이 지워져 빈 공간이 생기고 페이지를 compact하며 레코드가 물리적으로 옮겨져도, 슬롯 번호는 그대로다(슬롯 안의 offset만 고치면 되니까). 그래서 바깥(인덱스)에서 "페이지 5의 슬롯 2"로 행을 가리켜도 그 주소가 안 깨진다. PostgreSQL은 이걸 **TID(ctid)**, InnoDB는 레코드 포인터라 부르고, 곧 만들 우리 `RID`도 같은 발상이다.

db-hobby가 삭제할 때 실제로 안 지우고 슬롯만 **tombstone**(무효 표시)으로 두는 것도 같은 이유 — 인덱스가 가리키던 주소를 살아 있게 두려는 거예요. 다만 이건 슬롯 페이지의 보편 법칙이라기보단 **구현 선택**입니다. 어떤 구현은 삭제 즉시 페이지를 compact하기도 하고, PostgreSQL은 MVCC 때문에 튜플을 죽었다고 표시만 해두고 나중에 VACUUM이 정리해요([13편](/blog/project/db-hobby/db-hobby-13-mvcc)에서 다시 나옵니다).

> **실무/면접 포인트**: InnoDB도 페이지 안에선 Page Directory라는 sparse 디렉터리(레코드 몇 개 묶음마다 슬롯 하나)로 이진 탐색하듯 위치를 좁힌 뒤, 그 지점부터 레코드 체인을 따라가 정확한 행을 찾습니다(디렉터리만으로 끝나는 순수 이진 탐색은 아니에요). 다만 행을 PK 순서로 정렬해 저장하는 클러스터드 구조라, 보조 인덱스가 행을 가리킬 때 물리 슬롯 포인터가 아니라 **PK 값**을 써요. "행을 물리 위치로 식별하느냐(PG·db-hobby) PK로 식별하느냐(InnoDB)"가 힙과 갈리는 지점입니다(5절에서 다시).

## 4. 버퍼 풀 — 디스크를 매번 때리지 않기

페이지를 읽을 때마다 디스크를 때리면 느려요. 메모리는 디스크보다 수만~수십만 배 빠르니, 자주 쓰는 페이지는 메모리에 들고 있어야 합니다. **버퍼 풀**이 그 역할 — 고정 개수의 "프레임"에 페이지를 캐시하고, 요청한 페이지가 있으면(hit) 그대로, 없으면(miss) 디스크에서 읽어 올려요. 자리가 없으면 LRU로 victim을 골라 쫓아냅니다(InnoDB buffer pool, PostgreSQL shared buffers와 같은 역할).

그런데 단순한 LRU 캐시와 **DB 버퍼 풀**은 달라요. 캐시에 든 게 "원본"이고 수정도 여기서 일어나기 때문에 세 가지 안전장치가 붙습니다.

| 장치 | 역할 |
|---|---|
| **pin count** | 지금 누가 읽거나 쓰는 중인 페이지(pin>0)는 절대 안 쫓아냄(쓰는 도중 사라지면 안 되니까) |
| **dirty 플래그** | 메모리에서 수정된 페이지는 표시 -> evict/flush 때 디스크에 반영. 안 바뀐 건 그냥 버림(디스크에 원본 있음) |
| **LRU** | victim은 pin 안 된 것 중 가장 오래 안 쓴 프레임 |

![버퍼 풀 — 프레임(page/pin/dirty/LRU), miss는 디스크 로드, dirty면 evict 시 flush](/uploads/project/db-hobby/buffer-pool.svg)

이 셋이 "캐시인데 데이터가 안 깨지는" 비결이에요. 나중에 트랜잭션·WAL을 붙일 때 여기에 **no-steal**(커밋 안 된 dirty 페이지는 victim에서 제외)이라는 네 번째 규칙이 더 붙는데, 그 얘기는 [4편](/blog/project/db-hobby/db-hobby-4-transactions)에서 합니다.

> 더 깊이: [캐시와 버퍼: 속도 차이를 극복하는 두 가지 방법](/blog/theory/cache-and-buffer) — 캐시(읽기 가속)와 버퍼(생산자-소비자 완충)가 어떻게 다른지. 그리고 [JVM 메모리 ④: OS Page Cache](/blog/theory/es-memory-04-page-cache) — DB 버퍼 풀과 별개로 OS가 또 한 겹 캐시하는 이중 캐시 구조.

## 5. 힙 파일 — 드디어 테이블

페이저·슬롯 페이지·버퍼 풀을 묶으면 비로소 **테이블**이 나와요. 힙 파일(heap file)은 **순서 없는** 페이지들의 모음입니다 — "heap"은 자료구조 힙이 아니라 "아무렇게나 쌓아둔 더미"라는 뜻이에요. 행을 넣으면 빈자리가 있는 페이지에, 없으면 새 페이지를 붙입니다. 정렬도, 위치 규칙도 없어요(db-hobby는 단순하게 마지막 페이지부터 보고, PostgreSQL은 FSM(Free Space Map)으로 빈 공간이 있는 페이지를 찾습니다).

그래서 행의 주소가 필요한데, 그게 **RID = (page_id, slot)** 입니다 — "몇 번 페이지의 몇 번 슬롯". 슬롯 번호가 안정적이라 RID는 행이 페이지 안에서 옮겨져도 안 바뀌어요. RID는 일반 용어이고, PostgreSQL의 TID(ctid)가 바로 같은 역할을 합니다. 곧 만들 B+Tree 인덱스가 "키 -> RID"로 이걸 가리킵니다.

![힙 파일 — 여러 페이지에 행이 슬롯으로 담기고, full scan은 모든 페이지를 훑는다](/uploads/project/db-hobby/heap-file.svg)

`SELECT * FROM t`의 가장 기본 형태인 **풀 스캔(sequential scan)** 은 힙의 모든 페이지를, 페이지 안의 모든 슬롯을 훑는 이중 루프예요. O(행 수)입니다. 모든 관계형 DB의 출발점이자, 나중에 인덱스를 붙이는 이유가 바로 이 O(n)을 피하려는 거예요. db-hobby는 **테이블 하나 = 파일 하나**(`<db>.<테이블>.tbl`)로 단순화했는데, PostgreSQL이 릴레이션마다 파일을 따로 두는 relfilenode 방식과 닮았습니다([5편](/blog/project/db-hobby/db-hobby-5-join-aggregate)에서 다중 테이블로 다시 나와요).

여기서 "왜 굳이 순서 없는 힙이냐"를 짚고 가야겠어요. 다른 길은 **데이터 자체를 PK 순서로 정렬해 저장**하는 것 — InnoDB의 클러스터드 인덱스(=index-organized table)가 그렇습니다. 둘은 정반대의 장단점을 가져요.

| | 힙 (PostgreSQL·db-hobby) | 클러스터드 (InnoDB) |
|---|---|---|
| 저장 순서 | 순서 없음 | PK 순서로 정렬 |
| INSERT | 빈자리에 던져 넣음 (빠름·단순) | 정렬 위치에 끼워 넣음 -> 페이지 분할, 무작위 PK면 느림 |
| PK 조회 | 인덱스 -> RID -> 힙 (2단계) | PK 인덱스 리프가 곧 데이터 (한 트리로 끝) |
| 보조 인덱스 | RID(물리 위치)를 가리킴 | PK 값을 들고 "보조 -> PK -> 데이터" |

> **설계 선택**: "어느 게 더 좋다"가 아니라 워크로드(쓰기 위주냐 PK 조회 위주냐)에 따라 갈리는 선택입니다. db-hobby가 힙을 고른 건 학습용으로 압도적으로 단순해서예요 — INSERT가 `heap_insert` 한 줄이고, 곧 만들 B+Tree 인덱스를 "키 -> RID"라는 별도 구조로 깔끔하게 떼어 볼 수 있으니까요.

> 더 깊이: [DB 인덱스 ⑤: 클러스터형 인덱스와 DBMS별 차이](/blog/theory/db-index-05-clustered-dbms) — heap-organized(PostgreSQL)와 index-organized(InnoDB)의 보조 인덱스 경로·PK 전략 차이를 실제 DB로.

## 6. 정리

저장 계층은 "바이트를 디스크에 안전하게 얹고, 행 단위로 다루는" 네 겹이에요. 밑에서부터: 페이저(디스크 I/O) -> 슬롯 페이지(행 패킹) -> 버퍼 풀(캐시) -> 힙(테이블). 핵심 설계 선택을 정리하면:

- **고정 크기 페이지** — 디스크가 블록 I/O를 하니 DB도 페이지를 작업 단위로. 크기는 메타데이터 오버헤드 vs IOPS·캐시 효율 트레이드오프(5분 규칙).
- **슬롯 페이지** — 가변 길이 행을 담고, 슬롯 번호가 안정적 주소(TID/RID)가 됨. 인덱스가 이걸 가리킨다.
- **버퍼 풀** — 단순 LRU가 아니라 pin/dirty가 붙어야 "캐시인데 안 깨진다".
- **힙 vs 클러스터드** — db-hobby는 PostgreSQL식 힙(쓰기 단순, PK 조회는 인덱스->힙 2단계). InnoDB는 클러스터드(PK 인덱스 리프가 곧 데이터, 쓰기 복잡).

아직 SQL은 한 글자도 안 받았어요. [다음 편](/blog/project/db-hobby/db-hobby-2-sql-engine)에선 그 위에 SQL을 얹습니다 — 텍스트를 토큰으로 쪼개 AST로 파싱하고, 실행기가 이 힙을 훑어 진짜 행을 돌려주기까지.

## 참고

- [PostgreSQL Documentation: Database Page Layout](https://www.postgresql.org/docs/current/storage-page-layout.html)
- [PostgreSQL Documentation: Physical Storage (relfilenode, heap)](https://www.postgresql.org/docs/current/storage.html)
- Jim Gray & Franco Putzolu, *The 5 Minute Rule for Trading Memory for Disc Accesses* (1987)
- 본 블로그: [DB 스토리지 내부 ①: Heap, Page, Index, B-Tree](/blog/theory/db-storage-01-heap-page-index) · [DB 인덱스 ⑤: 클러스터형 인덱스와 DBMS별 차이](/blog/theory/db-index-05-clustered-dbms) · [캐시와 버퍼](/blog/theory/cache-and-buffer)
- [db-hobby 코드 (GitHub)](https://github.com/dj258255/db-hobby)

<!-- EN -->

## 0. Introduction — A DB Is a Data Layer Restacked on Top of the OS

What pushed me to build a database was OS. Studying operating systems, the same primitives keep coming back — pages, caches, concurrency, laying bytes onto a file and reading them back. And **a DB is essentially a system that restacks, on top of what the OS provides — files, memory, concurrency — another layer for storing and finding data efficiently** (a relational DB then offers SQL as its interface). So building a DB layer by layer from the bottom lets you watch those OS concepts actually mesh, and above all follow **what its designers wrestled with and why they chose what they chose**.

That is **db-hobby** — a learning project that dissects how relational DBs like PostgreSQL and MySQL work inside, implemented in C one layer at a time (300+ tests across all layers). Part 1 builds the bottom — the **storage layer** that lays bytes onto disk.

## 1. The Map — Everything Sits on Fixed-Size Pages

A DB is not one blob; it is a stack of layers, top to bottom.

![db-hobby layer map](/uploads/project/db-hobby/layer-map.svg)

> **Key fact**: in page-based relational DBs, almost everything sits on **fixed-size pages** — db-hobby, PostgreSQL, InnoDB do. So we build from the bottom (the pager) up. (LSM-family stores like RocksDB and Cassandra are not page-centric — compared in [Part 3](/blog/project/db-hobby/db-hobby-3-index-wal).)

Each DB picks a different size for that one page.

| DB | Page size |
|---|---|
| **db-hobby** | 4KB |
| PostgreSQL | 8KB |
| MySQL InnoDB | 16KB |
| SQLite | default 4KB (3.12.0/2016 on; 1KB default before · configurable 512B–64KB) |

This part builds the bottom four layers of that map — pager, slotted page, buffer pool, heap.

> **Why C**: if the goal is to dissect the real structure as-is, use the language real DBs use. The internals are memory, pointers, and byte layout — exactly the learning content — and a language that hides those behind abstraction hides what you came to learn. C hides nothing.

## 2. The Pager — Reading and Writing Pages to Disk

The pager at the very bottom has one job — "read/write one 4096-byte page from disk by `page_id`".

> **Why pages, not rows**: disks (and the OS / SSD controller) do I/O in blocks, not bytes. Read one byte and the whole block it belongs to comes up. So a DB should make blocks (pages) its unit of work from the start.

Fixing the page size brings a gift — page N's offset in the file is one multiplication.

```c
int pager_read(Pager *p, page_id_t id, void *buf) {
    off_t offset = (off_t)id * PAGE_SIZE;   // page N = N * 4096
    ssize_t n = pread(p->fd, buf, PAGE_SIZE, offset);
    return (n == (ssize_t)PAGE_SIZE) ? 0 : -1;
}
```

Using `pread`/`pwrite` over `read`/`write` is deliberate. Plain `read`/`write` carry a "current position", so reading elsewhere needs an `lseek` first; `pread(fd, buf, len, offset)` takes the offset as an argument, skipping that step. It fits a model where the page offset is a single multiplication, and it is thread-safe for free — precisely because it never touches the file's shared offset, so there is no race where one thread's `lseek` and another's read scramble the position (we are single-threaded, so that is just a bonus).

Why 4KB? There is no single right answer. A often-cited lens for page size is the 1987 **Five-Minute Rule** by Jim Gray and Gianfranco Putzolu — an economic calculation of "how long should you keep a page read from disk in memory to break even" against disk and RAM prices, which explains **why making a page larger pays off**. But a real DB's choice is not decided by that alone: 1980s Berkeley POSTGRES landing on 8KB involved several factors — the era's Unix virtual-memory page size and I/O efficiency (it matched typical VM page sizes well) — and PostgreSQL's docs do not actually claim "8KB because of the Five-Minute Rule."

> **Practical/interview note**: a larger page has less metadata overhead but, on some SSDs, lower IOPS (e.g., one Intel SSD benchmark dropped from 75,000 IOPS at 4KB to 47,500 at 8KB, ~37% lower — IOPS depends on the SSD, queue depth, random/sequential, and controller, so this is no general law) and halves how many pages fit in the same cache memory. The precise framing is "page size is a trade-off between metadata overhead and IOPS/cache efficiency." db-hobby went small (4KB) so "how many rows per page" is easy to see — and any fixed size leaves the code above unchanged.

![Pager tests pass](/uploads/project/db-hobby/pager-test-output.svg)

> Deeper: [DB Storage Internals ①: Heap, Page, Index, B-Tree](/blog/theory/db-storage-01-heap-page-index).

## 3. The Slotted Page — Packing Variable-Length Rows into 4096 Bytes

A page is still just a 4096-byte blob. Packing several **variable-length** rows into it has a catch: `'kim'` is 3 bytes, `'alexander'` is 9. How do you know where each row starts and ends, and how do you tidy up when a middle row is deleted or resized? The answer is the **slotted page** — the structure of PostgreSQL heap pages and InnoDB pages alike.

The layout grows toward the middle from both ends. At the **front**, after a header, a **slot array** (each slot = "this row is at offset X, length Y") grows downward; at the **end**, the actual record bytes grow upward. The middle is free space, and when the two meet, the page is full.

![Slotted page layout](/uploads/project/db-hobby/slotted-page-layout.svg)

A simpler path existed: nail every row to the same length (fixed-length records) and you need no slot array — row N is at `header + N * size`. Old DBs and some embedded systems do this. Comparing them:

| | Slotted page (db-hobby·PG·InnoDB) | Fixed-length record |
|---|---|---|
| Variable-length TEXT | packs naturally | must size to the longest -> waste |
| Row location | the slot array points | `header + N * size` multiply |
| Delete·compact | slot number kept, only offset fixed | hard to reuse space |
| Adoption | nearly all relational DBs | old / some embedded |

> **Two payoffs of slotted pages**: one is that they **pack variable-length rows naturally into one page**; the other — perhaps the more important — is that **the slot number is a stable address for the row**. Even when a delete frees space and a compaction physically moves the record, the slot number stays (only the offset inside the slot changes). So an index pointing at "page 5, slot 2" never breaks. PostgreSQL calls this **TID (ctid)**, InnoDB calls it a record pointer, and our `RID` is the same idea.

db-hobby deleting by marking the slot a **tombstone** instead of really erasing is for the same reason — keep the address an index pointed at alive. This, though, is an implementation choice rather than a universal law of slotted pages: some implementations compact the page immediately on delete, and PostgreSQL (because of MVCC) only marks a tuple dead and lets VACUUM clean it up later (revisited in [Part 13](/blog/project/db-hobby/db-hobby-13-mvcc)).

> **Practical/interview note**: InnoDB also narrows down records within a page via a Page Directory — a sparse directory (one slot per small group of records) it binary-searches to get close, then follows the record chain from there to the exact row (so it is not a pure directory-only binary search). But because it stores rows clustered in PK order, its secondary indexes point at rows by **PK value**, not a physical slot pointer. "Identify a row by physical location (PG·db-hobby) vs by PK (InnoDB)" is where it splits from the heap (more in section 5).

## 4. The Buffer Pool — Not Hitting Disk Every Time

Hitting disk on every page read is slow. Memory is tens of thousands of times faster, so hot pages should stay in memory. The **buffer pool** does that — it caches pages in a fixed number of "frames", serves a hit directly, loads a miss from disk, and on a full pool picks an LRU victim to evict (the role of InnoDB's buffer pool, PostgreSQL's shared buffers).

But a DB buffer pool is not a plain LRU cache. Since what it holds is the "original" and edits happen here, three safeguards attach.

| Safeguard | Role |
|---|---|
| **pin count** | a page in use (pin>0) is never evicted (it must not vanish mid-write) |
| **dirty flag** | a modified page is marked -> flushed on evict/flush; an unchanged one is just dropped (the disk has the original) |
| **LRU** | the victim is the least-recently-used unpinned frame |

![Buffer pool](/uploads/project/db-hobby/buffer-pool.svg)

These three are the trick behind "a cache whose data does not corrupt". When transactions/WAL arrive, a fourth rule — **no-steal** (never evict an uncommitted dirty page) — joins them, covered in [Part 4](/blog/project/db-hobby/db-hobby-4-transactions).

> Deeper: [Cache vs Buffer](/blog/theory/cache-and-buffer) and [JVM Memory ④: OS Page Cache](/blog/theory/es-memory-04-page-cache).

## 5. The Heap File — Finally, a Table

Tie the pager, slotted page, and buffer pool together and you finally get a **table**. A heap file is a collection of **unordered** pages — "heap" here means a careless pile, not the data structure. Insert a row into a page with free space, else append a new page. No sort, no placement rule (db-hobby simply checks from the last page; PostgreSQL uses an FSM (Free Space Map) to find a page with room).

So a row needs an address: **RID = (page_id, slot)**. Since slot numbers are stable, an RID does not change when the row moves within a page. RID is a generic term, and PostgreSQL's TID (ctid) plays exactly this role; the B+Tree index we build soon points at it via "key -> RID".

![Heap file](/uploads/project/db-hobby/heap-file.svg)

The most basic form of `SELECT * FROM t`, the **sequential scan**, is a double loop over every page and every slot — O(rows). It is the starting point of every relational DB, and the very reason we add an index later is to avoid that O(n). db-hobby simplifies to **one table = one file** (`<db>.<table>.tbl`), like PostgreSQL's relfilenode ([Part 5](/blog/project/db-hobby/db-hobby-5-join-aggregate) revisits this with multiple tables).

Why an unordered heap at all? The other path is to store the data itself sorted in PK order — InnoDB's clustered index (index-organized table). They have opposite trade-offs.

| | Heap (PostgreSQL·db-hobby) | Clustered (InnoDB) |
|---|---|---|
| Storage order | unordered | sorted by PK |
| INSERT | toss into free space (fast·simple) | insert at sorted position -> page splits, slow for random PK |
| PK lookup | index -> RID -> heap (2 steps) | PK index leaf is the data (one tree) |
| Secondary index | points by RID (physical) | holds PK value, "secondary -> PK -> data" |

> **A design choice**: not "which is better" but a choice driven by workload (write-heavy vs PK-lookup-heavy). db-hobby picked the heap because it is overwhelmingly simpler for learning — INSERT is one `heap_insert`, and the upcoming B+Tree index detaches cleanly as a separate "key -> RID" structure.

> Deeper: [DB Index ⑤: Clustered Index and Per-DBMS Differences](/blog/theory/db-index-05-clustered-dbms).

## 6. Wrap-up

The storage layer is four tiers that "lay bytes onto disk safely and handle them per row": pager (disk I/O) -> slotted page (row packing) -> buffer pool (cache) -> heap (table). The key design choices:

- **Fixed-size pages** — disks do block I/O, so the DB makes a page its unit. Size is a trade-off of metadata overhead vs IOPS/cache efficiency (the Five-Minute Rule).
- **Slotted page** — packs variable-length rows, and the slot number becomes a stable address (TID/RID) the index points at.
- **Buffer pool** — not plain LRU; pin/dirty are required so "the cache does not corrupt".
- **Heap vs clustered** — db-hobby is a PostgreSQL-style heap (simple writes, 2-step index->heap PK lookup); InnoDB is clustered (the PK index leaf is the data, complex writes).

No SQL yet. [Next](/blog/project/db-hobby/db-hobby-2-sql-engine) we put SQL on top — tokenize text into an AST, and have an executor scan this heap and return real rows.

## References

- [PostgreSQL Documentation: Database Page Layout](https://www.postgresql.org/docs/current/storage-page-layout.html)
- [PostgreSQL Documentation: Physical Storage (relfilenode, heap)](https://www.postgresql.org/docs/current/storage.html)
- Jim Gray & Franco Putzolu, *The 5 Minute Rule for Trading Memory for Disc Accesses* (1987)
- This blog: [DB Storage Internals ①](/blog/theory/db-storage-01-heap-page-index) · [DB Index ⑤: Clustered](/blog/theory/db-index-05-clustered-dbms) · [Cache vs Buffer](/blog/theory/cache-and-buffer)
- [db-hobby on GitHub](https://github.com/dj258255/db-hobby)

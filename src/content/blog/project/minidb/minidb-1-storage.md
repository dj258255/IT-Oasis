---
title: '저장 계층: 페이지에서 힙까지'
titleEn: 'The Storage Layer: From Pages to the Heap'
description: "PostgreSQL·MySQL이 내부에서 어떻게 동작하는지 이해하려고 관계형 DB를 C로 밑바닥부터 만든 minidb 시리즈. 1편은 가장 아래 저장 계층 — 고정 크기 페이지를 디스크에 읽고 쓰는 페이저, 가변 길이 행을 페이지에 욱여넣는 슬롯 페이지, 디스크를 매번 때리지 않게 하는 버퍼 풀(pin/dirty/LRU), 그리고 이 셋을 묶어 만든 첫 테이블인 힙 파일까지 직접 구현한다."
descriptionEn: "minidb is a relational database built from scratch in C to understand how PostgreSQL and MySQL work inside. Part 1 builds the storage layer from the bottom: a pager that reads/writes fixed-size pages, slotted pages that pack variable-length rows, a buffer pool (pin/dirty/LRU), and the heap file that ties them into a first table."
date: 2026-05-11
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

데이터베이스를 직접 만들어보고 싶었다.
계기는 OS였다.
운영체제를 공부하다 보면 페이지, 캐시, 동시성, 파일에 바이트를 얹고 다시 읽는 법 같은 기본 개념들이 계속 나온다.
그런데 DB라는 게 결국 **그 개념들을 가져다 최대한 최적화하고, 사람이 쓰기 좋게 SQL이라는 얼굴을 씌워 놓은 것**이더라.
그러니 DB를 밑바닥부터 한 겹씩 만들어 보면, OS의 그 개념들이 실제로 어떻게 맞물려 돌아가는지, 그리고 무엇보다 **이걸 만든 사람들이 무슨 고민 끝에 왜 이렇게 설계했는지** 그 의도를 손으로 따라가 볼 수 있겠다 싶었다.
새로운 걸 발명하려는 게 아니라, 이미 있는 진짜를 정확히 재현하면서 그 안에 담긴 생각을 이해하는 것.

그렇게 만든 게 **minidb** 다.
PostgreSQL·MySQL 같은 관계형 DB가 내부에서 어떻게 동작하는지를, C로 한 겹씩 직접 구현하며 해부한 학습 프로젝트다.
이 시리즈는 페이저부터 트랜잭션·조인·집계까지 밑바닥부터 쌓아 올렸고, 거기에 이후 더한 SQL 기능과 실측까지 이어 담는다(전 계층 테스트 223개).
그 첫 편인 이 글은 맨 아래 — 바이트를 디스크에 얹는 **저장 계층** 을 짓는다.

## 전체 지도

DB는 한 덩어리가 아니라 여러 계층의 합이다.
위에서 아래로 이렇게 쌓인다.

![minidb 계층 지도 — SQL 텍스트가 파서·플래너·실행기를 거쳐 카탈로그·접근(힙/B-Tree)·버퍼풀·페이지·페이저로 내려가고, WAL이 내구성을 받친다](/uploads/project/minidb/layer-map.svg)

핵심 사실: **모든 것은 고정 크기 페이지 위에 쌓인다.** (PostgreSQL 8KB, MySQL InnoDB 16KB, SQLite 4KB.) 그래서 맨 아래(페이저)부터 짓는다.
이번 편은 [8]~[5] 네 계층을 만든다.

**왜 C인가.** 목표가 "진짜 구조를 있는 그대로 해부"라면, 진짜 DB가 쓰는 언어로 하는 게 맞다.
DB 내부는 메모리·포인터·바이트 레이아웃이 곧 학습 내용인데, 언어가 이걸 추상화로 가리면 정작 배우려는 걸 못 본다.
C는 아무것도 안 가린다.

---

## 페이저 — 페이지를 디스크에 읽고 쓰기

가장 밑바닥.
페이저는 단 하나만 책임진다 — "page_id로 4096바이트 페이지 하나를 디스크에서 읽고 쓴다".
왜 행 단위가 아니라 **페이지 단위**일까? 디스크(그리고 OS·SSD 컨트롤러)는 바이트가 아니라 블록 단위로 I/O를 한다.
1바이트를 읽어도 그 바이트가 속한 블록 전체가 올라온다.
그러니 DB도 처음부터 블록(페이지)을 작업 단위로 잡는 게 맞다.
페이지를 **고정 크기**로 잡으면 또 하나의 선물이 따라온다 — N번 페이지의 파일 내 위치가 곱셈 한 번으로 정해진다.

```c
int pager_read(Pager *p, page_id_t id, void *buf) {
    off_t offset = (off_t)id * PAGE_SIZE;   // N번 페이지 = N * 4096
    ssize_t n = pread(p->fd, buf, PAGE_SIZE, offset);
    return (n == (ssize_t)PAGE_SIZE) ? 0 : -1;
}
```

`read`/`write` 말고 `pread`/`pwrite`를 쓴 건 사소하지만 의도가 있다.
보통의 `read`/`write`는 파일의 "현재 위치"를 들고 다녀서, 엉뚱한 데를 읽으려면 `lseek`로 먼저 옮겨야 한다.
`pread(fd, buf, len, offset)`는 오프셋을 인자로 받으니 그 단계가 없다.
페이지 위치가 곱셈 하나로 나오는 우리 모델엔 이게 더 자연스럽고, 덤으로 멀티스레드에서도 안전하다(우린 단일 스레드라 덤일 뿐이지만).

페이지를 왜 하필 4KB로 잡았나.
사실 정답은 없고 DB마다 다르다 — PostgreSQL 8KB, InnoDB 16KB, SQLite는 2016년부터 4KB(그 전엔 1KB)다.
이게 그냥 취향이 아니라, 1985년 Jim Gray의 "**5분 규칙(Five-Minute Rule)**"에서 나온 경제학적 계산이다.
"디스크에서 읽어온 페이지를 메모리에 얼마나 들고 있어야 본전인가"를 디스크값·램값으로 따지면 8KB 안팎이 나오고, 그래서 1980년대 Berkeley POSTGRES가 8KB를 골랐다(당시 OS 가상 메모리 페이지가 4~8KB라 한 페이지가 OS 페이지에 딱 맞물리는 이점도 있었다).
큰 페이지는 메타데이터 오버헤드가 적은 대신 SSD에서 IOPS가 떨어지고(예: 어떤 인텔 SSD는 4KB로 75,000 IOPS인데 8KB면 47,500으로 약 37% 하락), 같은 캐시 메모리에 들어가는 페이지 수도 절반이 된다.
나는 학습용이라 "한 페이지에 행 몇 개"가 눈에 잘 들어오게 작은 4KB로 갔다.
어차피 어떤 크기든 "고정 크기"라는 점만 같으면 위 코드는 안 바뀐다.

![페이저 테스트 — 라운드트립 + 재오픈 영속성 11개 통과](/uploads/project/minidb/pager-test-output.svg)

> 더 깊이: [DB 스토리지 내부 ①: Heap, Page, Index, B-Tree](/blog/theory/db-storage-01-heap-page-index) — 왜 행이 아니라 페이지가 DB의 작업 단위인지, PostgreSQL 8KB / InnoDB 16KB 페이지가 어떻게 얽히는지 실제 DB 관점에서.

## 슬롯 페이지 — 4096바이트 안에 행 욱여넣기

페이지는 아직 그냥 4096바이트 덩어리일 뿐이다.
여기에 **가변 길이** 행을 여러 개 담으려면 문제가 하나 있다.
`'kim'`은 3바이트, `'alexander'`는 9바이트다.
길이가 제각각인 행을 어디서부터 어디까지인지 어떻게 알고, 중간 행이 지워지거나 길이가 바뀌면 어떻게 정리할까? 답이 **슬롯 페이지(slotted page)** 다.
PostgreSQL heap 페이지, InnoDB 페이지가 전부 이 구조다.

레이아웃은 양쪽에서 가운데로 자라는 모양이다.
페이지 **앞**에는 헤더 뒤로 **슬롯 배열**(각 슬롯 = "이 행은 페이지 안 offset 몇, 길이 몇")이 아래로 자라고, 페이지 **끝**에서는 실제 레코드 바이트가 위로 자란다.
가운데가 빈 공간이고, 둘이 만나면 그 페이지는 꽉 찬 것이다.

![슬롯 페이지 레이아웃 — 슬롯 배열은 아래로, 레코드는 위로, 가운데 빈 공간](/uploads/project/minidb/slotted-page-layout.svg)

더 간단한 길도 있었다.
모든 행을 같은 길이로 못 박아두면(고정 길이 레코드) 슬롯 배열 같은 건 필요 없다.
N번 행은 그냥 `헤더 + N * 행크기` 위치에 있으니까.
옛날 DB나 일부 임베디드 시스템이 이렇게 한다.
문제는 TEXT다.
이름이 'kim'이든 'alexander'든 가장 긴 길이에 맞춰 칸을 잡아야 하니 공간이 줄줄 새고, 그래도 가변 길이를 못 담는 경우가 생긴다.
그래서 진짜 관계형 DB는 거의 다 슬롯 페이지를 쓴다 — PostgreSQL heap, InnoDB, SQLite 전부.

그런데 슬롯 페이지의 진짜 값어치는 공간 절약이 아니라 **슬롯 번호가 행의 안정적인 주소**가 된다는 데 있다.
행이 지워져 빈 공간이 생기고 페이지를 compact하면서 레코드가 물리적으로 옮겨져도, 슬롯 배열의 그 칸(슬롯 번호)은 그대로다 — 슬롯 안의 offset만 고치면 되니까.
덕분에 바깥(인덱스)에서 "페이지 5의 슬롯 2"라는 주소로 행을 가리켜도, 행이 페이지 안에서 아무리 움직여도 그 주소가 안 깨진다.
PostgreSQL은 이걸 **TID(ctid)**, InnoDB는 레코드 포인터라 부르고, 잠시 뒤 우리 `RID`도 똑같은 발상이다.
(참고로 InnoDB도 페이지 안에선 Page Directory라는 슬롯 디렉터리로 레코드를 이진 탐색한다.
다만 행을 PK 순서로 정렬해 저장하는 클러스터드 구조라, 보조 인덱스가 행을 가리킬 때 물리 슬롯 포인터가 아니라 PK 값을 쓴다 — "행을 물리 위치로 식별하느냐 PK로 식별하느냐"가 힙과 갈리는 지점이다.) 삭제할 때 실제로 안 지우고 슬롯만 **tombstone**(무효 표시) 처리하는 것도 같은 이유 — 인덱스가 가리키던 주소를 살아있게 두려는 거다.

## 버퍼 풀 — 디스크를 매번 때리지 않기

페이지를 읽을 때마다 디스크를 때리면 느리다.
메모리는 디스크(특히 회전 디스크)보다 수만~수십만 배 빠르니, 자주 쓰는 페이지는 메모리에 들고 있어야 한다.
**버퍼 풀**이 그 역할 — 고정 개수의 "프레임"에 페이지를 캐시하고, 요청한 페이지가 있으면(hit) 그대로, 없으면(miss) 디스크에서 읽어 올린다.
자리가 없으면 LRU로 victim을 골라 쫓아낸다(InnoDB buffer pool, PostgreSQL shared buffers와 같은 역할).

그런데 단순한 LRU 캐시와 **DB 버퍼 풀**은 다르다.
캐시에 든 게 "원본"이고 수정도 여기서 일어나기 때문에, 세 가지 안전장치가 붙는다:

- **pin count** — 지금 누가 읽거나 쓰는 중인 페이지(pin>0)는 절대 쫓아내지 않는다. 쓰는 도중 메모리에서 사라지면 안 되니까.
- **dirty 플래그** — 메모리에서 수정된 페이지는 표시해 두고, 쫓겨나거나 flush될 때 디스크에 반영한다. 안 바뀐 페이지는 그냥 버리면 된다(디스크에 원본이 있으니).
- **LRU** — victim은 pin 안 된 것 중 가장 오래 안 쓴 프레임.

![버퍼 풀 — 프레임(page/pin/dirty/LRU), miss는 디스크 로드, dirty면 evict 시 flush](/uploads/project/minidb/buffer-pool.svg)

이 셋이 "캐시인데 데이터가 안 깨지는" 비결이다.
나중에 트랜잭션·WAL을 붙일 때 여기에 **no-steal**(커밋 안 된 dirty 페이지는 victim에서 제외)이라는 네 번째 규칙이 더 붙는데, 그 얘기는 [4편](/blog/project/minidb/minidb-4-transactions)에서 한다.

> 더 깊이: [캐시와 버퍼: 속도 차이를 극복하는 두 가지 방법](/blog/theory/cache-and-buffer) — 캐시(읽기 가속)와 버퍼(생산자-소비자 속도차 완충)가 어떻게 다른지, 메모리 계층 전반. 그리고 [JVM 메모리 ④: OS Page Cache](/blog/theory/es-memory-04-page-cache) — DB 버퍼 풀과 별개로 OS가 또 한 겹 캐시하는 이중 캐시 구조.

## 힙 파일 — 드디어 테이블

페이저·슬롯 페이지·버퍼 풀을 묶으면 비로소 **테이블**이 나온다.
힙 파일(heap file)은 **순서 없는** 페이지들의 모음이다 — "heap"은 자료구조 힙이 아니라 "아무렇게나 쌓아둔 더미"라는 뜻이다.
행을 넣으면 마지막 페이지에 자리가 있으면 거기에, 없으면 새 페이지를 붙인다.
정렬도, 위치 규칙도 없다.
그래서 행의 주소가 필요한데, 그게 **RID = (page_id, slot)** 이다 — "몇 번 페이지의 몇 번 슬롯".
앞서 본 대로 슬롯 번호가 안정적이라, RID는 행이 페이지 안에서 옮겨져도 안 바뀐다.
PostgreSQL의 TID와 정확히 같은 개념이고, 곧 만들 B+Tree 인덱스가 "키 -> RID"로 이걸 가리킨다.

![힙 파일 — 여러 페이지에 행이 슬롯으로 담기고, full scan은 모든 페이지를 훑는다](/uploads/project/minidb/heap-file.svg)

`SELECT * FROM t` 의 가장 기본 형태인 **풀 스캔(sequential scan)** 은 힙의 모든 페이지를, 페이지 안의 모든 슬롯을 훑는 이중 루프다.
O(행 수).
모든 관계형 DB의 출발점이자, 나중에 인덱스를 붙이는 이유가 바로 이 O(n)을 피하려는 것이다.
minidb는 한 가지 단순화를 했다 — **테이블 하나 = 파일 하나**(`<db>.<테이블>.tbl`).
PostgreSQL이 릴레이션마다 파일을 따로 두는 relfilenode 방식과 닮았고, 그 얘기는 [5편](/blog/project/minidb/minidb-5-join-aggregate)에서 다중 테이블을 만들 때 다시 나온다.

여기서 "왜 굳이 순서 없는 힙이냐"를 짚고 넘어가야겠다.
다른 길은 **데이터 자체를 PK 순서로 정렬해 저장**하는 것이다 — InnoDB의 클러스터드 인덱스(=index-organized table)가 그렇다.
둘은 정반대의 장단점을 가진다.

- **힙(PostgreSQL 방식, 우리가 고른 것)**: INSERT가 그냥 빈자리에 던져 넣으면 끝이라 쓰기가 빠르고 단순하다. 대신 PK로 한 줄을 찾을 때 인덱스에서 RID를 얻고(1단계) 힙에서 그 RID를 또 읽는(2단계) "두 번" 일을 한다.
- **클러스터드(InnoDB 방식)**: 데이터가 PK 순서로 누워 있으니 PK 조회가 한 방에 끝난다(인덱스가 곧 데이터). 대신 INSERT가 정렬 위치를 찾아 끼워 넣어야 해서 페이지 분할이 일어나고, PK가 UUID처럼 무작위면 새 행이 여기저기 흩어져 쓰기가 느려진다. 게다가 보조 인덱스는 RID가 아니라 PK 값을 들고 있어서, 보조 인덱스 조회는 "보조 인덱스 -> PK -> 클러스터드 인덱스"로 한 번 더 돈다.

학습용으론 힙이 압도적으로 단순해서 골랐다 — INSERT가 `heap_insert` 한 줄이고, 곧 만들 B+Tree 인덱스를 "키 -> RID"라는 별도 구조로 깔끔하게 떼어 볼 수 있으니까.
"어느 게 더 좋다"가 아니라 워크로드(쓰기 위주냐 PK 조회 위주냐)에 따라 갈리는 설계 선택이다.

> 더 깊이: [DB 인덱스 ⑤: 클러스터형 인덱스와 DBMS별 차이](/blog/theory/db-index-05-clustered-dbms) — heap-organized(PostgreSQL)와 index-organized(InnoDB)의 보조 인덱스 경로·PK 전략 차이를 실제 DB로.

---

여기까지가 "바이트를 디스크에 안전하게 얹고, 행 단위로 다루는" 저장 계층이다.
페이저(디스크 I/O) -> 슬롯 페이지(행 패킹) -> 버퍼 풀(캐시) -> 힙(테이블) 네 겹을 밑에서부터 쌓았다.
아직 SQL은 한 글자도 안 받았다.
[다음 편](/blog/project/minidb/minidb-2-sql-engine)에선 그 위에 SQL을 얹는다 — 텍스트를 토큰으로 쪼개 AST로 파싱하고, 실행기가 이 힙을 훑어 진짜 행을 돌려주기까지.

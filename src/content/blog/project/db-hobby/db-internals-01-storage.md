---
title: 'DB 내부 ①: 저장의 뼈대 — 페이지·슬롯·행 포맷·힙·버퍼 풀은 어떻게 맞물리는가'
titleEn: 'DB Internals ①: The Storage Skeleton — How Pages, Slots, Row Format, Heap, and the Buffer Pool Interlock'
description: "관계형 DB의 맨 아래는 다섯 겹이다 — 고정 크기 페이지(왜 모든 DB가 블록 단위인가), 슬롯 페이지(가변 행 + 안정적 주소), 행 포맷(null 비트맵), 힙 파일(RID), 그리고 버퍼 풀(캐시인데 안 깨지는 이유). PostgreSQL 8KB·InnoDB 16KB가 왜 그 크기인지, TID/RID가 왜 인덱스의 기반인지, NULL은 왜 값이 아니라 비트로 저장되는지, pin 프로토콜이 어떻게 latch와 분업해 멀티스레드에서 페이지를 지키는지 — C로 미니 DB를 직접 구현하고 ThreadSanitizer로 계측하며 확인한 내용을 1차 자료 기준으로 정리해요."
descriptionEn: "The bottom of a relational DB is five layers — fixed-size pages (why every DB works in blocks), the slotted page (variable-length rows + stable addresses), the row format (null bitmap), the heap file (RID), and the buffer pool (why a cache that holds the source of truth doesn't corrupt). Why PostgreSQL chose 8KB and InnoDB 16KB, why TID/RID is the foundation indexes point at, why NULL is stored as a bit rather than a value, and how the pin protocol divides labor with the latch to protect pages under real threads — verified by building a mini DB in C and measuring with ThreadSanitizer, grounded in primary sources."
date: 2026-01-18T00:00:00.000Z
tags:
  - Database Internals
  - Storage
  - Buffer Pool
  - PostgreSQL
  - InnoDB
  - C
category: study/db-hobby
coverImage: /uploads/project/db-hobby/cover.svg
draft: false
series: "미니 DB로 이해하는 DB 내부"
seriesOrder: 1
---

## 0. 들어가며 — 만들어 보며 확인한 것만 적습니다

이 시리즈는 PostgreSQL·MySQL InnoDB 같은 관계형 DB의 내부를, **C로 미니 DB([db-hobby](https://github.com/dj258255/db-hobby))를 밑바닥부터 직접 구현하며** 확인한 기록이에요. 페이지 한 장에서 시작해 MVCC 스냅샷 격리, 진짜 `psql`이 붙는 wire protocol 서버, 병렬 실행, Raft 합의로 복제되는 HA 구성까지 올라갔고, 전 계층이 **테스트 686개 / 42스위트**로 덮여 있으며 동시성은 ThreadSanitizer로 계측했습니다.

문헌 요약이 아니라, **구현하다 부딪힌 벽이 곧 목차**입니다. "왜 이렇게 설계했는가"는 만들어 보면 몸으로 알게 되거든요. 각 편은 한 주제를 완결로 다루고, 실제 DB(PostgreSQL·InnoDB)가 같은 문제를 어떻게 푸는지 1차 자료 기준으로 대조합니다.

1편은 맨 아래 — **저장의 뼈대** 다섯 겹이에요. 페이지, 슬롯 페이지, 행 포맷, 힙, 버퍼 풀. 이 다섯이 어떻게 맞물리는지를 이해하면, 그 위의 모든 것(인덱스·WAL·MVCC)이 왜 그 모양인지가 보입니다.

## 1. 전체 지도 — 거의 모든 것은 고정 크기 페이지 위에

DB는 한 덩어리가 아니라 계층의 합이에요. 위에서 아래로:

![DB 계층 지도 — SQL 텍스트가 파서·플래너·실행기를 거쳐 카탈로그·접근(힙/B-Tree)·버퍼풀·페이지·페이저로 내려가고, WAL이 내구성을 받친다](/uploads/project/db-hobby/layer-map.svg)

> **핵심 사실**: 페이지 기반 관계형 DB에선 거의 모든 것이 **고정 크기 페이지** 위에 쌓인다 — PostgreSQL·InnoDB·SQLite·db-hobby가 그렇다. (반면 RocksDB·Cassandra 같은 LSM 계열은 페이지 중심이 아니다 — [7편(저장 엔진의 세 철학)](/blog/project/db-hobby/db-internals-07-storage-engines)에서 대조합니다.)

그 "한 페이지"의 크기는 DB마다 다릅니다.

| DB | 페이지 크기 |
|---|---|
| **db-hobby** | 4KB |
| PostgreSQL | 8KB |
| MySQL InnoDB | 기본 16KB (`innodb_page_size` 4K~64K 설정 가능) |
| SQLite | 기본 4KB (3.12.0/2016~, 이전 기본 1KB · 512B~64KB 설정 가능) |

## 2. 페이저 — 왜 행이 아니라 페이지 단위인가

가장 밑바닥의 페이저(pager)는 단 하나만 책임져요 — "`page_id`로 고정 크기 페이지 하나를 디스크에서 읽고 쓴다".

> **왜 행이 아니라 페이지 단위인가**: 디스크(그리고 OS·SSD 컨트롤러)는 바이트가 아니라 **블록 단위**로 I/O를 한다. 1바이트를 읽어도 그 바이트가 속한 블록 전체가 올라온다. 그러니 DB도 처음부터 블록(페이지)을 작업 단위로 잡는 게 맞다.

페이지를 **고정 크기**로 잡으면 선물이 따라옵니다 — N번 페이지의 파일 내 위치가 곱셈 한 번으로 정해져요.

```c
int pager_read(Pager *p, page_id_t id, void *buf) {
    off_t offset = (off_t)id * PAGE_SIZE;   // N번 페이지 = N * 4096
    ssize_t n = pread(p->fd, buf, PAGE_SIZE, offset);
    return (n == (ssize_t)PAGE_SIZE) ? 0 : -1;
}
```

`read`/`write` 대신 `pread`/`pwrite`를 쓴 것도 의도가 있어요. 보통의 `read`는 파일의 "현재 위치"를 들고 다녀서 `lseek`로 먼저 옮겨야 하는데, `pread(fd, buf, len, offset)`는 오프셋을 인자로 받으니 그 단계가 없습니다. 그리고 공유 파일 오프셋을 건드리지 않아 **멀티스레드에서 안전**해요 — 한 스레드의 `lseek`와 다른 스레드의 읽기가 위치를 꼬이게 만드는 race가 없습니다. 이 성질은 나중에 6절(버퍼 풀의 병렬 I/O)에서 실제로 값을 합니다.

### 페이지 크기는 왜 4/8/16KB인가

정답은 없고 DB마다 다른데, 자주 인용되는 출발점이 1987년 Jim Gray와 Gianfranco Putzolu의 **5분 규칙(Five-Minute Rule)** — "디스크에서 읽어온 페이지를 메모리에 얼마나 들고 있어야 본전인가"를 디스크값·램값으로 따지는 경제학적 계산이에요. 다만 실제 DB의 선택이 이 하나로 정해진 건 아닙니다. 1980년대 Berkeley POSTGRES가 8KB를 고른 데는 당시 Unix 가상 메모리 페이지 크기, I/O 효율 등이 함께 작용했고, PostgreSQL 문서가 "5분 규칙 때문에 8KB"라고 직접 말하지도 않아요.

> **실무/면접 포인트**: 큰 페이지는 메타데이터 오버헤드가 적은 대신 일부 SSD에선 IOPS가 떨어질 수 있고(예컨대 어떤 인텔 SSD 벤치마크에선 4KB 75,000 IOPS → 8KB 47,500으로 ~37% 하락 — SSD·큐 깊이·컨트롤러에 따라 달라지니 일반 법칙은 아님), 같은 캐시 메모리에 들어가는 페이지 수도 절반이 됩니다. **"페이지 크기 = 메타데이터 오버헤드 vs IOPS·캐시 효율의 트레이드오프"**가 정확한 설명이에요. db-hobby는 학습용이라 "한 페이지에 행 몇 개"가 눈에 들어오는 4KB로 갔습니다 — 어떤 크기든 "고정"이기만 하면 위 코드는 안 바뀝니다.

> 더 깊이: [DB 스토리지 내부 ①: Heap, Page, Index, B-Tree](/blog/theory/db-storage-01-heap-page-index)

## 3. 슬롯 페이지 — 가변 행, 그리고 안정적 주소

페이지는 아직 4096바이트 덩어리일 뿐이에요. 여기에 **가변 길이** 행을 여러 개 담으려면 문제가 있습니다. `'kim'`은 3바이트, `'alexander'`는 9바이트 — 길이가 제각각인 행이 어디서 어디까지인지 어떻게 알고, 중간 행이 지워지면 어떻게 정리할까요? 답이 **슬롯 페이지(slotted page)** 입니다. PostgreSQL heap 페이지가 정확히 이 구조고, db-hobby도 같은 길을 갔어요. (InnoDB 페이지는 비슷해 보이지만 성격이 다릅니다 — 아래 상자에서.)

레이아웃은 양쪽에서 가운데로 자라는 모양이에요. 페이지 **앞**에는 헤더 뒤로 **슬롯 배열**(각 슬롯 = "이 행은 offset 몇, 길이 몇")이 아래로 자라고, 페이지 **끝**에서는 실제 레코드 바이트가 위로 자랍니다. 둘이 만나면 꽉 찬 거예요.

![슬롯 페이지 레이아웃 — 슬롯 배열은 아래로, 레코드는 위로, 가운데 빈 공간](/uploads/project/db-hobby/slotted-page-layout.svg)

더 단순한 길(고정 길이 레코드: N번 행 = `헤더 + N × 행크기`)과 비교하면:

| | 슬롯 페이지 (PG·InnoDB·db-hobby) | 고정 길이 레코드 |
|---|---|---|
| 가변 길이 TEXT | 자연스럽게 담음 | 가장 긴 길이에 맞춰야 해 공간 낭비 |
| 행 위치 | 슬롯 배열이 가리킴 | 곱셈 한 번 |
| 삭제·compact | 슬롯 번호 유지, offset만 수정 | 자리 재사용 어려움 |
| 채택 | 거의 모든 관계형 DB | 옛날·일부 임베디드 |

> **슬롯 페이지의 두 가지 값어치**: 하나는 가변 길이 행을 담는 것. 다른 하나는 — 어쩌면 더 중요한 — **슬롯 번호가 행의 안정적인 주소**가 된다는 것이다. 행이 지워져 페이지를 compact하며 레코드가 물리적으로 옮겨져도 슬롯 번호는 그대로다(슬롯 안의 offset만 고치면 되니까). 그래서 바깥(인덱스)에서 "페이지 5의 슬롯 2"로 행을 가리켜도 주소가 안 깨진다. PostgreSQL은 이걸 **TID(ctid)** 라 부른다 — 그리고 이 "슬롯 = 안정적 외부 주소" 성질은 PostgreSQL·db-hobby 쪽 이야기다.

> **실무/면접 포인트**: InnoDB 페이지에도 Page Directory라는 게 있지만 성격이 달라요 — 슬롯 하나가 행 하나가 아니라 **4~8개 레코드당 슬롯 하나**인 sparse 디렉터리라, 슬롯으로 근처까지 좁힌 뒤 레코드 체인을 따라갑니다. 즉 InnoDB에는 TID급의 안정적 외부 주소가 사실상 없어요. 행을 PK 순서로 정렬해 저장하는 클러스터드 구조라, 보조 인덱스가 행을 가리킬 때도 물리 포인터가 아니라 **PK 값**을 씁니다. "행을 물리 위치로 식별하느냐(PG) PK로 식별하느냐(InnoDB)"가 저장 엔진이 갈리는 지점이에요 — [7편](/blog/project/db-hobby/db-internals-07-storage-engines)에서 실측으로 대조해요.

덧붙이면 PostgreSQL은 페이지에 일부러 빈 공간을 남겨두는 다이얼도 줍니다 — `FILLFACTOR`. 기본값 100은 페이지를 꽉 채우고, 90으로 낮추면 10%를 UPDATE 몫으로 남겨둬요. 새 버전이 같은 페이지에 들어갈 자리가 있으면 인덱스를 안 고치고 끝나는 **HOT(Heap-Only Tuple)** 업데이트가 가능해지거든요 — UPDATE가 왜 "새 버전 만들기"인지는 [4편(MVCC)](/blog/project/db-hobby/db-internals-04-mvcc)에서 다룹니다.

## 4. 행 포맷 — 값을 바이트로, 그리고 NULL은 비트로

슬롯 하나에 들어가는 "행"은 어떻게 생겼을까요. db-hobby의 행은 `[MVCC 헤더 8B][null 비트맵][값들...]` — `INT`는 4바이트, `TEXT`는 "길이 + 바이트"로 순차 인코딩합니다(MVCC 헤더는 [4편(격리)](/blog/project/db-hobby/db-internals-04-mvcc)의 주인공이라 여기선 자리만 알아두세요).

여기서 구현하다 부딪히는 첫 번째 벽이 **NULL**이에요.

### NULL은 데이터 안의 어떤 값으로도 표현할 수 없다

처음 떠오르는 건 특별한 값의 약속입니다 — "정수 `-1`을 NULL로 치자". 바로 막혀요. `-1`은 멀쩡한 정수 값이라, 진짜 `-1`을 저장하려는 순간 구분이 안 됩니다. 빈 문자열 `''`도 NULL이 아니라 "길이 0인 문자열"이라는 엄연히 다른 값이고요.

> **핵심 사실**: NULL은 일반 데이터 값이 아니라 **"값이 없음"을 나타내는 특수 표지(marker)** 다. 일반 INT·TEXT 데이터 *그 자체*로는 표현할 수 없으니, 데이터 **바깥**에 따로 표시해야 한다.

그래서 대표적인 row-store DB가 쓰는 방법이 **null 비트맵**입니다. 행 앞에 컬럼 수만큼의 비트를 두고, i번째 비트가 1이면 "i번째 컬럼은 NULL". NULL인 컬럼은 비트만 켜고 **값 바이트를 아예 안 씁니다**(공간 절약).

| | db-hobby | PostgreSQL | InnoDB |
|---|---|---|---|
| 위치 | MVCC 헤더 뒤, 값 앞 | 튜플 헤더의 `t_bits` | 행 헤더(가변 부분) |
| 크기 | 컬럼당 1비트 | 컬럼당 1비트 | nullable 컬럼당 1비트 |
| NULL 컬럼의 값 바이트 | 안 씀 | 안 씀 | 안 씀 |
| 비트맵 생략 | 안 함 (항상 존재) | **그 행에 NULL이 없으면** 그 행에서 생략 — 스키마가 아니라 행 단위 판정 | NOT NULL 컬럼은 비트맵에서 제외 |

PostgreSQL의 생략 판정은 행마다예요 — 헤더의 `HEAP_HASNULL` 플래그가 그 스위치고, 공식 문서 표현 그대로 *"There is a null bitmap only if the HEAP_HASNULL bit is set in t_infomask."* 즉 같은 테이블 안에서도 NULL이 없는 행은 비트맵 없이, NULL이 있는 행은 비트맵을 달고 저장됩니다.

```c
/* 인코딩: 행 = MVCC 헤더(8B) + null 비트맵 + 값들 */
int nbits = (schema->num_columns + 7) / 8;      // 컬럼 8개당 1바이트
for (int i = 0; i < schema->num_columns; i++) {
    if (vals[i].type == VAL_NULL) {
        buf[MVCC_HDR + i / 8] |= (uint8_t)(1 << (i % 8)); // 비트만 켜고
        continue;                                          // 값 바이트는 안 쓴다
    }
    /* 아니면 INT 4바이트 / TEXT 길이+바이트 */
}
```

> **왜 비트맵을 값들보다 앞에 두나**: 값을 읽기 **전에** "이 컬럼이 NULL인지"를 알아야, 그 자리에서 4바이트를 읽을지 0바이트를 건너뛸지 정할 수 있다. 비트맵이 값들 뒤에 있으면 닭과 달걀이 된다 — 값을 다 읽어야 비트맵에 닿는데, 어디까지가 값인지 알려면 비트맵이 필요하니까. (offset 배열을 쓰는 포맷은 이 제약이 느슨해요 — 진짜 요건은 "값 해석 전에 NULL 여부를 알 수 있을 것"뿐입니다.)

덧붙이면, NULL의 **저장**(바이트 표현)과 NULL의 **의미**(3값 논리, `COUNT(col)`이 NULL을 건너뛰는 것, 정렬에서의 NULLS LAST)는 별개 관심사예요. db-hobby에선 의미 쪽을 실행기에 먼저 만들어 뒀더니, 저장(비트맵)을 나중에 뚫자 `WHERE x IS NULL`·집계·정렬이 손도 안 대고 그대로 돌았습니다 — 계층을 잘 끊으면 받는 보상을 손으로 확인한 순간이었어요.

### 행이 페이지보다 크면 — TOAST와 오버플로

여기까지는 "행이 페이지 하나에 들어간다"는 전제였어요. db-hobby는 그 전제를 아예 제약으로 못 박았습니다 — **행 ≤ 페이지**, 넘치는 삽입은 거부해요. 그럼 실제 DB에서 8KB 페이지에 1MB짜리 TEXT는 어떻게 들어갈까요? PostgreSQL 문서도 전제는 같습니다 — *"PostgreSQL uses a fixed page size (commonly 8 kB), and does not allow tuples to span multiple pages."* — 대신 우회로를 둡니다. **TOAST**: 행이 임계(기본 ~2KB)를 넘으면 큰 컬럼 값을 먼저 압축하고, 그래도 크면 별도의 TOAST 테이블로 잘라 내보내고 본 행엔 포인터만 남겨요. InnoDB는 **off-page 저장** — DYNAMIC 행 포맷에선 긴 가변 길이 컬럼을 오버플로 페이지로 빼고 본 행엔 20바이트 포인터만 둡니다. SQLite는 오버플로 페이지를 사슬로 잇고요.

| | PostgreSQL | InnoDB | SQLite | db-hobby |
|---|---|---|---|---|
| 행 > 페이지 처리 | **TOAST** (~2KB 임계: 압축 → 외부 테이블 + 포인터) | **off-page** (DYNAMIC: 오버플로 페이지 + 20B 포인터) | overflow page chain | **미지원 — 행 ≤ 페이지 제약** |

## 5. 힙 파일 — 드디어 테이블, 그리고 RID

페이저·슬롯 페이지·행 포맷을 묶으면 비로소 **테이블**이 나옵니다. 힙 파일(heap file)은 **순서 없는** 페이지들의 모음이에요 — "heap"은 자료구조 힙이 아니라 "아무렇게나 쌓아둔 더미"라는 뜻입니다. 행을 넣으면 빈자리가 있는 페이지에, 없으면 새 페이지에. 정렬도 위치 규칙도 없어요(PostgreSQL은 FSM(Free Space Map)으로 빈 공간 있는 페이지를 찾습니다).

행의 주소는 **RID = (page_id, slot)** — "몇 번 페이지의 몇 번 슬롯". 슬롯 번호가 안정적이라 행이 페이지 안에서 옮겨져도 RID는 안 바뀝니다. PostgreSQL의 TID(ctid)가 정확히 같은 역할이고, [2편](/blog/project/db-hobby/db-internals-02-btree-index)에서 만들 B+Tree 인덱스가 "키 → RID"로 이걸 가리켜요.

> **흔한 오해 정정**: *"ctid는 행의 안정적 주소니까 애플리케이션에서 행 식별자로 써도 된다?"* — 아니요. 이 안정성은 **페이지 안 compact에 한한** 이야기예요. PostgreSQL 공식 문서는 ctid에 대해 *"ctid will change if it is updated or moved by VACUUM FULL... useless as a long-term row identifier"* 라고 못 박습니다 — UPDATE는 (MVCC 때문에) 행의 새 버전을 다른 자리에 만들고, VACUUM FULL은 행을 페이지 밖으로 통째로 옮기니까요. 인덱스가 기대는 "짧은 수명의 물리 주소"와 앱이 원하는 "영속 식별자"는 다른 물건입니다.

> **실무 안티패턴**: ctid를 애플리케이션의 행 식별자(URL 파라미터, 외래 참조 대용)로 쓰는 것. UPDATE 한 번, VACUUM FULL 한 번에 조용히 끊어져요. 영속 식별자는 PK로.

![힙 파일 — 여러 페이지에 행이 슬롯으로 담기고, full scan은 모든 페이지를 훑는다](/uploads/project/db-hobby/heap-file.svg)

`SELECT * FROM t`의 기본형인 **풀 스캔(sequential scan)** 은 모든 페이지의 모든 슬롯을 훑는 이중 루프 — O(행 수)예요. 인덱스를 만드는 이유가 바로 이 O(n)을 피하려는 것이고요. 저장 방식의 다른 길(데이터 자체를 PK 순서로 정렬하는 InnoDB 클러스터드)과의 본격 대조는 [7편](/blog/project/db-hobby/db-internals-07-storage-engines)으로 미루고, 요지만:

| | 힙 (PostgreSQL·db-hobby) | 클러스터드 (InnoDB) |
|---|---|---|
| 저장 순서 | 순서 없음 | PK 순서 정렬 |
| INSERT | 빈자리에 던져 넣음 (단순·빠름) | 정렬 위치에 삽입 → 분할 가능 |
| PK 조회 | 인덱스 → RID → 힙 (2단계) | PK 인덱스 리프가 곧 데이터 |
| 보조 인덱스가 가리키는 것 | RID (물리 위치) | PK 값 |

## 6. 버퍼 풀 — 캐시인데 데이터가 안 깨지는 이유

페이지를 읽을 때마다 디스크를 때리면 느립니다. 메모리는 HDD 랜덤 I/O 기준 수만 배, NVMe SSD 기준으로도 수백 배 빠르니, 자주 쓰는 페이지는 메모리에 들고 있어야 해요. **버퍼 풀**이 그 역할 — 고정 개수의 "프레임"에 페이지를 캐시하고, hit면 그대로, miss면 디스크에서 올리고, 자리가 없으면 victim을 골라 쫓아냅니다. db-hobby의 victim 선택은 가장 단순한 순수 LRU예요(같은 자리를 InnoDB buffer pool, PostgreSQL shared buffers가 맡는데, 교체 정책은 일부러 다르게 갑니다 — 아래에서).

그런데 단순 LRU 캐시와 DB 버퍼 풀은 달라요. **캐시에 든 게 "원본"이고 수정도 여기서 일어나기 때문**에 안전장치가 붙습니다.

| 장치 | 역할 |
|---|---|
| **pin count** | 지금 누가 쓰는 중인 페이지(pin>0)는 절대 안 쫓아냄 |
| **dirty 플래그** | 메모리에서 수정된 페이지는 evict/flush 때 디스크 반영. 안 바뀐 건 그냥 버림 |
| **LRU** | victim은 pin 안 된 것 중 가장 오래 안 쓴 프레임 |

![버퍼 풀 — 프레임(page/pin/dirty/LRU), miss는 디스크 로드, dirty면 evict 시 flush](/uploads/project/db-hobby/buffer-pool.svg)

> **흔한 오해 정정**: *"버퍼 풀은 그냥 LRU 캐시다?"* — db-hobby는 순수 LRU가 맞지만, 실제 DB는 순수 LRU를 **일부러 피합니다.** 대형 순차 스캔 한 번이, 다시 안 읽을 페이지들로 캐시 전체를 밀어내 버리는 문제 때문이에요. PostgreSQL shared buffers는 LRU가 아니라 **clock-sweep** — 프레임마다 `usage_count`를 두고 시계바늘이 돌며 깎아, 여러 번 쓰인 페이지가 살아남습니다 — 이고, 대형 순차 스캔엔 아예 작은 전용 **ring buffer**를 줘서 본 캐시를 오염시키지 않아요. InnoDB buffer pool은 LRU의 변형인 **midpoint insertion** — 리스트를 new/old sublist로 나누고 새 페이지를 중간(old sublist 머리)에 넣어, 한 번 읽히고 마는 페이지가 hot 구역에 못 들어오게 합니다(`innodb_old_blocks_pct`·`innodb_old_blocks_time`). MySQL 매뉴얼의 표현 그대로 — *"a variation of the least recently used (LRU) algorithm... midpoint insertion strategy."*

| | db-hobby | PostgreSQL | InnoDB |
|---|---|---|---|
| 교체 정책 | 순수 LRU | clock-sweep (`usage_count`) | midpoint insertion LRU (new/old sublist) |
| 순차 스캔 방어 | 없음 | 전용 ring buffer | old sublist + `innodb_old_blocks_time` |

(트랜잭션이 붙으면 여기에 **no-steal/steal** 정책이 얹히고, 페이지가 절반만 디스크에 내려간 채 전원이 꺼지는 **torn page** 문제와 페이지 체크섬(PostgreSQL `data_checksums`) 얘기도 나오는데, 그건 [3편(WAL과 복구)](/blog/project/db-hobby/db-internals-03-wal-recovery)의 주제입니다.)

### 스레드를 켜면 가장 먼저 깨지는 곳

여기까지는 단일 스레드 얘기예요. 진짜 스레드를 켜면 **버퍼 풀이 가장 먼저 깨집니다** — SELECT든 INSERT든 인덱스 탐색이든, 모든 연산이 페이지를 읽으려면 반드시 여길 거치니까요. 모든 계층이 밟고 선 바닥이거든요.

```c
void *bufpool_fetch(BufferPool *bp, page_id_t page_id) {
    Frame *f = find_frame(bp, page_id);
    if (f) {
        bp->hits++;              /* ← 둘이 동시에 증가시키면 하나를 잃는다 */
        f->pin_count++;          /* ← pin 카운트가 꼬인다: 축출 보호가 깨짐 */
        ...
    }
    f = pick_frame(bp);          /* ← 둘이 같은 victim을 골라 서로 다른 페이지를 로드 */
}
```

`pin_count++`가 원자적이지 않으면, 두 스레드가 각자 pin을 걸었는데 카운트는 1만 오를 수 있어요. 한쪽이 unpin하는 순간 카운트가 0이 되고, **아직 그 페이지를 쓰고 있는 다른 스레드 밑에서 프레임이 축출**됩니다 — 데이터 교차 오염이에요. 추측이 아니라 측정 가능한 사실입니다. ThreadSanitizer로 컴파일해 돌리면 `data race on Frame::pin_count` 경고가 쏟아져요.

### 해법 — latch와 pin의 분업

고치는 방법: 버퍼 풀에 **latch**(mutex)를 달아 프레임 테이블을 건드리는 모든 연산을 임계구역으로 감쌉니다. 그런데 여기서 이 절의 핵심 통찰이 나와요 — **latch를 풀고 반환한 페이지 데이터를, 호출자는 latch 없이 씁니다.** 그동안 다른 스레드가 그 프레임을 축출하면 어떡하죠?

**축출되지 않습니다 — pin이 막으니까요.** `fetch`는 pin을 걸고 반환하고, victim 선택은 `pin_count != 0`인 프레임을 절대 안 고릅니다. 즉 **분업**이에요:

- **latch**는 프레임 *메타데이터*(pin 카운트, dirty, LRU, page↔frame 매핑)를 지킨다.
- **pin**은 반환된 *페이지 데이터*를 지킨다 — pin된 프레임은 축출 대상이 아니므로, latch 밖에서 오래 읽어도 그 자리에 그대로 있다.

이게 **pin 프로토콜**입니다. 이 분업 덕에 무거운 연산이 latch를 오래 쥐지 않아요 — pin만 잡고 latch는 즉시 놓습니다. PostgreSQL의 buffer pin + content lock, InnoDB의 buf_page pin이 정확히 이 두 겹 구조예요.

한 가지 더 — 캐시 miss 때의 **디스크 I/O를 latch 안에서 하느냐 밖에서 하느냐**도 갈림길입니다. latch 안에서 하면 단순하고 정확하지만 여러 스레드의 읽기가 직렬화돼요. 진짜 DB는 "read-in-progress" 상태를 두어 I/O를 latch 밖으로 뺍니다. db-hobby도 처음엔 안에서 하다가, 병렬 스캔을 실측하니 이게 콜드 캐시의 천장으로 드러나 밖으로 뺐어요 — 그 측정→수정→재측정의 이야기는 [8편(병렬 실행)](/blog/project/db-hobby/db-internals-08-parallel)에서 합니다.

### 증명 — ThreadSanitizer로 "레이스 없음"을 계측한다

동시성 코드에서 "테스트가 통과했다"는 약한 증거예요 — 레이스는 대부분의 실행에서 안 터지고 어쩌다 한 번 터지니까요. 그래서 **레이스 자체를 계측**합니다. 프레임(16개)보다 훨씬 많은 페이지(300개)로 축출이 끊임없이 일어나는 상황에서 8스레드가 동시에 두들기는 스트레스 테스트를 TSan 빌드로:

```
$ make test-tsan
  ok   동시 읽기 40000×8: 항상 그 페이지의 데이터 (교차 오염 0)
  ok   읽기 폭풍 뒤 모든 페이지 재조회 성공 (pin 누수 없음)
  ok   동시 쓰기 뒤 디스크의 모든 페이지 스탬프 정확 (축출/flush 무결성)
전체 통과       ← ThreadSanitizer 경고 0
```

TSan이 경고를 안 냈다는 건 "이번엔 안 터졌다"가 아니라 **관측된 실행에 data race가 실제로 없었다**는 뜻입니다. 훨씬 강한 증거예요.

> **실무 안티패턴**: "캐시는 클수록 좋다"며 PostgreSQL `shared_buffers`를 RAM 대부분으로 잡는 것. PostgreSQL은 OS 페이지 캐시 **위에서** 도는 구조라 같은 페이지가 두 캐시에 이중으로 얹히고 체크포인트 flush 부담도 커져요 — 공식 문서가 RAM의 25% 안팎을 출발점으로 권하는 이유입니다. 같은 결로, UPDATE가 잦은 테이블을 `FILLFACTOR` 기본값 100으로 방치하는 것도 HOT 업데이트(3절) 기회를 스스로 닫는 셈이에요.

> 더 깊이: [캐시와 버퍼: 속도 차이를 극복하는 두 가지 방법](/blog/theory/cache-and-buffer) · [JVM 메모리 ④: OS Page Cache](/blog/theory/es-memory-04-page-cache) — DB 버퍼 풀과 별개로 OS가 또 한 겹 캐시하는 이중 캐시 구조.

## 7. 정리

저장의 뼈대는 다섯 겹이고, 각 겹은 위 겹이 기대는 성질을 하나씩 제공합니다.

- **고정 크기 페이지** — 디스크가 블록 I/O를 하니 DB도 페이지가 작업 단위. 크기(4/8/16KB)는 메타데이터 오버헤드 vs IOPS·캐시 효율의 트레이드오프.
- **슬롯 페이지** — 가변 길이 행을 담고, **슬롯 번호가 안정적 주소**(TID/RID)가 된다. 인덱스가 여기에 기댄다.
- **행 포맷** — NULL은 값으로 표현 불가능하므로 **비트맵**으로, 값보다 앞에. PG `t_bits`·InnoDB 모두 같은 발상.
- **힙 파일** — 순서 없는 페이지 모음 + RID. 풀 스캔 O(n)이 인덱스의 존재 이유.
- **버퍼 풀** — 단순 LRU가 아니라 **pin/dirty**가 붙어야 "원본을 든 캐시"가 안 깨진다. 멀티스레드에선 **latch(메타데이터) + pin(데이터)의 분업**이 핵심이고, 이는 TSan으로 계측 가능하다.

다음 편은 이 힙 위에 **B+Tree 인덱스**를 얹어, 풀 스캔 O(n)을 O(log n)으로 바꿉니다 — 그리고 "인덱스는 왜 단순 key→value가 아닌가"라는, 만들어 보면 반드시 부딪히는 질문까지.

## 참고 (1차 자료 우선)

- [PostgreSQL Documentation: Database Page Layout](https://www.postgresql.org/docs/current/storage-page-layout.html)
- [PostgreSQL Documentation: Physical Storage](https://www.postgresql.org/docs/current/storage.html)
- [PostgreSQL Documentation: TOAST](https://www.postgresql.org/docs/current/storage-toast.html)
- [PostgreSQL Documentation: System Columns (ctid)](https://www.postgresql.org/docs/current/ddl-system-columns.html)
- [PostgreSQL Documentation: Resource Consumption (shared_buffers)](https://www.postgresql.org/docs/current/runtime-config-resource.html)
- [MySQL 8.0 Reference: InnoDB Row Formats](https://dev.mysql.com/doc/refman/8.0/en/innodb-row-format.html)
- [MySQL 8.0 Reference: Buffer Pool (midpoint insertion LRU)](https://dev.mysql.com/doc/refman/8.0/en/innodb-buffer-pool.html)
- Jim Gray & Gianfranco Putzolu, *The 5 Minute Rule for Trading Memory for Disc Accesses* (1987)
- 본 블로그: [DB 스토리지 내부 ①](/blog/theory/db-storage-01-heap-page-index) · [DB 인덱스 ⑤: 클러스터형 인덱스와 DBMS별 차이](/blog/theory/db-index-05-clustered-dbms) · [캐시와 버퍼](/blog/theory/cache-and-buffer)
- [db-hobby 코드 (GitHub)](https://github.com/dj258255/db-hobby) — `pager.c` · `page.c` · `heap.c` · `bufpool.c`

<!-- EN -->

## 0. Introduction — Only What I Verified by Building

This series is a record of dissecting the internals of relational databases like PostgreSQL and MySQL InnoDB by **building a mini DB ([db-hobby](https://github.com/dj258255/db-hobby)) from scratch in C.** It grew from a single page up to MVCC snapshot isolation, a wire-protocol server a real `psql` connects to, parallel execution, and an HA configuration replicated by Raft consensus — with every layer covered by **686 checks across 42 suites**, and the concurrency measured under ThreadSanitizer.

It isn't a literature summary: **the walls I hit while building are the table of contents.** "Why was it designed this way" is something you learn in your bones by building it. Each part treats one topic to completion and contrasts how real DBs (PostgreSQL, InnoDB) solve the same problem, grounded in primary sources.

Part 1 is the bottom — the five layers of the **storage skeleton**: pages, the slotted page, the row format, the heap, and the buffer pool. Understand how these five interlock and you can see why everything above them (indexes, WAL, MVCC) has the shape it does.

## 1. The Map — Almost Everything Sits on Fixed-Size Pages

A DB is not one lump but a sum of layers, top to bottom:

![DB layer map — SQL text descends through parser, planner, executor to catalog, access (heap/B-Tree), buffer pool, page, pager, with WAL underpinning durability](/uploads/project/db-hobby/layer-map.svg)

> **Key fact**: in a page-based relational DB, almost everything stacks on **fixed-size pages** — PostgreSQL, InnoDB, SQLite, and db-hobby alike. (LSM-family systems like RocksDB and Cassandra are not page-centric — contrasted in [Part 7 (Three Philosophies of Storage Engines)](/blog/project/db-hobby/db-internals-07-storage-engines).)

The size of that "one page" differs per DB:

| DB | Page size |
|---|---|
| **db-hobby** | 4KB |
| PostgreSQL | 8KB |
| MySQL InnoDB | default 16KB (`innodb_page_size` configurable 4K–64K) |
| SQLite | default 4KB (since 3.12.0/2016; previously 1KB; configurable 512B–64KB) |

## 2. The Pager — Why Pages, Not Rows

The pager at the very bottom has exactly one responsibility — "read and write one fixed-size page on disk by `page_id`."

> **Why pages, not rows**: the disk (and the OS and SSD controller) does I/O in **blocks**, not bytes. Read one byte and the whole block containing it comes up. So the DB should take the block (page) as its unit of work from the start.

Making pages **fixed-size** brings a gift — page N's position in the file is one multiplication away:

```c
int pager_read(Pager *p, page_id_t id, void *buf) {
    off_t offset = (off_t)id * PAGE_SIZE;   // page N = N * 4096
    ssize_t n = pread(p->fd, buf, PAGE_SIZE, offset);
    return (n == (ssize_t)PAGE_SIZE) ? 0 : -1;
}
```

Using `pread`/`pwrite` instead of `read`/`write` is deliberate. A plain `read` carries the file's "current position," requiring an `lseek` first; `pread(fd, buf, len, offset)` takes the offset as an argument. And because it doesn't touch the shared file offset, it's **thread-safe** — no race where one thread's `lseek` scrambles another thread's read position. That property pays off for real in §6 (parallel I/O in the buffer pool).

### Why 4/8/16KB?

There's no single right answer. A frequently-cited starting point is the **Five-Minute Rule** (Jim Gray & Gianfranco Putzolu, 1987) — an economic calculation of "how long must a page fetched from disk stay in memory to break even," priced in disk and RAM costs. But real DBs' choices weren't decided by this alone: 1980s Berkeley POSTGRES picked 8KB under the influence of contemporary Unix virtual-memory page sizes and I/O efficiency, and the PostgreSQL docs never say "8KB because of the five-minute rule."

> **Practical/interview point**: larger pages have less metadata overhead but can lose IOPS on some SSDs (one Intel SSD benchmark dropped from 75,000 IOPS at 4KB to 47,500 at 8KB, ~37% — this varies by SSD, queue depth, and controller, so it's not a general law), and half as many pages fit in the same cache memory. The accurate statement is **"page size = a trade-off of metadata overhead vs IOPS and cache efficiency."** db-hobby went with 4KB for learning — "how many rows fit in one page" stays visible — and the code above doesn't change for any size, as long as it's fixed.

> Deeper: [DB Storage Internals ①: Heap, Page, Index, B-Tree](/blog/theory/db-storage-01-heap-page-index)

## 3. The Slotted Page — Variable-Length Rows and Stable Addresses

A page is still just a 4096-byte blob. To pack multiple **variable-length** rows into it there's a problem: `'kim'` is 3 bytes, `'alexander'` is 9. How do you know where each row starts and ends, and how do you tidy up when a middle row is deleted? The answer is the **slotted page** — exactly the structure of PostgreSQL heap pages, and the road db-hobby took as well. (InnoDB pages look similar but differ in character — see the box below.)

The layout grows from both ends toward the middle. At the **front**, after the header, a **slot array** (each slot = "this row is at offset X, length Y") grows downward; from the **end**, actual record bytes grow upward. When they meet, the page is full.

![Slotted page layout — slot array grows down, records grow up, free space in the middle](/uploads/project/db-hobby/slotted-page-layout.svg)

Compared to the simpler road (fixed-length records: row N = `header + N × rowsize`):

| | Slotted page (PG · InnoDB · db-hobby) | Fixed-length records |
|---|---|---|
| Variable-length TEXT | naturally packed | must size to the longest — wasteful |
| Row position | slot array points to it | one multiplication |
| Delete/compact | slot number stays, only offset changes | hard to reuse space |
| Adoption | almost every relational DB | legacy, some embedded |

> **The slotted page's two dividends**: one is packing variable-length rows. The other — perhaps more important — is that **the slot number becomes a stable address for the row.** Even when deletions trigger compaction and records physically move within the page, the slot number stays (only the offset inside the slot changes). So the outside world (an index) can point at "page 5, slot 2" without the address breaking. PostgreSQL calls this the **TID (ctid)** — and this "slot = stable external address" property is a PostgreSQL/db-hobby story.

> **Practical/interview point**: InnoDB pages also have something called a Page Directory, but its character differs — it's a **sparse** directory with one slot per 4–8 records, not one per row: the slot narrows you to the neighborhood, then you follow the record chain. In other words, InnoDB has no real TID-grade stable external address. Because it stores rows physically sorted by PK (clustered), its secondary indexes identify rows by **PK value**, not physical pointers. "Identify rows by physical location (PG) or by PK (InnoDB)" is where storage engines diverge — measured head-to-head in [Part 7](/blog/project/db-hobby/db-internals-07-storage-engines).

One more dial: PostgreSQL lets you deliberately leave free space in a page — `FILLFACTOR`. The default 100 packs pages full; lowering it to 90 reserves 10% for UPDATEs. If the new version of a row fits in the same page, a **HOT (Heap-Only Tuple)** update becomes possible — one that finishes without touching the indexes. Why an UPDATE means "creating a new version" is covered in [Part 4 (MVCC)](/blog/project/db-hobby/db-internals-04-mvcc).

## 4. The Row Format — Values as Bytes, and NULL as Bits

What does the "row" inside a slot look like? A db-hobby row is `[MVCC header 8B][null bitmap][values...]` — `INT` as 4 bytes, `TEXT` as "length + bytes," encoded sequentially. (The MVCC header stars in [Part 4 (Isolation)](/blog/project/db-hobby/db-internals-04-mvcc); for now just note its place.)

The first wall you hit implementing this is **NULL**.

### NULL Can't Be Expressed by Any Value Inside the Data

The first idea is a sentinel — "let integer `-1` mean NULL." It fails immediately: `-1` is a perfectly good integer, indistinguishable the moment someone stores a real `-1`. An empty string `''` is likewise not NULL but a distinct value, "a string of length 0."

> **Key fact**: NULL is not a data value but a **marker for "no value."** Since it can't be expressed by the INT/TEXT data *itself*, it must be recorded **outside** the data.

So the method representative row-store DBs use is the **null bitmap**: one bit per column at the front of the row; bit i set means "column i is NULL." A NULL column sets its bit and **writes no value bytes at all** (saving space too).

| | db-hobby | PostgreSQL | InnoDB |
|---|---|---|---|
| Location | after MVCC header, before values | tuple header's `t_bits` | row header (variable part) |
| Size | 1 bit per column | 1 bit per column | 1 bit per nullable column |
| Value bytes for NULL | none | none | none |
| Bitmap omission | never (always present) | omitted for **rows with no NULLs** — a per-row decision, not per-schema | NOT NULL columns excluded |

PostgreSQL decides per row — the `HEAP_HASNULL` flag in the header is the switch, in the official docs' words: *"There is a null bitmap only if the HEAP_HASNULL bit is set in t_infomask."* So even within one table, rows without NULLs are stored bitmap-free while rows with NULLs carry one.

```c
/* encode: row = MVCC header (8B) + null bitmap + values */
int nbits = (schema->num_columns + 7) / 8;      // 1 byte per 8 columns
for (int i = 0; i < schema->num_columns; i++) {
    if (vals[i].type == VAL_NULL) {
        buf[MVCC_HDR + i / 8] |= (uint8_t)(1 << (i % 8)); // set the bit,
        continue;                                          // write no value bytes
    }
    /* else: INT 4 bytes / TEXT length+bytes */
}
```

> **Why the bitmap sits before the values**: you must know "is this column NULL" **before** reading the value, to decide whether to read 4 bytes or skip 0. Put the bitmap after the values and it's chicken-and-egg — you need to read all values to reach the bitmap, but you need the bitmap to know where values end. (Formats with offset arrays relax this; the real requirement is just "know NULL-ness before interpreting the value.")

One more note: the **storage** of NULL (byte representation) and the **semantics** of NULL (three-valued logic, `COUNT(col)` skipping NULLs, NULLS LAST in sorting) are separate concerns. In db-hobby the semantics were built into the executor first; when storage (the bitmap) was later unblocked, `WHERE x IS NULL`, aggregates, and sorting all worked untouched — a hands-on payoff of cutting layers cleanly.

### When a Row Outgrows the Page — TOAST and Overflow

Everything so far assumed "a row fits in one page." db-hobby nails that assumption down as a hard constraint — **row ≤ page**, oversized inserts are rejected. So how does a 1MB TEXT fit into an 8KB page in a real DB? PostgreSQL starts from the same premise — *"PostgreSQL uses a fixed page size (commonly 8 kB), and does not allow tuples to span multiple pages."* — but provides a detour. **TOAST**: when a row exceeds a threshold (~2KB by default), large column values are first compressed, and if still too big, sliced out into a separate TOAST table with only a pointer left in the main row. InnoDB uses **off-page storage** — in the DYNAMIC row format, long variable-length columns move to overflow pages, leaving a 20-byte pointer in the row. SQLite chains overflow pages.

| | PostgreSQL | InnoDB | SQLite | db-hobby |
|---|---|---|---|---|
| Row > page handling | **TOAST** (~2KB threshold: compress → external table + pointer) | **off-page** (DYNAMIC: overflow pages + 20B pointer) | overflow page chain | **unsupported — row ≤ page constraint** |

## 5. The Heap File — Finally a Table, and the RID

Bundle the pager, slotted page, and row format and you finally get a **table**. A heap file is a collection of **unordered** pages — "heap" as in "a pile," not the data structure. Insert a row into any page with room, or append a new page. No ordering, no placement rule (PostgreSQL finds pages with free space via the FSM, its Free Space Map).

A row's address is the **RID = (page_id, slot)** — "which slot of which page." Because slot numbers are stable, the RID survives records moving within a page. PostgreSQL's TID (ctid) plays exactly this role, and the B+Tree index built in [Part 2](/blog/project/db-hobby/db-internals-02-btree-index) points at it as "key → RID."

> **Common misconception, corrected**: *"ctid is a stable row address, so an application can use it as a row identifier?"* — No. The stability holds **only across in-page compaction.** The PostgreSQL docs are blunt about ctid: *"ctid will change if it is updated or moved by VACUUM FULL... useless as a long-term row identifier"* — an UPDATE creates a new version of the row elsewhere (because of MVCC), and VACUUM FULL moves rows across pages wholesale. The "short-lived physical address" an index leans on and the "persistent identifier" an application wants are different things.

> **Real-world anti-pattern**: using ctid as an application-level row identifier (URL parameter, foreign-reference substitute). One UPDATE or one VACUUM FULL silently severs it. Persistent identifiers belong to the PK.

![Heap file — rows packed into slots across pages; a full scan sweeps every page](/uploads/project/db-hobby/heap-file.svg)

The basic form of `SELECT * FROM t` is the **sequential scan** — a double loop over every slot of every page, O(rows). Avoiding that O(n) is exactly why indexes exist. The other storage road (data itself sorted by PK — InnoDB's clustered organization) is contrasted with measurements in [Part 7](/blog/project/db-hobby/db-internals-07-storage-engines); the gist:

| | Heap (PostgreSQL · db-hobby) | Clustered (InnoDB) |
|---|---|---|
| Storage order | unordered | sorted by PK |
| INSERT | toss into free space (simple, fast) | insert at sorted position → splits |
| PK lookup | index → RID → heap (2 steps) | PK index leaf *is* the data |
| Secondary index points at | RID (physical) | PK value |

## 6. The Buffer Pool — Why a Cache Holding the Source of Truth Doesn't Corrupt

Hitting disk for every page read is slow; memory is tens of thousands of times faster than random HDD I/O and still hundreds of times faster than NVMe, so hot pages must stay in memory. That's the **buffer pool** — cache pages in a fixed number of "frames": hit → serve; miss → load from disk; no room → pick a victim and evict. db-hobby picks victims with the simplest pure LRU (the same seat is held by the InnoDB buffer pool and PostgreSQL shared buffers, whose replacement policies deliberately diverge — see below).

But a DB buffer pool differs from a plain LRU cache: **what's in the cache is the original, and modifications happen there.** Hence the safeguards:

| Mechanism | Role |
|---|---|
| **pin count** | a page in use (pin>0) is never evicted |
| **dirty flag** | pages modified in memory are written back on evict/flush; clean ones just dropped |
| **LRU** | victim = least-recently-used among unpinned frames |

![Buffer pool — frames (page/pin/dirty/LRU); a miss loads from disk; dirty pages flush on eviction](/uploads/project/db-hobby/buffer-pool.svg)

> **Common misconception, corrected**: *"a buffer pool is just an LRU cache?"* — True for db-hobby, but real DBs **deliberately avoid pure LRU.** The problem: one large sequential scan flushes the entire cache with pages that will never be read again. PostgreSQL shared buffers use not LRU but **clock-sweep** — each frame carries a `usage_count` that a clock hand decrements as it sweeps, so pages touched repeatedly survive — and large sequential scans get a small dedicated **ring buffer** so they can't pollute the main cache. The InnoDB buffer pool uses an LRU variant, **midpoint insertion** — the list splits into new/old sublists and new pages enter at the midpoint (head of the old sublist), so read-once pages never reach the hot region (`innodb_old_blocks_pct`, `innodb_old_blocks_time`). In the MySQL manual's own words: *"a variation of the least recently used (LRU) algorithm... midpoint insertion strategy."*

| | db-hobby | PostgreSQL | InnoDB |
|---|---|---|---|
| Replacement policy | pure LRU | clock-sweep (`usage_count`) | midpoint insertion LRU (new/old sublists) |
| Sequential-scan defense | none | dedicated ring buffer | old sublist + `innodb_old_blocks_time` |

(When transactions arrive, a **no-steal/steal** policy is layered on top — along with the **torn page** problem (power dying with a page half-written) and page checksums (PostgreSQL `data_checksums`) — the subject of [Part 3 (WAL and Recovery)](/blog/project/db-hobby/db-internals-03-wal-recovery).)

### The First Thing That Breaks Under Threads

All of the above assumed one thread. Turn on real threads and **the buffer pool breaks first** — every operation, SELECT or INSERT or index descent, must pass through it to read a page. It's the floor every layer stands on.

```c
void *bufpool_fetch(BufferPool *bp, page_id_t page_id) {
    Frame *f = find_frame(bp, page_id);
    if (f) {
        bp->hits++;              /* ← two concurrent increments lose one */
        f->pin_count++;          /* ← pin count skews: eviction protection breaks */
        ...
    }
    f = pick_frame(bp);          /* ← two threads pick the same victim, load different pages */
}
```

If `pin_count++` isn't atomic, two threads each take a pin but the count rises by one. The moment one unpins, the count hits zero and the frame is **evicted from under the other thread still using it** — cross-contamination of data. This is measurable, not conjecture: compile with ThreadSanitizer and the un-latched pool spews `data race on Frame::pin_count` warnings.

### The Fix — a Division of Labor Between Latch and Pin

The fix: put a **latch** (mutex) on the pool and wrap every operation touching the frame table in a critical section. And here comes the key insight of this section — **the caller uses the returned page data with no latch held.** What if another thread evicts that frame in the meantime?

**It can't — the pin prevents it.** `fetch` returns with a pin taken, and victim selection never picks a frame with `pin_count != 0`. A division of labor:

- The **latch** protects frame *metadata* (pin counts, dirty flags, LRU clock, page↔frame mapping).
- The **pin** protects the returned *page data* — a pinned frame is not an eviction candidate, so it stays put while you read it outside the latch.

This is the **pin protocol.** Thanks to it, heavy operations don't hold the pool latch long — they take a pin and release the latch immediately. PostgreSQL's buffer pin + content lock and InnoDB's buf_page pin are exactly this two-layer structure.

One more fork in the road: on a cache miss, do you do the **disk I/O inside or outside the latch?** Inside is simple and correct but serializes concurrent reads. Real DBs move I/O outside the latch with a "read-in-progress" state. db-hobby also started inside — until measuring parallel scans exposed it as the cold-cache ceiling, and it moved out. That measure→fix→re-measure story is told in [Part 8 (Parallel Execution)](/blog/project/db-hobby/db-internals-08-parallel).

### Proof — Measuring "No Races" with ThreadSanitizer

For concurrent code, "the test passed" is weak evidence — races don't fire on most runs. So we **measure the races themselves.** A stress test with far more pages (300) than frames (16) keeps eviction churning while 8 threads hammer the pool, built with TSan:

```
$ make test-tsan
  ok   concurrent reads 40000×8: always that page's data (zero cross-contamination)
  ok   all pages fetchable after the read storm (no pin leaks)
  ok   after concurrent writes, every on-disk page stamp intact (evict/flush integrity)
all passed       ← zero ThreadSanitizer warnings
```

TSan staying silent doesn't mean "it didn't blow up this time" — it means **no data race existed in the observed execution.** Much stronger evidence.

> **Real-world anti-pattern**: setting PostgreSQL `shared_buffers` to most of RAM on the theory that "a bigger cache is always better." PostgreSQL runs **on top of** the OS page cache, so the same pages get cached twice and checkpoint flush pressure grows — which is why the official docs suggest starting around 25% of RAM. In the same spirit, leaving `FILLFACTOR` at the default 100 on UPDATE-heavy tables closes the door on HOT updates (§3) all by yourself.

> Deeper: [Cache and Buffer](/blog/theory/cache-and-buffer) · [JVM Memory ④: OS Page Cache](/blog/theory/es-memory-04-page-cache) — the double-caching structure where the OS caches another layer besides the DB buffer pool.

## 7. Wrap-up

The storage skeleton is five layers, each providing one property the layer above leans on:

- **Fixed-size pages** — disks do block I/O, so pages are the unit of work. Size (4/8/16KB) trades metadata overhead against IOPS and cache efficiency.
- **Slotted page** — packs variable-length rows, and **the slot number becomes a stable address** (TID/RID). Indexes lean on this.
- **Row format** — NULL can't be a value, so it's a **bitmap**, placed before the values. PG `t_bits` and InnoDB share the idea.
- **Heap file** — unordered pages + RID. The O(n) full scan is the reason indexes exist.
- **Buffer pool** — not plain LRU: **pin/dirty** make "a cache holding the original" safe. Under threads, the key is the **latch (metadata) + pin (data) division of labor**, measurable with TSan.

Next, a **B+Tree index** goes on top of this heap, turning the O(n) full scan into O(log n) — including the question you inevitably hit when you build one: "why isn't an index a simple key→value map?"

## References (primary sources first)

- [PostgreSQL Documentation: Database Page Layout](https://www.postgresql.org/docs/current/storage-page-layout.html)
- [PostgreSQL Documentation: Physical Storage](https://www.postgresql.org/docs/current/storage.html)
- [PostgreSQL Documentation: TOAST](https://www.postgresql.org/docs/current/storage-toast.html)
- [PostgreSQL Documentation: System Columns (ctid)](https://www.postgresql.org/docs/current/ddl-system-columns.html)
- [PostgreSQL Documentation: Resource Consumption (shared_buffers)](https://www.postgresql.org/docs/current/runtime-config-resource.html)
- [MySQL 8.0 Reference: InnoDB Row Formats](https://dev.mysql.com/doc/refman/8.0/en/innodb-row-format.html)
- [MySQL 8.0 Reference: Buffer Pool (midpoint insertion LRU)](https://dev.mysql.com/doc/refman/8.0/en/innodb-buffer-pool.html)
- Jim Gray & Gianfranco Putzolu, *The 5 Minute Rule for Trading Memory for Disc Accesses* (1987)
- This blog: [DB Storage Internals ①](/blog/theory/db-storage-01-heap-page-index) · [DB Index ⑤: Clustered Indexes Across DBMSs](/blog/theory/db-index-05-clustered-dbms) · [Cache and Buffer](/blog/theory/cache-and-buffer)
- [db-hobby source (GitHub)](https://github.com/dj258255/db-hobby) — `pager.c` · `page.c` · `heap.c` · `bufpool.c`

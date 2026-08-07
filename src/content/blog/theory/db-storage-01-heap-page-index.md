---
title: 'DB 스토리지 내부 ①: Heap, Page, Index, B-Tree'
description: DB는 행 단위로 일하지 않고 페이지 단위로 일합니다. PostgreSQL 8KB / InnoDB 16KB 페이지 안에 행이 어떻게 살고, 인덱스가 어떻게 페이지 집합을 줄이고, 왜 InnoDB의 UUID PK가 위험한지를 1차 자료 기준으로 정리합니다.
date: 2026-04-19T00:00:00.000Z
tags:
  - Database
  - Storage
  - Page
  - Heap
  - Index
  - B-Tree
  - PostgreSQL
  - InnoDB
category: theory/Database
draft: false
coverImage: "/uploads/theory/db-storage/cover-1.svg"
series: "DB 스토리지 내부"
seriesOrder: 1
---

## 0. 들어가며

[ACID 시리즈](/blog/theory/transaction-acid-01-atomicity)가 트랜잭션의 의미론을 다뤘다면, 이 시리즈는 **데이터가 디스크에 어떻게 살고 있는가** 를 다룹니다. 트랜잭션이 다루는 모든 행, 모든 인덱스, 모든 WAL 레코드는 결국 **페이지(Page)** 라는 단위로 저장되고 읽힙니다.

이 글의 핵심 메시지: **"DB는 행 단위로 일하지 않는다. 페이지 단위로 일한다."** SELECT 한 줄, UPDATE 한 줄을 실행해도 DB는 페이지 단위로 데이터를 관리하고 접근합니다. 인덱스도 페이지에 저장되고, 힙도 페이지에 저장됩니다. 다만 실제 물리 IO는 OS와 스토리지 계층에 의해 더 큰 단위로 묶이거나 더 작은 블록으로 쪼개질 수 있습니다. 이 추상화의 층층 구조를 이해하는 것이 *왜 어떤 쿼리는 빠르고 왜 어떤 쿼리는 느린지* 를 결정합니다.

## 1. 왜 스토리지 내부를 알아야 하는가

*"왜 이 쿼리가 느린가요?"* 라는 질문에 *"인덱스를 안 걸어서요"* 라고만 답하면 그 다음 질문이 들어옵니다. *"그래서 인덱스가 왜 빠르게 만드나요?"* 여기서 막히면 깊이가 드러납니다.

진짜 답은 이렇습니다. 풀 스캔은 논리적으로 **N개 페이지** 를 접근해야 하고(실제로는 OS readahead로 sequential read에 묶여 효율적이지만 양 자체는 N), 인덱스 스캔은 **트리 깊이만큼(보통 3~4번)** 의 페이지 접근이면 답이 나옵니다. 이 답을 하려면 페이지가 뭔지, IO가 뭔지, 인덱스가 어떤 데이터 구조인지 알아야 합니다.

이번 글은 그 가장 기초를 다룹니다.

## 2. 행(Row), 행 ID(Tuple ID)

### 행은 우리가 보는 것

```sql
SELECT id, name, salary FROM employees WHERE id = 40;
```

이걸 짤 때 우리는 **논리적인 행** 을 떠올립니다. `id=40`인 행 하나, 그 안에 `name`과 `salary`가 있습니다. 깔끔합니다.

### Row ID: DB가 내부적으로 쓰는 식별자

그런데 DB는 우리가 정의한 PK(`id`)를 직접 쓰는 게 아니라, **내부적으로 행의 물리적 위치를 가리키는 별도 식별자** 를 씁니다. 이 식별자가 **페이지 번호 + 페이지 안의 슬롯** 을 합친 것입니다.

| DB | 내부 행 식별자 이름 | 구조 |
|---|---|---|
| PostgreSQL | **CTID** (Tuple ID) | (페이지 번호, 페이지 내 line pointer index), 예: `(0, 1)` |
| MySQL InnoDB | (clustered index 사용 시) PK 자체가 식별자 역할 | PK가 없으면 InnoDB가 6바이트 hidden GEN_CLUST_INDEX 행 ID를 자동 생성 |
| Oracle | **ROWID** | 파일 + 블록 + 행 슬롯 |

PostgreSQL은 모든 인덱스 종류(B-tree, Hash, GIN, GiST, BRIN 등)가 결국 **CTID를 가리킵니다.** 즉 모든 인덱스가 secondary index입니다 (clustered index 자체가 없음). MySQL InnoDB는 PK가 곧 clustered index이고, secondary index는 **PK 값을 저장** 합니다(CTID 같은 물리 주소가 아님). InnoDB에 PK가 없으면 첫 NOT NULL UNIQUE 인덱스를 clustered index로 사용하고, 그것도 없으면 6바이트 hidden 행 ID(GEN_CLUST_INDEX)를 자동 생성합니다. 즉 **InnoDB 테이블은 항상 clustered index를 갖습니다.** 이 차이가 두 DB의 인덱스 동작을 결정적으로 다르게 만드는데, 자세한 건 아래 7장에서 다룹니다.

> **2장 요약**: 우리가 보는 PK와 DB가 내부에서 쓰는 행 식별자는 다를 수 있습니다. PostgreSQL은 CTID로 항상 분리하고, InnoDB는 PK 자체를 식별자로 사용합니다.

## 3. Page: DB가 데이터를 다루는 단위

### 페이지란

> **Page**: DB가 디스크에서 읽고 쓰는 고정 크기 단위. PostgreSQL 기본 8KB, MySQL InnoDB 기본 16KB.

여기서 **"고정 크기"** 가 핵심입니다. DB는 행 하나만 읽는 게 아니라 **페이지 단위** 로 데이터를 가져옵니다. SELECT 한 행을 위해 한 페이지(8KB 또는 16KB)가 buffer pool로 올라오고, 그 페이지에 다른 행 100개가 있어도 같이 따라옵니다. 다만 **디스크에서 읽는 것** 과 **buffer pool에서 가져오는 것** 은 다릅니다. 이미 메모리에 있는 페이지면 디스크 IO 없이 처리됩니다. *"페이지 단위"* 자체는 항상 그렇지만, *"디스크 IO가 발생하는가"* 는 buffer pool hit 여부에 달려있습니다.

### 왜 행이 아니라 페이지인가

이건 **디스크의 본질** 에서 옵니다. RAM은 바이트 단위 주소 지정(random access)이 가능해서 *"주소 0x1234의 1바이트만 읽어줘"* 가 자연스럽습니다. 하지만 디스크는 그렇게 동작하지 않습니다. HDD는 회전·헤드 이동 비용이 있고, SSD도 페이지(보통 4KB) 단위로 읽고 씁니다. 한 바이트만 읽고 싶어도 최소 한 블록은 읽어야 합니다.

DB는 이 현실 위에서 일하므로, **페이지 단위라는 더 큰 추상화** 를 둡니다. 한 번 IO를 하면 한 페이지(여러 행 묶음)가 한꺼번에 올라옵니다.

### 페이지의 물리적 위치 = 파일 안의 블록 번호

PostgreSQL을 기준으로 보면, 테이블마다 디스크에 데이터 파일이 있고, 그 파일은 **8KB 단위 페이지의 배열**로 구성됩니다. 페이지 0 뒤에 페이지 1, 페이지 2 순서로 이어지는 단순한 구조입니다. 그래서 임의의 페이지를 디스크에서 꺼낼 때 필요한 정보가 정확히 세 가지로 떨어집니다. 바로 *파일 이름 / offset / length* 입니다.

![파일 = 고정 크기 페이지의 배열, offset = page_no × page_size](/uploads/theory/db-storage/file-as-page-array.svg)

```
파일이름: base/<db_oid>/<relfilenode>   (PostgreSQL의 데이터 파일 경로)
offset  = page_no × page_size           (page 2면 2 × 8192 = 16384)
length  = page_size                     (8KB = 8192바이트)
```

이 매핑이 *논리적 페이지 번호 ↔ 디스크 위치*를 산수 한 번으로 풀어줍니다. 인덱스가 가리키는 CTID `(page_no, slot)`도 결국 이 산수로 디스크 위치로 환원됩니다. 새 INSERT는 마지막 페이지의 free space에 추가하고, 꽉 차면 파일 끝에 `page_no = N+1`을 새로 만들어 append합니다.

InnoDB도 같은 *파일=페이지 배열* 구조지만 페이지 크기가 16KB이고, heap이 아니라 **PK 순서로 정렬된 B+Tree 노드(=페이지)** 들이 형제 포인터로 연결되어 있습니다(7장 clustered index 참고).

### 페이지 안의 구조 (PostgreSQL 8KB 기준)

![PostgreSQL 페이지 레이아웃: Slotted Page](/uploads/theory/db-storage/page-layout.svg)

PostgreSQL 페이지는 공식 문서 기준 네 구획으로 나뉩니다.

| 구획 | 크기 | 역할 |
|---|---|---|
| **PageHeader** | 24바이트 (고정) | LSN, checksum, free space 시작/끝 오프셋 등 페이지 메타데이터 |
| **ItemId 배열 (Line Pointers)** | 4바이트 × N | 각 항목의 *(offset, length, flags)*. CTID의 슬롯 번호가 여기 인덱스 |
| **Items (Tuples)** | 가변 | 실제 행 데이터. 페이지 아래쪽에서 위로 거꾸로 자람 |
| **Special Space** | 가변 | 인덱스 페이지의 형제 페이지 링크 등. heap 페이지에서는 0바이트 |

핵심 포인트:

- **Line Pointer 배열은 위쪽**, **Tuple 데이터는 아래쪽** 에서 거꾸로 자랍니다. 둘 사이의 공간이 free space, 즉 새 행이 들어올 자리입니다.
- ItemId 한 개가 4바이트라는 게 작아 보이지만, 페이지당 항목이 1,000개라면 4KB(전체 페이지의 절반!)가 포인터로 채워집니다. *행이 너무 작으면 ItemId 오버헤드가 커진다*는 의미입니다.
- ItemId 간접 참조 덕분에 PostgreSQL은 페이지 안에서 행을 옮길 수 있습니다(VACUUM, defragmentation, [HOT update](/blog/theory/db-storage-03-hot-update-visibility-map) 등). 인덱스가 ItemId를 가리키므로 행이 페이지 안에서 이동해도 인덱스는 깨지지 않습니다.

### Buffer Pool: 페이지가 디스크에서 메모리로 올라오는 곳

지금까지 *"DB는 페이지 단위로 디스크 IO를 한다"* 만 말했습니다. 그런데 디스크에서 읽힌 페이지는 어디로 갈까요? **Buffer Pool(Shared Buffers)** 이라는 메모리 영역입니다. PostgreSQL은 `shared_buffers` 설정으로 크기를 정하고, InnoDB는 `innodb_buffer_pool_size`로 정합니다.

흐름은 이렇습니다.

1. 쿼리가 page 2를 읽으려 함 → buffer pool에 이미 있나? **HIT** 면 디스크 IO 없이 끝납니다.
2. 없으면 **MISS** → OS에 `pread(file, offset, length)` 요청 → buffer pool의 빈 슬롯(또는 evicted된 슬롯)에 페이지 적재.
3. 그 페이지에 접근하는 모든 후속 쿼리는 메모리에서 처리됩니다.
4. UPDATE도 같은 흐름입니다. 페이지를 buffer pool로 끌어와 *메모리에서 변경* 한 뒤, 변경 사실은 [WAL](/blog/theory/transaction-acid-04-durability)로 먼저 기록합니다. 더러워진 페이지(dirty page)는 나중에 background writer / checkpoint가 모아서 한 번에 flush합니다.

이 메커니즘 덕분에 *"인덱스로 페이지 3개만 짚어도 빠르다"* 가 성립합니다. 그 3개가 buffer pool에 있을 확률이 높으면 디스크 IO 없이 끝나기 때문입니다. 그래서 buffer pool이 **워킹셋(working set)을 담을 만큼 크냐**가 OLTP 성능의 1차 관문이고, 이건 [캐시와 버퍼](/blog/theory/cache-and-buffer) 글의 캐시 일반론이 DB 컨텍스트에서 구체화된 형태입니다. 읽기 캐시이자 쓰기 버퍼라는 *이중 역할*도 같은 글 기준으로 자연스럽게 풀립니다.

> **3장 요약**: 파일은 *페이지의 배열* 이고, 페이지 번호 ↔ 디스크 offset은 산수 한 번입니다. 페이지 안은 *PageHeader / ItemId / Items / Special* 네 구획이고, 디스크에서 읽힌 페이지는 buffer pool에 머물며 후속 IO를 흡수합니다. 다만 물리적 IO는 OS readahead로 더 크게 묶이거나(PostgreSQL 18의 `io_combine_limit` 기본 128KB = 16 페이지), SSD/파일시스템 4KB 블록으로 쪼개질 수도 있습니다.

## 4. IO: 줄여야 하는 비용

### IO = 디스크 읽기/쓰기 요청

> **IO**: 디스크로의 단일 read 또는 write 요청. DB 입장에서는 페이지 단위로 요청하지만, 실제 물리 IO 크기는 더 클 수도 더 작을 수도 있습니다.

여기서 정확히 짚을 점이 있습니다. DB의 페이지는 **논리적 단위** 고, 물리 IO 단위는 여러 층의 추상화에 의해 결정됩니다.

- **DB 페이지**: PostgreSQL 8KB, InnoDB 16KB (논리적 단위, buffer pool의 단위)
- **OS 페이지/파일시스템 블록**: 일반적으로 4KB (Linux ext4/XFS 기본)
- **SSD 섹터**: 일반적으로 4KB (HDD는 512B 또는 4KB)
- **실제 IO 요청 크기**: OS readahead, sequential prefetch, PostgreSQL 18의 `io_combine_limit`(기본 128KB = 16 데이터 페이지) 등으로 훨씬 큰 단위로 묶일 수 있음

즉 *"DB 페이지 = IO 단위"* 는 DB 추상화의 관점에서만 그렇습니다. **실제 물리 IO 횟수와 크기는 OS·파일시스템·스토리지 계층에 의해 달라져요.**

### IO가 비싼 이유

이런 추상화 층층 구조가 있어도 진짜 비싼 것은 결국 디스크 자체입니다. 자릿수 비교를 보면 CPU 한 사이클 ~0.3ns, RAM 접근 ~100ns, NVMe SSD random read ~10~100μs (장치별 편차 큼), HDD random read ~5~15ms로, RAM 대비 100배~10만 배 이상 느립니다. [D편](/blog/theory/transaction-acid-04-durability)에서 본 것과 같은 자릿수 차이입니다.

따라서 **대부분의 OLTP 워크로드에서 IO가 주요 병목** 입니다. 짧은 트랜잭션 + 작은 결과셋 + 디스크 접근 패턴이 성능을 결정짓는 환경입니다. 다만 모든 워크로드가 그런 건 아닙니다. 복잡한 집계는 CPU bound일 수 있고, 동시성 높은 시스템은 lock contention이, 분산 시스템은 network latency가 병목이 됩니다. IO 최적화는 기본 전제고, 그 위에 다른 차원이 쌓입니다.

### IO를 줄이는 방법

1. **인덱스로 정확한 페이지만 가져오기**: 풀 스캔 대신 1~3 페이지만 IO.
2. **OS 페이지 캐시에 의존**: 자주 읽는 페이지는 메모리에 남아있어 디스크 IO 없이 처리.
3. **순차 IO 활용**: HDD/SSD 모두 random보다 sequential이 훨씬 빠릅니다. 왜 그럴까요. HDD는 헤드 이동·회전 지연이 없어지고, SSD는 내부 채널 병렬성과 prefetch 캐시 효율을 살릴 수 있습니다. random IO는 이 모든 메커니즘을 깨뜨리기 때문에 비쌉니다. 풀 스캔은 sequential 패턴이라 의외로 효율적인 경우가 많습니다.
4. **페이지 안의 데이터 밀도 높이기**: 행이 작을수록 한 페이지에 더 많이 들어가고 IO가 줄어듭니다.

> *"SELECT *는 비싸다"* 는 흔한 격언의 진짜 메커니즘은 좀 더 미묘합니다. DB가 페이지 단위로 데이터를 다루므로 컬럼 개수와 IO가 1:1 비례하지는 않습니다. `SELECT name`이라고 해도 행 전체가 든 힙 페이지는 통째로 메모리에 올라옵니다. 다만 `SELECT *`가 실제로 IO를 늘리는 경로들이 따로 있습니다.
>
> - **TOAST/Out-of-line 추가 IO**: PostgreSQL은 큰 컬럼 값(2KB 초과 텍스트/JSON/bytea 등)을 별도 TOAST 테이블에 분리 저장하고 메인 행에는 포인터만 남깁니다. 흥미롭게도 TOAST된 컬럼을 SELECT하지 않으면 PostgreSQL은 포인터를 그냥 무시하므로 추가 IO가 발생하지 않습니다(공식 문서 + 실증 분석). 반대로 `SELECT *`는 TOAST 포인터를 모두 따라가서 chunk들을 읽어야 하므로, 큰 값 하나당 수십 번의 추가 IO가 행마다 누적될 수 있습니다.
> - **Index-Only Scan 기회 상실**: 일부 컬럼만 필요하면 인덱스만으로 답을 줄 수 있지만, `*`는 결국 힙 접근을 요구합니다.
> - **네트워크 전송량 + 직렬화 비용 증가**: 클라이언트로 보내는 바이트와 행 재구성 비용.
>
> 즉 페이지 단위 IO만 보면 컬럼 수가 무관해 보이지만, TOAST와 covering index를 고려하면 `SELECT *`는 실제로 IO를 증가시키는 경우가 많습니다.

> **4장 요약**: IO는 메모리 대비 자릿수 차이로 느립니다. OLTP 워크로드의 주요 병목이고, 인덱스·캐시·페이지 밀도 등이 IO를 줄이는 핵심 도구입니다.

## 5. Heap: 실제 데이터가 사는 곳

### 정의

> **Heap**: 테이블의 실제 행 데이터를 담는 페이지들의 모음. 일반적으로 순서 없이 저장됩니다(insertion order에 가까움).

PostgreSQL의 모든 테이블은 기본적으로 heap입니다. **InnoDB는 heap이 아니라 PK로 정렬된 clustered index를 테이블 자체로 씁니다** (이게 두 DB의 결정적 차이).

### Heap의 특성

- **무순서**: PostgreSQL heap은 행을 insertion order에 가깝게 저장합니다 (UPDATE/DELETE/VACUUM에 따라 빈 공간이 재사용되어 완전 정렬은 아님).
- **빠른 INSERT**: 새 행은 마지막 페이지의 free space에 추가하면 끝납니다.
- **느린 lookup**: 특정 값을 찾으려면 모든 페이지를 스캔해야 합니다. 이게 **풀 스캔(sequential scan)** 입니다.

### Full Scan 비용 계산

직원 1만 명, PostgreSQL 기본 8KB 페이지, 페이지당 행 100개를 가정하면 **100 페이지** 를 접근해야 합니다. `ID = 9999`인 직원 한 명을 찾으려고 100 페이지를 다 읽어야 합니다. 다만 이건 순차 접근이라 OS의 readahead로 여러 페이지가 묶여 적재되므로 물리적 IO 횟수는 더 적습니다. 이래서 풀 스캔이 의외로 효율적인 경우가 많습니다(특히 작은 테이블이나 결과 행이 많은 쿼리). 하지만 원하는 행이 1개뿐인데 100 페이지를 다 훑는 비용은 인덱스 lookup의 단 몇 페이지에 비해 자릿수 차이로 비쌉니다.

> **5장 요약**: Heap은 실제 데이터의 페이지 모음입니다. INSERT는 빠르지만 특정 값 lookup은 풀 스캔이 필요해 비효율적입니다(결과 행이 적을 때 특히). 그래서 인덱스가 필요합니다.

## 6. Index: 정확한 페이지를 알려주는 데이터 구조

5장까지 우리는 *"DB는 페이지 단위로 데이터를 다룬다"* 는 사실을 봤습니다. 풀 스캔은 모든 페이지를 훑어야 하니 비쌉니다. 이제 자연스럽게 질문이 따라옵니다. *"어떻게 적은 페이지 집합으로 원하는 데이터에 도달할 것인가?"* 이 문제를 푸는 구조가 인덱스입니다.

### 정의

> **Index**: 힙의 어느 페이지에 어떤 값이 있는지를 빠르게 찾을 수 있게 해주는 별도의 데이터 구조. 보통 B+Tree로 구현됩니다.

인덱스의 본질은 IO를 없애는 게 아니라 **필요한 페이지 집합을 극단적으로 줄이는 것** 입니다. 인덱스 자체도 디스크에 저장된 페이지 묶음이고, 인덱스 검색도 IO를 발생시킵니다. 다만 N개 페이지를 훑는 풀 스캔 대신 몇 개 페이지로 답을 찾는 형태로 문제를 축소합니다.

### B+Tree 구조

B+Tree는 균형 트리의 일종으로, RDBMS 인덱스의 사실상 표준입니다.

![B+Tree, 노드 = 한 페이지, fanout 100~300](/uploads/theory/db-storage/btree.svg)

핵심 속성은 다음과 같습니다.

- **Key는 정렬되어 있다**: 왼쪽으로 갈수록 작고, 오른쪽으로 갈수록 큽니다.
- **모든 데이터는 leaf에만**: internal node는 경로 안내만 합니다.
- **Leaf 노드들은 양방향 링크**: range query(`BETWEEN`, `>`, `<`)가 효율적입니다. leaf 한 개를 찾으면 형제 leaf로 순차 이동합니다.
- **균형 트리**: 어느 leaf까지의 깊이도 같습니다. 즉 항상 O(log N) 검색입니다.

### B+Tree의 IO 효율

각 노드 = 한 페이지(PG 8KB, InnoDB 16KB). 페이지 하나에 수백 개의 키가 들어가므로 **fanout(분기수)이 큽니다.** 학술 자료 + 실측 기준 fanout은 보통 **100~300 수준** 입니다(키 크기 + fill factor에 따라 달라지며, fill factor 67% 가정 시 max의 약 2/3가 평균 fanout). 이 fanout이면 **수억 행 테이블도 트리 깊이 3~4면 충분** 합니다. 예를 들어 fanout 133 기준 깊이 4면 약 3억 leaf 페이지입니다. 키가 작을수록 fanout이 커져 트리가 더 얕아지고, 키가 길수록(긴 문자열, 복합 키) fanout이 줄어 깊이가 늘어납니다.

> **fanout이 큰 게 왜 중요한가**: fanout이 클수록 트리 깊이가 작아지고, 트리 깊이가 작을수록 lookup에 필요한 페이지 접근이 줄어듭니다. 이게 B+Tree가 인덱스 표준이 된 이유의 본질입니다. 디스크 친화적인 얕은 트리인 것입니다. 풀 스캔(N 페이지 접근) 대비 자릿수 차이가 여기서 만들어집니다.
>
> 더 본질적으로 보면 **B+Tree는 노드 크기를 페이지 크기에 맞춰 설계** 되어 있습니다. 이진 탐색 트리처럼 노드 하나에 키 하나가 아니라, 노드 하나 = 한 페이지(8KB/16KB) = 수백 개 키입니다. 결과적으로 **트리 탐색 한 단계 = 디스크 페이지 접근 한 번** 이라는 매핑이 자연스럽게 성립합니다. 자료구조와 IO 패턴이 한 단위로 묶인 설계, 이게 B+Tree가 디스크 시대의 표준 인덱스가 된 진짜 이유입니다.

게다가 실제 성능은 논리적 페이지 접근 횟수보다 **buffer pool hit rate** 에 더 크게 좌우됩니다. PostgreSQL의 `shared_buffers`(+ OS 페이지 캐시), MySQL InnoDB의 `innodb_buffer_pool_size`로 설정하는 메모리 영역에 자주 접근되는 페이지가 캐시되면 물리 디스크 IO 자체가 일어나지 않습니다. 이게 인덱스 상위 노드(root, internal)가 사실상 거의 항상 캐시에 머무르는 이유고, 인덱스 lookup의 실질 디스크 IO가 이론보다 훨씬 적은 이유입니다.

### 인덱스 lookup의 두 단계: Index + Heap

PostgreSQL 기준 (가장 흔한 패턴):

1. **인덱스 검색**: B+Tree를 따라 leaf까지 내려가 원하는 키를 찾고, leaf에 저장된 CTID(`(페이지번호, 슬롯번호)`)를 얻습니다. 이론상 트리 깊이만큼의 IO(보통 3~4번)지만, 상위 노드(root, internal)는 자주 접근되어 OS 페이지 캐시에 거의 항상 머물기 때문에 실제 디스크 IO는 leaf 1~2번에 그치는 경우가 많습니다.
2. **힙 접근**: CTID가 가리키는 힙 페이지를 IO해서 행 전체를 가져옵니다. IO 1번입니다.

총 실질 IO는 **2~3번** 정도입니다. 풀 스캔(N번)과 비교하면 자릿수 차이입니다.

### Index-Only Scan (보너스)

쿼리가 인덱스 안에 있는 컬럼만 필요로 하면, 힙 접근 단계를 건너뛸 수 있습니다. 예를 들어 `idx(id, name)` 인덱스가 있고 `SELECT name FROM t WHERE id = 40`이면 인덱스만으로 답이 나옵니다.

다만 PostgreSQL의 Index-Only Scan은 **Visibility Map** 에 따라 조건부로 동작합니다. MVCC 때문에 *"이 페이지의 모든 행이 모두에게 보임"* 표시가 있어야 힙 접근을 생략할 수 있습니다. (자세한 건 이 시리즈 후속편에서 다룹니다.)

> **6장 요약**: 인덱스는 별도의 B+Tree 데이터 구조입니다. fanout이 커서 트리 깊이가 얕고, lookup은 트리 깊이만큼(보통 3~4번, 캐시 덕분에 실제 디스크 IO는 더 적음)의 페이지 접근으로 끝납니다. PostgreSQL은 인덱스 검색 후 힙 접근하는 2단계가 일반적이지만, Index-Only Scan이나 캐시 히트로 힙 접근이 생략될 수 있습니다.

## 7. Clustered Index vs Secondary Index: PostgreSQL과 InnoDB의 결정적 차이

이게 두 DB의 가장 큰 물리 구조 차이입니다.

![PostgreSQL vs InnoDB, Index와 Heap의 결정적 차이](/uploads/theory/db-storage/clustered-vs-secondary.svg)

### Clustered Index

> **Clustered Index**: 테이블 자체가 특정 키 순서로 정렬되어 저장된 구조. leaf 노드에 행 전체가 들어있습니다.

### Secondary Index

> **Secondary Index**: 별도의 B+Tree로, leaf에 키 + 행 식별자만 저장. 실제 데이터는 다른 곳(힙 또는 clustered index)에 있습니다.

### PostgreSQL: 모든 인덱스가 Secondary

PostgreSQL은 (InnoDB 같은 의미의) clustered index가 없습니다. 테이블은 항상 힙(무순서 페이지 모음)이고, 모든 인덱스는 별도의 B+Tree에 키 + CTID만 저장합니다. PostgreSQL의 `CLUSTER` 명령이 있긴 하지만 **일회성 물리 재정렬** 일 뿐, 이후 INSERT/UPDATE는 정렬을 유지하지 않습니다. InnoDB의 *지속적으로 정렬을 유지하는* clustered index와는 다른 개념입니다.

![PostgreSQL, Index에서 Heap으로 이어지는 2단계 lookup](/uploads/theory/db-storage/pg-index-heap.svg)

- **장점**: 모든 인덱스가 동등합니다. PK를 변경해도 다른 인덱스에 영향이 없습니다.
- **단점**: 일반적으로 인덱스 → 힙 2단계 IO가 필요합니다 (단, Index-Only Scan이 가능하거나 힙 페이지가 이미 shared buffer에 있으면 힙 IO는 생략 가능). UPDATE 시 모든 인덱스를 갱신해야 합니다.

### MySQL InnoDB: PK가 Clustered, Secondary는 PK를 가리킴

InnoDB는 테이블 자체가 PK 기준으로 정렬된 B+Tree입니다. PK B+Tree의 leaf에 **행 전체가 들어있습니다.**

![InnoDB, Clustered Index leaf 자체에 행](/uploads/theory/db-storage/innodb-clustered.svg)

Secondary index는 leaf에 secondary key + PK만 저장합니다. 실제 행을 가져오려면 PK로 다시 clustered index를 lookup합니다.

![InnoDB, Secondary Index에서 Clustered Index로 이어지는 2단계 lookup](/uploads/theory/db-storage/innodb-secondary.svg)

- **장점**: PK 기반 lookup은 1단계입니다. clustered index 한 번이면 행이 나옵니다.
- **단점**: Secondary index 사용 시 2단계입니다 (secondary → clustered). 그리고 **PK가 길면 모든 secondary index가 부풀어 오릅니다** (PK 값을 leaf마다 저장하므로).

### UUID PK가 InnoDB에서 위험한 이유

InnoDB에서 PK는 단순한 식별자가 아니라 **물리적 데이터 배치를 결정하는 값** 입니다. clustered index = 테이블 자체이므로, PK가 어떤 값이냐에 따라 행이 디스크 어디에 놓이느냐가 정해집니다. 이 관점에서 무작위 UUID를 PK로 쓰면 다음과 같습니다.

- INSERT마다 무작위 위치의 페이지에 추가되어 **페이지 분할(split)이 자주 발생합니다.**
- 새 행이 매번 다른 페이지에 들어가므로 **캐시 히트율이 저하됩니다.**
- 페이지가 빈번히 분할되면서 **fragmentation이 누적되고 디스크 사용량이 증가합니다.**

해결책은 **시간 정렬 가능한 ID**(UUIDv7, ULID, snowflake), 또는 별도 auto-increment PK를 두고 UUID는 unique secondary index로 두는 것입니다.

PostgreSQL은 clustered index가 없으므로 이 문제가 본질적으로 작습니다. UUID PK라도 INSERT는 대체로 마지막 힙 페이지에 append되는 패턴을 따릅니다. 단, 완전한 순차 append는 아닙니다. UPDATE/DELETE/VACUUM으로 생긴 free space에 새 행이 재사용되어 들어가는 경우(FSM, Free Space Map 기반)도 있고, fillfactor 설정에 따라 동일 페이지에 후속 변경이 들어가기도 합니다. 그럼에도 InnoDB처럼 PK 값에 따라 무작위 위치로 흩어지지는 않습니다. 한편 PK 자체에 대한 unique B+Tree 인덱스는 만들어지므로, 그 인덱스의 페이지 분할/fragmentation 비용은 InnoDB와 마찬가지로 발생합니다. 결정적 차이는 **힙 자체가 PK 값에 묶여 분할되지 않는다는 점** 입니다.

> **7장 요약**: PostgreSQL은 모든 인덱스가 secondary이고 힙은 무순서입니다. InnoDB는 PK가 clustered이고 secondary는 PK를 가리킵니다. UUID PK는 InnoDB에서 특히 위험합니다.

## 8. 정리: 한 페이지의 인생

### 핵심 통찰

- **DB는 행 단위가 아니라 페이지 단위로 일한다.** 한 행을 가져오려고 해도 페이지 단위로 buffer pool에 올라옵니다 (실제 물리 IO는 OS와 스토리지 계층에 따라 다른 단위로 처리될 수 있고, buffer pool hit 시 디스크 IO 자체가 발생하지 않음).
- **IO가 OLTP의 주요 병목**: 메모리 대비 자릿수 차이입니다. random IO는 SSD 내부 병렬성과 prefetch 캐시를 깨뜨려 sequential보다 훨씬 비쌉니다. IO 최적화는 기본 전제고, 그 위에 CPU·lock·network 같은 다른 차원이 쌓입니다.
- **Heap은 실제 데이터, Index는 페이지 집합 축소 도구**: 인덱스의 본질은 IO를 없애는 게 아니라 *필요한 페이지 집합을 극단적으로 줄이는 것* 입니다. 둘 다 페이지로 저장되지만 역할이 다릅니다.
- **B+Tree가 인덱스의 사실상 표준**: 노드 크기를 페이지 크기에 맞춰 설계해, 트리 탐색 한 단계가 디스크 페이지 접근 한 번이 됩니다. fanout이 100~300으로 커서 트리가 얕고, leaf 좌우 링크로 range query가 효율적입니다.
- **Buffer pool이 진짜 성능을 결정한다**: PostgreSQL `shared_buffers`, InnoDB `innodb_buffer_pool_size`. 자주 접근되는 페이지가 캐시에 머물면 물리 디스크 IO 자체가 일어나지 않습니다.
- **Clustered Index는 PostgreSQL과 InnoDB를 결정적으로 다르게 만든다**: 모든 인덱스 동작과 PK 선택 가이드라인이 여기서 갈립니다.
- **`SELECT *`는 컬럼 수와 IO가 1:1 비례하지는 않지만**, TOAST chunk 추가 IO + Index-Only Scan 기회 상실 + 네트워크 전송량 증가로 결과적으로 IO를 늘리는 경우가 많습니다.

> 결국 스토리지 내부의 핵심 설계 결정은 **얼마나 적은 페이지 접근으로 답을 만들 것인가** 라는 한 가지 질문으로 수렴합니다. 페이지를 어떻게 쪼갤지, 인덱스를 어떻게 만들지, PK를 무엇으로 할지, 거의 모든 선택이 **페이지 접근 횟수와 그것이 캐시에 머물 확률** 로 평가됩니다. 다른 차원(CPU, lock, network)은 그 위에 쌓입니다.

## 참고 (1차 자료 우선)

- [PostgreSQL Documentation — Database Page Layout](https://www.postgresql.org/docs/current/storage-page-layout.html): 페이지 헤더, line pointer, tuple 구조 공식 명세
- [MySQL 8.4 Reference — Clustered and Secondary Indexes](https://dev.mysql.com/doc/refman/8.4/en/innodb-index-types.html): InnoDB의 PK 기반 clustered index 공식 설명
- [Jeremy Cole — B+Tree index structures in InnoDB](https://blog.jcole.us/2013/01/10/btree-index-structures-in-innodb/): InnoDB 페이지 내부 구조 분석의 고전
- [boringSQL — Inside PostgreSQL's 8KB Page](https://www.boringsql.com/posts/inside-postgresql-8kb-page/): PostgreSQL 페이지 구조의 실증 분석
- [Stormatics — PostgreSQL Internals: Page Structure](https://stormatics.tech/blogs/postgresql-internals-page-structure): 페이지 헤더 필드별 의미
- Hellerstein, Stonebraker, Hamilton — *Architecture of a Database System* (2007): DB 시스템 구조의 표준 참고자료
- [CMU 15-445 Database Systems 강의](https://15445.courses.cs.cmu.edu/): Storage, Indexes 모듈

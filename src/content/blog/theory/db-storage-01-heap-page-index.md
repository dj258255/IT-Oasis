---
title: 'DB 스토리지 내부 ①: Heap, Page, Index, B-Tree'
titleEn: 'DB Storage Internals ①: Heap, Page, Index, B-Tree'
description: DB는 행 단위로 일하지 않고 페이지 단위로 일해요. PostgreSQL 8KB / InnoDB 16KB 페이지 안에 행이 어떻게 살고, 인덱스가 어떻게 페이지 집합을 줄이고, 왜 InnoDB의 UUID PK가 위험한지를 1차 자료 기준으로 정리합니다.
descriptionEn: DBs do not work in rows — they work in pages. How rows live inside PostgreSQL's 8KB / InnoDB's 16KB pages, how indexes shrink the set of pages you must touch, and why a UUID PK is particularly dangerous in InnoDB — grounded in primary sources.
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

[ACID 시리즈](/blog/theory/transaction-acid-01-atomicity)가 트랜잭션의 의미론을 다뤘다면, 이 시리즈는 **데이터가 디스크에 어떻게 살고 있는가** 를 다룹니다. 트랜잭션이 다루는 모든 행, 모든 인덱스, 모든 WAL 레코드는 결국 **페이지(Page)** 라는 단위로 저장되고 읽혀요.

이 글의 핵심 메시지: **"DB는 행 단위로 일하지 않는다. 페이지 단위로 일한다."** SELECT 한 줄, UPDATE 한 줄을 실행해도 DB는 페이지 단위로 데이터를 관리하고 접근합니다. 인덱스도 페이지에 저장되고, 힙도 페이지에 저장돼요. 다만 실제 물리 IO는 OS와 스토리지 계층에 의해 더 큰 단위로 묶이거나 더 작은 블록으로 쪼개질 수 있어요 — 이 추상화의 층층 구조를 이해하는 것이 *왜 어떤 쿼리는 빠르고 왜 어떤 쿼리는 느린지* 를 결정합니다.

## 1. 왜 스토리지 내부를 알아야 하는가

*"왜 이 쿼리가 느린가요?"* 라는 질문에 *"인덱스를 안 걸어서요"* 라고만 답하면 그 다음 질문이 들어와요 — *"그래서 인덱스가 왜 빠르게 만드나요?"* 여기서 막히면 깊이가 드러납니다.

진짜 답은 이래요: 풀 스캔은 논리적으로 **N개 페이지** 를 접근해야 하고(실제로는 OS readahead로 sequential read에 묶여 효율적이지만 양 자체는 N), 인덱스 스캔은 **트리 깊이만큼(보통 3~4번)** 의 페이지 접근이면 답이 나와요. 이 답을 하려면 페이지가 뭔지, IO가 뭔지, 인덱스가 어떤 데이터 구조인지 알아야 합니다.

이번 글은 그 가장 기초를 다뤄요.

## 2. 행(Row), 행 ID(Tuple ID)

### 행은 우리가 보는 것

```sql
SELECT id, name, salary FROM employees WHERE id = 40;
```

이걸 짤 때 우리는 **논리적인 행** 을 떠올려요. `id=40`인 행 하나, 그 안에 `name`과 `salary`가 있어요. 깔끔합니다.

### Row ID — DB가 내부적으로 쓰는 식별자

그런데 DB는 우리가 정의한 PK(`id`)를 직접 쓰는 게 아니라, **내부적으로 행의 물리적 위치를 가리키는 별도 식별자** 를 써요. 이 식별자가 **페이지 번호 + 페이지 안의 슬롯** 을 합친 것입니다.

| DB | 내부 행 식별자 이름 | 구조 |
|---|---|---|
| PostgreSQL | **CTID** (Tuple ID) | (페이지 번호, 페이지 내 line pointer index) — 예: `(0, 1)` |
| MySQL InnoDB | (clustered index 사용 시) PK 자체가 식별자 역할 | PK가 없으면 InnoDB가 6바이트 hidden GEN_CLUST_INDEX 행 ID를 자동 생성 |
| Oracle | **ROWID** | 파일 + 블록 + 행 슬롯 |

PostgreSQL은 모든 인덱스 종류(B-tree, Hash, GIN, GiST, BRIN 등)가 결국 **CTID를 가리켜요** — 즉 모든 인덱스가 secondary index입니다 (clustered index 자체가 없음). MySQL InnoDB는 PK가 곧 clustered index이고, secondary index는 **PK 값을 저장** 합니다(CTID 같은 물리 주소가 아님). InnoDB에 PK가 없으면 첫 NOT NULL UNIQUE 인덱스를 clustered index로 사용하고, 그것도 없으면 6바이트 hidden 행 ID(GEN_CLUST_INDEX)를 자동 생성해요 — 즉 **InnoDB 테이블은 항상 clustered index를 갖습니다.** 이 차이가 두 DB의 인덱스 동작을 결정적으로 다르게 만들어요 — 자세한 건 아래 7장에서.

> **2장 요약** — 우리가 보는 PK와 DB가 내부에서 쓰는 행 식별자는 다를 수 있어요. PostgreSQL은 CTID로 항상 분리, InnoDB는 PK 자체를 식별자로 사용합니다.

## 3. Page — DB가 데이터를 다루는 단위

### 페이지란

> **Page**: DB가 디스크에서 읽고 쓰는 고정 크기 단위. PostgreSQL 기본 8KB, MySQL InnoDB 기본 16KB.

여기서 **"고정 크기"** 가 핵심이에요. DB는 행 하나만 읽는 게 아니라 **페이지 단위** 로 데이터를 가져옵니다. SELECT 한 행을 위해 한 페이지(8KB 또는 16KB)가 buffer pool로 올라오고, 그 페이지에 다른 행 100개가 있어도 같이 따라와요. 다만 **디스크에서 읽는 것** 과 **buffer pool에서 가져오는 것** 은 다릅니다 — 이미 메모리에 있는 페이지면 디스크 IO 없이 처리돼요. *"페이지 단위"* 자체는 항상 그렇지만, *"디스크 IO가 발생하는가"* 는 buffer pool hit 여부에 달려있습니다.

### 왜 행이 아니라 페이지인가

이건 **디스크의 본질** 에서 와요. RAM은 바이트 단위 주소 지정(random access)이 가능해서 *"주소 0x1234의 1바이트만 읽어줘"* 가 자연스럽습니다. 하지만 디스크는 그렇게 동작하지 않아요 — HDD는 회전·헤드 이동 비용이 있고, SSD도 페이지(보통 4KB) 단위로 읽고 씁니다. 한 바이트만 읽고 싶어도 최소 한 블록은 읽어야 해요.

DB는 이 현실 위에서 일하므로, **페이지 단위라는 더 큰 추상화** 를 둡니다. 한 번 IO를 하면 한 페이지(여러 행 묶음)가 한꺼번에 올라와요.

### 페이지의 물리적 위치 = 파일 안의 블록 번호

PostgreSQL 기준 — 테이블마다 디스크에 데이터 파일이 있고, 그 파일은 8KB 단위 블록들로 나뉘어요. 블록 번호는 0부터 순차 증가. 행이 추가되어 마지막 블록이 꽉 차면 새 블록을 파일 끝에 추가합니다.

InnoDB도 비슷하지만 16KB 페이지로, 그리고 PK 순서로 정렬된 B+Tree 노드(=페이지)들이 연결돼요.

### 페이지 안의 구조 (PostgreSQL 8KB 기준)

![PostgreSQL 페이지 레이아웃 — Slotted Page](/uploads/theory/db-storage/page-layout.svg)

핵심 포인트:

- **Line Pointer 배열(페이지 위쪽)** 이 각 행의 오프셋과 길이를 저장. CTID의 두 번째 숫자가 이 line pointer 인덱스예요.
- **Tuple 데이터(페이지 아래쪽)** 는 거꾸로 자라남. 위쪽 line pointer 끝과 아래쪽 tuple 시작 사이의 free space가 새 행을 추가할 공간.
- 인덱스 페이지의 경우 **Special Space** 에 형제 페이지 링크 등의 메타데이터.

이 line pointer 간접 참조 덕분에 PostgreSQL은 페이지 안에서 행을 옮길 수 있어요(VACUUM, defragmentation, HOT update 등). 인덱스가 line pointer를 가리키므로 행이 페이지 안에서 이동해도 인덱스는 깨지지 않아요.

> **3장 요약** — 페이지는 DB의 논리적 IO 최소 단위(PG 8KB, InnoDB 16KB). 페이지 안에 여러 행이 있고, line pointer 배열이 각 행 위치를 가리킵니다. 디스크 기반 RDBMS는 행 한 개만 읽지 않고 페이지 단위로 작업해요 — 다만 물리적 IO는 OS readahead로 더 크게 묶이거나(PostgreSQL 18의 `io_combine_limit` 기본 128KB = 16 페이지), SSD/파일시스템 4KB 블록으로 쪼개질 수도 있어요.

## 4. IO — 줄여야 하는 비용

### IO = 디스크 읽기/쓰기 요청

> **IO**: 디스크로의 단일 read 또는 write 요청. DB 입장에서는 페이지 단위로 요청하지만, 실제 물리 IO 크기는 더 클 수도 더 작을 수도 있어요.

여기서 정확히 짚을 점이 있어요 — DB의 페이지는 **논리적 단위** 고, 물리 IO 단위는 여러 층의 추상화에 의해 결정됩니다:

- **DB 페이지**: PostgreSQL 8KB, InnoDB 16KB (논리적 단위, buffer pool의 단위)
- **OS 페이지/파일시스템 블록**: 일반적으로 4KB (Linux ext4/XFS 기본)
- **SSD 섹터**: 일반적으로 4KB (HDD는 512B 또는 4KB)
- **실제 IO 요청 크기**: OS readahead, sequential prefetch, PostgreSQL 18의 `io_combine_limit`(기본 128KB = 16 데이터 페이지) 등으로 훨씬 큰 단위로 묶일 수 있음

즉 *"DB 페이지 = IO 단위"* 는 DB 추상화의 관점에서만 그렇습니다. **실제 물리 IO 횟수와 크기는 OS·파일시스템·스토리지 계층에 의해 달라져요.**

### IO가 비싼 이유

이런 추상화 층층 구조가 있어도 진짜 비싼 것은 결국 디스크 자체예요. 자릿수 비교: CPU 한 사이클 ~0.3ns, RAM 접근 ~100ns, NVMe SSD random read ~10~100μs (장치별 편차 큼), HDD random read ~5~15ms — RAM 대비 100배~10만 배 이상 느립니다. [D편](/blog/theory/transaction-acid-04-durability)에서 본 것과 같은 자릿수 차이.

따라서 **대부분의 OLTP 워크로드에서 IO가 주요 병목** 이에요 — 짧은 트랜잭션 + 작은 결과셋 + 디스크 접근 패턴이 성능을 결정짓는 환경. 다만 모든 워크로드가 그런 건 아닙니다 — 복잡한 집계는 CPU bound일 수 있고, 동시성 높은 시스템은 lock contention이, 분산 시스템은 network latency가 병목이 돼요. IO 최적화는 기본 전제고, 그 위에 다른 차원이 쌓입니다.

### IO를 줄이는 방법

1. **인덱스로 정확한 페이지만 가져오기** — 풀 스캔 대신 1~3 페이지만 IO.
2. **OS 페이지 캐시에 의존** — 자주 읽는 페이지는 메모리에 남아있어 디스크 IO 없이 처리.
3. **순차 IO 활용** — HDD/SSD 모두 random보다 sequential이 훨씬 빨라요. 왜 그런가: HDD는 헤드 이동·회전 지연이 없어지고, SSD는 내부 채널 병렬성과 prefetch 캐시 효율을 살릴 수 있어요. random IO는 이 모든 메커니즘을 깨뜨리기 때문에 비쌉니다. 풀 스캔은 sequential 패턴이라 의외로 효율적인 경우가 많아요.
4. **페이지 안의 데이터 밀도 높이기** — 행이 작을수록 한 페이지에 더 많이 들어가고 IO가 줄어들어요.

> *"SELECT *는 비싸다"* 는 흔한 격언의 진짜 메커니즘은 좀 더 미묘해요. DB가 페이지 단위로 데이터를 다루므로 컬럼 개수와 IO가 1:1 비례하지는 않습니다 — `SELECT name`이라고 해도 행 전체가 든 힙 페이지는 통째로 메모리에 올라와요. 다만 `SELECT *`가 실제로 IO를 늘리는 경로들이 따로 있어요:
>
> - **TOAST/Out-of-line 추가 IO** — PostgreSQL은 큰 컬럼 값(2KB 초과 텍스트/JSON/bytea 등)을 별도 TOAST 테이블에 분리 저장하고 메인 행에는 포인터만 남깁니다. 흥미롭게도 TOAST된 컬럼을 SELECT하지 않으면 PostgreSQL은 포인터를 그냥 무시하므로 추가 IO가 발생하지 않아요(공식 문서 + 실증 분석). 반대로 `SELECT *`는 TOAST 포인터를 모두 따라가서 chunk들을 읽어야 하므로, 큰 값 하나당 수십 번의 추가 IO가 행마다 누적될 수 있어요.
> - **Index-Only Scan 기회 상실** — 일부 컬럼만 필요하면 인덱스만으로 답을 줄 수 있지만, `*`는 결국 힙 접근을 요구합니다.
> - **네트워크 전송량 + 직렬화 비용 증가** — 클라이언트로 보내는 바이트와 행 재구성 비용.
>
> 즉 페이지 단위 IO만 보면 컬럼 수가 무관해 보이지만, TOAST와 covering index를 고려하면 `SELECT *`는 실제로 IO를 증가시키는 경우가 많아요.

> **4장 요약** — IO는 메모리 대비 자릿수 차이로 느립니다. OLTP 워크로드의 주요 병목이고, 인덱스·캐시·페이지 밀도 등이 IO를 줄이는 핵심 도구예요.

## 5. Heap — 실제 데이터가 사는 곳

### 정의

> **Heap**: 테이블의 실제 행 데이터를 담는 페이지들의 모음. 일반적으로 순서 없이 저장됩니다(insertion order에 가까움).

PostgreSQL의 모든 테이블은 기본적으로 heap이에요. **InnoDB는 heap이 아니라 PK로 정렬된 clustered index를 테이블 자체로 씁니다** (이게 두 DB의 결정적 차이).

### Heap의 특성

- **무순서**: PostgreSQL heap은 행을 insertion order에 가깝게 저장 (UPDATE/DELETE/VACUUM에 따라 빈 공간이 재사용되어 완전 정렬은 아님).
- **빠른 INSERT**: 새 행은 마지막 페이지의 free space에 추가하면 끝.
- **느린 lookup**: 특정 값을 찾으려면 모든 페이지를 스캔해야 함 — 이게 **풀 스캔(sequential scan)**.

### Full Scan 비용 계산

직원 1만 명, PostgreSQL 기본 8KB 페이지, 페이지당 행 100개 가정 → **100 페이지** 를 접근해야 함. `ID = 9999`인 직원 한 명을 찾으려고 100 페이지를 다 읽어야 해요. 다만 이건 순차 접근이라 OS의 readahead로 여러 페이지가 묶여 적재되므로 물리적 IO 횟수는 더 적습니다 — 이래서 풀 스캔이 의외로 효율적인 경우가 많아요(특히 작은 테이블이나 결과 행이 많은 쿼리). 하지만 원하는 행이 1개뿐인데 100 페이지를 다 훑는 비용은 인덱스 lookup의 단 몇 페이지에 비해 자릿수 차이로 비싸요.

> **5장 요약** — Heap은 실제 데이터의 페이지 모음이에요. INSERT는 빠르지만 특정 값 lookup은 풀 스캔이 필요해 비효율적입니다(결과 행이 적을 때 특히). 그래서 인덱스가 필요해요.

## 6. Index — 정확한 페이지를 알려주는 데이터 구조

5장까지 우리는 *"DB는 페이지 단위로 데이터를 다룬다"* 는 사실을 봤어요. 풀 스캔은 모든 페이지를 훑어야 하니 비싸요. 이제 자연스럽게 따라오는 질문 — *"어떻게 적은 페이지 집합으로 원하는 데이터에 도달할 것인가?"* 이 문제를 푸는 구조가 인덱스입니다.

### 정의

> **Index**: 힙의 어느 페이지에 어떤 값이 있는지를 빠르게 찾을 수 있게 해주는 별도의 데이터 구조. 보통 B+Tree로 구현됩니다.

인덱스의 본질은 **IO를 없애는 게 아니라 필요한 페이지 집합을 극단적으로 줄이는 것** 이에요. 인덱스 자체도 디스크에 저장된 페이지 묶음이고, 인덱스 검색도 IO를 발생시킵니다. 다만 N개 페이지를 훑는 풀 스캔 대신 몇 개 페이지로 답을 찾는 형태로 문제를 축소해요.

### B+Tree 구조

B+Tree는 균형 트리의 일종으로, RDBMS 인덱스의 사실상 표준이에요.

![B+Tree — 노드 = 한 페이지, fanout 100~300](/uploads/theory/db-storage/btree.svg)

핵심 속성:

- **Key는 정렬되어 있다** — 왼쪽으로 갈수록 작고, 오른쪽으로 갈수록 큼.
- **모든 데이터는 leaf에만** — internal node는 경로 안내만 함.
- **Leaf 노드들은 양방향 링크** — range query(`BETWEEN`, `>`, `<`)가 효율적. leaf 한 개를 찾으면 형제 leaf로 순차 이동.
- **균형 트리** — 어느 leaf까지의 깊이도 같음. 즉 항상 O(log N) 검색.

### B+Tree의 IO 효율

각 노드 = 한 페이지(PG 8KB, InnoDB 16KB). 페이지 하나에 수백 개의 키가 들어가므로 **fanout(분기수)이 큽니다.** 학술 자료 + 실측 기준 fanout은 보통 **100~300 수준** (키 크기 + fill factor에 따라 달라짐 — fill factor 67% 가정 시 max의 약 2/3가 평균 fanout). 이 fanout이면 **수억 행 테이블도 트리 깊이 3~4면 충분** 해요 — 예: fanout 133 기준 깊이 4에 약 3억 leaf 페이지. 키가 작을수록 fanout이 커져 트리가 더 얕아지고, 키가 길수록(긴 문자열, 복합 키) fanout이 줄어 깊이가 늘어나요.

> **fanout이 큰 게 왜 중요한가**: fanout이 클수록 트리 깊이가 작아지고, 트리 깊이가 작을수록 lookup에 필요한 페이지 접근이 줄어들어요. 이게 B+Tree가 인덱스 표준이 된 이유의 본질입니다 — 디스크 친화적인 얕은 트리. 풀 스캔(N 페이지 접근) 대비 자릿수 차이가 여기서 만들어져요.
>
> 더 본질적으로: **B+Tree는 노드 크기를 페이지 크기에 맞춰 설계** 되어 있어요. 이진 탐색 트리처럼 노드 하나에 키 하나가 아니라, 노드 하나 = 한 페이지(8KB/16KB) = 수백 개 키. 결과적으로 **트리 탐색 한 단계 = 디스크 페이지 접근 한 번** 이라는 매핑이 자연스럽게 성립합니다. 자료구조와 IO 패턴이 한 단위로 묶인 설계 — 이게 B+Tree가 디스크 시대의 표준 인덱스가 된 진짜 이유예요.

게다가 실제 성능은 논리적 페이지 접근 횟수보다 **buffer pool hit rate** 에 더 크게 좌우돼요. PostgreSQL의 `shared_buffers`(+ OS 페이지 캐시), MySQL InnoDB의 `innodb_buffer_pool_size`로 설정하는 메모리 영역에 자주 접근되는 페이지가 캐시되면 물리 디스크 IO 자체가 일어나지 않아요. 이게 인덱스 상위 노드(root, internal)가 사실상 거의 항상 캐시에 머무르는 이유고, 인덱스 lookup의 실질 디스크 IO가 이론보다 훨씬 적은 이유입니다.

### 인덱스 lookup의 두 단계 — Index + Heap

PostgreSQL 기준 (가장 흔한 패턴):

1. **인덱스 검색**: B+Tree를 따라 leaf까지 내려감 → 원하는 키를 찾음 → leaf에 저장된 CTID(`(페이지번호, 슬롯번호)`)를 얻음. 이론상 트리 깊이만큼의 IO(보통 3~4번)지만, 상위 노드(root, internal)는 자주 접근되어 OS 페이지 캐시에 거의 항상 머물기 때문에 실제 디스크 IO는 leaf 1~2번에 그치는 경우가 많아요.
2. **힙 접근**: CTID가 가리키는 힙 페이지를 IO해서 행 전체 가져옴. IO 1번.

총 실질 IO **2~3번** 정도. 풀 스캔(N번)과 비교하면 자릿수 차이.

### Index-Only Scan (보너스)

쿼리가 인덱스 안에 있는 컬럼만 필요로 하면, 힙 접근 단계를 건너뛸 수 있어요. 예: `idx(id, name)` 인덱스가 있고 `SELECT name FROM t WHERE id = 40`이면 인덱스만으로 답이 나옵니다.

다만 PostgreSQL의 Index-Only Scan은 **Visibility Map** 에 따라 조건부로 동작해요 — MVCC 때문에 *"이 페이지의 모든 행이 모두에게 보임"* 표시가 있어야 힙 접근을 생략할 수 있어요. (자세한 건 이 시리즈 후속편에서.)

> **6장 요약** — 인덱스는 별도의 B+Tree 데이터 구조예요. fanout이 커서 트리 깊이가 얕고, lookup은 트리 깊이만큼(보통 3~4번, 캐시 덕분에 실제 디스크 IO는 더 적음)의 페이지 접근으로 끝나요. PostgreSQL은 인덱스 검색 후 힙 접근하는 2단계가 일반적이지만, Index-Only Scan이나 캐시 히트로 힙 접근이 생략될 수 있어요.

## 7. Clustered Index vs Secondary Index — PostgreSQL과 InnoDB의 결정적 차이

이게 두 DB의 가장 큰 물리 구조 차이예요.

![PostgreSQL vs InnoDB — Index와 Heap의 결정적 차이](/uploads/theory/db-storage/clustered-vs-secondary.svg)

### Clustered Index

> **Clustered Index**: 테이블 자체가 특정 키 순서로 정렬되어 저장된 구조. leaf 노드에 행 전체가 들어있어요.

### Secondary Index

> **Secondary Index**: 별도의 B+Tree로, leaf에 키 + 행 식별자만 저장. 실제 데이터는 다른 곳(힙 또는 clustered index)에 있어요.

### PostgreSQL — 모든 인덱스가 Secondary

PostgreSQL은 clustered index가 없어요(InnoDB 같은 의미에서). 테이블은 항상 힙(무순서 페이지 모음)이고, 모든 인덱스는 별도의 B+Tree에 키 + CTID만 저장합니다. PostgreSQL의 `CLUSTER` 명령이 있긴 하지만 **일회성 물리 재정렬** 일 뿐, 이후 INSERT/UPDATE는 정렬을 유지하지 않아요 — InnoDB의 *지속적으로 정렬을 유지하는* clustered index와는 다른 개념.

```
[Index B+Tree leaf]: (key=40, ctid=(1,4))
                            ↓
[Heap page 1]: ... slot 4 = {id:40, name:..., salary:...}
```

- **장점**: 모든 인덱스가 동등. PK 변경해도 다른 인덱스 영향 없음.
- **단점**: 일반적으로 인덱스 → 힙 2단계 IO가 필요해요 (단, Index-Only Scan이 가능하거나 힙 페이지가 이미 shared buffer에 있으면 힙 IO는 생략 가능). UPDATE 시 모든 인덱스를 갱신해야 함 (HOT update로 일부 회피 가능, 후속편에서).

### MySQL InnoDB — PK가 Clustered, Secondary는 PK를 가리킴

InnoDB는 테이블 자체가 PK 기준으로 정렬된 B+Tree예요. PK B+Tree의 leaf에 **행 전체가 들어있어요.**

```
[Clustered Index leaf]: (id=40, {name:..., salary:...})  ← 행 자체
```

Secondary index는 leaf에 secondary key + PK만 저장합니다. 실제 행을 가져오려면 PK로 다시 clustered index를 lookup.

```
[Secondary Index leaf]: (name='Alice', id=40)
                                ↓ PK lookup
[Clustered Index leaf]: (id=40, {name:..., salary:...})
```

- **장점**: PK 기반 lookup은 1단계 — clustered index 한 번이면 행이 나옴.
- **단점**: Secondary index 사용 시 2단계 (secondary → clustered). 그리고 **PK가 길면 모든 secondary index가 부풀어 오름** (PK 값을 leaf마다 저장하므로).

### UUID PK가 InnoDB에서 위험한 이유

InnoDB에서 PK는 단순한 식별자가 아니라 **물리적 데이터 배치를 결정하는 값** 이에요. clustered index = 테이블 자체이므로, PK가 어떤 값이냐에 따라 행이 디스크 어디에 놓이느냐가 정해집니다. 이 관점에서 무작위 UUID를 PK로 쓰면:

- INSERT마다 무작위 위치의 페이지에 추가 → **페이지 분할(split)이 자주 발생.**
- 새 행이 매번 다른 페이지에 들어가므로 **캐시 히트율 저하.**
- 페이지가 빈번히 분할되면서 **fragmentation 누적, 디스크 사용량 증가.**

해결책: **시간 정렬 가능한 ID**(UUIDv7, ULID, snowflake) 또는 별도 auto-increment PK + UUID는 unique secondary index로.

PostgreSQL은 clustered index가 없으므로 이 문제가 본질적으로 작아요 — UUID PK라도 INSERT는 대체로 마지막 힙 페이지에 append되는 패턴을 따릅니다. 단, 완전한 순차 append는 아니에요 — UPDATE/DELETE/VACUUM으로 생긴 free space에 새 행이 재사용되어 들어가는 경우(FSM, Free Space Map 기반)도 있고, fillfactor 설정에 따라 동일 페이지에 후속 변경이 들어가기도 해요. 그럼에도 InnoDB처럼 PK 값에 따라 무작위 위치로 흩어지지는 않아요. 한편 PK 자체에 대한 unique B+Tree 인덱스는 만들어지므로, 그 인덱스의 페이지 분할/fragmentation 비용은 InnoDB와 마찬가지로 발생합니다. 결정적 차이는 **힙 자체가 PK 값에 묶여 분할되지 않는다는 점** 이에요.

> **7장 요약** — PostgreSQL: 모든 인덱스가 secondary, 힙은 무순서. InnoDB: PK가 clustered, secondary는 PK를 가리킴. UUID PK는 InnoDB에서 특히 위험합니다.

## 8. 정리 — 한 페이지의 인생

### 핵심 통찰

- **DB는 행 단위가 아니라 페이지 단위로 일한다.** 한 행을 가져오려고 해도 페이지 단위로 buffer pool에 올라옵니다 (실제 물리 IO는 OS와 스토리지 계층에 따라 다른 단위로 처리될 수 있고, buffer pool hit 시 디스크 IO 자체가 발생하지 않음).
- **IO가 OLTP의 주요 병목**: 메모리 대비 자릿수 차이. random IO는 SSD 내부 병렬성과 prefetch 캐시를 깨뜨려 sequential보다 훨씬 비싸요. IO 최적화는 기본 전제고, 그 위에 CPU·lock·network 같은 다른 차원이 쌓입니다.
- **Heap은 실제 데이터, Index는 페이지 집합 축소 도구**: 인덱스의 본질은 IO를 없애는 게 아니라 *필요한 페이지 집합을 극단적으로 줄이는 것*. 둘 다 페이지로 저장되지만 역할이 달라요.
- **B+Tree가 인덱스의 사실상 표준**: 노드 크기를 페이지 크기에 맞춰 설계 — 트리 탐색 한 단계 = 디스크 페이지 접근 한 번. fanout이 100~300으로 커서 트리가 얕고, leaf 좌우 링크로 range query 효율.
- **Buffer pool이 진짜 성능을 결정한다**: PostgreSQL `shared_buffers`, InnoDB `innodb_buffer_pool_size`. 자주 접근되는 페이지가 캐시에 머물면 물리 디스크 IO 자체가 일어나지 않아요.
- **Clustered Index는 PostgreSQL과 InnoDB를 결정적으로 다르게 만든다**: 모든 인덱스 동작과 PK 선택 가이드라인이 여기서 갈려요.
- **`SELECT *`는 컬럼 수와 IO가 1:1 비례하지는 않지만**, TOAST chunk 추가 IO + Index-Only Scan 기회 상실 + 네트워크 전송량 증가로 결과적으로 IO를 늘리는 경우가 많습니다.

> 결국 스토리지 내부의 핵심 설계 결정은 **얼마나 적은 페이지 접근으로 답을 만들 것인가** 라는 한 가지 질문으로 수렴해요. 페이지를 어떻게 쪼갤지, 인덱스를 어떻게 만들지, PK를 무엇으로 할지 — 거의 모든 선택이 **페이지 접근 횟수와 그것이 캐시에 머물 확률** 로 평가됩니다. 다른 차원(CPU, lock, network)은 그 위에 쌓여요.

## 다음 편 예고

이 시리즈가 다룰 후속 주제들:

- **B+Tree 깊게**: 노드 분할, fanout 계산, 트리 깊이 추정, fillfactor
- **HOT Update와 Visibility Map**: PostgreSQL이 인덱스 갱신을 피하는 메커니즘
- **Row Store vs Column Store**: OLTP와 OLAP의 물리 구조 차이
- **Index 종류**: Hash, GIN, GiST, BRIN — B+Tree 외의 선택지

## 참고 (1차 자료 우선)

- [PostgreSQL Documentation — Database Page Layout](https://www.postgresql.org/docs/current/storage-page-layout.html) — 페이지 헤더, line pointer, tuple 구조 공식 명세
- [MySQL 8.4 Reference — Clustered and Secondary Indexes](https://dev.mysql.com/doc/refman/8.4/en/innodb-index-types.html) — InnoDB의 PK 기반 clustered index 공식 설명
- [Jeremy Cole — B+Tree index structures in InnoDB](https://blog.jcole.us/2013/01/10/btree-index-structures-in-innodb/) — InnoDB 페이지 내부 구조 분석의 고전
- [boringSQL — Inside PostgreSQL's 8KB Page](https://www.boringsql.com/posts/inside-postgresql-8kb-page/) — PostgreSQL 페이지 구조의 실증 분석
- [Stormatics — PostgreSQL Internals: Page Structure](https://stormatics.tech/blogs/postgresql-internals-page-structure) — 페이지 헤더 필드별 의미
- Hellerstein, Stonebraker, Hamilton — *Architecture of a Database System* (2007) — DB 시스템 구조의 표준 참고자료
- [CMU 15-445 Database Systems 강의](https://15445.courses.cs.cmu.edu/) — Storage, Indexes 모듈

<!-- EN -->

## 0. Introduction

If the [ACID series](/blog/theory/transaction-acid-01-atomicity) covered the *semantics* of transactions, this series covers **how data actually lives on disk.** Every row, every index entry, every WAL record a transaction touches is ultimately stored and read in units of **pages**.

The core message of this post: **"DBs do not work in rows — they work in pages."** Even when you run a single-row SELECT or UPDATE, the DB manages and accesses data page by page. Indexes are stored in pages, the heap is stored in pages. That said, real physical I/O can be coalesced into larger units or split into smaller blocks by the OS and storage stack — understanding this layered abstraction is what decides *why some queries are fast and others are slow.*

## 1. Why You Need to Know Storage Internals

If your only answer to *"why is this query slow?"* is *"there is no index,"* the next question follows: *"OK, why does an index make it faster?"* The depth shows up here.

The real answer: a full scan touches **N pages** logically (in practice OS readahead bundles them into efficient sequential reads, but the count is still N), while an index scan reaches the answer in **as few page touches as the tree depth (typically 3-4).** Giving that answer requires knowing what pages are, what I/O is, and what data structure an index is.

This post covers that base.

## 2. Row, Row ID (Tuple ID)

### Rows are what we see

```sql
SELECT id, name, salary FROM employees WHERE id = 40;
```

When we write this, we picture a **logical row** — one row with `id=40`, containing `name` and `salary`. Clean.

### Row ID — the identifier the DB uses internally

But the DB does not use the PK we defined (`id`) directly — internally it uses **a separate identifier that points to a row's physical location**, combining a **page number + a slot inside the page**.

| DB | Internal row identifier | Structure |
|---|---|---|
| PostgreSQL | **CTID** (Tuple ID) | (page number, line-pointer index inside the page) — e.g., `(0, 1)` |
| MySQL InnoDB | (when a clustered index is used) the PK itself acts as the identifier | If no PK, InnoDB auto-generates a 6-byte hidden GEN_CLUST_INDEX row ID |
| Oracle | **ROWID** | file + block + row slot |

In PostgreSQL, every index type (B-tree, Hash, GIN, GiST, BRIN, etc.) ultimately points to a **CTID** — meaning every index is a secondary index (there is no clustered index per se). In MySQL InnoDB, the PK *is* the clustered index, and secondary indexes store **the PK value** (not a physical address like CTID). If an InnoDB table has no PK, the first NOT NULL UNIQUE index becomes the clustered index; if there is none of those either, InnoDB auto-generates a 6-byte hidden row ID (GEN_CLUST_INDEX) — meaning **InnoDB tables always have a clustered index.** This difference makes the two DBs behave decisively differently — see Section 7 below.

> **Section 2 takeaway** — The PK we see and the row identifier the DB uses internally can differ. PostgreSQL always separates them via CTID; InnoDB uses the PK itself as the identifier.

## 3. Page — The Unit the DB Works In

### What a page is

> **Page**: the fixed-size unit the DB reads and writes to disk. PostgreSQL default 8KB, MySQL InnoDB default 16KB.

The key word is **"fixed size."** The DB does not read just one row — it reads **page by page.** A SELECT for one row pulls one page (8KB or 16KB) into the buffer pool, and any other 100 rows on that page come along. But **reading from disk** and **fetching from buffer pool** are different — a page already in memory is served without disk I/O. *"Page-granular access"* is always true; *"does disk I/O happen?"* depends on buffer-pool hits.

### Why pages instead of rows

This comes from the **nature of the disk.** RAM allows byte-granular addressing (random access), so *"give me 1 byte at address 0x1234"* is natural. Disks do not work that way — HDDs have rotational and head-movement costs, and SSDs read/write in pages (typically 4KB) too. Even for one byte you must read at least one block.

DBs operate on top of this reality, so they impose **a larger abstraction called the page.** One I/O brings up one page (a bundle of rows) at once.

### Physical location of a page = block number inside a file

In PostgreSQL — each table has a data file on disk, divided into 8KB blocks. Block numbers start at 0 and increase sequentially. When a row is added and the last block fills up, a new block is appended at the end of the file.

InnoDB is similar but with 16KB pages and B+Tree nodes (= pages) linked in PK order.

### Inside a page (PostgreSQL 8KB)

![PostgreSQL Page Layout — Slotted Page](/uploads/theory/db-storage/page-layout.svg)

Key points:

- The **Line Pointer array (top of the page)** stores each row's offset and length. The second number in a CTID is this line-pointer index.
- The **Tuple data (bottom of the page)** grows upward. The free space between the bottom of the line pointers and the top of the tuples is where new rows go.
- For index pages, the **Special Space** holds metadata like sibling-page links.

This line-pointer indirection lets PostgreSQL move rows within a page (VACUUM, defragmentation, HOT update). Since indexes point to line pointers, moving rows within a page does not break the indexes.

> **Section 3 takeaway** — A page is the DB's logical minimum I/O unit (PG 8KB, InnoDB 16KB). A page contains many rows, and the line-pointer array points to each row's location. Disk-based RDBMSs do not read one row at a time — they work in pages. Real physical I/O may be larger via OS readahead (PostgreSQL 18's `io_combine_limit` defaults to 128KB = 16 pages) or smaller via the SSD/filesystem 4KB blocks.

## 4. I/O — The Cost to Reduce

### I/O = a disk read/write request

> **I/O**: a single read or write request to disk. From the DB's perspective the request is page-granular, but real physical I/O can be larger or smaller.

To be precise — a DB page is a **logical unit**, while the physical I/O unit is determined by several layers of abstraction:

- **DB page**: PostgreSQL 8KB, InnoDB 16KB (logical, the buffer-pool unit)
- **OS page / filesystem block**: typically 4KB (Linux ext4/XFS default)
- **SSD sector**: typically 4KB (HDD is 512B or 4KB)
- **Actual I/O request size**: OS readahead, sequential prefetch, PostgreSQL 18's `io_combine_limit` (default 128KB = 16 data pages), and so on may bundle into much larger units

So *"DB page = I/O unit"* holds only at the DB-abstraction level. **Real physical I/O count and size depend on the OS, filesystem, and storage layer.**

### Why I/O is expensive

Even with all these layered abstractions, the real expense is the disk itself. Order-of-magnitude comparison: CPU cycle ~0.3ns, RAM access ~100ns, NVMe SSD random read ~10-100μs (high device variance), HDD random read ~5-15ms — 100x to 100,000x slower than RAM. Same orders-of-magnitude story as in [Part D](/blog/theory/transaction-acid-04-durability).

So **I/O is the primary bottleneck for most OLTP workloads** — short transactions + small result sets + disk access patterns dictate performance. Not all workloads though — complex aggregations may be CPU-bound, highly concurrent systems hit lock contention, distributed systems hit network latency. I/O optimization is the baseline; other dimensions stack on top.

### Ways to reduce I/O

1. **Use indexes to fetch only the right pages** — 1-3 page I/Os instead of a full scan.
2. **Lean on the OS page cache** — frequently-read pages stay in memory, served without disk I/O.
3. **Use sequential I/O** — for both HDD and SSD, sequential is much faster than random. Why: HDDs avoid head-movement and rotational latency; SSDs leverage internal channel parallelism and prefetch-cache efficiency. Random I/O breaks all of these mechanisms, which is why it is expensive. A full scan is sequential and is unexpectedly efficient in many cases.
4. **Increase data density per page** — smaller rows mean more rows per page, and less I/O.

> The folk wisdom *"SELECT \* is expensive"* has a more nuanced mechanism. Since the DB works in pages, column count does not scale 1:1 with I/O — `SELECT name` still pulls in the whole heap page containing the row. But there are paths where `SELECT *` does increase I/O:
>
> - **TOAST / out-of-line extra I/O** — PostgreSQL stores large column values (text/JSON/bytea over ~2KB) in a separate TOAST table and keeps only a pointer in the main row. Notably, if you do not select the TOASTed columns, PostgreSQL just ignores the pointer — no extra I/O (per official docs and empirical analyses). With `SELECT *` it follows every TOAST pointer and reads chunks, so per row, dozens of extra I/Os may accumulate per large value.
> - **Lost Index-Only Scan opportunity** — when only a few columns are needed, the index alone can answer; `*` forces heap access.
> - **Increased network bytes + serialization cost** — bytes shipped to the client and row-reconstruction overhead.
>
> So at the page-I/O level, column count looks irrelevant, but considering TOAST and covering indexes, `SELECT *` often does increase I/O.

> **Section 4 takeaway** — I/O is orders of magnitude slower than memory. It is the main OLTP bottleneck, and indexes / cache / page density are the core tools to reduce it.

## 5. Heap — Where the Actual Data Lives

### Definition

> **Heap**: the collection of pages that hold the table's actual row data. Generally stored without any order (close to insertion order).

Every PostgreSQL table is a heap by default. **InnoDB is not a heap — its table itself is a clustered index sorted by PK** (the decisive difference between the two DBs).

### Heap properties

- **Unordered**: PostgreSQL heap stores rows close to insertion order (UPDATE/DELETE/VACUUM may reuse free space, so it is not perfectly sorted).
- **Fast INSERT**: append the new row to the free space of the last page.
- **Slow lookup**: finding a specific value requires scanning every page — this is a **sequential scan / full scan**.

### Full Scan cost

10,000 employees, PostgreSQL default 8KB pages, ~100 rows per page → **100 pages** to access. Finding a single employee with `ID = 9999` reads all 100 pages. That said, this is sequential access, so OS readahead bundles many pages, reducing the physical I/O count — that is why full scans are unexpectedly efficient (especially for small tables or queries with many result rows). But reading 100 pages to find one row is orders of magnitude more expensive than an index lookup that touches just a few pages.

> **Section 5 takeaway** — The heap is the page collection holding the actual data. INSERTs are fast, but value lookups need a full scan and are inefficient (especially when result rows are few). That is why we need indexes.

## 6. Index — The Data Structure That Tells You the Right Pages

Through Section 5 we have established that *"the DB works in pages."* A full scan must traverse all pages, so it is expensive. The natural follow-up — *"how do we reach the data with as few pages as possible?"* The structure that solves this is the index.

### Definition

> **Index**: a separate data structure that lets you quickly find which page in the heap contains which value. Usually implemented as a B+Tree.

The essence of an index is **not eliminating I/O but radically shrinking the set of pages you need to touch.** The index itself is also a collection of disk-resident pages, and index lookups also cause I/O — they just turn the problem of *touch N pages* into *touch a few pages*.

### B+Tree structure

A B+Tree is a kind of balanced tree and the de facto standard for RDBMS indexes.

![B+Tree — node = one page, fanout 100~300](/uploads/theory/db-storage/btree.svg)

Key properties:

- **Keys are sorted** — smaller to the left, larger to the right.
- **All data lives in leaves** — internal nodes only guide the path.
- **Leaves are doubly linked** — range queries (`BETWEEN`, `>`, `<`) are efficient; once you reach a leaf, walk to its sibling.
- **Balanced** — depth is the same to every leaf. Always O(log N) lookup.

### B+Tree's I/O efficiency

Each node = one page (PG 8KB, InnoDB 16KB). Hundreds of keys fit in one page, so the **fanout (branching factor) is large.** Per academic and empirical sources, fanout is typically **100~300** (depends on key size and fill factor — at fill factor 67%, average fanout is about 2/3 of the max). With this fanout, **even tables with hundreds of millions of rows are reachable at depth 3-4** — e.g., at fanout 133, depth 4 covers about 300 million leaf pages. Smaller keys give larger fanout (shallower tree); larger keys (long strings, composite keys) reduce fanout (deeper tree).

> **Why a large fanout matters**: larger fanout → shallower tree → fewer page touches per lookup. This is the essential reason B+Tree became the standard index — a disk-friendly, shallow tree. The orders-of-magnitude difference vs full scan (N page touches) is built right here.
>
> More fundamentally: **B+Tree was designed with node size matched to page size.** Unlike a binary search tree with one key per node, a B+Tree node = one page (8KB/16KB) = hundreds of keys. As a result, **one tree-traversal step = one disk-page access** falls out naturally. The data structure and the I/O pattern are bundled into one unit — that is the real reason B+Tree became the standard index of the disk era.

Furthermore, real-world performance is dominated less by logical page-touch count and more by the **buffer-pool hit rate.** PostgreSQL's `shared_buffers` (+ OS page cache) and InnoDB's `innodb_buffer_pool_size` define the memory area where frequently-accessed pages stay; physical disk I/O does not happen at all. That is why upper-level index nodes (root, internal) almost always live in cache, and why real disk I/O for an index lookup is even less than the theoretical count.

### Index lookup in two steps — Index + Heap

PostgreSQL (the most common pattern):

1. **Index search**: walk the B+Tree down to a leaf → find the key → get the CTID (`(page, slot)`) stored at the leaf. In theory this is tree-depth I/Os (typically 3-4), but upper nodes (root, internal) are almost always in the OS page cache, so real disk I/O is often just 1-2 leaf reads.
2. **Heap access**: do an I/O on the heap page the CTID points to and fetch the full row. 1 I/O.

Total real I/O: **2~3**. Compared to a full scan (N), an order-of-magnitude difference.

### Index-Only Scan (bonus)

If the query needs only columns present in the index, the heap-access step is skipped. Example: with `idx(id, name)` and `SELECT name FROM t WHERE id = 40`, the index alone answers.

PostgreSQL's Index-Only Scan is **conditional on the Visibility Map** — because of MVCC, the page must be marked *"all rows visible to everyone"* for the heap access to be skipped. (Detailed in a later post in this series.)

> **Section 6 takeaway** — An index is a separate B+Tree structure. With large fanout the tree is shallow, and lookups end with about as many page touches as the tree depth (typically 3-4; cache makes real disk I/O even less). PostgreSQL typically does index→heap in two steps, but an Index-Only Scan or cache hit can skip the heap access.

## 7. Clustered Index vs Secondary Index — The Decisive Difference Between PostgreSQL and InnoDB

This is the largest physical-structure difference between the two DBs.

![PostgreSQL vs InnoDB — the decisive difference between Index and Heap](/uploads/theory/db-storage/clustered-vs-secondary.svg)

### Clustered Index

> **Clustered Index**: the table itself, sorted by a specific key. The leaf nodes contain entire rows.

### Secondary Index

> **Secondary Index**: a separate B+Tree whose leaves store key + row identifier only. The actual data lives elsewhere (heap or clustered index).

### PostgreSQL — every index is a secondary

PostgreSQL has no clustered index (in the InnoDB sense). The table is always a heap (an unordered collection of pages), and every index is a separate B+Tree storing key + CTID. PostgreSQL has a `CLUSTER` command, but it is a **one-shot physical reordering** — subsequent INSERTs/UPDATEs do not maintain the order. Different from InnoDB's *continuously-maintained* clustered index.

```
[Index B+Tree leaf]: (key=40, ctid=(1,4))
                            ↓
[Heap page 1]: ... slot 4 = {id:40, name:..., salary:...}
```

- **Pro**: all indexes are equal. Changing the PK has no impact on other indexes.
- **Con**: typically requires two-step I/O, index → heap (unless an Index-Only Scan applies or the heap page is already in shared buffers, in which case heap I/O is skipped). Every index must be updated on UPDATE (HOT update can skip some — covered later).

### MySQL InnoDB — PK is the clustered, secondary points to PK

The InnoDB table itself is a B+Tree sorted by PK. The PK B+Tree's leaves contain **whole rows.**

```
[Clustered Index leaf]: (id=40, {name:..., salary:...})  ← the row itself
```

A secondary index leaf stores secondary key + PK only. To get the actual row, you look up the clustered index again with the PK.

```
[Secondary Index leaf]: (name='Alice', id=40)
                                ↓ PK lookup
[Clustered Index leaf]: (id=40, {name:..., salary:...})
```

- **Pro**: PK lookup is one step — one clustered-index trip and you have the row.
- **Con**: Using a secondary index is two steps (secondary → clustered). And **a long PK bloats every secondary index** (the PK value is duplicated in every leaf).

### Why a UUID PK is dangerous in InnoDB

In InnoDB, the PK is not just an identifier — it is the value that **decides the physical placement of data.** Since clustered index = the table itself, the PK value determines where on disk the row goes. Through that lens, a random UUID PK means:

- Every INSERT goes to a random page → **frequent page splits.**
- Each new row lands on a different page → **lower cache hit rate.**
- Frequent splits accumulate **fragmentation, and disk usage grows.**

Solution: **time-sortable IDs** (UUIDv7, ULID, snowflake) or a separate auto-increment PK + UUID as a unique secondary index.

PostgreSQL has no clustered index, so this problem is fundamentally smaller — even with a UUID PK, INSERTs largely follow a pattern of appending to the last heap page. It is not a perfectly sequential append, though — UPDATE/DELETE/VACUUM-created free space may be reused (via FSM, the Free Space Map), and depending on `fillfactor`, subsequent changes may go onto the same page. Still, rows do not get scattered to random positions based on the PK value as in InnoDB. Meanwhile a unique B+Tree index on the PK itself does exist, so its page-split / fragmentation cost happens just like in InnoDB. The decisive difference is that **the heap itself is not split based on PK values.**

> **Section 7 takeaway** — PostgreSQL: every index is secondary, the heap is unordered. InnoDB: the PK is clustered, secondary indexes point to the PK. UUID PKs are particularly dangerous in InnoDB.

## 8. Wrap-up — A Page's Life

### Key insights

- **DBs do not work in rows — they work in pages.** Even one row pulls a page-sized chunk into the buffer pool (real physical I/O may be at a different unit depending on the OS/storage stack, and on a buffer-pool hit no disk I/O happens at all).
- **I/O is the primary OLTP bottleneck**: orders of magnitude slower than memory. Random I/O breaks SSD internal parallelism and prefetch caches, making it much more expensive than sequential. I/O optimization is the baseline; other dimensions (CPU, lock, network) stack on top.
- **Heap is the actual data; Index is the page-set-shrinking tool**: the essence of an index is *not eliminating I/O but radically reducing the page set you must touch.* Both are stored as pages but play different roles.
- **B+Tree is the de facto standard index**: node size matched to page size — one tree-step = one disk-page access. Fanout 100~300 keeps the tree shallow, and leaf doubly-linked lists make range queries efficient.
- **Buffer pool decides real performance**: PostgreSQL `shared_buffers`, InnoDB `innodb_buffer_pool_size`. Frequently-accessed pages staying in cache means physical disk I/O does not happen at all.
- **The clustered-index difference makes PostgreSQL and InnoDB decisively different**: every index behavior and PK choice guideline diverges from here.
- **`SELECT *` does not scale 1:1 with column count for I/O**, but TOAST chunk extra I/O + lost Index-Only Scan + increased network bytes mean it often does increase I/O in practice.

> Storage internals' core design question converges to one thing: **how few page touches does it take to produce the answer?** How to split pages, how to build indexes, what to use as PK — almost every decision is evaluated by **page-touch count and the probability that those pages are in cache.** Other dimensions (CPU, lock, network) stack on top.

## What's Next in the Series

Upcoming topics:

- **B+Tree, deeper**: node splits, fanout calculations, depth estimation, fillfactor
- **HOT Update and Visibility Map**: how PostgreSQL avoids index updates
- **Row Store vs Column Store**: the physical-structure split between OLTP and OLAP
- **Index types**: Hash, GIN, GiST, BRIN — alternatives to B+Tree

## References (Primary Sources First)

- [PostgreSQL Documentation — Database Page Layout](https://www.postgresql.org/docs/current/storage-page-layout.html) — official spec for page header, line pointers, tuple structure
- [MySQL 8.4 Reference — Clustered and Secondary Indexes](https://dev.mysql.com/doc/refman/8.4/en/innodb-index-types.html) — official explanation of InnoDB's PK-based clustered index
- [Jeremy Cole — B+Tree index structures in InnoDB](https://blog.jcole.us/2013/01/10/btree-index-structures-in-innodb/) — classic analysis of InnoDB page internals
- [boringSQL — Inside PostgreSQL's 8KB Page](https://www.boringsql.com/posts/inside-postgresql-8kb-page/) — empirical analysis of PostgreSQL page structure
- [Stormatics — PostgreSQL Internals: Page Structure](https://stormatics.tech/blogs/postgresql-internals-page-structure) — meaning of each page-header field
- Hellerstein, Stonebraker, Hamilton — *Architecture of a Database System* (2007) — standard reference on DB system architecture
- [CMU 15-445 Database Systems course](https://15445.courses.cs.cmu.edu/) — Storage and Indexes modules

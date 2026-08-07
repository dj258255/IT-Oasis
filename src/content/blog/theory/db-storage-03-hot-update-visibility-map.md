---
title: 'DB 스토리지 내부 ③: HOT Update와 Visibility Map'
description: PostgreSQL UPDATE는 MVCC 구현 특성상 write amplification이 발생할 수 있습니다. HOT(Heap-Only Tuple) Update가 조건부로 인덱스 갱신을 회피하고, Visibility Map이 조건부로 Index-Only Scan을 가능하게 합니다. fillfactor와 autovacuum, 인덱스 컬럼 설계가 그 조건을 만족시키는 실무적 지렛대입니다.
date: 2026-04-21T00:00:00.000Z
tags:
  - Database
  - Storage
  - PostgreSQL
  - MVCC
  - HOT Update
  - Visibility Map
  - VACUUM
  - Index-Only Scan
  - autovacuum
category: theory/Database
draft: false
coverImage: "/uploads/theory/db-storage/cover-3.svg"
series: "DB 스토리지 내부"
seriesOrder: 3
---

## 0. 들어가며

스토리지 시리즈 3편입니다. [1편](/blog/theory/db-storage-01-heap-page-index)에서 페이지·힙·인덱스·B+Tree를 다뤘고, [2편](/blog/theory/db-storage-02-row-vs-column)에서 row store와 column store의 트레이드오프를 풀었다면, 이번 편은 한 단계 안쪽으로 들어가 *"PostgreSQL이 어떻게 자기 자신의 비용을 줄이는가"*를 봅니다.

[ACID ① 편(Atomicity)](/blog/theory/transaction-acid-01-atomicity)에서 다룬 MVCC와 [스토리지 1편](/blog/theory/db-storage-01-heap-page-index)의 Heap·Index가 만나는 지점에서, UPDATE가 만드는 비용과 PostgreSQL이 그 비용을 피하기 위해 만든 두 가지 메커니즘 **HOT(Heap-Only Tuple) Update와 Visibility Map**을 풀어봅니다.

핵심 메시지는 이렇습니다. **PostgreSQL의 UPDATE는 MVCC 구현 특성상 write amplification이 발생할 수 있습니다.** 새 row version 생성과 모든 인덱스 갱신이 따라올 수 있기 때문입니다. HOT update는 조건부로 인덱스 갱신을 회피하고, Visibility Map은 조건부로 Index-Only Scan을 가능하게 합니다. 두 메커니즘 모두 MVCC가 만든 비용을 *조건이 맞을 때* 상쇄하는 설계이고, fillfactor와 autovacuum 튜닝, 인덱스 컬럼 설계는 이 조건을 만족시키는 실무적 지렛대입니다.

![HOT Update와 Visibility Map 시리즈 커버](/uploads/theory/db-storage/cover-3.svg)

> **글의 범위**: WAL/checkpoint/replication 등 인접 주제는 HOT과 VM의 동작·실패 모드를 이해하는 데 필요한 범위까지만 짧게 다룹니다. 각 주제의 깊이 있는 다이브는 [ACID ④ 편(Durability + WAL 흐름)](/blog/theory/transaction-acid-04-durability)을 참고하면 됩니다.

## 1. PostgreSQL UPDATE의 잠재 비용: Write Amplification

### MVCC가 만든 비용

[ACID ① 편](/blog/theory/transaction-acid-01-atomicity)에서 봤듯, PostgreSQL은 MVCC를 **새 row version 생성** 방식으로 구현합니다. UPDATE는 제자리 수정이 아니라 *새 튜플 삽입과 옛 튜플을 dead로 표시*하는 작업이 따라옵니다. CYBERTEC의 표현을 빌리면 *"DELETE + INSERT와 크게 다르지 않다"*입니다.

### 잠재 비용: Write Amplification

문제는 튜플 하나가 아닙니다. 인덱스가 N개 걸려있고 HOT이 적용되지 않는 경우, UPDATE 한 번에 새 튜플의 새 위치(CTID)를 가리키도록 인덱스도 N번 갱신해야 합니다. 이게 Write Amplification의 logical 측면입니다. 추가로 디스크 측면에서는 WAL 기록과 fsync로 인한 동기화 비용도 latency 변동에 기여합니다 ([ACID ④ 편](/blog/theory/transaction-acid-04-durability) 참고).

10개 인덱스가 걸린 테이블에서 non-indexed 컬럼 하나만 UPDATE해도, HOT이 적용되지 않는 경우 다음이 다 일어납니다:

1. Heap에 새 튜플 1개 작성
2. 옛 튜플을 dead로 표시
3. 인덱스 10개 갱신 (옛 위치 → 새 위치로)
4. WAL 레코드 추가
5. 옛 인덱스 엔트리들은 나중에 VACUUM이 와야 정리됨

심지어 **변경하지 않은 인덱스 컬럼까지 다 갱신**해야 합니다. 인덱스가 가리키는 행 위치(CTID)가 바뀌었기 때문입니다. 이게 cold update의 비용이고, HOT update가 이를 조건부로 회피하는 메커니즘입니다 (다음 장에서 다룹니다).

![Cold Update vs HOT Update: UPDATE 한 번이 만드는 IO의 차이](/uploads/theory/db-storage/cold-vs-hot-update.svg)

### Bloat: UPDATE가 만드는 부산물

UPDATE가 누적되면 dead tuple이 쌓입니다(같은 행이라도 옛 버전이 페이지에 남아있음). 이게 bloat입니다:

- **Storage bloat**: 디스크 사용량 증가 (실제 활성 데이터의 몇 배)
- **Read amplification**: Sequential Scan이 dead tuple까지 읽음 → 쿼리 느려짐
- **Index bloat**: 인덱스도 옛 위치 엔트리들이 누적됨

Uber가 2016년 PostgreSQL에서 MySQL로 이주한 사례가 이 write amplification과 bloat 이슈를 널리 알린 계기였습니다. 다만 Uber의 이주는 write amplification 단일 원인이 아니라 replication 모델, 인덱스 동작, OS 페이지 캐시 활용 등 복합적 이유였고, PostgreSQL 커뮤니티의 반박도 있었습니다. 그럼에도 메커니즘 자체는 실재하고, 고-update 워크로드에서 무시할 수 없는 비용입니다.

> **1장 요약**: PostgreSQL UPDATE는 cold update 시 새 튜플 생성과 모든 인덱스 갱신으로 write amplification이 발생할 수 있고, 누적되면 bloat가 됩니다. 이 비용을 조건부로 줄이는 두 가지 메커니즘이 HOT Update와 Visibility Map입니다.

## 2. HOT Update: 조건부로 인덱스 갱신을 피하는 메커니즘

### 핵심 통찰

> 만약 변경된 컬럼이 어떤 인덱스에도 포함되지 않는다면, 인덱스는 옛 위치만 알고 있어도 충분하다. 행 자체는 같은 행이고, 인덱스 키는 변하지 않았으므로.

이 통찰이 **HOT(Heap-Only Tuple) Update**의 출발점입니다. 인덱스 갱신을 완전히 건너뛸 수 있다면 write amplification의 주요 부분(인덱스 N개 갱신)이 사라집니다. 다만 HOT에서도 *새 튜플 생성과 WAL 기록*은 여전히 발생합니다. **완전히 zero가 되는 게 아니라 대폭 감소하는 것**입니다.

### HOT Update의 두 조건 (PostgreSQL 공식 문서)

PostgreSQL이 HOT update를 적용하는 조건은 정확히 두 가지입니다:

1. **변경된 컬럼이 어떤 인덱스에도 포함되지 않는다** (BRIN 같은 summarizing index 제외).
2. **새 튜플이 옛 튜플과 같은 페이지에 들어갈 free space가 있다.**

두 조건 모두 충족되면 **HOT Update**입니다. 인덱스 갱신 없이 같은 페이지 안에서만 변경합니다.

하나라도 어기면 **일반 UPDATE("cold update")**입니다. 모든 인덱스를 갱신하고 dead tuple로 인한 bloat가 누적됩니다.

특히 1번 조건은 이진법입니다. *인덱스 컬럼 하나만 변경되어도 HOT은 즉시 불가능*합니다. 예를 들어 10개 컬럼 중 9개는 non-indexed인데 1개만 indexed인 컬럼을 같이 update하면 그 한 컬럼 때문에 모든 인덱스가 갱신됩니다. 그래서 *어떤 컬럼이 indexed인가*가 HOT 성공률을 결정적으로 좌우합니다.

2번 조건도 조용히 깨질 수 있습니다. 새 row가 옛 row보다 커지면 같은 페이지에 못 들어가서 HOT이 실패합니다. 짧은 문자열이 긴 문자열로 update되거나, NULL이었던 컬럼에 값이 들어가면 row 크기가 늘어납니다. 더 까다로운 케이스도 있습니다. 컬럼이 TOAST 임계값(보통 ~2KB)을 넘으면 별도 TOAST 테이블로 이동하면서 row 헤더가 변형되고, 이 과정에서 같은 페이지 유지가 깨질 수 있습니다. 즉 HOT은 **데이터 크기 안정성**도 전제로 합니다. 가변 길이 컬럼이 자주 늘어나는 워크로드에서는 fillfactor를 충분히 낮춰도 HOT 비율이 떨어질 수 있습니다.

### HOT chain: 같은 페이지 안의 버전 체인

HOT update가 일어나면 페이지 안에 다음 구조가 만들어집니다:

![HOT Chain: Index에서 LP 1, Tuple을 거쳐 t_ctid 따라 최신 버전으로](/uploads/theory/db-storage/hot-chain.svg)

핵심:

- 인덱스는 **Line Pointer 1만 가리킵니다.** Tuple 1, Tuple 2 어느 것도 직접 가리키지 않습니다.
- Tuple 1은 `HEAP_HOT_UPDATED` 플래그로 표시되어 *"나는 옛 버전이고 t_ctid를 따라가면 새 버전이 있다"*고 알립니다.
- Tuple 2는 `HEAP_ONLY_TUPLE` 플래그로 *"나는 인덱스에서 직접 가리키지 않는 튜플이다"*고 알립니다.
- Index Scan은 Line Pointer 1에서 Tuple 1로, t_ctid를 따라 Tuple 2를 찾습니다.

여러 번 HOT update되면 하나의 인덱스 엔트리에서 여러 dead 튜플을 거쳐 live 튜플에 도달하는 **HOT chain**이 길어집니다. Chain이 길수록 tuple에서 t_ctid를 따라 다음 tuple로 가는 pointer chasing 비용이 누적됩니다(같은 페이지 안이라 디스크 IO는 없지만 CPU/메모리 접근 차원의 누적 비용이 발생). 그래서 *"왜 HOT chain이 길어지면 느려지죠?"*의 답이 여기 있습니다. pruning이 chain을 적시에 정리해주지 않으면 read 비용이 점진적으로 증가합니다.

### HOT pruning: VACUUM 없이 청소하는 메커니즘

HOT chain이 길어지면 읽기 비용이 쌓입니다. 그래서 PostgreSQL은 기회가 될 때마다(opportunistic) HOT chain을 정리합니다:

- **누가 정리하나**: SELECT 같은 일반 쿼리도 페이지 접근 시 HOT pruning을 트리거할 수 있습니다 (VACUUM만이 아님). 다만 이는 opportunistic execution이고 항상 보장되지는 않습니다. 페이지가 prunable한 상태이고 잠금을 획득할 수 있을 때만 일어납니다.
- **무엇을 정리하나**: Chain의 중간 dead 튜플을 제거합니다. Line pointer 1은 redirect pointer로 변환되어 최신 live 튜플을 직접 가리키게 됩니다.
- **결과**: 인덱스는 여전히 line pointer 1만 가리키지만, 실제로는 redirect를 따라 최신 튜플로 도달합니다. 페이지 안의 공간이 재활용 가능해집니다.

이 메커니즘 덕분에 *HOT update와 HOT pruning*이 잘 돌아가면 VACUUM의 부담이 크게 줄어듭니다. 다만 **pruning은 VACUUM을 대체하지 않습니다**. Pruning은 page-level cleanup (한 페이지 안의 dead tuple 정리)에 그치고, VACUUM은 visibility map 갱신, XID freezing, FSM 정리, 인덱스 정리 등 시스템 차원의 유지보수를 담당합니다. Pruning이 활발해도 VACUUM은 여전히 주기적으로 돌아야 합니다.

### Fillfactor: HOT을 돕는 지렛대

HOT의 두 번째 조건은 *같은 페이지에 free space*가 있는 것입니다. 그런데 PostgreSQL의 페이지는 기본적으로 100% 채웁니다. 그래서 페이지가 가득 차면 HOT이 안 됩니다.

해결책은 **Fillfactor 설정**입니다. 페이지를 처음 채울 때 몇 %까지만 채우도록 지정해, update 여유 공간을 남겨둡니다. 권장값(업계 통용):

| 워크로드 | Fillfactor |
|---|---|
| 고-update (세션, 카운터) | 70 |
| 중간 (사용자 프로필) | 80~85 |
| 거의 read-only (상품 카탈로그) | 95 |
| Append-only (로그) | 100 |

```sql
ALTER TABLE sessions SET (fillfactor = 70);
```

### HOT update 모니터링

```sql
SELECT relname, n_tup_upd, n_tup_hot_upd,
       round(100.0 * n_tup_hot_upd / NULLIF(n_tup_upd, 0), 2) AS hot_ratio
FROM pg_stat_user_tables
WHERE n_tup_upd > 0
ORDER BY hot_ratio ASC;
```

목표는 `hot_ratio` **80% 이상**입니다. 80% 미만이면 fillfactor를 낮추거나 인덱스 컬럼 구조를 재검토합니다.

또한 HOT은 *UPDATE로 인한 index bloat*을 억제합니다. Cold update에서는 인덱스에 옛 위치와 새 위치 두 엔트리가 남고 옛 엔트리는 VACUUM이 와야 정리되지만, HOT update에서는 인덱스를 아예 안 건드리므로 *UPDATE 기인 dead index entry 자체가 생기지 않습니다*. 다만 INSERT 패턴으로 인한 index bloat(예: 정렬 깨짐에 따른 page split, 키 분포로 인한 fill ratio 저하)은 여전히 발생합니다. HOT은 UPDATE 차원만 다루는 메커니즘이지 모든 index bloat을 막는 만능 도구는 아닙니다.

> **2장 요약**: HOT update는 *변경 컬럼이 인덱스에 없고 같은 페이지에 free space가 있으면* 인덱스 갱신을 회피합니다. 결과적으로 write amplification 감소, index bloat 억제, VACUUM 부담 감소까지 연쇄적으로 좋아집니다. Fillfactor를 낮춰 HOT 가능성을 높이는 게 OLTP 튜닝의 핵심 기법입니다.

## 3. Visibility Map: Index-Only Scan을 가능하게 하는 메커니즘

### MVCC가 만든 또 다른 비용: Visibility 체크

PostgreSQL 인덱스에는 **visibility 정보가 없습니다**. 즉 인덱스에서 어떤 튜플을 찾아도, 그게 현재 트랜잭션에서 보여야 하는 버전인지 알려면 반드시 heap을 읽어야 합니다(튜플의 `xmin`/`xmax` 확인).

이게 [1편](/blog/theory/db-storage-01-heap-page-index)에서 *"PostgreSQL은 일반적으로 인덱스와 힙 2단계 IO"*라고 한 이유입니다. Index-Only Scan의 가능성을 열어주려면 *visibility 체크 없이도 안전한 페이지를 따로 표시*할 수 있으면 어떨까요?

### Visibility Map의 정의 (PostgreSQL 공식 문서)

> **Visibility Map (VM)**: 각 heap relation마다 별도 파일로 저장되는 비트맵. 각 heap 페이지마다 2비트를 갖는다.

- **첫 번째 비트 (all-visible)**: 이 페이지의 모든 튜플이 **현재와 미래의 모든 트랜잭션**에 보인다(공식 문서: *"visible to every current and future transaction"*). 즉 dead 튜플이 없어 어떤 스냅샷에서도 무조건 보이므로, visibility 체크를 건너뛰어도 안전하다.
- **두 번째 비트 (all-frozen, PostgreSQL 9.6+)**: 이 페이지의 모든 튜플이 frozen 상태여서, transaction wraparound VACUUM이 건너뛸 수 있다.

VM은 별도 파일에 저장됩니다 (`<relation_filenode>_vm`). PostgreSQL 8.4에서 도입됐습니다.

![Visibility Map: heap 페이지마다 2비트로 all-visible과 all-frozen 추적](/uploads/theory/db-storage/visibility-map-bits.svg)

### 비트가 보수적이라는 사실

VM의 비트는 **conservative이면서 transient**합니다:

- 비트 1은 "확실히 모든 튜플이 모두에게 보임"을 뜻합니다.
- 비트 0은 "그럴 수도 있고 아닐 수도 있음"을 뜻합니다 (즉 모를 때도 0).
- **write activity가 일어나면 즉시 0으로 clear됩니다**: 페이지에 INSERT/UPDATE/DELETE가 생기면 PostgreSQL이 자동으로 해당 페이지의 all-visible 비트를 끕니다. 다음 VACUUM이 다시 set 해줄 때까지 그 상태로 남습니다.

이 보수성이 정확성을 보장합니다. 비트 1을 잘못 신뢰하면 visibility 검증을 건너뛰는 게 위험하기 때문입니다. 동시에 *write activity가 활발한 테이블에서는 VM이 자주 stale 상태가 되어 IOS 효율이 떨어진다*는 의미이기도 합니다.

### Visibility Map의 두 가지 역할

#### 역할 1: Index-Only Scan 활성화

PostgreSQL 공식 문서가 명시하는 Index-Only Scan(IOS)의 조건은 **두 단계**입니다:

**1단계, Covering 조건 (인덱스 자체의 조건)**: 쿼리가 참조하는 모든 컬럼이 인덱스에 저장되어 있어야 합니다. 예를 들어 `SELECT id, name FROM t WHERE id = 5`라면 `(id, name)` 인덱스이거나, `id` 인덱스에 `INCLUDE (name)`가 있어야 합니다. 이게 *covering index* 개념입니다. 이 조건이 안 맞으면 인덱스만으로 답이 안 나오므로 IOS 자체가 불가능하고 일반 Index Scan으로 갑니다.

**2단계, Visibility 조건 (런타임)**: covering 조건이 충족되어 IOS가 물리적으로 가능해도, MVCC 때문에 각 행이 현재 트랜잭션 스냅샷에 보이는지 확인해야 합니다. 인덱스 엔트리에는 visibility 정보가 없으므로, 원래대로라면 매 행마다 heap을 읽어야 합니다. 여기서 VM이 등장합니다:

- 인덱스에서 후보 튜플 위치(CTID)를 찾습니다.
- VM에서 그 페이지의 all-visible 비트를 확인합니다:
  - **비트 = 1**이면 heap을 읽지 않고 인덱스 값만으로 답합니다. 진짜 Index-Only Scan입니다.
  - **비트 = 0**이면 heap을 방문해 visibility를 확인합니다. *즉 IOS plan으로 잡혔어도 실제로 heap fetch가 발생합니다.* `EXPLAIN (ANALYZE, BUFFERS)`의 `Heap Fetches`가 이 횟수를 보여줍니다.

핵심은 **IOS가 plan 단계에서 결정되고 런타임에 VM 체크로 heap 방문 여부가 갈린다**는 것입니다. 두 단계 모두 통과해야 진정한 IOS입니다. covering index가 없으면 IOS 자체가 불가능하고, covering index가 있어도 VM이 stale하면 일반 Index Scan과 비슷한 비용이 됩니다.

![Index-Only Scan은 covering 조건과 visibility 조건 두 단계를 모두 통과해야 진짜 IOS](/uploads/theory/db-storage/ios-two-stage.svg)

### 한 단계 더: VM 아래에 hint bits와 CLOG가 있다

VM all-visible 비트가 set되어 heap을 안 본다고 해도 PostgreSQL의 visibility 체크는 완전히 공짜가 아닙니다. 한 단계 더 들어가 봅니다:

- **CLOG (Commit Log, `pg_xact`)**: 모든 트랜잭션의 commit/abort 상태를 비트맵으로 저장합니다. 튜플의 `xmin`/`xmax`가 가리키는 트랜잭션이 커밋됐는지 실패했는지 알려면 원래 CLOG를 봐야 합니다.
- **Hint bits**: 튜플 헤더의 플래그입니다(`HEAP_XMIN_COMMITTED` 등). CLOG 조회 결과를 튜플에 캐시해 다음부터는 CLOG를 안 봐도 됩니다. 일반 SELECT가 튜플을 읽을 때 기회적으로 hint bits를 set합니다.

따라서 IOS의 정확한 비용 구조는 다음과 같습니다:

1. Covering 조건 통과로 IOS plan 확정
2. VM all-visible 비트 set으로 heap page를 안 봄 (페이지 차원)
3. 그래도 튜플의 hint bits가 안 박혀있으면 CLOG lookup 발생 (튜플 차원)

VM이 set되면 보통 hint bits도 함께 set되어 있는 경우가 많지만, *최근 커밋된 직후*에는 VM 비트는 set되어도 hint bits는 미설정인 경계 상황이 가능합니다. 즉 *"VM all-visible = 완전한 heap skip"이 항상 성립하지는 않습니다*. *"VM all-visible인데도 IOS가 느린 이유"*에 대한 답이 hint bits와 CLOG 조회 비용에 있습니다.

또한 hint bits는 opportunistic하게 set되는 구조입니다. 어떤 트랜잭션은 자기 차례에 hint bit를 set하고 끝내고, 다른 트랜잭션은 이미 set된 상태라 그냥 읽기만 합니다. 결과적으로 같은 쿼리도 hint bits가 박혀있는지에 따라 *latency가 들쭉날쭉*할 수 있습니다. 첫 번째 reader는 CLOG lookup과 hint bit 쓰기 비용을 부담하고, 다음 reader들은 그 결과를 공짜로 활용합니다 (PostgreSQL Wiki는 이 패턴이 *"transaction execution time is subject to unpredictable spikes"*의 한 원인이라고 설명합니다).

#### 역할 2: VACUUM 효율 향상

VACUUM은 *변경된 페이지만* 처리하면 됩니다. VM에서 all-visible 비트가 1인 페이지는 건너뛸 수 있습니다. 대형 테이블에서 VACUUM 시간이 결정적으로 줄어듭니다.

**all-frozen 비트의 실무 의미**는 좀 더 깊습니다. PostgreSQL의 32비트 XID는 약 21억 트랜잭션마다 wraparound가 발생할 수 있어, XID가 충분히 오래된 튜플은 frozen으로 표시해야 합니다. all-frozen 비트가 set된 페이지는 anti-wraparound VACUUM도 통째로 건너뜁니다. 즉 *freeze가 안 된 페이지가 많으면 anti-wraparound VACUUM이 점점 무거워지다가 wraparound 임계값에 도달하면 강제 VACUUM이 일반 작업을 블로킹*합니다. 거대한 테이블에 고-update 워크로드가 겹칠 때 all-frozen 비율이 낮으면 어느 시점에 피할 수 없는 운영 비용으로 돌아온다는 의미입니다.

### 누가 VM을 갱신하는가: VACUUM

핵심은 **VM을 VACUUM이 갱신한다**는 것입니다. 더 정확히는, VACUUM이 dead 튜플을 제거하고 페이지가 깨끗해졌다고 판단할 때 all-visible 비트를 set합니다.

이게 결정적 결과를 만듭니다. *VACUUM이 자주 돌지 않으면 VM이 stale 상태로 남고, Index-Only Scan이 가능한 쿼리도 일반 Index Scan으로 fallback해 느려집니다.* autovacuum 튜닝과 Index-Only Scan 성능이 직결되는 이유입니다.

> **3장 요약**: Visibility Map은 페이지마다 2비트로 all-visible과 all-frozen을 추적합니다. IOS는 *covering 조건(쿼리 컬럼이 인덱스에 있음)과 visibility 조건(VM all-visible)* 두 단계를 모두 통과해야 진짜 IOS입니다. VM은 write activity로 즉시 clear되는 보수적 구조라서, autovacuum이 적시에 set 해줘야 IOS 효율이 유지됩니다.

## 4. VACUUM과 autovacuum: bloat의 청소부

### VACUUM의 역할

VACUUM은 **세 가지 일**을 합니다 (실무에서 의외로 헷갈리는 부분):

1. **Dead tuple 정리**: 공간을 재사용 가능하게 표시합니다. 다만 *어디에 어떤 크기의 free space가 있는지*는 별도의 **Free Space Map (FSM)**이 추적하고, 새 INSERT/UPDATE는 FSM을 통해 적절한 페이지를 찾습니다 ([1편](/blog/theory/db-storage-01-heap-page-index)에서 다룬 메커니즘).
2. **Visibility Map 갱신**: all-visible/all-frozen 비트를 set합니다.
3. **Transaction ID Freezing**: XID wraparound를 방지합니다. 32비트 XID 카운터가 약 21억 트랜잭션마다 한 바퀴 돌므로, 오래된 튜플의 XID를 frozen으로 표시해야 합니다.

(추가로 ANALYZE가 통계 갱신을 담당하지만, VACUUM과 별개 작업입니다.)

VACUUM은 **디스크를 압축하지 않습니다**. 페이지 안의 공간을 재사용 가능하게 표시할 뿐입니다. 디스크에 반환하려면 `VACUUM FULL`(테이블 전체 rewrite + lock)이나 `pg_repack`(온라인 rewrite)이 필요합니다.

### Autovacuum: 자동으로 도는 VACUUM

PostgreSQL은 **autovacuum launcher**라는 백그라운드 프로세스로 VACUUM을 자동 실행합니다. 트리거 조건(기본값)은 다음과 같습니다:

```
threshold = autovacuum_vacuum_threshold (기본 50)
         + autovacuum_vacuum_scale_factor (기본 0.2) × table_size

→ dead_tuple 수가 threshold 넘으면 autovacuum 트리거
```

기본값으로는 *테이블의 20%가 dead tuple이 되어야* autovacuum이 돕니다. 고-update 테이블에서는 너무 보수적입니다.

### Autovacuum 튜닝: 실무적 지렛대

고-update이면서 큰 테이블에 흔히 쓰이는 예시입니다 (Atlassian, Snowflake, Elysiate 등 업계 자료 종합):

```sql
ALTER TABLE sessions SET (
  autovacuum_vacuum_scale_factor = 0.02,  -- 20% → 2%로
  autovacuum_vacuum_threshold = 100
);
```

이렇게 하면 2%만 dead가 되어도 autovacuum이 트리거되어 10배 빠르게 청소합니다. **다만 이는 예시이지 절대 권장값이 아닙니다.** 테이블 크기와 워크로드에 따라 달라집니다. 작은 테이블(수만 행 이하)에서는 0.02가 과도하게 자주 트리거되어 autovacuum 워커를 낭비할 수 있고, 반대로 거대한 테이블(수억 행)에서는 0.02도 부족할 수 있어 threshold 절대값을 같이 조정해야 합니다. 프로덕션에서 적용하기 전에 `pg_stat_user_tables`로 dead tuple 누적 패턴을 측정하고 결정해야 합니다.

한편 **autovacuum이 느린 이유는 cost-based throttling 때문**입니다. autovacuum은 프로덕션 트래픽을 방해하지 않으려고 의도적으로 IO를 throttling합니다:

- `autovacuum_vacuum_cost_limit` (기본 200): 한 사이클에 누적 가능한 IO cost 상한
- `autovacuum_vacuum_cost_delay` (기본 2ms, PG12+): cost limit 도달 시 sleep하는 시간
- 페이지 hit/miss/dirty마다 cost가 누적되고, cost_limit을 초과하면 cost_delay만큼 sleep한 뒤 다시 작업

즉 *autovacuum이 느리게 느껴지는 이유는 느려서가 아니라 일부러 천천히 도는 것*입니다. 고-update 워크로드에서 autovacuum이 변경 속도를 못 따라가면 `cost_limit`을 올리거나(예: 1000~2000) `cost_delay`를 줄여(예: 1ms) throttling을 완화하는 게 정석입니다. worker 수도 같이 조정합니다:

- `autovacuum_max_workers`: 기본 3, 활발히 update되는 테이블이 많으면 5~10으로 증가 (단, 각 worker가 cost_limit을 공유하므로 worker만 늘리면 효과가 제한적)

### Autovacuum이 못 따라가면 일어나는 일

- Dead tuple 누적으로 bloat가 증가하고 sequential scan이 느려집니다.
- VM이 stale해져 Index-Only Scan이 일반 Index Scan으로 fallback합니다.
- Index bloat로 인덱스 페이지 분할이 누적되고 인덱스 검색이 느려집니다.
- **XID wraparound 위기**는 진짜로 위험한 시나리오입니다. PostgreSQL이 읽기 전용 모드로 강제 진입해 다운타임이 발생할 수 있습니다. 한 번 일어나면 복구가 어렵습니다.

이래서 **"autovacuum을 끄지 말라"**는 격언이 있습니다. 끄는 순간 시한 폭탄입니다. 대신 튜닝해야 합니다.

> **4장 요약**: VACUUM은 *dead tuple 정리, VM 갱신, XID freezing* 세 가지를 담당합니다. Autovacuum 기본값(scale_factor 0.2)은 고-update 워크로드에 너무 보수적이라 fillfactor와 함께 튜닝해야 합니다.

## 5. 통합: HOT과 VM, autovacuum이 만드는 선순환

세 메커니즘이 잘 맞물리면 선순환이, 어느 하나라도 깨지면 악순환이 만들어집니다:

![선순환 vs 악순환: fillfactor, autovacuum, 인덱스 컬럼 설계의 정렬 여부](/uploads/theory/db-storage/virtuous-vicious-cycle.svg)

OLTP 시스템 튜닝의 핵심은 이 선순환이 작동하도록 *fillfactor와 autovacuum 설정, 인덱스 컬럼 설계*를 정렬하는 것입니다.

다만 이 다이어그램은 **이상적인 케이스**입니다. 현실에서는 다음과 같은 외부 요인이 선순환을 자주 깨뜨립니다:

- **Long-running transaction + connection pool**: 오래 살아있는 트랜잭션이 있으면 그 트랜잭션이 시작된 시점 이후의 dead tuple을 VACUUM이 정리할 수 없습니다. 특히 connection pool 환경에서 자주 발생합니다. 애플리케이션이 트랜잭션을 BEGIN한 채 idle로 둔 경우(`idle in transaction` 상태)입니다. **이게 bloat이 계속 쌓이는 가장 흔한 실무 원인**입니다. `pg_stat_activity`에서 `state = 'idle in transaction'`이고 `xact_start`가 오래된 백엔드를 모니터링하고, 애플리케이션 측에서는 *트랜잭션을 짧게 유지하고 끝나면 즉시 commit/rollback*하는 게 원칙입니다. Streaming replication 환경에서는 더 까다로워집니다. primary의 VACUUM이 정리하려는 row version이 standby에서 long query에 의해 참조되는 중이면 vacuum conflict가 발생해 standby의 쿼리가 취소되거나(`hot_standby_feedback=off`인 경우) primary의 VACUUM이 지연됩니다(on인 경우). 즉 long-running transaction의 영향이 primary뿐 아니라 cluster 전체로 퍼집니다.
- **Autovacuum lag**: 변경 속도가 autovacuum 처리 속도보다 빠르면 영구히 따라가지 못합니다. cost limit과 worker 수 튜닝이 필요합니다 (위 4장 참고).
- **Checkpoint / WAL pressure**: Update가 폭발적으로 발생하면 WAL이 빠르게 쌓이고, checkpoint 주기마다 dirty page를 디스크로 한꺼번에 flush하는 IO spike가 발생합니다. 이때 latency가 튀는 게 update 많은 워크로드의 흔한 패턴입니다. [ACID ④ 편](/blog/theory/transaction-acid-04-durability)에서 다룬 `checkpoint_timeout`, `max_wal_size`, `checkpoint_completion_target` 튜닝이 이 IO spike를 분산하는 지렛대입니다. 또한 fsync/group commit의 디스크 동기화 비용도 고-update 워크로드에서 latency 변동의 주요 원인입니다.
- **XID wraparound 위기로 인한 anti-wraparound VACUUM**: 테이블의 `relfrozenxid`이 `autovacuum_freeze_max_age`(기본 2억) 임계값을 넘으면 PostgreSQL이 *autovacuum이 꺼져 있어도, 사용자가 취소해도 즉시 재시작되는 강제 VACUUM*을 실행합니다. `pg_stat_activity`에 `(to prevent wraparound)` 라벨로 표시됩니다. 이 VACUUM은 aggressive 모드로 동작해 visibility map 기반 페이지 스킵을 비활성화하고 테이블 전체를 스캔하며, 일반 VACUUM과 다른 lock을 잡아 DDL 등과 충돌할 수 있습니다. 거대한 테이블에서 발동되면 수 시간에서 수일 걸릴 수 있고, 그동안 다른 작업과의 IO·lock 경합으로 latency가 폭발합니다. 이게 *"왜 갑자기 VACUUM이 DB를 멈추게 만드나요?"*의 답입니다. *평소에 all-frozen 비율을 높게 유지하고 적시에 일반 VACUUM이 freezing까지 처리하게 해서, anti-wraparound로 강제 진입하지 않게 하는 게 핵심*입니다.
- **Vacuum-blocking lock**: DDL이나 일부 작업이 VACUUM을 막아 처리가 미뤄집니다.
- **FSM fragmentation**: VACUUM이 dead tuple을 정리해도 남는 free space가 작은 조각들로 쪼개져 있으면 새 INSERT/UPDATE가 그 공간을 활용하지 못해 *효과적 bloat*가 누적됩니다. 이게 누적되면 `VACUUM FULL` 또는 `pg_repack`으로 테이블 재구성이 필요해지는 시점이 옵니다.
- **Index bloat**: B+Tree 인덱스도 dead 엔트리와 페이지 분할(page split)이 누적되면 bloat가 됩니다. UPDATE가 인덱스 컬럼을 자주 변경하면 옛 위치 엔트리가 vacuum될 때까지 누적되고, INSERT가 정렬 순서를 깨면 page split이 일어나 인덱스 페이지의 fill ratio가 낮아집니다. 주기적 `REINDEX CONCURRENTLY` 또는 `pg_repack`으로 정리가 필요합니다.

즉 실무 OLTP 운영은 *이 다이어그램과 그것을 깨뜨리는 외부 요인 모니터링*의 조합입니다.

> **5장 요약**: 세 메커니즘은 독립적으로 보이지만 서로 강하게 결합되어 있습니다. 어느 하나라도 무너지면 전체 시스템 효율이 무너집니다.

## 6. 실전 진단: 내 시스템은 건강한가

### 진단 쿼리 1: HOT update 비율

```sql
SELECT relname, n_tup_upd, n_tup_hot_upd,
       round(100.0 * n_tup_hot_upd / NULLIF(n_tup_upd, 0), 2) AS hot_ratio
FROM pg_stat_user_tables
WHERE n_tup_upd > 1000
ORDER BY hot_ratio ASC;
```

**해석**: `hot_ratio < 80%`면 fillfactor를 낮추거나 인덱스를 재검토합니다. `hot_ratio < 30%`이면 심각합니다.

### 진단 쿼리 2: dead tuple 비율

```sql
SELECT relname, n_live_tup, n_dead_tup,
       round(100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0), 2) AS dead_pct,
       last_autovacuum
FROM pg_stat_user_tables
WHERE n_live_tup > 0
ORDER BY dead_pct DESC;
```

**해석**: `dead_pct > 20%`이면서 `last_autovacuum`이 오래된 테이블은 autovacuum 트리거 임계값을 낮춰야 합니다.

### 진단 쿼리 3: VM 상태 확인 (`pg_visibility` extension)

```sql
CREATE EXTENSION IF NOT EXISTS pg_visibility;

SELECT relname,
       (SELECT count(*) FROM pg_visibility_map(c.oid) WHERE all_visible) AS all_visible_pages,
       (SELECT count(*) FROM pg_visibility_map(c.oid)) AS total_pages
FROM pg_class c
WHERE relname = 'your_table';
```

**해석**: `all_visible_pages / total_pages`가 낮으면 Index-Only Scan이 효과를 못 발휘합니다. autovacuum을 더 자주 돌리도록 튜닝합니다.

### 진단 쿼리 4: Index-Only Scan이 진짜로 일어나는가

```sql
EXPLAIN (ANALYZE, BUFFERS) SELECT id FROM your_table WHERE id = 12345;
```

`Heap Fetches: 0`이면 진정한 Index-Only Scan입니다. `Heap Fetches: > 0`이면 VM이 stale해서 heap을 읽고 있는 상태입니다.

### 진단 쿼리 5: Long-running transaction 모니터링 (가장 흔한 bloat 원인)

```sql
SELECT pid, state, xact_start, query_start,
       now() - xact_start AS xact_age,
       LEFT(query, 80) AS query
FROM pg_stat_activity
WHERE state IN ('idle in transaction', 'idle in transaction (aborted)')
  AND xact_start IS NOT NULL
ORDER BY xact_start;
```

**해석**: `xact_age`가 분/시간 단위로 큰 백엔드가 보이면 즉시 조사해야 합니다. *이게 bloat이 계속 쌓이는 원인 1순위*입니다. 애플리케이션 측 트랜잭션 관리를 점검합니다 (connection pool에서 트랜잭션을 길게 유지하지 않는지).

> **6장 요약**: `pg_stat_user_tables`, `pg_visibility`, `EXPLAIN ANALYZE`, `pg_stat_activity`로 시스템 상태를 진단할 수 있습니다. 진짜 OLTP 운영은 이 지표들을 정기적으로 모니터링하는 데서 시작됩니다.

## 7. 정리: 메커니즘이 풀어주는 비용의 그림

### 핵심 통찰

1. **PostgreSQL UPDATE의 잠재 비용은 Write Amplification**: cold update 시 새 튜플 생성과 모든 인덱스 갱신이 따라옵니다. MVCC 구현의 결과지만 *항상 발생하는 건 아닙니다* (HOT이 적용되면 인덱스 갱신 회피).
2. **HOT Update는 조건부 인덱스 갱신 회피**: 두 조건은 *변경 컬럼이 어떤 인덱스에도 없고 같은 페이지에 free space가 있을 때*입니다. 인덱스 컬럼 하나만 변경되어도 HOT은 즉시 불가능합니다. 또한 *row 크기 증가나 TOAST 이동*으로 같은 페이지 유지가 깨질 때도 HOT이 실패합니다. HOT에서도 새 튜플 생성과 WAL 기록은 발생하므로, *write amplification이 zero가 되는 게 아니라 대폭 감소*합니다. 부수 효과로 *index bloat 억제*까지 따라옵니다 (cold update와 달리 dead index entry 자체가 안 생김).
3. **HOT chain은 길어질수록 read 비용 누적**: tuple에서 t_ctid를 따라 다음 tuple로 이어지는 pointer chasing이 같은 페이지 안에서 일어나도 CPU/메모리 차원의 비용이 쌓입니다. Pruning이 적시에 정리해줘야 효율이 유지됩니다.
4. **Index-Only Scan은 두 단계 조건**: *covering 조건(모든 참조 컬럼이 인덱스에 있음)과 visibility 조건(VM all-visible 비트 set)*입니다. covering이 없으면 IOS 자체가 불가능하고, covering이 있어도 VM이 stale하면 heap fetch가 발생합니다 (`EXPLAIN`의 `Heap Fetches`로 확인). 그 아래에는 *hint bits와 CLOG* 레이어가 있어 VM이 set돼도 튜플 차원 visibility 비용이 약간 남을 수 있습니다. Hint bits의 opportunistic timing 때문에 같은 쿼리도 latency가 들쭉날쭉할 수 있습니다.
5. **HOT pruning은 VACUUM을 대체하지 않음**: pruning은 page-level cleanup이고, VACUUM은 visibility/freeze/FSM/index 정리로 역할이 다릅니다. Pruning이 활발해도 VACUUM은 주기적으로 돌아야 합니다.
6. **Visibility Map은 conservative이면서 transient**: write activity가 발생하면 즉시 clear됩니다. all-visible은 IOS 효율, all-frozen은 anti-wraparound VACUUM 회피에 결정적입니다.
7. **VACUUM은 단일 작업이 아님**: dead tuple 정리(공간 표시, FSM과 연결), VM 갱신, XID freezing 세 가지를 함께 담당합니다.
8. **Autovacuum이 느려 보이는 이유는 cost-based throttling**: cost_limit과 cost_delay로 의도적으로 천천히 돕니다. 못 따라가면 cost_limit을 올리거나 cost_delay를 줄여 throttling을 완화합니다.
9. **Anti-wraparound VACUUM은 진짜 위험**: `relfrozenxid` > `autovacuum_freeze_max_age`(기본 2억)이면 *autovacuum이 꺼져있어도 강제 실행되고, 취소해도 즉시 재시작되며, 일반 작업과 lock이 충돌*합니다. 평소 all-frozen 비율을 높게 유지하는 게 예방책입니다.
10. **세 메커니즘은 결합되어 작동하지만, 외부 요인이 자주 깨뜨림**: long-running transaction(`idle in transaction`), connection pool 환경의 트랜잭션 관리 부실, checkpoint/WAL pressure, anti-wraparound VACUUM, FSM fragmentation, index bloat 등입니다.
11. **Bloat 누적의 가장 흔한 실무 원인은 long transaction**: `idle in transaction` 상태로 트랜잭션을 길게 유지하면 그 시점 이후의 dead tuple을 VACUUM이 정리할 수 없습니다. replication 환경에서는 standby의 long query가 primary VACUUM과 conflict하는 경우까지 발생합니다. *애플리케이션 측 트랜잭션 관리가 결정적입니다.*
12. **튜닝은 측정 후 워크로드별로**: 고-update이면서 큰 테이블에는 fillfactor 70~80과 적극적 autovacuum 패턴이 흔하지만 *절대 권장값이 아닙니다*. `pg_stat_user_tables`, `pg_stat_activity`로 측정 후 결정합니다.

### 진짜 한 줄

> PostgreSQL UPDATE의 비용은 MVCC로 인한 write amplification이고, **HOT은 이 쓰기 비용을 조건부로 줄이며, Visibility Map은 읽기 비용(Index-Only Scan)을 조건부로 줄인다.**

### 통합된 답: 한 단락 정리

PostgreSQL UPDATE는 MVCC 구현 특성상 write amplification이 발생할 수 있습니다. 새 row version 생성과 모든 인덱스 갱신이 따라올 수 있기 때문입니다. 이를 회피하는 메커니즘이 **HOT(Heap-Only Tuple) Update**이고, *변경 컬럼이 어떤 인덱스에도 포함되지 않고 같은 페이지에 free space가 있으면* 인덱스 갱신을 건너뛰고 같은 페이지 안에 새 버전을 만듭니다. 인덱스 컬럼 하나라도 변경되면 HOT은 즉시 불가능하고 row 크기 증가나 TOAST 이동으로도 깨질 수 있어, *어떤 컬럼이 indexed인지와 데이터 크기 안정성*이 HOT 성공률을 좌우합니다. 인덱스는 옛 line pointer만 가리키고 HOT chain을 따라 최신 버전을 찾으며, 이를 돕는 게 **fillfactor 설정**입니다. 고-update 테이블에서 70~80이 흔한 출발점입니다.

한편 **Visibility Map**은 페이지마다 2비트(all-visible과 all-frozen)를 추적해 두 가지 일을 합니다. Index-Only Scan을 가능하게 하고, VACUUM이 깨끗한 페이지를 건너뛸 수 있게 합니다. 다만 IOS의 조건은 **두 단계**로, *covering 조건(참조 컬럼이 인덱스에 있음)*과 *visibility 조건(VM all-visible 비트 set)*이 모두 통과해야 진짜 IOS가 됩니다. 그 아래에는 *hint bits와 CLOG* 레이어가 있어, VM이 set돼도 튜플 차원 visibility 비용이 약간 남을 수 있습니다(hint bit 미설정 상태에서 동시 reader들이 모두 CLOG lookup하면 같은 쿼리도 latency가 들쭉날쭉해집니다).

**VACUUM**은 *dead tuple 정리, VM 갱신, XID freezing* 세 가지를 담당하며, autovacuum이 느려 보이는 이유는 *cost-based throttling*(`cost_limit`, `cost_delay`)으로 의도적으로 천천히 도는 것입니다. 정말 위험한 건 **anti-wraparound VACUUM**입니다. `relfrozenxid`이 `autovacuum_freeze_max_age`(기본 2억)을 넘으면 *autovacuum이 꺼져 있어도 강제로 도는* 종류의 VACUUM이고, 일반 작업과 lock 충돌을 일으킬 수 있습니다. `pg_stat_activity`에 `(to prevent wraparound)`로 표시되는 그 VACUUM입니다. 그래서 OLTP 튜닝의 본질은 *fillfactor와 autovacuum 설정, 인덱스 컬럼 설계, 트랜잭션 길이 관리*를 워크로드에 맞게 정렬하는 것입니다. 기본 `autovacuum_vacuum_scale_factor=0.2`가 고-update 큰 테이블에는 너무 보수적인 경우가 많지만 *절대 권장값이 아니라 측정 후 결정*해야 하고, *bloat이 계속 쌓이는 가장 흔한 원인은 `idle in transaction` 상태의 long-running transaction*이라는 점도 함께 봐야 합니다.

---

결국 HOT과 Visibility Map은 **MVCC가 만든 비용을 상쇄하기 위한 PostgreSQL의 두 가지 답**입니다. MVCC는 동시성을 얻기 위해 *write amplification과 visibility 체크*라는 비용을 지불했고, HOT과 VM은 그 비용을 조건부로 줄여줍니다. 그 조건을 만족시키는 것이 곧 OLTP 튜닝의 본질입니다.

---

### 글의 범위와 한계

이 글은 PostgreSQL의 HOT update와 Visibility Map에 초점을 맞췄습니다. 다른 데이터베이스의 비교는 의도적으로 생략합니다:

- **MySQL InnoDB**는 *clustered index, undo log, change buffer*라는 다른 메커니즘으로 비슷한 문제를 해결합니다. undo log 기반 MVCC라서 PostgreSQL과는 write amplification 패턴이 다릅니다 (다만 secondary index update는 여전히 발생).
- **Oracle**은 *rollback segment와 index의 visibility info* 조합입니다.
- **SQL Server**는 *page-level versioning*으로 다른 접근을 취합니다.

각 DB가 MVCC를 구현하는 방식에 따라 다른 비용과 다른 튜닝 지렛대를 가집니다. PostgreSQL의 HOT/VM 모델은 그중 하나이고, open-source 생태계에서 가장 자주 마주치게 되는 모델입니다.

### 참고 (1차 자료 우선)

- [PostgreSQL Documentation — Heap-Only Tuples (HOT)](https://www.postgresql.org/docs/current/storage-hot.html): HOT의 두 조건 공식 정의
- [PostgreSQL Documentation — Visibility Map](https://www.postgresql.org/docs/current/storage-vm.html): VM의 두 비트 공식 정의
- [PostgreSQL `README.HOT` (source)](https://github.com/postgres/postgres/blob/master/src/backend/access/heap/README.HOT): HOT 구현의 기본 문서
- [boringSQL — HOT Updates in Postgres](https://boringsql.com/posts/hot-updates-in-postgres/): line pointer와 chain 메커니즘 실증 분석
- [CYBERTEC — HOT updates in PostgreSQL for better performance](https://www.cybertec-postgresql.com/en/hot-updates-in-postgresql-for-better-performance/): 실무 관점의 깊이 있는 분석
- [CYBERTEC — Making the PostgreSQL visibility map visible](https://www.cybertec-postgresql.com/en/postgresql-visibility-map/): VM 동작과 Index-Only Scan의 관계
- [InterDB — Heap Only Tuple (HOT)](https://www.interdb.jp/pg/pgsql07.html): Hironobu Suzuki의 PostgreSQL 내부 분석
- [Google Cloud — Deep dive into PostgreSQL VACUUM](https://cloud.google.com/blog/products/databases/deep-dive-into-postgresql-vacuum): VACUUM의 세 가지 역할과 autovacuum FAQ
- [PostgreSQL Wiki — Index-only scans](https://wiki.postgresql.org/wiki/Index-only_scans): IOS 메커니즘 학술적 정리
- [Snowflake Engineering — Tuning Postgres Vacuum](https://www.snowflake.com/engineering-blog/tuning-postgres-vacuum/): bloat 진단 쿼리
- [PostgreSQL Documentation — Routine Vacuuming](https://www.postgresql.org/docs/current/routine-vacuuming.html): autovacuum, freezing, anti-wraparound 공식 가이드
- [PostgreSQL Documentation — Database Page Layout](https://www.postgresql.org/docs/current/storage-page-layout.html): 페이지 헤더 / Item ID / 튜플 레이아웃 공식 정의

---
title: 'DB 내부 ④: 격리, 2PL에서 MVCC 스냅샷 격리까지, reader가 writer를 안 막기까지'
description: "동시에 여럿이 읽고 쓸 때 DB는 어떻게 안전한가. 두 철학이 있다. 충돌을 미리 막는 2PL(잠금)과 버전을 갈라 충돌을 피하는 MVCC다. MVCC의 두뇌는 가시성 규칙 한 줄(xmin 커밋 AND xmax 미커밋이면 보인다)이고, 그 규칙이 성립하려면 DELETE조차 지우면 안 된다(xmax 도장). 그 순간 힙을 읽는 아홉 갈래 전부에 가시성 게이트가 필요해지고, '인덱스는 MVCC를 모른다'는 원칙이 선다. 일부러 만든 쓰레기(dead tuple)는 VACUUM이 치우는데, PostgreSQL nbtree처럼 병합 없는 lazy 삭제로 충분한 이유, VACUUM해도 파일이 안 줄어드는 이유까지 코드로 확인한다. 마지막으로 reader의 락을 제거하고 BEGIN 시점 스냅샷(PG의 xmax/xip 축소판)을 고정하면, 한 트랜잭션이 미커밋 UPDATE를 쥐고 있어도 다른 쪽이 옛 버전을 막힘 없이 읽는 진짜 스냅샷 격리가 선다. 그 여파로 PK 인덱스가 다중 버전 멀티맵이 되어야 했던 것까지, C 구현으로 확인하며 정리한다."
date: 2026-03-28T00:00:00.000Z
tags:
  - Database Internals
  - MVCC
  - Isolation
  - Transaction
  - PostgreSQL
  - InnoDB
  - C
category: study/db-hobby
coverImage: /uploads/project/db-hobby/cover.svg
draft: false
series: "미니 DB로 이해하는 DB 내부"
seriesOrder: 4
---

## 0. 들어가며 : 동시에 여럿이 올 때

[3편](/blog/project/db-hobby/db-internals-03-wal-recovery)까지로 크래시엔 안 깨지게 됐습니다. 이번 문제는 **동시성**입니다. 두 트랜잭션이 같은 행을 동시에 건드리면? 하나는 읽고 하나는 쓰면?

이 편은 그 답의 두 철학(2PL vs MVCC)에서 시작해, MVCC를 실제로 구현하며 부딪힌 벽들을 순서대로 밟습니다. 스포일러: MVCC의 핵심은 "버전을 쌓는다"가 아니라 **가시성 규칙 한 줄**이고, 그 한 줄을 지키려면 DELETE조차 지우면 안 되고, 지우지 않으면 청소부(VACUUM)가 필요해지고, 청소까지 끝나면 마침내 **"reader가 writer를 안 막는다"** 가 시연이 아니라 실행이 됩니다.

격리 수준과 이상현상의 이론 전체 그림은 [트랜잭션 ACID ②: Isolation](/blog/theory/transaction-acid-02-isolation)에 있습니다. 이 편은 그 이론이 코드로 서는 과정입니다.

## 1. 두 철학 : 충돌을 막을까, 피할까

두 트랜잭션이 같은 행을 동시에 건드릴 때, 안전하게 만드는 답은 둘입니다.

**2PL(잠금): 충돌을 미리 막는다.** 읽으려면 공유 락(S), 쓰려면 배타 락(X)을 잡습니다. 누가 잠근 건 못 건드립니다. 비관적(pessimistic) 접근. 락이 서로를 기다리다 사이클이 생기면 **교착(deadlock)** 이라, wait-for 그래프로 탐지해 한쪽을 abort해야 합니다.

**MVCC(버전): 충돌을 피한다.** 쓰면 덮어쓰는 대신 **새 버전**을 만들고, 읽으면 자기 트랜잭션 시점의 **스냅샷**을 봅니다. 읽는 쪽과 쓰는 쪽이 서로 다른 버전을 보니 막을 일이 없습니다.

| 이상현상 | 2PL의 처방 | MVCC의 처방 |
|---|---|---|
| dirty read | X 잠긴 행을 못 읽음 | 미커밋 버전은 애초에 안 보임 |
| lost update | X 락으로 쓰기 직렬화 | 쓰기 충돌만 별도 처리(방식은 DB마다 다름, 5절 표) |
| non-repeatable read | S 락을 커밋까지 쥠 | 스냅샷을 트랜잭션 단위로 고정할 때 차단 |

같은 문제를 한쪽은 "잠가서", 한쪽은 "버전을 갈라서" 풉니다. 그리고 공짜 점심은 없습니다:

| | 2PL (잠금) | MVCC (버전) |
|---|---|---|
| 얻는 것 | 단순한 저장(행당 버전 1개) | **읽기가 쓰기를 안 막음** |
| 치르는 비용 | 동시성 저하, 교착 탐지·abort | dead tuple 누적, **VACUUM** |
| 비용 청구 시점 | 실행 중(락 대기) | 나중에 백그라운드(청소) |

> **실무/면접 포인트**: "MVCC가 빠르다"보다 정확한 설명은 **"MVCC는 읽기-쓰기 충돌을 없앤다"** 다. 일반 SELECT가 락 없이 스냅샷을 읽으니 reader와 writer가 서로 안 기다린다(`FOR UPDATE` 같은 명시적 락은 예외). 다만 **쓰기-쓰기 충돌은 MVCC에서도 남는다**(5절). PostgreSQL의 높은 읽기 동시성이 여기서 나오고, 그 값으로 PG는 VACUUM을 떠안고 산다.

db-hobby는 2PL(테이블 S/X 락, strict 2PL, wait-for 교착 탐지)을 먼저 만들어 "막는" 쪽을 확인한 뒤, MVCC로 갈아탔습니다. 이 갈아타기가 이 편의 나머지 전부입니다.

## 2. MVCC의 두뇌 : 가시성 규칙 한 줄

MVCC는 "버전을 쌓는다"가 전부처럼 보이지만, 그걸 작동시키는 두뇌는 **가시성 규칙** 한 줄입니다. 각 행 버전이 두 개의 트랜잭션 ID를 답니다.

- `xmin`: 이 버전을 만든(INSERT한) 트랜잭션
- `xmax`: 이 버전을 지운(DELETE한) 트랜잭션 (0이면 아직)

> **가시성 규칙**: 어떤 행 버전은, (`xmin`이 **나 자신**이거나 커밋됐고) AND NOT (`xmax`가 **나 자신**이거나 커밋됨)일 때만 보인다.

```c
int mvcc_visible(const TxnLog *log, int xmin, int xmax) {
    if (txnlog_status(log, xmin) != TXN_COMMITTED) return 0; /* 생성자가 미커밋/abort -> 없는 행 */
    if (xmax != 0 && txnlog_status(log, xmax) == TXN_COMMITTED) return 0; /* 커밋된 삭제 -> 안 보임 */
    return 1;
}
```

`TxnLog`는 트랜잭션 id마다 상태(진행/커밋/아보트)를 담은 배열로, PostgreSQL의 **CLOG**(`pg_xact`)에 대응합니다. 행 저장은 [1편의 행 포맷](/blog/project/db-hobby/db-internals-01-storage) 맨 앞에 8바이트 헤더(`[xmin(4)][xmax(4)]`)를 붙이는 것으로 끝납니다.

코드의 `mvcc_visible`은 **남의 트랜잭션**에 대한 핵심 판정입니다. 실제 게이트(`db.c`의 `row_visible`)엔 `xmin == my_txn || …` 조항이 하나 더 붙습니다. **자기 트랜잭션의 미커밋 쓰기는 자기에겐 보여야** 하기 때문입니다(방금 INSERT한 행을 내 다음 SELECT가 못 보면 곤란합니다). PostgreSQL은 여기서 한 단계 더 갑니다. 같은 트랜잭션 안에서도 `cmin`/`cmax`로 **문장 단위** 가시성을 갈라서, 실행 중인 UPDATE가 자기가 방금 만든 새 버전을 또 읽어 다시 갱신하는 사고(Halloween problem)를 막습니다.

> **왜 PostgreSQL 튜플 헤더엔 hint bits가 있나**: db-hobby의 TxnLog는 메모리 배열이라 상태 조회가 즉시지만, PostgreSQL의 CLOG(`pg_xact`)는 디스크에 있습니다(SLRU 캐시 경유). 매 가시성 판정마다 CLOG를 뒤지면 비싸니, 한 번 알아낸 커밋/아보트 결과를 **튜플 헤더의 hint bits에 캐시**합니다. 이 캐시 쓰기 때문에 "대량 적재 직후 첫 SELECT가 유난히 느리다(읽기가 쓰기를 유발한다)"는 PostgreSQL 특유의 현상이 생깁니다.

![행 버전과 가시성 : xmin/xmax와 트랜잭션 상태가 버전의 보임/안 보임을 가른다](/uploads/project/db-hobby/mvcc-version-visibility.svg)

여기서 **"이전 버전을 어디에 두느냐"** 가 실제 DB들을 가르는 분기점입니다.

| | db-hobby | PostgreSQL | InnoDB |
|---|---|---|---|
| 옛 버전 위치 | 같은 힙 (행 헤더 xmin/xmax) | 같은 힙 (튜플 헤더) | **별도 Undo Log** |
| UPDATE | 옛 버전에 xmax + 새 버전(새 RID) | 새 튜플 append | in-place 수정 + before를 undo에 |
| 트랜잭션 상태 | TxnLog | CLOG(`pg_xact`) | rollback segment 포인터 |

db-hobby는 PostgreSQL을 따라 **같은 힙 안**(append-only)에 둡니다. 이 선택의 우아한 보상이 하나 있습니다. **롤백이 공짜**입니다. abort하면 TxnLog에 "아보트"라 적기만 하면, 그 트랜잭션이 만든 모든 버전이 가시성 규칙에 의해 **자동으로 안 보이게** 됩니다. 행을 하나하나 되돌릴 필요가 없습니다. (InnoDB는 반대로 undo log를 재생해 물리적으로 되돌리는 대신, 힙이 항상 최신 버전만 들고 있어 읽기가 가볍습니다. 이 트레이드오프의 전체 그림은 [ACID ①](/blog/theory/transaction-acid-01-atomicity).)

> **흔한 오해 정정**: *"롤백은 어느 DB든 싸다"*. 옛 버전을 어디 두느냐가 롤백 비용까지 정합니다. PostgreSQL은 db-hobby처럼 CLOG에 '아보트'라 적으면 끝이라 즉시 반환되지만, 만들어 둔 dead tuple의 청구서는 VACUUM으로 이월됩니다. InnoDB는 undo log를 재생해 물리적으로 되돌리니 **대형 트랜잭션의 롤백이 커밋보다 오래 걸릴 수 있습니다**. 수백만 행 UPDATE를 롤백해 본 사람이 아는 그 대기 시간입니다.

## 3. DELETE는 지우지 않는다 : xmax 도장과 아홉 갈래 게이트

가시성 규칙이 성립하려면 치명적인 전제가 하나 있습니다. **DELETE가 행을 물리적으로 지우면 안 됩니다.** 지워 버리면 "커밋 안 된 삭제는 여전히 보여야 한다"(reader의 스냅샷)를 지킬 수 없습니다. DELETE 롤백도 물리 복원에 기대야 합니다.

그래서 DELETE는 슬롯을 지우는 대신 **xmax 4바이트만 제자리에서 덮어씁니다**. 도장을 찍는 것입니다.

```c
static int stamp_xmax(Table *t, RID rid, int32_t xmax) {
    uint8_t rec[PAGE_SIZE]; uint16_t len;
    heap_get(&t->heap, rid, rec, &len);
    memcpy(rec + 4, &xmax, 4);                     /* MVCC 헤더 = [xmin(4)][xmax(4)] */
    return heap_overwrite(&t->heap, rid, rec, len); /* 같은 길이 제자리 덮어쓰기 */
}
```

UPDATE도 같은 결입니다. 옛 버전에 `stamp_xmax`, 새 버전을 새 RID로 삽입. PostgreSQL이 UPDATE를 다루는 방식 그대로입니다.

### 대가 : 힙을 읽는 모든 경로가 가시성을 알아야 한다

"지워진 행이 물리적으로 존재"하게 된 순간, 힙을 읽는 **모든** 경로가 버전을 걸러야 합니다. 세어 보니 아홉 갈래였습니다. 풀스캔, PK 점 조회, PK 범위, 보조 인덱스, 조인 세 방식(중첩 루프·해시 빌드·인덱스 NLJ), 집계/정렬 materialize, DML 대상 수집, CREATE INDEX 빌드. 게이트는 한 줄인데, 그 한 줄을 아홉 군데 다 달아야 정확합니다. 하나라도 빼먹으면 그 경로만 유령(지워진 행)을 봅니다.

![xmax 게이트 : 힙을 읽는 모든 경로가 가시성 판정을 지난다](/uploads/project/db-hobby/mvcc-xmax-gate.svg)

여기서 인덱스에 관한 중요한 관찰:

> **인덱스는 MVCC를 모른다.** B+Tree는 (키 → RID)만 알지, 그 RID의 행이 어느 트랜잭션에 보이는지 모른다. 그래서 모든 인덱스 경로가 "인덱스로 후보를 찾고 → 힙에서 행을 읽고 → 게이트로 판정"하는 2단 구조가 된다. PostgreSQL의 인덱스 스캔이 힙에 들러 가시성을 확인하는 것(그리고 그 비용을 아끼려 visibility map을 두는 것)과 같은 이유다. [2편](/blog/project/db-hobby/db-internals-02-btree-index)의 "인덱스는 후보일 뿐, 진실은 힙에" 원칙이 MVCC에서 생존 조건이 된다.

보상은 즉시 왔습니다. **DELETE 롤백이 되살아납니다.** xmax를 찍은 트랜잭션이 아보트되면 가시성 규칙이 그 도장을 무효로 치니까, ROLLBACK 한 번에 지운 행이 돌아옵니다. 물리 복원이 아니라 논리의 귀결입니다.

## 4. 일부러 만든 쓰레기 : VACUUM

이제 새 문제가 생겼습니다. DELETE가 안 지우니 **죽은 버전(dead tuple)이 무한히 쌓입니다.** DELETE를 해도 파일이 1바이트도 안 줄어듭니다. 이게 MVCC가 청구하는 비용이고, 청소부가 **VACUUM**입니다.

**누가 죽었는가**: 판정 원칙은 "지금은 물론 앞으로도 아무 트랜잭션에게 보일 수 없는 버전". 일반적으론 실행 중인 모든 스냅샷을 고려하는 까다로운 판정인데(PostgreSQL의 oldest xmin horizon), db-hobby에선 "커밋된 xmax가 찍힌 버전"으로 떨어집니다. `exec_vacuum`이 어느 세션이든 열린 트랜잭션이 있으면 VACUUM 자체를 거부해서, 판정 시점에 살아있는 스냅샷이 없음이 보장되기 때문입니다. PostgreSQL은 다르게 갑니다. 다른 세션의 트랜잭션이 열려 있어도 VACUUM은 돌고, 다만 oldest xmin보다 새로운 dead tuple을 그 회차에 못 치울 뿐입니다. 자기 자신이 트랜잭션 블록 안이면 실행 불가(`VACUUM cannot run inside a transaction block`)라는 건 그와 별개의 제약입니다.

**청소부의 세 가지 일**: 순서가 중요합니다.

```
① 죽은 버전을 가리키던 인덱스 항목을 지운다   (B+Tree lazy 삭제)
② 힙 슬롯을 비우고 페이지를 compaction한다    (슬롯 번호 = RID 불변!)
③ 꼬리가 전부 빈 페이지면 파일을 자른다        (조건부 truncate)
```

![VACUUM : 죽은 버전 수집, 인덱스 항목 제거, 페이지 compaction, 꼬리 truncate](/uploads/project/db-hobby/vacuum-sweep.svg)

②에서 슬롯 번호를 보존하는 이유는 [1편](/blog/project/db-hobby/db-internals-01-storage)의 그 원칙, 슬롯 번호가 곧 RID고 인덱스가 RID로 가리키기 때문입니다. ③은 **파일 끝의 전부-빈 페이지만** 자르고 가운데 빈 페이지는 남깁니다. PostgreSQL VACUUM도 정확히 이래서, **"VACUUM 했는데 파일이 안 줄어요"** 가 흔한 겁니다(공간은 재사용 가능해졌지만 OS에 반납되진 않은 상태).

**B+Tree 삭제: 교과서와 다르게.** 죽은 버전을 치우면 인덱스 항목이 허공을 가리키니 지워야 하는데, 교과서(병합·재분배)를 이식하기 전에 진짜 DB를 봤습니다. **PostgreSQL nbtree는 재분배를 안 합니다.** 리프에서 항목을 지우고, 페이지가 완전히 비면 트리에서 떼어 재활용할 뿐입니다. 노드가 반쯤 비어도 그냥 둡니다. 그래서 **lazy 삭제**로 충분합니다. 포인트는 키가 아니라 **(키, RID) 짝**을 지우는 것입니다. UPDATE된 PK는 같은 키가 살아있는 새 버전을 가리키고 있어서, 짝으로 지워야 산 항목을 안 다칩니다.

**트랜잭션 ID도 유한하다.** db-hobby의 TxnLog는 고정 배열(`TXN_MAX`)이라 ID를 소진하면 재시작 전까진 끝입니다. 미니 DB라서 허용한 한계입니다. PostgreSQL의 XID는 32비트 순환 카운터라 약 40억에서 한 바퀴 돕니다(wraparound). 옛 튜플의 xmin이 '미래'로 해석되는 순간 데이터가 사라져 보이기 때문에, VACUUM이 충분히 오래된 튜플의 xmin을 '영원히 과거'(frozen)로 바꿔 둡니다. 공식 문서가 routine vacuuming의 존재 이유로 *"to protect against loss of very old data due to transaction ID wraparound"* 를 명시할 만큼 운영에서 무거운 주제입니다.

> **실무 안티패턴**: 트랜잭션을 열어 둔 채 방치하는 것(idle in transaction). PostgreSQL에선 그 세션의 스냅샷이 oldest xmin을 붙들어 **그보다 새로운 dead tuple을 VACUUM이 못 치우고**, 테이블이 부풉니다(bloat). `pg_stat_activity`의 `xact_start`로 오래 열린 트랜잭션을, `pg_stat_user_tables`의 `n_dead_tup`으로 쌓인 시체를 확인하고, `idle_in_transaction_session_timeout`으로 방치 자체를 끊는 게 상비책입니다.

## 5. 진짜 스냅샷 격리 : reader의 락을 없애다

부품이 다 모였습니다. 이제 철학 전환의 마지막 한 수입니다. **SELECT가 락을 안 잡습니다.**

```c
static int acquire_stmt_locks(Database *db, const Statement *st, int txn, FILE *out) {
    switch (st->type) {
        case STMT_INSERT: case STMT_DELETE: case STMT_UPDATE:
            return lock_one(db, ..., LOCK_X, txn, out);  /* 쓰기만 X락 */
        default: return 0;                                /* SELECT: 락 없음 */
    }
}
```

"락 없이 dirty read를 어떻게 막지?" **그건 더 이상 락의 일이 아닙니다.** writer의 미커밋 버전은 xmin이 미커밋이라 게이트가 거릅니다. UPDATE의 옛 버전은 xmax가 미커밋이라 **여전히 보입니다.** reader는 거부당하는 게 아니라 그냥 **옛 버전을 읽습니다.** 막는 대신 가르는 것입니다. 1절의 표가 코드가 된 순간입니다.

**시간을 고정한다: BEGIN 시점 스냅샷.** 락을 없앴으니 격리는 온전히 가시성이 정하는데, "지금 커밋된 것"을 보면 read committed입니다(같은 SELECT 두 번 사이에 남이 커밋하면 결과가 바뀜). 스냅샷 격리라 부르려면 시간을 BEGIN에 고정해야 합니다. 구현은 PostgreSQL 스냅샷의 축소판입니다. BEGIN 때 ① 이후에 태어날 트랜잭션의 경계(`snap_next`)와 ② 지금 열려 있는 남의 트랜잭션 목록(`snap_inprog`)을 기록하고, 가시성 판정이 이 스냅샷을 통과해야 "커밋됨"으로 칩니다. PG 스냅샷의 `xmax`(경계)와 `xip`(in-progress 목록)에 정확히 대응합니다. 이로써 db-hobby는 트랜잭션 안은 REPEATABLE READ, 밖의 단문은 read committed입니다. PostgreSQL로 치면 `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`를 항상 켜 둔 셈입니다. PostgreSQL의 기본값(READ COMMITTED)은 명시적 트랜잭션 **안에서도** 문장마다 새 스냅샷을 찍고, "트랜잭션 안 = 스냅샷 고정"이 기본인 건 오히려 InnoDB(기본 REPEATABLE READ)의 구도입니다.

> **흔한 오해 정정**: *"스냅샷은 BEGIN이 찍는다"*. db-hobby는 정말 BEGIN 시점에 찍지만, 실제 DB들은 미룹니다. PostgreSQL의 REPEATABLE READ가 고정하는 건 공식 문서 표현으로 *"a snapshot as of the start of the first non-transaction-control statement in the transaction"*, 즉 BEGIN이 아니라 **첫 일반 문장** 시점입니다. InnoDB도 첫 consistent read 시점이고, 시작하자마자 고정하려면 `START TRANSACTION WITH CONSISTENT SNAPSHOT`을 명시해야 합니다. "BEGIN만 해 두면 그 시각이 기준"이라는 가정은 두 DB 모두에서 어긋납니다.

**쓰기-쓰기만은 막는다.** 두 트랜잭션이 같은 데이터를 고치는 것만은 버전으로 못 피합니다(lost update). db-hobby의 답은 쓰기에만 X락(테이블 단위)을 유지하고, 충돌하면 기다리지 않고 뒤에 온 쪽이 즉시 에러를 받는 것입니다(no-wait). 그런데 이 지점이야말로 이론과 구현이, 구현과 구현이 갈립니다:

| | 동시 UPDATE 충돌 처리 |
|---|---|
| 이론의 SI (Berenson et al. 1995) | **first-committer-wins**(커밋 시점에 뒤에 커밋하는 쪽이 abort) |
| PostgreSQL READ COMMITTED | 행 락 **대기** → 상대가 커밋하면 최신 버전으로 조건 재평가 후 진행 |
| PostgreSQL REPEATABLE READ | 행 락 **대기** → 상대가 커밋하면 `ERROR: could not serialize access due to concurrent update` |
| InnoDB REPEATABLE READ | 행 락 **대기** → 그대로 덮어씀(충돌 감지 없음, lost update는 애플리케이션 몫) |
| db-hobby | 테이블 락 no-wait, 즉시 에러 |

> **실무/면접 포인트**: "MVCC는 lost update를 어떻게 막나"에 한 줄로 답하면 위험한 이유가 이 표다. 이론의 SI는 first-committer-wins인데 PostgreSQL은 **first-updater-wins**(먼저 행을 갱신한 쪽이 이기고, 뒤에 온 쪽은 대기 후 진행 또는 에러)로 구현했고, InnoDB의 REPEATABLE READ는 아예 감지하지 않아 `SELECT ... FOR UPDATE`나 낙관적 버전 컬럼으로 애플리케이션이 직접 막아야 한다.

**예상 못 한 여파: PK 인덱스가 다중 버전이 되어야 했다.** 여기까지 하고 테스트를 돌리니 스냅샷 시나리오가 깨졌습니다. 범인은 PK 인덱스입니다. 지금까지 유니크라서 UPDATE가 키의 항목을 새 RID로 **덮어썼는데**, 그 순간 **옛 버전으로 가는 인덱스 경로가 끊깁니다.** 스냅샷 reader가 인덱스로 조회하면 빈 결과, 풀스캔으론 보이는 모순이 생깁니다. 답은 PostgreSQL이 이미 알고 있었습니다. **인덱스 컬럼이 바뀌었거나 HOT이 불가능한 UPDATE에서는, 인덱스도 버전마다 항목을 갖는다.** (PostgreSQL은 인덱스 컬럼이 안 바뀌고 같은 페이지에 자리가 있으면 HOT(Heap-Only Tuple) 업데이트로 새 인덱스 항목 없이 힙 안의 버전 체인만 늘리고, 인덱스는 체인의 루트만 가리킵니다. db-hobby엔 HOT이 없으니 모든 UPDATE가 항목을 하나 더 답니다.) PK 인덱스가 한 키에 여러 RID를 매다는 멀티맵(`btree_insert_dup`)이 되고, 조회가 후보들 중 보이는 버전을 고릅니다. [2편](/blog/project/db-hobby/db-internals-02-btree-index)의 부제("인덱스는 왜 단순 key→value가 아닌가")의 답이 이것입니다.

![다중 세션 : 한 트랜잭션이 미커밋 UPDATE를 쥐어도 다른 세션은 옛 버전을 막힘 없이 읽는다](/uploads/project/db-hobby/multi-txn-sessions.svg)

이제 그 장면이 실제로 돕니다:

```
SESSION 0> BEGIN; UPDATE t SET v = 999 WHERE id = 1;   -- 미커밋 쓰기를 쥔 채
SESSION 1> SELECT * FROM t WHERE id = 1;
1 | 100                                                  -- 막히지 않고 옛 버전을 읽는다
SESSION 0> COMMIT;
SESSION 1> SELECT * FROM t WHERE id = 1;
1 | 999                                                  -- (트랜잭션 밖) 이제 새 값
```

**reader가 writer를 안 막는다.** 시연이 아니라 실행입니다.

하나만 선을 그어 두겠습니다. 여기 세운 건 스냅샷 격리(SI)지 SERIALIZABLE이 아닙니다. 두 트랜잭션이 서로의 행을 읽고 **각자 다른 행**을 고치는 write skew(당직 의사 둘이 서로만 남은 걸 확인하고 동시에 퇴근하는 그 시나리오)는 first-updater-wins로도 못 잡습니다. 같은 행을 안 건드리니 충돌 자체가 없습니다. PostgreSQL이 SERIALIZABLE에서 SSI로 이걸 잡는 이야기는 [트랜잭션 ACID ②: Isolation](/blog/theory/transaction-acid-02-isolation)에 있습니다.

## 6. 정리

- **두 철학**: 2PL은 충돌을 막고(락, 교착의 비용), MVCC는 버전을 갈라 피한다(dead tuple과 VACUUM의 비용). 비용 청구 시점이 다르다(실행 중 vs 백그라운드).
- **MVCC의 두뇌는 가시성 규칙 한 줄**: xmin 커밋 AND xmax 미커밋. 트랜잭션 상태 배열(CLOG)과 행 헤더 8바이트가 전부다. **롤백이 공짜**로 나온다.
- **DELETE는 지우지 않는다**: xmax 도장. 그 대가로 힙을 읽는 아홉 갈래 전부에 게이트, 그리고 **"인덱스는 MVCC를 모른다"** 원칙.
- **VACUUM**: dead 판정(커밋된 xmax, 열린 트랜잭션이 있으면 거부하기에 가능한 단순화), 인덱스 (키,RID) 짝 삭제(lazy, PG nbtree도 재분배 안 함), RID 불변 compaction, 꼬리만 truncate(그래서 파일이 잘 안 줄어든다).
- **스냅샷 격리**: reader 락 제거 + BEGIN 스냅샷(xmax/xip) + 쓰기 충돌만 별도 처리(db-hobby는 no-wait 즉시 에러, PG는 first-updater-wins). 여파로 **PK 인덱스가 다중 버전 멀티맵**이 된다.

다음 편은 이 엔진에 **네트워크**를 뚫습니다. 진짜 `psql`이 접속하는 PostgreSQL wire protocol 서버입니다.

## 참고 (1차 자료 우선)

- [PostgreSQL Documentation: MVCC — Concurrency Control](https://www.postgresql.org/docs/current/mvcc.html)
- [PostgreSQL Documentation: Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html): REPEATABLE READ의 스냅샷 시점과 동시 UPDATE 동작의 1차 근거
- [PostgreSQL Documentation: Routine Vacuuming](https://www.postgresql.org/docs/current/routine-vacuuming.html)
- [PostgreSQL Documentation: Heap-Only Tuples (HOT)](https://www.postgresql.org/docs/current/storage-hot.html)
- [MySQL 8.0 Reference: InnoDB Multi-Versioning](https://dev.mysql.com/doc/refman/8.0/en/innodb-multi-versioning.html)
- [MySQL 8.0 Reference: Consistent Nonlocking Reads](https://dev.mysql.com/doc/refman/8.0/en/innodb-consistent-read.html)
- Hal Berenson et al., *A Critique of ANSI SQL Isolation Levels* (SIGMOD 1995): 스냅샷 격리의 고전
- 본 블로그: [트랜잭션 ACID ①: Atomicity](/blog/theory/transaction-acid-01-atomicity) · [②: Isolation](/blog/theory/transaction-acid-02-isolation) · [락 메커니즘 총정리](/blog/theory/lock-mechanisms-all)
- [db-hobby 코드 (GitHub)](https://github.com/dj258255/db-hobby): `mvcc.c` · `lock.c` · `db.c`

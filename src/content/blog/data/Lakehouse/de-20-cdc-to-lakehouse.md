---
title: '[DE] CDC로 레이크하우스 채우기: 조회는 상태를 보고 로그는 변경을 본다'
description: 원천 DB의 변경을 레이크하우스로 옮기는 방법은 updated_at을 주기적으로 조회하는 방식과 DB의 변경 로그를 읽는 방식으로 나뉩니다. 조회 방식은 삭제와 중간 상태를 놓친다는 것을 SQLite로 재현하고 Debezium이 binlog와 WAL을 읽는 구조, 초기 스냅샷, at-least-once 보장, PostgreSQL replication slot이 디스크를 채우는 경로, Iceberg에 upsert로 반영할 때의 조건을 공식 문서와 사례로 정리합니다.
date: 2026-10-19T00:00:00.000Z
tags:
  - Data Engineering
  - CDC
  - Debezium
  - Iceberg
  - PostgreSQL
  - MySQL
  - Lakehouse
category: data/Lakehouse
topics:
  - pipeline
  - database
draft: false
series: "DE 공부"
seriesOrder: 21
---

## 결론부터

1. `updated_at`을 주기적으로 조회하는 CDC는 그 순간의 상태만 봅니다. 두 조회 사이의 중간 변경과 삭제를 놓칩니다. SQLite로 재현했을 때 주문 하나의 pending, paid, shipped 중 shipped만 잡혔고 다음 조회 전에 생겼다 지워진 주문과 한 번 본 뒤 지워진 주문의 삭제는 아예 잡히지 않았습니다.
2. 로그 기반 CDC는 DB가 복구와 복제를 위해 이미 남기는 변경 로그(MySQL binlog, PostgreSQL WAL)를 읽습니다. 모든 변경과 삭제를 순서대로 받고 원천 DB에 조회 부하를 주지 않습니다. Debezium이 대표 도구입니다.
3. Debezium의 기본 보장은 at-least-once이고 내부 중복 제거 계층이 없습니다. 받는 쪽은 기본 키로 upsert해서 멱등하게 반영합니다.
4. PostgreSQL의 replication slot은 소비자가 가져가지 않은 WAL을 지우지 않습니다. 기본 설정(`max_slot_wal_keep_size=-1`)에서는 한도 없이 쌓여 디스크를 채울 수 있습니다.
5. Iceberg에 반영할 때 Flink Iceberg sink는 exactly-once를 보장하고 upsert 모드는 v2 테이블과 식별 필드가 필요합니다. 스트리밍 반영은 작은 파일과 delete 파일을 계속 만들어서 20편의 유지보수가 따라와야 합니다.

---

## 1. 원천 DB에서 레이크하우스로

2편의 수명주기에서 수집 단계에 해당하는 이야기입니다. 주문 서비스의 DB(MySQL, PostgreSQL)에 있는 주문 테이블을 분석용 Iceberg 테이블로 옮긴다고 해 봅시다. 하루 한 번 통째로 복사하면 간단하지만 테이블이 크면 오래 걸리고 하루 동안의 변화는 보이지 않습니다. 바뀐 것만 옮기는 방법이 CDC(Change Data Capture)이고 바뀐 것을 알아내는 방법이 두 가지입니다.

비유하면 이렇습니다. 하나는 10초마다 주문 테이블을 들여다보며 "지난번 이후 바뀐 행 있어?" 하고 묻는 방식입니다(조회 기반). 다른 하나는 DB가 스스로 쓰는 변경 일지를 처음부터 차례로 읽는 방식입니다(로그 기반). 묻는 방식은 물어보는 순간의 모습만 보고 일지를 읽는 방식은 그사이 일어난 일을 전부 봅니다. 이 차이가 2절의 재현에서 그대로 드러나고 3절부터는 일지를 읽는 쪽의 세부(일지의 종류, 처음 시작할 때의 문제, 중복, 디스크)로 내려갑니다.

이 블로그에는 프로젝트에서 CDC를 붙인 글이 이미 있습니다. [WikiEngine의 CDC 이벤트 동기화](/blog/project/wikiengine/cdc), [기본값 때문에 139배 느렸던 CDC](/blog/project/be-commerce/be-commerce-ch35-cdc-default-was-slow), [RUNNING인 채 5분 동안 아무것도 보내지 않은 커넥터](/blog/project/be-commerce/be-commerce-ch49-cdc-running-not-flowing)가 그 경험입니다. 이 글은 방식 자체를 비교합니다.

## 2. 조회 기반 CDC가 놓치는 것

### 2-1. 재현

SQLite 테이블 하나에 주문 변경을 일으키고 두 방식을 나란히 돌렸습니다([labs/de-study/ch20](https://github.com/dj258255/IT-Oasis/tree/main/labs/de-study/ch20)의 `cdc_poll_vs_log.py`).

- 조회 기반: 10초마다 `updated_at > 마지막 조회 시각`인 행을 가져갑니다.
- 로그 기반 흉내: 트리거로 모든 INSERT, UPDATE, DELETE를 변경 로그 테이블에 남기고 그걸 읽습니다.

| 시각 | 원천 DB의 변경 |
|---|---|
| 1초 | 주문 1 생성(pending) |
| 3초 | 주문 1 결제(paid) |
| 5초 | 주문 1 출고(shipped) |
| 12초 | 주문 2 생성 |
| 15초 | 주문 2 삭제 |
| 22초 | 주문 3 생성 |
| 31초 | 주문 3 삭제 |

| 방식 | 받은 것 |
|---|---|
| 조회 기반 | 10초: 주문 1 shipped / 30초: 주문 3 pending |
| 로그 기반 | 주문 1 생성, paid, shipped / 주문 2 생성, 삭제 / 주문 3 생성, 삭제 |

조회 쪽 코드의 핵심은 한 줄입니다.

```python
rows = db.execute("SELECT id, status, updated_at FROM orders WHERE updated_at > ? ORDER BY id", [last_poll]).fetchall()
```

"마지막으로 조회한 시각 이후에 고쳐진 행"을 가져오고 조회가 끝나면 `last_poll`을 지금 시각으로 옮깁니다. 이 질의를 시각마다 따라가면 결과가 왜 그렇게 나왔는지 보입니다.

| 조회 시각 | 조건 | 그 순간 테이블에 있는 행 | 받은 것 |
|---|---|---|---|
| 10초 | `updated_at > 0` | 주문 1(shipped, 5초) | 주문 1 shipped |
| 20초 | `updated_at > 10` | 주문 1(5초). 주문 2는 15초에 지워져 없음 | 없음 |
| 30초 | `updated_at > 20` | 주문 1, 주문 3(pending, 22초) | 주문 3 pending |
| 40초 | `updated_at > 30` | 주문 1. 주문 3은 31초에 지워져 없음 | 없음 |

로그 쪽은 SQLite 트리거 세 개(INSERT, UPDATE, DELETE마다 하나)가 변경이 일어날 때마다 `changelog` 테이블에 한 줄씩 적습니다. 실제 DB의 binlog나 WAL처럼 "일어난 일을 순서대로 적은 일지"를 흉내 낸 것입니다.

![같은 7번의 변경을 조회 기반과 로그 기반이 각각 무엇으로 받는지 시간축으로 그린 그림. 원천 DB에서는 1, 3, 5초에 주문 1이 pending, paid, shipped로 바뀌고 12초에 주문 2 생성, 15초에 삭제, 22초에 주문 3 생성, 31초에 삭제가 일어난다. 10초마다 도는 조회는 10초에 주문 1 shipped, 30초에 주문 3 pending만 받고 20초와 40초에는 아무것도 받지 못한다. 로그 기반은 일곱 개 변경을 순서대로 모두 받는다](/uploads/data/de-20-cdc-to-lakehouse/poll-vs-log-timeline.svg)

조회 기반이 놓친 것은 셋입니다.

- 중간 상태: 주문 1이 결제됐다는 사실(paid)은 10초 조회 전에 shipped로 덮여 사라졌습니다. "결제 후 출고까지 걸린 시간" 같은 분석이 불가능합니다.
- 조회 사이에 생겼다 사라진 행: 주문 2는 한 번도 보지 못했습니다.
- 삭제: 주문 3은 pending으로 받아 갔는데 31초의 삭제는 받지 못했습니다. 레이크하우스에는 주문 3이 계속 남습니다.

### 2-2. 문서와 사례

Debezium 블로그의 "Five Advantages of Log-Based Change Data Capture"(Gunnar Morling, 2018)가 같은 세 가지를 짚습니다. 조회 방식은 마지막 조회 이후 삭제된 레코드를 알 수 없고 두 조회 사이의 중간 변경을 놓칠 수 있으며 자주 조회하면 그 쿼리가 원천 DB에 부하를 줍니다.

넥스트리의 2026년 글 "Logstash에서 Debezium CDC로 전환한 이유"는 Logstash JDBC로 `modified_on` 컬럼을 1분마다 조회하다 삭제가 반영되지 않는 문제를 겪었습니다. 행이 지워지면 조회 결과에서 조용히 빠질 뿐이고 삭제됐다는 사실은 어디에도 남지 않는다고 적었고 insert와 update만 테스트해서 놓쳤다고 했습니다.

삭제를 잡으려고 원천 테이블에 삭제 표시 컬럼(soft delete)을 두는 방법도 있지만 원천 서비스의 코드를 바꿔야 하고 중간 상태 문제는 그대로입니다.

## 3. 로그 기반 CDC: Debezium

### 3-1. 원천 DB별 준비

DB는 장애 복구와 복제를 위해 모든 변경을 로그로 남깁니다. Debezium은 이 로그를 복제본처럼 읽습니다.

두 로그가 무엇인지 먼저 짚어 둡니다.

- **PostgreSQL WAL(Write-Ahead Log)**: 이름 그대로 "먼저 쓰는 로그"입니다. 주문 행을 고칠 때 PostgreSQL은 데이터 파일을 고치기 전에 "어떤 행을 어떻게 바꿨다"를 WAL에 먼저 적습니다. 서버가 갑자기 꺼져도 다시 켜질 때 WAL을 읽어 고치던 작업을 마저 반영할 수 있고([PostgreSQL, Write-Ahead Logging](https://www.postgresql.org/docs/current/wal-intro.html)) 복제본 서버도 이 WAL을 받아 똑같이 따라 합니다. WAL의 위치는 LSN(Log Sequence Number)이라는 계속 커지는 번호로 가리킵니다. 4절에서 이 번호가 다시 나옵니다.
- **MySQL binlog**: MySQL이 복제와 특정 시점 복구를 위해 남기는 변경 기록입니다. 복제본은 원본의 binlog를 받아 같은 변경을 적용합니다.

Debezium이 하는 일은 결국 "복제본인 척하고 이 일지를 받아 와서 Kafka 메시지로 바꾸는 것"입니다.

| DB | 읽는 로그 | Debezium 문서의 요구 조건 |
|---|---|---|
| MySQL | binlog | `binlog_format=ROW`, `binlog_row_image=FULL` |
| PostgreSQL | WAL(logical decoding) | 출력 플러그인 pgoutput(PostgreSQL 10+ 기본 포함). replication slot을 하나 만든다. DDL 변경은 logical decoding이 지원하지 않는다 |

MySQL 쪽 두 설정이 왜 필요한지는 예를 보면 바로 보입니다. `binlog_format`이 `STATEMENT`면 binlog에 `UPDATE orders SET status='cancelled' WHERE created_at < '2026-10-01'` 같은 SQL 문장 자체가 적힙니다. 이걸로는 어느 주문 몇 건이 바뀌었는지 알 수 없습니다. `ROW`로 두면 실제로 바뀐 행 하나하나가 적힙니다([MySQL, Replication Formats](https://dev.mysql.com/doc/refman/8.4/en/replication-formats.html)). `binlog_row_image=FULL`은 그 행의 바꾸기 전과 후 값을 모든 컬럼에 대해 남기라는 설정입니다. `MINIMAL`로 줄이면 행을 찾는 데 필요한 컬럼과 바뀐 컬럼만 적혀서 Debezium 이벤트의 `before`, `after`에도 일부 컬럼만 들어옵니다([MySQL, binlog_row_image](https://dev.mysql.com/doc/refman/8.4/en/replication-options-binary-log.html)).

PostgreSQL에서는 `REPLICA IDENTITY`가 기본값이면 update 이벤트의 `before`에 기본 키만 들어갑니다. 변경 전 값 전체가 필요하면 테이블을 `REPLICA IDENTITY FULL`로 바꿔야 합니다. 주문 1을 pending에서 paid로 바꾼 이벤트라면 기본값에서는 `before`가 `{"id": 1}`뿐이라 "원래 pending이었다"는 사실을 이벤트만으로는 모릅니다. FULL이면 `before`에 `{"id": 1, "status": "pending", ...}`이 다 들어옵니다. 그 대신 WAL에 행 전체를 한 번 더 적으니 WAL이 커집니다.

### 3-2. 변경 이벤트

```json
{
  "before": {"id": 1, "status": "pending"},
  "after":  {"id": 1, "status": "paid"},
  "source": {"db": "shop", "table": "orders", "...": "..."},
  "op": "u",
  "ts_ms": 1760000000000
}
```

| op | 뜻 |
|---|---|
| `c` | 생성 |
| `u` | 수정 |
| `d` | 삭제(`after`가 null) |
| `r` | 초기 스냅샷으로 읽은 행 |

삭제 이벤트 뒤에는 같은 키에 값이 null인 tombstone 이벤트가 하나 더 붙습니다(`tombstones.on.delete` 기본 true). 12편의 log compaction이 이 tombstone을 보고 그 키의 이전 메시지를 지웁니다. 이벤트의 키는 테이블의 기본 키라서 같은 행의 변경은 같은 Kafka 파티션에 순서대로 들어갑니다.

주문 3의 일생으로 보면 이렇게 됩니다.

```
키 {id:3}  값 {op:"c", after:{id:3, status:"pending"}}
키 {id:3}  값 {op:"d", before:{id:3}, after:null}
키 {id:3}  값 null                      ← tombstone
```

log compaction은 키마다 마지막 값만 남기고 앞의 메시지를 지우는 Kafka 기능입니다. 마지막 값이 null(tombstone)이면 일정 시간 뒤 그 키 자체를 지웁니다. 그래서 compaction을 켠 토픽을 처음부터 읽는 새 소비자는 "지금 살아 있는 주문"만 보게 되고 지워진 주문 3은 보이지 않습니다. tombstone 없이 `op:"d"` 메시지만 있었다면 그 메시지가 마지막 값으로 영원히 남습니다.

### 3-3. 초기 스냅샷

로그는 과거 전부를 담고 있지 않습니다. 그래서 처음 시작할 때 테이블 전체를 한 번 읽고(스냅샷) 그 뒤부터 로그를 따라갑니다. `snapshot.mode`로 정합니다. 기본값은 `initial`이고 스냅샷 없이 지금부터의 변경만 읽는 `no_data` 등이 있습니다.

토스증권의 2024년 글 "대규모 CDC Pipeline 운영을 위한 Debezium 개선 여정"은 이 단계가 단일 스레드로 처리되어 경우에 따라 11~12시간까지 걸렸다고 적었습니다. 초기 적재는 다른 도구(Sqoop)로 하고 Debezium은 `no_data` 모드로 띄우는 방식으로 바꾸고 테이블 추가용 모드를 직접 만들어 최대 12시간이던 작업을 테이블 추가는 1시간, 확장은 5분 안으로 줄였다고 했습니다.

Debezium은 이후 incremental snapshot을 넣었습니다(DDD-3). Netflix의 DBLog 논문 방식을 따라, 테이블을 기본 키 기준 청크로 나눠 읽으면서 로그 수집을 멈추지 않고 중간에 멈췄다 이어서 할 수 있습니다. signal 테이블에 INSERT를 넣어 실행합니다.

여기서 막히는 지점은 "테이블을 읽는 동안에도 변경이 계속 들어오는데 둘이 섞이면 어느 쪽이 맞나"입니다. 청크로 읽은 값이 그사이 바뀐 행의 옛 값일 수 있기 때문입니다. DBLog 논문은 워터마크 두 개로 이 문제를 풉니다.

1. 로그 처리를 아주 잠깐 멈추고 워터마크 테이블에 "낮은 워터마크(lw)"를 씁니다. 이 쓰기도 변경이라 로그에 남습니다.
2. 주문 테이블에서 다음 청크(예: 주문 번호 1~1,000)를 읽어 메모리에 둡니다.
3. "높은 워터마크(hw)"를 쓰고 로그 처리를 다시 엽니다.
4. 로그를 읽다가 lw와 hw 사이에서 주문 7의 변경 이벤트를 만나면 메모리의 청크에서 주문 7을 뺍니다. 이벤트 자체는 그대로 내보냅니다.
5. hw에 닿으면 청크에 남은 행을 내보냅니다.

주문 7은 청크로 읽은 값이 옛 값일 수 있으니 버리고 로그의 최신 변경을 믿는 것입니다. 청크를 읽은 정확한 시점은 몰라도 "lw와 hw 사이 어딘가"라는 것은 확실하니 그 구간에 변경이 있던 행만 빼면 순서가 꼬이지 않습니다([DBLog 논문](https://arxiv.org/abs/2010.12597)).

### 3-4. 전달 보장

Debezium 문서는 이렇게 적습니다. Debezium은 at-least-once 전달을 보장하고 exactly-once를 위한 내부 중복 제거 계층은 구현하지 않는다. PostgreSQL 커넥터 문서는 두 경우를 듭니다. Kafka Connect 프로세스가 갑자기 죽으면 태스크가 마지막으로 기록된 오프셋부터 다시 시작해 직전에 보낸 이벤트를 또 보낼 수 있습니다. 신호로 띄운 블로킹 스냅샷이 끝난 직후에는 스냅샷이 이미 담은 레코드와 겹치는 이벤트를 내보낼 수 있습니다.

Kafka Connect 3.3 이상을 분산 모드로 띄우고 worker와 커넥터에 exactly-once 설정을 켜면 일부 커넥터(MySQL, PostgreSQL 등)는 exactly-once로 쓸 수 있습니다. 조건이 여럿이라 받는 쪽은 중복이 올 수 있다고 보고 기본 키로 upsert하는 구성이 흔합니다(14편).

중복이 어디서 생기는지 한 번 따라가 보겠습니다. 커넥터는 이벤트를 Kafka에 보내고 "여기까지 보냈다"는 위치(오프셋)를 주기적으로 따로 저장합니다.

| 순서 | 일어나는 일 |
|---|---|
| 1 | 주문 1 paid, 주문 1 shipped 두 이벤트를 Kafka에 보냈다 |
| 2 | 위치를 저장하기 직전에 커넥터가 죽었다. 저장된 위치는 paid 이전이다 |
| 3 | 재시작한 커넥터가 저장된 위치부터 다시 읽어 paid, shipped를 또 보낸다 |

받는 쪽에는 paid, shipped, paid, shipped가 옵니다. append로 쌓으면 주문 1의 행이 네 개가 되지만 기본 키로 upsert하면 마지막 shipped가 남아 한 번만 받은 것과 결과가 같습니다. 다만 순서대로 와야 마지막이 맞으니 같은 키가 같은 파티션에 순서대로 들어간다는 3-2절의 성질이 여기서 같이 쓰입니다.

## 4. replication slot이 디스크를 채우는 경로

PostgreSQL의 replication slot은 소비자가 확인한 위치를 기억하고 그 이후의 WAL을 지우지 않습니다. 소비자가 멈춰도 마찬가지입니다.

slot은 책갈피와 같습니다. PostgreSQL은 평소 오래된 WAL 파일을 재활용하는데 책갈피가 꽂힌 곳부터 뒤쪽은 소비자가 아직 안 읽었을 수 있으니 지우지 않습니다. 책갈피 위치를 가리키는 값이 두 개 있습니다.

- `confirmed_flush_lsn`: 소비자(Debezium)가 "여기까지 받아서 처리했다"고 알려 온 위치입니다.
- `restart_lsn`: slot이 다시 시작할 때 필요할 수 있는 가장 오래된 위치입니다. 진행 중이던 긴 트랜잭션을 처음부터 다시 풀어야 할 수도 있어서 보통 `confirmed_flush_lsn`보다 조금 앞에 있습니다. 서버가 실제로 남겨 두는 WAL의 시작점이 이 값입니다.

![replication slot이 붙드는 WAL을 그린 그림. WAL 세그먼트가 시간순으로 놓여 있고 restart_lsn 왼쪽은 재활용 가능, restart_lsn부터 pg_current_wal_lsn()까지는 지우지 못하는 구간이다. confirmed_flush_lsn은 그 사이에 있다. 아래에는 커넥터가 멈췄을 때와 커넥터는 살아 있지만 추적 테이블이 조용할 때 두 경우에 이 구간이 늘어난다고 적혀 있다](/uploads/data/de-20-cdc-to-lakehouse/replication-slot.svg)

지금 slot마다 WAL을 얼마나 붙들고 있는지는 이렇게 봅니다.

```sql
SELECT slot_name,
       active,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained_wal
FROM pg_replication_slots;
```

`pg_current_wal_lsn()`은 지금 DB가 쓰고 있는 위치이고 `pg_wal_lsn_diff`는 두 위치 사이의 바이트 수입니다. 그림의 주황 구간 크기가 `retained_wal`입니다. Gunnar Morling은 이 값과 함께 slot이 30분 넘게 비활성인지, 디스크 사용률이 60~70%를 넘는지를 경보 기준의 출발점으로 제안합니다([Mastering Postgres Replication Slots](https://www.morling.dev/blog/mastering-postgres-replication-slots/)).

PostgreSQL 문서의 문장입니다.

- replication slot 때문에 서버가 WAL 세그먼트를 너무 많이 붙들어 `pg_wal` 공간을 채울 수 있다. `max_slot_wal_keep_size`로 한도를 둘 수 있다.
- `max_slot_wal_keep_size`가 -1(기본값)이면 replication slot이 붙드는 WAL에 한도가 없다. 한도를 넘으면 그 slot은 필요한 WAL이 지워져 복제를 계속할 수 없게 될 수 있다.
- slot은 소비자의 상태를 모르고 필요 없는 slot은 지워야 한다. 극단적인 경우 VACUUM이 오래된 행을 정리하지 못해 트랜잭션 ID 고갈을 막으려고 DB가 멈출 수 있다.

한도를 두면 디스크는 지키지만 slot이 무효화되어 CDC를 처음부터 다시 맞춰야 합니다. 한도가 없으면 CDC는 이어지지만 디스크가 찰 수 있습니다. 어느 쪽이든 slot의 지연을 감시해야 합니다(`pg_replication_slots`의 `confirmed_flush_lsn`, `restart_lsn`).

소비자가 살아 있는데도 WAL이 쌓이는 경우가 있습니다. Debezium 문서는 추적하는 테이블의 변경은 드문데 DB 전체 변경이 많으면 커넥터가 확인할 위치를 앞으로 옮길 이벤트가 없어 이미 처리한 WAL이 남는다고 설명하고 `heartbeat.interval.ms`와 `heartbeat.action.query`를 해결책으로 듭니다.

쇼핑몰로 바꾸면 이런 상황입니다. Debezium은 주문 테이블만 추적하는데 같은 서버의 접속 로그 테이블에 초당 수천 건이 쌓입니다. WAL은 서버 전체가 함께 쓰니 접속 로그의 변경도 전부 WAL에 들어갑니다. 새벽에 주문이 몇 시간 동안 하나도 없으면 Debezium은 WAL을 읽기는 하지만 내보낼 주문 이벤트가 없어 "여기까지 처리했다"는 확인을 보낼 계기가 없습니다. 그동안 쌓인 접속 로그 WAL이 고스란히 남습니다. Morling은 PostgreSQL 인스턴스 하나에 DB가 여럿이고 그중 조용한 DB에 slot이 있는 경우도 같은 모양이라고 설명합니다. WAL은 인스턴스 전체가 공유하는데 slot은 DB 단위이기 때문입니다.

heartbeat는 일부러 작은 변경을 주기적으로 만들어 확인 위치를 앞으로 미는 방법입니다. PostgreSQL 14부터는 테이블을 만들지 않고 WAL에 메시지만 남기는 `pg_logical_emit_message`를 heartbeat로 쓸 수 있습니다(함수 자체는 9.6부터 있었고 pgoutput이 이 메시지를 소비자에게 넘겨주는 것이 14부터입니다).

```properties
heartbeat.interval.ms=60000
heartbeat.action.query=SELECT pg_logical_emit_message(false, 'heartbeat', now()::varchar)
```

1분마다 WAL에 작은 메시지를 하나 쓰고 Debezium이 그것을 읽으면서 확인 위치가 함께 전진합니다. 이 방식은 커넥터 계정에 그 함수의 실행 권한이 있어야 합니다([Morling](https://www.morling.dev/blog/mastering-postgres-replication-slots/)). Zalando의 2025년 글은 활동이 적은 DB에서 테이블 변경이 없으면 slot이 앞으로 가지 않아 WAL이 디스크가 바닥날 때까지 쌓였고 heartbeat를 설정했는데도 이것이 가장 큰 운영 문제였다고 적었습니다. 이 문제를 Debezium에 고쳐 넣었고 3.4.0에 `lsn.flush.mode=connector_and_driver`로 들어갔습니다.

## 5. 레이크하우스에 반영하기

### 5-1. upsert

변경 이벤트를 Iceberg 테이블에 반영하는 것은 기본 키로 upsert하는 일입니다. 생성과 수정은 그 키의 행을 새 값으로 바꾸고 삭제는 그 키의 행을 지웁니다.

| 방법 | 공식 문서에서 확인한 것 |
|---|---|
| Spark `MERGE INTO` | 바뀔 행이 든 데이터 파일을 다시 써서 overwrite 커밋으로 반영한다. `INSERT OVERWRITE` 대신 권장한다 |
| Flink Iceberg sink | exactly-once를 보장한다. upsert 모드는 v2 테이블과 식별 필드(기본 키)가 필요하고 파티션 테이블이면 파티션 컬럼도 식별 필드에 들어가야 한다. 커밋은 Flink 체크포인트가 끝난 뒤 일어난다 |
| Flink CDC Iceberg pipeline 커넥터 | exactly-once를 지원하지 않고 at-least-once와 기본 키 멱등 쓰기로 동작한다. 기본 키 없는 테이블은 지원하지 않는다 |
| Iceberg Kafka Connect sink | exactly-once 전달, 중앙에서 커밋을 조정한다. 커밋 간격 기본 5분. CDC와 upsert 모드는 원래 Tabular 저장소 문서에 있던 설정(`iceberg.tables.cdc-field`, `iceberg.tables.upsert-mode-enabled`)으로 확인했고 Apache 문서의 설정 표에서는 찾지 못했다 |

Flink 쪽 두 줄의 차이를 구분해야 합니다. 같은 Iceberg로 쓰는데 Iceberg Flink sink는 exactly-once이고 Flink CDC pipeline 커넥터는 at-least-once에 기본 키 멱등성입니다. 어느 쪽이든 결과 테이블이 정확하려면 기본 키가 있어야 합니다.

Delta Lake 문서도 외부 DB의 변경을 반영하는 용도로 MERGE를 들면서 원천의 여러 행이 대상의 한 행에 맞으면 실패할 수 있으니 키마다 한 행만 남기도록 미리 정리하라고 권합니다. 한 배치 안에 같은 주문의 pending, paid, shipped가 다 들어 있다면 마지막 것만 남겨서 MERGE해야 합니다. 2-1절의 로그가 순서를 지켜 주기 때문에 "마지막 것"을 정할 수 있습니다.

Spark에서 쓰면 이런 모양이 됩니다. `changes`는 이번 배치에 들어온 변경 이벤트를 펼친 표이고 `op`, `id`, 바뀐 뒤 컬럼들, 로그 위치(`source_lsn`)가 들어 있다고 가정한 예시입니다(직접 돌리지 않았습니다).

```sql
MERGE INTO lake.orders AS t
USING (
  SELECT * FROM (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY id ORDER BY source_lsn DESC) AS rn
    FROM changes
  ) WHERE rn = 1                                -- 주문마다 가장 늦은 변경 하나만
) AS s
ON t.id = s.id
WHEN MATCHED AND s.op = 'd' THEN DELETE         -- 마지막이 삭제면 지운다
WHEN MATCHED THEN UPDATE SET *                  -- 있으면 새 값으로
WHEN NOT MATCHED AND s.op != 'd' THEN INSERT *  -- 없으면 넣는다
```

`ROW_NUMBER() ... ORDER BY source_lsn DESC`가 "같은 주문의 변경 중 로그에서 가장 뒤에 있는 것에 1번을 매기라"는 뜻이고 `rn = 1`로 그것만 남깁니다. 주문 1의 pending, paid, shipped가 한 배치에 왔다면 shipped 하나만 MERGE에 들어갑니다. 마지막 줄의 `s.op != 'd'`는 이 배치 안에서 생겼다 지워진 주문(2-1절의 주문 2)을 넣지 않으려는 조건입니다.

Flink upsert 쪽은 같은 일을 Iceberg의 삭제 파일로 합니다. 주문 1이 pending으로 들어간 뒤 shipped로 바뀌면 이렇게 쌓입니다.

| 커밋 | 쓰는 파일 | 읽을 때 보이는 주문 1 |
|---|---|---|
| 1 | 데이터 파일 F1: `(1, pending)` | pending |
| 2 | 데이터 파일 F2: `(1, shipped)`, equality delete D1: `id = 1` | D1이 F1의 pending을 가리고 F2의 shipped만 보임 |

D1은 시퀀스 번호가 더 작은 F1에만 적용되고 같은 커밋의 F2에는 적용되지 않습니다([19편 5절](/blog/data/lakehouse/de-18-iceberg-table-format#5-행-단위-삭제)의 규칙). 쓰는 쪽은 F1을 열어 볼 필요가 없어 빠르지만 읽는 쪽은 F1을 읽을 때마다 D1과 맞춰 봐야 합니다. 이런 삭제 파일이 커밋마다 쌓이는 것이 다음 절의 부산물입니다([RisingWave](https://risingwave.com/blog/cdc-to-iceberg-upsert-delete/)의 설명을 주문 예로 다시 썼습니다).

### 5-2. 스트리밍 반영의 부산물

Flink upsert는 쓸 때마다 이전 값을 지우는 equality delete 파일을 만듭니다. Iceberg 유지보수 문서는 스트리밍 쿼리가 작은 데이터 파일을 만들어 합쳐야 하고 커밋이 잦은 테이블은 메타데이터 파일을 주기적으로 정리해야 한다고 적습니다. 반영이 잘 돌아가는 동안에도 읽기는 점점 느려질 수 있어서 20편의 컴팩션과 스냅샷 만료가 CDC 파이프라인의 일부가 됩니다.

## 6. outbox 패턴

원천 서비스가 DB 테이블 대신 이벤트를 내보내고 싶을 때도 같은 구조를 씁니다. Debezium 문서는 outbox 패턴을 서비스의 내부 상태(DB)와 다른 서비스가 받는 이벤트 사이의 불일치를 피하는 방법으로 설명합니다. 서비스는 주문을 저장하는 트랜잭션 안에서 outbox 테이블에 이벤트 행을 함께 넣고 Debezium이 그 테이블의 변경을 읽어 Kafka로 보냅니다. DB 저장과 이벤트 발행이 한 트랜잭션으로 묶이니 "저장은 됐는데 이벤트는 못 보냄"이 생기지 않습니다.

outbox 없이 하면 무엇이 문제인지부터 보겠습니다. 결제 서비스가 주문을 paid로 저장하고 이어서 Kafka에 "결제 완료" 이벤트를 보낸다고 합시다. 저장은 성공했는데 이벤트를 보내기 직전에 서버가 죽으면 DB에는 결제가 됐는데 배송 서비스는 그 사실을 영영 모릅니다. 순서를 바꿔 이벤트를 먼저 보내면 반대로 이벤트는 갔는데 저장이 롤백되는 경우가 생깁니다. DB와 Kafka는 서로 다른 시스템이라 둘을 한 번에 성공시키거나 한 번에 실패시킬 방법이 없습니다. 이것을 이중 쓰기(dual write) 문제라고 부릅니다([AWS 기술 블로그, 클라우드 디자인 패턴 5부](https://aws.amazon.com/ko/blogs/tech/cloud-design-patterns-on-aws-5/)).

outbox는 "보낼 이벤트"도 DB 행으로 만들어 같은 트랜잭션에 넣는 것으로 이 문제를 DB 하나 안으로 가져옵니다.

```sql
BEGIN;
UPDATE orders SET status = 'paid' WHERE id = 101;
INSERT INTO outbox (id, aggregatetype, aggregateid, type, payload)
VALUES ('6f1c…', 'order', '101', 'OrderPaid', '{"orderId": 101, "amount": 30000}');
COMMIT;
```

두 문장이 함께 커밋되거나 함께 롤백됩니다. Debezium은 `outbox` 테이블에 생긴 행을 WAL에서 읽어 Kafka로 보내고 Outbox Event Router가 `aggregatetype`(여기서는 order)으로 토픽을, `aggregateid`(주문 번호)로 메시지 키를 정합니다. 컬럼 이름은 Outbox Event Router의 기본값을 따랐습니다. Debezium이 at-least-once라 이벤트가 두 번 갈 수 있다는 점은 그대로이니 받는 서비스는 `id`로 이미 처리한 이벤트를 걸러야 합니다.

## 7. 중국과 국내 빅테크 사례

### 7-1. Alibaba에서 나온 CDC 도구: Canal과 Flink CDC

로그 기반 CDC 도구 둘이 Alibaba에서 나왔습니다.

- **Canal**: README에 따르면 Alibaba는 항저우와 미국 두 데이터센터 사이 동기화가 필요했고 처음에는 업무 트리거로 증분 변경을 얻다가 2010년부터 DB 로그를 해석하는 방식으로 옮겼습니다. Canal은 MySQL 복제본의 통신 규약을 흉내 내 자신을 복제본으로 위장하고 MySQL에 binlog 전송(dump)을 요청합니다. 3-1절의 "복제본처럼 로그를 읽는다"를 그대로 구현한 것입니다.
- **Flink CDC**: 2020년 7월 개인 관심 프로젝트로 시작해 Ververica 저장소의 오픈소스가 됐고 이후 Apache Flink 하위 프로젝트로 기증됐습니다. 2021년 "Flink CDC 2.0 正式发布，详解核心改进"은 1.x의 문제를 셋으로 꼽았습니다. Debezium 방식이라 스냅샷 때 전역 락이나 테이블 락이 필요했고(DBA가 락 권한을 잘 주지 않음) 스냅샷을 병렬로 읽지 못했고 스냅샷 단계에서 체크포인트를 못 했습니다. 2.0은 3-3절의 incremental snapshot과 같은 DBLog 알고리즘을 단순화해 기본 키 범위 청크로 나눠 락 없이 병렬로 읽습니다. TPC-DS customer 테이블(약 6,500만 행, 병렬도 8, 스냅샷 단계만)에서 1.4가 89분, 2.0이 13분이었습니다.

### 7-2. 레이크 포맷 이전과 이후의 upsert

Meituan의 2018년 글 "美团DB数据同步到数据仓库的架构与实践"은 Canal로 MySQL binlog를 Kafka에 보내고 매시간 Hive ODS로 옮겼습니다. 최초 스냅샷 뒤로는 매일 기본 키로 병합해 원래 테이블에 `INSERT OVERWRITE`로 다시 썼고 Hive가 DELETE를 지원하지 않아 삭제는 left outer join으로 처리했습니다. 5-1절의 upsert를 테이블 전체 다시 쓰기로 하던 시대의 방식입니다.

레이크 포맷 이후의 사례입니다.

| 회사 | 내용 |
|---|---|
| 快手(Hudi, 2023) | 갱신 지원과 커뮤니티를 이유로 Hudi를 골랐습니다. MySQL CDC를 날짜 파티션 없는 Hudi 테이블에 써서 매일 하던 전체 스냅샷 병합을 대체했고 같은 자원으로 로그 입수 시효가 1시간 40분에서 40분이 됐습니다. 쓰기 작업이 도는 동안 병합 계획을 만들면 데이터를 잃을 위험이 있다는 한계도 적었습니다 |
| B站(Hudi, 2023) | DB 데이터를 Canal이나 Flink CDC로 Hudi에 씁니다. 다만 실시간으로 갱신되는 테이블은 같은 쿼리를 다시 읽을 때 같은 결과가 보장되지 않아 ETL 입력으로는 맞지 않았다고 적었습니다 |
| ByteDance(Hudi) | 영상 메타데이터를 일 단위 MySQL·Redis 덤프에서 시간 단위 Hudi upsert로 바꿔 피크 자원을 40% 줄이고 데이터 준비 시점을 약 3.5시간 앞당겼습니다 |

### 7-3. 국내: 카카오, LINE, 토스

- **카카오**(2024): 매일 MySQL 전체를 배치로 가져오다 DB 디스크 사용률이 100%에 닿는 문제를 Flink CDC와 Iceberg로 풀었습니다. 2절의 "조회 기반은 원천 DB에 부하를 준다"가 전체 복사에서 더 크게 나타난 경우입니다.
- **LINE Plus**: Flink Iceberg 싱크의 upsert로 반영 주기를 60분에서 5분으로 줄였습니다. 식별 필드(identifier field)를 빠뜨리자 행이 중복되고 equality delete 파일이 비대해졌다고 적었습니다. 5-1절의 "upsert 모드는 식별 필드가 필요하다"를 놓쳤을 때의 결과입니다.
- **토스**(2024): Kafka Connect 기반 입수 자동화로 약 1,000개의 파이프라인을 세 명이 관리합니다. 기존 CDC 저장소(Kudu)는 큰 테이블에서 적재 지연이 컸다고 적었습니다.

## 8. 범위와 한계

- 2-1절은 SQLite 트리거로 로그 기반 CDC를 흉내 낸 것입니다. 실제 binlog나 WAL을 읽지 않았습니다.
- 3-4절의 중복 순서표, 4절의 접속 로그 상황, 5-1절의 MERGE 문, 6절의 outbox 문은 원리를 보이려고 만든 예이고 직접 돌리지 않았습니다.
- Debezium과 Kafka Connect를 띄워 재현하지는 않았습니다. 3~4절은 Debezium과 PostgreSQL 문서 사례 글 기준입니다.
- Iceberg 문서는 GitHub main 브랜치 원문 기준이라 릴리스 버전과 다를 수 있습니다.
- 스트리밍 upsert로 delete 파일이 쌓일 때 읽기가 얼마나 느려지는지 수치는 찾지 못했습니다.

## 9. 헷갈렸던 것

**Q. 조회 기반도 updated_at 인덱스만 있으면 부하가 작지 않나요?**

부하는 줄일 수 있어도 2-1절의 세 가지 누락은 그대로입니다. 매 조회가 "지금 상태"를 보는 방식이라 그 사이의 변경과 삭제는 구조적으로 보이지 않습니다. 하루 한 번 최종 상태만 필요하고 삭제가 없는 테이블이라면 조회 기반으로 충분할 수 있습니다.

**Q. Debezium이 at-least-once면 레이크하우스에 중복 행이 생기나요?**

append로 쌓으면 생깁니다. 기본 키로 upsert하면 같은 변경이 두 번 와도 결과 행은 같습니다. 4편의 멱등성이 여기서도 마지막 방어선입니다.

**Q. replication slot 감시는 무엇을 보면 되나요?**

slot이 붙들고 있는 WAL 크기와 소비자가 확인한 위치가 앞으로 가는지를 봅니다. 소비자가 멈췄는데 slot이 남아 있으면 지워야 하고 소비자가 살아 있는데도 위치가 멈춰 있으면 4절의 heartbeat 문제를 의심합니다.

## 참고 자료

공식 문서
- Debezium, [connector for MySQL](https://debezium.io/documentation/reference/stable/connectors/mysql.html), [connector for PostgreSQL](https://debezium.io/documentation/reference/stable/connectors/postgresql.html), [Exactly-once delivery](https://debezium.io/documentation/reference/stable/configuration/eos.html), [FAQ](https://debezium.io/documentation/faq/), [Outbox Event Router](https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html)
- Debezium, [DDD-3: Incremental snapshotting](https://github.com/debezium/debezium-design-documents/blob/main/DDD-3.md)
- Andreas Andreakis, Ioannis Papapanagiotou, [DBLog: A Watermark Based Change-Data-Capture Framework](https://arxiv.org/abs/2010.12597), Netflix, 2020
- MySQL, [Replication Formats](https://dev.mysql.com/doc/refman/8.4/en/replication-formats.html), [Binary Logging Options and Variables](https://dev.mysql.com/doc/refman/8.4/en/replication-options-binary-log.html)
- PostgreSQL, [Write-Ahead Logging](https://www.postgresql.org/docs/current/wal-intro.html), [Replication Slots](https://www.postgresql.org/docs/current/warm-standby.html), [Replication 설정](https://www.postgresql.org/docs/current/runtime-config-replication.html), [Logical Decoding Concepts](https://www.postgresql.org/docs/current/logicaldecoding-explanation.html)
- Apache Iceberg, [Spark writes](https://github.com/apache/iceberg/blob/main/docs/docs/spark-writes.md), [Flink writes](https://github.com/apache/iceberg/blob/main/docs/docs/flink-writes.md), [Maintenance](https://github.com/apache/iceberg/blob/main/docs/docs/maintenance.md), [Kafka Connect](https://iceberg.apache.org/docs/latest/kafka-connect/)
- Apache Flink CDC, [Iceberg pipeline connector](https://nightlies.apache.org/flink/flink-cdc-docs-stable/docs/connectors/pipeline-connectors/iceberg/)
- Delta Lake, [Table deletes, updates, and merges](https://docs.delta.io/latest/delta-update.html)
- Tabular, [iceberg-kafka-connect](https://github.com/tabular-io/iceberg-kafka-connect)

글과 사례
- Gunnar Morling, [Five Advantages of Log-Based Change Data Capture](https://debezium.io/blog/2018/07/19/advantages-of-log-based-change-data-capture/), Debezium, 2018
- Gunnar Morling, [Mastering Postgres Replication Slots: Preventing WAL Bloat and Other Production Issues](https://www.morling.dev/blog/mastering-postgres-replication-slots/), 2025
- RisingWave, [CDC to Apache Iceberg: Upsert and Delete Semantics Explained](https://risingwave.com/blog/cdc-to-iceberg-upsert-delete/), 2026
- 한정호, [AWS에 구축하는 클라우드 디자인 패턴 시리즈 5부: 데이터 관리](https://aws.amazon.com/ko/blogs/tech/cloud-design-patterns-on-aws-5/), AWS 기술 블로그, 2024
- Jiri Pechanec, [Incremental Snapshots in Debezium](https://debezium.io/blog/2021/10/07/incremental-snapshots/), Debezium, 2021
- 김용우, [대규모 CDC Pipeline 운영을 위한 Debezium 개선 여정](https://toss.tech/article/cdc_pipeline), 토스, 2024
- Conor Gallagher, [Contributing to Debezium: Fixing Logical Replication at Scale](https://engineering.zalando.com/posts/2025/12/contributing-to-debezium.html), Zalando, 2025
- Tim, [Logstash에서 Debezium CDC로 전환한 이유](https://www.nextree.io/logstasheseo-debezium-cdcro-jeonhwanhan-iyu/), 넥스트리, 2026
- 실습 코드: [labs/de-study/ch20](https://github.com/dj258255/IT-Oasis/tree/main/labs/de-study/ch20)

중국과 국내 빅테크 사례
- Alibaba, [canal README](https://github.com/alibaba/canal)
- 徐榜江(Alibaba), [Flink CDC 2.0 正式发布，详解核心改进](https://developer.aliyun.com/article/786600), 2021
- Apache Flink Community, [The Next Step of Flink CDC](https://www.alibabacloud.com/blog/the-next-step-of-flink-cdc_601210), 2024
- Meituan, [美团DB数据同步到数据仓库的架构与实践](https://tech.meituan.com/2018/12/06/binlog-dw.html), 2018
- 张静(快手), [数据湖在快手的生产实践](https://cloud.tencent.com/developer/news/1129269), 2023
- 周晖栋(bilibili), [B 站构建实时数据湖的探索和实践](https://developer.aliyun.com/article/1211753), 2023
- 张友军(ByteDance), [字节跳动基于 Apache Hudi 构建实时数仓的实践](https://developer.volcengine.com/articles/7220261658042564666)
- louis.sml, [Apache Iceberg와 Flink CDC 심층 탐구](https://tech.kakao.com/posts/656), 카카오, 2024
- 김성도, 고상일, [Hive에서 Iceberg로: 데이터 반영 속도 12배 향상의 비밀](https://techblog.lycorp.co.jp/ko/from-hive-to-iceberg-12x-faster-data-updates), LINE
- 조승완, [입수는 Datalake로! (feat. Iceberg)](https://toss.tech/article/datalake-iceberg), 토스, 2024

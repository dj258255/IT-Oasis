---
title: '[DE Ch-20] CDC로 레이크하우스 채우기: 조회는 상태를 보고 로그는 변경을 본다'
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
seriesOrder: 20
---

## 결론부터

1. `updated_at`을 주기적으로 조회하는 CDC는 그 순간의 상태만 봅니다. 두 조회 사이의 중간 변경과 삭제를 놓칩니다. SQLite로 재현했을 때 주문 하나의 pending, paid, shipped 중 shipped만 잡혔고 다음 조회 전에 생겼다 지워진 주문과 한 번 본 뒤 지워진 주문의 삭제는 아예 잡히지 않았습니다.
2. 로그 기반 CDC는 DB가 복구와 복제를 위해 이미 남기는 변경 로그(MySQL binlog, PostgreSQL WAL)를 읽습니다. 모든 변경과 삭제를 순서대로 받고 원천 DB에 조회 부하를 주지 않습니다. Debezium이 대표 도구입니다.
3. Debezium의 기본 보장은 at-least-once이고 내부 중복 제거 계층이 없습니다. 받는 쪽은 기본 키로 upsert해서 멱등하게 반영합니다.
4. PostgreSQL의 replication slot은 소비자가 가져가지 않은 WAL을 지우지 않습니다. 기본 설정(`max_slot_wal_keep_size=-1`)에서는 한도 없이 쌓여 디스크를 채울 수 있습니다.
5. Iceberg에 반영할 때 Flink Iceberg sink는 exactly-once를 보장하고 upsert 모드는 v2 테이블과 식별 필드가 필요합니다. 스트리밍 반영은 작은 파일과 delete 파일을 계속 만들어서 Ch-19의 유지보수가 따라와야 합니다.

---

## 1. 원천 DB에서 레이크하우스로

Ch-01의 수명주기에서 수집 단계에 해당하는 이야기입니다. 주문 서비스의 DB(MySQL, PostgreSQL)에 있는 주문 테이블을 분석용 Iceberg 테이블로 옮긴다고 해 봅시다. 하루 한 번 통째로 복사하면 간단하지만 테이블이 크면 오래 걸리고 하루 동안의 변화는 보이지 않습니다. 바뀐 것만 옮기는 방법이 CDC(Change Data Capture)이고 바뀐 것을 알아내는 방법이 두 가지입니다.

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

| DB | 읽는 로그 | Debezium 문서의 요구 조건 |
|---|---|---|
| MySQL | binlog | `binlog_format=ROW`, `binlog_row_image=FULL` |
| PostgreSQL | WAL(logical decoding) | 출력 플러그인 pgoutput(PostgreSQL 10+ 기본 포함). replication slot을 하나 만든다. DDL 변경은 logical decoding이 지원하지 않는다 |

PostgreSQL에서는 `REPLICA IDENTITY`가 기본값이면 update 이벤트의 `before`에 기본 키만 들어갑니다. 변경 전 값 전체가 필요하면 테이블을 `REPLICA IDENTITY FULL`로 바꿔야 합니다.

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

삭제 이벤트 뒤에는 같은 키에 값이 null인 tombstone 이벤트가 하나 더 붙습니다(`tombstones.on.delete` 기본 true). Ch-11의 log compaction이 이 tombstone을 보고 그 키의 이전 메시지를 지웁니다. 이벤트의 키는 테이블의 기본 키라서 같은 행의 변경은 같은 Kafka 파티션에 순서대로 들어갑니다.

### 3-3. 초기 스냅샷

로그는 과거 전부를 담고 있지 않습니다. 그래서 처음 시작할 때 테이블 전체를 한 번 읽고(스냅샷), 그 뒤부터 로그를 따라갑니다. `snapshot.mode`로 정합니다. 기본값은 `initial`이고 스냅샷 없이 지금부터의 변경만 읽는 `no_data` 등이 있습니다.

토스증권의 2024년 글 "대규모 CDC Pipeline 운영을 위한 Debezium 개선 여정"은 이 단계가 단일 스레드로 처리되어 경우에 따라 11~12시간까지 걸렸다고 적었습니다. 초기 적재는 다른 도구(Sqoop)로 하고 Debezium은 `no_data` 모드로 띄우는 방식으로 바꾸고 테이블 추가용 모드를 직접 만들어, 최대 12시간이던 작업을 테이블 추가는 1시간, 확장은 5분 안으로 줄였다고 했습니다.

Debezium은 이후 incremental snapshot을 넣었습니다(DDD-3). Netflix의 DBLog 논문 방식을 따라, 테이블을 기본 키 기준 청크로 나눠 읽으면서 로그 수집을 멈추지 않고 중간에 멈췄다 이어서 할 수 있습니다. signal 테이블에 INSERT를 넣어 실행합니다.

### 3-4. 전달 보장

Debezium 문서는 이렇게 적습니다. Debezium은 at-least-once 전달을 보장하고 exactly-once를 위한 내부 중복 제거 계층은 구현하지 않는다. PostgreSQL 커넥터 문서는 스냅샷 직후 스냅샷이 이미 담은 레코드를 다시 내보낼 수 있다고도 적습니다.

Kafka Connect 3.3 이상을 분산 모드로 띄우고 worker와 커넥터에 exactly-once 설정을 켜면 일부 커넥터(MySQL, PostgreSQL 등)는 exactly-once로 쓸 수 있습니다. 조건이 여럿이라, 받는 쪽은 중복이 올 수 있다고 보고 기본 키로 upsert하는 구성이 흔합니다(Ch-13).

## 4. replication slot이 디스크를 채우는 경로

PostgreSQL의 replication slot은 소비자가 확인한 위치를 기억하고 그 이후의 WAL을 지우지 않습니다. 소비자가 멈춰도 마찬가지입니다.

PostgreSQL 문서의 문장입니다.

- replication slot 때문에 서버가 WAL 세그먼트를 너무 많이 붙들어 `pg_wal` 공간을 채울 수 있다. `max_slot_wal_keep_size`로 한도를 둘 수 있다.
- `max_slot_wal_keep_size`가 -1(기본값)이면 replication slot이 붙드는 WAL에 한도가 없다. 한도를 넘으면 그 slot은 필요한 WAL이 지워져 복제를 계속할 수 없게 될 수 있다.
- slot은 소비자의 상태를 모르고 필요 없는 slot은 지워야 한다. 극단적인 경우 VACUUM이 오래된 행을 정리하지 못해 트랜잭션 ID 고갈을 막으려고 DB가 멈출 수 있다.

한도를 두면 디스크는 지키지만 slot이 무효화되어 CDC를 처음부터 다시 맞춰야 합니다. 한도가 없으면 CDC는 이어지지만 디스크가 찰 수 있습니다. 어느 쪽이든 slot의 지연을 감시해야 합니다(`pg_replication_slots`의 `confirmed_flush_lsn`, `restart_lsn`).

소비자가 살아 있는데도 WAL이 쌓이는 경우가 있습니다. Debezium 문서는 추적하는 테이블의 변경은 드문데 DB 전체 변경이 많으면, 커넥터가 확인할 위치를 앞으로 옮길 이벤트가 없어 이미 처리한 WAL이 남는다고 설명하고 `heartbeat.interval.ms`와 `heartbeat.action.query`를 해결책으로 듭니다. Zalando의 2025년 글은 활동이 적은 DB에서 테이블 변경이 없으면 slot이 앞으로 가지 않아 WAL이 디스크가 바닥날 때까지 쌓였고 heartbeat를 설정했는데도 이것이 가장 큰 운영 문제였다고 적었습니다. 이 문제를 Debezium에 고쳐 넣었고 3.4.0에 `lsn.flush.mode=connector_and_driver`로 들어갔습니다.

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

### 5-2. 스트리밍 반영의 부산물

Flink upsert는 쓸 때마다 이전 값을 지우는 equality delete 파일을 만듭니다. Iceberg 유지보수 문서는 스트리밍 쿼리가 작은 데이터 파일을 만들어 합쳐야 하고 커밋이 잦은 테이블은 메타데이터 파일을 주기적으로 정리해야 한다고 적습니다. 반영이 잘 돌아가는 동안에도 읽기는 점점 느려질 수 있어서 Ch-19의 컴팩션과 스냅샷 만료가 CDC 파이프라인의 일부가 됩니다.

## 6. outbox 패턴

원천 서비스가 DB 테이블 대신 이벤트를 내보내고 싶을 때도 같은 구조를 씁니다. Debezium 문서는 outbox 패턴을 서비스의 내부 상태(DB)와 다른 서비스가 받는 이벤트 사이의 불일치를 피하는 방법으로 설명합니다. 서비스는 주문을 저장하는 트랜잭션 안에서 outbox 테이블에 이벤트 행을 함께 넣고 Debezium이 그 테이블의 변경을 읽어 Kafka로 보냅니다. DB 저장과 이벤트 발행이 한 트랜잭션으로 묶이니 "저장은 됐는데 이벤트는 못 보냄"이 생기지 않습니다.

## 7. 중국과 국내 빅테크 사례

### 7-1. Alibaba에서 나온 CDC 도구: Canal과 Flink CDC

로그 기반 CDC 도구 둘이 Alibaba에서 나왔습니다.

- **Canal**: README에 따르면 Alibaba는 항저우와 미국 두 데이터센터 사이 동기화가 필요했고 처음에는 업무 트리거로 증분 변경을 얻다가 2010년부터 DB 로그를 해석하는 방식으로 옮겼습니다. Canal은 MySQL 복제본의 통신 규약을 흉내 내 자신을 복제본으로 위장하고 MySQL에 binlog 전송(dump)을 요청합니다. 3-1절의 "복제본처럼 로그를 읽는다"를 그대로 구현한 것입니다.
- **Flink CDC**: 2020년 7월 개인 관심 프로젝트로 시작해 Ververica 저장소의 오픈소스가 됐고 이후 Apache Flink 하위 프로젝트로 기증됐습니다. 2021년 "Flink CDC 2.0 正式发布，详解核心改进"은 1.x의 문제를 셋으로 꼽았습니다. Debezium 방식이라 스냅샷 때 전역 락이나 테이블 락이 필요했고(DBA가 락 권한을 잘 주지 않음), 스냅샷을 병렬로 읽지 못했고 스냅샷 단계에서 체크포인트를 못 했습니다. 2.0은 3-3절의 incremental snapshot과 같은 DBLog 알고리즘을 단순화해 기본 키 범위 청크로 나눠 락 없이 병렬로 읽습니다. TPC-DS customer 테이블(약 6,500만 행, 병렬도 8, 스냅샷 단계만)에서 1.4가 89분, 2.0이 13분이었습니다.

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
- Debezium과 Kafka Connect를 띄워 재현하지는 않았습니다. 3~4절은 Debezium과 PostgreSQL 문서 사례 글 기준입니다.
- Iceberg 문서는 GitHub main 브랜치 원문 기준이라 릴리스 버전과 다를 수 있습니다.
- 스트리밍 upsert로 delete 파일이 쌓일 때 읽기가 얼마나 느려지는지 수치는 찾지 못했습니다.

## 9. 헷갈렸던 것

**Q. 조회 기반도 updated_at 인덱스만 있으면 부하가 작지 않나요?**

부하는 줄일 수 있어도 2-1절의 세 가지 누락은 그대로입니다. 매 조회가 "지금 상태"를 보는 방식이라 그 사이의 변경과 삭제는 구조적으로 보이지 않습니다. 하루 한 번 최종 상태만 필요하고 삭제가 없는 테이블이라면 조회 기반으로 충분할 수 있습니다.

**Q. Debezium이 at-least-once면 레이크하우스에 중복 행이 생기나요?**

append로 쌓으면 생깁니다. 기본 키로 upsert하면 같은 변경이 두 번 와도 결과 행은 같습니다. Ch-03의 멱등성이 여기서도 마지막 방어선입니다.

**Q. replication slot 감시는 무엇을 보면 되나요?**

slot이 붙들고 있는 WAL 크기와 소비자가 확인한 위치가 앞으로 가는지를 봅니다. 소비자가 멈췄는데 slot이 남아 있으면 지워야 하고 소비자가 살아 있는데도 위치가 멈춰 있으면 4절의 heartbeat 문제를 의심합니다.

## 참고 자료

공식 문서
- Debezium, [connector for MySQL](https://debezium.io/documentation/reference/stable/connectors/mysql.html), [connector for PostgreSQL](https://debezium.io/documentation/reference/stable/connectors/postgresql.html), [Exactly-once delivery](https://debezium.io/documentation/reference/stable/configuration/eos.html), [FAQ](https://debezium.io/documentation/faq/), [Outbox Event Router](https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html)
- Debezium, [DDD-3: Incremental snapshotting](https://github.com/debezium/debezium-design-documents/blob/main/DDD-3.md)
- PostgreSQL, [Replication Slots](https://www.postgresql.org/docs/current/warm-standby.html), [Replication 설정](https://www.postgresql.org/docs/current/runtime-config-replication.html), [Logical Decoding Concepts](https://www.postgresql.org/docs/current/logicaldecoding-explanation.html)
- Apache Iceberg, [Spark writes](https://github.com/apache/iceberg/blob/main/docs/docs/spark-writes.md), [Flink writes](https://github.com/apache/iceberg/blob/main/docs/docs/flink-writes.md), [Maintenance](https://github.com/apache/iceberg/blob/main/docs/docs/maintenance.md), [Kafka Connect](https://iceberg.apache.org/docs/latest/kafka-connect/)
- Apache Flink CDC, [Iceberg pipeline connector](https://nightlies.apache.org/flink/flink-cdc-docs-stable/docs/connectors/pipeline-connectors/iceberg/)
- Delta Lake, [Table deletes, updates, and merges](https://docs.delta.io/latest/delta-update.html)
- Tabular, [iceberg-kafka-connect](https://github.com/tabular-io/iceberg-kafka-connect)

글과 사례
- Gunnar Morling, [Five Advantages of Log-Based Change Data Capture](https://debezium.io/blog/2018/07/19/advantages-of-log-based-change-data-capture/), Debezium, 2018
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

---
title: '트랜잭션 ACID ④: Durability는 어떻게 디스크까지 살아남는가'
description: WAL · fsync · group commit · doublewrite buffer · 체크포인트까지, 커밋된 변경이 디스크에 영속적으로 남기 위한 메커니즘 전반을 1차 자료 기준으로 정리합니다. PostgreSQL synchronous_commit과 MySQL innodb_flush_log_at_trx_commit으로 trade-off 다이얼을 어떻게 돌리는지까지.
date: 2026-04-18T00:00:00.000Z
tags:
  - Transaction
  - ACID
  - Durability
  - WAL
  - fsync
  - Group Commit
  - Doublewrite Buffer
  - PostgreSQL
  - InnoDB
  - Database
category: theory/Database
draft: false
coverImage: "/uploads/theory/transaction-acid/cover-4.svg"
series: "트랜잭션 ACID"
seriesOrder: 4
---

## 0. 들어가며

ACID 시리즈의 마지막 글자, **D(Durability, 지속성)**. 정의는 단순합니다. *"커밋된 변경은 영속적이다."* 그런데 어떻게 영속적인지 들어가면 끝이 없습니다. 이 글의 핵심 메시지는 **"Durability는 ACID에서 설정으로 직접 trade-off를 조절할 수 있는 글자다"** 입니다. PostgreSQL의 `synchronous_commit`, MySQL InnoDB의 `innodb_flush_log_at_trx_commit` 같은 설정은 강한 durability와 처리량 사이의 다이얼입니다. 그리고 그 다이얼을 안전하게 돌리려면 WAL, fsync, group commit, doublewrite buffer 같은 메커니즘을 알아야 합니다.

## 1. Durability의 정의: 커밋되면 살아남는다

> **Durability**: 트랜잭션이 커밋된 후에는, 그 변경 사항이 시스템 충돌·전원 차단·OS 크래시가 발생해도 비휘발성 저장소에 영속적으로 남는다는 보장.

핵심 단어는 **"커밋된"** 입니다. 커밋되지 않은 트랜잭션은 살아남을 의무가 없습니다([① 편](/blog/theory/transaction-acid-01-atomicity)에서 다룬 atomicity가 오히려 지워줄 의무를 가집니다). 사용자 관점에서는 이렇습니다. *"커밋 응답을 받은 그 순간 전원을 빼도, 다시 켰을 때 그 데이터가 있어야 한다."*

저장소가 SSD든 HDD든 NVMe든 상관없습니다. 핵심은 데이터가 살아남는다는 것입니다.

## 2. 왜 Durability는 느린가

직관적으로 *"DB에 쓰면 디스크에 쓰겠지"* 라고 생각하기 쉽지만, 실제로 디스크에 쓰는 건 느립니다. 매우 느립니다. 메모리 쓰기는 나노초 단위, SSD 쓰기는 마이크로초 단위, HDD 쓰기는 밀리초 단위로 **자릿수가 100~1000배 차이** 납니다.

데이터베이스는 매 트랜잭션마다 다음을 디스크에 써야 한다고 생각해보면:

- 데이터 행(row) 자체
- 인덱스 (B-tree, hash 등)
- 시스템 메타데이터 (트랜잭션 로그, 통계 정보 등)

이 모든 걸 매번 디스크에 직접 쓰면 처리량이 무너집니다. 그래서 DB는 두 가지 전략으로 이 문제를 풀어왔습니다.

- **WAL (Write-Ahead Log)**: 변경 사항의 델타만 작은 로그에 빠르게 쓰고, 실제 데이터 페이지는 나중에 비동기로 씁니다.
- **메모리 버퍼 + 주기적 스냅샷**: 모든 쓰기를 메모리에 두고, 백그라운드에서 디스크로 flush합니다.

> Redis는 두 전략 모두를 제공하는 좋은 예입니다. RDB(스냅샷)와 AOF(Append-Only File, WAL과 유사)를 갖추고 있고, Redis 7부터는 둘을 결합한 hybrid persistence가 기본입니다. 즉 *"Redis = 스냅샷 계열"* 로 단정하면 부정확합니다.

대부분의 RDBMS는 1번 (WAL) 방식을 씁니다. 깊이 들어가봅시다.

> **2장 요약**: 디스크는 메모리보다 자릿수 차이로 느립니다. 매 트랜잭션마다 모든 데이터를 디스크에 쓰면 처리량이 무너지므로, DB는 WAL이나 메모리 버퍼 같은 우회 전략을 씁니다.

## 3. WAL (Write-Ahead Log): 델타만 빠르게 쓴다

### 핵심 원리

> **WAL의 핵심**: 데이터 페이지를 디스크에 쓰기 전에 변경 사항의 로그를 먼저 쓴다. 그 로그가 디스크에 안전하게 쓰여야만 트랜잭션을 커밋된 것으로 본다.

![WAL: 변경 델타를 디스크에 먼저, 데이터 페이지는 나중에](/uploads/theory/transaction-acid/wal-flow.svg)

이게 왜 빠른가? **변경 사항의 델타만** 기록하기 때문입니다. *"행 ID 7의 balance를 100에서 200으로 변경"* 같은 작은 레코드죠. 데이터 페이지(PostgreSQL 8KB, InnoDB 16KB) 전체를 쓰는 것보다 훨씬 작습니다. 게다가 WAL은 **순차 쓰기(sequential write)** 이고, 디스크는 순차 쓰기에 최적화되어 있습니다(HDD에서는 헤드 이동이 없고, SSD에서도 GC 압박이 적음).

### 충돌 후 복구: Redo

만약 DB가 충돌하면, 메모리에 있던 변경 사항(아직 데이터 페이지에 반영 안 됨)은 사라집니다. 하지만 WAL은 디스크에 있습니다. 재시작 시 DB는 마지막 체크포인트 이후의 WAL을 읽으며 변경을 *재적용(redo)* 합니다(전체 WAL을 처음부터 읽지 않습니다. 체크포인트 시점 이전의 변경은 이미 데이터 페이지에 반영되어 있으므로). 결과적으로 충돌 직전의 커밋된 상태로 복원됩니다.

이게 [① 편](/blog/theory/transaction-acid-01-atomicity)에서 다룬 Atomicity의 redo phase와 같은 메커니즘입니다. WAL은 durability와 crash recovery의 기반이고, atomicity는 그 위에서 redo/undo 기반의 recovery protocol과 함께 구현됩니다. 학계의 표준 알고리즘은 **ARIES**(Algorithms for Recovery and Isolation Exploiting Semantics)이고, InnoDB가 ARIES 계열에 가깝습니다(redo log + 별도 undo log + steal/no-force). PostgreSQL은 다른 길을 택했습니다. explicit undo log 대신 MVCC로 abort된 트랜잭션의 흔적을 그대로 남겨두고 가시성 규칙으로 처리합니다(나중에 VACUUM으로 정리).

### WAL Segment

WAL은 무한정 커지면 안 되므로 **세그먼트**(고정 크기 파일, PostgreSQL 기본 16MB) 단위로 잘라 씁니다. 체크포인트가 일어나면(데이터 페이지가 디스크에 안전히 flush됨) 옛 세그먼트는 재활용하거나 삭제할 수 있습니다.

### Redis의 AOF (Append-Only File)

Redis도 WAL과 비슷한 메커니즘을 가집니다. `appendonly yes` 설정 시 모든 쓰기 명령을 AOF에 append합니다. 충돌 시 AOF를 재실행해 메모리 상태를 복원합니다. RDB 스냅샷과 함께 쓸 수 있습니다(Redis 7부터는 AOF + RDB 혼합인 hybrid persistence가 기본).

> **3장 요약**: WAL은 변경 델타만 순차 쓰기로 디스크에 먼저 기록하는 메커니즘입니다. 데이터 페이지는 나중에 쓰고, 충돌 시 WAL을 redo하여 복원합니다. 작고 빠른 쓰기로 durability를 확보하는 게 핵심입니다.

## 4. OS 캐시의 함정: fsync가 필요한 이유

여기서부터가 진짜 디테일입니다. WAL을 디스크에 쓰는 것조차 그리 단순하지 않습니다.

### OS는 거짓말을 한다

DB가 `write(fd, wal_record, size)` 시스템 콜로 WAL을 쓴다고 해봅시다. OS(Linux/Windows)는 보통 이렇게 동작합니다.

1. DB가 `write()` 호출.
2. OS는 데이터를 **페이지 캐시(메모리)** 에 저장하고, 즉시 *"성공"* 응답.
3. 실제 디스크 쓰기는 나중에 OS가 알아서 함.

이 단계 2에서 OS는 사실상 거짓말을 합니다. DB에는 *"성공"* 이라고 했지만 실제로는 메모리에만 있습니다. 만약 이 시점에 전원이 나가면? **WAL 데이터는 사라지고, DB는 사용자에게 이미 *"커밋되었습니다"* 라고 알린 상태입니다. Durability 위반.**

### fsync: OS에게 *"진짜로 디스크에 써라"*

이 문제를 해결하기 위해 OS는 `fsync(fd)` 시스템 콜을 제공합니다. *"이 파일의 모든 변경을 지금 디스크의 비휘발성 매체까지 flush해라"* 라는 명령입니다. fsync는 OS 수준에서 디스크 flush를 요청합니다. 다만 진짜 durability는 하드웨어 협력이 있어야 합니다. 디스크의 휘발성 쓰기 캐시, RAID 컨트롤러 캐시, 펌웨어의 write reorder 등이 끼어들면 fsync가 반환된 후에도 전원 차단 시 데이터가 손실될 수 있습니다. 이 하드웨어 차원은 아래에서 다시 다룹니다.

![fsync 계층: 어디까지 안전해야 진짜 durability인가](/uploads/theory/transaction-acid/fsync-layers.svg)

> 즉 fsync는 durability의 충분조건이 아니라 **필요조건에 가깝습니다.** 호출하지 않으면 절대 보장될 수 없지만, 호출했다고 해서 보장되는 것도 아닙니다.

DB는 보통 매 커밋마다 이렇게 합니다.

1. WAL 레코드를 `write()`로 OS 캐시에 씀.
2. `fsync()`로 디스크까지 flush.
3. 그 후에 사용자에게 *"커밋 성공"* 응답.

이게 ACID-D의 표준 구현 패턴입니다.

### fsync의 비용

fsync는 비쌉니다. 대략적으로 HDD에서는 한 자릿수~수십 ms (7200rpm 기준 한 회전이 8ms, 회전 지연이 큰 비중), SATA/NVMe SSD에서는 수십 μs~수 ms 수준 (장치·커널·전원 보호 여부에 따라 편차 큼)입니다. 매 커밋마다 fsync를 호출하면 처리량이 떨어지는 건 분명하고, 특히 짧은 트랜잭션이 많은 OLTP 워크로드에서 결정적인 병목이 됩니다.

한 가지 짚어두면, fsync 비용의 본질은 *"데이터를 더 많이 쓴다"* 가 아니라 **동기 barrier로 작동한다**는 점입니다. `write()`는 OS 페이지 캐시까지만 복사하고 즉시 리턴하므로 커널이 여러 쓰기를 큰 sequential I/O로 묶을 수 있지만, 매 커밋 fsync는 디스크 ack까지 애플리케이션이 블로킹돼서 그 묶음 효과가 깨집니다. 디스크에 들어가는 *총 바이트*는 비슷해도 **I/O 명령 횟수와 동기 대기 시간**이 자릿수로 차이 납니다. 그래서 단일 커넥션 OLTP 처리량은 대략 1/fsync_latency에 묶이고, 이걸 살리는 메커니즘이 다음에 다룰 group commit입니다.

이래서 DB들이 fsync를 묶어서(group commit) 처리하거나, 아예 끄거나(asynchronous commit), 하드웨어 도움(NVRAM, 배터리 백업 RAID 컨트롤러)을 받는 등 여러 우회를 씁니다.

### 진실은 더 어둡다: 디스크도 거짓말을 한다

앞에서 fsync가 OS-level flush를 요청한다고 했는데, 사실 **디스크 자체에도 캐시**가 있습니다. 일부 디스크는 fsync 명령을 받고도 디스크 내부의 휘발성 쓰기 캐시까지만 도착하면 응답합니다. 그 캐시는 전원 차단 시 날아갑니다.

이래서 PostgreSQL 같은 DB는 `wal_sync_method`로 더 강력한 동기화 방식(`open_datasync`, `fdatasync` 등)을 선택할 수 있습니다. 또한 엔터프라이즈 디스크는 BBU(Battery Backup Unit)로 캐시를 보호합니다.

> MySQL 8.4 공식 매뉴얼이 직접 인정합니다. *"Many operating systems and some disk hardware fool the flush-to-disk operation. They may tell mysqld that the flush has taken place, even though it has not. In this case, the durability of transactions is not guaranteed even with the recommended settings, and in the worst case, a power outage can corrupt InnoDB data."*

> **4장 요약**: OS의 페이지 캐시 때문에 단순 `write()`만으로는 durability가 보장되지 않습니다. fsync로 강제 flush해야 하지만 비용이 큽니다. 디스크 자체 캐시까지 고려하면 진짜 durability는 하드웨어 협력 없이 어렵습니다.

## 5. Durability 다이얼: DB별 설정

이제 설정을 봅시다. 각 DB는 **"얼마나 강하게 fsync할 것인가"** 를 사용자가 선택하게 해줍니다.

![Durability 다이얼: DB별 설정 매트릭스](/uploads/theory/transaction-acid/durability-dial.svg)

### PostgreSQL의 `synchronous_commit`

PostgreSQL 공식 문서 기준 5단계:

| 값 | 의미 | 데이터 손실 위험 |
|---|---|---|
| `off` | WAL fsync 없이 커밋 응답. 백그라운드에서 비동기로 flush. | 최대 `wal_writer_delay × 3` (기본 ~600ms) |
| `local` | 로컬 WAL fsync 확인 후 응답. 복제는 무관. | 로컬 디스크 보장만 |
| `remote_write`* | 동기 standby의 OS 캐시 도착 확인 후 응답. | standby OS 크래시 시 손실 가능 |
| `on` (기본) | 로컬 WAL fsync (standby 있으면 standby의 디스크 fsync까지) 확인 후 응답. | standby 있을 시: primary와 모든 동기 standby가 동시 손상되어야 손실 |
| `remote_apply`* | 동기 standby가 적용까지 완료한 후 응답 (standby 쿼리에서도 보임). | 가장 강함, 가장 느림 |

`*` `remote_write`/`remote_apply`/`on`(복제 의미)는 `synchronous_standby_names`가 설정되어 있어야 의미가 있습니다. PostgreSQL 공식 문서 그대로 옮기면 *"If synchronous_standby_names is empty, the only meaningful settings are on and off; remote_apply, remote_write and local all provide the same local synchronization level as on."* 입니다. 즉 동기 standby가 설정되지 않은 단일 노드에서는 `on`/`local`/`remote_write`/`remote_apply` 모두 같은 동작(로컬 fsync까지)입니다.

또한 `synchronous_commit = off`는 **데이터 손실은 가능하지만 데이터 손상은 일으키지 않습니다**(공식 문서 명시). 즉 잃어버린 트랜잭션은 aborted clean된 것처럼 보이고 DB 상태는 일관성을 유지합니다. 이게 `fsync = off`(파라미터 자체를 끄는 더 위험한 설정)와의 결정적 차이입니다.

### MySQL InnoDB의 `innodb_flush_log_at_trx_commit`

MySQL 8.4 공식 매뉴얼 기준 3단계:

| 값 | 의미 | 데이터 손실 위험 |
|---|---|---|
| `0` | 매 커밋 시 아무것도 안 함. WAL은 1초마다 일괄 flush. | 최대 1초 |
| `1` (기본, ACID) | 매 커밋마다 WAL을 디스크까지 flush. | 거의 없음 |
| `2` | 매 커밋마다 WAL을 OS 캐시까지 쓰고 1초마다 fsync. | OS 크래시 시 최대 1초 |

MySQL 매뉴얼이 명시합니다. *"The default setting of 1 is required for full ACID compliance."* `0`이나 `2`는 ACID-D를 일부 포기하는 설정입니다.

> 차이점을 보면, `0`과 `2` 모두 1초 손실 가능하지만 `2`는 **DB 크래시 시에는 안전**합니다(OS 캐시까지는 쓰여있고, OS가 살아있으면 결국 fsync됨). `0`은 DB 크래시만으로도 손실 가능합니다. 그래서 실무에서는 *"조금 빠르게"* 가 필요하면 `2`를 선호합니다.

### 실용 가이드

| 시나리오 | 권장 설정 |
|---|---|
| 금융, 결제, 주문 | PG: `on` (또는 `remote_apply`로 복제까지) / MySQL: `1` |
| 일반 OLTP | 위와 동일 (성능이 충분하면 default 유지) |
| 분석/배치 적재, 임시 워크로드 | PG: `local`이나 `off` / MySQL: `2` |
| 로그 수집, IoT 메트릭, 캐시 | PG: `off` / MySQL: `0` 또는 `2` |

> **팁**: PostgreSQL은 트랜잭션 단위로 `SET LOCAL synchronous_commit = 'off'`로 설정을 변경할 수 있습니다. 즉 중요한 트랜잭션은 강한 durability, 덜 중요한 트랜잭션은 빠른 응답으로 혼합 운영할 수 있습니다. 이게 PostgreSQL의 큰 장점입니다.

> **5장 요약**: Durability는 다이얼입니다. PostgreSQL은 5단계, MySQL InnoDB는 3단계로 얼마나 강하게 fsync할지 선택할 수 있습니다. 워크로드별로 트랜잭션마다 다르게 설정하는 것도 가능합니다.

## 6. Group Commit: 처리량을 살리는 핵심 최적화

매 커밋마다 fsync하면 처리량이 무너진다고 했습니다. 그럼 강한 durability를 유지하면서 처리량을 어떻게 올릴까요? 답은 **group commit** 입니다.

### 원리

여러 트랜잭션이 거의 동시에 커밋하려 한다고 가정합니다. 각각 fsync하면 N번의 디스크 IO가 필요합니다. 하지만 WAL은 어차피 순차적이고, 한 번의 fsync는 그 시점까지의 모든 WAL을 함께 flush합니다.

![Group Commit: 동시 커밋들의 fsync를 한 번에 묶는다](/uploads/theory/transaction-acid/group-commit.svg)

그래서 DB는 이렇게 합니다:

1. 트랜잭션 T1, T2, T3가 거의 동시에 커밋 요청.
2. T1이 fsync를 시작하는 동안 T2, T3는 대기.
3. T1의 fsync가 끝나면 T2, T3의 WAL도 같이 flush됨 (그들이 쓴 WAL이 T1의 fsync 시점 이전에 OS 캐시에 도착했으므로).
4. **한 번의 fsync로 세 트랜잭션 모두 디스크 보장 확보.**

결과: N개 트랜잭션이 1번의 fsync 비용을 공유. 처리량 확보.

### 실전

PostgreSQL과 MySQL InnoDB 모두 group commit을 자동으로 합니다. 별도로 켜거나 끄는 설정은 없습니다. PostgreSQL에는 `commit_delay`/`commit_siblings`로 강제로 더 큰 그룹을 만드는 미세조정이 있지만, 공식 가이드와 *PostgreSQL 10 High Performance* 책 모두 *"대부분의 경우 효과 없거나 오히려 느려질 수 있다"* 고 권고합니다. 즉 group commit은 기본적으로 잘 동작하고, 실무에서는 거의 손대지 않는 영역입니다.

> **6장 요약**: Group commit은 동시 커밋들의 fsync를 묶어 처리하는 최적화입니다. 강한 durability를 유지하면서 처리량을 확보하는 핵심 기법이고, 현대 RDBMS는 자동으로 합니다.

## 7. InnoDB Doublewrite Buffer: 부분 쓰기 문제

WAL과 별개로, InnoDB에는 또 하나의 흥미로운 메커니즘이 있습니다. 바로 **doublewrite buffer**입니다.

### 부분 쓰기(Torn Page) 문제

InnoDB의 데이터 페이지는 보통 16KB입니다. 그런데 OS/디스크의 atomic write 단위는 보통 4KB(또는 512B)죠. 그래서 InnoDB가 16KB 페이지를 쓰는 도중 전원이 나가면, **일부만 쓰여진 *깨진 페이지(torn page)*** 가 디스크에 남을 수 있습니다.

WAL만으로는 이 문제를 풀지 못합니다. WAL은 논리적 변경 기록(*"이 위치를 X에서 Y로 변경"*)이기 때문에, 페이지 자체가 물리적으로 깨져있으면 그 위에 델타를 적용해봐야 결과가 보장되지 않습니다. 즉 **깨진 페이지 자체를 복구할 수단이 별도로 필요**합니다.

### Doublewrite Buffer의 해결법

InnoDB는 데이터 페이지를 디스크에 쓰기 전에 **연속된 doublewrite 영역에 먼저** 씁니다. 그 후 실제 위치에 씁니다. (저장 위치는 MySQL 8.0.20 이전엔 시스템 테이블스페이스 내, 8.0.20 이후엔 별도의 doublewrite 파일.)

![Torn Page 방어: InnoDB doublewrite vs PostgreSQL full_page_writes](/uploads/theory/transaction-acid/torn-page.svg)

크래시 후 복구 시:

- **실제 위치의 페이지가 깨졌으면** → doublewrite buffer의 깨끗한 복사본으로 복원.
- **doublewrite buffer가 깨졌으면** → 실제 위치의 페이지를 사용 (실제 쓰기는 시작도 안 한 것).

> 이름은 *"double write"* 지만 I/O가 두 배가 되지는 않습니다. MySQL 8.4 공식 매뉴얼은 이렇게 설명합니다. *"doublewrite buffer does not require twice as much I/O overhead or twice as many I/O operations. Data is written to the doublewrite buffer in a large sequential chunk, with a single fsync() call."* 즉 한 번의 fsync로 여러 페이지를 묶어 처리합니다. 실제 성능 영향은 워크로드에 따라 다른데, Percona 분석 기준 SSD/NVMe + MySQL 8.0.20+ 환경에서는 보통 5~10% 수준이지만 HDD + 쓰기 집중 워크로드에서는 50% 이상의 처리량 손실까지 보고된 사례가 있습니다.

PostgreSQL은 다른 방법(`full_page_writes = on`, 기본값)으로 같은 문제를 풉니다. **체크포인트 후 첫 변경 시 페이지 전체를 WAL에 기록**하는 방식입니다.

> **7장 요약**: InnoDB doublewrite buffer는 부분 쓰기(torn page) 문제를 막는 방어 메커니즘입니다. PostgreSQL의 `full_page_writes`도 같은 문제의 다른 해법입니다. WAL만으로는 페이지 단위 atomic write가 보장되지 않는다는 점에서 출발합니다.

## 8. Checkpoint: WAL과 데이터 페이지의 만남

WAL이 무한정 쌓이지 않게, 그리고 충돌 후 복구가 너무 오래 걸리지 않게 하려면 **체크포인트** 가 필요합니다.

### 체크포인트의 역할

체크포인트는 다음을 합니다.

- 메모리(buffer pool)의 dirty page들을 디스크의 실제 위치에 flush.
- 그 시점까지의 WAL은 더 이상 redo에 필요 없으므로 재활용 가능 표시.
- 충돌 후 복구는 이 체크포인트 이후의 WAL만 재실행하면 됨.

### 트레이드오프

- **잦은 체크포인트**: 복구 빠름, 하지만 dirty page flush IO가 많아져 평소 처리량 저하.
- **드문 체크포인트**: 평소 IO 적음, 하지만 복구 시간 길어짐.

PostgreSQL: `checkpoint_timeout` (기본 5분), `max_wal_size`(WAL 누적 크기 임계).
MySQL InnoDB: `innodb_log_file_size`로 redo log 크기 조절(체크포인트 빈도와 직결).

이 다이얼은 durability와는 직접 관계가 없습니다. 어차피 WAL이 fsync되어 있으면 데이터는 안전하기 때문입니다. 대신 복구 시간과 평소 IO 부담을 조절합니다.

> **8장 요약**: 체크포인트는 dirty page를 디스크에 반영해 WAL을 재활용 가능하게 만드는 작업입니다. 빈도 설정은 복구 시간과 평소 IO 사이의 트레이드오프입니다.

## 9. 정리

### 핵심 통찰

- **Durability ≠ 디스크 쓰기**: *"DB가 디스크에 쓴다"* 는 말은 OS 캐시까지일 뿐입니다. 진짜 durability는 fsync로 OS-level flush를 요청한 후에도 하드웨어 캐시까지 안전해야 보장됩니다 (BBU, atomic write, 적절한 fs barrier 등).
- **fsync는 비싸다**: 매 커밋마다 fsync하면 처리량이 무너지므로 group commit이 필수입니다.
- **Durability는 다이얼이다**: PostgreSQL의 `synchronous_commit`, MySQL의 `innodb_flush_log_at_trx_commit`로 강도를 조절합니다. ACID 네 글자 중 설정으로 가장 직접적으로 trade-off를 조절할 수 있는 영역입니다.
- **WAL이 durability와 recovery의 기반**: 변경 델타를 작고 빠르게 디스크에 기록하는 메커니즘이 D(지속성)와 충돌 복구의 핵심입니다. A(원자성)는 그 위에서 redo/undo 기반의 recovery protocol과 함께 구현됩니다. 대표 알고리즘이 ARIES이고, InnoDB가 가까운 계열이며, PostgreSQL은 MVCC로 다른 길을 택했습니다.
- **하드웨어도 거짓말한다**: OS 캐시 + 디스크 캐시 때문에 진짜 durability는 BBU나 atomic write 같은 하드웨어 협력 없이 어렵습니다.
- **부분 쓰기 방어**: WAL만으로는 페이지 단위 atomic write가 보장되지 않으므로 doublewrite buffer / `full_page_writes` 같은 추가 메커니즘이 필요합니다.

> 결국 Durability는 *"데이터가 언제까지 안전한가"* 가 아니라 **"어디까지를 안전하다고 정의할 것인가"** 의 문제입니다. OS 캐시까지인지, 로컬 디스크 매체까지인지, 동기 standby의 디스크까지인지, standby의 적용까지인지, 시스템마다 답이 다르고, 그 경계를 어디에 그을 것인지가 곧 워크로드의 trade-off 선택입니다.

## 시리즈 마무리

ACID 네 글자를 모두 다뤘습니다.

- [① Atomicity](/blog/theory/transaction-acid-01-atomicity): 전부 성공 or 전부 실패. WAL의 redo + undo로 구현.
- [② Isolation](/blog/theory/transaction-acid-02-isolation): 동시 트랜잭션 사이의 가시성 제어. MVCC + 격리 수준.
- [③ Consistency](/blog/theory/transaction-acid-03-consistency): 트랜잭션이 무결성 제약을 유지. 사실상 애플리케이션 책임 + DB의 제약 강제.
- **④ Durability**: 커밋된 변경은 영속. WAL + fsync + group commit + doublewrite buffer.

ACID 네 글자에는 수십 년의 DB 엔지니어링이 응축돼 있습니다. 각 글자 뒤에는 trade-off가 있고, 그 trade-off를 안다는 게 백엔드 개발자의 깊이를 만듭니다.

## 참고 (1차 자료 우선)

- [PostgreSQL Documentation — Reliability and the Write-Ahead Log](https://www.postgresql.org/docs/current/wal-intro.html): WAL 메커니즘 공식 설명
- [PostgreSQL Documentation — synchronous_commit 설정](https://www.postgresql.org/docs/current/runtime-config-wal.html#GUC-SYNCHRONOUS-COMMIT): 5단계 옵션의 정확한 의미
- [MySQL 8.4 Reference — innodb_flush_log_at_trx_commit](https://dev.mysql.com/doc/refman/8.4/en/innodb-parameters.html#sysvar_innodb_flush_log_at_trx_commit): 0/1/2 옵션 + ACID 준수 명시
- [MySQL 8.4 Reference — Doublewrite Buffer](https://dev.mysql.com/doc/refman/8.4/en/innodb-doublewrite-buffer.html): torn page 방어 메커니즘
- [Percona — PostgreSQL synchronous_commit Options and Synchronous Standby Replication](https://www.percona.com/blog/postgresql-synchronous_commit-options-and-synchronous-standby-replication/): 각 옵션의 단계별 그림과 트레이드오프
- [Cybertec — The synchronous_commit parameter and streaming replication](https://www.cybertec-postgresql.com/en/the-synchronous_commit-parameter-and-streaming-replication/): TPS 비교 벤치마크 포함
- [Redis Persistence Documentation](https://redis.io/docs/management/persistence/): RDB + AOF 하이브리드 모델
- Andreas Reuter & Theo Härder, *Principles of Transaction-Oriented Database Recovery* (1983): ACID 원전 논문

---
title: '트랜잭션 ACID ④: Durability는 어떻게 디스크까지 살아남는가'
titleEn: 'Transaction ACID ④: How Does Durability Survive All the Way to Disk?'
description: WAL · fsync · group commit · doublewrite buffer · 체크포인트까지 — 커밋된 변경이 디스크에 영속적으로 남기 위한 메커니즘 전반을 1차 자료 기준으로 정리해요. PostgreSQL synchronous_commit과 MySQL innodb_flush_log_at_trx_commit으로 trade-off 다이얼을 어떻게 돌리는지까지.
descriptionEn: WAL, fsync, group commit, doublewrite buffer, checkpoints — the full mechanism stack that lets a committed change persist to disk, grounded in primary sources. Plus how to turn the trade-off dial via PostgreSQL's synchronous_commit and MySQL's innodb_flush_log_at_trx_commit.
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

ACID 시리즈의 마지막 글자, **D(Durability, 지속성)**. 정의는 단순합니다 — *"커밋된 변경은 영속적이다."* 그런데 어떻게 영속적인지 들어가면 끝이 없어요. 이 글의 핵심 메시지는 — **"Durability는 ACID에서 설정으로 직접 trade-off를 조절할 수 있는 글자다."** PostgreSQL의 `synchronous_commit`, MySQL InnoDB의 `innodb_flush_log_at_trx_commit` 같은 설정은 강한 durability와 처리량 사이의 다이얼이에요. 그리고 그 다이얼을 안전하게 돌리려면 WAL, fsync, group commit, doublewrite buffer 같은 메커니즘을 알아야 합니다.

## 1. Durability의 정의 — 커밋되면 살아남는다

> **Durability**: 트랜잭션이 커밋된 후에는, 그 변경 사항이 시스템 충돌·전원 차단·OS 크래시가 발생해도 비휘발성 저장소에 영속적으로 남는다는 보장.

핵심 단어는 **"커밋된"** 이에요. 커밋되지 않은 트랜잭션은 살아남을 의무가 없습니다([① 편](/blog/theory/transaction-acid-01-atomicity)에서 다룬 atomicity가 오히려 지워줄 의무를 가져요). 사용자 관점에서는: *"커밋 응답을 받은 그 순간 전원을 빼도, 다시 켰을 때 그 데이터가 있어야 한다."*

저장소가 SSD든 HDD든 NVMe든 상관없어요. 핵심은 데이터가 살아남는다는 것입니다.

## 2. 왜 Durability는 느린가

직관적으로 *"DB에 쓰면 디스크에 쓰겠지"* 라고 생각하기 쉽지만, 실제로 디스크에 쓰는 건 느려요. 매우 느립니다. 메모리 쓰기는 나노초 단위, SSD 쓰기는 마이크로초 단위, HDD 쓰기는 밀리초 단위 — **자릿수가 100~1000배 차이** 나요.

데이터베이스는 매 트랜잭션마다 다음을 디스크에 써야 한다고 생각해보면:

- 데이터 행(row) 자체
- 인덱스 (B-tree, hash 등)
- 시스템 메타데이터 (트랜잭션 로그, 통계 정보 등)

이 모든 걸 매번 디스크에 직접 쓰면 처리량이 무너집니다. 그래서 DB는 두 가지 전략으로 이 문제를 풀어왔어요:

- **WAL (Write-Ahead Log)** — 변경 사항의 델타만 작은 로그에 빠르게 쓰고, 실제 데이터 페이지는 나중에 비동기로 씀.
- **메모리 버퍼 + 주기적 스냅샷** — 모든 쓰기를 메모리에 두고, 백그라운드에서 디스크로 flush.

> Redis는 두 전략 모두를 제공하는 좋은 예예요 — RDB(스냅샷)와 AOF(Append-Only File, WAL과 유사). Redis 7부터는 둘을 결합한 hybrid persistence가 기본입니다. 즉 *"Redis = 스냅샷 계열"* 로 단정하면 부정확해요.

대부분의 RDBMS는 1번 (WAL) 방식을 써요. 깊이 들어가봅시다.

> **2장 요약** — 디스크는 메모리보다 자릿수 차이로 느립니다. 매 트랜잭션마다 모든 데이터를 디스크에 쓰면 처리량이 무너지므로, DB는 WAL이나 메모리 버퍼 같은 우회 전략을 써요.

## 3. WAL (Write-Ahead Log) — 델타만 빠르게 쓴다

### 핵심 원리

> **WAL의 핵심**: 데이터 페이지를 디스크에 쓰기 전에 변경 사항의 로그를 먼저 쓴다. 그 로그가 디스크에 안전하게 쓰여야만 트랜잭션을 커밋된 것으로 본다.

![WAL — 변경 델타를 디스크에 먼저, 데이터 페이지는 나중에](/uploads/theory/transaction-acid/wal-flow.svg)

이게 왜 빠른가? **변경 사항의 델타만** 기록하기 때문이에요 — *"행 ID 7의 balance를 100에서 200으로 변경"* 같은 작은 레코드. 데이터 페이지(PostgreSQL 8KB, InnoDB 16KB) 전체를 쓰는 것보다 훨씬 작아요. 게다가 WAL은 **순차 쓰기(sequential write)** 이고, 디스크는 순차 쓰기에 최적화되어 있어요(HDD에서는 헤드 이동이 없고, SSD에서도 GC 압박이 적음).

### 충돌 후 복구 — Redo

만약 DB가 충돌하면, 메모리에 있던 변경 사항(아직 데이터 페이지에 반영 안 됨)은 사라져요. 하지만 WAL은 디스크에 있습니다. 재시작 시 DB는 마지막 체크포인트 이후의 WAL을 읽으며 변경을 *재적용(redo)* 해요(전체 WAL을 처음부터 읽지 않습니다 — 체크포인트 시점 이전의 변경은 이미 데이터 페이지에 반영되어 있으므로). 결과적으로 충돌 직전의 커밋된 상태로 복원돼요.

이게 [① 편](/blog/theory/transaction-acid-01-atomicity)에서 다룬 Atomicity의 redo phase와 같은 메커니즘이에요 — WAL은 durability와 crash recovery의 기반이고, atomicity는 그 위에서 redo/undo 기반의 recovery protocol과 함께 구현됩니다. 학계의 표준 알고리즘은 **ARIES**(Algorithms for Recovery and Isolation Exploiting Semantics)이고, InnoDB가 ARIES 계열에 가까워요(redo log + 별도 undo log + steal/no-force). PostgreSQL은 다른 길을 택했어요 — explicit undo log 대신 MVCC로 abort된 트랜잭션의 흔적을 그대로 남겨두고 가시성 규칙으로 처리합니다(나중에 VACUUM으로 정리).

### WAL Segment

WAL은 무한정 커지면 안 되므로 **세그먼트**(고정 크기 파일, PostgreSQL 기본 16MB) 단위로 잘라 써요. 체크포인트가 일어나면(데이터 페이지가 디스크에 안전히 flush됨) 옛 세그먼트는 재활용/삭제 가능해요.

### Redis의 AOF (Append-Only File)

Redis도 WAL과 비슷한 메커니즘을 가져요 — `appendonly yes` 설정 시 모든 쓰기 명령을 AOF에 append합니다. 충돌 시 AOF를 재실행해 메모리 상태를 복원해요. RDB 스냅샷과 함께 쓸 수 있어요(Redis 7부터는 AOF + RDB 혼합인 hybrid persistence가 기본).

> **3장 요약** — WAL은 변경 델타만 순차 쓰기로 디스크에 먼저 기록하는 메커니즘입니다. 데이터 페이지는 나중에 쓰고, 충돌 시 WAL을 redo하여 복원해요. 작고 빠른 쓰기로 durability를 확보하는 게 핵심입니다.

## 4. OS 캐시의 함정 — fsync가 필요한 이유

여기서부터가 진짜 디테일이에요. WAL을 디스크에 쓰는 것조차 그리 단순하지 않습니다.

### OS는 거짓말을 한다

DB가 `write(fd, wal_record, size)` 시스템 콜로 WAL을 쓴다고 해보면. OS(Linux/Windows)는 보통 이렇게 동작해요:

1. DB가 `write()` 호출.
2. OS는 데이터를 **페이지 캐시(메모리)** 에 저장하고, 즉시 *"성공"* 응답.
3. 실제 디스크 쓰기는 나중에 OS가 알아서 함.

이 단계 2에서 OS는 사실상 거짓말을 해요 — DB에는 *"성공"* 이라고 했지만 실제로는 메모리에만 있어요. 만약 이 시점에 전원이 나가면? **WAL 데이터는 사라지고, DB는 사용자에게 이미 *"커밋되었습니다"* 라고 알린 상태입니다. Durability 위반.**

### fsync — OS에게 *"진짜로 디스크에 써라"*

이 문제를 해결하기 위해 OS는 `fsync(fd)` 시스템 콜을 제공해요 — *"이 파일의 모든 변경을 지금 디스크의 비휘발성 매체까지 flush해라."* fsync는 OS 수준에서 디스크 flush를 요청합니다. 다만 진짜 durability는 하드웨어 협력이 있어야 해요 — 디스크의 휘발성 쓰기 캐시, RAID 컨트롤러 캐시, 펌웨어의 write reorder 등이 끼어들면 fsync가 반환된 후에도 전원 차단 시 데이터가 손실될 수 있어요. 이 하드웨어 차원은 아래에서 다시 다룹니다.

![fsync 계층 — 어디까지 안전해야 진짜 durability인가](/uploads/theory/transaction-acid/fsync-layers.svg)

> 즉 fsync는 durability의 충분조건이 아니라 **필요조건에 가깝습니다.** 호출하지 않으면 절대 보장될 수 없지만, 호출했다고 해서 보장되는 것도 아니에요.

DB는 보통 매 커밋마다:

1. WAL 레코드를 `write()`로 OS 캐시에 씀.
2. `fsync()`로 디스크까지 flush.
3. 그 후에 사용자에게 *"커밋 성공"* 응답.

이게 ACID-D의 표준 구현 패턴이에요.

### fsync의 비용

fsync는 비싸요. 대략적으로 HDD에서는 한 자릿수~수십 ms (7200rpm 기준 한 회전이 8ms, 회전 지연이 큰 비중), SATA/NVMe SSD에서는 수십 μs~수 ms 수준 (장치·커널·전원 보호 여부에 따라 편차 큼). 매 커밋마다 fsync를 호출하면 처리량이 떨어지는 건 분명합니다 — 특히 짧은 트랜잭션이 많은 OLTP 워크로드에서 결정적인 병목이 돼요.

이래서 DB들이 fsync를 묶어서(group commit) 처리하거나, 아예 끄거나(asynchronous commit), 하드웨어 도움(NVRAM, 배터리 백업 RAID 컨트롤러)을 받는 등 여러 우회를 써요.

### 진실은 더 어둡다 — 디스크도 거짓말을 한다

앞에서 fsync가 OS-level flush를 요청한다고 했는데, 사실 **디스크 자체에도 캐시**가 있어요. 일부 디스크는 fsync 명령을 받고도 디스크 내부의 휘발성 쓰기 캐시까지만 도착하면 응답합니다. 그 캐시는 전원 차단 시 날아가요.

이래서 PostgreSQL 같은 DB는 `wal_sync_method`로 더 강력한 동기화 방식(`open_datasync`, `fdatasync` 등)을 선택할 수 있어요. 또한 엔터프라이즈 디스크는 BBU(Battery Backup Unit)로 캐시 보호를 합니다.

> MySQL 8.4 공식 매뉴얼이 직접 인정해요: *"Many operating systems and some disk hardware fool the flush-to-disk operation. They may tell mysqld that the flush has taken place, even though it has not. In this case, the durability of transactions is not guaranteed even with the recommended settings, and in the worst case, a power outage can corrupt InnoDB data."*

> **4장 요약** — OS의 페이지 캐시 때문에 단순 `write()`만으로는 durability가 보장되지 않습니다. fsync로 강제 flush해야 하지만 비용이 커요. 디스크 자체 캐시까지 고려하면 진짜 durability는 하드웨어 협력 없이 어렵습니다.

## 5. Durability 다이얼 — DB별 설정

이제 설정을 봐요. 각 DB는 **"얼마나 강하게 fsync할 것인가"** 를 사용자가 선택하게 해줍니다.

![Durability 다이얼 — DB별 설정 매트릭스](/uploads/theory/transaction-acid/durability-dial.svg)

### PostgreSQL의 `synchronous_commit`

PostgreSQL 공식 문서 기준 5단계:

| 값 | 의미 | 데이터 손실 위험 |
|---|---|---|
| `off` | WAL fsync 없이 커밋 응답. 백그라운드에서 비동기로 flush. | 최대 `wal_writer_delay × 3` (기본 ~600ms) |
| `local` | 로컬 WAL fsync 확인 후 응답. 복제는 무관. | 로컬 디스크 보장만 |
| `remote_write`* | 동기 standby의 OS 캐시 도착 확인 후 응답. | standby OS 크래시 시 손실 가능 |
| `on` (기본) | 로컬 WAL fsync (standby 있으면 standby의 디스크 fsync까지) 확인 후 응답. | standby 있을 시: primary와 모든 동기 standby가 동시 손상되어야 손실 |
| `remote_apply`* | 동기 standby가 적용까지 완료한 후 응답 (standby 쿼리에서도 보임). | 가장 강함, 가장 느림 |

`*` `remote_write`/`remote_apply`/`on`(복제 의미)는 `synchronous_standby_names`가 설정되어 있어야 의미가 있어요. PostgreSQL 공식 문서 그대로: *"If synchronous_standby_names is empty, the only meaningful settings are on and off; remote_apply, remote_write and local all provide the same local synchronization level as on."* — 즉 동기 standby가 설정되지 않은 단일 노드에서는 `on`/`local`/`remote_write`/`remote_apply` 모두 같은 동작(로컬 fsync까지)이에요.

또한 `synchronous_commit = off`는 **데이터 손실은 가능하지만 데이터 손상은 일으키지 않아요**(공식 문서 명시). 즉 잃어버린 트랜잭션은 aborted clean된 것처럼 보이고 DB 상태는 일관성을 유지합니다. 이게 `fsync = off`(파라미터 자체를 끄는 더 위험한 설정)와의 결정적 차이.

### MySQL InnoDB의 `innodb_flush_log_at_trx_commit`

MySQL 8.4 공식 매뉴얼 기준 3단계:

| 값 | 의미 | 데이터 손실 위험 |
|---|---|---|
| `0` | 매 커밋 시 아무것도 안 함. WAL은 1초마다 일괄 flush. | 최대 1초 |
| `1` (기본, ACID) | 매 커밋마다 WAL을 디스크까지 flush. | 거의 없음 |
| `2` | 매 커밋마다 WAL을 OS 캐시까지 쓰고 1초마다 fsync. | OS 크래시 시 최대 1초 |

MySQL 매뉴얼이 명시: *"The default setting of 1 is required for full ACID compliance."* `0`이나 `2`는 ACID-D를 일부 포기하는 설정이에요.

> 차이점: `0`과 `2` 모두 1초 손실 가능하지만, `2`는 **DB 크래시 시에는 안전**(OS 캐시까지는 쓰여있음, OS가 살아있으면 결국 fsync됨). `0`은 DB 크래시만으로도 손실 가능. 그래서 실무에서는 *"조금 빠르게"* 가 필요하면 `2`를 선호해요.

### 실용 가이드

| 시나리오 | 권장 설정 |
|---|---|
| 금융, 결제, 주문 | PG: `on` (또는 `remote_apply`로 복제까지) / MySQL: `1` |
| 일반 OLTP | 위와 동일 (성능이 충분하면 default 유지) |
| 분석/배치 적재, 임시 워크로드 | PG: `local`이나 `off` / MySQL: `2` |
| 로그 수집, IoT 메트릭, 캐시 | PG: `off` / MySQL: `0` 또는 `2` |

> **팁**: PostgreSQL은 트랜잭션 단위로 `SET LOCAL synchronous_commit = 'off'`로 설정 변경 가능해요. 즉 중요한 트랜잭션은 강한 durability, 덜 중요한 트랜잭션은 빠른 응답으로 혼합 운영할 수 있습니다. 이게 PostgreSQL의 큰 장점이에요.

> **5장 요약** — Durability는 다이얼입니다. PostgreSQL은 5단계, MySQL InnoDB는 3단계로 얼마나 강하게 fsync할지 선택 가능해요. 워크로드별로 트랜잭션마다 다르게 설정하는 것도 가능합니다.

## 6. Group Commit — 처리량을 살리는 핵심 최적화

매 커밋마다 fsync하면 처리량이 무너진다고 했어요. 그럼 강한 durability를 유지하면서 처리량을 어떻게 올릴까요? 답은 **group commit** 입니다.

### 원리

여러 트랜잭션이 거의 동시에 커밋하려 한다고 가정해요. 각각 fsync하면 N번의 디스크 IO가 필요합니다. 하지만 WAL은 어차피 순차적이고, 한 번의 fsync는 그 시점까지의 모든 WAL을 함께 flush해요.

![Group Commit — 동시 커밋들의 fsync를 한 번에 묶는다](/uploads/theory/transaction-acid/group-commit.svg)

그래서 DB는 이렇게 합니다:

1. 트랜잭션 T1, T2, T3가 거의 동시에 커밋 요청.
2. T1이 fsync를 시작하는 동안 T2, T3는 대기.
3. T1의 fsync가 끝나면 T2, T3의 WAL도 같이 flush됨 (그들이 쓴 WAL이 T1의 fsync 시점 이전에 OS 캐시에 도착했으므로).
4. **한 번의 fsync로 세 트랜잭션 모두 디스크 보장 확보.**

결과: N개 트랜잭션이 1번의 fsync 비용을 공유. 처리량 확보.

### 실전

PostgreSQL과 MySQL InnoDB 모두 group commit을 자동으로 합니다. 별도로 켜거나 끄는 설정은 없어요. PostgreSQL에는 `commit_delay`/`commit_siblings`로 강제로 더 큰 그룹을 만드는 미세조정이 있지만 — 공식 가이드와 *PostgreSQL 10 High Performance* 책 모두 *"대부분의 경우 효과 없거나 오히려 느려질 수 있다"* 고 권고해요. 즉 group commit은 기본적으로 잘 동작하고, 실무에서는 거의 손대지 않는 영역입니다.

> **6장 요약** — Group commit은 동시 커밋들의 fsync를 묶어 처리하는 최적화예요. 강한 durability를 유지하면서 처리량을 확보하는 핵심 기법이고, 현대 RDBMS는 자동으로 합니다.

## 7. InnoDB Doublewrite Buffer — 부분 쓰기 문제

WAL과 별개로, InnoDB에는 또 하나의 흥미로운 메커니즘이 있어요 — **doublewrite buffer**.

### 부분 쓰기(Torn Page) 문제

InnoDB의 데이터 페이지는 보통 16KB. 그런데 OS/디스크의 atomic write 단위는 보통 4KB(또는 512B). 그래서 InnoDB가 16KB 페이지를 쓰는 도중 전원이 나가면, **일부만 쓰여진 *깨진 페이지(torn page)*** 가 디스크에 남을 수 있어요.

WAL만으로는 이 문제를 못 풀어요 — WAL은 논리적 변경 기록(*"이 위치를 X에서 Y로 변경"*)이기 때문에, 페이지 자체가 물리적으로 깨져있으면 그 위에 델타를 적용해봐야 결과가 보장되지 않아요. 즉 **깨진 페이지 자체를 복구할 수단이 별도로 필요**합니다.

### Doublewrite Buffer의 해결법

InnoDB는 데이터 페이지를 디스크에 쓰기 전에 **연속된 doublewrite 영역에 먼저** 씁니다. 그 후 실제 위치에 써요. (저장 위치는 MySQL 8.0.20 이전엔 시스템 테이블스페이스 내, 8.0.20 이후엔 별도의 doublewrite 파일.)

![Torn Page 방어 — InnoDB doublewrite vs PostgreSQL full_page_writes](/uploads/theory/transaction-acid/torn-page.svg)

크래시 후 복구 시:

- **실제 위치의 페이지가 깨졌으면** → doublewrite buffer의 깨끗한 복사본으로 복원.
- **doublewrite buffer가 깨졌으면** → 실제 위치의 페이지를 사용 (실제 쓰기는 시작도 안 한 것).

> 이름은 *"double write"* 지만 I/O가 두 배가 되지는 않아요. MySQL 8.4 공식 매뉴얼: *"doublewrite buffer does not require twice as much I/O overhead or twice as many I/O operations. Data is written to the doublewrite buffer in a large sequential chunk, with a single fsync() call."* 즉 한 번의 fsync로 여러 페이지를 묶어 처리합니다. 실제 성능 영향은 워크로드에 따라 다른데 — Percona 분석 기준 SSD/NVMe + MySQL 8.0.20+ 환경에서는 보통 5~10% 수준이지만, HDD + 쓰기 집중 워크로드에서는 50% 이상의 처리량 손실까지 보고된 사례가 있어요.

PostgreSQL은 다른 방법(`full_page_writes = on`, 기본값)으로 같은 문제를 풀어요 — **체크포인트 후 첫 변경 시 페이지 전체를 WAL에 기록**.

> **7장 요약** — InnoDB doublewrite buffer는 부분 쓰기(torn page) 문제 방어 메커니즘입니다. PostgreSQL의 `full_page_writes`도 같은 문제의 다른 해법. WAL만으로는 페이지 단위 atomic write가 보장되지 않는다는 점에서 출발해요.

## 8. Checkpoint — WAL과 데이터 페이지의 만남

WAL이 무한정 쌓이지 않게, 그리고 충돌 후 복구가 너무 오래 걸리지 않게 하려면 **체크포인트** 가 필요해요.

### 체크포인트의 역할

체크포인트는 다음을 합니다:

- 메모리(buffer pool)의 dirty page들을 디스크의 실제 위치에 flush.
- 그 시점까지의 WAL은 더 이상 redo에 필요 없으므로 재활용 가능 표시.
- 충돌 후 복구는 이 체크포인트 이후의 WAL만 재실행하면 됨.

### 트레이드오프

- **잦은 체크포인트**: 복구 빠름, 하지만 dirty page flush IO가 많아져 평소 처리량 저하.
- **드문 체크포인트**: 평소 IO 적음, 하지만 복구 시간 길어짐.

PostgreSQL: `checkpoint_timeout` (기본 5분), `max_wal_size`(WAL 누적 크기 임계).
MySQL InnoDB: `innodb_log_file_size`로 redo log 크기 조절(체크포인트 빈도와 직결).

이 다이얼은 durability와는 직접 관계 없지만 — 어차피 WAL이 fsync되어 있으면 데이터는 안전합니다 — 복구 시간과 평소 IO 부담을 조절해요.

> **8장 요약** — 체크포인트는 dirty page를 디스크에 반영해 WAL을 재활용 가능하게 만드는 작업입니다. 빈도 설정은 복구 시간과 평소 IO 사이의 트레이드오프예요.

## 9. 정리

### 핵심 통찰

- **Durability ≠ 디스크 쓰기**: *"DB가 디스크에 쓴다"* 는 말은 OS 캐시까지일 뿐. 진짜 durability는 fsync로 OS-level flush를 요청한 후에도 하드웨어 캐시까지 안전해야 보장돼요 (BBU, atomic write, 적절한 fs barrier 등).
- **fsync는 비싸다**: 매 커밋마다 fsync하면 처리량이 무너지므로 group commit이 필수.
- **Durability는 다이얼이다**: PostgreSQL의 `synchronous_commit`, MySQL의 `innodb_flush_log_at_trx_commit`로 강도를 조절합니다. ACID 네 글자 중 설정으로 가장 직접적으로 trade-off를 조절할 수 있는 영역.
- **WAL이 durability와 recovery의 기반**: 변경 델타를 작고 빠르게 디스크에 기록하는 메커니즘이 D(지속성)와 충돌 복구의 핵심이에요. A(원자성)는 그 위에서 redo/undo 기반의 recovery protocol과 함께 구현됩니다 — 대표 알고리즘이 ARIES이고, InnoDB가 가까운 계열, PostgreSQL은 MVCC로 다른 길을 택했어요.
- **하드웨어도 거짓말한다**: OS 캐시 + 디스크 캐시 때문에 진짜 durability는 BBU나 atomic write 같은 하드웨어 협력 없이 어렵습니다.
- **부분 쓰기 방어**: WAL만으로는 페이지 단위 atomic write가 보장되지 않으므로 doublewrite buffer / `full_page_writes` 같은 추가 메커니즘이 필요해요.

> 결국 Durability는 *"데이터가 언제까지 안전한가"* 가 아니라 **"어디까지를 안전하다고 정의할 것인가"** 의 문제예요. OS 캐시까지인지, 로컬 디스크 매체까지인지, 동기 standby의 디스크까지인지, standby의 적용까지인지 — 시스템마다 답이 다르고, 그 경계를 어디에 그을 것인지가 곧 워크로드의 trade-off 선택입니다.

## 시리즈 마무리

ACID 네 글자를 모두 다뤘어요:

- [① Atomicity](/blog/theory/transaction-acid-01-atomicity): 전부 성공 or 전부 실패. WAL의 redo + undo로 구현.
- [② Isolation](/blog/theory/transaction-acid-02-isolation): 동시 트랜잭션 사이의 가시성 제어. MVCC + 격리 수준.
- [③ Consistency](/blog/theory/transaction-acid-03-consistency): 트랜잭션이 무결성 제약을 유지. 사실상 애플리케이션 책임 + DB의 제약 강제.
- **④ Durability**: 커밋된 변경은 영속. WAL + fsync + group commit + doublewrite buffer.

ACID는 단순한 4글자가 아니라, 수십 년의 DB 엔지니어링이 응축된 약속이에요. 각 글자 뒤에는 trade-off가 있고, 그 trade-off를 안다는 게 백엔드 개발자의 깊이를 만듭니다.

## 참고 (1차 자료 우선)

- [PostgreSQL Documentation — Reliability and the Write-Ahead Log](https://www.postgresql.org/docs/current/wal-intro.html) — WAL 메커니즘 공식 설명
- [PostgreSQL Documentation — synchronous_commit 설정](https://www.postgresql.org/docs/current/runtime-config-wal.html#GUC-SYNCHRONOUS-COMMIT) — 5단계 옵션의 정확한 의미
- [MySQL 8.4 Reference — innodb_flush_log_at_trx_commit](https://dev.mysql.com/doc/refman/8.4/en/innodb-parameters.html#sysvar_innodb_flush_log_at_trx_commit) — 0/1/2 옵션 + ACID 준수 명시
- [MySQL 8.4 Reference — Doublewrite Buffer](https://dev.mysql.com/doc/refman/8.4/en/innodb-doublewrite-buffer.html) — torn page 방어 메커니즘
- [Percona — PostgreSQL synchronous_commit Options and Synchronous Standby Replication](https://www.percona.com/blog/postgresql-synchronous_commit-options-and-synchronous-standby-replication/) — 각 옵션의 단계별 그림과 트레이드오프
- [Cybertec — The synchronous_commit parameter and streaming replication](https://www.cybertec-postgresql.com/en/the-synchronous_commit-parameter-and-streaming-replication/) — TPS 비교 벤치마크 포함
- [Redis Persistence Documentation](https://redis.io/docs/management/persistence/) — RDB + AOF 하이브리드 모델
- Andreas Reuter & Theo Härder, *Principles of Transaction-Oriented Database Recovery* (1983) — ACID 원전 논문

<!-- EN -->

## 0. Introduction

The last letter of the ACID series — **D (Durability)**. The definition is simple: *"committed changes persist."* But the moment you go in, it never ends. The core message of this post: **"Durability is the letter of ACID where you can dial the trade-off most directly via configuration."** Settings like PostgreSQL's `synchronous_commit` and MySQL InnoDB's `innodb_flush_log_at_trx_commit` are dials between strong durability and throughput. To turn that dial safely you need to understand WAL, fsync, group commit, and the doublewrite buffer.

## 1. Definition — If It Is Committed, It Survives

> **Durability**: after a transaction commits, its changes survive system crashes, power loss, and OS crashes — they remain on non-volatile storage.

The key word is **"committed"**. Uncommitted transactions have no obligation to survive (in fact [Part ①](/blog/theory/transaction-acid-01-atomicity) — atomicity — has the duty to erase them). From the user's perspective: *"the moment I receive the commit response, I can pull the plug and the data must still be there when the system comes back up."*

Whether the storage is SSD, HDD, or NVMe doesn't matter. What matters is that the data survives.

## 2. Why Is Durability Slow?

Intuitively you may think *"writing to a DB writes to disk,"* but actually writing to disk is slow. Very slow. Memory writes are nanoseconds, SSD writes are microseconds, HDD writes are milliseconds — **orders of magnitude differ by 100~1000×**.

Imagine the DB had to write the following to disk on every transaction:

- The data row itself
- Indexes (B-tree, hash, etc.)
- System metadata (transaction logs, statistics, etc.)

If you wrote all of that directly to disk every time, throughput would collapse. So DBs have solved this with two strategies:

- **WAL (Write-Ahead Log)** — write only the change delta into a small log quickly; the actual data pages are written later, asynchronously.
- **Memory buffer + periodic snapshot** — keep all writes in memory and flush to disk in the background.

> Redis is a great example that offers both — RDB (snapshot) and AOF (Append-Only File, similar to WAL). From Redis 7, the hybrid combining the two is the default. So calling *"Redis = the snapshot family"* is inaccurate.

Most RDBMSs use approach 1 (WAL). Let's go deep.

> **Section 2 takeaway** — Disks are orders of magnitude slower than memory. Writing all data to disk on every transaction collapses throughput, so DBs use detours like WAL or memory buffers.

## 3. WAL (Write-Ahead Log) — Write Only the Delta, Quickly

### Core principle

> **WAL's core**: write a log of the change before writing the data pages to disk. A transaction is considered committed only once that log is safely written to disk.

![WAL — write the delta to disk first, data pages later](/uploads/theory/transaction-acid/wal-flow.svg)

Why is this fast? Because **only the change delta** is recorded — a small record like *"change row 7's balance from 100 to 200."* That is much smaller than writing the whole data page (PostgreSQL 8KB, InnoDB 16KB). Plus WAL is a **sequential write**, and disks are optimized for sequential writes (no head movement on HDD; less GC pressure on SSD).

### Crash recovery — Redo

If the DB crashes, in-memory changes (not yet reflected in data pages) are lost. But the WAL is on disk. On restart, the DB reads WAL from the last checkpoint and *redoes* the changes (it does not start from the very beginning — anything before the checkpoint is already in the data pages). The result is the committed state from just before the crash.

This is the same mechanism as the redo phase of Atomicity from [Part ①](/blog/theory/transaction-acid-01-atomicity) — WAL is the basis for both durability and crash recovery, and atomicity is implemented on top with a redo/undo recovery protocol. The canonical algorithm in academia is **ARIES** (Algorithms for Recovery and Isolation Exploiting Semantics); InnoDB is in the ARIES family (redo log + separate undo log + steal/no-force). PostgreSQL went a different route — instead of an explicit undo log, it leaves traces of aborted transactions via MVCC and resolves them with visibility rules (later cleaned by VACUUM).

### WAL Segment

WAL must not grow indefinitely, so it is sliced into **segments** (fixed-size files; PostgreSQL default 16MB). When a checkpoint happens (data pages are safely flushed), older segments become recyclable / deletable.

### Redis AOF (Append-Only File)

Redis has a similar mechanism — with `appendonly yes`, every write command is appended to the AOF. On crash, AOF is replayed to restore in-memory state. It can be combined with RDB snapshots (Redis 7 defaults to a hybrid persistence of AOF + RDB).

> **Section 3 takeaway** — WAL is the mechanism that writes only the change delta to disk first, sequentially. Data pages are written later, and recovery replays WAL to restore. Securing durability with small, fast writes is the core idea.

## 4. The Trap of OS Cache — Why fsync Is Necessary

This is where the real detail lives. Even writing WAL to disk is not that simple.

### The OS lies

Suppose the DB writes WAL via `write(fd, wal_record, size)`. The OS (Linux/Windows) typically does this:

1. The DB calls `write()`.
2. The OS stores the data in the **page cache (memory)** and immediately returns *"success."*
3. The actual disk write happens later, when the OS decides.

In step 2 the OS is essentially lying — it told the DB *"success"* but the data is in memory. If the power fails right then? **The WAL is gone, and the DB has already told the user *"committed."* That is a durability violation.**

### fsync — telling the OS *"actually write to disk"*

The OS provides the `fsync(fd)` system call to fix this — *"flush all changes to this file all the way to non-volatile media now."* fsync requests an OS-level flush. But true durability requires hardware cooperation — disk volatile write caches, RAID controller caches, firmware write reordering can all sneak in, so even after fsync returns, a power-cut can lose data. We revisit the hardware level below.

![fsync layers — how far do you need to be safe for real durability?](/uploads/theory/transaction-acid/fsync-layers.svg)

> So fsync is not a sufficient condition for durability — it is closer to a **necessary** one. Without it, durability cannot be guaranteed; with it, it still is not automatically guaranteed.

The DB typically does on every commit:

1. Write the WAL record into the OS cache via `write()`.
2. Flush to disk via `fsync()`.
3. Then return *"commit success"* to the user.

This is the standard ACID-D implementation pattern.

### The cost of fsync

fsync is expensive. Roughly, single-digit to tens of ms on HDD (a 7200rpm rotation is 8ms, with rotational latency dominating); tens of μs to a few ms on SATA/NVMe SSD (with significant variance based on device, kernel, and power-loss protection). Calling fsync on every commit clearly tanks throughput — it is the decisive bottleneck for OLTP workloads with many short transactions.

That is why DBs use detours like batching fsync (group commit), turning it off (asynchronous commit), or relying on hardware help (NVRAM, battery-backed RAID controllers).

### The truth is darker — disks lie too

Above we said fsync requests an OS-level flush, but the **disk itself has a cache** too. Some disks acknowledge fsync as soon as data reaches the disk's volatile write cache. That cache vanishes on power loss.

That is why DBs like PostgreSQL let you choose stronger sync methods via `wal_sync_method` (`open_datasync`, `fdatasync`, etc.). Enterprise disks protect their caches with a BBU (Battery Backup Unit).

> The MySQL 8.4 manual openly admits: *"Many operating systems and some disk hardware fool the flush-to-disk operation. They may tell mysqld that the flush has taken place, even though it has not. In this case, the durability of transactions is not guaranteed even with the recommended settings, and in the worst case, a power outage can corrupt InnoDB data."*

> **Section 4 takeaway** — Because of OS page cache, plain `write()` does not guarantee durability. fsync forces a flush but is expensive. Considering disk caches, true durability is hard without hardware cooperation.

## 5. The Durability Dial — Settings Per DB

Now the configuration. Each DB lets you choose **how strongly to fsync**.

![Durability dial — per-DB setting matrix](/uploads/theory/transaction-acid/durability-dial.svg)

### PostgreSQL `synchronous_commit`

Five levels per the PostgreSQL official docs:

| Value | Meaning | Data-loss risk |
|---|---|---|
| `off` | Reply commit without WAL fsync. Asynchronously flushed in the background. | Up to `wal_writer_delay × 3` (default ~600ms) |
| `local` | Reply after local WAL fsync. Replication is irrelevant. | Local-disk guarantee only |
| `remote_write`* | Reply after sync standby's OS cache has the write. | Possible loss on standby OS crash |
| `on` (default) | Reply after local WAL fsync (and standby disk fsync if there is one). | With standbys: only lost if primary and all sync standbys fail simultaneously |
| `remote_apply`* | Reply only after sync standby has applied the change (visible on standby queries). | Strongest, slowest |

`*` `remote_write`/`remote_apply`/`on`'s replica meaning is meaningful only when `synchronous_standby_names` is set. Per the PostgreSQL docs verbatim: *"If synchronous_standby_names is empty, the only meaningful settings are on and off; remote_apply, remote_write and local all provide the same local synchronization level as on."* — meaning on a single node with no sync standbys, `on`/`local`/`remote_write`/`remote_apply` all behave the same (local fsync only).

Also, `synchronous_commit = off` **may lose data but does not cause data corruption** (per official docs). Lost transactions look as if they were aborted cleanly, and the DB stays consistent. That is the decisive difference from `fsync = off` (a far more dangerous setting that disables the parameter itself).

### MySQL InnoDB `innodb_flush_log_at_trx_commit`

Three levels per the MySQL 8.4 manual:

| Value | Meaning | Data-loss risk |
|---|---|---|
| `0` | Do nothing on commit. WAL is bulk-flushed every 1 second. | Up to 1 second |
| `1` (default, ACID) | Flush WAL all the way to disk on every commit. | Almost none |
| `2` | Write WAL to OS cache on every commit, fsync once per second. | Up to 1 second on OS crash |

The MySQL manual states: *"The default setting of 1 is required for full ACID compliance."* `0` and `2` are explicit choices to give up part of ACID-D.

> Difference: both `0` and `2` can lose up to 1 second, but `2` is **safe on DB crash** (data is in OS cache; if the OS lives, fsync eventually happens). `0` can lose data even on DB-only crash. So in practice when *"a bit faster"* is needed, people prefer `2`.

### Practical guide

| Scenario | Recommended |
|---|---|
| Finance, payments, orders | PG: `on` (or `remote_apply` to include replicas) / MySQL: `1` |
| General OLTP | Same as above (keep defaults if perf is fine) |
| Analytics / batch loads / temporary workloads | PG: `local` or `off` / MySQL: `2` |
| Log collection, IoT metrics, cache | PG: `off` / MySQL: `0` or `2` |

> **Tip**: PostgreSQL allows per-transaction changes via `SET LOCAL synchronous_commit = 'off'`. Critical transactions get strong durability, less critical ones get a fast response — mixed-mode operation. A big PostgreSQL win.

> **Section 5 takeaway** — Durability is a dial. PostgreSQL has 5 levels, MySQL InnoDB has 3, choosing how strongly to fsync. You can also vary it per transaction by workload.

## 6. Group Commit — The Core Optimization That Saves Throughput

We said that fsyncing every commit tanks throughput. So how do you keep strong durability and lift throughput? The answer is **group commit**.

### Principle

Suppose multiple transactions try to commit at almost the same time. fsyncing each requires N disk I/Os. But WAL is sequential, and a single fsync flushes everything in the WAL up to that point.

![Group Commit — bundle concurrent commits' fsync into one](/uploads/theory/transaction-acid/group-commit.svg)

So the DB does:

1. Transactions T1, T2, T3 all request commit at almost the same time.
2. T1 starts an fsync; T2 and T3 wait.
3. When T1's fsync finishes, T2 and T3's WAL is flushed too (their WAL records reached the OS cache before T1's fsync point).
4. **One fsync, durability for all three.**

Result: N transactions share the cost of 1 fsync. Throughput secured.

### In practice

PostgreSQL and MySQL InnoDB both do group commit automatically. There is no toggle to enable/disable. PostgreSQL has `commit_delay`/`commit_siblings` for fine-tuning the group size, but both the official guide and *PostgreSQL 10 High Performance* warn that *"in most cases it has no effect or even slows things down."* Group commit just works by default and is rarely touched in practice.

> **Section 6 takeaway** — Group commit bundles concurrent commits' fsyncs. It is the key technique for keeping strong durability while securing throughput, and modern RDBMSs do it automatically.

## 7. InnoDB Doublewrite Buffer — The Partial Write Problem

Separate from WAL, InnoDB has another interesting mechanism — the **doublewrite buffer**.

### The torn page problem

InnoDB data pages are typically 16KB. But the OS/disk atomic write unit is usually 4KB (or 512B). So if power fails while InnoDB is writing a 16KB page, a **partially-written *torn page*** can remain on disk.

WAL alone cannot solve this — WAL is a logical change record (*"change this location from X to Y"*), so if the page itself is physically torn, applying the delta does not guarantee a correct result. **You need a separate way to recover the page itself.**

### The doublewrite buffer's solution

InnoDB writes data pages to a **contiguous doublewrite area first**, then to the actual location. (Storage location: inside the system tablespace before MySQL 8.0.20; in a separate doublewrite file from 8.0.20 on.)

![Torn Page defense — InnoDB doublewrite vs PostgreSQL full_page_writes](/uploads/theory/transaction-acid/torn-page.svg)

On crash recovery:

- **If the actual-location page is torn** → restore from the clean copy in the doublewrite buffer.
- **If the doublewrite buffer is torn** → use the actual-location page (the actual write never started).

> Despite the name *"double write,"* I/O does not double. MySQL 8.4 manual: *"doublewrite buffer does not require twice as much I/O overhead or twice as many I/O operations. Data is written to the doublewrite buffer in a large sequential chunk, with a single fsync() call."* That is, multiple pages are batched into one fsync. Real-world impact varies — per Percona analyses, on SSD/NVMe + MySQL 8.0.20+ it is usually 5-10%, but on HDD + write-heavy workloads, throughput losses of 50%+ have been reported.

PostgreSQL solves the same problem differently with `full_page_writes = on` (default) — **after a checkpoint, the first change to a page writes the entire page to WAL**.

> **Section 7 takeaway** — The InnoDB doublewrite buffer defends against torn pages. PostgreSQL's `full_page_writes` is a different solution to the same problem. They both start from the fact that WAL alone does not guarantee atomic page writes.

## 8. Checkpoint — Where WAL and Data Pages Meet

To prevent WAL from growing indefinitely and to keep recovery time bounded, you need **checkpoints**.

### What a checkpoint does

- Flush dirty pages from the buffer pool to their actual location on disk.
- Mark WAL up to that point as no longer needed for redo, so it can be recycled.
- Crash recovery only needs to replay WAL after the checkpoint.

### Trade-off

- **Frequent checkpoints**: faster recovery, but more dirty-page flush I/O lowering steady-state throughput.
- **Infrequent checkpoints**: less steady-state I/O, but longer recovery.

PostgreSQL: `checkpoint_timeout` (default 5 min), `max_wal_size` (WAL accumulation threshold).
MySQL InnoDB: `innodb_log_file_size` controls redo log size (directly tied to checkpoint frequency).

This dial is not directly about durability — once WAL is fsynced, data is safe — but it tunes recovery time vs steady-state I/O burden.

> **Section 8 takeaway** — Checkpoints reflect dirty pages to disk so that WAL becomes recyclable. The frequency setting is a trade-off between recovery time and steady-state I/O.

## 9. Wrap-up

### Key insights

- **Durability ≠ writing to disk**: *"the DB writes to disk"* really means *"to the OS cache."* True durability requires that fsync's OS-level flush is also safe at the hardware-cache level (BBU, atomic writes, proper fs barriers).
- **fsync is expensive**: fsyncing every commit collapses throughput, so group commit is essential.
- **Durability is a dial**: PostgreSQL's `synchronous_commit` and MySQL's `innodb_flush_log_at_trx_commit` tune the strength. Of the four ACID letters, durability is the area where settings most directly trade off.
- **WAL is the foundation of durability and recovery**: writing change deltas to disk small and fast is the core of D and crash recovery. A is implemented on top with a redo/undo recovery protocol — the canonical algorithm is ARIES, with InnoDB closer to that family; PostgreSQL chose a different MVCC-based path.
- **Hardware lies too**: with OS cache + disk cache, true durability is hard without hardware cooperation like BBU or atomic write.
- **Defending against partial writes**: WAL alone does not guarantee atomic page writes, so additional mechanisms like the doublewrite buffer / `full_page_writes` are needed.

> Ultimately, Durability is not the question of *"how long is the data safe"* but **"where do you draw the line of safe."** Up to the OS cache? The local disk media? The sync standby's disk? The standby's apply? Different systems answer differently, and where you draw that line is the workload's trade-off choice.

## Series Wrap-up

We covered all four letters of ACID:

- [① Atomicity](/blog/theory/transaction-acid-01-atomicity): all succeed or all fail. Implemented with WAL redo + undo.
- [② Isolation](/blog/theory/transaction-acid-02-isolation): visibility control between concurrent transactions. MVCC + isolation levels.
- [③ Consistency](/blog/theory/transaction-acid-03-consistency): transactions maintain integrity constraints. Mostly the application's responsibility + DB-enforced constraints.
- **④ Durability**: committed changes persist. WAL + fsync + group commit + doublewrite buffer.

ACID is not just four letters but a promise compressed from decades of DB engineering. Behind each letter is a trade-off, and knowing those trade-offs is what gives a backend developer depth.

## References (Primary Sources First)

- [PostgreSQL Documentation — Reliability and the Write-Ahead Log](https://www.postgresql.org/docs/current/wal-intro.html) — official WAL mechanism reference
- [PostgreSQL Documentation — synchronous_commit](https://www.postgresql.org/docs/current/runtime-config-wal.html#GUC-SYNCHRONOUS-COMMIT) — exact meaning of all 5 levels
- [MySQL 8.4 Reference — innodb_flush_log_at_trx_commit](https://dev.mysql.com/doc/refman/8.4/en/innodb-parameters.html#sysvar_innodb_flush_log_at_trx_commit) — 0/1/2 + ACID compliance note
- [MySQL 8.4 Reference — Doublewrite Buffer](https://dev.mysql.com/doc/refman/8.4/en/innodb-doublewrite-buffer.html) — torn-page defense
- [Percona — PostgreSQL synchronous_commit Options and Synchronous Standby Replication](https://www.percona.com/blog/postgresql-synchronous_commit-options-and-synchronous-standby-replication/) — diagrams and trade-offs per option
- [Cybertec — The synchronous_commit parameter and streaming replication](https://www.cybertec-postgresql.com/en/the-synchronous_commit-parameter-and-streaming-replication/) — TPS comparison benchmarks
- [Redis Persistence Documentation](https://redis.io/docs/management/persistence/) — RDB + AOF hybrid model
- Andreas Reuter & Theo Härder, *Principles of Transaction-Oriented Database Recovery* (1983) — the foundational ACID paper

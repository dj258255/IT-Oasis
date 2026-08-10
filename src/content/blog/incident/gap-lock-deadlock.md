---
title: '갭 락 데드락, "없으면 넣는다"가 만드는 교착'
description: 'MySQL 8.4.3 REPEATABLE READ에서 "없으면 넣는다" 패턴이 만드는 갭 락 데드락을 두 세션으로 재현하고, performance_schema.data_locks로 락이 걸린 순간을 포착했습니다. 두 트랜잭션이 같은 갭에 X 갭 락을 동시에 GRANTED로 잡은 뒤 서로의 insert intention 락을 막습니다. 해소 두 가지를 각각 30회(시도 60건) 돌린 결과, 원래 방식은 데드락 30회, INSERT ... ON DUPLICATE KEY UPDATE는 0회, READ COMMITTED는 데드락 0회에 중복키 에러 30회였습니다. READ COMMITTED는 탐색과 인덱스 스캔의 갭 락만 끄고 외래키 검사와 중복키 검사에는 갭 락을 그대로 쓰며, 행 기반 바이너리 로깅이 전제입니다. 격리 수준을 BEGIN 뒤에서 바꾸면 변수만 바뀌고 실행 중인 트랜잭션은 그대로 REPEATABLE READ로 돕니다.'
date: 2026-03-10
tags:
  - MySQL
  - InnoDB
  - Deadlock
  - Gap Lock
  - Transaction
  - Isolation
  - Concurrency
  - Performance Schema
category: incident/LockTx
series: '데이터베이스가 무너지는 지점'
seriesOrder: 8
coverImage: /uploads/incident/gap-lock-deadlock/fig-locks.png
---

> 근거 등급: `E1·축소`
> 출처: [KINTO Technologies, 本番環境で発生したAurora MySQL 3 系のデッドロックの原因を調査した話](https://blog.kinto-technologies.com/posts/2024-12-11-mysql-deadlock/) · [MySQL 8.4, InnoDB Locking (gap locks, insert intention locks)](https://dev.mysql.com/doc/refman/8.4/en/innodb-locking.html) · [Deadlocks in InnoDB](https://dev.mysql.com/doc/refman/8.4/en/innodb-deadlocks.html)

## 1. 유명한 이유

실무에서 흔한 데드락은 두 트랜잭션이 자원을 반대 순서로 잡는 고전적 형태만이 아닙니다. **같은 코드가 동시에 두 번 실행됐을 뿐인데** 나는 데드락입니다.

정산이나 집계에서 "그 날짜 행이 있으면 더하고 없으면 만든다"를 짤 때, 자연스러운 코드는 이렇습니다.

```sql
SELECT id FROM settlement WHERE live_id=? AND settle_date=? FOR UPDATE;  -- 확인
INSERT INTO settlement (...) VALUES (...);                                -- 없으면 삽입
```

두 요청이 동시에 오면 이 코드가 데드락을 냅니다. 원인은 REPEATABLE READ의 갭 락과 insert intention 락의 조합입니다. MySQL 공식 문서가 두 락을 각각 정의해 두었지만, 둘이 만났을 때 어떻게 되는지는 직접 재봐야 감이 옵니다.

이 세션은 그 조합을 재현하고, `performance_schema.data_locks`로 **락이 걸린 순간의 상태**를 포착하고, `SHOW ENGINE INNODB STATUS`의 데드락 그래프를 읽습니다. 그다음 해소 두 가지를 각각 30회씩 돌려 데드락이 실제로 사라지는지 셉니다.

### 같은 코드로 결제가 실패한 회사가 있습니다

토요타 계열 KINTO Technologies가 Aurora MySQL 결제 플랫폼에서 겪은 것을 공개했습니다. 인기 상품 발매로 신청이 몰린 날 카드 결제가 실패하고 로그에 `Deadlock found when trying to get lock; try restarting transaction`이 찍혔습니다. 문제가 된 쿼리는 중복 결제를 막으려고 넣은 `SELECT * FROM PAYMENTS where request_id = '' FOR UPDATE`였고, 원문은 해당 `request_id`의 데이터가 아직 삽입되기 전이라 이 쿼리가 헛돌면서 갭 락을 잡았다고 적습니다. 이어지는 INSERT가 삽입 의도 갭 락을 잡으려다 먼저 잡힌 갭 락과 충돌해 대기가 생겼고 MySQL이 데드락을 검지했다는 설명이 뒤따릅니다. 이 세션이 재현한 순서와 같습니다.

세 가지는 구분해서 봐야 합니다. 첫째, 글에 실린 `SHOW ENGINE INNODB STATUS` 출력은 프로덕션에서 뜬 것이 아니라 운영 요청 값을 그대로 써서 로컬에서 재현한 것입니다. 프로덕션 쪽 증거는 에러 로그와 상품팀의 신고입니다. 둘째, 이들이 고른 해소는 아래 3절의 두 방법이 아니라 확인 후 삽입이라는 구조 자체를 버리고 요청을 받는 시점에 가등록하고 트랜잭션을 즉시 커밋하는 설계 변경이었습니다. 셋째, 부하 테스트가 이 문제를 놓친 이유를 원문이 밝히는데 인덱스 단편화를 걱정해 `request_id`에 UUID를 넣었기 때문입니다. 값이 매번 달라 같은 갭에 두 트랜잭션이 몰리지 않았습니다.

## 2. 재현

### 환경

MySQL 8.4.3, REPEATABLE READ(기본값), `innodb_print_all_deadlocks=ON`. 데드락은 부하가 아니라 순서 문제라서 스레드 두 개면 재현됩니다. 자원 상한은 걸지 않았습니다.

재현 스크립트는 Python 스레드 2개를 `threading.Barrier`로 맞춰 두 세션의 진행을 동기화하고, `innodb_lock_wait_timeout=10`을 걸었습니다. 호스트 사양은 기록하지 않았습니다.

`SHOW ENGINE INNODB STATUS`는 `innodb_print_all_deadlocks` 값과 상관없이 **마지막 데드락 한 건만** 보여줍니다. MySQL 문서도 "To view the last deadlock in an InnoDB user transaction, use SHOW ENGINE INNODB STATUS"라고 적습니다. 그래서 이 명령의 `LATEST DETECTED DEADLOCK` 블록은 새 데드락이 날 때까지 같은 내용을 계속 되풀이합니다. 운영에서 데드락을 전부 추적하려면 `innodb_print_all_deadlocks=ON`으로 켜서 에러 로그에 남겨야 하고, 이 세션도 그렇게 켜 두었습니다.

아래 두 증거는 모두 **단일 스냅숏**입니다. `data_locks` 출력은 두 세션이 INSERT 직전인 한 순간을 한 번 찍은 것이고, 데드락 그래프도 그 시점에 남아 있던 마지막 한 건입니다. 30회 반복해 센 것은 3절의 데드락 발생 횟수뿐이고, 락 상태 자체를 여러 번 관측해 같은 모양이 나오는지 확인하지는 않았습니다.

### 락이 걸린 순간

![락 상태](/uploads/incident/gap-lock-deadlock/fig-locks.png)

```
트랜잭션 2658  uk_live_date  X,GAP                   GRANTED   2, 1037565, 301
트랜잭션 2658  uk_live_date  X,GAP,INSERT_INTENTION  WAITING   2, 1037565, 301
트랜잭션 2659  uk_live_date  X,GAP                   GRANTED   2, 1037565, 301
```

세 줄이 이 세션의 전부입니다.

1. 두 트랜잭션이 **같은 갭에 X 갭 락을 동시에 GRANTED로 잡고 있습니다.** 갭 락끼리는 서로를 막지 않습니다. 갭 락의 목적은 "이 구간에 새 행이 들어오는 것을 막는 것"이지 "다른 갭 락을 막는 것"이 아니기 때문입니다.
2. 그런데 INSERT는 그 갭에 **insert intention 락**을 요청합니다. 이 락은 갭 락과 충돌합니다.
3. A의 insert intention이 B의 갭 락에 막히고, B의 것이 A의 갭 락에 막힙니다. 서로를 기다립니다.

`SELECT ... FOR UPDATE`가 성공했을 때 "내가 이 자리를 확보했다"고 읽으면 틀립니다. 확보한 것은 **다른 트랜잭션이 넣지 못하게 하는 권리**이지, 내가 넣을 수 있는 권리가 아닙니다.

### 데드락 그래프

![데드락 그래프](/uploads/incident/gap-lock-deadlock/fig-graph.png)

`SHOW ENGINE INNODB STATUS`의 출력을 읽는 순서는 이렇습니다.

- `*** (1) TRANSACTION:` 아래 `HOLDS THE LOCK(S)`와 `WAITING FOR THIS LOCK`
- `*** (2) TRANSACTION:` 아래 같은 두 항목
- `*** WE ROLL BACK TRANSACTION (2)` (InnoDB가 희생자로 고른 쪽)

락 대상이 `supremum` 레코드로 찍히는 것도 갭 락의 표시입니다. 마지막 레코드 뒤의 열린 구간을 잠글 때 supremum 의사 레코드에 락을 겁니다.

## 3. 해소

같은 시나리오를 두 방법으로 고쳐 각각 30회(시도 60건)씩 돌렸습니다.

| 방법 | 데드락 | 중복키 에러 | 판단 |
|---|---|---|---|
| 원래 방식 (`SELECT FOR UPDATE` 후 `INSERT`) | **30회** | 0 | 재현 기준 |
| `INSERT ... ON DUPLICATE KEY UPDATE` | **0회** | 0 | 권장 |
| READ COMMITTED로 낮추기 | **0회** | 30회 | 조건부 |

**확인과 삽입을 한 문장으로 합치는 쪽**이 답입니다. 갭 락을 먼저 잡는 단계 자체가 없어지고, 중복 처리는 엔진이 유니크 키로 합니다. 30회 전부 성공했고 중복키 에러도 없었습니다.

**READ COMMITTED**도 이 시나리오의 데드락은 없앱니다. 다만 "갭 락이 아예 없어서"는 아닙니다. MySQL 문서는 갭 락이 꺼지는 범위를 이렇게 한정합니다.

> Gap locking can be disabled explicitly. This occurs if you change the transaction isolation level to READ COMMITTED. In this case, gap locking is disabled for searches and index scans and is used only for foreign-key constraint checking and duplicate-key checking.

꺼지는 것은 **탐색과 인덱스 스캔의 갭 락**이고, **외래키 제약 검사와 중복키 검사에는 READ COMMITTED에서도 갭 락을 씁니다.** 이 시나리오에서 데드락이 사라진 이유는 `SELECT ... FOR UPDATE`가 더 이상 갭을 잠그지 않게 됐기 때문이지, 서버에서 갭 락이 사라졌기 때문이 아닙니다. 외래키가 걸린 테이블에 INSERT하는 경로라면 READ COMMITTED에서도 갭 락을 만나게 됩니다.

결과도 다릅니다. 60시도 중 30건이 중복키 에러(1062)로 실패했습니다. 데드락이 중복키 에러로 바뀐 것이고, 애플리케이션이 그 에러를 잡아 재시도하거나 무시해야 합니다. 실패를 없앤 게 아니라 실패의 종류를 바꾼 것이라, 예외 처리를 함께 넣지 않으면 장애의 모양만 달라집니다.

격리 수준을 내리기 전에 확인할 것이 둘 더 있습니다.

**첫째, 바이너리 로그 형식입니다.** 문서는 "Only row-based binary logging is supported with the READ COMMITTED isolation level"이라고 못박습니다. `binlog_format=MIXED`면 서버가 알아서 행 기반으로 전환하지만, `STATEMENT`로 두면 "InnoDB can no longer perform inserts"라 곧 에러가 납니다. MySQL 8.4는 `binlog_format` 기본값이 `ROW`이고 이 변수 자체가 deprecated라 새로 세우는 환경에서는 걸릴 일이 적습니다. 문제는 8.0 이전부터 `STATEMENT`나 `MIXED`로 돌던 복제 구성입니다. 그런 곳에서는 격리 수준 한 줄을 내리는 것이 복제 형식 변경을 함께 요구합니다.

**둘째, UPDATE와 DELETE의 락 동작이 같이 바뀝니다.** READ COMMITTED에서는 실제로 고친 행의 락만 유지하고, 조건에 맞지 않은 행의 레코드 락은 WHERE 평가가 끝나는 대로 풀립니다. 그리고 이미 잠긴 행을 만나면 semi-consistent read로 최신 커밋 버전을 읽어 조건에 맞는지 먼저 판정하고, 맞을 때만 다시 읽어 잠그거나 락을 기다립니다. 문서는 이 조합을 두고 "This greatly reduces the probability of deadlocks, but they can still happen"이라고 적습니다. 데드락 확률을 크게 낮추지만 없애지는 못한다는 뜻입니다. 4절의 인덱스 없는 UPDATE가 정확히 이 효과가 걸리는 자리인데, 이 세션은 4절을 REPEATABLE READ에서만 돌렸으므로 READ COMMITTED에서 락 건수가 얼마나 줄어드는지는 재지 않았습니다.

## 4. 인덱스가 없으면 락 범위가 넓어진다

두 번째 시나리오로 인덱스 없는 컬럼의 UPDATE를 넣었습니다. `WHERE status='PENDING'`은 `status`에 인덱스가 없어서 InnoDB가 PRIMARY를 통째로 훑고, 훑은 행마다 락을 잡습니다.

두 번째 UPDATE 직전에 찍은 `data_locks` 스냅숏에는 락이 **204건** 있었습니다. 200행짜리 테이블에서 `status='PENDING'`인 행은 100행이고, 실행한 문장은 거기에 `live_id` 범위 조건까지 붙어 50행에 해당합니다. 204건의 내역은 이렇습니다.

- 한 트랜잭션이 쥔 레코드 락 201건. 200행 전부와 supremum 의사 레코드입니다.
- 다른 트랜잭션이 기다리는 레코드 락 1건. 대상이 `id=1` 행인데, 그 트랜잭션의 조건 범위(`live_id > 100`) 밖입니다. 자기가 고칠 행이 아닌데도 스캔이 그 행을 지나가느라 막힌 것입니다.
- 테이블 IX 락 2건.

REPEATABLE READ에서는 조건에 맞지 않은 행의 락도 트랜잭션이 끝날 때까지 남습니다. 3절에 적은 대로 READ COMMITTED로 내리면 이 락들은 WHERE 평가 직후에 풀리고 semi-consistent read가 함께 걸리지만, 이 시나리오를 READ COMMITTED에서 다시 재지는 않았습니다.

이 시나리오는 **한 번만 실행했습니다.** 30회 반복은 3절의 해소 검증에만 적용했고 이쪽은 반복 측정하지 않았습니다. 그리고 그 한 번의 실행에서는 **데드락이 나지 않았습니다.** 한 세션이 먼저 전 행을 잠그고 다른 세션이 그 앞에서 대기하는 것으로 끝났습니다. 결과 파일에서 이 구간 아래에도 데드락 그래프가 찍혀 있지만, 그것은 2절에 적은 성질 때문입니다. `SHOW ENGINE INNODB STATUS`가 새 데드락이 날 때까지 마지막 한 건을 계속 보여주므로 시나리오 1의 트랜잭션(2658과 2659)이 그대로 다시 출력된 것입니다. 트랜잭션 번호와 타임스탬프가 위 블록과 같은 것이 그 증거입니다.

그래서 이 절이 실제로 보인 것은 넓어진 락 범위와 그로 인한 대기까지입니다. 인덱스를 거는 것이 조회 성능만의 문제가 아니라 **락 범위를 좁혀 충돌 면적을 줄이는 일**이기도 하다는 것은 204건이라는 숫자가 그대로 보여줍니다. 다만 인덱스 유무에 따라 데드락 발생률이 실제로 얼마나 달라지는지는 재지 않았습니다. 이 관점은 A22(인덱스가 있는데 못 쓰는 경우)와 짝이 됩니다.

## 5. 다른 선택지 넷과 그 대가

3절의 표에는 없던 넷을 같은 조건으로 각각 30회(시도 60건) 돌렸습니다. 두 요청이 각각 1000을 넣으려 하므로 **의도한 최종금액은 2000**입니다. 그 열이 이 표의 요점입니다.

![다른 선택지 넷](/uploads/incident/gap-lock-deadlock/fig-alt.png)

| 방법 | 데드락 | 다른 에러 | 성공 | 총 실행 | 소요 | **최종금액** |
|---|---|---|---|---|---|---|
| 원래 방식 (기준선) | 30회 | 0 | | 60 | | |
| `SELECT ... FOR UPDATE SKIP LOCKED` | **30회** | 0 | 30/60 | 60 | 7.3초 | 1000 |
| `SELECT ... FOR UPDATE NOWAIT` | 5회 | 3572 25건 | 30/60 | 60 | 7.3초 | 1000 |
| `INSERT IGNORE` | 1회 | 0 | 59/60 | 60 | **1.0초** | 1000 |
| 원래 방식 + 재시도 | 30회 | 0 | **60/60** | 90 | 16.5초 | **2000** |

### `SKIP LOCKED`는 갭 락에 통하지 않습니다

데드락 30회로 기준선과 같습니다. `SKIP LOCKED`가 건너뛰는 것은 **잠긴 행**이고, 이 시나리오에는 대상 행이 없어서 건너뛸 것이 없습니다. 갭 락은 그대로 잡히고 삽입 의도 락도 그대로 충돌합니다.

락 힌트 두 개를 함께 소개하는 글이 많지만 이 조건에서는 하나만 듣습니다. `SKIP LOCKED`가 쓸모 있는 자리는 큐 소비 패턴처럼 **잠긴 행을 건너뛰고 다음 행으로 가는 것이 의미가 있을 때**입니다.

### `NOWAIT`은 에러의 종류를 바꿉니다

데드락이 30회에서 5회로 줄었습니다. 대기를 하지 않으니 순환 대기가 성립할 창이 좁아지기 때문입니다. 대신 3572(`Statement aborted because lock(s) could not be acquired immediately and NOWAIT is set`)가 25건 나옵니다.

**실패가 사라진 것이 아니라 빨라진 것입니다.** 데드락은 InnoDB가 탐지하기까지 기다려야 하고 `NOWAIT`은 즉시 돌아옵니다. 애플리케이션이 재시도를 하고 있다면 그 차이가 지연으로 나타나지만, 재시도가 없으면 최종금액은 여전히 1000입니다.

### `INSERT IGNORE`가 가장 위험합니다

가장 빠르고(1.0초, 기준선의 7분의 1) 데드락도 거의 없고 성공률도 59/60입니다. 그런데 **최종금액이 1000입니다.**

`INSERT IGNORE`는 중복키를 만나면 그 행을 넣지 않고 경고만 남깁니다. 에러가 아니라 성공으로 끝납니다. 두 번째 요청의 1000원이 아무 신호 없이 사라집니다. 정산이나 후원 집계에서 이것은 데드락보다 나쁩니다. **데드락은 시끄럽게 실패하고 `INSERT IGNORE`는 조용히 틀립니다.**

3절이 `ON DUPLICATE KEY UPDATE`를 권한 이유가 여기서 분명해집니다. 두 문법 모두 갭 락 단계를 없애지만, 한쪽은 금액을 더하고 한쪽은 버립니다.

### 재시도만 최종금액을 맞춥니다

데드락은 30회 그대로 납니다. 그런데 최종 성공이 60/60이고 금액이 2000입니다. 잡아서 다시 돌면 두 번째 시도의 `SELECT`가 상대가 넣은 행을 보고 `UPDATE` 분기로 가기 때문입니다.

대가는 총 실행 90회입니다. 60건을 처리하는 데 트랜잭션 90개를 던졌으니 1.5배입니다. 소요도 16.5초로 기준선의 두 배가 넘습니다.

**여기서 한 가지를 분명히 해야 합니다.** 재시도가 수렴하려면 재시도하는 코드가 "있으면 더한다" 분기를 실제로 갖고 있어야 합니다. 처음 이 실험을 짤 때 `SELECT` 결과를 보지 않고 `INSERT`만 다시 던지도록 두었더니, 재시도가 데드락을 중복키로 바꾸기만 하고 최종 성공은 30/60에 머물렀습니다. **재시도는 멱등한 로직 위에서만 안전망이 됩니다.**

### 반복 측정 4회

조건마다 30회(시도 60건)를 4회 반복했습니다.

| 방법 | 성공(4회) | 총 실행(4회) | 소요(4회) | 최종금액(4회) |
|---|---|---|---|---|
| `NOWAIT` | 30, 30, 30, 30 | 60, 60, 60, 60 | 7.3, 7.3, 7.3, 7.3초 | 1000 × 4 |
| `SKIP LOCKED` | 30, 30, 30, 30 | 60, 60, 60, 60 | 7.3, 7.3, 7.4, 7.4초 | 1000 × 4 |
| 재시도 | 60, 60, 60, 60 | 90, 90, 90, 90 | 16.5, 16.6, 16.6, 16.6초 | **2000 × 4** |
| `INSERT IGNORE` | 59, 60, 60, 59 | 60, 60, 60, 60 | 1.0, 1.1, 1.1, 1.2초 | 1000 × 4 |

**최종금액이 네 회차 모두 같습니다.** 재시도만 2000이고 나머지 셋은 1000입니다. 이 절의 결론은 회차 편차로 뒤집히지 않습니다.

흔들린 것은 `INSERT IGNORE`의 성공 건수뿐입니다(59, 60, 60, 59). 데드락이 두 회차에서 1건씩 났고 그 요청이 실패로 끝났습니다. 그런데 **실패하든 성공하든 최종금액은 1000입니다.** 성공률로 이 방법을 고르면 안 되는 이유가 그것입니다.

### 정리하면

| 원하는 것 | 고를 것 |
|---|---|
| 데드락 없이 금액 정확 | `ON DUPLICATE KEY UPDATE` (3절) |
| 기존 코드를 유지하며 금액 정확 | 재시도. 단 로직이 멱등해야 함 |
| 대기 없이 즉시 실패 통보 | `NOWAIT`. 재시도와 함께 써야 의미가 있음 |
| 잠긴 행을 건너뛰고 진행 | `SKIP LOCKED`. 이 시나리오에는 해당 없음 |
| 쓰지 말 것 | `INSERT IGNORE` (금액을 조용히 잃음) |

## 6. 예상과 달랐던 점

### 격리 수준 변경이 조용히 안 먹었습니다

READ COMMITTED 해소를 검증하는데 데드락이 30회 그대로 나왔습니다. 원인은 `BEGIN` **뒤에** `SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED`를 둔 것이었습니다.

```
BEGIN;
SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED;
SELECT @@transaction_isolation;   →  READ-COMMITTED
```

**변수는 바뀐 값을 보여주는데 실행 중인 트랜잭션은 그대로 REPEATABLE READ로 돕니다.** 세션 설정은 다음 트랜잭션부터 적용되기 때문입니다. 변수를 찍어 확인했는데도 안 먹는 상황이라, 이걸 모르면 "READ COMMITTED로 바꿨는데 갭 락이 그대로다"라는 결론에 도달합니다. `BEGIN` 앞으로 옮기자 데드락이 0회가 됐습니다.

### 행이 있으면 다른 데드락이 됩니다

시나리오를 두 번째 실행할 때 락 모드가 `X,GAP`이 아니라 `X,REC_NOT_GAP`으로 나왔습니다. 첫 실행에서 만든 행이 남아 있어 `SELECT FOR UPDATE`가 갭이 아닌 레코드를 잠근 것입니다. 여전히 데드락은 나지만 **메커니즘이 다릅니다.** 갭 락 데드락을 재현하려면 대상 행이 없는 상태에서 시작해야 하고, 그래서 매 실행 전 초기화를 넣었습니다.

같은 증상(1213 Deadlock found)이라도 원인이 갭 락인지 레코드 락인지에 따라 해법이 달라지므로, `data_locks`의 `LOCK_MODE`를 보지 않고 증상만으로 진단하면 안 됩니다.

## 7. 1213을 넘어서

네 가지를 이어서 쟀습니다. 실행 스크립트와 출력 원문은 저장소의 A06 세션에 있습니다.

### 획득 순서 엇갈림은 격리 수준을 내려도 남습니다

| 격리 수준 | 데드락 | 에러 |
|---|---|---|
| REPEATABLE READ | 30/30회 | 1213 30건 |
| READ COMMITTED | 30/30회 | 1213 30건 |

갭 락 데드락은 READ COMMITTED로 내리면 사라집니다. 3절에 적은 대로 `SELECT ... FOR UPDATE`가 더 이상 갭을 잠그지 않기 때문입니다. 순서 엇갈림은 30회 전부 그대로 납니다. **이미 있는 행의 잠금 순서 문제라 갭과 무관합니다.** 에러 번호가 1213으로 같아서 로그만 보면 구분이 안 됩니다. 격리 수준을 내려 보고 없어지는지로 갈립니다.

### 인덱스가 락 수를 줄인다는 말은 격리 수준에 달렸습니다

| 조건 | 락 수(3회) | 중앙값 |
|---|---|---|
| REPEATABLE READ / 인덱스 없음 | 1007, 1007, 1007 | **1007** |
| REPEATABLE READ / 인덱스 있음 | 22, 22, 22 | **22** |
| READ COMMITTED / 인덱스 없음 | 11, 11, 11 | **11** |
| READ COMMITTED / 인덱스 있음 | 21, 21, 21 | 21 |

REPEATABLE READ에서는 인덱스가 1007 개를 22 개로 줄입니다. 46배입니다.

**READ COMMITTED에서는 인덱스가 락 수를 오히려 늘립니다.** 11 개에서 21 개가 됩니다.
READ COMMITTED는 조건에 안 맞는 행의 잠금을 문장이 끝날 때 놓아 줍니다. 그래서 인덱스가 없어도 남는 락이 대상 행뿐입니다. 인덱스를 붙이면 거기에 인덱스 레코드 락이 더해집니다. **인덱스가 줄이는 것은 훑는 양이고, 남는 락 수는 격리 수준이 정합니다.**

4절의 204건은 1회 스냅숏이었고, 위는 3회 전부 같은 값입니다.

### 백오프 방식은 이 시나리오에서 처리량을 바꾸지 않습니다

| 백오프 | 최대 시도 | 성공 | 총 시도 | 소요 | 최종 금액 |
|---|---|---|---|---|---|
| 없음 | 4 | 60/60 | 61 | 13.7초 | 60,000 |
| 없음 | 8 | 60/60 | 61 | 13.6초 | 60,000 |
| 선형 | 4 | 60/60 | 61 | 13.8초 | 60,000 |
| 선형 | 8 | 60/60 | 61 | 13.6초 | 60,000 |
| 지수 | 4 | 60/60 | 61 | 13.6초 | 60,000 |
| 지수 | 8 | 60/60 | 61 | 13.6초 | 60,000 |
| 지수+지터 | 4 | 60/60 | 61 | 13.5초 | 60,000 |
| 지수+지터 | 8 | 60/60 | 61 | 13.4초 | 60,000 |

여덟 조건이 13.4~13.8초 안에 있습니다. 차이는 3%이고 최종 금액도 전부 60,000원입니다.

**총 시도가 61 인 것이 이유입니다.** 60건을 처리하는 동안 데드락이 한 번 났습니다.
재시도가 한 번이면 백오프 방식이 개입할 자리가 없습니다. 백오프는 재시도가 잦고 그 재시도가 서로 다시 부딪칠 때 의미가 생깁니다. 두 세션이 번갈아 도는 이 부하는 그 조건이 아닙니다. **백오프를 고르는 것보다 부딪치는 횟수를 줄이는 쪽이 먼저입니다.**

### SKIP LOCKED가 통하는 자리

| 방식 | 처리 | 소요 | 초당 | 워커별 분배 |
|---|---|---|---|---|
| plain | 200/200 | 1.1초 | 185.7 | 53, 45, 51, 51 (에러 1213 34건) |
| skiplocked | 200/200 | 0.9초 | **224.4** | 51, 50, 49, 50 |
| nowait | 200/200 | 2.7초 | 75.2 | 101, 2, 97, 0 (에러 3572 171건) |

5절에서는 `SKIP LOCKED`가 이 시나리오에 안 통한다고 적었습니다. 거기서는 두 세션이 **같은 한 행**을 원했고, 아직 없는 행이라 건너뛸 것 자체가 없었습니다.

큐는 반대입니다. 일감이 200개 있고 누가 어느 것을 가져가든 상관없습니다. 건너뛴 일감은 다음 워커가 가져갑니다. 셋 다 200건을 다 처리했고 `SKIP LOCKED`가 제일 빠릅니다. 분배도 51/50/49/50으로 고릅니다.

`NOWAIT`은 처리량이 3분의 1이고 분배가 101/2/97/0입니다. 잠긴 것을 만나면 건너뛰지 않고 에러를 내므로, 총 3,572회 시도 중 171회가 에러입니다. **워커 하나는 한 건도 못 가져갔습니다.** 재시도 경합에서 진 워커가 계속 집니다.

**결론이 5절과 갈리는 이유는 도구가 달라서가 아니라 목표가 달라서입니다.**
"같은 한 행이 목표인가"가 갈리는 자리입니다.

## 현업은 어떻게 해소했는가

이 유형을 겪고 공개한 사례가 있습니다. KINTO Technologies가 2024년 Aurora MySQL 3 결제 플랫폼에서 만난 건입니다. **그들이 고른 해소가 이 글의 1순위 처방과 다릅니다.**

> "Through our investigation, we identified that the `SELECT FROM ... FOR UPDATE` query, which was used to check for duplicate payments, was causing the deadlock. To resolve this, we decided to **discontinue this query and revised the design**. Now, the data is temporarily registered when a request is received, and **the transaction is committed immediately**."

`INSERT ... ON DUPLICATE KEY UPDATE`도 아니고 `READ COMMITTED`도 아니고 재시도도 아닙니다. **확인용 잠금 조회를 없애고 트랜잭션을 둘로 쪼갰습니다.**

왜 그랬는지가 데드락 출력에 있습니다. `ACTIVE 6 sec inserting`, `ACTIVE 7 sec inserting`. **결제 대행사 호출이 트랜잭션 안에 있어서 그 왕복 내내 갭 락을 쥐고 있었습니다.** 이 세션의 재현에는 외부 호출이 없어 밀리초 안에 끝나고, 그래서 "왜 그렇게 오래 잡고 있었나"라는 질문 자체가 안 생깁니다. **트랜잭션 안에 외부 호출이 있는가가 이 유형의 실제 위험을 정하는 조건입니다.**

**그들이 스스로 적은 반성이 가장 이식성 높은 교훈입니다.**

> "In our load testing, we used random values (UUIDs) for the `request_id`, primarily to avoid performance degradation from index fragmentation and rebuilding. As a result, **no deadlock occurred during the tests**, and they completed successfully."

부하 시험의 키 분포가 운영과 달라서 데드락이 시험을 통과했습니다. 운영의 `request_id`는 `상품ID-YYYYMMDD-일련번호` 라 연속값이 동시에 들어왔고, 시험은 UUID 라 갭이 안 겹쳤습니다. **이 세션은 인덱스 유무를 축으로 잡았는데 실제 사건에서 결정적이었던 축은 키 분포였습니다.**

### 벤더 권고와 이 글이 갈리는 자리

MySQL 공식 문서의 1순위는 재시도입니다. "Always be prepared to re-issue a transaction if it fails due to deadlock. Deadlocks are not dangerous. Just try again." 이 세션이 5절에서 재시도만 최종 금액을 맞춘다고 잰 것과 같은 방향입니다.

**그런데 `INSERT ... ON DUPLICATE KEY UPDATE`에 대해서는 AWS가 Aurora에서 반대 방향을 권합니다.** MySQL 5.7.26 이상과 Aurora MySQL 2.10.3 이상에 들어간 Bug #98324 수정 때문입니다. 유니크 보조 인덱스나 외래키 제약 위반이 잦은 워크로드에서 upsert의 내부 부분 롤백이 추가 락을 만듭니다.

> "Instead of using `INSERT...ON DUPLICATE KEY UPDATE`, rewrite the SQL statement as a multistatement transaction such as the following: `BEGIN; SELECT {{rows that conflict on secondary indexes}}; UPDATE {{conflicting rows}}; INSERT {{new rows}}; COMMIT;`"

같은 문서가 `REPLACE INTO`와 `INSERT IGNORE`도 같은 범주로 묶습니다.

**그러니 이 글이 30회 무결로 검증한 것은 로컬 MySQL 8.4.3 기준입니다.** 유니크 보조 인덱스 충돌이 잦은 워크로드를 Aurora에서 돌린다면 같은 결과가 나오는지 따로 확인해야 합니다. 이 세션은 그 조건을 만들지 않았습니다.

갭 락 자체에 대해서는 AWS도 이 글과 같은 방향입니다. "If you encounter gap locking, you can modify the transaction isolation level to `READ COMMITTED` for the session or transaction to prevent it."

그리고 재시도에 대해 이렇게 못 박습니다. "**deadlocks are an expected database behavior and can still occur.** Applications should have the necessary logic to handle deadlocks when they are encountered."


### 그래서 키 분포를 직접 재 봤습니다

KINTO의 반성이 이 세션에 없던 축을 가리켰으니 그것만 따로 만들었습니다. 같은 코드에 **키만 바꿔** 돌립니다. 트랜잭션 안에 0.25초짜리 외부 호출 구간을 두었습니다. 실제 데드락 출력의 `ACTIVE 6 sec inserting`이 그 왕복이었고, 그 구간이 없으면 갭 락을 쥐는 시간이 밀리초라 같은 코드로도 데드락이 잘 안 납니다.

동시 8, 각 25회차, 총 200 트랜잭션입니다.

| 테이블 | 키 | 데드락 | 들어간 행 | 데드락률 |
|---|---|---|---|---|
| 비었음 | 순차 | 175 / 200 | 25 / 200 | 87.5% |
| 비었음 | UUID | 49 / 200 | 151 / 200 | 24.5% |
| 20만 행 | 순차 | 175 / 200 | 25 / 200 | 87.5% |
| 20만 행 | UUID | 41 / 200 | 159 / 200 | 20.5% |

**키 분포만으로 87.5%와 22%가 갈립니다.** 순차 키에서는 여덟 중 일곱이 죽고 하나만 들어갑니다. 여덟이 전부 같은 갭에 삽입 의도 락을 걸어 서로 막기 때문입니다.

**부하 시험이 왜 통과했는지가 이 표에 그대로 있습니다.** UUID로 시험하면 같은 코드가 5분의 1 확률로만 데드락을 냅니다. 회차를 조금 돌려 보고 넘어가면 안 보입니다.

세우고 나서 틀린 가설도 하나 있습니다. **테이블을 20만 행으로 채우면 갭이 잘게 쪼개져 데드락이 줄 것이라고 봤는데, 순차 키에서는 87.5%로 똑같았습니다.** 순차 키는 값이 인덱스의 한 구간에 몰려서, 앞에 행이 몇 개 있든 동시에 들어오는 여덟 개가 같은 갭을 고릅니다. 갭의 개수가 아니라 **키가 어디에 떨어지는가**가 정합니다.

계측에서 두 번 미끄러진 자국도 남겨 둡니다. 처음에는 에러 로그를 grep해 데드락을 셌는데 0이 나왔습니다. 실제로는 215건이 났고 패턴이 안 맞았을 뿐입니다. 다음에는 동시 실행을 컨테이너 안으로 옮기면서 `mysql`의 stderr를 버렸고, 그러자 전 조건이 "데드락 0건, 성공 200건"으로 나왔습니다. **두 번 다 0이 안 났다는 뜻인지 못 셌다는 뜻인지 구분이 안 되는 계측이었습니다.** 지금은 트랜잭션마다 결과를 한 줄씩 남기고 성공과 데드락의 합이 시도 수와 같은지 확인합니다.

## 못 한 것

- **7절의 네 조건은 30라운드 1회 실행입니다.** 락 수만 3회 반복했습니다.
- **분산 환경은 다루지 않았습니다.** 단일 인스턴스 두 세션입니다.

---

재현에 쓴 compose 파일과 실행 출력 원문은 [incident-lab 저장소의 A06 세션](https://github.com/dj258255/incident-lab/tree/main/sessions/A06-gap-lock-deadlock)에 있습니다.

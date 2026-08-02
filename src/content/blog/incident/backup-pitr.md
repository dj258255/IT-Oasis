---
title: '백업은 있는데 복구가 안 된다, PITR을 가로막는 다섯 가지'
titleEn: "You Have Backups, You Just Cannot Restore: Five Things That Block PITR"
description: "GitLab 2017년 사고는 백업 다섯 겹이 전부 안 들었고 WAL 아카이빙조차 없어 시점 복구를 할 재료가 없었습니다. MySQL·PostgreSQL·SQL Server·Oracle 네 엔진에서 PITR을 직접 재현하고, 네 엔진 모두 벽시계로 지점을 가리키면 경계에서 샌다는 것을 실측했습니다."
descriptionEn: "In January 2017 GitLab discovered that all five of its backup and replication mechanisms were broken only after an engineer wiped the primary PostgreSQL data directory. The incident itself involved roughly 300GB of PostgreSQL data and cannot be reproduced as such, so this session reproduces only the same mechanism at reduced scale on MySQL 8.4.3 with a 1,500-row table. Restoring a mysqldump full backup (40K) and replaying the binary log (192K) up to the moment just before a DROP TABLE recovers everything: the backup alone brings back 1,000 rows and loses 500, while replaying up to position 176549 brings all 1,500 rows back. The five obstacles split into three genuine database traps and two artifacts of running the lab in containers. Scaling up to 4 million rows (a 525MB dump) shows total recovery time growing from 0.54s to 21.5s while the restore verdict stays identical at every scale, which is why absolute timings from this lab cannot be quoted but verdicts and boundary rules can. Three of them raise no error at all: a replay that is silently skipped, an expired binlog that closes the PITR window, and a missing -i on docker exec that never delivers standard input."
date: 2026-03-09
tags:
  - MySQL
  - Backup
  - PITR
  - GTID
  - RPO
  - Replication
  - PostgreSQL
  - Docker
category: incident/DbOps
series: '데이터베이스가 무너지는 지점'
seriesOrder: 7
coverImage: /uploads/incident/backup-pitr/fig-pitr.png
---

> 근거 등급: `E1·축소`
> 출처: [GitLab.com Database Incident (2017-01-31)](https://about.gitlab.com/blog/2017/02/01/gitlab-dot-com-database-incident/) · [Postmortem](https://about.gitlab.com/blog/2017/02/10/postmortem-of-database-outage-of-january-31/) · [MySQL 8.4, PITR Using Event Positions](https://dev.mysql.com/doc/refman/8.4/en/point-in-time-recovery-positions.html) · [GTID Concepts](https://dev.mysql.com/doc/refman/8.4/en/replication-gtids-concepts.html) · [Google SRE Book, Data Integrity](https://sre.google/sre-book/data-integrity/) · [AWS, Restoring a DB instance to a specified time](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_PIT.html) · [AWS Well-Architected REL09-BP04](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/rel_backing_up_data_periodic_recovery_testing_data.html) · [GitLab Handbook, Database Backups](https://handbook.gitlab.com/handbook/engineering/infrastructure/database/)

## 1. 유명한 이유

2017년 1월 31일(UTC), GitLab 엔지니어가 복제가 밀린 상황을 수습하다 secondary인 줄 알고 primary의 PostgreSQL 데이터 디렉터리를 지웠습니다. 약 300GB가 사라졌습니다. 진짜 사건은 그다음입니다. 당시 라이브 문서에 이렇게 적혀 있습니다.

> "out of five backup/replication techniques deployed none are working reliably or set up in the first place."

**"다섯"은 사고 당일 라이브 문서의 표현입니다.** 열흘 뒤 사후 분석이 열거한 상시 절차는 넷입니다. 넷을 적고 다섯 번째로 세어졌던 것은 그 아래에 접어 둡니다.

| 수단 | 실패 이유 |
|---|---|
| `pg_dump` → S3 | 일반 애플리케이션 서버에서 돌았고 그 서버에 PostgreSQL 데이터 디렉터리가 없어 Omnibus가 9.2로 폴백. 9.6 서버를 덤프하려다 실패해 S3 버킷이 비어 있었음. **실패 알림은 발송됐으나 DMARC 미설정으로 수신 측에서 거부돼 몇 달간 아무에게도 도달하지 않음** |
| Azure 디스크 스냅샷 | NFS 서버에만 설정, DB 서버에는 미설정 |
| LVM 스냅샷 | 24시간 주기이고 재해 복구용이 아님 |
| PostgreSQL 복제 | primary가 WAL 세그먼트를 secondary가 받기 전에 지워 중단 |

**그리고 이 글의 주제에 직접 걸리는 것이 하나 더 있습니다.**

> "As GitLab.com was **not using WAL archiving**, the secondary had to be re-synchronised manually."

**GitLab.com은 WAL 아카이빙을 쓰지 않았습니다.** 곧 이 글이 다루는 시점 복구를 할 재료가 애초에 없었습니다. 백업 다섯 겹이 전부 안 들었다는 이야기의 앞에, 그 다섯 겹 중 어느 것도 "사고 직전 시점으로 되돌린다"를 할 수 없는 종류였다는 사실이 있습니다. 남은 선택지가 6시간 전 스냅숏이었던 이유입니다.

사후 분석의 개선 항목 목록에 그래서 이것이 들어갑니다.

> "**Investigate Point in time recovery & continuous archiving for PostgreSQL** (#1097)"

**사고가 난 뒤에야 PITR 도입을 검토 항목으로 올렸습니다.** 이 글이 MySQL로 축소 재현하는 것이 바로 그들이 그때 갖고 있지 않던 능력입니다.

결과는 약 6시간 유실(프로젝트 5,000개, 댓글 5,000개, 계정 700개)과 18시간 다운타임입니다.

핵심은 "복구에 실패했다"가 아니라 **"백업이 있다고 믿고 있었다"**입니다. Google SRE Book이 같은 말을 다르게 적습니다.

> "No one really wants to make backups; what people really want are restores."

AWS Well-Architected의 REL09-BP04 안티패턴 목록은 GitLab 사고를 그대로 문장화한 수준입니다. "백업이 존재한다고 가정하는 것", "복원해 보되 데이터를 조회하거나 꺼내 보지 않는 것", "복원 시간이 RTO 안에 들어간다고 가정하는 것".

### 그들을 살린 것은 백업 정책이 아니었습니다

라이브 문서에 이 문장이 있습니다.

> "LVM 스냅샷은 기본적으로 24시간에 한 번만 생성됩니다. 팀원 1은 데이터베이스 로드 밸런싱 작업을 하고 있었기 때문에 장애 발생 약 6시간 전에 **수동으로** 스냅샷을 실행했습니다."

**복구에 쓴 것이 그 수동 스냅숏입니다.** 백업 정책이 만든 것이 아니라, 다른 일을 하던 엔지니어가 우연히 여섯 시간 전에 손으로 찍어 둔 것입니다. 그것이 없었으면 유실은 6시간이 아니라 24시간이었습니다.

300GB 중 **4.5GB만 남았습니다.** 삭제를 멈춘 것이 오후 11시 27분(UTC)인데 그때는 이미 늦었습니다.

그리고 같은 문서에 이 글의 주제와 정확히 겹치는 한 줄이 더 있습니다.

> "`pg_basebackup`은 마스터 서버가 복제 과정을 시작할 때까지 **조용히 기다립니다.** 다른 운영 엔지니어에 따르면 이 과정은 최대 10분까지 걸릴 수 있습니다. 이로 인해 프로세스가 어떤 이유로든 멈춘 것으로 오해할 수 있습니다."

**멈춘 것과 기다리는 것이 화면에서 같아 보입니다.** 이 오해가 그날 밤의 판단으로 이어졌습니다. 도구가 진행 상황을 안 알려 주면 사람이 추측하고, 새벽에 지친 사람의 추측은 틀립니다.

한 가지 밝혀 둘 것이 있습니다. 사고 당일 라이브 문서는 `pg_dump` 실패를 "오류 메시지 없이 실패한다"고 적었고, 열흘 뒤 사후 분석은 **에러는 났고 그 알림 메일이 DMARC로 반려됐다**고 풀어 씁니다. **뒤집은 것이 아니라 구체화한 것입니다.** 사후 분석의 5 Whys도 백업 절차가 조용히 실패했다(failed silently)는 표현을 그대로 쓰고, 그다음 why에서 알림이 왜 안 닿았는지를 설명합니다. 곧 운영자 입장에서는 조용한 실패가 맞고, 그 조용함의 정체가 반려된 메일이었습니다. 이 글은 뒤쪽 서술을 따릅니다.

사건 자체는 PostgreSQL 300GB 규모라 그대로 재현할 수 없습니다. 이 세션은 엔진도 규모도 다른 MySQL에서 1,500행짜리 테이블로 같은 메커니즘만 축소 재현했습니다. 시점 복구(PITR)를 실제로 수행하고, 복구를 가로막는 것들을 다룹니다. 데이터베이스 쪽 함정 셋과, 이 랩이 컨테이너로 축소해서 생긴 아티팩트 둘로 갈라 적었습니다. **다섯 중 셋은 재현이든 사고든 이 세션을 만들면서 제가 실제로 밟았습니다.** 규모가 작다는 것이 이 세션의 가장 큰 약점이라, 4절 끝에 400만 행까지 올린 곡선을 붙여 무엇이 규모를 타고 무엇이 안 타는지 갈랐습니다.

## 2. 재현

### 환경

| 항목 | 값 |
|---|---|
| 원본 | MySQL 8.4.3, `log-bin`, `gtid-mode=ON`, `sync_binlog=1`, `innodb_flush_log_at_trx_commit=1` |
| 복구 대상 | MySQL 8.4.3 별도 인스턴스 (사고 서버에 되돌리지 않는다) |
| 도구 | percona-server:8.4 컨테이너 (`mysqlbinlog` 확보용, 아티팩트 1 참고) |
| 데이터 규모 | 사고 직전 1,500행(T0 백업 시점 1,000행 + 그 뒤 500행). 덤프 40K, 이어 붙인 binlog 192K |
| 컨테이너 자원 한도 | 걸지 않았습니다. compose에 `cpus`도 `mem_limit`도 없습니다 |
| 호스트 사양 | 2026-07-31 재측정 회차는 macOS 26.3.1, Apple M2 Pro 12코어, 32GB에서 돌았고 컨테이너 런타임 VM은 12코어 7.7GB입니다(`results/00-host.txt`). 그 이전 회차의 호스트는 기록이 없어 확인되지 않습니다. 초기 회차의 단서는 덤프 헤더와 도구 컨테이너 버전 문자열의 `aarch64`뿐입니다 |
| 측정 횟수 | 1회. 반복 측정을 하지 않아 분산은 모릅니다 |

이 저장소는 세션마다 장비가 달라서, 아래 소요 시간을 다른 세션의 절대값과 비교하면 안 됩니다. 이 글 안에서 세 구간의 비율을 보는 데까지만 쓸 수 있는 수치입니다.

### 타임라인

```
T0     풀백업 (mysqldump --single-transaction --source-data=2)
T0~T1  후원 500건이 더 들어온다 (백업에 없는 데이터)
T1     운영자가 실수로 DROP TABLE sponsor
T1~    사고를 모른 채 다른 테이블에 쓰기가 계속된다
```

## 3. 결과: PITR은 실제로 듣는다

![PITR 전후](/uploads/incident/backup-pitr/fig-pitr.png)

| 복구 방법 | 복구된 행 | 유실 |
|---|---|---|
| 백업만 복원 | 1,000건 | **500건** |
| 백업 + binlog를 사고 직전까지 | **1,500건** | **0건** |

사고 직전의 정답은 1,500건입니다. T0 백업 시점에 1,000행이었고 그 뒤 500건이 더 들어왔습니다. 백업만 되돌리면 그 500건이 통째로 사라집니다. **백업 주기가 곧 RPO 상한**이라는 말이 이 500건입니다. [Keepthescore](https://keepthescore.com/blog/posts/deleted_a_production_database/)가 2020년에 겪은 것이 정확히 이 구조로, 일 1회 백업 덕에 30분 만에 복구했지만 7시간치는 영원히 사라졌습니다.

binlog에서 사고 직전 위치를 찾아 그 구간만 적용하면 유실이 0이 됩니다. 위치는 공식 문서가 안내하는 방식 그대로 찾습니다.

```console
$ mysqlbinlog --base64-output=DECODE-ROWS -v /dump/incident.binlog > binlog-decoded.txt
$ grep -B3 -m1 -A1 "DROP TABLE" binlog-decoded.txt
#260729  6:14:56 server id 1  end_log_pos 176683 CRC32 0xdb7be403 	Query	thread_id=329	exec_time=0	error_code=0	Xid = 3605
SET TIMESTAMP=1785305696/*!*/;
SET @@session.pseudo_thread_id=329/*!*/;
DROP TABLE `sponsor` /* generated by server */
/*!*/;
```

이 이벤트 바로 앞줄이 `# at 176549`이고, 스크립트는 그 값을 뽑아 `DROP TABLE 이벤트 시작 위치 176549`로 기록했습니다. `--stop-position=176549`로 그 직전까지만 적용합니다.

**RTO 분해**: 이 실행에서 백업 0.075초, 덤프 복원 0.078초, binlog 추출·적용 0.947초입니다. 로그 원문은 각각 `.075473000` / `.077972000` / `.947246000`초입니다. 대상은 1,500행짜리 테이블 하나이고 덤프가 40K, 이어 붙인 binlog가 192K입니다. 이 규모에서는 복구 시간의 대부분이 binlog 구간을 뽑아 재적용하는 데 들어갔습니다. 백업 주기를 늘리면 그만큼 이어 붙일 binlog가 늘어나므로 RPO와 RTO는 백업 주기 하나로 맞물립니다. **다만 이 비율은 규모가 커지면 뒤집힙니다.** 4절 끝의 규모 곡선에서 400만 행을 재면 복원이 79.3%, binlog 적용이 10.5%로 갈립니다. 이 절의 "대부분이 binlog"는 1,500행이라는 규모에서만 성립합니다. 세 구간 모두 1회 실행값이라 분산도 모릅니다.

## 4. 복구를 가로막는 것들

다섯 가지를 만났는데 성격이 둘로 갈립니다. **셋은 어느 환경에서든 나오는 데이터베이스 쪽 함정이고, 둘은 이 랩이 컨테이너로 축소했기 때문에 나온 것입니다.** 처음에는 다섯을 한 줄로 세워 적었는데, 그러면 진짜 셋이 나머지 둘에 희석됩니다. 갈라서 적습니다.

### 데이터베이스 쪽 함정 셋

![데이터베이스 쪽 함정 셋](/uploads/incident/backup-pitr/fig-blocked.png)

### 함정 1. 사고 난 서버에 덤프를 되돌리면 첫 줄에서 막힌다

```console
$ grep -m1 "GTID_PURGED" results/dump/full.sql
SET @@GLOBAL.GTID_PURGED=/*!80000 '+'*/ '2695cd5d-8b13-11f1-bd5c-0242ac190002:1-5';

$ docker exec -i a23-mysql mysql -uroot -plab < full.sql     # 원본 서버에 복원 시도
ERROR 3546 (HY000) at line 24: @@GLOBAL.GTID_PURGED cannot be changed: the added gtid set must not overlap with @@GLOBAL.GTID_EXECUTED
```

`mysqldump`가 GTID 환경에서 기본으로 넣는 `SET @@GLOBAL.GTID_PURGED`가 이미 실행된 GTID와 겹쳐 복원 전체가 중단됩니다. 사고 복구는 대개 원본 서버에서 하려고 하므로, PITR 문서만 읽고 따라가면 여기서 막힙니다. 해법은 새 인스턴스에 복원하거나(권장) `--set-gtid-purged=OFF`로 다시 뜨는 것입니다.

### 함정 2. 재적용이 조용히 스킵된다

![조용한 스킵](/uploads/incident/backup-pitr/fig-silent-skip.png)

방금 적용한 binlog를 한 번 더 적용해 봤습니다.

```console
재적용 전 행 수 1500
재적용 전 gtid_executed 00f60e36-8b14-11f1-8c76-0242ac190003:1,\n2695cd5d-8b13-11f1-bd5c-0242ac190002:1-505

$ mysql < recover.sql        # 방금 적용한 것과 똑같은 파일을 한 번 더
종료 코드 0 (0이면 성공)
재적용 후 행 수 1500  → 늘어난 행 0 건
재적용 후 gtid_executed 00f60e36-8b14-11f1-8c76-0242ac190003:1,\n2695cd5d-8b13-11f1-bd5c-0242ac190002:1-505
GTID 차집합(새로 실행된 트랜잭션) ''
```

`stderr`에 남은 것은 비밀번호를 명령줄에 썼다는 경고 한 줄뿐이고(`results/reapply.err`), 그 줄을 걸러 내면 아무것도 없습니다. **명령은 성공하고 에러도 없는데 데이터는 한 건도 들어가지 않습니다.** 공식 문서가 그대로 적어 둔 동작입니다.

> "any attempt to execute a subsequent transaction with the same GTID is ignored by that server. **No error is raised, and no statement in the transaction is executed.**"

운영자가 "복구했다"고 판단하기 딱 좋은 조건입니다. 복구 후에는 반드시 행 수나 체크섬으로 결과를 확인해야 하고, GTID 차집합이 비었는지 보는 것이 가장 빠른 확인입니다.

### 함정 3. binlog가 만료되면 PITR 창이 닫힌다

```console
$ SELECT @@binlog_expire_logs_seconds        # 기본값
  2592000
  (2592000초 = 30일)

$ SET GLOBAL binlog_expire_logs_seconds = 1; FLUSH BINARY LOGS;
  binlog 파일 수 4개 → 2개
  가장 오래된 파일 binlog.000001 → binlog.000004
$ SHOW BINARY LOGS
  binlog.000004	242	No
  binlog.000005	198	No
```

만료는 시각이 되면 자동으로 일어나지 않습니다. **서버 기동 시점과 binlog flush 시점에만** 정리됩니다. 남은 파일의 첫 이벤트 시각이 곧 PITR 가능 하한이고, 최신 풀백업이 그 하한보다 오래됐다면 백업은 있는데 이어붙일 binlog가 없어 그 구간은 영구 유실입니다. **백업 보존 주기와 binlog 만료 기간은 함께 정해야 합니다.**

### 랩 아티팩트 둘

아래 둘은 MySQL의 성질이 아닙니다. 하나는 컨테이너 이미지의 구성이고 하나는 제 셸 스크립트 버그입니다. 그래도 지우지 않고 남기는 이유는 **둘 다 "조용한 실패"라는 이 글의 관통 주제와 같은 모양**이기 때문입니다. 복구 도구가 없다는 것도, 파이프가 안 닿는다는 것도, 사고 당일에 알면 늦습니다.

#### 아티팩트 1. 공식 이미지에 `mysqlbinlog`가 없다

```console
$ docker exec a23-mysql bash -c "ls /usr/bin | grep -i '^mysql'"
mysql
mysql-secret-store-login-path
mysql_config
mysql_migrate_keyring
mysql_tzinfo_to_sql
mysqladmin
mysqldump
mysqlsh

$ docker exec a23-mysql mysqlbinlog --version
bash: line 1: mysqlbinlog: command not found
```

여덟 줄이 나오는데 그중 `mysqlbinlog`는 없습니다. `mysql:8.4` 공식 이미지에 `mysqldump`는 있는데 `mysqlbinlog`가 없습니다. 공식 문서의 PITR 절차는 전부 `mysqlbinlog`로 쓰여 있으므로, 컨테이너로 운영하면서 이 사실을 사고 당일에 알면 복구가 그 자리에서 멈춥니다. 이 세션은 클라이언트 유틸이 들어 있는 percona-server 컨테이너로 우회했습니다.

#### 아티팩트 2. 파이프가 컨테이너에 닿지 않는다

`docker exec`에 `-i`를 빠뜨리면 표준입력이 전달되지 않습니다. 그런데 **에러가 나지 않습니다.** 500건을 넣는 스크립트가 조용히 0건을 넣었고, 그 뒤 측정이 전부 어긋났습니다. 복구 스크립트를 자동화할 때 "실행됐다"와 "적용됐다"를 구분해 검증해야 하는 이유입니다.

### 규모를 키우면 무엇이 달라지는가

이 세션의 가장 큰 약점은 규모입니다. 1,500행에 40K 덤프로 RTO를 말하면 "백업 0.075초" 한 줄에서 나머지가 통째로 할인됩니다. 그래서 규모를 400만 행까지 올려 곡선을 그렸습니다. 규모마다 새 컨테이너를 띄우고 각 2회씩입니다.

| 행 수 | 덤프 크기 | 덤프 | 복원 | 합계 | 행/합계 배수 |
|---|---|---|---|---|---|
| 1,500 | 1MB | 0.08초 | 0.23초 | 0.54초 | 1.00 |
| 200,000 | 27MB | 0.28초 | 1.12초 | 1.67초 | 43.4 |
| 1,000,000 | 131MB | 0.95초 | 4.29초 | 5.57초 | 65.2 |
| 4,000,000 | **525MB** | 3.66초 | **16.88초** | **21.48초** | 67.7 |

**시간은 규모를 탑니다.** 행이 2,667배가 되면 합계가 39.8배입니다.

**그런데 복원 판정은 전 규모에서 통과입니다.** 1,500행에서 400만 행까지 같습니다. 이것이 이 세션이 작은 규모에서 인용할 수 있는 것과 없는 것을 가릅니다. **절대 시간은 못 씁니다. 판정과 경계 규칙은 씁니다.** `recovery_target_inclusive`가 커밋 정각 한 건을 가르는 것, SQL Server의 복구 모델이 `SIMPLE`이면 로그 백업이 거부되는 것, Oracle의 아카이브 모드 전환에 `MOUNT` 단계가 붙는 것은 행이 1,500개든 400만 개든 같습니다.

표를 읽을 때 두 가지를 밝혀 둡니다. **덤프와 복원을 더해도 합계가 안 됩니다.** 합계에는 컨테이너 기동, 접속 대기, 스키마 생성, 바이너리 로그 적용, 검증 조회가 함께 들어 있고 표에는 덤프와 복원 두 구간만 뽑았습니다. 1,500행에서 0.08과 0.23을 더하면 0.31인데 합계가 0.54인 것이 그 차이입니다. 그리고 **행/합계 배수는 반올림한 표 값이 아니라 원시값으로 계산한 것**이라 표의 숫자로 다시 나누면 안 맞습니다.

이 표의 1,500행 복원 0.23초는 3절의 0.078초와 다릅니다. **다른 스크립트의 다른 회차**입니다. 3절은 `mysqldump` 한 벌을 복원한 값이고 이 표는 규모 곡선용으로 새로 만든 컨테이너에서 데이터베이스를 통째로 되돌린 값입니다. 두 값을 같은 축에 놓고 비교하면 안 됩니다.

마지막 열이 그 반대쪽을 보여 줍니다. **행/합계 배수가 1에서 67.7로 올라갑니다.** 규모가 커질수록 행당 복구 비용이 싸집니다. 기동과 접속과 스키마 생성 같은 고정비가 희석되기 때문입니다. 곧 **작은 랩에서 잰 RTO는 큰 규모로 그대로 곱하면 과대평가가 됩니다.** 1,500행의 0.54초에 2,667을 곱하면 24분인데 실제 400만 행은 21.5초입니다.

이 실험을 짜면서 **함정 1을 또 밟았습니다.** `RESET BINARY LOGS AND GTIDS` 다음에 `DROP DATABASE`를 실행했더니 그 `DROP`이 새 GTID를 만들어 덤프의 `SET @@GLOBAL.GTID_PURGED`가 다시 겹쳤습니다.

```
ERROR 3546 (HY000) at line 24: @@GLOBAL.GTID_PURGED cannot be changed:
the added gtid set must not overlap with @@GLOBAL.GTID_EXECUTED
```

에러를 버리고 있었기 때문에 처음에는 "525MB 복원이 0.19초"라는 값이 남았습니다. 순서를 뒤집고, 복원 후 행 수가 원본과 정확히 같은지 확인해 아니면 그 회차를 버리도록 고쳤습니다.

## 5. 원 엔진으로 다시: PostgreSQL

여기까지는 MySQL입니다. 원 사건은 PostgreSQL이었으니 같은 엔진에서 한 번 더 밟아 봤습니다. 결과가 갈리는 자리가 두 곳 나옵니다. 둘 다 기본값이고, 둘 다 사람이 기대하는 쪽과 반대입니다.

환경은 PostgreSQL 17.5, `archive_mode=on`, `archive_command`는 공식 문서 권고대로 이미 있는 파일이면 실패하게 두었습니다. `pg_basebackup`으로 1,000행 시점의 베이스 백업을 뜬 뒤 500행을 더 넣고, 그 500행을 `DELETE`로 지우는 것이 사고입니다.

### 목표 시점에 닿아도 서버가 열리지 않는다

`recovery_target_time`만 주고 `recovery_target_action`을 지정하지 않으면 기본값은 `pause`입니다.

![복구는 끝났는데 읽기 전용이다](/uploads/incident/backup-pitr/fig-pg-pause.png)

복구는 끝났고 데이터도 사고 직전 1,500행 그대로입니다. 그런데 `pg_is_in_recovery()`가 `t`이고 쓰기가 되지 않습니다. `pg_wal_replay_resume()`을 사람이 불러야 승격됩니다. MySQL의 PITR에는 이 단계가 없습니다. binlog를 이어 붙인 그 서버는 이미 쓰기가 되는 상태입니다. 복구 절차서에 승격 한 줄이 빠져 있으면 "복구는 됐는데 서비스가 안 열린다"에서 시간을 씁니다.

### inclusive는 커밋 정각 한 건만 가른다

`recovery_target_inclusive` 기본값은 `on`이고, 목표 시각과 커밋 시각이 같은 트랜잭션을 포함합니다. 사고 트랜잭션의 커밋 시각을 그대로 목표로 주면 그 사고가 다시 적용된다는 뜻입니다.

여기서 한 번 헛디뎠습니다. 처음에는 사고 직후에 `now()`를 찍어 그 값을 목표로 줬는데, `off`로 둬도 500행이 그대로 사라졌습니다. `now()`는 `DELETE`가 커밋된 뒤에 실행한 별도 쿼리의 시각이라 커밋보다 늦습니다. `inclusive`가 가르는 것은 목표 시각과 정확히 같은 시각에 커밋된 트랜잭션 하나뿐이므로, 목표가 조금이라도 뒤면 사고는 `off`와 무관하게 들어옵니다.

그래서 `track_commit_timestamp=on`으로 켜고 사고 트랜잭션의 XID를 잡아 `pg_xact_commit_timestamp()`로 정확한 커밋 시각을 얻은 다음, 네 조건으로 나눠 다시 쟀습니다.

| 복구 | 목표 시각 | `inclusive` | 결과 |
|---|---|---|---|
| A | 사고 직전 | 기본(`on`) | 1,500행. 단 `pause`라 승격 전까지 읽기 전용 |
| B | 사고 커밋 정각 | 기본(`on`) | **1,000행. 사고가 다시 적용됨** |
| C | 사고 커밋 정각 | `off` | 1,500행 |
| D | 사고 커밋 +1초 | `off` | **1,000행. `off`가 아무것도 막지 못함** |

![inclusive는 커밋 정각 한 건만 가른다](/uploads/incident/backup-pitr/fig-pg-inclusive.png)

C와 D의 차이가 이 절의 요점입니다. 설정은 똑같이 `recovery_target_inclusive = off`인데 목표 시각만 1초 다릅니다. `off`는 안전장치가 아니라 경계 한 칸을 옮기는 스위치이고, 그 경계는 커밋 타임스탬프 정각에만 있습니다. 사고 시각을 로그나 모니터링 그래프에서 눈대중으로 읽어 넣는 흔한 방식에서는 이 스위치가 아무 일도 하지 않습니다.

안전한 쪽은 A입니다. 사고보다 앞선 시각을 목표로 잡으면 `inclusive`가 무엇이든 사고는 들어오지 않습니다. C는 유실을 최소화하지만 `track_commit_timestamp`를 미리 켜 뒀을 때만 성립합니다. 기본값은 `off`이고, 사고가 난 다음에 켜면 이미 지나간 트랜잭션의 커밋 시각은 나오지 않습니다.

### 반복 측정 4회

네 회차 모두 같은 값입니다.

| 복구 | 4회 결과 |
|---|---|
| A 사고 직전 목표(`pause`) | 1,500 × 4 |
| B 커밋 정각, `inclusive=on` | 1,000 × 4 |
| C 커밋 정각, `inclusive=off` | 1,500 × 4 |
| D 커밋 +1초, `inclusive=off` | 1,000 × 4 |

경계 규칙은 상수라 편차가 없습니다. **C와 D가 매번 갈리는 것이 이 절의 결론이 회차 편차가 아니라는 근거입니다.**

### 두 엔진을 나란히 놓으면

| | MySQL 8.4 | PostgreSQL 17.5 |
|---|---|---|
| 복구 재료 | 풀 덤프 + binlog | 베이스 백업 + 아카이브 WAL |
| 경계 지정 | `--stop-position`, `--stop-datetime` | `recovery_target_lsn`, `_time`, `_xid`, `_name` |
| 경계 포함 | `--stop-position`은 그 위치 직전까지 | `recovery_target_inclusive` 기본 `on`, 정각 한 건만 가름 |
| 복구 직후 상태 | 바로 쓰기 가능 | 기본 `pause`. 승격을 사람이 부름 |
| 조용한 실패 | GTID 겹침 시 재적용 스킵(함정 2) | `restore_command`가 성공을 가장하면 잘못된 지점에서 멈춤 |

마지막 줄에서 두 엔진이 같은 방식으로 위험합니다. PostgreSQL 문서가 `archive_command`에 대해 없는 파일 요청에는 반드시 0이 아닌 값을 반환해야 한다고 못 박는 이유이고, 이 실험의 compose에도 `test ! -f`를 앞에 둔 이유입니다.

## 6. SQL Server로 한 번 더

SQL Server Developer 에디션은 `mcr.microsoft.com/mssql/server`로 무료 공개돼 있고 `STOPAT` 시점 복구가 그 에디션에 들어 있습니다. 같은 사고를 이 엔진에서도 돌려 봤습니다.

SQL Server 2022 (16.0.4265.3), Developer 에디션, 같은 1,500행 규모입니다. Apple Silicon에는 ARM 이미지가 없어 에뮬레이션으로 돌고 메모리를 6GB 줘야 떴습니다.

### 복구 모델이 SIMPLE이면 시점 복구가 성립하지 않습니다

```console
1> BACKUP LOG spoon TO DISK='/var/opt/mssql/backup/log_simple.trn' WITH INIT
Msg 4208, Level 16, State 1
The statement BACKUP LOG is not allowed while the recovery model is SIMPLE.
Use BACKUP DATABASE or change the recovery model using ALTER DATABASE.
```

이것이 MySQL과 PostgreSQL에 없는 관문입니다. MySQL은 `log-bin`이 켜져 있으면 binlog가 나오고, PostgreSQL은 `archive_mode=on`이면 WAL이 보관됩니다. SQL Server는 **데이터베이스마다 복구 모델이 따로 있고**, `SIMPLE`이면 로그 백업 자체가 거부됩니다. 새 DB는 `model` 데이터베이스의 값을 물려받으므로, 그 값이 `SIMPLE`인 인스턴스에서는 만든 DB가 전부 시점 복구를 못 합니다. **백업 스크립트가 있어도 이 값 하나로 창이 닫힙니다.**

### 로그를 이어 붙이려면 `NORECOVERY`가 먼저입니다

```console
-- NORECOVERY 없이 전체 백업만 복원
RESTORE DATABASE successfully processed 498 pages
상태 ONLINE, 행 수 1000

-- 그 뒤 로그를 적용해 보면
Msg 3117, Level 16, State 1
The log or differential backup cannot be restored because no files are ready to rollforward.
```

데이터베이스가 열려 버렸고, 그 뒤로는 로그를 적용할 수 없습니다. 다시 하려면 전체 백업부터 복원해야 합니다. **1,000행 상태로 서비스를 열고 나서 "아 500건이 없네"를 알아차리면 그때는 이미 늦습니다.**

MySQL은 이 함정이 없습니다. 덤프를 복원한 뒤 아무 때나 binlog를 이어 붙일 수 있습니다. PostgreSQL도 `recovery.signal`이 있으면 복구 모드로 뜹니다. SQL Server만 **복원 명령에 상태를 명시**해야 합니다.

### `STOPAT`을 넉넉하게 잡으면 열리지 않습니다

| 복구 | `STOPAT` | 결과 |
|---|---|---|
| A | (없음, `NORECOVERY`도 없음) | ONLINE, 1,000행. 로그 이어 붙이기 불가 |
| B | 사고 직전 `2026-07-30 12:13:22.922` | ONLINE, **1,500행** |
| C | 사고 직후 `2026-07-30 12:13:25.390` | **RESTORING. 열리지 않음** |
| D | 로그 백업 완료 시각 `12:13:25.000` | ONLINE, **1,500행** |

C가 이 절의 요점입니다. `RECOVERY`를 함께 줬는데도 데이터베이스가 `RESTORING`에 남았습니다. `STOPAT` 시각이 이 로그 백업의 끝보다 뒤라서, SQL Server가 **아직 적용할 로그가 더 있을 수 있다고 보고 기다립니다.**

5절에서 PostgreSQL이 `recovery_target_action` 기본 `pause` 때문에 "복구는 됐는데 안 열린다"를 만들었습니다. SQL Server도 같은 증상을 만드는데 **원인이 다릅니다.** PostgreSQL은 목표에 도달했는데 승격을 안 한 것이고, SQL Server는 목표에 도달하지 못했다고 판단한 것입니다. 전자는 `pg_wal_replay_resume()`으로 열리고, 후자는 `RESTORE DATABASE ... WITH RECOVERY`를 한 번 더 불러야 합니다.

D도 함께 봐야 합니다. `STOPAT`을 로그 백업 완료 시각으로 주면 1,500행입니다. 사고 `DELETE`가 그 로그 안에 있는데도 제외됐습니다. `msdb.dbo.backupset`의 완료 시각이 초 단위로 기록되어 사고 커밋의 실제 타임스탬프보다 이르기 때문입니다. **PostgreSQL의 `recovery_target_inclusive`처럼 경계를 옵션으로 고를 수는 없고, `STOPAT`은 그 시각까지 포함하는 규칙이 고정입니다.**

### 세 엔진을 나란히 놓으면

| | MySQL 8.4 | PostgreSQL 17.5 | SQL Server 2022 |
|---|---|---|---|
| 복구 재료 | 풀 덤프 + binlog | 베이스 백업 + 아카이브 WAL | 전체 백업 + 로그 백업 |
| 로그 보관의 전제 | `log-bin` | `archive_mode=on` | **DB별 복구 모델이 `FULL`** |
| 경계 지정 | `--stop-position`, `--stop-datetime` | `recovery_target_*` | `STOPAT` |
| 경계 포함 | 그 위치 직전까지 | `recovery_target_inclusive`로 선택 | 고정(그 시각까지 포함) |
| 복구 직후 상태 | 바로 쓰기 가능 | 기본 `pause`. 승격 필요 | `NORECOVERY`를 명시해야 로그 이어 붙임 |
| 안 열리는 함정 | 없음 | 목표 도달 후 `pause` | `STOPAT`이 로그 끝보다 뒤면 `RESTORING` | `RESETLOGS` 뒤 옛 시점은 `RMAN-20207` |
| 벽시계 경계 | **`--stop-datetime`도 초 단위, 같은 초 커밋은 빠짐** | `recovery_target_time`도 같은 성질 | `STOPAT` 초 단위 반올림 |

**세 엔진이 같은 사고를 다른 자리에서 막습니다.** 절차서를 한 엔진에서 쓰고 다른 엔진에 옮기면 그 자리마다 다시 걸립니다.



### SQL Server 판정을 3회 반복하면

이 컨테이너는 ARM 에뮬레이션으로 돕니다. 그래서 시간 수치를 아예 안 적었는데, 그러면 무엇을 반복해야 하는지가 남습니다. **시간이 아니라 판정을 반복했습니다.** 이 절이 말하는 셋은 원래 시간이 아니라 결과의 종류입니다.

| 조건 | 회차 1 | 회차 2 | 회차 3 |
|---|---|---|---|
| 사고 직전 / 사고 후 행 수 | 2,001 / 1,501 | 2,001 / 1,501 | 2,001 / 1,501 |
| A `NORECOVERY` 누락 | 로그 적용 에러 2건 | 2건 | 2건 |
| B `STOPATMARK` | `ONLINE`, 2,001행 | 같음 | 같음 |
| C `STOPAT`이 로그 끝보다 뒤 | `RESTORING` | 같음 | 같음 |

**세 회차가 완전히 같습니다.** 에뮬레이션이 시간을 흔들어도 판정은 안 흔들립니다. 그래서 시간 수치 없이도 이 절의 결론을 인용할 수 있습니다.

반복하면서 조건 B를 `STOPAT`(시각)에서 `STOPATMARK`(트랜잭션 마크)로 바꿨습니다. 시각으로 주면 회차마다 `RESTORING`에 남았다 안 남았다 합니다. `STOPAT`이 초 단위로 반올림되고 그 시점이 로그 백업의 유효 구간 안에 들어가는지가 회차마다 갈리기 때문입니다. `BEGIN TRAN ... WITH MARK`로 지점에 이름을 붙이면 시계와 무관해집니다. **"이 시점으로 되돌린다"를 정확히 하려면 시각보다 마크가 낫습니다.**

## 7. Oracle 대조

마지막 하나가 Oracle입니다. Database Free 23ai가 무료 공개돼 있어 실행했습니다. Oracle AI Database 26ai Free (23.26.2.0.0)입니다.

| | 사고 전 | 사고 후 | `UNTIL TIME` 복구 후 |
|---|---|---|---|
| Oracle 26ai Free | 1,500행 | 1,000행 | **1,500행** |

```
RUN {
  SHUTDOWN IMMEDIATE;
  STARTUP MOUNT;
  SET UNTIL TIME "TO_DATE('2026-07-31 02:40:54','YYYY-MM-DD HH24:MI:SS')";
  RESTORE DATABASE;
  RECOVER DATABASE;
  ALTER DATABASE OPEN RESETLOGS;
}
```

### `RESETLOGS`가 인카네이션(incarnation)을 만듭니다

복구를 마치고 `RESETLOGS`로 열면 데이터베이스의 계보가 갈립니다.

```console
SQL> SELECT incarnation#, status, resetlogs_change# FROM v$database_incarnation;
    1 PARENT     1
    2 PARENT     1924245
    3 PARENT     2953770
    4 CURRENT    2956222
```

네 번 열렸고 지금은 4번입니다. **그 시점 이후의 옛 아카이브 로그는 새 인카네이션에
적용할 수 없습니다.** 되돌아가려면 `RESET DATABASE TO INCARNATION`을 먼저 해야 합니다.

MySQL·PostgreSQL·SQL Server 에는 이 개념이 없습니다. **복구를 여러 번 시도할 때
"어느 복구본에서 갈라져 나온 것인가"를 데이터베이스가 스스로 관리하는 것이 Oracle 쪽
특징이고, 그만큼 관리 대상이 하나 더 있습니다.**

### 목표 시각의 리두가 아직 아카이브되지 않았으면 그 앞까지만 갑니다

처음 실행에서 복구 후 행 수가 1,000이었습니다. 목표 시각이 사고 직전인데 백업 시점까지만
되돌아간 것입니다. 원인은 그 시점의 리두가 **아직 현재 온라인 로그에만 있고 아카이브되지
않은 것**이었습니다. 목표 시각을 잡기 전에 `ALTER SYSTEM ARCHIVE LOG CURRENT`를 넣어
고쳤습니다.

이것은 PostgreSQL의 `archive_timeout`과 같은 자리입니다. **"방금 커밋했으니 복구할 수
있다"가 아니라 "그 리두가 아카이브로 떨어졌으니 복구할 수 있다"입니다.**

### 아카이브 로그 모드를 끄고 다시 켜 봤습니다

이 이미지는 `ARCHIVELOG`로 출고됩니다. 출고 상태가 그렇다는 것이 못 재는 이유는 아니라서, 끄고 다시 켜며 그 왕복을 쟀습니다.

| 방향 | 걸린 시간 | 그동안 |
|---|---|---|
| `ARCHIVELOG` → `NOARCHIVELOG` | 12초 | 데이터베이스가 질의를 안 받습니다 |
| `NOARCHIVELOG` → `ARCHIVELOG` | 11초 | 같습니다 |

끈 상태에서 `RMAN`이 무엇을 말하는지도 봤습니다. `RMAN-06026: some targets not found - aborting restore`로 거절하고, `v$archived_log`가 0건입니다. **리두가 덮어써지므로 백업 시점 뒤로 되돌아갈 재료 자체가 없습니다.** 되돌린 직후에는 1건이 생겨 아카이브가 실제로 도는 것까지 확인했습니다.

**갈리는 자리는 길이가 아니라 단계입니다.** 이 랩은 데이터가 1,500행이라 12초의 대부분이 기동 시간이고, 운영 규모에서는 `SHUTDOWN IMMEDIATE`가 열린 트랜잭션의 롤백을 기다리므로 더 길어집니다. 그보다 중요한 것은 Oracle이 데이터베이스를 `MOUNT` 상태에 두는 단계를 하나 더 요구한다는 점입니다. 열린 채로는 바꿀 수 없습니다. PostgreSQL은 `archive_mode`를 켜고 재기동하면 되고, MySQL은 `log-bin`을 켜고 재기동하면 됩니다. **백업 전략을 나중에 바꾸려 할 때 이 한 단계가 정지 시간의 성격을 가릅니다.**

각 방향 1회 실행입니다.

### 아카이브 전환을 3회 반복하면

exp6은 각 방향 1회였습니다. 1,500행짜리 랩이라 그 12초의 대부분이 기동 시간인데, 기동은 회차마다 흔들리는 값이라 한 번 재고 인용하면 안 됩니다. 끄고 켜기를 한 묶음으로 3회 돌렸습니다.

| 방향 | 중앙 | 범위 | 폭 |
|---|---|---|---|
| `ARCHIVELOG` → `NOARCHIVELOG` | 11.7초 | 11.5~12.2초 | 6.0% |
| `NOARCHIVELOG` → `ARCHIVELOG` | 10.5초 | 10.5~11.4초 | 8.6% |

**회차 폭이 6~8.6%로 좁습니다.** 두 방향의 중앙값 차이 1.2초가 회차 폭 최대 0.9초보다 크므로, "끄는 쪽이 조금 더 오래 걸린다"까지는 인용할 수 있습니다. 끄는 쪽에 `ALTER DATABASE NOARCHIVELOG` 뒤 정리가 조금 더 붙는 것으로 보이지만 그 안을 갈라 보지는 않았습니다.

다만 앞에서 적은 대로 **갈리는 자리는 길이가 아니라 단계입니다.** 두 방향 다 10초대이고 그 대부분이 기동이며, MySQL과 PostgreSQL은 설정을 바꾸고 재기동 한 번이면 끝납니다. Oracle만 `MOUNT`라는 중간 상태를 하나 더 지납니다.


### 네 엔진 대조

| | MySQL 8.4 | PostgreSQL 17.5 | SQL Server 2022 | Oracle 26ai |
|---|---|---|---|---|
| 복구 재료 | 풀 덤프 + binlog | 베이스 백업 + WAL | 전체 백업 + 로그 백업 | RMAN 백업 + 아카이브 로그 |
| 로그 보관 전제 | `log-bin` | `archive_mode=on` | DB별 복구 모델 `FULL` | `ARCHIVELOG` 모드 |
| 전제를 켜는 비용 | 재기동 | 재기동 | `ALTER DATABASE` (온라인) | 재기동 + `MOUNT` 단계 |
| 경계 지정 | `--stop-position`, `--stop-datetime` | `recovery_target_*` | `STOPAT` | `SET UNTIL TIME` |
| 경계 포함 | 그 위치 직전까지 | `inclusive`로 선택 | 고정(그 시각까지 포함) | 그 시각 직전까지 |
| 복구본의 계보 | 없음 | 타임라인(`.history`) | 없음 | **인카네이션** |
| 안 열리는 함정 | 없음 | 목표 도달 후 `pause` | `STOPAT`이 로그 끝보다 뒤면 `RESTORING` | `RESETLOGS` 뒤 옛 시점은 `RMAN-20207` |
| 벽시계 경계 | **`--stop-datetime`도 초 단위, 같은 초 커밋은 빠짐** | `recovery_target_time`도 같은 성질 | `STOPAT` 초 단위 반올림 | 리두가 아카이브 안 됐으면 그 앞까지만 |

**네 엔진이 같은 사고를 네 자리에서 다르게 막습니다.**
## 8. 해소: 백업을 믿지 않는 절차

실험에서 나온 것을 운영 체크리스트로 정리하면 이렇습니다.

| 항목 | 확인 방법 |
|---|---|
| 백업이 비어 있지 않은가 | 파일 크기 임계치 + 종료 코드 확인. `set -o pipefail` 없이 파이프 쓰면 실패를 놓친다 |
| 복원이 되는가 | 별도 인스턴스에 정기 복원. GitLab의 pg_dump 버전 불일치는 이 단계에서 즉시 잡혔을 문제다 |
| 복원된 데이터가 맞는가 | 행 수·체크섬 대조. 복원 성공과 데이터 정합은 다르다(함정 2) |
| binlog가 백업 대상인가 | 풀백업만 있으면 RPO는 백업 주기다. binlog가 있어야 그 사이를 메운다 |
| binlog 만료가 백업 주기보다 긴가 | `binlog_expire_logs_seconds` vs 백업 보존 기간 |
| 복구 도구가 그 환경에 있는가 | 사고 당일에 확인하면 늦다 |
| 복구 시간이 RTO 안인가 | 리허설에서 실측. 추정하지 않는다 |

## 9. 예상과 달랐던 점

### 함정 셋을 제가 직접 밟았습니다

이 세션의 실험 설계는 조사에서 나왔지만, **함정 1·2와 아티팩트 2는 스크립트를 짜다가 실제로 막혀서 발견한 것들**입니다. GTID 겹침으로 복원이 중단됐고, `mysqlbinlog`가 없어 도구 컨테이너를 추가했고, `-i` 누락으로 데이터가 조용히 안 들어갔습니다. 재현 랩을 만드는 사람도 같은 자리에서 막힌다는 뜻이고, 실전에서 처음 해보면 더할 것입니다. **복구 리허설을 해봐야 하는 이유가 이것 자체입니다.**

### GTID 경고가 PITR 문서에 없습니다

MySQL의 PITR 문서(9.5절)에는 GTID 관련 경고가 한 줄도 없습니다. 조용한 스킵은 복제 챕터에, `--set-gtid-purged` 문제는 mysqldump 옵션 설명에 흩어져 있습니다. PITR 문서만 읽고 따라 하면 두 함정을 그대로 만나는 구조입니다.

### 같은 함정이 엔진을 건너 반복됩니다

5절에서 PostgreSQL을 붙이고 나서야 보인 것인데, 두 엔진의 가장 위험한 실패가 같은 모양입니다. MySQL은 GTID가 겹치면 재적용을 조용히 스킵하고, PostgreSQL은 `restore_command`가 성공을 가장하면 잘못된 지점에서 조용히 멈춥니다. 엔진을 바꿔도 "성공처럼 보이는 실패"라는 형태는 남습니다.

### 실패 모드가 전부 조용합니다

다섯 중 셋(재적용 스킵, binlog 만료, `-i` 누락)이 에러 없이 실패합니다. 나머지 둘(GTID 겹침, 도구 부재)은 시끄럽게 실패하는데, 역설적으로 그쪽이 낫습니다. **복구에서 가장 위험한 것은 실패가 아니라 성공처럼 보이는 실패입니다.** GitLab 사고에서 cron 실패 알림이 DMARC로 막혀 몇 달간 아무도 몰랐던 것과 같은 종류입니다.

## 10. 논리 백업과 물리 백업의 복원 시간

논리는 `mysqldump`, 물리는 서버를 멈추고 데이터 디렉터리를 통째로 옮기는 콜드 백업입니다.

### 규모를 바꾸면 방향이 뒤집힙니다

두 규모에서 각각 3회씩 돌렸습니다. 표의 값은 3회 중앙값입니다.

| 행 수 | 논리 백업 | 논리 복원 | 물리 백업 | 물리 복원 | 복원 배수 |
|---|---|---|---|---|---|
| 10만 | 0.13초 | **0.87초** | 1.75초 | **5.87초** | 논리가 6.7배 빠름 |
| 100만 | 0.76초 | **8.92초** | 2.90초 | **6.72초** | 물리가 1.3배 빠름 |

**10만 행에서는 논리가 6.7배 빠르고, 100만 행에서는 물리가 1.3배 빠릅니다.** 열 배를 키우자 방향이 넘어갔습니다.

이유는 두 비용의 성질이 다르기 때문입니다. **논리 복원은 행 수에 비례합니다.** 0.87초가 8.92초로 10.3배가 됐고, 행 수 10배와 거의 같습니다. SQL을 다시 파싱하고 행을 넣고 인덱스를 다시 만드는 일이라 데이터가 늘면 그만큼 늡니다.

**물리 복원은 대체로 고정입니다.** 5.87초가 6.72초로 1.15배만 늘었습니다. 비용의 대부분이 데이터가 아니라 서버 재기동입니다. 컨테이너를 멈추고 tar를 풀고 다시 띄우는 그 기동이 6초 남짓이고, 행 수가 열 배가 돼도 거기는 안 움직입니다.

그러면 교차점이 있습니다. 이 랩에서는 10만과 100만 사이입니다. **그 아래에서는 덤프가 빠르고 그 위에서는 파일 복사가 빠릅니다.** 두 규모만 재서 정확한 지점은 모릅니다.

백업 크기는 규모와 무관하게 갈립니다. 10만 행에서 7.8MB 대 237.3MB로 30배, 100만 행에서 78.9MB 대 540.9MB로 6.9배입니다. 물리 백업은 데이터 파일뿐 아니라 시스템 테이블스페이스와 리두 로그까지 통째로 담기 때문에, 데이터가 작을수록 그 고정분의 비중이 큽니다.

### 논리 복원이 0행으로 끝나던 자리를 잡았습니다

처음 돌렸을 때는 논리 쪽이 거의 다 실패했습니다. 100만 행 세 회차가 전부 복원 후 0행이었고 10만 행도 첫 회차만 성공했습니다.

원인은 **GTID 였습니다.** `mysqldump`는 기본으로 `SET @@GLOBAL.GTID_PURGED`를 덤프 머리에 넣습니다. 그런데 복원 대상 서버에는 앞 회차가 만든 GTID가 이미 남아 있어서, 그 문장이 `@@GLOBAL.GTID_PURGED can only be set when @@GLOBAL.GTID_EXECUTED is empty`로 거부됩니다. 거부되는 순간 그 뒤의 `CREATE TABLE`과 `INSERT`가 통째로 안 돌고, `mysql` 클라이언트는 종료 코드만 남기고 조용히 끝납니다.

**그래서 복원이 0.06초에 끝나고 행이 0개입니다.** 회차를 거듭할수록 심해진 것도 이 때문입니다. 첫 회차는 서버가 깨끗해서 통과하고 두 번째부터 걸립니다.

고친 것은 두 가지입니다. 회차마다 복원 대상에 `RESET BINARY LOGS AND GTIDS`를 걸어 GTID 상태를 비우고, 복원 뒤 행 수가 적재한 수와 **정확히 같은지**(`-ne` 비교) 확인해 아니면 그 회차를 버립니다.

**이 결함은 "성공처럼 읽히는 실패"의 전형입니다.** 에러는 표준 오류로 나가고 종료 코드는 0이며, 남는 것은 "복원 0.06초"라는 아주 좋아 보이는 수치입니다. 가드를 넣기 전 실행에서는 그 값이 그대로 표에 들어가 논리가 물리보다 75배 빠른 것처럼 보였습니다.

### 이 절의 한계

- 두 규모만 쟀습니다. 교차점이 10만과 100만 사이라는 것까지이고 정확한 지점은 모릅니다.
- 물리 백업이 콜드입니다. 서버를 멈춰야 하므로 무중단이 아닙니다. XtraBackup은 그 정지를 없애는 대신 도구 자체가 필요하고, 이 랩에서는 MySQL 8.4용 이미지를 확보하지 못해 쓰지 않았습니다.
- **물리 복원의 재기동 비용은 이 컨테이너의 값입니다.** 6초 남짓이 고정비인데 그 값이 곧 교차점의 위치를 정합니다. 기동이 빠른 환경이라면 교차점이 왼쪽으로 옮겨 갑니다.

## 11. MySQL 세 구간을 반복해서

3절의 RTO 분해(백업 / 덤프 복원 / binlog 적용)가 각각 한 번씩 잰 값이었습니다. 어느 구간이 지배하는지로 개선할 곳이 정해지므로, 회차 폭이 구간 사이 차이보다 크면 그 판단이 안 섭니다. 20만 행에 binlog 구간 2만 행으로 5회 돌렸습니다.

| 구간 | 중앙 | 최소 | 최대 | 폭 |
|---|---|---|---|---|
| 백업(`mysqldump`) | 0.200초 | 0.200초 | 0.205초 | 0.005초 |
| 덤프 복원 | **1.565초** | 1.523초 | 1.588초 | 0.065초 |
| binlog 적용 | 0.208초 | 0.207초 | 0.214초 | 0.007초 |

**회차 폭이 구간 사이 차이보다 훨씬 작습니다.** 가장 넓은 것이 복원의 0.065초이고 복원과 나머지의 차이는 1.35초입니다. 어느 구간이 지배하는지 말할 수 있습니다.

**복원이 79.3%입니다.** 백업 10.1%, binlog 적용 10.5%입니다.

백업은 RTO에 안 들어갑니다. 사고가 나기 전에 이미 끝나 있기 때문입니다. **실제 RTO는 복원과 binlog 적용의 합 1.773초이고 그중 binlog 적용이 11.7%입니다.**

그래서 RTO를 줄이려면 복원을 봐야 합니다. binlog 적용을 아무리 최적화해도 12% 안에서 움직입니다. 물리 백업으로 바꾸는 것이 이 축에서 나오는 선택지인데, 10절에서 본 대로 이 규모에서는 물리 복원이 더 느립니다. **규모가 커져 논리 복원의 SQL 재실행이 지배하기 시작하는 지점이 그 교환이 뒤집히는 자리입니다.**

binlog 구간 2만 행이 0.208초입니다. 사고 시점까지 밀린 binlog가 100배면 20초입니다. **binlog 적용은 사고 발견이 늦을수록 선형으로 늘어납니다.** 복원 시간은 데이터 크기에 붙고 binlog 적용은 사고 이후 경과 시간에 붙습니다. 두 축이 다릅니다.

### 이 값을 얻는 데 네 번 실패했습니다

네 번 다 "binlog 적용 0행" 이었고, 그 옆의 백업과 복원 시간은 정상으로 찍혀 있었습니다.

1. `mysqldump`가 넣는 `SET @@GLOBAL.GTID_PURGED`가 대상의 GTID와 충돌해 복원 전체가 멈췄습니다. 첫 회차만 성공하고 2회차부터 0행이었습니다.
2. `SHOW BINARY LOG STATUS`를 두 번 나눠 읽어 그 사이에 위치가 움직였습니다.
3. `mysqlbinlog`에 표준입력(`-`)을 먹였습니다. 스트림은 되감을 수 없어 `--start-position`이 안 먹습니다.
4. **`mysql:8.4` 이미지에 `mysqlbinlog`가 없습니다.** 4절 아티팩트 1이 이미 알고 별도 컨테이너를 쓰고 있었는데 이 스크립트가 그대로 불렀고, `command not found`가 `2>&1`에 삼켜졌습니다.

넷 다 에러가 안 나고 "0행" 이라는 정상 모양의 숫자로 남았습니다.

## 12. 체크리스트를 파이프라인으로 옮겼습니다

8절의 체크리스트 일곱 항목을 실제로 도는 스크립트로 만들었습니다. 체크리스트는 지키는 사람이 있어야 지켜지고, 사람은 사고 당일에만 확인합니다.

핵심은 하나입니다. **백업을 믿지 않고 매번 되살려 봅니다.** 그리고 **일부러 망가뜨린 백업을 같이 넣습니다.** 통과만 시키는 검사는 아무것도 안 지키고 있는 것이라서, 각 검사가 실제로 걸리는지를 봐야 그 검사를 믿을 수 있습니다.

20만 행에 정상 덤프 하나와 망가뜨린 덤프 셋을 넣었습니다. 빈 파일, 중간에 잘린 것, `INSERT`만 주석 처리해 스키마만 남긴 것입니다.

| 백업 | 크기 검사 | 복원 실행 | 데이터 대조 |
|---|---|---|---|
| 정상 | 통과 | 통과 | 통과 |
| 빈 파일 | 걸림 | **통과** | 걸림 |
| 중간에 잘림 | 걸림 | 걸림 | 걸림 |
| 스키마만 | **통과** | **통과** | 걸림 |

**이 파이프라인은 첫 검사에서 걸려도 멈추지 않고 세 검사를 전부 돌립니다.** 그래야 어느 검사가 무엇을 잡는지 표로 볼 수 있습니다. 운영에 걸 때는 첫 실패에서 끊는 편이 자원을 아끼지만, 검사 자체를 검증하는 이 자리에서는 전부 돌려야 합니다.

**세 검사가 서로를 대신하지 못합니다.** 빈 파일과 스키마만 있는 덤프는 복원 실행을 에러 없이 통과합니다. 복원이 성공했다는 것과 데이터가 있다는 것은 다릅니다. 그리고 스키마만 남긴 덤프는 크기 검사도 통과합니다. `INSERT`를 주석으로 바꾼 것이라 바이트 수가 거의 그대로이기 때문입니다.

그래서 **데이터 대조가 마지막 방어선입니다.** 이때 행 수를 "0보다 큰가"로 보면 안 되고 원본과 정확히 같은지 봐야 합니다. 10절이 그 자리를 밟았습니다. GTID 충돌로 복원이 중간에 멈췄는데 종료 코드가 0 이라 "복원 0.06초"라는 아주 좋아 보이는 값이 남았습니다.

나머지 항목도 이 랩이 실제로 걸린 자리를 그대로 검사합니다. 복원 대상 컨테이너에 `mysqlbinlog`가 있는지 보는 항목은 4절 아티팩트 1에서 온 것이고, 이 실행에서도 **걸립니다.** `mysql:8.4` 이미지에 그 도구가 없기 때문입니다. 사고 당일에 알면 늦습니다.

마지막 항목은 리허설 전체 소요가 RTO 예산 안인지입니다. 이 실행은 5.4초였고, **추정이 아니라 방금 실제로 되살려 본 시간입니다.**

### 이 파이프라인을 짜면서 같은 함정을 밟았습니다

처음 돌렸을 때 검사가 전부 "걸림"으로 나왔습니다. 파이프라인이 아주 잘 도는 것처럼 보였습니다. 그런데 원본이 0행이었습니다. 20만 행을 재귀 CTE로 넣는데 `cte_max_recursion_depth` 기본값이 1000 이라 막힌 것입니다.

원본이 비었으니 복원한 것과 안 맞는 게 당연하고, 그래서 모든 대조가 걸렸습니다. **"검사가 잘 걸린다"와 "조건이 안 섰다"가 같은 모양이었습니다.** 이 세션이 다른 절에서 계속 말하던 그 유형입니다. 적재 직후에 행 수가 기대와 정확히 같은지 확인하고 아니면 그 자리에서 멈추도록 고쳤습니다.

이 실행은 1회입니다.

## 13. 관리형 서비스에서는 무엇이 달라지는가

> 이 절의 근거 등급은 `E3·문서 대조`입니다. 다른 절과 달리 **실행이 없습니다.** 계정이 없어 실물 인스턴스로 확인하지 못했고, 전부 AWS 공식 문서를 인용한 것입니다.

여기까지는 전부 직접 운영하는 엔진입니다. 실무의 PITR은 상당수가 RDS나 Aurora의 버튼 쪽이고, 그쪽은 규칙이 다릅니다. **이 절은 실물 인스턴스로 검증한 것이 아니라 AWS 공식 문서와 대조한 것입니다.** 계정이 없어 실행은 못 했습니다.

### 복원은 항상 새 인스턴스입니다

> "You can restore a DB instance to a specific point in time, **creating a new DB instance without modifying the source DB instance**."

**제자리 복구가 없습니다.** 이 세션이 한 것처럼 같은 서버에 덤프를 되돌리는 경로 자체가 없고, 그래서 4절 함정 1(GTID 겹침)도 안 생깁니다. 대신 다른 것이 생깁니다. 복원이 끝나면 엔드포인트가 다른 인스턴스가 하나 더 있고, **애플리케이션을 그쪽으로 옮기는 것이 별도 작업**입니다. RTO에 그 전환 시간이 붙습니다.

### RPO 하한이 설정이 아니라 5분입니다

> "RDS uploads transaction logs for DB instances to Amazon S3 **every five minutes**."

이 세션은 binlog를 사고 직전 위치까지 이어 붙여 유실을 0으로 만들었습니다. RDS에서는 그 자유가 없습니다. `LatestRestorableTime`이 상한이고 그 값은 5분 주기에 매입니다. **바꿀 수 있는 손잡이가 아닙니다.**

### 복원본은 기본 파라미터 그룹으로 뜹니다

> "Restored DB instances are **automatically associated with the default DB parameter and option groups**."

콘솔로 복원하면 복원이 끝난 뒤에 파라미터 그룹을 다시 붙여야 합니다. `innodb_buffer_pool_size`든 문자셋이든 원본과 다른 값으로 뜬다는 뜻입니다. **복원 직후의 인스턴스는 데이터만 원본이고 설정은 기본값입니다.** 사고 당일 이걸 모르면 "복구는 됐는데 느리다"가 됩니다.

### 이 글의 주제와 겹치는 자리가 둘 있습니다

**하나. 특정 상태가 PITR 창을 조용히 멈춥니다.**

> "For a SQL Server DB instance, the `OFFLINE`, `EMERGENCY`, and `SINGLE_USER` modes aren't supported. Setting any database into one of these modes **causes the latest restorable time to stop moving ahead for the whole instance**."

인스턴스 하나의 데이터베이스 하나를 그 모드로 두면 **인스턴스 전체의 복구 가능 시점이 그 자리에 멈춥니다.** 에러가 나는 것이 아니라 시계가 안 갑니다. 유지보수하느라 잠깐 `SINGLE_USER`로 돌려 두고 잊으면 그 뒤로 PITR이 없습니다.

**둘. 로그 사슬이 끊겼는데 그걸 감지 못 하는 경우가 있습니다.**

> "In some cases, Amazon RDS can detect this issue and the latest restorable time is prevented from moving forward. In other cases, such as when a SQL Server database uses the `BULK_LOGGED` recovery model, **the break in log sequence isn't detected.** It might not be possible to restore a SQL Server DB instance to a point in time if there is a break in the log sequence."

**감지되는 경우와 안 되는 경우가 갈립니다.** 감지되면 최소한 시계가 멈춰서 이상하다는 신호라도 남습니다. `BULK_LOGGED`는 감지가 안 되니 화면상 복구 가능 시점이 계속 앞으로 가고, 정작 복원해 보면 못 갑니다. 이 글이 계속 말한 유형이 관리형 서비스 안에도 그대로 있습니다.

그래서 AWS의 결론이 이렇습니다. "For these reasons, **Amazon RDS doesn't support changing the recovery model of SQL Server databases.**" 아예 못 바꾸게 막았습니다.

### 관리형이라도 안 바뀌는 것

| 항목 | 직접 운영 | RDS |
|---|---|---|
| 복원 위치 | 같은 서버 가능 | **항상 새 인스턴스** |
| RPO 하한 | 로그 주기를 내가 정함 | **5분 고정** |
| 복원본 설정 | 원본 그대로 | **기본 파라미터 그룹** |
| SQL Server 복구 모델 | 내가 바꿈 | **변경 금지** |
| 복원해 봐야 아는가 | 그렇다 | **그렇다** |

**마지막 줄이 이 글의 요지입니다.** 관리형으로 옮기면 백업을 만드는 일과 보관하는 일은 위임됩니다. 복원해 보는 일은 위임되지 않습니다. `LatestRestorableTime`이 앞으로 가고 있다는 것과 그 시점으로 실제 복원이 된다는 것은 다른 이야기이고, 위 `BULK_LOGGED` 항목이 그 둘이 갈리는 경우를 문서로 인정합니다. 12절이 만든 파이프라인이 관리형 환경에서도 필요한 이유입니다.

## 14. 현업은 어떻게 해소했는가

GitLab이 2017년에 프로덕션 DB 디렉터리를 지우고 백업 다섯 겹이 전부 안 들었던 사고입니다. **고친 것이 백업 기술이 아니었습니다.**

`pg_dump`는 정상적으로 에러를 냈습니다. 9.2 클라이언트가 9.6 서버를 덤프하려다 실패한 것이고, 그 실패는 크론 알림 메일로 나갔습니다. 죽은 것은 그 메일이었습니다.

> "While notifications are enabled for any cronjobs that error, these notifications are sent by email. ... Unfortunately DMARC was not enabled for the cronjob emails, resulting in them being rejected by the receiver. This means we were never aware of the backups failing, until it was too late."

크론 에러 알림은 켜져 있었지만 DMARC 미서명이라 수신 측이 거부했고, 너무 늦을 때까지 아무도 몰랐습니다. **탐지가 없던 것이 아니라 탐지 결과가 전달되지 않았습니다.**

5 Whys의 마지막 답이 조직을 지목합니다.

> "Why was the backup procedure not tested on a regular basis? - Because there was no ownership, as a result nobody was responsible for testing this procedure."

그래서 넣은 것이 이메일 대신 **Prometheus 백업 모니터링**, 공개 백업 대시보드, 복원 자동 테스트, 그리고 **"데이터 내구성 담당자 지정"**입니다.

**그 복원 테스트가 지금도 매일 돕니다.** 2026년 현재 GitLab 핸드북에 이렇게 적혀 있습니다.

> "Daily restoration testing is performed for GitLab.com application databases in CI pipelines ... This process performs a point-in-time recovery (PITR) restore into a new instance and verifies data integrity by running queries on the restored database."

새 인스턴스로 PITR 복원을 하고 **복원된 DB에 쿼리를 돌려 무결성을 확인**합니다. Gitaly도 무작위 스냅샷을 새 디스크에 복원해 최근 커밋이 있는지 봅니다. 여기에 분기별 Game Day로 RTO/RPO를 실측합니다.

**12절이 만든 파이프라인이 이 구조의 축소판입니다.** 복원해 보고, 행 수와 체크섬으로 대조하고, 소요가 예산 안인지 봅니다. 다만 GitLab이 실제로 고친 것 중 이 세션이 못 만든 것이 하나 있습니다. **소유자입니다.** 파이프라인은 짜면 되지만 그것이 실패했을 때 누가 받는가는 코드 밖의 문제입니다.

### 파이프라인을 주기 실행과 알림까지 붙였습니다

위 파이프라인은 1회 실행이고 스케줄러도 알림도 없었습니다. 그러면 시연이지 해결이 아닙니다. GitLab이 실제로 고친 것이 백업 기술이 아니라 소유자와 알림이었다는 것을 생각하면 특히 그렇습니다. 코드 안쪽 절반을 만들었습니다.

`tools/verify-scheduler.sh`는 세 가지를 합니다. 주기적으로 파이프라인을 돌리고, 실패하면 알림 채널에 쓰고, **그 알림이 실제로 남았는지 되읽어 확인합니다.**

마지막 항목이 이 스크립트의 이유입니다. GitLab의 `pg_dump`는 에러를 냈고 크론은 메일을 보냈는데 그 메일이 DMARC로 반려됐습니다. **알림 경로 자체를 검증하지 않으면 알림은 없는 것과 같습니다.** 그래서 지정한 회차에 일부러 백업을 손상시켜 알림이 실제로 나가는지 봅니다. 통과만 하는 감시는 감시하고 있지 않은 것과 같다는, 파이프라인에 적용한 것과 같은 논리입니다.

돌려 보니 여기서도 한 번 미끄러졌습니다. 처음 실행에서 전 회차가 실패로 나왔고 스크립트는 "실패 6건에 알림 6건입니다. 알림 경로가 살아 있습니다"라고 보고했습니다. **알림은 실제로 나갔으니 그 말이 틀린 것은 아닌데, 정작 백업 검사는 한 번도 안 돌았습니다.** 다른 실험이 자원을 쓰느라 검사용 컨테이너가 안 떴을 뿐입니다.

운영에서 이 둘을 같은 알림으로 묶으면 **"백업이 깨졌다"와 "검사 장비가 죽었다"를 구분할 수 없습니다.** 앞은 백업을 고쳐야 하고 뒤는 검사기를 고쳐야 하는데, 화면에는 둘 다 빨간불입니다. 그래서 실패를 두 종류로 갈라 종료 코드도 다르게 두었습니다.

| 종료 코드 | 뜻 | 다음 행동 |
|---|---|---|
| 0 | 전 검사 통과 | 없음 |
| 1 | 검사 실패 | 백업을 본다 |
| 2 | 일부러 망가뜨렸는데 통과 | **검사 자체를 의심한다** |
| 3 | 실패했는데 알림이 유실됨 | 알림 경로를 본다 |
| 4 | 전부 환경 실패 | 검사기를 본다. **백업에 대해서는 아무것도 모른다** |

2번이 가장 중요합니다. 검사가 전부 통과했는데 일부러 넣은 손상까지 통과했다면, 그 회차는 "백업이 멀쩡하다"가 아니라 "검사가 아무것도 안 보고 있다"입니다.

cron이나 systemd timer에 거는 형태는 이렇습니다.

```
*/30 * * * * /opt/lab/tools/verify-scheduler.sh || /opt/lab/tools/page-oncall.sh
```

**그래도 이 세션이 못 만든 것이 남습니다. 소유자입니다.** `page-oncall.sh`가 누구를 깨우는지, 그 사람이 안 받으면 다음이 누구인지는 코드 밖의 문제입니다. GitLab의 5 Whys 마지막 답이 "아무도 책임지지 않아서"였던 것이 이 자리입니다.

### 벽시계로 지점을 가리키면 어느 엔진에서든 샙니다

Oracle 절에서 `SET UNTIL TIME`이 초 단위이고 그 시각을 포함하지 않는다는 것을 봤습니다. **MySQL도 같습니다.** `mysqlbinlog --stop-datetime`으로 커밋과 같은 초를 지정해 재 봤습니다.

| 지정 | 결과 |
|---|---|
| 백업 시점 | 3행 |
| 백업 뒤 정상 쓰기 후 | 5행 |
| `--stop-datetime`을 그 커밋과 같은 초로 | **3행** |

**5행이 기대인데 3행, 곧 백업 시점 그대로입니다.** 그 초에 커밋된 두 행이 재적용에서 빠졌습니다. 에러는 안 납니다.

그래서 네 엔진이 같은 자리에서 샙니다.

| 엔진 | 벽시계 지정 | 안전한 대안 |
|---|---|---|
| MySQL | `--stop-datetime` (초) | `--stop-position` (이벤트 위치) |
| PostgreSQL | `recovery_target_time` (초) | `recovery_target_lsn` / `_xid` / `_name` |
| SQL Server | `STOPAT` (초 반올림) | `STOPATMARK` (트랜잭션 마크) |
| Oracle | `SET UNTIL TIME` (초, 미포함) | `SET UNTIL SCN` |

**오른쪽 열이 전부 "시간이 아닌 것"입니다.** 위치든 LSN이든 마크든 SCN이든, 공통점은 **그 지점이 로그 안의 한 항목을 정확히 가리킨다**는 것입니다. 벽시계는 그 항목들 사이의 간격보다 굵어서, 같은 초 안에 여러 커밋이 들어가면 어느 쪽까지인지를 못 정합니다.

이 글이 SQL Server 절에서 `STOPAT`을 `STOPATMARK`로 바꾼 것도, Oracle 절에서 SCN을 권하는 것도 같은 이유입니다. **엔진이 달라도 벽시계로 지점을 가리키면 경계에서 샙니다.**

### Oracle이 계속 백업 시점에 멈춘 이유

리뷰에서 "Oracle이 얇다"는 지적을 받았습니다. `UNTIL TIME`을 1회 돌린 수준인데 아카이브 모드 전환은 3회나 쟀으니 비중이 반대라는 것이고, 맞는 지적입니다.

판정 넷을 반복해서 재는 실험을 짰는데 **사고 직전 시점으로 복구해도 계속 백업 시점의 500행이 나왔습니다.** 기대는 700행입니다. 여섯 번 고치는 동안 아카이브 누락, 멀티테넌트 구조, PDB 개방 순서를 차례로 의심했고 전부 아니었습니다.

일곱 번째에 RMAN 출력을 직접 읽었습니다. 같은 조건에서 시점 지정 방식만 바꿔 맞대 봤습니다.

| 지정 방식 | 복구 결과 |
|---|---|
| `SET UNTIL SCN 3028403` | **700행** |
| `SET UNTIL TIME` (커밋과 같은 초) | **500행** |

**SCN으로 주면 되고 시각으로 주면 안 됩니다.**

`SET UNTIL TIME`은 초 단위이고 **그 시각을 포함하지 않습니다.** 스크립트가 200행을 넣은 직후 `SYSDATE`를 찍고 있었으니, 그 커밋이 일어난 바로 그 초를 가리키면서 그 커밋을 빼고 복구한 것입니다. 커밋과 시각 사이에 4초를 두자 700행이 돌아왔습니다.

**실무에서 위험한 이유가 분명합니다.** 사고 직전 시각을 초 단위로 적어 복구하면 그 초에 커밋된 것이 조용히 빠집니다. 에러는 안 납니다. 복구는 성공했다고 나오고 행 수만 다릅니다. 이 글이 계속 말한 유형입니다.

**그래서 사고 직전 지점은 시각이 아니라 SCN으로 잡는 편이 안전합니다.** SQL Server 편에서 `STOPAT` 대신 `STOPATMARK`로 바꾼 것과 같은 이유입니다. 그쪽도 초 단위 반올림 때문에 회차마다 결과가 갈렸습니다. **엔진이 달라도 벽시계로 지점을 가리키면 경계에서 샌다는 성질은 같습니다.**

### RESETLOGS로 열면 그 앞으로 못 돌아갑니다

같은 실험에서 확인한 것이 하나 더 있습니다. 사고 직전으로 복구해 `RESETLOGS`로 연 뒤 다시 그 시점으로 가려 하면 이렇게 막힙니다.

```
RMAN-20207: UNTIL TIME or RECOVERY WINDOW is before RESETLOGS time
```

`RESETLOGS`가 새 인카네이션을 만들고, 그 인카네이션의 시작보다 앞선 시점은 현재 계보에서 닿을 수 없기 때문입니다. `LIST INCARNATION OF DATABASE`로 보면 복구할 때마다 계보가 하나씩 늘어납니다.

**되돌리는 방법은 있습니다.** `RESET DATABASE TO INCARNATION <번호>`로 계보를 옮기면 `database reset to incarnation 6` 같은 확인이 찍힙니다. 다만 그 상태에서 복구가 이어지려면 **그 인카네이션에서 뜬 백업이 있어야 합니다.** 이 실험을 디버깅하며 `RESETLOGS`를 반복했더니 인카네이션이 일곱 개까지 쌓였고, 옛 계보의 백업이 없어 복구가 안 됐습니다.

그래서 실험을 회차마다 **현재 인카네이션에서 새로 백업**하도록 고쳤습니다. 실무로 옮기면 이렇습니다. **불완전 복구로 데이터베이스를 연 직후에는 전체 백업을 다시 떠야 합니다.** 안 그러면 그 시점 이후로 PITR 창이 비어 있습니다.

### 불완전 복구를 반복한 데이터베이스는 이렇게 막힙니다

위 실험을 돌리며 `RESETLOGS`를 여러 번 반복했더니 데이터베이스가 `MOUNTED`에서 안 열리는 상태가 됐습니다. 푸는 순서가 에러 두 개로 갈렸습니다.

**첫째, 그냥 열면 안 됩니다.**

```
ORA-01589: must use RESETLOGS or NORESETLOGS option for database open
```

불완전 복구 뒤라 평범한 `ALTER DATABASE OPEN`을 안 받습니다. 어느 쪽을 고를지 정해 줘야 합니다.

**둘째, `RESETLOGS`로 열어도 막힙니다.**

```
ORA-01190: control file or data file 1 is from before the last RESETLOGS
ORA-01110: data file 1: '/opt/oracle/oradata/FREE/system01.dbf'
```

**컨트롤 파일과 데이터 파일의 계보가 어긋난 것입니다.** 여기서 데이터 파일만 다시 복원해도 안 풀립니다. 컨트롤 파일이 최신 인카네이션을 가리키는데 데이터 파일이 옛 계보의 것이라, 둘을 같은 지점으로 맞춰야 합니다.

푸는 순서는 이렇습니다.

```sql
SHUTDOWN IMMEDIATE;
STARTUP NOMOUNT;
RESTORE CONTROLFILE FROM AUTOBACKUP;   -- 컨트롤 파일부터
ALTER DATABASE MOUNT;
RESTORE DATABASE;
RECOVER DATABASE;
ALTER DATABASE OPEN RESETLOGS;
```

**`RESTORE CONTROLFILE FROM AUTOBACKUP`이 첫 줄이라는 것이 핵심입니다.** 컨트롤 파일 자동 백업이 꺼져 있으면 이 경로 자체가 없습니다. 이 랩에서는 켜져 있어 살아났습니다.

실무로 옮기면 두 가지입니다. **컨트롤 파일 자동 백업을 켜 두어야 하고**, 불완전 복구를 시험 삼아 반복하는 환경에서는 매번 전체 백업을 다시 떠야 합니다. 앞 절에서 적은 "불완전 복구로 연 직후에는 전체 백업을 다시 뜬다"가 이 상태를 예방하는 조치이기도 합니다.

### 네 판정을 3회차로 돌렸습니다

앞선 시도가 유효 회차 1개를 못 넘긴 이유는 설계에 있었습니다. **판정마다 들어가는 `ALTER DATABASE OPEN RESETLOGS`가 인카네이션이라는 전역 상태를 바꿉니다.** 앞 판정이 만든 계보 때문에 다음 판정의 기준점이 사라집니다.

그래서 RMAN의 인카네이션 관리에 기대지 않기로 했습니다. **사고 직후 상태의 데이터 파일과 컨트롤 파일을 통째로 떠 두고 판정마다 그 스냅숏으로 되돌립니다.** 아카이브 로그는 별도 경로라 그대로 남습니다.

| 회차 | 1 사고 직전 | 2 사고 이후 | 3 `RESETLOGS` 뒤 | 4 스냅숏 복귀 |
|---|---|---|---|---|
| 1 | 통과 | 통과 | 막힘 `RMAN-20207` | 통과 |
| 2 | 통과 | 통과 | 막힘 `RMAN-20207` | 통과 |
| 3 | 통과 | 통과 | 막힘 `RMAN-20207` | 통과 |

**3회차 판정이 모두 같습니다.** 시간은 못 재도 이 넷은 인용할 수 있습니다.

판정 순서에도 이유가 있습니다. **3번은 스냅숏으로 되돌리기 전에 재야 합니다.** 1번이 방금 `RESETLOGS`로 연 그 상태에서 바로 재야 "연 뒤에는 그 앞으로 못 간다"를 보는 것이 되기 때문입니다. 그래서 1 → 3 → 2 → 4 순으로 돌립니다.

네 줄이 말하는 것을 정리하면 이렇습니다.

**1번.** 사고 직전 시각으로 복구하면 그 시점의 700행이 돌아옵니다. 단 그 시각이 커밋과 다른 초여야 합니다. 앞 절에서 본 그 조건입니다.

**2번.** 사고 이후 시각을 주면 사고까지 함께 복구됩니다. 500행입니다. **시점 복구는 "되돌리는" 것이 아니라 "지정한 지점까지 재생하는" 것이라서**, 지점을 잘못 잡으면 사고를 다시 재생합니다.

**3번.** `RESETLOGS`로 연 뒤 그 앞 시점으로 가려 하면 `RMAN-20207`로 막힙니다. 세 회차 모두 같은 에러입니다.

**4번.** 그 막힌 상태에서 `RESETLOGS` 전의 컨트롤 파일을 되돌리면 다시 갈 수 있습니다. **이것이 앞 절의 "불완전 복구로 연 직후에는 전체 백업을 다시 뜬다"가 필요한 이유입니다.** 그때의 컨트롤 파일이 없으면 4번이 안 됩니다.

## 세 줄 요약

**하나.** GitLab은 백업 다섯 겹이 전부 안 들었을 뿐 아니라 **WAL 아카이빙 자체를 안 쓰고 있었습니다.** 시점 복구를 할 재료가 없었고, 사고 뒤에야 도입을 검토 항목으로 올렸습니다. 이 글이 재현한 것이 그들이 그때 갖고 있지 않던 능력입니다.

**둘.** 네 엔진 모두 **벽시계로 지점을 가리키면 경계에서 샙니다.** MySQL `--stop-datetime`, PostgreSQL `recovery_target_time`, SQL Server `STOPAT`, Oracle `SET UNTIL TIME`이 전부 초 단위입니다. 같은 초에 커밋된 것이 에러 없이 빠집니다. 안전한 대안은 전부 시간이 아닌 것(위치·LSN·마크·SCN)입니다.

**셋.** 복원해 보지 않은 백업은 백업이 아닙니다. **통과만 하는 검사도 검사가 아닙니다.** 12절 파이프라인이 일부러 망가뜨린 백업을 함께 넣는 이유가 그것이고, 그 검사가 실제로 걸리는 것까지 봐야 그 검사를 믿을 수 있습니다.

## 못 한 것

- **아카이브 로그 모드 전환은 3회 반복이고 1,500행 기준입니다.** 회차 폭은 좁지만 두 방향 모두 대부분이 기동 시간이라, 데이터가 큰 인스턴스에서는 `SHUTDOWN IMMEDIATE`가 열린 트랜잭션의 롤백을 기다리므로 더 길어집니다.
- **Oracle 쪽은 시간을 안 잽니다.** ARM 에뮬레이션이라 절대값이 이 호스트의 것이 아닙니다. 네 판정은 3회차로 돌려 전부 같은 결과를 확인했습니다.
- **SQL Server는 판정만 3회 반복했습니다.** 세 회차가 같지만 ARM 에뮬레이션이라 시간 수치는 여전히 안 적습니다.
- **논리 대 물리의 교차점을 두 규모로만 좁혔습니다.** 10절에서 10만 행과 100만 행 사이에 있다는 것까지 재고 그 사이는 안 찍었습니다.
- **3절의 PITR 시나리오는 데이터 규모가 작습니다.** 사고 직전 1,500행, 덤프 40K, binlog 192K입니다. 10절에서 논리 대 물리는 100만 행까지 키워 봤지만, PITR 세 구간(백업·복원·binlog 적용)의 비율이 그 규모에서 어떻게 변하는지는 11절의 20만 행까지입니다.
- **초기 회차의 호스트 사양을 남기지 않았습니다.** `uname -srm`, `nproc`, `free -g`를 찍어 두지 않아 어느 장비에서 돌렸는지 확인되지 않습니다. 덤프 헤더와 도구 컨테이너 버전 문자열의 `aarch64`가 전부입니다. 지금 다시 찍어도 그 실행의 장비라는 보장이 없어 채우지 않았습니다. 반복 측정을 하면 그때 기록이 남으므로 이 항목은 반복 측정과 함께 해소됩니다. RTO를 주제로 하는 글에서 이건 구멍이고, 그래서 위 소요 시간을 다른 세션의 절대값과 비교하면 안 됩니다.
- **검증 파이프라인은 MySQL 하나입니다.** 주기 실행과 알림, 알림 경로 자체의 검증까지는 붙였고 실패 종류에 따라 종료 코드를 갈랐습니다. 남은 것은 소유자입니다. 누구를 깨우고 안 받으면 다음이 누구인지는 코드 밖입니다. PostgreSQL·SQL Server·Oracle 쪽 검증도 같은 형태로는 안 짰습니다.

---

재현에 쓴 compose 파일과 실행 출력 원문은 [incident-lab 저장소의 A23 세션](https://github.com/dj258255/incident-lab/tree/main/sessions/A23-backup-pitr)에 있습니다.

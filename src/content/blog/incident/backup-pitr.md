---
title: '백업은 있는데 복구가 안 된다, PITR을 가로막는 다섯 가지'
titleEn: "You Have Backups, You Just Cannot Restore: Five Things That Block PITR"
description: "2017년 1월 GitLab은 primary의 PostgreSQL 데이터 디렉터리를 지운 뒤에야 다섯 가지 백업·복제 수단이 전부 듣지 않는다는 것을 알았습니다. 사건 자체는 PostgreSQL 300GB 규모라 그대로 재현할 수 없어, MySQL 8.4.3에서 1,500행짜리 테이블로 같은 메커니즘만 축소 재현했습니다. mysqldump 풀백업(덤프 40K)과 binlog(192K)로 DROP TABLE 직전 시점까지 되돌리면, 백업만 복원했을 때는 1,000건이 돌아와 500건이 유실되고 binlog를 사고 직전 위치 176549까지 이어 붙이면 1,500건이 전부 돌아옵니다. 복구를 가로막는 함정은 다섯 가지인데 넷은 스크립트로 재현했고 하나는 실험을 만들다 직접 밟았습니다. 그중 셋은 에러 없이 실패합니다. 재적용이 조용히 스킵되는 것, binlog가 만료돼 PITR 창이 닫히는 것, docker exec에 -i를 빠뜨려 표준입력이 전달되지 않는 것입니다."
descriptionEn: "In January 2017 GitLab discovered that all five of its backup and replication mechanisms were broken only after an engineer wiped the primary PostgreSQL data directory. The incident itself involved roughly 300GB of PostgreSQL data and cannot be reproduced as such, so this session reproduces only the same mechanism at reduced scale on MySQL 8.4.3 with a 1,500-row table. Restoring a mysqldump full backup (40K) and replaying the binary log (192K) up to the moment just before a DROP TABLE recovers everything: the backup alone brings back 1,000 rows and loses 500, while replaying up to position 176549 brings all 1,500 rows back. Of the five traps that block recovery, four were reproduced by script and one was hit while building the experiment. Three of them raise no error at all: a replay that is silently skipped, an expired binlog that closes the PITR window, and a missing -i on docker exec that never delivers standard input."
date: 2026-07-29
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
> 출처: [GitLab.com Database Incident (2017-01-31)](https://about.gitlab.com/blog/2017/02/01/gitlab-dot-com-database-incident/) · [Postmortem](https://about.gitlab.com/blog/2017/02/10/postmortem-of-database-outage-of-january-31/) · [MySQL 8.4, PITR Using Event Positions](https://dev.mysql.com/doc/refman/8.4/en/point-in-time-recovery-positions.html) · [GTID Concepts](https://dev.mysql.com/doc/refman/8.4/en/replication-gtids-concepts.html) · [Google SRE Book, Data Integrity](https://sre.google/sre-book/data-integrity/)

## 1. 유명한 이유

2017년 1월 31일, GitLab 엔지니어가 복제가 밀린 상황을 수습하다 secondary인 줄 알고 primary의 PostgreSQL 데이터 디렉터리를 지웠습니다. 약 300GB가 사라졌습니다. 진짜 사건은 그다음입니다. 당시 라이브 문서에 이렇게 적혀 있습니다.

> "out of five backup/replication techniques deployed none are working reliably or set up in the first place."

다섯 가지가 각각 이렇게 실패했습니다.

| 수단 | 실패 이유 |
|---|---|
| pg_dump → S3 | 워커에 9.2 바이너리가 잡혀 9.6 서버를 덤프 시도. 에러로 중단돼 S3 버킷이 비어 있었음 |
| cron 실패 알림 | DMARC 미설정으로 수신 측에서 거부. 실패가 몇 달간 아무에게도 도달하지 않음 |
| Azure 디스크 스냅샷 | NFS 서버에만 설정, DB 서버에는 미설정 |
| LVM 스냅샷 | 24시간 주기이고 재해 복구용이 아님 |
| PostgreSQL 복제 | primary가 WAL 세그먼트를 secondary가 받기 전에 지워 중단 |

결과는 약 6시간 유실(프로젝트 5,000개, 댓글 5,000개, 계정 700개)과 18시간 다운타임입니다.

핵심은 "복구에 실패했다"가 아니라 **"백업이 있다고 믿고 있었다"**입니다. Google SRE Book이 같은 말을 다르게 적습니다.

> "No one really wants to make backups; what people really want are restores."

AWS Well-Architected의 REL09-BP04 안티패턴 목록은 GitLab 사고를 그대로 문장화한 수준입니다. "백업이 존재한다고 가정하는 것", "복원해 보되 데이터를 조회하거나 꺼내 보지 않는 것", "복원 시간이 RTO 안에 들어간다고 가정하는 것".

사건 자체는 PostgreSQL 300GB 규모라 그대로 재현할 수 없습니다. 이 세션은 엔진도 규모도 다른 MySQL에서 1,500행짜리 테이블로 같은 메커니즘만 축소 재현했습니다. 시점 복구(PITR)를 실제로 수행하고, 복구를 가로막는 함정 다섯 가지를 다룹니다. 넷은 스크립트로 재현했고 하나(`docker exec`의 `-i` 누락)는 실험을 만들다 밟은 것입니다. **그중 셋은 이 세션을 만들면서 제가 직접 밟았습니다.**

## 2. 재현

### 환경

| 항목 | 값 |
|---|---|
| 원본 | MySQL 8.4.3, `log-bin`, `gtid-mode=ON`, `sync_binlog=1`, `innodb_flush_log_at_trx_commit=1` |
| 복구 대상 | MySQL 8.4.3 별도 인스턴스 (사고 서버에 되돌리지 않는다) |
| 도구 | percona-server:8.4 컨테이너 (`mysqlbinlog` 확보용, 함정 2 참고) |
| 데이터 규모 | 사고 직전 1,500행(T0 백업 시점 1,000행 + 그 뒤 500행). 덤프 40K, 이어 붙인 binlog 192K |
| 컨테이너 자원 한도 | 걸지 않았습니다. compose에 `cpus`도 `mem_limit`도 없습니다 |
| 호스트 사양 | **기록하지 않았습니다.** `uname -srm`, `nproc`, `free -g`를 남기지 않아 어느 장비였는지 확인되지 않습니다. 로그에 남은 단서는 덤프 헤더와 도구 컨테이너 버전 문자열의 `aarch64`뿐입니다 |
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

사고 직전의 정답은 1,500건입니다. T0 백업 시점에 1,000행이었고 그 뒤 500건이 더 들어왔습니다. 백업만 되돌리면 그 500건이 통째로 사라집니다. **백업 주기가 곧 RPO 상한**이라는 말이 이 500건입니다. Keepthescore가 2020년에 겪은 것이 정확히 이 구조로, 일 1회 백업 덕에 30분 만에 복구했지만 7시간치는 영원히 사라졌습니다.

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

**RTO 분해**: 이 실행에서 백업 0.075초, 덤프 복원 0.078초, binlog 추출·적용 0.947초입니다. 로그 원문은 각각 `.075473000` / `.077972000` / `.947246000`초입니다. 대상은 1,500행짜리 테이블 하나이고 덤프가 40K, 이어 붙인 binlog가 192K입니다. 이 규모에서는 복구 시간의 대부분이 binlog 구간을 뽑아 재적용하는 데 들어갔습니다. 백업 주기를 늘리면 그만큼 이어 붙일 binlog가 늘어나므로 RPO와 RTO는 백업 주기 하나로 맞물립니다. 다만 이 비율이 규모를 키워도 유지되는지는 재지 않았습니다. 세 구간 모두 1회 실행값이라 분산도 모릅니다.

## 4. 복구를 가로막는 다섯 가지

![복구를 막는 두 가지](/uploads/incident/backup-pitr/fig-blocked.png)

### 함정 1. 사고 난 서버에 덤프를 되돌리면 첫 줄에서 막힌다

```console
$ grep -m1 "GTID_PURGED" results/dump/full.sql
SET @@GLOBAL.GTID_PURGED=/*!80000 '+'*/ '2695cd5d-8b13-11f1-bd5c-0242ac190002:1-5';

$ docker exec -i a23-mysql mysql -uroot -plab < full.sql     # 원본 서버에 복원 시도
ERROR 3546 (HY000) at line 24: @@GLOBAL.GTID_PURGED cannot be changed: the added gtid set must not overlap with @@GLOBAL.GTID_EXECUTED
```

`mysqldump`가 GTID 환경에서 기본으로 넣는 `SET @@GLOBAL.GTID_PURGED`가 이미 실행된 GTID와 겹쳐 복원 전체가 중단됩니다. 사고 복구는 대개 원본 서버에서 하려고 하므로, PITR 문서만 읽고 따라가면 여기서 막힙니다. 해법은 새 인스턴스에 복원하거나(권장) `--set-gtid-purged=OFF`로 다시 뜨는 것입니다.

### 함정 2. 공식 이미지에 `mysqlbinlog`가 없다

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

### 함정 3. 재적용이 조용히 스킵된다

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

### 함정 4. binlog가 만료되면 PITR 창이 닫힌다

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

### 함정 5. 파이프가 컨테이너에 닿지 않는다

`docker exec`에 `-i`를 빠뜨리면 표준입력이 전달되지 않습니다. 그런데 **에러가 나지 않습니다.** 500건을 넣는 스크립트가 조용히 0건을 넣었고, 그 뒤 측정이 전부 어긋났습니다. 복구 스크립트를 자동화할 때 "실행됐다"와 "적용됐다"를 구분해 검증해야 하는 이유입니다.

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
| 조용한 실패 | GTID 겹침 시 재적용 스킵(함정 3) | `restore_command`가 성공을 가장하면 잘못된 지점에서 멈춤 |

마지막 줄에서 두 엔진이 같은 방식으로 위험합니다. PostgreSQL 문서가 `archive_command`에 대해 없는 파일 요청에는 반드시 0이 아닌 값을 반환해야 한다고 못 박는 이유이고, 이 실험의 compose에도 `test ! -f`를 앞에 둔 이유입니다.

## 6. SQL Server로 한 번 더

앞서 이 자리에 "공식 이미지가 없거나 라이선스가 걸려 이 랩에서 실행할 수 없었다"고 적었습니다. **틀렸습니다.** SQL Server Developer 에디션은 `mcr.microsoft.com/mssql/server`로 무료 공개돼 있고 `STOPAT` 시점 복구가 그 에디션에 들어 있습니다. 재봤습니다.

SQL Server 2022 (16.0.4265.3), Developer 에디션, 같은 1,500행 규모입니다. Apple Silicon에는 ARM 이미지가 없어 에뮬레이션으로 돌고 메모리를 6GB 줘야 떴습니다.

### 복구 모델이 SIMPLE이면 시점 복구가 성립하지 않습니다

```console
1> BACKUP LOG spoon TO DISK='/var/opt/mssql/backup/log_simple.trn' WITH INIT
Msg 4208, Level 16, State 1
The statement BACKUP LOG is not allowed while the recovery model is SIMPLE.
Use BACKUP DATABASE or change the recovery model using ALTER DATABASE.
```

이것이 MySQL과 PostgreSQL에 없는 관문입니다. MySQL은 `log-bin`이 켜져 있으면 binlog가 나오고, PostgreSQL은 `archive_mode=on`이면 WAL이 보관됩니다. SQL Server는 **데이터베이스마다 복구 모델이 따로 있고**, `SIMPLE`이면 로그 백업 자체가 거부됩니다. 새 DB는 `model` 데이터베이스의 값을 물려받으므로, 그 값이 `SIMPLE`인 인스턴스에서는 만든 DB가 전부 시점 복구를 못 합니다. **백업 스크립트가 있어도 이 값 하나로 창이 닫힙니다.**

### `NORECOVERY`를 빠뜨리면 로그를 이어 붙일 수 없습니다

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
| 안 열리는 함정 | 없음 | 목표 도달 후 `pause` | `STOPAT`이 로그 끝보다 뒤면 `RESTORING` |

**세 엔진이 같은 사고를 다른 자리에서 막습니다.** 절차서를 한 엔진에서 쓰고 다른 엔진에 옮기면 그 자리마다 다시 걸립니다.

Oracle은 여전히 다루지 않았습니다. Oracle Database Free 23ai 컨테이너가 공개돼 있어 실행 자체는 가능해 보이는데, `RMAN`의 `UNTIL TIME` 실습에 아카이브 로그 모드 전환과 별도 구성이 필요해 이번에는 넣지 않았습니다. **"라이선스 때문에 불가능"이 아니라 "아직 안 했다"가 정확한 표현입니다.**

## 7. Oracle 대조

마지막 하나가 Oracle입니다. 앞에서 "라이선스 때문이 아니라 아직 안 했다"고 적어 둔 자리입니다. Database Free 23ai가 무료 공개돼 있어 실행했습니다. Oracle AI Database 26ai Free (23.26.2.0.0)입니다.

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

### `RESETLOGS`가 인케네이션을 만듭니다

복구를 마치고 `RESETLOGS` 로 열면 데이터베이스의 계보가 갈립니다.

```console
SQL> SELECT incarnation#, status, resetlogs_change# FROM v$database_incarnation;
    1 PARENT     1
    2 PARENT     1924245
    3 PARENT     2953770
    4 CURRENT    2956222
```

네 번 열렸고 지금은 4번입니다. **그 시점 이후의 옛 아카이브 로그는 새 인케네이션에
적용할 수 없습니다.** 되돌아가려면 `RESET DATABASE TO INCARNATION` 을 먼저 해야 합니다.

MySQL·PostgreSQL·SQL Server 에는 이 개념이 없습니다. **복구를 여러 번 시도할 때
"어느 복구본에서 갈라져 나온 것인가"를 데이터베이스가 스스로 관리하는 것이 Oracle 쪽
특징이고, 그만큼 관리 대상이 하나 더 있습니다.**

### 목표 시각의 리두가 아직 아카이브되지 않았으면 그 앞까지만 갑니다

처음 실행에서 복구 후 행 수가 1,000 이었습니다. 목표 시각이 사고 직전인데 백업 시점까지만
되돌아간 것입니다. 원인은 그 시점의 리두가 **아직 현재 온라인 로그에만 있고 아카이브되지
않은 것**이었습니다. 목표 시각을 잡기 전에 `ALTER SYSTEM ARCHIVE LOG CURRENT` 를 넣어
고쳤습니다.

이것은 PostgreSQL 의 `archive_timeout` 과 같은 자리입니다. **"방금 커밋했으니 복구할 수
있다"가 아니라 "그 리두가 아카이브로 떨어졌으니 복구할 수 있다"입니다.**

### 아카이브 로그 모드 전환은 밟지 못했습니다

이 이미지는 `ARCHIVELOG` 로 출고됩니다. 끄고 켜는 과정을 재현하지 못했습니다. 다만 다른
엔진과 갈리는 자리는 남습니다. Oracle 은 켜려면 데이터베이스를 `MOUNT` 상태로 내렸다
올려야 하고 그동안 닫혀 있습니다. PostgreSQL 은 `archive_mode` 를 켜고 재기동하면 되고,
MySQL 은 `log-bin` 을 켜고 재기동하면 됩니다. **`MOUNT` 라는 중간 상태가 하나 더 있는
것이 Oracle 쪽 절차의 차이입니다.**

### 네 엔진 대조

| | MySQL 8.4 | PostgreSQL 17.5 | SQL Server 2022 | Oracle 26ai |
|---|---|---|---|---|
| 복구 재료 | 풀 덤프 + binlog | 베이스 백업 + WAL | 전체 백업 + 로그 백업 | RMAN 백업 + 아카이브 로그 |
| 로그 보관 전제 | `log-bin` | `archive_mode=on` | DB별 복구 모델 `FULL` | `ARCHIVELOG` 모드 |
| 전제를 켜는 비용 | 재기동 | 재기동 | `ALTER DATABASE` (온라인) | 재기동 + `MOUNT` 단계 |
| 경계 지정 | `--stop-position`, `--stop-datetime` | `recovery_target_*` | `STOPAT` | `SET UNTIL TIME` |
| 경계 포함 | 그 위치 직전까지 | `inclusive` 로 선택 | 고정(그 시각까지 포함) | 그 시각 직전까지 |
| 복구본의 계보 | 없음 | 타임라인(`.history`) | 없음 | **인케네이션** |
| 안 열리는 함정 | 없음 | 목표 도달 후 `pause` | `STOPAT` 이 로그 끝보다 뒤면 `RESTORING` | 리두가 아카이브 안 됐으면 그 앞까지만 |

**네 엔진이 같은 사고를 네 자리에서 다르게 막습니다.** 절차서를 한 엔진에서 쓰고 다른
엔진에 옮기면 그 자리마다 다시 걸립니다.
## 8. 해소: 백업을 믿지 않는 절차

실험에서 나온 것을 운영 체크리스트로 정리하면 이렇습니다.

| 항목 | 확인 방법 |
|---|---|
| 백업이 비어 있지 않은가 | 파일 크기 임계치 + 종료 코드 확인. `set -o pipefail` 없이 파이프 쓰면 실패를 놓친다 |
| 복원이 되는가 | 별도 인스턴스에 정기 복원. GitLab의 pg_dump 버전 불일치는 이 단계에서 즉시 잡혔을 문제다 |
| 복원된 데이터가 맞는가 | 행 수·체크섬 대조. 복원 성공과 데이터 정합은 다르다(함정 3) |
| binlog가 백업 대상인가 | 풀백업만 있으면 RPO는 백업 주기다. binlog가 있어야 그 사이를 메운다 |
| binlog 만료가 백업 주기보다 긴가 | `binlog_expire_logs_seconds` vs 백업 보존 기간 |
| 복구 도구가 그 환경에 있는가 | 사고 당일에 확인하면 늦다 |
| 복구 시간이 RTO 안인가 | 리허설에서 실측. 추정하지 않는다 |

## 9. 예상과 달랐던 점

### 함정 셋을 제가 직접 밟았습니다

이 세션의 실험 설계는 조사에서 나왔지만, **함정 1·2·5는 스크립트를 짜다가 실제로 막혀서 발견한 것들**입니다. GTID 겹침으로 복원이 중단됐고, `mysqlbinlog`가 없어 도구 컨테이너를 추가했고, `-i` 누락으로 데이터가 조용히 안 들어갔습니다. 재현 랩을 만드는 사람도 같은 자리에서 막힌다는 뜻이고, 실전에서 처음 해보면 더할 것입니다. **복구 리허설을 해봐야 하는 이유가 이것 자체입니다.**

### GTID 경고가 PITR 문서에 없습니다

MySQL의 PITR 문서(9.5절)에는 GTID 관련 경고가 한 줄도 없습니다. 조용한 스킵은 복제 챕터에, `--set-gtid-purged` 문제는 mysqldump 옵션 설명에 흩어져 있습니다. PITR 문서만 읽고 따라 하면 두 함정을 그대로 만나는 구조입니다.

### 같은 함정이 엔진을 건너 반복됩니다

5절에서 PostgreSQL을 붙이고 나서야 보인 것인데, 두 엔진의 가장 위험한 실패가 같은 모양입니다. MySQL은 GTID가 겹치면 재적용을 조용히 스킵하고, PostgreSQL은 `restore_command`가 성공을 가장하면 잘못된 지점에서 조용히 멈춥니다. 엔진을 바꿔도 "성공처럼 보이는 실패"라는 형태는 남습니다.

### 실패 모드가 전부 조용합니다

다섯 중 셋(재적용 스킵, binlog 만료, `-i` 누락)이 에러 없이 실패합니다. 나머지 둘(GTID 겹침, 도구 부재)은 시끄럽게 실패하는데, 역설적으로 그쪽이 낫습니다. **복구에서 가장 위험한 것은 실패가 아니라 성공처럼 보이는 실패입니다.** GitLab 사고에서 cron 실패 알림이 DMARC로 막혀 몇 달간 아무도 몰랐던 것과 같은 종류입니다.

## 못 한 것

- **Oracle의 아카이브 로그 모드 전환을 밟지 못했습니다.** 이미지가 `ARCHIVELOG`로 출고됩니다.
- **Oracle 쪽도 1회 실행입니다.** 7절의 값에 반복 측정이 없습니다.
- **SQL Server 쪽도 조건마다 1회씩입니다.** 6절의 값에 반복 측정이 없고, ARM 에뮬레이션으로 돌았으므로 시간 관련 수치는 아예 적지 않았습니다.
- **논리·물리 백업의 복원 시간을 비교하지 않았습니다.** 벤더 문서가 백업 속도만 명시하고 복원 속도 비교는 없어서, 직접 재면 독자적 기여가 되는 자리입니다.
- **데이터 규모가 작습니다.** 사고 직전 1,500행, 덤프 40K, binlog 192K입니다. RTO 절대값은 이 규모에서만 성립하고, 규모를 키웠을 때 세 구간의 비율이 어떻게 변하는지는 재지 않았습니다.
- **호스트 사양을 남기지 않았습니다.** `uname -srm`, `nproc`, `free -g`를 찍어 두지 않아 어느 장비에서 돌렸는지 확인되지 않습니다. 덤프 헤더와 도구 컨테이너 버전 문자열의 `aarch64`가 전부입니다. 지금 다시 찍어도 그 실행의 장비라는 보장이 없어 채우지 않았습니다. 반복 측정을 하면 그때 기록이 남으므로 이 항목은 반복 측정과 함께 해소됩니다. RTO를 주제로 하는 글에서 이건 구멍이고, 그래서 위 소요 시간을 다른 세션의 절대값과 비교하면 안 됩니다.
- **MySQL 쪽 세 구간은 여전히 1회 실행값입니다.** 5절의 PostgreSQL 조건만 4회 반복했습니다.
- **백업 검증 파이프라인을 구현하지 않았습니다.** 체크리스트로 적었을 뿐, 자동 복원 리허설을 실제로 돌리는 것은 다음 과제입니다.

---

재현에 쓴 compose 파일과 실행 출력 원문은 [incident-lab 저장소의 A23 세션](https://github.com/dj258255/incident-lab/tree/main/sessions/A23-backup-pitr)에 있습니다.

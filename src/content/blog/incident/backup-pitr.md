---
title: '백업은 있는데 복구가 안 된다, 성공처럼 보이는 실패들'
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

## 무엇을 만들었고 무엇을 확인했나
**만든 것.** MySQL·PostgreSQL·SQL Server·Oracle 네 엔진에서 시점 복구를 직접 수행하는 랩과, 백업을 매번 되살려 보고 실패하면 알리는 검증 파이프라인입니다. 스크립트와 결과는 [incident-lab](https://github.com/dj258255/incident-lab) 의 `sessions/A23-backup-pitr`에 있습니다.

**왜 했나.** GitLab이 2017년에 데이터 디렉터리를 지우고 백업 다섯 겹이 전부 안 들었던 사고를 보고, 왜 복구가 그렇게 어려웠는지 직접 밟아 보려고 했습니다.

**검증한 것 넷.**

| 질문 | 답 | 근거 |
|---|---|---|
| GitLab은 왜 사고 직전으로 못 돌아갔나 | WAL 아카이빙을 안 쓰고 있었습니다. 시점 복구를 할 재료가 없었고 사고 뒤에야 도입을 검토 항목(#1097)으로 올렸습니다 | 사후 분석 원문 |
| 사고 직전 시각을 정확히 적으면 되나 | 안 됩니다. 네 엔진 모두 벽시계가 초 단위라 그 초에 커밋된 것이 에러 없이 빠집니다 | [엔진별 실측](#3-벽시계로-지점을-가리키면-어느-엔진에서든-샙니다) |
| 논리와 물리 중 무엇이 빠른가 | 규모가 정합니다. 교차점이 50만과 100만 행 사이이고 물리 쪽 고정비 3초가 그 위치를 정합니다 | [네 규모 측정](#4-논리와-물리-교차점은-규모가-정합니다) |
| 백업 검사를 만들면 끝인가 | 아닙니다. 일부러 망가뜨린 백업을 함께 넣어야 그 검사가 실제로 걸리는지 알 수 있습니다 | [파이프라인](#5-백업을-믿지-않는-파이프라인) |

**얻은 것.** 이 랩에서 잰 절대 시간은 인용할 수 없습니다. 규모가 작고 Oracle·SQL Server는 ARM 에뮬레이션입니다. 대신 **판정과 경계 규칙은 규모를 안 탑니다.** 400만 행까지 올려도 복원 판정이 같았고, 그것이 작은 랩에서 인용할 수 있는 것과 없는 것을 가릅니다.

아래는 그 넷을 만들면서 밟은 함정과 실패의 기록입니다. 표의 근거 절로 바로 가셔도 됩니다.

## 1. 왜 이 사고인가

2017년 1월 31일(UTC), GitLab 엔지니어가 복제가 밀린 상황을 수습하다 secondary인 줄 알고 primary의 PostgreSQL 데이터 디렉터리를 지웠습니다. 약 300GB가 사라졌습니다. 진짜 사건은 그다음입니다.

> "out of five backup/replication techniques deployed none are working reliably or set up in the first place."

다섯 겹이 각각 왜 안 들었는지는 [전체 기록](https://github.com/dj258255/incident-lab/blob/main/sessions/A23-backup-pitr/README.md)에 표로 정리했습니다. 이 글이 다루는 것은 그 앞에 있는 한 줄입니다.

> "As GitLab.com was not using WAL archiving, the secondary had to be re-synchronised manually."

**GitLab.com은 WAL 아카이빙을 쓰지 않았습니다.** 곧 시점 복구를 할 재료가 애초에 없었습니다. 백업 다섯 겹이 전부 안 들었다는 이야기의 앞에, 그 다섯 겹 중 어느 것도 "사고 직전 시점으로 되돌린다"를 할 수 없는 종류였다는 사실이 있습니다. 남은 선택지가 우연히 여섯 시간 전에 손으로 찍어 둔 스냅숏이었던 이유입니다.

그래서 이 세션의 질문은 "백업을 잘 뜨는 법"이 아닙니다. **시점 복구가 실제로 되는지, 안 될 때 어떻게 안 되는지**입니다.

## 2. 무엇을 만들었나

MySQL 8.4.3에서 1,500행짜리 테이블로 같은 메커니즘을 축소 재현했습니다.

```
T0     풀백업 (mysqldump --single-transaction --source-data=2)
T0~T1  후원 500건이 더 들어온다 (백업에 없는 데이터)
T1     운영자가 실수로 DROP TABLE sponsor
T1~    사고를 모른 채 다른 테이블에 쓰기가 계속된다
```

풀 덤프만 되돌리면 1,000행이고 500행이 사라집니다. binlog를 사고 직전 위치까지 이어 붙이면 1,500행이 전부 돌아옵니다. **시점 복구는 실제로 듣습니다.** 문제는 거기까지 가는 길에 있습니다.

같은 시나리오를 PostgreSQL 17.5, SQL Server 2022, Oracle 26ai에서 다시 돌렸습니다. 엔진마다 재료도 전제도 다른데, 네 번 하고 나서야 보이는 것이 있었습니다. 3절이 그것입니다.

## 3. 벽시계로 지점을 가리키면 어느 엔진에서든 샙니다

Oracle을 재다가 잡은 것이 네 엔진 공통의 성질이었습니다. 이 절은 그 하나를 다룹니다.

### 시작은 Oracle이 계속 백업 시점에 멈춘 것이었습니다

Oracle 판정 넷을 반복해서 재는 실험을 짰는데 **사고 직전 시점으로 복구해도 계속 백업 시점의 500행이 나왔습니다.** 기대는 700행입니다. 여섯 번 고치는 동안 아카이브 누락, 멀티테넌트 구조, PDB 개방 순서를 차례로 의심했고 전부 아니었습니다.

일곱 번째에 RMAN 출력을 직접 읽었습니다. 같은 조건에서 시점 지정 방식만 바꿔 맞대 봤습니다.

| 지정 방식 | 복구 결과 |
|---|---|
| `SET UNTIL SCN 3028403` | 700행 |
| `SET UNTIL TIME` (커밋과 같은 초) | 500행 |

SCN으로 주면 되고 시각으로 주면 안 됩니다.

`SET UNTIL TIME`은 초 단위이고 **그 시각을 포함하지 않습니다.** 스크립트가 200행을 넣은 직후 `SYSDATE`를 찍고 있었으니, 그 커밋이 일어난 바로 그 초를 가리키면서 그 커밋을 빼고 복구한 것입니다. 커밋과 시각 사이에 4초를 두자 700행이 돌아왔습니다.

**실무에서 위험한 이유가 분명합니다.** 사고 직전 시각을 초 단위로 적어 복구하면 그 초에 커밋된 것이 조용히 빠집니다. 에러는 안 납니다. 복구는 성공했다고 나오고 행 수만 다릅니다. 이 세션이 계속 만난 유형입니다.

**그래서 사고 직전 지점은 시각이 아니라 SCN으로 잡는 편이 안전합니다.** SQL Server에서 `STOPAT` 대신 `STOPATMARK`로 바꾼 것과 같은 이유입니다. 그쪽도 초 단위 반올림 때문에 회차마다 결과가 갈렸습니다. **엔진이 달라도 벽시계로 지점을 가리키면 경계에서 샌다는 성질은 같습니다.**

### MySQL도 같은 자리에서 샙니다

**MySQL도 같습니다.** 경계 규칙만 보려고 3행짜리 마이크로 실험을 따로 만들었습니다. 이 랩의 다른 MySQL 측정과 스케일이 완전히 다르고, 여기서 볼 것은 시간이 아니라 **같은 초의 커밋이 들어오는가 빠지는가** 하나입니다. 1회 실행입니다.

| 지정 | 결과 |
|---|---|
| 백업 시점 | 3행 |
| 백업 뒤 정상 쓰기 후 | 5행 |
| `--stop-datetime`을 그 커밋과 같은 초로 | 3행 |

5행이 기대인데 3행, 곧 백업 시점 그대로입니다. 그 초에 커밋된 두 행이 재적용에서 빠졌고 에러는 안 났습니다.

네 엔진이 같은 자리에서 샙니다.

| 엔진 | 벽시계 지정 | 안전한 대안 |
|---|---|---|
| MySQL | `--stop-datetime` (초) | `--stop-position` (이벤트 위치) |
| PostgreSQL | `recovery_target_time` (초) | `recovery_target_lsn` / `_xid` / `_name` |
| SQL Server | `STOPAT` (초 반올림) | `STOPATMARK` (트랜잭션 마크) |
| Oracle | `SET UNTIL TIME` (초, 미포함) | `SET UNTIL SCN` |

오른쪽 열의 공통점은 하나입니다. 위치든 LSN이든 마크든 SCN이든 **로그 안의 한 항목을 정확히 가리킵니다.** 벽시계는 그 항목들 사이의 간격보다 굵어서, 같은 초 안에 여러 커밋이 들어가면 어디까지인지를 못 정합니다.

이 랩이 SQL Server에서 `STOPATMARK`로 옮기고 Oracle에서 SCN을 권하는 것도 같은 이유입니다. **엔진이 달라도 벽시계로 지점을 가리키면 경계에서 샙니다.**

### 네 엔진 대조

| | MySQL 8.4 | PostgreSQL 17.5 | SQL Server 2022 | Oracle 26ai |
|---|---|---|---|---|
| 복구 재료 | 풀 덤프 + binlog | 베이스 백업 + WAL | 전체 백업 + 로그 백업 | RMAN 백업 + 아카이브 로그 |
| 로그 보관 전제 | `log-bin` | `archive_mode=on` | DB별 복구 모델 `FULL` | `ARCHIVELOG` 모드 |
| 전제를 켜는 비용 | 재기동 | 재기동 | `ALTER DATABASE` (온라인) | 재기동 + `MOUNT` 단계 |
| 경계 지정 | `--stop-position`, `--stop-datetime` | `recovery_target_*` | `STOPAT` | `SET UNTIL TIME` |
| 경계 포함 | 그 위치 직전까지 | `inclusive`로 선택 | 고정(그 시각까지 포함) | 그 시각 직전까지 |
| 복구본의 계보 | 없음 | 타임라인(`.history`) | 없음 | 인카네이션 |
| 안 열리는 함정 | 없음 | 목표 도달 후 `pause` | `STOPAT`이 로그 끝보다 뒤면 `RESTORING` | `RESETLOGS` 뒤 옛 시점은 `RMAN-20207` |
| 벽시계 경계 | `--stop-datetime`도 초 단위, 같은 초 커밋은 빠짐 | `recovery_target_time`도 같은 성질 | `STOPAT` 초 단위 반올림 | `SET UNTIL TIME`은 초 단위이고 그 시각 미포함 |
| 목표 시점에 못 닿는 경우 | binlog 만료 | 아카이브 WAL 유실 | 로그 백업 누락 | 리두가 아직 아카이브 안 됨 |

**네 엔진이 같은 사고를 네 자리에서 다르게 막습니다.**

## 4. 논리와 물리, 교차점은 규모가 정합니다

복구 시간을 줄이려면 백업 방식부터 골라야 합니다. `mysqldump`는 복원할 때 `INSERT`를 행마다 다시 실행하고, 물리 백업은 데이터 파일을 그대로 복사합니다. 어느 쪽이 빠른지는 조건에 따라 갈립니다.

10만 행과 100만 행만 재면 교차점이 그 사이라는 것까지밖에 안 나옵니다. 네 규모로 다시 쟀습니다.

| 행 수 | 논리 복원 | 물리 복원 | 빠른 쪽 |
|---|---|---|---|
| 100,000 | 0.68초 | 2.95초 | 논리 |
| 250,000 | 1.40초 | 2.94초 | 논리 |
| 500,000 | 2.45초 | 3.15초 | 논리 |
| 1,000,000 | 4.53초 | 3.12초 | 물리 |

**교차점이 50만과 100만 사이입니다.** 물리 복원은 규모가 열 배 늘어도 2.95초에서 3.12초로 거의 안 움직입니다. 파일을 복사하고 서버를 띄우는 고정비가 대부분이라 그렇습니다. 논리 복원은 0.68초에서 4.53초로 6.7배 늘어납니다. 행마다 `INSERT`를 실행하니 행 수에 비례합니다.

**그래서 교차점의 위치를 정하는 것은 그 고정비입니다.** 이 컨테이너에서 3초 남짓이고, 기동이 빠른 환경이라면 교차점이 왼쪽으로 옮겨 갑니다.

## 5. 백업을 믿지 않는 파이프라인

실험에서 나온 것을 운영 체크리스트로 정리하면 이렇습니다.

| 항목 | 확인 방법 |
|---|---|
| 시점 복구가 가능한 구성인가 | MySQL은 `log_bin`, PostgreSQL은 `archive_mode=on`과 `archive_command` 성공. 이것이 없으면 아래는 전부 전체 백업 시점으로 돌아가기에 대한 검사다 |
| 백업이 비어 있지 않은가 | 파일 크기 임계치 + 종료 코드 확인. `set -o pipefail` 없이 파이프 쓰면 실패를 놓친다 |
| 복원이 되는가 | 별도 인스턴스에 정기 복원. GitLab의 pg_dump 버전 불일치는 이 단계에서 즉시 잡혔을 문제다 |
| 복원된 데이터가 맞는가 | 행 수·체크섬 대조. 복원 성공과 데이터 정합은 다르다 |
| binlog가 백업 대상인가 | 풀백업만 있으면 RPO는 백업 주기다. binlog가 있어야 그 사이를 메운다 |
| binlog 만료가 백업 주기보다 긴가 | `binlog_expire_logs_seconds` vs 백업 보존 기간 |
| 복구 도구가 그 환경에 있는가 | 사고 당일에 확인하면 늦다 |
| 복구 시간이 RTO 안인가 | 리허설에서 실측. 추정하지 않는다 |

이 여덟 항목을 실제로 도는 스크립트로 만들었습니다. 체크리스트는 지키는 사람이 있어야 지켜지고, 사람은 사고 당일에만 확인합니다.

핵심은 하나입니다. **백업을 믿지 않고 매번 되살려 봅니다.** 그리고 **일부러 망가뜨린 백업을 같이 넣습니다.** 통과만 시키는 검사는 아무것도 안 지키고 있는 것이라서, 각 검사가 실제로 걸리는지를 봐야 그 검사를 믿을 수 있습니다.

20만 행에 정상 덤프 하나와 망가뜨린 덤프 셋을 넣었습니다. 빈 파일, 중간에 잘린 것, `INSERT`만 주석 처리해 스키마만 남긴 것입니다.

| 백업 | 크기 검사 | 복원 실행 | 데이터 대조 |
|---|---|---|---|
| 정상 | 통과 | 통과 | 통과 |
| 빈 파일 | 걸림 | 통과 | 걸림 |
| 중간에 잘림 | 걸림 | 걸림 | 걸림 |
| 스키마만 | 통과 | 통과 | 걸림 |

**이 파이프라인은 첫 검사에서 걸려도 멈추지 않고 세 검사를 전부 돌립니다.** 그래야 어느 검사가 무엇을 잡는지 표로 볼 수 있습니다. 운영에 걸 때는 첫 실패에서 끊는 편이 자원을 아끼지만, 검사 자체를 검증하는 이 자리에서는 전부 돌려야 합니다.

**세 검사가 서로를 대신하지 못합니다.** 빈 파일과 스키마만 있는 덤프는 복원 실행을 에러 없이 통과합니다. 복원이 성공했다는 것과 데이터가 있다는 것은 다릅니다. 그리고 스키마만 남긴 덤프는 크기 검사도 통과합니다. `INSERT`를 주석으로 바꾼 것이라 바이트 수가 거의 그대로이기 때문입니다.

그래서 **데이터 대조가 마지막 방어선입니다.** 이때 행 수를 "0보다 큰가"로 보면 안 되고 원본과 정확히 같은지 봐야 합니다. 이 랩이 그 자리를 밟았습니다. GTID 충돌로 복원이 중간에 멈췄는데 종료 코드가 0 이라 "복원 0.06초"라는 아주 좋아 보이는 값이 남았습니다.

나머지 항목도 이 랩이 실제로 걸린 자리를 그대로 검사합니다. 복원 대상 컨테이너에 `mysqlbinlog`가 있는지 보는 항목은 이 랩이 실제로 막혔던 자리에서 온 것이고, 이 실행에서도 **걸립니다.** `mysql:8.4` 이미지에 그 도구가 없기 때문입니다. 사고 당일에 알면 늦습니다.

마지막 항목은 리허설 전체 소요가 RTO 예산 안인지입니다. 이 실행은 5.4초였고, **추정이 아니라 방금 실제로 되살려 본 시간입니다.**


### 조건이 안 섰는데 검사가 잘 걸리는 것처럼 보였습니다

처음 돌렸을 때 검사가 전부 "걸림"으로 나왔습니다. 파이프라인이 아주 잘 도는 것처럼 보였습니다. 그런데 원본이 0행이었습니다. 20만 행을 재귀 CTE로 넣는데 `cte_max_recursion_depth` 기본값이 1000 이라 막힌 것입니다. 원본이 비었으니 복원한 것과 안 맞는 게 당연하고, 그래서 모든 대조가 걸렸습니다. **"검사가 잘 걸린다"와 "조건이 안 섰다"가 같은 모양이었습니다.** 적재 직후에 행 수가 기대와 정확히 같은지 확인하고 아니면 그 자리에서 멈추도록 고쳤습니다.

### 주기 실행과 알림까지 붙였습니다

위 파이프라인은 1회 실행이고 스케줄러도 알림도 없었습니다. 그러면 시연이지 해결이 아닙니다. `tools/verify-scheduler.sh`는 세 가지를 합니다. 주기적으로 파이프라인을 돌리고, 실패하면 알림 채널에 쓰고, **그 알림이 실제로 남았는지 되읽어 확인합니다.**

마지막 항목이 이 스크립트의 이유입니다. GitLab의 `pg_dump`는 에러를 냈고 크론은 메일을 보냈는데 그 메일이 DMARC로 반려됐습니다. **알림 경로 자체를 검증하지 않으면 알림은 없는 것과 같습니다.**

여기서도 한 번 미끄러졌습니다. 첫 실행에서 전 회차가 실패했는데 스크립트는 "알림 경로가 살아 있습니다"라고 보고했습니다. **알림은 나갔지만 정작 백업 검사는 한 번도 안 돌았습니다.** 검사용 컨테이너가 안 떴을 뿐입니다. 운영에서 이 둘을 같은 알림으로 묶으면 "백업이 깨졌다"와 "검사 장비가 죽었다"를 구분할 수 없어서, 실패를 갈라 종료 코드를 다르게 뒀습니다.

| 종료 코드 | 뜻 | 다음 행동 |
|---|---|---|
| 0 | 전 검사 통과 | 없음 |
| 1 | 검사 실패 | 백업을 본다 |
| 2 | 일부러 망가뜨렸는데 통과 | 검사 자체를 의심한다 |
| 3 | 실패했는데 알림이 유실됨 | 알림 경로를 본다 |
| 4 | 전부 환경 실패 | 검사기를 본다. 백업 상태는 여전히 모른다 |

2번이 가장 중요합니다. 검사가 전부 통과했는데 일부러 넣은 손상까지 통과했다면, 그 회차는 "백업이 멀쩡하다"가 아니라 "검사가 아무것도 안 보고 있다"입니다.

**그래도 이 세션이 못 만든 것이 남습니다. 소유자입니다.** `page-oncall.sh`가 누구를 깨우는지, 그 사람이 안 받으면 다음이 누구인지는 코드 밖의 문제입니다. GitLab의 5 Whys 마지막 답이 "아무도 책임지지 않아서"였던 것이 이 자리입니다.

## 6. 예상과 달랐던 점


### 함정 셋을 제가 직접 밟았습니다

이 세션의 실험 설계는 조사에서 나왔지만, **막힌 자리 셋은 스크립트를 짜다가 실제로 만난 것들**입니다. GTID 겹침으로 복원이 중단됐고, `mysqlbinlog`가 없어 도구 컨테이너를 추가했고, `-i` 누락으로 데이터가 조용히 안 들어갔습니다. 재현 랩을 만드는 사람도 같은 자리에서 막힌다는 뜻이고, 실전에서 처음 해보면 더할 것입니다. **복구 리허설을 해봐야 하는 이유가 이것 자체입니다.**

### GTID 경고가 PITR 문서에 없습니다

MySQL의 PITR 문서(9.5절)에는 GTID 관련 경고가 한 줄도 없습니다. 조용한 스킵은 복제 챕터에, `--set-gtid-purged` 문제는 mysqldump 옵션 설명에 흩어져 있습니다. PITR 문서만 읽고 따라 하면 두 함정을 그대로 만나는 구조입니다.

### 같은 함정이 엔진을 건너 반복됩니다

PostgreSQL을 붙이고 나서야 보인 것인데, 두 엔진의 가장 위험한 실패가 같은 모양입니다. MySQL은 GTID가 겹치면 재적용을 조용히 스킵하고, PostgreSQL은 `restore_command`가 성공을 가장하면 잘못된 지점에서 조용히 멈춥니다. 엔진을 바꿔도 "성공처럼 보이는 실패"라는 형태는 남습니다.

### 실패 모드가 전부 조용합니다

다섯 중 셋(재적용 스킵, binlog 만료, `-i` 누락)이 에러 없이 실패합니다. 나머지 둘(GTID 겹침, 도구 부재)은 시끄럽게 실패하는데, 역설적으로 그쪽이 낫습니다. **복구에서 가장 위험한 것은 실패가 아니라 성공처럼 보이는 실패입니다.** GitLab 사고에서 cron 실패 알림이 DMARC로 막혀 몇 달간 아무도 몰랐던 것과 같은 종류입니다.


## 7. 현업은 어떻게 해소했는가


**GitLab이 고친 것은 백업 기술이 아니었습니다.**

`pg_dump`는 정상적으로 에러를 냈고 크론은 알림 메일을 보냈습니다. 죽은 것은 그 메일이었습니다.

> "these notifications are sent by email ... DMARC was not enabled for the cronjob emails, resulting in them being rejected by the receiver."

그래서 실패가 아무에게도 닿지 않았습니다. 5 Whys의 마지막 답이 이것입니다.

> "Why was the backup procedure not tested on a regular basis? - Because there was no ownership, as a result nobody was responsible for testing this procedure."

그들이 실제로 넣은 것 셋입니다.

| 조치 | 내용 |
|---|---|
| 소유자 지정 | 백업 절차마다 담당을 명시 |
| WAL 아카이빙과 PITR 검토 | 개선 항목 #1097 |
| 매일 복원 테스트 | CI 파이프라인에서 새 인스턴스로 PITR 복원 후 쿼리로 정합성 확인 |

세 번째가 지금도 돕니다. 2026년 현재 GitLab 핸드북의 문장입니다.

> "Daily restoration testing is performed for GitLab.com application databases in CI pipelines ... This process performs a point-in-time recovery (PITR) restore into a new instance and verifies data integrity by running queries on the restored database."

**5절이 만든 파이프라인이 이 구조의 축소판입니다.** 복원해 보고, 행 수와 체크섬으로 대조하고, 소요가 예산 안인지 봅니다. 빠진 것은 5절 끝에 적은 소유자 하나입니다.


## 못 한 것


- **절대 시간은 인용할 수 없습니다.** 규모가 작고 Oracle과 SQL Server는 ARM 에뮬레이션입니다. 400만 행까지 올려도 복원 판정은 같았습니다. 규모별 곡선은 [전체 기록](https://github.com/dj258255/incident-lab/blob/main/sessions/A23-backup-pitr/README.md)에 있습니다.
- **파이프라인에 소유자가 없습니다.** 실패했을 때 누구를 깨우고 그 사람이 안 받으면 다음이 누구인지는 코드 밖의 문제입니다. 5절 끝에서 다룹니다.
- **초기 회차는 호스트 사양을 안 남겼습니다.** `uname -srm`과 `nproc`을 안 찍어서 어느 장비에서 돌린 회차인지 확인되지 않습니다. 지금 다시 찍어도 그 실행의 장비라는 보장이 없어 비워 뒀고, 뒤에 붙인 반복 측정부터 `meta/HOST.md`에 남깁니다.


---

**전체 기록은 [incident-lab 저장소의 A23 세션](https://github.com/dj258255/incident-lab/blob/main/sessions/A23-backup-pitr/README.md)에 있습니다.** 엔진별 재현 절차, 복구를 가로막은 다섯 함정, Oracle 인카네이션 판정, 400만 행까지의 규모 곡선, XtraBackup 무정지 백업, 관리형 서비스 대조가 그쪽에 있습니다. 실행한 명령과 출력 원문은 `reproduce.md`, 측정 데이터는 `results/`입니다.

---
title: '백업이 진짜가 되기까지: 로그 백업 5기종과 시점 복구, 그리고 정석까지의 네 걸음'
titleEn: 'Until Backups Became Real — Log Backups Across Five Engines, PITR, and Four Steps to Orthodoxy'
description: '이기종 DBMS 운영 관리 플랫폼 DBTower 6편. 백업 대장정입니다. 전반부는 로그 백업이 MSSQL만 되던 것을 MySQL binlog, PostgreSQL WAL, MongoDB oplog, Oracle 아카이브 로그까지 다섯 기종 전부로 넓히며 "기종이 못 하는 것"과 "하다가 깨진 것"을 구분하는 UNSUPPORTED 상태를 만들고, 최신 파일 하나만 수집하면 체인에 조용한 구멍이 난다는 것을 "마지막 이전 전부" 보충 수집으로 고치고, 생성한 복원 안내문을 실제로 실행해 SQL Server와 PostgreSQL에서 목표 시점의 상태를 정확히 재현한 기록입니다. 후반부는 그걸 현업의 정석 쪽으로 옮겨 가는 네 걸음입니다. Mongo oplog 증분($gte로 일부러 만든 겹침 한 건이 체인 무결의 증거, 산출물 28분의 1), pg_receivewal 스트리밍(복제 슬롯 덕에 수신자를 죽여도 재시작 사이 유실 0, 그리고 죽은 프로세스를 산 것처럼 보이게 하던 docker exec -i 함정), MySQL 물리 백업 XtraBackup(MYSQL_PWD를 안 읽고 /dev/stdin defaults를 조용히 무시하는 함정 두 겹, 검증은 파일 존재가 아니라 실제 prepare 실행), 그리고 AES-256-GCM 산출물 암호화(변조된 백업은 조용히 오염되는 대신 명확히 실패한다)까지입니다.'
descriptionEn: 'Part 15 of DBTower — the backup saga. First half: log backup goes from MSSQL-only to all five engines with an UNSUPPORTED status separating "the engine cannot" from "it broke", catch-up collection fixing the silent chain gap of collecting only the newest file, and generated restore guides actually executed — SQL Server and PostgreSQL both reproduced exact point-in-time states. Second half pushes toward production orthodoxy in four steps: Mongo oplog incrementals where a deliberately overlapped entry ($gte) proves chain continuity while shrinking backups 28x, pg_receivewal streaming with replication slots (killing the receiver loses nothing — plus the docker exec -i trap that made dead processes look alive), MySQL physical backups via XtraBackup past two password traps and verified by actually running prepare, and AES-256-GCM artifact encryption where tampering fails loudly instead of corrupting quietly.'
date: 2026-07-15
tags:
  - MySQL
  - PostgreSQL
  - MongoDB
  - Backup
  - PITR
  - DBRE
category: personal/DBTower
coverImage: /uploads/project/dbtower/xtrabackup-physical.png
draft: false
series: "DBTower"
seriesOrder: 6
---

## 0. 들어가며, Phase 2의 남은 절반

[5편](/blog/project/dbtower/dbtower-5-productionization)에서 화면을 맞췄으니 이번엔 기능의 깊이입니다. Phase 2에 남은 건 데이터 마스킹, 로그 백업과 시점 복구(PITR). 앞의 둘은 짧게, 백업은 길게 씁니다. 배운 게 훨씬 많았거든요.

**마스킹**은 설계대로 붙였습니다. 외부(웹훅·MCP 응답)로 나가는 SQL에서 리터럴만 `?`로 가리는 문자 스캐너로, `WHERE email = 'hong@x.com'`의 이메일은 가리고 컬럼·인덱스는 남깁니다. 진단력은 구조에, 민감정보는 값에 있으니까요. 정규식이 아니라 스캐너인 건 문자열 `'...'`(가림)과 따옴표 식별자 `"..."`(보존) 구분, `''` 이스케이프, `$1` 보존 같은 경계를 정규식이 못 잡아서입니다. 단위 테스트가 함정도 잡았습니다. 달러 인용 `$tag$...$tag$`의 태그에 `$`를 넣으면 닫는 `$`까지 소비해 종료를 못 만납니다.

**수집 신뢰도**도 한 조각 넣었습니다. 레퍼런스 밋업의 Lessons Learned를 대조하다가, MySQL digest 테이블이 가득 차면 신규 쿼리 통계가 소실돼 신규 쿼리 감지가 눈이 멀고, 그 사각이 DBTower에도 있음을 확인했습니다. 더 재미있는 건 Prepared Statement. PREPARE 후 EXECUTE를 돌리니 digest엔 `EXECUTE s1 USING @?`만 남고 실제 쿼리는 집계되지 않아, PS 워크로드가 Top Query에서 익명 부하가 됩니다. 둘 다 Advisor로 만들었습니다. 포화율 80% 경고, 소실 카운터 CRITICAL, PS 익명 부하 감지. 조치는 명령 안내까지만 합니다. 레퍼런스는 80% 넘으면 자동 truncate했지만, 우리는 대상 DB를 바꾸지 않으니까요.

## 1. "미지원"이라는 상태를 만들다

본편입니다. 로그 백업은 그동안 SQL Server만 됐습니다(`BACKUP LOG`). 다른 기종에 LOG 백업을 요청하면 예외가 던져지고, 이력엔 **FAILED**로 남았습니다.

여기 정직성 문제가 숨어 있었습니다. "MySQL은 binlog 수집 경로가 없어서 못 한다"와 "MSSQL 로그 백업이 서버 에러로 깨졌다"는 완전히 다른 사실인데, 이력에선 둘 다 FAILED였습니다. 못 하는 것과 깨진 것이 구분되지 않으면 신선도 화면도 운영자 판단도 흐려집니다. 그래서 세 번째 상태 **UNSUPPORTED**를 만들었습니다(V13). `UnsupportedOperationException`은 사유와 함께 UNSUPPORTED로, 나머지 예외만 FAILED로. 같은 마이그레이션에 백업 타입(FULL/LOG) 컬럼도 넣었습니다. 이게 없으면 뒤에 나올 PITR의 "복원 가능 범위" 계산이 불가능하거든요. 이전 이력은 타입이 null로 남습니다. FULL이었다 위장하지 않고 계산에서 제외합니다.

## 2. 다섯 기종, 다섯 개의 사정

각 기종의 로그 백업을 정석부터 확인하고 붙였습니다. 사정이 전부 달랐습니다.

**MySQL**은 교과서적이었습니다. `FLUSH BINARY LOGS`로 현재 binlog를 닫고(쓰는 중인 파일을 수집하면 안 되니 경계를 만드는 겁니다) 닫힌 파일을 수집합니다. 게이트는 `log_bin`. binlog가 꺼져 있으면 켜는 건 대상 서버 설정이라 우리가 하지 않고, "켜져 있으면 쓴다"로 UNSUPPORTED 사유만 남깁니다. 함정은 도구 쪽이었습니다. 공식 원격 수집 도구 mysqlbinlog가 **mysql:8.4 컨테이너 이미지에 없습니다**(실측 확인. mysqldump는 있는데요). 그래서 수집 명령을 접두부 템플릿으로 열어 두고, 데모는 닫힌 물리 파일을 그대로 가져오되 프로덕션 프로필엔 `mysqlbinlog --read-from-remote-server`를 뒀습니다. 이 도구도 MYSQL_PWD를 읽어 비밀번호 argv 금지 규칙과 호환됩니다.

**PostgreSQL**이 제일 고민스러웠습니다. 처음엔 "WAL 아카이빙은 archive_command 등 대상 서버 구성이 필요하니 자동화하지 않는다"로 접었는데, 다시 보니 `pg_switch_wal()`은 서버 설정 변경이 아니라 함수 호출입니다. FLUSH BINARY LOGS와 같은 결의 로그 로테이션이고, 닫힌 세그먼트를 수집하면 됩니다. 게이트 셋: `wal_level=minimal`(복구 재료가 아예 안 적힘), `pg_switch_wal` 권한, 수집 명령 미설정. 대신 문헌이 말하는 한계는 감추지 않았습니다. 무결한 연속 아카이브의 정석은 서버가 아카이브 확인 후에만 세그먼트를 재활용하는 archive_command(또는 pg_receivewal 스트리밍)이고, 우리 원샷 수집은 그 조율이 없어 재활용 경합 창이 남습니다. 세그먼트 이름이 순차 hex라 수집본만으로 갭 검출이 가능하다는 것까지 note에 적었습니다. (이 한계는 후반부에서 pg_receivewal로 정면 해소합니다.)

**MongoDB**는 게이트가 곧 교훈이었습니다. oplog는 복제셋에만 존재합니다. standalone 데모에서 LOG 백업을 요청하면 "standalone — oplog 없음(복제셋 전용)" UNSUPPORTED가 정확히 남는 걸 먼저 실측했습니다. 그다음 데모 스택을 단일노드 복제셋으로 전환했는데(플랫폼이 아니라 데모 관리자, 즉 사람의 행위입니다), auth와 replSet을 같이 켜면 내부 인증용 keyFile이 필수라는 복병이 있었습니다. macOS 바인드 마운트는 파일 권한이 안 맞아, 컨테이너 기동 시 파일을 안으로 복사해 400 권한을 입히는 부트스트랩으로 풀었습니다. 전환 후 `local.oplog.rs` 덤프가 돌아갑니다. oplog 컬렉션을 직접 덤프하는 것이 Percona·Pythian이 문서화한 정석 증분 방식입니다.

**Oracle**이 가장 많은 걸 가르쳐줬습니다. NOARCHIVELOG 게이트(모드 전환은 mount 재기동이 필요한 대상 구성)를 실측하고, 데모를 ARCHIVELOG로 전환하고, 모니터 계정에 ALTER SYSTEM까지 grant했는데, 돌아온 건 **ORA-65040**이었습니다. 플러거블 데이터베이스(PDB) 안에서는 허용되지 않는 작업이랍니다. 아카이브 로그 전환은 CDB 수준 작업이라, PDB로 접속하는 한 권한을 아무리 줘도 원천 불가입니다. 처음엔 이걸 권한 게이트(UNSUPPORTED)로 처리했지만, 다시 보니 사실이 다릅니다. 경계를 지금 못 만들 뿐, **이미 아카이브된 파일의 수집은 가능합니다.** 운영 DB는 로그 스위치가 자연히 일어나니까요. 그래서 ARCHIVE LOG CURRENT를 best-effort로 강등하고 V$ARCHIVED_LOG의 파일들을 수집하는 걸 본체로 삼았습니다. "RMAN이 정석인데 왜 파일 복사냐"는 질문엔: 아카이브 로그는 RMAN 백업셋(RMAN으로만 복원되는 고유 포맷)과 달리 완결된 리두 파일 그 자체라 복사만으로 유효한 보존이 되고(공식 문서 인정), RMAN을 끼우면 대상 서버에서 스크립트 실행 + 이중 카탈로그가 되어 "읽기 수집" 정체성을 넘습니다. RMAN의 블록 검증·증분을 포기하는 트레이드오프는 주석에 남겼습니다.

## 3. 최신 하나만 가져가면 체인에 구멍이 난다

문헌으로 "현업 정석대로 되는 게 맞나"를 재검증하다 구멍이 나왔습니다. 세 기종 모두 **방금 닫힌 파일 하나**만 수집하고 있었습니다. 주기 사이에 로그가 여러 번 회전하면(MySQL이 max_binlog_size로 자동 회전하거나, 부하로 WAL 세그먼트가 여러 개 차거나) 중간 파일들이 조용히 빠집니다. 로그 체인은 하나만 빠져도 그 지점 이후 복구가 불가능한데, 아무도 모르게요. MySQL 공식 문서와 현업 백업 스크립트의 관행은 명확했습니다. FLUSH 후 **마지막(쓰는 중) 파일 이전 전부**를 복사한다.

미수집 닫힌 로그를 전부 보충 수집(catch-up)하되, "이미 수집했는가"는 별도 상태 저장 없이 **로컬 산출물 파일명으로 판정**합니다. 산출물 이름이 원본 로그 이름으로 끝나게 지어놨으니 파일시스템이 곧 장부입니다(멱등). 서버 쪽은 건드리지 않습니다. PURGE로 지우는 건 우리 몫이 아닙니다.

수동으로 로그를 두세 번 회전시켜 "주기를 놓친 상황"을 만들고 LOG 백업을 한 번 실행했습니다. MySQL은 산출물이 3개에서 13개로(과거 미수집분 전부), PostgreSQL은 1개에서 5개로 늘었는데 세그먼트 번호가 **50·51·52·53·54로 연속, 갭 제로**였습니다. 재실행하면 "전부 이미 수집됨"으로 멱등하게 거절됩니다.

## 4. 시점 복구, 생성한 안내문을 실제로 실행하다

로그 체인이 쌓이니 시점 복구가 가능해집니다. 범위는 처음부터 좁게 잡았습니다. 완전한 PITR 오케스트레이션은 대상 서버 구성(아카이브 경로, restore_command)을 요구해 정체성과 충돌하니, DBTower는 **(1) 복원 가능 창 계산**과 **(2) 기종별 복원 명령 문안 생성**까지만 하고 실행은 사람이 합니다. gh-ost dry-run, digest TRUNCATE 안내와 같은 생성·안내 모델입니다.

창 계산은 이력 산수입니다. 마지막 성공 FULL 시각부터 그 이후 마지막 성공 LOG 시각까지. LOG가 없으면 "FULL 시점으로만 복원 가능(임의 시점 불가)"이라고 정직하게 말합니다. 문안 생성은 기종별 관심사라 Operator의 능력으로 뒀습니다(기종 분기를 서비스에 두지 않는 원칙). MySQL은 FULL 적재 후 `mysqlbinlog --stop-datetime | mysql` 재생, SQL Server는 FULL을 NORECOVERY로 적재하고 로그 체인을 시간순으로 잇되 마지막 로그만 `STOPAT` + RECOVERY. PostgreSQL 문안은 한계 명시가 본체입니다. 우리 FULL은 pg_dump 논리 덤프라 **WAL을 그 위에 재생할 수 없습니다.** 지어낸 절차 대신 "시점 복구에는 물리 베이스백업(pg_basebackup)이 필요하다"는 사실과 그 절차를 안내합니다.

이 안내문이 진짜 돌아가는지 실행으로 증명했습니다. SQL Server에 FULL 복구 모델 데모 DB를 만들어 3행을 넣고 FULL 백업, 2행 추가 후 LOG, 1행(amount=600) 추가 후 LOG로 체인을 쌓고, 생성된 문안을 그대로 실행했습니다. 목표 시점은 600이 들어가기 전. 결과: 임시 DB에 **5행, 600 없음.** 원본은 6행 그대로. 6행짜리 현재에서 5행짜리 과거를 꺼낸 겁니다. e2e가 함정도 잡았습니다. 같은 서버에 복원하면 데이터 파일이 충돌해 MOVE 절이 필요합니다. 이 교훈은 안내문 주석으로 되먹였습니다.

이 모든 게 콘솔에선 카드 하나로 보입니다. 복원 가능 창, 기종별 복원 문안, 이력에서 SUCCESS는 초록·FAILED는 빨강·UNSUPPORTED는 회색. "못 하는 것"이 실패로 위장되지 않는 색 구분까지입니다.

물리의 첫 조각도 여기서 들어왔습니다. 백업 타입에 **PHYSICAL(물리 전체)**을 신설했습니다. PostgreSQL은 pg_basebackup(replication 프로토콜이라 서버 설정 변경이 없고, tar를 stdout으로 받아 기존 수집 모델 그대로), Oracle은 RMAN 경로(BACKUP ARCHIVELOG ALL **NOT BACKED UP 1 TIMES**)입니다. 멱등과 블록 검증은 RMAN 카탈로그가 보장하는데, 데모 이미지엔 rman이 없어 파일 수집 폴백을 정직하게 씁니다. PostgreSQL에서도 SQL Server처럼 **실제 시점 복원**을 했습니다. 물리 백업(404MB) 위에 마커 A를 넣고 WAL을 수집하고, 목표 시점을 기록하고, 마커 B를 넣고 다시 WAL을 수집했습니다. 그다음 안내문대로 tar를 해체하고 recovery_target_time을 걸어 임시 서버를 띄웠습니다. 여기서도 함정이 하나. recovery 모드는 pg_wal에 파일을 직접 넣는 게 아니라 **restore_command가 필수**입니다. 문안을 고치고 재시도하니 서버 로그가 증언했습니다. "recovery stopping before commit ... 11:23:38.887". 마커 B가 들어가기 직전에 정확히 멈춘 겁니다. 체인의 뒷받침도 확인됐습니다. 물리 백업의 backup_label이 요구한 시작 세그먼트(58)를 앞 절의 멱등 보충 수집이 이미 갖고 있었습니다. 정석대로 "전부"를 줍는 습관이 자기 자신을 구한 셈입니다.

## 5. "돌아간다"와 "정석이다" 사이, 네 걸음을 더

여기까지 쓰고 3-2-1이 완성됐다고 생각했습니다. 현업 DBA의 눈으로 보면 네 군데가 걸립니다. Mongo 로그 백업은 매번 oplog 전체를 떴고(증분이 아니라 반복 전체 수집), PG WAL은 수집 주기 사이에 세그먼트가 재활용되면 구멍이 날 수 있는 풀 방식이었고, MySQL엔 현업 표준인 물리 백업 경로가 없었고, 산출물은 전부 평문이었습니다. 후반부는 그 네 조각을 정석 쪽으로 옮기는 이야기입니다.

## 6. 겹침 한 건이 증거다, Mongo oplog 증분

증분 백업의 적은 구멍입니다. 직전 수집과 이번 수집 사이에 유실이 있어도 산출물만 봐서는 모르니까요. 그래서 설계의 본체를 "구멍이 없다는 증거"에 뒀습니다. 직전 산출물 파일명에 박아둔 ts 마커 이후를 뜨되, 조건을 `$gt`가 아니라 **`$gte`로** 걸어 직전 덤프의 마지막 엔트리를 일부러 한 건 겹쳐 받습니다. 이번 산출물의 첫 엔트리가 직전 마커와 정확히 일치하면, 그 겹침 자체가 두 산출물 사이에 빈틈이 없다는 물증이 됩니다.

실측도 그대로였습니다. 1차 로그 백업이 215,848바이트(전체), 20건 insert 후 2차가 **7,686바이트로 28분의 1**이었습니다. 2차 아카이브를 임시 네임스페이스로 실제 복원하니 첫 엔트리 ts가 1차 마커(ts1784170173_1)와 정확히 일치했고, 총 24엔트리(겹침 1 + 신규)였습니다.

반대 방향의 정직함도 있습니다. oplog는 순환(capped) 컬렉션이라 수집이 뜸하면 마커보다 오래된 엔트리가 이미 밀려났을 수 있는데, 이때 조용히 전체를 다시 뜨면 안 됩니다. 체인 구멍을 성공으로 위장하는 거니까요. 명확히 실패시키고 "FULL부터 다시 + 주기를 줄이라"고 말하게 했습니다.

## 7. 죽어도 다시 서는 수신자, pg_receivewal과 죽은 척하는 래퍼

WAL 수집의 정석은 완결된 세그먼트를 주기적으로 걷어오는 게 아니라 복제 프로토콜로 실시간 스트리밍하는 겁니다. `pg_receivewal --slot`이면 앞에서 적어둔 그 한계가 두 가지 다 풀립니다. 스트리밍이라 수집 주기라는 창 자체가 없어지고, 복제 슬롯 덕에 수신자가 죽어 있는 동안의 WAL도 서버가 보존해줍니다.

상주 프로세스라 매니저의 일은 "실행"이 아니라 "보살핌"입니다. 30초마다 대상 집합을 다시 계산해 죽은 스트림은 재기동하고 대상에서 빠진 스트림은 종료합니다. 그런데 첫 e2e에서 이상한 일이 벌어졌습니다. 컨테이너 안의 pg_receivewal을 죽였는데 매니저가 재시작을 안 하는 겁니다. 범인은 호스트 쪽 `docker exec -i` CLI였습니다. 원격 프로세스가 죽어도 stdin의 EOF를 기다리며 저 혼자 살아 있었고, 매니저의 isAlive()는 그 죽은 껍데기를 산 스트림으로 오인했습니다. 템플릿에서 -i를 빼고(pg_receivewal은 stdin이 필요 없습니다) 방어로 spawn 직후 자식 stdin을 닫게 했습니다. 죽은 척하는 래퍼는 생존 감시의 적입니다.

고친 뒤 e2e는 교과서처럼 흘러갑니다. 기동 후 슬롯 active=t, .partial 수신 → 프로세스 kill → 30초 안에 "사망 감지 — 재시작 1회차"와 함께 재접속 → 수신 디렉터리에 C8, C9, CA.partial이 **연속으로** 남았습니다. kill 공백 구간에 만들어진 C9를 슬롯이 보존하다 넘겨준 겁니다. 재시작 사이 유실 0.

## 8. prepare까지 해봐야 백업이다, XtraBackup

대용량 MySQL의 주 백업은 물리가 표준입니다. 논리 덤프는 복원 때 SQL을 전부 재생하고 인덱스를 재구축해야 해 수백 GB부터는 비현실적이고, binlog 재생의 앵커도 물리 백업+좌표가 정석이니까요. PHYSICAL 타입에 `xtrabackup --stream=xbstream`을 stdout으로 받아 단일 파일로 저장하는 경로를 추가했습니다. 이 형태라 뒤에 나올 암호화 관문·원격 보관과 그대로 조립됩니다.

함정은 비밀번호 쪽에서 두 겹으로 나왔습니다. 시리즈 내내 "비밀번호는 argv 금지, 환경변수로"를 지켜왔는데, xtrabackup은 **MYSQL_PWD를 읽지 않습니다**("password: not set"). mongodump 때처럼 defaults 파일을 파이프로 주면 되겠지 하고 `--defaults-extra-file=/dev/stdin`을 시도하니, defaults 로더가 파이프를 **에러도 없이 조용히 무시**합니다. 조용한 폴백이 또 하나 늘었습니다. 결국 비밀번호를 환경변수(XB_CNF)로 넘기고, 코드가 소유한 래퍼 스크립트가 컨테이너 안에서 임시 파일(umask 077)로 떨어뜨려 읽게 했습니다. 호스트·컨테이너 어느 쪽 argv에도 비밀번호가 없습니다.

검증도 물리답게 바꿨습니다. 물리 산출물은 "파일이 존재한다"로는 아무것도 증명 못 합니다. 격리 컨테이너에서 xbstream을 풀고 **`xtrabackup --prepare`를 실제로 실행**합니다. redo 적용과 미완 트랜잭션 롤백, 즉 크래시 복구를 진짜로 수행하는 거죠. 이게 성공해야 "복원 가능한 물리 백업"이 사실이 됩니다. 실측: 81,269,868바이트 xbstream을 5.6초에 뜨고, 검증에서 자동 복호 → 추출 → prepare → VERIFIED.

![백업/PITR 카드, 물리(xbstream) 앵커와 복원 가능 창](/uploads/project/dbtower/xtrabackup-physical.png)

시점 복구 문안도 물리 앵커에 맞게 갈립니다. 특히 binlog 재생을 **xtrabackup_binlog_info의 좌표부터** 시작하라는 경고를 문안에 박았습니다. 좌표 없이 처음부터 재생하면 백업에 이미 반영된 변경이 중복 적용되니까요.

## 9. 변조는 실패가 된다, 산출물 암호화

백업 파일은 대상 DB 전체 데이터의 가장 농축된 유출면인데, 로컬도 원격도 평문이었습니다. 3-2-1-1-0에서 네 번째 1(암호화 사본)이 비어 있던 거죠. 산출물 쓰기의 단일 관문에서 AES-256-GCM 스트리밍 암호화를 걸었습니다. 형식은 MAGIC 헤더(DBTENC1) + IV + 암호문. 파일명은 그대로라 체인 보충이나 ts 마커 규약이 암호화와 무관하게 동작합니다.

GCM을 고른 이유는 기밀성보다 **인증** 쪽입니다. 복호에 태그 검증이 포함되니, 보관 중 1비트라도 변조된 산출물은 복원 검증에서 조용히 오염된 데이터를 내놓는 대신 명확히 실패합니다. "복원해 본 백업"에 "변조 안 된 백업"까지 얹히는 거죠. 실측: 키 설정 후 mysql FULL을 뜨니 산출물 헤더가 DBTENC1이고 파일 안 CREATE TABLE 평문이 **0건**, 복원 검증은 자동 복호를 거쳐 VERIFIED. 단위 테스트로는 꼬리 1비트 변조 거부와 다른 키 거부까지 고정했습니다.

한계도 적어둡니다. MSSQL·Oracle의 서버 사이드 백업은 대상 서버 디스크에 직접 쓰여 이 관문을 지나지 않습니다. 원격 업로드 시점 암호화가 후속 후보입니다.

## 10. 정책이 정석을 알게 하다, FULL 앵커와 LOG 체인의 병행

네 걸음을 다 걷고 다섯 번째가 나왔습니다. 이번엔 코드가 아니라 질문에서 나왔습니다. "백업 정책이랑 로그 백업 정책은 따로 걸 수 있나?" 확인해보니 정책 테이블의 유니크 제약이 인스턴스 단위였습니다. 인스턴스당 정책이 딱 하나라, FULL과 LOG를 동시에 자동 스케줄로 걸 수가 없었습니다.

그 병행이 곧 시점 복구의 실무 표준이기 때문입니다. SQL Server의 정석 구성(주간 FULL, 일간 DIFF, 15분 LOG)도, MySQL의 일간 물리 백업과 binlog 상시 수집도, PostgreSQL의 basebackup과 WAL 아카이빙도 전부 같은 구조입니다. 두 지표가 서로 다른 주기를 요구해서입니다. 얼마나 잃어도 되는가(RPO)는 로그 주기가 정하니 로그는 촘촘해야 하고, 얼마나 빨리 복구되는가(RTO)는 앵커의 최신성이 정하니 전체 백업은 무겁지만 주기적으로 갱신돼야 합니다. 인스턴스당 정책 하나면 둘 중 하나를 사람의 수동 실행에 의존하게 됩니다. 시리즈 내내 배격해온 "사람이 기억해야 작동하는 운영"이 백업의 심장부에 남아 있던 셈입니다.

수정은 제약을 (인스턴스, 타입) 복합으로 푸는 게 본체였습니다. 폴러는 원래 기한이 된 정책 목록을 순회하며 각자의 타입으로 실행하는 구조라 손댈 게 없었고, 스키마와 API의 단수 의미론만 열면 됐습니다. 마이그레이션 함정이 하나. 기존 유니크 제약의 이름이 환경마다 다릅니다(스크립트가 명명한 것과 하이버네이트가 생성한 것). 이름을 박아 DROP하는 대신 카탈로그에서 유니크 제약을 찾아 동적으로 지우게 했습니다. 덤으로 드러난 것도 있습니다. 정책 타입 CHECK 제약에 PHYSICAL이 빠져 있어, 물리 백업은 즉시 실행만 가능했고 정책 스케줄은 원천 차단돼 있었습니다.

신선도도 같이 고쳤습니다. 기존 판정은 "종류 무관 최근 성공"이라, LOG가 15분마다 성공하면 FULL이 몇 주째 깨져 있어도 화면이 초록이었습니다. 앵커 없이는 로그 체인만으로 복원이 안 되는데도요. 신선도 기준을 앵커(FULL/PHYSICAL)로 바꾸고, LOG 축의 건강은 복원 가능 창이 따로 말하게 뒀습니다.

한 인스턴스에 FULL 360분과 LOG 1분을 동시에 걸자 정책 목록에 두 행이 공존하고, 폴러가 같은 틱에 FULL과 LOG를 각각 실행한 뒤 다음 분엔 LOG만 돌았습니다. 각자의 주기가 독립으로 살아 있는 거죠. 신선도를 조회하니 기준 시각이 최신 성공(방금의 LOG)이 아니라 앵커(그 전의 FULL)로 잡혔습니다. 가림 왜곡이 사라진 것까지 확인하고서야 이 절을 닫았습니다.

## 11. 배운 것

이 대장정에서 남는 문장은 이렇습니다. **백업 기능이 있다는 것과 복구가 된다는 것은 다르고, 그 간극은 상태의 정직함(UNSUPPORTED)·체인의 연속성(보충 수집·겹침 증거·복제 슬롯)·실행해 본 절차(STOPAT·recovery_target_time·prepare)로만 메워집니다.** 다섯 기종의 사정이 전부 달랐지만(binlog와 WAL과 oplog와 아카이브 로그와 xbstream이 전부 다르게 생겼지만), 게이트를 정직하게 선언하고 닫힌 로그 전부를 멱등하게 줍고 복원을 실제로 돌려보는 골격은 하나였습니다. 이걸로 백업 축은 논리·물리·로그·스트리밍·증분·암호화·복원 검증, 그리고 그 전부를 정석 조합으로 자동 운영하는 병행 정책까지 채워졌습니다.

다음은 Phase 3입니다. 여러 팀이 한 콘솔을 쓸 때를 위한 팀 라벨 기반 접근 스코핑과, 로그인이 재시작을 견디는 공유 세션 이야기입니다. 인스턴스 메타에 심어둔 team_label 컬럼이 드디어 제 역할을 하게 됩니다.

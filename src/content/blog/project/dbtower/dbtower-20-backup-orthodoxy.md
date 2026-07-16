---
title: '백업의 정석 — 겹침이 증거가 되는 증분, 죽어도 다시 서는 수신자, prepare까지 해봐야 백업, 변조는 실패가 되는 암호화'
titleEn: 'Backup Orthodoxy — Incrementals Where Overlap Is the Proof, a Receiver That Rises Again, No Backup Until Prepare Succeeds, and Encryption That Turns Tampering into Failure'
description: '이기종 DBMS 운영 관리 플랫폼 DBTower 20편. 16편의 백업·PITR을 현업의 정석 쪽으로 네 걸음 밀었습니다. 첫째, Mongo oplog 증분 — 매번 전체를 뜨던 로그 백업이 직전 마커 이후만 뜨게 되면서 215,848바이트가 7,686바이트(28분의 1)가 됐는데, 핵심은 크기가 아니라 $gte로 일부러 만든 겹침 한 건이 "체인에 구멍 없음"의 증거가 된다는 점입니다. 둘째, pg_receivewal 스트리밍 — 수집 주기 사이의 구멍을 복제 슬롯이 막고, 프로세스를 죽여도 30초 안에 되살아나 kill 공백 구간의 세그먼트까지 연속으로 받아냅니다. 그 과정에서 죽은 프로세스를 산 것처럼 보이게 하던 docker exec -i 함정도 잡았고요. 셋째, MySQL 물리 백업(XtraBackup) — xtrabackup은 MYSQL_PWD를 안 읽고 /dev/stdin defaults 파일은 조용히 무시한다는 함정 두 겹을 지나, 검증은 파일 존재가 아니라 실제 prepare(크래시 복구 수행)까지 돌려 VERIFIED를 받습니다. 넷째, 산출물 암호화 — AES-256-GCM 스트리밍이라 백업 파일에서 CREATE TABLE 평문이 0건이 되고, GCM 태그 덕에 변조된 백업은 조용히 오염되는 대신 명확히 실패합니다.'
descriptionEn: 'Part 20 of DBTower — four steps toward production-grade backups. Mongo oplog incrementals where a deliberately overlapped entry ($gte, not $gt) proves chain continuity while shrinking a log backup 28x; pg_receivewal streaming with replication slots, where killing the receiver loses nothing because the slot preserves WAL across the 30-second restart — plus the docker exec -i trap that made dead processes look alive; MySQL physical backups via XtraBackup past two traps (it ignores MYSQL_PWD and silently skips piped defaults files), verified not by file existence but by actually running prepare; and AES-256-GCM artifact encryption where zero plaintext survives and tampering fails loudly instead of corrupting quietly.'
date: 2026-07-22
tags:
  - MySQL
  - PostgreSQL
  - MongoDB
  - Backup
  - DBRE
category: personal/DBTower
coverImage: /uploads/project/dbtower/cover.svg
draft: false
series: "DBTower"
seriesOrder: 20
---

## 0. 들어가며, "돌아간다"와 "정석이다" 사이

16편에서 로그 백업 5기종과 시점 복구를 만들고 3-2-1이 완성됐다고 썼습니다. 거짓말은 아니었는데, 현업 DBA의 눈으로 다시 보면 네 군데가 걸립니다. Mongo 로그 백업은 매번 oplog 전체를 뜨고 있었고(증분이 아니라 반복 전체 수집), PG WAL은 수집 주기 사이에 세그먼트가 재활용되면 구멍이 날 수 있는 풀 방식이었고, MySQL엔 현업 표준인 물리 백업 경로가 없었고, 산출물은 전부 평문이었습니다. 이번 편은 그 네 조각을 정석 쪽으로 미는 이야기입니다.

## 1. 겹침 한 건이 증거다 — Mongo oplog 증분

증분 백업의 적은 구멍입니다. 직전 수집과 이번 수집 사이에 유실이 있어도 산출물만 봐서는 모르니까요. 그래서 설계의 본체를 "구멍이 없다는 증거"에 뒀습니다. 직전 산출물 파일명에 박아둔 ts 마커 이후를 뜨되, 조건을 `$gt`가 아니라 **`$gte`**로 — 직전 덤프의 마지막 엔트리를 일부러 한 건 겹쳐 받습니다. 이번 산출물의 첫 엔트리가 직전 마커와 정확히 일치하면, 그 겹침 자체가 두 산출물 사이에 빈틈이 없다는 물증이 됩니다.

실측이 그대로 나왔습니다. 1차 로그 백업이 215,848바이트(전체), 20건 insert 후 2차가 **7,686바이트 — 28분의 1**. 2차 아카이브를 임시 네임스페이스로 실제 복원해보니 첫 엔트리 ts가 1차 마커(ts1784170173_1)와 정확히 일치했고, 총 24엔트리(겹침 1 + 신규)였습니다.

반대 방향의 정직함도 하나 있습니다. oplog는 순환(capped) 컬렉션이라 수집이 뜸하면 마커보다 오래된 엔트리가 이미 밀려났을 수 있는데, 이때 조용히 전체를 다시 뜨면 안 됩니다. 그건 체인 구멍을 성공으로 위장하는 거니까요. 명확히 실패시키고 "FULL부터 다시 + 주기를 줄이라"고 말하게 했습니다.

## 2. 죽어도 다시 서는 수신자 — pg_receivewal과 죽은 척하는 래퍼

WAL 수집의 정석은 완결된 세그먼트를 주기적으로 걷어오는 게 아니라 복제 프로토콜로 실시간 스트리밍하는 겁니다. `pg_receivewal --slot`이면 두 가지가 한 번에 해결됩니다. 스트리밍이라 수집 주기라는 창 자체가 없어지고, 복제 슬롯 덕에 수신자가 죽어 있는 동안의 WAL도 서버가 보존해줍니다.

상주 프로세스라 매니저의 일은 "실행"이 아니라 "보살핌"입니다. 30초마다 대상 집합을 다시 계산해 죽은 스트림은 재기동하고 대상에서 빠진 스트림은 종료합니다. 그런데 첫 e2e에서 이상한 일이 벌어졌습니다. 컨테이너 안의 pg_receivewal을 죽였는데 매니저가 재시작을 안 하는 겁니다. 범인은 호스트 쪽 `docker exec -i` CLI였습니다 — 원격 프로세스가 죽어도 stdin의 EOF를 기다리며 저 혼자 살아 있었고, 매니저의 isAlive()는 그 죽은 껍데기를 산 스트림으로 오인했습니다. 템플릿에서 -i를 빼고(pg_receivewal은 stdin이 필요 없습니다), 방어로 spawn 직후 자식 stdin을 닫게 했습니다. 죽은 척하는 래퍼는 생존 감시의 적입니다.

고친 뒤의 e2e는 교과서처럼 흘러갑니다. 기동 후 슬롯 active=t, .partial 수신 → 프로세스 kill → 30초 안에 "사망 감지 — 재시작 1회차"와 함께 재접속 → 수신 디렉터리에 C8, C9, CA.partial이 **연속으로** — kill 공백 구간에 만들어진 C9를 슬롯이 보존하고 있다가 넘겨준 겁니다. 재시작 사이 유실 0.

## 3. prepare까지 해봐야 백업이다 — XtraBackup

대용량 MySQL의 주 백업은 물리가 표준입니다. 논리 덤프는 복원할 때 SQL을 전부 재생하고 인덱스를 재구축해야 해서 수백 GB부터는 비현실적이고, binlog 재생의 앵커도 물리 백업+좌표가 정석이니까요. PHYSICAL 타입을 추가해 `xtrabackup --stream=xbstream`을 stdout으로 받아 단일 파일로 저장했습니다 — 이 형태라 기존 암호화 관문·원격 보관과 그대로 조립됩니다.

함정은 비밀번호 쪽에서 두 겹으로 나왔습니다. 이 시리즈에서 줄곧 "비밀번호는 argv 금지, 환경변수로"를 지켜왔는데, xtrabackup은 **MYSQL_PWD를 읽지 않습니다**("password: not set"). 그럼 mongodump 때처럼 defaults 파일을 파이프로 주면 되겠지 하고 `--defaults-extra-file=/dev/stdin`을 시도하니 — defaults 로더가 파이프를 **에러도 없이 조용히 무시**합니다. 조용한 폴백이 또 하나 늘었습니다. 결국 비밀번호를 환경변수(XB_CNF)로 넘기고, 코드가 소유한 래퍼 스크립트가 컨테이너 안에서 임시 파일(umask 077)로 떨어뜨려 읽게 했습니다. 호스트·컨테이너 어느 쪽 argv에도 비밀번호가 없습니다.

검증도 물리답게 바꿨습니다. 물리 산출물은 "파일이 존재한다"로는 아무것도 증명 못 합니다. 격리 컨테이너에서 xbstream을 풀고 **`xtrabackup --prepare`를 실제로 실행** — redo 적용과 미완 트랜잭션 롤백, 즉 크래시 복구를 진짜로 수행합니다. 이게 성공해야 "복원 가능한 물리 백업"이 사실이 됩니다. 실측: 81,269,868바이트 xbstream을 5.6초에 뜨고, 검증에서 자동 복호 → 추출 → prepare → VERIFIED.

![백업/PITR 카드 — 물리(xbstream) 앵커와 복원 가능 창](/uploads/project/dbtower/xtrabackup-physical.png)

시점 복구 문안도 물리 앵커에 맞게 갈립니다. 특히 binlog 재생을 **xtrabackup_binlog_info의 좌표부터** 시작하라는 경고를 문안에 박았습니다 — 좌표 없이 처음부터 재생하면 백업에 이미 반영된 변경이 중복 적용됩니다.

## 4. 변조는 실패가 된다 — 산출물 암호화

백업 파일은 대상 DB 전체 데이터의 가장 농축된 유출면인데, 로컬도 원격도 평문이었습니다. 3-2-1-1-0에서 네 번째 1(암호화 사본)이 비어 있던 거죠. 산출물 쓰기의 단일 관문에서 AES-256-GCM 스트리밍 암호화를 걸었습니다. 형식은 MAGIC 헤더(DBTENC1) + IV + 암호문 — 파일명은 그대로라 체인 보충이나 ts 마커 규약이 암호화와 무관하게 동작합니다.

GCM을 고른 이유는 기밀성보다 **인증** 쪽입니다. 복호에 태그 검증이 포함되니, 보관 중에 1비트라도 변조된 산출물은 복원 검증에서 조용히 오염된 데이터를 내놓는 대신 명확히 실패합니다. "복원해 본 백업"에 "변조 안 된 백업"까지 얹히는 겁니다. 실측: 키 설정 후 mysql FULL을 뜨니 산출물 헤더가 DBTENC1이고 파일 안에 CREATE TABLE 평문이 **0건**, 복원 검증은 자동 복호를 거쳐 VERIFIED. 단위 테스트로는 꼬리 1비트 변조 거부와 다른 키 거부까지 고정했습니다.

한계도 적어둡니다. MSSQL·Oracle의 서버 사이드 백업은 대상 서버 디스크에 직접 쓰여 이 관문을 지나지 않습니다 — 원격 업로드 시점 암호화가 후속 후보입니다.

이걸로 백업 축은 논리·물리·로그·스트리밍·증분·암호화·복원 검증까지 채워졌습니다. 다음 편은 방향을 바꿔서, 관제탑이 사람과 대화하는 쪽입니다 — 알림이 카드가 되고, 이모지가 진단을 부르고, 로그인 창이 토큰을 만드는 이야기요.

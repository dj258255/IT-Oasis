---
title: '설정 변경 0으로 데드락을 읽다 — 세 기종, 세 입도'
titleEn: 'Reading Deadlocks with Zero Config Change: Three Engines, Three Granularities'
description: "이기종 DBMS 운영 관리 플랫폼 DBTower 14편. 데드락은 자체 회복(한쪽 롤백)되지만 애플리케이션 오류로 드러나는, 반복되면 락 순서를 점검해야 하는 신호입니다. DB는 이미 데드락의 흔적을 남기므로 설정을 바꾸지 않고 그걸 읽었습니다 — 그런데 세 기종의 관측 입도가 근본적으로 달랐습니다. SQL Server의 system_health 확장 이벤트는 데드락마다 victim·관여 프로세스·경합 리소스를 XML로 남기고, MySQL의 SHOW ENGINE INNODB STATUS는 가장 최근 1건만 텍스트로 보여주며, PostgreSQL은 개별 사건 없이 누적 카운터만 줍니다. 그래서 앞 둘은 리포트 파싱으로, PG는 카운터 델타 알림으로 갈랐습니다. 라이브 실측에서는 조사와 정반대의 현실 — 방금 발생한 데드락이 파일이 아니라 메모리 링버퍼에만 있던 것 — 을 만나 설계를 그 자리에서 고쳤습니다."
descriptionEn: "Part 14 of DBTower. A deadlock self-heals (one side rolls back) but surfaces as an application error, and repeated ones signal a lock-ordering problem. The database already leaves traces, so we read them without changing any settings — but the three engines' observation granularity differs fundamentally. SQL Server's system_health extended events leave victim, participating processes, and contended resources as XML per deadlock; MySQL's SHOW ENGINE INNODB STATUS shows only the single latest one as text; PostgreSQL gives no per-event record, only a cumulative counter. So the first two parse reports while PG uses a counter delta alert. Live measurement met the opposite of what the research suggested — a just-occurred deadlock lived only in the in-memory ring buffer, not the file — and the design was fixed on the spot."
date: 2026-07-07
tags:
  - Java
  - Spring Boot
  - DBRE
  - Observability
  - SQL Server
  - MySQL
  - PostgreSQL
category: personal/DBTower
coverImage: /uploads/project/dbtower/cover.svg
draft: false
series: "DBTower"
seriesOrder: 14
---

## 0. 들어가며 — 스스로 낫는데, 왜 봐야 하나

데드락은 묘한 사고입니다. 두 트랜잭션이 서로가 쥔 락을 기다리며 영원히 멈출 것 같지만, DB가 순환 대기를 감지하고 한쪽을 victim으로 골라 롤백합니다. **자체 회복되는 거죠.** 그런데도 봐야 하는 이유는, 롤백된 쪽이 애플리케이션에는 에러(`Deadlock found`, `1205`)로 튀고, 이게 **반복되면 코드의 락 순서가 잘못됐다는 신호**이기 때문입니다.

원칙은 이번에도 같습니다 — **읽고 판단만.** 데드락을 잡겠다고 대상 DB의 확장 이벤트 세션을 새로 켜거나(`ALTER EVENT SESSION`) 설정을 바꾸면 안 됩니다. 다행히 세 기종 모두 데드락의 흔적을 **이미** 남깁니다. 그걸 설정 변경 0으로 읽는 게 이번 아크입니다.

문제는, 그 흔적의 **입도(granularity)가 기종마다 근본적으로 다르다**는 것이었습니다.

## 1. 세 개의 다른 입도

- **SQL Server** — `system_health` 확장 이벤트 세션이 (기본으로 켜진 채) 데드락마다 `xml_deadlock_report`를 남깁니다. victim, 관여한 모든 프로세스의 입력 SQL, 경합한 락 리소스까지 XML로. **가장 풍부합니다.** 여러 건을 읽을 수 있죠.
- **MySQL** — `SHOW ENGINE INNODB STATUS` 출력의 "LATEST DETECTED DEADLOCK" 섹션. 이름 그대로 **가장 최근 1건**만. 그 이전 데드락은 덮여 사라집니다.
- **PostgreSQL** — 개별 데드락 리포트가 뷰에 없습니다. 로그에는 남지만, 통계 뷰에는 `pg_stat_database.deadlocks`라는 **누적 카운터**뿐이에요.

이 차이는 억지로 통일할 수 없습니다. 그래서 축을 둘로 갈랐어요. **MSSQL·MySQL은 `recentDeadlocks()`가 리포트 목록을 반환**하고, **PG는 개별 사건이 없으니 카운터 델타 알림**으로. 공용 레코드 `DeadlockEvent(발생시각·문장들·victim·리소스·source)`에 담되, PG는 이 레코드 대신 카운터를 씁니다. 같은 축을 기종 현실에 맞게 두 갈래로 다룬 거죠.

## 2. 세 경로

**SQL Server** — `sys.fn_xe_file_target_read_file`로 `.xel` 파일에서 `xml_deadlock_report`를 읽어 DOM 파싱합니다. victim-list의 프로세스 id로 어느 쪽이 롤백됐는지 가르고, 각 프로세스의 `inputbuf`에서 SQL을, resource-list에서 경합 객체·인덱스를 뽑습니다. 외부 XML 라이브러리 없이 표준 `javax.xml`만 씁니다(11편의 showplan 파싱과 같은 도구).

**MySQL** — `SHOW ENGINE INNODB STATUS`의 거대한 텍스트(최대 1MB)에서 "LATEST DETECTED DEADLOCK" 블록을 잘라, 두 트랜잭션의 SQL과 `WE ROLL BACK TRANSACTION (N)`의 N번(victim), 경합 인덱스·테이블을 정규식으로 추출합니다. 최대 1건이라는 한계를 응답에 정직하게 답니다.

**PostgreSQL** — `pg_stat_database.deadlocks`의 누적값을 읽고, OpsAlert가 폴 사이 **델타**를 봅니다. 늘었으면 "새 데드락 N건". 단, 첫 관측(직전 값 없음)이나 카운터 감소(통계 리셋)는 알리지 않습니다 — 과거분을 새 사건으로 오인하지 않으려고요.

## 3. 라이브 — 조사와 정반대였던 현실

이 아크의 하이라이트는 SQL Server에서 나왔습니다.

착수 조사 때 "ring_buffer 타깃은 SQL Server 2022에서 `xml_deadlock_report`를 빈 결과로 준다"는 사례를 읽었습니다. 그래서 **파일 타깃으로 고정**했죠. 코드도 그렇게 짰고요.

그런데 실제로 두 세션을 크로스 락으로 데드락시키고(Process 65가 victim으로 롤백, `Msg 1205`) 조회했더니 — **빈 배열**이 돌아왔습니다. 파일 타깃을 직접 세어보니 `xml_deadlock_report` 0건. 그런데 인메모리 링버퍼를 세어보니 **1건**. 조사와 **정반대**였어요. 이 컨테이너(SQL Server 2022 Linux)에서는 방금 발생한 데드락이 **링버퍼엔 즉시 있지만 `.xel` 파일에는 아직 flush되지 않은** 것이었습니다.

정답은 "둘 중 뭘 믿을까"가 아니라 **"둘 다 읽고 내용으로 중복 제거"**였습니다. 파일 타깃(과거 롤오버 포함)과 링버퍼(가장 최근)를 모두 읽어, 시각·victim·리소스로 dedup. 어느 한쪽의 한계(파일은 flush 지연, 링버퍼는 용량 제한)에도 최근 데드락을 놓치지 않게. 고치고 다시 조회하니 정확히 잡혔습니다.

![SQL Server 데드락 카드 — system_health XE에서 victim(spid 65)·경합 PK 인덱스·두 트랜잭션 SQL](/uploads/project/dbtower/deadlock-mssql.png)

MySQL도 같은 방식으로 크로스 락을 걸어 `ERROR 1213`을 유발했고, "LATEST DETECTED DEADLOCK"에서 victim(트랜잭션 2 롤백), 두 UPDATE 문, 경합 리소스(`index PRIMARY of table sample.dl_demo`)를 정확히 파싱했습니다.

![MySQL 데드락 카드 — INNODB STATUS의 최근 1건, victim·PRIMARY 인덱스·문장](/uploads/project/dbtower/deadlock-mysql.png)

PostgreSQL은 같은 크로스 락으로 `deadlock detected`를 유발하니 `pg_stat_database.deadlocks`가 **0에서 1로** 올랐습니다. OpsAlert의 델타 로직(첫 관측은 조용, 증가 시 알림, 반복 억제)은 폴 주기 타이밍에 의존하지 않도록 단위 테스트로 못박았습니다.

## 4. 마치며 — "최근만"이라는 정직

이번에도 배운 건 통일의 방법이 아니라 **차이를 인정하는 방법**이었습니다. 데드락이라는 하나의 축을, 리포트를 주는 두 기종과 카운터만 주는 한 기종으로 갈라 각자의 최선으로 읽었습니다.

그리고 공통의 정직한 한계를 남깁니다 — 세 경로 모두 **롤링/최신 저장**이라 "최근"만 봅니다. MySQL은 아예 1건, MSSQL·PG도 용량 상한이 있어 오래된 데드락은 관측 범위 밖이에요. 과거 전수 이력을 보장하지 않는다는 걸 카드와 응답에 그대로 적었습니다. "지금 막 났고 반복되고 있나"를 보는 데는 충분하고, 그 이상을 보장하는 척하지 않는 게 이 기능의 값을 지키는 길이라고 봤습니다.

조사 문서가 "파일 타깃을 써라"라고 했을 때 그대로 믿고 끝냈다면, 데모에서 데드락이 안 잡히는 걸 "원래 그런가 보다" 하고 넘겼을지도 모릅니다. 라이브로 직접 유발해 보지 않았다면 몰랐을 일이죠 — 실측이 문서를 이깁니다.

코드와 실측 기록 전체는 [GitHub](https://github.com/dj258255/dbtower)에 있습니다.

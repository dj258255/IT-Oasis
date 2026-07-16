---
title: '여유 77%인데 치명 경보가 맞다 — 디스크 포화 예측과, 같은 서버라서 두 번 울리던 경보'
titleEn: 'A Critical Alert at 77% Free Is Correct — Disk Saturation Forecasting, and Alerts That Fired Twice for the Same Server'
description: '이기종 DBMS 운영 관리 플랫폼 DBTower 18편. 지금까지의 신호는 전부 "DB"의 신호였는데, DB 장애의 큰 축은 DB 바깥(호스트)에서 옵니다. 전반부는 디스크 포화 예측 — 잔량이 아니라 속도를 봅니다. 여유가 76.8%나 남았는데 치명 경보가 뜨는 화면을 실쓰기 부하로 직접 만들었는데, 초당 17MB씩 줄고 있으면 20시간 뒤 장애라서 이 경보가 맞습니다. 그 과정에서 node-exporter가 rootfs 마운트 없이 컨테이너 자기 자신만 보고 있던 함정과, mountpoint="/" 고정이 실무(데이터 전용 마운트)와 어긋나는 설계 함정을 밟았습니다. 후반부는 서버 공유 인지 — 등록 단위는 DB인데 물리 단위는 서버라, 같은 서버에 DB 두 개를 등록하면 세션·복제·데드락 경보가 두 번 울립니다. 그룹당 1회로 줄이되 "누구에게 해당하는지"를 명시하고, 헬스 스코어(위험 귀속)는 일부러 dedup하지 않은 선 긋기를 기록했습니다.'
descriptionEn: 'Part 18 of DBTower. Every signal so far was a "database" signal, but a large class of DB failures comes from outside the DB — the host. First half: disk saturation forecasting that watches the rate, not the remainder. I produced a screen where a CRITICAL fires at 76.8% free by writing real load — at 17MB/s of shrinkage that disk dies in 20 hours, so the alert is right. Along the way: node-exporter silently watching only its own container without a rootfs mount, and the design trap of pinning mountpoint="/" when real DB data lives on dedicated mounts. Second half: server-sharing awareness — registration units are databases but physical units are servers, so two DBs on one server meant every session/replication/deadlock alert fired twice. Deduped to once per group with an explicit "applies to all of..." note, while deliberately NOT deduping health scores: both databases really are at risk.'
date: 2026-07-18
tags:
  - Java
  - Spring Boot
  - Prometheus
  - Monitoring
  - DBRE
category: personal/DBTower
coverImage: /uploads/project/dbtower/cover.svg
draft: false
series: "DBTower"
seriesOrder: 18
---

## 0. 들어가며, DB만 보던 관제탑

지금까지 DBTower의 신호는 전부 "DB의 신호"였습니다. 쿼리가 느려졌다, 복제가 밀린다, 백업이 오래됐다. 그런데 DB 운영에서 예고가 가장 길고, 그런데도 가장 자주 터지는 장애가 하나 있습니다 — 디스크가 차는 것. WAL이, binlog가, 데이터 파일이 차오르는 속도는 며칠 전부터 보이는데, 그 예고를 읽는 쪽이 없었습니다. 디스크는 DB가 아니라 호스트의 자원이라서요. 이번 편은 그 "호스트라는 차원"을 플랫폼에 넣은 기록입니다.

## 1. 잔량이 아니라 속도

디스크 경보의 흔한 형태는 "여유 10% 미만"입니다. 이게 놓치는 케이스가 있습니다 — 여유가 77%인데 초당 17MB씩 줄고 있으면, 그 디스크는 20시간 뒤에 죽습니다. 잔량 경보는 마지막 순간까지 침묵하다가 손쓸 시간이 없을 때 웁니다.

그래서 계산을 바꿨습니다. 선형 추세 ETA — 여유 바이트를 최근 6시간의 감소 속도로 나누면 "이 속도면 며칠 뒤 0이 되는가"가 나옵니다(PromQL로는 `avail / -deriv(avail[6h])`). 3일 안이면 치명, 14일 안이면 경고, 추세가 없어도 여유가 10% 미만이면 경고. 그리고 문안에 한 줄을 반드시 넣었습니다 — "선형 추세 가정, 예측이지 사실이 아님". 예측을 사실처럼 말하는 순간 이 플랫폼의 정직이 무너지니까요.

실제로 확인하고 싶어서 부하를 진짜로 만들었습니다. MySQL 볼륨에 15초마다 256MB씩 실제로 쓰는 루프를 돌리고 어드바이저를 호출하니 —

![Advisors 카드 — 여유 76.8%인데 치명: 약 0.7일 내 포화](/uploads/project/dbtower/disk-forecast-critical.png)

여유 76.8%, 치명. 잔량만 보는 경보 체계라면 이 화면에서 아무 일도 일어나지 않았을 겁니다.

## 2. 함정 두 개 — 자기 자신만 보던 exporter, "/"라는 고정관념

구현보다 배선에서 두 번 넘어졌습니다. 첫 번째: 데모 스택의 node-exporter가 **컨테이너 자기 자신만 보고 있었습니다**. 쿼리를 날려보니 `mountpoint="/"` 시계열 자체가 없었어요. node-exporter를 컨테이너로 띄울 땐 호스트 루트를 읽기 전용으로 마운트하고(`/:/host:ro`) `--path.rootfs=/host`를 줘야 호스트의 디스크가 보입니다 — 공식 가이드의 첫 줄인데, 마운트 없이도 프로세스는 멀쩡히 뜨고 메트릭도 나오니 조용히 틀린 값을 보게 됩니다. 17편의 교훈 그대로입니다. 조용한 폴백이 제일 무섭습니다.

두 번째는 설계 함정이었습니다. 처음엔 볼 파일시스템을 `mountpoint="/"`로 고정했는데, 이건 실무와 어긋납니다 — DBA는 데이터를 전용 마운트(/data, /var/lib/mysql)에 두는 게 정석이라, 루트만 보면 정작 데이터 디스크를 놓칩니다. 그래서 인스턴스에 노드 매핑 필드(nodeFilter, Prometheus 라벨 셀렉터)를 달면서 규칙을 하나 넣었습니다. **nodeFilter가 mountpoint를 직접 지정하면 기본 "/"를 양보한다.** PromQL은 같은 라벨의 매처 두 개를 AND로 겹치기 때문에 기본값 위에 덮어쓸 방법이 없거든요 — 겹치는 순간 빈 결과가 됩니다. 참고로 이 필드는 쿼리에 그대로 삽입되므로 `label="value"` 나열 형식만 통과시킵니다. 셀렉터 주입으로 임의 PromQL이 실행되면 안 되니까요.

## 3. 같은 서버라서 두 번 울리던 경보

후반부는 반대 방향의 어긋남입니다. DBTower의 등록 단위는 DB(host·port·dbName)인데, 물리 단위는 서버입니다. 데모 스택에도 이미 있었습니다 — 한 PostgreSQL 서버에 local-postgres와 dbtower-self, 한 SQL Server에 local-mssql과 mssql-pitr. 그런데 세션, 복제 상태, 데드락은 전부 **서버 단위 관측**입니다. 같은 유휴 트랜잭션 하나가 두 인스턴스의 폴링에 각각 걸려 같은 사고 알림이 두 배로 갑니다. 탐침도 두 배고요.

해법은 계산 키 하나였습니다. `host:port`로 서버 그룹을 파생하고(엔티티 추가도, DNS 해석도 없이), 서버 전역 신호는 그룹 대표 한 곳에서만 탐침합니다. 실제로 공유 서버에 트랜잭션을 열어둔 채 방치하니 경보가 정확히 한 건, 이렇게 왔습니다 — "장기 유휴 트랜잭션 pid=45664 ... **(서버 127.0.0.1:15432 공유 — local-postgres, dbtower-self 전체에 해당)**". 마지막 줄이 중요합니다. dedup으로 경보가 대표 이름으로만 오면, 받은 팀이 "우리 DB 아니네" 하고 넘길 수 있으니까요. 줄이되, 누구에게 해당하는지는 명시합니다.

![인스턴스 카드 — 같은 host:port 페어에만 "서버 공유 ×2" 배지](/uploads/project/dbtower/server-shared-badge.png)

선을 하나 그었습니다. **dedup은 탐침과 경보에만 하고, 위험 귀속에는 하지 않습니다.** 같은 서버의 두 DB는 둘 다 실제로 위험합니다 — 헬스 스코어까지 반으로 줄이면 그게 오히려 왜곡입니다. 디스크 예측 어드바이저도 같은 원리로, 일일 스윕에서는 호스트당 1회만 돌고 나머지 인스턴스에는 "서버 공유 — 누가 대신 점검했나"를 남깁니다(생략을 숨기지 않고요). 스윕 로그로는 인스턴스 7개에 호스트 점검 2회 — 5회가 줄었습니다.

## 4. 덤 — 테스트가 지키고 있던 암묵의 계약

dedup을 넣다가 기존 테스트 세 개가 깨졌는데, 원인이 교훈이었습니다. 원래 코드는 감지 결과를 findings 리스트에 **하나씩 누적**했습니다 — 중간 감지 하나가 예외로 죽어도 그 전까지의 신호는 알림으로 나가는 구조죠. 저는 서버 스코프 신호를 중간 리스트에 모았다가 한 번에 합치도록 바꿨고, 그 순간 "부분 실패에도 부분 결과는 살아남는다"는 계약이 깨졌습니다. 아무 문서에도 없던 계약인데 테스트가 지키고 있었습니다. 동작을 검증하는 테스트는 이럴 때 값을 합니다.

다음은 스케일의 남은 조각들입니다 — 한 노드만 수집하는 현재 구조를 노드 여럿이 나눠 드는 수집 샤딩, 그리고 최대 볼륨 테이블의 파티셔닝. 관제탑이 관제 대상만큼 커질 차례입니다.

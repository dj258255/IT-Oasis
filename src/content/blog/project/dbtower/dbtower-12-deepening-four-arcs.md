---
title: '완결 뒤에 더 깊이 — 다섯 기종을 파고든 네 개의 심화 아크'
titleEn: 'Deeper After Done: Four Deepening Arcs Across Five Engines'
description: "이기종 DBMS 운영 관리 플랫폼 DBTower 12편. 로드맵을 완주하고 완결을 선언한 뒤, 남겨둔 숙제를 붙잡고 다시 파고들었습니다. 네 개의 심화 아크를 한 편에 압축합니다. (1) 실행계획 변경(plan flip) 감지를 PostgreSQL만 되던 것에서 다섯 기종으로 완성 — 계획 형태를 얻는 경로가 기종마다 전혀 달라(MySQL 리터럴 샘플 재EXPLAIN, SQL Server Query Store, Oracle plan_hash_value, Mongo 프로파일러 명령) shape 정규화 한 겹으로 통일. (2) p95의 정직 등급을 올리기 — 누적을 최근 구간으로(0.48→0.19), 미지원을 추정으로, 프로파일러가 꺼져도 인스턴스 p95를 살리고, 못 올리는 Oracle은 그대로 두어 라벨로 대비. (3) 설정 변경 0으로 데드락 읽기 — 세 기종의 관측 입도가 다르고, 조사와 정반대로 데드락이 파일이 아니라 링버퍼에만 있던 현실. (4) 관제가 부하가 되지 않게 하는 스케일 제어 다섯 축. 라이브에서 2^64 센티넬 오버플로와 최소권한 조용한 폴백 같은 진짜 버그도 잡았습니다."
descriptionEn: "Part 12 of DBTower. After completing the roadmap and declaring done, I went back to the homework I had left and dug deeper. Four deepening arcs, condensed into one post: (1) completing plan-flip detection from PostgreSQL-only to all five engines, where the path to obtain a plan shape differs wildly per engine and a single shape-normalization layer unifies them; (2) raising p95's honesty grade — cumulative to recent-window (0.48 to 0.19), unsupported to estimated, keeping an instance p95 alive even with the profiler off, and leaving Oracle unraised so labels contrast; (3) reading deadlocks with zero config change across three engines of different observation granularity, where the deadlock lived in the ring buffer, not the file — the opposite of the research; (4) five axes of scale control so the watchtower never becomes the load. Live measurement caught real bugs like a 2^64 sentinel overflow and a least-privilege silent fallback."
date: 2026-07-07
tags:
  - Java
  - Spring Boot
  - DBRE
  - Query Optimization
  - Observability
  - MySQL
  - SQL Server
  - Oracle
  - MongoDB
category: personal/DBTower
coverImage: /uploads/project/dbtower/cover.svg
draft: false
series: "DBTower"
seriesOrder: 12
---

## 0. 들어가며 — 완결을 선언하고, 다시 파고들다

앞 편에서 로드맵을 완주하고 "완결"을 선언하면서, 정직하게 숙제 세 개를 남겨뒀습니다. 그리고 그 숙제를 붙잡고 넉 달을 더 파고들었어요. 결과가 **네 개의 심화 아크**입니다. 하나하나가 별도 글이었을 만큼 깊지만, 관통하는 태도가 같아 한 편에 압축합니다 — **못 하는 걸 하는 척하지 않고, 아는 만큼만 정직하게 말하되, 그 아는 것을 라이브로 확인한다.**

## 1. 하나의 기능을 다섯 기종으로 — 플랜 플립 완성

"쿼리도 데이터도 그대로인데 갑자기 느려졌다"면 옵티마이저가 계획을 갈아탄 겁니다(plan flip). 이 감지는 그동안 **PostgreSQL만** 완전했어요. 정규화된 쿼리($1·?)로 계획을 얻는 길이 PG에만 있었거든요.

다섯 기종으로 완성하면서 다시 만난 건 이기종의 현실이었습니다 — **같은 '계획 형태'를 얻는 경로가 기종마다 전혀 다릅니다.** MySQL은 `performance_schema`가 저장한 리터럴 샘플(`QUERY_SAMPLE_TEXT`)을 EXPLAIN하고, SQL Server는 Query Store가 축출 없이 보존하는 계획 이력을 그대로 읽고, Oracle은 `plan_hash_value`가 곧 계획 식별자이며, MongoDB는 프로파일러가 저장한 실제 명령을 explain으로 재실행합니다.

핵심 설계는 이 이질성을 **인터페이스 하나 뒤로 숨긴 것**이었어요. `planShapeForDigest` 메서드 하나가 기종별로 계획을 뽑고, 그 앞의 판정 로직은 다섯 기종을 하나처럼 다룹니다. JSON·XML·해시로 제각각인 계획 표현은 `PlanShapes` 정규화 한 겹으로 흡수해 — 구조는 남기고 비용·행수는 버려서 — 비교 가능한 문자열로 만듭니다. 새 기종은 이 메서드 하나만 채우면 됩니다.

## 2. 정직 등급을 올리는 법 — 다섯 p95의 다섯 사다리

레이턴시 백분위(p95)는 이미 다섯 기종에서 값을 냈지만, 그 값들의 **신뢰 등급이 제각각**이었습니다. MySQL은 리셋 이후 누적이라 최근 급변을 늦게 반영하고, SQL Server·Oracle은 아예 미지원, PostgreSQL은 추정치였죠.

이번엔 값을 더 내는 게 아니라 등급을 올렸습니다. 기종마다 사다리가 다 달랐어요.

- **MySQL** — 누적 히스토그램을 직전 스냅샷과 버킷별로 차분해 "최근 구간" p95를 복원. 같은 쿼리가 **누적 0.48ms → 구간 0.19ms**로 갈립니다. 최근 부하가 빠른 인덱스 조회라 누적보다 낮게 나온 거죠.
- **SQL Server** — Query Store가 켜지면 미지원을 풀어 avg+stdev 추정치(ESTIMATED)를 냅니다.
- **MongoDB** — `serverStatus.opLatencies` 히스토그램으로 **프로파일러가 꺼져도** 인스턴스 p95를 살립니다. 기존 프로파일러 기반 계산이 전멸하는 상황에서 유일한 관측이 되죠.
- **PostgreSQL / Oracle** — PG는 확장이 있으면 승격, **Oracle은 원자료가 없어 끝내 못 올려 UNSUPPORTED로 남겼습니다.** 넷은 올리고 하나는 못 올린 걸 라벨이 정직하게 가릅니다.

![레이턴시 카드 — 실측누적·실측구간·히스토그램·추정·미지원이 배지로 갈린다](/uploads/project/dbtower/latency-windowed.png)

그리고 라이브에서만 잡히는 **진짜 버그 두 개**를 잡았어요. MySQL 히스토그램 마지막 버킷의 상한이 unsigned bigint 최댓값(2^64-1) 센티넬이라 `getLong()`이 오버플로했고(→ BigDecimal), 모니터링 계정이 히스토그램 뷰 권한만 빠져 조용히 누적값으로 폴백하던 걸 경고 로그로 드러냈습니다. 단위 테스트의 합성 데이터엔 없던 것들이라, 라이브가 아니면 몰랐을 버그였습니다.

## 3. 설정 변경 0으로 데드락을 읽다 — 세 기종, 세 입도

데드락은 자체 회복(한쪽 롤백)되지만 애플리케이션 오류로 드러나고, 반복되면 락 순서를 점검해야 하는 신호입니다. DB는 이미 흔적을 남기므로 **설정을 바꾸지 않고** 읽었어요 — 그런데 세 기종의 관측 입도가 근본적으로 달랐습니다.

SQL Server의 `system_health` 확장 이벤트는 데드락마다 victim·프로세스·리소스를 XML로 남기고(가장 풍부), MySQL의 `SHOW ENGINE INNODB STATUS`는 **가장 최근 1건만** 텍스트로 보여주며, PostgreSQL은 개별 사건 없이 **누적 카운터**만 줍니다. 그래서 앞 둘은 리포트 파싱으로, PG는 카운터 델타 알림으로 갈랐습니다.

이 아크의 하이라이트는 SQL Server에서 나왔어요. 착수 조사는 "ring_buffer 타깃은 2022에서 빈 결과를 준다"며 파일 타깃을 쓰라 했습니다. 그대로 짰죠. 그런데 실제로 데드락을 유발하고 조회하니 **빈 배열**이 돌아왔습니다. 파일 타깃엔 0건, 인메모리 링버퍼엔 1건 — **조사와 정반대**였어요. 방금 난 데드락이 파일엔 아직 flush되지 않고 링버퍼에만 있던 겁니다. 정답은 "둘 다 읽고 내용으로 중복 제거"였습니다.

![SQL Server 데드락 카드 — system_health XE에서 victim·경합 인덱스·문장까지](/uploads/project/dbtower/deadlock-mssql.png)

조사 문서를 그대로 믿었다면 "데모에서 데드락이 안 잡히나 보다" 하고 넘어갔을 겁니다. **실측이 문서를 이깁니다** — 이건 뒤에서 또 반복됩니다.

## 4. 관제가 부하가 되지 않게 — 스케일 제어 다섯 축

인스턴스가 몇 개일 땐 안 보이던 게 수십 개가 되면 드러납니다. 직렬 수집이 주기를 넘기고, 폴러 하나가 느려지면 뒤 전부가 밀리고, 대량 장애 때 알림이 채널을 도배하죠. "진단이 부하 유발자가 되면 안 된다"는 원칙을 **규모의 축**으로 확장했습니다.

수집을 워커 풀로 병렬화하되 ShedLock의 노드 배타는 유지하고(병렬은 노드 안에서만), 스케줄러 풀을 분리해 폴러들이 서로를 안 막게 하고, 알림에 분당 상한을 두되 초과분은 버리지 않고 "N건 더" 한 줄로 묶고, 문제 인스턴스를 삭제 없이 격리하는 토글을 달고, 헬스 스코어를 노드별로 캐시했습니다. 실측에서 인스턴스 14개를 워커 풀이 1.2초에 수집했고, 하나를 격리하니 그것만 수집 0건·나머지 13개만 잡혔습니다.

![인스턴스 목록 — 전부 '수집중', 격리한 하나만 '격리됨' 배지](/uploads/project/dbtower/collection-toggle.png)

## 5. 마치며 — 관통한 하나의 태도

네 아크에 새 축은 많지만, 관통한 건 하나였습니다. Oracle p95를 억지로 안 올리고 UNSUPPORTED로 둔 것, 데드락이 "최근만" 보인다고 명시한 것, 병렬이 "노드 안에서만"이라 못박은 것 — **한계를 감추지 않는 게 기능의 신뢰를 지켰습니다.** 그리고 매 아크에서 라이브 실측이 문서·조사를 이겼어요(ring_buffer 역전, 2^64 센티넬).

이 태도를 스스로에게도 적용하고 싶었습니다. "그럼 내가 만든 이것들엔 무슨 결함이 있지?" — 그게 다음 편, 자기 검증의 시작이었습니다.

각 아크의 상세 설계와 실측 기록(VERIFICATION 57~61절)은 [GitHub](https://github.com/dj258255/dbtower)에 있습니다.

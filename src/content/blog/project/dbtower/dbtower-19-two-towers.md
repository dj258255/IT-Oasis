---
title: '관제탑이 두 대가 될 때 — 나눠 드는 수집, 노드를 오가도 하나인 잠금, 지우는 대신 떨어뜨리는 파티션'
titleEn: 'When the Control Tower Becomes Two — Sharded Collection, One Lockout Across Nodes, and Dropping Instead of Deleting'
description: '이기종 DBMS 운영 관리 플랫폼 DBTower 19편. 스케일 3부작입니다. 첫째, 수집 샤딩 — 지금까지는 노드를 늘려도 분산 락 하나 때문에 수집은 한 노드만 했습니다. 샤드별 락으로 바꾸니 두 노드가 일을 나눠 들고, 한 노드를 죽이면 남은 노드가 설정 변경 없이 전 샤드를 인수합니다. 같은 쿠키로 로그인도 살아남으니 진짜 무중단입니다. 둘째, 로그인 잠금 카운터를 메타 DB로 — 인메모리 카운터는 노드마다 독립이라 LB 뒤에서는 실패 허용치가 사실상 노드 수배였습니다. 노드 A에서 두 번, B에서 한 번 틀리자 네 번째 시도가 잠기는 것을 실측했습니다. 셋째, 최대 볼륨 테이블의 월별 파티셔닝 — 보존 정리가 200만 행 DELETE 1.9초에서 파티션 DROP 12.8ms가 됐고, DELETE가 남기던 블로트(생존 17만 행에 404MB)는 존재 자체가 사라졌습니다. 덤으로 커넥션 온디맨드 — 격리한 대상의 유휴 커넥션이 1개 영구에서 0으로 수렴합니다.'
descriptionEn: 'Part 19 of DBTower — a scale trilogy. First, sharded collection: adding nodes used to change nothing because one distributed lock meant one collector; per-shard locks let two nodes split the work, and killing one node makes the survivor take over every shard with zero configuration — while the same session cookie keeps working. Second, the login lockout counter moved to the meta DB: in-memory counters are per-node, so behind a load balancer the real threshold was N times higher; I measured two failures on node A plus one on node B locking the fourth attempt. Third, monthly partitioning of the biggest table: retention went from a 1.9-second 2M-row DELETE (leaving 404MB of bloat for 170k live rows) to a 12.8ms partition DROP with no bloat at all. Plus connections on demand: an isolated target now converges to zero idle connections instead of holding one forever.'
date: 2026-07-20
tags:
  - Java
  - Spring Boot
  - PostgreSQL
  - HA
  - DBRE
category: personal/DBTower
coverImage: /uploads/project/dbtower/cover.svg
draft: false
series: "DBTower"
seriesOrder: 19
---

## 0. 들어가며, 노드를 늘렸는데 아무것도 안 늘었다

17편에서 세션을 메타 DB로 옮기며 "노드를 늘릴 준비"를 했다고 썼는데, 정작 노드를 늘려보면 민망한 일이 벌어집니다. 수집도, 경보도, 스윕도 전부 분산 락(ShedLock)으로 "한 시점에 한 노드만"을 보장해뒀기 때문에 — 두 번째 노드는 락 획득에 실패하고 놀기만 합니다. 고가용성이지 수평 확장이 아니었던 거죠. 이번 편은 그 간극을 메운 스케일 3부작입니다.

## 1. 락 하나를 락 N개로 — 나눠 들기와 페일오버를 한 번에

수집 샤딩의 설계는 락을 쪼개는 것뿐입니다. `shards=4`면 틱마다 샤드 0~3의 락(`snapshot-collect-0`...`-3`)을 각각 시도하고, 획득한 샤드의 인스턴스(`instanceId % 4`)만 수집합니다. 이 단순한 구조가 좋은 이유는 **분산과 페일오버가 같은 메커니즘**이라는 겁니다. 노드가 둘이면 락 경쟁으로 일이 자연히 갈라지고(실측: A가 샤드 1·2·3, B가 샤드 0), 한 노드를 죽이면 다음 틱에 남은 노드가 락 네 개를 다 잡습니다 — 설정 변경도, 리밸런싱 프로토콜도 없이요. consistent hashing 같은 것도 필요 없습니다. 스냅샷은 누적 카운터의 차분이라 담당이 바뀌어도 데이터가 깨지지 않거든요.

실제로 A를 kill하고 지켜봤습니다. 다음 틱에 B의 로그에 `shard=0/4, 1/4, 2/4, 3/4`가 나란히 찍히고, A에서 로그인했던 쿠키는 B에서 그대로 200을 받습니다. 수집 공백도, 재로그인도 없는 진짜 무중단입니다.

![페일오버 후 node B가 같은 세션으로 콘솔을 서빙한다](/uploads/project/dbtower/node-b-survivor.png)

디테일 하나 — shards=1(기본)이면 락 이름을 기존 것 그대로 씁니다. 롤링 배포 중에 구버전 노드와도 같은 락을 다퉈야 하니까요. 반대로 샤드 수를 바꿀 땐 전 노드 동시 적용이 전제입니다. 노드마다 N이 다르면 `id % N` 계산이 어긋나 같은 인스턴스를 두 노드가 수집합니다.

## 2. 노드를 오가며 틀려도 잠긴다

두 번째는 부끄러운 종류의 구멍입니다. 로그인 브루트포스 방어(연속 실패 10회 잠금)를 예전에 만들면서 "인메모리라 노드마다 독립 — Phase 3에서 재검토"라고 정직하게 적어뒀는데, 노드가 진짜 둘이 되니 그 문장의 의미가 명확해졌습니다. **LB 뒤에서는 실패 허용치가 노드 수배가 됩니다.** 공격자가 요청을 분산시키면 노드마다 따로 세니까요. 재시작하면 잠금이 풀리는 것도 덤이었고요.

해법은 세션 때와 같은 논리입니다 — 이미 있는 메타 DB를 공유 스토어로. 계정별 실패 수와 잠금 해제 시각을 테이블 한 장에 두면 어느 노드로 오든 카운터는 하나입니다. 실측은 임계를 3으로 낮춰서: 노드 A에서 한 번, B에서 한 번, 다시 A에서 한 번 틀리자 — 네 번째 시도가 B에서 `error=locked`를 받았습니다.

![노드를 오간 실패 3회 뒤 잠금 — 카운터가 메타 DB라 분산 우회가 안 된다](/uploads/project/dbtower/cross-node-lock.png)

동시성은 정직하게 타협했습니다. 두 노드가 같은 계정의 실패를 동시에 쓰면 카운트 하나가 유실될 수 있는데, 임계 10회 스케일에서 한두 회 유실은 잠금 시점을 미세하게 늦출 뿐입니다. 그 오차를 없애자고 비관 락을 거는 건 배보다 배꼽이라, 감수한다고 주석에 적어뒀습니다.

## 3. 지우지 말고 떨어뜨려라

세 번째는 메타 DB 자신의 노화 문제입니다. 쿼리 통계 테이블은 인스턴스 5대 기준 하루 72만 행이 쌓이고, 보존 정리(7일)는 매시간 벌크 DELETE였습니다. 측정해보니 문제가 둘이었습니다. 합성 200만 행을 지우는 데 **1.9초** — 그리고 더 나쁜 건, 지운 뒤에도 공간이 안 돌아온다는 겁니다. VACUUM까지 돌렸는데 생존 17만 행짜리 테이블이 **404MB**를 붙잡고 있었습니다. PostgreSQL의 DELETE는 dead tuple을 남기고, 일반 VACUUM은 파일을 줄여주지 않으니까요.

월별 RANGE 파티션으로 바꾸면 이야기가 달라집니다. 지난달 전체를 지우는 건 DELETE가 아니라 `DROP TABLE` — 실측 **12.8ms**, 147배 빠르고 블로트가 아예 생기지 않습니다(파일 삭제니까). 기한이 걸쳐 있는 파티션 내부는 여전히 DELETE가 맡지만, 파티션 프루닝 덕에 그 파티션만 스캔하고, 남는 블로트도 그 파티션이 다음 달 떨어질 때 함께 사라집니다. 블로트의 수명이 유한해지는 거죠.

전환에서 함정 둘. 기존 테이블은 ALTER로 파티션 테이블이 될 수 없어서 신 테이블 생성 → 복사 → 스왑을 한 트랜잭션으로 묶었고(17만 행 기준 1.6초 — 부산물로 404MB가 55MB로, 스왑이 곧 재작성이라), PostgreSQL 16은 **파티션 테이블에 identity 컬럼을 지원하지 않습니다**(17부터). 시퀀스 DEFAULT로 바꾸고 PK에 파티션 키를 포함시켰습니다. 파티션 선생성(이번 달·다음 달)과 만료 DROP은 기존 보존 잡이 맡습니다 — 이름 규약(`query_snapshot_y2026m07`)을 파싱해 "그 달 전체가 기한을 지난" 파티션만 보수적으로 떨어뜨리고, 규약 밖 자식은 건드리지 않습니다.

## 4. 덤 — 안 쓰는 대상에 커넥션을 꽂아두지 않기

마지막 조각은 커넥션입니다. 인스턴스별 풀의 minimumIdle이 1이라, 격리(수집 제외)한 대상에도 유휴 커넥션 1개가 영구히 꽂혀 있었습니다. 관제 대상이 수백 대면 그만큼의 커넥션 슬롯을 관제 도구가 상시 점유하는 셈이죠. 조사하다 더 재미있는 걸 발견했는데 — 격리했는데도 processlist의 Sleep 시간이 계속 리셋되는 겁니다. 범인은 SLO 헬스 폴러였습니다. 격리 플래그를 안 보고 60초마다 핑을 날리고 있었어요. 격리의 목적이 "문제 대상을 두드리지 않기"인데 핑이 그걸 뚫고 있었던 거죠.

minimumIdle을 0으로, 유휴 종료와 최대 수명을 명시하고, 오래 안 쓰인 풀은 통째로 닫도록 했습니다(다음 사용 시 재생성). 여기에도 하한 가드가 하나 필요했습니다 — idleTimeout이 수집 주기보다 짧으면 활발한 대상조차 틱마다 물리 재연결을 하게 돼 풀의 존재 이유가 사라지니, 주기+30초를 하한으로 강제합니다. 실측: 격리 후 커넥션 0 수렴, 해제하면 다음 틱에 풀이 되살아나 수집 재개. 활발한 대상은 아무 변화 없음(커넥션이 계속 따뜻하니까).

이제 로드맵의 큰 조각들이 거의 다 찼습니다. 다음은 정리의 시간입니다 — 46장의 검증 스크린샷과 82개의 실측 절을 포트폴리오답게 매만지는 일이요.

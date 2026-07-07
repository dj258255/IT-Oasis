---
title: '로드맵을 완주하고 남겨둔 숙제 세 개 — 플랜 플립 감지, 3-2-1 완성, TLS의 벽'
titleEn: 'Three Assignments Left After Finishing the Roadmap — Plan Flip Detection, Completing 3-2-1, and the TLS Wall'
description: "이기종 DBMS 운영 관리 플랫폼 DBTower 11편. 10편에서 로드맵을 완주했지만, 문서에 '정직한 잔여'로 남겨둔 것들이 있었습니다. 새 기능 축을 늘리는 대신 그중 셋을 골라 깊이 팠습니다. '쿼리도 데이터도 그대로인데 갑자기 느려짐 = 옵티마이저가 플랜을 갈아탐'이라는 현업 단골 장애를 잡는 실행계획 변경 감지 — 정규화 텍스트($1)는 EXPLAIN이 안 된다는 벽을 PostgreSQL 16의 GENERIC_PLAN으로 넘고, 추정치를 버린 계획 shape만 해시 비교해 가짜 변경을 막고, 회귀 감지된 쿼리만 계획을 뜨는 부하 원칙까지. 그리고 로컬에만 있던 백업을 S3 호환 오프사이트로 올려 3-2-1을 완성한 이야기(업로드 실패는 백업 실패가 아니다), TLS 강제 관리형 서비스에 붙지 못하던 벽을 제거하되 인증서 검증 우회 옵션은 일부러 안 만든 결정까지 — 전부 실측으로 닫습니다."
descriptionEn: "Part 11 of DBTower. Part 10 declared the project complete — but the docs honestly listed leftovers. Instead of adding new feature axes, I picked three and dug deep: plan-flip detection for the classic incident where 'the query and data are unchanged but suddenly slow = the optimizer swapped plans' — crossing the wall that normalized statement texts ($1) cannot be EXPLAINed via PostgreSQL 16's GENERIC_PLAN, hashing only the plan shape (estimates stripped) to avoid false flips, and diagnosing only already-regressed queries per the load principle; completing the 3-2-1 rule by shipping backups to S3-compatible offsite storage (an upload failure is not a backup failure); and removing the TLS wall for managed services while deliberately not offering a certificate-verification bypass."
date: 2026-07-06
tags:
  - Java
  - Spring Boot
  - DBRE
  - PostgreSQL
  - Query Optimization
  - S3
category: personal/DBTower
coverImage: /uploads/project/dbtower/cover.svg
draft: false
series: "DBTower"
seriesOrder: 11
---

## 0. 들어가며 — 완주 선언의 각주

[10편](/blog/project/dbtower/dbtower-10-guardrails-and-selfhost)에서 로드맵 완주와 v1.0.0을 선언했어요. 그런데 그 선언에는 각주가 붙어 있었습니다 — 문서 곳곳에 "정직한 잔여"로 남겨둔 것들이요. 백업 원격 보관은 VERIFICATION 29절에, TLS는 셀프호스트 점검에서, 그리고 발행 후 리뷰에서 나온 "검증 루프" 계열의 다음 질문이 하나 더 있었죠.

새 기능 축을 늘리는 건 이제 아니라고 판단했어요 — 축을 늘리면 정체성이 흐려집니다. 대신 기준 하나로 셋을 골랐습니다: **기존 축의 구멍 중에서, 실사용자가 실제로 부딪히거나 현업 장애가 실제로 지나가는 자리.** 그렇게 고른 셋이 실행계획 변경 감지, 백업 오프사이트, TLS입니다.

## 1. 플랜 플립 — "쿼리는 그대로인데 갑자기 느려요"

현업 단골 장애 중에 이런 게 있어요. 배포도 없었고 쿼리도 데이터도 그대로인데 어느 날 갑자기 느려짐. 원인은 **옵티마이저가 플랜을 갈아탄 것**(plan flip)입니다 — 통계가 임계를 넘어가며 인덱스 스캔이 풀스캔으로 뒤집히는 식이죠. pganalyze의 plan change alerts, PMM의 Query Analytics가 정확히 이걸 잡는 기능이에요.

DBTower의 회귀 감지(2편)는 "느려졌다"까지는 잡지만 "**계획이 바뀌어서** 느려졌다"는 못 말해줬습니다. 진단 스택의 마지막 구멍이었어요.

**벽 — 정규화 텍스트는 EXPLAIN이 안 된다.** 구현하려고 보니 근본적인 문제가 있었습니다. 통계 소스(pg_stat_statements 등)의 쿼리 텍스트는 리터럴이 지워진 정규화 형태예요 — `WHERE k = $1`. 이걸 그대로 EXPLAIN에 넣으면 "파라미터 값이 없다"고 거부됩니다. 리터럴을 임의 값으로 채우는 방법도 생각했지만 버렸어요 — 값에 따라 다른 플랜이 나오니 **가짜 변경**을 만들어내는 짓입니다.

답은 PostgreSQL 16에 있었습니다. `EXPLAIN (GENERIC_PLAN)` — 정확히 이 용도로 만들어진 기능으로, 파라미터 플레이스홀더를 채우지 않고 제네릭 플랜을 산출합니다. 다른 기종에는 이런 수단이 없어서, 플레이스홀더가 없는 텍스트만 시도하고 있으면 스킵합니다. 못 하는 걸 지어내지 않는 것 — 이 시리즈의 규칙 그대로예요.

**비교 대상은 계획의 "형태"만.** 계획 원문을 그대로 해시하면 안 됩니다. 비용·추정 행수는 통계가 조금만 변해도 흔들려서 매번 "변경"이 되거든요. 그래서 노드 종류·인덱스·대상 테이블만 남긴 shape(`Index Scan(idx_k)` vs `Seq Scan(plan_demo)`)를 만들어 그 해시만 비교합니다. "같은 구조, 다른 추정치 = 같은 플랜"을 단위 테스트로 고정했어요.

**트리거는 회귀만.** 모든 쿼리의 계획을 매번 뜨면 진단이 부하 유발자가 됩니다(10편의 A9 원칙). 그래서 레이턴시/행수 회귀가 **이미 감지된** 쿼리만 계획을 뜹니다 — 추정 explain이라 실행 부하도 없어요. 첫 관측은 기준선으로 조용히 저장되고, 두 번째부터 비교가 성립합니다.

**실측 — 4막짜리 e2e.** 같은 digest의 쿼리로 시나리오를 돌렸습니다. 30만 행 테이블(k=2가 30만, k=1이 10행)에 인덱스를 걸고:

```
P1  좁은 범위(101행, 인덱스)          -> 평균 0.03ms — 조용
P2  넓은 범위(25만행, 같은 digest)    -> 레이턴시 회귀 발화
    -> 기준선 저장: Aggregate>[Index Only Scan(idx_plan_demo_k)]
P3  좁은 범위(회복)                   -> 조용 (개선은 회귀가 아니다)
P4  인덱스 드랍 -> 좁은 범위          -> 60초 뒤 감지:
    "실행계획 변경 확인: ... WHERE k BETWEEN $1 AND $2
     — Aggregate>[Index Only Scan(idx_plan_demo_k)]
     -> Aggregate>[Gather>[Aggregate>[Seq Scan(plan_demo)]]]"
    (동반: 레이턴시 회귀 평균 0.03 -> 6.23ms, +23,249%)
```

![실행계획 변경 카드 — Index Only Scan에서 Seq Scan으로 갈아탄 순간이 그대로 남는다](/uploads/project/dbtower/plan-change.png)

그런데 이 실측에 도달하기까지 함정을 둘 밟았어요 — 이 함정들이 이번 기능의 진짜 배움입니다.

**함정 1 — 모의 데이터가 시나리오를 배신한다.** 처음 만든 데모 테이블은 k 값이 2종(희소 10행 / 흔함 30만 행)인 스큐였는데, 이 구조에서는 **제네릭 플랜이 인덱스가 있어도 Seq Scan을 고릅니다.** 제네릭 플랜은 특정 값이 아니라 평균 선택도로 판단하는데, 값이 2종이면 평균 선택도가 50%라 인덱스가 이길 수 없거든요. 드랍 전후 shape가 똑같으니 플립 자체가 성립 불가. k를 고유값 30만 개로 바꾸고 같은 digest를 유지하는 범위 쿼리(`BETWEEN $1 AND $2`)로 시나리오를 다시 설계했습니다. 감지기를 검증하려면 감지기가 아니라 **데이터부터 옵티마이저의 눈으로** 봐야 한다는 걸 배웠어요.

**함정 2 — 수동 검증과 자동화 경로는 다른 길을 탄다.** psql에서 `EXPLAIN (GENERIC_PLAN) ... $1`이 잘 돼서 구현했는데, 앱에서는 조용히 실패했습니다. psql은 simple query protocol이라 `$1`이 그냥 텍스트로 넘어가지만, **pgjdbc는 extended protocol이라 서버가 `$1`을 바인드 파라미터로 파싱**해 "0개 바인드" 에러가 나요. 이 호출만 `preferQueryMode=simple` 1회용 커넥션으로 풀었습니다 — 회귀 때만 드물게 실행되니 풀 우회 비용은 수용. "터미널에서 되는 것"과 "코드에서 되는 것" 사이의 프로토콜 층을 실측으로 확인한 셈이에요.

덤 하나. 텍스트 계획 폴백(숫자를 지워 구조만 비교)은 계획에 없던 곳에서 먼저 검증됐어요 — e2e 도중 Oracle 인스턴스의 회귀에 트래커가 반응해 DBMS_XPLAN 텍스트 기준선을 스스로 남겼거든요. PG 전용으로 설계한 기능의 폴백 경로가 실전에서 먼저 작동한 겁니다.

## 2. 3-2-1의 마지막 조각 — 백업을 오프사이트로

백업 축은 5편(복원 검증)과 8편(신선도 감시)을 거치며 꽤 완성됐지만, VERIFICATION 29절에 정직하게 적어둔 구멍이 있었어요 — **로컬 디스크에만 있는 백업은 서버가 죽으면 같이 죽습니다.** 3-2-1 원칙(사본 3, 매체 2, 오프사이트 1)의 마지막 1이 비어 있었던 거죠.

성공한 백업 산출물을 S3 호환 스토리지에 올리는 걸로 채웠습니다. "S3 호환"으로 잡은 이유가 이 기능의 핵심 결정이에요 — AWS S3뿐 아니라 MinIO·R2가 같은 API라서, **셀프호스트 사용자가 클라우드 계정 없이 MinIO 컨테이너 하나로 오프사이트를 갖출 수 있습니다.** 데모 스택에도 MinIO를 추가해서 로컬에서 전 과정이 실측돼요.

설계 판단 하나: **업로드 실패는 백업 실패가 아닙니다.** 로컬 백업 성공은 이미 유효한 사실인데, 업로드 에러가 그걸 FAILED로 뒤집으면 거짓말이 되죠. 그래서 이력은 SUCCESS로 남기고 원격 위치만 비웁니다 — 신선도 카드에 "원격 보관 / 로컬만" 열을 따로 둬서 두 사실을 구분해 보여줘요.

```
POST /api/instances/2/backup  (local-postgres)
-> SUCCESS, 32,892,191 bytes
-> remoteLocation: s3://dbtower-backups/instance-2/postgres-local-postgres-....sql
MinIO 컨테이너 /data에서 객체 실재 확인
```

![백업 신선도 — 원격 보관 열이 추가돼 로컬 성공과 오프사이트를 구분해 보여준다](/uploads/project/dbtower/freshness-remote.png)

정직한 각주: 서버 사이드 백업(SQL Server의 BACKUP DATABASE, Oracle의 DBMS_DATAPUMP)은 산출물이 대상 서버 안에 생겨 플랫폼이 파일로 갖고 있지 않아요 — 이 경우는 업로드를 건너뛰고 그렇게 기록합니다.

## 3. TLS — 셀프호스트 사용자가 처음 부딪힐 벽

셀프호스트 점검 때 발견했던 잔여입니다. 접속 문자열이 로컬/사내망 기준이라 — SQL Server는 `encrypt=false` 하드코딩, MongoDB는 TLS off — **Atlas나 Azure SQL처럼 TLS를 강제하는 관리형 서비스에는 아예 붙을 수 없었어요.**

등록 옵션 `useTls` 하나로 풀되, 기종마다 반영 방식이 다 다른 게 또 이기종의 현실이었습니다. MySQL은 URL 파라미터(sslMode=REQUIRED), PostgreSQL도 파라미터(sslmode=require), SQL Server는 세미콜론 속성(encrypt=true), Oracle은 파라미터가 아니라 **프로토콜 자체**(tcps), MongoDB는 드라이버 설정 객체. 같은 "TLS 켜기"가 다섯 갈래로 갈라지는 걸 옵션 하나 뒤로 숨겼어요 — 1편부터 반복된 그 패턴입니다.

그리고 **일부러 안 만든 것**이 하나 있어요. `trustServerCertificate=true` 같은 인증서 검증 우회 옵션이요. 자가서명 인증서 환경에서 편하라고 넣는 순간, 사용자는 "TLS를 켰다"고 믿지만 실제로는 중간자 공격에 열린 암호화만 남습니다. 착각을 파는 옵션은 보안 구멍이에요. 사설 CA는 JVM truststore에 등록하는 게 정도라, 그 길만 열어뒀습니다.

실측이 양방향이라 재밌었어요:

```
tls-mysql  (MySQL 8.4, useTls=true)  -> 201 등록 성공 + health up
   등록이 fail-closed(접속 검증 통과해야 등록)라, 성공 자체가 TLS 협상 성공의 증거

tls-mssql  (자가서명, useTls=true)   -> "접속 실패로 등록 거부"
   인증서 체인 검증이 실제로 작동한다는 실측 — 실패가 곧 증거
```

성공만 증거가 아니라 **거부도 증거**입니다. 자가서명을 거부하지 않았다면 검증이 안 돌고 있다는 뜻이니까요.

## 4. 마치며 — 잔여 목록 갱신

세 개를 닫고 잔여 목록을 갱신합니다. 백업 원격 보관과 TLS는 지웠고, 남은 것: 알림 쿨다운 설정 외부화, Vault 동적 계정, 백업 산출물 암호화, 히스토그램 기반 구간 p95. 그리고 이번에 새로 생긴 잔여도 정직하게 — 플랜 변경 감지는 정규화 텍스트에 대해 PostgreSQL만 완전하고(GENERIC_PLAN), 타 기종은 플레이스홀더 없는 쿼리로 한정됩니다.

돌아보면 이번 세 개의 공통점은 "완주가 끝이 아니라 기준선"이라는 거예요. 문서에 적어둔 잔여는 부채 목록이 아니라 **다음에 팔 곳의 지도**였습니다. 잔여를 정직하게 적는 습관이 없었다면, 완주 뒤에 뭘 해야 할지부터 다시 조사해야 했을 거예요.

코드와 실측 기록 전체는 [GitHub](https://github.com/dj258255/dbtower)에 있습니다.

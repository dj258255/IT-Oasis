---
title: '두 저장소가 손잡은 날: 창고가 계산한 평소를 관제탑이 받아 오탐을 지우고, 말로 물으면 차트가 생긴다'
titleEn: 'The Day Two Repositories Joined Hands — the Warehouse Computes "Normal," the Tower Merges It to Kill False Alarms, and Asking in Words Produces a Chart'
description: '이기종 DBMS 운영 관리 플랫폼 DBTower 19편. lakehouse(장기 분석계)와의 루프를 양방향으로 닫았습니다. 받는 쪽부터: lakehouse가 수개월 이력으로 계산한 요일×시간대 베이스라인을 V24 테이블로 받아 BaselineService의 14일 창에 가중 병합했습니다. 병합은 충분통계량 복원(Σx=n·m, Σx²=(n−1)s²+n·m²)이라 원시 관측을 더한 것과 수학적으로 동일하고, 단위는 시간당 호출량을 QPS로 /3600 스케일합니다. 라이브 검증에서 실측 스파이크(psql 3,000회)의 판정이 장기 테이블 내용에 따라 뒤집혔습니다. 장기가 "평소 0.2qps"라 하면 z=7.42 이상 발화, 관측 수는 101(장기 100+단기 1)로 병합의 실물이 찍혔습니다. 반대 방향(평소가 높음을 알아 월요일 피크 오탐을 지우는 것)은 단위 테스트로 고정했고, 빈 테이블이면 병합 전과 판정이 동일하다는 회귀 0도 테스트입니다. 주는 쪽: 대기 이벤트(V25, 5분 주기)와 오브젝트 크기(V26, 6시간 주기)를 주기 영속하는 잡 둘을 신설해 lakehouse가 내릴 원료를 만들었습니다. 첫 사이클 134행·43행이 기종별 실형(MSSQL 37·Oracle 50·Mongo 6)을 그대로 드러냈습니다. plan_snapshot 보존엔 48시간 하한을 병행해 "어제 하루창" 추출 전 유실을 막았습니다. 마지막으로 자연어 서빙: Metabot이 Cloud 전용이라 셀프호스트에 없는 갭을, MCP 도구 두 개(장기 마트 SELECT 질의·Metabase 카드 생성)로 메웠습니다. DuckDB JDBC를 직접 얹는 대신 이미 DuckLake를 물고 있는 Metabase API를 경유해 의존 0이고, 에이전트가 만든 카드는 "DBTower AI" 전용 컬렉션에 격리됩니다. 실측: 용량 예측 마트 질의 6행, DELETE는 400 거부, 카드 76이 실제로 생성되어 bar 차트가 143ms에 렌더됐습니다. 가는 길의 함정 셋. Flyway가 테이블을 재생성하면 GRANT가 사라진다, compileJava는 리소스를 복사하지 않아 마이그레이션이 classpath에 없다, Boot 4의 기본 Jackson 3는 Jackson 2 JsonNode를 POJO로 직렬화한다.'
descriptionEn: 'Part 19 of DBTower — closing the loop with the lakehouse in both directions. Receiving: long-term day-of-week × hour baselines computed by the lakehouse over months arrive in a V24 table and get weight-merged into BaselineService''s 14-day window. The merge reconstructs sufficient statistics (Σx=n·m, Σx²=(n−1)s²+n·m²), mathematically identical to having added the raw observations, with hourly call volume scaled to QPS by /3600. In live verification, the verdict on a real measured spike (3,000 psql executions) flipped based on what the long-term table said — with "normal is 0.2 qps" it fired z=7.42, and the observation count read 101 (100 long-term + 1 short-term), the merge made visible. The suppression direction (knowing Monday peaks are normal) is pinned by unit tests, as is zero regression when the table is empty. Supplying: two new persistence jobs — wait events (V25, every 5 minutes) and object sizes (V26, every 6 hours) — feed the lakehouse; the first cycles (134 and 43 rows) exposed each engine''s true shape (MSSQL 37, Oracle 50, Mongo 6). Plan-snapshot retention gained a 48-hour floor so yesterday''s window can''t be swept before extraction. Finally, natural-language serving: Metabot is Cloud-only, so two MCP tools (long-term mart SELECT and Metabase card creation) fill the gap — going through the Metabase API that already speaks DuckLake (zero new dependencies), with agent-created cards quarantined in a "DBTower AI" collection. Measured: capacity-forecast query returns 6 rows, DELETE gets a 400, and card 76 was actually created, rendering a bar chart in 143ms. Three traps along the way: Flyway recreating a table drops its GRANTs, compileJava does not copy resources so migrations are missing from the classpath, and Boot 4''s default Jackson 3 serializes a Jackson 2 JsonNode as a POJO.'
date: 2026-07-25
tags:
  - Java
  - Spring Boot
  - DBRE
  - MCP
  - Reverse ETL
category: personal/DBTower
coverImage: /uploads/project/dbtower/cover.svg
draft: false
series: "DBTower"
seriesOrder: 19
---

## 0. 반쪽짜리 악수

lakehouse 쪽 9편에서 "두 저장소가 손잡기"의 절반은 끝나 있었습니다. 창고(lakehouse)가 장기 베이스라인 마트를 계산해 원천 테이블로 되쓰는(writeback) 경로를 만들고, 32,498행 왕복과 권한 격리(permission denied)까지 실측해 뒀죠. 그런데 그 화물을 받는 테이블의 정식 DDL도, 판정에 쓰는 병합 로직도 이쪽(DBTower)엔 없었습니다. 화물은 도착하는데 아무도 안 뜯는 상태. 내릴 원료 쪽도 구멍이 있었습니다. 대기 이벤트는 화면에만 보여주고 영속을 안 했고(추출할 것이 없음), 크기는 "지금"만 알았습니다(추세를 계산할 시계열이 없음).

이번 편은 그 반쪽들을 전부 닫은 기록입니다. 받는 쪽 하나(D8)와 주는 쪽 셋(V25·V26·보존 하한)을 닫고, 그 위에 자연어 서빙까지 얹었습니다.

## 1. 받는 쪽: 평소를 아는 창고, 판정하는 관제탑

BaselineService의 이상 감지는 14일 창의 (요일×시간대) 버킷 통계로 z-score를 냅니다. 문제는 주간 계절성입니다. "매주 월요일 아침 배치 피크"는 14일 창엔 버킷당 관측이 최대 2개라, 관측 부족으로 판정이 보류되거나 얕은 표본이 평범한 주기 부하를 이상으로 오탐합니다. 그 이력은 lakehouse에 있습니다. 같은 데이터의 수개월치가 있으니까요.

V24로 수신 테이블(`baseline_longterm`)을 정의하고, 병합을 이렇게 설계했습니다.

- **충분통계량 복원.** 누적기(Acc)는 n·Σx·Σx²를 들고 있습니다. 장기 요약(n, mean, stddev)에서 Σx = n·m, Σx² = (n−1)s² + n·m²를 복원해 더하면, 원시 관측을 일일이 더한 것과 수학적으로 동일한 가중 결합입니다. 근사가 아닙니다.
- **단위 정합.** 장기는 "시간당 호출량", 단기는 QPS입니다. /3600 선형 스케일이라 mean도 stddev도 같은 배율로 접힙니다.
- **장기가 나르는 축은 호출량뿐.** 레이턴시·행수는 단기 관측이 충분할 때만 판정합니다. 얕은 단기 표본을 장기 게이트에 얹으면, 오탐을 줄이려던 병합이 되레 오탐 문을 여니까요.
- **회귀 0이 계약.** 테이블이 없거나 비면 병합할 것이 없어 판정은 병합 전과 완전히 동일합니다. 같은 입력을 스위치 on/off 두 서비스에 넣어 z까지 일치함을 테스트로 고정했습니다.

라이브 검증. psql로 `SELECT 1 AS d8_spike`를 5분간 3,000번 날려 실측 스파이크를 만들고, 그 쿼리의 장기 버킷을 조작하며 같은 스캔을 반복했습니다.

```
장기 없음(신규 쿼리)   → 학습중 (판정 보류 — 기존 동작)
장기 = "평소 0.2qps"   → 이상 발화: qps 현재=7.47, 장기평균=0.3, z=7.42, 관측=101
```

**관측=101.** 장기 100 + 단기 1. 가중 병합으로 게이트를 넘겨 판정이 가능해졌고, z가 병합 통계로 계산됐다는 실물 증거가 응답에 찍혔습니다. 반대 방향(장기가 "평소가 원래 5.0"임을 알아 같은 5.0 스파이크를 무경보 처리)은 단위 테스트(`월요일_피크를_아는_장기_평균이_오탐을_없앤다`)로 고정했습니다. 라이브에선 배치 타이밍이 스파이크 꼬리를 놓쳐 그 방향의 증명력이 없었다는 것도 정직하게 적어 둡니다.

운영 발견 하나. 검증용 수동 테이블을 지우고 Flyway가 재생성하자 lakehouse_writer의 GRANT가 함께 사라져 첫 되쓰기가 permission denied로 죽었습니다. **DDL 재생성은 GRANT 재적용을 요구한다**. 역할·권한은 환경 소유라 마이그레이션에 넣지 않고, 운영 절차에 이 함정을 남겼습니다.

## 2. 주는 쪽: 세 개의 공급 잡

**V25 대기 이벤트(5분 주기).** waitEvents()는 5기종을 조회해 화면에 보여줄 뿐 영속이 없었습니다. "지난달 그 장애 때 뭘 기다렸나"는 이력이 있어야 답하죠. 첫 사이클이 기종별 실형을 드러냈습니다: MSSQL 37·Oracle 50·Mongo 6·PG 3. 미지원이거나 대기가 없는 기종은 빈 목록이고, 행을 지어내지 않습니다.

**V26 오브젝트 크기(6시간 주기).** "이 DB 몇 달 뒤 꽉 차나"는 크기의 시계열이 필요합니다. 단기 디스크 ETA(17편의 Prometheus 라이브 카나리아)와는 지평이 다른 층이죠. 첫 사이클은 6인스턴스 43오브젝트(self-PG 185MB, PG 70MB). 이 원료로 lakehouse가 선형 추세와 임계 D-day를 계산합니다(그쪽 unit test가 기지값으로 산식을 고정: +10MB/일·임계 2000MB → 잔여 81일). volume 계열 컬럼은 계약상 nullable로 두고 채우지 않았습니다. 기종별 볼륨 조회는 후속이라, 없는 값을 채워 넣지 않습니다.

**plan_snapshot 보존 48시간 하한.** 카운트 보존(쿼리당 최신 20)은 플랜이 자주 뒤집히는 쿼리에서 "어제" 행을 하루가 닫히기 전에 밀어낼 수 있습니다. lakehouse가 어제 하루창을 D+1에 추출하는 계약과 정면 충돌이죠. 스윕에 시간 하한을 병행해 어린 행은 세대를 초과해도 남깁니다. 테이블이 일시적으로 상한을 넘는 것이 의도된 트레이드오프입니다(추출 정합 > 상한 엄격성).

함정 하나. `compileJava`는 리소스를 복사하지 않습니다. V26을 넣고 컴파일만 한 채 재기동했더니 마이그레이션이 classpath(build/resources)에 없어 조용히 적용되지 않았습니다. `classes` 태스크가 정답이었습니다.

## 3. Metabot 없이, 말로 물으면 차트가 생긴다

Metabase의 AI(Metabot)는 Cloud 전용이라 셀프호스트에 없습니다. 그 갭을 부품 재조립으로 메웠습니다: 에이전트 → MCP(14→16종) → REST → **Metabase API** → DuckLake 장기 마트.

DuckDB JDBC와 확장을 DBTower에 직접 얹는 선택지를 접은 게 설계의 핵심입니다. DuckLake의 서빙 계층은 이미 Metabase입니다(lakehouse 7단계 계약: "Metabase는 DuckLake만 read-only"). 경유하면 새 의존이 0이고, read-only 봉인도 Metabase 커넥션 구조가 최종 방어선이 됩니다.

- `lakehouse_query`: 장기 마트 SELECT. 도구 설명에 **실재 테이블·컬럼을 명시**해 에이전트가 스키마를 지어내지 못하게 했고, SELECT/WITH 전용 가드(주석 제거 후 판정, 세미콜론·쓰기·DDL 거부)와 행 상한을 걸었습니다.
- `lakehouse_card_create`: 질의를 Metabase 카드로 저장하고 URL을 돌려줍니다. 에이전트가 만든 카드는 "DBTower AI" 전용 컬렉션에 격리돼, 사람의 대시보드를 오염시키지 않습니다.

실측입니다. 용량 예측 마트 질의는 깔끔한 6행을 돌려줬고, `DELETE FROM ...`은 400("SELECT/WITH로 시작하는 읽기 질의만 허용한다")으로 거부됐고, 카드 생성은 `{"card_id":76, "url":".../question/76", "collection":"DBTower AI"}`를 반환했습니다. 그 URL을 열면:

![에이전트가 만든 Metabase 카드 76, "인스턴스별 관측 오브젝트 총 크기(MB)" bar 차트가 DBTower AI 컬렉션 아래 6행·143ms로 렌더된 실화면](/uploads/project/dbtower/dbtower19_ai_card.png)

에이전트가 만든 질문이 실제 차트로 서 있습니다. 대화는 에이전트(Claude·Discord)에서 일어나고 결과물이 Metabase에 남습니다. Metabot의 "화면 안 채팅"과는 다른 모양이고, 그 차이는 그대로 남깁니다. 대신 이 경로는 Metabot이 못 하는 걸 합니다: 장기 마트 조회와 라이브 진단(기존 14도구)과 차트 생성을 **한 대화에서** 섞을 수 있습니다.

마지막 함정. Boot 4의 기본 직렬화는 Jackson 3입니다. Metabase 응답을 Jackson 2 JsonNode로 들고 있다가 컨트롤러에서 그대로 반환했더니, 스프링이 그 노드를 POJO로 직렬화해 `{"array":false,"bigDecimal":false,...}` 같은 메타데이터 덤프가 나갔습니다. JSON 문자열로 직접 응답해 해소했습니다.

## 4. 남은 것을 정직하게

- **병합의 억제 방향 라이브 실증은 4주 이력 뒤의 몫입니다.** 합성 주입 없이 실버킷이 차오르면, "월요일 피크 무경보"를 실측으로 다시 확인합니다.
- **volume·max_bytes는 공급되지 않습니다(NULL).** 기종별 볼륨 조회(MSSQL dm_os_volume_stats·Oracle maxbytes)는 후속 아크입니다.
- **되쓰기 스케줄의 deadman 편입은 lakehouse 쪽 결정으로 남아 있습니다.**
- **Metabase 60의 공식 MCP 서버**가 DuckDB 드라이버의 60 지원과 함께 오면, 카드 생성 도구는 공식 경로와 비교해 재평가합니다.

---

배운 건, 두 시스템의 루프는 계약으로 닫힌다는 것이었습니다. 받는 쪽은 "빈 테이블이면 회귀 0", 주는 쪽은 "없는 값은 NULL"을 계약으로 삼았고, 보존은 추출 창이 닫히기 전엔 지우지 않으며, 서빙은 SELECT만 전용 컬렉션에 남깁니다. 계약이 명시돼 있으니 어느 쪽이 먼저 배포되든, 어느 쪽이 죽어 있든 시스템은 약속대로 동작합니다. 관측=101이라는 숫자 하나가 그 계약들이 실제로 맞물려 돌아간다는 증거로 남았습니다.

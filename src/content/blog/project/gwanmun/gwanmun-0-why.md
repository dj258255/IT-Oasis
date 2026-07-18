---
title: '전문·TCP와 JSON·REST 사이에 통역기를 세운 아홉 단계, 관문(gwanmun) 총정리'
titleEn: 'The Complete Story of gwanmun, an Integration Gateway Built Between Fixed-Length TCP and JSON REST Across Nine Measured Stages'
description: '은행 계정계는 고정길이 전문(電文)과 TCP로만, 모바일 앱은 JSON과 HTTP REST로만 말합니다. 둘 다 못 고치니 가운데에 통역기를 세웁니다. 전문과 JSON을 변환하는 연계층, 그리고 그 통로를 지키는 API 게이트웨이층입니다. 이 글은 그 통역기를 목업 계정계까지 세워 직접 만든 9단계의 총정리입니다. 계정계를 실제로 죽여 서킷이 OPEN으로 열리고 503으로 격리하는 과정, RuntimeException 하나(풀 고갈)가 서킷을 열고 원장 4건을 증발시킨 감사 결함과 그 수정(503과 원장 완결), 부하가 서킷 stale 레이스를 staleResultsTotal=197로 실증한 기록, 한계 약 10~12k req/s와 게이트웨이 오버헤드 약 0.21ms, 죽은 백엔드에서 서킷 off 351 vs on 9,425 req/s, 같은 멱등키를 두 번 보내도 계정계 호출 1회에 원장 1행으로 이중거래가 0이었던 것까지 담았습니다. 전부 VERIFICATION에 명령과 출력이 남은 실측이고, 안 만든 것은 왜 안 만들었는지 적었습니다.'
descriptionEn: 'A bank''s core system speaks only fixed-length messages over TCP, while the mobile app speaks only JSON over HTTP REST. Neither can be rewritten, so a translator goes in the middle: an integration layer that converts between messages and JSON, and an API gateway layer that guards the channel. This is the complete story of building that translator by hand across nine stages, mock core included. It covers killing the core to watch the circuit isolate it with OPEN and 503, a single RuntimeException from pool exhaustion that opened the circuit and vanished four ledger rows along with its fix (503 plus a complete ledger), load proving a stale-circuit race at staleResultsTotal=197, a knee around 10-12k req/s and roughly 0.21ms gateway overhead, a dead backend at 351 vs 9,425 req/s with the circuit off vs on, and the same idempotency key sent twice yielding one core call and one ledger row. Every number is measured with commands and outputs kept in VERIFICATION, and everything not built says why.'
date: 2025-11-15
tags:
  - Java
  - Spring Boot
  - TCP
  - API Gateway
  - EAI
category: personal/gwanmun
coverImage: /uploads/project/gwanmun/cover.svg
draft: false
series: "gwanmun"
seriesOrder: 0
---

## 0. 이 글 하나로

이 글은 관문(gwanmun) 시리즈 본편 5편의 총정리입니다. 시리즈를 안 읽어도 이 한 편으로 전체가 파악되게 썼고 깊이가 필요한 지점마다 해당 편을 링크했습니다.

한 줄로 요약하면 **고정길이 전문(電文)+TCP로만 말하는 은행 계정계와, JSON+HTTP REST로만 말하는 앱 사이에 세운 연계 게이트웨이**입니다. 둘 다 못 고치니 가운데에 통역기를 두는데, 그 통역기는 두 층입니다. 전문↔JSON을 변환하는 **연계층**, 그리고 통로를 인증·라우팅·유량제어로 지키는 **API 게이트웨이층**입니다. 진짜 은행 없이 로컬에서 전 과정을 재현했고 전문을 주고받는 목업 계정계까지 직접 세웠습니다. Java 21 + Spring Boot 3.5, 코드는 [GitHub](https://github.com/dj258255/gwanmun)에 공개되어 있습니다.

숫자부터 놓고 시작하겠습니다. 전부 직접 측정했고 명령·출력·환경이 담긴 재현 기록([VERIFICATION.md](https://github.com/dj258255/gwanmun/blob/main/docs/VERIFICATION.md) 1~9단계)이 저장소에 있습니다.

| 항목 | 수치 |
|---|---|
| 두 프로토콜 통역 | 고정길이 전문+TCP ↔ JSON+REST, 대표 거래 4종(잔액·거래내역·상태조회·망취소) |
| 장애 격리 | 계정계를 실제로 kill → 서킷 OPEN → 이후 503 즉시 거절(계정계 호출 0) |
| 감사 결함 수정 | 풀 고갈이 서킷을 열고 원장 4건 증발 → 수정 후 503 + 원장 9행 완결·서킷 CLOSED |
| 부하 상한 | k6 무릎 ~10–12k req/s, ~6k까지 p95<1ms, 실패율 전 구간 0% |
| 게이트웨이 오버헤드 | 경유 시 ≈ 0.21ms/req (직접 왕복 대비) |
| 빠른 실패의 값 | 죽은 백엔드에서 서킷 off 351 req/s(p50 8.11s) vs on 9,425 req/s(p50 0.68ms) |
| 멱등 이중거래 | 같은 키 2회 → 계정계 1회·원장 1행(이중거래 0), 처리 중 재요청 409 |
| 테스트 / 기록 | 168건 (CI 게이트) / VERIFICATION 1~9단계 |

측정 환경은 공통적으로 로컬에서 두 프로세스(게이트웨이 앱 ↔ 목업 계정계)를 실제 TCP 소켓으로 잇고 원장은 PostgreSQL 컨테이너에 적재하는 구성입니다. 각 수치의 상세 조건은 해당 절에 명시했습니다.

## 1. 말이 안 통하는 두 시스템

은행에 모바일 잔액조회를 붙여야 한다고 해봅시다. 문제는 양쪽이 쓰는 언어가 완전히 다릅니다.

- **계정계(코어뱅킹)** 는 오래된 시스템이라 이렇게 말합니다: `"0200" + 계좌번호[14] + 거래코드[4] + 공백패딩...`. 띄어쓰기와 자릿수가 곧 의미인 **고정길이 전문**이고, 그것도 **TCP 소켓**으로 오갑니다.
- **모바일 앱** 은 이렇게 말합니다: `{"account":"12345678901234"}`. **JSON**을 **HTTP REST**로 실어 보냅니다.

이 둘은 직접 대화가 안 됩니다. 그런데 계정계를 JSON/REST로 통째로 뜯어고치는 건 현실적으로 감당하기 어려운 규모라 못 고칩니다. 답은 하나입니다. **가운데에 통역기를 세우는 것.** 이게 마이데이터·오픈뱅킹의 구조이고 이 프로젝트가 작게 직접 만드는 대상입니다.

지어낸 상황처럼 보여도 지금 실무에서 벌어지는 문제 공간입니다. ISO 20022 전환기에도 다수 은행이 코어를 못 고쳐 미들웨어로 신규 포맷과 레거시 고정길이를 변환하는 전략을 택했고(변환 계층은 사라지기는커녕 두꺼워지는 중), 국내 대외계·코어뱅킹은 여전히 고정길이 전문 + TCP 연계가 흔합니다.

## 2. 두 층을 나누고 정체성은 섞지 않는 설계

통역기가 하는 일은 두 층으로 나뉩니다.

- **연계(통역) 층**은 JSON을 계정계가 알아듣는 전문으로 바꾸고, TCP로 보내고, 돌아온 전문을 다시 JSON으로 되돌립니다. 프로토콜(HTTP↔TCP)과 포맷(JSON↔전문)을 동시에 변환합니다.
- **API 게이트웨이 층**은 이 통로가 외부(핀테크·마이데이터)에 열리면 아무나 들어오면 안 되니, 앞단에서 인증·라우팅·유량제어로 지킵니다. 신분을 확인하고, 어디로 갈지 안내하고, 방문 횟수를 제한하되, 집 안 살림(잔액 계산)엔 관여하지 않습니다. **흐름은 통제하되 비즈니스 로직은 계정계에 위임**한다는 원칙입니다.

![API 게이트웨이 층과 연계(통역) 층이 모바일 REST와 레거시 전문 사이를 잇는 gwanmun 아키텍처](/uploads/project/gwanmun/architecture.svg)

경계 하나를 더 그었습니다. 이 프로젝트는 [DBTower](/blog/project/dbtower/dbtower-0-overview)와 성격이 정반대라 별도 저장소로 둡니다. gwanmun은 **데이터 경로 위에서 메시지를 중계**하는 미들웨어(인라인)이고 DBTower는 **데이터 경로 밖에서 관찰**하는 관제(아웃오브밴드)입니다. 둘을 한 코드베이스에 섞으면 두 정체성이 흐려집니다. 느슨한 연결(gwanmun의 원장 DB를 DBTower가 관측)만 남겼습니다.

코드베이스 자체도 Spring Modulith 모듈로 경계를 지어 모듈 간 순환 의존을 빌드에서 실패시킵니다(`ApplicationModules.verify()`가 전 단계 그린). message·core·gateway·ledger·web가 단방향 DAG로 물려 있습니다.

두 층 그림을 코드 단위로 내리면 이렇게 됩니다. 색 구역이 방금 말한 5모듈의 경계이고, 필터 체인(인증→라우팅→유량제어)·장애 내성 3겹(데드라인·재시도·서킷)·커넥션 풀·비동기 원장 적재 스레드가 각각 어느 모듈에 사는지, 목업 계정계 3서버(9099·9098·9097)와 원장 PostgreSQL(25432)이 어떤 포트로 물리는지까지 실제 코드 그대로입니다.

![5모듈 경계와 필터 체인, 장애 내성, 비동기 원장 적재, 목업 계정계 3서버를 담은 gwanmun 상세 서버 아키텍처](/uploads/project/gwanmun/architecture-detail.svg)

원장 DB 쪽 경계도 미리 그려두면 뒤 편들이 읽기 쉬워집니다. 테이블은 딱 3개입니다. 거래 원장(`transaction_ledger`), 멱등키(`idempotency_key`), EOD 대사 이력(`reconciliation_run`)이고, 테이블 사이는 물리 FK 없이 값(`tran_id`·`settle_date`)으로 잇는 논리 관계입니다. 원장 적재가 비동기라 멱등키를 적는 시점에 원장 행이 아직 없을 수 있어서 FK를 두지 않는 게 설계상 맞았습니다.

![transaction_ledger · idempotency_key · reconciliation_run 세 테이블로 이뤄진 gwanmun 원장 DB ERD](/uploads/project/gwanmun/erd.svg)

## 3. 상황이 이끈 9단계 개선 아크

이 프로젝트는 **"어떤 상황에서 무엇이 깨지고, 그래서 무엇을 만드는가"**의 서사로 씁니다. 각 단계는 앞 단계가 남긴 구멍에서 출발했습니다. 전/후가 있는 건 전후로 실측했습니다.

| 단계 | 상황(무엇이 깨졌나) | 만든 것 | 핵심 실측 |
|---|---|---|---|
| [1~2](/blog/project/gwanmun/gwanmun-1-parser-and-framing) | 전문↔JSON 변환, TCP는 스트림이라 한 전문이 한 번에 안 옴 | 스펙 선언 파서/빌더 · 프레이밍 · 목업 계정계 TCP 서버 | 요청 30B/응답 61B가 **실소켓** 왕복(elapsedMs 12), EUC-KR 한글 무손실, partial read 재조립·뭉침 분리 |
| [3](/blog/project/gwanmun/gwanmun-2-gateway-skeleton) | 통로가 외부에 열림: 아무나 못 들어오게 | 손으로 짠 필터 체인(인증→라우팅→유량제어) + 모듈러 모놀리스 | 무키 401 · 잘못된 키 403 · 모르는 경로 404 · 용량 5 초과 시 6번째 429(Retry-After) |
| [4](/blog/project/gwanmun/gwanmun-2-gateway-skeleton) | 거래내역은 건수만큼 길이가 매번 다름 · 요청당 소켓 낭비 | 길이 프리픽스 2단계 프레이밍 · 스레드 안전 커넥션 풀 | 가변 309B(헤더4+본문305) 왕복, 동시 폭주 시 created=4(==max) · reused=12 |
| [5](/blog/project/gwanmun/gwanmun-3-ledger-and-resilience) | 게이트웨이가 거래를 아무것도 기억 못 함 | 거래ID 채번 · 3값 원장(SUCCESS/FAILED/UNKNOWN) · 마스킹 · 메트릭 | 타임아웃 3.06초 → 504 + **UNKNOWN 기록**(FAILED로 단정 안 함), 계좌는 마스킹 형태만 저장 |
| [6](/blog/project/gwanmun/gwanmun-3-ledger-and-resilience) | 계정계 장애가 게이트웨이로 전파 · UNKNOWN 방치 | 자체 서킷브레이커 · 성격별 재시도 · UNKNOWN 해소 | 계정계 kill → 502 → **503×4 즉시 거절** → 재기동 후 HALF_OPEN 탐침 → CLOSED 복귀; 처리됨→망취소→CANCELED, 미처리→FAILED |
| [7](/blog/project/gwanmun/gwanmun-4-audit-and-load) | 궂은 날엔 오작동: 감사가 확정 결함 6건 + 보안 3건 | 풀 고갈 3중 오작동 소탕 · 원장 공백 금지 · 보안 경화 | (전) 고갈 4건 HTTP 500·**원장 4건 증발**·서킷 오보 OPEN → (후) 503·**원장 9행 완결**·서킷 CLOSED |
| [8](/blog/project/gwanmun/gwanmun-4-audit-and-load) | 테스트가 로컬에서만 돎 · 부하 앞 서킷 미검증(A3) | 세대 permit 서킷 · k6 하네스 · CI · Boot 3.5 | 부하가 A3 stale 레이스를 **staleResultsTotal=197**(15초)로 실증; 무릎 ~10–12k req/s; 서킷 off 351 vs on 9,425 req/s |
| [9](/blog/project/gwanmun/gwanmun-5-idempotency-reconciliation) | 호출자 재전송을 구분 못 함 · 원장이 한 번도 대조 안 됨 | 멱등키(DB 유니크 선점) · EOD 대사 배치 | 같은 키 2회 → 계정계 **1회**·원장 **1행**(이중거래 0); 대사 4유형 분류 + UNKNOWN 자동해소 |

각 단계의 잔여가 다음 단계의 상황이 됩니다. 원장 편이 "UNKNOWN을 적기만 한다"를 남기면 장애 내성 편이 그 해소를 만들고, 장애 내성 편이 "부하 미검증"을 남기면 부하 편이 그걸 다시 재고, 부하 편이 "멱등키 없음"을 남기면 멱등 편이 그 자리를 채우는 식입니다.

## 4. RuntimeException 하나가 서킷을 여는 이유를 파헤친 심층 사례

3편까지 "기능이 도는 것"을 실측으로 증명했다면, [4편](/blog/project/gwanmun/gwanmun-4-audit-and-load)은 방향을 뒤집어 전체 코드를 감사했습니다. 기능이 도는 것과 궂은 날에도 옳게 도는 것은 다른 문제니까요. 그중 가장 날카로웠던 결함(A1) 하나를 통째로 보여드리겠습니다.

**상황을 이렇게 만들었습니다.** 목업 계정계는 끝까지 멀쩡합니다. 지연 계좌의 응답 지연(5초)이 read 타임아웃(8초)보다 짧아, 풀을 쥔 요청은 전부 성공하게 설계했습니다. 실패 원인을 **오직 내부 커넥션 풀 고갈**(풀 4, borrow 대기 1초) 하나로 고립시킨 겁니다. 동시 8건을 슬로우 계좌로 던지면 4건은 풀을 쥐고 나머지 4건은 풀이 없어 대기하다 `PoolExhaustedException`을 만납니다.

**그 예외 하나가 세 곳을 동시에 오작동시켰습니다.** `PoolExhaustedException`이 RuntimeException으로 모든 처리 경로를 관통하면서:

1. **서킷이 잘못 열렸다.** 실행기가 이걸 백엔드 실패로 계수했습니다. 계정계는 멀쩡한데 내부 고갈 3연속이면 서킷이 OPEN되고, 이후 멀쩡한 계정계로 가는 모든 거래가 503으로 차단됩니다(오보).
2. **거래가 장부에서 증발했다.** 서비스·컨트롤러가 IOException·GatewayException만 잡아서, 이 예외는 500으로 관통하며 **원장에 아무것도 안 남겼습니다.** 8건을 보냈는데 원장엔 5행만 남고 4건이 사라졌습니다.
3. **조회성 재시도도 안 탔다.** 계약(타입)에 없는 타입이 흐르니 재시도 분기도 무의미해집니다.

수정 전 원장(psql 실측)이 이 증발을 그대로 보여줍니다:

```
 GWMNU...072 | SUCCESS | 5006 |
 GWMNU...073 | SUCCESS | 5006 |
 GWMNU...074 | SUCCESS | 5006 |
 GWMNU...077 | SUCCESS | 5006 |
 GWMNU...079 | FAILED  |    1 | ... 서킷 'core-banking' ...
(5 rows)   ← 8건을 보냈는데 5행. 071·075·076·078이 증발.
```

**진단은 "타입이 계약"이라는 것이었습니다.** 서킷은 백엔드 실패만 세야 하는데, 내부 사정(풀 고갈)을 백엔드 장애로 오인한 게 근원입니다. 그래서 풀 고갈은 서킷에 **계수하지 않고**(내부 사정 ≠ 계정계 장애), 재시도도 안 하고(풀이 이미 borrow-timeout을 기다렸으니 재시도는 부하 증폭), 왕복 이후의 실패는 전부 클라이언트 예외로 감싸 **원장 FAILED를 보장**하고 컨트롤러에 최후 방어 catch를 뒀습니다.

수정 후, 동일 시나리오의 원장은 구멍이 없습니다:

```
 GWMNU...804 | FAILED | 1008 | 게이트웨이 내부 커넥션 풀 고갈: ...
 GWMNU...806 | FAILED | 1008 | ...
 GWMNU...807 | FAILED | 1007 | ...
 GWMNU...808 | FAILED | 1008 | ...
 (SUCCESS 4 + 확인 1 포함 9 rows)
```

고갈 4건은 이제 HTTP 500을 던지지 않고 **503**("포화 상태" + 거래ID + correlationId)으로 나가고, 서킷은 **CLOSED**를 유지하며, 직후 멀쩡한 계좌는 200입니다. `elapsed_ms=1008 ≈ borrow 대기 1000ms`라, 고갈 거절이 "대기 후 거절"이라는 것까지 숫자로 남습니다. 이 회귀는 `AuditRegressionIntegrationTest`로 고정해, 다시 깨지면 CI가 잡습니다.

한 줄로 요약하면 **하나의 예외 타입이 어떤 경로로 흐르는지가 곧 시스템의 신뢰성**이고, 그건 부하를 실제로 걸어 궂은 상황을 만들어야만 드러납니다.

## 5. 정직성과 트레이드오프

**서킷브레이커를 직접 구현했습니다(Resilience4j를 안 썼어요).** 완제품이 더 견고할 수 있는데도 손으로 짠 이유는, 게이트웨이가 장애를 어떻게 격리하는지를 상태 전이 단위로 이해하려는 것이었습니다. 그리고 그 선택이 [부하 편](/blog/project/gwanmun/gwanmun-4-audit-and-load)에서 값을 했습니다. 직접 짠 서킷이라 **A3(stale 결과 귀속)** 같은 미묘한 동시성 결함을 세대(generation) permit으로 파고들 수 있었습니다. `acquire()`가 상태 세대를 담은 permit을 발급하고 결과 보고는 세대가 일치할 때만 상태에 반영합니다. 부하 창에서 이 stale 결과가 15초에 **197번** 실제로 도착했다는 걸 `staleResultsTotal=197`로 계수했습니다. 완제품을 썼다면 이 층위를 열어 보지 못했을 겁니다.

**학습판 경계는 정직하게 긋습니다.** 금융결제원 표준 전문을 전수 구현하지는 않았습니다. 대표 거래 몇 종으로 핵심 흐름을 다뤘고, 전문은 평문 로컬 소켓(암호화·전용선 미적용)이며, 채번·대사·rate limit은 단일 노드 전제입니다. 이것들을 "했다"고 말하지 않고 각 편의 "잔여" 절에 못 한 것으로 적었습니다.

**부하 수치도 경계가 있습니다.** k6·앱·목업이 한 머신에서 CPU를 나눠 쓰므로, 무릎 ~10–12k req/s는 **결합 시스템의 천장**으로 읽어야지 순수 서버 성능으로 보면 안 됩니다. 그래도 상대 비교(게이트웨이 vs 직접, 서킷 on vs off)는 유효합니다. "금융권 표준 P95" 같은 공개 근거 없는 수치는 지어내지 않았습니다.

## 6. 안 하기로 한 것과 그 이유

**"왜 안 넣었는지 안다"**, 바로 이게 이 프로젝트의 성격입니다. 감사 백로그에서 안 하기로 가른 것과 근거를 그대로 옮깁니다.

- **JWT/OAuth 단독 인증은 안 했습니다.** 서버 간 게이트웨이 인증은 API 키+mTLS가 관례이고, 토큰 발급 인프라는 전문·연계라는 이 프로젝트의 주제와 겹치지 않습니다.
- **분산 rate limit(Redis 등)도 넣지 않았습니다.** 인스턴스 로컬 토큰버킷으로 개념은 이미 증명했고, 분산화는 저장소 의존만 늘립니다. 실무 답도 "로컬 근사 + 임계 근처만 외부 저장소 검증" 하이브리드입니다.
- **HA·이중화·중앙 채번은 뺐습니다.** 실무에서 절체는 L4/인프라 계층 장치입니다. 앱이 담당하는 부분집합(graceful shutdown·재접속)은 이미 커버했고, 단일 노드 경계를 코드 주석·문서에 명시하는 쪽을 택했습니다.
- **MQ 어댑터(Kafka 등)는 제외했습니다.** 동기 TCP 전문 연계가 주제입니다. 비동기 채널은 응답 전문의 거래ID 매칭 등 전제가 달라져 별개 프로젝트 규모가 됩니다.
- **가상스레드 전면 전환은 안 했습니다.** 무제한 수용은 커넥션 풀 고갈·pinning을 유발합니다. 실무 실측 결론도 "기본 off, I/O 무거운 구간만 상한 걸린 executor로 선별 적용"입니다.
- **금융 표준 전문 전수·전문 암호화·전용선은 범위 밖입니다.** "표준 전수 아님"을 정직하게 표기합니다.

이 판단들이 자의적이지 않도록 실무 실태를 조사해 근거를 댔습니다. 이 도메인이 유효하다는 1차 사료가 여럿입니다. 은행·카드·VAN 연동용 TCP Gateway 구축 후기는 겪은 문제(동시 세션 제한 → 풀 크기를 계약값에 일치, 기관이 커넥션을 임의로 끊음 → 헬스체크·재수립, 전문 분할 도착 → 길이 필드 프레이밍, 타임아웃 → 처리결과조회, 대사·재처리를 게이트웨이 부속 기능으로 내장)가 이 프로젝트의 단계들과 그대로 겹칩니다. 타임아웃 3값 처리도 도메인 공식 관례로, 은행 공동망 에러코드 42는 "(TIME OUT) 처리결과조회로 거래성립여부 확인요망"이고 오픈뱅킹도 무응답 시 결과조회 절차를 규정합니다. 둘 다 [3편](/blog/project/gwanmun/gwanmun-3-ledger-and-resilience)의 UNKNOWN·상태조회 설계와 정확히 일치합니다. 대외계 장애의 실제 병목이 관측성이라는 점(어느 전문이 어디서 죽었는지 추적하는 능력이 곧 복구 시간)은 correlation ID·원장의 방향을 뒷받침합니다.

## 7. 커버리지와 남은 한계 결산

1~9단계로 무엇을 커버했고 무엇이 범위 밖인지 결산합니다.

| 축 | 하는 것 | 위임/범위 밖 (이유) |
|---|---|---|
| 프로토콜 변환 | 고정·가변 전문 프레이밍, EUC-KR byte 오프셋 처리, JSON↔전문 양방향 | 표준 전문 전수·중첩 가변·바이너리 길이 헤더는 확장 지점 |
| 게이트웨이 방어 | 인증·라우팅·유량제어를 필터 체인으로 직접 | JWT/OAuth 단독·분산 rate limit은 안 함(단일 노드 인메모리) |
| 관측성 | 거래ID 채번·3값 원장·마스킹·correlation ID·Prometheus 메트릭 | 원장 파티셔닝·장기 보존 배치 삭제는 잔여 |
| 장애 내성 | 자체 서킷브레이커·성격별 재시도·거래 데드라인·세대 permit | 서킷은 인스턴스 로컬(다중 노드 공유 없음) |
| UNKNOWN 해소 | 상태조회→망취소(멱등) 경로, EOD 대사 배치의 자동 해소 | 대사는 잔액조회 중심(이체·다계좌는 확장) |
| 중복 방지 | 멱등키를 DB 유니크 제약으로 원자적 선점(이중거래 0) | 멱등키·채번·대사 모두 단일 노드 전제 |
| 부하 검증 | k6로 한계 TPS·P95·게이트웨이 오버헤드·빠른 실패의 값 | 분리된 부하 발생기·전용 서버의 절대 성능은 미측정 |

돌아보면 이 프로젝트를 관통한 건 세 문장입니다.

1. **차이는 경계 뒤로.** 프로토콜·포맷 차이는 연계층 뒤로, 외부 위협은 게이트웨이층 뒤로, 두 정체성(인라인 중계 vs 아웃오브밴드 관제)은 별도 저장소로 보냅니다.
2. **타임아웃은 '모름'이다.** 응답을 못 받은 거래는 UNKNOWN이고, 확정은 조회로 한다. 임의로 실패 처리하면 이중 거래가 난다.
3. **신뢰는 궂은 날에 증명된다.** 계정계를 실제로 죽이고, 풀을 실제로 고갈시키고, 부하를 실제로 걸어 서킷 stale을 계수하기 전까지, "된다"는 주장은 빚이다.

전 과정의 상세는 시리즈 [1편(전문 파서·프레이밍)](/blog/project/gwanmun/gwanmun-1-parser-and-framing)부터 [5편(멱등키·대사)](/blog/project/gwanmun/gwanmun-5-idempotency-reconciliation)까지에, 재현 가능한 기록은 [GitHub](https://github.com/dj258255/gwanmun)에 있습니다.

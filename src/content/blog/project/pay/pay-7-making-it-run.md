---
title: '이제 진짜로 돌린다 — Flyway로 실기동, 그리고 라이브 검증'
titleEn: "Now It Actually Runs — Flyway Migrations and Live Verification"
description: 결제 시스템 개선기 1. 지금까지 87개 테스트로 검증했지만, 정작 앱을 띄우면 뜨지 않았다 — 원장을 지키려 ddl-auto를 validate로 뒀는데 스키마를 만드는 게 없었기 때문. Flyway 마이그레이션을 붙여 실제로 기동시키고, 실 MySQL 위에서 주문→승인→멱등키 재사용→금액 위변조 방어를 curl로 확인한 뒤, k6로 진짜 부하 수치를 뽑았다 — 21,112 요청, 오류율 0%, p95 96ms.
descriptionEn: "Payment system improvement log 1. I had 87 passing tests, but the app didn't actually boot — to protect the ledger I set ddl-auto to validate, yet nothing created the schema. I added Flyway migrations to make it run, verified order→approve→idempotent-replay→amount-tampering-defense on real MySQL with curl, then pulled real load numbers with k6 — 21,112 requests, 0% errors, p95 96ms."
date: 2026-07-12T00:00:00.000Z
tags:
  - Payment
  - Flyway
  - Database Migration
  - k6
  - Load Testing
  - Spring Boot
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 7
---

*결제 도메인 취업을 목표로 실전 결제 시스템을 밑바닥부터 만드는 시리즈. 이 글부터는 개선기예요. 1편 — 실제로 돌게 만들고 라이브로 검증하기.*

## 0. 테스트는 통과하는데, 앱이 안 뜬다

[본편](/blog/project/pay/pay-6-operations)을 마쳤을 때 테스트 87개가 다 통과했어요. 그런데 정작 `bootRun`으로 앱을 띄우면 — **안 떴어요.**

이유가 좀 아이러니해요. 원장을 append-only로 지키려고 `ddl-auto: validate`를 썼거든요. JPA가 스키마를 함부로 못 바꾸게, "검증만" 하게요. 그런데 **정작 스키마를 만드는 게 없었어요.** validate는 "테이블이 있는지 확인"만 하지 만들진 않으니까, 빈 DB에선 검증 실패로 부팅이 막혀요.

> 테스트는 H2 인메모리랑 Mockito로 도니까 이 구멍을 못 봤어요. "돌아가는 것처럼 보이는데 실제 기동은 안 되는" 상태였던 거죠. 이걸 메우는 게 이번 개선이에요.

## 1. Flyway — 스키마를 코드로 관리한다

해법은 **Flyway 마이그레이션**이에요. `ddl-auto: validate`는 그대로 두고(원장 보호), 스키마 생성은 Flyway가 버전 관리하는 SQL로 해요.

문제는 **정확한 DDL을 손으로 쓰기가 위험**하다는 거예요. 컬럼 하나, 타입 하나 어긋나면 validate가 부팅을 막아요. 그래서 Hibernate한테 시켰어요 — 엔티티에서 DDL을 **파일로 생성**하게요.

```bash
# 실행 안 하고 DDL만 파일로 뽑기
--spring.jpa.properties.jakarta.persistence.schema-generation.scripts.action=create
--spring.jpa.properties.jakarta.persistence.schema-generation.scripts.create-target=build/schema-create.sql
```

MySQL 방언으로 17개 테이블 DDL이 정확하게 나왔어요. 이걸 `V1__init.sql`로 고정하고, 못생긴 자동 생성 제약명만 정리하고, 배치 스캔용 인덱스와 개발용 시드(`V2__seed`)를 더했어요. Modulith의 이벤트 테이블(`event_publication`, = Outbox)도 여기 포함돼서 Flyway가 관리하게 했고요.

그리고 다시 띄웠더니 —

```
Flyway: Migrating schema `pay` to version "1 - init"
Flyway: Migrating schema `pay` to version "2 - seed dev data"
Flyway: Successfully applied 2 migrations
Tomcat started on port 8080
Started PayApplication in 6.525 seconds
```

**떴어요.** Flyway가 스키마를 만들고, JPA validate가 통과하고, 6.5초 만에 기동.

## 2. 라이브로 두들겨 보다

이제 진짜 MySQL 위에서 도는지 curl로 확인했어요. 지금까지 테스트로만 증명하던 것들이 **실제로** 되는지.

**① 서버 권위 가격 + 주문 생성**
```bash
$ curl -X POST /api/v1/orders -d '{"userId":1,"items":[{"productId":1,"quantity":2}]}'
{"orderNo":"01KWSH8JXGJHYKB2MQ35XCCFXQ","totalAmount":20000,...}
```
클라이언트는 `productId`랑 `quantity`만 보냈는데, 서버가 카탈로그에서 가격을 조회해 `totalAmount: 20000`(10,000×2)을 확정했어요. ULID 주문번호도 잘 나오고요.

**② 결제 승인**
```bash
$ curl -X POST /api/v1/payments/confirm -H 'Idempotency-Key: ...' \
    -d '{"paymentKey":"...","orderNo":"01KWSH...","amount":20000}'
{"orderStatus":"PAID","paymentStatus":"DONE","message":"승인 완료"} [200]
```

**③ 멱등키 재사용 (따닥)** — 같은 키로 두 번:
```
1차: {...DONE...} [200]
2차(같은 키): {...DONE...} [200]   ← 재실행 없이 첫 응답 재반환
```

**④ 금액 위변조 (1원으로 조작)**:
```bash
$ curl ... -d '{"orderNo":"01KWSH...","amount":1}'
{"code":"AMOUNT_MISMATCH","message":"...주문 10000, 요청 1"} [403]
```

**⑤ 어드민 인증**:
```
무인증 GET /api/v1/admin/dead-letters → 401
admin 인증 → 200
```

[Phase 1](/blog/project/pay/pay-1-order-payment-core)의 신뢰 경계, [Phase 2](/blog/project/pay/pay-2-designing-for-failure)의 멱등키, [Phase 6](/blog/project/pay/pay-6-operations)의 접근 제어 — 전부 **실제로** 작동해요. 테스트가 거짓말을 안 했다는 거죠.

## 3. 그리고 진짜 부하 수치

앱이 뜨니까 드디어 [준비해뒀던 k6](/blog/project/pay/pay-5-lock-comparison)를 실제로 돌릴 수 있었어요. 주문 생성 → 결제 승인을 최대 **200 VU**로 2분간.

```
█ THRESHOLDS
  http_req_duration
    ✓ 'p(95)<300'  p(95)=96.16ms
    ✓ 'p(99)<800'  p(99)=131.75ms
  http_req_failed
    ✓ 'rate<0.01'  rate=0.00%

█ TOTAL RESULTS
  http_reqs .......: 21112   175.08/s
  http_req_failed .: 0.00%   0 out of 21112
  { name:confirm } : p(95)=111.08ms
```

**21,112 요청, 175 req/s, 오류율 0%, p95 96ms, p99 131ms.** 임계치 전부 통과. 이제 "동시에 많이 결제하면?"에 **실측 수치로** 답할 수 있어요. (로컬 단일 인스턴스 + FakePgClient 기준이라 절대치보단 "임계치를 지키며 견딘다"는 게 포인트예요. 실 PG를 붙이면 PG 레이턴시가 더해지죠 — 그건 다음 개선.)

## 4. 개선의 교훈

이번 건 기능 추가가 아니라 **"검증된 코드"와 "실제 기동" 사이의 구멍**을 메운 거예요.

> 테스트가 다 통과해도, 실제로 띄워보기 전엔 모르는 게 있어요. 이 프로젝트에선 그게 "스키마를 아무도 안 만든다"였죠. 그래서 **라이브 검증(curl + k6)**을 한 번은 꼭 거쳐야 해요 — 테스트 초록불과 실기동은 다른 문제니까요.

그리고 이게 실무에서도 똑같아요. `ddl-auto: validate` + Flyway는 "앱이 멋대로 스키마를 못 바꾸게" 하는 표준 조합이에요. 특히 원장처럼 **한 줄도 훼손되면 안 되는** 테이블이 있으면요.

## 다음 — 실 토스페이먼츠 어댑터

지금은 상태 기반 FakePgClient로 모든 걸 결정적으로 테스트해요. 다음 개선은 그 자리에 **진짜 토스페이먼츠 어댑터**를 끼우는 거예요 — 멱등키를 PG로 전달하고, 실패를 3-상태로 변환하고, 서킷브레이커로 감싸는. 기존 `PgClient` 인터페이스 덕에 **구현 하나만 추가**하면 돼요. 이어서 씁니다.

---

*이 글은 작성 중인 시리즈의 개선기예요. 라이브 검증 수치는 로컬 실기동에서 실제로 뽑은 값입니다.*

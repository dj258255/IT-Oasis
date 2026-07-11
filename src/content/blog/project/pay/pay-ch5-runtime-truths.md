---
title: '실기동이 드러낸 것·조회·운영 완성'
description: '"승인됐습니다"라고 답했지만 DB엔 없던 영속 버그, 27편 회고, 폴링 계약을 닫는 조회 API, 단건 동기화·수기 대사, 강제취소 2인 승인, FDS 심사 큐.'
date: 2025-12-07T00:00:00.000Z
tags:
  - Payment
  - Spring Boot
  - Spring Modulith
  - 결제 시스템
category: study/pay
coverImage: "/uploads/project/pay/thumbs/pay-ch5.svg"
draft: false
series: "결제 시스템 만들기"
seriesOrder: 5
---

*결제 시스템 시리즈 — 실기동이 드러낸 것·조회·운영 완성. 원 연재 여러 편을 한 챕터로 묶었고, 각 절이 원래 한 편이다.*

## 승인됐습니다"라고 답했지만 DB엔 없었다 — 실기동이 드러낸 결제 확정 버그

응답은 `PAID`인데 DB엔 `PENDING_PAYMENT`가 남아 있었다. 결제 승인이 실제로는 DB에 확정되지 않는 버그가, 200개 넘는 테스트가 전부 초록불인 채로 실기동에서 드러났다.

### 0. 구매확정이 자꾸 막혔다

[에스크로](/blog/project/pay/pay-ch4-arch-events-ops)를 붙이고 실기동으로 흐름을 눌러봤다. 주문 생성 → 결제 승인 → 구매확정. 그런데 구매확정이 자꾸 막혔다.

```
POST /api/v1/orders/{orderNo}/confirm-purchase
→ 409 "결제 완료 주문만 구매확정할 수 있습니다."
```

이상했다. 바로 전에 결제 승인 응답은 분명 이랬으니까.

```json
{ "orderNo": "...", "orderStatus": "PAID", "paymentStatus": "DONE", "message": "승인 완료" }
```

PAID라고 응답했는데 구매확정은 "PAID가 아니다"라며 막는다. 앞뒤가 안 맞아서 DB를 직접 열어봤다.

```sql
SELECT status FROM orders   WHERE order_no='...';  -- PENDING_PAYMENT  (?!)
SELECT status FROM payments WHERE order_no='...';  -- IN_PROGRESS      (?!)
```

응답은 `PAID`/`DONE`인데 DB는 `PENDING_PAYMENT`/`IN_PROGRESS`. 결제 승인이 실제로는 DB에 확정되지 않고 있었다. 결제 시스템에서 이건 최악의 종류다. 됐다고 답해놓고 실제론 안 된 상태니까.

### 1. 이상한 단서: 트랜잭션은 커밋되는데 UPDATE가 없다

먼저 상태머신을 의심했다. 그런데 `PAID → PENDING_PAYMENT`는 상태 전이표상 불가능한 전이다. PAID였다가 되돌아간 게 아니라, 애초에 PAID가 저장된 적이 없다는 뜻이었다.

응답의 `orderStatus`는 서비스가 메모리에 들고 있는 `order.getStatus()`로 만든다. 그건 `PAID`. 그런데 DB엔 반영이 안 됐다. 그럼 트랜잭션이 롤백됐나? 아니었다. 트랜잭션 디버그 로그를 켜봤다.

```
Creating new transaction [CheckoutService.confirm]
Participating in existing transaction (...)
Initiating transaction commit
Committing JPA transaction on EntityManager [...]
```

트랜잭션은 정상적으로 생성되고 커밋됐다. 그런데 SQL 로그는 이랬다.

```
insert into payments (...)          ← startApproval: IN_PROGRESS
insert into payment_history (...)   ← 이력
insert into payment_history (...)   ← approve()가 남긴 두 번째 이력
update stock ...                    ← 재고 차감(명시 쿼리)
...
(update payments set status=DONE  → 없음!)
(update orders  set status=PAID   → 없음!)
```

INSERT는 나가는데 상태를 바꾸는 UPDATE만 안 나간다. 트랜잭션이 커밋되는데도 dirty-checking이 만들어야 할 UPDATE가 없었다.

### 2. 왜 INSERT는 되고 UPDATE는 안 될까

여기서 실마리가 잡혔다. 이 프로젝트의 엔티티는 `@GeneratedValue(strategy = IDENTITY)`를 쓴다. IDENTITY 전략은 `persist()` 시점에 즉시 INSERT를 실행한다(DB가 생성한 ID를 바로 받아와야 하니까). 그래서 신규 엔티티의 INSERT는 flush 여부와 무관하게 즉시 나간다. 반면 기존 엔티티의 상태 변경(UPDATE)은 커밋 시점의 flush에 의존한다. 그 flush가 안 일어나면 UPDATE도 없다.

문제는 이 트랜잭션의 영속성 컨텍스트가 커밋 때 변경분을 flush하지 않는다는 것이었다. IDENTITY 즉시 INSERT가 이 문제를 가려서, 주문 행은 있으니 저장은 되는 줄 착각하게 만들었다.

> **정정(나중에 더 정확히 알게 된 것)**: 처음엔 이걸 "[OSIV를 꺼서](/blog/project/pay/pay-ch3-perf-cancel)(`open-in-view: false`) 그렇다"고 이해했는데, 부정확했다. 일반적인 read-write 트랜잭션 안에선 OSIV 여부와 무관하게 커밋 때 dirty-check가 flush된다(managed 엔티티라면). 진짜 원인은 이 경로의 세션 FlushMode가 AUTO가 아니었다는 데 있다. `@Transactional(readOnly = true)` 조회가 끼면 Hibernate가 FlushMode를 **MANUAL**로 바꿔서, 이후 dirty 변경이 커밋 때 flush되지 않는다. 거기에 "불러온 엔티티가 detached라 merge가 필요한" 경우까지 겹치면서, `order.markPaid()`·`payment.approve()` 같은 변경이 메모리에만 남고 사라졌다. OSIV off는 detached를 만드는 배경일 뿐, flush를 막는 직접 원인은 아니다.

### 3. 고치기: 애그리거트를 명시적으로 영속

해법은 dirty-checking의 자동 flush에 의존하지 않고, 상태를 바꾼 애그리거트를 명시적으로 저장하는 것.

```java
// 상태 전이(approve/abort/markUnknown)를 명시적으로 영속한다.
paymentRepository.saveAndFlush(payment);
```

처음엔 `save()`로 했는데, 여기서 재밌는 걸 발견했다. `save()`로 되는 곳과 안 되는 곳이 갈렸다.

- `findByOrderNo`로 불러온(detached) 엔티티(주문·에스크로 홀드)는 `save()`(=merge)로 확정됐다.
- `initiate`로 새로 만들어 persist한 managed 엔티티(결제)는 `save()`가 merge no-op이 되어 확정되지 않았다.

이 트랜잭션에서 자동 flush를 신뢰할 수 없다는 게 드러난 셈이다. 그래서 모든 애그리거트 상태 확정 지점을 `saveAndFlush`로 통일했다. merge 여부와 무관하게 flush를 강제한다. 가끔 되고 가끔 안 되는 저장을 결제 시스템에 둘 수는 없다.

같은 버그가 confirm뿐 아니라 취소·복구 배치·에스크로·가상계좌·구독에도 다 있었다. 불러와서 상태만 바꾸는 모든 곳. 전수 조사해서 한꺼번에 고쳤다.

고친 뒤 실기동으로 다시 확인했다.

```
승인      → 주문 PAID,     결제 DONE,             에스크로 RELEASED
전액취소  → 주문 CANCELED, 결제 CANCELED(잔액 0),  에스크로 REFUNDED
부분취소  → 주문 PAID,     결제 PARTIAL(잔액 7천), 에스크로 HELD 유지
```

이제 응답과 DB가 일치한다.

### 4. 왜 여태 안 잡혔나 — 테스트의 사각지대

제일 뼈아픈 질문. 테스트가 200개가 넘는데 왜 이걸 못 잡았지?

답은 테스트의 성격에 있었다. 이 프로젝트의 단위 테스트는 리포지토리를 목(mock)으로 둔다.

```java
OrderRepository orderRepository = mock(OrderRepository.class);
// order.markPaid() 후 상태가 PAID인지 "메모리에서" 검증
assertThat(order.getStatus()).isEqualTo(OrderStatus.PAID);  // 통과!
```

이 테스트는 "서비스 로직이 order를 PAID로 바꿨는가"를 검증한다. 그건 맞았다. 하지만 그게 실제 DB에 반영됐는지는 목이라서 검증할 수가 없다. dirty-checking flush 같은 영속성 계층의 동작은 진짜 DB를 써야만 드러난다.

그래서 이 버그는 단위 테스트의 사각지대에 정확히 숨어 있었다. [부하테스트(k6)](/blog/project/pay/pay-ch3-perf-cancel)도 HTTP 200만 봤지 DB 상태는 안 봤다. 에스크로가 "주문이 PAID여야 한다"는 조건을 실제로 요구하면서, 실기동에서 처음 터진 것이다.

목 기반 단위 테스트는 로직을 검증할 뿐 영속까지 검증하지 못한다. 상태 전이가 DB에 남는지는 실 DB 통합 테스트로만 확인된다. 그래서 재발 방지로 각 수정 지점에 `verify(repo).saveAndFlush(...)` 단언을 넣어, 최소한 "명시 저장을 호출한다"는 계약을 고정했다. 그리고 기능은 끝까지 눌러봐야 한다. "API가 200을 준다"와 "DB에 올바르게 남는다"는 다른 얘기다. E2E 실기동으로 실제 상태를 확인하지 않았다면, 이 버그는 운영에서 "결제됐다는데 주문이 없어요" 문의로 터졌을 것이다.

### 마치며

이번 건 새 기능이 아니라, 이미 있던 가장 위험한 버그를 실기동으로 잡아낸 편이다.

결제 시스템에서 "승인됐습니다"라는 응답은 약속이고, 그 약속이 DB에 확정되지 않으면 거짓말이 된다. 트랜잭션이 커밋되는데도 변경이 유실될 수 있다는 것, 그걸 목 테스트는 못 잡는다는 것. 이 둘을 실제 장애가 아니라 실기동 검증에서 만난 게 다행이었다. 터지기 전에 찾아서 고쳤다.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, 수정 후 승인/취소/부분취소/구매확정을 실 MySQL로 전수 검증했다.*

<hr />

## 결제 시스템을 밑바닥부터 만들고 나서 — 27편의 회고

가장 위험했던 버그까지 잡고 나니, 여기서 한 번 여정을 정리하고 갈 때가 됐다. 27편 동안 만든 걸 돌아보면 전부 하나의 주제로 수렴한다. "돌아가는 것"과 "실제로·안전하게 돌아가는 것" 사이의 구멍을 하나씩 메우는 일.

### 왜 이걸 만들었나

[첫 편](/blog/project/pay/pay-ch1-payment-core)에서 결제의 정상 경로는 사실 쉽다고 했다. 주문 만들고, PG 부르고, 성공하면 완료. 어려운 건 그 다음이다. 타임아웃되면? 중복 요청이 따닥 들어오면? 승인은 됐는데 재고가 없으면? 우리 DB와 PG가 어긋나면?

그래서 이 프로젝트는 처음부터 "장애는 실제로 일어난다"를 전제로, 실패·정합성 처리에 무게를 뒀다.

### 세 갈래로 돌아보기

#### 1) 실패를 상태로 보존하기

가장 핵심이었던 결정은 [타임아웃을 실패로 단정하지 않은 것](/blog/project/pay/pay-ch1-payment-core)이다. PG 승인이 타임아웃되면 성공도 실패도 아닌 **UNKNOWN(미확정)**으로 보존하고, [복구 배치](/blog/project/pay/pay-ch4-arch-events-ops)가 나중에 조회로 확정한다. 모르는 것을 모른다고 두는 이 3-상태 모델이, 결제에서 이중결제·유실을 막는 뿌리였다.

여기서 여러 갈래가 파생됐다. [멱등키](/blog/project/pay/pay-ch2-payment-methods)로 따닥 중복 차단, [서킷브레이커](/blog/project/pay/pay-ch4-arch-events-ops)로 승인은 재시도 안 하고 UNKNOWN 폴백, [보상 트랜잭션](/blog/project/pay/pay-ch3-perf-cancel)으로 승인 후 재고 부족을 자동 망취소. 전부 부분 실패를 어떻게 봉합하느냐의 변주다.

#### 2) 돈의 정합성 지키기

돈은 틀리면 안 되니까, [복식부기 원장](/blog/project/pay/pay-ch1-payment-core)(차변=대변 불변식), 정산, 그리고 내부·외부 기록을 맞춰보는 대사를 뒀다. [취소](/blog/project/pay/pay-ch3-perf-cancel)는 포인트 우선 환불·재취소 이중환불 차단을 다뤘고, [에스크로](/blog/project/pay/pay-ch4-arch-events-ops)는 구매확정 전까지 판매자 정산을 보류했다.

이 정합성은 [모듈 경계가 지켜질 때만](/blog/project/pay/pay-ch4-arch-events-ops) 성립해서, 경계를 `ModularityTests`로 강제하고 CI에 얹었다. 이벤트는 [Kafka로 외부화](/blog/project/pay/pay-ch4-arch-events-ops)해 프로세스 밖으로도 흘릴 수 있게 여지를 뒀다.

#### 3) 측정하고, 검증하고, 드러내기

감이 아니라 수치로 결정하려 했다. [락 3종 비교](/blog/project/pay/pay-ch1-payment-core)로 재고 차감 전략을 골랐고, [부하테스트가 BCrypt 병목을 짚어주자](/blog/project/pay/pay-ch3-perf-cancel) [JWT로 걷어내](/blog/project/pay/pay-ch3-perf-cancel) min 110ms→4ms를 전후 수치로 확인했다. 복원력은 주장만 하지 않고 [Toxiproxy로 실제 네트워크를 끊어](/blog/project/pay/pay-ch4-arch-events-ops) 검증했다.

### 만드는 내내 반복된 것: 실기동이 진실을 말한다

돌아보면 이 시리즈에서 "앱이 실제로 안 떴다"가 몇 번이나 반복됐다. [7편](/blog/project/pay/pay-ch1-payment-core)에서, 확장 모듈을 붙였을 때, 그리고 스키마 마이그레이션을 빠뜨렸을 때. 테스트가 다 초록불이어도 실기동은 다른 얘기였다.

정점이 [바로 앞 절](/blog/project/pay/pay-ch5-runtime-truths)이다. 200개가 넘는 테스트가 통과하는데도 결제 승인이 DB에 확정되지 않는 치명 버그가 실기동에서야 드러났다. 리포지토리를 목으로 둔 단위 테스트는 로직만 검증하지 영속은 검증하지 못했으니까. 이 하나가 프로젝트 전체의 교훈을 압축한다.

> **"테스트 초록불 ≠ 실제로 동작함."** 단위 테스트는 로직을, 통합·실기동은 진짜 동작을 검증한다. 결제처럼 정합성이 생명인 시스템일수록, "API가 200을 준다"에서 멈추지 말고 "DB에 올바르게 남는가"를 끝까지 눌러봐야 한다.

### 무엇이 남았나

이 시스템은 여전히 미완성이다. JWT는 만료·갱신·폐기가 필요하고, Kafka 소비자는 별도로 존재하지 않고, 대사는 실제 PG 파일 포맷과 붙여야 하고, 부하도 단일 노트북 수준이다. 실서비스라면 넘어야 할 산이 훨씬 많다.

다만 이 프로젝트의 목적은 완성된 결제사가 아니라, 결제 도메인의 어려운 지점들 — 실패, 정합성, 관측성 — 을 실제로 마주하고 하나씩 풀어보는 것이었다. 만드는 내내 정상 경로보다 "이 경우엔 어떻게 되지?"라는 질문에 코드로 답하려 했다.

### 마치며

밑바닥부터 만들어보고 제일 크게 남은 감각. 어떻게 성공하느냐보다, 어떻게 실패하고 그걸 어떻게 안전하게 다루느냐가 훨씬 중요하다.

승인 한 번 성공시키는 건 쉽다. 타임아웃된 승인을 미확정으로 보존하고, 중복 요청을 멱등하게 흘리고, 승인 후 문제를 보상으로 되돌리고, 그 모든 게 DB에 정확히 확정되는지 실기동으로 확인하는 것. 이 지루하고 꼼꼼한 일들이 결제의 신뢰를 만든다.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있다. 각 개선은 실측·실기동으로 검증했고, 발견한 버그는 재발 방지 테스트와 함께 고쳤다.*

<hr />

## 나중에 확인하세요"라고 해놓고 확인할 곳이 없었다 — 폴링 계약을 완성한 조회 API

회고까지 쓰고 끝난 줄 알았는데, 스펙에 적힌 조회 엔드포인트 두 개가 코드엔 하나도 없었다. UNKNOWN 모델의 폴링 계약이 반쪽으로 서 있었던 것이다.

### 0. 끝인 줄 알았는데

[앞 절의 회고](/blog/project/pay/pay-ch5-runtime-truths)까지 쓰고 "이제 됐다" 싶었다. 그런데 마지막으로 API 스펙 문서(`docs/10`)를 다시 훑어보다가 이상한 걸 발견했다.

스펙엔 이런 엔드포인트가 적혀 있었다.

```
GET /api/v1/orders/{orderNo}      — 주문 조회 (결제 상태 포함)
GET /api/v1/payments/{paymentId}  — 결제 조회
```

그런데 코드엔 하나도 없었다. 전체 엔드포인트를 grep해보니 주문·결제에 GET 매핑이 0개. 생성(POST)·승인·취소만 있었다. "조회쯤이야 나중에" 하고 미뤄뒀던 게 회고를 쓸 때까지 그대로 빠져 있었다.

문제는 이게 단순한 편의 기능 누락이 아니었다는 점이다.

### 1. 이 시스템의 간판이 반쪽이었다

이 프로젝트에서 제일 강조한 설계가 [UNKNOWN 3-상태 모델](/blog/project/pay/pay-ch1-payment-core)이다. PG 승인이 타임아웃되면 실패로 단정하지 않고 `UNKNOWN`으로 보존하고 —

```json
// 승인 타임아웃 시 응답
202 Accepted
{ "orderStatus": "PAYMENT_IN_PROGRESS", "paymentStatus": "UNKNOWN",
  "message": "결제 결과를 확인하고 있습니다. 잠시 후 다시 확인해 주세요." }
```

"잠시 후 다시 확인해 주세요"라고 답한다. [복구 배치](/blog/project/pay/pay-ch4-arch-events-ops)가 PG 조회로 확정하면, 클라이언트는 폴링으로 그 확정 결과를 확인하는 게 계약이다.

그런데 정작 폴링할 조회 API가 없었다. "나중에 확인하세요"라고 해놓고 확인할 곳을 안 준 셈이다. 사용자가 결말을 볼 방법이 없으니, 없던 기능을 새로 만드는 게 아니라 이미 한 약속을 지키는 일이었다. 우선순위가 제일 높을 수밖에 없었다.

### 2. 조회에도 소유권은 지킨다

조회 API를 만들 때 제일 신경 쓴 건 소유권이다. 남의 주문·결제를 조회로 훔쳐보면 안 된다([IDOR](/blog/project/pay/pay-ch2-payment-methods)는 조회에도 똑같이 적용된다).

여기서 모듈 경계 문제가 하나 있었다. `GET /payments/{paymentId}`는 결제 조회인데, 결제의 소유권 검증은 결제 모듈이 못 한다. userId ↔ 주문 매핑은 order 모듈이 소유하고, payment는 사용자가 누군지 모르기 때문이다.

그래서 이렇게 나눴다.

> 두 조회 모두 order 모듈에서 소유권을 검증한다. `GET /payments/{paymentId}`는 payment 모듈의 `orderNoOf(paymentId)`(결제→주문번호만 반환)를 부른 뒤, order가 그 주문을 로드해 `verifyOwner`로 확인하고, 통과한 뒤에야 결제 상세를 조회한다. payment는 "이 결제가 누구 것인지" 몰라도 되고, 남의 결제는 존재 여부조차 안 드러난다(소유권 실패 시 상세 조회 자체를 안 하니까).

이건 [POST /payments/confirm이 order 모듈의 컨트롤러에 있는 것](/blog/project/pay/pay-ch4-arch-events-ops)과 같은 결이다. 결제 관련이라도 사용자·소유권이 얽히면 order가 관문을 맡는다. 경계를 지키면서 IDOR도 막았다.

### 3. 무엇을 대표 상태로 보여줄까

작은 판단이 하나 있었다. 한 주문에 결제 시도가 여러 번 있을 수 있다(첫 시도 UNKNOWN, 재시도 등). `GET /orders/{orderNo}`가 결제 상태를 함께 보여줄 때, 어느 결제를 대표로 보여줘야 할까?

최신 시도(`requestedAt` 내림차순)를 대표로 택했다. 이래야 "UNKNOWN이던 최신 시도가 복구 배치로 DONE이 됐다"는 진행을 주문 단위 폴링으로 관측할 수 있다. 성공 건만 보여주면 UNKNOWN→DONE으로 바뀌는 과정을 못 본다. 이 판단은 메서드 주석과 스펙에 명시했다.

이제 흐름이 이렇게 닫힌다.

```
승인 요청 → (타임아웃) → 202 UNKNOWN
   ↓  클라이언트 폴링
GET /orders/{orderNo}  →  paymentStatus: "UNKNOWN"   (아직)
   ↓  (복구 배치가 PG 조회로 확정)
GET /orders/{orderNo}  →  paymentStatus: "DONE"      (확정!)
```

응답으로 노출하는 건 전부 뷰 record다. 엔티티(`Payment`·`PaymentHistory`는 package-private)를 모듈 밖으로 내보내지 않고, 조회에 필요한 필드만 담은 불변 record로 응답한다. 결제 상세엔 상태·잔액·상태 전이 이력·취소 투영을 담았다.

### 마치며

GET 두 개니 화려하진 않다. 하지만 이미 한 약속을 지킨다는 점에서 꽤 중요했다.

회고까지 써놓고도 스펙을 다시 보니 계약이 반쪽이었다. "다 만들었다"는 감각과 "스펙대로 다 됐다"는 사실은 다르다. 문서에 적어둔 계약을 코드가 실제로 지키는지, 끝났다고 생각한 뒤에 한 번 더 대조한 덕에 이 구멍을 찾았다.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, 조회는 소유권 검증 후 뷰 record로만 응답한다.*

<hr />

## 배치가 도착하기 전에 지금 확정해야 할 때 — 단건 동기화와 수기 대사 확정

조회 API로 사용자 쪽 계약을 닫고 나니, 이번엔 운영자 쪽이 보였다. 전체를 훑는 배치는 있는데 "특정 한 건을 지금 처리"하는 경로가 없었다. 단건 PG 강제 동기화와 수기 대사 확정, 이 둘을 채운 기록이다.

### 0. 전체 배치는 있는데, 이 한 건은?

[어드민 편](/blog/project/pay/pay-ch4-arch-events-ops)에서 운영 개입 손잡이를 여럿 만들었다. 그런데 실제 운영 시나리오를 더 그려보니 위의 두 경로가 빠져 있었다.

### 1. 단건 PG 강제 동기화 — 배치를 기다릴 수 없을 때

결제 [웹훅](/blog/project/pay/pay-ch1-payment-core)이 누락되는 일은 실제로 있다(PG쪽 발송 실패, 네트워크 유실). 그럼 우리 DB엔 결제가 `IN_PROGRESS`나 `UNKNOWN`으로 남고, PG엔 승인이 돼 있는 불일치가 생긴다.

[복구 배치](/blog/project/pay/pay-ch4-arch-events-ops)가 주기적으로 이런 미확정 건을 PG 조회로 확정한다. 그런데 이런 상황이 남는다.

> 고객이 "결제했는데 처리가 안 됐어요" 문의를 지금 넣었다. 운영자는 다음 배치 주기를 기다릴 수 없다. 그 건 하나만 지금 PG에 물어봐서 확정하고 싶은데, 전체 스캔 배치(`/admin/payments/recover`)밖에 없었다.

그래서 단건 동기화를 열었다.

```
POST /api/v1/admin/payments/{id}/sync
→ { "paymentId": 1, "orderNo": "...", "status": "DONE",
    "message": "PG 조회로 상태를 동기화했습니다" }
```

좋았던 건 새 로직을 거의 안 짰다는 점이다. 이미 [웹훅이 "페이로드를 믿지 말고 조회로 재검증"](/blog/project/pay/pay-ch1-payment-core)할 때 쓰던 `resolveByPaymentKey(paymentKey)`가 있었다. PG를 조회해서 승인돼 있으면 DONE, 없으면 ABORTED, 취소됐으면 CANCELED로 확정하는 메서드다. sync는 결제 id로 paymentKey를 찾아 그걸 그대로 재사용하고, 확정 뒤 상태를 다시 읽어 응답만 한다.

> 이미 확정된(DONE 등) 건을 sync해도 안전하다. `resolveByPaymentKey`가 UNKNOWN/IN_PROGRESS일 때만 조회하고 나머지는 멱등 no-op이라서다. 운영자가 "혹시 몰라" 눌러도 이중 처리가 없다.

배치(전체 스캔)와 단건 sync가 같은 확정 로직을 공유하는 게 핵심이다. 정기적 자동 확정과 즉시 수동 확정이 서로 다르게 동작하면, 그게 바로 버그의 씨앗이니까.

### 2. 수기 대사 확정 — 조회만으론 부족하다

두 번째는 [대사(reconciliation)](/blog/project/pay/pay-ch1-payment-core)다. 내부 기록과 PG 파일을 맞춰보고, 안 맞으면 4분류(내부만/외부만/금액불일치) 중 하나로 `PENDING`(사람 확인 필요)을 남긴다. 어드민에서 이 예외 큐를 조회는 할 수 있었다.

그런데 조회만 되고 "확인했다"고 표시할 방법이 없었다. 운영자가 불일치를 조사해서 "이건 타이밍 차이였고 실제론 정상"이라고 결론 내려도, 그 건은 영원히 `PENDING`으로 남는다. 다음에 봐도 아직 안 본 건인지 봤는데 처리한 건인지 구분이 안 된다.

그래서 수기 확정을 붙였다.

```
POST /api/v1/admin/reconciliations/{id}/resolve   → PENDING → MANUALLY_RESOLVED
```

`ReconStatus`에 `MANUALLY_RESOLVED`를 추가하고, `PENDING`에서만 이 전이가 되게 가드를 뒀다(이미 확정된 걸 또 확정 못 하게). 여기서 두 가지 판단이 있었다.

**(1) 누가·왜 확정했는지는 어디에 남기나.** 엔티티에 `resolvedBy`, `note` 컬럼을 추가할 수도 있었지만, 감사 로그로 남기는 걸 택했다. 이 프로젝트엔 이미 상태 변경 어드민이 [감사 로그](/blog/project/pay/pay-ch4-arch-events-ops)를 남기는 패턴이 있고, "누가 언제 무엇을 했나"는 append-only 감사 테이블의 몫이다. 대사 결과 행은 최종 상태(MANUALLY_RESOLVED)만 들고, 이력은 감사가 맡는다. 덕분에 스키마 변경도 status enum에 값 하나 추가(V6)로 최소화됐다.

**(2) 상태 변경을 진짜로 저장하기.** [바로 앞서 잡은 버그](/blog/project/pay/pay-ch5-runtime-truths)의 교훈이 그대로 적용됐다. 이 프로젝트에서 불러온 엔티티의 상태만 바꾸고 두면 커밋 때 flush가 유실될 수 있다는 걸 방금 확인했으니까. `result.resolveManually()`로 상태만 바꾸고 두면 DB엔 안 남을 수 있다. 그래서 `repository.saveAndFlush(result)`로 명시 영속했다. 방금 배운 걸 새 코드에 곧바로 적용한 셈이다.

### 마치며

이번 두 어드민의 공통점은 "자동화의 정기 주기와 별개로, 사람이 지금 이 한 건을 손볼 수 있게"다. 배치는 전체를 훑고, 어드민은 특정 건을 즉시. 이 둘이 다 있어야 운영이 돌아간다.

단건 sync는 배치와 같은 확정 로직(조회 재검증 경로)을 재사용했고, 수기 확정엔 방금 배운 saveAndFlush를 곧바로 적용했다. 새 기능이 기존 자산과 직전의 교훈 위에 얹혔다.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, V6 마이그레이션·단건 sync·ROLE_ADMIN 인가를 실 MySQL로 검증했다.*

<hr />

## 한 사람이 남의 돈을 취소하게 두지 않는다 — 강제취소의 2인 승인(maker-checker)

운영 손잡이가 늘어날수록 무거워지는 권한이 하나 있다. 강제취소다. 이 권한에 maker-checker 2인 승인을 걸고, 요청자≠승인자 규칙을 엔티티 레벨에 박아 우회를 원천 차단했다.

### 0. 강제취소는 필요하지만, 무섭다

운영을 하다 보면 결제를 강제로 취소해야 할 때가 있다. 분쟁 조정, 명백한 오류 정정, 사기 확인 후 환불 같은. 그래서 어드민에 강제취소 기능이 필요하다. 그런데 이건 무서운 권한이다.

> 한 사람이 단독으로 아무 결제나 취소할 수 있다는 건, 그 사람의 실수나 악의가 곧바로 남의 돈에 영향을 준다는 뜻이다. 내부자 부정, 오조작, 계정 탈취 중 어느 하나만 뚫려도 피해가 즉시 발생한다. 금융에서 이건 용납되지 않는다.

그래서 금융 백오피스엔 표준 패턴이 있다. **maker-checker(4-eyes)**. 요청하는 사람(maker)과 승인하는 사람(checker)을 반드시 다른 사람으로 강제한다. 두 사람의 눈을 거쳐야 실행되니, 한 명이 뚫려도 단독으론 아무것도 못 한다.

### 1. 흐름: 요청 → (다른 사람) 승인 → 실행

강제취소를 2단계로 나눴다.

```
POST /admin/payments/{id}/force-cancel        → 요청 생성 (REQUESTED, requestedBy=요청자)
POST /admin/force-cancels/{reqId}/approve     → 다른 어드민이 승인 = 실행 (EXECUTED)
POST /admin/force-cancels/{reqId}/reject      → 거부 (REJECTED)
GET  /admin/force-cancels?status=REQUESTED    → 승인 대기 큐
```

요청은 `force_cancel_requests` 테이블에 남는다(누가 요청했는지, 얼마를, 왜). 그리고 다른 어드민이 승인 큐에서 그 요청을 승인하면, 그때 실제 취소가 실행된다.

### 2. 핵심 질문: 요청자≠승인자를 어디서 강제하나

이번 구현의 진짜 포인트. "요청자와 승인자가 달라야 한다"를 어느 계층에서 검사하느냐다.

컨트롤러에서? 서비스에서? 둘 다 우회 가능성이 있다. 그래서 도메인 엔티티 안에 넣었다.

```java
public void approve(String approver) {
    if (this.status != ForceCancelStatus.REQUESTED) {
        throw ... // 이미 처리된 요청
    }
    if (approver.equals(this.requestedBy)) {
        throw new PaymentException("MAKER_CHECKER_VIOLATION",
                "요청자는 자신의 강제취소를 승인할 수 없습니다.");
    }
    this.status = ForceCancelStatus.EXECUTED;
    this.approvedBy = approver;
}
```

> 규칙을 엔티티의 상태 전이 메서드에 박으면, 어느 서비스·어느 컨트롤러가 부르든 우회가 불가능하다. 나중에 다른 경로에서 approve를 호출해도 이 가드를 반드시 통과해야 하니까. "비즈니스 규칙은 엔티티가 지킨다"는 원칙([상태머신 가드](/blog/project/pay/pay-ch1-payment-core)와 같은 결)을 maker-checker에도 적용했다.

서비스는 이 가드를 통과한 뒤에만 실제 취소를 실행한다. 그래서 요청자가 자기 요청을 승인하려 하면 취소 로직은 아예 호출되지 않는다(테스트에서 `never()`로 검증).

실기동으로 확인했다.

```
1) admin이 강제취소 요청       → REQUESTED (requestedBy=admin)
2) admin 본인이 승인 시도       → 403 MAKER_CHECKER_VIOLATION   ← 자기 요청 승인 차단
3) admin2가 승인               → 200 EXECUTED (approvedBy=admin2)
4) 결제 실제 상태              → CANCELED, balance 0            ← 진짜로 취소됨
```

(2인 흐름을 시연하려면 어드민이 둘 필요해서 `admin2`를 하나 추가했다. 어드민이 하나뿐이면 모든 승인이 자기 승인이 되어 항상 막힌다.)

데모 콘솔에서 요청자 본인이 승인을 누르면 이렇게 막힌다.

![강제취소 요청자 본인 승인 차단 — MAKER_CHECKER_VIOLATION](/uploads/project/pay/demo/demo-maker-checker.png)

### 3. 승인 = 실행, 그런데 기존 걸 재사용

승인이 통과하면 실제 취소를 해야 한다. 여기서 새 취소 로직을 또 짜지 않고, [이미 있는 `PaymentService.cancel`](/blog/project/pay/pay-ch3-perf-cancel)을 그대로 불렀다.

```java
public ForceCancelView approve(long requestId, String approver) {
    ForceCancelRequest req = load(requestId);
    req.approve(approver);   // maker-checker 가드 (여기 통과해야 아래로)
    paymentService.cancel(req.getPaymentId(), Money.of(req.getCancelAmount()), req.getReason());
    repository.saveAndFlush(req);
    ...
}
```

`paymentService.cancel`은 결제 취소 + PG 망취소 + [현금영수증 연쇄취소·원장 역분개 이벤트](/blog/project/pay/pay-ch3-perf-cancel)까지 이어주는 경로다. 강제취소도 이 경로를 타니, 일반 취소와 똑같이 정합성이 유지된다. 이 전체가 한 트랜잭션이라, PG 취소가 실패하면 롤백되고 요청은 `REQUESTED`로 남아 재시도할 수 있다.

여기에도 [최근 배운 saveAndFlush](/blog/project/pay/pay-ch5-runtime-truths)를 잊지 않고 적용했다. 요청 상태를 EXECUTED로 바꾼 게 실제 DB에 남도록.

### 4. 누가·언제·무엇을

강제취소는 민감하니 모든 요청과 승인을 감사 로그로 남긴다. 요청자, 승인자, 대상 결제, 금액, 시각. `force_cancel_requests` 테이블 자체가 "누가 요청하고 누가 승인했나"(requestedBy/approvedBy)를 들고 있고, 상태 변경 액션은 [감사 로거](/blog/project/pay/pay-ch4-arch-events-ops)에도 찍힌다.

이게 중요한 이유가 있다. maker-checker의 목적은 사고를 막는 것만이 아니라, 사고가 나도 추적 가능하게 만드는 것이기도 하다. 나중에 "이 취소는 누가 왜 했나"에 반드시 답할 수 있어야 한다.

### 마치며

기능 자체는 요청·승인 두 엔드포인트로 단순하다. 하지만 "위험한 권한을 어떻게 안전하게 주느냐"라는, 금융 시스템의 본질적인 질문을 다뤘다.

요청자≠승인자 규칙을 엔티티에 박아 우회를 원천 차단했고, 승인이 통과하면 기존 취소 경로를 재사용해 정합성을 공짜로 얻었다. 새 권한을 열되, 그 권한이 함부로 쓰일 수 없게 만드는 게 이번 개선이었다.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, 본인승인 차단→2인 승인→실제 취소를 실 MySQL로 검증했다.*

<hr />

## 판정 엔진은 있는데 심사할 곳이 없었다 — FDS 사후 탐지와 REVIEW 큐

운영 완성의 마지막 조각은 FDS였다. 만들어두고 아무 흐름에도 연결하지 않았던 판정 엔진을 이벤트 구독으로 실제 거래에 붙이고, REVIEW 판정을 담을 심사 큐와 어드민 처리 경로를 만들었다.

### 0. 만들어뒀는데 안 쓰이던 엔진

[확장 기능들](/blog/project/pay/pay-ch2-payment-methods)을 만들 때 이상거래탐지(FDS) 룰 엔진도 넣었다. 블랙리스트·velocity(속도)·고액을 점수로 매겨 `ALLOW/CHALLENGE/REVIEW/BLOCK`을 결정하는. 임계값도 프로퍼티로 빼서 배포 없이 조정 가능하게.

그런데 이번에 문서와 코드를 대조하다 깨달았다. 이 엔진이 정작 아무 흐름에도 연결돼 있지 않았다. `evaluate()`는 단위 테스트만 부르고 있었고, 실제 결제가 이걸 거치지 않았다. 게다가 `REVIEW`(사람 검토 필요) 판정이 나와도 그걸 담아둘 큐도, 어드민이 처리할 방법도 없었다. 판정만 하고 아무도 안 보는 엔진이었다.

### 1. 크리티컬 경로는 건드리지 않는다

제일 먼저 정한 원칙. FDS를 붙인다고 결제 승인 경로(confirm)를 건드리지 않는다.

이유는 두 가지다.

> **(1) 위험**: confirm은 [방금 큰 버그를 잡은](/blog/project/pay/pay-ch5-runtime-truths) 크리티컬 경로다. 여기에 FDS 평가를 끼워 넣으면 결제 지연·실패 리스크가 생긴다. **(2) 데이터**: 동기 인라인 판정은 IP·기기ID 같은 요청 시점 신호가 필요한데, 이걸 confirm에 다 흘려보내려면 배관이 커진다.

그래서 방향을 비동기 사후 탐지(post-hoc)로 잡았다. 결제가 완료되면 `PaymentConfirmedEvent`가 울리는데, [이걸 fraud 모듈이 구독](/blog/project/pay/pay-ch4-arch-events-ops)해서 승인이 끝난 뒤 별도로 평가한다.

```java
@ApplicationModuleListener
void onConfirmed(PaymentConfirmedEvent e) {
    String cardKey = paymentService.paymentKeyOf(e.paymentId()).orElse(null);
    if (cardKey == null) return;
    FraudResult r = fraudService.evaluate(
        new FraudCheckRequest(0L, cardKey, null, null, e.amount()));  // 같은 판정 엔진 재사용
    if (r.decision() == REVIEW || r.decision() == BLOCK) {
        reviewRepository.save(FraudReview.flagged(e.orderNo(), e.paymentId(), cardKey, e.amount(), r));
    }
}
```

이게 [Outbox 이벤트](/blog/project/pay/pay-ch1-payment-core)로 승인 완료 후 비동기로 도니, 결제 지연이나 실패에 전혀 영향을 주지 않는다. 판정 엔진은 그대로 재사용하고, 붙이는 방식만 이벤트 리스너로 바꿨다.

### 2. 사후 탐지의 신호 한계 — 솔직하게

정직하게 짚을 한계가 있다. `PaymentConfirmedEvent`는 [Zero-Payload](/blog/project/pay/pay-ch1-payment-core)(식별자·최소 정보만) 지향이라, IP·기기ID·userId 같은 요청 시점 신호가 없다.

그래서 사후 평가는 `userId=0`, `ip=null`, `device=null`로 두고 cardKey(결제키)와 금액만으로 판정한다. 다행히 이 프로젝트의 활성 룰(블랙리스트·velocity·고액)이 전부 cardKey와 금액을 기준으로 동작해서, 사후에도 정상적으로 점수가 나온다.

> 동기 인라인 판정이라면 IP·기기로 더 촘촘히 볼 수 있지만, 사후 탐지는 그 신호가 없다는 걸 리스너 주석에 명시했다. 무엇을 못 보는지 숨기지 않아야, 나중에 이 코드를 읽는 사람에게 정직하다.

cardKey는 이벤트에 없어서 `paymentKeyOf(paymentId)`로 되읽고, 그것도 없으면 조용히 넘어간다. REVIEW/BLOCK만 큐에 넣고, ALLOW/CHALLENGE는 안 넣는다. (BLOCK은 사후엔 이미 결제가 끝나 막을 순 없지만, 긴급 심사 대상으로 적재한다.)

### 3. 심사 → 거부 → 사전 차단으로 이어지는 루프

큐에 쌓인 REVIEW를 어드민이 처리한다.

```
GET  /admin/fraud-reviews?status=PENDING   → 심사 대기 큐
POST /admin/fraud-reviews/{id}/approve     → 정상 거래로 확인 (APPROVED)
POST /admin/fraud-reviews/{id}/reject      → 사기로 판정 (REJECTED) + 카드 블랙리스트
```

제일 중요한 건 거부(reject)다. 단순히 "사기로 표시"하고 끝나지 않는다.

```java
public FraudReviewView reject(long id, String reviewer) {
    FraudReview review = load(id);
    review.reject(reviewer);
    fraudService.blacklistCard(review.getCardKey());   // 향후 같은 카드는 BLOCK
    repository.saveAndFlush(review);
    ...
}
```

거부하면 그 카드를 블랙리스트에 넣는다. 그러면 이후 같은 카드의 결제는 판정 엔진이 `BLOCK`으로 잡는다. 사후 탐지 → 사람 심사 → 사전 차단으로 이어지는 피드백 루프가 닫히는 것이다. 한 번 사기로 판정된 카드는 다음번엔 애초에 막힌다.

큐 뷰에서 결제키(cardKey)는 민감하니 앞 4자리·뒤 4자리만 보이게 마스킹했고, 모든 승인/거부는 [감사 로그](/blog/project/pay/pay-ch4-arch-events-ops)로 남긴다. 상태 변경엔 [예의 saveAndFlush](/blog/project/pay/pay-ch5-runtime-truths)도 적용했다.

### 마치며

새 엔진을 만든 게 아니라, 이미 있던 엔진을 실제로 쓰이게 연결한 편이다.

크리티컬 경로를 지키려고 비동기 사후 탐지를 택했고, 사후엔 신호가 부족하다는 한계를 코드 주석에 남겼고, 거부가 블랙리스트로 이어지게 해 탐지가 차단으로 닫히는 루프를 만들었다. 이벤트 구독 하나로, 판정만 하고 아무도 안 보던 엔진이 실제 거래를 평가하고 사람의 심사를 거쳐 조금씩 촘촘해지기 시작했다.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, V8 마이그레이션·사후 탐지 리스너·심사 어드민을 실 MySQL로 검증했다.*

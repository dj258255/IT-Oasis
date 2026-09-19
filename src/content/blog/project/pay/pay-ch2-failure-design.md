---
title: '타임아웃을 실패로 확정하지 않고 미확정으로 남기기'
description: '타임아웃은 실패가 아니라 미확정이라 보존하고 복구가 확정합니다. 이미 나간 승인은 롤백이 안 되니 보상으로 되돌립니다. failover는 PG가 요청을 못 받은 경우에만 하고, 고르는 시점은 결제창 앞으로 옮겼습니다.'
date: 2026-03-02
category: study/pay
coverImage: "/uploads/project/pay/thumbs/pay-failure.svg"
draft: false
series: "결제 시스템 만들기"
seriesOrder: 2
tags:
  - Payment
  - 실패 설계
  - 멱등성
  - 보상 트랜잭션
  - 결제 시스템
---

개인 프로젝트로 만든 결제 시스템 pay의 개발 기록입니다. 실무 운영 경험이 아닙니다.

카드에서는 돈이 나갔는데 서버는 그 결제를 실패로 처리하고 있었다. PG 응답이 없으면 결과를 모르고, 승인이 나간 뒤엔 롤백으로 못 되돌린다. 응답·정합 문제를 다섯으로 나눠 다룬 기록이다 — 기준은 무엇이 확정됐고 무엇이 미상인가.

## 상황 1 — 응답이 안 온 승인은 실패가 아니라 미확정이다

타임아웃을 실패로 단정할 것인가, 미확정으로 남길 것인가. 미확정으로 남기고 복구가 확정하게 했다([1편](/blog/project/pay/pay-ch1-what-to-trust)). "타임아웃 = 실패"면 카드에서는 돈이 빠졌는데 우리는 주문을 취소한다. 카카오페이의 3-상태 모델을 따라 명시적 거절만 `FAILED`, 타임아웃은 `UNKNOWN`으로 남긴다.

```java
case SUCCESS -> payment.approve(...);
case FAILED  -> payment.abort(...);          // 명시적 거절만 실패
case TIMEOUT -> payment.markUnknown(reason); // 미확정 — 보존
```

### 1. 멱등키는 유니크 제약으로

따닥(중복 클릭)은 서버에서 막았다. `(멱등키 + 경로 + 메서드)` 유니크라 동시에 온 두 요청 중 하나만 INSERT에 성공하고 나머지는 유니크 위반으로 튕긴다. 응답은 토스페이먼츠와 같은 시맨틱이다 — 완료된 키는 첫 응답 재반환, 처리 중 `409`, 같은 키에 본문이 다르면 `422`, 키 오류 `400`.

```java
try { record = repository.saveAndFlush(IdempotencyRecord.start(key, path, method, requestHash)); }
catch (DataIntegrityViolationException race) { return handleExisting(reload(key), requestHash, responseType); }
```

### 2. 복구 배치가 UNKNOWN을 확정한다

복구 배치가 `UNKNOWN`을 60초마다 스캔해 PG 조회로 실제 상태를 묻는다. 승인돼 있으면 취소하지 않고 **전진 복구(DONE)**, `NOT_FOUND`면 `ABORTED`, PG가 이미 취소했으면 상태 동기화(망취소 아님)다. 반대 정책(무조건 망취소)도 `networkCancel`로 넣어 둘 다 허용 전이로 뒀다.

```java
case APPROVED  -> payment.confirmByRecovery(pg.method());   // 전진 복구(DONE)
case NOT_FOUND -> payment.abortByRecovery("PG에 결제 없음");
case CANCELED  -> payment.confirmCanceledByRecovery();      // PG 취소 → 상태 동기화
```

### 3. 서킷브레이커: 승인은 재시도하면 안 된다

PG가 죽으면 모든 요청이 10초씩 걸려 스레드가 고갈된다. Resilience4j 서킷브레이커로 감싸고 OPEN이면 호출 없이 폴백한다. 승인은 "장애엔 재시도"가 통하지 않는다 — 어댑터가 `Idempotency-Key: orderNo`를 실어 보내도 코어는 그 보장에 기대지 않기 때문이다. 그래서 승인은 재시도를 안 켰고 실패·서킷오픈 시 `UNKNOWN`으로 돌린다.

```java
} catch (CallNotPermittedException open) {
    return PgApproveResult.timeout("서킷 오픈: PG 장애로 승인 미확정"); // 재시도 아님 — UNKNOWN
}
```

### 4. 후처리 여섯 중 셋을 뺐다

[카카오페이의 MSA 결제 트랜잭션 관리 글](https://tech.kakaopay.com/post/msa-transaction/)이 나열한 후처리 여섯 중 승인을 한 번 더 보내는 둘과 확인 없이 성공으로 넘기는 하나를 뺐다 — 다시 보내면 두 번 결제된다. 재시도는 조회 하나뿐이다(승인을 왜 안 켰는지는 [§3](#3-서킷브레이커-승인은-재시도하면-안-된다)). 이 기준은 뒤의 데드락에서도 썼다([동시성 편](/blog/project/pay/pay-ch2-concurrency-and-load)). 응답은 `200`·`400`·`202`로 나눈다.

`PaymentRecoveryScheduler`가 60초마다 미확정 건을 다시 묻고, 10분을 넘기면 알림이 울려 사람이 닫는다. 보상도 소진하면 `FAILED`로 두고 `compensation.exhausted`를 올린다([운영 자동화 편](/blog/project/pay/pay-ch9-batch-ownership)의 연장선).

### 5. 고객이 다른 카드로 다시 누르면

고객은 완료 알림을 못 받았으니 카드를 바꿔 다시 누른다. 미확정일 때 주문은 `PAYMENT_IN_PROGRESS`에 머물고 전이표에 자기 자신으로 가는 길이 없어 **불법 전이로 막힌다** — 막는 자리가 멱등키가 아니라 상태머신이다(카드 A와 B는 새 멱등키를 받는다). 대가는 컸다. **고객은 배치가 돌 때까지 아무 수단으로도 결제를 못 하고**, 「허용되지 않은 상태 전이입니다」라는 문장만 받았다.

[Stripe의 PaymentIntent](https://docs.stripe.com/payments/payment-intents)는 **주문 하나에 의도 하나, 그 아래 시도 여럿**이라 멱등 범위도 주문 번호다. 그래서 **고객의 재시도를 미확정 해소 트리거로** 썼다 — 앞 결제가 승인됐으면 `409 ORDER_ALREADY_PAID`, 아직 모르면 `409 PAYMENT_RESULT_PENDING`, 승인 아님은 카드 B로 결제된다. 60초가 사라졌다. 남는 창(조회가 「없다」고 답한 결제가 PG에선 진행 중이던 경우)은 대사가 잡는다.

## 상황 2 — 승인은 났는데 재고가 없다: 롤백 대신 보상

### 1. 롤백은 DB만 되돌린다

대안 셋을 봤다 — ① `@Transactional` 롤백(롤백되는 건 DB뿐), ② 지금 한 번 망취소(망취소도 PG 호출이라 실패하면 되돌릴 방법이 사라짐), ③ 망취소를 적재하고 재시도(지시가 DB에 있어 서버가 죽어도 남음) → ③을 골랐다. 우리 DB와 PG는 한 트랜잭션으로 묶을 수 없으니 그런 순간은 보상으로 푼다.

### 2. 망취소를 적재하고 재시도한다

망취소도 PG 호출이라 실패할 수 있어서, 한 번 시도하고 끝내는 대신 durable하게 적재해두고 성공할 때까지 재시도한다(`compensation_tasks`, outbox의 사촌). **내부적·확실한 것과 외부적·불확실한 것을 나눠** 재고 원복·포인트 복원은 즉시, PG 망취소만 큐로 뺐다. 승인 + 차감 실패면 태스크를 적재하고 주문을 `FAILED`로 둔 채 커밋한다. 스케줄러가 `PENDING` 태스크로 망취소를 호출한다.

### 3. 진짜 함정: 잡은 예외가 트랜잭션을 오염시킨다

예외를 삼켰으니 커밋되겠지 했는데 최종 커밋에서 `UnexpectedRollbackException`이 터지고 보상 태스크 적재까지 롤백됐다.

> `deductConditional`은 `@Transactional` 메서드고, 바깥 트랜잭션에 **참여(join)**합니다. 이게 예외를 던지는 순간, Spring은 **공유 트랜잭션을 rollback-only로 표시**합니다. 바깥에서 그 예외를 잡아도 트랜잭션은 이미 "이건 무조건 롤백"으로 낙인이 찍힌 상태입니다.

해법은 예외를 아예 안 던지는 것이라 조건부 차감을 boolean으로 바꾼 `tryDeduct`를 만들었다.

```java
/** 예외 없는 조건부 차감 — 성공 true, 재고부족 false. */
@Transactional
public boolean tryDeduct(long productId, int qty) {
    return stockRepository.deductConditionally(productId, qty) > 0;
}
```

### 4. 재시도에 멱등과 상한을 건다

취소가 "성공한 결제가 없으면 `PAYMENT_NOT_FOUND`"를 던지는데, 이걸 실패로 처리하면 이미 취소된 걸 영원히 재시도한다 — 취소할 게 없다는 건 목적이 달성된 상태라 `task.markDone()`으로 완료 처리한다. 지수 백오프로 최대 5분 벌리되 `maxRetries`(5회)를 넘으면 `FAILED`로 두고 `compensation.exhausted`를 올린다. 스케줄러는 `app.compensation.enabled`로 기본은 꺼둔다.

## 멀티 PG 라우팅: 규칙을 정하고, 한참 뒤에 배선했다

국내 상위 PG사도 한 시간씩 장애가 난다. PG를 여럿 두고 하나가 죽으면 넘기되 **요청이 그 PG에 닿지도 못한 게 확실할 때만** 넘긴다 — 아무 때나 넘기면 이중결제다.

| PG 응답 | failover | 왜 |
|---|---|---|
| SUCCESS / FAILED(카드 거절) | 안 넘김 | 됐거나, 다른 PG로 가도 똑같이 거절(잔액 부족은 어디든 부족) |
| TIMEOUT(미확정) / 그 밖의 예외 | **절대 안 넘김** | 원 PG에서 이미 처리됐을 수 있다 — 넘기면 이중결제 |
| 요청 미도달(연결 실패·서킷 오픈) | 다음 PG로 넘김 | PG가 요청을 아예 못 받았다 |

가중치로 우선순위를 주고(`PgRoute.of("TOSS", tossAdapter, 10)`, `PgRoute.of("NICE", niceAdapter, 5)`), 모든 PG가 안 되면 `UNKNOWN`으로 돌려 복구 배치에 맡긴다. 시나리오 여섯을 테스트로 박았다 — 주 PG 성공(보조 호출 0), 장애→failover, 카드 거절·타임아웃→안 넘김, 모든 PG 장애→UNKNOWN, 서킷 오픈→건너뜀.

### 그런데 이 라우터가 테스트에서만 살아 있었다

전수 감사에서 이 라우터가 **어디에도 배선되지 않았고**, `grep`으로 세어보니 참조가 **자기 테스트뿐**이었다. 금고를 만들고 안 채우던 그 패턴이([4편: 실기동](/blog/project/pay/pay-ch2-runtime-truths)) PG에도 있었다. 배선은 있던 seam에 끼웠다 — `ResilientPgClient`가 감싸는 대상(`pgDelegate`) 자리에 라우터를 넣고 `@Primary`는 하나로 뒀다(둘이면 스프링이 못 정하고, 떼면 서킷을 잃는다).

```
APP_PG_ROUTING_ENABLED=true ./gradlew bootRun
→ PgRoutingConfig : 멀티 PG 라우팅 활성화 — 경로 2개 (가중치 순 시도, 장애 시 failover)
→ 결제 승인 → order PAID / payment DONE   (라우터의 primary 경로로 승인)
```

### 취소·조회는 원 PG로 되돌렸다

`PgClient.cancel(paymentKey, ...)`가 provider를 안 받아 취소·조회가 "가용한 첫 PG"로 나갔다. 후속 과제로 미뤘지만, Toss로 승인된 결제를 다른 PG에 조회하면 없다고 나오고 복구 배치가 살아 있는 결제를 실패로 확정한다 — **앞의 UNKNOWN 복구와 보상을 통째로 깨는 자리**였다. 그래서 `Payment.pgProvider`로 원 PG를 찾아 보낸다. provider가 있는데 경로에 없으면 안 보내고 예외를 던진다. provider를 모르는 옛 결제는 순회하되 조회는 `IN_PROGRESS`를 반환한다.

### 고르는 시점을 결제창 앞으로 옮겼다

기본은 꺼둔 채였고 적어둔 이유가 틀려 있었다. 진짜 막은 건 둘이다. 하나, `/confirm`이 `paymentKey`를 받는 시점은 고를 시점이 이미 지난 뒤라 서버에 고를 자리가 없었다. 둘, 결제창(PSP 토큰) 방식에서는 승인 단계 failover가 성립하지 않는다 — 승인 키가 그 PG의 결제창에서 인증을 마쳐야 발급되는 PSP 토큰이라 다른 PG엔 모르는 거래이고, **넘겨도 성공률이 0이다.**

찾아보니 고르는 시점을 앞으로 옮기는 게 표준이었다 — 포트원 스마트 라우팅은 채널 대신 `channelGroupId`를 받아 요청 시점에 비율로 PG를 고른다.

> 캐스케이딩(한 거래를 여러 PG에 차례로 재시도)은 기술적으로 가능하지만 **소비자 체크아웃에서는 거의 쓰이지 않습니다.** 책임과 네트워크 컴플라이언스 리스크가 승인률 이득보다 큽니다.

프론트가 결제창을 띄우기 전에 `POST /api/v1/payments/init`을 부르고, 서버는 차단기가 열린 PG를 빼고 남은 것 중 가중치 비례로 하나를 골라 돌려준다 — 아픈 PG로 고객을 **애초에 안 보내는** 장치다. 전부 아파도 하나는 골라 준다.

> "PG 장애 나면요?"에 "다른 PG로 넘겨요"는 절반의 답입니다. 나머지 절반이 **"단, 타임아웃과 카드 거절엔 안 넘긴다. 이중결제와 무의미한 재시도니까"**입니다. 이 구분이 빠지면 failover 자체가 이중결제 경로가 됩니다.

## 가상계좌: 완료가 최종 상태가 아니었다

가상계좌는 방향이 반대다 — 계좌를 발급하고 입금을 기다린다(`발급 → 입금대기 → 입금완료`). 기본은 웹훅으로 처리하고 "믿지 말고 조회로 재검증"한다. 토스 문서를 파고들면 함정 둘이 나온다.

> **EXPIRED 상태로 바뀔 때는 웹훅이 전송되지 않습니다.** (토스페이먼츠 문서에 명시돼 있습니다.)

이걸 모르고 웹훅만 기다리면 만료 건이 영원히 "입금대기"로 남아 재고나 쿠폰을 물고 있다. 그래서 **자체 만료 배치**가 `dueDate` 지난 `WAITING_FOR_DEPOSIT`을 스캔하되, 만료시키기 전에 PG에 조회해서 늦게 도착한 입금(APPROVED)이면 완료 처리한다. 만료 배치가 도는 그 순간 입금이 도착하는 레이스도 같다 — dueDate만 보고 만료시키면 방금 입금한 돈이 붕 뜬다.

```java
if (pgClient.query(va.getPaymentKey()).isApproved()) va.confirmDeposit(); // 늦은 입금 → 완료
else va.expire();
```

> "가상계좌 만료 어떻게 처리하세요?"에 대한 답이 이것입니다. "EXPIRED 웹훅이 없어서 배치로 감지하고, 만료 직전에 조회로 재확인해서 늦은 입금과의 레이스를 해소합니다."

> 일부 은행(신한 등)은 **입금 실패인데 DONE을 먼저 보낸 뒤, 최대 2분 후 되돌리는** 통보를 합니다.

보통 상태머신은 "완료는 최종"이라 가정하는데 가상계좌는 아니다. 그래서 `DONE → WAITING_FOR_DEPOSIT`·`DONE → CANCELED` **역전이를 허용 전이로** 넣고, 역전이가 오면 이미 보낸 후속 처리(알림·포인트 적립)를 보상으로 되돌린다.

## 웹훅이 승인 응답보다 먼저 오면

현업에 계신 분에게 질문을 하나 받았다.

> 동기 요청이 타임아웃으로 늘어지는데 웹훅(비동기)이 먼저 떨어지면? 이거 해결해보는 거는 좋은 부분이에요. **실무에서도 왕왕 있구요**

코드를 열어보니 늦게 온 웹훅은 막고 있었지만, 먼저 온 웹훅은 결제 행을 못 찾아 `PAYMENT_NOT_FOUND`로 떨어졌다. 수신이 **즉시 200을 돌려줘** PG 재전송이라는 두 번째 그물이 사라졌고, 남은 아웃박스 재시도는 `republish-outstanding-events-on-restart: true`라 앱을 재기동해야 돈다.

> 여기서 예외를 던지면 Modulith가 발행을 **미완료로 남겨 재시도**한다(at-least-once)

결제 행이 없는 건 아직 커밋되지 않았다는 뜻이라, `PENDING_PAYMENT`로 두고 `failReason`에 "결제 행 없음 — 웹훅이 승인 응답보다 먼저 도착"을 남긴다. `FAILED`면 "실패해서 다시"가 되지만 실제로는 "결제 행을 기다리는 중"이다. `PAYMENT_NOT_FOUND`만 보류로 바꾸고 다른 실패는 그대로 던진다. 스케줄러가 5초마다 다시 보고 상한 12회를 넘기면 `FAILED`로 넘긴다. 게이트 없이 만들었더니 테스트가 잡았다(`SchedulerGatePairingTest > 스케줄러는 모두 프로퍼티 게이트를 가진다 FAILED`).

### 실 MySQL로 재현했더니 버그가 셋 나왔다

목으로 `PAYMENT_NOT_FOUND`를 던지게 만들어 **경로만** 고정했는데, 실제 문제인 "결제 행이 아직 커밋되지 않아 다른 트랜잭션에서 안 보이는" 상태는 목으로 만들 수 없다. 실 MySQL에 붙여 넣었더니 셋이 나왔다.

1. `resolveByPaymentKey`가 `@Transactional`이라 [§3의 rollback-only 함정](#3-진짜-함정-잡은-예외가-트랜잭션을-오염시킨다)이 재현됐다. 기존 코드 주석이 정확히 경고하고 있었다 — 예외를 catch해 같은 트랜잭션에 FAILED를 쓰려 하면 그 트랜잭션이 이미 **rollback-only로 오염**돼 write마저 커밋되지 않는다. 예외를 받지 않고 먼저 물어보는 쪽으로 고쳤다.

2. `exists()`를 `@Transactional(readOnly = true)`로 뒀더니 상태가 여전히 `RECEIVED`였다. **readOnly로 바깥 트랜잭션에 합류하면 Hibernate FlushMode가 MANUAL이 되어** 이어지는 `save`가 flush되지 않고 사라진다 — [실기동 편](/blog/project/pay/pay-ch2-runtime-truths)의 `saveAndFlush` 함정과 같다.

3. `webhook_events.status`가 `VARCHAR`가 아니라 `ENUM('FAILED','PROCESSED','RECEIVED','SKIPPED')`라 새 값이 잘려 들어갔다. **H2는 이걸 문자열로 받아 통과시킨다.** 마이그레이션에 ENUM 값 목록을 더했다.

목은 트랜잭션 경계도, FlushMode도, 컬럼 타입도 흉내내지 못한다. 고친 뒤 로그는 `[task-1]` 보류(수신) → `[scheduling-1]` 보류(재시도 스케줄러)로 나온다.

토스에 실 PG로 쏴 보니 **웹훅이 한 건도 안 들어왔다**(헤더·멱등 키 사정) — 그 과정은 [15편](/blog/project/pay/pay-ch15-webhook-arrived-first)에 있다. 고친 뒤 입금처리 로그는 `08:29:15` 보류 `retry=1` → `retry=2` → `retry=3` → `08:30:19 소진 webhookEventId=3`(상한 12회)였고, 토스 전송 기록은 성공 2건·실패 0이었다.

## 남은 구멍

아직 실제 토스 대신 상태 기반 `FakePgClient`로 대부분을 테스트하고, 멀티 PG 라우팅은 기본값이 꺼져 있다. 조회가 「없다」고 답한 뒤 PG에서 진행 중이던 결제가 둘 다 승인되는 창은 대사로만 잡는다. 발신 IP 제한은 아직 안 걸었고, 보류 행이 쌓이는 것은 상한과 만료로만 관리한다.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있습니다. 보상 흐름은 14개의 단위 테스트로 검증했고, `app.pg.routing.enabled=true`로 라우터가 `pgDelegate`로 배선되어 결제가 라우팅 경로로 승인되는 것을 실기동으로 확인했습니다.*

## 참고

- 결제 트랜잭션의 예외 상황과 3상태 모델: [카카오페이 기술블로그](https://tech.kakaopay.com/post/msa-transaction/)
- 멱등 요청 가이드(같은 키에 다른 본문일 때의 처리 포함): [Stripe Idempotent requests](https://stripe.com/docs/api/idempotent_requests), [Adyen API idempotency](https://docs.adyen.com/development-resources/api-idempotency)
- 멱등키 보관 기간과 헤더 계약: [토스페이먼츠 개발자센터](https://docs.tosspayments.com/guides/using-api/idempotency-key)

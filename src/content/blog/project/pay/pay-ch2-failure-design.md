---
title: '결제 API는 타임아웃됐는데, 카드 승인은 이미 됐다면?'
description: '결제의 실패와 모름을 구분하고 조회·보상·웹훅으로 정합성을 복구한 과정. 타임아웃은 UNKNOWN으로 남겨 복구 배치가 확정한다. 승인 뒤 내부 실패는 보상으로 되돌리고, failover는 요청이 PG에 닿지 못한 경우로 한정한다.'
date: 2026-03-02
category: study/pay
coverImage: "/uploads/project/pay/thumbs/pay-failure.svg"
draft: false
unlisted: true
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

결제 승인 API를 호출했는데 응답이 오지 않았다. 서버가 보기에는 타임아웃이다. 이것만으로 결제가 실패했다고 말할 수 있을까?

```
우리 서버 ── 승인 요청 ──▶ PG
                          │
                     카드 승인 완료
                          │
우리 서버 ◀── 응답 ───────┘
                timeout
```

PG가 요청을 받아 카드를 승인했는데 그 응답만 네트워크에서 사라졌을 수 있다. 이때 타임아웃을 `FAILED`로 처리하면 PG에는 승인된 결제가 남고 우리 서버에는 실패한 결제가 남는다. 고객에게 다시 결제하라고 안내하면 두 번째 승인까지 성공해 이중 결제가 된다.

그래서 이 프로젝트는 결제 결과를 `SUCCESS`와 `FAILED` 둘로 나누지 않았다.

```
SUCCESS  승인됐음을 안다
FAILED   거절됐음을 안다
UNKNOWN  승인됐는지 아직 모른다
```

핵심은 모르는 상태를 성공이나 실패로 성급하게 확정하지 않는 것이다. `UNKNOWN`은 방치하지 않고 조회로 나중에 확정한다. 이 기준으로 다섯 가지를 다뤘다.

- 승인 응답이 사라졌을 때 최종 상태를 어떻게 확인할 것인가
- 결과를 모르는 동안 고객의 재결제를 어떻게 막을 것인가
- 승인 이후 내부 처리가 실패하면 어떻게 보상할 것인가
- 여러 PG가 있을 때 언제 다른 PG로 넘겨도 되는가
- 승인 응답보다 웹훅이 먼저 도착하면 어떻게 처리할 것인가

돌아보면 다섯은 같은 질문으로 모인다. **지금 이 결제에 대해 무엇이 확정됐고 무엇을 아직 모르는가.**

---

## 1. 응답이 없다고 결제가 실패한 것은 아니다

미확정으로 남기고 복구가 확정하게 했다([1편](/blog/project/pay/pay-ch1-what-to-trust)). [카카오페이의 3-상태 모델](https://tech.kakaopay.com/post/msa-transaction/)을 따라 명시적 거절만 `FAILED`로 두고 타임아웃은 `UNKNOWN`으로 남긴다.

```java
case SUCCESS -> payment.approve(...);
case FAILED  -> payment.abort(...);          // 명시적 거절만 실패
case TIMEOUT -> payment.markUnknown(reason); // 미확정 — 보존
```

여기서 갈리는 지점은 하나다. 응답이 없다는 사실은 "안 됐다"와 "모른다" 중 어느 쪽도 정해 주지 않는다. 그래서 미확정을 없애려 들지 않고 확정할 수단을 따로 만들었다.

```
승인 요청
   │
   ├─ 명시적 승인 ──────▶ DONE
   ├─ 명시적 거절 ──────▶ FAILED
   └─ timeout ─────────▶ UNKNOWN
                            │
                       PG 상태 조회
                       ╱          ╲
                  APPROVED      NOT_FOUND
                     │              │
                   DONE          ABORTED
```

## 2. UNKNOWN은 조회로 확정한다

복구 배치가 `UNKNOWN`을 60초마다 스캔해 PG에 상태를 묻는다. 반대 정책(무조건 망취소)도 `networkCancel`로 넣어 둘 다 허용 전이로 뒀다.

![타임아웃을 실패로 확정하지 않고 UNKNOWN으로 보존한 뒤 복구 배치가 60초마다 PG에 조회해 APPROVED면 전진 복구(DONE), NOT_FOUND면 ABORTED, CANCELED면 상태 동기화로 확정하는 흐름](/uploads/project/pay/diagrams/flow-unknown-recovery.svg)

```java
case APPROVED  -> payment.confirmByRecovery(pg.method());   // 전진 복구(DONE)
case NOT_FOUND -> payment.abortByRecovery("PG에 결제 없음");
case CANCELED  -> payment.confirmCanceledByRecovery();      // PG 취소 → 상태 동기화
```

### 순진한 해결: 승인을 한 번 더 보내면 되지 않나

가장 먼저 떠오르는 수정은 재시도다. 그런데 `UNKNOWN`에서 다시 승인을 보내면, 첫 요청이 이미 승인됐을 경우 두 번 승인된다. 그래서 여기서 할 일은 **이미 보낸 승인의 결과를 확인하는 것**이다. 재시도는 조회 하나뿐이다.

PG가 죽으면 모든 요청이 10초씩 걸려 스레드가 고갈된다. Resilience4j 차단기로 감싸고 `OPEN`이면 호출 없이 폴백한다. 승인은 "장애엔 재시도"가 통하지 않는 자리다. 어댑터가 `Idempotency-Key: orderNo`를 실어 보내도 코어는 그 보장에 기대지 않기 때문이다. 그래서 승인에는 재시도를 켜지 않고 실패·차단기 오픈을 `UNKNOWN`으로 돌린다.

```java
} catch (CallNotPermittedException open) {
    return PgApproveResult.timeout("서킷 오픈: PG 장애로 승인 미확정"); // 재시도 아님 — UNKNOWN
}
```

[카카오페이의 MSA 결제 트랜잭션 관리 글](https://tech.kakaopay.com/post/msa-transaction/)이 나열한 후처리 여섯 중에서 승인을 한 번 더 보내는 둘과 확인 없이 성공으로 넘기는 하나를 뺐다. 응답은 `200`·`400`·`202`로 나누고 재시도는 조회로만 건다. 이 기준은 뒤의 동시성 문제에서도 그대로 썼다([동시성 편](/blog/project/pay/pay-ch2-concurrency-and-load)).

`PaymentRecoveryScheduler`가 60초마다 미확정 건을 다시 묻고 10분을 넘기면 알림이 울려 사람이 닫는다. 10분은 방치 상한이고, 그 안에 확정되지 않으면 판단을 사람에게 넘긴다.

## 3. 결과를 모르는 동안 고객이 다시 결제하면

`UNKNOWN`일 때 주문은 `PAYMENT_IN_PROGRESS`에 머물고 전이표에 자기 자신으로 가는 길이 없어 **불법 전이로 막힌다**. 막는 자리는 상태머신이다. 방어선은 하나 더 있다.

### 같은 요청의 중복은 멱등키가 막는다

따닥(중복 클릭)은 서버에서 막았다. `(멱등키 + 경로 + 메서드)` 유니크라 동시에 온 두 요청 중 하나만 INSERT에 성공하고 나머지는 유니크 위반으로 튕긴다. 응답은 토스페이먼츠와 같은 시맨틱이다.

```java
try { record = repository.saveAndFlush(IdempotencyRecord.start(key, path, method, requestHash)); }
catch (DataIntegrityViolationException race) { return handleExisting(reload(key), requestHash, responseType); }
```

- 완료된 키는 첫 응답을 재반환한다
- 처리 중이면 `409`
- 같은 키에 본문이 다르면 `422`
- 키 자체가 잘못되면 `400`

### 다른 카드로 다시 누르면 상태머신이 막는다

멱등키가 막는 것은 "같은 요청의 중복"이고 카드 A와 B는 새 멱등키를 받는다. 그래서 다른 카드로 다시 누르는 일은 멱등키로 걸리지 않는다. **고객은 배치가 돌 때까지 아무 수단으로도 결제를 못 하고**, 「허용되지 않은 상태 전이입니다」라는 문장만 받았다. 이것도 답이 아니다.

[Stripe의 PaymentIntent](https://docs.stripe.com/payments/payment-intents)는 **주문 하나에 의도 하나, 그 아래 시도 여럿**이라 멱등 범위도 주문 번호다. 이 구조를 참고해 **고객의 재시도를 미확정 해소 트리거로** 썼다. 앞 결제가 승인됐으면 `409 ORDER_ALREADY_PAID`, 아직 모르면 `409 PAYMENT_RESULT_PENDING`, 승인이 아니면 카드 B로 결제된다.

> 멱등성과 결제 상태는 막는 대상이 다르다. 같은 요청의 중복은 멱등키가, 다른 수단으로 다시 하는 결제는 상태머신이 막는다.

## 4. 승인은 성공했는데 우리 처리가 실패하면

PG 승인은 성공했고 재고 차감이 실패했다. 처음 생각한 방법은 `@Transactional`로 묶고 예외가 나면 롤백하는 것이었다.

### 왜 그것으로 안 되는가

DB 롤백은 이미 발생한 PG 승인을 취소하지 못한다. 우리 DB와 PG는 한 트랜잭션으로 묶을 수 없다. 대안 셋을 놓고 봤다.

1. `@Transactional` 롤백: 롤백되는 것은 우리 DB뿐이다
2. 그 자리에서 한 번 망취소: 망취소도 PG 호출이라 실패하면 되돌릴 방법이 사라진다
3. 망취소를 적재하고 재시도: 지시가 DB에 있어 서버가 죽어도 남는다

### 선택: 망취소를 적재하고 재시도한다

세 번째를 골랐다(`compensation_tasks`, outbox의 사촌). 한 번 시도하고 끝내는 대신 durable하게 적재해 두고 성공할 때까지 재시도한다.

**내부적·확실한 것과 외부적·불확실한 것을 나눠** 재고 원복과 포인트 복원은 그 자리에서 처리하고 PG 망취소만 큐로 뺐다. 승인 후 차감이 실패하면 태스크를 적재하고 주문을 `FAILED`로 둔 채 커밋한다. 스케줄러가 `PENDING` 태스크를 집어 망취소를 호출한다.

### 재시도에 멱등과 상한을 건다

취소가 "성공한 결제가 없으면 `PAYMENT_NOT_FOUND`"를 던지는데, 이걸 실패로 처리하면 이미 취소된 건을 영원히 재시도한다. 취소할 것이 없다는 건 목적이 달성된 상태라 `task.markDone()`으로 완료 처리한다. 지수 백오프로 최대 5분까지 벌리되 `maxRetries`(5회)를 넘으면 `FAILED`로 두고 `compensation.exhausted` 지표를 올린다. 스케줄러는 `app.compensation.enabled`로 기본을 꺼 뒀다.

### 검증

취소 성공, 이미 취소됨, 반복 실패, 재시도 소진을 단위 테스트로 박았다. 보상 흐름에 붙은 테스트는 14개다.

### 4.1 구현하면서 밟은 함정: 예외를 삼켜도 트랜잭션은 오염된다

예외를 삼켰으니 커밋되겠지 했는데 최종 커밋에서 `UnexpectedRollbackException`이 터지고 보상 태스크 적재까지 롤백됐다.

> `deductConditional`은 `@Transactional` 메서드고 바깥 트랜잭션에 **참여(join)**합니다. 이게 예외를 던지는 순간, Spring은 **공유 트랜잭션을 rollback-only로 표시**합니다. 바깥에서 그 예외를 잡아도 트랜잭션은 이미 "이건 무조건 롤백"으로 낙인이 찍힌 상태입니다.

해법은 예외를 아예 안 던지는 것이라 조건부 차감을 boolean으로 바꾼 `tryDeduct`를 만들었다.

```java
/** 예외 없는 조건부 차감 — 성공 true, 재고부족 false. */
@Transactional
public boolean tryDeduct(long productId, int qty) {
    return stockRepository.deductConditionally(productId, qty) > 0;
}
```

## 5. 여러 PG가 있다면 타임아웃에 다른 PG로 넘겨도 될까?

국내 상위 PG사도 한 시간씩 장애가 난다. PG를 여럿 두고 하나가 죽으면 넘기되 **요청이 그 PG에 닿지도 못한 게 확실할 때만** 넘긴다.

![PaymentService → ResilientPgClient(@Primary) → RoutingPgClient(pgDelegate) → TOSS·NICE로 이어지는 계층과, 요청이 미도달일 때만 다음 PG로 넘기는 failover 분기](/uploads/project/pay/diagrams/flow-pg-routing.svg)

| PG 응답 | failover | 왜 |
|---|---|---|
| SUCCESS / FAILED(카드 거절) | 안 넘김 | 됐거나, 다른 PG로 가도 똑같이 거절(잔액 부족은 어디든 부족) |
| TIMEOUT(미확정) / 그 밖의 예외 | **절대 안 넘김** | 원 PG에서 이미 처리됐을 수 있다. 넘기면 이중결제다 |
| 요청 미도달(연결 실패·서킷 오픈) | 다음 PG로 넘김 | PG가 요청을 아예 못 받았다 |

기준은 하나로 정리된다. **요청이 그 PG에 닿을 수 있었는가.** 닿았을 수 있으면 넘기지 않는다. 표의 두 번째 줄이 이 글 전체에서 가장 비싼 줄이다.

가중치로 우선순위를 준다(`PgRoute.of("TOSS", tossAdapter, 10)`, `PgRoute.of("NICE", niceAdapter, 5)`). 모든 PG가 안 되면 `UNKNOWN`으로 돌려 복구 배치에 맡긴다. 시나리오 여섯을 테스트로 박았다. 주 PG 성공(보조 호출 0), 장애 시 failover, 카드 거절과 타임아웃은 안 넘김, 모든 PG 장애 시 `UNKNOWN`, 차단기 오픈 시 건너뜀이다.

### 그런데 이 라우터가 테스트에서만 살아 있었다

전수 감사에서 이 라우터가 **어디에도 배선되지 않았고**, `grep`으로 세어 보니 참조가 **자기 테스트뿐**이었다. 규칙을 세우고 검증까지 붙였는데 제품 경로에는 없었던 셈이다.

배선은 있던 seam에 끼웠다. `ResilientPgClient`가 감싸는 대상(`pgDelegate`) 자리에 라우터를 넣고 `@Primary`는 하나로 뒀다. 둘이면 스프링이 못 정한다. 떼면 차단기를 잃는다.

```
APP_PG_ROUTING_ENABLED=true ./gradlew bootRun
→ PgRoutingConfig : 멀티 PG 라우팅 활성화 — 경로 2개 (가중치 순 시도, 장애 시 failover)
→ 결제 승인 → order PAID / payment DONE   (라우터의 primary 경로로 승인)
```

### 취소·조회는 원 PG로 되돌렸다

`PgClient.cancel(paymentKey, ...)`가 provider를 안 받아 취소·조회가 "가용한 첫 PG"로 나갔다. Toss로 승인된 결제를 다른 PG에 조회하면 없다고 나온다. 복구 배치가 살아 있는 결제를 실패로 확정한다. **앞의 UNKNOWN 복구와 보상을 통째로 깨는 자리**였다.

그래서 `Payment.pgProvider`로 원 PG를 찾아 보낸다. provider가 있는데 경로에 없으면 보내지 않고 예외를 던진다. provider를 모르는 옛 결제는 순회하되 조회는 `IN_PROGRESS`를 반환한다.

### 고르는 시점을 결제창 앞으로 옮겼다

라우팅은 기본을 꺼둔 채였고 꺼둔 이유로 적어 둔 것이 틀려 있었다. 진짜로 막은 것은 둘이다.

첫째, `/confirm`이 `paymentKey`를 받는 시점은 고를 시점이 이미 지난 뒤라 서버에 고를 자리가 없었다. 둘째, 결제창(PSP 토큰) 방식에서는 승인 단계 failover가 성립하지 않는다. 승인 키가 그 PG의 결제창에서 인증을 마쳐야 발급되는 PSP 토큰이라 다른 PG에는 모르는 거래이고, 넘겨도 성공률이 0이다.

찾아보니 고르는 시점을 앞으로 옮기는 것이 표준이었다. 포트원 스마트 라우팅은 채널 대신 `channelGroupId`를 받아 요청 시점에 비율로 PG를 고른다.

> 캐스케이딩(한 거래를 여러 PG에 차례로 재시도)은 기술적으로 가능하지만 **소비자 체크아웃에서는 거의 쓰이지 않습니다.** 책임과 네트워크 컴플라이언스 리스크가 승인률 이득보다 큽니다.

프론트가 결제창을 띄우기 전에 `POST /api/v1/payments/init`을 부르고 서버는 차단기가 열린 PG를 빼고 남은 것 중 가중치 비례로 하나를 골라 돌려준다. 전부 아파도 하나는 골라 준다.

## 6. 웹훅이 승인 응답보다 먼저 도착하면

현업에 계신 분에게 질문을 하나 받았다.

> 동기 요청이 타임아웃으로 늘어지는데 웹훅(비동기)이 먼저 떨어지면? 이거 해결해보는 거는 좋은 부분이에요. **실무에서도 왕왕 있구요**

앞의 다섯 문제는 모두 "응답이 없다"에서 시작했는데, 이건 응답이 오기 전에 다른 경로로 결과가 먼저 도착하는 경우다.

```
Thread A                        Thread B
승인 요청
  │
PG 승인
  │
payment INSERT
  │                             webhook 도착
  │                                  │
  │                             payment 조회
  │                                  │
아직 commit 전                       └─ NOT FOUND
  │
commit
```

코드를 열어보니 늦게 온 웹훅은 막고 있었지만 먼저 온 웹훅은 결제 행을 못 찾아 `PAYMENT_NOT_FOUND`로 떨어졌다. 수신이 **즉시 200을 돌려줘** PG 재전송이라는 두 번째 그물이 사라졌고, 남은 아웃박스 재시도는 `republish-outstanding-events-on-restart: true`라 앱을 재기동해야 돈다.

> 여기서 예외를 던지면 Modulith가 발행을 **미완료로 남겨 재시도**한다(at-least-once)

결제 행이 없는 것은 아직 커밋되지 않았다는 뜻일 수 있다. 그래서 `PAYMENT_NOT_FOUND`를 `PENDING_PAYMENT`로 두고 `failReason`에 "결제 행 없음 — 웹훅이 승인 응답보다 먼저 도착"을 남긴다. `FAILED`로 두면 "실패했으니 다시"가 되지만 실제로는 "결제 행을 기다리는 중"이다. `PAYMENT_NOT_FOUND`만 보류로 바꾸고 다른 실패는 그대로 던진다. 스케줄러가 5초마다 다시 보고 상한 12회를 넘기면 `FAILED`로 넘긴다.

게이트 없이 만들었더니 테스트가 잡았다(`SchedulerGatePairingTest > 스케줄러는 모두 프로퍼티 게이트를 가진다 FAILED`).

### 6.1 Mock에서는 통과했는데 실 MySQL에서 깨진 셋

목으로 `PAYMENT_NOT_FOUND`를 던지게 만들어 **경로만** 고정했는데, "결제 행이 아직 커밋되지 않아 다른 트랜잭션에서 안 보이는" 상태는 목으로 만들 수 없다. 실 MySQL에 붙여 넣었더니 셋이 나왔다.

1. `resolveByPaymentKey`가 `@Transactional`이라 [4.1의 rollback-only 함정](#41-구현하면서-밟은-함정-예외를-삼켜도-트랜잭션은-오염된다)이 재현됐다. 기존 코드 주석이 정확히 경고하고 있었다. 예외를 catch해 같은 트랜잭션에 FAILED를 쓰려 하면 그 트랜잭션이 이미 **rollback-only로 오염**돼 write마저 커밋되지 않는다. 예외를 받지 않고 먼저 물어보는 쪽으로 고쳤다.

2. `exists()`를 `@Transactional(readOnly = true)`로 뒀더니 상태가 여전히 `RECEIVED`였다. **readOnly로 바깥 트랜잭션에 합류하면 Hibernate FlushMode가 MANUAL이 되어** 이어지는 `save`가 flush되지 않고 사라진다. [실기동 편](/blog/project/pay/pay-ch2-runtime-truths)의 `saveAndFlush` 함정과 같다.

3. `webhook_events.status`는 `ENUM('FAILED','PROCESSED','RECEIVED','SKIPPED')`이었다. 새 값이 잘려 들어갔다. **H2는 이걸 문자열로 받아 통과시킨다.** 마이그레이션에 ENUM 값 목록을 더했다.

고친 뒤 로그는 `[task-1]` 보류(수신) → `[scheduling-1]` 보류(재시도 스케줄러)로 나온다.

초기 기록에는 토스 실 PG에서 공개 주소로 웹훅을 받았다고 읽힐 수 있는 문장이 있었지만, 현재 저장소의 증거로 확인되는 것은 **토스 형식의 이벤트를 테스트 코드가 우리 서버에 보내는 시나리오**입니다. 따라서 실 PG가 실제로 재전송하는 시간·횟수까지 검증했다고 쓰지 않기로 했습니다. 현재 로그로 확인한 것은 `08:29:15` 보류 `retry=1` → `retry=2` → `retry=3` → `08:30:19 소진 webhookEventId=3` 흐름과, 상한 12회 뒤 사람이 볼 수 있게 남기는 동작입니다.

## 남은 구멍

아직 공개 주소로 실 PG 웹훅을 직접 수신하는 계약 테스트 대신 토스 형식 테스트 이벤트와 상태 기반 `FakePgClient`로 검증하고 있다. 멀티 PG 라우팅은 기본값이 꺼져 있다. 조회가 「없다」고 답한 뒤 PG에서 진행 중이던 결제가 둘 다 승인되는 창은 대사로만 잡는다. 토스 웹훅의 발신 IP 제한은 아직 설정하지 않았고, 보류 행이 쌓이는 것은 상한과 만료로 관리한다. 이 한계를 숨기지 않는 것이 현재 결과의 범위다.

## 마무리

처음에는 결제 실패를 제대로 처리하는 문제라고 생각했다. 만들면서 알게 된 것은 그 앞에 놓인 질문이었다. 무엇을 실패라고 말할 수 있는가.

타임아웃은 실패가 아니었다. `PAYMENT_NOT_FOUND`도 항상 실패가 아니었다. 웹훅이 늦은 것도 아니었다. 승인 응답보다 먼저 올 수 있었다. 다른 PG가 살아 있다고 해서 그쪽으로 다시 승인해도 되는 것도 아니었다.

기준은 하나로 남았다. **확정된 사실만 상태로 확정하고 모르는 것은 `UNKNOWN`으로 남긴다.** 그리고 `UNKNOWN`을 방치하는 대신 조회·재시도·대사로 나중에 확정한다.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있습니다. 보상 흐름은 14개의 단위 테스트로 검증했고 `app.pg.routing.enabled=true`로 라우터가 `pgDelegate`로 배선되어 결제가 라우팅 경로로 승인되는 것을 실기동으로 확인했습니다.*

## 참고

- 결제 트랜잭션의 예외 상황과 3상태 모델: [카카오페이 기술블로그](https://tech.kakaopay.com/post/msa-transaction/)
- 멱등 요청 가이드(같은 키에 다른 본문일 때의 처리 포함): [Stripe Idempotent requests](https://stripe.com/docs/api/idempotent_requests), [Adyen API idempotency](https://docs.adyen.com/development-resources/api-idempotency)
- 멱등키 보관 기간과 헤더 계약: [토스페이먼츠 개발자센터](https://docs.tosspayments.com/guides/using-api/idempotency-key)

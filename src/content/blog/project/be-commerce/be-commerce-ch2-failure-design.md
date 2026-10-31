---
coverImage: /uploads/covers/ai-generated/project/be-commerce/be-commerce-ch2-failure-design.png
title: '결제 타임아웃과 미확정 상태의 설계'
description: '결제 승인 응답이 없을 때 서버가 아는 것은 결과를 모른다는 사실뿐이다. 타임아웃을 UNKNOWN으로 보존해 복구 배치가 조회로 확정하고 승인 뒤 내부 실패는 보상 작업으로 되돌리며 다른 PG로 넘기는 failover는 요청이 PG에 닿지 못한 경우로 한정한 기준을 정리한다.'
date: 2026-03-02
category: study/be-commerce
topics:
  - payments
draft: false
series: "BE-commerce"
seriesOrder: 2
tags:
  - Payment
  - 실패 설계
  - 멱등성
  - 보상 트랜잭션
  - 결제 시스템
---

결제 승인 요청의 타임아웃은 결과를 모르는 상태입니다. 서버는 응답을 받지 못했다는 사실만 알고 PG가 그 요청을 받아 카드를 승인했는지는 모릅니다. 승인은 됐는데 응답만 네트워크에서 사라졌을 수 있기 때문입니다. 이 상태를 실패로 기록하면 PG에는 승인된 결제가 남고 우리 서버에는 실패한 결제가 남습니다. 고객에게 다시 결제하라고 안내하면 두 번째 승인까지 성공해 이중 결제가 됩니다.

```
우리 서버 ── 승인 요청 ──▶ PG
                          │
                     카드 승인 완료
                          │
우리 서버 ◀── 응답 ───────┘
                timeout
```

그래서 BE-commerce는 결제 결과를 `SUCCESS`와 `FAILED` 둘로 나누지 않고 모르는 상태를 하나 더 뒀습니다.

```
SUCCESS  승인됐음을 안다
FAILED   거절됐음을 안다
UNKNOWN  승인됐는지 아직 모른다
```

`UNKNOWN`은 성공이나 실패로 성급하게 확정하지 않고 조회로 나중에 확정하는 상태입니다. 이 글은 그 상태를 중심으로 다섯 가지 설계를 정리합니다.

- 승인 응답이 사라졌을 때 최종 상태를 어떻게 확인하는지
- 결과를 모르는 동안 고객의 재결제를 어떻게 막는지
- 승인 이후 내부 처리가 실패하면 어떻게 보상하는지
- 여러 PG가 있을 때 언제 다른 PG로 넘겨도 되는지
- 승인 응답보다 웹훅이 먼저 도착하면 어떻게 처리하는지

다섯은 같은 질문으로 모입니다. 지금 이 결제에서 무엇이 확정됐고 무엇을 아직 모르는지입니다.

## 결론부터

- 승인 응답이 없다는 이유만으로 `FAILED`를 기록하지 않고 `UNKNOWN`으로 보존합니다.
- `UNKNOWN`은 PG 상태 조회로 확정합니다. 그동안 중복 결제는 상태머신과 멱등키가 막습니다.
- PG 승인 뒤 내부 처리가 실패하면 보상 작업을 적재합니다. 로컬 트랜잭션 롤백은 PG 승인을 되돌리지 못합니다.
- 다른 PG로 넘기는 failover는 요청이 기존 PG에 도달하지 않았다는 사실이 확인된 경우로만 제한합니다.

이 글의 중심은 결과를 아는 경우와 모르는 경우를 상태로 분리하는 일입니다. 재시도 횟수는 그다음 문제입니다.

## 1. 응답이 없으면 결제는 실패일까?

실패로 확정할 수 없고 미확정으로 남겨 복구가 확정하게 했습니다. [카카오페이의 3-상태 모델](https://tech.kakaopay.com/post/msa-transaction/)을 따라 명시적 거절만 `FAILED`로 두고 타임아웃은 `UNKNOWN`으로 남깁니다.

```java
case SUCCESS -> payment.approve(...);
case FAILED  -> payment.abort(...);          // 명시적 거절만 실패
case TIMEOUT -> payment.markUnknown(reason); // 미확정 — 보존
```

여기서 갈리는 지점은 하나입니다. 응답이 없다는 사실은 "안 됐다"와 "모른다" 중 어느 쪽도 정해 주지 않습니다. 그래서 미확정을 없애려 들지 않고 확정할 수단을 따로 만들었습니다.

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

## 2. UNKNOWN은 무엇으로 확정할까?

PG 상태 조회로 확정합니다. 복구 배치가 `UNKNOWN`을 60초마다 스캔해 PG에 상태를 묻습니다. 반대 정책(무조건 망취소)도 `networkCancel`로 넣어 둘 다 허용 전이로 뒀습니다.

![타임아웃이 나면 UNKNOWN으로 보존하고 복구 배치가 60초마다 PG에 조회한다. PG에 승인돼 있으면 DONE, 결제가 없으면 ABORTED, 이미 취소됐으면 취소 상태로 맞춘다. 10분 안에 확정되지 않으면 알림이 울리고 사람이 닫는다](/uploads/project/be-commerce/diagrams/flow-unknown-recovery.svg)

```java
case APPROVED  -> payment.confirmByRecovery(pg.method());   // 전진 복구(DONE)
case NOT_FOUND -> payment.abortByRecovery("PG에 결제 없음");
case CANCELED  -> payment.confirmCanceledByRecovery();      // PG 취소 → 상태 동기화
```

### 승인을 한 번 더 보내면 왜 안 될까?

첫 요청이 이미 승인됐을 수 있기 때문입니다. `UNKNOWN`에서 다시 승인을 보내면 그 경우 두 번 승인됩니다. 그래서 여기서 할 일은 이미 보낸 승인의 결과를 확인하는 것이고 재시도는 조회 하나뿐입니다.

PG가 죽으면 모든 요청이 10초씩 걸려 스레드가 고갈됩니다. Resilience4j 차단기로 감싸고 `OPEN`이면 호출 없이 폴백합니다. 승인은 "장애엔 재시도"가 통하지 않는 자리입니다. 어댑터가 `Idempotency-Key: orderNo`를 실어 보내도 코어는 그 보장에 기대지 않기 때문입니다. 그래서 승인에는 재시도를 켜지 않고 실패와 차단기 오픈을 `UNKNOWN`으로 돌립니다.

```java
} catch (CallNotPermittedException open) {
    return PgApproveResult.timeout("서킷 오픈: PG 장애로 승인 미확정"); // 재시도 아님 — UNKNOWN
}
```

[카카오페이의 MSA 결제 트랜잭션 관리 글](https://tech.kakaopay.com/post/msa-transaction/)이 나열한 후처리 여섯 중에서 승인을 한 번 더 보내는 둘과 확인 없이 성공으로 넘기는 하나를 뺐습니다. 응답은 `200`·`400`·`202`로 나누고 재시도는 조회로만 겁니다. 이 기준은 뒤의 동시성 문제에서도 그대로 썼습니다.

`PaymentRecoveryScheduler`가 60초마다 미확정 건을 다시 묻고 10분을 넘기면 알림이 울려 사람이 닫습니다. 10분은 방치 상한이고 그 안에 확정되지 않으면 판단을 사람에게 넘깁니다.

## 3. 결과를 모르는 동안 재결제는 어떻게 막을까?

상태머신이 막습니다. `UNKNOWN`일 때 주문은 `PAYMENT_IN_PROGRESS`에 머물고 전이표에 자기 자신으로 가는 길이 없어 불법 전이로 걸립니다. 방어선은 하나 더 있습니다.

### 같은 요청의 중복은 무엇이 막을까?

멱등키가 막습니다. 따닥(중복 클릭)은 서버에서 막았습니다. `(멱등키 + 경로 + 메서드)` 유니크라 동시에 온 두 요청 중 하나만 INSERT에 성공하고 나머지는 유니크 위반으로 튕깁니다. 응답은 토스페이먼츠와 같은 시맨틱입니다.

```java
try { record = repository.saveAndFlush(IdempotencyRecord.start(key, path, method, requestHash)); }
catch (DataIntegrityViolationException race) { return handleExisting(reload(key), requestHash, responseType); }
```

- 완료된 키는 첫 응답을 재반환합니다
- 처리 중이면 `409`
- 같은 키에 본문이 다르면 `422`
- 키 자체가 잘못되면 `400`

### 다른 카드로 다시 누르면 무엇이 막을까?

상태머신이 막습니다. 멱등키가 막는 것은 같은 요청의 중복이고 카드 A와 B는 새 멱등키를 받습니다. 그래서 다른 카드로 다시 누르는 일은 멱등키로 걸리지 않습니다. 처음 구현에서 고객은 배치가 돌 때까지 아무 수단으로도 결제를 못 하고 「허용되지 않은 상태 전이입니다」라는 문장만 받았습니다. 이것도 답이 되지 못했습니다.

[Stripe의 PaymentIntent](https://docs.stripe.com/payments/payment-intents)는 주문 하나에 의도 하나, 그 아래 시도 여럿이라 멱등 범위도 주문 번호입니다. 이 구조를 참고해 고객의 재시도를 미확정 해소 트리거로 썼습니다. 앞 결제가 승인됐으면 `409 ORDER_ALREADY_PAID`, 아직 모르면 `409 PAYMENT_RESULT_PENDING`, 승인이 아니면 카드 B로 결제됩니다.

> 멱등성과 결제 상태는 막는 대상이 다릅니다. 같은 요청의 중복은 멱등키가, 다른 수단으로 다시 하는 결제는 상태머신이 막습니다.

## 4. 승인 뒤 내부 처리가 실패하면 어떻게 되돌릴까?

망취소를 적재하고 재시도합니다. PG 승인은 성공했고 재고 차감이 실패한 상황입니다. 처음 생각한 방법은 `@Transactional`로 묶고 예외가 나면 롤백하는 것이었습니다.

### 롤백으로는 왜 부족할까?

DB 롤백은 이미 발생한 PG 승인을 취소하지 못합니다. 우리 DB와 PG는 한 트랜잭션으로 묶을 수 없습니다. 대안 셋을 놓고 봤습니다.

1. `@Transactional` 롤백: 롤백되는 것은 우리 DB뿐입니다
2. 그 자리에서 한 번 망취소: 망취소도 PG 호출이라 실패하면 되돌릴 방법이 사라집니다
3. 망취소를 적재하고 재시도: 지시가 DB에 있어 서버가 죽어도 남습니다

### 망취소는 어떻게 적재할까?

세 번째를 골랐습니다(`compensation_tasks`, outbox의 사촌). 한 번 시도하고 끝내지 않고 durable하게 적재해 두고 성공할 때까지 재시도합니다.

내부적이고 확실한 것과 외부적이고 불확실한 것을 나눴습니다. 재고 원복과 포인트 복원은 그 자리에서 처리하고 PG 망취소만 큐로 뺐습니다. 승인 후 차감이 실패하면 태스크를 적재하고 주문을 `FAILED`로 둔 채 커밋합니다. 스케줄러가 `PENDING` 태스크를 집어 망취소를 호출합니다.

### 재시도의 상한은 어디에 둘까?

5회입니다. 취소가 "성공한 결제가 없으면 `PAYMENT_NOT_FOUND`"를 던지는데 이걸 실패로 처리하면 이미 취소된 건을 영원히 재시도합니다. 취소할 것이 없다는 건 목적이 달성된 상태라 `task.markDone()`으로 완료 처리합니다. 지수 백오프로 최대 5분까지 벌리되 `maxRetries`(5회)를 넘으면 `FAILED`로 두고 `compensation.exhausted` 지표를 올립니다. 스케줄러는 `app.compensation.enabled`로 기본을 꺼 뒀습니다.

취소 성공, 이미 취소됨, 반복 실패, 재시도 소진을 단위 테스트로 박았습니다. 보상 흐름에 붙은 테스트는 14개입니다.

### 4.1 예외를 삼켜도 트랜잭션은 왜 오염될까?

참여한 트랜잭션이 예외를 던지는 순간 rollback-only 표시가 붙기 때문입니다. 예외를 삼켰으니 커밋되겠지 했는데 최종 커밋에서 `UnexpectedRollbackException`이 터지고 보상 태스크 적재까지 롤백됐습니다.

> `deductConditional`은 `@Transactional` 메서드고 바깥 트랜잭션에 참여(join)합니다. 이게 예외를 던지는 순간 Spring은 공유 트랜잭션을 rollback-only로 표시합니다. 바깥에서 그 예외를 잡아도 트랜잭션은 이미 "이건 무조건 롤백"으로 낙인이 찍힌 상태입니다.

해법은 예외를 아예 안 던지는 것이라 조건부 차감을 boolean으로 바꾼 `tryDeduct`를 만들었습니다.

```java
/** 예외 없는 조건부 차감 — 성공 true, 재고부족 false. */
@Transactional
public boolean tryDeduct(long productId, int qty) {
    return stockRepository.deductConditionally(productId, qty) > 0;
}
```

## 5. 타임아웃에 다른 PG로 넘겨도 될까?

요청이 그 PG에 닿지도 못한 게 확실할 때만 넘깁니다. 국내 상위 PG사도 한 시간씩 장애가 나므로 PG를 여럿 두고 하나가 죽으면 넘기되 그 조건을 지킵니다.

![PG 응답을 셋으로 나눈 판정. 승인됐거나 카드가 거절됐으면 안 넘기고 응답이 없거나 예외가 났으면 승인됐을 수 있어 절대 안 넘기며 연결 실패나 차단기 열림처럼 요청이 닿지 않은 경우에만 다음 PG로 넘긴다](/uploads/project/be-commerce/diagrams/flow-pg-routing.svg)

| PG 응답 | failover | 왜 |
|---|---|---|
| SUCCESS / FAILED(카드 거절) | 안 넘김 | 됐거나, 다른 PG로 가도 똑같이 거절(잔액 부족은 어디든 부족) |
| TIMEOUT(미확정) / 그 밖의 예외 | 절대 안 넘김 | 원 PG에서 이미 처리됐을 수 있다. 넘기면 이중결제다 |
| 요청 미도달(연결 실패·서킷 오픈) | 다음 PG로 넘김 | PG가 요청을 아예 못 받았다 |

기준은 요청이 그 PG에 닿을 수 있었는지 하나입니다. 닿았을 수 있으면 넘기지 않습니다. 표의 두 번째 줄이 이 글 전체에서 가장 비싼 줄입니다.

가중치로 우선순위를 줍니다(`PgRoute.of("TOSS", tossAdapter, 10)`, `PgRoute.of("NICE", niceAdapter, 5)`). 모든 PG가 안 되면 `UNKNOWN`으로 돌려 복구 배치에 맡깁니다. 시나리오 여섯을 테스트로 박았습니다. 주 PG 성공(보조 호출 0), 장애 시 failover, 카드 거절과 타임아웃은 안 넘김, 모든 PG 장애 시 `UNKNOWN`, 차단기 오픈 시 건너뜀입니다.

### 라우터는 왜 테스트에서만 살아 있었을까?

어디에도 배선되지 않았기 때문입니다. 전수 감사에서 `grep`으로 세어 보니 참조가 자기 테스트뿐이었습니다. 규칙을 세우고 검증까지 붙였는데 제품 경로에는 없었던 셈입니다.

배선은 있던 seam에 끼웠습니다. `ResilientPgClient`가 감싸는 대상(`pgDelegate`) 자리에 라우터를 넣고 `@Primary`는 하나로 뒀습니다. 둘이면 스프링이 못 정하고 떼면 차단기를 잃습니다.

```
APP_PG_ROUTING_ENABLED=true ./gradlew -p commerce bootRun
→ PgRoutingConfig : 멀티 PG 라우팅 활성화 — 경로 2개 (가중치 순 시도, 장애 시 failover)
→ 결제 승인 → order PAID / payment DONE   (라우터의 primary 경로로 승인)
```

### 취소와 조회는 어느 PG로 보낼까?

승인한 원 PG로 보냅니다. 처음에는 `PgClient.cancel(paymentKey, ...)`가 provider를 안 받아 취소와 조회가 "가용한 첫 PG"로 나갔습니다. Toss로 승인된 결제를 다른 PG에 조회하면 없다고 나오고 복구 배치가 살아 있는 결제를 실패로 확정합니다. 앞의 UNKNOWN 복구와 보상을 통째로 깨는 자리였습니다.

그래서 `Payment.pgProvider`로 원 PG를 찾아 보냅니다. provider가 있는데 경로에 없으면 보내지 않고 예외를 던집니다. provider를 모르는 옛 결제는 순회하되 조회는 `IN_PROGRESS`를 반환합니다.

### PG는 언제 고를까?

결제창을 띄우기 전입니다. 라우팅은 기본을 꺼둔 채였고 꺼둔 이유로 적어 둔 것이 틀려 있었습니다. 진짜로 막은 것은 둘입니다.

첫째, `/confirm`이 `paymentKey`를 받는 시점은 고를 시점이 이미 지난 뒤라 서버에 고를 자리가 없었습니다. 둘째, 결제창(PSP 토큰) 방식에서는 승인 단계 failover가 성립하지 않습니다. 승인 키가 그 PG의 결제창에서 인증을 마쳐야 발급되는 PSP 토큰이라 다른 PG에는 모르는 거래이고 넘겨도 성공률이 0입니다.

찾아보니 고르는 시점을 앞으로 옮기는 것이 표준이었습니다. 포트원 스마트 라우팅은 채널 대신 `channelGroupId`를 받아 요청 시점에 비율로 PG를 고릅니다.

> 캐스케이딩(한 거래를 여러 PG에 차례로 재시도)은 기술적으로 가능하지만 소비자 체크아웃에서는 거의 쓰이지 않습니다. 책임과 네트워크 컴플라이언스 리스크가 승인률 이득보다 큽니다.

프론트가 결제창을 띄우기 전에 `POST /api/v1/payments/init`을 부르고 서버는 차단기가 열린 PG를 빼고 남은 것 중 가중치 비례로 하나를 골라 돌려줍니다. 전부 아파도 하나는 골라 줍니다.

## 6. 웹훅이 승인 응답보다 먼저 오면 어떻게 될까?

결제 행이 아직 없어 보류로 두고 다시 봅니다. 현업에 계신 분에게 질문을 하나 받았습니다.

> 동기 요청이 타임아웃으로 늘어지는데 웹훅(비동기)이 먼저 떨어지면? 이거 해결해보는 거는 좋은 부분이에요. 실무에서도 왕왕 있구요

앞의 다섯 문제는 모두 "응답이 없다"에서 시작했는데 이건 응답이 오기 전에 다른 경로로 결과가 먼저 도착하는 경우입니다.

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

코드를 열어보니 늦게 온 웹훅은 막고 있었지만 먼저 온 웹훅은 결제 행을 못 찾아 `PAYMENT_NOT_FOUND`로 떨어졌습니다. 수신이 즉시 200을 돌려줘 PG 재전송이라는 두 번째 그물이 사라졌고 남은 아웃박스 재시도는 `republish-outstanding-events-on-restart: true`라 앱을 재기동해야 돕니다.

> 여기서 예외를 던지면 Modulith가 발행을 미완료로 남겨 재시도합니다(at-least-once)

결제 행이 없는 것은 아직 커밋되지 않았다는 뜻일 수 있습니다. 그래서 `PAYMENT_NOT_FOUND`를 `PENDING_PAYMENT`로 두고 `failReason`에 `결제 행 없음 — 웹훅이 승인 응답보다 먼저 도착`을 남깁니다. `FAILED`로 두면 "실패했으니 다시"가 되지만 실제로는 "결제 행을 기다리는 중"입니다. `PAYMENT_NOT_FOUND`만 보류로 바꾸고 다른 실패는 그대로 던집니다. 스케줄러가 5초마다 다시 보고 상한 12회를 넘기면 `FAILED`로 넘깁니다.

게이트 없이 만들었더니 테스트가 잡았습니다(`SchedulerGatePairingTest > 스케줄러는 모두 프로퍼티 게이트를 가진다 FAILED`).

### 6.1 Mock에서 통과한 것이 실 MySQL에서 왜 깨졌을까?

목으로는 커밋 전 상태를 만들 수 없기 때문입니다. 목으로 `PAYMENT_NOT_FOUND`를 던지게 만들어 경로만 고정했는데 "결제 행이 아직 커밋되지 않아 다른 트랜잭션에서 안 보이는" 상태는 목으로 만들 수 없습니다. 실 MySQL에 붙여 넣었더니 셋이 나왔습니다.

1. `resolveByPaymentKey`가 `@Transactional`이라 [4.1의 rollback-only 함정](#41-예외를-삼켜도-트랜잭션은-왜-오염될까)이 재현됐습니다. 기존 코드 주석이 정확히 경고하고 있었습니다. 예외를 catch해 같은 트랜잭션에 FAILED를 쓰려 하면 그 트랜잭션이 이미 rollback-only로 오염돼 write마저 커밋되지 않습니다. 예외를 받지 않고 먼저 물어보는 쪽으로 고쳤습니다.

2. `exists()`를 `@Transactional(readOnly = true)`로 뒀더니 상태가 여전히 `RECEIVED`였습니다. readOnly로 바깥 트랜잭션에 합류하면 Hibernate FlushMode가 MANUAL이 되어 이어지는 `save`가 flush되지 않고 사라집니다. 실기동 점검에서 겪은 `saveAndFlush` 함정과 같습니다.

3. `webhook_events.status`는 `ENUM('FAILED','PROCESSED','RECEIVED','SKIPPED')`이었습니다. 새 값이 잘려 들어갔습니다. H2는 이걸 문자열로 받아 통과시킵니다. 마이그레이션에 ENUM 값 목록을 더했습니다.

고친 뒤 로그는 `[task-1]` 보류(수신) → `[scheduling-1]` 보류(재시도 스케줄러)로 나옵니다.

초기 기록에는 토스 실 PG에서 공개 주소로 웹훅을 받았다고 읽힐 수 있는 문장이 있었지만 현재 저장소의 증거로 확인되는 것은 토스 형식의 이벤트를 테스트 코드가 우리 서버에 보내는 시나리오입니다. 따라서 실 PG가 실제로 재전송하는 시간과 횟수까지 검증했다고 쓰지 않기로 했습니다. 현재 로그로 확인한 것은 `08:29:15` 보류 `retry=1` → `retry=2` → `retry=3` → `08:30:19 소진 webhookEventId=3` 흐름과 상한 12회 뒤 사람이 볼 수 있게 남기는 동작입니다.

## 한계와 후속 작업

공개 주소로 실 PG 웹훅을 직접 수신하는 계약 테스트는 아직 없고 토스 형식 테스트 이벤트와 상태 기반 `FakePgClient`로 검증하고 있습니다. 멀티 PG 라우팅은 기본값이 꺼져 있습니다. 조회가 「없다」고 답한 뒤 PG에서 진행 중이던 결제가 둘 다 승인되는 창은 대사로만 잡습니다. 토스 웹훅의 발신 IP 제한은 아직 설정하지 않았고 보류 행이 쌓이는 것은 상한과 만료로 관리합니다. 이 한계가 현재 결과의 범위입니다.

## 정리

처음에는 결제 실패를 제대로 처리하는 문제라고 생각했습니다. 만들면서 알게 된 것은 그 앞에 놓인 질문이었습니다. 무엇을 실패라고 말할 수 있는지입니다.

타임아웃은 미확정 상태였습니다. `PAYMENT_NOT_FOUND`는 결제 행을 기다리는 중일 수 있었습니다. 웹훅은 승인 응답보다 먼저 올 수 있었습니다. 다른 PG가 살아 있어도 그쪽으로 다시 승인하면 이중 결제가 될 수 있었습니다.

기준은 하나로 남았습니다. 확정된 사실만 상태로 확정하고 모르는 것은 `UNKNOWN`으로 남깁니다. 그 `UNKNOWN`은 조회와 재시도, 대사가 나중에 확정합니다.

전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/BE-commerce)에 있습니다. 보상 흐름은 14개의 단위 테스트로 검증했고 `app.pg.routing.enabled=true`로 라우터가 `pgDelegate`로 배선되어 결제가 라우팅 경로로 승인되는 것을 실기동으로 확인했습니다.

## 참고

- 결제 트랜잭션의 예외 상황과 3상태 모델: [카카오페이 기술블로그](https://tech.kakaopay.com/post/msa-transaction/)
- 멱등 요청 가이드(같은 키에 다른 본문일 때의 처리 포함): [Stripe Idempotent requests](https://stripe.com/docs/api/idempotent_requests), [Adyen API idempotency](https://docs.adyen.com/development-resources/api-idempotency)
- 멱등키 보관 기간과 헤더 계약: [토스페이먼츠 개발자센터](https://docs.tosspayments.com/guides/using-api/idempotency-key)

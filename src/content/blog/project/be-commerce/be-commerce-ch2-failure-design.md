---
coverImage: /uploads/covers/ai-generated/project/be-commerce/be-commerce-ch2-failure-design.png
title: '결제 타임아웃과 미확정 상태의 설계'
description: '결제 승인 응답이 없을 때 서버가 아는 것은 결과를 모른다는 사실뿐이다. 타임아웃을 UNKNOWN으로 보존해 복구 배치가 조회로 확정하고, 그동안의 재결제는 멱등키와 상태머신이 막으며, 승인 뒤 내부 실패는 보상 작업을 적재해 되돌리는 설계를 정리한다.'
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

그래서 BE-commerce는 결제 결과를 `SUCCESS`와 `FAILED` 둘로 나누지 않고 모르는 상태를 하나 더 뒀습니다.

```
SUCCESS  승인됐음을 안다
FAILED   거절됐음을 안다
UNKNOWN  승인됐는지 아직 모른다
```

`UNKNOWN`은 성공이나 실패로 성급하게 확정하지 않고 조회로 나중에 확정하는 상태입니다. 이 글은 그 상태를 어떻게 확정하는지, 확정되기 전의 재결제를 무엇으로 막는지, 승인 뒤 내부 처리가 실패하면 무엇으로 되돌리는지를 정리합니다. 셋은 같은 질문으로 모입니다. 지금 이 결제에서 무엇이 확정됐고 무엇을 아직 모르는지입니다.

## 결론부터

- 승인 응답이 없다는 이유만으로 `FAILED`를 기록하지 않고 `UNKNOWN`으로 보존합니다.
- `UNKNOWN`은 PG 상태 조회로 확정합니다. 그동안 같은 요청의 중복은 멱등키가, 다른 수단으로 다시 하는 결제는 상태머신이 막습니다.
- PG 승인 뒤 내부 처리가 실패하면 보상 작업을 적재합니다. 로컬 트랜잭션 롤백은 PG 승인을 되돌리지 못합니다.

## 1. 응답이 없으면 결제는 실패일까?

실패로 확정할 수 없고 미확정으로 남겨 복구가 확정하게 했습니다. [카카오페이의 3-상태 모델](https://tech.kakaopay.com/post/msa-transaction/)을 따라 명시적 거절만 `FAILED`로 두고 타임아웃은 `UNKNOWN`으로 남깁니다.

```java
case SUCCESS -> payment.approve(...);
case FAILED  -> payment.abort(...);          // 명시적 거절만 실패
case TIMEOUT -> payment.markUnknown(reason); // 미확정 — 보존
```

응답이 없다는 사실은 "안 됐다"와 "모른다" 중 어느 쪽도 정해 주지 않습니다. 그래서 미확정을 없애려 들지 않고 확정할 수단을 따로 만들었습니다.

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

PG 상태 조회로 확정합니다. 복구 배치가 `UNKNOWN`을 60초마다 스캔해 PG에 상태를 묻고 10분을 넘기면 알림이 울려 사람이 닫습니다. 반대 정책(무조건 망취소)도 `networkCancel`로 넣어 둘 다 허용 전이로 뒀습니다.

![타임아웃이 나면 UNKNOWN으로 보존하고 복구 배치가 60초마다 PG에 조회한다. PG에 승인돼 있으면 DONE, 결제가 없으면 ABORTED, 이미 취소됐으면 취소 상태로 맞춘다. 10분 안에 확정되지 않으면 알림이 울리고 사람이 닫는다](/uploads/project/be-commerce/diagrams/flow-unknown-recovery.svg)

```java
case APPROVED  -> payment.confirmByRecovery(pg.method());   // 전진 복구(DONE)
case NOT_FOUND -> payment.abortByRecovery("PG에 결제 없음");
case CANCELED  -> payment.confirmCanceledByRecovery();      // PG 취소 → 상태 동기화
```

### 승인을 한 번 더 보내면 왜 안 될까?

첫 요청이 이미 승인됐을 수 있기 때문입니다. `UNKNOWN`에서 다시 승인을 보내면 그 경우 두 번 승인됩니다. 그래서 여기서 할 일은 이미 보낸 승인의 결과를 확인하는 것이고 재시도는 조회 하나뿐입니다. [카카오페이 글](https://tech.kakaopay.com/post/msa-transaction/)이 나열한 후처리 여섯 가운데 승인을 한 번 더 보내는 둘과 확인 없이 성공으로 넘기는 하나를 뺀 것입니다.

PG가 죽으면 모든 요청이 10초씩 걸려 스레드가 고갈되므로 Resilience4j 차단기로 감싸고 `OPEN`이면 호출 없이 폴백합니다. 승인은 "장애엔 재시도"가 통하지 않는 자리입니다. 어댑터가 `Idempotency-Key: orderNo`를 실어 보내도 코어는 그 보장에 기대지 않습니다. 그래서 승인에는 재시도를 켜지 않고 실패와 차단기 오픈을 `UNKNOWN`으로 돌립니다.

```java
} catch (CallNotPermittedException open) {
    return PgApproveResult.timeout("서킷 오픈: PG 장애로 승인 미확정"); // 재시도 아님 — UNKNOWN
}
```

## 3. 결과를 모르는 동안 재결제는 어떻게 막을까?

같은 요청의 중복은 멱등키가 막고 다른 수단으로 다시 하는 결제는 상태머신이 막습니다. 둘은 막는 대상이 다릅니다.

### 같은 요청의 중복은 무엇이 막을까?

멱등키입니다. 따닥(중복 클릭)은 `(멱등키 + 경로 + 메서드)` 유니크로 동시에 온 두 요청 중 하나만 INSERT에 성공하고 나머지는 유니크 위반으로 튕깁니다. 응답은 토스페이먼츠와 같은 시맨틱입니다.

```java
try { record = repository.saveAndFlush(IdempotencyRecord.start(key, path, method, requestHash)); }
catch (DataIntegrityViolationException race) { return handleExisting(reload(key), requestHash, responseType); }
```

- 완료된 키는 첫 응답을 재반환합니다
- 처리 중이면 `409`
- 같은 키에 본문이 다르면 `422`
- 키 자체가 잘못되면 `400`

### 다른 카드로 다시 누르면 무엇이 막을까?

상태머신입니다. 카드 A와 B는 새 멱등키를 받으므로 다른 카드로 다시 누르는 일은 멱등키로 걸리지 않습니다. `UNKNOWN`일 때 주문은 `PAYMENT_IN_PROGRESS`에 머물고 전이표에 자기 자신으로 가는 길이 없어 불법 전이로 걸립니다. 다만 배치가 돌 때까지 고객이 아무 수단으로도 결제를 못 하고 「허용되지 않은 상태 전이입니다」만 받는 것은 답이 못 됩니다.

[Stripe의 PaymentIntent](https://docs.stripe.com/payments/payment-intents)는 주문 하나에 의도 하나, 그 아래 시도 여럿이라 멱등 범위도 주문 번호입니다. 이 구조를 참고해 고객의 재시도를 미확정 해소 트리거로 썼습니다. 앞 결제가 승인됐으면 `409 ORDER_ALREADY_PAID`, 아직 모르면 `409 PAYMENT_RESULT_PENDING`, 승인이 아니면 카드 B로 결제됩니다.

## 4. 승인 뒤 내부 처리가 실패하면 어떻게 되돌릴까?

망취소를 적재하고 재시도합니다. PG 승인은 성공했고 재고 차감이 실패한 상황입니다.

### 롤백으로는 왜 부족할까?

DB 롤백은 이미 발생한 PG 승인을 취소하지 못합니다. 우리 DB와 PG는 한 트랜잭션으로 묶을 수 없습니다. 대안 셋을 놓고 봤습니다.

1. `@Transactional` 롤백: 롤백되는 것은 우리 DB뿐입니다
2. 그 자리에서 한 번 망취소: 망취소도 PG 호출이라 실패하면 되돌릴 방법이 사라집니다
3. 망취소를 적재하고 재시도: 지시가 DB에 있어 서버가 죽어도 남습니다

### 망취소는 어떻게 적재할까?

세 번째를 골랐습니다(`compensation_tasks`, outbox의 사촌). 내부적이고 확실한 것과 외부적이고 불확실한 것을 나눠 재고 원복과 포인트 복원은 그 자리에서 처리하고 PG 망취소만 큐로 뺐습니다. 승인 후 차감이 실패하면 태스크를 적재하고 주문을 `FAILED`로 둔 채 커밋합니다. 스케줄러가 `PENDING` 태스크를 집어 망취소를 호출하고 성공할 때까지 재시도합니다.

### 재시도의 상한은 어디에 둘까?

5회입니다. 지수 백오프로 최대 5분까지 벌리되 `maxRetries`를 넘으면 `FAILED`로 두고 `compensation.exhausted` 지표를 올립니다. 취소가 "성공한 결제가 없으면 `PAYMENT_NOT_FOUND`"를 던지는데 이것을 실패로 처리하면 이미 취소된 건을 영원히 재시도합니다. 취소할 것이 없다는 건 목적이 달성된 상태라 `task.markDone()`으로 완료 처리합니다.

### 4-1. 예외를 삼켜도 트랜잭션은 왜 오염될까?

참여한 트랜잭션이 예외를 던지는 순간 rollback-only 표시가 붙기 때문입니다. `deductConditional`은 `@Transactional` 메서드라 바깥 트랜잭션에 참여하는데 여기서 예외가 나면 Spring이 공유 트랜잭션을 rollback-only로 표시합니다. 바깥에서 그 예외를 잡아도 최종 커밋에서 `UnexpectedRollbackException`이 터지고 보상 태스크 적재까지 롤백됩니다. 그래서 예외를 아예 던지지 않는 boolean 조건부 차감 `tryDeduct`로 바꿨습니다.

```java
/** 예외 없는 조건부 차감 — 성공 true, 재고부족 false. */
@Transactional
public boolean tryDeduct(long productId, int qty) {
    return stockRepository.deductConditionally(productId, qty) > 0;
}
```

## 5. 미확정은 어디까지 번질까?

다른 PG로 넘기는 판단과 웹훅 수신까지 번집니다. 타임아웃이 났다고 다른 PG로 다시 승인하면 원 PG에서 이미 처리됐을 수 있어 이중 결제가 되므로 failover는 요청이 원 PG에 닿지 못한 것이 확실한 경우로만 제한합니다. 그 조건과 PG를 고르는 시점은 [PG failover의 허용 조건](/blog/project/be-commerce/be-commerce-ch67-pg-failover-conditions)에 있습니다. 승인 응답보다 웹훅이 먼저 도착하면 결제 행이 아직 없는데 그것을 실패로 두지 않고 보류했다가 다시 보는 구조는 [먼저 도착한 웹훅의 보류와 재처리](/blog/project/be-commerce/be-commerce-ch15-webhook-arrived-first)에 있습니다.

## 한계와 후속 작업

조회가 「없다」고 답한 뒤 PG에서 진행 중이던 결제가 둘 다 승인되는 창은 대사로만 잡습니다. 복구와 보상은 상태 기반 `FakePgClient`로 검증했고 실 PG의 재전송 시간과 횟수는 재지 않았습니다.

## 정리

결제 실패를 제대로 처리하는 문제 앞에는 무엇을 실패라고 말할 수 있는지라는 질문이 놓여 있었습니다. 타임아웃은 미확정 상태였고 다른 PG가 살아 있어도 그쪽으로 다시 승인하면 이중 결제가 될 수 있었습니다. 기준은 하나로 남았습니다. 확정된 사실만 상태로 확정하고 모르는 것은 `UNKNOWN`으로 남깁니다. 그 `UNKNOWN`은 조회와 재시도, 대사가 나중에 확정합니다.

## 참고

- 전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/BE-commerce)에 있습니다.
- 결제 트랜잭션의 예외 상황과 3상태 모델: [카카오페이 기술블로그](https://tech.kakaopay.com/post/msa-transaction/)
- 멱등 요청 가이드(같은 키에 다른 본문일 때의 처리 포함): [Stripe Idempotent requests](https://stripe.com/docs/api/idempotent_requests), [Adyen API idempotency](https://docs.adyen.com/development-resources/api-idempotency)
- 멱등키 보관 기간과 헤더 계약: [토스페이먼츠 개발자센터](https://docs.tosspayments.com/guides/using-api/idempotency-key)

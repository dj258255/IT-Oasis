---
title: '10초 안에 200을 못 주면 PG가 다시 보낸다 — 웹훅을 비동기로 떼며 만난 트랜잭션 함정 둘'
titleEn: 'Return 200 Within 10s or the PG Resends — Two Transaction Traps While Making Webhooks Async'
description: 결제 시스템 개선기. PG는 웹훅에 10초 내 2xx를 요구하고 못 주면 재전송한다. 그런데 웹훅 처리가 응답 경로에서 PG 조회 API를 동기로 부르고 있었다 — 그 네트워크 왕복이 10초를 넘길 위험. 아웃박스 이벤트로 해석을 떼어냈는데, 코드로는 안 보이고 실기동에서만 드러난 함정 둘을 만났다. 자기호출이 트랜잭션을 우회해 AFTER_COMMIT이 안 걸렸고, 실패를 catch해 FAILED를 쓰려다 오염된 트랜잭션에 막혔다.
descriptionEn: "Payment system improvement log. A PG demands a 2xx within 10 seconds or it resends the webhook. But webhook handling called the PG query API synchronously in the response path — that round trip risks blowing past 10s. I split the interpretation off onto an outbox event, and hit two traps invisible in the code, visible only at runtime: self-invocation bypassed the transaction so AFTER_COMMIT never fired, and catching the failure to write FAILED hit a poisoned transaction."
date: 2027-02-13T00:00:00.000Z
tags:
  - Payment
  - Webhook
  - Async
  - Transaction
  - Spring Modulith
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 47
---

*결제 시스템 시리즈. 개선기 — 웹훅을 빠른 응답과 비동기 해석으로 나누다.*

## 0. 10초 규약

PG 웹훅엔 시간 규약이 있어요 — **10초 안에 2xx**를 못 주면 PG가 "못 받았나 보다" 하고 **재전송**해요(토스는 최대 7회, 며칠에 걸쳐). 그래서 웹훅 응답은 빨라야 해요.

그런데 [웹훅 처리 코드](/blog/project/pay/pay-3-webhooks-and-outbox)를 보니 이랬어요.

```java
public void handle(...) {
    WebhookEvent event = receive(...);   // 서명검증 + 멱등저장 (빠름)
    process(event);                       // ← PG 조회 API를 동기 호출 (느릴 수 있음)
}
```

`process`는 [페이로드를 믿지 않고 PG 조회 API로 실제 상태를 재검증](/blog/project/pay/pay-2-designing-for-failure)해요. 문제는 그 **PG 조회 네트워크 왕복이 응답 경로에 얹혀 있다**는 거예요.

> PG가 느리거나 일시 장애면 이 조회가 몇 초씩 걸려요. 그럼 웹훅 응답이 10초를 넘고, PG는 재전송을 시작하죠. 재전송이 또 조회를 유발하고 — 느릴 때 더 부하가 쌓이는 악순환이에요. 수신 확인과 실제 해석은 시간 특성이 완전히 다른데 한 스레드에 묶여 있던 거예요.

다행히 예전의 제가 `receive`와 `process`를 이미 나눠뒀고, javadoc에 "나중에 process만 비동기로 떼어낸다"고 적어놨어요. 이번에 실제로 뗐어요. 그런데 "이벤트로 떼면 되겠지"가 — 두 번 막혔어요.

## 1. 왜 @Async 대신 아웃박스인가

단순하게 `process`에 `@Async`를 붙일 수도 있어요. 근데 [이 시스템은 신뢰성을 아웃박스로 보장](/blog/project/pay/pay-3-webhooks-and-outbox)해요. `@Async`는 인메모리 스레드풀이라 —

> 200을 응답한 뒤, `@Async` 작업이 실행되기 전에 앱이 죽으면(배포·크래시) 그 **해석 작업이 통째로 사라져요.** PG는 200을 받았으니 재전송도 안 하고요. 웹훅은 받았는데 해석은 안 된 채 유실되는 거죠.

그래서 `@Async` 대신 **Modulith 이벤트**로 뗐어요. `receive`가 신규 이벤트에 `WebhookReceivedEvent`를 발행하면, [Event Publication Registry(아웃박스)](/blog/project/pay/pay-3-webhooks-and-outbox)에 수신과 함께 기록되고, 커밋 후 `@ApplicationModuleListener`가 별도 스레드에서 해석해요. 앱이 죽어도 재기동 때 재발행돼요 — 유실이 없죠.

```java
@Transactional
public WebhookEvent receive(...) {
    ...
    WebhookEvent saved = repository.save(...);
    events.publishEvent(new WebhookReceivedEvent(saved.getId()));  // 아웃박스에 함께 커밋
    return saved;
}

@ApplicationModuleListener            // 커밋 후 별도 스레드에서 해석
void onWebhookReceived(WebhookReceivedEvent e) {
    repository.findById(e.webhookEventId()).ifPresent(this::process);
}
```

## 2. 함정 하나 — 자기호출이 트랜잭션을 삼켰다

코드는 완벽해 보였어요. 테스트도 통과했고요. 그런데 **실기동해서** 웹훅을 쏴보니 —

```
웹훅 POST → 200 (0.02초, 빠름 ✓)
직후 DB: RECEIVED
3초 후 DB: 여전히 RECEIVED (?!)
event_publication: WebhookReceivedEvent, 완료 안 됨
```

해석이 **아예 실행되지 않았어요.** 발행은 아웃박스에 기록됐는데, 리스너가 안 불린 거예요. 다른 이벤트(`PaymentConfirmedEvent` 3444건)는 다 완료되는데 이것만.

차이는 하나였어요 — **자기호출(self-invocation).**

> `@ApplicationModuleListener`는 `AFTER_COMMIT`이라, 발행이 **커밋되는 트랜잭션 안**에서 일어나야 걸려요. 그런데 컨트롤러가 부른 `handle()`이 `this.receive()`를 부르는데, 이건 **프록시를 거치지 않아** `receive()`의 `@Transactional`이 **무시돼요.** 그래서 발행이 트랜잭션 밖에서 일어났고 — 커밋할 트랜잭션이 없으니 `AFTER_COMMIT`이 영원히 안 걸린 거예요. (저장은 Spring Data가 자체 커밋해서 행은 남았고요. 그래서 더 헷갈렸죠.)

`handle()`을 트랜잭션 경계로 만들어 고쳤어요.

```java
@Transactional   // 발행이 이 트랜잭션에 실려 커밋 → 그 커밋에 비동기 해석이 걸린다
public void handle(String sig, String body) {
    receive(sig, body);
}
```

[자기호출이 프록시 기반 AOP를 우회한다](/blog/project/pay/pay-26-persistence-bug)는 건 아는 함정인데도, 이벤트 발행과 얽히니 증상이 "리스너가 그냥 안 불림"으로 나타나서 한참 봤어요. **코드로는 안 보이고 실기동에서만 드러났죠.**

## 3. 함정 둘 — 오염된 트랜잭션에 FAILED를 못 쓴다

고치니 리스너가 불렸어요. 근데 이번엔 다른 에러가.

```
Transaction silently rolled back because it has been marked as rollback-only.
Leaving event publication uncompleted.
```

존재하지 않는 결제를 가리킨 웹훅을 처리할 때였어요. `process`가 원래 이렇게 돼 있었거든요.

```java
try {
    paymentRecoveryService.resolveByPaymentKey(paymentKey);  // 없는 결제 → 예외
    event.markProcessed();
} catch (Exception e) {
    event.markFailed(e.getMessage());   // ← 여기가 안 먹혔다
}
repository.save(event);
```

> `resolveByPaymentKey`가 "결제 없음"으로 예외를 던지면, 그게 이미 **현재 트랜잭션을 rollback-only로 오염**시켜요. `catch`로 잡아서 `FAILED`를 쓰고 `save`해도, 오염된 트랜잭션은 **커밋 자체가 거부**돼요. "실패를 기록하려는 write"가 그 실패 때문에 막히는 거죠.

여기서 방향을 바꿨어요. "실패를 잡아 FAILED로 **포기**"하는 대신, **예외를 그대로 전파**하기로요.

```java
// 실패는 삼키지 않는다 — 예외 전파 → 아웃박스가 발행을 미완료로 남겨 재시도(at-least-once)
paymentRecoveryService.resolveByPaymentKey(paymentKey);
event.markProcessed();
repository.save(event);
```

> 비동기 해석이 아웃박스에 실려 있으니, 예외를 던지면 Modulith가 그 발행을 **미완료로 남겨 재시도**해요. PG 일시 장애 같은 건 재시도로 풀리고, 오염된 트랜잭션에 억지로 뭘 쓸 필요도 없어졌죠. "포기하고 FAILED"보다 "재시도에 맡긴다"가 아웃박스와 더 잘 맞았어요.

실기동으로 최종 확인했어요.

```
정상 웹훅(실제 결제) → 200(0.02s) → 별도 스레드 → PROCESSED, 발행 완료 ✓
실패 웹훅(없는 결제)  → 200(0.02s) → 해석 실패 전파 → 발행 미완료(재시도 대기) ✓
```

성공은 완료되고, 실패는 유실 없이 재시도 큐에 남아요.

## 마치며

이번 편의 배선 자체는 두 줄이에요 — 발행 하나, 리스너 하나. 근데 그 사이에 **트랜잭션 함정 둘**이 있었고, 둘 다 [코드 리뷰로는 안 보이고 실기동에서만](/blog/project/pay/pay-26-persistence-bug) 드러났어요. 자기호출이 트랜잭션을 우회한 것도, 예외가 트랜잭션을 오염시킨 것도, "웹훅을 쏴보고 DB를 열어보고 나서야" 알았죠.

비동기는 "떼면 끝"이 아니에요. **어디서 트랜잭션이 열리고 커밋되는지**, **실패가 그 트랜잭션을 어떻게 오염시키는지**를 알아야 진짜로 동작해요. 그리고 그 앎은 — 늘 그렇듯 — 돌려보고 나서야 왔어요.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, 빠른 200(~0.02s)·비동기 PROCESSED·실패 시 아웃박스 재시도를 실기동으로 확인했습니다.*

---
title: '웹훅은 믿는 게 아니라 검증하는 것 — 그리고 이벤트를 잃지 않는 법'
titleEn: "A Webhook Is Not to Be Trusted but Verified — And How Not to Lose Events"
description: 결제 시스템 Phase 3. 웹훅과 이벤트를 만든다. 현직자가 제일 파고드는 "웹훅이 두 번 오면? 안 오면? 순서가 뒤집히면?"에 답한다 — 서명은 HMAC으로 검증하되, 페이로드의 상태는 믿지 않고 조회 API로 재검증한다. 그리고 결제 완료를 다른 모듈로 전파할 때의 dual-write 문제를 Spring Modulith 이벤트 레지스트리(=Transactional Outbox)로 풀고, at-least-once를 멱등 컨슈머로 받고, 실패는 DLQ로 격리한다.
descriptionEn: "Payment system Phase 3: webhooks and events. Answering what practitioners probe hardest — 'what if the webhook arrives twice? never? out of order?' — by verifying signatures with HMAC but never trusting the payload's status, re-verifying via the query API instead. Then solving the dual-write problem of propagating payment completion across modules with Spring Modulith's event registry (a Transactional Outbox), consuming at-least-once with an idempotent consumer, and isolating failures in a DLQ."
date: 2026-07-08T00:00:00.000Z
tags:
  - Payment
  - Webhook
  - Transactional Outbox
  - Spring Modulith
  - Kafka
  - Idempotency
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 3
---

*결제 도메인 취업을 목표로 실전 결제 시스템을 밑바닥부터 만드는 시리즈. 이 글은 3편 — 웹훅 처리와 이벤트 유실 방지.*

## 0. 이번 편의 두 질문

Phase 3은 결제를 **바깥세상과 잇는** 편이에요. 두 방향이 있어요.

- **들어오는 것 — 웹훅**: PG가 "이 결제 상태가 바뀌었어요"라고 우리한테 알려주는 것
- **나가는 것 — 이벤트**: 결제가 완료됐을 때 원장·정산·알림 같은 다른 모듈에 전파하는 것

그리고 각각에 현직자가 꼭 물어보는 질문이 붙어요.

> 웹훅이 **두 번** 오면? **안** 오면? **순서가 뒤집혀** 오면?
> 결제는 됐는데 이벤트 발행이 실패해서 **원장에 안 남으면**?

## 1. 웹훅 — 페이로드를 믿지 마세요

가장 흔한 실수는 웹훅 페이로드를 **그대로 믿는** 거예요. "웹훅에 `status: DONE`이라고 왔으니 결제 완료 처리하자." 이게 위험해요.

- 웹훅은 **위조**될 수 있어요 (아무나 우리 웹훅 URL로 가짜 요청을 보낼 수 있죠)
- 웹훅은 **순서가 뒤집혀** 올 수 있어요 (나중 상태가 먼저 도착)
- 웹훅은 **중복**으로 와요 (PG가 재전송하니까 — 정상 동작이에요)

그래서 제가 세운 원칙은 하나예요.

> **웹훅은 "뭔가 바뀌었다"는 신호로만 쓰고, 실제 상태는 조회 API로 다시 물어본다.**

수신 파이프라인을 이렇게 짰어요.

```
[서명 검증] → [멱등 수신(중복이면 스킵)] → [원본 저장] → [빠른 200]
                                                    ↓ (그 다음)
                              [조회 API로 재검증 → 상태 확정]
```

### 서명 검증 — HMAC, constant-time, tolerance

위조를 막으려면 서명을 검증해야 해요. (토스페이먼츠는 웹훅 서명 스펙이 없어서, 자체 Mock PG에 Stripe 방식을 구현했어요.)

```java
// signedPayload = timestamp + "." + rawBody
// HMAC-SHA256 으로 계산한 서명과 헤더의 서명을 비교
boolean valid = MessageDigest.isEqual(expected, provided);   // ← constant-time 비교
```

세 가지가 포인트예요.

- **`MessageDigest.isEqual` (constant-time 비교)**: 일반 `equals`는 앞부터 비교하다 틀리면 바로 끝나서, 응답 시간으로 서명을 한 글자씩 알아내는 **타이밍 공격**이 가능해요. 상수 시간 비교로 막아요.
- **timestamp를 서명에 포함**: 그래서 위조 불가.
- **tolerance 5분**: 오래된(가로챈) 요청을 재전송하는 **replay 공격**을 막아요.

### 멱등 수신 — 두 번 와도 괜찮게

PG는 응답을 못 받으면 웹훅을 **최대 7회 재전송**해요(토스 기준 약 3일 19시간). 그러니 같은 이벤트가 여러 번 와요. `external_event_id`에 유니크 제약을 걸어서, 이미 받은 이벤트는 조용히 스킵해요.

```java
if (repository.findByExternalEventId(eventId).isPresent()) {
    return; // 중복 웹훅은 정상 — 그냥 넘어간다
}
```

### 순서 역전 — 조회가 답이다

"순서가 뒤집히면?"의 답도 결국 같아요. 페이로드의 상태 대신 **조회 API로 최신 상태를 다시 읽으니까**, 웹훅이 어떤 순서로 오든 우리는 항상 "지금 PG의 진짜 상태"를 반영해요. 그리고 이 조회-확정 로직은 [Phase 2](/blog/project/pay/pay-2-designing-for-failure)의 복구 배치와 **완전히 같은 코드**(`resolveByPaymentKey`)예요. 웹훅이든 배치든, 결국 "PG에 물어봐서 확정한다"는 하나의 길로 모여요.

마지막으로, 컨트롤러는 **항상 200을 반환**해요(서명 실패만 401). 파싱이 실패해도 저장은 됐으니 200을 주죠. 5xx를 주면 PG가 계속 재전송하며 우리를 두들기니까요.

## 2. 나가는 이벤트 — dual-write 문제

이제 반대 방향. 결제가 완료되면 원장에 기록하고, 정산에 반영하고, 알림을 보내야 해요. 이걸 이벤트로 전파하는데, 여기 함정이 있어요 — **dual-write.**

```
결제 DB 커밋  ─┐
              ├─ 둘 다 성공해야 하는데...
이벤트 발행    ─┘
```

- 커밋 후 발행이 실패하면 → **이벤트 유실** (결제는 됐는데 원장에 안 남음)
- 발행 후 커밋이 실패하면 → **유령 이벤트** (원장엔 있는데 결제가 없음)

정석 해법은 **Transactional Outbox**예요. 도메인 변경과 이벤트를 **한 트랜잭션**에 같이 저장하고, 릴레이가 나중에 발행. [0편에서 말했듯이](/blog/project/pay/pay-0-why-and-modulith), **Spring Modulith의 이벤트 레지스트리가 바로 이 Outbox예요.**

`@ApplicationModuleListener`로 이벤트를 받으면, Modulith가 발행을 `event_publication` 테이블에 기록해요. 리스너가 성공하면 완료로 마킹하고, 실패하거나 앱이 죽으면 미완료로 남아 재시도되죠. 제가 직접 outbox 테이블과 폴링 릴레이를 짜는 대신, 검증된 구현을 쓰는 거예요.

```java
@Component
class PaymentConfirmedListener {
    @ApplicationModuleListener   // = 커밋 후 + 비동기 + 자체 트랜잭션 + Outbox 기록
    void on(PaymentConfirmedEvent event) {
        notificationService.handlePaymentConfirmed(event);
    }
}
```

## 3. at-least-once를 안전하게 받기 — 멱등 컨슈머 + DLQ

Outbox는 **at-least-once**예요. "적어도 한 번"은 보장하지만, 재시도 때문에 **두 번 이상** 올 수 있어요. 그래서 받는 쪽이 멱등해야 해요.

```java
public void handlePaymentConfirmed(PaymentConfirmedEvent event) {
    String eventKey = "payment-confirmed-" + event.paymentId();
    if (processedEvents.existsByEventKeyAndConsumer(eventKey, CONSUMER)) {
        return;   // 이미 처리함 — 중복 흡수
    }
    try {
        sender.sendPaymentReceipt(...);
        processedEvents.save(ProcessedEvent.of(eventKey, CONSUMER));
    } catch (RuntimeException ex) {
        deadLetters.save(DeadLetter.of("PaymentConfirmedEvent", eventKey, ex.getMessage()));
    }
}
```

두 가지 장치가 있어요.

- **멱등 컨슈머**: `(eventKey, consumer)` 유니크로 "이미 처리했나"를 판별. 같은 이벤트가 두 번 와도 한 번만 처리돼요.
- **DLQ(Dead Letter Queue)**: 처리가 실패하면 **예외를 밖으로 던지지 않고** 죽은 편지함에 격리해요. 왜냐면 리스너가 예외를 던지면 Modulith가 계속 재시도하는데, **포이즌 메시지**(항상 실패하는 이벤트)면 무한 재시도로 막혀버려요. 그래서 실패는 DLQ에 넣고 리스너는 정상 종료시켜, 나중에 배치/운영이 DLQ에서 재처리하게 해요.

> "Kafka는요?" 지금은 Modulith 이벤트 레지스트리를 Outbox 백본으로 써요. 외부 Kafka로 내보내는 건 `spring-modulith-events-kafka` 브릿지를 얹는 **설정 추가**예요 — 도메인 로직은 그대로고, 소비 측을 멱등하게 만들어 둔 게 이미 그 준비예요.

## 4. 정리

이번 편에서 만든 걸 두 방향으로 보면 —

| 방향 | 위협 | 방어 |
|---|---|---|
| 들어오는 웹훅 | 위조 | HMAC 서명 + constant-time + tolerance |
| | 중복 | external_event_id 유니크 |
| | 순서 역전 | 페이로드 대신 조회 API로 재검증 |
| | 유실 | 웹훅 + (Phase 2) 복구 배치 이중화 |
| 나가는 이벤트 | dual-write 유실 | Modulith 이벤트 레지스트리(Outbox) |
| | at-least-once 중복 | 멱등 컨슈머(processed_events) |
| | 포이즌 메시지 | DLQ 격리 |

테스트 64개, 전부 통과. 웹훅도 이벤트도 "실패와 중복이 당연히 일어난다"고 전제하고 설계한 거예요.

## 다음 — Phase 4: 정산·대사·원장 ★

다음이 이 시리즈에서 가장 희소한 편이에요.

```
복식부기 원장     차변 합계 = 대변 합계로 정합성을 수학적으로 증명
Spring Batch 정산  거래 집계 → 수수료 계산 → 지급금 생성
대사(reconciliation) PG 정산 파일 vs 내부 기록 4분류 — "결제의 최종 방어선"
```

취준생 포트폴리오에서 원장·대사까지 가는 경우는 거의 없어요. 이어서 씁니다.

---

*이 글은 작성 중인 시리즈의 일부예요. 실패·중복·순서역전을 각각 테스트로 재현하며 진행합니다.*

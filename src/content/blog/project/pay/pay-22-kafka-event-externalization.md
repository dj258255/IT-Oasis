---
title: '모놀리스 안에서만 울리던 이벤트를 밖으로 — Kafka로 결제 이벤트를 외부화한 이유'
titleEn: "Events That Only Rang Inside the Monolith — Why I Externalized Payment Events to Kafka"
description: 결제 시스템 개선기. 결제 이벤트는 모듈 간 통신의 척추였지만, 그 이벤트는 이 프로세스 안에서만 울렸다. 분석·별도 서비스처럼 프로세스 밖 소비자가 생기면? 이벤트 모델을 안 바꾸고 서비스 분리로 진화할 여지를 두려고 Spring Modulith의 @Externalized로 선택 이벤트를 Kafka에 실었다. 그리고 outbox와 Kafka를 묶어 dual-write 유실을 막은 이야기.
descriptionEn: "Payment system improvement log. Payment events were the spine of inter-module communication, but they only rang inside this process. What about out-of-process consumers like analytics or a separate service? To leave room to evolve toward services without changing the event model, I put selected events on Kafka via Spring Modulith's @Externalized — and tied outbox and Kafka together to prevent dual-write loss."
date: 2026-08-22T00:00:00.000Z
tags:
  - Payment
  - Kafka
  - Spring Modulith
  - Event Driven
  - Outbox
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 22
---

*결제 시스템 시리즈. 개선기 — 이벤트를 프로세스 밖으로.*

## 0. 이벤트는 이 프로세스 안에서만 울렸다

이 프로젝트는 [처음부터 이벤트로 모듈을 이었어요](/blog/project/pay/pay-0-why-and-modulith). 결제가 승인되면 `PaymentConfirmedEvent`가 울리고, [원장](/blog/project/pay/pay-4-ledger-settlement-reconciliation)이 분개하고, 정산이 집계하고, [현금영수증](/blog/project/pay/pay-16-cash-receipt)이 발급돼요. 모듈끼리 직접 호출하지 않고 이벤트로만 대화하니, 결합이 느슨하고 새 소비자를 붙이기도 쉬웠죠.

그런데 이 이벤트엔 한 가지 한계가 있었어요 — **이 프로세스 안에서만 울린다**는 거예요.

Spring Modulith의 `@ApplicationModuleListener`는 이벤트를 `event_publication` 테이블(outbox)에 기록하고, 같은 JVM 안의 리스너에게 비동기로 전달해요. 완벽하게 동작하지만, **JVM 경계를 못 넘어요.** 만약 —

- 결제 데이터를 실시간으로 빨아들이는 **분석/데이터웨어하우스**가 생기면?
- FDS(이상거래탐지)를 **별도 서비스**로 떼어내면?
- 다른 팀이 결제 완료를 구독해 자기 워크플로를 돌리고 싶으면?

이 소비자들은 우리 `event_publication` 테이블을 들여다볼 수 없어요. 모놀리스 안에 갇힌 이벤트인 거죠.

## 1. 선택지: 이벤트 모델을 갈아엎을 것인가

가장 안이한 답은 "필요해지면 그때 REST API를 뚫어주자"예요. 하지만 그건 이벤트 기반 설계를 버리고 폴링·동기 호출로 돌아가는 거예요. 이미 잘 만든 이벤트 모델이 있는데요.

더 나은 방향은 **지금 있는 이벤트를 그대로 두고, 프로세스 밖으로도 흘려보내는** 거예요. 이벤트를 발행하는 payment 모듈의 코드는 한 줄도 안 바꾸고, "이 이벤트는 밖에서도 필요하다"고 **선언**만 하는 거죠. 그러면 나중에 서비스를 분리해도 이벤트 모델을 다시 짤 필요가 없어요.

Spring Modulith가 정확히 이걸 위한 도구를 줘요 — `@Externalized`예요.

## 2. `@Externalized` — 애노테이션 하나로 밖에 싣기

이벤트 타입에 애노테이션 하나만 붙이면 돼요.

```java
@Externalized("payment.confirmed::#{orderNo}")
public record PaymentConfirmedEvent(String orderNo, Long paymentId, long amount, Instant approvedAt) {}
```

이건 "이 이벤트가 발행되면 `payment.confirmed` **토픽**으로, `orderNo`를 **메시지 키**로 Kafka에 실어라"는 뜻이에요. `PaymentCanceledEvent`도 `payment.canceled` 토픽으로 똑같이 붙였고요.

`::#{orderNo}` 부분 — 메시지 키를 orderNo로 잡은 게 중요해요.

> Kafka는 **파티션 안에서만** 순서를 보장해요. 같은 키는 항상 같은 파티션으로 가니, orderNo를 키로 쓰면 **같은 주문의 이벤트(confirmed → canceled)가 순서 역전 없이** 도착해요. 우리가 필요한 건 전역 순서가 아니라 "한 주문 안에서의 순서"뿐이라, 이걸로 충분하죠. 서로 다른 주문은 병렬로 흘려도 되니 처리량도 살고요.

## 3. 진짜 함정: dual-write 유실

여기서 조심할 게 있어요. "이벤트를 DB에도 저장하고 Kafka에도 발행"하는 건 전형적인 **dual-write 문제**예요.

> DB 저장은 성공했는데 Kafka 발행이 실패하면? 또는 그 반대라면? 두 시스템에 각각 쓰는 순간, "하나는 됐고 하나는 안 된" 불일치가 생겨요. 결제 도메인에서 이건 "원장엔 있는데 분석엔 없는" 데이터 유실로 이어져요.

Modulith의 외부화가 좋은 건, 이걸 **outbox로 봉합**한다는 거예요.

```
결제 승인 트랜잭션
  ├─ payments 테이블 저장
  └─ event_publication(outbox)에 이벤트 기록  ← 같은 로컬 트랜잭션!
  ─────────── 커밋 ───────────
  (커밋 후) 외부화 리스너가 Kafka로 발행
     ├─ 성공 → outbox에서 완료 마킹
     └─ 실패/브로커 다운 → 미완료로 남음 → 재기동 시 재발행
```

핵심은 **이벤트 기록이 결제 저장과 같은 트랜잭션**이라는 거예요. 결제가 커밋됐으면 이벤트도 반드시 outbox에 있어요. Kafka 발행은 그 **뒤에** 일어나고, 실패하면 outbox에 남아 재시도돼요. 그래서 "결제는 됐는데 이벤트는 증발"하는 일이 구조적으로 안 생겨요. 대신 재발행 때문에 **같은 이벤트가 두 번 갈 수 있으니**(at-least-once), 프로세스 밖 소비자도 [인프로세스 소비자처럼](/blog/project/pay/pay-2-designing-for-failure) 멱등하게 짜야 해요.

producer 쪽도 `acks=all` + 멱등 producer로 뒀어요 — 브로커가 확실히 받았을 때만 성공으로 치고, 재시도 중복을 억제하게요.

## 4. 브로커가 없어도 앱은 떠야 한다

마지막으로 운영 현실 하나. 로컬 개발이나 테스트에선 Kafka를 안 띄우는 경우가 많아요. 그런데 `@Externalized`가 걸린 이벤트를 발행할 때마다 브로커가 없다고 부팅이나 결제가 깨지면 곤란하죠.

그래서 외부화를 **프로퍼티로 게이트**했어요. 기본은 꺼두고(`externalization.enabled: false`), Kafka가 있는 환경에서만 `kafka` 프로파일로 켜요.

- **기본(off)**: `@Externalized` 애노테이션은 그대로 있지만 Kafka로는 아무것도 안 나가요. outbox 기반 인프로세스 소비는 100% 그대로 동작하고, 브로커 없이도 부팅·테스트가 다 통과해요.
- **kafka 프로파일(on)**: 외부화 리스너가 활성화돼 실제로 Kafka에 실어요.

기능을 넣되 **기존 동작을 1도 안 건드리는** 게 중요했어요. 개선이 회귀를 만들면 안 되니까요.

## 마치며

이번 건 "당장 필요한 기능"이라기보단 **미래를 위한 여지**를 만든 거예요. 지금은 모놀리스 하나지만, 이벤트를 프로세스 밖으로 흘릴 수 있게 해두면 — 나중에 분석 파이프라인을 붙이든, FDS를 서비스로 떼어내든, **이벤트 모델을 다시 짜지 않고** 소비자만 늘리면 돼요.

그리고 그 과정에서 dual-write 유실이라는 함정을 outbox로 봉합했어요. 이벤트를 밖으로 내보내는 일에서 진짜 어려운 건 "어떻게 보내느냐"가 아니라 **"어떻게 안 잃느냐"**더라고요.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, 외부화는 프로퍼티로 켜고 끌 수 있게 설계했습니다.*

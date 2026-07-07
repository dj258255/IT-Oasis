---
title: '아무도 부르지 않는 배치들 — javadoc은 스케줄러가 있다고 믿었다'
titleEn: 'Batches Nobody Calls — the Javadoc Believed a Scheduler Existed'
description: 결제 시스템 개선기. 전수 감사에서 "로직은 있는데 주기 호출자가 없는" 배치 4종을 찾았다. 미확정 결제 복구는 javadoc이 "스케줄러가 실행한다"고 적어놨는데 정작 스케줄러 클래스가 없었고, 주문/가상계좌 만료·구독 dunning도 로직만 있고 부르는 이가 없었다. 만료돼야 할 주문이 영원히 안 만료되고 있었다. 그리고 outbox 테이블은 완료 이벤트를 지우지 않아 무한히 자라고 있었다. 죽은 배치들에 스케줄러를 달아 살린 이야기.
descriptionEn: "Payment system improvement log. An audit found four batches with logic but no periodic caller. The unknown-payment recovery's javadoc claimed 'a scheduler runs this' — but no scheduler class existed; order/virtual-account expiry and subscription dunning had logic with no caller too. Orders that should expire never did. And the outbox table grew forever, never purging completed events. A story of bringing dead batches to life with schedulers."
date: 2026-12-26T00:00:00.000Z
tags:
  - Payment
  - Batch
  - Scheduler
  - Spring Boot
  - Operations
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 40
---

*결제 시스템 시리즈. 개선기 — 부르는 사람이 없던 배치를 살리다.*

## 0. javadoc이 거짓말을 하고 있었다

[전수 감사](/blog/project/pay/pay-39-settlement-escrow-alignment)에서 나온 또 하나의 항목이에요.

> **[5] 핵심 배치 스케줄러 부재** — @Scheduled는 2개뿐. 미확정 결제 복구·구독 dunning·주문/VA 만료 배치가 **로직만 있고 부르는 스케줄러가 없음**.

특히 미확정 복구가 재밌었어요. `PaymentRecoveryService`의 javadoc엔 이렇게 적혀 있었거든요.

```java
/**
 * ... 스케줄러가 {@code payment.recovery.enabled=true}일 때 이 로직을 주기 실행한다(운영). ...
 */
```

**그런데 그 스케줄러가 없었어요.** grep해보니 `@Scheduled`도, `payment.recovery.enabled` 프로퍼티도 실재하지 않았죠. 문서는 "스케줄러가 돈다"고 믿고 있는데, 실제로는 [어드민이 수동으로 트리거](/blog/project/pay/pay-29-admin-sync-resolve)하는 것뿐이었어요. 의도와 구현이 갈라진, [죽은 이벤트](/blog/project/pay/pay-39-settlement-escrow-alignment)와 같은 종류의 갭이었어요.

## 1. 로직은 다 있었다, 부르는 사람만 없었다

확인해보니 **배치 로직은 전부 완성**돼 있었어요.

| 배치 | 로직 | 스케줄러 |
|---|---|---|
| 미확정(UNKNOWN) 결제 복구 | `recoverUnknownPayments()` ✅ | ❌ (javadoc은 있다고 주장) |
| 가상계좌 만료 | `expireOverdue(now)` ✅ | ❌ |
| 구독 정기결제(dunning) | `runBillingCycle(today)` ✅ | ❌ |
| 주문 만료 | `Order.markExpired()` ✅ | ❌ (스캔 서비스도 없음) |

가장 심각한 건 **주문 만료**였어요. `Order.markExpired()`(PENDING_PAYMENT → EXPIRED)는 있는데, "만료 배치가 이 값으로 스캔한다"는 [주석](/blog/project/pay/pay-1-order-payment-core)의 그 배치가 **존재하지 않았어요.**

> 즉, 결제 안 하고 방치된 PENDING_PAYMENT 주문이 **영원히 만료되지 않아요.** 30분 유효시간이 지나도 상태가 그대로라, 재고 선점(있었다면)이나 통계가 계속 오염돼요. 만료 로직은 있는데 아무도 그걸 실행하지 않으니, 사실상 없는 기능이었죠.

## 2. 스케줄러를 다는 것도 그냥 붙이면 안 된다

배치 4개에 스케줄러를 달았어요. 그런데 이 프로젝트엔 스케줄러를 켜고 끄는 원칙이 이미 있었어요 — [보상 태스크·에스크로 자동 릴리스](/blog/project/pay/pay-19-compensation-network-cancel)처럼 **프로퍼티 게이트(기본 off)**로요.

```java
@Configuration @EnableScheduling
@ConditionalOnProperty(name = "app.order.expiry.enabled", havingValue = "true")
class OrderExpirySchedulingConfig {}   // 프로퍼티 off면 스케줄링 인프라 자체가 안 뜬다
```

기본을 off로 두는 이유는 테스트·부트에 부작용이 없게 하기 위해서예요. 여기서 신경 쓴 게 하나 있어요 — **여러 `@EnableScheduling`이 공존해도 되나?**

> 이미 order(보상)·escrow(자동 릴리스)에 각각 `@EnableScheduling` 게이트가 있고, 여기에 복구·만료·dunning·outbox까지 더하면 `@EnableScheduling`이 여러 개가 돼요. 괜찮을까? — 괜찮아요. `@EnableScheduling`은 `ScheduledAnnotationBeanPostProcessor`를 **고정된 빈 이름**으로 등록하는데, Spring이 같은 이름의 중복 등록을 dedup해요. 그래서 게이트를 몇 개를 켜도 스케줄링 처리기는 한 번만 뜨죠. 각 프로퍼티를 켠 스케줄러만 독립적으로 돌아요.

새로 만든 건 주문 만료 스캔 서비스 하나뿐이었어요(나머지는 기존 로직에 스케줄러만).

```java
public int expireOverdue(Instant now) {
    // PENDING_PAYMENT + 만료시각 경과 주문을 스캔 → markExpired + saveAndFlush
    // 한 건 실패가 배치를 안 멈추게 per-item try/catch
}
```

[예의 saveAndFlush](/blog/project/pay/pay-26-persistence-bug)와 [한 건 실패 격리](/blog/project/pay/pay-23-ops-admin)는 이젠 반사적으로 들어가요.

실기동으로 확인했어요 — 주문을 만들고 만료시각을 과거로 backdate한 뒤 스케줄러를 켜니,

```
주문 → PENDING_PAYMENT
(만료시각 과거로 조작)
→ 8초 뒤 → EXPIRED
로그: "주문 만료 배치 완료 count=1"
```

드디어 만료돼야 할 주문이 만료돼요.

## 3. 무한히 자라던 테이블

마지막은 눈에 안 보이던 문제 — **outbox 테이블의 무한 성장**이었어요.

이 시스템은 [Modulith의 Event Publication Registry](/blog/project/pay/pay-3-webhooks-and-outbox)를 outbox로 써요(`event_publication` 테이블). 이벤트를 발행하면 여기 기록되고, 리스너가 처리하면 완료 표시돼요. 그런데 —

> **완료된 이벤트를 지우거나 아카이브하는 게 없었어요.** 게다가 `republish-outstanding-events-on-restart: true`라 재기동 때 미완료분을 재발행하죠. 그래서 이 테이블은 **매 결제마다 커지기만** 했어요. 몇 달이면 수백만 행이 쌓여 조회·재발행이 느려지고, 결국 성능 문제가 돼요.

Modulith가 이걸 위한 API를 줘요 — `CompletedEventPublications.deletePublicationsOlderThan(Duration)`. 완료된 지 N일 지난 이벤트를 지우는 거죠. 주기 정리 스케줄러를 붙였어요(기본 7일 보존).

> 참고로 Modulith 1.3엔 `completion-mode`로 `DELETE`(완료 즉시 삭제)나 `ARCHIVE`(별도 테이블로 이동) 모드도 있어요. 감사 이력을 잠깐이라도 남기고 싶어서 "완료 유지 + 주기 purge"를 택했어요. outbox는 유실 방지가 목적이지 영구 보관이 목적은 아니니까요.

## 마치며

이번 건 화려하진 않아요. 스케줄러 4개 + 정리 잡 하나니까요. 하지만 **"로직이 있다 ≠ 동작한다"**를 다시 보여준 편이에요.

배치 로직을 아무리 잘 짜도, 그걸 **주기적으로 부르는 사람이 없으면** 그건 죽은 코드예요. 그리고 javadoc이 "스케줄러가 돈다"고 적혀 있다고 실제로 도는 게 아니고요. [실기동이](/blog/project/pay/pay-26-persistence-bug), [실측이](/blog/project/pay/pay-37-deadlock-retry) 그랬듯 — 감사가 "문서의 주장과 코드의 현실"이 갈라진 곳을 짚어줬어요. 만들어둔 걸 실제로 **살아 움직이게** 하는 것도, 만드는 것만큼 중요한 일이더라고요.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, 주문 만료 배치를 실 MySQL로 검증했습니다(backdate→EXPIRED).*

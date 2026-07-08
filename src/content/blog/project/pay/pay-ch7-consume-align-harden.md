---
title: '이벤트 소비·도메인 정합·하드닝'
description: '프로세스 밖 Kafka 소비자, 죽은 이벤트가 가리킨 정산·에스크로 도메인 모순, 아무도 안 부르던 스케줄러, 암호화의 실적용, 보안 상태 수명·운영성·관측성.'
date: 2026-01-04T00:00:00.000Z
tags:
  - Payment
  - Spring Boot
  - Spring Modulith
  - 결제 시스템
category: project/pay
draft: false
series: "결제 시스템 만들기"
seriesOrder: 7
---

*결제 시스템 시리즈 — 이벤트 소비·도메인 정합·하드닝. (원 연재 여러 편을 한 챕터로 묶었습니다. 각 절이 원래 한 편입니다.)*

## 프로세스 밖 소비자"라는 약속을 실제로 지키기 — 그리고 붙여보니 드러난 이중 인코딩

*결제 시스템 시리즈. 개선기 — 약속을 실증으로, 실증이 버그를.*

### 0. 구독자 없는 외부화는 약속일 뿐

[Kafka 외부화 편](/blog/project/pay/pay-ch4-arch-events-ops)에서 결제 이벤트에 `@Externalized`를 달아 Kafka로 내보냈어요. 목적은 분명했죠 — **프로세스 밖 소비자**(분석, 별도 서비스, 다른 팀)가 이벤트 모델 무수정으로 구독할 수 있게.

그런데 돌아보니, 정작 **구독하는 프로세스 밖 소비자가 하나도 없었어요.** 토픽에 이벤트가 실리는 것까진 확인했지만, "다른 프로세스가 실제로 받아서 쓸 수 있다"는 건 여전히 **약속**이었지 실증이 아니었죠. [FDS 엔진](/blog/project/pay/pay-ch5-runtime-truths)도 [대사 엔진](/blog/project/pay/pay-ch6-security-queue)도 "만들어두고 안 연결된" 상태였다가 연결하며 완성됐듯 — 외부화도 소비자가 있어야 완성이에요.

그래서 만들었어요. 그리고 이번에도, **실제로 붙여보니 몰랐던 게 드러났어요.**

### 1. 소비자 앱 — 메인과 완전히 분리

소비자는 "정산 알림" 데모 워커예요. `payment.confirmed`/`payment.canceled`를 구독해 구조화 로그를 남기는 경량 앱. 설계에서 지킨 분리 원칙 세 가지 —

**(1) 빌드부터 분리.** `consumer-app/`은 자체 `settings.gradle`을 가진 **독립 Gradle 프로젝트**예요. 루트 멀티모듈에 include하지 않아서, 메인의 빌드·테스트·CI가 이 앱의 존재조차 몰라요. 실행만 wrapper를 공유하죠(`./gradlew -p consumer-app bootRun`). "별도 서비스"라면 빌드 생명주기부터 별도여야 하니까요.

**(2) 타입도 분리.** 소비자는 메인 앱의 이벤트 클래스를 import하지 않아요. 값을 **String으로 받아 Jackson `readTree`로 파싱**해요. producer가 붙이는 타입 헤더(`__TypeId__: com.beomsu.pay...PaymentConfirmedEvent`)에 기대면, 소비자가 발행자의 **내부 클래스명에 결합**돼요 — 그 순간 "프로세스 밖"의 의미가 사라지죠. 계약은 클래스가 아니라 **JSON 스키마**여야 해요.

**(3) 실패도 분리.** 파싱 안 되는 메시지(포이즌)는 warn 찍고 건너뛰어요 — 이상한 메시지 하나가 파티션 소비 전체를 멈추면 안 되니까요. 그리고 [outbox 재발행](/blog/project/pay/pay-ch4-arch-events-ops)은 at-least-once라 **중복 수신이 가능**하다는 것, 그래서 실소비자는 orderNo/paymentId 기반 멱등 처리가 필수라는 걸 코드에 명시했어요.

### 2. 붙여보니 — 와이어에 base64가 흐르고 있었다

두 앱을 나란히 띄우고 결제를 일으켰어요. 소비자가 이벤트를 받긴 받았는데 —

```
[정산알림] 결제 완료 수신 orderNo= amount=0 ...   ← 빈 값?!
```

파싱이 전부 빈 값이에요. 토픽을 직접 덤프해보니 —

```
"eyJvcmRlck5vIjoiMDFLV1c2OFpFMldNOVNFQVY5SEFONjdHSlEiLCJwYXltZW50SWQiOjEsImFtb3VudCI6MTAwMDAsIn..."
```

JSON이 아니라 **base64 문자열**이 흐르고 있었어요. 디코드하니 그 안에 정확한 JSON이 들어 있었고요. 이중 인코딩이죠.

> 원인은 직렬화기 궁합이었어요. Modulith 외부화는 이벤트를 **이미 JSON byte[]로 직렬화해서** KafkaTemplate에 넘겨요. 그런데 producer의 value-serializer가 `JsonSerializer`였고 — Jackson은 byte[]를 받으면 **base64 문자열로 JSON 인코딩**해요. 이미 JSON인 걸 한 번 더 감싼 거예요.
>
> 수정은 한 줄: `value-serializer: ByteArraySerializer`. 이미 직렬화된 byte[]를 **그대로** 와이어에 싣는 거죠.

고치고 다시 돌리니 —

```
[정산알림] 결제 완료 수신 orderNo=01KWW6HR... amount=10000 partition=0 offset=1
[정산알림] 결제 취소 수신 orderNo=01KWW6HR... cancelAmount=10000 fullyCanceled=true
```

별도 프로세스가 깨끗한 JSON을 받아 모든 필드를 정확히 파싱해요. 이제 "프로세스 밖 소비자"는 약속이 아니라 **동작하는 사실**이에요.

### 3. 왜 이 버그는 지금까지 숨어 있었나

곱씹어볼 지점이에요. 이 이중 인코딩은 [외부화를 만든 시점](/blog/project/pay/pay-ch4-arch-events-ops)부터 있었어요. 그런데 아무 테스트도 못 잡았죠 — 발행 측 설정 테스트는 "토픽으로 나간다"까지만 봤고, **와이어 포맷을 읽는 쪽이 없었으니** 포맷이 틀렸는지 알 길이 없었어요.

이 시리즈에서 반복된 패턴이 또 나온 거예요.

> [결제 확정 버그](/blog/project/pay/pay-ch5-runtime-truths)는 실기동 E2E가, [outbox 데드락](/blog/project/pay/pay-ch6-security-queue)은 스파이크 실측이, 이번 이중 인코딩은 **실제 소비자를 붙이는 것**이 드러냈어요. 공통점 — **소비하는 쪽이 생기기 전까지, 만드는 쪽은 자기가 옳다고 믿는다.** 계약의 검증은 언제나 반대편 끝에서 옵니다.

Kafka를 붙일 계획이 없더라도, 이벤트를 외부화한다면 **더미라도 좋으니 진짜로 읽는 소비자를 하나 두는 것** — 그게 와이어 계약의 테스트예요.

### 마치며

이번 건 시리즈에서 계속 미뤄왔던 "프로세스 밖" 한 조각을 채운 편이에요. 독립 빌드·타입 비결합·포이즌 격리라는 소비자 쪽 원칙을 세웠고, 붙이는 과정에서 발행 쪽의 숨은 이중 인코딩까지 잡았어요.

이벤트 기반 아키텍처의 완성은 발행이 아니라 **구독**이더라고요. 구독자가 생기는 순간 계약이 검증되고, 포맷이 드러나고, 약속이 사실이 돼요.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, 소비자 앱은 [consumer-app/](https://github.com/dj258255/payment-system/tree/main/consumer-app)에서 별도 프로세스로 실행됩니다.*

<hr />

## 구매확정 전에 정산되고 있었다 — 죽은 이벤트가 가리킨 도메인 모순

*결제 시스템 시리즈. 개선기 — 감사가 찾아낸 마지막 모순.*

### 0. 감사가 이상한 걸 짚었다

기능이 거의 다 완성된 뒤, 코드베이스를 **전수 감사**했어요("시스템이 암묵적으로 가정하는 것"을 다 찾아내자). 17건이 나왔는데, 그중 하나가 유독 걸렸어요.

> **[3] 정산이 에스크로와 분리** — 정산 적재가 `PaymentConfirmedEvent`(승인 즉시)에서 일어나고, `EscrowReleasedEvent`는 **구독자 0**(죽은 이벤트). "구매확정 전 보류"가 정산에 미반영.

읽고 나서 "아…" 했어요. [에스크로 편](/blog/project/pay/pay-ch4-arch-events-ops)에서 분명히 이렇게 만들었거든요 — 결제금을 **구매확정 전까지 HELD로 보류**하고, 구매자가 확정하면 RELEASED로 풀어 정산 가능하게. 자금이 판매자 것이 되는 건 **구매확정 시점**이라고요.

그런데 [정산 모듈](/blog/project/pay/pay-ch1-payment-core)은 그걸 몰랐어요. `PaymentSettlementListener`가 **결제 승인 이벤트**를 받아, 승인되자마자 정산 항목을 쌓고 있었죠. 즉 —

> **에스크로는 "구매확정 전엔 못 준다"고 하는데, 정산은 "승인됐으니 지급 목록에 올린다"고 하고 있었어요.** 같은 시스템 안에서 두 모듈이 "돈이 언제 판매자 것이 되는가"를 **정반대로** 알고 있던 거예요.

그리고 그 증거가 **죽은 이벤트**였어요. 구매확정 시 `EscrowReleasedEvent`를 발행하는데, [grep해보니 구독자가 아무도 없었어요.](/blog/project/pay/pay-ch5-runtime-truths) "향후 정산 파이프라인이 구독한다"는 주석만 남긴 채, 아무도 듣지 않는 이벤트를 계속 던지고 있던 거죠.

### 1. "돈은 언제 판매자 것이 되는가"

이건 결제 도메인에서 **가장 중요한 질문 중 하나**예요. 마켓플레이스라면 특히요.

- 너무 일찍 (승인 시점) 정산하면 → 미배송·분쟁 때 [이미 나간 돈을 회수 못 해요](/blog/project/pay/pay-ch4-arch-events-ops).
- 그래서 에스크로가 있는 거고, 정산은 **구매확정(에스크로 릴리스)에 맞춰야** 해요.

정답은 명확했어요 — **정산의 트리거를 승인이 아니라 구매확정으로 옮기는 것.** 죽어 있던 `EscrowReleasedEvent`를 정산이 구독하게 하면 돼요.

### 2. 정산 항목에 생명주기를 주다

기존 정산 항목의 상태는 `PENDING → SETTLED` 둘뿐이었어요. 여기에 "구매확정" 관문을 끼워 넣었어요.

```
PENDING_CONFIRMATION   승인됨 · 구매확정 대기 (아직 지급 대상 아님)
       ↓ EscrowReleasedEvent
CONFIRMED              구매확정됨 · 정산 가능
       ↓ 일 단위 배치
SETTLED               집계·지급됨
       (전액취소 시) → CANCELED
```

핵심은 세 곳이에요.

**(1) 승인 → PENDING_CONFIRMATION.** 승인 이벤트는 여전히 정산 항목을 만들지만, 이젠 "지급 대상"이 아니라 "**대기**" 상태로요.

**(2) 구매확정 → CONFIRMED.** 정산이 `EscrowReleasedEvent`를 구독해서, 그 주문의 항목을 CONFIRMED로 전이시켜요. **죽었던 이벤트가 드디어 제 일을 하는 거죠.**

```java
@ApplicationModuleListener
void onEscrowReleased(EscrowReleasedEvent event) {
    settlementService.confirmSettlement(event.orderNo());   // PENDING_CONFIRMATION → CONFIRMED
}
```

**(3) 배치는 CONFIRMED만 집계.** 일 단위 정산 배치가 `PENDING` 대신 **`CONFIRMED`만** 합산해요. 구매확정 안 된 `PENDING_CONFIRMATION` 항목은 지급에서 **자동으로 빠져요.** 이게 "구매확정 전 보류"가 정산에 실제로 반영되는 지점이에요 — 보류가 말이 아니라 동작이 된 거죠.

실기동으로 확인했어요.

```
승인 후        → settlement_items: PENDING_CONFIRMATION  (보류)
구매확정 후    → settlement_items: CONFIRMED             (정산 가능!)
전액취소       → settlement_items: CANCELED              (정산 제외)
부분취소 3000  → settlement_items: amount 7000           (역반영)
```

### 3. 취소는 정산에 어떻게 반영하나 — 그리고 정직한 한계

정산은 취소 이벤트도 구독하게 했어요(`PaymentCanceledEvent`). 그런데 여기 미묘한 경우들이 있어요.

- **확정 전 전액취소** → 항목을 `CANCELED`로. 애초에 지급 안 됨.
- **확정 전 부분취소** → 항목 amount를 줄임.
- **이미 SETTLED(집계·지급됨) 뒤 취소** → …?

마지막 경우가 어려워요. 이미 판매자에게 지급 목록으로 나간 걸 정산 항목에서 되돌리면, 회계가 어긋나요. 그래서 **되돌리지 않기로** 했어요.

> 이미 SETTLED된 항목에 취소가 오면, 금액을 건드리지 않고 `settlement.postsettle.cancel` 카운터만 올려요(운영이 별도 정산 조정으로 처리). 실무에선 이걸 **다음 배치의 음수 조정(clawback)**으로 반영하죠. 지금은 그 신호까지만 남기고, "정산은 재구성 가능한 집계이고 취소의 진짜 이력은 [원장 역분개](/blog/project/pay/pay-ch3-perf-cancel)가 보유한다"는 판단을 주석에 명시했어요.

측정을 부풀리지 않듯([데드락 편 각주처럼](/blog/project/pay/pay-ch6-security-queue)), 처리 못 하는 케이스도 **"못 한다"고 정직하게** 표시하는 게 나아요. 조용히 틀리게 처리하는 것보다요.

### 4. 경계는 여기서도 단방향

정산이 에스크로 이벤트를 구독하니, `settlement`가 `escrow`에 의존해요. 방향을 확인했어요 — **settlement → escrow 단방향**. 에스크로는 정산을 몰라요(자기 이벤트만 던질 뿐). [모듈 경계](/blog/project/pay/pay-ch4-arch-events-ops)를 CI가 강제하니, 순환이 생겼으면 빌드가 깨졌을 거예요. 통과했고요.

### 마치며

이번 건 이 시리즈에서 반복된 패턴의 **정점** 같아요. [실기동이](/blog/project/pay/pay-ch5-runtime-truths), [스파이크가](/blog/project/pay/pay-ch6-security-queue), [소비자를 붙이는 게](/blog/project/pay/pay-ch7-consume-align-harden) 숨은 문제를 드러냈듯 — 이번엔 **전수 감사**가 "두 모듈이 같은 사실을 다르게 알고 있는" 도메인 모순을 짚었어요.

그리고 그 모순의 증거가 **죽은 이벤트**였다는 게 인상적이었어요. 아무도 안 듣는 이벤트를 계속 던지고 있었다는 건, 설계 의도(구매확정 시 정산)와 실제 동작(승인 시 정산)이 갈라져 있었다는 신호였거든요. 죽은 이벤트를 살리는 건 단순히 리스너 하나 붙이는 게 아니라, **갈라진 두 모듈의 세계관을 다시 합치는** 일이었어요.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, 승인→보류→구매확정→확정→취소 반영을 실 MySQL로 검증했습니다.*

<hr />

## 아무도 부르지 않는 배치들 — javadoc은 스케줄러가 있다고 믿었다

*결제 시스템 시리즈. 개선기 — 부르는 사람이 없던 배치를 살리다.*

### 0. javadoc이 거짓말을 하고 있었다

[전수 감사](/blog/project/pay/pay-ch7-consume-align-harden)에서 나온 또 하나의 항목이에요.

> **[5] 핵심 배치 스케줄러 부재** — @Scheduled는 2개뿐. 미확정 결제 복구·구독 dunning·주문/VA 만료 배치가 **로직만 있고 부르는 스케줄러가 없음**.

특히 미확정 복구가 재밌었어요. `PaymentRecoveryService`의 javadoc엔 이렇게 적혀 있었거든요.

```java
/**
 * ... 스케줄러가 {@code payment.recovery.enabled=true}일 때 이 로직을 주기 실행한다(운영). ...
 */
```

**그런데 그 스케줄러가 없었어요.** grep해보니 `@Scheduled`도, `payment.recovery.enabled` 프로퍼티도 실재하지 않았죠. 문서는 "스케줄러가 돈다"고 믿고 있는데, 실제로는 [어드민이 수동으로 트리거](/blog/project/pay/pay-ch5-runtime-truths)하는 것뿐이었어요. 의도와 구현이 갈라진, [죽은 이벤트](/blog/project/pay/pay-ch7-consume-align-harden)와 같은 종류의 갭이었어요.

### 1. 로직은 다 있었다, 부르는 사람만 없었다

확인해보니 **배치 로직은 전부 완성**돼 있었어요.

| 배치 | 로직 | 스케줄러 |
|---|---|---|
| 미확정(UNKNOWN) 결제 복구 | `recoverUnknownPayments()` ✅ | ❌ (javadoc은 있다고 주장) |
| 가상계좌 만료 | `expireOverdue(now)` ✅ | ❌ |
| 구독 정기결제(dunning) | `runBillingCycle(today)` ✅ | ❌ |
| 주문 만료 | `Order.markExpired()` ✅ | ❌ (스캔 서비스도 없음) |

가장 심각한 건 **주문 만료**였어요. `Order.markExpired()`(PENDING_PAYMENT → EXPIRED)는 있는데, "만료 배치가 이 값으로 스캔한다"는 [주석](/blog/project/pay/pay-ch1-payment-core)의 그 배치가 **존재하지 않았어요.**

> 즉, 결제 안 하고 방치된 PENDING_PAYMENT 주문이 **영원히 만료되지 않아요.** 30분 유효시간이 지나도 상태가 그대로라, 재고 선점(있었다면)이나 통계가 계속 오염돼요. 만료 로직은 있는데 아무도 그걸 실행하지 않으니, 사실상 없는 기능이었죠.

### 2. 스케줄러를 다는 것도 그냥 붙이면 안 된다

배치 4개에 스케줄러를 달았어요. 그런데 이 프로젝트엔 스케줄러를 켜고 끄는 원칙이 이미 있었어요 — [보상 태스크·에스크로 자동 릴리스](/blog/project/pay/pay-ch3-perf-cancel)처럼 **프로퍼티 게이트(기본 off)**로요.

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

[예의 saveAndFlush](/blog/project/pay/pay-ch5-runtime-truths)와 [한 건 실패 격리](/blog/project/pay/pay-ch4-arch-events-ops)는 이젠 반사적으로 들어가요.

실기동으로 확인했어요 — 주문을 만들고 만료시각을 과거로 backdate한 뒤 스케줄러를 켜니,

```
주문 → PENDING_PAYMENT
(만료시각 과거로 조작)
→ 8초 뒤 → EXPIRED
로그: "주문 만료 배치 완료 count=1"
```

드디어 만료돼야 할 주문이 만료돼요.

### 3. 무한히 자라던 테이블

마지막은 눈에 안 보이던 문제 — **outbox 테이블의 무한 성장**이었어요.

이 시스템은 [Modulith의 Event Publication Registry](/blog/project/pay/pay-ch1-payment-core)를 outbox로 써요(`event_publication` 테이블). 이벤트를 발행하면 여기 기록되고, 리스너가 처리하면 완료 표시돼요. 그런데 —

> **완료된 이벤트를 지우거나 아카이브하는 게 없었어요.** 게다가 `republish-outstanding-events-on-restart: true`라 재기동 때 미완료분을 재발행하죠. 그래서 이 테이블은 **매 결제마다 커지기만** 했어요. 몇 달이면 수백만 행이 쌓여 조회·재발행이 느려지고, 결국 성능 문제가 돼요.

Modulith가 이걸 위한 API를 줘요 — `CompletedEventPublications.deletePublicationsOlderThan(Duration)`. 완료된 지 N일 지난 이벤트를 지우는 거죠. 주기 정리 스케줄러를 붙였어요(기본 7일 보존).

> 참고로 Modulith 1.3엔 `completion-mode`로 `DELETE`(완료 즉시 삭제)나 `ARCHIVE`(별도 테이블로 이동) 모드도 있어요. 감사 이력을 잠깐이라도 남기고 싶어서 "완료 유지 + 주기 purge"를 택했어요. outbox는 유실 방지가 목적이지 영구 보관이 목적은 아니니까요.

### 마치며

이번 건 화려하진 않아요. 스케줄러 4개 + 정리 잡 하나니까요. 하지만 **"로직이 있다 ≠ 동작한다"**를 다시 보여준 편이에요.

배치 로직을 아무리 잘 짜도, 그걸 **주기적으로 부르는 사람이 없으면** 그건 죽은 코드예요. 그리고 javadoc이 "스케줄러가 돈다"고 적혀 있다고 실제로 도는 게 아니고요. [실기동이](/blog/project/pay/pay-ch5-runtime-truths), [실측이](/blog/project/pay/pay-ch6-security-queue) 그랬듯 — 감사가 "문서의 주장과 코드의 현실"이 갈라진 곳을 짚어줬어요. 만들어둔 걸 실제로 **살아 움직이게** 하는 것도, 만드는 것만큼 중요한 일이더라고요.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, 주문 만료 배치를 실 MySQL로 검증했습니다(backdate→EXPIRED).*

<hr />

## 금고를 만들어놓고 아무것도 안 넣었다 — 암호화를 실제 컬럼에, 그리고 조회의 딜레마

*결제 시스템 시리즈. 개선기 — 만들어둔 암호화를 실제로 쓰다.*

### 0. 금고는 있는데 비어 있었다

[필드 암호화](/blog/project/pay/pay-ch2-payment-methods)를 만들고, [envelope로 키 로테이션까지](/blog/project/pay/pay-ch6-security-queue) 정성껏 확장했어요. AES-256-GCM, DEK/KEK, 블라인드 인덱스, JPA 컨버터 — 민감 데이터를 잠글 금고를 완비했죠.

그런데 [감사](/blog/project/pay/pay-ch7-consume-align-harden)가 이렇게 짚었어요.

> **[4] 필드 암호화 인프라 전부 미사용** — `@Convert`가 **어느 엔티티 컬럼에도 적용 안 됨**. 가상계좌 계좌번호·빌링키가 평문.

금고를 만들어놓고 **아무것도 안 넣은** 거예요. 계좌번호도, 카드 토큰인 빌링키도 DB에 평문으로 누워 있었죠. [FDS 엔진처럼](/blog/project/pay/pay-ch5-runtime-truths), [대사 엔진처럼](/blog/project/pay/pay-ch6-security-queue) — 만들고 안 연결한 또 하나였어요.

### 1. 그냥 붙이면 되는 게 아니었다

컬럼에 `@Convert`만 붙이면 될 줄 알았는데, 필드마다 **접근 패턴**이 달라서 그게 안 됐어요.

**계좌번호**는 쉬웠어요. 값으로 조회할 일이 없거든요(주문번호로 가상계좌를 찾지, 계좌번호로 찾지 않아요). 그냥 암호화하면 끝.

```java
@Convert(converter = EncryptedStringConverter.class)
@Column(length = 255)   // 암호문이 길어서 확장
private String accountNumber;
```

문제는 **빌링키**였어요. 코드를 보니 —

```java
Optional<BillingKey> findByBillingKey(String billingKey);   // 값으로 조회
@Column(nullable = false, unique = true, length = 200)      // 유니크
private String billingKey;
```

빌링키는 **유니크**이고, **값으로 조회**돼요. 여기에 암호화를 붙이면 —

> envelope 암호화는 **매번 새 DEK와 IV**를 써요([그래서 안전하죠](/blog/project/pay/pay-ch6-security-queue) — 같은 값도 매번 다른 암호문). 그런데 그게 바로 문제예요. **같은 빌링키가 저장할 때마다 다른 암호문**이 되니, (1) `WHERE billing_key = '암호화된값'` 조회가 절대 안 맞고, (2) 유니크 제약이 무의미해져요(다른 암호문이라 절대 충돌 안 함). 보안을 위한 암호화가 **조회와 유니크를 깨뜨리는** 거예요.

암호화하면 못 찾고, 못 찾으면 결제를 못 해요. 이 딜레마가 결제 시스템에서 민감 필드를 다룰 때 항상 나오는 벽이에요.

### 2. 블라인드 인덱스가 존재하는 이유

해법은 **결정적 인덱스를 따로 두는** 거예요. 암호문은 못 하는 걸(같은 입력=같은 값) 대신 해주는 컬럼이죠.

```
billing_key         env:v1:...    ← envelope 암호문 (비결정적, 안전)
billing_key_index   a3f9c2...     ← HMAC-SHA256 (결정적, 유니크·조회용)
```

**블라인드 인덱스**는 빌링키를 secret으로 HMAC 해싱한 값이에요. 같은 빌링키는 **항상 같은 인덱스**가 나와요. 그래서 —

- **유니크**를 인덱스 컬럼으로 옮겨요(같은 빌링키 → 같은 인덱스 → 충돌 감지).
- **조회**를 인덱스로 해요: `findByBillingKey(raw)` → `raw`를 해싱 → `findByBillingKeyIndex(hash)`.

```java
public Optional<BillingKey> findByBillingKey(String raw) {
    return repository.findByBillingKeyIndex(indexer.index(raw));   // 원문을 해싱해 조회
}
```

빌링키 자체는 여전히 암호문으로 잠겨 있고(유출돼도 못 읽음), 조회·유니크는 인덱스가 대신해요. **HMAC은 일방향**이라 인덱스만 봐선 빌링키를 역산 못 하고, secret이 없으면 인덱스를 만들 수도 없어요. 이게 [블라인드 인덱스 클래스](/blog/project/pay/pay-ch2-payment-methods)를 애초에 만든 이유였는데 — 이번에 **실제로 쓰면서** 왜 필요한지 몸으로 알았어요.

정리하면 필드마다 전략이 달라요.

| 필드 | 조회? | 전략 |
|---|---|---|
| 계좌번호 | ✗ | 단순 암호화 |
| 구독의 빌링키 참조 | ✗ (userId로 조회) | 단순 암호화 |
| **빌링키(원본)** | ✓ 유니크·값 조회 | **암호화 + 블라인드 인덱스** |

### 3. 이미 있던 평문은 어쩌나

마지막 현실 문제 — 마이그레이션 전에 저장된 **평문 행**들이요. 그걸 복호화하려 하면 `env:` 형식이 아니라 예외가 나요.

그래서 하위호환 한 줄을 넣었어요.

```java
public String decrypt(String ciphertext) {
    if (!ciphertext.startsWith("env:")) return ciphertext;   // 레거시 평문 → 그대로
    ... // env: 형식만 복호화
}
```

`env:`로 시작 안 하면 "이건 마이그레이션 전 평문이구나" 하고 그대로 돌려줘요. 새로 저장되는 값은 항상 암호화되고, 옛 평문은 읽기만 되고요. 이렇게 하면 **점진적 마이그레이션**이 가능해요 — 한 번에 다 재암호화하지 않고, 읽을 때/쓸 때 자연스럽게 넘어가죠.

### 마치며

이번 건 "만든 걸 실제로 쓰는" 이 시리즈 후반의 패턴이 또 반복된 편이에요. 하지만 붙이는 과정에서 만난 **조회되는 비밀 필드의 딜레마**가 진짜 배움이었어요.

암호화는 "잠그면 끝"이 아니에요. 잠근 걸 여전히 **찾고, 유니크를 지키고, 결제에 써야** 하죠. 그 요구를 암호문 하나로는 못 채우니, 블라인드 인덱스라는 짝을 두는 거예요. 보안 인프라를 만드는 것과, 그걸 **실제 도메인의 조회·제약과 함께** 쓰는 것은 다른 난이도라는 걸 — 금고를 채우면서야 알았어요.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, V10 마이그레이션(컬럼 확장·유니크 이전)은 실 MySQL validate로 검증했습니다.*

<hr />

## 재시작하면 블랙리스트가 사라진다 — 보안 상태의 수명, 그리고 README의 거짓말

*결제 시스템 시리즈. 개선기 — 보안 갭을 마감하다.*

### 0. 감사가 짚은 넷

[전수 감사](/blog/project/pay/pay-ch7-consume-align-harden)의 보안 관련 항목 넷을 이번에 마감했어요. 각각 성격이 다른데, 관통하는 주제가 있었어요 — **보안 상태의 수명**과 **문서의 진실성**.

### 1. 조용한 기본값 — 웹훅 시크릿

[웹훅 서명 검증](/blog/project/pay/pay-ch1-payment-core)은 HMAC 시크릿으로 "이 웹훅이 진짜 PG가 보낸 것인지"를 확인해요. 그런데 그 시크릿이 이렇게 주입되고 있었어요.

```java
@Value("${payment.webhook.secret:test-webhook-secret}")   // ← 기본값
```

`test-webhook-secret`이라는 **약한 기본값을 조용히** 쓰고 있던 거예요. 운영에서 환경변수를 깜빡 안 넣으면? 앱은 아무 경고 없이 뜨고, **공개된 문자열로 서명을 검증**해요. 그럼 공격자가 그 문자열로 서명을 위조해 가짜 웹훅을 보낼 수 있죠.

이상한 건, [JWT 키는 이미 fail-fast](/blog/project/pay/pay-ch3-perf-cancel)였다는 거예요(미설정이면 기동 실패). 웹훅만 빠져 있었죠. 일관성을 맞췄어요.

```java
public WebhookSignatureVerifier(@Value("${payment.webhook.secret}") String secret) {
    // 미설정·약한 키면 기동 거부 — JWT 키와 같은 결
}
```

실기동으로 확인했어요 — 빈 시크릿으로 띄우니 앱이 **뜨지 않아요.**

```
Caused by: IllegalStateException: payment.webhook.secret 미설정 — 웹훅 서명 시크릿을 환경변수/시크릿으로 주입해야 합니다.
```

"조용히 약한 값으로 도는 것"보다 "**시끄럽게 죽는 것**"이 보안에선 나아요. 잘못된 설정으로 프로덕션이 뜨는 걸, 배포 시점에 막는 거예요.

### 2. 재시작하면 사라지는 블랙리스트

[FDS 사후 심사](/blog/project/pay/pay-ch5-runtime-truths)에서, 사기로 판정된 카드를 **블랙리스트**에 넣어 이후 결제를 차단하게 만들었어요. 그런데 그 블랙리스트가 이랬어요.

```java
private final Set<String> cardBlacklist = ConcurrentHashMap.newKeySet();   // in-memory
```

**메모리에만** 있었어요. 즉 —

> 앱을 재시작하면(배포, 장애 복구) **블랙리스트가 통째로 사라져요.** 어제 사기로 차단한 카드가, 오늘 배포 후엔 다시 통과해요. 보안 상태가 프로세스 수명만큼만 사는 거죠. 결제 차단 같은 건 프로세스보다 오래 살아야 하는데요.

여기서 판단이 하나 있었어요 — 블랙리스트를 어디에 저장하나? 새 테이블을 만들 수도 있지만, **진실 원천은 이미 DB에 있었어요.** 사기로 거부한 심사 리뷰(`REJECTED`)가 `fraud_reviews`에 남아 있거든요.

> 그래서 별도 저장소 대신, **기동 시 REJECTED 리뷰에서 블랙리스트를 재구축**하기로 했어요. 인메모리 Set은 "캐시"로 두고, 진실 원천은 DB의 심사 이력으로요.

```java
@EventListener(ApplicationReadyEvent.class)
void reload() {
    fraudReviewRepository.findByStatus(REJECTED)
        .forEach(r -> fraudService.blacklistCard(r.getCardKey()));   // 기동 시 재적재
}
```

이제 재시작해도 어제 차단한 카드는 그대로 막혀요. "상태를 어디에 두느냐"보다 "**진실 원천이 무엇이냐**"를 먼저 물으니, 새 테이블 없이 깔끔하게 풀렸어요.

### 3. 한 프로세스만 세는 velocity

[FDS velocity 룰](/blog/project/pay/pay-ch2-payment-methods)은 "1분에 카드로 몇 번 시도했나"를 세서 이상 패턴을 잡아요. 그런데 그 카운터가 **인메모리**였어요.

> 서버가 여러 대면(실서비스는 당연히), 각 인스턴스가 **자기가 받은 요청만** 세요. 공격자가 1분에 100번을 쳐도, 10대에 분산되면 각각 10번밖에 못 봐서 velocity 룰이 **안 걸려요.** 인메모리 카운터는 다중 인스턴스에서 사실상 무력한 거죠.

이건 [rate limiter](/blog/project/pay/pay-ch6-security-queue)나 [토큰 저장소](/blog/project/pay/pay-ch6-security-queue)와 정확히 같은 문제였고, 해법도 같았어요 — **Redis 공유 카운터.**

```java
// velocity:{cardKey}:{분} 을 모든 인스턴스가 공유해 INCR
Long n = redis.opsForValue().increment("velocity:" + key + ":" + epochMinute);
```

기존 인메모리 구현은 폴백·테스트용으로 남기고, Redis 구현을 기본으로 두되(`@Primary`), Redis가 죽으면 **fail-open**(velocity 통과 + 경고)했어요. 사기 탐지는 보조 방어층이라, 그 층의 Redis 장애가 결제 전면 중단으로 번지면 안 되니까요.

실기동으로 결제를 일으키니, Redis에 velocity 키가 실제로 찍혔어요.

```
velocity:card:pk-98E5E60F...:29723098
```

이제 여러 대가 하나의 카운터를 공유해요.

### 4. README가 거짓말을 하고 있었다

마지막은 코드가 아니라 **문서**였어요. 감사가 이걸 짚었어요.

> README는 "MySQL + JPA + **QueryDSL**", "settlement — **Spring Batch** 정산"이라 명시하나, `build.gradle`에 둘 다 **의존조차 없다.**

쓰지도 않는 기술을 쓴다고 적어놨던 거예요. 아마 초기 계획엔 있었는데 실제론 안 쓰고, 문서만 안 고친 거죠. 이건 사소해 보여도 **정직성 문제**예요 — 코드를 읽는 사람이 문서를 믿을 수 없게 되니까요.

그래서 정직하게 고쳤어요. QueryDSL은 삭제하고, 정산은 "일 단위 배치 집계(서비스 루프; 대용량은 Spring Batch로 확장 여지)"로 사실화했어요. 그리고 README에 **"가정과 한계"** 절을 새로 뒀어요 — 데모 사용자(인메모리), 단일 통화(KRW), 로컬 기본 시크릿(운영은 env 필수), 멀티 PG 미배선 같은 걸 **숨기지 않고** 적었어요.

> "이건 이렇게 가정했고, 여기까진 안 했다"를 적는 게, "다 완벽하다"고 적는 것보다 훨씬 믿음직해요. 특히 결제처럼 신뢰가 생명인 도메인에선요.

### 마치며

이번 건 새 기능이 아니라 **마감**이에요. 그런데 마감이 보여준 게 있어요 — 보안은 "잠그면 끝"이 아니라 **상태가 얼마나 오래, 어디까지 사느냐**의 문제라는 것. 블랙리스트는 재시작을 넘어 살아야 하고, velocity는 인스턴스를 넘어 공유돼야 하고, 시크릿은 조용히 약해지면 안 돼요.

그리고 코드만큼 **문서도 정직해야** 한다는 것. 안 쓰는 걸 쓴다고 적고, 가정을 숨기는 문서는 — 그 자체가 신뢰의 구멍이더라고요.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, 웹훅 fail-fast·블랙리스트 재적재·Redis velocity를 실기동으로 검증했습니다.*

<hr />

## 배포하는 순간 결제가 끊기면 안 된다 — 운영성 마감 네 가지

*결제 시스템 시리즈. 개선기 — 운영성을 마감하다.*

### 0. 기능 말고, 운영성

[감사](/blog/project/pay/pay-ch7-consume-align-harden)가 짚은 것 중 "기능이라기보단 **운영성**"인 항목 넷을 마감했어요. 화려하진 않지만, 실서비스가 **실제로 돌아가려면** 반드시 있어야 하는 것들이에요.

### 1. 배포하는 순간 결제가 끊기면 안 된다

제일 중요했던 건 **graceful shutdown**이었어요. 이게 없으면 —

> 배포할 때(또는 재시작할 때) 컨테이너가 SIGTERM을 받으면, 앱이 **즉시** 종료돼요. 그 순간 처리 중이던 결제 승인 요청이 **강제로 끊겨요.** PG엔 승인 요청이 갔는데 우리 응답은 중단된, [정확히 UNKNOWN을 유발하는](/blog/project/pay/pay-ch1-payment-core) 상황이죠. 배포할 때마다 미확정 결제가 생기는 거예요.

설정 두 줄로 막았어요.

```yaml
server:
  shutdown: graceful
spring:
  lifecycle:
    timeout-per-shutdown-phase: 20s
```

이제 SIGTERM이 오면 **새 요청은 안 받되, 진행 중인 요청은 완료까지 기다려요**(최대 20초). 실기동으로 확인했어요.

```
Commencing graceful shutdown. Waiting for active requests to complete
Graceful shutdown complete
```

진행 중 결제가 끝난 뒤에야 종료돼요. 배포가 결제를 끊지 않아요. (쿠버네티스라면 로드밸런서 드레이닝을 위한 preStop 지연도 필요하지만, 여기선 단일 프로세스라 설정만으로 충분해요.)

### 2. "전부 다 주세요"가 되던 어드민

[어드민 조회](/blog/project/pay/pay-ch4-arch-events-ops) 6종(DLQ·보상·대사·미확정·강제취소·FDS 심사)이 전부 **전건 List**였어요. 감사가 "코드 전체에 `Pageable`이 하나도 없다"고 짚었죠.

> 데모에선 데이터가 몇 건이라 괜찮아 보이지만, 운영에서 DLQ가 수만 건 쌓이면 `findAll()`이 **전부를 메모리에 로딩**해요. 어드민 화면 한 번 여는 게 DB와 힙을 때리는 거죠.

6종 전부 페이지네이션으로 바꿨어요. 좋았던 건 **뷰 매핑을 그대로 유지**할 수 있었다는 거예요.

```java
// 기존: repo.findByStatus(status).stream().map(뷰변환).toList()
// 변경: repo.findByStatus(status, pageable).map(뷰변환)
```

`Page.map`이 `List.stream().map`과 똑같이 동작해서, [엔티티 대신 뷰 record로 노출하는 원칙](/blog/project/pay/pay-ch4-arch-events-ops)은 그대로 두고 컨테이너만 List→Page로 바꿨어요. 응답도 `[...]`에서 `{content:[...], totalElements, ...}`로 자연스럽게 바뀌고요.

### 3. CI가 빌드하지 않던 앱

[Kafka 소비자 앱](/blog/project/pay/pay-ch7-consume-align-harden)을 **독립 Gradle 프로젝트**로 만들었잖아요. 그게 장점이자 함정이었어요.

> 독립 프로젝트라 루트 빌드가 존재조차 몰라요 — 그래서 [CI](/blog/project/pay/pay-ch4-arch-events-ops)가 소비자 앱을 **빌드도 테스트도 안 했어요.** 소비자 앱이 깨져도 CI는 초록불이었죠. "분리"의 대가로 "검증 사각지대"가 생긴 거예요.

CI에 한 스텝을 추가했어요.

```yaml
- name: Build consumer-app (독립 프로젝트)
  run: ./gradlew -p consumer-app build --console=plain
```

이제 소비자 앱도 매 push마다 빌드·테스트돼요. 분리하되, 검증에선 빠뜨리지 않는 거죠.

### 4. 부하테스트가 자기 방어에 걸렸다

마지막은 자기모순이었어요. [폭주 제어](/blog/project/pay/pay-ch6-security-queue)에서 rate limiter를 기본 on으로 켰는데, 정작 [성능 측정용 부하테스트](/blog/project/pay/pay-ch3-perf-cancel)(`checkout-load.js`)는 **단일 데모 유저**로 돌아요.

> 단일 유저가 초당 수십 번을 치니, per-user 5/s 제한에 **자기가 걸려서** 대량 429가 나요. 성능을 재려는 테스트가 자기 방어 장치에 막혀 측정이 왜곡되는 거죠.

이건 스크립트를 고치기보단 **문서로 정합**시켰어요 — checkout-load는 성능 측정용이니 `APP_RATELIMIT_ENABLED=false`로 돌리고, spike-test는 반대로 rate limit을 켜서 [shed를 측정](/blog/project/pay/pay-ch6-security-queue)한다고요. 두 테스트의 목적이 다르니 실행 방식도 다른 걸 명시했어요.

### 마치며

이번 편은 새 기능이 하나도 없어요. 배포가 결제를 안 끊게, 어드민이 힙을 안 태우게, CI가 사각지대를 안 남기게, 테스트가 자기모순에 안 빠지게 — **"실제로 운영 가능하게"** 만드는 마감들이었죠.

기능을 만드는 것과 그게 **운영에서 버티게** 하는 것은 다른 일이에요. graceful shutdown 두 줄, 페이지네이션 한 파라미터 — 작지만 이런 게 없으면 첫 배포·첫 트래픽에서 바로 티가 나요. 결제 시스템의 완성도는 화려한 기능이 아니라, 이런 **운영성의 마감**에서 갈리더라고요.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, graceful shutdown 드레이닝과 어드민 페이지네이션을 실기동으로 검증했습니다.*

<hr />

## CPU 말고 "미확정 결제 나이"를 본다 — 결제 SLO를 대시보드와 알림으로, 그리고 스크레이프를 막은 시큐리티

*결제 시스템 시리즈. 개선기 — 관측성을 실전화하다.*

### 0. JSON은 있는데, 그걸 볼 스택이 없었다

[전수 감사](/blog/project/pay/pay-ch7-consume-align-harden)가 이 시리즈 후반에 반복해서 짚은 패턴이 있어요 — **"만들어는 놨는데 실제로 연결은 안 했다."** [암호화 금고를 만들고 안 넣었고](/blog/project/pay/pay-ch7-consume-align-harden), [배치 로직을 짜고 스케줄러를 안 달았죠](/blog/project/pay/pay-ch7-consume-align-harden). 관측성도 똑같았어요.

`monitoring/dashboard.json`은 있었어요. 근데 —

> **그라파나가 없어요.** 프로메테우스도 없고, 둘을 compose에 배선한 것도, 대시보드를 자동 로드하는 프로비저닝도, 알림 룰도 없었어요. dashboard.json은 "언젠가 그라파나에 수동 임포트하면 되는" 죽은 파일이었죠. 관측성이라기보단 관측성의 **스크린샷**이었어요.

이번엔 이걸 진짜로 돌아가게 만들었어요. 그런데 배선하는 과정에서, "결제 시스템의 관측성이란 뭘 봐야 하나"라는 질문과 "실기동해야만 보이는 벽" 둘 다를 만났어요.

### 1. CPU가 아니라 "결제가 건강한가"를 본다

관측성의 기본은 CPU·메모리·힙 같은 시스템 메트릭이에요. 그건 Micrometer가 공짜로 줘요. 하지만 그것만으론 "이 **결제 시스템**이 건강한가"를 답 못 해요. CPU가 20%여도 결제는 다 실패하고 있을 수 있거든요.

그래서 이 도메인만의 SLO 지표를 게이지 두 개로 만들었어요.

```java
// payment.unknown.oldest.age — 가장 오래된 UNKNOWN(미확정) 결제의 나이(초)
Gauge.builder("payment.unknown.oldest.age", this, PaymentSloMetrics::unknownOldestAgeSeconds)
        .baseUnit("seconds")
        .register(meterRegistry);
```

이게 왜 중요하냐면 — [PG 타임아웃은 결과를 모르는 UNKNOWN으로 보존](/blog/project/pay/pay-ch1-payment-core)하고, [복구 배치가 나중에 조회로 확정](/blog/project/pay/pay-ch7-consume-align-harden)한다고 했잖아요. 그럼 **"UNKNOWN이 몇 건이냐"보다 "가장 오래된 UNKNOWN이 얼마나 오래 미확정이냐"가 진짜 신호**예요. 복구 배치가 밀리거나 망취소가 안 돌면 이 값이 계속 커지거든요. 10분 넘게 미확정인 결제가 있다? 그건 고객 돈이 붕 뜬 채로 방치되고 있다는 뜻이에요.

두 번째는 대사예요.

```java
// recon.pending.count — 사람 확인이 필요한 PENDING 대사 건수
Gauge.builder("recon.pending.count", this, m -> repository.countByStatus(ReconStatus.PENDING))
        .register(meterRegistry);
```

[대사는 최종 방어선](/blog/project/pay/pay-ch6-security-queue)이라, 내부 장부와 PG 파일이 안 맞는 PENDING 예외가 쌓인다는 건 "누군가 봐야 할 불일치가 적체되고 있다"는 신호죠.

게이지 supplier는 스크레이프마다(15초) 단일 집계 쿼리만 돌아요 — `min(requestedAt)` 하나, `count` 하나. 가벼워요.

![Grafana 결제 SLO 대시보드 — 성공률·TPS·미확정 나이·대사 적체·결과별 rate·p95/p99·HikariCP](/uploads/project/pay/demo/demo-grafana-dashboard.png)

성공률 100%, 처리량 1.24 req/s, 미확정 0초, 대사 0건. **결제 언어로** 시스템 상태를 한눈에 보는 거예요.

### 2. 알림은 코드다

대시보드는 사람이 봐야 알아요. 근데 새벽 3시엔 아무도 안 보죠. 그래서 같은 지표를 **알림 룰**로도 코드화했어요(`monitoring/alert-rules.yml`). 결제 SLO 5개예요.

| 알림 | 조건 | 심각도 |
|---|---|---|
| PaymentSuccessRateLow | 5분 결제 성공률 < 95% | critical |
| CompensationExhausted | [보상 재시도 소진](/blog/project/pay/pay-ch3-perf-cancel) > 0 | critical |
| UnknownPaymentAging | 미확정 결제 나이 > 10분 | critical |
| DeadlockRetrySpike | [데드락 재시도](/blog/project/pay/pay-ch6-security-queue) > 10회/분 | warning |
| ReconPendingBacklog | 대사 PENDING > 0 (15분+) | warning |

![Prometheus 결제 SLO 알림 룰 5종 — 모두 inactive](/uploads/project/pay/demo/demo-prometheus-alerts.png)

지금은 5개 모두 **inactive**예요. 시스템이 건강하니까요. 알림은 "아무 일 없을 땐 조용하고, 조건이 맞으면 운다" — 이 상태가 정상이에요.

여기서 성공률 알림에 미묘한 게 하나 있었어요.

> 성공률 = `성공/전체`인데, 트래픽이 아예 없으면 분모가 0이라 `0/0 = NaN`이 돼요. 그럼 `< 0.95` 비교가 참일까요? 아니에요 — 프로메테우스는 NaN을 비교에서 빼서 **발화하지 않아요.** 덕분에 새벽에 트래픽이 0일 때 "성공률 0%!" 오탐이 안 떠요. 이걸 몰랐으면 `or vector(1)` 같은 방어를 넣었을 텐데, 산술 자체가 알아서 해결해줬죠.

### 3. 진짜 배움 — 실기동하니 스크레이프가 401이었다

여기까지는 코드예요. compose도 파싱되고, 테스트도 통과하고, 대시보드 JSON도 유효해요. 근데 **실제로 띄워보니** 프로메테우스가 아무것도 못 긁고 있었어요.

```
GET /actuator/prometheus  →  401 Unauthorized
WWW-Authenticate: Bearer
```

[시큐리티](/blog/project/pay/pay-ch3-perf-cancel)가 `/actuator/**`를 ADMIN 뒤에 두고 있었거든요. 근데 프로메테우스 수집기는 JWT를 들고 다니지 않아요 — 그냥 15초마다 익명으로 GET 할 뿐이죠. 그러니 **전부 401.** 대시보드는 텅 비고요.

이게 이번 편의 진짜 배움이었어요.

> compose가 파싱되고 테스트가 초록불이라고 "관측성이 된다"가 아니에요. **"프로메테우스 → 시큐리티 필터체인 → /actuator/prometheus"라는 런타임 경로**가 실제로 뚫려야 되는 거예요. HTTP 200 하나를 보는 게 아니라, [실기동해서](/blog/project/pay/pay-ch5-runtime-truths) 스크레이프가 진짜 긁히는지를 봐야 알아요.

고친 건 최소 개방이에요 — `/actuator/prometheus`만 열고(수집기가 인증 없이 긁어야 하니), 나머지 actuator(env·heapdump 같은 정찰 소지)는 계속 ADMIN으로 잠갔어요.

```java
.requestMatchers("/actuator/health", "/actuator/info", "/actuator/prometheus").permitAll()
.requestMatchers("/actuator/**").hasRole("ADMIN")
```

운영에선 `management.server.port`를 내부망 전용 포트로 분리해서 스크레이프하는 게 정석이에요. 여기선 로컬 프로메테우스를 위해 이 엔드포인트만 열되, [그 가정을 README에 적었어요](/blog/project/pay/pay-ch7-consume-align-harden) — 숨기지 않고요.

### 4. p99가 No data였다

스크레이프가 뚫린 뒤에도 "요청 p99 레이턴시" 패널만 **No data**였어요. 이유가 재밌어요.

> p99는 `histogram_quantile(0.99, ...http_server_requests_seconds_bucket...)`로 구해요. **버킷**이 있어야 분위수를 내죠. 근데 Micrometer는 기본적으로 HTTP 요청에 **히스토그램 버킷을 안 만들어요** — `_count`, `_sum`, `_max`만 내요. 그래서 `_bucket` 계열이 없어서 쿼리가 통째로 비었던 거예요.
> 평균(`sum/count`)은 낼 수 있어도 p99는 못 내요. 평균은 "느린 1%"를 숨기니까, 결제엔 p99가 훨씬 중요한데 말이죠.

설정 한 줄로 버킷을 켰어요.

```yaml
management:
  metrics:
    distribution:
      percentiles-histogram:
        http.server.requests: true
```

이제 프로메테우스가 버킷을 받아 서버측에서 p95/p99를 집계해요. 대시보드에 p99 ≈ 60ms 곡선이 떠요.

### 마치며

이번 편도 "만든 걸 실제로 쓰다"의 반복이에요. dashboard.json이라는 껍데기에 프로메테우스·그라파나·알림·게이지를 붙여 살아 움직이게 했죠.

근데 두 가지가 남아요. 하나는 **결제 관측성은 CPU가 아니라 도메인 언어여야** 한다는 것 — "미확정 결제가 얼마나 오래 방치됐나", "대사가 몇 건 밀렸나"처럼, 그 시스템이 정말 걱정해야 할 걸 봐야 해요. 다른 하나는 **관측성도 실기동으로만 검증된다**는 것. 스크레이프를 막은 시큐리티도, 버킷이 없어 빈 p99도, 코드를 아무리 읽어도 안 보였어요. 띄워서 프로메테우스가 진짜 긁는 걸 보고서야 알았죠.

대시보드는 코드예요. 그리고 코드가 그렇듯, **돌려봐야** 진짜 도는지 알아요.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, Prometheus/Grafana 스택을 compose로 실기동해 스크레이프·게이지·알림 룰·p99 집계를 모두 실측·캡처했습니다.*

---
title: '테스트에서만 살아 있던 failover — 만들어둔 멀티 PG 라우팅을 배선하다, 그리고 TIMEOUT엔 절대 failover하지 않는 이유'
titleEn: 'Failover That Only Lived in Tests — Wiring the Multi-PG Router I Built, and Why You Never Fail Over on TIMEOUT'
description: 결제 시스템 개선기. 멀티 PG failover 라우터를 잘 만들어놓고 어디에도 배선하지 않았다 — 테스트에서만 살아 있었다. 배선하려니 진짜 문제는 @Primary 충돌이었다. ResilientPgClient가 이미 @Primary라, 라우터를 또 @Primary로 두면 주입이 깨진다. qualifier seam에 끼워 두 계층으로 합성했다. 그리고 이 라우터의 핵심은 "아무 때나 failover하지 않는다"는 것 — 특히 TIMEOUT(미확정)엔 절대 다른 PG로 넘기지 않는다. 넘기면 이중결제가 나니까.
descriptionEn: "Payment system improvement log. I built a multi-PG failover router well, then wired it nowhere — it only lived in tests. Wiring it, the real problem was an @Primary clash. ResilientPgClient was already @Primary, so making the router @Primary too breaks injection. I slotted it into the qualifier seam, composing two layers. And the router's core rule is that it does not fail over on just anything — especially not on TIMEOUT, because that would double-charge."
date: 2027-02-06T00:00:00.000Z
tags:
  - Payment
  - Resilience
  - PG
  - Spring
  - Circuit Breaker
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 46
---

*결제 시스템 시리즈. 개선기 — 만들어둔 failover를 실제로 배선하다.*

## 0. 또 하나의 "만들고 안 쓴 것"

[전수 감사](/blog/project/pay/pay-39-settlement-escrow-alignment)가 짚은 패턴 — [금고를 만들고 안 채웠고](/blog/project/pay/pay-41-encryption-applied), [배치를 만들고 안 불렀던](/blog/project/pay/pay-40-schedulers) 그 패턴이 PG에도 있었어요.

`RoutingPgClient` — 여러 PG를 가중치 순으로 시도하고 장애 시 다음 PG로 넘기는(failover) 라우터를 꽤 정성껏 만들어놨어요. 서킷브레이커도 PG별로 붙이고, 단위 테스트도 촘촘했죠. 그런데 —

> `grep`해보니 이 라우터를 참조하는 건 **자기 테스트뿐**이었어요. 어느 `@Configuration`에서도 빈으로 등록되지 않았고, 실제 결제는 여전히 단일 PG(`ResilientPgClient`가 감싼 하나)로만 흘렀어요. failover 로직이 **테스트에서만 살아 있던** 거예요.

이번에 배선했어요. 그런데 "빈으로 등록만 하면 되겠지"가 아니었어요.

## 1. 진짜 문제는 @Primary였다

결제는 `PgClient` 인터페이스로 PG를 부르고, 그 구현으로 `ResilientPgClient`가 `@Primary`로 주입돼요(서킷브레이커·재시도를 입힌 데코레이터). 여기에 라우터를 넣으려니 —

> `RoutingPgClient`를 또 `@Primary`로 두면? **`@Primary`가 둘**이 되어 "어느 걸 주입할지" 스프링이 못 정해요. 그렇다고 `ResilientPgClient`의 `@Primary`를 떼면, 그게 주던 재시도·외곽 서킷을 잃죠.

핵심은 이미 있던 **seam**을 본 거예요. `ResilientPgClient`는 자기가 감쌀 대상을 이렇게 주입받고 있었어요.

```java
public ResilientPgClient(@Qualifier("pgDelegate") PgClient delegate) { ... }
```

`pgDelegate`라는 이름표(qualifier)가 붙은 PG를 감싸요. 원래는 `FakePgClient`(개발)나 `TossPgClient`(운영)가 프로파일로 그 자리에 들어갔죠. **그럼 라우터를 바로 그 `pgDelegate` 자리에 끼우면 되는 거예요.**

```java
@Configuration
@ConditionalOnProperty(name = "app.pg.routing.enabled", havingValue = "true")
class PgRoutingConfig {
    @Bean @Qualifier("pgDelegate")
    PgClient routingPgDelegate() {
        return new RoutingPgClient(List.of(
            PgRoute.of("primary-fake",   new FakePgClient(), 10),
            PgRoute.of("secondary-fake", new FakePgClient(), 5)));
    }
}
```

그러면 계층이 자연스럽게 합성돼요.

```
PaymentService → ResilientPgClient(@Primary, 외곽 서킷·query 재시도)
              → RoutingPgClient(pgDelegate, PG별 서킷·failover)
              → [primary PG, secondary PG]
```

`@Primary`는 `ResilientPgClient` 하나로 그대로 두고, 그 아래 `pgDelegate`만 "단일 PG → 라우터"로 바뀌는 거죠. 데코레이터 패턴이 이래서 좋아요 — 바깥 껍질은 안쪽이 하나든 라우터든 몰라요.

## 2. qualifier가 둘이 되는 함정

한 가지 걸린 게 있었어요. `FakePgClient`는 **항상** `@Qualifier("pgDelegate")`였거든요. 라우터도 `pgDelegate`로 등록하면 **같은 이름표가 둘**이 되어 다시 주입이 모호해져요.

> 그래서 `FakePgClient`의 `pgDelegate` 역할을 **라우팅이 꺼졌을 때만**으로 조건화했어요. `@ConditionalOnProperty(name="app.pg.routing.enabled", havingValue="false", matchIfMissing=true)` — 라우팅을 켜면 이 빈은 아예 등록되지 않고, 라우터가 유일한 `pgDelegate`가 돼요. 라우터 내부 경로는 자체 `new FakePgClient()`로 만들고요.

토글 하나로 `FakePgClient`의 등록과 `PgRoutingConfig`의 등록이 **함께** 뒤집혀요 — 정확히 하나만 `pgDelegate`가 되도록.

실기동으로 확인했어요.

```
APP_PG_ROUTING_ENABLED=true ./gradlew bootRun
→ PgRoutingConfig : 멀티 PG 라우팅 활성화 — 경로 2개 (가중치 순 시도, 장애 시 failover)
→ 결제 승인 → order PAID / payment DONE   (라우터의 primary 경로로 승인)
```

## 3. 이 라우터의 진짜 값어치 — 아무 때나 failover하지 않는다

failover의 어려운 부분은 "언제 넘길까"가 아니라 **"언제 넘기면 안 되나"**예요. `RoutingPgClient`가 결과를 이렇게 나눠요.

| PG 응답 | failover? | 이유 |
|---|---|---|
| SUCCESS | ✗ | 성공 — 끝 |
| FAILED(카드 거절) | ✗ | 다른 PG도 거절할 것 |
| **TIMEOUT(미확정)** | **✗ 절대** | **다른 PG로 재시도 = 이중결제 위험** |
| 예외·서킷 오픈 | ✓ | PG가 요청을 못 받음 → 다음 PG |

제일 중요한 게 세 번째예요.

> [PG 타임아웃은 "결과를 모른다"는 뜻](/blog/project/pay/pay-2-designing-for-failure)이에요 — 원 PG에서 이미 승인됐을 수도 있어요. 이때 "실패했나 보다" 하고 다른 PG로 넘겨 재승인하면? **두 PG에서 이중으로 결제**돼요. 그래서 TIMEOUT은 failover하지 않고 그대로 UNKNOWN으로 돌려, [복구 배치가 나중에 조회로 확정](/blog/project/pay/pay-40-schedulers)하게 맡겨요. failover는 "PG가 요청을 **못 받았을 때**"(연결 실패·서킷 오픈)만 하는 거예요.

failover를 "실패하면 다음으로"라고 단순하게 짜면 바로 이 이중결제 함정에 빠져요. 결제에서 재시도·failover는 항상 **멱등성과 이중청구**를 먼저 물어야 해요.

## 4. 남겨둔 한계 — 원 PG 라우팅

정직하게 하나 남겼어요. 취소·조회는 원래 결제를 처리한 **그 PG**로 가야 맞아요(A PG로 승인했으면 A PG로 취소). `Payment.pgProvider`에 어느 PG였는지 기록은 돼 있는데, 정작 `PgClient.cancel(paymentKey, ...)` 인터페이스가 provider를 안 받아요. 그래서 지금은 "가용한 첫 PG"로 시도해요.

> 제대로 하려면 인터페이스에 provider 힌트를 넣어 라우터가 원 PG로 보내야 하는데, 이건 인터페이스를 건드리는 일이라 [후속 과제로 명시](/blog/project/pay/pay-42-security-hardening)했어요. "여기까진 했고 여기부턴 안 했다"를 적는 게, 안 한 걸 숨기는 것보다 나으니까요.

## 마치며

이번 건도 새 로직이 아니라 **배선**이에요. 잘 만들어둔 failover 라우터가 테스트에서만 살아 있었고, 그걸 실제 결제 경로에 끼웠죠. 배우는 건 두 가지였어요 — **`@Primary`와 qualifier로 이미 있는 seam에 데코레이터를 겹쳐 끼우는 법**, 그리고 **failover조차 결제에선 "이중결제 안 나게" 조심스럽게 해야 한다**는 것.

만드는 것과 **실제 흐름에 배선하는 것**은 다르다 — 이 시리즈가 계속 반복하는 교훈의, PG 버전이었어요.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, `app.pg.routing.enabled=true`로 라우터가 pgDelegate로 배선되어 결제가 라우팅 경로로 승인되는 것을 실기동으로 확인했습니다.*

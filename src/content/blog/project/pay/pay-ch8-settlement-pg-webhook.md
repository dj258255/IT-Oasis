---
title: '정산 정확성·멀티PG·웹훅 비동기'
description: '총액의 3%만 떼던 정산에 수수료 부가세·지급예정일을 채우고, 테스트에서만 살아있던 멀티PG failover를 배선, 웹훅을 비동기로 떼고, 집계 키가 승인일이던 정산 버그를 잡다.'
date: 2026-01-18T00:00:00.000Z
tags:
  - Payment
  - Spring Boot
  - Spring Modulith
  - 결제 시스템
category: project/pay
draft: false
series: "결제 시스템 만들기"
seriesOrder: 8
---

*결제 시스템 시리즈 — 정산 정확성·멀티PG·웹훅 비동기. 원 연재 여러 편을 한 챕터로 묶었고, 각 절이 원래 한 편이다.*

## 정산이 "총액의 3%"만 떼고 있었다 — 수수료 부가세·지급예정일, 그리고 또 하나의 죽은 배치

### 0. 정산이 한 줄로 끝나 있었다

정산 수수료 계산이 상수 한 줄로 끝나 있었다. [에스크로에 정렬한 정산](/blog/project/pay/pay-ch7-consume-align-harden)에서 "구매확정된 결제만 집계한다"까지는 맞췄는데, 정작 수수료 쪽을 열어보니 이랬다.

```java
private static final long FEE_PERCENT = 3;
// fee = gross * 3 / 100
```

총액의 **3%**를 떼는 게 전부다. 실무 정산은 여기서 한 겹 더 들어간다.

> PG/가맹점 정산은 **수수료(정률)** 에 그 **수수료의 부가세 10%** 를 더 떼고, 지급이 **언제** 이뤄지는지(**지급예정일**)까지 계산한다. 예를 들어 승인 100,000원이면 수수료 2.7%인 2,700원, 거기에 VAT 270원이 붙어 실지급은 97,030원이다. 그리고 이 돈은 오늘이 아니라 **정산일+2영업일**에 들어온다.

"3%만 떼기"는 이 셋 중 하나만 있는 셈이다. 빠진 둘을 채웠다.

### 1. 돈은 정수로 — 수수료율을 bps로

수수료율은 **basis point(bps)** 정수로 뒀다. 270 bps가 2.7%다. `0.027`(double)로 두고 `gross * 0.027`을 하는 쪽이 편해 보이지만, 이 프로젝트에는 [KRW를 소수점 없는 정수(long)로만 다룬다](/blog/project/pay/pay-ch1-payment-core)는 원칙이 있다. 부동소수를 돈 계산에 끼우면 반올림 오차가 쌓인다.

```java
long fee    = Math.multiplyExact(gross, feeBps) / 10000;  // 정수 나눗셈(floor)
long feeVat = fee / 10;                                    // 수수료의 10%
long net    = gross - fee - feeVat;
```

검산하면 gross=100,000 → fee=2,700 → feeVat=270 → net=**97,030**. 부동소수 없이 떨어진다. 이 검산값은 테스트로 못박아 뒀다(`settleFeeModelExactValues`). 수수료 로직은 한 번 틀어지면 돈이 샌다.

정산 집계의 불변식도 기존 `net = gross - fee`에서 **`net = gross - fee - feeVat`** 로 넓혔다. 마이그레이션에서 레거시 정산은 `feeVat = 0`으로 백필하므로 **옛 불변식이 그대로 성립**하고, net을 다시 계산할 필요도 없었다.

### 2. 지급예정일 = 정산일 + 2영업일

지급예정일은 "정산일 + 2일"이 아니라 "**+2영업일**"이다. 주말엔 정산 지급이 안 되기 때문이다.

```java
// 하루씩 전진하며 토·일을 건너뛰어 N영업일을 센다
LocalDate payoutDate = BusinessDays.plusBusinessDays(settlementDate, 2);
```

금요일 정산이면 +2영업일은 토·일을 건너뛴 **다음 화요일**이다. 여기서 선을 하나 그었다.

> 이 계산은 **주말만** 건너뛰고 **법정공휴일은 반영하지 않는다.** 실제 정산이라면 공휴일 캘린더(설·추석·대체공휴일…)를 붙여야 맞다. 다만 그건 별도 데이터 소스가 필요한 일이라, 여기선 "주말 skip"까지만 하고 **그 한계를 javadoc과 README에 명시**했다. "공휴일도 처리한다"고 적고 안 하는 것보다 "여기까지만 했다"를 적는 쪽이 [정직하다](/blog/project/pay/pay-ch7-consume-align-harden).

### 3. 또 하나의 죽은 배치

여기까지 만들고 "지급 확정"을 붙이려다 이상한 걸 발견했다. **정산을 실제로 만드는 `settle()`을 부르는 코드가 없었다.**

```
$ grep -rn ".settle(" src/
src/test/.../SettlementServiceTest.java:  service.settle(DATE)   ← 테스트뿐
```

[스케줄러 없던 배치들](/blog/project/pay/pay-ch7-consume-align-harden)과 같은 패턴이다. 정산 로직은 완성돼 있는데, 운영에서 그걸 주기적으로 부르는 스케줄러도 수동으로 돌릴 어드민도 없었다. 정산이 영원히 안 만들어지니 "지급 확정"할 대상도 없다.

그래서 배선했다. 기존 [스케줄러 게이트 패턴](/blog/project/pay/pay-ch7-consume-align-harden)(기본 off) 그대로 일 단위 스케줄러를 달고, 어드민에 조회·수동실행·지급확정을 뒀다. 정산 상태에는 `PAID_OUT`을 추가했다.

```java
public void markPaidOut() {
    if (this.status == SettlementStatus.CREATED) {   // 멱등: 이미 PAID_OUT이면 무시
        this.status = SettlementStatus.PAID_OUT;
        this.paidOutAt = Instant.now();
    }
}
```

데모 콘솔에도 정산 패널을 붙여, 승인→구매확정→정산 집계→지급 확정까지 눌러볼 수 있게 했다.

![정산 데모 — 총액 30,000 → 수수료 810 + VAT 81 → 지급액 29,109, 지급예정일 2영업일 뒤](/uploads/project/pay/demo/demo-settlement.png)

총액 30,000이 수수료 810 + VAT 81을 떼고 **29,109**로, 지급예정일은 2영업일 뒤로 찍힌다. `CREATED`를 "지급 확정"하면 `PAID_OUT`이 된다. 실 MySQL로 이 흐름 전체를 검증했다(3건 구매확정 → 집계 → 지급확정 → 항목 SETTLED).

### 4. package-info가 또 거짓말을 했다

마지막은 [README가 QueryDSL·Spring Batch 거짓말을 했던 것](/blog/project/pay/pay-ch7-consume-align-harden)의 잔당이다. 정산 모듈 `package-info`가 이렇게 적혀 있었다.

```java
/** <p>Spring Batch 기반 일 단위 거래 집계 → 수수료 계산 → ... */
```

**Spring Batch를 안 쓰는데** 쓴다고 적혀 있었다(실제론 서비스 루프). README는 앞서 고쳤는데 package-info엔 같은 주장이 남아 있던 것. "서비스 루프 집계, 대용량은 Spring Batch로 확장 여지"로 사실화했다. 문서의 거짓말은 한 군데에서 끝나지 않는다. 같은 주장을 여러 곳에 복붙해뒀다면 전부 찾아 고쳐야 한다.

### 마치며

정산은 "수수료 떼면 끝"이 아니었다. 수수료, 그 수수료의 부가세, 그리고 언제 주느냐가 얽힌 도메인이다. 한 줄로 뭉뚱그렸던 걸 실무 구조로 풀면서 돈은 정수(bps)로 지키고 지급일은 영업일로 셌다. 못 하는 것(공휴일)은 문서에 못 한다고 적었다. 그리고 로직은 다 있는데 부르는 사람이 없는 배치를 여기서 또 만났다. 스케줄러와 어드민을 배선하고 나서야 정산이 실제로 만들어지기 시작했다.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있다. 수수료·부가세·지급예정일·지급확정(PAID_OUT) 전 흐름을 실 MySQL로 검증했다(V11 마이그레이션·검산 100,000→97,030 포함).*

<hr />

## 테스트에서만 살아 있던 failover — 만들어둔 멀티 PG 라우팅을 배선하다, 그리고 TIMEOUT엔 절대 failover하지 않는 이유

### 0. 또 하나의 "만들고 안 쓴 것"

부르는 사람 없는 코드는 정산 배치로 끝나지 않았다. [전수 감사](/blog/project/pay/pay-ch7-consume-align-harden)가 짚은 패턴, [금고를 만들고 안 채우고](/blog/project/pay/pay-ch7-consume-align-harden) [배치를 만들고 안 부르던](/blog/project/pay/pay-ch7-consume-align-harden) 그 패턴이 PG에도 있었다.

`RoutingPgClient`. 여러 PG를 가중치 순으로 시도하고 장애 시 다음 PG로 넘기는(failover) 라우터를 꽤 정성껏 만들어놨다. 서킷브레이커도 PG별로 붙였고 단위 테스트도 촘촘했다. 그런데.

> `grep`해보니 이 라우터를 참조하는 건 **자기 테스트뿐**이었다. 어느 `@Configuration`에서도 빈으로 등록되지 않았고, 실제 결제는 여전히 단일 PG(`ResilientPgClient`가 감싼 하나)로만 흘렀다. failover가 실제 결제 경로엔 없고 **테스트 안에서만 돌고** 있었다.

이번에 배선했다. 다만 "빈으로 등록만 하면 되겠지"로 끝나는 일이 아니었다.

### 1. 진짜 문제는 @Primary였다

결제는 `PgClient` 인터페이스로 PG를 부르고, 그 구현으로 `ResilientPgClient`가 `@Primary`로 주입된다(서킷브레이커·재시도를 입힌 데코레이터). 여기에 라우터를 넣으려니 문제가 걸렸다.

> `RoutingPgClient`를 또 `@Primary`로 두면 **`@Primary`가 둘**이 되어 스프링이 어느 걸 주입할지 못 정한다. 그렇다고 `ResilientPgClient`의 `@Primary`를 떼면 그게 주던 재시도·외곽 서킷을 잃는다.

답은 이미 있던 **seam**에 있었다. `ResilientPgClient`는 자기가 감쌀 대상을 이렇게 주입받고 있었다.

```java
public ResilientPgClient(@Qualifier("pgDelegate") PgClient delegate) { ... }
```

`pgDelegate`라는 이름표(qualifier)가 붙은 PG를 감싼다. 원래는 `FakePgClient`(개발)나 `TossPgClient`(운영)가 프로파일로 그 자리에 들어갔다. 그렇다면 라우터를 바로 그 `pgDelegate` 자리에 끼우면 된다.

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

그러면 계층이 자연스럽게 합성된다.

```
PaymentService → ResilientPgClient(@Primary, 외곽 서킷·query 재시도)
              → RoutingPgClient(pgDelegate, PG별 서킷·failover)
              → [primary PG, secondary PG]
```

`@Primary`는 `ResilientPgClient` 하나로 그대로 두고, 그 아래 `pgDelegate`만 단일 PG에서 라우터로 바뀐다. 데코레이터 패턴의 힘이 여기서 나온다. 바깥 껍질은 안쪽이 하나든 라우터든 모른다.

### 2. qualifier가 둘이 되는 함정

한 가지가 더 걸렸다. `FakePgClient`는 **항상** `@Qualifier("pgDelegate")`였다. 라우터도 `pgDelegate`로 등록하면 **같은 이름표가 둘**이 되어 다시 주입이 모호해진다.

> 그래서 `FakePgClient`의 `pgDelegate` 역할을 **라우팅이 꺼졌을 때만**으로 조건화했다. `@ConditionalOnProperty(name="app.pg.routing.enabled", havingValue="false", matchIfMissing=true)`. 라우팅을 켜면 이 빈은 아예 등록되지 않고 라우터가 유일한 `pgDelegate`가 된다. 라우터 내부 경로는 자체 `new FakePgClient()`로 만든다.

토글 하나로 `FakePgClient`의 등록과 `PgRoutingConfig`의 등록이 **함께** 뒤집힌다. 언제나 하나만 `pgDelegate`가 되는 구조다.

실기동으로 확인했다.

```
APP_PG_ROUTING_ENABLED=true ./gradlew bootRun
→ PgRoutingConfig : 멀티 PG 라우팅 활성화 — 경로 2개 (가중치 순 시도, 장애 시 failover)
→ 결제 승인 → order PAID / payment DONE   (라우터의 primary 경로로 승인)
```

### 3. 이 라우터의 진짜 값어치 — 아무 때나 failover하지 않는다

failover의 어려운 부분은 "언제 넘길까"가 아니라 **"언제 넘기면 안 되나"**다. `RoutingPgClient`는 결과를 이렇게 나눈다.

| PG 응답 | failover | 이유 |
|---|---|---|
| SUCCESS | 안 함 | 성공, 끝 |
| FAILED(카드 거절) | 안 함 | 다른 PG도 거절할 것 |
| **TIMEOUT(미확정)** | **절대 안 함** | **다른 PG로 재시도 = 이중결제 위험** |
| 예외·서킷 오픈 | 함 | PG가 요청을 못 받음 → 다음 PG |

핵심은 세 번째 줄이다.

> [PG 타임아웃은 "결과를 모른다"는 뜻](/blog/project/pay/pay-ch1-payment-core)이다. 원 PG에서 이미 승인됐을 수 있다. 이때 "실패했나 보다" 하고 다른 PG로 넘겨 재승인하면 **두 PG에서 이중으로 결제**된다. 그래서 TIMEOUT은 failover하지 않고 그대로 UNKNOWN으로 돌려, [복구 배치가 나중에 조회로 확정](/blog/project/pay/pay-ch7-consume-align-harden)하게 맡긴다. failover는 "PG가 요청을 **못 받았을 때**"(연결 실패·서킷 오픈)만 한다.

failover를 "실패하면 다음으로"라고 단순하게 짜면 이 이중결제 함정에 바로 빠진다. 결제에서 재시도·failover는 항상 멱등성과 이중청구를 먼저 물어야 한다.

### 4. 남겨둔 한계 — 원 PG 라우팅

하나는 남겨뒀다. 취소·조회는 원래 결제를 처리한 **그 PG**로 가야 맞다(A PG로 승인했으면 A PG로 취소). `Payment.pgProvider`에 어느 PG였는지 기록은 돼 있는데, 정작 `PgClient.cancel(paymentKey, ...)` 인터페이스가 provider를 안 받는다. 그래서 지금은 "가용한 첫 PG"로 시도한다.

> 제대로 하려면 인터페이스에 provider 힌트를 넣어 라우터가 원 PG로 보내야 한다. 인터페이스를 건드리는 일이라 [후속 과제로 명시](/blog/project/pay/pay-ch7-consume-align-harden)했다. "여기까진 했고 여기부턴 안 했다"를 적는 쪽이 안 한 걸 숨기는 것보다 낫다.

### 마치며

이번에도 새 로직은 없다. 테스트에서만 돌던 라우터를 `pgDelegate` 자리에 끼우고, `FakePgClient`의 등록을 토글에 묶은 게 전부다. 대신 그 과정에서 `@Primary`와 qualifier로 기존 seam에 데코레이터를 겹쳐 끼우는 법을 손에 익혔고, failover조차 결제에선 이중결제부터 따져야 한다는 판단을 표로 박아뒀다.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있다. `app.pg.routing.enabled=true`로 라우터가 pgDelegate로 배선되어 결제가 라우팅 경로로 승인되는 것을 실기동으로 확인했다.*

<hr />

## 10초 안에 200을 못 주면 PG가 다시 보낸다 — 웹훅을 비동기로 떼며 만난 트랜잭션 함정 둘

### 0. 10초 규약

PG로 나가는 경로를 배선했으니, 이번엔 PG가 우리를 부르는 경로인 웹훅 차례다. PG 웹훅엔 시간 규약이 있다. **10초 안에 2xx**를 못 주면 PG는 수신 실패로 보고 **재전송**한다(토스는 최대 7회, 며칠에 걸쳐). 웹훅 응답은 그래서 빨라야 한다.

그런데 [웹훅 처리 코드](/blog/project/pay/pay-ch1-payment-core)는 이랬다.

```java
public void handle(...) {
    WebhookEvent event = receive(...);   // 서명검증 + 멱등저장 (빠름)
    process(event);                       // ← PG 조회 API를 동기 호출 (느릴 수 있음)
}
```

`process`는 [페이로드를 믿지 않고 PG 조회 API로 실제 상태를 재검증](/blog/project/pay/pay-ch1-payment-core)한다. 문제는 그 **PG 조회 네트워크 왕복이 응답 경로에 얹혀 있다**는 것.

> PG가 느리거나 일시 장애면 이 조회가 몇 초씩 걸린다. 웹훅 응답이 10초를 넘고, PG는 재전송을 시작한다. 재전송이 또 조회를 유발하니 느릴 때 더 부하가 쌓이는 악순환이다. 수신 확인과 실제 해석은 시간 특성이 완전히 다른데 한 스레드에 묶여 있었다.

다행히 `receive`와 `process`는 이미 나뉘어 있었고, javadoc에도 "나중에 process만 비동기로 떼어낸다"고 적어둔 상태였다. 이번에 실제로 뗐다. 그런데 "이벤트로 떼면 되겠지"가 두 번 막혔다.

### 1. 왜 @Async 대신 아웃박스인가

단순하게는 `process`에 `@Async`를 붙이면 된다. 하지만 [이 시스템은 신뢰성을 아웃박스로 보장](/blog/project/pay/pay-ch1-payment-core)하고, 인메모리 스레드풀인 `@Async`에는 구멍이 있다.

> 200을 응답한 뒤 `@Async` 작업이 실행되기 전에 앱이 죽으면(배포·크래시) 그 **해석 작업이 통째로 사라진다.** PG는 200을 받았으니 재전송도 안 한다. 웹훅은 받았는데 해석은 안 된 채 유실된다.

그래서 `@Async` 대신 **Modulith 이벤트**로 뗐다. `receive`가 신규 이벤트에 `WebhookReceivedEvent`를 발행하면 [Event Publication Registry(아웃박스)](/blog/project/pay/pay-ch1-payment-core)에 수신과 함께 기록되고, 커밋 후 `@ApplicationModuleListener`가 별도 스레드에서 해석한다. 앱이 죽어도 재기동 때 재발행된다. 유실이 없다.

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

### 2. 함정 하나 — 자기호출이 트랜잭션을 삼켰다

코드는 완벽해 보였고 테스트도 통과했다. 그런데 **실기동해서** 웹훅을 쏴보니 이상했다.

```
웹훅 POST → 200 (0.02초, 빠름)
직후 DB: RECEIVED
3초 후 DB: 여전히 RECEIVED (?!)
event_publication: WebhookReceivedEvent, 완료 안 됨
```

해석이 **아예 실행되지 않았다.** 발행은 아웃박스에 기록됐는데 리스너가 안 불린 것. 다른 이벤트(`PaymentConfirmedEvent` 3444건)는 다 완료되는데 이것만 그랬다.

차이는 하나, **자기호출(self-invocation)**이었다.

> `@ApplicationModuleListener`는 `AFTER_COMMIT`이라, 발행이 **커밋되는 트랜잭션 안**에서 일어나야 걸린다. 그런데 컨트롤러가 부른 `handle()`이 `this.receive()`를 부르는데, 이 호출은 **프록시를 거치지 않아** `receive()`의 `@Transactional`이 **무시된다.** 발행이 트랜잭션 밖에서 일어났고, 커밋할 트랜잭션이 없으니 `AFTER_COMMIT`이 영원히 안 걸렸다. (저장은 Spring Data가 자체 커밋해서 행은 남았다. 그래서 더 헷갈렸다.)

`handle()`을 트랜잭션 경계로 만들어 고쳤다.

```java
@Transactional   // 발행이 이 트랜잭션에 실려 커밋 → 그 커밋에 비동기 해석이 걸린다
public void handle(String sig, String body) {
    receive(sig, body);
}
```

[자기호출이 프록시 기반 AOP를 우회한다](/blog/project/pay/pay-ch5-runtime-truths)는 건 아는 함정인데도, 이벤트 발행과 얽히니 증상이 "리스너가 그냥 안 불림"으로 나타나 한참 헤맸다. 코드만 봐서는 안 보이고 실기동에서만 드러나는 부류다.

### 3. 함정 둘 — 오염된 트랜잭션에 FAILED를 못 쓴다

고치니 리스너가 불렸다. 이번엔 다른 에러가 나왔다.

```
Transaction silently rolled back because it has been marked as rollback-only.
Leaving event publication uncompleted.
```

존재하지 않는 결제를 가리킨 웹훅을 처리할 때였다. `process`가 원래 이렇게 돼 있었다.

```java
try {
    paymentRecoveryService.resolveByPaymentKey(paymentKey);  // 없는 결제 → 예외
    event.markProcessed();
} catch (Exception e) {
    event.markFailed(e.getMessage());   // ← 여기가 안 먹혔다
}
repository.save(event);
```

> `resolveByPaymentKey`가 "결제 없음"으로 예외를 던지면, 그 시점에 이미 **현재 트랜잭션이 rollback-only로 오염**된다. `catch`로 잡아 `FAILED`를 쓰고 `save`해도 오염된 트랜잭션은 **커밋 자체가 거부**된다. 실패를 기록하려는 write가 바로 그 실패 때문에 막히는 구조다.

여기서 방향을 바꿨다. 실패를 잡아 `FAILED`로 포기하는 대신 **예외를 그대로 전파**하기로 했다.

```java
// 실패는 삼키지 않는다 — 예외 전파 → 아웃박스가 발행을 미완료로 남겨 재시도(at-least-once)
paymentRecoveryService.resolveByPaymentKey(paymentKey);
event.markProcessed();
repository.save(event);
```

> 비동기 해석이 아웃박스에 실려 있으니, 예외를 던지면 Modulith가 그 발행을 **미완료로 남겨 재시도**한다. PG 일시 장애 같은 건 재시도로 풀리고, 오염된 트랜잭션에 억지로 뭘 쓸 필요도 없어졌다. 아웃박스에는 "포기하고 FAILED"보다 "재시도에 맡긴다"가 맞았다.

실기동으로 최종 확인했다.

```
정상 웹훅(실제 결제) → 200(0.02s) → 별도 스레드 → PROCESSED, 발행 완료
실패 웹훅(없는 결제)  → 200(0.02s) → 해석 실패 전파 → 발행 미완료(재시도 대기)
```

성공은 완료되고, 실패는 유실 없이 재시도 큐에 남는다.

### 마치며

배선 자체는 두 줄이다. 발행 하나, 리스너 하나. 그 사이의 트랜잭션 함정 둘, 자기호출이 트랜잭션을 우회한 것과 예외가 트랜잭션을 오염시킨 것은 둘 다 [코드 리뷰로는 안 보이고 실기동에서만](/blog/project/pay/pay-ch5-runtime-truths) 드러났다. 웹훅을 쏘고 DB를 열어본 뒤에야 어디서 트랜잭션이 열리고 커밋되는지, 실패가 그 트랜잭션을 어떻게 오염시키는지가 손에 잡혔다.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있다. 빠른 200(~0.02s)·비동기 PROCESSED·실패 시 아웃박스 재시도를 실기동으로 확인했다.*

<hr />

## 정산이 조용히 가맹점에 돈을 안 주고 있었다 — 집계 키가 승인일이던 버그, 그리고 같은 날만 확정하던 테스트

### 0. "더 있나?" 하고 다시 봤더니

여기까지 하고 다 됐다 싶었다. 그 "다 됐다"를 의심하며 코드베이스를 결제 도메인 리뷰어의 눈으로 한 번 더 훑었는데, 정산에서 조용한 버그가 나왔다. 에러도 안 나고 테스트도 초록불인데 **가맹점에 돈이 안 나가는** 버그다. [정산을 에스크로에 정렬](/blog/project/pay/pay-ch7-consume-align-harden)하고 [수수료·부가세·지급예정일까지 고도화](/blog/project/pay/pay-ch8-settlement-pg-webhook)한 바로 그 정산에서.

### 1. 집계 키가 잘못된 날짜였다

정산 배치의 핵심은 이 한 줄이다.

```java
itemRepository.findByStatusAndConfirmedDate(CONFIRMED, date);
// "그 date에 CONFIRMED된 정산 항목"을 집계
```

`status == CONFIRMED` 그리고 `confirmedDate == date` 둘 다 맞는 항목을 모은다. 문제는 이 `confirmedDate`의 정체였다.

```java
// 적재 시점(결제 승인 이벤트)
LocalDate confirmedDate = LocalDate.ofInstant(event.approvedAt(), UTC);  // ← 승인일
```

이름은 `confirmedDate`("구매확정일")인데 실제로 담긴 건 **승인일**이었다. 항목이 `CONFIRMED`(정산 가능)로 바뀌는 건 [에스크로 릴리스(구매확정)](/blog/project/pay/pay-ch4-arch-events-ops) 시점인데, 그 전이가 `confirmedDate`를 **재스탬프하지 않았다.**

이게 치명적인 이유는 **에스크로가 며칠 홀드되기 때문이다**(기본 7일).

> 결제가 D일에 승인 → 항목 적재(`confirmedDate = D`, PENDING). D+1일에 `settle(D)` 배치가 도는데, 이 항목은 아직 PENDING이라 제외된다. **D+7일**에 에스크로가 릴리스되어 CONFIRMED가 되지만 `confirmedDate`는 **여전히 D.** 그런데 `settle(D)`는 D+1에 이미 실행됐고, [재실행은 멱등하게 skip](/blog/project/pay/pay-ch8-settlement-pg-webhook)된다(그 날짜 정산이 이미 있으니까). 스케줄러는 매일 `settle(어제)`만 돌지 과거를 다시 돌지 않는다.
>
> 결과적으로 이 항목은 **CONFIRMED인 채로 영원히 집계되지 않는다.** "그 날짜에 CONFIRMED된 항목"이라는 조건을 어떤 배치도 만족시키지 못한다. `settle(D)`가 돌 땐 PENDING이었고, `settle(D+7)`엔 `confirmedDate`가 안 맞는다. **가맹점은 돈을 못 받는다.**

무서운 대목은 따로 있다. 에스크로 홀드가 본질적으로 며칠짜리라, 이건 예외가 아니라 **거의 모든 항목의 기본 경로**다. "구매확정 시점 정산"을 하겠다던 [바로 그 리워크](/blog/project/pay/pay-ch7-consume-align-harden)가 정작 지급을 막고 있었다.

### 2. 내 테스트는 왜 못 잡았나

더 뼈아픈 쪽은 테스트다. 정산 테스트의 헬퍼가 이랬다.

```java
private static SettlementItem confirmedItem(...) {
    SettlementItem item = SettlementItem.of(..., DATE);  // 승인일 = DATE
    item.confirm();                                       // 곧바로 확정
    return item;                                          // confirmedDate == DATE
}
```

**승인하자마자 같은 날 확정**하니 `confirmedDate`와 `settle` 대상 날짜가 늘 일치했다. 그래서 모든 테스트가 통과했다. 하지만 "승인하자마자 같은 날 구매확정"은 실제로는 거의 안 일어난다. 에스크로가 며칠 홀드하기 때문이다.

> 테스트가 "승인일 == 확정일"이라는, 현실에선 드문 조건에서만 돌아 버그를 통째로 가렸다. [실기동 검증](/blog/project/pay/pay-ch5-runtime-truths) 때도 나는 결제 후 **바로** 구매확정을 눌렀으니 그때도 우연히 통과했다. 승인과 확정 사이의 **시간 간격**이라는 정산의 본질을, 테스트도 나도 좁혀서 보고 있었다.

### 3. 고침 — 확정일로 재스탬프

집계 키를 승인일에서 **구매확정(릴리스)일**로 바꿨다. 마침 `EscrowReleasedEvent`가 릴리스 시각을 담고 있었다.

```java
public void confirm(LocalDate settlementReadyDate) {
    if (this.status == PENDING_CONFIRMATION) {
        this.status = CONFIRMED;
        this.confirmedDate = settlementReadyDate;   // ← 릴리스일로 재스탬프
    }
}
```

```java
void onEscrowReleased(EscrowReleasedEvent event) {
    LocalDate releaseDate = LocalDate.ofInstant(event.releasedAt(), UTC);
    settlementService.confirmSettlement(event.orderNo(), releaseDate);
}
```

이제 릴리스일 R로 재스탬프되니 **R+1의 `settle(R)`이 이 항목을 집계**한다. 필드 이름도 이 수정으로 바로잡혔다. `confirmedDate`가 이름대로 "구매확정일"이 됐다(전엔 이름과 달리 승인일이었다).

회귀 테스트도 심었다. 승인 D일 적재 → D+7 릴리스 → **릴리스일 배치가 잡는지**. 누가 다시 승인일로 되돌리면 빨간불이 뜬다.

실 MySQL로 확인했다.

```
승인일 backdate(2026-06-01) → PENDING (confirmed_date=2026-06-01)
구매확정(에스크로 릴리스) → CONFIRMED, confirmed_date=2026-07-07 (재스탬프!)
settle(2026-07-07) → 집계 → SETTLED, 정산 생성(net 9,703)
```

승인일이 6월 1일이던 항목이 릴리스 시 오늘로 재스탬프되어 오늘 배치에 잡힌다.

### 마치며

이번 건은 "만들었는데 안 돌더라"의 가장 조용한 버전이었다. 컴파일도 되고 테스트도 통과하고 데모도 됐다. 그런데 승인과 확정 사이에 며칠이 끼는 실제 타이밍에선 가맹점 지급이 영영 밀렸다.

남긴 것은 둘이다. 집계 키는 그 상태로 전이되는 시점의 값이어야 한다. "그 날짜에 X된 것"을 찾으면서 다른 사건(승인)의 날짜를 키로 쓰면 조건이 영영 안 맞는다. 그리고 시간을 압축한 테스트는 시간 버그를 못 잡는다. 같은 날 승인·확정하는 테스트는 며칠 걸리는 실제 흐름에 눈을 감는다.

이 버그를 찾은 건 새 기능이 아니라 "다 됐나?" 하고 한 번 더 본 재감사였다. 에스크로 홀드가 끼는 결제, 그러니까 사실상 전부가 이 경로를 탔으니, 초록불 뒤를 다시 본 그 한 번이 지급 전체를 살린 셈이다.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있다. 승인일 backdate → 릴리스 재스탬프 → 릴리스일 배치 집계까지 실 MySQL로 검증했다.*

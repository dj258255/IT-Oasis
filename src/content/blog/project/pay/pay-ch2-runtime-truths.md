---
title: '실기동 점검: 테스트는 통과하는데 실제로는 틀렸다'
description: '테스트가 다 통과하는데 실제로 띄우니 결제가 DB에 없었다. 이벤트는 두 번 인코딩되고, 배치는 아무도 부르지 않고, 금고는 비어 있었다. 전부 앱을 실제로 띄우고 나서야 나왔다.'
date: 2026-08-31T00:00:00.000Z
category: study/pay
coverImage: "/uploads/project/pay/thumbs/pay-ch2.svg"
draft: false
series: "결제 시스템 만들기"
seriesOrder: 3
tags:
  - Payment
  - 실기동
  - 이벤트
  - 운영
---

*결제 시스템 시리즈 3편. 만든 걸 실제로 돌려봤을 때 나온 것들이다.*

## 승인됐습니다"라고 답했지만 DB엔 없었다: 실기동이 드러낸 결제 확정 버그

응답은 `PAID`인데 DB엔 `PENDING_PAYMENT`가 남아 있었다. 결제 승인이 실제로는 DB에 확정되지 않는 버그가, 200개 넘는 테스트가 전부 초록불인 채로 실기동에서 드러났다.

### 0. 구매확정이 자꾸 막혔다

[에스크로](/blog/project/pay/pay-0-overview)를 붙이고 실기동으로 흐름을 눌러봤다. 주문 생성 → 결제 승인 → 구매확정. 그런데 구매확정이 자꾸 막혔다.

```
POST /api/v1/orders/{orderNo}/confirm-purchase
→ 409 "결제 완료 주문만 구매확정할 수 있습니다."
```

이상했다. 바로 전에 결제 승인 응답은 분명 이랬으니까.

```json
{ "orderNo": "...", "orderStatus": "PAID", "paymentStatus": "DONE", "message": "승인 완료" }
```

PAID라고 응답했는데 구매확정은 "PAID가 아니다"라며 막는다. 앞뒤가 안 맞아서 DB를 직접 열어봤다.

```sql
SELECT status FROM orders   WHERE order_no='...';  -- PENDING_PAYMENT  (?!)
SELECT status FROM payments WHERE order_no='...';  -- IN_PROGRESS      (?!)
```

응답은 `PAID`/`DONE`인데 DB는 `PENDING_PAYMENT`/`IN_PROGRESS`. 결제 승인이 실제로는 DB에 확정되지 않고 있었다. 결제 시스템에서 이건 최악의 종류다. 됐다고 답해놓고 실제론 안 된 상태니까.

### 1. 이상한 단서: 트랜잭션은 커밋되는데 UPDATE가 없다

먼저 상태머신을 의심했다. 그런데 `PAID → PENDING_PAYMENT`는 상태 전이표상 불가능한 전이다. PAID였다가 되돌아간 게 아니었다. 애초에 PAID가 저장된 적이 없다는 뜻이었다.

응답의 `orderStatus`는 서비스가 메모리에 들고 있는 `order.getStatus()`로 만든다. 그건 `PAID`. 그런데 DB엔 반영이 안 됐다. 그럼 트랜잭션이 롤백됐나? 아니었다. 트랜잭션 디버그 로그를 켜봤다.

```
Creating new transaction [CheckoutService.confirm]
Participating in existing transaction (...)
Initiating transaction commit
Committing JPA transaction on EntityManager [...]
```

트랜잭션은 정상적으로 생성되고 커밋됐다. 그런데 SQL 로그는 이랬다.

```
insert into payments (...)          ← startApproval: IN_PROGRESS
insert into payment_history (...)   ← 이력
insert into payment_history (...)   ← approve()가 남긴 두 번째 이력
update stock ...                    ← 재고 차감(명시 쿼리)
...
(update payments set status=DONE  → 없음!)
(update orders  set status=PAID   → 없음!)
```

INSERT는 나가는데 상태를 바꾸는 UPDATE만 안 나간다. 트랜잭션이 커밋되는데도 dirty-checking이 만들어야 할 UPDATE가 없었다.

### 2. 왜 INSERT는 되고 UPDATE는 안 될까

여기서 실마리가 잡혔다. 이 프로젝트의 엔티티는 `@GeneratedValue(strategy = IDENTITY)`를 쓴다. IDENTITY 전략은 `persist()` 시점에 즉시 INSERT를 실행한다(DB가 생성한 ID를 바로 받아와야 하니까). 그래서 신규 엔티티의 INSERT는 flush 여부와 무관하게 즉시 나간다. 반면 기존 엔티티의 상태 변경(UPDATE)은 커밋 시점의 flush에 의존한다. 그 flush가 안 일어나면 UPDATE도 없다.

문제는 이 트랜잭션의 영속성 컨텍스트가 커밋 때 변경분을 flush하지 않는다는 것이었다. IDENTITY 즉시 INSERT가 이 문제를 가려서, 주문 행은 있으니 저장은 되는 줄 착각하게 만들었다.

> **정정(나중에 더 정확히 알게 된 것)**: 처음엔 이걸 "[OSIV를 꺼서](/blog/project/pay/pay-0-overview)(`open-in-view: false`) 그렇다"고 이해했는데, 부정확했다. 일반적인 read-write 트랜잭션 안에선 OSIV 여부와 무관하게 커밋 때 dirty-check가 flush된다(managed 엔티티라면). 진짜 원인은 이 경로의 세션 FlushMode가 AUTO가 아니었다는 데 있다. `@Transactional(readOnly = true)` 조회가 끼면 Hibernate가 FlushMode를 **MANUAL**로 바꿔서, 이후 dirty 변경이 커밋 때 flush되지 않는다. 거기에 "불러온 엔티티가 detached라 merge가 필요한" 경우까지 겹치면서, `order.markPaid()`·`payment.approve()` 같은 변경이 메모리에만 남고 사라졌다. OSIV off는 detached를 만드는 배경일 뿐, flush를 막는 직접 원인은 아니다.

### 3. 고치기: 애그리거트를 명시적으로 영속

해법은 dirty-checking의 자동 flush에 의존하지 않고, 상태를 바꾼 애그리거트를 명시적으로 저장하는 것.

```java
// 상태 전이(approve/abort/markUnknown)를 명시적으로 영속한다.
paymentRepository.saveAndFlush(payment);
```

처음엔 `save()`로 했는데, 여기서 재밌는 걸 발견했다. `save()`로 되는 곳과 안 되는 곳이 갈렸다.

- `findByOrderNo`로 불러온(detached) 엔티티(주문·에스크로 홀드)는 `save()`(=merge)로 확정됐다.
- `initiate`로 새로 만들어 persist한 managed 엔티티(결제)는 `save()`가 merge no-op이 되어 확정되지 않았다.

이 트랜잭션에서 자동 flush를 신뢰할 수 없다는 게 드러난 셈이다. 그래서 모든 애그리거트 상태 확정 지점을 `saveAndFlush`로 통일했다. merge 여부와 무관하게 flush를 강제한다. 가끔 되고 가끔 안 되는 저장을 결제 시스템에 둘 수는 없다.

같은 버그가 confirm뿐 아니라 취소·복구 배치·에스크로·가상계좌·구독에도 다 있었다. 불러와서 상태만 바꾸는 모든 곳. 전수 조사해서 한꺼번에 고쳤다.

고친 뒤 실기동으로 다시 확인했다.

```
승인      → 주문 PAID,     결제 DONE,             에스크로 RELEASED
전액취소  → 주문 CANCELED, 결제 CANCELED(잔액 0),  에스크로 REFUNDED
부분취소  → 주문 PAID,     결제 PARTIAL(잔액 7천), 에스크로 HELD 유지
```

이제 응답과 DB가 일치한다.

### 4. 왜 여태 안 잡혔나: 테스트의 사각지대

제일 뼈아픈 질문. 테스트가 200개가 넘는데 왜 이걸 못 잡았지?

답은 테스트의 성격에 있었다. 이 프로젝트의 단위 테스트는 리포지토리를 목(mock)으로 둔다.

```java
OrderRepository orderRepository = mock(OrderRepository.class);
// order.markPaid() 후 상태가 PAID인지 "메모리에서" 검증
assertThat(order.getStatus()).isEqualTo(OrderStatus.PAID);  // 통과!
```

이 테스트는 "서비스 로직이 order를 PAID로 바꿨는가"를 검증한다. 그건 맞았다. 하지만 그게 실제 DB에 반영됐는지는 목이라서 검증할 수가 없다. dirty-checking flush 같은 영속성 계층의 동작은 진짜 DB를 써야만 드러난다.

그래서 이 버그는 단위 테스트의 사각지대에 정확히 숨어 있었다. [부하테스트(k6)](/blog/project/pay/pay-0-overview)도 HTTP 200만 봤지 DB 상태는 안 봤다. 에스크로가 "주문이 PAID여야 한다"는 조건을 실제로 요구하면서, 실기동에서 처음 터진 것이다.

목 기반 단위 테스트는 로직을 검증할 뿐 영속까지 검증하지 못한다. 상태 전이가 DB에 남는지는 실 DB 통합 테스트로만 확인된다. 그래서 재발 방지로 각 수정 지점에 `verify(repo).saveAndFlush(...)` 단언을 넣어, 최소한 "명시 저장을 호출한다"는 계약을 고정했다. 그리고 기능은 끝까지 눌러봐야 한다. "API가 200을 준다"와 "DB에 올바르게 남는다"는 다른 얘기다. E2E 실기동으로 실제 상태를 확인하지 않았다면, 이 버그는 운영에서 "결제됐다는데 주문이 없어요" 문의로 터졌을 것이다.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, 수정 후 승인/취소/부분취소/구매확정을 실 MySQL로 전수 검증했다.*

---

## 프로세스 밖 소비자"라는 약속을 실제로 지키기: 붙여보니 드러난 이중 인코딩

외부화해둔 Kafka 이벤트를 구독하는 소비자를 드디어 만들었다. 그리고 붙이자마자 알았다. JSON이어야 할 와이어에 base64가 흐르고 있었다.

### 0. 구독자 없는 외부화는 약속일 뿐

[Kafka 외부화 편](/blog/project/pay/pay-0-overview)에서 결제 이벤트에 `@Externalized`를 달아 Kafka로 내보냈다. 목적은 분명했다. 프로세스 밖 소비자(분석, 별도 서비스, 다른 팀)가 이벤트 모델을 고치지 않고 구독할 수 있게 하는 것.

그런데 돌아보니 정작 구독하는 프로세스 밖 소비자가 하나도 없었다. 토픽에 이벤트가 실리는 것까진 확인했지만, "다른 프로세스가 실제로 받아서 쓸 수 있다"는 건 여전히 약속이었지 실증이 아니었다. FDS 엔진도 [대사 엔진](/blog/project/pay/pay-0-overview)도 만들어두고 안 연결된 상태였다가 연결하면서 완성됐다. 외부화도 소비자가 있어야 완성이다.

그래서 만들었다. 이번에도 실제로 붙여보니 몰랐던 게 드러났다.

### 1. 소비자 앱: 메인과 완전히 분리

소비자는 "정산 알림" 데모 워커다. `payment.confirmed`/`payment.canceled`를 구독해 구조화 로그를 남기는 경량 앱. 설계에서 지킨 분리 원칙은 세 가지다.

**(1) 빌드부터 분리.** `consumer-app/`은 자체 `settings.gradle`을 가진 독립 Gradle 프로젝트다. 루트 멀티모듈에 include하지 않아서 메인의 빌드·테스트·CI가 이 앱의 존재조차 모른다. 실행만 wrapper를 공유한다(`./gradlew -p consumer-app bootRun`). "별도 서비스"라면 빌드 생명주기부터 별도여야 한다.

**(2) 타입도 분리.** 소비자는 메인 앱의 이벤트 클래스를 import하지 않는다. 값을 String으로 받아 Jackson `readTree`로 파싱한다. producer가 붙이는 타입 헤더(`__TypeId__: com.beomsu.pay...PaymentConfirmedEvent`)에 기대면 소비자가 발행자의 내부 클래스명에 결합되고, 그 순간 "프로세스 밖"의 의미가 사라진다. 계약으로 삼을 것은 JSON 스키마다.

**(3) 실패도 분리.** 파싱 안 되는 메시지(포이즌)는 warn 찍고 건너뛴다. 이상한 메시지 하나가 파티션 소비 전체를 멈추면 안 된다. [outbox 재발행](/blog/project/pay/pay-0-overview)은 at-least-once라 중복 수신이 가능하다는 것, 그래서 실소비자는 orderNo/paymentId 기반 멱등 처리가 필수라는 것도 코드에 명시했다.

### 2. 붙여보니: 와이어에 base64가 흐르고 있었다

두 앱을 나란히 띄우고 결제를 일으켰다. 소비자가 이벤트를 받긴 받았다.

```
[정산알림] 결제 완료 수신 orderNo= amount=0 ...   ← 빈 값?!
```

파싱이 전부 빈 값이다. 토픽을 직접 덤프했다.

```
"eyJvcmRlck5vIjoiMDFLV1c2OFpFMldNOVNFQVY5SEFONjdHSlEiLCJwYXltZW50SWQiOjEsImFtb3VudCI6MTAwMDAsIn..."
```

와이어에 흐르는 건 base64 문자열이었다. 디코드하니 그 안에 정확한 JSON이 들어 있었다. 이중 인코딩이다.

> 원인은 직렬화기 궁합이었다. Modulith 외부화는 이벤트를 이미 JSON byte[]로 직렬화해서 KafkaTemplate에 넘긴다. 그런데 producer의 value-serializer가 `JsonSerializer`였다. Jackson은 byte[]를 받으면 base64 문자열로 JSON 인코딩한다. 이미 JSON인 걸 한 번 더 감싼 것이다.
>
> 수정은 한 줄. `value-serializer: ByteArraySerializer`. 이미 직렬화된 byte[]를 그대로 와이어에 싣는다.

고치고 다시 돌렸다.

```
[정산알림] 결제 완료 수신 orderNo=01KWW6HR... amount=10000 partition=0 offset=1
[정산알림] 결제 취소 수신 orderNo=01KWW6HR... cancelAmount=10000 fullyCanceled=true
```

별도 프로세스가 깨끗한 JSON을 받아 모든 필드를 제대로 파싱한다. "프로세스 밖 소비자"가 약속에서 동작하는 사실이 됐다.

### 3. 왜 이 버그는 지금까지 숨어 있었나

곱씹어볼 지점이다. 이 이중 인코딩은 [외부화를 만든 시점](/blog/project/pay/pay-0-overview)부터 있었다. 그런데 아무 테스트도 못 잡았다. 발행 측 설정 테스트는 "토픽으로 나간다"까지만 봤고, 와이어 포맷을 읽는 쪽이 없으니 포맷이 틀렸는지 알 길이 없었다.

이 시리즈에서 반복된 패턴이 또 나왔다.

> 결제 확정 버그는 실기동 E2E가, [outbox 데드락](/blog/project/pay/pay-0-overview)은 스파이크 실측이, 이번 이중 인코딩은 실제 소비자를 붙이는 것이 드러냈다. 소비하는 쪽이 생기기 전까지 만드는 쪽은 자기가 옳다고 믿는다. 계약의 검증은 언제나 반대편 끝에서 온다.

Kafka를 붙일 계획이 없더라도, 이벤트를 외부화한다면 더미라도 좋으니 진짜로 읽는 소비자를 하나 두는 게 좋다. 그게 와이어 계약의 테스트다.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, 소비자 앱은 [consumer-app/](https://github.com/dj258255/payment-system/tree/main/consumer-app)에서 별도 프로세스로 실행된다.*

---

## 아무도 부르지 않는 배치들: javadoc은 스케줄러가 있다고 믿었다

죽은 이벤트 다음은 죽은 배치였다. 같은 감사에서, 복구·만료·dunning 배치가 로직만 완성된 채 부르는 스케줄러 없이 잠들어 있다는 게 드러났다. 심지어 javadoc은 있지도 않은 스케줄러가 돈다고 적고 있었다.

### 0. javadoc이 거짓말을 하고 있었다

전수 감사에서 나온 또 하나의 항목이다.

> **[5] 핵심 배치 스케줄러 부재**: @Scheduled는 2개뿐. 미확정 결제 복구·구독 dunning·주문/VA 만료 배치가 **로직만 있고 부르는 스케줄러가 없음**.

특히 미확정 복구가 흥미로웠다. `PaymentRecoveryService`의 javadoc엔 이렇게 적혀 있었다.

```java
/**
 * ... 스케줄러가 {@code payment.recovery.enabled=true}일 때 이 로직을 주기 실행한다(운영). ...
 */
```

그런데 그 스케줄러가 없었다. grep해보니 `@Scheduled`도, `payment.recovery.enabled` 프로퍼티도 실재하지 않았다. 문서는 "스케줄러가 돈다"고 믿고 있는데 실제로는 어드민이 수동으로 트리거하는 것뿐이었다. 의도와 구현이 갈라진, 죽은 이벤트와 같은 종류의 갭이다.

### 1. 로직은 다 있었다, 부르는 사람만 없었다

확인해보니 배치 로직은 전부 완성돼 있었다.

| 배치 | 로직 | 스케줄러 |
|---|---|---|
| 미확정(UNKNOWN) 결제 복구 | `recoverUnknownPayments()` 있음 | 없음 (javadoc은 있다고 주장) |
| 가상계좌 만료 | `expireOverdue(now)` 있음 | 없음 |
| 구독 정기결제(dunning) | `runBillingCycle(today)` 있음 | 없음 |
| 주문 만료 | `Order.markExpired()` 있음 | 없음 (스캔 서비스도 없음) |

가장 심각한 건 주문 만료였다. `Order.markExpired()`(PENDING_PAYMENT → EXPIRED)는 있는데, "만료 배치가 이 값으로 스캔한다"는 [주석](/blog/project/pay/pay-ch1-what-to-trust)의 그 배치가 존재하지 않았다.

> 결제 안 하고 방치된 PENDING_PAYMENT 주문이 영원히 만료되지 않는다. 30분 유효시간이 지나도 상태가 그대로라 재고 선점(있었다면)이나 통계가 계속 오염된다. 만료 로직은 있는데 아무도 실행하지 않으니, 사실상 없는 기능이었다.

### 2. 스케줄러를 다는 것도 그냥 붙이면 안 된다

배치 4개에 스케줄러를 달았다. 이 프로젝트엔 스케줄러를 켜고 끄는 원칙이 이미 있다. [보상 태스크·에스크로 자동 릴리스](/blog/project/pay/pay-0-overview)처럼 프로퍼티 게이트(기본 off)다.

```java
@Configuration @EnableScheduling
@ConditionalOnProperty(name = "app.order.expiry.enabled", havingValue = "true")
class OrderExpirySchedulingConfig {}   // 프로퍼티 off면 스케줄링 인프라 자체가 안 뜬다
```

기본을 off로 두는 이유는 테스트·부트에 부작용이 없게 하기 위해서다. 여기서 신경 쓴 게 하나 있다. 여러 `@EnableScheduling`이 공존해도 되나?

> 이미 order(보상)·escrow(자동 릴리스)에 각각 `@EnableScheduling` 게이트가 있고, 여기에 복구·만료·dunning·outbox까지 더하면 `@EnableScheduling`이 여러 개가 된다. 괜찮을까? 괜찮다. `@EnableScheduling`은 `ScheduledAnnotationBeanPostProcessor`를 고정된 빈 이름으로 등록하는데, Spring이 같은 이름의 중복 등록을 dedup한다. 게이트를 몇 개를 켜도 스케줄링 처리기는 한 번만 뜨고, 각 프로퍼티를 켠 스케줄러만 독립적으로 돈다.

새로 만든 건 주문 만료 스캔 서비스 하나뿐이다(나머지는 기존 로직에 스케줄러만 달았다).

```java
public int expireOverdue(Instant now) {
    // PENDING_PAYMENT + 만료시각 경과 주문을 스캔 → markExpired + saveAndFlush
    // 한 건 실패가 배치를 안 멈추게 per-item try/catch
}
```

예의 saveAndFlush와 [한 건 실패 격리](/blog/project/pay/pay-0-overview)는 이제 반사적으로 들어간다.

실기동으로 확인했다. 주문을 만들고 만료시각을 과거로 backdate한 뒤 스케줄러를 켜니,

```
주문 → PENDING_PAYMENT
(만료시각 과거로 조작)
→ 8초 뒤 → EXPIRED
로그: "주문 만료 배치 완료 count=1"
```

드디어 만료돼야 할 주문이 만료된다.

### 3. 무한히 자라던 테이블

마지막은 눈에 안 보이던 문제, outbox 테이블의 무한 성장이다.

이 시스템은 [Modulith의 Event Publication Registry](/blog/project/pay/pay-ch1-what-to-trust)를 outbox로 쓴다(`event_publication` 테이블). 이벤트를 발행하면 여기 기록되고, 리스너가 처리하면 완료 표시된다.

> 완료된 이벤트를 지우거나 아카이브하는 게 없었다. 게다가 `republish-outstanding-events-on-restart: true`라 재기동 때 미완료분을 재발행한다. 그래서 이 테이블은 매 결제마다 커지기만 했다. 몇 달이면 수백만 행이 쌓여 조회·재발행이 느려지고, 결국 성능 문제가 된다.

Modulith가 이걸 위한 API를 준다. `CompletedEventPublications.deletePublicationsOlderThan(Duration)`으로 완료된 지 N일 지난 이벤트를 지우는 것. 주기 정리 스케줄러를 붙였다(기본 7일 보존).

> 참고로 Modulith 1.3엔 `completion-mode`로 `DELETE`(완료 즉시 삭제)나 `ARCHIVE`(별도 테이블로 이동) 모드도 있다. 감사 이력을 잠깐이라도 남기고 싶어서 "완료 유지 + 주기 purge"를 택했다. outbox의 목적은 유실 방지지 영구 보관이 아니다.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, 주문 만료 배치를 실 MySQL로 검증했다(backdate→EXPIRED).*

---

## 금고를 만들어놓고 아무것도 안 넣었다: 암호화를 실제 컬럼에, 그리고 조회의 딜레마

감사가 짚은 다음 간극은 더 민감한 곳, 암호화였다. AES-256-GCM 금고까지 완비해놓고 어느 컬럼에도 적용하지 않아, 계좌번호와 빌링키가 DB에 평문으로 누워 있었다.

### 0. 금고는 있는데 비어 있었다

[필드 암호화](/blog/project/pay/pay-0-overview)를 만들고, [envelope로 키 로테이션까지](/blog/project/pay/pay-0-overview) 정성껏 확장했다. AES-256-GCM, DEK/KEK, 블라인드 인덱스, JPA 컨버터까지 민감 데이터를 잠글 준비는 다 돼 있었다.

그런데 감사가 이렇게 짚었다.

> **[4] 필드 암호화 인프라 전부 미사용**: `@Convert`가 **어느 엔티티 컬럼에도 적용 안 됨**. 가상계좌 계좌번호·빌링키가 평문.

인프라만 완비하고 채우진 않은 셈이다. 계좌번호도, 카드 토큰인 빌링키도 평문 그대로였다. FDS 엔진처럼, [대사 엔진처럼](/blog/project/pay/pay-0-overview), 만들고 안 연결한 또 하나였다.

### 1. 그냥 붙이면 되는 게 아니었다

컬럼에 `@Convert`만 붙이면 될 줄 알았는데, 필드마다 접근 패턴이 달라서 그게 안 됐다.

계좌번호는 쉬웠다. 값으로 조회할 일이 없다(주문번호로 가상계좌를 찾지, 계좌번호로 찾지 않는다). 그냥 암호화하면 끝.

```java
@Convert(converter = EncryptedStringConverter.class)
@Column(length = 255)   // 암호문이 길어서 확장
private String accountNumber;
```

문제는 빌링키였다. 코드를 봤다.

```java
Optional<BillingKey> findByBillingKey(String billingKey);   // 값으로 조회
@Column(nullable = false, unique = true, length = 200)      // 유니크
private String billingKey;
```

빌링키는 유니크이고, 값으로 조회된다. 여기에 암호화를 붙이면 문제가 생긴다.

> envelope 암호화는 매번 새 DEK와 IV를 쓴다([그래서 안전하다](/blog/project/pay/pay-0-overview). 같은 값도 매번 다른 암호문이 나온다). 그런데 그게 바로 문제다. 같은 빌링키가 저장할 때마다 다른 암호문이 되니, (1) `WHERE billing_key = '암호화된값'` 조회가 절대 안 맞고, (2) 유니크 제약이 무의미해진다(다른 암호문이라 절대 충돌하지 않는다). 보안을 위한 암호화가 조회와 유니크를 깨뜨린다.

암호화하면 못 찾고, 못 찾으면 결제를 못 한다. 결제 시스템에서 민감 필드를 다룰 때 항상 나오는 벽이다.

### 2. 블라인드 인덱스가 존재하는 이유

해법은 결정적 인덱스를 따로 두는 것이다. 암호문이 못 하는 일(같은 입력=같은 값)을 대신해주는 컬럼이다.

```
billing_key         env:v1:...    ← envelope 암호문 (비결정적, 안전)
billing_key_index   a3f9c2...     ← HMAC-SHA256 (결정적, 유니크·조회용)
```

블라인드 인덱스는 빌링키를 secret으로 HMAC 해싱한 값이다. 같은 빌링키는 항상 같은 인덱스가 나온다. 덕분에 두 가지가 풀린다.

- 유니크를 인덱스 컬럼으로 옮긴다(같은 빌링키 → 같은 인덱스 → 충돌 감지).
- 조회를 인덱스로 한다: `findByBillingKey(raw)` → `raw`를 해싱 → `findByBillingKeyIndex(hash)`.

```java
public Optional<BillingKey> findByBillingKey(String raw) {
    return repository.findByBillingKeyIndex(indexer.index(raw));   // 원문을 해싱해 조회
}
```

빌링키 자체는 여전히 암호문으로 잠겨 있고(유출돼도 못 읽는다), 조회·유니크는 인덱스가 대신한다. HMAC은 일방향이라 인덱스만 봐선 빌링키를 역산 못 하고, secret이 없으면 인덱스를 만들 수도 없다. [블라인드 인덱스 클래스](/blog/project/pay/pay-0-overview)를 애초에 만든 이유가 이것이었는데, 실제로 써보고서야 왜 필요한지 체감했다.

그래서 필드마다 전략이 다르다.

| 필드 | 조회? | 전략 |
|---|---|---|
| 계좌번호 | 안 함 | 단순 암호화 |
| 구독의 빌링키 참조 | 안 함 (userId로 조회) | 단순 암호화 |
| **빌링키(원본)** | 함 (유니크·값 조회) | **암호화 + 블라인드 인덱스** |

### 3. 이미 있던 평문은 어쩌나

마지막 현실 문제는 마이그레이션 전에 저장된 평문 행들이다. 그걸 복호화하려 하면 `env:` 형식이 아니라 예외가 난다.

그래서 하위호환 한 줄을 넣었다.

```java
public String decrypt(String ciphertext) {
    if (!ciphertext.startsWith("env:")) return ciphertext;   // 레거시 평문 → 그대로
    ... // env: 형식만 복호화
}
```

`env:`로 시작하지 않으면 마이그레이션 전 평문으로 보고 그대로 돌려준다. 새로 저장되는 값은 항상 암호화되고, 옛 평문은 읽기만 된다. 한 번에 다 재암호화하지 않고 읽을 때·쓸 때 자연스럽게 넘어가는 점진적 마이그레이션이다.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, V10 마이그레이션(컬럼 확장·유니크 이전)은 실 MySQL validate로 검증했다.*

---

## 재시작하면 블랙리스트가 사라진다: 보안 상태의 수명, 그리고 README의 거짓말

저장된 데이터를 잠갔으니 다음은 살아 움직이는 보안 상태다. 차단·검증에 쓰이는 상태가 얼마나 오래, 어디까지 사는지를 감사가 짚었고, 덤으로 문서의 거짓말까지 나왔다.

### 0. 감사가 짚은 넷

전수 감사의 보안 관련 항목 넷을 이번에 마감했다. 각각 성격이 다른데 관통하는 주제가 있다. 보안 상태의 수명, 그리고 문서의 진실성.

### 1. 조용한 기본값: 웹훅 시크릿

[웹훅 서명 검증](/blog/project/pay/pay-ch1-what-to-trust)은 HMAC 시크릿으로 "이 웹훅이 진짜 PG가 보낸 것인지"를 확인한다. 그런데 그 시크릿이 이렇게 주입되고 있었다.

```java
@Value("${payment.webhook.secret:test-webhook-secret}")   // ← 기본값
```

`test-webhook-secret`이라는 약한 기본값을 조용히 쓰고 있었다. 운영에서 환경변수를 깜빡 안 넣으면? 앱은 아무 경고 없이 뜨고, 공개된 문자열로 서명을 검증한다. 공격자가 그 문자열로 서명을 위조해 가짜 웹훅을 보낼 수 있다.

이상한 건 [JWT 키는 이미 fail-fast](/blog/project/pay/pay-0-overview)였다는 점이다(미설정이면 기동 실패). 웹훅만 빠져 있었다. 일관성을 맞췄다.

```java
public WebhookSignatureVerifier(@Value("${payment.webhook.secret}") String secret) {
    // 미설정·약한 키면 기동 거부 — JWT 키와 같은 결
}
```

실기동으로 확인했다. 빈 시크릿으로 띄우니 앱이 뜨지 않는다.

```
Caused by: IllegalStateException: payment.webhook.secret 미설정 — 웹훅 서명 시크릿을 환경변수/시크릿으로 주입해야 합니다.
```

조용히 약한 값으로 도는 것보다 시끄럽게 죽는 게 보안에선 낫다. 잘못된 설정으로 프로덕션이 뜨는 걸 배포 시점에 막는다.

### 2. 재시작하면 사라지는 블랙리스트

FDS 사후 심사에서, 사기로 판정된 카드를 블랙리스트에 넣어 이후 결제를 차단하게 만들었다. 그런데 그 블랙리스트가 이랬다.

```java
private final Set<String> cardBlacklist = ConcurrentHashMap.newKeySet();   // in-memory
```

메모리에만 있었다.

> 앱을 재시작하면(배포, 장애 복구) 블랙리스트가 통째로 사라진다. 어제 사기로 차단한 카드가 오늘 배포 후엔 다시 통과한다. 보안 상태가 프로세스 수명만큼만 사는 것이다. 결제 차단 같은 상태는 프로세스보다 오래 살아야 한다.

여기서 판단이 하나 있었다. 블랙리스트를 어디에 저장하나. 새 테이블을 만들 수도 있지만, 진실 원천은 이미 DB에 있었다. 사기로 거부한 심사 리뷰(`REJECTED`)가 `fraud_reviews`에 남아 있다.

> 그래서 별도 저장소 대신 기동 시 REJECTED 리뷰에서 블랙리스트를 재구축하기로 했다. 인메모리 Set은 "캐시"로 두고, 진실 원천은 DB의 심사 이력으로 삼는다.

```java
@EventListener(ApplicationReadyEvent.class)
void reload() {
    fraudReviewRepository.findByStatus(REJECTED)
        .forEach(r -> fraudService.blacklistCard(r.getCardKey()));   // 기동 시 재적재
}
```

이제 재시작해도 어제 차단한 카드는 그대로 막힌다. "상태를 어디에 두느냐"보다 "진실 원천이 무엇이냐"를 먼저 물으니, 새 테이블 없이 풀렸다.

### 3. 한 프로세스만 세는 velocity

[FDS velocity 룰](/blog/project/pay/pay-0-overview)은 "1분에 카드로 몇 번 시도했나"를 세서 이상 패턴을 잡는다. 그런데 그 카운터가 인메모리였다.

> 서버가 여러 대면(실서비스는 당연히 그렇다) 각 인스턴스가 자기가 받은 요청만 센다. 공격자가 1분에 100번을 쳐도 10대에 분산되면 각각 10번밖에 못 봐서 velocity 룰이 안 걸린다. 인메모리 카운터는 다중 인스턴스에서 사실상 무력하다.

[rate limiter](/blog/project/pay/pay-0-overview)나 [토큰 저장소](/blog/project/pay/pay-0-overview)와 같은 문제였고, 해법도 같다. Redis 공유 카운터.

```java
// velocity:{cardKey}:{분} 을 모든 인스턴스가 공유해 INCR
Long n = redis.opsForValue().increment("velocity:" + key + ":" + epochMinute);
```

기존 인메모리 구현은 폴백·테스트용으로 남기고 Redis 구현을 기본으로 뒀다(`@Primary`). Redis가 죽으면 fail-open(velocity 통과 + 경고)이다. 사기 탐지는 보조 방어층이라, 그 층의 Redis 장애가 결제 전면 중단으로 번지면 안 된다.

실기동으로 결제를 일으키니 Redis에 velocity 키가 실제로 찍혔다.

```
velocity:card:pk-98E5E60F...:29723098
```

이제 여러 대가 하나의 카운터를 공유한다.

### 4. README가 거짓말을 하고 있었다

마지막 항목은 문서였다. 감사가 이걸 짚었다.

> README는 "MySQL + JPA + **QueryDSL**", "settlement: **Spring Batch** 정산"이라 명시하나, `build.gradle`에 둘 다 **의존조차 없다.**

쓰지도 않는 기술을 쓴다고 적어놨던 것이다. 초기 계획엔 있었는데 실제론 안 쓰게 됐고, 문서만 안 고친 듯하다. 사소해 보여도 정직성 문제다. 코드를 읽는 사람이 문서를 믿을 수 없게 된다.

그래서 고쳤다. QueryDSL은 삭제하고, 정산은 "일 단위 배치 집계(서비스 루프; 대용량은 Spring Batch로 확장 여지)"로 사실화했다. README에 "가정과 한계" 절도 새로 뒀다. 데모 사용자(인메모리), 단일 통화(KRW), 로컬 기본 시크릿(운영은 env 필수), 멀티 PG 미배선 같은 걸 숨기지 않고 적었다.

> "이건 이렇게 가정했고 여기까진 안 했다"를 적는 쪽이 "다 완벽하다"고 적는 것보다 믿음직하다. 결제처럼 신뢰가 생명인 도메인에선 특히 그렇다.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, 웹훅 fail-fast·블랙리스트 재적재·Redis velocity를 실기동으로 검증했다.*

---

## 남는 생각

다섯 건의 공통점이 있다. **전부 테스트는 통과하고 있었다.**

단위 테스트는 내가 상상한 경계를 검사한다. 상상하지 못한 경계는 **실제로 띄워야만** 나왔다. 프로세스가 재시작되는 것, 이벤트가 직렬화를 두 번 거치는 것, `@Scheduled` 가 있어도 `@EnableScheduling` 이 없는 것이 그랬다.

그래서 이후로는 기능을 만들 때마다 **한 번은 진짜로 돌려보는 것**을 절차에 넣었다.

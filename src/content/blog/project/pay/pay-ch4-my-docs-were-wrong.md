---
title: '내가 적어놓은 것이 틀렸다'
description: 'PG 문서는 깊게 읽어야만 함정이 보였고, 내 javadoc과 README는 아예 거짓이었고, 내가 낸 하드닝 추천은 웹서칭해보니 수치가 틀렸다.'
date: 2026-08-31T00:00:00.000Z
category: study/pay
coverImage: "/uploads/project/pay/thumbs/pay-ch4.svg"
draft: false
series: "결제 시스템 만들기"
seriesOrder: 5
tags:
  - Payment
  - 문서
  - 자가 감사
  - 검증
---

*결제 시스템 시리즈 5편. 문서를 믿었다가 틀린 기록들이다. 남의 문서도, 내 문서도.*

## 가상계좌: 문서를 깊게 읽어야만 보이는 두 함정


### 0. 입금을 기다리는 결제

가상계좌는 "계좌번호를 발급하고 입금을 기다리는" 결제다. 카드처럼 즉시 승인이 떨어지지 않고, 사용자가 나중에 그 계좌로 돈을 넣어야 완료된다. 상태 흐름은 `발급 → 입금대기 → 입금완료`.

기본은 [웹훅 처리](/blog/project/pay/pay-0-overview)으로 처리한다. 입금되면 PG가 웹훅을 보내고, 우리는 "믿지 말고 조회로 재검증"해서 완료 처리한다. 여기까진 쉽다. 토스페이먼츠 문서를 파고들면 함정 둘이 나온다.

### 1. 함정 ①: 만료엔 웹훅이 안 온다

입금기한(예: 7일)이 지나면 가상계좌가 만료된다. 여기에 함정이 있다.

> **EXPIRED 상태로 바뀔 때는 웹훅이 전송되지 않는다.** (토스페이먼츠 문서에 명시돼 있다.)

이걸 모르면 "웹훅으로 다 처리하니까 만료도 웹훅 오겠지" 하고 방치하게 된다. 그러면 만료된 가상계좌가 영원히 "입금대기"로 남아 재고나 쿠폰을 물고 있다. 그래서 **자체 만료 배치**가 필요하다.

```java
public int expireOverdue(Instant now) {
    // EXPIRED 웹훅이 안 오므로 직접 스캔한다
    List<VirtualAccount> overdue =
        repository.findByStatusAndDueDateBefore(WAITING_FOR_DEPOSIT, now);
    for (VirtualAccount va : overdue) {
        // 만료시키기 전에 PG에 조회 — 입금이 늦게 도착했을 수도 있으니까
        if (pgClient.query(va.getPaymentKey()).isApproved()) {
            va.confirmDeposit();   // 늦은 입금 → 완료 (만료 안 함)
        } else {
            va.expire();
        }
    }
    return overdue.size();
}
```

### 2. 만료-입금 레이스

위 코드에서 눈여겨볼 게 있다. 만료 배치가 도는 **바로 그 순간에 입금이 도착**할 수 있다. 만료시켜야 하나, 완료시켜야 하나?

답은 [앞서 세운 원칙](/blog/project/pay/pay-ch1-what-to-trust) 그대로다. **믿지 말고 PG에 조회.** 만료 대상이라도 조회해서 실제로 입금됐으면(APPROVED) 만료시키지 않고 완료 처리한다. dueDate만 보고 기계적으로 만료시키면 방금 입금한 사용자의 돈이 붕 뜬다.

> "가상계좌 만료 어떻게 처리하세요?"에 대한 답이 이것이다. "EXPIRED 웹훅이 없어서 배치로 감지하고, 만료 직전에 조회로 재확인해서 늦은 입금과의 레이스를 해소합니다." 문서를 대충 읽으면 절대 안 나오는 디테일이다.

### 3. 함정 ②: DONE에서 되돌아온다

두 번째 함정은 더 미묘하다.

> 일부 은행(신한 등)은 **입금 실패인데 DONE을 먼저 보낸 뒤, 최대 2분 후 되돌리는** 통보를 한다. `DONE → 입금대기`로 상태가 역전이되는 것이다.

보통 상태머신은 "완료(DONE)는 최종 상태"라고 가정한다. 가상계좌는 아니다. 그래서 상태머신에 **역전이를 허용 전이로** 넣었다.

```java
DONE → { WAITING_FOR_DEPOSIT, CANCELED }   // 은행 지연 통보로 인한 역전이
```

역전이가 오면 이미 보낸 "결제 완료" 후속 처리(알림, 포인트 적립 등)를 되돌려야 한다. 상태 전이 이력과 [보상 트랜잭션](/blog/project/pay/pay-ch1-what-to-trust) 발상이 여기서도 쓰인다.

### 4. 정리

가상계좌는 "입금 기다리기"라는 단순해 보이는 기능에 실무 함정이 숨어 있다.

| 함정 | 대응 |
|---|---|
| EXPIRED엔 웹훅 없음 | 자체 만료 배치(dueDate 스캔) |
| 만료-입금 레이스 | 만료 직전 조회로 재확인 |
| DONE→입금대기 역전이 | 상태머신에 역전이 허용 + 후속 처리 보상 |

> 세 가지 모두 문서 구석에서 건진 것들이다. "가상계좌 붙였어요"와 "EXPIRED 웹훅 부재와 DONE 역전이까지 처리했어요"는 깊이가 다르다. [이 시리즈의 원칙](/blog/project/pay/pay-ch1-what-to-trust), "웹훅을 믿지 말고 조회로 확정한다"·"실패/역전이를 상태머신에 새긴다"가 그대로 재사용됐다.

---

## 재감사 2회차: 부분취소만 멱등이 아니었고, 내가 2년 전에 쓴 설명이 틀렸다

### 0. 한 번 더 봤더니 또 있었다

[재감사에서 정산 날짜 키 버그를 잡고](/blog/project/pay/pay-ch3-money-leaks) "이제 됐나?" 하며 같은 눈으로 한 번 더 훑었더니 둘이 더 나왔다. 하나는 부분취소의 멱등성 구멍, 다른 하나는 **내가 예전에 써둔 설명이 틀렸다는 사실**이다.

### 1. 전액취소는 멱등인데, 부분취소는 아니었다

취소를 정산에 반영하는 코드가 이렇게 갈려 있었다.

```java
if (event.fullyCanceled()) {
    item.cancel();                       // 전액: status==CANCELED 가드로 재배달에도 멱등
} else {
    item.reduce(event.cancelAmount());   // 부분: 델타를 뺀다 → 재배달 시 또 뺀다 (버그)
}
```

전액취소는 "이미 CANCELED면 무시" 가드가 있어서 [at-least-once 재배달](/blog/project/pay/pay-ch1-what-to-trust)에 안전하다. 부분취소는 다르다. `reduce`로 델타(취소분)를 빼기만 한다.

> 이벤트는 아웃박스로 최소 한 번 이상 배달된다. 리스너가 성공했는데 완료 표시 전에 크래시가 나면 재기동 때 같은 취소 이벤트가 다시 온다. 그럼 `reduce(3000)`가 두 번 호출되어 **6000이 깎인다.** 실제론 3000만 취소했는데도. 가맹점이 취소분의 두 배를 덜 받는다. 멱등 가드가 부분취소 경로에만 빠져 있었고, 그 비대칭이 문제였다.

해법은 관점을 바꾸는 것이었다. 빼지 말고, 되어야 할 값으로 세팅하자. 결제 엔티티는 이미 `balanceAmount`(취소 후 잔액)를 들고 있었다. 그걸 이벤트에 실었다.

```java
// 이벤트가 델타(cancelAmount)만이 아니라 "취소 후 잔액(절대값)"을 함께 나른다
new PaymentCanceledEvent(orderNo, paymentId, cancelAmount, settleableBalance, fullyCanceled);
```

```java
// 정산은 델타를 빼는 대신, 잔액으로 세팅한다 → 몇 번 와도 같은 값
public void applySettleableBalance(long settleableBalance) {
    this.amount = Math.max(0L, settleableBalance);
}
```

이제 같은 취소가 세 번 와도 `amount`는 잔액 그대로다. **절대값 세팅은 본질적으로 멱등**이다. 델타(`cancelAmount`)는 원장 역분개와 에스크로 환불이 여전히 쓰기 때문에 같이 실어 보내고, 정산만 절대 잔액을 본다.

> 멱등성을 "중복을 감지해서 막는다"로 풀 수도 있다(취소 ID를 저장해 두고 비교). 더 단순한 건 **연산 자체를 멱등하게** 만드는 것. "빼기"를 "세팅"으로 바꾸니 감지 로직 없이 멱등이 됐다. 라이브로 부분취소 10,000을 걸어보니 정산액이 잔액 20,000으로 맞았다.

### 2. 그리고, 내가 틀렸던 설명

두 번째는 코드 밖에서 나왔다. **내 과거 글**이다. 재감사가 이렇게 짚었다.

> 코드 곳곳에 "`saveAndFlush`가 필요한 건 **OSIV를 꺼서** dirty-check 자동 flush가 안 되기 때문"이라는 주석이 있는데, 이건 **기술적으로 틀렸다.**

찔렸다. [예전에 영속 유실 버그를 잡은 글](/blog/project/pay/pay-ch2-runtime-truths)에서 내가 그렇게 설명했기 때문이다. 다시 보니 이랬다.

> **일반적인 read-write 트랜잭션 안에선, OSIV를 켜든 끄든 managed 엔티티의 변경은 커밋 때 dirty-check로 flush된다.** 증거가 같은 코드베이스에 있었다. `settle()`은 `items.forEach(SettlementItem::markSettled)`를 **save 없이** 부르는데 정상 SETTLED된다. "OSIV off면 자동 flush가 안 된다"면 이게 동작하면 안 된다. 내 설명은 이렇게 반증됐다.

그럼 [pay-26의 진짜 원인](/blog/project/pay/pay-ch2-runtime-truths)은 뭐였을까?

> 커밋되는데 managed 엔티티가 flush 안 되는 상황의 원인은 **세션 FlushMode가 AUTO가 아니었던 것**이다. `@Transactional(readOnly = true)` 조회가 끼면 Hibernate가 FlushMode를 **MANUAL**로 바꾸고, 이후 dirty 변경이 커밋 때 flush되지 않는다. 거기에 detached 엔티티(merge 필요)가 겹쳤다. OSIV off는 detached를 만드는 배경 조건에 그친다. flush를 직접 막은 건 FlushMode 쪽이다. 재밌는 건 정작 `CheckoutService`의 다른 주석은 "readOnly 조회로 세션 flush가 MANUAL"이라고 **정확히** 적혀 있었다는 점. 같은 코드베이스 안에서 주석끼리 설명이 엇갈리고 있었던 셈이다.

그래서 정정했다. 부정확한 주석 12곳을 "readOnly/detached라 자동 flush를 신뢰할 수 없어 명시 영속한다(pay-26 교훈)"로 고치고, pay-26 글에도 **정정 노트**를 달았다. `saveAndFlush`를 쓰는 정책 자체는 유효하다. 틀린 건 이유였다.

> 지울 수도 있었다. 어차피 draft고, 아무도 안 봤을 수도 있다. 안 지웠다. "예전엔 이렇게 이해했는데 다시 보니 틀렸고, 진짜는 이거다"를 남기는 쪽이 처음부터 다 맞은 척하는 것보다 정직하다. 틀린 걸 고친 흔적도 기록이다.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, 부분취소 멱등(잔액 세팅)은 실 MySQL로, OSIV 정정은 `settle()`의 save-less 동작으로 검증했다.*

---

## "이거 진짜 고치는 게 맞아?" 내 하드닝 추천을 웹서칭으로 검증하니, 하나는 수치가 틀렸고 하나는 방향이 틀렸다

### 0. "그거 진짜 고치는 게 맞아?"

재감사는 버그에 더해 하드닝 후보도 남겼다. [재감사](/blog/project/pay/pay-ch3-money-leaks)로 골라둔 후보 셋을 웹서칭으로 실무 기준과 대조했더니, 하나는 잘못된 수치를 들이대고 있었고 다른 하나는 방향 자체가 반대였다. 둘 다 내 추천이었다. 대조 전에 스스로 물은 질문은 하나. **"이거 진짜 고칠 값어치가 있나, 아니면 내가 억지 부리는 건가?"**

### 1. 멱등 TTL: "24시간으로 줄여라" 했다가 철회

첫 후보는 멱등키였다. 코드를 보니 `IdempotencyRecord.TTL = Duration.ofDays(15)`, **15일**이었다. 내 판단은 이랬다.

> "Stripe·Razorpay는 멱등키를 **24시간** 보관한다. 15일은 15배 과하다. 24h로 줄이자."

그럴듯했다. 그런데 코드 주석에 "**토스페이먼츠와 동일하게 15일**"이라고 적혀 있었다. 웹서칭해 보니 [토스페이먼츠 개발자센터](https://docs.tosspayments.com/guides/using-api/idempotency-key)가 명시하고 있었다.

> "멱등키는 처음 요청에 사용한 날부터 **15일** 간 유효합니다."

내가 틀렸다. 15일은 이 시스템이 모델링하는 **토스페이먼츠(한국 PG)에 의도적으로 맞춘 값**이었다. Stripe의 24시간이라는 미국 PG 기준을 토스를 모델링한 시스템에 무심코 들이댄 것이다. PG마다 정책이 다르다. Adyen은 최소 7일, Stripe 24h, 토스 15일.

그래서 "TTL을 줄여라"는 **철회**했다. 대신 진짜 문제는 따로 있었다.

> TTL은 15일인데, **만료된 레코드를 지우는 장치가 없어서** `idempotency_keys` 테이블이 무한히 자란다. [아웃박스 테이블이 그랬던 것](/blog/project/pay/pay-ch2-runtime-truths)과 같은 계열이다. 아웃박스엔 정리 스케줄러를 붙였는데 멱등 테이블은 빠져 있었다.

TTL은 그대로 두고(토스 정합), 유효기간 지난 레코드만 주기적으로 벌크 삭제하는 스케줄러를 붙였다.

```java
@Modifying
@Query("delete from IdempotencyRecord r where r.expiresAt < :threshold")
int deleteByExpiresAtBefore(Instant threshold);   // 한 건씩 아니라 벌크 삭제
```

웹서칭이 경고한 게 하나 더 있었다. "**한 건씩 지우면 정리가 뒤처진다**(Stripe도 그래서 TTL 인덱스로 옮김)"는 것. 그래서 엔티티 loop 삭제를 피하고 단일 벌크 DELETE로 했다. 실 MySQL로 만료(5일 전) 삭제·유효(15일 후) 유지를 확인했다.

"업계 표준"을 안다고 아무 데나 들이대면 안 된다. 이 시스템이 **어느 PG를 모델링하는지**가 정답을 바꾼다. 검증 안 했으면 멀쩡한 값을 15배 잘못 줄일 뻔했다.

### 2. PG 콜 in 트랜잭션: "득 없다" 했다가, 실사고들 앞에서 인정

두 번째는 반대 방향으로 틀렸다. 체크아웃이 **PG 승인(외부 HTTP)을 DB 트랜잭션 안에서** 호출하고 있었다. 처음 내 결론은 이랬다.

> "안티패턴이긴 한데, 정합성은 이미 [UNKNOWN 복구](/blog/project/pay/pay-ch1-what-to-trust)로 해결됐고, 커넥션 점유는 fast-fail로 완화되니 **득이 별로 없다. 그냥 문서화하자.**"

그런데 [읽는 분이](/blog) 되물었다. "득이 진짜 없어? 현업은 어떤데?" 웹서칭해 보니 이번에도 내가 틀렸다.

> 외부 API 콜 중 DB 커넥션을 붙잡는 건 "**classic leak pattern, silent killer**"로 불린다. 실제 장애 사례가 수두룩하다. 다운스트림 지연으로 인한 연쇄 결제 실패, 느린 쿼리가 커넥션을 소진시킨 수 시간 outage, 트래픽 2배에 커넥션 풀 고갈. 심지어 "**서킷브레이커도 기다리는 동안 풀이 찬다**"고 명시돼 있었다. 내가 "완화됐다"던 그 서킷브레이커가 완전히 막지 못한다는 뜻이다. 득은 실재했다.

"득 없다"는 접었다. 그럼 고쳐야 하나? 여기서 한 겹이 더 있었다.

> 현업 정석은 이 흐름을 **사가로 쪼개는** 것. 짧은 로컬 트랜잭션(예약) → PG(트랜잭션 밖) → 확정/보상이다. 그런데 트레이스해 보니 이 시스템은 **모듈러 모놀리스**라 체크아웃이 단일 트랜잭션, 곧 진짜 ACID 원자성을 갖고 있었다. 사가로 쪼개면 그 원자성을 포기하게 되고, 예약(포인트 선점)이 커밋된 뒤 확정 단계를 크래시로 못 하면 어중간하게 **멈춘 사가**가 남는다. 이걸 복구하는 게 사가의 진짜 어려운 부분이고, 여기까지 안 하면 오히려 회귀(포인트 누수)다.

"외부 콜을 트랜잭션 밖으로"는 고규모·MSA의 규칙이다. 모놀리스에서 ACID를 포기하며 사가 복잡도를 떠안는 건 이 규모에선 과할 수 있다. 커넥션 점유 위험은 `connection-timeout: 3s`가 이미 상한을 걸어준다. 느린 PG여도 3초 안에 떨어진다.

최종 판단은 리팩터 대신 [ADR](https://github.com/dj258255/payment-system)로 남기는 것이었다.

> ADR-007에 이렇게 적었다. 안티패턴을 **인지**하고(실사고 인용), 이 모놀리스에선 ACID 원자성을 위해 **의도적으로** 단일 트랜잭션을 유지하며, fast-fail·서킷·UNKNOWN 복구로 완화하고, 스케일이 요구하면 **3단계 사가로 이행**하는 경로(멈춘 사가 복구 포함)를 명시했다. "규칙과 예외를 알고 이 규모에선 원자성을 택한 것"을 기록으로 남긴 셈이다. 규칙을 몰라서 지나친 것으로 읽히지 않게 하는 장치이기도 하다.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, 멱등 purge는 실 MySQL로, 체크아웃 트랜잭션 경계는 ADR-007로 트레이드오프를 남겼다.*

---

## 테스트에서만 살아 있던 failover: 만들어둔 멀티 PG 라우팅을 배선하다, 그리고 TIMEOUT엔 절대 failover하지 않는 이유

### 0. 또 하나의 "만들고 안 쓴 것"

부르는 사람 없는 코드는 정산 배치로 끝나지 않았다. [전수 감사](/blog/project/pay/pay-ch2-runtime-truths)가 짚은 패턴, [금고를 만들고 안 채우고](/blog/project/pay/pay-ch2-runtime-truths) [배치를 만들고 안 부르던](/blog/project/pay/pay-ch2-runtime-truths) 그 패턴이 PG에도 있었다.

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

### 3. 이 라우터의 진짜 값어치: 아무 때나 failover하지 않는다

failover의 어려운 부분은 **"언제 넘기면 안 되나"**다. "언제 넘길까"는 상대적으로 쉬운 질문이다. `RoutingPgClient`는 결과를 이렇게 나눈다.

| PG 응답 | failover | 이유 |
|---|---|---|
| SUCCESS | 안 함 | 성공, 끝 |
| FAILED(카드 거절) | 안 함 | 다른 PG도 거절할 것 |
| **TIMEOUT(미확정)** | **절대 안 함** | **다른 PG로 재시도 = 이중결제 위험** |
| 예외·서킷 오픈 | 함 | PG가 요청을 못 받음 → 다음 PG |

핵심은 세 번째 줄이다.

> [PG 타임아웃은 "결과를 모른다"는 뜻](/blog/project/pay/pay-ch1-what-to-trust)이다. 원 PG에서 이미 승인됐을 수 있다. 이때 "실패했나 보다" 하고 다른 PG로 넘겨 재승인하면 **두 PG에서 이중으로 결제**된다. 그래서 TIMEOUT은 failover하지 않고 그대로 UNKNOWN으로 돌려, [복구 배치가 나중에 조회로 확정](/blog/project/pay/pay-ch2-runtime-truths)하게 맡긴다. failover는 "PG가 요청을 **못 받았을 때**"(연결 실패·서킷 오픈)만 한다.

failover를 "실패하면 다음으로"라고 단순하게 짜면 이 이중결제 함정에 바로 빠진다. 결제에서 재시도·failover는 항상 멱등성과 이중청구를 먼저 물어야 한다.

### 4. 남겨둔 한계: 원 PG 라우팅

하나는 남겨뒀다. 취소·조회는 원래 결제를 처리한 **그 PG**로 가야 맞다(A PG로 승인했으면 A PG로 취소). `Payment.pgProvider`에 어느 PG였는지 기록은 돼 있는데, 정작 `PgClient.cancel(paymentKey, ...)` 인터페이스가 provider를 안 받는다. 그래서 지금은 "가용한 첫 PG"로 시도한다.

> 제대로 하려면 인터페이스에 provider 힌트를 넣어 라우터가 원 PG로 보내야 한다. 인터페이스를 건드리는 일이라 [후속 과제로 명시](/blog/project/pay/pay-ch2-runtime-truths)했다. "여기까진 했고 여기부턴 안 했다"를 적는 쪽이 안 한 걸 숨기는 것보다 낫다.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있다. `app.pg.routing.enabled=true`로 라우터가 pgDelegate로 배선되어 결제가 라우팅 경로로 승인되는 것을 실기동으로 확인했다.*

---

## 남는 생각

**남의 문서는 깊게 읽어야 보이고, 내 문서는 틀려 있었다.**

앞엣것은 노력의 문제라 읽으면 된다. 뒤엣것이 어렵다 — 내가 쓴 걸 내가 다시 읽으면 **쓸 때 생각한 것이 그대로 보인다.** 코드가 그 사이에 바뀌었어도.

그래서 나중에는 **문서와 코드를 기계로 대조하는 테스트**를 만들게 됐다. ERD 문서 대 마이그레이션, API 스펙 대 실제 에러 코드, 원인 분류 수 대 규칙. 사람이 알아채길 기다리지 않는 쪽이 쌌다.

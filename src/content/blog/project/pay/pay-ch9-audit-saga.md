---
title: '재감사·하드닝 검증·사가 리팩터'
description: '재감사 2회차가 잡은 부분취소 멱등, 웹서칭으로 검증한 하드닝 추천, 그리고 ADR로만 안다고 적어둔 크라운주얼 체크아웃을 진짜 사가로 뜯다.'
date: 2026-02-01T00:00:00.000Z
tags:
  - Payment
  - Spring Boot
  - Spring Modulith
  - 결제 시스템
category: project/pay
draft: false
series: "결제 시스템 만들기"
seriesOrder: 9
---

*결제 시스템 시리즈 — 재감사·하드닝 검증·사가 리팩터. (원 연재 여러 편을 한 챕터로 묶었다. 각 절이 원래 한 편이다.)*

## 재감사 2회차 — 부분취소만 멱등이 아니었고, 내가 2년 전에 쓴 설명이 틀렸다

### 0. 한 번 더 봤더니 또 있었다

[재감사에서 정산 날짜 키 버그를 잡고](/blog/project/pay/pay-ch8-settlement-pg-webhook) "이제 됐나?" 하며 같은 눈으로 한 번 더 훑었더니 둘이 더 나왔다. 하나는 부분취소의 멱등성 구멍, 다른 하나는 **내가 예전에 써둔 설명이 틀렸다는 사실**이다.

### 1. 전액취소는 멱등인데, 부분취소는 아니었다

취소를 정산에 반영하는 코드가 이렇게 갈려 있었다.

```java
if (event.fullyCanceled()) {
    item.cancel();                       // 전액: status==CANCELED 가드로 재배달에도 멱등
} else {
    item.reduce(event.cancelAmount());   // 부분: 델타를 뺀다 → 재배달 시 또 뺀다 (버그)
}
```

전액취소는 "이미 CANCELED면 무시" 가드가 있어서 [at-least-once 재배달](/blog/project/pay/pay-ch1-payment-core)에 안전하다. 부분취소는 다르다. `reduce`로 델타(취소분)를 빼기만 한다.

> 이벤트는 아웃박스로 최소 한 번 이상 배달된다. 리스너가 성공했는데 완료 표시 전에 크래시가 나면 재기동 때 같은 취소 이벤트가 다시 온다. 그럼 `reduce(3000)`가 두 번 호출되어 **6000이 깎인다.** 실제론 3000만 취소했는데도. 가맹점이 취소분의 두 배를 덜 받는다. 전액은 멱등이고 부분만 아닌 비대칭이 문제였다.

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

### 2. 그리고 — 내가 틀렸던 설명

두 번째는 코드가 아니라 **내 과거 글**이었다. 재감사가 이렇게 짚었다.

> 코드 곳곳에 "`saveAndFlush`가 필요한 건 **OSIV를 꺼서** dirty-check 자동 flush가 안 되기 때문"이라는 주석이 있는데, 이건 **기술적으로 틀렸다.**

찔렸다. [예전에 영속 유실 버그를 잡은 글](/blog/project/pay/pay-ch5-runtime-truths)에서 내가 그렇게 설명했기 때문이다. 다시 보니 이랬다.

> **일반적인 read-write 트랜잭션 안에선, OSIV를 켜든 끄든 managed 엔티티의 변경은 커밋 때 dirty-check로 flush된다.** 증거가 같은 코드베이스에 있었다. `settle()`은 `items.forEach(SettlementItem::markSettled)`를 **save 없이** 부르는데 정상 SETTLED된다. "OSIV off면 자동 flush가 안 된다"면 이게 동작하면 안 된다. 내 설명은 이렇게 반증됐다.

그럼 [pay-26의 진짜 원인](/blog/project/pay/pay-ch5-runtime-truths)은 뭐였을까?

> 커밋되는데 managed 엔티티가 flush 안 되는 상황의 원인은 **세션 FlushMode가 AUTO가 아니었던 것**이다. `@Transactional(readOnly = true)` 조회가 끼면 Hibernate가 FlushMode를 **MANUAL**로 바꾸고, 이후 dirty 변경이 커밋 때 flush되지 않는다. 거기에 detached 엔티티(merge 필요)가 겹쳤다. OSIV off는 detached를 만드는 배경일 뿐, flush를 막는 직접 원인이 아니다. 재밌는 건 정작 `CheckoutService`의 다른 주석은 "readOnly 조회로 세션 flush가 MANUAL"이라고 **정확히** 적혀 있었다는 점. 한쪽에선 맞게, 다른 쪽에선 틀리게 설명하고 있었던 셈이다.

그래서 정정했다. 부정확한 주석 12곳을 "readOnly/detached라 자동 flush를 신뢰할 수 없어 명시 영속한다(pay-26 교훈)"로 고치고, pay-26 글에도 **정정 노트**를 달았다. `saveAndFlush`를 쓰는 정책 자체는 유효하다. 틀린 건 이유였다.

> 지울 수도 있었다. 어차피 draft고, 아무도 안 봤을 수도 있다. 안 지웠다. "예전엔 이렇게 이해했는데 다시 보니 틀렸고, 진짜는 이거다"를 남기는 쪽이 처음부터 다 맞은 척하는 것보다 정직하다. 틀린 걸 고친 흔적도 기록이다.

### 마치며

이번 라운드가 남긴 건 두 가지 정정이다. 부분취소는 델타 차감을 잔액 세팅으로 바꿔 멱등해졌고, 주석 12곳과 과거 글 하나가 고쳐졌다. `settle()`이 save 없이 도는 걸 보고 "어? 그럼 내 OSIV 설명이 틀린 거 아냐?" 하고 멈춘 순간이 제일 값졌다. 코드만이 아니라 내가 안다고 적어둔 설명도 감사 대상이었던 것이다.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, 부분취소 멱등(잔액 세팅)은 실 MySQL로, OSIV 정정은 `settle()`의 save-less 동작으로 검증했다.*

<hr />

## 이거 진짜 고치는 게 맞아?" — 내 하드닝 추천을 웹서칭으로 검증하니, 하나는 수치가 틀렸고 하나는 방향이 틀렸다

### 0. "그거 진짜 고치는 게 맞아?"

재감사는 버그만 남긴 게 아니라 하드닝 후보도 남겼다. [재감사](/blog/project/pay/pay-ch8-settlement-pg-webhook)로 골라둔 후보 셋을 웹서칭으로 실무 기준과 대조했더니, 하나는 잘못된 수치를 들이대고 있었고 다른 하나는 방향 자체가 반대였다. 둘 다 내 추천이었다. 대조 전에 스스로 물은 질문은 하나. **"이거 진짜 고칠 값어치가 있나, 아니면 내가 억지 부리는 건가?"**

### 1. 멱등 TTL — "24시간으로 줄여라" 했다가 철회

첫 후보는 멱등키였다. 코드를 보니 `IdempotencyRecord.TTL = Duration.ofDays(15)`, **15일**이었다. 내 판단은 이랬다.

> "Stripe·Razorpay는 멱등키를 **24시간** 보관한다. 15일은 15배 과하다 — 24h로 줄이자."

그럴듯했다. 그런데 코드 주석에 "**토스페이먼츠와 동일하게 15일**"이라고 적혀 있었다. 웹서칭해 보니 [토스페이먼츠 개발자센터](https://docs.tosspayments.com/guides/using-api/idempotency-key)가 명시하고 있었다.

> "멱등키는 처음 요청에 사용한 날부터 **15일** 간 유효합니다."

내가 틀렸다. 15일은 임의값이 아니라, 이 시스템이 모델링하는 **토스페이먼츠(한국 PG)에 의도적으로 맞춘 값**이었다. Stripe의 24시간이라는 미국 PG 기준을 토스를 모델링한 시스템에 무심코 들이댄 것이다. PG마다 정책이 다르다. Adyen은 최소 7일, Stripe 24h, 토스 15일.

그래서 "TTL을 줄여라"는 **철회**했다. 대신 진짜 문제는 따로 있었다.

> TTL은 15일인데, **만료된 레코드를 지우는 장치가 없어서** `idempotency_keys` 테이블이 무한히 자란다. [아웃박스 테이블이 그랬던 것](/blog/project/pay/pay-ch7-consume-align-harden)과 같은 계열이다. 아웃박스엔 정리 스케줄러를 붙였는데 멱등 테이블은 빠져 있었다.

TTL은 그대로 두고(토스 정합), 유효기간 지난 레코드만 주기적으로 벌크 삭제하는 스케줄러를 붙였다.

```java
@Modifying
@Query("delete from IdempotencyRecord r where r.expiresAt < :threshold")
int deleteByExpiresAtBefore(Instant threshold);   // 한 건씩 아니라 벌크 삭제
```

웹서칭이 경고한 게 하나 더 있었다. "**한 건씩 지우면 정리가 뒤처진다**(Stripe도 그래서 TTL 인덱스로 옮김)"는 것. 그래서 엔티티 loop 삭제가 아니라 단일 벌크 DELETE로 했다. 실 MySQL로 만료(5일 전) 삭제·유효(15일 후) 유지를 확인했다.

"업계 표준"을 안다고 아무 데나 들이대면 안 된다. 이 시스템이 **어느 PG를 모델링하는지**가 정답을 바꾼다. 검증 안 했으면 멀쩡한 값을 15배 잘못 줄일 뻔했다.

### 2. PG 콜 in 트랜잭션 — "득 없다" 했다가, 실사고들 앞에서 인정

두 번째는 반대 방향으로 틀렸다. 체크아웃이 **PG 승인(외부 HTTP)을 DB 트랜잭션 안에서** 호출하고 있었다. 처음 내 결론은 이랬다.

> "안티패턴이긴 한데, 정합성은 이미 [UNKNOWN 복구](/blog/project/pay/pay-ch1-payment-core)로 해결됐고, 커넥션 점유는 fast-fail로 완화되니 **득이 별로 없다. 그냥 문서화하자.**"

그런데 [읽는 분이](/blog) 되물었다. "득이 진짜 없어? 현업은 어떤데?" 웹서칭해 보니 이번에도 내가 틀렸다.

> 외부 API 콜 중 DB 커넥션을 붙잡는 건 "**classic leak pattern, silent killer**"로 불린다. 실제 장애 사례가 수두룩하다. 다운스트림 지연으로 인한 연쇄 결제 실패, 느린 쿼리가 커넥션을 소진시킨 수 시간 outage, 트래픽 2배에 커넥션 풀 고갈. 심지어 "**서킷브레이커도 기다리는 동안 풀이 찬다**"고 명시돼 있었다. 내가 "완화됐다"던 그 서킷브레이커가 완전히 막지 못한다는 뜻이다. 득은 실재했다.

"득 없다"는 접었다. 그럼 고쳐야 하나? 여기서 한 겹이 더 있었다.

> 현업 정석은 이 흐름을 **사가로 쪼개는** 것. 짧은 로컬 트랜잭션(예약) → PG(트랜잭션 밖) → 확정/보상이다. 그런데 트레이스해 보니 이 시스템은 **모듈러 모놀리스**라 체크아웃이 단일 트랜잭션, 곧 진짜 ACID 원자성을 갖고 있었다. 사가로 쪼개면 그 원자성을 포기하게 되고, 예약(포인트 선점)이 커밋된 뒤 확정 단계를 크래시로 못 하면 어중간하게 **멈춘 사가**가 남는다. 이걸 복구하는 게 사가의 진짜 어려운 부분이고, 여기까지 안 하면 오히려 회귀(포인트 누수)다.

"외부 콜을 트랜잭션 밖으로"는 고규모·MSA의 규칙이다. 모놀리스에서 ACID를 포기하며 사가 복잡도를 떠안는 건 이 규모에선 과할 수 있다. 커넥션 점유 위험은 `connection-timeout: 3s`가 이미 상한을 걸어준다. 느린 PG여도 3초 안에 떨어진다.

최종 판단은 리팩터 대신 [ADR](https://github.com/dj258255/payment-system)로 남기는 것이었다.

> ADR-007에 이렇게 적었다. 안티패턴을 **인지**하고(실사고 인용), 이 모놀리스에선 ACID 원자성을 위해 **의도적으로** 단일 트랜잭션을 유지하며, fast-fail·서킷·UNKNOWN 복구로 완화하고, 스케일이 요구하면 **3단계 사가로 이행**하는 경로(멈춘 사가 복구 포함)를 명시했다. "규칙을 몰라서 안 한 것"이 아니라 "규칙과 예외를 알고 이 규모에선 원자성을 택한 것"을 기록으로 남긴 셈이다.

### 마치며

코드보다 판단을 검증한 라운드였다. 멱등 TTL은 토스 15일이 정답이라 추천을 철회하고 purge 스케줄러만 붙였다. PG 콜 in 트랜잭션은 "득 없다"를 접되, 이 규모에선 원자성을 지키는 쪽으로 ADR-007에 트레이드오프를 남겼다. 어느 PG를 모델링하는지, 모놀리스인지 MSA인지에 따라 같은 규칙의 답이 달라진다는 걸 두 후보가 각자 다른 방식으로 보여줬다.

다만 ADR은 어디까지나 문서다. "안다"고 적어둔 그 안티패턴을 결국 코드로 뜯게 되는데, 그게 다음 절이다.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, 멱등 purge는 실 MySQL로, 체크아웃 트랜잭션 경계는 ADR-007로 트레이드오프를 남겼다.*

<hr />

## ADR로 "안다"고 적어놓고 — 크라운주얼 체크아웃을 진짜 사가로 뜯다

### 0. "그래서 진짜 뜯은 거야?"

결국 뜯었다. 체크아웃은 외부 PG 승인(HTTP)을 DB 트랜잭션 안에서 호출하고 있었고, 이 [알려진 안티패턴](/blog/project/pay/pay-ch9-audit-saga)을 앞 절에서 [ADR](https://github.com/dj258255/payment-system)로 정리해 뒀다. "안티패턴은 알지만, 모놀리스라 ACID 원자성을 위해 의도적으로 단일 트랜잭션을 두고, fast-fail·서킷으로 완화한다." 판단으로는 괜찮았다. 그런데 되물음이 왔다.

> "그래서 **진짜 트랜잭션 꺼낸 거야?** ADR만 쓴 거 아니고?"

맞다, ADR만 썼다. 코드는 그대로였다. 그래서 뜯었고, 이 절이 그 기록이다.

### 1. 어떤 문제였나 — 구체적으로

평상시엔 아무 문제 없다. PG가 100ms에 응답하면 커넥션 100ms 점유하고 끝. 문제는 **PG 브라운아웃**, 죽진 않고 느려지는 상황이다.

> 토스가 장애가 아니라 **지연**만 생겨서 응답이 2~3초로 늘어난다고 해보자. 이제 체크아웃 하나당 DB 커넥션을 2~3초씩 붙잡는다. Hikari 풀은 20개인데, 초당 체크아웃 10건 × 3초면 커넥션이 고갈된다. 그럼 체크아웃뿐 아니라 **주문 조회·어드민·다른 모든 DB 요청**이 커넥션을 못 얻어 앱 전체가 멈춘다. 느린 PG 하나가 서비스 전체를 다운시키는 것이다.

제일 뼈아픈 건, 내가 "완화됐다"던 장치들이 이걸 못 막는다는 점이었다.

- **서킷브레이커**는 PG가 *에러*를 낼 때만 열린다. 느리지만 성공하는 브라운아웃은 에러가 아니라 안 열린다.
- **fast-fail 3초**는 커넥션을 *얻을 때까지* 기다리는 상한이지, *붙잡는 시간*이 아니다.

"외부 콜을 트랜잭션 안에 두지 마라"는 규칙은 실제 장애를 일으키는 위험이었다.

### 2. 3단계 사가 — 트랜잭션을 쪼개다

해법은 PG 콜을 트랜잭션 **밖**으로 빼는 것. 체크아웃을 3단계로 쪼갰다.

```java
public CheckoutResult confirm(...) {
    // 1단계 (tx): 예약 — 검증·주문잠금·포인트선점·결제 IN_PROGRESS 적재. 커밋 후 커넥션 반납.
    var reservation = checkoutTx.reserve(...);

    // 2단계 (tx 밖): PG 승인 — 이 동안 DB 커넥션 0개 점유
    var outcome = paymentService.pgApprove(...);

    // 3단계 (tx): 확정/보상 — 결과 반영·재고차감·PAID 또는 롤백
    return checkoutTx.settle(reservation.paymentId(), ..., outcome);
}
```

이제 느린 PG여도 **DB 커넥션을 안 잡으니 풀이 마르지 않는다.** 체크아웃만 PG를 기다리느라 느려질 뿐, 앱 전체는 멀쩡하다. 폭발 반경이 격리됐다.

배선에서 신경 쓴 건 **모듈 경계**였다. PG 결과 타입(`PgApproveResult`)은 payment 모듈 내부라, order가 참조하면 [Modulith 경계](/blog/project/pay/pay-ch4-arch-events-ops)가 깨진다. 그래서 노출용 `ApprovalOutcome`을 payment 루트에 두고, order는 그걸 불투명하게 PG 승인 단계에서 확정 단계로 건넨다. `CheckoutService`는 클래스 `@Transactional`을 떼서 오케스트레이터로 두고, 트랜잭션 경계(`reserve`/`settle`)는 별도 빈(`CheckoutTx`)에 뒀다. [자기호출이면 트랜잭션이 우회되기 때문이다](/blog/project/pay/pay-ch8-settlement-pg-webhook).

### 3. 진짜 어려운 부분 — 멈춘 사가 복구

사가엔 공짜가 없다. **원자성을 포기**하는 순간 새 크래시 엣지케이스가 생긴다.

> 예약 단계에서 포인트 선점이 커밋됐는데, 확정 단계 전에 앱이 죽으면? 주문은 `PAYMENT_IN_PROGRESS`로, 결제는 `IN_PROGRESS`로, 포인트는 예약된 채 **어중간하게 멈춘 사가**가 남는다. 단일 트랜잭션이면 크래시 시 깔끔히 롤백됐을 상황이다. 사가는 이 멈춘 상태를 **직접 복구**해야 하고, 여기까지 안 하면 오히려 회귀다. 포인트가 뜬 채 새어나가기 때문이다.

이게 사가의 실제 비용이다. 복구 배치를 만들었다.

```java
// PAYMENT_IN_PROGRESS로 멈춘 주문을 스캔 → 카드 결제를 PG 조회로 확정 → settle 재실행
Optional<StuckPaymentInfo> info = paymentService.resolveStuckPayment(orderNo);
long cardAmount = info.map(amount).orElse(0);
long pointAmount = order.getTotalAmount() - cardAmount;  // 금액 불변식에서 도출
checkoutTx.settle(orderNo, ..., cardAmount, pointAmount, info.map(outcome).orElse(null));
```

PG 조회로 실제 결과를 확정한 뒤, **같은 `settle`을 재실행**한다. 승인됐으면 완결(재고차감·PAID), 실패면 롤백(포인트 복원·PENDING 복귀). 핵심은 `settle`이 재진입 가능하다는 것. 결제 확정(`applyResult`)이 [멱등](/blog/project/pay/pay-ch9-audit-saga)(IN_PROGRESS일 때만 전이)이라, 복구가 몇 번 돌아도 안전하다.

### 4. 라이브로 증명

말로만 "된다"가 아니라, [실기동으로](/blog/project/pay/pay-ch5-runtime-truths) 두 경로를 확인했다.

```
정상 체크아웃 → order PAID / payment DONE           (3단계 사가 정상)
멈춘 사가(주문 IN_PROGRESS + 결제 IN_PROGRESS) 심음
→ 복구 배치 → PG 조회(NOT_FOUND) → 주문 PENDING_PAYMENT / 결제 ABORTED   (롤백 완결)
로그: "멈춘 체크아웃 복구 완료 recovered=1"
```

멈춘 사가가 실제로 롤백되어 재시도 가능 상태로 돌아왔다. 크래시 복구까지 코드로 도는 걸 확인한 것이다. 테스트 451개, 기존 체크아웃 동작(성공·미확정·거절·재고부족 보상·복합결제)도 같은 단언으로 전부 보존됐다.

### 마치며

"안다"를 "한다"로 바꾼 라운드였다. 막상 뜯어 보니 트랜잭션을 셋으로 쪼개는 리팩터 자체는 짧았고, 작업의 대부분은 멈춘 사가 복구 배치와 재진입 가능한 `settle`이었다. 원자성을 커넥션 점유와 맞바꾸는 순간 멈춘 사가를 복구할 책임이 따라오고, 그 책임까지 감당해야 사가로 풀었다고 말할 수 있다. "이 규모엔 안 해도 된다"는 ADR의 판단은 여전히 유효하다. 다만 이제 그 문서 옆에, 실제로 도는 코드와 `recovered=1` 로그가 같이 있다.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, 3단계 사가 정상 흐름과 멈춘 사가 복구를 실 MySQL로 검증했다(ADR-007에 배경·이행 기록).*

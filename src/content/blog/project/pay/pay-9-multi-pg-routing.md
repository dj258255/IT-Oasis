---
title: '멀티 PG 라우팅 — 그런데 아무 때나 failover하면 안 된다'
titleEn: "Multi-PG Routing — But You Must Not Fail Over Whenever You Feel Like It"
description: 결제 시스템 확장 1. PG 하나가 장애 나면 매출이 멈춘다. 그래서 여러 PG를 가중치로 라우팅하고 장애 시 다음 PG로 넘긴다. 그런데 핵심은 "언제 failover하면 안 되는가"다 — 카드 거절은 다른 PG도 거절하니 넘겨봐야 소용없고, 타임아웃은 넘기면 이중결제가 난다. 예외/서킷오픈처럼 "PG가 요청을 아예 못 받은" 경우에만 failover한다.
descriptionEn: "Payment system extension 1. If one PG goes down, revenue stops. So I route across multiple PGs by weight and fail over when one is down. But the crux is knowing when NOT to fail over — a card decline will be declined by other PGs too, and a timeout, if retried on another PG, causes a double charge. Only fail over when the PG never received the request (exception/open circuit)."
date: 2026-07-14T00:00:00.000Z
tags:
  - Payment
  - Multi-PG
  - Failover
  - Circuit Breaker
  - Resilience
  - Java
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 9
---

*결제 시스템 시리즈. 확장 기능 1편 — 멀티 PG 라우팅과 failover의 함정.*

## 0. PG 하나에 매출을 걸지 않는다

국내 상위 PG사도 실제로 한 시간씩 장애가 나요. 단일 PG만 연동했으면 그 한 시간 동안 **매출이 통째로 멈춰요.** 그래서 여러 PG를 두고, 하나가 죽으면 다른 PG로 넘기는(failover) 게 필요해요.

[Phase 2](/blog/project/pay/pay-2-designing-for-failure)에서 PG를 `PgClient`로 추상화하고 서킷브레이커를 붙여둔 덕에, 이건 그 위에 라우터 하나를 얹는 일이에요.

```java
RoutingPgClient(List.of(
    PgRoute.of("TOSS", tossAdapter, 10),   // 가중치 높은 PG 먼저
    PgRoute.of("NICE", niceAdapter, 5)));
```

가중치로 우선순위를 줘요(수수료 낮은 PG를 높게 두면 비용 최적화도 되고요). 각 PG는 **자체 서킷브레이커**로 보호돼서, 계속 실패하는 PG는 아예 건너뛰어요.

## 1. 진짜 어려운 건 "언제 failover하면 안 되는가"

여기가 이 기능의 핵심이에요. "장애면 다음 PG로" 는 쉬운데, **아무 때나 넘기면 사고가 나요.** 결과를 네 가지로 나눠서 각각 다르게 처리해요.

```java
try {
    PgApproveResult result = route.circuitBreaker()
            .executeSupplier(() -> route.adapter().approve(command));
    return result;   // ← SUCCESS/FAILED/TIMEOUT 모두 여기서 반환 (failover 안 함)
} catch (RuntimeException e) {
    // PG가 요청을 아예 못 받음(연결 실패/서킷 오픈) → 다음 PG로 failover
}
```

| PG 응답 | failover? | 왜 |
|---|---|---|
| **SUCCESS** | ❌ | 됐으니까 |
| **FAILED** (카드 거절) | ❌ | **다른 PG도 거절해요.** 잔액 부족은 어느 PG로 가도 부족하죠 |
| **TIMEOUT** (미확정) | ❌ **절대** | **이중결제 위험.** 원 PG에서 이미 처리됐을 수 있는데 다른 PG로 또 쏘면 두 번 결제돼요 |
| **예외 / 서킷 오픈** | ✅ | PG가 **요청을 아예 못 받았어요.** 안전하게 다른 PG로 |

> 이게 [Phase 2의 "타임아웃은 실패가 아니다"](/blog/project/pay/pay-2-designing-for-failure)와 정확히 같은 논리예요. 타임아웃은 "PG가 처리했는지 모르는" 상태라, 다른 PG로 재시도하는 순간 이중결제 리스크가 생겨요. 그래서 failover는 **"PG가 요청을 못 받은 게 확실할 때"**(연결 실패·서킷 오픈)만 해요. 모든 PG가 안 되면? UNKNOWN으로 돌려서 [복구 배치](/blog/project/pay/pay-2-designing-for-failure)에 맡겨요.

## 2. 테스트로 못 박기

failover 규칙을 시나리오별로 테스트했어요. 특히 "failover하면 안 되는" 케이스를요.

```java
@Test
@DisplayName("타임아웃(미확정)은 failover하지 않는다 — 이중결제 방지")
void noFailoverOnTimeout() {
    StubPg toss = new StubPg("TOSS").returns(PgApproveResult.timeout("응답 없음"));
    StubPg nice = new StubPg("NICE").returns(PgApproveResult.success("CARD"));
    RoutingPgClient router = new RoutingPgClient(List.of(
        PgRoute.of("TOSS", toss, 10), PgRoute.of("NICE", nice, 5)));

    PgApproveResult r = router.approve(cmd);

    assertThat(r.outcome()).isEqualTo(PgOutcome.TIMEOUT);
    assertThat(nice.approveCalls.get()).isZero();   // NICE로 안 넘어감
}
```

- 주 PG 성공 → 그것만 씀 (보조 PG 호출 0)
- 주 PG **장애(예외)** → 보조 PG로 failover → 성공
- 주 PG **카드 거절** → 그대로 반환, failover 안 함
- 주 PG **타임아웃** → 그대로 반환, failover 안 함 (이중결제 방지)
- 모든 PG 장애 → UNKNOWN
- 주 PG **서킷 오픈** → 건너뛰고 보조 PG

## 3. 개선의 교훈

포트원 같은 결제 대행사도 멀티 PG를 세일즈 포인트로 삼는데("장애 대응 1시간 → 10초"), 보통 **콘솔 수동 전환**이에요. 여기선 **자동** failover를 만들었고, 무엇보다 **"언제 failover하면 안 되는지"**를 명확히 했어요.

> "PG 장애 나면요?"에 "다른 PG로 넘겨요"는 절반의 답이에요. 나머지 절반이 **"단, 타임아웃과 카드 거절엔 안 넘겨요 — 이중결제와 무의미한 재시도니까"**예요. 이 구분이 결제를 아는 사람과 모르는 사람을 가르는 지점이에요.

## 다음 — 복합결제 (포인트 + 카드)

다음 확장은 포인트와 카드를 같이 쓰는 복합결제예요. 내부 포인트와 외부 카드를 한 결제에 묶을 때의 보상 트랜잭션, 그리고 부분취소 시 "포인트부터 환불하는 이유"까지. 이어서 씁니다.

---

*확장 기능도 기존 기반(PgClient 추상화·서킷브레이커) 위에 얹는 형태로, 각 규칙을 테스트로 고정하며 만듭니다.*

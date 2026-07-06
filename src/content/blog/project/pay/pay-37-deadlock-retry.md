---
title: 'DB가 "재시작하라"고 말할 때 — 데드락은 재시도해도 되는 실패다'
titleEn: 'When the DB Says "Try Restarting" — Deadlocks Are the Kind of Failure You May Retry'
description: 결제 시스템 개선기. 스파이크 실측이 드러낸 outbox INSERT 데드락(0.55%)을 고쳤다. 핵심은 실패의 종류를 구분하는 것 — 이 시스템엔 "승인은 재시도 금지"라는 철칙이 있는데, 그건 결과를 모르는 타임아웃 얘기다. 데드락은 전체 롤백이 확정된 transient 실패라 재실행이 안전하다. 모든 변경 API를 감싸는 멱등 계층에 재시도를 한 곳만 넣어, 같은 스파이크에서 5xx를 0으로 만들었다.
descriptionEn: "Payment system improvement log. Fixed the outbox INSERT deadlocks (0.55%) the spike test exposed. The key is classifying failures — this system has an iron rule of 'never retry approvals,' but that's about indeterminate timeouts. A deadlock is a transient failure with a guaranteed full rollback, so re-execution is safe. One retry, placed in the idempotency layer that wraps every mutating API, brought 5xx to zero on the same spike."
date: 2026-12-05T00:00:00.000Z
tags:
  - Payment
  - MySQL
  - Deadlock
  - Retry
  - Reliability
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 37
---

*결제 시스템 시리즈. 개선기 — 지난 실측이 짚어준 데드락을 고치다.*

## 0. 지난 편의 숙제

[폭주 제어 편](/blog/project/pay/pay-36-overload-control)의 스파이크 실측에서 이상한 걸 발견했었죠 — 제어를 **켰을 때만** 5xx가 113건(0.55%) 났어요. 고정 윈도우 rate limiter가 통과 요청을 **매초 초입에 버스트**로 내보내니, 그 동시 커밋들이 [아웃박스](/blog/project/pay/pay-3-webhooks-and-outbox)(`event_publication`) INSERT에서 부딪힌 거예요.

```
SQL Error: 1213, SQLState: 40001
Deadlock found when trying to get lock; try restarting transaction
```

에러 메시지를 다시 읽어보세요. MySQL이 스스로 말하고 있어요 — **"try restarting transaction."** 데드락은 DB가 두 트랜잭션 중 하나를 골라 죽이고(전체 롤백), "다시 하면 될 거야"라고 알려주는 **일시적(transient) 실패**예요. 그럼 재시도하면 되겠네? …그런데 이 시스템엔 걸리는 게 하나 있어요.

## 1. "승인은 재시도 금지"와 충돌하지 않나

이 프로젝트의 철칙 중 하나가 [**승인은 재시도하지 않는다**](/blog/project/pay/pay-24-chaos-testing)예요. 멱등키 없는 승인 재시도는 이중결제니까요. 그런데 데드락 났다고 confirm을 재실행하면 그 철칙을 깨는 거 아닌가?

아니에요. 핵심은 **실패의 종류가 다르다**는 거예요.

> **타임아웃**은 *결과를 모르는* 실패예요. PG가 승인을 했는지 안 했는지 알 수 없으니, 재시도하면 이중결제가 날 수 있어요. 그래서 UNKNOWN으로 보존하고 조회로 확정하죠.
>
> **데드락**은 *결과가 확정된* 실패예요. DB가 트랜잭션을 **통째로 롤백했다고 보장**해요. 우리 쪽 상태는 깨끗하게 원점이에요. 재실행은 "다시 하는" 게 아니라 "처음부터 하는" 거죠.

남는 걱정 하나 — 롤백돼도 그 트랜잭션 **안에서 이미 나간 외부 호출**(PG approve)은 어쩌나? 재실행하면 같은 `paymentKey`/`orderNo`/`amount`로 PG를 다시 부르는데, 실제 PG(토스 등)는 **동일 파라미터 confirm을 멱등 처리**해요(같은 결과 반환). 그래서 이 재시도는 외부에도 안전해요. 실패를 "재시도 가능/불가"로 이분하지 않고, **무엇이 확정됐고 무엇이 미상인지**로 나누는 게 결제 시스템의 재시도 규칙이에요.

## 2. 어디에 넣을까 — 멱등 계층 한 곳

재시도를 각 서비스마다 흩뿌리면 지저분해요. 좋은 지점이 이미 있었어요 — [**IdempotencyService**](/blog/project/pay/pay-2-designing-for-failure). 주문·승인·취소, 모든 변경 API가 이걸로 감싸져 있거든요.

```java
try {
    T result = executeWithDeadlockRetry(action);   // 데드락이면 최대 3회, 지터 백오프
    record.complete(serialize(result));
    ...
}
```

`action`은 자기 트랜잭션을 가지니, 데드락 롤백 후 재실행이 깨끗해요. 덤으로 좋은 성질 하나 — 재시도하는 동안 **PROCESSING 멱등 레코드가 살아 있어서**, 같은 키의 동시 중복 요청은 계속 409로 막혀요. 재시도가 중복 처리 창을 열지 않는 거죠. 발동 여부는 `idempotency.deadlock.retry` 카운터로 관측하고요.

## 3. 재실측 — 그리고 정직한 각주

같은 스파이크(150VU)를 다시 돌렸어요.

```
server_errors: 0.00%   (이전 0.55%)
성공 요청 p95: 66ms    (유지)
```

5xx가 사라졌어요. 다만 정직하게 적어둘 게 있어요 — 로그를 확인하니 **이번 런은 데드락 자체가 0건**이었어요. 데드락은 커밋 타이밍이 정확히 겹쳐야 나는 확률적 현상이라 매번 발생하지 않거든요. 그래서 "재시도가 113건을 흡수했다"가 아니라, **"재시도는 단위 테스트 3종으로 검증된 안전망으로 들어갔고, 다음에 데드락이 나면 카운터에 찍히며 조용히 흡수된다"**가 정확한 문장이에요. 측정 결과를 서사에 맞춰 부풀리지 않는 것 — [영속 버그 때](/blog/project/pay/pay-26-persistence-bug)처럼, 이번에도 지키고 싶었어요.

## 마치며

이번 건 작지만 결제 시스템다운 편이에요. "재시도해도 되나?"라는 질문에 기계적으로 답하지 않고, **실패를 분류**했어요 — 결과 미상(타임아웃)은 절대 재시도 금지, 결과 확정(데드락 롤백)은 재시도가 정석. 같은 "실패"라도 성질이 다르면 대응이 정반대가 되는 것, 그게 이 도메인의 재미이자 무서움이더라고요.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, 재시도 전후 스파이크 수치는 [docs/performance §7](https://github.com/dj258255/payment-system/blob/main/docs/performance/README.md)에 있습니다.*

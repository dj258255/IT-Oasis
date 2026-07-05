---
title: '"장애가 나도 괜찮다"는 말을 증명하기 — 서킷브레이커 단위 테스트와 Toxiproxy 카오스'
titleEn: 'Proving "It Survives Failure" — Circuit-Breaker Unit Tests and Toxiproxy Chaos'
description: 결제 시스템 개선기. 서킷브레이커, 타임아웃=UNKNOWN, 멱등 — 복원력 장치를 잔뜩 만들어놓고 정작 "진짜 장애가 나면 이게 동작하나?"는 코드로만 주장했다. 그래서 두 층위로 증명했다. 컨테이너 없이 결정적으로 도는 서킷브레이커 단위 테스트, 그리고 Toxiproxy로 실제 네트워크를 끊어 정합성이 살아남는지 확인하는 카오스 테스트. 복원력을 주장에서 검증으로.
descriptionEn: "Payment system improvement log. Circuit breaker, timeout=UNKNOWN, idempotency — I'd built a pile of resilience mechanisms but only claimed 'this works when failure hits' in code. So I proved it two ways: deterministic circuit-breaker unit tests with no containers, and a Toxiproxy chaos test that actually severs the network to check integrity survives. Resilience from claim to verification."
date: 2026-09-05T00:00:00.000Z
tags:
  - Payment
  - Chaos Engineering
  - Toxiproxy
  - Resilience4j
  - Testing
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 24
---

*결제 시스템 시리즈. 개선기 — 복원력을 주장에서 검증으로.*

## 0. 복원력을 "만들기"만 했다

지금까지 복원력 장치를 꽤 많이 만들었어요.

- [서킷브레이커](/blog/project/pay/pay-2-designing-for-failure)로 PG 장애가 전체로 번지는 걸 막고,
- 승인 타임아웃을 실패가 아니라 **UNKNOWN(미확정)**으로 보존하고,
- [멱등키](/blog/project/pay/pay-10-composite-payment)로 재시도가 이중결제로 이어지지 않게 했어요.

그런데 문득 이상했어요. 이것들이 **진짜 장애가 났을 때 동작한다는 걸** 어떻게 알죠? 다 "이렇게 동작하도록 코드를 짰다"는 주장이었지, **장애를 실제로 일으켜서** 확인한 적은 없었어요.

이건 결제 시스템에서 특히 위험해요. 복원력 코드는 평소엔 안 돌아요 — 장애가 나야 발동하죠. 그런데 그 코드가 정작 장애 순간에 버그가 있으면? **가장 필요한 순간에 안전장치가 없는** 거예요. 그래서 복원력은 반드시 **장애를 주입해서** 검증해야 해요.

두 층위로 나눠서 증명했어요.

## 1. 층위 ①: 서킷브레이커를 결정적으로 못박기

첫 번째는 서킷브레이커 자체의 동작이에요. 이건 컨테이너나 네트워크 없이, **결정적인 단위 테스트**로 잡을 수 있어요.

`ResilientPgClient`는 PG 호출을 서킷브레이커·재시도로 감싸요. 여기에 **장애를 주입하는 가짜 PgClient**를 넣고 감싸면, 실제 PG 없이 데코레이터 동작만 딱 검증할 수 있어요.

검증한 세 가지가 이 시스템 복원력의 핵심 규칙이에요.

**(1) 승인은 재시도하지 않는다.**

```java
// faulty delegate가 예외를 던져도 —
approve() → delegate 호출 횟수 == 1, 결과 == TIMEOUT(UNKNOWN)
```

이게 결제에서 제일 중요한 규칙이에요. 멱등키 없이 승인을 재시도하면 **이중결제**가 나요. 그래서 승인은 실패해도 재시도하지 않고, 대신 **UNKNOWN으로 돌려** [복구 배치](/blog/project/pay/pay-23-ops-admin)가 나중에 조회로 확정하게 해요. "실패로 단정하지 않는다"는 3-상태 모델을, delegate를 딱 1번만 부르는 걸로 못박았어요.

**(2) 서킷이 열리면 아예 부르지 않는다.**

반복 실패로 서킷이 `OPEN` 되면, 이후 승인은 delegate를 **호출조차 안 하고** 즉시 UNKNOWN으로 폴백해요. 테스트에선 서킷을 연 뒤 몇 번 더 호출해도 **delegate 호출 횟수가 안 느는지**를 확인했어요. 이게 "PG 장애가 우리 스레드를 고갈시키지 않는다"의 증거예요 — 죽은 PG를 계속 기다리지 않고 빠르게 포기하니까요.

**(3) 조회는 재시도하되, 무한은 아니다.**

조회(query)는 읽기라 재시도가 안전해요. 그래서 몇 번 실패 후 성공하면 재시도로 흡수해요. 단, **maxAttempts(3)에서 멈추고** 예외를 전파해요 — 무한 재시도로 장애를 키우지 않고, 다음 배치 주기에 다시 잡게요.

이 단위 테스트들은 컨테이너가 없어서 **CI 기본 스위트에서 매번 결정적으로** 돌아요. 서킷브레이커 동작이 회귀하면 즉시 빨간불이 떠요.

## 2. 층위 ②: Toxiproxy로 진짜 네트워크를 끊기

단위 테스트는 서킷브레이커 "로직"을 검증하지만, **진짜 네트워크 장애**는 재현하지 못해요. 커넥션이 5초씩 늘어지거나, 쿼리 중간에 끊기거나, 커넥션 풀이 마르는 상황 — 이건 실제 TCP를 방해해야 나와요.

그래서 [Toxiproxy](https://github.com/Shopify/toxiproxy)를 썼어요. 앱과 MySQL 사이에 **프록시를 끼워, 그 구간에 장애(toxic)를 주입**하는 도구예요.

```
앱 ──> [Toxiproxy] ──> MySQL
            ↑
       여기에 latency 5s / 커넥션 cut 주입
```

테스트 시나리오는 이래요.

1. 정상 상태에서 체크아웃(주문 생성 → 승인) 1건을 성공시켜요.
2. Toxiproxy에 `latency(UPSTREAM, 5초)` toxic을 주입해요 — DB 응답이 5초씩 늘어지게.
3. 장애 중에 체크아웃을 시도해요. 이때 검증하는 건 **"무한 hang이 아니라 깨끗한 타임아웃으로 끝나는가"**예요.
4. toxic을 제거하고, **같은 Idempotency-Key로 재시도**해요. **이중 결제가 없는지** 확인해요.

### 여기서 핵심: 짧은 타임아웃

3번이 중요해요. JDBC `socketTimeout`과 Hikari `connectionTimeout`을 **짧게(2~3초)** 둬야 해요.

> 만약 타임아웃이 무한이면, DB가 느려질 때 요청 스레드가 **영원히 매달려요.** 그럼 스레드 풀이 마르고, 장애가 결제 지연을 넘어 **서비스 전체 마비**로 번져요. 짧은 타임아웃은 "느린 건 차라리 빨리 실패시킨다"는 원칙이에요. Toxiproxy로 latency를 주입했을 때, 요청이 5초 매달리는 게 아니라 3초에 **타임아웃 예외(5xx)로 깔끔하게 끝나고, 부분 커밋도 없이** 트랜잭션이 롤백되는 걸 확인했어요.

### 그리고: 멱등이 장애를 건너 생존하는가

4번은 [멱등성](/blog/project/pay/pay-2-designing-for-failure)이 **장애를 관통해서** 유지되는지를 봐요. 장애로 한 번 실패한 요청을, 같은 멱등키로 재시도했을 때 — 첫 응답이 그대로 재반환되고 이중 결제/이중 차감이 없어야 해요. "네트워크가 끊겼다 붙어도 결제는 정확히 한 번"이라는 걸, 실제로 끊어보고 확인한 거예요.

## 3. 왜 기본 스위트에서 뺐나

Toxiproxy 테스트는 컨테이너 2개(MySQL + Toxiproxy) + 앱 부팅이 필요해서 무거워요. 그래서 `@Tag("chaos")`를 붙여 **기본 테스트에서 제외**했어요.

```bash
./gradlew test        # 기본: 카오스 제외 — 빠르고 결정적, 컨테이너 안 뜸
./gradlew chaosTest   # 카오스만: 컨테이너 2개 + 부트, 전용 환경에서
```

[CI가 매 PR마다 도는](/blog/project/pay/pay-21-ci-guards-boundaries) 기본 스위트는 **결정성과 속도**가 생명이에요. 컨테이너에 의존하는 무거운 테스트가 끼면, 환경에 따라 불안정해지고 느려져요. 그래서 결정적인 것(서킷브레이커 단위)은 항상 돌리고, 무거운 것(Toxiproxy)은 네트워크가 준비된 전용 환경에서만 돌리게 나눴어요.

이 분리 자체가 하나의 판단이에요 — **"모든 테스트를 항상 돌린다"가 아니라, 테스트의 성격에 따라 언제 돌릴지를 정한다.**

## 마치며

이번 건 복원력을 **주장에서 검증으로** 옮긴 편이에요.

서킷브레이커도 멱등도, 만들어놓고 "잘 되겠지" 하면 그건 희망이지 보장이 아니에요. delegate를 몇 번 부르는지 세어보고, 실제로 네트워크를 끊어보고, 그러고 나서야 "장애가 나도 이중결제는 안 난다"고 말할 수 있어요. 카오스 엔지니어링이 거창한 게 아니라 — **"안전장치가 정말 동작하는지, 장애를 일으켜 확인한다"**는 이 단순한 태도가 전부더라고요.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, 서킷브레이커 검증은 CI에서, Toxiproxy 카오스는 전용 실행으로 나눴습니다.*

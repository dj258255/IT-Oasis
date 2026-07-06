---
title: '갑자기 10만 명이 결제하면? — 폭주를 429로 쳐내고 성공 요청의 속도를 지키기'
titleEn: 'What If 100K People Pay at Once? — Shedding the Surge with 429s While Keeping Successful Requests Fast'
description: 결제 시스템 개선기. "갑자기 사람이 많이 결제하면 어떻게 되지?"를 점검해보니 유입 제어가 절반뿐이었다 — 속도 제한이 없고, 대기열은 권고일 뿐이고, 풀은 30초씩 매달린다. Redis rate limiter(429), 대기열 게이트 강제(입장권), 빠른 실패 설정 3층을 쌓고 같은 스파이크를 전/후로 실측했다. 폭주의 97.5%를 429로 거절하자 성공 요청 p95가 738ms→52ms. 그리고 실측이 또 하나의 숨은 문제(아웃박스 데드락)를 드러냈다.
descriptionEn: "Payment system improvement log. Auditing 'what if a surge of payments hits?' revealed only half the story: no rate limiting, an advisory-only queue, pools hanging 30 seconds. I stacked three layers — a Redis rate limiter (429), enforced queue gating (entry passes), fast-fail pool settings — and measured the same spike before/after. Shedding 97.5% of the surge as 429s brought successful-request p95 from 738ms to 52ms. And the measurement exposed yet another hidden issue (outbox deadlocks)."
date: 2026-11-28T00:00:00.000Z
tags:
  - Payment
  - Rate Limiting
  - Load Shedding
  - Redis
  - k6
  - Performance
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 36
---

*결제 시스템 시리즈. 개선기 — 폭주를 다 받지 않기로 하다.*

## 0. "갑자기 사람이 많이 결제하면?"

이 질문으로 시스템을 점검해봤어요. 층별로 세어보니 — **유입 제어가 절반뿐**이었어요.

- [JWT로 인증은 싸졌는데](/blog/project/pay/pay-20-jwt-removes-bottleneck), 싸진 만큼 **더 많이 받아버려요.** 속도 제한이 없으니까요.
- [선착순 대기열](/blog/project/pay/pay-34-waiting-queue)을 만들었지만 **권고일 뿐** — 클라이언트가 무시하고 결제 API를 직접 치면 그대로 DB까지 갑니다.
- Hikari `connectionTimeout`이 기본 **30초** — 폭주하면 요청들이 커넥션을 30초씩 기다리며 톰캣 스레드를 다 물고 늘어져요. 지연이 아니라 **전면 마비**로 번지는 경로죠.

핵심 원칙은 이거예요.

> **감당 못 할 요청은 가장 바깥 층에서, 가장 싸게 거절한다.** 안쪽(DB)으로 갈수록 요청 처리 비용이 커지니, 밖에서 429 한 방으로 쳐내는 게 모두를 살리는 길이에요. 어차피 한정판 100개에 10만 명이 오면, 99,900명은 **언젠가 거절**당해요 — 문제는 그 거절이 "DB를 태운 뒤"냐 "문 앞에서"냐죠.

3층을 쌓았어요.

## 1. 층 ①: Redis 분산 rate limiter — 연타를 문 앞에서

가장 바깥 층. 주문·승인 API에 **속도 제한**을 걸었어요 — 사용자별 5회/초 + 전역 100회/초. Redis 고정 윈도우(`INCR` + `EXPIRE`) 한 방이라 O(1)이고, 다중 인스턴스에서도 카운트가 정확해요. 초과분은 `429 + Retry-After: 1`.

데모 콘솔에서 같은 사용자가 주문을 8연타하면 —

```
8연타 → 5건 201 (통과) + 3건 429 RATE_LIMITED "요청이 너무 잦습니다"
```

정당한 사용자에게 5회/초는 충분하고, 봇/오작동 클라이언트의 폭탄은 Redis에서 끝나요. DB는 구경도 못 하죠.

세부 판단 둘: **(1)** 필터를 `@Component`로 두지 않고 SecurityConfig에서 직접 만들어 Bearer 인증 **뒤에** 삽입했어요 — principal(userId)로 사용자별 키를 만들 수 있고, 빈 자동등록에 의한 이중 적용이 원천 차단돼요. **(2)** 고정 윈도우는 경계 순간 최대 2배가 통과하는 특성이 있는데, 단순성을 택하고 그 한계를 주석에 명시했어요(뒤층이 흡수).

## 2. 층 ②: 대기열을 권고에서 강제로 — 입장권

[대기열 편](/blog/project/pay/pay-34-waiting-queue)에서 "결제 경로와 독립"으로 설계했는데, 그 대가는 **착한 클라이언트만 줄을 선다**는 거였어요. 이번에 옵트인 방식으로 보완했어요.

- 대기열이 `admitted`를 판정하는 순간, **입장권**(`admit:{eventId}:{userId}`, TTL 10분)을 Redis에 발급해요.
- **게이트 상품**(프로퍼티로 지정, 예: 한정판)을 주문하면, 서버가 이 입장권을 검증해요. 없으면 —

```
한정판 주문 (입장권 없음) → 429 QUEUE_PASS_REQUIRED "선착순 대기열 입장 후 주문할 수 있습니다"
대기열 입장 → admitted:true (입장권 발급)
한정판 재주문 → 201 성공
```

이제 대기열을 무시하고 API를 직접 쳐도 **서버가 막아요.** 권고가 강제가 됐죠. 중요한 건 **옵트인**이라는 것 — 게이트 상품 목록이 비어 있으면(기본) 검증 자체를 안 타서 기존 동작이 100% 불변이에요. 일반 상품 결제는 대기열과 여전히 무관하고요.

데모 콘솔에서 두 층이 동작하는 모습이에요.

![폭주 제어 데모 — 연타 3건이 429 RATE_LIMITED로 쳐내지고, 한정판은 입장권 없이 429 → 대기열 입장 → 201](/uploads/project/pay/demo/demo-overload.png)

## 3. 층 ③: 매달리지 말고 빠르게 실패

마지막 층은 설정이에요. [카오스 테스트](/blog/project/pay/pay-24-chaos-testing)에선 짧은 타임아웃을 걸었으면서, 정작 **운영 설정은 기본값**이었더라고요.

```yaml
hikari:
  connection-timeout: 3000   # 30초 대기 → 3초 빠른 실패
  maximum-pool-size: 20
tomcat.threads.max: 100      # 스레드 무한 증식 대신 상한
```

폭주가 위 두 층을 뚫고 와도, 커넥션을 3초만 기다리고 실패해요. "모두가 30초씩 매달려 다 같이 죽는" 대신 "일부가 빠르게 실패하고 나머지는 산다"로요.

## 4. 실측 — 같은 스파이크, 전과 후

[늘 하던 대로](/blog/project/pay/pay-20-jwt-removes-bottleneck) 수치로 확인했어요. k6로 **0→150 VU를 10초 만에** 꽂는 스파이크를, 제어 OFF/ON으로 두 번요. 이 테스트에서 429는 실패가 아니라 **의도된 거절(shed)**로 따로 세요.

| 지표 | 제어 없음 | **제어 있음** |
|---|---|---|
| 유입 | 304 req/s **전량 DB까지** | 398 req/s 중 **97.5%를 429로 거절** |
| DB 도달 | 15,445건 (100%) | ~510건 (2.5%) |
| **성공 요청 p95** | **737.81ms** | **52.01ms (14배↓)** |
| 성공 요청 max | 1.48s | 105ms |

제어가 없으면 폭주가 전량 DB로 흘러 **정상 요청까지 같이** 느려져요(p95 738ms — 평시 37ms의 20배). 제어를 켜면 감당 못 할 요청은 문 앞에서 429로 끝나고, **통과한 요청은 평시에 가까운 속도를 유지**해요. "모두가 느려짐"에서 "일부는 기다리고, 나머지는 정상"으로 — 이게 load shedding의 본질이에요.

## 5. 실측이 또 하나를 드러냈다

정직하게 적어둘 발견이 있어요. 제어 **ON에서만** 5xx가 113건(0.55%) 나왔어요. 추적해보니 —

> 고정 윈도우 rate limiter는 통과 요청을 **윈도우 경계마다 버스트**로 내보내요(매초 초입에 5건이 동시에). 그 동시 커밋들이 [아웃박스](/blog/project/pay/pay-3-webhooks-and-outbox)(`event_publication`) INSERT에서 **MySQL 데드락**으로 부딪혔어요. 제어가 없을 땐 오히려 지연이 요청을 자연스럽게 직렬화해서 0건이었고요.

임계치(<1%) 이내라 테스트는 통과했지만, 이건 스파이크 실측이 아니면 영영 몰랐을 특성이에요. 데드락 재시도 또는 sliding window로 후속 과제로 남겼어요. [부하테스트가 BCrypt를 짚어줬듯](/blog/project/pay/pay-17-load-test-finds-bottleneck), **측정은 항상 다음 개선을 짚어주네요.**

## 마치며

"갑자기 사람이 많이 결제하면?"의 답은 "더 빠른 서버"가 아니었어요. **"다 받지 않는 것"** — 감당할 수 있는 만큼만 안으로 들이고, 나머지는 바깥에서 명확하게(429 + Retry-After) 거절하는 것.

그리고 layered defense예요. rate limiter가 연타를, 대기열 게이트가 이벤트 폭주를, 빠른 실패 설정이 마지막 방어를. 한 층이 뚫려도 다음 층이 받아요. 폭주 제어는 기능이 아니라 **구조**더라고요.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, 스파이크 전/후 실측 수치는 [docs/performance §7](https://github.com/dj258255/payment-system/blob/main/docs/performance/README.md)에 있습니다.*

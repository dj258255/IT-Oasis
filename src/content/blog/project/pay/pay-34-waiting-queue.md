---
title: '한정판 오픈에 10만 명이 몰리면 — Redis Sorted Set 선착순 대기열'
titleEn: 'When 100K People Hit a Limited Drop at Once — A Redis Sorted Set Waiting Queue'
description: 결제 시스템 개선기. 한정판 선착순처럼 순간 트래픽이 폭증하면, 수만 명이 동시에 주문·재고 차감을 때려 DB가 무너진다. 문을 넓히는 대신 줄을 세우기로 했다 — Redis Sorted Set으로 도착 순서대로 대기열을 만들고, 앞에서부터 정해진 인원만 입장시켜 DB 유입을 제어한다. score를 도착 순번으로 쓰는 이유, 재진입 멱등, 이탈 시 순번이 당겨지는 것까지.
descriptionEn: "Payment system improvement log. A limited drop can send tens of thousands hammering orders and stock deduction at once, crushing the DB. Instead of widening the door, I formed a line — a Redis Sorted Set queue by arrival order that admits only a fixed number from the front to throttle DB load. Why score is the arrival sequence, idempotent re-entry, and how leaving advances everyone behind."
date: 2026-11-14T00:00:00.000Z
tags:
  - Payment
  - Redis
  - Performance
  - Concurrency
  - Scalability
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 34
---

*결제 시스템 시리즈. 개선기 — 문을 넓히는 대신 줄을 세우기.*

## 0. 문을 넓히면 무너진다

[성능 편](/blog/project/pay/pay-17-load-test-finds-bottleneck)에서 부하를 다뤘지만, 진짜 무서운 건 **선착순**이에요. 한정판 100개를 오픈하는 순간 10만 명이 몰리면, 평소 트래픽의 수백 배가 **한꺼번에** 들어와요.

이걸 "서버를 키워서" 감당하려는 건 대개 실패해요.

> 10만 명을 다 받아주면, 그 10만 개의 요청이 동시에 [재고 차감](/blog/project/pay/pay-5-lock-comparison)을 때려요. DB 커넥션 풀이 순식간에 마르고, 락 경합이 폭발하고, 정상 사용자까지 다 느려져요. **어차피 살 수 있는 건 100명뿐**인데, 10만 명이 다 DB를 두들기는 거죠. 문을 아무리 넓혀도, 그 뒤의 DB는 그대로예요.

그래서 발상을 바꿨어요. **문을 넓히지 말고, 줄을 세우자.** 앞에서부터 정해진 인원만 들여보내고, 나머지는 대기열에서 자기 순번을 기다리게 하는 거예요. DB엔 항상 감당 가능한 만큼만 흘러 들어가고요.

## 1. Redis Sorted Set이 딱 맞는 이유

"순번이 있는 줄"을 뭘로 만들까 — **Redis Sorted Set(ZSET)**이 정확히 이걸 위한 자료구조예요.

ZSET은 각 멤버에 **score**를 매겨 정렬해둬요. 그래서 이렇게 쓸 수 있어요.

```
입장 요청 → INCR queue:{event}:seq  (도착 순번을 원자적으로 발급)
          → ZADD queue:{event} {순번} {userId}
```

`score`를 **도착 순번**으로 쓰는 게 핵심이에요. 순번이 작을수록 먼저 도착 → ZSET이 자동으로 도착 순서(FIFO)로 정렬해요. 그럼 내 순위는?

```
rank = ZRANK queue:{event} {userId}   // 0-based, 내 앞에 몇 명인지
admitted = (rank < admitLimit)         // 앞에서 admitLimit명만 입장
```

`ZRANK` 하나로 "내 앞에 몇 명 있는지"가 바로 나와요. 그리고 앞에서부터 `admitLimit`(예: 100)명만 `admitted=true`로 입장시켜요. 나머지는 대기하며 자기 순번을 폴링하고요.

INCR로 순번을 발급하는 게 중요해요 — 도착 순번이 **원자적**이라, 동시에 1만 명이 들어와도 순번이 겹치지 않아요. 시각(timestamp)을 score로 쓰면 같은 밀리초에 들어온 요청들이 순서가 애매해지는데, INCR은 그 문제가 없죠.

## 2. 폴링해도 뒤로 밀리지 않게 — 재진입 멱등

대기 중인 사용자는 "내 순번 언제 와?"를 계속 폴링해요. 그런데 여기 함정이 있어요.

> 만약 폴링(또는 새로고침)할 때마다 `enter`가 다시 `ZADD`를 하면? **매번 새 도착 순번을 받아 줄 맨 뒤로 밀려나요.** 기다릴수록 순번이 뒤로 가는 최악의 대기열이 되는 거죠.

그래서 `enter`를 **멱등**하게 만들었어요.

```java
// 이미 줄에 있으면 순번을 새로 뽑지 않고 기존 rank를 반환
if (redis.opsForZSet().score(key, userId) != null) {
    return currentPosition(key, userId);   // ZADD 안 함
}
// 처음 온 사람만 순번 발급 + ZADD
```

`ZSCORE`로 이미 줄에 있는지 먼저 확인하고, 있으면 순번을 그대로 둬요. 그래서 100번 폴링해도 내 순번은 안 변해요. "입장/상태 조회"가 몇 번을 호출되든 도착 순서를 보존하는 게, 대기열의 신뢰성이에요.

## 3. 앞사람이 빠지면 뒷사람이 당겨진다

입장한 사람이 결제를 끝내면 줄에서 나가요.

```
POST /queue/{event}/leave → ZREM queue:{event} {userId}
```

여기서 ZSET의 좋은 점이 또 나와요. 앞사람을 `ZREM`으로 빼면, **뒷사람들의 rank가 자동으로 한 칸씩 당겨져요.** rank는 "현재 ZSET에서의 순위"라 실시간으로 재계산되거든요. 그래서 별도 로직 없이, 앞사람이 나가면 대기 1번이 입장 대상이 돼요.

실기동으로 확인했어요(admit-limit=1로).

```
user1 입장  → position 1, admitted:true    (입장!)
user2 입장  → position 2, admitted:false    (대기)
user1 이탈  → leave
user2 상태  → position 1, admitted:true    (순번 당겨져 입장!)
```

user1이 나가자마자 user2가 자동으로 입장 대상이 됐어요. 줄이 실제로 움직이는 거죠.

## 4. 결제 경로는 건드리지 않았다

한 가지 의식적으로 지킨 원칙 — 대기열을 **[크리티컬한 결제 경로](/blog/project/pay/pay-26-persistence-bug)에 끼워 넣지 않았어요.** 대기열은 "입장/상태/이탈"만 하는 **독립 프리미티브**로 뒀고, 다른 모듈을 전혀 참조하지 않아요(모듈 의존 0).

"입장 확인 후 결제로 진행"은 클라이언트 흐름이에요 — 대기열에서 `admitted`를 받은 사용자가 결제 API를 호출하는 식이죠. 이렇게 분리하면, **대기열이 죽어도 결제 자체는 멀쩡**하고(대기열 조회는 Redis 예외 시 fail-soft), 결제 경로에 Redis 의존이 안 생겨요. 트래픽 제어와 결제 처리를 섞지 않은 거예요.

그리고 이 대기열은 [Redis를 또 한 번 제대로 쓰는](/blog/project/pay/pay-32-jwt-refresh-revoke) 사례이기도 해요 — 토큰 저장소에 이어, 순번 있는 대기열까지 Redis의 자료구조가 제 일을 하네요.

## 마치며

이번 건 "감당 못 할 트래픽을 어떻게 감당하나"라는 질문에, **"다 받지 말고 줄을 세운다"**로 답한 편이에요. 선착순의 본질은 "빠른 서버"가 아니라 "질서 있는 입장"이더라고요.

핵심은 Redis Sorted Set이라는 딱 맞는 도구였어요 — score를 도착 순번으로 쓰니 FIFO가 공짜로 되고, ZRANK로 순위가, ZREM으로 순번 당김이 자동으로 됐어요. 자료구조를 문제에 맞게 고르면, 로직이 이렇게 간결해진다는 걸 다시 느꼈어요.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, 입장·대기·이탈 순번 당김을 실 Redis로 검증했습니다.*

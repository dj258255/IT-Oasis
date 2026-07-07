---
title: '재시작하면 블랙리스트가 사라진다 — 보안 상태의 수명, 그리고 README의 거짓말'
titleEn: 'Restart and the Blacklist Is Gone — the Lifespan of Security State, and the README That Lied'
description: 결제 시스템 개선기. 감사가 보안 갭 넷을 짚었다. 웹훅 시크릿은 test-webhook-secret 기본값을 조용히 쓰고 있었고, 사기 카드 블랙리스트는 재시작하면 통째로 사라졌고, velocity 카운터는 인메모리라 다중 인스턴스에서 무력했다. 그리고 README는 쓰지도 않는 QueryDSL과 Spring Batch를 쓴다고 적어놨다. 보안은 상태의 수명과 진실성의 문제라는 걸 다시 배운 이야기.
descriptionEn: "Payment system improvement log. An audit found four security gaps. The webhook secret silently used a test-webhook-secret default, the fraud card blacklist vanished entirely on restart, and the velocity counter was in-memory — useless across instances. And the README claimed QueryDSL and Spring Batch it never used. A story of relearning that security is about the lifespan of state and honesty."
date: 2027-01-09T00:00:00.000Z
tags:
  - Payment
  - Security
  - Redis
  - Fraud Detection
  - Reliability
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 42
---

*결제 시스템 시리즈. 개선기 — 보안 갭을 마감하다.*

## 0. 감사가 짚은 넷

[전수 감사](/blog/project/pay/pay-39-settlement-escrow-alignment)의 보안 관련 항목 넷을 이번에 마감했어요. 각각 성격이 다른데, 관통하는 주제가 있었어요 — **보안 상태의 수명**과 **문서의 진실성**.

## 1. 조용한 기본값 — 웹훅 시크릿

[웹훅 서명 검증](/blog/project/pay/pay-3-webhooks-and-outbox)은 HMAC 시크릿으로 "이 웹훅이 진짜 PG가 보낸 것인지"를 확인해요. 그런데 그 시크릿이 이렇게 주입되고 있었어요.

```java
@Value("${payment.webhook.secret:test-webhook-secret}")   // ← 기본값
```

`test-webhook-secret`이라는 **약한 기본값을 조용히** 쓰고 있던 거예요. 운영에서 환경변수를 깜빡 안 넣으면? 앱은 아무 경고 없이 뜨고, **공개된 문자열로 서명을 검증**해요. 그럼 공격자가 그 문자열로 서명을 위조해 가짜 웹훅을 보낼 수 있죠.

이상한 건, [JWT 키는 이미 fail-fast](/blog/project/pay/pay-20-jwt-removes-bottleneck)였다는 거예요(미설정이면 기동 실패). 웹훅만 빠져 있었죠. 일관성을 맞췄어요.

```java
public WebhookSignatureVerifier(@Value("${payment.webhook.secret}") String secret) {
    // 미설정·약한 키면 기동 거부 — JWT 키와 같은 결
}
```

실기동으로 확인했어요 — 빈 시크릿으로 띄우니 앱이 **뜨지 않아요.**

```
Caused by: IllegalStateException: payment.webhook.secret 미설정 — 웹훅 서명 시크릿을 환경변수/시크릿으로 주입해야 합니다.
```

"조용히 약한 값으로 도는 것"보다 "**시끄럽게 죽는 것**"이 보안에선 나아요. 잘못된 설정으로 프로덕션이 뜨는 걸, 배포 시점에 막는 거예요.

## 2. 재시작하면 사라지는 블랙리스트

[FDS 사후 심사](/blog/project/pay/pay-31-fds-review-queue)에서, 사기로 판정된 카드를 **블랙리스트**에 넣어 이후 결제를 차단하게 만들었어요. 그런데 그 블랙리스트가 이랬어요.

```java
private final Set<String> cardBlacklist = ConcurrentHashMap.newKeySet();   // in-memory
```

**메모리에만** 있었어요. 즉 —

> 앱을 재시작하면(배포, 장애 복구) **블랙리스트가 통째로 사라져요.** 어제 사기로 차단한 카드가, 오늘 배포 후엔 다시 통과해요. 보안 상태가 프로세스 수명만큼만 사는 거죠. 결제 차단 같은 건 프로세스보다 오래 살아야 하는데요.

여기서 판단이 하나 있었어요 — 블랙리스트를 어디에 저장하나? 새 테이블을 만들 수도 있지만, **진실 원천은 이미 DB에 있었어요.** 사기로 거부한 심사 리뷰(`REJECTED`)가 `fraud_reviews`에 남아 있거든요.

> 그래서 별도 저장소 대신, **기동 시 REJECTED 리뷰에서 블랙리스트를 재구축**하기로 했어요. 인메모리 Set은 "캐시"로 두고, 진실 원천은 DB의 심사 이력으로요.

```java
@EventListener(ApplicationReadyEvent.class)
void reload() {
    fraudReviewRepository.findByStatus(REJECTED)
        .forEach(r -> fraudService.blacklistCard(r.getCardKey()));   // 기동 시 재적재
}
```

이제 재시작해도 어제 차단한 카드는 그대로 막혀요. "상태를 어디에 두느냐"보다 "**진실 원천이 무엇이냐**"를 먼저 물으니, 새 테이블 없이 깔끔하게 풀렸어요.

## 3. 한 프로세스만 세는 velocity

[FDS velocity 룰](/blog/project/pay/pay-14-fraud-detection)은 "1분에 카드로 몇 번 시도했나"를 세서 이상 패턴을 잡아요. 그런데 그 카운터가 **인메모리**였어요.

> 서버가 여러 대면(실서비스는 당연히), 각 인스턴스가 **자기가 받은 요청만** 세요. 공격자가 1분에 100번을 쳐도, 10대에 분산되면 각각 10번밖에 못 봐서 velocity 룰이 **안 걸려요.** 인메모리 카운터는 다중 인스턴스에서 사실상 무력한 거죠.

이건 [rate limiter](/blog/project/pay/pay-36-overload-control)나 [토큰 저장소](/blog/project/pay/pay-32-jwt-refresh-revoke)와 정확히 같은 문제였고, 해법도 같았어요 — **Redis 공유 카운터.**

```java
// velocity:{cardKey}:{분} 을 모든 인스턴스가 공유해 INCR
Long n = redis.opsForValue().increment("velocity:" + key + ":" + epochMinute);
```

기존 인메모리 구현은 폴백·테스트용으로 남기고, Redis 구현을 기본으로 두되(`@Primary`), Redis가 죽으면 **fail-open**(velocity 통과 + 경고)했어요. 사기 탐지는 보조 방어층이라, 그 층의 Redis 장애가 결제 전면 중단으로 번지면 안 되니까요.

실기동으로 결제를 일으키니, Redis에 velocity 키가 실제로 찍혔어요.

```
velocity:card:pk-98E5E60F...:29723098
```

이제 여러 대가 하나의 카운터를 공유해요.

## 4. README가 거짓말을 하고 있었다

마지막은 코드가 아니라 **문서**였어요. 감사가 이걸 짚었어요.

> README는 "MySQL + JPA + **QueryDSL**", "settlement — **Spring Batch** 정산"이라 명시하나, `build.gradle`에 둘 다 **의존조차 없다.**

쓰지도 않는 기술을 쓴다고 적어놨던 거예요. 아마 초기 계획엔 있었는데 실제론 안 쓰고, 문서만 안 고친 거죠. 이건 사소해 보여도 **정직성 문제**예요 — 코드를 읽는 사람이 문서를 믿을 수 없게 되니까요.

그래서 정직하게 고쳤어요. QueryDSL은 삭제하고, 정산은 "일 단위 배치 집계(서비스 루프; 대용량은 Spring Batch로 확장 여지)"로 사실화했어요. 그리고 README에 **"가정과 한계"** 절을 새로 뒀어요 — 데모 사용자(인메모리), 단일 통화(KRW), 로컬 기본 시크릿(운영은 env 필수), 멀티 PG 미배선 같은 걸 **숨기지 않고** 적었어요.

> "이건 이렇게 가정했고, 여기까진 안 했다"를 적는 게, "다 완벽하다"고 적는 것보다 훨씬 믿음직해요. 특히 결제처럼 신뢰가 생명인 도메인에선요.

## 마치며

이번 건 새 기능이 아니라 **마감**이에요. 그런데 마감이 보여준 게 있어요 — 보안은 "잠그면 끝"이 아니라 **상태가 얼마나 오래, 어디까지 사느냐**의 문제라는 것. 블랙리스트는 재시작을 넘어 살아야 하고, velocity는 인스턴스를 넘어 공유돼야 하고, 시크릿은 조용히 약해지면 안 돼요.

그리고 코드만큼 **문서도 정직해야** 한다는 것. 안 쓰는 걸 쓴다고 적고, 가정을 숨기는 문서는 — 그 자체가 신뢰의 구멍이더라고요.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, 웹훅 fail-fast·블랙리스트 재적재·Redis velocity를 실기동으로 검증했습니다.*

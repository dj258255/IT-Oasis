---
title: '배포하는 순간 결제가 끊기면 안 된다 — 운영성 마감 네 가지'
titleEn: "A Deploy Must Not Cut a Payment Mid-Flight — Four Operability Closeouts"
description: 결제 시스템 개선기. 기능이 아니라 운영성을 마감했다. SIGTERM에 진행 중 결제를 드레이닝하는 graceful shutdown, 전건 로딩되던 어드민 조회 6종의 페이지네이션, CI에서 빠져 있던 소비자 앱 빌드, rate limiter와 충돌하던 부하테스트 정합까지. 화려하지 않지만 실서비스가 실제로 돌아가려면 반드시 있어야 하는 것들.
descriptionEn: "Payment system improvement log. Not features, but operability. Graceful shutdown that drains in-flight payments on SIGTERM, pagination for six admin queries that loaded everything, the consumer app that CI never built, and reconciling the load test that clashed with the rate limiter. Unglamorous, but the things a real service actually needs to run."
date: 2027-01-16T00:00:00.000Z
tags:
  - Payment
  - Operations
  - Spring Boot
  - Graceful Shutdown
  - CI
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 43
---

*결제 시스템 시리즈. 개선기 — 운영성을 마감하다.*

## 0. 기능 말고, 운영성

[감사](/blog/project/pay/pay-39-settlement-escrow-alignment)가 짚은 것 중 "기능이라기보단 **운영성**"인 항목 넷을 마감했어요. 화려하진 않지만, 실서비스가 **실제로 돌아가려면** 반드시 있어야 하는 것들이에요.

## 1. 배포하는 순간 결제가 끊기면 안 된다

제일 중요했던 건 **graceful shutdown**이었어요. 이게 없으면 —

> 배포할 때(또는 재시작할 때) 컨테이너가 SIGTERM을 받으면, 앱이 **즉시** 종료돼요. 그 순간 처리 중이던 결제 승인 요청이 **강제로 끊겨요.** PG엔 승인 요청이 갔는데 우리 응답은 중단된, [정확히 UNKNOWN을 유발하는](/blog/project/pay/pay-2-designing-for-failure) 상황이죠. 배포할 때마다 미확정 결제가 생기는 거예요.

설정 두 줄로 막았어요.

```yaml
server:
  shutdown: graceful
spring:
  lifecycle:
    timeout-per-shutdown-phase: 20s
```

이제 SIGTERM이 오면 **새 요청은 안 받되, 진행 중인 요청은 완료까지 기다려요**(최대 20초). 실기동으로 확인했어요.

```
Commencing graceful shutdown. Waiting for active requests to complete
Graceful shutdown complete
```

진행 중 결제가 끝난 뒤에야 종료돼요. 배포가 결제를 끊지 않아요. (쿠버네티스라면 로드밸런서 드레이닝을 위한 preStop 지연도 필요하지만, 여기선 단일 프로세스라 설정만으로 충분해요.)

## 2. "전부 다 주세요"가 되던 어드민

[어드민 조회](/blog/project/pay/pay-23-ops-admin) 6종(DLQ·보상·대사·미확정·강제취소·FDS 심사)이 전부 **전건 List**였어요. 감사가 "코드 전체에 `Pageable`이 하나도 없다"고 짚었죠.

> 데모에선 데이터가 몇 건이라 괜찮아 보이지만, 운영에서 DLQ가 수만 건 쌓이면 `findAll()`이 **전부를 메모리에 로딩**해요. 어드민 화면 한 번 여는 게 DB와 힙을 때리는 거죠.

6종 전부 페이지네이션으로 바꿨어요. 좋았던 건 **뷰 매핑을 그대로 유지**할 수 있었다는 거예요.

```java
// 기존: repo.findByStatus(status).stream().map(뷰변환).toList()
// 변경: repo.findByStatus(status, pageable).map(뷰변환)
```

`Page.map`이 `List.stream().map`과 똑같이 동작해서, [엔티티 대신 뷰 record로 노출하는 원칙](/blog/project/pay/pay-23-ops-admin)은 그대로 두고 컨테이너만 List→Page로 바꿨어요. 응답도 `[...]`에서 `{content:[...], totalElements, ...}`로 자연스럽게 바뀌고요.

## 3. CI가 빌드하지 않던 앱

[Kafka 소비자 앱](/blog/project/pay/pay-38-kafka-consumer)을 **독립 Gradle 프로젝트**로 만들었잖아요. 그게 장점이자 함정이었어요.

> 독립 프로젝트라 루트 빌드가 존재조차 몰라요 — 그래서 [CI](/blog/project/pay/pay-21-ci-guards-boundaries)가 소비자 앱을 **빌드도 테스트도 안 했어요.** 소비자 앱이 깨져도 CI는 초록불이었죠. "분리"의 대가로 "검증 사각지대"가 생긴 거예요.

CI에 한 스텝을 추가했어요.

```yaml
- name: Build consumer-app (독립 프로젝트)
  run: ./gradlew -p consumer-app build --console=plain
```

이제 소비자 앱도 매 push마다 빌드·테스트돼요. 분리하되, 검증에선 빠뜨리지 않는 거죠.

## 4. 부하테스트가 자기 방어에 걸렸다

마지막은 자기모순이었어요. [폭주 제어](/blog/project/pay/pay-36-overload-control)에서 rate limiter를 기본 on으로 켰는데, 정작 [성능 측정용 부하테스트](/blog/project/pay/pay-17-load-test-finds-bottleneck)(`checkout-load.js`)는 **단일 데모 유저**로 돌아요.

> 단일 유저가 초당 수십 번을 치니, per-user 5/s 제한에 **자기가 걸려서** 대량 429가 나요. 성능을 재려는 테스트가 자기 방어 장치에 막혀 측정이 왜곡되는 거죠.

이건 스크립트를 고치기보단 **문서로 정합**시켰어요 — checkout-load는 성능 측정용이니 `APP_RATELIMIT_ENABLED=false`로 돌리고, spike-test는 반대로 rate limit을 켜서 [shed를 측정](/blog/project/pay/pay-36-overload-control)한다고요. 두 테스트의 목적이 다르니 실행 방식도 다른 걸 명시했어요.

## 마치며

이번 편은 새 기능이 하나도 없어요. 배포가 결제를 안 끊게, 어드민이 힙을 안 태우게, CI가 사각지대를 안 남기게, 테스트가 자기모순에 안 빠지게 — **"실제로 운영 가능하게"** 만드는 마감들이었죠.

기능을 만드는 것과 그게 **운영에서 버티게** 하는 것은 다른 일이에요. graceful shutdown 두 줄, 페이지네이션 한 파라미터 — 작지만 이런 게 없으면 첫 배포·첫 트래픽에서 바로 티가 나요. 결제 시스템의 완성도는 화려한 기능이 아니라, 이런 **운영성의 마감**에서 갈리더라고요.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, graceful shutdown 드레이닝과 어드민 페이지네이션을 실기동으로 검증했습니다.*

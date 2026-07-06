---
title: '"프로세스 밖 소비자"라는 약속을 실제로 지키기 — 그리고 붙여보니 드러난 이중 인코딩'
titleEn: 'Keeping the "Out-of-Process Consumer" Promise for Real — and the Double Encoding It Exposed'
description: 결제 시스템 개선기. 결제 이벤트를 Kafka로 외부화하며 "프로세스 밖 소비자가 구독할 수 있다"고 약속했지만, 실제 구독자가 없어 약속에 머물러 있었다. 메인 빌드와 완전히 분리된 경량 소비자 앱을 만들어 별도 프로세스에서 이벤트를 수신했다 — 그리고 실제로 붙여보니, 와이어에 base64로 이중 인코딩된 페이로드가 흐르고 있었다. 직렬화기 한 줄이 만든 버그를, 실증이 아니면 영영 몰랐을 것이다.
descriptionEn: "Payment system improvement log. Externalizing payment events to Kafka promised 'out-of-process consumers can subscribe' — but with no actual subscriber it stayed a promise. I built a lightweight consumer app fully separate from the main build and received events in another process — and actually hooking it up revealed base64 double-encoded payloads on the wire. One serializer line caused a bug that nothing but a real consumer would ever have exposed."
date: 2026-12-12T00:00:00.000Z
tags:
  - Payment
  - Kafka
  - Event Driven
  - Spring Modulith
  - Serialization
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 38
---

*결제 시스템 시리즈. 개선기 — 약속을 실증으로, 실증이 버그를.*

## 0. 구독자 없는 외부화는 약속일 뿐

[Kafka 외부화 편](/blog/project/pay/pay-22-kafka-event-externalization)에서 결제 이벤트에 `@Externalized`를 달아 Kafka로 내보냈어요. 목적은 분명했죠 — **프로세스 밖 소비자**(분석, 별도 서비스, 다른 팀)가 이벤트 모델 무수정으로 구독할 수 있게.

그런데 돌아보니, 정작 **구독하는 프로세스 밖 소비자가 하나도 없었어요.** 토픽에 이벤트가 실리는 것까진 확인했지만, "다른 프로세스가 실제로 받아서 쓸 수 있다"는 건 여전히 **약속**이었지 실증이 아니었죠. [FDS 엔진](/blog/project/pay/pay-31-fds-review-queue)도 [대사 엔진](/blog/project/pay/pay-33-settlement-file-reconciliation)도 "만들어두고 안 연결된" 상태였다가 연결하며 완성됐듯 — 외부화도 소비자가 있어야 완성이에요.

그래서 만들었어요. 그리고 이번에도, **실제로 붙여보니 몰랐던 게 드러났어요.**

## 1. 소비자 앱 — 메인과 완전히 분리

소비자는 "정산 알림" 데모 워커예요. `payment.confirmed`/`payment.canceled`를 구독해 구조화 로그를 남기는 경량 앱. 설계에서 지킨 분리 원칙 세 가지 —

**(1) 빌드부터 분리.** `consumer-app/`은 자체 `settings.gradle`을 가진 **독립 Gradle 프로젝트**예요. 루트 멀티모듈에 include하지 않아서, 메인의 빌드·테스트·CI가 이 앱의 존재조차 몰라요. 실행만 wrapper를 공유하죠(`./gradlew -p consumer-app bootRun`). "별도 서비스"라면 빌드 생명주기부터 별도여야 하니까요.

**(2) 타입도 분리.** 소비자는 메인 앱의 이벤트 클래스를 import하지 않아요. 값을 **String으로 받아 Jackson `readTree`로 파싱**해요. producer가 붙이는 타입 헤더(`__TypeId__: com.beomsu.pay...PaymentConfirmedEvent`)에 기대면, 소비자가 발행자의 **내부 클래스명에 결합**돼요 — 그 순간 "프로세스 밖"의 의미가 사라지죠. 계약은 클래스가 아니라 **JSON 스키마**여야 해요.

**(3) 실패도 분리.** 파싱 안 되는 메시지(포이즌)는 warn 찍고 건너뛰어요 — 이상한 메시지 하나가 파티션 소비 전체를 멈추면 안 되니까요. 그리고 [outbox 재발행](/blog/project/pay/pay-22-kafka-event-externalization)은 at-least-once라 **중복 수신이 가능**하다는 것, 그래서 실소비자는 orderNo/paymentId 기반 멱등 처리가 필수라는 걸 코드에 명시했어요.

## 2. 붙여보니 — 와이어에 base64가 흐르고 있었다

두 앱을 나란히 띄우고 결제를 일으켰어요. 소비자가 이벤트를 받긴 받았는데 —

```
[정산알림] 결제 완료 수신 orderNo= amount=0 ...   ← 빈 값?!
```

파싱이 전부 빈 값이에요. 토픽을 직접 덤프해보니 —

```
"eyJvcmRlck5vIjoiMDFLV1c2OFpFMldNOVNFQVY5SEFONjdHSlEiLCJwYXltZW50SWQiOjEsImFtb3VudCI6MTAwMDAsIn..."
```

JSON이 아니라 **base64 문자열**이 흐르고 있었어요. 디코드하니 그 안에 정확한 JSON이 들어 있었고요. 이중 인코딩이죠.

> 원인은 직렬화기 궁합이었어요. Modulith 외부화는 이벤트를 **이미 JSON byte[]로 직렬화해서** KafkaTemplate에 넘겨요. 그런데 producer의 value-serializer가 `JsonSerializer`였고 — Jackson은 byte[]를 받으면 **base64 문자열로 JSON 인코딩**해요. 이미 JSON인 걸 한 번 더 감싼 거예요.
>
> 수정은 한 줄: `value-serializer: ByteArraySerializer`. 이미 직렬화된 byte[]를 **그대로** 와이어에 싣는 거죠.

고치고 다시 돌리니 —

```
[정산알림] 결제 완료 수신 orderNo=01KWW6HR... amount=10000 partition=0 offset=1
[정산알림] 결제 취소 수신 orderNo=01KWW6HR... cancelAmount=10000 fullyCanceled=true
```

별도 프로세스가 깨끗한 JSON을 받아 모든 필드를 정확히 파싱해요. 이제 "프로세스 밖 소비자"는 약속이 아니라 **동작하는 사실**이에요.

## 3. 왜 이 버그는 지금까지 숨어 있었나

곱씹어볼 지점이에요. 이 이중 인코딩은 [외부화를 만든 시점](/blog/project/pay/pay-22-kafka-event-externalization)부터 있었어요. 그런데 아무 테스트도 못 잡았죠 — 발행 측 설정 테스트는 "토픽으로 나간다"까지만 봤고, **와이어 포맷을 읽는 쪽이 없었으니** 포맷이 틀렸는지 알 길이 없었어요.

이 시리즈에서 반복된 패턴이 또 나온 거예요.

> [결제 확정 버그](/blog/project/pay/pay-26-persistence-bug)는 실기동 E2E가, [outbox 데드락](/blog/project/pay/pay-37-deadlock-retry)은 스파이크 실측이, 이번 이중 인코딩은 **실제 소비자를 붙이는 것**이 드러냈어요. 공통점 — **소비하는 쪽이 생기기 전까지, 만드는 쪽은 자기가 옳다고 믿는다.** 계약의 검증은 언제나 반대편 끝에서 옵니다.

Kafka를 붙일 계획이 없더라도, 이벤트를 외부화한다면 **더미라도 좋으니 진짜로 읽는 소비자를 하나 두는 것** — 그게 와이어 계약의 테스트예요.

## 마치며

이번 건 시리즈에서 계속 미뤄왔던 "프로세스 밖" 한 조각을 채운 편이에요. 독립 빌드·타입 비결합·포이즌 격리라는 소비자 쪽 원칙을 세웠고, 붙이는 과정에서 발행 쪽의 숨은 이중 인코딩까지 잡았어요.

이벤트 기반 아키텍처의 완성은 발행이 아니라 **구독**이더라고요. 구독자가 생기는 순간 계약이 검증되고, 포맷이 드러나고, 약속이 사실이 돼요.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, 소비자 앱은 [consumer-app/](https://github.com/dj258255/payment-system/tree/main/consumer-app)에서 별도 프로세스로 실행됩니다.*

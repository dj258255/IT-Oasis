---
title: '결제 시스템을 밑바닥부터 만들고 나서 — 27편의 회고'
titleEn: "After Building a Payment System from Scratch — A Retrospective in 27 Parts"
description: 결제 시스템 시리즈 회고. 주문·결제의 정상 경로가 아니라 실패·정합성 처리에 무게를 두고 밑바닥부터 만들었다. 타임아웃=UNKNOWN 3-상태, 보상 트랜잭션, 멱등, 서킷브레이커, 원장·정산·대사, 그리고 실기동이 드러낸 버그들까지 — 만드는 내내 "돌아가는 것"과 "실제로·안전하게 돌아가는 것" 사이의 구멍을 메운 여정을 돌아본다.
descriptionEn: "Retrospective of the payment-system series. Built from scratch with weight on failure and consistency, not the happy path. Timeout=UNKNOWN three-state, compensation, idempotency, circuit breakers, ledger/settlement/reconciliation, and bugs the live run exposed — a look back at closing the gap between 'it runs' and 'it runs correctly and safely.'"
date: 2026-09-26T00:00:00.000Z
tags:
  - Payment
  - Retrospective
  - Spring Modulith
  - Architecture
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 27
---

*결제 시스템 시리즈. 회고 — 밑바닥부터 만든 여정을 돌아보며.*

## 왜 이걸 만들었나

[첫 편](/blog/project/pay/pay-0-why-and-modulith)에서 이렇게 시작했어요 — 결제의 **정상 경로**는 사실 쉽다고. 주문 만들고, PG 부르고, 성공하면 완료. 어려운 건 그 다음이에요. **타임아웃되면? 중복 요청이 따닥 들어오면? 승인은 됐는데 재고가 없으면? 우리 DB와 PG가 어긋나면?**

그래서 이 프로젝트는 처음부터 "장애는 실제로 일어난다"를 전제로, **실패·정합성 처리**에 무게를 뒀어요. 27편에 걸쳐 만든 걸 돌아보면, 결국 하나의 주제로 수렴해요 — **"돌아가는 것"과 "실제로·안전하게 돌아가는 것" 사이의 구멍을 하나씩 메우는 일.**

## 세 갈래로 돌아보기

### 1) 실패를 상태로 보존하기

가장 핵심이었던 결정은 [타임아웃을 실패로 단정하지 않은 것](/blog/project/pay/pay-2-designing-for-failure)이에요. PG 승인이 타임아웃되면 성공도 실패도 아닌 **UNKNOWN(미확정)**으로 보존하고, [복구 배치](/blog/project/pay/pay-23-ops-admin)가 나중에 조회로 확정해요. "모르는 것을 모른다고 두는" 이 3-상태 모델이, 결제에서 이중결제·유실을 막는 뿌리였어요.

여기서 파생된 것들 — [멱등키](/blog/project/pay/pay-10-composite-payment)로 따닥 중복 차단, [서킷브레이커](/blog/project/pay/pay-24-chaos-testing)로 승인은 재시도 안 하고 UNKNOWN 폴백, [보상 트랜잭션](/blog/project/pay/pay-19-compensation-network-cancel)으로 승인 후 재고 부족을 자동 망취소. 전부 "부분 실패를 어떻게 봉합하느냐"의 변주였어요.

### 2) 돈의 정합성 지키기

돈은 틀리면 안 되니까, [복식부기 원장](/blog/project/pay/pay-4-ledger-settlement-reconciliation)(차변=대변 불변식), 정산, 그리고 내부·외부 기록을 맞춰보는 대사를 뒀어요. [취소](/blog/project/pay/pay-18-order-cancel)는 포인트 우선 환불·재취소 이중환불 차단을 다뤘고, [에스크로](/blog/project/pay/pay-25-escrow)는 구매확정 전까지 판매자 정산을 보류했어요.

이 정합성은 [모듈 경계가 지켜질 때만](/blog/project/pay/pay-21-ci-guards-boundaries) 성립해서, 경계를 `ModularityTests`로 강제하고 CI에 얹었어요. 그리고 이벤트를 [Kafka로 외부화](/blog/project/pay/pay-22-kafka-event-externalization)해 프로세스 밖으로도 흘릴 수 있게 여지를 뒀고요.

### 3) 측정하고, 검증하고, 드러내기

감이 아니라 수치로 결정하려 했어요. [락 3종 비교](/blog/project/pay/pay-5-lock-comparison)로 재고 차감 전략을 골랐고, [부하테스트가 BCrypt 병목을 짚어주자](/blog/project/pay/pay-17-load-test-finds-bottleneck) [JWT로 걷어내](/blog/project/pay/pay-20-jwt-removes-bottleneck) min 110ms→4ms를 전후 수치로 확인했어요. 복원력은 주장만 하지 않고 [Toxiproxy로 실제 네트워크를 끊어](/blog/project/pay/pay-24-chaos-testing) 검증했고요.

## 만드는 내내 반복된 것: 실기동이 진실을 말한다

돌아보면 이 시리즈에서 **"앱이 실제로 안 떴다"**가 몇 번이나 반복됐어요. [7편](/blog/project/pay/pay-7-making-it-run)에서, 확장 모듈을 붙였을 때, 그리고 스키마 마이그레이션을 빠뜨렸을 때. 테스트가 다 초록불이어도 실기동은 다른 얘기였어요.

정점은 [바로 앞 편](/blog/project/pay/pay-26-persistence-bug)이었어요. 200개가 넘는 테스트가 통과하는데도, **결제 승인이 DB에 확정되지 않는** 치명 버그가 실기동에서야 드러났어요. 리포지토리를 목으로 둔 단위 테스트는 "로직"만 검증하지 "영속"은 검증하지 못했거든요. 이 하나가 이 프로젝트 전체의 교훈을 압축해요 —

> **"테스트 초록불 ≠ 실제로 동작함."** 단위 테스트는 로직을, 통합·실기동은 진짜 동작을 검증한다. 결제처럼 정합성이 생명인 시스템일수록, "API가 200을 준다"에서 멈추지 말고 "DB에 올바르게 남는가"를 끝까지 눌러봐야 한다.

## 무엇이 남았나

이 시스템은 여전히 미완성이에요. JWT는 만료·갱신·폐기가 필요하고, Kafka 소비자는 별도로 존재하지 않고, 대사는 실제 PG 파일 포맷과 붙여야 하고, 부하도 단일 노트북 수준이에요. 실서비스라면 넘어야 할 산이 훨씬 많죠.

하지만 이 프로젝트의 목적은 "완성된 결제사"가 아니라, **결제 도메인의 어려운 지점들 — 실패, 정합성, 관측성 — 을 실제로 마주하고 하나씩 풀어보는 것**이었어요. 그리고 만드는 내내, 정상 경로보다 **"이 경우엔 어떻게 되지?"**라는 질문에 코드로 답하려 했어요.

## 마치며

결제 시스템을 밑바닥부터 만들어보고 나서 제일 크게 남은 건, **"어떻게 하면 성공하나"보다 "어떻게 실패하나, 그리고 그걸 어떻게 안전하게 다루나"가 훨씬 중요하다**는 감각이에요.

승인 한 번 성공시키는 건 쉬워요. 타임아웃된 승인을 미확정으로 보존하고, 중복 요청을 멱등하게 흘리고, 승인 후 문제를 보상으로 되돌리고, 그 모든 게 DB에 정확히 확정되는지 실기동으로 확인하는 것 — 이 지루하고 꼼꼼한 일들이 결제의 신뢰를 만든다는 걸, 27편을 만들며 몸으로 배웠어요.

읽어주셔서 감사합니다.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있습니다. 각 개선은 실측·실기동으로 검증했고, 발견한 버그는 재발 방지 테스트와 함께 고쳤습니다.*

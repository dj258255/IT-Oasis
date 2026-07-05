---
title: '아키텍처를 문서가 아니라 CI가 지키게 — 모듈 경계를 깨면 빌드가 깨진다'
titleEn: "Let CI Guard the Architecture, Not a Doc — Break a Module Boundary and the Build Breaks"
description: 결제 시스템 개선기. 모듈 경계는 문서에 적어두면 시간이 지나며 무너진다. 이 프로젝트는 경계를 Spring Modulith의 ModularityTests로 검증하는데, 이걸 GitHub Actions에 얹으니 "결제 모듈이 원장 내부를 몰래 참조" 같은 위반이 PR 단계에서 빌드를 깨뜨린다. 규율을 사람 리뷰가 아니라 CI에 맡긴 이야기.
descriptionEn: "Payment system improvement log. Module boundaries written in a doc erode over time. This project verifies boundaries with Spring Modulith's ModularityTests, and putting that on GitHub Actions means a violation like 'the payment module secretly reaching into the ledger's internals' breaks the build at PR time. A story of handing discipline to CI instead of human review."
date: 2026-08-15T00:00:00.000Z
tags:
  - Payment
  - CI
  - GitHub Actions
  - Spring Modulith
  - Architecture
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 21
---

*결제 시스템 시리즈. 개선기 — 아키텍처 규율을 CI로 자동화.*

## 0. 문서로 적은 규칙은 무너진다

[첫 편](/blog/project/pay/pay-0-why-and-modulith)에서 이 프로젝트를 **모듈형 모놀리스**로 짰다고 했어요. order, payment, point, ledger… 모듈마다 경계가 있고, 서로 정해진 통로(공개 API·이벤트)로만 대화해요.

문제는 이 경계가 **시간이 지나면 무너진다**는 거예요. 급하게 기능을 넣다 보면 "payment에서 ledger 내부 클래스 하나만 잠깐 쓰자" 같은 유혹이 생겨요. 한 번 뚫리면 다음은 더 쉽고, 반년 뒤엔 경계가 이름만 남죠. 아키텍처 문서에 "모듈 간 직접 참조 금지"라고 적어둬도, 그건 **강제되지 않는 약속**이에요.

## 1. 경계를 테스트로 검증한다

그래서 이 프로젝트는 처음부터 경계를 **테스트로** 박아뒀어요. Spring Modulith의 `ModularityTests`예요.

```java
@Test
void verifiesModularStructure() {
    ApplicationModules.of(PayApplication.class).verify();
}
```

이 한 줄이 전체 모듈 그래프를 훑어서, **허용되지 않은 모듈 간 의존**이 있으면 실패해요. 각 모듈은 자기가 의존해도 되는 모듈을 명시적으로 선언하거든요.

```java
@ApplicationModule(allowedDependencies = { "shared", "payment", "point" })
package com.beomsu.pay.order;
```

order는 shared·payment·point에만 의존할 수 있어요. 만약 누군가 order에서 ledger 내부를 참조하면, `verify()`가 "허용되지 않은 의존"이라고 딱 잡아내요. **경계가 실행 가능한 규칙**이 된 거죠.

## 2. 그런데 테스트는 안 돌리면 소용없다

여기에 구멍이 하나 있어요. 테스트로 만들어놨어도, **누가 그 테스트를 돌려야** 의미가 있어요. 로컬에서 깜빡하고 안 돌리거나, "이번엔 급하니까" 건너뛰면? 경계 위반이 그대로 머지돼요.

그래서 이걸 **GitHub Actions**에 얹었어요. PR을 올리거나 main에 푸시하면, CI가 자동으로 전체 테스트를 돌려요 — 그 안엔 `ModularityTests`도 있고요.

```yaml
- name: Run tests
  run: ./gradlew clean test --console=plain
```

이제 흐름이 이렇게 돼요.

> 누군가 payment에서 ledger 내부를 몰래 참조하는 PR을 올린다 → CI가 `./gradlew test`를 돈다 → `ModularityTests`가 "허용되지 않은 의존"으로 **실패** → PR에 빨간 X가 뜬다 → 머지 못 함.

경계를 지키는 일이 **사람의 기억력이나 리뷰어의 눈썰미**에서 **자동화된 게이트**로 옮겨간 거예요. 리뷰어가 놓쳐도 CI는 안 놓쳐요.

## 3. 결제 시스템이라 더 그렇다

이게 결제 도메인에서 특히 중요한 이유가 있어요. 결제 시스템은 [실패·정합성 처리](/blog/project/pay/pay-2-designing-for-failure)가 핵심이고, 그 정합성은 **모듈 경계가 지켜질 때** 성립해요.

예를 들어 [원장(ledger)](/blog/project/pay/pay-4-ledger-settlement-reconciliation)은 결제 이벤트를 **구독**해서 분개를 기록해요. 만약 payment가 ledger 내부를 직접 호출하는 지름길이 생기면, 이벤트 기반의 느슨한 결합이 깨지고 — [보상 트랜잭션](/blog/project/pay/pay-19-compensation-network-cancel)이나 재처리 로직이 은근슬쩍 어긋나기 시작해요. 경계가 무너지면 "결제와 회계가 따로 논다"는 최악의 상황으로 가는 거죠.

그래서 경계 검증을 CI 게이트로 두는 건, 단순한 코드 스타일이 아니라 **정합성의 방어선**이에요.

## 4. CI 구성에서 신경 쓴 것

몇 가지 소소한 결정이 있었어요.

- **Docker 불필요**: 테스트 스위트를 단위·슬라이스·H2(인메모리)로 짜뒀더니, CI 러너에 DB나 Testcontainers가 필요 없어요. `ubuntu-latest`에서 JDK 21만 있으면 결정적으로 돌아요. [락 비교 테스트](/blog/project/pay/pay-5-lock-comparison)를 H2로 짠 게 여기서도 값을 했죠.
- **동시성 취소**: 같은 브랜치에 새 푸시가 오면 진행 중인 실행을 취소하게 했어요(`concurrency`). 러너 시간 낭비를 줄여요.
- **실패 리포트 보존**: 실패해도 테스트 리포트를 아티팩트로 남겨, 뭐가 깨졌는지 바로 볼 수 있게요.

그리고 첫 실행이 초록불이 되는 걸 확인했어요 — 223개 테스트 + 모듈 경계 검증이 CI에서 통과.

## 마치며

이번 건 화려한 기능은 아니에요. 하지만 **"아키텍처를 어떻게 유지하느냐"**에 대한 답이라 개인적으론 꽤 좋아하는 편이에요.

경계를 문서에 적으면 무너지고, 리뷰에 맡기면 새요. 대신 **경계를 테스트로 만들고, 그 테스트를 CI가 매번 돌리게** 하면 — 규율이 사람의 의지가 아니라 시스템의 일부가 돼요. "깨지면 빨간불이 뜬다"는 것만큼 확실한 규칙은 없더라고요.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, CI는 매 PR·푸시마다 전체 테스트와 모듈 경계를 검증합니다.*

---
title: 'PG 연동은 흔하다 — 그래서 "결제가 실패했을 때"를 만든다'
titleEn: "Integrating a PG Is Common — So I'm Building 'When Payment Fails'"
description: 결제 시스템 포트폴리오를 시작한다. 그런데 토스페이먼츠 연동해서 "결제 성공"까지 가는 글은 이미 수십 개다 — 그건 차별화가 안 된다. 결제 공고 15곳과 카카오페이·토스·배민 기술블로그를 뒤져보니, 현직자가 파고드는 지점은 전부 PG가 책임지지 않는 영역이었다 — 타임아웃, 중복결제, 망취소, 정산, 대사. 첫 글은 왜 이걸 만드는지, 왜 Spring Modulith인지, 그리고 Modulith의 이벤트 레지스트리가 어떻게 Transactional Outbox를 공짜로 주는지.
descriptionEn: "Starting a payment-system portfolio. But there are already dozens of posts that integrate a PG and reach 'payment succeeded' — that's not a differentiator. After digging through 15 payment job postings and the engineering blogs of Kakao Pay, Toss, and Baemin, the parts practitioners probe are all the areas a PG does NOT cover — timeouts, duplicate charges, network cancels, settlement, reconciliation. This first post: why build this, why Spring Modulith, and how Modulith's event registry gives you a Transactional Outbox for free."
date: 2026-07-05T00:00:00.000Z
tags:
  - Payment
  - Spring Modulith
  - Spring Boot
  - Idempotency
  - Transactional Outbox
  - Java
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 0
---

*결제 도메인 취업을 목표로 실전 결제 시스템을 밑바닥부터 만드는 시리즈. 이 글은 0편 — 왜 만드는지, 그리고 아키텍처를 왜 Spring Modulith로 잡았는지.*

## 0. 들어가며

결제 시스템으로 포트폴리오를 만들기로 했어요. 그런데 시작하기 전에 조사부터 했습니다 — **결제 회사들이 실제로 뭘 원하는지**, 그리고 **이미 나와 있는 결제 포트폴리오는 어떤 모습인지**.

결과는 좀 뼈아팠어요. velog·티스토리에 "아임포트/포트원/토스페이먼츠 연동해서 결제하기" 글은 **수십 개**가 있어요. 결제창 띄우고, 승인 API 부르고, 취소 CRUD 만들면 끝. 이건 튜토리얼을 따라 한 거지 차별화가 아니에요. 채용하는 쪽도 그걸 압니다.

그럼 뭘 만들어야 하나. 결제 공고 15곳(토스페이먼츠·카카오페이·네이버페이·교보문고·PG 3사·배민·무신사…)과 카카오페이·토스·우아한형제들 기술블로그를 뒤졌어요. 반복되는 게 보이더라고요.

> 어필이 극대화되는 지점은 전부 **"PG가 책임지지 않는 영역"**이었어요 — 실패 처리, 상태 관리, 정산, 대사, 보상, 금액 배분, 규제 반영.

토스페이먼츠는 승인 API만 줘요. **타임아웃 나면 어떻게 할지, 중복결제를 어떻게 막을지, 서버가 죽었다 살아나면 미확정 결제를 어떻게 정리할지, PG 정산 파일이 내 기록과 안 맞으면 어떻게 할지** — 이건 전부 만드는 사람 몫이에요. 흔한 포트폴리오는 PG가 해주는 부분(연동)만 하고 끝나고, 진짜 도메인은 여기 빈 공간에 있어요.

## 1. 그래서 "실패부터" 만든다

조사에서 뽑은 차별화 축은 5개였어요. 그리고 이게 **결제 면접 단골 질문과 정확히 겹쳐요.**

| # | 만들 것 | 대응하는 면접 질문 |
|---|---|---|
| 1 | 실패 설계 — 멱등키 + 상태머신 + 보상 트랜잭션(망취소) | "PG 승인 후 DB 롤백되면?", "타임아웃 시 중복 환불 어떻게 막나?" |
| 2 | 보안 검증 — 웹훅 서명, 금액 위변조 검증 | "클라이언트가 금액을 조작하면?" |
| 3 | 정산 + 대사 — Spring Batch 정산, 복식부기 원장 | "내 기록과 PG 기록이 다르면?" |
| 4 | 수치 있는 성능 개선 — 부하테스트 리포트 | "동시에 1000명이 결제하면?" |
| 5 | 문서화 — ADR, 트러블슈팅, 장애 재현 실험 | (이력서·포트폴리오 서류 통과 그 자체) |

그래서 이 시리즈의 방향은 명확해요. **"결제 성공"은 1편이면 끝나고, 진짜 알맹이는 "결제가 실패했을 때"부터예요.** 타임아웃을 성공도 실패도 아닌 `UNKNOWN` 상태로 모델링하고, 망취소를 배치로 돌리고, 원장으로 정합성을 수학적으로 증명하는 것.

## 2. 아키텍처: 왜 Spring Modulith인가

첫 결정은 아키텍처였어요. 후보는 셋.

- **물리적 MSA**: 공고가 MSA를 원하니까. 근데 1인 포트폴리오에서 서비스별 배포·DB·네트워크를 처음부터 깔면, 분산 트랜잭션·네트워크 장애 같은 **본질이 아닌 인프라 복잡도**에 시간을 다 써요. 정작 보여줘야 할 도메인 설계가 묻히죠.
- **단일 패키지 모놀리스**: 편하지만 경계가 흐려져서 "결제와 정산이 서로 내부를 직접 호출하는" 스파게티가 돼요.
- **Spring Modulith (모듈형 모놀리스)**: 그 사이.

Modulith를 골랐어요. 이유는 **경계는 지키되 인프라는 단순하게** 가져갈 수 있어서예요.

`com.beomsu.pay` 바로 아래 각 패키지가 하나의 모듈이에요.

```
com.beomsu.pay
├── order          주문 상태머신, 금액 위변조 기준값
├── payment        승인/취소/멱등/상태머신/PG연동  ← 시스템의 심장
├── ledger         복식부기 원장
├── settlement     Spring Batch 정산
├── reconciliation 대사 (최종 방어선)
└── shared         Money 등 공유 값 타입 (OPEN 모듈)
```

핵심은 **모듈끼리 직접 호출하지 않고 도메인 이벤트로만 소통한다**는 거예요. 그리고 이 규칙을 말로만 지키는 게 아니라 `package-info.java`에 허용 의존을 선언하고, 테스트가 위반을 잡으면 **빌드를 깨뜨려요.**

```java
@org.springframework.modulith.ApplicationModule(
        allowedDependencies = { "shared" }   // payment는 shared만 의존 가능
)
package com.beomsu.pay.payment;
```

```java
class ModularityTests {
    static final ApplicationModules modules = ApplicationModules.of(PayApplication.class);

    @Test
    void verifiesModularStructure() {
        modules.verify();   // 순환 의존·불법 접근·내부 침투를 정적으로 검사
    }
}
```

이제 누가 실수로 `payment`에서 `settlement`의 내부 클래스를 가져다 쓰면 **테스트가 빨개져요.** 아키텍처 규칙이 문서가 아니라 코드가 되는 거죠.

## 3. 킬러 디테일: 이벤트 레지스트리가 곧 Outbox다

Modulith를 고른 진짜 이유는 따로 있어요.

결제 완료 이벤트를 원장·정산으로 보낼 때 고전적인 문제가 있어요 — **dual write.** "DB 커밋"과 "이벤트 발행"을 둘 다 성공시켜야 하는데, 순진하게 나눠 쓰면:

- DB 커밋 후 발행 실패 → **이벤트 유실** (결제는 됐는데 원장에 안 남음)
- 발행 후 DB 롤백 → **유령 이벤트** (원장엔 있는데 결제가 없음)

정석 해법이 **Transactional Outbox**예요. 도메인 변경과 이벤트를 하나의 트랜잭션으로 저장하고, 릴레이가 나중에 발행. 보통 이걸 직접 구현하는데 — 폴링 릴레이, 중복 발행 처리, 재시도… 버그 온상이에요.

그런데 **Spring Modulith의 Event Publication Registry가 정확히 이 Outbox예요.**

모듈이 이벤트를 발행하면 Modulith가 **같은 트랜잭션에서 `event_publication` 테이블에 INSERT**하고, 커밋 후 리스너를 호출해요. 리스너가 실패하거나 앱이 죽으면 미완료 이벤트가 테이블에 남고, 재기동 때 재발행되죠.

> 즉 내가 직접 짜려던 `outbox_events` 테이블을, 프레임워크가 검증된 형태로 공짜로 주는 거예요. 대신 원리는 이해하고 있어야 하고(면접에서 "왜 직접 안 짰나"를 물으니까), 그건 [설계 문서](/blog/project/pay)에 따로 정리해뒀어요.

이게 [ADR-002](/blog/project/pay)로 남긴 결정이에요. Outbox는 at-least-once라서, 받는 쪽은 **멱등 컨슈머**로 설계해야 한다는 것까지가 한 세트고요.

## 4. Phase 0에서 실제로 만든 것

말만 하면 안 되니까, 오늘 뼈대를 깔고 빌드를 통과시켰어요.

- **Java 21 + Spring Boot 3.4 + Spring Modulith 1.3**
- 6개 모듈 + 경계 검증 테스트 (`modules.verify()` 통과)
- `Money` 값 객체 — KRW는 `long`(원)으로, 부동소수점 안 쓰고, 음수 금지, 차감 결과가 음수면 예외. 잔액 부족·과다 취소를 **값 타입 수준에서** 막아요.
- MySQL + Redis를 Docker Compose로, Testcontainers로 통합 테스트 기반
- `open-in-view: false` — OSIV 꺼서 긴 트랜잭션/커넥션 점유를 처음부터 차단 (카카오페이 성능 개선기의 교훈을 기본값으로)
- ADR 2건, 모듈 다이어그램 자동 생성

작은 디테일 하나. 원장 테이블은 나중에 append-only(수정·삭제 금지)로 보호할 거라, JPA를 `ddl-auto: validate`로 뒀어요. 스키마는 마이그레이션으로 관리하고 JPA는 검증만 하게. 첫날부터 "실무처럼" 시작하려는 거예요.

## 5. 앞으로의 순서

```
Phase 0  뼈대            Modulith 6모듈 + 경계 검증        ← 오늘 여기
Phase 1  결제 코어        요청→인증→승인, 상태머신, 금액 검증
Phase 2  실패 설계 ★      멱등키, UNKNOWN 3-상태, 망취소, 서킷브레이커
Phase 3  웹훅+이벤트      서명 검증, Outbox→Kafka, 멱등 컨슈머, DLQ
Phase 4  정산+대사+원장 ★  복식부기, Spring Batch, 대사 4분류
Phase 5  성능 ★          부하테스트, 락 3종 비교, 목표→병목→개선 수치
Phase 6  운영            Grafana, 백오피스 어드민
```

이 시리즈는 **각 Phase가 끝날 때마다 여기 기록**하는 식으로 갈 거예요. 별표(★)가 차별화가 큰 구간이고요.

다음 편은 Phase 1 — 결제 코어. 토스페이먼츠 승인 플로우를 붙이면서, "요청과 승인을 왜 분리하는가"와 "금액 위변조를 어디서 막는가"부터 시작할게요.

---

*이 글은 작성 중인 시리즈의 일부예요. 설계 문서 전문(채용공고 분석, ERD, API 스펙, 장애 시나리오)은 별도 저장소에 정리돼 있고, 진행하며 이 시리즈로 풀어냅니다.*

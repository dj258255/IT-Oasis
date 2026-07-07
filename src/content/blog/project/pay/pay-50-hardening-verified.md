---
title: '"이거 진짜 고치는 게 맞아?" — 내 하드닝 추천을 웹서칭으로 검증하니, 하나는 수치가 틀렸고 하나는 방향이 틀렸다'
titleEn: '"Is This Actually Worth Fixing?" — I Verified My Own Hardening Picks Against Research, and One Had the Wrong Number, the Other the Wrong Direction'
description: 결제 시스템 개선기. 재감사로 하드닝 후보 셋을 골랐는데, "진짜 고치는 게 맞냐"는 물음에 웹서칭으로 하나하나 검증했다. 멱등키 TTL은 "24시간으로 줄여라" 했다가 토스페이먼츠가 실제로 15일인 걸 알고 철회했다 — 남은 건 무한 성장 막는 purge 하나. PG 승인을 트랜잭션 안에서 하는 건 "득 없다"고 했다가, 커넥션 풀 고갈 실사고들을 보고 내가 틀렸음을 인정했다 — 다만 모놀리스에선 ACID 원자성과의 트레이드오프라, 리팩터 대신 ADR로 남겼다. 추천을 검증하는 게 곧 엔지니어링이라는 이야기.
descriptionEn: "Payment system improvement log. An audit surfaced three hardening candidates, and when asked whether they were actually worth fixing, I verified each against research. For the idempotency key TTL I first said 'cut it to 24h,' then learned Toss Payments actually uses 15 days and retracted — leaving just a purge job to bound growth. For the PG call inside a transaction I said 'no benefit,' then saw the connection-pool-exhaustion incidents and admitted I was wrong — but in a monolith it's a trade-off against ACID atomicity, so I documented it in an ADR instead of refactoring."
date: 2027-03-06T00:00:00.000Z
tags:
  - Payment
  - Engineering
  - Idempotency
  - Transaction
  - Research
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 50
---

*결제 시스템 시리즈. 개선기 — 내 추천을 웹서칭으로 검증하다.*

## 0. "그거 진짜 고치는 게 맞아?"

[재감사](/blog/project/pay/pay-48-settlement-date-key-bug)로 하드닝 후보 셋을 골라놓고 스스로 물었어요 — **"이거 진짜 고칠 값어치가 있나, 아니면 내가 억지 부리는 건가?"** 그래서 각각을 웹서칭으로 실무 기준과 대조했어요. 결과가 재밌었어요 — 하나는 **수치**가 틀렸고, 하나는 **방향**이 틀렸어요. 둘 다 제 추천이요.

## 1. 멱등 TTL — "24시간으로 줄여라" 했다가 철회

첫 후보는 멱등키였어요. 코드를 보니 `IdempotencyRecord.TTL = Duration.ofDays(15)` — **15일**이었어요. 저는 이렇게 판단했죠.

> "Stripe·Razorpay는 멱등키를 **24시간** 보관한다. 15일은 15배 과하다 — 24h로 줄이자."

그럴듯했어요. 근데 코드 주석에 이렇게 적혀 있었어요 — "**토스페이먼츠와 동일하게 15일**." 그래서 웹서칭했어요. [토스페이먼츠 개발자센터](https://docs.tosspayments.com/guides/using-api/idempotency-key)가 명시하고 있었어요.

> "멱등키는 처음 요청에 사용한 날부터 **15일** 간 유효합니다."

**제가 틀렸어요.** 15일은 임의값이 아니라, 이 시스템이 모델링하는 **토스페이먼츠(한국 PG)에 의도적으로 맞춘 정확한 값**이었어요. 저는 Stripe의 24시간이라는 미국 PG 기준을, 토스를 모델링한 시스템에 무심코 들이댔던 거예요. **PG마다 정책이 다른데** 말이죠(Adyen은 최소 7일, Stripe 24h, 토스 15일).

그래서 "TTL을 줄여라"는 **철회**했어요. 대신 진짜 문제는 따로 있었어요 —

> TTL은 15일인데, **만료된 레코드를 지우는 장치가 없어서** `idempotency_keys` 테이블이 무한히 자라요. [아웃박스 테이블이 그랬던 것](/blog/project/pay/pay-40-schedulers)과 똑같은 계열이죠. 아웃박스엔 정리 스케줄러를 붙였는데 멱등 테이블은 빠져 있었어요.

그래서 TTL은 그대로 두고(토스 정합), 유효기간 지난 레코드만 주기 벌크 삭제하는 스케줄러를 붙였어요.

```java
@Modifying
@Query("delete from IdempotencyRecord r where r.expiresAt < :threshold")
int deleteByExpiresAtBefore(Instant threshold);   // 한 건씩 아니라 벌크 삭제
```

웹서칭이 경고한 게 하나 더 있었어요 — "**한 건씩 지우면 정리가 뒤처진다**(Stripe도 그래서 TTL 인덱스로 옮김)". 그래서 엔티티 loop 삭제가 아니라 단일 벌크 DELETE로 했고요. 실 MySQL로 만료(5일 전) 삭제·유효(15일 후) 유지를 확인했어요.

**교훈**: "업계 표준"을 안다고 그걸 아무 데나 들이대면 안 돼요. 이 시스템이 **어느 PG를 모델링하는지**가 정답을 바꿔요. 검증 안 했으면 멀쩡한 값을 15배 잘못 줄일 뻔했어요.

## 2. PG 콜 in 트랜잭션 — "득 없다" 했다가, 실사고들 앞에서 인정

두 번째는 반대 방향으로 틀렸어요. 체크아웃이 **PG 승인(외부 HTTP)을 DB 트랜잭션 안에서** 호출하고 있었어요. 저는 처음에 이렇게 말했어요.

> "안티패턴이긴 한데, 정합성은 이미 [UNKNOWN 복구](/blog/project/pay/pay-2-designing-for-failure)로 해결됐고, 커넥션 점유는 fast-fail로 완화되니 — **득이 별로 없다. 그냥 문서화하자.**"

근데 [읽는 분이](/blog) 되물었어요 — "득이 진짜 없어? 현업은 어떤데?" 그래서 웹서칭했어요. **제가 틀렸어요.**

> "외부 API 콜 중 DB 커넥션을 붙잡는 건 **classic leak pattern, silent killer**"예요. 실제 장애 사례가 수두룩해요 — 다운스트림 지연으로 인한 연쇄 결제 실패, 느린 쿼리가 커넥션을 소진시킨 수 시간 outage, 트래픽 2배에 커넥션 풀 고갈. 심지어 "**서킷브레이커도 기다리는 동안 풀이 찬다**"고 명시돼 있었어요. 제가 "완화됐다"던 그 서킷브레이커가 완전히 막지 못한다는 거죠. **득은 실재했어요.**

그래서 "득 없다"를 인정하고 물러섰어요. 그럼 고쳐야 하나? 여기서 **또 한 겹**이 있었어요.

> 현업 정석은 이 흐름을 **사가로 쪼개는** 것 — 짧은 로컬 트랜잭션(예약) → PG(트랜잭션 밖) → 확정/보상. 근데 트레이스해보니, 이 시스템은 **모듈러 모놀리스**라 체크아웃이 **단일 트랜잭션 = 진짜 ACID 원자성**을 갖고 있었어요. 사가로 쪼개면 그 원자성을 포기하고, **Phase 1에서 포인트 예약이 커밋된 뒤 크래시로 Phase 3를 못 하면 어중간하게 멈춘 사가**가 남아요. 이걸 복구하는 게 사가의 진짜 어려운 부분이고, 여기까지 안 하면 오히려 회귀(포인트 누수)예요.

즉 "외부 콜을 트랜잭션 밖으로"는 **고규모·MSA의 규칙**이고, 모놀리스에서 진짜 ACID를 포기하며 사가 복잡도를 떠안는 건 이 규모에선 **과할 수** 있어요. 그리고 커넥션 점유 위험은 `connection-timeout: 3s`가 이미 상한을 걸어줘요(느린 PG여도 3초 안에 떨어짐).

그래서 최종 판단은 — **리팩터 대신 [ADR](https://github.com/dj258255/payment-system)로 남겼어요.**

> ADR-007에 이렇게 적었어요: 안티패턴을 **인지**하고(실사고 인용), 이 모놀리스에선 ACID 원자성을 위해 **의도적으로** 단일 트랜잭션을 유지하며, fast-fail·서킷·UNKNOWN 복구로 완화하고, **스케일이 요구하면 3단계 사가로 이행**하는 경로(멈춘 사가 복구 포함)를 명시했어요. "규칙을 몰라서 안 한 것"이 아니라 "규칙과 예외를 알고 이 규모에선 원자성을 택한 것"이라는 걸 기록으로 남긴 거죠.

## 마치며

이번 편은 코드보다 **판단을 검증한** 이야기예요. 재감사로 후보를 골랐지만, "진짜 고치는 게 맞냐"를 웹서칭으로 되짚으니 — 하나는 **수치가**(24h vs 토스 15일), 하나는 **방향이**(득 없다 → 있다, 근데 트레이드오프) 틀렸어요.

배운 건 둘이에요. 하나는 **"업계 표준"도 맥락을 타야** 한다는 것 — 어느 PG를 모델링하는지, 모놀리스인지 MSA인지에 따라 같은 규칙의 답이 달라져요. 다른 하나는 **자기 추천을 의심하는 게 곧 엔지니어링**이라는 것. "이거 진짜 맞아?"를 웹서칭으로 되물었기에, 멀쩡한 값을 잘못 줄이지도, 크라운주얼을 과하게 뜯지도 않았어요. 결제처럼 신뢰가 생명인 도메인에선, 확신보다 **검증**이 더 미더운 것 같아요.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, 멱등 purge는 실 MySQL로, 체크아웃 트랜잭션 경계는 ADR-007로 트레이드오프를 남겼습니다.*

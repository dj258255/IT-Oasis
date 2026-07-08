---
title: 'pay 총정리 — 실패가 비싼 도메인을 밑바닥부터'
titleEn: 'pay, the Complete Story — Building a Payment System From the Ground Up'
description: "Spring Modulith로 만든 결제 시스템 pay의 전체 기록을 한 편에 정리합니다. 결제를 고른 이유(타임아웃·중복·미확정·정산 불일치가 실제로 아픈, 실패가 비싼 도메인)에서 시작해, 신뢰 경계를 어디에 긋는가·PG 타임아웃을 UNKNOWN으로 보존하고 복구가 확정하는 실패 설계·복식부기 원장으로 자금 이동을 검증하는 정합성·PG 콜을 트랜잭션 밖으로 뺀 체크아웃 사가·재고 락 3종 실측 비교, 그리고 구독·월렛·회원·분쟁까지 결제수단을 넓히며 새 수단을 기존 계약에 대칭시키는 법, 마지막으로 내가 만든 코드를 스스로 감사해 잡은 자금 손실 버그까지 — 시리즈를 안 읽어도 이 한 편으로 전체가 잡히게 썼고 깊이가 필요한 지점마다 해당 편을 링크했습니다."
descriptionEn: "The complete story of pay, a payment system built on Spring Modulith, in one post. Why payments (a domain where timeouts, duplicates, unknown states, and settlement mismatches actually hurt — failure is expensive), where to draw the trust boundary, preserving PG timeouts as UNKNOWN and letting recovery finalize them, verifying money movement with a double-entry ledger, a checkout saga that keeps the PG call outside the transaction, three locking strategies measured head-to-head, extending payment methods (subscription, wallet, membership, disputes) by mirroring proven contracts, and money-loss bugs caught by auditing my own code. Written so the series is optional; every depth is linked."
date: 2026-02-15
tags:
  - Payment
  - Spring Boot
  - Spring Modulith
  - Java 21
  - Distributed Systems
  - Learning
category: project/pay
draft: false
series: "결제 시스템 만들기"
seriesOrder: 0
---

## 이 글 하나로

결제 시스템을 밑바닥부터 만들며 배운 걸 한 편에 정리했습니다. 시리즈 열 편을 안 읽어도 이 글로 전체가 잡히도록 썼고, 더 깊이 보고 싶은 지점마다 해당 편을 링크해 뒀어요.

먼저 왜 하필 결제였느냐부터. 저는 **실패가 비싼 도메인**을 하나 제대로 파보고 싶었습니다. 결제는 그 조건에 딱 맞아요. 카드 승인 요청을 보냈는데 응답이 안 오면 그건 성공도 실패도 아니고, 서버가 죽었다 살아나면 어중간하게 걸친 결제를 누군가 정리해야 하고, 하루가 끝나면 내 장부와 PG가 보낸 정산 파일이 한 푼도 안 틀리게 맞아야 합니다. PG 연동 자체는 튜토리얼이 수십 개지만, 진짜 어려운 곳은 PG가 대신 해주지 않는 이 빈 공간에 있었어요. 그래서 그 빈 공간을 직접 만들어보기로 했습니다.

만든 결과를 세 문장으로 요약하면 이렇습니다. 첫째, **믿을 값과 안 믿을 값을 가른다** — 금액도 가격도 사용자 신원도 클라이언트가 아니라 서버와 인증 컨텍스트에서 정합니다. 둘째, **실패를 지운 셈 치지 않고 상태로 남긴다** — 타임아웃은 `UNKNOWN`으로 보존했다가 복구 배치가 PG에 되물어 확정합니다. 셋째, **돈이 맞는지 수학으로 증명한다** — 모든 자금 이동을 복식부기 원장에 차변=대변으로 남기고, 대사가 최종 방어선이 됩니다.

전체 코드는 [GitHub 저장소](https://github.com/dj258255/payment-system)에 있고, 설계 문서(도메인 조사·ERD·API 스펙·장애 시나리오)와 507개 테스트, 라이브 검증 기록이 함께 있습니다.

## 아키텍처 — 왜 모듈형 모놀리스인가

MSA로 시작하고 싶은 유혹이 있었지만, 1인 학습 프로젝트에서 서비스별 배포와 네트워크를 처음부터 깔면 정작 배우고 싶은 도메인 설계가 인프라 복잡도에 묻힙니다. 그래서 [Spring Modulith](/blog/project/pay/pay-ch1-payment-core)로 갔어요. `com.beomsu.pay` 아래 각 패키지가 하나의 모듈이고, 모듈 사이는 직접 호출이 아니라 도메인 이벤트로만 이어집니다. 이 경계는 문서가 아니라 테스트(`ModularityTests`)가 강제해서, 규칙을 어기면 빌드가 깨져요. 나중에 물리적으로 쪼갤 여지는 남기되 지금은 한 프로세스 안에서 도메인에 집중하는 선택이었습니다.

## 결제 코어와 실패 설계

가장 먼저 만든 건 주문·결제의 상태머신과 금액 검증입니다([1편](/blog/project/pay/pay-ch1-payment-core)). 결제 승인은 정상 승인, 명시적 거절, 그리고 **응답을 못 받은 미확정** 세 갈래로 갈리는데, 흔한 구현이 놓치는 게 세 번째예요. 타임아웃을 실패로 처리해 버리면, 실제로는 PG에서 승인된 결제를 우리만 실패로 알고 있는 최악의 불일치가 생깁니다. 그래서 미확정은 `UNKNOWN`으로 보존하고, 1분마다 도는 복구 배치가 PG 조회로 진짜 결과를 확정합니다. 중복 결제는 `Idempotency-Key`와 DB 유니크 제약으로 막는데, INSERT에 성공한 요청만 처리권을 갖는 구조라 "따닥" 연타에도 결제는 한 번만 일어나요.

승인 뒤 재고가 부족하면 이미 나간 돈을 되돌려야 합니다. 이 망취소를 아웃박스에 적재해 재시도하는 보상 트랜잭션으로 처리했고, 느린 PG에는 서킷브레이커로 대응했습니다.

## 정합성 — 원장·정산·대사

흔한 결제 예제가 거의 안 가는 곳이 여기예요([1편 후반](/blog/project/pay/pay-ch1-payment-core)). 잔액을 숫자 하나로 덮어쓰는 대신, 모든 자금 이동을 복식부기 분개로 남깁니다. 차변 합과 대변 합이 항상 같아야 한다는 불변식이 곧 "돈이 안 샜다"는 증명이에요. 정산은 하루치 결제를 집계해 수수료와 부가세를 떼고 판매자에게 줄 금액과 지급 예정일을 계산하고([8편](/blog/project/pay/pay-ch8-settlement-pg-webhook)), 대사는 내 기록과 PG 정산 파일을 대조해 네 가지로 분류합니다. 자동으로 못 맞춘 건 사람이 확정하는 큐로 넘어가요.

## 체크아웃 사가 — PG 콜을 트랜잭션 밖으로

처음엔 체크아웃 전체를 한 트랜잭션으로 묶었는데, 이게 위험했습니다([9편](/blog/project/pay/pay-ch9-audit-saga)). 트랜잭션 안에서 외부 PG를 호출하면, PG가 느려질 때 DB 커넥션을 붙잡은 채 기다리게 되고, 그 커넥션이 풀에서 마르면 앱 전체가 멈추는 연쇄 장애로 번집니다. 그래서 예약(트랜잭션) → PG 승인(트랜잭션 밖) → 확정·보상(트랜잭션)의 세 단계로 뜯었어요. 원자성을 포기한 대가로 "예약만 하고 확정 전에 죽은" 멈춘 사가가 생기는데, 이건 복구 배치가 PG 조회로 완결하거나 되돌립니다.

## 동시성 — 락을 수치로 골랐다

재고·잔액 차감에서 어떤 락을 쓸지, 감이 아니라 실측으로 정했습니다([3편](/blog/project/pay/pay-ch3-perf-cancel)). 비관적 락·낙관적 락·조건부 UPDATE 세 가지를 같은 부하로 돌려 이중 차감과 마이너스 잔액이 0건인지, 처리량이 어떤지 비교했고, 조건부 UPDATE를 골랐어요. 부하테스트로 병목을 찾은 뒤 요청당 BCrypt를 JWT로 걷어낸 전후 수치도 함께 남겼습니다.

## 결제수단을 넓히며 배운 것 — 계약의 대칭

구독·선불 월렛·복합결제·회원·분쟁까지 붙이면서([2편](/blog/project/pay/pay-ch2-payment-methods)·[10편](/blog/project/pay/pay-ch10-features-audit)) 한 가지 원리를 계속 마주쳤어요. **새 결제수단을 추가한다는 건 정상 경로를 잇는 게 아니라, 기존 수단이 가진 모든 계약을 빠짐없이 대칭시키는 일**이라는 것. 포인트가 예약·보상·취소·멱등·복구를 갖고 있다면, 월렛도 그 다섯을 똑같이 가져야 합니다. 하나라도 반만 베끼면 그 틈으로 돈이 새요.

## 운영과 관측성 — happy path 다음

자동 복구가 포기하는 순간이 반드시 옵니다. 그때 사람이 이어받을 어드민이 필요해서([5편](/blog/project/pay/pay-ch5-runtime-truths)), 미확정 결제 강제 조회·보상 재처리·수기 대사·강제취소 2인 승인 같은 백오피스를 만들었어요. 관측성은 CPU 같은 일반 지표 말고 **미확정 결제 최고 경과 시간**, **대사 미해결 건수** 같은 결제 도메인 고유 지표를 대시보드와 알림으로 노출했습니다([7편](/blog/project/pay/pay-ch7-consume-align-harden)). 보안·대기열·유입 제어는 [6편](/blog/project/pay/pay-ch6-security-queue)에 모았어요.

## 내 코드를 내가 감사했다

기능을 다 붙인 뒤, 그 신규 코드를 정면으로 감사했습니다([10편](/blog/project/pay/pay-ch10-features-audit)). 결과가 뼈아팠어요. 취소 경로가 월렛이라는 결제수단의 존재를 몰라 환불이 증발했고, 거절 후 재시도하면 멱등 장치가 오히려 공짜 결제를 만들었어요. 둘 다 앞서 말한 "계약을 반만 베낀" 실수에서 나왔고, 라이브로 재현해 확정한 뒤 고쳤습니다. 특히 적립 회수 버그 하나는 유닛테스트가 초록불인 채로 숨어 있다가 실 MySQL 재현에서야 잡혔는데, "동작한다"와 "맞다"가 다르다는 걸 다시 배운 지점이었어요.

## 남은 한계

범위를 좁히려고 일부러 선을 그은 것들이 있습니다. 쿠폰은 정책을 더 고민하려고 남겨뒀고, 다통화·정산 공휴일 캘린더·분쟁 대응기한 자동 처리는 "실서비스라면 이렇게 확장한다"고 문서에 적어만 뒀어요. 못 하는 걸 하는 척하기보다, 어디까지 했고 왜 거기서 멈췄는지를 적는 편이 정직하다고 봤습니다.

시리즈 각 편은 이 요약을 하나씩 풀어낸 기록입니다. 아래 목록에서 관심 가는 편부터 보셔도 좋아요.

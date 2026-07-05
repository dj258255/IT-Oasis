---
title: '결제는 만들고 나서가 진짜 — 관측성과 백오피스로 마무리'
titleEn: "The Real Work Starts After You Ship — Wrapping Up with Observability and a Back Office"
description: 결제 시스템 만들기 마지막 편. 코어를 다 만들었으니 운영 도구를 붙인다. 결제 성공률·p99·서킷 상태를 Micrometer로 계측해 Prometheus/Grafana로 보고, Phase 3에서 만든 DLQ를 운영자가 재처리하는 백오피스 어드민을 만든다. 그리고 Phase 0부터 6까지, 12개 커밋과 87개 테스트로 무엇을 증명했는지 되돌아본다.
descriptionEn: "The final chapter of building a payment system. With the core done, I add operational tooling. Instrumenting payment success rate, p99, and circuit state with Micrometer for Prometheus/Grafana, and building a back-office admin to reprocess the DLQ from Phase 3. Then a look back at what Phases 0 through 6 — 12 commits and 87 tests — actually proved."
date: 2026-07-11T00:00:00.000Z
tags:
  - Payment
  - Observability
  - Micrometer
  - Prometheus
  - Spring Modulith
  - Back Office
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 6
---

*결제 도메인 취업을 목표로 실전 결제 시스템을 밑바닥부터 만드는 시리즈. 이 글은 마지막 6편 — 운영, 그리고 전체 회고.*

## 0. 만든 다음이 진짜다

[Phase 5](/blog/project/pay/pay-5-lock-comparison)까지 결제 코어와 성능을 다 잡았어요. 그런데 결제 시스템은 **배포하고 나서가 진짜**예요. 돌아가는 걸 보고, 문제를 잡고, 새는 걸 메우는 것. 마지막 편은 그 도구예요.

```
관측성      결제 성공률·p99·서킷 상태를 Micrometer → Prometheus → Grafana
백오피스     DLQ 재처리 같은 운영 도구
```

## 1. 관측성 — CPU가 아니라 결제 성공률을 본다

흔한 실수는 CPU·메모리 같은 인프라 지표만 보는 거예요. 결제 시스템에서 진짜 중요한 건 **비즈니스 SLO** — "결제가 잘 되고 있나?"예요.

그래서 승인 결과를 결과별로 계측했어요.

```java
meterRegistry.counter("payment.confirm", "outcome", result.outcome().name().toLowerCase())
        .increment();
```

이 한 줄로 `payment_confirm_total{outcome="success|failed|timeout"}` 메트릭이 쌓여요. 그러면 Grafana에서 **결제 성공률**을 이렇게 계산해요.

```promql
sum(rate(payment_confirm_total{outcome="success"}[5m]))
  / sum(rate(payment_confirm_total[5m]))
```

이걸 테스트로도 박았어요 — `SimpleMeterRegistry`로 카운터가 실제 증가하는지 검증해요.

```java
service.confirm("order-1", "pk-1", Money.of(10_000));
assertThat(meterRegistry.counter("payment.confirm", "outcome", "success").count()).isEqualTo(1.0);
```

Spring Boot Actuator + Micrometer가 나머지도 공짜로 줘요 — p99 레이턴시(`http_server_requests`), HikariCP 풀 사용률, **서킷브레이커 상태**(`resilience4j_circuitbreaker_state`). Grafana 대시보드의 핵심 패널로 묶었어요.

| 패널 | 왜 |
|---|---|
| 결제 성공률 (SLO) | 비즈니스 건강도 |
| p99 레이턴시 | tail latency = 다운스트림 스톨 신호 |
| HikariCP 풀 사용률 | 커넥션 고갈 조기 경보 |
| 서킷브레이커 상태 | PG 장애 감지 |
| UNKNOWN 결제 추이 | 복구 배치 부하 신호 |

`monitoring/`에 `prometheus.yml`과 `dashboard.json`을 아티팩트로 넣어서, 클론하면 바로 띄울 수 있게 했어요.

## 2. 백오피스 — DLQ를 되살리다

[Phase 3](/blog/project/pay/pay-3-webhooks-and-outbox)에서 알림 처리가 실패하면 DLQ(Dead Letter Queue)에 격리한다고 했죠. 그런데 격리만 하고 끝이면 반쪽이에요. **누군가 그걸 다시 처리해야** 해요. 그게 백오피스의 일이에요.

> "백오피스"는 결제 채용공고에 **직무명으로 실재**해요 (섹타나인 "PG 시스템 Backend 정산 및 백오피스", 나이스페이먼츠 "PG BO서비스 개발"). 대부분 포트폴리오가 happy path에서 끝나는데, 어드민은 "운영을 안다"는 가장 확실한 증거예요.

DLQ 재처리를 만들었어요. 알림 채널이 복구되면 운영자가 다시 시도해요.

```java
public boolean reprocess(Long deadLetterId) {
    DeadLetter dl = deadLetters.findById(deadLetterId).orElseThrow(...);
    try {
        sender.sendPaymentReceipt(dl.getOrderNo(), dl.getPaymentId(), dl.getAmount());
        processedEvents.save(ProcessedEvent.of(dl.getEventKey(), CONSUMER));  // 멱등 마킹
        deadLetters.delete(dl);                                               // DLQ에서 제거
        return true;
    } catch (RuntimeException ex) {
        dl.incrementRetry();       // 여전히 실패 — 재시도 횟수만 올리고 DLQ에 남긴다
        return false;
    }
}
```

성공하면 DLQ에서 빼고 처리 완료로 마킹하고, 또 실패하면 재시도 횟수만 올려 남겨요. `GET /api/v1/admin/dead-letters`로 목록을 보고, `POST .../{id}/reprocess`로 되살리는 거죠.

그리고 여기서 하나 놓쳤다가 잡은 게 있어요. **어드민 엔드포인트를 인증 없이 열어뒀던 거예요.** 자동 보안 검토가 바로 짚었어요 — "결제 데이터 조회와 상태 변경(재처리)을 아무나 호출할 수 있다"고. 코드 주석엔 "운영에선 인증 붙는다"고 미뤄뒀는데, 검토의 지적이 맞았어요 — **인가를 미래로 미루면 안 되죠.** 그래서 Spring Security로 `/api/v1/admin/**`에 `ROLE_ADMIN`을 요구하고, 재처리엔 호출자를 감사 로그로 남기게 했어요.

```java
.authorizeHttpRequests(auth -> auth
    .requestMatchers("/api/v1/admin/**").hasRole("ADMIN")   // 어드민만
    .requestMatchers("/actuator/**").hasRole("ADMIN")        // 메트릭도 보호
    .anyRequest().permitAll())                              // 결제 흐름·웹훅
```

그리고 이걸 `@WebMvcTest`로 못 박았어요 — 인증 없이 호출하면 401, ROLE_ADMIN이면 200. (운영에선 여기에 **maker-checker(2인 승인)**·감사 테이블이 더 붙어요.)

> 재밌는 게, 이것도 이 시리즈의 교훈이랑 똑같아요 — "happy path는 만들었는데 접근 제어를 미뤘다"가 바로 결제 시스템에서 사고 나는 지점이거든요. 자동 검토가 그걸 커밋 단계에서 잡아준 거죠.

## 3. 회고 — Phase 0부터 6까지 무엇을 증명했나

이걸로 로드맵을 다 돌았어요. 커밋 12개, 테스트 87개. 되돌아보면, 각 Phase가 결제 면접 질문 하나씩에 **코드로** 답해요.

| Phase | 만든 것 | 답하는 질문 |
|---|---|---|
| 0 | Spring Modulith 뼈대 | "MSA 경험은?" → 모듈 경계를 테스트로 강제 |
| 1 | 주문·결제 코어 | "금액 조작 막나요?" → 신뢰 경계부터 |
| 2 | 멱등키·UNKNOWN 복구·서킷 | "따닥은? 타임아웃은? PG 장애는?" |
| 3 | 웹훅·Outbox·DLQ | "웹훅 두 번 오면? 이벤트 유실은?" |
| 4 | 원장·정산·대사 | "돈이 맞는지 어떻게 아나요?" |
| 5 | 락 3종 비교 | "동시에 1000명이 결제하면?" → 수치로 |
| 6 | 관측성·백오피스 | "운영은 어떻게?" |

시리즈를 관통하는 한 문장을 고르라면 이거예요.

> **결제 시스템의 차별화는 "성공"이 아니라 "실패와 정합성"에 있다.**

PG 연동해서 결제 성공까지는 흔해요. 진짜는 타임아웃을 UNKNOWN으로 보존하고, 멱등키로 따닥을 막고, 복식부기로 정합성을 증명하고, 대사로 최후 방어선을 치고, 락을 수치로 고르는 것 — **PG가 책임지지 않는 영역**이에요. 그리고 그게 정확히 현직자가 파고드는 지점이고요.

## 남은 것 (정직하게)

포트폴리오로는 충분히 갖췄지만, 프로덕션까지 가려면 남은 게 있어요.

- **스키마 마이그레이션**: 원장을 append-only로 지키려고 `ddl-auto: validate`를 쓰는데, 실제 기동엔 Flyway 마이그레이션이 필요해요. (다음 작업)
- **실 PG 연동**: 지금은 상태 기반 FakePgClient로 모든 시나리오를 결정적으로 테스트해요. 토스페이먼츠 실 키 연동은 어댑터 하나 추가.
- **실 부하 수치**: 락 비교는 실측했고, 엔드투엔드 k6 스크립트는 준비됐어요. 앱을 띄우고 돌리면 TPS·p99가 나와요.
- **확장 기능**: 멀티 PG 라우팅·구독 결제·선불 월렛·FDS 등은 [설계 문서](/blog/project/pay)에 정리해뒀고, 기존 기반 위에 얹는 형태로 설계했어요.

여기까지, "결제가 실패했을 때"를 제대로 만드는 여정이었어요. 읽어주셔서 고맙습니다.

---

*이 시리즈는 Spring Modulith 기반으로, 각 실패 시나리오를 테스트로 재현하며 만들었어요. 코드는 87개 테스트로 검증돼 있습니다.*

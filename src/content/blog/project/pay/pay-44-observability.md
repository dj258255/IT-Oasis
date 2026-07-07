---
title: 'CPU 말고 "미확정 결제 나이"를 본다 — 결제 SLO를 대시보드와 알림으로, 그리고 스크레이프를 막은 시큐리티'
titleEn: 'Watch the Age of Unconfirmed Payments, Not CPU — Payment SLOs as Dashboards and Alerts, and the Security That Blocked the Scrape'
description: 결제 시스템 개선기. 그라파나 대시보드 JSON은 있는데 정작 그라파나도, 프로메테우스 배선도, 알림도 없었다. 배선하면서 결제 도메인 고유의 SLO를 게이지로 만들었다 — 미확정 결제가 얼마나 오래 방치됐나, 대사 미해결이 몇 건이나 쌓였나. CPU·메모리가 아니라 "이 결제 시스템이 건강한가"를 결제 언어로 본다. 그런데 실기동해보니 스크레이프가 401에 막혔고, p99는 No data였다. HTTP 200이 아니라 실제 수집 경로를 봐야 한다는 걸 다시 배운 이야기.
descriptionEn: "Payment system improvement log. There was a Grafana dashboard JSON, but no Grafana, no Prometheus wiring, no alerts. Wiring it up, I built SLO gauges native to the payment domain — how long the oldest unconfirmed payment has aged, how many reconciliation exceptions are piling up. Not CPU or memory, but whether this payment system is healthy, in the language of payments. Then a live run showed the scrape blocked by 401 and p99 as No data. A story of relearning that you must verify the actual collection path, not an HTTP 200."
date: 2027-01-23T00:00:00.000Z
tags:
  - Payment
  - Observability
  - Prometheus
  - Grafana
  - SLO
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 44
---

*결제 시스템 시리즈. 개선기 — 관측성을 실전화하다.*

## 0. JSON은 있는데, 그걸 볼 스택이 없었다

[전수 감사](/blog/project/pay/pay-39-settlement-escrow-alignment)가 이 시리즈 후반에 반복해서 짚은 패턴이 있어요 — **"만들어는 놨는데 실제로 연결은 안 했다."** [암호화 금고를 만들고 안 넣었고](/blog/project/pay/pay-41-encryption-applied), [배치 로직을 짜고 스케줄러를 안 달았죠](/blog/project/pay/pay-40-schedulers). 관측성도 똑같았어요.

`monitoring/dashboard.json`은 있었어요. 근데 —

> **그라파나가 없어요.** 프로메테우스도 없고, 둘을 compose에 배선한 것도, 대시보드를 자동 로드하는 프로비저닝도, 알림 룰도 없었어요. dashboard.json은 "언젠가 그라파나에 수동 임포트하면 되는" 죽은 파일이었죠. 관측성이라기보단 관측성의 **스크린샷**이었어요.

이번엔 이걸 진짜로 돌아가게 만들었어요. 그런데 배선하는 과정에서, "결제 시스템의 관측성이란 뭘 봐야 하나"라는 질문과 "실기동해야만 보이는 벽" 둘 다를 만났어요.

## 1. CPU가 아니라 "결제가 건강한가"를 본다

관측성의 기본은 CPU·메모리·힙 같은 시스템 메트릭이에요. 그건 Micrometer가 공짜로 줘요. 하지만 그것만으론 "이 **결제 시스템**이 건강한가"를 답 못 해요. CPU가 20%여도 결제는 다 실패하고 있을 수 있거든요.

그래서 이 도메인만의 SLO 지표를 게이지 두 개로 만들었어요.

```java
// payment.unknown.oldest.age — 가장 오래된 UNKNOWN(미확정) 결제의 나이(초)
Gauge.builder("payment.unknown.oldest.age", this, PaymentSloMetrics::unknownOldestAgeSeconds)
        .baseUnit("seconds")
        .register(meterRegistry);
```

이게 왜 중요하냐면 — [PG 타임아웃은 결과를 모르는 UNKNOWN으로 보존](/blog/project/pay/pay-2-designing-for-failure)하고, [복구 배치가 나중에 조회로 확정](/blog/project/pay/pay-40-schedulers)한다고 했잖아요. 그럼 **"UNKNOWN이 몇 건이냐"보다 "가장 오래된 UNKNOWN이 얼마나 오래 미확정이냐"가 진짜 신호**예요. 복구 배치가 밀리거나 망취소가 안 돌면 이 값이 계속 커지거든요. 10분 넘게 미확정인 결제가 있다? 그건 고객 돈이 붕 뜬 채로 방치되고 있다는 뜻이에요.

두 번째는 대사예요.

```java
// recon.pending.count — 사람 확인이 필요한 PENDING 대사 건수
Gauge.builder("recon.pending.count", this, m -> repository.countByStatus(ReconStatus.PENDING))
        .register(meterRegistry);
```

[대사는 최종 방어선](/blog/project/pay/pay-33-settlement-file-reconciliation)이라, 내부 장부와 PG 파일이 안 맞는 PENDING 예외가 쌓인다는 건 "누군가 봐야 할 불일치가 적체되고 있다"는 신호죠.

게이지 supplier는 스크레이프마다(15초) 단일 집계 쿼리만 돌아요 — `min(requestedAt)` 하나, `count` 하나. 가벼워요.

![Grafana 결제 SLO 대시보드 — 성공률·TPS·미확정 나이·대사 적체·결과별 rate·p95/p99·HikariCP](/uploads/project/pay/demo/demo-grafana-dashboard.png)

성공률 100%, 처리량 1.24 req/s, 미확정 0초, 대사 0건. **결제 언어로** 시스템 상태를 한눈에 보는 거예요.

## 2. 알림은 코드다

대시보드는 사람이 봐야 알아요. 근데 새벽 3시엔 아무도 안 보죠. 그래서 같은 지표를 **알림 룰**로도 코드화했어요(`monitoring/alert-rules.yml`). 결제 SLO 5개예요.

| 알림 | 조건 | 심각도 |
|---|---|---|
| PaymentSuccessRateLow | 5분 결제 성공률 < 95% | critical |
| CompensationExhausted | [보상 재시도 소진](/blog/project/pay/pay-19-compensation-network-cancel) > 0 | critical |
| UnknownPaymentAging | 미확정 결제 나이 > 10분 | critical |
| DeadlockRetrySpike | [데드락 재시도](/blog/project/pay/pay-37-deadlock-retry) > 10회/분 | warning |
| ReconPendingBacklog | 대사 PENDING > 0 (15분+) | warning |

![Prometheus 결제 SLO 알림 룰 5종 — 모두 inactive](/uploads/project/pay/demo/demo-prometheus-alerts.png)

지금은 5개 모두 **inactive**예요. 시스템이 건강하니까요. 알림은 "아무 일 없을 땐 조용하고, 조건이 맞으면 운다" — 이 상태가 정상이에요.

여기서 성공률 알림에 미묘한 게 하나 있었어요.

> 성공률 = `성공/전체`인데, 트래픽이 아예 없으면 분모가 0이라 `0/0 = NaN`이 돼요. 그럼 `< 0.95` 비교가 참일까요? 아니에요 — 프로메테우스는 NaN을 비교에서 빼서 **발화하지 않아요.** 덕분에 새벽에 트래픽이 0일 때 "성공률 0%!" 오탐이 안 떠요. 이걸 몰랐으면 `or vector(1)` 같은 방어를 넣었을 텐데, 산술 자체가 알아서 해결해줬죠.

## 3. 진짜 배움 — 실기동하니 스크레이프가 401이었다

여기까지는 코드예요. compose도 파싱되고, 테스트도 통과하고, 대시보드 JSON도 유효해요. 근데 **실제로 띄워보니** 프로메테우스가 아무것도 못 긁고 있었어요.

```
GET /actuator/prometheus  →  401 Unauthorized
WWW-Authenticate: Bearer
```

[시큐리티](/blog/project/pay/pay-20-jwt-removes-bottleneck)가 `/actuator/**`를 ADMIN 뒤에 두고 있었거든요. 근데 프로메테우스 수집기는 JWT를 들고 다니지 않아요 — 그냥 15초마다 익명으로 GET 할 뿐이죠. 그러니 **전부 401.** 대시보드는 텅 비고요.

이게 이번 편의 진짜 배움이었어요.

> compose가 파싱되고 테스트가 초록불이라고 "관측성이 된다"가 아니에요. **"프로메테우스 → 시큐리티 필터체인 → /actuator/prometheus"라는 런타임 경로**가 실제로 뚫려야 되는 거예요. HTTP 200 하나를 보는 게 아니라, [실기동해서](/blog/project/pay/pay-26-persistence-bug) 스크레이프가 진짜 긁히는지를 봐야 알아요.

고친 건 최소 개방이에요 — `/actuator/prometheus`만 열고(수집기가 인증 없이 긁어야 하니), 나머지 actuator(env·heapdump 같은 정찰 소지)는 계속 ADMIN으로 잠갔어요.

```java
.requestMatchers("/actuator/health", "/actuator/info", "/actuator/prometheus").permitAll()
.requestMatchers("/actuator/**").hasRole("ADMIN")
```

운영에선 `management.server.port`를 내부망 전용 포트로 분리해서 스크레이프하는 게 정석이에요. 여기선 로컬 프로메테우스를 위해 이 엔드포인트만 열되, [그 가정을 README에 적었어요](/blog/project/pay/pay-42-security-hardening) — 숨기지 않고요.

## 4. p99가 No data였다

스크레이프가 뚫린 뒤에도 "요청 p99 레이턴시" 패널만 **No data**였어요. 이유가 재밌어요.

> p99는 `histogram_quantile(0.99, ...http_server_requests_seconds_bucket...)`로 구해요. **버킷**이 있어야 분위수를 내죠. 근데 Micrometer는 기본적으로 HTTP 요청에 **히스토그램 버킷을 안 만들어요** — `_count`, `_sum`, `_max`만 내요. 그래서 `_bucket` 계열이 없어서 쿼리가 통째로 비었던 거예요.
> 평균(`sum/count`)은 낼 수 있어도 p99는 못 내요. 평균은 "느린 1%"를 숨기니까, 결제엔 p99가 훨씬 중요한데 말이죠.

설정 한 줄로 버킷을 켰어요.

```yaml
management:
  metrics:
    distribution:
      percentiles-histogram:
        http.server.requests: true
```

이제 프로메테우스가 버킷을 받아 서버측에서 p95/p99를 집계해요. 대시보드에 p99 ≈ 60ms 곡선이 떠요.

## 마치며

이번 편도 "만든 걸 실제로 쓰다"의 반복이에요. dashboard.json이라는 껍데기에 프로메테우스·그라파나·알림·게이지를 붙여 살아 움직이게 했죠.

근데 두 가지가 남아요. 하나는 **결제 관측성은 CPU가 아니라 도메인 언어여야** 한다는 것 — "미확정 결제가 얼마나 오래 방치됐나", "대사가 몇 건 밀렸나"처럼, 그 시스템이 정말 걱정해야 할 걸 봐야 해요. 다른 하나는 **관측성도 실기동으로만 검증된다**는 것. 스크레이프를 막은 시큐리티도, 버킷이 없어 빈 p99도, 코드를 아무리 읽어도 안 보였어요. 띄워서 프로메테우스가 진짜 긁는 걸 보고서야 알았죠.

대시보드는 코드예요. 그리고 코드가 그렇듯, **돌려봐야** 진짜 도는지 알아요.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, Prometheus/Grafana 스택을 compose로 실기동해 스크레이프·게이지·알림 룰·p99 집계를 모두 실측·캡처했습니다.*

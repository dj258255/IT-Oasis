---
title: '결제 재시도는 가용성을 높이는가, 장애를 증폭하는가'
description: '승인 재시도는 이중 결제를 만들 수 있고, 조회 재시도는 retry storm을 만들 수 있다. BE-commerce에서 결과 확정 여부를 기준으로 재시도 경계를 나누고, 재시도 횟수보다 장애 중 호출량과 정상 API 영향을 측정하는 이유를 정리했다.'
date: 2026-09-22
category: study/be-commerce
coverImage: "/uploads/project/be-commerce/diagrams/erd.svg"
draft: false
unlisted: true
series: "결제 시스템 만들기"
seriesOrder: 26
tags:
  - Payment
  - Retry
  - Reliability
  - 결제 시스템
---

결제 시스템에서 재시도는 “실패하면 다시 호출한다”로 끝나지 않습니다. 승인 요청은 네트워크가 끊긴 순간에도 PG에서 이미 처리됐을 수 있고, 상태 조회는 읽기라 재시도할 수 있지만 장애 중에는 호출량을 증폭시킬 수 있습니다.

## 결과가 확정됐는가를 먼저 본다

현재 BE-commerce의 기준은 다음과 같습니다.

| 호출 | 결정 | 얻는 것 | 포기한 것 |
|---|---|---|---|
| 승인 | 자동 재시도하지 않음 | 이중 결제 방지 | 일시 장애에서 즉시 성공할 기회 |
| 상태 조회 | 최대 3회 + backoff/jitter | 일시 장애 흡수 | 장애 중 추가 호출량 |
| 승인 동시성 초과 | PG에 닿기 전 확정 실패 | 유령 UNKNOWN 방지 | 순간 처리량 |
| 승인 예외·서킷 오픈 | UNKNOWN 보존 | 나중에 조회로 수렴 | 즉시 확정 |

핵심은 재시도 가능 여부가 아니라 **결과가 확정됐는가**입니다. PG에 닿았을 가능성이 있으면 실패라고 단정하지 않고, 닿지 않았음이 보장될 때만 실패로 확정합니다.

## 재시도 횟수만 보면 잘못된 결론을 낸다

조회에 재시도를 넣은 뒤에는 다음 지표를 추가했습니다.

- `payment.pg.query.retry`: 실제 추가 시도 횟수
- `payment.pg.query.retry.exhausted`: 재시도 예산을 모두 쓴 횟수
- `payment.unknown.oldest.age`: 아직 확정되지 않은 결제의 나이

재시도 횟수가 많고 성공률이 높아 보여도 정상 API의 p95가 악화되고 PG 호출량이 폭증했다면 좋은 복구가 아닙니다. 그래서 이번 retry storm 실험에서는 오류율·도착률·동시성·PG 지연을 고정하고 정상 API p95, connection wait, UNKNOWN age를 함께 비교했습니다.

Uber는 장애의 원인 서비스와 단순히 장애를 전달한 서비스를 구분하는 error ownership을 retry 판단에 사용한다고 설명합니다. 모든 호출자가 같은 방식으로 재시도하면 호출 깊이에 따라 요청이 증폭될 수 있기 때문입니다. 현재 BE-commerce는 호출 경계가 짧아 이 구조를 복제하지 않고 bounded retry·jitter·서킷·동시성 상한을 먼저 선택했습니다.

## 로컬 brownout에서 확인한 것

실제 PG 대신 fake PG에 지연과 timeout을 주입하고, 임시 MySQL 스키마에서 도착률 2 req/s·읽기
2 req/s·10초의 open-loop 부하를 돌렸습니다.

| 조건 | confirm 결과 | confirm p95 | 읽기 p95 |
|---|---:|---:|---:|
| PG 300ms · 동시 상한 1 | 성공 20건 | 382.81ms | 12.94ms |
| PG 3,000ms · 상한 1 · timeout 500ms | PENDING 13건, 사전 거절 8건 | 542.04ms | 16.20ms |
| PG 3,000ms · 상한 없음 · timeout 500ms | 성공 9건, HTTP 실패 24/52 | 8.33s | 3.00s |

상한을 끄자 마지막 대조군에서 Hikari connection timeout 133건과 active connection 최대 17개가
관측됐습니다. 상한 1에서는 PG에 닿은 요청만 PENDING으로 남고, 닿기 전 요청은 실패로 끊겨 일반
읽기를 보호했습니다. 이 결과는 “timeout을 짧게 하면 성능이 좋아진다”가 아니라, 미확정 결제와
일반 API 지연 사이의 비용을 어디에 둘지 결정한 것입니다.

항상 실패하는 조회 더블에 200개 요청·32개 worker를 동시에 넣은 retry storm 실험에서는 delegate
호출 32회, retry event 32회, exhausted 0회, 45ms가 측정됐습니다. 공유 서킷이 먼저 열려 200×3회의
호출로 증폭되지 않았습니다. 반대로 단일 조회의 retry 예산은 별도 테스트에서 최대 3회로 제한됩니다.

재현 기록은 [retry storm 실험 문서](https://github.com/dj258255/BE-commerce/blob/main/docs/34-%EA%B2%B0%EC%A0%9C-%EC%9E%AC%EC%8B%9C%EB%8F%84%EC%99%80-retry-storm-%EC%8B%A4%ED%97%98.md)에 남겼습니다.

## 아직 외부 검증이 필요한 것

실제 PG 장애에서의 retry budget 최적값, 다단 호출 체인의 error ownership, provider별 p99는 로컬 fake PG만으로 확정할 수 없습니다. 이 프로젝트에서는 이를 구현 완료라고 쓰지 않고 실험 카드로 남겼습니다.

## 참고

- [Uber - How Uber Protects Against Retry Storms](https://www.uber.com/us/en/blog/protecting-against-retry-storms/)
- [Stripe - Idempotency](https://stripe.com/blog/idempotency)
- [retry storm 실험 설계](https://github.com/dj258255/BE-commerce/blob/main/docs/34-%EA%B2%B0%EC%A0%9C-%EC%9E%AC%EC%8B%9C%EB%8F%84%EC%99%80-retry-storm-%EC%8B%A4%ED%97%98.md)

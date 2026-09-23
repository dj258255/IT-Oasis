---
title: '결제 원장의 Hot Entity: 정합성을 지키면서 처리량을 얻는 법'
description: '원장에 강한 일관성을 적용해도 특정 계정과 판매자에 쓰기가 몰리면 처리량이 떨어진다. append-only 원장, 잔액 스냅샷, 직렬화 배치 사이에서 무엇을 측정하고 언제 선택해야 하는지 정리했다.'
date: 2026-09-22
category: study/be-commerce
coverImage: "/uploads/project/be-commerce/diagrams/erd.svg"
draft: false
unlisted: true
series: "결제 시스템 만들기"
seriesOrder: 29
tags:
  - Payment
  - Ledger
  - Concurrency
  - 결제 시스템
---

원장에 강한 일관성을 적용하면 돈이 틀어지는 문제를 줄일 수 있습니다. 그러나 특정 판매자나 계정에 거래가 몰리면 같은 잔액을 갱신하는 쓰기가 직렬화되고, 인스턴스를 늘려도 그 계정의 경합은 줄지 않습니다. 이것이 hot entity 문제입니다.

Uber는 결제 원장의 hot entity에서 정합성을 포기하지 않고 serialized batch-write로 처리량을 높였다고 설명합니다. 중요한 것은 “무조건 비동기로 바꿨다”가 아니라, 강한 일관성이 필요한 경계를 유지하면서 직렬화 비용을 어디서 감당할지 선택한 것입니다.

## 현재 BE-commerce의 선택

- 원장 거래는 append-only다.
- 차변 합계와 대변 합계가 생성 시점에 같아야 한다.
- 잔액은 엔트리 합으로 계산되는 파생값이다.
- 스냅샷은 아직 추가하지 않는다.

스냅샷을 넣으면 잔액 조회는 빨라질 수 있지만 원장과 스냅샷이라는 두 개의 읽기 기준이 생깁니다. 스냅샷을 잘못 갱신하면 빠른 값이 틀린 값이 됩니다. 그래서 현재는 SUM의 비용을 실측하고, hot account 경합이 관측될 때만 스냅샷이나 계정별 직렬화 배치를 검토합니다.

## 측정하지 않고 최적화하지 않는다

- 일반 계정과 hot 계정의 동시 쓰기
- lock wait와 throughput
- p95/p99 commit latency
- 원장 재생성 잔액과 스냅샷 잔액 비교
- 재시작·재처리 후 차변/대변 불변식 검사

처리량이 올라도 잔액이 재생성되지 않거나 감사 추적이 끊기면 성공으로 보지 않습니다.

## 실제 MySQL에서 먼저 잰 것은 읽기 비용이었다

실제 `ledger_entries`에 benchmark transaction만 임시로 넣고 지운 뒤, 10회 반복 측정했습니다.
doubling 방식으로 실제 행 수는 12,474·98,490·196,794행이 됐습니다.

| 원장 행 수 | 조건 | single account p95 | group by p95 |
|---:|---|---:|---:|
| 12,474 | covering index 있음 | 3.9ms | 11.1ms |
| 98,490 | covering index 있음 | 29.8ms | 90.7ms |
| 196,794 | covering index 있음 | 61.2ms | 183.6ms |
| 196,794 | covering index 없음 | 64.6ms | 121.4ms |

특정 계정 조회는 인덱스가 약간 이득을 주지만, 전체 계정 `GROUP BY`에서는 인덱스가 더 느렸습니다.
따라서 “인덱스를 추가하면 원장이 빨라진다”가 결론이 아닙니다. 읽기 패턴마다 얻는 것과 잃는 것이
다르고, 현재 규모에서는 두 진실을 만드는 잔액 스냅샷을 도입하지 않기로 했습니다.

이후 동일 hot account에 동시 분개를 몰아넣어 lock wait·commit throughput을 측정하고, 그 결과를
스냅샷 도입 기준과 비교했습니다. 재현 명령과 중단 시 정리 규칙은 [hot entity 판단
문서](https://github.com/dj258255/BE-commerce/blob/main/docs/37-%EA%B2%B0%EC%A0%9C-%EC%9B%90%EC%9E%A5%EC%9D%98-hot-entity%EC%99%80-처리량.md)에 남겼습니다.

## hot account 동시 쓰기 실험 결과

이 실험은 별도 MySQL 8.4 InnoDB 컨테이너에서 실행했습니다. worker 8개가 200회씩
갱신했고, 같은 계정 행을 갱신하는 hot 조건과 서로 다른 행을 갱신하는 cold 조건을 비교했습니다.

| 조건 | 처리량 | p95 | p99 | row lock waits |
|---|---:|---:|---:|---:|
| hot, 같은 계정 | 207.1/s | 44ms | 47ms | 1,599 |
| cold, 서로 다른 계정 | 1,224.2/s | 8ms | 10ms | 0 |

같은 행을 갱신하면 처리량은 약 83.1% 낮아지고 p95는 5.5배 높아졌습니다. 그렇다고 바로 잔액
스냅샷을 정답으로 삼지는 않았습니다. 스냅샷은 읽기를 줄이는 대신 원장과 파생값이라는 두 기준을
만들기 때문입니다. hotness가 실제 트래픽에서도 반복되는지 확인한 뒤, 재생성 검증을 포함한 별도
결정으로 남겨야 합니다.

재현 명령과 원장 SUM 측정 결과는 [hot entity 판단 문서](https://github.com/dj258255/BE-commerce/blob/main/docs/37-%EA%B2%B0%EC%A0%9C-%EC%9B%90%EC%9E%A5%EC%9D%98-hot-entity%EC%99%80-%EC%B2%98%EB%A6%AC%EB%9F%89.md)에 남겼습니다.

## 참고

- [Uber - Zero-Sum by Design: 10 Years of Uber’s Payments Platform](https://www.uber.com/bl/en/blog/ubers-payments-platform/)
- [Modern Treasury - Enforcing Immutability](https://www.moderntreasury.com/journal/enforcing-immutability-in-your-double-entry-ledger)
- [Hot Entity 판단 문서](https://github.com/dj258255/BE-commerce/blob/main/docs/37-%EA%B2%B0%EC%A0%9C-%EC%9B%90%EC%9E%A5%EC%9D%98-hot-entity%EC%99%80-%EC%B2%98%EB%A6%AC%EB%9F%89.md)

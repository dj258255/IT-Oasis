---
title: '[DE Ch-16] 윈도와 interval join: 시간 범위가 짝을 정하고 상태 크기도 정한다'
description: 끝이 없는 스트림을 집계하려면 시간으로 잘라야 하고 두 스트림을 이으려면 시간 범위 안에서 짝을 찾아야 합니다. Flink의 텀블링, 슬라이딩, 세션, 글로벌 윈도와 trigger, evictor가 결과를 내는 시점을 정리하고 주문과 결제를 interval join으로 이을 때 범위를 넓힐수록 짝지어지는 비율과 붙들고 있어야 하는 상태가 함께 늘어나는 것을 시뮬레이션으로 셉니다.
date: 2026-10-19T00:00:00.000Z
tags:
  - Data Engineering
  - Flink
  - Window
  - Interval Join
  - Stream Processing
category: data/Streaming
topics:
  - pipeline
  - messaging
draft: false
series: "DE 공부"
seriesOrder: 16
---

## 결론부터

1. 윈도는 끝없는 스트림을 시간으로 자르는 방법입니다. 겹치지 않는 텀블링, 겹치는 슬라이딩, 활동이 끊기면 닫히는 세션, 직접 trigger를 붙여야 하는 글로벌 윈도가 있습니다.
2. 이벤트 시간 윈도의 기본 trigger는 watermark가 윈도 끝을 넘을 때 한 번 결과를 냅니다. 결과가 언제 나오는지는 Ch-15의 watermark가 정합니다.
3. interval join은 한쪽 이벤트 시각을 기준으로 정한 범위 안에 있는 상대편 이벤트와 짝을 짓습니다. 주문과 결제를 시뮬레이션해 보니 범위를 1분으로 두면 결제가 있는 주문의 60.0%만 짝지어졌고 5분이면 94.0%, 60분이면 100%였습니다.
4. 범위를 넓히면 그동안 짝을 기다리는 이벤트를 상태로 들고 있어야 합니다. 같은 시뮬레이션에서 평균 보관 주문 수가 1분 6.9건에서 60분 416.7건으로 늘었습니다. 범위는 짝지어지는 비율과 상태 크기를 맞바꿉니다.

---

## 1. 끝없는 스트림을 시간으로 자르기

"지난 1분 동안의 조회 수"처럼 스트림을 집계하려면 어디서 끊을지 정해야 합니다. Flink Windows 문서의 네 가지 윈도입니다.

| 윈도 | 동작 | 쇼핑몰 예 |
|---|---|---|
| 텀블링(tumbling) | 크기가 고정되고 겹치지 않는다 | 1분마다 상품별 조회 수 |
| 슬라이딩(sliding) | 크기와 이동 간격을 따로 정한다. 이동이 크기보다 작으면 겹친다 | 5분마다 계산하는 최근 10분 인기 상품 |
| 세션(session) | 정해진 간격 동안 이벤트가 없으면 닫힌다 | 30분 동안 행동이 없으면 끝나는 방문 세션 |
| 글로벌(global) | 키마다 하나의 윈도. 기본 trigger가 영원히 발화하지 않아 직접 trigger를 붙여야 의미가 있다 | 장바구니에 상품이 10개 쌓일 때마다 |

슬라이딩 윈도는 이벤트 하나가 여러 윈도에 들어갑니다. 크기 10분, 이동 5분이면 이벤트마다 두 윈도에 속하니 계산과 상태가 그만큼 늘어납니다.

## 2. 결과가 나오는 시점: trigger와 evictor

윈도는 세 부품으로 움직입니다.

| 부품 | 하는 일 |
|---|---|
| window assigner | 이벤트를 어느 윈도에 넣을지 정한다(위 네 가지) |
| trigger | 윈도를 언제 계산할지 정한다. 메서드는 `onElement`, `onEventTime`, `onProcessingTime`, `onMerge`, `clear` |
| evictor(선택) | trigger가 발화한 뒤 윈도 함수 앞이나 뒤에 일부 이벤트를 뺀다 |

이벤트 시간 윈도의 기본 trigger는 `EventTimeTrigger`이고 watermark가 윈도 끝을 넘으면 한 번 발화합니다. 문서는 watermark가 도착하면 최대 타임스탬프(윈도 끝 - 1)가 새 watermark보다 작은 모든 윈도를 계산한다고 적습니다. 그래서 Ch-15에서 본 watermark의 지연이 곧 윈도 결과의 지연입니다.

윈도의 수명도 정해져 있습니다. 문서의 예시로 5분 텀블링 윈도에 allowed lateness 1분이면, 12:00~12:05 윈도는 첫 이벤트가 올 때 만들어지고 watermark가 12:06을 지나면 지워집니다. allowed lateness를 늘리면 그만큼 윈도 상태가 오래 남습니다.

세션 윈도에서는 늦게 온 이벤트가 이미 닫힌 두 세션 사이를 메워 두 세션을 하나로 합칠 수도 있습니다. 결과를 이미 낸 두 세션이 나중에 하나로 바뀌니 받는 쪽이 정정을 처리할 수 있어야 합니다.

## 3. 두 스트림 잇기

### 3-1. window join과 interval join

주문 스트림과 결제 스트림을 주문 ID로 이어 "주문 후 결제까지 걸린 시간"을 보고 싶다고 해 봅시다. 데이터베이스라면 두 테이블을 조인하면 되지만 스트림에서는 상대편 이벤트가 언제 올지 모릅니다. 영원히 기다릴 수는 없으니 시간 범위를 정해야 합니다.

| 조인 | Flink 문서의 정의 |
|---|---|
| window join | 같은 키를 가지고 같은 윈도에 있는 두 스트림의 이벤트를 잇는다. inner join처럼 동작한다 |
| interval join | 스트림 A의 이벤트 a와 B의 이벤트 b가 같은 키이고 `b.timestamp ∈ [a.timestamp + lower, a.timestamp + upper]`이면 잇는다. 현재 inner join만 한다 |

window join은 윈도 경계에 걸린 짝을 놓칩니다. 10:00:58의 주문과 10:01:03의 결제는 1분 윈도 기준으로 서로 다른 윈도라 이어지지 않습니다. interval join은 각 주문 시각을 기준으로 범위를 잡아서 이 문제가 없습니다.

```java
orders.keyBy(o -> o.orderId)
      .intervalJoin(payments.keyBy(p -> p.orderId))
      .between(Duration.ZERO, Duration.ofMinutes(5))     // 주문 뒤 0~5분 안의 결제
      .process(new PaymentLatencyFunction());
```

DataStream API의 interval join은 이벤트 시간만 지원합니다. Flink SQL의 interval join은 처리 시간도 받고 양쪽 시간을 묶는 조건(`o.order_time BETWEEN s.ship_time - INTERVAL '4' HOUR AND s.ship_time` 같은)과 등호 조건이 하나 이상 필요합니다.

### 3-2. 재현: 범위가 정하는 두 가지

- 주문 1만 건이 하루 동안 고르게 들어옵니다(시드 고정).
- 결제는 주문의 90%에만 있고 주문 뒤 평균 1분(지수분포)에 오며 그중 5%는 10~40분 뒤에 옵니다.
- 결제 시각이 [주문 시각, 주문 시각 + 범위] 안이면 짝을 짓습니다.
- 상태는 범위 동안 주문을 기억하는 것으로 셉니다. 평균 동시 보관 수는 초당 주문 수 × 범위입니다.
- 코드는 [labs/de-study/ch16](https://github.com/dj258255/IT-Oasis/tree/main/labs/de-study/ch16)의 `interval_join.py`입니다.

결제가 실제로 있는 주문은 9,010건입니다.

| 범위 | 짝지은 주문 | 결제 있는 주문 중 | 평균 보관 주문 수 |
|---|---|---|---|
| 1분 | 5,407건 | 60.0% | 6.9건 |
| 5분 | 8,469건 | 94.0% | 34.7건 |
| 15분 | 8,615건 | 95.6% | 104.2건 |
| 60분 | 9,010건 | 100.0% | 416.7건 |

범위를 5분에서 15분으로 세 배 늘려도 짝지어지는 비율은 1.6%포인트만 늘고 상태는 세 배가 됩니다. 늦게 오는 5%가 10~40분 뒤에 몰려 있어서 그 꼬리를 잡으려면 범위를 40분 이상으로 잡아야 합니다. Ch-08에서 본 꼬리 지연이 여기서는 조인 범위와 상태 크기로 나타납니다.

이 시뮬레이션은 하루 1만 건이라 상태가 작습니다. 초당 1만 건이면 60분 범위에서 3,600만 건을 들고 있어야 하고 이 상태는 체크포인트마다 저장됩니다(Ch-17).

### 3-3. 범위 밖의 짝

interval join은 inner join이라 범위 안에 짝이 없는 주문은 결과에 나오지 않습니다. "결제가 안 된 주문"이 궁금하다면 interval join으로는 볼 수 없습니다. 범위를 넘긴 주문을 따로 내보내려면 상태와 타이머를 직접 다루는 `KeyedProcessFunction`으로 짜거나, Flink SQL의 outer join을 씁니다. 늦게 온 결제를 버리지 않으려면 Ch-15의 side output처럼 받을 길을 따로 만들어야 합니다.

## 4. 중국과 국내 빅테크 사례

### 4-1. 快手: 늦은 데이터를 얼마나 견딜지가 상태 크기를 정한다

快手의 2021년 글은 일간 활성 사용자(DAU)의 중복 제거를 세 가지로 설계해 비교했습니다.

| 설계 | 순서 뒤바뀜 허용 | 상태 크기 |
|---|---|---|
| 기기 ID + 차원 + 분을 키로 | 16분 | 약 480GB |
| 타임스탬프로 판단 | 0 | 약 30GB |
| 최종안: 링 버퍼 형태 | 16분 | 증가를 억제 |

순서 뒤바뀜을 16분까지 견디려면 그 시간만큼 기억해야 해서 상태가 열여섯 배쯤 커졌습니다. 3-2절에서 조인 범위가 상태 크기를 정한 것과 같은 구조이고 상태를 담는 자료구조를 바꿔서 둘을 함께 얻은 사례입니다. 같은 글은 오프라인 결과와의 오차를 1% 이내로 맞추는 것을 목표로 적었습니다.

### 4-2. 토스: 슬라이딩 윈도 기간과 상태

토스의 2026년 글 "Apache Flink + RocksDB 튜닝으로 광고 Frequency Capping 실시간 집계를 일주일까지 확장하기"는 광고 노출 빈도를 분, 시간, 일 단위로 세는 앱을 따로 운영합니다. 상태가 분 단위 앱 약 1.5GB, 시간 단위 약 11.8GB, 일 단위 약 110GB였고 일 단위 앱의 디스크상 상태는 집계 기간 1일 9GB, 3일 32GB, 7일 68GB로 기간에 거의 비례했습니다. 세이브포인트는 220~230GB였습니다. 상태를 다루는 방법(RocksDB 튜닝, 체크포인트)은 Ch-17에서 이어집니다.

## 5. 범위와 한계

- 3-2절은 시뮬레이션입니다. Flink를 돌리지 않았고 상태 크기는 "범위 동안 주문을 기억한다"는 단순 계산입니다. 실제 Flink interval join은 양쪽 스트림을 모두 버퍼에 들고 있습니다.
- 결제 지연 분포는 일부러 골랐습니다. 실제 데이터에서는 지연 분포를 먼저 재고 범위를 정해야 합니다.
- temporal join(버전이 있는 테이블의 그 시점 값과 잇는 조인)은 다루지 않았습니다.

## 6. 헷갈렸던 것

**Q. 범위를 넉넉히 잡으면 되지 않나요?**

짝지어지는 비율은 오르지만 상태가 범위에 비례해서 늘고 결과가 나오는 시점도 늦어집니다. 범위가 끝나야 "짝이 없다"를 확정할 수 있기 때문입니다. 지연 분포를 보고 업무에서 받아들일 수 있는 누락 비율에 맞춰 정합니다.

**Q. 하한을 음수로 둘 수도 있나요?**

됩니다. 하한과 상한은 음수도 양수도 될 수 있고 하한이 상한보다 작거나 같으면 됩니다. 결제 이벤트가 주문 이벤트보다 먼저 도착할 수 있는 경우(예: 결제 시스템의 시계가 앞서 있거나 주문 이벤트가 늦게 발행되는 경우)에는 하한을 음수로 둡니다.

**Q. 윈도 결과가 두 번 나올 수도 있나요?**

allowed lateness를 주면 늦은 이벤트가 올 때마다 같은 윈도의 결과를 다시 냅니다(late firing). 세션 윈도는 늦은 이벤트가 세션을 합칠 수도 있습니다. 받는 쪽은 윈도 키(시작, 끝)로 덮어쓰는 방식으로 받아야 합니다.

## 참고 자료

- Apache Flink 2.3, [Windows](https://nightlies.apache.org/flink/flink-docs-stable/docs/dev/datastream/operators/windows/)
- Apache Flink 2.3, [Joining](https://nightlies.apache.org/flink/flink-docs-stable/docs/dev/datastream/operators/joining/)
- Apache Flink 2.3, [SQL Joins](https://nightlies.apache.org/flink/flink-docs-release-2.3/docs/sql/reference/queries/joins/)
- Tyler Akidau, [Streaming 102: The world beyond batch](https://www.oreilly.com/radar/the-world-beyond-batch-streaming-102/), 2016
- 실습 코드: [labs/de-study/ch16](https://github.com/dj258255/IT-Oasis/tree/main/labs/de-study/ch16)

중국과 국내 빅테크 사례
- 李天朔(快手), [快手基于 Flink 构建实时数仓场景化实践](https://developer.aliyun.com/article/787654), 2021
- 이승민, 최원용, [Apache Flink + RocksDB 튜닝으로 광고 Frequency Capping 실시간 집계를 일주일까지 확장하기](https://toss.tech/article/flink-realtime-frequency-capping), 토스, 2026

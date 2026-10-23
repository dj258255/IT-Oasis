---
title: '[DE Ch-15] Flink의 시간과 watermark: 얼마나 기다릴지가 지연과 완전성을 맞바꾼다'
description: 끝이 없는 입력에서는 "이 구간의 데이터가 다 왔다"를 알 수 없어서 watermark라는 추정을 씁니다. watermark를 늦게 잡으면 결과가 늦고 빨리 잡으면 늦게 온 데이터를 버립니다. 허용치별로 버려지는 이벤트와 결과 지연을 시뮬레이션으로 세고 조용한 파티션 하나가 전체 watermark를 붙잡는 현상과 idleness 설정을 Flink 2.3 문서와 사례로 정리합니다.
date: 2026-10-19T00:00:00.000Z
tags:
  - Data Engineering
  - Flink
  - Event Time
  - Watermark
  - Stream Processing
category: data/Streaming
topics:
  - pipeline
  - messaging
draft: false
series: "DE 공부"
seriesOrder: 15
---

## 결론부터

1. 이벤트 시간(event time)은 일이 일어난 시각이고 처리 시간(processing time)은 시스템이 그걸 처리한 시각입니다. 네트워크와 재시도 때문에 둘은 어긋나고 순서도 뒤바뀝니다.
2. watermark는 "이 스트림의 이벤트 시간이 t에 도달했다"는 선언이고 t 이하 이벤트는 더 오지 않는다는 추정입니다. 끝이 없는 입력에서는 다 왔는지 알 방법이 없어서 추정을 씁니다. 추정이 틀리면 늦은 데이터가 생기고 Flink는 기본적으로 그 데이터를 버립니다.
3. 허용치(bounded out-of-orderness)를 시뮬레이션으로 바꿔 보니 0초면 늦은 이벤트 2.32%를 버리고 결과는 윈도 끝 0.2초 뒤에 나왔습니다. 5초면 0.10%만 버리는 대신 결과가 5.2초 뒤에 나왔습니다. 허용치는 지연과 완전성을 맞바꾸는 손잡이입니다.
4. 연산자의 watermark는 입력 중 가장 작은 값입니다. 파티션 하나가 조용해지면 전체 watermark가 멈추고 윈도 결과가 나오지 않습니다. 시뮬레이션에서 120초 동안 윈도 결과가 2개만 나왔고 idleness를 5초로 주니 11개가 나왔습니다.

---

## 1. 두 개의 시간

이 글이 풀려는 질문은 하나입니다. 쇼핑몰 대시보드에 "10:00~10:01 주문 수"를 띄우려고 할 때 10:01이 되자마자 숫자를 내도 될까요? 10:00:59에 생긴 주문이 네트워크에서 3초 헤매다 10:01:02에 도착할 수 있으니 바로 내면 그 주문이 빠집니다. 그렇다고 마냥 기다리면 숫자가 영영 안 나옵니다. 얼마나 기다릴지를 정하는 장치가 watermark이고 이 글은 그 장치가 어떻게 움직이는지, 어디서 막히는지를 차례로 봅니다.

Ch-01에서 배치와 스트림의 차이를 입력이 끝나는지로 봤고 끝이 없는 입력은 "언제 결과를 내도 되는지"를 따로 정해야 한다고 했습니다. Ch-04에서는 배치 작업의 실행 시각과 데이터 구간을 나눴습니다. 스트림에도 같은 두 시간이 있습니다.

Flink 2.3 문서의 정의입니다.

| 시간 | 정의 |
|---|---|
| 처리 시간 | 그 연산을 실행하는 기계의 시스템 시각 |
| 이벤트 시간 | 각 이벤트가 그 이벤트를 만든 기기에서 일어난 시각 |

쇼핑몰 앱의 상품 조회 이벤트라면 이벤트 시간은 사용자가 화면을 연 순간이고 처리 시간은 Flink가 그 이벤트를 받은 순간입니다. 지하철에서 연 화면의 이벤트는 몇 분 뒤에 도착할 수 있습니다. "10시 정각부터 1분 동안의 조회 수"를 처리 시간으로 세면 네트워크 사정에 따라 결과가 달라지고 같은 데이터를 다시 돌려도 다른 값이 나옵니다. 이벤트 시간으로 세야 다시 돌려도 같은 결과가 나옵니다(Ch-03의 멱등성).

## 2. watermark: 다 왔다는 추정

### 2-1. 정의

이벤트 시간으로 "10:00~10:01 윈도"를 세려면 언제 그 윈도를 닫고 결과를 낼지 알아야 합니다. 10:01이 지난 이벤트가 하나 왔다고 해서 10:00대 이벤트가 더 안 온다는 보장은 없습니다.

Flink 문서는 `Watermark(t)`를 그 스트림의 이벤트 시간이 t에 도달했다는 선언이라고 정의합니다. t 이하 타임스탬프를 가진 이벤트는 더 오지 않아야 한다는 뜻입니다. 윈도는 watermark가 윈도 끝을 넘을 때 결과를 냅니다.

처음 읽으면 "선언"이라는 말이 잘 와닿지 않습니다. 공항 탑승구에 빗대면 쉽습니다. 탑승구는 출발 시각이 되면 손님이 다 왔든 안 왔든 닫고 그 뒤에 뛰어온 손님은 못 탑니다. watermark도 데이터가 다 왔는지 확인할 방법이 없으니 "이 시각까지는 다 왔다고 치고 마감하겠다"고 정하는 마감 시각입니다(GeekNews에 소개된 ["실시간 데이터의 '마감 시간' 정하기"](https://news.hada.io/topic?id=25297)가 이 비유로 설명합니다). [Ververica의 입문 글 "Watermarks in Apache Flink Made Easy"](https://ververica.com/blog/watermarks-in-apache-flink-made-easy)는 순서가 뒤섞여 도착하는 이벤트를 시각 순으로 다시 정렬해 내보내는 프로그램을 예로 듭니다. 4가 먼저 왔다고 바로 내보내면 뒤에 2가 왔을 때 순서가 틀리고 1이 올지 모른다고 영원히 기다리면 아무것도 못 내보냅니다. 언젠가는 "2보다 이른 것은 더 안 온다"고 정해야 하고 그 판단이 watermark입니다.

### 2-2. 손으로 따라가 보기

허용치 2초, 10초짜리 윈도로 이벤트 여섯 개를 따라가 보겠습니다. 허용치 2초는 "지금까지 본 가장 늦은 이벤트 시간에서 2초를 뺀 값"을 watermark로 쓴다는 뜻입니다. 이벤트 시간은 도착 순서와 다르게 뒤섞여 있습니다.

| 도착 순서 | 이벤트 시간 | 지금까지 본 최대 | watermark(최대 - 2) | 일어나는 일 |
|---|---|---|---|---|
| 1 | 3초 | 3 | 1 | 윈도 [0, 10)에 들어감 |
| 2 | 1초 | 3 | 1 | 순서는 뒤바뀌었지만 윈도가 아직 열려 있어 들어감 |
| 3 | 8초 | 8 | 6 | 윈도 [0, 10)에 들어감 |
| 4 | 12초 | 12 | 10 | 윈도 [10, 20)에 들어감. watermark가 10에 닿아 [0, 10)이 결과 3건을 냄 |
| 5 | 9초 | 12 | 10 | [0, 10)은 이미 결과를 냈으므로 버려짐(늦은 이벤트) |
| 6 | 11초 | 12 | 10 | 윈도 [10, 20)에 들어감 |

두 가지를 볼 수 있습니다. 2번처럼 순서가 바뀌어도 허용치 안이면 문제가 없습니다. 5번은 이벤트 시간이 9초라서 [0, 10)에 들어가야 하는데 12초짜리 이벤트가 먼저 와서 watermark를 10까지 밀어 버렸기 때문에 버려집니다. 허용치가 4초였다면 4번 시점의 watermark는 8이라 윈도가 닫히지 않았고 5번도 들어갔습니다. 대신 결과는 이벤트 시간 14초짜리가 올 때까지 늦어집니다. 3절의 시뮬레이션은 이 표를 이벤트 6,000개로 늘린 것입니다.

표에서는 이벤트마다 watermark를 다시 계산했지만 실제 Flink는 일정 주기로 내보냅니다(2-3절). 또 Flink의 `forBoundedOutOfOrderness` 구현은 "최대 - 허용치"에서 1ms를 더 빼고 윈도는 "윈도 끝 - 1ms"에 watermark가 닿으면 발화해서 두 1ms가 서로 상쇄됩니다. 결과적으로 표처럼 "최대 - 허용치가 윈도 끝에 닿으면 닫힌다"로 생각해도 됩니다.

Tyler Akidau의 "Streaming 102"(2016)는 watermark를 이벤트 시간 영역에서 입력이 얼마나 다 왔는지에 대한 시간 개념으로 설명하고 두 종류로 나눕니다.

| 종류 | 설명 |
|---|---|
| 완벽한 watermark | 입력을 완전히 알 때만 만들 수 있다. 예: 파티션 안에서 타임스탬프가 항상 오름차순 |
| 추정(heuristic) watermark | 분산된 입력 대부분은 완전히 알 수 없어서 추정한다. 추정이 틀리면 늦은 데이터가 생긴다 |

Dataflow 논문(VLDB 2015)은 watermark의 한계를 둘로 정리합니다. 너무 빠르면 watermark 뒤에 늦은 데이터가 도착하고 너무 느리면 느린 데이터 하나가 전체 파이프라인의 watermark를 붙잡습니다. 이 글의 3절이 첫 번째, 4절이 두 번째입니다.

### 2-3. Flink에서 watermark를 만드는 방법

| 전략 | 동작 |
|---|---|
| `forBoundedOutOfOrderness(d)` | 지금까지 본 가장 늦은 이벤트 시간보다 d만큼 뒤에 watermark를 둔다 |
| `forMonotonousTimestamps()` | 타임스탬프가 항상 오름차순이라 현재 타임스탬프를 바로 watermark로 쓴다 |
| `withIdleness(d)` | d 동안 이벤트가 없는 입력을 idle로 표시해 watermark 계산에서 뺀다(4절) |

코드로 쓰면 이렇습니다. 주문 이벤트의 `createdAt`(주문이 생긴 시각, 밀리초)을 이벤트 시간으로 쓰는 예입니다.

```java
WatermarkStrategy<Order> strategy = WatermarkStrategy
    .<Order>forBoundedOutOfOrderness(Duration.ofSeconds(2))   // ① 허용치 2초
    .withTimestampAssigner((order, recordTs) -> order.createdAt) // ② 이벤트 시간을 어디서 읽나
    .withIdleness(Duration.ofSeconds(5));                     // ③ 5초 조용한 입력은 계산에서 뺀다

env.fromSource(kafkaSource, strategy, "orders");              // ④ 소스에 붙인다
```

- ①은 2-2절 표의 "최대 - 2"를 만드는 줄입니다.
- ②를 빼면 Kafka 소스는 Kafka 레코드의 타임스탬프(보통 발행 시각)를 이벤트 시간으로 씁니다. 5-2절 컬리 사례가 이 줄을 빠뜨려서 생긴 일입니다. `recordTs`가 그 Kafka 타임스탬프이고 여기서는 쓰지 않습니다.
- ③은 4절에서 다룹니다.
- ④처럼 소스에 바로 붙이면 Kafka 파티션마다 watermark를 따로 만듭니다.

watermark는 주기적으로 내보내고 간격은 `pipeline.auto-watermark-interval`(기본 200ms)입니다. Kafka 소스는 기본으로 Kafka 레코드의 타임스탬프를 이벤트 시간으로 쓰고 파티션마다 watermark를 따로 만든 뒤 합칩니다. 여러 파티션을 한 스트림으로 섞은 뒤에 watermark를 만들면 파티션별 순서가 섞여 사라지기 때문입니다.

이 마지막 문장은 예를 들어야 이해가 됩니다. 파티션 0은 지금 10:00:05 근처를 읽고 있고 파티션 1은 조금 밀려서 10:00:01 근처를 읽고 있다고 해 봅시다. 각 파티션 안에서는 시각이 거의 순서대로입니다. 두 파티션을 한 줄로 섞으면 10:00:05, 10:00:01, 10:00:06, 10:00:02처럼 4초씩 오락가락하는 스트림이 됩니다. 여기에 허용치 2초짜리 watermark를 걸면 파티션 1의 이벤트가 줄줄이 늦은 것으로 처리됩니다. 파티션마다 따로 watermark를 만들고 둘 중 작은 값(4-1절)을 쓰면 이런 일이 없습니다.

## 3. 재현: 허용치가 정하는 것

### 3-1. 조건

- 이벤트 시간 0~600초에 이벤트 6,000개(초당 10개)가 생깁니다.
- 각 이벤트는 평균 0.3초 늦게 도착하고(지수분포), 2%는 3~8초 늦게 도착합니다(시드 고정). 지수분포는 대부분이 아주 조금 늦고 드물게 길게 늦는 모양입니다. 평균이 0.3초면 절반 가까이(약 49%)가 0.2초 안에 오고 1초를 넘는 것은 4%가 안 됩니다. 여기에 3~8초짜리 2%를 따로 얹어 "가끔 크게 늦는 이벤트"를 흉내 냈습니다.
- 10초짜리 텀블링 윈도로 셉니다. 텀블링 윈도는 0~10초, 10~20초처럼 겹치지 않게 자른 구간입니다(Ch-16). watermark는 "지금까지 본 가장 늦은 이벤트 시간 - 허용치"입니다.
- watermark가 윈도 끝을 넘으면 결과를 내고 그 뒤에 도착한 그 윈도의 이벤트는 버립니다(Flink 기본 동작).
- 코드는 [labs/de-study/ch15](https://github.com/dj258255/IT-Oasis/tree/main/labs/de-study/ch15)의 `watermark.py`입니다.

### 3-2. 결과

| 허용치 | 버려진 늦은 이벤트 | 결과가 나오기까지(윈도 끝부터, 평균) |
|---|---|---|
| 0초 | 139개(2.32%) | 0.20초 |
| 0.5초 | 75개(1.25%) | 0.66초 |
| 1초 | 46개(0.77%) | 1.16초 |
| 2초 | 27개(0.45%) | 2.19초 |
| 5초 | 6개(0.10%) | 5.16초 |
| 10초 | 0개(0.00%) | 10.21초 |

허용치를 올리면 버리는 이벤트가 줄고 결과가 늦어집니다. 결과 지연은 거의 허용치만큼 늘어납니다. 허용치 0초에서 2%보다 많이(2.32%) 버린 이유는 평균 0.3초짜리 작은 지연에서도 순서가 뒤바뀌기 때문입니다. 바로 다음 이벤트가 먼저 도착해 watermark를 올려 버리면 조금 늦은 이벤트도 늦은 것이 됩니다. 2-2절 표의 5번 이벤트가 바로 이 경우입니다.

표의 숫자를 읽는 법도 짚어 두겠습니다. "결과가 나오기까지"는 윈도 끝(예: 10초)부터 그 윈도의 결과가 나온 순간까지의 시간입니다. 허용치가 0인데도 0.2초가 걸린 것은 watermark가 이벤트가 도착해야만 움직이기 때문입니다. 윈도 끝을 넘긴 첫 이벤트(이벤트 시간 10.0초 이후)가 생기고 그 이벤트가 0.3초 안팎 늦게 도착해야 watermark가 10을 넘습니다. 허용치가 d면 이벤트 시간 10 + d짜리 이벤트를 기다려야 하니 지연이 대략 d + 0.2초가 됩니다.

어디에 둘지는 답이 정해져 있지 않습니다. "늦게 온 0.5%는 버려도 되고 결과는 1초 안에 필요하다"처럼 업무 요구로 정합니다. 데이터의 지연 분포를 먼저 재 봐야 손잡이를 어디에 둘지 정할 수 있습니다.

### 3-3. 늦은 데이터를 받는 방법

Flink Windows 문서 기준입니다.

| 방법 | 동작 |
|---|---|
| 기본 | watermark가 윈도 끝을 지나면 늦은 이벤트를 버린다. allowed lateness 기본값 0 |
| `allowedLateness(d)` | 윈도 끝 + d 전에 온 이벤트는 윈도에 더하고 결과를 다시 낸다(late firing). 같은 계산의 결과가 여러 번 나오므로 받는 쪽이 덮어쓰거나 중복을 처리해야 한다. 윈도 상태를 d만큼 더 들고 있는다 |
| `sideOutputLateData(tag)` | 버려지는 이벤트를 별도 스트림으로 받는다 |

`allowedLateness`는 허용치를 키우지 않고 늦은 데이터를 받는 방법입니다. 결과는 빨리(허용치 기준으로) 한 번 내고 늦은 데이터가 오면 고친 결과를 다시 냅니다. Akidau가 말한 "결과를 정정하는 방식"(누적 모드)의 하나입니다.

허용치와 allowed lateness는 둘 다 "늦은 것을 기다린다"처럼 들려서 헷갈립니다. 2-2절 표에 allowed lateness 5초를 더하면 차이가 보입니다.

| 시점 | 허용치 2초만 | 허용치 2초 + allowed lateness 5초 |
|---|---|---|
| watermark 10(4번 이벤트 도착) | [0, 10) 결과 3건을 냄 | [0, 10) 결과 3건을 냄 |
| 9초짜리 이벤트 도착(5번) | 버림 | 윈도에 더하고 결과 4건을 다시 냄 |
| watermark 15 | 이미 지워짐 | 윈도 상태를 지움. 이후 [0, 10) 이벤트는 버림 |

허용치는 첫 결과 자체를 늦추고 allowed lateness는 첫 결과는 그대로 두고 정정본을 덧붙입니다. 대시보드처럼 같은 칸을 덮어쓰면 되는 곳에는 allowed lateness가 잘 맞고 한 번 나간 결과를 되돌릴 수 없는 곳(예: 알림 발송)에는 허용치를 키우는 쪽이 맞습니다.

Factor House의 Flink 문제 해결 글(2026)은 side output 태그만 걸어 두고 그 스트림을 아무도 소비하지 않으면 버려진 레코드 수는 0으로 보고되면서 늦은 이벤트가 사라진다고 경고합니다. 진단에는 `currentInputWatermark`와 `numLateRecordsDropped` 지표를 봅니다.

## 4. 조용한 파티션이 전체를 붙잡는다

### 4-1. 최솟값 규칙

Flink 문서는 여러 입력을 받는 연산자의 현재 이벤트 시간을 입력 스트림들의 이벤트 시간 중 최솟값으로 정합니다. 그래서 입력 하나가 멈추면 연산자의 watermark도 멈춥니다.

왜 최솟값을 쓰는지는 큰 쪽을 따른다고 가정해 보면 보입니다. 파티션 A는 10:05까지 왔다고 하고 파티션 B는 10:01까지만 왔다고 합시다. 연산자가 큰 쪽인 10:05를 따르면 [10:01, 10:02) 윈도부터 닫아 버리는데 B에는 아직 10:01대 이벤트가 줄줄이 남아 있습니다. 그 이벤트가 전부 늦은 것이 됩니다. 작은 쪽을 따라야 "모든 입력에서 이 시각까지는 다 왔다"가 성립합니다. 대신 가장 느린 입력에 전체가 묶입니다.

![두 파티션의 watermark를 처리 시간에 따라 그린 그래프. 파티션 A의 선은 계속 올라가고 파티션 B의 선은 30초에서 멈춘다. idleness가 없으면 연산자 watermark가 B를 따라 29초에서 멈추고 idleness 5초를 주면 35초부터 A를 따라 다시 올라간다](/uploads/data/de-15-flink-time-watermark/idle-min.svg)

### 4-2. 재현

파티션 A는 0~120초 내내 이벤트가 오고 파티션 B는 30초 이후 아무것도 오지 않습니다. 허용치 1초, 10초 윈도입니다(`idle_source.py`).

| 설정 | 120초 동안 결과를 낸 윈도 |
|---|---|
| idleness 없음 | 2개(0~10초, 10~20초) |
| idleness 5초 | 11개(0~110초) |

B의 watermark는 29초에 멈춥니다. 최솟값 규칙 때문에 전체 watermark도 29초에 멈추고 20~30초 윈도부터는 영원히 닫히지 않습니다. A에는 이벤트가 계속 들어오는데 결과가 안 나오는 상태입니다. idleness를 주면 5초 동안 조용한 B를 계산에서 빼서 A의 watermark로 진행합니다.

### 4-3. 실제로 생기는 곳

- Kafka 파티션 일부에만 데이터가 들어오는 경우. 키가 몇 개 안 되거나 특정 시간대에 일부 파티션이 비는 경우입니다.
- 소스 병렬도가 파티션 수보다 많은 경우. Flink Kafka 문서는 병렬도가 파티션 수보다 크면 Kafka 소스가 자동으로 idle이 되지 않으니 병렬도를 줄이거나 idle timeout을 주라고 적습니다. 파티션을 하나도 받지 못한 소스 서브태스크는 watermark를 영원히 올리지 않습니다.

Confluent의 2025년 글 "Why Is My Apache Flink Job Not Producing Results?"는 Kafka 입력은 흐르는데 출력이 비어 있는 원인으로 watermark 전략이 없는 경우(DataStream에서 기본은 영원히 기다림), 타임스탬프 필드를 잘못 고른 경우, 허용치를 24시간처럼 크게 잡은 경우, 다시 활성화되지 않는 idle 파티션, 이벤트가 끊긴 스트림을 꼽습니다. 마지막 경우는 이벤트가 끊기면 watermark를 올릴 다음 이벤트가 없어서 마지막 윈도가 닫히지 않는다는 뜻입니다.

AWS Managed Flink 문서도 같은 점을 짚습니다. `withIdleness`는 새 watermark를 만들지 않고 idle 입력을 최솟값 계산에서 빼기만 합니다. 모든 입력에서 이벤트가 끊기면 마지막 윈도는 여전히 닫히지 않습니다.

idleness에도 대가가 있습니다. FLIP-180은 idle로 표시했던 입력이 다시 데이터를 보내면 idleness가 없었다면 늦지 않았을 레코드가 늦은 것으로 처리될 위험이 있다고 적습니다. 그동안 다른 입력의 watermark로 시간이 앞으로 가 버렸기 때문입니다.

### 4-4. 반대 문제: 빠른 입력

입력 하나가 다른 입력보다 훨씬 앞서 나가면 하류 연산자는 느린 입력을 기다리는 동안 빠른 입력의 데이터를 쌓아 둬야 합니다. Flink 문서는 이것이 연산자 상태의 통제할 수 없는 증가로 이어질 수 있다고 적고 watermark alignment(`withWatermarkAlignment(그룹, 최대 차이, 갱신 주기)`)로 앞선 입력을 잠시 멈추게 합니다. 2-1절에서 Dataflow 논문이 말한 "너무 느림"의 반대편입니다.

## 5. 중국과 국내 빅테크 사례

### 5-1. 快手: watermark로 발화하고 늦은 데이터는 상태에 남긴다

快手의 2021년 발표 정리 "快手基于 Flink 构建实时数仓场景化实践"은 일 단위 지표를 실시간으로 보여 주는 방식을 바꾼 경험을 적었습니다. 예전에는 일 단위 윈도에서 1분마다 미리 결과를 내는(early fire) 방식이었는데 과거 데이터를 다시 처리하면 그래프의 점이 빠지는 문제가 있었습니다. 처리 시간 기준으로 발화해서 다시 돌릴 때 같은 결과가 나오지 않은 것입니다. 일 단위 윈도 안에 분 단위 작은 윈도를 두고 watermark가 그 윈도의 이벤트 시간을 넘을 때 발화하도록 바꿨고 늦은 데이터는 버리지 않고 상태에 남겼습니다. 1절에서 말한 "이벤트 시간이어야 다시 돌려도 같은 결과"의 실제 판입니다.

같은 글은 잡을 재시작할 때마다 최소 2분 정도의 지연이 생기고 핵심 리포트의 SLA인 5분 안에 장애 복구 시간까지 들어간다고 적었습니다.

### 5-2. 컬리: 이벤트 시간을 잘못 고른 것과 조용한 파티션

컬리의 2025년 글 "Kafka Streams 윈도우 도입기"는 Flink 대신 Kafka Streams를 썼지만 이 글과 같은 두 문제를 겪었습니다.

- 23:59에 생긴 데이터가 00:00에 발행되자 다음 날 윈도에 들어가 정산이 틀렸습니다. Kafka 레코드 시각(발행 시각)을 이벤트 시간으로 쓰고 있었기 때문입니다. 이벤트 시간을 데이터의 `createdAt`으로 바꿔 해결했습니다. 2-3절에서 본 "Kafka 소스는 기본으로 레코드 타임스탬프를 쓴다"를 그대로 두면 생기는 일입니다.
- 이벤트가 끊기면 스트림 시간이 멈춰 윈도가 닫히지 않았습니다. 내부에서 더미 레코드를 흘리는 방법은 효과가 없었고 윈도 저장소를 직접 훑어 발행하면 중복이 생겼습니다. 결국 3분마다 파티션마다 외부 더미 이벤트를 넣는 스케줄러로 풀었습니다. 4-3절의 "이벤트가 끊긴 스트림"을 idleness 설정이 없는 엔진에서 푼 방법입니다.

## 6. 범위와 한계

- 3절과 4절은 시뮬레이션입니다. 실제 Flink 잡을 돌리지 않았습니다. 지연 분포를 일부러 골랐으므로 표의 비율은 이 분포에서만 의미가 있습니다.
- 시뮬레이션의 watermark는 이벤트마다 갱신했습니다. 실제 Flink는 200ms마다 내보내므로 결과 지연이 조금 더 늘어납니다.
- 국내 기술블로그에서 watermark나 idle 파티션 경험담은 찾지 못했습니다.

## 7. 헷갈렸던 것

**Q. 처리 시간으로 세면 watermark 걱정이 없지 않나요?**

결과를 기다리지 않고 바로 낼 수 있어서 지연은 가장 짧습니다. 대신 결과가 데이터가 도착한 사정에 따라 달라지고 같은 데이터를 다시 처리하면 다른 결과가 나옵니다. 백필이나 장애 뒤 재처리가 있는 파이프라인이라면 이벤트 시간이 맞습니다.

**Q. 허용치를 아주 크게 잡으면 안전하지 않나요?**

버리는 데이터는 줄지만 결과가 그만큼 늦고 그동안 윈도 상태를 들고 있어야 합니다. Confluent 글이 허용치를 24시간으로 잡아 결과가 안 나오는 경우를 원인 중 하나로 꼽은 것도 그래서입니다. 결과를 빨리 내고 늦은 데이터로 정정하는 `allowedLateness`가 대안입니다.

**Q. watermark가 멈췄는지는 어떻게 아나요?**

연산자의 `currentInputWatermark` 지표가 앞으로 가지 않으면 멈춘 것입니다. 입력 중 어느 파티션이 비어 있는지, 소스 병렬도가 파티션 수보다 많은지부터 확인합니다.

## 참고 자료

공식 문서
- Apache Flink 2.3, [Timely Stream Processing](https://nightlies.apache.org/flink/flink-docs-stable/docs/concepts/time/)
- Apache Flink 2.3, [Generating Watermarks](https://nightlies.apache.org/flink/flink-docs-stable/docs/dev/datastream/event-time/generating_watermarks/), [Builtin Watermark Generators](https://nightlies.apache.org/flink/flink-docs-stable/docs/dev/datastream/event-time/built_in/)
- Apache Flink 2.3, [Windows](https://nightlies.apache.org/flink/flink-docs-stable/docs/dev/datastream/operators/windows/), [Kafka connector](https://nightlies.apache.org/flink/flink-docs-stable/docs/connectors/datastream/kafka/), [Configuration](https://nightlies.apache.org/flink/flink-docs-stable/docs/deployment/config/)
- Apache Flink 소스 코드, [BoundedOutOfOrdernessWatermarks.java](https://github.com/apache/flink/blob/master/flink-core/src/main/java/org/apache/flink/api/common/eventtime/BoundedOutOfOrdernessWatermarks.java)(watermark = 최대 - 허용치 - 1ms), [EventTimeTrigger.java](https://github.com/apache/flink/blob/master/flink-runtime/src/main/java/org/apache/flink/streaming/api/windowing/triggers/EventTimeTrigger.java)(윈도 최대 타임스탬프 ≤ watermark면 발화)
- [FLIP-180: Adjust StreamStatus and Idleness definition](https://cwiki.apache.org/confluence/display/FLINK/FLIP-180:+Adjust+StreamStatus+and+Idleness+definition)
- AWS, [Maintain best practices for Managed Service for Apache Flink applications](https://docs.aws.amazon.com/managed-flink/latest/java/best-practices.html)

이론과 사례
- Tyler Akidau, [Streaming 101: The world beyond batch](https://www.oreilly.com/radar/the-world-beyond-batch-streaming-101/), 2015
- Tyler Akidau, [Streaming 102: The world beyond batch](https://www.oreilly.com/radar/the-world-beyond-batch-streaming-102/), 2016
- Tyler Akidau 외, [The Dataflow Model](https://www.vldb.org/pvldb/vol8/p1792-Akidau.pdf), PVLDB 8, 2015
- Ververica, [Watermarks in Apache Flink Made Easy](https://ververica.com/blog/watermarks-in-apache-flink-made-easy)(뒤섞인 이벤트를 정렬하는 예로 watermark가 왜 필요한지 설명)
- GeekNews, [실시간 데이터의 '마감 시간' 정하기: 스트림 처리와 워터마크 전략](https://news.hada.io/topic?id=25297)(탑승구 마감 비유)
- Wade Waldron, [Why Is My Apache Flink® Job Not Producing Results?](https://www.confluent.io/blog/why-is-flink-not-producing-results/), Confluent, 2025
- Chad Harris, [How to fix Flink windows that never fire or drop late events](https://factorhouse.io/resources/flink/troubleshooting/flink-watermarks-late-data/), Factor House, 2026
- 실습 코드: [labs/de-study/ch15](https://github.com/dj258255/IT-Oasis/tree/main/labs/de-study/ch15)

중국과 국내 빅테크 사례
- 李天朔(快手), [快手基于 Flink 构建实时数仓场景化实践](https://developer.aliyun.com/article/787654), 2021
- 박지환, [Kafka Streams 윈도우 도입기](https://helloworld.kurly.com/blog/2025-kafka-streams-window/), 컬리, 2025

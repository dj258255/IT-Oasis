---
title: '[DE] 측정의 함정: 부하 도구가 느린 순간을 지우는 coordinated omission'
description: 서버가 1초 멈췄는데 부하 도구가 p99를 1ms로 기록할 수 있습니다. 응답을 받아야 다음 요청을 보내는 도구는 서버가 멈춘 동안 요청을 보내지 않아서 가장 나쁜 순간의 표본이 빠집니다. 이 coordinated omission을 시뮬레이션으로 재현하고 open loop 부하와 보정 방법을 비교합니다. 워밍업 구간을 다루는 방법과, 두 기계의 시계로 지연을 잴 때 생기는 오차도 정리합니다.
date: 2026-10-19T00:00:00.000Z
tags:
  - Data Engineering
  - Latency
  - Coordinated Omission
  - Load Testing
  - Benchmark
  - Clock
category: data/Foundations
topics:
  - pipeline
  - performance
draft: false
series: "DE 공부"
seriesOrder: 10
---

## 결론부터

1. 응답을 받아야 다음 요청을 보내는 부하 도구(closed loop)는 서버가 멈춘 동안 요청을 보내지 않습니다. 멈춘 시간에 쌓였어야 할 느린 표본이 빠져서 결과가 실제보다 좋게 나옵니다. Gil Tene는 이를 coordinated omission이라고 불렀습니다.
2. 시뮬레이션에서 1ms짜리 서버가 1초 멈췄을 때 closed loop 도구는 p99를 1.0ms로 기록했습니다. 정해진 시각마다 보내고 그 시각부터 재는 open loop 방식은 p99를 920.0ms로 기록했습니다.
3. open loop로 부하를 걸거나(wrk2, k6의 arrival-rate executor), 기록할 때 빠진 표본을 채우는 보정(HdrHistogram의 `recordValueWithExpectedInterval`)을 씁니다.
4. JIT, 클래스 로딩, 캐시 때문에 시작 직후는 느립니다. 워밍업 구간을 측정에서 빼되 뺐다는 사실과 그 길이를 적습니다. 운영에서는 그 구간이 실제 사용자에게 닿기도 해서 따로 봐야 합니다.
5. 보낸 시각과 받은 시각을 서로 다른 기계에서 찍으면 두 시계의 차이가 그대로 지연에 섞입니다. NTP는 인터넷에서 보통 5~100ms 오차를 냅니다. 가능하면 같은 프로세스에서 단조 시계로 잽니다.

---

## 1. 측정 도구도 시스템의 일부다

9편에서 평균 대신 백분위와 최댓값을 보자고 했습니다. 그런데 백분위를 계산할 원본 표본이 처음부터 잘못 모였다면 어떤 통계도 소용없습니다. Gil Tene의 발표 교훈 중 하나가 "측정 방법이 무엇이든 그 방법부터 시험하라"였습니다. 일부러 멈추는 시스템에 측정 도구를 돌려서 멈춘 만큼의 지연이 결과에 나오는지 보라는 뜻입니다.

이 글 전체가 기대는 구분이 하나 있어서 먼저 짚고 가겠습니다. 요청이 들어오는 방식은 크게 둘입니다.

| | closed loop(닫힌 방식) | open loop(열린 방식) |
|---|---|---|
| 쇼핑몰에 빗대면 | 점원 10명이 각자 계산이 끝나야 다음 손님을 부른다 | 매장 문으로 1분에 손님 6명씩 계속 들어온다 |
| 계산대가 1분 멈추면 | 아무도 다음 손님을 부르지 않으니 새 손님이 생기지 않는다 | 손님은 계속 들어와 줄이 길어진다 |
| 시스템 예 | 큐에서 메시지를 하나씩 꺼내 처리하는 워커 | 많은 사용자가 각자 요청을 보내는 웹 서버 |

Artillery 블로그의 [Understanding workload models](https://artillery.io/blog/load-testing-workload-models)(Hassy Veldstra, 2023)가 이 두 모델을 같은 예(큐 워커와 웹 서버)로 나눕니다. 실제 웹 서비스는 대부분 열린 쪽입니다. 사용자는 서버가 바쁜지 모르고 버튼을 누릅니다. 그런데 많은 부하 도구는 닫힌 쪽으로 동작합니다. 응답을 받아야 다음 요청을 보내는 코드가 가장 짜기 쉽기 때문입니다. 이 어긋남에서 문제가 생깁니다.

## 2. coordinated omission

### 2-1. 발표의 예

발표 자료의 예시는 이렇습니다. 초당 100건을 각 1ms에 처리하던 시스템이 100초 동안 멈춥니다.

| | 실제로 사용자가 겪는 것 | 흔한 부하 도구가 기록하는 것 |
|---|---|---|
| p50 | 1ms | 1ms |
| p75 | 약 50초 | 1ms |
| p99.99 | 약 100초 | 1ms |
| 평균 | 약 25초 | 10.9ms |

흔한 도구는 1ms짜리 1만 건과 100초짜리 1건을 기록합니다. 멈춘 100초 동안 보냈어야 할 요청 1만 건이 통째로 빠졌습니다. 도구가 서버의 느림에 맞춰 스스로 요청을 늦춘 셈이라 "조정된(coordinated) 누락(omission)"입니다.

왼쪽 열의 숫자는 이렇게 나옵니다. 발표의 예는 정상 100초와 멈춘 100초가 이어지는 상황입니다.

1. 정상 100초 동안 초당 100건씩 1만 건이 1ms에 끝납니다.
2. 멈춘 100초 동안에도 사용자는 초당 100건씩 1만 건을 보냅니다. 멈춤이 시작될 때 보낸 요청은 100초를, 끝나기 직전에 보낸 요청은 거의 0초를 기다립니다. 이 1만 건의 대기 시간은 0초에서 100초 사이에 고르게 퍼집니다.
3. 전체 2만 건을 줄 세우면 앞쪽 절반이 1ms, 뒤쪽 절반이 0~100초입니다. p75는 뒤쪽 절반의 한가운데라 약 50초, p99.99는 거의 맨 끝이라 약 100초입니다.
4. 평균은 절반이 거의 0이고 절반이 평균 50초이니 약 25초입니다.

오른쪽 열의 평균은 (1ms × 1만 건 + 100,000ms × 1건) ÷ 10,001건입니다. 직접 계산하면 약 11.0ms(10.999ms)이고 발표 자료는 10.9ms로 적었습니다. 100초짜리 하나가 평균을 조금 올렸을 뿐이고 백분위에는 전혀 나타나지 않습니다.

### 2-2. 재현

같은 구조를 작게 만들었습니다([labs/de-study/ch09](https://github.com/dj258255/IT-Oasis/tree/main/labs/de-study/ch09)의 `coordinated_omission.py`).

- 서버는 요청 하나를 1ms에 처리하고 5.0초부터 6.0초까지 1초 동안 멈춥니다.
- 목표 부하는 10ms마다 1건(초당 100건)을 10초 동안입니다.
- 시뮬레이션이라 결과가 항상 같습니다.

| 부하 방식 | 기록 건수 | p50 | p99 | p99.9 | max |
|---|---|---|---|---|---|
| closed loop: 응답을 받아야 다음 요청, 밀린 요청은 건너뜀 | 902 | 1.0 | 1.0 | 991.0 | 991.0 |
| closed loop + 보정 | 1001 | 1.0 | 891.0 | 981.0 | 991.0 |
| open loop: 10ms마다 보내고 보내기로 한 시각부터 잼 | 1000 | 1.0 | 920.0 | 1001.0 | 1001.0 |

(단위 ms)

![서버가 5.0초부터 6.0초까지 멈춘 구간을 빨간 영역으로 칠한 타임라인 두 줄. 위 closed loop 줄은 멈춤 직후 5.01초에 나간 요청 1건이 991ms 화살표로 이어지고 멈춘 동안의 자리에는 보내지 않은 요청을 뜻하는 ×표가 찍혀 기록 902건, p99 1.0ms다. 아래 open loop 줄은 멈춘 동안 보낸 요청들이 1001ms, 821ms, 641ms처럼 남은 멈춤 시간에 앞 요청들의 처리 시간까지 더해 기다리는 화살표로 그려져 기록 1000건, p99 920ms다](/uploads/data/de-09-measurement-pitfalls/de09-closed-vs-open.svg)

closed loop는 1,000건을 보내야 했는데 902건만 기록했습니다. 스크립트의 closed loop는 응답이 다음 예정 시각보다 늦게 오면 그 사이에 보냈어야 할 요청을 건너뛰고 응답을 받은 시각부터 다시 10ms 간격을 셉니다. 그래서 멈춘 1초 동안 보냈어야 할 98건이 빠졌고 기록된 느린 표본은 멈춤이 막 시작된 5.01초에 나가 6.0초까지 기다린 1건뿐입니다. 902건 중 느린 표본이 1건이면 상위 1%(9건)에도 들지 못하니 p99는 1ms입니다. p99.9는 상위 0.9건이라 사실상 최댓값과 같은 991ms가 나왔습니다. 최댓값을 함께 보지 않았다면 이 정지를 알아챌 방법이 없습니다. 9편에서 최댓값을 항상 보자고 한 이유가 여기 있습니다.

open loop는 멈춘 동안에도 10ms마다 요청을 "보낸" 것으로 치고 그 요청들이 줄을 서서 1,001ms, 992ms, 983ms ... 를 기다린 것으로 기록합니다. 10ms씩 늦게 보냈으니 10ms씩 덜 기다릴 것 같지만 서버가 풀린 뒤 앞 요청들을 1ms씩 차례로 처리하느라 9ms씩만 줄어듭니다. 사용자가 실제로 겪는 것과 같습니다. 정해진 간격으로 들어오는 사용자들은 서버가 멈췄다고 요청을 미루지 않기 때문입니다. 1,000건 중 2ms를 넘긴 느린 표본이 112건(약 11%)이니 p99는 그 느린 무리 안쪽인 920ms에 떨어집니다.

### 2-3. 보정

closed loop로 잴 수밖에 없다면 기록할 때 빠진 표본을 채웁니다. HdrHistogram의 `recordValueWithExpectedInterval(value, expectedInterval)`은 기록한 값이 기대 간격보다 크면 그 값에서 기대 간격씩 줄어드는 값들을 자동으로 더 기록합니다. 991ms를 기대 간격 10ms로 기록하면 981, 971, ... 11ms가 함께 기록됩니다. 뜻을 풀면 이렇습니다. "이 요청이 991ms 걸렸다면 그 10ms 뒤에 보냈어야 할 요청은 981ms를 기다렸을 것이고 20ms 뒤의 요청은 971ms를 기다렸을 것이다." 도구가 건너뛴 요청들을 그 가정으로 되살려 넣는 것입니다.

표의 "closed loop + 보정" 줄이 이 방식입니다. 실습 스크립트는 남은 값이 0보다 큰 동안 계속 채워서 마지막에 1ms 하나를 더 넣었고 그래서 기록이 1,001건입니다. [HdrHistogram 구현](https://github.com/HdrHistogram/HdrHistogram/blob/master/src/main/java/org/HdrHistogram/AbstractHistogram.java)은 남은 값이 기대 간격 이상일 때까지만 채우므로 같은 입력이면 1,000건이 됩니다. 빠지는 것이 1ms 표본 하나라 결론은 달라지지 않습니다. 기록이 끝난 뒤 보정한 사본을 만드는 `copyCorrectedForCoordinatedOmission`도 있습니다.

HdrHistogram README의 예시도 같은 결론입니다. 100초 정지 동안 표본이 하나만 기록되면 보정 전에는 결과의 약 99.99%가 1ms 이하이고 기대 간격 10ms로 보정하면 약 50%만 1ms 이하입니다.

## 3. open loop와 closed loop

| | closed loop | open loop |
|---|---|---|
| 다음 요청 | 앞 응답을 받은 뒤 | 정해진 시각에, 응답과 상관없이 |
| 서버가 느려지면 | 부하도 함께 줄어든다 | 부하는 그대로, 대기열이 쌓인다 |
| 측정 시작점 | 실제로 보낸 시각 | 보내기로 한 시각 |
| 맞는 질문 | 사용자 수가 정해진 시스템(동시 사용자 N명) | 도착률이 정해진 시스템(초당 N건) |
| 도구 | 많은 기본 부하 도구, k6의 VU 기반 executor | wrk2(`-R`), k6의 constant-arrival-rate, ramping-arrival-rate executor |

k6 문서는 closed 모델에서 VU의 반복이 앞 반복이 끝나야 시작하므로 대상 시스템의 응답 시간이 테스트의 처리량에 영향을 준다고 적고 이 문제를 일부 문헌에서는 coordinated omission이라 부른다고 설명합니다.

wrk2는 wrk를 고쳐 일정한 처리량으로 부하를 걸고 요청을 보냈어야 할 시각부터 지연을 잽니다. README 예시(작성자 환경)에서 평상시 p99는 보정값 10.52ms와 미보정값 5.43ms로 두 배쯤 차이 났고 1.4초 정지를 넣으면 보정값 1.27초와 미보정값 6.04ms로 약 200배 차이 났습니다.

Marc Brooker의 2023년 글 [Open and Closed, Omission and Collapse](https://brooker.co.za/blog/2023/05/10/open-closed/)는 시뮬레이터로 차이의 크기를 보입니다. 요청의 99.9%는 0.1ms, 0.1%는 10ms 걸리는 서버를 클라이언트 하나가 닫힌 방식으로 두드리면 p99가 1ms 아래로 나오고 같은 서버에 열린 방식으로 요청이 들어오면 p99가 25ms를 넘었습니다. 글쓴이는 닫힌 방식 벤치마크가 p99를 적어도 25배 낮게 볼 수 있다고 정리합니다. 클라이언트 하나인 닫힌 방식에서는 느린 요청이 끝날 때까지 다음 요청이 없으니 줄이 생기지 않습니다. 열린 방식에서는 10ms짜리 요청 뒤에 도착한 요청들이 줄을 서서 함께 늦어집니다.

ScyllaDB의 2021년 글은 YCSB(단일 스레드, workload A)로 같은 차이를 보였습니다. 목표 처리량 없이 closed 모델로 돌리면 8,743 ops/s에 읽기 p99가 249μs였습니다. 목표 처리량을 주고 의도한 시작 시각 기준으로 재니 읽기 p99가 약 665ms였습니다. 글쓴이는 앞의 숫자를 거짓말이라고 적었습니다.

데이터 파이프라인에서는 13편에서 프로듀서 지연을 잴 때 이 구분이 다시 나옵니다. "초당 1만 건을 넣을 때의 지연"을 재고 싶다면 1만 건을 정해진 간격으로 보내야 합니다. 앞 메시지의 응답을 기다렸다 보내면 실제로는 초당 1만 건이 안 들어갔을 수 있습니다.

## 4. 워밍업

시작 직후의 프로세스는 느립니다. JVM이라면 클래스를 처음 불러오고 JIT 컴파일러가 자주 쓰이는 코드를 아직 최적화하지 않았고 캐시와 커넥션 풀이 비어 있습니다.

마이크로벤치마크 도구 JMH는 기본값으로 워밍업 5회(각 10초)를 돈 뒤 측정 5회(각 10초)를 하고 이를 별도 JVM 5개(fork)에서 반복합니다. 워밍업 구간의 결과는 측정에서 빠집니다.

워밍업을 빼는 것은 "안정된 상태의 성능"을 묻는 질문에 맞습니다. 그런데 운영에서는 그 구간이 실제 사용자에게 닿습니다. 카카오페이는 배포 직후 HikariCP 커넥션 사용 시간이 평소 3ms 이내에서 최대 1~1.5초로 늘고 풀 30개가 모두 사용 중이 되어 커넥션 획득이 타임아웃(10초)까지 가는 문제를 겪었습니다. 풀을 50개로 늘려도 같았고 원인은 클래스 지연 로딩이었습니다. 애플리케이션이 트래픽을 받기 전에 미리 요청을 돌리고(ApplicationRunner), 그동안 startupProbe로 트래픽을 막은 뒤에는 커넥션 사용 시간이 2ms 이내로 유지됐다고 정리했습니다.

| 질문 | 워밍업 구간 |
|---|---|
| 안정된 상태에서 얼마나 빠른지 | 빼고 잰다. 뺀 길이를 적는다 |
| 배포 직후 사용자가 무엇을 겪는지 | 그 구간만 따로 잰다 |

## 5. 시계가 다른 두 기계

### 5-1. 오차의 크기

지연을 "보낸 시각"과 "받은 시각"의 차이로 잴 때 두 시각을 서로 다른 기계에서 찍으면 두 시계의 차이가 지연에 그대로 더해지거나 빠집니다.

예를 들어 주문 서버가 10:00:00.000에 메시지를 보냈고 집계 서버가 10:00:00.003에 받았다고 찍었다면 지연은 3ms로 보입니다. 그런데 집계 서버 시계가 주문 서버보다 2ms 빠르게 가고 있었다면 실제 지연은 1ms이고 2ms 느리게 가고 있었다면 실제 지연은 5ms입니다. 시계 차이가 지연보다 크면 뺄셈 결과가 음수까지 나옵니다. 서로 다른 기계의 시계는 NTP(Network Time Protocol)로 시간 서버에 물어 맞추는데 이 맞춤에도 오차가 있습니다.

NTP FAQ는 인터넷에서의 일반적인 정확도를 5ms에서 100ms 정도로 적습니다. 조용한 같은 서브넷이면 1ms 이내라는 사례도 실려 있습니다. 측정하려는 지연이 수 ms라면 시계 오차가 측정값보다 클 수 있습니다. 받은 시각에서 보낸 시각을 뺐더니 음수가 나오는 경우가 이렇게 생깁니다.

### 5-2. 같은 시계로 재는 방법

| 방법 | 예 |
|---|---|
| 보내는 쪽과 받는 쪽을 같은 프로세스에 둔다 | Kafka의 `EndToEndLatency` 도구는 프로듀서와 컨슈머를 한 JVM에 띄우고 `System.nanoTime()`으로 보내기 전후를 잰다 |
| 같은 기계에서 잰다 | 측정용 생산자와 소비자를 같은 노드(같은 Pod)에 둔다 |
| 시계를 맞추는 단계를 둔다 | Confluent의 Kafka·Pulsar·RabbitMQ 비교 벤치마크는 RabbitMQ 측정을 위해 클라이언트 기계들의 시간을 맞추는 단계를 추가했다고 적는다 |

같은 기계 안에서도 시계를 골라야 합니다.

| 시계 | 특징 |
|---|---|
| 벽시계(`CLOCK_REALTIME`, Python `time.time()`) | NTP가 시간을 고치면 뒤로 갈 수도 있다. 두 호출 사이에 시계가 조정되면 더 작은 값이 나올 수 있다 |
| 단조 시계(`CLOCK_MONOTONIC`, Python `time.monotonic()`, `perf_counter()`) | 뒤로 가지 않는다. 기준점이 정해져 있지 않아 두 값의 차이만 의미가 있다 |

같은 프로세스 안의 구간 시간은 단조 시계로 잽니다. 기계 사이의 시각은 벽시계밖에 없으니 5-1절의 오차를 함께 적습니다.

Confluent의 2020년 글 "99th Percentile Latency at Scale with Apache Kafka"는 끝에서 끝까지 지연을 프로듀서의 `send()` 호출부터 컨슈머의 `poll()`이 그 레코드를 돌려줄 때까지로 정의하고 다섯 구간(produce, publish, commit, catch-up, fetch)으로 나눕니다. 13편에서 이 구간을 다시 씁니다.

## 6. 측정 전에 정할 것

| 정할 것 | 이 글에서 본 이유 |
|---|---|
| 부하 모델(open/closed) | closed면 서버가 느릴 때 표본이 빠진다(2절) |
| 목표 도착률 | open loop의 간격을 정한다 |
| 워밍업 길이와 처리 | 측정할지 뺄지 질문에 따라 다르다(4절) |
| 시각을 찍는 곳과 시계 | 기계가 다르면 시계 오차가 섞인다(5절) |
| 보고할 값 | p50, p95, p99, p99.9, max, 건수(9편) |
| 도구 시험 | 일부러 멈추는 서버에 먼저 돌려 본다(1절) |

## 7. 중국과 국내 빅테크 사례

중국과 국내 빅테크 글 중 coordinated omission이라는 말을 직접 쓴 글은 찾지 못했습니다. 같은 문제를 다른 말로 다룬 글은 있습니다.

- **Meituan**(2018) "全链路压测平台（Quake）在美团中的实践": 스레드 기반 부하는 요청-대기-응답 방식이라 스레드 수를 늘려도 QPS를 정확히 제어할 수 없어서 미리 정한 QPS에 맞춰 매초 정해진 수의 요청을 보내는 비동기 엔진으로 바꿨습니다. 3절의 closed loop에서 open loop로 옮긴 것입니다. 부하 생성기 쪽의 GC 지터가 대상 서비스의 실제 응답 시간을 부풀리고 실제 QPS를 흔든다고도 적었습니다. 1절의 "측정 도구도 시스템의 일부"입니다.
- **LINE**(2020) "서버 사이드 테스트 자동화 여정 - 4": JMeter를 빼고 Python 비동기 부하 생성기를 직접 만든 이유 중 하나가 스레드 수를 늘려 부하를 올리는 방식으로는 원하는 양의 트래픽을 만들기 어렵다는 판단이었습니다. 부하는 같은 IDC 안에서 만들고 캐시 계층을 끈 채 모듈 하나를 시험했습니다.
- **LINE**(2023) "Spring Boot + Kubernetes 기반에서 웜업 적용하기": 배포 직후 응답이 평균의 약 6배였습니다. 예시 로그에서 첫 호출은 104,052,250ns, 두 번째 호출은 12,458ns였습니다. 웜업이 끝날 때까지 readiness probe를 DOWN으로 두어 트래픽을 막았습니다. 4절의 카카오페이와 같은 해법입니다.

## 8. 범위와 한계

- 2-2절은 시뮬레이션입니다. 실제 부하 도구를 돌리지는 않았습니다. wrk2와 ScyllaDB의 수치는 각 글쓴이의 환경에서 잰 값입니다.
- JMH가 워밍업 결과를 왜 버리는지 설명한 공식 문장은 찾지 못해 기본값만 옮겼습니다.
- Confluent 2020년 글이 타임스탬프를 어디서 찍고 시계를 어떻게 맞췄는지는 글에서 확인하지 못했습니다.

## 9. 헷갈렸던 것

**Q. 동시 사용자 100명으로 테스트하면 closed loop인데, 그건 틀린 건가요?**

질문에 따라 맞습니다. 사용자가 정해져 있고 각자 앞 응답을 봐야 다음 행동을 하는 시스템이라면 closed loop가 현실과 같습니다. 문제는 결과를 "초당 N건일 때의 지연"으로 읽을 때입니다. 서버가 느려진 동안 실제 도착률이 줄었으니 그 숫자는 초당 N건의 지연이 아닙니다.

**Q. 보정하면 없던 표본을 지어내는 것 아닌가요?**

보정은 "그 시간에 보냈어야 할 요청이 있었고 그 요청들이 서버가 풀릴 때까지 기다렸을 것"이라는 가정으로 채웁니다. 도착률이 일정하다는 가정이 맞으면 open loop로 잰 것과 비슷해지고 표에서도 p99 891ms와 920ms로 가까웠습니다. 가정이 맞지 않는 시스템이면 보정값도 틀리니 가능하면 처음부터 open loop로 잽니다.

**Q. 최댓값은 한 번 튄 값이라 버려도 되지 않나요?**

2-2절의 closed loop 결과에서 정지를 알려 준 숫자는 최댓값 하나뿐이었습니다. 한 번 튄 값처럼 보여도 측정 도구가 나머지 느린 표본을 지웠을 수 있습니다. 최댓값이 이상하면 버리기 전에 그 시각에 무슨 일이 있었는지 봅니다.

## 참고 자료

- Gil Tene, [How NOT to Measure Latency](https://qconsf.com/sf2012/dl/qcon-sanfran-2012/slides/GilTene_HowNotToMeasureLatency.pdf), QCon San Francisco 2012
- [HdrHistogram README](https://github.com/HdrHistogram/HdrHistogram), [JavaDoc: recordValueWithExpectedInterval](https://hdrhistogram.github.io/HdrHistogram/JavaDoc/org/HdrHistogram/AbstractHistogram.html)
- [wrk2](https://github.com/giltene/wrk2)
- Grafana k6, [Open and closed models](https://grafana.com/docs/k6/latest/using-k6/scenarios/concepts/open-vs-closed/)
- ScyllaDB, [On Coordinated Omission](https://www.scylladb.com/2021/04/22/on-coordinated-omission/), 2021
- Hassy Veldstra, [Understanding workload models](https://artillery.io/blog/load-testing-workload-models), Artillery, 2023
- Marc Brooker, [Open and Closed, Omission and Collapse](https://brooker.co.za/blog/2023/05/10/open-closed/), 2023
- OpenJDK, [JMH](https://github.com/openjdk/jmh)
- 카카오페이, [배포 직후 발생하는 응답 지연을 해결하기 위한 여정 (feat. JVM 웜업)](https://tech.kakaopay.com/post/jvm-warm-up/)
- NTP, [FAQ: How does it work?](https://www.ntp.org/ntpfaq/ntp-s-algo/)
- [clock_gettime(2)](https://man7.org/linux/man-pages/man2/clock_gettime.2.html), Python [time](https://docs.python.org/3/library/time.html)
- Apache Kafka, [EndToEndLatency.java](https://github.com/apache/kafka/blob/trunk/tools/src/main/java/org/apache/kafka/tools/EndToEndLatency.java)
- Confluent, [99th Percentile Latency at Scale with Apache Kafka](https://www.confluent.io/blog/configure-kafka-to-minimize-latency/), 2020
- Confluent, [Benchmarking Apache Kafka, Apache Pulsar, and RabbitMQ](https://www.confluent.io/blog/kafka-fastest-messaging-system/)
- 실습 코드: [labs/de-study/ch09](https://github.com/dj258255/IT-Oasis/tree/main/labs/de-study/ch09)

중국과 국내 빅테크 사례
- 耿杰(Meituan), [全链路压测平台（Quake）在美团中的实践](https://tech.meituan.com/2018/09/27/quake-introduction.html), 2018
- 하태호, [서버 사이드 테스트 자동화 여정 - 4. 성능 테스트 자동화 목표 설정 및 테스트 환경 구성](https://engineering.linecorp.com/ko/blog/server-side-test-automation-4/), LINE, 2020
- 박원영, 박제희, [Spring Boot + Kubernetes 기반에서 웜업 적용하기](https://engineering.linecorp.com/ko/blog/apply-warm-up-in-spring-boot-and-kubernetes/), LINE, 2023

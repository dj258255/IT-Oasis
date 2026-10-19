---
title: '[DE Ch-12] 프로듀서 설정과 지연: linger.ms는 기다림을 사서 요청 수를 줄인다'
description: Kafka 프로듀서는 레코드를 배치로 모아 보냅니다. linger.ms만큼 더 기다리면 배치가 커지고 요청 수가 줄어 오히려 지연이 줄기도 합니다. Kafka 4.0에서 linger.ms 기본값이 0에서 5로 바뀐 이유와, acks, 멱등성, max.in.flight가 내구성과 순서를 어떻게 정하는지 공식 문서와 측정 글로 정리하고 메시지 유입량에 따라 linger가 의미를 갖는 구간을 단순 모델로 셉니다.
date: 2026-10-19T00:00:00.000Z
tags:
  - Data Engineering
  - Kafka
  - Producer
  - Latency
  - Batching
  - Idempotence
category: data/Streaming
topics:
  - pipeline
  - messaging
draft: false
series: "DE 공부"
seriesOrder: 12
---

## 결론부터

1. 프로듀서는 파티션마다 레코드를 배치로 모아 보냅니다. 배치는 `batch.size`(기본 16KB)가 차거나 `linger.ms`가 지나면 나갑니다. Kafka 4.0(KIP-1030)에서 `linger.ms` 기본값이 0에서 5로 바뀌었고 문서는 배치가 커지는 효과로 지연이 비슷하거나 오히려 낮아지는 경우가 많다고 적습니다.
2. linger가 의미를 갖는 구간은 유입량에 달렸습니다. 단순 모델에서 초당 1만 건은 배치가 linger 전에 차서 5ms와 20ms의 결과가 같았고 초당 100건은 20ms를 기다려도 요청당 2.9건밖에 모이지 않았습니다.
3. 3.0부터 `acks=all`과 `enable.idempotence=true`가 기본입니다. 멱등성은 브로커가 프로듀서 ID와 순번으로 재시도 중복을 걸러 주고 `max.in.flight.requests.per.connection`이 5 이하일 때 재시도해도 순서를 지킵니다.
4. 재시도는 횟수보다 시간으로 제한합니다. `retries` 기본값은 사실상 무한이고 `delivery.timeout.ms`(기본 2분)가 레코드 하나를 보내려고 시도하는 전체 시간을 정합니다.

---

## 1. send()가 돌아온 뒤 일어나는 일

Ch-09에서 Confluent의 2020년 글이 끝에서 끝까지 지연을 다섯 구간으로 나눴다고 했습니다.

| 구간 | 하는 일 |
|---|---|
| produce | 프로듀서가 레코드를 배치에 모으고 요청을 보내기까지 |
| publish | 리더 브로커가 받아 로그에 쓰기까지 |
| commit | 팔로워들이 복제해 커밋되기까지 |
| catch-up | 컨슈머가 뒤처져 있으면 따라잡기까지 |
| fetch | 컨슈머가 가져가기까지 |

이 글은 첫 구간을 다룹니다. `send()`를 부르면 레코드는 바로 네트워크로 나가지 않고 프로듀서 메모리(`buffer.memory`, 기본 32MB)의 파티션별 배치에 들어갑니다. 별도 스레드가 배치를 브로커별 요청으로 묶어 보냅니다.

## 2. 배치: batch.size와 linger.ms

### 2-1. 기본값과 4.0의 변화

| 설정 | 기본값(4.3) | 뜻 |
|---|---|---|
| `batch.size` | 16384 | 파티션 하나의 배치 크기 상한. 0이면 배치를 끈다. 버퍼를 이 크기로 미리 잡는다 |
| `linger.ms` | 5(4.0부터, 그 전에는 0) | 배치가 차지 않아도 이만큼 기다렸다 보낸다 |
| `compression.type` | none | 압축은 배치 단위라 배치가 클수록 압축이 잘 된다 |

KIP-1030은 linger 기본값을 5로 바꾸며 이렇게 설명합니다. 배치가 커져서 얻는 효율 때문에 linger가 늘어도 프로듀서 지연이 비슷하거나 더 낮은 경우가 많다. 그리고 주의를 하나 붙입니다. 브로커가 밀리면 실제로 기다리는 시간이 linger보다 길어질 수 있다. KIP 문서에 벤치마크 수치는 없습니다.

기다리면 왜 빨라질 수 있을까요. 요청 하나에는 네트워크 왕복, 브로커의 요청 처리, 복제 요청이 붙습니다. 레코드를 하나씩 보내면 같은 양의 데이터에 요청이 수십 배 많아지고 브로커가 요청을 처리하느라 바빠지면 모든 요청이 줄을 섭니다. 몇 ms 모아서 보내면 요청 수가 줄어 그 줄이 짧아집니다.

### 2-2. 측정된 근거

Confluent의 2020년 글(브로커 9대, 복제 3, 파티션 108개, `acks=all`, lz4, 값 512B)에서 프로듀서 90대가 합쳐서 초당 90MB를 보내는 조건으로 `linger.ms`를 0에서 5로 올렸습니다. 브로커가 받는 produce 요청이 2,800에서 1,100으로 줄었고 p50과 p99가 모두 좋아졌으며 p99 쪽이 훨씬 크게 좋아졌다고 적었습니다. 정확한 ms 값은 그래프로만 있어 옮기지 못했습니다.

같은 글에는 반대 방향의 결과도 있습니다. 같은 총량을 프로듀서 900대로 나눠 보내자 지연 중앙값이 60% 늘고 p99는 세 배가 됐으며 브로커 CPU가 거의 100%까지 올랐습니다. 프로듀서 하나가 보내는 양이 적으면 배치가 작아지고 요청 수가 늘어납니다. `batch.size`를 16KB에서 128KB로 늘려도 변화가 없었는데 프로듀서마다 보내는 양이 적어 16KB도 다 차지 않았기 때문입니다.

### 2-3. 재현: 유입량별로 linger가 하는 일

배치가 차는 조건과 linger 조건만 넣은 단순 모델로 셌습니다([labs/de-study/ch12](https://github.com/dj258255/IT-Oasis/tree/main/labs/de-study/ch12)의 `batching.py`).

- 1KB 레코드가 무작위 간격으로 10초 동안 들어옵니다(시드 고정).
- 배치는 16KB(레코드 16개)가 차면 바로, 아니면 첫 레코드 뒤 linger가 지나면 나갑니다.
- 실제 프로듀서는 앞 요청의 응답을 기다리는 동안에도 레코드를 모읍니다. 이 효과는 넣지 않았습니다. 그래서 linger 0의 "요청당 1건"은 실제보다 비관적입니다.

| 초당 레코드 | linger.ms | 초당 요청 | 요청당 레코드 | 평균 대기 | p99 대기 |
|---|---|---|---|---|---|
| 100 | 0 | 97 | 1.0 | 0.00ms | 0.00ms |
| 100 | 5 | 66 | 1.5 | 4.22ms | 5.00ms |
| 100 | 20 | 33 | 2.9 | 13.09ms | 20.00ms |
| 1,000 | 0 | 1,001 | 1.0 | 0.00ms | 0.00ms |
| 1,000 | 5 | 166 | 6.0 | 2.91ms | 5.00ms |
| 1,000 | 20 | 64 | 15.8 | 7.42ms | 19.49ms |
| 10,000 | 0 | 9,963 | 1.0 | 0.00ms | 0.00ms |
| 10,000 | 5 | 623 | 16.0 | 0.75ms | 2.11ms |
| 10,000 | 20 | 623 | 16.0 | 0.75ms | 2.11ms |

표는 세 구간으로 읽힙니다.

- 유입이 아주 적으면(초당 100건) linger만큼 고스란히 기다리고 얻는 배치는 작습니다. 요청 수를 줄여야 할 만큼 브로커가 바쁘지도 않습니다.
- 중간이면(초당 1,000건) linger가 요청 수를 크게 줄입니다. 5ms로 요청이 여섯 분의 일, 20ms로 열여섯 분의 일이 됩니다.
- 유입이 많으면(초당 1만 건) linger 전에 배치가 차서 linger 값이 결과를 바꾸지 않습니다. 이 구간에서 배치 크기를 키우려면 `batch.size`를 올려야 합니다.

이 모델에는 2-1절의 "요청이 줄어 브로커 줄이 짧아지는 효과"가 없습니다. 그래서 대기 시간은 linger가 늘수록 길게만 나옵니다. 브로커가 바쁜 구간에서 linger가 오히려 지연을 줄이는 현상은 2-2절의 실측이 보여 줍니다.

## 3. 내구성과 순서: acks, 멱등성, in-flight

### 3-1. 기본값과 그 이력

| 설정 | 기본값(4.3) | 뜻 |
|---|---|---|
| `acks` | all | ISR 전원이 받아야 성공(Ch-11의 5절) |
| `enable.idempotence` | true | 브로커가 프로듀서 ID와 순번으로 재시도 중복을 걸러 준다 |
| `max.in.flight.requests.per.connection` | 5 | 응답을 기다리는 요청을 연결당 몇 개까지 둘지 |
| `retries` | 2147483647 | 사실상 무한. 직접 조정하지 말고 `delivery.timeout.ms`로 제어하라고 문서가 권한다 |
| `delivery.timeout.ms` | 120000 | `send()` 뒤 성공이나 실패를 알리기까지의 상한. `request.timeout.ms + linger.ms` 이상이어야 한다 |
| `request.timeout.ms` | 30000 | 요청 하나의 응답을 기다리는 시간 |

`acks=all`과 멱등성 기본값은 3.0(KIP-679)에서 들어왔습니다. 다만 3.0.0과 3.1.0에서는 버그(KAFKA-13598)로 멱등성 기본값이 실제로 적용되지 않았고 3.0.1, 3.1.1, 3.2.0에서 고쳐졌습니다. 이 버전대를 쓴다면 멱등성을 명시적으로 켜 두는 쪽이 안전합니다.

### 3-2. 멱등성이 막는 것과 순서

멱등성이 없으면 이런 일이 생깁니다. 프로듀서가 배치를 보냈고 브로커는 받아서 썼는데 응답이 네트워크에서 사라집니다. 프로듀서는 시간 초과로 보고 다시 보내고 브로커는 같은 배치를 한 번 더 씁니다. Ch-03의 "처리는 됐는데 응답만 잃은 경우"입니다. 멱등성을 켜면 브로커가 프로듀서 ID와 파티션별 순번을 보고 이미 쓴 배치를 다시 쓰지 않습니다.

순서는 in-flight 요청 수와 엮입니다. 응답을 기다리는 요청이 여러 개인데 앞 요청만 실패해서 재시도하면, 뒤 요청이 먼저 쓰여 순서가 바뀔 수 있습니다. 문서는 멱등성이 꺼져 있고 이 값이 1보다 크면 재시도로 순서가 바뀔 위험이 있다고 적습니다. 멱등성이 켜져 있으면 브로커가 프로듀서마다 최근 배치 5개를 기억해서 5 이하에서는 순서가 지켜집니다. 그래서 멱등성을 켜려면 이 값이 5 이하여야 하고 충돌하는 설정을 직접 적었다면 설정 오류가 납니다. 직접 적지 않았는데 충돌하면 멱등성이 조용히 꺼집니다.

멱등성이 걸러 주는 범위는 프로듀서 세션 안의 재시도입니다. 애플리케이션이 같은 데이터를 두 번 `send()`하면 브로커는 다른 레코드로 봅니다. 이 경우는 Ch-13의 트랜잭션이나 받는 쪽의 멱등 처리로 다룹니다.

## 4. 처리량 중심과 지연 중심

Confluent Cloud의 최적화 문서는 목표에 따라 설정을 나눕니다.

| 목표 | 설정 |
|---|---|
| 처리량 | `batch.size` 100,000~200,000, `linger.ms` 10~100, lz4, `acks=1`, 컨슈머 `fetch.min.bytes` 약 100,000 |
| 지연 | `linger.ms=0`, 압축 없음, `acks=1`, 컨슈머 `fetch.min.bytes=1` |
| 내구성 | 복제 3, `acks=all`, 멱등성, 멱등성을 안 쓰면 `max.in.flight=1`, 컨슈머 자동 커밋 끄기 |

지연 중심 설정이 `linger.ms=0`인 것은 2절의 결론과 어긋나 보입니다. 브로커가 한가하고 요청 수가 문제 되지 않는 환경이라면 기다리지 않는 쪽이 빠릅니다. 2-2절처럼 요청 수가 브로커를 바쁘게 만드는 규모라면 linger가 지연을 줄입니다. 어느 쪽인지는 브로커의 요청 처리 지표를 보고 정합니다.

`acks=1`은 내구성과 맞바꾼 설정입니다. Confluent 2020년 측정에서 `acks=1`을 `all`로 바꾸자 같은 조건의 처리량이 초당 195MB에서 161MB로 줄었습니다. 같은 글은 `min.insync.replicas`는 가용성에만 영향을 주고 지연에는 영향이 없다고 적습니다.

## 5. 지연의 꼬리는 프로듀서 밖에서도 온다

Allegro는 2024년 글에서 초당 최대 30만 건을 쓰는 클러스터의 produce 지연을 추적했습니다. 중앙값은 한 자릿수 ms였는데 p99가 최대 1초, p99.9가 최대 3초까지 튀었습니다. eBPF로 따라가 보니 ext4 파일시스템의 주기적인 저널 커밋이 파일 쓰기를 늦추고 느린 쓰기 하나가 락 경합으로 뒤 요청들까지 줄 세우고 있었습니다. 브로커를 XFS로 옮긴 뒤 SLO(65ms)를 넘는 produce 요청 수가 82% 줄었습니다.

프로듀서 설정으로 다룰 수 있는 것은 1절의 produce 구간입니다. p99가 튀면 Ch-08처럼 백분위와 최댓값을 보고 Ch-09처럼 시각을 어디서 찍었는지 확인한 뒤, 구간별로 어디서 늘었는지 나눠 봐야 합니다.

## 6. 숫자로 감 잡기

LinkedIn이 2014년에 쓴 벤치마크 글(Kafka 0.8.1 무렵, 장비 6대 중 브로커 3대, 7200RPM 디스크, 1GbE, 100바이트 레코드, 대부분 기본 설정)의 결과입니다.

| 조건 | 처리량 |
|---|---|
| 프로듀서 1개, 복제 없음 | 초당 821,557건(78.3MB/s) |
| 프로듀서 1개, 3중 비동기 복제 | 초당 786,980건 |
| 프로듀서 1개, 3중 동기 복제 | 초당 421,823건 |
| 프로듀서 3개, 3중 비동기 복제 | 초당 2,024,032건 |

같은 글은 끝에서 끝까지 지연을 중앙값 2ms, p99 3ms, p99.9 14ms로 적었고 이 지연을 잰 부하 수준은 적혀 있지 않습니다. 12년 전 하드웨어와 버전이라 지금 숫자로 쓰기보다 "작은 레코드도 배치로 모으면 초당 수십만 건이 들어간다"는 감으로 씁니다.

## 7. 중국과 국내 빅테크 사례: 꼬리 지연은 페이지 캐시에서 온다

5절의 Allegro처럼 프로듀서 설정 밖에서 온 꼬리 지연 사례가 중국과 국내에도 있습니다. 공통 원인은 브로커의 페이지 캐시입니다.

| 회사 | 겪은 일 |
|---|---|
| Meituan(2021) | 서버당 페이지 캐시 80GB에 쓰기가 초당 170MB면 캐시에는 약 8분치만 남습니다. 소비 지연이 0~8분인 실시간 소비 작업은 80%뿐이었고 나머지 20%의 지연 소비가 디스크를 읽으면서 실시간 데이터를 캐시에서 밀어냈습니다. HDD는 읽기 동시성이 늘면 처리량이 급격히 떨어져 SSD 캐시 층을 따로 만들었습니다. 2022년 글은 쓰기와 읽기 TP99가 300ms를 넘는 브로커를 느린 노드로 정의했습니다 |
| 快手(2019) | 디스크가 바쁠 때 뒤처진 컨슈머에 속도 제한을 걸었습니다. 적용 전에는 디스크 사용률 100%에 produce 지연이 수 초였고 적용 뒤에는 사용률 약 60%로 안정됐습니다. 팔로워 쓰기와 뒤처진 읽기가 캐시를 오염시키지 않게 자체 블록 캐시도 만들었습니다 |
| LINE(2019) | Produce 응답 시간 p99가 평소보다 50~100배 나빠졌는데 요청 수는 그대로였고 디스크 읽기만 늘었습니다. 디스크를 읽어야 하는 Fetch 요청의 sendfile이 네트워크 스레드를 막고 있었습니다. sendfile 대부분은 2~32μs에 끝났지만 일부가 8ms를 넘었습니다. 요청 처리 스레드에서 /dev/null로 미리 sendfile을 해 페이지 캐시를 데워 두는 방식으로 해결했습니다 |

세 사례 모두 Ch-08의 교훈과 같습니다. 평균과 요청 수는 그대로인데 p99만 튀었고 원인은 다른 컨슈머의 읽기였습니다. 1절의 다섯 구간 중 publish 구간이 다른 작업에 막힌 경우입니다.

### 7-1. 네트워크 버퍼

Tencent Cloud의 2023년 글 "CKafka 跨洋数据同步性能优化"는 홍콩에서 미국 동부로 미러링할 때 연결당 소비 속도가 초당 325KB에 그친 문제를 다뤘습니다. 브로커와 컨슈머의 소켓 버퍼(`socket.send.buffer.bytes`, `receive.buffer.bytes`)를 기본값 64KB에서 OS 기본값으로 바꾸고 `max.partition.fetch.bytes`를 5MB로 올리자 연결당 초당 2MB 이상이 됐습니다. 왕복 시간이 긴 구간에서는 한 번에 보낼 수 있는 양(창 크기)이 처리량을 정하기 때문입니다.

vivo의 2021년 글은 `linger.ms`와 `batch.size`를 크게 하면 처리량이 오르지만 클라이언트가 죽으면 아직 보내지 않은 데이터를 잃을 위험이 있다고 경고합니다. 2절의 배치는 프로듀서 메모리에 있는 동안 보장이 없습니다.

## 8. 범위와 한계

- 2-3절은 단순 모델입니다. 프로듀서가 응답을 기다리는 동안 모으는 효과, 브로커 쪽 대기열, 압축을 넣지 않았습니다.
- Confluent 2020년 글의 그래프 수치(ms)와 Confluent 최적화 백서 본문은 확인하지 못했습니다. 4절의 표는 Confluent Cloud 문서의 권장값입니다.
- 실제 Kafka로 linger를 바꿔 가며 재지는 않았습니다. 재려면 Ch-09의 원칙대로 정해진 도착률로 보내고 프로듀서와 컨슈머를 같은 프로세스에 둔 Kafka의 `EndToEndLatency` 같은 방식으로 재야 합니다.

## 9. 헷갈렸던 것

**Q. linger.ms를 0으로 두면 레코드를 하나씩 보내나요?**

아닙니다. 프로듀서는 앞 요청의 응답을 기다리는 동안 들어온 레코드를 모아 다음 요청에 함께 보냅니다. linger 0은 "일부러 더 기다리지는 않는다"는 뜻입니다. 2-3절 모델이 linger 0을 요청당 1건으로 센 것은 이 효과를 뺐기 때문입니다.

**Q. acks=all이면 메시지를 절대 잃지 않나요?**

ISR이 줄어든 상태에서는 남은 복제본 수만큼만 지킵니다. `min.insync.replicas`를 2 이상으로 두어야 "적어도 두 곳에 있다"가 보장됩니다(Ch-11).

**Q. 멱등성을 켜면 exactly-once인가요?**

프로듀서와 브로커 사이 재시도의 중복을 없앨 뿐입니다. 애플리케이션이 같은 내용을 두 번 보내거나, 컨슈머가 처리 후 커밋 전에 죽어 다시 읽는 중복은 남습니다. 끝에서 끝까지의 보장은 Ch-13에서 다룹니다.

## 참고 자료

공식 문서
- Apache Kafka 4.3, [Producer configs](https://kafka.apache.org/43/generated/producer_config.html), [Design](https://kafka.apache.org/43/design/design/), [Upgrade notes](https://kafka.apache.org/43/getting-started/upgrade/)
- [KIP-1030: Change constraints and default values for various configurations](https://cwiki.apache.org/confluence/display/KAFKA/KIP-1030%3A+Change+constraints+and+default+values+for+various+configurations)
- Confluent Cloud 문서 클라이언트 최적화: [처리량](https://docs.confluent.io/cloud/current/client-apps/optimizing/throughput.html), [지연](https://docs.confluent.io/cloud/current/client-apps/optimizing/latency.html), [내구성](https://docs.confluent.io/cloud/current/client-apps/optimizing/durability.html)

측정과 사례
- Anna Povzner, Scott Hendricks, [99th Percentile Latency at Scale with Apache Kafka](https://www.confluent.io/blog/configure-kafka-to-minimize-latency/), Confluent, 2020
- Jay Kreps, [Benchmarking Apache Kafka: 2 Million Writes Per Second (On Three Cheap Machines)](https://engineering.linkedin.com/kafka/benchmarking-apache-kafka-2-million-writes-second-three-cheap-machines), LinkedIn, 2014
- Maciej Mościcki, Piotr Rżysko, [Unlocking Kafka's Potential: Tackling Tail Latency with eBPF](https://blog.allegro.tech/2024/03/kafka-performance-analysis.html), Allegro, 2024
- 실습 코드: [labs/de-study/ch12](https://github.com/dj258255/IT-Oasis/tree/main/labs/de-study/ch12)

중국과 국내 빅테크 사례
- 世吉, 仕禄(Meituan), [基于SSD的Kafka应用层缓存架构设计与实现](https://tech.meituan.com/2021/01/14/kafka-ssd.html), 2021
- Meituan, [Kafka在美团数据平台的实践](https://tech.meituan.com/2022/08/04/the-practice-of-kafka-in-the-meituan-data-platform.html), 2022
- 赵健博(快手), [快手万亿级别 Kafka 集群应用实践与技术演进之路](https://www.infoq.cn/article/q0o*qzlqiay31mwiobjh), 2019
- 谢雪辉(Tencent), [CKafka 跨洋数据同步性能优化](https://cloud.tencent.com/developer/article/2307606), 2023
- vivo互联网服务器团队, [Kafka万亿级消息实战](https://www.cnblogs.com/vivotech/p/14776819.html), 2021
- Kawamura Yuto, [LINE에서 Kafka를 사용하는 방법 - 2편](https://engineering.linecorp.com/ko/blog/how-to-use-kafka-in-line-2/), [3편](https://engineering.linecorp.com/ko/blog/how-to-use-kafka-in-line-3), LINE, 2019

---
title: '[DE Ch-13] 전달 보장: exactly-once는 출력과 오프셋을 함께 커밋하는 일이다'
description: at-most-once와 at-least-once는 컨슈머가 처리와 커밋 중 무엇을 먼저 하느냐로 갈립니다. Kafka의 exactly-once는 처리 결과와 읽은 위치를 한 트랜잭션으로 커밋해서 만듭니다. 컨슈머가 처리 도중 죽는 상황을 세 방식으로 재현하고 KIP-98의 트랜잭션 구조와 비용, read_committed 독자가 기다리는 시간, 외부 DB로 나갈 때 보장이 끝나는 지점을 공식 문서와 사례로 정리합니다.
date: 2026-10-19T00:00:00.000Z
tags:
  - Data Engineering
  - Kafka
  - Exactly-once
  - Transaction
  - Idempotence
  - Flink
category: data/Foundations
topics:
  - pipeline
  - messaging
draft: false
series: "DE 공부"
seriesOrder: 13
---

## 결론부터

1. 컨슈머가 커밋을 먼저 하고 처리하면 at-most-once(잃을 수 있음), 처리를 먼저 하고 커밋하면 at-least-once(중복될 수 있음)입니다. 재현에서 7번째 처리 직후 죽게 했더니 앞쪽은 7번을 잃었고 뒤쪽은 6, 7번을 두 번 처리했습니다.
2. Kafka의 exactly-once는 처리 결과(출력 토픽)와 읽은 위치(오프셋)를 한 트랜잭션으로 커밋해서 만듭니다. 오프셋도 Kafka 토픽에 저장되기 때문에 가능합니다. 트랜잭션이 abort되면 출력은 `read_committed` 독자에게 보이지 않고 위치도 되돌아갑니다.
3. 트랜잭션 비용은 들어간 메시지 수와 상관없이 일정합니다. 그래서 트랜잭션을 크게 할수록 처리량 손실이 줄지만 읽는 쪽은 커밋될 때까지 기다리므로 끝에서 끝까지 지연이 늘어납니다.
4. 보장은 Kafka 안에서 끝납니다. 처리 중 외부 DB에 쓰거나 API를 부르면 그 부작용은 트랜잭션에 묶이지 않습니다. 외부로 나가는 구간은 기본 키 upsert나 고유 키로 멱등하게 만듭니다.

---

## 1. 세 가지 보장

Kafka 설계 문서는 세 가지를 이렇게 정의합니다.

| 보장 | 정의 |
|---|---|
| at-most-once | 메시지를 잃을 수는 있지만 다시 전달하지는 않는다 |
| at-least-once | 메시지를 잃지는 않지만 다시 전달할 수 있다 |
| exactly-once | 각 메시지가 한 번, 단 한 번 처리된다 |

같은 문서는 이 문제가 둘로 나뉜다고 적습니다. 메시지를 발행할 때의 내구성과, 메시지를 소비할 때의 보장입니다. 발행 쪽은 Ch-12의 멱등 프로듀서가 재시도 중복을 막습니다. 이 글은 소비 쪽을 다룹니다.

## 2. 처리와 커밋의 순서

### 2-1. 재현

컨슈머가 메시지 10개를 처리하다 7번째를 처리한 직후 죽고 다시 시작하면 마지막으로 커밋된 오프셋부터 읽게 했습니다([labs/de-study/ch13](https://github.com/dj258255/IT-Oasis/tree/main/labs/de-study/ch13)의 `delivery_semantics.py`).

| 방식 | 최종 처리 결과 | 빠짐 | 중복 |
|---|---|---|---|
| 커밋 후 처리 | 1, 2, 3, 4, 5, 6, 8, 9, 10 | 7 | 없음 |
| 처리 후 커밋(5개마다) | 1, 2, 3, 4, 5, 6, 7, 6, 7, 8, 9, 10 | 없음 | 6, 7 |
| 출력과 오프셋을 함께 커밋(5개 단위 트랜잭션) | 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 | 없음 | 없음 |

- 커밋 후 처리: 7번의 오프셋을 커밋한 뒤 처리하기 전에 죽었습니다. 다시 시작하면 8번부터 읽으니 7번은 영영 처리되지 않습니다.
- 처리 후 커밋: 6, 7번을 처리했지만 다음 커밋(10번) 전에 죽었습니다. 마지막 커밋은 5번이라 6번부터 다시 읽습니다.
- 트랜잭션: 6, 7번의 출력은 아직 커밋되지 않은 트랜잭션 안에 있었습니다. 죽으면서 그 트랜잭션이 abort되어 출력이 보이지 않게 되고 위치도 5번으로 남습니다. 다시 처리한 6, 7번의 출력만 커밋됩니다.

설계 문서도 같은 순서로 설명합니다. 읽고 위치를 저장하고 처리하면 at-most-once입니다. 읽고 처리하고 위치를 저장하면 컨슈머 장애 때 at-least-once입니다. 그리고 기본 키로 덮어쓰는 갱신처럼 같은 메시지를 두 번 받아도 같은 값으로 덮어쓰는 처리라면 at-least-once로도 결과가 같다고 덧붙입니다. Ch-03의 멱등성 이야기입니다.

### 2-2. 커밋 간격이 정하는 것

처리 후 커밋 방식에서 중복의 양은 커밋 간격이 정합니다. 5개마다 커밋하면 최대 4개, `enable.auto.commit`(기본 5초 간격)이면 최대 5초치가 다시 처리될 수 있습니다. 커밋을 자주 하면 중복은 줄지만 커밋 요청이 늘어납니다.

## 3. Kafka 트랜잭션

### 3-1. 출력과 오프셋을 한 트랜잭션에

설계 문서의 설명입니다. 컨슈머의 위치는 내부 토픽에 메시지로 저장되므로, 처리 결과를 받는 출력 토픽과 같은 트랜잭션으로 오프셋을 Kafka에 쓸 수 있다. 트랜잭션이 abort되면 저장된 위치는 이전 값으로 돌아간다. 다만 컨슈머가 자동으로 되감지 않으므로 커밋된 오프셋을 다시 가져와야 한다.

```java
producer.initTransactions();
while (true) {
    ConsumerRecords<String, String> records = consumer.poll(Duration.ofMillis(100));
    producer.beginTransaction();
    for (ConsumerRecord<String, String> r : records) {
        producer.send(new ProducerRecord<>("daily-sales", r.key(), process(r)));
    }
    // 읽은 위치를 같은 트랜잭션에 넣는다
    producer.sendOffsetsToTransaction(nextOffsets(records), consumer.groupMetadata());
    producer.commitTransaction();
}
```

문서의 "Using Transactions" 절이 붙이는 조건은 이렇습니다.

- 트랜잭션은 프로듀서에만 있습니다. 컨슈머 인스턴스마다 프로듀서 인스턴스를 하나씩 두는 것을 권합니다.
- 컨슈머는 `isolation.level=read_committed`, `enable.auto.commit=false`여야 합니다.
- abort되면 애플리케이션 상태와 컨슈머 위치를 직접 되돌려야 합니다.

### 3-2. 구조: KIP-98

| 구성 요소 | 하는 일 |
|---|---|
| 프로듀서 ID와 순번 | 프로듀서마다 ID를 받고 파티션별 순번을 붙인다. 브로커가 이걸로 재시도 중복을 거른다(멱등 프로듀서) |
| `transactional.id` | 애플리케이션이 정하는 고정 ID. 같은 ID로 새 프로듀서가 뜨면 epoch를 올려 옛 프로듀서(좀비)를 막는다 |
| transaction coordinator | 트랜잭션 상태를 관리하는 브로커. 상태는 내부 토픽(transaction log)에 저장한다 |
| control record | 커밋 단계에서 각 파티션에 COMMIT 또는 ABORT 표시를 쓴다. 클라이언트가 처리하고 사용자에게는 보이지 않는다 |
| `isolation.level` | 기본은 `read_uncommitted`. `read_committed`는 커밋된 트랜잭션의 메시지와 트랜잭션 밖 메시지만 읽는다 |
| LSO(last stable offset) | 아직 끝나지 않은 트랜잭션 중 가장 앞선 위치. `read_committed` 컨슈머는 이 앞까지만 읽는다 |

KIP-98은 이 보장이 프로듀서 관점이라고 적습니다. 컨슈머 쪽은 조금 약하고 이유로 로그 압축, 세그먼트 삭제, 임의 위치로의 seek를 듭니다. 2.6의 KIP-447은 입력 파티션마다 프로듀서를 하나씩 만들어야 하던 구조를 고쳐, `sendOffsetsToTransaction`에 컨슈머 그룹 정보를 넘기는 방식으로 스레드당 프로듀서 하나로 줄였습니다. 4.0에서는 KIP-890이 커밋이나 abort마다 epoch를 올려, 늦게 도착한 이전 트랜잭션의 메시지가 다음 트랜잭션에 섞이는 문제와 끝나지 않는 트랜잭션 때문에 LSO가 멈추는 문제를 막았습니다.

### 3-3. 비용

Confluent의 2017년 글 "Transactions in Apache Kafka"(Apurva Mehta, Jason Gustafson)가 비용을 설명합니다.

- 트랜잭션의 오버헤드는 그 안에 쓴 메시지 수와 상관없습니다. 처리량을 높이려면 트랜잭션 하나에 메시지를 많이 넣습니다.
- 1KB 레코드를 최대 속도로 쓰면서 100ms마다 커밋하면 처리량이 3% 줄었습니다. 메시지가 작거나 커밋 간격이 짧으면 더 많이 줄어듭니다.
- 트랜잭션을 길게 하면 끝에서 끝까지 지연이 늘어납니다. 커밋 간격이 길수록 읽는 쪽이 오래 기다립니다.
- `read_committed` 컨슈머는 처리량이 줄지 않았습니다. zero-copy를 유지하고 컨슈머가 따로 버퍼링하지 않기 때문입니다.

같은 해 Confluent 글 "Exactly-once Semantics is Possible"은 Kafka Streams에서 커밋 간격을 100ms로 짧게 잡으면 메시지 크기에 따라 처리량이 15~30% 줄고 30초로 잡으면 1KB 이상 메시지에서는 손실이 없었다고 적습니다. 두 수치 모두 0.11 시절 측정입니다.

정리하면 트랜잭션 크기가 처리량과 지연을 맞바꿉니다. Ch-12의 linger.ms와 같은 구조입니다.

### 3-4. 열린 트랜잭션 하나가 뒤의 커밋까지 붙잡는다

`read_committed` 컨슈머는 LSO 앞까지만 읽습니다. 트랜잭션 하나가 끝나지 않으면, 그 뒤에 커밋된 다른 트랜잭션의 메시지도 보이지 않습니다. Flink 1.13 Kafka 커넥터 문서는 끝나지 않은 트랜잭션 1이 있으면 커밋된 트랜잭션 2도 트랜잭션 1이 끝날 때까지 보이지 않는다고 적습니다. 브로커의 `transaction.max.timeout.ms`(기본 15분)는 트랜잭션이 열려 있을 수 있는 최대 시간이고 문서는 너무 큰 값이 컨슈머를 멈춰 세울 수 있다고 경고합니다.

## 4. Flink와 Kafka: 체크포인트에 맞춘 두 단계 커밋

Flink는 Kafka 트랜잭션을 체크포인트와 묶습니다. 현재 Flink KafkaSink 문서는 `DeliveryGuarantee.EXACTLY_ONCE`일 때 모든 메시지를 Kafka 트랜잭션으로 쓰고 체크포인트 때 커밋한다고 적습니다. 체크포인트를 시작하는 것이 사전 커밋(pre-commit) 단계이고 체크포인트가 끝나면 커밋합니다(Flink 2018년 글).

여기서 두 가지가 나옵니다.

- 가시성: 결과는 체크포인트가 끝나야 보입니다. 체크포인트 간격이 1분이면 `read_committed` 독자는 평균 30초쯤 늦게 봅니다(Ch-17에서 셉니다).
- 시간 제한: Flink 문서는 Kafka 트랜잭션 시간 제한을 "최대 체크포인트 시간 + 최대 재시작 시간"보다 크게 잡으라고 권합니다. 그보다 짧으면 재시작하는 동안 트랜잭션이 만료되어 데이터를 잃을 수 있습니다. 프로듀서의 `transaction.timeout.ms`를 올리려면 브로커의 `transaction.max.timeout.ms`(기본 15분)도 그 이상이어야 합니다.

Uber의 2021년 광고 이벤트 처리 글은 Flink 집계 결과를 Kafka 트랜잭션으로 쓰고 다운스트림이 `read_committed`로 읽게 했습니다. 체크포인트 간격이 지연의 병목이 되어 기본 10분 대신 2분을 썼고 그래서 엄밀한 실시간은 아니라고 적었습니다.

## 5. 보장이 끝나는 곳

### 5-1. 외부 시스템

Confluent 글은 exactly-once가 Kafka Streams 내부 처리 범위에서만 보장되고 처리 중 원격 저장소를 갱신하는 RPC를 부르면 그 부작용은 한 번이라고 보장되지 않는다고 적습니다. Kafka 설계 문서도 다른 대상 시스템에 대한 exactly-once는 그 시스템의 협력이 필요하고 Kafka는 그걸 구현할 수 있는 기본 장치를 제공한다고 적습니다. 가장 간단한 방법으로는 컨슈머가 오프셋을 출력과 같은 곳에 저장하는 것을 듭니다.

| 출력 대상 | 방법 |
|---|---|
| 다른 Kafka 토픽 | 트랜잭션(3절) |
| DB | 출력과 오프셋을 같은 DB 트랜잭션에 쓰거나, 기본 키 upsert로 멱등하게 |
| 외부 API | 고유 요청 키(멱등키)로 상대가 중복을 거르게 |
| 레이크하우스 | 기본 키 upsert(Ch-20) |

Uber 사례도 Kafka 트랜잭션만으로 끝내지 않았습니다. 레코드마다 UUID를 멱등 키로 붙여 Hive에서는 중복을 제거하고 Pinot에서는 upsert로 반영했습니다.

Kafka 4.1부터는 외부 트랜잭션 관리자가 두 단계 커밋에 Kafka를 참여시킬 수 있게 하는 KIP-939의 설정(`transaction.two.phase.commit.enable`, 기본 false)이 문서에 생겼습니다. Kafka와 DB에 같이 쓰는 이중 쓰기(dual write)가 장애 때 어긋나는 문제를 풀려는 기능입니다.

### 5-2. "exactly-once delivery는 불가능하다"는 말

Tyler Treat의 블로그 글 "You Cannot Have Exactly-Once Delivery"(2015)는 분산 시스템에서 메시지를 정확히 한 번 전달하는 것은 불가능하다고 말합니다. 근거는 두 장군 문제와 FLP 불가능성입니다. 실무에서는 메시지 처리를 멱등하게 만들거나 중복을 제거해서 한 번처럼 보이게 만든다고 정리합니다.

Kafka 쪽의 정의는 이 논쟁과 어긋나지 않습니다. KIP-129는 "exactly once processing"이라는 말이 좁지만 각 메시지를 정확히 한 번 본 것과 같은 출력이 나온다는 보장으로 이해하면 맞다고 적습니다. Confluent 글도 받은 레코드마다 처리 결과가 장애가 있어도 한 번 반영된다고 정의합니다. 전달은 여러 번 일어날 수 있고 결과에 한 번 반영되게 만든다는 뜻입니다.

## 6. 국내 빅테크 사례

중국 빅테크의 Kafka 트랜잭션이나 exactly-once 도입 사례는 찾지 못했습니다. 국내 사례는 트랜잭션 대신 구간마다 중복과 유실을 다룬 쪽입니다.

- **올리브영**(2024) "Kafka 메시지 중복 및 유실 케이스별 해결 방법": 구간별로 `acks=all`과 멱등 프로듀서(Ch-12), 수동 즉시 커밋(`MANUAL_IMMEDIATE`), CooperativeSticky 할당을 썼습니다. 실제 장애는 처리 시간이 `max.poll.interval.ms`(10분)를 넘겨 커밋이 실패하고 리밸런스 뒤 중복 소비가 난 경우였습니다. 2-1절의 "처리 후 커밋"에서 커밋을 못 한 경우입니다.
- **카카오페이**(2024) 지연이체: 같은 송금 요청이 두 번 와도 상태가 지연(DELAY)이 아니면 건너뛰고 사용자 단위 락을 걸었습니다. 5-1절의 "외부 DB는 멱등하게"를 상태 확인으로 구현한 방식입니다.
- **우아한형제들**(2025): 처리 전에 커밋하는 임시 조치로 중복은 막았지만 유실 위험이 생겼다고 적었습니다. 2-1절 표의 첫 줄(at-most-once)로 옮겨 간 것입니다. 결국 상태를 DB로 관리하는 작업 큐로 바꿨습니다.
- **토스증권**(2025) 데이터센터 이중화 #3: 두 클러스터 사이 미러링(MirrorMaker2)은 오프셋 대응을 기본 100건마다 한 번만 기록해서 다른 데이터센터로 넘어갈 때 정확한 대응점이 없으면 보수적으로 앞쪽 오프셋을 써 중복이 생깁니다. 데이터센터 장애 때는 "중복 최소, 유실 없음", 계획 작업 때는 "중복도 유실도 없음"을 요구사항으로 두고 계획 작업에서는 트래픽을 한쪽으로 다 돌린 뒤 넘겨 중복을 없앴습니다. 보장 수준을 상황마다 다르게 정한 사례입니다.
- **카카오**(2022): Kafka Connect에서 메모리를 많이 쓰는 커넥터가 OOM으로 죽으면 커밋이 실패해 같은 노드의 다른 커넥터까지 중복 처리될 수 있어 Connect 클러스터를 나눴습니다.

## 7. 범위와 한계

- 2-1절은 시뮬레이션입니다. 실제 Kafka 트랜잭션을 돌리지 않았습니다.
- 3-3절의 3%, 15~30% 수치는 2017년 Kafka 0.11 시점의 측정이고 4.x에서 다시 잰 공식 수치는 찾지 못했습니다.
- KIP-939가 4.1에 들어왔다는 것은 4.0 설정 문서에 없고 4.1 문서에 있다는 것으로 판단했습니다. 업그레이드 노트에서는 찾지 못했습니다.

## 8. 헷갈렸던 것

**Q. 멱등 프로듀서만 켜면 exactly-once 아닌가요?**

멱등 프로듀서는 프로듀서가 같은 배치를 재시도할 때 생기는 중복만 없앱니다. 컨슈머가 처리하고 커밋하기 전에 죽어서 다시 읽는 중복(2-1절의 두 번째 줄)은 남습니다. 그걸 없애는 것이 출력과 오프셋을 함께 커밋하는 트랜잭션입니다.

**Q. 트랜잭션을 쓰면 컨슈머도 꼭 read_committed여야 하나요?**

기본값 `read_uncommitted`는 abort된 트랜잭션의 메시지까지 보여 줍니다. 재현의 세 번째 줄에서 abort된 6, 7번 출력이 보이면 결국 중복이 됩니다. 결과를 읽는 쪽이 `read_committed`여야 트랜잭션의 의미가 살아납니다.

**Q. 그럼 항상 exactly-once를 켜는 게 좋은가요?**

처리량과 지연을 내주고 외부 시스템으로 나가는 순간 보장이 끝납니다. 받는 쪽이 기본 키로 덮어쓰는 구조라면 at-least-once로도 결과가 같습니다. Kafka 안에서 다른 토픽으로 집계를 이어 가는 파이프라인처럼 중복이 결과를 바꾸고 멱등하게 만들기 어려운 곳에 씁니다.

## 참고 자료

공식 문서와 KIP
- Apache Kafka 4.3, [Design](https://kafka.apache.org/43/design/design/)(Message Delivery Semantics, Using Transactions), [Upgrade notes](https://kafka.apache.org/43/getting-started/upgrade/)
- [KIP-98 - Exactly Once Delivery and Transactional Messaging](https://cwiki.apache.org/confluence/display/KAFKA/KIP-98+-+Exactly+Once+Delivery+and+Transactional+Messaging)
- [KIP-129: Streams Exactly-Once Semantics](https://cwiki.apache.org/confluence/display/KAFKA/KIP-129%3A+Streams+Exactly-Once+Semantics)
- [KIP-447: Producer scalability for exactly once semantics](https://cwiki.apache.org/confluence/display/KAFKA/KIP-447%3A+Producer+scalability+for+exactly+once+semantics)
- [KIP-890: Transactions Server-Side Defense](https://cwiki.apache.org/confluence/display/KAFKA/KIP-890%3A+Transactions+Server-Side+Defense)
- [KIP-939: Support Participation in 2PC](https://cwiki.apache.org/confluence/display/KAFKA/KIP-939%3A+Support+Participation+in+2PC)
- Apache Flink, [Kafka connector](https://nightlies.apache.org/flink/flink-docs-stable/docs/connectors/datastream/kafka/), [Kafka connector 1.13](https://nightlies.apache.org/flink/flink-docs-release-1.13/docs/connectors/datastream/kafka/)

글과 사례
- Neha Narkhede 외, [Exactly-once Semantics is Possible: Here's How Apache Kafka Does it](https://www.confluent.io/blog/exactly-once-semantics-are-possible-heres-how-apache-kafka-does-it/), Confluent, 2017
- Apurva Mehta, Jason Gustafson, [Transactions in Apache Kafka](https://www.confluent.io/blog/transactions-apache-kafka/), Confluent, 2017
- Piotr Nowojski, Mike Winters, [An Overview of End-to-End Exactly-Once Processing in Apache Flink (with Apache Kafka, too!)](https://flink.apache.org/2018/02/28/an-overview-of-end-to-end-exactly-once-processing-in-apache-flink-with-apache-kafka-too/), 2018
- Brave New Geek, [You Cannot Have Exactly-Once Delivery](https://bravenewgeek.com/you-cannot-have-exactly-once-delivery/), 2015
- Jacob Tsafatinos 외, [Real-Time Exactly-Once Ad Event Processing with Apache Flink, Kafka, and Pinot](https://www.uber.com/blog/real-time-exactly-once-ad-event-processing/), Uber, 2021
- 데브원영, [아파치 카프카 Exactly-once 처리의 진실과 거짓](https://blog.voidmainvoid.net/504), 2023
- 실습 코드: [labs/de-study/ch13](https://github.com/dj258255/IT-Oasis/tree/main/labs/de-study/ch13)

중국과 국내 빅테크 사례
- 시나브로우, [Kafka 메시지 중복 및 유실 케이스별 해결 방법](https://oliveyoung.tech/2024-10-16/oliveyoung-scm-oms-kafka/), 올리브영, 2024
- elmo.wiz, [지연이체 서비스 개발기: 은행 점검 시간 끝나면 송금해 드릴게요! (feat. 발표 후기)](https://tech.kakaopay.com/post/ifkakao2024-delayed-transfer/), 카카오페이, 2024
- 박민규, [장시간 비동기 작업, Kafka 대신 RDB 기반 Task Queue로 해결하기](https://techblog.woowahan.com/23625/), 우아한형제들, 2025
- 김용우, [토스증권 Apache Kafka 데이터센터 이중화 구성 #3: Offset Sync](https://toss.tech/article/33121), 토스, 2025
- cory.doras, [제네시스 - 광고추천팀의 카프카 기반 스트리밍 데이터 플랫폼](https://tech.kakao.com/posts/506), 카카오, 2022

---
title: '[DE Ch-11] Kafka 로그 구조: 순서는 파티션 안에서만, 파티션을 늘리면 키가 옮겨 간다'
description: Kafka의 토픽은 파티션으로 나뉜 추가 전용 로그입니다. 순서는 파티션 안에서만 보장되고 같은 키는 murmur2 해시로 같은 파티션에 갑니다. 파티션 수를 6개에서 8개로 늘리면 키의 74.6%가 다른 파티션으로 옮겨 간다는 것을 Kafka와 같은 해시로 확인합니다. 세그먼트와 보존, 오프셋 저장, 컨슈머 그룹과 리밸런스 프로토콜의 변화, 복제와 ISR까지 Kafka 4.3 문서 기준으로 정리합니다.
date: 2026-10-19T00:00:00.000Z
tags:
  - Data Engineering
  - Kafka
  - Partition
  - Consumer Group
  - Rebalance
  - Replication
category: data/Streaming
topics:
  - pipeline
  - messaging
draft: false
series: "DE 공부"
seriesOrder: 11
---

## 결론부터

1. Kafka 토픽은 파티션 여러 개로 나뉘고 각 파티션은 추가만 하는 로그입니다. 순서는 파티션 하나 안에서만 보장되고 파티션 사이에는 순서가 없습니다.
2. 키가 있는 레코드는 키의 murmur2 해시를 파티션 수로 나눈 나머지로 파티션이 정해집니다. 그래서 같은 키는 같은 파티션에 가고 순서가 지켜집니다. 대신 파티션 수를 바꾸면 매핑이 바뀝니다. Kafka와 같은 해시로 계산해 보니 6개에서 8개로 늘릴 때 키의 74.6%가 다른 파티션으로 옮겨 갔습니다.
3. 컨슈머 그룹 안에서 파티션 하나는 한 번에 컨슈머 하나만 읽습니다. 컨슈머가 파티션보다 많으면 남는 컨슈머는 할 일이 없습니다. 컨슈머가 들고 나면 파티션을 다시 나누는 리밸런스가 일어나고 Kafka 4.0에서 서버가 할당을 맡는 새 프로토콜(KIP-848)이 GA가 됐습니다.
4. 복제는 ISR(동기화된 복제본 집합) 기준입니다. `acks=all`은 지금 ISR 전원이 받았다는 뜻이라, ISR이 1개로 줄면 1개만 받아도 성공합니다. 이를 막는 것이 `min.insync.replicas`이고 기본값은 1입니다. 흔한 운영 구성은 복제 3, `min.insync.replicas=2`, `acks=all`입니다.

---

## 1. 로그: 추가만 하는 순서 있는 기록

Jay Kreps는 2013년 글 "The Log"에서 로그를 시간 순서로 정렬된, 추가만 하는 레코드의 나열로 정의했습니다. 각 레코드의 번호가 타임스탬프 역할을 하고 이 순서는 특정 기계의 시계와 상관이 없습니다. 같은 상태에서 시작한 결정적 프로세스 둘이 같은 입력을 같은 순서로 받으면 같은 상태로 끝난다는 원리 위에서 로그는 여러 시스템이 같은 순서로 같은 데이터를 받게 하는 장치가 됩니다.

시스템 N개를 서로 직접 연결하면 연결이 N²개 가깝게 늘어납니다. 모두가 로그 하나에 쓰고 로그 하나를 읽으면 연결은 N개가 됩니다. Ch-01의 Kappa 아키텍처가 "로그를 충분히 오래 보관하고 다시 읽는다"는 전제를 세운 것도 이 글의 연장입니다.

이 블로그의 [토이 Kafka 글](/blog/hobby/kafka-hobby-00-why-and-architecture)에서 이 구조를 직접 만들어 보고 있습니다. 이 글은 실제 Kafka의 동작을 문서 기준으로 정리합니다.

## 2. 파티션과 순서

### 2-1. 순서는 파티션 안에서만

토픽 하나는 파티션 여러 개로 나뉩니다. 파티션마다 별도의 로그라 여러 브로커에 흩어 두고 병렬로 쓰고 읽을 수 있습니다. 그 대가로 순서는 파티션 안에서만 있습니다. "The Log"는 각 파티션은 완전히 정렬된 로그지만 파티션 사이에는 전역 순서가 없다고 적고 Kafka 4.3 소개 문서는 같은 키를 가진 레코드가 같은 파티션에 쓰이고 그 파티션을 읽는 컨슈머는 항상 쓴 순서대로 읽는다고 적습니다.

| 원하는 순서 | 방법 |
|---|---|
| 한 주문의 이벤트(생성, 결제, 배달 출발) 순서 | 주문 ID를 키로 쓴다 |
| 한 사용자의 행동 순서 | 사용자 ID를 키로 쓴다 |
| 토픽 전체의 순서 | 파티션을 1개로 둔다. 병렬성을 포기한다 |

우아한형제들의 2024년 글은 하루 100만 건 이상의 배달 주문을 다루며 주문과 배달 식별자를 키로 써서 파티션 안 순서를 보장했다고 적었습니다.

### 2-2. 키에서 파티션으로: murmur2

키가 있는 레코드의 파티션은 Kafka 클라이언트 소스의 `BuiltInPartitioner.partitionForKey`가 정합니다.

```java
return Utils.toPositive(Utils.murmur2(serializedKey)) % numPartitions;
```

이 해시를 파이썬으로 옮기고 Kafka 저장소의 단위 테스트(`UtilsTest.testMurmur2`)에 있는 값 여섯 개와 같은지 확인한 뒤 실험했습니다. 코드는 [labs/de-study/ch11](https://github.com/dj258255/IT-Oasis/tree/main/labs/de-study/ch11)에 있습니다. 키는 `user-0`부터 `user-9999`까지 1만 개입니다.

| 확인 | 결과 |
|---|---|
| 파티션 6개에 나뉜 키 수 | 1,700 / 1,668 / 1,703 / 1,575 / 1,650 / 1,704 |
| 6개 → 8개로 늘렸을 때 파티션이 바뀐 키 | 7,462개(74.6%) |
| 6개 → 12개로 늘렸을 때 파티션이 바뀐 키 | 5,039개(50.4%) |

키는 고르게 나뉩니다. 파티션 수를 늘리면 대부분의 키가 다른 파티션으로 갑니다. 나머지 연산이라 6에서 12처럼 두 배로 늘리면 절반만 옮겨 가고(나머지가 0~5인 키는 그대로), 6에서 8처럼 늘리면 4분의 3이 옮겨 갑니다.

옮겨 가는 순간 순서 보장이 깨질 수 있습니다. `user-42`의 이벤트가 파티션 4에 쌓여 있는데 파티션을 늘린 뒤 새 이벤트가 파티션 1로 가면, 파티션 1을 읽는 컨슈머가 파티션 4의 이전 이벤트보다 먼저 새 이벤트를 처리할 수 있습니다. Jun Rao의 파티션 수 결정 글(2015)도 키가 있는 토픽은 파티션을 늘리면 키와 파티션의 매핑이 바뀌니 처음부터 넉넉히 잡으라고 권합니다. 같은 글은 최소 파티션 수를 목표 처리량을 파티션 하나의 생산 처리량과 소비 처리량으로 각각 나눈 값 중 큰 쪽으로 잡는 식을 제시합니다.

### 2-3. 키가 없으면

키가 없는 레코드는 sticky 방식으로 파티션을 고릅니다. 한 파티션에 batch.size만큼 쓸 때까지 그 파티션에 붙어 있다가 다음 파티션으로 넘어갑니다. 2.4의 KIP-480은 레코드마다 파티션을 돌아가며 고르는 대신 배치 단위로 붙여 배치를 크게 만들었고 KIP 문서는 측정에서 지연이 절반으로 줄었다고 적습니다. 3.3의 KIP-794는 느린 브로커의 파티션에 레코드가 더 몰리는 문제를 고쳐, 큐가 짧은 파티션을 더 자주 고르게 했습니다.

## 3. 세그먼트, 보존, 오프셋

### 3-1. 세그먼트와 보존

파티션의 로그는 디스크에서 여러 세그먼트 파일로 나뉩니다. 파일 이름은 그 세그먼트의 첫 오프셋이고(`00000000000000000000.log`), 세그먼트가 정해진 크기에 닿으면 새 파일로 넘어갑니다. 지울 때는 세그먼트 파일 단위로 지웁니다.

| 토픽 설정 | 기본값(4.3) | 뜻 |
|---|---|---|
| `retention.ms` | 604800000(7일) | 이보다 오래된 세그먼트를 지운다. 세그먼트 안 가장 늦은 타임스탬프로 판단한다 |
| `retention.bytes` | -1(무제한) | 파티션 크기 기준 보존. 기본은 꺼져 있다 |
| `segment.bytes` | 1GiB | 세그먼트 하나의 크기 |
| `cleanup.policy` | delete | `compact`면 키마다 마지막 값을 남긴다 |

`cleanup.policy=compact`(log compaction)는 파티션 안에서 키마다 적어도 마지막 값 하나를 남깁니다. 압축된 뒤에도 남은 메시지는 원래 오프셋을 그대로 가집니다. "The Log"가 말한 테이블과 이벤트의 이중성이 여기서 나옵니다. 키마다 최신 값만 남긴 로그는 그 시점의 테이블과 같습니다.

### 3-2. 오프셋은 Kafka 안에 저장된다

컨슈머가 어디까지 읽었는지(오프셋)는 내부 토픽 `__consumer_offsets`에 메시지로 저장됩니다. 파티션 하나를 그룹 안 컨슈머 하나만 읽으니, 그룹의 위치는 파티션마다 정수 하나로 충분합니다.

| 컨슈머 설정 | 기본값(4.3) | 뜻 |
|---|---|---|
| `enable.auto.commit` | true | 주기적으로 오프셋을 자동 커밋한다 |
| `auto.commit.interval.ms` | 5000 | 자동 커밋 주기 |
| `auto.offset.reset` | latest | 커밋된 오프셋이 없을 때 어디서 시작할지. latest면 지금부터 들어오는 것만 읽는다 |
| `offsets.retention.minutes`(브로커) | 10080(7일) | 커밋된 오프셋을 보관하는 기간 |

`auto.offset.reset=latest`에는 문서의 경고가 붙어 있습니다. 이 설정으로 파티션 수를 바꾸면 메시지를 놓칠 수 있습니다. 새로 생긴 파티션에는 커밋된 오프셋이 없어서 컨슈머가 그 파티션을 처음 읽기 시작하기 전에 들어온 메시지를 건너뛰기 때문입니다. 2-2절의 매핑 변화와 함께 파티션 늘리기를 조심해야 하는 두 번째 이유입니다.

## 4. 컨슈머 그룹과 리밸런스

### 4-1. 파티션 하나에 컨슈머 하나

같은 그룹 ID를 가진 컨슈머들은 토픽의 파티션을 나눠 읽습니다. 설계 문서는 파티션 하나를 그룹 안의 컨슈머 정확히 하나가 읽는다고 적습니다. 실습 스크립트로 파티션 6개를 단순 라운드로빈으로 나눴습니다.

| 컨슈머 수 | 컨슈머별 파티션 | 노는 컨슈머 |
|---|---|---|
| 3 | 2, 2, 2 | 0 |
| 6 | 1, 1, 1, 1, 1, 1 | 0 |
| 8 | 1, 1, 1, 1, 1, 1, 0, 0 | 2 |

컨슈머를 늘려 처리량을 올리는 데는 파티션 수가 상한입니다. 4.2부터 production-ready가 된 share group(KIP-932)은 이 제약이 없습니다. 문서는 share group의 컨슈머 수가 파티션 수를 넘을 수 있다고 적고 레코드 단위로 확인하고 전달 횟수를 셉니다. 대신 파티션 안 순서를 기대할 수 없는 큐에 가깝습니다.

### 4-2. 리밸런스

컨슈머가 새로 들어오거나 나가거나 응답이 없으면 파티션을 다시 나눕니다. 이 과정이 리밸런스입니다.

| 방식 | 도입 | 내용 |
|---|---|---|
| eager | 초기 | 모든 컨슈머가 가진 파티션을 다 내려놓고 새로 받는다. 그동안 그룹 전체가 멈춘다 |
| cooperative incremental(KIP-429) | 2.4 | 옮겨야 하는 파티션만 내려놓는다. 4.3 classic 프로토콜의 기본 할당 전략은 `[RangeAssignor, CooperativeStickyAssignor]` |
| static membership(KIP-345) | 2.3 | `group.instance.id`를 주면 재시작해도 같은 멤버로 본다. 세션 타임아웃 안에 돌아오면 리밸런스가 없다 |
| 새 컨슈머 그룹 프로토콜(KIP-848) | 4.0 GA | 할당을 서버가 맡고 전역 동기화 단계가 없다. 클라이언트에서 `group.protocol=consumer`를 줘야 켜진다(기본은 아직 classic) |

KIP-848 프로토콜에서는 `session.timeout.ms`, `heartbeat.interval.ms`, `partition.assignment.strategy`를 클라이언트에서 쓰지 않고 브로커 설정(`group.consumer.session.timeout.ms` 기본 45초 등)으로 정합니다. 공식 로드맵(KIP-1274)은 5.0에서 이 프로토콜을 기본으로 만드는 계획입니다.

### 4-3. 처리가 느려서 생기는 리밸런스

국내 기술블로그 두 곳이 같은 원인을 적었습니다.

- 사람인(2019): 메일 시스템에서 메시지 처리 중 DB 조회가 1분 30초~2분 걸렸습니다. 한 번에 가져오는 500건(`max.poll.records` 기본값)을 처리하는 동안 `max.poll.interval.ms`(5분)를 넘겨 그룹에서 빠지고 리밸런스가 일어났고 커밋된 오프셋이 실제 처리 위치보다 뒤처져 같은 메시지를 다시 소비했습니다. `session.timeout.ms`를 늘려도 효과가 없었고 `max.poll.interval.ms=600000`, `max.poll.records=2`로 해결한 뒤 처리량은 파티션과 동시성을 늘려 보충했습니다.
- 넥스트리(2026): 약 10분마다 리밸런스가 반복됐습니다. `max.poll.interval.ms`가 10분인데 메시지 하나의 처리(약 4만 6천 건 저장)가 10분을 넘었습니다. 시간을 늘린 것은 임시 조치였고 일괄 저장으로 처리 시간 자체를 줄였습니다.

두 사례 모두 `session.timeout.ms`(하트비트가 끊긴 것을 잡는 값)가 아니라 `max.poll.interval.ms`(poll을 너무 오래 안 부른 것을 잡는 값)에 걸렸습니다. 하트비트는 별도 스레드가 보내므로 처리 스레드가 오래 걸려도 계속 갑니다. 그리고 리밸런스 뒤 중복 소비가 생기므로 Ch-03의 멱등성이 다시 필요합니다.

## 5. 복제와 ISR

| 개념 | Kafka 4.3 문서 |
|---|---|
| committed | 그 파티션의 ISR 전원이 받은 메시지. ISR 중 하나라도 살아 있으면 잃지 않는다 |
| ISR에서 빠지는 조건 | 팔로워가 `replica.lag.time.max.ms`(기본 30초) 동안 가져가지 않거나 따라잡지 못하면 |
| `acks=all` | 지금 ISR에 있는 복제본 전원이 받으면 확인한다 |
| `min.insync.replicas`(기본 1) | `acks=all`인데 ISR이 이보다 적으면 쓰기를 거부한다(NotEnoughReplicas) |
| 컨슈머에게 보이는 시점 | `acks` 설정과 상관없이 ISR 전원에 복제되고 `min.insync.replicas` 조건을 만족한 뒤 |
| `unclean.leader.election.enable` | 기본 false. ISR 밖의 뒤처진 복제본을 리더로 세우지 않는다 |

`acks=all`만으로는 부족한 이유가 표의 셋째, 넷째 줄에 있습니다. 복제를 3으로 두었어도 팔로워 둘이 느려져 ISR에서 빠지면 ISR은 리더 하나입니다. 이때 `acks=all`은 리더 하나만 받아도 성공을 돌려주고 그 리더가 죽으면 메시지를 잃습니다. `min.insync.replicas=2`로 두면 ISR이 2개 미만일 때 쓰기를 거부해서 가용성을 내주고 내구성을 지킵니다. 문서가 전형적인 구성으로 드는 것이 복제 3, `min.insync.replicas=2`, `acks=all`입니다.

`default.replication.factor`와 `num.partitions`의 브로커 기본값은 둘 다 1입니다. 토픽을 자동 생성하게 두면 복제 없는 토픽이 생깁니다.

## 6. 중국과 국내 빅테크 사례

### 6-1. 복제본을 늘리거나 옮길 때

| 회사 | 겪은 일과 대응 |
|---|---|
| 快手(2019) | 하루 수조 건, 피크 초당 1억 건 이상. 브로커를 늘릴 때 새 복제본이 가장 오래된 오프셋부터 복사하느라 디스크 사용률이 계속 가득 차고 produce의 P999 지연이 급등했습니다. 최신 오프셋부터 복제하되 모든 컨슈머가 따라잡을 때까지 기다렸다가 ISR에 넣도록 고쳐(KAFKA-8328), 저녁 피크에 확장해도 영향이 없었다고 적었습니다 |
| vivo(2021) | Kafka 2.1.1의 파티션 재배치 도구는 직렬로만 돌고 시작하면 멈출 수 없어서(2.6.0에서 해결) 증분 이동과 이동 중단을 직접 넣었습니다. 리더 자동 재배치(`auto.leader.rebalance.enable`)는 제어할 수 없다며 끄라고 권합니다 |
| Meituan(2022) | 전체 서버 15,000대 이상, 단일 클러스터 최대 2,000대 이상, 피크 초당 4억 건 이상. ISR 안의 팔로워와 ISR 밖의 팔로워가 서로 다른 fetcher를 쓰게 나눠, 뒤처진 복제본의 따라잡기 읽기가 ISR의 실시간 복제를 방해하지 않게 했습니다 |
| ByteDance(2024) | Kafka는 재시작, 교체, 확장, 축소가 모두 데이터 복사와 리더 전환을 동반해 느리고 I/O가 커서 피크에 확장으로 대응하지 못했습니다. 저장을 분산 파일시스템에 맡기고 브로커를 상태 없는 계산 층으로 만든 자체 메시지 큐(BMQ)로 옮겼고 이 구조에서는 ISR 관리가 필요 없다고 적었습니다. 95% 이상의 업무가 BMQ로 옮겼습니다 |

5절의 ISR과 2-2절의 파티션은 운영에서 "옮길 때 무엇이 느려지는지"로 나타납니다. 브로커에 데이터가 붙어 있는 구조라 브로커를 바꾸면 데이터를 옮겨야 합니다.

### 6-2. 파티션이 많아지면

Alibaba 중간件팀의 2016년 글 "Kafka vs RocketMQ—— Topic数量对单机性能的影响"(서버 1대, 7200rpm HDD, Kafka 0.8.2, 128바이트 메시지, 토픽당 파티션 8개)은 토픽을 64개에서 256개로 늘리자 Kafka의 처리량이 98.37% 떨어졌다고 적었습니다. 파티션마다 물리 파일이 따로 있어 디스크 I/O가 경쟁하기 때문이라고 설명합니다. RocketMQ 개발사가 쓴 옛 버전 비교라는 점을 감안해야 하지만 8절 Q&A의 "파티션은 브로커의 파일을 늘린다"를 숫자로 보여 줍니다.

### 6-3. 국내: 파티션 키, 리밸런스, 데이터센터 이중화

- **카카오페이**(2024): 은행 점검 시간이 끝나면 송금하는 지연이체에서 사용자 ID를 레코드 키로 써서 한 사용자의 송금을 같은 파티션에 모아 순서대로 처리했습니다(2-1절). 파티션 수는 줄일 수 없어(InvalidPartitionsException) 신중히 정했다고 적었습니다. 컨슈머 2→3개, `max.poll.records` 1→20, 처리 스레드 1→10으로 바꿔 분당 91건이 728건이 됐습니다.
- **컬리**(2022)와 **우아한형제들**(2025): 4-3절과 같은 원인입니다. 컬리는 500건을 5분 안에 처리하지 못해 리밸런스가 반복되자 `max.poll.records`를 1로 낮추고 배치 리스너로 처리량을 되찾았습니다. 우아한형제들은 30분 넘게 걸리는 작업에서 리밸런스로 같은 엑셀 파일이 여러 번 발송되자 결국 Kafka 대신 DB 기반 작업 큐로 옮겼습니다.
- **카카오**(2022): 담당자가 없는 파이프라인에서 파티션 수보다 많은 컨슈머가 실행되는 자원 낭비가 있었다고 적었습니다(4-1절의 노는 컨슈머).
- **토스증권**(2025): 데이터센터 이중화에서 두 데이터센터에 걸친 하나의 클러스터(stretched cluster)를 버렸습니다. 데이터센터 사이 네트워크가 끊기면 split-brain으로 가용성을 지킬 수 없고 복제가 끝나야 응답하므로 데이터센터 사이 지연만큼 느려지기 때문입니다. 5절의 `acks=all`이 ISR 전원을 기다린다는 것이 데이터센터 사이에서는 그대로 지연이 됩니다. 대신 데이터센터마다 클러스터를 두고 양방향으로 미러링했습니다.
- **올리브영**(2024): 브로커를 한 대씩 재부팅하는 MSK 패치(약 4시간)에 대비해 복제 3, `min.insync.replicas=2`로 구성했습니다(5절의 전형적 구성).

## 7. 범위와 한계

- 기본값은 Kafka 4.3 공식 문서(4.1과 같음) 기준입니다.
- 2-2절의 키 이동 비율은 `user-N` 형태의 키 1만 개로 계산했습니다. 키 모양에 따라 정확한 비율은 달라지지만 파티션 수가 n에서 m으로 바뀔 때 대부분의 키가 옮겨 간다는 결론은 나머지 연산에서 나옵니다.
- 4-1절의 컨슈머 배정은 단순 라운드로빈으로 흉내 냈습니다. 실제 할당 전략(Range, CooperativeSticky, 서버 측 uniform)은 배정 결과가 다를 수 있지만 파티션보다 많은 컨슈머가 노는 것은 같습니다.
- KIP-429, KIP-345, KIP-848, KIP-932 원문은 직접 열지 않고 공식 문서와 업그레이드 노트로 확인했습니다.
- 공식 설계 문서에서 high watermark를 정의한 문단은 찾지 못해 다루지 않았습니다.

## 8. 헷갈렸던 것

**Q. 파티션을 많이 만들어 두면 안전하지 않나요?**

Confluent의 2020년 측정에서는 클러스터의 파티션을 108개에서 7,200개까지 늘리자 다른 작은 토픽의 p99 끝에서 끝까지 지연이 선형으로 늘었습니다. 파티션은 브로커의 파일, 복제 요청, 메타데이터를 늘립니다. 처음부터 넉넉히 잡되 필요한 처리량과 컨슈머 수에서 계산해 잡습니다.

**Q. 리밸런스가 일어나면 메시지를 잃나요?**

보통은 중복이 생깁니다. 처리는 했는데 오프셋을 커밋하기 전에 파티션이 다른 컨슈머로 가면, 새 컨슈머가 마지막으로 커밋된 위치부터 다시 읽습니다. 그래서 처리를 멱등하게 만들거나, 처리 결과와 오프셋을 함께 커밋하는 방법을 씁니다.

**Q. 컨슈머 그룹을 서버마다 다르게 주면요?**

그룹이 다르면 각 그룹이 토픽 전체를 따로 읽습니다. 우아한형제들 글의 이벤트 버스가 이 방식으로, 모든 서버가 같은 이벤트를 받아야 할 때 서버마다 다른 그룹 ID를 씁니다. 일을 나누는 것이 목적이면 같은 그룹, 모두에게 알리는 것이 목적이면 다른 그룹입니다.

## 참고 자료

공식 문서와 소스
- Apache Kafka 4.3, [Introduction](https://kafka.apache.org/43/getting-started/introduction/), [Design](https://kafka.apache.org/43/design/design/), [Log implementation](https://kafka.apache.org/43/implementation/log/)
- Apache Kafka 4.3, [Topic configs](https://kafka.apache.org/43/generated/topic_config.html), [Consumer configs](https://kafka.apache.org/43/generated/consumer_config.html), [Consumer rebalance protocol](https://kafka.apache.org/43/operations/consumer-rebalance-protocol/)
- [Apache Kafka 4.0 릴리스 공지](https://kafka.apache.org/blog/2025/03/18/apache-kafka-4.0.0-release-announcement/)
- [KIP-480: Sticky Partitioner](https://cwiki.apache.org/confluence/display/KAFKA/KIP-480%3A+Sticky+Partitioner), [KIP-794: Strictly Uniform Sticky Partitioner](https://cwiki.apache.org/confluence/display/KAFKA/KIP-794%3A+Strictly+Uniform+Sticky+Partitioner)
- Apache Kafka, [BuiltInPartitioner.java](https://github.com/apache/kafka/blob/trunk/clients/src/main/java/org/apache/kafka/clients/producer/internals/BuiltInPartitioner.java), [UtilsTest.java](https://github.com/apache/kafka/blob/trunk/clients/src/test/java/org/apache/kafka/common/utils/UtilsTest.java)

글과 사례
- Jay Kreps, [The Log: What every software engineer should know about real-time data's unifying abstraction](https://engineering.linkedin.com/distributed-systems/log-what-every-software-engineer-should-know-about-real-time-datas-unifying), LinkedIn, 2013([보관본](https://web.archive.org/web/2024/https://engineering.linkedin.com/distributed-systems/log-what-every-software-engineer-should-know-about-real-time-datas-unifying))
- Jun Rao, [How to choose the number of topics/partitions in a Kafka cluster?](https://www.confluent.io/blog/how-choose-number-topics-partitions-kafka-cluster/), 2015
- 사람인, [kafka 설정을 사용한 문제해결](https://saramin.github.io/2019-09-17-kafka/), 2019
- 넥스트리, [Kafka Rebalancing과 메시지 처리 병목 개선](https://www.nextree.io/kafka-rebalancinggwa-mesiji-ceori-byeongmog-gaeseon/), 2026
- 우아한형제들, [우리 팀은 카프카를 어떻게 사용하고 있을까](https://techblog.woowahan.com/17386/), 2024
- 실습 코드: [labs/de-study/ch11](https://github.com/dj258255/IT-Oasis/tree/main/labs/de-study/ch11)

중국과 국내 빅테크 사례
- 赵健博(快手), [快手万亿级别 Kafka 集群应用实践与技术演进之路](https://www.infoq.cn/article/q0o*qzlqiay31mwiobjh), 2019
- vivo互联网服务器团队, [Kafka万亿级消息实战](https://www.cnblogs.com/vivotech/p/14776819.html), 2021
- Meituan, [Kafka在美团数据平台的实践](https://tech.meituan.com/2022/08/04/the-practice-of-kafka-in-the-meituan-data-platform.html), 2022
- 火山引擎 云原生计算(ByteDance), [一文了解字节跳动消息队列演进之路](https://developer.volcengine.com/articles/7325343303150272539), 2024
- 以夕(Alibaba), [Kafka vs RocketMQ—— Topic数量对单机性能的影响](http://jm.taobao.org/2016/04/07/kafka-vs-rocketmq-topic-amout/), 2016
- elmo.wiz, [지연이체 서비스 개발기: 은행 점검 시간 끝나면 송금해 드릴게요! (feat. 발표 후기)](https://tech.kakaopay.com/post/ifkakao2024-delayed-transfer/), 카카오페이, 2024
- 서민우, [컬리 검색이 카프카를 들여다본 이야기 1](https://helloworld.kurly.com/blog/search-system-with-kafka-1/), 컬리, 2022
- 박민규, [장시간 비동기 작업, Kafka 대신 RDB 기반 Task Queue로 해결하기](https://techblog.woowahan.com/23625/), 우아한형제들, 2025
- cory.doras, [제네시스 - 광고추천팀의 카프카 기반 스트리밍 데이터 플랫폼](https://tech.kakao.com/posts/506), 카카오, 2022
- 강병수, [토스증권 Apache Kafka 데이터센터 이중화 구성 #1](https://toss.tech/article/kafka-distribution-1), 토스, 2025
- 시나브로우, [Kafka 메시지 중복 및 유실 케이스별 해결 방법](https://oliveyoung.tech/2024-10-16/oliveyoung-scm-oms-kafka/), 올리브영, 2024

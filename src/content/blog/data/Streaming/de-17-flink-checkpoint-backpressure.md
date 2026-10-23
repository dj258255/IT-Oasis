---
title: '[DE Ch-17] 체크포인트와 백프레셔: 간격은 재처리량과 결과가 보이는 시점을 함께 정한다'
description: Flink는 배리어를 데이터 사이에 흘려 전체 상태의 스냅샷을 찍고 장애가 나면 마지막 스냅샷부터 다시 처리합니다. exactly-once 싱크는 체크포인트가 끝날 때 결과를 커밋하므로 간격이 곧 결과가 보이기까지의 지연이 됩니다. 간격별 가시성 지연과 장애 때 재처리량을 시뮬레이션으로 세고 백프레셔가 배리어를 늦춰 체크포인트가 길어지는 경로와 unaligned 체크포인트, buffer debloating, buffer timeout을 Flink 2.3 문서로 정리합니다.
date: 2026-10-19T00:00:00.000Z
tags:
  - Data Engineering
  - Flink
  - Checkpoint
  - Backpressure
  - Exactly-once
  - Fault Tolerance
category: data/Streaming
topics:
  - pipeline
  - messaging
draft: false
series: "DE 공부"
seriesOrder: 17
---

## 결론부터

1. Flink의 체크포인트는 Chandy-Lamport 알고리즘에서 출발했습니다. 소스가 데이터 사이에 배리어를 넣고 배리어가 지나가는 연산자마다 상태를 저장합니다. 장애가 나면 마지막으로 끝난 체크포인트의 상태와 소스 위치로 돌아가 다시 처리합니다.
2. exactly-once 싱크는 체크포인트가 끝날 때 결과를 커밋합니다. 시뮬레이션에서 간격 1초면 결과가 평균 1.0초 뒤에 보였고 60초면 평균 30.5초 뒤에 보였습니다. 장애 때 다시 처리하는 양도 1초 간격 약 1천 건에서 60초 간격 약 3만 건으로 늘었습니다.
3. 입력이 여러 개인 연산자는 모든 입력에서 배리어가 올 때까지 먼저 온 입력을 멈추고 기다립니다(정렬). 백프레셔로 데이터가 느리게 흐르면 배리어도 느리게 흘러 체크포인트가 길어지거나 시간 초과로 실패합니다.
4. unaligned 체크포인트는 배리어가 앞의 데이터를 추월하게 하고 그 데이터까지 저장해서 체크포인트 시간을 처리량과 분리합니다. buffer debloating은 흐르는 중인 데이터의 양을 줄여 배리어가 빨리 지나가게 합니다. 둘 다 기본으로 꺼져 있습니다.

---

## 1. 상태가 있는 스트림 처리의 장애 복구

Ch-15의 윈도 집계와 Ch-16의 interval join은 상태를 들고 있습니다. 1분 동안 센 조회 수, 아직 결제를 기다리는 주문입니다. 프로세스가 죽으면 이 상태가 사라집니다. Kafka에서 처음부터 다시 읽을 수도 있지만 며칠치를 다시 처리해야 할 수 있습니다.

체크포인트는 주기적으로 상태 전체의 스냅샷을 저장해 두는 장치입니다. 장애가 나면 마지막 스냅샷의 상태를 불러오고 그 스냅샷을 찍던 순간의 Kafka 오프셋부터 다시 읽습니다.

게임의 세이브와 비슷합니다. 세이브 파일에는 "몇 번째 스테이지까지 깼는지"(Kafka 오프셋)와 "그때 가진 아이템"(연산자 상태)이 함께 들어 있어야 합니다. 둘 중 하나만 맞으면 다시 불러왔을 때 아이템이 두 번 생기거나 사라집니다. 이 글의 앞부분(2~3절)은 분산된 여러 연산자에서 이 짝을 어떻게 맞추는지와 그 대가로 결과가 언제 보이는지를 보고 뒷부분(4~5절)은 하류가 느릴 때 이 장치가 어떻게 흔들리는지를 봅니다.

이 글에서 말하는 상태와 연산자를 짚고 가겠습니다. 연산자는 `map`, `window`, `join`처럼 Flink 잡을 이루는 처리 단계 하나이고 실제로는 병렬도만큼 복제되어 여러 서브태스크로 돕니다. 상태는 연산자가 이벤트와 이벤트 사이에 기억해야 하는 값입니다. "지금까지 센 주문 수", "아직 결제를 못 만난 주문 목록", 소스가 Kafka의 어디까지 읽었는지(오프셋)가 모두 상태입니다.

## 2. 배리어로 찍는 스냅샷

### 2-1. 원리

Flink 문서는 체크포인트가 분산 스냅샷을 위한 Chandy-Lamport 알고리즘에서 영감을 받았다고 적습니다. Carbone 외의 2015년 논문 "Lightweight Asynchronous Snapshots for Distributed Dataflows"는 이 방식을 ABS(Asynchronous Barrier Snapshotting)로 정리하고 순환이 없는 데이터 흐름에서는 연산자 상태만 저장하면 된다고 설명합니다. 전체를 멈추고 스냅샷을 찍는 방식과 달리 처리를 멈추지 않습니다.

```
소스 ──[레코드][레코드]|배리어 n|[레코드][레코드]──→ 연산자 ──→ 싱크
                       └ 배리어 n 앞의 레코드까지 반영한 상태 = 스냅샷 n
```

- 소스가 Kafka 오프셋을 기록하고 데이터 사이에 배리어 n을 넣습니다.
- 배리어는 레코드를 앞지르지 않고 데이터와 같은 줄로 흐릅니다.
- 연산자는 배리어를 받으면 자기 상태를 저장하고 배리어를 하류로 넘깁니다.
- 싱크까지 배리어가 도착하고 모든 상태 저장이 끝나면 체크포인트 n이 완료됩니다.

왜 배리어가 필요한지는 배리어 없이 찍어 보면 보입니다. 주문 수를 세는 연산자 하나가 있고 소스가 Kafka에서 주문을 읽어 넘긴다고 합시다. 소스와 연산자가 "각자 지금 상태를 저장하라"는 신호를 동시에 받았다고 해 봅시다.

| 시점 | 소스가 읽은 오프셋 | 연산자가 센 수 | 저장된 값 |
|---|---|---|---|
| 신호 도착 | 100 | 97(98~100번은 아직 네트워크 버퍼 안) | 소스 100, 연산자 97 |
| 장애 후 복구 | 101부터 다시 읽음 | 97에서 시작 | 98~100번 주문 3건이 영영 안 세어짐 |

반대로 소스가 먼저 저장하고 연산자가 한참 뒤에 저장해서 연산자 쪽이 앞서 있으면 같은 주문이 두 번 세어집니다. 두 값이 "같은 순간"을 가리키지 않아서 생기는 일입니다. 배리어를 쓰면 소스는 오프셋 100을 저장하고 100번 뒤에 배리어를 끼워 보냅니다. 연산자는 배리어를 받은 순간에 상태를 저장하는데 그때는 98~100번이 이미 배리어 앞에서 처리된 뒤라 센 수가 정확히 100입니다. 배리어가 "여기까지가 스냅샷 n"이라는 선을 데이터 흐름 안에 그어서 모든 연산자가 같은 선에서 저장하게 만드는 셈입니다. 전체를 멈추지 않고도 이 선을 맞출 수 있다는 것이 Chandy-Lamport 계열 알고리즘의 요점입니다.

### 2-2. 정렬이 지연을 만든다

입력이 둘 이상인 연산자(join, union 뒤의 연산자)는 입력마다 배리어가 다른 시각에 도착합니다. 문서는 이런 연산자가 배리어에 맞춰 입력들을 정렬해야 하고 이 정렬 단계가 지연을 늘릴 수 있다고 적습니다. 배리어를 먼저 받은 입력은 다른 입력의 배리어가 올 때까지 읽지 않습니다. 그 입력의 배리어 뒤 데이터를 처리하면 스냅샷 n에 다음 구간의 데이터가 섞이기 때문입니다.

Ch-16의 주문과 결제를 잇는 join 연산자로 순서대로 따라가 보겠습니다.

![join 연산자의 두 입력. 주문 입력에는 배리어 n이 먼저 도착해 그 뒤 주문들이 막혀 쌓이고 결제 입력은 배리어 n이 올 때까지 계속 처리된다. 결제 쪽 배리어가 도착하면 상태를 저장하고 배리어를 하류로 보낸 뒤 막혔던 주문 입력을 다시 읽는다](/uploads/data/de-17-flink-checkpoint-backpressure/alignment.svg)

1. 주문 입력에 배리어 n이 먼저 도착합니다. join은 주문 입력을 더 읽지 않습니다. 그 뒤의 주문은 입력 버퍼에 쌓입니다.
2. 결제 입력은 계속 읽습니다. 결제 쪽 배리어 n 앞에 있는 결제는 모두 스냅샷 n에 들어가야 하기 때문입니다.
3. 결제 입력에도 배리어 n이 오면 두 입력이 같은 선에 섰습니다(정렬 완료). 이 순간 상태를 저장하고 배리어 n을 하류로 보냅니다.
4. 막아 두었던 주문 입력을 다시 읽습니다.

1번에서 주문 입력을 막지 않고 배리어 뒤의 주문 A를 처리했다고 해 봅시다. 주문 A가 상태에 들어간 채로 스냅샷 n이 저장됩니다. 그런데 소스가 저장한 오프셋은 배리어 n 위치라서 복구하면 주문 A를 다시 읽습니다. 상태에 이미 있는 주문 A가 한 번 더 들어가 중복이 생깁니다. 막고 기다리는 시간이 2번의 길이, 곧 두 입력의 배리어 도착 시각 차이만큼이고 이것이 정렬 지연입니다.

at-least-once 모드는 이 정렬을 건너뜁니다. 정렬하지 않으니 배리어 뒤의 레코드가 먼저 처리되어 스냅샷에 섞이고 복구하면 그 레코드가 중복으로 다시 처리됩니다.

## 3. 결과는 체크포인트가 끝날 때 보인다

### 3-1. 두 단계 커밋

Ch-13에서 Flink의 Kafka 싱크가 체크포인트에 맞춰 Kafka 트랜잭션을 커밋한다고 했습니다. Flink 2018년 글은 체크포인트 시작이 사전 커밋 단계이고 체크포인트가 끝나면 JobManager가 완료를 알려 싱크가 커밋한다고 설명합니다. 사전 커밋이 하나라도 실패하면 나머지도 모두 abort합니다. Flink KafkaSink 문서는 이렇게 하면 `read_committed` 컨슈머 기준으로 중복이 없지만 레코드가 보이는 시점이 사실상 체크포인트가 저장될 때까지 늦어지니 체크포인트 간격을 그에 맞게 조정하라고 적습니다.

한 사이클을 순서대로 적으면 이렇습니다.

1. 체크포인트 n-1이 끝난 뒤 싱크는 Kafka 트랜잭션 하나를 열고 결과를 그 안에 씁니다. 이 레코드는 Kafka에 들어가 있지만 `read_committed`로 읽는 컨슈머에게는 아직 안 보입니다.
2. 배리어 n이 싱크에 도착하면 싱크는 버퍼를 비우고 트랜잭션을 커밋 직전 상태로 만듭니다(사전 커밋). 그리고 다음 결과를 담을 새 트랜잭션을 엽니다.
3. 모든 연산자의 스냅샷 n이 저장되면 JobManager가 "체크포인트 n 완료"를 알립니다. 싱크는 그때 2번의 트랜잭션을 커밋하고 컨슈머가 그 결과를 봅니다.
4. 3번 전에 장애가 나면 그 트랜잭션은 abort되고 잡은 체크포인트 n-1부터 다시 처리합니다. 커밋되지 않은 결과는 아무도 본 적이 없으니 다시 써도 중복이 아닙니다.

1번에서 쓴 결과는 3번이 되어야 보입니다. 3-2절은 이 기다림이 얼마나 되는지를 셉니다.

### 3-2. 재현: 간격이 정하는 두 가지

- 레코드가 초당 1,000건 고르게 들어옵니다(600초).
- 체크포인트는 간격마다 시작해서 0.5초 뒤 끝나고 끝나는 순간 그때까지의 결과가 보입니다.
- 장애는 무작위 시각에 한 번 나고(1,000번 반복해 평균), 마지막으로 끝난 체크포인트 이후의 레코드를 다시 처리합니다.
- 코드는 [labs/de-study/ch17](https://github.com/dj258255/IT-Oasis/tree/main/labs/de-study/ch17)의 `checkpoint_visibility.py`입니다.

| 간격 | 결과가 보이기까지 평균 | p99 | 장애 때 다시 처리하는 레코드(평균) |
|---|---|---|---|
| 1초 | 1.00초 | 1.49초 | 996건 |
| 10초 | 5.50초 | 10.40초 | 5,334건 |
| 60초 | 30.50초 | 59.90초 | 30,617건 |

평균 가시성 지연은 간격의 절반에 체크포인트 시간을 더한 값입니다. 체크포인트 바로 뒤에 들어온 레코드는 간격만큼 기다리니 p99는 간격에 가깝습니다. 재처리량도 간격에 비례합니다.

표의 숫자는 버스 정류장으로 계산할 수 있습니다. 버스가 10분마다 오고 손님이 아무 때나 정류장에 오면 평균 5분을 기다립니다. 여기서 버스는 체크포인트 완료이고 손님은 레코드입니다. 간격 10초면 레코드는 0~10초를 기다린 뒤 체크포인트 시간 0.5초를 더 기다리니 평균 5 + 0.5 = 5.5초입니다. 기다림이 0.5초에서 간격 + 0.5초 사이에 고르게 퍼져 있어서 p99는 0.5 + 0.99 × 간격이고 60초면 59.9초입니다. 장애 때 다시 처리하는 양도 같은 계산입니다. 장애가 아무 때나 나면 마지막 완료 체크포인트로부터 평균 "간격의 절반 + 0.5초"만큼 지나 있고 초당 1,000건을 곱하면 1초 간격에서 약 1,000건, 60초 간격에서 약 30,500건입니다. 표의 5,334건과 30,617건이 이론값 5,500건, 30,500건과 조금 다른 것은 장애 시각을 1,000번만 뽑아 평균을 냈기 때문입니다.

간격을 줄이면 둘 다 좋아지지만 체크포인트를 자주 찍는 비용(상태 저장, 원격 저장소 쓰기, 정렬 대기)이 늘어납니다. Ch-13의 Uber 사례가 체크포인트 간격이 지연의 병목이라 기본 10분 대신 2분을 썼다는 것이 이 표의 실제 판입니다. 하이퍼커넥트는 2025년 실시간 추천용 Flink 스트림 조인 글에서 Kafka 싱크의 exactly-once가 체크포인트 주기마다 메시지를 발행해 실시간성이 크게 떨어진다며 쓰지 않고 Redis로 중복을 제거하는 쪽을 골랐습니다.

### 3-3. 체크포인트 설정

Flink 2.3 설정 문서의 기본값입니다.

| 설정 | 기본값 | 뜻 |
|---|---|---|
| `execution.checkpointing.interval` | 없음 | 체크포인트는 기본으로 꺼져 있다 |
| `execution.checkpointing.mode` | EXACTLY_ONCE | AT_LEAST_ONCE면 정렬을 건너뛴다 |
| `execution.checkpointing.timeout` | 10분 | 이 안에 끝나지 않으면 실패 |
| `execution.checkpointing.min-pause` | 0ms | 체크포인트 사이 최소 간격 |
| `execution.checkpointing.max-concurrent-checkpoints` | 1 | 동시에 진행할 수 있는 체크포인트 수 |
| `execution.checkpointing.tolerable-failed-checkpoints` | 0 | 몇 번 실패까지 잡을 계속 돌릴지 |
| `state.backend.type` | hashmap | 상태를 JVM 힙에 둔다. rocksdb, forst도 있다 |
| `execution.checkpointing.incremental` | false | 직전 체크포인트 이후 바뀐 것만 저장 |

상태 백엔드 문서는 힙에 두는 hashmap과 디스크에 두는 RocksDB를 성능과 확장성의 선택으로 설명합니다. RocksDB는 직렬화와 디스크 접근 때문에 한 자릿수 배 느리지만 메모리보다 큰 상태를 다룰 수 있고 증분 체크포인트를 지원합니다. Ch-16의 60분 interval join처럼 상태가 커지면 증분 체크포인트가 체크포인트 시간을 줄입니다.

체크포인트와 세이브포인트는 복구 로그와 백업의 관계에 비유됩니다. 체크포인트는 Flink가 만들고 관리하고 지우는 장애 복구용이고 세이브포인트는 사용자가 만들고 지우는 버전 업그레이드나 잡 변경용입니다.

## 4. 백프레셔

### 4-1. 하류가 느리면 상류가 멈춘다

싱크가 느리면(외부 DB 쓰기가 밀리면) 그 앞 연산자의 출력 버퍼가 찹니다. Flink는 1.5부터 credit 기반 흐름 제어를 씁니다. 받는 쪽이 비어 있는 버퍼 수만큼 credit을 주고 보내는 쪽은 credit만큼만 보냅니다. 받는 쪽이 느리면 credit이 줄고 보내는 쪽이 멈추고 이게 소스까지 거슬러 올라가 소스가 Kafka에서 덜 읽습니다. 데이터를 잃지 않고 속도를 맞추는 장치입니다.

택배 상자를 받는 창고로 생각하면 됩니다. 창고는 "빈 선반이 3칸 있다"고 미리 알려 주고 보내는 쪽은 상자를 3개까지만 보냅니다. 창고가 상자를 정리해 선반이 비면 다시 "2칸 비었다"고 알립니다. 창고가 바빠 선반이 안 비면 보내는 쪽은 상자를 들고 기다리고 그 보내는 쪽에 상자를 넘기던 곳도 차례로 멈춥니다. 이 "빈 칸 수"가 credit이고 상자가 네트워크 버퍼입니다.

1.5 이전에는 이렇게 칸 수를 알려 주지 않고 TCP의 흐름 제어에 기댔습니다. 문제는 두 TaskManager 사이에 TCP 연결 하나를 여러 서브태스크가 함께 쓴다는 데 있었습니다. Flink 2019년 네트워크 스택 글의 예처럼 받는 쪽 서브태스크 하나만 느려도 그 연결 전체가 막혀 옆의 멀쩡한 서브태스크까지 데이터를 못 받았습니다. credit은 서브태스크(채널)마다 따로 세기 때문에 느린 채널만 멈춥니다. 같은 글은 이 덕분에 배리어가 쌓인 버퍼 뒤에서 덜 기다리게 되어 체크포인트 정렬도 나아졌다고 적습니다.

모니터링 문서는 태스크마다 초당 몇 ms를 어떻게 보냈는지 세 지표로 보여 줍니다(합이 약 1,000ms).

| 지표 | 뜻 |
|---|---|
| `backPressuredTimeMsPerSecond` | 출력 버퍼가 없어 기다린 시간 |
| `busyTimeMsPerSecond` | 실제로 일한 시간 |
| `idleTimeMsPerSecond` | 입력이 없어 논 시간 |

웹 UI는 백프레셔 비율 0~10%를 OK, 10~50%를 LOW, 50~100%를 HIGH로 표시합니다. 병목은 보통 HIGH인 태스크들의 바로 하류에 있는 busy가 높은 태스크입니다.

예를 들어 "Kafka 소스 → 파싱 → 주문 DB 싱크" 잡에서 세 지표가 이렇게 나왔다고 해 봅시다(설명을 위한 가상의 값입니다).

| 태스크 | backPressured | busy | idle | 읽는 법 |
|---|---|---|---|---|
| Kafka 소스 | 800ms | 150ms | 50ms | 대부분 기다림. 막힌 줄의 뒤쪽에 선 피해자 |
| 파싱 | 750ms | 200ms | 50ms | 역시 기다림 |
| 주문 DB 싱크 | 0ms | 950ms | 50ms | 기다리지 않고 쉬지도 않음. 여기가 병목 |

백프레셔가 HIGH인 태스크는 "내 뒤가 막혀서 기다린다"는 뜻이라 원인이 아닙니다. HIGH가 끝나는 지점 바로 뒤에서 busy가 1,000ms에 가까운 태스크를 찾으면 됩니다. 여기서는 싱크의 DB 쓰기를 묶어 보내거나 병렬도를 늘리는 쪽으로 손을 댑니다.

busy가 높다는 것까지는 알아도 그 안에서 무엇이 느린지는 이 지표로 안 보입니다. 하이퍼커넥트의 2025년 글은 연산자마다 사용자 코드가 도는 시간과 그 밖의 시간(직렬화, 네트워크)을 나눠 재고 느린 연산자는 flame graph로 열어 봤더니 Flink가 일반 클래스에 쓰는 Kryo 직렬화기에서 대부분의 시간을 쓰고 있었다고 적었습니다. 데이터 클래스를 POJO 직렬화기가 쓰이도록 바꾸는 것이 해법이었습니다. 6-5절 토스 사례의 Kryo에서 POJO로의 전환과 같은 지점입니다.

### 4-2. 백프레셔가 체크포인트를 늦춘다

배리어는 데이터를 앞지르지 않으니 데이터가 느리게 흐르면 배리어도 느리게 흐릅니다. Flink의 2020년 글 "From Aligned to Unaligned Checkpoints - Part 1"은 백프레셔가 없으면 배리어가 몇 ms 만에 흐르고 정렬되지만 백프레셔 아래에서는 체크포인트가 오래 걸리거나 시간 초과로 실패할 수 있다고 적습니다. 문서의 "Checkpointing under backpressure"는 백프레셔가 심하면 체크포인트 시간의 대부분이 배리어를 전파하는 시간이라고 설명합니다.

체크포인트가 실패하면 3-2절의 표가 나빠집니다. 마지막 성공 체크포인트가 오래전이 되어 장애 때 다시 처리할 양이 늘고 exactly-once 싱크의 결과도 그만큼 늦게 보입니다. 백프레셔가 지연 문제이면서 장애 복구 문제가 되는 이유입니다.

### 4-3. 대응: unaligned 체크포인트와 buffer debloating

| 방법 | 동작 | 기본값과 제약 |
|---|---|---|
| unaligned 체크포인트(`execution.checkpointing.unaligned.enabled`) | 배리어가 버퍼에 쌓인 데이터를 앞질러 싱크까지 빨리 가고 앞지른 데이터를 스냅샷에 함께 저장한다. 체크포인트 시간이 처리량과 무관해진다 | 꺼짐. EXACTLY_ONCE이고 동시 체크포인트가 1일 때만 쓸 수 있다. 저장하는 데이터가 늘어난다 |
| `aligned-checkpoint-timeout` | 정렬로 시작했다가 정해진 시간이 넘으면 unaligned로 바꾼다 | 기본 0ms(켜면 처음부터 unaligned) |
| buffer debloating(`taskmanager.network.memory.buffer-debloat.enabled`) | 흐르는 중인 데이터가 목표 시간(기본 1초) 안에 소비되도록 버퍼 크기를 자동으로 줄인다 | 꺼짐. 1.14 도입 |

네트워크 버퍼 문서는 흐르는 중인 데이터가 많을수록 처리량은 높고 안정적이지만 체크포인트 시간이 길어진다고 적습니다. buffer debloating은 이 양을 줄여 배리어가 빨리 지나가게 하는 쪽입니다.

둘의 차이를 마트 계산대 줄로 비유해 보겠습니다. 배리어는 줄 맨 뒤에 선 "마감 안내판"이고 계산대가 느려 줄이 길면 안내판이 계산대에 닿기까지 오래 걸립니다.

- **정렬 체크포인트**: 안내판이 줄을 따라 차례로 나아갑니다. 줄이 길면 그만큼 기다립니다.
- **unaligned 체크포인트**: 안내판이 줄을 건너뛰어 바로 계산대로 갑니다. 대신 건너뛴 손님들(버퍼에 있던 레코드)의 명단을 스냅샷에 함께 적어 둡니다. 복구할 때는 상태를 불러온 뒤 이 명단의 레코드부터 다시 흘려보냅니다. 그래서 체크포인트가 빨리 끝나는 대신 크기가 커집니다.
- **buffer debloating**: 줄 자체를 짧게 유지합니다. 줄이 짧으면 안내판이 차례대로 가도 금방 닿습니다. 목표 시간 1초는 "지금 줄에 선 손님을 1초 안에 다 계산할 수 있을 만큼만 줄을 세운다"는 뜻입니다.

## 5. 지연 쪽 손잡이: buffer timeout

Flink는 레코드를 하나씩 네트워크로 보내지 않고 버퍼에 모아 보냅니다. Ch-12의 프로듀서 linger.ms와 같은 구조입니다. 버퍼가 차지 않아도 `execution.buffer-timeout.interval`(기본 100ms)이 지나면 보냅니다.

셔틀버스로 보면 됩니다. 버스는 자리가 다 차면 바로 출발하고 덜 차도 100ms가 지나면 출발합니다. 손님이 많은 시간에는 금방 차서 기다림이 짧고 한산한 시간에는 손님이 최대 100ms를 버스 안에서 기다립니다. 그래서 buffer timeout은 트래픽이 적은 채널에서 지연의 상한 노릇을 합니다. 체크포인트 배리어는 이 버스를 기다리지 않고 바로 내보냅니다. 다만 2019년 네트워크 스택 글은 이 타이머가 강한 보장은 아니고 백프레셔가 걸린 채널에서는 효과가 없다고 적습니다. 버스가 출발하려 해도 받는 쪽 credit이 없으면 못 갑니다.

DataStream 문서의 설명입니다.

- 처리량을 최대로 하려면 버퍼가 찰 때만 보내게 합니다(timeout 끄기).
- 지연을 줄이려면 0에 가까운 값(5~10ms)을 줍니다. 0은 심각한 성능 저하를 일으킬 수 있으니 피합니다.
- 입력이 충분히 빠르지 않으면 버퍼가 늦게 차서 지연 문제가 생깁니다.

Flink 2019년 네트워크 스택 글은 credit 기반 흐름 제어 이후 buffer timeout을 1ms로 줄여도 기본 100ms일 때 처리량의 최대 75%가 나왔다고 적습니다(100노드 × 8슬롯, 로직 없는 벤치마크 잡).

## 6. 중국과 국내 빅테크 사례

### 6-1. 규모

| 회사 | 공개한 규모 |
|---|---|
| Alibaba(2020 双11) | 실시간 계산 피크 초당 40억 건, 초당 7TB. 실시간 잡 35,000개 이상, 클러스터 150만 코어 이상 |
| Meituan(2021) | 잡 약 5만 개, 머신 1.5만 대 이상, 피크 초당 5.4억 건. 큰 잡 하나가 병렬도 5,000, 상태 10TB, TaskManager 1,000개 이상 |
| ByteDance(2022) | TB급 상태를 가진 잡 140개 이상, 단일 잡 최대 상태 60TB |
| ByteDance(2026 논문) | 동시에 도는 스트리밍 잡 70,000개 이상, 슬롯 1,100만 개 이상 |

### 6-2. 큰 상태의 체크포인트가 부딪힌 곳

- **저장소 요청**: Meituan은 큰 잡이 체크포인트를 찍는 동안 HDFS에 RPC 요청을 대량으로 보내 NameNode의 요청 큐가 가득 찼다고 적었습니다. NameNode 묶음을 여러 개 두고 잡을 나눠 붙였습니다. ByteDance는 작은 상태 파일을 메타데이터에 합쳐 넣는 기준(`state.backend.fs.memory-threshold`)을 올려 Map만 있는 잡의 저장소 요청을 병렬도 수만큼에서 1번으로 줄였고 업로드 스레드를 10개보다 많이 두면 NameNode가 버티지 못한다고 경고했습니다.
- **세이브포인트**: Meituan은 세이브포인트를 만드는 데 7분 가까이 걸리는데 증분 체크포인트는 1~2초면 끝나서 세이브포인트 전용 시간 제한을 따로 두었습니다. 세이브포인트 뒤의 첫 증분 체크포인트가 전량 업로드로 돌아가 800GB 가까이 올린 경우도 적었습니다. 3-3절의 체크포인트와 세이브포인트 차이가 운영에서 드러난 모습입니다.
- **하나의 실패가 전체를 멈춤**: ByteDance의 2026년 논문 "StreamShield"는 기존 방식에서 태스크 하나의 실패가 진행 중인 체크포인트 전체를 중단시킨다고 적고 영역(region) 단위 체크포인트를 도입했습니다. 12시간 시험(HDFS 업로드가 5% 확률로 느려짐, 30초 주기)에서 체크포인트 성공률이 53.9%에서 93.5%로 올랐습니다.

### 6-3. 정렬과 흐르는 중인 데이터

ByteDance의 2022년 글은 4-2절의 정렬 문제를 흐르는 중인 버퍼를 줄이는 쪽으로 풀었습니다. 흐르는 중인 버퍼가 상태 자체보다 커지는 경우도 있다고 적고 unaligned 체크포인트를 써도 버퍼가 많으면 저장할 데이터가 커져 비동기 단계가 느려진다고 지적했습니다. 4-3절의 "unaligned는 저장하는 데이터가 늘어난다"와 같은 이야기입니다. 상태 백엔드는 상태 총량 1GB 미만만 힙(FsStateBackend)을 쓰고 나머지는 RocksDB를 권하며 연산자 하나의 RocksDB가 약 15GB를 넘으면 압축이 잦아져 쓰기가 멈춘다고 적었습니다.

Alibaba Cloud의 실시간 계산 Flink 문서는 체크포인트 시간 초과를 이렇게 진단합니다. 동기 단계와 정렬 시간이 길면 정렬이 병목이니 백프레셔부터 풀고 unaligned 체크포인트와 buffer debloating을 쓰고 비동기 단계와 체크포인트 크기가 크면 상태 업로드가 병목이니 병렬도를 늘립니다.

### 6-4. 증분 체크포인트를 더 잘게: changelog

Meituan의 2023년 발표 정리 "基于 Log 的通用增量 Checkpoint 在美团的进展"은 상태 변경을 로그로 계속 올리는 changelog 상태 백엔드를 시험했습니다. 안정적인 체크포인트 간격이 10분에서 10초로 줄었고 기존 체크포인트 대비 CPU 사용률 피크가 40%, 디스크 IO 피크가 29%, 네트워크 출력 피크가 61% 줄었습니다. 대가로 병렬도 4,800인 잡에서 changelog 파일이 기본 설정으로 약 130만 개 생겼고 changelog 쓰기 지연은 p99 약 3초, 최대 약 2분이었습니다. 3-2절에서 간격을 줄이면 가시성 지연과 재처리량이 함께 줄었는데 changelog는 그 간격을 줄이는 방법이고 대신 저장소에 파일과 요청을 늘립니다.

### 6-5. 국내: 토스의 RocksDB 튜닝

토스의 2026년 광고 빈도 제한 글(Ch-16에서 상태 크기를 봤습니다)은 상태 백엔드를 앱마다 튜닝했습니다.

- 분 단위 앱은 쓰기 버퍼를 조정해 블록 캐시 적중률을 62~64%에서 99~100%로 올렸습니다.
- 시간 단위 앱은 분할 인덱스·필터로 쓰기 증폭을 20에서 10으로 낮췄고 Flink가 bits-per-key 설정 14를 10으로 덮어쓰는 현상도 찾았습니다.
- 일 단위 앱은 SST 파일을 160개에서 40개로 줄이고 쓰기 증폭을 30에서 20으로 낮췄습니다.
- changelog를 켜고 체크포인트 2분, 최소 간격 30초로 두어 증분 체크포인트가 약 70MB였고 직렬화를 Kryo에서 POJO로 바꿔 changelog I/O를 60% 줄였습니다.

## 7. 범위와 한계

- 3-2절은 시뮬레이션입니다. 체크포인트 시간을 0.5초로 고정했고 백프레셔로 체크포인트가 길어지는 효과와 체크포인트 비용은 넣지 않았습니다.
- 실제 Flink 잡을 돌려 체크포인트 시간이나 백프레셔를 재지 않았습니다.
- Carbone 외 논문의 평가 수치는 확인하지 못했습니다.
- 상태 백엔드 문서는 hashmap 항목에 큰 상태와 긴 윈도에 권장한다는 문장을 적어 두었는데 같은 문서의 RocksDB 설명과 맞지 않아 인용하지 않았습니다.

## 8. 헷갈렸던 것

**Q. 체크포인트를 1초마다 찍으면 지연도 재처리도 작은데 왜 안 그러나요?**

체크포인트마다 모든 연산자의 상태를 원격 저장소에 씁니다. 상태가 크면 1초 안에 끝나지 않고 끝나기 전에 다음 체크포인트가 밀려 줄을 섭니다. 상태 크기, 증분 체크포인트 여부, 저장소 속도로 가능한 최소 간격이 정해집니다.

**Q. unaligned 체크포인트를 켜면 다 해결되나요?**

백프레셔 아래에서도 체크포인트가 끝나게 해 줄 뿐 백프레셔 자체는 그대로입니다. 버퍼에 쌓인 데이터까지 저장해서 체크포인트가 커지고 복구 때 그 데이터를 다시 흘립니다. 문서는 이렇게 복구할 때 watermark에 대한 암묵적인 보장이 깨질 수 있다고도 적습니다. 원인인 느린 연산자를 찾는 것이 먼저입니다.

**Q. at-least-once 모드로 바꾸면요?**

정렬을 건너뛰어 정렬 지연이 사라지고 싱크도 체크포인트를 기다리지 않고 바로 씁니다. 대신 복구 때 중복이 생기니 받는 쪽이 멱등해야 합니다. 하이퍼커넥트가 고른 쪽이 이 방향입니다.

## 참고 자료

공식 문서
- Apache Flink 2.3, [Stateful Stream Processing](https://nightlies.apache.org/flink/flink-docs-stable/docs/concepts/stateful-stream-processing/)
- Apache Flink 2.3, [Checkpointing](https://nightlies.apache.org/flink/flink-docs-stable/docs/dev/datastream/fault-tolerance/checkpointing/), [Configuration](https://nightlies.apache.org/flink/flink-docs-stable/docs/deployment/config/)
- Apache Flink 2.3, [State Backends](https://nightlies.apache.org/flink/flink-docs-stable/docs/ops/state/state_backends/), [Checkpoints vs. Savepoints](https://nightlies.apache.org/flink/flink-docs-stable/docs/ops/state/checkpoints_vs_savepoints/)
- Apache Flink 2.3, [Monitoring Back Pressure](https://nightlies.apache.org/flink/flink-docs-stable/docs/ops/monitoring/back_pressure/), [Checkpointing under backpressure](https://nightlies.apache.org/flink/flink-docs-stable/docs/ops/state/checkpointing_under_backpressure/), [Network Buffer Tuning](https://nightlies.apache.org/flink/flink-docs-stable/docs/deployment/memory/network_mem_tuning/)
- Apache Flink 2.3, [DataStream API overview](https://nightlies.apache.org/flink/flink-docs-stable/docs/dev/datastream/overview/)(Controlling Latency), [Kafka connector](https://nightlies.apache.org/flink/flink-docs-stable/docs/connectors/datastream/kafka/)

논문과 글
- Apache Flink 2.3, [Fault Tolerance via State Snapshots](https://nightlies.apache.org/flink/flink-docs-stable/docs/learn-flink/fault_tolerance/)(Learn Flink, 배리어와 정렬 입문)
- Paris Carbone 외, [Lightweight Asynchronous Snapshots for Distributed Dataflows](https://arxiv.org/abs/1506.08603), 2015
- Arvid Heise, Stephan Ewen, [From Aligned to Unaligned Checkpoints - Part 1: Checkpoints, Alignment, and Backpressure](https://flink.apache.org/2020/10/15/from-aligned-to-unaligned-checkpoints-part-1-checkpoints-alignment-and-backpressure/), 2020
- Nico Kruber, [A Deep-Dive into Flink's Network Stack](https://flink.apache.org/2019/06/05/a-deep-dive-into-flinks-network-stack/), 2019
- Piotr Nowojski, Mike Winters, [An Overview of End-to-End Exactly-Once Processing in Apache Flink (with Apache Kafka, too!)](https://flink.apache.org/2018/02/28/an-overview-of-end-to-end-exactly-once-processing-in-apache-flink-with-apache-kafka-too/), 2018
- SoonHo Seo, [Apache Flink 어플리케이션의 End-to-End Latency 병목 찾아내기](https://hyperconnect.github.io/2025/03/28/flink-e2e-latency.html), 하이퍼커넥트, 2025(연산자별 처리 시간과 비처리 시간, flame graph로 찾은 Kryo 병목)
- Jongbong Park, [AI 실시간 추천 시스템을 위한 Flink 기반 스트림 조인 서비스 구축기](https://hyperconnect.github.io/2025/06/11/azar-flink-real-time-stream-join-service.html), 하이퍼커넥트, 2025
- Yaroslav Tkachenko 외, [7 Tips For Optimizing Apache Flink Applications](https://shopify.engineering/optimizing-apache-flink-applications-tips), Shopify, 2022
- 실습 코드: [labs/de-study/ch17](https://github.com/dj258255/IT-Oasis/tree/main/labs/de-study/ch17)

중국과 국내 빅테크 사례
- 王峰(Alibaba), [40亿条/秒！Flink流批一体在阿里双11首次落地的背后](https://developer.aliyun.com/article/778667), 2020
- Alibaba Cloud, [检查点和快照超时的诊断方法与调优策略](https://help.aliyun.com/zh/flink/realtime-flink/use-cases/prevent-checkpoint-and-savepoint-timeout)(실시간 계산 Flink 문서)
- 字节跳动技术团队, [字节跳动使用 Flink State 的经验分享](https://juejin.cn/post/7111600050262212638), 2022
- Yong Fang 외(ByteDance), [StreamShield: A Production-Proven Resiliency Solution for Apache Flink at ByteDance](https://arxiv.org/html/2602.03189v1), 2026
- 冯斐, 王非凡(Meituan), [美团 Flink 大作业部署与状态稳定性优化实践](https://segmentfault.com/a/1190000041453543), 2022
- 王非凡(Meituan), [基于 Log 的通用增量 Checkpoint 在美团的进展](https://juejin.cn/post/7236412253456515130), 2023
- 이승민, 최원용, [Apache Flink + RocksDB 튜닝으로 광고 Frequency Capping 실시간 집계를 일주일까지 확장하기](https://toss.tech/article/flink-realtime-frequency-capping), 토스, 2026

---
title: '왜 Kafka를 직접 만드나 — 내 첫 분산 시스템'
titleEn: 'Why Build Kafka — My First Distributed System'
description: 미니 RDBMS(db-hobby)를 만들며 남긴 WAL을 보다가 생각이 하나로 모였다 — 이 로그를 주인공으로 승격시켜 여러 노드에 복제하면 그게 Kafka다. Java로 바닥부터 만드는 토이 Kafka 연재의 1편. 코드를 쓰기 전에 끝낸 설계 결정들(분산 로그가 뭔지, 왜 Java인지, 단일 브로커 먼저 왜 그런지)과, 이번엔 단위 테스트 대신 "상황 시뮬레이션"으로 검증하기로 한 이유를 정리한다.
descriptionEn: "A toy Kafka built from scratch in Java. Looking at the WAL left behind by my mini RDBMS (db-hobby), it clicked — promote that log to the star and replicate it across nodes, and you have Kafka. This first post covers the design decisions settled before writing code (what a distributed log is, why Java, why single-broker first) and why I verify with a 'situation simulation' instead of unit tests this time."
date: 2026-07-02T00:00:00.000Z
tags:
  - Kafka
  - Java
  - Distributed Systems
  - Log
  - Replication
  - Raft
category: study/kafka-hobby
draft: false
series: "Java로 만드는 토이 Kafka"
seriesOrder: 1
---

*바닥부터 직접 만드는 토이 Kafka 연재. 이 글은 1편 — 코드 이전에 끝낸 설계 결정들.*

## 0. 들어가며

[C로 토이 커널](/blog/hobby/kernel-hobby-00-boot-to-paging)을 만들고, [C로 미니 RDBMS](/blog/project/db-hobby/db-internals-01-storage)를 만들고, [C로 토이 JVM](/blog/hobby/java-hobby-00-why-and-architecture)까지 손을 대면서, 뒤늦게 한 가지가 눈에 들어왔어요 — **내가 만든 건 전부 "컴퓨터 한 대 안"의 이야기더라고요.**

커널도, DB도, JVM도 전부 단일 노드예요. 그런데 진짜 백엔드 시스템은 결국 **여러 대의 컴퓨터가 협력**하죠. 복제, 합의, 파티셔닝 — 이 "가로축"을 나는 한 번도 안 판 거예요.

그러다 db-hobby의 `wal.c`를 다시 보는데, 생각이 딱 맞물렸어요.

> **WAL(Write-Ahead Log)은 "맨 뒤에 계속 덧붙이기만 하는 기록장"이에요. 그 로그를 여러 노드에 복제해서 시스템의 *주인공*으로 만들면 — 그게 Kafka예요.**

이미 절반은 만들어 둔 셈이더라고요. 그래서 이번엔 그 로그를 **파티션으로 쪼개고 노드로 복제하는**, 내 **첫 분산 시스템**을 만들기로 했어요. 이름은 `kafka-hobby`.

전체 로드맵은 [저장소 README](https://github.com/dj258255/kafka-hobby#readme)에 정리돼 있어요. 이 글은 코드를 쓰기 전에 풀어야 했던 질문들의 회고예요.

## 1. Kafka가 무엇인지부터 — "분산된 append-only 로그"

가장 먼저 짚고 넘어가야 했어요. **Kafka는 "메시지 큐"가 아니에요.** (정확히는 그보다 훨씬 단순하면서 강력한 무언가예요.)

Kafka의 심장은 딱 하나예요 — **append-only 로그**. 레코드를 맨 뒤에 순서대로 붙이고, 각 레코드에 단조 증가하는 **offset**을 준다. 그게 전부예요.

```
Topic "orders"
├── Partition 0:  [msg0][msg1][msg2][msg3]...   (로그 파일 하나)
├── Partition 1:  [msg0][msg1][msg2]...
└── Partition 2:  [msg0][msg1]...
                   ▲ offset 0,1,2...  (파티션 안에서만 순서 보장)
```

Kafka 창시자 Jay Kreps가 쓴 유명한 글 [*"The Log"*](https://engineering.linkedin.com/distributed-systems/log-what-every-software-engineer-should-know-about-real-time-datas-unifying)의 요지가 이거예요. **로그는 DB·복제·스트림 처리를 관통하는 단 하나의 통합 추상이다.** 일반 큐와 달리 로그는 "총 순서(total order) + 재생 가능(replay)"이라는 성질을 공짜로 주는데, 이게 복제·장애복구·스트림처리를 전부 떠받쳐요.

| | 일반 메시지 큐 | Kafka(로그) |
|---|---|---|
| 읽으면 | 메시지가 사라짐 | offset만 앞으로, 데이터는 남음 |
| 재생 | 불가 | offset 되감으면 언제든 다시 |
| 새 소비자 | 과거 못 봄 | offset 0부터 처음부터 |

> 그래서 첫 결정이 명확해졌어요 — **큐를 만드는 게 아니라 "로그"를 만든다.** db-hobby에서 WAL을 만들어봤으니, 여기선 그 로그를 *여러 노드로 복제*하는 게 새로 배울 부분이에요.

## 2. 왜 이게 필요한 상황인가

동기 없이 만들면 중간에 지쳐요. 그래서 [`SCENARIO.md`](https://github.com/dj258255/kafka-hobby/blob/master/SCENARIO.md)에 "어떤 상황이 이걸 필요하게 만드는가"를 먼저 박아뒀어요.

이커머스 백엔드를 상상해요. `order-service`가 "주문 생성됨" 이벤트를 쏟아내고, 여러 소비자가 각자 속도로 처리해야 해요.

```
                     ┌──> inventory-service (재고 차감)
order-service ──이벤트──┼──> email-service     (확인 메일)
                     └──> analytics-service (집계)
```

직접 호출하면 지옥이에요. 소비자 하나 죽으면 주문이 막히고(강결합), 크래시 나면 처리 중이던 이벤트가 증발하고(유실), 과거를 재집계하고 싶어도 데이터가 없고(재생 불가), 새 소비자 붙이려면 order-service를 또 고쳐야 하죠(확장 불가).

**해결책 = 그 사이에 분산 로그를 둔다.** 생산자는 붙이기만, 소비자는 각자 offset을 들고 읽기만. 결합이 끊기고, 크래시에도 남고, 언제든 재생·추가 가능해져요. 그게 Kafka고, 그걸 밑바닥부터 만드는 게 이 프로젝트예요.

## 3. 설계 결정 — 언어, 그리고 순서

### 왜 Java인가

커널·DB·JVM은 전부 C로 만들었어요. 그런데 Kafka만은 **Java**로 갑니다. 이유가 둘이에요.

1. **진짜 Kafka가 JVM(Java/Scala)이에요.** 언어까지 미러링하면 실제 소스(`Log`, `Partition`, `KafkaApis`)와 개념·용어가 1:1로 맞아서 대조 학습이 쉬워요.
2. **제 주력·면접 언어예요.** 잡서칭 중이라, 분산 시스템을 제 주 언어로 밑바닥부터 짰다는 증거가 직접 도움이 돼요.

### 왜 단일 브로커부터인가

Kafka를 처음부터 "여러 노드"로 시작하면 **"분산"과 "네트워크 프로토콜"이라는 두 개의 처음 쓰는 근육**을 동시에 쓰느라 버거워요. 그래서 두 국면으로 쪼갰어요.

```
국면 1 — 단일 브로커        국면 2 — 다중 브로커
(프로토콜 + 로그 저장)  →   (복제 + 합의)
 여기서 뼈대를 세우고        여기서 진짜 분산이 된다
```

국면 1(트랙 A~C)에서 와이어 프로토콜과 로그 저장을 완성해 "동작하는 카프카"를 만들고, 국면 2(트랙 D~E)에서 복제(ISR)와 **합의(Raft/KRaft)**를 얹어 "분산 카프카"로 키워요. 분산 학습의 진짜 알맹이는 국면 2에 있지만, 국면 1이 없으면 얹을 곳이 없죠.

> 재밌는 지점: **Kafka의 메타데이터 합의(KRaft)를 제대로 만들면 Raft를 안 만들 수가 없어요.** Raft는 etcd·Consul·CockroachDB의 심장이죠. (→ 그래서 Raft는 [MIT 6.5840로 먼저 제대로 배운 뒤](/blog/distributed-systems/distsys-00-why-and-plan) 국면 2에서 짓기로 했어요. 자작만으론 네트워크 분단 같은 실패를 스스로 테스트하기 어렵거든요.)

## 4. 이번엔 "테스트" 대신 "상황 시뮬레이션"

db-hobby가 강했던 진짜 이유는 **323개 테스트**였어요. "동작한다 주장"이 아니라 "증명"이 됐죠. Kafka도 그 검증 문화를 이어가는데, 방식을 살짝 바꿨어요.

분산 시스템은 단위 테스트보다 **"진짜 클라이언트가 이런 상황에서 이렇게 요청하면 브로커가 제대로 답하나?"**를 재현하는 게 훨씬 잘 맞아요. 그래서 `ClientSimulator`라는 걸 만들었어요 — **실제 Kafka 클라이언트 역할을 하며 브로커를 두들기고 PASS/FAIL을 찍는** 작은 하네스예요.

```
make run    # 브로커 실행
make sim    # 시뮬레이터가 진짜 클라이언트처럼 붙어서 검증
make test   # 위 둘을 자동으로
```

이게 **동기와 검증을 동시에** 잡아요 — "왜 이걸 만들지?"의 답(SCENARIO)이자 "제대로 만들었나?"의 답(시뮬레이터)이거든요. 코드가 막히면 시뮬레이터가 기대하는 바이트 레이아웃이 곧 명세라, 뭘 만들어야 하는지가 그대로 보여요.

## 5. 첫 관문 — "통성명"(Track A)

생산도 소비도 하기 전에, 모든 클라이언트가 **맨 처음** 하는 일이 있어요. 브로커에 붙어서 *"너 어떤 API를 어느 버전까지 지원해?"*라고 묻는 거죠. 이게 `ApiVersions` 요청, 프로토콜의 **핸드셰이크**예요.

Kafka는 커스텀 이진 프로토콜을 쓰는데, 모든 메시지가 이렇게 프레이밍돼요.

```
[ 4-byte 길이 N ][ N 바이트 payload ]
```

요청 payload의 맨 앞(헤더)은 이렇게 생겼어요.

```
api_key        INT16   어떤 API인지 (18 = ApiVersions)
api_version    INT16   그 API의 몇 번 버전을 쓰는지
correlation_id INT32   클라이언트가 고른 번호 — 브로커가 그대로 돌려줘야 함
```

`correlation_id`를 브로커가 **그대로 되돌려줘야** 클라이언트가 "이게 내 질문의 답"임을 알아요. Track A는 딱 이 대화를 할 줄 아는 브로커를 만드는 단계예요.

뼈대는 다 짜뒀고(TCP accept 루프, 프레임 read/write, 디스패치), **"카프카를 이해했다"는 증거가 되는 두 지점만 비워뒀어요** — (1) 소켓의 raw 바이트를 구조화된 요청으로 바꾸는 파싱, (2) "내가 뭘 지원하는지" 응답 만들기. 지금 시뮬레이터를 돌리면 이렇게 나와요.

```
[broker] listening on port 9092
[sim] connected to localhost:9092
[sim] sent ApiVersions request (correlationId=42)
[conn] TODO #1: parse the request header (KafkaRequest.parse)  <- implement this TODO and re-run
```

이건 버그가 아니라 **의도된 red 상태**예요. 여기서 헤더 파싱(TODO #1)을 채우면 correlation id가 PASS로 바뀌고, 응답 빌더(TODO #2)까지 채우면 초록불 — Track A 통과. 이 red→green 여정 자체가 공부예요.

## 마무리

코드에 앞서 이걸 결정했어요.

- **큐가 아니라 로그를 만든다** — db-hobby의 WAL을 주인공으로 승격.
- **Java로** — 진짜 Kafka(JVM)와 미러링 + 내 주력 언어.
- **단일 브로커 → 다중 브로커** 두 국면 — 국면 2(복제·Raft)가 분산의 알맹이.
- **단위 테스트 대신 상황 시뮬레이션** — 동기와 검증을 한 번에.

다음 편(2편)에서는 Track A의 두 TODO를 실제로 채우면서, Kafka 와이어 프로토콜을 바이트 단위로 뜯어봐요 — 헤더를 파싱하고, `ApiVersions` 응답을 조립하고, 시뮬레이터를 초록불로 만드는 과정이요. 전체 로드맵과 코드는 [저장소](https://github.com/dj258255/kafka-hobby)에 있어요.

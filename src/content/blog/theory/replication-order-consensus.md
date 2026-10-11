---
title: '복제본 여러 개를 하나처럼 쓰려면 무엇이 필요할까?'
description: '메이퇀 기술 블로그의 복제 정리 하편을 뼈대로 선형 읽기, 순서를 정하는 번호, 합의, 2PC, Kafka 트랜잭션이 각각 무엇을 치르는지 정리했습니다. etcd 세 대, PostgreSQL 두 대, Kafka 한 대로 읽기 지연과 분할, 조정자가 멈춘 2PC의 잠금, 열린 트랜잭션이 붙잡는 소비자를 직접 실행했고 Google, Roblox, Amazon, PingCAP, OceanBase, 메이퇀의 선택을 원문으로 붙였습니다.'
date: 2026-10-12
tags:
  - Replication
  - Linearizability
  - Consensus
  - Raft
  - Two-Phase Commit
  - Kafka Transactions
  - etcd
  - PostgreSQL
  - Distributed Systems
category: theory/Database
series: "데이터 복제"
seriesOrder: 2
coverImage: /uploads/covers/theory/replication-order-consensus.svg
draft: false
---

복제본 여러 개를 하나처럼 쓰려면 다섯 가지가 필요하고 다섯 가지 모두 값을 치릅니다. 최신 값을 읽는 읽기, 순서를 정하는 번호, 다음에 쓸 것을 정하는 합의, 여러 곳을 함께 고치는 커밋, 읽는 쪽의 격리입니다. 앞 글 [데이터 복제에서 정하는 다섯 가지](/blog/theory/replication-five-decisions)는 복제를 어떻게 할지를 다뤘고 이 글은 그 뒤에 남는 질문을 다룹니다. 뼈대는 메이퇀 기술 블로그의 "Replication（下）：事务，一致性与共识"입니다. 아래에서는 그 글을 원문이라고 부릅니다. 원문은 『데이터 중심 애플리케이션 설계』의 트랜잭션, 일관성, 합의를 요약하고 Kafka에 대응시킵니다. 여기에는 etcd, PostgreSQL, Kafka로 직접 실행한 결과와 회사들이 고른 것을 더했습니다.

실행해서 확인한 결과부터 적습니다.

1. 복제본이 하나인 것처럼 최신 값을 읽는 선형 읽기는 쓰기만큼 치릅니다. 노드 사이 왕복이 11.7ms인 etcd 세 대에서 자기가 가진 값을 바로 주는 읽기는 0.3ms, 선형 읽기는 리더에서 11.3~11.7ms, 팔로워에서 23.3~23.8ms였습니다. 한 대를 나머지와 끊자 그 노드는 25초 뒤에도 옛 값을 돌려줬고 선형 읽기는 7초 뒤 실패했습니다.
2. 순서는 시계 대신 번호로 정합니다. 시계가 3초 빠른 노드가 있으면 시각이 큰 쓰기를 남기는 규칙은 나중에 쓴 값을 버립니다. 번호는 물러난 리더와 만료된 락 보유자의 쓰기를 거절하는 데도 쓰입니다.
3. 합의는 리더가 바뀌는 동안 쓰기를 멈춥니다. etcd의 리더를 끊자 과반 쪽의 쓰기가 다섯 번 모두 1.2~1.6초 멈췄다가 이어졌습니다.
4. 2PC는 조정자가 멈추면 참가자가 잠금을 쥔 채 기다립니다. PostgreSQL에서 조정자를 2초, 5초, 10초 비우자 같은 행을 고치려던 쓰기가 1,994ms, 4,995ms, 9,999ms 막혔고 서버를 재시작해도 잠금이 남았습니다.
5. Kafka 트랜잭션은 읽는 쪽의 격리 수준까지 맞춰야 합니다. 트랜잭션을 5초 열어 두자 커밋된 것만 읽는 소비자는 트랜잭션과 무관한 메시지까지 5초 뒤에 받았습니다. 기본 설정의 소비자는 중단된 트랜잭션의 메시지를 1ms 만에 받았습니다.

합의 알고리즘 자체의 구현과 격리 수준은 이 블로그의 다른 글에 있습니다.

| 주제 | 글 |
|---|---|
| Raft를 직접 구현(선출, 지속성, 멤버십, 선형화 읽기) | [DB 내부 ⑩: Raft](/blog/project/db-hobby/db-internals-10-raft) |
| 격리 수준과 이상 현상 | [트랜잭션 ACID ②: Isolation](/blog/theory/transaction-acid-02-isolation) |
| 일관성이라는 말의 여러 뜻 | [트랜잭션 ACID ③: Consistency](/blog/theory/transaction-acid-03-consistency) |

## 원문의 설명 가운데 여섯 곳은 문서나 실행 결과와 다르거나 조건이 빠져 있었습니다

원문의 서술을 공식 문서, 논문, 실행 결과와 대조했습니다.

| 원문의 서술 | 확인한 것 |
|---|---|
| 선형성은 외부 일관성의 최고 수준이고 직렬성은 내부 일관성의 최고 수준이다 | 같은 글의 3장과 4장은 트랜잭션 쪽을 외부 일관성, 복제본 쪽을 내부 일관성이라고 정의합니다. 5장의 이 문장만 둘이 뒤바뀌어 있습니다 |
| Lamport 시계에서 Counter가 큰 쪽이 나중에 일어났다 | 먼저 일어난 일의 번호가 작다는 한 방향만 성립합니다. 2장의 계산 예시에서 실제로 가장 늦은 쓰기의 번호가 1이었습니다 |
| `acks=-1`에서 `min.insync.replicas` 제한이 없으면 복제본 하나만 문제여도 쓰기를 못 받는다 | 문서에 따르면 쓰기가 거절되는 것은 확인한 복제본 수가 이 값에 못 미칠 때입니다. 기본값이 1이어서 동기화된 복제본이 리더 하나로 줄어도 조건을 채웁니다. 쓰기가 막히는 쪽은 이 값을 올렸을 때입니다 |
| 조정자에게 트랜잭션 ID를 받고 커밋이 결정되면 참가자가 메시지를 로그에 쓴다 | KIP-98에서 ID(`transactional.id`)는 사용자가 정하고 조정자는 프로듀서 번호와 에포크를 돌려줍니다. 메시지는 커밋 전에 이미 로그에 있고 커밋 때 쓰이는 것은 표시(마커)입니다. 5장의 실행에서 커밋 전 메시지를 기본 설정의 소비자가 1ms 만에 읽었습니다 |
| Kafka는 읽기 커밋(RC) 격리까지 구현했다 | 소비자의 `isolation.level` 기본값은 `read_uncommitted`입니다. `read_committed`는 따로 켜야 합니다 |
| 2PC도 합의 알고리즘의 하나다 | 2PC는 조정자가 멈추면 끝나지 않으므로 고장을 견디는 합의가 못 됩니다. Gray와 Lamport의 문장은 "The classic Two-Phase Commit protocol blocks if the coordinator fails"입니다. 4장에서 다룹니다 |

## 1. 하나처럼 보이는 읽기는 쓰기만큼 치릅니다

선형성은 복제본이 여러 개여도 하나인 것처럼 보이는 성질입니다. 쓰기가 끝난 뒤에 시작한 읽기는 어느 복제본에 물어도 그 값이나 더 새 값을 받습니다. 이 성질을 읽기에서 지키려면 읽기마다 과반과 통신해야 해서 읽기가 쓰기만큼 느려지고 과반과 끊긴 노드는 읽기에 답하지 못합니다.

etcd는 두 가지 읽기를 제공합니다. 선형 읽기가 기본이고 요청마다 직렬 읽기를 고를 수 있습니다. 문서는 직렬 읽기를 이렇게 설명합니다.

> clients can configure a request's consistency mode to serializable, which may access stale data with respect to quorum, but removes the performance penalty of linearized accesses' reliance on live consensus.

### 선형 읽기는 리더에서 왕복 한 번, 팔로워에서 왕복 두 번이 들었습니다

etcd 세 대를 띄우고 노드 사이에만 편도 5ms의 지연을 넣었습니다. 노드끼리의 왕복은 11.7ms이고 클라이언트와 노드 사이에는 지연이 없습니다. 같은 키를 500번씩 세 차례 읽고 중앙값을 냈습니다. 쓰기는 300번씩 세 차례입니다.

![직렬 읽기는 물어본 노드가 바로 답하고 선형 읽기는 리더가 과반에 확인한 뒤 답하는 경로를 비교한 그림](/uploads/theory/replication-order-consensus/read-paths.svg)

| 요청 | 리더에 보냄 | 팔로워에 보냄 |
|---|---|---|
| 직렬 읽기 | 0.27 ~ 0.30ms | 0.26 ~ 0.29ms |
| 선형 읽기 | 11.34 ~ 11.73ms | 23.28 ~ 23.80ms |
| 쓰기 | 11.20 ~ 11.72ms | 22.72 ~ 23.19ms |

선형 읽기와 쓰기의 값이 같습니다. 리더는 읽기에 답하기 전에 자기가 아직 리더인지를 과반에게 확인하고 이 확인에 노드 사이 왕복이 한 번 듭니다. 팔로워에 보낸 읽기는 팔로워가 리더에게 묻는 왕복이 한 번 더 붙습니다. 읽기가 쓰기의 열 배인 서비스가 모든 읽기를 선형으로 하면 합의 계층이 받는 부하도 그만큼 늘어납니다.

### 과반과 끊긴 노드는 옛 값을 주거나 답하지 못합니다

팔로워 한 대를 나머지 두 대와 끊은 뒤 과반 쪽에서 값을 `v1`에서 `v2`로 바꿨습니다. 끊긴 노드에 읽기와 쓰기를 보낸 결과입니다.

| 끊긴 노드에 보낸 요청 | 결과 |
|---|---|
| 직렬 읽기, 끊은 직후 | `v1` (1.3ms) |
| 직렬 읽기, 5초 뒤 | `v1` (5.5ms) |
| 직렬 읽기, 25초 뒤 | `v1` (2.3ms) |
| 선형 읽기 | 7,005ms 뒤 실패(`request timed out`) |
| 쓰기 | 7,004ms 뒤 실패 |

리더를 끊었을 때도 끊긴 옛 리더의 결과는 같았습니다. 직렬 읽기는 옛 값을 주고 선형 읽기와 쓰기는 약 7초 뒤 실패했습니다. 과반 쪽 두 대는 선형 읽기로 `v2`를 줬습니다.

끊긴 노드가 고를 수 있는 것은 둘입니다. 옛 값이라도 답하거나 답하지 않는 것입니다. CAP 정리가 말하는 선택이 이것이고 etcd는 요청마다 고르게 해 두었습니다. 직렬 읽기는 캐시처럼 조금 낡아도 되는 조회에, 선형 읽기는 락과 리더 선출처럼 낡은 값이 사고가 되는 조회에 씁니다.

### 회사들은 선형성의 값을 수치로 내놓았습니다

PingCAP은 TiDB 5.0의 릴리스 노트에 선형성을 낮췄을 때 줄어드는 지연을 실었습니다. 트랜잭션의 일관성을 선형에서 인과 일관성으로 낮추면 64스레드 쓰기 시험의 평균 지연이 11.86ms에서 11.19ms로 5.6% 줄어듭니다. 같은 문서는 이때 서로 의존하지 않는 트랜잭션들 사이에는 전체로 일관된 순서가 없어진다고 덧붙입니다.

앤트그룹의 Raft 구현 SOFAJRaft는 선형 읽기를 두 방식으로 제공합니다. 기본은 읽기마다 과반에 확인하는 ReadIndex이고 다른 하나는 정해 둔 시간 동안 확인을 건너뛰는 Lease Read입니다. 문서는 두 방식의 성능 차이를 15%쯤이라고 밝히고 코드 주석에 Lease Read가 시계에 기댄다는 경고를 달아 두었습니다.

ZooKeeper는 읽기를 기본으로 선형으로 하지 않습니다. 문서에는 두 클라이언트가 어느 순간에나 같은 데이터를 본다고 보장하지 않는다고 적혀 있고 최신 값이 필요하면 읽기 전에 `sync()`를 부르라고 안내합니다. 원문이 선형 읽기의 예로 든 것이 이 `sync()`입니다.

직접 만든 Raft에서 같은 현상을 본 기록은 [DB 내부 ⑩의 6장](/blog/project/db-hobby/db-internals-10-raft)에 있습니다.

## 2. 순서는 시계 대신 번호로 정합니다

복제본들이 같은 결과에 이르려면 쓰기의 순서에 모두가 동의해야 합니다. 서버의 시계는 서로 달라서 시각으로 순서를 정하면 나중에 쓴 값이 버려질 수 있습니다. 그래서 순서는 하나씩 올라가는 번호로 정하고 같은 번호를 낡은 요청을 거절하는 데도 씁니다.

### 시계가 3초 빠른 노드가 있으면 시각 기준은 나중 쓰기를 버립니다

노드 A의 시계가 3초 빠르다고 두고 쓰기 세 개의 순서를 계산했습니다. 측정이 아니고 규칙을 손으로 따라간 예시입니다. Lamport 번호는 노드마다 하나씩 올리고 다른 노드의 번호를 받으면 큰 쪽에 맞추는 카운터입니다.

| 쓰기 | 실제 시각 | 그 노드의 시계 | Lamport 번호 |
|---|---|---|---|
| A에 `x=1` | 100.0 | 103.0 | (1, A) |
| `x=1`을 받아 본 B에 `x=2` | 101.0 | 101.0 | (2, B) |
| 아무것도 받지 않은 C에 `x=3` | 110.0 | 110.0 | (1, C) |

`x=1`과 `x=2` 가운데 시계의 시각이 큰 쪽을 남기면 `x=1`이 남습니다. `x=2`는 `x=1`을 본 뒤에 쓴 값인데 버려집니다. Lamport 번호가 큰 쪽을 남기면 `x=2`가 남습니다.

셋째 줄은 번호의 한계입니다. `x=3`은 실제로 가장 늦게 쓰였는데 번호는 1입니다. Lamport 번호는 원인이 결과보다 작은 번호를 받는다는 것만 보장하고 서로를 모르는 쓰기들 사이에서는 실제 시각의 순서를 지키지 않습니다. 원문의 "Counter가 큰 쪽이 나중에 일어났다"는 이 경우에 틀립니다. 번호만으로 선형성을 얻지 못하는 이유도 여기에 있습니다. 실제 시각의 순서까지 지키려면 3장의 합의가 필요합니다.

### 번호는 물러난 리더와 만료된 락의 쓰기를 거절하는 데 쓰입니다

리더가 바뀔 때마다 올라가는 번호를 에포크라고 합니다. Raft의 term, Kafka의 리더 에포크가 같은 것입니다. 받는 쪽이 지금까지 본 가장 큰 번호를 기억해 두면 물러난 줄 모르는 옛 리더의 요청을 번호만 보고 거절할 수 있습니다.

Google은 Paxos로 락 서비스 Chubby를 만들면서 이 번호를 넣었습니다. 요청을 받은 복제본이 처리 도중에 리더 자리를 잃거나 잃었다가 되찾을 수 있어서 리더가 줄곧 리더였는지를 확인할 수단이 필요했다고 합니다. 논문의 번호는 한 복제본이 리더 자리를 지킨 동안에만 같은 값을 줍니다.

락에서는 같은 번호를 펜싱 토큰이라고 부릅니다. Martin Kleppmann의 예시가 알기 쉽습니다. 클라이언트 1이 토큰 33으로 락을 얻은 뒤 긴 멈춤에 빠져 락이 만료됩니다. 클라이언트 2가 토큰 34로 락을 얻어 저장소에 씁니다. 깨어난 클라이언트 1이 토큰 33으로 쓰려 하면 저장소는 34를 이미 처리했으므로 거절합니다.

합의로 만든 락 서비스에도 이 토큰이 필요합니다. Jepsen은 etcd 3.4.3을 분석하고 키와 값의 연산은 엄격한 직렬성을 지키는 것으로 보인다고 했습니다. 락에 대해서는 이렇게 결론 냈습니다.

> etcd locks are fundamentally unsafe

여러 클라이언트가 같은 락을 동시에 쥘 수 있고 장애가 없는 건강한 클러스터에서도 그런 일이 났다는 것입니다. Jepsen이 권한 것은 락을 쥔 쪽이 하는 모든 연산에 펜싱 토큰을 붙이는 방법입니다.

### 시계를 꼭 써야 하면 거꾸로 간 시계를 거절합니다

번호에 시각을 넣어야 하는 경우도 있습니다. 메이퇀의 ID 발급기 Leaf는 ID의 앞자리에 밀리초 시각을 넣습니다. 시계가 거꾸로 가면 같은 ID가 다시 나올 수 있어서 Leaf는 발급 때마다 직전에 발급한 시각과 견줍니다. 글에 실린 코드는 거꾸로 간 폭이 5ms 이하면 그 두 배를 기다렸다가 다시 보고 여전히 거꾸로면 예외를 던져 발급을 거절합니다. 메이퇀은 2017년 윤초 때 일부 기계의 시계가 거꾸로 갔고 이 처리 덕분에 업무에 영향이 없었다고 밝혔습니다.

## 3. 합의는 리더가 바뀌는 동안 쓰기를 멈춥니다

합의는 여러 노드가 같은 값 하나를 정하고 한번 정하면 바꾸지 않는 일입니다. 복제에서는 이 일을 로그의 칸마다 되풀이합니다. 모든 노드가 같은 쓰기를 같은 순서로 받게 되고 이것을 전체 순서 브로드캐스트라고 합니다. 원문이 정리한 대로 리더 선출, 락, 유일성 제약, 원자적 커밋이 모두 이 문제로 바뀝니다. 치르는 값은 둘입니다. 과반이 살아 있어야 하고 리더가 바뀌는 동안은 쓰기가 멈춥니다.

### 리더를 끊자 과반 쪽의 쓰기가 1.2~1.6초 멈췄습니다

1장의 etcd 세 대에서 쓰기를 계속 보내면서 4초 지점에 리더를 나머지 두 대와 끊었습니다. 쓰기는 남은 두 대 가운데 한 대에 보냈고 성공한 쓰기들 사이의 가장 긴 공백을 쟀습니다. 다섯 번 되풀이했습니다.

| 회차 | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| 쓰기가 멈춘 시간 | 1,349ms | 1,555ms | 1,558ms | 1,217ms | 1,579ms |

다섯 번 모두 실패한 쓰기는 없었고 요청이 그 시간만큼 늦게 끝났습니다. 남은 두 대가 리더의 소식이 끊긴 것을 알아채고 새 리더를 뽑는 데 걸린 시간입니다. etcd의 선출 제한 시간은 기본 1초입니다. 이 값을 줄이면 공백이 짧아지고 네트워크가 잠깐 느려질 때 멀쩡한 리더를 바꾸는 일이 늘어납니다. 앞 글 3장의 제한 시간 문제가 합의 안으로 옮겨 온 것입니다.

### 논문의 한 쪽이 구현에서는 수천 줄이 됩니다

Google은 Chubby를 만든 경험을 "Paxos Made Live"로 남겼습니다.

> While Paxos can be described with a page of pseudo-code, our complete implementation contains several thousand lines of C++ code.

늘어난 까닭으로 논문은 디스크 손상, 리더의 임대 시간, 구성원 변경을 듭니다. 디스크가 손상되어 기록을 잃은 복제본은 자기가 한 약속을 어길 수 있습니다. 구성원 변경은 문헌에 자세한 절차와 정확성 증명이 없어서 직접 채웠다고 합니다. 원문이 합의를 직접 만들지 말고 ZooKeeper나 etcd에 맡기라고 권한 배경입니다.

### 합의 저장소 하나에 여럿을 얹으면 그 저장소의 건강이 전체의 건강이 됩니다

Roblox는 2021년 10월 28일부터 73시간 동안 서비스가 멈췄습니다. 사후 분석에 따르면 원인은 합의 알고리즘의 결함이 아니었습니다. 합의 기반 저장소인 Consul에서 새로 켠 스트리밍 기능이 읽기와 쓰기가 몰린 상황에서 경합을 일으켰고 Consul이 로그를 저장하는 데 쓰는 BoltDB에서 성능 문제가 함께 났습니다. 서비스 발견, 상태 점검, 세션 락, 키와 값 저장이 모두 이 Consul에 얹혀 있었습니다. Roblox는 이렇게 적었습니다.

> the system failed because Consul was a single point of failure, and Consul was not healthy.

합의는 노드 몇 대가 죽는 고장을 견디게 해 줍니다. 저장소 전체가 느려지는 고장은 견디지 못하고 그 위에 얹힌 것들이 함께 느려집니다.

위챗의 저장소 PaxosStore는 반대쪽 선택을 보여 줍니다. 리더의 임대에 기대는 합의는 리더가 바뀌는 동안 쓰기를 받지 못하므로 리더를 두지 않는 Paxos를 골랐다고 논문에 밝혔습니다. 대신 쓰기 충돌을 줄이려고 요청을 정해진 복제본으로 보냅니다.

## 4. 2PC는 조정자가 멈추면 참가자가 잠금을 쥔 채 기다립니다

여러 DB나 여러 파티션을 함께 고치고 모두 커밋되거나 모두 취소되게 하는 방법이 2단계 커밋(2PC)입니다. 조정자가 참가자들에게 준비할 수 있는지 묻고 모두 그렇다고 답하면 커밋을 지시합니다. 준비했다고 답한 참가자는 혼자서 취소할 수 없고 조정자의 지시를 기다려야 합니다. 그래서 조정자가 멈추면 참가자는 잠금을 쥔 채 멈춥니다.

### 조정자가 자리를 비운 만큼 다른 쓰기가 막혔습니다

PostgreSQL 16에서 한 세션이 행 하나를 고치고 `PREPARE TRANSACTION`까지 한 뒤 연결을 끊었습니다. 조정자가 준비 단계 뒤에 죽은 상황입니다. 다른 세션이 같은 행을 고치려 할 때 얼마나 막히는지를 쟀습니다.

| 조정자가 돌아와 `COMMIT PREPARED`를 한 시점 | 다른 세션의 쓰기가 막힌 시간 |
|---|---|
| 2초 뒤 | 1,994ms |
| 5초 뒤 | 4,995ms |
| 10초 뒤 | 9,999ms |

그 행을 읽는 `SELECT`는 막히지 않고 준비 전의 값을 돌려줬습니다. 쓰기에 `lock_timeout`을 500ms로 걸면 502ms 뒤 오류가 났습니다.

준비된 트랜잭션이 치르게 하는 것을 세 가지 더 확인했습니다.

| 실행한 것 | 결과 |
|---|---|
| 준비된 트랜잭션을 둔 채 서버를 재시작 | 준비된 트랜잭션이 그대로 남았고 그 행에 대한 쓰기는 506ms 뒤 잠금 시간 초과 |
| 그 상태에서 다른 테이블의 10만 행을 고치고 `VACUUM` | 죽은 행 100,000개가 "아직 지울 수 없음". 준비된 트랜잭션을 끝내고 다시 돌리자 100,000개가 지워짐 |
| 두 DB에서 100을 옮기는 2PC, 조정자가 첫 DB만 커밋하고 죽음 | 첫 DB 900, 둘째 DB 1,000으로 합이 2,000에서 1,900이 됨. 둘째 DB의 그 행은 잠긴 채. 남은 쪽을 손으로 커밋하자 합이 2,000으로 돌아옴 |

PostgreSQL 문서는 이 기능에 주의 문단을 달아 두었습니다.

> It is unwise to leave transactions in the prepared state for a long time. This will interfere with the ability of VACUUM to reclaim storage, and in extreme cases could cause the database to shut down to prevent transaction ID wraparound (see Section 25.1.5). Keep in mind also that the transaction continues to hold whatever locks it held.

`max_prepared_transactions`의 기본값은 0이어서 준비된 트랜잭션은 따로 켜야 쓸 수 있습니다.

### 회사들은 조정자를 없애거나 조정자도 복제했습니다

메이퇀은 2016년의 메시지 큐 설계 글에서 2PC를 쓰지 않기로 한 까닭을 밝혔습니다. 조정자가 죽거나 한 곳이 고장 나는 경우에 대해 2PC는 거의 풀 수 없는 블랙홀이라는 표현을 썼습니다. 고른 것은 업무 데이터를 고치는 로컬 트랜잭션 안에서 보낼 메시지를 같은 DB에 저장하고 발송이 실패하면 다시 보내는 방식입니다. 이 방식에서는 같은 메시지가 두 번 갈 수 있어서 받는 쪽이 중복을 견뎌야 합니다.

2PC를 유지한 쪽은 멈추는 지점을 복제했습니다. OceanBase는 참가자를 Paxos로 복제되는 그룹으로 두고 조정자의 상태를 따로 저장하지 않습니다. 조정자가 죽으면 참가자들이 가진 상태로 다시 만듭니다. 논문에 따르면 이 설계로 커밋 한 번에 드는 Paxos 동기화가 세 번에서 두 번으로 줄었습니다. Gray와 Lamport의 Paxos Commit은 조정자 자체를 2F+1대로 두고 F+1대가 살아 있으면 진행하는 방식입니다.

TiDB는 커밋의 둘째 단계를 응답 뒤로 미뤘습니다. 5.0에 들어간 비동기 커밋은 첫 단계가 성공하면 클라이언트에 결과를 돌려주고 둘째 단계를 뒤에서 실행합니다. 릴리스 노트의 수치로는 64스레드에서 인덱스를 갱신하는 시험의 평균 지연이 12.04ms에서 7.01ms로 41.7% 줄었습니다.

## 5. Kafka 트랜잭션은 읽는 쪽의 격리 수준까지 맞춰야 합니다

Kafka의 트랜잭션은 여러 파티션에 쓰는 메시지를 모두 보이게 하거나 모두 안 보이게 합니다. 구조는 2PC이고 조정자의 상태를 내부 토픽에 복제해서 조정자가 죽어도 다른 브로커가 이어받습니다. 이 보장은 쓰는 쪽만으로 완성되지 않습니다. 메시지는 커밋 전에 이미 로그에 쓰이므로 읽는 쪽이 커밋된 것만 읽도록 설정해야 하고 그렇게 설정한 소비자는 열린 트랜잭션 뒤의 메시지를 전부 기다립니다.

### 열린 트랜잭션 하나가 무관한 메시지까지 붙잡았습니다

Kafka 3.9 한 대에 파티션 하나짜리 토픽을 만들고 소비자 둘을 붙였습니다. 하나는 기본값인 `read_uncommitted`, 다른 하나는 `read_committed`입니다. 트랜잭션을 열어 메시지 둘을 보내고 다른 프로듀서로 트랜잭션 밖의 일반 메시지 하나를 보낸 뒤 각 소비자가 받기까지의 시간을 쟀습니다.

![열린 트랜잭션이 있을 때 read_committed 소비자는 LSO까지만 읽고 read_uncommitted 소비자는 하이 워터마크까지 읽는 그림](/uploads/theory/replication-order-consensus/lso.svg)

| 상황 | 메시지 | `read_uncommitted` | `read_committed` |
|---|---|---|---|
| 5초 열어 두었다 커밋 | 트랜잭션 메시지 | 0 ~ 1ms | 5,054 ~ 5,056ms |
| 5초 열어 두었다 커밋 | 뒤따른 일반 메시지 | 1ms | 5,024ms |
| 5초 열어 두었다 중단 | 트랜잭션 메시지 | 1ms | 받지 않음 |
| 5초 열어 두었다 중단 | 뒤따른 일반 메시지 | 1ms | 5,014ms |
| 열린 트랜잭션 없음 | 일반 메시지 | 1ms | 1ms |
| 프로듀서가 커밋 없이 죽음 | 뒤따른 일반 메시지 | 0ms | 10,655ms |

`read_committed` 소비자가 읽을 수 있는 끝을 LSO(last stable offset)라고 합니다. 문서의 설명으로는 가장 먼저 열린 트랜잭션의 첫 메시지 바로 앞이고 그 뒤의 메시지는 트랜잭션이 끝날 때까지 보류됩니다. 그래서 둘째 줄처럼 트랜잭션과 무관한 메시지도 함께 늦습니다.

마지막 줄의 10.7초는 `transaction.timeout.ms`를 10초로 줄여서 나온 값입니다. 프로듀서가 죽으면 조정자가 이 시간이 지난 뒤 트랜잭션을 중단시킵니다. 기본값은 60초이므로 설정을 그대로 두면 프로듀서 하나가 죽을 때 그 파티션의 `read_committed` 소비자가 1분쯤 멈춥니다.

셋째 줄은 반대쪽 설정의 값입니다. 기본값인 `read_uncommitted` 소비자는 중단된 트랜잭션의 메시지를 받습니다. 프로듀서만 트랜잭션을 쓰고 소비자 설정을 그대로 두면 중단된 메시지가 처리됩니다.

### 트랜잭션을 길게 열수록 처리량은 덜 줄고 끝에서 끝까지의 지연은 늘어납니다

Confluent는 트랜잭션의 비용을 조건과 함께 밝혔습니다. 1KB 메시지를 최대 처리량으로 보내면서 100ms마다 커밋하면 처리량이 3% 줄어듭니다. 메시지가 작거나 커밋 간격이 짧으면 더 줄어든다고 합니다. 커밋 간격을 늘리면 처리량은 지켜지고 위 표에서 본 대로 `read_committed` 소비자가 기다리는 시간이 그만큼 늘어납니다.

물러난 프로듀서를 막는 데는 2장의 번호가 쓰입니다. 같은 `transactional.id`로 새 프로듀서가 등록하면 조정자가 에포크를 올리고 옛 에포크의 프로듀서가 보내는 요청을 거절합니다. 이 방어에도 빈 곳이 있었습니다. KIP-890은 네트워크에서 늦게 도착한 메시지 때문에 LSO가 나아가지 못하고 `read_committed` 소비자가 멈추는 일이 실제로 있었다고 밝히고 커밋이나 중단 표시를 쓸 때마다 프로듀서의 에포크를 올리도록 고쳤습니다.

## 6. 이런 성질은 모델 검사와 장애 주입으로 확인합니다

이 글의 다섯 가지는 평소에는 보이지 않습니다. 노드가 끊기거나 조정자가 죽거나 프로듀서가 멈추는 순간에만 드러나고 그 순간이 겹쳐야 나오는 버그도 있습니다. 원문은 확인하는 도구로 TLA+와 Jepsen을 듭니다. TLA+는 설계를 수학으로 적어 가능한 모든 순서를 탐색하는 모델 검사이고 Jepsen은 돌아가는 시스템에 장애를 넣고 기록된 연산들이 선형성 같은 성질을 지켰는지 검사합니다.

Amazon은 2014년 보고서에서 TLA+로 찾은 버그를 소개했습니다. DynamoDB의 내결함성 알고리즘에서 고장과 복구가 특정 순서로 다른 처리와 겹치면 데이터를 잃는 버그가 나왔고 이 버그를 드러내는 가장 짧은 실행이 35단계였습니다.

> The bug had passed unnoticed through extensive design reviews, code reviews, and testing

PingCAP은 Raft와 TiDB의 2PC를 적은 TLA+ 명세를 공개 저장소에 두고 있습니다.

Jepsen 쪽의 결과는 이 글에 두 번 나왔습니다. etcd의 키와 값은 엄격한 직렬성을 지키는 것으로 보였고 같은 etcd의 락은 안전하지 않았습니다. 같은 합의 위에 올린 기능이라도 성질은 기능마다 따로 확인해야 한다는 뜻입니다.

이 글의 실행은 장애 주입의 가장 작은 꼴입니다. 한 대를 끊고 조정자를 죽이고 프로듀서를 죽이기 전에 무엇이 나올지를 먼저 적어 두었고 결과와 견줬습니다. 결과가 예상과 어긋난 곳은 없었습니다.

## 실행한 조건과 한계

- 모두 Apple Silicon 맥(12코어) 위의 리눅스 가상 머신(CPU 4, 메모리 6GiB) 한 대에서 컨테이너로 실행했습니다. 2026년 10월 12일 04:24부터 04:34 사이입니다. 맥의 1분 부하 평균은 etcd의 지연을 잴 때 4.9~5.5였고 분할 실험이 끝날 때 17.6, Kafka 실험 때 7.7~10.2였습니다.
- etcd는 3.5.17 세 대이고 데이터는 메모리 파일 시스템에 두었습니다. 디스크에 내려쓰는 시간이 실제보다 작으므로 쓰기와 선형 읽기의 값은 거의 네트워크 왕복만 담고 있습니다. 지연은 노드 사이 인터페이스에만 편도 5ms를 넣어 만들었고 요청은 클라이언트 하나가 HTTP 게이트웨이로 차례로 보냈습니다.
- 분할은 한 대를 피어 네트워크에서 떼어 내는 방식입니다. 한 방향만 끊기거나 일부 패킷만 사라지는 경우는 재현하지 않았습니다. 끊긴 노드를 다시 이은 뒤 옛 값을 주는 시간이 12초를 넘겼는데 컨테이너의 네트워크를 다시 붙이는 방식에서 온 값일 수 있어 본문에 쓰지 않았습니다.
- PostgreSQL은 16.15입니다. 재시작 실험은 처음에 데이터를 메모리 파일 시스템에 둔 탓에 재시작과 함께 데이터가 지워졌고 디스크 볼륨으로 바꿔 다시 실행했습니다. 나머지는 메모리 파일 시스템입니다. 두 DB에 걸친 2PC는 스크립트가 조정자 노릇을 했고 트랜잭션 관리자 제품을 쓴 것이 아닙니다.
- Kafka는 3.9.0 한 대(KRaft)이고 클라이언트는 librdkafka 2.16.0입니다. 브로커가 한 대여서 복제와 조정자 교체는 일어나지 않았습니다. 소비자가 받은 시각은 프로듀서의 전송이 확인된 시각부터 잰 값입니다.
- 2장의 표는 계산 예시이고 측정이 아닙니다.
- 회사 사례의 수치는 각 회사가 공개한 글과 논문의 값입니다.

## 참고

뼈대로 삼은 글

- [Replication（下）：事务，一致性与共识 (美团技术团队, 2021-08-25)](https://tech.meituan.com/2021/08/25/Replication-in-meituan-02.html)
- [Replication（上）：常见复制模型&分布式系统挑战 (美团技术团队, 2021-08-25)](https://tech.meituan.com/2021/08/25/Replication-in-meituan-01.html)

회사 사례

- [Google, Paxos Made Live: An Engineering Perspective (2007)](https://static.googleusercontent.com/media/research.google.com/en//archive/paxos_made_live.pdf)
- [Roblox, Roblox Return to Service 10/28-10/31 2021 (2022)](https://corp.roblox.com/newsroom/2022/01/roblox-return-to-service-10-28-10-31-2021)
- [Amazon, Use of Formal Methods at Amazon Web Services (2014)](https://lamport.azurewebsites.net/tla/formal-methods-amazon.pdf)
- [PingCAP, TiDB 5.0 Release Notes](https://docs.pingcap.com/tidb/stable/release-5.0.0/), [pingcap/tla-plus](https://github.com/pingcap/tla-plus)
- [OceanBase: A 707 Million tpmC Distributed Relational Database System (VLDB 2022)](https://www.vldb.org/pvldb/vol15/p3385-xu.pdf)
- [Tencent, PaxosStore: High-availability Storage Made Practical in WeChat (VLDB 2017)](http://www.vldb.org/pvldb/vol10/p1730-lin.pdf)
- [美团, Leaf——美团点评分布式ID生成系统 (2017)](https://tech.meituan.com/2017/04/21/mt-leaf.html)
- [美团, 消息队列设计精要 (2016)](https://tech.meituan.com/2016/07/01/mq-design.html)
- [SOFAJRaft 사용 안내](https://www.sofastack.tech/projects/sofa-jraft/jraft-user-guide/)
- [Confluent, Transactions in Apache Kafka (2017)](https://www.confluent.io/blog/transactions-apache-kafka/)

논문과 분석

- [Gray & Lamport, Consensus on Transaction Commit (2004)](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/tr-2003-96.pdf)
- [Lamport, Time, Clocks, and the Ordering of Events in a Distributed System (1978)](https://lamport.azurewebsites.net/pubs/time-clocks.pdf)
- [Martin Kleppmann, How to do distributed locking (2016)](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html)
- [Jepsen, etcd 3.4.3 (2020)](https://jepsen.io/analyses/etcd-3.4.3)

공식 문서

- [etcd, KV API guarantees](https://etcd.io/docs/v3.5/learning/api_guarantees/)
- [ZooKeeper Programmer's Guide: Consistency Guarantees](https://zookeeper.apache.org/doc/current/zookeeperProgrammers.html)
- [PostgreSQL 16, PREPARE TRANSACTION](https://www.postgresql.org/docs/16/sql-prepare-transaction.html)
- [Apache Kafka, Consumer Configs (isolation.level)](https://kafka.apache.org/39/generated/consumer_config.html), [Producer Configs (transaction.timeout.ms)](https://kafka.apache.org/39/generated/producer_config.html), [Topic Configs (min.insync.replicas)](https://kafka.apache.org/39/generated/topic_config.html)
- [KIP-98: Exactly Once Delivery and Transactional Messaging](https://cwiki.apache.org/confluence/display/KAFKA/KIP-98+-+Exactly+Once+Delivery+and+Transactional+Messaging)
- [KIP-890: Transactions Server-Side Defense](https://cwiki.apache.org/confluence/display/KAFKA/KIP-890%3A+Transactions+Server-Side+Defense)

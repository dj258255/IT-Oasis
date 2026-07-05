---
title: 'DB 내부 ⑩: Raft — primary가 죽으면 누가 결정하는가, 합의에서 HA DB까지'
titleEn: 'DB Internals ⑩: Raft — Who Decides When the Primary Dies? From Consensus to an HA Database'
description: "복제의 최대 약점은 'primary가 죽으면?'이다 — replica 승격을 사람이 하면 밤에 전화가 오고, 자동으로 하면 split-brain이 온다. 이건 결국 합의(consensus) 문제고, 답이 Raft다. 리더 선출(임기·과반·무작위 타임아웃), 로그 복제(prevLogIndex 정합 검사), 그리고 '과반에 있어도 현재 임기여야만 커밋'이라는 §5.4.2의 미묘함까지 — 다섯 안전성 성질을 결정적 시뮬레이션 네트워크(분단·크래시·재정렬을 재현 가능하게 주입) 위에서 확인한다. 이어서 프로덕션의 조각들: 재시작 후 이중 투표를 막는 지속성(currentTerm/votedFor fsync, §5.1), 무한히 크는 로그를 자르는 스냅샷(§7 — 그리고 오프셋 0이 no-op이라 기존 테스트가 버그를 못 잡는 함정), 돌아가는 중에 노드를 넣고 빼는 멤버십 변경(§6 — 겹치는 과반), 상태기계 복제(SMR)로 진짜 SQL 엔진을 복제해 리더가 죽어도 살아남는 HA DB, 마지막으로 파티션된 옛 리더가 낡은 값을 주지 않게 하는 선형화 읽기(ReadIndex, §8)까지. 적대적 리뷰가 잡아낸 실제 버그들(스냅샷 미설치 발산, apply 에러 무시, read barrier의 epoch 부재)이 각 절의 정직한 경계다."
descriptionEn: "Replication's greatest weakness is 'what if the primary dies?' — promote replicas by hand and you get 3am pages; automate it and you get split-brain. It's a consensus problem, and the answer is Raft. Leader election (terms, majorities, randomized timeouts), log replication (the prevLogIndex consistency check), and §5.4.2's subtlety — 'replicated on a majority' still isn't committable unless it's from the current term — all five safety properties verified on a deterministic simulated network (partitions, crashes, reordering injected reproducibly). Then the production pieces: persistence that prevents double-voting across restarts (fsynced currentTerm/votedFor, §5.1), snapshots that trim the unbounded log (§7 — plus the trap that offset 0 makes it a no-op existing tests can't catch), membership changes while running (§6 — overlapping majorities), state-machine replication (SMR) replicating a real SQL engine into an HA DB that survives leader death, and finally linearizable reads (ReadIndex, §8) that stop a partitioned old leader from serving stale data. The real bugs adversarial reviews caught — snapshot-not-installed divergence, swallowed apply errors, a read barrier missing its epoch — are each section's honest boundary."
date: 2026-07-05T00:00:00.000Z
tags:
  - Database Internals
  - Raft
  - Consensus
  - Distributed Systems
  - High Availability
  - C
category: project/db-hobby
coverImage: /uploads/project/db-hobby/cover.svg
draft: false
series: "미니 DB로 이해하는 DB 내부"
seriesOrder: 10
---

## 0. 들어가며 — 복제가 답하지 못한 질문

[9편](/blog/project/db-hobby/db-internals-09-replication)의 복제는 primary가 살아 있는 동안만 이야기예요. primary가 죽으면? replica를 승격해야 하는데 — **누가, 언제, 어느 replica를?** 사람이 하면 새벽에 전화가 오고, 스크립트로 자동화하면 더 무서운 게 옵니다: 네트워크가 잠깐 끊겼을 뿐인데 양쪽이 서로 "내가 primary"라며 **둘 다 쓰기를 받는 split-brain.**

이건 결국 **합의(consensus)** 문제입니다 — "지금 리더가 누구인가"에 대해, 일부가 죽거나 끊겨도 나머지가 **하나의 답**에 동의하는 것. Paxos가 원조지만 악명 높게 어렵고, 2014년 Diego Ongaro의 **Raft**가 "이해 가능성"을 설계 목표로 같은 문제를 풉니다. etcd·Consul·TiKV·CockroachDB가 Raft 위에 서 있어요.

이 편은 Raft를 합의 코어부터 지어 올려, **진짜 SQL 엔진을 복제해 리더가 죽어도 살아남는 HA DB**, 그리고 **읽기까지 선형화**하는 데까지 갑니다. 각 절의 끝엔 적대적 리뷰가 잡아낸 **실제 버그**가 있어요 — 합의 코드는 "그럴듯하게 맞는" 상태가 제일 위험하거든요.

## 1. 합의 코어 — 선출, 복제, 그리고 §5.4.2의 미묘함

Raft의 뼈대는 셋입니다.

**리더 선출.** 시간은 **임기(term)** 로 나뉘고, 노드는 leader/follower/candidate 중 하나예요. follower가 리더의 하트비트를 일정 시간 못 받으면 candidate가 되어 임기를 올리고 `RequestVote`를 뿌립니다. **과반**의 표를 받으면 리더 — 과반은 겹치므로 한 임기에 리더는 최대 하나예요(Election Safety). 동시 입후보로 표가 갈리는 split vote는 **무작위 선거 타임아웃**이 흩어 줍니다.

**로그 복제.** 클라이언트의 명령은 리더의 로그에 append되고, `AppendEntries`로 follower에 복제돼요. 이때 각 메시지에 **직전 엔트리의 (index, term)** 을 실어 보내고, follower는 자기 로그의 그 자리와 일치할 때만 받습니다 — 불일치면 거부하고, 리더가 한 칸씩 물러나며 일치점을 찾아 그 뒤를 덮어써요. 이 **정합 검사**가 Log Matching(같은 index·term이면 그 이전 로그 전체가 같다)을 귀납적으로 보장합니다.

**커밋 — 그리고 §5.4.2의 미묘함.** 과반에 복제된 엔트리는 커밋되는데, 여기 함정이 있어요. 논문 Figure 8의 시나리오: **옛 임기의 엔트리는 과반에 있어도 그것만으론 커밋으로 칠 수 없습니다** — 나중에 더 높은 임기의 리더가 그걸 덮어쓸 수 있거든요. 그래서 리더는 **자기 현재 임기의 엔트리가 과반에 도달했을 때만** commit_index를 전진시키고, 그때 그 이전 것들이 함께 커밋됩니다. 선출 쪽의 짝이 **§5.4.1 선거 제한** — 투표자는 자기보다 로그가 낡은 후보에겐 표를 주지 않아요(그래서 커밋된 엔트리를 가진 노드만 리더가 될 수 있음 = Leader Completeness).

![Raft 합의 — 리더 선출(임기·과반), AppendEntries 정합 검사, 과반 커밋](/uploads/project/db-hobby/raft-consensus.svg)

### 어떻게 검증하나 — 결정적 시뮬레이션

합의 코드의 버그는 특정한 메시지 순서·분단 타이밍에서만 터져요. 진짜 소켓 위에선 그 스케줄을 **재현할 수 없습니다.** 그래서 테스트 하버스가 논리 시계·메시지 큐·분단 행렬을 전부 소유하는 **결정적 시뮬레이션 네트워크**를 씁니다 — 분단을 만들고, 특정 노드를 죽이고, 메시지를 재정렬하는 시나리오를 **똑같이 반복 재생**할 수 있어요. 리더를 소수파에 가두면 다수파가 새 리더를 뽑고, 옛 리더가 돌아오면 강등되고, 갈라진 로그가 정합 검사로 수렴하는 것까지 — 전부 재현 가능한 시나리오로 못박습니다. (TigerBeetle·FoundationDB가 결정적 시뮬레이션 테스트를 신조로 삼는 이유와 같아요.)

## 2. 지속성 — 재시작한 노드가 두 번 투표하면

합의는 메모리로 끝나지 않아요. **§5.1: currentTerm과 votedFor는 응답 전에 안정 저장소에 있어야 합니다.** 왜냐면 — 노드가 임기 5에서 A에게 투표하고 크래시 후 재시작하면, votedFor를 잊은 채 같은 임기 5에서 B에게 **또 투표**할 수 있어요. 그럼 A와 B가 같은 임기에 각각 과반을 꾸려 **리더 둘** — Election Safety가 무너집니다.

그래서 투표·임기 변경은 응답을 보내기 **전에** fsync돼야 해요. [3편의 WAL 규칙](/blog/project/db-hobby/db-internals-03-wal-recovery)("응답 전에 로그가 내구")과 정확히 같은 결이죠. 로그 엔트리도 마찬가지 — "복제됐다"고 ack한 엔트리가 크래시로 증발하면 과반 계산이 거짓이 됩니다.

![Raft 지속성 — votedFor를 fsync하지 않으면 재시작 후 이중 투표로 리더가 둘](/uploads/project/db-hobby/raft-persistence.svg)

## 3. 스냅샷 — 로그는 무한히 클 수 없다

로그가 진실의 전부면 로그는 무한히 자랍니다. **§7 스냅샷**: 상태기계의 현재 상태를 통째로 찍고, 그 지점까지의 로그를 버려요(log compaction). 새로 합류하거나 한참 뒤처진 follower에겐 로그 대신 **InstallSnapshot**으로 스냅샷을 통째로 보냅니다. [3편의 체크포인트](/blog/project/db-hobby/db-internals-03-wal-recovery)("데이터가 로그를 따라잡았음을 선언하고 로그를 비움")의 분산판이에요.

구현의 핵심은 **오프셋 하나**입니다 — 로그를 자르면 배열 인덱스와 논리 인덱스가 어긋나므로, `log_base`(버린 로그 수)를 두고 모든 접근을 `logical - log_base`로 변환해요.

> **함정 — 기존 테스트는 이 버그를 못 잡는다**: `log_base = 0`이면 변환이 전부 no-op이라, 스냅샷을 안 찍는 기존 시나리오는 변환을 하나 빼먹어도 전부 통과한다. 스냅샷을 찍은 **뒤의** 선출·복제·복구 시나리오가 있어야 비로소 변환 누락이 드러난다. 실제로 적대적 리뷰가 이 영역에서 실버그를 잡았다 — **복구 시 스냅샷을 상태기계에 설치하지 않아**, 재시작한 노드의 상태기계가 스냅샷 이전 상태부터 로그를 적용해 **조용히 발산**하는 버그. "로드했다"와 "설치했다"는 다르다.

![Raft 스냅샷 — 상태기계를 찍고 로그를 자르고, 뒤처진 follower에겐 InstallSnapshot](/uploads/project/db-hobby/raft-snapshot.svg)

## 4. 멤버십 변경 — 돌아가는 중에 노드를 넣고 빼기

클러스터 구성 자체를 바꾸는 건 왜 위험할까요? 3노드에서 5노드로 한 번에 바꾸면, 옛 구성(과반=2)과 새 구성(과반=3)이 **서로 겹치지 않는 과반**을 동시에 꾸릴 수 있어요 — 리더 둘. 그래서 **§6 단일 서버 변경**: 노드를 **한 번에 하나씩만** 추가/제거합니다. 한 노드 차이면 옛/새 구성의 과반이 반드시 겹치거든요.

구성 변경은 특별한 로그 엔트리로 흘러요 — 그리고 미묘한 규칙: 노드는 구성 엔트리를 **커밋 전에, append 순간부터** 적용합니다(그래야 전환기의 과반 계산이 안전). 그럼 그 엔트리가 나중에 덮어써지면? **truncate 시 구성을 되돌리는** 처리가 필요하죠. 자기 자신을 제거하는 리더는 그 변경이 커밋된 뒤 스스로 물러나고요. 이 영역도 적대적 리뷰가 네 개의 실버그를 잡았어요(InstallSnapshot이 구성을 안 실어 나름, truncate가 구성을 안 되돌림, 커밋 대기 없는 연속 변경, 자기 제거 리더가 안 물러남) — **멤버십은 Raft에서 버그 밀도가 가장 높은 영역**이라는 논문 저자의 말이 실감 났습니다.

![Raft 멤버십 — 단일 서버 변경: 한 번에 하나면 옛/새 과반이 반드시 겹친다](/uploads/project/db-hobby/raft-membership.svg)

## 5. SMR — 진짜 SQL 엔진을 복제하는 HA DB

합의 코어가 서면, DB에 얹는 표준 패턴이 **상태기계 복제(SMR, State Machine Replication)** 입니다:

1. 쓰기(SQL)는 리더의 Raft 로그에 **제안**되고,
2. 과반 복제로 **커밋**되면,
3. **모든 노드가 커밋된 명령을 같은 순서로 자기 엔진에 적용**합니다 (`db_exec`).

같은 초기 상태 + 같은 명령을 같은 순서로 = 같은 최종 상태 (State Machine Safety가 이 순서를 보장). etcd가 KV를, TiKV·CockroachDB가 SQL 스토리지를 이렇게 복제해요.

이걸 진짜 엔진에 배선하면 — 3노드에 CREATE/INSERT를 흘리고 세 엔진의 SELECT가 완전히 일치하는지, 그리고 진짜 시험: **리더를 죽입니다.** 남은 둘이 새 리더를 뽑고(failover), 쓰기가 계속되고, 생존 노드들의 데이터가 여전히 일치해요. Leader Completeness가 "커밋된 쓰기는 새 리더에도 반드시 있다"를 보장하니까요. [9편](/blog/project/db-hobby/db-internals-09-replication)이 답 못 한 "primary가 죽으면?"의 답이 이겁니다 — **아무도 결정하지 않아도, 합의가 결정한다.**

> **적대적 리뷰가 잡은 버그**: apply가 `db_exec`의 실패를 **무시**하고 있었다. 한 노드에서만 적용이 실패하면 last_applied는 전진하는데 엔진은 안 바뀌어 — **그 노드만 조용히 발산**한다. SMR의 약속("같은 명령, 같은 상태")은 apply의 에러 처리까지 포함해야 지켜진다.

![Raft로 복제되는 HA DB — 쓰기는 합의로, 모든 노드가 커밋된 SQL을 자기 엔진에 적용, 리더가 죽어도 failover](/uploads/project/db-hobby/raft-replicated-db.svg)

## 6. 선형화 읽기 — 파티션된 옛 리더의 낡은 값

마지막 구멍. 쓰기는 합의를 거치는데 **읽기**는요? 아무 노드에서나 읽으면 뒤처진 값을 볼 수 있어요. "리더에서 읽으면 되지 않나?" — 가장 무서운 반례가 **파티션된 옛 리더**입니다: 자기가 강등된 걸 모른 채(하트비트가 안 닿을 뿐) 자기 상태기계에서 읽으면, 새 리더가 이미 커밋한 쓰기를 놓친 **낡은 값**을 줘요.

답이 **§8 ReadIndex**예요. 리더는 읽기를 서빙하기 전에:

1. 지금 `commit_index`를 **read index**로 잡고,
2. 하트비트 한 라운드에 **과반이 응답**하는지 확인하고 (— 지금도 내가 리더인가?),
3. 상태기계가 read index까지 적용된 뒤에야 읽습니다.

결정적 안전성: **파티션된 옛 리더는 과반 ack를 영영 못 받아 읽기가 거부됩니다.** 낡은 값을 주느니 거부. 그리고 확인에 성공했다면 과반이 이번 임기에 나를 인정한 것이므로, 그 사이 더 최신 커밋이 다른 곳에 존재할 수 없어요.

> **적대적 리뷰가 잡은 버그**: 배리어의 ack 집계가 "같은 임기의 성공 응답"이면 다 세고 있었다 — **배리어 이전에 발사된 하트비트의 응답**이 재정렬로 늦게 도착해도 세어져, 원리상 오확인이 가능했다(테스트 하버스의 스케줄 특성 때문에 우연히 안 터졌을 뿐). 수정: 배리어마다 **epoch**를 올려 하트비트에 싣고 응답에 에코시켜, **현재 epoch의 ack만** 센다. "안전이 코드가 아니라 테스트 하버스의 우연에 걸려 있는" 상태를 잡아낸 리뷰였다.

(대안인 leader lease는 시계 가정이 필요해서, 결정적 시뮬레이션과 맞는 ReadIndex를 골랐어요 — etcd도 기본이 ReadIndex입니다.)

![선형화 읽기 — 확인된 리더는 서빙, 파티션된 옛 리더는 과반 확인 실패로 거부](/uploads/project/db-hobby/raft-linearizable-read.svg)

## 7. 정리

- **failover는 합의 문제다** — 사람도 스크립트도 아닌, 과반의 동의가 리더를 정한다. split-brain은 "과반은 겹친다"로 원천 봉쇄.
- **합의 코어**: 임기+과반 선출(무작위 타임아웃), prevLog 정합 검사(Log Matching), 그리고 **현재 임기 과반만 커밋**(§5.4.2)과 **선거 제한**(§5.4.1)이 안전성의 심장.
- **검증은 결정적 시뮬레이션으로** — 분단·크래시·재정렬을 재현 가능하게. 합의 버그는 특정 스케줄에서만 터진다.
- **프로덕션의 조각들**: 지속성(§5.1 — 이중 투표 방지, WAL 규칙과 같은 결), 스냅샷(§7 — log_base=0이 no-op이라 새 시나리오가 필요), 멤버십(§6 — 한 번에 하나, 겹치는 과반).
- **SMR** — 커밋된 명령을 같은 순서로 모든 엔진에. 리더가 죽어도 살아남는 HA DB. apply의 에러 처리까지가 SMR의 약속.
- **ReadIndex** — 읽기 전에 "지금도 리더"를 과반으로 확인. 파티션된 옛 리더는 거부된다. epoch 없는 ack 집계는 재정렬에 뚫린다.
- **적대적 리뷰의 가치** — 스냅샷 미설치 발산, apply 에러 무시, epoch 부재: 전부 "테스트는 초록인데 원리상 틀린" 종류였다. 합의 코드는 독립적인 회의주의자가 필요하다.

이 시리즈는 여기까지예요 — 페이지 한 장에서 시작해, 진짜 psql이 붙고, MVCC로 격리하고, 병렬로 돌고, 합의로 복제되는 미니 DB까지. 각 편의 "정직한 경계"들이 다음 여정의 지도입니다.

## 참고 (1차 자료 우선)

- Diego Ongaro & John Ousterhout, *In Search of an Understandable Consensus Algorithm* (Raft, USENIX ATC 2014)
- Diego Ongaro, *Consensus: Bridging Theory and Practice* (PhD dissertation, 2014) — 멤버십·ReadIndex의 상세
- [etcd Documentation: Linearizability / ReadIndex](https://etcd.io/docs/)
- [TiKV Deep Dive: Consensus Algorithm](https://tikv.org/deep-dive/consensus-algorithm/)
- 본 블로그: [트랜잭션 ACID ③: Consistency](/blog/theory/transaction-acid-03-consistency)
- [db-hobby 코드 (GitHub)](https://github.com/dj258255/db-hobby) — `raft.c` · `raftdb.c` · `tests/test_raft.c`

<!-- EN -->

## 0. Introduction — the Question Replication Couldn't Answer

[Part 9](/blog/project/db-hobby/db-internals-09-replication)'s replication is a story only while the primary lives. When it dies, a replica must be promoted — **by whom, when, and which one?** Do it by hand and you get 3am pages; automate it with scripts and something scarier arrives: a brief network blip and both sides claim "I'm the primary," both accepting writes — **split-brain.**

This is ultimately a **consensus** problem — agreeing on **one answer** to "who is the leader now," even as some nodes die or disconnect. Paxos is the ancestor, notoriously hard; Diego Ongaro's 2014 **Raft** solves the same problem with understandability as an explicit design goal. etcd, Consul, TiKV, and CockroachDB stand on it.

This part builds Raft from the consensus core up — to **replicating a real SQL engine into an HA DB that survives leader death**, and to **linearizing reads.** Each section ends with a **real bug caught by adversarial review** — consensus code is most dangerous when it's plausibly correct.

## 1. The Consensus Core — Election, Replication, and §5.4.2's Subtlety

Raft's skeleton is threefold.

**Leader election.** Time divides into **terms**; nodes are leader/follower/candidate. A follower that misses heartbeats becomes a candidate, bumps the term, and broadcasts `RequestVote`. A **majority** of votes makes a leader — majorities overlap, so at most one leader per term (Election Safety). Split votes from simultaneous candidacies are dispersed by **randomized election timeouts.**

**Log replication.** Client commands append to the leader's log and replicate via `AppendEntries`. Each message carries the **(index, term) of the preceding entry**; a follower accepts only if its log matches at that position — otherwise it refuses, and the leader steps back until the logs agree, then overwrites from there. This **consistency check** inductively guarantees Log Matching (same index+term ⇒ identical logs up to there).

**Commit — and §5.4.2's subtlety.** An entry replicated on a majority commits — but there's a trap. The paper's Figure 8 scenario: **an entry from an older term, even on a majority, cannot be counted committed by that alone** — a later, higher-term leader can still overwrite it. So a leader advances commit_index **only when an entry of its own current term reaches a majority** — which then commits everything before it too. The election-side twin is the **§5.4.1 election restriction**: voters refuse candidates with staler logs — so only nodes holding all committed entries can become leader (Leader Completeness).

![Raft consensus — leader election (terms, majorities), the AppendEntries consistency check, majority commit](/uploads/project/db-hobby/raft-consensus.svg)

### How to Verify — Deterministic Simulation

Consensus bugs fire only under particular message orders and partition timings — schedules you **cannot reproduce** over real sockets. So the test harness owns a **deterministic simulated network** — logical clock, message queues, a partition matrix — able to **replay identical adversarial scenarios**: trap the leader in a minority, kill nodes, reorder messages. The minority-trapped leader demotes on return; diverged logs converge through the consistency check — all pinned as reproducible scenarios. (The same creed behind TigerBeetle's and FoundationDB's deterministic simulation testing.)

## 2. Persistence — a Restarted Node Voting Twice

Consensus doesn't end in memory. **§5.1: currentTerm and votedFor must be on stable storage before responding.** Why: a node votes for A in term 5, crashes, restarts having forgotten votedFor — and votes for B in the same term 5. A and B each assemble a majority: **two leaders.** Election Safety collapses.

So votes and term changes must be fsynced **before** the response leaves — exactly the same grain as [Part 3's WAL rule](/blog/project/db-hobby/db-internals-03-wal-recovery) ("durable before acknowledged"). Log entries likewise: an acked-but-evaporated entry falsifies majority arithmetic.

![Raft persistence — without fsyncing votedFor, a restart enables double voting: two leaders](/uploads/project/db-hobby/raft-persistence.svg)

## 3. Snapshots — the Log Cannot Grow Forever

If the log is the whole truth, it grows without bound. **§7 snapshots**: capture the state machine wholesale and discard the log up to that point (log compaction). For newly joining or badly lagging followers, ship the snapshot itself via **InstallSnapshot.** It's the distributed edition of [Part 3's checkpoint](/blog/project/db-hobby/db-internals-03-wal-recovery) ("declare data has caught up; clear the log").

The implementation crux is **one offset** — trimming desynchronizes array indexes from logical indexes, so keep `log_base` (entries discarded) and translate every access as `logical - log_base`.

> **The trap — existing tests can't catch this**: with `log_base = 0` every translation is a no-op, so all pre-snapshot scenarios pass even if you miss a translation. Only election/replication/recovery scenarios **after** a snapshot expose the omission. Adversarial review caught a real bug here — **recovery loaded the snapshot but never installed it into the state machine**, so a restarted node applied the log on top of pre-snapshot state and **silently diverged.** "Loaded" and "installed" are different words.

![Raft snapshots — capture the state machine, trim the log, InstallSnapshot for lagging followers](/uploads/project/db-hobby/raft-snapshot.svg)

## 4. Membership Changes — Adding and Removing Nodes While Running

Why is changing the cluster configuration itself dangerous? Jump from 3 to 5 nodes at once and the old configuration (majority=2) and new (majority=3) can assemble **disjoint majorities** simultaneously — two leaders. Hence **§6 single-server changes**: add/remove **one node at a time.** With a one-node delta, old and new majorities necessarily overlap.

Configuration changes flow as special log entries — with a subtle rule: nodes apply a config entry **from the moment it's appended, before commit** (so majority arithmetic is safe during the transition). Then what if that entry is later overwritten? You need **config reversion on truncation.** And a leader removing itself steps down after the change commits. Adversarial review caught four real bugs in this area (InstallSnapshot not carrying the config; truncation not reverting it; back-to-back changes without commit-wait; a self-removing leader not stepping down) — the paper author's remark that **membership is Raft's most bug-dense area** rang true.

![Raft membership — single-server changes: one at a time keeps old/new majorities overlapping](/uploads/project/db-hobby/raft-membership.svg)

## 5. SMR — an HA Database Replicating a Real SQL Engine

With the core standing, the standard pattern for a DB is **state machine replication (SMR)**:

1. writes (SQL) are **proposed** into the leader's Raft log,
2. **committed** by majority replication,
3. and **every node applies committed commands to its own engine in the same order** (`db_exec`).

Same initial state + same commands in the same order = same final state (State Machine Safety guarantees the order). etcd replicates a KV this way; TiKV and CockroachDB replicate SQL storage.

Wired to the real engine: stream CREATE/INSERTs at a 3-node cluster and check all three engines' SELECTs match — then the real test: **kill the leader.** The remaining two elect a new one (failover), writes continue, and the survivors still agree — Leader Completeness guarantees committed writes exist on any new leader. This is the answer to [Part 9](/blog/project/db-hobby/db-internals-09-replication)'s open question — **nobody decides, and yet consensus decides.**

> **Bug caught by adversarial review**: apply was **swallowing** `db_exec` failures. If application fails on just one node, last_applied advances while the engine doesn't change — **that node silently diverges.** SMR's promise ("same commands, same state") holds only if apply's error handling is part of it.

![The Raft-replicated HA DB — writes go through consensus; every node applies committed SQL to its own engine; failover survives leader death](/uploads/project/db-hobby/raft-replicated-db.svg)

## 6. Linearizable Reads — the Partitioned Old Leader's Stale Data

The last hole. Writes pass through consensus — but **reads**? Read from any node and you can see lag. "Just read from the leader?" — the scariest counterexample is the **partitioned old leader**: unaware it's been deposed (heartbeats simply aren't arriving), it reads its own state machine and serves a **stale value**, missing writes the new leader already committed.

The answer is **§8 ReadIndex.** Before serving a read, the leader:

1. captures the current `commit_index` as the **read index**,
2. confirms **a majority responds** to one round of heartbeats (— am I still the leader?),
3. and serves only after the state machine has applied up to the read index.

The decisive safety: **a partitioned old leader never gets its majority ack, so the read is refused.** Refusal over staleness. And if confirmation succeeds, a majority acknowledged this term's leader — no newer commit can exist elsewhere in the meantime.

> **Bug caught by adversarial review**: the barrier's ack counting accepted any same-term success reply — so a reply to a heartbeat **fired before the barrier**, arriving late under reordering, could falsely confirm (it hadn't fired only due to the harness's scheduling habits). Fix: bump an **epoch** per barrier, carry it in heartbeats, echo it in replies, and count **only current-epoch acks.** A review that caught safety resting on a harness accident rather than the code.

(The alternative — leader leases — needs clock assumptions, so ReadIndex fit the deterministic simulation better. etcd's default is ReadIndex too.)

![Linearizable reads — a confirmed leader serves; a partitioned old leader fails quorum confirmation and refuses](/uploads/project/db-hobby/raft-linearizable-read.svg)

## 7. Wrap-up

- **Failover is a consensus problem** — neither humans nor scripts but majority agreement chooses the leader. Split-brain is foreclosed by "majorities overlap."
- **The core**: term+majority election (randomized timeouts), the prevLog consistency check (Log Matching), and the heart of safety — **commit only current-term majorities** (§5.4.2) plus the **election restriction** (§5.4.1).
- **Verify by deterministic simulation** — partitions, crashes, reordering, reproducibly. Consensus bugs fire only on particular schedules.
- **The production pieces**: persistence (§5.1 — double-vote prevention, same grain as the WAL rule), snapshots (§7 — log_base=0 is a no-op, demanding new scenarios), membership (§6 — one at a time, overlapping majorities).
- **SMR** — committed commands to every engine in the same order; an HA DB surviving leader death. Apply's error handling is part of SMR's promise.
- **ReadIndex** — confirm "still leader" by majority before reading; the partitioned old leader is refused. Epoch-less ack counting falls to reordering.
- **The value of adversarial review** — snapshot-not-installed divergence, swallowed apply errors, the missing epoch: all of the "tests green, wrong in principle" kind. Consensus code needs an independent skeptic.

That's the series — from one page, to a DB a real psql connects to, isolated by MVCC, running in parallel, and replicated by consensus. Each part's "honest boundaries" are the map for the next journey.

## References (primary sources first)

- Diego Ongaro & John Ousterhout, *In Search of an Understandable Consensus Algorithm* (Raft, USENIX ATC 2014)
- Diego Ongaro, *Consensus: Bridging Theory and Practice* (PhD dissertation, 2014)
- [etcd Documentation: Linearizability / ReadIndex](https://etcd.io/docs/)
- [TiKV Deep Dive: Consensus Algorithm](https://tikv.org/deep-dive/consensus-algorithm/)
- This blog: [Transaction ACID ③: Consistency](/blog/theory/transaction-acid-03-consistency)
- [db-hobby source (GitHub)](https://github.com/dj258255/db-hobby) — `raft.c` · `raftdb.c` · `tests/test_raft.c`

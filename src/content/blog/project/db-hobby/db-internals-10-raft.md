---
title: 'DB 내부 ⑩: Raft, primary가 죽으면 누가 결정하는가, 합의에서 HA DB까지'
titleEn: 'DB Internals ⑩: Raft — Who Decides When the Primary Dies? From Consensus to an HA Database'
description: "복제의 최대 약점은 'primary가 죽으면?'이다. replica 승격을 사람이 하면 밤에 전화가 오고, 자동으로 하면 split-brain이 온다. 이건 결국 합의(consensus) 문제고, 답이 Raft다. 리더 선출(임기·과반·무작위 타임아웃), 로그 복제(prevLogIndex 정합 검사), 그리고 '과반에 있어도 현재 임기여야만 커밋'이라는 §5.4.2의 미묘함까지, 다섯 안전성 성질을 결정적 시뮬레이션 네트워크(분단·크래시·재정렬을 재현 가능하게 주입) 위에서 확인한다. 이어서 프로덕션의 조각들: 재시작 후 이중 투표를 막는 지속성(currentTerm/votedFor fsync, §5.1), 무한히 크는 로그를 자르는 스냅샷(§7, 그리고 오프셋 0이 no-op이라 기존 테스트가 버그를 못 잡는 함정), 돌아가는 중에 노드를 넣고 빼는 멤버십 변경(§6, 겹치는 과반), 상태기계 복제(SMR)로 진짜 SQL 엔진을 복제해 리더가 죽어도 살아남는 HA DB, 마지막으로 파티션된 옛 리더가 낡은 값을 주지 않게 하는 선형화 읽기(ReadIndex, §8)까지. 적대적 리뷰가 잡아낸 실제 버그들(스냅샷 미설치 발산, apply 에러 무시, read barrier의 epoch 부재)이 각 절의 정직한 경계다."
descriptionEn: "Replication's greatest weakness is 'what if the primary dies?' — promote replicas by hand and you get 3am pages; automate it and you get split-brain. It's a consensus problem, and the answer is Raft. Leader election (terms, majorities, randomized timeouts), log replication (the prevLogIndex consistency check), and §5.4.2's subtlety — 'replicated on a majority' still isn't committable unless it's from the current term — all five safety properties verified on a deterministic simulated network (partitions, crashes, reordering injected reproducibly). Then the production pieces: persistence that prevents double-voting across restarts (fsynced currentTerm/votedFor, §5.1), snapshots that trim the unbounded log (§7 — plus the trap that offset 0 makes it a no-op existing tests can't catch), membership changes while running (§6 — overlapping majorities), state-machine replication (SMR) replicating a real SQL engine into an HA DB that survives leader death, and finally linearizable reads (ReadIndex, §8) that stop a partitioned old leader from serving stale data. The real bugs adversarial reviews caught — snapshot-not-installed divergence, swallowed apply errors, a read barrier missing its epoch — are each section's honest boundary."
date: 2026-06-26T00:00:00.000Z
tags:
  - Database Internals
  - Raft
  - Consensus
  - Distributed Systems
  - High Availability
  - C
category: study/db-hobby
coverImage: /uploads/project/db-hobby/cover.svg
draft: false
series: "미니 DB로 이해하는 DB 내부"
seriesOrder: 10
---

## 0. 들어가며: 복제가 답하지 못한 질문

[9편](/blog/project/db-hobby/db-internals-09-replication)의 복제는 primary가 살아 있는 동안만 이야기입니다. primary가 죽으면? replica를 승격해야 하는데, **누가, 언제, 어느 replica를?** 사람이 하면 새벽에 전화가 오고, 스크립트로 자동화하면 더 무서운 게 옵니다: 네트워크가 잠깐 끊겼을 뿐인데 양쪽이 서로 "내가 primary"라며 **둘 다 쓰기를 받는 split-brain.**

이건 결국 **합의(consensus)** 문제입니다. "지금 리더가 누구인가"에 대해, 일부가 죽거나 끊겨도 나머지가 **하나의 답**에 동의하는 것입니다. Paxos가 원조지만 악명 높게 어렵고, 2014년 발표된 Ongaro와 Ousterhout의 **Raft**가 "이해 가능성"을 설계 목표로 같은 문제를 풉니다. etcd·Consul·TiKV·CockroachDB가 Raft 위에 서 있습니다.

이 편은 Raft를 합의 코어부터 지어 올려, **진짜 SQL 엔진을 복제해 리더가 죽어도 살아남는 HA DB**, 그리고 **읽기까지 선형화**하는 데까지 갑니다. 각 절의 끝엔 적대적 리뷰가 잡아낸 **실제 버그**가 있습니다. 합의 코드는 "그럴듯하게 맞는" 상태가 제일 위험하기 때문입니다.

## 1. 합의 코어: 선출, 복제, 그리고 §5.4.2의 미묘함

Raft의 뼈대는 셋입니다.

**리더 선출.** 시간은 **임기(term)** 로 나뉘고, 노드는 leader/follower/candidate 중 하나입니다. follower가 리더의 하트비트를 일정 시간 못 받으면 candidate가 되어 임기를 올리고 `RequestVote`를 뿌립니다. **과반**의 표를 받으면 리더입니다. 과반은 겹치고, **겹친 노드는 한 임기에 한 표만 주므로**(votedFor), 한 임기에 리더는 최대 하나입니다(Election Safety). 동시 입후보로 표가 갈리는 split vote는 **무작위 선거 타임아웃**이 흩어 줍니다.

실전에는 선출을 흔드는 변수가 하나 더 있습니다. 파티션돼 있던 노드는 하트비트를 못 받아 혼자 임기를 계속 올립니다. 파티션이 풀려 복귀하는 순간, 부풀려진 임기가 멀쩡히 일하던 리더를 강등시킵니다(Ongaro 박사논문 §9.6이 말하는 disruptive server). 그래서 etcd 같은 구현은 **Pre-Vote**(본선거 전에 "내가 이기겠나"를 임기를 올리지 않고 타진)와 **CheckQuorum**(과반과 통신하지 못하는 리더의 자진 강등)을 얹습니다. 미니 DB는 결정적 시뮬레이션 안이라 이 확장 없이 기본형을 유지했습니다.

**로그 복제.** 클라이언트의 명령은 리더의 로그에 append되고, `AppendEntries`로 follower에 복제됩니다. 이때 각 메시지에 **직전 엔트리의 (index, term)** 을 실어 보내고, follower는 자기 로그의 그 자리와 일치할 때만 받습니다. 불일치면 거부하고, 리더가 한 칸씩 물러나며 일치점을 찾아 그 뒤를 덮어씁니다. 이 **정합 검사**가 Log Matching(같은 index·term이면 그 이전 로그 전체가 같다)을 귀납적으로 보장합니다.

**커밋, 그리고 §5.4.2의 미묘함.** 과반에 복제된 엔트리는 커밋되는데, 여기 함정이 있습니다. 논문 Figure 8의 시나리오: **옛 임기의 엔트리는 과반에 있어도 그것만으론 커밋으로 칠 수 없습니다.** 나중에 더 높은 임기의 리더가 그걸 덮어쓸 수 있기 때문입니다. 논문의 표현 그대로 *"Raft never commits log entries from previous terms by counting replicas."*(§5.4.2) 그래서 리더는 **자기 현재 임기의 엔트리가 과반에 도달했을 때만** commit_index를 전진시키고, 그때 그 이전 것들이 함께 커밋됩니다. 선출 쪽의 짝이 **§5.4.1 선거 제한**입니다. 투표자는 자기보다 로그가 낡은 후보에겐 표를 주지 않습니다(그래서 커밋된 엔트리를 가진 노드만 리더가 될 수 있음 = Leader Completeness).

![Raft 합의: 리더 선출(임기·과반), AppendEntries 정합 검사, 과반 커밋](/uploads/project/db-hobby/raft-consensus.svg)

### 어떻게 검증하나: 결정적 시뮬레이션

합의 코드의 버그는 특정한 메시지 순서·분단 타이밍에서만 터집니다. 진짜 소켓 위에선 그 스케줄을 **재현할 수 없습니다.** 그래서 테스트 하버스가 논리 시계·메시지 큐·분단 행렬을 전부 소유하는 **결정적 시뮬레이션 네트워크**를 씁니다. 분단을 만들고, 특정 노드를 죽이고, 메시지를 재정렬하는 시나리오를 **똑같이 반복 재생**할 수 있습니다. 리더를 소수파에 가두면 다수파가 새 리더를 뽑고, 옛 리더가 돌아오면 강등되고, 갈라진 로그가 정합 검사로 수렴하는 것까지 전부 재현 가능한 시나리오로 못박습니다. (TigerBeetle·FoundationDB가 결정적 시뮬레이션 테스트를 신조로 삼는 이유와 같습니다.)

## 2. 지속성: 재시작한 노드가 두 번 투표하면

합의는 메모리로 끝나지 않습니다. **§5.1: currentTerm과 votedFor는 응답 전에 안정 저장소에 있어야 합니다.** 왜냐면 노드가 임기 5에서 A에게 투표하고 크래시 후 재시작하면, votedFor를 잊은 채 같은 임기 5에서 B에게 **또 투표**할 수 있습니다. 그럼 A와 B가 같은 임기에 각각 과반을 꾸려 **리더 둘**이 되어 Election Safety가 무너집니다.

그래서 투표·임기 변경은 응답을 보내기 **전에** fsync돼야 합니다. [3편의 WAL 규칙](/blog/project/db-hobby/db-internals-03-wal-recovery)("응답 전에 로그가 내구")과 정확히 같은 결입니다. 로그 엔트리도 마찬가지입니다. "복제됐다"고 ack한 엔트리가 크래시로 증발하면 과반 계산이 거짓이 됩니다.

비용도 정면으로 보면, 엔트리마다 fsync 하나씩이면 합의 처리량의 병목은 CPU도 네트워크도 아닌 디스크 플러시가 됩니다. 그래서 etcd 같은 프로덕션 구현은 여러 엔트리·여러 응답을 한 번의 fsync에 묶습니다. [3편의 group commit](/blog/project/db-hobby/db-internals-03-wal-recovery)이 동시 커밋의 fsync를 묶던 것과 정확히 대칭인 이야기입니다.

![Raft 지속성: votedFor를 fsync하지 않으면 재시작 후 이중 투표로 리더가 둘](/uploads/project/db-hobby/raft-persistence.svg)

## 3. 스냅샷: 로그는 무한히 클 수 없다

로그가 진실의 전부면 로그는 무한히 자랍니다. **§7 스냅샷**: 상태기계의 현재 상태를 통째로 찍고, 그 지점까지의 로그를 버립니다(log compaction). 새로 합류하거나 한참 뒤처진 follower에겐 로그 대신 **InstallSnapshot**으로 스냅샷을 통째로 보냅니다. [3편의 체크포인트](/blog/project/db-hobby/db-internals-03-wal-recovery)("데이터가 로그를 따라잡았음을 선언하고 로그를 비움")의 분산판입니다.

구현의 핵심은 **오프셋 하나**입니다. 로그를 자르면 배열 인덱스와 논리 인덱스가 어긋나므로, `log_base`(버린 로그 수)를 두고 모든 접근을 `logical - log_base`로 변환합니다.

> **함정, 기존 테스트는 이 버그를 못 잡는다**: `log_base = 0`이면 변환이 전부 no-op이라, 스냅샷을 안 찍는 기존 시나리오는 변환을 하나 빼먹어도 전부 통과한다. 스냅샷을 찍은 **뒤의** 선출·복제·복구 시나리오가 있어야 비로소 변환 누락이 드러난다. 실제로 적대적 리뷰가 이 영역에서 실버그를 잡았다. **복구 시 스냅샷을 상태기계에 설치하지 않아**, 재시작한 노드의 상태기계가 스냅샷 이전 상태부터 로그를 적용해 **조용히 발산**하는 버그다. "로드했다"와 "설치했다"는 다르다.

![Raft 스냅샷: 상태기계를 찍고 로그를 자르고, 뒤처진 follower에겐 InstallSnapshot](/uploads/project/db-hobby/raft-snapshot.svg)

## 4. 멤버십 변경: 돌아가는 중에 노드를 넣고 빼기

클러스터 구성 자체를 바꾸는 건 왜 위험할까요? 3노드에서 5노드로 한 번에 바꾸면, 옛 구성(과반=2)과 새 구성(과반=3)이 **서로 겹치지 않는 과반**을 동시에 꾸릴 수 있습니다. 리더가 둘이 되는 것입니다. 논문 §6의 답은 **joint consensus**, 옛/새 구성의 과반을 둘 다 요구하는 과도기 구성(C_old,new)을 거치는 2단계 프로토콜입니다. 더 단순한 대안이 Ongaro 박사논문(2014) 4장의 **단일 서버 변경**입니다. 노드를 **한 번에 하나씩만** 추가/제거합니다. 한 노드 차이면 옛/새 구성의 과반이 반드시 겹치기 때문입니다. 미니 DB가 구현한 건 이쪽입니다.

(덧붙여 정족수 산수 하나. 4노드의 허용 장애 수는 3노드와 똑같이 1입니다(과반=3). 짝수 번째 노드는 가용성을 안 늘리고 정족수만 키웁니다. 이것이 합의 클러스터를 홀수로 꾸리는 이유입니다.)

구성 변경은 특별한 로그 엔트리로 흐릅니다. 그리고 미묘한 규칙이 있습니다: 노드는 구성 엔트리를 **커밋 전에, append 순간부터** 적용합니다(그래야 전환기의 과반 계산이 안전). 그럼 그 엔트리가 나중에 덮어써지면? **truncate 시 구성을 되돌리는** 처리가 필요합니다. 자기 자신을 제거하는 리더는 그 변경이 커밋된 뒤 스스로 물러납니다. 이 영역도 적대적 리뷰가 네 개의 실버그를 잡았습니다(InstallSnapshot이 구성을 안 실어 나름, truncate가 구성을 안 되돌림, 커밋 대기 없는 연속 변경, 자기 제거 리더가 안 물러남). **멤버십은 저자 스스로 안전성 버그를 공지했을 만큼**(2015년 raft-dev) 미묘한 영역이라는 게 실감 났습니다.

> **흔한 오해 정정**: *"노드는 한 번에 하나씩만 바꾸면 항상 안전하다?"* 아닙니다. 2015년 Ongaro가 raft-dev 메일링 리스트에 직접 공지한 버그: 단일 변경이라도 **리더 교체와 겹치면** 서로 충돌하는 두 구성이 각각 커밋될 수 있습니다. 수정은 *"리더는 자기 현재 임기의 엔트리를 하나 커밋하기 전에는 새 구성 엔트리를 append하면 안 된다"* 입니다. 위의 '커밋 대기 없는 연속 변경' 버그와 같은 계열의 함정입니다(직전 변경/임기에서 무엇이 커밋됐는지 확인하지 않고 다음 구성을 밀어 넣는 것). §5.4.2가 커밋에 걸었던 "현재 임기" 조건이 멤버십에서도 반복되는 셈입니다.

![Raft 멤버십, 단일 서버 변경: 한 번에 하나면 옛/새 과반이 반드시 겹친다](/uploads/project/db-hobby/raft-membership.svg)

## 5. SMR: 진짜 SQL 엔진을 복제하는 HA DB

합의 코어가 서면, DB에 얹는 표준 패턴이 **상태기계 복제(SMR, State Machine Replication)** 입니다:

1. 쓰기(SQL)는 리더의 Raft 로그에 **제안**되고,
2. 과반 복제로 **커밋**되면,
3. **모든 노드가 커밋된 명령을 같은 순서로 자기 엔진에 적용**합니다 (`db_exec`).

같은 초기 상태 + 같은 명령을 같은 순서로 = 같은 최종 상태입니다. 단, **명령이 결정적일 때만**입니다(State Machine Safety가 보장하는 건 순서까지). `NOW()`나 `RANDOM()` 같은 비결정 요소가 명령에 섞이면 같은 순서로 적용해도 노드마다 다른 값을 계산해 발산합니다. MySQL statement-based replication의 고전적인 함정이고, CockroachDB가 SQL 텍스트가 아니라 결정적인 KV 연산 레벨에서 Raft를 돌리는 이유입니다. 미니 DB의 SQL 부분집합에는 그런 비결정 함수가 없어서 텍스트 그대로 복제해도 성립합니다. etcd가 KV를, TiKV·CockroachDB가 SQL 스토리지를 이렇게 복제합니다.

이걸 진짜 엔진에 배선해 봅니다. 3노드에 CREATE/INSERT를 흘리고 세 엔진의 SELECT가 완전히 일치하는지 확인하고, 진짜 시험으로 **리더를 죽입니다.** 남은 둘이 새 리더를 뽑고(failover), 쓰기가 계속되고, 생존 노드들의 데이터가 여전히 일치합니다. Leader Completeness가 "커밋된 쓰기는 새 리더에도 반드시 있다"를 보장하기 때문입니다. [9편](/blog/project/db-hobby/db-internals-09-replication)이 답 못 한 "primary가 죽으면?"의 답이 이겁니다. **아무도 결정하지 않아도, 합의가 결정한다.**

> **적대적 리뷰가 잡은 버그**: apply가 `db_exec`의 실패를 **무시**하고 있었다. 한 노드에서만 적용이 실패하면 last_applied는 전진하는데 엔진은 안 바뀌어 **그 노드만 조용히 발산**한다. SMR의 약속("같은 명령, 같은 상태")은 apply의 에러 처리까지 포함해야 지켜진다.

SMR에는 구멍이 하나 더 남아 있습니다. **클라이언트 재시도**입니다. 리더가 명령을 apply까지 마치고 응답을 보내기 직전에 죽으면, 클라이언트는 타임아웃으로 재시도하고 같은 INSERT가 **두 번** 적용될 수 있습니다. 박사논문 §6.3의 처방은 세션 + 일련번호 dedup입니다. *"clients assign unique serial numbers to every command"*, 상태기계가 세션별 최신 일련번호와 응답을 기억해 중복을 걸러내는 방식입니다. 미니 DB에는 이 계층이 없습니다. 합의가 주는 건 "커밋된 명령의 전체 순서"까지고, exactly-once 의미론은 그 위에 따로 지어야 하는 계약이라는 걸 정직한 경계로 남깁니다.

![Raft로 복제되는 HA DB: 쓰기는 합의로, 모든 노드가 커밋된 SQL을 자기 엔진에 적용, 리더가 죽어도 failover](/uploads/project/db-hobby/raft-replicated-db.svg)

## 6. 선형화 읽기: 파티션된 옛 리더의 낡은 값

마지막 구멍. 쓰기는 합의를 거치는데 **읽기**는요? 아무 노드에서나 읽으면 뒤처진 값을 볼 수 있습니다. "리더에서 읽으면 되지 않나?" 가장 무서운 반례가 **파티션된 옛 리더**입니다: 자기가 강등된 걸 모른 채(하트비트가 안 닿을 뿐) 자기 상태기계에서 읽으면, 새 리더가 이미 커밋한 쓰기를 놓친 **낡은 값**을 줍니다.

답이 **§8 ReadIndex**입니다(절차의 상세는 박사논문 §6.4). 리더는 읽기를 서빙하기 전에:

0. **자기 현재 임기의 엔트리를 최소 하나 커밋한 상태**여야 하고(그래서 리더는 선출 직후 no-op 엔트리를 커밋합니다),
1. 지금 `commit_index`를 **read index**로 잡고,
2. 하트비트 한 라운드에 **과반이 응답**하는지 확인하고(지금도 내가 리더인가?),
3. 상태기계가 read index까지 적용된 뒤에야 읽습니다.

0단계가 왜 필요하냐면, 갓 선출된 리더의 `commit_index`는 전임 리더가 커밋한 지점을 아직 반영하지 못했을 수 있습니다. §5.4.2가 말했듯 옛 임기 엔트리는 과반에 있어도 그것만으론 커밋으로 못 치니, 새 리더는 자기 임기의 엔트리가 하나 커밋되고 나서야 "내 commit_index가 모든 커밋을 포함한다"고 말할 수 있기 때문입니다. 하트비트 과반 확인(2단계)은 "내가 아직 리더인가"에만 답하지, 이 구멍은 못 막습니다. 그리고 이 전제는 빠뜨리기 쉽습니다. 실제로 제 구현도 처음엔 0단계를 빠뜨렸고, 이 절차를 1차 자료와 대조하다 발견했습니다(적대적 리뷰 계열의 발견이 하나 더 늘어난 셈입니다). §5.4.2의 실무 짝이 바로 "선출 직후 no-op 커밋"이라는 걸, 빠뜨려 보고서야 체감했습니다.

결정적 안전성: **파티션된 옛 리더는 과반 ack를 영영 못 받아 읽기가 거부됩니다.** 낡은 값을 주느니 거부합니다. 그리고 0단계 전제 위에서 확인에 성공했다면, 내 commit_index가 모든 커밋을 포함하고 과반이 이번 임기에 나를 인정한 것이므로, 그 사이 더 최신 커밋이 다른 곳에 존재할 수 없습니다.

> **흔한 오해 정정**: *"리더에서 읽으면 항상 최신이다?"* 반례가 둘입니다. 하나, **파티션된 옛 리더**입니다. 강등된 걸 모른 채 낡은 상태기계를 읽어줍니다. 둘, **갓 선출된 진짜 리더**입니다. 자격은 맞는데 commit_index가 아직 전임의 커밋을 못 따라잡아 낡은 스냅샷을 읽을 수 있습니다. 앞은 과반 확인(2단계)이 막고, 뒤는 현재 임기 커밋 전제(0단계)가 막습니다. "리더"라는 자격만으론 둘 다 못 막습니다.

> **적대적 리뷰가 잡은 버그**: 배리어의 ack 집계가 "같은 임기의 성공 응답"이면 다 세고 있었다. **배리어 이전에 발사된 하트비트의 응답**이 재정렬로 늦게 도착해도 세어져, 원리상 오확인이 가능했다(테스트 하버스의 스케줄 특성 때문에 우연히 안 터졌을 뿐). 수정: 배리어마다 **epoch**를 올려 하트비트에 싣고 응답에 에코시켜, **현재 epoch의 ack만** 센다. "안전이 코드가 아니라 테스트 하버스의 우연에 걸려 있는" 상태를 잡아낸 리뷰였다.

(대안인 leader lease는 시계 가정이 필요해서, 결정적 시뮬레이션과 맞는 ReadIndex를 골랐습니다. etcd도 기본이 ReadIndex입니다.)

실제 시스템들의 읽기 모드도 이 지점에서 갈립니다:

| 시스템 | 기본 읽기 | 다른 모드 |
|---|---|---|
| etcd | ReadIndex (linearizable) | `serializable` 옵션, 로컬 읽기라 낡을 수 있음 |
| Consul | leader lease (`default`) | `consistent`(과반 확인) · `stale`(아무 노드나) |
| TiKV | lease read 주력 | lease를 못 믿는 상황엔 ReadIndex 폴백 |

lease read(리더가 시계 기반 임차 기간 동안 과반 확인 없이 읽기)는 하트비트 왕복 자체를 아끼기 때문에, 시계 가정을 감수하고라도 프로덕션에서 주력으로 널리 쓰입니다. ReadIndex가 유일한 정답은 아니라는 것도 공정하게 적어 둡니다.

> **실무/면접 포인트**: 쓰기 없는 읽기도 *"내가 아직 리더인가"* 라는 합의 질문을 피할 수 없습니다. ReadIndex는 그 질문에 하트비트 한 라운드로, lease read는 시계 가정으로 답할 뿐, 질문 자체를 없애는 방법은 없습니다. "읽기는 공짜"라는 직관이 분산 합의에선 성립하지 않습니다.

![선형화 읽기: 확인된 리더는 서빙, 파티션된 옛 리더는 과반 확인 실패로 거부](/uploads/project/db-hobby/raft-linearizable-read.svg)

## 7. 정리

- **failover는 합의 문제다.** 사람도 스크립트도 아닌 과반의 동의가 리더를 정한다. split-brain은 "과반은 겹친다"로 원천 봉쇄.
- **합의 코어**: 임기+과반 선출(무작위 타임아웃), prevLog 정합 검사(Log Matching), 그리고 **현재 임기 과반만 커밋**(§5.4.2)과 **선거 제한**(§5.4.1)이 안전성의 심장.
- **검증은 결정적 시뮬레이션으로.** 분단·크래시·재정렬을 재현 가능하게. 합의 버그는 특정 스케줄에서만 터진다.
- **프로덕션의 조각들**: 지속성(§5.1, 이중 투표 방지, WAL 규칙과 같은 결), 스냅샷(§7, log_base=0이 no-op이라 새 시나리오가 필요), 멤버십(한 번에 하나씩, 박사논문 4장, 겹치는 과반. 리더 교체와 겹치는 2015년의 알려진 버그까지).
- **SMR**: 커밋된 **결정적** 명령을 같은 순서로 모든 엔진에. 리더가 죽어도 살아남는 HA DB. apply의 에러 처리까지가 SMR의 약속.
- **ReadIndex**: 현재 임기 엔트리 커밋(선출 직후 no-op)을 전제로, 읽기 전에 "지금도 리더"를 과반으로 확인. 파티션된 옛 리더는 거부된다. epoch 없는 ack 집계는 재정렬에 뚫린다.
- **적대적 리뷰의 가치**: 스냅샷 미설치 발산, apply 에러 무시, epoch 부재. 전부 "테스트는 초록인데 원리상 틀린" 종류였다. 합의 코드는 독립적인 회의주의자가 필요하다.

저장·복구·격리·최적화·병렬·분산의 여정은 여기서 정점입니다. 페이지 한 장에서 시작해, 진짜 psql이 붙고, MVCC로 격리하고, 병렬로 돌고, 합의로 복제되는 미니 DB까지. 마지막 [11편](/blog/project/db-hobby/db-internals-11-sql-executor)은 부록 격으로, 이 모든 것의 입구였던 **SQL 실행기 자체**(파서·조인·집계·3값 논리)를 완결합니다.

## 참고 (1차 자료 우선)

- Diego Ongaro & John Ousterhout, *In Search of an Understandable Consensus Algorithm* (Raft, USENIX ATC 2014)
- Diego Ongaro, *Consensus: Bridging Theory and Practice* (PhD dissertation, 2014): 단일 서버 멤버십 변경(4장)·클라이언트 세션 dedup(§6.3)·ReadIndex(§6.4)·disruptive server(§9.6)의 상세
- [Diego Ongaro, "bug in single-server membership changes" (raft-dev, 2015)](https://groups.google.com/g/raft-dev/c/t4xj6dJTP6E): 리더 교체와 겹친 단일 변경의 안전성 버그 공지와 수정
- [etcd Documentation: Linearizability / ReadIndex](https://etcd.io/docs/)
- [Consul Documentation: Consistency Modes](https://developer.hashicorp.com/consul/docs/architecture/consensus): default(leader lease)·consistent·stale
- [TiKV Deep Dive: Consensus Algorithm](https://tikv.org/deep-dive/consensus-algorithm/)
- [MySQL Reference Manual: Advantages and Disadvantages of Statement-Based and Row-Based Replication](https://dev.mysql.com/doc/refman/8.0/en/replication-sbr-rbr.html): 비결정 구문과 SBR의 함정
- 본 블로그: [트랜잭션 ACID ③: Consistency](/blog/theory/transaction-acid-03-consistency)
- [db-hobby 코드 (GitHub)](https://github.com/dj258255/db-hobby): `raft.c` · `raftdb.c` · `tests/test_raft.c`

<!-- EN -->

## 0. Introduction — the Question Replication Couldn't Answer

[Part 9](/blog/project/db-hobby/db-internals-09-replication)'s replication is a story only while the primary lives. When it dies, a replica must be promoted — **by whom, when, and which one?** Do it by hand and you get 3am pages; automate it with scripts and something scarier arrives: a brief network blip and both sides claim "I'm the primary," both accepting writes — **split-brain.**

This is ultimately a **consensus** problem — agreeing on **one answer** to "who is the leader now," even as some nodes die or disconnect. Paxos is the ancestor, notoriously hard; **Raft**, published in 2014 by Ongaro and Ousterhout, solves the same problem with understandability as an explicit design goal. etcd, Consul, TiKV, and CockroachDB stand on it.

This part builds Raft from the consensus core up — to **replicating a real SQL engine into an HA DB that survives leader death**, and to **linearizing reads.** Each section ends with a **real bug caught by adversarial review** — consensus code is most dangerous when it's plausibly correct.

## 1. The Consensus Core — Election, Replication, and §5.4.2's Subtlety

Raft's skeleton is threefold.

**Leader election.** Time divides into **terms**; nodes are leader/follower/candidate. A follower that misses heartbeats becomes a candidate, bumps the term, and broadcasts `RequestVote`. A **majority** of votes makes a leader — majorities overlap, and **the overlapping node grants only one vote per term** (votedFor), so at most one leader per term (Election Safety). Split votes from simultaneous candidacies are dispersed by **randomized election timeouts.**

Practice adds one more election-shaking variable: a partitioned node, starved of heartbeats, keeps bumping its term alone. The moment the partition heals, that inflated term deposes a perfectly healthy leader (the disruptive server of Ongaro's dissertation §9.6). So implementations like etcd add **Pre-Vote** (probe "would I win?" before the real election, without bumping the term) and **CheckQuorum** (a leader that cannot reach a majority steps down on its own) — the mini DB, living inside deterministic simulation, keeps the base form without these extensions.

**Log replication.** Client commands append to the leader's log and replicate via `AppendEntries`. Each message carries the **(index, term) of the preceding entry**; a follower accepts only if its log matches at that position — otherwise it refuses, and the leader steps back until the logs agree, then overwrites from there. This **consistency check** inductively guarantees Log Matching (same index+term ⇒ identical logs up to there).

**Commit — and §5.4.2's subtlety.** An entry replicated on a majority commits — but there's a trap. The paper's Figure 8 scenario: **an entry from an older term, even on a majority, cannot be counted committed by that alone** — a later, higher-term leader can still overwrite it. In the paper's own words — *"Raft never commits log entries from previous terms by counting replicas."* (§5.4.2) So a leader advances commit_index **only when an entry of its own current term reaches a majority** — which then commits everything before it too. The election-side twin is the **§5.4.1 election restriction**: voters refuse candidates with staler logs — so only nodes holding all committed entries can become leader (Leader Completeness).

![Raft consensus — leader election (terms, majorities), the AppendEntries consistency check, majority commit](/uploads/project/db-hobby/raft-consensus.svg)

### How to Verify — Deterministic Simulation

Consensus bugs fire only under particular message orders and partition timings — schedules you **cannot reproduce** over real sockets. So the test harness owns a **deterministic simulated network** — logical clock, message queues, a partition matrix — able to **replay identical adversarial scenarios**: trap the leader in a minority, kill nodes, reorder messages. The minority-trapped leader demotes on return; diverged logs converge through the consistency check — all pinned as reproducible scenarios. (The same creed behind TigerBeetle's and FoundationDB's deterministic simulation testing.)

## 2. Persistence — a Restarted Node Voting Twice

Consensus doesn't end in memory. **§5.1: currentTerm and votedFor must be on stable storage before responding.** Why: a node votes for A in term 5, crashes, restarts having forgotten votedFor — and votes for B in the same term 5. A and B each assemble a majority: **two leaders.** Election Safety collapses.

So votes and term changes must be fsynced **before** the response leaves — exactly the same grain as [Part 3's WAL rule](/blog/project/db-hobby/db-internals-03-wal-recovery) ("durable before acknowledged"). Log entries likewise: an acked-but-evaporated entry falsifies majority arithmetic.

Face the cost squarely, too — one fsync per entry makes consensus throughput bottleneck on disk flushes, not CPU or network. So production implementations like etcd batch multiple entries and responses into a single fsync — precisely symmetric to [Part 3's group commit](/blog/project/db-hobby/db-internals-03-wal-recovery) batching the fsyncs of concurrent commits.

![Raft persistence — without fsyncing votedFor, a restart enables double voting: two leaders](/uploads/project/db-hobby/raft-persistence.svg)

## 3. Snapshots — the Log Cannot Grow Forever

If the log is the whole truth, it grows without bound. **§7 snapshots**: capture the state machine wholesale and discard the log up to that point (log compaction). For newly joining or badly lagging followers, ship the snapshot itself via **InstallSnapshot.** It's the distributed edition of [Part 3's checkpoint](/blog/project/db-hobby/db-internals-03-wal-recovery) ("declare data has caught up; clear the log").

The implementation crux is **one offset** — trimming desynchronizes array indexes from logical indexes, so keep `log_base` (entries discarded) and translate every access as `logical - log_base`.

> **The trap — existing tests can't catch this**: with `log_base = 0` every translation is a no-op, so all pre-snapshot scenarios pass even if you miss a translation. Only election/replication/recovery scenarios **after** a snapshot expose the omission. Adversarial review caught a real bug here — **recovery loaded the snapshot but never installed it into the state machine**, so a restarted node applied the log on top of pre-snapshot state and **silently diverged.** "Loaded" and "installed" are different words.

![Raft snapshots — capture the state machine, trim the log, InstallSnapshot for lagging followers](/uploads/project/db-hobby/raft-snapshot.svg)

## 4. Membership Changes — Adding and Removing Nodes While Running

Why is changing the cluster configuration itself dangerous? Jump from 3 to 5 nodes at once and the old configuration (majority=2) and new (majority=3) can assemble **disjoint majorities** simultaneously — two leaders. The paper's §6 answer is **joint consensus** — a two-phase protocol passing through a transitional configuration (C_old,new) that requires majorities of both. The simpler alternative is the **single-server change** of chapter 4 of Ongaro's dissertation (2014): add/remove **one node at a time.** With a one-node delta, old and new majorities necessarily overlap — the mini DB implements this one.

(A quorum-arithmetic aside — 4 nodes tolerate exactly as many failures as 3 do: one (majority=3). An even-numbered node adds no availability, only quorum size — why consensus clusters come in odd sizes.)

Configuration changes flow as special log entries — with a subtle rule: nodes apply a config entry **from the moment it's appended, before commit** (so majority arithmetic is safe during the transition). Then what if that entry is later overwritten? You need **config reversion on truncation.** And a leader removing itself steps down after the change commits. Adversarial review caught four real bugs in this area (InstallSnapshot not carrying the config; truncation not reverting it; back-to-back changes without commit-wait; a self-removing leader not stepping down) — membership being **subtle enough that the author himself announced a safety bug in it** (raft-dev, 2015) rang true.

> **Common misconception, corrected**: *"Changing one node at a time is always safe?"* — No. A bug Ongaro himself announced on the raft-dev mailing list in 2015: even single-server changes, when they **overlap with a leader change**, can get two conflicting configurations each committed. The fix: *"the leader must not append a new configuration entry until it has committed an entry from its current term."* It's the same family of trap as the 'back-to-back changes without commit-wait' bug above (pushing the next configuration without checking what the previous change/term actually committed) — §5.4.2's "current term" condition on commits, echoing into membership.

![Raft membership — single-server changes: one at a time keeps old/new majorities overlapping](/uploads/project/db-hobby/raft-membership.svg)

## 5. SMR — an HA Database Replicating a Real SQL Engine

With the core standing, the standard pattern for a DB is **state machine replication (SMR)**:

1. writes (SQL) are **proposed** into the leader's Raft log,
2. **committed** by majority replication,
3. and **every node applies committed commands to its own engine in the same order** (`db_exec`).

Same initial state + same commands in the same order = same final state — but **only if the commands are deterministic** (State Machine Safety guarantees the order, no further). Let nondeterminism like `NOW()` or `RANDOM()` into a command and nodes compute different values from the same order and diverge — the classic trap of MySQL's statement-based replication, and why CockroachDB runs Raft not over SQL text but over deterministic KV operations. The mini DB's SQL subset has no such nondeterministic functions, so replicating the text itself holds. etcd replicates a KV this way; TiKV and CockroachDB replicate SQL storage.

Wired to the real engine: stream CREATE/INSERTs at a 3-node cluster and check all three engines' SELECTs match — then the real test: **kill the leader.** The remaining two elect a new one (failover), writes continue, and the survivors still agree — Leader Completeness guarantees committed writes exist on any new leader. This is the answer to [Part 9](/blog/project/db-hobby/db-internals-09-replication)'s open question — **nobody decides, and yet consensus decides.**

> **Bug caught by adversarial review**: apply was **swallowing** `db_exec` failures. If application fails on just one node, last_applied advances while the engine doesn't change — **that node silently diverges.** SMR's promise ("same commands, same state") holds only if apply's error handling is part of it.

One more hole remains in SMR — **client retries.** If the leader dies after applying a command but just before responding, the client times out, retries, and the same INSERT can apply **twice.** The dissertation's §6.3 prescription is sessions plus serial-number dedup — *"clients assign unique serial numbers to every command"* — the state machine remembering each session's latest serial number and response to filter duplicates. The mini DB doesn't have this layer. What consensus gives ends at "a total order of committed commands"; exactly-once semantics is a contract that must be built on top — an honest boundary.

![The Raft-replicated HA DB — writes go through consensus; every node applies committed SQL to its own engine; failover survives leader death](/uploads/project/db-hobby/raft-replicated-db.svg)

## 6. Linearizable Reads — the Partitioned Old Leader's Stale Data

The last hole. Writes pass through consensus — but **reads**? Read from any node and you can see lag. "Just read from the leader?" — the scariest counterexample is the **partitioned old leader**: unaware it's been deposed (heartbeats simply aren't arriving), it reads its own state machine and serves a **stale value**, missing writes the new leader already committed.

The answer is **§8 ReadIndex** (the procedure in detail: dissertation §6.4). Before serving a read, the leader:

0. must have **committed at least one entry from its own current term** (— which is why a leader commits a no-op entry right after election),
1. captures the current `commit_index` as the **read index**,
2. confirms **a majority responds** to one round of heartbeats (— am I still the leader?),
3. and serves only after the state machine has applied up to the read index.

Why step 0: a freshly elected leader's `commit_index` may not yet reflect what the previous leader committed. As §5.4.2 said, entries from older terms can't be counted committed by majority alone — so only once an entry of its own term commits can a new leader say "my commit_index covers everything committed." The heartbeat majority check (step 2) answers only "am I still the leader" — it cannot plug this hole. And this premise is easy to drop — my own implementation initially dropped step 0, and I found it while checking this procedure against the primary sources (one more discovery in the adversarial-review lineage). That "commit a no-op right after election" is §5.4.2's practical twin was something I only truly felt after dropping it.

The decisive safety: **a partitioned old leader never gets its majority ack, so the read is refused.** Refusal over staleness. And if confirmation succeeds on top of the step-0 premise — my commit_index covers all commits, and a majority acknowledged me this term — no newer commit can exist elsewhere in the meantime.

> **Common misconception, corrected**: *"Reading from the leader is always fresh?"* — Two counterexamples. One, the **partitioned old leader** — unaware it's deposed, it reads a stale state machine. Two, the **freshly elected, genuine leader** — the title is legitimate, but its commit_index may not yet have caught up with its predecessor's commits, so it can read a stale snapshot. The majority check (step 2) blocks the former; the current-term-commit premise (step 0) blocks the latter. The title "leader" alone blocks neither.

> **Bug caught by adversarial review**: the barrier's ack counting accepted any same-term success reply — so a reply to a heartbeat **fired before the barrier**, arriving late under reordering, could falsely confirm (it hadn't fired only due to the harness's scheduling habits). Fix: bump an **epoch** per barrier, carry it in heartbeats, echo it in replies, and count **only current-epoch acks.** A review that caught safety resting on a harness accident rather than the code.

(The alternative — leader leases — needs clock assumptions, so ReadIndex fit the deterministic simulation better. etcd's default is ReadIndex too.)

Real systems' read modes split exactly here:

| System | Default read | Other modes |
|---|---|---|
| etcd | ReadIndex (linearizable) | `serializable` option — local read, may be stale |
| Consul | leader lease (`default`) | `consistent` (majority check) · `stale` (any node) |
| TiKV | lease read as the workhorse | falls back to ReadIndex when the lease can't be trusted |

Lease reads (the leader serving without a majority check during a clock-based lease window) save the heartbeat round-trip itself, so they're widely the production workhorse even at the price of clock assumptions — to be fair, ReadIndex is not the only right answer.

> **Practical/interview point**: even a read with no write cannot dodge the consensus question *"am I still the leader?"* ReadIndex answers it with one heartbeat round; lease reads answer it with a clock assumption — there is no way to remove the question itself. The intuition "reads are free" does not survive distributed consensus.

![Linearizable reads — a confirmed leader serves; a partitioned old leader fails quorum confirmation and refuses](/uploads/project/db-hobby/raft-linearizable-read.svg)

## 7. Wrap-up

- **Failover is a consensus problem** — neither humans nor scripts but majority agreement chooses the leader. Split-brain is foreclosed by "majorities overlap."
- **The core**: term+majority election (randomized timeouts), the prevLog consistency check (Log Matching), and the heart of safety — **commit only current-term majorities** (§5.4.2) plus the **election restriction** (§5.4.1).
- **Verify by deterministic simulation** — partitions, crashes, reordering, reproducibly. Consensus bugs fire only on particular schedules.
- **The production pieces**: persistence (§5.1 — double-vote prevention, same grain as the WAL rule), snapshots (§7 — log_base=0 is a no-op, demanding new scenarios), membership (one at a time — dissertation chapter 4, overlapping majorities; plus 2015's known bug when overlapping a leader change).
- **SMR** — committed **deterministic** commands to every engine in the same order; an HA DB surviving leader death. Apply's error handling is part of SMR's promise.
- **ReadIndex** — premised on committing a current-term entry (the post-election no-op), confirm "still leader" by majority before reading; the partitioned old leader is refused. Epoch-less ack counting falls to reordering.
- **The value of adversarial review** — snapshot-not-installed divergence, swallowed apply errors, the missing epoch: all of the "tests green, wrong in principle" kind. Consensus code needs an independent skeptic.

The journey through storage, recovery, isolation, optimization, parallelism, and distribution peaks here — from one page to a DB a real psql connects to, isolated by MVCC, running in parallel, replicated by consensus. The final [Part 11](/blog/project/db-hobby/db-internals-11-sql-executor) closes the loop as an appendix: **the SQL executor itself** (parser, joins, aggregation, three-valued logic) — the entrance to everything above.

## References (primary sources first)

- Diego Ongaro & John Ousterhout, *In Search of an Understandable Consensus Algorithm* (Raft, USENIX ATC 2014)
- Diego Ongaro, *Consensus: Bridging Theory and Practice* (PhD dissertation, 2014) — single-server membership changes (ch. 4), client session dedup (§6.3), ReadIndex (§6.4), disruptive servers (§9.6)
- [Diego Ongaro, "bug in single-server membership changes" (raft-dev, 2015)](https://groups.google.com/g/raft-dev/c/t4xj6dJTP6E) — the safety-bug announcement and its fix
- [etcd Documentation: Linearizability / ReadIndex](https://etcd.io/docs/)
- [Consul Documentation: Consistency Modes](https://developer.hashicorp.com/consul/docs/architecture/consensus) — default (leader lease), consistent, stale
- [TiKV Deep Dive: Consensus Algorithm](https://tikv.org/deep-dive/consensus-algorithm/)
- [MySQL Reference Manual: Advantages and Disadvantages of Statement-Based and Row-Based Replication](https://dev.mysql.com/doc/refman/8.0/en/replication-sbr-rbr.html) — nondeterministic statements under SBR
- This blog: [Transaction ACID ③: Consistency](/blog/theory/transaction-acid-03-consistency)
- [db-hobby source (GitHub)](https://github.com/dj258255/db-hobby) — `raft.c` · `raftdb.c` · `tests/test_raft.c`

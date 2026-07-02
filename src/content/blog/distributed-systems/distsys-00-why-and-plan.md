---
title: '분산 시스템, 먼저 제대로 배우고 Kafka를 만든다 — MIT 6.5840'
titleEn: "Learn Distributed Systems First, Then Build Kafka — MIT 6.5840"
description: 자작 스택(커널·DB·JVM)이 다 단일 노드라, 다음 축은 분산이다. 분산을 배우려면 그냥 분산 시스템 하나를 밑바닥부터 만들면 될 것 같지만 거기엔 치명적 구멍이 있다 — 네트워크 분단·크래시 같은 실패를 스스로 테스트할 수가 없다. 그래서 MIT 6.5840로 fundamentals를 먼저 정면돌파하고, 그 토대 위에 Kafka를 짓기로 했다. 학습 플랜, Go를 고른 이유, 첫날 MapReduce 셋업까지.
descriptionEn: "My from-scratch stack (kernel, DB, JVM) is all single-node, so distributed systems is the next axis. You'd think the way to learn it is to build a distributed system from scratch — but that has a fatal gap: you can't self-test failures like network partitions and crashes. So I learn the fundamentals through MIT 6.5840 first, then build Kafka on that foundation. The plan, why Go, and day-one MapReduce setup."
date: 2026-07-02T00:00:00.000Z
tags:
  - Distributed Systems
  - MIT 6.5840
  - Raft
  - Go
  - Kafka
  - Consensus
category: study/distributed-systems
draft: false
series: "분산 시스템 공부기 (MIT 6.5840)"
seriesOrder: 1
---

*분산 시스템을 제대로 파보는 공부기. 이 글은 1편 — 왜 6.5840부터 시작하나, 그리고 어떻게.*

## 0. 들어가며

[커널](/blog/hobby/kernel-hobby-00-boot-to-paging)도, [DB](/blog/project/db-hobby/db-hobby-1-storage)도, [JVM](/blog/hobby/java-hobby-00-why-and-architecture)도 밑바닥부터 만들어봤어요. 그런데 전부 **컴퓨터 한 대 안**의 이야기더라고요. 다음 축은 분명했어요 — **여러 대가 협력하는 분산 시스템.**

그럼 어떻게 배우지? 제 방식대로면 "분산 시스템 하나를 밑바닥부터 만들어보자"가 자연스러워요 (그게 [Kafka를 만들기로 한 이유](/blog/hobby/kafka-hobby-00-why-and-architecture)고요). 그런데 계획을 짜다 보니, **자작만으로는 분산을 "제대로" 배울 수 없는 이유**가 걸렸어요. 그래서 순서를 정했습니다 — **분산 fundamentals를 먼저 제대로 배우고(MIT 6.5840), 그 위에 Kafka를 짓는다.** 이 글은 그 이유와 계획이에요.

## 1. 왜 "그냥 만들면서 배우기"로는 부족한가

분산 시스템을 Kafka 하나 만들며 배우려 하면 두 가지가 걸려요.

### ① 앞부분이 다 단일 노드

Kafka를 만들려면 먼저 **와이어 프로토콜 → 로그 저장 → produce/fetch**를 해야 해요. 이건 전부 컴퓨터 한 대 안의 일이에요. 진짜 분산(복제·합의)은 로드맵 맨 끝에 있죠. "분산 공부"가 목표인데 몇 주간 배관부터 깔고 나서야 분산에 도달해요.

### ② 진짜 어려운 걸 스스로 테스트할 수 없다 (결정타)

**분산 시스템이 어려운 진짜 이유는 실패를 다루는 거예요** — 네트워크 분단, 노드 크래시, 메시지 지연·재정렬. 정상 경로는 쉬워요. 복제? 그냥 로그 복사하면 되죠. 어려운 건 "리더가 죽는 순간 메시지가 반쯤 갔을 때" 같은 지옥이에요.

그런데 **이런 실패 시나리오를 스스로 테스트로 만들기가 거의 불가능해요.** 프로토콜은 내가 짠 시뮬레이터로 검증할 수 있어도, *"내 합의 알고리즘이 네트워크 분단에서 올바른가?"*는 스스로 검증하기 어려워요.

> 분산에서 가장 위험한 함정은 **"돌아가는 것처럼 보이는데 사실 틀린"** 코드예요. 적대적 테스트가 없으면 그걸 맞다고 믿고 넘어가요. 그리고 그 버그는 프로덕션에서 새벽 3시에 터지죠.

## 2. 그래서 MIT 6.5840부터

이 구멍을 정확히 메워주는 게 있었어요 — **MIT의 분산 시스템 대학원 과목 6.5840(구 6.824).** 랩마다 **적대적 테스트 스위트**가 붙어 있어요. 네트워크 분단·크래시·지연을 무작위로 주입하면서 내 구현이 여전히 올바른지 두들기죠.

이게 자작으로는 재현하기 힘든 부분이에요. Raft 논문을 직접 구현하고 MIT이 만든 잔인한 테스트로 검증받는 것. 강의·랩·테스트가 전부 무료로 공개돼 있어서 집에서 그대로 할 수 있어요.

| | 만들면서 배우기 (Kafka) | MIT 6.5840 |
|---|---|---|
| 분산 학습 밀도 | 낮음 (앞이 단일 노드) | 높음 (Raft 정면돌파) |
| 적대적 테스트 | 스스로 못 짬 | 분단·크래시 주입 |
| 성격 | 실전 시스템 완성 | fundamentals 학습 |

## 3. 순서: 배우고 → 짓는다

Kafka는 여전히 만들어요. 다만 순서를 **"배우고 나서 짓는다"**로 잡았어요.

```
1단계  이론·멘탈모델   Kleppmann 8강(7h) + DDIA 5~9장       ← 지도 그리기
2단계  핵심 정면돌파   MIT 6.5840: MapReduce → Raft         ← 적대적 테스트로 합의
3단계  실전에 적용     그 Raft를 kafka-hobby 트랙 E에 짓기    ← 배운 걸 내 손으로
```

> 6.5840에서 Raft를 제대로 배우고 나면, [kafka-hobby](https://github.com/dj258255/kafka-hobby)의 합의(KRaft) 트랙이 막막한 TODO가 아니라 **"아는 걸 짓는 일"**이 돼요. fundamentals(6.5840)와 실전(Kafka)이 서로를 강화하죠. 면접에서도 "6.5840 Raft를 구현했고 그걸 제가 만든 Kafka에 적용했습니다"는 이론과 실전을 동시에 증명하는 답이고요.

## 4. 왜 Go인가 (C/Java 하던 사람 입장에서)

6.5840은 **Go 전용**이에요. 테스트 하네스 자체가 Go로 짜여 있어서 선택지가 없어요. 저는 [커널·DB](/blog/hobby/kernel-hobby-00-boot-to-paging)를 C로, Kafka를 Java로 만들었지 Go는 처음이었어요. 근데 걱정보다 훨씬 쉬웠어요.

- **Go ≈ C 문법 + Java식 GC + goroutine/channel + 훨씬 작은 문법.** C·Java 배경이면 며칠이면 랩 돌릴 수준이 돼요.
- **goroutine·channel이 분산 코드를 깔끔하게 만들어요.** "여러 노드가 동시에 메시지 주고받기"가 Java 스레드보다 자연스럽죠. MIT이 Go를 고른 이유예요.
- **Go 자체가 커리어 자산.** Kubernetes·Docker·etcd가 다 Go예요.

개념 매핑은 이렇게 잡았어요.

| C/Java | Go |
|---|---|
| Thread / pthread | goroutine `go f()` |
| BlockingQueue | channel `ch <- x` |
| synchronized / mutex | `sync.Mutex` |
| class | struct + 메서드 |
| try/catch | `if err != nil` (에러는 값) |
| finally | `defer` |

## 5. 첫날 — 셋업하고 손 풀기

말만 하면 안 되니까 바로 환경을 깔았어요.

```sh
brew install go                                            # Go 1.26
git clone git://g.csail.mit.edu/6.5840-golabs-2026 6.5840  # 랩 스타터 (git:// 프로토콜!)
cd 6.5840/src/main
go run mrsequential.go wc.so pg-*.txt                      # 순차 MapReduce 레퍼런스
```

셰익스피어 텍스트로 단어 수를 세는 순차 버전이 잘 돌아갔어요.

```
the 29748
and 23612
to  16079
```

이제 할 일은 이 **순차 버전을 "분산"으로** 만드는 것 — `mr/worker.go`와 `mr/coordinator.go`를 채워서 여러 워커가 나눠 처리하고 중간에 워커가 죽어도 코디네이터가 재할당하게. 테스트(`make mr`)는 실제로 워커를 크래시시키면서 검사해요.

## 마무리

코드에 앞서 순서를 이렇게 잡았어요.

- **분산을 "제대로" 배우려면 실패 처리를 적대적 테스트로 검증해야 한다** — 자작만으론 채우기 힘든 부분.
- 그래서 **MIT 6.5840로 fundamentals(특히 Raft)를 먼저 정면돌파**하고, 그걸 **[kafka-hobby](/blog/hobby/kafka-hobby-00-why-and-architecture)를 지으며 적용**한다.
- **Go는 부담이 아니라 자산** — C/Java 배경이면 며칠이면 된다.

다음 편은 MapReduce 랩을 실제로 구현하면서 "분산 작업 분배 + 죽은 워커 복구"를 Go로 짜보는 과정이에요. 그다음이 진짜 산 — **Raft**고요.

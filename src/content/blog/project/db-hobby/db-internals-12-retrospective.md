---
title: 'DB 내부 ⑫ (회고): 나는 왜 DB를 밑바닥부터 만들었나 — 만들어서 증명한 것들'
titleEn: 'DB Internals ⑫ (Retrospective): Why I Built a Database from Scratch — and What Building It Proved'
description: "이 글은 db-hobby의 회고이자, 이 시리즈 전체의 포트폴리오다. 출발점은 하나의 자각이었다 — '인덱스는 B+Tree라 빠르다'고 말할 수는 있는데, 왜 이진 트리가 아니라 B+Tree인지, 커밋의 fsync가 정확히 무엇을 보장하는지 설명하지 못했다. 설명할 수 없으면 모르는 것이다. 그래서 페이지 한 장부터 Raft 합의까지 C로 직접 만들었고, 모든 주장을 직접 측정한 수치로 바꿨다: 인덱스는 10만 행에서 풀 스캔보다 416배 빨랐고, 같은 5천 행 적재가 fsync 횟수에 따라 23배 갈렸고, 12코어 병렬화는 2.16배가 천장이었는데 그 천장의 정체(버퍼 풀 latch의 I/O 직렬화)를 A/B 실험으로 확증하고 고치자 콜드 스캔이 0.62배에서 2.39배가 됐다. 성능 작업 중 조용히 틀린 답을 내던 집계 버그를 발굴했고, 구현과 검증을 분리한 적대적 리뷰가 '테스트는 초록인데 원리상 틀린' 합의 버그 여섯을 잡았다. 686개 테스트, ThreadSanitizer/ASan 계측, 크래시 주입, 결정적 시뮬레이션 — 무엇을 만들었는지가 아니라 어떻게 검증했고 왜 그 선택을 했는지의 기록이다. 무엇을 안 했는지(정직한 경계)까지 포함해서."
descriptionEn: "This is db-hobby's retrospective and the portfolio of the whole series. It began with one realization — I could say 'indexes are fast because they're B+Trees,' but I couldn't explain why a B+Tree and not a binary tree, or what exactly a commit's fsync guarantees. If you can't explain it, you don't know it. So I built it in C, from a single page to Raft consensus, converting every claim into numbers I measured myself: the index beat a full scan by 416× at 100k rows; the same 5,000-row load differed 23× by fsync count; 12-core parallelism ceilinged at 2.16× — and after identifying that ceiling (the buffer-pool latch serializing I/O) and confirming it with an A/B experiment, the cold scan went from 0.62× to 2.39×. Performance work unearthed an aggregate that silently returned wrong answers, and adversarial reviews separating implementation from verification caught six consensus bugs of the 'tests green, wrong in principle' kind. 686 tests, ThreadSanitizer/ASan instrumentation, crash injection, deterministic simulation — a record not of what was built, but of how it was verified and why each choice was made. Including what was deliberately not built (the honest boundaries)."
date: 2026-07-06T00:00:00.000Z
tags:
  - Database Internals
  - Retrospective
  - Portfolio
  - Testing
  - C
category: study/db-hobby
coverImage: /uploads/project/db-hobby/cover.svg
draft: false
series: "미니 DB로 이해하는 DB 내부"
seriesOrder: 12
---

## 0. 30초 요약 — 이 프로젝트가 증명한 숫자들

긴 글이니 결론부터. **db-hobby**는 C로 밑바닥부터 만든 미니 관계형 DB([GitHub](https://github.com/dj258255/db-hobby))이고, 아래 표의 모든 수치는 제가 이 프로젝트에서 **직접 측정**한 것입니다(12코어 macOS, `-O2`, 측정 코드도 repo에 있음).

| 주장 | 직접 측정한 근거 |
|---|---|
| 인덱스는 O(log n)이다 | 풀 스캔 대비 1천 행 **11배** → 10만 행 **416배** (격차가 N과 함께 벌어짐 = 로그 곡선 그 자체) |
| 내구성(fsync)은 비싸다 | 같은 5천 행 적재: 행당 커밋 3,372 rows/s vs 50행 묶음 79,039 rows/s — **23배** |
| 클러스터드는 지역성이 무기다 | InnoDB식이 PK 범위 스캔 **3.8배** 빠름, 대신 보조 인덱스 점 조회 **2배** 느림(이중 조회) |
| 병렬화의 천장은 CPU가 아니다 | 12코어 병렬 집계 최고 **2.16배**(선형 아님) — 천장의 정체는 버퍼 풀 latch. 고치자 콜드 스캔 **0.62배 → 2.39배** |
| 전부 검증됐다 | **테스트 686개 / 42스위트**, ThreadSanitizer·ASan/UBSan 클린, 크래시 주입, 결정적 시뮬레이션 |
| 진짜 프로토콜이다 | **실제 psql 14.19가 접속**해 MVCC("reader가 writer를 안 막는다")를 두 터미널로 시연 |

이 글은 그 여정의 회고예요 — **왜 만들었고, 어떻게 검증했고, 왜 그 선택들을 했는지.** 기능 나열은 안 합니다(그건 [시리즈 1~11편](/blog/project/db-hobby/db-internals-01-storage)이 이미 해요).

## 1. 왜 만들었나 — "설명할 수 없으면 모르는 것이다"

출발점은 지식의 불편함이었어요. 저는 이런 문장들을 말할 수 *있었습니다*:

- "인덱스는 B+Tree라 빨라요."
- "커밋하면 fsync돼서 안전해요."
- "MVCC라 읽기가 안 막혀요."

그런데 꼬리 질문 하나면 무너졌어요. **왜 이진 트리가 아니라 B+Tree인가?** fsync가 정확히 *무엇*을 보장하는가 — 데이터 파일인가 로그인가? 읽기가 안 막히면 dirty read는 *무엇이* 막는가? 답을 못 하는 지식은 외운 것이지 이해한 게 아니에요. 그리고 외운 지식은 실무의 변형된 상황(EXPLAIN이 인덱스를 안 탈 때, VACUUM을 해도 디스크가 안 줄 때)에서 힘을 못 씁니다.

동시에 OS를 공부하면서 다른 자각이 왔어요 — 페이지, 캐시, 동시성, fsync… **DB라는 게 결국 OS가 주는 원시 재료 위에 데이터 계층을 다시 쌓은 종합 시스템**이더라고요. 그렇다면 한 겹씩 직접 쌓아 보면, 그 문장들이 전부 "외운 것"에서 "유도할 수 있는 것"으로 바뀌겠다 — 그게 이 프로젝트의 문제 정의였습니다.

**왜 C였나** — 목표가 "진짜 구조의 재현"인데, DB 내부는 메모리·포인터·바이트 레이아웃이 곧 학습 내용이에요. 언어가 그걸 추상화로 가리면 정작 배우려는 게 안 보입니다(중간에 Java 재작성도 검토했지만, 버퍼 풀을 GC 위에 올리는 순간 "버퍼 풀을 왜 만드나"라는 질문 자체가 증발해서 접었어요). **왜 발명이 아니라 재현이었나** — 새 걸 만드는 게 아니라 PostgreSQL·InnoDB가 왜 그렇게 생겼는지를 이해하는 게 목적이라, 매 계층마다 "실제 DB는 여기서 어떻게 하나"를 대조하는 걸 규칙으로 삼았습니다.

## 2. 어떻게 일했나 — 주장은 테스트로, 검증은 분리해서

이 프로젝트에서 가장 의식적으로 지킨 건 기능이 아니라 **검증 문화**였어요. 네 겹입니다.

**① 모든 계층은 테스트가 주장한다.** "동작한다"가 아니라 테스트 686개가 말하게 했어요. 특히 복구 계층은 **크래시를 실제로 주입**했습니다 — 커밋 마커 fsync 직후에 죽이면 redo로 살아나는지(내구성), 마커 전에 죽이면 깨끗이 버려지는지(원자성). "전원이 꺼져도 안 깨진다"는 크래시를 일으켜 보기 전엔 주장일 뿐이니까요.

**② 동시성은 계측한다.** 동시성 코드에서 "테스트 통과"는 약한 증거예요 — 레이스는 대부분의 실행에서 안 터지니까. 그래서 버퍼 풀 축출 폭풍, latch crabbing, 병렬 스캔 전부를 **ThreadSanitizer로 계측**해 "관측된 실행에 data race가 없었다"를 얻었습니다. 분산(Raft)은 한 발 더 — 합의 버그는 특정 메시지 순서에서만 터지는데 진짜 소켓 위에선 그 스케줄을 재현할 수 없어서, 논리 시계·메시지 큐·분단 행렬을 테스트가 소유하는 **결정적 시뮬레이션 네트워크**를 만들어 적대적 시나리오를 똑같이 반복 재생했어요.

**③ 구현과 검증을 분리한다.** 사람이든 AI든, 구현한 쪽은 자기 코드에 관대해요. 그래서 합의·복제처럼 "그럴듯하게 맞는" 상태가 제일 위험한 영역엔 **독립적인 적대적 리뷰**를 붙였습니다 — 구현을 모르는 검증자가 "이 주장들을 깨 보라"는 임무만 받고 공격하는 방식이에요(AI 에이전트를 쓸 때도 리뷰어는 코드를 고치지 못하게 역할을 갈랐습니다 — 고치는 순간 또 하나의 구현자가 되고 검증자가 사라지니까). 이 리뷰가 잡은 게 전부 **"테스트는 초록인데 원리상 틀린"** 종류였어요:

| 적대적 리뷰가 잡은 실버그 | 왜 테스트가 못 잡았나 |
|---|---|
| 복구가 스냅샷을 로드만 하고 상태기계에 **설치 안 함** → 재시작 노드가 조용히 발산 | 스냅샷 이후를 검증하는 시나리오가 없었음 |
| 멤버십 변경 4건 (truncate가 구성을 안 되돌림 등) | 특정 분단·타이밍에서만 발현 |
| SMR apply가 엔진 실패를 **무시** → 한 노드만 발산 | 실패 주입 없이는 관찰 불가 |
| 읽기 배리어 ack에 **epoch 부재** → 재정렬 시 오확인 가능 | 하버스의 스케줄 습관이 우연히 가려줌 |

마지막 줄이 특히 아픈 교훈이었어요 — **안전이 코드가 아니라 테스트 하버스의 우연에 걸려 있던** 상태를, 독립 검증자가 원리로 짚어냈습니다.

**④ 만들었으면 잰다.** 성능 주장엔 반드시 측정을 붙였고, 측정 조건(코어 수·워밍/콜드·최소시간)을 명시했습니다. 이 원칙이 다음 절의 서사를 만들었어요.

## 3. 딥다이브 ① — 측정이 병목을 찾고, A/B가 인과를 확증하다

이 프로젝트에서 가장 아끼는 서사예요. 5단계로 그대로 적습니다.

1. **정상 상태** — MVCC로 논리적 동시성은 얻었지만, 실행은 전역 latch 하나로 직렬화돼 있었어요. 병렬 스캔·병렬 집계를 구현해 read-only 쿼리를 워커 여럿이 나눠 돌게 만들었습니다(직렬과 결과 바이트 동일 + TSan 클린까지 확인).
2. **문제** — 자로 재니 이상했어요. 12코어인데 최고 **2.16배**. 심지어 콜드 캐시(테이블 > 버퍼 풀)에선 8워커가 **0.62배** — 직렬보다 *느렸습니다.*
3. **분석** — 프로파일이 아니라 구조에서 답을 찾았어요. 버퍼 풀은 latch 하나가 프레임 테이블을 지키는데, 캐시 miss 시의 **디스크 읽기(pager_read)까지 그 latch 안에서** 일어나고 있었습니다. 워커 여덟이 latch 앞에 줄 서서 I/O를 한 번에 하나씩 — 코어가 12개여도 I/O는 1차선. 사실 이 한계는 코드 주석에 제가 "진짜 DB는 read-in-progress 상태로 I/O를 latch 밖으로 뺀다"라고 적어 둔, 알고도 미뤄 둔 빚이었어요. 측정이 그 빚의 우선순위를 끌어올린 겁니다.
4. **학습·수정** — miss 시 프레임을 `io_pending`+pin으로 예약하고 latch를 놓은 뒤 읽도록 바꿨습니다. 같은 페이지를 동시에 miss한 스레드는 조건변수로 기다렸다 hit로 잡아 중복 로드를 막고요(PostgreSQL 계열의 read-in-progress 패턴).
5. **결과 — 그리고 인과의 확증** — 여기가 한끝이에요. "고쳤더니 빨라졌다"로 끝내지 않고, **스위치 하나로 I/O를 latch 안/밖으로 토글해 같은 프로세스·같은 워밍 상태에서 A/B**를 쟀습니다. 변수가 정확히 하나뿐인 실험: latch 안 = 4워커 1.08배·8워커 0.62배, latch 밖 = 4워커 **2.39배**·8워커 1.36배. I/O 직렬화가 천장이었다는 인과가 확증됐고, 정확성은 콜드 7만 행 동시 로딩을 수학적 정답과 대조 + 축출 폭풍 TSan 클린으로 못박았습니다.

이 사이클(측정 → 구조 분석 → 수정 → **단일 변수 A/B 재측정**)이 제가 이 프로젝트에서 배운 성능 작업의 표준형이에요.

## 4. 딥다이브 ② — 성능 작업이 발굴한 "조용히 틀린 답"

집계를 병렬화하려고 그 경로를 읽다가, 병렬화와 무관한 **기존 버그**를 발견했어요. 직렬 집계가 행을 고정 버퍼(4,096행)까지만 모은 뒤 계산하고 있었습니다 — 6,000행 테이블에 `SELECT COUNT(*)`를 하면 **에러 없이 4096**이 나왔어요. 가장 무서운 종류의 버그죠: 틀린 답을 멀쩡한 얼굴로 돌려주는.

두 가지를 배웠습니다. 첫째, **성능 작업은 correctness 감사를 겸한다** — "빠르게 만들려고 읽는 코드"가 곧 "믿고 지나치던 코드"라서요. 둘째, **검증 기준을 무엇으로 잡느냐가 검증의 전부다** — 이 버그를 고친 병렬 집계는 직렬과 비교하면 안 됐어요(직렬이 틀렸으니까). 그래서 **수학적 정답(oracle)** 과 대조했습니다: SUM(1..n) = n(n+1)/2. 기준이 오염됐을 가능성까지 의심하는 것 — 적대적 리뷰에서 배운 태도가 여기서도 일했어요.

비슷한 결의 사건이 하나 더 있어요. LSM을 PK 인덱스로 배선하려다(`CREATE TABLE ... USING lsm`) **"인덱스는 단순 key→value가 아니다"** 라는 벽에 부딪혔습니다 — MVCC가 한 키에 여러 행 버전을 매달아서, unique한 LSM으론 담을 수 없었거든요. 교과서가 미리 알려주지 않는 이런 상호작용(MVCC × 인덱스 구조)은 만들어 봐야만 만나요. 해법은 dedup 단위를 (key, val) 짝으로 바꾼 멀티값 모드였고, 이건 RocksDB 계열이 비유니크 인덱스를 담는 방식과 같은 계열이었습니다 — 부딪히고 나서 찾아보니 실제 DB가 이미 그 길에 있었다는 것 자체가, 이 프로젝트가 의도한 학습 방식이었어요.

## 5. 선택의 기록 — "왜"에 답할 수 없는 결정은 하지 않는다

기술 선택마다 "왜 이것이고, 왜 대안이 아니었나"를 남기는 걸 규칙으로 했어요. 대표 다섯 개:

| 선택 | 왜 | 왜 대안이 아니었나 |
|---|---|---|
| 저장은 힙(PG식) | INSERT 단순, 인덱스를 "키→RID"로 깔끔히 분리해 학습 | 클러스터드(InnoDB식)는 나중에 **벤치 모듈로 대조**(3.8배/2배 실측) — 엔진 배선은 실행기 재작성 대비 학습 효익이 낮아 안 함 |
| 복구는 no-steal부터 | redo-only의 단순함으로 원리를 먼저 | 그 대가(트랜잭션 크기가 풀에 못 박힘)에 **실제로 부딪힌 뒤** steal+undo로 — "정책이 복구를 결정한다"를 몸으로 배우는 순서 |
| pageLSN·CLR 생략 | 페이지 전체 물리 로깅이라 redo가 멱등 → 불필요함을 **크래시 주입으로 증명**하고 닫음 | 화물숭배 금지 — 기법은 필요해지는 문제가 나타날 때 들여온다 |
| 선형화 읽기는 ReadIndex | 과반 확인만으로 성립, 결정적 시뮬레이션과 궁합 | leader lease는 시계 가정이 필요 — 테스트 인프라와 안 맞음 (etcd 기본값도 ReadIndex) |
| B+Tree 삭제는 lazy | PostgreSQL nbtree도 재분배를 안 한다 — 교과서(병합·재분배) 이식 전에 실제 DB를 먼저 확인 | "교과서적으로 완전한" 것보다 "실제 시스템이 왜 그 절충을 했는지"가 이 프로젝트의 질문 |

## 6. 무엇을 안 했나 — 정직한 경계

한 것만큼 안 한 것도 적어야 이 회고가 정직해져요. 의도적으로 남긴 경계들입니다:

- **inter-query 병렬 없음** — 병렬화는 한 쿼리 안(intra-query)까지. 서로 다른 트랜잭션의 동시 실행은 여전히 엔진 latch가 직렬화합니다. 카탈로그·테이블 WAL·트랜잭션 상태 전부의 스레드 안전화가 필요한, 이 프로젝트 최대의 남은 산.
- **행 단위 락 없음** — 쓰기 충돌은 테이블 granularity의 first-updater-wins. 원리는 PostgreSQL과 같고 입자만 거칠어요.
- **physiological 로깅·히스토그램·정렬 병합 조인·extended query protocol 없음** — 각각 "어떤 문제가 그걸 필요하게 만드는지"를 해당 편에 적고 닫았습니다.
- **프로덕션이 아님** — 이건 학습 프로젝트예요. 목적은 PostgreSQL을 대체하는 게 아니라 PostgreSQL을 **읽을 수 있게 되는 것.**

## 7. 그래서 무엇이 달라졌나

이 프로젝트 전과 후의 차이는, 실무 상황들이 "암기 항목"에서 **"유도 가능한 것"** 으로 바뀐 거예요.

- "인덱스를 걸었는데 왜 안 타요?" → 옵티마이저가 통계로 "페치할 행 > 페이지 수"를 계산해 일부러 안 탄 것. `random_page_cost`의 직관을 비용 모델로 직접 구현해 봤으니까.
- "VACUUM 했는데 디스크가 안 줄어요" → truncate는 파일 꼬리의 전부-빈 페이지만. 그 코드를 직접 썼으니까.
- "커밋이 느려요" → fsync 23배를 직접 쟀고, group commit 계열 다이얼(`innodb_flush_log_at_trx_commit`·`synchronous_commit`)이 정확히 무엇을 트레이드하는지 아니까.
- "replica가 낡은 값을 줘요" → 복제 lag의 구조(커밋 후 비동기 전송)와, 그걸 정말 없애려면 합의(ReadIndex)까지 가야 한다는 것을 만들어 봤으니까.

그리고 부수적인 소득 하나 — 이 시리즈 자체가 그 증거물이에요. 처음엔 41편의 시간순 빌드로그로 썼다가, 독자가 주제를 배우러 온다는 걸 인정하고 **주제별 완결 11편 + 이 회고**로 전면 재편했습니다. 글의 구조도 코드처럼 리팩토링 대상이라는 것, 그것도 이 프로젝트에서 배운 것 중 하나입니다.

## 8. 시리즈 지도

| 편 | 주제 |
|---|---|
| [①](/blog/project/db-hobby/db-internals-01-storage) | 저장의 뼈대 — 페이지·슬롯·행 포맷·힙·버퍼 풀 |
| [②](/blog/project/db-hobby/db-internals-02-btree-index) | B+Tree 인덱스 — O(log n), 인덱스는 왜 단순 key→value가 아닌가 |
| [③](/blog/project/db-hobby/db-internals-03-wal-recovery) | WAL과 크래시 복구 — redo-only에서 steal + no-force까지 |
| [④](/blog/project/db-hobby/db-internals-04-mvcc) | 격리 — 2PL에서 MVCC 스냅샷까지 |
| [⑤](/blog/project/db-hobby/db-internals-05-wire-protocol) | 진짜 psql이 붙는 서버 — wire protocol 해부 |
| [⑥](/blog/project/db-hobby/db-internals-06-optimizer) | 비용 기반 옵티마이저 — 통계·선택도·Selinger DP |
| [⑦](/blog/project/db-hobby/db-internals-07-storage-engines) | 저장 엔진의 세 철학 — 힙 vs 클러스터드 vs LSM |
| [⑧](/blog/project/db-hobby/db-internals-08-parallel) | 병렬 실행 — latch를 걷어내고, 재고, 병목을 고치기 |
| [⑨](/blog/project/db-hobby/db-internals-09-replication) | 복제 — 복구의 redo를 스트림으로 |
| [⑩](/blog/project/db-hobby/db-internals-10-raft) | Raft — 합의에서 HA DB까지 |
| [⑪](/blog/project/db-hobby/db-internals-11-sql-executor) | SQL 실행기 — 텍스트에서 행까지 |

코드와 테스트 전부: [github.com/dj258255/db-hobby](https://github.com/dj258255/db-hobby)

<!-- EN -->

## 0. A 30-Second Summary — the Numbers This Project Proved

Conclusions first. **db-hobby** is a mini relational database built from scratch in C ([GitHub](https://github.com/dj258255/db-hobby)), and every number below was **measured by me, in this project** (12-core macOS, `-O2`, measurement code in the repo).

| Claim | Evidence I measured myself |
|---|---|
| Indexes are O(log n) | vs full scan: **11×** at 1k rows → **416×** at 100k (the gap widening with N *is* the log curve) |
| Durability (fsync) is expensive | the same 5,000-row load: 3,372 rows/s per-row commits vs 79,039 rows/s in batches of 50 — **23×** |
| Clustering's weapon is locality | InnoDB-style wins PK range scans **3.8×**, loses secondary point lookups **2×** (double lookup) |
| Parallelism's ceiling isn't CPU | 12-core parallel aggregation peaked at **2.16×** — the ceiling was the buffer-pool latch; fixing it took the cold scan from **0.62× to 2.39×** |
| All of it is verified | **686 checks / 42 suites**, ThreadSanitizer & ASan/UBSan clean, crash injection, deterministic simulation |
| It speaks a real protocol | **an actual psql 14.19 connects** and demonstrates MVCC ("readers don't block writers") across two terminals |

This is the retrospective of that journey — **why I built it, how I verified it, and why I made each choice.** No feature listing (Parts [1–11](/blog/project/db-hobby/db-internals-01-storage) already do that).

## 1. Why Build It — "If You Can't Explain It, You Don't Know It"

It began with a discomfort about my own knowledge. I *could* say these sentences:

- "Indexes are fast because they're B+Trees."
- "Commits are safe because of fsync."
- "MVCC means reads don't block."

One follow-up question collapsed any of them. **Why a B+Tree and not a binary tree?** What exactly does fsync guarantee — the data file or the log? If reads don't block, what *does* prevent dirty reads? Knowledge that can't answer is memorized, not understood — and memorized knowledge fails precisely in the deformed situations of practice (when EXPLAIN skips your index; when VACUUM doesn't shrink the disk).

Studying operating systems brought the other realization: pages, caches, concurrency, fsync… **a database is a data layer restacked on the raw materials the OS provides.** Build it one layer at a time, then, and every one of those sentences would turn from "memorized" into "derivable." That was this project's problem statement.

**Why C** — when the goal is reproducing real structure, memory, pointers, and byte layout *are* the curriculum; a language that abstracts them hides exactly what I came to learn. (I considered a Java rewrite midway and dropped it — put the buffer pool on top of a GC and the question "why does a buffer pool exist" itself evaporates.) **Why reproduce rather than invent** — the goal was understanding why PostgreSQL and InnoDB look the way they do, so every layer carries a "here's how real DBs do it" comparison as a rule.

## 2. How I Worked — Claims by Tests, Verification Separated

What I most deliberately protected wasn't features but a **verification culture.** Four layers.

**① Every layer's claims are made by tests.** Not "it works" — 686 checks say so. The recovery layer in particular **injects real crashes**: die right after the commit-marker fsync and the change must survive via redo (durability); die before the marker and it must vanish cleanly (atomicity). "Power loss doesn't corrupt" is only a claim until you actually cut the power.

**② Concurrency is instrumented.** "Tests passed" is weak evidence for concurrent code — races don't fire on most runs. So buffer-pool eviction storms, latch crabbing, and parallel scans all ran under **ThreadSanitizer**, yielding "no data race existed in the observed execution." Distribution (Raft) went a step further: consensus bugs fire only under particular message schedules, unreproducible over real sockets — so the tests own a **deterministic simulated network** (logical clock, message queues, partition matrix) that replays adversarial scenarios identically.

**③ Implementation and verification are separated.** Human or AI, whoever implemented is lenient toward their own code. So the areas where "plausibly correct" is most dangerous — consensus, replication — got **independent adversarial reviews**: a verifier who didn't write the code, tasked only with breaking its claims (when using AI agents, the reviewer was barred from editing code — the moment it edits, it becomes another implementer and the verifier disappears). Everything these reviews caught was of the **"tests green, wrong in principle"** kind:

| Real bug caught by adversarial review | Why tests missed it |
|---|---|
| Recovery loaded the snapshot but never **installed** it → restarted node silently diverges | no post-snapshot scenarios existed |
| 4 membership bugs (truncation not reverting config, etc.) | manifest only under specific partitions/timings |
| SMR apply **swallowed** engine failures → single-node divergence | unobservable without failure injection |
| Read barrier acks lacked an **epoch** → false confirmation under reordering | the harness's scheduling habits masked it |

That last row was the sharpest lesson — **safety resting on a test harness's accident rather than on the code**, spotted by an independent skeptic from first principles.

**④ If you built it, measure it.** Every performance claim carries a measurement with its conditions stated (core count, warm/cold, min-time). That principle produced the next section's story.

## 3. Deep Dive ① — Measurement Finds the Bottleneck; an A/B Confirms Causality

The story I value most in this project, told in five stages.

1. **Steady state** — MVCC gave logical concurrency, but execution was serialized under one global latch. I built parallel scan and parallel aggregation so read-only queries split across workers (verified byte-identical to serial, TSan clean).
2. **The problem** — the ruler disagreed with expectations: on 12 cores, a **2.16×** peak. Worse, cold-cache (table > buffer pool), 8 workers ran at **0.62×** — *slower than serial.*
3. **The analysis** — the answer came from structure, not a profiler. One latch guards the buffer pool's frame table, and on a cache miss **the disk read (pager_read) happened inside that latch.** Eight workers queued at the latch doing I/O one at a time — twelve cores, single-lane I/O. This limit was in fact a debt I'd knowingly written into a comment: "a real DB moves I/O out of the latch with a read-in-progress state." The measurement promoted that debt's priority.
4. **Learning & fix** — on a miss, reserve the frame as `io_pending`+pinned, release the latch, read outside; threads missing the same page wait on a condition variable and wake to a hit, preventing duplicate loads (the read-in-progress pattern of the PostgreSQL lineage).
5. **The result — and confirming causality** — here's the edge. Not stopping at "I fixed it and it got faster," I added a switch toggling I/O in/out of the latch and ran an **A/B in the same process with the same warm-up** — an experiment with exactly one variable. In-latch: 1.08× (4w), 0.62× (8w). Out-of-latch: **2.39×** (4w), 1.36× (8w). Causality confirmed: I/O serialization was the ceiling. Correctness pinned by concurrently loading a cold 70k-row table against math oracles, plus a TSan-clean eviction storm.

That cycle — measure → structural analysis → fix → **single-variable A/B re-measure** — is the standard form of performance work this project taught me.

## 4. Deep Dive ② — Performance Work Unearths a "Silently Wrong Answer"

Reading the aggregation path to parallelize it, I found a **pre-existing bug** unrelated to parallelism: serial aggregation collected rows only up to a fixed buffer (4,096) before computing — `SELECT COUNT(*)` on a 6,000-row table returned **4096, with no error.** The scariest kind of bug: wrong answers with a straight face.

Two lessons. First, **performance work doubles as a correctness audit** — the code you read to make fast is the code you'd been trusting blindly. Second, **what you verify against is everything**: the fixed parallel aggregate must not be compared to serial (serial was wrong), so it was checked against **math oracles** — SUM(1..n) = n(n+1)/2. Suspecting that even your baseline may be contaminated — an attitude learned from adversarial review — did its work here too.

One more event in the same grain: wiring the LSM in as a PK index (`CREATE TABLE ... USING lsm`) hit the wall that **"an index is not a simple key→value map"** — MVCC hangs multiple row versions off one key, which a unique LSM cannot hold. Interactions like this (MVCC × index structure) that textbooks don't pre-announce are met only by building. The fix — a multi-value mode whose dedup unit is the (key, val) pair — turned out to be the same lineage RocksDB-family engines use for non-unique indexes. Discovering the real DBs were already on the road you were forced onto: that was precisely this project's intended way of learning.

## 5. A Record of Choices — No Decision Without an Answer to "Why"

Every technical choice keeps its "why this, why not the alternative." Five representatives:

| Choice | Why | Why not the alternative |
|---|---|---|
| Heap storage (PG-style) | simple INSERTs; the index separates cleanly as "key→RID" for learning | clustered (InnoDB-style) was later **contrasted in a bench module** (3.8×/2× measured) — engine wiring would cost an executor rewrite for little learning |
| Recovery starts at no-steal | learn the principle via redo-only simplicity | after **actually hitting** its price (transaction size nailed to the pool), move to steal+undo — the order that teaches "policy determines recovery" in the flesh |
| pageLSN & CLR omitted | whole-page physical logging makes redo idempotent — proved unnecessary **by crash injection**, then closed | no cargo-culting — a technique enters when the problem demanding it appears |
| Linearizable reads via ReadIndex | needs only a majority round; fits deterministic simulation | leader leases need clock assumptions — mismatched with the test infrastructure (etcd defaults to ReadIndex too) |
| Lazy B+Tree deletion | PostgreSQL's nbtree doesn't rebalance either — checked the real DB before porting the textbook | "textbook completeness" mattered less than "why real systems chose that compromise" |

## 6. What I Didn't Build — Honest Boundaries

The retrospective is honest only if what wasn't done is written too. Boundaries left deliberately:

- **No inter-query parallelism** — parallelism reaches within one query (intra-query). Different transactions still serialize under the engine latch. Making the catalog, per-table WAL, and transaction state thread-safe is the largest remaining mountain.
- **No row-level locks** — write conflicts use table-granularity first-updater-wins. Same principle as PostgreSQL, coarser grain.
- **No physiological logging, histograms, sort-merge join, or extended query protocol** — each closed with a note on which problem would make it necessary.
- **Not production** — this is a learning project. The goal was never to replace PostgreSQL but to become **able to read it.**

## 7. So What Changed

The difference before and after is that practical situations moved from "memorized items" to **"derivable things."**

- "I added an index — why isn't it used?" → the optimizer computed rows-to-fetch > page count from statistics and skipped it on purpose. I implemented the `random_page_cost` intuition as a cost model myself.
- "I ran VACUUM and the disk didn't shrink" → truncation trims only all-empty trailing pages. I wrote that code.
- "Commits are slow" → I measured the 23× fsync gap myself and know exactly what the group-commit dials (`innodb_flush_log_at_trx_commit`, `synchronous_commit`) trade.
- "The replica serves stale data" → I built the structure of replication lag (async, send-after-commit) — and learned that truly eliminating it takes consensus (ReadIndex).

One side dividend — this series itself is evidence. It was first written as a 41-part chronological build log; admitting that readers come to learn topics, I restructured it wholesale into **11 topic-complete parts plus this retrospective.** That prose structure is a refactoring target just like code — that, too, is something this project taught.

## 8. Series Map

| Part | Topic |
|---|---|
| [①](/blog/project/db-hobby/db-internals-01-storage) | The storage skeleton — pages, slots, row format, heap, buffer pool |
| [②](/blog/project/db-hobby/db-internals-02-btree-index) | The B+Tree index — O(log n), and why an index isn't a simple key→value map |
| [③](/blog/project/db-hobby/db-internals-03-wal-recovery) | WAL and crash recovery — from redo-only to steal + no-force |
| [④](/blog/project/db-hobby/db-internals-04-mvcc) | Isolation — from 2PL to MVCC snapshots |
| [⑤](/blog/project/db-hobby/db-internals-05-wire-protocol) | A server a real psql connects to — dissecting the wire protocol |
| [⑥](/blog/project/db-hobby/db-internals-06-optimizer) | The cost-based optimizer — statistics, selectivity, Selinger DP |
| [⑦](/blog/project/db-hobby/db-internals-07-storage-engines) | Three philosophies of storage engines — heap vs clustered vs LSM |
| [⑧](/blog/project/db-hobby/db-internals-08-parallel) | Parallel execution — peeling latches, measuring, fixing the bottleneck |
| [⑨](/blog/project/db-hobby/db-internals-09-replication) | Replication — streaming recovery's redo |
| [⑩](/blog/project/db-hobby/db-internals-10-raft) | Raft — from consensus to an HA database |
| [⑪](/blog/project/db-hobby/db-internals-11-sql-executor) | The SQL executor — from text to rows |

All code and tests: [github.com/dj258255/db-hobby](https://github.com/dj258255/db-hobby)

---
title: '격리: 단일 스레드 DB에서 트랜잭션 사이를 지키기'
titleEn: 'Isolation: Guarding Between Transactions in a Single-Threaded DB'
description: "관계형 DB를 C로 밑바닥부터 만든 minidb 시리즈. 4편에서 '안 만든 가장 어려운 절반'이라고 인정했던 ACID의 I(격리)를 만든다. minidb는 단일 스레드라 진짜 동시성이 없는데 무엇을 격리하나 - 그 긴장이 설계를 정한다. 인터리브된 in-process 트랜잭션 + 2PL 테이블 락으로, 충돌을 (블록 대신) 거부해 dirty read와 lost update를 막고, wait-for 그래프로 교착(deadlock) 순환을 탐지한다. 진짜 동시성(MVCC)은 아니지만 격리의 메커니즘 자체를 손으로 만져본다."
descriptionEn: "Part 11 of building a relational database from scratch in C. We build the I in ACID (isolation) - the half part 4 admitted was the hardest and was left out. minidb is single-threaded, so what is there to isolate? That tension drives the design: interleaved in-process transactions plus 2PL table locks, where a conflict is rejected (not blocked on) to prevent dirty reads and lost updates, and a wait-for graph detects deadlock cycles. It isn't real concurrency (MVCC), but it makes the mechanism of isolation tangible."
date: 2026-06-26
tags:
  - C
  - Database Internals
  - Transactions
  - Concurrency
  - Locking
  - Learning
category: project/minidb
coverImage: /uploads/project/minidb/cover.svg
draft: false
series: "minidb"
seriesOrder: 11
---

[4편](/blog/project/minidb/minidb-4-transactions)에서 ACID 중 A(원자성)와 D(내구성)는 만들었지만, **I(격리)는 "안 만든 가장 어려운 절반"이라고 솔직히 적었다.**
이번 편은 그 절반을 만든다.
그런데 시작하자마자 벽에 부딪힌다 - minidb는 단일 스레드다.
트랜잭션이 한 번에 하나씩만 도는데, **대체 무엇을 격리하나?**
이 질문이 이 글의 설계를 전부 정했다.

## 단일 스레드인데 격리할 게 있나

격리는 본질적으로 **트랜잭션 "사이"** 의 문제다.
T1이 어떤 행을 고치는 도중에 T2가 그 행을 읽으면 안 되고(dirty read), 둘이 같은 값을 동시에 고치면 한쪽 수정이 사라지면 안 된다(lost update).
이런 이상현상은 두 트랜잭션이 **겹쳐 돌 때만** 생긴다.
그런데 minidb는 트랜잭션을 하나씩만 도니, 겹칠 일이 없어 격리할 것도 없어 보인다.

게다가 더 깊은 문제가 있었다.
[3편·4편의 WAL](/blog/project/minidb/minidb-4-transactions)은 "커밋 시 그 테이블의 dirty 페이지를 **전부** flush"하는 모델이다.
만약 두 트랜잭션이 같은 테이블에 동시에 쓰면, 한쪽이 커밋할 때 다른 쪽의 미완성 변경까지 디스크에 박힌다.
즉 저장 계층부터가 "한 테이블에 writer 하나"를 전제로 짜여 있었다.
진짜 동시 쓰기를 지원하려면 행 버전 관리(MVCC)나 undo 로그(ARIES)가 필요한데, 그건 엔진을 통째로 다시 쓰는 일이다.

그래서 방향을 정했다.
**진짜 OS 동시성을 흉내 내는 대신, 인터리브된 in-process 트랜잭션 사이의 충돌을 "감지"하는 데 집중하자.**
T1을 좀 진행하고, T2를 좀 진행하고 - 이렇게 번갈아 도는 두 논리적 트랜잭션이 같은 자원을 건드리면 막는다.
이게 격리의 핵심인 **충돌 직렬화** 다.
"동시에 도는 것처럼 보이지만 실제로는 줄 세운다"는 게 격리의 본질이니까.

## 1. 락 매니저 - 충돌 행렬이 전부다

격리의 고전적 도구는 **락**이다.
읽으려면 공유 락(S), 쓰려면 배타 락(X)을 잡는다.
규칙은 작은 호환 행렬 하나다.

```
            보유 S   보유 X
   요청 S    OK      충돌
   요청 X   충돌     충돌
```

읽기끼리(S-S)는 호환된다 - 여러 트랜잭션이 같은 걸 동시에 읽어도 안전하니까.
하지만 쓰기(X)는 누구와도 충돌한다 - 쓰는 중인 걸 읽거나 같이 쓰면 위험하니까.
같은 트랜잭션은 자기 자신과 충돌하지 않고, S를 쥔 채 X로 올리는 **업그레이드**는 다른 보유자가 없을 때만 된다.

이걸 `(테이블, 키)` 단위로 추적하는 작은 락 매니저로 만들었다.
**락 단위를 테이블로 잡은 건 우연이 아니다.**
앞서 말한 WAL 제약 - "한 테이블에 writer 하나" - 때문이다.
테이블 X 락이 그걸 강제하니, 저장 계층을 한 줄도 안 고치고 격리를 얹을 수 있었다.
행 단위 락이 더 세밀하지만, 그러면 같은 테이블에 두 writer가 생겨 WAL이 깨진다.

## 2. 거부, 블록이 아니라

락을 실행기에 연결했다.
`INSERT`/`UPDATE`/`DELETE`는 그 테이블에 X 락을, `SELECT`는 S 락을 잡는다.
명시적 트랜잭션(`BEGIN`)이면 그 락을 **`COMMIT`/`ROLLBACK`까지 쥔다** - 이게 strict 2PL(2단계 잠금)이다.
autocommit 문장이면 문장 끝에 바로 푼다.

여기서 단일 스레드의 특성이 드러난다.
진짜 DB라면 충돌하는 락은 **블록**된다 - 앞 트랜잭션이 풀 때까지 기다린다.
그런데 minidb엔 기다릴 스레드가 없다.
그래서 충돌을 **거부**로 바꿨다 - 락을 못 잡으면 그 문장이 `ERROR`로 떨어진다.

이걸로 진짜 엔진에서 격리를 시연할 수 있다.
다른 트랜잭션(T99)이 테이블 `t`에 X 락을 쥔 상황을 만들어 두고:

```
-- T99가 t를 쓰는 중(X 락 보유)
SELECT * FROM t WHERE id = 1;   -- ERROR: t가 잠겨 있습니다 (읽기 충돌)
INSERT INTO t VALUES (3, 30);   -- ERROR: t가 잠겨 있습니다 (쓰기 충돌)
```

T99가 쓰는 테이블을 읽으려다 거부되는 게 **dirty read 방지**다 - 커밋 안 된 값을 못 본다.
같은 테이블에 쓰려다 거부되는 게 **lost update 방지**다 - 두 쓰기가 겹쳐 한쪽이 사라지는 걸 막는다.
반면 T99가 S 락만 쥐고 있으면 다른 `SELECT`는 통과한다(S-S 호환) - reader는 reader를 막지 않는다.
경합이 없을 땐 락이 완전히 투명해서, 격리를 붙이기 전의 테스트 300여 개가 한 줄도 안 깨졌다.

> 더 깊이: 격리 수준(Read Committed, Repeatable Read 등)과 dirty read·lost update·write skew 같은 이상현상이 무엇인지는 [트랜잭션 ACID ②: Isolation은 어떻게 구현되는가](/blog/theory/transaction-acid-02-isolation). 락 자체가 하드웨어부터 분산까지 어떻게 작동하는지는 [락 메커니즘의 모든 것](/blog/theory/lock-mechanisms-all).

## 3. 교착 - 거부 모델엔 없지만, 있어야 할 것

여기서 흥미로운 일이 생긴다.
**거부 모델에선 교착(deadlock)이 아예 안 생긴다.**
교착은 T1이 A를 쥐고 B를 기다리고, T2가 B를 쥐고 A를 기다리며 서로 영원히 못 푸는 상황인데 - minidb는 "기다림"이 없다.
못 잡으면 즉시 거부하니, 순환이 만들어질 틈이 없다.

그래도 교착 탐지를 만들었다.
**"만약 거부 대신 기다린다면" 필요해지는 것**을 보이기 위해서다.
누가 누구를 기다리는지를 그래프로 적는다 - **wait-for 그래프**.
T1이 (T2가 쥔) B를 기다리면 `T1 -> T2` 간선을 긋는다.
이 그래프에 **순환**이 있으면 교착이다.

```
T1 --기다림--> T2 --기다림--> T1     (2중 순환 = 교착)
T1 -> T2 -> T3 -> T1                 (3중 순환 = 교착)
```

순환을 DFS로 찾아, 있으면 그 안의 한 트랜잭션(victim)을 골라 돌려준다 - 실제 DB라면 그 victim을 abort해 순환을 끊는다.
단방향 대기(T2가 T1을 기다리지만 T1은 안 기다림)는 순환이 아니라 교착이 아니고, 한 대기만 풀려도 순환이 사라지는 걸 테스트로 확인했다.

## 이건 진짜 동시성이 아니다

정직하게 말하면, 내가 만든 건 **진짜 동시 실행이 아니다.**
스레드도 없고, 두 트랜잭션이 물리적으로 같이 돌지도 않는다.
PostgreSQL이 쓰는 MVCC(다중 버전 동시성 제어) - 각 트랜잭션이 자기 시점의 스냅샷을 보고, 행마다 여러 버전을 두는 방식 - 은 행 버전 관리가 필요해 엔진을 다시 써야 한다.
내가 만든 건 그 반대편 고전 기법인 **2PL 잠금**의, 그것도 단일 스레드 축소판이다.

하지만 격리의 **메커니즘**은 다 들어 있다.
S/X 락과 호환 행렬, 트랜잭션이 끝까지 락을 쥐는 2PL, 충돌로 막히는 dirty read·lost update, 그리고 wait-for 그래프로 보는 교착.
"트랜잭션 사이"라는, 단일 트랜잭션 엔진엔 없던 개념을 처음부터 발명해야 했다 - 락 소유자 id, 충돌 규칙, 대기 그래프 전부가 "다른 트랜잭션이 존재한다"를 코드로 표현한 것이다.
4편에서 가장 어렵다고 미뤘던 절반이 왜 어려운지, 만들면서 알았다.
격리는 무언가를 하는 게 아니라, **다른 누군가가 동시에 무언가를 할 때 무슨 일이 일어나는가**에 관한 것이기 때문이다.

## 닫으며

이걸로 minidb는 ACID 네 글자를 다 건드렸다.
A(원자성, [4편](/blog/project/minidb/minidb-4-transactions) 롤백), C(일관성, [9편](/blog/project/minidb/minidb-9-null-storage) NOT NULL 제약), I(격리, 이번 편 2PL), D(내구성, [3편](/blog/project/minidb/minidb-3-index-wal) WAL).
어느 하나도 "진짜 DB만큼"은 아니지만, 각 글자가 코드로 무엇을 뜻하는지는 이제 손에 잡힌다.
특히 I는, 단일 스레드라는 제약이 오히려 "격리가 정확히 무엇을 막는 것인가"를 더 또렷이 보게 해줬다.

> **시리즈**: [1. 저장 계층](/blog/project/minidb/minidb-1-storage) · [2. SQL 엔진](/blog/project/minidb/minidb-2-sql-engine) · [3. 인덱스와 WAL](/blog/project/minidb/minidb-3-index-wal) · [4. 트랜잭션](/blog/project/minidb/minidb-4-transactions) · [5. 조인과 집계](/blog/project/minidb/minidb-5-join-aggregate) · [6. BETWEEN과 LIKE](/blog/project/minidb/minidb-6-between-like) · [7. 직접 재보기](/blog/project/minidb/minidb-7-benchmark) · [8. EXPLAIN](/blog/project/minidb/minidb-8-explain) · [9. NULL 저장](/blog/project/minidb/minidb-9-null-storage) · [10. 보조 인덱스](/blog/project/minidb/minidb-10-secondary-index) · 11. 격리 · [코드(GitHub)](https://github.com/dj258255/minidb)

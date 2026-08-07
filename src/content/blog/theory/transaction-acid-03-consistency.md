---
title: '트랜잭션 ACID ③: Consistency는 사실 두 가지다'
description: ACID의 C와 CAP의 C가 같은 단어일 뿐 완전히 다른 개념이라는 점을 정리합니다. Kleppmann은 "C는 ACID에 들어갈 자격이 없다"고 말하고, CAP의 C는 사실 linearizability를 의미합니다. Eventual Consistency가 데이터 손상을 회복시키지 못하는 이유와 일관성 모델 공간(linearizability/serializability/strict serializability)까지.
date: 2026-04-17T00:00:00.000Z
tags:
  - Transaction
  - ACID
  - Consistency
  - CAP
  - Linearizability
  - Eventual Consistency
  - PACELC
  - Database
category: theory/Database
draft: false
coverImage: "/uploads/theory/transaction-acid/cover-3.svg"
series: "트랜잭션 ACID"
seriesOrder: 3
---

## 0. 들어가며

ACID에서 가장 모호한 글자가 C입니다. 면접에서도 가장 자주 헷갈리는 글자입니다. 이 글의 핵심 메시지는 이것입니다. **"ACID의 C와 CAP의 C는 같은 단어를 쓸 뿐 완전히 다른 개념이다."** Martin Kleppmann은 *Designing Data-Intensive Applications* 에서 더 강한 주장을 합니다. *"Consistency는 사실 ACID에 들어갈 자격이 없다"* 는 것입니다.

## 1. 왜 C가 가장 모호한가

[① 편(Atomicity)](/blog/theory/transaction-acid-01-atomicity)은 명확했습니다. *"전부 성공 or 전부 실패."* [② 편(Isolation)](/blog/theory/transaction-acid-02-isolation)도 (조금 복잡하지만) 명확했습니다. *"동시 트랜잭션 사이의 가시성 제어."* 곧 다룰 D(Durability)도 분명합니다. *"커밋된 변경은 영속적이다."*

그런데 C는 다릅니다. 강의에서, 책에서, 면접에서 이 단어가 등장할 때마다 사람들은 서로 다른 의미로 씁니다:

- *"DB에 쓴 데이터가 일관성을 유지한다"*: 데이터 무결성?
- *"분산 노드들이 같은 값을 본다"*: 복제본 동기화?
- *"Eventually consistent하다"*: 최종 일관성?
- *"ACID 보장한다"*: 트랜잭션 무결성?

이 네 가지가 모두 *"consistency"* 라는 한 단어로 표현됩니다. 진짜 문제는 이들이 서로 다른 개념인데 같은 단어를 공유한다는 점입니다. 첫 번째와 네 번째는 ACID의 C에 가깝고, 두 번째는 CAP의 C, 세 번째는 또 다른 차원의 보장입니다.

![Consistency가 가리키는 4가지](/uploads/theory/transaction-acid/four-cs.svg)

이번 글은 이 혼동을 풀어봅니다.

## 2. ACID의 C: 사실 애플리케이션의 책임이다

### 정의

> **ACID의 C(Consistency)**: 트랜잭션이 데이터베이스를 한 유효한 상태에서 다른 유효한 상태로 옮기는 것을 보장한다.

여기서 *"유효한 상태"* 란 무엇인가? **애플리케이션이 정의한 무결성 제약(invariants)** 을 만족하는 상태입니다:

- **외래 키 제약 (foreign key)**: 참조하는 행이 실제로 존재해야 함
- **유니크 제약 (unique)**: 중복된 값이 없어야 함
- **체크 제약 (check)**: 값이 특정 범위 안에 있어야 함
- **NOT NULL 제약**: 빈 값이 들어가면 안 됨
- **그 외 비즈니스 규칙**: *"잔액은 음수가 될 수 없다"*, *"좋아요 수는 좋아요 테이블의 행 수와 같아야 한다"*

트랜잭션이 시작될 때 이 제약들이 만족되어 있고, 트랜잭션이 끝났을 때도 만족되어야 한다는 것이 C의 의미입니다.

### Instagram 예시

![Instagram 예시: invariant이 두 테이블에 걸쳐 있다](/uploads/theory/transaction-acid/instagram-tables.svg)

여기서 invariant: `photos.likes_count = COUNT(*) FROM likes WHERE photo_id = ?`

두 테이블이 따로 있지만 *"좋아요 수의 합"* 이라는 한 가지 진실을 두 곳에서 표현하고 있습니다. 이 둘이 어긋나면(예: photos에 likes_count가 5인데 likes 테이블엔 2개뿐, 또는 likes 테이블에 photo_id=4가 있는데 photos엔 4가 없음) → 데이터 불일치, 즉 **C 위반**입니다.

### Kleppmann의 주목할 만한 입장

여기서 면접에서 차이를 만드는 디테일이 있습니다. *Designing Data-Intensive Applications* (Chapter 7)에서 Martin Kleppmann이 직접 한 말:

> *"Consistency refers to the application-specific notion of the database being in a 'good state.' It is not something that the database can guarantee; it is a property of the application, that may rely on the database's atomicity and isolation to achieve it. Thus, the letter C doesn't really belong in ACID."*

번역하면: *"Consistency는 DB가 보장할 수 있는 게 아니라 애플리케이션의 속성이다. 그래서 C는 사실 ACID에 들어갈 자격이 없다."*

왜 그런가? 생각해보면:

- **DB가 보장할 수 있는 것**: 외래 키(FK), 유니크(UNIQUE), 체크(CHECK), NOT NULL, 그리고 PostgreSQL의 EXCLUSION 제약 같은 DB가 알 수 있는 무결성. 트랜잭션이 이걸 위반하면 DB가 자동으로 ROLLBACK하므로, DB는 결코 *"별 역할 없는"* 게 아닙니다. 잘 설계된 스키마라면 상당 부분의 invariant을 DB 레벨에서 강제할 수 있습니다.
- **DB가 보장할 수 없는 것**: DB가 알 수 없는 비즈니스 규칙. *"이체할 때 출금 = 입금"* 같은 규칙은 DB가 모릅니다(여러 행 사이의 관계라 일반적인 제약으로 표현 불가). 애플리케이션이 트랜잭션을 올바르게 작성해야 보장됩니다.

[① 편](/blog/theory/transaction-acid-01-atomicity)에서 다룬 계좌 이체 예시를 다시 보면:

```sql
BEGIN;
UPDATE account SET balance = balance - 100 WHERE id = 1;
UPDATE account SET balance = balance + 100 WHERE id = 2;
COMMIT;
```

이 트랜잭션이 *"출금 = 입금"* 이라는 invariant을 유지하는 건 개발자가 이렇게 작성했기 때문입니다. 만약 두 번째 UPDATE를 빼먹어도 DB는 아무 불평 없이 커밋합니다. DB는 이것이 invariant 위반인지 모르기 때문입니다.

즉 C는 **개념적으로는 A·I와 별개의 속성이지만, 실제로는 A(원자성)와 I(격리) 위에서 구현됩니다.** A와 I가 잘 작동해야 애플리케이션이 invariant을 유지할 수 있는 기반이 마련됩니다. 그 위에서 invariant을 정의하고 지키는 것은 애플리케이션의 몫입니다.

> **2장 요약**: ACID의 C는 애플리케이션이 정의한 무결성 제약이 트랜잭션 전후로 유지된다는 의미입니다. DB가 직접 보장하는 건 일부(FK, UNIQUE 등)뿐이고, 비즈니스 규칙은 애플리케이션 책임입니다. Kleppmann은 *"C는 사실 ACID에 들어갈 자격이 없다"* 고 주장합니다.

## 3. CAP의 C: 완전히 다른 개념

여기서부터 헷갈림의 진원지입니다. **CAP 정리에 나오는 C는 ACID의 C와 완전히 다른 개념입니다.**

### 정의

> **CAP의 C(Consistency)**: 일반적으로 **Linearizability** 로 해석됩니다. 분산 시스템이 마치 단일 복사본만 있는 것처럼 동작한다는 보장이며, 모든 연산이 invocation과 response 사이의 어느 시점에 원자적으로 일어난 것처럼 보이고, 실시간 순서(real-time ordering) 를 따릅니다. A 연산이 끝난 후 B 연산이 시작되면 B는 반드시 A의 결과를 봅니다. 이 real-time 순서 보장이 sequential consistency나 causal consistency 같은 더 약한 모델과 구분되는 핵심입니다.

Kleppmann의 *Designing Data-Intensive Applications* (Chapter 9)에서 더 정확한 정의:

> *"Make a system appear as if there were only one copy of the data, and all operations on it are atomic. Once a new value has been written or read, all subsequent reads see the value that was written, until it is overwritten again."*

이게 핵심입니다. **단일 복사본 추상화 + 쓰기 후 모든 읽기는 그 값(또는 이후 값)을 본다.**

Martin Kleppmann의 직접 인용 (블로그 *"Please stop calling databases CP or AP"*, 2015):

> *"Consistency in CAP actually means linearizability, which is a very specific (and very strong) notion of consistency. In particular it has got nothing to do with the C in ACID, even though that C also stands for 'consistency'."*

번역: *"CAP의 C는 linearizability를 의미하고, ACID의 C와는 아무 관계가 없다."*

### 직관적 예시

Bob과 Alice가 같이 호텔을 예약합니다. John이 마지막 방을 예약했고, 그 응답을 받은 시점 이후에 Bob이 페이지를 새로고침한다고 가정합니다.

- **Linearizable system**: Bob의 새로고침은 반드시 John의 예약 결과를 봅니다. *"예약 불가능"* 으로 표시됩니다.
- **Non-linearizable system**: Bob의 요청이 아직 동기화 안 된 복제본으로 가서 *"예약 가능"* 표시. 잠시 후 진실이 드러남.

Linearizability의 핵심은 **실시간 순서 보장**입니다. 한 연산 A가 완료된 후에 시작된 연산 B는 반드시 A의 결과를 본다는 뜻입니다. 마치 데이터베이스가 한 카피만 있는 것처럼 동작한다는 보장입니다.

### "일관된 읽기"가 바로 이거다

흔히 말하는 두 번째 종류의 일관성, 즉 primary에 쓰고 replica에서 읽으면 옛날 값이 나올 수 있다는 것이 정확히 **CAP의 C(linearizability) 위반** 입니다. ACID의 C와는 별개 문제입니다.

### ACID-C와 CAP-C 비교

![ACID-C vs CAP-C](/uploads/theory/transaction-acid/acid-c-vs-cap-c.svg)

| 측면 | ACID의 C | CAP의 C (Linearizability) |
|---|---|---|
| 의미 | 트랜잭션이 무결성 제약을 깨지 않음 | 단일 복사본처럼 보이고, 쓰기가 끝난 후의 모든 읽기는 그 값(또는 그 이후 값)을 본다 |
| 범위 | 단일 DB의 트랜잭션 단위 | 분산 시스템 전체 |
| 누가 보장? | 애플리케이션 (DB는 일부 도움) | 합의 알고리즘(Paxos/Raft 등) + 복제 |
| 예시 | *"좋아요 수가 likes 테이블 행 수와 같다"* | *"쓰고 즉시 읽으면 그 값이 나온다"* |
| 반대 개념 | 데이터 손상 (corruption) | Stale read (linearizability를 보장하지 않는 약한 모델들) |

> **3장 요약**: CAP의 C는 Linearizability(시스템이 단일 복사본처럼 보이고 실시간 순서를 따름)를 가리키는 분산 시스템 개념이고, ACID의 C(트랜잭션 무결성)와는 완전히 다른 개념입니다.

## 4. Eventual Consistency: 또 다른 C

### 정의

> **Eventual Consistency**: *"충분한 시간이 지나면 모든 복제본이 동일한 값으로 수렴(converge)한다"* 는 보장. 핵심은 **replica convergence** 이며, stale read는 그 결과 중 하나일 뿐입니다.
>
> 단, **수렴 시점에 대한 시간적 보장은 없습니다.** 1초 후일 수도, 1분 후일 수도, 노드 장애가 회복될 때까지일 수도 있습니다. 이게 strong consistency와의 결정적 차이입니다. strong consistency는 *"쓰자마자 보인다"* 를 보장하지만, eventual consistency는 *"언젠가 보인다"* 만 보장합니다.

이건 CAP의 C(linearizability)를 약화시킨 보장입니다. ACID의 C와는 또 다른 차원의 이야기입니다.

### 핵심 통찰: "Eventual Consistency는 손상된 데이터를 회복시키지 못한다"

흔한 오해를 정확히 짚으면:

- **흔한 오해**: *"지금 데이터가 좀 이상해도 결국엔 일관성을 가질 거야"*
- **정확한 사실**: Eventual consistency는 **복제본 간 수렴에만** 적용됩니다.

Instagram 예시로 돌아가서, `photos.likes_count = 5`인데 likes 테이블엔 행이 2개뿐이라면, 이건 eventual하게 5와 2가 일치하게 되지 **않습니다.** 이미 데이터가 손상된 것이고, eventual consistency 자체는 이걸 자동으로 회복시켜주지 않습니다. 회복하려면 별도의 보정 메커니즘이 필요합니다. 배치 reconciliation 작업, CRDT 같은 충돌 해소 자료구조, 재처리 파이프라인, 또는 트랜잭션 재실행 같은 것들입니다. 이런 메커니즘을 따로 설계하지 않으면 손상 상태로 남습니다.

즉:

- **ACID의 C 위반 (데이터 손상)**: eventual하게 회복 안 됨. 별도 수정 필요.
- **CAP의 C 위반 (stale read)**: 보통 복제 동기화로 회복되지만, 비동기 복제에서 primary 장애 시 미복제 데이터는 영구 손실 가능.

이 둘을 구분하는 게 결정적입니다.

> **흔한 오해 정정, *"eventual consistency는 NoSQL 얘기다"***: 아닙니다. 단일 노드 PostgreSQL에 read replica를 한 대 붙이는 순간, 또는 앞단에 Redis / Memcached 캐시를 두는 순간부터 시스템은 이미 eventual consistency 모델로 들어갑니다. primary에 쓰고 직후 replica에서 읽으면 옛 값이 나오고, DB를 갱신해도 캐시는 한 박자 늦게 무효화됩니다.
>
> 즉 *"우리 DB가 ACID를 지키니까 시스템 전체도 strong consistency"* 라는 가정은 단일 노드에서만 성립합니다. 복제본 · 캐시 · CDN처럼 **데이터가 두 군데에 존재하는 순간 eventual consistency의 영역** 이고, 그 trade-off를 *"NoSQL 쓸 때만 신경 쓴다"* 고 미루면 운영에서 직접 부딪힙니다.

### Eventual Consistency를 받아들이는 이유

DynamoDB, Cassandra, Riak 같은 시스템들이 의도적으로 eventual consistency를 선택하는 이유:

- **Linearizability는 비싸다.** 합의 알고리즘으로 quorum의 합의를 받아야 하고, 네트워크 지연·노드 장애 시 가용성이 저하됩니다.
- **수많은 워크로드는 stale-read를 견딜 수 있다.** SNS 좋아요 수가 1초 늦게 갱신돼도 비즈니스 영향 거의 없음.
- **CAP 정리 (정확한 의미)**: 네트워크 분할(P)이 발생한 상황에서만 일관성(C)과 가용성(A) 중 하나를 포기해야 한다는 정리입니다. 평소(분할 없을 때)에는 셋 다 가능. Brewer 본인이 2012년에 *"two out of three"* 단순화는 오해를 부른다고 명확히 했고, 평소 상황의 트레이드오프(consistency vs latency)는 **PACELC 정리** 가 다룹니다.

> *"최종 일관성은 마케팅 용어"* 라는 표현은 약간 과한 비판입니다. 제대로 설계된 분산 시스템에서는 합리적인 트레이드오프입니다. 다만 그것이 데이터 무결성을 보장한다는 의미는 아니라는 점을 명확히 해야 합니다.

> **4장 요약**: Eventual Consistency는 CAP의 C를 약화시킨 보장이고, 복제본 간 수렴에 대한 약속이지 데이터 무결성 회복 약속이 아닙니다. 분산 시스템에서 가용성·성능을 위한 합리적 선택일 수 있지만, ACID의 C를 대체하지는 못합니다.

## 5. 동기 복제 vs 비동기 복제

CAP의 C를 어떻게 강하게 보장할지가 복제 전략의 핵심입니다. 두 극단부터 보면:

### 동기 복제 (Synchronous Replication)

- 쓰기 시 정해진 수의 복제본(보통 quorum, 또는 모든 동기 standby)에 기록되어야 커밋 완료.
- **Linearizability에 가까움** (특히 합의 알고리즘과 결합 시).
- 단점: 느림. quorum이 못 모이거나 동기 standby가 응답하지 못하면 쓰기가 막힘.

### 비동기 복제 (Asynchronous Replication)

- 쓰기는 primary에 반영되고 즉시 커밋. 복제는 백그라운드.
- 일반적으로 **eventual consistency** 모델.
- 장점: 빠름, 가용성 높음. 단점: stale read 가능 + primary 장애 시 복제 안 된 데이터 손실 가능.

### 실제 DB의 풍부한 스펙트럼

PostgreSQL의 `synchronous_commit` 설정을 보면 두 극단 사이의 단계가 보입니다:

| 값 | 의미 |
|---|---|
| `off` | WAL이 디스크에 fsync되기 전에 커밋 응답 (가장 빠름, 데이터 손실 위험) |
| `local` | 로컬 WAL만 fsync 확인 (복제 무관) |
| `remote_write` | 복제본의 메모리까지만 도착 확인 |
| `on` (기본) | 로컬 WAL fsync 확인 (복제본 관련 의미는 `synchronous_standby_names` 설정이 있을 때만) |
| `remote_apply` | 복제본이 실제 적용까지 완료 확인 (가장 강한 보장, 가장 느림) |

> **주의**: `synchronous_commit = on`이 복제본까지의 보장을 가지려면 별도로 `synchronous_standby_names`로 동기 standby를 지정해야 합니다. 둘이 조합되어야 의미가 완성됩니다. 단독으로 `on`만 보고 *"복제본까지 보장"* 이라고 단정하면 부정확합니다.

이런 다이얼은 D편(Durability)에서 더 자세히 다룰 것입니다. 핵심은 linearizability 자체는 만족/불만족의 boolean 성질이지만, **어떤 일관성 모델을 선택하느냐는 풍부한 모델 공간**이라는 점입니다.

### 일관성 모델 공간

![일관성 모델: 두 차원과 그 교집합](/uploads/theory/transaction-acid/consistency-models.svg)

일관성 모델들은 단순한 일직선이 아니라 두 차원으로 나뉩니다 (Bailis, Jepsen.io 분류):

- **단일 객체(single-object) 차원**: linearizability → sequential consistency → causal consistency → eventual consistency. 강한 → 약한 순서.
- **다중 객체/트랜잭션 차원**: serializability, 즉 트랜잭션이 어떤 직렬 순서와 동등하다는 보장. linearizability와는 직접 비교 불가능한 다른 축.
- **두 차원을 합친 것**: **strict serializability**, 트랜잭션 직렬화 + 실시간 순서. Google Spanner가 대표적.

즉 linearizability는 단일 객체 일관성의 최강이고, serializability는 트랜잭션 일관성의 표준이며, 둘이 만나는 지점이 strict serializability입니다. 시스템은 워크로드에 따라 이 모델 공간 어딘가를 선택합니다.

> **5장 요약**: 일관성 모델은 단일 객체 차원(linearizability ↔ eventual)과 트랜잭션 차원(serializability)으로 나뉘고, 둘을 합친 strict serializability가 가장 강합니다. 시스템은 동기/비동기 복제 + fsync 타이밍 + 적용 시점 등의 다이얼로 어느 모델을 선택할지 조정합니다.

## 6. 정리: C라는 단어가 가리키는 4가지

면접/실무에서 *"consistency"* 라는 단어가 나오면 어떤 의미인지 먼저 명확히 해야 합니다:

| # | 명칭 | 의미 | 누가 보장? |
|---|---|---|---|
| 1 | ACID의 C | 트랜잭션이 무결성 제약을 유지 | 애플리케이션 (DB는 FK/UNIQUE 등 일부 도움) |
| 2 | CAP의 C (Linearizability) | 시스템이 단일 복사본처럼 보임 + 실시간 순서 보장 | 합의 알고리즘 + 복제 메커니즘 |
| 3 | Eventual Consistency | 시간이 지나면 노드들이 같은 값으로 수렴 | 비동기 복제 시스템 |
| 4 | Transaction-level Read Consistency | 같은 트랜잭션 안에서 같은 값을 봄 | [② 편](/blog/theory/transaction-acid-02-isolation)의 격리 수준 (RR, SERIALIZABLE) |

이 네 개는 같은 단어를 쓸 뿐 완전히 다른 개념입니다. 면접/실무에서 어느 의미로 쓰이는지 명확히 하지 않으면 대화가 어긋납니다.

### 핵심 통찰들

- **C는 개념적으로는 독립적이지만, 실제로는 A와 I 위에서 구현된다**: Atomicity가 깨지면 무결성 제약도 쉽게 깨지고(반쪽 트랜잭션), Isolation이 약하면 일관성 없는 읽기로 invariant 검증이 잘못될 수 있습니다. 개념적으로는 C(invariant 유지)가 A·I와 별개의 속성이지만, 애플리케이션이 invariant을 유지하려면 A와 I가 정상 작동해야 합니다. 이게 Kleppmann이 *"C는 ACID에 들어갈 자격이 없다"* 고 한 배경입니다.
- **ACID의 C는 데이터 무결성, CAP의 C는 분산 노드 동기화**: 이름만 같지 푸는 문제가 다릅니다.
- **Eventual Consistency는 복제본 간 수렴(convergence)을 보장**합니다: 그러나 invariant이 깨진 데이터(데이터 손상)는 자동 회복되지 않으며, 별도의 보정 메커니즘(reconciliation 배치, CRDT, 재처리 등)이 필요합니다.
- **복제 전략은 트레이드오프**: 강한 일관성 ↔ 가용성 ↔ 성능. 절대값이 아니라 다이얼로 조절.

## 참고 (1차 자료 우선)

- Martin Kleppmann, *Designing Data-Intensive Applications*, Chapter 7: *"C doesn't really belong in ACID"* 주장의 출처
- [Martin Kleppmann — Please stop calling databases CP or AP](https://martin.kleppmann.com/2015/05/11/please-stop-calling-databases-cp-or-ap.html): CAP의 C가 linearizability라는 점 직접 설명
- Herlihy & Wing, *Linearizability: A Correctness Condition for Concurrent Objects* (1990): linearizability의 원전 논문
- [Jepsen.io — Linearizability](https://jepsen.io/consistency/models/linearizable): 권위 있는 정의 (*"strongest single-object consistency model"*)
- [Daniel Abadi — PACELC theorem](https://www.cs.umd.edu/~abadi/papers/abadi-pacelc.pdf): CAP의 partition-only 한계를 보강
- [Eric Brewer — CAP Twelve Years Later (2012)](https://www.infoq.com/articles/cap-twelve-years-later-how-the-rules-have-changed/): CAP 창시자의 *"two out of three는 오해"* 명확화
- [Confusing Consistency: CAP vs ACID — savchenko.tech](https://savchenko.tech/posts/confusing-consistency/): *"CAP Consistency means linearizability and ACID Consistency is application's responsibility"*
- [Consistency in the CAP theorem vs. consistency in ACID transactions](https://www.alachisoft.com/blogs/consistency-in-cap-vs-acid/): 두 개념의 역사적 기원과 차이
- [The confusing CAP and ACID wording — Nicolas Liochon](https://blog.thislongrun.com/2015/03/the-confusing-cap-and-acid-wording.html): Atomic-in-CAP vs Atomic-in-ACID 까지 다룬 정밀 분석
- [Inconsistent thoughts on database consistency — Alex DeBrie](https://www.alexdebrie.com/posts/database-consistency/): 실용적 관점의 정리

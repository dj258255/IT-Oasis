---
title: 'MySQL, MongoDB, Redis를 같이 쓴 이유'
description: 채팅 시스템에서 MySQL(관계 데이터), MongoDB(메시지 저장), Redis(실시간 전달+캐싱) 세 DB를 함께 사용한 Polyglot Persistence 설계를 정리한다.
date: 2025-11-11T00:00:00.000Z
tags:
  - MySQL
  - MongoDB
  - Redis
  - Polyglot Persistence
  - Event-Driven
category: team/Joying
draft: false
coverImage: "/uploads/project/Joying/mysql-mongodb-redis-why/mysql-relational-data.svg"
series: "Joying"
---

Redis Pub/Sub + MongoDB로 메시지 브로커를 결정했습니다. 그런데 프로젝트 전체를 보면 MySQL, MongoDB, Redis 세 가지 데이터베이스를 쓰고 있습니다.

**"DB 3개 쓰면 관리 안 힘든가?"**

팀원이 물었습니다. 맞는 말입니다. 복잡도가 올라갑니다. 그래도 이렇게 설계한 이유가 있습니다.

---

## 단일 DB로 해결할 수 없었나?

처음엔 "MySQL 하나로 다 해결하면 안 되나?"라는 질문이 있었습니다. 검토해봤습니다.

> **측정 환경**: EC2 t3.medium (2 vCPU, 4GB RAM), Docker Compose 내 MySQL 8.0 / MongoDB 6.0. 채팅 메시지 1,000건을 순차 Insert하여 평균 소요시간 측정.

### 1. MySQL만 사용

단일 DB로 관리는 간단하지만, 채팅 메시지 Insert가 느리다. 직접 측정 결과 MySQL Insert 평균 **~15ms** (InnoDB, `chat_message` 테이블, 인덱스 3개 포함). 행 단위 잠금(Row-level Lock) 때문에 동시 전송 시 트랜잭션이 직렬화되어 병목이 생깁니다.

### 2. MongoDB만 사용

직접 측정 결과 MongoDB Insert 평균 **~5ms** (WiredTiger, `chatMessages` 컬렉션, 복합 인덱스 1개). MySQL 대비 3배 빠르다. 하지만 JOIN이 안 돼서 채팅방-사용자-상품 관계를 Application Join으로 처리해야 합니다. 느리고 코드가 복잡해집니다.

### 3. Polyglot Persistence (선택)

각 데이터에 최적화된 저장소를 쓰는 방식입니다. DB 3개를 운영하는 복잡도가 올라가지만, 단일 DB로는 성능 요구사항을 맞출 수 없었습니다.

**트래픽 추정 근거**: 6주 프로젝트 기준 동시 사용자 50-100명, 채팅방 평균 10개/인, 메시지 전송 빈도 1-2건/초/채팅방으로 추정하면 피크 시 초당 수백 건의 메시지가 발생한다. 목록 조회(채팅방 진입, 앱 열기)는 더 빈번하여 메시지 전송의 3-5배. 이 규모에서 MySQL 단독으로 메시지 Insert(15ms/건 × 직렬화)와 목록 조회(N+1 쿼리)를 동시에 처리하면 병목이 발생한다.

---

## 데이터 특성이 다르다

### MySQL: 관계형 데이터

채팅방은 Member, Product와 관계를 맺습니다.

![](/uploads/project/Joying/mysql-mongodb-redis-why/mysql-relational-data.svg)


![](/uploads/project/Joying/mysql-mongodb-redis-why/mysql-relational-data-2.svg)


MongoDB로 이걸 하려면 Application Join이 필요합니다. 느립니다.

**왜 PostgreSQL이 아니라 MySQL인가?** 채팅방 메타데이터는 단순 CRUD + JOIN이 주를 이루고, 복잡한 쿼리(Window Function, CTE 등)가 필요하지 않다. 팀원 4명 중 3명이 MySQL 경험이 있고, 삼성 SW 아카데미 기본 교육도 MySQL 기반이었다. 6주 프로젝트에서 PostgreSQL로 전환하는 학습 비용 대비 얻는 이점이 없었다. 다만 PostgreSQL의 JSONB 타입은 MongoDB 대체 가능성이 있었지만, 채팅 메시지의 write-heavy 특성상 별도 MongoDB가 더 적합하다고 판단했다.

### MongoDB: 쓰기 성능

채팅 메시지는 읽기도 많지만, 쓰기 성능이 더 critical합니다.

채팅 메시지 특성:
- 쓰기 성능이 critical (실시간 전송, 지연 시 UX 저하)
- 동시 쓰기 빈번 (같은 채팅방에 여러 명이 동시에 전송)
- JOIN 불필요 (메시지는 독립적)
- 스키마 변경 가능성 (이미지, 파일, 음성 등 추가)


MongoDB는 Insert에 최적화되어 있습니다. 문서 단위 잠금이라 동시성도 좋습니다.

| 작업 | MySQL | MongoDB |
|------|-------|---------|
| Insert | ~15ms | ~5ms |
| 동시성 | 행 단위 잠금 | 문서 단위 잠금 |

### Redis: 실시간성

Pub/Sub은 메모리 기반이라 디스크 I/O가 없습니다. 초당 수만 건 처리 가능하고, 지연 시간이 1ms 이하입니다.

캐싱도 Redis가 담당합니다. 안읽은 메시지 개수, 세션 정보처럼 자주 읽히는 데이터를 메모리에 둡니다.

---

## MySQL JSON 컬럼은 왜 안 되는가

처음엔 MySQL의 JSON 컬럼에 메시지 배열로 저장하면 되지 않나 싶었습니다.

![](/uploads/project/Joying/mysql-mongodb-redis-why/mysql-json-column-issues.svg)


세 가지 문제가 있었습니다.

### 1. 파싱 오버헤드


**메시지 50개 조회**
JSON 파싱 → 역직렬화 → 필터링 → 직렬화 → 반환
→ 100ms 이상


### 2. 인덱싱 불가

![](/uploads/project/Joying/mysql-mongodb-redis-why/no-indexing.svg)

> 전체 JSON 스캔 (인덱스 못 씀)

### 3. 동시성 문제


**사용자 A와 B가 동시에 메시지 전송**

Thread 1: JSON 배열 업데이트 → 전체 행 잠금
Thread 2: 대기...


MySQL은 행 단위 잠금입니다. JSON 배열에 메시지 1개만 추가해도 전체 채팅방이 잠깁니다.

**MongoDB는 이런 문제가 없다:**

![](/uploads/project/Joying/mysql-mongodb-redis-why/concurrency-issue.svg)


---

## Event-Driven Architecture

보통 채팅 시스템의 핵심은 Event-Driven Architecture입니다.

한 채팅방의 인원을 서버 하나에 다 넣으면 서버가 죽어서 분산이 필수입니다.


1. 메시지 전송 = 이벤트 발행
2. Redis Pub/Sub = 이벤트 버스
3. 서버들 = 이벤트 구독자 (독립적)
4. 각 서버가 자신의 클라이언트에게 전송


### 서버 간 결합도가 낮다

![](/uploads/project/Joying/mysql-mongodb-redis-why/low-server-coupling.svg)


서버 1이 죽어도 서버 2, 3은 영향 없이 동작합니다.

### 수평 확장이 쉽다

![](/uploads/project/Joying/mysql-mongodb-redis-why/horizontal-scaling.png)



Redis Pub/Sub은 그대로. 새 서버 추가만 하면 자동으로 구독합니다.

---

## Polyglot Persistence

한 애플리케이션에서 여러 종류의 데이터베이스를 혼용하는 패턴을 Polyglot Persistence라고 합니다.


**MySQL: 채팅방 메타데이터**
- ChatRoom, Member, Product
- 관계형 데이터 (JOIN 필요)
- 트랜잭션 보장

**MongoDB: 채팅 메시지**
- ChatMessage (빠른 쓰기)
- CompoundIndex (빠른 조회)
- 스키마 유연성

**Redis: 실시간 전달 + 캐싱**
- Pub/Sub (메시지 브로드캐스트)
- 세션 관리
- 안읽은 메시지 개수 캐싱


복잡도가 올라가는 건 맞습니다.
3개의 DB를 각각 관리해야 하고, 트랜잭션도 복잡해집니다.
MySQL에서 실패하면 MongoDB도 롤백해야 하는데, 분산 트랜잭션은 구현이 어렵습니다.

그래도 선택한 이유는 성능입니다. 각 데이터에 최적화된 저장소를 쓰니까 성능이 압도적으로 좋습니다.
채팅 메시지는 MongoDB로 빠르게 쓰고, 안읽은 메시지 개수는 Redis로 즉시 읽고, 사용자 정보는 MySQL로 관계 관리합니다.

채팅은 일관성보다 성능이 더 중요합니다. 안읽은 메시지 개수가 1-2초 늦게 업데이트되는 건 사용자가 거의 못 느낍니다.

---

## 실제 구현

### ChatMessage (MongoDB Document)

![](/uploads/project/Joying/mysql-mongodb-redis-why/chat-message-mongodb.svg)


### ChatRoom (MySQL Entity)

![](/uploads/project/Joying/mysql-mongodb-redis-why/chat-room-mysql.svg)


### Factory Pattern (메시지 타입별 생성)

![](/uploads/project/Joying/mysql-mongodb-redis-why/factory-pattern.svg)


메시지 타입별로 필수 필드를 강제합니다. `createImageMessage`는 `imageUrl`이 필수 파라미터라서, 없으면 컴파일 에러가 납니다.

---

## 결과

| DB | 역할 | 성능 |
|----|------|------|
| MySQL | 채팅방 메타데이터, 관계 | JOIN 쿼리 최적화 |
| MongoDB | 채팅 메시지 저장 | Insert 5ms |
| Redis | 실시간 전달, 캐싱 | 1ms 이하 |

3개 DB 운영 복잡도보다 성능 이득이 훨씬 큽니다.

---
title: '옵티마이저를 눈에 보이게: EXPLAIN 만들기'
titleEn: 'Making the Optimizer Visible: Building EXPLAIN'
description: "관계형 DB를 C로 밑바닥부터 만든 minidb 시리즈. 3편·5편에서 만든 플래너(인덱스 점조회/범위/풀스캔, 조인 방법 선택)는 실행 안에 숨어 보이지 않았다. EXPLAIN을 붙여 그 결정을 트리로 출력한다. 핵심은 별도 추정기를 만들지 않고 실행기가 결정을 내리는 바로 그 지점에서 플랜을 찍는 것 - 그래서 플랜과 실제 실행이 절대 어긋나지 않는다. 덤으로 ORDER BY나 LIMIT만 붙어도 인덱스가 꺼지는 minidb의 한계가 플랜에 정직하게 드러난다."
descriptionEn: "Part 8 of building a relational database from scratch in C. The planner built in parts 3 and 5 (index point/range/scan, join-method choice) was invisible, buried inside execution. EXPLAIN prints those decisions as a tree. The key: don't build a separate estimator - emit the plan at the exact point the executor makes the decision, so the plan can never diverge from reality. As a bonus, minidb's limits (ORDER BY or LIMIT disabling the index) show up honestly in the plan."
date: 2026-06-15
tags:
  - C
  - Database Internals
  - Query Planner
  - EXPLAIN
  - Learning
category: project/minidb
coverImage: /uploads/project/minidb/cover.svg
draft: false
series: "minidb"
seriesOrder: 8
---

[3편](/blog/project/minidb/minidb-3-index-wal)에서 "PK 조건이면 인덱스 점 조회, 범위면 범위 스캔, 아니면 풀 스캔"이라는 플래너의 씨앗을 만들었고, [5편](/blog/project/minidb/minidb-5-join-aggregate)에선 조인마다 인덱스·해시·중첩 루프 중 하나를 고르게 했다.
그런데 이 결정들은 전부 실행 코드 안에 숨어 있었다.
쿼리를 던지면 결과 행만 나올 뿐, "그래서 인덱스를 쓴 거야 만 거야?"는 보이지 않는다.
진짜 DB엔 그걸 보여주는 `EXPLAIN`이 있다.
이번 편은 그걸 붙인다.

## 핵심 결정: 추정하지 말고, 실행기에게 물어라

EXPLAIN을 만드는 방법은 크게 둘이다.
하나는 **플랜을 따로 추정하는 코드**를 새로 짜는 것 - WHERE를 보고 "아마 인덱스를 쓰겠지" 하고 별도로 판단해 출력한다.
간단해 보이지만 함정이 있다.
그 추정 로직과 실제 실행기의 결정이 **시간이 지나며 어긋난다.**
실행기를 고쳤는데 EXPLAIN 추정기를 안 고치면, 플랜은 "인덱스 쓴다"는데 실제론 풀 스캔을 도는 거짓말쟁이가 된다.
실무에서도 EXPLAIN과 실제 실행 계획이 다른 건 악명 높은 디버깅 지옥이다.

그래서 나는 둘째 길로 갔다.
**추정기를 따로 만들지 않고, 실행기가 결정을 내리는 바로 그 지점에서 플랜을 찍는다.**
조인 방법을 고르는 코드는 이미 5편에 있다.
거기서 `method[k]`를 다 정한 직후, 해시를 빌드하기 직전에 이 한 줄을 끼웠다.

```c
/* 레벨별 method를 다 고른 직후 - EXPLAIN이면 여기까지의 결정만 찍고 끝낸다 */
if (sel->explain) {
    explain_join(out, sel, &m);
    return 0;
}
/* (아니면 계속) 해시 조인 레벨은 미리 해시를 빌드하고... */
```

단일 테이블도 똑같다.
실행기가 인덱스를 쓸지 말지 판정하는 `pk_cond` 로직과 **글자 그대로 같은 조건**을 EXPLAIN이 다시 평가해 출력한다.
즉 EXPLAIN은 결정을 따라 하지 않는다 - 결정을 내리는 코드 옆에 붙어, 그 결정을 그냥 받아 적는다.
그래서 플랜과 실제 실행이 **구조적으로 어긋날 수가 없다.**
실행기가 바뀌면 EXPLAIN도 자동으로 따라 바뀐다.

## 플랜은 트리다

쿼리 실행은 파이프라인이다.
스캔이 행을 뱉으면 -> WHERE가 거르고 -> 조인이 잇고 -> GROUP BY가 접고 -> ORDER BY가 정렬하고 -> LIMIT이 자른다.
그래서 플랜도 트리로 찍는다.
맨 위가 마지막에 일어나는 일(결과), 안으로 들어갈수록 먼저 일어나는 일이다.
복잡한 쿼리 하나를 EXPLAIN해 보면 이렇게 나온다.

```
EXPLAIN SELECT users.name, COUNT(*) FROM users JOIN orders ON users.id = orders.uid
        WHERE users.id > 2 GROUP BY users.name ORDER BY 2 DESC LIMIT 5;

Limit  (limit=5)
  Sort  (keys: col2 DESC)
    GroupAggregate  (group: name; aggs: COUNT(*))
      Filter  (users.id > 2)
        Nested-Loop Join  (2 tables)
          Seq Scan on users  (outer)
          Hash Join -> orders  (build hash on join col)
```

아래에서 위로 읽으면 그대로 실행 순서다.
`users`를 훑고(Seq Scan), `orders`를 조인 컬럼으로 해시 빌드해 잇고(Hash Join), `users.id > 2`로 거르고(Filter), 이름으로 묶어 세고(GroupAggregate), 집계값으로 정렬하고(Sort), 위 5개만(Limit).
조인 레벨에 붙은 `Hash Join`은 5편에서 고른 그 방법이다 - 안쪽 `orders`의 조인 키(`uid`)가 PK가 아니라서 인덱스 대신 해시를 빌드한 것.
만약 안쪽 조인 키가 PK였다면 거기엔 `Index Nested Loop`이 찍힌다.

## 정직한 플랜: ORDER BY가 인덱스를 끈다

EXPLAIN을 붙이고 나서 제일 재밌었던 건, minidb의 **한계가 플랜에 그대로 드러난다**는 점이었다.

```
EXPLAIN SELECT * FROM users WHERE id = 2;
Index Point Lookup on users using id  (id = 2)

EXPLAIN SELECT * FROM users WHERE id = 2 LIMIT 1;
Limit  (limit=1)
  Seq Scan on users  (filter: id = 2)
```

같은 `WHERE id = 2`인데, `LIMIT`을 붙였더니 `Index Point Lookup`이 `Seq Scan`으로 바뀌었다.
이건 버그가 아니라 minidb의 실제 동작이다.
[3편](/blog/project/minidb/minidb-3-index-wal)에서 인덱스 경로를 "`SELECT *` 이고 `ORDER BY`/`LIMIT`/`OFFSET`이 없을 때"로만 좁게 열어 뒀기 때문이다.
정렬·자르기가 끼면 행을 모았다가 후처리하는 다른 경로로 빠지면서, 그 경로는 인덱스를 안 쓴다.

말로 설명할 땐 흐릿했던 이 한계가, EXPLAIN으로 보니 한눈에 잡혔다.
사실 이게 EXPLAIN의 본질이다.
"왜 이 쿼리가 느리지?"는 결국 "옵티마이저가 왜 인덱스를 안 썼지?"인 경우가 많고, 그 답을 눈으로 보게 해 주는 도구가 EXPLAIN이다.
실무에서 `WHERE`에 인덱스를 걸어 놓고도 함수로 감싸거나 형변환이 끼어 인덱스가 죽는 경우, EXPLAIN의 `type=ALL`(풀 스캔)이 그걸 일러바친다.

> 더 깊이: [DB 인덱스 ①: 인덱스 기초와 EXPLAIN 읽기](/blog/theory/db-index-01-explain-basics) - 실제 MySQL/PostgreSQL의 EXPLAIN을 어떻게 읽는지, `type`·`rows`·`key`가 뭘 말하는지. 그리고 [② 스캔의 종류와 옵티마이저의 선택](/blog/theory/db-index-02-scan-types) - 같은 쿼리라도 데이터 분포에 따라 인덱스와 풀 스캔 중 무엇이 빠른지를 옵티마이저가 어떻게 저울질하는지.

## minidb가 안 한 것: 비용 기반과 EXPLAIN ANALYZE

minidb의 플래너는 **규칙 기반(rule-based)** 이다.
"PK 등식이면 무조건 인덱스", "조인 키가 PK면 무조건 인덱스 NLJ" 같은 if 문 몇 개로 정해진다.
진짜 DB는 여기서 한참 더 간다 - **비용 기반(cost-based)** 이다.
테이블에 행이 몇 개고 값 분포가 어떤지(통계)를 들고, 인덱스를 타는 비용과 풀 스캔 비용을 숫자로 계산해 더 싼 쪽을 고른다.
그래서 "이 조건이면 전체의 90%가 걸리니 인덱스로 한 줄씩 찾느니 그냥 다 읽는 게 싸다"는 판단도 한다 - 규칙 기반인 minidb는 못 하는 일이다.

또 하나, 진짜 DB의 `EXPLAIN ANALYZE`는 플랜을 **실제로 실행해** 예상 행 수와 실측 행 수, 실측 시간까지 나란히 보여준다.
"옵티마이저는 100행을 예상했는데 실제론 100만 행이었다" 같은 통계 오차를 잡는 핵심 도구다.
minidb의 EXPLAIN은 실행을 안 하는 쪽(추정만)이라 거기까진 못 간다.
하지만 minidb는 애초에 통계도, 비용 모델도 없으니 - 규칙 기반 플래너엔 규칙을 그대로 보여주는 EXPLAIN이 딱 맞는 짝이었다.

## 닫으며

EXPLAIN은 새 기능이라기보다 **이미 만든 것을 보이게 하는 창**이었다.
3편·5편에서 내린 결정들은 줄곧 거기 있었지만, 실행 코드 안에 묻혀 눈에 안 띄었을 뿐이다.
그 결정 지점 옆에 출력 한 줄을 끼우니, 플래너가 매 쿼리마다 무슨 생각을 하는지가 트리로 드러났다.
그리고 그 트리는 자랑이 아니라 고백이었다 - "나는 ORDER BY가 붙으면 인덱스를 못 써요"라고.
만든 걸 재보는 게 [7편](/blog/project/minidb/minidb-7-benchmark)이었다면, 만든 걸 들여다보는 건 이 EXPLAIN이다.

> **시리즈**: [1. 저장 계층](/blog/project/minidb/minidb-1-storage) · [2. SQL 엔진](/blog/project/minidb/minidb-2-sql-engine) · [3. 인덱스와 WAL](/blog/project/minidb/minidb-3-index-wal) · [4. 트랜잭션](/blog/project/minidb/minidb-4-transactions) · [5. 조인과 집계](/blog/project/minidb/minidb-5-join-aggregate) · [6. BETWEEN과 LIKE](/blog/project/minidb/minidb-6-between-like) · [7. 직접 재보기](/blog/project/minidb/minidb-7-benchmark) · 8. EXPLAIN · [코드(GitHub)](https://github.com/dj258255/minidb)

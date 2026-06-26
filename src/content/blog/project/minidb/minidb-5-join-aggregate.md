---
title: '조인은 어떻게 동작하는가 — 두 테이블을 잇고 행을 접기까지'
titleEn: 'How Do Joins Work? — From Joining Two Tables to Folding Rows'
description: "관계형 DB를 C로 밑바닥부터 만든 minidb 시리즈 마지막 편. 한 테이블을 넘어 테이블 여러 개를 둔다. PostgreSQL의 relfilenode처럼 테이블마다 파일을 따로 두고 카탈로그로 묶은 뒤, 재귀적 N-way 중첩 루프 조인을 짠다. 그리고 별칭·self-join, 집계(COUNT/SUM/MIN/MAX/AVG)·GROUP BY, 레벨마다 인덱스/해시/중첩 루프를 고르는 조인 알고리즘 선택, LEFT JOIN과 NULL, 서브쿼리까지 — 진짜 옵티마이저가 하는 일을 코드로 드러낸다."
descriptionEn: "The final part of building a relational database from scratch in C. Going beyond a single table: each table is its own files (like PostgreSQL's relfilenode) tied by a catalog, with a recursive N-way nested-loop join. Plus aliases/self-joins, aggregates (COUNT/SUM/MIN/MAX/AVG) with GROUP BY, per-level join-method selection (index / hash / nested-loop), LEFT JOIN and NULL, and subqueries — the work a real optimizer does, made visible in code."
date: 2026-05-24
tags:
  - C
  - Database Internals
  - JOIN
  - Query Planner
  - Hash Join
  - SQL
  - Learning
category: project/minidb
coverImage: /uploads/project/minidb/cover.svg
draft: false
series: "minidb"
seriesOrder: 5
---

## 0. 들어가며 — 한 테이블에서 여러 테이블로

[4편](/blog/project/minidb/minidb-4-transactions)까지로 "한 테이블짜리 DB"가 완성됐어요 — 저장·SQL·인덱스·내구성·트랜잭션. 페이지에 행을 얹고, SQL을 받고, 빠르게 찾고, 전원이 꺼져도 안 깨지고, 묶음 작업을 원자적으로 처리하는 데까지 왔습니다. 그런데 진짜 DB는 테이블 하나로 안 끝나죠 — `users`와 `orders`를 **잇고**, 그 결과를 부서별로 **접어** 집계합니다.

이번 마지막 편은 테이블을 여러 개 두고 잇습니다. 그러려면 저장 구조부터 손봐야 했어요. 다 만들고 나면 `SELECT users.name, COUNT(*) FROM users JOIN orders ON users.id = orders.uid GROUP BY users.name` 같은 진짜 분석 쿼리가 도는 걸 볼 수 있습니다.

> **이번 편의 목표**: 다중 테이블(relfilenode식) -> N-way 중첩 루프 조인 -> 조인 알고리즘 선택(인덱스/해시/스캔) -> 집계와 GROUP BY -> LEFT JOIN과 NULL -> 서브쿼리. 진짜 옵티마이저가 매 쿼리에 하는 "어떻게 조인하고 어떻게 접을까"라는 결정을, C로 한 단계씩 드러냅니다.

## 1. 다중 테이블 — relfilenode를 그대로 따라하기

진짜 DB처럼 테이블 여러 개를 두고 조인하려면 저장 구조부터 바꿔야 했어요. **PostgreSQL이 릴레이션마다 디스크 파일을 따로 두는 방식(relfilenode)** 을 그대로 따랐습니다. 어떤 테이블이 있는지는 카탈로그 파일이 들고(`pg_class` 격), 각 테이블의 행과 인덱스는 테이블별 파일에 살아요.

```
mydb              카탈로그 — 테이블 목록 + 스키마
mydb.users.tbl    users 행 (Heap)
mydb.users.idx    users PK 인덱스 (B+Tree)
mydb.orders.tbl   orders 행
mydb.orders.idx   orders PK 인덱스
```

이 결정이 왜 중요하냐면, 테이블이 파일별로 나뉘니 **앞서 만든 힙·B+Tree 코드를 한 줄도 안 고치고 테이블 수만큼 복제하면 됐다**는 거예요. [1편의 힙](/blog/project/minidb/minidb-1-storage)과 [3편의 B+Tree](/blog/project/minidb/minidb-3-index-wal)가 "테이블 하나"를 다루는 코드였는데, 그게 그대로 N개로 늘어납니다. 트랜잭션만 모든 테이블에 걸쳐 작동하도록 넓혔어요.

> **왜 테이블 = 파일인가**: 릴레이션마다 파일을 따로 두면 한 테이블의 저장 로직이 다른 테이블과 완전히 격리된다. 그래서 "한 테이블짜리 힙 코드"를 그대로 N벌 복제하는 게 가능하다 — 이게 PostgreSQL relfilenode 방식의 학습적 이점이다. InnoDB도 `innodb_file_per_table` 옵션으로 같은 구조를 택할 수 있다(끄면 한 공유 테이블스페이스에 다 몰아넣는다).

## 2. 중첩 루프 조인 — 조인은 결국 이중 루프

조인은 가장 기본인 **중첩 루프 조인(nested-loop join)** 으로 구현했어요. 바깥 테이블을 한 행씩 훑으면서, 그 한 행마다 안쪽 테이블을 전부 스캔해 `ON` 조건이 맞는 짝을 찾아 두 행을 이어 붙입니다. 컬럼은 `users.id` 처럼 테이블로 한정할 수 있고, `WHERE` 는 양쪽 테이블 어느 컬럼으로도 걸어요.

```
SELECT * FROM users JOIN orders ON users.id = orders.uid WHERE users.name = 'kim'
users.id | users.name | orders.oid | orders.uid | orders.item
1 | kim | 10 | 1 | book
1 | kim | 11 | 1 | pen
(2행)
```

옵티마이저가 인덱스나 해시를 못 쓸 때 실제로 떨어지는 게 이 중첩 루프 조인이에요. O(바깥 x 안쪽)이라 느리지만, **"조인이 결국 두 스캔의 이중 루프"** 라는 본질이 코드에 그대로 드러납니다.

> **핵심 사실**: 모든 조인 알고리즘의 출발점은 중첩 루프다. 한쪽을 고정하고 다른 쪽을 다 뒤지는 이중 루프가 "맞는 짝을 찾는다"의 가장 솔직한 표현이고, 인덱스·해시·정렬병합은 전부 이 안쪽 루프를 더 빠르게 만드는 변형일 뿐이다.

### 인덱스 중첩 루프 조인 — 안쪽 루프를 점 조회로

여기서 한 걸음 더 갔어요. 안쪽 테이블의 **PK가 마침 `ON` 컬럼이면**, 안쪽을 전부 훑을 필요가 없습니다. 바깥 행의 키로 [3편에서 만든 B+Tree](/blog/project/minidb/minidb-3-index-wal)를 점 조회하면 끝 — O(바깥 x 안쪽)이 O(바깥 x log 안쪽)으로 줄어들어요. 이게 옵티마이저가 인덱스가 있을 때 고르는 **인덱스 중첩 루프 조인(index nested-loop join)** 입니다.

minidb는 조인 시 안쪽 PK가 조인 키인지 보고, 맞으면 전체 스캔 대신 `btree_search` 로 바꿉니다(`(N행, 인덱스 조인)` 으로 표시).

```c
if (level >= 1 && m->method[level] == JM_INDEX) {
    /* 인덱스 NLJ: 앞 테이블의 키로 Tk의 PK 인덱스를 점 조회 */
    const Value *k = &m->rows[m->key_t[level]][m->key_i[level]];
    if (k->type == VAL_INT) {
        bval_t encoded;
        if (btree_search(&m->tabs[level]->index, k->int_val, &encoded) == 0) {
            /* 안쪽 전체 스캔 대신 RID 하나를 바로 끌어온다 */
        }
    }
}
```

### N-way 조인 — 재귀적인 다단 중첩 루프

조인은 둘로 끝나지 않아요. `a JOIN b JOIN c ...` 처럼 여러 테이블을 잇는 건 **재귀적인 N단 중첩 루프**입니다. 테이블 체인을 레벨별로 내려가며, 레벨 k에서 그 테이블을 스캔하고 k번째 `ON` 이 맞으면 다음 레벨로, 가장 깊은 곳에서 모든 행이 묶이면 `WHERE` 를 걸고 출력해요.

핵심은 **2단 조인이 이 일반형의 특수한 경우(N=2)일 뿐이라, 코드 하나로 둘 다 처리된다**는 거예요. `mjoin_descend(level)`가 레벨 k의 테이블을 처리하고 `mjoin_descend(level+1)`을 재귀 호출하면, 가장 깊은 레벨(`level == ntabs`)에서 결합 행이 완성됩니다. 그 위에 `ORDER BY` 를 얹으면(결합 행을 모아 정렬) 조인 결과도 정렬·`LIMIT` 할 수 있어요.

```
SELECT * FROM users JOIN orders ON users.id = orders.uid
                    JOIN products ON orders.oid = products.pid
users.id | users.name | orders.oid | orders.uid | orders.item | products.pid | products.pname
1 | kim | 10 | 1 | book | 10 | A
1 | kim | 11 | 1 | pen | 11 | B
(2행, 인덱스 조인)
```

> **재귀가 N-way를 공짜로 푸는 이유**: 조인 체인을 "레벨"로 보면, 각 레벨은 "그 테이블을 스캔하고, 짝이 맞으면 다음 레벨로 내려간다"는 똑같은 일을 한다. 그러니 2단이든 5단이든 함수 하나가 자신을 깊이 N까지 재귀 호출하면 끝이다 — [2편의 재귀 하강 파서](/blog/project/minidb/minidb-2-sql-engine)에서 문법 규칙이 함수로 떨어졌던 것과 같은, "재귀적 구조엔 재귀 함수"라는 발상이다.

## 3. 더 진짜 SQL처럼 ① — 별칭과 self-join

조인을 만들고 나니 욕심이 났어요. 진짜 SQL에 가까워지려면 세 가지가 더 필요했습니다. 첫째가 **테이블 별칭과 self-join** 이에요.

`FROM emp e JOIN emp m ON e.mgr = m.id` — 같은 테이블을 두 번 걸어 직원과 그 상사를 잇습니다. 비결은 "이름 해소"를 테이블명이 아니라 **실효 이름(별칭이 있으면 별칭)** 으로 바꾸는 것이에요.

```c
/* 실효 이름(tname)은 별칭이 있으면 별칭 — self-join은 별칭으로 두 인스턴스를 구별한다. */
m.tname[0] = sel->alias[0] ? sel->alias : m.tabs[0]->schema.table;
```

그러면 `e` 와 `m` 이 같은 `emp` 의 다른 인스턴스로 구별돼, self-join이 공짜로 열려요. 컬럼을 `e.mgr` 로 적었을 때 "테이블 `emp` 의 mgr"이 아니라 "실효 이름 `e` 의 mgr"로 찾으니, 같은 물리 테이블을 가리키는 두 별칭이 서로 안 헷갈립니다.

## 4. 더 진짜 SQL처럼 ② — 집계와 GROUP BY

`WHERE` 가 행을 거르고 조인이 행을 잇는다면, `GROUP BY` 와 집계 함수는 여러 행을 **하나로 접습니다**. 여기서 처음으로 "행 하나가 행 하나로" 대응되지 않는 연산이 등장해요.

한 그룹의 `COUNT`는 그 그룹 전체를 봐야 나오죠. 그래서 minidb는 행을 모아 그룹 키로 정렬한 뒤, 같은 키의 연속 구간마다 누산기를 돌립니다 — **PostgreSQL의 정렬 기반 `GroupAggregate` 와 같은 방식**이에요. (입력이 이미 그룹 키로 정렬돼 들어오면 한 그룹이 끝날 때마다 바로 흘려보낼 수도 있어요 — PG의 스트리밍 GroupAggregate가 그렇습니다 — 다만 minidb는 단순하게 전부 모아 정렬하는 길을 택했어요.)

```
SELECT dept, COUNT(*), SUM(amt), AVG(amt) FROM sales GROUP BY dept
dept | COUNT(*) | SUM(amt) | AVG(amt)
eng | 2 | 300 | 150
sales | 3 | 500 | 166.667
```

> **minidb 집계가 모아서 처리하는 이유**: `WHERE`나 단순 `SELECT`는 행 하나를 보고 즉시 통과/탈락을 정할 수 있어 한 행씩 흘려보내면 된다(스트리밍). 하지만 `COUNT(*)`는 그룹의 마지막 행까지 다 세야 값이 나온다 — 입력이 그룹 키로 정렬돼 있지 않으면 행을 일단 다 모아 정렬하는 materialize 경로가 필요하다. 실제 PostgreSQL은 입력이 이미 정렬됐으면 스트리밍하는 GroupAggregate, 아니면 HashAggregate도 쓰는데, minidb는 단순한 "모아서 정렬 기반" 하나만 골랐다.

### HAVING과 집계 결과 정렬

여기에 `HAVING` 과 집계 결과 정렬을 더했어요. `HAVING` 은 `WHERE` 의 집계판입니다 — `WHERE` 가 행을 거른다면 `HAVING` 은 집계가 끝난 *그룹* 을 거릅니다(`HAVING COUNT(*) > 2`).

| | `WHERE` | `HAVING` |
|---|---|---|
| 거르는 대상 | 개별 행 | 집계가 끝난 그룹 |
| 적용 시점 | 그룹핑·집계 **전** | 그룹핑·집계 **후** |
| 쓸 수 있는 것 | 컬럼 값 | 집계값(`COUNT(*)`, `SUM(amt)`) |
| 예 | `WHERE amt > 100` | `HAVING SUM(amt) > 250` |

그리고 그룹마다 접힌 출력 행을 따로 모아 정렬하면 집계값 기준 정렬이 되는데, `ORDER BY 2`(출력 컬럼 위치)를 받게 해 `ORDER BY 2 DESC LIMIT 3` 같은 **상위 N 분석** 까지 됩니다("매출 합 상위 3개 부서").

```
SELECT dept, SUM(amt) FROM sales GROUP BY dept HAVING SUM(amt) > 250 ORDER BY 2 DESC
dept | SUM(amt)
sales | 500
eng | 300
```

### 조인과 집계가 한 함수에서 만나다

가장 좋았던 깨달음은 여기예요. 처음엔 집계가 단일 테이블만 됐는데, **조인이 이미 만들어내는 *결합 행* 이 곧 집계의 입력**이라는 걸 깨닫고 나니 둘은 한 함수로 만났습니다 — "행을 모아 그룹·집계"하는 코드는 입력이 한 테이블의 행이든 조인된 결합 행이든 똑같으니까요.

```c
/* 조인이 만든 결합 행이 곧 집계의 입력 — 두 실행기가 한 함수로 만난다. */
if (!sel->select_star) {
    /* ... 결합 행을 전부 matbuf에 모은 뒤 ... */
    int rc = aggregate_rowset(sel, matbuf, m.matcount, comb, cols, out);
}
```

컬럼 해소만 "테이블명에서 (실효 테이블, 이름) 목록"으로 일반화하면, 조인한 데이터를 그룹별로 집계하는 진짜 분석 쿼리가 열려요.

```
SELECT users.name, COUNT(*), SUM(orders.oid)
  FROM users JOIN orders ON users.id = orders.uid
  GROUP BY users.name ORDER BY 2 DESC
users.name | COUNT(*) | SUM(orders.oid)
kim | 2 | 21
lee | 1 | 12
```

## 5. 조인 알고리즘 선택 — 옵티마이저의 핵심 결정

지금까지 조인은 중첩 루프(+안쪽 PK면 인덱스 점 조회)였어요. 여기에 **해시 조인** 을 더했습니다. 안쪽 테이블을 한 번 훑어 **조인 키 -> 행 목록** 해시를 만들어 두고(build), 바깥 테이블을 한 번 훑으며 그 해시를 조회만 하면(probe) 짝이 나와요. 각 테이블을 한 번씩만 보니 O(바깥 x 안쪽)이 O(바깥 + 안쪽)으로 줄어듭니다 — 인덱스가 없어도요.

그래서 minidb는 조인 레벨마다 **셋 중 하나를 고릅니다**: 안쪽 PK가 조인 키면 인덱스 NLJ, 그 밖의 등식 조인이면 해시 조인, 아니면 중첩 루프.

```c
m.method[k] = JM_SCAN;
if (kcol >= 0) {
    if (kcol == 0 && m.tabs[k]->has_index) {
        m.method[k] = JM_INDEX; /* Tk의 PK가 조인 키 -> 점 조회 */
    } else {
        m.method[k] = JM_HASH;  /* 그 외 -> Tk를 조인 컬럼으로 해시 빌드 */
    }
}
```

한 쿼리 안에서 레벨마다 다른 방법이 섞이는 게(`(N행, 인덱스+해시 조인)`) 곧 옵티마이저가 조인 계획을 짜는 일이에요.

### 세 알고리즘 비교

사실 교과서 조인 알고리즘은 셋인데, 나는 둘(중첩 루프·해시)만 만들고 **정렬 병합 조인(sort-merge join)** 은 안 만들었어요. 셋을 비교하면 이렇습니다.

| | 중첩 루프 (NLJ) | 해시 조인 | 정렬 병합 조인 |
|---|---|---|---|
| 시간 복잡도 | O(바깥 x 안쪽) (인덱스면 O(바깥 x log)) | O(바깥 + 안쪽) | O(정렬 비용 + 바깥 + 안쪽) |
| 사전 준비 | 없음 (인덱스 NLJ는 인덱스) | 안쪽을 해시 테이블로 빌드 | 양쪽을 조인 키로 정렬 |
| 조인 조건 | 등식·비등식 다 됨 | **등식만** | 등식·범위 |
| 메모리 | 적음 | 해시가 메모리에 들어가야 | 정렬 버퍼 |
| 빛나는 곳 | 한쪽이 작고 안쪽에 인덱스(OLTP) | 양쪽 크고 정렬 안 됨(OLAP) | 양쪽 이미 정렬됐거나 너무 커서 해시 불가 |
| minidb | O (스캔/인덱스) | O | X (안 만듦) |

정렬 병합은 양쪽을 조인 키로 정렬해 두고 지퍼 잠그듯 나란히 훑는 방식인데, 정렬된 입력에선 해시보다 메모리를 덜 쓰고 등식뿐 아니라 범위 조인까지 처리할 수 있어 대용량 데이터 웨어하우스에서 자주 쓰여요. 특히 양쪽이 이미 정렬돼 나오거나(인덱스 스캔 결과 등) 둘 다 해시가 메모리에 안 들어갈 만큼 거대할 때 빛납니다. 안 만든 건 게을러서가 아니라, 정렬 인프라가 더 필요하고 우리 규모에선 보여줄 게 적어서예요.

### 진짜 옵티마이저는 비용 모델로 고른다

실제 PostgreSQL 옵티마이저는 이 셋을 두고 **비용 모델**로 골라요 — 양쪽 크기 추정치, 어느 쪽이 이미 정렬돼 있는지, 해시가 `work_mem`에 들어가는지, 순차 I/O vs 무작위 I/O vs CPU 비용을 한꺼번에 저울질합니다. 대략의 직관은 이래요:

- 한쪽이 아주 작고 안쪽에 인덱스가 있으면 **중첩 루프** (OLTP의 기본)
- 양쪽이 크고 정렬 안 됐으면 **해시** (OLAP에서 흔함)
- 양쪽이 이미 정렬됐거나 너무 커서 해시도 안 들어가면 **정렬 병합**

minidb의 "레벨마다 인덱스/해시/스캔 중 하나"는 이 비용 모델의 아주 거친 버전인 셈이에요. 그리고 진짜 옵티마이저가 조인 방법보다 먼저 고민하는 게 **조인 순서(join order)** 예요 — `A JOIN B JOIN C`라도 `(A JOIN B) JOIN C`가 아니라 `(B JOIN C) JOIN A`가 훨씬 빠를 수 있어서, PostgreSQL은 가능한 순서들을 비용으로 비교합니다. minidb는 그냥 **FROM 절에 적힌 순서를 그대로** 써요.

> **실무/면접 포인트**: 이 "조인 방법 선택"이 실무에서 얼마나 중요한지는, 같은 조인을 어떻게 거느냐로 응답이 수천 배 갈리는 사례에서 드러난다. 옵티마이저가 잘못된 조인 방법이나 순서를 고르면(예: 큰 테이블을 바깥으로) 같은 쿼리가 수십 배 느려진다 — 그래서 `EXPLAIN`으로 실제 선택을 확인하는 게 튜닝의 첫걸음이다.

> 더 깊이, 조인·페이지네이션 최적화 실전: [Deferred Join 적용기 — 기대한 40배 vs 현실 13%](/blog/project/WikiEngine/deferred-join-optimization)(거대 OFFSET 페이지네이션에서 조인을 늦춰 읽는 트릭과 EXPLAIN 분석) · [COUNT(*) 제거와 페이지 제한으로 19,424ms -> 8ms](/blog/project/WikiEngine/query-refactoring-optimization)(1,425만 행에서 COUNT 제거·Deferred Join으로 19초를 8ms로). 스캔 종류와 옵티마이저의 선택은 [DB 인덱스 ②](/blog/theory/db-index-02-scan-types)에서.

## 6. LEFT JOIN과 NULL의 등장

지금까지 조인은 전부 INNER였어요 — 양쪽이 맞는 쌍만 내보냅니다. 하지만 "주문이 하나도 없는 사용자까지" 보려면 **LEFT JOIN** 이 필요해요. 왼쪽(바깥) 행은 매칭이 없어도 살리고, 오른쪽 컬럼을 **NULL** 로 채웁니다.

여기서 minidb에 처음으로 NULL이 들어왔어요. 중요한 건 **NULL이 저장 행엔 절대 안 생긴다**는 점입니다(`INSERT` 는 값을 다 받아요). NULL은 오직 결과에만, 그것도 LEFT JOIN의 미매칭 오른쪽 같은 자리에만 transient하게 등장해요. 그래서 변경 범위가 값 모델·비교·집계로 좁게 묶였습니다.

재귀 조인에는 딱 한 가지만 더했어요 — **"이번 바깥 행이 매칭됐나"는 플래그**. 레벨 k의 후보를 다 돌렸는데 매칭이 0이고 그 조인이 LEFT면, 그 테이블 컬럼을 NULL로 채워 한 번 내려보냅니다.

```c
/* LEFT JOIN인데 이번 외부행에 매칭이 하나도 없었다 -> 오른쪽을 NULL로 채워 보존 */
if (is_left && !m->matched[level]) {
    mjoin_null_fill(m, level);
    return mjoin_descend(m, level + 1);
}
```

인덱스로 찾든 해시로 찾든 스캔으로 찾든 "매칭 0이면 NULL 채움"은 똑같아서, **조인 알고리즘 선택과 깔끔하게 직교**해요. 5절에서 셋 중 하나를 고른 게 여기 NULL 채움 로직과 서로 안 얽힙니다.

```
SELECT users.name, COUNT(*), COUNT(orders.oid)
  FROM users LEFT JOIN orders ON users.id = orders.uid
  GROUP BY users.name
users.name | COUNT(*) | COUNT(orders.oid)
kim | 2 | 2
lee | 1 | 1
park | 1 | 0
```

`park` 은 주문이 없어 NULL 한 줄로 보존됐는데, `COUNT(*)` 는 그 행을 세서 1, `COUNT(orders.oid)` 는 NULL을 건너뛰어 0이에요. 이 둘의 차이가 곧 NULL의 의미론입니다.

> **NULL의 의미론 (면접 단골)**: `COUNT(*)` 는 행을 세고, `COUNT(컬럼)` 은 NULL 아닌 값을 센다. `SUM`·`AVG`·`MIN`·`MAX` 도 NULL을 무시하고, NULL은 무엇과도(심지어 NULL과도) 같지 않다 — `WHERE` 에서 NULL 비교는 거짓이다. 이게 SQL의 3값 논리(TRUE/FALSE/UNKNOWN)의 핵심이다.

### IS NULL과 공짜로 열리는 anti-join

NULL은 `=` 로 못 잡아요(`NULL = NULL` 도 거짓이니까). 그래서 NULL을 검사하려면 별도 연산자가 필요합니다 — `IS NULL` / `IS NOT NULL`. 이게 생기니 **anti-join** 이 공짜로 열려요.

```
SELECT users.name FROM users LEFT JOIN orders ON users.id = orders.uid
  WHERE orders.oid IS NULL
users.name
park
```

LEFT JOIN으로 미매칭을 NULL로 만들고, `IS NULL` 로 그 NULL을 잡으면 "주문이 하나도 없는 사용자"가 나옵니다. **차집합이 두 기능(LEFT JOIN + IS NULL)의 결합으로 자연히 떨어져요.**

끝으로 `SELECT DISTINCT` 도 더했는데, 구현은 "모든 출력 컬럼으로 GROUP BY 한 것"과 같아요 — 출력 행을 전체 컬럼으로 정렬한 뒤 인접한 중복을 지우면 끝입니다. 4절의 정렬 기반 집계 인프라가 그대로 재활용돼요.

```
SELECT DISTINCT dept FROM sales
dept
eng
sales
```

## 7. 더 진짜 SQL처럼 ③ — 쿼리 안의 쿼리, 서브쿼리

마지막으로 `WHERE col IN (SELECT ...)` — **서브쿼리** 를 얹었어요. 여기서 AST가 처음으로 재귀가 됩니다. WHERE 조건의 오른쪽이 값이 아니라 또 다른 `SELECT` 라서, `Condition` 이 `SelectStmt` 를 품고(자기참조라 전방 선언 + 포인터 + malloc) [2편의 파서](/blog/project/minidb/minidb-2-sql-engine)가 자신을 다시 부릅니다.

핵심은 **상관 없는(uncorrelated) 서브쿼리는 한 번만 돈다**는 거예요. `IN (SELECT uid FROM orders)` 의 안쪽은 바깥 행과 무관하니, 바깥을 스캔하기 전에 안쪽을 한 번 돌려 값 집합을 만들어두고(prepare 단계), 바깥은 그 집합에 멤버십만 검사합니다.

| | 미리 캐시 (minidb) | 행마다 재실행 (순진한 구현) |
|---|---|---|
| 안쪽 실행 횟수 | 1번 (prepare) | 바깥 행 수만큼 |
| 복잡도 | O(행) | O(행 x 서브쿼리) |
| 전제 | uncorrelated(안쪽이 바깥과 무관) | correlated여도 동작 |

행마다 다시 돌리면 O(행 x 서브쿼리)지만, 미리 캐시하면 O(행)이에요.

```
SELECT * FROM users WHERE id IN (SELECT uid FROM orders)
id | name
1 | kim
2 | lee
```

`orders` 에 주문을 낸 사용자(uid 1,2)만 나옵니다. 안쪽 결과를 집합으로 만들고 바깥이 그걸 조회하는 게, 곧 서브쿼리의 가장 단순한 실행 모델이에요. 멤버십을 뒤집은 `NOT IN`, 그리고 한 값과 비교하는 **스칼라 서브쿼리** (`WHERE v > (SELECT v FROM t WHERE id = 2)`)도 같이 붙였어요 — IN이 "집합에 있나"라면 스칼라는 "그 한 값과 비교"라, 같은 prepare 인프라를 쓰고 비교 방식만 다릅니다.

### 마무리 — 다중 키 ORDER BY와 OFFSET

마지막 마무리로 **다중 컬럼 `ORDER BY`** (`ORDER BY dept, amt DESC`)와 **`OFFSET`** (`LIMIT 2 OFFSET 1` — 페이지네이션)도 넣었어요. 정렬 비교기를 단일 키에서 키 목록으로 일반화하니, 키마다 ASC/DESC를 적용하게 됐고 — 덤으로 "오름차순 정렬 후 통째로 뒤집기" 같던 옛 DESC 처리 꼼수도 사라졌습니다. 비교기가 키를 차례로 훑다 차이가 나는 첫 키에서 방향을 적용해 결과를 내요.

> 더 깊이: 집계(`SUM`/`COUNT`)는 "여러 행을 한 컬럼으로 접는" OLAP 성향이 강한데, 그래서 분석용 DB는 행이 아니라 컬럼으로 저장한다 — [DB 스토리지 내부 ②: Row Store vs Column Store](/blog/theory/db-storage-02-row-vs-column). 우리가 만든 정렬 기반 집계(GroupAggregate)와 옵티마이저의 스캔 선택은 [DB 인덱스 ②](/blog/theory/db-index-02-scan-types)에서.

## 8. 정리

이번 편은 "한 테이블에서 여러 테이블로" 가는 길이었어요. 핵심 설계 선택을 정리하면:

- **다중 테이블** — PostgreSQL relfilenode식으로 테이블 = 파일. 그래서 한 테이블짜리 힙·B+Tree 코드를 그대로 N벌 복제했다.
- **중첩 루프 조인** — 조인은 결국 이중 루프. 안쪽 PK가 조인 키면 인덱스 점 조회(O(바깥 x log)), N-way는 재귀로 공짜로 풀린다.
- **조인 알고리즘 선택** — 레벨마다 인덱스/해시/스캔 중 하나. 진짜 옵티마이저가 비용 모델로 하는 일의 거친 버전이다(정렬 병합은 안 만듦).
- **집계와 GROUP BY** — 행을 모아 정렬 후 누산(PostgreSQL GroupAggregate). 조인의 결합 행이 곧 집계의 입력이라 두 실행기가 한 함수에서 만난다. `HAVING`은 집계의 `WHERE`.
- **LEFT JOIN과 NULL** — "매칭 0이면 NULL 채움" 플래그 하나. 조인 알고리즘 선택과 직교. `IS NULL`이 생기니 anti-join이 공짜.
- **서브쿼리** — AST의 첫 재귀. uncorrelated는 한 번만 돌려 캐시(O(행)).

새로운 걸 발명하진 않았어요. 대신 PostgreSQL·MySQL이 매일 하는 일 — 글자를 받아 페이지를 읽고 행을 돌려주는 그 일 — 을 밑바닥부터 한 겹씩 직접 만들며 이해했습니다. 페이지에 저장하고(페이저·슬롯 페이지), 메모리에 캐시하고(버퍼 풀), 테이블로 묶고(힙), SQL을 받고(파서·실행기), 빠르게 찾고(B+Tree), 전원이 꺼져도 안 깨지고(WAL), 묶음 작업을 원자적으로 처리하고(트랜잭션), 테이블을 여러 개 두고 조인하고(다중 테이블·INNER/LEFT 조인), 행을 접어 집계합니다(GROUP BY·HAVING). 조인은 인덱스·해시·중첩 루프 중에서 골라 가며, 매칭 없는 행은 NULL로 채워 가며.

이제 `SELECT` 를 칠 때마다 그 아래 계층들에서 무슨 일이 벌어지는지 알아요. 그게 이 프로젝트의 전부였습니다.

## 참고

- [PostgreSQL Documentation: Physical Storage (relfilenode)](https://www.postgresql.org/docs/current/storage.html)
- [PostgreSQL Documentation: Planner / Optimizer (join methods)](https://www.postgresql.org/docs/current/planner-optimizer.html)
- [PostgreSQL Documentation: Controlling the Planner (work_mem, join cost)](https://www.postgresql.org/docs/current/runtime-config-resource.html)
- 본 블로그: [DB 인덱스 ②: 스캔 종류와 옵티마이저](/blog/theory/db-index-02-scan-types) · [DB 스토리지 내부 ②: Row Store vs Column Store](/blog/theory/db-storage-02-row-vs-column)
- 실전 최적화: [Deferred Join 적용기](/blog/project/WikiEngine/deferred-join-optimization) · [COUNT(*) 제거와 페이지 제한](/blog/project/WikiEngine/query-refactoring-optimization)
- minidb 시리즈: [1편 저장 계층](/blog/project/minidb/minidb-1-storage) · [2편 SQL 엔진](/blog/project/minidb/minidb-2-sql-engine) · [3편 인덱스·WAL](/blog/project/minidb/minidb-3-index-wal) · [4편 트랜잭션](/blog/project/minidb/minidb-4-transactions)
- [minidb 코드 (GitHub)](https://github.com/dj258255/minidb)

> **시리즈**: [1. 저장 계층](/blog/project/minidb/minidb-1-storage) · [2. SQL 엔진](/blog/project/minidb/minidb-2-sql-engine) · [3. 인덱스와 WAL](/blog/project/minidb/minidb-3-index-wal) · [4. 트랜잭션](/blog/project/minidb/minidb-4-transactions) · 5. 조인과 집계 · [코드(GitHub)](https://github.com/dj258255/minidb)

<!-- EN -->

## 0. Introduction — From One Table to Many

Through [Part 4](/blog/project/minidb/minidb-4-transactions) the "single-table DB" was complete — storage, SQL, indexes, durability, transactions. We got to laying rows onto pages, taking SQL, finding fast, surviving a power loss, and handling batched work atomically. But a real DB does not stop at one table — it **joins** `users` and `orders`, then **folds** the result per department to aggregate.

This final part puts down multiple tables and joins them. That meant reworking the storage layout first. Once done, you get to watch a real analytical query run, like `SELECT users.name, COUNT(*) FROM users JOIN orders ON users.id = orders.uid GROUP BY users.name`.

> **Goal of this part**: multiple tables (relfilenode-style) -> N-way nested-loop join -> join-method selection (index/hash/scan) -> aggregation and GROUP BY -> LEFT JOIN and NULL -> subqueries. The "how to join and how to fold" decision a real optimizer makes on every query, revealed step by step in C.

## 1. Multiple Tables — Copying relfilenode Verbatim

To put down several tables and join them like a real DB, the storage layout had to change first. We followed **PostgreSQL's way of giving each relation its own disk files (relfilenode)** verbatim. A catalog file holds which tables exist (the `pg_class` equivalent), and each table's rows and index live in per-table files.

```
mydb              catalog — table list + schema
mydb.users.tbl    users rows (Heap)
mydb.users.idx    users PK index (B+Tree)
mydb.orders.tbl   orders rows
mydb.orders.idx   orders PK index
```

Why this decision matters: because tables are split per file, **the heap and B+Tree code built earlier could be replicated per table without changing a single line**. [Part 1's heap](/blog/project/minidb/minidb-1-storage) and [Part 3's B+Tree](/blog/project/minidb/minidb-3-index-wal) were code for "one table", and it scales straight to N. Only the transactions were broadened to work across all tables.

> **Why table = file**: giving each relation its own file isolates one table's storage logic completely from the others. That is what makes it possible to replicate the "single-table heap code" N times as-is — the learning benefit of the PostgreSQL relfilenode approach. InnoDB can pick the same structure via `innodb_file_per_table` (turn it off and everything lands in one shared tablespace).

## 2. Nested-Loop Join — A Join Is Just a Double Loop

We implemented joins with the most basic **nested-loop join**. Scanning the outer table row by row, for each row we scan the entire inner table to find pairs matching the `ON` condition, and stitch the two rows together. Columns can be qualified by table like `users.id`, and `WHERE` can target any column of either table.

```
SELECT * FROM users JOIN orders ON users.id = orders.uid WHERE users.name = 'kim'
users.id | users.name | orders.oid | orders.uid | orders.item
1 | kim | 10 | 1 | book
1 | kim | 11 | 1 | pen
(2 rows)
```

This nested-loop join is what actually drops out when the optimizer cannot use an index or hash. It is slow at O(outer x inner), but the essence — **"a join is ultimately a double loop over two scans"** — shows directly in the code.

> **Key fact**: every join algorithm starts from the nested loop. Fixing one side and combing the other is the most honest expression of "find the matching pair", and index, hash, and sort-merge are all just variants that make this inner loop faster.

### Index Nested-Loop Join — Inner Loop as a Point Lookup

We went one step further. If the inner table's **PK happens to be the `ON` column**, there is no need to scan the inner table whole. Point-look up [the B+Tree from Part 3](/blog/project/minidb/minidb-3-index-wal) with the outer row's key and you are done — O(outer x inner) shrinks to O(outer x log inner). This is the **index nested-loop join** the optimizer picks when an index exists.

On a join, minidb checks whether the inner PK is the join key, and if so swaps the full scan for `btree_search` (shown as `(N rows, index join)`).

```c
if (level >= 1 && m->method[level] == JM_INDEX) {
    /* index NLJ: point-look up Tk's PK index with the preceding table's key */
    const Value *k = &m->rows[m->key_t[level]][m->key_i[level]];
    if (k->type == VAL_INT) {
        bval_t encoded;
        if (btree_search(&m->tabs[level]->index, k->int_val, &encoded) == 0) {
            /* pull one RID directly instead of scanning the inner whole */
        }
    }
}
```

### N-way Join — A Recursive Multi-Level Nested Loop

Joins do not stop at two. Joining several tables like `a JOIN b JOIN c ...` is a **recursive N-level nested loop**. Descending the table chain level by level, at level k we scan that table, and if the k-th `ON` matches we go to the next level; at the deepest point, when all rows are bound, we apply `WHERE` and output.

The key is that **a two-table join is just a special case (N=2) of this general form, so one piece of code handles both**. `mjoin_descend(level)` processes level k's table and recurses into `mjoin_descend(level+1)`, and at the deepest level (`level == ntabs`) the combined row is complete. Put `ORDER BY` on top (collect combined rows and sort) and join results can be sorted and `LIMIT`-ed too.

```
SELECT * FROM users JOIN orders ON users.id = orders.uid
                    JOIN products ON orders.oid = products.pid
users.id | users.name | orders.oid | orders.uid | orders.item | products.pid | products.pname
1 | kim | 10 | 1 | book | 10 | A
1 | kim | 11 | 1 | pen | 11 | B
(2 rows, index join)
```

> **Why recursion solves N-way for free**: viewing the join chain as "levels", each level does the same thing — "scan that table, and if the pair matches, descend to the next level". So whether 2 levels or 5, one function recursing into itself to depth N suffices — the same "recursive structure wants a recursive function" idea as when grammar rules fell into functions in [Part 2's recursive-descent parser](/blog/project/minidb/minidb-2-sql-engine).

## 3. Closer to Real SQL ① — Aliases and Self-Joins

Once joins worked, I wanted more. Getting closer to real SQL needed three more things. The first is **table aliases and self-joins**.

`FROM emp e JOIN emp m ON e.mgr = m.id` — hang the same table twice to join an employee to their manager. The trick is to base "name resolution" not on the table name but on the **effective name (the alias if present)**.

```c
/* effective name (tname) is the alias if present — self-join distinguishes the two instances by alias. */
m.tname[0] = sel->alias[0] ? sel->alias : m.tabs[0]->schema.table;
```

Then `e` and `m` are distinguished as different instances of the same `emp`, and self-join opens for free. When you write `e.mgr`, it resolves as "the mgr of effective name `e`", not "the mgr of table `emp`", so two aliases pointing at the same physical table do not get confused.

## 4. Closer to Real SQL ② — Aggregation and GROUP BY

If `WHERE` filters rows and joins stitch rows, `GROUP BY` and aggregate functions **fold many rows into one**. This is the first operation where one row does not map to one row.

A group's `COUNT` only emerges once you have seen the whole group. So minidb collects rows, sorts by group key, and runs an accumulator over each contiguous run of equal keys — the **same approach as PostgreSQL's sort-based `GroupAggregate`**. (If the input already arrives sorted by the group key, you could emit each group as it ends — that is PG's streaming GroupAggregate — but minidb takes the simple collect-and-sort path.)

```
SELECT dept, COUNT(*), SUM(amt), AVG(amt) FROM sales GROUP BY dept
dept | COUNT(*) | SUM(amt) | AVG(amt)
eng | 2 | 300 | 150
sales | 3 | 500 | 166.667
```

> **Why minidb's aggregation collects first**: `WHERE` or a plain `SELECT` can decide pass/fail on one row immediately, so it can stream rows one by one. But `COUNT(*)` needs to count to the last row of the group before its value emerges — so unless the input is already sorted by the group key, a materialize path that collects and sorts all rows first is required. Real PostgreSQL streams via GroupAggregate when the input is already sorted, and otherwise uses HashAggregate; minidb chose only the simple sort-based path.

### HAVING and Sorting Aggregate Results

We added `HAVING` and sorting of aggregate results. `HAVING` is the aggregate counterpart of `WHERE` — if `WHERE` filters rows, `HAVING` filters the *groups* after aggregation (`HAVING COUNT(*) > 2`).

| | `WHERE` | `HAVING` |
|---|---|---|
| Filters | individual rows | groups after aggregation |
| Applied | **before** grouping/aggregation | **after** grouping/aggregation |
| Can reference | column values | aggregate values (`COUNT(*)`, `SUM(amt)`) |
| Example | `WHERE amt > 100` | `HAVING SUM(amt) > 250` |

And collecting the folded output rows per group and sorting them gives sorting by aggregate value; by accepting `ORDER BY 2` (output-column position), it even does **top-N analysis** like `ORDER BY 2 DESC LIMIT 3` ("top 3 departments by total revenue").

```
SELECT dept, SUM(amt) FROM sales GROUP BY dept HAVING SUM(amt) > 250 ORDER BY 2 DESC
dept | SUM(amt)
sales | 500
eng | 300
```

### Joins and Aggregation Meet in One Function

The best realization is here. At first aggregation worked only on a single table, but once I realized that **the *combined row* a join already produces is exactly aggregation's input**, the two met in one function — the "collect rows and group/aggregate" code is identical whether the input is one table's rows or joined combined rows.

```c
/* the combined row a join produces is aggregation's input — the two executors meet in one function. */
if (!sel->select_star) {
    /* ... after collecting all combined rows into matbuf ... */
    int rc = aggregate_rowset(sel, matbuf, m.matcount, comb, cols, out);
}
```

Generalize only the column resolution to "from a table name to a list of (effective table, name)", and a real analytical query that aggregates joined data per group opens up.

```
SELECT users.name, COUNT(*), SUM(orders.oid)
  FROM users JOIN orders ON users.id = orders.uid
  GROUP BY users.name ORDER BY 2 DESC
users.name | COUNT(*) | SUM(orders.oid)
kim | 2 | 21
lee | 1 | 12
```

## 5. Join-Method Selection — The Optimizer's Core Decision

So far joins were nested-loop (+ index point lookup if inner PK). We added **hash join**. Scan the inner table once to build a **join key -> row list** hash (build), then scan the outer table once doing only hash lookups (probe) to find pairs. Seeing each table just once shrinks O(outer x inner) to O(outer + inner) — even without an index.

So minidb **picks one of three** per join level: index NLJ if the inner PK is the join key, hash join for other equi-joins, else nested loop.

```c
m.method[k] = JM_SCAN;
if (kcol >= 0) {
    if (kcol == 0 && m.tabs[k]->has_index) {
        m.method[k] = JM_INDEX; /* Tk's PK is the join key -> point lookup */
    } else {
        m.method[k] = JM_HASH;  /* otherwise -> build hash on Tk by join column */
    }
}
```

Different methods mixing per level within one query (`(N rows, index+hash join)`) is exactly the optimizer planning a join.

### Comparing the Three Algorithms

Textbook join algorithms are three, but I built only two (nested loop, hash) and skipped **sort-merge join**. Comparing the three:

| | Nested loop (NLJ) | Hash join | Sort-merge join |
|---|---|---|---|
| Time complexity | O(outer x inner) (O(outer x log) if index) | O(outer + inner) | O(sort cost + outer + inner) |
| Prep | none (index NLJ needs an index) | build inner into hash table | sort both by join key |
| Join condition | equi and non-equi | **equi only** | equi and range |
| Memory | low | hash must fit in memory | sort buffers |
| Shines when | one side small, inner indexed (OLTP) | both large, unsorted (OLAP) | both already sorted, or too big for hash |
| minidb | yes (scan/index) | yes | no (not built) |

Sort-merge sorts both sides by join key and combs them side by side like a zipper; on sorted input it uses less memory than a hash and handles range joins (not just equi-joins), so it is common in large data warehouses. It especially shines when both already come sorted (e.g. index-scan output) or both are too huge for a hash to fit in memory. Not building it was not laziness — it needs more sort infrastructure and has little to show at our scale.

### A Real Optimizer Picks by a Cost Model

The real PostgreSQL optimizer picks among these three by a **cost model** — weighing both sides' size estimates, which side is already sorted, whether the hash fits in `work_mem`, and sequential vs random I/O vs CPU cost all at once. The rough intuition:

- one side very small and the inner indexed -> **nested loop** (OLTP default)
- both large and unsorted -> **hash** (common in OLAP)
- both already sorted, or too big for even a hash -> **sort-merge**

minidb's "one of index/hash/scan per level" is a very coarse version of this cost model. And what a real optimizer weighs even before the join method is **join order** — for `A JOIN B JOIN C`, `(B JOIN C) JOIN A` can be far faster than `(A JOIN B) JOIN C`, so PostgreSQL compares the possible orders by cost. minidb just uses **the order written in the FROM clause** as-is.

> **Practical/interview note**: how much this "join-method selection" matters in practice shows in cases where the same join's response varies thousands of times by how you filter it. If the optimizer picks the wrong method or order (e.g. the big table as outer), the same query gets tens of times slower — so checking the actual choice with `EXPLAIN` is the first step of tuning.

> Deeper, hands-on join/pagination optimization: [Applying Deferred Join — expected 40x vs reality 13%](/blog/project/WikiEngine/deferred-join-optimization) (the trick of deferring the join read on huge-OFFSET pagination, with EXPLAIN analysis) · [Removing COUNT(*) and capping pages: 19,424ms -> 8ms](/blog/project/WikiEngine/query-refactoring-optimization) (cutting 19s to 8ms on 14.25M rows by removing COUNT and Deferred Join). Scan kinds and the optimizer's choice are in [DB Index ②](/blog/theory/db-index-02-scan-types).

## 6. The Arrival of LEFT JOIN and NULL

So far all joins were INNER — emitting only matching pairs. But to see "even users with no orders at all", you need **LEFT JOIN**. Keep the left (outer) row even with no match, and fill the right columns with **NULL**.

This is where NULL first entered minidb. The key point is that **NULL never arises in stored rows** (`INSERT` takes all values). NULL appears only in results, and only transiently, in spots like the unmatched right side of a LEFT JOIN. So the change scope stayed narrowly bound to the value model, comparison, and aggregation.

The recursive join needed just one addition — a **"did this outer row match" flag**. If level k's candidates are all exhausted with zero matches and that join is LEFT, fill that table's columns with NULL and descend once.

```c
/* LEFT JOIN but this outer row had no match at all -> fill the right with NULL to preserve it */
if (is_left && !m->matched[level]) {
    mjoin_null_fill(m, level);
    return mjoin_descend(m, level + 1);
}
```

Whether found by index, hash, or scan, "zero matches means NULL fill" is the same, so it is **cleanly orthogonal to join-method selection**. The "pick one of three" from section 5 does not entangle with this NULL-fill logic.

```
SELECT users.name, COUNT(*), COUNT(orders.oid)
  FROM users LEFT JOIN orders ON users.id = orders.uid
  GROUP BY users.name
users.name | COUNT(*) | COUNT(orders.oid)
kim | 2 | 2
lee | 1 | 1
park | 1 | 0
```

`park` has no orders, so it is preserved as a single NULL row; `COUNT(*)` counts that row for 1, and `COUNT(orders.oid)` skips the NULL for 0. The difference between these two is the semantics of NULL.

> **The semantics of NULL (an interview staple)**: `COUNT(*)` counts rows, and `COUNT(column)` counts non-NULL values. `SUM`, `AVG`, `MIN`, `MAX` also ignore NULL, and NULL equals nothing (not even NULL) — a NULL comparison in `WHERE` is false. This is the core of SQL's three-valued logic (TRUE/FALSE/UNKNOWN).

### IS NULL and the Anti-Join That Opens for Free

NULL cannot be caught with `=` (`NULL = NULL` is false too). So checking for NULL needs separate operators — `IS NULL` / `IS NOT NULL`. Once these exist, an **anti-join** opens for free.

```
SELECT users.name FROM users LEFT JOIN orders ON users.id = orders.uid
  WHERE orders.oid IS NULL
users.name
park
```

Make unmatched rows NULL with LEFT JOIN, then catch that NULL with `IS NULL`, and "users with no orders at all" come out. **Set difference falls out naturally from combining two features (LEFT JOIN + IS NULL).**

Finally we added `SELECT DISTINCT`, implemented the same as "GROUP BY every output column" — sort output rows by all columns then drop adjacent duplicates. Section 4's sort-based aggregation infrastructure is reused as-is.

```
SELECT DISTINCT dept FROM sales
dept
eng
sales
```

## 7. Closer to Real SQL ③ — A Query Inside a Query, the Subquery

Lastly we put on `WHERE col IN (SELECT ...)` — the **subquery**. Here the AST becomes recursive for the first time. Since the right side of the WHERE condition is not a value but another `SELECT`, a `Condition` holds a `SelectStmt` (self-referential, so forward declaration + pointer + malloc) and [Part 2's parser](/blog/project/minidb/minidb-2-sql-engine) calls itself again.

The key is that **an uncorrelated subquery runs only once**. The inside of `IN (SELECT uid FROM orders)` is independent of the outer row, so before scanning the outer we run the inner once to build a value set (the prepare step), and the outer only tests membership against that set.

| | Pre-cached (minidb) | Re-run per row (naive) |
|---|---|---|
| Inner executions | once (prepare) | as many as outer rows |
| Complexity | O(rows) | O(rows x subquery) |
| Premise | uncorrelated (inner independent of outer) | works even if correlated |

Re-running per row is O(rows x subquery), but pre-caching is O(rows).

```
SELECT * FROM users WHERE id IN (SELECT uid FROM orders)
id | name
1 | kim
2 | lee
```

Only users who placed orders (uid 1, 2) come out. Building the inner result into a set and having the outer query it is the simplest execution model of a subquery. We also attached `NOT IN` (flipped membership) and the **scalar subquery** comparing against a single value (`WHERE v > (SELECT v FROM t WHERE id = 2)`) — if IN is "is it in the set", scalar is "compare to that one value", using the same prepare infrastructure with only the comparison differing.

### Wrap-up — Multi-Key ORDER BY and OFFSET

As a final touch we added **multi-column `ORDER BY`** (`ORDER BY dept, amt DESC`) and **`OFFSET`** (`LIMIT 2 OFFSET 1` — pagination). Generalizing the sort comparator from a single key to a key list let us apply ASC/DESC per key — and as a bonus, the old DESC-handling hack of "sort ascending then reverse the whole thing" disappeared. The comparator walks keys in order and applies the direction at the first key that differs to produce a result.

> Deeper: aggregation (`SUM`/`COUNT`) leans strongly OLAP — "folding many rows into one column" — which is why analytical DBs store by column, not by row: [DB Storage Internals ②: Row Store vs Column Store](/blog/theory/db-storage-02-row-vs-column). Our sort-based aggregation (GroupAggregate) and the optimizer's scan choice are in [DB Index ②](/blog/theory/db-index-02-scan-types).

## 8. Wrap-up

This part was the path "from one table to many". The key design choices:

- **Multiple tables** — table = file, PostgreSQL relfilenode-style. So the single-table heap and B+Tree code was replicated N times as-is.
- **Nested-loop join** — a join is ultimately a double loop. If the inner PK is the join key, an index point lookup (O(outer x log)); N-way falls out of recursion for free.
- **Join-method selection** — one of index/hash/scan per level. A coarse version of what a real optimizer does with a cost model (sort-merge not built).
- **Aggregation and GROUP BY** — collect rows, sort, then accumulate (PostgreSQL GroupAggregate). A join's combined row is aggregation's input, so the two executors meet in one function. `HAVING` is aggregation's `WHERE`.
- **LEFT JOIN and NULL** — a single "zero matches means NULL fill" flag. Orthogonal to join-method selection. Once `IS NULL` exists, the anti-join is free.
- **Subquery** — the AST's first recursion. An uncorrelated one runs once and is cached (O(rows)).

We did not invent anything new. Instead we understood what PostgreSQL and MySQL do every day — taking characters, reading pages, returning rows — by building it from the bottom up one layer at a time. Store onto pages (pager, slotted page), cache in memory (buffer pool), tie into tables (heap), take SQL (parser, executor), find fast (B+Tree), survive a power loss (WAL), handle batched work atomically (transactions), put down multiple tables and join them (multiple tables, INNER/LEFT joins), and fold rows to aggregate (GROUP BY, HAVING). Joins pick among index, hash, and nested loop; unmatched rows get filled with NULL.

Now I know what happens in the layers underneath every time I type `SELECT`. That was the whole point of this project.

## References

- [PostgreSQL Documentation: Physical Storage (relfilenode)](https://www.postgresql.org/docs/current/storage.html)
- [PostgreSQL Documentation: Planner / Optimizer (join methods)](https://www.postgresql.org/docs/current/planner-optimizer.html)
- [PostgreSQL Documentation: Controlling the Planner (work_mem, join cost)](https://www.postgresql.org/docs/current/runtime-config-resource.html)
- This blog: [DB Index ②: Scan Types and the Optimizer](/blog/theory/db-index-02-scan-types) · [DB Storage Internals ②: Row Store vs Column Store](/blog/theory/db-storage-02-row-vs-column)
- Hands-on optimization: [Applying Deferred Join](/blog/project/WikiEngine/deferred-join-optimization) · [Removing COUNT(*) and capping pages](/blog/project/WikiEngine/query-refactoring-optimization)
- minidb series: [Part 1 Storage](/blog/project/minidb/minidb-1-storage) · [Part 2 SQL Engine](/blog/project/minidb/minidb-2-sql-engine) · [Part 3 Index·WAL](/blog/project/minidb/minidb-3-index-wal) · [Part 4 Transactions](/blog/project/minidb/minidb-4-transactions)
- [minidb on GitHub](https://github.com/dj258255/minidb)

> **Series**: [1. Storage](/blog/project/minidb/minidb-1-storage) · [2. SQL Engine](/blog/project/minidb/minidb-2-sql-engine) · [3. Index and WAL](/blog/project/minidb/minidb-3-index-wal) · [4. Transactions](/blog/project/minidb/minidb-4-transactions) · 5. Joins and Aggregation · [Code (GitHub)](https://github.com/dj258255/minidb)
</content>
</invoke>

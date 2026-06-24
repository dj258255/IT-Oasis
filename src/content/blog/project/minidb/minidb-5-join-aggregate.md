---
title: 'minidb — 조인과 집계: JOIN, GROUP BY, 조인 알고리즘'
titleEn: 'minidb — Joins and Aggregation: JOIN, GROUP BY, Join Algorithms'
description: "관계형 DB를 C로 밑바닥부터 만든 minidb 시리즈 마지막 편. 한 테이블을 넘어 테이블 여러 개를 둔다. PostgreSQL의 relfilenode처럼 테이블마다 파일을 따로 두고 카탈로그로 묶은 뒤, 재귀적 N-way 중첩 루프 조인을 짠다. 그리고 별칭·self-join, 집계(COUNT/SUM/MIN/MAX/AVG)·GROUP BY, 레벨마다 인덱스/해시/중첩 루프를 고르는 조인 알고리즘 선택까지 — 진짜 옵티마이저가 하는 일을 코드로 드러낸다."
descriptionEn: "The final part of building a relational database from scratch in C. Going beyond a single table: each table is its own files (like PostgreSQL's relfilenode) tied by a catalog, with a recursive N-way nested-loop join. Plus aliases/self-joins, aggregates (COUNT/SUM/MIN/MAX/AVG) with GROUP BY, and per-level join-method selection (index / hash / nested-loop) — the work a real optimizer does, made visible in code."
date: 2026-06-22
tags:
  - C
  - Database Internals
  - JOIN
  - Query Planner
  - SQL
  - Learning
category: project/minidb
coverImage: /uploads/project/minidb/cover.svg
draft: false
series: "minidb"
seriesOrder: 5
---

[4편](/blog/project/minidb/minidb-4-transactions)까지로 "한 테이블짜리 DB"가 완성됐다 — 저장·SQL·인덱스·내구성·트랜잭션. 이번 마지막 편은 테이블을 여러 개 두고 **잇는다**. 그러려면 저장 구조부터 손봐야 했다.

## 다중 테이블과 JOIN

진짜 DB처럼 테이블 여러 개를 두고 조인하려면 저장 구조부터 바꿔야 했다. **PostgreSQL이 릴레이션마다 디스크 파일을 따로 두는 방식(relfilenode)** 을 그대로 따랐다. 어떤 테이블이 있는지는 카탈로그 파일이 들고(`pg_class` 격), 각 테이블의 행과 인덱스는 테이블별 파일에 산다.

```
mydb              카탈로그 — 테이블 목록 + 스키마
mydb.users.tbl    users 행 (Heap)
mydb.users.idx    users PK 인덱스 (B+Tree)
mydb.orders.tbl   orders 행
mydb.orders.idx   orders PK 인덱스
```

테이블이 파일별로 나뉘니 앞서 만든 힙·B+Tree 코드는 한 줄도 안 고치고 테이블 수만큼 복제하면 됐다. 트랜잭션만 모든 테이블에 걸쳐 작동하도록 넓혔다.

조인은 가장 기본인 **중첩 루프 조인(nested-loop join)** 으로 구현했다. 바깥 테이블을 한 행씩 훑으면서, 그 한 행마다 안쪽 테이블을 전부 스캔해 `ON` 조건이 맞는 짝을 찾아 두 행을 이어 붙인다. 컬럼은 `users.id` 처럼 테이블로 한정할 수 있고, `WHERE` 는 양쪽 테이블 어느 컬럼으로도 건다.

```
SELECT * FROM users JOIN orders ON users.id = orders.uid WHERE users.name = 'kim'
users.id | users.name | orders.oid | orders.uid | orders.item
1 | kim | 10 | 1 | book
1 | kim | 11 | 1 | pen
(2행)
```

옵티마이저가 인덱스나 해시를 못 쓸 때 실제로 떨어지는 게 이 중첩 루프 조인이다. O(바깥 x 안쪽)이라 느리지만, "조인이 결국 두 스캔의 이중 루프"라는 본질이 코드에 그대로 드러난다.

여기서 한 걸음 더 갔다. 안쪽 테이블의 **PK가 마침 `ON` 컬럼이면**, 안쪽을 전부 훑을 필요가 없다. 바깥 행의 키로 B+Tree를 점 조회하면 끝 — O(바깥 x 안쪽)이 O(바깥 x log 안쪽)으로 줄어든다. 이게 옵티마이저가 인덱스가 있을 때 고르는 **인덱스 중첩 루프 조인(index nested-loop join)** 이다. minidb는 조인 시 안쪽 PK가 조인 키인지 보고, 맞으면 전체 스캔 대신 `btree_search` 로 바꾼다(`(N행, 인덱스 조인)` 으로 표시).

조인은 둘로 끝나지 않는다. `a JOIN b JOIN c ...` 처럼 여러 테이블을 잇는 건 **재귀적인 N단 중첩 루프**다. 테이블 체인을 레벨별로 내려가며, 레벨 k에서 그 테이블을 스캔하고 k번째 `ON` 이 맞으면 다음 레벨로, 가장 깊은 곳에서 모든 행이 묶이면 `WHERE` 를 걸고 출력한다. 2단 조인은 이 일반형의 특수한 경우(N=2)일 뿐이라, 코드 하나로 둘 다 처리된다. 그 위에 `ORDER BY` 를 얹으면(결합 행을 모아 정렬) 조인 결과도 정렬·`LIMIT` 할 수 있다.

```
SELECT * FROM users JOIN orders ON users.id = orders.uid
                    JOIN products ON orders.oid = products.pid
users.id | users.name | orders.oid | orders.uid | orders.item | products.pid | products.pname
1 | kim | 10 | 1 | book | 10 | A
1 | kim | 11 | 1 | pen | 11 | B
(2행, 인덱스 조인)
```

## 더 진짜 SQL처럼: 별칭, 집계, 조인 알고리즘

조인을 만들고 나니 욕심이 났다. 진짜 SQL에 가까워지려면 세 가지가 더 필요했다.

**테이블 별칭과 self-join.** `FROM emp e JOIN emp m ON e.mgr = m.id` — 같은 테이블을 두 번 걸어 직원과 그 상사를 잇는다. 비결은 "이름 해소"를 테이블명이 아니라 **실효 이름(별칭이 있으면 별칭)** 으로 바꾸는 것. 그러면 `e` 와 `m` 이 같은 `emp` 의 다른 인스턴스로 구별돼, self-join이 공짜로 열린다.

**집계와 GROUP BY.** `WHERE` 가 행을 거르고 조인이 행을 잇는다면, `GROUP BY` 와 집계 함수는 여러 행을 **하나로 접는다**. 정렬 못 하는 `ORDER BY` 처럼 스트리밍이 안 되니(그룹 전체를 봐야 `COUNT` 가 나옴), 행을 모아 그룹 키로 정렬한 뒤 같은 키의 연속 구간마다 누산기를 돌린다 — PostgreSQL의 정렬 기반 `GroupAggregate` 다.

```
SELECT dept, COUNT(*), SUM(amt), AVG(amt) FROM sales GROUP BY dept
dept | COUNT(*) | SUM(amt) | AVG(amt)
eng | 2 | 300 | 150
sales | 3 | 500 | 166.667
```

여기에 `HAVING` 과 집계 결과 정렬을 더했다. `HAVING` 은 `WHERE` 의 집계판이다 — `WHERE` 가 행을 거른다면 `HAVING` 은 집계가 끝난 *그룹* 을 거른다(`HAVING COUNT(*) > 2`). 그리고 그룹마다 접힌 출력 행을 따로 모아 정렬하면 집계값 기준 정렬이 되는데, `ORDER BY 2`(출력 컬럼 위치)를 받게 해 `ORDER BY 2 DESC LIMIT 3` 같은 **상위 N 분석** 까지 된다("매출 합 상위 3개 부서").

```
SELECT dept, SUM(amt) FROM sales GROUP BY dept HAVING SUM(amt) > 250 ORDER BY 2 DESC
dept | SUM(amt)
sales | 500
eng | 300
```

마지막으로 **조인과 집계를 합쳤다.** 처음엔 집계가 단일 테이블만 됐는데, 조인이 이미 만들어내는 *결합 행* 이 곧 집계의 입력이라는 걸 깨닫고 나니 둘은 한 함수로 만났다 — "행을 모아 그룹·집계"하는 코드는 입력이 한 테이블의 행이든 조인된 결합 행이든 똑같으니까. 컬럼 해소만 "테이블명에서 (실효 테이블, 이름) 목록"으로 일반화하면, 조인한 데이터를 그룹별로 집계하는 진짜 분석 쿼리가 열린다.

```
SELECT users.name, COUNT(*), SUM(orders.oid)
  FROM users JOIN orders ON users.id = orders.uid
  GROUP BY users.name ORDER BY 2 DESC
users.name | COUNT(*) | SUM(orders.oid)
kim | 2 | 21
lee | 1 | 12
```

**조인 알고리즘 선택.** 지금까지 조인은 중첩 루프(+안쪽 PK면 인덱스 점 조회)였다. 여기에 **해시 조인** 을 더했다. 안쪽 테이블을 조인 컬럼으로 미리 해시 테이블로 만들어 두면, 바깥 행마다 O(1)로 짝을 찾는다 — 인덱스가 없어도 O(바깥 x 안쪽)을 O(바깥 + 안쪽)으로 줄인다. 그래서 minidb는 조인 레벨마다 **셋 중 하나를 고른다**: 안쪽 PK가 조인 키면 인덱스 NLJ, 그 밖의 등식 조인이면 해시 조인, 아니면 중첩 루프. 한 쿼리 안에서 레벨마다 다른 방법이 섞이는 게(`(N행, 인덱스+해시 조인)`) 곧 옵티마이저가 조인 계획을 짜는 일이다.

## LEFT JOIN과 NULL의 등장

지금까지 조인은 전부 INNER였다 — 양쪽이 맞는 쌍만 내보낸다. 하지만 "주문이 하나도 없는 사용자까지" 보려면 **LEFT JOIN** 이 필요하다. 왼쪽(바깥) 행은 매칭이 없어도 살리고, 오른쪽 컬럼을 **NULL** 로 채운다.

여기서 minidb에 처음으로 NULL이 들어왔다. 중요한 건 **NULL이 저장 행엔 절대 안 생긴다**는 점이다(`INSERT` 는 값을 다 받는다). NULL은 오직 결과에만, 그것도 LEFT JOIN의 미매칭 오른쪽 같은 자리에만 transient하게 등장한다. 그래서 변경 범위가 값 모델·비교·집계로 좁게 묶였다.

재귀 조인에는 딱 한 가지만 더했다 — **"이번 바깥 행이 매칭됐나"는 플래그**. 레벨 k의 후보를 다 돌렸는데 매칭이 0이고 그 조인이 LEFT면, 그 테이블 컬럼을 NULL로 채워 한 번 내려보낸다. 인덱스로 찾든 해시로 찾든 스캔으로 찾든 "매칭 0이면 NULL 채움"은 똑같아서, 조인 알고리즘 선택과 깔끔하게 직교한다.

```
SELECT users.name, COUNT(*), COUNT(orders.oid)
  FROM users LEFT JOIN orders ON users.id = orders.uid
  GROUP BY users.name
users.name | COUNT(*) | COUNT(orders.oid)
kim | 2 | 2
lee | 1 | 1
park | 1 | 0
```

`park` 은 주문이 없어 NULL 한 줄로 보존됐는데, `COUNT(*)` 는 그 행을 세서 1, `COUNT(orders.oid)` 는 NULL을 건너뛰어 0이다. 이 둘의 차이가 곧 NULL의 의미론이다 — `COUNT(*)` 는 행을 세고, `COUNT(컬럼)` 은 NULL 아닌 값을 센다. `SUM`·`AVG`·`MIN`·`MAX` 도 NULL을 무시하고, NULL은 무엇과도(심지어 NULL과도) 같지 않다(`WHERE` 에서 NULL 비교는 거짓).

그래서 NULL을 검사하려면 별도 연산자가 필요하다 — `IS NULL` / `IS NOT NULL`. `=` 는 NULL에 항상 거짓이니 NULL을 잡을 방법이 이것뿐이다. 이게 생기니 **anti-join** 이 공짜로 열린다.

```
SELECT users.name FROM users LEFT JOIN orders ON users.id = orders.uid
  WHERE orders.oid IS NULL
users.name
park
```

LEFT JOIN으로 미매칭을 NULL로 만들고, `IS NULL` 로 그 NULL을 잡으면 "주문이 하나도 없는 사용자"가 나온다. 차집합이 두 기능의 결합으로 자연히 떨어진다. 끝으로 `SELECT DISTINCT` 도 더했는데, 구현은 "모든 출력 컬럼으로 GROUP BY 한 것"과 같다 — 출력 행을 전체 컬럼으로 정렬한 뒤 인접한 중복을 지우면 끝이다.

## 닫으며

새로운 걸 발명하진 않았다. 대신 PostgreSQL·MySQL이 매일 하는 일 — 글자를 받아 페이지를 읽고 행을 돌려주는 그 일 — 을 밑바닥부터 한 겹씩 직접 만들며 이해했다. 페이지에 저장하고(페이저·슬롯 페이지), 메모리에 캐시하고(버퍼 풀), 테이블로 묶고(힙), SQL을 받고(파서·실행기), 빠르게 찾고(B+Tree), 전원이 꺼져도 안 깨지고(WAL), 묶음 작업을 원자적으로 처리하고(트랜잭션), 테이블을 여러 개 두고 조인하고(다중 테이블·INNER/LEFT 조인), 행을 접어 집계한다(GROUP BY·HAVING). 조인은 인덱스·해시·중첩 루프 중에서 골라 가며, 매칭 없는 행은 NULL로 채워 가며.

이제 `SELECT` 를 칠 때마다 그 아래 계층들에서 무슨 일이 벌어지는지 안다. 그게 이 프로젝트의 전부였다.

> **시리즈**: [1. 저장 계층](/blog/project/minidb/minidb-1-storage) · [2. SQL 엔진](/blog/project/minidb/minidb-2-sql-engine) · [3. 인덱스와 WAL](/blog/project/minidb/minidb-3-index-wal) · [4. 트랜잭션](/blog/project/minidb/minidb-4-transactions) · 5. 조인과 집계 · [코드(GitHub)](https://github.com/dj258255/minidb)

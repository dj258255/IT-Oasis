---
title: 'DB 내부 ⑪: SQL 실행기 — 텍스트에서 행까지, 조인 3형제와 3값 논리'
titleEn: 'DB Internals ⑪: The SQL Executor — From Text to Rows, the Three Joins, and Three-Valued Logic'
description: "SQL은 '무엇을'만 말하는 선언형 언어다 — 그 텍스트가 실제 행이 되기까지의 파이프라인을 해부한다. 렉서(maximal munch, 예약어는 왜 생기나), 재귀 하강 파서(문법 규칙 하나 = 함수 하나, 서브쿼리에서 파서가 자기 자신을 부른다 — 손 파서 vs bison/Lemon의 갈림), 그리고 실행기에서 스트리밍과 materialize가 갈리는 이유. 본론은 조인 3형제 — 모든 조인의 출발점인 중첩 루프(이중 루프), 안쪽을 점 조회로 바꾸는 인덱스 NLJ, O(N+M)의 해시 조인, 그리고 안 만든 정렬 병합까지 선택 기준을 표로. GROUP BY가 왜 정렬(또는 해시)을 요구하는지(GroupAggregate vs HashAggregate), HAVING은 왜 그룹의 WHERE인지. 마지막으로 BETWEEN이 실행기 0줄로 끝난 이유(문법 설탕), LIKE의 백트래킹 two-pointer 매칭과 LIKE '%x%'가 B-tree를 못 타는 이유(트라이그램·역색인으로의 탈출구), uncorrelated 서브쿼리의 1회 실행 캐시, 그리고 NULL의 3값 논리(UNKNOWN, NOT IN + NULL 함정)까지 — 시리즈의 실행기 축을 완결한다."
descriptionEn: "SQL is declarative — it says only 'what.' We dissect the pipeline that turns that text into actual rows: the lexer (maximal munch; why reserved words exist), the recursive-descent parser (one grammar rule = one function; on subqueries the parser calls itself — and the hand-written vs bison/Lemon fork), and why execution splits into streaming vs materializing. The main act is the three joins — the nested loop that every join begins as (a double loop), the index NLJ that turns the inner side into point lookups, the O(N+M) hash join, and the sort-merge we didn't build, with selection criteria in a table. Why GROUP BY demands sorting (or hashing) — GroupAggregate vs HashAggregate — and why HAVING is the WHERE of groups. Finally: why BETWEEN cost zero executor lines (syntactic sugar), LIKE's backtracking two-pointer matcher and why LIKE '%x%' can't use a B-tree (with trigram/inverted-index escape routes), the run-once cache for uncorrelated subqueries, and NULL's three-valued logic (UNKNOWN; the NOT IN + NULL trap) — completing the series' executor axis."
date: 2026-07-06T00:00:00.000Z
tags:
  - Database Internals
  - SQL
  - Parser
  - Join
  - Executor
  - PostgreSQL
  - C
category: project/db-hobby
coverImage: /uploads/project/db-hobby/cover.svg
draft: false
series: "미니 DB로 이해하는 DB 내부"
seriesOrder: 11
---

## 0. 들어가며 — 선언형 언어가 행이 되기까지

이 시리즈의 [1~10편](/blog/project/db-hobby/db-internals-01-storage)은 저장·복구·격리·최적화·분산을 다뤘는데, 정작 한 축이 비어 있었어요 — **SQL 텍스트가 실제 행이 되기까지의 실행기 파이프라인** 그 자체. 이 편이 그 축을 완결합니다.

SQL은 선언형 언어예요 — "**무엇을**"만 말하고 "어떻게"는 안 말합니다. `SELECT * FROM users WHERE id = 1`이라는 문자열이 힙의 실제 행이 되려면 세 단계가 필요해요.

```
SQL 텍스트 → [렉서] → 토큰 → [파서] → AST → [실행기] → 행
```

컴파일러의 앞단을 그대로 빌려온 구조입니다 — 모든 DB의 프런트엔드가 이렇게 생겼어요.

## 1. 렉서 — 글자를 토큰으로

**1단계는 토크나이저(렉서).** `SELECT * FROM users WHERE id = 1` → `[SELECT] [*] [FROM] [IDENT:users] [WHERE] [IDENT:id] [=] [INT:1]`. 하는 일은 공백 건너뛰기, 글자 덩어리 묶기, `'...'` 문자열 떼기 — 그리고 미묘한 규칙 하나:

```c
/* 비교 연산자: 두 글자를 먼저 본다 */
if (c == '<' && nx == '=') { ...; t.type = TOK_LE; }   /* <= */
if (c == '<' && nx == '>') { ...; t.type = TOK_NE; }   /* SQL의 <> */
if (c == '<')              { ...; t.type = TOK_LT; }   /* 그냥 < */
```

> **maximal munch**: `<=`를 만났을 때 `<` 하나만 떼면 뒤의 `=`가 엉뚱하게 따로 떨어진다. 렉서는 "가능한 한 긴 토큰을 먼저 집는다"(longest match) — 거의 모든 렉서의 원칙이다.

키워드와 식별자의 구분도 여기서 정해져요 — 덩어리를 다 읽은 뒤 예약어 표를 조회해서(`strcasecmp`로 대소문자 무시) `users`는 `IDENT`, `FROM`은 키워드 토큰이 됩니다.

> **실무/면접 포인트 — 예약어는 왜 생기나**: `SELECT`가 키워드 토큰이 되므로 컬럼 이름으로 그냥 `select`를 쓰면 파서가 헷갈린다. 그래서 예약어(reserved word)가 존재하고, 따옴표로 escape하면 쓸 수 있다 — PostgreSQL은 `"select"`, MySQL은 백틱, SQL Server는 `[select]`. 진짜 DB는 비예약(non-reserved) 키워드도 둬서 일부는 그냥도 허용한다.

## 2. 재귀 하강 파서 — 문법 규칙 하나 = 함수 하나

**2단계는 파서.** 토큰을 트리(AST)로 조립합니다. 재귀 하강(recursive descent)의 묘미는 **문법 규칙 하나하나가 함수 하나**가 된다는 것 — 파서 코드가 거의 영어로 읽혀요.

```c
static void parse_select_stmt(Parser *p, SelectStmt *s) {
    parse_select_list(p, s);               /* * 또는 컬럼/집계 목록 */
    p_expect(p, TOK_FROM, "FROM이 필요합니다");
    parse_name(p, s->table);
    if (p_accept(p, TOK_WHERE))  parse_where(p, &s->where);
    if (p_accept(p, TOK_GROUP))  { /* GROUP BY ... */ }
    if (p_accept(p, TOK_ORDER))  { /* ORDER BY ... */ }
}
```

파서를 떠받치는 도구는 셋뿐이에요 — `p_accept`(있으면 소비, 선택 문법), `p_expect`(없으면 에러, 필수 문법), `p_advance`(다음 토큰). 이 셋이 재귀 하강의 전부라 해도 됩니다.

![SQL 텍스트 → 토큰 → AST](/uploads/project/db-hobby/sql-to-ast.svg)

두 가지가 특히 배울 지점이에요.

- **우선순위 = 함수 호출 순서.** WHERE는 `term (OR term)*`, term은 `cond (AND cond)*`로 파싱돼요 — AND가 OR보다 안쪽 함수라 `a AND b OR c`는 자연히 `(a AND b) OR c`가 됩니다. 연산자 우선순위를 표가 아니라 **호출 구조**로 표현하는 것.
- **서브쿼리에서 파서가 자기 자신을 부른다.** `WHERE id IN (SELECT ...)`를 만나면 조건 파싱 함수 안에서 `parse_select_stmt`를 다시 불러요 — 문법이 재귀적이니 파서도 재귀적. "재귀 하강"이라는 이름의 정체입니다(AST의 `Condition`이 `SelectStmt*`를 품는 자기참조 구조가 되고요).

### 손으로 쓴 파서 vs 파서 생성기

| | 손으로 쓴 재귀 하강 | 파서 생성기 (yacc/bison) |
|---|---|---|
| 문법 정의 | 함수로 직접 (코드 = 문법) | 별도 `.y` 문법 파일 |
| 에러 메시지 | 마음대로 (위치·맥락 자유) | 기본값에 갇히기 쉬움 |
| 디버깅 | 함수 따라가기 | 생성된 상태 머신을 봐야 |
| 큰 문법·복잡한 우선순위 | 함수가 늘어남 | 빛난다 (자동 처리) |
| 채택 | GCC/Clang, 그리고 SQLite(자체 생성기 **Lemon**) | **MySQL(bison), PostgreSQL(bison)** |

PostgreSQL과 MySQL은 bison(LALR 생성기)을 쓰고, SQLite는 자체 생성기 Lemon을 씁니다. 손 파서는 에러 메시지와 디버깅 통제가 쉬워 컴파일러 세계(GCC/Clang)에선 오히려 주류예요 — 학습용으로도 "코드가 곧 문법"이라 압도적으로 유리하고요.

## 3. 실행기 — 스트리밍과 materialize가 갈리는 곳

**3단계, AST를 힙 연산으로.** 실행기의 큰 그림은 연산자 트리를 행이 흐르는 파이프라인으로 보는 **Volcano/iterator 모델**입니다(Goetz Graefe, 1994 — PostgreSQL 실행기의 조상). 미니 DB는 이를 콜백(visit) 스타일로 단순화했지만, 본질적 구분 하나는 그대로 드러나요:

> **행 하나 보고 결정할 수 있으면 스트리밍, 여러 행을 봐야 하면 materialize.** `WHERE`는 행 하나로 통과/탈락이 정해지니 한 행씩 흘려보내면 된다. 그런데 `COUNT(*)`는 그룹의 마지막 행까지 봐야 하고, `ORDER BY`는 전체를 봐야 한다 — 행을 모아야(materialize) 한다. 이 구분이 메모리 사용량과 첫 행 응답 시간을 가른다.

이 구분은 이미 시리즈 곳곳에서 일했어요 — [8편](/blog/project/db-hobby/db-internals-08-parallel)의 병렬화가 스트리밍 SELECT와 집계를 다른 전략으로 다룬 이유, 그리고 집계의 materialize 버퍼 상한이 silent 버그가 됐던 사건이 전부 이 지점입니다.

## 4. 조인 3형제 — 모든 조인은 이중 루프에서 시작한다

여러 테이블을 잇는 조인의 출발점은 **중첩 루프 조인(NLJ)** 이에요 — 바깥 테이블을 한 행씩 훑으며, 행마다 안쪽 테이블을 전부 스캔해 `ON`이 맞는 짝을 붙이는 이중 루프.

> **핵심 사실**: 모든 조인 알고리즘의 출발점은 중첩 루프다. "맞는 짝을 찾는다"의 가장 솔직한 표현이고, **인덱스·해시·정렬병합은 전부 이 안쪽 루프를 빠르게 만드는 변형**일 뿐이다.

- **인덱스 NLJ** — 안쪽 테이블의 조인 키에 인덱스가 있으면, 안쪽 전체 스캔 대신 바깥 행의 키로 **점 조회**. O(N×M) → O(N×log M).
- **해시 조인** — 안쪽을 한 번 훑어 `조인 키 → 행 목록` 해시를 만들고(build), 바깥을 한 번 훑으며 조회(probe). O(N×M) → **O(N+M)**, 인덱스가 없어도. 단 **등식 조인만** 됩니다(해시는 순서가 없으니까).
- **정렬 병합 조인** — 양쪽을 조인 키로 정렬해 지퍼 잠그듯 나란히 훑기. 미니 DB는 안 만들었어요 — 정렬 인프라가 더 필요하고 우리 규모에선 보여줄 게 적어서(정직한 생략).

| | NLJ | 인덱스 NLJ | 해시 조인 | 정렬 병합 |
|---|---|---|---|---|
| 복잡도 | O(N×M) | O(N×log M) | **O(N+M)** | O(정렬+N+M) |
| 조인 조건 | 아무거나 | 등식(인덱스 키) | **등식만** | 등식·범위 |
| 사전 준비 | 없음 | 인덱스 | 해시 빌드(메모리) | 양쪽 정렬 |
| 빛나는 곳 | 한쪽이 아주 작을 때 | OLTP(안쪽에 인덱스) | 양쪽 크고 정렬 안 됨(OLAP) | 이미 정렬됐거나 해시가 메모리 초과 |

미니 DB는 조인 레벨마다 "안쪽 PK가 조인 키면 인덱스 NLJ, 그 밖의 등식이면 해시, 아니면 스캔"으로 골라요 — [6편](/blog/project/db-hobby/db-internals-06-optimizer)의 비용 모델이 이 선택을 정교화한 거고요. PostgreSQL은 여기에 정렬 병합까지 셋을 비용(`work_mem`에 해시가 들어가나, 어느 쪽이 이미 정렬돼 있나)으로 저울질합니다.

**LEFT JOIN과 NULL의 등장** — INNER는 맞는 쌍만 내보내지만, LEFT는 왼쪽 행을 매칭이 없어도 살리고 오른쪽을 **NULL로 채워요.** 구현은 "이번 바깥 행이 매칭됐나" 플래그 하나 — 그리고 이 NULL 채움이 인덱스/해시/스캔 어느 방법과도 **직교**한다는 게 설계의 미덕입니다(방법 선택과 NULL 로직이 서로 안 얽힘).

## 5. 집계 — GROUP BY는 왜 정렬(또는 해시)인가

`WHERE`가 행을 거르고 조인이 행을 잇는다면, `GROUP BY`+집계는 여러 행을 **하나로 접습니다** — 처음으로 "행 하나 → 행 하나"가 아닌 연산이에요. 한 그룹의 `COUNT`는 그 그룹 전체를 봐야 나오니, **같은 그룹의 행들이 인접해야** 구간 단위로 누산기를 돌릴 수 있습니다. 그래서 길이 둘이에요:

- **정렬 기반(GroupAggregate)** — 그룹 키로 정렬하면 같은 키가 연속 구간이 된다. 미니 DB와 PostgreSQL의 GroupAggregate 방식(PG는 입력이 이미 정렬돼 있으면 모으지 않고 스트리밍).
- **해시 기반(HashAggregate)** — 그룹 키 → 누산기 해시를 두고 한 번에 스캔. 정렬이 필요 없지만 그룹 수만큼 메모리를 쓴다. PostgreSQL이 둘을 비용으로 고른다.

`HAVING`은 **그룹의 WHERE**예요 — WHERE가 그룹핑 *전에* 개별 행을 거르고, HAVING이 집계가 끝난 *뒤에* 그룹을 거릅니다(`HAVING COUNT(*) > 2`). 적용 시점이 다르다는 것이 둘의 전부입니다.

## 6. WHERE의 확장 — 공짜인 것과 아닌 것

기능을 얹을 때마다 "새 코드가 필요한가"가 갈렸는데, 그 갈림 자체가 배울 거리예요.

**BETWEEN — 실행기 0줄 (문법 설탕).** `col BETWEEN a AND b`는 파서가 그 자리에서 `(col >= a) AND (col <= b)`로 풀어버리면 끝 — 실행기는 자기가 BETWEEN을 처리하는 줄도 모릅니다. (PostgreSQL은 파스 트리에 BETWEEN 노드를 남겼다가 나중에 변환해요 — 어디서 푸느냐는 구현 선택.) `IN (v1, v2, ...)`도 같은 결 — 값 집합 멤버십일 뿐.

**LIKE — 진짜 새 연산자.** `%`(0글자 이상)·`_`(한 글자) 와일드카드는 어떤 기존 비교로도 안 풀려요. 매칭 알고리즘의 갈림길이 셋인데:

| 방식 | 시간 | 공간 | 문제 |
|---|---|---|---|
| 재귀 | 최악 지수적 | 스택 | `%` 여러 개면 호출 폭발 |
| DP 테이블 | O(n·m) | O(n·m) | 길이 곱만큼 메모리 |
| **백트래킹 two-pointer** | 평균 ~O(n) | **O(1)** | 인위적 최악 패턴에서 출렁임 |

```c
static int like_match(const char *s, const char *pat) {
    const char *star = NULL, *ss = NULL;
    while (*s) {
        if (*pat == '%')      { star = pat++; ss = s; }      /* %: 위치 기억, 일단 0글자 */
        else if (*pat == '_' || *pat == *s) { pat++; s++; }  /* 한 글자 일치 */
        else if (star) { pat = star + 1; s = ++ss; }         /* 막힘 -> %가 한 글자 더 먹은 셈 */
        else return 0;
    }
    while (*pat == '%') pat++;
    return *pat == '\0';
}
```

포인터 둘과 "마지막 `%` 위치"만 기억하는 O(1) 공간 매처예요.

> **실무/면접 포인트 — LIKE '%x%'는 왜 느린가**: 인덱스는 값을 **정렬한** 구조라, `'kim%'`처럼 앞이 고정된 패턴만 "정렬된 구간의 시작점"으로 점프할 수 있다. 앞이 `%`로 열리면 시작점을 특정할 수 없어 풀 스캔이다 — 미니 DB만이 아니라 **B-tree 인덱스의 본질적 한계.** 중간 일치가 필요하면 인덱스 자체를 바꾼다: PostgreSQL의 트라이그램(pg_trgm — 문자열을 3글자 조각으로 쪼개 색인), 또는 검색 엔진의 역색인(Lucene/Elasticsearch).

**서브쿼리 — uncorrelated는 한 번만 돈다.** `IN (SELECT uid FROM orders)`의 안쪽은 바깥 행과 무관하니, 바깥 스캔 **전에 한 번** 돌려 값 집합을 캐시하고 바깥은 멤버십만 검사해요. 행마다 재실행하면 O(행×서브쿼리), 캐시하면 O(행) — 이 구분(uncorrelated vs correlated)이 진짜 옵티마이저의 서브쿼리 unnesting이 하는 고민의 출발점입니다. 그리고 [8편](/blog/project/db-hobby/db-internals-08-parallel)에서 서브쿼리 WHERE가 병렬화 게이트에 걸렸던 이유도 이것 — 술어가 실행기를 재진입하니까요.

## 7. NULL의 의미론 — 3값 논리

[1편](/blog/project/db-hobby/db-internals-01-storage)에서 NULL의 **저장**(비트맵)을 다뤘으니, 여기선 **의미**를 닫습니다. SQL의 비교는 참/거짓이 아니라 **3값** — TRUE / FALSE / **UNKNOWN**이에요.

> **핵심 규칙**: NULL은 "값이 없음"이 아니라 **"모름"** 이다. 모르는 것과의 비교는 그 결과도 모른다 — `NULL = NULL`은 TRUE가 아니라 **UNKNOWN**이다(둘 다 모르는 값인데 같은지 어떻게 아나). 그리고 **WHERE는 TRUE만 통과**시킨다 — UNKNOWN은 FALSE처럼 걸러진다.

이 두 줄에서 실무의 함정들이 전부 유도돼요:

- `WHERE col = NULL`은 **아무 행도 안 나온다** (전부 UNKNOWN). NULL 검사는 전용 연산자 `IS NULL` / `IS NOT NULL`로.
- **`NOT IN` + NULL 함정**: `x NOT IN (1, NULL)`은 `x != 1 AND x != NULL`인데 뒤가 UNKNOWN이라 전체가 최고 UNKNOWN — **절대 TRUE가 될 수 없어 결과가 통째로 빈다.** 서브쿼리 결과에 NULL이 하나만 섞여도 `NOT IN`이 전멸하는 유명한 사고.
- **집계는 NULL을 건너뛴다**: `COUNT(*)`는 행 수(NULL 포함), `COUNT(col)`/`SUM`/`AVG`는 비NULL만. `AVG`의 분모도 비NULL 개수다 — 이 구분은 [8편의 부분 집계](/blog/project/db-hobby/db-internals-08-parallel)에서 누산기를 둘로 나눈 이유였다.
- **정렬에서 NULL의 자리**: 비교가 안 되니 위치를 **정해줘야** 한다. PostgreSQL은 기본 NULLS LAST(ASC 기준), 지정도 가능 — 미니 DB도 같은 기본값.

## 8. 정리 — 시리즈의 실행기 축, 완결

- **파이프라인**: 렉서(maximal munch, 예약어) → 재귀 하강 파서(문법=함수, 우선순위=호출 구조, 서브쿼리=자기 재귀) → 실행기(스트리밍 vs materialize).
- **조인 3형제**: 전부 중첩 루프의 변형 — 인덱스는 안쪽을 점 조회로, 해시는 O(N+M)으로(등식만), 정렬 병합은 정렬된 입력에서. LEFT JOIN의 NULL 채움은 방법 선택과 직교.
- **집계**: 같은 그룹이 인접해야 접을 수 있다 — 정렬 기반(GroupAggregate) vs 해시 기반(HashAggregate). HAVING = 그룹의 WHERE.
- **공짜 vs 진짜**: BETWEEN/IN(목록)은 파서의 문법 설탕(실행기 0줄), LIKE는 진짜 새 연산자(O(1) 공간 백트래킹 매처). `'%x%'`가 느린 건 B-tree의 본질 — 탈출구는 트라이그램·역색인.
- **3값 논리**: NULL은 "모름", WHERE는 TRUE만 통과 — `NOT IN`+NULL 전멸, `COUNT(*) vs COUNT(col)`, NULLS LAST가 전부 여기서 유도된다.

이로써 시리즈가 진짜 완결이에요 — 저장([①](/blog/project/db-hobby/db-internals-01-storage))부터 실행기(⑪)까지, 미니 DB가 가진 모든 축을 다뤘습니다.

## 참고 (1차 자료 우선)

- Goetz Graefe, *Volcano — An Extensible and Parallel Query Evaluation System* (IEEE TKDE, 1994)
- [PostgreSQL Documentation: The Parser Stage](https://www.postgresql.org/docs/current/parser-stage.html)
- [PostgreSQL Documentation: Pattern Matching (LIKE, pg_trgm)](https://www.postgresql.org/docs/current/functions-matching.html)
- [SQLite: The Lemon LALR(1) Parser Generator](https://sqlite.org/lemon.html)
- [PostgreSQL Documentation: Executor](https://www.postgresql.org/docs/current/executor.html)
- 본 블로그: [DB 인덱스 ①: EXPLAIN 읽기](/blog/theory/db-index-01-explain-basics)
- [db-hobby 코드 (GitHub)](https://github.com/dj258255/db-hobby) — `sql.c`(렉서·파서) · `db.c`(실행기·조인·집계)

<!-- EN -->

## 0. Introduction — From a Declarative Language to Rows

Parts [1–10](/blog/project/db-hobby/db-internals-01-storage) of this series covered storage, recovery, isolation, optimization, and distribution — but one axis stayed open: **the executor pipeline itself, from SQL text to actual rows.** This part completes it.

SQL is declarative — it says only "**what**," never "how." For the string `SELECT * FROM users WHERE id = 1` to become real heap rows, three stages are needed:

```
SQL text → [lexer] → tokens → [parser] → AST → [executor] → rows
```

It's the front end of a compiler, borrowed wholesale — every DB's frontend looks like this.

## 1. The Lexer — Characters to Tokens

**Stage 1: the tokenizer (lexer).** `SELECT * FROM users WHERE id = 1` → `[SELECT] [*] [FROM] [IDENT:users] [WHERE] [IDENT:id] [=] [INT:1]`. It skips whitespace, groups character runs, peels `'...'` strings — plus one subtle rule:

```c
/* comparison operators: look two characters ahead first */
if (c == '<' && nx == '=') { ...; t.type = TOK_LE; }   /* <= */
if (c == '<' && nx == '>') { ...; t.type = TOK_NE; }   /* SQL's <> */
if (c == '<')              { ...; t.type = TOK_LT; }   /* plain < */
```

> **Maximal munch**: on seeing `<=`, taking just `<` leaves the `=` to fall off separately and wrongly. A lexer "grabs the longest possible token first" (longest match) — the rule nearly every lexer follows.

Keywords vs identifiers are also decided here — after reading a whole run, look it up in a reserved-word table (case-insensitive): `users` is an `IDENT`, `FROM` is a keyword token.

> **Practical/interview point — why reserved words exist**: since `SELECT` becomes a keyword token, using bare `select` as a column name confuses the parser. Hence reserved words — escapable with quoting: PostgreSQL `"select"`, MySQL backticks, SQL Server `[select]`. Real DBs also keep non-reserved keywords that are allowed bare.

## 2. The Recursive-Descent Parser — One Grammar Rule = One Function

**Stage 2: the parser** assembles tokens into a tree (AST). The charm of recursive descent is that **each grammar rule becomes one function** — the parser reads almost like English:

```c
static void parse_select_stmt(Parser *p, SelectStmt *s) {
    parse_select_list(p, s);               /* * or column/aggregate list */
    p_expect(p, TOK_FROM, "FROM required");
    parse_name(p, s->table);
    if (p_accept(p, TOK_WHERE))  parse_where(p, &s->where);
    if (p_accept(p, TOK_GROUP))  { /* GROUP BY ... */ }
    if (p_accept(p, TOK_ORDER))  { /* ORDER BY ... */ }
}
```

Three tools carry the whole parser — `p_accept` (consume if present; optional grammar), `p_expect` (error if absent; mandatory grammar), `p_advance` (pull the next token).

![SQL text → tokens → AST](/uploads/project/db-hobby/sql-to-ast.svg)

Two points are worth learning:

- **Precedence = call structure.** WHERE parses as `term (OR term)*` with each term `cond (AND cond)*` — AND being the inner function makes `a AND b OR c` naturally `(a AND b) OR c`. Operator precedence expressed not as a table but as **call nesting.**
- **On subqueries, the parser calls itself.** Meeting `WHERE id IN (SELECT ...)`, the condition parser invokes `parse_select_stmt` again — a recursive grammar demands a recursive parser. That's the name "recursive descent" (and the AST's `Condition` holds a self-referential `SelectStmt*`).

### Hand-Written vs Parser Generators

| | Hand-written recursive descent | Parser generator (yacc/bison) |
|---|---|---|
| Grammar definition | directly as functions (code = grammar) | separate `.y` grammar file |
| Error messages | fully controlled (position, context) | easily stuck with defaults |
| Debugging | just follow the functions | must read the generated state machine |
| Large grammars, complex precedence | functions multiply | shines (automatic) |
| Adopters | GCC/Clang; SQLite (its own generator, **Lemon**) | **MySQL (bison), PostgreSQL (bison)** |

PostgreSQL and MySQL use bison (an LALR generator); SQLite uses its own Lemon. Hand-written parsers dominate the compiler world (GCC/Clang) for error-message and debugging control — and for learning, "the code is the grammar" wins outright.

## 3. The Executor — Where Streaming and Materializing Split

**Stage 3: AST to heap operations.** The big picture is the **Volcano/iterator model** (Goetz Graefe, 1994 — ancestor of PostgreSQL's executor): an operator tree that rows flow through. The mini DB simplifies it to callback (visit) style, but one essential distinction shows through intact:

> **If one row decides, stream; if many rows are needed, materialize.** `WHERE` passes or drops on a single row — stream it. But `COUNT(*)` needs the group's last row, and `ORDER BY` needs everything — collect (materialize) first. This distinction governs memory usage and time-to-first-row.

It has already done work across the series — it's why [Part 8](/blog/project/db-hobby/db-internals-08-parallel)'s parallelization treated streaming SELECTs and aggregates with different strategies, and why the aggregate's materialization cap became a silent bug.

## 4. The Three Joins — Every Join Starts as a Double Loop

Joins begin as the **nested-loop join (NLJ)** — sweep the outer table row by row and, per row, scan the entire inner table for `ON`-matching pairs. A double loop.

> **Key fact**: every join algorithm starts from the nested loop. It's the most honest expression of "find the matching pairs" — **index, hash, and sort-merge are all just ways to make the inner loop faster.**

- **Index NLJ** — if the inner join key has an index, replace the inner scan with a **point lookup** per outer row. O(N×M) → O(N×log M).
- **Hash join** — sweep the inner side once building a `join key → rows` hash (build), sweep the outer side probing it (probe). O(N×M) → **O(N+M)**, no index needed. **Equality joins only** (hashes have no order).
- **Sort-merge join** — sort both sides by the join key and zip through them. The mini DB skipped it — more sorting infrastructure, little to show at our scale (an honest omission).

| | NLJ | Index NLJ | Hash join | Sort-merge |
|---|---|---|---|---|
| Complexity | O(N×M) | O(N×log M) | **O(N+M)** | O(sort+N+M) |
| Join condition | any | equality (index key) | **equality only** | equality, ranges |
| Preparation | none | an index | hash build (memory) | both sides sorted |
| Shines when | one side tiny | OLTP (indexed inner) | both large, unsorted (OLAP) | pre-sorted, or hash exceeds memory |

The mini DB picks per join level — "inner PK is the key → index NLJ; other equality → hash; else scan" — which [Part 6](/blog/project/db-hobby/db-internals-06-optimizer)'s cost model refines. PostgreSQL weighs all three by cost (does the hash fit `work_mem`? which side is already sorted?).

**LEFT JOIN and the arrival of NULL** — INNER emits only matched pairs; LEFT keeps unmatched left rows, filling the right side with **NULL.** The implementation is one flag — "did this outer row match?" — and this NULL-filling is **orthogonal** to the method choice (index/hash/scan), a design virtue: the two never entangle.

## 5. Aggregation — Why GROUP BY Demands Sorting (or Hashing)

If `WHERE` filters rows and joins connect them, `GROUP BY` + aggregates **fold many rows into one** — the first non-row-to-row operation. A group's `COUNT` requires seeing the whole group, so **rows of the same group must be adjacent** for a run-based accumulator. Two roads:

- **Sort-based (GroupAggregate)** — sorting by the group key makes equal keys contiguous. The mini DB's way, and PostgreSQL's GroupAggregate (which streams when input arrives pre-sorted).
- **Hash-based (HashAggregate)** — a `group key → accumulator` hash in one pass. No sort, but memory per group. PostgreSQL chooses between the two by cost.

`HAVING` is **the WHERE of groups** — WHERE filters individual rows *before* grouping; HAVING filters groups *after* aggregation (`HAVING COUNT(*) > 2`). Timing is the entire difference.

## 6. Extending WHERE — What's Free and What Isn't

Each new feature asked "does this need new code?" — and the split itself is the lesson.

**BETWEEN — zero executor lines (syntactic sugar).** The parser expands `col BETWEEN a AND b` into `(col >= a) AND (col <= b)` on the spot — the executor never knows it handles BETWEEN. (PostgreSQL keeps a BETWEEN node in the parse tree and transforms later — where to expand is an implementation choice.) `IN (v1, v2, ...)` is the same grain — set membership.

**LIKE — a genuinely new operator.** The wildcards `%` (0+ chars) and `_` (exactly one) reduce to no existing comparison. Three ways to build the matcher:

| Method | Time | Space | Problem |
|---|---|---|---|
| Recursion | worst-case exponential | stack depth | call explosion with many `%` |
| DP table | O(n·m) | O(n·m) | memory = product of lengths |
| **Backtracking two-pointer** | ~O(n) average | **O(1)** | wobbles on adversarial patterns |

```c
static int like_match(const char *s, const char *pat) {
    const char *star = NULL, *ss = NULL;
    while (*s) {
        if (*pat == '%')      { star = pat++; ss = s; }      /* remember %, assume 0 chars */
        else if (*pat == '_' || *pat == *s) { pat++; s++; }  /* one char matches */
        else if (star) { pat = star + 1; s = ++ss; }         /* stuck -> % eats one more */
        else return 0;
    }
    while (*pat == '%') pat++;
    return *pat == '\0';
}
```

Two pointers plus "last `%` position" — an O(1)-space matcher.

> **Practical/interview point — why LIKE '%x%' is slow**: an index is a **sorted** structure, so only prefix-anchored patterns like `'kim%'` can jump to "the start of a sorted range." A leading `%` leaves no start point — full scan. Not a mini-DB limitation but **the essence of B-tree indexes.** For infix search, change the index itself: PostgreSQL's trigrams (pg_trgm — index 3-character shreds) or a search engine's inverted index (Lucene/Elasticsearch).

**Subqueries — uncorrelated ones run once.** The inner query of `IN (SELECT uid FROM orders)` is independent of outer rows, so run it **once before** the outer scan, cache the value set, and test membership per row. Re-running per row is O(rows×subquery); caching is O(rows) — the uncorrelated/correlated distinction is where real optimizers' subquery unnesting begins. It's also why [Part 8](/blog/project/db-hobby/db-internals-08-parallel) gated subquery WHEREs out of parallelization — the predicate re-enters the executor.

## 7. The Semantics of NULL — Three-Valued Logic

[Part 1](/blog/project/db-hobby/db-internals-01-storage) covered NULL's **storage** (the bitmap); here we close its **meaning.** SQL comparisons aren't true/false but **three-valued** — TRUE / FALSE / **UNKNOWN.**

> **Key rules**: NULL is not "no value" but **"unknown."** Comparing with the unknown yields the unknown — `NULL = NULL` is **UNKNOWN**, not TRUE (how would you know two unknowns are equal?). And **WHERE passes only TRUE** — UNKNOWN filters out like FALSE.

Every practical trap derives from those two lines:

- `WHERE col = NULL` returns **no rows** (all UNKNOWN). Test NULL with the dedicated `IS NULL` / `IS NOT NULL`.
- **The `NOT IN` + NULL trap**: `x NOT IN (1, NULL)` is `x != 1 AND x != NULL`; the latter is UNKNOWN, so the whole is at best UNKNOWN — **it can never be TRUE, and the result set empties.** One NULL in a subquery annihilates `NOT IN` — a famous outage pattern.
- **Aggregates skip NULLs**: `COUNT(*)` counts rows (NULLs included); `COUNT(col)`/`SUM`/`AVG` count only non-NULLs — `AVG`'s denominator too. That distinction is why [Part 8's partial aggregation](/blog/project/db-hobby/db-internals-08-parallel) kept two accumulators.
- **NULL's place in ORDER BY**: since it can't compare, its position must be **decreed.** PostgreSQL defaults to NULLS LAST (for ASC), configurable — the mini DB matches.

## 8. Wrap-up — the Series' Executor Axis, Complete

- **The pipeline**: lexer (maximal munch, reserved words) → recursive-descent parser (grammar=functions, precedence=call structure, subquery=self-recursion) → executor (streaming vs materializing).
- **Three joins**: all variants of the nested loop — index turns the inner side into lookups, hash reaches O(N+M) (equality only), sort-merge for pre-sorted inputs. LEFT JOIN's NULL-fill is orthogonal to method choice.
- **Aggregation**: folding requires adjacency — sort-based (GroupAggregate) vs hash-based (HashAggregate). HAVING = the WHERE of groups.
- **Free vs real**: BETWEEN/IN(list) are parser sugar (zero executor lines); LIKE is a real operator (O(1)-space backtracking matcher). `'%x%'` being slow is B-tree essence — escape via trigrams or inverted indexes.
- **Three-valued logic**: NULL means "unknown," WHERE passes only TRUE — the `NOT IN`+NULL annihilation, `COUNT(*) vs COUNT(col)`, and NULLS LAST all derive from it.

With this, the series is truly complete — from storage ([①](/blog/project/db-hobby/db-internals-01-storage)) to the executor (⑪), every axis the mini DB has.

## References (primary sources first)

- Goetz Graefe, *Volcano — An Extensible and Parallel Query Evaluation System* (IEEE TKDE, 1994)
- [PostgreSQL Documentation: The Parser Stage](https://www.postgresql.org/docs/current/parser-stage.html)
- [PostgreSQL Documentation: Pattern Matching](https://www.postgresql.org/docs/current/functions-matching.html)
- [SQLite: The Lemon LALR(1) Parser Generator](https://sqlite.org/lemon.html)
- [PostgreSQL Documentation: Executor](https://www.postgresql.org/docs/current/executor.html)
- This blog: [DB Index ①: Reading EXPLAIN](/blog/theory/db-index-01-explain-basics)
- [db-hobby source (GitHub)](https://github.com/dj258255/db-hobby) — `sql.c` (lexer/parser) · `db.c` (executor/joins/aggregates)

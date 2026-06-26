---
title: 'WHERE를 더 채우다 — BETWEEN·LIKE·IN과 와일드카드 매칭은 어떻게 구현되는가'
titleEn: 'Filling Out WHERE — How Are BETWEEN, LIKE, IN, and Wildcard Matching Implemented?'
description: "관계형 DB를 C로 밑바닥부터 만든 minidb 시리즈 6편. WHERE에 BETWEEN·LIKE·IN을 더하며 '새 기능에 항상 새 코드가 필요한가'를 묻습니다 — BETWEEN은 실행기를 한 줄도 안 건드리고 파서에서 >= AND <= 로 푸는 문법 설탕(desugaring), LIKE는 %·_ 와일드카드를 백트래킹 two-pointer로 직접 매칭하는 진짜 새 연산자, IN 값 목록은 기존 멤버십 머신의 입력만 파서에서 채우기. 그리고 왜 LIKE '%키워드%'가 실무에서 인덱스를 못 타 느린지, PostgreSQL은 트라이그램(pg_trgm)으로 어떻게 푸는지를 LIKE 패턴별 인덱스 사용 표로 비교합니다."
descriptionEn: "Part 6 of minidb, a relational database built from scratch in C. Adding BETWEEN, LIKE, and IN to WHERE we ask 'does a new feature always need new code?' — BETWEEN is syntactic sugar desugared in the parser into >= AND <= (zero executor changes), LIKE is a real new operator with a backtracking two-pointer wildcard matcher, and the IN value list just refills the input of the existing membership machine. Plus why LIKE '%term%' can't use an index and is slow in practice, and how PostgreSQL solves it with trigrams (pg_trgm), compared in a per-pattern index-usability table."
date: 2026-05-28
tags:
  - C
  - Database Internals
  - SQL
  - Parser
  - PostgreSQL
  - Learning
category: project/minidb
coverImage: /uploads/project/minidb/cover.svg
draft: false
series: "minidb"
seriesOrder: 6
---

## 0. 들어가며 — 새 기능에 항상 새 코드가 필요할까

[5편](/blog/project/minidb/minidb-5-join-aggregate)으로 "저장·SQL·인덱스·트랜잭션·조인"까지 한 바퀴를 돌고 나니, 정작 일상적으로 제일 많이 쓰는 `WHERE` 연산자 두 개가 비어 있었어요 — `BETWEEN`과 `LIKE`. 그래서 채웠는데, 둘을 같이 붙이고 보니 재밌는 대비가 생겼습니다. **하나는 실행기를 한 줄도 안 건드리고 끝났고, 하나는 새 알고리즘이 필요했어요.**

그 차이가 이 편의 전부예요. 이번 편은 새 계층을 짓는 1~5편과 달리, 이미 만든 엔진 위에 기능 몇 개를 얹으며 **"좋은 시스템이 어떻게 새 코드로 증식하지 않고 확장되는가"** 를 보는 에필로그예요. 그 렌즈가 **"기능을 받으면 먼저 이게 기존 것의 조합으로 표현되나?를 묻는 습관"** 이고, BETWEEN·LIKE·IN 세 기능으로 따라가 봅니다.

> **이번 편의 질문**: 새 SQL 연산자를 더할 때, 실행기까지 새 코드를 짜야 하는가, 아니면 있는 걸 다시 쓰면 되는가? BETWEEN(설탕), IN 값 목록(입력 재활용), LIKE(진짜 새 알고리즘) — 셋이 각각 다른 답을 줍니다.

세 기능을 한 표로 미리 늘어놓으면 이렇습니다.

| 기능 | 전략 | 실행기 변경 | 새 코드 |
|---|---|---|---|
| **BETWEEN** | desugaring (파서에서 `>= AND <=`로 환원) | 0줄 | 없음 |
| **IN (값 목록)** | 기존 멤버십 머신의 입력만 파서가 채움 | 0줄 | 없음 |
| **LIKE** | 와일드카드 매처 (백트래킹 two-pointer) | 새 연산자 | 매칭 알고리즘 |

## 1. BETWEEN — 실행기를 0줄 건드린 이유

`id BETWEEN 2 AND 5`를 어떻게 구현할까요? 처음엔 당연히 실행기에 새 비교 연산자 `CMP_BETWEEN`을 만들고, 셀 하나에 "두 값 사이인가"를 판정하는 분기를 추가하는 그림을 그렸어요. 그런데 한 발 물러서서 보면 `BETWEEN a AND b`는 사실 **새로운 의미가 전혀 없습니다.** 그냥 `id >= a AND id <= b`예요. 양끝을 포함하는(inclusive) 두 비교의 AND일 뿐이죠.

> **정의 — 문법 설탕(syntactic sugar)**: 핵심 문법으로 환원되는, 편의를 위한 표기. 그걸 더 단순한 핵심 문법으로 펴는 과정을 desugaring이라 한다. `BETWEEN`은 두 비교의 AND로 환원되는 전형적인 설탕이다.

그래서 실행기 대신 **파서에서 풀어버렸어요(desugaring).** `BETWEEN`을 만나면 토큰을 읽어서 조건 두 개를 만들어 같은 AND 묶음에 넣습니다.

```c
} else if (p_accept(p, TOK_BETWEEN)) {
    /* col BETWEEN a AND b 는 문법 설탕 - (col >= a) AND (col <= b)로 푼다. */
    c->op = CMP_GE;
    parse_value(p, &c->val);                 /* 첫 조건: col >= a */
    p_expect(p, TOK_AND, "BETWEEN <값> 다음에 AND가 필요합니다");
    g->count++;
    Condition *c2 = &g->conds[g->count];     /* 둘째 조건: col <= b */
    snprintf(c2->tbl, SQL_NAME_LEN, "%s", c->tbl);
    snprintf(c2->col, SQL_NAME_LEN, "%s", c->col);
    c2->op = CMP_LE;
    parse_value(p, &c2->val);
}
```

이러면 [2편에서 만든 파서](/blog/project/minidb/minidb-2-sql-engine)가 뱉는 AST는 `id BETWEEN 2 AND 5`나 `id >= 2 AND id <= 5`나 **완전히 똑같아요.** 실행기, WHERE 평가, DNF 처리 — 그 아래 전부가 BETWEEN이라는 단어를 영영 모른 채로 동작합니다. (정확히는 위처럼 파서엔 분기를 더했지만, **WHERE 실행 경로는 한 줄도 안 바뀌었다**는 뜻이에요.) 새 코드 경로가 0개라는 건 곧 새 버그 가능성도 0개라는 뜻이고요.

이게 제가 즉흥적으로 떠올린 잔재주가 아니라, 진짜 컴파일러·DB가 쓰는 정석입니다. SQL 표준도 `BETWEEN`을 두 비교로 정의하고, 실제 옵티마이저들도 내부에서 `>= AND <=`로 변환해 처리해요. 핵심 연산자 집합을 작게 유지하면, 편의 문법이 아무리 늘어도 엔진은 안 무거워집니다.

desugaring 전후를 비교하면 핵심이 분명해져요.

| | desugaring 방식 (minidb 선택) | 새 연산자 `CMP_BETWEEN` 방식 |
|---|---|---|
| 어디서 처리 | 파서 한 곳 | 파서 + 실행기 + WHERE 평가 + DNF |
| 새 코드 경로 | 0개 | 비교 분기, NULL 처리, 출력 등 여러 개 |
| 새 버그 가능성 | 0개 | 새 경로마다 존재 |
| 핵심 연산자 수 | 그대로 유지 | 하나 늘어남 |

> **주의 — 공짜엔 솔직한 한계 하나**: minidb의 인덱스 경로는 ["조건이 딱 하나일 때"만](/blog/project/minidb/minidb-3-index-wal) 발동하는데, BETWEEN은 조건 두 개로 풀리고 minidb 플래너는 그 둘을 다시 하나의 범위 조건으로 묶지 못해서 풀 스캔으로 떨어진다. 즉 BETWEEN이 원래 인덱스를 못 타는 게 아니라, minidb 플래너가 범위로 인식하지 못해서다 — 결과는 정확하지만 인덱스 가속은 못 받는다.

진짜 DB라면 B+Tree 리프에서 `a`로 점프해 `b`까지 훑는 **인덱스 범위 스캔(index range scan)** 으로 양쪽 경계를 한 번에 쓰지만, 우리 범위 스캔은 경계를 한쪽만 받게 짜여 있어서 거기까진 안 갔어요. 학습용으론 "desugaring으로 기능을 공짜로 얻었다"는 사실이 더 중요했습니다.

## 2. LIKE — 이건 진짜 새 연산자였다

`LIKE`는 사정이 달라요. `name LIKE 'kim%'`의 `%`(임의 길이)·`_`(한 글자) 같은 와일드카드는 `>=`, `=` 어떤 기존 비교로도 풀리지 않습니다. 패턴을 글자 단위로 맞춰보는 **매칭 알고리즘**이 새로 필요해요. BETWEEN이 "기존 것의 조합"이었다면, LIKE는 그게 안 되는 첫 기능입니다.

먼저 정한 것 하나: LIKE는 정규식이 아니에요. SQL의 `LIKE`는 와일드카드가 딱 두 개(`%`, `_`)뿐인, 정규식보다 훨씬 제한된 패턴 매칭입니다(쉘 glob와도 완전히 같진 않아요 — glob엔 `*`·`?`·`[]`가 있죠). 정규식 엔진을 통째로 들고 오는 건 학습용 DB엔 과하고, SQL 표준 의미와도 안 맞아요.

> **정의 — SQL LIKE**: PostgreSQL 문서는 LIKE를 "패턴을 와일드카드 구간과 비(非)와일드카드 구간으로 나눠, 입력 문자열을 그렇게 쪼갤 수 있으면 매칭"이라고 정의한다. 와일드카드는 `%`(0글자 이상)와 `_`(정확히 한 글자) 둘뿐 — 딱 그만큼만 구현하면 된다.

### 2.1 매처를 어떻게 짤까 — 세 갈래 길

가장 곧은 길은 **재귀**예요 — "`%`를 만나면 0글자부터 끝까지 다 시도해보고 하나라도 되면 참". 깔끔하지만 패턴에 `%`가 여러 개면 호출이 지수적으로 터질 수 있고, 입력이 길면 스택도 깊어집니다. 또 하나는 **동적 계획법(DP) 테이블** — `dp[i][j] = 입력 i까지와 패턴 j까지가 매칭되나`. 확실하지만 입력·패턴 길이의 곱만큼 메모리를 써요. 셋을 비교하면:

| 방식 | 시간 | 공간 | 문제점 |
|---|---|---|---|
| 재귀 | 최악 지수적 | 스택 깊이 | `%` 여러 개면 호출 폭발 |
| DP 테이블 | O(n·m) | O(n·m) | 길이 곱만큼 메모리 |
| **백트래킹 two-pointer** (minidb 선택) | 평균 ~O(n), 최악 O(n·m) | **O(1)** | 인위적 최악 패턴에서 출렁임 |

저는 셋째 길인 **백트래킹 two-pointer**로 갔어요. 재귀도 DP 테이블도 없이, 포인터 두 개와 "마지막 `%` 위치"만 기억하면 됩니다.

```c
/* '%' = 임의 길이(0+), '_' = 정확히 한 글자. 그 외는 그대로 일치. */
static int like_match(const char *s, const char *pat) {
    const char *star = NULL, *ss = NULL;
    while (*s) {
        if (*pat == '%') {
            star = pat++;   /* '%' 위치 기억, 일단 0글자 먹은 걸로 보고 패턴만 전진 */
            ss = s;
        } else if (*pat == '_' || *pat == *s) {
            pat++;          /* 한 글자 일치 - 둘 다 전진 */
            s++;
        } else if (star) {
            pat = star + 1; /* 막혔다 -> 마지막 '%'가 한 글자 더 먹은 셈 치고 재시도 */
            s = ++ss;
        } else {
            return 0;       /* '%'도 없는데 안 맞음 -> 실패 */
        }
    }
    while (*pat == '%') pat++;   /* 남은 패턴이 전부 '%'면 빈 문자열에 매칭 */
    return *pat == '\0';
}
```

### 2.2 핵심 아이디어 — `%`에 대한 낙관적 추측과 후회

`%`를 만나면 일단 "0글자를 먹었다"고 가정하고 패턴만 한 칸 전진해요(`star`에 위치를, `ss`에 그때의 입력 위치를 적어둡니다). 그러다 뒤에서 글자가 안 맞아 막히면, 마지막 `%`로 되돌아가 "아 그 `%`가 한 글자 더 먹었어야 했구나" 하고 `ss`를 한 칸 밀어 다시 시도합니다. `%`가 조금씩 더 먹어가며 backtrack하는 거예요.

`name LIKE '%a%'`로 `park`를 맞추는 흐름을 따라가 보면:

![LIKE '%a%' 가 'park' 와 매칭 — 가운데 a는 직접 일치, 앞 %는 'p'를·뒤 %는 'rk'를 흡수(0+글자)](/uploads/project/minidb/like-wildcard-match.svg)

이 방식은 재귀 없이 공간 O(1)이고, 시간은 현실 패턴에선 평균적으로 거의 선형(O(n))에 가까워요 — 다만 `%`가 잔뜩 박힌 인위적 최악 패턴에선 백트래킹이 반복돼 O(n·m)까지 출렁입니다. 위키피디아 "Matching wildcards" 항목이나 여러 글롭 구현이 정확히 이 골격을 쓰는데, 현실의 패턴에선 단순 반복문이 NFA 같은 정교한 방식보다 대체로 빨라요. 학습용으로도, 실용으로도 합리적인 타협점이었습니다.

참고로 SQL의 `ESCAPE` 절(`LIKE '100\%' ESCAPE '\'`로 `%`를 글자 그대로 찾기)은 뺐어요. 의미는 알지만 매처에 상태가 하나 더 붙어서, 와일드카드 매칭의 본질을 가리기만 한다고 봤습니다. 대소문자는 구분해요 — minidb의 TEXT 비교가 `strcmp` 기반이라, `LIKE`도 자연히 대소문자를 구분하게 두는 게 일관됐습니다(PostgreSQL의 `LIKE`도 기본 대소문자 구분, 무시하려면 `ILIKE`).

## 3. LIKE는 왜 실무에서 느린가 — 그리고 진짜 DB는 어떻게 푸나

minidb의 `LIKE`는 풀 스캔이에요. 모든 행을 꺼내 `like_match`를 돌립니다. 그런데 이건 학습용의 한계가 아니라 — **`LIKE '%키워드%'`는 진짜 DB에서도 B-tree 인덱스를 못 써요.** 이게 백엔드에서 자주 데이는 지점입니다(B-tree 얘기예요 — 트라이그램·FULLTEXT 같은 다른 인덱스는 가능한데, 곧 봅니다).

이유는 [B+Tree 인덱스](/blog/project/minidb/minidb-3-index-wal)의 본질에 있어요. 인덱스는 값을 **정렬해** 놓은 구조입니다. `name LIKE 'kim%'`처럼 **앞이 고정된** 패턴이면, 정렬된 트리에서 `kim`으로 시작하는 구간의 시작점으로 바로 점프해 그 구간만 훑으면 돼요 — 인덱스가 멋지게 동작합니다. 하지만 `LIKE '%kim'`이나 `LIKE '%kim%'`처럼 **앞이 `%`로 열려 있으면**, 시작점을 특정할 수가 없어요. "kim으로 끝나는 모든 단어"는 정렬 순서상 사방에 흩어져 있으니까요.

> **실무/면접 포인트 — 왜 LIKE '%x%'가 느린가**: 인덱스는 값을 정렬한 구조라, 앞이 고정된 패턴만 "정렬된 구간의 시작점"으로 점프할 수 있다. 앞이 `%`로 열린 패턴은 시작점을 특정할 수 없어 풀 스캔으로 떨어진다. 첫 와일드카드 앞의 고정 접두사가 길고 선택적일수록 스캔 범위가 줄어든다 — 바꿔 말해 접두사가 없으면 줄일 게 없다.

패턴별로 인덱스를 탈 수 있는지 표로 정리하면 분명해져요.

| LIKE 패턴 | 앞부분 | B+Tree 인덱스 | 이유 |
|---|---|---|---|
| `'kim%'` | 고정 접두사 | 사용 가능 (범위 스캔) | `kim` 구간 시작점으로 점프 |
| `'k_m%'` | 고정 접두사 `k` | 부분 사용 | `k` 구간으로 좁힌 뒤 매칭 |
| `'%kim'` | `%`로 열림 | 불가 -> 풀 스캔 | 시작점 특정 불가 |
| `'%kim%'` | `%`로 열림 | 불가 -> 풀 스캔 | 같은 이유, 중간 일치 |

그럼 "본문에 키워드 포함" 같은 중간 일치 검색은 어떻게 할까요. 진짜 DB는 인덱스 자체를 바꿉니다. PostgreSQL은 **트라이그램 인덱스(pg_trgm)** 를 써요 — 문자열을 세 글자 조각으로 쪼개(`"Hello"` -> `"Hel"`,`"ell"`,`"llo"`) 그 조각들을 인덱싱하면, `%ell%` 같은 중간 검색도 조각 매칭으로 가속할 수 있습니다. 더 나아가면 아예 검색 엔진(Lucene, Elasticsearch)의 역색인으로 가요.

| | minidb | PostgreSQL B-Tree | PostgreSQL pg_trgm (GIN) | Lucene/ES |
|---|---|---|---|---|
| `'kim%'` | 풀 스캔 | 범위 스캔 | 가속 | 가속 |
| `'%kim%'` | 풀 스캔 | 풀 스캔 | **가속(트라이그램)** | **가속(역색인)** |
| 구현 비용 | `like_match` 한 줄 | 기본 인덱스 | 확장 설치 | 별도 엔진 |

> **주의**: minidb가 `LIKE`를 풀 스캔으로 둔 건 게을러서가 아니라, 앞이 열린 패턴은 정렬 인덱스로 가속할 방법이 원리적으로 없기 때문이다. 가속하려면 트라이그램·역색인처럼 인덱스의 종류 자체를 바꿔야 한다.

사실 저는 이걸 머리가 아니라 몸으로 배웠어요. [WikiEngine](/blog/project/WikiEngine/lucene-decision)에서 1,215만 건에 `LIKE '%검색어%'`를 날렸다가 [5초 만에 타임아웃](/blog/project/WikiEngine/fulltext-ngram-index)이 나고, 커넥션 풀이 마르며 검색과 무관한 API까지 503으로 무너졌습니다. EXPLAIN을 찍으니 `type=ALL`, 약 2,700만 행을 스캔하는 계획이었어요(조인까지 포함한 실행 계획이라 원본 1,215만 행보다 추정 스캔 행이 더 불었습니다). 결국 MySQL FULLTEXT ngram을 거쳐 임베디드 Lucene으로 갈아엎었습니다.

minidb에서 `LIKE`를 풀 스캔으로 구현하며 "왜 이게 느릴 수밖에 없는지"를 코드 레벨에서 다시 보니, 그때 그 타임아웃의 정체가 비로소 깔끔하게 설명됐어요. 인덱스가 정렬 구조라서 앞이 열린 패턴엔 손쓸 수 없다는 그 한 가지 사실 때문이었습니다.

> 더 깊이: [DB 인덱스 ①: 인덱스 기초와 EXPLAIN 읽기](/blog/theory/db-index-01-explain-basics)와 [② 스캔의 종류와 옵티마이저의 선택](/blog/theory/db-index-02-scan-types) — 왜 어떤 조건은 인덱스를 타고 어떤 건 풀 스캔으로 떨어지는지, 옵티마이저의 판단을 실제 DB로.

## 4. 한 번 더 공짜 — IN (값 목록)

BETWEEN을 쓰고 나서 `IN (1, 3, 5)` 같은 값 목록도 채웠는데, 이게 또 비슷한 이야기였어요. minidb엔 이미 `IN (SELECT ...)` 서브쿼리가 있었습니다. 그게 동작하는 방식은 "서브쿼리를 한 번 돌려 값 집합(`in_set`)을 만들어 두고, 바깥 행이 그 집합에 들었는지 멤버십만 검사"하는 거였어요. 그렇다면 `IN (1, 3, 5)`는? 서브쿼리가 만들어 주던 그 `in_set`을, 파서가 파싱하면서 직접 채워 넣으면 끝입니다.

```c
if (p->cur.type == TOK_SELECT) {   /* IN (SELECT ...) — 기존 서브쿼리 경로 */
    ...
} else {                            /* IN (v1, v2, ...) — 값 목록을 바로 in_set에 채운다 */
    do { parse_value(p, &set[n++]); } while (p_accept(p, TOK_COMMA));
    c->in_sub = 1;        /* 멤버십 머신 재사용 */
    c->in_set = set;      /* 서브쿼리 대신 파서가 채운 값 집합 */
}
```

멤버십을 검사하는 실행기 코드도, 메모리를 정리하는 코드도, 인덱스 플래너도 한 줄을 안 고쳤어요. 실행 직전에 서브쿼리를 미리 계산해 두는 **prepare 단계** 가, 서브쿼리가 없으면(`sub`가 NULL이면) 자연히 아무 일도 안 하도록 이미 짜여 있었기 때문입니다.

> **핵심 사실 — 같은 발상, 다른 방향**: BETWEEN이 "기존 문법으로 환원"이었다면, IN 값 목록은 "기존 실행 경로(멤버십)의 입력을 다른 데서 채우기"였다. 하나는 출력을 줄이고(파서가 두 비교로 펴서 실행기는 모름), 하나는 입력을 바꾼다(실행기는 그대로, 집합을 누가 채우는지만 다름). 방향만 다를 뿐 "실행기는 안 건드린다"는 결과는 같다.

## 5. 정리

세 기능을 붙이며 배운 건 결국 **"새 기능에 항상 새 코드가 필요한 건 아니다"** 였어요. 0절의 표를 다시 보면 셋의 전략이 한눈에 들어옵니다.

- **BETWEEN** — 기존 문법으로 환원되는 설탕이라 파서에서 풀어 실행기를 0줄 건드림. 대신 조건 두 개로 풀려 단일 조건 인덱스 경로는 못 탐.
- **IN (값 목록)** — 기존 멤버십 머신의 입력만 파서에서 채워 역시 실행기를 안 건드림. `sub`가 NULL이라 prepare가 알아서 건너뜀.
- **LIKE** — 셋 중 유일하게 진짜 새 코드. 와일드카드 매칭은 어떤 기존 비교로도 환원되지 않으니까. 백트래킹 two-pointer로 O(n·m)·O(1)에 풀되, `%`로 열린 패턴은 정렬 인덱스로 가속 불가라는 실무 한계까지 코드로 확인.

세 기능을 더했지만 **새로 생긴 실행 경로는 LIKE 하나뿐**이었어요 — BETWEEN은 기존 문법으로 환원했고, IN은 기존 실행기를 재사용했으니까요. 기능을 받으면 먼저 "이게 기존 것의 조합으로 표현되나?"를 묻는 습관 — 이게 이 셋을 붙이며 굳어진 가장 실용적인 교훈이에요(여기까지 더해 minidb의 테스트는 223개가 됐습니다). 작은 습관 하나가 코드의 크기보다 더 오래 남았습니다.

## 참고

- [PostgreSQL Documentation: Pattern Matching (LIKE / SIMILAR TO)](https://www.postgresql.org/docs/current/functions-matching.html)
- [PostgreSQL Documentation: pg_trgm (trigram matching)](https://www.postgresql.org/docs/current/pgtrgm.html)
- [Wikipedia: Matching wildcards](https://en.wikipedia.org/wiki/Matching_wildcards)
- 본 블로그: [DB 인덱스 ①: 인덱스 기초와 EXPLAIN 읽기](/blog/theory/db-index-01-explain-basics) · [② 스캔의 종류와 옵티마이저의 선택](/blog/theory/db-index-02-scan-types) · [WikiEngine: LIKE에서 Lucene으로](/blog/project/WikiEngine/lucene-decision) · [WikiEngine: FULLTEXT ngram 인덱스](/blog/project/WikiEngine/fulltext-ngram-index)
- minidb 시리즈: [2편 SQL 엔진](/blog/project/minidb/minidb-2-sql-engine) · [3편 인덱스·WAL](/blog/project/minidb/minidb-3-index-wal) · [5편 조인·집계](/blog/project/minidb/minidb-5-join-aggregate)
- [minidb 코드 (GitHub)](https://github.com/dj258255/db-hobby)

<!-- EN -->

## 0. Introduction — Does a New Feature Always Need New Code?

After [Part 5](/blog/project/minidb/minidb-5-join-aggregate) completed a full loop — storage, SQL, indexes, transactions, joins — two of the most everyday `WHERE` operators were still missing: `BETWEEN` and `LIKE`. So I filled them in, and putting the two side by side produced an interesting contrast. **One was done without touching the executor by a single line; the other needed a new algorithm.**

That contrast is the whole of this part. Unlike Parts 1-5, which build a new layer each time, this one is an epilogue — laying a few features onto the engine already built and watching **how a good system grows by extension, not by multiplying code.** The lens is the habit: **when a feature lands, first ask "is this expressible as a combination of what already exists?"** — followed through three features (BETWEEN, LIKE, IN).

> **This part's question**: when adding a new SQL operator, must you write new executor code, or can you reuse what's there? BETWEEN (sugar), the IN value list (reused input), and LIKE (a genuinely new algorithm) each give a different answer.

Laying the three out in one table up front:

| Feature | Strategy | Executor change | New code |
|---|---|---|---|
| **BETWEEN** | desugaring (parser rewrites to `>= AND <=`) | 0 lines | none |
| **IN (value list)** | parser just fills the existing membership machine's input | 0 lines | none |
| **LIKE** | wildcard matcher (backtracking two-pointer) | new operator | matching algorithm |

## 1. BETWEEN — Why the Executor Wasn't Touched

How do you implement `id BETWEEN 2 AND 5`? At first I naturally sketched adding a new comparison operator `CMP_BETWEEN` to the executor, plus a branch that decides "is this cell between two values?". But step back and `BETWEEN a AND b` carries **no new meaning at all.** It is just `id >= a AND id <= b` — the AND of two inclusive comparisons.

> **Definition — syntactic sugar**: a convenience notation that reduces to core grammar. The process of unfolding it into simpler core grammar is called desugaring. `BETWEEN` is a textbook sugar that reduces to the AND of two comparisons.

So instead of the executor, I unfolded it **in the parser (desugaring).** On hitting `BETWEEN`, it reads tokens, builds two conditions, and puts them in the same AND group.

```c
} else if (p_accept(p, TOK_BETWEEN)) {
    /* col BETWEEN a AND b is syntactic sugar - unfold to (col >= a) AND (col <= b). */
    c->op = CMP_GE;
    parse_value(p, &c->val);                 /* first cond: col >= a */
    p_expect(p, TOK_AND, "AND required after BETWEEN <value>");
    g->count++;
    Condition *c2 = &g->conds[g->count];     /* second cond: col <= b */
    snprintf(c2->tbl, SQL_NAME_LEN, "%s", c->tbl);
    snprintf(c2->col, SQL_NAME_LEN, "%s", c->col);
    c2->op = CMP_LE;
    parse_value(p, &c2->val);
}
```

Now the AST emitted by [the parser from Part 2](/blog/project/minidb/minidb-2-sql-engine) is **identical** for `id BETWEEN 2 AND 5` and `id >= 2 AND id <= 5`. The executor, WHERE evaluation, DNF handling — everything below runs forever unaware of the word BETWEEN. (Precisely: the parser did gain the branch above, but the **WHERE execution path didn't change by a line**.) Zero new code paths means zero new bug surface.

This is not an ad-hoc trick I improvised; it is the standard real compilers and DBs use. The SQL standard defines `BETWEEN` as two comparisons, and real optimizers internally rewrite it to `>= AND <=`. Keep the core operator set small and the engine stays light no matter how much convenience grammar piles on.

Comparing before/after desugaring makes the point clear:

| | desugaring (minidb's choice) | new operator `CMP_BETWEEN` |
|---|---|---|
| Where handled | parser only | parser + executor + WHERE eval + DNF |
| New code paths | 0 | comparison branch, NULL handling, output, ... |
| New bug surface | 0 | one per new path |
| Core operator count | unchanged | grows by one |

> **Caution — one honest limit on the free lunch**: minidb's index path fires [only when there is exactly one condition](/blog/project/minidb/minidb-3-index-wal), but BETWEEN unfolds into two, and minidb's planner does not re-merge them into a single range condition, so it falls to a full scan. That is — BETWEEN is not inherently un-indexable; minidb's planner just does not recognize it as a range. The result is correct but gets no index speedup.

A real DB would use both bounds at once with an **index range scan** — jump to `a` in the B+Tree leaf and sweep to `b` — but our range scan was written to take only one bound, so I didn't go that far. For learning, the fact that "desugaring got the feature for free" mattered more.

## 2. LIKE — This One Was a Real New Operator

`LIKE` is a different story. The wildcards in `name LIKE 'kim%'` — `%` (any length), `_` (one char) — reduce to no existing comparison like `>=` or `=`. You need a new **matching algorithm** that checks the pattern character by character. Where BETWEEN was "a combination of what exists," LIKE is the first feature where that fails.

One decision up front: LIKE is not regex. SQL's `LIKE` is a much more limited pattern match with exactly two wildcards (`%`, `_`) — not even quite a shell glob (which has `*`, `?`, `[]`). Dragging in a whole regex engine is overkill for a learning DB and doesn't match SQL standard semantics.

> **Definition — SQL LIKE**: the PostgreSQL docs define LIKE as "split the pattern into wildcard and non-wildcard segments; if the input string can be partitioned that way, it matches." The only wildcards are `%` (zero or more chars) and `_` (exactly one) — implement just that much.

### 2.1 How to Write the Matcher — Three Roads

The straightest road is **recursion** — "on `%`, try eating 0 chars through all chars; true if any works." Clean, but with several `%` the calls can blow up exponentially, and long inputs deepen the stack. Another is a **dynamic-programming (DP) table** — `dp[i][j] = does input up to i match pattern up to j`. Reliable, but uses memory proportional to the product of the lengths. Comparing the three:

| Approach | Time | Space | Problem |
|---|---|---|---|
| Recursion | worst-case exponential | stack depth | call explosion with multiple `%` |
| DP table | O(n·m) | O(n·m) | memory ~ product of lengths |
| **Backtracking two-pointer** (minidb's choice) | avg ~O(n), worst O(n·m) | **O(1)** | wobbles on artificial worst-case patterns |

I went with the third road, the **backtracking two-pointer**. No recursion, no DP table — just two pointers and "the last `%` position."

```c
/* '%' = any length (0+), '_' = exactly one char. Anything else matches literally. */
static int like_match(const char *s, const char *pat) {
    const char *star = NULL, *ss = NULL;
    while (*s) {
        if (*pat == '%') {
            star = pat++;   /* remember '%' pos; assume it ate 0 chars, advance pattern only */
            ss = s;
        } else if (*pat == '_' || *pat == *s) {
            pat++;          /* one char matches - advance both */
            s++;
        } else if (star) {
            pat = star + 1; /* stuck -> pretend the last '%' ate one more char, retry */
            s = ++ss;
        } else {
            return 0;       /* mismatch with no '%' -> fail */
        }
    }
    while (*pat == '%') pat++;   /* trailing '%' matches the empty string */
    return *pat == '\0';
}
```

### 2.2 The Core Idea — Optimistic Guess and Regret About `%`

On hitting `%`, assume "it ate 0 chars" and advance the pattern by one (recording the position in `star` and the input position at that moment in `ss`). If a later character fails to match and we get stuck, return to the last `%`, decide "ah, that `%` should have eaten one more char," nudge `ss` forward by one, and retry. The `%` eats a little more each time as it backtracks.

Tracing `name LIKE '%a%'` against `park`:

![LIKE '%a%' matching 'park' — the middle 'a' matches directly, the leading % absorbs 'p' and the trailing % absorbs 'rk' (0+ chars)](/uploads/project/minidb/like-wildcard-match.svg)

This runs in O(1) space, no recursion, and in time it is on average near-linear (O(n)) on real-world patterns — only on artificial worst cases (patterns crammed with `%`) does the backtracking repeat up to O(n·m). Wikipedia's "Matching wildcards" entry and many glob implementations use exactly this skeleton, and on real-world patterns a plain loop is generally faster than fancier NFA-style approaches. A reasonable compromise for both learning and practice.

For the record, I dropped SQL's `ESCAPE` clause (`LIKE '100\%' ESCAPE '\'` to find a literal `%`). I know what it means, but it adds one more state to the matcher and only obscures the essence of wildcard matching. Case is significant — since minidb's TEXT comparison is `strcmp`-based, letting `LIKE` be case-sensitive too was consistent (PostgreSQL's `LIKE` is also case-sensitive by default; use `ILIKE` to ignore case).

## 3. Why LIKE Is Slow in Practice — and How Real DBs Solve It

minidb's `LIKE` is a full scan. It pulls every row and runs `like_match`. But this is not a learning-DB limitation — **`LIKE '%term%'` can't use a B-tree index in real DBs either.** This is a common burn on the backend (it is a B-tree thing — other indexes like trigram or FULLTEXT can, as we will see).

The reason lies in the nature of [the B+Tree index](/blog/project/minidb/minidb-3-index-wal). An index is a structure that keeps values **sorted**. For a pattern **fixed at the front** like `name LIKE 'kim%'`, you jump straight to the start of the `kim`-prefixed range in the sorted tree and sweep only that range — the index works beautifully. But if the front is **open with `%`** like `LIKE '%kim'` or `LIKE '%kim%'`, you can't pin down a start point. "All words ending in kim" are scattered everywhere in sort order.

> **Practical/interview note — why LIKE '%x%' is slow**: an index is a sorted structure, so only a front-anchored pattern can jump to "the start of a sorted range." A pattern open at the front has no determinable start and falls to a full scan. The longer and more selective the fixed prefix before the first wildcard, the smaller the scan range — conversely, no prefix means nothing to narrow.

A per-pattern index-usability table makes it clear:

| LIKE pattern | Front | B+Tree index | Why |
|---|---|---|---|
| `'kim%'` | fixed prefix | usable (range scan) | jump to start of `kim` range |
| `'k_m%'` | fixed prefix `k` | partial | narrow to `k` range, then match |
| `'%kim'` | open with `%` | no -> full scan | no determinable start |
| `'%kim%'` | open with `%` | no -> full scan | same reason, infix match |

So how do you do an infix search like "contains a keyword in the body"? Real DBs change the index itself. PostgreSQL uses a **trigram index (pg_trgm)** — it splits strings into three-character chunks (`"Hello"` -> `"Hel"`,`"ell"`,`"llo"`) and indexes the chunks, so an infix search like `%ell%` can be accelerated by chunk matching. Push further and you reach the inverted index of a search engine (Lucene, Elasticsearch).

| | minidb | PostgreSQL B-Tree | PostgreSQL pg_trgm (GIN) | Lucene/ES |
|---|---|---|---|---|
| `'kim%'` | full scan | range scan | accelerated | accelerated |
| `'%kim%'` | full scan | full scan | **accelerated (trigram)** | **accelerated (inverted)** |
| Implementation cost | one `like_match` | built-in index | install extension | separate engine |

> **Caution**: minidb leaves `LIKE` as a full scan not out of laziness, but because a front-open pattern is *in principle* impossible to accelerate with a sorted index. To accelerate it you must change the *kind* of index — trigram, inverted.

I actually learned this with my body, not my head. In [WikiEngine](/blog/project/WikiEngine/lucene-decision) I fired `LIKE '%query%'` at 12.15M rows, got a [5-second timeout](/blog/project/WikiEngine/fulltext-ngram-index), drained the connection pool, and even search-unrelated APIs collapsed into 503s. EXPLAIN showed `type=ALL`, a plan scanning about 27M rows (a join-inclusive plan, so the estimated scanned rows ballooned past the 12.15M base rows). I ended up rebuilding through MySQL FULLTEXT ngram and then embedded Lucene.

Implementing `LIKE` as a full scan in minidb and seeing "why this has to be slow" at the code level, that timeout finally explained itself cleanly. It was due to that single fact — an index is a sorted structure, so a front-open pattern is beyond its reach.

> Deeper: [DB Index ①: Index Basics and Reading EXPLAIN](/blog/theory/db-index-01-explain-basics) and [② Scan Types and the Optimizer's Choice](/blog/theory/db-index-02-scan-types) — why some conditions ride an index and others fall to a full scan, the optimizer's judgment in a real DB.

## 4. Free Once More — IN (Value List)

After BETWEEN I also filled in value lists like `IN (1, 3, 5)`, and this was a similar story. minidb already had the `IN (SELECT ...)` subquery. It worked by "running the subquery once to build a value set (`in_set`), then checking only membership of the outer row in that set." So `IN (1, 3, 5)`? Just have the parser fill that same `in_set` directly while parsing, and you're done.

```c
if (p->cur.type == TOK_SELECT) {   /* IN (SELECT ...) — existing subquery path */
    ...
} else {                            /* IN (v1, v2, ...) — fill in_set directly with the value list */
    do { parse_value(p, &set[n++]); } while (p_accept(p, TOK_COMMA));
    c->in_sub = 1;        /* reuse the membership machine */
    c->in_set = set;      /* value set filled by the parser instead of a subquery */
}
```

Not a line changed in the executor code that checks membership, the code that frees memory, or the index planner. Because the **prepare step** that pre-computes the subquery right before execution was already written so that, with no subquery (`sub` is NULL), it naturally does nothing.

> **Key fact — same idea, different direction**: where BETWEEN was "reduce to existing grammar," the IN value list was "fill the input of an existing execution path (membership) from somewhere else." One reduces the output (the parser unfolds into two comparisons; the executor never knows), the other swaps the input (the executor is untouched; only who fills the set differs). Only the direction differs — the outcome, "don't touch the executor," is the same.

## 5. Wrap-up

What I learned adding these three was, in the end, that **"a new feature does not always need new code."** Looking back at the section-0 table, the three strategies snap into view:

- **BETWEEN** — sugar that reduces to existing grammar, unfolded in the parser, executor untouched (0 lines). The cost: it unfolds into two conditions, so it can't ride the single-condition index path.
- **IN (value list)** — only the existing membership machine's input is filled by the parser; the executor is untouched. With `sub` NULL, prepare skips it on its own.
- **LIKE** — the only one of the three that truly needed new code, since wildcard matching reduces to no existing comparison. Solved in O(n·m)/O(1) with a backtracking two-pointer, down to confirming in code the practical limit that front-open patterns can't be accelerated by a sorted index.

Three features added, but **only one new execution path was born — LIKE** — since BETWEEN reduced to existing grammar and IN reused the existing executor. The habit of asking, when a feature lands, "is this expressible as a combination of what exists?" is the most practical lesson that set in while adding these three (with them, minidb's tests reached 223). One small habit outlasted the size of the code.

## References

- [PostgreSQL Documentation: Pattern Matching (LIKE / SIMILAR TO)](https://www.postgresql.org/docs/current/functions-matching.html)
- [PostgreSQL Documentation: pg_trgm (trigram matching)](https://www.postgresql.org/docs/current/pgtrgm.html)
- [Wikipedia: Matching wildcards](https://en.wikipedia.org/wiki/Matching_wildcards)
- This blog: [DB Index ①: Index Basics and Reading EXPLAIN](/blog/theory/db-index-01-explain-basics) · [② Scan Types and the Optimizer's Choice](/blog/theory/db-index-02-scan-types) · [WikiEngine: From LIKE to Lucene](/blog/project/WikiEngine/lucene-decision) · [WikiEngine: FULLTEXT ngram Index](/blog/project/WikiEngine/fulltext-ngram-index)
- minidb series: [Part 2 SQL Engine](/blog/project/minidb/minidb-2-sql-engine) · [Part 3 Index·WAL](/blog/project/minidb/minidb-3-index-wal) · [Part 5 Join·Aggregate](/blog/project/minidb/minidb-5-join-aggregate)
- [minidb on GitHub](https://github.com/dj258255/db-hobby)

---
title: 'SQL을 더 채우다: BETWEEN과 LIKE, 그리고 와일드카드 매칭'
titleEn: 'Filling Out the SQL: BETWEEN, LIKE, and Wildcard Matching'
description: "관계형 DB를 C로 밑바닥부터 만든 minidb 시리즈 부록. WHERE에 BETWEEN과 LIKE를 더하면서 두 가지 다른 구현 전략을 본다 - BETWEEN은 실행기를 한 줄도 안 건드리고 파서에서 >= AND <= 로 푸는 문법 설탕(desugaring), LIKE는 %·_ 와일드카드를 백트래킹 two-pointer 매처로 직접 매칭하는 새 연산자. 그리고 왜 LIKE '%키워드%'가 실무에서 느린지, 진짜 DB는 prefix 인덱스·트라이그램으로 어떻게 푸는지까지."
descriptionEn: "An addendum to the minidb series. Adding BETWEEN and LIKE to WHERE shows two different implementation strategies: BETWEEN is desugared in the parser into >= AND <= (zero executor changes), while LIKE is a real new operator with a backtracking two-pointer wildcard matcher. Plus why LIKE '%term%' is slow in practice and how real databases use prefix indexes and trigrams."
date: 2026-06-08
tags:
  - C
  - Database Internals
  - SQL
  - Parser
  - Learning
category: project/minidb
coverImage: /uploads/project/minidb/cover.svg
draft: false
series: "minidb"
seriesOrder: 6
---

[5편](/blog/project/minidb/minidb-5-join-aggregate)으로 "저장·SQL·인덱스·트랜잭션·조인"까지 한 바퀴를 돌고 나니, 정작 일상적으로 제일 많이 쓰는 `WHERE` 연산자 두 개가 비어 있었다 - `BETWEEN`과 `LIKE`.
그래서 채웠는데, 둘을 같이 붙이고 보니 재밌는 대비가 생겼다.
**하나는 실행기를 한 줄도 안 건드리고 끝났고, 하나는 새 알고리즘이 필요했다.** 그 차이가 이 글의 전부다.

## BETWEEN - 실행기를 0줄 건드린 이유

`id BETWEEN 2 AND 5`를 어떻게 구현할까? 처음엔 당연히 실행기에 새 비교 연산자 `CMP_BETWEEN`을 만들고, 셀 하나에 "두 값 사이인가"를 판정하는 분기를 추가하는 그림을 그렸다.
그런데 한 발 물러서서 보면 `BETWEEN a AND b`는 사실 새로운 의미가 전혀 없다.
그냥 `id >= a AND id <= b`다.
양끝을 포함하는(inclusive) 두 비교의 AND일 뿐.

그래서 실행기 대신 **파서에서 풀어버렸다(desugaring).** `BETWEEN`을 만나면 토큰을 읽어서 조건 두 개를 만들어 같은 AND 묶음에 넣는다.

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

이러면 [2편에서 만든 파서](/blog/project/minidb/minidb-2-sql-engine)가 뱉는 AST는 `id BETWEEN 2 AND 5`나 `id >= 2 AND id <= 5`나 **완전히 똑같다.** 실행기, WHERE 평가, DNF 처리 - 그 아래 전부가 BETWEEN이라는 단어를 영영 모른 채로 동작한다.
새 코드 경로가 0개라는 건 곧 새 버그 가능성도 0개라는 뜻이다.

이게 내가 즉흥적으로 떠올린 잔재주가 아니라, 진짜 컴파일러·DB가 쓰는 정석이다.
이런 걸 **문법 설탕(syntactic sugar)** 이라 하고, 그걸 더 단순한 핵심 문법으로 펴는 과정을 desugaring이라 부른다.
SQL 표준도 `BETWEEN`을 두 비교로 정의하고, 실제 옵티마이저들도 내부에서 `>= AND <=`로 변환해 처리한다.
핵심 연산자 집합을 작게 유지하면, 편의 문법이 아무리 늘어도 엔진은 안 무거워진다.

대신 솔직한 한계가 하나 따라온다.
minidb의 인덱스 경로는 ["조건이 딱 하나일 때"만](/blog/project/minidb/minidb-3-index-wal) 발동하는데, BETWEEN은 조건 두 개로 풀리니 그 경로를 안 타고 풀 스캔으로 떨어진다.
결과는 정확하지만 인덱스 가속은 못 받는다.
진짜 DB라면 B+Tree 리프에서 `a`로 점프해 `b`까지 훑는 **인덱스 범위 스캔**으로 양쪽 경계를 한 번에 쓰지만, 우리 범위 스캔은 경계를 한쪽만 받게 짜여 있어서 거기까진 안 갔다.
학습용으론 "desugaring으로 기능을 공짜로 얻었다"는 사실이 더 중요했다.

## LIKE - 이건 진짜 새 연산자였다

`LIKE`는 사정이 다르다.
`name LIKE 'kim%'`의 `%`(임의 길이)·`_`(한 글자) 같은 와일드카드는 `>=`, `=` 어떤 기존 비교로도 풀리지 않는다.
패턴을 글자 단위로 맞춰보는 **매칭 알고리즘**이 새로 필요하다.

먼저 정한 것: LIKE는 정규식이 아니다.
SQL의 `LIKE`는 와일드카드가 딱 두 개(`%`, `_`)뿐인 축소판 글롭(glob)이다.
정규식 엔진을 통째로 들고 오는 건 학습용 DB엔 과하고, SQL 표준 의미와도 안 맞는다.
PostgreSQL 문서도 LIKE를 "패턴을 와일드카드 구간과 비(非)와일드카드 구간으로 나눠, 입력 문자열을 그렇게 쪼갤 수 있으면 매칭"이라고 정의한다 - 딱 그만큼만 구현하면 된다.

### 매처를 어떻게 짤까

가장 곧은 길은 재귀다 - "`%`를 만나면 0글자부터 끝까지 다 시도해보고 하나라도 되면 참".
깔끔하지만 패턴에 `%`가 여러 개면 호출이 지수적으로 터질 수 있고, 입력이 길면 스택도 깊어진다.
또 하나는 동적 계획법(DP) 테이블 - `dp[i][j] = 입력 i까지와 패턴 j까지가 매칭되나`.
확실하지만 입력·패턴 길이의 곱만큼 메모리를 쓴다.

나는 셋째 길인 **백트래킹 two-pointer**로 갔다.
재귀도 DP 테이블도 없이, 포인터 두 개와 "마지막 `%` 위치"만 기억하면 된다.

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

핵심 아이디어는 **`%`에 대한 낙관적 추측과 후회**다.
`%`를 만나면 일단 "0글자를 먹었다"고 가정하고 패턴만 한 칸 전진한다(`star`에 위치를, `ss`에 그때의 입력 위치를 적어둔다).
그러다 뒤에서 글자가 안 맞아 막히면, 마지막 `%`로 되돌아가 "아 그 `%`가 한 글자 더 먹었어야 했구나" 하고 `ss`를 한 칸 밀어 다시 시도한다.
`%`가 조금씩 더 먹어가며 backtrack하는 것이다.

`name LIKE '%a%'`로 `park`를 맞추는 흐름을 따라가 보면:

```
패턴 %a%  입력 park
  % 만남 -> star=%, ss=p, 패턴은 'a'로 전진 (0글자 가정)
  'a' vs 'p' 불일치, star 있음 -> ss를 a로 밀고 재시도
  'a' vs 'a' 일치! 둘 다 전진
  % 만남 -> 남은 입력(rk) 다 흡수
  입력 끝, 남은 패턴 % 건너뛰면 끝 -> 매칭
```

이 방식은 재귀 없이 시간 O(n·m), 공간 O(1)이다.
위키피디아 "Matching wildcards" 항목이나 여러 글롭 구현이 정확히 이 골격을 쓴다 - 인위적인 최악 케이스(`%`가 잔뜩 박힌 패턴)에선 백트래킹이 출렁이지만, 현실의 패턴에선 단순 반복문이 NFA 같은 정교한 방식보다 대체로 빠르다.
학습용으로도, 실용으로도 합리적인 타협점이었다.

참고로 SQL의 `ESCAPE` 절(`LIKE '100\%' ESCAPE '\'`로 `%`를 글자 그대로 찾기)은 뺐다.
의미는 알지만 매처에 상태가 하나 더 붙어서, 와일드카드 매칭의 본질을 가리기만 한다고 봤다.
대소문자는 구분한다 - minidb의 TEXT 비교가 `strcmp` 기반이라, `LIKE`도 자연히 대소문자를 구분하게 두는 게 일관됐다(PostgreSQL의 `LIKE`도 기본 대소문자 구분, 무시하려면 `ILIKE`).

## LIKE는 왜 실무에서 느린가 - 그리고 진짜 DB는 어떻게 푸나

minidb의 `LIKE`는 풀 스캔이다.
모든 행을 꺼내 `like_match`를 돌린다.
그런데 이건 학습용의 한계가 아니라 - **`LIKE '%키워드%'`는 진짜 DB에서도 인덱스를 못 쓴다.** 이게 백엔드에서 자주 데이는 지점이다.

이유는 [B+Tree 인덱스](/blog/project/minidb/minidb-3-index-wal)의 본질에 있다.
인덱스는 값을 **정렬해** 놓은 구조다.
`name LIKE 'kim%'`처럼 **앞이 고정된** 패턴이면, 정렬된 트리에서 `kim`으로 시작하는 구간의 시작점으로 바로 점프해 그 구간만 훑으면 된다 - 인덱스가 멋지게 동작한다.
하지만 `LIKE '%kim'`이나 `LIKE '%kim%'`처럼 **앞이 `%`로 열려 있으면**, 시작점을 특정할 수가 없다.
"kim으로 끝나는 모든 단어"는 정렬 순서상 사방에 흩어져 있으니까.
그래서 풀 스캔으로 떨어진다.
첫 와일드카드 앞의 고정 접두사가 길고 선택적일수록 스캔 범위가 줄어든다 - 바꿔 말해 접두사가 없으면 줄일 게 없다.

그럼 "본문에 키워드 포함" 같은 중간 일치 검색은 어떻게 하나.
진짜 DB는 인덱스 자체를 바꾼다.
PostgreSQL은 **트라이그램 인덱스(pg_trgm)** 를 쓴다 - 문자열을 세 글자 조각으로 쪼개("Hello" -> "Hel","ell","llo") 그 조각들을 인덱싱하면, `%ell%` 같은 중간 검색도 조각 매칭으로 가속할 수 있다.
더 나아가면 아예 검색 엔진(Lucene, Elasticsearch)의 역색인으로 간다.

사실 나는 이걸 머리가 아니라 몸으로 배웠다.
[WikiEngine](/blog/project/WikiEngine/lucene-decision)에서 1,215만 건에 `LIKE '%검색어%'`를 날렸다가 [5초 만에 타임아웃](/blog/project/WikiEngine/fulltext-ngram-index)이 나고, 커넥션 풀이 마르며 검색과 무관한 API까지 503으로 무너졌다.
EXPLAIN을 찍으니 `type=ALL`, 2,700만 행 풀 스캔.
결국 MySQL FULLTEXT ngram을 거쳐 임베디드 Lucene으로 갈아엎었다.
minidb에서 `LIKE`를 풀 스캔으로 구현하며 "왜 이게 느릴 수밖에 없는지"를 코드 레벨에서 다시 보니, 그때 그 타임아웃의 정체가 비로소 깔끔하게 설명됐다.
인덱스가 정렬 구조라서 앞이 열린 패턴엔 손쓸 수 없다는 그 한 가지 사실 때문이었다.

> 더 깊이: [DB 인덱스 ①: 인덱스 기초와 EXPLAIN 읽기](/blog/theory/db-index-01-explain-basics)와 [② 스캔의 종류와 옵티마이저의 선택](/blog/theory/db-index-02-scan-types) - 왜 어떤 조건은 인덱스를 타고 어떤 건 풀 스캔으로 떨어지는지, 옵티마이저의 판단을 실제 DB로.

## 정리

두 연산자를 붙이며 배운 건 결국 **"새 기능에 항상 새 코드가 필요한 건 아니다"** 였다.
BETWEEN은 기존 문법으로 환원되는 설탕이라 파서에서 풀어 실행기를 0줄 건드렸고, LIKE는 환원이 안 되는 진짜 새 연산이라 매처를 짰다.
기능을 받으면 먼저 "이게 기존 것의 조합으로 표현되나?"를 묻는 습관 - 이게 desugaring이 가르쳐준 가장 실용적인 교훈이다.

여기까지 더해 minidb의 테스트는 218개가 됐다.
다음에 또 SQL을 채운다면 `IN (값 목록)`이나 `ORDER BY` 다중 키 같은, 역시 기존 것으로 환원되는지부터 따져볼 생각이다.

---
title: 'NULL을 저장하다: null 비트맵과 3값 논리'
titleEn: 'Storing NULL: The Null Bitmap and Three-Valued Logic'
description: "관계형 DB를 C로 밑바닥부터 만든 minidb 시리즈. 지금까지 NULL은 LEFT JOIN 결과에만 잠깐 나타났고 진짜 행엔 못 들어갔다. 이번엔 INSERT (1, NULL)을 실제로 저장한다. 핵심은 값이 없음을 바이트로 표시하는 null 비트맵 - 컬럼당 1비트를 행 앞에 붙이는 진짜 DB 행 포맷의 방식이다. 그리고 막상 저장만 뚫으니 비교·집계·정렬이 그대로 동작했다. 5편 LEFT JOIN 때 만든 NULL 처리가 이미 거기 있었으니까. 덤으로 3값 논리(NULL은 =로 안 잡힌다)와 NULLS LAST 정렬까지."
descriptionEn: "Part 9 of building a relational database from scratch in C. Until now NULL only appeared transiently in LEFT JOIN results and couldn't live in stored rows. This time we actually store INSERT (1, NULL). The key is a null bitmap - one bit per column at the front of each row, exactly how real DB row formats mark absence. And once storage was unblocked, comparison, aggregation, and sorting just worked, because the NULL handling built for LEFT JOIN in part 5 was already there. Plus three-valued logic (NULL isn't caught by =) and NULLS-LAST sorting."
date: 2026-06-18
tags:
  - C
  - Database Internals
  - SQL
  - NULL
  - Learning
category: project/minidb
coverImage: /uploads/project/minidb/cover.svg
draft: false
series: "minidb"
seriesOrder: 9
---

[5편](/blog/project/minidb/minidb-5-join-aggregate)에서 NULL이 처음 등장했지만, 그건 LEFT JOIN의 미매칭 오른쪽을 채우는 **임시** NULL이었다.
정작 `INSERT INTO t VALUES (1, NULL)`은 거부됐다 - 진짜 행엔 NULL을 못 담았으니까.
이번 편은 그걸 뚫는다.
별것 아닌 것 같은데, 막상 해 보니 "값이 없다"를 바이트로 어떻게 표시하느냐가 생각보다 까다로웠고, 동시에 예전에 깔아 둔 게 얼마나 많은 일을 대신 해 주는지도 봤다.

## "값이 없음"을 어떻게 바이트로 적나

[2편의 튜플 코덱](/blog/project/minidb/minidb-2-sql-engine)에서 `INT`는 4바이트, `TEXT`는 "길이 + 바이트"로 인코딩한다고 했다.
그런데 NULL은 어디에 적나?
처음 떠오른 건 특별한 값을 약속하는 것 - 예를 들어 정수 `-1`을 NULL로 치자.
바로 안 된다.
`-1`은 멀쩡한 정수 값이다.
TEXT도 마찬가지로 빈 문자열 `''`은 NULL이 아니라 "길이 0인 문자열"이라는 엄연히 다른 값이다.
즉 **데이터 안의 어떤 값으로도 NULL을 표현할 수 없다.**
NULL은 값이 아니라 "값이 없음"이라, 데이터 바깥에 따로 표시해야 한다.

그래서 진짜 DB가 쓰는 방법이 **null 비트맵(null bitmap)** 이다.
행 맨 앞에 컬럼 수만큼의 비트를 두고, i번째 비트가 1이면 "i번째 컬럼은 NULL"이라는 뜻이다.
NULL인 컬럼은 비트만 켜고 값 바이트는 아예 안 쓴다(공간도 아낀다).
PostgreSQL도 InnoDB도 행 헤더에 이 null 비트맵을 둔다.

minidb의 인코딩은 이렇게 바뀌었다.

```c
/* 행 맨 앞에 null 비트맵: 컬럼당 1비트(1이면 NULL) */
int nbits = (schema->num_columns + 7) / 8;   // 컬럼 8개당 1바이트
memset(buf, 0, nbits);
uint16_t off = nbits;                          // 값들은 비트맵 뒤부터
for (int i = 0; i < schema->num_columns; i++) {
    const Value *v = &vals[i];
    if (v->type == VAL_NULL) {
        buf[i / 8] |= (1 << (i % 8));          // 비트만 켜고
        continue;                              // 값 바이트는 안 쓴다
    }
    /* (아니면 기존대로 INT 4바이트 / TEXT 길이+바이트로 기록) */
}
```

디코딩은 거꾸로다.
먼저 행 앞 비트맵을 읽어, 켜진 비트의 컬럼은 `VAL_NULL`로 두고 값 바이트를 건너뛴다.
비트맵을 **맨 앞**에 두는 게 중요하다 - 값을 읽기 전에 "이 컬럼이 NULL인지"를 먼저 알아야 그 자리에서 4바이트를 읽을지 0바이트를 건너뛸지 정할 수 있으니까.

## 저장만 뚫으니 나머지는 이미 돌아갔다

여기서 재밌는 일이 있었다.
null 비트맵으로 저장·복원을 만들고 나니, **그 외엔 거의 고칠 게 없었다.**

`WHERE name IS NULL`도, `COUNT(*)`와 `COUNT(name)`의 차이도, NULL이 섞인 `ORDER BY`도 전부 그냥 동작했다.
이유는 [5편](/blog/project/minidb/minidb-5-join-aggregate) 덕분이다.
그때 LEFT JOIN의 임시 NULL을 처리하려고 비교 함수(`NULL은 어떤 것과도 같지 않다`), 집계(`COUNT(col)`·`SUM`·`AVG`는 NULL을 건너뛴다), 정렬 비교기까지 전부 `VAL_NULL`을 아는 코드로 만들어 뒀다.
그 NULL이 "조인이 만든 것"이든 "디스크에서 읽은 것"이든 코드 입장에선 똑같은 `VAL_NULL`이다.
그래서 저장이라는 **입구** 하나만 열어 주니, 그 뒤 파이프라인은 손 안 대고 통째로 재사용됐다.

이게 계층을 잘 끊어 두면 받는 보상이다.
NULL의 "의미"(비교·집계 규칙)와 NULL의 "저장"(바이트 표현)을 따로 만들어 뒀더니, 한쪽을 나중에 채워도 다른 쪽이 안 흔들렸다.

## NULL은 거짓이 아니라 "모름"이다 - 3값 논리

NULL을 저장하고 나니 SQL에서 제일 헷갈리는 주제를 직접 마주하게 됐다 - **3값 논리(three-valued logic)**.

보통 조건은 참 아니면 거짓이다.
그런데 NULL이 끼면 세 번째 값, **모름(unknown)** 이 생긴다.
`name = 'kim'`인데 `name`이 NULL이면?
"이름이 없는 사람의 이름이 kim인가"는 참도 거짓도 아닌 "모름"이다.
SQL은 모름을 거짓처럼 취급해 그 행을 결과에서 뺀다.
그래서 이런 일이 벌어진다.

```
SELECT * FROM nt WHERE name = 'kim';      -- NULL인 행: 안 나옴
SELECT * FROM nt WHERE name != 'kim';     -- NULL인 행: 이것도 안 나옴 (!)
```

`=`로도 `!=`로도 NULL 행이 안 잡힌다.
둘 다 "모름"이라 거짓 처리되니까.
이게 흔히 데이는 지점이다 - "kim이 아닌 사람"을 뽑으려고 `!= 'kim'`을 썼는데 정작 이름이 빈 사람이 쏙 빠진다.
그래서 NULL을 잡는 **유일한** 방법이 따로 있다 - `IS NULL` / `IS NOT NULL`.
`=`는 NULL에 영영 참이 안 되니, NULL을 검사하려면 전용 연산자가 필요한 것이다.

같은 이유로 집계도 NULL을 특별 취급한다.

```
SELECT COUNT(*), COUNT(v), SUM(v) FROM na;   -- v가 (10, NULL)일 때
2 | 1 | 10
```

`COUNT(*)`는 **행**을 세니 2, `COUNT(v)`는 **NULL 아닌 값**을 세니 1, `SUM(v)`도 NULL을 빼고 더해 10이다.
"평균을 낼 때 값이 없는 행은 분모에서도 빠진다"는 게 이 규칙에서 나온다.

정렬에선 NULL을 어디에 둘지를 정해야 한다.
minidb는 NULL을 가장 크게 쳐서 오름차순(ASC)에선 맨 뒤로 보낸다 - PostgreSQL의 기본값인 `NULLS LAST`와 같다.
(MySQL은 반대로 NULL을 가장 작게 쳐서 앞에 둔다. 표준이 정해주지 않아 DB마다 다른 부분이다.)

## PK는 NULL일 수 없다

딱 한 곳, NULL을 막아 둔 데가 있다 - **첫 컬럼(PK)** 이다.
minidb는 첫 컬럼을 유일 키로 보고 B+Tree 인덱스를 거는데([3편](/blog/project/minidb/minidb-3-index-wal)), 인덱스의 키가 NULL이면 "정렬된 트리에서 NULL을 어디에 꽂나"부터 막힌다.
그래서 `INSERT INTO t VALUES (NULL, 'x')`는 거부한다.
진짜 DB에서 기본 키가 항상 `NOT NULL`인 것과 같은 이유다.
반대로 PK가 아닌 컬럼은 전부 nullable로 뒀다 - 아직 `NOT NULL` 제약을 따로 거는 문법은 안 만들었으니, 그건 다음 숙제다.

## 덤: 만들다 보니 옛 글의 거짓말이 드러났다

이번에도 만들면서 기존 코드를 다시 보게 됐는데, 두 군데서 사실과 다른 서술을 찾았다.
정렬 비교 함수엔 "NULL은 가장 작게"라는 주석이 붙어 있었는데, 코드는 실제로 NULL을 가장 **크게** 치고 있었다(NULLS LAST).
README엔 "NULL은 저장 행에 들어가지 않는다"가 남아 있었다 - 이번 편으로 정확히 거짓이 된 문장이다.
둘 다 바로잡았다.
직접 만들고 재보는 일의 부수입은, 자꾸 내가 예전에 적어 둔 걸 의심하게 된다는 것이다.

## 닫으며

NULL 저장은 코드량으로 보면 작은 작업이었다 - 행 앞에 비트맵 한 줌.
하지만 그 작은 입구 하나가 5편에서 깔아 둔 NULL 파이프라인 전체를 깨웠고, 그 과정에서 SQL의 3값 논리를 손으로 만져 봤다.
"값이 없음"을 값으로 표현할 수 없어 데이터 바깥에 비트로 표시해야 한다는 것, 그래서 `=`로는 영영 NULL을 못 잡는다는 것 - 글로 읽을 땐 외우던 규칙이, 직접 비트맵을 깔고 나니 당연한 귀결로 보였다.

> **시리즈**: [1. 저장 계층](/blog/project/minidb/minidb-1-storage) · [2. SQL 엔진](/blog/project/minidb/minidb-2-sql-engine) · [3. 인덱스와 WAL](/blog/project/minidb/minidb-3-index-wal) · [4. 트랜잭션](/blog/project/minidb/minidb-4-transactions) · [5. 조인과 집계](/blog/project/minidb/minidb-5-join-aggregate) · [6. BETWEEN과 LIKE](/blog/project/minidb/minidb-6-between-like) · [7. 직접 재보기](/blog/project/minidb/minidb-7-benchmark) · [8. EXPLAIN](/blog/project/minidb/minidb-8-explain) · 9. NULL 저장 · [코드(GitHub)](https://github.com/dj258255/minidb)

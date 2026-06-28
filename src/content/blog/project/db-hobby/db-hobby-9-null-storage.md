---
title: 'NULL은 어떻게 저장되는가 — null 비트맵과 3값 논리'
titleEn: 'How Is NULL Stored? — The Null Bitmap and Three-Valued Logic'
description: "PostgreSQL·MySQL이 내부에서 어떻게 동작하는지 이해하려고 관계형 DB를 C로 밑바닥부터 만든 db-hobby 시리즈 9편. 지금까지 NULL은 LEFT JOIN 결과에만 잠깐 나타났고 진짜 행엔 못 들어갔어요. 이번엔 INSERT (1, NULL)을 실제로 저장합니다 — 핵심은 '값이 없음'을 바이트로 표시하는 null 비트맵(컬럼당 1비트를 행 앞에 붙이는 진짜 DB 행 포맷의 방식)입니다. 그리고 저장만 뚫으니 비교·집계·정렬이 그대로 동작했어요. 5편 LEFT JOIN 때 깔아 둔 NULL 처리가 이미 거기 있었으니까요. 3값 논리(=로도 !=로도 NULL이 안 잡힌다), NOT NULL 제약, NULLS LAST 정렬까지 PostgreSQL·InnoDB와 비교합니다."
descriptionEn: "Part 9 of db-hobby, a relational database built from scratch in C to understand how PostgreSQL and MySQL work inside. Until now NULL only appeared transiently in LEFT JOIN results and couldn't live in stored rows. This time we actually store INSERT (1, NULL) — the key is a null bitmap, one bit per column at the front of each row, exactly how real DB row formats mark absence. And once storage was unblocked, comparison, aggregation, and sorting just worked, because the NULL handling built for LEFT JOIN in Part 5 was already there. We cover three-valued logic (NULL isn't caught by = or !=), the NOT NULL constraint, and NULLS-LAST sorting, comparing with PostgreSQL and InnoDB."
date: 2026-06-07
tags:
  - C
  - Database Internals
  - SQL
  - "NULL"
  - Three-Valued Logic
  - PostgreSQL
  - InnoDB
  - Learning
category: project/db-hobby
coverImage: /uploads/project/db-hobby/cover.svg
draft: false
series: "db-hobby"
seriesOrder: 9
---

## 0. 들어가며 — "값이 없음"을 어떻게 저장하나

[5편](/blog/project/db-hobby/db-hobby-5-join-aggregate)에서 NULL이 처음 등장했어요. 하지만 그건 LEFT JOIN의 미매칭 오른쪽을 채우는 **임시** NULL이었습니다 — 조인 결과에만 잠깐 나타났다 사라지는 값이지, 디스크에 저장된 적은 없어요. 정작 `INSERT INTO t VALUES (1, NULL)`은 거부됐습니다. 진짜 행엔 NULL을 못 담았으니까요.

이번 편은 그걸 뚫습니다. 별것 아닌 것 같은데, 막상 해 보니 "값이 없다"를 바이트로 어떻게 표시하느냐가 생각보다 까다로웠고, 동시에 예전에 깔아 둔 게 얼마나 많은 일을 대신 해 주는지도 봤어요.

> **이번 편의 목표**: `INSERT (1, NULL)`을 실제로 저장한다. 핵심은 "값이 없음"을 데이터 바깥에 표시하는 **null 비트맵**. 그리고 저장이라는 입구 하나만 열면, 비교·집계·정렬·3값 논리가 어떻게 그 뒤를 따라오는지를 본다.

## 1. NULL은 데이터 안의 어떤 값으로도 표현할 수 없다

[2편의 튜플 코덱](/blog/project/db-hobby/db-hobby-2-sql-engine)에서 `INT`는 4바이트, `TEXT`는 "길이 + 바이트"로 인코딩한다고 했어요. 그런데 NULL은 어디에 적나요?

처음 떠오르는 건 **특별한 값을 약속**하는 겁니다 — 예를 들어 정수 `-1`을 NULL로 치자. 바로 막힙니다. `-1`은 멀쩡한 정수 값이에요. 누군가 진짜로 `-1`을 저장하려 하면 NULL과 구분이 안 됩니다. TEXT도 마찬가지예요. 빈 문자열 `''`은 NULL이 아니라 "길이 0인 문자열"이라는 엄연히 다른 값이고요.

> **핵심 사실**: NULL은 일반 데이터 값이 아니라 **"값이 없음"을 나타내는 특수 표지(marker)** 다. 타입도 갖고 컬럼에도 저장되지만, 일반 INT·TEXT 데이터 *그 자체* 로는 표현할 수 없으니 데이터 **바깥**에 따로 표시해야 한다. 이게 NULL을 저장하는 모든 어려움의 출발점이다.

그래서 진짜 DB가 쓰는 방법이 **null 비트맵(null bitmap)** 입니다. 행 맨 앞에 컬럼 수만큼의 비트를 두고, i번째 비트가 1이면 "i번째 컬럼은 NULL"이라는 뜻이에요. NULL인 컬럼은 비트만 켜고 값 바이트는 아예 안 씁니다(공간도 아낍니다). PostgreSQL도 InnoDB도 행 헤더에 이 null 비트맵을 둬요.

| | null 비트맵 (db-hobby) | PostgreSQL | InnoDB |
|---|---|---|---|
| 위치 | 행 헤더(MVCC) 뒤, 값 앞 | 튜플 헤더의 `t_bits` | 행 헤더(가변 부분) |
| 크기 | 컬럼당 1비트(컬럼 8개당 1바이트) | 컬럼당 1비트 | nullable 컬럼당 1비트 |
| NULL 컬럼의 값 바이트 | 아예 안 씀(공간 절약) | 아예 안 씀 | 아예 안 씀 |
| nullable 아닌 컬럼 | 비트는 두되 항상 0 | 모두 NOT NULL이면 비트맵 자체를 생략 | NOT NULL 컬럼은 비트맵에서 제외 |

세부는 달라도 대표적인 row-store DB(PostgreSQL·InnoDB)에선 발상이 똑같아요 — "어느 컬럼이 NULL인지"를 값 바이트가 아니라 **별도의 비트**로 적는다. (Oracle·SQL Server·SQLite는 행 포맷이 또 꽤 달라요.)

## 2. null 비트맵 — 행 앞에 비트 한 줌

db-hobby의 인코딩은 이렇게 바뀌었어요. 행 맨 앞 [MVCC 헤더](/blog/project/db-hobby/db-hobby-2-sql-engine)(xmin/xmax, 8바이트) 바로 뒤에 null 비트맵을 깔고, 그 뒤부터 값들을 적습니다.

```c
/* 행 = MVCC 헤더(8B) + null 비트맵 + 값들. 비트가 1이면 그 컬럼은 NULL */
int nbits = (schema->num_columns + 7) / 8;     // 컬럼 8개당 1바이트
memset(buf + MVCC_HDR, 0, (size_t)nbits);
uint16_t off = (uint16_t)(MVCC_HDR + nbits);   // 값들은 비트맵 뒤부터
for (int i = 0; i < schema->num_columns; i++) {
    const Value *v = &vals[i];
    if (v->type == VAL_NULL) {
        buf[MVCC_HDR + i / 8] |= (uint8_t)(1 << (i % 8)); // 비트만 켜고
        continue;                                          // 값 바이트는 안 쓴다
    }
    /* (아니면 기존대로 INT 4바이트 / TEXT 길이+바이트로 기록) */
}
```

`(num_columns + 7) / 8`은 "컬럼 수를 8로 나눠 올림"이에요 — 컬럼 8개까진 1바이트, 9개부턴 2바이트. 비트 연산 `buf[i/8] |= (1 << (i%8))`은 i번째 비트가 몇 번째 바이트의 몇 번째 자리인지를 계산해 그 비트만 켜는 표준 관용구입니다.

디코딩은 거꾸로예요. 먼저 행 앞 비트맵을 읽어, 켜진 비트의 컬럼은 `VAL_NULL`로 두고 값 바이트를 건너뜁니다.

```c
int nbits = (schema->num_columns + 7) / 8;
uint16_t off = (uint16_t)(MVCC_HDR + nbits);   // MVCC 헤더 + null 비트맵 건너뜀
for (int i = 0; i < schema->num_columns; i++) {
    if (rec[MVCC_HDR + i / 8] & (uint8_t)(1 << (i % 8))) { // null 비트가 켜졌으면
        out[i].type = VAL_NULL;
        continue;                                          // 값 바이트는 없다
    }
    /* (아니면 INT면 4바이트, TEXT면 길이+바이트를 읽는다) */
}
```

> **왜 비트맵을 맨 앞에 두나**: 값을 읽기 **전에** "이 컬럼이 NULL인지"를 먼저 알아야, 그 자리에서 4바이트(INT)를 읽을지 아니면 0바이트를 건너뛸지를 정할 수 있다. 비트맵이 값들 뒤에 있으면 닭이 먼저냐 달걀이 먼저냐가 된다 — 값을 다 읽어야 비트맵에 닿는데, 어디까지가 값인지를 알려면 비트맵이 필요하니까. 그래서 값을 순차로 읽는 db-hobby 같은 포맷에선 비트맵이 값보다 앞에 있어야 한다. (offset 배열이나 컬럼 디렉터리를 쓰는 포맷은 이 제약이 느슨해져요 — 진짜 요건은 "값을 해석하기 전에 NULL 여부를 알 수 있을 것"뿐이다.)

## 3. 저장만 뚫으니 나머지는 이미 돌아갔다

여기서 재밌는 일이 있었어요. null 비트맵으로 저장·복원을 만들고 나니, **그 외엔 거의 고칠 게 없었습니다.**

`WHERE name IS NULL`도, `COUNT(*)`와 `COUNT(name)`의 차이도, NULL이 섞인 `ORDER BY`도 전부 그냥 동작했어요. 이유는 [5편](/blog/project/db-hobby/db-hobby-5-join-aggregate) 덕분입니다. 그때 LEFT JOIN의 임시 NULL을 처리하려고 비교 함수(NULL은 어떤 것과도 같지 않다), 집계(`COUNT(col)`·`SUM`·`AVG`는 NULL을 건너뛴다), 정렬 비교기까지 전부 `VAL_NULL`을 아는 코드로 만들어 뒀거든요.

그 NULL이 "조인이 만든 것"이든 "디스크에서 읽은 것"이든 코드 입장에선 똑같은 `VAL_NULL`이에요. 그래서 저장이라는 **입구** 하나만 열어 주니, 그 뒤 파이프라인은 손 안 대고 통째로 재사용됐습니다(어디까지나 db-hobby가 구현한 기능 범위에서요 — 진짜 DB는 UNIQUE·DISTINCT·GROUP BY·조인 등식·인덱스마다 NULL 정책이 더 붙습니다).

> **설계 보상 — 계층을 잘 끊으면 받는 것**: NULL의 "의미"(비교·집계·정렬 규칙)와 NULL의 "저장"(바이트 표현)을 따로 만들어 뒀더니, 한쪽을 나중에 채워도 다른 쪽이 안 흔들렸다. 5편에서 의미를, 9편에서 저장을 채웠는데 둘이 깔끔하게 맞물렸다. "관심사 분리"가 추상적 구호가 아니라 실제로 일을 덜어 주는 걸 손으로 본 순간이다.

## 4. NULL은 거짓이 아니라 "모름"이다 — 3값 논리

NULL을 저장하고 나니 SQL에서 제일 헷갈리는 주제를 직접 마주하게 됐어요 — **3값 논리(three-valued logic)** 입니다.

보통 조건은 참 아니면 거짓이에요. 그런데 NULL이 끼면 세 번째 값, **모름(unknown)** 이 생깁니다.

> **3값 논리란**: NULL이 낀 비교의 결과는 참도 거짓도 아닌 **모름(unknown)** 이다. `name = 'kim'`인데 `name`이 NULL이면, "이름이 없는 사람의 이름이 kim인가"는 답할 수 없다 — 모름이다. 그리고 SQL `WHERE`는 **TRUE인 행만 통과**시키므로, FALSE도 UNKNOWN(모름)도 똑같이 탈락한다 — 즉 모름은 거짓처럼 결과에서 빠진다.

그래서 이런 일이 벌어져요.

```sql
SELECT * FROM nt WHERE name = 'kim';      -- name이 NULL인 행: 안 나옴
SELECT * FROM nt WHERE name != 'kim';     -- name이 NULL인 행: 이것도 안 나옴 (!)
```

`=`로도 `!=`로도 NULL 행이 안 잡혀요. 둘 다 "모름"이라 거짓 처리되니까요. db-hobby의 비교 함수가 이 규칙을 한 줄로 박아둡니다.

```c
static int values_equal(const Value *a, const Value *b) {
    if (a->type == VAL_NULL || b->type == VAL_NULL) {
        return 0; /* NULL은 무엇과도(NULL과도) 같지 않다 */
    }
    /* ... 같은 타입이면 값 비교 ... */
}
```

| 비교 | `name`이 NULL일 때 결과 | WHERE에서 그 행은 |
|---|---|---|
| `name = 'kim'` | unknown(모름) | 제외 |
| `name != 'kim'` | unknown(모름) | 제외 |
| `name = NULL` | unknown(모름) | 제외 |
| `name IS NULL` | **참** | 포함 |
| `name IS NOT NULL` | 거짓 | 제외 |

> **실무/면접 포인트 — 왜 `!=`로 NULL이 안 잡히나**: "kim이 아닌 사람"을 뽑으려고 `name != 'kim'`을 썼는데 정작 이름이 빈(NULL) 사람이 쏙 빠진다. `!=`도 NULL과 비교하면 "모름"이라 거짓 처리되기 때문이다. 그래서 NULL을 잡는 **유일한** 방법이 따로 있다 — `IS NULL` / `IS NOT NULL`. `=`/`!=`는 NULL에 영영 참이 안 되니, NULL 검사에는 전용 연산자가 필요하다. 이게 SQL 초심자가 가장 자주 데이는 지점이다.

db-hobby도 그래서 `IS NULL` / `IS NOT NULL`을 따로 처리해요.

```c
if (cond->op == CMP_IS_NULL)     return cell && cell->type == VAL_NULL;
if (cond->op == CMP_IS_NOT_NULL) return cell && cell->type != VAL_NULL;
```

## 5. 집계와 정렬도 NULL을 특별 취급한다

같은 이유로 집계도 NULL을 특별 취급합니다. `COUNT(*)`와 `COUNT(col)`이 다른 게 여기서 나와요.

```sql
SELECT COUNT(*), COUNT(v), SUM(v) FROM na;   -- v가 (10, NULL)일 때
2 | 1 | 10
```

`COUNT(*)`는 **행**을 세니 2, `COUNT(v)`는 **NULL 아닌 값**을 세니 1, `SUM(v)`도 NULL을 빼고 더해 10이에요.

| 집계 | NULL 처리 | `v`가 `(10, NULL)`일 때 |
|---|---|---|
| `COUNT(*)` | 행을 셈 (NULL 포함) | 2 |
| `COUNT(v)` | NULL 아닌 값만 셈 | 1 |
| `SUM(v)` | NULL 건너뜀 | 10 |
| `AVG(v)` | NULL 건너뜀(분모에서도 빠짐) | 10 |
| `MIN`/`MAX(v)` | NULL 건너뜀 | 10 / 10 |
| (전부 NULL일 때) | 결과가 NULL | NULL |

"평균을 낼 때 값이 없는 행은 분모에서도 빠진다"는 게 이 규칙에서 나옵니다. db-hobby의 SUM/AVG 코드가 그대로예요.

```c
for (int r = s; r < e; r++) {
    const Value *cell = &rows[(size_t)r * ncols + ci];
    if (cell->type == VAL_NULL) continue;   // NULL은 건너뛴다
    sum += cell->int_val;
    cnt++;
}
if (cnt == 0) { c.is_null = 1; return c; }  // 전부 NULL -> 결과도 NULL
c.num = (it->agg == AGG_SUM) ? (double)sum : (double)sum / cnt;
```

정렬에선 NULL을 **어디에 둘지**를 정해야 해요. db-hobby는 NULL을 가장 크게 쳐서 오름차순(ASC)에선 맨 뒤로 보냅니다 — PostgreSQL의 기본값인 `NULLS LAST`와 같아요.

```c
/* NULL은 가장 크게 친다(ASC 정렬 시 끝 = PostgreSQL의 NULLS LAST). */
static int value_cmp(const Value *x, const Value *y) {
    if (x->type == VAL_NULL || y->type == VAL_NULL) {
        return (x->type == VAL_NULL) - (y->type == VAL_NULL);
    }
    /* ... 둘 다 비NULL이면 값 비교 ... */
}
```

| | db-hobby | PostgreSQL | MySQL |
|---|---|---|---|
| ASC에서 NULL 위치 | 맨 뒤 (NULLS LAST) | 맨 뒤 (NULLS LAST, 기본) | 맨 앞 (NULL을 가장 작게) |
| 표준이 정하나 | — | SQL 표준은 미지정 | SQL 표준은 미지정 |

> **주의 — NULL 정렬은 DB마다 다르다**: SQL 표준은 "NULL을 정렬에서 어디에 둘지"를 정해주지 않는다. 그래서 PostgreSQL은 NULL을 가장 크게(ASC면 뒤), MySQL은 가장 작게(ASC면 앞) 친다. db-hobby는 PostgreSQL을 따라 NULLS LAST로 갔다. 이식성이 필요하면 `ORDER BY col NULLS LAST`처럼 명시하는 게 안전하다(다만 db-hobby는 아직 그 문법은 없다).

## 6. PK는 NULL일 수 없다 — NOT NULL 제약

딱 한 곳, NULL을 막아 둔 데가 있어요 — **첫 컬럼(PK)** 입니다. 이유는 정렬이 아니라 **PK의 정의**예요 — PK는 행을 유일하게 식별하는 키인데, "모름"인 NULL을 키로 허용하면 유일 식별이 깨지니까요(그래서 SQL 표준도 PK에 NOT NULL을 강제합니다). db-hobby는 첫 컬럼을 유일 키로 보고 B+Tree 인덱스를 걸며([3편](/blog/project/db-hobby/db-hobby-3-index-wal)), 그래서 `INSERT INTO t VALUES (NULL, 'x')`를 거부해요. (B+Tree 자체는 NULL도 정렬할 수 있어요 — 실제 PostgreSQL은 NULL이 든 B-tree 인덱스도 만듭니다. db-hobby가 PK 키에 NULL을 안 받는 건 구현 단순화 + PK 의미 때문이에요.)

거기에 더해, 컬럼별로 `NOT NULL` 제약을 직접 걸 수도 있어요. `CREATE TABLE`에서 컬럼 뒤에 `NOT NULL`을 붙이면 파서가 그 컬럼에 플래그를 세웁니다.

```c
col->not_null = 0;
if (p_accept(p, TOK_NOT)) {              /* 선택적 NOT NULL 제약 */
    p_expect(p, TOK_NULL, "NOT 다음에 NULL이 필요합니다");
    col->not_null = 1;
}
```

INSERT 때는 "PK이거나 NOT NULL 컬럼인데 값이 NULL이면" 거부해요 — 진짜 DB의 PK NOT NULL + 컬럼 제약과 똑같은 검사입니다.

```c
for (int i = 0; i < in->num_values && i < t->schema.num_columns; i++) {
    int is_pk = (i == 0 && t->has_index);
    if ((is_pk || t->schema.columns[i].not_null) && in->values[i].type == VAL_NULL) {
        fprintf(out, "ERROR: '%s' 컬럼은 NULL일 수 없습니다%s\n",
                t->schema.columns[i].name, is_pk ? " (기본 키)" : "");
        return -1;
    }
}
```

> **실무/면접 포인트 — PK는 왜 항상 NOT NULL인가**: 기본 키는 행을 **유일하게 식별**하는 키다. NULL은 "모름"이라 두 NULL이 같은지조차 판정할 수 없으니(3값 논리), NULL을 키로 허용하면 "유일 식별"이라는 PK의 존재 이유가 깨진다. 그래서 SQL 표준도, 모든 실제 DB도 PK 컬럼에 NOT NULL을 강제한다. db-hobby가 첫 컬럼 NULL을 막는 것도 정확히 같은 자리다 — 인덱스 키로 NULL을 꽂을 수 없다는 구현 사정과, "PK는 유일 식별자"라는 의미 사정이 같은 결론으로 만난다.

## 7. 덤 — 만들다 보니 옛 글의 거짓말이 드러났다

이번에도 만들면서 기존 코드를 다시 보게 됐는데, 두 군데서 사실과 다른 서술을 찾았어요. 정렬 비교 함수엔 "NULL은 가장 작게"라는 주석이 붙어 있었는데, 코드는 실제로 NULL을 가장 **크게** 치고 있었습니다(NULLS LAST). README엔 "NULL은 저장 행에 들어가지 않는다"가 남아 있었는데 — 이번 편으로 정확히 거짓이 된 문장이에요. 둘 다 바로잡았습니다.

직접 만들고 재보는 일의 부수입은, 자꾸 내가 예전에 적어 둔 걸 의심하게 된다는 거예요. 코드가 진실이고 주석·문서는 언제든 뒤처질 수 있다는 걸 손으로 확인하는 셈입니다.

## 8. 정리

NULL 저장은 코드량으로 보면 작은 작업이었어요 — 행 앞에 비트맵 한 줌. 하지만 그 작은 입구 하나가 5편에서 깔아 둔 NULL 파이프라인 전체를 깨웠고, 그 과정에서 SQL의 3값 논리를 손으로 만져 봤습니다. 핵심을 정리하면:

- **null 비트맵** — "값이 없음"은 데이터 안의 어떤 값으로도 표현 못 하니, 행 앞에 컬럼당 1비트로 데이터 바깥에 표시한다. 비트는 반드시 값보다 **앞**(값을 읽기 전에 NULL 여부를 알아야 하니까). PostgreSQL·InnoDB 행 포맷과 같은 발상.
- **3값 논리** — NULL이 낀 비교는 참도 거짓도 아닌 "모름"이고, WHERE는 모름을 거짓 취급한다. 그래서 `=`로도 `!=`로도 NULL이 안 잡히고, NULL을 잡는 유일한 길은 `IS NULL`/`IS NOT NULL`.
- **집계·정렬** — `COUNT(*)`는 행을, `COUNT(col)`/`SUM`/`AVG`는 NULL을 건너뛴 값을 센다. 정렬은 NULL을 가장 크게 쳐 ASC에선 NULLS LAST, DESC에선 NULLS FIRST가 되는데 — 방향만 뒤집을 뿐이라 둘 다 PostgreSQL 기본과 같다(MySQL은 반대).
- **NOT NULL·PK** — PK는 항상 NOT NULL(NULL은 유일 식별을 깨니까). 컬럼별 `NOT NULL` 제약도 INSERT에서 검증한다.

"값이 없음"을 값으로 표현할 수 없어 데이터 바깥에 비트로 표시해야 한다는 것 — 이건 직접 비트맵을 깔며 손에 잡혔어요. 그리고 그 과정에서 "NULL은 일반 값과 다르다"가 실감 나니, `=`로는 영영 NULL을 못 잡는 3값 논리가 왜 필요한지도 비로소 이해됐습니다(3값 논리는 저장 방식이 아니라 SQL 언어 설계지만, 저장을 만지며 그 필요성이 또렷해졌어요).

## 참고

- [PostgreSQL Documentation: Database Page Layout (튜플 헤더·null bitmap)](https://www.postgresql.org/docs/current/storage-page-layout.html)
- [PostgreSQL Documentation: NULL과 비교 (`IS NULL`, 3값 논리)](https://www.postgresql.org/docs/current/functions-comparison.html)
- [SQL standard: three-valued logic — Wikipedia: Null (SQL)](https://en.wikipedia.org/wiki/Null_(SQL))
- db-hobby 시리즈: [1. 저장 계층](/blog/project/db-hobby/db-hobby-1-storage) · [2. SQL 엔진](/blog/project/db-hobby/db-hobby-2-sql-engine) · [3. 인덱스와 WAL](/blog/project/db-hobby/db-hobby-3-index-wal) · [4. 트랜잭션](/blog/project/db-hobby/db-hobby-4-transactions) · [5. 조인과 집계](/blog/project/db-hobby/db-hobby-5-join-aggregate) · [6. BETWEEN과 LIKE](/blog/project/db-hobby/db-hobby-6-between-like) · [7. 직접 재보기](/blog/project/db-hobby/db-hobby-7-benchmark) · [8. EXPLAIN](/blog/project/db-hobby/db-hobby-8-explain)
- [db-hobby 코드 (GitHub)](https://github.com/dj258255/db-hobby)

<!-- EN -->

## 0. Introduction — How Do You Store "No Value"?

NULL first appeared back in [Part 5](/blog/project/db-hobby/db-hobby-5-join-aggregate). But that was a **transient** NULL filling the unmatched right side of a LEFT JOIN — a value that flashes into a join result and vanishes, never stored on disk. `INSERT INTO t VALUES (1, NULL)` itself was rejected, because a real stored row couldn't hold a NULL.

This part unblocks that. It sounds trivial, but doing it showed that marking "no value" in bytes is trickier than expected — and at the same time it showed how much the groundwork laid earlier does for free.

> **Goal of this part**: actually store `INSERT (1, NULL)`. The key is the **null bitmap**, which marks "no value" outside the data itself. And once that one entry point — storage — is open, watch how comparison, aggregation, sorting, and three-valued logic all follow behind it.

## 1. NULL Can't Be Expressed by Any Value Inside the Data

In [Part 2's tuple codec](/blog/project/db-hobby/db-hobby-2-sql-engine), `INT` is 4 bytes and `TEXT` is "length + bytes". So where do you write NULL?

The first idea is to **reserve a special value** — say, treat the integer `-1` as NULL. It breaks immediately. `-1` is a perfectly valid integer; if someone really stores `-1`, you can't tell it from NULL. TEXT is the same: the empty string `''` isn't NULL but "a string of length 0", a genuinely different value.

> **Key fact**: NULL isn't an ordinary data value — it's a **special marker for "the absence of a value."** It has a type, lives in columns, and is testable via IS NULL, but no ordinary INT or TEXT data by *itself* can represent it, so it must be marked **outside** the data. This is the starting point of every difficulty in storing NULL.

So real DBs use a **null bitmap**. At the front of each row sit as many bits as there are columns; if bit i is 1, "column i is NULL". A NULL column gets only its bit set and writes no value bytes at all (saving space too). Both PostgreSQL and InnoDB keep this null bitmap in the row header.

| | Null bitmap (db-hobby) | PostgreSQL | InnoDB |
|---|---|---|---|
| Location | after the row (MVCC) header, before values | the tuple header's `t_bits` | the row header (variable part) |
| Size | 1 bit per column (1 byte per 8 columns) | 1 bit per column | 1 bit per nullable column |
| Value bytes of a NULL column | not written (space saved) | not written | not written |
| Non-nullable columns | bit kept but always 0 | bitmap omitted entirely if all NOT NULL | excluded from the bitmap |

Details differ, but the idea is identical across these row-store DBs — record "which column is NULL" with a **separate bit**, not with the value bytes. (Other engines like Oracle, SQL Server, and SQLite lay out rows quite differently.)

## 2. The Null Bitmap — A Handful of Bits at the Front of the Row

db-hobby's encoding changed like this. Right after the row's [MVCC header](/blog/project/db-hobby/db-hobby-2-sql-engine) (xmin/xmax, 8 bytes) comes the null bitmap, and the values follow after that.

```c
/* row = MVCC header (8B) + null bitmap + values. bit 1 means that column is NULL */
int nbits = (schema->num_columns + 7) / 8;     // 1 byte per 8 columns
memset(buf + MVCC_HDR, 0, (size_t)nbits);
uint16_t off = (uint16_t)(MVCC_HDR + nbits);   // values start after the bitmap
for (int i = 0; i < schema->num_columns; i++) {
    const Value *v = &vals[i];
    if (v->type == VAL_NULL) {
        buf[MVCC_HDR + i / 8] |= (uint8_t)(1 << (i % 8)); // set just the bit
        continue;                                          // write no value bytes
    }
    /* (else encode as before: INT 4 bytes / TEXT length+bytes) */
}
```

`(num_columns + 7) / 8` is "column count divided by 8, rounded up" — up to 8 columns is 1 byte, 9 needs 2. The bit op `buf[i/8] |= (1 << (i%8))` computes which byte and which position bit i lands in, and sets just that bit — the standard idiom.

Decoding is the reverse. Read the bitmap at the front first; for each set bit, leave the column as `VAL_NULL` and skip its value bytes.

```c
int nbits = (schema->num_columns + 7) / 8;
uint16_t off = (uint16_t)(MVCC_HDR + nbits);   // skip MVCC header + null bitmap
for (int i = 0; i < schema->num_columns; i++) {
    if (rec[MVCC_HDR + i / 8] & (uint8_t)(1 << (i % 8))) { // null bit is set
        out[i].type = VAL_NULL;
        continue;                                          // no value bytes here
    }
    /* (else read 4 bytes for INT, or length+bytes for TEXT) */
}
```

> **Why put the bitmap at the very front**: you must know "is this column NULL?" **before** reading its value, so you can decide whether to read 4 bytes (INT) or skip 0 bytes here. If the bitmap sat after the values, it becomes chicken-and-egg — you'd have to read all the values to reach the bitmap, but you need the bitmap to know where the values end. So in a format like db-hobby's that reads values sequentially, the bitmap must come before the values. (Formats with offset arrays or column directories relax this — the real requirement is just that NULL status be knowable before interpreting a value.)

## 3. Once Storage Was Unblocked, the Rest Already Worked

Here's the fun part. Once I'd built store/restore with the null bitmap, **there was almost nothing else to fix.**

`WHERE name IS NULL`, the difference between `COUNT(*)` and `COUNT(name)`, an `ORDER BY` with NULLs mixed in — they all just worked. Thanks to [Part 5](/blog/project/db-hobby/db-hobby-5-join-aggregate). Back then, to handle the LEFT JOIN's transient NULLs, I'd already made the comparison function (NULL equals nothing), aggregation (`COUNT(col)`/`SUM`/`AVG` skip NULL), and the sort comparator all aware of `VAL_NULL`.

Whether that NULL was "made by a join" or "read from disk", it's the same `VAL_NULL` to the code. So opening just the one **entry point** — storage — let the whole pipeline behind it be reused untouched (within the feature scope db-hobby implements — real DBs have extra NULL policies for UNIQUE, DISTINCT, GROUP BY, join equality, and indexes).

> **A design reward — what cutting layers cleanly buys you**: by building NULL's "meaning" (comparison/aggregation/sort rules) separately from NULL's "storage" (byte representation), filling in one side later didn't shake the other. Part 5 filled the meaning, Part 9 filled the storage, and the two meshed cleanly. It was the moment I saw with my own hands that "separation of concerns" isn't an abstract slogan but something that actually cuts the work.

## 4. NULL Isn't False — It's "Unknown": Three-Valued Logic

Storing NULL brought me face to face with the most confusing topic in SQL — **three-valued logic**.

A condition is usually either true or false. But once NULL enters, a third value appears: **unknown**.

> **What three-valued logic is**: the result of a comparison involving NULL is neither true nor false but **unknown**. If `name = 'kim'` and `name` is NULL, "is the name of a nameless person kim?" is unanswerable — unknown. And a SQL `WHERE` **keeps only rows that are TRUE**, so both FALSE and UNKNOWN are dropped alike — that is, unknown falls out of the result just like false.

So this happens:

```sql
SELECT * FROM nt WHERE name = 'kim';      -- rows where name is NULL: not returned
SELECT * FROM nt WHERE name != 'kim';     -- rows where name is NULL: also not returned (!)
```

NULL rows are caught by neither `=` nor `!=`. Both are "unknown", so both are treated as false. db-hobby's comparison function pins this rule down in one line.

```c
static int values_equal(const Value *a, const Value *b) {
    if (a->type == VAL_NULL || b->type == VAL_NULL) {
        return 0; /* NULL equals nothing (not even NULL) */
    }
    /* ... if same type, compare values ... */
}
```

| Comparison | Result when `name` is NULL | That row in WHERE |
|---|---|---|
| `name = 'kim'` | unknown | excluded |
| `name != 'kim'` | unknown | excluded |
| `name = NULL` | unknown | excluded |
| `name IS NULL` | **true** | included |
| `name IS NOT NULL` | false | excluded |

> **Practical/interview note — why `!=` doesn't catch NULL**: you write `name != 'kim'` to pull out "people who aren't kim", and yet people with no name (NULL) quietly drop out. Because `!=` against NULL is also "unknown", treated as false. So there's a single way to catch NULL — `IS NULL` / `IS NOT NULL`. Since `=`/`!=` are never true against NULL, checking for NULL needs a dedicated operator. This is where SQL beginners get burned most often.

That's why db-hobby handles `IS NULL` / `IS NOT NULL` separately too.

```c
if (cond->op == CMP_IS_NULL)     return cell && cell->type == VAL_NULL;
if (cond->op == CMP_IS_NOT_NULL) return cell && cell->type != VAL_NULL;
```

## 5. Aggregation and Sorting Treat NULL Specially Too

For the same reason, aggregation treats NULL specially. This is where `COUNT(*)` and `COUNT(col)` differ.

```sql
SELECT COUNT(*), COUNT(v), SUM(v) FROM na;   -- when v is (10, NULL)
2 | 1 | 10
```

`COUNT(*)` counts **rows**, so 2; `COUNT(v)` counts **non-NULL values**, so 1; `SUM(v)` also adds excluding NULL, so 10.

| Aggregate | NULL handling | When `v` is `(10, NULL)` |
|---|---|---|
| `COUNT(*)` | counts rows (NULL included) | 2 |
| `COUNT(v)` | counts only non-NULL values | 1 |
| `SUM(v)` | skips NULL | 10 |
| `AVG(v)` | skips NULL (excluded from denominator too) | 10 |
| `MIN`/`MAX(v)` | skips NULL | 10 / 10 |
| (when all NULL) | result is NULL | NULL |

"When averaging, rows with no value drop out of the denominator too" comes from this rule. db-hobby's SUM/AVG code is exactly that.

```c
for (int r = s; r < e; r++) {
    const Value *cell = &rows[(size_t)r * ncols + ci];
    if (cell->type == VAL_NULL) continue;   // skip NULL
    sum += cell->int_val;
    cnt++;
}
if (cnt == 0) { c.is_null = 1; return c; }  // all NULL -> result is NULL
c.num = (it->agg == AGG_SUM) ? (double)sum : (double)sum / cnt;
```

For sorting, you must decide **where to put NULL**. db-hobby ranks NULL as the largest, so ascending (ASC) sends it to the back — the same as PostgreSQL's default, `NULLS LAST`.

```c
/* rank NULL largest (so on ASC it lands at the end = PostgreSQL's NULLS LAST). */
static int value_cmp(const Value *x, const Value *y) {
    if (x->type == VAL_NULL || y->type == VAL_NULL) {
        return (x->type == VAL_NULL) - (y->type == VAL_NULL);
    }
    /* ... if both non-NULL, compare values ... */
}
```

| | db-hobby | PostgreSQL | MySQL |
|---|---|---|---|
| NULL position on ASC | back (NULLS LAST) | back (NULLS LAST, default) | front (NULL ranked smallest) |
| Does the standard fix it | — | SQL standard leaves it unspecified | SQL standard leaves it unspecified |

> **Caution — NULL sort order differs per DB**: the SQL standard doesn't fix "where NULL goes in sorting". So PostgreSQL ranks NULL largest (back on ASC), MySQL smallest (front on ASC). db-hobby followed PostgreSQL with NULLS LAST. If you need portability, it's safer to spell it out like `ORDER BY col NULLS LAST` (though db-hobby doesn't have that syntax yet).

## 6. A PK Can't Be NULL — The NOT NULL Constraint

There's exactly one place NULL is blocked — the **first column (the PK)**. The reason is not sorting but the **definition of a PK** — it uniquely identifies a row, and allowing "unknown" NULL as a key would break that unique identification (which is why the SQL standard forces NOT NULL on PKs). db-hobby treats the first column as a unique key with a B+Tree index ([Part 3](/blog/project/db-hobby/db-hobby-3-index-wal)), so `INSERT INTO t VALUES (NULL, 'x')` is rejected. (A B+Tree can perfectly well sort NULLs — real PostgreSQL even builds B-tree indexes containing NULLs; db-hobby disallows a NULL PK key for implementation simplicity plus PK semantics.)

On top of that, you can put a `NOT NULL` constraint on a column directly. Append `NOT NULL` after a column in `CREATE TABLE` and the parser sets a flag on it.

```c
col->not_null = 0;
if (p_accept(p, TOK_NOT)) {              /* optional NOT NULL constraint */
    p_expect(p, TOK_NULL, "NULL expected after NOT");
    col->not_null = 1;
}
```

At INSERT time it rejects "a PK or NOT NULL column whose value is NULL" — exactly the PK-NOT-NULL + column-constraint check of a real DB.

```c
for (int i = 0; i < in->num_values && i < t->schema.num_columns; i++) {
    int is_pk = (i == 0 && t->has_index);
    if ((is_pk || t->schema.columns[i].not_null) && in->values[i].type == VAL_NULL) {
        fprintf(out, "ERROR: column '%s' cannot be NULL%s\n",
                t->schema.columns[i].name, is_pk ? " (primary key)" : "");
        return -1;
    }
}
```

> **Practical/interview note — why a PK is always NOT NULL**: a primary key is the key that **uniquely identifies** a row. NULL is "unknown", so you can't even judge whether two NULLs are equal (three-valued logic); allowing NULL as a key would break the very reason a PK exists — unique identification. So the SQL standard, and every real DB, enforces NOT NULL on PK columns. db-hobby blocking a NULL first column sits in exactly the same spot — the implementation fact (you can't slot NULL as an index key) and the semantic fact ("a PK is a unique identifier") meet at the same conclusion.

## 7. A Bonus — Building It Exposed Lies in Old Writing

This time too, building it made me re-read the existing code, and I found two statements that didn't match reality. The sort comparison function had a comment saying "NULL is smallest", but the code actually ranked NULL **largest** (NULLS LAST). The README still said "NULL doesn't go into stored rows" — a sentence this very part made precisely false. I fixed both.

A side benefit of building and measuring things yourself is that you keep growing suspicious of what you wrote earlier. It's a hands-on confirmation that the code is the truth and comments/docs can always fall behind.

## 8. Wrap-up

Storing NULL was a small task by line count — a handful of bits at the front of the row. But that one small entry point woke the entire NULL pipeline laid down in Part 5, and along the way I got to touch SQL's three-valued logic with my hands. The key points:

- **Null bitmap** — "no value" can't be expressed by any value inside the data, so mark it outside the data with one bit per column at the front of the row. The bits must come **before** the values (you must know the NULL status before reading a value). Same idea as PostgreSQL's and InnoDB's row formats.
- **Three-valued logic** — a comparison involving NULL is neither true nor false but "unknown", and WHERE treats unknown as false. So NULL is caught by neither `=` nor `!=`, and the only way to catch it is `IS NULL`/`IS NOT NULL`.
- **Aggregation/sorting** — `COUNT(*)` counts rows; `COUNT(col)`/`SUM`/`AVG` count values skipping NULL. Sorting ranks NULL largest, giving NULLS LAST on ASC and NULLS FIRST on DESC — only the direction flips, so both match PostgreSQL's default (MySQL is the opposite).
- **NOT NULL/PK** — a PK is always NOT NULL (NULL breaks unique identification). Per-column `NOT NULL` constraints are validated at INSERT too.

That "no value" can't be expressed as a value and must be marked with a bit outside the data — that became tangible once I'd laid down the bitmap myself. And once "NULL is unlike an ordinary value" sank in, I finally understood why three-valued logic (where `=` never catches NULL) is needed — three-valued logic is SQL's language design, not a storage detail, but building the storage made its necessity vivid.

## References

- [PostgreSQL Documentation: Database Page Layout (tuple header, null bitmap)](https://www.postgresql.org/docs/current/storage-page-layout.html)
- [PostgreSQL Documentation: Comparison with NULL (`IS NULL`, three-valued logic)](https://www.postgresql.org/docs/current/functions-comparison.html)
- [SQL standard: three-valued logic — Wikipedia: Null (SQL)](https://en.wikipedia.org/wiki/Null_(SQL))
- db-hobby series: [1. Storage](/blog/project/db-hobby/db-hobby-1-storage) · [2. SQL Engine](/blog/project/db-hobby/db-hobby-2-sql-engine) · [3. Index & WAL](/blog/project/db-hobby/db-hobby-3-index-wal) · [4. Transactions](/blog/project/db-hobby/db-hobby-4-transactions) · [5. Join & Aggregate](/blog/project/db-hobby/db-hobby-5-join-aggregate) · [6. BETWEEN & LIKE](/blog/project/db-hobby/db-hobby-6-between-like) · [7. Benchmark](/blog/project/db-hobby/db-hobby-7-benchmark) · [8. EXPLAIN](/blog/project/db-hobby/db-hobby-8-explain)
- [db-hobby on GitHub](https://github.com/dj258255/db-hobby)
```

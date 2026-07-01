---
title: 'SQL 엔진은 어떻게 동작하는가 — 텍스트에서 행까지'
titleEn: 'How Does the SQL Engine Work? — From Text to Rows'
description: "PostgreSQL·MySQL이 내부에서 어떻게 동작하는지 이해하려고 관계형 DB를 C로 밑바닥부터 만든 db-hobby 시리즈 2편. 1편의 저장 계층 위에 SQL 프런트엔드를 얹습니다 — 손으로 쓴 토크나이저(렉서)와 재귀 하강 파서로 SQL 문자열을 AST로 바꾸고, 튜플 코덱이 값을 스키마대로 바이트로 인코딩하고, 실행기가 힙을 훑어 CREATE/INSERT/SELECT/UPDATE/DELETE를 처리합니다. 손으로 쓴 파서 vs 파서 생성기, length-prefixed vs 널 종료, tombstone 삭제 같은 설계 선택을 PostgreSQL·MySQL과 비교합니다."
descriptionEn: "Part 2 of db-hobby, a relational database built from scratch in C to understand how PostgreSQL and MySQL work inside. On top of Part 1's storage layer we add the SQL frontend — a hand-written tokenizer (lexer) and recursive-descent parser turn SQL text into an AST, a tuple codec encodes values to bytes by schema, and an executor scans the heap to run CREATE/INSERT/SELECT/UPDATE/DELETE. We compare design choices — hand-written parser vs parser generator, length-prefixed vs null-terminated, tombstone deletes — against PostgreSQL and MySQL."
date: 2026-05-14
tags:
  - C
  - Database Internals
  - SQL
  - Parser
  - PostgreSQL
  - InnoDB
  - Learning
category: study/db-hobby
coverImage: /uploads/project/db-hobby/cover.svg
draft: false
series: "db-hobby"
seriesOrder: 2
---

## 0. 들어가며 — 텍스트를 행으로 바꾸는 길

[1편](/blog/project/db-hobby/db-hobby-1-storage)에서 페이저·슬롯 페이지·버퍼 풀·힙으로 "행을 디스크에 얹고 훑는" 저장 계층을 만들었어요. 하지만 아직 SQL은 한 글자도 못 받습니다. 행을 넣으려면 C 함수를 직접 부르고, 행을 찾으려면 힙을 손으로 훑어야 해요.

이번 편은 그 위에 **SQL 프런트엔드** 를 얹습니다 — 텍스트를 구조로 바꾸는 **파서**, 그리고 그 구조를 힙에 연결하는 **실행기**. 다 만들고 나면 `SELECT * FROM users WHERE id = 2` 한 줄을 타이핑해 `2 | lee` 라는 행을 돌려받기까지, 1편에서 만든 여섯 계층이 한 번에 맞물려 돌아가는 걸 볼 수 있어요.

> **이번 편의 목표**: SQL 텍스트 -> 토큰(렉서) -> AST(파서) -> 힙 연산(실행기). 대부분의 관계형 DB가 텍스트로 들어온 쿼리를 처리하는 바로 그 파이프라인을, C로 한 단계씩 짓습니다. (실제 DB는 파서와 실행기 **사이에 옵티마이저·실행 계획 생성** 계층이 더 들어가는데, db-hobby는 그 축소판을 실행기 안에 녹였어요 — [3편](/blog/project/db-hobby/db-hobby-3-index-wal)·[8편 EXPLAIN](/blog/project/db-hobby/db-hobby-8-explain)에서 본격적으로 나옵니다.)

## 1. 큰 그림 — 컴파일러의 앞단을 빌려온다

`"SELECT * FROM users WHERE id = 1"` 은 사람에겐 한 문장이지만 컴퓨터에겐 그냥 글자 나열이에요. 이걸 실행기가 다룰 수 있는 **구조(트리)** 로 바꾸는 게 파서이고, 그 구조를 1편의 힙에 연결해 진짜 행을 돌려주는 게 실행기입니다.

이 흐름의 **앞단(렉싱·파싱)** 은 사실 DB가 발명한 게 아니라 컴파일러·인터프리터에서 그대로 빌려온 거예요. 소스 코드를 토큰으로 쪼개고(렉싱), 토큰을 트리로 조립하고(파싱)까지는 대부분의 언어 처리기에서 같습니다. 다만 그 **뒤는 갈라져요** — 컴파일러는 코드 생성으로 가고, DB는 관계 대수·비용 추정에 기반한 쿼리 옵티마이저라는, 앞단만 닮았지 뒤는 거의 다른 분야로 갑니다.

| 단계 | 컴파일러 용어 | db-hobby에서 | 입력 -> 출력 |
|---|---|---|---|
| 1 | 렉싱(lexing) | 토크나이저 | 글자 -> 토큰 |
| 2 | 파싱(parsing) | 재귀 하강 파서 | 토큰 -> AST |
| 3 | 평가(evaluation) | 실행기 | AST -> 힙 연산 -> 행 |

> **핵심 사실**: SQL 처리를 "작은 언어 인터프리터"에 빗댈 수 있다 — SQL이 그 언어, 파서가 앞단, 실행기가 평가기다. 다만 이 비유는 db-hobby나 SQLite처럼 **AST를 비교적 직접 실행**하는 구현에 가깝고, PostgreSQL·MySQL은 AST를 그대로 실행하지 않는다 — 재작성(rewrite)·옵티마이저를 거쳐 **실행 계획(plan tree)** 을 만든 뒤 그걸 실행한다. db-hobby는 학습용이라 AST를 바로 실행하고, "쿼리 플래너"는 그 안의 작은 분기로 들어 있다.

## 2. 토크나이저(렉서) — 글자를 토큰으로

**1단계는 토크나이저(lexer).** 글자 스트림을 의미 단위 **토큰**으로 쪼갭니다.

`SELECT * FROM users WHERE id = 1` -> `[SELECT] [*] [FROM] [IDENT:users] [WHERE] [IDENT:id] [=] [INT:1]`.

렉서가 하는 일은 네 가지예요.

- 공백을 건너뛴다.
- 연속된 글자(`isalpha`/`isdigit`/`_`)를 식별자나 키워드로 묶는다.
- `<=`·`<>`·`!=`·`>=` 같은 **두 글자 연산자를 한 토큰으로** 인식한다.
- `'...'` 안을 문자열 리터럴로 떼낸다.

db-hobby 렉서의 비교 연산자 처리가 좋은 예예요. 두 글자를 먼저 보고, 아니면 한 글자로 떨어집니다.

```c
/* 비교 연산자 (=, !=, <, >, <=, >=). 두 글자를 먼저 본다. */
if (c == '=' || c == '<' || c == '>' || c == '!') {
    char nx = lx->src[lx->pos + 1];
    if (c == '<' && nx == '=') { lx->pos += 2; t.type = TOK_LE; return t; }
    if (c == '<' && nx == '>') { lx->pos += 2; t.type = TOK_NE; return t; } /* SQL의 <> */
    if (c == '>' && nx == '=') { lx->pos += 2; t.type = TOK_GE; return t; }
    if (c == '!' && nx == '=') { lx->pos += 2; t.type = TOK_NE; return t; }
    if (c == '=') { lx->pos++; t.type = TOK_EQ; return t; }
    if (c == '<') { lx->pos++; t.type = TOK_LT; return t; }
    if (c == '>') { lx->pos++; t.type = TOK_GT; return t; }
    t.type = TOK_ERROR; /* 외톨이 '!' */
    return t;
}
```

> **왜 두 글자를 먼저 보나(maximal munch)**: `<=`를 만났을 때 `<` 하나만 떼면 그 뒤 `=`가 엉뚱하게 따로 떨어진다. 렉서는 "가능한 한 긴 토큰을 먼저 집는다"는 maximal munch(longest match) 규칙을 따른다 — 거의 대부분의 렉서가 쓰는 원칙이다(Python의 들여쓰기, Go의 세미콜론 자동 삽입처럼 토큰화에 별도 규칙을 더 얹는 언어도 있긴 하다).

키워드와 일반 식별자를 어떻게 가르냐가 또 하나의 포인트예요. db-hobby는 식별자처럼 한 덩어리를 다 읽은 **뒤에**, 그 문자열이 예약어인지 표로 한 번 조회합니다(`keyword_of`). `users`면 `TOK_IDENT`, `FROM`이면 `TOK_FROM`. 대소문자는 `strcasecmp`로 무시해서 `select`도 `SELECT`도 같은 토큰이 돼요.

```c
static TokType keyword_of(const char *s) {
    if (!strcasecmp(s, "SELECT")) return TOK_SELECT;
    if (!strcasecmp(s, "FROM"))   return TOK_FROM;
    if (!strcasecmp(s, "WHERE"))  return TOK_WHERE;
    /* ... CREATE, INSERT, JOIN, GROUP, HAVING, LIKE, BETWEEN, ... */
    return TOK_IDENT; /* 예약어가 아니면 일반 식별자(테이블·컬럼 이름) */
}
```

> **실무/면접 포인트**: 키워드를 토큰 종류로 미리 갈라두면, 파서가 "users는 이름이고 FROM은 키워드"임을 헷갈리지 않는다. 이게 SQL의 예약어(reserved word)가 생기는 이유다 — `SELECT`가 키워드라 컬럼 이름으로 그냥 `select`를 쓰면 충돌한다. 다만 "아예 못 쓴다"기보단 **따옴표로 감싸 escape하면 쓸 수 있다** — PostgreSQL은 `"select"`, MySQL은 백틱 `` `select` ``, SQL Server는 `[select]`. 진짜 DB는 비예약 키워드(non-reserved)도 둬서 일부는 그냥도 허용하는데, 원리는 같다.

## 3. 재귀 하강 파서 — 토큰을 AST로

**2단계는 재귀 하강 파서(recursive descent).** 토큰을 트리(AST)로 조립합니다. 재귀 하강의 묘미는 **문법 규칙 하나하나가 함수 하나**가 된다는 것이에요.

![SQL 텍스트 -> 토큰 -> AST](/uploads/project/db-hobby/sql-to-ast.svg)

db-hobby 파서의 `parse_select_stmt`는 거의 영어 그대로 읽힙니다 — "SELECT 목록이 오고, FROM이 와야 하고, 테이블 이름이 오고, JOIN은 있어도 되고, WHERE도 있어도 되고, GROUP BY·HAVING·ORDER BY·LIMIT·OFFSET도 있어도 되고".

```c
static void parse_select_stmt(Parser *p, SelectStmt *s) {
    s->limit = -1;                         /* "LIMIT 없음"의 기본값 */
    parse_select_list(p, s);               /* * 또는 컬럼/집계 목록 */
    p_expect(p, TOK_FROM, "FROM이 필요합니다");
    parse_name(p, s->table);
    /* ... JOIN 절들 ... */
    if (p_accept(p, TOK_WHERE))  parse_where(p, &s->where);
    if (p_accept(p, TOK_GROUP))  { /* GROUP BY ... */ }
    if (p_accept(p, TOK_ORDER))  { /* ORDER BY ... */ }
    if (p_accept(p, TOK_LIMIT))  { /* LIMIT n ... */ }
}
```

파서를 떠받치는 도구는 딱 세 개예요. 이 셋이 재귀 하강의 전부라고 해도 됩니다.

| 헬퍼 | 하는 일 |
|---|---|
| `p_accept(t)` | 지금 토큰이 `t`면 소비하고 1, 아니면 그대로 0 (선택적 문법용) |
| `p_expect(t, msg)` | `t`여야만 함. 아니면 `msg`로 에러 (필수 문법용) |
| `p_advance()` | 렉서에서 다음 토큰 하나를 당겨온다 |

문법이 중첩되면 함수가 중첩 호출돼요. `WHERE`의 조건들은 `parse_where`가, 그 안의 OR로 이어진 AND 묶음은 `parse_and_group`이, 그 안의 한 조건(`id = 1`)은 또 그 아래가 맡습니다. 그리고 서브쿼리(`WHERE id IN (SELECT ...)`)를 만나면 파서가 **자기 자신을 재귀 호출**해요 — `parse_and_group` 안에서 다시 `parse_select_stmt`를 부릅니다. 이게 "재귀 하강"이라는 이름의 정체이고, [5편의 서브쿼리](/blog/project/db-hobby/db-hobby-5-join-aggregate)에서 다시 나옵니다.

> **WHERE는 OR-of-AND 형태만 받는다(DNF 변환은 아니다)**: db-hobby의 WHERE는 `term (OR term)*`이고 각 term은 `cond (AND cond)*`다. AND가 OR보다 먼저 묶이므로 `a AND b OR c`는 `(a AND b) OR c`로 파싱된다 — 선언적 우선순위(precedence)를 함수 호출 순서로 표현한 것이다. 주의: 이건 입력을 OR-of-AND(결과적으로 DNF 모양)로 **제한해서 받는** 것이지, `(a OR b) AND c`를 `(a AND c) OR (b AND c)`로 바꾸는 **DNF 정규화가 아니다**(애초에 db-hobby는 괄호 친 WHERE를 파싱하지 않는다). `BETWEEN a AND b` 같은 문법 설탕은 db-hobby 파서가 그 자리에서 `(col >= a) AND (col <= b)`로 풀어버리는데, 이것도 db-hobby의 선택이다 — PostgreSQL은 파스 트리에 BETWEEN 노드를 남겼다가 나중에 변환한다.

### 손으로 쓴 파서 vs 파서 생성기

파서는 손으로 짤 수도, yacc/bison·ANTLR 같은 **파서 생성기**로 문법만 적어 자동 생성할 수도 있어요.

| | 손으로 쓴 재귀 하강 (db-hobby·SQLite) | 파서 생성기 (yacc/bison) |
|---|---|---|
| 문법 정의 | 함수로 직접 (코드 = 문법) | 별도 `.y` 문법 파일 |
| 에러 메시지 | 마음대로 (위치·맥락 자유) | 생성기 기본값에 갇히기 쉬움 |
| 디버깅 | 그냥 함수 따라가기 | 생성된 상태 머신을 봐야 함 |
| 큰 문법·복잡한 우선순위 | 함수가 늘어남 | 빛난다(자동 처리) |
| 채택 예 | SQLite(자체 생성기 Lemon), GCC/Clang | MySQL(bison), PostgreSQL(bison) |

생성기는 문법이 크고 자주 바뀔 때, 또 연산자 우선순위가 복잡할 때 빛나요(실제로 MySQL은 bison을 씁니다). 반대로 SQLite는 자체 생성기 Lemon을 쓰고, 손으로 쓴 재귀 하강도 흔합니다 — 에러 메시지를 마음대로 만들고, 디버깅이 그냥 함수 따라가기라 통제하기 쉽다는 이유로요.

> **설계 선택**: 학습용엔 손으로 쓰는 쪽이 낫다고 봅니다. 문법 규칙 하나가 함수 하나로 눈앞에 있으니 "파싱이 대체 뭘 하는지"가 가려지지 않아요. 대신 문법이 커지면 함수가 늘어나는 건 감수해야 합니다. db-hobby는 JOIN·GROUP BY·서브쿼리까지 손으로 갔는데, 그 덕에 각 SQL 기능이 어느 함수에서 태어나는지가 코드에 그대로 보입니다.

## 4. 튜플 코덱 — 값을 바이트로, 바이트를 값으로

파서가 만든 AST(예: `Select{ table:"users", where: id=2 }`)와 [1편의 힙 파일](/blog/project/db-hobby/db-hobby-1-storage)을 잇는 게 실행기예요. 그 사이에 꼭 필요한 한 가지가 **튜플 코덱(tuple codec)** — SQL 값을 디스크에 넣을 바이트열로, 또 그 반대로 바꾸는 인코더/디코더입니다.

db-hobby의 규칙은 단순해요: `INT`는 4바이트 정수(int32), `TEXT`는 "2바이트 길이 + 그 길이만큼의 바이트". 그래서 `(1, 'kim')`은 `01 00 00 00 | 03 00 | 6B 69 6D`(id=1, 길이 3, "kim")으로 인코딩됩니다.

![tuple codec — (1, 'kim')이 스키마대로 바이트열로 인코딩](/uploads/project/db-hobby/tuple-encoding.svg)

```c
/* INT : 4바이트(int32),  TEXT : 2바이트 길이 + 바이트열 */
if (schema->columns[i].type == COL_INT) {
    int32_t x = (int32_t)v->int_val;
    memcpy(buf + off, &x, 4);
    off += 4;
} else { /* TEXT */
    uint16_t len = (uint16_t)strlen(v->text_val);
    memcpy(buf + off, &len, 2);   /* 길이를 앞에 박는다 */
    off += 2;
    memcpy(buf + off, v->text_val, len);
    off += len;
}
```

디코드는 정확히 그 역순이에요 — INT면 4바이트를 읽고, TEXT면 길이 2바이트를 먼저 읽어 그만큼 또 읽습니다. 인코드/디코드가 **같은 스키마 순서**를 따르기 때문에 바이트열 안에 "어디가 어느 컬럼"이라는 표시가 따로 없어도 됩니다. (참고로 정수를 `memcpy`로 그대로 담아서 바이트 순서가 호스트 엔디안을 따라요 — 학습용이라 괜찮지만 엔디안이 다른 머신으로 파일을 옮기면 깨지니, 실제 DB는 엔디안을 고정해 저장합니다.)

> **TEXT를 왜 "길이 + 바이트"로 했나(length-prefixed)**: C 문자열처럼 끝에 `\0`를 붙이는 방법(널 종료)도 있지만, 그러면 길이를 알려고 끝까지 스캔해야 하고 문자열 안에 `\0`가 섞이면 깨진다. 길이를 앞에 박아두면 한 번에 "여기서 3바이트"라고 점프할 수 있다.

| | length-prefixed (db-hobby·실DB) | 널 종료 (C 문자열) |
|---|---|---|
| 길이 알기 | O(1) (앞 2바이트) | O(n) (끝까지 스캔) |
| 바이너리 안전 | O (`\0` 섞여도 됨) | X (`\0`에서 끊김) |
| 다음 컬럼 점프 | 곱셈/덧셈 한 번 | 스캔해야 위치를 앎 |
| 쓰는 곳 | PostgreSQL varlena, Pascal 문자열, 네트워크 프로토콜 | C 문자열 |

이건 내가 발명한 게 아니라 가변 길이 데이터의 정석이고, Pascal 문자열부터 네트워크 프로토콜, 그리고 실제 DB의 행 포맷까지 다 이 방식이에요. PostgreSQL의 가변 길이 타입(varlena)도 앞에 길이 헤더를 다는데, 같은 *아이디어*일 뿐 같은 *방식*은 아니에요 — varlena는 1바이트(짧은 값)나 4바이트 헤더를 쓰고, 값이 크면 TOAST로 따로 떼어 저장하거나 압축까지 합니다. 정수를 고정 4바이트로 둔 것도 같은 맥락 — 길이가 안 변하니 다음 컬럼 위치 계산이 덧셈으로 끝나요.

> **실무/면접 포인트**: 실제 db-hobby 코드의 행 포맷은 여기에 두 가지가 더 붙어 있다 — 컬럼당 1비트씩의 **null 비트맵**(어느 컬럼이 NULL인지), 그리고 [13편 MVCC](/blog/project/db-hobby/db-hobby-13-mvcc)에서 추가한 8바이트 **xmin/xmax 헤더**. 이 글에선 핵심인 INT/TEXT 인코딩에 집중하지만, "행 = 헤더 + null 비트맵 + 값들"이라는 레이아웃은 PostgreSQL 튜플과 똑같은 발상이다.

## 5. 실행기 — AST를 힙 연산으로

이 코덱 위에서 실행기는 문장 종류대로 1편의 저장 계층을 부립니다. 이번 db-hobby에선 SQL 한 문장이 결국 몇 개의 저장 계층 연산으로 번역되는 모습을 직접 볼 수 있어요. 실제 관계형 DB는 이 사이에 옵티마이저·실행 계획 생성 같은 계층이 더 들어가지만(SQL의 진짜 무게는 거기 있어요), 기본 흐름은 같습니다.

| SQL | 실행기가 하는 일 | 저장 계층 호출 |
|---|---|---|
| `CREATE` | 스키마를 카탈로그에 기록, 테이블 파일 생성 | `catalog_write` |
| `INSERT` | 값을 인코딩해 힙에 넣고 인덱스 등록 | `encode_row` -> `heap_insert` |
| `SELECT` | 힙을 훑으며 디코딩, `WHERE`로 거름 | `heap_scan` -> `decode_row` |
| `DELETE` | 매칭 행의 슬롯을 tombstone | `heap_delete` |
| `UPDATE` | 옛 행 삭제 + 새 행 삽입 | `heap_delete` + `heap_insert` |

`INSERT`의 본체는 정말 짧아요 — 인코딩 한 번, 힙 삽입 한 번, 인덱스가 있으면 등록 한 번.

```c
uint8_t buf[PAGE_SIZE];
uint16_t len;
encode_row(&t->schema, in->values, in->num_values, db->cur_txn, 0, buf, &len);
RID rid;
heap_insert(&t->heap, buf, len, &rid);   /* 1편의 힙에 행을 넣고 RID를 받는다 */
```

`SELECT`는 힙을 풀 스캔하며 한 행씩 콜백으로 받아, 디코딩하고 `WHERE`로 거른 뒤 통과한 것만 출력해요. `WHERE id = 2`는 지금은 그냥 모든 행을 비교하는 O(n)인데(1편 5절의 sequential scan), 이 "각 행을 평가해서 통과시킬지 정하는" 분기가 곧 [다음 편](/blog/project/db-hobby/db-hobby-3-index-wal)에서 인덱스를 붙일 자리이자 **쿼리 플래너**의 씨앗이 됩니다.

```c
static int select_visit(RID rid, const void *rec, uint16_t len, void *ctx_) {
    SelectCtx *ctx = ctx_;
    Value row[SQL_MAX_COLS];
    decode_row(ctx->schema, rec, row);     /* 바이트 -> 값 */
    /* ... WHERE 평가, 통과하면 출력 ... */
    return 0;
}
```

REPL을 붙이면 드디어 진짜 SQL을 타이핑해 결과를 받습니다.

![db-hobby REPL 세션 — CREATE/INSERT/SELECT가 실제로 동작](/uploads/project/db-hobby/repl-session.svg)

`SELECT * FROM users WHERE id = 2` 한 줄이 `2 | lee` 를 돌려주기까지의 길을 따라가 보면 지금까지 만든 게 전부 맞물려요 — 글자가 토큰이 되고(렉서), 토큰이 AST가 되고(파서), AST가 힙 스캔이 되고(실행기), 스캔이 버퍼 풀을 거쳐(캐시), 페이지가 슬롯에서 풀려(슬롯 페이지), 디스크 오프셋에서 읽혔습니다(페이저). 여섯 계층의 합주예요.

## 6. CRUD 완성 — DELETE와 UPDATE의 함정

`DELETE`와 `UPDATE`를 붙여 CRUD를 완성했는데, 둘 다 인덱스(다음 편) 때문에 미리 신경 쓸 게 있었어요.

- **`DELETE`** 는 (db-hobby에선) 행을 실제로 지우지 않고 힙 슬롯을 **tombstone**(무효 표시)만 합니다. [1편](/blog/project/db-hobby/db-hobby-1-storage)에서 본 대로, 인덱스가 "키 -> RID"로 가리키던 주소를 깨지 않기 위해서예요. (PostgreSQL도 즉시 지우진 않지만 그쪽은 MVCC의 dead tuple·visibility와 얽혀 있고 VACUUM이 나중에 정리해요 — [13편](/blog/project/db-hobby/db-hobby-13-mvcc). db-hobby의 tombstone은 그 단순화 버전입니다.) 인덱스 항목은 그대로 남지만, 그 RID로 `heap_get`을 하면 tombstone이라 -1을 돌려줘 결과에서 자연히 빠집니다 — stale 인덱스 항목이 무해해지는 이유예요(코드 주석에도 "가리키는 슬롯이 tombstone이라 heap_get이 -1을 돌려줘 결과에서 자동으로 빠진다"고 적어뒀습니다).
- **`UPDATE`** 는 더 까다롭습니다. 행이 가변 길이라 제자리 수정이 **항상 되는 건 아니라서**(길이가 같거나 페이지에 여유가 있으면 제자리도 가능하지만, 'kim' -> 'alexander'처럼 길어지면 안 들어가요), db-hobby는 단순하게 **언제나 "옛 행 삭제 + 새 행 삽입"** 으로 처리해요. 그러면 **RID가 바뀝니다.** 그래서 모든 인덱스를 새 RID로 갱신해야 하는데(바뀐 컬럼과 무관하게 RID 자체가 통째로 바뀌니까), 이걸 빼먹으면 인덱스가 삭제된 옛 위치를 가리켜 그 행이 쿼리에서 사라져요.

```c
/* UPDATE: db-hobby는 제자리 수정을 안 하고 언제나 옛 행 삭제 + 새 행 삽입 */
heap_delete(&t->heap, ctx.rids[i]);
RID newrid;
heap_insert(&t->heap, newbuf, newlen, &newrid);
/* 새 RID로 인덱스 갱신 — 안 하면 인덱스가 삭제된 옛 위치를 가리켜 행이 사라진다 */
if (t->has_index && row[0].type == VAL_INT)
    btree_insert(&t->index, row[0].int_val, rid_encode(newrid));
```

![db-hobby CRUD 세션 — UPDATE로 kim을 KIM으로, DELETE로 id=2를 지우면 SELECT에 1행(KIM)만 남는다](/uploads/project/db-hobby/crud-session.svg)

이 "지우지 않고 새로 쓰는" 방식은 실제 PostgreSQL과 닮았어요. PostgreSQL도 UPDATE를 제자리 수정이 아니라 새 튜플 삽입으로 처리해 ctid(=RID)가 바뀌는데, 그 **주된 이유는 가변 길이가 아니라 MVCC**예요 — 옛 버전을 동시에 읽는 트랜잭션이 있을 수 있어 새 버전을 따로 만드는 거죠([13편](/blog/project/db-hobby/db-hobby-13-mvcc)). 가변 길이는 부차적 이유고요. 다만 이게 write amplification(한 번의 UPDATE가 여러 인덱스 쓰기를 부름)을 일으켜서, PostgreSQL은 이를 줄이려 **HOT update**라는 기법을 씁니다.

| | db-hobby UPDATE | PostgreSQL UPDATE | InnoDB UPDATE |
|---|---|---|---|
| 방식 | 옛 행 tombstone + 새 행 삽입 | 옛 튜플 dead + 새 튜플 삽입 | 가능하면 제자리(in-place) + undo |
| RID/주소 | 항상 바뀜 | 바뀜(HOT이면 인덱스 갱신 회피) | PK 불변이면 안 바뀜 |
| 인덱스 갱신 | 모든 인덱스 새 RID | 모든 인덱스(HOT은 예외) | 바뀐 컬럼의 인덱스만 |

> 더 깊이: [DB 스토리지 내부 ③: HOT Update와 Visibility Map](/blog/theory/db-storage-03-hot-update-visibility-map) — UPDATE가 RID(ctid)를 바꿔 인덱스까지 갱신해야 하는 write amplification을, PostgreSQL이 HOT update로 어떻게 줄이는지.

## 7. 정리

SQL 엔진은 "텍스트를 행으로 바꾸는" 세 단계예요. 글자 -> 토큰(렉서) -> AST(파서) -> 힙 연산(실행기). 핵심 설계 선택을 정리하면:

- **렉서** — maximal munch로 두 글자 연산자를 먼저 집고, 식별자를 다 읽은 뒤 키워드 표로 조회해 예약어를 가른다.
- **재귀 하강 파서** — (LL 방식이라) 문법 규칙 하나가 함수 하나. 서브쿼리는 파서의 자기 재귀로 떨어지고, WHERE는 OR-of-AND(DNF 모양)만 받는다(임의 식의 DNF 변환은 아님). 손으로 쓴 파서는 통제·디버깅이 쉽고(SQLite식), 생성기는 큰 문법에서 빛난다(MySQL bison).
- **튜플 코덱** — INT 4바이트 고정, TEXT는 length-prefixed. 길이를 앞에 박아 O(1) 점프·바이너리 안전. 실DB 행 포맷과 같은 발상.
- **실행기** — db-hobby에선 SQL 한 문장이 힙 연산 몇 개로 번역된다(실DB는 그 사이에 옵티마이저가 더 있다). DELETE는 tombstone, UPDATE는 (db-hobby에선 언제나) 삭제+삽입이라 RID가 바뀌어 인덱스를 다시 써야 한다(PostgreSQL은 MVCC 때문에 새 튜플을 쓰고, HOT으로 인덱스 갱신을 줄인다).

이제 SQL이 돌아요. 하지만 `WHERE` 가 매번 모든 행을 훑는 O(n)입니다. 데이터가 100만 행이면 `id = 2` 하나 찾자고 100만 번 비교해요. [다음 편](/blog/project/db-hobby/db-hobby-3-index-wal)에선 이걸 O(log n)으로 줄이는 B+Tree 인덱스를 짓고, 그 위에 전원이 꺼져도 데이터가 안 깨지게 하는 WAL을 붙입니다.

## 참고

- [PostgreSQL Documentation: SQL Syntax — Lexical Structure](https://www.postgresql.org/docs/current/sql-syntax-lexical.html)
- [PostgreSQL Documentation: Database Page Layout (튜플 헤더·varlena)](https://www.postgresql.org/docs/current/storage-page-layout.html)
- [SQLite: The Lemon Parser Generator](https://www.sqlite.org/lemon.html)
- 본 블로그: [DB 스토리지 내부 ③: HOT Update와 Visibility Map](/blog/theory/db-storage-03-hot-update-visibility-map)
- db-hobby 시리즈: [1편 저장 계층](/blog/project/db-hobby/db-hobby-1-storage) · [3편 인덱스·WAL](/blog/project/db-hobby/db-hobby-3-index-wal) · [5편 JOIN·집계·서브쿼리](/blog/project/db-hobby/db-hobby-5-join-aggregate) · [13편 MVCC](/blog/project/db-hobby/db-hobby-13-mvcc)
- [db-hobby 코드 (GitHub)](https://github.com/dj258255/db-hobby)

<!-- EN -->

## 0. Introduction — The Path from Text to Rows

In [Part 1](/blog/project/db-hobby/db-hobby-1-storage) we built the storage layer that "lays rows onto disk and scans them" with a pager, slotted pages, a buffer pool, and a heap. But it cannot take a single character of SQL yet. To insert a row you call a C function by hand; to find one you scan the heap by hand.

This part puts the **SQL frontend** on top — a **parser** that turns text into structure, and an **executor** that connects that structure to the heap. Once it is done, typing `SELECT * FROM users WHERE id = 2` returns the row `2 | lee`, and you get to watch all six layers from Part 1 mesh at once.

> **Goal of this part**: SQL text -> tokens (lexer) -> AST (parser) -> heap operations (executor). We build, step by step in C, the very pipeline most relational DBs use to process a query that arrived as text. (Real DBs insert an **optimizer / plan-generation** layer between the parser and executor; db-hobby folds a tiny version of it into the executor — it shows up properly in [Part 3](/blog/project/db-hobby/db-hobby-3-index-wal) and [Part 8 EXPLAIN](/blog/project/db-hobby/db-hobby-8-explain).)

## 1. The Big Picture — Borrowing a Compiler's Front End

`"SELECT * FROM users WHERE id = 1"` is one sentence to a human but just a run of characters to a computer. Turning it into a **structure (tree)** the executor can handle is the parser's job; connecting that structure to Part 1's heap to return real rows is the executor's.

This flow's **front end (lexing, parsing)** is not a DB invention — it borrows from compilers/interpreters. Splitting source into tokens (lexing) and assembling them into a tree (parsing) are the same in most language processors. But the **back ends diverge** — a compiler heads to code generation, while a DB goes to a query optimizer built on relational algebra and cost estimation: the front ends rhyme, the back ends mostly do not.

| Stage | Compiler term | In db-hobby | Input -> output |
|---|---|---|---|
| 1 | lexing | tokenizer | chars -> tokens |
| 2 | parsing | recursive-descent parser | tokens -> AST |
| 3 | evaluation | executor | AST -> heap ops -> rows |

> **Key fact**: SQL processing can be likened to "a tiny language interpreter" — SQL is the language, the parser the front end, the executor the evaluator. But this analogy fits implementations that run the AST fairly **directly**, like db-hobby or SQLite; PostgreSQL and MySQL do not run the AST as-is — they pass it through rewrite and an optimizer to build a **plan tree**, then run that. db-hobby, being for learning, runs the AST directly, with the "query planner" living as a small branch inside it.

## 2. The Tokenizer (Lexer) — Chars to Tokens

**Stage 1 is the tokenizer (lexer).** It splits the character stream into meaningful **tokens**.

`SELECT * FROM users WHERE id = 1` -> `[SELECT] [*] [FROM] [IDENT:users] [WHERE] [IDENT:id] [=] [INT:1]`.

The lexer does four things:

- skip whitespace.
- group runs of characters (`isalpha`/`isdigit`/`_`) into identifiers or keywords.
- recognize **two-char operators as one token** — `<=`, `<>`, `!=`, `>=`.
- peel `'...'` into a string literal.

db-hobby's comparison-operator handling is a good example. It checks two characters first, then falls back to one.

```c
/* comparison ops (=, !=, <, >, <=, >=). check two chars first. */
if (c == '=' || c == '<' || c == '>' || c == '!') {
    char nx = lx->src[lx->pos + 1];
    if (c == '<' && nx == '=') { lx->pos += 2; t.type = TOK_LE; return t; }
    if (c == '<' && nx == '>') { lx->pos += 2; t.type = TOK_NE; return t; } /* SQL's <> */
    if (c == '>' && nx == '=') { lx->pos += 2; t.type = TOK_GE; return t; }
    if (c == '!' && nx == '=') { lx->pos += 2; t.type = TOK_NE; return t; }
    if (c == '=') { lx->pos++; t.type = TOK_EQ; return t; }
    if (c == '<') { lx->pos++; t.type = TOK_LT; return t; }
    if (c == '>') { lx->pos++; t.type = TOK_GT; return t; }
    t.type = TOK_ERROR; /* lone '!' */
    return t;
}
```

> **Why check two chars first (maximal munch)**: on `<=`, peeling only `<` would leave `=` dangling on its own. The lexer follows the maximal-munch (longest-match) rule — "grab the longest possible token first" — which almost every lexer uses (some languages layer extra tokenization rules on top, like Python's indentation or Go's semicolon insertion).

How keywords split from plain identifiers is another point. db-hobby reads a whole identifier-like chunk **first**, then looks it up once in a table (`keyword_of`) to see if it is reserved. `users` is `TOK_IDENT`; `FROM` is `TOK_FROM`. Case is ignored via `strcasecmp`, so `select` and `SELECT` become the same token.

```c
static TokType keyword_of(const char *s) {
    if (!strcasecmp(s, "SELECT")) return TOK_SELECT;
    if (!strcasecmp(s, "FROM"))   return TOK_FROM;
    if (!strcasecmp(s, "WHERE"))  return TOK_WHERE;
    /* ... CREATE, INSERT, JOIN, GROUP, HAVING, LIKE, BETWEEN, ... */
    return TOK_IDENT; /* not a keyword -> plain identifier (table/column name) */
}
```

> **Practical/interview note**: splitting keywords into token kinds up front keeps the parser from confusing "users is a name and FROM is a keyword". This is why SQL has reserved words — since `SELECT` is a keyword, using a bare `select` as a column name clashes. But rather than "cannot use it at all," you **escape it with quotes**: PostgreSQL `"select"`, MySQL `` `select` ``, SQL Server `[select]`. Real DBs also add non-reserved keywords to allow some bare, but the principle is the same.

## 3. The Recursive-Descent Parser — Tokens to AST

**Stage 2 is the recursive-descent parser.** It assembles tokens into a tree (AST). The charm of recursive descent is that **each grammar rule becomes one function**.

![SQL text -> tokens -> AST](/uploads/project/db-hobby/sql-to-ast.svg)

db-hobby's `parse_select_stmt` reads almost like English — "a SELECT list comes, then FROM must come, then a table name, then JOINs are optional, WHERE is optional, and so are GROUP BY, HAVING, ORDER BY, LIMIT, OFFSET".

```c
static void parse_select_stmt(Parser *p, SelectStmt *s) {
    s->limit = -1;                         /* default for "no LIMIT" */
    parse_select_list(p, s);               /* * or a column/aggregate list */
    p_expect(p, TOK_FROM, "FROM expected");
    parse_name(p, s->table);
    /* ... JOIN clauses ... */
    if (p_accept(p, TOK_WHERE))  parse_where(p, &s->where);
    if (p_accept(p, TOK_GROUP))  { /* GROUP BY ... */ }
    if (p_accept(p, TOK_ORDER))  { /* ORDER BY ... */ }
    if (p_accept(p, TOK_LIMIT))  { /* LIMIT n ... */ }
}
```

The parser rests on exactly three tools — they are basically all of recursive descent.

| Helper | What it does |
|---|---|
| `p_accept(t)` | if the current token is `t`, consume it and return 1; else leave it and return 0 (for optional grammar) |
| `p_expect(t, msg)` | must be `t`; otherwise error with `msg` (for required grammar) |
| `p_advance()` | pull the next token from the lexer |

When grammar nests, functions nest. `WHERE`'s conditions go to `parse_where`, its OR-joined AND-groups to `parse_and_group`, and one condition (`id = 1`) below that. And on a subquery (`WHERE id IN (SELECT ...)`) the parser **calls itself recursively** — `parse_and_group` calls `parse_select_stmt` again. That is the meaning behind the name "recursive descent", and it returns in [Part 5's subqueries](/blog/project/db-hobby/db-hobby-5-join-aggregate).

> **WHERE only accepts OR-of-AND form (this is not DNF conversion)**: db-hobby's WHERE is `term (OR term)*` with each term `cond (AND cond)*`. Since AND binds before OR, `a AND b OR c` parses as `(a AND b) OR c` — declarative precedence expressed as call order. The nuance: this **restricts input** to OR-of-AND (which happens to already be in DNF shape); it does **not normalize** `(a OR b) AND c` into `(a AND c) OR (b AND c)` (db-hobby does not even parse parenthesized WHERE). Sugar like `BETWEEN a AND b` is unfolded right there into `(col >= a) AND (col <= b)` — also db-hobby's choice; PostgreSQL keeps a BETWEEN node in the parse tree and transforms it later.

### Hand-Written Parser vs Parser Generator

A parser can be hand-written, or auto-generated from a grammar by a **parser generator** like yacc/bison or ANTLR.

| | Hand-written recursive descent (db-hobby·SQLite) | Parser generator (yacc/bison) |
|---|---|---|
| Grammar definition | in functions directly (code = grammar) | separate `.y` grammar file |
| Error messages | as you like (free on position/context) | easily stuck with generator defaults |
| Debugging | just follow the functions | must read a generated state machine |
| Large grammar·complex precedence | functions multiply | shines (handled automatically) |
| Adopters | SQLite (its own Lemon), GCC/Clang | MySQL (bison), PostgreSQL (bison) |

Generators shine when the grammar is large and changes often, or operator precedence is complex (MySQL really does use bison). Conversely SQLite uses its own generator Lemon, and hand-written recursive descent is common — because you craft error messages freely and debugging is just following functions, which is easy to control.

> **A design choice**: for learning, hand-writing wins. With one grammar rule as one function right in front of you, "what parsing actually does" is never hidden. The cost is that functions multiply as the grammar grows. db-hobby hand-wrote all the way through JOIN, GROUP BY, and subqueries, and as a result you can see in the code exactly which function each SQL feature is born in.

## 4. The Tuple Codec — Values to Bytes, Bytes to Values

What connects the parser's AST (e.g. `Select{ table:"users", where: id=2 }`) to [Part 1's heap file](/blog/project/db-hobby/db-hobby-1-storage) is the executor. The one thing required in between is the **tuple codec** — an encoder/decoder that turns SQL values into bytes for disk and back.

db-hobby's rule is simple: `INT` is a 4-byte integer (int32), `TEXT` is "2-byte length + that many bytes". So `(1, 'kim')` encodes as `01 00 00 00 | 03 00 | 6B 69 6D` (id=1, length 3, "kim").

![tuple codec — (1, 'kim') encoded to bytes by schema](/uploads/project/db-hobby/tuple-encoding.svg)

```c
/* INT : 4 bytes (int32),  TEXT : 2-byte length + bytes */
if (schema->columns[i].type == COL_INT) {
    int32_t x = (int32_t)v->int_val;
    memcpy(buf + off, &x, 4);
    off += 4;
} else { /* TEXT */
    uint16_t len = (uint16_t)strlen(v->text_val);
    memcpy(buf + off, &len, 2);   /* length prefixed up front */
    off += 2;
    memcpy(buf + off, v->text_val, len);
    off += len;
}
```

Decoding is exactly the reverse — for INT read 4 bytes, for TEXT read the 2-byte length first then that many bytes. Because encode and decode follow the **same schema order**, the byte stream needs no marker for "which part is which column". (Note: `memcpy`-ing the integer raw means the byte order follows the host endianness — fine for learning, but moving the file to a machine of different endianness would break it, which is why real DBs store with a fixed endianness.)

> **Why "length + bytes" for TEXT (length-prefixed)**: you could null-terminate like a C string, but then finding the length means scanning to the end, and an embedded `\0` corrupts it. Stamping the length up front lets you jump "3 bytes from here" in one step.

| | length-prefixed (db-hobby·real DBs) | null-terminated (C string) |
|---|---|---|
| Knowing length | O(1) (front 2 bytes) | O(n) (scan to end) |
| Binary-safe | yes (embedded `\0` ok) | no (cut at `\0`) |
| Jump to next column | one add/multiply | must scan to find position |
| Used by | PostgreSQL varlena, Pascal strings, network protocols | C strings |

This is not my invention but the standard for variable-length data, used from Pascal strings to network protocols to real DB row formats. PostgreSQL's variable-length types (varlena) also carry a length header up front — the same *idea*, but not the same *method*: varlena uses a 1-byte (short) or 4-byte header, and large values get TOASTed out-of-line or even compressed. Fixing integers at 4 bytes is the same idea — the length never varies, so computing the next column's position is just an add.

> **Practical/interview note**: the real db-hobby row format adds two more things — a **null bitmap** (one bit per column, marking which is NULL) and an 8-byte **xmin/xmax header** added in [Part 13 MVCC](/blog/project/db-hobby/db-hobby-13-mvcc). This article focuses on the core INT/TEXT encoding, but the layout "row = header + null bitmap + values" is the same idea as a PostgreSQL tuple.

## 5. The Executor — AST to Heap Operations

On top of this codec, the executor drives Part 1's storage layer per statement kind. In this db-hobby you can watch each SQL statement get translated into a handful of storage-layer operations. A real relational DB inserts more layers in between — an optimizer and plan generation, where SQL's real weight lives — but the basic flow is the same.

| SQL | What the executor does | Storage call |
|---|---|---|
| `CREATE` | record schema in the catalog, create the table file | `catalog_write` |
| `INSERT` | encode values, put into the heap, register index | `encode_row` -> `heap_insert` |
| `SELECT` | scan the heap, decode, filter by `WHERE` | `heap_scan` -> `decode_row` |
| `DELETE` | tombstone the matching rows' slots | `heap_delete` |
| `UPDATE` | delete the old row + insert a new row | `heap_delete` + `heap_insert` |

`INSERT`'s body is genuinely short — one encode, one heap insert, one index register if present.

```c
uint8_t buf[PAGE_SIZE];
uint16_t len;
encode_row(&t->schema, in->values, in->num_values, db->cur_txn, 0, buf, &len);
RID rid;
heap_insert(&t->heap, buf, len, &rid);   /* put the row into Part 1's heap, get an RID */
```

`SELECT` full-scans the heap, receiving one row per callback, decodes it, filters by `WHERE`, and outputs only those that pass. `WHERE id = 2` is O(n) for now — comparing every row (the sequential scan of Part 1, section 5) — and this branch that "evaluates each row to decide whether it passes" is exactly where [the next part](/blog/project/db-hobby/db-hobby-3-index-wal) adds an index, the seed of the **query planner**.

```c
static int select_visit(RID rid, const void *rec, uint16_t len, void *ctx_) {
    SelectCtx *ctx = ctx_;
    Value row[SQL_MAX_COLS];
    decode_row(ctx->schema, rec, row);     /* bytes -> values */
    /* ... evaluate WHERE, output if it passes ... */
    return 0;
}
```

Attach a REPL and you finally type real SQL and get rows back.

![db-hobby REPL session — CREATE/INSERT/SELECT actually working](/uploads/project/db-hobby/repl-session.svg)

Tracing how one line `SELECT * FROM users WHERE id = 2` returns `2 | lee` shows everything built so far meshing — chars become tokens (lexer), tokens become an AST (parser), the AST becomes a heap scan (executor), the scan goes through the buffer pool (cache), pages unpack from slots (slotted page), and they were read from a disk offset (pager). A concert of six layers.

## 6. Completing CRUD — the Traps in DELETE and UPDATE

Adding `DELETE` and `UPDATE` completes CRUD, and both had something to mind ahead of the index (next part).

- **`DELETE`** (in db-hobby) does not really erase a row; it only **tombstones** (marks invalid) the heap slot. As seen in [Part 1](/blog/project/db-hobby/db-hobby-1-storage), this keeps the address an index pointed at via "key -> RID" from breaking. (PostgreSQL also defers erasure, but there it is tangled with MVCC dead tuples and visibility, cleaned later by VACUUM — [Part 13](/blog/project/db-hobby/db-hobby-13-mvcc). db-hobby's tombstone is the simplified version.) The index entry remains, but `heap_get` on that RID returns -1 because it is a tombstone, so the row drops from results naturally — that is why a stale index entry is harmless (the code comment even says "the slot it points to is a tombstone, so heap_get returns -1 and it drops from results automatically").
- **`UPDATE`** is trickier. Since rows are variable-length, in-place editing is **not always possible** (same length or enough free space on the page allows it, but growing 'kim' -> 'alexander' may not fit), so db-hobby simply **always** does **"delete the old row + insert a new row"**. That **changes the RID.** So every index must be updated to the new RID (the RID changes wholesale regardless of which column changed), and skipping this leaves an index pointing at the deleted old location, making the row vanish from queries.

```c
/* UPDATE: db-hobby never edits in place; always delete old row + insert new row */
heap_delete(&t->heap, ctx.rids[i]);
RID newrid;
heap_insert(&t->heap, newbuf, newlen, &newrid);
/* update index to the new RID — else the index points at the deleted old spot and the row vanishes */
if (t->has_index && row[0].type == VAL_INT)
    btree_insert(&t->index, row[0].int_val, rid_encode(newrid));
```

![db-hobby CRUD session — UPDATE turns kim into KIM, DELETE removes id=2, so SELECT leaves one row (KIM)](/uploads/project/db-hobby/crud-session.svg)

This "don't erase, write anew" approach resembles PostgreSQL's. PostgreSQL also handles UPDATE as a new tuple insert so the ctid (= RID) changes — but the **main reason is MVCC, not variable length**: a concurrent transaction may still be reading the old version, so a new version is made alongside it ([Part 13](/blog/project/db-hobby/db-hobby-13-mvcc)). Variable length is a secondary reason. But this causes write amplification (one UPDATE triggers several index writes), so PostgreSQL uses a technique called **HOT update** to reduce it.

| | db-hobby UPDATE | PostgreSQL UPDATE | InnoDB UPDATE |
|---|---|---|---|
| Method | tombstone old + insert new | old tuple dead + insert new | in-place if possible + undo |
| RID/address | always changes | changes (HOT avoids index updates) | unchanged if PK unchanged |
| Index update | all indexes get new RID | all indexes (HOT excepted) | only changed columns' indexes |

> Deeper: [DB Storage Internals ③: HOT Update and the Visibility Map](/blog/theory/db-storage-03-hot-update-visibility-map) — how PostgreSQL's HOT update reduces the write amplification of an UPDATE that changes the RID (ctid) and must update indexes too.

## 7. Wrap-up

The SQL engine is three stages that "turn text into rows": chars -> tokens (lexer) -> AST (parser) -> heap ops (executor). The key design choices:

- **Lexer** — maximal munch grabs two-char operators first; identifiers are read whole then looked up in a keyword table to split off reserved words.
- **Recursive-descent parser** — being LL, one grammar rule, one function. Subqueries fall out of the parser recursing on itself, and WHERE only accepts OR-of-AND (DNF shape), not arbitrary-expression DNF conversion. Hand-written parsers are easy to control and debug (SQLite-style); generators shine on large grammars (MySQL's bison).
- **Tuple codec** — INT fixed at 4 bytes, TEXT length-prefixed. The leading length gives O(1) jumps and binary safety. Same idea as real DB row formats.
- **Executor** — in db-hobby one SQL statement is translated into a few heap ops (a real DB has an optimizer in between). DELETE is a tombstone; UPDATE is (always, in db-hobby) delete+insert, so the RID changes and indexes must be rewritten (PostgreSQL writes a new tuple because of MVCC, and trims index updates with HOT).

SQL runs now. But `WHERE` scans every row, O(n). At a million rows, finding `id = 2` means a million comparisons. [The next part](/blog/project/db-hobby/db-hobby-3-index-wal) builds a B+Tree index to cut that to O(log n), and adds a WAL on top so data survives a power loss.

## References

- [PostgreSQL Documentation: SQL Syntax — Lexical Structure](https://www.postgresql.org/docs/current/sql-syntax-lexical.html)
- [PostgreSQL Documentation: Database Page Layout (tuple header, varlena)](https://www.postgresql.org/docs/current/storage-page-layout.html)
- [SQLite: The Lemon Parser Generator](https://www.sqlite.org/lemon.html)
- This blog: [DB Storage Internals ③: HOT Update and the Visibility Map](/blog/theory/db-storage-03-hot-update-visibility-map)
- db-hobby series: [Part 1 Storage](/blog/project/db-hobby/db-hobby-1-storage) · [Part 3 Index·WAL](/blog/project/db-hobby/db-hobby-3-index-wal) · [Part 5 JOIN·Aggregate·Subquery](/blog/project/db-hobby/db-hobby-5-join-aggregate) · [Part 13 MVCC](/blog/project/db-hobby/db-hobby-13-mvcc)
- [db-hobby on GitHub](https://github.com/dj258255/db-hobby)

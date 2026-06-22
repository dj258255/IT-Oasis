---
title: 'SQL 텍스트를 AST로 — 손으로 쓴 렉서와 파서'
titleEn: 'From SQL Text to an AST — A Hand-Written Lexer and Parser'
description: "저장 계층을 다 만들었으니 이제 위로 올라간다. 'SELECT * FROM users WHERE id = 1' 같은 문자열을 엔진이 다룰 수 있는 구조(AST)로 바꾸는 프런트엔드를, 외부 라이브러리 없이 C로 직접 만든다 — 토크나이저로 토큰을 쪼개고, 재귀 하강 파서로 트리를 조립한다."
descriptionEn: "With the storage layer done, we move up. We build the frontend that turns a string like 'SELECT * FROM users WHERE id = 1' into a structure the engine can act on (an AST), by hand in C — a tokenizer splits it into tokens, and a recursive-descent parser assembles the tree."
date: 2026-06-22
tags:
  - C
  - Database Internals
  - SQL Parser
  - Lexer
  - Devlog
category: project/minidb
coverImage: /uploads/project/minidb/cover.svg
draft: false
series: "minidb"
seriesOrder: 5
---

[4편](/blog/project/minidb/minidb-heap-file)까지 저장 계층을 다 만들었다. 행을 넣고, 전부 훑고, 지우고, 껐다 켜도 남는다. 그런데 지금 테이블에 뭔가 넣으려면 C 함수 `heap_insert(...)`를 직접 불러야 한다. 진짜 DB는 그렇지 않다. **SQL 문자열**을 받는다. 이번엔 그 프런트엔드를 만든다.

## 두 단계: 토큰으로 쪼개고, 트리로 조립한다

`"SELECT * FROM users WHERE id = 1"` 은 사람에겐 한 문장이지만 컴퓨터에겐 그냥 글자의 나열이다. 이걸 구조로 바꾸는 건 두 단계다.

1. **토크나이저(lexer)**: 글자 스트림을 의미 있는 토큰으로 쪼갠다. `SELECT`, `*`, `FROM`, `users`, `WHERE`, `id`, `=`, `1`.
2. **파서(parser)**: 토큰들을 문법에 맞춰 트리(AST)로 조립한다.

![SQL 텍스트가 토큰으로 쪼개지고 다시 AST 트리로 조립되는 흐름](/uploads/project/minidb/sql-to-ast.svg)

## 렉서 — 글자에서 토큰으로

렉서는 위치를 하나씩 옮기며 그 자리의 글자를 보고 토큰을 만든다. 공백은 건너뛰고, `(` `)` `,` `*` `=` `;` 는 그 자체로 토큰, `'...'` 는 문자열, 숫자는 정수, 알파벳으로 시작하면 식별자다. 식별자를 만들고 나서 키워드 표와 대조해 `SELECT`인지 그냥 컬럼 이름인지 가른다(대소문자 무시).

```c
if (isalpha(c) || c == '_') {
    // 식별자 글자를 모은다
    while (isalnum(src[pos]) || src[pos] == '_') t.text[n++] = src[pos++];
    t.type = keyword_of(t.text);   // SELECT? FROM? 아니면 그냥 IDENT
}
```

## 파서 — 재귀 하강

파서는 "지금 토큰이 뭐냐"를 보고 문법 규칙을 따라 내려간다. 이게 **재귀 하강(recursive descent)** — 문법 규칙 하나하나가 함수 하나가 된다. `SELECT` 문 규칙은 거의 영어 그대로 읽힌다.

```c
static void parse_select(Parser *p, Statement *st) {
    p_expect(p, TOK_STAR, "지금은 SELECT * 만 지원합니다");
    p_expect(p, TOK_FROM, "FROM이 필요합니다");
    parse_name(p, st->select.table);
    if (p_accept(p, TOK_WHERE)) {          // WHERE는 있어도 되고 없어도 됨
        st->select.has_where = 1;
        parse_name(p, st->select.where_col);
        p_expect(p, TOK_EQ, "= 가 필요합니다");
        parse_value(p, &st->select.where_val);
    }
}
```

`p_expect`는 "이 토큰이 와야 한다, 아니면 오류"이고, `p_accept`는 "오면 먹고 아니면 말고"다. 오류가 나면 메시지를 남기고 멈춘다 — 진짜 DB가 `syntax error near ...` 를 뱉는 그 자리다.

지원하는 문법은 학습용 최소 부분집합이다. `CREATE TABLE`(INT/TEXT 컬럼), `INSERT INTO ... VALUES`, `SELECT * FROM ... [WHERE col = value]`. 외부 파서 라이브러리 없이 전부 손으로 썼다.

## 검증

세 가지 문장을 파싱해 AST가 제대로 나오는지, 대소문자를 섞어도 되는지, 잘못된 문장은 오류를 내는지 확인했다.

![make test 결과 — SQL 파서 테스트 20개 통과, CREATE/INSERT/SELECT/WHERE와 오류 케이스 포함](/uploads/project/minidb/sql-test-output.svg)

`소문자 키워드도 파싱`, `잘못된 SELECT는 오류` 가 통과한다는 건, 렉서와 파서가 제대로 맞물려 돈다는 뜻이다. 이제 SQL 텍스트가 구조화된 AST가 된다.

## 다음

마지막 조각은 [7] 실행기다. 지금까지의 둘을 잇는다 — **AST + 힙 파일 = 돌아가는 SQL.** `CREATE TABLE`은 스키마(카탈로그)를 만들고, `INSERT`는 값을 스키마대로 바이트로 인코딩해 `heap_insert`하고, `SELECT`는 `heap_scan`으로 훑으며 행을 디코딩하고 `WHERE`로 거른다. 그러면 드디어 진짜 SQL을 타이핑해 결과를 받는 한 바퀴가 완성된다.

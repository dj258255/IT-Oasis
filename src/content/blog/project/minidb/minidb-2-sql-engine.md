---
title: 'SQL 엔진: 파서와 실행기'
titleEn: 'The SQL Engine: Parser and Executor'
description: "관계형 DB를 C로 밑바닥부터 만든 minidb 시리즈 2편. 저장 계층 위에 SQL 프런트엔드를 얹는다. 손으로 쓴 토크나이저와 재귀 하강 파서로 SQL 문자열을 AST로 바꾸고, 실행기가 값을 스키마대로 바이트로 인코딩(tuple codec)해 힙을 훑으며 CREATE/INSERT/SELECT/UPDATE/DELETE를 처리한다. REPL로 진짜 SQL을 타이핑해 결과를 받기까지."
descriptionEn: "Part 2 of building a relational database from scratch in C. On top of the storage layer we add the SQL frontend: a hand-written tokenizer and recursive-descent parser turn SQL text into an AST, and an executor encodes values to bytes (tuple codec) and scans the heap to run CREATE/INSERT/SELECT/UPDATE/DELETE — with a REPL to type real SQL and get rows back."
date: 2026-06-22
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
seriesOrder: 2
---

[1편](/blog/project/minidb/minidb-1-storage)에서 페이저·슬롯 페이지·버퍼 풀·힙으로 "행을 디스크에 얹고 훑는" 저장 계층을 만들었다. 하지만 아직 SQL은 한 글자도 못 받는다. 이번 편은 그 위에 **SQL 프런트엔드** 를 얹는다 — 텍스트를 구조로 바꾸는 파서, 그리고 그 구조를 힙에 연결하는 실행기.

## SQL 파서 — 텍스트를 AST로

`"SELECT * FROM users WHERE id = 1"` 문자열을 구조로 바꾼다. 두 단계다. **토크나이저(lexer)** 가 토큰으로 쪼개고, **재귀 하강 파서** 가 트리(AST)로 조립한다.

![SQL 텍스트 -> 토큰 -> AST](/uploads/project/minidb/sql-to-ast.svg)

재귀 하강은 문법 규칙 하나하나가 함수 하나가 된다. `SELECT` 규칙은 거의 영어 그대로 읽힌다 — "STAR가 와야 하고, FROM이 와야 하고, 이름이 오고, WHERE는 있어도 되고". 외부 파서 라이브러리 없이 손으로 썼다.

## 실행기와 REPL — SELECT가 행을 돌려준다

파서의 AST와 힙 파일을 잇는 게 실행기다. 값을 스키마대로 바이트로 인코딩하고(tuple codec: INT 4바이트, TEXT 길이+바이트), `CREATE`는 스키마를 만들고, `INSERT`는 `heap_insert`하고, `SELECT`는 `heap_scan`으로 훑으며 `WHERE`로 거른다.

![tuple codec — (1, 'kim')이 스키마대로 바이트열로 인코딩](/uploads/project/minidb/tuple-encoding.svg)

REPL을 붙이면 드디어 진짜 SQL을 타이핑해 결과를 받는다.

![minidb REPL 세션 — CREATE/INSERT/SELECT가 실제로 동작](/uploads/project/minidb/repl-session.svg)

`SELECT * FROM users WHERE id = 2` 가 `2 | lee` 를 돌려주기까지, 글자가 토큰이 되고(렉서), 토큰이 AST가 되고(파서), AST가 힙 스캔이 되고(실행기), 스캔이 버퍼 풀을 거쳐(캐시), 페이지가 슬롯에서 풀려(슬롯 페이지), 디스크 오프셋에서 읽혔다(페이저). 여섯 계층이 전부 맞물린 결과다.

실행기에는 `DELETE` 와 `UPDATE` 도 붙여 CRUD를 완성했다. `DELETE` 는 힙 슬롯을 tombstone하고(인덱스 항목은 남아도 `heap_get` 이 -1을 돌려줘 무해하다), `UPDATE` 는 가변 길이라 "삭제 + 재삽입" 으로 처리한 뒤 **인덱스를 새 위치(RID)로 갱신** 한다 — 안 하면 옮겨진 행이 인덱스에서 사라진다.

![minidb CRUD 세션 — UPDATE로 kim을 KIM으로, DELETE로 id=2를 지우면 SELECT에 1행(KIM)만 남는다](/uploads/project/minidb/crud-session.svg)

---

이제 SQL이 돈다. 하지만 `WHERE` 가 매번 모든 행을 훑는 O(n)이다. [다음 편](/blog/project/minidb/minidb-3-index-wal)에선 이걸 O(log n)으로 줄이는 B+Tree 인덱스를 짓고, 전원이 꺼져도 데이터가 안 깨지게 하는 WAL을 붙인다.

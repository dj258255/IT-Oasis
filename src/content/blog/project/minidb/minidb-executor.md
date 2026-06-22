---
title: '드디어 SELECT가 행을 돌려준다 — 실행기와 REPL'
titleEn: 'SELECT Finally Returns Rows — The Executor and REPL'
description: "파서가 만든 AST와 힙 파일을 잇는 마지막 조각, 실행기. 값을 스키마대로 바이트로 인코딩하고(tuple codec), CREATE는 스키마를 만들고, INSERT는 heap_insert하고, SELECT는 heap_scan으로 훑으며 WHERE로 거른다. REPL에 SQL을 타이핑하면 진짜로 행이 나온다 — 6편에 걸쳐 밑바닥부터 만든 미니 데이터베이스가 한 바퀴를 닫는다."
descriptionEn: "The final piece that connects the parser's AST to the heap file: the executor. It encodes values per schema (a tuple codec), CREATE stores a schema, INSERT calls heap_insert, and SELECT scans, decodes, and filters by WHERE. Type SQL into the REPL and rows actually come back — closing the loop on a mini database built from scratch over six posts."
date: 2026-06-22
tags:
  - C
  - Database Internals
  - Executor
  - SQL
  - Devlog
category: project/minidb
coverImage: /uploads/project/minidb/cover.svg
draft: false
series: "minidb"
seriesOrder: 6
---

여기까지 왔다. [저장 계층](/blog/project/minidb/minidb-heap-file)으로 행을 디스크에 담고, [파서](/blog/project/minidb/minidb-sql-parser)로 SQL을 AST로 바꿨다. 이제 둘을 잇는 마지막 조각, **실행기(executor)** 다. 실행기가 붙으면 드디어 SQL을 타이핑해 진짜 결과를 받는다.

## 실행기가 하는 일 = AST를 보고 저장 계층을 부린다

실행기는 파서가 만든 AST를 받아, 종류별로 저장 계층을 호출한다.

- **CREATE**: 스키마(컬럼 이름·타입)를 기록한다. 이게 카탈로그다.
- **INSERT**: 값을 스키마대로 바이트로 인코딩해 `heap_insert`.
- **SELECT**: `heap_scan`으로 모든 행을 훑으며 디코딩하고, `WHERE`로 거른 뒤 출력.

## 값을 바이트로 — tuple codec

행을 디스크에 넣으려면 `(1, 'kim')` 같은 값들을 바이트열로 바꿔야 한다. 규칙은 스키마가 정한다. INT는 4바이트, TEXT는 길이(2바이트) + 글자들.

![tuple codec — (1, 'kim')이 스키마(id INT, name TEXT)에 따라 바이트열로 인코딩되는 모습](/uploads/project/minidb/tuple-encoding.svg)

읽을 땐 거꾸로 한다. 행 바이트와 스키마를 함께 보고, "앞 4바이트는 INT, 그다음 2바이트는 길이, 그만큼이 TEXT" 하고 디코딩한다. 스키마가 없으면 바이트열은 그냥 의미 없는 숫자다 — 그래서 카탈로그가 필요하다.

`SELECT`의 `WHERE id = 2` 는 스캔하면서 각 행을 디코딩해 해당 컬럼 값을 꺼내 비교하는 것뿐이다.

```c
// heap_scan의 콜백: 행 하나를 디코딩하고 WHERE로 거른다
Value row[SQL_MAX_COLS];
decode_row(schema, rec, row);
if (!match_where(schema, sel, row)) return 0;   // 안 맞으면 건너뜀
print_row(out, schema, row);                     // 맞으면 출력
```

(지금은 `WHERE`가 있어도 풀 스캔을 한 뒤 거른다. 인덱스가 없으니까. 다음 단계의 B-Tree가 바로 이 풀 스캔을 피하려는 것이다.)

## 그래서 — 진짜로 돈다

REPL을 붙였다. SQL을 한 줄씩 받아 실행한다. 6편에 걸쳐 만든 것이 이 한 화면에서 한 바퀴를 닫는다.

![minidb REPL 세션 — CREATE TABLE, INSERT 3번, SELECT *가 3행, SELECT WHERE id=2가 lee 한 행을 반환](/uploads/project/minidb/repl-session.svg)

`SELECT * FROM users WHERE id = 2` 가 `2 | lee` 를 돌려준다. 이 한 줄이 나오기까지, 글자가 토큰이 되고(렉서), 토큰이 AST가 되고(파서), AST가 힙 스캔이 되고(실행기), 스캔이 버퍼 풀을 거쳐(캐시), 페이지가 슬롯에서 풀려(슬롯 페이지), 디스크 오프셋에서 읽혔다(페이저). **여섯 계층이 전부 맞물려 돈 결과다.**

## 정직한 한계, 그리고 다음

학습용이라 단순화한 게 많다. 스키마(카탈로그)는 메모리에만 있어서 프로그램을 껐다 켜면 다시 `CREATE TABLE` 해줘야 한다(행 자체는 디스크에 남는다). `SELECT *` 만 되고, `WHERE`는 등호 비교 하나뿐이다. 동시성도 트랜잭션도 없다.

그래서 다음 단계가 분명하다. [8] **B-Tree 인덱스** — 풀 스캔 대신 O(log n) 조회. [9] **WAL과 트랜잭션** — 쓰다가 죽어도 복구되는 내구성, 그리고 동시 접근. 그리고 카탈로그를 디스크에 진짜 시스템 테이블로 저장하는 것(`pg_catalog`처럼).

## 닫으며

새로운 걸 발명하려다 시작했지만, 결국 더 값진 걸 했다. PostgreSQL·MySQL이 매일 하는 일 — 글자를 받아 페이지를 읽고 행을 돌려주는 그 일 — 을 밑바닥부터 한 겹씩 직접 만들며 이해했다. 페이지, 슬롯, 버퍼 풀, 힙, 파서, 실행기. 이제 `SELECT`를 칠 때마다 그 아래에서 무슨 일이 벌어지는지 안다. 그거면 충분하다.

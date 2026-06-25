---
title: 'SQL 엔진: 파서와 실행기'
titleEn: 'The SQL Engine: Parser and Executor'
description: "관계형 DB를 C로 밑바닥부터 만든 minidb 시리즈 2편. 저장 계층 위에 SQL 프런트엔드를 얹는다. 손으로 쓴 토크나이저와 재귀 하강 파서로 SQL 문자열을 AST로 바꾸고, 실행기가 값을 스키마대로 바이트로 인코딩(tuple codec)해 힙을 훑으며 CREATE/INSERT/SELECT/UPDATE/DELETE를 처리한다. REPL로 진짜 SQL을 타이핑해 결과를 받기까지."
descriptionEn: "Part 2 of building a relational database from scratch in C. On top of the storage layer we add the SQL frontend: a hand-written tokenizer and recursive-descent parser turn SQL text into an AST, and an executor encodes values to bytes (tuple codec) and scans the heap to run CREATE/INSERT/SELECT/UPDATE/DELETE — with a REPL to type real SQL and get rows back."
date: 2026-05-15
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

[1편](/blog/project/minidb/minidb-1-storage)에서 페이저·슬롯 페이지·버퍼 풀·힙으로 "행을 디스크에 얹고 훑는" 저장 계층을 만들었다.
하지만 아직 SQL은 한 글자도 못 받는다.
이번 편은 그 위에 **SQL 프런트엔드** 를 얹는다 — 텍스트를 구조로 바꾸는 파서, 그리고 그 구조를 힙에 연결하는 실행기.

## SQL 파서 — 텍스트를 AST로

`"SELECT * FROM users WHERE id = 1"` 은 사람에겐 한 문장이지만 컴퓨터에겐 그냥 글자 나열이다.
이걸 실행기가 다룰 수 있는 **구조(트리)** 로 바꾸는 게 파서다.
모든 컴파일러·인터프리터가 그렇듯 두 단계로 나뉜다.

**1단계 — 토크나이저(lexer).** 글자 스트림을 의미 단위 **토큰**으로 쪼갠다.
`SELECT * FROM users WHERE id = 1` -> `[SELECT] [*] [FROM] [IDENT:users] [WHERE] [IDENT:id] [=] [INT:1]`.
공백을 건너뛰고, 연속된 글자를 식별자/키워드로 묶고, `<=`·`!=` 같은 두 글자 연산자를 한 토큰으로 인식하고, `'...'` 안을 문자열 리터럴로 떼낸다.
키워드(SELECT/FROM/…)와 일반 식별자(테이블·컬럼 이름)는 토큰 종류로 구분해 두면, 파서가 "users는 이름이고 FROM은 키워드"임을 헷갈리지 않는다.

**2단계 — 재귀 하강 파서(recursive descent).** 토큰을 트리(AST)로 조립한다.
재귀 하강의 묘미는 **문법 규칙 하나하나가 함수 하나**가 된다는 것이다.

![SQL 텍스트 -> 토큰 -> AST](/uploads/project/minidb/sql-to-ast.svg)

`parse_select`는 거의 영어 그대로 읽힌다 — "STAR(또는 컬럼 목록)가 와야 하고, FROM이 와야 하고, 테이블 이름이 오고, WHERE는 있어도 되고, ORDER BY·LIMIT도 있어도 되고".
`WHERE`의 조건은 `parse_where`가, 그 안의 한 조건(`id = 1`)은 또 다른 함수가 맡는다.
문법이 중첩되면 함수가 중첩 호출되고, 나중에 서브쿼리(`WHERE id IN (SELECT ...)`)를 붙일 때는 파서가 **자기 자신을 재귀 호출**한다 — 그게 [5편 서브쿼리](/blog/project/minidb/minidb-5-join-aggregate)에서 다시 나온다.

파서는 손으로 짤 수도, yacc/bison·ANTLR 같은 **파서 생성기**로 문법만 적어 자동 생성할 수도 있다.
생성기는 문법이 크고 자주 바뀔 때, 또 연산자 우선순위가 복잡할 때 빛난다(실제로 MySQL은 bison을 쓴다).
반대로 SQLite는 자체 생성기(Lemon)를 쓰고, 손으로 쓴 재귀 하강도 흔하다 — 에러 메시지를 마음대로 만들고, 디버깅이 그냥 함수 따라가기라 통제하기 쉽다는 이유로.
나는 둘 다 해본 입장에서 학습용엔 손으로 쓰는 쪽이 낫다고 본다.
문법 규칙 하나가 함수 하나로 눈앞에 있으니 "파싱이 대체 뭘 하는지"가 가려지지 않는다.
대신 문법이 커지면 함수가 늘어나는 건 감수해야 한다.

## 실행기 — AST를 힙에 연결

파서가 만든 AST(예: `Select{ table:"users", where: id=2 }`)와 [1편의 힙 파일](/blog/project/minidb/minidb-1-storage)을 잇는 게 실행기다.
핵심 한 가지는 **튜플 코덱(tuple codec)** — SQL 값을 디스크에 넣을 바이트열로, 또 그 반대로 바꾸는 인코더/디코더다.
minidb의 규칙은 단순하다: `INT`는 4바이트 정수(int32), `TEXT`는 "2바이트 길이 + 그 길이만큼의 바이트".
그래서 `(1, 'kim')`은 `01 00 00 00 | 03 00 | 6B 69 6D`(id=1, 길이 3, "kim")으로 인코딩된다.

TEXT를 왜 "길이 + 바이트"로 했나.
C 문자열처럼 끝에 `\0`를 붙이는 방법(널 종료)도 있는데, 그러면 길이를 알려고 끝까지 스캔해야 하고 문자열 안에 `\0`가 섞이면 깨진다.
길이를 앞에 박아두면 한 번에 "여기서 3바이트"라고 점프할 수 있다.
이건 내가 발명한 게 아니라 가변 길이 데이터의 정석(length-prefixed)이고, Pascal 문자열부터 네트워크 프로토콜, 그리고 실제 DB의 행 포맷까지 다 이 방식이다.
정수를 고정 4바이트로 둔 것도 마찬가지 — 길이가 안 변하니 위치 계산이 곱셈으로 끝난다.

![tuple codec — (1, 'kim')이 스키마대로 바이트열로 인코딩](/uploads/project/minidb/tuple-encoding.svg)

이 코덱 위에서 실행기는 문장 종류대로 저장 계층을 부린다.
`CREATE`는 스키마(카탈로그)를 기록하고, `INSERT`는 값을 인코딩해 `heap_insert`로 넣고, `SELECT`는 `heap_scan`으로 힙을 훑으며 디코딩한 행을 `WHERE`로 거른다.
`WHERE id = 2`는 지금은 그냥 모든 행을 풀 스캔하며 비교하는 O(n)인데, 다음 편에서 인덱스를 붙여 이 분기가 곧 **쿼리 플래너**의 씨앗이 된다.

REPL을 붙이면 드디어 진짜 SQL을 타이핑해 결과를 받는다.

![minidb REPL 세션 — CREATE/INSERT/SELECT가 실제로 동작](/uploads/project/minidb/repl-session.svg)

`SELECT * FROM users WHERE id = 2` 한 줄이 `2 | lee` 를 돌려주기까지의 길을 따라가 보면 지금까지 만든 게 전부 맞물린다 — 글자가 토큰이 되고(렉서), 토큰이 AST가 되고(파서), AST가 힙 스캔이 되고(실행기), 스캔이 버퍼 풀을 거쳐(캐시), 페이지가 슬롯에서 풀려(슬롯 페이지), 디스크 오프셋에서 읽혔다(페이저).
여섯 계층의 합주다.

## CRUD 완성 — DELETE와 UPDATE의 함정

`DELETE`와 `UPDATE`를 붙여 CRUD를 완성했는데, 둘 다 인덱스(다음 편) 때문에 미리 신경 쓸 게 있었다.

- **`DELETE`** 는 행을 실제로 지우지 않고 힙 슬롯을 **tombstone**(무효 표시)만 한다. [1편](/blog/project/minidb/minidb-1-storage)에서 본 대로, 인덱스가 "키 -> RID"로 가리키던 주소를 깨지 않기 위해서다. 인덱스 항목은 그대로 남지만, 그 RID로 `heap_get`을 하면 tombstone이라 -1을 돌려줘 결과에서 자연히 빠진다 — stale 인덱스 항목이 무해해지는 이유다.
- **`UPDATE`** 는 더 까다롭다. 행이 가변 길이라(예: 'kim' -> 'alexander') 제자리 수정이 안 될 수 있어, "옛 행 삭제 + 새 행 삽입"으로 처리한다. 그러면 **RID가 바뀐다.** 그래서 인덱스를 새 RID로 갱신해야 하는데, 이걸 빼먹으면 인덱스가 삭제된 옛 위치를 가리켜 그 행이 쿼리에서 사라진다. (실제 PostgreSQL은 이 write amplification을 줄이려 HOT update라는 기법을 쓴다 — 아래 링크.)

![minidb CRUD 세션 — UPDATE로 kim을 KIM으로, DELETE로 id=2를 지우면 SELECT에 1행(KIM)만 남는다](/uploads/project/minidb/crud-session.svg)

> 더 깊이: [DB 스토리지 내부 ③: HOT Update와 Visibility Map](/blog/theory/db-storage-03-hot-update-visibility-map) — UPDATE가 RID(ctid)를 바꿔 인덱스까지 갱신해야 하는 write amplification을, PostgreSQL이 HOT update로 어떻게 줄이는지.

---

이제 SQL이 돈다.
하지만 `WHERE` 가 매번 모든 행을 훑는 O(n)이다.
데이터가 100만 행이면 `id = 2` 하나 찾자고 100만 번 비교한다.
[다음 편](/blog/project/minidb/minidb-3-index-wal)에선 이걸 O(log n)으로 줄이는 B+Tree 인덱스를 짓고, 그 위에 전원이 꺼져도 데이터가 안 깨지게 하는 WAL을 붙인다.

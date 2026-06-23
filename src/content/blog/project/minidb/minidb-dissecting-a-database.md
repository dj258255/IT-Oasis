---
title: '진짜 데이터베이스를 C로 밑바닥부터 만들기 — minidb 전 과정'
titleEn: 'Building a Real Database from Scratch in C — The Whole minidb'
description: "PostgreSQL·MySQL이 내부에서 어떻게 동작하는지 제대로 이해하고 싶어서, 그 구조를 C로 한 겹씩 직접 만들었다. 고정 크기 페이지부터 슬롯 페이지·버퍼 풀·힙·SQL 파서·실행기·B+Tree 인덱스·WAL·트랜잭션까지 — 밑바닥부터 쌓아 CREATE/INSERT/SELECT/UPDATE/DELETE와 BEGIN/COMMIT/ROLLBACK이 도는 미니 관계형 DB를 만든 전 과정을 한 글에 담았다."
descriptionEn: "To really understand how PostgreSQL and MySQL work inside, I built their structure in C, one layer at a time — from fixed-size pages up through slotted pages, a buffer pool, a heap, a SQL parser and executor, a B+Tree index, a write-ahead log, and transactions. This single post walks the whole thing: a mini relational database from scratch where CREATE/INSERT/SELECT/UPDATE/DELETE and BEGIN/COMMIT/ROLLBACK actually run."
date: 2026-06-22
tags:
  - C
  - Database Internals
  - Storage Engine
  - B-Tree
  - SQL
  - WAL
  - Learning
coverImage: /uploads/project/minidb/cover.svg
draft: false
---

데이터베이스를 직접 만들어보고 싶었다. 처음엔 "세상에 없는 새로운 DB"를 찾아 한참 헤맸는데, 파고들수록 분명해진 게 있다. 인프라 영역은 거의 다 누군가 이미 잘 만들어놨고, "아무도 안 한 빈칸"은 사실상 유니콘이다. 그래서 목표를 바꿨다. 새로운 걸 발명하는 대신, **이미 있는 진짜를 정확히 재현하면서 그 구조를 손으로 이해하기.**

그렇게 만든 게 **minidb** 다. PostgreSQL·MySQL 같은 관계형 DB가 내부에서 어떻게 동작하는지를, C로 한 겹씩 직접 구현하며 해부한 학습 프로젝트다. 이 글은 9개 계층을 밑바닥부터 쌓아 올린 전 과정을 한 번에 담는다. 각 계층은 전부 테스트로 검증했다(총 127개).

## 전체 지도

DB는 한 덩어리가 아니라 여러 계층의 합이다. 위에서 아래로 이렇게 쌓인다.

```
 SQL 텍스트
   |
   v [1] Parser      토크나이저 + 파서 -> AST
   v [2] Planner     AST -> 실행 계획 (풀스캔 vs 인덱스)
   v [3] Executor    계획 실행
   |
   v [4] Catalog     스키마 메타데이터
   v [5] Access      Heap(테이블) + B-Tree(인덱스)
   v [6] Buffer Pool 페이지 캐시 + LRU 교체
   v [7] Page        슬롯 페이지: 행을 고정 크기 페이지에 패킹
   v [8] Pager/Disk  페이지 <-> 단일 파일
   v [9] WAL         쓰기 선행 로그 + 크래시 복구
```

핵심 사실: **모든 것은 고정 크기 페이지 위에 쌓인다.** (PostgreSQL 8KB, MySQL InnoDB 16KB, SQLite 4KB.) 그래서 맨 아래(페이저)부터 짓는다.

**왜 C인가.** 목표가 "진짜 구조를 있는 그대로 해부"라면, 진짜 DB가 쓰는 언어로 하는 게 맞다. DB 내부는 메모리·포인터·바이트 레이아웃이 곧 학습 내용인데, 언어가 이걸 추상화로 가리면 정작 배우려는 걸 못 본다. C는 아무것도 안 가린다.

---

## 1. 페이저 — 페이지를 디스크에 읽고 쓰기

가장 밑바닥. 페이저는 "page_id로 페이지를 읽고 쓴다"만 책임진다. 페이지를 고정 크기로 잡으면 N번 페이지의 디스크 위치는 곱셈 한 번으로 정해진다.

```c
int pager_read(Pager *p, page_id_t id, void *buf) {
    off_t offset = (off_t)id * PAGE_SIZE;   // N번 페이지 = N * 4096
    ssize_t n = pread(p->fd, buf, PAGE_SIZE, offset);
    return (n == (ssize_t)PAGE_SIZE) ? 0 : -1;
}
```

다섯 줄짜리 이 곱셈이 PostgreSQL·MySQL·SQLite가 전부 그 위에 서 있는 토대다.

![페이저 테스트 — 라운드트립 + 재오픈 영속성 11개 통과](/uploads/project/minidb/pager-test-output.svg)

## 2. 슬롯 페이지 — 4096바이트 안에 행 욱여넣기

페이지는 아직 그냥 바이트 덩어리다. 가변 길이 행 여러 개를 한 페이지에 넣으려면 **슬롯 페이지** 가 필요하다. PostgreSQL heap·InnoDB 페이지가 이 구조다. 헤더 뒤로 슬롯 배열이 아래로 자라고, 레코드는 끝에서 위로 자라며, 가운데가 빈 공간이다.

![슬롯 페이지 레이아웃 — 슬롯 배열은 아래로, 레코드는 위로, 가운데 빈 공간](/uploads/project/minidb/slotted-page-layout.svg)

묘수는 **슬롯 번호가 행의 안정적인 주소**가 된다는 것이다. 레코드가 페이지 안에서 옮겨져도 슬롯 번호는 안 바뀐다 — 이게 PostgreSQL의 TID, InnoDB 레코드 포인터의 기반이다.

## 3. 버퍼 풀 — 디스크를 매번 때리지 않기

페이지를 매번 디스크에서 읽으면 느리다. 버퍼 풀은 자주 쓰는 페이지를 메모리에 캐시하고 꽉 차면 LRU로 교체한다(InnoDB buffer pool). 단순 캐시와 DB 버퍼 풀의 차이는 세 가지다: **pin count**(쓰는 중인 페이지는 못 쫓아냄), **dirty 플래그**(수정된 페이지는 쫓겨나기 전에 디스크로 flush), **LRU**(가장 안 쓴 걸 victim으로).

![버퍼 풀 — 프레임(page/pin/dirty/LRU), miss는 디스크 로드, dirty면 evict 시 flush](/uploads/project/minidb/buffer-pool.svg)

이 셋이 "캐시인데 데이터가 안 깨지는" 비결이다.

## 4. 힙 파일 — 드디어 테이블

페이저·슬롯 페이지·버퍼 풀을 묶으면 **테이블** 이 나온다. 힙 파일은 순서 없는 페이지들의 모음이다. 행을 넣으면 마지막 페이지에 들어가고, 꽉 차면 새 페이지를 할당한다. 행의 주소는 **RID = (page_id, slot)**.

![힙 파일 — 여러 페이지에 행이 슬롯으로 담기고, full scan은 모든 페이지를 훑는다](/uploads/project/minidb/heap-file.svg)

`SELECT * FROM t` 의 가장 기본 형태인 풀 스캔은 모든 페이지의 모든 슬롯을 훑는 이중 루프다. 모든 관계형 DB의 출발점이고, 나중에 인덱스를 붙이는 이유가 바로 이걸 피하기 위해서다.

## 5. SQL 파서 — 텍스트를 AST로

여기서부터 위쪽(프런트엔드)이다. `"SELECT * FROM users WHERE id = 1"` 문자열을 구조로 바꾼다. 두 단계다. **토크나이저(lexer)** 가 토큰으로 쪼개고, **재귀 하강 파서** 가 트리(AST)로 조립한다.

![SQL 텍스트 -> 토큰 -> AST](/uploads/project/minidb/sql-to-ast.svg)

재귀 하강은 문법 규칙 하나하나가 함수 하나가 된다. `SELECT` 규칙은 거의 영어 그대로 읽힌다 — "STAR가 와야 하고, FROM이 와야 하고, 이름이 오고, WHERE는 있어도 되고". 외부 파서 라이브러리 없이 손으로 썼다.

## 6. 실행기와 REPL — SELECT가 행을 돌려준다

파서의 AST와 힙 파일을 잇는 게 실행기다. 값을 스키마대로 바이트로 인코딩하고(tuple codec: INT 4바이트, TEXT 길이+바이트), `CREATE`는 스키마를 만들고, `INSERT`는 `heap_insert`하고, `SELECT`는 `heap_scan`으로 훑으며 `WHERE`로 거른다.

![tuple codec — (1, 'kim')이 스키마대로 바이트열로 인코딩](/uploads/project/minidb/tuple-encoding.svg)

REPL을 붙이면 드디어 진짜 SQL을 타이핑해 결과를 받는다.

![minidb REPL 세션 — CREATE/INSERT/SELECT가 실제로 동작](/uploads/project/minidb/repl-session.svg)

`SELECT * FROM users WHERE id = 2` 가 `2 | lee` 를 돌려주기까지, 글자가 토큰이 되고(렉서), 토큰이 AST가 되고(파서), AST가 힙 스캔이 되고(실행기), 스캔이 버퍼 풀을 거쳐(캐시), 페이지가 슬롯에서 풀려(슬롯 페이지), 디스크 오프셋에서 읽혔다(페이저). 여섯 계층이 전부 맞물린 결과다.

실행기에는 `DELETE` 와 `UPDATE` 도 붙여 CRUD를 완성했다. `DELETE` 는 힙 슬롯을 tombstone하고(인덱스 항목은 남아도 `heap_get` 이 -1을 돌려줘 무해하다), `UPDATE` 는 가변 길이라 "삭제 + 재삽입" 으로 처리한 뒤 **인덱스를 새 위치(RID)로 갱신** 한다 — 안 하면 옮겨진 행이 인덱스에서 사라진다.

![minidb CRUD 세션 — UPDATE로 kim을 KIM으로, DELETE로 id=2를 지우면 SELECT에 1행(KIM)만 남는다](/uploads/project/minidb/crud-session.svg)

## 7. B+Tree 인덱스 — 풀 스캔을 피하기

`WHERE` 가 모든 행을 훑으면 O(n)이다. **인덱스** 로 O(log n)에 찾아간다. B+Tree는 내부 노드(길잡이: 키 + 자식)와 리프 노드(실제 키·값, 옆으로 연결됨)로 된 균형 트리다.

![B+Tree 구조 — 내부 노드에서 리프로 내려가는 검색 경로](/uploads/project/minidb/btree-diagram.svg)

어려운 부분은 **노드 분할(split)** 이다. 리프가 꽉 차면 반으로 쪼개고 가운데 키를 부모로 올린다. 루트까지 올라가 루트가 쪼개지면 트리 높이가 1 자란다 — 그래서 모든 리프가 항상 같은 깊이에 있고, 트리가 한쪽으로 안 기운다. 디스크에 저장되는 B+Tree를 직접 짜고, 키 1000개를 넣어 다단계 분할을 일으킨 뒤 오름차순 스캔으로 구조 무결성을 증명했다.

그리고 이 인덱스를 실행기에 연결했다. INSERT는 `(PK -> RID)` 를 인덱스에 등록하고, `WHERE id = 2` 처럼 인덱스된 컬럼을 쓰면 풀 스캔 대신 `btree_search` -> `heap_get` 한 줄만 읽는다. "쓸 수 있으면 인덱스를 쓴다"는 이 분기가 **쿼리 플래너의 가장 단순한 형태** 다. `WHERE`는 `=` 외에 `<` `>` `<=` `>=` `!=` 도 받는데, `=` 는 인덱스 점 조회로 한 줄을 집고, `<` `>` `<=` `>=` 는 B+Tree의 연결된 리프 체인을 따라 **범위 스캔**한다 — 리프를 옆으로 이어둔 게 이때 빛난다(`id > 5`면 5의 리프로 내려가 거기서부터 옆으로 읽으면 끝). `!=`·비PK·복합 조건은 풀 스캔. 연산자에 따라 실행 계획이 갈리는 게 곧 플래너가 하는 일이다. 조건은 `AND`로 여러 개를 묶을 수도 있다(`WHERE id > 1 AND name != 'kim'`).

## 8. WAL — 쓰다가 전원이 꺼져도

마지막 정체성, 내구성과 원자성. 데이터 파일을 고치는 도중 전원이 꺼지면 파일이 깨질 수 있다. **WAL(Write-Ahead Log)** 은 데이터를 고치기 전에 바뀔 내용을 로그에 먼저 적고 fsync 한다.

![WAL 흐름 — stage -> 로그+커밋마커 fsync(내구성 분기점) -> 데이터 적용 -> 로그 비움](/uploads/project/minidb/wal-flow.svg)

복구 규칙은 단 하나다. 재시작 시 로그에 **커밋 마커가 있으면 데이터에 재적용(redo), 없으면 버린다(rollback).** 테스트에서 정확히 두 위험한 순간에 크래시를 주입했다 — 커밋 마커 fsync 직후(데이터 적용 전)에 멈추면 복구가 redo하고(내구성), 커밋 마커 전에 멈추면 복구가 버린다(원자성). 전원이 꺼져도 데이터가 안 깨진다는 걸 실제로 크래시를 일으켜 증명했다.

![WAL 테스트 — 커밋 후 크래시 redo, 커밋 전 크래시 discard 6개 통과](/uploads/project/minidb/wal-test-output.svg)

---

## 9. 트랜잭션 — BEGIN / COMMIT / ROLLBACK

WAL이 원자성·내구성의 원리를 줬으니, 이제 SQL 레벨에서 묶음 작업을 다룬다. 여러 변경을 한 단위로 묶어 전부 확정(COMMIT)하거나 전부 되돌린다(ROLLBACK).

구현은 **no-steal + 커밋 시 force** 정책이다. 트랜잭션 중 바뀐 페이지는 버퍼 풀 메모리에만 두고 디스크엔 안 흘린다(no-steal). `COMMIT`이면 flush + fsync 해서 확정하고, `ROLLBACK`이면 dirty 프레임을 버리고 트랜잭션이 할당한 페이지를 잘라 디스크 원본 상태로 되돌린다. 핵심은 **힙과 B+Tree 인덱스를 둘 다 되돌린다**는 것 — 그래야 롤백한 INSERT가 행도, 인덱스 항목도 남기지 않는다.

![minidb 트랜잭션 세션 — BEGIN 후 INSERT한 lee를 ROLLBACK하면 SELECT에 1행(kim)만 남는다](/uploads/project/minidb/txn-session.svg)

`BEGIN` 으로 시작해 `lee` 를 넣고 `ROLLBACK` 하니, `SELECT` 에는 `kim` 한 줄만 남는다. `lee` 는 행도 인덱스도 흔적 없이 사라졌다. (학습용이라 격리 수준·동시성 — ACID의 I — 은 없다. 한 번에 한 트랜잭션이다.)

## 닫으며

새로운 걸 발명하진 않았다. 대신 PostgreSQL·MySQL이 매일 하는 일 — 글자를 받아 페이지를 읽고 행을 돌려주는 그 일 — 을 밑바닥부터 한 겹씩 직접 만들며 이해했다. 페이지에 저장하고(페이저·슬롯 페이지), 메모리에 캐시하고(버퍼 풀), 테이블로 묶고(힙), SQL을 받고(파서·실행기), 빠르게 찾고(B+Tree), 전원이 꺼져도 안 깨지고(WAL), 묶음 작업을 원자적으로 처리한다(트랜잭션).

이제 `SELECT` 를 칠 때마다 그 아래 계층들에서 무슨 일이 벌어지는지 안다. 그게 이 프로젝트의 전부였다.

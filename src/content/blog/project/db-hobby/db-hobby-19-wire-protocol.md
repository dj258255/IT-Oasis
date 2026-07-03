---
title: '진짜 psql이 내 C DB에 붙는다 — PostgreSQL wire protocol 서버'
titleEn: 'Real psql Connects to My C Database — a PostgreSQL Wire Protocol Server'
description: "18편까지 db-hobby는 로컬 REPL 하나였다. 진짜 DB는 TCP로 여러 클라이언트를 받는다. 이번 편은 db-hobby가 PostgreSQL의 v3 wire protocol을 직접 말하게 해서, 아무 개조도 안 한 순정 psql이 그대로 붙게 만든다. 놀라운 건 재사용의 규모다 — 새로 짠 건 poll() 이벤트 루프 + 바이트 조립 400줄뿐이고, 커넥션을 18편의 세션에 하나씩 매핑하니 스레드 없이도 psql 두 개가 인터리브 트랜잭션을 돈다. startup 핸드셰이크, SSLRequest 거절, simple query, RowDescription/DataRow, ReadyForQuery의 트랜잭션 상태 바이트까지 프로토콜을 바이트 단위로 뜯어보고, psql 14.19로 'reader가 writer를 안 막는다'를 네트워크 너머에서 실제로 시연한다. 그리고 이 서버의 한계(단일 스레드 poll = 진짜 병렬이 아니다)가 다음 편 트랙 D의 장애 서사가 되는 것까지."
descriptionEn: "Through Part 18, db-hobby was a single local REPL. A real database accepts many clients over TCP. This part makes db-hobby speak PostgreSQL's v3 wire protocol directly, so an unmodified, stock psql connects to it as-is. The striking thing is the scale of reuse — the only new code is a poll() event loop plus ~400 lines of byte assembly, and mapping each connection to one of Part 18's sessions lets two psql windows run interleaved transactions with no threads at all. We dissect the protocol byte by byte — the startup handshake, refusing SSLRequest, simple query, RowDescription/DataRow, the ReadyForQuery transaction-status byte — and demonstrate 'readers don't block writers' over the network with real psql 14.19. And this server's limit (single-threaded poll = not truly parallel) becomes the next part's failure narrative for Track D."
date: 2026-07-03
tags:
  - C
  - Database Internals
  - PostgreSQL
  - Wire Protocol
  - Network
  - psql
  - Learning
category: study/db-hobby
coverImage: /uploads/project/db-hobby/cover.svg
draft: false
series: "db-hobby"
seriesOrder: 19
---

## 0. 들어가며 — 로컬 REPL을 벗어나며

[18편](/blog/project/db-hobby/db-hobby-18-multi-txn)까지 db-hobby는 저장·인덱스·SQL·WAL·MVCC를 다 갖췄지만, 바깥에서 보면 **터미널에 붙은 프로그램 하나**였어요. `./build/db-hobby my.db`로 열어 SQL을 타이핑하는. 진짜 DB는 TCP로 여러 클라이언트를 받죠 — 그리고 그 클라이언트들이 각자의 트랜잭션을 인터리브합니다.

이번 편의 목표는 도발적일 만큼 구체적입니다: **아무 개조도 안 한 순정 `psql`이 db-hobby에 그대로 붙게 한다.** 그러려면 db-hobby가 PostgreSQL의 **wire protocol**을 말할 줄 알아야 해요. CodeCrafters에서 Redis의 RESP를 정독하는 것과 같은 결의 작업이지만, 상대가 psql이라 성공하면 데모가 훨씬 셉니다.

## 1. 놀라운 건 재사용의 규모다

먼저 결론부터. 이 편에서 **새로 짠 코드는 딱 두 가지**예요 — `poll()` 이벤트 루프와, 바이트를 빅엔디안으로 조립·해석하는 헬퍼. 400줄 남짓. SQL 실행은? [2편](/blog/project/db-hobby/db-hobby-2-sql-engine)의 파서·실행기를 **그대로** 부릅니다.

```c
if (type == 'Q') {                          /* Simple Query */
    db->cur_session = c->session;           /* 커넥션 = 세션 (18편) */
    char *obuf = NULL; size_t olen = 0;
    FILE *of = open_memstream(&obuf, &olen);
    db_exec(db, payload, of);               /* ← 기존 실행기, 무개조 */
    fclose(of);
    reply_from_output(c->fd, payload, obuf, txn_status);  /* 텍스트 → wire */
}
```

`db_exec`는 여전히 `FILE*`에 사람이 읽는 텍스트를 씁니다. 서버는 그 텍스트를 `open_memstream`으로 가로채, wire protocol 메시지로 **번역**할 뿐이에요. 계층이 깨끗하게 분리돼 있었던 덕에, 네트워크 서버가 실행기를 한 줄도 안 바꾸고 얹혔습니다. 좋은 추상화의 배당금이에요.

그리고 결정적으로 — **커넥션을 [18편](/blog/project/db-hobby/db-hobby-18-multi-txn)의 세션에 하나씩 매핑**합니다. 18편에서 `SESSION n`으로 수동 전환하던 그 세션이, 이제 TCP 커넥션마다 자동 배정돼요. 18편의 다중 트랜잭션이 사실은 이 편을 위한 사전 준비였던 셈입니다.

## 2. 프로토콜을 바이트로 뜯어본다

PostgreSQL wire protocol v3는 의외로 소박해요. 핸드셰이크만 지나면 대부분 `[타입 1바이트][길이 4바이트][페이로드]` 프레임입니다.

**핸드셰이크가 유일한 변칙** — startup 메시지엔 타입 바이트가 없어요(길이부터 옵니다). 그리고 psql은 접속하자마자 **SSLRequest**(매직 넘버 `80877103`)를 보내는데, 우린 SSL이 없으니 단호하게 거절합니다.

```c
if (code == 80877103 || code == 80877104) {  /* SSL / GSS 요청 */
    write(c->fd, "N", 1);   /* 'N' = 안 함. psql은 평문으로 다시 startup을 보낸다 */
}
```

그 다음 진짜 startup(프로토콜 `196608` = 3.0)이 오면, 인증 통과와 준비 완료를 알립니다.

```c
send_msg(fd, 'R', ...0);        /* AuthenticationOk — "인증 통과" */
send_msg(fd, 'S', "client_encoding" "UTF8");  /* ParameterStatus (한글 위해 UTF8) */
send_msg(fd, 'K', pid, key);    /* BackendKeyData (취소용, 우린 더미) */
send_ready(fd, 'I');            /* ReadyForQuery — "쿼리 받을 준비 됨" */
```

여기서 **`ReadyForQuery`의 상태 바이트**가 이 프로토콜의 영리한 디테일이에요 — `'I'`(idle) / `'T'`(트랜잭션 중) / `'E'`(실패한 트랜잭션). 서버가 매 응답 끝에 이 한 바이트로 트랜잭션 상태를 알려주면, psql이 프롬프트를 `=>` / `=*>` / `=!>`로 바꿔 그립니다. 우린 커넥션의 세션이 `in_txn`이냐로 이 바이트를 정합니다 — 18편의 세션 상태가 그대로 psql 프롬프트에 반영돼요.

## 3. 결과를 돌려주는 세 가지 모양

`db_exec`의 텍스트 출력을 psql이 이해하는 메시지로 번역하는 게 `reply_from_output`입니다. 세 갈래예요.

**① SELECT 결과** — 실행기 출력은 `헤더\n행\n행\n(N행)` 꼴이라, 마지막의 `(N행` 꼬리를 찾아 header와 rows를 가릅니다. 컬럼은 `" | "`로 쪼개 `RowDescription`(모든 컬럼을 text OID 25로)과 `DataRow`로 보내요.

```c
if (footer >= 1) {                         /* "(N행" 꼬리가 있으면 = SELECT */
    ncols = split_pipe(lines[0], cols);    /* 헤더 → 컬럼명 */
    send_row_desc(fd, cols, ncols);
    for (각 데이터 줄) send_data_row(fd, split_pipe(line));
    send_cmd_complete(fd, "SELECT N");
}
```

**② EXPLAIN** — 진짜 PostgreSQL처럼 `QUERY PLAN` 단일 컬럼의 여러 행으로 보냅니다. 플랜 트리가 psql 안에서 예쁘게 나와요.

**③ 그 외**(INSERT/COMMIT/VACUUM…) — 안내 메시지의 첫 줄을 `CommandComplete` 태그로. psql이 그걸 명령 완료 표시로 출력합니다. 그리고 `"ERROR"`로 시작하면 `ErrorResponse`로 감싸 psql이 빨간 `ERROR:`로 그리게 하고요.

> **정직한 한계**: SELECT 응답을 실행기의 **텍스트 출력을 파싱**해서 만드는 건 지름길입니다. 그래서 `TEXT` 값 안에 `" | "`가 들어가면 컬럼이 갈려요. 제대로 하려면 실행기가 구조화된 로우를 직접 내보내야 하는데(진짜 DB의 tuple descriptor), 그건 실행기 전체를 건드리는 일이라 이 편의 범위 밖입니다. "동작하는 psql 데모"를 최소 변경으로 얻는 게 목표였어요. 그리고 extended query(Parse/Bind/Execute)도 없습니다 — psql의 기본 대화는 simple query라 붙는 데 충분하거든요.

## 4. 그래서, 진짜 붙는다

빌드하고 서버를 띄운 뒤, **순정 psql**로 접속합니다.

```sh
$ ./build/db-hobby my.db --serve 5433
db-hobby: 127.0.0.1:5433 에서 대기 중 — psql "host=127.0.0.1 port=5433 dbname=db-hobby"

$ psql "host=127.0.0.1 port=5433 dbname=db-hobby"
psql (14.19)
db-hobby=> CREATE TABLE t (id INT, v TEXT);
테이블 't' 생성됨 (컬럼 2개)
db-hobby=> INSERT INTO t VALUES (1, 'hello');
1개 행 삽입됨
db-hobby=> SELECT * FROM t;
 id |   v
----+-------
 1  | hello
(1 row)
```

`(1 row)`, 그리고 `+`와 `-`로 그린 테이블 — 저건 **db-hobby가 아니라 psql이** 그린 겁니다. db-hobby는 `RowDescription`과 `DataRow`를 바이트로 보냈을 뿐이고, psql이 그걸 받아 자기 방식대로 예쁘게 렌더했어요. 프로토콜만 맞으면 클라이언트는 상대가 진짜 PostgreSQL인지 C로 짠 400줄 서버인지 구분하지 못합니다. **그게 프로토콜의 힘이에요.**

## 5. 클라이맥스 — 네트워크 너머의 "reader는 writer를 안 막는다"

[18편](/blog/project/db-hobby/db-hobby-18-multi-txn)에서 `SESSION n`으로 시연했던 그 장면을, 이제 **진짜 psql 두 개**로 재현합니다. 커넥션마다 세션이 배정되니, 한 psql이 트랜잭션을 열고 있는 동안 다른 psql이 붙어 읽을 수 있어요.

**터미널 A** (writer):
```
db-hobby=> BEGIN;
db-hobby=*> UPDATE t SET v = 999 WHERE id = 1;
1개 행 수정됨
                                  -- 아직 커밋 안 함. 프롬프트가 =*> (트랜잭션 중)
```

**터미널 B** (reader) — A가 미커밋 UPDATE를 쥐고 있는 동안:
```
db-hobby=> SELECT * FROM t WHERE id = 1;
 id |  v
----+-----
 1  | 100                         -- 안 막힌다! 옛 버전 100을 읽는다
db-hobby=> UPDATE t SET v = 555 WHERE id = 1;
ERROR:  테이블 't'가 다른 트랜잭션에 잠겨 있습니다 (쓰기 충돌)
```

**터미널 A**가 `COMMIT;` 하면 — **터미널 B**:
```
db-hobby=> SELECT * FROM t WHERE id = 1;
 id |  v
----+-----
 1  | 999                         -- 커밋 후엔 새 값
```

이건 제가 지어낸 트랜스크립트가 아니라 **실제 psql 14.19를 두 개 띄워 잡은 출력**입니다(FIFO로 두 커넥션을 열어 둔 채 명령을 번갈아 흘려보냈어요). reader는 거부당하지도, 기다리지도 않고 스냅샷의 옛 버전을 읽고 — 쓰기끼리만 first-updater-wins로 충돌합니다. [MVCC의 존재 이유](/blog/project/db-hobby/db-hobby-12-2pl-vs-mvcc)가, 이제 네트워크 너머에서 두 클라이언트로 증명됐어요.

## 6. 이 서버의 한계 — 그리고 다음 편

정직하게 짚을 게 있어요. 이 서버는 **단일 스레드 `poll()` 루프**입니다. 커넥션을 여러 개 받고 세션으로 인터리브하지만, 진짜로 **동시에** 실행하는 건 하나도 없어요 — 한 순간엔 한 쿼리만 돕니다. 게다가 메시지를 읽을 때 `recv_all`로 **블로킹**하기 때문에, 느린 클라이언트 하나가 자기 메시지를 다 안 보내면 그동안 서버 전체가 멈춥니다.

이게 왜 문제냐면 — CPU가 여러 개인데 쿼리를 한 번에 하나씩만 처리하니 코어를 놀리고, 무거운 쿼리 하나가 다른 모든 커넥션을 막아요. 진짜 DB는 커넥션마다 스레드(또는 프로세스)를 띄워 **진짜 병렬**로 처리하죠. 그러려면 [1편](/blog/project/db-hobby/db-hobby-1-storage)의 버퍼 풀부터 [3편](/blog/project/db-hobby/db-hobby-3-index-wal)의 B+Tree까지, 지금 "단일 스레드라 안전하다"고 가정한 모든 계층에 **latch(래치)** 를 달아야 합니다.

> **한 줄 예고**: 이 편의 한계 — "여러 커넥션을 받지만 진짜 병렬은 아니다" — 가 정확히 **다음 편(트랙 D)의 장애 서사**입니다. `poll()` 루프를 스레드 풀로 바꾸는 순간, 지금까지 공짜로 누리던 단일 스레드 안전성이 전부 무너지고 — 버퍼 풀 latch, B+Tree latch crabbing, 진짜 블로킹 락 매니저가 "필요해서" 등장합니다. 시리즈의 원칙 그대로요.

![PostgreSQL wire protocol 서버 — 순정 psql이 startup/SSLRequest 핸드셰이크 후 simple query(Q)를 보내면, 단일 스레드 poll 루프가 커넥션을 18편의 세션에 매핑해 실행기(무개조)를 부르고, 텍스트 출력을 RowDescription/DataRow로 번역해 돌려준다. 두 psql이 세션으로 인터리브](/uploads/project/db-hobby/wire-protocol-server.svg)

## 7. 정리

| 항목 | db-hobby | 비고 |
|---|---|---|
| TCP 서버 | O | 단일 스레드 `poll()`, 127.0.0.1 |
| 커넥션 = 세션 | O | 18편 세션에 매핑, 끊김 시 트랜잭션 롤백 |
| PG wire v3 (simple query) | O | 진짜 psql 14.19로 검증 |
| SELECT/EXPLAIN/명령/에러 응답 | O | 실행기 텍스트 출력 파싱 |
| extended query (Parse/Bind) | X | psql 기본 대화엔 불필요 |
| 진짜 병렬 실행 | X | 단일 스레드 = 다음 편(트랙 D)의 동기 |

"내가 C로 짠 400줄 서버에 진짜 psql이 그대로 붙는다" — 프로토콜을 정확히 말하기만 하면, 클라이언트는 상대를 구분하지 못한다는 걸 몸으로 확인했어요. 그리고 그 서버가 여러 커넥션을 받으면서도 하나씩만 처리한다는 한계가, 다음에 진짜 스레드 동시성으로 넘어갈 이유를 스스로 만들었습니다.

## 참고

- [PostgreSQL Documentation: Frontend/Backend Protocol (message formats)](https://www.postgresql.org/docs/current/protocol.html)
- [PostgreSQL Documentation: Message Formats](https://www.postgresql.org/docs/current/protocol-message-formats.html)
- 본 시리즈: [2편 SQL 엔진](/blog/project/db-hobby/db-hobby-2-sql-engine) · [12편 2PL vs MVCC](/blog/project/db-hobby/db-hobby-12-2pl-vs-mvcc) · [18편 다중 트랜잭션](/blog/project/db-hobby/db-hobby-18-multi-txn)

<!-- EN -->

## 0. Introduction — Leaving the Local REPL

Through [Part 18](/blog/project/db-hobby/db-hobby-18-multi-txn), db-hobby had storage, indexes, SQL, WAL, and MVCC — but from the outside it was **one program attached to a terminal**: open it with `./build/db-hobby my.db` and type SQL. A real database accepts many clients over TCP — and those clients interleave their transactions.

This part's goal is provocatively concrete: **make an unmodified, stock `psql` connect to db-hobby as-is.** For that, db-hobby must speak PostgreSQL's **wire protocol**. Same flavor as poring over Redis's RESP on CodeCrafters, but with psql as the counterpart, success makes for a far stronger demo.

## 1. The Striking Part Is the Scale of Reuse

The conclusion first. The **only new code** in this part is two things — a `poll()` event loop, and helpers that assemble/parse bytes in big-endian. About 400 lines. SQL execution? It calls [Part 2](/blog/project/db-hobby/db-hobby-2-sql-engine)'s parser and executor **as-is**.

```c
if (type == 'Q') {                          /* Simple Query */
    db->cur_session = c->session;           /* connection = session (Part 18) */
    char *obuf = NULL; size_t olen = 0;
    FILE *of = open_memstream(&obuf, &olen);
    db_exec(db, payload, of);               /* ← existing executor, untouched */
    fclose(of);
    reply_from_output(c->fd, payload, obuf, txn_status);  /* text → wire */
}
```

`db_exec` still writes human-readable text to a `FILE*`. The server merely intercepts that text with `open_memstream` and **translates** it into wire-protocol messages. Because the layers were cleanly separated, the network server bolted onto the executor without changing a line. The dividend of good abstraction.

And crucially — it **maps each connection to one of [Part 18](/blog/project/db-hobby/db-hobby-18-multi-txn)'s sessions**. The session you switched manually with `SESSION n` in Part 18 is now auto-assigned per TCP connection. Part 18's multi-transaction was, in fact, preparation for this part.

## 2. The Protocol, Byte by Byte

PostgreSQL wire protocol v3 is surprisingly modest. Past the handshake, almost everything is a `[type 1 byte][length 4 bytes][payload]` frame.

**The handshake is the only oddity** — the startup message has no type byte (it starts with the length). And psql, right after connecting, sends an **SSLRequest** (magic number `80877103`); having no SSL, we refuse firmly.

```c
if (code == 80877103 || code == 80877104) {  /* SSL / GSS request */
    write(c->fd, "N", 1);   /* 'N' = no. psql re-sends startup in cleartext */
}
```

Then the real startup (protocol `196608` = 3.0) arrives, and we announce authentication and readiness.

```c
send_msg(fd, 'R', ...0);        /* AuthenticationOk — "you're in" */
send_msg(fd, 'S', "client_encoding" "UTF8");  /* ParameterStatus (UTF8 for Korean) */
send_msg(fd, 'K', pid, key);    /* BackendKeyData (for cancel; ours is a dummy) */
send_ready(fd, 'I');            /* ReadyForQuery — "ready for a query" */
```

Here the **status byte of `ReadyForQuery`** is a clever detail — `'I'` (idle) / `'T'` (in transaction) / `'E'` (failed transaction). When the server ends each response with this one byte, psql redraws its prompt as `=>` / `=*>` / `=!>`. We set it from whether the connection's session is `in_txn` — Part 18's session state flows straight into psql's prompt.

## 3. Three Shapes of Reply

`reply_from_output` translates `db_exec`'s text output into messages psql understands. Three branches.

**① SELECT result** — the executor's output is `header\nrow\nrow\n(N rows)`, so we find the trailing `(N행` footer and split header from rows. Columns are split on `" | "` and sent as `RowDescription` (every column as text OID 25) and `DataRow`.

```c
if (footer >= 1) {                         /* a "(N rows" footer means SELECT */
    ncols = split_pipe(lines[0], cols);    /* header → column names */
    send_row_desc(fd, cols, ncols);
    for (each data line) send_data_row(fd, split_pipe(line));
    send_cmd_complete(fd, "SELECT N");
}
```

**② EXPLAIN** — like real PostgreSQL, sent as multiple rows of a single `QUERY PLAN` column. The plan tree renders nicely inside psql.

**③ Everything else** (INSERT/COMMIT/VACUUM…) — the first line of the info message becomes a `CommandComplete` tag, which psql prints as the command status. And anything starting with `"ERROR"` is wrapped in `ErrorResponse`, so psql draws it as a red `ERROR:`.

> **Honest limitation**: building the SELECT reply by **parsing the executor's text output** is a shortcut. So a `TEXT` value containing `" | "` splits into columns. Doing it right means the executor emitting structured rows (a real database's tuple descriptor), which touches the whole executor and is out of scope here. The goal was a *working psql demo with minimal change*. And there's no extended query (Parse/Bind/Execute) either — psql's default conversation is the simple query, which is enough to connect.

## 4. So, It Really Connects

Build, start the server, and connect with **stock psql**.

```sh
$ ./build/db-hobby my.db --serve 5433
db-hobby: waiting on 127.0.0.1:5433 — psql "host=127.0.0.1 port=5433 dbname=db-hobby"

$ psql "host=127.0.0.1 port=5433 dbname=db-hobby"
psql (14.19)
db-hobby=> CREATE TABLE t (id INT, v TEXT);
table 't' created (2 columns)
db-hobby=> INSERT INTO t VALUES (1, 'hello');
1 row inserted
db-hobby=> SELECT * FROM t;
 id |   v
----+-------
 1  | hello
(1 row)
```

`(1 row)`, and the table drawn with `+` and `-` — that was drawn by **psql, not db-hobby**. db-hobby only sent `RowDescription` and `DataRow` as bytes; psql received them and rendered them its own way. Get the protocol right and the client can't tell whether it's talking to real PostgreSQL or a 400-line C server. **That's the power of a protocol.**

## 5. The Climax — "Readers Don't Block Writers," Over the Network

The scene [Part 18](/blog/project/db-hobby/db-hobby-18-multi-txn) demonstrated with `SESSION n` is now reproduced with **two real psql clients**. Each connection gets a session, so one psql can hold a transaction open while another connects and reads.

**Terminal A** (writer):
```
db-hobby=> BEGIN;
db-hobby=*> UPDATE t SET v = 999 WHERE id = 1;
1 row updated
                                  -- not committed yet. prompt is =*> (in transaction)
```

**Terminal B** (reader) — while A holds the uncommitted UPDATE:
```
db-hobby=> SELECT * FROM t WHERE id = 1;
 id |  v
----+-----
 1  | 100                         -- not blocked! reads the old version, 100
db-hobby=> UPDATE t SET v = 555 WHERE id = 1;
ERROR:  table 't' is locked by another transaction (write conflict)
```

After **Terminal A** does `COMMIT;` — **Terminal B**:
```
db-hobby=> SELECT * FROM t WHERE id = 1;
 id |  v
----+-----
 1  | 999                         -- after commit, the new value
```

This isn't a transcript I made up — it's **actual output from two real psql 14.19 clients** (two connections held open via FIFOs, commands fed in alternation). The reader is neither rejected nor made to wait; it reads the old version from its snapshot — and only writes collide, first-updater-wins. [MVCC's reason for existing](/blog/project/db-hobby/db-hobby-12-2pl-vs-mvcc) is now proven over the network, with two clients.

## 6. This Server's Limit — and What's Next

To be honest: this server is a **single-threaded `poll()` loop**. It accepts multiple connections and interleaves them by session, but nothing runs **truly at once** — one query runs at any instant. Worse, it reads messages with a **blocking** `recv_all`, so one slow client that doesn't finish sending its message freezes the whole server meanwhile.

Why that matters — with several CPUs, processing one query at a time idles the cores, and one heavy query blocks every other connection. Real databases spawn a thread (or process) per connection for **true parallelism**. For that, every layer from [Part 1](/blog/project/db-hobby/db-hobby-1-storage)'s buffer pool to [Part 3](/blog/project/db-hobby/db-hobby-3-index-wal)'s B+Tree — everything we've assumed "safe because single-threaded" — needs **latches**.

> **One-line preview**: this part's limit — "accepts many connections but isn't truly parallel" — is exactly **the next part's failure narrative (Track D)**. The moment you swap the `poll()` loop for a thread pool, all the single-threaded safety we've enjoyed for free collapses, and buffer-pool latches, B+Tree latch crabbing, and a real blocking lock manager arrive "because they're needed." True to the series' principle.

![PostgreSQL wire protocol server — stock psql sends a simple query (Q) after the startup/SSLRequest handshake; a single-threaded poll loop maps the connection to a Part-18 session, calls the (untouched) executor, and translates the text output into RowDescription/DataRow. Two psql clients interleave by session](/uploads/project/db-hobby/wire-protocol-server.svg)

## 7. Wrap-up

| Item | db-hobby | Note |
|---|---|---|
| TCP server | O | single-threaded `poll()`, 127.0.0.1 |
| connection = session | O | mapped to Part 18 sessions; rollback on disconnect |
| PG wire v3 (simple query) | O | verified with real psql 14.19 |
| SELECT/EXPLAIN/command/error replies | O | parsed from executor text output |
| extended query (Parse/Bind) | X | not needed for psql's default conversation |
| true parallel execution | X | single-threaded = the next part's (Track D) motivation |

"A real psql connects, as-is, to a 400-line server I wrote in C" — get the protocol exactly right and the client can't tell the difference, felt in the bones. And the very fact that this server accepts many connections yet handles one at a time created, by itself, the reason to move on to true thread concurrency next.

## References

- [PostgreSQL Documentation: Frontend/Backend Protocol (message formats)](https://www.postgresql.org/docs/current/protocol.html)
- [PostgreSQL Documentation: Message Formats](https://www.postgresql.org/docs/current/protocol-message-formats.html)
- This series: [Part 2 SQL Engine](/blog/project/db-hobby/db-hobby-2-sql-engine) · [Part 12 2PL vs MVCC](/blog/project/db-hobby/db-hobby-12-2pl-vs-mvcc) · [Part 18 Multi-Transaction](/blog/project/db-hobby/db-hobby-18-multi-txn)

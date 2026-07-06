---
title: 'DB 내부 ⑤: 진짜 psql이 붙는 서버 — PostgreSQL wire protocol 해부'
titleEn: 'DB Internals ⑤: A Server a Real psql Connects To — Dissecting the PostgreSQL Wire Protocol'
description: "DB 서버와 클라이언트 사이엔 '프로토콜이라는 계약'이 있다 — 그 계약만 지키면 상대는 내가 진짜 PostgreSQL인지 구분하지 못한다. PostgreSQL wire protocol v3를 바이트로 뜯는다: 유일한 변칙인 startup 핸드셰이크와 SSLRequest 거절, [타입 1B][길이 4B][페이로드] 프레임, RowDescription/DataRow/CommandComplete의 세 가지 응답 모양, 그리고 psql 프롬프트(=> / =*> / =!>)를 바꾸는 ReadyForQuery 상태 바이트 한 개까지. 400줄 서버로 실제 psql 14가 접속했고, 좋은 계층 분리 덕에 SQL 실행기는 한 줄도 안 바꿨다. 클라이맥스는 두 psql 터미널 — 한쪽이 미커밋 UPDATE를 쥔 채로 다른 쪽이 옛 버전을 막힘 없이 읽는, MVCC의 존재 이유가 네트워크 너머에서 증명되는 장면. 커넥션당 스레드와 그 뒤에 숨은 굵은 latch의 한계까지 정리해요."
descriptionEn: "Between a DB server and its clients sits a contract called the protocol — honor it and the other side can't tell you're not real PostgreSQL. We dissect wire protocol v3 byte by byte: the startup handshake (the one irregularity) and refusing SSLRequest, the [type 1B][length 4B][payload] frame, the three response shapes (RowDescription/DataRow/CommandComplete), and the single ReadyForQuery status byte that switches psql's prompt (=> / =*> / =!>). A 400-line server that a real psql 14 connects to — without changing one line of the SQL executor, thanks to clean layering. The climax: two psql terminals, one holding an uncommitted UPDATE while the other reads the old version unblocked — MVCC's reason for existing, proven across the network. Plus thread-per-connection and the coarse latch hiding behind it."
date: 2026-04-20T00:00:00.000Z
tags:
  - Database Internals
  - Wire Protocol
  - PostgreSQL
  - Network
  - C
category: study/db-hobby
coverImage: /uploads/project/db-hobby/cover.svg
draft: false
series: "미니 DB로 이해하는 DB 내부"
seriesOrder: 5
---

## 0. 들어가며 — 프로토콜은 계약이다

[4편](/blog/project/db-hobby/db-internals-04-mvcc)까지의 엔진은 로컬 REPL이었어요. 진짜 DB는 네트워크 서버입니다 — 그리고 서버와 클라이언트 사이엔 **프로토콜이라는 계약**이 있어요.

이 편의 목표는 하나였습니다: **아무 psql이나 접속하게 하라.** PostgreSQL wire protocol v3를 말하는 서버를 만들면, psql은 상대가 진짜 PG인지 구분하지 못해요. 클라이언트를 새로 만드는 게 아니라 **계약을 지켜서 기존 생태계(psql, JDBC, 각종 드라이버)를 통째로 빌리는** 것 — 이게 wire protocol 호환이 강력한 이유고, CockroachDB·YugabyteDB 같은 신생 DB들이 PG wire protocol을 말하는 이유이기도 합니다.

> **흔한 오해 정정**: *"PG wire 호환이면 PostgreSQL 호환이다"* — 계약이 보장하는 건 **바이트의 모양**까지예요. CockroachDB·YugabyteDB는 wire는 PG를 말하지만 격리 수준의 기본값과 동작, SQL 방언, 에러의 결이 PostgreSQL과 다릅니다. 드라이버가 붙는 것과 애플리케이션이 같게 동작하는 건 별개의 문제예요 — 이 글의 400줄 서버가 그 산 증거입니다(psql은 붙지만, 이건 PostgreSQL이 아니죠).

결론부터: **400줄 서버로 실제 psql 14가 붙었고, SQL 실행기는 한 줄도 안 바꿨습니다.**

## 1. 놀라운 건 재사용의 규모다

이 편에서 새로 짠 코드는 딱 두 가지예요 — 이벤트 루프와, 바이트를 빅엔디안으로 조립·해석하는 헬퍼. SQL 실행은 기존 실행기를 **그대로** 부릅니다.

```c
if (type == 'Q') {                          /* Simple Query */
    db->cur_session = c->session;           /* 커넥션 = 세션 */
    FILE *of = open_memstream(&obuf, &olen);
    db_exec(db, payload, of);               /* ← 기존 실행기, 무개조 */
    fclose(of);
    reply_from_output(c->fd, payload, obuf, txn_status);  /* 텍스트 → wire */
}
```

실행기는 여전히 `FILE*`에 사람이 읽는 텍스트를 씁니다. 서버는 그 텍스트를 `open_memstream`으로 가로채 wire 메시지로 **번역**할 뿐이에요. 계층이 깨끗하게 분리돼 있던 덕에 네트워크가 실행기 위에 무개조로 얹혔습니다 — 좋은 추상화의 배당금.

그리고 결정적으로, **TCP 커넥션을 [4편](/blog/project/db-hobby/db-internals-04-mvcc)의 트랜잭션 세션에 하나씩 매핑**합니다. 커넥션마다 자기 트랜잭션 핸들이 자동 배정돼요 — 다중 트랜잭션 세션이 사실은 이 편을 위한 사전 준비였던 셈이에요.

![wire protocol 서버 — psql이 startup 핸드셰이크를 지나 Simple Query를 보내면, 서버가 실행기 출력을 wire 메시지로 번역한다](/uploads/project/db-hobby/wire-protocol-server.svg)

## 2. 프로토콜을 바이트로 뜯어본다

PostgreSQL wire protocol v3는 의외로 소박해요. 핸드셰이크만 지나면 대부분 **`[타입 1바이트][길이 4바이트][페이로드]`** 프레임입니다(길이는 빅엔디안, 길이 자신을 포함).

**핸드셰이크가 유일한 변칙** — 공식 문서의 첫 문장 그대로, *"To begin a session, a frontend opens a connection to the server and sends a startup message."* 이 startup 메시지엔 타입 바이트가 없어요(길이부터 옵니다). 그리고 기본 설정(`sslmode=prefer`)의 psql은 접속하자마자 **SSLRequest**(매직 넘버 `80877103`)부터 보내는데, SSL이 없으면 한 바이트로 거절하면 됩니다.

```c
if (code == 80877103 || code == 80877104) {  /* SSL / GSS 요청 */
    write(c->fd, "N", 1);   /* 'N' = 안 함. psql은 평문으로 다시 startup을 보낸다 */
}
```

(이 "물어보고 거절당하면 평문" 왕복도 진화 중이에요 — PostgreSQL 17부터는 첫 바이트부터 TLS로 시작하는 direct TLS(`sslnegotiation=direct`)가 추가됐습니다.)

진짜 startup(프로토콜 버전 `196608` = 3.0)이 오면 네 개의 메시지로 "준비 완료"를 알립니다.

```c
send_msg(fd, 'R', ...0);        /* AuthenticationOk */
send_msg(fd, 'S', "client_encoding" "UTF8");  /* ParameterStatus */
send_msg(fd, 'K', pid, key);    /* BackendKeyData (취소용) */
send_ready(fd, 'I');            /* ReadyForQuery — "쿼리 받을 준비 됨" */
```

두 가지 정직한 축약이 있어요. 실제 PostgreSQL은 `ParameterStatus`를 하나가 아니라 여러 개 보냅니다 — `server_version`, `standard_conforming_strings`, `DateStyle` 등. 일부 드라이버는 이 값들을 요구하지만, psql만 상대할 땐 `client_encoding` 하나로 충분했어요. 인증도 마찬가지 — 이 서버는 누구든 무조건 `AuthenticationOk`를 받는 trust 상당이고, 실제 PostgreSQL의 기본은 SCRAM-SHA-256 챌린지-응답입니다.

`BackendKeyData`의 pid·key는 **쿼리 취소**용인데, 여기에 프로토콜의 재미있는 설계가 있어요 — 실행 중인 커넥션은 쿼리를 처리하느라 바쁘니, CancelRequest(매직 넘버 `80877102`)는 startup 대신 이 매직을 실은 **별도의 새 커넥션**으로 날아옵니다. db-hobby는 키만 발급하고 취소 처리는 구현하지 않았어요.

여기서 이 프로토콜의 영리한 디테일 하나 — **`ReadyForQuery`의 상태 바이트**예요. 공식 문서의 정의로 *"'I' if idle (not in a transaction block); 'T' if in a transaction block; or 'E' if in a failed transaction block"*. 서버가 매 응답 끝에 이 한 바이트로 트랜잭션 상태를 알려주면, psql이 프롬프트를 `=>` / `=*>` / `=!>`로 바꿔 그립니다. 커넥션의 세션이 `in_txn`이냐로 이 바이트를 정하니, 엔진의 트랜잭션 상태가 그대로 psql 프롬프트에 반영돼요.

이 계약의 무게를 보여주는 숫자 하나 — 위의 `196608`(v3.0)은 **PostgreSQL 7.4(2003년)부터 지금까지 그대로**입니다. v2 지원이 제거된 게 PostgreSQL 14, 첫 마이너 상향(3.2)이 PostgreSQL 18에서야 나왔어요. 20년 넘게 안 바뀐 계약이었기에 psql·JDBC·수많은 드라이버 생태계가 그 위에 쌓일 수 있었던 겁니다.

## 3. 결과를 돌려주는 세 가지 모양

실행기의 텍스트 출력을 psql이 이해하는 메시지로 번역하는 갈래는 셋입니다.

- **① SELECT 결과** — `RowDescription`(컬럼 정의, 전부 text OID 25로 단순화) + 행마다 `DataRow` + `CommandComplete("SELECT N")`. 실행기 출력의 `헤더\n행…\n(N행)` 꼴에서 꼬리를 찾아 헤더와 행을 가릅니다.
- **② EXPLAIN** — 진짜 PostgreSQL처럼 `QUERY PLAN` 단일 컬럼의 여러 행으로. 플랜 트리가 psql 안에서 예쁘게 나와요.
- **③ 그 외**(INSERT/COMMIT/…) — 첫 줄을 `CommandComplete` 태그로. `"ERROR"`로 시작하면 `ErrorResponse`로 감싸 psql이 빨간 `ERROR:`로 그리게 합니다.

> **정직한 한계**: SELECT 응답을 실행기의 **텍스트 출력을 파싱**해 만드는 건 지름길이다. `TEXT` 값 안에 `" | "`가 들어가면 컬럼이 갈린다. 제대로 하려면 실행기가 구조화된 로우(진짜 DB의 tuple descriptor)를 직접 내보내야 하는데, 그건 실행기 전체를 건드리는 일. 그리고 extended query protocol도 없다 — psql의 기본 대화는 simple query라 붙는 데 충분하지만, §0에서 말한 "JDBC 생태계를 통째로 빌린다"엔 이 부재가 선을 긋는다. **pgJDBC는 extended query protocol이 기본이라 이 서버엔 붙지 못한다.** "동작하는 psql"을 최소 변경으로 얻는 게 목표였다.

### 못 지킨 계약의 나머지 절반 — extended query protocol

실제 애플리케이션 드라이버들의 기본 대화는 simple query가 아니라 **extended query protocol**이에요. 한 문장이 다섯 메시지로 쪼개집니다 — `Parse`(SQL 텍스트를 이름 붙은 문장으로), `Bind`(파라미터 값을 채워 portal 생성), `Describe`(결과 모양 조회), `Execute`(portal 실행), `Sync`(경계 표시). 이렇게 쪼갠 이유는 셋 — 파싱·플래닝을 한 번 하고 **플랜을 재사용**할 수 있고(prepared statement), 값을 텍스트가 아닌 **바이너리 포맷**으로 보낼 수 있고, 무엇보다 SQL 텍스트와 값이 **서로 다른 메시지로** 갑니다.

> **흔한 오해 정정**: *"prepared statement는 성능 기능일 뿐이다"* — 프로토콜 관점에선 보안 장치예요. `Parse`에 실리는 SQL엔 `$1` 자리표시자만 있고 값은 `Bind`에 따로 실리니, **값이 SQL로 해석될 경로 자체가 없습니다.** 문자열 이어붙이기가 만드는 SQL 인젝션이 애플리케이션의 이스케이프 실력이 아니라 **프로토콜 수준에서** 차단되는 거예요.

## 4. 클라이맥스 — 네트워크 너머의 "reader는 writer를 안 막는다"

[4편](/blog/project/db-hobby/db-internals-04-mvcc)의 그 장면을 이제 **진짜 psql 두 개**로 재현합니다.

**터미널 A** (writer):
```
db-hobby=> BEGIN;
db-hobby=*> UPDATE t SET v = 999 WHERE id = 1;
1개 행 수정됨                      -- 아직 커밋 안 함. 프롬프트가 =*> (트랜잭션 중)
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
 1  | 999                         -- 커밋 후엔 새 값
```

지어낸 트랜스크립트가 아니라 **실제 psql 14.19 두 개를 띄워 잡은 출력**이에요. reader는 거부당하지도 기다리지도 않고 스냅샷의 옛 버전을 읽고, 쓰기끼리만 충돌합니다. MVCC의 존재 이유가 네트워크 너머에서 두 클라이언트로 증명됐어요. 단, 터미널 B가 받은 **즉시 ERROR**는 db-hobby의 이중 단순화 — 테이블 단위 락에, 기다리지 않는 no-wait — 가 만든 모양입니다.

> **흔한 오해 정정**: *"MVCC에서 쓰기 충돌은 즉시 에러가 난다"* — 실제 PostgreSQL에서 터미널 B의 UPDATE는 에러 없이 **행 락을 기다리며 멈춰 있습니다.** A가 커밋하면 READ COMMITTED에선 최신 버전으로 조건을 재평가해 그냥 진행하고, REPEATABLE READ에서만 `ERROR: could not serialize access due to concurrent update`가 나요. InnoDB도 기다리는 쪽이라, `innodb_lock_wait_timeout`(기본 50초)을 넘겨야 `ERROR 1205 (HY000): Lock wait timeout exceeded; try restarting transaction`을 봅니다. 기다림을 원치 않으면 그걸 명시하는 게 관행이에요 — PostgreSQL의 `lock_timeout`, `SELECT ... FOR UPDATE NOWAIT`.

## 5. 커넥션당 스레드 — 그리고 굵은 latch

처음 서버는 단일 스레드 `poll()` 루프였어요 — 진짜 병렬이 아니라 인터리브였죠. 커넥션마다 OS 스레드를 주는 **thread-per-connection**으로 바꾸면 네트워크 I/O는 진짜 병렬이 됩니다. PostgreSQL이 커넥션마다 프로세스를 포크하는 것의 스레드판이에요.

단, 정직하게 — 실행 자체는 **전역 엔진 latch 하나로 직렬화**했습니다. 실행기 전 계층이 아직 단일 스레드 가정이라, 우선 굵은 latch 하나로 정확성을 산 거예요. [1편](/blog/project/db-hobby/db-internals-01-storage)에서 스레드 안전하게 만든 버퍼 풀이 "이 굵은 latch를 계층별로 걷어낼 첫 발판"이고 — 그 걷어내는 여정(병렬 스캔부터 실측까지)이 [8편](/blog/project/db-hobby/db-internals-08-parallel)입니다.

> **실무/면접 포인트**: 커넥션당 스레드/프로세스는 단순하지만 커넥션 수만큼 자원을 먹는다. 그래서 실무 PostgreSQL 앞엔 거의 항상 PgBouncer 같은 **커넥션 풀러**가 선다. 이 구도의 이론은 [DB 커넥션 풀](/blog/theory/db-connection-pool)과 [Tomcat NIO 요청 처리](/blog/theory/tomcat-nio-request-handling)에서.

> **실무 안티패턴**: PgBouncer를 transaction 모드로 두고 prepared statement·`SET`·temp table을 쓰는 것. 이 글의 서버가 보여주듯 wire 세계에서 **세션 상태는 특정 백엔드(커넥션)에 귀속**되는데, transaction 모드는 트랜잭션마다 백엔드를 갈아끼우니 "아까 준비한 문장"이 없는 백엔드에 `Execute`가 도착해요 — 간헐적으로만 터지는 `prepared statement "S_1" does not exist`의 정체입니다.

## 6. 정리

- **프로토콜은 계약** — 계약만 지키면 기존 생태계(psql·드라이버)를 통째로 빌린다. CockroachDB 등이 PG wire를 말하는 이유.
- **v3 프레임은 소박하다** — `[타입 1B][길이 4B][페이로드]`. 변칙은 startup(타입 없음)과 SSLRequest('N' 한 바이트 거절)뿐.
- **ReadyForQuery 상태 바이트 하나**가 psql 프롬프트(`=>`/`=*>`/`=!>`)를 바꾼다 — 프로토콜에 트랜잭션 상태가 새겨져 있다.
- **좋은 계층 분리의 배당금** — 실행기 무개조로 서버가 얹혔다. 대신 텍스트 파싱 응답·simple query only라는 정직한 지름길.
- **MVCC가 네트워크 너머에서 증명** — 두 psql, reader는 안 막히고 writer끼리만 충돌(즉시 에러는 db-hobby의 no-wait 단순화 — 실제 PG는 행 락 대기).

다음 편은 플래너가 멍청해지는 순간 — "인덱스가 있으면 무조건 쓴다"는 규칙이 틀리는 지점에서 **비용 기반 옵티마이저**가 시작됩니다.

## 참고 (1차 자료 우선)

- [PostgreSQL Documentation: Frontend/Backend Protocol](https://www.postgresql.org/docs/current/protocol.html)
- [PostgreSQL Documentation: Message Flow](https://www.postgresql.org/docs/current/protocol-flow.html) — extended query·CancelRequest 절차의 1차 근거
- [PostgreSQL Documentation: Message Formats](https://www.postgresql.org/docs/current/protocol-message-formats.html)
- [PgBouncer Documentation: Features](https://www.pgbouncer.org/features.html) — pooling 모드별 세션 상태 제약
- 본 블로그: [DB 커넥션 풀](/blog/theory/db-connection-pool) · [Tomcat NIO 요청 처리](/blog/theory/tomcat-nio-request-handling)
- [db-hobby 코드 (GitHub)](https://github.com/dj258255/db-hobby) — `server.c`

<!-- EN -->

## 0. Introduction — the Protocol Is a Contract

The engine through [Part 4](/blog/project/db-hobby/db-internals-04-mvcc) was a local REPL. A real DB is a network server — and between server and client sits a **contract called the protocol.**

The goal of this part was singular: **let any psql connect.** Build a server that speaks PostgreSQL wire protocol v3 and psql cannot tell it isn't real PG. Rather than writing a new client, you **honor the contract and borrow the whole existing ecosystem** — psql, JDBC, every driver. That's why wire-protocol compatibility is powerful, and why newer databases like CockroachDB and YugabyteDB speak the PG wire protocol.

> **Common misconception, corrected**: *"PG-wire-compatible means PostgreSQL-compatible"* — the contract only guarantees **the shape of the bytes.** CockroachDB and YugabyteDB speak PG on the wire, but their isolation defaults and behavior, SQL dialect, and the texture of their errors differ from PostgreSQL. A driver connecting and an application behaving identically are separate questions — this article's 400-line server is living proof (psql connects, and this is emphatically not PostgreSQL).

The punchline: **a ~400-line server that a real psql 14 connects to — without changing one line of the SQL executor.**

## 1. The Striking Part Is the Scale of Reuse

Only two things were newly written: the event loop, and helpers that assemble/parse big-endian bytes. SQL execution calls the existing executor **as-is**:

```c
if (type == 'Q') {                          /* Simple Query */
    db->cur_session = c->session;           /* connection = session */
    FILE *of = open_memstream(&obuf, &olen);
    db_exec(db, payload, of);               /* ← the existing executor, unmodified */
    fclose(of);
    reply_from_output(c->fd, payload, obuf, txn_status);  /* text → wire */
}
```

The executor still writes human-readable text to a `FILE*`. The server intercepts it via `open_memstream` and merely **translates** it into wire messages. Clean layering paid its dividend: the network stacked on top with zero executor changes.

Crucially, **each TCP connection maps to one of [Part 4](/blog/project/db-hobby/db-internals-04-mvcc)'s transaction sessions** — every connection automatically gets its own transaction handle. The multi-transaction sessions turned out to be preparation for this part.

![Wire protocol server — psql passes the startup handshake, sends Simple Query, and the server translates executor output into wire messages](/uploads/project/db-hobby/wire-protocol-server.svg)

## 2. Dissecting the Protocol in Bytes

PostgreSQL wire protocol v3 is surprisingly modest. Past the handshake, nearly everything is a **`[type 1 byte][length 4 bytes][payload]`** frame (length big-endian, including itself).

**The handshake is the one irregularity** — as the official docs' opening line puts it, *"To begin a session, a frontend opens a connection to the server and sends a startup message."* That startup message has no type byte (it begins with the length). And psql under its default setting (`sslmode=prefer`) opens by sending an **SSLRequest** (magic `80877103`); with no SSL, refuse with a single byte:

```c
if (code == 80877103 || code == 80877104) {  /* SSL / GSS request */
    write(c->fd, "N", 1);   /* 'N' = no. psql retries startup in plaintext */
}
```

(Even this ask-then-fall-back round trip is evolving — PostgreSQL 17 added direct TLS, `sslnegotiation=direct`, starting TLS from the very first byte.)

When the real startup arrives (protocol `196608` = 3.0), four messages declare readiness:

```c
send_msg(fd, 'R', ...0);        /* AuthenticationOk */
send_msg(fd, 'S', "client_encoding" "UTF8");  /* ParameterStatus */
send_msg(fd, 'K', pid, key);    /* BackendKeyData (for cancels) */
send_ready(fd, 'I');            /* ReadyForQuery */
```

Two honest abbreviations here. Real PostgreSQL sends not one `ParameterStatus` but several — `server_version`, `standard_conforming_strings`, `DateStyle`, and more. Some drivers require those values, but for psql alone, `client_encoding` sufficed. Same for authentication — this server is trust-equivalent, handing everyone an unconditional `AuthenticationOk`, while real PostgreSQL's default is a SCRAM-SHA-256 challenge-response.

`BackendKeyData`'s pid and key are for **query cancellation**, and there's a fun bit of protocol design here — a connection mid-query is busy processing it, so a CancelRequest (magic `80877102`) arrives on a **separate, brand-new connection** carrying that magic instead of a startup. db-hobby only issues the key; cancellation itself isn't implemented.

One clever detail: **ReadyForQuery's status byte** — in the official definition, *"'I' if idle (not in a transaction block); 'T' if in a transaction block; or 'E' if in a failed transaction block"*. The server appends this one byte to every response, and psql redraws its prompt as `=>` / `=*>` / `=!>`. We derive it from whether the connection's session is `in_txn` — the engine's transaction state surfaces directly in psql's prompt.

One number that shows this contract's weight — the `196608` (v3.0) above has been **unchanged since PostgreSQL 7.4 (2003).** v2 support was removed only in PostgreSQL 14, and the first minor bump (3.2) arrived only in PostgreSQL 18. A contract stable for over twenty years is what let the psql/JDBC/driver ecosystem pile up on top of it.

## 3. Three Shapes of Response

Translating executor text into psql-comprehensible messages forks three ways:

- **① SELECT results** — `RowDescription` (column definitions, all simplified to text OID 25) + one `DataRow` per row + `CommandComplete("SELECT N")`.
- **② EXPLAIN** — like real PostgreSQL: multiple rows under a single `QUERY PLAN` column. Plan trees render nicely inside psql.
- **③ Everything else** (INSERT/COMMIT/…) — first line becomes the `CommandComplete` tag; lines starting with `"ERROR"` get wrapped in `ErrorResponse` so psql paints them red.

> **Honest limits**: building SELECT responses by **parsing the executor's text output** is a shortcut — a `TEXT` value containing `" | "` splits columns. Doing it right means the executor emitting structured rows (a real DB's tuple descriptor), which touches the whole executor. There's also no extended query protocol: psql's default conversation is simple query, which suffices — but this absence draws the line under §0's "borrow the whole JDBC ecosystem." **pgJDBC defaults to the extended query protocol, so JDBC cannot connect to this server.** The goal was a working psql with minimal change.

### The Other Half of the Contract, Unkept — the Extended Query Protocol

Real application drivers' default conversation isn't simple query but the **extended query protocol.** One statement splits into five messages — `Parse` (SQL text into a named statement), `Bind` (fill in parameter values, creating a portal), `Describe` (ask for the result shape), `Execute` (run the portal), `Sync` (mark the boundary). Three reasons for the split: parse and plan once and **reuse the plan** (prepared statements), send values in **binary format** rather than text, and above all, SQL text and values travel **in different messages.**

> **Common misconception, corrected**: *"Prepared statements are just a performance feature"* — from the protocol's viewpoint they are a security device. The SQL carried in `Parse` holds only `$1` placeholders and the values ride separately in `Bind`, so **there is simply no path by which a value can be interpreted as SQL.** The SQL injection that string concatenation invites gets blocked not by the application's escaping skills but **at the protocol level.**

## 4. The Climax — "Readers Don't Block Writers," Across the Network

[Part 4](/blog/project/db-hobby/db-internals-04-mvcc)'s scene, now with **two real psql clients.**

**Terminal A** (writer):
```
db-hobby=> BEGIN;
db-hobby=*> UPDATE t SET v = 999 WHERE id = 1;
UPDATE 1                          -- uncommitted; prompt shows =*> (in transaction)
```

**Terminal B** (reader) — while A holds the uncommitted UPDATE:
```
db-hobby=> SELECT * FROM t WHERE id = 1;
 id |  v
----+-----
 1  | 100                         -- not blocked! reads the old version
db-hobby=> UPDATE t SET v = 555 WHERE id = 1;
ERROR:  table 't' is locked by another transaction (write conflict)
```

After **Terminal A** commits — **Terminal B**:
```
db-hobby=> SELECT * FROM t WHERE id = 1;
 1  | 999                         -- the new value after commit
```

Not an invented transcript — **captured from two real psql 14.19 clients.** The reader is neither rejected nor made to wait; it reads its snapshot's old version, and only writers collide. MVCC's reason for existing, proven across the network by two clients. One caveat: Terminal B's **immediate ERROR** is the shape of db-hobby's double simplification — table-granularity locks, plus no-wait instead of waiting.

> **Common misconception, corrected**: *"Under MVCC, a write conflict errors out immediately"* — in real PostgreSQL, Terminal B's UPDATE **hangs waiting on the row lock**, with no error. Once A commits, READ COMMITTED re-evaluates the predicate on the newest version and simply proceeds; only REPEATABLE READ raises `ERROR: could not serialize access due to concurrent update`. InnoDB waits too — you only see `ERROR 1205 (HY000): Lock wait timeout exceeded; try restarting transaction` after `innodb_lock_wait_timeout` (default 50 s) expires. If you don't want the wait, the convention is to say so — PostgreSQL's `lock_timeout`, or `SELECT ... FOR UPDATE NOWAIT`.

## 5. Thread-per-Connection — and the Coarse Latch

The first server was a single-threaded `poll()` loop — interleaving, not true parallelism. Switching to **thread-per-connection** makes network I/O genuinely parallel — the thread version of PostgreSQL forking a process per connection.

Honestly, though — execution itself was **serialized under one global engine latch.** The executor stack still assumed a single thread, so correctness was bought with one coarse latch first. The thread-safe buffer pool from [Part 1](/blog/project/db-hobby/db-internals-01-storage) is "the first foothold for peeling that coarse latch off layer by layer" — and that peeling journey (parallel scans through measurement) is [Part 8](/blog/project/db-hobby/db-internals-08-parallel).

> **Practical/interview point**: thread/process-per-connection is simple but consumes resources per connection — which is why production PostgreSQL almost always sits behind a **connection pooler** like PgBouncer. Theory in [DB Connection Pool](/blog/theory/db-connection-pool) and [Tomcat NIO Request Handling](/blog/theory/tomcat-nio-request-handling).

> **Production anti-pattern**: running PgBouncer in transaction mode while using prepared statements, `SET`, or temp tables. As this article's server shows, in the wire world **session state belongs to a specific backend (connection)** — and transaction mode swaps backends per transaction, so an `Execute` lands on a backend that never saw "the statement you prepared earlier." That's the identity of the intermittent `prepared statement "S_1" does not exist`.

## 6. Wrap-up

- **The protocol is a contract** — honor it and you borrow the entire ecosystem. Why CockroachDB and friends speak PG wire.
- **The v3 frame is modest** — `[type 1B][length 4B][payload]`; the only irregularities are startup (no type byte) and SSLRequest (a one-byte 'N').
- **One ReadyForQuery status byte** drives psql's prompt (`=>`/`=*>`/`=!>`) — transaction state is engraved into the protocol.
- **Clean layering's dividend** — the server stacked onto an unmodified executor; the honest shortcuts are text-parsed responses and simple-query-only.
- **MVCC proven across the network** — two psqls; the reader unblocked, only writers collide (the immediate error is db-hobby's no-wait simplification — real PG waits on the row lock).

Next: the moment the planner gets stupid — where "always use an index if you can" goes wrong, and the **cost-based optimizer** begins.

## References (primary sources first)

- [PostgreSQL Documentation: Frontend/Backend Protocol](https://www.postgresql.org/docs/current/protocol.html)
- [PostgreSQL Documentation: Message Flow](https://www.postgresql.org/docs/current/protocol-flow.html) — primary source for the extended query and CancelRequest procedures
- [PostgreSQL Documentation: Message Formats](https://www.postgresql.org/docs/current/protocol-message-formats.html)
- [PgBouncer Documentation: Features](https://www.pgbouncer.org/features.html) — session-state constraints per pooling mode
- This blog: [DB Connection Pool](/blog/theory/db-connection-pool) · [Tomcat NIO Request Handling](/blog/theory/tomcat-nio-request-handling)
- [db-hobby source (GitHub)](https://github.com/dj258255/db-hobby) — `server.c`

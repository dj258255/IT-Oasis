---
title: '길이가 매번 다른 전문, 그리고 요청마다 새 소켓 — 가변 프레이밍과 커넥션 풀'
titleEn: 'A Message Whose Length Changes Every Time, and a New Socket per Request — Variable Framing and a Connection Pool'
description: "2편은 고정 61byte 전문만 다뤘고, 커넥션 풀과 길이 헤더(가변 전문)를 잔여로 남겨 뒀습니다. 4편에서 그 둘을 채웁니다. 거래내역 조회 응답처럼 레코드가 건수만큼 붙어 길이가 매번 다른 전문은 고정길이 프레이밍으로 못 자릅니다. 전문 앞에 4byte 길이 헤더를 붙여 2단계로 읽습니다 — 헤더를 먼저 다 모아 본문 길이를 안 뒤, 그만큼 더 모읍니다. 헤더 반쪽·본문 반쪽·뭉침·비정상 길이(숫자 아님·상한 초과)를 각각 방어했습니다. 그리고 2편이 요청마다 소켓을 새로 열던 것을, 최대 크기·유휴 반납·검증·고갈 거절을 갖춘 스레드 안전한 커넥션 풀로 바꿔 소켓을 재사용합니다. 가변 레코드 5건 왕복(길이 헤더가 보이는 hex), 순차 재사용(소켓 1개), 동시 폭주 시 최대 크기까지만 여는 것을 진짜 실행으로 남겼습니다."
descriptionEn: "Phase 2 handled only fixed 61-byte messages and left a connection pool and a length header (variable messages) as unfinished work. Phase 4 fills both. A transaction-history response, where records pile up by count so the length differs every time, can't be cut by fixed-length framing. So I prefix each message with a 4-byte length header and read in two stages: first gather the header to learn the body length, then gather exactly that many more bytes. I defended a half-arrived header, a half-arrived body, glued messages, and malformed lengths (non-numeric, over cap). Then I replaced Phase 2's open-a-socket-per-request with a thread-safe connection pool that has a max size, idle return, validation, and exhaustion rejection, so sockets get reused. I captured a 5-record variable round trip (with the length header visible in hex), sequential reuse (one socket), and opening only up to the max under a concurrent burst — all from real runs."
date: 2026-07-08
tags:
  - Java
  - Spring Boot
  - TCP
  - 프레이밍
  - 커넥션 풀
  - Spring Modulith
category: personal/gwanmun
coverImage: /uploads/project/gwanmun/cover.svg
draft: false
series: "gwanmun"
seriesOrder: 4
---

## 1. 상황 — 2편이 남겨 둔 두 개의 구멍

[2편](/blog/project/gwanmun/gwanmun-2-tcp-framing)에서 통로를 열 때, 잔여로 두 가지를 정직하게 적어 뒀습니다.

> 커넥션 풀 없음(요청당 소켓), 길이 헤더(가변 전문) 미구현.

2편의 프레이밍은 "한 전문 = 고정 61byte"만 다뤘습니다. 프레임 길이를 상수로 아니까, 그 길이만큼 모이면 잘라 내보내면 됐습니다. 하지만 실제 거래에는 **길이가 매번 다른 전문**이 있습니다. 대표적인 게 거래내역 조회 응답입니다 — 계좌에 거래가 3건이면 레코드 3개, 12건이면 12개가 붙어, 전문 전체 길이가 조회할 때마다 달라집니다. 프레임 길이 상수를 못 씁니다.

두 번째 구멍은 소켓입니다. 2편의 클라이언트는 `exchange()`가 불릴 때마다 소켓을 새로 열고, 응답을 받고, 닫았습니다. 요청 한 건에 TCP 3-way 핸드셰이크 한 번, 소켓 자원 한 벌을 매번 지불한 셈입니다. 한두 건이면 티가 안 나지만, 초당 수백 건이 흐르면 이 반복 비용이 그대로 지연이 됩니다.

이번 편의 목표는 그 두 구멍을 메우는 것입니다.

> 하나, 길이 헤더로 가변 전문을 프레이밍한다. 둘, 커넥션 풀로 소켓을 재사용한다.

## 2. 함정 — 가변 프레이밍의 2단계, 풀의 동시성과 고갈

### 함정 하나 — 헤더도 반쪽으로 온다

가변 전문의 정석은 "전문 앞에 본문이 몇 byte인지 적은 길이 헤더를 두는 것"입니다. 받는 쪽은 헤더를 읽어 본문 길이 L을 알고, L byte를 모으면 한 전문이 완성됩니다.

문제는 TCP가 바이트 스트림이라는 점이 여기서 한 겹 더 깊어진다는 것입니다. 2편에서 "고정 61byte도 한 번에 안 온다"를 다뤘는데, 가변에서는 **길이 헤더조차 반쪽으로 옵니다.** 4byte 헤더 중 2byte만 먼저 오면, 본문 길이를 아직 읽을 수조차 없습니다. 그러니 읽기가 2단계여야 합니다.

1. **1단계**: 헤더 4byte가 다 모일 때까지 기다린다(헤더 반쪽 방어).
2. **2단계**: 헤더로 본문 길이 L을 안 뒤, 본문 L byte가 다 모일 때까지 더 기다린다(본문 반쪽 방어).

여기에 2편의 함정들이 그대로 얹힙니다 — 여러 전문이 붙어 오는 뭉침, 한 전문 반쪽만 남는 경계.

### 함정 둘 — 길이 헤더를 믿으면 안 된다

길이 헤더 방식의 조용한 위험은, **헤더에 적힌 숫자를 그대로 믿는다는 것**입니다. 스트림에 쓰레기 바이트가 섞이거나 헤더가 손상되면, 헤더가 "본문 9999byte"라고 거짓말할 수 있습니다. 그걸 믿고 "9999byte 올 때까지 기다리자"고 하면, 오지도 않을 바이트를 무한정 기다리거나 거대한 버퍼를 잡으려 듭니다. 자원 고갈로 번지는 표면입니다. 그래서 헤더는 **검증하고, 어긋나면 즉시 끊어야** 합니다(fail-closed).

### 함정 셋 — 풀은 동시성과 고갈에서 샌다

커넥션 풀은 개념은 단순하지만("연 소켓을 쥐고 있다가 다음에 재사용") 두 곳에서 샙니다.

- **동시성**: 웹 요청은 스레드 풀에서 병렬로 처리됩니다. 여러 스레드가 동시에 풀에서 빌리고 반납하면, 카운터와 유휴 큐가 경쟁 상태에 빠져 "최대 4개"라던 풀이 5개, 6개를 열 수 있습니다.
- **고갈**: 최대 크기까지 다 빌려 나간 상태에서 또 요청이 오면 어떻게 할 것인가. 무한정 기다리면 스레드가 끝없이 적체됩니다. 정책을 정해야 합니다.

## 3. 판단 — 2단계 누적기, 검증하는 헤더, 잠그고 거절하는 풀

**하나, 가변 프레이밍은 고정 프레이밍과 나란히 둔다.** 2편의 `FixedLengthFramer` 옆에 `LengthPrefixedFramer`를 새로 만듭니다. 둘 다 "소켓 조각을 누적하다가 한 전문이 완성되면 잘라 내보낸다"는 같은 골격이되, 경계를 잡는 방법만 다릅니다(상수 길이 vs 헤더가 알려주는 길이).

**둘, 헤더는 4byte ASCII 십진수로 두되 반드시 검증한다.** 헤더가 숫자가 아니거나, 설정한 상한을 넘는 길이를 요구하면 그 자리에서 실패시킵니다. 4byte ASCII로는 음수를 표현할 수 없지만, 그 자리에 온 비-숫자·과대 길이가 현실의 "비정상 길이"입니다 — 믿지 않고 끊습니다.

**셋, 가변 전문 코덱은 고정 코덱을 두 번 쓰는 것으로 만든다.** 응답 본문은 "고정 헤더 + 고정 레코드 × N"입니다. 1편의 고정 코덱을 앞 헤더에 한 번, 뒤 레코드에 건수만큼 쓰면 됩니다. 경계는 이미 전송 계층의 길이 헤더가 확정해 주므로, 본문 전체 길이에서 역산합니다.

**넷, 풀은 하나의 락으로 관리하고, 가득 차면 거절한다.** 카운터·유휴 큐 갱신은 전부 하나의 `ReentrantLock` 안에서 하고, 느린 소켓 open만 락 밖에서 합니다. 최대 크기까지 다 나간 상태에서 또 빌리면, 정해진 시간만 기다리다 그래도 자리가 없으면 무한 대기 대신 예외로 거절합니다(빠른 실패).

## 4. 개선 — 헤더, 코덱, 풀

### 4-1. 길이 프리픽스 프레이머 — 2단계로 자른다

핵심은 `next()`입니다. 헤더가 덜 왔으면 1단계에서, 본문이 덜 왔으면 2단계에서 각각 `null`을 돌려주고 다음 조각을 기다립니다.

```java
public byte[] next() throws MalformedFrameException {
    if (size < HEADER_LENGTH) {
        return null;                       // 1단계: 헤더가 아직 반쪽
    }
    int bodyLength = parseHeader();        // 헤더를 읽어 본문 길이를 안다(검증 포함)
    int frameLength = HEADER_LENGTH + bodyLength;
    if (size < frameLength) {
        return null;                       // 2단계: 본문이 아직 덜 참
    }
    byte[] body = Arrays.copyOfRange(buffer, HEADER_LENGTH, frameLength);
    int remaining = size - frameLength;
    System.arraycopy(buffer, frameLength, buffer, 0, remaining); // 남은 건 다음 전문
    size = remaining;
    return body;
}
```

`parseHeader()`가 함정 둘(믿으면 안 되는 헤더)을 막습니다. 숫자가 아니면, 상한을 넘으면, 그 자리에서 끊습니다.

```java
private int parseHeader() throws MalformedFrameException {
    String header = new String(buffer, 0, HEADER_LENGTH, US_ASCII);
    int bodyLength = 0;
    for (int i = 0; i < HEADER_LENGTH; i++) {
        char c = header.charAt(i);
        if (c < '0' || c > '9') {          // 손상·쓰레기 바이트
            throw new MalformedFrameException("길이 헤더가 숫자가 아닙니다: '" + header + "'");
        }
        bodyLength = bodyLength * 10 + (c - '0');
    }
    if (bodyLength > maxBodyLength) {      // 자원 고갈 방어
        throw new MalformedFrameException("길이 헤더가 상한을 초과합니다: " + bodyLength);
    }
    return bodyLength;
}
```

읽는 쪽(`LengthPrefixedConnection`)은 2편의 `FramedConnection`과 같은 골격입니다 — read 버퍼를 일부러 작게(16byte) 잡아, 헤더·본문이 한 번에 안 오는 상황을 코드가 구조적으로 다루게 합니다.

### 4-2. 가변 전문 코덱 — 고정 코덱을 두 번

응답 본문은 `고정 헤더(30byte) + 레코드(55byte) × N`입니다. 헤더는 **건수(recordCount)**와 **전체 본문 길이(totalLength)**를 담아, 뒤에 몇 건이 얼마만큼 붙는지 스스로 설명합니다(self-describing). 파싱은 전체 길이에서 건수를 역산합니다.

```java
public <H, R> VariableMessage<H, R> parse(byte[] body, Class<H> headerType, Class<R> recordType) {
    int headerLen = MessageSpec.of(headerType).totalLength();   // 30
    int recordLen = MessageSpec.of(recordType).totalLength();   // 55
    int recordArea = body.length - headerLen;
    if (recordArea % recordLen != 0) {                          // 딱 안 떨어지면 잘린 전문
        throw new GwanmunParseException("레코드 영역이 레코드 길이로 나눠떨어지지 않습니다");
    }
    int count = recordArea / recordLen;
    H header = codec.parse(Arrays.copyOfRange(body, 0, headerLen), headerType);
    List<R> records = new ArrayList<>(count);
    for (int i = 0; i < count; i++) {
        int start = headerLen + i * recordLen;
        records.add(codec.parse(Arrays.copyOfRange(body, start, start + recordLen), recordType));
    }
    return new VariableMessage<>(header, records);
}
```

클라이언트는 파싱 후 헤더가 밝힌 건수·전체길이가 실제와 맞는지 교차검증합니다 — 전문의 자기 설명이 거짓이 아닌지 확인하는 것입니다.

### 4-3. 커넥션 풀 — 하나의 락, 재사용, 고갈 거절

풀은 유휴 연결을 큐에 두고, 빌릴 때 검증부터 합니다. 유휴가 있으면 재사용, 없으면 최대 크기 안에서 새로 열고, 가득 차면 대기 후 거절합니다.

```java
public Lease borrow() throws IOException, InterruptedException {
    long deadlineNanos = System.nanoTime() + borrowTimeoutMs * 1_000_000L;
    lock.lock();
    try {
        while (true) {
            Entry e = idle.pollFirst();
            if (e != null) {
                if (e.conn.isValid()) {                // 유휴 중 죽지 않았나 검증
                    active++; e.reuseCount++; reusedCount++;
                    return new Lease(e);               // 재사용
                }
                closeQuietly(e.conn); total--; destroyedCount++;
                continue;                              // 죽은 건 버리고 다시
            }
            if (total < maxSize) {
                total++;                               // 슬롯 선점(초과 생성 차단)
                lock.unlock();
                C conn = factory.create();             // 느린 소켓 open은 락 밖에서
                lock.lock();
                createdCount++; active++;
                return new Lease(new Entry(conn));
            }
            long remaining = deadlineNanos - System.nanoTime();
            if (remaining <= 0) {
                throw new PoolExhaustedException(name, maxSize, borrowTimeoutMs); // 거절
            }
            slotAvailable.awaitNanos(remaining);       // 반납을 기다린다
        }
    } finally {
        if (lock.isHeldByCurrentThread()) lock.unlock();
    }
}
```

`total < maxSize`에서 먼저 `total++`로 슬롯을 선점하는 게 동시성 방어의 핵심입니다. 여러 스레드가 동시에 "여유 있다"를 봐도, 슬롯을 선점한 스레드만 실제로 새 소켓을 열기 때문에 최대 크기를 넘지 않습니다. 반납(`release`)은 연결을 검증해 살아 있으면 유휴 큐로 돌리고, 죽었거나 처리 중 깨졌으면(`invalidate`) 폐기합니다.

`CoreBankingClient`(2편, 고정 61byte)와 새 `TransactionHistoryClient`(가변)가 각자 이 풀을 하나씩 들고, `exchange()`/`query()`가 빌려 쓰고 반납합니다. 계정계가 keep-alive라 한 소켓으로 여러 전문을 주고받을 수 있어(서버측 처리 루프가 프레임이 더 안 올 때까지 읽습니다) 풀이 성립합니다.

## 5. 실측 — 진짜 실행

앱을 8090에 띄우고(내장 목업 계정계 두 개: 잔액조회 9099, 거래내역 9098), 실제로 왕복시켰습니다.

### 가변 전문 왕복 — 길이 헤더가 보인다

`12345678901234` 계좌의 거래내역 5건을 조회했습니다. 요청 전선은 44byte(길이 헤더 4 + 본문 40), 응답 전선은 309byte입니다. 응답의 앞 4byte가 길이 헤더입니다(실제 출력).

```
응답 전선 앞부분 (hex):
0000  30 33 30 35 30 33 31 30   0305 0310   ← 앞 4byte "0305" = 본문 305 byte
0008  31 32 33 34 35 36 37 38   12345678
...
총 309 byte (길이 헤더 4 + 본문 305 = 헤더 30 + 레코드 55 × 5)
```

헤더 `30 33 30 35`는 ASCII `"0305"`, 즉 본문이 305byte라는 선언입니다. 305 = 헤더 30 + 레코드 55 × 5건. 파싱하면 헤더와 레코드 5건이 나옵니다(응답 JSON에서 발췌).

```json
"header": { "messageType": "0310", "accountNo": "12345678901234",
            "recordCount": "5", "totalLength": "305", "responseCode": "0000" },
"records": [
  { "seq": "1", "txDate": "20260621", "txType": "입금", "amount": "477000",
    "balanceAfter": "6879922000", "summary": "급여이체" },
  { "seq": "2", "txDate": "20260624", "txType": "출금", "amount": "8000",
    "balanceAfter": "6879914000", "summary": "카드결제" },
  ... (3건 더)
]
```

`txType`(입금/출금)과 `summary`(급여이체·카드결제…)가 한글입니다. 레코드 슬라이스도 byte 오프셋으로 잘라 EUC-KR로 디코딩하므로, 2byte 한글이 경계에서 안 깨집니다(1편의 원칙이 레코드에도 그대로).

건수를 바꾸면 전체 길이가 따라 바뀝니다 — 3건이면 본문 195byte, 10건이면 본문 580byte. 이게 "가변"의 실측입니다.

### 커넥션 풀 — 순차는 소켓 1개, 동시는 최대 크기까지

같은 클라이언트로 순차로 6번 조회하면, 첫 왕복만 소켓을 새로 열고 이후는 재사용합니다(실제 출력).

```
조회 1: created(신규 소켓)       pool[created=1 reused=0 idle=1]
조회 2: reused #1            pool[created=1 reused=1 idle=1]
조회 3: reused #2            pool[created=1 reused=2 idle=1]
조회 4: reused #3            pool[created=1 reused=3 idle=1]
조회 5: reused #4            pool[created=1 reused=4 idle=1]
조회 6: reused #5            pool[created=1 reused=5 idle=1]
```

`created`가 1로 고정입니다 — 소켓을 딱 하나만 열어 여섯 번 재사용했습니다. 2편이라면 여기서 소켓을 여섯 번 열고 닫았을 겁니다.

같은 풀에 동시에 10건을 폭주시키면, 이번엔 여러 소켓이 필요합니다. 하지만 최대 크기(4) 이상은 절대 열지 않습니다(실제 출력).

```
동시 폭주 후: created=4 (== max 4) · reused=12 · idle=4 · destroyed=0
```

`created=4`가 정확히 최대 크기와 같습니다. 10개 요청이 동시에 몰려도 소켓은 4개까지만 열고 나머지는 반납된 걸 이어받아 재사용했습니다. 슬롯 선점 방어가 동시성에서 초과 생성을 막은 결과입니다. 잔액조회(고정 61byte) 풀도 같은 방식으로 붙어, 세 번 조회하면 `created=1 reused=2`로 소켓 하나를 재사용합니다.

화면에도 같은 걸 붙였습니다 — 가변 전문 왕복은 길이 헤더가 노랗게 강조된 hex 덤프와 레코드 표를, 풀 상태는 활성/유휴/재사용 카운터를 보여줍니다.

![가변 전문 왕복(길이 헤더 강조 hex + 레코드 5건)과 커넥션 풀 상태(순차 재사용·동시 최대 크기)](/uploads/project/gwanmun/variable-length-demo.png)

### 함정은 테스트로 강제했다

가장 중요한 경계들은 화면이 아니라 테스트로 못 박았습니다. `./gradlew test`는 **80개 전부 그린**입니다(2·3편의 52개 + 이번 28개).

- `LengthPrefixedFramerTest`(11) — 헤더 반쪽, 본문 반쪽, 한 바이트씩, 뭉침(길이 다른 세 전문), 한 전문 반, 빈 본문, 그리고 비정상 길이 거절(숫자 아님·상한 초과).
- `VariableMessageCodecTest`(4) — 레코드 5건 왕복 무손실(한글 포함), 0·1·12건 가변, 잘린 전문 거절.
- `ConnectionPoolTest`(7) — 재사용(같은 소켓 객체), 죽은 연결 폐기, `invalidate` 폐기, 고갈 거절(대기 후 `PoolExhausted`), 대기자가 반납분을 이어받음, 동시성(8스레드×50회가 최대 3짜리 풀을 쳐도 활성이 3을 절대 안 넘음), 닫힌 풀 거절.
- `MockTransactionHistoryServerTest`(6) — 실제 소켓 가변 왕복, 건수별 길이 차이, 결정론, 풀 재사용(한 소켓으로 keep-alive 3건), 서버측 partial read(길이 헤더 중간·본문 중간에서 쪼갠 요청 재조립), 동시 8건.

동시성 테스트는 소켓 없이 가짜 연결로 풀 계약만 봅니다 — 활성 수가 최대를 넘지 않고, 재사용이 실제로 일어나며, 만들어진 연결이 최대 크기 이하인지.

```java
assertThat(maxObservedActive.get()).isLessThanOrEqualTo(maxSize); // 초과 생성 없음
assertThat(ids.get()).isLessThanOrEqualTo(maxSize);               // 최대만큼만 열림
assertThat(pool.stats().reused()).isGreaterThan(0);               // 재사용이 실제로
```

### 모듈 경계는 계속 코드가 강제한다

3편에서 세운 모듈러 모놀리스 경계는 이번에도 `ApplicationModules.verify()`가 그린으로 지킵니다. 클래스가 늘었지만(가변 프레이머·풀·거래내역 클라이언트는 `core`에, 가변 코덱·레코드 DTO는 `message`에, 새 컨트롤러는 `web`에) 전부 제자리에 들어가 순환이 생기지 않았습니다. 의존은 여전히 단방향 DAG이고, 이번에 `web → core` 한 줄이 늘었습니다(새 컨트롤러가 거래내역 클라이언트를 씀).

```
web      → gateway, message, core
gateway  → message, core
core     → message
message  → (없음 — 순수 모듈)
```

Documenter가 다시 그린 다이어그램은 `docs/modules/`에 갱신돼 있습니다.

## 6. 잔여 — 정직하게 안 한 것

- **길이 헤더는 4byte ASCII 십진수 한 종류.** 본문 최대 9999byte까지만 표현합니다. 실무에는 2byte·4byte 바이너리(빅엔디언), 헤더에 본문 외 다른 필드까지 포함하는 변형이 많지만, 여기선 한 종류로 원리를 보였습니다. 더 큰 전문·다른 헤더 규격은 프레이머의 헤더 해석부만 바꾸면 되는 자리로 남깁니다.
- **풀은 최소 기능.** 최대 크기·유휴 반납·검증·고갈 거절까지입니다. 유휴 연결의 최대 생존 시간(오래 놀던 소켓 선제 폐기), 주기적 헬스체크, 최소 유휴 수 유지(warm pool), 연결 누수 감지 같은 상용 풀의 기능은 없습니다. 검증은 빌려주기/반납 시점의 소켓 상태 확인까지입니다.
- **파이프라이닝 없음.** 한 연결에서 요청→응답을 끝낸 뒤 다음을 보냅니다. 응답을 기다리지 않고 요청을 연달아 밀어 넣는 파이프라이닝은 범위 밖입니다(프레이머는 뭉침을 처리하니 받는 쪽 토대는 있지만, 보내는 쪽 상관관계 관리는 안 했습니다).
- **가변 전문은 대표 한 종.** 거래내역 조회 하나로 "고정 헤더 + 반복 레코드" 구조를 보였습니다. 중첩 가변(레코드 안에 또 가변 배열)이나 선택 필드가 있는 전문은 다루지 않았습니다.

2편이 남긴 두 구멍을 메웠습니다. 이제 길이가 매번 다른 전문도 프레이밍으로 정확히 자르고, 소켓은 요청마다 새로 열지 않고 재사용합니다. 통로가 더 튼튼해졌습니다.

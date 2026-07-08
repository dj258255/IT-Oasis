---
title: 'TCP는 한 전문을 한 번에 주지 않는다 — 프레이밍을 손으로'
titleEn: 'TCP Never Hands You a Whole Message at Once — Framing by Hand'
description: "Phase 1에서 만든 전문 파서를 실제 소켓에 붙였습니다. 그런데 TCP는 바이트 스트림이라 '고정 61byte 전문'이라도 소켓 read 한 번이 그걸 온전히 준다는 보장이 없습니다. 반쪽만 왔다가 나머지가 뒤에 오고(partial read), 두 전문이 붙어 오기도 합니다(뭉침). 필요한 바이트가 다 모일 때까지 버퍼에 누적한 뒤에야 한 전문으로 넘기는 프레이밍을 순수 java.net 소켓으로 직접 짜고, 목업 계정계 TCP 서버와 REST→전문→TCP→전문→JSON 왕복을 실제 두 프로세스로 붙인 기록입니다. 반쪽 도착 재조립을 테스트로 강제하고, 소켓을 타고 오간 진짜 hex를 화면과 curl로 남겼습니다."
descriptionEn: "I wired the fixed-length message parser from Phase 1 onto a real socket. But TCP is a byte stream: even for a fixed 61-byte message, a single socket read is not guaranteed to hand you the whole thing. Half arrives, the rest comes later (partial read); or two messages arrive glued together. I hand-wrote a framer in plain java.net sockets that accumulates bytes until a full message is present before passing it on, stood up a mock core-banking TCP server, and wired a REST→message→TCP→message→JSON round trip across two real processes. Partial-read reassembly is forced by tests, and the real bytes that crossed the socket are captured on screen and via curl."
date: 2026-07-08
tags:
  - Java
  - Spring Boot
  - TCP
  - 소켓
  - 프레이밍
  - EAI
category: personal/gwanmun
coverImage: /uploads/project/gwanmun/cover.svg
draft: false
series: "gwanmun"
seriesOrder: 2
---

## 1. 상황 — 이제 소켓 앞에 선다

[1편](/blog/project/gwanmun/gwanmun-1-message-parser)에서 전문 ↔ JSON 변환 엔진을 만들었습니다. 바이트 덩어리를 오프셋대로 잘라 DTO로, 다시 바이트로. 하지만 그건 `byte[]`를 손에 쥐고 있을 때의 이야기입니다. 파서는 바이트를 해석할 뿐, 그 바이트를 **어디서 받아오는지**는 아직 모릅니다.

이번 편의 목표는 하나입니다.

> REST로 들어온 잔액조회(JSON)를 → 요청 전문으로 만들어 → **TCP 소켓**으로 계정계에 보내고 → 응답 전문을 받아 → JSON으로 돌려준다.

그러려면 상대가 필요합니다. 진짜 은행 계정계는 없으니 **목업 계정계 TCP 서버**를 만들어, 잔액조회 요청 전문(30byte)을 받으면 응답 전문(61byte)을 돌려주게 했습니다. 그리고 앱과 계정계를 실제로 **소켓으로** 대화시킵니다. 여기서 Phase 1에는 없던 함정이 하나 튀어나옵니다.

## 2. 함정 — "고정 61byte"인데 한 번에 안 온다

처음엔 이렇게 생각했습니다. "응답이 딱 61byte로 고정이니, 소켓에서 61byte 읽으면 되잖아?"

```java
byte[] buf = new byte[61];
in.read(buf);   // 이게 61byte를 다 준다는 보장이 없다
```

`InputStream.read(byte[])`는 **요청한 만큼 준다고 약속하지 않습니다.** 지금 이 순간 커널 버퍼에 있는 만큼만 줍니다. TCP는 메시지 단위가 아니라 **바이트 스트림**이라, "전문"이라는 경계는 우리 머릿속에만 있지 네트워크에는 없어요. 그래서 두 가지가 실제로 벌어집니다.

- **반쪽 도착(partial read)**: 61byte 중 30byte만 먼저 오고, 나머지 31byte는 다음 `read`에 옵니다. 위 코드는 30byte만 읽고 "다 왔다"고 착각합니다.
- **뭉침**: 요청을 연속으로 두 번 보내면, 두 전문이 붙어 122byte가 한 번의 `read`로 올 수 있습니다. 61byte만 뚝 잘라 쓰면 나머지 61byte는 다음 전문의 앞부분인데 그냥 흘려버리거나 섞입니다.

이건 로컬에서 짧은 전문을 주고받을 땐 운 좋게 안 터지다가, 전문이 길어지거나 네트워크가 끼면 재현되는 종류의 버그입니다. 운에 기대면 안 됩니다.

여기서 이번 편의 원칙이 나옵니다.

> **경계는 내가 세운다.** 필요한 바이트가 다 모일 때까지 버퍼에 쌓아두고, 프레임 길이만큼 찼을 때에만 한 전문으로 잘라 넘긴다. 이 누적·경계 관리를 **프레이밍**이라 부른다.

## 3. 판단 — Netty를 쓰기 전에, 왜 필요한지부터

Netty에는 `FixedLengthFrameDecoder`, `LengthFieldBasedFrameDecoder`가 있습니다. 정확히 이 문제를 풀려고 있는 물건이에요. 하지만 여기서는 **프레이밍을 순수 `java.net` 소켓으로 직접 짰습니다.** 라이브러리에 맡기기 전에 "TCP 스트림인데 왜 프레이밍이 필요한가"를 버퍼 누적·경계 관리 코드로 직접 겪어보려는 거죠.

프레이밍 방식은 두 갈래입니다. **고정길이**면 길이를 상수로 알고 있으니 그 길이만큼 모으면 되고, **가변길이**면 전문 앞머리에 길이 헤더를 두고 그 값을 읽어 경계를 잡습니다. 우리 전문은 종류별로 길이가 고정(요청 30, 응답 61)이라 **고정길이 프레이밍**으로 충분합니다. 길이 헤더 방식은 가변 전문이 필요해질 때의 확장 지점으로 남겨뒀습니다.

## 4. 개선 — 누적기와, 일부러 작게 잡은 read 버퍼

핵심은 `FixedLengthFramer`입니다. 소켓에서 온 바이트 조각을 계속 `feed`로 밀어넣고, `next()`로 완성된 프레임을 꺼냅니다. 덜 찼으면 `null`.

```java
public byte[] next() {
    if (size < frameLength) {
        return null;                 // 아직 한 전문이 안 됐다 — 더 기다린다
    }
    byte[] frame = Arrays.copyOfRange(buffer, 0, frameLength);
    int remaining = size - frameLength;
    // 남은 바이트(다음 전문의 앞부분일 수 있음)를 앞으로 당겨 압축한다
    System.arraycopy(buffer, frameLength, buffer, 0, remaining);
    size = remaining;
    return frame;
}
```

`next()`가 완성 프레임을 꺼낸 뒤 **남은 바이트를 버퍼 앞으로 당기는 것**이 뭉침을 다루는 부분입니다. 두 전문이 붙어 왔으면, 첫 프레임을 꺼내고 남은 61byte가 버퍼에 그대로 보존됩니다. `next()`를 한 번 더 부르면 두 번째 전문이 나옵니다.

이 누적기를 소켓에 붙인 게 `FramedConnection.readFrame()`입니다. 여기서 한 가지 의도적인 선택을 했습니다 — **read 버퍼를 전문보다 작은 64byte로 잡았습니다.**

```java
private static final int CHUNK = 64;   // 61byte 전문보다 작게

public byte[] readFrame() throws IOException {
    byte[] frame = framer.next();      // 지난번 뭉쳐 온 다음 전문이 이미 있을 수도
    if (frame != null) return frame;
    while (true) {
        int n = in.read(chunk);        // 한 번에 몇 byte가 올지 모른다
        if (n < 0) {                   // EOF
            if (framer.hasPartial())
                throw new EOFException("연결이 전문 중간에 끊겼습니다...");
            return null;               // 프레임 경계에서의 깔끔한 종료
        }
        framer.feed(chunk, 0, n);
        frame = framer.next();
        if (frame != null) return frame;
        // 아직 덜 찼다 — 다음 조각을 기다린다(partial read를 계속 누적)
    }
}
```

버퍼를 작게 잡은 건 성능이 아니라 **정직함** 때문입니다. 큰 버퍼로 한 방에 읽으면 로컬에선 61byte가 우연히 한 번에 담겨 partial read 경로가 아예 안 돌 수 있습니다. 그러면 "우린 partial read를 처리한다"는 말이 코드로 증명되지 않아요. 작게 잡으면 61byte 전문조차 반드시 여러 번의 `read`로 조립되므로, 재조립 경로가 항상 실제로 돕니다.

목업 계정계 서버는 이 위에 얹었습니다. `ServerSocket`으로 accept하고, 연결마다 `FramedConnection`으로 요청 전문(30byte)을 읽어 파싱하고, 계좌번호에서 **결정론적으로** 만든 가짜 잔액으로 응답 전문(61byte)을 지어 돌려줍니다. 잔액 계산은 계정계의 몫이라 서버에 뒀습니다 — 관문(gwanmun)은 흐름만 통제하고 계산은 위임한다는 원칙입니다. 같은 연결로 여러 요청이 오면 순서대로 처리하고(keep-alive), 없는 계좌(0)엔 응답코드 `0001`로 정직하게 오류도 하나 냅니다.

게이트웨이 배선(`GatewayService`)은 이 조각들을 잇습니다. `accountNo` → 요청 전문 build → `CoreBankingClient`가 소켓으로 송수신 → 응답 전문 parse → JSON. 계정계 연결이 실패하면 파싱 오류와 구분해 `GatewayException`으로 감싸 502로 돌려줍니다(입력 자체가 틀리면 400). 무한 대기를 막는 연결·읽기 타임아웃도 걸었습니다.

## 5. 실측 — 진짜 두 프로세스, 진짜 소켓

말로 "된다"가 아니라, **앱과 계정계를 별개의 프로세스로** 띄워 소켓으로 대화시켰습니다.

- 계정계: `./gradlew runMockCore` → 독립 JVM(PID 67046)이 9099 포트에서 대기
- 앱: `java -jar ...jar --gwanmun.core.embedded=false` → 8090 포트(PID 64210), 내장 계정계는 끔

두 PID가 9099 소켓으로 붙은 상태에서 curl 한 방:

```
POST /api/gateway/balance {"accountNo":"12345678901234"}
```

돌아온 응답입니다(값은 손대지 않은 실제 출력).

```json
{
  "requestHex":  "303230303132333435363738393031323334494E30312020202020202020",
  "requestLength": 30,
  "responseHex": "303231303132333435363738393031323334494E30313030303030363837
                  3934343530303030303030C1A4BBF320C3B3B8AEB5C7BEFABDC0B4CFB4D920",
  "responseLength": 61,
  "json": {
    "messageType": "0210",
    "accountNo": "12345678901234",
    "txCode": "IN01",
    "balance": "6879445000",
    "responseCode": "0000",
    "responseMessage": "정상 처리되었습니다"
  },
  "core": "127.0.0.1:9099",
  "elapsedMs": 12
}
```

이 hex는 **실제로 소켓을 타고 오간 바이트**입니다. 응답 뒤쪽 `C1A4 BBF3 20 C3B3 B8AE ...`는 EUC-KR로 인코딩된 `정`(C1A4) `상`(BBF3) `공백`(20) `처`(C3B3)... — 소켓을 건너온 한글이 파서에서 안 깨지고 `정상 처리되었습니다`로 복원됐습니다. 잔액 `6879445000`은 계좌번호에서 결정론적으로 만든 값이라, 같은 계좌면 언제 조회해도 같습니다.

화면에도 같은 걸 붙였습니다. 계좌번호를 넣고 전송하면 (a)나간 요청 전문 hex (b)돌아온 응답 전문 hex (c)최종 JSON이 한눈에 보입니다.

![게이트웨이 왕복 — REST에서 전문으로, TCP를 건너, 다시 JSON으로](/uploads/project/gwanmun/gateway-roundtrip.png)

가장 중요한 검증은 **반쪽 도착 재조립**입니다. 이걸 테스트로 강제했습니다. 하나는 누적기 단위 테스트로, 61byte 전문을 **한 바이트씩 61번** 나눠 넣어도 60번째까지는 `null`, 61번째에 원본과 동일한 프레임이 나오는지 확인합니다.

```java
for (int i = 0; i < 60; i++) {
    framer.feed(full, i, 1);
    assertThat(framer.next()).isNull();   // 아직 미완성
}
framer.feed(full, 60, 1);
assertThat(framer.next()).isEqualTo(full); // 마지막 한 byte에 완성
```

다른 하나는 **실제 소켓 위에서** 강제합니다. 클라이언트가 30byte 요청을 `12 + 18`로 쪼개 보내고 중간에 시간차를 주면, 서버가 앞부분만 먼저 받게 됩니다. 그래도 서버가 반쪽을 누적해 한 전문으로 조립하고 정상 응답을 돌려주는지 봅니다.

```java
out.write(request, 0, 12); out.flush();
Thread.sleep(80);              // 앞부분만 먼저 도착하도록
out.write(request, 12, 18); out.flush();
// 서버가 재조립해 61byte 응답을 보내야 한다
```

뭉침(두 전문이 한 조각에), 한 연결로 연속 3건, 동시 10건도 테스트로 덮었습니다. `./gradlew test`는 **37개 전부 그린**입니다(Phase 1의 20개 + 이번 17개).

## 6. 잔여 — 정직하게 안 한 것

- **커넥션 풀·재사용**: 클라이언트는 요청당 소켓을 하나 열고 닫습니다. 단순함을 택했고, 풀링은 부하가 실제로 필요해질 때의 확장 지점입니다.
- **길이 헤더(가변 전문)**: 이번엔 길이가 고정이라 상수 프레이밍으로 충분했습니다. 가변 전문이 생기면 앞머리 길이 헤더 방식이 필요한데, 구조는 같고 "몇 byte 모을지"를 상수 대신 헤더에서 읽는 차이입니다.
- **목업 계정계의 잔액**: 계좌번호 해시로 만든 합성값입니다. 실제 은행 로직이 아니라, "계정계가 계산을 위임받아 응답한다"는 흐름을 재현하는 용도입니다.
- **전문 암호화·전용선**: 실제 금융망 보안(VPN, 전문 암호화)은 인프라 영역이라 손대지 않았습니다. 여긴 평문 로컬 소켓입니다. 학습판의 경계입니다.

이제 통역기가 소켓 앞에 섰습니다. 바이트가 스트림으로 쪼개져 와도 전문으로 다시 세우고, 그 전문을 REST 세계로 넘기고, 답을 다시 전문으로 만들어 돌려보냅니다. 하지만 이 통로는 아직 **아무나 드나들 수 있습니다.** 다음 편은 이 앞에 문지기를 세웁니다 — 인증·라우팅·유량제어를, 역시 손으로.

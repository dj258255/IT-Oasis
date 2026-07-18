---
title: '고정길이 전문 파서와 TCP 프레이밍을 손으로 짜며 배운 것, 바이트가 진실이다'
titleEn: 'Hand-Writing a Fixed-Length Message Parser and TCP Framing, Where Bytes Are the Truth'
description: '은행 계정계의 고정길이 전문(電文)을 모바일 앱이 알아듣는 JSON으로, 그 반대로도 바꾸는 변환 엔진을 만들고(1부), 그 파서를 실제 TCP 소켓 앞에 세웠습니다(2부). 1부의 핵심은 하나입니다. 한글이 섞인 전문을 String.substring으로 자르면 깨진다는 것입니다. EUC-KR에서 한글 한 글자는 2byte라, 자르기도 패딩 제거도 전부 byte[] 위에서 해야 합니다. 필드 레이아웃을 어노테이션 스펙으로 선언하고 오프셋을 자동 계산해 byte[]↔DTO↔JSON을 양방향 변환하는 과정을, 왕복 무손실 테스트와 hex 덤프로 검증했습니다. 2부의 함정은 TCP가 바이트 스트림이라는 사실입니다. ''고정 61byte 전문''이라도 소켓 read 한 번이 그걸 온전히 준다는 보장이 없습니다. 반쪽만 왔다가 나머지가 뒤에 오고(partial read), 두 전문이 붙어 오기도 합니다(뭉침). 필요한 바이트가 다 모일 때까지 버퍼에 누적한 뒤에야 한 전문으로 넘기는 프레이밍을 순수 java.net 소켓으로 직접 짜고, 목업 계정계 TCP 서버를 세워 REST→전문→TCP→전문→JSON 왕복을 실제 두 프로세스로 붙였습니다. 반쪽 도착 재조립을 테스트로 강제하고, 소켓을 타고 오간 진짜 hex를 화면과 curl로 남겼습니다.'
descriptionEn: 'I built an engine that converts a bank core system''s fixed-length messages into JSON the mobile app understands, and back (part 1), then put that parser in front of a real TCP socket (part 2). The crux of part 1 is one thing: slicing a message that contains Korean with String.substring breaks it. In EUC-KR a single Korean character is 2 bytes, so both slicing and padding removal must happen on byte[]. Field layouts are declared as annotation specs with auto-computed offsets, converting byte[]↔DTO↔JSON in both directions, all verified with lossless round-trip tests and hex dumps. Part 2 faces the trap that TCP is a byte stream: even for a fixed 61-byte message, a single socket read is not guaranteed to hand you the whole thing. Half arrives and the rest comes later (partial read), or two messages arrive glued together. I hand-wrote a framer in plain java.net sockets that accumulates bytes until a full message is present before passing it on, stood up a mock core-banking TCP server, and wired a REST→message→TCP→message→JSON round trip across two real processes. Partial-read reassembly is forced by tests, and the real bytes that crossed the socket are captured on screen and via curl.'
date: 2025-07-20
tags:
  - Java
  - Spring Boot
  - EUC-KR
  - 전문
  - 파서
  - EAI
  - TCP
  - 소켓
  - 프레이밍
category: personal/gwanmun
coverImage: /uploads/project/gwanmun/cover.svg
draft: false
series: "gwanmun"
seriesOrder: 1
---

## 1부. 고정길이 전문 파서를 손으로 짜기

### 1. 상황, 통역이 먼저다

[0편](/blog/project/gwanmun/gwanmun-0-why)에서 그림을 그렸습니다. 계정계는 고정길이 전문(電文)과 TCP로만 말하고, 앱은 JSON과 HTTP로만 말합니다. 둘 사이에 통역기를 세우기로 했는데, 그 통역기가 제일 먼저 할 줄 알아야 하는 일이 이것입니다.

> 계정계가 보낸 `"0210" + "12345678901234" + "IN01" + ...` 같은 **바이트 덩어리**를 `{"accountNo":"12345678901234", ...}` **JSON**으로 바꾸고, 반대로도 바꾼다.

네트워크(TCP 소켓)는 그다음입니다. 소켓으로 아무리 잘 받아와도, 그 바이트를 해석하지 못하면 통역은 시작조차 안 되기 때문입니다. 그래서 이번 편은 오직 **전문 ↔ DTO ↔ JSON 변환 엔진** 하나만 만듭니다.

전문이 낯설 수 있어서 짚고 갑니다. 고정길이 전문은 이렇게 생겼습니다.

```
0210 12345678901234 IN01 000000001234567 0000 정상 처리되었습니다
└──┘ └────────────┘ └──┘ └─────────────┘ └──┘ └──────────────┘
전문   계좌번호(14)   거래  잔액(15,좌측     응답   응답메시지(20byte,
구분   숫자, 좌측       코드  제로패딩)        코드   EUC-KR)
(4)    제로패딩
```

띄어쓰기는 설명을 위해 넣은 것이고, 실제로는 **공백 없이 딱 붙은 61바이트**입니다. 어느 위치(offset)부터 몇 바이트가 어떤 필드인지를 양쪽이 미리 약속해 두고, 그 약속만으로 해석합니다. 구분자(콤마 같은 것)가 없습니다. 자릿수 자체가 의미입니다.

### 2. 한계, String으로 다루면 한글이 깨진다

처음엔 단순하게 생각했습니다. "문자열 잘라서 필드별로 나누면 되잖아?"

```java
String account = raw.substring(4, 18);   // 계좌번호
String message = raw.substring(41, 61);  // 응답메시지
```

이게 함정입니다. `substring`은 **문자(char) 인덱스**로 자릅니다. 그런데 전문의 길이는 **byte 기준**입니다. 영문·숫자만 있으면 1문자=1byte라 우연히 맞지만 한글이 들어오는 순간 어긋납니다.

한글은 EUC-KR 인코딩에서 **한 글자가 2byte**입니다. 실제로 확인해보면:

```
"정" → C1 A4   (2 byte)
"상" → BB F3   (2 byte)
```

응답메시지 필드는 "20byte"인데, 이걸 "20문자"로 오해하고 `substring(41, 61)`로 자르면 위치가 밀립니다. 게다가 byte 배열을 String으로 먼저 바꾼 뒤 자르면, 2byte짜리 한글이 필드 경계에서 반토막 나며 **깨진 글자(�)**가 나옵니다. 바이트의 세계와 문자의 세계를 섞은 대가입니다.

여기서 이 프로젝트의 원칙이 나옵니다.

> **바이트가 진실이다.** 자르기도, 패딩 제거도, 전부 byte[] 위에서 한다. 디코딩(byte→문자)은 **맨 마지막에 딱 한 번만** 한다.

패딩·정렬 관례도 함께 못 박아야 했습니다. 금융 전문의 오래된 관습입니다.

- **숫자**: 우측 정렬 + 좌측 제로패딩. 잔액 `1234567`은 15자리 필드에서 `000000001234567`.
- **문자**: 좌측 정렬 + 우측 공백패딩. 거래코드 `IN01`은 그대로, 짧으면 오른쪽을 공백으로 채움.

이 둘을 헷갈리면 파싱이 통째로 무너집니다.

### 3. 레이아웃을 스펙으로 선언한다는 판단

전문은 한 종류가 아닙니다. 잔액조회, 이체, 거래내역... 거래마다 필드 구성이 다릅니다. 전문마다 `substring` 파싱 코드를 새로 짜면, 필드 하나가 밀릴 때마다 뒤가 전부 깨지고 눈으로 오프셋을 세야 하는 지옥이 옵니다.

그래서 **레이아웃을 선언(스펙)으로 분리**하기로 했습니다. DTO 필드에 어노테이션으로 "이 필드는 몇 번째, 몇 byte, 무슨 타입"만 적어두면, **오프셋은 앞 필드들의 길이 합으로 자동 계산**됩니다. 사람이 오프셋을 세지 않습니다.

```java
@Data
public class BalanceInquiryResponse {
    @Field(order = 1, length = 4,  type = FieldType.TEXT)    String messageType;
    @Field(order = 2, length = 14, type = FieldType.NUMERIC) String accountNo;
    @Field(order = 3, length = 4,  type = FieldType.TEXT)    String txCode;
    @Field(order = 4, length = 15, type = FieldType.NUMERIC) String balance;
    @Field(order = 5, length = 4,  type = FieldType.TEXT)    String responseCode;
    @Field(order = 6, length = 20, type = FieldType.TEXT)    String responseMessage; // 한글
}
```

`length`는 **byte 수**입니다. `responseMessage`의 20은 "문자 20자"로 읽기 쉽지만 실제로는 "20byte"이고, 한글로는 최대 10자까지 담긴다는 뜻입니다. 타입(`NUMERIC`/`TEXT`)이 곧 패딩·정렬 관례를 결정하니, 필드마다 그걸 따로 적을 필요가 없습니다.

### 4. 개선, 변환 엔진의 뼈대

엔진은 세 조각입니다.

**스펙 해석(`MessageSpec`)**은 DTO 클래스를 리플렉션으로 훑어 `@Field`를 `order`순으로 정렬하고 오프셋을 누적 계산해 총 길이를 확정합니다. 매번 하면 낭비라 클래스별로 캐시합니다.

**파서(`byte[] → DTO`)**, 여기가 원칙이 사는 곳입니다.

```java
byte[] slice   = Arrays.copyOfRange(raw, field.offset(), field.endOffset()); // byte로 자르고
byte[] trimmed = stripPadding(slice, field.type());                          // byte로 패딩 제거
String value   = new String(trimmed, EUC_KR);                                // 그다음에 디코딩
```

패딩 제거를 **디코딩 전에** byte 단위로 합니다. 여기서 작지만 중요한 안전장치가 하나 있습니다. 우측 공백을 뗄 때, EUC-KR 한글의 두 바이트는 모두 `0xA1~0xFE` 범위라 **공백(0x20)이 절대 한글의 일부일 수 없습니다.** 그래서 끝에서부터 `0x20`을 떼어내도 한글이 깨질 위험이 없습니다. 이걸 String에서 `trim()`으로 했다면 이 보장을 스스로 검증할 수 없었을 겁니다.

**빌더(`DTO → byte[]`)**는 값을 EUC-KR로 인코딩하고 타입에 맞춰 정렬·패딩해 고정 길이 버퍼에 채웁니다. 인코딩 결과가 필드 byte 길이를 넘으면 **조용히 자르지 않고 예외**를 던집니다.

```java
if (encoded.length > field.length())
    throw new GwanmunBuildException("필드 '" + field.name() + "' 값이 너무 깁니다: ...");
```

잘라서 몰래 담으면 그게 곧 데이터 손상이라, 실패는 시끄럽게 냈습니다. 잘린 전문(길이 미달)도 마찬가지로 `GwanmunParseException`으로 명확히 세웁니다.

**JSON 브릿지**는 Jackson입니다. DTO의 필드가 전부 String이라, DTO ↔ JSON은 별도 매핑 없이 그대로 오갑니다.

### 5. 실측, 왕복이 눈에 보이게

말로만 "된다"고 하지 않으려고, 브라우저에서 전문 ↔ JSON 왕복이 보이는 단일 페이지 데모를 붙였습니다. 왼쪽에서 필드를 입력해 전문을 만들면 **hex + 아스키 덤프**로 보여주고, 그 hex를 오른쪽에 붙여 파싱하면 JSON으로 되돌아옵니다.

![전문과 JSON이 오가는 데모 화면](/uploads/project/gwanmun/parser-demo.png)

실제로 응답 전문을 만들어본 결과입니다. `responseMessage`에 "정상 처리되었습니다"를 넣었습니다.

```
POST /api/build → 
hex:   30323130 3132333435363738393031323334 494E3031
       303030303030303031323334353637 30303030
       C1A4BBF320C3B3B8AEB5C7BEFABDC0B4CFB4D920
length: 61
```

읽어보면:

- `30323130` = `"0210"` (전문구분)
- `30303030303030 3031323334353637` = 잔액 `1234567`이 좌측 제로패딩돼 `000000001234567`
- `C1A4 BBF3 20 C3B3 B8AE ...` = `정`(C1A4) `상`(BBF3) `공백`(20) `처`(C3B3)... 이렇게 **한글이 EUC-KR 2byte로 정확히 인코딩**됐고 20byte를 채우고 남은 오른쪽 1byte는 공백(20)으로 패딩.

이 hex를 그대로 파서에 넣으면:

```
POST /api/parse →
{"messageType":"0210","accountNo":"12345678901234","txCode":"IN01",
 "balance":"1234567","responseCode":"0000","responseMessage":"정상 처리되었습니다"}
```

**한글이 안 깨지고, 좌측 제로패딩이 벗겨진 채로** 원래 값으로 돌아왔습니다. 잔액은 `000000001234567`에서 패딩이 벗겨진 `1234567`로, 응답메시지는 뒤 공백이 제거된 `정상 처리되었습니다`로.

검증은 눈으로만 하지 않았습니다. JUnit5 + AssertJ로 **20개의 테스트**를 세웠고, 핵심은 이렇습니다.

- **왕복 무손실**: `byte[] → DTO → JSON → DTO → byte[]`가 원본 바이트와 **완전히 동일**.
- **한글 EUC-KR 왕복**: 한글 메시지가 인코딩·디코딩을 거쳐도 그대로.
- **"한글=2byte" 검증**: 한글 6자를 인코딩하면 정확히 12byte.
- **패딩**: 숫자 좌측 제로패딩(`1234567`→`000000001234567`), 문자 우측 공백패딩(filler 8칸), 전부 0인 숫자는 `0` 하나로.
- **예외**: 15자리를 14byte 필드에 넣거나, 한글 11자(22byte)를 20byte 필드에 넣으면 빌드 예외. 잘린/과다 전문은 파싱 예외.

`./gradlew build`는 그린입니다.

### 6. 잔여, 정직하게 안 한 것

- **부호(음수 금액)**: 레거시 전문은 음수를 마지막 자리 오버펀치(예: `1234A`가 특정 부호를 의미) 같은 관례로 표현하기도 합니다. 복잡하고 규격마다 달라서 이번 범위 밖으로 두고 문서에만 남겼습니다.
- **실제 은행 표준 전문**: 여기 쓴 잔액조회 요청(30byte)·응답(61byte)은 **학습용 합성 스펙**입니다. 금융결제원·은행별 실제 규격을 베끼지 않았고, 구조만 현실적으로 흉내 냈습니다. "표준 전수 구현"이 아닙니다.
- **네트워크**: 파서는 바이트를 해석할 뿐, 아직 소켓이 없습니다. TCP로 전문을 받아 이 파서에 물리고, 다시 전문으로 만들어 돌려보내는 **프로토콜 변환**이 이어지는 2부입니다. TCP는 스트림이라 "고정 61byte"라도 한 번에 다 안 오는 문제(partial read)가 기다리고 있습니다.

파싱만으로는 아직 "연계"가 아닙니다. 하지만 통역의 사전은 만들었습니다. 바이트를 문장으로, 문장을 바이트로 옮기는 규칙. 2부에서 이 사전을 들고 소켓 앞에 섭니다.

## 2부. TCP 프레이밍: 한 전문은 한 번에 오지 않는다

### 1. 상황, 이제 소켓 앞에 선다

1부에서 전문 ↔ JSON 변환 엔진을 만들었습니다. 바이트 덩어리를 오프셋대로 잘라 DTO로, 다시 바이트로. 하지만 그건 `byte[]`를 손에 쥐고 있을 때의 이야기입니다. 파서는 바이트를 해석할 뿐, 그 바이트를 **어디서 받아오는지**는 아직 모릅니다.

이번 편의 목표는 하나입니다.

> REST로 들어온 잔액조회(JSON)를 → 요청 전문으로 만들어 → **TCP 소켓**으로 계정계에 보내고 → 응답 전문을 받아 → JSON으로 돌려준다.

그러려면 상대가 필요합니다. 진짜 은행 계정계는 없으니 **목업 계정계 TCP 서버**를 만들어 잔액조회 요청 전문(30byte)을 받으면 응답 전문(61byte)을 돌려주게 했습니다. 그리고 앱과 계정계를 실제로 **소켓으로** 대화시킵니다. 여기서 1부에는 없던 함정이 하나 튀어나옵니다.

### 2. 함정, "고정 61byte"인데 한 번에 안 온다

처음엔 이렇게 생각했습니다. "응답이 딱 61byte로 고정이니, 소켓에서 61byte 읽으면 되잖아?"

```java
byte[] buf = new byte[61];
in.read(buf);   // 이게 61byte를 다 준다는 보장이 없다
```

`InputStream.read(byte[])`는 **요청한 만큼 준다고 약속하지 않습니다.** 지금 이 순간 커널 버퍼에 있는 만큼만 줍니다. TCP가 실어 나르는 건 **바이트 스트림**뿐이라, "전문"이라는 경계는 우리 머릿속에만 있지 네트워크에는 없습니다. 그래서 두 가지가 실제로 벌어집니다.

- **반쪽 도착(partial read)**: 61byte 중 30byte만 먼저 오고, 나머지 31byte는 다음 `read`에 옵니다. 위 코드는 30byte만 읽고 "다 왔다"고 착각합니다.
- **뭉침**: 요청을 연속으로 두 번 보내면, 두 전문이 붙어 122byte가 한 번의 `read`로 올 수 있습니다. 61byte만 뚝 잘라 쓰면 나머지 61byte는 다음 전문의 앞부분인데 그냥 흘려버리거나 섞입니다.

이건 로컬에서 짧은 전문을 주고받을 땐 운 좋게 안 터지다가, 전문이 길어지거나 네트워크가 끼면 재현되는 종류의 버그입니다. 운에 기대면 안 됩니다.

여기서 이번 편의 원칙이 나옵니다.

> **경계는 내가 세운다.** 필요한 바이트가 다 모일 때까지 버퍼에 쌓아두고, 프레임 길이만큼 찼을 때에만 한 전문으로 잘라 넘긴다. 이 누적·경계 관리를 **프레이밍**이라 부른다.

### 3. 판단, Netty를 쓰기 전에 왜 필요한지부터

Netty에는 `FixedLengthFrameDecoder`, `LengthFieldBasedFrameDecoder`가 있습니다. 정확히 이 문제를 풀려고 있는 물건입니다. 하지만 여기서는 **프레이밍을 순수 `java.net` 소켓으로 직접 짰습니다.** 라이브러리에 맡기기 전에 "TCP 스트림인데 왜 프레이밍이 필요한가"를 버퍼 누적·경계 관리 코드로 직접 겪어보려는 것입니다.

프레이밍 방식은 두 갈래입니다. **고정길이**면 길이를 상수로 알고 있으니 그 길이만큼 모으면 되고, **가변길이**면 전문 앞머리에 길이 헤더를 두고 그 값을 읽어 경계를 잡습니다. 우리 전문은 종류별로 길이가 고정(요청 30, 응답 61)이라 **고정길이 프레이밍**으로 충분합니다. 길이 헤더 방식은 가변 전문이 필요해질 때의 확장 지점으로 남겨뒀습니다.

### 4. 개선, 누적기와 일부러 작게 잡은 read 버퍼

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

이 누적기를 소켓에 붙인 게 `FramedConnection.readFrame()`입니다. 여기서 한 가지 의도적인 선택을 했습니다. 바로 **read 버퍼를 전문보다 작은 64byte로 잡은 것**입니다.

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

버퍼를 작게 잡은 건 **정직함** 때문입니다. 성능과는 상관없습니다. 큰 버퍼로 한 방에 읽으면 로컬에선 61byte가 우연히 한 번에 담겨 partial read 경로가 아예 안 돌 수 있습니다. 그러면 "우린 partial read를 처리한다"는 말이 코드로 증명되지 않습니다. 작게 잡으면 61byte 전문조차 반드시 여러 번의 `read`로 조립되므로, 재조립 경로가 항상 실제로 돕니다.

목업 계정계 서버는 이 위에 얹었습니다. `ServerSocket`으로 accept하고 연결마다 `FramedConnection`으로 요청 전문(30byte)을 읽어 파싱하고 계좌번호에서 **결정론적으로** 만든 가짜 잔액으로 응답 전문(61byte)을 지어 돌려줍니다. 잔액 계산은 계정계의 몫이라 서버에 뒀습니다. 관문(gwanmun)은 흐름만 통제하고 계산은 위임한다는 원칙입니다. 같은 연결로 여러 요청이 오면 순서대로 처리하고(keep-alive), 없는 계좌(0)엔 응답코드 `0001`로 정직하게 오류도 하나 냅니다.

게이트웨이 배선(`GatewayService`)은 이 조각들을 잇습니다. `accountNo` → 요청 전문 build → `CoreBankingClient`가 소켓으로 송수신 → 응답 전문 parse → JSON. 계정계 연결이 실패하면 파싱 오류와 구분해 `GatewayException`으로 감싸 502로 돌려줍니다(입력 자체가 틀리면 400). 무한 대기를 막는 연결·읽기 타임아웃도 걸었습니다.

### 5. 실측, 진짜 두 프로세스와 진짜 소켓

말로 "된다"고 하는 대신, **앱과 계정계를 별개의 프로세스로** 띄워 소켓으로 대화시켰습니다.

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

이 hex는 **실제로 소켓을 타고 오간 바이트**입니다. 응답 뒤쪽 `C1A4 BBF3 20 C3B3 B8AE ...`는 EUC-KR로 인코딩된 `정`(C1A4) `상`(BBF3) `공백`(20) `처`(C3B3)... 소켓을 건너온 한글이 파서에서 안 깨지고 `정상 처리되었습니다`로 복원됐습니다. 잔액 `6879445000`은 계좌번호에서 결정론적으로 만든 값이라, 같은 계좌면 언제 조회해도 같습니다.

화면에도 같은 걸 붙였습니다. 계좌번호를 넣고 전송하면 (a)나간 요청 전문 hex (b)돌아온 응답 전문 hex (c)최종 JSON이 한눈에 보입니다.

![REST에서 전문으로, TCP를 건너, 다시 JSON으로 돌아오는 게이트웨이 왕복](/uploads/project/gwanmun/gateway-roundtrip.png)

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

뭉침(두 전문이 한 조각에), 한 연결로 연속 3건, 동시 10건도 테스트로 덮었습니다. `./gradlew test`는 **37개 전부 그린**입니다(1부의 20개 + 이번 17개).

### 6. 잔여, 정직하게 안 한 것

- **커넥션 풀·재사용**: 클라이언트는 요청당 소켓을 하나 열고 닫습니다. 단순함을 택했고, 풀링은 부하가 실제로 필요해질 때의 확장 지점입니다.
- **길이 헤더(가변 전문)**: 이번엔 길이가 고정이라 상수 프레이밍으로 충분했습니다. 가변 전문이 생기면 앞머리 길이 헤더 방식이 필요한데, 구조는 같고 "몇 byte 모을지"를 상수 대신 헤더에서 읽는 차이입니다.
- **목업 계정계의 잔액**: 계좌번호 해시로 만든 합성값입니다. "계정계가 계산을 위임받아 응답한다"는 흐름을 재현하려는 것이지, 은행의 실제 로직을 옮기려던 건 아닙니다.
- **전문 암호화·전용선**: 실제 금융망 보안(VPN, 전문 암호화)은 인프라 영역이라 손대지 않았습니다. 여긴 평문 로컬 소켓입니다. 학습판의 경계입니다.

이제 통역기가 소켓 앞에 섰습니다. 바이트가 스트림으로 쪼개져 와도 전문으로 다시 세우고, 그 전문을 REST 세계로 넘기고, 답을 다시 전문으로 만들어 돌려보냅니다. 하지만 이 통로는 아직 **아무나 드나들 수 있습니다.** 다음 편은 이 앞에 문지기를 세웁니다. 인증과 라우팅, 유량제어를 역시 손으로 짭니다.

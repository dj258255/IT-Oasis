---
title: '바이트가 진실이다 — 고정길이 전문 파서를 손으로 만들기'
titleEn: 'Bytes Are the Truth — Building a Fixed-Length Message Parser by Hand'
description: "은행 계정계가 보내는 고정길이 전문(電文)을 모바일 앱이 알아듣는 JSON으로, 그 반대로도 바꾸는 변환 엔진을 만들었습니다. 핵심은 하나입니다 — 한글이 섞인 전문을 String.substring으로 자르면 깨진다는 것. EUC-KR에서 한글 한 글자는 2byte라, 자르기도 패딩 제거도 전부 byte[] 위에서 해야 합니다. 필드 레이아웃을 어노테이션 스펙으로 선언하고, 오프셋을 자동 계산해 byte[]↔DTO↔JSON을 양방향 변환하는 과정을, 왕복 무손실 테스트와 hex 덤프로 검증한 기록입니다."
descriptionEn: "I built an engine that converts a bank core system's fixed-length messages into JSON the mobile app understands, and back. The crux is one thing: slicing a message that contains Korean with String.substring breaks it. In EUC-KR a single Korean character is 2 bytes, so both slicing and padding removal must happen on byte[]. A record of declaring field layouts as annotation specs, auto-computing offsets, and converting byte[]↔DTO↔JSON in both directions — verified with lossless round-trip tests and hex dumps."
date: 2026-07-08
tags:
  - Java
  - Spring Boot
  - EUC-KR
  - 전문
  - 파서
  - EAI
category: personal/gwanmun
coverImage: /uploads/project/gwanmun/cover.svg
draft: true
series: "gwanmun"
seriesOrder: 1
---

## 1. 상황 — 통역이 먼저다

[0편](/blog/project/gwanmun/gwanmun-0-why)에서 그림을 그렸습니다. 계정계는 고정길이 전문(電文)과 TCP로만 말하고, 앱은 JSON과 HTTP로만 말합니다. 둘 사이에 통역기를 세우기로 했는데, 그 통역기가 제일 먼저 할 줄 알아야 하는 일이 이거예요.

> 계정계가 보낸 `"0210" + "12345678901234" + "IN01" + ...` 같은 **바이트 덩어리**를 `{"accountNo":"12345678901234", ...}` **JSON**으로 바꾸고, 반대로도 바꾼다.

네트워크(TCP 소켓)는 그다음입니다. 소켓으로 아무리 잘 받아와도, 그 바이트를 해석하지 못하면 통역은 시작조차 안 되니까요. 그래서 Phase 1은 오직 **전문 ↔ DTO ↔ JSON 변환 엔진** 하나만 만듭니다.

전문이 낯설 수 있어서 짚고 갑니다. 고정길이 전문은 이렇게 생겼습니다.

```
0210 12345678901234 IN01 000000001234567 0000 정상 처리되었습니다
└──┘ └────────────┘ └──┘ └─────────────┘ └──┘ └──────────────┘
전문   계좌번호(14)   거래  잔액(15,좌측     응답   응답메시지(20byte,
구분   숫자, 좌측       코드  제로패딩)        코드   EUC-KR)
(4)    제로패딩
```

띄어쓰기는 설명을 위해 넣은 것이고, 실제로는 **공백 없이 딱 붙은 61바이트**입니다. 어느 위치(offset)부터 몇 바이트가 어떤 필드인지를 양쪽이 미리 약속해 두고, 그 약속만으로 해석합니다. 구분자(콤마 같은 것)가 없어요. 자릿수 자체가 의미입니다.

## 2. 한계 — String으로 다루면 한글이 깨진다

처음엔 단순하게 생각했습니다. "문자열 잘라서 필드별로 나누면 되잖아?"

```java
String account = raw.substring(4, 18);   // 계좌번호
String message = raw.substring(41, 61);  // 응답메시지
```

이게 함정입니다. `substring`은 **문자(char) 인덱스**로 자릅니다. 그런데 전문의 길이는 **byte 기준**이에요. 영문·숫자만 있으면 1문자=1byte라 우연히 맞지만, **한글이 들어오는 순간 어긋납니다.**

한글은 EUC-KR 인코딩에서 **한 글자가 2byte**입니다. 실제로 확인해보면:

```
"정" → C1 A4   (2 byte)
"상" → BB F3   (2 byte)
```

응답메시지 필드는 "20byte"인데, 이걸 "20문자"로 오해하고 `substring(41, 61)`로 자르면 위치가 밀립니다. 게다가 byte 배열을 String으로 먼저 바꾼 뒤 자르면, 2byte짜리 한글이 필드 경계에서 반토막 나며 **깨진 글자(�)**가 나옵니다. 바이트의 세계와 문자의 세계를 섞은 대가입니다.

여기서 이 프로젝트의 원칙이 나옵니다.

> **바이트가 진실이다.** 자르기도, 패딩 제거도, 전부 byte[] 위에서 한다. 디코딩(byte→문자)은 **맨 마지막에 딱 한 번만** 한다.

패딩·정렬 관례도 함께 못 박아야 했습니다. 금융 전문의 오래된 관습이에요.

- **숫자**: 우측 정렬 + 좌측 제로패딩. 잔액 `1234567`은 15자리 필드에서 `000000001234567`.
- **문자**: 좌측 정렬 + 우측 공백패딩. 거래코드 `IN01`은 그대로, 짧으면 오른쪽을 공백으로 채움.

이 둘을 헷갈리면 파싱이 통째로 무너집니다.

## 3. 판단 — 레이아웃을 스펙으로 선언한다

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

`length`는 **byte 수**입니다. `responseMessage`의 20은 "문자 20자"가 아니라 "20byte"이고, 한글로는 최대 10자까지 담긴다는 뜻입니다. 타입(`NUMERIC`/`TEXT`)이 곧 패딩·정렬 관례를 결정하니, 필드마다 그걸 따로 적을 필요가 없습니다.

## 4. 개선 — 변환 엔진의 뼈대

엔진은 세 조각입니다.

**스펙 해석(`MessageSpec`)** — DTO 클래스를 리플렉션으로 훑어 `@Field`를 `order`순으로 정렬하고, 오프셋을 누적 계산해 총 길이를 확정합니다. 매번 하면 낭비라 클래스별로 캐시합니다.

**파서(`byte[] → DTO`)** — 여기가 원칙이 사는 곳입니다.

```java
byte[] slice   = Arrays.copyOfRange(raw, field.offset(), field.endOffset()); // byte로 자르고
byte[] trimmed = stripPadding(slice, field.type());                          // byte로 패딩 제거
String value   = new String(trimmed, EUC_KR);                                // 그다음에 디코딩
```

패딩 제거를 **디코딩 전에** byte 단위로 합니다. 여기서 작지만 중요한 안전장치가 하나 있습니다. 우측 공백을 뗄 때, EUC-KR 한글의 두 바이트는 모두 `0xA1~0xFE` 범위라 **공백(0x20)이 절대 한글의 일부일 수 없습니다.** 그래서 끝에서부터 `0x20`을 떼어내도 한글이 깨질 위험이 없어요. 이걸 String에서 `trim()`으로 했다면 이 보장을 스스로 검증할 수 없었을 겁니다.

**빌더(`DTO → byte[]`)** — 값을 EUC-KR로 인코딩하고, 타입에 맞춰 정렬·패딩해 고정 길이 버퍼에 채웁니다. 인코딩 결과가 필드 byte 길이를 넘으면 **조용히 자르지 않고 예외**를 던집니다.

```java
if (encoded.length > field.length())
    throw new GwanmunBuildException("필드 '" + field.name() + "' 값이 너무 깁니다: ...");
```

잘라서 몰래 담으면 그게 곧 데이터 손상이라, 실패는 시끄럽게 냈습니다. 잘린 전문(길이 미달)도 마찬가지로 `GwanmunParseException`으로 명확히 세웁니다.

**JSON 브릿지**는 Jackson입니다. DTO의 필드가 전부 String이라, DTO ↔ JSON은 별도 매핑 없이 그대로 오갑니다.

## 5. 실측 — 왕복이 눈에 보이게

말로만 "된다"고 하지 않으려고, 브라우저에서 전문 ↔ JSON 왕복이 보이는 단일 페이지 데모를 붙였습니다. 왼쪽에서 필드를 입력해 전문을 만들면 **hex + 아스키 덤프**로 보여주고, 그 hex를 오른쪽에 붙여 파싱하면 JSON으로 되돌아옵니다.

![데모 화면 — 전문↔JSON 왕복](/uploads/project/gwanmun/parser-demo.png)

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
- `C1A4 BBF3 20 C3B3 B8AE ...` = `정`(C1A4) `상`(BBF3) `공백`(20) `처`(C3B3)... — **한글이 EUC-KR 2byte로 정확히 인코딩**됐고, 20byte를 채우고 남은 오른쪽 1byte는 공백(20)으로 패딩.

이 hex를 그대로 파서에 넣으면:

```
POST /api/parse →
{"messageType":"0210","accountNo":"12345678901234","txCode":"IN01",
 "balance":"1234567","responseCode":"0000","responseMessage":"정상 처리되었습니다"}
```

**한글이 안 깨지고, 좌측 제로패딩이 벗겨진 채로** 원래 값으로 돌아왔습니다. 잔액은 `000000001234567`이 아니라 `1234567`로, 응답메시지는 뒤 공백이 제거된 `정상 처리되었습니다`로.

검증은 눈으로만 하지 않았습니다. JUnit5 + AssertJ로 **20개의 테스트**를 세웠고, 핵심은 이렇습니다.

- **왕복 무손실**: `byte[] → DTO → JSON → DTO → byte[]`가 원본 바이트와 **완전히 동일**.
- **한글 EUC-KR 왕복**: 한글 메시지가 인코딩·디코딩을 거쳐도 그대로.
- **"한글=2byte" 검증**: 한글 6자를 인코딩하면 정확히 12byte.
- **패딩**: 숫자 좌측 제로패딩(`1234567`→`000000001234567`), 문자 우측 공백패딩(filler 8칸), 전부 0인 숫자는 `0` 하나로.
- **예외**: 15자리를 14byte 필드에 넣거나, 한글 11자(22byte)를 20byte 필드에 넣으면 빌드 예외. 잘린/과다 전문은 파싱 예외.

`./gradlew build`는 그린입니다.

## 6. 잔여 — 정직하게 안 한 것

- **부호(음수 금액)**: 레거시 전문은 음수를 마지막 자리 오버펀치(예: `1234A`가 특정 부호를 의미) 같은 관례로 표현하기도 합니다. 복잡하고 규격마다 달라서 이번 범위 밖으로 두고 문서에만 남겼습니다.
- **실제 은행 표준 전문**: 여기 쓴 잔액조회 요청(30byte)·응답(61byte)은 **학습용 합성 스펙**입니다. 금융결제원·은행별 실제 규격을 베끼지 않았고, 구조만 현실적으로 흉내 냈습니다. "표준 전수 구현"이 아닙니다.
- **네트워크**: 파서는 바이트를 해석할 뿐, 아직 소켓이 없습니다. TCP로 전문을 받아 이 파서에 물리고, 다시 전문으로 만들어 돌려보내는 **프로토콜 변환**이 다음 편(Phase 2)입니다. TCP는 스트림이라 "고정 61byte"라도 한 번에 다 안 오는 문제(partial read)가 기다리고 있고요.

파싱만으로는 아직 "연계"가 아닙니다. 하지만 통역의 사전은 만들었습니다. 바이트를 문장으로, 문장을 바이트로 옮기는 규칙. 다음 편에서 이 사전을 들고 소켓 앞에 섭니다.

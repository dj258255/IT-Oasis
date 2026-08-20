---
title: '관문(gwanmun) 개발기: 전문·TCP와 JSON·REST 사이에 통역기를 세운 아홉 단계'
description: >-
  은행 계정계는 고정길이 전문과 TCP로만, 모바일 앱은 JSON과 HTTP REST로만 말합니다.
  둘 다 못 고치니 가운데에 통역기를 세웠습니다. 목업 계정계까지 직접 띄워 만든 아홉 단계를
  한 글에 모았습니다. 계정계를 실제로 죽여 서킷이 열리는 과정, 풀 고갈이 원장 4건을
  증발시킨 감사 결함과 수정, 부하가 서킷 stale 레이스를 197회로 실증한 기록, 같은 멱등키를
  두 번 보내도 이중거래가 0이었던 것까지 전부 실측입니다.
date: 2025-11-15
tags:
  - gwanmun
  - Java
  - Spring Boot
  - TCP
  - API Gateway
  - EAI
  - Circuit Breaker
  - Idempotency
  - Load Testing
  - Modulith
category: personal/gwanmun
coverImage: /uploads/project/gwanmun/cover.svg
draft: false
series: "gwanmun"
seriesOrder: 1
---

한 줄로 요약하면 고정길이 전문과 TCP로만 말하는 은행 계정계와, JSON과 HTTP REST로만 말하는 앱 사이에 세운 연계 게이트웨이입니다. 둘 다 못 고치니 가운데에 통역기를 두는데, 그 통역기는 두 층입니다. 전문과 JSON을 변환하는 연계층, 그리고 통로를 인증과 라우팅, 유량제어로 지키는 API 게이트웨이층입니다.

진짜 은행 없이 로컬에서 전 과정을 재현했고 전문을 주고받는 목업 계정계까지 직접 세웠습니다. Java 21과 Spring Boot 3.5를 썼고 코드는 [GitHub](https://github.com/dj258255/gwanmun)에 공개되어 있습니다.

숫자부터 놓고 시작하겠습니다. 전부 직접 측정했고 명령과 출력, 환경이 담긴 재현 기록([VERIFICATION.md](https://github.com/dj258255/gwanmun/blob/main/docs/VERIFICATION.md) 1~9단계)이 저장소에 있습니다.

| 항목 | 수치 |
|---|---|
| 두 프로토콜 통역 | 고정길이 전문+TCP ↔ JSON+REST, 대표 거래 4종(잔액·거래내역·상태조회·망취소) |
| 장애 격리 | 계정계를 실제로 kill → 서킷 OPEN → 이후 503 즉시 거절(계정계 호출 0) |
| 감사 결함 수정 | 풀 고갈이 서킷을 열고 원장 4건 증발 → 수정 후 503 + 원장 9행 완결·서킷 CLOSED |
| 부하 상한 | k6 무릎 ~10–12k req/s, ~6k까지 p95<1ms, 실패율 전 구간 0% |
| 게이트웨이 오버헤드 | 경유 시 ≈ 0.21ms/req (직접 왕복 대비) |
| 빠른 실패의 값 | 죽은 백엔드에서 서킷 off 351 req/s(p50 8.11s) vs on 9,425 req/s(p50 0.68ms) |
| 멱등 이중거래 | 같은 키 2회 → 계정계 1회·원장 1행(이중거래 0), 처리 중 재요청 409 |
| 테스트 / 기록 | 168건 (CI 게이트) / VERIFICATION 1~9단계 |

측정 환경은 공통적으로 로컬에서 두 프로세스(게이트웨이 앱과 목업 계정계)를 실제 TCP 소켓으로 잇고 원장은 PostgreSQL 컨테이너에 적재하는 구성입니다. 각 수치의 상세 조건은 해당 장에 명시했습니다.

## 말이 안 통하는 두 시스템

은행에 모바일 잔액조회를 붙여야 한다고 해봅시다. 문제는 양쪽이 쓰는 언어가 완전히 다릅니다.

계정계는 오래된 시스템이라 이렇게 말합니다. `"0200" + 계좌번호[14] + 거래코드[4] + 공백패딩...`. 띄어쓰기와 자릿수가 곧 의미인 고정길이 전문이고, 그것도 TCP 소켓으로 오갑니다. 반면 모바일 앱은 `{"account":"12345678901234"}` 처럼 JSON을 HTTP REST로 실어 보냅니다.

이 둘은 직접 대화가 안 됩니다. 그런데 계정계를 JSON과 REST로 통째로 뜯어고치는 건 현실적으로 감당하기 어려운 규모라 못 고칩니다. 답은 하나입니다. 가운데에 통역기를 세우는 것입니다.

지어낸 상황처럼 보여도 지금 실무에서 벌어지는 문제 공간입니다. ISO 20022 전환기에도 다수 은행이 코어를 못 고쳐 미들웨어로 신규 포맷과 레거시 고정길이를 변환하는 전략을 택했고, 국내 대외계와 코어뱅킹은 여전히 고정길이 전문에 TCP 연계가 흔합니다.

## 두 층을 나누고 정체성은 섞지 않는다

연계층은 JSON을 계정계가 알아듣는 전문으로 바꾸고, TCP로 보내고, 돌아온 전문을 다시 JSON으로 되돌립니다. 프로토콜과 포맷을 동시에 변환합니다.

API 게이트웨이층은 이 통로가 외부에 열리면 아무나 들어오면 안 되니 앞단에서 인증과 라우팅, 유량제어로 지킵니다. 신분을 확인하고 어디로 갈지 안내하고 방문 횟수를 제한하되, 집 안 살림인 잔액 계산에는 관여하지 않습니다. 흐름은 통제하되 비즈니스 로직은 계정계에 위임한다는 원칙입니다.

![API 게이트웨이 층과 연계(통역) 층이 모바일 REST와 레거시 전문 사이를 잇는 gwanmun 아키텍처](/uploads/project/gwanmun/architecture.svg)

경계 하나를 더 그었습니다. 이 프로젝트는 [DBTower](/blog/project/dbtower/dbtower-0-overview)와 성격이 정반대라 별도 저장소로 둡니다. gwanmun은 데이터 경로 위에서 메시지를 중계하는 미들웨어이고 DBTower는 데이터 경로 밖에서 관찰하는 관제입니다. 둘을 한 코드베이스에 섞으면 두 정체성이 흐려집니다. 원장 DB를 DBTower가 관측하는 느슨한 연결만 남겼습니다.

코드베이스 자체도 Spring Modulith 모듈로 경계를 지어 모듈 간 순환 의존을 빌드에서 실패시킵니다. message와 core, gateway, ledger, web이 단방향 DAG로 물려 있습니다.

![5모듈 경계와 필터 체인, 장애 내성, 비동기 원장 적재, 목업 계정계 3서버를 담은 gwanmun 상세 서버 아키텍처](/uploads/project/gwanmun/architecture-detail.svg)

원장 DB 경계도 미리 그려두면 뒤가 읽기 쉽습니다. 테이블은 셋입니다. 거래 원장과 멱등키, EOD 대사 이력이고 테이블 사이는 물리 FK 없이 값으로 잇는 논리 관계입니다. 원장 적재가 비동기라 멱등키를 적는 시점에 원장 행이 아직 없을 수 있어서 FK를 두지 않는 게 설계상 맞았습니다.

![transaction_ledger · idempotency_key · reconciliation_run 세 테이블로 이뤄진 gwanmun 원장 DB ERD](/uploads/project/gwanmun/erd.svg)

## 상황이 이끈 아홉 단계

각 단계가 어떤 상황에서 밀려 나왔고 무엇으로 증명됐는지를 먼저 놓습니다. 상세는 해당 장에 있습니다.

| 단계 | 상황 | 한 것 | 증명 |
|---|---|---|---|
| [1~2](#1-전문-파서와-tcp-프레이밍) | 전문과 JSON 변환, TCP는 스트림이라 한 전문이 한 번에 안 옴 | 스펙 선언 파서와 빌더, 프레이밍, 목업 계정계 TCP 서버 | 요청 30B와 응답 61B가 실소켓 왕복(elapsedMs 12), EUC-KR 한글 무손실, partial read 재조립과 뭉침 분리 |
| [3](#2-필터-체인과-가변-프레이밍-커넥션-풀) | 통로가 외부에 열림 | 손으로 짠 필터 체인(인증→라우팅→유량제어)과 모듈러 모놀리스 | 무키 401, 잘못된 키 403, 모르는 경로 404, 용량 5 초과 시 6번째 429 |
| [4](#2-필터-체인과-가변-프레이밍-커넥션-풀) | 거래내역은 건수만큼 길이가 매번 다르고 요청당 소켓이 낭비됨 | 길이 프리픽스 2단계 프레이밍, 스레드 안전 커넥션 풀 | 가변 309B 왕복, 동시 폭주 시 created=4(==max), reused=12 |
| [5](#3-3값-원장과-손으로-짠-서킷브레이커) | 게이트웨이가 거래를 아무것도 기억 못 함 | 거래ID 채번, 3값 원장, 마스킹, 메트릭 | 타임아웃 3.06초에 504와 UNKNOWN 기록, 계좌는 마스킹 형태만 저장 |
| [6](#3-3값-원장과-손으로-짠-서킷브레이커) | 계정계 장애가 게이트웨이로 전파되고 UNKNOWN이 방치됨 | 자체 서킷브레이커, 성격별 재시도, UNKNOWN 해소 | 계정계 kill로 502, 이후 503×4 즉시 거절, 재기동 후 HALF_OPEN 탐침에서 CLOSED 복귀 |
| [7](#4-감사가-찾은-결함과-부하가-드러낸-레이스) | 궂은 날엔 오작동, 감사가 확정 결함 6건과 보안 3건 | 풀 고갈 3중 오작동 소탕, 원장 공백 금지, 보안 경화 | 전에는 고갈 4건이 HTTP 500에 원장 4건 증발, 후에는 503에 원장 9행 완결 |
| [8](#4-감사가-찾은-결함과-부하가-드러낸-레이스) | 테스트가 로컬에서만 돌고 서킷은 부하 앞에서 미검증 | 세대 permit 서킷, k6 하네스, CI | 부하가 A3 stale 레이스를 staleResultsTotal=197로 실증, 무릎 약 10~12k req/s |
| [9](#5-멱등키와-eod-대사) | 호출자 재전송을 구분 못 하고 원장이 한 번도 대조되지 않음 | 멱등키 DB 유니크 선점, EOD 대사 배치 | 같은 키 2회에 계정계 1회와 원장 1행, 대사 4유형 분류와 UNKNOWN 자동해소 |

---

## 1. 전문 파서와 TCP 프레이밍

*원문 발행일 2025-07-20*

### 1부. 고정길이 전문 파서를 손으로 짜기

#### 1. 상황, 통역이 먼저다

[0편](#상황이-이끈-아홉-단계)에서 그림을 그렸습니다. 계정계는 고정길이 전문(電文)과 TCP로만 말하고, 앱은 JSON과 HTTP로만 말합니다. 둘 사이에 통역기를 세우기로 했는데, 그 통역기가 제일 먼저 할 줄 알아야 하는 일이 이것입니다.

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

#### 2. 한계, String으로 다루면 한글이 깨진다

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

#### 3. 레이아웃을 스펙으로 선언한다는 판단

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

#### 4. 개선, 변환 엔진의 뼈대

엔진은 세 조각입니다.

**스펙 해석(`MessageSpec`)은** DTO 클래스를 리플렉션으로 훑어 `@Field`를 `order`순으로 정렬하고 오프셋을 누적 계산해 총 길이를 확정합니다. 매번 하면 낭비라 클래스별로 캐시합니다.

**파서(`byte[] → DTO`)**, 여기가 원칙이 사는 곳입니다.

```java
byte[] slice   = Arrays.copyOfRange(raw, field.offset(), field.endOffset()); // byte로 자르고
byte[] trimmed = stripPadding(slice, field.type());                          // byte로 패딩 제거
String value   = new String(trimmed, EUC_KR);                                // 그다음에 디코딩
```

패딩 제거를 **디코딩 전에** byte 단위로 합니다. 여기서 작지만 중요한 안전장치가 하나 있습니다. 우측 공백을 뗄 때, EUC-KR 한글의 두 바이트는 모두 `0xA1~0xFE` 범위라 **공백(0x20)이 절대 한글의 일부일 수 없습니다.** 그래서 끝에서부터 `0x20`을 떼어내도 한글이 깨질 위험이 없습니다. 이걸 String에서 `trim()`으로 했다면 이 보장을 스스로 검증할 수 없었을 겁니다.

**빌더(`DTO → byte[]`)는** 값을 EUC-KR로 인코딩하고 타입에 맞춰 정렬·패딩해 고정 길이 버퍼에 채웁니다. 인코딩 결과가 필드 byte 길이를 넘으면 **조용히 자르지 않고 예외**를 던집니다.

```java
if (encoded.length > field.length())
    throw new GwanmunBuildException("필드 '" + field.name() + "' 값이 너무 깁니다: ...");
```

잘라서 몰래 담으면 그게 곧 데이터 손상이라, 실패는 시끄럽게 냈습니다. 잘린 전문(길이 미달)도 마찬가지로 `GwanmunParseException`으로 명확히 세웁니다.

**JSON 브릿지**는 Jackson입니다. DTO의 필드가 전부 String이라, DTO ↔ JSON은 별도 매핑 없이 그대로 오갑니다.

#### 5. 실측, 왕복이 눈에 보이게

정말 되는지 눈으로 확인하려고, 브라우저에서 전문 ↔ JSON 왕복이 보이는 단일 페이지 데모를 붙였습니다. 왼쪽에서 필드를 입력해 전문을 만들면 **hex + 아스키 덤프**로 보여주고, 그 hex를 오른쪽에 붙여 파싱하면 JSON으로 되돌아옵니다.

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

#### 6. 잔여, 정직하게 안 한 것

- **부호(음수 금액)**: 레거시 전문은 음수를 마지막 자리 오버펀치(예: `1234A`가 특정 부호를 의미) 같은 관례로 표현하기도 합니다. 복잡하고 규격마다 달라서 이번 범위 밖으로 두고 문서에만 남겼습니다.
- **실제 은행 표준 전문**: 여기 쓴 잔액조회 요청(30byte)·응답(61byte)은 **학습용 합성 스펙**입니다. 금융결제원·은행별 실제 규격을 베끼지 않았고, 구조만 현실적으로 흉내 냈습니다. "표준 전수 구현"이 아닙니다.
- **네트워크**: 파서는 바이트를 해석할 뿐, 아직 소켓이 없습니다. TCP로 전문을 받아 이 파서에 물리고, 다시 전문으로 만들어 돌려보내는 **프로토콜 변환**이 이어지는 2부입니다. TCP는 스트림이라 "고정 61byte"라도 한 번에 다 안 오는 문제(partial read)가 기다리고 있습니다.

파싱만으로는 아직 "연계"가 아닙니다. 하지만 통역의 사전은 만들었습니다. 바이트를 문장으로, 문장을 바이트로 옮기는 규칙. 2부에서 이 사전을 들고 소켓 앞에 섭니다.

### 2부. TCP 프레이밍: 한 전문은 한 번에 오지 않는다

#### 1. 상황, 이제 소켓 앞에 선다

1부에서 전문 ↔ JSON 변환 엔진을 만들었습니다. 바이트 덩어리를 오프셋대로 잘라 DTO로, 다시 바이트로. 하지만 그건 `byte[]`를 손에 쥐고 있을 때의 이야기입니다. 파서는 바이트를 해석할 뿐, 그 바이트를 **어디서 받아오는지**는 아직 모릅니다.

이번 편의 목표는 하나입니다.

> REST로 들어온 잔액조회(JSON)를 → 요청 전문으로 만들어 → **TCP 소켓**으로 계정계에 보내고 → 응답 전문을 받아 → JSON으로 돌려준다.

그러려면 상대가 필요합니다. 진짜 은행 계정계는 없으니 **목업 계정계 TCP 서버**를 만들어 잔액조회 요청 전문(30byte)을 받으면 응답 전문(61byte)을 돌려주게 했습니다. 그리고 앱과 계정계를 실제로 **소켓으로** 대화시킵니다. 여기서 1부에는 없던 함정이 하나 튀어나옵니다.

#### 2. 함정, "고정 61byte"인데 한 번에 안 온다

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

#### 3. 판단, Netty를 쓰기 전에 왜 필요한지부터

Netty에는 `FixedLengthFrameDecoder`, `LengthFieldBasedFrameDecoder`가 있습니다. 정확히 이 문제를 풀려고 있는 물건입니다. 하지만 여기서는 **프레이밍을 순수 `java.net` 소켓으로 직접 짰습니다.** 라이브러리에 맡기기 전에 "TCP 스트림인데 왜 프레이밍이 필요한가"를 버퍼 누적·경계 관리 코드로 직접 겪어보려는 것입니다.

프레이밍 방식은 두 갈래입니다. **고정길이**면 길이를 상수로 알고 있으니 그 길이만큼 모으면 되고, **가변길이**면 전문 앞머리에 길이 헤더를 두고 그 값을 읽어 경계를 잡습니다. 우리 전문은 종류별로 길이가 고정(요청 30, 응답 61)이라 **고정길이 프레이밍**으로 충분합니다. 길이 헤더 방식은 가변 전문이 필요해질 때의 확장 지점으로 남겨뒀습니다.

#### 4. 개선, 누적기와 일부러 작게 잡은 read 버퍼

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

#### 5. 실측, 진짜 두 프로세스와 진짜 소켓

이번엔 **앱과 계정계를 별개의 프로세스로** 실제로 띄워 소켓으로 대화시켰습니다.

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

#### 6. 잔여, 정직하게 안 한 것

- **커넥션 풀·재사용**: 클라이언트는 요청당 소켓을 하나 열고 닫습니다. 단순함을 택했고, 풀링은 부하가 실제로 필요해질 때의 확장 지점입니다.
- **길이 헤더(가변 전문)**: 이번엔 길이가 고정이라 상수 프레이밍으로 충분했습니다. 가변 전문이 생기면 앞머리 길이 헤더 방식이 필요한데, 구조는 같고 "몇 byte 모을지"를 상수 대신 헤더에서 읽는 차이입니다.
- **목업 계정계의 잔액**: 계좌번호 해시로 만든 합성값입니다. "계정계가 계산을 위임받아 응답한다"는 흐름을 재현하려는 것이지, 은행의 실제 로직을 옮기려던 건 아닙니다.
- **전문 암호화·전용선**: 실제 금융망 보안(VPN, 전문 암호화)은 인프라 영역이라 손대지 않았습니다. 여긴 평문 로컬 소켓입니다. 학습판의 경계입니다.

이제 통역기가 소켓 앞에 섰습니다. 바이트가 스트림으로 쪼개져 와도 전문으로 다시 세우고, 그 전문을 REST 세계로 넘기고, 답을 다시 전문으로 만들어 돌려보냅니다. 하지만 이 통로는 아직 **아무나 드나들 수 있습니다.** 다음 편은 이 앞에 문지기를 세웁니다. 인증과 라우팅, 유량제어를 역시 손으로 짭니다.

---

## 2. 필터 체인과 가변 프레이밍, 커넥션 풀

*원문 발행일 2025-08-16*

### 1부. 문지기를 손으로 짜는 인증·라우팅·유량제어 필터 체인

#### 1. 상황, 통로를 외부에 열면 아무나 들어온다

[1편](#1-전문-파서와-tcp-프레이밍) 2부에서 통로를 열었습니다. REST로 들어온 잔액조회를 요청 전문으로 만들어 TCP로 계정계에 보내고 응답 전문을 받아 JSON으로 돌려주는 왕복. 통역기가 소켓 앞에 선 셈입니다.

문제는, 이 통로가 **무방비**라는 것입니다. `POST /api/gateway/balance`에 계좌번호만 넣으면 누구나 계정계에 질의를 밀어넣을 수 있습니다. 이 통로가 외부(다른 팀, 외부 클라이언트)에 열리는 순간 세 가지가 필요해집니다.

- 이 요청은 **누가** 보낸 것인가 (인증)
- 이 요청은 **어디로** 가야 하는가 (라우팅)
- 한 클라이언트가 **얼마나** 자주 쳐도 되는가 (유량제어)

각 백엔드가 따로 이걸 처리하면 중복이고 관리가 안 됩니다. 통로 앞단에서 한 번에 걸러야 합니다.

![gwanmun의 두 층 구조. 위쪽은 API 게이트웨이(인증·라우팅·유량제어), 아래쪽은 연계 통역(전문↔JSON)](/uploads/project/gwanmun/architecture.svg)

이번 편의 목표는 하나입니다.

> `/api/gateway/**` 앞에 문지기를 세운다. 요청이 인증 → 라우팅 → 유량제어를 순서대로 통과해야만 뒤쪽 전문 왕복에 닿는다. 그리고 그 문지기를 **완제품 없이 손으로 짠다.**

#### 2. 함정, 직접 짜는 유량제어는 두 곳에서 샌다

인증과 라우팅은 비교적 정직합니다. 헤더를 보고 맞으면 통과, 아니면 상태코드. 진짜 함정은 **유량제어**에 있습니다. "클라이언트별 분당 N건"을 직접 구현하려고 토큰버킷을 짜면, 두 곳에서 조용히 샙니다.

**함정 하나, 시계가 거꾸로 간다.** 토큰버킷의 핵심은 "지난번 이후 흐른 시간만큼 토큰을 채운다"입니다. 이때 무심코 벽시계(`System.currentTimeMillis()`)를 쓰면, NTP 시간 보정이나 서머타임 전환으로 시계가 **뒤로** 점프할 수 있습니다. 그러면 "흐른 시간"이 음수가 되고 계산에 따라 토큰이 폭증하거나 음수로 꺼집니다. 로컬에선 안 보이다가 운영 서버의 시간 동기화 한 번에 터지는 종류입니다.

**함정 둘, 같은 버킷을 여러 스레드가 동시에 친다.** 웹 요청은 스레드 풀에서 병렬로 처리됩니다. 한 클라이언트가 동시에 여러 요청을 보내면, 여러 스레드가 **같은 버킷**의 토큰을 동시에 소비하려 듭니다. `if (남은 토큰 > 0) 토큰--` 같은 검사-후-실행(check-then-act)은 원자적이지 않아서 두 스레드가 동시에 "토큰 있음"을 보고 둘 다 통과해 버립니다. 용량 5인데 6건이 통과하는 초과 소비가 생깁니다.

이 둘을 막지 못하면 "유량제어를 한다"는 말이 코드로 증명되지 않습니다.

#### 3. 판단, 필터 체인은 인터페이스로 짜고 시계는 단조로, 버킷은 잠근다

세 가지를 정했습니다.

**하나, 필터 체인은 직접 추상화한다.** 요청이 순서대로 통과하는 체인을 `GatewayFilter` 인터페이스 + 체인 실행기로 짭니다. 각 필터는 통과(다음으로 넘김) 아니면 차단(상태코드·사유 남기고 멈춤)을 결정합니다. 서블릿 API에 묶이지 않는 순수 자바로 두어 필터 로직만 단독 테스트할 수 있게 하고 서블릿과의 연결은 얇은 브릿지 하나로 격리합니다.

**둘, 시계는 단조(monotonic) 시계를 쓴다.** `System.nanoTime()`은 뒤로 가지 않음이 보장됩니다. 게다가 테스트에서 시간을 마음대로 흘릴 수 있게 시계를 주입 가능한 `LongSupplier`로 둡니다(가짜 시계로 보충 로직을 결정론적으로 검증).

**셋, 버킷은 버킷 단위로 잠근다.** 클라이언트마다 버킷 하나를 `ConcurrentHashMap`에 두되, 버킷의 소비 연산은 `synchronized`로 묶습니다. 락 범위가 그 클라이언트 버킷 하나라, 다른 클라이언트끼리는 서로 안 막습니다.

#### 4. 개선, 체인을 짜고 단조 시계로 채우고 버킷을 잠근다

##### 4-1. 필터 인터페이스와 체인 실행기

필터는 통과면 `chain.next(...)`를 부르고 차단이면 `response.block(...)`을 부른 뒤 next를 **안** 부릅니다. 그 순간 체인이 멈춥니다.

```java
public interface GatewayFilter {
    void filter(GatewayRequest request, GatewayResponse response, GatewayFilterChain chain);
    int order();  // 인증 10 → 라우팅 20 → 유량제어 30. 순서를 코드로 드러낸다.
}

public final class GatewayFilterChain {
    private final List<GatewayFilter> filters;
    private int index;
    public void next(GatewayRequest request, GatewayResponse response) {
        if (response.blocked()) return;          // 이미 막혔으면 멈춤
        if (index < filters.size()) {
            filters.get(index++).filter(request, response, this);
        }
    }
}
```

인증 필터는 이렇게 통과/차단을 가릅니다.

```java
String apiKey = request.header("X-API-Key");
if (apiKey == null || apiKey.isBlank()) {
    response.block(401, "인증 실패: X-API-Key 헤더가 없습니다.");
    return;                                       // next를 안 부른다 = 체인 종료
}
String clientId = registry.clientFor(apiKey);
if (clientId == null) {
    response.block(403, "인증 실패: 등록되지 않은 API 키입니다.");
    return;
}
request.clientId(clientId);                        // 뒤 필터가 쓸 클라이언트 id를 실어 준다
response.header("X-Gateway-Client", clientId);     // 통과 흔적을 응답에 남긴다
chain.next(request, response);
```

라우팅 필터는 "메서드 + 경로"를 라우팅 테이블에서 찾고 없으면 404로 끊습니다. 테이블 구조라 거래가 늘면 줄만 추가하면 됩니다(지금은 목업 계정계로 가는 잔액조회 한 줄).

##### 4-2. 토큰버킷, 단조 시계로 채운다

```java
private void refill() {
    long now = clock.getAsLong();                 // System::nanoTime (주입)
    long elapsed = now - lastRefillNanos;
    if (elapsed > 0) {                            // 단조 시계라 음수일 리 없지만, 0으로 방어
        tokens = Math.min(capacity, tokens + elapsed * refillPerNano);
        lastRefillNanos = now;
    }
}

public synchronized boolean tryConsume() {
    refill();
    if (tokens >= 1.0) { tokens -= 1.0; return true; }
    return false;
}
```

`elapsed > 0` 가드가 함정 하나(시간 역행)를 막습니다. 벽시계였다면 여기서 `elapsed`가 음수가 돼 `tokens`가 요동쳤을 겁니다. 단조 시계라 그럴 일이 없고 혹시 몰라 가드까지 둡니다.

##### 4-3. 유량제어 필터, 버킷을 원자적으로 만들고 버킷 단위로 잠근다

```java
TokenBucket bucket = buckets.computeIfAbsent(clientId,
        k -> new TokenBucket(capacity, refillPerSecond, clock));
if (bucket.tryConsume()) {                         // tryConsume은 synchronized
    response.header("X-RateLimit-Remaining", Long.toString(bucket.remaining()));
    chain.next(request, response);
    return;
}
long retrySec = Math.max(1, (long) Math.ceil(bucket.millisUntilRefill() / 1000.0));
response.header("Retry-After", Long.toString(retrySec));
response.block(429, "요청이 너무 잦습니다(클라이언트 '" + clientId + "' 분당 한도 초과). "
        + retrySec + "초 후 재시도하세요.");
```

`computeIfAbsent`는 키별로 원자적이라, 첫 요청이 동시에 여럿 와도 버킷은 하나만 생깁니다. 소비는 `tryConsume()`이 버킷 단위로 동기화하므로, 여러 스레드가 같은 버킷을 쳐도 토큰이 정확히 하나씩만 빠집니다. 이게 함정 둘(초과 소비)을 막는 부분입니다.

##### 4-4. 서블릿에 잇는 브릿지

손으로 짠 체인을 서블릿 파이프라인에 연결하는 건 얇은 브릿지 하나입니다. `HttpServletRequest`에서 필요한 것만 뽑아 체인을 태우고 **막히면** 그 상태코드·사유로 응답하고 백엔드로 안 넘깁니다. **통과하면** 체인이 남긴 헤더를 응답에 실어 준 뒤 컨트롤러로 넘깁니다. `/api/gateway/*`에만 걸어, 통역만 하던 나머지 API(`/api/build` 등)는 문지기 밖입니다.

#### 5. 왜 모듈러 모놀리스인가, 경계를 코드가 강제하니까

이번에 필터 층이 들어오며 클래스가 늘었습니다. 통역 코덱, 계정계 연동, 관문 필터, REST 컨트롤러가 한 프로젝트에 섞이기 시작하는 지점입니다. 여기서 코드베이스를 [Spring Modulith](https://spring.io/projects/spring-modulith) 기반 **모듈러 모놀리스**로 재정렬했습니다. 기술적 근거는 셋입니다.

**하나, 모듈 경계를 코드가 강제한다.** `io.gwanmun` 바로 아래 각 패키지를 하나의 애플리케이션 모듈로 둡니다. `message`는 전문 코덱(순수), `core`는 계정계 연동, `gateway`는 관문 필터 체인, `web`은 REST 조립을 맡습니다. 각 모듈은 자기 기반 패키지의 타입만 API로 내놓고 하위 패키지(예: 필터 구현 세부)는 내부에 감춥니다. 이 경계는 문서에 적어 둔 약속에 머물지 않고 **테스트로 검증**됩니다.

```java
ApplicationModules.of(GwanmunApplication.class).verify();  // 그린 = 경계 지켜짐
```

**둘, 순환참조를 차단한다.** `verify()`는 모듈 간 순환 의존이나 다른 모듈 내부 패키지 직접 참조를 빨갛게 막습니다. 실제 의존은 단방향 DAG입니다.

```
web      → gateway, message
gateway  → message, core
core     → message
message  → (없음 — 순수 모듈)
```

누가 실수로 `message`가 `web`을 참조하게 만들면(순환) 테스트가 즉시 깨집니다. 경계를 사람 눈 대신 빌드가 지킵니다.

**셋, 단일 배포 단위를 유지한다.** 이건 마이크로서비스가 아닙니다. 프로세스도, 배포도 하나입니다. 다만 모듈 경계가 코드로 강제되니, 나중에 필요하면 쪼갤 수 있는 선택지를 남겨둘 뿐입니다. 지금 필요하지도 않은 분산을 미리 지불하지 않으면서, 경계의 이점만 취하는 선택입니다.

`message` 모듈은 다른 모듈이 전문 필드를 다뤄야 하므로 `dto`·`spec` 하위 패키지만 `@NamedInterface`로 열고 나머지는 감췄습니다. 모듈 다이어그램은 Documenter로 생성해 `docs/modules/`에 남겼습니다(components.puml, 모듈별 puml·adoc).

#### 6. 실측, 401 / 403 / 404 / 429의 진짜 응답

앱을 8090에 띄우고(내장 목업 계정계 9099 포함) curl로 다섯 경로를 실제로 쳤습니다. 기동 로그에 체인 순서가 찍힙니다.

```
ApiKeyRegistry   : API 키 2개 로드: [demo-key-fintech-a, demo-key-fintech-b]
GatewayFilterConfig : 관문 필터 체인 등록(순서): [AuthenticationFilter#10, RoutingFilter#20, RateLimitFilter#30]
```

**키 없음 → 401, 잘못된 키 → 403** (값은 손대지 않은 실제 출력):

```
$ curl -i -X POST /api/gateway/balance -d '{"accountNo":"12345678901234"}'
HTTP/1.1 401
{"blocked":true,"status":401,"reason":"인증 실패: X-API-Key 헤더가 없습니다."}

$ curl -i ... -H "X-API-Key: wrong-key" ...
HTTP/1.1 403
{"blocked":true,"status":403,"reason":"인증 실패: 등록되지 않은 API 키입니다."}
```

**정상 키 → 통과, 계정계 왕복 성공.** 판정 헤더가 응답에 드러납니다.

```
$ curl -i ... -H "X-API-Key: demo-key-fintech-a" ...
HTTP/1.1 200
X-Gateway-Client: fintech-a
X-Gateway-Route: core-banking-balance
X-RateLimit-Remaining: 4
X-Gateway-Decision: pass
...
"json":{"balance":"6879445000","responseCode":"0000","responseMessage":"정상 처리되었습니다"}
```

문지기(인증→라우팅→유량제어)를 다 통과한 뒤에야 1편의 전문 왕복이 실행됩니다. 문 통과 후 통역입니다.

**유량제어 → N+1번째에서 429.** 용량 5로 두고 한 클라이언트로 8회 연속 전송했습니다.

```
요청 1 → 200  (remaining: 4)  통과
요청 2 → 200  (remaining: 3)  통과
요청 3 → 200  (remaining: 2)  통과
요청 4 → 200  (remaining: 1)  통과
요청 5 → 200  (remaining: 0)  통과
요청 6 → 429  (Retry-After: 2s)  차단
요청 7 → 429  (Retry-After: 2s)  차단
요청 8 → 429  (Retry-After: 2s)  차단
```

정확히 5건이 통과하고 6번째부터 429 + Retry-After가 붙습니다. 화면에도 같은 걸 붙였습니다. 키와 횟수를 정해 연속 전송하면 통과(초록)와 차단(빨강)이 줄줄이 찍히고 합계가 뜹니다.

![게이트웨이 방어 장면. 5건 통과 후 429로 3건 차단, 클라이언트별 토큰버킷](/uploads/project/gwanmun/gateway-guard.png)

**알 수 없는 경로 → 404.** 인증은 통과했지만(`X-Gateway-Client` 헤더가 찍힘) 라우팅에서 막힙니다.

```
$ curl -i -X POST /api/gateway/unknown -H "X-API-Key: demo-key-fintech-a" -d '{}'
HTTP/1.1 404
X-Gateway-Client: fintech-a
{"blocked":true,"status":404,"reason":"알 수 없는 라우트: POST /api/gateway/unknown"}
```

가장 중요한 두 함정은 테스트로 강제했습니다. **동시성**은 8스레드가 각 100회, 총 800회를 같은 클라이언트 버킷에 던져 통과가 **정확히 용량만큼**(초과 없이)인지 봅니다.

```java
// 시계 고정(보충 배제) → 통과는 딱 capacity건이어야 한다
assertThat(passed.get()).isEqualTo(capacity);
assertThat(blocked.get()).isEqualTo(threads * attemptsPerThread - capacity);
```

**시계 역행**은 가짜 시계를 과거로 되돌려도 토큰이 폭증하지 않는지 봅니다.

```java
now.set(과거값);                          // 벽시계 보정 흉내
assertThat(bucket.tryConsume()).isFalse(); // 폭증 없음
```

모듈 경계 검증까지 합쳐 `./gradlew test`는 **52개 전부 그린**입니다(1편의 37개 + 이번 15개). `ModularityTest`의 `verify()`가 그린이라는 건, 위에 그린 모듈 DAG가 코드로 지켜지고 있다는 뜻입니다.

#### 7. 잔여, 정직하게 안 한 것

- **분산 환경 rate limit 공유 안 됨.** 토큰버킷은 **단일 노드 인메모리**입니다. 인스턴스를 여럿으로 늘리면 각자 따로 세므로 전역 한도가 안 맞습니다. 공유하려면 Redis 같은 외부 저장소에 카운터를 둬야 하는데, 그 순간 네트워크 왕복·원자 연산·장애 시 동작이라는 새 문제가 붙습니다. 여기선 단일 노드로 명시하고 확장 지점으로 남깁니다.
- **JWT/OAuth 미구현.** 인증은 정적 API 키 검증까지입니다. 토큰 만료·서명 검증(JWT)이나 발급/위임 흐름(OAuth)은 범위 밖입니다. 인터페이스는 같은 자리(인증 필터)라 나중에 교체할 수 있게만 뒀습니다.
- **API 키 평문 보관.** 설정·인메모리에 평문으로 둡니다. 실서비스라면 시크릿 스토어에 두고 해시로 대조하겠지만 학습판의 경계입니다.
- **모듈러 모놀리스 ≠ 마이크로서비스.** 단일 배포 단위입니다. 경계가 코드로 강제될 뿐 프로세스·DB·배포는 하나입니다.

이제 통로 앞에 문지기가 섰습니다. 누가 보냈는지 확인하고 갈 곳이 있는지 보고 너무 자주 치면 잠시 막습니다. 그 관문을 통과한 요청만 1편의 전문 왕복에 닿습니다. 하지만 운영 중 "잔액조회가 가끔 실패한다"는 말이 나오면, 지금 구조로는 **어디서 깨졌는지**가 안 보입니다. 인증에서? 라우팅에서? 백엔드 타임아웃에서? 3편은 그 거래의 경로를 남기고 실패 지점을 드러냅니다.

그 전에, 1편 2부가 잔여로 남겨 둔 통로의 구멍 둘, 곧 가변 전문과 소켓 재사용부터 2부에서 메웁니다.

### 2부. 가변 프레이밍과 커넥션 풀

#### 1. 상황, 1편 2부가 남겨 둔 두 개의 구멍

[1편](#1-전문-파서와-tcp-프레이밍) 2부에서 통로를 열 때, 잔여로 두 가지를 정직하게 적어 뒀습니다.

> 커넥션 풀 없음(요청당 소켓), 길이 헤더(가변 전문) 미구현.

1편 2부의 프레이밍은 "한 전문 = 고정 61byte"만 다뤘습니다. 프레임 길이를 상수로 아니까, 그 길이만큼 모이면 잘라 내보내면 됐습니다. 하지만 실제 거래에는 **길이가 매번 다른 전문**이 있습니다. 대표적인 게 거래내역 조회 응답입니다. 계좌에 거래가 3건이면 레코드 3개, 12건이면 12개가 붙어 전문 전체 길이가 조회할 때마다 달라집니다. 프레임 길이 상수를 못 씁니다.

두 번째 구멍은 소켓입니다. 1편 2부의 클라이언트는 `exchange()`가 불릴 때마다 소켓을 새로 열고 응답을 받고 닫았습니다. 요청 한 건에 TCP 3-way 핸드셰이크 한 번, 소켓 자원 한 벌을 매번 지불한 셈입니다. 한두 건이면 티가 안 나지만 초당 수백 건이 흐르면 이 반복 비용이 그대로 지연이 됩니다.

이번 편의 목표는 그 두 구멍을 메우는 것입니다.

> 하나, 길이 헤더로 가변 전문을 프레이밍한다. 둘, 커넥션 풀로 소켓을 재사용한다.

#### 2. 함정, 가변 프레이밍의 2단계와 풀의 동시성·고갈

##### 함정 하나, 헤더도 반쪽으로 온다

가변 전문의 정석은 "전문 앞에 본문이 몇 byte인지 적은 길이 헤더를 두는 것"입니다. 받는 쪽은 헤더를 읽어 본문 길이 L을 알고 L byte를 모으면 한 전문이 완성됩니다.

문제는 TCP가 바이트 스트림이라는 점이 여기서 한 겹 더 깊어진다는 것입니다. 1편 2부에서 "고정 61byte도 한 번에 안 온다"를 다뤘는데, 가변에서는 **길이 헤더조차 반쪽으로 옵니다.** 4byte 헤더 중 2byte만 먼저 오면, 본문 길이를 아직 읽을 수조차 없습니다. 그러니 읽기가 2단계여야 합니다.

1. **1단계**: 헤더 4byte가 다 모일 때까지 기다린다(헤더 반쪽 방어).
2. **2단계**: 헤더로 본문 길이 L을 안 뒤, 본문 L byte가 다 모일 때까지 더 기다린다(본문 반쪽 방어).

여기에 1편 2부의 함정들이 그대로 얹힙니다. 여러 전문이 붙어 오는 뭉침과 한 전문 반쪽만 남는 경계 말입니다.

##### 함정 둘, 길이 헤더를 믿으면 안 된다

길이 헤더 방식의 조용한 위험은, **헤더에 적힌 숫자를 그대로 믿는다는 것**입니다. 스트림에 쓰레기 바이트가 섞이거나 헤더가 손상되면, 헤더가 "본문 9999byte"라고 거짓말할 수 있습니다. 그걸 믿고 "9999byte 올 때까지 기다리자"고 하면, 오지도 않을 바이트를 무한정 기다리거나 거대한 버퍼를 잡으려 듭니다. 자원 고갈로 번지는 표면입니다. 그래서 헤더는 **검증하고 어긋나면 즉시 끊어야** 합니다(fail-closed).

##### 함정 셋, 풀은 동시성과 고갈에서 샌다

커넥션 풀은 개념은 단순하지만("연 소켓을 쥐고 있다가 다음에 재사용") 두 곳에서 샙니다.

- **동시성**: 웹 요청은 스레드 풀에서 병렬로 처리됩니다. 여러 스레드가 동시에 풀에서 빌리고 반납하면, 카운터와 유휴 큐가 경쟁 상태에 빠져 "최대 4개"라던 풀이 5개, 6개를 열 수 있습니다.
- **고갈**: 최대 크기까지 다 빌려 나간 상태에서 또 요청이 오면 어떻게 할 것인가. 무한정 기다리면 스레드가 끝없이 적체됩니다. 정책을 정해야 합니다.

#### 3. 판단, 2단계 누적기와 검증하는 헤더, 잠그고 거절하는 풀

**하나, 가변 프레이밍은 고정 프레이밍과 나란히 둔다.** 1편 2부의 `FixedLengthFramer` 옆에 `LengthPrefixedFramer`를 새로 만듭니다. 둘 다 "소켓 조각을 누적하다가 한 전문이 완성되면 잘라 내보낸다"는 같은 골격이되, 경계를 잡는 방법만 다릅니다(상수 길이 vs 헤더가 알려주는 길이).

**둘, 헤더는 4byte ASCII 십진수로 두되 반드시 검증한다.** 헤더가 숫자가 아니거나, 설정한 상한을 넘는 길이를 요구하면 그 자리에서 실패시킵니다. 4byte ASCII로는 음수를 표현할 수 없지만 그 자리에 온 비-숫자·과대 길이가 현실의 "비정상 길이"입니다. 믿지 않고 끊습니다.

**셋, 가변 전문 코덱은 고정 코덱을 두 번 쓰는 것으로 만든다.** 응답 본문은 "고정 헤더 + 고정 레코드 × N"입니다. 1편의 고정 코덱을 앞 헤더에 한 번, 뒤 레코드에 건수만큼 쓰면 됩니다. 경계는 이미 전송 계층의 길이 헤더가 확정해 주므로, 본문 전체 길이에서 역산합니다.

**넷, 풀은 하나의 락으로 관리하고 가득 차면 거절한다.** 카운터·유휴 큐 갱신은 전부 하나의 `ReentrantLock` 안에서 하고 느린 소켓 open만 락 밖에서 합니다. 최대 크기까지 다 나간 상태에서 또 빌리면, 정해진 시간만 기다리다 그래도 자리가 없으면 무한 대기 대신 예외로 거절합니다(빠른 실패).

#### 4. 개선, 헤더로 자르고 코덱을 두 번 쓰고 풀로 재사용한다

##### 4-1. 길이 프리픽스 프레이머, 2단계로 자른다

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

읽는 쪽(`LengthPrefixedConnection`)은 1편 2부의 `FramedConnection`과 같은 골격입니다. read 버퍼를 일부러 작게(16byte) 잡아, 헤더·본문이 한 번에 안 오는 상황을 코드가 구조적으로 다루게 합니다.

##### 4-2. 가변 전문 코덱, 고정 코덱을 두 번 쓴다

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

클라이언트는 파싱 후 헤더가 밝힌 건수·전체길이가 실제와 맞는지 교차검증합니다. 전문의 자기 설명이 거짓이 아닌지 확인하는 셈입니다.

##### 4-3. 커넥션 풀, 하나의 락으로 재사용하고 고갈되면 거절한다

풀은 유휴 연결을 큐에 두고 빌릴 때 검증부터 합니다. 유휴가 있으면 재사용, 없으면 최대 크기 안에서 새로 열고 가득 차면 대기 후 거절합니다.

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

`total < maxSize`에서 먼저 `total++`로 슬롯을 선점하는 게 동시성 방어의 핵심입니다. 여러 스레드가 동시에 "여유 있다"를 봐도, 슬롯을 선점한 스레드만 실제로 새 소켓을 열기 때문에 최대 크기를 넘지 않습니다. 반납(`release`)은 연결을 검증해 살아 있으면 유휴 큐로 돌리고 죽었거나 처리 중 깨졌으면(`invalidate`) 폐기합니다.

`CoreBankingClient`(1편 2부, 고정 61byte)와 새 `TransactionHistoryClient`(가변)가 각자 이 풀을 하나씩 들고 `exchange()`/`query()`가 빌려 쓰고 반납합니다. 계정계가 keep-alive라 한 소켓으로 여러 전문을 주고받을 수 있어(서버측 처리 루프가 프레임이 더 안 올 때까지 읽습니다) 풀이 성립합니다.

#### 5. 실측, 진짜 실행

앱을 8090에 띄우고(내장 목업 계정계 두 개: 잔액조회 9099, 거래내역 9098), 실제로 왕복시켰습니다.

##### 가변 전문 왕복, 길이 헤더가 보인다

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

건수를 바꾸면 전체 길이가 따라 바뀝니다. 3건이면 본문 195byte, 10건이면 본문 580byte입니다. 이게 "가변"의 실측입니다.

##### 커넥션 풀, 순차는 소켓 1개, 동시는 최대 크기까지

같은 클라이언트로 순차로 6번 조회하면, 첫 왕복만 소켓을 새로 열고 이후는 재사용합니다(실제 출력).

```
조회 1: created(신규 소켓)       pool[created=1 reused=0 idle=1]
조회 2: reused #1            pool[created=1 reused=1 idle=1]
조회 3: reused #2            pool[created=1 reused=2 idle=1]
조회 4: reused #3            pool[created=1 reused=3 idle=1]
조회 5: reused #4            pool[created=1 reused=4 idle=1]
조회 6: reused #5            pool[created=1 reused=5 idle=1]
```

`created`가 1로 고정입니다. 소켓을 딱 하나만 열어 여섯 번 재사용했습니다. 1편 2부라면 여기서 소켓을 여섯 번 열고 닫았을 겁니다.

같은 풀에 동시에 10건을 폭주시키면, 이번엔 여러 소켓이 필요합니다. 하지만 최대 크기(4) 이상은 절대 열지 않습니다(실제 출력).

```
동시 폭주 후: created=4 (== max 4) · reused=12 · idle=4 · destroyed=0
```

`created=4`가 정확히 최대 크기와 같습니다. 10개 요청이 동시에 몰려도 소켓은 4개까지만 열고 나머지는 반납된 걸 이어받아 재사용했습니다. 슬롯 선점 방어가 동시성에서 초과 생성을 막은 결과입니다. 잔액조회(고정 61byte) 풀도 같은 방식으로 붙어, 세 번 조회하면 `created=1 reused=2`로 소켓 하나를 재사용합니다.

화면에도 같은 걸 붙였는데, 가변 전문 왕복은 길이 헤더가 노랗게 강조된 hex 덤프와 레코드 표를, 풀 상태는 활성/유휴/재사용 카운터를 보여줍니다.

![가변 전문 왕복(길이 헤더 강조 hex + 레코드 5건)과 커넥션 풀 상태(순차 재사용·동시 최대 크기)](/uploads/project/gwanmun/variable-length-demo.png)

##### 함정은 테스트로 강제했다

가장 중요한 경계들은 화면 데모로는 부족해 테스트로 못 박았습니다. `./gradlew test`는 **80개 전부 그린**입니다(1편과 1부의 52개 + 이번 28개).

- `LengthPrefixedFramerTest`(11)에서는 헤더 반쪽, 본문 반쪽, 한 바이트씩, 뭉침(길이 다른 세 전문), 한 전문 반, 빈 본문, 그리고 비정상 길이 거절(숫자 아님·상한 초과)을 검증합니다.
- `VariableMessageCodecTest`(4)에서는 레코드 5건 왕복 무손실(한글 포함), 0·1·12건 가변, 잘린 전문 거절을 확인합니다.
- `ConnectionPoolTest`(7)에서는 재사용(같은 소켓 객체), 죽은 연결 폐기, `invalidate` 폐기, 고갈 거절(대기 후 `PoolExhausted`), 대기자가 반납분을 이어받음, 동시성(8스레드×50회가 최대 3짜리 풀을 쳐도 활성이 3을 절대 안 넘음), 닫힌 풀 거절을 다룹니다.
- `MockTransactionHistoryServerTest`(6)에서는 실제 소켓 가변 왕복, 건수별 길이 차이, 결정론, 풀 재사용(한 소켓으로 keep-alive 3건), 서버측 partial read(길이 헤더 중간·본문 중간에서 쪼갠 요청 재조립), 동시 8건을 검증합니다.

동시성 테스트는 소켓 없이 가짜 연결로 풀 계약만 봅니다. 활성 수가 최대를 넘지 않고 재사용이 실제로 일어나며 만들어진 연결이 최대 크기 이하인지 확인합니다.

```java
assertThat(maxObservedActive.get()).isLessThanOrEqualTo(maxSize); // 초과 생성 없음
assertThat(ids.get()).isLessThanOrEqualTo(maxSize);               // 최대만큼만 열림
assertThat(pool.stats().reused()).isGreaterThan(0);               // 재사용이 실제로
```

##### 모듈 경계는 계속 코드가 강제한다

1부에서 세운 모듈러 모놀리스 경계는 이번에도 `ApplicationModules.verify()`가 그린으로 지킵니다. 클래스가 늘었지만(가변 프레이머·풀·거래내역 클라이언트는 `core`에, 가변 코덱·레코드 DTO는 `message`에, 새 컨트롤러는 `web`에) 전부 제자리에 들어가 순환이 생기지 않았습니다. 의존은 여전히 단방향 DAG이고 이번에 `web → core` 한 줄이 늘었습니다(새 컨트롤러가 거래내역 클라이언트를 씀).

```
web      → gateway, message, core
gateway  → message, core
core     → message
message  → (없음 — 순수 모듈)
```

Documenter가 다시 그린 다이어그램은 `docs/modules/`에 갱신돼 있습니다.

#### 6. 잔여, 정직하게 안 한 것

- **길이 헤더는 4byte ASCII 십진수 한 종류.** 본문 최대 9999byte까지만 표현합니다. 실무에는 2byte·4byte 바이너리(빅엔디언), 헤더에 본문 외 다른 필드까지 포함하는 변형이 많지만 여기선 한 종류로 원리를 보였습니다. 더 큰 전문·다른 헤더 규격은 프레이머의 헤더 해석부만 바꾸면 되는 자리로 남깁니다.
- **풀은 최소 기능.** 최대 크기·유휴 반납·검증·고갈 거절까지입니다. 유휴 연결의 최대 생존 시간(오래 놀던 소켓 선제 폐기), 주기적 헬스체크, 최소 유휴 수 유지(warm pool), 연결 누수 감지 같은 상용 풀의 기능은 없습니다. 검증은 빌려주기/반납 시점의 소켓 상태 확인까지입니다.
- **파이프라이닝 없음.** 한 연결에서 요청→응답을 끝낸 뒤 다음을 보냅니다. 응답을 기다리지 않고 요청을 연달아 밀어 넣는 파이프라이닝은 범위 밖입니다(프레이머는 뭉침을 처리하니 받는 쪽 토대는 있지만 보내는 쪽 상관관계 관리는 안 했습니다).
- **가변 전문은 대표 한 종.** 거래내역 조회 하나로 "고정 헤더 + 반복 레코드" 구조를 보였습니다. 중첩 가변(레코드 안에 또 가변 배열)이나 선택 필드가 있는 전문은 다루지 않았습니다.

1편 2부가 남긴 두 구멍을 메웠습니다. 이제 길이가 매번 다른 전문도 프레이밍으로 정확히 자르고 소켓은 요청마다 새로 열지 않고 재사용합니다. 통로가 더 튼튼해졌습니다.

---

## 3. 3값 원장과 손으로 짠 서킷브레이커

*원문 발행일 2025-09-21*

### 1부. 거래 원장과 3값 상태: 타임아웃은 실패가 아니다

#### 1. 상황: 통로는 튼튼해졌는데 아무것도 기억하지 못한다

[2편](#2-필터-체인과-가변-프레이밍-커넥션-풀)까지로 통로 자체는 꽤 단단해졌습니다. 고정·가변 전문을 프레이밍으로 정확히 자르고, 필터 체인이 문을 지키고, 커넥션 풀이 소켓을 재사용합니다.

그런데 이 게이트웨이에 이런 질문을 던지면 답이 없습니다.

> "어제 14시쯤 들어온 그 잔액조회, 계정계까지 갔나요? 응답은 받았나요?"

게이트웨이는 거래를 흘려보내기만 하고 **아무것도 기억하지 못합니다.** 앱 로그가 있긴 하지만, 어떤 로그 라인이 어떤 요청의 것인지 묶을 열쇠가 없고 거래 하나가 성공했는지 실패했는지의 판정 자체가 어디에도 적히지 않습니다. 평소에는 문제가 안 됩니다. 문제는 장애 때입니다. 호출자(핀테크)는 "응답을 못 받았다"고 하고 계정계는 "우린 처리했다"고 하는 상황에서, 중간에 서 있던 게이트웨이가 아무 기록이 없으면 중재가 불가능합니다.

이번 편의 목표는 게이트웨이에 기억을 붙이는 것입니다.

> 하나, 모든 거래에 유일한 거래고유번호를 채번한다. 둘, 거래의 결과를 원장(DB)에 적는다. 셋, 그 원장이 스스로 거짓말하지 않게 한다.

셋째가 이번 편의 요점입니다. 아래 함정에서 다룹니다.

#### 2. 함정: 타임아웃은 실패가 아니다, 그리고 두 가지 더

##### 함정 하나. 응답을 못 받은 거래를 "실패"로 적으면 안 된다

거래 상태를 성공/실패 2값으로 설계하면 자연스럽게 이렇게 짜게 됩니다: "예외가 났으니 FAILED".

그런데 타임아웃을 생각해 보면 이게 거짓말입니다. read 타임아웃은 "정해진 시간 안에 응답이 안 왔다"이지 "계정계가 처리를 안 했다"가 아닙니다. 요청 전문은 이미 소켓을 타고 나갔고 계정계는 받아서 처리한 뒤 응답을 보냈는데 그게 늦게 도착하는 중일 수도 있습니다. 이걸 FAILED로 적으면 어떻게 될까요? 호출자든 운영자든 "실패했으니 다시 보내자"가 되고, 계정계에서는 같은 거래가 **두 번** 실행됩니다. 잔액조회면 무해하지만 이체라면 사고입니다.

그래서 금융 연계의 거래 상태는 3값이어야 합니다.

- **SUCCESS**는 응답을 정상 수신했고 응답코드도 정상이다.
- **FAILED**는 명확한 실패다. 오류 응답을 받았거나(없는 계좌), 입력이 틀렸거나, 연결 자체가 거부돼 **요청이 나가기 전에** 죽었다. 계정계에서 처리됐을 가능성이 없다.
- **UNKNOWN**은 **모른다.** 요청은 나갔는데 응답을 못 받았다(타임아웃, 응답 없는 연결 종료). 처리됐을 수도, 안 됐을 수도 있다.

UNKNOWN을 인정하는 게 찜찜해 보이지만 모르는 것을 모른다고 적는 것이 아는 척 틀리게 적는 것보다 훨씬 안전합니다. UNKNOWN으로 적힌 거래만 골라 나중에 확인(대사)하면 되기 때문입니다.

##### 함정 둘. 기록이 거래를 느리게 하면 안 된다

원장 적재를 거래 경로에 동기로 끼우면, DB insert 시간만큼 모든 거래가 느려집니다. 더 나쁜 건 원장 DB 장애입니다. 관측하려고 붙인 DB가 죽어서 거래까지 죽으면, 관측이 장애의 원인이 됩니다. 부가 기능이 본 기능의 관문이 되는 구조는 뒤집혀 있습니다.

##### 함정 셋. 원장이 민감정보 창고가 된다

거래 기록에는 계좌번호가 들어갑니다. 원문 그대로 쌓으면 원장 테이블이 곧 계좌번호 창고입니다. DB 백업, 조회 화면, 로그로 흘러나가는 모든 경로가 유출 표면이 됩니다. 마스킹을 "보여줄 때" 하면 늦습니다. 저장돼 있는 이상 어디로든 샙니다.

#### 3. 판단: 새 모듈, 예외 사슬 판정, 저장 직전 마스킹

**하나, 원장은 새 모듈 `ledger`로 세운다.** 관측은 통역(message)·전송(core)·검문(gateway) 어디의 부속도 아니라서 경계를 따로 긋습니다. 의존은 ledger → message(마스커) 한 줄뿐이고, web이 ledger를 조립합니다. `ApplicationModules.verify()`가 이 경계를 계속 강제합니다.

**둘, 거래고유번호는 자기설명 구조로.** 오픈뱅킹 거래고유번호(bank_tran_id)가 "이용기관코드 + 생성구분 + 일련번호"로 ID만 보고도 출처가 읽히게 돼 있는 걸 참조해, `GWMN`(생성주체) + `U`(구분) + 날짜 8자리 + 일련번호 9자리 = 22자로 정했습니다. 유일성은 두 겹으로 보장합니다. 동시 요청은 `AtomicLong`이(락 없이 원자적), 재기동은 "자정 이후 흐른 밀리초 × 10"을 시드로 써서(재기동하면 시드가 죽기 전 발급분을 앞지름) 막습니다.

**셋, 3값 판정은 예외의 원인 사슬로.** 응답을 받았으면 응답코드로(0000=SUCCESS, 그 외=FAILED), 못 받았으면 예외 사슬을 훑어 `SocketTimeoutException`·`EOFException`(요청은 나감)이면 UNKNOWN, `ConnectException` 등(나가기도 전)이면 FAILED.

**넷, 적재는 전용 스레드 + 유한 큐로 비동기.** 거래 스레드는 큐에 넣고 즉시 돌아갑니다. 큐가 차거나 DB가 죽으면 WARN 로그만 남기고 거래는 진행합니다. `record()`는 예외를 던지지 않는 메서드로 계약합니다.

**다섯, 마스킹은 저장 직전 한 곳에서.** 규칙은 명시적으로 "앞 6자리 + 뒤 4자리만 노출"(짧으면 더 보수적으로). 적재 경로가 어디든 이 지점을 지나므로 원장에 원문이 남을 수 없습니다. 앱 로그의 계좌도 같은 마스커를 거칩니다.

**여섯, 요청마다 correlation ID.** 수신 헤더 `X-Correlation-Id`가 있으면 승계하고(형식 검증 후), 없으면 만들어 MDC에 넣습니다. 로그 패턴이 모든 라인에 자동으로 찍고 응답 헤더로 돌려주고 원장에도 저장합니다. "이 502가 어느 요청이었나"를 호출자↔앱 로그↔원장 사이에서 한 줄로 꿰는 실입니다.

저장소는 PostgreSQL 컨테이너(자체 docker-compose, 재기동해도 원장이 남게)로 하되, 로컬 개발·테스트는 H2 인메모리로 DB 없이 돌게 했습니다.

#### 4. 개선: 채번기, 판정, 비동기 원장

##### 4-1. 채번: 스레드 안전과 재기동 안전을 분리해서 푼다

```java
public String next() {
    long seq = sequence.incrementAndGet() % SEQUENCE_SPACE;   // 동시성: 원자적 증가
    return "GWMN" + "U" + LocalDate.now(clock).format(BASIC_ISO_DATE)
            + String.format("%09d", seq);
}

// 재기동 안전: 시드 = 자정 이후 흐른 ms × 10.
// 재기동하면 그 사이 흐른 시간만큼 시드가 앞서 있어, 죽기 전 발급분과 겹치지 않는다
// (지속 발급률이 초당 1만 건을 넘지 않는 한 — 단일 노드 전제).
long millisOfDay = LocalTime.now(clock).toNanoOfDay() / 1_000_000L;
this.sequence = new AtomicLong((millisOfDay * 10) % SEQUENCE_SPACE);
```

날짜가 ID에 박혀 있으므로 날이 바뀌면 일련번호가 겹쳐도 ID는 다릅니다. 테스트는 16스레드 × 2000건 동시 채번이 전부 유일한 것과, 시계를 주입해 "5초 뒤 재기동한 채번기 1만 건이 이전 1만 건과 안 겹치는 것"을 못 박았습니다.

##### 4-2. 원인 사슬을 훑는 3값 판정

```java
public static TransactionStatus ofFailure(Throwable failure) {
    Throwable t = failure;
    for (int depth = 0; t != null && depth < MAX_CAUSE_DEPTH; depth++) {
        if (t instanceof SocketTimeoutException || t instanceof EOFException) {
            return UNKNOWN;   // 요청은 나갔는데 응답을 못 받았다 — 모른다고 적는다
        }
        t = t.getCause();
    }
    return FAILED;            // 연결 거부·풀 고갈 등: 나가기도 전의 실패 — 명확히 실패
}
```

게이트웨이 예외로 몇 겹 감싸여 와도 사슬을 따라가 같은 판정을 냅니다. `EOFException`(응답 전문 없이 연결이 닫힘)도 UNKNOWN인 게 포인트입니다. 요청은 이미 나갔기 때문입니다.

##### 4-3. 비동기 원장: record()는 예외를 던지지 않는다

```java
public void record(LedgerRecord record) {
    meterRegistry.counter("gwanmun.ledger.transactions",
            "status", record.status().name()).increment();
    try {
        writer.execute(() -> persist(record));   // 전용 스레드 + 유한 큐(1000)
    } catch (RejectedExecutionException e) {
        log.warn("원장 적재 큐 포화 — 기록을 건너뜁니다(거래는 정상 진행): txId={}", ...);
    }
}

private void persist(LedgerRecord r) {
    try {
        repository.save(new LedgerEntry(..., AccountMasker.mask(r.accountNo()), ...));
    } catch (RuntimeException e) {
        // 원장 DB 장애가 거래 장애로 번지면 안 된다. 거래는 이미 끝났다.
        log.warn("원장 적재 실패(거래는 이미 정상 진행됨): txId={} 원인={}", ...);
    }
}
```

마스킹이 `persist()` 안, 즉 저장 직전 한 곳에 있는 것도 의도입니다. 테스트는 "save가 예외를 던져도 record()는 안 던진다"와 "저장된 엔티티의 계좌가 `123456****1234`이고 원문이 없다"를 검증합니다.

컨트롤러는 거래마다 ID를 먼저 채번하고, 결과가 어느 쪽이든 원장에 적습니다. 타임아웃(UNKNOWN)일 때는 HTTP도 502 대신 **504**로 구분해 돌려줍니다. "백엔드가 실패했다"와 "응답을 못 받았다(결과 미확인)"는 호출자에게도 다른 정보입니다.

#### 5. 실측: 3값이 실제로 원장에 남는다

원장 DB(PostgreSQL 16, 자체 docker-compose, 포트 25432)를 띄우고 앱을 postgres 프로파일로 기동했습니다. UNKNOWN을 진짜로 만들기 위해 목업 계정계에 지연 모드를 하나 넣었습니다. 계좌 `99999999999999`로 요청이 오면 정상 처리하되 응답만 5초 늦춥니다. 게이트웨이의 read 타임아웃이 3초라 반드시 타임아웃이 납니다.

**(a) 정상 거래 → SUCCESS** (curl 실제 출력, 거래ID가 응답에 노출)

```
POST /api/gateway/balance {"accountNo":"12345678901234"}
HTTP/1.1 200
X-Correlation-Id: demo-cid-success-1
{"transactionId":"GWMNU20260709105002301","ledgerStatus":"SUCCESS", ..., "elapsedMs":2}
```

**(b) 없는 계좌 → FAILED** (응답은 받았고, 오류 코드 0001이므로 UNKNOWN이 아닌 FAILED)

```
{"transactionId":"GWMNU20260709105002302","ledgerStatus":"FAILED",
 "json":{"responseCode":"0001","responseMessage":"없는 계좌입니다"}}
```

**(c) 지연 계좌 → 타임아웃 → UNKNOWN** (3.06초 만에 504, read 타임아웃 3000ms에서 포기)

```
POST /api/gateway/balance {"accountNo":"99999999999999"}
HTTP/1.1 504
{"error":"계정계(127.0.0.1:9099) 통신 실패: Read timed out",
 "transactionId":"GWMNU20260709105002303","ledgerStatus":"UNKNOWN"}
```

이때 계정계(목업) 쪽 로그에는 요청이 도달해 처리된 흔적이 남아 있습니다. "실패"라고 적었다면 틀렸을 상황입니다.

```
io.gwanmun.core.MockCoreBankingServer : 지연 모드 계좌 — 응답을 5000ms 늦춥니다(게이트웨이 타임아웃 유발용)
```

원장 DB를 직접 열어 보면(psql 실제 출력):

```
gwanmun=# SELECT transaction_id, status, response_code, elapsed_ms, detail
          FROM transaction_ledger WHERE status <> 'SUCCESS' ORDER BY id;
     transaction_id     | status  | response_code | elapsed_ms |                      detail
------------------------+---------+---------------+------------+--------------------------------------------------
 GWMNU20260709105002302 | FAILED  | 0001          |          0 | 없는 계좌입니다
 GWMNU20260709105002303 | UNKNOWN |               |       3011 | 계정계(127.0.0.1:9099) 통신 실패: Read timed out
```

UNKNOWN 행의 `response_code`가 비어 있습니다. 응답 자체를 못 받았다는 정직한 기록입니다. `elapsed_ms=3011`은 타임아웃 3초의 흔적이고, `account_masked` 컬럼은 `999999****9999`처럼 마스킹된 값만 있습니다.

##### correlation ID로 로그와 원장을 한 줄에 꿴다

앱 로그의 모든 라인에 `[cid:...]`가 찍힙니다(실제 출력, 계좌도 마스킹돼 있습니다).

```
[cid:demo-cid-success-1] io.gwanmun.gateway.GatewayService : 게이트웨이 왕복 완료: 계좌=123456****1234 응답코드=0000 잔액=6879445000 (2ms)
[cid:c1d066748a7944d7]   io.gwanmun.gateway.GatewayService : 게이트웨이 왕복 완료: 계좌=* 응답코드=0001 잔액=0 (0ms)
```

`demo-cid-success-1`은 호출자가 보낸 헤더를 승계한 값이고, 다른 하나는 게이트웨이가 생성한 값입니다. 같은 ID가 응답 헤더와 원장 행에도 저장돼 있어, 셋 중 어느 쪽에서 출발해도 나머지를 찾을 수 있습니다.

##### 자체 구현물이 스스로를 보고하는 커스텀 메트릭

`/actuator/prometheus`의 자체 구현물 메트릭입니다(429를 2건 유발한 직후, 실제 출력).

```
gwanmun_core_roundtrip_seconds_count{tx="balance"} 7
gwanmun_ledger_transactions_total{status="FAILED"} 1.0
gwanmun_ledger_transactions_total{status="SUCCESS"} 7.0
gwanmun_ledger_transactions_total{status="UNKNOWN"} 1.0
gwanmun_pool_active{pool="core-banking"} 0.0
gwanmun_pool_idle{pool="core-banking"} 1.0
gwanmun_pool_opened_total{pool="core-banking"} 2.0
gwanmun_pool_reused_total{pool="core-banking"} 6.0
gwanmun_pool_destroyed_total{pool="core-banking"} 1.0
gwanmun_ratelimit_consumed_total{client="fintech-b"} 5.0
gwanmun_ratelimit_rejected_total{client="fintech-b"} 2.0
```

읽는 재미가 있습니다. `destroyed_total=1`은 타임아웃 난 소켓을 풀이 폐기한 것이고, `opened_total=2 · reused_total=6`은 소켓 2개로 8왕복을 처리했다는 뜻입니다. 2편 1부의 토큰버킷과 2부의 커넥션 풀이 이제 숫자로 자신을 보고합니다. 헬스는 liveness/readiness가 분리돼 있고(`/actuator/health/liveness`·`/readiness` 각각 UP), SIGTERM을 보내면 graceful shutdown이 처리 중 요청을 마저 끝낸 뒤 풀과 원장 스레드를 정리하는 것도 로그로 확인했습니다.

여기서 삽질 하나를 정직하게 적어 둡니다. 풀의 누적 개설 수를 처음에 `gwanmun.pool.created` 게이지로 등록했는데, Prometheus 신형 노출 형식에서 `_created`가 **예약 접미사**라 지표가 `gwanmun_pool_total`로 뭉개져 나왔습니다. 게이지가 일회성 람다를 약참조로 쥐어 GC 뒤 NaN이 되는 함정도 같이 밟았습니다. 누적값은 단조 증가이므로 함수 카운터(`opened_total`)로 바꾸고, 게이지는 컨텍스트가 살아 있는 한 살아 있는 클라이언트 빈에 걸어 해결했습니다.

##### 화면에서 3값이 색으로 보인다

화면에도 원장 섹션을 붙였습니다. 상태별 카운트와 최근 거래 표를 넣었고, UNKNOWN 행의 소요 3011ms, 마스킹된 계좌, correlation ID까지 그대로 보입니다.

![거래 원장 화면. SUCCESS(초록)/FAILED(빨강)/UNKNOWN(노랑) 3값 상태와 마스킹된 계좌, correlation ID가 함께 보인다](/uploads/project/gwanmun/transaction-ledger.png)

##### 테스트

`./gradlew test`는 **104개 전부 그린**입니다(1~2편의 80개 + 이번 24개). 채번 동시성·재기동, 3값 판정(진짜 소켓 타임아웃 포함), 마스킹 규칙, "적재 실패가 거래를 안 막는 것", HTTP→소켓→비동기 적재 전 구간 통합까지. 새 `ledger` 모듈을 포함해도 `ApplicationModules.verify()`는 계속 그린입니다(5모듈 단방향 DAG는 web → gateway·message·core·ledger, ledger → message).

#### 6. 잔여: 정직하게 안 한 것

- **UNKNOWN을 해소하는 흐름이 없습니다.** 이번 편은 UNKNOWN을 *기록*하는 것까지입니다. 실무라면 UNKNOWN 거래를 취소 전문(망취소)으로 무효화하거나 상태 조회(대사)로 확정 짓는 후속 흐름이 붙어야 합니다. 그게 2부의 재료입니다.
- **멱등키가 없습니다.** 호출자가 같은 요청을 재시도해도 게이트웨이는 새 거래로 봅니다. 거래ID로 문의는 가능하지만 중복 실행 방지는 안 됩니다.
- **채번은 단일 노드 전제입니다.** 다중 인스턴스라면 노드 식별자를 넣거나 중앙 채번이 필요합니다.
- **JWT/OAuth는 여전히 미구현**(3편 잔여 그대로)이고, 원장의 보존 기한·파티셔닝·변경 감사 추적도 없습니다.

이제 게이트웨이가 거래를 기억합니다. 무엇이 성공했고 무엇이 실패했으며, 가장 중요하게는 **무엇을 모르는지**를 스스로 압니다. 모른다고 적힌 거래를 확정 짓는 일이 다음 차례입니다.

### 2부. 손으로 짠 서킷브레이커, 그리고 망취소로 UNKNOWN 확정 짓기

#### 1. 상황: 폭탄이 둘 남아 있다

1부로 게이트웨이가 기억을 갖게 됐습니다. 모든 거래에 거래고유번호가 붙고, 결과가 3값 상태(SUCCESS/FAILED/UNKNOWN)로 원장에 남습니다. 그런데 그 원장을 보다 보면 두 가지가 눈에 밟힙니다.

**첫째, 계정계가 느려지면 게이트웨이가 같이 죽습니다.** read 타임아웃이 3초라는 말은, 계정계가 죽어 있으면 요청 하나가 3초씩 스레드를 붙잡는다는 뜻입니다. 트래픽이 계속 들어오면 톰캣 스레드가 전부 "죽은 계정계 기다리기"에 묶이고 계정계 장애가 게이트웨이 장애로 번집니다. 중계자가 백엔드와 운명을 같이하면 중계자를 둔 의미가 없습니다.

**둘째, UNKNOWN이 기록만 되고 방치돼 있습니다.** 1부에서 "타임아웃은 실패가 아니다, 모른다고 적는다"까지 갔지만 모른다고 적힌 거래는 그 뒤로 아무도 안 건드립니다. 실무라면 이 거래들이 대사(對査) 리스트에 올라 "계정계에서 처리됐는지" 확인되고, 처리됐으면 취소(망취소)로 무효화되거나 확정돼야 합니다. 기록은 해소를 위한 준비일 뿐입니다.

이번 편의 목표는 이 둘입니다.

> 하나, 계정계 장애가 게이트웨이를 무너뜨리지 못하게 한다(서킷브레이커·재시도·데드라인). 둘, UNKNOWN을 해소한다(거래상태조회·망취소).

#### 2. 함정: 재시도는 양날이고, 타임아웃은 한 겹이 아니다

##### 함정 하나. 변경성 거래를 재시도하면 이중 거래다

"실패하면 다시 보내자"는 직관적입니다. 그런데 1부에서 확인했듯, 타임아웃은 실패가 아닙니다. 아직 결과를 모르는 미확인 상태입니다. 계정계는 처리를 끝냈는데 응답만 늦은 것일 수 있습니다. 그 상태에서 재전송하면 같은 거래가 두 번 실행됩니다. 잔액조회면 무해하지만 이체나 취소라면 사고입니다.

그래서 재시도 허용 여부는 설정 옵션으로 두지 않고 **거래의 성격**에 못 박아야 합니다. 조회성(잔액조회·거래내역·상태조회)은 몇 번을 다시 보내도 계정계 상태가 안 변하니 재시도해도 안전합니다. 변경성(이체·망취소)은 재시도 금지입니다. 응답을 못 받으면 UNKNOWN으로 남기고, 해소 절차로 넘깁니다.

##### 함정 둘. 소켓 read 타임아웃은 "호출 한 번"의 제한일 뿐이다

재시도를 붙이는 순간 시간 계산이 달라집니다. read 타임아웃 3초에 재시도 2회면, 거래 하나가 최악의 경우 3초 × 3회 + 백오프로 10초 가까이 늘어집니다. 호출자는 그만큼 기다려 주지 않습니다. 그래서 "호출 한 번"의 제한과 별개로 **"거래 전체"의 데드라인**이 필요합니다. 그리고 데드라인은 새 시도의 출발선만 막아서는 부족합니다. 남은 시간이 1.8초인데 마지막 시도가 read 타임아웃 3초를 다 쓰면 데드라인이 뚫립니다. 매 시도의 read 제한 자체를 남은 시간으로 깎아야 합니다.

##### 함정 셋. HALF_OPEN은 동시성 함정이다

서킷브레이커의 상태 전이 중 제일 미묘한 곳이 HALF_OPEN입니다. OPEN 대기가 끝났다고 통로를 활짝 열면, 회복 중이던 백엔드에 밀린 트래픽이 한꺼번에 쏟아져 다시 눕습니다. 탐침(probe)을 제한된 수만 내보내고 탐침이 나가 있는 동안의 다른 호출은 즉시 거절해야 합니다. 여러 스레드가 동시에 "대기 끝났네, 내가 탐침"이라며 뚫고 나가지 못하게 상태 전이와 탐침 카운트가 한 락 안에서 움직여야 합니다.

##### 함정 넷. 원거래 전문에 열쇠가 없으면 대사가 불가능하다

상태조회를 설계하다가 구멍을 발견했습니다. 1부까지의 잔액조회 요청 전문(30byte)에는 **거래고유번호 필드가 없습니다.** 거래ID는 게이트웨이 원장에만 적혔지, 전문에 실려 나간 적이 없습니다. 그러면 계정계에 "GWMNU...031 거래 처리했습니까?"라고 물어도 계정계는 그 번호를 모릅니다. 대사는 양쪽이 같은 열쇠를 쥐고 있어야 성립합니다. 오픈뱅킹 전문이 bank_tran_id를 본문에 싣는 이유가 이것입니다.

#### 3. 판단: 성격을 타입에 박고, 확정은 조회로 한다

**하나, 서킷브레이커는 직접 구현한다.** 이 프로젝트의 원칙 그대로입니다. 프레임워크 통짜(Resilience4j) 대신 손으로 짜서, 게이트웨이 내부에서 무슨 일이 일어나는지 이해하려는 겁니다. 상태는 셋입니다. CLOSED(정상, 연속 실패를 센다) → OPEN(임계 도달, 계정계 호출 없이 즉시 실패하고 원장에는 FAILED) → HALF_OPEN(대기 후 제한 탐침) → 성공 시 CLOSED. 동시성은 synchronized 한 겹으로 지킵니다. 상태 전이·카운터 갱신은 나노초 단위 작업이라 락 경합이 문제되지 않고, 미묘한 lock-free 코드보다 검증이 쉽습니다. 상태 전이는 WARN 로그와 Prometheus 게이지(`gwanmun_circuit_state` 0/1/2)·카운터(opened/rejected)로 노출합니다.

**둘, 재시도 가능 여부는 enum으로 강제한다.** `TransactionKind.INQUIRY`(조회성, 재시도 허용)와 `MUTATION`(변경성, 재시도 금지)을 만들고, 계정계 클라이언트의 `exchange(frame, kind)`가 이 성격을 받습니다. 변경성이면 실행기가 재시도 설정을 무시하고 1회로 끝냅니다. 설정이 어떻든 코드가 재시도를 막습니다.

**셋, 거래 데드라인이 마지막 시도까지 깎는다.** 소켓 read 타임아웃 3초(1회 호출 제한)와 별개로 거래 데드라인 5초를 둡니다. 시도 사이 백오프를 포함해 남은 시간을 계산하고, 매 시도의 read 타임아웃을 `min(설정값, 남은 시간)`으로 낮춥니다. 커넥션 풀에서 빌린 소켓의 `soTimeout`을 시도마다 조정하는 메서드를 연결 인터페이스에 추가했습니다.

**넷, UNKNOWN의 확정은 조회로 한다.** 금융 연계의 정수라고 생각하는 부분입니다. 응답을 못 받은 거래는 "모름"이고, 계정계에 **물어서** 확정합니다.

- 원거래 전문에 거래고유번호를 싣습니다. 요청 전문 공통 선두를 `전문구분(4) + 거래고유번호(22)`로 확장(30 → 52byte)했습니다. 아픈 변경이지만 피할 수 없습니다. 열쇠 없는 대사는 없습니다.
- 목업 계정계가 자기가 처리한 거래를 기억합니다(인메모리 원장: 거래ID → 처리 결과). 지연 모드 계좌는 **기록 먼저, 응답은 늦게** 돌려줍니다. 게이트웨이가 포기해도 계정계엔 처리 흔적이 남는, UNKNOWN의 전형적 상황이 재현됩니다. 반대로 유실 모드 계좌(`8888...`)는 기록도 응답도 없이 연결을 끊습니다. 처리 직전에 죽은 계정계인 셈입니다.
- 전문 2종을 추가합니다. **거래상태조회(0400)**: 원거래 거래ID로 "처리됨(01)/미처리(02)"를 답받는다. **망취소(0420)**: 처리된 원거래를 무효화한다(멱등이라 이미 취소된 원거래도 취소 성공). 네 전문이 같은 프레임 규격(요청 52/응답 61byte)이라 기존 고정길이 프레이밍·커넥션 풀을 그대로 탑니다.

정책 하나를 결정해야 했습니다. 상태조회가 "처리됨"이면 그 거래를 성공으로 살릴 수도(CONFIRMED) 있습니다. 저는 **망취소**를 택했습니다. 게이트웨이는 호출자에게 이미 504를 돌려줬습니다. 호출자가 모르는 성공을 계정계에 살려두면 양쪽 장부가 어긋납니다. 원거래를 무효화해 "없던 일"로 맞추는 것이 오픈뱅킹 망취소의 관례이기도 합니다. "미처리"라면 처리됐을 가능성이 0이므로, 그제야 FAILED로 확정할 수 있습니다.

원장에는 4번째 상태 `CANCELED`와 해소 이력(resolved_at, resolution_method)이 생깁니다. CANCELED로 들어오는 길은 해소 절차뿐이고, 거래 시점 판정은 여전히 3값만 냅니다.

#### 4. 개선: 실행기 하나에 세 겹을 두른다

계정계로 나가는 모든 호출이 `ResilientExecutor`를 지납니다. 데드라인·재시도·서킷이 한 루프에 있습니다.

```java
public <T> T execute(TransactionKind kind, Attempt<T> attempt) throws IOException {
    long start = nanoTime.getAsLong();
    int maxAttempts = kind.retryable() ? 1 + maxRetries : 1;   // 변경성은 무조건 1회
    IOException last = null;

    for (int attemptNo = 1; attemptNo <= maxAttempts; attemptNo++) {
        if (attemptNo > 1) {
            long backoff = backoffMs << (attemptNo - 2);       // 200 → 400 → ...
            if (elapsedMs(start) + backoff >= deadlineMs) break;  // 데드라인 소진 — 재시도 포기
            sleeper.sleep(backoff);
        }
        long remaining = deadlineMs - elapsedMs(start);
        if (remaining <= 0) break;

        try {
            breaker.acquire();                 // 서킷 OPEN이면 여기서 즉시 거절
        } catch (CircuitOpenException e) {
            if (last != null) throw last;      // 재시도 도중 열렸다면 "원래의 실패"를 던진다
            throw e;
        }
        try {
            // 이번 시도의 read 타임아웃 = min(설정값, 데드라인까지 남은 시간)
            T result = attempt.call((int) Math.min(readTimeoutMs, remaining));
            breaker.onSuccess();
            return result;
        } catch (IOException e) {
            breaker.onFailure();
            last = e;
            if (!kind.retryable()) throw e;    // 변경성: 첫 실패에서 그대로 — 이중 거래 방어
        }
    }
    throw last;
}
```

디테일 두 곳이 이번 편의 판단을 담고 있습니다. 재시도 도중 서킷이 열리면(내 실패가 임계를 채운 경우 포함) `CircuitOpenException` 대신 **마지막 실제 실패**를 던집니다. 호출자에게 중요한 건 서킷이 열렸다는 사실보다 계정계가 어떻게 실패했는가이고 3값 판정(타임아웃→UNKNOWN)도 그 원인을 봐야 하기 때문입니다. 반대로 첫 시도 전부터 열려 있었다면 `CircuitOpenException`이 그대로 올라가는데, 이건 요청이 밖으로 나가지 않은 실패라 판정이 **FAILED**로 떨어집니다. UNKNOWN이 될 여지가 없습니다(HTTP는 503으로 구분).

서킷브레이커 본체는 synchronized 상태 기계입니다. HALF_OPEN의 탐침 정원이 함정 셋의 답입니다.

```java
public synchronized void acquire() throws CircuitOpenException {
    if (state == OPEN) {
        if (waitedMs < openWaitMs) { rejectedTotal++; throw new CircuitOpenException(...); }
        transition(HALF_OPEN, "대기 경과 — 탐침 허용");
        probesInFlight = 0;
    }
    if (state == HALF_OPEN) {
        if (probesInFlight >= halfOpenMaxProbes) {   // 탐침이 나가 있는 동안은
            rejectedTotal++;                          // 추가 호출을 즉시 거절 —
            throw new CircuitOpenException(...);      // 회복 확인 전에 트래픽을 쏟지 않는다
        }
        probesInFlight++;
    }
}
```

해소 플로우는 gateway 모듈의 `TransactionResolutionService`가 맡습니다. 상태조회는 조회성이라 재시도를 허용하고, 망취소는 `MUTATION`으로 나갑니다.

```java
// ① 거래상태조회 — 조회성: 재시도 허용
byte[] statusRes = client.exchange(statusReqFrame, TransactionKind.INQUIRY);
if (!PROCESSED.equals(parsed.getProcessedFlag())) {
    return outcome(CONFIRMED_UNPROCESSED);   // 미처리 확인 → 이제야 FAILED로 확정 가능
}
// ② 망취소 — 변경성: 재시도 금지. 이마저 응답을 못 받으면 UNKNOWN 유지, 상태조회부터 다시.
byte[] cancelRes = client.exchange(cancelReqFrame, TransactionKind.MUTATION);
```

이 서비스는 원장을 모릅니다. 전문 왕복과 판정만 하고, 원장 확정(UNKNOWN→CANCELED/FAILED)은 조립층인 web 컨트롤러가 합니다. gateway → ledger 의존을 만들지 않으려는 모듈 경계이고, `ApplicationModules.verify()`는 이번에도 그린입니다.

#### 5. 실측: 서킷이 열리고 닫히는 것, 해소 두 경로가 원장에 남는 것

##### 계정계 프로세스를 진짜로 죽여 본 서킷

앱과 목업 계정계를 두 프로세스로 띄우고(`--gwanmun.core.embedded=false` + `runMockCore`), 계정계를 kill한 뒤 연속 5회 호출했습니다(실제 출력).

```
요청 1 → HTTP 502 : 계정계(127.0.0.1:9099) 통신 실패: Connection refused
요청 2 → HTTP 503 : 서킷 'core-banking' OPEN — 계정계 호출을 차단하고 즉시 실패
요청 3 → HTTP 503 : (동일)
요청 4 → HTTP 503 : (동일)
요청 5 → HTTP 503 : (동일)
```

요청 1 하나가 서킷을 열었습니다. 원호출 + 재시도 2회 = 연속 실패 3회가 임계(3)를 정확히 채웠기 때문입니다. **재시도가 서킷의 실패 카운트를 3배로 밀어 넣는** 상호작용이 실측에 그대로 드러납니다. 요청 2~5는 계정계 호출 없이 즉시 거절됐고, 원장에는 `elapsed_ms=0`인 FAILED로 남았습니다(psql 확인). 목업을 다시 띄우고 10초 뒤 호출하면 탐침이 나가 회복합니다. 상태 전이 로그(실제):

```
서킷 'core-banking' CLOSED → OPEN (연속 실패 3회(임계 3))
서킷 'core-banking' OPEN → HALF_OPEN (대기 10000ms 경과 — 탐침 허용)
서킷 'core-banking' HALF_OPEN → CLOSED (탐침 성공 — 계정계 회복 확인)
```

Prometheus에도 같은 사건이 찍힙니다: `gwanmun_circuit_state{circuit="core-banking"} 1.0`(OPEN), `gwanmun_circuit_opened_total 2.0`, `gwanmun_circuit_rejected_total 5.0`, `gwanmun_core_retries_total 2.0`.

데드라인도 숫자로 확인됩니다. 지연 계좌(응답 5초 지연, read 타임아웃 3초) 호출의 총 소요가 **5.02초**로 찍혔습니다. 1차 타임아웃 3초 + 백오프 0.2초 + 2차 시도의 read 타임아웃이 남은 1.8초로 깎인 합입니다. 로그에는 "거래 데드라인(5000ms) 소진 — 재시도를 접습니다"가 남습니다.

##### UNKNOWN 두 건, 서로 다른 운명으로 갈린 해소

지연 계좌(계정계는 처리했고 응답만 유실)와 유실 계좌(계정계가 기록 없이 죽음)로 UNKNOWN을 하나씩 만들고, 각각 `POST /api/gateway/resolve/{tranId}`를 쐈습니다(실제 출력).

```
# (a) 지연 거래 — 상태조회 "처리됨" → 망취소 → CANCELED
{ "before": "UNKNOWN", "processedAtCore": true,
  "statusInquiry": { "coreMessage": "처리된 거래입니다" },
  "netCancel":     { "coreMessage": "취소 완료되었습니다" },
  "after": "CANCELED", "resolutionMethod": "NET_CANCEL" }

# (b) 유실 거래 — 상태조회 "미처리" → 망취소 없이 FAILED 확정
{ "processedAtCore": false,
  "statusInquiry": { "coreMessage": "미처리 거래입니다" },
  "netCancel": null,
  "after": "FAILED", "resolutionMethod": "STATUS_INQUIRY" }
```

원장 DB를 직접 열면(psql 실제 출력) 해소 시각과 방법까지 남아 있습니다.

```
     transaction_id     |  status  | elapsed_ms | resolution_method |                    detail
------------------------+----------+------------+-------------------+-----------------------------------------------
 GWMNU20260709148855031 | CANCELED |       5007 | NET_CANCEL        | 상태조회 처리됨 → 망취소 성공 — CANCELED 확정
 GWMNU20260709148855032 | FAILED   |        206 | STATUS_INQUIRY    | 상태조회 결과 미처리 — FAILED 확정
```

같은 UNKNOWN인데 하나는 CANCELED, 하나는 FAILED입니다. **"모름"의 확정을 조회로 한다**는 이번 편의 문장이 원장 두 줄로 남았습니다.

##### 실측이 준 보너스, 함정 둘을 현장에서 밟다

첫 해소 시도는 500으로 터졌습니다. 원인은 코드에 있지 않았습니다. DB였습니다. 앞서 원장을 만들 때 Hibernate `ddl-auto: update`가 PostgreSQL에 만들어 둔 상태 체크 제약이 3값(SUCCESS/FAILED/UNKNOWN)만 허용해서, CANCELED로의 UPDATE가 `violates check constraint`로 거부된 겁니다. `ddl-auto: update`는 컬럼은 추가해 줘도 **체크 제약은 갱신하지 않습니다.** 수동 ALTER로 제약을 다시 걸어 해결했고, 마이그레이션 도구 없이 enum을 늘리는 비용을 실측으로 배웠습니다.

더 재미있는 건 그다음입니다. 그 500이 터진 시점에 **망취소 전문은 이미 계정계에 나가 있었습니다**. 원장 갱신만 실패했지, 원거래는 취소된 상태였습니다. 해소를 다시 돌리자 상태조회→망취소가 재실행됐는데, 망취소를 멱등(이미 취소된 원거래도 취소 성공)으로 설계해 둔 덕에 안전하게 CANCELED로 수렴했습니다. "해소 절차는 재실행 가능해야 한다"는 설계 노트의 문장을, 계획에 없던 장애가 실전의 생존 조건으로 증명해 줬습니다.

##### 서킷이 열리는 순간과 해소 플로우를 담은 화면

화면에 장애 내성 섹션을 붙였습니다. 캡처 중에 목업 프로세스를 실제로 kill해서 만든 상태입니다. 서킷 칩이 OPEN(빨강, 연속실패 3/3)이고, 오른쪽에는 방금 해소한 거래의 상태조회·망취소 전문 hex와 원장 확정(UNKNOWN → CANCELED)이, 아래에는 연속 호출의 502 → 503×4가 보입니다.

![장애 내성 화면. 서킷 OPEN(빨강)과 상태조회·망취소 해소 플로우, 연속 호출 즉시 거절이 담겨 있다](/uploads/project/gwanmun/resilience-demo.png)

##### 테스트

`./gradlew test`는 **129개 전부 그린**입니다(1·2편과 1부의 104개 + 이번 25개). 서킷 상태 전이(임계 도달 OPEN·즉시 거절·HALF_OPEN 탐침 정원·탐침 성공/실패), **변경성 재시도 금지(재시도 설정이 있어도 호출은 정확히 1회)**, 데드라인이 마지막 시도의 read 타임아웃을 깎는 것, 상태조회/망취소 전문 왕복, HTTP→소켓→원장 전 구간의 UNKNOWN→CANCELED/FAILED 해소까지. 서킷과 실행기는 시계와 sleep을 주입받게 만들어 실제 대기 없이 시간 흐름을 검증합니다.

#### 6. 잔여: 정직하게 안 한 것

- **해소는 수동 트리거만 있습니다.** UNKNOWN을 주기적으로 훑는 대사 배치(스케줄러)는 다음 확장 지점입니다.
- **멱등키가 여전히 없습니다.** 게이트웨이 내부 재시도는 조회성 한정이라 안전하지만, 호출자가 변경성 요청을 재전송하면 새 거래로 봅니다.
- **응답 전문에 거래ID가 없습니다.** 동기 소켓이라 요청-응답 매칭이 자명해 생략했지만, 비동기 채널이면 응답에도 실어야 합니다.
- **서킷은 인스턴스 로컬입니다.** 다중 인스턴스면 각자 따로 열고 닫습니다. JWT/OAuth·HA·중앙 채번도 이전 잔여 그대로이고, 체크 제약 함정에서 확인했듯 마이그레이션 도구(Flyway류)도 확장 지점입니다.

이제 게이트웨이는 계정계가 죽어도 같이 죽지 않고, 모른다고 적은 거래를 계정계에 물어서 확정 지을 줄 압니다. 기록(1부)과 해소(2부)가 맞물리면서, 원장이 비로소 "장애 때 믿고 쓰는 장부"가 됐습니다.

---

## 4. 감사가 찾은 결함과 부하가 드러낸 레이스

*원문 발행일 2025-10-19*

### 1부. 감사가 찾은 것들, 풀 고갈이 서킷을 여는 버그

#### 1. 이번엔 쌓지 않고 뒤집었다

[3편](#3-3값-원장과-손으로-짠-서킷브레이커)까지로 로드맵의 기능은 다 돌았습니다. 전문 코덱, 프레이밍, 필터 체인, 커넥션 풀, 원장, 서킷브레이커, UNKNOWN 해소까지 매 편 실측으로 "돈다"를 증명해 왔습니다. 그래서 이번 편은 방향을 뒤집었습니다. 질문 하나를 들고 **전체 코드 감사**를 돌렸습니다.

> 기능이 도는 것과, 궂은 날에도 옳게 도는 것은 다른 문제다. 트래픽이 폭주하면? 계정계가 쓰레기를 돌려주면? 자정 직후에 재기동하면?

감사는 확정 결함 6건과 보안 구멍 3건을 냈습니다. 그중 최대어가 이 편의 제목인 **내부 커넥션 풀 고갈이 서킷브레이커를 여는 버그**입니다. 계정계는 멀쩡한데, 게이트웨이가 스스로 만든 병목 때문에 멀쩡한 계정계로 가는 길을 끊어 버립니다.

#### 2. RuntimeException 하나가 만든 3중 오작동

앞서 커넥션 풀을 만들 때, 고갈 정책의 예외를 이렇게 선언했습니다.

```java
public class PoolExhaustedException extends RuntimeException {
```

당시엔 자연스러웠습니다. "풀이 가득 차서 거절한다"는 언체크드 예외로 두는 게 관례고, 호출부에 throws를 강제하고 싶지 않았기 때문입니다. 문제는 그 뒤 두 단계에 걸쳐 쌓인 처리 경로들이 전부 **이 타입을 모르는 채로** 설계됐다는 겁니다.

**경로 1. 서킷브레이커가 내부 사정을 백엔드 장애로 계수한다.** 3편의 실행기는 시도 실패를 이렇게 나눴습니다.

```java
} catch (IOException e) {
    breaker.onFailure();          // 계정계 실패 — 서킷에 계수
    last = e;
    if (!kind.retryable()) throw e;
} catch (RuntimeException e) {
    breaker.onFailure();          // ← 풀 고갈도 여기로 들어온다
    throw e;
}
```

`catch (RuntimeException)`은 "예상 못 한 것도 실패는 실패"라는 방어 코드였는데, 풀 고갈이 정확히 이 그물에 걸립니다. 서킷 임계가 3이니 **동시 요청 폭주로 풀 고갈이 3번 연속되면 서킷이 열립니다.** 서킷이 열리면 이후 모든 거래가 계정계 호출 없이 즉시 거절됩니다. 게이트웨이 내부 자원이 잠깐 모자랐다는 이유로 멀쩡한 계정계로 가는 통로를 스스로 차단하는 셈입니다. 서킷의 존재 이유(죽은 백엔드에 매달리지 않기)와 정반대의 오보입니다.

**경로 2. 서비스와 컨트롤러가 이 타입을 모른다.** GatewayService는 `IOException`만, 컨트롤러는 `GatewayException`만 잡습니다. RuntimeException인 풀 고갈은 둘 다 뚫고 스프링 기본 500으로 터집니다. 더 아픈 건 원장입니다. 원장 기록은 catch 블록 안에 있으므로 **관통한 거래는 원장에 한 줄도 남지 않습니다.** 원장을 만든 편에서 "모든 거래는 원장에 남는다"고 못 박았고, `TransactionStatus` 주석에는 "풀 고갈 → FAILED"라고 적어 뒀는데, 그 경로는 실제로는 도달 불가능한 문서였던 겁니다. 주석은 계약을 적었고, 타입은 계약을 어겼습니다.

**경로 3. 재시도 판단도 IOException만 본다.** 조회성 재시도는 `catch (IOException)` 안에서만 작동하니 풀 고갈은 재시도 대상도 아닙니다(이건 결과적으로는 맞는 동작입니다만, "설계돼서 안 하는 것"과 "그물에 안 걸려서 안 되는 것"은 다릅니다).

같은 축의 구멍이 하나 더 있었습니다. **A2. 왕복 성공 "이후"의 실패.** 거래내역 클라이언트는 응답을 받은 뒤 가변 전문을 파싱하고 헤더의 자기설명(건수·전체길이)을 교차검증합니다. 그런데 계정계가 레코드 영역이 잘렸거나 건수 필드에 비숫자가 있는 쓰레기를 주면 `GwanmunParseException`과 `NumberFormatException`이 그대로 관통합니다. 역시 500 + 원장 공백. **계정계가 이상한 응답을 줬다는 사실이야말로 원장에 남아야 하는 사건**인데, 정상 실패보다 더 심한 이상 상황일수록 기록이 안 되는 역설입니다.

감사가 확정한 나머지도 짧게 적습니다.

- **A4.** 풀의 `isValid()`가 로컬 소켓 플래그만 봅니다. 계정계가 FIN을 보내고 죽어도 이쪽 소켓은 멀쩡해 보이고, write는 OS 버퍼에 들어가 "성공"한 뒤 read에서야 EOF가 납니다. 유휴로 오래 논 소켓에 변경성 전문(망취소)이 타면 억울한 UNKNOWN이 됩니다.
- **A5.** 채번기 일련번호가 날짜가 바뀌어도 리셋되지 않습니다. "시드 = 자정 이후 흐른 밀리초 × 10"이라는 재기동 안전의 불변식이, 자정을 넘겨 살아 있는 프로세스에서 깨집니다. 자정 직후 발급분이 어제 저녁 크기의 일련번호를 달고, 같은 날 저녁 자연 시드가 그 구간을 다시 밟으면 충돌합니다. 그리고 그 unique 위반은 비동기 적재의 WARN 로그로 조용히 삼켜집니다.
- **A6.** `String.getBytes(charset)`는 EUC-KR로 표현 못 하는 문자(이모지 등)를 **조용히 '?'로 치환**합니다. 금융 전문에서 데이터가 소리 없이 바뀌는 건 실패보다 나쁩니다.
- **B1/B2/B4.** 기동 로그에 API 키 원문(`map.keySet()`을 그대로 로깅), 실제 계정계 거래를 유발하는 `/api/history`가 무인증·무유량제어(풀을 만든 편의 "데모 편의" 예외가 보안 구멍으로 잔존), 에러 응답 바디에 내부 host:port와 예외 원문·입력 원문 에코.

#### 3. 타입이 계약이다

이 편의 수리는 전부 한 문장으로 수렴합니다. **타입이 계약이다.** 예외 타입은 "무슨 일이 났는가"를 실어 나르는 계약인데, 계약서에 없는 타입이 흐르는 순간 그 위에 쌓은 안전장치(서킷·원장·상태 판정)가 전부 동시에 헛돕니다. 그래서 고치는 방식도 타입 단위로 정했습니다.

**하나. 서킷은 백엔드 실패만 센다.** 풀 고갈은 게이트웨이 내부 사정이지 계정계 장애가 아닙니다. 실행기에 `PoolExhaustedException` 전용 catch를 두어 **계수 없이 타입 그대로** 올립니다. 재시도도 하지 않습니다. 풀이 이미 borrow-timeout만큼 기다렸고, 과부하에서 재시도는 부하 증폭일 뿐이기 때문입니다. 디테일이 하나 있는데, 실행기는 시도 전에 `breaker.acquire()`로 허가를 받습니다. HALF_OPEN에서 허가(탐침 정원 1)를 받아 놓고 풀 고갈로 백엔드까지 가 보지도 못하면? 성공도 실패도 아니므로 정원만 돌려놔야 합니다. 안 돌려놓으면 나가지도 않은 탐침이 정원을 영원히 차지해 **서킷이 영영 안 닫힙니다.** `onAborted()`를 추가했습니다.

**둘. 원장 공백 금지, 3겹으로.** 왕복 이후의 실패(파싱·자기설명 검증)는 전부 클라이언트 예외(`GatewayException`/`HistoryClientException`)로 감싸 컨트롤러의 원장 기록 경로에 태우고, 풀 고갈은 컨트롤러가 타입으로 받아 **원장 FAILED + HTTP 503**(사유: 포화)으로 처리하고, 마지막에 `catch (RuntimeException)` 최후 방어를 둬서 어떤 미분류 예외도 원장에 구멍을 못 내게 했습니다. 3값 판정은 그대로입니다. 풀 고갈은 요청이 계정계로 나가기 전의 실패라 처리됐을 가능성이 0이고, 그래서 FAILED가 맞습니다(UNKNOWN으로 볼 여지가 없습니다).

**셋. 죽은 유휴 소켓은 수명으로 거른다.** `isValid()`를 진짜 생존 검사로 바꾸는 방법(probe 왕복)도 있지만, 검사 자체가 왕복 비용이고 검사와 사용 사이의 틈은 여전히 남습니다. 유휴 TTL(반납 후 N초 지난 연결은 폐기, 기본 30초)이 간단하고 확실합니다. 계정계 keep-alive 정책보다 짧게 잡으면 낡은 소켓이 변경성 전문을 태울 창 자체가 사라집니다.

**넷. 날짜가 바뀌면 재시드.** 채번의 빠른 경로(락 없는 AtomicLong)는 그대로 두고, `next()`가 날짜 전이를 감지했을 때만 synchronized 재시드를 합니다. 그리고 원장 적재 실패(큐 포화·persist 예외)를 `gwanmun.ledger.dropped{reason}` 카운터로 계수했습니다. 삼키는 건 원칙(적재가 거래를 막지 않는다)대로 삼키되, **유실은 보이는 유실**이어야 알람을 걸 수 있습니다.

**다섯. 인코딩은 fail-closed.** `CharsetEncoder` + `CodingErrorAction.REPORT`로 매핑 불가 문자를 예외로 드러내고, NUMERIC 필드의 비숫자도 빌드가 거절합니다. 상대 계정계 파서가 '?'를 어떻게 읽을지에 운명을 맡기지 않습니다.

**여섯. 실거래 유발 경로는 전부 관문 안으로.** `/api/history`를 필터 체인(인증→라우팅→유량제어)에 편입했습니다. 반면 `/api/ledger`·`/api/pool/stats`·`/api/circuit/stats`는 일부러 관문 밖에 남겼습니다. 계정계 호출이 없는 읽기 전용 관측 경로인 데다, 서킷이 열린 상황을 관찰하는 요청이 유량제어에 막히면 관측 자체가 안 되기 때문입니다. 이 판단은 코드 주석과 문서에 명시했습니다(관문 밖 예외는 빠뜨린 실수여서는 안 되고, 내린 결정이어야 하니까).

**일곱. 외부 응답은 일반화, 추적은 correlationId로.** 에러 바디에서 내부 host:port·예외 원문·입력 에코를 걷어내고, 일반화한 사유 + 거래ID + correlationId만 내보냅니다. 상세는 서버 로그와 원장에 있고, correlationId가 그 둘을 잇는 열쇠입니다.

#### 4. 계약을 코드에 다시 박는다

실행기의 실패 분류가 이번 편의 핵심 diff입니다.

```java
} catch (IOException e) {
    breaker.onFailure();              // 계정계 실패 — 서킷에 계수
    last = e;
    if (!kind.retryable()) throw e;
} catch (PoolExhaustedException e) {
    // 내부 풀 고갈 — 백엔드 실패가 아니므로 서킷에 계수하지 않고, 재시도 없이 그대로 올린다.
    // (풀이 이미 borrow-timeout 만큼 기다렸다. 과부하에서의 재시도는 부하 증폭이다.)
    // 받아 둔 허가는 성공/실패 아닌 "미사용"으로 반납한다(HALF_OPEN 탐침 정원 누수 방지).
    breaker.onAborted();
    throw e;
} catch (RuntimeException e) {
    breaker.onFailure();
    throw e;
}
```

컨트롤러는 타입별로 받아 원장부터 적습니다. 문서에만 적혀 있던 FAILED 경로에 풀 고갈이 드디어 코드로 도달합니다.

```java
} catch (PoolExhaustedException e) {
    // (a) 원장에 FAILED (b) 서킷 비계수(실행기가 보장) (c) 503 + 명확한 사유
    ledger.record(new LedgerRecord(transactionId, TX_CODE_BALANCE, accountNo,
            TransactionStatus.FAILED, null, "게이트웨이 내부 커넥션 풀 고갈: " + e.getMessage(), ...));
    return errorBody(HttpStatus.SERVICE_UNAVAILABLE,
            "게이트웨이가 일시적으로 포화 상태입니다. 잠시 후 다시 시도하세요.", ...);
} catch (GatewayException e) {
    ...  // 3값 판정 → 504(UNKNOWN)/503(서킷)/502, 상세는 로그·원장까지만
} catch (RuntimeException e) {
    ...  // 최후 방어 — 어떤 경로로도 원장에 구멍을 내지 않는다
}
```

풀에는 유휴 TTL이 들어갔습니다. 반납 시각을 기억했다가, 빌려줄 때 수명부터 봅니다.

```java
Entry e = idle.pollFirst();
if (e != null) {
    if (idleTtlMs > 0 && (nanoTime.getAsLong() - e.idleSinceNanos) / 1_000_000 > idleTtlMs) {
        // 로컬 플래그로는 멀쩡해 보여도 상대가 이미 닫았을 수 있는 나이든 연결 — 폐기 후 재시도.
        closeQuietly(e.conn);
        total--; destroyedCount++; expiredCount++;
        continue;
    }
    if (e.conn.isValid()) { ... 재사용 ... }
```

코덱은 무음 치환을 거절로 바꿨습니다.

```java
CharsetEncoder encoder = charset.newEncoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT);
try {
    ByteBuffer encoded = encoder.encode(CharBuffer.wrap(value));
    ...
} catch (CharacterCodingException e) {
    throw new GwanmunBuildException("... EUC-KR 로 표현할 수 없는 문자가 있습니다 — '?' 무음 치환 대신 거절합니다.", e);
}
```

그리고 이 모든 것을 검증 가능하게 만들기 위해 목업에 **fault 계좌 2종**을 심었습니다. `7777…`은 정상 응답을 만든 뒤 끝 3byte를 잘라 보냅니다(길이 헤더는 잘린 길이와 일치해 프레이밍은 통과하고, 파싱에서 터집니다). `6666…`은 헤더의 건수 필드에 `X?A`를 심습니다. 코덱의 빌드 검증이 이제 이런 전문을 못 만들므로 바이트를 직접 오염시킨, 진짜 "계정계가 보낸 쓰레기"입니다. 지연 계좌의 대기 시간도 설정(`mock.delay-ms`)으로 빼서 통합 테스트가 짧은 지연으로 풀 고갈을 재현할 수 있게 했습니다.

#### 5. 같은 시나리오, 수정 전과 후

전/후 대비가 이 편의 핵심 증거라서, **수정 전 코드(77c8f62)에서 먼저 재현 출력을 떠 놓고** 고쳤습니다. 시나리오는 동일합니다: 풀 4·borrow 대기 1초, 지연 계좌(응답 5초, read 타임아웃 8초라 풀을 쥔 요청은 반드시 성공하고 계정계는 끝까지 멀쩡합니다)로 **동시 8건**.

##### 수정 전, 500·증발·오보

```
req2/5/7/8 → HTTP 500 {"status":500,"error":"Internal Server Error"}   # 고갈 4건: 스택 관통
req1/3/4/6 → HTTP 200 ledgerStatus=SUCCESS                             # 풀을 쥔 4건

GET /api/circuit/stats
→ "coreBanking": {"state":"OPEN","openedTotal":1, ...}                 # 내부 고갈이 서킷을 열었다

직후 멀쩡한 계좌 호출
→ HTTP 503 "서킷 'core-banking' OPEN — 계정계 호출을 차단하고 즉시 실패합니다"
```

계정계는 한 순간도 안 죽었는데 서킷이 열렸고, 멀쩡한 계좌가 거절당했습니다. 원장은 더 심각합니다(psql 실제 출력).

```
 GWMNU...072 | SUCCESS | 5006 |
 GWMNU...073 | SUCCESS | 5006 |
 GWMNU...074 | SUCCESS | 5006 |
 GWMNU...077 | SUCCESS | 5006 |
 GWMNU...079 | FAILED  |    1 | 계정계(127.0.0.1:9099) 통신 실패: 서킷 'core-banking' ...
(5 rows)
```

8건을 보냈는데 5행입니다. 고갈된 4건, 071·075·076·078이 **장부에서 증발**했습니다. 그리고 079의 detail을 보면 내부 host:port가 그대로 HTTP 응답으로도 나가고 있었습니다(B4).

##### 수정 후, 503·완결·침묵하는 서킷

```
고갈 4건 → HTTP 503
  {"error":"게이트웨이가 일시적으로 포화 상태입니다. 잠시 후 다시 시도하세요.",
   "transactionId":"GWMNU20260709225440806","ledgerStatus":"FAILED","correlationId":"4622f445f95f4439"}
풀을 쥔 4건 → HTTP 200 ledgerStatus=SUCCESS

GET /api/circuit/stats
→ "coreBanking": {"state":"CLOSED","consecutiveFailures":0,"openedTotal":0}

직후 멀쩡한 계좌 호출 → HTTP 200
```

```
 GWMNU...801 | SUCCESS | 5008 |
 GWMNU...802 | SUCCESS | 5008 |
 GWMNU...803 | SUCCESS | 5007 |
 GWMNU...804 | FAILED  | 1008 | 게이트웨이 내부 커넥션 풀 고갈: 커넥션 풀 'core-banking' 고갈...
 GWMNU...805 | SUCCESS | 5007 |
 GWMNU...806 | FAILED  | 1008 | 게이트웨이 내부 커넥션 풀 고갈: ...
 GWMNU...807 | FAILED  | 1007 | 게이트웨이 내부 커넥션 풀 고갈: ...
 GWMNU...808 | FAILED  | 1008 | 게이트웨이 내부 커넥션 풀 고갈: ...
 GWMNU...809 | SUCCESS |    0 |                         ← 직후 멀쩡한 계좌 확인 호출
(9 rows)
```

9행 완결. elapsed_ms=1008이 "borrow 대기 1초 후 거절"이라는 정책까지 숫자로 증언합니다. 성공 4건의 5초와 나란히 놓고 보면, 어느 요청이 풀을 쥐었고 어느 요청이 문 앞에서 돌아갔는지가 원장만으로 재구성됩니다. 3편에서 원장을 만든 이유가 바로 이런 날을 위해서였습니다.

##### fault 계좌, 이상 응답이 드디어 장부에 남는다

```
POST /api/history {"accountNo":"77777777777777"}   # 레코드 영역 비정합
→ HTTP 502 {"error":"계정계 처리에 실패했습니다.","transactionId":"GWMNU...810",
            "ledgerStatus":"FAILED","correlationId":"2f346ce04a79474f"}
```

```
 GWMNU...810 | HI01 | FAILED | 계정계 응답 전문 처리 실패(왕복은 성공, 응답이 스펙과 다름): 레코드 영역(162 byte)이 ...
 GWMNU...811 | HI01 | FAILED | 계정계 응답 전문 처리 실패(왕복은 성공, 응답이 스펙과 다름): For input string: "X?A"
```

외부 응답은 일반화된 한 줄 + correlationId, 원장에는 원인 전문(全文). 정보가 필요한 곳에만 정보가 갑니다.

##### grep으로 끝나는 보안 경화 검증

```
# B1: 기동 로그 (수정 전 → 후)
API 키 2개 로드: [demo-key-fintech-a, demo-key-fintech-b]      # 키 원문 노출
API 키 2개 로드 (클라이언트: [fintech-a, fintech-b])            # grep 'demo-key' → 0건

# B2: /api/history 무인증 (수정 전 200 + 실제 계정계 거래 → 후 401)
→ HTTP 401 {"blocked":true,"status":401,"reason":"인증 실패: X-API-Key 헤더가 없습니다."}

# B4: 400 응답의 입력 에코 (수정 전: 입력='12ab<script>' 그대로 반사 → 후: 규칙만)
→ HTTP 400 {"error":"accountNo 는 숫자 1~14자리여야 합니다."}
```

"설정이 비면 데모 키 자동 활성"은 학습판 편의로 유지하되, INFO 대신 **WARN으로 fail-open임을 못 박게** 바꿨습니다. 편의는 남기더라도 조용히 켜지게 두지는 않습니다.

##### 테스트, 129 → 147

`./gradlew test` **147건 전부 그린**입니다(기존 129 + 회귀 18). 핵심 회귀는 요구사항 그대로 고정했습니다. "동시 N건 슬로우 계좌로 풀 고갈 유발 → 고갈 요청이 FAILED로 원장 기록 + 서킷 CLOSED 유지 + 직후 정상 거래 200"을 HTTP→소켓→원장 전 구간 통합 테스트로 박았습니다. 그 외에 풀 고갈의 서킷 비계수·HALF_OPEN 정원 누수 방지(주입 시계), 유휴 TTL 만료(주입 시계)와 **목업 재기동 후 낡은 소켓 비재사용**(실소켓), 자정 롤오버 재시드(가변 시계로 23:50 발급 → 자정 후 시드 되감김 → 같은 날 저녁 자연 시드와 무충돌), dropped 카운터, 이모지 빌드 거절, fault 계좌 2종. `ApplicationModules.verify()`도 계속 그린입니다.

#### 6. 정직하게 안 한 것

- **A3. 서킷 stale 결과 귀속.** OPEN 전이 직전에 나가 있던 호출의 늦은 onSuccess/onFailure가 새 상태에 섞일 수 있습니다. `acquire()`가 permit 토큰을 발급하고 결과 보고가 토큰을 들고 오게 하는 방식이 답인데, 난이도 대비 실익이 낮아 이번 소탕에서 제외하고 백로그에 남겼습니다.
- **감사 백로그를 문서로 분리했습니다.** 다음에 할 것(CI + k6 부하 실측, A3, IETF Idempotency-Key draft 기반 멱등키, EOD 대사 배치, Boot 3.5+ 업그레이드)과 안 하기로 한 것(JWT 단독 인증·분산 rate limit·HA·MQ, 각각 이유와 함께)을 갈라 ROADMAP에 남겼습니다. "언젠가"라는 말은 백로그가 아니기 때문입니다.

3편까지가 "장애가 나도 무너지지 않는 게이트웨이"였다면, 1부는 "**자기 자신이 만든 예외에도** 무너지지 않는 게이트웨이"입니다. 감사가 가르쳐 준 건 결국 하나였습니다. 안전장치는 계약(타입) 위에 쌓이고, 계약에 없는 타입 하나가 흐르면 서킷도 원장도 판정도 한꺼번에 헛돈다는 것. 그래서 이번 편의 수리는 catch 블록을 고친 것처럼 보이지만, 실은 전부 계약서를 고친 일이었습니다.

### 2부. 부하가 드러낸 서킷 레이스, A3 stale 귀속 수정과 k6 실측

#### 1. 테스트는 로컬에서만 돌고 서킷은 부하 앞에서 미지수였다

1부까지 테스트가 147건 쌓였습니다. 문제는 그게 **제 노트북에서만** 돈다는 것이었습니다. 커밋을 밀어도 아무도 확인하지 않고 공개 레포인데 LICENSE 파일도 없었습니다. 그리고 더 큰 공백이 있었습니다. 이 게이트웨이가 **부하 앞에서 어떻게 되는지** 재 본 적이 한 번도 없었습니다. 지금까지의 실측은 전부 curl 동시 8건 수준이었기 때문입니다.

1부의 감사는 확정 결함 하나를 "난이도 대비 실익이 낮다"며 백로그로 미뤘습니다. **A3. 서킷 stale 결과 귀속.**

> OPEN 전이 직전에 나가 있던 호출의 늦은 onSuccess/onFailure가 새 상태에 섞일 수 있다.

그때는 "실익이 낮다"고 적었는데, 돌이켜 보면 그건 **부하를 걸어 본 적이 없어서 실익을 몰랐던 것**이기도 했습니다. A3는 동시성과 상태 전이가 겹쳐야 드러나는 버그라, curl 몇 방으로는 절대 안 보입니다. 그래서 2부의 순서는 자연스럽게 정해졌습니다. **부하 하네스를 붙이고, 그게 드러낸 A3를 고치고, 다시 잰다.**

#### 2. A3는 왜 부하에서만 보이는가

서킷브레이커의 결과 보고 코드는 3편부터 이렇게 생겼습니다. `onSuccess()`와 `onFailure()`는 **현재 상태만** 봅니다.

```java
public synchronized void onSuccess() {
    if (state == State.HALF_OPEN) {   // 지금 HALF_OPEN이면
        probesInFlight--;
        transition(State.CLOSED, "탐침 성공 — 계정계 회복 확인");
    }
    consecutiveFailures = 0;
}
```

여기 숨은 가정은 "onSuccess를 부르는 호출 = 방금 이 상태에서 나간 호출"입니다. 한산할 땐 참입니다. 하지만 부하가 걸리면 이렇게 어긋납니다.

1. 호출 A가 **CLOSED**에서 허가를 받고 계정계로 나갑니다. 아직 응답이 안 왔습니다.
2. 그 사이 다른 호출들이 줄줄이 실패해 서킷이 **CLOSED → OPEN**으로 전이합니다.
3. 대기가 지나 **OPEN → HALF_OPEN**, 탐침 정원(1)을 진짜 탐침 하나가 차지합니다.
4. **이제서야** 1번의 호출 A가 성공으로 돌아와 `onSuccess()`를 부릅니다.

4번 시점의 `state`는 HALF_OPEN입니다. 그래서 코드는 A의 성공을 **탐침 성공으로 착각**해 `probesInFlight--` 하고 서킷을 닫아 버립니다. 회복을 확인하지도 않았는데 말입니다. 반대로 A가 실패로 돌아오면 `probesInFlight`가 음수가 되고 갓 진입한 HALF_OPEN을 다시 열어, 회복 판단이 통째로 뒤집힙니다. 결과가 **어느 상태 세대에서 나간 호출의 것인지**를 코드가 모르는 게 근본 원인입니다.

한 가지가 더 있었습니다. **버그가 수치를 오염시킵니다.** A3를 안 고친 채 부하를 재면 서킷 관련 숫자가 못 믿을 값이 됩니다. 그래서 순서는 A3 먼저, 측정은 그다음이어야 했습니다.

#### 3. 결과에 세대(generation)를 새긴다

답은 감사가 예고한 대로 **permit 토큰**입니다. `acquire()`는 이제 그냥 통과시키지 않고, "이 호출이 **어느 상태 세대**에서 허가를 받았는가"를 담은 토큰을 발급합니다. 상태가 한 번 전이할 때마다 세대가 오릅니다. 결과 보고는 permit의 세대가 **현재 세대와 같을 때만** 상태에 반영합니다.

```java
public synchronized Permit acquire() throws CircuitOpenException {
    // ... OPEN이면 거절 / 대기 지나면 HALF_OPEN 전이 ...
    if (state == State.HALF_OPEN) {
        if (probesInFlight >= halfOpenMaxProbes) { /* 거절 */ }
        probesInFlight++;
        return new Permit(generation, true);   // 이 탐침의 세대
    }
    return new Permit(generation, false);      // CLOSED 통과의 세대
}

public synchronized void onSuccess(Permit permit) {
    if (isStale(permit)) return;               // 세대가 다르면 무시
    if (state == State.HALF_OPEN) {
        probesInFlight--;
        transition(State.CLOSED, "탐침 성공 — 계정계 회복 확인");
    }
    consecutiveFailures = 0;
}

private void transition(State to, String why) {
    state = to;
    generation++;   // 전이할 때마다 세대를 올려, 이전 세대의 늦은 결과를 stale로 만든다
    log.warn("서킷 '{}' {} → {} ({})", name, from, to, why);
}
```

앞의 시나리오를 다시 밟으면: 호출 A는 CLOSED에서 세대 0의 permit을 받았습니다. 그 뒤 두 번 전이해 세대가 2가 됐습니다. A가 늦게 돌아와 `onSuccess(permit0)`을 부르면 `permit.generation(0) != generation(2)`이므로 **stale이라 무시**됩니다. HALF_OPEN은 오염되지 않고, 진짜 탐침이 회복을 확인할 때까지 열린 채로 남습니다. 무시한 횟수는 `staleResultsTotal`로 세어 지표로 노출합니다(이게 뒤에서 결정적 증거가 됩니다).

한 가지 더 손봤습니다. 실행기가 받은 permit을 **`finally`로 반드시 정산**하게 했습니다. 어떤 분기로도 못 갚고 빠져나가면(예: Error) 탐침 정원이 새기 때문입니다.

```java
CircuitBreaker.Permit permit = breaker.acquire();
boolean settled = false;
try {
    T result = attempt.call(attemptTimeoutMs);
    breaker.onSuccess(permit); settled = true;
    return result;
} catch (IOException e) {
    breaker.onFailure(permit); settled = true;
    // ...
} finally {
    if (!settled) breaker.onAborted(permit);   // Error로 위를 못 탄 허가를 미사용 반납
}
```

세대 하나만 봐도 되는 이유가 깔끔합니다. 세대가 같으면 그 사이 전이가 없었다는 뜻이니, permit이 발급된 상태가 지금 상태와 반드시 같습니다. 그래서 "CLOSED에서 받은 permit인데 지금 HALF_OPEN" 같은 애매한 경우를 따로 다룰 필요가 없습니다. 세대가 다르면 무시, 끝.

#### 4. CI와 부하 하네스, 실측용 프로파일

수리와 함께 하네스를 깔았습니다.

**CI (GitHub Actions).** `.github/workflows/ci.yml`은 push·PR마다 JDK 21에서 `./gradlew test`를 돌립니다. `ApplicationModules.verify()`(모듈 경계 검증)까지 이 테스트 스위트 안에 있어서 한 번의 실행이 단위·통합·모듈 검증을 모두 덮습니다. 로컬에서만 돌던 150건이 이제 원격에서도 강제됩니다. README에 배지를 붙이고, 공개 레포에 빠져 있던 **MIT LICENSE**도 추가했습니다.

**실측용 `loadtest` 프로파일.** 데모용으로 일부러 낮춰 둔 값(풀 4·rate 5)은 부하 앞에서 인위적 병목이 됩니다. 그래서 별도 프로파일로 풀 100, 유량제어 사실상 해제(rate-capacity 200만), 조회성 재시도 0(순수 1회 왕복 처리량), 목업 지연 0으로 둡니다. 이 값들을 문서에 명시해 재현 가능하게 했습니다. **목표는 "N TPS 달성"에 있지 않습니다. 한계 TPS·P95·병목 지점을 드러내는 게 목표**입니다(우아한형제들 성능 글의 피크 역산 관례).

**부하 도구 세 종.**
- (a) `loadtest/gw_balance.js`. k6로 `POST /api/gateway/balance`에 고정 도착률을 걸어 한계·P95 곡선을 그립니다.
- (b) `DirectCoreBenchmark`. **같은 클라이언트 코드(`CoreBankingClient`)로** 목업에 직접 붙어 순수 TCP 왕복만 재는 기준선입니다. 별도 소켓 코드를 새로 짜면 비교가 공정하지 않으니 게이트웨이가 쓰는 그 클라이언트를 그대로 씁니다.
- (c) 죽은 백엔드를 두고 서킷 off/on을 대비하는 k6 실행.

한 가지 못을 박아 둡니다. k6·앱·목업이 **한 머신에서 CPU를 나눠 씁니다.** 그래서 아래 절대 수치는 "결합 시스템의 천장"이지 순수 서버 성능이 아닙니다. 다만 상대 비교(게이트웨이 vs 직접, 서킷 on vs off)는 유효합니다. 지어낼 수 없는 건 지어내지 않습니다.

#### 5. 부하가 드러낸 A3

##### A3, 결정론적으로 갈린다

먼저 회귀 테스트입니다. `CircuitBreakerTest`에 시계와 상태를 주입한 결정론적 재현 3건을 넣었습니다. 세대 가드를 무력화하면(수정 전 동작을 재현) **정확히 A3 두 건만** 빨갛게 뜹니다.

```
CircuitBreakerTest > A3: CLOSED에서 나간 늦은 성공은 HALF_OPEN을 거짓으로 닫지 못한다  FAILED
CircuitBreakerTest > A3: CLOSED에서 나간 늦은 실패는 HALF_OPEN 탐침 정원을 깎거나 서킷을 다시 열지 못한다  FAILED
8 tests completed, 2 failed
```

세대 가드를 되살리면 8건 전부 그린. 수정 전과 후가 이렇게 딱 갈리는 게 좋은 회귀입니다.

##### 그런데 이게 실제로 벌어지긴 하나, staleResultsTotal=197

결정론적 테스트는 "이럴 수 있다"를 증명하지, "실제로 벌어진다"를 증명하진 않습니다. 그건 부하가 증명했습니다. 시나리오 (c)의 서킷 플래핑 부하(죽은 백엔드, HALF_OPEN 탐침이 붙었다 떨어졌다)를 **15초** 돌린 뒤 서킷 상태:

```
GET /api/circuit/stats → coreBanking:
  {"state":"OPEN","openedTotal":2,"rejectedTotal":141268,"staleResultsTotal":197}
```

**staleResultsTotal=197.** stale 결과 보고가 15초에 197번 도착했습니다. 수정 전이라면 이 197건이 전이·탐침 정원에 잘못 섞여 서킷 상태를 오염시켰을 것입니다. A3는 이론상의 레이스로 그칠 일이 아니었습니다. 부하가 걸리면 **초당 열몇 번씩 실제로 일어나는** 일이었습니다. 감사가 "실익이 낮다"고 본 게 틀렸던 셈입니다. 실익이 낮았던 게 아니라 부하를 안 재서 안 보였던 겁니다.

##### (a) 한계 TPS · P95 곡선

정상 백엔드에 도착률을 올려 가며 k6를 반복했습니다.

| 목표 TPS | 달성 req/s | p50 | p95 | 실패율 | dropped |
|---:|---:|---:|---:|---:|---:|
| 500 | 500 | 0.49ms | 0.98ms | 0% | 0 |
| 1,000 | 1,000 | 0.37ms | 0.50ms | 0% | 0 |
| 2,000 | 2,000 | 0.31ms | 0.47ms | 0% | 0 |
| 4,000 | 4,000 | 0.26ms | 0.42ms | 0% | 0 |
| 6,000 | 6,000 | 0.27ms | 0.68ms | 0% | 0 |
| 8,000 | 7,914 | 0.31ms | 4.99ms | 0% | 1,271 |
| 10,000 | 9,986 | 0.31ms | 3.28ms | 0% | 202 |
| 12,000 | 11,922 | 0.42ms | 11.6ms | 0% | 1,169 |
| 15,000 | 14,188 | 3.97ms | 36.4ms | 0% | 12,002 |

무릎은 **~10–12k req/s**입니다. ~6k까지 p95가 1ms 밑을 유지하다가 그 위에서 꺾이고, 12k를 넘기면 k6가 목표 도착률 자체를 못 채웁니다(dropped_iterations 급증). 눈여겨볼 건 **실패율이 전 구간 0%**라는 점입니다. 게이트웨이는 과부하에서 틀린 답을 내지 않고 지연으로 degrade합니다. 원장도, 서킷도 계속 정상입니다.

##### (b) 게이트웨이 경유 오버헤드

같은 클라이언트로 목업에 직접 붙은 기준선과 게이트웨이 경유를 나란히 놓습니다.

```
직접 왕복(1스레드, 20k회):  p50=0.048ms  p95=0.079ms  mean=0.055ms
직접 왕복(16스레드):        39,231 req/s  p50=0.331ms
직접 왕복(50스레드):        44,465 req/s  p50=1.153ms
게이트웨이(비포화, 4k/s):    p50=0.264ms
```

**게이트웨이 경유 오버헤드 ≈ 0.21ms/req**입니다(게이트웨이 p50 0.26ms − 직접 왕복 p50 0.05ms). 이 0.21ms가 HTTP 파싱 + 관문 필터 체인(인증·라우팅·유량제어) + 전문 build + 원장 비동기 적재 + JSON 직렬화의 값입니다. 얇습니다.

더 흥미로운 건 처리량 천장입니다. **순수 커넥터는 ~40–44k req/s를 내는데, REST 게이트웨이 전체 경로는 ~12k req/s에서 막힙니다.** 병목은 TCP 커넥션 풀이 아닙니다. 이 지연대(0.05ms 왕복)에서는 동시 소켓 3개면 1만 TPS를 감당합니다. 진짜 한계는 **웹 계층**입니다. 요청 하나가 서블릿 스레드 하나를 동기 TCP 왕복 동안 통째로 붙잡는 blocking thread-per-request 구조. 이건 다음에 뭘 최적화할지의 실측 근거가 됩니다. 풀을 더 키우는 것으로는 안 되고, 웹 계층을 손대야 한다는 것.

##### (c) 빠른 실패의 값

마지막으로, 서킷이 왜 있는지를 숫자로 봅니다. 도달 불가 백엔드(connect-timeout 300ms 확정)를 두고 서킷 off와 on을 대비했습니다.

```
서킷 OFF (임계 1억 — 안 열림):  351 req/s   p50=8.11s  p95=8.98s  실패 100%
서킷 ON  (임계 3):             9,425 req/s  p50=0.68ms p95=95.9ms  즉시 거절
```

**서킷이 없으면 죽은 백엔드가 게이트웨이를 같이 눕힙니다.** 모든 요청이 300ms connect 타임아웃을 기다리며 서블릿 스레드를 붙잡아, 처리량이 351 req/s로 붕괴하고 지연이 **8초**로 치솟습니다. 요청이 스레드 풀에 쌓이기만 하기 때문입니다.

**서킷이 있으면** 3연속 실패로 열린 뒤 나머지는 계정계 호출 없이 튕겨 냅니다. 처리량은 27배로 뛰고(351 → 9,425 req/s), p50 지연은 8.11초에서 0.68ms로 약 1.2만 배 떨어집니다. 빠른 실패는 **스레드를 죽은 백엔드에 헌납하지 않으려는** 장치입니다. 처리량이 오르는 건 그 부산물입니다. 이 숫자가 3편에서 서킷을 손으로 짠 이유를 뒤늦게 정당화해 줍니다.

##### Boot 3.5 업그레이드, 강행 대신 검증

3.3.x는 OSS 지원이 끝났습니다. Spring Boot **3.3.5 → 3.5.4**, Spring Modulith **1.2.7 → 1.4.3**으로 올렸습니다. 백로그에 "실익 대비 위험 있음"이라 적어 뒀던 항목이라, 깨지면 되돌리고 정직히 남긴다는 전제로 마지막에 시도했습니다.

결과는 **채택**입니다. 유일한 파손은 문서 생성 API 한 줄이었습니다. `Documenter.withOutputFolder(String)` 체이닝이 사라지고 출력 폴더가 생성자의 `Documenter.Options`로 옮겨졌습니다. 적응 후 **150건 전부 그린 + verify() 그린**, 앱 기동·잔액조회·prometheus 노출 모두 정상. 파장이 rabbit hole로 번지지 않고 원포인트 수정으로 끝나서, 강행하지 않고도 채택할 수 있었습니다. 만약 이게 광범위하게 깨졌다면 되돌리고 "무엇 때문에 보류"를 여기 적었을 겁니다.

##### 테스트, 147 → 150

`./gradlew test` **150건 그린**입니다(기존 147 + A3 회귀 3), Boot 3.5.4 위에서. A3 회귀 3건(늦은 성공 무시·늦은 실패 무시·정상 세대 반영)에 더해, 기존 서킷 테스트는 permit 시그니처로 갱신했습니다.

#### 6. 정직하게 안 한 것

- **부하 수치는 단일 머신 결합 천장입니다.** k6·앱·목업이 한 CPU를 나눠 쓴 값이라, 분리된 부하 발생기·전용 서버에서의 절대 성능은 측정하지 않았습니다. 이번 목적은 상대 비교(게이트웨이 vs 직접, 서킷 on vs off)와 병목 규명이었습니다. "금융권 표준 P95" 같은 공개 근거 없는 수치는 지어내지 않습니다.
- **웹 계층이 병목이라는 건 알았지만 안 건드렸습니다.** thread-per-request가 ~12k에서 막힌다는 실측은 나왔지만, 가상 스레드 전환 같은 처방은 다음 문제입니다(그마저도 카카오페이 실측은 "기본 off, I/O 무거운 구간만 선별 적용"이라, 전면 전환은 애초에 답이 아닙니다).
- **멱등키·EOD 대사 배치·DBTower 연계**는 백로그에 그대로 둡니다.

1부가 "자기 자신이 만든 예외에도 무너지지 않는 게이트웨이"였다면, 2부는 그 감사가 **미뤄 둔 버그를 부하로 끄집어낸** 이야기입니다. "실익이 낮다"는 판단은 종종 "아직 안 재 봤다"의 다른 말입니다. staleResultsTotal이 197을 셀 때, 미뤄 둔 게 실은 초당 열몇 번씩 벌어지고 있었다는 걸 알았습니다. 부하 테스트의 값은 결국 그겁니다. **모르던 걸 숫자로 보이게 만드는 것.**

---

## 5. 멱등키와 EOD 대사

*원문 발행일 2025-11-08*

### 1. 재전송을 구분 못 하고, 원장은 대조된 적이 없다

[4편](#4-감사가-찾은-결함과-부하가-드러낸-레이스)까지 원장은 모든 거래를 3값(SUCCESS/FAILED/**UNKNOWN**)으로 적었고 UNKNOWN을 상태조회·망취소로 해소할 수 있었습니다. 하지만 3편부터 4편까지 "잔여"에 계속 적어 둔 두 문장이 있었습니다.

> 멱등키 없음(같은 요청의 재시도를 게이트웨이가 구분하지 못한다).
> 해소는 수동 트리거만(주기 대사 배치는 확장 지점).

이 둘은 같은 뿌리에서 나옵니다. **타임아웃은 실패가 아니라 미확인(UNKNOWN)이다**. 3편의 이 규칙이 옳으려면, 미확인을 받은 호출자가 그 다음에 무엇을 하느냐를 다뤄야 합니다.

호출자는 504(결과 미확인)를 받으면 자연스럽게 같은 요청을 다시 보냅니다. 그런데 게이트웨이 입장에서 그건 **새 거래**입니다. 새 거래고유번호를 채번하고 새 원장 행을 만들고 계정계에 다시 보냅니다. 계정계에서 첫 요청이 이미 처리됐다면, 두 번째는 **이중 거래**입니다. "임의로 FAILED로 적지 않는다"는 규칙이 이중 거래를 막아 주지는 않습니다. 그건 재시도의 방아쇠를 당기지 않을 뿐이고 방아쇠는 호출자 손에 있습니다.

그리고 원장은 여전히 **한 번도 계정계와 대조된 적이 없는 진실**입니다. "우리 원장에 SUCCESS로 적힌 이 거래가 정말 계정계에서 처리됐나? 우리가 UNKNOWN으로 둔 저 거래를 계정계는 처리했나?" 이걸 확인하는 절차가 없었습니다. 실무 조사에서 반복해서 나온 문장이 "대사가 신뢰도를 결정한다, 특히 취소·미확인 건에서"였습니다.

그래서 이번 편의 두 축이 정해졌습니다. **재전송을 게이트웨이가 막고(멱등키), 매일 장부를 대조한다(EOD 대사).**

### 2. 멱등키 동시성은 앱 락으로 못 막고 DB 유니크 제약으로 막는다

관례는 분명합니다. 오픈뱅킹은 중복 거래고유번호를 A0326으로 거절하고 토스페이먼츠는 `Idempotency-Key` 헤더 + 409 규격을 씁니다. 요구는 세 가지입니다.

1. **완료된 요청의 재수신** → 저장된 원응답을 **재실행 없이** 그대로 재반환.
2. **처리 중인 요청의 동시 재요청** → 409.
3. **같은 키에 다른 본문** → 거절(계약 위반).

처음엔 인메모리 맵 + 락으로 짜려다 멈췄습니다. 4편에서 부하가 A3 서킷 레이스를 드러냈던 걸 떠올리면, 인메모리 락은 **단일 노드에서만** 맞습니다. 두 요청이 같은 키로 동시에 들어올 때, 이걸 하나로 묶는 일은 애플리케이션 락으로는 안 됩니다. **DB 유니크 제약**이어야 하고, 그건 노드가 몇 개든 안 깨집니다.

그래서 멱등키를 원장 PG의 테이블 하나로 두고 `(키, 메서드, 경로)`에 유니크 제약을 걸었습니다. 흐름은 begin → (처리) → complete입니다.

```java
public Decision begin(String key, String method, String path, String fingerprint,
        String tranId, Duration ttl) {
    // ... 기존 항목이 있으면 만료 여부·본문 지문으로 판정 ...

    // IN_PROGRESS 선점 — 유니크 제약이 동시 선점을 하나로 만든다.
    try {
        repository.saveAndFlush(new IdempotencyEntry(
                key, method, path, fingerprint, tranId, now, now.plus(ttl)));
        return Decision.proceed();
    } catch (DataIntegrityViolationException race) {
        // 조회~INSERT 사이에 다른 스레드가 같은 키를 선점했다 — 재조회로 판정한다.
        IdempotencyEntry e = repository.findByIdempotencyKeyAndMethodAndPath(key, method, path)
                .orElse(null);
        return e == null ? Decision.proceed() : decide(e, fingerprint);
    }
}
```

INSERT에 먼저 성공한 쪽만 PROCEED를 받습니다. 진 쪽은 `DataIntegrityViolationException`을 잡아 재조회하고 승자의 IN_PROGRESS를 보고 409를 냅니다. 완료된 행이면 저장해 둔 원응답(HTTP 상태 + 본문 JSON)을 그대로 돌려주고 지문이 다르면 422입니다.

한 가지 결정을 더 했습니다. **내부 포화(풀 고갈·서킷 OPEN)의 503은 원응답으로 굳히지 않습니다.** 그건 계정계로 나가지도 못한 일시적 실패라, 같은 멱등키로 재시도할 수 있게 선점을 놓아줍니다(`release`). 반대로 504(결과 미확인)는 저장합니다. 같은 키의 재전송에 "역시 미확인"을 돌려주는 게, 새로 계정계를 두드리는 것보다 옳기 때문입니다.

### 3. 멱등키 실측으로 이중 거래 0

컨트롤러에 배선하고 라이브로 확인했습니다. 같은 키로 잔액조회를 두 번:

```
# CALL 1 (Idempotency-Key: idem-...-live)
HTTP/1.1 200
X-Idempotent-Replay: false
{"transactionId":"GWMNU20260709325692461","ledgerStatus":"SUCCESS", ... "elapsedMs":6}

# CALL 2 (같은 키)
HTTP/1.1 200
X-Idempotent-Replay: true
{"transactionId":"GWMNU20260709325692461","ledgerStatus":"SUCCESS", ... "elapsedMs":6}
```

둘째 응답은 **같은 거래고유번호, 같은 본문**입니다. `elapsedMs=6`까지 똑같습니다. 재실행 없이 첫 요청의 원응답을 그대로 되돌려준 겁니다. 진짜 이중 거래가 안 났는지는 두 곳으로 확인합니다. 계정계(목업) 로그의 "요청 수신"은 이 거래고유번호에 대해 **1회**뿐이고, 원장에도 1행입니다.

```
gwanmun=# SELECT count(*), max(status), max(amount)
          FROM transaction_ledger WHERE transaction_id='GWMNU20260709325692461';
 count | max     |    max
-------+---------+------------
     1 | SUCCESS | 6879445000      ← 재전송이 새 거래를 안 만들었다(이중 거래 0)
```

처리 중 동시 재요청도 봤습니다. 지연 계좌(응답을 늦춰 read 타임아웃을 유발)로 첫 요청이 붙잡힌 사이, 같은 키로 두 번째를 던지면:

```
req1 HTTP 504  {"...","ledgerStatus":"UNKNOWN", ...}                          # 처리 중(지연 계좌)
req2 HTTP 409  {"error":"같은 멱등키의 요청이 처리 중입니다. 잠시 후 결과를 조회하세요."}
```

같은 키에 다른 계좌번호를 실으면 422로 거절됩니다. 멱등키는 "같은 요청"에만 유효한 약속입니다. 아무 요청에나 갖다 붙인다고 통과되지는 않기 때문입니다.

### 4. EOD 대사의 4유형 분류, 그리고 순서 함정

대사는 게이트웨이 원장과 계정계 실제 처리내역을 대조합니다. 그러려면 계정계에서 "그 날 처리한 거래 전부"를 받아 와야 합니다. 목업 계정계에 **당일 처리내역 전체 조회** 가변 전문(0500 요청 → 0510 응답, 레코드 N건)을 하나 추가했습니다. 잔액조회 계정계와 **같은 인메모리 원장을 공유**하는 별도 포트(9097, 길이 프리픽스 프레이밍)로 답하게 해서 이 계정계가 처리·취소한 그대로가 대사 응답에 나옵니다.

대조는 거래고유번호를 열쇠로 네 유형으로 가릅니다.

- **MATCH** 양쪽에 다 있고 금액·상태가 맞는 정상 건.
- **MISMATCH** 양쪽에 다 있지만 금액이나 상태가 어긋난 건.
- **LEDGER_ONLY** 우리 원장에만 있는 건(계정계는 처리 안 했는데 원장은 SUCCESS).
- **CORE_ONLY** 저쪽 계정계에만 있는 건(계정계는 처리했는데 원장은 UNKNOWN이거나 아예 누락).

그리고 대조 **전에** UNKNOWN을 자동 해소합니다. 3편의 해소 절차(상태조회 → 처리됐으면 망취소 → CANCELED, 미처리면 FAILED)를 그대로 돌립니다. 미확인이 남은 채로 대조하면 진짜 불일치인지 "아직 모름"인지가 뒤섞이기 때문입니다.

여기서 실측 중에 순서 함정을 하나 밟았습니다. 처음엔 이렇게 짰습니다.

```
1. 계정계 당일 처리내역 스냅샷을 뜬다
2. 원장의 UNKNOWN을 자동 해소한다(망취소 포함)
3. 스냅샷 vs 원장을 분류한다
```

돌려 보니 방금 CANCELED로 해소한 거래가 "원장 취소 vs 계정계 정상"이라며 MISMATCH로 찍혔습니다. 이유는 명백했습니다. **자동 해소의 망취소는 계정계 기록도 바꿉니다**(정상 → 취소). 그런데 계정계 스냅샷을 2단계 전에 떠 놨으니, 스냅샷 속 그 거래는 아직 "정상"이었던 겁니다. 억울한 불일치입니다.

고치는 방법은 순서를 뒤집는 것뿐입니다. **해소 → 스냅샷 → 분류.** 망취소가 양쪽을 다 바꾼 뒤에 계정계를 봐야, 원장과 계정계가 같은 시점을 봅니다.

```java
// 1) UNKNOWN 자동 해소 — 해소의 망취소는 계정계 기록도 바꾸므로,
//    계정계 스냅샷은 해소 "이후"에 떠야 양쪽이 같은 시점을 본다.
for (LedgerView e : ledger.ofDay(yyyymmdd)) {
    if (e.status() == TransactionStatus.UNKNOWN) tryResolve(e.transactionId());
}
// 2) (해소 반영 후) 계정계 스냅샷 + 4유형 분류
SettlementResult acc = settlementClient.queryDay(yyyymmdd);
```

### 5. 통제된 5건으로 본 EOD 대사 실측

네 유형이 다 나오는지 보려면 불일치를 일부러 심어야 합니다. 원장 PG를 비우고 5건을 만들었습니다.

- 정상 거래 하나(A). MATCH가 될 것.
- 정상 거래 하나(B)를 psql로 원장 금액만 오염 → MISMATCH
- 정상 거래 하나(C)를 psql로 원장 행만 삭제(계정계엔 남음) → CORE_ONLY(누락)
- 지연 계좌 하나(D)는 504 UNKNOWN → 대사가 자동 해소할 것
- 계정계엔 없는 원장 단독 행(E)에 psql로 SUCCESS 삽입 → LEDGER_ONLY

대사를 돌린 결과입니다.

```
POST /api/reconciliation/run?date=20260709  → HTTP 200
counts: {"MATCH":2, "MISMATCH":1, "LEDGER_ONLY":1, "CORE_ONLY":1, "UNKNOWN_RESOLVED":1}

CORE_ONLY   GWMNU...983  ledger=(없음)   core=579344000    :: 계정계 처리 기록만 있고 원장에 없음(누락)
LEDGER_ONLY GWMNU...999  ledger=SUCCESS  core=None         :: 계정계에 처리 기록 없음(원장은 SUCCESS)
MATCH       GWMNU...984  ledger=CANCELED core=7577976000   :: 대사 자동 해소: UNKNOWN → CANCELED(망취소) · 양쪽 취소 일치
MATCH       GWMNU...981  ledger=SUCCESS  core=2338584000   :: 양쪽있음 · 금액 일치
MISMATCH    GWMNU...982  ledger=5958464111  core=5958464000 :: 금액 상이(원장 vs 계정계)
```

지연 계좌 D가 핵심입니다. 그건 대사 전엔 UNKNOWN이었는데(계정계는 처리했지만 게이트웨이가 응답을 못 받음), 대사가 상태조회로 "처리됨"을 확인하고 망취소를 쏴 **CANCELED로 자동 확정**했습니다. 계정계도 취소로 뒤집혀 양쪽이 취소로 일치합니다. 원장과 대사 이력을 psql로 확인합니다.

```
gwanmun=# SELECT transaction_id, status, resolution_method
          FROM transaction_ledger WHERE transaction_id='GWMNU...984';
 GWMNU...984 | CANCELED | NET_CANCEL       ← 대사가 자동 해소

gwanmun=# SELECT settle_date, match_count, mismatch_count,
          ledger_only_count, core_only_count, unknown_resolved_count
          FROM reconciliation_run ORDER BY id DESC LIMIT 1;
 20260709 | 2 | 1 | 1 | 1 | 1
```

대사가 한 번 돌 때마다 이 요약 한 줄이 `reconciliation_run`에 남습니다. "원장이 검증된 진실"임을 매일 이 한 줄로 증명하는 셈입니다. 수동 트리거 외에 마감 시각 스케줄러도 뒀지만 데모에서 예기치 않게 돌지 않게 기본은 비활성(cron="-")입니다.

### 6. DBTower 연계로 원장 PG를 관제 밖에서 본다

마지막 축은 [DBTower](https://github.com/dj258255/dbtower)와의 느슨한 연결입니다. gwanmun은 데이터 경로 **위**에서 전문을 중계하는 인라인 미들웨어이고 DBTower는 데이터 경로 **밖**에서 DB를 관찰하는 아웃오브밴드 관제탑입니다. 성격이 정반대라 별도 저장소로 두되, 원장 PG를 DBTower의 관측 대상으로 등록하는 것만 연결합니다.

왜 원장 PG인가. 부하가 커지면 모든 거래 경로가 지나는 원장 insert에서 경합·슬로우쿼리·락이 생깁니다. 4편의 `gwanmun.ledger.dropped` 카운터는 유실을 세지만 **왜** 느린지는 못 봅니다. 그건 gwanmun 자신이 안에서 못 보는 것(자기 커넥션 지연은 알아도 DB 서버 관점의 경합·플랜은 모름)이고 관제가 밖에서 `pg_stat_statements`로 봅니다.

DBTower 앱 자체를 띄워 등록 API까지 부르지는 않았습니다(관제탑은 자기 컨트롤 플레인 DB가 필요한 별도 스택입니다). 대신 **대상 DB를 실제로 등록 가능한 상태까지 준비하고 관제가 볼 그 수치를 그 계정으로 직접 조회**했습니다. `pg_stat_statements`를 로드하고 DBTower가 쓰는 최소 권한 계정(`pg_read_all_stats`)을 만든 뒤:

```
# 모니터 계정 접속(등록 시 health check와 동일)
$ PGPASSWORD=... psql -U dbtower_monitor -d gwanmun -c "SELECT version();"
  PostgreSQL 16.14 ...                                        # 접속 OK

# 원장 insert 트래픽 후, 모니터 계정으로 pg_stat_statements 조회(=DBTower query-stats가 보는 것)
 calls | mean_ms |                         query
-------+---------+------------------------------------------------------------
     5 |   0.820 | insert into transaction_ledger (account_masked,amount,corr
```

원장 insert가 `pg_stat_statements`에 집계되고 모니터 계정이 그걸 읽습니다. DBTower가 이 PG를 등록하면 그대로 관측할 수치입니다. 등록 body와 구성도, 정직한 경계는 저장소의 [docs/DBTOWER-INTEGRATION.md](https://github.com/dj258255/gwanmun/blob/main/docs/DBTOWER-INTEGRATION.md)에 남겼습니다. gwanmun 코드는 DBTower를 전혀 참조하지 않습니다. 연결은 순전히 운영 구성이고 두 프로젝트의 정체성 경계는 유지됩니다.

### 7. 잔여, 정직하게 안 한 것

- **DBTower 앱 미기동**: 대상 DB 준비 + 관제가 볼 수치를 모니터 계정으로 실측하는 데까지입니다. 등록 API 실호출·대시보드 캡처는 안 했습니다.
- **대사는 잔액조회 중심**: 계정계 시뮬레이터가 잔액만 기록하므로 대조 수치도 잔액입니다. 이체·다계좌 대사는 확장 지점입니다.
- **멱등키 스코프**: `(키+메서드+경로)` + DB 유니크 선점입니다. 다중 노드도 같은 PG를 보면 성립하지만, 채번·대사는 여전히 단일 노드 전제입니다. 스케줄러 cron은 기본 비활성이라 데모는 수동 트리거로 돕니다.

테스트는 **168건**(기존 150 + 이번 편 18)이 그린이고 모듈 경계 `verify()`도 그대로 그린입니다. 각 단계의 함정·판단·검증은 저장소의 [ROADMAP](https://github.com/dj258255/gwanmun/blob/main/docs/ROADMAP.md)·[VERIFICATION](https://github.com/dj258255/gwanmun/blob/main/docs/VERIFICATION.md)에 있습니다.

3편에서 "타임아웃은 실패가 아니라 미확인"이라고 적었을 때, 그 규칙이 온전해지려면 미확인 이후의 세계, 곧 호출자의 재전송과 장부의 대조를 다뤄야 한다는 걸 이번에야 마무리했습니다. 재전송을 막고 매일 장부를 대조합니다.

---
## 6. 정직하게 안 한 것과 그 이유

### 완제품 대신 손으로 짠 것

서킷브레이커를 직접 구현했습니다. Resilience4j를 쓰지 않았습니다. 완제품이 더 견고할 수 있는데도 손으로 짠 이유는 게이트웨이가 장애를 어떻게 격리하는지를 상태 전이 단위로 이해하려는 것이었습니다.

그 선택이 4장에서 값을 했습니다. 직접 짠 서킷이라 A3 같은 미묘한 동시성 결함을 세대 permit으로 파고들 수 있었습니다. `acquire()`가 상태 세대를 담은 permit을 발급하고 결과 보고는 세대가 일치할 때만 상태에 반영합니다. 부하 창에서 이 stale 결과가 15초에 197번 실제로 도착했다는 걸 `staleResultsTotal=197`로 계수했습니다. 완제품을 썼다면 이 층위를 열어 보지 못했을 겁니다.

### 학습판 경계는 정직하게 긋는다

금융결제원 표준 전문을 전수 구현하지는 않았습니다. 대표 거래 몇 종으로 핵심 흐름을 다뤘고, 전문은 평문 로컬 소켓이라 암호화와 전용선을 적용하지 않았으며, 채번과 대사, rate limit은 단일 노드 전제입니다.

부하 수치에도 경계가 있습니다. k6와 앱, 목업이 한 머신에서 CPU를 나눠 쓰므로 무릎 10~12k req/s는 결합 시스템의 천장으로 읽어야지 순수 서버 성능으로 보면 안 됩니다. 그래도 상대 비교인 게이트웨이 경유 대 직접, 서킷 on 대 off는 유효합니다. 금융권 표준 P95 같은 공개 근거 없는 수치는 지어내지 않았습니다.

### 안 넣기로 가른 것들

왜 안 넣었는지 안다는 것, 이게 이 프로젝트의 성격입니다.

JWT와 OAuth 단독 인증은 안 했습니다. 서버 간 게이트웨이 인증은 API 키와 mTLS가 관례이고, 토큰 발급 인프라는 전문과 연계라는 주제와 겹치지 않습니다.

분산 rate limit도 넣지 않았습니다. 인스턴스 로컬 토큰버킷으로 개념은 이미 증명했고 분산화는 저장소 의존만 늘립니다. 실무 답도 로컬 근사에 임계 근처만 외부 저장소로 검증하는 하이브리드입니다.

HA와 이중화, 중앙 채번은 뺐습니다. 실무에서 절체는 L4나 인프라 계층 장치입니다. 앱이 담당하는 부분집합인 graceful shutdown과 재접속은 이미 커버했고, 단일 노드 경계를 코드 주석과 문서에 명시하는 쪽을 택했습니다.

MQ 어댑터도 제외했습니다. 동기 TCP 전문 연계가 주제입니다. 비동기 채널은 응답 전문의 거래ID 매칭 등 전제가 달라져 별개 프로젝트 규모가 됩니다.

가상스레드 전면 전환은 안 했습니다. 무제한 수용은 커넥션 풀 고갈과 pinning을 유발합니다. 실무 실측 결론도 기본은 끄고 I/O 무거운 구간만 상한 걸린 executor로 선별 적용하는 것입니다.

이 판단들이 자의적이지 않도록 실무 실태를 조사해 근거를 댔습니다. 은행과 카드, VAN 연동용 TCP Gateway 구축 후기에서 겪은 문제들이 이 프로젝트의 단계와 그대로 겹칩니다. 동시 세션 제한에는 풀 크기를 계약값에 맞추고, 기관이 커넥션을 임의로 끊으면 헬스체크와 재수립으로 대응하고, 전문이 분할 도착하면 길이 필드로 프레이밍하고, 타임아웃에는 처리결과조회를 걸고, 대사와 재처리를 게이트웨이 부속 기능으로 내장하는 식입니다.

타임아웃 3값 처리도 도메인 공식 관례입니다. 은행 공동망 에러코드 42는 처리결과조회로 거래성립여부를 확인하라고 규정하고 오픈뱅킹도 무응답 시 결과조회 절차를 둡니다. 둘 다 3장의 UNKNOWN과 상태조회 설계와 정확히 일치합니다.


## 7. 커버리지 결산

| 축 | 하는 것 | 위임하거나 범위 밖 |
|---|---|---|
| 프로토콜 변환 | 고정·가변 전문 프레이밍, EUC-KR byte 오프셋 처리, JSON과 전문 양방향 | 표준 전문 전수, 중첩 가변, 바이너리 길이 헤더는 확장 지점 |
| 게이트웨이 방어 | 인증·라우팅·유량제어를 필터 체인으로 직접 | JWT/OAuth 단독, 분산 rate limit은 안 함 |
| 관측성 | 거래ID 채번, 3값 원장, 마스킹, correlation ID, Prometheus 메트릭 | 원장 파티셔닝과 장기 보존 배치 삭제는 잔여 |
| 장애 내성 | 자체 서킷브레이커, 성격별 재시도, 거래 데드라인, 세대 permit | 서킷은 인스턴스 로컬 |
| UNKNOWN 해소 | 상태조회에서 망취소로 가는 멱등 경로, EOD 대사의 자동 해소 | 대사는 잔액조회 중심 |
| 중복 방지 | 멱등키를 DB 유니크 제약으로 원자적 선점 | 멱등키와 채번, 대사 모두 단일 노드 전제 |
| 부하 검증 | k6로 한계 TPS, P95, 게이트웨이 오버헤드, 빠른 실패의 값 | 분리된 부하 발생기와 전용 서버의 절대 성능은 미측정 |

돌아보면 이 프로젝트를 관통한 건 세 문장입니다.

첫째, 차이는 경계 뒤로 보냅니다. 프로토콜과 포맷 차이는 연계층 뒤로, 외부 위협은 게이트웨이층 뒤로, 두 정체성은 별도 저장소로 보냅니다.

둘째, 타임아웃은 모름입니다. 응답을 못 받은 거래는 UNKNOWN이고 확정은 조회로 합니다. 임의로 실패 처리하면 이중 거래가 납니다.

셋째, 신뢰는 궂은 날에 증명됩니다. 계정계를 실제로 죽이고, 풀을 실제로 고갈시키고, 부하를 실제로 걸어 서킷 stale을 계수하기 전까지 된다는 주장은 빚입니다.

재현 가능한 기록은 [GitHub](https://github.com/dj258255/gwanmun)에 있습니다.

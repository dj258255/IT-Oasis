---
title: '감사가 찾은 것들: 풀 고갈이 서킷을 여는 버그 — RuntimeException 하나가 만든 3중 오작동'
titleEn: 'What the Audit Found: the Bug Where Pool Exhaustion Opens the Circuit — a Triple Malfunction from a Single RuntimeException'
description: "6편까지는 기능을 쌓았고, 7편은 방향을 뒤집어 전체 코드 감사를 돌렸습니다. 가장 큰 발견은 풀 고갈의 3중 오작동입니다. PoolExhaustedException이 RuntimeException으로 모든 처리 경로를 관통해서 — 계정계가 멀쩡한데 내부 풀 고갈 3연속이면 서킷이 열리고(오보), 고갈 요청은 500으로 터지며 원장에서 통째로 증발하고, 재시도 경로도 안 탑니다. 같은 축의 두 번째 구멍: 계정계가 쓰레기 응답을 주면 왕복 성공 이후의 파싱 예외가 관통해 역시 500 + 원장 공백. 동일 시나리오(동시 8건 슬로우 계좌)를 수정 전 코드와 수정 후 코드에서 각각 실측해 대비를 남겼습니다 — 수정 전: 500 4건 + 원장 5행(4건 증발) + 서킷 OPEN + 직후 멀쩡한 계좌 503 거절. 수정 후: 503 4건('포화 상태' + 거래ID) + 원장 9행 완결 + 서킷 CLOSED + 직후 멀쩡한 계좌 200. 이 편의 문장은 하나입니다 — 타입이 계약이다. 계약에 없는 타입이 흐르면 모든 안전장치가 동시에 헛돕니다. 유휴 커넥션 TTL(isValid()는 로컬 플래그만 본다), 채번기 자정 재시드, EUC-KR 무음 '?' 치환의 fail-closed 전환, API 키 기동 로그 노출 제거, 무인증 실거래 경로(/api/history) 관문 편입, 에러 응답의 내부 정보 일반화까지 — 감사 확정 결함을 소탕하고 회귀 테스트 18건으로 고정했습니다(129→147). 안 한 것(A3 서킷 stale 귀속)은 백로그에 정직하게 남겼습니다."
descriptionEn: "Stages 1-6 built features; Stage 7 flips direction and runs a full code audit. The biggest find is a triple malfunction on pool exhaustion. PoolExhaustedException, a RuntimeException, pierced every handling path — three consecutive internal exhaustions open the circuit breaker while the core system is perfectly healthy (a false alarm), exhausted requests blow up as 500s and vanish from the ledger entirely, and the retry path never engages. A second hole on the same axis: when the core returns a garbage response, post-roundtrip parse exceptions pierce through for another 500 + ledger gap. I ran the identical scenario (8 concurrent slow-account requests) against the pre-fix and post-fix code — before: four 500s, a 5-row ledger (4 transactions vanished), circuit OPEN, and the next healthy request rejected with 503. After: four 503s with a clear saturation reason and transaction IDs, a complete 9-row ledger, circuit CLOSED, and the next healthy request served 200. The lesson in one line: types are contracts — when an unconsidered type flows, every safety device fails at once. Also fixed: idle-connection TTL (isValid() only checks local flags), transaction-ID reseeding at midnight rollover, fail-closed EUC-KR encoding instead of silent '?' substitution, API keys removed from startup logs, the unauthenticated real-transaction path (/api/history) brought inside the gateway guard, and error responses generalized. 18 regression tests pin it all down (129 to 147). What I didn't do (A3, stale-result attribution in the breaker) is honestly logged in the backlog."
date: 2025-10-04
tags:
  - Java
  - Spring Boot
  - 코드감사
  - 커넥션풀
  - 서킷브레이커
  - 예외설계
category: personal/gwanmun
coverImage: /uploads/project/gwanmun/cover.svg
draft: false
series: "gwanmun"
seriesOrder: 7
---

## 1. 상황 — 이번엔 쌓지 않고 뒤집었다

[6편](/blog/project/gwanmun/gwanmun-6-resilience-netcancel)까지로 로드맵의 기능은 다 돌았습니다. 전문 코덱, 프레이밍, 필터 체인, 커넥션 풀, 원장, 서킷브레이커, UNKNOWN 해소까지 — 매 편 실측으로 "돈다"를 증명해 왔습니다. 그래서 7편은 방향을 뒤집었습니다. 새 기능 대신 **전체 코드 감사**를 돌렸습니다. 질문 하나를 들고요.

> 기능이 도는 것과, 궂은 날에도 옳게 도는 것은 다른 문제다. 트래픽이 폭주하면? 계정계가 쓰레기를 돌려주면? 자정 직후에 재기동하면?

감사는 확정 결함 6건과 보안 구멍 3건을 냈습니다. 그중 최대어가 이 편의 제목입니다 — **내부 커넥션 풀 고갈이 서킷브레이커를 여는 버그.** 계정계는 멀쩡한데, 게이트웨이가 스스로 만든 병목 때문에 멀쩡한 계정계로 가는 길을 끊어 버립니다.

## 2. 함정 — RuntimeException 하나가 만든 3중 오작동

앞서 커넥션 풀을 만들 때, 고갈 정책의 예외를 이렇게 선언했습니다.

```java
public class PoolExhaustedException extends RuntimeException {
```

당시엔 자연스러웠습니다. "풀이 가득 차서 거절한다"는 언체크드 예외로 두는 게 관례고, 호출부에 throws를 강제하고 싶지 않았으니까요. 문제는 그 뒤 두 단계에 걸쳐 쌓인 처리 경로들이 전부 **이 타입을 모르는 채로** 설계됐다는 겁니다.

**경로 1 — 서킷브레이커가 내부 사정을 백엔드 장애로 계수한다.** 앞 편의 실행기는 시도 실패를 이렇게 나눴습니다.

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

`catch (RuntimeException)`은 "예상 못 한 것도 실패는 실패"라는 방어 코드였는데, 풀 고갈이 정확히 이 그물에 걸립니다. 서킷 임계가 3이니 **동시 요청 폭주로 풀 고갈이 3번 연속되면 서킷이 열립니다.** 서킷이 열리면 이후 모든 거래가 계정계 호출 없이 즉시 거절 — 즉, 게이트웨이 내부 자원이 잠깐 모자랐다는 이유로 멀쩡한 계정계로 가는 통로를 스스로 차단합니다. 서킷의 존재 이유(죽은 백엔드에 매달리지 않기)와 정반대의 오보입니다.

**경로 2 — 서비스와 컨트롤러가 이 타입을 모른다.** GatewayService는 `IOException`만, 컨트롤러는 `GatewayException`만 잡습니다. RuntimeException인 풀 고갈은 둘 다 뚫고 스프링 기본 500으로 터집니다. 더 아픈 건 원장입니다 — 원장 기록은 catch 블록 안에 있으므로, **관통한 거래는 원장에 한 줄도 남지 않습니다.** 원장을 만든 편에서 "모든 거래는 원장에 남는다"고 못 박았고, `TransactionStatus` 주석에는 "풀 고갈 → FAILED"라고 적어 뒀는데, 그 경로는 실제로는 도달 불가능한 문서였던 겁니다. 주석은 계약을 적었고, 타입은 계약을 어겼습니다.

**경로 3 — 재시도 판단도 IOException만 본다.** 조회성 재시도는 `catch (IOException)` 안에서만 작동하니 풀 고갈은 재시도 대상도 아닙니다(이건 결과적으로는 맞는 동작입니다만, "설계돼서 안 하는 것"과 "그물에 안 걸려서 안 되는 것"은 다릅니다).

같은 축의 구멍이 하나 더 있었습니다. **A2 — 왕복 성공 "이후"의 실패.** 거래내역 클라이언트는 응답을 받은 뒤 가변 전문을 파싱하고, 헤더의 자기설명(건수·전체길이)을 교차검증합니다. 그런데 계정계가 쓰레기를 주면 — 레코드 영역이 잘렸거나 건수 필드에 비숫자가 있으면 — `GwanmunParseException`과 `NumberFormatException`이 그대로 관통합니다. 역시 500 + 원장 공백. **계정계가 이상한 응답을 줬다는 사실이야말로 원장에 남아야 하는 사건**인데, 정상 실패보다 더 심한 이상 상황일수록 기록이 안 되는 역설입니다.

감사가 확정한 나머지도 짧게 적습니다.

- **A4** — 풀의 `isValid()`가 로컬 소켓 플래그만 봅니다. 계정계가 FIN을 보내고 죽어도 이쪽 소켓은 멀쩡해 보이고, write는 OS 버퍼에 들어가 "성공"한 뒤 read에서야 EOF가 납니다. 유휴로 오래 논 소켓에 변경성 전문(망취소)이 타면 억울한 UNKNOWN이 됩니다.
- **A5** — 채번기 일련번호가 날짜가 바뀌어도 리셋되지 않습니다. "시드 = 자정 이후 흐른 밀리초 × 10"이라는 재기동 안전의 불변식이, 자정을 넘겨 살아 있는 프로세스에서 깨집니다 — 자정 직후 발급분이 어제 저녁 크기의 일련번호를 달고, 같은 날 저녁 자연 시드가 그 구간을 다시 밟으면 충돌. 그리고 그 unique 위반은 비동기 적재의 WARN 로그로 조용히 삼켜집니다.
- **A6** — `String.getBytes(charset)`는 EUC-KR로 표현 못 하는 문자(이모지 등)를 **조용히 '?'로 치환**합니다. 금융 전문에서 데이터가 소리 없이 바뀌는 건 실패보다 나쁩니다.
- **B1/B2/B4** — 기동 로그에 API 키 원문(`map.keySet()`을 그대로 로깅), 실제 계정계 거래를 유발하는 `/api/history`가 무인증·무유량제어(풀을 만든 편의 "데모 편의" 예외가 보안 구멍으로 잔존), 에러 응답 바디에 내부 host:port와 예외 원문·입력 원문 에코.

## 3. 판단 — 타입이 계약이다

이 편의 수리는 전부 한 문장으로 수렴합니다. **타입이 계약이다.** 예외 타입은 "무슨 일이 났는가"를 실어 나르는 계약인데, 계약서에 없는 타입이 흐르는 순간 그 위에 쌓은 안전장치(서킷·원장·상태 판정)가 전부 동시에 헛돕니다. 그래서 고치는 방식도 타입 단위로 정했습니다.

**하나 — 서킷은 백엔드 실패만 센다.** 풀 고갈은 게이트웨이 내부 사정이지 계정계 장애가 아닙니다. 실행기에 `PoolExhaustedException` 전용 catch를 두어 **계수 없이 타입 그대로** 올립니다. 재시도도 하지 않습니다 — 풀이 이미 borrow-timeout만큼 기다렸고, 과부하 상황의 재시도는 부하 증폭일 뿐입니다. 디테일이 하나 있는데, 실행기는 시도 전에 `breaker.acquire()`로 허가를 받습니다. HALF_OPEN에서 허가(탐침 정원 1)를 받아 놓고 풀 고갈로 백엔드까지 가 보지도 못하면? 성공도 실패도 아니므로 정원만 돌려놔야 합니다. 안 돌려놓으면 나가지도 않은 탐침이 정원을 영원히 차지해 **서킷이 영영 안 닫힙니다.** `onAborted()`를 추가했습니다.

**둘 — 원장 공백 금지, 3겹으로.** 왕복 이후의 실패(파싱·자기설명 검증)는 전부 클라이언트 예외(`GatewayException`/`HistoryClientException`)로 감싸 컨트롤러의 원장 기록 경로에 태우고, 풀 고갈은 컨트롤러가 타입으로 받아 **원장 FAILED + HTTP 503**(사유: 포화)으로 처리하고, 마지막에 `catch (RuntimeException)` 최후 방어를 둬서 어떤 미분류 예외도 원장에 구멍을 못 내게 했습니다. 3값 판정은 그대로입니다 — 풀 고갈은 요청이 계정계로 나가기 전의 실패이므로 UNKNOWN이 아니라 FAILED가 맞습니다(처리됐을 가능성이 0).

**셋 — 죽은 유휴 소켓은 수명으로 거른다.** `isValid()`를 진짜 생존 검사로 바꾸는 방법(probe 왕복)도 있지만, 검사 자체가 왕복 비용이고 검사와 사용 사이의 틈은 여전히 남습니다. 유휴 TTL(반납 후 N초 지난 연결은 폐기, 기본 30초)이 간단하고 확실합니다 — 계정계 keep-alive 정책보다 짧게 잡으면 낡은 소켓이 변경성 전문을 태울 창 자체가 사라집니다.

**넷 — 날짜가 바뀌면 재시드.** 채번의 빠른 경로(락 없는 AtomicLong)는 그대로 두고, `next()`가 날짜 전이를 감지했을 때만 synchronized 재시드를 합니다. 그리고 원장 적재 실패(큐 포화·persist 예외)를 `gwanmun.ledger.dropped{reason}` 카운터로 계수했습니다 — 삼키는 건 원칙(적재가 거래를 막지 않는다)대로 삼키되, **유실은 보이는 유실**이어야 알람을 걸 수 있습니다.

**다섯 — 인코딩은 fail-closed.** `CharsetEncoder` + `CodingErrorAction.REPORT`로 매핑 불가 문자를 예외로 드러내고, NUMERIC 필드의 비숫자도 빌드가 거절합니다. 상대 계정계 파서가 '?'를 어떻게 읽을지에 운명을 맡기지 않습니다.

**여섯 — 실거래 유발 경로는 전부 관문 안으로.** `/api/history`를 필터 체인(인증→라우팅→유량제어)에 편입했습니다. 반면 `/api/ledger`·`/api/pool/stats`·`/api/circuit/stats`는 일부러 관문 밖에 남겼습니다 — 계정계 호출이 없는 읽기 전용 관측 경로이고, 서킷이 열린 상황을 관찰하는 요청이 유량제어에 막히면 관측 자체가 안 되기 때문입니다. 이 판단은 코드 주석과 문서에 명시했습니다(예외는 실수가 아니라 결정이어야 하니까).

**일곱 — 외부 응답은 일반화, 추적은 correlationId로.** 에러 바디에서 내부 host:port·예외 원문·입력 에코를 걷어내고, 일반화한 사유 + 거래ID + correlationId만 내보냅니다. 상세는 서버 로그와 원장에 있고, correlationId가 그 둘을 잇는 열쇠입니다.

## 4. 개선 — 계약을 코드에 다시 박는다

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

컨트롤러는 타입별로 받아 원장부터 적습니다. 풀 고갈이 드디어 문서가 아니라 코드로 FAILED에 도달합니다.

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

그리고 이 모든 것을 검증 가능하게 만들기 위해 목업에 **fault 계좌 2종**을 심었습니다. `7777…`은 정상 응답을 만든 뒤 끝 3byte를 잘라 보내고(길이 헤더는 잘린 길이와 일치 — 프레이밍은 통과, 파싱에서 터짐), `6666…`은 헤더의 건수 필드에 `X?A`를 심습니다(코덱의 빌드 검증이 이제 이런 전문을 못 만들므로, 바이트를 직접 오염 — 진짜 "계정계가 보낸 쓰레기"). 지연 계좌의 대기 시간도 설정(`mock.delay-ms`)으로 빼서 통합 테스트가 짧은 지연으로 풀 고갈을 재현할 수 있게 했습니다.

## 5. 실측 — 같은 시나리오, 수정 전과 후

전/후 대비가 이 편의 핵심 증거라서, **수정 전 코드(77c8f62)에서 먼저 재현 출력을 떠 놓고** 고쳤습니다. 시나리오는 동일합니다: 풀 4·borrow 대기 1초, 지연 계좌(응답 5초, read 타임아웃 8초 — 즉 풀을 쥔 요청은 반드시 성공하고 계정계는 끝까지 멀쩡함)로 **동시 8건**.

### 수정 전 — 500, 증발, 오보

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

8건을 보냈는데 5행입니다. 071·075·076·078 — 고갈된 4건이 **장부에서 증발**했습니다. 그리고 079의 detail을 보면 내부 host:port가 그대로 HTTP 응답으로도 나가고 있었습니다(B4).

### 수정 후 — 503, 완결, 침묵하는 서킷

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

9행 완결. elapsed_ms=1008이 "borrow 대기 1초 후 거절"이라는 정책까지 숫자로 증언합니다. 성공 4건의 5초와 나란히 놓고 보면, 어느 요청이 풀을 쥐었고 어느 요청이 문 앞에서 돌아갔는지가 원장만으로 재구성됩니다 — 5편에서 원장을 만든 이유가 이런 날을 위해서였습니다.

### fault 계좌 — 이상 응답이 드디어 장부에 남는다

```
POST /api/history {"accountNo":"77777777777777"}   # 레코드 영역 비정합
→ HTTP 502 {"error":"계정계 처리에 실패했습니다.","transactionId":"GWMNU...810",
            "ledgerStatus":"FAILED","correlationId":"2f346ce04a79474f"}
```

```
 GWMNU...810 | HI01 | FAILED | 계정계 응답 전문 처리 실패(왕복은 성공, 응답이 스펙과 다름): 레코드 영역(162 byte)이 ...
 GWMNU...811 | HI01 | FAILED | 계정계 응답 전문 처리 실패(왕복은 성공, 응답이 스펙과 다름): For input string: "X?A"
```

외부 응답은 일반화된 한 줄 + correlationId, 원장에는 원인 전문(全文) — 정보가 필요한 곳에만 정보가 갑니다.

### 보안 경화 — grep으로 끝나는 검증

```
# B1: 기동 로그 (수정 전 → 후)
API 키 2개 로드: [demo-key-fintech-a, demo-key-fintech-b]      # 키 원문 노출
API 키 2개 로드 (클라이언트: [fintech-a, fintech-b])            # grep 'demo-key' → 0건

# B2: /api/history 무인증 (수정 전 200 + 실제 계정계 거래 → 후 401)
→ HTTP 401 {"blocked":true,"status":401,"reason":"인증 실패: X-API-Key 헤더가 없습니다."}

# B4: 400 응답의 입력 에코 (수정 전: 입력='12ab<script>' 그대로 반사 → 후: 규칙만)
→ HTTP 400 {"error":"accountNo 는 숫자 1~14자리여야 합니다."}
```

"설정이 비면 데모 키 자동 활성"은 학습판 편의로 유지하되, INFO가 아니라 **WARN으로 fail-open임을 못 박게** 바꿨습니다 — 편의는 남기더라도 조용히 켜지게 두지는 않습니다.

### 테스트 — 129 → 147

`./gradlew test` **147건 전부 그린**입니다(기존 129 + 회귀 18). 핵심 회귀는 요구사항 그대로 고정했습니다 — "동시 N건 슬로우 계좌로 풀 고갈 유발 → 고갈 요청이 FAILED로 원장 기록 + 서킷 CLOSED 유지 + 직후 정상 거래 200"을 HTTP→소켓→원장 전 구간 통합 테스트로. 그 외에 풀 고갈의 서킷 비계수·HALF_OPEN 정원 누수 방지(주입 시계), 유휴 TTL 만료(주입 시계)와 **목업 재기동 후 낡은 소켓 비재사용**(실소켓), 자정 롤오버 재시드(가변 시계 — 23:50 발급 → 자정 후 시드 되감김 → 같은 날 저녁 자연 시드와 무충돌), dropped 카운터, 이모지 빌드 거절, fault 계좌 2종. `ApplicationModules.verify()`도 계속 그린입니다.

## 6. 잔여 — 정직하게 안 한 것

- **A3 — 서킷 stale 결과 귀속.** OPEN 전이 직전에 나가 있던 호출의 늦은 onSuccess/onFailure가 새 상태에 섞일 수 있습니다. `acquire()`가 permit 토큰을 발급하고 결과 보고가 토큰을 들고 오게 하는 방식이 답인데, 난이도 대비 실익이 낮아 이번 소탕에서 제외했습니다 — 백로그에 기록.
- **감사 백로그를 문서로 분리했습니다.** 다음에 할 것(CI + k6 부하 실측, A3, 멱등키 — IETF Idempotency-Key draft, EOD 대사 배치, Boot 3.5+ 업그레이드)과 안 하기로 한 것(JWT 단독 인증·분산 rate limit·HA·MQ — 각각 이유와 함께)을 갈라 ROADMAP에 남겼습니다. "언젠가"라는 말은 백로그가 아니니까요.

6편까지가 "장애가 나도 무너지지 않는 게이트웨이"였다면, 7편은 "**자기 자신이 만든 예외에도** 무너지지 않는 게이트웨이"입니다. 감사가 가르쳐 준 건 결국 하나였습니다 — 안전장치는 계약(타입) 위에 쌓이고, 계약에 없는 타입 하나가 흐르면 서킷도 원장도 판정도 한꺼번에 헛돈다는 것. 그래서 이번 편의 수리는 전부 catch 블록이 아니라 계약서를 고친 일이었습니다.

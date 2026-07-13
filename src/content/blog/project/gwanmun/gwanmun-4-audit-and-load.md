---
title: '감사가 찾은 풀 고갈 3중 오작동과 부하가 드러낸 서킷 stale 레이스를 k6 실측으로 잡다'
titleEn: 'Hunting Down the Pool-Exhaustion Triple Malfunction the Audit Found and the Stale Circuit Race the Load Revealed, with k6 Measurements'
description: '1부는 방향을 뒤집어 전체 코드 감사를 돌립니다. 최대 발견은 풀 고갈의 3중 오작동입니다. PoolExhaustedException이 RuntimeException으로 모든 처리 경로를 관통해서, 계정계가 멀쩡한데 내부 풀 고갈 3연속이면 서킷이 열리고(오보), 고갈 요청은 500으로 터지며 원장에서 통째로 증발하고, 재시도 경로도 안 탑니다. 동일 시나리오(동시 8건 슬로우 계좌)를 수정 전과 후로 실측했습니다. 수정 전에는 500이 4건에 원장 5행(4건 증발), 서킷 OPEN, 직후 멀쩡한 계좌까지 503 거절이었고, 수정 후에는 503 4건(''포화 상태'' + 거래ID), 원장 9행 완결, 서킷 CLOSED, 직후 멀쩡한 계좌는 200이었습니다. 유휴 커넥션 TTL, 채번기 자정 재시드, EUC-KR 무음 ''?'' 치환의 fail-closed 전환, API 키 기동 로그 노출 제거 등 확정 결함을 소탕하고 회귀 테스트 18건으로 고정했습니다(129→147). 2부는 감사가 ''난이도 대비 실익이 낮다''며 미룬 A3(서킷 stale 결과 귀속)를 부하가 실증한 이야기입니다. 서킷이 열렸다 닫혔다 하는 15초 부하 창에서 stale 결과 보고가 197번 발생했고(staleResultsTotal=197), acquire()가 상태 세대를 담은 permit 토큰을 발급해 세대가 일치할 때만 상태에 반영하게 고쳤습니다. 그리고 k6로 세 가지를 실측했습니다. 무릎 약 10~12k req/s(6k까지 p95<1ms, 실패율 전 구간 0%), 게이트웨이 경유 오버헤드 약 0.21ms/req(병목은 TCP 풀이 아니라 웹 계층으로, 커넥터 40k vs 전체 경로 12k req/s), 죽은 백엔드에서 서킷 off 351 req/s(p50 8.11s) vs on 9,425 req/s(p50 0.68ms)입니다. CI(GitHub Actions), MIT LICENSE, Spring Boot 3.5.4 업그레이드(150건 그린)까지 함께 소진했습니다.'
descriptionEn: 'Part 1 flips direction and runs a full code audit. The biggest find is a triple malfunction on pool exhaustion. PoolExhaustedException, a RuntimeException, pierced every handling path: three consecutive internal exhaustions open the circuit breaker while the core system is perfectly healthy (a false alarm), exhausted requests blow up as 500s and vanish from the ledger entirely, and the retry path never engages. The identical scenario (8 concurrent slow-account requests) was measured before and after the fix. Before: four 500s, a 5-row ledger (4 transactions vanished), circuit OPEN, and the next healthy request rejected with 503. After: four 503s with a clear saturation reason and transaction IDs, a complete 9-row ledger, circuit CLOSED, and the next healthy request served 200. Idle-connection TTL, transaction-ID reseeding at midnight rollover, fail-closed EUC-KR encoding instead of silent ''?'' substitution, API keys removed from startup logs and more were swept up, pinned by 18 regression tests (129 to 147). Part 2 is the story of load proving the deferred A3 (stale-result attribution in the breaker): in a 15-second window where the circuit flapped open and closed, stale result reports arrived 197 times (staleResultsTotal=197); the fix has acquire() issue a permit token stamped with the state generation, and result reports only affect state when the generation still matches. Three things were measured with k6: a knee at around 10-12k req/s (p95 under 1ms up to 6k, 0% errors throughout), roughly 0.21ms/req gateway-through overhead (the bottleneck is the web layer, not the TCP pool, at connector 40k vs full path 12k req/s), and against a dead backend 351 req/s at 8.11s p50 with the circuit off vs 9,425 req/s at 0.68ms p50 with it on. Also landed: CI on GitHub Actions, an MIT LICENSE, and a Spring Boot 3.5.4 upgrade (150 tests green).'
date: 2025-10-19
tags:
  - Java
  - Spring Boot
  - 코드감사
  - 커넥션풀
  - 서킷브레이커
  - 예외설계
  - 부하테스트
  - k6
  - 동시성
category: personal/gwanmun
coverImage: /uploads/project/gwanmun/cover.svg
draft: false
series: "gwanmun"
seriesOrder: 4
---

## 1부. 감사가 찾은 것들, 풀 고갈이 서킷을 여는 버그

### 1. 이번엔 쌓지 않고 뒤집었다

[3편](/blog/project/gwanmun/gwanmun-3-ledger-and-resilience)까지로 로드맵의 기능은 다 돌았습니다. 전문 코덱, 프레이밍, 필터 체인, 커넥션 풀, 원장, 서킷브레이커, UNKNOWN 해소까지 매 편 실측으로 "돈다"를 증명해 왔습니다. 그래서 이번 편은 방향을 뒤집었습니다. 새 기능 대신 질문 하나를 들고 **전체 코드 감사**를 돌렸습니다.

> 기능이 도는 것과, 궂은 날에도 옳게 도는 것은 다른 문제다. 트래픽이 폭주하면? 계정계가 쓰레기를 돌려주면? 자정 직후에 재기동하면?

감사는 확정 결함 6건과 보안 구멍 3건을 냈습니다. 그중 최대어가 이 편의 제목인 **내부 커넥션 풀 고갈이 서킷브레이커를 여는 버그**입니다. 계정계는 멀쩡한데, 게이트웨이가 스스로 만든 병목 때문에 멀쩡한 계정계로 가는 길을 끊어 버립니다.

### 2. RuntimeException 하나가 만든 3중 오작동

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

### 3. 타입이 계약이다

이 편의 수리는 전부 한 문장으로 수렴합니다. **타입이 계약이다.** 예외 타입은 "무슨 일이 났는가"를 실어 나르는 계약인데, 계약서에 없는 타입이 흐르는 순간 그 위에 쌓은 안전장치(서킷·원장·상태 판정)가 전부 동시에 헛돕니다. 그래서 고치는 방식도 타입 단위로 정했습니다.

**하나. 서킷은 백엔드 실패만 센다.** 풀 고갈은 게이트웨이 내부 사정이지 계정계 장애가 아닙니다. 실행기에 `PoolExhaustedException` 전용 catch를 두어 **계수 없이 타입 그대로** 올립니다. 재시도도 하지 않습니다. 풀이 이미 borrow-timeout만큼 기다렸고, 과부하에서 재시도는 부하 증폭일 뿐이기 때문입니다. 디테일이 하나 있는데, 실행기는 시도 전에 `breaker.acquire()`로 허가를 받습니다. HALF_OPEN에서 허가(탐침 정원 1)를 받아 놓고 풀 고갈로 백엔드까지 가 보지도 못하면? 성공도 실패도 아니므로 정원만 돌려놔야 합니다. 안 돌려놓으면 나가지도 않은 탐침이 정원을 영원히 차지해 **서킷이 영영 안 닫힙니다.** `onAborted()`를 추가했습니다.

**둘. 원장 공백 금지, 3겹으로.** 왕복 이후의 실패(파싱·자기설명 검증)는 전부 클라이언트 예외(`GatewayException`/`HistoryClientException`)로 감싸 컨트롤러의 원장 기록 경로에 태우고, 풀 고갈은 컨트롤러가 타입으로 받아 **원장 FAILED + HTTP 503**(사유: 포화)으로 처리하고, 마지막에 `catch (RuntimeException)` 최후 방어를 둬서 어떤 미분류 예외도 원장에 구멍을 못 내게 했습니다. 3값 판정은 그대로입니다. 풀 고갈은 요청이 계정계로 나가기 전의 실패라 처리됐을 가능성이 0이고, 그래서 FAILED가 맞습니다(UNKNOWN으로 볼 여지가 없습니다).

**셋. 죽은 유휴 소켓은 수명으로 거른다.** `isValid()`를 진짜 생존 검사로 바꾸는 방법(probe 왕복)도 있지만, 검사 자체가 왕복 비용이고 검사와 사용 사이의 틈은 여전히 남습니다. 유휴 TTL(반납 후 N초 지난 연결은 폐기, 기본 30초)이 간단하고 확실합니다. 계정계 keep-alive 정책보다 짧게 잡으면 낡은 소켓이 변경성 전문을 태울 창 자체가 사라집니다.

**넷. 날짜가 바뀌면 재시드.** 채번의 빠른 경로(락 없는 AtomicLong)는 그대로 두고, `next()`가 날짜 전이를 감지했을 때만 synchronized 재시드를 합니다. 그리고 원장 적재 실패(큐 포화·persist 예외)를 `gwanmun.ledger.dropped{reason}` 카운터로 계수했습니다. 삼키는 건 원칙(적재가 거래를 막지 않는다)대로 삼키되, **유실은 보이는 유실**이어야 알람을 걸 수 있습니다.

**다섯. 인코딩은 fail-closed.** `CharsetEncoder` + `CodingErrorAction.REPORT`로 매핑 불가 문자를 예외로 드러내고, NUMERIC 필드의 비숫자도 빌드가 거절합니다. 상대 계정계 파서가 '?'를 어떻게 읽을지에 운명을 맡기지 않습니다.

**여섯. 실거래 유발 경로는 전부 관문 안으로.** `/api/history`를 필터 체인(인증→라우팅→유량제어)에 편입했습니다. 반면 `/api/ledger`·`/api/pool/stats`·`/api/circuit/stats`는 일부러 관문 밖에 남겼습니다. 계정계 호출이 없는 읽기 전용 관측 경로인 데다, 서킷이 열린 상황을 관찰하는 요청이 유량제어에 막히면 관측 자체가 안 되기 때문입니다. 이 판단은 코드 주석과 문서에 명시했습니다(관문 밖 예외는 빠뜨린 실수여서는 안 되고, 내린 결정이어야 하니까).

**일곱. 외부 응답은 일반화, 추적은 correlationId로.** 에러 바디에서 내부 host:port·예외 원문·입력 에코를 걷어내고, 일반화한 사유 + 거래ID + correlationId만 내보냅니다. 상세는 서버 로그와 원장에 있고, correlationId가 그 둘을 잇는 열쇠입니다.

### 4. 계약을 코드에 다시 박는다

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

컨트롤러는 타입별로 받아 원장부터 적습니다. 풀 고갈이 드디어 문서에 그치지 않고 코드로 FAILED에 도달합니다.

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

### 5. 같은 시나리오, 수정 전과 후

전/후 대비가 이 편의 핵심 증거라서, **수정 전 코드(77c8f62)에서 먼저 재현 출력을 떠 놓고** 고쳤습니다. 시나리오는 동일합니다: 풀 4·borrow 대기 1초, 지연 계좌(응답 5초, read 타임아웃 8초라 풀을 쥔 요청은 반드시 성공하고 계정계는 끝까지 멀쩡합니다)로 **동시 8건**.

#### 수정 전, 500·증발·오보

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

#### 수정 후, 503·완결·침묵하는 서킷

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

#### fault 계좌, 이상 응답이 드디어 장부에 남는다

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

#### grep으로 끝나는 보안 경화 검증

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

#### 테스트, 129 → 147

`./gradlew test` **147건 전부 그린**입니다(기존 129 + 회귀 18). 핵심 회귀는 요구사항 그대로 고정했습니다. "동시 N건 슬로우 계좌로 풀 고갈 유발 → 고갈 요청이 FAILED로 원장 기록 + 서킷 CLOSED 유지 + 직후 정상 거래 200"을 HTTP→소켓→원장 전 구간 통합 테스트로 박았습니다. 그 외에 풀 고갈의 서킷 비계수·HALF_OPEN 정원 누수 방지(주입 시계), 유휴 TTL 만료(주입 시계)와 **목업 재기동 후 낡은 소켓 비재사용**(실소켓), 자정 롤오버 재시드(가변 시계로 23:50 발급 → 자정 후 시드 되감김 → 같은 날 저녁 자연 시드와 무충돌), dropped 카운터, 이모지 빌드 거절, fault 계좌 2종. `ApplicationModules.verify()`도 계속 그린입니다.

### 6. 정직하게 안 한 것

- **A3. 서킷 stale 결과 귀속.** OPEN 전이 직전에 나가 있던 호출의 늦은 onSuccess/onFailure가 새 상태에 섞일 수 있습니다. `acquire()`가 permit 토큰을 발급하고 결과 보고가 토큰을 들고 오게 하는 방식이 답인데, 난이도 대비 실익이 낮아 이번 소탕에서 제외하고 백로그에 남겼습니다.
- **감사 백로그를 문서로 분리했습니다.** 다음에 할 것(CI + k6 부하 실측, A3, IETF Idempotency-Key draft 기반 멱등키, EOD 대사 배치, Boot 3.5+ 업그레이드)과 안 하기로 한 것(JWT 단독 인증·분산 rate limit·HA·MQ, 각각 이유와 함께)을 갈라 ROADMAP에 남겼습니다. "언젠가"라는 말은 백로그가 아니기 때문입니다.

3편까지가 "장애가 나도 무너지지 않는 게이트웨이"였다면, 1부는 "**자기 자신이 만든 예외에도** 무너지지 않는 게이트웨이"입니다. 감사가 가르쳐 준 건 결국 하나였습니다. 안전장치는 계약(타입) 위에 쌓이고, 계약에 없는 타입 하나가 흐르면 서킷도 원장도 판정도 한꺼번에 헛돈다는 것. 그래서 이번 편의 수리는 catch 블록을 고친 것처럼 보이지만, 실은 전부 계약서를 고친 일이었습니다.

## 2부. 부하가 드러낸 서킷 레이스, A3 stale 귀속 수정과 k6 실측

### 1. 테스트는 로컬에서만 돌고 서킷은 부하 앞에서 미지수였다

1부까지 테스트가 147건 쌓였습니다. 문제는 그게 **제 노트북에서만** 돈다는 것이었습니다. 커밋을 밀어도 아무도 확인하지 않고 공개 레포인데 LICENSE 파일도 없었습니다. 그리고 더 큰 공백이 있었습니다. 이 게이트웨이가 **부하 앞에서 어떻게 되는지** 재 본 적이 한 번도 없었습니다. 지금까지의 실측은 전부 curl 동시 8건 수준이었기 때문입니다.

1부의 감사는 확정 결함 하나를 "난이도 대비 실익이 낮다"며 백로그로 미뤘습니다. **A3. 서킷 stale 결과 귀속.**

> OPEN 전이 직전에 나가 있던 호출의 늦은 onSuccess/onFailure가 새 상태에 섞일 수 있다.

그때는 "실익이 낮다"고 적었는데, 돌이켜 보면 그건 **부하를 걸어 본 적이 없어서 실익을 몰랐던 것**이기도 했습니다. A3는 동시성과 상태 전이가 겹쳐야 드러나는 버그라, curl 몇 방으로는 절대 안 보입니다. 그래서 2부의 순서는 자연스럽게 정해졌습니다. **부하 하네스를 붙이고, 그게 드러낸 A3를 고치고, 다시 잰다.**

### 2. A3는 왜 부하에서만 보이는가

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

### 3. 결과에 세대(generation)를 새긴다

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

### 4. CI와 부하 하네스, 실측용 프로파일

수리와 함께 하네스를 깔았습니다.

**CI (GitHub Actions).** `.github/workflows/ci.yml`은 push·PR마다 JDK 21에서 `./gradlew test`를 돌립니다. `ApplicationModules.verify()`(모듈 경계 검증)까지 이 테스트 스위트 안에 있어서 한 번의 실행이 단위·통합·모듈 검증을 모두 덮습니다. 로컬에서만 돌던 150건이 이제 원격에서도 강제됩니다. README에 배지를 붙이고, 공개 레포에 빠져 있던 **MIT LICENSE**도 추가했습니다.

**실측용 `loadtest` 프로파일.** 데모용으로 일부러 낮춰 둔 값(풀 4·rate 5)은 부하 앞에서 인위적 병목이 됩니다. 그래서 별도 프로파일로 풀 100, 유량제어 사실상 해제(rate-capacity 200만), 조회성 재시도 0(순수 1회 왕복 처리량), 목업 지연 0으로 둡니다. 이 값들을 문서에 명시해 재현 가능하게 했습니다. **목표는 "N TPS 달성"에 있지 않습니다. 한계 TPS·P95·병목 지점을 드러내는 게 목표**입니다(우아한형제들 성능 글의 피크 역산 관례).

**부하 도구 세 종.**
- (a) `loadtest/gw_balance.js`. k6로 `POST /api/gateway/balance`에 고정 도착률을 걸어 한계·P95 곡선을 그립니다.
- (b) `DirectCoreBenchmark`. **같은 클라이언트 코드(`CoreBankingClient`)로** 목업에 직접 붙어 순수 TCP 왕복만 재는 기준선입니다. 별도 소켓 코드를 새로 짜면 비교가 공정하지 않으니 게이트웨이가 쓰는 그 클라이언트를 그대로 씁니다.
- (c) 죽은 백엔드를 두고 서킷 off/on을 대비하는 k6 실행.

한 가지 못을 박아 둡니다. k6·앱·목업이 **한 머신에서 CPU를 나눠 씁니다.** 그래서 아래 절대 수치는 "결합 시스템의 천장"이지 순수 서버 성능이 아닙니다. 다만 상대 비교(게이트웨이 vs 직접, 서킷 on vs off)는 유효합니다. 지어낼 수 없는 건 지어내지 않습니다.

### 5. 부하가 드러낸 A3

#### A3, 결정론적으로 갈린다

먼저 회귀 테스트입니다. `CircuitBreakerTest`에 시계와 상태를 주입한 결정론적 재현 3건을 넣었습니다. 세대 가드를 무력화하면(수정 전 동작을 재현) **정확히 A3 두 건만** 빨갛게 뜹니다.

```
CircuitBreakerTest > A3: CLOSED에서 나간 늦은 성공은 HALF_OPEN을 거짓으로 닫지 못한다  FAILED
CircuitBreakerTest > A3: CLOSED에서 나간 늦은 실패는 HALF_OPEN 탐침 정원을 깎거나 서킷을 다시 열지 못한다  FAILED
8 tests completed, 2 failed
```

세대 가드를 되살리면 8건 전부 그린. 수정 전과 후가 이렇게 딱 갈리는 게 좋은 회귀입니다.

#### 그런데 이게 실제로 벌어지긴 하나, staleResultsTotal=197

결정론적 테스트는 "이럴 수 있다"를 증명하지, "실제로 벌어진다"를 증명하진 않습니다. 그건 부하가 증명했습니다. 시나리오 (c)의 서킷 플래핑 부하(죽은 백엔드, HALF_OPEN 탐침이 붙었다 떨어졌다)를 **15초** 돌린 뒤 서킷 상태:

```
GET /api/circuit/stats → coreBanking:
  {"state":"OPEN","openedTotal":2,"rejectedTotal":141268,"staleResultsTotal":197}
```

**staleResultsTotal=197.** stale 결과 보고가 15초에 197번 도착했습니다. 수정 전이라면 이 197건이 전이·탐침 정원에 잘못 섞여 서킷 상태를 오염시켰을 것입니다. A3는 이론상의 레이스로 그칠 일이 아니었습니다. 부하가 걸리면 **초당 열몇 번씩 실제로 일어나는** 일이었습니다. 감사가 "실익이 낮다"고 본 게 틀렸던 셈입니다. 실익이 낮았던 게 아니라 부하를 안 재서 안 보였던 겁니다.

#### (a) 한계 TPS · P95 곡선

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

#### (b) 게이트웨이 경유 오버헤드

같은 클라이언트로 목업에 직접 붙은 기준선과 게이트웨이 경유를 나란히 놓습니다.

```
직접 왕복(1스레드, 20k회):  p50=0.048ms  p95=0.079ms  mean=0.055ms
직접 왕복(16스레드):        39,231 req/s  p50=0.331ms
직접 왕복(50스레드):        44,465 req/s  p50=1.153ms
게이트웨이(비포화, 4k/s):    p50=0.264ms
```

**게이트웨이 경유 오버헤드 ≈ 0.21ms/req**입니다(게이트웨이 p50 0.26ms − 직접 왕복 p50 0.05ms). 이 0.21ms가 HTTP 파싱 + 관문 필터 체인(인증·라우팅·유량제어) + 전문 build + 원장 비동기 적재 + JSON 직렬화의 값입니다. 얇습니다.

더 흥미로운 건 처리량 천장입니다. **순수 커넥터는 ~40–44k req/s를 내는데, REST 게이트웨이 전체 경로는 ~12k req/s에서 막힙니다.** 병목은 TCP 커넥션 풀이 아닙니다. 이 지연대(0.05ms 왕복)에서는 동시 소켓 3개면 1만 TPS를 감당합니다. 진짜 한계는 **웹 계층**입니다. 요청 하나가 서블릿 스레드 하나를 동기 TCP 왕복 동안 통째로 붙잡는 blocking thread-per-request 구조. 이건 다음에 뭘 최적화할지의 실측 근거가 됩니다. 풀을 더 키우는 것으로는 안 되고, 웹 계층을 손대야 한다는 것.

#### (c) 빠른 실패의 값

마지막으로, 서킷이 왜 있는지를 숫자로 봅니다. 도달 불가 백엔드(connect-timeout 300ms 확정)를 두고 서킷 off와 on을 대비했습니다.

```
서킷 OFF (임계 1억 — 안 열림):  351 req/s   p50=8.11s  p95=8.98s  실패 100%
서킷 ON  (임계 3):             9,425 req/s  p50=0.68ms p95=95.9ms  즉시 거절
```

**서킷이 없으면 죽은 백엔드가 게이트웨이를 같이 눕힙니다.** 모든 요청이 300ms connect 타임아웃을 기다리며 서블릿 스레드를 붙잡아, 처리량이 351 req/s로 붕괴하고 지연이 **8초**로 치솟습니다. 요청이 스레드 풀에 쌓이기만 하기 때문입니다.

**서킷이 있으면** 3연속 실패로 열린 뒤 나머지는 계정계 호출 없이 튕겨 냅니다. 처리량은 27배로 뛰고(351 → 9,425 req/s), p50 지연은 8.11초에서 0.68ms로 약 1.2만 배 떨어집니다. 빠른 실패는 **스레드를 죽은 백엔드에 헌납하지 않으려는** 장치입니다. 처리량이 오르는 건 그 부산물입니다. 이 숫자가 3편에서 서킷을 손으로 짠 이유를 뒤늦게 정당화해 줍니다.

#### Boot 3.5 업그레이드, 강행 대신 검증

3.3.x는 OSS 지원이 끝났습니다. Spring Boot **3.3.5 → 3.5.4**, Spring Modulith **1.2.7 → 1.4.3**으로 올렸습니다. 백로그에 "실익 대비 위험 있음"이라 적어 뒀던 항목이라, 깨지면 되돌리고 정직히 남긴다는 전제로 마지막에 시도했습니다.

결과는 **채택**입니다. 유일한 파손은 문서 생성 API 한 줄이었습니다. `Documenter.withOutputFolder(String)` 체이닝이 사라지고 출력 폴더가 생성자의 `Documenter.Options`로 옮겨졌습니다. 적응 후 **150건 전부 그린 + verify() 그린**, 앱 기동·잔액조회·prometheus 노출 모두 정상. 파장이 rabbit hole로 번지지 않고 원포인트 수정으로 끝나서, 강행하지 않고도 채택할 수 있었습니다. 만약 이게 광범위하게 깨졌다면 되돌리고 "무엇 때문에 보류"를 여기 적었을 겁니다.

#### 테스트, 147 → 150

`./gradlew test` **150건 그린**입니다(기존 147 + A3 회귀 3), Boot 3.5.4 위에서. A3 회귀 3건(늦은 성공 무시·늦은 실패 무시·정상 세대 반영)에 더해, 기존 서킷 테스트는 permit 시그니처로 갱신했습니다.

### 6. 정직하게 안 한 것

- **부하 수치는 단일 머신 결합 천장입니다.** k6·앱·목업이 한 CPU를 나눠 쓴 값이라, 분리된 부하 발생기·전용 서버에서의 절대 성능은 측정하지 않았습니다. 이번 목적은 상대 비교(게이트웨이 vs 직접, 서킷 on vs off)와 병목 규명이었습니다. "금융권 표준 P95" 같은 공개 근거 없는 수치는 지어내지 않습니다.
- **웹 계층이 병목이라는 건 알았지만 안 건드렸습니다.** thread-per-request가 ~12k에서 막힌다는 실측은 나왔지만, 가상 스레드 전환 같은 처방은 다음 문제입니다(그마저도 카카오페이 실측은 "기본 off, I/O 무거운 구간만 선별 적용"이라, 전면 전환은 애초에 답이 아닙니다).
- **멱등키·EOD 대사 배치·DBTower 연계**는 백로그에 그대로 둡니다.

1부가 "자기 자신이 만든 예외에도 무너지지 않는 게이트웨이"였다면, 2부는 그 감사가 **미뤄 둔 버그를 부하로 끄집어낸** 이야기입니다. "실익이 낮다"는 판단은 종종 "아직 안 재 봤다"의 다른 말입니다. staleResultsTotal이 197을 셀 때, 미뤄 둔 게 실은 초당 열몇 번씩 벌어지고 있었다는 걸 알았습니다. 부하 테스트의 값은 결국 그겁니다. **모르던 걸 숫자로 보이게 만드는 것.**

---
title: '계정계가 죽으면 게이트웨이도 죽는다 — 손으로 짠 서킷브레이커, 그리고 망취소로 UNKNOWN 확정 짓기'
titleEn: 'When the Core Dies, the Gateway Dies With It — a Hand-Rolled Circuit Breaker, and Settling UNKNOWNs with Net Cancellation'
description: "5편의 원장은 응답을 못 받은 거래를 UNKNOWN으로 기록까지만 했습니다. 6편은 남은 폭탄 둘을 처리합니다. 첫째, 장애 전파 — 계정계가 죽으면 모든 호출이 타임아웃까지 스레드를 붙잡아 게이트웨이가 같이 눕습니다. 서킷브레이커를 직접 구현해(CLOSED→OPEN→HALF_OPEN) 연속 실패 임계에서 통로를 끊고, 조회성 거래만 지수 백오프로 제한 재시도하며(변경성 재시도는 이중 거래라 코드가 0회를 강제), 소켓 read 타임아웃과 별개의 거래 단위 데드라인이 마지막 재시도의 read 제한까지 깎습니다. 둘째, UNKNOWN 해소 — 응답을 못 받은 거래는 '모름'이고 확정은 조회로 합니다. 원거래 전문에 거래고유번호를 실어(30→52byte) 계정계와 공통 열쇠를 쥐고, 거래상태조회 전문으로 '처리됨/미처리'를 확인해 처리됐으면 망취소 전문으로 무효화(CANCELED), 미처리면 그제야 FAILED로 확정합니다. 계정계 프로세스를 실제로 죽여 서킷이 열리고(503 즉시 거절, 원장 elapsed_ms=0) 재기동 후 탐침으로 닫히는 전 과정과, 해소 두 경로가 PostgreSQL 원장에 남는 것까지 실측했습니다. ddl-auto:update가 체크 제약을 갱신하지 않아 CANCELED UPDATE가 거부된 함정과, 그 실패 순간 이미 나간 망취소를 멱등성이 구해 준 이야기도 정직하게 적었습니다."
descriptionEn: "Phase 5's ledger only recorded unanswered transactions as UNKNOWN. Phase 6 defuses the two remaining bombs. First, failure propagation: when the core system dies, every call holds a thread until timeout and the gateway collapses with it. I hand-rolled a circuit breaker (CLOSED→OPEN→HALF_OPEN) that cuts the path at a consecutive-failure threshold, retry only inquiry-type transactions with exponential backoff (retrying mutations means double execution, so the code forces zero), and added a per-transaction deadline separate from the socket read timeout that even trims the last retry's read limit. Second, UNKNOWN resolution: an unanswered transaction is 'unknown' and only an inquiry can settle it. The original message now carries the transaction ID (30→52 bytes) so both sides share a key; a status-inquiry message asks the core 'did you process this?' — if processed, a net-cancel message voids it (CANCELED); if not, only then is it FAILED. I actually killed the mock core process to watch the circuit open (immediate 503 rejections, elapsed_ms=0 in the ledger) and close again via a half-open probe, and verified both resolution paths land in the PostgreSQL ledger. Also honestly documented: ddl-auto:update doesn't refresh check constraints (the CANCELED update was rejected), and how net-cancel idempotency saved the day when that failure struck after the cancel had already gone out."
date: 2026-07-09
tags:
  - Java
  - Spring Boot
  - 서킷브레이커
  - 망취소
  - 장애내성
  - Spring Modulith
category: personal/gwanmun
coverImage: /uploads/project/gwanmun/cover.svg
draft: false
series: "gwanmun"
seriesOrder: 6
---

## 1. 상황 — 폭탄이 둘 남아 있다

[5편](/blog/project/gwanmun/gwanmun-5-transaction-ledger)으로 게이트웨이가 기억을 갖게 됐습니다. 모든 거래에 거래고유번호가 붙고, 결과가 3값 상태(SUCCESS/FAILED/UNKNOWN)로 원장에 남습니다. 그런데 그 원장을 보다 보면 두 가지가 눈에 밟힙니다.

**첫째, 계정계가 느려지면 게이트웨이가 같이 죽습니다.** read 타임아웃이 3초라는 말은, 계정계가 죽어 있으면 요청 하나가 3초씩 스레드를 붙잡는다는 뜻입니다. 트래픽이 계속 들어오면 톰캣 스레드가 전부 "죽은 계정계 기다리기"에 묶이고, 계정계 장애가 게이트웨이 장애로 번집니다. 중계자가 백엔드와 운명을 같이하면 중계자를 둔 의미가 없습니다.

**둘째, UNKNOWN이 기록만 되고 방치돼 있습니다.** 5편에서 "타임아웃은 실패가 아니다, 모른다고 적는다"까지 갔지만, 모른다고 적힌 거래는 그 뒤로 아무도 안 건드립니다. 실무라면 이 거래들이 대사(對査) 리스트에 올라 "계정계에서 처리됐는지" 확인되고, 처리됐으면 취소(망취소)로 무효화되거나 확정돼야 합니다. 기록은 해소를 위한 준비일 뿐, 기록 자체가 목적이 아닙니다.

이번 편의 목표는 이 둘입니다.

> 하나, 계정계 장애가 게이트웨이를 무너뜨리지 못하게 한다(서킷브레이커·재시도·데드라인). 둘, UNKNOWN을 해소한다(거래상태조회·망취소).

## 2. 함정 — 재시도는 양날이고, 타임아웃은 한 겹이 아니다

### 함정 하나 — 변경성 거래를 재시도하면 이중 거래다

"실패하면 다시 보내자"는 직관적입니다. 그런데 5편에서 확인했듯, 타임아웃은 실패가 아니라 미확인입니다. 계정계는 처리를 끝냈는데 응답만 늦은 것일 수 있습니다. 그 상태에서 재전송하면 같은 거래가 두 번 실행됩니다. 잔액조회면 무해하지만 이체나 취소라면 사고입니다.

그래서 재시도 허용 여부는 설정 옵션이 아니라 **거래의 성격**에 못 박아야 합니다. 조회성(잔액조회·거래내역·상태조회)은 몇 번을 다시 보내도 계정계 상태가 안 변하니 재시도해도 안전합니다. 변경성(이체·망취소)은 재시도 금지 — 응답을 못 받으면 UNKNOWN으로 남기고, 해소 절차로 넘깁니다.

### 함정 둘 — 소켓 read 타임아웃은 "호출 한 번"의 제한일 뿐이다

재시도를 붙이는 순간 시간 계산이 달라집니다. read 타임아웃 3초에 재시도 2회면, 거래 하나가 최악의 경우 3초 × 3회 + 백오프로 10초 가까이 늘어집니다. 호출자는 그만큼 기다려 주지 않습니다. 그래서 "호출 한 번"의 제한과 별개로 **"거래 전체"의 데드라인**이 필요합니다. 그리고 데드라인은 새 시도의 출발선만 막아서는 부족합니다 — 남은 시간이 1.8초인데 마지막 시도가 read 타임아웃 3초를 다 쓰면 데드라인이 뚫립니다. 매 시도의 read 제한 자체를 남은 시간으로 깎아야 합니다.

### 함정 셋 — HALF_OPEN은 동시성 함정이다

서킷브레이커의 상태 전이 중 제일 미묘한 곳이 HALF_OPEN입니다. OPEN 대기가 끝났다고 통로를 활짝 열면, 회복 중이던 백엔드에 밀린 트래픽이 한꺼번에 쏟아져 다시 눕습니다. 탐침(probe)을 제한된 수만 내보내고, 탐침이 나가 있는 동안의 다른 호출은 즉시 거절해야 합니다. 여러 스레드가 동시에 "대기 끝났네, 내가 탐침"이라며 뚫고 나가지 못하게 상태 전이와 탐침 카운트가 한 락 안에서 움직여야 합니다.

### 함정 넷 — 원거래 전문에 열쇠가 없으면 대사가 불가능하다

상태조회를 설계하다가 구멍을 발견했습니다. 5편까지의 잔액조회 요청 전문(30byte)에는 **거래고유번호 필드가 없습니다.** 거래ID는 게이트웨이 원장에만 적혔지, 전문에 실려 나간 적이 없습니다. 그러면 계정계에 "GWMNU...031 거래 처리했습니까?"라고 물어도 계정계는 그 번호를 모릅니다. 대사는 양쪽이 같은 열쇠를 쥐고 있어야 성립합니다 — 오픈뱅킹 전문이 bank_tran_id를 본문에 싣는 이유가 이것입니다.

## 3. 판단 — 성격을 타입에 박고, 확정은 조회로 한다

**하나, 서킷브레이커는 직접 구현한다.** 이 프로젝트의 원칙 그대로입니다 — 프레임워크 통짜(Resilience4j) 대신 손으로, 게이트웨이 내부에서 무슨 일이 일어나는지 이해하려고. 상태는 셋: CLOSED(정상, 연속 실패를 센다) → OPEN(임계 도달, 계정계 호출 없이 즉시 실패 — 원장에는 FAILED) → HALF_OPEN(대기 후 제한 탐침) → 성공 시 CLOSED. 동시성은 synchronized 한 겹으로 지킵니다. 상태 전이·카운터 갱신은 나노초 단위 작업이라 락 경합이 문제되지 않고, 미묘한 lock-free 코드보다 검증이 쉽습니다. 상태 전이는 WARN 로그와 Prometheus 게이지(`gwanmun_circuit_state` 0/1/2)·카운터(opened/rejected)로 노출합니다.

**둘, 재시도 가능 여부는 enum으로 강제한다.** `TransactionKind.INQUIRY`(조회성, 재시도 허용)와 `MUTATION`(변경성, 재시도 금지)을 만들고, 계정계 클라이언트의 `exchange(frame, kind)`가 이 성격을 받습니다. 변경성이면 실행기가 재시도 설정을 무시하고 1회로 끝냅니다 — "설정을 조심하자"가 아니라 코드가 못 하게 만드는 쪽입니다.

**셋, 거래 데드라인이 마지막 시도까지 깎는다.** 소켓 read 타임아웃 3초(1회 호출 제한)와 별개로 거래 데드라인 5초를 둡니다. 시도 사이 백오프를 포함해 남은 시간을 계산하고, 매 시도의 read 타임아웃을 `min(설정값, 남은 시간)`으로 낮춥니다. 커넥션 풀에서 빌린 소켓의 `soTimeout`을 시도마다 조정하는 메서드를 연결 인터페이스에 추가했습니다.

**넷, UNKNOWN의 확정은 조회로 한다.** 금융 연계의 정수라고 생각하는 부분입니다 — 응답을 못 받은 거래는 "모름"이고, 아는 척하지 않고 계정계에 **물어서** 확정합니다.

- 원거래 전문에 거래고유번호를 싣습니다. 요청 전문 공통 선두를 `전문구분(4) + 거래고유번호(22)`로 확장(30 → 52byte)했습니다. 아픈 변경이지만 피할 수 없습니다 — 열쇠 없는 대사는 없습니다.
- 목업 계정계가 자기가 처리한 거래를 기억합니다(인메모리 원장: 거래ID → 처리 결과). 지연 모드 계좌는 **기록 먼저, 응답은 늦게** — 게이트웨이가 포기해도 계정계엔 처리 흔적이 남는, UNKNOWN의 전형적 상황이 재현됩니다. 반대로 유실 모드 계좌(`8888...`)는 기록도 응답도 없이 연결을 끊습니다 — 처리 직전에 죽은 계정계입니다.
- 전문 2종을 추가합니다. **거래상태조회(0400)**: 원거래 거래ID로 "처리됨(01)/미처리(02)"를 답받는다. **망취소(0420)**: 처리된 원거래를 무효화한다(멱등 — 이미 취소된 원거래도 취소 성공). 네 전문이 같은 프레임 규격(요청 52/응답 61byte)이라 기존 고정길이 프레이밍·커넥션 풀을 그대로 탑니다.

정책 하나를 결정해야 했습니다. 상태조회가 "처리됨"이면 그 거래를 성공으로 살릴 수도(CONFIRMED) 있습니다. 저는 **망취소**를 택했습니다. 게이트웨이는 호출자에게 이미 504를 돌려줬습니다 — 호출자가 모르는 성공을 계정계에 살려두면 양쪽 장부가 어긋납니다. 원거래를 무효화해 "없던 일"로 맞추는 것이 오픈뱅킹 망취소의 관례이기도 합니다. "미처리"라면 처리됐을 가능성이 0이므로, 그제야 FAILED로 확정할 수 있습니다.

원장에는 4번째 상태 `CANCELED`와 해소 이력(resolved_at, resolution_method)이 생깁니다. CANCELED로 들어오는 길은 해소 절차뿐이고, 거래 시점 판정은 여전히 3값만 냅니다.

## 4. 개선 — 실행기 하나에 세 겹을 두른다

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

디테일 두 곳이 이번 편의 판단을 담고 있습니다. 재시도 도중 서킷이 열리면(내 실패가 임계를 채운 경우 포함) `CircuitOpenException`이 아니라 **마지막 실제 실패**를 던집니다 — 호출자에게 중요한 건 "서킷이 열렸다"가 아니라 계정계가 어떻게 실패했는가이고, 3값 판정(타임아웃→UNKNOWN)도 그 원인을 봐야 하기 때문입니다. 반대로 첫 시도 전부터 열려 있었다면 `CircuitOpenException`이 그대로 올라가는데, 이건 요청이 밖으로 나가지 않은 실패라 판정이 UNKNOWN이 아니라 **FAILED**로 떨어집니다(HTTP는 503으로 구분).

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

이 서비스는 원장을 모릅니다 — 전문 왕복과 판정만 하고, 원장 확정(UNKNOWN→CANCELED/FAILED)은 조립층인 web 컨트롤러가 합니다. gateway → ledger 의존을 만들지 않으려는 모듈 경계이고, `ApplicationModules.verify()`는 이번에도 그린입니다.

## 5. 실측 — 서킷이 열리고 닫히는 것, 해소 두 경로가 원장에 남는 것

### 서킷 — 계정계 프로세스를 진짜로 죽였다

앱과 목업 계정계를 두 프로세스로 띄우고(`--gwanmun.core.embedded=false` + `runMockCore`), 계정계를 kill한 뒤 연속 5회 호출했습니다(실제 출력).

```
요청 1 → HTTP 502 : 계정계(127.0.0.1:9099) 통신 실패: Connection refused
요청 2 → HTTP 503 : 서킷 'core-banking' OPEN — 계정계 호출을 차단하고 즉시 실패
요청 3 → HTTP 503 : (동일)
요청 4 → HTTP 503 : (동일)
요청 5 → HTTP 503 : (동일)
```

요청 1 하나가 서킷을 열었습니다 — 원호출 + 재시도 2회 = 연속 실패 3회가 임계(3)를 정확히 채웠기 때문입니다. **재시도가 서킷의 실패 카운트를 3배로 밀어 넣는** 상호작용이 실측에 그대로 드러납니다. 요청 2~5는 계정계 호출 없이 즉시 거절됐고, 원장에는 `elapsed_ms=0`인 FAILED로 남았습니다(psql 확인). 목업을 다시 띄우고 10초 뒤 호출하면 탐침이 나가 회복합니다. 상태 전이 로그(실제):

```
서킷 'core-banking' CLOSED → OPEN (연속 실패 3회(임계 3))
서킷 'core-banking' OPEN → HALF_OPEN (대기 10000ms 경과 — 탐침 허용)
서킷 'core-banking' HALF_OPEN → CLOSED (탐침 성공 — 계정계 회복 확인)
```

Prometheus에도 같은 사건이 찍힙니다: `gwanmun_circuit_state{circuit="core-banking"} 1.0`(OPEN), `gwanmun_circuit_opened_total 2.0`, `gwanmun_circuit_rejected_total 5.0`, `gwanmun_core_retries_total 2.0`.

데드라인도 숫자로 확인됩니다. 지연 계좌(응답 5초 지연, read 타임아웃 3초) 호출의 총 소요가 **5.02초** — 1차 타임아웃 3초 + 백오프 0.2초 + 2차 시도의 read 타임아웃이 남은 1.8초로 깎인 합입니다. 로그에는 "거래 데드라인(5000ms) 소진 — 재시도를 접습니다"가 남습니다.

### 해소 — UNKNOWN 두 건의 서로 다른 운명

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

같은 UNKNOWN인데 하나는 CANCELED, 하나는 FAILED — **"모름"의 확정은 아는 척이 아니라 조회로 한다**는 이번 편의 문장이 원장 두 줄로 남았습니다.

### 실측이 준 보너스 — 함정 둘을 현장에서 밟았다

첫 해소 시도는 500으로 터졌습니다. 원인은 코드가 아니라 DB였습니다 — Phase 5 때 Hibernate `ddl-auto: update`가 PostgreSQL에 만들어 둔 상태 체크 제약이 3값(SUCCESS/FAILED/UNKNOWN)만 허용해서, CANCELED로의 UPDATE가 `violates check constraint`로 거부된 겁니다. `ddl-auto: update`는 컬럼은 추가해 줘도 **체크 제약은 갱신하지 않습니다.** 수동 ALTER로 제약을 다시 걸어 해결했고, 마이그레이션 도구 없이 enum을 늘리는 비용을 실측으로 배웠습니다.

더 재미있는 건 그다음입니다. 그 500이 터진 시점에 **망취소 전문은 이미 계정계에 나가 있었습니다** — 원장 갱신만 실패했지, 원거래는 취소된 상태였습니다. 해소를 다시 돌리자 상태조회→망취소가 재실행됐는데, 망취소를 멱등(이미 취소된 원거래도 취소 성공)으로 설계해 둔 덕에 안전하게 CANCELED로 수렴했습니다. "해소 절차는 재실행 가능해야 한다"가 설계 노트의 문장이 아니라 실전의 생존 조건이라는 걸, 계획에 없던 장애가 증명해 줬습니다.

### 화면 — 서킷이 열리는 순간과 해소 플로우

화면에 장애 내성 섹션을 붙였습니다. 캡처 중에 목업 프로세스를 실제로 kill해서 만든 상태입니다 — 서킷 칩이 OPEN(빨강, 연속실패 3/3)이고, 오른쪽에는 방금 해소한 거래의 상태조회·망취소 전문 hex와 원장 확정(UNKNOWN → CANCELED)이, 아래에는 연속 호출의 502 → 503×4가 보입니다.

![장애 내성 화면 — 서킷 OPEN(빨강), 상태조회·망취소 해소 플로우, 연속 호출 즉시 거절](/uploads/project/gwanmun/resilience-demo.png)

### 테스트

`./gradlew test`는 **129개 전부 그린**입니다(1~5편의 104개 + 이번 25개). 서킷 상태 전이(임계 도달 OPEN·즉시 거절·HALF_OPEN 탐침 정원·탐침 성공/실패), **변경성 재시도 금지(재시도 설정이 있어도 호출은 정확히 1회)**, 데드라인이 마지막 시도의 read 타임아웃을 깎는 것, 상태조회/망취소 전문 왕복, HTTP→소켓→원장 전 구간의 UNKNOWN→CANCELED/FAILED 해소까지. 서킷과 실행기는 시계와 sleep을 주입받게 만들어 실제 대기 없이 시간 흐름을 검증합니다.

## 6. 잔여 — 정직하게 안 한 것

- **해소는 수동 트리거만 있습니다.** UNKNOWN을 주기적으로 훑는 대사 배치(스케줄러)는 다음 확장 지점입니다.
- **멱등키가 여전히 없습니다.** 게이트웨이 내부 재시도는 조회성 한정이라 안전하지만, 호출자가 변경성 요청을 재전송하면 새 거래로 봅니다.
- **응답 전문에 거래ID가 없습니다.** 동기 소켓이라 요청-응답 매칭이 자명해 생략했지만, 비동기 채널이면 응답에도 실어야 합니다.
- **서킷은 인스턴스 로컬입니다.** 다중 인스턴스면 각자 따로 열고 닫습니다. JWT/OAuth·HA·중앙 채번도 이전 잔여 그대로이고, 체크 제약 함정에서 확인했듯 마이그레이션 도구(Flyway류)도 확장 지점입니다.

이제 게이트웨이는 계정계가 죽어도 같이 죽지 않고, 모른다고 적은 거래를 계정계에 물어서 확정 지을 줄 압니다. 기록(5편)과 해소(6편)가 맞물리면서, 원장이 비로소 "장애 때 믿고 쓰는 장부"가 됐습니다.

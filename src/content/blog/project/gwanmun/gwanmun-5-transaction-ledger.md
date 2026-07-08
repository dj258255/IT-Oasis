---
title: '게이트웨이가 거래를 기억하지 못한다 — 거래 원장과 3값 상태(타임아웃은 실패가 아니다)'
titleEn: 'The Gateway Remembers Nothing — A Transaction Ledger and Three-Valued Status (a Timeout Is Not a Failure)'
description: "4편까지의 게이트웨이는 거래를 흘려보내기만 하고 아무것도 기억하지 못했습니다. \"어제 그 요청 어떻게 됐나요?\"에 답할 방법이 없으니 장애가 나면 대응 불가입니다. 5편은 관측을 붙입니다 — 모든 거래에 거래고유번호를 채번하고(오픈뱅킹 bank_tran_id의 자기설명 구조 참조, 스레드 안전 + 재기동 안전), 결과를 3값 상태로 원장에 적재합니다. 핵심 규칙은 타임아웃을 임의로 실패 처리하지 않는 것입니다. 응답을 못 받은 거래는 계정계에서 처리됐을 수 있어 FAILED가 아니라 UNKNOWN으로 적습니다 — 목업 계정계에 응답 지연 모드를 넣어 진짜 read 타임아웃을 일으키고, 원장에 UNKNOWN이 남는 것을 실측했습니다. 적재는 비동기라 거래를 막지 않고(DB가 죽어도 거래는 진행), 계좌는 저장 직전 마스킹돼 원장에 원문이 없습니다. correlation ID가 모든 로그 라인과 원장을 한 줄로 꿰고, 토큰버킷·커넥션 풀·TCP 왕복이 /actuator/prometheus 커스텀 메트릭으로 노출됩니다."
descriptionEn: "Up to phase 4 the gateway just passed transactions through and remembered nothing — no way to answer \"what happened to that request yesterday,\" so an incident meant flying blind. Phase 5 adds observability: every transaction gets a unique ID (modeled on Open Banking's self-describing bank_tran_id; thread-safe and restart-safe) and lands in a ledger with a three-valued status. The core rule: never arbitrarily mark a timeout as failed. A transaction whose response never arrived may well have been processed by the core system, so it's recorded as UNKNOWN, not FAILED — I added a delay mode to the mock core to trigger a real read timeout and verified UNKNOWN actually lands in the ledger. Writes are asynchronous so logging never blocks a transaction (even with the DB down), account numbers are masked right before persistence so the ledger never holds raw values, a correlation ID threads every log line and ledger row together, and the token bucket, connection pool, and TCP round trips are exposed as custom Prometheus metrics."
date: 2026-07-08
tags:
  - Java
  - Spring Boot
  - 거래원장
  - 관측가능성
  - Prometheus
  - Spring Modulith
category: personal/gwanmun
coverImage: /uploads/project/gwanmun/cover.svg
draft: false
series: "gwanmun"
seriesOrder: 5
---

## 1. 상황 — 통로는 튼튼해졌는데, 아무것도 기억하지 못한다

[4편](/blog/project/gwanmun/gwanmun-4-variable-length-pool)까지로 통로 자체는 꽤 단단해졌습니다. 고정·가변 전문을 프레이밍으로 정확히 자르고, 필터 체인이 문을 지키고, 커넥션 풀이 소켓을 재사용합니다.

그런데 이 게이트웨이에 이런 질문을 던지면 답이 없습니다.

> "어제 14시쯤 들어온 그 잔액조회, 계정계까지 갔나요? 응답은 받았나요?"

게이트웨이는 거래를 흘려보내기만 하고 **아무것도 기억하지 못합니다.** 앱 로그가 있긴 하지만, 어떤 로그 라인이 어떤 요청의 것인지 묶을 열쇠가 없고, 거래 하나가 성공했는지 실패했는지의 판정 자체가 어디에도 적히지 않습니다. 평소에는 문제가 안 됩니다. 문제는 장애 때입니다 — 호출자(핀테크)는 "응답을 못 받았다"고 하고, 계정계는 "우린 처리했다"고 하는 상황에서, 중간에 서 있던 게이트웨이가 아무 기록이 없으면 중재가 불가능합니다.

이번 편의 목표는 게이트웨이에 기억을 붙이는 것입니다.

> 하나, 모든 거래에 유일한 거래고유번호를 채번한다. 둘, 거래의 결과를 원장(DB)에 적는다. 셋, 그 원장이 스스로 거짓말하지 않게 한다.

셋째가 이번 편의 요점입니다. 아래 함정에서 다룹니다.

## 2. 함정 — 타임아웃은 실패가 아니다, 그리고 두 가지 더

### 함정 하나 — 응답을 못 받은 거래를 "실패"로 적으면 안 된다

거래 상태를 성공/실패 2값으로 설계하면 자연스럽게 이렇게 짜게 됩니다: "예외가 났으니 FAILED".

그런데 타임아웃을 생각해 보면 이게 거짓말입니다. read 타임아웃은 "정해진 시간 안에 응답이 안 왔다"이지 "계정계가 처리를 안 했다"가 아닙니다. 요청 전문은 이미 소켓을 타고 나갔고, 계정계는 받아서 처리한 뒤 응답을 보냈는데 그게 늦게 도착하는 중일 수도 있습니다. 이걸 FAILED로 적으면 어떻게 되느냐 — 호출자든 운영자든 "실패했으니 다시 보내자"가 되고, 계정계에서는 같은 거래가 **두 번** 실행됩니다. 잔액조회면 무해하지만 이체라면 사고입니다.

그래서 금융 연계의 거래 상태는 3값이어야 합니다.

- **SUCCESS** — 응답을 정상 수신했고 응답코드도 정상.
- **FAILED** — 명확한 실패. 오류 응답을 받았거나(없는 계좌), 입력이 틀렸거나, 연결 자체가 거부돼 **요청이 나가기 전에** 죽었다. 계정계에서 처리됐을 가능성이 없다.
- **UNKNOWN** — **모른다.** 요청은 나갔는데 응답을 못 받았다(타임아웃, 응답 없는 연결 종료). 처리됐을 수도, 안 됐을 수도 있다.

UNKNOWN을 인정하는 게 찜찜해 보이지만, 모르는 것을 모른다고 적는 것이 아는 척 틀리게 적는 것보다 훨씬 안전합니다. UNKNOWN으로 적힌 거래만 골라 나중에 확인(대사)하면 되기 때문입니다.

### 함정 둘 — 기록이 거래를 느리게 하면 안 된다

원장 적재를 거래 경로에 동기로 끼우면, DB insert 시간만큼 모든 거래가 느려집니다. 더 나쁜 건 원장 DB 장애입니다 — 관측하려고 붙인 DB가 죽어서 거래까지 죽으면, 관측이 장애의 원인이 됩니다. 부가 기능이 본 기능의 관문이 되는 구조는 뒤집혀 있습니다.

### 함정 셋 — 원장이 민감정보 창고가 된다

거래 기록에는 계좌번호가 들어갑니다. 원문 그대로 쌓으면 원장 테이블이 곧 계좌번호 창고입니다. DB 백업, 조회 화면, 로그로 흘러나가는 모든 경로가 유출 표면이 됩니다. 마스킹을 "보여줄 때" 하면 늦습니다 — 저장돼 있는 이상 어디로든 샙니다.

## 3. 판단 — 새 모듈, 예외 사슬 판정, 저장 직전 마스킹

**하나, 원장은 새 모듈 `ledger`로 세운다.** 관측은 통역(message)·전송(core)·검문(gateway) 어디의 부속도 아니라서 경계를 따로 긋습니다. 의존은 ledger → message(마스커) 한 줄뿐이고, web이 ledger를 조립합니다. `ApplicationModules.verify()`가 이 경계를 계속 강제합니다.

**둘, 거래고유번호는 자기설명 구조로.** 오픈뱅킹 거래고유번호(bank_tran_id)가 "이용기관코드 + 생성구분 + 일련번호"로 ID만 보고도 출처가 읽히게 돼 있는 걸 참조해, `GWMN`(생성주체) + `U`(구분) + 날짜 8자리 + 일련번호 9자리 = 22자로 정했습니다. 유일성은 두 겹으로 보장합니다 — 동시 요청은 `AtomicLong`이(락 없이 원자적), 재기동은 "자정 이후 흐른 밀리초 × 10"을 시드로 써서(재기동하면 시드가 죽기 전 발급분을 앞지름) 막습니다.

**셋, 3값 판정은 예외의 원인 사슬로.** 응답을 받았으면 응답코드로(0000=SUCCESS, 그 외=FAILED), 못 받았으면 예외 사슬을 훑어 `SocketTimeoutException`·`EOFException`(요청은 나감)이면 UNKNOWN, `ConnectException` 등(나가기도 전)이면 FAILED.

**넷, 적재는 전용 스레드 + 유한 큐로 비동기.** 거래 스레드는 큐에 넣고 즉시 돌아갑니다. 큐가 차거나 DB가 죽으면 WARN 로그만 남기고 거래는 진행합니다 — `record()`는 예외를 던지지 않는 메서드로 계약합니다.

**다섯, 마스킹은 저장 직전 한 곳에서.** 규칙은 명시적으로 "앞 6자리 + 뒤 4자리만 노출"(짧으면 더 보수적으로). 적재 경로가 어디든 이 지점을 지나므로 원장에 원문이 남을 수 없습니다. 앱 로그의 계좌도 같은 마스커를 거칩니다.

**여섯, 요청마다 correlation ID.** 수신 헤더 `X-Correlation-Id`가 있으면 승계하고(형식 검증 후), 없으면 만들어 MDC에 넣습니다. 로그 패턴이 모든 라인에 자동으로 찍고, 응답 헤더로 돌려주고, 원장에도 저장합니다. "이 502가 어느 요청이었나"를 호출자↔앱 로그↔원장 사이에서 한 줄로 꿰는 실입니다.

저장소는 PostgreSQL 컨테이너(자체 docker-compose, 재기동해도 원장이 남게)로 하되, 로컬 개발·테스트는 H2 인메모리로 DB 없이 돌게 했습니다.

## 4. 개선 — 채번기, 판정, 비동기 원장

### 4-1. 채번 — 스레드 안전과 재기동 안전을 분리해서 푼다

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

### 4-2. 3값 판정 — 원인 사슬을 훑는다

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

게이트웨이 예외로 몇 겹 감싸여 와도 사슬을 따라가 같은 판정을 냅니다. `EOFException`(응답 전문 없이 연결이 닫힘)도 UNKNOWN인 게 포인트입니다 — 요청은 이미 나갔기 때문입니다.

### 4-3. 비동기 원장 — record()는 예외를 던지지 않는다

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

컨트롤러는 거래마다 ID를 먼저 채번하고, 결과가 어느 쪽이든 원장에 적습니다. 타임아웃(UNKNOWN)일 때는 HTTP도 502가 아니라 **504**로 구분해 돌려줍니다 — "백엔드가 실패했다"와 "응답을 못 받았다(결과 미확인)"는 호출자에게도 다른 정보입니다.

## 5. 실측 — 3값이 실제로 원장에 남는다

원장 DB(PostgreSQL 16, 자체 docker-compose, 포트 25432)를 띄우고 앱을 postgres 프로파일로 기동했습니다. UNKNOWN을 진짜로 만들기 위해 목업 계정계에 지연 모드를 하나 넣었습니다 — 계좌 `99999999999999`로 요청이 오면 정상 처리하되 응답만 5초 늦춥니다. 게이트웨이의 read 타임아웃이 3초라 반드시 타임아웃이 납니다.

**(a) 정상 거래 → SUCCESS** (curl 실제 출력, 거래ID가 응답에 노출)

```
POST /api/gateway/balance {"accountNo":"12345678901234"}
HTTP/1.1 200
X-Correlation-Id: demo-cid-success-1
{"transactionId":"GWMNU20260709105002301","ledgerStatus":"SUCCESS", ..., "elapsedMs":2}
```

**(b) 없는 계좌 → FAILED** (응답은 받았다 — 오류 코드 0001이므로 UNKNOWN이 아니라 FAILED)

```
{"transactionId":"GWMNU20260709105002302","ledgerStatus":"FAILED",
 "json":{"responseCode":"0001","responseMessage":"없는 계좌입니다"}}
```

**(c) 지연 계좌 → 타임아웃 → UNKNOWN** (3.06초 만에 504 — read 타임아웃 3000ms에서 포기)

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

UNKNOWN 행의 `response_code`가 비어 있습니다 — 응답 자체를 못 받았다는 정직한 기록입니다. `elapsed_ms=3011`은 타임아웃 3초의 흔적이고, `account_masked` 컬럼은 `999999****9999`처럼 마스킹된 값만 있습니다.

### correlation ID — 로그와 원장이 한 줄로 꿰인다

앱 로그의 모든 라인에 `[cid:...]`가 찍힙니다(실제 출력 — 계좌도 마스킹돼 있습니다).

```
[cid:demo-cid-success-1] io.gwanmun.gateway.GatewayService : 게이트웨이 왕복 완료: 계좌=123456****1234 응답코드=0000 잔액=6879445000 (2ms)
[cid:c1d066748a7944d7]   io.gwanmun.gateway.GatewayService : 게이트웨이 왕복 완료: 계좌=* 응답코드=0001 잔액=0 (0ms)
```

`demo-cid-success-1`은 호출자가 보낸 헤더를 승계한 값이고, 다른 하나는 게이트웨이가 생성한 값입니다. 같은 ID가 응답 헤더와 원장 행에도 저장돼 있어, 셋 중 어느 쪽에서 출발해도 나머지를 찾을 수 있습니다.

### 커스텀 메트릭 — 자체 구현물이 스스로를 보고한다

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

읽는 재미가 있습니다 — `destroyed_total=1`은 타임아웃 난 소켓을 풀이 폐기한 것이고, `opened_total=2 · reused_total=6`은 소켓 2개로 8왕복을 처리했다는 뜻입니다. 3편의 토큰버킷과 4편의 커넥션 풀이 이제 숫자로 자신을 보고합니다. 헬스는 liveness/readiness가 분리돼 있고(`/actuator/health/liveness`·`/readiness` 각각 UP), SIGTERM을 보내면 graceful shutdown이 처리 중 요청을 마저 끝낸 뒤 풀과 원장 스레드를 정리하는 것도 로그로 확인했습니다.

여기서 삽질 하나를 정직하게 적어 둡니다. 풀의 누적 개설 수를 처음에 `gwanmun.pool.created` 게이지로 등록했는데, Prometheus 신형 노출 형식에서 `_created`가 **예약 접미사**라 지표가 `gwanmun_pool_total`로 뭉개져 나왔습니다. 게이지가 일회성 람다를 약참조로 쥐어 GC 뒤 NaN이 되는 함정도 같이 밟았습니다. 누적값은 단조 증가이므로 함수 카운터(`opened_total`)로 바꾸고, 게이지는 컨텍스트가 살아 있는 한 살아 있는 클라이언트 빈에 걸어 해결했습니다.

### 화면 — 3값이 색으로 보인다

화면에도 원장 섹션을 붙였습니다. 상태별 카운트와 최근 거래 표 — UNKNOWN 행의 소요 3011ms, 마스킹된 계좌, correlation ID까지 그대로 보입니다.

![거래 원장 화면 — SUCCESS(초록)/FAILED(빨강)/UNKNOWN(노랑) 3값 상태, 마스킹된 계좌, correlation ID](/uploads/project/gwanmun/transaction-ledger.png)

### 테스트

`./gradlew test`는 **104개 전부 그린**입니다(1~4편의 80개 + 이번 24개). 채번 동시성·재기동, 3값 판정(진짜 소켓 타임아웃 포함), 마스킹 규칙, "적재 실패가 거래를 안 막는 것", HTTP→소켓→비동기 적재 전 구간 통합까지. 새 `ledger` 모듈을 포함해도 `ApplicationModules.verify()`는 계속 그린입니다(5모듈 단방향 DAG — web → gateway·message·core·ledger, ledger → message).

## 6. 잔여 — 정직하게 안 한 것

- **UNKNOWN을 해소하는 흐름이 없습니다.** 이번 편은 UNKNOWN을 *기록*하는 것까지입니다. 실무라면 UNKNOWN 거래를 취소 전문(망취소)으로 무효화하거나 상태 조회(대사)로 확정 짓는 후속 흐름이 붙어야 합니다 — 다음 편의 재료입니다.
- **멱등키가 없습니다.** 호출자가 같은 요청을 재시도해도 게이트웨이는 새 거래로 봅니다. 거래ID로 문의는 가능하지만 중복 실행 방지는 안 됩니다.
- **채번은 단일 노드 전제입니다.** 다중 인스턴스라면 노드 식별자를 넣거나 중앙 채번이 필요합니다.
- **JWT/OAuth는 여전히 미구현**(3편 잔여 그대로)이고, 원장의 보존 기한·파티셔닝·변경 감사 추적도 없습니다.

이제 게이트웨이가 거래를 기억합니다. 무엇이 성공했고 무엇이 실패했으며 — 가장 중요하게 — **무엇을 모르는지**를 스스로 압니다. 모른다고 적힌 거래를 확정 짓는 일이 다음 차례입니다.

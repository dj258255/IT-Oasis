---
title: '타임아웃을 실패로 단정하지 않는 3값 원장, 그리고 손으로 짠 서킷브레이커와 망취소'
titleEn: 'A Three-Valued Ledger That Never Calls a Timeout a Failure, plus a Hand-Rolled Circuit Breaker and Net Cancellation'
description: '1부는 아무것도 기억하지 못하던 게이트웨이에 기억을 붙입니다. 모든 거래에 거래고유번호를 채번하고(스레드 안전 + 재기동 안전), 결과를 3값 상태(SUCCESS/FAILED/UNKNOWN)로 원장에 적재합니다. 핵심 규칙은 타임아웃을 임의로 실패 처리하지 않는 것입니다. 응답을 못 받은 거래는 계정계에서 처리됐을 수 있어 FAILED가 아니라 UNKNOWN으로 적습니다. 목업 계정계에 응답 지연 모드를 넣어 진짜 read 타임아웃(3.06초 → 504)을 일으키고 원장에 UNKNOWN이 남는 것을 실측했습니다. 적재는 비동기라 거래를 막지 않고, 계좌는 저장 직전 마스킹되며, correlation ID가 로그와 원장을 한 줄로 꿰고, 토큰버킷·커넥션 풀·TCP 왕복이 Prometheus 커스텀 메트릭으로 노출됩니다. 2부는 남은 폭탄 둘을 처리합니다. 계정계 프로세스를 실제로 죽여 손으로 짠 서킷브레이커(CLOSED→OPEN→HALF_OPEN)가 502 → 503×4 즉시 거절로 장애를 격리하고 재기동 후 탐침으로 닫히는 전 과정을 확인했고, UNKNOWN 해소도 완성했습니다. 원거래 전문에 거래고유번호를 실어(30→52byte) 거래상태조회로 처리 여부를 확인해, 처리됐으면 망취소로 CANCELED, 미처리면 그제야 FAILED로 확정합니다. 조회성 거래만 지수 백오프로 제한 재시도하고(변경성 재시도는 이중 거래라 코드가 0회를 강제), 거래 단위 데드라인이 마지막 재시도의 read 제한까지 깎습니다. ddl-auto:update가 체크 제약을 갱신하지 않아 CANCELED UPDATE가 거부된 함정과, 그 실패 순간 이미 나간 망취소를 멱등성이 구해 준 이야기도 정직하게 적었습니다.'
descriptionEn: 'Part 1 gives the gateway, which remembered nothing, a memory: every transaction gets a unique ID (thread-safe and restart-safe) and lands in a ledger with a three-valued status (SUCCESS/FAILED/UNKNOWN). The core rule is to never arbitrarily mark a timeout as failed. A transaction whose response never arrived may well have been processed by the core system, so it is recorded as UNKNOWN, not FAILED. I added a delay mode to the mock core to trigger a real read timeout (3.06s, then 504) and verified UNKNOWN actually lands in the ledger. Writes are asynchronous so logging never blocks a transaction, account numbers are masked right before persistence, a correlation ID threads log lines and ledger rows together, and the token bucket, connection pool, and TCP round trips are exposed as custom Prometheus metrics. Part 2 defuses the two remaining bombs. I hand-rolled a circuit breaker (CLOSED→OPEN→HALF_OPEN) and actually killed the mock core process to watch it isolate the failure with a 502 followed by four immediate 503 rejections, then close again via a half-open probe after restart. UNKNOWN resolution follows: the original message now carries the transaction ID (30→52 bytes), and a status-inquiry message asks the core whether it processed the transaction; if processed, a net-cancel message voids it (CANCELED), and only if unprocessed is it finally FAILED. Only inquiry-type transactions retry with exponential backoff (retrying mutations means double execution, so the code forces zero), and a per-transaction deadline trims even the last retry''s read limit. Also honestly documented: ddl-auto:update does not refresh check constraints (the CANCELED update was rejected), and net-cancel idempotency saved the day when that failure struck after the cancel had already gone out.'
date: 2025-09-21
tags:
  - Java
  - Spring Boot
  - 거래원장
  - 관측가능성
  - Prometheus
  - Spring Modulith
  - 서킷브레이커
  - 망취소
  - 장애내성
category: personal/gwanmun
coverImage: /uploads/project/gwanmun/cover.svg
draft: false
series: "gwanmun"
seriesOrder: 3
---

## 1부. 거래 원장과 3값 상태: 타임아웃은 실패가 아니다

### 1. 상황: 통로는 튼튼해졌는데 아무것도 기억하지 못한다

[2편](/blog/project/gwanmun/gwanmun-2-gateway-skeleton)까지로 통로 자체는 꽤 단단해졌습니다. 고정·가변 전문을 프레이밍으로 정확히 자르고, 필터 체인이 문을 지키고, 커넥션 풀이 소켓을 재사용합니다.

그런데 이 게이트웨이에 이런 질문을 던지면 답이 없습니다.

> "어제 14시쯤 들어온 그 잔액조회, 계정계까지 갔나요? 응답은 받았나요?"

게이트웨이는 거래를 흘려보내기만 하고 **아무것도 기억하지 못합니다.** 앱 로그가 있긴 하지만, 어떤 로그 라인이 어떤 요청의 것인지 묶을 열쇠가 없고 거래 하나가 성공했는지 실패했는지의 판정 자체가 어디에도 적히지 않습니다. 평소에는 문제가 안 됩니다. 문제는 장애 때입니다. 호출자(핀테크)는 "응답을 못 받았다"고 하고 계정계는 "우린 처리했다"고 하는 상황에서, 중간에 서 있던 게이트웨이가 아무 기록이 없으면 중재가 불가능합니다.

이번 편의 목표는 게이트웨이에 기억을 붙이는 것입니다.

> 하나, 모든 거래에 유일한 거래고유번호를 채번한다. 둘, 거래의 결과를 원장(DB)에 적는다. 셋, 그 원장이 스스로 거짓말하지 않게 한다.

셋째가 이번 편의 요점입니다. 아래 함정에서 다룹니다.

### 2. 함정: 타임아웃은 실패가 아니다, 그리고 두 가지 더

#### 함정 하나. 응답을 못 받은 거래를 "실패"로 적으면 안 된다

거래 상태를 성공/실패 2값으로 설계하면 자연스럽게 이렇게 짜게 됩니다: "예외가 났으니 FAILED".

그런데 타임아웃을 생각해 보면 이게 거짓말입니다. read 타임아웃은 "정해진 시간 안에 응답이 안 왔다"이지 "계정계가 처리를 안 했다"가 아닙니다. 요청 전문은 이미 소켓을 타고 나갔고 계정계는 받아서 처리한 뒤 응답을 보냈는데 그게 늦게 도착하는 중일 수도 있습니다. 이걸 FAILED로 적으면 어떻게 될까요? 호출자든 운영자든 "실패했으니 다시 보내자"가 되고, 계정계에서는 같은 거래가 **두 번** 실행됩니다. 잔액조회면 무해하지만 이체라면 사고입니다.

그래서 금융 연계의 거래 상태는 3값이어야 합니다.

- **SUCCESS**는 응답을 정상 수신했고 응답코드도 정상이다.
- **FAILED**는 명확한 실패다. 오류 응답을 받았거나(없는 계좌), 입력이 틀렸거나, 연결 자체가 거부돼 **요청이 나가기 전에** 죽었다. 계정계에서 처리됐을 가능성이 없다.
- **UNKNOWN**은 **모른다.** 요청은 나갔는데 응답을 못 받았다(타임아웃, 응답 없는 연결 종료). 처리됐을 수도, 안 됐을 수도 있다.

UNKNOWN을 인정하는 게 찜찜해 보이지만 모르는 것을 모른다고 적는 것이 아는 척 틀리게 적는 것보다 훨씬 안전합니다. UNKNOWN으로 적힌 거래만 골라 나중에 확인(대사)하면 되기 때문입니다.

#### 함정 둘. 기록이 거래를 느리게 하면 안 된다

원장 적재를 거래 경로에 동기로 끼우면, DB insert 시간만큼 모든 거래가 느려집니다. 더 나쁜 건 원장 DB 장애입니다. 관측하려고 붙인 DB가 죽어서 거래까지 죽으면, 관측이 장애의 원인이 됩니다. 부가 기능이 본 기능의 관문이 되는 구조는 뒤집혀 있습니다.

#### 함정 셋. 원장이 민감정보 창고가 된다

거래 기록에는 계좌번호가 들어갑니다. 원문 그대로 쌓으면 원장 테이블이 곧 계좌번호 창고입니다. DB 백업, 조회 화면, 로그로 흘러나가는 모든 경로가 유출 표면이 됩니다. 마스킹을 "보여줄 때" 하면 늦습니다. 저장돼 있는 이상 어디로든 샙니다.

### 3. 판단: 새 모듈, 예외 사슬 판정, 저장 직전 마스킹

**하나, 원장은 새 모듈 `ledger`로 세운다.** 관측은 통역(message)·전송(core)·검문(gateway) 어디의 부속도 아니라서 경계를 따로 긋습니다. 의존은 ledger → message(마스커) 한 줄뿐이고, web이 ledger를 조립합니다. `ApplicationModules.verify()`가 이 경계를 계속 강제합니다.

**둘, 거래고유번호는 자기설명 구조로.** 오픈뱅킹 거래고유번호(bank_tran_id)가 "이용기관코드 + 생성구분 + 일련번호"로 ID만 보고도 출처가 읽히게 돼 있는 걸 참조해, `GWMN`(생성주체) + `U`(구분) + 날짜 8자리 + 일련번호 9자리 = 22자로 정했습니다. 유일성은 두 겹으로 보장합니다. 동시 요청은 `AtomicLong`이(락 없이 원자적), 재기동은 "자정 이후 흐른 밀리초 × 10"을 시드로 써서(재기동하면 시드가 죽기 전 발급분을 앞지름) 막습니다.

**셋, 3값 판정은 예외의 원인 사슬로.** 응답을 받았으면 응답코드로(0000=SUCCESS, 그 외=FAILED), 못 받았으면 예외 사슬을 훑어 `SocketTimeoutException`·`EOFException`(요청은 나감)이면 UNKNOWN, `ConnectException` 등(나가기도 전)이면 FAILED.

**넷, 적재는 전용 스레드 + 유한 큐로 비동기.** 거래 스레드는 큐에 넣고 즉시 돌아갑니다. 큐가 차거나 DB가 죽으면 WARN 로그만 남기고 거래는 진행합니다. `record()`는 예외를 던지지 않는 메서드로 계약합니다.

**다섯, 마스킹은 저장 직전 한 곳에서.** 규칙은 명시적으로 "앞 6자리 + 뒤 4자리만 노출"(짧으면 더 보수적으로). 적재 경로가 어디든 이 지점을 지나므로 원장에 원문이 남을 수 없습니다. 앱 로그의 계좌도 같은 마스커를 거칩니다.

**여섯, 요청마다 correlation ID.** 수신 헤더 `X-Correlation-Id`가 있으면 승계하고(형식 검증 후), 없으면 만들어 MDC에 넣습니다. 로그 패턴이 모든 라인에 자동으로 찍고 응답 헤더로 돌려주고 원장에도 저장합니다. "이 502가 어느 요청이었나"를 호출자↔앱 로그↔원장 사이에서 한 줄로 꿰는 실입니다.

저장소는 PostgreSQL 컨테이너(자체 docker-compose, 재기동해도 원장이 남게)로 하되, 로컬 개발·테스트는 H2 인메모리로 DB 없이 돌게 했습니다.

### 4. 개선: 채번기, 판정, 비동기 원장

#### 4-1. 채번: 스레드 안전과 재기동 안전을 분리해서 푼다

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

#### 4-2. 원인 사슬을 훑는 3값 판정

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

#### 4-3. 비동기 원장: record()는 예외를 던지지 않는다

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

### 5. 실측: 3값이 실제로 원장에 남는다

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

#### correlation ID로 로그와 원장을 한 줄에 꿴다

앱 로그의 모든 라인에 `[cid:...]`가 찍힙니다(실제 출력, 계좌도 마스킹돼 있습니다).

```
[cid:demo-cid-success-1] io.gwanmun.gateway.GatewayService : 게이트웨이 왕복 완료: 계좌=123456****1234 응답코드=0000 잔액=6879445000 (2ms)
[cid:c1d066748a7944d7]   io.gwanmun.gateway.GatewayService : 게이트웨이 왕복 완료: 계좌=* 응답코드=0001 잔액=0 (0ms)
```

`demo-cid-success-1`은 호출자가 보낸 헤더를 승계한 값이고, 다른 하나는 게이트웨이가 생성한 값입니다. 같은 ID가 응답 헤더와 원장 행에도 저장돼 있어, 셋 중 어느 쪽에서 출발해도 나머지를 찾을 수 있습니다.

#### 자체 구현물이 스스로를 보고하는 커스텀 메트릭

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

#### 화면에서 3값이 색으로 보인다

화면에도 원장 섹션을 붙였습니다. 상태별 카운트와 최근 거래 표를 넣었고, UNKNOWN 행의 소요 3011ms, 마스킹된 계좌, correlation ID까지 그대로 보입니다.

![거래 원장 화면. SUCCESS(초록)/FAILED(빨강)/UNKNOWN(노랑) 3값 상태와 마스킹된 계좌, correlation ID가 함께 보인다](/uploads/project/gwanmun/transaction-ledger.png)

#### 테스트

`./gradlew test`는 **104개 전부 그린**입니다(1~2편의 80개 + 이번 24개). 채번 동시성·재기동, 3값 판정(진짜 소켓 타임아웃 포함), 마스킹 규칙, "적재 실패가 거래를 안 막는 것", HTTP→소켓→비동기 적재 전 구간 통합까지. 새 `ledger` 모듈을 포함해도 `ApplicationModules.verify()`는 계속 그린입니다(5모듈 단방향 DAG는 web → gateway·message·core·ledger, ledger → message).

### 6. 잔여: 정직하게 안 한 것

- **UNKNOWN을 해소하는 흐름이 없습니다.** 이번 편은 UNKNOWN을 *기록*하는 것까지입니다. 실무라면 UNKNOWN 거래를 취소 전문(망취소)으로 무효화하거나 상태 조회(대사)로 확정 짓는 후속 흐름이 붙어야 합니다. 그게 2부의 재료입니다.
- **멱등키가 없습니다.** 호출자가 같은 요청을 재시도해도 게이트웨이는 새 거래로 봅니다. 거래ID로 문의는 가능하지만 중복 실행 방지는 안 됩니다.
- **채번은 단일 노드 전제입니다.** 다중 인스턴스라면 노드 식별자를 넣거나 중앙 채번이 필요합니다.
- **JWT/OAuth는 여전히 미구현**(3편 잔여 그대로)이고, 원장의 보존 기한·파티셔닝·변경 감사 추적도 없습니다.

이제 게이트웨이가 거래를 기억합니다. 무엇이 성공했고 무엇이 실패했으며, 가장 중요하게는 **무엇을 모르는지**를 스스로 압니다. 모른다고 적힌 거래를 확정 짓는 일이 다음 차례입니다.

## 2부. 손으로 짠 서킷브레이커, 그리고 망취소로 UNKNOWN 확정 짓기

### 1. 상황: 폭탄이 둘 남아 있다

1부로 게이트웨이가 기억을 갖게 됐습니다. 모든 거래에 거래고유번호가 붙고, 결과가 3값 상태(SUCCESS/FAILED/UNKNOWN)로 원장에 남습니다. 그런데 그 원장을 보다 보면 두 가지가 눈에 밟힙니다.

**첫째, 계정계가 느려지면 게이트웨이가 같이 죽습니다.** read 타임아웃이 3초라는 말은, 계정계가 죽어 있으면 요청 하나가 3초씩 스레드를 붙잡는다는 뜻입니다. 트래픽이 계속 들어오면 톰캣 스레드가 전부 "죽은 계정계 기다리기"에 묶이고 계정계 장애가 게이트웨이 장애로 번집니다. 중계자가 백엔드와 운명을 같이하면 중계자를 둔 의미가 없습니다.

**둘째, UNKNOWN이 기록만 되고 방치돼 있습니다.** 1부에서 "타임아웃은 실패가 아니다, 모른다고 적는다"까지 갔지만 모른다고 적힌 거래는 그 뒤로 아무도 안 건드립니다. 실무라면 이 거래들이 대사(對査) 리스트에 올라 "계정계에서 처리됐는지" 확인되고, 처리됐으면 취소(망취소)로 무효화되거나 확정돼야 합니다. 기록은 해소를 위한 준비일 뿐입니다.

이번 편의 목표는 이 둘입니다.

> 하나, 계정계 장애가 게이트웨이를 무너뜨리지 못하게 한다(서킷브레이커·재시도·데드라인). 둘, UNKNOWN을 해소한다(거래상태조회·망취소).

### 2. 함정: 재시도는 양날이고, 타임아웃은 한 겹이 아니다

#### 함정 하나. 변경성 거래를 재시도하면 이중 거래다

"실패하면 다시 보내자"는 직관적입니다. 그런데 1부에서 확인했듯, 타임아웃은 실패가 아닙니다. 아직 결과를 모르는 미확인 상태입니다. 계정계는 처리를 끝냈는데 응답만 늦은 것일 수 있습니다. 그 상태에서 재전송하면 같은 거래가 두 번 실행됩니다. 잔액조회면 무해하지만 이체나 취소라면 사고입니다.

그래서 재시도 허용 여부는 설정 옵션으로 두지 않고 **거래의 성격**에 못 박아야 합니다. 조회성(잔액조회·거래내역·상태조회)은 몇 번을 다시 보내도 계정계 상태가 안 변하니 재시도해도 안전합니다. 변경성(이체·망취소)은 재시도 금지입니다. 응답을 못 받으면 UNKNOWN으로 남기고, 해소 절차로 넘깁니다.

#### 함정 둘. 소켓 read 타임아웃은 "호출 한 번"의 제한일 뿐이다

재시도를 붙이는 순간 시간 계산이 달라집니다. read 타임아웃 3초에 재시도 2회면, 거래 하나가 최악의 경우 3초 × 3회 + 백오프로 10초 가까이 늘어집니다. 호출자는 그만큼 기다려 주지 않습니다. 그래서 "호출 한 번"의 제한과 별개로 **"거래 전체"의 데드라인**이 필요합니다. 그리고 데드라인은 새 시도의 출발선만 막아서는 부족합니다. 남은 시간이 1.8초인데 마지막 시도가 read 타임아웃 3초를 다 쓰면 데드라인이 뚫립니다. 매 시도의 read 제한 자체를 남은 시간으로 깎아야 합니다.

#### 함정 셋. HALF_OPEN은 동시성 함정이다

서킷브레이커의 상태 전이 중 제일 미묘한 곳이 HALF_OPEN입니다. OPEN 대기가 끝났다고 통로를 활짝 열면, 회복 중이던 백엔드에 밀린 트래픽이 한꺼번에 쏟아져 다시 눕습니다. 탐침(probe)을 제한된 수만 내보내고 탐침이 나가 있는 동안의 다른 호출은 즉시 거절해야 합니다. 여러 스레드가 동시에 "대기 끝났네, 내가 탐침"이라며 뚫고 나가지 못하게 상태 전이와 탐침 카운트가 한 락 안에서 움직여야 합니다.

#### 함정 넷. 원거래 전문에 열쇠가 없으면 대사가 불가능하다

상태조회를 설계하다가 구멍을 발견했습니다. 1부까지의 잔액조회 요청 전문(30byte)에는 **거래고유번호 필드가 없습니다.** 거래ID는 게이트웨이 원장에만 적혔지, 전문에 실려 나간 적이 없습니다. 그러면 계정계에 "GWMNU...031 거래 처리했습니까?"라고 물어도 계정계는 그 번호를 모릅니다. 대사는 양쪽이 같은 열쇠를 쥐고 있어야 성립합니다. 오픈뱅킹 전문이 bank_tran_id를 본문에 싣는 이유가 이것입니다.

### 3. 판단: 성격을 타입에 박고, 확정은 조회로 한다

**하나, 서킷브레이커는 직접 구현한다.** 이 프로젝트의 원칙 그대로입니다. 프레임워크 통짜(Resilience4j) 대신 손으로 짜서, 게이트웨이 내부에서 무슨 일이 일어나는지 이해하려는 겁니다. 상태는 셋입니다. CLOSED(정상, 연속 실패를 센다) → OPEN(임계 도달, 계정계 호출 없이 즉시 실패하고 원장에는 FAILED) → HALF_OPEN(대기 후 제한 탐침) → 성공 시 CLOSED. 동시성은 synchronized 한 겹으로 지킵니다. 상태 전이·카운터 갱신은 나노초 단위 작업이라 락 경합이 문제되지 않고, 미묘한 lock-free 코드보다 검증이 쉽습니다. 상태 전이는 WARN 로그와 Prometheus 게이지(`gwanmun_circuit_state` 0/1/2)·카운터(opened/rejected)로 노출합니다.

**둘, 재시도 가능 여부는 enum으로 강제한다.** `TransactionKind.INQUIRY`(조회성, 재시도 허용)와 `MUTATION`(변경성, 재시도 금지)을 만들고, 계정계 클라이언트의 `exchange(frame, kind)`가 이 성격을 받습니다. 변경성이면 실행기가 재시도 설정을 무시하고 1회로 끝냅니다. "설정을 조심하자"에 기대지 않고 코드가 못 하게 만드는 쪽입니다.

**셋, 거래 데드라인이 마지막 시도까지 깎는다.** 소켓 read 타임아웃 3초(1회 호출 제한)와 별개로 거래 데드라인 5초를 둡니다. 시도 사이 백오프를 포함해 남은 시간을 계산하고, 매 시도의 read 타임아웃을 `min(설정값, 남은 시간)`으로 낮춥니다. 커넥션 풀에서 빌린 소켓의 `soTimeout`을 시도마다 조정하는 메서드를 연결 인터페이스에 추가했습니다.

**넷, UNKNOWN의 확정은 조회로 한다.** 금융 연계의 정수라고 생각하는 부분입니다. 응답을 못 받은 거래는 "모름"이고, 아는 척하지 않고 계정계에 **물어서** 확정합니다.

- 원거래 전문에 거래고유번호를 싣습니다. 요청 전문 공통 선두를 `전문구분(4) + 거래고유번호(22)`로 확장(30 → 52byte)했습니다. 아픈 변경이지만 피할 수 없습니다. 열쇠 없는 대사는 없습니다.
- 목업 계정계가 자기가 처리한 거래를 기억합니다(인메모리 원장: 거래ID → 처리 결과). 지연 모드 계좌는 **기록 먼저, 응답은 늦게** 돌려줍니다. 게이트웨이가 포기해도 계정계엔 처리 흔적이 남는, UNKNOWN의 전형적 상황이 재현됩니다. 반대로 유실 모드 계좌(`8888...`)는 기록도 응답도 없이 연결을 끊습니다. 처리 직전에 죽은 계정계인 셈입니다.
- 전문 2종을 추가합니다. **거래상태조회(0400)**: 원거래 거래ID로 "처리됨(01)/미처리(02)"를 답받는다. **망취소(0420)**: 처리된 원거래를 무효화한다(멱등이라 이미 취소된 원거래도 취소 성공). 네 전문이 같은 프레임 규격(요청 52/응답 61byte)이라 기존 고정길이 프레이밍·커넥션 풀을 그대로 탑니다.

정책 하나를 결정해야 했습니다. 상태조회가 "처리됨"이면 그 거래를 성공으로 살릴 수도(CONFIRMED) 있습니다. 저는 **망취소**를 택했습니다. 게이트웨이는 호출자에게 이미 504를 돌려줬습니다. 호출자가 모르는 성공을 계정계에 살려두면 양쪽 장부가 어긋납니다. 원거래를 무효화해 "없던 일"로 맞추는 것이 오픈뱅킹 망취소의 관례이기도 합니다. "미처리"라면 처리됐을 가능성이 0이므로, 그제야 FAILED로 확정할 수 있습니다.

원장에는 4번째 상태 `CANCELED`와 해소 이력(resolved_at, resolution_method)이 생깁니다. CANCELED로 들어오는 길은 해소 절차뿐이고, 거래 시점 판정은 여전히 3값만 냅니다.

### 4. 개선: 실행기 하나에 세 겹을 두른다

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

### 5. 실측: 서킷이 열리고 닫히는 것, 해소 두 경로가 원장에 남는 것

#### 계정계 프로세스를 진짜로 죽여 본 서킷

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

#### UNKNOWN 두 건, 서로 다른 운명으로 갈린 해소

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

같은 UNKNOWN인데 하나는 CANCELED, 하나는 FAILED입니다. **"모름"의 확정은 아는 척으로 때우지 않고 조회로 한다**는 이번 편의 문장이 원장 두 줄로 남았습니다.

#### 실측이 준 보너스, 함정 둘을 현장에서 밟다

첫 해소 시도는 500으로 터졌습니다. 원인은 코드에 있지 않았습니다. DB였습니다. 앞서 원장을 만들 때 Hibernate `ddl-auto: update`가 PostgreSQL에 만들어 둔 상태 체크 제약이 3값(SUCCESS/FAILED/UNKNOWN)만 허용해서, CANCELED로의 UPDATE가 `violates check constraint`로 거부된 겁니다. `ddl-auto: update`는 컬럼은 추가해 줘도 **체크 제약은 갱신하지 않습니다.** 수동 ALTER로 제약을 다시 걸어 해결했고, 마이그레이션 도구 없이 enum을 늘리는 비용을 실측으로 배웠습니다.

더 재미있는 건 그다음입니다. 그 500이 터진 시점에 **망취소 전문은 이미 계정계에 나가 있었습니다**. 원장 갱신만 실패했지, 원거래는 취소된 상태였습니다. 해소를 다시 돌리자 상태조회→망취소가 재실행됐는데, 망취소를 멱등(이미 취소된 원거래도 취소 성공)으로 설계해 둔 덕에 안전하게 CANCELED로 수렴했습니다. "해소 절차는 재실행 가능해야 한다"는 설계 노트의 문장을, 계획에 없던 장애가 실전의 생존 조건으로 증명해 줬습니다.

#### 서킷이 열리는 순간과 해소 플로우를 담은 화면

화면에 장애 내성 섹션을 붙였습니다. 캡처 중에 목업 프로세스를 실제로 kill해서 만든 상태입니다. 서킷 칩이 OPEN(빨강, 연속실패 3/3)이고, 오른쪽에는 방금 해소한 거래의 상태조회·망취소 전문 hex와 원장 확정(UNKNOWN → CANCELED)이, 아래에는 연속 호출의 502 → 503×4가 보입니다.

![장애 내성 화면. 서킷 OPEN(빨강)과 상태조회·망취소 해소 플로우, 연속 호출 즉시 거절이 담겨 있다](/uploads/project/gwanmun/resilience-demo.png)

#### 테스트

`./gradlew test`는 **129개 전부 그린**입니다(1·2편과 1부의 104개 + 이번 25개). 서킷 상태 전이(임계 도달 OPEN·즉시 거절·HALF_OPEN 탐침 정원·탐침 성공/실패), **변경성 재시도 금지(재시도 설정이 있어도 호출은 정확히 1회)**, 데드라인이 마지막 시도의 read 타임아웃을 깎는 것, 상태조회/망취소 전문 왕복, HTTP→소켓→원장 전 구간의 UNKNOWN→CANCELED/FAILED 해소까지. 서킷과 실행기는 시계와 sleep을 주입받게 만들어 실제 대기 없이 시간 흐름을 검증합니다.

### 6. 잔여: 정직하게 안 한 것

- **해소는 수동 트리거만 있습니다.** UNKNOWN을 주기적으로 훑는 대사 배치(스케줄러)는 다음 확장 지점입니다.
- **멱등키가 여전히 없습니다.** 게이트웨이 내부 재시도는 조회성 한정이라 안전하지만, 호출자가 변경성 요청을 재전송하면 새 거래로 봅니다.
- **응답 전문에 거래ID가 없습니다.** 동기 소켓이라 요청-응답 매칭이 자명해 생략했지만, 비동기 채널이면 응답에도 실어야 합니다.
- **서킷은 인스턴스 로컬입니다.** 다중 인스턴스면 각자 따로 열고 닫습니다. JWT/OAuth·HA·중앙 채번도 이전 잔여 그대로이고, 체크 제약 함정에서 확인했듯 마이그레이션 도구(Flyway류)도 확장 지점입니다.

이제 게이트웨이는 계정계가 죽어도 같이 죽지 않고, 모른다고 적은 거래를 계정계에 물어서 확정 지을 줄 압니다. 기록(1부)과 해소(2부)가 맞물리면서, 원장이 비로소 "장애 때 믿고 쓰는 장부"가 됐습니다.

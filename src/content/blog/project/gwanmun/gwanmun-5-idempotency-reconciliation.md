---
title: '재전송의 이중 거래를 멱등키로 막고, 대조된 적 없던 원장을 EOD 대사로 맞추다'
titleEn: 'Stopping Retry-Induced Double Transactions with an Idempotency Key and Reconciling the Never-Checked Ledger at EOD'
description: '4편까지 원장은 거래를 3값(SUCCESS/FAILED/UNKNOWN)으로 적고 UNKNOWN을 수동으로 해소할 수 있었지만, 두 구멍이 남아 있었습니다. 하나, 게이트웨이는 호출자의 재전송을 구분하지 못합니다. 타임아웃(UNKNOWN)을 받은 호출자가 같은 요청을 다시 보내면 그건 새 거래고, 계정계에서 두 번 실행돼 이중 거래가 됩니다. 둘, 원장은 한 번도 계정계와 대조된 적이 없는 진실입니다. 5편은 둘을 채웁니다. 멱등키는 (키+메서드+경로)를 DB 유니크 제약으로 원자적 선점합니다. 앱 락이 아니라 DB가 동시 재요청을 하나로 만듭니다. 처리 중 재요청은 409, 완료된 요청 재수신은 저장된 원응답을 재실행 없이 재반환합니다. 같은 키로 잔액조회를 두 번 보내니 계정계 로그에 요청 수신은 1회, 원장에 그 거래는 1행으로 남아 이중 거래 0을 psql로 확인했습니다. EOD 대사는 계정계 당일 처리내역(가변 전문)을 원장 전량과 거래고유번호로 대조해 양쪽일치 / 금액상이 / 우리만있음 / 저쪽만있음의 4유형으로 가립니다. UNKNOWN은 대조 전에 상태조회·망취소로 자동 해소합니다. 통제된 5건으로 {MATCH:2, MISMATCH:1, LEDGER_ONLY:1, CORE_ONLY:1, UNKNOWN_RESOLVED:1}을 실측했고, 여기서 순서 함정을 하나 발견했습니다. 자동 해소의 망취소가 계정계 기록도 바꾸므로, 계정계 스냅샷은 해소 이후에 떠야 합니다. 마지막으로 원장 PG를 DBTower 관제 대상으로 등록 가능하게 준비했습니다.'
descriptionEn: 'Through stage 4 the ledger recorded transactions in three states (SUCCESS/FAILED/UNKNOWN) and could resolve UNKNOWNs manually, but two holes remained. First, the gateway can''t tell a caller''s retry apart: a caller who got a timeout (UNKNOWN) and re-sends the same request creates a new transaction, executed twice at the core as a double transaction. Second, the ledger is a truth that was never reconciled against the core. Stage 5 fills both. The idempotency key claims (key+method+path) atomically via a DB unique constraint, so the DB, not an app lock, collapses concurrent retries into one. An in-flight retry gets 409, and a completed request''s re-receipt replays the stored original response without re-executing. Sending the same balance inquiry twice, the core log shows one request received and the ledger holds one row for it: double transaction zero, verified in psql. EOD reconciliation pulls the core''s same-day processed list (a variable-length message) and matches it against the whole ledger by transaction id, sorting into four types: both-match, amount-mismatch, ledger-only, and core-only. UNKNOWNs are auto-resolved by status-inquiry and net-cancel before matching. A controlled five-record run produced {MATCH:2, MISMATCH:1, LEDGER_ONLY:1, CORE_ONLY:1, UNKNOWN_RESOLVED:1} and surfaced an ordering trap: the net-cancel of auto-resolution also flips the core''s record, so the core snapshot must be taken after resolution. Finally, the ledger PG was prepared to register as a DBTower monitoring target.'
date: 2025-11-08
tags:
  - Java
  - Spring Boot
  - 멱등성
  - 대사
  - PostgreSQL
  - 금융IT
category: personal/gwanmun
coverImage: /uploads/project/gwanmun/cover.svg
draft: false
series: "gwanmun"
seriesOrder: 5
---

## 1. 재전송을 구분 못 하고, 원장은 대조된 적이 없다

[4편](/blog/project/gwanmun/gwanmun-4-audit-and-load)까지 원장은 모든 거래를 3값(SUCCESS/FAILED/**UNKNOWN**)으로 적었고 UNKNOWN을 상태조회·망취소로 해소할 수 있었습니다. 하지만 3편부터 4편까지 "잔여"에 계속 적어 둔 두 문장이 있었습니다.

> 멱등키 없음(같은 요청의 재시도를 게이트웨이가 구분하지 못한다).
> 해소는 수동 트리거만(주기 대사 배치는 확장 지점).

이 둘은 같은 뿌리에서 나옵니다. **타임아웃은 실패가 아니라 미확인(UNKNOWN)이다**. 3편의 이 규칙이 옳으려면, 미확인을 받은 호출자가 그 다음에 무엇을 하느냐를 다뤄야 합니다.

호출자는 504(결과 미확인)를 받으면 자연스럽게 같은 요청을 다시 보냅니다. 그런데 게이트웨이 입장에서 그건 **새 거래**입니다. 새 거래고유번호를 채번하고 새 원장 행을 만들고 계정계에 다시 보냅니다. 계정계에서 첫 요청이 이미 처리됐다면, 두 번째는 **이중 거래**입니다. "임의로 FAILED로 적지 않는다"는 규칙이 이중 거래를 막아 주지는 않습니다. 그건 재시도의 방아쇠를 당기지 않을 뿐이고 방아쇠는 호출자 손에 있습니다.

그리고 원장은 여전히 **한 번도 계정계와 대조된 적이 없는 진실**입니다. "우리 원장에 SUCCESS로 적힌 이 거래가 정말 계정계에서 처리됐나? 우리가 UNKNOWN으로 둔 저 거래를 계정계는 처리했나?" 이걸 확인하는 절차가 없었습니다. 실무 조사에서 반복해서 나온 문장이 "대사가 신뢰도를 결정한다, 특히 취소·미확인 건에서"였습니다.

그래서 이번 편의 두 축이 정해졌습니다. **재전송을 게이트웨이가 막고(멱등키), 매일 장부를 대조한다(EOD 대사).**

## 2. 멱등키의 동시성 열쇠는 앱 락이 아니라 DB 유니크 제약

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

한 가지 결정을 더 했습니다. **내부 포화(풀 고갈·서킷 OPEN)의 503은 원응답으로 굳히지 않습니다.** 그건 계정계로 나가지도 못한 일시적 실패라, 같은 멱등키로 재시도할 수 있게 선점을 놓아줍니다(`release`). 반대로 504(결과 미확인)는 저장합니다. 같은 키의 재전송에 "역시 미확인"을 돌려주는 게, 새로 계정계를 두드리는 것보다 옳으니까요.

## 3. 멱등키 실측으로 이중 거래 0

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

같은 키에 다른 계좌번호를 실으면 422로 거절됩니다. 멱등키는 "같은 요청"에만 유효한 약속입니다. 아무 요청에나 갖다 붙인다고 통과되지는 않으니까요.

## 4. EOD 대사의 4유형 분류, 그리고 순서 함정

대사는 게이트웨이 원장과 계정계 실제 처리내역을 대조합니다. 그러려면 계정계에서 "그 날 처리한 거래 전부"를 받아 와야 합니다. 목업 계정계에 **당일 처리내역 전체 조회** 가변 전문(0500 요청 → 0510 응답, 레코드 N건)을 하나 추가했습니다. 잔액조회 계정계와 **같은 인메모리 원장을 공유**하는 별도 포트(9097, 길이 프리픽스 프레이밍)로 답하게 해서 이 계정계가 처리·취소한 그대로가 대사 응답에 나옵니다.

대조는 거래고유번호를 열쇠로 네 유형으로 가릅니다.

- **MATCH** 양쪽에 다 있고 금액·상태가 맞는 정상 건.
- **MISMATCH** 양쪽에 다 있지만 금액이나 상태가 어긋난 건.
- **LEDGER_ONLY** 우리 원장에만 있는 건(계정계는 처리 안 했는데 원장은 SUCCESS).
- **CORE_ONLY** 저쪽 계정계에만 있는 건(계정계는 처리했는데 원장은 UNKNOWN이거나 아예 누락).

그리고 대조 **전에** UNKNOWN을 자동 해소합니다. 3편의 해소 절차(상태조회 → 처리됐으면 망취소 → CANCELED, 미처리면 FAILED)를 그대로 돌립니다. 미확인이 남은 채로 대조하면 진짜 불일치인지 "아직 모름"인지가 뒤섞이니까요.

여기서 실측 중에 순서 함정을 하나 밟았습니다. 처음엔 이렇게 짰습니다.

```
1. 계정계 당일 처리내역 스냅샷을 뜬다
2. 원장의 UNKNOWN을 자동 해소한다(망취소 포함)
3. 스냅샷 vs 원장을 분류한다
```

돌려 보니 방금 CANCELED로 해소한 거래가 "원장 취소 vs 계정계 정상"이라며 MISMATCH로 찍혔습니다. 이유는 명백했습니다. **자동 해소의 망취소는 계정계 기록도 바꿉니다**(정상 → 취소). 그런데 계정계 스냅샷을 2단계 전에 떠 놨으니, 스냅샷 속 그 거래는 아직 "정상"이었던 겁니다. 억울한 불일치죠.

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

## 5. 통제된 5건으로 본 EOD 대사 실측

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

## 6. DBTower 연계로 원장 PG를 관제 밖에서 본다

마지막 축은 [DBTower](https://github.com/dj258255/dbtower)와의 느슨한 연결입니다. gwanmun은 데이터 경로 **위**에서 전문을 중계하는 인라인 미들웨어이고 DBTower는 데이터 경로 **밖**에서 DB를 관찰하는 아웃오브밴드 관제탑입니다. 성격이 정반대라 별도 저장소로 두되, 원장 PG를 DBTower의 관측 대상으로 등록하는 것만 연결합니다.

왜 원장 PG일까요. 부하가 커지면 모든 거래 경로가 지나는 원장 insert에서 경합·슬로우쿼리·락이 생깁니다. 4편의 `gwanmun.ledger.dropped` 카운터는 유실을 세지만 **왜** 느린지는 못 봅니다. 그건 gwanmun 자신이 안에서 못 보는 것(자기 커넥션 지연은 알아도 DB 서버 관점의 경합·플랜은 모름)이고 관제가 밖에서 `pg_stat_statements`로 봅니다.

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

## 7. 잔여, 정직하게 안 한 것

- **DBTower 앱 미기동**: 대상 DB 준비 + 관제가 볼 수치를 모니터 계정으로 실측하는 데까지입니다. 등록 API 실호출·대시보드 캡처는 안 했습니다.
- **대사는 잔액조회 중심**: 계정계 시뮬레이터가 잔액만 기록하므로 대조 수치도 잔액입니다. 이체·다계좌 대사는 확장 지점입니다.
- **멱등키 스코프**: `(키+메서드+경로)` + DB 유니크 선점입니다. 다중 노드도 같은 PG를 보면 성립하지만, 채번·대사는 여전히 단일 노드 전제입니다. 스케줄러 cron은 기본 비활성이라 데모는 수동 트리거로 돕니다.

테스트는 **168건**(기존 150 + 이번 편 18)이 그린이고 모듈 경계 `verify()`도 그대로 그린입니다. 각 단계의 함정·판단·검증은 저장소의 [ROADMAP](https://github.com/dj258255/gwanmun/blob/main/docs/ROADMAP.md)·[VERIFICATION](https://github.com/dj258255/gwanmun/blob/main/docs/VERIFICATION.md)에 있습니다.

3편에서 "타임아웃은 실패가 아니라 미확인"이라고 적었을 때, 그 규칙이 온전해지려면 미확인 이후의 세계, 곧 호출자의 재전송과 장부의 대조를 다뤄야 한다는 걸 이번에야 마무리했습니다. 재전송을 막고 매일 장부를 대조합니다.

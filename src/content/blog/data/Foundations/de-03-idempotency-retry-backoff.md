---
title: '[DE Ch-03] 멱등성과 재시도·백오프: 몇 번 돌려도 같은 결과와 흩어지는 재시도'
description: 오케스트레이터는 실패한 태스크를 처음부터 다시 돌립니다. 그래서 태스크는 몇 번을 돌려도 같은 결과를 내야 합니다. append와 파티션 덮어쓰기를 DuckDB로 비교하고 지운 직후 죽는 경우를 트랜잭션으로 막습니다. 지터 없는 지수 백오프가 서버가 살아나는 순간 요청을 한꺼번에 몰아오는 것과 지터가 그 대가로 늦추는 것을 시뮬레이션으로 셉니다.
date: 2026-10-19T00:00:00.000Z
tags:
  - Data Engineering
  - Idempotency
  - Retry
  - Exponential Backoff
  - Jitter
  - Airflow
  - Argo Workflows
  - DuckDB
category: data/Foundations
topics:
  - pipeline
  - distributed
draft: false
series: "DE 공부"
seriesOrder: 3
---

## 결론부터

1. 오케스트레이터의 재시도는 실패한 태스크를 처음부터 다시 실행합니다. 태스크가 멱등하지 않으면 재시도가 중복 데이터를 만듭니다.
2. 데이터 파이프라인에서 멱등성을 만드는 가장 흔한 방법은 결과를 파티션 단위로 통째로 덮어쓰는 것입니다. 지우기와 넣기는 한 트랜잭션으로 묶어야 합니다. 지운 직후 죽으면 중복보다 나쁜 결과, 데이터가 사라진 파티션이 남습니다.
3. 태스크 안에서 `now()`나 "가장 최근 데이터"를 읽으면 같은 실행을 다시 돌려도 입력이 달라집니다. 실행마다 처리할 구간을 인자로 받아야 합니다.
4. 지터 없는 지수 백오프는 같은 순간 실패한 클라이언트들이 같은 순간 다시 시도하게 만듭니다. 시뮬레이션에서 서버가 살아난 직후 1초에 1,000건이 몰렸고 full jitter를 넣으니 44건이었습니다. 대신 마지막 클라이언트가 성공한 시각이 31초에서 88초로 늦어졌습니다.
5. 재시도는 횟수 상한과 예산을 두고 한 계층에서만 합니다. 계층마다 재시도하면 호출 수가 곱으로 늘어납니다.

---

## 1. "실패하면 다시 돌리면 되지"의 전제

Ch-02에서 오케스트레이터가 실패한 태스크를 재시도한다고 했습니다. 용어를 다시 짚으면 태스크는 "주문 집계 SQL 한 번 돌리기"처럼 파이프라인을 이루는 일 하나이고 오케스트레이터는 Airflow나 Argo Workflows처럼 태스크를 순서대로 띄우고 실패하면 다시 띄우는 프로그램입니다. Astronomer 문서는 이 재시도가 태스크를 처음부터 다시 실행한다고 적습니다. 실패 직전까지 한 일을 기억해 이어서 하지 않습니다.

그러면 질문이 하나 생깁니다. 실패하기 전에 이미 한 일은 어떻게 되는지입니다. 일일 매출을 집계해서 테이블에 넣는 태스크가 넣기까지 끝낸 뒤 알림 단계에서 실패했다면 재시도는 같은 매출을 한 번 더 넣습니다. 재시도가 안전하려면 태스크가 몇 번을 돌아도 같은 결과를 내야 합니다. 이 성질이 멱등성(idempotency)입니다.

## 2. 멱등성: 결과와 상태가 같아야 한다

멱등성은 같은 연산을 한 번 하든 여러 번 하든 결과가 같은 성질입니다. 수학에서는 절댓값이 예입니다. |−3|에 절댓값을 또 씌워도 3입니다.

시스템에서는 돌려받는 값만 같아서는 부족합니다. 저장된 상태까지 같아야 합니다. 토스페이먼츠의 멱등성 글이 HTTP 메서드로 이 차이를 설명합니다.

| 메서드 | 멱등한지 | 이유 |
|---|---|---|
| GET | 멱등 | 상태를 바꾸지 않는다 |
| PUT | 멱등 | 같은 값으로 몇 번 덮어써도 결과 상태가 같다 |
| DELETE | 멱등 | 이미 지운 것을 또 지워도 상태는 "없음"으로 같다 |
| POST | 멱등하지 않음 | 호출할 때마다 새 리소스가 생길 수 있다 |

결제 API는 POST를 멱등하게 만들려고 멱등키(`Idempotency-Key`)를 씁니다. 같은 키로 다시 오면 처리하지 않고 저장해 둔 첫 응답을 돌려줍니다. 결제 쪽 이야기는 [멱등키 보관 기간을 정한 글](/blog/project/be-commerce/be-commerce-ch4-my-docs-were-wrong)에서 다뤘고 이 글은 데이터 파이프라인 쪽에 맞춥니다.

## 3. 데이터 파이프라인에서 멱등성이 깨지는 세 가지

### 3-1. INSERT로 쌓는다

Airflow 3.2 Best Practices는 "재실행할 때 INSERT를 쓰지 말라"고 적습니다. INSERT는 돌린 횟수만큼 행을 더합니다. 대신 UPSERT를 쓰라고 권합니다.

UPSERT는 UPDATE와 INSERT를 합친 말입니다. 키가 같은 행이 이미 있으면 고치고 없으면 넣습니다. PostgreSQL과 DuckDB에서는 이렇게 씁니다.

```sql
-- daily_sales(day DATE PRIMARY KEY, total BIGINT)처럼 day에 기본 키가 있어야 한다
INSERT INTO daily_sales (day, total) VALUES ('2026-10-01', 42000)
ON CONFLICT (day) DO UPDATE SET total = excluded.total;
-- 처음 돌면: 10/1 행이 생긴다
-- 다시 돌면: 10/1 행이 이미 있으니 total만 42000으로 다시 쓴다. 행은 여전히 하나
```

`ON CONFLICT (day)`가 "같은 날짜 행이 이미 있으면"이고 `excluded`는 방금 넣으려다 막힌 값을 가리킵니다. 같은 문장을 열 번 돌려도 10/1 행은 하나입니다.

### 3-2. `now()`로 처리 구간을 정한다

"어제 매출"을 `now() - 1일`로 계산하는 태스크를 생각해 봅시다. 10월 2일 새벽에 돌면 10월 1일을 집계합니다. 이 실행이 실패해서 10월 3일에 재시도하면 10월 2일을 집계합니다. 같은 실행을 다시 돌렸는데 다른 날을 처리한 것입니다. 같은 문서가 태스크 안에서 `now()`를 중요한 계산에 쓰지 말라고 적은 이유입니다. 처리할 구간은 오케스트레이터가 실행마다 넘겨주는 값(Airflow의 `data_interval_start`)으로 정합니다. 다만 Airflow 3의 기본 설정에서는 이 값이 트리거 시각과 같아서 "어제"를 가리키지 않습니다. 구간을 1일로 잡는 설정이 따로 필요하고 [Ch-04](/blog/data/foundations/de-04-logical-date-backfill)에서 자세히 다룹니다.

### 3-3. "가장 최근 데이터"를 읽는다

입력 테이블의 최신 상태를 읽는 태스크는 재실행 사이에 누군가 입력을 고치면 다른 결과를 냅니다. 문서는 고정된 파티션을 읽으라고 권합니다.

세 경우의 공통점은 같은 실행이 다시 돌 때 입력이나 쓰기 방식이 달라진다는 것입니다. 멱등한 태스크는 입력을 고정하고(구간을 인자로 받는다), 쓰기를 덮어쓰기로 만듭니다.

## 4. 멱등하게 만드는 세 가지 방법

표를 보기 전에 파티션이라는 말을 정리합니다. 큰 테이블을 날짜 같은 기준으로 잘라 따로 보관한 조각입니다. 주문 테이블을 날짜로 나눴다면 `day=2026-10-01` 조각, `day=2026-10-02` 조각이 따로 있고 "10월 1일 조각만 통째로 지우고 다시 쓰기"가 다른 날을 건드리지 않고 가능합니다. 객체 스토리지라면 날짜별 폴더 하나가 파티션 하나입니다.

| 방법 | 하는 일 | 맞는 경우 | 비용 |
|---|---|---|---|
| 파티션 덮어쓰기 | 그 날짜 파티션을 지우고 다시 넣는다 | 날짜처럼 결과를 통째로 다시 계산할 수 있는 단위가 있을 때 | 파티션 전체를 다시 쓴다. 지우기와 넣기 사이가 비면 안 된다 |
| UPSERT / MERGE | 키가 있으면 고치고 없으면 넣는다 | 행마다 키가 있고 일부만 바뀔 때 | 키 설계가 필요하다. 원본에서 사라진 행은 지워지지 않는다 |
| 입력 해시로 건너뛰기 | 같은 입력으로 이미 돈 적 있으면 아무것도 안 한다 | 입력 파일 단위로 처리할 때 | 해시와 실행 기록을 따로 저장해야 한다 |

Airflow를 만든 Maxime Beauchemin은 2018년 글 "Functional Data Engineering"에서 첫 번째 방법을 원칙으로 정리했습니다. 태스크를 입력만으로 출력이 정해지는 순수 함수처럼 만들고 결과는 파티션 단위로 통째로 덮어쓰며 이미 쓴 파티션을 부분적으로 고치지 않는다는 것입니다. 순수 함수는 같은 입력을 넣으면 언제 몇 번 불러도 같은 값을 돌려주고 바깥 상태를 몰래 바꾸지 않는 함수입니다. `add(2, 3)`은 순수하고 "현재 시각을 읽어 더하는 함수"는 순수하지 않습니다. Spark의 `partitionOverwriteMode=dynamic`(이번에 쓴 데이터가 들어 있는 파티션만 바꾸고 나머지는 둔다), Delta Lake의 `replaceWhere`(조건에 맞는 행만 새 데이터로 바꾼다)가 이 방식을 구현한 기능입니다.

UPSERT의 비용 칸에 적은 "원본에서 사라진 행"은 놓치기 쉽습니다. 주문이 취소되어 원천에서 빠졌다면 UPSERT는 그 행을 건드리지 않으므로 이전 실행이 넣은 행이 남습니다. 파티션 덮어쓰기는 파티션을 통째로 다시 만드니 이 문제가 없습니다.

## 5. 재현 1: 덮어쓰기 도중에 죽으면

### 5-1. 조건

- DuckDB에 주문 3건을 넣고 일일 매출 테이블 `daily_sales`에 적재합니다. 10월 1일 매출은 30,000원 + 12,000원 = 42,000원입니다.
- 네 경우를 비교합니다. append를 두 번, 덮어쓰기를 두 번, 트랜잭션 없이 지운 직후 죽음, 트랜잭션 안에서 지운 직후 죽음.
- 코드는 [labs/de-study/ch03](https://github.com/dj258255/IT-Oasis/tree/main/labs/de-study/ch03)의 `idempotent_load.py`입니다.

```python
def overwrite(day, crash=False, tx=True):
    """그 날짜 파티션을 지우고 다시 넣는다. crash=True면 지운 직후 죽는다."""
    if tx:
        con.execute("BEGIN")
    try:
        con.execute("DELETE FROM daily_sales WHERE day = ?", [day])
        if crash:
            raise RuntimeError("지우고 넣기 전에 죽음")
        con.execute(INSERT_SQL, [day])
        if tx:
            con.execute("COMMIT")
    except RuntimeError:
        if tx:
            con.execute("ROLLBACK")
```

함수가 하는 일을 순서대로 적으면 이렇습니다.

1. `tx=True`면 `BEGIN`으로 트랜잭션을 엽니다. 이제부터의 변경은 `COMMIT` 전까지 "임시"입니다.
2. 그 날짜 행을 `DELETE`로 지웁니다.
3. `crash=True`면 여기서 일부러 예외를 던집니다. 워커가 지우기 직후 죽은 상황을 흉내 낸 것입니다.
4. 죽지 않았다면 `INSERT_SQL`로 주문 테이블에서 그날 매출을 다시 계산해 넣고 `COMMIT`으로 확정합니다.
5. 예외가 났으면 `ROLLBACK`으로 1번 이후의 변경을 모두 없던 일로 돌립니다.

`tx=False`면 1, 4, 5번의 트랜잭션 문장이 빠집니다. 이때 DuckDB는 문장 하나하나를 그 자리에서 확정하는 자동 커밋(autocommit)으로 동작합니다. `DELETE`는 실행되는 순간 확정되고 되돌릴 방법이 없습니다.
### 5-2. 결과

| 경우 | `daily_sales` 결과 |
|---|---|
| append 두 번 | 10월 1일 행 두 개(42,000원, 42,000원) |
| 덮어쓰기 두 번 | 10월 1일 행 하나(42,000원) |
| 트랜잭션 없이 지운 직후 죽음 | 10월 1일 행이 없음 |
| 트랜잭션 안에서 지운 직후 죽음 | 롤백되어 10월 1일 42,000원이 남음 |

처음에는 덮어쓰기면 멱등성이 끝난다고 생각했습니다. 세 번째 줄이 그 생각을 깼습니다. DELETE가 자동 커밋으로 먼저 반영된 뒤 INSERT 전에 죽으면 파티션이 비어 버립니다. append의 중복은 합계가 이상해서 눈에 띄기라도 하지만 빈 파티션은 "그날 매출이 0원"과 구분이 안 됩니다. 재시도가 성공하면 다시 채워지지만 재시도가 돌기 전까지 그 테이블을 읽은 쪽은 틀린 값을 봅니다.

지우기와 넣기를 한 트랜잭션으로 묶으면 중간에 죽어도 롤백되어 이전 결과가 남습니다. 트랜잭션을 쓸 수 없는 저장소(객체 스토리지 위의 파일)에서는 새 결과를 다른 위치에 다 쓴 뒤 가리키는 곳만 바꾸는 방식을 씁니다.

폴더로 그려 보면 이렇습니다.

1. 지금 읽는 쪽은 `daily_sales/day=2026-10-01/`을 봅니다.
2. 재계산 결과는 `_tmp/run-42/day=2026-10-01/`에 처음부터 끝까지 씁니다. 이 동안 읽는 쪽은 옛 결과를 계속 봅니다.
3. 다 쓴 뒤에 "10/1 파티션은 이제 `run-42` 쪽"이라고 가리키는 정보 하나만 바꿉니다.

2번 도중에 죽으면 `_tmp`에 쓰다 만 파일이 남을 뿐이고 읽는 쪽은 여전히 온전한 옛 결과를 봅니다. 빈 파티션이 보이는 순간이 없습니다. Spark의 동적 파티션 덮어쓰기도 임시 디렉터리에 쓴 뒤 커밋 시점에 파티션을 바꿔치기합니다. Iceberg 같은 테이블 포맷이 스냅샷 단위로 커밋하는 것도 같은 문제를 푸는 방법이고 Ch-18에서 다룹니다.

## 6. 재시도: 무엇을, 몇 번, 어디서

### 6-1. 재시도할 오류와 하지 않을 오류

Google SRE Book 22장은 재시도할 수 있는 오류와 없는 오류를 나누라고 합니다. 잘못된 요청이나 영구 오류는 몇 번을 다시 해도 성공하지 않습니다.

| 오류 | 재시도 | 예 |
|---|---|---|
| 일시적 | 한다 | 네트워크 끊김, 타임아웃, 과부하 응답 |
| 영구적 | 하지 않는다 | 잘못된 입력, 권한 없음, 스키마 불일치 |

도구도 이 구분을 지원합니다.

- Airflow: 태스크 안에서 `AirflowFailException`을 던지면 남은 재시도와 상관없이 바로 실패합니다.
- Argo Workflows: `retryPolicy`로 어떤 실패를 재시도할지 고릅니다. `OnFailure`(기본, main 컨테이너 실패), `OnError`(컨트롤러 오류나 init·wait 컨테이너 실패), `OnTransientError`(일시적 오류로 정의된 것), `Always` 중 하나이고 `expression`으로 `lastRetry.exitCode` 같은 조건을 더할 수 있습니다. 둘은 AND로 묶입니다.

### 6-2. 횟수 상한과 재시도 예산

SRE Book은 요청 하나의 재시도 횟수에 상한을 두고 프로세스 전체에도 예산을 두라고 합니다. 예시로 든 값은 프로세스당 분당 재시도 60회이고 예산을 다 쓰면 재시도 없이 실패시킵니다. 상한만 있으면 장애 중에 모든 요청이 상한까지 재시도해서 부하가 몇 배로 불어납니다.

숫자로 보면 두 장치의 차이가 분명합니다. 분당 1,000건을 보내는 서버가 있고 요청마다 재시도 상한이 3회라고 하겠습니다.

| 상황 | 상한만 있을 때 | 상한 + 분당 예산 60회 |
|---|---|---|
| 평소(실패 1%) | 재시도 분당 10회 남짓 | 같음. 예산 안이다 |
| 장애(실패 100%) | 1,000건 × 3회 = 재시도 분당 3,000회, 원래의 네 배 부하 | 재시도 60회에서 멈춘다. 부하는 1,060건 정도 |

평소에는 둘이 똑같이 동작하고 장애가 났을 때만 예산이 차이를 만듭니다. 서버가 가장 약할 때 부하를 네 배로 키우지 않는 것이 예산의 일입니다.

### 6-3. 계층마다 재시도하면 곱으로 늘어난다

같은 장에 나오는 계산입니다. 네 계층이 각자 네 번씩 시도하면 사용자 요청 하나가 DB에 4 × 4 × 4 = 64번 도달할 수 있습니다.

곱이 되는 이유는 위 계층의 재시도 한 번마다 아래 계층이 처음부터 자기 재시도를 다시 하기 때문입니다. 프런트엔드 → 백엔드 → DB 접근 계층 → DB 순서라면 DB 접근 계층이 DB에 네 번 시도하고 실패를 올려보내면 백엔드가 그걸 한 번의 실패로 보고 다시 부릅니다. 백엔드의 네 번 각각이 DB 네 번이니 16번이고 프런트엔드의 네 번이 다시 이걸 감싸 64번이 됩니다. AWS Builders' Library도 재시도는 스택의 한 곳에서만 하라고 권합니다. 오케스트레이터가 태스크를 재시도한다면 태스크 안의 HTTP 클라이언트까지 재시도하는지 확인해야 합니다. 둘 다 세 번씩이면 외부 API는 아홉 번 호출을 받습니다.

결제 API에서 같은 문제를 측정한 글이 [결제 재시도는 가용성을 높이는가, 장애를 증폭하는가](/blog/project/be-commerce/be-commerce-ch26-payment-retries-retry-storm)와 [재전송을 켰더니 느린 PG에서 결제 실패가 늘었다](/blog/project/be-commerce/be-commerce-ch60-resend-budget)입니다.

## 7. 재현 2: 지수 백오프와 지터

용어 셋을 먼저 풀어 둡니다.

- **백오프(backoff)**: 실패하면 바로 다시 하지 않고 조금 물러나 기다렸다가 하는 것입니다.
- **지수 백오프**: 기다리는 시간을 실패할 때마다 두 배로 늘립니다. 1초, 2초, 4초, 8초처럼 갑니다. 서버가 잠깐 끊긴 거라면 금방 다시 붙고 오래 죽어 있다면 점점 덜 두드립니다.
- **지터(jitter)**: 기다리는 시간에 무작위 값을 섞는 것입니다. 모든 클라이언트가 같은 공식을 쓰면 같은 순간 실패한 클라이언트들이 같은 순간 다시 시도하는데 지터가 이 박자를 흩뜨립니다.

### 7-1. 조건

- 클라이언트 1,000개가 0초에 동시에 실패합니다. 서버는 30초 동안 죽어 있다가 살아납니다.
- 백오프는 1초에서 시작해 실패할 때마다 두 배, 상한 60초입니다.
- 지터는 세 가지를 비교합니다. AWS Architecture Blog의 "Exponential Backoff And Jitter"에 나온 방식입니다.
  - none: 지터 없음. 대기 = min(60, 1 × 2^시도)
  - full: 0과 대기 사이에서 무작위
  - equal: 대기의 절반 + 0과 절반 사이 무작위
- 방식마다 `random.seed(1)`로 고정해서 어디서 돌려도 같은 값이 나옵니다. 실제 서버와 네트워크를 쓰지 않는 시뮬레이션이라 서버가 받은 요청 수를 그대로 셉니다.
- 코드는 같은 폴더의 `backoff_jitter.py`입니다.

```python
def next_delay(mode, attempt):
    delay = min(CAP, BASE * 2 ** attempt)
    if mode == "full":
        return random.uniform(0, delay)
    if mode == "equal":
        return delay / 2 + random.uniform(0, delay / 2)
    return delay                       # none: 지터 없음
```

`attempt`는 0부터 셉니다. 지터가 없으면 대기는 2^0 = 1초, 2^1 = 2초, 4초, 8초, 16초이고 이걸 차례로 더한 1, 3, 7, 15, 31초에 재시도가 일어납니다. full은 같은 상한 안에서 `random.uniform(0, delay)`로 0초부터 상한까지 아무 값이나 뽑고 equal은 앞 절반을 보장한 뒤 뒤 절반만 무작위로 뽑습니다. 세 번째 시도(상한 4초)라면 none은 정확히 4초, full은 0~4초, equal은 2~4초를 기다립니다.

### 7-2. 결과

| 방식 | 죽어 있는 동안 재시도 | 살아난 뒤 1초에 가장 많이 몰린 요청 | 마지막 클라이언트가 성공한 시각 |
|---|---|---|---|
| none | 4,000건 | 1,000건(31초) | 31초 |
| full | 5,539건 | 44건(34초) | 88초 |
| equal | 5,000건 | 76건(51초) | 59초 |

![클라이언트 1,000개가 0초에 실패하고 서버가 30초에 살아날 때 1초마다 서버에 들어온 요청 수를 세 줄로 그린 막대 그림. 지터가 없으면 1, 3, 7, 15초에 1,000건씩 재시도하고 31초에 1,000건이 한꺼번에 들어온다. full jitter는 처음 몇 초에 재시도가 몰렸다가 줄어들고 살아난 뒤 요청은 30초부터 88초까지 낮게 퍼진다. equal jitter는 살아난 뒤 요청이 34초부터 59초 사이에 퍼진다](/uploads/data/de-03-idempotency-retry-backoff/retry-timeline.svg)

그림은 `backoff_jitter.py`와 같은 계산을 1초 단위로 그대로 그린 것입니다. 회색 칸이 서버가 죽어 있던 30초이고 그 오른쪽이 살아난 뒤입니다.

지터가 없으면 1,000개 클라이언트가 1, 3, 7, 15, 31초에 정확히 같이 재시도합니다. 서버가 30초에 살아나도 31초에 1,000건이 한꺼번에 들어옵니다. 막 살아난 서버가 이 몰림을 못 버티면 다시 죽고 클라이언트들은 다시 같은 박자로 기다립니다. full jitter는 같은 1초에 몰리는 요청을 44건까지 줄였습니다.

처음에는 지터가 부하를 모든 면에서 줄인다고 생각했습니다. 표의 나머지 두 열은 그렇지 않다는 걸 보여 줍니다.

- 죽어 있는 동안의 재시도는 오히려 늘었습니다(4,000건 → 5,539건). full jitter는 대기를 0에 가깝게 뽑을 수 있어서 초반에 재시도를 더 자주 합니다. 그림의 full 줄 맨 왼쪽 막대가 그 흔적입니다. 첫 대기가 0~1초에서 뽑히니 1,000개 모두 첫 1초 안에 한 번 재시도하고 뒤이은 대기까지 짧게 뽑힌 클라이언트는 같은 1초 안에 한두 번 더 해서 0초 칸에만 1,271건이 찍힙니다.
- 마지막 클라이언트가 성공한 시각은 31초에서 88초로 늦어졌습니다. 운 나쁘게 대기가 길게 뽑힌 클라이언트는 서버가 살아난 뒤에도 한참 기다립니다.

equal jitter는 대기의 절반을 보장해서 두 극단 사이에 있습니다. 몰림은 76건으로 full보다 조금 많고 마지막 성공은 59초로 full보다 빠릅니다. AWS 글이 full jitter를 기본으로 권하면서 equal jitter를 아주 짧은 대기를 피하는 대안으로 소개한 이유가 이 표에서 보입니다.

## 8. Airflow와 Argo의 재시도 설정

| | Airflow 3.2 | Argo Workflows |
|---|---|---|
| 횟수 | `retries` | `retryStrategy.limit`(첫 시도는 세지 않음) |
| 대기 | `retry_delay` | `backoff.duration` |
| 지수 증가 | `retry_exponential_backoff`(3.2부터 배수를 float로 지정 가능) | `backoff.factor` |
| 상한 | `max_retry_delay`, 전역 상한 `[core] max_task_retry_delay`(기본 24시간) | `backoff.maxDuration` |
| 재시도 조건 | `AirflowFailException`으로 즉시 실패 | `retryPolicy`, `expression` |

Argo의 `backoff` 세부 필드(`duration`, `factor`, `maxDuration`)는 공식 Retries 페이지에 설명이 없어서 2차 자료로 확인했습니다. 둘 다 재시도 대기에 지터를 넣는 설정이 있는지는 이번에 확인하지 못했습니다.

## 9. 중국 빅테크 사례: 스케줄러가 재시도할 때

- **快手**(2022): 자체 스케줄러의 실행 목표를 "정확히 한 번 실행, 빠뜨리지 않고 되도록 두 번 돌리지 않기"로 적었습니다. 상태 기계로 잘못된 상태 전이를 막고 재시도하기 전에 이전 인스턴스를 정리합니다. 이전 인스턴스가 아직 살아서 쓰고 있는데 새 인스턴스가 같은 파티션을 쓰면 5절의 덮어쓰기도 깨지기 때문입니다.
- **Tencent Lhotse**(2015): 재시도를 같은 기계에서 다시 하는 것과 다른 기계로 옮겨 하는 것 두 가지로 나누고 같은 기계 재시도를 먼저 합니다. 연속으로 실패한 기계는 블랙리스트에 올려 일정 시간 스케줄링에서 뺍니다. 6-1절의 "재시도할 오류와 하지 않을 오류"를 기계 단위로 구분한 셈입니다.
- **Tencent US**(2023): 상태 제출을 재시도할 때 간격을 점점 늘린다고 적었습니다(7절의 지수 백오프).

## 10. 범위와 한계

- 재현 1은 DuckDB 단일 프로세스입니다. 객체 스토리지 위의 파일이나 분산 테이블에서는 트랜잭션 대신 다른 원자적 교체 방법이 필요하고 여기서는 다루지 않았습니다.
- 재현 2는 시뮬레이션입니다. 서버가 요청을 처리하는 데 걸리는 시간, 몰림 때문에 서버가 다시 죽는 효과는 넣지 않았습니다. 그래서 "몰리면 다시 죽는다"는 이 재현으로 보인 것이 아니고 SRE Book과 AWS 글의 설명입니다.
- decorrelated jitter는 비교하지 않았습니다.
- Beauchemin의 "Functional Data Engineering" 원문은 이번에 직접 열지 못했습니다(Medium 접근 제한). 4절의 요약은 널리 알려진 원칙을 옮긴 것이니 원문으로 확인하길 권합니다.

## 11. 헷갈렸던 것

**Q. 멱등하면 재시도를 무제한으로 해도 되나요?**

결과는 안전해도 부하는 안전하지 않습니다. 멱등성은 "여러 번 해도 결과가 같다"는 보장이고 여러 번 하는 비용은 그대로 듭니다. 장애 중에 모든 클라이언트가 무제한 재시도하면 서버가 회복할 틈이 없습니다. 그래서 6-2절의 상한과 예산이 필요합니다.

**Q. 처리는 됐는데 성공 응답만 못 받았으면 어떻게 하나요?**

Stripe의 멱등성 글이 이 경우를 따로 나눕니다. 처리가 원자적으로 롤백된 실패는 통째로 다시 하면 됩니다. 처리는 끝났는데 응답만 잃었다면 다시 요청했을 때 서버가 다시 처리하지 않고 저장해 둔 첫 결과를 돌려줘야 합니다. 데이터 파이프라인으로 옮기면 적재는 끝났는데 오케스트레이터가 성공을 기록하기 전에 워커가 죽은 경우입니다. 재시도가 다시 적재하더라도 덮어쓰기라면 결과가 같으니 문제가 없습니다.

**Q. 백오프 상한(cap)은 왜 두나요?**

상한 없이 두 배씩 늘리면 열 번째 재시도는 1초 × 2^10 = 약 17분 뒤입니다. 서버가 이미 살아났는데 클라이언트는 한참 기다립니다. 상한은 회복 뒤의 최대 대기 시간을 정합니다. 재현 2에서 상한을 60초로 둔 것도 그래서입니다.

## 참고 자료

- Maxime Beauchemin, [Functional Data Engineering: a modern paradigm for batch data processing](https://maximebeauchemin.medium.com/functional-data-engineering-a-modern-paradigm-for-batch-data-processing-2327ec32c42a), 2018
- [Airflow 3.2 Best Practices](https://airflow.apache.org/docs/apache-airflow/3.2.2/best-practices.html)
- Astronomer, [Rerun Airflow Dags and tasks](https://www.astronomer.io/docs/learn/airflow-3/rerunning-dags)
- [Argo Workflows Retries](https://argo-workflows.readthedocs.io/en/latest/retries/)
- Google, [Site Reliability Engineering 22장 Addressing Cascading Failures](https://sre.google/sre-book/addressing-cascading-failures/)
- Amazon, [Timeouts, retries, and backoff with jitter](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter)
- AWS Architecture Blog, [Exponential Backoff And Jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/)
- Stripe, [Designing robust and predictable APIs with idempotency](https://stripe.com/blog/idempotency)
- 토스페이먼츠, [멱등성이 뭔가요?](https://www.tosspayments.com/blog/articles/dev-1)
- Databricks, [Selectively overwrite data with Delta Lake](https://docs.databricks.com/gcp/delta/selective-overwrite)
- Cloudera, [Spark Dynamic Partition overwriting](https://docs.cloudera.com/runtime/latest/cloud-data-access/topics/cr-cda-manifest-committer-spark-dynamic-partition.html)
- [PostgreSQL INSERT ... ON CONFLICT](https://www.postgresql.org/docs/current/sql-insert.html#SQL-ON-CONFLICT)
- Seonggil Jeong, [Airflow Best Practices 번역](https://medium.com/@seonggil/airflow-best-practices-0db503a5e3f2): 공식 Best Practices를 한국어로 옮기고 UPSERT, 고정 파티션 읽기를 정리한 글
- 실습 코드: [labs/de-study/ch03](https://github.com/dj258255/IT-Oasis/tree/main/labs/de-study/ch03)

중국과 국내 빅테크 사례
- 张蕤(快手), [快手大数据任务调度系统设计与实践](https://www.tonguebusy.com/a/tuiguang/weixintuiguang/1107.html), DataFunTalk 재게시, 2022
- 腾讯大数据, [全民拥抱Docker云--Lhotse系统经验分享](https://cloud.tencent.cn/developer/article/1030033), 2015
- 马朋勃(Tencent), [腾讯大数据分布式任务调度平台——US](https://www.modb.pro/db/647438), DataFun 재게시, 2023

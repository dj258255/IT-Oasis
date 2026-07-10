---
title: '커밋마다 검증되고, 침묵해도 잡히고, 계약을 어기면 막힌다 — CI·deadman·dbt contracts'
titleEn: 'Verified on Every Commit, Caught Even in Silence, Blocked on a Broken Contract — CI, Deadman, dbt Contracts'
description: "8편에서 tests/를 열어 pytest 35개로 로직을 고정했는데, 그건 제 노트북에서만 도는 로컬 자산이었어요. 커밋이 강제하지 않으면 며칠 뒤 누군가 테스트를 깨고도 초록불이라 착각합니다. 게다가 알림은 여전히 '실패하면 운다'뿐인데, 감사가 실제로 지적한 사건은 정반대였습니다 — 원천 수집기가 21시간 침묵했는데 아무 알림이 없었어요. 태스크가 시작조차 안 했으니 on_failure_callback이 불릴 일도 없었던 거죠. 마지막으로 마트 스키마는 계약이 없어서, 컬럼 타입을 바꿔도 발행 전까지 아무도 모릅니다. 세 구멍을 셋 다 닫았습니다. CI(GitHub Actions 3관문: ruff·pytest·dbt)가 커밋마다 강제하는데, 임베디드 DuckDB라 MinIO도 PG도 없는 러너에서 tiny 픽스처 parquet 몇 장으로 dbt build를 e2e로 돌립니다(모델+데이터 테스트+계약+unit test 4건, 러너 안에서 PASS=25 실측). dbt unit test로 델타 로직 엣지 네 개를 정적 입력→기대 출력으로 고정했고(first-vs-last·순리셋 클램프·하루 1스냅샷·지문 SUM). deadman heartbeat는 성공 시 카탈로그 PG에 생존 신호를 남기고, 기한(26h) 내 갱신이 끊기면 역방향으로 경보합니다 — 30h 침묵을 심으니 로컬 수신기에 경보가 HTTP 200으로 실제로 도착했습니다. dbt contracts는 마트 컬럼 타입을 DB 레벨로 강제해서, latency_increase_ms를 VARCHAR로 바꾸자 빌드가 'data type mismatch'로 막혔습니다. 회귀는 없었어요 — verify ALL MATCH(149,259/79,894), 실데이터 계약 강제 dbt run PASS=3."
descriptionEn: "In part 8 I opened tests/ and pinned the logic with 35 pytest cases — but that was a local asset that only ran on my laptop. If commits don't enforce it, days later someone breaks a test and still sees green. And alerts still only cried on failure, when the incident the audit actually flagged was the opposite: the source collector went silent for 21 hours with zero alerts, because the task never even started so on_failure_callback never fired. Finally, the mart schema had no contract, so a column type change stayed invisible until publish. I closed all three. CI (GitHub Actions, three gates: ruff, pytest, dbt) enforces on every commit, and because DuckDB is embedded, a runner with no MinIO or PG builds the whole dbt DAG e2e from a handful of tiny fixture parquet files (models + data tests + contracts + 4 unit tests, PASS=25 in the runner). dbt unit tests pin four delta-logic edges as static input-to-output (first-vs-last, counter-reset clamp, single-snapshot day, fingerprint SUM). A deadman heartbeat writes a liveness signal to the catalog PG on success and alarms in reverse when it isn't refreshed within the deadline (26h) — I planted a 30h silence and the alert actually landed at a local receiver with HTTP 200. dbt contracts enforce mart column types at the DB level, so changing latency_increase_ms to VARCHAR blocked the build with 'data type mismatch'. No regression — verify ALL MATCH (149,259/79,894), contract-enforced dbt run on live data PASS=3."
date: 2026-07-04
tags:
  - Data Engineering
  - CI/CD
  - dbt
  - Airflow
  - DuckDB
category: personal/lakehouse
coverImage: /uploads/project/lakehouse/cover.svg
draft: false
series: "lakehouse"
seriesOrder: 9
---

## 0. 상황 — 초록불의 세 가지 거짓말

8편에서 처음으로 `tests/`를 열었습니다. pytest 35개로 게이트 판정과 자기파괴 가드,
발행 원자성을 고정했죠. 그때는 "이제 회귀는 못 낸다"고 생각했어요. 그런데 며칠 지나
마트 SQL을 만지다가 문득 깨달았습니다 — 그 테스트는 **제 노트북에서만 돕니다.** 커밋할
때 아무도 `pytest`를 부르지 않아요. 제가 깜빡하면 깨진 채로 push되고, 리포는 여전히
초록불처럼 보입니다. 테스트가 있다는 사실과 테스트가 통과한다는 사실은 다른 얘기인데,
그 사이를 이어주는 게 없었던 거예요.

두 번째 거짓말은 더 뼈아팠습니다. 6편에서 실패 알림(webhook)을 붙이며 "차단은 시작이고
통보가 완성이다"라고 썼는데, 정작 이 파이프라인이 겪은 가장 긴 침묵엔 통보가 없었습니다.
원천 수집기(DBTower Spring 앱)가 **21시간 동안 조용히 멈춰** 있었는데, 알림은 한 통도
안 왔어요. 이유는 단순합니다 — 알림은 태스크가 **돌다가 실패해야** 웁니다. 태스크가
아예 시작조차 안 하면 `on_failure_callback`이 불릴 일이 없어요. 스케줄러가 죽든, DAG가
pause되든, 원천이 말라붙든, "실패 감지"라는 방향으로는 '미실행'을 절대 못 잡습니다.

세 번째는 아직 사고가 안 났을 뿐입니다. 마트 `mart_query_regression`의
`latency_increase_ms`는 Metabase 카드가 숫자로 읽는 컬럼인데, 제가 SQL을 만지다 이걸
문자열로 바꿔도 dbt는 아무 말 없이 빌드합니다. 깨지는 건 발행 뒤 대시보드가 그 카드를
그릴 때예요. 스키마는 코드가 아니라 데이터의 형태라, SQL 리뷰로는 안 걸립니다.

이번 편은 이 세 구멍 — 로컬에만 있는 테스트, 못 잡는 침묵, 계약 없는 스키마 — 를
셋 다 닫은 기록입니다. 주제는 하나예요: **신뢰할 수 있는 파이프라인은 커밋마다
검증되고, 침묵해도 잡히고, 계약을 어기면 막힌다.**

## 1. CI — 임베디드 DuckDB라서 러너 안에서 다 끝난다

첫 구멍은 뻔한 처방입니다. GitHub Actions로 커밋마다 검사를 강제하면 됩니다. 관문은 셋:
ruff(린트), pytest(순수 로직), 그리고 dbt. 앞의 둘은 흔합니다. 재밌는 건 dbt예요.

보통 "CI에서 dbt를 돌린다"고 하면 클라우드 웨어하우스에 CI 전용 스키마를 잡거나,
컨테이너로 Postgres를 띄웁니다. 그런데 이 스택은 쿼리 엔진이 **DuckDB — 임베디드**예요.
외부 DW가 아예 필요 없습니다. MinIO도 PG도 없는 러너에서, 원천 스냅샷을 흉내낸 작은
parquet 몇 장만 로컬에 깔면 dbt가 staging→fct→mart를 **실제로 짓고** 데이터 테스트·
계약·unit test까지 한 번에 돕니다. 이게 이 스택을 고른 값이 CI에서 드러나는 지점이에요.

픽스처는 델타 로직의 대표 경로를 일부러 담았습니다 — 정상 누적 증가, 지문 충돌(같은
grain 두 계열), 순리셋(하루 last < first). 파티션 레이아웃은 운영과 똑같이
`dt=YYYY-MM-DD/instance_id=N/`이고요.

```python
# scripts/ci_fixture.py — 픽스처 parquet + raw 소스 뷰 등록
python scripts/ci_fixture.py "$FIXTURE_DIR" "$DBT_DUCKDB_FILE"
# 픽스처 생성: 4개 파티션 파일, 10행 → <tmp>/fixture
# raw.query_snapshot 뷰 등록 → <tmp>/ci.duckdb
```

운영 소스는 MinIO(`s3://`)를 가리키는데, 이걸 어떻게 픽스처로 갈아끼울까요. sources.yml의
`external_location`을 환경변수로 스왑 가능하게 했습니다. 기본값은 운영 경로 그대로,
CI만 픽스처를 가리킵니다.

```yaml
# models/sources.yml — 운영 기본값은 불변, CI만 덮어쓴다
external_location: >-
  {{ env_var('RAW_SNAPSHOT_LOCATION',
     "read_parquet('s3://lakehouse/raw/query_snapshot/dt=*/instance_id=*/*.parquet', hive_partitioning = 1)") }}
```

워크플로가 러너에서 도는 순서 그대로 호스트에서 재현했습니다(act 없이 각 단계를 직접
실행해 통과를 확인).

```
### ruff ###     All checks passed!
### pytest ###   53 passed
### fixture ###  픽스처 생성: 4개 파티션 파일, 10행
                 raw.query_snapshot 뷰 등록
### dbt deps / parse ###  Performance info: ./target/perf_info.json
### dbt build ###  Done. PASS=25  (2 table + 18 data test + 4 unit test + 1 view)
                   Completed successfully
```

`dbt build` 한 번에 25개가 돕니다 — 모델 2개, 데이터 테스트 18개, unit test 4개, view 1개.
전부 러너 안에서, 외부 인프라 0으로. 배지는 README 맨 위에 달았습니다.

## 2. dbt unit tests — 심장의 엣지를 정적으로 못박다

이 프로젝트의 심장은 3편에서 만든 델타 로직입니다. 누적 카운터를 하루 양 끝 차분으로
바꾸고(first-vs-last), 리셋이면 `GREATEST(0, ...)`로 클램프하고, 지문 충돌은 staging에서
SUM으로 접는 것. 데이터 테스트(not_null 등)는 "실데이터에 규칙이 성립하나"를 보지만,
**로직 자체가 이 입력에 이 출력을 내나**는 안 봅니다. 그건 dbt unit test의 몫이에요
(dbt 1.8+, 여기선 1.11 + dbt-duckdb 1.10).

입력(ref/source)을 목킹하므로 실데이터가 없어도 로직만 딱 고정됩니다. 엣지 네 개를
정적 입력→기대 출력으로 박았어요.

```yaml
# models/marts/unit_tests.yml — 리셋 클램프
- name: test_reset_clamps_to_zero
  model: fct_query_daily
  given:
    - input: ref('stg_query_snapshot')
      rows:
        - {instance_id: 2, query_id: "q2", dt: "2026-01-01", captured_at: "2026-01-01 06:00:00", calls: 500, total_time_ms: 5000.0, query_text: "y"}
        - {instance_id: 2, query_id: "q2", dt: "2026-01-01", captured_at: "2026-01-01 23:00:00", calls: 100, total_time_ms: 1000.0, query_text: "y"}
  expect:
    rows:
      # last(100) < first(500) → GREATEST(0,..)=0, delta_calls=0이면 avg는 NULL
      - {instance_id: 2, query_id: "q2", dt: "2026-01-01", delta_calls: 0, delta_total_time_ms: 0.0, avg_latency_ms: null}
```

```
fct_query_daily::test_delta_first_vs_last ............ PASS  # 300-100=200, 4000-1000=3000, avg 15.0
fct_query_daily::test_reset_clamps_to_zero ........... PASS  # last<first → 0, avg NULL
fct_query_daily::test_single_snapshot_day_delta_zero . PASS  # 하루 1스냅샷 → first==last → 0
stg_query_snapshot::test_staging_sums_fingerprint_collision  PASS  # 120+80 → SUM 200
Done. PASS=4
```

여기서 정직하게 하나 짚고 갑니다. **dbt-duckdb는 외부 `read_parquet` 소스를
unit test 입력으로 introspect하지 못합니다.** stg의 소스-입력 테스트를 처음 돌렸더니
`relation doesn't exist`로 깨졌어요 — dbt가 입력 relation의 컬럼 타입을 알아내려고
`raw.query_snapshot`을 물리 테이블로 찾는데, 외부 parquet 소스는 그런 relation이 없거든요.
fct의 unit test는 입력이 모델 ref(stg)라 이 문제가 없습니다. stg만 걸린 거예요.

미지원이라 접는 대신, 픽스처를 가리키는 `raw.query_snapshot` **뷰**를 dbt가 쓰는 바로
그 파일에 미리 등록해 우회했습니다(`ci_fixture.py`가 함께 수행). 여전히 외부 DW·MinIO·
PG는 필요 없어요. "unit test 미지원"이 아니라 "외부 소스 introspect의 제약"이고, 그
경계까지가 정직한 한계입니다.

그리고 이걸 라이브 파이프라인과 분리했습니다. 컨테이너 transform은 이제
`dbt test --select test_type:data`로 데이터 테스트만 돕니다. unit test는 목킹 로직이라
라이브 데이터와 결과가 같고(무의미), 외부 소스 introspect도 안 되니 CI 몫으로 뒀어요.
실데이터 데이터 테스트는 그대로 18개 통과합니다.

## 3. deadman — 성공의 부재를 잡는 역방향 감시

두 번째 구멍, 침묵. 이건 "실패 감지"를 아무리 정교하게 해도 못 막습니다. 태스크가
시작조차 안 하는데 무슨 실패를 감지하나요. 방향을 뒤집어야 합니다 — **성공이
주기적으로 남겨야 할 신호가 안 남은 것**을 잡는 거예요. deadman switch의 원리입니다.

절반은 heartbeat입니다. `snapshot_offload`가 offload→gate→transform→publish를 전부
통과하면, 마지막에 붙인 `heartbeat` 태스크가 "성공했다"를 남깁니다. 어디에? 파일은
컨테이너가 죽으면 같이 사라지니 테이블에 씁니다 — DuckLake 카탈로그와 같은 PG 인스턴스의
분리 DB(`ducklake_catalog`)에요. 서비스 추가 0이고, DBTower 메타 DB(dbtower)는 5편부터
지켜온 대로 건드리지 않습니다.

나머지 절반이 감시입니다. `extract/deadman.py`가 그 heartbeat가 **기한 내 갱신됐나**를
보고, 낡았으면 경보합니다. 판정은 순수 함수라 PG 없이 테스트로 박을 수 있어요.

```python
# extract/deadman.py — 신선도 판정(발췌)
def check_stale(dag_id, last_success_at, max_age_seconds, now=None):
    now = now or datetime.now(UTC)
    if last_success_at is None:                      # 한 번도 성공 못 함/테이블 빔 → 낡음
        return StaleVerdict(dag_id, True, None, max_age_seconds, None)
    age = (now - last_success_at).total_seconds()
    return StaleVerdict(dag_id, age > max_age_seconds, age, max_age_seconds, last_success_at)
```

실측입니다. 로컬 수신기(:18809)를 띄우고, 정상 heartbeat를 찍은 뒤 여러 상황을 돌렸어요.
경보는 기존 실패 알림과 **같은 webhook 채널**을 재사용합니다(채널·수신기·배선 동일,
서비스 추가 0).

```
# 1) 방금 성공(기한 26h) → 건강, 경보 없음
INFO heartbeat 건강 — snapshot_offload: 0.0h 전 성공(기한 26.0h)      exit=0

# 3) 30h 전 성공을 마지막으로 침묵(기한 26h) → 경보 발화, 수신기 HTTP 200
{ "event": "pipeline_deadman", "dag_id": "snapshot_offload",
  "last_success_at": "2026-07-07T16:43:10+00:00", "age_hours": 30.0, "deadline_hours": 26.0,
  "error": "heartbeat 정지 30.0h(기한 26.0h 초과) — 스케줄러 death/pause/원천 침묵 의심" }   exit=1

# 4) heartbeat 없는 DAG(미실행/pause 모사) → 경보 발화
{ "event": "pipeline_deadman", "dag_id": "nonexistent_dag", "last_success_at": null,
  "error": "heartbeat 없음 — 한 번도 성공 기록이 없다(DAG 미실행/pause 의심)" }   exit=1
```

30시간 침묵이 26시간 기한을 넘겨 경보가 실제로 수신기에 도착했습니다. 처음의 그 21시간
침묵이 이제는 잡힙니다.

그런데 여기서 정직해야 할 게 있어요. 이 감시를 어디서 돌리냐가 문제입니다. Airflow 안에
`deadman_watch` DAG(@hourly)를 뒀는데, **이 감시 DAG도 같은 스케줄러 위에서 돕니다.**
스케줄러가 통째로 죽으면 감시 DAG도 같이 죽어요 — 자기 죽음은 자기가 못 봅니다.

| 경로 | 무엇을 잡나 | 못 잡는 것 |
|---|---|---|
| Airflow `deadman_watch` DAG (@hourly) | 스케줄러 사는 동안의 pause·연속 실패·원천 침묵 | **자기 스케줄러의 death** |
| 외부 `python -m extract.deadman` (host cron) | 스케줄러가 통째로 죽는 total death까지 | 그 외부 러너 자체의 death |

**감시자는 감시 대상 밖에 있어야 total death를 잡습니다.** 그래서 외부 cron 경로를 함께
뒀어요 — 종료코드가 경보 발화 수(0=건강)라 cron이 비영 종료를 자체 경보로도 태웁니다.
그럼 그 외부 러너는 또 누가 감시하냐고요? 결국 감시의 감시는 조직 밖 상시 모니터
(PagerDuty류)의 몫입니다 — 로컬 스택 범위 밖이고, 그게 이 층의 정직한 끝입니다.

## 4. dbt contracts — 발행 전 마지막 방어선

세 번째 구멍, 계약 없는 스키마. `fct_query_daily`와 `mart_query_regression`에
`contract: enforced: true`를 걸고 컬럼 이름·타입·제약을 선언했습니다. 타입은 상상이
아니라 실측한 DuckDB 산출 타입 그대로예요 — 누적값을 SUM하면 `BIGINT`가 `HUGEINT`로
승격되는 것까지 `DESCRIBE`로 확인하고 박았습니다.

```yaml
# models/marts/schema.yml — 계약 + DB 레벨 제약
- name: delta_calls
  data_type: hugeint      # SUM(BIGINT)→HUGEINT, 실측 타입 그대로
  constraints:
    - type: not_null
    - type: check
      expression: "delta_calls >= 0"    # 클램프 불변식을 DB가 강제
```

dbt-duckdb는 이 constraint를 문서로만 두는 게 아니라 **DB 레벨로 실제 enforce**합니다.
3편에서 코드로 지키던 "델타는 음수가 될 수 없다"는 클램프 불변식을, 이제 데이터베이스가
CHECK 제약으로 강제해요.

계약이 진짜 방어선인지는 어기게 해봐야 압니다. 마트 컬럼 하나의 산출 타입을 일부러
바꿨어요 — 다운스트림(Metabase 카드)이 숫자로 읽는 `latency_increase_ms`를 문자열로.

```
# mart_query_regression.sql: latency_increase_ms 를 CAST(... AS VARCHAR)로 변경
$ dbt build --select mart_query_regression
ERROR creating sql table model main.mart_query_regression
  This model has an enforced contract that failed.
  | column_name         | definition_type | contract_type | mismatch_reason    |
  | latency_increase_ms | VARCHAR         | DOUBLE        | data type mismatch |
Done. PASS=0 ERROR=1
```

빌드가 막혔습니다. 대시보드가 그 카드를 그리다 런타임에 깨지는 게 아니라, **발행 전
CREATE TABLE 시점에** 타입 불일치로 차단된 거예요. 주입을 원복하니 다시 통과합니다.
그리고 이 계약이 실데이터에서도 성립하는지 — 픽스처가 아니라 진짜 MinIO를 직독한
`dbt run`으로 확인했습니다.

```
$ dbt run --profiles-dir . --project-dir .     # RAW_SNAPSHOT_LOCATION 기본값=MinIO
Done. PASS=3 WARN=0 ERROR=0     # 계약이 실데이터 산출 타입과 일치
```

## 5. 회귀 없음

세 가지를 얹으면서 기존 파이프라인이 안 깨졌는지 닫힌 창으로 재검했습니다. 원천
수집기는 07-07 23:04에 멈춰 있어(닫힌 창) 수치가 안정입니다.

```
$ pytest -q
53 passed                          # 기존 35 + deadman 감시 로직 18

$ python -m extract.verify_count 2026-07-05 2026-07-06
2026-07-05   149,259   149,259   OK
2026-07-06    79,894    79,894   OK
RESULT: ALL MATCH

$ python -m extract.quality 2026-07-05 2026-07-06
GATE: PASS — 모든 dt 통과

$ dbt run (계약 강제) → PASS=3 · dbt test --select test_type:data → PASS=18
```

heartbeat 격리도 확인했습니다 — `ducklake_catalog.pipeline_heartbeat`에는 기록이 있고,
DBTower 메타 DB(dbtower) 안 같은 이름 테이블 수는 **0**입니다. 원천 메타는 오염되지
않았어요.

## 6. 잔여 — 정직하게

- **CI는 tiny 픽스처까지입니다.** 로직·계약·스키마는 러너에서 검증하지만, 실데이터
  규모(수십만 행)·MinIO/PG 통합은 CI 밖(호스트 실측)이에요. 1년치(365dt) 규모 실측은
  다음이고, 그 수치를 근거로 증분 모델 전환을 판단할 겁니다(수치 없이 미리 최적화 안 함).
- **unit test는 fct만 완전히 CI 네이티브입니다.** stg의 소스-입력 테스트는 외부
  read_parquet를 introspect 못 해 픽스처 뷰 등록으로 우회했습니다 — dbt-duckdb의 제약이고,
  깔끔하진 않아요.
- **deadman은 heartbeat 신선도까지입니다.** Airflow 내 감시 DAG는 자기 스케줄러의
  total death를 못 잡아 외부 cron을 뒀지만, 그 외부 러너의 생존은 또 조직 밖 모니터의
  몫입니다. 감시의 사슬은 어딘가에서 스택 밖으로 나갑니다.
- **계약은 마트 2개까지입니다.** 컬럼 레벨 계보·PII 태깅은 dbt Enterprise 영역이라
  문서 계보까지만 합니다.
- 운영 대시보드화(게이트 FAIL·마지막 성공 dt·발행 지연을 Metabase 상태 카드로)는
  다음입니다. heartbeat 테이블이 이제 있으니 "마지막 성공 dt" 카드는 바로 얹을 수 있어요.

---

세 편의 아크가 이렇게 닫힙니다. 4·6·8편이 **조용히 틀린 데이터**를 게이트로 막고
통보로 완성했다면, 이번 편은 그 신뢰를 **커밋·침묵·계약** 세 축에서 마저 묶었습니다.
파이프라인은 이제 제 노트북 밖에서도 커밋마다 스스로를 검증하고, 아무도 안 볼 때
멈추면 역방향으로 울고, 계약을 어기는 변경은 발행 전에 막습니다. 실무자 서베이가
말하는 데이터 엔지니어링의 고통 1~2위(조용한 실패·스키마 파괴)와 그대로 겹치는
방향이고, 스트리밍을 새로 얹는 것보다 이쪽이 이 규모가 실제로 향해야 할 곳이라고
생각합니다.

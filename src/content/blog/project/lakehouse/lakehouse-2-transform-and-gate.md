---
title: '누적 스냅샷을 일간 델타로, 그 답을 지키는 품질 게이트 — 가짜 리셋과 조용한 오답'
titleEn: 'Cumulative Snapshots to Daily Deltas, and a Quality Gate That Guards the Answer — Fake Resets and Silent Wrong Answers'
description: "raw는 내려왔지만 calls·total_time_ms가 누적 카운터라 그냥 더하면 무의미합니다. 1부는 변환입니다 — raw를 시간순으로 늘어놓으면 302→55→302→56처럼 감소가 섞여 가짜 리셋이 보이는데, 원인은 같은 지문에 둘 이상의 누적 계열이 얽힌 중복 12,743키였습니다. staging에서 SUM으로 단조 계열을 복원하고, fct에서 하루 first-vs-last 차분에 GREATEST(0,…) 리셋 클램프를 겁니다(순리셋 219그레인이 0으로 클램프, 대안인 인접 델타 합산은 22,264,704 vs 3,126,579로 과대계상해 기각). dbt test 18개 통과, 마트가 마침내 'instance 8 Oracle 쿼리가 25.9ms에서 64.5ms로 149% 느려졌다'고 답합니다. 2부는 그 답을 믿어도 되는지를 지키는 검문소입니다 — reconciliation·completeness·freshness 축으로 dbt 앞을 검문하고, 한 dt라도 FAIL이면 dbt를 아예 실행하지 않습니다(fail-closed). dt=2026-07-06의 instance_id=3 파티션(20,158행)을 통째로 지우자 reconciliation(79,894 vs 59,736)과 completeness(누락 [3])가 동시에 잡아 dbt를 SKIP하고 종료코드 2로 빠졌고, Airflow에서도 transform이 upstream_failed로 실행되지 않았습니다."
descriptionEn: "Raw is offloaded, but calls and total_time_ms are cumulative counters — summing them is meaningless. Part 1 is the transform: ordering raw by time shows drops like 302→55→302→56 that look like fake resets, caused by 12,743 duplicate keys where multiple cumulative series collide under one fingerprint. Staging restores a monotonic series by SUM, and the fact table takes a within-day first-vs-last diff with a GREATEST(0, …) reset clamp (219 net-reset grains clamp to zero; the adjacent-positive-delta alternative over-counts 22,264,704 vs 3,126,579 and was rejected). 18 dbt tests pass, and the mart finally answers: instance 8's Oracle query slowed from 25.9ms to 64.5ms, up 149%. Part 2 guards whether that answer can be trusted — a checkpoint in front of dbt with reconciliation, completeness, and freshness; if any dt FAILs, dbt never runs (fail-closed). Deleting instance_id=3's partition (20,158 rows) for dt=2026-07-06 tripped reconciliation (79,894 vs 59,736) and completeness (missing [3]) at once, skipping dbt with exit code 2 — and in Airflow, transform stayed upstream_failed, never run."
date: 2026-05-10
tags:
  - dbt
  - DuckDB
  - Parquet
  - MinIO
  - DataQuality
  - Analytics
  - Airflow
category: personal/lakehouse
coverImage: /uploads/project/lakehouse/cover.svg
draft: false
series: "lakehouse"
seriesOrder: 2
---

## 1부 — 누적 스냅샷을 일간 델타로: 가짜 리셋을 걷어내고 답하기

### 0. 상황 — 내려는 놨는데, 여전히 못 답한다

[1편](/blog/project/lakehouse/lakehouse-1-contract-and-load)에서 어제치 스냅샷을 MinIO에 parquet로 안전하게 내렸습니다. 원천 = parquet = DuckDB 3자 일치까지 확인했고요. 그런데 정작 이 프로젝트가 존재하는 이유였던 질문 — **"지난 구간보다 느려진 쿼리 있어?"** — 앞에서는 raw가 여전히 침묵합니다.

이유는 컬럼 두 개에 있습니다.

```
calls          누적 호출수 (서버 기동 이후 단조 증가 카운터)
total_time_ms  누적 총 실행시간 (구간값 아님)
```

`calls`를 그냥 `SUM`하면 무슨 일이 벌어질까요. 하루에 스냅샷이 인스턴스당 수백 번 찍힙니다(실측 256~813회). 매 스냅샷마다 "지금까지 누적 302회"가 반복 기록돼요. 그걸 다 더하면 302를 수백 번 더한, 아무 의미 없는 수가 나옵니다. 하루의 실제 발생량은 **차분**해야 합니다 — 하루 끝 누적에서 하루 시작 누적을 뺀 값.

이건 새로운 통찰이 아니라 DBTower가 이미 하던 겁니다. `ComparisonService`가 두 시점을 비교할 때:

```java
long delta = Math.max(0, end.getCalls() - start.getCalls());
```

`end - start`로 구간을 구하고, `Math.max(0, …)`로 감싸 음수를 0으로 눌러요. **왜 음수가 나오냐**가 이 편의 진짜 함정입니다.

### 1. 함정 — 시간순으로 늘어놓으면 감소가 섞인다

누적 카운터는 단조 증가여야 합니다. 그러니 하루 안에서 시간순 정렬하면 302, 303, 305, … 처럼 계속 오르기만 해야 정상이죠. 그런데 한 쿼리를 실제로 뽑아 보면 이렇습니다.

```
captured_at                   calls
2026-07-07 00:00:18.340565    302
2026-07-07 00:00:18.340565     55
2026-07-07 00:01:18.470229    302
2026-07-07 00:01:18.470229     56
2026-07-07 00:02:11.143368    302
2026-07-07 00:02:11.143368     56
...
```

302과 55가 번갈아 나옵니다. 인접 차분을 하면 302→55는 **-247**, 다음은 55→302로 **+247**. 하루에 이런 가짜 감소가 수백 번씩 잡혔어요(전체 32,946건).

카운터 리셋(대상 DB 재기동)인가 싶었지만, 같은 `captured_at`에 두 행이 있다는 게 이상했습니다. 파고들었더니:

```
id      calls  total_time_ms  query_text
382469    302        19.6588  SHOW REPLICA STATUS
382471     55         5.2660  SHOW REPLICA STATUS
```

**같은 `query_id`(지문 해시), 같은 `query_text`인데 누적값이 다른 두 계열**이 한 순간에 공존합니다. 지문 충돌이에요. `id`는 다르지만 `id`는 스냅샷마다 새로 발번되는 전역 PK라 계열 식별자가 못 됩니다. 이런 (instance_id, query_id, captured_at) 중복이 **12,743키** 있었습니다.

즉 감소의 정체는 리셋이 아니라 **두 누적 계열이 한 지문 아래 얽혀 시간순으로 지그재그**한 것이었습니다. 이걸 안 풀고 인접 차분을 하면 델타가 통째로 오염됩니다.

### 2. 판단 — 합쳐서 단조를 복원하고, 양 끝만 본다

두 함정에 각각 답이 필요합니다.

**얽힌 계열(함정 A)**: staging에서 `captured_at`별로 누적값을 **SUM**합니다. 핵심은 이겁니다 — *단조 비감소 계열들의 합도 단조 비감소*. 302 계열과 55 계열을 더하면 357, 358, 360, … 으로 다시 깔끔하게 증가하는, 지문 단위 '총 활동'의 누적 계열이 복원됩니다. 서로 다른 물리 쿼리를 하나로 합치는 근사이긴 하지만, 지문이 같은 이상 이게 정직하게 낼 수 있는 최선의 그레인입니다.

**차분 방식(함정 B)**: 하루 **first-vs-last**(양 끝 차분)를 택했습니다. `GREATEST(0, 마지막_누적 - 처음_누적)`. DBTower `ComparisonService`의 `Math.max(0, end - start)`와 정확히 같은 원리라, 나중에 DBTower 화면의 시점 비교와 교차검증까지 됩니다.

여기서 갈림길이 하나 있었습니다. 인접 스냅샷의 양의 델타를 전부 합산하는 방식(Prometheus `rate()`가 카운터 리셋을 다루는 그 방식)도 후보였어요. 하루 중 리셋이 일어나도 리셋 이후 증가분을 살린다는 장점이 있습니다. 그런데 실측해 보니:

```
인접 양의 델타 합산 : 총 delta_calls = 22,264,704
first-vs-last       : 총 delta_calls =  3,126,579
```

7배 넘게 부풀었습니다. 원인은 앞의 SUM 집계와 상호작용입니다. 어떤 쿼리가 스냅샷 사이에 잠깐 보고되지 않으면 합계가 뚝 떨어졌다가, 다시 나타나면 확 오릅니다. 인접 델타 합산은 그 **유령 재등장**을 활동으로 과대계상해요. 반면 first-vs-last는 하루 양 끝만 보므로 중간 출렁임에 흔들리지 않습니다. DBTower 정식 로직과의 정합까지 고려해 first-vs-last를 택했습니다.

리셋 클램프는 여전히 필요합니다. SUM으로 얽힘을 푼 뒤에도 하루 `last < first`인 **순리셋 그레인이 219개** 남았거든요(진짜 재기동이거나 종일 간헐 보고). 거기서 `GREATEST(0, …)`가 음수를 0으로 눌러 줍니다.

### 3. 개선 — dbt 3계층

#### staging — 얽힘을 접는다

```sql
-- models/staging/stg_query_snapshot.sql (view)
select
    instance_id,
    query_id,
    cast(dt as date)   as dt,
    captured_at,
    sum(calls)         as calls,          -- 지문 충돌·중복 계열을 합산으로 접는다
    sum(total_time_ms) as total_time_ms,  -- 단조 계열의 합도 단조
    sum(rows_examined) as rows_examined,
    max(query_text)    as query_text
from {{ source('raw', 'query_snapshot') }}
group by instance_id, query_id, cast(dt as date), captured_at
```

소스는 dbt-duckdb의 `external_location`으로 MinIO parquet에 직결됩니다. httpfs·s3 설정은 프로파일에서 로드되고요.

```yaml
# models/sources.yml
sources:
  - name: raw
    meta:
      external_location: >-
        read_parquet(
          's3://lakehouse/raw/query_snapshot/dt=*/instance_id=*/*.parquet',
          hive_partitioning = 1
        )
```

#### marts — 차분과 클램프

```sql
-- models/marts/fct_query_daily.sql (table)
with endpoints as (
    select
        instance_id, query_id, dt, query_text, calls, total_time_ms,
        row_number() over (partition by instance_id, query_id, dt order by captured_at asc)  as rn_first,
        row_number() over (partition by instance_id, query_id, dt order by captured_at desc) as rn_last
    from {{ ref('stg_query_snapshot') }}
),
diffed as (
    select
        instance_id, query_id, dt,
        any_value(query_text)                              as query_text,
        max(case when rn_first = 1 then calls end)         as first_calls,
        max(case when rn_last  = 1 then calls end)         as last_calls,
        max(case when rn_first = 1 then total_time_ms end) as first_time_ms,
        max(case when rn_last  = 1 then total_time_ms end) as last_time_ms
    from endpoints
    group by instance_id, query_id, dt
)
select
    instance_id, query_id, dt, query_text,
    greatest(0, last_calls   - first_calls)   as delta_calls,          -- 리셋 클램프
    greatest(0, last_time_ms - first_time_ms) as delta_total_time_ms,
    greatest(0, last_time_ms - first_time_ms)
        / nullif(greatest(0, last_calls - first_calls), 0) as avg_latency_ms
from diffed
```

그 위에 0편의 질문에 답하는 마트를 얹습니다 — 인스턴스+쿼리별로 첫 활동일 대비 마지막 활동일 평균 지연을 비교해 악화 순으로 정렬합니다(`mart_query_regression`). 잡음이 큰 날은 `delta_calls >= 100` 미만이면 비교에서 뺐고요.

#### 테스트 — 누적 카운터라서 delta는 음수일 수 없다

스키마 테스트(not_null·relationships) 외에, 이 도메인에만 있는 불변식을 singular 테스트로 박았습니다.

```sql
-- tests/assert_fct_delta_non_negative.sql
-- GREATEST(0, ...) 클램프가 살아 있으면 0행이어야 한다.
select * from {{ ref('fct_query_daily') }}
where delta_calls < 0 or delta_total_time_ms < 0
```

그레인 유일성(`assert_stg_grain_unique`, `assert_fct_grain_unique`)도 같은 방식으로 검증합니다.

### 4. 실측 — dbt run/test와 마트가 답한 질문

한 가지 정직하게 짚을 것. 호스트 `.venv`가 python3.14였는데 dbt-core 1.11이 그 위에서 직렬화 오류로 아예 뜨질 않았습니다. `.venv`를 python3.12로 재구성하고 추출 의존성까지 동일 버전으로 다시 깔아 해결했어요(`dbt-duckdb 1.10.1`).

```
$ .venv/bin/dbt run --profiles-dir .
  1 of 3 OK view  main.stg_query_snapshot ...... [OK 0.06s]
  2 of 3 OK table main.fct_query_daily ......... [OK 0.27s]
  3 of 3 OK table main.mart_query_regression ... [OK 0.02s]
  Done. PASS=3 WARN=0 ERROR=0 SKIP=0 TOTAL=3

$ .venv/bin/dbt test --profiles-dir .
  Done. PASS=18 WARN=0 ERROR=0 SKIP=0 TOTAL=18
```

테스트 18개(not_null 14 + relationships 1 + 커스텀 3) 전부 통과. 그중 `assert_fct_delta_non_negative`가 통과했다는 건 **리셋 클램프가 실제로 동작해 음수 델타가 하나도 없다**는 뜻입니다. `fct_query_daily.delta_calls` 최솟값을 직접 세도 0이었고요 — 순리셋 219그레인이 조용히 0으로 눌렸습니다.

![dbt run/test 통과와 마트 질의 실제 출력](/uploads/project/lakehouse/dbt-mart-result.png)

이제 0편의 질문에 마침내 답합니다. `mart_query_regression`을 악화 순으로 뽑으면(07-05 → 07-07 평균 지연):

| inst | 쿼리 | first_ms | last_ms | +ms | +% |
|---|---|---|---|---|---|
| 8 (Oracle) | `SELECT sql_id, MAX(SUBSTR(sql_text…` | 25.89 | 64.50 | **+38.61** | +149% |
| 4 (메타 PG) | `select qs1_0.id,qs1_0.calls,…` | 19.52 | 38.30 | +18.78 | +96% |
| 1 (MySQL) | ``SELECT `p`.`ID` AS `pid`,…`` | 1.05 | 2.19 | +1.14 | +109% |

"instance 8의 Oracle 쿼리가 이틀 새 평균 25.9ms에서 64.5ms로, **149% 느려졌다.**" raw만으로는 절대 못 냈을 답입니다. 흥미로운 건 4번 인스턴스 — DBTower가 자기 메타 PG에 던지는 스냅샷 적재/조회 쿼리(`qs1_0`은 하이버네이트 별칭)입니다. **파이프라인이 준 부하를 파이프라인이 관측하는 도그푸딩**이 데이터로도 드러났어요.

#### 계보(lineage)

`dbt docs generate` 후 계보 그래프입니다. source에서 마트까지, 그리고 커스텀 테스트가 어디에 걸리는지 한눈에 보입니다.

![dbt lineage — raw.query_snapshot에서 stg, fct, mart_query_regression까지](/uploads/project/lakehouse/dbt-lineage.png)

`raw.query_snapshot`(초록 소스) → `stg_query_snapshot` → `fct_query_daily` → `mart_query_regression`으로 흐르고, fct에서 검증 테스트 세 갈래가 갈라집니다.

### 5. 잔여 — 정직한 한계

- **지문 충돌 근사**: SUM으로 얽힌 계열을 접은 건 서로 다른 물리 쿼리를 한 지문으로 합치는 근사입니다. `id`로 계열을 완벽히 분리하진 못해요(스냅샷마다 새 `id`). "지문 단위 총 활동"까지가 정직하게 낼 수 있는 그레인입니다.
- **first-vs-last의 손실**: 하루 중 리셋이 나면 재상승분을 일부 잃습니다(219그레인). DBTower 정식 로직과의 정합을 우선해 감수했고, 잃는 양은 클램프된 그레인 수로 계량해 뒀습니다. 인접 델타 합산은 반대로 과대계상하니, 둘 다 틀린 방향이 다를 뿐 완벽하진 않습니다.
- **품질 게이트 없음**: 어느 날 한 인스턴스 파티션이 수집 장애로 비면, 그 위 랭킹은 조용히 오답을 냅니다. 지금은 그걸 잡을 게 없어요 — freshness·빈 파티션 검증과 알림은 이어지는 2부입니다.
- **구간이 짧다**: 아직 3일치(07-05~07)만 적재돼 사실상 이틀 비교입니다. "지난달" 규모의 추세는 적재가 쌓인 뒤에.

그래도 이 편에서 raw가 처음으로 질문에 답했습니다. 다음은 이 답을 **믿어도 되는지**를 지키는 품질 게이트입니다.

코드는 [GitHub](https://github.com/dj258255/dbtower-lakehouse)에 있습니다.

여기까지가 1부 — 변환입니다. 이제 그 답을 믿어도 되는지를 지키러 갑니다.

## 2부 — 실패해야 하는 파이프라인: 조용한 오답을 막는 품질 게이트

### 0. 상황 — 답은 나오는데, 믿어도 되는지는 아무도 안 지킨다

1부에서 raw가 처음으로 질문에 답했습니다. "instance 8의 Oracle 쿼리가 이틀 새 25.9ms에서 64.5ms로 149% 느려졌다" 같은 답이 마트에서 나왔죠. 그런데 거기엔 조용한 전제가 하나 깔려 있었습니다 — **그 밑의 raw가 온전하다**는 전제.

한 상황을 가정해 봅시다. 어느 날 새벽, 특정 인스턴스의 어제 파티션이 수집 장애로 비었습니다. 오브젝트가 아예 안 올라왔거나, 절반만 올라왔거나. 그 위에서 dbt는 아무 불평 없이 돌아갑니다. 마트는 "악화 쿼리 랭킹"을 여전히 뱉어내요. 다만 그 랭킹은 이제 **빠진 인스턴스를 뺀 채 계산된, 조용히 틀린 답**입니다. dbt run은 초록불, 테스트도 초록불. 아무도 모릅니다.

이건 DBTower 시리즈 내내 지켰던 원칙 — **"못 하는 것은 못 한다고"** — 의 데이터판입니다. 데이터가 반쪽이면, 반쪽인 채로 답을 내지 말고 **멈춰야** 합니다. 조용히 틀린 데이터는 없는 것보다 나쁘거든요. 없으면 "데이터 없음"이라고 답하지만, 반쪽이면 그럴듯한 오답을 자신 있게 냅니다.

그래서 이 편은 기능을 늘리지 않습니다. 오히려 **파이프라인이 실패하게 만드는** 장치를 답니다.

### 1. 함정 — 반쪽 적재는 dbt가 잡아주지 않는다

dbt에도 테스트가 있습니다(1부에서 18개 통과시켰죠). 하지만 dbt test는 **이미 로드된 데이터 안의 관계**를 검증합니다 — not_null, unique, 참조 무결성. "parquet에 있어야 할 인스턴스가 통째로 안 왔다"는 건 dbt가 보는 세계 밖의 일이에요. 없는 행은 not_null을 위반하지 않습니다. 없으니까요.

세 가지 반쪽이 특히 조용합니다.

```
빈 파티션      한 인스턴스의 dt 파티션이 아예 안 올라옴 → 그 인스턴스만 랭킹에서 증발
행수 불일치     원천 PG엔 20,158행인데 parquet엔 12,000행만 → 부분 적재, 델타가 축소
freshness 붕괴  수집이 낮 12시에 끊김 → 하루 절반만 담긴 파티션을 '하루'로 취급
```

세 경우 모두 dbt run은 성공합니다. 마트도 나옵니다. 틀린 채로요. 그러니 검문은 **dbt 이전에, raw 파티션 자체를 상대로** 해야 합니다.

### 2. 판단 — 다운스트림 앞에 검문소를 세우고, FAIL이면 막는다 (fail-closed)

핵심 결정은 **fail-closed**입니다. 게이트가 통과를 확신하지 못하면 다운스트림을 진행시키지 않습니다. 기본값이 "차단"이에요. 반대(fail-open, 의심스러워도 일단 진행)는 조용한 오답을 그대로 통과시키니까요.

검문은 세 축입니다. 각각 이미 아는 사실 하나씩과 대조합니다.

**reconciliation(정합)** — 원천 PG의 그 dt 행수와 parquet 행수가 인스턴스별로 정확히 같은가. 1편에서 만든 `verify_count`(원천=적재 대조)를 이 게이트로 흡수했습니다. 불일치는 유실이거나 중복이거나 부분 적재입니다. FAIL.

**completeness(완결성)** — 레지스트리(`database_instance`)에 등록된 인스턴스가 그 dt 파티션에 **전부** 존재하는가. 빈 파티션·수집 누락을 잡는 축입니다. 하나라도 빠지면 FAIL.

**freshness(신선도)** — 그 dt의 최신 `captured_at`이 다음날 00:00 경계에 충분히 근접한가. 수집이 하루 중간에 끊기면 최신 시각이 경계에서 멀어집니다. 기본 임계는 3시간 초과 WARN, 12시간 초과 FAIL로 뒀습니다. freshness만 WARN 단계를 둔 건, 늦게 한 번 끊긴 것과 하루 절반이 빈 것은 심각도가 다르기 때문입니다(dbt test의 warn/error 이원화와 같은 발상).

WARN은 통과시키되 기록합니다. FAIL만 막습니다.

### 3. 개선 — 게이트 모듈과 오케스트레이션

#### 게이트 (`extract/quality.py`)

dt마다 세 검문을 돌려 `OK`/`WARN`/`FAIL`을 매기고, dt 판정은 그중 가장 나쁜 값으로 접습니다. FAIL이 하나라도 있으면 `blocked`.

```python
def check_reconciliation(pg: dict[int, int], pq: dict[int, int]) -> CheckResult:
    """원천 PG == parquet 행수(인스턴스별). 하나라도 어긋나면 FAIL."""
    mismatches = []
    for iid in sorted(set(pg) | set(pq)):
        p, q = pg.get(iid, 0), pq.get(iid, 0)
        if p != q:
            mismatches.append(f"inst {iid}: PG {p:,} != parquet {q:,}")
    if mismatches:
        return CheckResult("reconciliation", FAIL, "; ".join(mismatches))
    return CheckResult("reconciliation", OK, f"PG=parquet={sum(pg.values()):,}행")

def check_completeness(registry: list[int], pq: dict[int, int]) -> CheckResult:
    """레지스트리 기대 인스턴스가 파티션에 전부 존재하는가. 빠지면 FAIL."""
    present = {iid for iid, n in pq.items() if n > 0}
    missing = [iid for iid in registry if iid not in present]
    if missing:
        return CheckResult("completeness", FAIL, f"누락 {missing}")
    return CheckResult("completeness", OK, f"기대 {len(registry)}인스턴스 전부 존재")
```

parquet 행수는 DuckDB `read_parquet(..., hive_partitioning=1)`로 인스턴스별 `count(*)`를 세고, PG는 같은 UTC 하루창으로 `group by instance_id`를 셉니다. 파티션이 통째로 없어 glob이 아무 파일과도 안 맞으면 DuckDB가 `IOException`을 던지는데, 이걸 잡아 "파티션 전무(빈 dict)"로 해석합니다 — 그러면 completeness가 전 인스턴스 누락으로 잡습니다.

#### 오케스트레이션 — 게이트를 dbt 앞에 (`extract/run_pipeline.py`)

fail-closed의 실체는 여기입니다. 게이트가 막으면 **dbt를 아예 호출하지 않습니다.**

```python
reports = evaluate(days)
print_report(reports)

if any(r.blocked for r in reports):
    print("SKIPPED — 게이트 FAIL. dbt를 실행하지 않는다(fail-closed).")
    return 2                      # dbt 미실행, 종료코드 2

# 여기까지 왔다 = 모든 dt 통과
subprocess.run([sys.executable, "-m", "dbt.cli.main", "run", "--profiles-dir", "."], cwd=DBT_DIR)
```

#### Airflow — 태스크 의존성으로 같은 계약을

DAG를 `offload → quality_gate → transform`으로 확장했습니다. `quality_gate` 태스크는 게이트를 돌리고 FAIL이면 예외를 던집니다. 그러면 Airflow가 이 태스크를 failed로 표시하고, 의존하는 `transform`은 **upstream_failed**가 되어 실행되지 않습니다.

```python
@task(retries=0)  # 품질 FAIL은 결정적이다 — 재시도해도 그대로 FAIL이므로 즉시 차단한다.
def quality_gate(offload_result: dict) -> dict:
    from extract.quality import assert_gate
    assert_gate([offload_result["dt"]])   # FAIL이면 RuntimeError → 태스크 실패 → transform 차단
    return {"dt": offload_result["dt"], "gate": "PASS"}

transform(quality_gate(offload()))
```

`retries=0`은 의도한 설계입니다. 재시도는 일시적 장애(네트워크 등)를 회복할 때 의미가 있는데, 품질 FAIL은 **결정적**입니다 — 같은 파티션을 다시 검문해도 똑같이 FAIL이죠. 무의미한 5분×2회 대기 없이 즉시 downstream을 막습니다.

### 4. 실측 — 통과, 그리고 일부러 깨뜨리기

#### 정상 — 3개 dt 전부 통과

```
$ python -m extract.quality 2026-07-05 2026-07-06 2026-07-07
2026-07-05  reconciliation OK  PG=parquet=149,259행 (6인스턴스)
            completeness   OK  기대 6인스턴스 전부 존재
            freshness      OK  최신 23:59:30, 경계까지 0.0h
2026-07-06  ... PG=parquet=79,894행 ...  freshness OK 최신 23:58:47
2026-07-07  ... PG=parquet=279,002행 ... freshness OK 최신 23:04:30, 경계까지 0.9h  (진행 중인 오늘)
GATE: PASS — 모든 dt 통과 → 다운스트림 진행 가능
```

한 가지 정직하게 짚을 것. dt=2026-07-07은 **원천 DB의 시계 기준 아직 진행 중인 '오늘'**입니다(원천 `now()`가 07-07 23시대). 그래서 값이 계속 자랍니다(268,952 → 269,354 → 279,002). 재적재 직후 그 순간엔 PG=parquet로 맞지만, 열린 창이라 다음 순간 또 벌어질 수 있어요. 실제로 freshness가 07-07만 '경계까지 0.9h'로 뜨는 게 바로 **아직 안 닫힌 날**이라는 신호입니다. 그래서 게이트의 안정 통과 근거는 닫힌 창(07-05·07-06)에 둡니다 — 149,259·79,894는 몇 번을 세도 불변이에요.

#### 장애 주입 — instance 3의 파티션을 지우면

dt=2026-07-06에서 `instance_id=3` 파티션(20,158행)을 MinIO에서 통째로 삭제했습니다. 수집 장애로 한 인스턴스가 통째로 빠진 상황이죠. 그리고 파이프라인을 돌립니다.

```
$ python -m extract.run_pipeline 2026-07-05 2026-07-06 2026-07-07
2026-07-06  reconciliation FAIL  총 PG 79,894 vs parquet 59,736 — inst 3: PG 20,158 != parquet 0
            completeness   FAIL  기대 6인스턴스 중 누락 [3] (존재 [1, 2, 4, 7, 8])
            freshness      OK    최신 23:58:47, 경계까지 0.0h
GATE: BLOCKED — FAIL 파티션 ['2026-07-06'] → dbt 미실행(fail-closed)
=== 2) dbt ===
SKIPPED — 게이트 FAIL. dbt를 실행하지 않는다(fail-closed).   (exit code 2)
```

두 축이 동시에 잡았습니다. reconciliation은 20,158행이 사라진 걸(79,894 → 59,736), completeness는 인스턴스 3이 목록에서 빠진 걸. 그리고 나머지 dt는 멀쩡하니 통과 — **문제 있는 dt만** 막습니다. dbt는 실행되지 않았고 종료코드는 2입니다.

![품질 게이트 정상 통과와 장애주입 FAIL 실제 출력](/uploads/project/lakehouse/quality-gate.png)

#### Airflow에서도 같은 차단

Airflow DAG에서도 같은 계약을 확인했습니다. freshness FAIL 임계를 0.5h로 조여 07-07(경계까지 0.9h)을 강제로 FAIL시킨 `airflow dags test`의 태스크 상태입니다.

```
$ airflow tasks states-for-dag-run snapshot_offload 2026-07-08
offload       success
quality_gate  failed            # 게이트가 raise → 태스크 실패
transform     upstream_failed   # 게이트 실패로 실행되지 않음
```

그래프로 보면 offload(초록 success) → quality_gate(빨강 failed) → transform(주황 upstream_failed)으로, 게이트가 변환을 실제로 막고 있는 게 한눈에 드러납니다.

![Airflow 그래프 — quality_gate 실패가 transform을 upstream_failed로 막는다](/uploads/project/lakehouse/quality-gate-dag.png)

#### 원상복구

시연이 끝나고 `python -m extract.offload 2026-07-06`으로 재적재했습니다. 파티션 통째 덮어쓰기(1편의 멱등성)라 인스턴스 3이 그대로 복원되고, 게이트를 다시 돌리니 3개 dt 전부 PASS로 돌아왔습니다. 리포에는 정상 상태만 남습니다.

### 5. 잔여 — 정직한 한계

- **규칙 기반까지입니다.** 정합·완결성·freshness는 명시적 규칙으로 잡지만, "행수는 맞는데 값이 이상하다"류의 통계적 이상(분포 급변 등)은 이 게이트가 못 봅니다. 그건 다른 층의 일이고, 여기선 범위 밖으로 뒀습니다.
- **알림 발화는 아직입니다.** 게이트는 FAIL로 다운스트림을 막지만, 그 사실을 사람에게 밀어 보내는 웹훅(DBTower의 Discord 채널 재사용 같은)은 붙이지 않았습니다. 지금은 종료코드와 태스크 상태로만 드러납니다.
- **freshness는 dt 파티션 전체 기준입니다.** 그날 일부 인스턴스만 일찍 끊겨도 다른 인스턴스가 경계까지 수집했으면 dt-level로는 OK가 됩니다(07-07이 그랬습니다). 인스턴스별 freshness는 더 촘촘하지만, 그만큼 오탐도 늘어 지금은 dt 단위로 뒀습니다.
- **Airflow의 transform은 얇습니다.** 컨테이너엔 dbt를 얹지 않아, 실제 dbt 빌드는 호스트의 `run_pipeline`에서 실측합니다. Airflow가 증명하는 건 "게이트 통과가 전제여야 변환이 시작된다"는 오케스트레이션 계약이고, 실제 dbt를 막는 것은 `run_pipeline`으로 보였습니다.

1부에서 raw가 처음 답을 냈다면, 이 2부에선 그 답을 **믿어도 되는지**를 지키는 문지기를 세웠습니다. 다음은 이 lake를 진짜 lakehouse로 — ACID·타임트래블·스키마 진화를 얹는 테이블 포맷입니다.

코드는 [GitHub](https://github.com/dj258255/dbtower-lakehouse)에 있습니다.

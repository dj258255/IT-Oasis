---
title: '누적 스냅샷을 일간 델타로 — 가짜 리셋을 걷어내고 답하기'
titleEn: 'From Cumulative Snapshots to Daily Deltas — Cutting Through Fake Resets'
description: "0편에서 '지난달보다 느려진 쿼리 있어?'에 답하지 못했습니다. 2편에서 raw를 MinIO로 내렸지만, calls·total_time_ms가 누적 카운터라 그냥 더하면 무의미합니다. 차분해야 하는데, raw를 시간순으로 늘어놓으면 302→55→302→56처럼 감소가 섞여 가짜 리셋이 보입니다. 원인은 같은 지문(query_id)에 둘 이상의 누적 계열이 얽힌 중복 12,743키였습니다. staging에서 captured_at별로 누적값을 SUM해 단조 계열을 복원하고(단조 계열의 합도 단조), fct에서 하루 first-vs-last 차분에 GREATEST(0, …) 리셋 클램프를 겁니다. 이는 DBTower ComparisonService의 Math.max(0, end-start)와 같은 원리라 교차검증도 됩니다. 대안인 인접 델타 합산(Prometheus rate 방식)은 유령 재등장을 과대계상해(22,264,704 vs 3,126,579) 기각했습니다. dbt run/test 18개 통과, 순리셋 219그레인이 0으로 클램프되고, 마트가 마침내 'instance 8 Oracle 쿼리가 25.9ms에서 64.5ms로 149% 느려졌다'고 답합니다."
descriptionEn: "In part 0 I couldn't answer 'which queries got slower than last month?'. Part 2 offloaded raw to MinIO, but calls/total_time_ms are cumulative counters, so summing them is meaningless. You must diff them — yet ordering raw by time shows drops like 302→55→302→56, which look like fake resets. The cause was 12,743 duplicate keys where two or more cumulative series collide under one fingerprint (query_id). Staging sums the cumulative values per captured_at to restore a monotonic series (a sum of monotonic series is monotonic), and the fact table takes a within-day first-vs-last diff with a GREATEST(0, …) reset clamp. This mirrors DBTower's ComparisonService Math.max(0, end-start), so it cross-validates. The alternative — summing adjacent positive deltas (Prometheus rate style) — over-counts ghost reappearances (22,264,704 vs 3,126,579), so I rejected it. 18 dbt tests pass, 219 net-reset grains clamp to zero, and the mart finally answers: instance 8's Oracle query slowed from 25.9ms to 64.5ms, up 149%."
date: 2026-05-02
tags:
  - dbt
  - DuckDB
  - Parquet
  - MinIO
  - DataQuality
  - Analytics
category: personal/lakehouse
coverImage: /uploads/project/lakehouse/cover.svg
draft: false
series: "lakehouse"
seriesOrder: 3
---

## 0. 상황 — 내려는 놨는데, 여전히 못 답한다

[2편](/blog/project/lakehouse/lakehouse-2-extract-load)에서 어제치 스냅샷을 MinIO에 parquet로 안전하게 내렸습니다. 원천 = parquet = DuckDB 3자 일치까지 확인했고요. 그런데 정작 이 프로젝트가 존재하는 이유였던 질문 — **"지난 구간보다 느려진 쿼리 있어?"** — 앞에서는 raw가 여전히 침묵합니다.

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

## 1. 함정 — 시간순으로 늘어놓으면 감소가 섞인다

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

## 2. 판단 — 합쳐서 단조를 복원하고, 양 끝만 본다

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

## 3. 개선 — dbt 3계층

### staging — 얽힘을 접는다

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

### marts — 차분과 클램프

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

### 테스트 — 누적 카운터라서 delta는 음수일 수 없다

스키마 테스트(not_null·relationships) 외에, 이 도메인에만 있는 불변식을 singular 테스트로 박았습니다.

```sql
-- tests/assert_fct_delta_non_negative.sql
-- GREATEST(0, ...) 클램프가 살아 있으면 0행이어야 한다.
select * from {{ ref('fct_query_daily') }}
where delta_calls < 0 or delta_total_time_ms < 0
```

그레인 유일성(`assert_stg_grain_unique`, `assert_fct_grain_unique`)도 같은 방식으로 검증합니다.

## 4. 실측 — dbt run/test와 마트가 답한 질문

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

### 계보(lineage)

`dbt docs generate` 후 계보 그래프입니다. source에서 마트까지, 그리고 커스텀 테스트가 어디에 걸리는지 한눈에 보입니다.

![dbt lineage — raw.query_snapshot에서 stg, fct, mart_query_regression까지](/uploads/project/lakehouse/dbt-lineage.png)

`raw.query_snapshot`(초록 소스) → `stg_query_snapshot` → `fct_query_daily` → `mart_query_regression`으로 흐르고, fct에서 검증 테스트 세 갈래가 갈라집니다.

## 5. 잔여 — 정직한 한계

- **지문 충돌 근사**: SUM으로 얽힌 계열을 접은 건 서로 다른 물리 쿼리를 한 지문으로 합치는 근사입니다. `id`로 계열을 완벽히 분리하진 못해요(스냅샷마다 새 `id`). "지문 단위 총 활동"까지가 정직하게 낼 수 있는 그레인입니다.
- **first-vs-last의 손실**: 하루 중 리셋이 나면 재상승분을 일부 잃습니다(219그레인). DBTower 정식 로직과의 정합을 우선해 감수했고, 잃는 양은 클램프된 그레인 수로 계량해 뒀습니다. 인접 델타 합산은 반대로 과대계상하니, 둘 다 틀린 방향이 다를 뿐 완벽하진 않습니다.
- **품질 게이트 없음**: 어느 날 한 인스턴스 파티션이 수집 장애로 비면, 그 위 랭킹은 조용히 오답을 냅니다. 지금은 그걸 잡을 게 없어요 — freshness·빈 파티션 검증과 알림은 다음 편입니다.
- **구간이 짧다**: 아직 3일치(07-05~07)만 적재돼 사실상 이틀 비교입니다. "지난달" 규모의 추세는 적재가 쌓인 뒤에.

그래도 이 편에서 raw가 처음으로 질문에 답했습니다. 다음은 이 답을 **믿어도 되는지**를 지키는 품질 게이트입니다.

코드는 [GitHub](https://github.com/dj258255/dbtower-lakehouse)에 있습니다.

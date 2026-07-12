---
title: 'DuckLake를 얹어 lake를 house로 올리고, 알림·retry·컨테이너 dbt·CHECKPOINT로 운영까지 단단히 조인 기록'
titleEn: 'Laying DuckLake on the Lake to Make It a House, Then Hardening Operations with Alerts, Retries, dbt in the Container, and CHECKPOINT'
description: 'Parquet 덮어쓰기만으론 ACID도 타임트래블도 없어 엄밀히는 lake입니다. 1부에서 그 위에 테이블 포맷 DuckLake를 얹습니다. 카탈로그는 로컬에 이미 있는 PostgreSQL에(단 DBTower 메타 DB와 분리된 ducklake_catalog), 데이터 파일은 MinIO에 두어 서비스 추가는 0입니다. 네 번의 커밋으로 버전 v0~v4를 쌓고 AT (VERSION => n)으로 과거를 실제로 되살렸습니다. v2는 79,894, v3는 229,153이고, UPDATE한 행은 과거 버전에서 0.55, 현재 1000.55로 읽히며, BEGIN…ROLLBACK으로 149,259행을 지웠다 되돌려도 흔적이 없습니다. 2부는 운영 경화입니다. fail-closed 게이트가 막았다는 사실을 아무도 모르면 마트가 조용히 낡아가니까요. on_failure_callback으로 webhook 알림(강제 FAIL 주입 시 로컬 수신기에 dag_id·task_id·에러 요약이 실제 도착), retries=3과 지수 백오프(단 품질 게이트는 retries=0, 결정적 실패는 재시도해도 그대로 FAIL이니까), Dockerfile 분리 venv에 dbt를 구워 offload→quality_gate→transform 3태스크가 전부 컨테이너 안에서 success(dbt run PASS=3, test PASS=18), 주간 CHECKPOINT로 스냅샷 11→2와 S3 오브젝트 7→3(행수 229,153 불변), backfill 날짜 산수까지 실측으로 확정합니다.'
descriptionEn: 'With only Parquet overwrites there is no ACID and no time travel; strictly speaking it is a lake. Part 1 lays the DuckLake table format on top. The catalog goes into the PostgreSQL we already run locally (in a separate ducklake_catalog DB, isolated from DBTower''s metadata DB) and data files go to MinIO, so zero new services are added. Four commits stack versions v0..v4 and AT (VERSION => n) actually resurrects the past: v2 is 79,894, v3 is 229,153, the updated row reads 0.55 at the old version and 1000.55 now, and a BEGIN…ROLLBACK deleting 149,259 rows leaves no trace. Part 2 is operational hardening, because if nobody knows the fail-closed gate fired, the marts silently go stale. A webhook alert via on_failure_callback (an injected FAIL actually lands dag_id, task_id, and an error summary at a local receiver), retries=3 with exponential backoff (the quality gate keeps retries=0, since deterministic failures fail the same way on retry), dbt baked into a separate venv in the Dockerfile so offload, quality_gate, and transform all succeed inside the container (dbt run PASS=3, test PASS=18), a weekly CHECKPOINT taking snapshots 11 to 2 and S3 objects 7 to 3 with the row count unchanged at 229,153, and backfill date arithmetic pinned by measurement.'
date: 2026-06-06
tags:
  - DuckLake
  - DuckDB
  - PostgreSQL
  - Parquet
  - MinIO
  - Data Engineering
  - Airflow
  - dbt
  - Operations
category: personal/lakehouse
coverImage: /uploads/project/lakehouse/cover.svg
draft: false
series: "lakehouse"
seriesOrder: 3
---

## 1부. lake를 house로: PostgreSQL 카탈로그 테이블 포맷 DuckLake

### 0. 상황: 지금까지 만든 건 엄밀히 lake다

[2편](/blog/project/lakehouse/lakehouse-2-transform-and-gate)까지 파이프라인은 제법 갖춰졌습니다. 원천에서 추출하고(1편), dbt로 변환하고 반쪽 데이터를 막는 문지기까지 세웠죠(2편). 그런데 [0편](/blog/project/lakehouse/lakehouse-0-why)에서 스스로 그은 선이 하나 있었습니다.

> "Parquet 덮어쓰기만으론 ACID·타임트래블이 없어 엄밀히는 lake입니다. 테이블 포맷을 얹어야 house가 되고, 그래야 lakehouse라 부르는 게 정직합니다."

이 편은 그 문장을 닫는 편입니다.

무엇이 부족한지는 raw의 멱등성 규약에 그대로 드러나 있습니다. 1편에서 만든 적재는 파티션 프리픽스를 **통째로 지우고 다시 씁니다**(whole-partition overwrite). 같은 날짜를 몇 번 돌려도 결과가 같다는 건 backfill에는 큰 장점이지만 뒤집으면 이런 뜻이기도 합니다. **어제의 파티션이 오늘 덮어쓰이면, 어제 그 안에 무엇이 있었는지는 사라진다.** 파일이 없으니까요.

그래서 이런 질문에 답할 수 없습니다.

- "지난주 화요일 기준으로 다시 계산해줘." → 그날 parquet가 이미 덮였으면 불가능.
- "적재가 도중일 때 대시보드를 열면?" → 반쪽 상태가 그대로 보일 수 있음.
- "저 수치, 언제부터 저렇게 됐지?" → 버전이 없으니 되짚을 이력이 없음.

lakehouse의 정의는 개방 포맷(Parquet) 위에 **ACID·타임트래블·스키마 진화**를 얹은 것입니다. 지금 우리에겐 Parquet만 있고 그 위층이 비어 있어요. 그러니 지금은 lake에 머물러 있고, house라 부르기엔 이릅니다.

### 1. 파일 덮어쓰기에 '버전' 개념이 없다는 함정

raw 레이어의 시간 모델을 정확히 보겠습니다. `s3://lakehouse/raw/query_snapshot/dt=2026-07-06/instance_id=3/part-000.parquet`는 그 파티션의 **현재 진실 딱 하나**입니다. 재적재하면 같은 키에 새 바이트가 올라가고, 이전 바이트는 없어집니다. S3 버저닝을 켜면 오브젝트 버전은 남지만, 그건 스토리지 레벨의 파일 이력이지 **테이블 레벨의 논리 버전**이 아닙니다. "이 테이블의 3번째 커밋 시점"을 SQL로 가리킬 방법이 없어요.

정리하면 파일 덮어쓰기에는 세 가지가 구조적으로 빠져 있습니다.

```
원자성 없음     여러 인스턴스 파티션을 쓰는 도중 조회하면 반쪽이 보인다.
버전 없음       "N번째 상태"를 가리킬 좌표가 없다 → 타임트래블 불가.
스키마 고정      컬럼을 늘리면 옛 파티션과 새 파티션의 스키마가 갈라진다.
```

이걸 메우는 게 **테이블 포맷**입니다. 핵심 발상은 간단합니다. 데이터 파일(Parquet)은 그대로 두되, **"어느 스냅샷에 어떤 파일들이 속하는지"를 따로 기록하는 카탈로그**를 둡니다. 커밋할 때마다 카탈로그에 새 스냅샷 한 줄이 쌓이고, 각 스냅샷은 그 시점의 파일 목록을 가리킵니다. 그러면 과거 스냅샷을 지정해 그때의 파일들만 읽으면 그게 타임트래블이고, 커밋을 원자 단위로 만들면 그게 ACID입니다.

### 2. 카탈로그를 PostgreSQL에 두는 DuckLake라는 판단

테이블 포맷의 사실상 표준은 Apache Iceberg입니다. 다만 로컬 단일노드에서는 걸리는 지점이 있습니다. DuckDB에서 **Iceberg에 쓰려면 REST 카탈로그 서버가 따로 필요합니다**(path 기반은 읽기 전용). 관제 부하를 최소화하려고 시작한 프로젝트인데, 여기서 상시 서비스가 하나 더 느는 건 규모에 안 맞습니다.

그래서 **DuckLake**를 택했습니다. DuckLake는 카탈로그를 별도 서버 대신 **평범한 SQL 데이터베이스에 테이블로** 둡니다. 우리는 이미 PostgreSQL을 쓰고 있죠(원천 DBTower 메타 PG가 PG입니다). 그 인스턴스를 재사용하면 **서비스 추가가 0**입니다. 데이터 파일은 지금처럼 MinIO(S3)에 Parquet로 두고요.

한 가지 반드시 지킬 선이 있습니다. **카탈로그를 DBTower 메타 DB(`dbtower`)에 섞으면 안 됩니다.** 그 DB는 관측 데이터가 사는 원천이고, 분석계가 그걸 오염시키면 "운영계와 분석계를 분리한다"는 이 프로젝트의 첫 원칙이 무너집니다. 그래서 같은 PG 인스턴스 안에 **별도 DB `ducklake_catalog`를 새로 만들어** 카탈로그 전용으로 씁니다. 물리 인스턴스는 공유하되 데이터베이스는 분리합니다. 서비스 0의 이점은 취하면서 오염은 막는 방식이죠.

정리하면 이런 구도입니다.

```
카탈로그(메타데이터)  →  PostgreSQL  ducklake_catalog DB   (dbtower와 분리)
데이터 파일(Parquet)  →  MinIO(S3)   s3://lakehouse/ducklake/
```

스토리지/컴퓨트 분리는 그대로 유지됩니다. 오히려 "어떤 파일이 어느 버전에 속하나"라는 메타데이터가 SQL로 조회 가능한 PG에 앉으면서 더 또렷해집니다.

Iceberg를 뺀 걸 못 해서로 볼 수도 있지만, 실제 이유는 규모가 안 맞아서입니다. 타임트래블·스키마 진화라는 개념은 두 포맷이 동일하므로, 나중에 멀티엔진·대규모가 되면 Iceberg 전환은 카탈로그 어댑터를 바꾸는 문제입니다.

### 3. DuckLake ATTACH와 테이블 적재로 개선하다

구현은 `extract/ducklake_load.py` 한 모듈입니다. 순서대로 봅니다.

#### 카탈로그 DB 준비 (dbtower를 건드리지 않고)

`postgres` 기본 DB로 접속해 `ducklake_catalog`가 없으면 만듭니다. `CREATE DATABASE`는 트랜잭션 안에서 못 돌아서 autocommit으로 엽니다.

```python
def ensure_catalog_db(cfg: DuckLakeConfig) -> bool:
    conn = psycopg2.connect(cfg.admin_dsn())
    conn.autocommit = True                       # CREATE DATABASE는 트랜잭션 밖에서
    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM pg_database WHERE datname = %s", (cfg.catalog_db,))
        if cur.fetchone():
            return False                         # 이미 있으면 그대로 (멱등)
        cur.execute(f'CREATE DATABASE "{cfg.catalog_db}"')
        return True
```

#### ATTACH로 카탈로그는 PG에, 데이터는 S3에

DuckDB에서 `ducklake`·`postgres`·`httpfs` 확장을 로드하고, MinIO 접속용 S3 시크릿을 만든 뒤, 한 줄로 붙입니다. `DATA_PATH`가 데이터 파일이 떨어질 S3 경로입니다.

```python
con.execute(
    f"ATTACH 'ducklake:postgres:{cfg.catalog_dsn()}' AS {cfg.lake_alias} "
    f"(DATA_PATH '{cfg.data_path}')"
)
con.execute(f"USE {cfg.lake_alias}")
```

이 `ATTACH` 한 줄이 실행되는 순간, PG의 `ducklake_catalog`에 카탈로그 테이블 30개가 생깁니다(`ducklake_snapshot`, `ducklake_table`, `ducklake_data_file` …). 스키마·스냅샷·파일 목록이 전부 여기 SQL 테이블로 관리됩니다.

#### 테이블 만들고 닫힌 창을 적재

스키마는 raw 계약을 그대로 따르되, 파티션 키였던 `dt`를 값 컬럼으로 명시 선언합니다. 테이블 포맷이라 스키마를 추론에 맡기지 않고 카탈로그에 박아 둡니다. 적재는 MinIO의 raw parquet를 `read_parquet`로 읽어 `INSERT` 합니다. 이 INSERT 하나가 하나의 커밋(스냅샷)이 됩니다.

```python
con.execute("""
    INSERT INTO query_snapshot
    SELECT id, instance_id, captured_at, query_id, query_text,
           calls, total_time_ms, rows_examined, CAST(dt AS DATE)
    FROM read_parquet('s3://lakehouse/raw/query_snapshot/dt=2026-07-06/instance_id=*/*.parquet',
                      hive_partitioning = 1)
""")
```

수치는 **닫힌 UTC 창만** 씁니다. dt=2026-07-06(79,894행)과 dt=2026-07-05(149,259행)이죠. 07-07은 원천 DB의 시계 기준 아직 진행 중인 '오늘'이라 값이 계속 자라므로(2편에서 다뤘죠), 재현 가능한 실증에는 넣지 않습니다.

### 4. 실측: 버전이 쌓이고, 과거를 실제로 되살린다

`python -m extract.ducklake_load`를 돌리면 네 번의 커밋이 순서대로 쌓입니다. 아래는 **실제 실행 출력**입니다(지어낸 수치 아님).

```
[카탈로그 DB] ducklake_catalog @ localhost:15432 (신규 생성) — DBTower 메타 DB(dbtower)와 분리
[ATTACH] ducklake:postgres → DATA_PATH s3://lakehouse/ducklake/  (카탈로그=PG, 데이터=S3)

[커밋1] CREATE TABLE query_snapshot  → 버전 1
[커밋2] INSERT dt=2026-07-06  +79,894행  → 버전 2  (누적 79,894)
[커밋3] INSERT dt=2026-07-05  +149,259행  → 버전 3  (누적 229,153)
[커밋4] UPDATE id=382457 total_time_ms 0.55 → 1000.55  → 버전 4  (행수 불변 229,153)
```

커밋4는 '뒤늦게 정정된 스냅샷'을 흉내 낸 한 행 UPDATE입니다. 타임트래블로 되돌아볼 대상이죠.

#### 스냅샷(버전) 목록

`ducklake_snapshots('lh')`를 조회하면 커밋 하나하나가 버전으로 남아 있습니다.

```
v0  {'schemas_created': ['main']}
v1  {'tables_created': ['main.query_snapshot']}
v2  {'tables_inserted_into': ['1']}
v3  {'tables_inserted_into': ['1']}
v4  {'inlined_insert': ['1'], 'inlined_delete': ['1']}
```

한 가지 정직하게 짚을 것. 벌크 INSERT 두 건(v2·v3)은 S3에 Parquet 데이터 파일을 실제로 썼지만, 단일 행 UPDATE(v4)는 DuckLake가 Parquet를 새로 쓰는 대신 **카탈로그에 인라인**했습니다(`inlined_insert`/`inlined_delete`). 작은 변경까지 매번 파일을 만들지 않으려는 최적화입니다. 그래도 결과는 동일하게 버전으로 남습니다.

#### 타임트래블, 같은 테이블에서 버전별로 다른 결과

핵심은 이겁니다. **같은 테이블, 같은 쿼리인데, 버전만 지정하면 그 시점의 상태가 그대로 나옵니다.**

```
count @ v2 (07-06만 적재 직후)  = 79,894
count @ v3 (07-05까지 적재 직후) = 229,153
count @ v4 (현재)             = 229,153
```

`SELECT count(*) FROM query_snapshot AT (VERSION => 2)`는 79,894를, `AT (VERSION => 3)`은 229,153을 돌려줍니다. 07-06만 담겼던 그 순간을, 파일을 아무것도 되돌리지 않고 SQL 한 줄로 재현한 거예요. raw 덮어쓰기로는 불가능했던 일입니다.

행 하나의 값도 시점별로 다릅니다. 커밋4에서 UPDATE한 `id=382457`을 과거 버전과 현재에서 각각 읽으면,

```
total_time_ms @ v3(과거) = 0.55       -- UPDATE 이전
total_time_ms @ v4(현재) = 1000.55    -- UPDATE 이후
```

과거 버전이 UPDATE 이전 값을 그대로 보존하고 있습니다. "저 수치 언제부터 저랬지?"에 이제 답할 수 있습니다.

#### BEGIN에서 ROLLBACK까지, 원자성 확인

트랜잭션 안에서 149,259행(07-05 전체)을 지웠다가 되돌립니다.

```
트랜잭션 전 count       = 229,153
DELETE 07-05 후(txn 내) = 79,894
ROLLBACK 후 count       = 229,153   (원상복구)
스냅샷 수 5 → 5  (롤백은 버전을 남기지 않음)
```

트랜잭션 안에서는 79,894로 줄었지만 ROLLBACK 하면 229,153으로 흔적 없이 돌아오고, 스냅샷(버전)도 늘지 않습니다. 부분 반영이 없습니다. 이게 ACID의 A입니다.

#### 카탈로그=PG / 데이터=S3, 그리고 오염 없음

마지막으로 분리가 실제로 지켜졌는지 확인합니다. 카탈로그는 PG에, 데이터는 S3에 갈라져 앉아 있고, DBTower 메타 DB는 깨끗합니다.

```
PG ducklake_catalog:  ducklake_ 카탈로그 테이블 30개
                      ducklake_table = query_snapshot (1건)
                      ducklake_data_file = 2건 (79,894행 · 149,259행)
S3 s3://lakehouse/ducklake/main/query_snapshot/*.parquet
                      810 KB (79,894행) + 1.38 MB (149,259행)
PG dbtower(메타 DB):  ducklake_ 테이블 = 0   ← 오염 없음
```

![DuckLake ACID·타임트래블 실제 실행 출력으로 버전 v0~v4와 타임트래블, 롤백, 카탈로그/데이터 분리를 담았다](/uploads/project/lakehouse/ducklake-timetravel.png)

*위 이미지는 터미널풍 카드로 렌더했지만 내용은 전부 실제 실행 출력입니다. DuckDB·PostgreSQL은 웹 UI가 없어 CLI 출력을 그대로 담았습니다.*

### 5. 잔여, 정직한 한계

- **단일 노드입니다.** DuckLake는 카탈로그를 SQL DB에 두는 구조라 로컬 단일노드에 잘 맞지만, 여러 엔진(Spark·Trino·Flink)이 한 테이블을 공유하는 대규모 조직 표준은 여전히 Iceberg입니다. 여기선 규모가 안 맞아 DuckLake를 택했고, 개념(타임트래블·스키마 진화)이 같으니 전환은 카탈로그 어댑터 문제로 남겨둡니다. 규모를 보고 뺐을 뿐, 지원이 안 되는 건 아닙니다.
- **적재는 raw 스냅샷을 테이블로 등록하는 데까지입니다.** dbt-duckdb에도 DuckLake를 마트의 물질화 대상으로 붙이는 길이 있지만, 이 편의 목적은 ACID·타임트래블을 **또렷한 커밋 단위로** 실증하는 것이라, 명시적 INSERT/UPDATE로 버전을 쌓는 쪽을 택했습니다. dbt 파이프라인 전체를 DuckLake 위로 옮기는 건 별도 작업으로 남습니다.
- **스냅샷 만료(버전 폭증)는 아직입니다.** 커밋마다 버전이 쌓이므로, 오래 돌리면 카탈로그와 데이터 파일이 계속 늘어납니다. 오래된 스냅샷을 정리하는 만료 정책은 이번 범위 밖입니다.
- **스키마 진화는 구조만 확인했습니다.** 테이블 포맷이라 ADD COLUMN이 버전으로 남는다는 건 카탈로그 구조상 성립하지만, 이 편의 실측은 ACID·타임트래블 두 축에 집중했습니다. 컬럼 추가 후 과거 버전 조회까지의 실측은 다음으로 미룹니다.
- **수치는 닫힌 창만입니다.** 07-05·07-06(149,259·79,894)만 재현 근거로 썼습니다. 07-07은 원천의 진행 중인 오늘이라 값이 자라므로 넣지 않았습니다.

0편에서 "Parquet 덮어쓰기만으론 엄밀히 lake"라고 선을 그었습니다. 이 편에서 그 위에 테이블 포맷을 얹어, 같은 테이블의 과거를 SQL로 되살리고 트랜잭션을 원자로 만들었습니다. 이제 lake가 house가 됐고, lakehouse라 부르는 게 정직해졌습니다.

코드는 [GitHub](https://github.com/dj258255/dbtower-lakehouse)에 있습니다.

여기까지가 1부입니다. lake가 house가 됐어요. 이제 이걸 운영이라 부를 수 있는지 볼 차례입니다.

## 2부. 실패해도 아무도 모르는 파이프라인은 미완성: 알림·retry·컨테이너 dbt·CHECKPOINT

### 0. 상황: 게이트는 잘 막는데, 막았다고 아무도 안 알려준다

1부까지 파이프라인은 형태를 다 갖췄습니다. 추출하고(1편), 변환하고 반쪽 데이터를 막고(2편), 테이블 포맷으로 버전까지 쌓았죠(1부). 그런데 이걸 "운영한다"고 상상하는 순간 구멍이 줄줄이 보였습니다.

**첫째, 알림이 없습니다.** 2편의 품질 게이트는 fail-closed입니다. FAIL이면 transform이 실행되지 않아요. 잘 막습니다. 문제는 그다음입니다. 막았다는 사실을 누구에게도 알리지 않아요. 게이트가 어느 새벽에 FAIL을 내면, 파이프라인은 조용히 멈춘 채 제가 우연히 Airflow UI를 열어볼 때까지 그대로 있습니다. 그동안 마트는 낡아가고요. **조용히 틀린 데이터가 없는 것보다 나쁘듯, 조용히 멈춘 파이프라인은 안 멈춘 척하는 파이프라인과 다를 게 없습니다.** 차단은 시작이고 통보가 완성입니다.

**둘째, 이게 제일 부끄러운데, transform이 반쪽이었습니다.** DAG 그래프는 `offload → quality_gate → transform` 3단계인데, Airflow 컨테이너에 dbt가 없어서 transform 태스크는 "게이트 통과 확인" 로그만 남겼습니다. 실제 dbt run은 제가 호스트에서 손으로 돌렸어요. 그래프의 마지막 단계가 사람 손으로 남으면 오케스트레이션이라 부를 수 없습니다. 오케스트레이션 그림일 뿐이죠.

**셋째, DuckLake는 스스로 아무것도 지우지 않습니다.** 1부 잔여에 적어둔 그대로입니다. 커밋마다 스냅샷이 쌓이고 덮어쓰인 파일은 타임트래블을 위해 S3에 남습니다. 만료 없이 방치하면 카탈로그(PG)와 스토리지(S3)가 단조 증가해요.

그 밖에도 retry 정책이 기본값 방치였고, backfill 절차는 제 머릿속에만 있었습니다. 이 편은 새 기능 없이 **운영 경화**만 다룹니다. 화려하진 않지만 이거 없으면 앞의 편들이 전부 "데모"에 머뭅니다.

### 1. 알림·재시도·유지보수에 하나씩 있는 함정

#### 함정 1: SLA 콜백은 폐기 경로다

Airflow에서 "실패를 알린다"를 검색하면 `sla_miss_callback`이 같이 나옵니다. 쓰면 안 됩니다. SLA 기능은 오랫동안 버그가 많기로 유명했고(스케줄러 안에서 돌아 지연·누락이 잦음), **Airflow 3.0에서 아예 제거됐습니다.** 지금 2.x에서 붙여봤자 이주할 때 뜯어내야 할 빚이에요. 표준 경로는 `on_failure_callback`입니다. 태스크가 최종 실패하면(재시도 소진 후) 호출되는 콜백이죠.

그리고 알림 코드 자체의 함정: **알림이 실패하면?** webhook 수신기가 죽어 있을 때 콜백이 예외를 던지면, 알림 실패가 장애 대응을 더 꼬이게 만듭니다. 알림은 best-effort여야 해요. 전 과정을 try/except로 감싸고 실패하면 로그만 남긴 채 삼킵니다.

#### 함정 2: 품질 게이트를 재시도하면 안 된다

retry는 만능이 아닙니다. 재시도가 의미 있는 건 **일시 장애**(네트워크 순단, 원천 재기동)뿐이에요. 품질 게이트의 FAIL은 결정적입니다. 데이터가 틀렸다는 판정인데, 5분 뒤에 다시 검문한다고 데이터가 맞아지지 않습니다. 재시도는 원천 PG와 S3에 재검문 부하만 얹어요. 그래서 retry 정책은 태스크별로 갈라야 합니다: 추출·변환은 retries=3 + 지수 백오프, **게이트는 retries=0**(2편 설계 그대로).

여기에 이번에 몸으로 배운 게 하나 더 있습니다. 작업 중 원천 스택이 통째로 내려간 적이 있는데(머신 절전), psycopg2 기본값엔 접속 타임아웃이 없어서 **연결 시도가 무한 대기**로 멈춰버렸습니다. 걸려서 멈춘 태스크는 실패도 아니라서 재시도도 알림도 못 탑니다. 그래서 모든 PG DSN에 `connect_timeout=5`를 박았어요. 빨리 죽어야 재시도가 삽니다.

#### 함정 3: dbt와 Airflow를 같은 환경에 섞으면 안 된다

컨테이너에 dbt를 넣는 가장 쉬운 방법은 Airflow의 site-packages에 `pip install dbt-duckdb`를 얹는 겁니다. 하면 안 되는 걸로 널리 알려져 있어요. dbt-core와 Airflow는 공유 의존성(jinja2, click, protobuf 등)의 버전 요구가 자주 충돌해서 어느 한쪽을 올리는 순간 다른 쪽이 조용히 깨집니다. 관례는 **컨테이너 안 별도 venv에 dbt를 격리**하고 subprocess로 부르는 것입니다. Cosmos 같은 통합 도구도, MWAA 문서도 같은 이유로 이 구조를 권장합니다.

기존 compose의 `_PIP_ADDITIONAL_REQUIREMENTS`도 이참에 폐기했습니다. 컨테이너가 뜰 때마다 pip을 도는 방식이라 기동이 느리고 무엇보다 "그날 PyPI 상태"에 따라 환경이 달라지는 비재현 요소였거든요. Dockerfile로 구워야 이미지 해시가 곧 환경입니다.

#### 함정 4: DuckLake 정리는 순서가 있다

DuckLake의 유지보수 수단은 여러 개입니다. 스냅샷 만료(`ducklake_expire_snapshots`), 인접 파일 컴팩션(`ducklake_merge_adjacent_files`), 옛 파일 삭제(`ducklake_cleanup_old_files`) 같은 것들이죠. 이걸 손으로 하나씩 부르면 **순서에 따라 꼬입니다.** 컴팩션 먼저·만료 나중 같은 조합에서 파일이 남거나 스냅샷 참조가 어긋나는 이슈가 보고돼 있어요(ducklake #336, #536). 공식 권장은 **`CHECKPOINT` 번들**입니다. 만료+인라인 플러시+컴팩션을 안전한 순서로 한 번에 묶어 실행하죠. 보존 기간은 `expire_older_than` 옵션으로 선언하고요.

### 2. 넷을 한 번에, 전부 실측으로 내린 판단

정리하면 이번 편의 판단은 이렇습니다.

```
알림        on_failure_callback → webhook POST (URL은 env 주입, 실패는 삼킴)
retry       retries=3 + 지수 백오프. 단 quality_gate만 retries=0 (결정적 실패)
transform   Dockerfile: 분리 venv(/opt/dbt-venv)에 dbt-duckdb → 컨테이너 안 run+test
유지보수     @weekly DAG: CHECKPOINT 번들 + 삭제 예약 파일 정리, 보존 7일
```

보존 7일은 원천(DBTower 스냅샷 보존 7일)과 대칭입니다. raw parquet 원본이 별도 경로에 그대로 있으니, DuckLake 버전 7일이면 "지난주 기준 재계산"까지는 되고 그 이전 타임트래블은 포기합니다. 대신 용량이 유계가 되죠.

그리고 전부 실측합니다. 특히 이번 편의 핵심 증거는 하나예요: **`airflow dags test`로 3태스크가 전부 컨테이너 안에서 success가 되는 것.** transform 로그 안에 dbt의 PASS가 찍혀 있어야 합니다.

### 3. 코드는 얇게, 경계는 분명하게 개선하다

#### 알림 모듈 (extract/alerts.py)

의존성 0(표준 라이브러리 urllib)으로 짰습니다. 핵심은 두 겹의 try/except입니다. 전송 실패도, 콜백 내부 오류도 절대 밖으로 안 새 나갑니다.

```python
def notify_task_failure(context: dict) -> None:
    """Airflow on_failure_callback 진입점."""
    try:
        ti = context.get("task_instance")
        payload = {
            "event": "airflow_task_failed",
            "dag_id": ti.dag_id, "task_id": ti.task_id,
            "logical_date": str(context.get("logical_date")),
            "try_number": ti.try_number, "max_tries": ti.max_tries,
            "log_url": ti.log_url,
            "error": str(context.get("exception"))[:1000],
        }
        post_webhook(payload)          # 이 안에서도 실패는 로그만 남기고 삼킨다
    except Exception:
        log.exception("실패 알림 콜백 내부 오류(무시)")
```

URL은 `ALERT_WEBHOOK_URL` 환경변수로 주입합니다. Slack이든 Discord든 사내 수신기든 POST 받는 곳이면 되고, 미설정이면 no-op이라 알림 없이도 파이프라인은 돕니다.

#### DAG의 retry 정책과 콜백

```python
default_args={
    "retries": 3,
    "retry_delay": pendulum.duration(minutes=2),
    "retry_exponential_backoff": True,      # 2분 → 4분 → 8분
    "max_retry_delay": pendulum.duration(minutes=30),
    "on_failure_callback": notify_task_failure,
},
```

그리고 게이트만 예외를 명시합니다.

```python
@task(retries=0)  # 품질 FAIL은 결정적 — 재시도해도 그대로 FAIL
def quality_gate(offload_result: dict) -> dict:
```

#### Dockerfile에서 dbt는 분리 venv에

```dockerfile
FROM apache/airflow:2.10.4-python3.12

# 추출·게이트·유지보수 의존성 — Airflow venv에 직접
RUN pip install --no-cache-dir pyarrow==18.1.0 psycopg2-binary==2.9.10 \
    boto3==1.35.90 duckdb==1.5.4

# dbt는 분리 venv — Airflow 의존성과 절대 섞지 않는다
USER root
RUN python -m venv /opt/dbt-venv \
    && /opt/dbt-venv/bin/pip install --no-cache-dir dbt-duckdb==1.10.1 duckdb==1.5.4 \
    && chown -R airflow:0 /opt/dbt-venv
USER airflow
```

transform 태스크는 이 venv의 dbt를 subprocess로 부릅니다. run이 통과해도 test가 깨지면 태스크는 실패입니다.

```python
for command in ("run", "test"):
    proc = subprocess.run([DBT_BIN, command,
                           "--profiles-dir", DBT_PROJECT_DIR,
                           "--project-dir", DBT_PROJECT_DIR], ...)
    if proc.returncode != 0:
        raise RuntimeError(f"dbt {command} 실패")
```

한 가지 주의할 배선: dbt 프로파일의 S3 endpoint는 지금까지 호스트 관점(`localhost:19000`)이었습니다. 컨테이너 안에서는 MinIO가 `dbtower-minio:9000`이므로, 프로파일이 읽는 `S3_ENDPOINT_HOSTPORT` env를 compose에서 컨테이너 관점으로 주입했습니다. 같은 profiles.yml이 호스트에서도 컨테이너에서도 돌아갑니다.

#### DuckLake 유지보수 (extract/ducklake_maintenance.py + @weekly DAG)

공식 권장 순서 그대로 세 줄입니다.

```python
con.execute(f"CALL lh.set_option('expire_older_than', '{retention}')")  # 보존 선언
con.execute("CHECKPOINT lh")                        # 만료+플러시+컴팩션 번들
con.execute("CALL ducklake_cleanup_old_files('lh', cleanup_all => true)")  # 예약된 파일 실제 삭제
```

셋째 줄이 필요한 이유: 만료가 하는 일은 **삭제 예약**뿐입니다. 파일이 그 자리에서 바로 지워지진 않아요. 예약만으로는 S3 용량이 줄지 않아요. 그리고 모듈에 안전 불변식을 하나 박았습니다. 유지보수 전/후 테이블 행수를 대조해서 다르면 예외를 던집니다(유지보수는 과거를 지울 뿐 현재를 바꾸면 안 되니까요). 그 예외도 물론 webhook으로 옵니다.

### 4. 실측: 알림 도착·3태스크 e2e·CHECKPOINT 전후·backfill

실측 시점의 원천 시계는 2026-07-08 17:24 UTC입니다. 즉 **07-07이 닫힌 창이 됐습니다**(279,002행으로 안정). 이 편의 수치는 전부 닫힌 창만 씁니다.

#### 3태스크가 전부 컨테이너 안에서 success

`airflow dags test snapshot_offload 2026-07-08`(→ dt=2026-07-07 처리) 결과입니다.

```
$ airflow tasks states-for-dag-run snapshot_offload manual__2026-07-08T00:00:00+00:00
offload       success    # dt=2026-07-07, 279,002행 (원천 PG = parquet)
quality_gate  success    # 3검문 모두 OK → GATE: PASS
transform     success    # 컨테이너 안 dbt

transform 로그 안:
  dbt run   Done. PASS=3 WARN=0 ERROR=0 SKIP=0 TOTAL=3
  dbt test  Done. PASS=18 WARN=0 ERROR=0 SKIP=0 TOTAL=18
  Returned value: {'dt': '2026-07-07', 'dbt_run': 'PASS', 'dbt_test': 'PASS'}
```

![Airflow 그래프 뷰에서 offload·quality_gate·transform 3태스크가 전부 success다 (dbt가 컨테이너 안에서 돈 그 런)](/uploads/project/lakehouse/e2e-dag.png)

처음으로 세 단계가 전부 한 컨테이너 안에서 끝났습니다. 호스트의 제 손은 이제 그래프에 없습니다.

#### 강제 FAIL → webhook에 실제로 도착

freshness FAIL 임계를 0.5h로 조여(dt=07-07은 경계까지 0.9h) 게이트를 강제로 죽였습니다. 로컬 수신기(표준 라이브러리 http.server 한 장짜리, :18808)의 **실제 수신 로그**입니다.

```
[2026-07-08 17:47:22 UTC] POST /alert from 127.0.0.1
{
  "event": "airflow_task_failed",
  "dag_id": "snapshot_offload",
  "task_id": "quality_gate",
  "logical_date": "2026-07-08 00:00:00+00:00",
  "try_number": 1,
  "max_tries": 0,
  "log_url": "http://localhost:8080/dags/snapshot_offload/grid?...&task_id=quality_gate&...tab=logs",
  "error": "품질 게이트 FAIL — 파티션 ['2026-07-07']. 다운스트림 차단."
}
```

같은 순간 스케줄러 로그는 `Marking task as FAILED ... quality_gate` → `알림 전송 완료 (HTTP 200)` → DagRun failed(transform 미실행) 순서로 흘렀습니다. 2편의 차단에 드디어 통보가 붙었어요. 눈여겨볼 것은 `max_tries: 0`입니다. 게이트는 재시도 없이 즉시 죽고 즉시 알리죠. 결정적 실패에 재시도는 낭비니까요.

#### CHECKPOINT 전후, 쌓인 것이 줄고 현재는 그대로

1부 데모를 두 번 반복해 일부러 버전·파일을 쌓은 뒤, 컨테이너 안에서 `airflow dags test ducklake_maintenance`(데모용 보존 0초)를 돌렸습니다.

```
[DuckLake 유지보수] retention = 0 seconds
지표                          전              후
--------------------------------------------------
스냅샷 수                     11               2
활성 데이터 파일               2               2
S3 오브젝트 수                 7               3
S3 바이트             7,337,540       2,828,889
테이블 행수(불변식)      229,153         229,153
삭제된 파일: 7개
```

옛 버전 9개와 죽은 파일 7개(4.5MB)가 사라졌고, 현재 상태는 한 행도 안 변했습니다(불변식 검사 통과). 운영에선 이 DAG가 @weekly, 보존 7일로 돕니다. 트레이드오프는 명확합니다. 7일보다 오래된 버전으로 되돌아가는 타임트래블은 포기하고 대신 카탈로그와 스토리지가 유계가 됩니다.

#### backfill, 날짜 산수를 실측으로 확정

backfill은 문서 없이는 항상 헷갈립니다. 실측으로 확정했어요: `-s/-e`는 **논리 실행일 구간(양끝 포함)**이고, @daily에서 각 런은 **논리일의 전날 dt**를 처리합니다.

```
$ airflow dags backfill snapshot_offload -s 2026-07-06 -e 2026-07-07 --reset-dagruns -y
→ 런 2개 생성 (논리 07-06, 07-07 = dt 07-05, 07-06 처리)
→ 태스크 6/6 succeeded, failed 0
```

즉 **dt=D 하나만 재적재하려면 `-s D+1 -e D+1`**. 그리고 멱등 검증입니다. 재적재 전후가 완전히 같습니다.

| 항목 | backfill 전 | backfill 후 |
|---|---|---|
| dt=2026-07-05 행수 | 149,259 | 149,259 |
| dt=2026-07-06 행수 | 79,894 | 79,894 |
| dt=2026-07-06 오브젝트 수 | 6 | 6 |

1편에서 "파티션 통째 덮어쓰기 멱등"을 설계할 때 노린 게 바로 이 장면입니다. backfill이 무서운 일에서 명령 한 줄로 내려앉습니다. `catchup=False`는 그대로 둡니다. DAG를 며칠 껐다 켰을 때 Airflow가 밀린 날짜를 멋대로 대량 실행하는 걸 막고 과거 재처리는 위처럼 **명시적으로만** 하자는 결정이에요. 이 절차 전체(실패 대응 → 로그 → 재적재, dry-run의 알려진 제약 포함)는 `docs/RUNBOOK.md`로 문서화했습니다. 새벽에 알림을 받은 사람이 처음부터 끝까지 따라갈 수 있게요.

### 5. 잔여, 정직한 한계

- **마트는 여전히 전체 재빌드입니다.** 매일 fct/mart 테이블을 통째로 다시 만듭니다. 지금 규모(수십만 행)에선 수 초지만, 적재가 수개월 쌓이면 dbt incremental 모델로 바꿔야 합니다.
- **알림은 채널 하나, best-effort 하나입니다.** 심각도 라우팅(게이트 FAIL은 급하고 유지보수 실패는 덜 급함), 중복 억제, 에스컬레이션은 없습니다. 그리고 알림 실패를 삼키는 설계라 "알림이 안 옴 = 정상"이 아닙니다. 최종 진실은 Airflow UI라고 RUNBOOK에 못박았습니다.
- **dbt 통합은 subprocess까지입니다.** 모델별 태스크 분해·재시도는 Cosmos 같은 통합 레이어의 몫인데, 모델 3개 규모엔 과잉이라 넣지 않았습니다.
- **CHECKPOINT 주기는 @weekly 고정입니다.** 커밋 빈도나 카탈로그 크기에 따른 적응형 주기는 하지 않았습니다.
- **대시보드(Serve)는 여전히 다음 몫입니다.** 30일 시야가 쌓이는 중이라, "DBTower로는 데이터 없음 vs lakehouse로는 답이 나옴" 대비 실측은 적재가 더 쌓인 뒤에.

0편에서 시작한 질문은 "버려지는 데이터를 어떻게 살릴까"였습니다. 여기까지 오고 나니 대답이 조금 달라졌어요. 파이프라인인 줄 알았던 게 실은 **운영**이더군요. 막고(2편), 버전을 남기고(1부), 이제 실패를 통보하고 스스로를 청소하는 데까지 왔습니다. 실패해도 아무도 모르는 파이프라인은 미완성이니까요.

코드는 [GitHub](https://github.com/dj258255/dbtower-lakehouse)에 있습니다.

---
title: 'lake를 house로 — PostgreSQL 카탈로그 테이블 포맷 DuckLake'
titleEn: 'From Lake to House — DuckLake, a Table Format with a PostgreSQL Catalog'
description: "0편에서 약속했습니다 — Parquet 덮어쓰기만으론 ACID도 타임트래블도 없어 엄밀히는 lake라고. 이 편에서 그 약속을 닫습니다. raw는 파티션을 통째로 덮어쓰기 때문에, 어제 상태가 무엇이었는지는 파일이 이미 사라져 알 수 없습니다. 그 위에 테이블 포맷 DuckLake를 얹습니다. 카탈로그는 로컬에 이미 있는 PostgreSQL에(단 DBTower 메타 DB와 분리된 ducklake_catalog), 데이터 파일은 MinIO에 둡니다 — 서비스 추가 0. query_snapshot을 DuckLake 테이블로 만들고 네 번 커밋했습니다: CREATE → 07-06 적재(79,894) → 07-05 적재(누적 229,153) → 한 행 UPDATE. 그러자 버전이 v0~v4로 쌓였고, AT (VERSION => n)으로 과거를 실제로 되살렸습니다 — v2는 79,894, v3는 229,153, 그리고 UPDATE한 행은 과거 버전에서 0.55, 현재 1000.55. BEGIN…ROLLBACK으로 149,259행을 지웠다 되돌려도 흔적이 없었습니다. 카탈로그는 PG에 30개 테이블로, 데이터는 S3에 parquet 2개로 갈라져 앉았고, DBTower 메타 DB는 오염되지 않았습니다. 수치는 닫힌 창 07-05·07-06만 씁니다."
descriptionEn: "Part 0 made a promise — with only Parquet overwrites there is no ACID and no time travel, so strictly it is a lake. This part closes that promise. Because raw overwrites whole partitions, yesterday's state is gone with the file; you cannot ask what it was. So we lay a table format, DuckLake, on top. The catalog goes into the PostgreSQL we already run locally (in a separate ducklake_catalog DB, isolated from DBTower's metadata DB), and data files go to MinIO — zero new services. We register query_snapshot as a DuckLake table and commit four times: CREATE, load 07-06 (79,894), load 07-05 (cumulative 229,153), then a one-row UPDATE. Versions stack up v0..v4, and AT (VERSION => n) actually resurrects the past — v2 is 79,894, v3 is 229,153, and the updated row reads 0.55 at the old version, 1000.55 now. A BEGIN…ROLLBACK that deletes 149,259 rows leaves no trace. The catalog sits in PG as 30 tables, the data in S3 as two parquet files, and DBTower's metadata DB stays untouched. All figures use only the closed windows 07-05 and 07-06."
date: 2026-07-08
tags:
  - DuckLake
  - DuckDB
  - PostgreSQL
  - Parquet
  - MinIO
  - Data Engineering
category: personal/lakehouse
coverImage: /uploads/project/lakehouse/cover.svg
draft: true
series: "lakehouse"
seriesOrder: 5
---

## 0. 상황 — 지금까지 만든 건 엄밀히 lake다

[4편](/blog/project/lakehouse/lakehouse-4-quality-gate)까지 파이프라인은 제법 갖춰졌습니다. 원천에서 추출하고(2편), dbt로 변환하고(3편), 반쪽 데이터를 막는 문지기까지 세웠죠(4편). 그런데 [0편](/blog/project/lakehouse/lakehouse-0-why)에서 스스로 그은 선이 하나 있었습니다.

> "Parquet 덮어쓰기만으론 ACID·타임트래블이 없어 엄밀히는 lake입니다. 테이블 포맷을 얹어야 house가 되고, 그래야 lakehouse라 부르는 게 정직합니다."

이 편은 그 문장을 닫는 편입니다.

무엇이 부족한지는 raw의 멱등성 규약에 그대로 드러나 있습니다. 2편에서 만든 적재는 파티션 프리픽스를 **통째로 지우고 다시 씁니다**(whole-partition overwrite). 같은 날짜를 몇 번 돌려도 결과가 같다는 건 backfill에는 큰 장점이지만, 뒤집으면 이런 뜻입니다 — **어제의 파티션이 오늘 덮어쓰이면, 어제 그 안에 무엇이 있었는지는 사라진다.** 파일이 없으니까요.

그래서 이런 질문에 답할 수 없습니다.

- "지난주 화요일 기준으로 다시 계산해줘." → 그날 parquet가 이미 덮였으면 불가능.
- "적재가 도중일 때 대시보드를 열면?" → 반쪽 상태가 그대로 보일 수 있음.
- "저 수치, 언제부터 저렇게 됐지?" → 버전이 없으니 되짚을 이력이 없음.

lakehouse의 정의는 개방 포맷(Parquet) 위에 **ACID·타임트래블·스키마 진화**를 얹은 것입니다. 지금 우리에겐 Parquet만 있고 그 위층이 비어 있어요. 그러니 아직 house가 아니라 lake입니다.

## 1. 함정 — 파일 덮어쓰기에는 '버전'이라는 개념이 없다

raw 레이어의 시간 모델을 정확히 보겠습니다. `s3://lakehouse/raw/query_snapshot/dt=2026-07-06/instance_id=3/part-000.parquet` — 이 오브젝트는 그 파티션의 **현재 진실 딱 하나**입니다. 재적재하면 같은 키에 새 바이트가 올라가고, 이전 바이트는 없어집니다. S3 버저닝을 켜면 오브젝트 버전은 남지만, 그건 스토리지 레벨의 파일 이력이지 **테이블 레벨의 논리 버전**이 아닙니다. "이 테이블의 3번째 커밋 시점"을 SQL로 가리킬 방법이 없어요.

정리하면 파일 덮어쓰기에는 세 가지가 구조적으로 빠져 있습니다.

```
원자성 없음     여러 인스턴스 파티션을 쓰는 도중 조회하면 반쪽이 보인다.
버전 없음       "N번째 상태"를 가리킬 좌표가 없다 → 타임트래블 불가.
스키마 고정      컬럼을 늘리면 옛 파티션과 새 파티션의 스키마가 갈라진다.
```

이걸 메우는 게 **테이블 포맷**입니다. 핵심 발상은 간단해요 — 데이터 파일(Parquet)은 그대로 두되, **"어느 스냅샷에 어떤 파일들이 속하는지"를 따로 기록하는 카탈로그**를 둡니다. 커밋할 때마다 카탈로그에 새 스냅샷 한 줄이 쌓이고, 각 스냅샷은 그 시점의 파일 목록을 가리킵니다. 그러면 과거 스냅샷을 지정해 그때의 파일들만 읽으면 그게 타임트래블이고, 커밋을 원자 단위로 만들면 그게 ACID입니다.

## 2. 판단 — 카탈로그를 PostgreSQL에 두는 DuckLake

테이블 포맷의 사실상 표준은 Apache Iceberg입니다. 다만 로컬 단일노드에서는 걸리는 지점이 있습니다. DuckDB에서 **Iceberg에 쓰려면 REST 카탈로그 서버가 따로 필요합니다**(path 기반은 읽기 전용). 관제 부하를 최소화하려고 시작한 프로젝트인데, 여기서 상시 서비스가 하나 더 느는 건 규모에 안 맞습니다.

그래서 **DuckLake**를 택했습니다. DuckLake는 카탈로그를 별도 서버가 아니라 **평범한 SQL 데이터베이스에 테이블로** 둡니다. 우리는 이미 PostgreSQL을 쓰고 있죠(원천 DBTower 메타 PG가 PG입니다). 그 인스턴스를 재사용하면 **서비스 추가가 0**입니다. 데이터 파일은 지금처럼 MinIO(S3)에 Parquet로 두고요.

한 가지 반드시 지킬 선이 있습니다. **카탈로그를 DBTower 메타 DB(`dbtower`)에 섞으면 안 됩니다.** 그 DB는 관측 데이터가 사는 원천이고, 분석계가 그걸 오염시키면 "운영계와 분석계를 분리한다"는 이 프로젝트의 첫 원칙이 무너집니다. 그래서 같은 PG 인스턴스 안에 **별도 DB `ducklake_catalog`를 새로 만들어** 카탈로그 전용으로 씁니다. 물리 인스턴스는 공유하되 데이터베이스는 분리 — 서비스 0의 이점은 취하면서 오염은 막습니다.

정리하면 이런 구도입니다.

```
카탈로그(메타데이터)  →  PostgreSQL  ducklake_catalog DB   (dbtower와 분리)
데이터 파일(Parquet)  →  MinIO(S3)   s3://lakehouse/ducklake/
```

스토리지/컴퓨트 분리는 그대로 유지됩니다. 오히려 "어떤 파일이 어느 버전에 속하나"라는 메타데이터가 SQL로 조회 가능한 PG에 앉으면서 더 또렷해집니다.

Iceberg를 안 쓴 건 못 해서가 아니라 규모에 안 맞아서입니다. 타임트래블·스키마 진화라는 개념은 두 포맷이 동일하므로, 나중에 멀티엔진·대규모가 되면 Iceberg 전환은 카탈로그 어댑터를 바꾸는 문제입니다.

## 3. 개선 — DuckLake ATTACH와 테이블 적재

구현은 `extract/ducklake_load.py` 한 모듈입니다. 순서대로 봅니다.

### 카탈로그 DB 준비 (dbtower를 건드리지 않고)

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

### ATTACH — 카탈로그는 PG, 데이터는 S3

DuckDB에서 `ducklake`·`postgres`·`httpfs` 확장을 로드하고, MinIO 접속용 S3 시크릿을 만든 뒤, 한 줄로 붙입니다. `DATA_PATH`가 데이터 파일이 떨어질 S3 경로입니다.

```python
con.execute(
    f"ATTACH 'ducklake:postgres:{cfg.catalog_dsn()}' AS {cfg.lake_alias} "
    f"(DATA_PATH '{cfg.data_path}')"
)
con.execute(f"USE {cfg.lake_alias}")
```

이 `ATTACH` 한 줄이 실행되는 순간, PG의 `ducklake_catalog`에 카탈로그 테이블 30개가 생깁니다(`ducklake_snapshot`, `ducklake_table`, `ducklake_data_file` …). 스키마·스냅샷·파일 목록이 전부 여기 SQL 테이블로 관리됩니다.

### 테이블 만들고 닫힌 창을 적재

스키마는 raw 계약을 그대로 따르되, 파티션 키였던 `dt`를 값 컬럼으로 명시 선언합니다. 테이블 포맷이라 스키마는 추론이 아니라 카탈로그에 박힙니다. 적재는 MinIO의 raw parquet를 `read_parquet`로 읽어 `INSERT` — 이 INSERT 하나가 하나의 커밋(스냅샷)이 됩니다.

```python
con.execute("""
    INSERT INTO query_snapshot
    SELECT id, instance_id, captured_at, query_id, query_text,
           calls, total_time_ms, rows_examined, CAST(dt AS DATE)
    FROM read_parquet('s3://lakehouse/raw/query_snapshot/dt=2026-07-06/instance_id=*/*.parquet',
                      hive_partitioning = 1)
""")
```

수치는 **닫힌 UTC 창만** 씁니다 — dt=2026-07-06(79,894행)과 dt=2026-07-05(149,259행). 07-07은 원천 DB의 시계 기준 아직 진행 중인 '오늘'이라 값이 계속 자라므로(4편에서 다뤘죠), 재현 가능한 실증에는 넣지 않습니다.

## 4. 실측 — 버전이 쌓이고, 과거를 실제로 되살린다

`python -m extract.ducklake_load`를 돌리면 네 번의 커밋이 순서대로 쌓입니다. 아래는 **실제 실행 출력**입니다(지어낸 수치 아님).

```
[카탈로그 DB] ducklake_catalog @ localhost:15432 (신규 생성) — DBTower 메타 DB(dbtower)와 분리
[ATTACH] ducklake:postgres → DATA_PATH s3://lakehouse/ducklake/  (카탈로그=PG, 데이터=S3)

[커밋1] CREATE TABLE query_snapshot  → 버전 1
[커밋2] INSERT dt=2026-07-06  +79,894행  → 버전 2  (누적 79,894)
[커밋3] INSERT dt=2026-07-05  +149,259행  → 버전 3  (누적 229,153)
[커밋4] UPDATE id=382457 total_time_ms 0.55 → 1000.55  → 버전 4  (행수 불변 229,153)
```

커밋4는 '뒤늦게 정정된 스냅샷'을 흉내 낸 한 행 UPDATE입니다 — 타임트래블로 되돌아볼 대상이죠.

### 스냅샷(버전) 목록

`ducklake_snapshots('lh')`를 조회하면 커밋 하나하나가 버전으로 남아 있습니다.

```
v0  {'schemas_created': ['main']}
v1  {'tables_created': ['main.query_snapshot']}
v2  {'tables_inserted_into': ['1']}
v3  {'tables_inserted_into': ['1']}
v4  {'inlined_insert': ['1'], 'inlined_delete': ['1']}
```

한 가지 정직하게 짚을 것. 벌크 INSERT 두 건(v2·v3)은 S3에 Parquet 데이터 파일을 실제로 썼지만, 단일 행 UPDATE(v4)는 DuckLake가 Parquet를 새로 쓰는 대신 **카탈로그에 인라인**했습니다(`inlined_insert`/`inlined_delete`). 작은 변경까지 매번 파일을 만들지 않으려는 최적화입니다 — 결과는 동일하게 버전으로 남습니다.

### 타임트래블 — 같은 테이블, 버전별로 다른 결과

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

### 원자성 — BEGIN … ROLLBACK

트랜잭션 안에서 149,259행(07-05 전체)을 지웠다가 되돌립니다.

```
트랜잭션 전 count       = 229,153
DELETE 07-05 후(txn 내) = 79,894
ROLLBACK 후 count       = 229,153   (원상복구)
스냅샷 수 5 → 5  (롤백은 버전을 남기지 않음)
```

트랜잭션 안에서는 79,894로 줄었지만 ROLLBACK 하면 229,153으로 흔적 없이 돌아오고, 스냅샷(버전)도 늘지 않습니다. 부분 반영이 없습니다 — 이게 ACID의 A입니다.

### 카탈로그=PG / 데이터=S3, 그리고 오염 없음

마지막으로 분리가 실제로 지켜졌는지 확인합니다. 카탈로그는 PG에, 데이터는 S3에 갈라져 앉아 있고, DBTower 메타 DB는 깨끗합니다.

```
PG ducklake_catalog:  ducklake_ 카탈로그 테이블 30개
                      ducklake_table = query_snapshot (1건)
                      ducklake_data_file = 2건 (79,894행 · 149,259행)
S3 s3://lakehouse/ducklake/main/query_snapshot/*.parquet
                      810 KB (79,894행) + 1.38 MB (149,259행)
PG dbtower(메타 DB):  ducklake_ 테이블 = 0   ← 오염 없음
```

![DuckLake ACID·타임트래블 실제 실행 출력 — 버전 v0~v4, 타임트래블, 롤백, 카탈로그/데이터 분리](/uploads/project/lakehouse/ducklake-timetravel.png)

*위 이미지는 터미널풍 카드로 렌더했지만 내용은 전부 실제 실행 출력입니다. DuckDB·PostgreSQL은 웹 UI가 없어 CLI 출력을 그대로 담았습니다.*

## 5. 잔여 — 정직한 한계

- **단일 노드입니다.** DuckLake는 카탈로그를 SQL DB에 두는 구조라 로컬 단일노드에 잘 맞지만, 여러 엔진(Spark·Trino·Flink)이 한 테이블을 공유하는 대규모 조직 표준은 여전히 Iceberg입니다. 여기선 규모가 안 맞아 DuckLake를 택했고, 개념(타임트래블·스키마 진화)이 같으니 전환은 카탈로그 어댑터 문제로 남겨둡니다. 미지원이 아니라 규모 선택입니다.
- **적재는 raw 스냅샷을 테이블로 등록하는 데까지입니다.** dbt-duckdb에도 DuckLake를 마트의 물질화 대상으로 붙이는 길이 있지만, 이 편의 목적은 ACID·타임트래블을 **또렷한 커밋 단위로** 실증하는 것이라, 명시적 INSERT/UPDATE로 버전을 쌓는 쪽을 택했습니다. dbt 파이프라인 전체를 DuckLake 위로 옮기는 건 별도 작업으로 남습니다.
- **스냅샷 만료(버전 폭증)는 아직입니다.** 커밋마다 버전이 쌓이므로, 오래 돌리면 카탈로그와 데이터 파일이 계속 늘어납니다. 오래된 스냅샷을 정리하는 만료 정책은 이번 범위 밖입니다.
- **스키마 진화는 구조만 확인했습니다.** 테이블 포맷이라 ADD COLUMN이 버전으로 남는다는 건 카탈로그 구조상 성립하지만, 이 편의 실측은 ACID·타임트래블 두 축에 집중했습니다. 컬럼 추가 후 과거 버전 조회까지의 실측은 다음으로 미룹니다.
- **수치는 닫힌 창만입니다.** 07-05·07-06(149,259·79,894)만 재현 근거로 썼습니다. 07-07은 원천의 진행 중인 오늘이라 값이 자라므로 넣지 않았습니다.

0편에서 "Parquet 덮어쓰기만으론 엄밀히 lake"라고 선을 그었습니다. 이 편에서 그 위에 테이블 포맷을 얹어, 같은 테이블의 과거를 SQL로 되살리고 트랜잭션을 원자로 만들었습니다. 이제 lake가 house가 됐고, lakehouse라 부르는 게 정직해졌습니다.

코드는 [GitHub](https://github.com/dj258255/dbtower-lakehouse)에 있습니다.

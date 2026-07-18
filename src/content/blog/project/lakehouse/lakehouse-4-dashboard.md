---
title: 'Metabase가 DuckLake를 읽게 되기까지 밟은 세 가지 함정, 그리고 마침내 질문에 답하는 화면'
titleEn: 'Three Traps I Hit Before Metabase Could Read DuckLake and the Screen Finally Answered the Question'
description: '0편의 질문은 ''지난달보다 느려진 쿼리 있어?''였습니다. 앞의 세 편에 걸쳐 파이프라인을 만들었는데, 정작 그 답을 보려면 아직도 DuckDB 셸에 SQL을 쳐야 했습니다. 마트는 있는데 소비자가 없는, 출구 없는 공장이었습니다. 이 편에서 Metabase 대시보드로 출구를 답니다. 그런데 화면 한 장 다는 데 함정이 셋이었습니다. 공식 Metabase 이미지는 Alpine이라 DuckDB 드라이버의 네이티브 라이브러리가 아예 안 뜨고(UnsatisfiedLinkError 실측), dbt가 굽는 DuckDB 파일을 BI가 직접 물면 프로세스 간 단일 쓰기라 같은 호스트에선 새벽 transform이 ''Conflicting lock is held''로 죽는데, 컨테이너 경계에선 반대로 그 잠금마저 전파되지 않아 dbt가 열린 리더 밑에서 파일을 소리 없이 재작성했습니다(둘 다 실측했습니다. 시끄럽게 죽거나 조용히 위험하거나 둘 중 하나였습니다). 그래서 DAG 끝에 publish 태스크를 달아 마트를 DuckLake로 발행하고 Metabase는 DuckLake만 read-only로 읽게 했는데, 이번엔 대시보드가 카드 3장을 동시에 쏘자 커넥션마다 도는 init_sql의 CREATE SECRET이 write-write conflict로 충돌했습니다(세션 로컬 SET s3_*로 해소). 실측으로 닫습니다. 4태스크 e2e success, 마트-API-화면 3자 수치 일치(instance 8 Oracle, 25.89ms → 64.50ms, +149.1%), 발행 커밋과 겹친 연속 41회 읽기 전부 무중단이었습니다. 대시보드 정의는 손 클릭이 아니라 REST API 스크립트라 빈 Metabase에서 명령 두 줄로 재현됩니다.'
descriptionEn: 'Part 0 asked which queries got slower than last month. Six parts of pipeline later, seeing the answer still required typing SQL into a DuckDB shell: marts without a consumer, a factory with no exit. This part adds the exit, a Metabase dashboard, and three traps stood in the way. The official Metabase image is Alpine-based, so the DuckDB driver''s native library never loads (measured UnsatisfiedLinkError). Pointing BI directly at the DuckDB file dbt builds trips single-writer semantics: on one host the nightly transform dies with ''Conflicting lock is held'', while across container boundaries the lock silently fails to propagate and dbt rewrote the file under a live reader (both measured; the choice was die loudly or be quietly unsafe). So a publish task at the end of the DAG ships the marts to DuckLake and Metabase reads only DuckLake, read-only. At which point the dashboard firing three cards at once made per-connection init_sql CREATE SECRET statements collide with a write-write conflict (fixed with session-local SET s3_*). Closed with measurements: a four-task e2e success, mart-API-screen numbers agreeing three ways (instance 8 Oracle, 25.89ms to 64.50ms, +149.1%), and 41 consecutive reads overlapping publish commits, all uninterrupted. The dashboard is defined by a REST API script, reproducible from an empty Metabase in two commands.'
date: 2026-06-14
tags:
  - Metabase
  - DuckDB
  - DuckLake
  - Airflow
  - Data Engineering
category: personal/lakehouse
coverImage: /uploads/project/lakehouse/cover.svg
draft: false
series: "lakehouse"
seriesOrder: 4
---

## 0. 마트는 있는데 소비자가 없던 상황

[0편](/blog/project/lakehouse/lakehouse-0-why)은 질문 하나로 시작했습니다. **"지난달보다 느려진 쿼리 있어?"** DBTower는 스냅샷을 7일 뒤 지우니까 구조적으로 답할 수 없고, 그래서 버려지기 직전의 데이터를 내려 장기 이력을 만드는 파이프라인을 지었습니다. 추출하고(1편), 델타로 변환하고 반쪽 데이터를 막고(2편), 테이블 포맷으로 버전을 쌓고 실패하면 알리게(3편)까지 했습니다.

그런데 3편을 끝내고 그 질문에 실제로 답해보려니, 저는 여전히 **DuckDB 셸을 열고 SQL을 치고** 있었습니다. `mart_query_regression`은 매일 구워지는데, 그걸 볼 수 있는 사람이 SQL 칠 줄 아는 저 하나뿐입니다. 질문을 던진 사람은 SQL을 치는 사람이 아닙니다. **마트에 소비자가 없으면 파이프라인은 출구 없는 공장입니다.**

이 편은 그 출구를 답니다. 클릭 몇 번으로 0편의 질문에 답하는 화면 말입니다. 그리고 화면 한 장 다는 일이 생각보다 함정이 많았다는 이야기입니다.

## 1. 왜 Metabase를 골랐나

후보는 크게 둘이었습니다. 정적 리포트 계열(Evidence처럼 빌드 타임에 SQL을 돌려 페이지를 굽는 방식, 혹은 노트북 내보내기)과 BI 서버 계열입니다.

정적 리포트는 "만든 질문"에는 깔끔하게 답하지만, 질문이 조금만 비틀리면, 이를테면 "그거 인스턴스 8만 보여줘" 같은 요청이 들어오면 다시 빌드해야 합니다. 관제에서 파생되는 질문은 대부분 필터를 바꿔가며 파고드는 탐색이라, 서버가 라이브로 질의하고 필터가 배선된 대시보드가 맞다고 봤습니다.

BI 서버 중에 Metabase를 고른 근거는 셋입니다.

1. **DuckDB 커넥터가 있습니다.** MotherDuck이 유지하는 [커뮤니티 드라이버](https://github.com/motherduckdb/metabase_duckdb_driver)가 있어서, 마트를 다른 DB로 복사해 나르지 않아도 DuckDB/DuckLake를 직접 읽을 수 있습니다. 서빙용 DB를 새로 세우지 않는다는 뜻입니다.
2. **전부 API로 됩니다.** 초기 설정(관리자 계정)부터 커넥션·질문·대시보드·필터 배선까지 REST API가 있어서, 대시보드를 제 브라우저에만 두지 않고 스크립트로 재현되는 산출물로 만들 수 있습니다.
3. **운영 부담이 작습니다.** 컨테이너 하나, 앱 DB는 로컬 데모 규모면 내장 H2로 충분합니다(운영이면 PG로 빼야 하고 잔여에 적었습니다).

## 2. 화면 한 장에 함정이 셋

### 함정 1: 공식 이미지에서 드라이버가 안 뜬다

compose에 `metabase/metabase:v0.59.16`을 얹고 드라이버 jar를 plugins에 넣었습니다. 드라이버 등록까지는 로그가 멀쩡합니다(`Registered driver :duckdb`). 그런데 첫 연결에서:

```
UnsatisfiedLinkError: /tmp/libduckdb_java....so:
  Error loading shared library libstdc++.so.6: No such file or directory
```

공식 Metabase 이미지는 **Alpine(musl)** 기반인데, DuckDB JDBC의 네이티브 라이브러리는 glibc에 링크돼 있습니다. 드라이버 저장소도 README에서 "기본 Alpine 컨테이너에선 안 된다"고 못박고 Debian 기반 Dockerfile을 제공합니다. 그래서 이미지를 직접 구웠습니다. `eclipse-temurin:21-jre-jammy` 위에 metabase.jar와 드라이버 jar를 얹은 20줄짜리입니다.

여기서 버전을 짝으로 고정하는 게 중요합니다. 드라이버 릴리스 이름이 아예 "Metabase 59 + DuckDB 1.5.3"처럼 짝을 명시합니다. Metabase만 올리면 드라이버가 안 뜨고 드라이버의 DuckDB 계열이 dbt 쪽(1.5.4)과 갈라지면 파일/DuckLake 포맷 호환부터 다시 봐야 합니다. 저는 드라이버 1.5.3.0 = Metabase 59로 맞췄고, 1.5 동계열이라 포맷 호환은 실측으로 확인됐습니다.

### 함정 2: dbt의 DuckDB 파일을 직접 물면 안 된다

드라이버가 떴으니 가장 쉬운 연결은 dbt가 마트를 굽는 그 DuckDB 파일을 read-only로 무는 겁니다. 실제로 됩니다. 마트 테이블이 보이고, 랭킹 쿼리도 정확한 값을 돌려줬습니다. 여기서 멈췄으면 "연결 완료"라고 썼을 겁니다.

정작 발목을 잡는 건 읽기 쪽이 아닙니다. **동시성**입니다. DuckDB 파일은 프로세스 간 **단일 쓰기**입니다. 읽기 전용 커넥션이라도 물고 있으면 쓰기 프로세스가 배타 잠금을 못 잡습니다. 그리고 BI는 켜 두는 물건이고 커넥션 풀은 커넥션을 계속 쥐고 있습니다. 실측 두 장면:

**같은 호스트, 프로세스 둘.** 읽기 전용 커넥션이 파일을 문 상태에서 쓰기로 열면:

```
Conflicting lock is held in .../Python (PID 99884) by user beomsu.
```

리눅스 서버에 이대로 올리면 **매일 새벽 transform(dbt run)이 이 에러로 죽습니다.** 대시보드를 다는 순간 파이프라인이 깨지는 구조입니다.

**컨테이너 경계(macOS Docker Desktop).** 더 놀란 건 이쪽입니다. Metabase 컨테이너가 파일을 문 걸 확인하고(`/proc/1/fd/25 → /marts/dbtower_lakehouse.duckdb`) 스케줄러 컨테이너에서 dbt run을 돌렸습니다. 그런데 **에러 없이 성공했습니다.** 잠금이 virtiofs 마운트 경계를 넘어 전파되지 않은 것입니다. 그러니까 dbt가 열린 리더 밑에서 파일을 통째로 재작성했는데 아무도 몰랐습니다. 시끄럽게 죽는 앞 장면보다 나쁩니다. 단일 쓰기를 지켜주던 안전장치가 배포 형태에 따라 조용히 사라지고, 쓰기 도중 읽기가 무방비가 되기 때문입니다.

죽거나(잠금이 전파되는 환경), 조용히 위험하거나(안 되는 환경). 어느 쪽이든 **dbt의 DuckDB 파일은 서빙 계층으로 실격**입니다.

### 함정 3: 커넥션 풀의 init_sql이 동시 카드 로딩에서 SECRET 경합을 깨운다

해법(3절)으로 DuckLake 연결을 붙인 뒤에도 하나 더 있었습니다. 커넥션에는 "새 커넥션마다 실행"되는 init_sql을 줄 수 있는데, 첫 구현은 여기서 `CREATE OR REPLACE SECRET minio (...)`로 S3(MinIO) 자격증명을 만들었습니다. 카드를 한 장씩 API로 돌리면 전부 통과합니다. 그런데 **대시보드를 열어** 카드 3장이 동시에 나가면 2장이 500으로 죽었습니다:

```
TransactionContext Error: Catalog write-write conflict on alter with "minio"
```

대시보드가 카드들을 병렬로 쏘니 커넥션 풀이 커넥션을 여러 개 열고, 커넥션마다 도는 init_sql이 같은 DuckDB 인스턴스의 **공유 카탈로그**에 SECRET replace를 동시에 시도한 것입니다. 하나씩 돌릴 땐 절대 안 나오고 화면을 여는 순간에만 나오는, 전형적인 동시성 함정입니다. 해법은 경합할 공유 상태를 없애는 것입니다. SECRET 대신 **세션 로컬**인 `SET s3_endpoint / s3_access_key_id / ...`로 바꾸자 동시 3카드를 몇 번을 쏴도, 컨테이너를 재기동해 콜드 스타트로 열어도 전부 통과했습니다.

## 3. 서빙 계층은 이미 세워둔 lakehouse로

함정 3에서 잠깐 앞질러 등장한 해법을 이제 폅니다. 함정 2의 답은 "파일 말고 무엇을 물릴까"입니다. 마트를 PostgreSQL로 내보내고 PG 커넥터로 붙는 안도 검토했습니다. 드라이버가 아예 버전 비호환이었다면 그렇게 갔을 겁니다. 그런데 이미 3편에서 세운 **DuckLake**가 있습니다. 카탈로그는 PG 트랜잭션이고 데이터는 S3 parquet입니다. 읽기와 쓰기를 파일 잠금 대신 **DB 트랜잭션(스냅샷 격리)**이 중재합니다. raw가 이미 사는 곳이라 서비스 추가도 0입니다.

그래서 DAG 끝에 태스크 하나를 달았습니다.

```
offload → quality_gate → transform → publish
```

`publish`는 dbt가 구운 마트 두 장(fct_query_daily, mart_query_regression)을 DuckLake로 통째 복사합니다. 마트는 일간 집계라 수천 행 규모입니다. 증분보다 통째 교체가 단순하고 멱등합니다. DuckLake에선 DROP+CREATE가 **한 커밋**이라 읽는 쪽은 언제나 발행 전이나 후의 온전한 버전만 봅니다. 발행 후엔 행수를 원본과 대조해서 다르면 태스크를 실패시킵니다(그 실패도 3편의 webhook으로 옵니다).

Metabase는 이제 DuckLake를 뭅니다. 드라이버가 1.4.1.0부터 `ducklake:` 접두사를 지원해서, 커넥션의 데이터베이스 경로에 카탈로그 PG DSN을 그대로 씁니다:

```
ducklake:postgres:dbname=ducklake_catalog host=dbtower-postgres port=5432 user=... password=...
read_only: true
init_sql: SET s3_endpoint='dbtower-minio:9000'; SET s3_access_key_id='...'; ...
```

대시보드는 읽기 전용이고, 쓰기는 파이프라인(publish)만 합니다. 역할이 커넥션 수준에서 갈립니다.

마지막 조각은 재현성입니다. 대시보드를 손으로 만들면 그건 제 브라우저에만 있는 산출물입니다. `scripts/metabase_bootstrap.py`가 빈 Metabase에서 출발해 초기 설정 → DuckLake 커넥션 → 질문 3개(악화 랭킹 표·일별 추이·악화 쿼리 수) → 대시보드 1장 + 인스턴스 필터 배선까지 전부 REST API로 만듭니다(멱등이라 있으면 재사용합니다). 재현 절차가 문서에 없고 스크립트에 있습니다:

```bash
docker compose up -d metabase        # 커스텀 이미지 빌드(드라이버 포함)
.venv/bin/python scripts/metabase_bootstrap.py
```

## 4. 0편의 질문에 화면이 답한다

실측 시점 기준 원천 시계는 2026-07-08 18:28 UTC, dt=07-05·06·07 셋 다 닫힌 창입니다(수치 안정).

**파이프라인부터.** 4태스크가 전부 컨테이너 안에서 success:

```
offload       success   dt=2026-07-07, 279,002행 (원천 PG = parquet)
quality_gate  success   3검문 OK → GATE: PASS
transform     success   dbt run PASS=3 · dbt test PASS=18
publish       success   fct_query_daily 1,749행 · mart_query_regression 22행 → DuckLake
```

![Airflow 그래프 뷰에서 offload, quality_gate, transform, publish 4태스크가 전부 success](/uploads/project/lakehouse/e2e-dag-publish.png)

**그리고 화면.** 0편의 질문을 대시보드 이름으로 걸었습니다. 시야가 아직 3일이라 "지난달" 대신 "지난 구간"으로 바꿔서요. "지난 구간보다 느려진 쿼리 있어?"

![Metabase 대시보드 전체 화면으로, 악화 쿼리 수와 일별 호출량 추이, 악화 쿼리 랭킹, 인스턴스 필터가 보인다](/uploads/project/lakehouse/metabase-dashboard.png)

랭킹 표 클로즈업입니다. 답은 "있다"입니다. **instance 8(Oracle)의 `g108q7fj4pmkv`가 구간 첫날 평균 25.89ms에서 마지막 날 64.50ms로, +149.1%** 느려졌습니다. 2편에서 SQL로 캤던 그 값이 이제 클릭 한 번의 화면입니다.

![악화 쿼리 랭킹 클로즈업으로, instance 8이 25.89ms → 64.50ms, +149.1%](/uploads/project/lakehouse/metabase-regression.png)

수치는 세 경로로 대조했습니다. dbt의 DuckDB 파일을 직독하고, Metabase API로 DuckLake를 읽고, 대시보드 화면으로 확인했습니다. 셋 다 같은 값입니다(악화 1위 +149.1%, 일별 delta_calls 합 07-05=624,915 · 07-06=7,458 · 07-07=2,503,874).

필터 배선도 실측입니다. Instance를 8로 좁히면 카드 셋이 같이 좁혀집니다. 악화 쿼리는 4건이고 파일 직독 count와 일치합니다:

![인스턴스 필터를 적용해 instance 8만 남긴 화면, 악화 쿼리 4건](/uploads/project/lakehouse/metabase-dashboard-filtered.png)

**함정 2를 갈아엎은 보람도 실측으로.** publish(커밋 2회)를 돌리면서 Metabase로 0.3초 간격 연속 질의를 41회 쐈습니다. 전부 completed였고 매번 온전한 22행이었습니다. 발행 커밋과 정확히 겹친 읽기도 반쪽 테이블을 본 적이 없습니다. 파일을 물렸을 때(죽거나, 조용히 위험하거나)와 정반대입니다.

미리 적어둘 것: 지금 마트의 시야는 3일(07-05~07)입니다. 아직 DBTower의 7일 보존 안입니다. 하지만 구조가 다릅니다. 원천은 7일이 되는 날 이 스냅샷들을 지우고, lakehouse는 계속 쌓습니다. 이 화면의 시야는 매일 하루씩 자라고, "지난달" 비교는 한 달 뒤에 같은 화면에서 그냥 됩니다. DBTower엔 이 질문에 해당하는 화면 자체가 없고(두 시점 비교까지가 관제의 몫), 그건 0편에서 정리한 대로 결함처럼 보이지만 역할 분리입니다.

## 5. 정직하게 남긴 한계

- **시야가 아직 3일입니다.** 4절에 적은 대로 매일 자라지만, "DBTower로는 데이터 없음 vs lakehouse로는 답이 나옴"의 30일 대비 스크린샷은 적재가 7일을 넘긴 뒤에야 찍을 수 있습니다.
- **인스턴스가 숫자 id로 보입니다.** 원천의 database_instance(이름·기종)를 dim으로 내리지 않아 화면엔 "instance 8"뿐입니다. 기종 라벨이 필요해지면 작은 dim 추출을 추가해야 합니다.
- **Metabase 앱 DB가 H2 단일 파일입니다.** 로컬 데모 규모의 선택이고, 운영이면 PG로 빼고 백업 대상에 넣어야 합니다.
- **알림과 대시보드가 아직 별개입니다.** 게이트 FAIL이 webhook으로는 오지만 대시보드에 배지로 뜨지는 않습니다. 파이프라인 상태 카드가 다음 후보입니다.
- 3편에서 남긴 마트 전체 재빌드(증분 전환), dbt 태스크 분해(Cosmos), 적응형 CHECKPOINT도 그대로 남아 있습니다.

## 6. 원이 닫혔다

0편은 답할 수 없는 질문에서 시작했습니다. 네 편이 지나고 이제 그 질문은 대시보드 이름이 됐습니다. 매일 새벽 파이프라인이 스냅샷을 내리고, 검문하고, 델타로 갈아 마트를 굽고, DuckLake로 발행하면 화면이 답합니다. "있어. instance 8의 이 쿼리, +149.1%."

버려지던 데이터에 두 번째 삶을 주겠다는 게 이 시리즈의 약속이었습니다. 두 번째 삶이란 결국 **누군가의 질문에 답하는 것**이었습니다. 파이프라인은 그 답을 만드는 공정이었고, 이번 편에서 그 답이 나오는 창구를 달았습니다.

코드는 [GitHub](https://github.com/dj258255/dbtower-lakehouse)에 있습니다.

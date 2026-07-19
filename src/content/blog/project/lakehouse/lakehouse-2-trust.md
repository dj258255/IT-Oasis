---
title: '아카이브가 자기 자신을 지우던 치명 경로를 막고, CI와 deadman과 dbt contracts로 신뢰를 마저 묶은 이야기'
titleEn: 'Blocking the Path Where the Archive Deleted Itself, Then Tying Trust Together with CI, a Deadman, and dbt Contracts'
description: '코드 감사에서 받은 결함 목록의 1번이 치명이었습니다. offload의 멱등 재적재는 ''파티션을 통째로 지우고 다시 쓴다''인데 삭제가 원천 0행 체크보다 먼저라, 원천 보존(7일) 밖의 dt를 backfill이나 Clear로 재실행하면 아카이브 유일본 parquet를 지운 뒤 아무것도 안 쓰고 exit 0으로 ''성공''합니다. 1부에서 이 경로를 실제로 재현하고 fail-closed 가드(ArchiveSelfDestructError, exit 1 → 재시도·webhook 경로 탑승)로 막았습니다. 같은 감사에서 나온 나머지 셋, 곧 게이트의 원천 Seq Scan(332ms/31k버퍼 → 인스턴스별 인덱스 루프 20ms/76버퍼), publish 혼합 버전(개별 커밋 → 단일 트랜잭션), 유지보수 DAG의 데모 테이블 하드 참조도 걷어내고 pytest 35개로 고정했습니다. 2부는 그 신뢰를 커밋·침묵·계약 세 축으로 마저 묶습니다. CI(GitHub Actions 3관문: ruff·pytest·dbt)가 임베디드 DuckDB 덕에 MinIO도 PG도 없는 러너에서 tiny 픽스처 parquet로 dbt build를 e2e로 돌리고(PASS=25), dbt unit test로 델타 로직 엣지 4개를 정적 입력→기대 출력으로 못박고, deadman heartbeat가 30h 침묵을 실제 경보 발화로 잡고(기한 26h), dbt contracts가 마트 컬럼 타입을 DB 레벨로 강제해 latency_increase_ms를 VARCHAR로 바꾸자 빌드가 ''data type mismatch''로 막혔습니다. 회귀는 없었습니다. verify는 ALL MATCH(149,259/79,894행), pytest는 53개 통과입니다.'
descriptionEn: 'Item one on the audit''s defect list was fatal: offload''s idempotent reload is delete-partition-then-rewrite, but the delete runs before the zero-rows check, so re-running a dt outside the source''s 7-day retention via backfill or Clear deletes the archive''s only parquet copy, writes nothing, and exits 0 as a ''success''. Part 1 reproduces that path and blocks it with a fail-closed guard (ArchiveSelfDestructError, exit 1, riding the retry and webhook path), then sweeps three more findings, namely the gate full-scanning the source (332ms/31k buffers to 20ms/76 buffers via per-instance index loops), publish exposing a mixed version (separate commits to a single transaction), and the maintenance DAG hard-referencing a demo table, all pinned by 35 pytest cases. Part 2 ties that trust across commits, silence, and contracts: CI (GitHub Actions, three gates: ruff, pytest, dbt) builds the whole dbt DAG e2e on a runner with no MinIO or PG thanks to embedded DuckDB and tiny fixture parquet (PASS=25), dbt unit tests pin four delta-logic edges as static input-to-output, a deadman heartbeat catches a planted 30h silence against a 26h deadline with a real alert, and dbt contracts enforce mart column types at the DB level, so changing latency_increase_ms to VARCHAR blocked the build with ''data type mismatch''. No regression: verify ALL MATCH (149,259/79,894), pytest 53.'
date: 2026-07-04
tags:
  - Data Engineering
  - Airflow
  - DuckLake
  - PostgreSQL
  - pytest
  - CI/CD
  - dbt
  - DuckDB
category: personal/lakehouse
coverImage: /uploads/project/lakehouse/cover.svg
draft: false
series: "lakehouse"
seriesOrder: 2
---

## 1부. 아카이브가 자신을 지우는 경로: 멱등 덮어쓰기가 보존 창 밖에서 자기파괴가 될 때

### 0. 8일 뒤에 재적재 버튼을 누른 상황

지난주 화요일 새벽, 게이트가 FAIL을 냈고 webhook 알림이 왔습니다. 그런데 그 주가 바빴습니다. 알림은 읽었고 "주말에 재적재하지"라고 생각만 하고 넘어갑니다. 8일이 지난 오늘에서야 [RUNBOOK](https://github.com/dj258255/dbtower-lakehouse/blob/main/docs/RUNBOOK.md) 절차대로 backfill을 겁니다.

```bash
airflow dags backfill snapshot_offload -s 2026-07-01 -e 2026-07-01 --reset-dagruns -y
```

offload는 초록불로 끝납니다. 로그도 평화롭습니다. "적재 완료, 총 0행"이라고 합니다. 그리고 그 순간, **dt=07-01의 아카이브 유일본이 방금 사라졌습니다.**

원천 DBTower는 스냅샷을 7일만 보존합니다. 이 시리즈의 존재 이유가 그것이었습니다. 원천이 지우기 전에 내려서, lakehouse가 유일본이 되게 하는 것입니다. 그런데 8일 전 dt를 재실행하면 원천엔 이미 그 날짜가 없습니다. 그리고 1편 2부에서 만든 멱등 재적재는 **"파티션을 통째로 지우고 다시 쓴다"** 입니다. 원천이 0행이면? 지우고 아무것도 안 씁니다.

이번 편은 코드 감사에서 이 경로가 확정 결함으로 잡힌 뒤, 그것까지 포함해 결함 넷을 전부 잡은 기록입니다. 넷 다 "잘 만들었다고 믿었던 장치의 뒷면"이라는 공통점이 있습니다.

### 1. 멱등의 뒷면이라는 함정

1편에서 멱등 재적재를 이렇게 구현했습니다.

```python
for instance_id in instance_ids:
    table = _fetch_partition(conn, instance_id, day_start, day_end)
    prefix = f"{RAW_PREFIX}/dt={dt}/instance_id={instance_id}/"

    # 멱등: 이 파티션에 이전 산출물이 있으면 먼저 비운다.
    removed = _delete_prefix(s3, sink.bucket, prefix)

    if table is None:
        log.info("해당 날짜 데이터 없음 → 스킵")
        continue                      # <- 삭제는 이미 끝난 뒤다
    ...
```

delete-first는 멱등 덮어쓰기의 정석입니다. 같은 dt를 몇 번 돌려도 중복 0. 1편까지의 검증에서 실제로 잘 동작했습니다. 문제는 이 코드가 세운 암묵적 전제입니다: **"원천은 언제나 진실이고, 지운 만큼 다시 쓸 수 있다."**

보존 창 안에서는 참입니다. 창 밖에서는 정반대가 됩니다. 원천은 이미 지웠고 parquet가 유일한 진실인데, 코드는 여전히 원천을 진실로 믿고 유일본을 지웁니다. 그리고 `if table is None: continue`으로 스킵합니다. 예외도 없고 exit 0입니다. **아카이브를 지키려고 만든 파이프라인에, 아카이브가 자신을 지우는 경로가 내장돼 있었던 겁니다.**

실제로 재현했습니다. 실데이터와 무관한 dt=2026-06-01에 가짜 파티션을 심고(원천은 읽기 전용 그대로였고, 시연은 MinIO에서만), 그 dt로 offload를 돌렸습니다.

```
--- before ---
  s3://lakehouse/raw/query_snapshot/dt=2026-06-01/instance_id=1/part-000.parquet  2665 bytes
--- run_offload 2026-06-01 (원천 0행, 수정 전 코드) ---
INFO 기존 파티션 오브젝트 1개 삭제 (raw/query_snapshot/dt=2026-06-01/instance_id=1/)
INFO instance 1: 해당 날짜 데이터 없음 → 스킵
INFO 적재 완료 dt=2026-06-01 총 0행
--- after ---
  (dt=2026-06-01 파티션 아래 오브젝트 없음)
```

"기존 파티션 오브젝트 1개 삭제" 한 줄과 함께 유일본이 사라졌고 프로세스는 성공으로 끝났습니다.

"게이트가 잡아주지 않냐"고 물을 수 있습니다. 잡습니다. 다음 게이트 실행에서 reconciliation이 FAIL을 내고 webhook도 옵니다. 그런데 그게 뭐가 달라집니까. 게이트는 **사후 통보**입니다. 데이터는 이미 없습니다. 복구할 원천도 이미 없습니다. 1편 4부에서 "조용히 틀린 데이터는 없는 것보다 나쁘다"며 fail-closed를 읽기 경로(dbt 앞)에 세웠는데, 정작 **쓰기 경로에는 fail-closed가 없었습니다.** 사후 검문소에 기대는 대신, 삭제 버튼 앞에서 손을 멈췄어야 합니다.

### 2. 쓰기 경로에도 fail-closed를 세운다는 판단

수정의 원칙은 한 문장입니다. **지울 자격은 다시 쓸 수 있는 자에게만 있다.**

원천에서 N행을 읽어왔다면 지우고 다시 써도 됩니다. 기존 멱등 경로 그대로입니다. 원천이 0행인데 파티션도 없다면 정말 아무것도 없는 날이니 스킵. 그런데 **원천이 0행인데 기존 파티션이 존재한다면**, 그 파티션은 유일본일 가능성이 높습니다. 이때는 삭제하지 않고 시끄럽게 실패해야 합니다.

```python
def decide_partition_action(source_rows: int, partition_exists: bool) -> str:
    if source_rows > 0:
        return "overwrite"
    if not partition_exists:
        return "skip"
    raise ArchiveSelfDestructError(
        "원천 0행인데 기존 파티션 오브젝트가 존재 — 보존 창 밖 재적재로 판단. "
        "이 파티션이 유일본일 수 있어 삭제를 거부한다(fail-closed). "
        "정말 지워야 하면 사람이 명시적으로 지운 뒤 재실행할 것."
    )
```

이 결정을 삭제보다 **먼저** 태웁니다. 예외로 죽는 게 핵심입니다. exit 1이면 Airflow가 태스크를 failed로 표시하고 1편 6부에서 깐 on_failure_callback이 webhook을 쏩니다. "조용한 성공 + 사후 FAIL 알림"이 "즉시 실패 + 유일본 보존"으로 바뀝니다. 같은 입력으로 다시 돌린 결과:

```
ArchiveSelfDestructError: 원천 0행인데 기존 파티션 오브젝트가 존재 — ...
--- after ---
  s3://lakehouse/raw/query_snapshot/dt=2026-06-01/instance_id=1/part-000.parquet  2665 bytes
```

2,665바이트가 그대로 있습니다. 잘못 누른 backfill은 이제 데이터를 지우는 대신 알림을 만듭니다.

자동 우회 경로는 일부러 안 만들었습니다. "정말 지우고 싶으면 플래그로" 같은 옵션은 이 가드가 막으려는 바로 그 실수를 한 단계 뒤로 미룰 뿐입니다. 정말 지워야 하는 파티션이면 사람이 MinIO에서 명시적으로 지우고 재실행합니다. 파괴적 행위에는 파괴적 행위의 절차를 요구하는 게 맞다고 봤습니다.

### 3. 뿌리가 같은 나머지 셋 개선

감사가 잡은 나머지 셋은 치명도는 낮지만, 전부 "장치가 자기 원칙을 자기한테는 적용 안 했다"는 같은 뿌리입니다.

#### 3-1. 게이트가 원천을 Seq Scan하고 있었다 (F2)

1편 2부에서 추출은 인덱스 `idx_snapshot_instance_time(instance_id, captured_at)`의 선두 컬럼을 타도록 instance별 루프로 짰습니다. captured_at 단독 조건은 선두를 못 타기 때문입니다. 그런데 1편 4부의 게이트(`_pg_counts`)와 검증 스크립트(verify_count)는 정확히 그 안티패턴으로 원천을 세고 있었습니다.

```sql
-- 게이트가 매일 던지던 질의
SELECT instance_id, count(*) FROM query_snapshot
WHERE captured_at >= %s AND captured_at < %s GROUP BY instance_id
```

EXPLAIN ANALYZE 실측:

```
Parallel Seq Scan on query_snapshot  (actual time=78.755..318.093 rows=49753 loops=3)
  Rows Removed by Filter: 169683
Buffers: shared hit=15115 read=15962
Execution Time: 332.256 ms
```

원천 전체를 훑고 65만 행 중 51만 행을 버립니다. 관측 대상인 메타 PG에 게이트가 매일 이 부하를 주고 있었던 것입니다. dbtower 시리즈에서 "관제가 부하가 되면 안 된다"고 그렇게 썼는데, 게이트가 부하가 되고 있었습니다. 레지스트리 인스턴스별 등치 루프로 바꾼 뒤:

```
Index Only Scan using idx_snapshot_instance_time  (actual time=1.177..18.481 rows=41313)
  Heap Fetches: 0
Buffers: shared hit=5 read=71
Execution Time: 20.213 ms
```

332ms/31,077버퍼가 인스턴스당 20ms/76버퍼로 줄었습니다. 게이트 전체(2일치 4검문)가 0.5초에 끝납니다.

#### 3-2. publish의 원자성이 테이블 하나짜리였다 (F3)

1편 7부에서 "DuckLake에선 DROP+CREATE가 한 커밋이라 읽는 쪽은 온전한 버전만 본다"고 썼습니다. 맞는 말인데, **테이블 하나 단위로만** 맞는 말이었습니다. publish는 마트 2개(fct_query_daily, mart_query_regression)를 루프로 돌며 각각 커밋합니다. fct 발행 성공 → mart 발행 실패면? 대시보드는 "오늘의 fct + 어제의 mart"라는, 존재한 적 없는 혼합 버전을 봅니다.

장애 주입으로 재현했습니다. 두 번째 CREATE 직전에 예외를 던지는 프록시를 커넥션에 씌우고 발행:

```
[주입 전] 최신 스냅샷 v31
[주입] publish_marts 사망: 주입 장애: 두 번째 마트 발행 직전 사망
[주입 후] 최신 스냅샷 v32
  v32  {'tables_created': ['main.fct_query_daily'], ...}  <- 주입 후 새로 생김
=> 혼합 상태: fct만 새 스냅샷으로 발행, mart는 이전 버전에 방치
```

수정은 DuckLake가 이미 주는 걸 쓰면 됩니다. 카탈로그가 PG 트랜잭션이니, 두 발행을 `BEGIN … COMMIT` 하나로 묶으면 끝입니다. 같은 주입을 다시:

```
[주입 후] 최신 스냅샷 v32 (이전 v32)  — 새 스냅샷 0개
=> 원자성 유지: 둘 다 이전 버전(대시보드는 온전한 과거를 본다)
```

정상 발행은 이제 스냅샷 하나에 두 테이블이 함께 담깁니다(`v33 tables_created: [mart_query_regression, fct_query_daily]`). 같은 dt의 산출물은 함께 나가거나 함께 안 나가거나, 둘 중 하나여야 합니다.

#### 3-3. 유지보수 DAG가 데모 산출물에 기대 있었다 (F4)

주간 유지보수 DAG의 measure()가 `query_snapshot` 테이블을 하드 참조하고 있었습니다. 그 테이블은 1편의 데모(run_demo)의 산출물입니다. 데모를 안 돌린 새 환경에 이 저장소를 배포하면? 격리된 새 카탈로그에서 실측:

```
CatalogException: Table with name query_snapshot does not exist!
```

주간 DAG가 첫 실행에서 즉사합니다. 유지보수는 "있는 것"을 정리하는 작업입니다. 특정 테이블이 있어야만 돌 이유가 없습니다. information_schema에서 지금 존재하는 테이블 목록을 읽어 그 전체(마트 포함)를 계측하도록 바꿨고 테이블이 하나도 없으면 스냅샷·고아 파일 정리만 하고 지나갑니다. 행수 불변식도 덤으로 좋아졌습니다. 전엔 데모 테이블 하나만 지켰는데 이제 테이블별로 전부 대조합니다.

같은 김에 run_demo의 파괴성도 막았습니다. 데모는 재실행 대비로 `DROP TABLE IF EXISTS query_snapshot`을 치는데, 그 테이블에 운영 데이터가 쌓여 있어도 말없이 지웁니다. 이제 기존 테이블이 있으면 확인(`--force` / `DUCKLAKE_DEMO_FORCE=1` / 대화형 y) 없이는 중단합니다:

```
중단: 기존 query_snapshot(229,153행) 보존. 재생성하려면 --force 또는
DUCKLAKE_DEMO_FORCE=1로 명시할 것.
```

F1과 같은 원칙입니다. **파괴적 기본값 금지.**

#### 3-4. 게이트 4축 + 테스트 자산

감사의 "시간 되면" 목록에서 둘을 더 담았습니다. 게이트에 네 번째 검문 **스키마 드리프트**를 추가했습니다. 원천 information_schema를 추출 계약(SNAPSHOT_SCHEMA)과 대조해서, 컬럼 유실·타입 변경은 FAIL(다음 추출이 깨진다), 원천에만 생긴 새 컬럼은 WARN(추출은 돌지만 그 컬럼이 조용히 버려지는 중이라는 신호)입니다. 알림 payload에는 Metabase 대시보드 URL 필드를 얹었습니다. 알림 받은 사람이 "지금 화면이 어떤 상태인가"를 한 클릭에 보도록 했습니다.

그리고 이 프로젝트에 처음으로 `tests/`를 열었습니다. 여덟 단계 동안 검증은 전부 실측 스크립트였는데, 실측은 "그때 맞았다"까지만 증명합니다. 판정 로직이 조용히 바뀌는 걸 막으려면 고정이 필요합니다. 게이트 4검문의 판정(경계값 포함), F1 가드(순수 결정 로직 + 얇은 페이크 PG/S3로 run_offload 통합 경로), offload 경계(dt 파싱·하루 창·parquet 스키마 계약), 발행 원자성(BEGIN/COMMIT/ROLLBACK 시퀀스)까지:

```
$ pytest -q
...................................                                      [100%]
35 passed in 0.50s
```

### 4. 회귀 없음을 확인한 실측

수정이 기존 파이프라인을 안 깨뜨렸는지가 마지막 검문입니다. 원천 수집기가 현재 꺼져 있어(원천 max(captured_at)=07-07 23:04) 닫힌 창만 수치로 씁니다.

```
$ python -m extract.verify_count 2026-07-05 2026-07-06
dt              source PG    parquet(S3)   match
------------------------------------------------
2026-07-05        149,259        149,259      OK
2026-07-06         79,894         79,894      OK
RESULT: ALL MATCH
```

인스턴스별 루프로 바꾼 카운트가 기존 수치와 정확히 같습니다. 질의 형태만 바뀌고 답은 불변입니다. 4축 게이트도:

```
$ python -m extract.quality 2026-07-05 2026-07-06
2026-07-05   reconciliation  OK   PG=parquet=149,259행 (6인스턴스)
             completeness    OK   기대 6인스턴스 전부 존재
             freshness       OK   최신 23:59:30, 경계까지 0.0h
             schema_drift    OK   기대 8컬럼 전부 타입 일치
             = dt verdict    OK   통과
...
GATE: PASS — 모든 dt 통과 → 다운스트림 진행 가능
```

호스트 run_pipeline(게이트 → dbt run)도 PASS=3으로 완주했고, 시연에 쓴 것들은 전부 원상복구했습니다. 가짜 파티션을 지우고, 장애 주입 뒤 마트를 정상 재발행(fct 1,749행 · mart 22행)하고, 새 환경 시연용 scratch 카탈로그를 DROP했습니다. 전 과정에서 원천은 읽기 전용 그대로였습니다.

### 5. 정직하게 남은 한계

- **가드는 "0행 vs 존재"까지만 봅니다.** 원천이 부분 유실된 경우(0은 아니지만 기존 파티션보다 훨씬 적은 행)는 여전히 덮어씁니다. 그건 게이트 reconciliation이 사후에 잡는 영역으로 남겼는데, 쓰기 전 행수 비교(기존 파티션 대비 급감 시 거부)까지 넣을지는 오탐(정당한 재수집 감소)과의 트레이드오프라 다음 판단거리입니다.
- **테스트는 자산까지고 CI 배선은 다음입니다.** pytest 35개가 로컬에서 도는 것과 커밋마다 강제되는 것은 다른 이야기입니다.
- **스키마 드리프트는 원천 방향만 봅니다.** parquet 쪽(과거 파티션 간 스키마 이질성)은 읽기 시점에 DuckDB가 시끄럽게 죽는 것에 기대고 있습니다.
- 알림의 대시보드 URL은 환경변수 배선까지입니다. 게이트 FAIL을 대시보드 배지로 띄우는 상태 카드는 여전히 다음 후보입니다.

### 6. 지키는 쪽을 지키며 끝맺기

이 시리즈 내내 "원천을 지킨다"는 원칙은 잘 지켰습니다. 읽기 전용 세션부터 서버커서, 인덱스 선두, 시간창까지 빠짐없이 지켰습니다. 그런데 감사가 보여준 건, 정작 **지키는 쪽, 곧 아카이브 자신을 지키는 코드가 없었다**는 사실입니다. 멱등 덮어쓰기는 보존 창 안에서만 멱등이었습니다. 게이트는 원천에 부하를 줬고 원자성은 테이블 하나짜리였습니다. 유지보수는 데모에 기대 있었고요.

넷 다 처음 만들 때 틀린 코드가 아니었습니다. 전제가 바뀌는 지점에서 뒷면이 드러났을 뿐입니다. 보존 창 밖, 동시 실패, 새 환경 같은 곳 말입니다. 그 지점을 코드가 스스로 인지하고 시끄럽게 멈추게 만드는 것, 그게 이번 편의 전부였습니다. 유일본을 지운 뒤의 알림은 부고고, 지우기 전의 실패는 방어입니다.

코드는 [GitHub](https://github.com/dj258255/dbtower-lakehouse)에 있습니다.

여기까지가 1부입니다. 쓰기 경로까지 fail-closed로 막았습니다. 이제 그 장치들이 제 노트북 밖에서도 계속 참이도록 묶습니다.

## 2부. 커밋마다 검증되고, 침묵해도 잡히고, 계약을 어기면 막힌다: CI·deadman·dbt contracts

### 0. 초록불의 세 가지 거짓말이라는 상황

1부에서 처음으로 `tests/`를 열었습니다. pytest 35개로 게이트 판정과 자기파괴 가드,
발행 원자성을 고정했습니다. 그때는 "이제 회귀는 못 낸다"고 생각했습니다. 그런데 며칠 지나
마트 SQL을 만지다가 문득 깨달았습니다. 그 테스트는 **제 노트북에서만 돕니다.** 커밋할
때 아무도 `pytest`를 부르지 않습니다. 제가 깜빡하면 깨진 채로 push되고 리포는 여전히
초록불처럼 보입니다. 테스트가 있다는 사실과 테스트가 통과한다는 사실은 다른 얘기인데,
그 사이를 이어주는 게 없었던 것입니다.

두 번째 거짓말은 더 뼈아팠습니다. 1편 6부에서 실패 알림(webhook)을 붙이며 "차단은 시작이고
통보가 완성이다"라고 썼는데, 정작 이 파이프라인이 겪은 가장 긴 침묵엔 통보가 없었습니다.
원천 수집기(DBTower Spring 앱)가 **21시간 동안 조용히 멈춰** 있었는데, 알림은 한 통도
안 왔습니다. 이유는 단순합니다. 알림은 태스크가 **돌다가 실패해야** 웁니다. 태스크가
아예 시작조차 안 하면 `on_failure_callback`이 불릴 일이 없습니다. 스케줄러가 죽든, DAG가
pause되든, 원천이 말라붙든, "실패 감지"라는 방향으로는 '미실행'을 절대 못 잡습니다.

세 번째는 아직 사고가 안 났을 뿐입니다. 마트 `mart_query_regression`의
`latency_increase_ms`는 Metabase 카드가 숫자로 읽는 컬럼인데, 제가 SQL을 만지다 이걸
문자열로 바꿔도 dbt는 아무 말 없이 빌드합니다. 깨지는 건 발행 뒤 대시보드가 그 카드를
그릴 때입니다. 스키마는 코드보다 데이터의 형태에 가까워서, SQL 리뷰로는 안 걸립니다.

이번 편은 이 세 구멍, 곧 로컬에만 있는 테스트와 못 잡는 침묵, 계약 없는 스키마를
셋 다 닫은 기록입니다. 주제는 하나입니다. **신뢰할 수 있는 파이프라인은 커밋마다
검증되고, 침묵해도 잡히고, 계약을 어기면 막힌다.**

### 1. 임베디드 DuckDB라서 러너 안에서 다 끝나는 CI

첫 구멍은 뻔한 처방입니다. GitHub Actions로 커밋마다 검사를 강제하면 됩니다. 관문은 셋:
ruff(린트), pytest(순수 로직), 그리고 dbt. 앞의 둘은 흔합니다. 재밌는 건 dbt입니다.

보통 "CI에서 dbt를 돌린다"고 하면 클라우드 웨어하우스에 CI 전용 스키마를 잡거나,
컨테이너로 Postgres를 띄웁니다. 그런데 이 스택은 쿼리 엔진이 **임베디드 DuckDB**입니다.
외부 DW가 아예 필요 없습니다. MinIO도 PG도 없는 러너에서, 원천 스냅샷을 흉내낸 작은
parquet 몇 장만 로컬에 깔면 dbt가 staging→fct→mart를 **실제로 짓고** 데이터 테스트·
계약·unit test까지 한 번에 돕니다. 이게 이 스택을 고른 값이 CI에서 드러나는 지점입니다.

픽스처는 델타 로직의 대표 경로를 일부러 담았습니다. 정상 누적 증가, 지문 충돌(같은
grain 두 계열), 순리셋(하루 last < first)입니다. 파티션 레이아웃은 운영과 똑같이
`dt=YYYY-MM-DD/instance_id=N/`입니다.

```python
# scripts/ci_fixture.py — 픽스처 parquet + raw 소스 뷰 등록
python scripts/ci_fixture.py "$FIXTURE_DIR" "$DBT_DUCKDB_FILE"
# 픽스처 생성: 4개 파티션 파일, 10행 → <tmp>/fixture
# raw.query_snapshot 뷰 등록 → <tmp>/ci.duckdb
```

운영 소스는 MinIO(`s3://`)를 가리키는데, 이걸 어떻게 픽스처로 갈아끼우느냐가 문제입니다. sources.yml의
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

`dbt build` 한 번에 25개가 돕니다. 모델 2개, 데이터 테스트 18개, unit test 4개, view 1개입니다.
전부 러너 안에서, 외부 인프라 0으로. 배지는 README 맨 위에 달았습니다.

### 2. 심장의 엣지를 정적으로 못박는 dbt unit test

그 25개 중 제일 공들인 게 unit test 4개입니다. 이 프로젝트의 심장은 1편 3부에서 만든 델타 로직입니다. 누적 카운터를 하루 양 끝 차분으로
바꾸고(first-vs-last), 리셋이면 `GREATEST(0, ...)`로 클램프하고, 지문 충돌은 staging에서
SUM으로 접는 것. 데이터 테스트(not_null 등)는 "실데이터에 규칙이 성립하나"를 보지만,
**로직 자체가 이 입력에 이 출력을 내나**는 안 봅니다. 그건 dbt unit test의 몫입니다
(dbt 1.8+, 여기선 1.11 + dbt-duckdb 1.10).

입력(ref/source)을 목킹하므로 실데이터가 없어도 로직만 딱 고정됩니다. 엣지 네 개를
정적 입력→기대 출력으로 박았습니다.

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
`relation doesn't exist`로 깨졌습니다. dbt가 입력 relation의 컬럼 타입을 알아내려고
`raw.query_snapshot`을 물리 테이블로 찾는데, 외부 parquet 소스는 그런 relation이 없기 때문입니다.
fct의 unit test는 입력이 모델 ref(stg)라 이 문제가 없습니다. stg만 걸린 것입니다.

미지원이라 접는 대신, 픽스처를 가리키는 `raw.query_snapshot` **뷰**를 dbt가 쓰는 바로
그 파일에 미리 등록해 우회했습니다(`ci_fixture.py`가 함께 수행). 여전히 외부 DW·MinIO·
PG는 필요 없습니다. 겉보기엔 "unit test 미지원"처럼 보여도 실제로는 "외부 소스 introspect의 제약"이고, 그
경계까지가 정직한 한계입니다.

그리고 이걸 라이브 파이프라인과 분리했습니다. 컨테이너 transform은 이제
`dbt test --select test_type:data`로 데이터 테스트만 돕니다. unit test는 목킹 로직이라
라이브 데이터와 결과가 같고(무의미), 외부 소스 introspect도 안 되니 CI 몫으로 뒀습니다.
실데이터 데이터 테스트는 그대로 18개 통과합니다.

### 3. 성공의 부재를 잡는 역방향 감시 deadman

두 번째 구멍, 침묵. 이건 "실패 감지"를 아무리 정교하게 해도 못 막습니다. 태스크가
시작조차 안 하는데 무슨 실패를 감지합니까. 방향을 뒤집어야 합니다. **성공이
주기적으로 남겨야 할 신호가 안 남은 것**을 잡는 것입니다. deadman switch의 원리입니다.

절반은 heartbeat입니다. `snapshot_offload`가 offload→gate→transform→publish를 전부
통과하면, 마지막에 붙인 `heartbeat` 태스크가 "성공했다"를 남깁니다. 어디에? 파일은
컨테이너가 죽으면 같이 사라지니 테이블에 씁니다. DuckLake 카탈로그와 같은 PG 인스턴스의
분리 DB(`ducklake_catalog`)입니다. 서비스 추가 0이고 DBTower 메타 DB(dbtower)는 1편 5부부터
지켜온 대로 건드리지 않습니다.

나머지 절반이 감시입니다. `extract/deadman.py`가 그 heartbeat가 **기한 내 갱신됐나**를
보고, 낡았으면 경보합니다. 판정은 순수 함수라 PG 없이 테스트로 박을 수 있습니다.

```python
# extract/deadman.py — 신선도 판정(발췌)
def check_stale(dag_id, last_success_at, max_age_seconds, now=None):
    now = now or datetime.now(UTC)
    if last_success_at is None:                      # 한 번도 성공 못 함/테이블 빔 → 낡음
        return StaleVerdict(dag_id, True, None, max_age_seconds, None)
    age = (now - last_success_at).total_seconds()
    return StaleVerdict(dag_id, age > max_age_seconds, age, max_age_seconds, last_success_at)
```

실측입니다. 로컬 수신기(:18809)를 띄우고, 정상 heartbeat를 찍은 뒤 여러 상황을 돌렸습니다.
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

그런데 여기엔 숨기면 안 되는 약점이 있습니다. 이 감시를 어디서 돌리냐가 문제입니다. Airflow 안에
`deadman_watch` DAG(@hourly)를 뒀는데, **이 감시 DAG도 같은 스케줄러 위에서 돕니다.**
스케줄러가 통째로 죽으면 감시 DAG도 같이 죽습니다. 자기 죽음은 자기가 못 봅니다.

| 경로 | 무엇을 잡나 | 못 잡는 것 |
|---|---|---|
| Airflow `deadman_watch` DAG (@hourly) | 스케줄러 사는 동안의 pause·연속 실패·원천 침묵 | **자기 스케줄러의 death** |
| 외부 `python -m extract.deadman` (host cron) | 스케줄러가 통째로 죽는 total death까지 | 그 외부 러너 자체의 death |

**감시자는 감시 대상 밖에 있어야 total death를 잡습니다.** 그래서 외부 cron 경로를 함께
뒀습니다. 종료코드가 경보 발화 수(0=건강)라 cron이 비영 종료를 자체 경보로도 태웁니다.
그럼 그 외부 러너는 또 누가 감시하냐고요? 결국 감시의 감시는 조직 밖 상시 모니터
(PagerDuty류)의 몫입니다. 로컬 스택 범위 밖이고, 그게 이 층의 정직한 끝입니다.

### 4. 발행 전 마지막 방어선인 dbt contracts

세 번째 구멍, 계약 없는 스키마. `fct_query_daily`와 `mart_query_regression`에
`contract: enforced: true`를 걸고 컬럼 이름·타입·제약을 선언했습니다. 타입은 실측한 DuckDB 산출 타입 그대로입니다. 누적값을 SUM하면 `BIGINT`가 `HUGEINT`로
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

dbt-duckdb에서 이 constraint는 **DB 레벨로 실제 enforce**됩니다.
1편 3부에서 코드로 지키던 "델타는 음수가 될 수 없다"는 클램프 불변식을, 이제 데이터베이스가
CHECK 제약으로 강제합니다.

계약이 진짜 방어선인지는 어기게 해봐야 압니다. 다운스트림(Metabase 카드)이 숫자로 읽는 `latency_increase_ms`의 산출 타입을 일부러 문자열로 바꿨습니다.

```
# mart_query_regression.sql: latency_increase_ms 를 CAST(... AS VARCHAR)로 변경
$ dbt build --select mart_query_regression
ERROR creating sql table model main.mart_query_regression
  This model has an enforced contract that failed.
  | column_name         | definition_type | contract_type | mismatch_reason    |
  | latency_increase_ms | VARCHAR         | DOUBLE        | data type mismatch |
Done. PASS=0 ERROR=1
```

빌드가 막혔습니다. 대시보드가 그 카드를 그리다 런타임에 깨질 문제를 **발행 전
CREATE TABLE 시점에** 타입 불일치로 미리 잡은 것입니다. 주입을 원복하니 다시 통과합니다.
그리고 이 계약이 실데이터에서도 성립하는지는 픽스처를 쓰지 않고 진짜 MinIO를 직독한
`dbt run`으로 확인했습니다.

```
$ dbt run --profiles-dir . --project-dir .     # RAW_SNAPSHOT_LOCATION 기본값=MinIO
Done. PASS=3 WARN=0 ERROR=0     # 계약이 실데이터 산출 타입과 일치
```

### 5. 회귀 없음

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

heartbeat 격리도 확인했습니다. `ducklake_catalog.pipeline_heartbeat`에는 기록이 있고,
DBTower 메타 DB(dbtower) 안 같은 이름 테이블 수는 **0**입니다. 원천 메타는 오염되지
않았습니다.

### 6. 정직하게 남긴 것들

- **CI는 tiny 픽스처까지입니다.** 로직·계약·스키마는 러너에서 검증하지만, 실데이터
  규모(수십만 행)·MinIO/PG 통합은 CI 밖(호스트 실측)입니다. 1년치(365dt) 규모 실측은
  다음이고, 그 수치를 근거로 증분 모델 전환을 판단할 겁니다(수치 없이 미리 최적화 안 함).
- **unit test는 fct만 완전히 CI 네이티브입니다.** stg의 소스-입력 테스트는 외부
  read_parquet를 introspect 못 해 픽스처 뷰 등록으로 우회했습니다. dbt-duckdb의 제약이고,
  깔끔하진 않습니다.
- **deadman이 보는 건 heartbeat 신선도가 전부입니다.** Airflow 내 감시 DAG는 자기 스케줄러의
  total death를 못 잡아 외부 cron을 뒀지만, 그 외부 러너의 생존은 또 조직 밖 모니터의
  몫입니다. 감시의 사슬은 어딘가에서 스택 밖으로 나갑니다.
- **계약을 건 건 마트 2개뿐입니다.** 컬럼 레벨 계보·PII 태깅은 dbt Enterprise 영역이라
  문서 계보까지만 합니다.
- 운영 대시보드화(게이트 FAIL·마지막 성공 dt·발행 지연을 Metabase 상태 카드로)는
  다음입니다. heartbeat 테이블이 이제 있으니 "마지막 성공 dt" 카드는 바로 얹을 수 있습니다.

---

세 아크가 이렇게 닫힙니다. 1편이 **조용히 틀린 데이터**를 게이트로 막고
통보로 완성했다면, 이번 2부는 그 신뢰를 **커밋·침묵·계약** 세 축에서 마저 묶었습니다.
파이프라인은 이제 제 노트북 밖에서도 커밋마다 스스로를 검증하고, 아무도 안 볼 때
멈추면 역방향으로 울고, 계약을 어기는 변경은 발행 전에 막습니다. 데이터 엔지니어링에서 흔히 첫손에 꼽히는 고통(조용한 실패·스키마 파괴)과 그대로 겹치는
방향이고, 이 규모에서 실제로 향해야 할 곳은 스트리밍을 새로 얹는 쪽보다 이쪽이라고 생각합니다.

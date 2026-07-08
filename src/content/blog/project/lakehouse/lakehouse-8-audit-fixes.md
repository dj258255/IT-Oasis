---
title: '아카이브가 자신을 지우는 경로 — 멱등 덮어쓰기가 보존 창 밖에서 자기파괴가 될 때'
titleEn: 'The Path Where the Archive Deletes Itself — When Idempotent Overwrite Turns Self-Destructive Outside the Retention Window'
description: "코드 감사에서 결함 목록을 받았습니다. 1번이 치명이었어요 — offload의 멱등 재적재는 '파티션을 통째로 지우고 다시 쓴다'인데, 삭제가 원천 0행 체크보다 먼저 옵니다. 원천 보존(7일) 밖의 dt를 backfill이나 Clear로 재실행하면 원천은 이미 비어 있으니, 아카이브 유일본 parquet를 지운 뒤 아무것도 안 쓰고 exit 0으로 '성공'합니다. 실제로 재현했습니다 — 가짜 파티션을 심고 원천에 없는 dt로 돌리자 '기존 파티션 오브젝트 1개 삭제' 로그 한 줄과 함께 유일본이 사라졌고, 품질 게이트는 사후에 FAIL을 알릴 뿐 이미 늦었습니다. 원천을 지키던 fail-closed가 정작 아카이브의 쓰기 경로에는 없었던 거예요. 수정은 원칙 하나입니다 — 원천이 0행인데 기존 파티션이 존재하면 삭제하지 않고 시끄럽게 실패한다(ArchiveSelfDestructError, exit 1 → 재시도·webhook 경로 탑승). 같은 감사에서 나온 셋도 함께 소탕합니다: 게이트가 captured_at 단독 필터로 원천 전체를 Seq Scan(332ms/31k버퍼 → 인스턴스별 인덱스 루프로 20ms/76버퍼, EXPLAIN 전/후 실측), publish가 마트 2개를 개별 커밋해 중간 실패 시 '새 fct + 어제 mart' 혼합 버전 노출(장애 주입으로 재현 → 단일 트랜잭션으로 롤백 실측), 주간 유지보수 DAG가 데모 산출물 테이블을 하드 참조해 새 환경에서 즉사(존재하는 테이블 기반으로 전환 + 데모의 DROP TABLE에 확인 가드). 그리고 이번에 tests/를 열었습니다 — 게이트 판정·자기파괴 가드·발행 원자성·스키마 계약을 pytest 35개로 고정, 닫힌 창 재검은 ALL MATCH(07-05=149,259 / 07-06=79,894) 유지."
descriptionEn: "A code audit handed me a defect list, and item one was fatal: offload's idempotent reload is delete-partition-then-rewrite, but the delete runs before the zero-rows check. Re-run a dt outside the source's 7-day retention via backfill or Clear and the source is already empty — so the job deletes the archive's only parquet copy, writes nothing, and exits 0 as a 'success'. I reproduced it: planted a fake partition, ran offload for a dt the source no longer has, and watched the sole copy vanish behind one log line. The quality gate only reports FAIL after the fact — too late. Fail-closed had guarded the source but never the archive's own write path. The fix is one principle: if the source has zero rows and a partition already exists, refuse to delete and fail loudly (ArchiveSelfDestructError, exit 1, riding the retry and webhook path). Three more audit findings fall with it: the gate full-scanned the source with a captured_at-only filter (332ms/31k buffers to 20ms/76 buffers via per-instance index loops, EXPLAIN before/after), publish committed two marts separately so a mid-failure exposed a mixed 'new fct + yesterday's mart' version (reproduced by fault injection, fixed with a single transaction and a measured rollback), and the weekly maintenance DAG hard-referenced a demo table, dying instantly on fresh environments (now table-list driven, plus a confirmation guard on the demo's DROP TABLE). And tests/ finally exists — 35 pytest cases pin the gate verdicts, the self-destruct guard, publish atomicity, and the schema contract; the closed windows still reconcile ALL MATCH (07-05=149,259 / 07-06=79,894)."
date: 2026-07-09
tags:
  - Data Engineering
  - Airflow
  - DuckLake
  - PostgreSQL
  - pytest
category: personal/lakehouse
coverImage: /uploads/project/lakehouse/cover.svg
draft: false
series: "lakehouse"
seriesOrder: 8
---

## 0. 상황 — 8일 뒤에 누른 재적재 버튼

이런 시나리오를 상상해 보세요. 지난주 화요일 새벽, 게이트가 FAIL을 냈고 webhook 알림이 왔습니다. 그런데 그 주가 바빴어요. 알림은 읽었고, "주말에 재적재하지"라고 생각만 하고 넘어갑니다. 8일이 지난 오늘에서야 [RUNBOOK](https://github.com/dj258255/dbtower-lakehouse/blob/main/docs/RUNBOOK.md) 절차대로 backfill을 겁니다.

```bash
airflow dags backfill snapshot_offload -s 2026-07-01 -e 2026-07-01 --reset-dagruns -y
```

offload는 초록불로 끝납니다. 로그도 평화로워요 — "적재 완료, 총 0행". 그리고 그 순간, **dt=07-01의 아카이브 유일본이 방금 사라졌습니다.**

원천 DBTower는 스냅샷을 7일만 보존합니다. 이 시리즈의 존재 이유가 그거였어요 — 원천이 지우기 전에 내려서, lakehouse가 유일본이 되는 것. 그런데 8일 전 dt를 재실행하면 원천엔 이미 그 날짜가 없습니다. 그리고 2편에서 만든 멱등 재적재는 **"파티션을 통째로 지우고 다시 쓴다"** 예요. 원천이 0행이면? 지우고, 아무것도 안 씁니다.

이번 편은 코드 감사에서 이 경로가 확정 결함으로 잡힌 뒤, 그것까지 포함해 결함 넷을 소탕한 기록입니다. 넷 다 "잘 만들었다고 믿었던 장치의 뒷면"이라는 공통점이 있습니다.

## 1. 함정 — 멱등의 뒷면

2편에서 멱등 재적재를 이렇게 구현했습니다.

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

delete-first는 멱등 덮어쓰기의 정석입니다. 같은 dt를 몇 번 돌려도 중복 0 — 4편까지의 검증에서 실제로 잘 동작했어요. 문제는 이 코드가 세운 암묵적 전제입니다: **"원천은 언제나 진실이고, 지운 만큼 다시 쓸 수 있다."**

보존 창 안에서는 참입니다. 창 밖에서는 정반대가 돼요. 원천은 이미 지웠고 parquet가 유일한 진실인데, 코드는 여전히 원천을 진실로 믿고 유일본을 지웁니다. 그리고 `if table is None: continue` — 스킵. 예외도 없고, exit 0입니다. **아카이브를 지키려고 만든 파이프라인에, 아카이브가 자신을 지우는 경로가 내장돼 있었던 겁니다.**

실제로 재현했습니다. 실데이터와 무관한 dt=2026-06-01에 가짜 파티션을 심고(원천은 읽기 전용 그대로 — 시연은 MinIO에서만), 그 dt로 offload를 돌렸어요.

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

"기존 파티션 오브젝트 1개 삭제" 한 줄과 함께 유일본이 사라졌고, 프로세스는 성공으로 끝났습니다.

"게이트가 잡아주지 않냐"고 물을 수 있는데 — 잡습니다. 다음 게이트 실행에서 reconciliation이 FAIL을 내고 webhook도 옵니다. 그런데 그게 뭐가 달라지나요. 게이트는 **사후 통보**입니다. 데이터는 이미 없습니다. 복구할 원천도 이미 없습니다. 4편에서 "조용히 틀린 데이터는 없는 것보다 나쁘다"며 fail-closed를 읽기 경로(dbt 앞)에 세웠는데, 정작 **쓰기 경로에는 fail-closed가 없었던 거예요.** 지키는 건 검문소가 아니라 삭제 버튼 앞의 손이어야 했습니다.

## 2. 판단 — fail-closed는 쓰기 경로에도

수정의 원칙은 한 문장입니다. **지울 자격은 다시 쓸 수 있는 자에게만 있다.**

원천에서 N행을 읽어왔다면 지우고 다시 써도 됩니다 — 기존 멱등 경로 그대로. 원천이 0행인데 파티션도 없다면 정말 아무것도 없는 날이니 스킵. 그런데 **원천이 0행인데 기존 파티션이 존재한다면**, 그 파티션은 유일본일 가능성이 높습니다. 이때는 삭제하지 않고 시끄럽게 실패해야 해요.

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

이 결정을 삭제보다 **먼저** 태웁니다. 예외로 죽는 게 핵심이에요 — exit 1이면 Airflow가 태스크를 failed로 표시하고, 6편에서 깐 on_failure_callback이 webhook을 쏩니다. "조용한 성공 + 사후 FAIL 알림"이 "즉시 실패 + 유일본 보존"으로 바뀝니다. 같은 입력으로 다시 돌린 결과:

```
ArchiveSelfDestructError: 원천 0행인데 기존 파티션 오브젝트가 존재 — ...
--- after ---
  s3://lakehouse/raw/query_snapshot/dt=2026-06-01/instance_id=1/part-000.parquet  2665 bytes
```

2,665바이트가 그대로 있습니다. 잘못 누른 backfill은 이제 데이터를 지우는 대신 알림을 만듭니다.

자동 우회 경로는 일부러 안 만들었습니다. "정말 지우고 싶으면 플래그로" 같은 옵션은 이 가드가 막으려는 바로 그 실수를 한 단계 뒤로 미룰 뿐이에요. 정말 지워야 하는 파티션이면 사람이 MinIO에서 명시적으로 지우고 재실행합니다 — 파괴적 행위에는 파괴적 행위의 절차를 요구하는 게 맞다고 봤습니다.

## 3. 개선 — 나머지 셋도 같은 뿌리

감사가 잡은 나머지 셋은 치명도는 낮지만, 전부 "장치가 자기 원칙을 자기한테는 적용 안 했다"는 같은 뿌리입니다.

### 3-1. 게이트가 원천을 Seq Scan하고 있었다 (F2)

2편에서 추출은 인덱스 `idx_snapshot_instance_time(instance_id, captured_at)`의 선두 컬럼을 타도록 instance별 루프로 짰습니다. captured_at 단독 조건은 선두를 못 타니까요. 그런데 4편의 게이트(`_pg_counts`)와 검증 스크립트(verify_count)는 정확히 그 안티패턴으로 원천을 세고 있었어요.

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

원천 전체를 훑고 65만 행 중 51만 행을 버립니다. 관측 대상인 메타 PG에 게이트가 매일 이 부하를 주고 있었던 거예요 — dbtower 시리즈에서 "관제가 부하가 되면 안 된다"고 그렇게 썼는데, 게이트가 부하가 되고 있었습니다. 레지스트리 인스턴스별 등치 루프로 바꾼 뒤:

```
Index Only Scan using idx_snapshot_instance_time  (actual time=1.177..18.481 rows=41313)
  Heap Fetches: 0
Buffers: shared hit=5 read=71
Execution Time: 20.213 ms
```

332ms/31,077버퍼 → 인스턴스당 20ms/76버퍼. 게이트 전체(2일치 4검문)가 0.5초에 끝납니다.

### 3-2. publish의 원자성이 테이블 하나짜리였다 (F3)

7편에서 "DuckLake에선 DROP+CREATE가 한 커밋이라 읽는 쪽은 온전한 버전만 본다"고 썼습니다. 맞는 말인데, **테이블 하나 단위로만** 맞는 말이었어요. publish는 마트 2개(fct_query_daily, mart_query_regression)를 루프로 돌며 각각 커밋합니다. fct 발행 성공 → mart 발행 실패면? 대시보드는 "오늘의 fct + 어제의 mart"라는, 존재한 적 없는 혼합 버전을 봅니다.

장애 주입으로 재현했습니다. 두 번째 CREATE 직전에 예외를 던지는 프록시를 커넥션에 씌우고 발행:

```
[주입 전] 최신 스냅샷 v31
[주입] publish_marts 사망: 주입 장애: 두 번째 마트 발행 직전 사망
[주입 후] 최신 스냅샷 v32
  v32  {'tables_created': ['main.fct_query_daily'], ...}  <- 주입 후 새로 생김
=> 혼합 상태: fct만 새 스냅샷으로 발행, mart는 이전 버전에 방치
```

수정은 DuckLake가 이미 주는 걸 쓰면 됩니다 — 카탈로그가 PG 트랜잭션이니, 두 발행을 `BEGIN … COMMIT` 하나로 묶으면 끝이에요. 같은 주입을 다시:

```
[주입 후] 최신 스냅샷 v32 (이전 v32)  — 새 스냅샷 0개
=> 원자성 유지: 둘 다 이전 버전(대시보드는 온전한 과거를 본다)
```

정상 발행은 이제 스냅샷 하나에 두 테이블이 함께 담깁니다(`v33 tables_created: [mart_query_regression, fct_query_daily]`). 같은 dt의 산출물은 함께 나가거나 함께 안 나가거나, 둘 중 하나여야 합니다.

### 3-3. 유지보수 DAG가 데모 산출물에 기대 있었다 (F4)

주간 유지보수 DAG의 measure()가 `query_snapshot` 테이블을 하드 참조하고 있었습니다. 그 테이블은 5편 데모(run_demo)의 산출물이에요. 데모를 안 돌린 새 환경에 이 저장소를 배포하면? 격리된 새 카탈로그에서 실측:

```
CatalogException: Table with name query_snapshot does not exist!
```

주간 DAG가 첫 실행에서 즉사합니다. 유지보수는 "있는 것"을 정리하는 작업이지 특정 테이블의 존재를 요구할 일이 아니죠. information_schema에서 지금 존재하는 테이블 목록을 읽어 그 전체(마트 포함)를 계측하도록 바꿨고, 테이블이 하나도 없으면 스냅샷·고아 파일 정리만 하고 지나갑니다. 행수 불변식도 덤으로 좋아졌어요 — 전엔 데모 테이블 하나만 지켰는데 이제 테이블별로 전부 대조합니다.

같은 김에 run_demo의 파괴성도 막았습니다. 데모는 재실행 대비로 `DROP TABLE IF EXISTS query_snapshot`을 치는데, 그 테이블에 운영 데이터가 쌓여 있어도 말없이 지웁니다. 이제 기존 테이블이 있으면 확인(`--force` / `DUCKLAKE_DEMO_FORCE=1` / 대화형 y) 없이는 중단합니다:

```
중단: 기존 query_snapshot(229,153행) 보존. 재생성하려면 --force 또는
DUCKLAKE_DEMO_FORCE=1로 명시할 것.
```

F1과 같은 원칙입니다 — **파괴적 기본값 금지.**

### 3-4. 게이트 4축 + 테스트 자산

감사의 "시간 되면" 목록에서 둘을 더 담았습니다. 게이트에 네 번째 검문 **스키마 드리프트**를 추가했어요 — 원천 information_schema를 추출 계약(SNAPSHOT_SCHEMA)과 대조해서, 컬럼 유실·타입 변경은 FAIL(다음 추출이 깨진다), 원천에만 생긴 새 컬럼은 WARN(추출은 돌지만 그 컬럼이 조용히 버려지는 중이라는 신호)입니다. 알림 payload에는 Metabase 대시보드 URL 필드를 얹었습니다 — 알림 받은 사람이 "지금 화면이 어떤 상태인가"를 한 클릭에 보게요.

그리고 이 프로젝트에 처음으로 `tests/`를 열었습니다. 8개 Phase 동안 검증은 전부 실측 스크립트였는데, 실측은 "그때 맞았다"까지만 증명합니다. 판정 로직이 조용히 바뀌는 걸 막으려면 고정이 필요해요. 게이트 4검문의 판정(경계값 포함), F1 가드(순수 결정 로직 + 얇은 페이크 PG/S3로 run_offload 통합 경로), offload 경계(dt 파싱·하루 창·parquet 스키마 계약), 발행 원자성(BEGIN/COMMIT/ROLLBACK 시퀀스)까지:

```
$ pytest -q
...................................                                      [100%]
35 passed in 0.50s
```

## 4. 실측 — 회귀 없음

수정이 기존 파이프라인을 안 깨뜨렸는지가 마지막 검문입니다. 원천 수집기가 현재 꺼져 있어(원천 max(captured_at)=07-07 23:04) 닫힌 창만 수치로 씁니다.

```
$ python -m extract.verify_count 2026-07-05 2026-07-06
dt              source PG    parquet(S3)   match
------------------------------------------------
2026-07-05        149,259        149,259      OK
2026-07-06         79,894         79,894      OK
RESULT: ALL MATCH
```

인스턴스별 루프로 바꾼 카운트가 기존 수치와 정확히 같습니다 — 질의 형태만 바뀌고 답은 불변. 4축 게이트도:

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

호스트 run_pipeline(게이트 → dbt run)도 PASS=3으로 완주했고, 시연에 쓴 것들은 전부 원상복구했습니다 — 가짜 파티션 삭제, 장애 주입 후 마트 정상 재발행(fct 1,749행 · mart 22행), 새 환경 시연용 scratch 카탈로그 DROP. 전 과정에서 원천은 읽기 전용 그대로였습니다.

## 5. 잔여 — 정직한 한계

- **가드는 "0행 vs 존재"까지만 봅니다.** 원천이 부분 유실된 경우(0은 아니지만 기존 파티션보다 훨씬 적은 행)는 여전히 덮어씁니다 — 그건 게이트 reconciliation이 사후에 잡는 영역으로 남겼는데, 쓰기 전 행수 비교(기존 파티션 대비 급감 시 거부)까지 넣을지는 오탐(정당한 재수집 감소)과의 트레이드오프라 다음 판단거리입니다.
- **테스트는 자산까지고 CI 배선은 다음입니다.** pytest 35개가 로컬에서 도는 것과 커밋마다 강제되는 것은 다른 이야기예요.
- **스키마 드리프트는 원천 방향만 봅니다.** parquet 쪽(과거 파티션 간 스키마 이질성)은 읽기 시점에 DuckDB가 시끄럽게 죽는 것에 기대고 있습니다.
- 알림의 대시보드 URL은 환경변수 배선까지입니다 — 게이트 FAIL을 대시보드 배지로 띄우는 상태 카드는 여전히 다음 후보.

## 6. 마치며 — 지키는 쪽을 지키기

이 시리즈 내내 "원천을 지킨다"는 원칙은 잘 지켰습니다. 읽기 전용 세션, 서버커서, 인덱스 선두, 시간창. 그런데 감사가 보여준 건, 정작 **지키는 쪽 — 아카이브 자신 — 을 지키는 코드가 없었다**는 사실이에요. 멱등 덮어쓰기는 보존 창 안에서만 멱등이었고, 게이트는 원천에 부하를 줬고, 원자성은 테이블 하나짜리였고, 유지보수는 데모에 기대 있었습니다.

넷 다 처음 만들 때 틀린 코드가 아니었습니다. 전제가 바뀌는 지점 — 보존 창 밖, 동시 실패, 새 환경 — 에서 뒷면이 드러났을 뿐이에요. 그 지점을 코드가 스스로 인지하고 시끄럽게 멈추게 만드는 것, 그게 이번 편의 전부였습니다. 유일본을 지운 뒤의 알림은 부고고, 지우기 전의 실패는 방어입니다.

코드는 [GitHub](https://github.com/dj258255/dbtower-lakehouse)에 있습니다.

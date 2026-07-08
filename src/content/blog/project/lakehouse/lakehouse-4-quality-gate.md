---
title: '실패해야 하는 파이프라인 — 조용한 오답을 막는 품질 게이트'
titleEn: 'A Pipeline That Must Fail — A Quality Gate Against Silent Wrong Answers'
description: "3편에서 raw를 처음으로 질문에 답하게 만들었지만, 그 답을 믿어도 되는지는 아무도 지키지 않았습니다. 어느 날 한 인스턴스의 파티션이 수집 장애로 비면, 그 위에 올린 악화 쿼리 랭킹은 조용히 틀린 답을 냅니다. 아무도 모릅니다. 이 편은 다운스트림(dbt) 앞에 검문소를 세웁니다. 세 축으로 검문합니다 — reconciliation(원천 PG 행수 == parquet 행수, 인스턴스별), completeness(레지스트리 기대 인스턴스가 그 dt에 전부 존재), freshness(dt 최신 captured_at이 하루 경계에 근접). 한 dt라도 FAIL이면 dbt를 아예 실행하지 않습니다(fail-closed). 실측으로 증명했습니다. 정상은 검문한 dt 전부 PASS(닫힌 149,259·79,894는 몇 번을 세도 불변, 07-07은 원천의 진행 중인 오늘이라 값이 유동적). 그다음 dt=2026-07-06의 instance_id=3 파티션(20,158행)을 통째로 지우자, 게이트가 reconciliation(79,894 vs 59,736)과 completeness(누락 [3]) 두 축에서 동시에 잡아 dbt를 SKIP하고 종료코드 2로 빠졌습니다. Airflow에서도 quality_gate가 실패하자 transform이 upstream_failed로 실행되지 않았습니다. 시연 후 재적재로 원상복구했습니다."
descriptionEn: "Part 3 finally made raw answer questions, but nobody guarded whether that answer could be trusted. If one instance's partition goes empty from a collection failure, the regression ranking built on top gives a silently wrong answer — and no one notices. This part puts a checkpoint in front of the downstream (dbt). Three axes: reconciliation (source PG row count == parquet row count, per instance), completeness (every expected instance from the registry present for that dt), and freshness (the dt's latest captured_at close to the day boundary). If any dt FAILs, dbt is never run (fail-closed). Proven live: the baseline passes every checked dt (the closed 149,259 / 79,894 are invariant no matter how often you count; 07-07 is the source's in-progress today, so its value drifts). Then deleting instance_id=3's partition (20,158 rows) for dt=2026-07-06 tripped both reconciliation (79,894 vs 59,736) and completeness (missing [3]) at once, skipping dbt and exiting code 2. In Airflow the quality_gate failure left transform as upstream_failed, never run. Recovered by re-offloading afterward."
date: 2026-07-08
tags:
  - Airflow
  - dbt
  - DataQuality
  - DuckDB
  - Parquet
  - MinIO
category: personal/lakehouse
coverImage: /uploads/project/lakehouse/cover.svg
draft: true
series: "lakehouse"
seriesOrder: 4
---

## 0. 상황 — 답은 나오는데, 믿어도 되는지는 아무도 안 지킨다

[3편](/blog/project/lakehouse/lakehouse-3-transform)에서 raw가 처음으로 질문에 답했습니다. "instance 8의 Oracle 쿼리가 이틀 새 25.9ms에서 64.5ms로 149% 느려졌다" 같은 답이 마트에서 나왔죠. 그런데 거기엔 조용한 전제가 하나 깔려 있었습니다 — **그 밑의 raw가 온전하다**는 전제.

한 상황을 가정해 봅시다. 어느 날 새벽, 특정 인스턴스의 어제 파티션이 수집 장애로 비었습니다. 오브젝트가 아예 안 올라왔거나, 절반만 올라왔거나. 그 위에서 dbt는 아무 불평 없이 돌아갑니다. 마트는 "악화 쿼리 랭킹"을 여전히 뱉어내요. 다만 그 랭킹은 이제 **빠진 인스턴스를 뺀 채 계산된, 조용히 틀린 답**입니다. dbt run은 초록불, 테스트도 초록불. 아무도 모릅니다.

이건 DBTower 시리즈 내내 지켰던 원칙 — **"못 하는 것은 못 한다고"** — 의 데이터판입니다. 데이터가 반쪽이면, 반쪽인 채로 답을 내지 말고 **멈춰야** 합니다. 조용히 틀린 데이터는 없는 것보다 나쁘거든요. 없으면 "데이터 없음"이라고 답하지만, 반쪽이면 그럴듯한 오답을 자신 있게 냅니다.

그래서 이 편은 기능을 늘리지 않습니다. 오히려 **파이프라인이 실패하게 만드는** 장치를 답니다.

## 1. 함정 — 반쪽 적재는 dbt가 잡아주지 않는다

dbt에도 테스트가 있습니다(3편에서 18개 통과시켰죠). 하지만 dbt test는 **이미 로드된 데이터 안의 관계**를 검증합니다 — not_null, unique, 참조 무결성. "parquet에 있어야 할 인스턴스가 통째로 안 왔다"는 건 dbt가 보는 세계 밖의 일이에요. 없는 행은 not_null을 위반하지 않습니다. 없으니까요.

세 가지 반쪽이 특히 조용합니다.

```
빈 파티션      한 인스턴스의 dt 파티션이 아예 안 올라옴 → 그 인스턴스만 랭킹에서 증발
행수 불일치     원천 PG엔 20,158행인데 parquet엔 12,000행만 → 부분 적재, 델타가 축소
freshness 붕괴  수집이 낮 12시에 끊김 → 하루 절반만 담긴 파티션을 '하루'로 취급
```

세 경우 모두 dbt run은 성공합니다. 마트도 나옵니다. 틀린 채로요. 그러니 검문은 **dbt 이전에, raw 파티션 자체를 상대로** 해야 합니다.

## 2. 판단 — 다운스트림 앞에 검문소를 세우고, FAIL이면 막는다 (fail-closed)

핵심 결정은 **fail-closed**입니다. 게이트가 통과를 확신하지 못하면 다운스트림을 진행시키지 않습니다. 기본값이 "차단"이에요. 반대(fail-open, 의심스러워도 일단 진행)는 조용한 오답을 그대로 통과시키니까요.

검문은 세 축입니다. 각각 이미 아는 사실 하나씩과 대조합니다.

**reconciliation(정합)** — 원천 PG의 그 dt 행수와 parquet 행수가 인스턴스별로 정확히 같은가. 2편에서 만든 `verify_count`(원천=적재 대조)를 이 게이트로 흡수했습니다. 불일치는 유실이거나 중복이거나 부분 적재입니다. FAIL.

**completeness(완결성)** — 레지스트리(`database_instance`)에 등록된 인스턴스가 그 dt 파티션에 **전부** 존재하는가. 빈 파티션·수집 누락을 잡는 축입니다. 하나라도 빠지면 FAIL.

**freshness(신선도)** — 그 dt의 최신 `captured_at`이 다음날 00:00 경계에 충분히 근접한가. 수집이 하루 중간에 끊기면 최신 시각이 경계에서 멀어집니다. 기본 임계는 3시간 초과 WARN, 12시간 초과 FAIL로 뒀습니다. freshness만 WARN 단계를 둔 건, 늦게 한 번 끊긴 것과 하루 절반이 빈 것은 심각도가 다르기 때문입니다(dbt test의 warn/error 이원화와 같은 발상).

WARN은 통과시키되 기록합니다. FAIL만 막습니다.

## 3. 개선 — 게이트 모듈과 오케스트레이션

### 게이트 (`extract/quality.py`)

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

### 오케스트레이션 — 게이트를 dbt 앞에 (`extract/run_pipeline.py`)

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

### Airflow — 태스크 의존성으로 같은 계약을

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

## 4. 실측 — 통과, 그리고 일부러 깨뜨리기

### 정상 — 3개 dt 전부 통과

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

### 장애 주입 — instance 3의 파티션을 지우면

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

### Airflow에서도 같은 차단

Airflow DAG에서도 같은 계약을 확인했습니다. freshness FAIL 임계를 0.5h로 조여 07-07(경계까지 0.9h)을 강제로 FAIL시킨 `airflow dags test`의 태스크 상태입니다.

```
$ airflow tasks states-for-dag-run snapshot_offload 2026-07-08
offload       success
quality_gate  failed            # 게이트가 raise → 태스크 실패
transform     upstream_failed   # 게이트 실패로 실행되지 않음
```

그래프로 보면 offload(초록 success) → quality_gate(빨강 failed) → transform(주황 upstream_failed)으로, 게이트가 변환을 실제로 막고 있는 게 한눈에 드러납니다.

![Airflow 그래프 — quality_gate 실패가 transform을 upstream_failed로 막는다](/uploads/project/lakehouse/quality-gate-dag.png)

### 원상복구

시연이 끝나고 `python -m extract.offload 2026-07-06`으로 재적재했습니다. 파티션 통째 덮어쓰기(2편의 멱등성)라 인스턴스 3이 그대로 복원되고, 게이트를 다시 돌리니 3개 dt 전부 PASS로 돌아왔습니다. 리포에는 정상 상태만 남습니다.

## 5. 잔여 — 정직한 한계

- **규칙 기반까지입니다.** 정합·완결성·freshness는 명시적 규칙으로 잡지만, "행수는 맞는데 값이 이상하다"류의 통계적 이상(분포 급변 등)은 이 게이트가 못 봅니다. 그건 다른 층의 일이고, 여기선 범위 밖으로 뒀습니다.
- **알림 발화는 아직입니다.** 게이트는 FAIL로 다운스트림을 막지만, 그 사실을 사람에게 밀어 보내는 웹훅(DBTower의 Discord 채널 재사용 같은)은 붙이지 않았습니다. 지금은 종료코드와 태스크 상태로만 드러납니다.
- **freshness는 dt 파티션 전체 기준입니다.** 그날 일부 인스턴스만 일찍 끊겨도 다른 인스턴스가 경계까지 수집했으면 dt-level로는 OK가 됩니다(07-07이 그랬습니다). 인스턴스별 freshness는 더 촘촘하지만, 그만큼 오탐도 늘어 지금은 dt 단위로 뒀습니다.
- **Airflow의 transform은 얇습니다.** 컨테이너엔 dbt를 얹지 않아, 실제 dbt 빌드는 호스트의 `run_pipeline`에서 실측합니다. Airflow가 증명하는 건 "게이트 통과가 전제여야 변환이 시작된다"는 오케스트레이션 계약이고, 실제 dbt를 막는 것은 `run_pipeline`으로 보였습니다.

3편에서 raw가 처음 답을 냈다면, 이 편에선 그 답을 **믿어도 되는지**를 지키는 문지기를 세웠습니다. 다음은 이 lake를 진짜 lakehouse로 — ACID·타임트래블·스키마 진화를 얹는 테이블 포맷입니다.

코드는 [GitHub](https://github.com/dj258255/dbtower-lakehouse)에 있습니다.

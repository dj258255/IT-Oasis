---
title: '실패해도 아무도 모르는 파이프라인은 미완성 — 알림·retry·컨테이너 dbt·CHECKPOINT'
titleEn: 'A Pipeline That Fails Silently Is Unfinished — Alerts, Retries, dbt in the Container, CHECKPOINT'
description: "4편에서 세운 fail-closed 게이트는 반쪽 데이터를 잘 막았습니다. 그런데 막았다는 사실을 아무도 모릅니다 — 알림이 없어서 파이프라인은 조용히 멈춘 채 발견될 때까지 마트가 낡아갑니다. 더 부끄러운 구멍도 있었습니다. transform 태스크는 컨테이너에 dbt가 없어 로그만 남기고, 실제 dbt는 제가 호스트에서 손으로 돌리고 있었어요 — 그래프는 3단계인데 마지막 단계가 사람 손이면 반쪽 오케스트레이션입니다. 이 편에서 넷을 닫습니다. on_failure_callback으로 webhook 알림(강제 FAIL을 주입하자 로컬 수신기에 dag_id·task_id·에러 요약이 실제로 도착), retries=3+지수 백오프(단 품질 게이트는 retries=0 유지 — 결정적 실패는 재시도해도 그대로 FAIL), Dockerfile의 분리 venv에 dbt를 구워 offload→quality_gate→transform 3태스크가 전부 컨테이너 안에서 success(dbt run PASS=3, test PASS=18), 그리고 스스로 아무것도 지우지 않는 DuckLake에 주간 CHECKPOINT — 스냅샷 11→2, S3 오브젝트 7→3, 행수는 229,153 그대로. backfill도 실측했습니다: -s/-e 날짜 산수를 확정하고, 멱등 덕에 재적재 후 행수가 한 행도 안 변했습니다."
descriptionEn: "The fail-closed gate from part 4 blocks half-baked data well. But nobody knows it fired — with no alerting, the pipeline just sits there silently while the marts grow stale. There was an even more embarrassing hole: the transform task had no dbt in the container, so it only logged a message while I ran dbt by hand on the host — a three-stage graph whose last stage is a human is half an orchestrator. This part closes four gaps. A webhook alert via on_failure_callback (inject a forced FAIL and the local receiver actually gets dag_id, task_id, and an error summary), retries=3 with exponential backoff (but the quality gate keeps retries=0 — deterministic failures fail the same way on retry), dbt baked into a separate venv in the Dockerfile so offload, quality_gate, and transform all succeed inside the container (dbt run PASS=3, test PASS=18), and a weekly CHECKPOINT for DuckLake, which never deletes anything on its own — snapshots 11 to 2, S3 objects 7 to 3, row count unchanged at 229,153. Backfill is measured too: the -s/-e date arithmetic pinned down, and thanks to idempotency not a single row changed after reloading."
date: 2026-06-06
tags:
  - Airflow
  - dbt
  - DuckLake
  - Data Engineering
  - Operations
category: personal/lakehouse
coverImage: /uploads/project/lakehouse/cover.svg
draft: false
series: "lakehouse"
seriesOrder: 6
---

## 0. 상황 — 게이트는 잘 막는데, 막았다고 아무도 안 알려준다

[5편](/blog/project/lakehouse/lakehouse-5-ducklake)까지 파이프라인은 형태를 다 갖췄습니다. 추출하고(2편), 변환하고(3편), 반쪽 데이터를 막고(4편), 테이블 포맷으로 버전까지 쌓았죠(5편). 그런데 이걸 "운영한다"고 상상하는 순간 구멍이 줄줄이 보였습니다.

**첫째, 알림이 없습니다.** 4편의 품질 게이트는 fail-closed입니다 — FAIL이면 transform이 실행되지 않아요. 잘 막습니다. 문제는 그다음입니다. 막았다는 사실을 누구에게도 알리지 않아요. 게이트가 어느 새벽에 FAIL을 내면, 파이프라인은 조용히 멈춘 채 제가 우연히 Airflow UI를 열어볼 때까지 그대로 있습니다. 그동안 마트는 낡아가고요. **조용히 틀린 데이터가 없는 것보다 나쁘듯, 조용히 멈춘 파이프라인은 안 멈춘 척하는 파이프라인과 다를 게 없습니다.** 차단은 시작이고 통보가 완성입니다.

**둘째, 이게 제일 부끄러운데, transform이 반쪽이었습니다.** DAG 그래프는 `offload → quality_gate → transform` 3단계인데, Airflow 컨테이너에 dbt가 없어서 transform 태스크는 "게이트 통과 확인" 로그만 남겼습니다. 실제 dbt run은 제가 호스트에서 손으로 돌렸어요. 그래프의 마지막 단계가 사람 손이면 그건 오케스트레이션이 아니라 오케스트레이션 그림입니다.

**셋째, DuckLake는 스스로 아무것도 지우지 않습니다.** 5편 잔여에 적어둔 그대로입니다 — 커밋마다 스냅샷이 쌓이고, 덮어쓰인 파일은 타임트래블을 위해 S3에 남습니다. 만료 없이 방치하면 카탈로그(PG)와 스토리지(S3)가 단조 증가해요.

그 밖에도 retry 정책이 기본값 방치였고, backfill 절차는 제 머릿속에만 있었습니다. 이 편은 새 기능이 아니라 **운영 경화** 편입니다 — 화려하진 않지만, 이거 없으면 앞의 다섯 편이 전부 "데모"에 머뭅니다.

## 1. 함정 — 알림·재시도·유지보수 각각에 하나씩

### 함정 1: SLA 콜백은 폐기 경로다

Airflow에서 "실패를 알린다"를 검색하면 `sla_miss_callback`이 같이 나옵니다. 쓰면 안 됩니다. SLA 기능은 오랫동안 버그가 많기로 유명했고(스케줄러 안에서 돌아 지연·누락이 잦음), **Airflow 3.0에서 아예 제거됐습니다.** 지금 2.x에서 붙여봤자 이주할 때 뜯어내야 할 빚이에요. 표준 경로는 `on_failure_callback` — 태스크가 최종 실패하면(재시도 소진 후) 호출되는 콜백입니다.

그리고 알림 코드 자체의 함정: **알림이 실패하면?** webhook 수신기가 죽어 있을 때 콜백이 예외를 던지면, 알림 실패가 장애 대응을 더 꼬이게 만듭니다. 알림은 best-effort여야 해요 — 전 과정을 try/except로 감싸고, 실패하면 로그만 남기고 삼킵니다.

### 함정 2: 품질 게이트를 재시도하면 안 된다

retry는 만능이 아닙니다. 재시도가 의미 있는 건 **일시 장애**(네트워크 순단, 원천 재기동)뿐이에요. 품질 게이트의 FAIL은 결정적입니다 — 데이터가 틀렸다는 판정인데, 5분 뒤에 다시 검문한다고 데이터가 맞아지지 않습니다. 재시도는 원천 PG와 S3에 재검문 부하만 얹어요. 그래서 retry 정책은 태스크별로 갈라야 합니다: 추출·변환은 retries=3 + 지수 백오프, **게이트는 retries=0**(4편 설계 그대로).

여기에 이번에 몸으로 배운 게 하나 더 있습니다. 작업 중 원천 스택이 통째로 내려간 적이 있는데(머신 절전), psycopg2 기본값엔 접속 타임아웃이 없어서 **연결 시도가 무한 대기**로 멈춰버렸습니다. 걸려서 멈춘 태스크는 실패도 아니라서 재시도도 알림도 못 탑니다. 그래서 모든 PG DSN에 `connect_timeout=5`를 박았어요 — 빨리 죽어야 재시도가 삽니다.

### 함정 3: dbt와 Airflow를 같은 환경에 섞으면 안 된다

컨테이너에 dbt를 넣는 가장 쉬운 방법은 Airflow의 site-packages에 `pip install dbt-duckdb`를 얹는 겁니다. 하면 안 되는 걸로 널리 알려져 있어요. dbt-core와 Airflow는 공유 의존성(jinja2, click, protobuf 등)의 버전 요구가 자주 충돌해서, 어느 한쪽을 올리는 순간 다른 쪽이 조용히 깨집니다. 관례는 **컨테이너 안 별도 venv에 dbt를 격리**하고 subprocess로 부르는 것 — Cosmos 같은 통합 도구도, MWAA 문서도 같은 이유로 이 구조를 권장합니다.

기존 compose의 `_PIP_ADDITIONAL_REQUIREMENTS`도 이참에 폐기했습니다. 컨테이너가 뜰 때마다 pip을 도는 방식이라 기동이 느리고, 무엇보다 "그날 PyPI 상태"에 따라 환경이 달라지는 비재현 요소였거든요. Dockerfile로 구워야 이미지 해시가 곧 환경입니다.

### 함정 4: DuckLake 정리는 순서가 있다

DuckLake의 유지보수 수단은 여러 개입니다 — 스냅샷 만료(`ducklake_expire_snapshots`), 인접 파일 컴팩션(`ducklake_merge_adjacent_files`), 옛 파일 삭제(`ducklake_cleanup_old_files`)…. 이걸 손으로 하나씩 부르면 **순서에 따라 꼬입니다.** 컴팩션 먼저·만료 나중 같은 조합에서 파일이 남거나 스냅샷 참조가 어긋나는 이슈가 보고돼 있어요(ducklake #336, #536). 공식 권장은 **`CHECKPOINT` 번들** — 만료+인라인 플러시+컴팩션을 안전한 순서로 한 번에 묶어 실행합니다. 보존 기간은 `expire_older_than` 옵션으로 선언하고요.

## 2. 판단 — 넷을 한 번에, 전부 실측으로

정리하면 이번 편의 판단은 이렇습니다.

```
알림        on_failure_callback → webhook POST (URL은 env 주입, 실패는 삼킴)
retry       retries=3 + 지수 백오프. 단 quality_gate만 retries=0 (결정적 실패)
transform   Dockerfile: 분리 venv(/opt/dbt-venv)에 dbt-duckdb → 컨테이너 안 run+test
유지보수     @weekly DAG: CHECKPOINT 번들 + 삭제 예약 파일 정리, 보존 7일
```

보존 7일은 원천(DBTower 스냅샷 보존 7일)과 대칭입니다. raw parquet 원본이 별도 경로에 그대로 있으니, DuckLake 버전 7일이면 "지난주 기준 재계산"까지는 되고 그 이전 타임트래블은 포기 — 대신 용량이 유계가 됩니다.

그리고 전부 실측합니다. 특히 이번 편의 핵심 증거는 하나예요: **`airflow dags test`로 3태스크가 전부 컨테이너 안에서 success가 되는 것.** transform 로그 안에 dbt의 PASS가 찍혀 있어야 합니다.

## 3. 개선 — 코드는 얇게, 경계는 분명하게

### 알림 모듈 (extract/alerts.py)

의존성 0(표준 라이브러리 urllib)으로 짰습니다. 핵심은 두 겹의 try/except입니다 — 전송 실패도, 콜백 내부 오류도 절대 밖으로 안 새 나갑니다.

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

### DAG — retry 정책과 콜백

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

### Dockerfile — dbt는 분리 venv에

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

### DuckLake 유지보수 (extract/ducklake_maintenance.py + @weekly DAG)

공식 권장 순서 그대로 세 줄입니다.

```python
con.execute(f"CALL lh.set_option('expire_older_than', '{retention}')")  # 보존 선언
con.execute("CHECKPOINT lh")                        # 만료+플러시+컴팩션 번들
con.execute("CALL ducklake_cleanup_old_files('lh', cleanup_all => true)")  # 예약된 파일 실제 삭제
```

셋째 줄이 필요한 이유: 만료는 파일을 바로 지우는 게 아니라 **삭제 예약**만 합니다. 예약만으로는 S3 용량이 줄지 않아요. 그리고 모듈에 안전 불변식을 하나 박았습니다 — 유지보수 전/후 테이블 행수를 대조해서 다르면 예외를 던집니다(유지보수는 과거를 지울 뿐 현재를 바꾸면 안 되니까요). 그 예외도 물론 webhook으로 옵니다.

## 4. 실측 — 알림 도착, 3태스크 e2e, CHECKPOINT 전후, backfill

실측 시점의 원천 시계는 2026-07-08 17:24 UTC — 즉 **07-07이 닫힌 창이 됐습니다**(279,002행으로 안정). 이 편의 수치는 전부 닫힌 창만 씁니다.

### 3태스크가 전부 컨테이너 안에서 success

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

![Airflow 그래프 뷰 — offload, quality_gate, transform 3태스크 전부 success (dbt가 컨테이너 안에서 돈 그 런)](/uploads/project/lakehouse/e2e-dag.png)

처음으로 세 단계가 전부 한 컨테이너 안에서 끝났습니다. 호스트의 제 손은 이제 그래프에 없습니다.

### 강제 FAIL → webhook에 실제로 도착

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

같은 순간 스케줄러 로그는 `Marking task as FAILED ... quality_gate` → `알림 전송 완료 (HTTP 200)` → DagRun failed(transform 미실행) 순서로 흘렀습니다. 4편의 차단에 드디어 통보가 붙었어요. 눈여겨볼 것은 `max_tries: 0` — 게이트는 재시도 없이 즉시 죽고 즉시 알립니다. 결정적 실패에 재시도는 낭비니까요.

### CHECKPOINT 전후 — 쌓인 것이 줄고, 현재는 그대로

5편 데모를 두 번 반복해 일부러 버전·파일을 쌓은 뒤, 컨테이너 안에서 `airflow dags test ducklake_maintenance`(데모용 보존 0초)를 돌렸습니다.

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

옛 버전 9개와 죽은 파일 7개(4.5MB)가 사라졌고, 현재 상태는 한 행도 안 변했습니다(불변식 검사 통과). 운영에선 이 DAG가 @weekly, 보존 7일로 돕니다. 트레이드오프는 명확합니다 — 7일보다 오래된 버전으로의 타임트래블은 포기하고, 대신 카탈로그와 스토리지가 유계가 됩니다.

### backfill — 날짜 산수를 실측으로 확정

backfill은 문서 없이는 항상 헷갈립니다. 실측으로 확정했어요: `-s/-e`는 **논리 실행일 구간(양끝 포함)**이고, @daily에서 각 런은 **논리일의 전날 dt**를 처리합니다.

```
$ airflow dags backfill snapshot_offload -s 2026-07-06 -e 2026-07-07 --reset-dagruns -y
→ 런 2개 생성 (논리 07-06, 07-07 = dt 07-05, 07-06 처리)
→ 태스크 6/6 succeeded, failed 0
```

즉 **dt=D 하나만 재적재하려면 `-s D+1 -e D+1`**. 그리고 멱등 검증 — 재적재 전후가 완전히 같습니다.

| 항목 | backfill 전 | backfill 후 |
|---|---|---|
| dt=2026-07-05 행수 | 149,259 | 149,259 |
| dt=2026-07-06 행수 | 79,894 | 79,894 |
| dt=2026-07-06 오브젝트 수 | 6 | 6 |

2편에서 "파티션 통째 덮어쓰기 멱등"을 설계할 때 노린 게 바로 이 장면입니다 — backfill이 무서운 작업이 아니라 그냥 명령 한 줄이 됩니다. `catchup=False`는 그대로 둡니다. DAG를 며칠 껐다 켰을 때 Airflow가 밀린 날짜를 멋대로 대량 실행하는 걸 막고, 과거 재처리는 위처럼 **명시적으로만** 하자는 결정이에요. 이 절차 전체(실패 대응 → 로그 → 재적재, dry-run의 알려진 제약 포함)는 `docs/RUNBOOK.md`로 문서화했습니다 — 새벽에 알림을 받은 사람이 처음부터 끝까지 따라갈 수 있게요.

## 5. 잔여 — 정직한 한계

- **마트는 여전히 전체 재빌드입니다.** 매일 fct/mart 테이블을 통째로 다시 만듭니다. 지금 규모(수십만 행)에선 수 초지만, 적재가 수개월 쌓이면 dbt incremental 모델로 바꿔야 합니다.
- **알림은 채널 하나, best-effort 하나입니다.** 심각도 라우팅(게이트 FAIL은 급하고 유지보수 실패는 덜 급함), 중복 억제, 에스컬레이션은 없습니다. 그리고 알림 실패를 삼키는 설계라 "알림이 안 옴 = 정상"이 아닙니다 — 최종 진실은 Airflow UI라고 RUNBOOK에 못박았습니다.
- **dbt 통합은 subprocess까지입니다.** 모델별 태스크 분해·재시도는 Cosmos 같은 통합 레이어의 몫인데, 모델 3개 규모엔 과잉이라 넣지 않았습니다.
- **CHECKPOINT 주기는 @weekly 고정입니다.** 커밋 빈도나 카탈로그 크기에 따른 적응형 주기는 하지 않았습니다.
- **대시보드(Serve)는 여전히 다음 몫입니다.** 30일 시야가 쌓이는 중이라, "DBTower로는 데이터 없음 vs lakehouse로는 답이 나옴" 대비 실측은 적재가 더 쌓인 뒤에.

0편에서 시작한 질문은 "버려지는 데이터를 어떻게 살릴까"였습니다. 여섯 편이 지나고 나니 대답이 조금 달라졌어요 — 살리는 건 파이프라인이 아니라 **운영**입니다. 막고(4편), 버전을 남기고(5편), 이제 실패를 통보하고 스스로를 청소하는 데까지 왔습니다. 실패해도 아무도 모르는 파이프라인은 미완성이니까요.

코드는 [GitHub](https://github.com/dj258255/dbtower-lakehouse)에 있습니다.

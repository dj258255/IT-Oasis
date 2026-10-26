---
title: '[DE] 논리 날짜와 backfill: Airflow 3에서 {{ ds }}가 가리키는 날이 바뀌었다'
description: 배치 작업에는 시계가 둘 있습니다. 언제 실행하는지와 어느 구간의 데이터를 처리하는지입니다. Airflow 2는 둘을 data interval로 묶었고 Airflow 3는 기본 timetable을 바꿔 매일 00시 run의 ds가 어제에서 오늘이 됐습니다. 이 차이를 DuckDB로 재현하고 catchup과 backfill이 지난 구간을 다시 돌리는 방식, Argo CronWorkflow가 같은 문제를 다루는 방식을 정리합니다.
date: 2026-10-19T00:00:00.000Z
tags:
  - Data Engineering
  - Airflow
  - Argo Workflows
  - Logical Date
  - Data Interval
  - Backfill
  - Catchup
  - Timetable
category: data/Foundations
topics:
  - pipeline
  - messaging
draft: false
series: "DE 공부"
seriesOrder: 5
---

## 결론부터

1. 배치 작업에는 실행 시각(run_after)과 처리할 데이터 구간(data interval) 두 시계가 있습니다. 재시도와 backfill이 안전하려면 태스크가 처리 범위를 데이터 구간으로 정해야 합니다.
2. Airflow 3.0부터 cron 문자열 스케줄의 기본 timetable이 `CronTriggerTimetable`로 바뀌었습니다(`create_cron_data_intervals=False`). 이 timetable은 데이터 구간 개념이 없어서 `data_interval_start`와 `data_interval_end`가 둘 다 트리거 시각입니다. 매일 00시 run의 `ds`가 Airflow 2에서는 어제였고 Airflow 3 기본값에서는 오늘입니다.
3. 재현해 보니 3.x 기본값의 `data_interval_start`로 날짜를 고르면 10/2 00:00 run이 아직 덜 찬 10/2 매출(8,000원)을 집계했습니다. 구간을 1일로 잡은 경우만 첫 실행과 재시도 모두 10/1 매출(42,000원)이 나왔습니다.
4. 수동 트리거와 asset 트리거 run은 logical date가 없습니다(`None`). 이 run에서 `data_interval_start`를 꺼내면 KeyError가 나고 `ds` 같은 시간 변수도 없습니다.
5. Airflow 3의 backfill은 스케줄러가 관리합니다. 이미 있는 run을 어떻게 할지 `none`, `failed`, `completed` 중에서 고릅니다. Argo CronWorkflow에는 논리 날짜와 backfill 기능이 없어 날짜를 파라미터로 넘기는 방식으로 만듭니다.

---

## 1. 실행 시각과 데이터 시각

이 글에는 Airflow 용어가 많이 나와서 처음 보는 분을 위해 먼저 모아 둡니다.

| 용어 | 뜻 | 일일 매출 예 |
|---|---|---|
| DAG | 태스크들과 그 순서를 적은 작업 묶음 하나 | `daily_sales` DAG: 주문 읽기 → 집계 → 저장 |
| run(DAG run) | DAG를 한 번 실행한 것 | 10/2 00:00에 돈 `daily_sales` 한 번 |
| cron 식 | "언제 돌릴지"를 적는 표기. `0 0 * * *`는 매일 0시 0분 | 매일 자정 |
| timetable | cron 식을 보고 run을 언제 만들고 각 run에 어떤 날짜를 붙일지 정하는 규칙 | 2절에서 두 종류를 비교 |
| logical date | run에 붙는 대표 날짜. 같은 DAG의 run들을 구분하고 정렬하는 이름표 | 2절에서 보듯 timetable에 따라 10/1일 수도 10/2일 수도 있다 |
| `{{ ds }}` | 태스크 코드 안에 쓰는 템플릿 변수. 실행할 때 logical date의 `YYYY-MM-DD` 문자열로 바뀐다 | `WHERE day = '{{ ds }}'`가 `WHERE day = '2026-10-01'`이 된다 |

일일 매출 집계는 "10월 1일 하루치 주문"을 처리합니다. 10월 1일 주문은 10월 1일이 끝나야 다 모이니 실제 실행은 10월 2일 00시 이후입니다. 이 작업에는 시각이 둘 붙습니다.

| 시각 | 뜻 | 예 |
|---|---|---|
| 실행 시각(run_after) | 이 run을 언제 만들고 실행해도 되는지 | 10/2 00:00 |
| 데이터 구간(data interval) | 이 run이 어느 구간의 데이터를 처리하는지 | 10/1 00:00 ~ 10/2 00:00 |

4편에서 태스크 안에서 `now()`로 "어제"를 계산하면 재시도할 때 다른 날을 처리한다고 했습니다. 실행 시각은 재시도마다 바뀌고 데이터 구간은 run에 고정되어 있으니 처리 범위는 데이터 구간으로 정해야 합니다. 그런데 Airflow 3에서는 이 데이터 구간이 기본적으로 없어졌습니다.

이 두 시계가 헷갈리는 데는 이름 탓도 있었습니다. Airflow 2.1까지는 logical date를 `execution_date`라고 불렀습니다. 이름만 보면 "실행한 시각"인데 실제로는 구간 시작이라 실행 시각보다 늘 한 구간 앞이었습니다. 10/2 00:00에 실행된 run의 `execution_date`가 10/1이었으니 처음 쓰는 사람마다 하루씩 헷갈렸습니다. 2.2에서 이 이름을 바꾼 설계 문서 AIP-39도 이름이 직관과 다르다는 점을 이유로 들고 `execution_date`를 `data_interval_start`로, `next_execution_date`를 `data_interval_end`로 바꾸자고 제안했습니다.

## 2. Airflow 3에서 바뀐 기본 timetable

### 2-1. 두 종류의 timetable

Airflow 3.2.2 timetable 문서는 cron 스케줄을 해석하는 방식을 둘로 나눕니다.

| | CronDataIntervalTimetable | CronTriggerTimetable |
|---|---|---|
| 데이터 구간 | 있다. 직전 cron 시각부터 이번 cron 시각까지 | 없다. `data_interval_start`와 `data_interval_end`가 같다 |
| 실행 시각 | 구간이 끝나는 cron 시각 | cron 시각 |
| logical date | 구간 시작 | 트리거 시각 |
| 매일 00시 스케줄, 10/2 00:00 실행 run의 `ds` | 2026-10-01 | 2026-10-02 |
| Airflow 2 기본값 | 이것 | |
| Airflow 3 기본값 | | 이것(`create_cron_data_intervals=False`) |

문서는 두 timetable이 같은 시각에 run을 실행하고 run_id에 붙는 타임스탬프만 다르다고 적습니다. 실행 시각은 그대로인데 logical date와 그 파생값(`ds`, `data_interval_*`)이 하루 밀린 셈입니다. Astronomer의 업그레이드 문서도 logical date가 Airflow 2에서는 `data_interval_start`와 같았고 Airflow 3에서는 run_after와 같아졌다고 정리합니다.

이 설정은 `schedule`에 cron 문자열(`"0 0 * * *"`, `"@daily"`)을 넘긴 DAG에만 적용됩니다. timetable 객체를 직접 넘긴 DAG는 영향이 없습니다. 문서는 업그레이드 전에 이 값을 명시적으로 고정하라고 권합니다.

### 2-2. 재현: 날짜를 고르는 세 가지 방법

- DuckDB에 10/1 주문 42,000원과, 아직 들어오는 중인 10/2 주문 8,000원을 넣습니다.
- 매일 00시에 도는 일일 매출 run이 10/2 00:00에 실행되다 실패하고 10/3 09:00에 재시도된다고 칩니다.
- 각 방법이 받는 `data_interval_start`는 문서의 timetable 정의를 흉내 냈습니다. Airflow를 직접 띄운 결과는 아닙니다.
- 코드는 [labs/de-study/ch04](https://github.com/dj258255/IT-Oasis/tree/main/labs/de-study/ch04)의 `interval_vs_now.py`입니다.

| 날짜를 고르는 방법 | 첫 실행(10/2 00:00) | 재시도(10/3 09:00) |
|---|---|---|
| `now() - 1일` | 10/1, 42,000원 | 10/2, 8,000원 |
| 3.x 기본 CronTrigger의 `data_interval_start` | 10/2, 8,000원 | 10/2, 8,000원 |
| 1일 구간의 `data_interval_start` | 10/1, 42,000원 | 10/1, 42,000원 |

![10/1 00:00부터 10/3 09:00까지의 시간축 위에 세 방법을 한 줄씩 놓은 그림. 1일 구간 run은 10/1 하루를 데이터 구간으로 갖고 있어 10/2 00:00 첫 실행과 10/3 09:00 재시도 모두 10/1 매출 42,000원을 집계한다. 3.x 기본 CronTrigger는 구간 시작과 끝이 모두 10/2 00:00인 점이라 두 번 다 아직 들어오는 중인 10/2 매출 8,000원을 집계한다. now() - 1일은 첫 실행에서 10/1, 재시도에서 10/2를 집계한다](/uploads/data/de-04-logical-date-backfill/two-clocks.svg)

표를 시간축 위에 옮긴 그림입니다. 줄마다 "이 방법은 어디를 보고 날짜를 정하나"를 따라가면 됩니다. 1일 구간은 run에 붙은 초록 막대를 보고 CronTrigger는 길이가 0인 빨간 점을 보고 `now()`는 태스크가 돌아가는 순간의 시계를 봅니다.

두 번째 줄이 Airflow 2에서 3으로 올리면서 생길 수 있는 일입니다. 재시도해도 결과가 같으니 멱등하긴 합니다. 그런데 처음부터 틀린 날을 일관되게 처리합니다. 에러가 나지 않고 10/2 매출이 8,000원으로 나오는 것도 데이터가 덜 찼다는 걸 모르면 이상해 보이지 않습니다.

`now() - 1일`은 첫 실행에서 맞는 값을 냅니다. 테스트를 한 번 돌려 보는 것으로는 이 방법의 문제를 못 찾고 재시도나 backfill을 할 때 드러납니다.

### 2-3. 고치는 방법

구간을 다시 만들면 됩니다. 방법은 둘입니다.

```python
from datetime import timedelta

from airflow.timetables.trigger import CronTriggerTimetable

@dag(
    # 트리거 시각에 끝나는 1일 구간을 명시한다
    schedule=CronTriggerTimetable("0 0 * * *", timezone="Asia/Seoul", interval=timedelta(days=1)),
    ...
)
```

- `CronTriggerTimetable`에 `interval`을 주면 run마다 그 길이의 데이터 구간이 생기고 트리거 시각에 끝납니다. 위 코드라면 서울 시각 10/2 00:00에 도는 run이 "10/1 00:00부터 10/2 00:00까지"라는 구간을 받습니다. `"0 0 * * *"`는 언제 돌릴지, `interval=timedelta(days=1)`은 그때 얼마만큼 뒤를 돌아볼지를 따로 정하는 셈입니다.
- 설정 `[scheduler] create_cron_data_intervals = True`로 cron 문자열 전체를 Airflow 2 방식으로 되돌릴 수도 있습니다. 문서는 trigger에서 data interval로 바꿀 때 기존 run이 있으면 스케줄 run 한 번이 건너뛰어진다고 경고합니다.

그리고 태스크에서는 `ds` 대신 `data_interval_start`, `data_interval_end`를 씁니다. 3.2.2 템플릿 문서는 logical date에 대해 "의미가 없는 식별용 값"이라고 적고 의미 있는 시각이 필요하면 data interval을 쓰라고 합니다. 같은 문서는 logical date와 `ds`가 DAG 안에서 유일하다고 가정하지 말고 run을 구분하려면 run_id를 쓰라고 합니다.

## 3. logical date가 없는 run

run은 시계 말고 다른 계기로도 시작합니다. asset은 Airflow 3에서 "이 테이블이나 파일이 갱신됐다"를 나타내는 이름표입니다. 앞 DAG가 `orders` asset을 갱신했다고 알리면 그 asset을 기다리던 DAG가 바로 run을 만듭니다. 사람이 UI의 Trigger 버튼이나 REST API로 직접 돌리는 수동 트리거도 있습니다. 이런 run은 "어느 날짜를 처리하는지"가 스케줄에서 나오지 않습니다.

Airflow 3.0 릴리스 노트는 asset 이벤트로 트리거되거나 logical date 없이 REST API로 트리거된 run은 `logical_date=None`이 되고 데이터 구간도 없다고 적습니다. 이 run의 태스크에서 `data_interval_start`, `data_interval_end`, `logical_date`를 꺼내면 KeyError가 납니다. 템플릿 문서도 asset 트리거 DAG에는 `logical_date`, `ds`, `ds_nodash` 같은 시간 변수가 없다고 적습니다.

같은 DAG를 스케줄로도 돌리고 asset으로도 돌린다면 태스크가 두 경우를 다 처리해야 합니다. 릴리스 노트는 `dag_run.logical_date`가 있는지 먼저 확인하라고 권합니다. logical date 없는 run에서 `{{ ds }}`를 렌더링하면 3.2.2 소스 기준으로 그 키가 컨텍스트에 들어가지 않고 DAG의 기본 `template_undefined`가 `StrictUndefined`라 렌더링 오류가 날 것으로 보입니다. `StrictUndefined`는 템플릿 엔진 Jinja의 설정으로 없는 변수를 만나면 빈 문자열로 넘어가지 않고 그 자리에서 오류를 냅니다. 조용히 `WHERE day = ''`가 되는 것보다는 낫지만 asset으로 돌린 run이 바로 실패한다는 뜻입니다. 직접 실행해 확인하지는 않았습니다.

미래의 logical date로는 run을 트리거할 수 없게 된 것도 3.0의 변화입니다.

## 4. catchup: 놓친 구간을 자동으로 채우기

DAG를 켰을 때 `start_date`부터 지금까지 놓친 run을 자동으로 만드는 것이 catchup입니다. 3.0에서 기본값이 `False`로 바뀌었습니다.

`start_date`를 2026-01-01로 두고 2026-10-19 14:00에 DAG를 켰다면 `catchup=True`일 때 한꺼번에 만들어지는 run 수를 세어 봤습니다(`catchup_count.py`).

| timetable | run 수 | logical date 범위 |
|---|---|---|
| CronDataInterval | 291개 | 01/01 ~ 10/18(구간이 끝난 것만) |
| CronTrigger | 292개 | 01/01 ~ 10/19(트리거 시각이 지난 것) |

291은 1월 1일부터 10월 18일까지의 날수입니다. 1~9월이 273일이고 10월 18일이 더해져 291일입니다. CronDataInterval은 하루가 다 끝난 구간에만 run을 만드니 10/19 하루는 아직 진행 중이라 빠집니다. CronTrigger는 10/19 00:00 트리거 시각이 이미 지났으니 그 run까지 만들어 하나가 많습니다.

291개 run이 동시에 생기면 7편의 동시성 제한이 바로 의미를 갖습니다. `max_active_runs` 기본값 16만큼 동시에 돌면서 DB나 외부 API를 두드립니다. 오늘의집 Airflow 도입기(2021)도 과거 `start_date`가 자동 backfill로 이어지는 걸 짚고 `catchup=False`를 쓰라고 했습니다.

`catchup=False`일 때의 동작도 timetable마다 다릅니다. 문서의 예시는 1/31 15시에 DAG를 멈췄다가 2/2 15시에 다시 켠 경우입니다. CronTrigger는 2/1, 2/2 run을 건너뛰고 2/3 00시에 다음 run을 실행합니다. CronDataInterval은 2/1 run만 건너뛰고 2/2 run을 다시 켜자마자 실행합니다.

## 5. backfill: 지난 구간을 골라서 다시 돌리기

### 5-1. Airflow 3의 backfill

catchup이 "켤 때 자동으로"라면 backfill은 "범위를 골라서 직접"입니다. Airflow 3.0부터는 스케줄러가 backfill을 관리합니다(AIP-78). UI와 REST API로 시작하고 지켜볼 수 있습니다.

```bash
airflow backfill create --dag-id daily_sales \
  --from-date 2026-09-01 --to-date 2026-09-30 \
  --reprocess-behavior failed \
  --max-active-runs 3 \
  --dry-run                 # 만들 run 목록만 보여 준다
```

| 옵션 | 뜻 |
|---|---|
| `--reprocess-behavior none`(기본) | 그 logical date의 run이 이미 있으면 상태와 상관없이 만들지 않는다 |
| `--reprocess-behavior failed` | 기존 run이 실패했을 때만 새로 만든다 |
| `--reprocess-behavior completed` | 기존 run이 성공했든 실패했든 새로 만든다 |
| 공통 | 최신 run이 running이나 queued면 어느 옵션이든 만들지 않는다 |
| `--max-active-runs` | backfill에만 따로 적용된다. DAG의 `max_active_runs`와 별개 |
| `--run-backwards` | 최근 날짜부터 거꾸로 돈다. `depends_on_past` 태스크가 있으면 쓸 수 없다 |

`depends_on_past`는 태스크 설정으로 "어제 run의 같은 태스크가 성공해야 오늘 것을 돌린다"는 뜻입니다. 누적 잔액처럼 전날 결과를 이어받는 계산에 씁니다. 거꾸로 돌면 어제 것이 아직 없으니 함께 쓸 수 없습니다. 3.2.2 소스는 `depends_on_past` 태스크가 있는 DAG에서 reprocess 옵션을 `none`(또는 생략)으로 두는 것도 막고 `failed`나 `completed`를 고르라는 오류를 냅니다.

세 가지 reprocess 옵션의 차이는 상태가 섞인 한 달을 놓고 보면 분명합니다. 9월 30일 가운데 1~20일은 성공, 21~25일은 실패, 26~30일은 DAG가 꺼져 있어 run이 아예 없다고 하겠습니다.

| 옵션 | 새로 만드는 run | 개수 |
|---|---|---|
| `none` | run이 없는 26~30일 | 5개 |
| `failed` | 26~30일 + 실패한 21~25일 | 10개 |
| `completed` | 9월 전체 | 30개 |

로직 버그를 고쳐서 이미 성공한 날까지 다시 계산해야 할 때만 `completed`를 씁니다.

UI에서는 Trigger에서 Backfill을 고르고 reprocess 선택지가 "Missing Runs", "Missing and Errored Runs", "All Runs"로 보입니다.

공식 문서끼리 플래그 이름이 다른 곳이 있습니다. backfill 개념 문서의 예시는 `--start-date`, `--end-date`, `--reprocessing-behavior`를 쓰고 3.2.2 CLI 레퍼런스는 `--from-date`, `--to-date`, `--reprocess-behavior`입니다. 위 예시는 CLI 레퍼런스를 따랐습니다. FAQ에도 3.0에서 없어진 `execution_date` 설명이 아직 남아 있습니다.

backfill이 안전하려면 4편의 멱등성이 전제입니다. `completed`로 이미 성공한 날을 다시 돌릴 때 append로 쌓는 태스크라면 매출이 두 배가 됩니다.

### 5-2. 사례: execution_date 제거의 비용

Airflow 3에서 `execution_date`가 컨텍스트와 API에서 빠지고 `logical_date`로 바뀌었습니다. 대규모 DAG 환경에서 3.0으로 옮긴 경험을 정리한 글(nanta, 2026)은 이 변화의 영향이 가장 컸다며 1차 252개, 2차 35개, 3차 21개 파일을 고쳤다고 적었습니다. `next_execution_date`는 `data_interval_end`로, `prev_execution_date_success`는 `prev_data_interval_start_success`로 바꿨습니다.

## 6. 시간대

Airflow는 기본적으로 UTC로 동작합니다. 오늘의집 도입기는 `start_date`에 `pendulum.timezone("Asia/Seoul")`을 넣어 KST 기준으로 스케줄을 짰다고 썼습니다. 2-3절의 예처럼 `CronTriggerTimetable`에 `timezone`을 주는 방법도 있습니다.

시간대를 쓰면 일광 절약 시간(DST)이 있는 지역에서는 하루에 실행이 0번이나 2번 생길 수 있습니다. Argo CronWorkflow 문서가 이 경우를 명시합니다. 한국은 DST가 없지만 해외 데이터를 그 지역 시간으로 자르는 작업이라면 확인해야 합니다.

## 7. Argo CronWorkflow는 날짜를 파라미터로 넘긴다

Argo CronWorkflow는 쿠버네티스 CronJob을 본떠 만들었고 Airflow의 logical date나 data interval에 해당하는 개념이 문서에 없습니다.

| 필드 | 기본값 | 뜻 |
|---|---|---|
| `schedules` | (필수) | cron 식 목록. 단수형 `schedule`은 v4.0에서 없어졌다 |
| `timezone` | 컨트롤러 기계의 시간대 | IANA 이름 |
| `concurrencyPolicy` | Allow | Allow는 겹쳐도 실행, Forbid는 이전 것이 돌고 있으면 건너뜀, Replace는 이전 것을 지우고 새로 실행 |
| `startingDeadlineSeconds` | 0 | 놓친 실행을 몇 초 안에 따라잡을지. 여러 번 놓쳐도 한 번만 실행한다 |
| `successfulJobsHistoryLimit`, `failedJobsHistoryLimit` | 3, 1 | 남길 Workflow 수 |

실행 시각은 `workflow.scheduledTime` 변수로 받을 수 있습니다. 처리할 날짜는 이 값에서 직접 계산하거나 파라미터로 넘깁니다.

backfill도 내장 기능이 없습니다. 공식 cron-backfill 예시는 이렇게 만듭니다.

1. 실제 일을 하는 WorkflowTemplate을 만들고 `date` 파라미터를 받게 합니다(기본값 "yesterday").
2. CronWorkflow는 이 템플릿을 매일 부릅니다.
3. backfill이 필요하면 별도 Workflow에서 `withSequence`로 날짜 목록을 만들어 날짜마다 템플릿을 부릅니다. Workflow 이름에 날짜를 넣어 같은 날짜가 두 번 만들어지지 않게 합니다.

`withSequence`는 숫자 범위를 받아 그 개수만큼 같은 단계를 펼치는 Argo 문법입니다. 공식 예시는 `start: "19"`, `end: "21"`과 날짜 모양의 `format`을 줘서 숫자 하나하나를 그 달의 날짜 문자열로 바꾸고 날짜마다 `create-job` 단계를 하나씩 만듭니다. 각 단계는 `job-<날짜>`라는 이름의 Workflow를 `action: apply`로 만듭니다. 예시의 주석은 날짜로 이름을 지으면 이미 있는 리소스를 다시 만들지 않아 더 견고하다고 적었습니다. 같은 날짜로 backfill을 두 번 돌려도 같은 이름의 Workflow가 새로 하나 더 생기지 않는다는 뜻입니다. 다만 예시를 그대로 베끼지는 않는 게 좋습니다. 예시의 `format`은 `"2020-05-%02X"`인데 `%X`는 16진수라서 19가 `13`으로 찍힙니다. 10진수 날짜를 원하면 `%02d`로 바꿔야 합니다.

Airflow가 구간 개념을 오케스트레이터 안에 둔다면 Argo는 그걸 작업 쪽 파라미터로 내보낸 셈입니다. 어느 쪽이든 처리 범위를 실행 시각과 분리해서 넘겨받는다는 원칙은 같습니다.

## 8. 중국과 국내 빅테크 사례

### 8-1. 카카오뱅크: 날짜를 인자로 넘기고 시간대를 바꾼다

카카오뱅크의 2024년 글 "Airflow로 펀드 배치 시스템 완벽 구축하기"는 2절의 원칙을 그대로 적었습니다. 업무를 재처리하려고 다음 영업일에 다시 돌려도 전날 실행과 같은 결과가 나오도록 날짜 파라미터를 넘깁니다. 실제 실행 일자가 필요할 때는 `{{ data_interval_end }}`를 쓰고 `astimezone`으로 Asia/Seoul로 바꿉니다. 6절의 시간대 문제를 태스크에서 명시적으로 처리하는 방식입니다.

### 8-2. Alibaba DataWorks: 끝나야 하는 시각에서 거꾸로 계산하는 기준선

Alibaba의 DataWorks는 태스크 하나 대신 혈연으로 이어진 사슬 전체를 감시 단위로 삼는 "기준선(基线)"을 둡니다. 2023년 발표 정리 "阿里巴巴数据稳定性治理实践"에 따르면 기준선에는 산출 마감 시각, 경보 여유, 경보 방식, 수신자가 들어 있고 실행 전에 미리 경보하고 실행 뒤에 즉시 경보합니다. 공식 문서는 경보 시각을 "약속 시각 - 경보 여유"로 두고 과거 평균 실행 시간을 거꾸로 더해 가며 각 태스크가 늦어도 언제 시작하고 끝나야 하는지 계산한다고 적습니다. 실행이 30분을 넘고 과거 평균보다 15분 넘게 길면 느려진 태스크로 판정합니다.

1절에서 실행 시각과 데이터 시각을 나눴다면 기준선은 여기에 "결과가 나와야 하는 시각"을 하나 더 둡니다. backfill로 지난 구간을 다시 돌릴 때 오늘 마감에 걸린 사슬과 자원을 다투지 않게 하는 근거가 됩니다.

### 8-3. backfill이 얼마나 큰 일인가

- **Meituan**(2017): 두 데이터 플랫폼을 합칠 때 옮길 태스크가 7,000개를 넘었다가 8,000개를 넘었고 의존 깊이가 평균 10단계, 깊은 것은 수십 단계였습니다. 태스크 하나를 옮기는 데 데이터 복사 1~4일, 코드 수정과 시험과 이중 실행에 3~5일이 걸렸습니다. 만들어지는 데이터의 약 50%가 과거 데이터를 덮어쓰는 것이라고 적었습니다. 재계산이 일상의 절반이라는 뜻이고 5절의 backfill이 멱등해야 하는 이유입니다.
- **有赞**(2021): 장애 동안 빠진 실행(예: 7시, 8시)은 복구 뒤 catchup으로 자동으로 채우고 여러 DAG에 걸친 재계산은 하류 인스턴스를 지운(clear) 뒤 catchup으로 다시 채운다고 설명했습니다.

## 9. 범위와 한계

- 2-2절은 timetable 정의를 흉내 낸 시뮬레이션입니다. Airflow 3.2를 직접 띄워 `ds` 값을 찍어 보지는 않았습니다. 직접 확인하려면 3편 실습 환경에서 `@daily` DAG로 `{{ ds }}`와 `{{ data_interval_start }}`를 출력해 보면 됩니다.
- 3절의 `{{ ds }}` 렌더링 오류는 소스를 읽고 내린 추론입니다.
- 4절의 `catchup=False` 동작은 문서 예시를 옮겼고 직접 재현하지 않았습니다.
- `create_delta_data_intervals` 설정과 timedelta 스케줄의 관계는 문서와 소스가 맞지 않아 다루지 않았습니다.

## 10. 헷갈렸던 것

**Q. 그럼 Airflow 3에서 `ds`는 쓰면 안 되나요?**

timetable이 데이터 구간을 갖고 있으면 `ds`는 구간 시작 날짜라 그대로 쓸 수 있습니다. 문제는 기본값인 CronTrigger에서 `ds`가 트리거 날짜가 된다는 점입니다. 어느 timetable인지 코드만 보고 알기 어렵다면 `data_interval_start`, `data_interval_end`를 쓰고 구간을 명시하는 쪽이 읽는 사람에게도 분명합니다.

**Q. catchup과 backfill은 같은 건가요?**

둘 다 지난 구간의 run을 만듭니다. catchup은 DAG를 켤 때 스케줄러가 `start_date`부터 자동으로 만들고 backfill은 사람이 범위와 재처리 방식을 골라 만듭니다. 3.0부터 catchup 기본값이 꺼져 있어서 지난 구간은 backfill로 채우는 쪽이 기본 흐름이 됐습니다.

**Q. Argo `concurrencyPolicy: Forbid`면 중복 실행이 없나요?**

이전 Workflow가 돌고 있으면 이번 스케줄을 건너뜁니다. 건너뛴 날짜의 데이터는 처리되지 않으니 나중에 따로 돌려야 합니다. 7편에서 본 것처럼 겹침을 막는 장치와 같은 일을 한 번만 하게 하는 장치는 다릅니다.

## 참고 자료

공식 문서와 소스
- [Airflow 3.2.2 Timetables](https://airflow.apache.org/docs/apache-airflow/3.2.2/authoring-and-scheduling/timetable.html)
- [Airflow 3.2.2 DAG Runs](https://airflow.apache.org/docs/apache-airflow/3.2.2/core-concepts/dag-run.html)
- [Airflow 3.2.2 Templates reference](https://airflow.apache.org/docs/apache-airflow/3.2.2/templates-ref.html)
- [Airflow 3.2.2 Backfill](https://airflow.apache.org/docs/apache-airflow/3.2.2/core-concepts/backfill.html), [CLI reference](https://airflow.apache.org/docs/apache-airflow/3.2.2/cli-and-env-variables-ref.html)
- [Airflow Release Notes](https://airflow.apache.org/docs/apache-airflow/stable/release_notes.html) 3.0.0
- [Airflow 3.2.2 timetables/base.py](https://raw.githubusercontent.com/apache/airflow/3.2.2/airflow-core/src/airflow/timetables/base.py)
- Astronomer, [Upgrade from Airflow 2 to 3](https://www.astronomer.io/docs/learn/airflow-upgrade-2-3)
- Ash Berlin-Taylor, [AIP-39 Richer scheduler_interval](https://cwiki.apache.org/confluence/display/AIRFLOW/AIP-39+Richer+scheduler_interval)(2.2.0에 반영된 설계 문서)
- [Argo Workflows Loops (withSequence)](https://argo-workflows.readthedocs.io/en/latest/walk-through/loops/)
- [Argo Workflows Cron Workflows](https://argo-workflows.readthedocs.io/en/latest/cron-workflows/), [Cron Backfill](https://argo-workflows.readthedocs.io/en/latest/cron-backfill/), [Variables](https://argo-workflows.readthedocs.io/en/latest/variables/)

사례
- [오늘의집, 버킷플레이스 Airflow 도입기](https://www.bucketplace.com/post/2021-04-13-%EB%B2%84%ED%82%B7%ED%94%8C%EB%A0%88%EC%9D%B4%EC%8A%A4-airflow-%EB%8F%84%EC%9E%85%EA%B8%B0/) (2021)
- [DEV, Airflow 3 quietly changed what your cron schedule means](https://dev.to/itcraftsman/airflow-3-quietly-changed-what-your-cron-schedule-means-2okg)
- [nanta, Airflow 3.0 Migration Guide: Lessons from a Large-Scale DAG Environment](https://nanta-data.dev/en/posts/airflow-3-migration-guide/) (2026)

이 시리즈
- 실습 코드: [labs/de-study/ch04](https://github.com/dj258255/IT-Oasis/tree/main/labs/de-study/ch04)

중국과 국내 빅테크 사례
- Sean(마승현), [Airflow로 펀드 배치 시스템 완벽 구축하기](https://tech.kakaobank.com/posts/2412-financial-batch-system-with-airflow/), 카카오뱅크, 2024
- 冉秋萍(Alibaba), [阿里巴巴数据稳定性治理实践](https://hub.baai.ac.cn/view/31355), DataFunTalk 재게시, 2023
- Alibaba Cloud, [DataWorks 基线介绍](https://www.alibabacloud.com/help/zh/dataworks/user-guide/intelligent-baseline/)(공식 문서)
- 语宸(Meituan), [美团数据平台融合实践](https://tech.meituan.com/2017/08/25/dataplat-coalesce.html), 2017
- Zheqi Song(有赞), [From Airflow to Apache DolphinScheduler, the Roadmap of Scheduling System On Youzan Big Data Development Platform](https://github.com/apache/dolphinscheduler-website/blob/master/blog/en-us/YouZan-case-study.md)

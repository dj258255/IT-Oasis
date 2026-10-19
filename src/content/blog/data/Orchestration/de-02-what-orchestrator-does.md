---
title: '[DE Ch-02] 오케스트레이터는 무엇을 맡나: cron 다음에 필요한 것들'
description: cron으로 스크립트를 시간 차를 두고 돌리면 의존성, 재시도, 실행 기록, 지난 날짜 재실행, 실패 알림이 빠집니다. Airflow 3와 Argo Workflows가 이 일을 어떤 부품으로 나눠 맡는지, 실행 상태를 어디에 두는지, 부품 하나가 죽으면 무엇이 멈추는지 공식 문서와 기술블로그로 정리합니다.
date: 2026-10-19T00:00:00.000Z
tags:
  - Data Engineering
  - Workflow Orchestration
  - Airflow
  - Argo Workflows
  - DAG
  - Scheduler
category: data/Orchestration
topics:
  - pipeline
  - messaging
draft: false
series: "DE 공부"
seriesOrder: 2
---

## 결론부터

1. cron은 정해진 시각에 명령을 실행하는 일만 합니다. 앞 작업이 끝났는지, 실패하면 다시 돌릴지, 어제 무엇이 돌았는지는 사람이 챙겨야 합니다. 오케스트레이터는 이 일을 맡습니다.
2. 작업 흐름은 DAG(방향이 있고 순환이 없는 그래프)로 정의합니다. 순환이 없어야 스케줄러가 실행 순서를 정할 수 있습니다.
3. Airflow 3는 스케줄러, DAG 프로세서, API 서버, (선택) triggerer, 메타DB, 워커로 나뉩니다. 3.x부터 태스크는 메타DB에 직접 붙지 못하고 API 서버를 거쳐 상태를 보고합니다.
4. Argo Workflows는 워크플로를 쿠버네티스 리소스로 저장하고 컨트롤러가 단계마다 Pod를 띄웁니다. 실행 상태가 etcd에 있어서 리소스 하나가 약 1MB를 넘으면 안 됩니다.
5. 오케스트레이터는 보통 태스크 사이에 데이터 대신 경로나 ID만 넘깁니다. 실행 상태를 담는 저장소는 데이터를 담도록 만든 곳이 아니기 때문입니다.

---

## 1. cron으로 버티다 생기는 일

주문 데이터를 가져와(A), 정리하고(B), 일일 매출을 집계하는(C) 작업이 있다고 해 봅시다. cron으로는 이렇게 걸 수 있습니다.

```
0 1 * * *  python extract_orders.py   # A
30 1 * * * python clean.py            # B
0 2 * * *  python daily_sales.py      # C
```

처음에는 잘 돕니다. 문제는 A가 30분 넘게 걸린 날 생깁니다.

| 빠진 것 | cron에서 생기는 일 |
|---|---|
| 의존성 | A가 안 끝났는데 B가 1시 30분에 시작해서 반쯤 들어온 데이터를 정리한다 |
| 재시도 | B가 일시적인 네트워크 오류로 실패하면 다음 날까지 아무도 다시 돌리지 않는다 |
| 실행 기록 | 지난주 화요일에 C가 성공했는지 보려면 서버에 들어가 로그 파일을 뒤져야 한다 |
| 지난 날짜 재실행 | B의 버그를 고친 뒤 지난 7일치를 다시 돌리려면 날짜를 인자로 받게 고치고 손으로 7번 돌린다 |
| 실패 알림 | C가 실패해도 대시보드 숫자가 어제 그대로인 걸 누군가 알아챌 때까지 모른다 |

국내외 기술블로그의 도입기도 대부분 이 표에서 시작합니다. 오늘의집은 Jenkins로 파이프라인을 운영하다가 모니터링 부족, 정교한 의존성 구성의 어려움, 태스크 하나의 실패가 여러 팀의 생산성을 떨어뜨리는 문제로 Airflow를 도입했습니다. 쏘카는 Rundeck에서 옮긴 이유로 고객 서비스용 스케줄링과 데이터 파이프라인 스케줄링의 분리, 데이터 웨어하우스 연동, 워크플로 시각화를 꼽았습니다.

Airflow 자체도 같은 이유로 생겼습니다. 2014년 10월 Airbnb에서 늘어나는 워크플로를 관리하려고 만들었고 2015년 6월 공개한 뒤 2016년 Apache 인큐베이터를 거쳐 2019년 최상위 프로젝트가 됐습니다.

## 2. DAG: 순환이 없어야 순서를 정할 수 있다

오케스트레이터는 작업 흐름을 DAG(Directed Acyclic Graph)로 받습니다. 태스크가 꼭짓점이고 "A가 끝나야 B" 같은 의존성이 방향 있는 간선입니다.

```
extract_orders ──→ clean ──→ daily_sales
```

순환이 없어야 하는 이유는 스케줄러가 하는 일에서 나옵니다. 스케줄러는 "앞 태스크가 모두 성공한 태스크"를 찾아 실행합니다. B가 C를 기다리고 C가 B를 기다리면 둘 다 영원히 시작할 수 없습니다. 순환이 없으면 위상 정렬로 항상 실행 순서를 만들 수 있습니다.

반복이 필요한 흐름도 있습니다. Netflix가 2024년 공개한 Maestro는 DAG와 함께 순환 워크플로, for-each 반복, 하위 워크플로도 지원합니다. 순환을 허용하는 엔진이 실행 순서와 종료를 어떻게 정하는지는 이번에 확인하지 못했습니다.

## 3. Airflow 3의 부품

### 3-1. 부품별 역할

Airflow 3.2 공식 문서의 Architecture Overview 기준입니다.

| 부품 | 하는 일 | 필수 여부 |
|---|---|---|
| 스케줄러(scheduler) | 어떤 태스크를 지금 돌릴지 정하고 executor에 넘긴다. executor는 별도 서비스가 아니고 스케줄러 프로세스 안에서 돈다 | 필수 |
| DAG 프로세서(dag-processor) | DAG 파일(파이썬)을 읽어 구조를 메타DB에 저장한다. 3.x에서는 모든 배포에 필요하다 | 필수 |
| API 서버(api-server) | UI와 REST API를 제공한다. 태스크도 이 API로 상태를 보고한다 | 필수(UI 포함) |
| triggerer | deferred 태스크의 대기를 asyncio 이벤트 루프 하나로 모아 처리한다 | deferred 태스크를 쓸 때만 |
| 메타DB | DAG 구조, 실행 기록, 태스크 상태, XCom이 쌓인다 | 필수 |
| 워커 | 태스크를 실제로 실행한다. 기본 설치에서는 스케줄러 안에 있을 수 있다 | executor에 따라 |

### 3-2. executor는 "태스크를 어디서 돌릴지"를 정한다

executor를 고르는 것은 태스크를 실행할 장소를 고르는 일입니다. 3.2 문서는 이렇게 나눕니다.

| 종류 | executor | 태스크가 도는 곳 |
|---|---|---|
| 로컬 | LocalExecutor(기본값) | 스케줄러 프로세스가 띄운 하위 프로세스 |
| 원격, 큐 방식 | CeleryExecutor, EdgeExecutor 등 | 큐에서 일을 가져가는 상주 워커 |
| 원격, 컨테이너 방식 | KubernetesExecutor, EcsExecutor | 태스크마다 새 Pod나 컨테이너 |

2.10부터는 executor를 여러 개 동시에 설정하고 태스크마다 고를 수 있습니다. 3.0에서 LocalKubernetesExecutor 같은 하이브리드 executor는 지원이 끝났습니다.

컨테이너 방식은 태스크마다 의존성을 격리할 수 있고 상주 워커를 관리하지 않아도 됩니다. 대신 태스크마다 Pod를 띄우는 시간이 붙습니다. 오늘의집 도입기가 Celery와 Kubernetes executor를 비교하며 짚은 단점이 이 기동 시간이고 짧은 태스크가 많을수록 커집니다. 이 비용은 Ch-07에서 따로 다룹니다.

### 3-3. 3.x에서 바뀐 것: 태스크가 메타DB에 직접 붙지 못한다

Airflow 2까지는 태스크 코드가 메타DB에 직접 연결했습니다. AIP-72(Task Execution Interface)로 3.0부터 이 연결이 막혔습니다. 태스크와 워커는 API 서버의 Execution API를 거쳐 상태를 보고하고 태스크는 `airflow.sdk` 네임스페이스의 Task SDK로 씁니다.

Airflow Summit 2025 세션 "Security made us do it"이 이유를 둘로 정리했습니다.

- 보안: 사용자가 쓴 태스크 코드가 Airflow의 원본 기록인 메타DB에 아무 쿼리나 날릴 수 있었습니다.
- 확장: 태스크마다 DB 연결을 하나씩 열어서 태스크가 늘면 DB 연결 수가 먼저 바닥났습니다.

그래서 3.x에서 태스크 정보가 필요하면 `get_current_context()`나 REST API를 씁니다. 메타DB에 직접 쿼리하던 커스텀 오퍼레이터는 고쳐야 합니다.

### 3-4. 스케줄러 두 대가 같은 태스크를 두 번 돌리지 않는 이유

스케줄러를 여러 대 띄우는 고가용성 구성에서는 두 스케줄러가 같은 태스크를 동시에 집을 수 있습니다. Airflow는 이걸 메타DB의 행 잠금으로 막습니다.

- 동시 실행 수와 pool 한도를 지키는 구간은 `SELECT ... FOR UPDATE`로 한 번에 한 스케줄러만 들어갑니다.
- 태스크를 집을 때는 `SKIP LOCKED`로 다른 스케줄러가 잠근 행을 건너뛰어 서로 다른 태스크를 동시에 가져갑니다.

그래서 이 잠금을 지원하는 PostgreSQL 12 이상, MySQL 8.0 이상에서만 여러 스케줄러를 쓸 수 있습니다. MariaDB는 10.6에서야 `SKIP LOCKED`를 넣었고 그 전에는 데드락이 보고됐습니다.

### 3-5. 실행 중인 태스크가 죽은 걸 알아채는 방식

태스크가 도는 동안 워커는 주기적으로 heartbeat를 보냅니다. 일정 시간 heartbeat가 끊기면 스케줄러가 그 태스크를 정리합니다. 재시도 횟수가 남았으면 재시도로, 아니면 실패로 바꿉니다. 예전에는 이런 태스크를 zombie task라고 불렀고 3.x 문서는 Task Instance Heartbeat Timeout이라고 부릅니다. 관련 설정은 `[scheduler] task_instance_heartbeat_timeout`(기준 시간), `task_instance_heartbeat_sec`(보내는 주기), `task_instance_heartbeat_timeout_detection_interval`(검사 주기)입니다.

OOM으로 프로세스가 죽었을 때, 쿠버네티스가 liveness probe 실패로 워커를 재시작했을 때, 노드 축소로 워커가 옮겨질 때 이 경로를 탑니다.

## 4. Argo Workflows의 부품과 상태 저장

### 4-1. 컨트롤러와 서버

Argo Workflows는 처음부터 쿠버네티스 위에서만 돌도록 만들어졌습니다.

| 부품 | 하는 일 |
|---|---|
| Workflow Controller | Workflow 리소스의 변화를 감시하고 원하는 상태에 맞춰 Pod를 만든다(reconcile). 혼자서도 돈다 |
| Argo Server | API와 UI를 제공한다 |

워크플로는 YAML로 쓰는 쿠버네티스 커스텀 리소스(CRD)입니다. 단계 하나나 DAG 태스크 하나가 Pod 하나가 되고 Pod 안에는 컨테이너가 셋 들어갑니다.

| 컨테이너 | 하는 일 |
|---|---|
| init | 입력 artifact와 파라미터를 가져온다 |
| main | 사용자 이미지. `argoexec`가 마운트되어 지정한 명령을 하위 프로세스로 실행한다 |
| wait | main이 끝나길 기다렸다가 출력 파라미터와 artifact를 저장한다 |

### 4-2. 상태가 etcd에 있다는 것

Airflow는 실행 상태를 자체 메타DB에 둡니다. Argo는 워크플로를 쿠버네티스 리소스로 etcd에 저장하고 단계별 상태도 그 리소스의 `status`에 들어갑니다.

여기서 제약이 생깁니다. 쿠버네티스 리소스 하나는 약 1MB를 넘을 수 없습니다. 단계가 아주 많은 워크플로는 노드 상태가 이 한도를 넘는데 그러면 Argo는 먼저 상태를 압축하고 그래도 크면 별도 SQL DB로 내보냅니다(offloading). 완료된 워크플로를 오래 보관하려면 Workflow Archive를 켜서 PostgreSQL이나 MySQL에 저장해야 합니다. 둘 다 켜지 않으면 상태는 etcd에만 있습니다.

| | Airflow 3 | Argo Workflows |
|---|---|---|
| 실행 상태 | 자체 메타DB(PostgreSQL 등) | 쿠버네티스 리소스(etcd) |
| 오래 보관 | 메타DB에 계속 쌓인다(정리 작업이 따로 필요) | Workflow Archive를 켜야 DB에 남는다 |
| 크기 제약 | DB 용량 | 리소스 하나 약 1MB, 넘으면 offloading |
| 정의 방식 | 파이썬 | YAML |

## 5. 태스크 사이에 데이터 대신 경로를 넘긴다

Airflow에서 태스크 사이에 값을 넘기는 장치가 XCom입니다. 기본 설정에서 XCom 값은 메타DB 테이블에 저장됩니다. 그래서 집계 결과 수백만 행을 XCom으로 넘기면 실행 상태를 담는 DB에 데이터가 쌓입니다. 메타DB는 스케줄러가 잠금과 조회를 계속 하는 곳입니다. 여기가 커지고 느려지면 그 DB를 쓰는 모든 DAG의 스케줄링이 함께 영향을 받습니다.

그래서 보통은 데이터를 객체 스토리지나 테이블에 쓰고 XCom에는 그 경로나 ID만 넘깁니다.

```python
@task
def extract_orders():
    # 데이터는 파일로 쓰고 경로만 돌려준다
    return "s3://bucket/orders/2026-10-01.parquet"
```

Argo도 같습니다. 출력 파라미터는 작은 문자열용이고 큰 결과는 artifact 저장소(S3 등)에 올린 뒤 다음 단계가 받아 갑니다. 4-2절의 1MB 제한을 생각하면 Argo 쪽이 더 엄격합니다.

## 6. 부품 하나가 죽으면

CKA 공부 글에서 "쿠버네티스 컨트롤러가 죽어도 이미 떠 있는 Pod는 계속 돈다"를 정리한 적이 있습니다. 오케스트레이터에도 같은 질문을 던져 볼 수 있습니다. 문서로 확인한 것과 확인하지 못한 것을 나눠 적습니다.

| 죽은 부품 | 이미 실행 중인 태스크 | 새 태스크 | 근거 |
|---|---|---|---|
| Airflow 스케줄러(LocalExecutor) | 스케줄러가 띄운 하위 프로세스라 영향을 받는다 | 시작되지 않는다 | executor가 스케줄러 프로세스 안에서 돈다(문서) |
| Airflow 스케줄러(Kubernetes·Celery executor) | 워커나 Pod는 계속 돈다 | 시작되지 않는다 | 실행 장소가 스케줄러 밖이다(문서) |
| Airflow 메타DB | 상태를 저장할 곳이 없다 | 시작되지 않는다 | 스케줄링 판단과 잠금이 전부 메타DB에 있다(문서) |
| Airflow API 서버 | 상태 보고가 막힌다. 그 뒤 어떻게 정리되는지는 확인하지 못했다 | UI와 API를 못 쓴다 | 3.x에서 태스크가 API로 보고한다(문서) |
| 워커 프로세스 | 죽는다 | 다른 워커가 가져간다 | heartbeat가 끊기면 재시도나 실패로 정리(3-5절) |
| Argo 컨트롤러 | Pod는 쿠버네티스가 계속 돌린다 | 다음 단계 Pod를 만들지 못한다 | 컨트롤러가 reconcile을 맡는다(문서) |

Argo 컨트롤러가 다시 살아나면 Workflow 리소스의 현재 상태를 보고 이어서 진행합니다. 쿠버네티스 컨트롤러가 살아난 뒤 원하는 상태와 현재 상태를 다시 비교하는 것과 같은 방식입니다.

## 7. 직접 돌려 볼 실습

쿠버네티스 없이 맥에서 `airflow standalone`으로 Airflow 3.2.2를 띄우고 절반 확률로 실패하는 태스크가 있는 쇼핑몰 일일 매출 DAG를 돌립니다. 코드와 설치 명령은 [labs/de-study/ch02](https://github.com/dj258255/IT-Oasis/tree/main/labs/de-study/ch02)에 있습니다.

```python
@dag(
    schedule="*/5 * * * *",
    start_date=datetime(2026, 1, 1),
    catchup=False,
    default_args={"retries": 2, "retry_delay": timedelta(seconds=10)},
)
def shop_daily_sales():
    @task
    def extract_orders():
        time.sleep(5)
        return "/tmp/orders.jsonl"          # 데이터 대신 경로만 넘긴다

    @task
    def clean(path):
        if random.random() < 0.5:
            raise RuntimeError("일시 오류 흉내")   # 절반은 실패해서 재시도를 탄다
        return path.replace("orders", "orders_clean")

    @task
    def daily_sales(path):
        time.sleep(60)                      # 실행 도중 끄기 실험용으로 길게
        print("집계 완료", path)

    daily_sales(clean(extract_orders()))
```

확인할 것은 셋입니다.

1. `clean`이 실패하면 10초 뒤 다시 시도하고 `task_instance` 테이블의 `try_number`가 올라가는지 봅니다.
2. `xcom` 테이블에 무엇이 들어 있는지 엽니다. 5절에서 말한 "경로만 넘긴다"가 실제로 어떤 행으로 남는지 볼 수 있습니다.
3. `daily_sales`가 도는 도중에 `airflow standalone`을 끄고 다시 켭니다. 끄기 전에 그 태스크가 어떤 상태가 될지 적어 두고 결과와 비교합니다. 6절 표의 첫 줄(LocalExecutor)과 3-5절의 heartbeat 정리 경로를 확인하는 실습입니다.

이 실습은 아직 직접 돌려 결과를 기록하지 않았습니다. 돌린 뒤 이 절에 결과를 채우겠습니다.

## 8. 중국과 국내 빅테크 사례

### 8-1. Airflow를 떠나 직접 만든 곳

| 회사 | 떠난 이유와 만든 것 |
|---|---|
| 快手(2022) | Airflow 단일 클러스터의 DAG가 1만 개 가까이 되자 태스크 하나의 스케줄링 지연 P99가 5분까지 올랐고 스케줄러에 HA가 없어 연간 장애가 약 8건(가용성 99.5%)이었습니다. 자체 엔진 Kwaiflow로 피크 지연 P99 5초 미만, 기동 속도 분당 십수만 건(Airflow는 분당 수천 건), 가용성 99.99%를 적었습니다 |
| 有赞(2021) | Airflow 1.7 + Celery 구성에서 스케줄러 HA를 Active/Standby로 붙였는데 프로세스가 살아 있는지만 봐서 교착으로 멈춘 스케줄러를 알아채지 못했습니다. Airflow 2.0 전에는 DAG 파싱이 한 곳에서만 돌아 스캔 지연이 60~70초까지 갔습니다. Apache DolphinScheduler로 옮겼습니다 |

두 사례가 짚은 것은 3-4절(스케줄러 여러 대)과 3-1절(DAG 프로세서)입니다. Airflow 2와 3은 스케줄러 HA와 별도 DAG 프로세서를 넣어 이 문제들을 풀었습니다. 1절의 Spotify처럼 규모가 커지면 오케스트레이터 자체의 한계가 먼저 드러납니다.

### 8-2. 직접 만든 스케줄러의 구조

| 회사 | 구조 |
|---|---|
| ByteDance FlowX(2023) | Master는 ZooKeeper로 주·예비를 나눕니다. 스케줄러가 재시작하면 DB에서 처리 중이던 태스크를 다시 읽어 이어 갑니다. 목표를 "빠뜨리지 않고 두 번 돌리지 않는 스케줄링"과 "초 단위 스케줄링 지연"으로 적었습니다 |
| Tencent US(2023) | 하루 수백만 태스크, 수천만 실행 인스턴스, 단일 DB에 3억 건 넘는 과거 인스턴스. 메타 저장소를 MySQL에서 분산 DB로 옮기고 오래된 데이터는 HBase에 둡니다. 5절에서 메타DB가 커지면 모든 DAG의 스케줄링이 영향을 받는다고 한 문제를 저장소를 바꿔 푼 경우입니다 |
| 京东 Buffalo(2024) | 수십만 태스크, 백만 개 넘는 의존 관계, 하루 백만 번 넘는 스케줄링. 인스턴스 데이터가 하루 백만 건 가까이 늘어서 핫·콜드 데이터를 나눕니다 |

### 8-3. 국내: 컬리의 Airflow 운영

컬리의 2024년 글 "서버리스에서 쿠버네티스로 - Airflow 운영 경험기"는 관리형 서비스에서 쿠버네티스 위 직접 운영으로 옮겨 고정 비용을 약 50% 줄였습니다. 옮긴 뒤 스케줄러 CPU가 운영 환경 0.25에서 0.45코어, 개발 환경 0.4에서 2.7코어로 늘어 DAG 파일을 다시 읽는 간격(`min_file_process_interval`)을 늘렸습니다. 3-1절의 DAG 프로세서가 DAG 파일을 주기적으로 파싱하는 비용이 숫자로 드러난 경우입니다.

## 9. 범위와 한계

- 3절과 4절은 Airflow 3.2, Argo Workflows 최신 문서 기준입니다. 버전이 바뀌면 부품 구성과 설정 이름이 달라질 수 있습니다.
- 6절 표의 API 서버 행은 상태 보고가 막힌 뒤 태스크가 어떻게 정리되는지 문서로 확인하지 못했습니다.
- heartbeat timeout의 기본값은 3.2 문서에 적혀 있지 않아서 숫자를 적지 않았습니다. `airflow config get-value scheduler task_instance_heartbeat_timeout`으로 직접 확인할 수 있습니다.
- Dagster처럼 태스크 대신 데이터 자산을 중심에 두는 오케스트레이터는 다루지 않았습니다. Airflow 3의 Asset은 Ch-05에서 다룹니다.

## 10. 헷갈렸던 것

**Q. 스케줄러와 executor가 따로 떠 있는 서비스인가요?**

3.2 문서 기준으로 executor는 스케줄러 프로세스 안에서 돕니다. executor가 하는 일은 태스크를 어디로 보낼지 정하는 것이고 실제로 태스크를 실행하는 곳은 executor 종류에 따라 하위 프로세스, 상주 워커, Pod로 나뉩니다.

**Q. 규모가 커지면 무엇이 먼저 문제가 되나요?**

Spotify가 오케스트레이터를 바꾼 글이 좋은 예입니다. 하루 2만 개 파이프라인, 저장소 1,000개 이상, 팀 300개 이상 규모에서 먼저 문제가 된 것은 운영이었습니다. Python과 Java로 같은 라이브러리를 두 벌 유지해야 했고 사용자들이 라이브러리 업그레이드를 따라오지 않았고 워크플로 내부가 블랙박스라 상류 의존성 누락을 실행한 뒤에야 알았습니다. 그래서 로직을 서버 쪽으로 옮긴 Flyte로 갔습니다. Netflix는 이전 오케스트레이터 Meson이 수직 확장만 돼서 AWS 인스턴스 상한에 닿은 것이 이유였습니다.

**Q. 오케스트레이터 자체가 죽으면 파이프라인 전체가 멈추지 않나요?**

멈춥니다. 쏘카의 두 번째 글이 이 문제를 다룹니다. 오케스트레이터는 배치 파이프라인 전체의 단일 장애점이 됩니다. 그래서 스케줄러를 여러 대 두고(3-4절), 메타DB를 이중화하고 오케스트레이터 자체를 감시하는 구성이 따로 필요합니다.

## 참고 자료

공식 문서
- [Airflow 3.2 Architecture Overview](https://airflow.apache.org/docs/apache-airflow/3.2.0/core-concepts/overview.html)
- [Airflow 3.2 Executor](https://airflow.apache.org/docs/apache-airflow/3.2.2/core-concepts/executor/index.html)
- [Airflow 3.2 Scheduler](https://airflow.apache.org/docs/apache-airflow/3.2.2/administration-and-deployment/scheduler.html)
- [Airflow 3.2 Tasks](https://airflow.apache.org/docs/apache-airflow/3.2.0/core-concepts/tasks.html)
- [AIP-72 Task Execution Interface aka Task SDK](https://cwiki.apache.org/confluence/spaces/AIRFLOW/pages/311626182/AIP-72+Task+Execution+Interface+aka+Task+SDK)
- [Airflow Summit 2025, Security made us do it: Airflow's new task execution architecture](https://airflowsummit.org/sessions/2025/security-made-us-do-it-airflows-new-task-execution-architecture/)
- [Airflow Summit 2021 스케줄러 발표 자료](https://airflowsummit.org/slides/2021/d2-Scheduler.pdf)
- [Argo Workflows Architecture](https://argo-workflows.readthedocs.io/en/latest/architecture/)
- [Argo Workflows Offloading Large Workflows](https://argo-workflows.readthedocs.io/en/latest/offloading-large-workflows/)
- [Argo Workflows Workflow Archive](https://argo-workflows.readthedocs.io/en/latest/workflow-archive/)

기술블로그
- [Spotify, Why We Switched Our Data Orchestration Service](https://engineering.atspotify.com/2022/03/why-we-switched-our-data-orchestration-service) (2022)
- [The New Stack, Netflix Open Sources Maestro](https://thenewstack.io/netflix-open-sources-maestro-a-next-gen-data-workflow-engine/) (2024)
- [Uber, Managing Uber's Data Workflows at Scale](https://eng.uber.com/managing-data-workflows-at-scale) (2019)
- [오늘의집, 버킷플레이스 Airflow 도입기](https://www.bucketplace.com/post/2021-04-13-%EB%B2%84%ED%82%B7%ED%94%8C%EB%A0%88%EC%9D%B4%EC%8A%A4-airflow-%EB%8F%84%EC%9E%85%EA%B8%B0/) (2021)
- [쏘카, Airflow와 함께한 데이터 환경 구축기](https://tech.socar.kr/data/2021/06/01/data-engineering-with-airflow) (2021)
- [쏘카, 전사 구성원들이 사용하는 배치 데이터 플랫폼 만들기](https://tech.socarcorp.kr/data/2022/11/09/advanced-airflow-for-databiz.html) (2022)
- [Wikipedia, Apache Airflow](https://en.wikipedia.org/wiki/Apache_Airflow)

이 시리즈
- [CKA Ch-01 쿠버네티스는 왜 필요한가](/blog/cert/cka/cka-01-why-kubernetes)
- 실습 코드: [labs/de-study/ch02](https://github.com/dj258255/IT-Oasis/tree/main/labs/de-study/ch02)

중국과 국내 빅테크 사례
- 张蕤(快手), [快手大数据任务调度系统设计与实践](https://www.tonguebusy.com/a/tuiguang/weixintuiguang/1107.html), DataFunTalk 재게시, 2022
- Zheqi Song(有赞), [From Airflow to Apache DolphinScheduler, the Roadmap of Scheduling System On Youzan Big Data Development Platform](https://github.com/apache/dolphinscheduler-website/blob/master/blog/en-us/YouZan-case-study.md)
- 火山引擎数智平台(ByteDance), [火山引擎DataLeap背后的支持者 - 工作流编排调度系统FlowX](https://developer.volcengine.com/articles/7293813926247170111), 2023
- 马朋勃(Tencent), [腾讯大数据分布式任务调度平台——US](https://www.modb.pro/db/647438), DataFun 재게시, 2023
- 京东, [京东百万级调度系统(Buffalo)架构解密](https://developer.jdcloud.com/article/3944), 2024
- 김영준, [서버리스에서 쿠버네티스로 - Airflow 운영 경험기](https://helloworld.kurly.com/blog/airflow-1/), 컬리, 2024

---
title: '[DE Ch-06] 동시성 제한, 중복 실행, 사람 승인: 오케스트레이터가 막아 주는 것과 맡겨 두는 것'
description: Airflow는 동시 실행을 스케줄러, DAG, run, 태스크, pool 다섯 층에서 제한합니다. 그런데 max_active_runs=1은 겹침을 막을 뿐 같은 일이 두 번 도는 것은 막지 않습니다. pool로 외부 API를 보호하는 효과와 이벤트 키로 run_id를 정하는 방법을 시뮬레이션으로 확인하고 오케스트레이터의 락이 왜 최종 방어선이 될 수 없는지 분산 락 이론으로 정리합니다. 사람 승인 단계는 Airflow 3.2와 3.3, Argo suspend를 비교합니다.
date: 2026-10-19T00:00:00.000Z
tags:
  - Data Engineering
  - Workflow Orchestration
  - Airflow
  - Argo Workflows
  - Concurrency
  - Pool
  - Human-in-the-loop
  - Distributed Lock
category: data/Orchestration
topics:
  - pipeline
  - distributed
draft: false
series: "DE 공부"
seriesOrder: 6
---

## 결론부터

1. Airflow 3.2의 동시성 제한은 다섯 층입니다. 스케줄러당 `parallelism`(기본 32), DAG run당 `max_active_tasks`(기본 16), DAG당 `max_active_runs`(기본 16), 태스크 단위 `max_active_tis_per_dag`, 그리고 자원 단위 pool(기본 128슬롯)입니다.
2. pool은 외부 시스템을 보호하는 장치입니다. 동시 5건까지만 받는 API를 가정한 시뮬레이션에서 pool 없이 50개를 한꺼번에 보내면 429 응답이 225건 나고 19초가 걸렸습니다. pool을 5로 두니 429 없이 10초에 끝났습니다.
3. `max_active_runs=1`은 run이 겹치지 않게 할 뿐 같은 일이 여러 번 도는 것은 막지 않습니다. 같은 이벤트가 세 번 오면 세 번 차례로 돕니다. 한 번만 돌게 하려면 이벤트 키로 run_id를 정해서 같은 키의 두 번째 생성을 실패시킵니다.
4. 오케스트레이터의 동시성 제한은 깨질 수 있습니다. HA 스케줄러 두 대에서 `max_active_runs=1`인 DAG의 run 두 개가 0.2초 차이로 시작된 이슈가 보고됐고 고치지 않기로 닫혔습니다. 정합성의 마지막 방어선은 태스크의 멱등성입니다.
5. 사람 승인 단계는 Airflow 3.1의 HITL 오퍼레이터와 Argo의 suspend로 만듭니다. Airflow 3.2의 HITL은 deferred 상태로 triggerer에서 기다리고 3.3부터는 워커도 triggerer도 쓰지 않는 `awaiting_input` 상태로 기다립니다. Argo suspend에 `duration`을 주면 시간이 지났을 때 승인 없이 자동으로 진행합니다.

---

## 1. 동시에 너무 많이, 같은 일을 두 번, 사람을 기다리며

Ch-05에서 이벤트로 DAG를 시작하면 이벤트가 몰리거나 두 번 올 수 있다고 했습니다. 오케스트레이터가 이때 맡는 일은 셋으로 나뉩니다.

| 문제 | 예 | 오케스트레이터의 장치 |
|---|---|---|
| 동시에 너무 많이 | 백필 300일치가 한꺼번에 돌며 DB를 두드린다 | 동시 실행 상한, pool |
| 같은 일을 두 번 | 같은 이벤트가 두 번 와서 같은 날 집계가 두 번 돈다 | run_id 유일성, 락 |
| 사람을 기다림 | 대량 삭제 전에 담당자 확인을 받는다 | 승인 대기 상태 |

## 2. Airflow의 다섯 층 동시성 제한

3.2.0 설정 문서 기준 기본값입니다.

| 층 | 설정 | 기본값 | 범위 |
|---|---|---|---|
| 스케줄러 | `[core] parallelism` | 32 | 스케줄러 한 대가 동시에 돌리는 태스크 수. 워커 수와 무관하다 |
| DAG run | `max_active_tasks`(전역 기본 `[core] max_active_tasks_per_dag`) | 16 | Airflow 3부터 run 하나 안에서 동시에 도는 태스크 수 |
| DAG | `max_active_runs`(전역 기본 `[core] max_active_runs_per_dag`) | 16 | DAG 하나의 동시 run 수. 한도에 닿으면 스케줄러가 새 run을 만들지 않는다 |
| 태스크 | `max_active_tis_per_dag`, `max_active_tis_per_dagrun` | 문서에서 기본값을 확인하지 못함 | 같은 태스크가 여러 run에 걸쳐(또는 run 하나 안에서) 동시에 도는 수 |
| 자원 | pool | `default_pool` 128슬롯 | 여러 DAG에 걸쳐 같은 자원을 쓰는 태스크의 합 |

앞의 네 층은 DAG와 태스크의 구조로 제한합니다. pool은 그 태스크가 쓰는 자원으로 제한합니다. "주문 DB를 읽는 태스크는 어느 DAG에서 왔든 합쳐서 5개까지"처럼 DAG 경계를 넘는 제한은 pool로만 걸 수 있습니다.

pool에서 슬롯이 비면 `priority_weight`가 높은 태스크부터 들어갑니다. 기본 `weight_rule`은 downstream이라 하류 태스크가 많은 태스크일수록 가중치가 커집니다. Shopify는 이 규칙 때문에 큰 DAG의 상류 태스크가 계속 유리해지는 문제를 겪었다고 썼습니다.

### 2-1. 재현: pool로 외부 API 보호하기

- 외부 API를 부르는 태스크 50개가 있습니다.
- API는 동시 5건까지 1초에 처리하고 넘친 요청에는 429를 돌려준다고 가정합니다. 429를 받은 태스크는 2초 뒤 다시 시도합니다.
- 1초 단위로 진행하는 시뮬레이션이라 결과가 항상 같습니다. 코드는 [labs/de-study/ch06](https://github.com/dj258255/IT-Oasis/tree/main/labs/de-study/ch06)의 `pool_limit.py`입니다.

| pool 크기 | 걸린 시간 | API 호출 | 429 |
|---|---|---|---|
| 50 | 19초 | 275회 | 225회 |
| 20 | 13초 | 125회 | 75회 |
| 10 | 11초 | 75회 | 25회 |
| 5 | 10초 | 50회 | 0회 |

동시에 많이 보낼수록 빨리 끝날 것 같지만 결과는 반대입니다. API가 받을 수 있는 수를 넘긴 요청은 거절당하고 재시도 대기를 하면서 전체 시간만 늘립니다. 상대가 받아 주는 동시 수에 pool을 맞추면 호출 수가 태스크 수와 같아지고 시간도 가장 짧습니다.

이 결과는 가정한 API 모델에서 나온 것입니다. 실제 API는 한도를 넘기면 거절하는 대신 느려지기도 하고 한도가 동시 수가 아니라 초당 요청 수일 수도 있습니다. 상대의 한도 방식을 먼저 알아야 pool 크기를 정할 수 있습니다.

### 2-2. 사례: Shopify의 pool 운영

Shopify는 2022년 글에서 DAG 1만 개 이상, 하루 15만 run 이상 규모의 운영 경험을 정리했습니다.

- UI에서 pool을 고칠 수 있는 사람이 관리자뿐이어서 pool 설정을 ConfigMap으로 관리하고 동기화 DAG로 반영했습니다. 변경은 PR 리뷰를 거칩니다.
- DAG policy로 팀별 pool 사용을 강제했습니다.
- 매시 정각과 자정에 실행이 몰려 스케줄러와 Trino가 과부하됐습니다. dag_id 해시로 실행 시각을 결정적으로 흩어서 부하를 나눴습니다.

세 번째는 Ch-03의 지터와 같은 발상입니다. 모두 같은 시각에 시작하면 몰리니 시작 시각을 흩습니다. 해시로 정해서 같은 DAG는 항상 같은 시각에 돕니다.

## 3. max_active_runs=1이 막는 것은 겹침이다

### 3-1. 재현: 같은 이벤트가 세 번 오면

- 같은 이벤트(`orders-2026-10-01`)가 0초, 1초, 7초에 세 번 전달됩니다. at-least-once 전달에서 생길 수 있는 일입니다.
- 코드는 같은 폴더의 `duplicate_trigger.py`입니다.

| 장치 | 도는 run 수 | 이유 |
|---|---|---|
| 없음 | 3번 | run마다 새 run_id |
| `max_active_runs=1` | 3번 | 겹치지 않게 차례로 돌 뿐 세 번 다 돈다 |
| 이벤트 키로 run_id | 1번 | 같은 이벤트는 같은 run_id라 두 번째부터 만들어지지 않는다 |

`max_active_runs=1`은 동시에 도는 run을 하나로 줄입니다. 나머지 run은 줄을 서서 기다렸다가 앞 run이 끝나면 돕니다. 같은 일을 한 번만 하게 하려면 "같은 일"을 알아볼 키가 있어야 합니다.

Airflow 3.2의 REST API로 DAG를 트리거할 때 run_id를 직접 줄 수 있습니다. 같은 DAG에 이미 있는 run_id로 다시 요청하면 DB의 유일성 제약에 걸리고 API는 이를 409 Conflict로 돌려줍니다(3.2.0 소스의 예외 처리기로 확인). 이벤트 ID로 run_id를 만들면 중복 이벤트는 409로 끝납니다.

### 3-2. 오케스트레이터의 제한이 깨지는 경우

공식 저장소에 보고된 이슈 두 건이 있습니다.

- [#45388](https://github.com/apache/airflow/issues/45388): Airflow 2.10.4에서 스케줄러 두 대로 HA를 구성했는데 `max_active_runs=1`인 DAG의 run 두 개가 0.2초 차이로 시작됐습니다. 메인테이너는 드물지만 가능한 경계 사례라고 답했고 막으려면 DAG 단위 락이 필요한데 그러면 병렬성이 떨어진다며 고치지 않기로(not planned) 닫았습니다.
- [#56050](https://github.com/apache/airflow/issues/56050): `max_active_runs=1`인 asset 스케줄 DAG에서 asset 이벤트 일부가 무시됩니다. 3.0.6에서 보고됐고 3.3.2에서도 재현된다는 댓글이 있으며 메인테이너가 재설계가 필요하다고 한 상태로 열려 있습니다.

두 이슈는 오케스트레이터의 동시성 제한이 "대체로 지켜지는" 장치라는 걸 보여 줍니다. 정합성이 걸린 일을 이 제한에만 맡기면 드문 경계 사례에서 깨집니다.

## 4. 분산 락은 두 종류다

Martin Kleppmann은 2016년 글 "How to do distributed locking"에서 락을 쓰는 목적을 둘로 나눕니다.

| 목적 | 락이 깨지면 | 예 | 권하는 방법 |
|---|---|---|---|
| 효율(efficiency) | 같은 일을 두 번 해서 비용이 든다 | 같은 알림 메일이 두 번 간다 | 단일 Redis 같은 가벼운 락으로 충분하다 |
| 정합성(correctness) | 데이터가 깨진다 | 같은 계좌에 두 번 출금된다 | 합의 시스템(ZooKeeper 등)과 fencing token |

정합성 락이 어려운 이유는 프로세스가 멈출 수 있어서입니다. 락을 잡은 프로세스가 GC 같은 이유로 멈춘 사이에 락 기간이 끝나면, 다른 프로세스가 락을 잡고 씁니다. 멈췄던 프로세스는 깨어나서 자기가 아직 락을 가졌다고 믿고 씁니다. 쓰기 직전에 락을 확인해도 확인과 쓰기 사이에 멈추면 소용없습니다.

fencing token은 이 문제를 쓰는 쪽에서 막습니다. 락을 잡을 때마다 1씩 커지는 번호를 받고 저장소는 이미 34번 토큰으로 쓴 뒤라면 33번 토큰의 쓰기를 거부합니다.

오케스트레이터의 동시성 제한은 효율 락에 가깝습니다. 3-2절처럼 깨질 수 있고 Argo의 DB 기반 락도 컨트롤러가 응답하지 않을 때 이미 잡은 락은 다른 Workflow가 가져가지 않아 사람이 풀어야 합니다(4-1절). 그래서 오케스트레이터 락으로 "웬만하면 한 번"을 만들고 "두 번 돌아도 결과가 같다"는 태스크의 멱등성(Ch-03)으로 정합성을 지킵니다.

### 4-1. Argo Workflows의 동시성 장치

| 장치 | 범위 | 문서에서 확인한 것 |
|---|---|---|
| `parallelism`(Workflow) | Workflow 하나 안에서 동시에 도는 Pod 수 | |
| `parallelism`(template) | 그 템플릿 호출 안의 Pod 수 | 그 안에서 부른 다른 템플릿의 Pod는 세지 않는다 |
| 컨트롤러 `parallelism`, `namespaceParallelism` | 클러스터, 네임스페이스 전체 Workflow 수 | 대기 중인 Workflow는 `spec.priority` 순으로 시작한다 |
| mutex | 동시 1개 | Workflow 단위나 템플릿 단위로 건다 |
| semaphore | 동시 N개 | ConfigMap의 값으로 N을 정한다 |
| DB 기반 mutex·semaphore | 컨트롤러 여러 대가 공유 | 3.7에서 도입. PostgreSQL, MySQL. heartbeat 기본 60초, 300초 응답이 없으면 inactive. 그 컨트롤러가 이미 잡은 락은 수동으로 풀어야 한다 |

락을 기다리는 Workflow는 priority가 높은 순, 같으면 먼저 만들어진 순으로 줄을 섭니다. 락 여러 개가 필요한 Workflow가 줄 맨 앞에 있으면 전부 얻을 때까지 기다리면서 뒤의 Workflow까지 막을 수 있습니다.

## 5. 사람 승인 단계

### 5-1. Airflow HITL (3.1 도입)

3.1에서 standard provider에 사람 승인용 오퍼레이터 네 가지가 들어왔습니다.

| 오퍼레이터 | 하는 일 |
|---|---|
| `HITLOperator` | 기본형. 선택지(options)를 보여 주고 고르게 한다. `multiple=True`면 여러 개 |
| `ApprovalOperator` | 승인과 거절 둘 중 하나 |
| `HITLBranchOperator` | 고른 선택지가 다음에 돌 태스크 ID가 된다 |
| `HITLEntryOperator` | 폼에 값을 입력받는다 |

UI의 태스크 화면 "Required Actions"에서 응답하고 `assigned_users`를 주면 그 사람들만 응답할 수 있습니다. 응답은 메타DB의 `hitl_detail` 테이블에 누가(`responded_by`), 언제(`responded_at`), 무엇을(`chosen_options`) 골랐는지로 남고 다음 태스크는 XCom으로 결과를 읽습니다.

3.2.0 소스로 확인한 동작은 이렇습니다.

- 태스크는 요청을 기록한 뒤 `HITLTrigger`로 defer합니다. 기다리는 동안 워커는 놓고 triggerer가 5초마다 응답을 확인합니다.
- 기다리는 시간의 상한은 `execution_timeout`입니다. 없으면 무기한 기다립니다.
- 시간이 지났을 때 `defaults`가 있으면 그 선택지로 응답한 것으로 기록하고(`responded_by` 없음) 진행합니다. 없으면 `HITLTimeoutError`로 실패합니다.
- `ApprovalOperator`에서 거절하면 태스크는 성공이고 하류 태스크가 skip됩니다. `fail_on_reject=True`로 실패시킬 수도 있지만 소스의 설명은 사람의 결정과 태스크 상태를 섞는 일이라며 권하지 않습니다.

3.3에서는 기다리는 방식이 바뀌었습니다. 스케줄러가 관리하는 `awaiting_input` 상태를 새로 두고 이 상태에서는 워커 슬롯도 triggerer도 pool 슬롯도 쓰지 않습니다. 시간 초과와 기본 선택지 적용도 스케줄러가 맡습니다. 3.2에서 승인 대기가 많으면 triggerer 용량(기본 1,000)과 pool 계산에 들어가니, 버전에 따라 운영 부담이 다릅니다.

### 5-2. Argo suspend

Argo는 `suspend` 템플릿으로 Workflow를 멈추고 `argo resume`으로 재개합니다.

```yaml
- name: approve
  suspend: {}                       # resume할 때까지 멈춘다
  inputs:
    parameters:
      - name: approve
        default: 'NO'
        enum: ['YES', 'NO']        # UI에 드롭다운으로 나온다
  outputs:
    parameters:
      - name: approve
        valueFrom:
          supplied: {}              # 사람이 resume하면서 값을 넣는다
```

다음 단계는 `{{steps.approve.outputs.parameters.approve}}`로 분기합니다. `argo resume`은 `--node-field-selector`로 특정 노드만 골라 재개할 수 있습니다.

`suspend`에 `duration: "6h"`를 주면 6시간 뒤 자동으로 재개합니다. 이때는 사람이 값을 넣지 않았으니 승인 없이 진행하는 셈입니다. "시간이 지나면 거절"로 만들려면 기본값을 `NO`로 두고 다음 단계가 그 값을 보고 멈추게 따로 설계해야 합니다. 이 부분은 문서가 직접 적은 내용이 아니고 문서의 동작에서 나온 해석입니다.

### 5-3. 두 도구 비교

| | Airflow 3.2 HITL | Airflow 3.3 HITL | Argo suspend |
|---|---|---|---|
| 기다리는 곳 | triggerer(deferred) | 스케줄러(`awaiting_input`) | Workflow 노드 상태 |
| 시간 초과 | `execution_timeout`, 기본 선택지 있으면 그걸로 진행 | `response_timeout`, 스케줄러가 처리 | `duration`이 지나면 자동 재개 |
| 누가 응답했는지 | `hitl_detail.responded_by` | 같음 | 이번에 확인하지 못함 |
| 응답 방법 | UI Required Actions | UI, HITL REST API | `argo resume`, UI |

## 6. 중국과 국내 빅테크 사례

### 6-1. 자원별 할당량과 우선순위

- **Tencent US**(2023): 실행기, YARN 큐, Hive, HDFS를 각각 할당량이 있는 자원으로 보고 동시 실행을 제어합니다. 2절의 pool을 자원 종류마다 둔 형태입니다.
- **ByteDance FlowX**(2023): 할당량(Quota)을 여러 지표, 정방향과 역방향 매칭, 시간 구간 제한으로 걸어 동시성을 제한합니다.
- **Alibaba DataWorks**(2023): 30초마다 현재 자원 상황을 보고 우선순위 높은 태스크(기준선에 걸린 사슬)에 자원을 몰아 줍니다. 하루 천만 단위의 스케줄링 인스턴스를 다루는 규모입니다.
- **京东 Buffalo**(2024): 해시 샤딩으로 부하를 나누고 각 서비스가 실행 배치 번호와 상태로 멱등하게 처리해 태스크 실행의 유일성을 지킵니다. 리소스 스케줄링은 주·예비 구조이고 분산 락을 피하려고 정보를 메모리에 둡니다. 4절에서 본 "락으로 웬만하면 한 번, 멱등성으로 정합성"과 같은 구성입니다.

### 6-2. 컬리: 동시 실행 상한이 만든 대기

컬리의 2024년 Airflow 운영기는 태스크가 scheduled 상태에 오래 머문 원인이 워커에 동시에 할당할 수 있는 태스크 수가 상한에 다가간 것이었다고 적었습니다. `worker_concurrency`를 올리는 대신 워커를 하나 더 늘렸습니다. 2절의 다섯 층 말고도 실행하는 쪽(워커)에 상한이 하나 더 있다는 예입니다.

### 6-3. 카카오뱅크: 규제가 요구하는 승인

카카오뱅크의 2024년 펀드 배치 글은 전자금융감독규정 제30조("일괄작업은 작업요청서에 의한 책임자의 승인을 받은 후 수행할 것")를 감사 로그로 대응했습니다. 제26조의 직무 분리는 DAG 태그에 따라 클러스터 정책이 접근 권한을 자동으로 붙이는 방식으로 처리했습니다. 5절의 승인 단계가 기술 선택이 아니라 규제 요건으로 들어오는 경우이고 그래서 5-1절의 "누가 언제 무엇을 골랐는지" 기록이 중요해집니다.

## 7. 범위와 한계

- 2-1절과 3-1절은 시뮬레이션입니다. 실제 Airflow pool이나 Argo semaphore를 띄워 재지 않았습니다.
- `max_active_tis_per_dag`, `max_active_tis_per_dagrun`의 기본값과 pool의 `include_deferred` 기본값은 문서에서 확인하지 못했습니다.
- 3-1절의 409 응답은 3.2.0 소스의 예외 처리기로 확인했고 dag_run 테이블의 유일성 제약 이름은 직접 보지 못했습니다.
- Argo suspend에서 누가 resume했는지가 기록되는 방식은 확인하지 못했습니다.
- HITL이나 Argo 승인 단계를 실제로 도입한 회사의 후기는 찾지 못했습니다.

## 8. 헷갈렸던 것

**Q. parallelism을 올리면 그만큼 빨라지나요?**

스케줄러 쪽 상한이 풀릴 뿐입니다. 그 아래 DAG, run, pool 제한이 그대로면 실제 동시 실행 수는 가장 좁은 층이 정합니다. 2-1절처럼 상대 시스템이 못 받는 만큼 보내면 오히려 느려집니다.

**Q. 이벤트 키로 run_id를 정하면 재처리는 어떻게 하나요?**

같은 run_id로는 새 run을 만들 수 없으니 기존 run을 지우고 다시 만들거나, 그 run의 태스크를 지우고(clear) 다시 돌립니다. 재처리 자체가 같은 결과를 내려면 Ch-03의 멱등성이 필요합니다.

**Q. 거절했는데 태스크가 성공으로 나오면 헷갈리지 않나요?**

Airflow는 의도적으로 그렇게 설계했습니다. 사람이 거절한 것은 시스템이 실패한 것과 다른 사건이라 태스크 상태는 성공으로 두고 거절이라는 결정은 `hitl_detail`과 하류 skip으로 남깁니다. 실패 알림이 거절 때마다 울리면 진짜 실패를 구분하기 어렵기 때문입니다.

## 참고 자료

공식 문서와 소스
- [Airflow 3.2.0 Configuration Reference](https://airflow.apache.org/docs/apache-airflow/3.2.0/configurations-ref.html)
- [Airflow Pools](https://airflow.apache.org/docs/apache-airflow/stable/administration-and-deployment/pools.html), [Priority Weights](https://airflow.apache.org/docs/apache-airflow/stable/administration-and-deployment/priority-weight.html)
- [Airflow 3.2.0 HITL 튜토리얼](https://airflow.apache.org/docs/apache-airflow/3.2.0/tutorial/hitl.html), [3.3.2 HITL 튜토리얼](https://airflow.apache.org/docs/apache-airflow/3.3.2/tutorial/hitl.html)
- [Airflow 3.1.0 발표](https://airflow.apache.org/blog/airflow-3.1.0/)
- [Airflow 3.2.0 HITL 오퍼레이터 소스](https://raw.githubusercontent.com/apache/airflow/3.2.0/providers/standard/src/airflow/providers/standard/operators/hitl.py)
- [Argo Workflows Synchronization](https://argo-workflows.readthedocs.io/en/latest/synchronization/), [Parallelism](https://argo-workflows.readthedocs.io/en/latest/parallelism/)
- [Argo Workflows Suspending](https://argo-workflows.readthedocs.io/en/latest/walk-through/suspending/), [Intermediate Parameters](https://argo-workflows.readthedocs.io/en/latest/intermediate-inputs/), [argo resume](https://argo-workflows.readthedocs.io/en/latest/cli/argo_resume/)

이론과 사례
- Martin Kleppmann, [How to do distributed locking](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html), 2016
- Shopify, [Lessons Learned From Running Apache Airflow at Scale](https://shopify.engineering/lessons-learned-apache-airflow-scale), 2022
- Apache Airflow 이슈 [#45388](https://github.com/apache/airflow/issues/45388), [#56050](https://github.com/apache/airflow/issues/56050)

이 시리즈
- 실습 코드: [labs/de-study/ch06](https://github.com/dj258255/IT-Oasis/tree/main/labs/de-study/ch06)

중국과 국내 빅테크 사례
- 马朋勃(Tencent), [腾讯大数据分布式任务调度平台——US](https://www.modb.pro/db/647438), DataFun 재게시, 2023
- 火山引擎数智平台(ByteDance), [火山引擎DataLeap背后的支持者 - 工作流编排调度系统FlowX](https://developer.volcengine.com/articles/7293813926247170111), 2023
- 冉秋萍(Alibaba), [阿里巴巴数据稳定性治理实践](https://hub.baai.ac.cn/view/31355), DataFunTalk 재게시, 2023
- 京东, [京东百万级调度系统(Buffalo)架构解密](https://developer.jdcloud.com/article/3944), 2024
- 김영준, [서버리스에서 쿠버네티스로 - Airflow 운영 경험기](https://helloworld.kurly.com/blog/airflow-1/), 컬리, 2024
- Sean(마승현), [Airflow로 펀드 배치 시스템 완벽 구축하기](https://tech.kakaobank.com/posts/2412-financial-batch-system-with-airflow/), 카카오뱅크, 2024

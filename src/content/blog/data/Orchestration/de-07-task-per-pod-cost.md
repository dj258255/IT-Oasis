---
title: '[DE] 태스크 하나가 Pod 하나가 될 때: 기동 시간을 구간으로 나누기'
description: KubernetesExecutor와 Argo Workflows는 태스크마다 Pod를 띄웁니다. 쿠버네티스의 공식 Pod 기동 SLO는 p99 5초인데, 이 숫자는 이미지 pull과 init 컨테이너를 뺀 값입니다. Pod가 생성되어 컨테이너가 시작하기까지를 condition, 이벤트, kubelet 메트릭으로 나누는 방법과, 이미지 pull, Pod 생성 호출, init 컨테이너가 각각 어디서 시간을 쓰는지, 짧은 태스크가 많을 때의 대안을 정리합니다.
date: 2026-10-19T00:00:00.000Z
tags:
  - Data Engineering
  - Kubernetes
  - Pod Startup Latency
  - Airflow
  - KubernetesExecutor
  - Argo Workflows
  - Image Pull
category: data/Orchestration
topics:
  - pipeline
  - performance
draft: false
unlisted: true
series: "DE 공부"
seriesOrder: 8
---

## 결론부터

1. Pod 하나가 컨테이너를 시작하기까지는 스케줄링, 샌드박스와 네트워크 준비, 이미지 pull, init 컨테이너, 컨테이너 시작 순으로 갑니다. condition의 `lastTransitionTime`과 kubelet 이벤트, kubelet 메트릭으로 이 구간을 나눠 볼 수 있습니다.
2. 쿠버네티스 공식 SLO(p99 5초 이하)는 이미지 pull과 init 컨테이너를 뺀 숫자입니다. 배치 태스크가 실제로 기다리는 시간은 이 둘을 더한 값입니다.
3. kubelet은 기본적으로 이미지를 하나씩 순서대로 받고 한 Pod 안의 이미지는 병렬 pull을 켜도 동시에 받지 않습니다. 이미지가 크면 lazy pulling(SOCI, eStargz, GKE Image streaming)으로 시작에 필요한 부분만 먼저 받을 수 있습니다.
4. Airflow KubernetesExecutor는 스케줄러 루프마다 Pod 생성 API를 기본 1건씩 순서대로 부릅니다. KubernetesPodOperator를 이 executor 위에서 쓰면 워커 Pod가 다시 Pod를 띄워서 기동 비용을 두 번 냅니다.
5. Argo는 단계마다 init, wait, main 컨테이너 셋을 띄웁니다. 문서 기준으로 init 컨테이너는 모든 Pod에 기동 지연을 더하고 대안으로는 한 Pod에 여러 컨테이너를 넣는 container set과 v4.1의 init-less Pod(beta)가 있습니다.

---

## 1. 1초짜리 태스크에 몇 초가 붙나

3편에서 executor를 고르는 것은 태스크를 어디서 돌릴지 고르는 일이라고 했습니다. 컨테이너 방식(KubernetesExecutor, Argo)은 태스크마다 의존성을 격리하고 상주 워커를 관리하지 않아도 됩니다. 그 대가는 Airflow 3.2 executor 문서에 이렇게 나옵니다. 태스크를 시작하기 전에 컨테이너나 Pod가 떠야 해서 기동 지연이 있다. 상주 워커를 쓰는 큐 방식 executor는 이 지연이 비교적 낮다.

태스크가 30분짜리라면 몇 초는 문제가 되지 않습니다. 태스크가 1~2초짜리이고 수백 개라면 기동 시간이 실행 시간보다 커집니다. 얼마나 붙는지 알려면 먼저 그 시간이 어디서 쓰이는지 나눠야 합니다.

이 글에 계속 나오는 쿠버네티스 용어를 먼저 정리해 둡니다. 자세한 설명은 CKA 시리즈에 있습니다.

| 용어 | 이 글에서 필요한 만큼의 뜻 |
|---|---|
| Pod | 쿠버네티스가 컨테이너를 띄우는 단위. 컨테이너 하나 이상과 그들이 같이 쓰는 네트워크를 묶은 것 |
| kubelet | 노드마다 하나씩 도는 에이전트. 자기 노드에 배정된 Pod를 보고 이미지를 받고 컨테이너를 띄운다 |
| 샌드박스 | Pod의 컨테이너들이 같이 쓸 네트워크 공간. 컨테이너보다 먼저 만들어지고 여기에 Pod IP가 붙는다 |
| 이미지와 레이어 | 이미지는 여러 레이어(파일 묶음)를 쌓은 것. 노드에 없는 레이어만 레지스트리에서 받는다 |
| init 컨테이너 | 본 컨테이너보다 먼저 차례로 돌고 끝나야 하는 준비용 컨테이너 |

([CKA 4편](/blog/cert/cka/cka-01b-core-objects-and-flow), [k8s-linux 3편](/blog/theory/systems/k8s-linux-02-namespaces-pause))

## 2. Pod가 컨테이너를 시작하기까지

### 2-1. 구간과 관측 지점

```
Pod 생성 ─→ 스케줄링 ─→ 샌드박스·네트워크·볼륨 ─→ 이미지 pull ─→ init 컨테이너 ─→ 컨테이너 시작
   │           │                 │                    │               │               │
creation-   PodScheduled   PodReadyToStart-      Pulling/Pulled   Initialized    containerStatuses
Timestamp                   Containers            이벤트                          [].state.startedAt
```

| 시점 | 어디서 보나 | 쿠버네티스 문서의 정의 |
|---|---|---|
| Pod 생성 | `metadata.creationTimestamp` | |
| 스케줄링 끝 | condition `PodScheduled` | Pod가 노드에 배정됐다 |
| 샌드박스 준비 끝 | condition `PodReadyToStartContainers` | 샌드박스가 만들어지고 네트워크와 볼륨이 준비됐다. 이미지 pull과 컨테이너 생성은 이 뒤에 일어난다. v1.37에서 stable, 처음 이름은 `PodHasNetwork` |
| 이미지 pull | 이벤트 `Pulling`, `Pulled` | `Pulled` 메시지에 실제 pull 시간과 대기 포함 시간, 이미지 크기가 찍힌다. 캐시를 쓰면 "already present on machine" |
| init 끝 | condition `Initialized` | 모든 init 컨테이너가 성공했다 |
| 컨테이너 시작 | `containerStatuses[].state.*.startedAt` | |

각 condition에는 상태가 바뀐 시각 `lastTransitionTime`이 있어서 생성 시각과의 차이로 구간을 셀 수 있습니다. Pod 하나의 시각을 한 번에 보려면 이렇게 꺼냅니다.

```bash
kubectl get pod <이름> -o jsonpath='{.metadata.creationTimestamp}{"\n"}{range .status.conditions[*]}{.type}{"\t"}{.lastTransitionTime}{"\n"}{end}'
kubectl get events --field-selector involvedObject.name=<이름> | grep -E 'Pulling|Pulled'
```

첫 줄은 생성 시각을 찍고 그 아래로 condition 이름과 바뀐 시각을 한 줄씩 찍습니다. 두 번째 줄은 그 Pod의 이벤트 가운데 이미지를 받기 시작하고 끝낸 기록만 남깁니다. 예를 들어 `PodScheduled` 시각에서 생성 시각을 빼면 스케줄링에 걸린 초가 나오고 `PodReadyToStartContainers`에서 `PodScheduled`를 빼면 샌드박스 준비에 걸린 초가 나옵니다.

조심할 곳이 하나 있습니다. 쿠버네티스 문서에 따르면 init 컨테이너가 없는 Pod에서 kubelet은 샌드박스 생성과 네트워크 설정을 시작하기 전에 `Initialized`를 True로 바꿉니다. init 컨테이너가 없는 Pod에서는 `Initialized` 시각이 `PodReadyToStartContainers`보다 앞설 수 있으니 구간 계산에 쓰면 안 됩니다.

그리고 condition 시각은 초 단위라서 1초보다 짧은 구간은 구분되지 않습니다. 더 잘게 보려면 메트릭을 씁니다. kubelet 메트릭은 모두 ALPHA이고 스케줄러 메트릭 하나만 BETA입니다.

| 메트릭 | 재는 것 |
|---|---|
| `kubelet_pod_start_sli_duration_seconds` | Pod 생성부터 모든 컨테이너 시작까지. 이미지 pull과 init 컨테이너 제외 |
| `kubelet_pod_start_total_duration_seconds` | 같은 구간. pull과 init 포함 |
| `kubelet_image_pull_duration_seconds` | 이미지 pull |
| `kubelet_run_podsandbox_duration_seconds` | 샌드박스 생성 |
| `scheduler_pod_scheduling_sli_duration_seconds`(BETA) | 스케줄링 큐에 들어간 뒤 배정될 때까지 |

total과 SLI 메트릭의 차이가 pull과 init에 쓴 시간입니다.

### 2-2. 공식 SLO 5초가 빼놓은 것

쿠버네티스 sig-scalability의 Pod 기동 지연 SLO는 이렇습니다.

- SLI: 스케줄 가능한 stateless Pod의 기동 지연. 이미지 pull과 init 컨테이너 실행 시간을 빼고 Pod 생성 시각부터 모든 컨테이너가 시작했다고 보고되어 watch로 관측될 때까지.
- SLO: 기본 설치에서 클러스터별 하루 기준 99번째 백분위 5초 이하.

SLI는 "무엇을 재는가"이고 SLO는 "그 값이 어디까지면 괜찮은가"라는 목표입니다. 99번째 백분위(p99)는 하루 동안 뜬 Pod를 기동 시간 순으로 줄 세웠을 때 99% 지점의 값이라 Pod 100개 가운데 99개가 5초 안에 시작했다는 뜻입니다(백분위는 9편). 아래 그림은 이 SLI가 2-1절의 구간 가운데 어디를 세고 어디를 빼는지 보여 줍니다.

![Pod 생성부터 모든 컨테이너 시작까지를 스케줄링, 샌드박스, 이미지 pull, init 컨테이너, 컨테이너 시작 다섯 구간으로 나눈 막대. 스케줄링, 샌드박스, 컨테이너 시작은 파란색으로 공식 SLO가 세는 구간이고 이미지 pull과 init 컨테이너는 빨간색으로 SLO에서 빠지는 구간이다. 배치 태스크가 실제로 기다리는 시간은 다섯 구간 전체다](/uploads/data/de-07-task-per-pod-cost/pod-startup-segments.svg)

이 숫자를 보고 "태스크 하나에 최대 5초"로 읽으면 안 됩니다. 배치 태스크는 이미지 pull과 init 컨테이너까지 다 기다립니다. 처음 보는 노드에서 큰 이미지를 받는 경우가 SLO에서 빠진 구간입니다.

## 3. 이미지 pull

### 3-1. pull 정책과 순서

먼저 이미지 이름의 표기 두 개를 구분해 둡니다. `python:3.12`의 `3.12`는 태그이고 태그는 나중에 다른 이미지를 가리키도록 바뀔 수 있습니다. `python@sha256:…`처럼 쓰는 digest는 이미지 내용으로 만든 해시라 절대 바뀌지 않습니다. 그래서 pull 정책도 태그냐 digest냐에 따라 달라집니다.

| 규칙 | 쿠버네티스 문서 |
|---|---|
| 기본 pull 정책 | 태그가 `:latest`이거나 없으면 `Always`, 그 외 태그나 digest면 `IfNotPresent` |
| `Always`의 실제 동작 | 매번 레지스트리에 태그의 digest를 묻고 없는 레이어만 받는다. 레이어가 다 있어도 레지스트리 왕복은 생긴다 |
| pull 순서 | kubelet은 기본적으로 이미지를 하나씩 받는다. `serializeImagePulls: false`로 병렬을 켜고 `maxParallelImagePulls`로 상한을 둔다. 상한 설정은 1.27에서 들어왔다([1.27 소개 글](https://kubernetes.io/blog/2023/05/15/speed-up-pod-startup/)) |
| Pod 하나 안 | 병렬 pull을 켜도 한 Pod를 위해 여러 이미지를 동시에 받지 않는다 |

마지막 줄은 Argo처럼 Pod 하나에 컨테이너가 여럿인 경우에 해당합니다. init 이미지와 main 이미지가 다르면 차례로 받습니다.

노드에 이미지를 미리 받아 두는 방법(pre-pull)도 문서에 나옵니다. 다만 노드 구성을 직접 통제할 수 있을 때만 쓸 만하다는 단서가 붙습니다. 클라우드가 노드를 자동으로 교체하면 미리 받아 둔 이미지가 사라집니다.

### 3-2. lazy pulling

이미지를 다 받기 전에 컨테이너를 시작하고 필요한 파일만 먼저 받는 방식입니다.

이게 통하는 이유는 컨테이너가 시작할 때 이미지 파일 대부분을 읽지 않는다는 데 있습니다. `python:3.12` 이미지에는 컴파일러, 문서, 쓰지 않는 표준 라이브러리 모듈이 다 들어 있지만 `print("hello")`를 실행하는 데 필요한 파일은 그중 일부입니다. 2016년 FAST 학회에 실린 Slacker 논문은 컨테이너 시작 시간의 76%가 이미지를 받는 데 쓰이는데 받은 데이터 가운데 실제로 읽히는 것은 6.4%뿐이라고 측정했습니다([Harter 외, Slacker](https://www.usenix.org/conference/fast16/technical-sessions/presentation/harter)). 오래된 측정이라 지금 숫자는 다를 수 있지만 "다 받고 조금 읽는다"는 구조는 그대로입니다. 그래서 읽는 순간에 그 파일만 받아 오자는 것이 lazy pulling입니다.

| 방식 | 내용 | 확인한 수치 |
|---|---|---|
| eStargz(stargz-snapshotter) | OCI 호환 포맷으로 이미지를 다시 만든다. 최적화하지 않으면 pull은 빨라지지만 실행이 느려질 수 있어 prefetch 최적화를 한다 | 공식 벤치마크는 환경마다 결과가 다르다고 적는다 |
| SOCI(AWS) | 이미지를 바꾸지 않고 별도 인덱스를 만들어 필요한 부분만 범위 요청으로 받는다 | AWS 글: 압축 250MB가 넘는 이미지에서 효과가 크고 그보다 작으면 오히려 전체 pull보다 느릴 수 있다 |
| GKE Image streaming | 시작에 필요한 데이터만 먼저 받는다 | 문서 예시: 327MB 이미지를 새 노드에 띄울 때 약 24초에서 1.5초 |

Grab은 2026년 글에서 Airflow와 Spark Connect 이미지에 SOCI를 적용한 결과를 정리했습니다. 캐시가 없는 새 노드에서 이미지 pull이 약 4배 빨라졌고 SOCI 설정(동시 다운로드, 압축 해제 병렬도, 청크 크기)을 조정한 뒤 새 노드의 다운로드 시간이 60초에서 24초로 줄었습니다. 운영 환경 P95 기동 시간 개선 폭은 본문에서 30~40%, 결론에서 29~34%로 글 안에서 서로 다르게 적혀 있습니다. 같은 글에서 eStargz는 Airflow 애플리케이션 시작 시간이 25초로 overlayFS와 SOCI의 5초보다 길었습니다. pull이 빨라져도 실행 중에 파일을 받아 오면 시작이 늦어질 수 있다는 예입니다.

## 4. Airflow KubernetesExecutor

### 4-1. Pod 생성 호출도 구간이다

KubernetesExecutor는 태스크마다 워커 Pod를 하나 띄우고 태스크가 끝나면 Pod를 지웁니다(`delete_worker_pods` 기본 True). Pod를 만드는 요청은 스케줄러가 보냅니다. cncf-kubernetes provider 10.24.0 기준으로 확인한 동작입니다.

- `worker_pods_creation_batch_size`의 기본값은 1입니다. 스케줄러 루프 한 번에 Pod 생성 API를 1건 부릅니다.
- 루프 안에서는 생성 호출을 순서대로 보내고 API 서버가 429를 주면 그 루프의 생성을 멈춥니다.
- 10.21.0부터 `async_pod_creation`(기본 False)과 `pod_creation_max_concurrency`가 생겼습니다. 켜면 생성 호출을 동시에 보냅니다. 설정 설명에는 호출마다 지연이 클 때(네트워크 왕복, admission webhook) 스케줄러 루프가 막히는 시간을 줄인다고 되어 있습니다.

배치 크기 1이 무슨 뜻인지 숫자로 보면 이렇습니다. 태스크 300개가 한꺼번에 `queued`가 되면 스케줄러는 루프 한 번에 하나씩 Pod 생성을 요청하니 300번째 태스크의 Pod는 루프를 300번 돈 뒤에야 생성 요청이 나갑니다. 2절의 구간이 시작되기도 전에 Pod 생성 요청을 기다리는 줄이 생깁니다. 루프 한 번이 몇 초인지는 환경마다 달라서 이 줄이 실제로 몇 초가 되는지는 직접 재 봐야 합니다. `kubernetes_executor.pod_creation_batch_duration` 메트릭으로 볼 수 있습니다.

### 4-2. KubernetesPodOperator를 KubernetesExecutor 위에서 쓰면

KubernetesPodOperator(KPO)는 쿠버네티스 API로 Pod를 하나 띄워 그 안에서 지정한 이미지를 실행하는 오퍼레이터입니다. KubernetesExecutor가 없어도 쓸 수 있습니다. 둘을 같이 쓰면 이렇게 됩니다.

```
스케줄러 ─→ 워커 Pod(Airflow 이미지) ─→ 태스크 Pod(사용자 이미지)
            기동 비용 1번                 기동 비용 2번
```

LINE 엔지니어링 블로그(2021, Airflow 1.10.12)가 이 구조를 명시했습니다. 워커 Pod가 직접 정의한 컨테이너 이미지를 Pod 형태로 또다시 실행한다는 설명입니다. Airflow 공식 문서는 "KPO는 API로 Pod를 띄운다"와 "KubernetesExecutor는 태스크마다 Pod를 띄운다"를 따로 적을 뿐 Pod가 두 개가 된다는 문장을 쓰지는 않습니다. 두 사실을 합치면 나오는 결론입니다. KPO의 `startup_timeout_seconds` 기본값은 120초로, Pod가 배정된 뒤 이 시간 안에 시작하지 않으면 실패합니다.

같은 글은 특정 노드에 Pod 생성이 몰려 워커 Pod와 태스크 Pod가 모두 늦어진 경험도 적었습니다. 원인은 워커 Pod에 CPU와 메모리 요청을 지정하지 않아 스케줄러가 노드에 Pod를 고르게 나누지 못한 것이었습니다.

## 5. Argo Workflows

Argo는 단계 하나나 DAG 태스크 하나마다 Pod를 하나 만들고 그 Pod에 컨테이너가 셋 들어갑니다(3편).

| 컨테이너 | 기동에 주는 영향 |
|---|---|
| init | main보다 먼저 순서대로 실행된다. 입력 artifact와 파라미터를 받는다 |
| wait | main과 함께 떠서 끝나길 기다린다 |
| main | 사용자 이미지. `argoexec`가 감싸서 실행한다 |

v4.1의 init-less Pod 문서는 "init 컨테이너는 모든 일반 컨테이너보다 먼저 차례로 실행되어 모든 Pod에 기동 지연을 더한다"고 적습니다. `initlessPod.enabled: true`(beta, 기본 꺼짐)로 켜면 init 컨테이너 없이 `argoexec`를 이미지 볼륨으로 붙이고 `supervisor` 컨테이너 하나가 init과 wait의 일을 함께 합니다. 쿠버네티스 1.33~1.35에서는 feature gate가 필요하고 1.36부터는 기본으로 켜져 있는 기능을 씁니다. init과 wait 오버헤드를 초 단위로 잰 공식 수치는 찾지 못했습니다.

Argo 컨트롤러는 기본적으로 끝난 Pod를 지우지 않습니다. 비용 최적화 문서에 따르면 컨트롤러의 CPU와 메모리는 Pod 수에 비례해 늘어나고 그래서 `podGC` 설정을 권합니다.

## 6. 짧은 태스크가 많을 때

| 방법 | 내용 | 대가 |
|---|---|---|
| 상주 워커로 보낸다 | Airflow 2.10부터 executor를 여러 개 설정하고 태스크마다 `executor=`로 고른다. 짧은 태스크는 Celery로, 격리가 필요한 태스크는 Kubernetes로 | Celery 워커와 브로커를 운영해야 한다. 3.0에서 CeleryKubernetesExecutor 같은 하이브리드 executor는 없어졌고 다중 executor가 공식 경로다 |
| 한 Pod에 여러 컨테이너(Argo container set) | 단계 여러 개를 Pod 하나 안의 컨테이너로 돌린다. Pod 기동과 init, wait 컨테이너를 줄인다 | 자원 요청이 컨테이너들의 합이라 비쌀 수 있다. container 템플릿만 쓸 수 있고 수십 개 규모에 맞다 |
| 태스크를 묶는다 | 짧은 태스크 여러 개를 태스크 하나로 합친다 | 재시도 단위가 커진다. 하나만 실패해도 묶음 전체를 다시 돈다(4편) |
| 이미지를 줄이거나 미리 받는다 | 3절 | 노드가 자주 바뀌면 사전 적재 효과가 줄어든다 |

Airflow의 KubernetesExecutor 문서에는 공식 Helm 차트가 Celery 워커를 0개까지 줄일 수 있게 되면서 KubernetesExecutor의 자원 측면 이점이 줄었다는 설명도 있습니다.

마지막 줄의 "태스크 묶기"는 공식 문서가 권하는 방법으로 찾지는 못했고 재시도 단위와의 교환 관계를 따져 넣었습니다.

## 7. 직접 돌려 볼 실습

kind 같은 로컬 클러스터에서 Pod를 여러 번 띄우고 구간을 찍는 스크립트입니다. 코드는 [labs/de-study/ch07](https://github.com/dj258255/IT-Oasis/tree/main/labs/de-study/ch07)에 있습니다.

```bash
kind create cluster --name pod-lab
./pod_startup.sh 5 busybox:1.36     # 첫 Pod만 pull, 나머지는 캐시
./pod_startup.sh 3 python:3.12      # 큰 이미지로 pull 구간 비교
```

Pod마다 생성 시각 기준으로 `PodScheduled`, `PodReadyToStartContainers`, `Initialized`, 컨테이너 시작까지 걸린 초와 `Pulled` 이벤트 메시지를 찍습니다. 확인할 것은 셋입니다.

1. 첫 Pod와 두 번째 Pod의 차이가 거의 이미지 pull에서 나오는지 봅니다.
2. init 컨테이너가 없는 Pod에서 `Initialized`가 `PodReadyToStartContainers`보다 먼저 찍히는지 봅니다(2-1절).
3. 이미지 크기를 바꿨을 때 `Pulled` 메시지의 시간이 어떻게 바뀌는지 봅니다.

이 실습은 아직 직접 돌려 결과를 기록하지 않았습니다. 돌린 뒤 이 절에 표로 채우겠습니다.

## 8. 중국과 국내 빅테크 사례

- **카카오뱅크**(2024): KubernetesExecutor는 파드가 초기화되고 트리거되는 데 시간이 걸리지만 대략 1분 내외라 펀드 배치에는 허용할 수 있는 범위라고 판단했습니다. 1절의 "태스크가 30분짜리면 몇 초는 문제가 되지 않는다"를 업무 기준으로 판단한 사례입니다.
- **오늘의집**(2021): 안정성과 확장성 때문에 KubernetesExecutor를 골랐지만 짧은 태스크에도 Pod를 만드는 오버헤드가 있다고 적었습니다.
- **京东 Buffalo**(2024): 실행층이 물리 기계의 상주 Worker와 태스크가 끝나면 지우는 쿠버네티스 단명 Pod를 함께 지원합니다. 6절의 "짧은 태스크는 상주 워커로, 격리가 필요한 태스크는 Pod로"를 실행층에서 고르게 한 구성입니다.
- **Tencent Lhotse**(2015): Docker를 도입하자 이미지만 받으면 배포가 끝나 초 단위로 확장할 수 있었다고 적었습니다. 측정 조건은 밝히지 않았습니다.

## 9. 범위와 한계

- 이 글의 숫자는 모두 문서와 남의 글에서 왔습니다. 직접 잰 Pod 기동 시간은 없습니다.
- LINE 글은 Airflow 1.10.12 시절이고 KPO가 Pod를 두 번 띄운다는 결론은 공식 문서 두 문장을 합친 추론입니다.
- Grab 글의 개선 폭은 글 안에서 두 가지로 적혀 있어 둘 다 옮겼습니다.
- Argo의 init, wait 컨테이너가 더하는 시간과 init-less Pod의 효과는 수치를 찾지 못했습니다.
- 생성 요청부터 스케줄러 배정까지를 따로 보여 주는 공식 필드는 찾지 못했습니다. `creationTimestamp`와 `PodScheduled`의 차이로 계산했습니다.

## 10. 헷갈렸던 것

**Q. `imagePullPolicy: Always`면 매번 이미지를 통째로 받나요?**

받지 않습니다. 레지스트리에 태그가 가리키는 digest를 묻고 노드에 없는 레이어만 받습니다. 다만 묻는 왕복은 매번 생기고 레지스트리가 느리거나 장애면 그 시간만큼 기동이 늦어지거나 실패합니다.

**Q. 기동 지연이 문제면 Celery로 가면 끝나나요?**

기동 지연은 줄지만 태스크 사이 격리가 약해집니다. 같은 워커에서 도는 태스크들이 파이썬 패키지와 메모리를 같이 씁니다. 그래서 짧고 가벼운 태스크와 무겁거나 의존성이 다른 태스크를 나눠 다른 executor로 보내는 구성이 나옵니다.

**Q. 공식 SLO가 5초면 내 클러스터도 5초 안에 뜨나요?**

SLO는 기본 설치에서 pull과 init을 뺀 값이고 stateless Pod 기준입니다. 볼륨을 붙이는 Pod는 목표값이 스토리지에 따라 다르다고 되어 있습니다. 내 클러스터의 값은 2-1절의 메트릭으로 직접 봐야 합니다.

## 참고 자료

공식 문서와 소스
- [Kubernetes, Pod Lifecycle](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/)
- [Kubernetes, Metrics reference](https://kubernetes.io/docs/reference/instrumentation/metrics/)
- [Kubernetes, Images](https://kubernetes.io/docs/concepts/containers/images/)
- [Kubernetes sig-scalability, Pod startup latency SLO](https://github.com/kubernetes/community/blob/master/sig-scalability/slos/pod_startup_latency.md)
- [Airflow 3.2.0 Executor](https://airflow.apache.org/docs/apache-airflow/3.2.0/core-concepts/executor/index.html)
- [Airflow cncf-kubernetes provider, Kubernetes Executor](https://airflow.apache.org/docs/apache-airflow-providers-cncf-kubernetes/stable/kubernetes_executor.html), [Configuration](https://airflow.apache.org/docs/apache-airflow-providers-cncf-kubernetes/stable/configurations-ref.html)
- [Argo Workflows Architecture](https://argo-workflows.readthedocs.io/en/latest/architecture/), [Init-less Pod](https://argo-workflows.readthedocs.io/en/latest/initless-pod/), [Container Set Template](https://argo-workflows.readthedocs.io/en/latest/container-set-template/), [Cost Optimisation](https://argo-workflows.readthedocs.io/en/latest/cost-optimisation/)
- [containerd stargz-snapshotter](https://github.com/containerd/stargz-snapshotter)
- [GKE Image streaming](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/image-streaming)

사례
- Tyler Harter 외, [Slacker: Fast Distribution with Lazy Docker Containers](https://www.usenix.org/conference/fast16/technical-sessions/presentation/harter), USENIX FAST 2016
- Kubernetes Blog, [Kubernetes 1.27: updates on speeding up Pod startup](https://kubernetes.io/blog/2023/05/15/speed-up-pod-startup/) (2023)
- AWS Containers Blog, [Under the hood: Lazy loading container images with Seekable OCI and AWS Fargate](https://aws.amazon.com/blogs/containers/under-the-hood-lazy-loading-container-images-with-seekable-oci-and-aws-fargate/) (2023)
- Grab Engineering, [Docker lazy loading](https://engineering.grab.com/docker-lazy-loading) (2026)
- LINE Engineering, [Kubernetes를 이용한 효율적인 데이터 엔지니어링(Airflow on Kubernetes VS Airflow Kubernetes Executor) - 2](https://engineering.linecorp.com/ko/blog/data-engineering-with-airflow-k8s-2/) (2021)

이 시리즈
- [3편 오케스트레이터는 무엇을 맡나](/blog/data/orchestration/de-02-what-orchestrator-does)
- 실습 코드: [labs/de-study/ch07](https://github.com/dj258255/IT-Oasis/tree/main/labs/de-study/ch07)

중국과 국내 빅테크 사례
- Sean(마승현), [Airflow로 펀드 배치 시스템 완벽 구축하기](https://tech.kakaobank.com/posts/2412-financial-batch-system-with-airflow/), 카카오뱅크, 2024
- 델피, [버킷플레이스 Airflow 도입기](https://www.bucketplace.com/post/2021-04-13-%EB%B2%84%ED%82%B7%ED%94%8C%EB%A0%88%EC%9D%B4%EC%8A%A4-airflow-%EB%8F%84%EC%9E%85%EA%B8%B0/), 오늘의집, 2021
- 京东, [京东百万级调度系统(Buffalo)架构解密](https://developer.jdcloud.com/article/3944), 2024
- 腾讯大数据, [全民拥抱Docker云--Lhotse系统经验分享](https://cloud.tencent.cn/developer/article/1030033), 2015

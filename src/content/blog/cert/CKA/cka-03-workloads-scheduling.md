---
title: '[CKA Ch-03] 워크로드와 스케줄링: Pod가 어디에 얼마만큼 뜨는지 정하는 값들'
description: CKA 비중 15%인 워크로드와 스케줄링 영역을 v1.37 커리큘럼 순서대로 시험에 쓰는 명령과 YAML 중심으로 정리합니다. 롤아웃과 롤백, ConfigMap과 Secret, HPA와 VPA, in-place resize, 프로브와 사이드카, StatefulSet, Job, PDB, requests와 limits, LimitRange, ResourceQuota, 어피니티, 테인트, static Pod, PriorityClass, DaemonSet을 다룹니다.
date: 2026-10-19T00:00:00.000Z
tags:
  - CKA
  - Kubernetes
  - Deployment
  - HPA
  - Scheduling
  - Taints
category: cert/CKA
topics:
  - cert
draft: false
series: "CKA 공부"
seriesOrder: 3
---

## 결론부터

1. 이 영역의 값은 세 길목에서 작동합니다. 승인 단계(LimitRange, ResourceQuota, PriorityClass)에서 막히면 생성이 `403 Forbidden`으로 거절되고 스케줄러(requests, nodeSelector, 어피니티, 테인트)에서 막히면 `Pending`으로 남습니다. limits, 프로브, restartPolicy는 노드의 kubelet이 집행합니다.
2. Deployment의 롤아웃은 Pod 템플릿(`.spec.template`)이 바뀔 때만 일어납니다. 레플리카 수만 바꾸면 새 리비전이 생기지 않습니다. 기본 전략은 RollingUpdate이고 `maxUnavailable`과 `maxSurge`의 기본값은 각각 25%입니다.
3. ConfigMap을 환경 변수로 넣으면 Pod를 다시 만들어야 반영되고 볼륨으로 넣으면 kubelet 동기화 주기를 거쳐 늦게 반영됩니다. `subPath` 마운트는 갱신되지 않습니다.
4. HPA는 CPU request가 없으면 CPU 사용률을 계산하지 못합니다. 1.34부터 `kubectl autoscale`의 옵션은 `--cpu=60%` 형식입니다.
5. 테인트는 노드가 Pod를 밀어내는 장치이고 톨러레이션은 그 밀어냄을 견디는 허가입니다. 톨러레이션만으로는 그 노드로 가지 않습니다. 특정 노드로 보내려면 nodeSelector나 노드 어피니티를 함께 씁니다.

시험 구조는 [CKA Ch-00](/blog/cert/cka/cka-00-exam-and-study-plan)에 정리했습니다. 옛 커리큘럼의 이 영역에 있던 매니페스트 관리 도구와 템플릿 항목은 v1.37 문구에 없고 아키텍처 영역의 "Use Helm and Kustomize to install cluster components"가 그 자리를 맡아 [CKA Ch-02](/blog/cert/cka/cka-02-cluster-architecture) 6장에서 다룹니다.

---

## 1. 롤링 업데이트와 롤백

커리큘럼 문구는 "Understand application deployments and how to perform rolling update and rollbacks"입니다.

### 1-1. Deployment, ReplicaSet, 리비전

<details>
<summary>기초부터: 롤아웃과 롤백은 안에서 어떻게 돌아가나</summary>

> **핵심 한 줄**: Deployment는 Pod를 직접 만들지 않습니다. 버전마다 ReplicaSet을 하나씩 두고 그 레플리카 숫자만 옮겨 가며 바꿉니다.

#### 1. 왜 필요한가

주문 API Pod 5개가 `nginx:1.27`로 돌고 있고 이것을 1.28로 바꿔야 합니다. 컨테이너는 만들어질 때의 이미지로 끝까지 돌기 때문에 새 이미지를 쓰려면 새 Pod를 띄워야 합니다. 그러면 옛 Pod를 언제 내리고 새 Pod를 언제 올릴지가 문제가 됩니다.

- **롤아웃(rollout)**: 새 버전으로 바꿔 가는 전체 과정
- **롤백(rollback)**: 문제가 생겨 이전 버전으로 되돌리는 것

둘 다 Deployment가 맡습니다.

| 전략 | 하는 방식 | 바꾸는 동안 | 고르는 경우 |
|---|---|---|---|
| `Recreate` | 옛 Pod 5개를 모두 지운 뒤 새 Pod 5개 생성 | 요청을 받을 Pod가 하나도 없어 서비스가 끊김 | 두 버전이 동시에 떠 있으면 곤란한 앱(예: 버전마다 DB 스키마가 다름) |
| `RollingUpdate`(기본) | 새 Pod를 조금 띄우고 옛 Pod를 조금 내리기를 반복 | 일부 Pod가 늘 요청을 받아 무중단 | 대부분의 무상태 앱. 한 번에 바꿀 양은 `maxUnavailable`, `maxSurge`로 정함 |

#### 2. 어떻게 동작하나 (레플리카 5개, RollingUpdate)

1. **템플릿 변경**: 사용자가 Pod 템플릿을 바꿉니다(`set image`, `apply`, `edit`).
2. **새 ReplicaSet 생성**: Deployment 컨트롤러가 템플릿이 달라진 것을 보고 새 템플릿으로 ReplicaSet v2를 만듭니다.
3. **조금씩 옮기기**: `maxSurge`, `maxUnavailable` 한도 안에서 v2를 늘리고 v1을 줄이기를 반복합니다. 새 Pod가 사용 가능(Ready)해져야 다음 걸음을 뗍니다.
4. **완료**: v2가 5개, v1이 0개가 되면 끝납니다. v1은 지워지지 않고 Pod 0개짜리 ReplicaSet으로 남습니다.

```text
Deployment order-api
 ├─ ReplicaSet v1 (nginx:1.27)  5 → 4 → 3 → 2 → 1 → 0   지우지 않고 0으로 남김 (리비전 1)
 └─ ReplicaSet v2 (nginx:1.28)  0 → 1 → 2 → 3 → 4 → 5   새로 만듦 (리비전 2)

kubectl rollout undo
  → v1에 남아 있던 템플릿을 Deployment에 다시 적음
  → 컨트롤러가 v1을 늘리고 v2를 줄임 (롤아웃과 같은 과정)
```

#### 3. 롤백이 빠른 이유

`kubectl rollout undo`를 치면 kubectl이 v1 ReplicaSet에 남아 있던 템플릿을 Deployment에 다시 적습니다. 그다음은 롤아웃과 똑같이 컨트롤러가 v1을 늘리고 v2를 줄입니다. 옛 템플릿이 ReplicaSet으로 보관돼 있어서 새로 준비할 것이 없습니다.

> **정리**: 롤아웃과 롤백은 같은 과정이고 어느 ReplicaSet을 늘리고 어느 쪽을 줄이느냐만 다릅니다. 아래 표의 값들은 그 숫자를 얼마나 빨리 옮길지 정합니다.

</details>

Deployment는 ReplicaSet을 관리하고 ReplicaSet은 Pod 수를 맞춥니다. Pod 템플릿을 바꾸면 Deployment가 새 ReplicaSet을 만들고 새 쪽을 늘리면서 옛 쪽을 줄입니다. 옛 ReplicaSet은 레플리카 0인 채로 남아 있다가 롤백할 때 다시 늘어납니다. 이 옛 ReplicaSet 하나하나가 리비전입니다.

| 항목 | "Deployments" 문서 기준 |
|---|---|
| 롤아웃이 일어나는 조건 | Pod 템플릿(`.spec.template`)이 바뀔 때만. 레플리카 수 변경은 해당 없음 |
| 기본 전략 | `RollingUpdate`. 다른 값은 `Recreate`(옛 Pod를 모두 죽인 뒤 새 Pod 생성) |
| `maxUnavailable` | 기본 25%. 백분율을 절대 수로 바꿀 때 내림 |
| `maxSurge` | 기본 25%. 백분율을 절대 수로 바꿀 때 올림 |
| 두 값의 제약 | 둘 다 0일 수는 없음 |
| `revisionHistoryLimit` | 기본 10. 0으로 두면 롤백할 수 없음 |
| `progressDeadlineSeconds` | 기본 600. 이 시간 안에 진행이 없으면 진행 실패로 보고 |

레플리카 4개라면 25%는 1개입니다. 기본값에서는 롤아웃 중 사용 가능한 Pod가 3개 아래로 내려가지 않고 전체 Pod는 5개를 넘지 않습니다. 레플리카가 3개면 `maxUnavailable`은 0.75를 내려 0개, `maxSurge`는 0.75를 올려 1개입니다. 새 Pod 하나가 먼저 뜬 다음에야 옛 Pod가 줄어듭니다.

### 1-2. 시험에서 쓰는 명령

```bash
# 쇼핑몰 주문 API
kubectl create deployment order-api --image=nginx:1.27 --replicas=3 -n shop

# 이미지 교체로 롤아웃 시작 (컨테이너 이름=이미지)
kubectl set image deployment/order-api nginx=nginx:1.28 -n shop
kubectl annotate deployment/order-api -n shop kubernetes.io/change-cause="image 1.28"

kubectl rollout status deployment/order-api -n shop
kubectl rollout history deployment/order-api -n shop
kubectl rollout history deployment/order-api -n shop --revision=2

# 직전 리비전으로, 또는 특정 리비전으로
kubectl rollout undo deployment/order-api -n shop
kubectl rollout undo deployment/order-api -n shop --to-revision=1

# 여러 변경을 묶어서 한 번에 롤아웃
kubectl rollout pause deployment/order-api -n shop
kubectl rollout resume deployment/order-api -n shop

# 템플릿은 그대로 두고 Pod만 순서대로 새로 띄우기
kubectl rollout restart deployment/order-api -n shop
```

`kubectl create deployment`가 만드는 컨테이너 이름은 이미지 이름에서 옵니다. `nginx:1.27`이면 컨테이너 이름이 `nginx`라서 `set image`에 `nginx=`를 씁니다. 이름이 기억나지 않으면 `kubectl get deploy order-api -o jsonpath='{.spec.template.spec.containers[*].name}'`로 확인합니다.

`rollout history`의 `CHANGE-CAUSE` 열은 Deployment의 `kubernetes.io/change-cause` 어노테이션에서 복사됩니다. 어노테이션을 달지 않으면 `<none>`으로 찍힙니다. 어노테이션은 Deployment에 남아 있어서 다음 롤아웃 때 바꾸지 않으면 새 리비전에도 같은 문구가 붙습니다. 롤아웃마다 새로 답니다.

### 1-3. 헷갈리는 지점

- `rollout status`는 롤아웃이 끝나면 종료 코드 0을 돌려줍니다. `--timeout`을 넘기면 `error: timed out waiting for the condition`, `progressDeadlineSeconds`를 넘기면 `error: deployment "order-api" exceeded its progress deadline`과 함께 0이 아닌 코드로 끝납니다.
- 없는 이미지 태그로 바꾸면 롤아웃이 멈춥니다. `maxUnavailable` 덕분에 옛 Pod가 전부 내려가지는 않으니 `rollout undo`로 되돌립니다.
- 롤백하면 되돌아간 리비전 번호는 빠지고 같은 템플릿이 새 번호로 붙습니다. `1, 2, 3`에서 `undo`로 2에 돌아가면 `1, 3, 4`입니다.
- `kubectl set image`나 `kubectl edit`으로 바꾼 값은 손에 든 매니페스트 파일에 남지 않습니다. 나중에 옛 파일로 `kubectl apply`를 하면 옛 이미지로 롤아웃이 다시 일어나니 파일도 함께 고쳐 둡니다.

### 1-4. Pod에서 바꿀 수 있는 필드와 `kubectl edit` 우회

<details>
<summary>기초부터: Pod는 고쳐 쓰지 않고 다시 만드는 단위</summary>

> **핵심 한 줄**: Pod는 한 번 만들면 그대로 쓰다가 버리는 단위이고 바꾸고 싶으면 다시 만듭니다. 고쳐 가며 쓰는 역할은 Deployment의 템플릿이 맡습니다.

#### 1. 왜 필요한가

돌고 있는 Pod에 환경 변수 하나를 더하려고 `kubectl edit pod`로 고쳤더니 저장이 거절됩니다. 이런 단순한 변경을 막아 둔 이유는 Pod spec의 대부분이 노드에서 컨테이너를 만들 때 한 번 쓰이고 끝나는 값이기 때문입니다.

#### 2. 어떻게 동작하나

1. **환경 변수**: 프로세스가 시작될 때 넘겨지는 값입니다. 이미 시작된 프로세스에 다시 넣을 방법이 없습니다.
2. **볼륨**: 컨테이너를 만들 때 마운트됩니다. 돌고 있는 컨테이너의 마운트를 갈아 끼우지 않습니다.
3. **API 서버의 판단**: 반영할 방법이 없는 필드라서 처음부터 변경을 받지 않습니다.
4. **바꿀 수 있는 이미지 필드**: 실제로는 kubelet이 그 컨테이너를 새 이미지로 다시 만들어 반영합니다(`RESTARTS`가 하나 오릅니다).

```text
kubectl edit pod (env 추가) → API 서버가 거절
kubectl edit deploy (env 추가) → 템플릿 변경 → 롤아웃 → 새 Pod가 새 env로 시작
```

#### 3. 한눈에 비교

| 구분 | Pod를 직접 고칠 때 | Deployment 템플릿을 고칠 때 |
|---|---|---|
| 바꾸는 방법 | 지우고 새로 만들기(`replace --force`) | `edit`, `set`, `apply` 한 번 |
| 바꾸는 동안 | 그 Pod가 없는 동안 요청을 못 받음 | 롤링 업데이트로 나머지 Pod가 요청을 받음 |
| 쓰는 자리 | 시험 과제의 단독 Pod, 디버깅 | 실제로 운영하는 워크로드 |

#### 4. 실전에서 보이는 모습

- `kubectl edit pod`로 금지된 필드를 고치고 저장하면 편집기가 다시 열리며 거절 메시지가 파일 위쪽 주석에 붙습니다. kubectl은 고친 내용을 `/tmp` 아래 임시 파일로 남겨 두므로 그 파일로 `replace --force`를 하면 됩니다(아래 본문의 절차).
- Deployment에 속한 Pod를 직접 지우면 ReplicaSet이 곧바로 같은 템플릿으로 새 Pod를 만듭니다. 바꾼 내용은 사라집니다.

> **정리**: `kubectl edit pod`가 거절되면 단독 Pod인지부터 봅니다. 단독 Pod는 `/tmp`에 남은 수정본으로 `replace --force`를 하고 Deployment에 속한 Pod는 템플릿을 고쳐 1-1절의 롤아웃에 맡깁니다.

</details>

실행 중인 Pod의 spec은 거의 바꿀 수 없습니다. API 서버의 Pod 검증 규칙이 허용하는 변경은 이 목록뿐입니다.

| 바꿀 수 있는 필드 | 조건 |
|---|---|
| `spec.containers[*].image`, `spec.initContainers[*].image` | 없음 |
| `spec.activeDeadlineSeconds` | 비어 있던 값을 양수로 넣거나 기존 값보다 줄일 때 |
| `spec.tolerations` | 기존 항목에 더하는 것만 |
| `spec.terminationGracePeriodSeconds` | 음수였던 값을 1로 바꿀 때만 |
| `spec.schedulingGates` | 기존 게이트를 지우는 것만 |
| `spec.nodeSelector`, `spec.affinity.nodeAffinity` | Pod에 스케줄링 게이트가 남아 있는 동안 조건을 더해 좁히는 변경만(preferred 항목은 자유롭게 바꿈) |

라벨과 어노테이션은 따로 바꿀 수 있고 CPU와 메모리는 3-3절의 `resize` 하위 리소스로 바꿉니다. 환경 변수, 볼륨, `command`, ServiceAccount 같은 나머지 필드를 고치면 "pod updates may not change fields other than ..."로 시작하는 메시지와 함께 거절됩니다.

그래서 Pod를 지우고 다시 만드는 절차를 손에 익혀 둡니다. `kubectl edit`은 저장이 거절되면 `A copy of your changes has been stored to "/tmp/kubectl-edit-....yaml"`로 수정본 경로를 알려 줍니다.

```bash
kubectl edit pod board-web -n board
# 거절되면 안내된 임시 파일로 지우고 다시 만들기
kubectl replace --force -f /tmp/kubectl-edit-<번호>.yaml
# 또는 kubectl get pod ... -o yaml > f.yaml 로 뽑아 고친 뒤 replace --force
```

Deployment가 관리하는 Pod는 템플릿을 고칩니다. Pod만 고쳐 다시 만들면 다음 교체 때 ReplicaSet이 템플릿 값으로 되돌립니다.

### 1-5. 직접 해 보기

`order-api`를 레플리카 4개로 만들고 `maxSurge: 1`, `maxUnavailable: 0`으로 바꿉니다. 없는 태그로 `set image`를 실행한 뒤 확인합니다.

- `kubectl rollout status ... --timeout=40s`가 `error: timed out waiting for the condition`으로 끝나고 `echo $?`가 1인지
- `kubectl get rs`에서 옛 ReplicaSet은 4개 Ready 그대로, 새 ReplicaSet은 1개가 `ErrImagePull`인지
- `rollout undo` 뒤 `rollout history`의 번호가 1-3절대로 바뀌는지

## 2. ConfigMap과 Secret으로 애플리케이션 설정

커리큘럼 문구는 "Use ConfigMaps and Secrets to configure applications"입니다.

### 2-1. 넣는 방법 넷, 갱신 방식 둘

<details>
<summary>기초부터: ConfigMap이 왜 있고 Pod에 어떻게 들어가나</summary>

> **핵심 한 줄**: ConfigMap은 설정값만 키-값으로 담아 두는 API 객체이고 Pod는 "어느 ConfigMap의 어느 키"만 가리킵니다.

#### 1. 왜 필요한가

게시판 앱이 페이지 크기와 로그 레벨을 환경 변수로 읽는다고 합시다.

| 설정을 두는 곳 | 생기는 문제 |
|---|---|
| Pod YAML의 `env`에 바로 적기 | 같은 앱을 쓰는 Deployment가 열 개면 파일 열 개를 고침. 개발과 운영의 값이 다르면 같은 YAML을 못 씀 |
| 설정 파일을 이미지에 구워 넣기 | 값 하나 바꾸려고 이미지를 다시 빌드 |
| ConfigMap | 앱(이미지와 Pod 정의)과 설정이 떨어져 있어 설정만 바꿈 |

값은 평문 문자열이고 비밀번호 같은 민감한 값은 2-2절의 Secret에 둡니다.

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: board-config
  namespace: board
data:
  PAGE_SIZE: "20"          # 값은 문자열. 숫자도 따옴표로 감쌈
  LOG_LEVEL: info
```

#### 2. 어떻게 동작하나

1. **저장**: ConfigMap이 API 서버를 거쳐 etcd에 저장됩니다. 참조하는 Pod와 같은 네임스페이스에 있어야 합니다.
2. **kubelet이 읽기**: Pod가 노드에 배치되면 그 노드의 kubelet이 API 서버에서 ConfigMap을 읽습니다.
3. **환경 변수 방식**: kubelet이 컨테이너를 시작할 때 값을 프로세스 환경에 넣습니다. 시작된 뒤에는 밖에서 환경을 바꿀 수 없어 ConfigMap을 고쳐도 반영되지 않습니다.
4. **볼륨 방식**: kubelet이 키마다 파일을 하나씩 만들어 컨테이너 경로에 마운트합니다. ConfigMap이 바뀌면 kubelet이 주기적으로 동기화하면서 파일 내용을 바꿔 줍니다. 앱이 그 파일을 다시 읽어야 새 값을 씁니다.

```text
ConfigMap(etcd) → API 서버 → 노드의 kubelet
                                ├─ env    : 컨테이너 시작 때 한 번 주입 (이후 고정)
                                └─ volume : 키마다 파일 생성, 주기적으로 동기화
```

#### 3. 헷갈리는 점 / 실전에서 보이는 모습

| 증상 | 원인 | 대처 |
|---|---|---|
| STATUS `CreateContainerConfigError` | 환경 변수로 가리킨 ConfigMap이나 키가 없음 | ConfigMap을 만들거나 참조에 `optional: true` |
| `ContainerCreating`에 머물고 Events에 마운트 실패 | 볼륨으로 가리킨 ConfigMap이 없음 | 같은 네임스페이스에 ConfigMap 생성 |
| ConfigMap을 고쳤는데 앱 값이 그대로 | 환경 변수 방식이거나 앱이 파일을 다시 읽지 않음 | `kubectl rollout restart`로 Pod를 다시 만듦 |

- nginx 설정 파일처럼 파일 하나가 통째로 필요하면 `--from-file=nginx.conf`로 파일 내용을 값 하나로 넣고 볼륨으로 마운트합니다. 키 이름이 파일 이름이 됩니다.

> **정리**: ConfigMap을 고쳤는데 앱 값이 그대로면 넣은 방식부터 확인합니다. env는 Pod를 다시 만들어야 하고 볼륨은 kubelet 동기화를 기다린 뒤 앱이 파일을 다시 읽어야 합니다.

</details>

"ConfigMaps" 문서가 꼽는 사용법은 명령과 인자, 환경 변수, 볼륨 파일, API로 직접 읽기 넷입니다.

| 넣는 방식 | 값을 바꾸면 |
|---|---|
| 환경 변수(`env`, `envFrom`) | 자동 반영 안 됨. Pod를 다시 만들어야 함 |
| 볼륨 파일 | 결국 반영됨. 지연은 kubelet 동기화 주기와 캐시 전파 지연을 더한 만큼 |
| `subPath`로 마운트한 볼륨 파일 | 반영 안 됨 |

Secret도 같습니다. 크기 제한은 ConfigMap과 Secret 모두 1MiB입니다.

### 2-2. Secret의 기본 저장 방식과 보호 조치

<details>
<summary>기초부터: Secret은 ConfigMap과 무엇이 다른가</summary>

> **핵심 한 줄**: Secret은 민감한 값을 따로 분류해 권한과 노출 방식을 다르게 다루려는 객체입니다. base64는 암호화가 아닙니다.

#### 1. 왜 필요한가

DB 비밀번호도 ConfigMap에 넣을 수는 있습니다. 그러면 `kubectl describe configmap` 한 번에 화면에 그대로 찍히고 ConfigMap을 읽을 권한이 있는 사람은 누구나 봅니다. 민감한 값을 따로 분류해 두면 권한을 따로 좁히고 노출 방식도 다르게 다룰 수 있습니다.

| 항목 | ConfigMap | Secret |
|---|---|---|
| `data`의 값 | 평문 문자열 | base64로 인코딩한 문자열 |
| `kubectl describe` | 값이 보임 | 바이트 수만 보임 |
| 볼륨으로 마운트하면 | 노드 디스크에 파일로 씀 | 노드 메모리 기반 tmpfs에 써서 디스크에 남지 않음 |
| 종류 | 하나 | `type`으로 구분(`Opaque`, `kubernetes.io/tls`, `kubernetes.io/dockerconfigjson` 등) |

#### 2. 어떻게 지키나

**base64의 정체**: 인증서나 키 파일 같은 바이너리 값도 YAML 문자열에 담기 위한 인코딩입니다. 키가 없어서 `echo 'Y2hhbmdlLW1l' | base64 -d` 한 줄이면 누구나 원문을 봅니다. 화면을 지나가며 비밀번호가 눈에 띄는 일 정도만 막아 줍니다.

Secret을 실제로 지키는 장치는 따로 있습니다.

1. **RBAC**: Secret의 `get`, `list` 권한을 필요한 주체에만 줍니다.
2. **저장 시 암호화**: etcd에 저장할 때 암호화합니다(2-6절).
3. **최소 노출**: Secret이 필요한 컨테이너에만 넣습니다.

```text
kubectl describe  → 바이트 수만 보임      (화면 노출 방지)
kubectl get -o yaml → base64 값 보임      (RBAC로 막아야 함)
etcd 직접 읽기     → 평문과 다름없음       (저장 시 암호화로 막아야 함)
```

#### 3. 만드는 법과 헷갈리는 점

| 방법 | 인코딩 | 주의 |
|---|---|---|
| `kubectl create secret generic` | 알아서 함 | 없음 |
| YAML `data` | `echo -n 'change-me' \| base64`로 직접 | `-n`을 빼면 줄바꿈 문자까지 인코딩되어 비밀번호가 달라짐 |
| YAML `stringData` | 평문을 적으면 API 서버가 `data`로 바꿔 저장 | 인코딩이 번거로울 때 |

#### 4. 외부 비밀 저장소와 잇기 (Secrets Store CSI Driver)

비밀번호를 클러스터 밖 저장소(HashiCorp Vault, 클라우드의 비밀 관리 서비스)에 두고 Pod가 뜰 때 CSI 볼륨으로 값을 받아 tmpfs 파일로 넣어 주는 애드온입니다.

- 기본 동작에서는 Kubernetes Secret 객체를 만들지 않아 etcd에 값이 남지 않습니다.
- 환경 변수로도 쓰고 싶으면 `secretObjects`로 Secret 동기화를 켭니다.
- 외부 값이 바뀌었을 때 자동으로 다시 받아 오는 순환(rotation)은 alpha 기능이라 기본으로 꺼져 있고 드라이버에 `--enable-secret-rotation=true`를 줘야 동작합니다. 켜면 드라이버가 `--rotation-poll-interval`(기본 `2m`) 간격으로 외부 저장소를 다시 확인합니다.

CKA 범위 밖이라 개념만 알아 둡니다.

> **정리**: 값이 가려지는 곳은 `kubectl describe` 화면뿐입니다. `get -o yaml`은 RBAC로, etcd 직접 읽기는 저장 시 암호화로 막아야 하고 Secret은 필요한 컨테이너에만 넣습니다.

</details>

Secret은 기본적으로 etcd에 암호화되지 않은 채 저장되고 `data` 필드의 base64는 인코딩일 뿐입니다. "Secrets" 문서가 권하는 조치는 저장 시 암호화(2-6절), 최소 권한 RBAC, 필요한 컨테이너에만 노출하기입니다. 네임스페이스에서 Pod를 만들 수 있는 사람이면 Secret을 마운트해 읽을 수 있다는 점도 같은 문서가 짚습니다.

### 2-3. 시험에서 쓰는 명령

```bash
# 게시판 설정
kubectl create configmap board-config -n board \
  --from-literal=PAGE_SIZE=20 --from-literal=LOG_LEVEL=info

kubectl create secret generic board-db -n board \
  --from-literal=DB_USER=board --from-literal=DB_PASSWORD='change-me'

kubectl create secret tls payment-tls -n payment --cert=tls.crt --key=tls.key

# Deployment에 환경 변수로 한꺼번에 주입
kubectl set env deployment/board-web -n board --from=configmap/board-config
kubectl set env deployment/board-web -n board --from=secret/board-db

# 값 확인
kubectl get secret board-db -n board -o jsonpath='{.data.DB_USER}' | base64 -d
```

`set env --from`은 키마다 `env` 항목을 하나씩 만들어 `valueFrom.configMapKeyRef`로 가리킵니다. 그래서 나중에 ConfigMap에 더한 키는 들어가지 않고 새 키까지 받으려면 YAML에 `envFrom`을 적습니다. 세 주입 방식을 모은 뼈대입니다.

```yaml
spec:
  containers:
    - name: board-web
      image: nginx
      envFrom:                      # 모든 키를 환경 변수로
        - configMapRef:
            name: board-config
      env:                          # 키 하나만 골라서
        - name: DB_PASSWORD
          valueFrom:
            secretKeyRef:
              name: board-db
              key: DB_PASSWORD
      volumeMounts:                 # 키마다 파일 하나
        - name: config
          mountPath: /etc/board
          readOnly: true
  volumes:
    - name: config
      configMap:
        name: board-config          # Secret이면 secret: { secretName: board-db }
```

### 2-4. 헷갈리는 지점

- `--from-file=<디렉터리>`는 일반 파일마다, `--from-env-file`은 `VAR=VAL` 줄마다 키 하나를 만듭니다. `--from-env-file`은 따옴표를 값에 그대로 넣습니다.
- `immutable: true`로 표시한 ConfigMap은 표시를 되돌릴 수도, `data`를 바꿀 수도 없습니다. 지우고 다시 만든 뒤 기존 Pod도 다시 만듭니다.
- Secret YAML을 손으로 쓸 때 base64 인코딩이 귀찮으면 `stringData` 필드를 씁니다.

### 2-5. command와 args, 이미지의 ENTRYPOINT와 CMD

<details>
<summary>기초부터: Docker의 CMD와 ENTRYPOINT부터</summary>

> **핵심 한 줄**: ENTRYPOINT는 실행 파일, CMD는 기본 인자입니다. 쿠버네티스에서는 `command`가 ENTRYPOINT 자리, `args`가 CMD 자리를 덮어씁니다.

#### 1. 왜 필요한가

컨테이너는 프로세스 하나가 사는 동안만 삽니다. 컨테이너가 시작되면 이미지에 정해진 명령이 PID 1 프로세스로 실행되고 그 프로세스가 끝나면 컨테이너도 끝납니다.

```text
ubuntu 이미지를 그냥 띄움
  → 기본 명령 bash가 붙을 터미널이 없음 → 곧바로 종료 (Exited)
  → 쿠버네티스에서는 restartPolicy: Always 때문에 다시 뜨고 또 끝남
  → CrashLoopBackOff
```

그래서 컨테이너가 무엇을 실행할지 정확히 정해 둬야 합니다.

#### 2. 어떻게 동작하나

1. **`CMD`**: 기본으로 실행할 명령이나 기본 인자입니다. `docker run <이미지> <값>`처럼 뒤에 값을 주면 CMD 전체가 그 값으로 바뀝니다.
2. **`ENTRYPOINT`**: 항상 실행할 실행 파일입니다. `docker run` 뒤의 값은 ENTRYPOINT를 바꾸지 않고 그 뒤에 인자로 붙습니다. 실행 파일 자체를 바꾸려면 `docker run --entrypoint`를 씁니다.

몇 초 쉬었다 끝나는 이미지 `shop-sleeper`를 이렇게 만들었다고 합시다.

```dockerfile
FROM ubuntu
ENTRYPOINT ["sleep"]
CMD ["5"]
```

| 실행 | 실제로 도는 명령 |
|---|---|
| `docker run shop-sleeper` | `sleep 5`. CMD가 기본 인자로 붙음 |
| `docker run shop-sleeper 10` | `sleep 10`. CMD만 10으로 바뀜 |
| `docker run --entrypoint echo shop-sleeper hi` | `echo hi`. ENTRYPOINT를 바꾸면 이미지의 CMD도 버려짐 |

**둘을 함께 쓰는 이유**

| 구성 | 불편한 점 |
|---|---|
| CMD만 `["sleep", "5"]` | 10초로 바꿀 때 `docker run shop-sleeper sleep 10`처럼 명령까지 다시 적음 |
| ENTRYPOINT만 | 인자를 빼먹으면 `sleep: missing operand`로 끝남 |
| ENTRYPOINT + CMD | 실행 파일은 고정, 기본 인자는 따로 바꿀 수 있음 |

#### 3. 쿠버네티스로 옮기면

| Docker | Pod YAML |
|---|---|
| `ENTRYPOINT`, `--entrypoint` | `command` |
| `CMD`, `docker run` 뒤의 값 | `args` |

```yaml
containers:
  - name: sleeper
    image: shop-sleeper
    command: ["sleep"]    # ENTRYPOINT 자리
    args: ["10"]          # CMD 자리. 실제 실행은 sleep 10
```

#### 4. 헷갈리는 점: exec 형식과 shell 형식

| 형식 | 예 | 실제 실행 |
|---|---|---|
| exec(배열) | `["sleep", "5"]` | 셸 없이 그 실행 파일이 바로 PID 1 |
| shell(문자열) | `CMD sleep 5` | `/bin/sh -c "sleep 5"`로 감싸 실행 |

쿠버네티스의 `command`와 `args`는 항상 배열이고 셸을 거치지 않습니다. 파이프나 `&&`, `$(date)` 같은 셸 문법을 쓰려면 `command: ["sh", "-c", "..."]`처럼 셸을 직접 부릅니다.

> **정리**: 실행 파일을 바꾸려면 `command`, 인자만 바꾸려면 `args`를 적습니다. 셸 문법이 필요하면 `sh -c`를 직접 부릅니다.

</details>

설정값을 넘기는 또 하나의 길이 실행 명령입니다. "Define a Command and Arguments for a Container" 문서 기준으로 `command`는 이미지의 ENTRYPOINT에, `args`는 CMD에 대응합니다. 이름만 보면 `command`가 CMD와 짝일 것 같아서 자주 틀립니다.

| Pod에 적은 것 | 실제로 실행되는 것 |
|---|---|
| 둘 다 없음 | 이미지의 ENTRYPOINT + CMD |
| `args`만 | 이미지의 ENTRYPOINT + `args` |
| `command`만 | `command`만. 이미지의 CMD도 버려짐 |
| 둘 다 | `command` + `args` |

`kubectl run`에서는 `--` 뒤의 값이 `args`가 되고 `--command`를 붙이면 `command`가 됩니다(`kubectl run sleeper --image=busybox --command -- sleep 3600`). 두 필드 모두 Pod를 만든 뒤에는 바꿀 수 없습니다.

### 2-6. Secret 저장 시 암호화(EncryptionConfiguration)

<details>
<summary>기초부터: etcd에 Secret을 암호화해 넣는 원리</summary>

> **핵심 한 줄**: API 서버가 etcd에 쓰기 직전에 암호화하고 읽은 직후 복호화합니다. kubectl로 보는 값은 그대로이고 etcd 안의 바이트만 암호문이 됩니다.

#### 1. 왜 필요한가

Secret은 base64일 뿐이라 etcd 데이터 디렉터리나 etcd 백업 스냅숏을 손에 넣은 사람은 `etcdctl get /registry/secrets/<네임스페이스>/<이름>`으로 비밀번호를 평문으로 읽습니다.

| 경로 | RBAC로 막히나 | 저장 시 암호화로 막히나 |
|---|---|---|
| kubectl → API 서버 → etcd | 막힘 | 해당 없음(API 서버가 복호화해 돌려줌) |
| etcd 데이터 디렉터리, 스냅숏 직접 읽기 | 안 막힘 | 막힘 |

#### 2. 어떻게 동작하나

```text
쓰기: kubectl → kube-apiserver ─암호화→ etcd   (값이 k8s:enc:aescbc:v1:key1: 접두어로 시작)
읽기: kubectl ← kube-apiserver ←복호화─ etcd
```

1. **설정 파일 작성**: `EncryptionConfiguration` 파일에 대상 리소스(`secrets`)와 공급자(provider) 목록을 적습니다.
2. **쓸 때**: 목록의 첫 번째 공급자로 암호화합니다. `identity: {}`(암호화하지 않음)가 첫 번째면 설정을 넣어도 평문으로 저장됩니다.
3. **읽을 때**: 저장된 값의 접두어에 맞는 공급자를 목록에서 찾아 복호화합니다. 설정 전에 평문으로 저장된 Secret을 계속 읽으려면 `identity`를 목록 아래쪽에 남겨 둡니다.
4. **API 서버에 연결**: kube-apiserver는 static Pod 안의 컨테이너라서 호스트 파일을 그냥 읽지 못합니다. 설정 파일이 든 디렉터리를 hostPath 볼륨으로 마운트하고 `--encryption-provider-config`에는 컨테이너 안의 경로를 적습니다.
5. **기존 Secret 다시 쓰기**: 암호화는 쓰는 순간에만 일어나므로 이미 있던 Secret은 `kubectl get secrets -A -o json | kubectl replace -f -`로 한 번씩 다시 써야 암호문으로 바뀝니다.

#### 3. 공급자 고르기

"Encrypting Confidential Data at Rest" 문서의 공급자 표 기준입니다.

| 공급자 | 강도 | 키 |
|---|---|---|
| `kms` v2(1.29 stable) | 가장 강함. 키를 외부 KMS에 맡김 | 외부 KMS |
| `secretbox` | Strong | 32바이트 |
| `aescbc` | Weak. CBC 패딩 오라클 취약점 때문에 권하지 않음 | 16, 24, 32바이트 |
| `aesgcm` | 키 순환을 자주 해야 함 | 16, 24, 32바이트 |
| `identity` | 암호화 없음 | 없음 |

과제가 `aescbc`를 지정하면 그대로 씁니다. 키는 `head -c 32 /dev/urandom | base64`로 만듭니다.

#### 4. 헷갈리는 점

- `identity`를 맨 위에 두면 설정이 들어가 있어도 새 Secret이 평문으로 저장됩니다.
- 설정을 켠 뒤에도 기존 Secret은 다시 쓰기 전까지 평문입니다.
- 매니페스트에 hostPath 마운트를 빠뜨리면 kube-apiserver가 설정 파일을 찾지 못해 뜨지 못하고 그동안 `kubectl`이 응답하지 않습니다.

#### 5. 파일 두 개의 뼈대

설정 파일과 kube-apiserver 매니페스트에서 손대는 자리만 모았습니다. 경로 `/etc/kubernetes/enc`는 예로 든 값입니다.

```yaml
# /etc/kubernetes/enc/enc.yaml (컨트롤 플레인 노드의 호스트 파일)
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
  - resources:
      - secrets
    providers:
      - aescbc:                    # 첫 번째: 새로 쓰는 값은 이것으로 암호화
          keys:
            - name: key1
              secret: <head -c 32 /dev/urandom | base64 결과>
      - identity: {}               # 설정 전 평문 Secret 읽기용
```

```yaml
# /etc/kubernetes/manifests/kube-apiserver.yaml 일부
spec:
  containers:
    - command:
        - kube-apiserver
        - --encryption-provider-config=/etc/kubernetes/enc/enc.yaml   # 컨테이너 안 경로
      volumeMounts:
        - name: enc
          mountPath: /etc/kubernetes/enc
          readOnly: true
  volumes:
    - name: enc
      hostPath:
        path: /etc/kubernetes/enc    # 호스트 경로
        type: DirectoryOrCreate
```

| 확인할 것 | 방법 |
|---|---|
| API 서버가 다시 떴나 | `kubectl get pods -n kube-system`에 `kube-apiserver-<노드>`가 Running |
| 새 Secret이 암호문인가 | `etcdctl get /registry/secrets/<ns>/<이름> \| hexdump -C`(인증서 옵션 생략)에 `k8s:enc:aescbc:v1:key1` 접두어 |

> **정리**: 첫 번째 공급자로 쓰고 접두어로 읽습니다. 실수가 나오는 곳은 공급자 순서, 기존 Secret 다시 쓰기, hostPath 마운트입니다.

</details>

저장 시 암호화 설정은 CKS 커리큘럼 항목이라 원리만 적습니다. kube-apiserver에 `--encryption-provider-config`로 `EncryptionConfiguration` 파일을 주고 그 디렉터리를 static Pod 매니페스트에 hostPath로 마운트합니다. 공급자 목록의 첫 항목으로 쓰고 읽을 때는 목록 순서대로 맞는 공급자를 찾으니 `aescbc` 같은 암호화 공급자를 맨 위에, 옛 평문을 읽을 `identity: {}`를 그 아래에 둡니다. 켠 뒤에는 `kubectl get secrets -A -o json | kubectl replace -f -`로 기존 Secret을 다시 써야 암호화됩니다. 전체 예제는 "Encrypting Confidential Data at Rest" 문서에 있습니다.

### 2-7. 비공개 레지스트리와 imagePullSecrets

<details>
<summary>기초부터: 이미지 이름 읽는 법과 이미지를 받는 주체</summary>

> **핵심 한 줄**: 이미지 이름은 `[레지스트리 호스트]/[경로]/[이미지 이름]:[태그]`이고 이미지를 받는 주체는 Pod가 배치된 노드의 kubelet과 컨테이너 런타임입니다.

#### 1. 이미지 이름 읽기

경로는 보통 계정이나 프로젝트 이름이고 생략한 부분에는 기본값이 채워집니다.

| 적은 이름 | 실제로 받는 이미지 |
|---|---|
| `nginx` | `docker.io/library/nginx:latest` |
| `bitnami/redis:7.2` | `docker.io/bitnami/redis:7.2` |
| `registry.k8s.io/pause:3.10` | 쿠버네티스 프로젝트 레지스트리의 이미지 |
| `registry.shop.example/shop/order-api:1.0` | 비공개 레지스트리의 이미지 |

| 생략한 부분 | 채워지는 기본값 |
|---|---|
| 레지스트리 호스트 | Docker Hub(`docker.io`) |
| 경로 | Docker 공식 이미지 모음 `library` |
| 태그 | `latest` |

- 쿠버네티스 구성요소 이미지는 2023년부터 `registry.k8s.io`에서 받고 옛 `k8s.gcr.io`는 동결됐습니다.
- 비공개 레지스트리 이미지는 호스트를 빼면 Docker Hub에서 찾다가 실패하므로 전체 경로를 적습니다.

#### 2. 누가 어떻게 받나

노드에서 사람이 `docker login`을 하듯 비밀번호를 칠 수는 없으니 자격 증명을 Secret으로 클러스터에 넣어 두고 Pod가 그 이름을 알려 주는 구조입니다.

1. **Secret 준비**: `docker-registry` 타입 Secret에 레지스트리 주소와 계정을 넣습니다. 옛 강의 예시에 붙는 `--docker-email`은 kubectl 문서상 선택 항목이라 빼도 됩니다. `--docker-server`를 빼면 기본값 `https://index.docker.io/v1/`(Docker Hub)이 들어가니 비공개 레지스트리는 주소를 꼭 적습니다.
2. **Pod에 이름 적기**: Pod spec의 `imagePullSecrets`에 Secret 이름을 적습니다. 컨테이너가 생기기 전에 노드가 쓰는 값이라 `containers` 항목 안에 들어가지 않고 Pod spec 높이에 있습니다.
3. **kubelet이 전달**: Pod가 배치되면 kubelet이 Secret을 읽어 자격 증명을 런타임에 넘깁니다.
4. **런타임이 pull**: 런타임(containerd 등)이 인증하고 이미지를 받습니다.

```text
kubelet ──CRI(pull 요청 + 자격 증명)──> containerd ──HTTPS──> 레지스트리
   ↑
imagePullSecrets의 Secret을 API 서버에서 읽음
```

#### 3. 언제 다시 받나 (imagePullPolicy)

| 조건(적지 않았을 때 기본값) | 정책 | 동작 |
|---|---|---|
| 태그가 `latest`이거나 없음 | `Always` | 매번 레지스트리 확인 |
| 그 밖의 태그 | `IfNotPresent` | 노드에 있으면 그대로 사용 |

운영에서 `latest`를 피하는 이유는 같은 이름이 다른 이미지를 가리킬 수 있어 어떤 버전이 돌고 있는지 알기 어렵기 때문입니다.

#### 4. 실전에서 보이는 모습

| STATUS | 뜻 |
|---|---|
| `ErrImagePull` | pull이 실패함(이름 오타, 태그 없음, 인증 실패) |
| `ImagePullBackOff` | 실패가 반복되어 재시도 간격이 벌어지는 중 |

원인은 `kubectl describe pod`의 Events에 남습니다.

> **정리**: `ErrImagePull`이 보이면 Events에서 이름 오타인지 인증 실패인지부터 가립니다. 비공개 레지스트리는 호스트까지 적은 전체 이름과 Pod spec 높이의 `imagePullSecrets`가 함께 있어야 kubelet이 받아 옵니다.

</details>

비공개 레지스트리 이미지는 호스트를 이미지 이름에 적고(`registry.shop.example/shop/order-api:1.0`) 자격 증명을 `docker-registry` 타입 Secret으로 만들어 Pod spec의 `imagePullSecrets`(`containers`와 같은 높이)에 이름을 적습니다. Secret은 Pod와 같은 네임스페이스에 있어야 합니다. 자격 증명이 틀리면 Pod가 `ErrImagePull`을 거쳐 `ImagePullBackOff`로 남고 Events에 인증 실패가 찍힙니다.

```bash
kubectl create secret docker-registry shop-registry -n shop \
  --docker-server=registry.shop.example \
  --docker-username=<사용자> --docker-password=<비밀번호>

# ServiceAccount에 붙여 새 Pod에 자동으로 채우기
kubectl patch serviceaccount default -n shop \
  -p '{"imagePullSecrets": [{"name": "shop-registry"}]}'
```

ServiceAccount에 붙이면 이후 새로 만드는 Pod에 `ServiceAccount` 승인 컨트롤러가 값을 채웁니다. 이미 떠 있는 Pod에는 들어가지 않습니다.

htpasswd 인증 `registry:2`로 확인한 Events 문구는 Secret이 없으면 `authorization failed: no basic auth credentials`, 비밀번호가 틀리면 `... manifests/1.0: 401 Unauthorized`입니다.

### 2-8. securityContext의 runAsUser와 capabilities

<details>
<summary>기초부터: 컨테이너의 root와 capabilities</summary>

> **핵심 한 줄**: 컨테이너 안 root는 보통 호스트에서도 UID 0입니다. 런타임이 capability 묶음을 줄여 둘 뿐이라 securityContext로 UID와 capability를 직접 좁힙니다.

#### 1. 왜 필요한가

이미지 대부분은 따로 정하지 않으면 컨테이너 안 프로세스를 root(UID 0)로 실행합니다. 컨테이너는 호스트 커널을 함께 쓰는 프로세스이고 네임스페이스로 보이는 범위만 가린 것입니다.

- Pod에 `hostUsers: false`(사용자 네임스페이스)를 적지 않는 한 컨테이너 안의 UID 0은 호스트에서도 UID 0입니다. Docker도 사용자 네임스페이스 매핑(dockerd의 `--userns-remap`)을 기본으로 꺼 두어 같은 상황입니다.
- 앱 취약점으로 셸을 빼앗기거나 hostPath로 호스트 파일이 마운트되어 있으면 피해가 그대로 커집니다.

#### 2. 어떻게 동작하나

1. **root 특권 쪼개기**: 리눅스는 root의 특권을 `NET_ADMIN`(네트워크 설정 변경), `SYS_TIME`(시스템 시계 변경), `CHOWN`(파일 소유자 변경)처럼 수십 개 조각으로 나눠 둡니다. 이 조각이 **capability**입니다.
2. **런타임의 기본 묶음**: 컨테이너 런타임은 root 프로세스에게도 기본 묶음만 주고 위험한 조각은 빼고 시작합니다.
3. **securityContext로 조정**: 그 위에서 UID를 바꾸거나 조각을 더하고 뺍니다.

```text
호스트 root: 모든 capability
   └─ 런타임 기본 묶음: 위험한 조각을 뺀 일부
         └─ securityContext: drop으로 더 빼거나 add로 하나씩 더함
               └─ privileged: true 는 이 단계를 건너뛰고 전부 줌
```

#### 3. 한눈에 비교

| 필드 | 뜻 | 적는 곳 |
|---|---|---|
| `runAsUser`, `runAsGroup` | 프로세스를 이 UID, GID로 실행 | Pod, 컨테이너 |
| `runAsNonRoot: true` | UID 0으로 시작하려 하면 kubelet이 컨테이너 시작을 거부 | Pod, 컨테이너 |
| `capabilities.add`, `capabilities.drop` | 기본 묶음에 조각을 더하거나 뺌 | 컨테이너만 |
| `allowPrivilegeEscalation: false` | setuid 프로그램 등으로 권한이 커지는 것을 막음 | 컨테이너만 |
| `privileged: true` | 모든 capability와 호스트 장치 접근을 줌. 사실상 호스트 root | 컨테이너만 |

| Docker 옵션 | securityContext |
|---|---|
| `docker run --user 1000` | `runAsUser: 1000` |
| Dockerfile의 `USER 1000` | 이미지 기본 UID. `runAsUser`를 적으면 Pod 값이 이김 |
| `--cap-add NET_ADMIN` | `capabilities.add: ["NET_ADMIN"]` |
| `--cap-drop ALL` | `capabilities.drop: ["ALL"]` |
| `--privileged` | `privileged: true` |

UID 1000은 리눅스 배포판이 첫 일반 사용자에게 주는 번호라 예시에 자주 나옵니다.

#### 4. 헷갈리는 점

- **Pod 수준과 컨테이너 수준**: Pod에 적은 값은 모든 컨테이너에 기본값처럼 깔리고 컨테이너에 같은 필드가 있으면 컨테이너 값이 이깁니다.
- **capabilities가 컨테이너에만 있는 이유**: 컨테이너마다 필요한 커널 권한이 다르기 때문에 API는 capabilities를 컨테이너 단위로만 둡니다. Pod 수준에 적으면 스키마 검증에서 걸립니다.
- **`MAC_ADMIN`은 MAC 주소와 무관**: 이름의 MAC은 강제 접근 제어(Mandatory Access Control)입니다. capabilities(7) 매뉴얼 기준으로 `CAP_MAC_ADMIN`은 Smack 같은 보안 모듈(LSM)의 설정을 바꾸는 권한입니다. 네트워크 장치의 MAC 주소를 바꾸는 일은 `NET_ADMIN`이 맡습니다.
- **`runAsNonRoot: true`인데 이미지가 root로 돌게 되어 있으면**: 컨테이너가 시작되지 않고 STATUS에 `CreateContainerConfigError`가 보입니다. `runAsUser`로 0이 아닌 UID를 함께 적으면 풀립니다.

> **정리**: UID는 `runAsUser`, 커널 권한 조각은 `capabilities`로 좁힙니다. `privileged: true`는 이 모든 제한을 푸는 값이라 꼭 필요할 때만 씁니다.

</details>

과제 지문에 나오면 문서에서 찾아 쓰는 정도로 알아 둡니다. Pod 수준(`spec.securityContext`)은 모든 컨테이너에, 컨테이너 수준은 그 컨테이너에만 적용되고 같은 필드가 두 곳에 있으면 컨테이너 수준이 이깁니다. `capabilities`는 컨테이너 수준에만 있습니다.

```yaml
spec:
  securityContext:
    runAsUser: 1000              # 모든 컨테이너 UID 1000
  containers:
    - name: api
      image: busybox:1.36
      command: ["sleep", "3600"]
      securityContext:
        capabilities:
          add: ["NET_ADMIN"]
```

Pod 수준에 `capabilities`를 적으면 `strict decoding error: unknown field "spec.securityContext.capabilities"`로 거절됩니다. 확인은 `kubectl exec <pod> -c api -- id`와 `grep Cap /proc/1/status`로 합니다. root가 아닌 UID의 프로세스는 `NET_ADMIN`을 더해도 `CapBnd`에만 들어가고 실제로 쓰이는 `CapEff`는 0입니다.

### 2-9. 직접 해 보기

2-3절 뼈대에 `subPath` 마운트를 하나 더하고 `kubectl edit configmap`으로 `PAGE_SIZE`를 20에서 50으로 바꿉니다. `kubectl exec`로 보면 볼륨 파일은 1분 안팎에 50이 되고 환경 변수와 `subPath` 파일은 20에 머뭅니다.

## 3. 워크로드 자동 확장

<details>
<summary>기초부터: 확장의 두 방향과 두 층</summary>

> **핵심 한 줄**: 확장은 개수를 늘리는 수평과 크기를 키우는 수직 두 방향이 있고 쿠버네티스는 이것을 Pod 층과 노드 층에서 따로 합니다.

#### 1. 왜 필요한가

| 방향 | 하는 일 | 물리 서버 시절 |
|---|---|---|
| 수직 확장(scale up) | 한 대의 자원을 키움 | CPU나 메모리를 더하려면 서버를 꺼야 해서 중단이 따름 |
| 수평 확장(scale out) | 같은 것을 여러 개 둠 | 기존 것을 멈추지 않고 대수만 늘려 서비스를 끊지 않고 부하를 나눔 |

#### 2. 두 층

| 층 | 수평(개수) | 수직(크기) |
|---|---|---|
| 워크로드(Pod) | 수동 `kubectl scale`, 자동 HPA(3-1절) | 수동 resources 수정이나 in-place resize, 자동 VPA(3-3절) |
| 클러스터(노드) | 수동은 VM을 만들어 `kubeadm join`, 자동은 Cluster Autoscaler 같은 노드 오토스케일러 | 노드 VM의 사양 변경. 보통 큰 노드를 새로 넣고 옛 노드를 drain해 대신함 |

#### 3. 두 층이 맞물리는 순서

1. **Pod 늘리기**: 트래픽이 늘면 HPA가 레플리카를 늘립니다.
2. **자리 부족**: 노드에 남은 자리(request 기준)가 모자라면 새 Pod가 `Pending`으로 남습니다.
3. **노드 늘리기**: Cluster Autoscaler가 자원 부족으로 `Pending`인 Pod를 보고 클라우드 API로 노드를 추가합니다.
4. **배치**: 새 노드가 붙으면 스케줄러가 `Pending` Pod를 그 노드에 놓습니다.
5. **줄이기**: 부하가 줄면 HPA가 레플리카를 줄이고 Cluster Autoscaler는 Pod를 다른 노드로 옮길 수 있는 한산한 노드를 비워 반납합니다.

```text
트래픽 증가 → HPA: replicas 3 → 6
           → 자리 부족: 새 Pod 2개 Pending
           → Cluster Autoscaler: 노드 추가
           → 스케줄러: Pending Pod를 새 노드에 배치
```

#### 4. 시험 범위

Cluster Autoscaler와 Karpenter 같은 노드 오토스케일러는 클라우드 API와 붙어 도는 별도 구성요소라서 kubeadm으로 만든 시험 클러스터에는 없습니다. 커리큘럼 문구도 워크로드 자동 확장이라 이 장은 Pod 층만 다룹니다.

> **정리**: HPA가 레플리카를 늘려도 노드 자리가 모자라면 새 Pod는 `Pending`에 머뭅니다. 시험 클러스터에는 노드를 늘려 줄 오토스케일러가 없어서 이 장은 Pod 층의 HPA(개수)와 VPA(크기)만 봅니다.

</details>

커리큘럼 문구는 "Configure workload autoscaling"입니다. "Autoscaling Workloads" 문서는 수평 확장(Pod 수)과 수직 확장(Pod에 주는 자원)을 나눕니다.

### 3-1. HPA가 레플리카 수를 고르는 방식

<details>
<summary>기초부터: HPA 한 바퀴와 Metrics Server</summary>

> **핵심 한 줄**: HPA는 목표치만 적어 둔 객체이고 kube-controller-manager 안의 HPA 컨트롤러가 15초마다 metrics-server 값을 읽어 `replicas`를 다시 씁니다.

#### 1. 왜 필요한가

| 방식 | 문제 |
|---|---|
| 사람이 `kubectl top`을 보다가 `kubectl scale` | 부하가 몰린 순간부터 명령을 치기까지 기존 Pod가 버티지 못함. 밤에는 볼 사람이 없음 |
| HPA | 목표치(예: CPU 평균 사용률 60%)와 최소, 최대 레플리카만 적으면 컨트롤러가 계속 맞춤 |

HPA 객체에는 대상 워크로드(Deployment, StatefulSet 등), 목표치, 최소와 최대 레플리카를 적습니다. 객체가 스스로 계산하지는 않습니다.

#### 2. 어떻게 동작하나

```text
각 노드 kubelet ──/metrics/resource──> metrics-server ──metrics.k8s.io API──> HPA 컨트롤러
                                                                            │ 15초마다 계산
                                                                            ▼
                                           대상 Deployment의 scale 하위 리소스에 replicas 기록
                                                                            ▼
                                           Deployment → ReplicaSet → Pod 생성 또는 삭제
```

1. **수집**: 각 노드의 kubelet이 컨테이너 CPU와 메모리 사용량을 내놓고 metrics-server가 이를 모아 `metrics.k8s.io` API로 제공합니다.
2. **평균 내기**: HPA 컨트롤러가 15초마다 대상 Pod들의 사용량을 가져와 request 대비 사용률의 평균을 냅니다.
3. **계산**: 아래 식으로 원하는 레플리카 수를 구하고 최소와 최대 사이로 자릅니다.
4. **기록**: 결과를 대상의 `scale` 하위 리소스에 씁니다. Pod를 실제로 늘리고 줄이는 일은 Deployment와 ReplicaSet 컨트롤러가 평소대로 합니다.

#### 3. 최소와 최대를 두는 이유

| 값 | 막는 것 |
|---|---|
| `maxReplicas` | 메트릭이 튀거나 비정상 트래픽이 몰려도 Pod가 끝없이 늘어 클러스터 자원을 다 먹는 일 |
| `minReplicas` | 조용한 시간에 가용성이 바닥까지 떨어지는 일 |

#### 4. 실전에서 보이는 모습

| 증상 | 원인 |
|---|---|
| `kubectl get hpa`의 `TARGETS`가 `cpu: <unknown>/60%` | metrics-server가 없거나 아직 값을 못 받음. HPA 컨트롤러는 사용량을 직접 재지 못해 아무것도 하지 않음 |
| CPU 사용률이 계산되지 않음 | 대상 컨테이너에 CPU request가 없음(사용률의 분모가 request) |
| 초당 요청 수로 확장하고 싶음 | Prometheus Adapter 같은 어댑터가 `custom.metrics.k8s.io`나 `external.metrics.k8s.io` API를 제공해야 함 |

> **정리**: metrics-server가 재고 HPA 컨트롤러가 계산하고 Deployment가 Pod를 바꿉니다. 셋 중 하나라도 빠지면 `TARGETS`부터 확인합니다.

</details>

HorizontalPodAutoscaler는 컨트롤 플레인의 컨트롤러가 기본 15초마다 계산합니다.

```text
desiredReplicas = ceil[currentReplicas * ( currentMetricValue / desiredMetricValue )]
```

레플리카 3개, 평균 CPU 90%, 목표 60%면 4.5를 올려 5개입니다. 비율이 허용 범위(tolerance, 기본 10%) 안이면 움직이지 않고 축소는 기본 300초 안정화 구간을 거칩니다.

사용률은 각 Pod의 컨테이너 request 대비 백분율입니다. 일부 컨테이너에 해당 자원의 request가 없으면 그 Pod의 사용률이 정의되지 않아 오토스케일러가 아무것도 하지 않습니다. 이때 `kubectl get hpa`의 `TARGETS`는 `cpu: <unknown>/60%`이고 `kubectl describe hpa`의 조건에 원인이 문장으로 찍힙니다.

```text
ScalingActive  False  FailedGetResourceMetric  ... missing request for cpu in container nginx of Pod ...
```

메트릭은 Metrics Server가 제공하는 `metrics.k8s.io` API에서 옵니다. 1.37에서 이 API의 `v1`이 stable이 됐고 전환 기간에는 `v1beta1`도 쓰입니다. `kubectl top pods`가 동작하면 Metrics Server는 살아 있습니다.

### 3-2. 시험에서 쓰는 명령

```bash
kubectl top pods -n shop        # Metrics Server가 동작하는지 확인

kubectl autoscale deployment order-api -n shop --cpu=60% --min=2 --max=8
kubectl get hpa -n shop
kubectl describe hpa order-api -n shop
```

`kubectl autoscale`의 옵션은 1.34부터 `--cpu`와 `--memory`입니다. 값에 `%`를 붙이면 평균 사용률이 목표이고 단위 없이 `500`만 쓰면 CPU는 `500m`, 메모리는 `500Mi`의 평균 값으로 읽습니다. 옛 강의의 `--cpu-percent`는 `Flag --cpu-percent has been deprecated` 경고와 함께 아직 동작하고 `--cpu`와 함께 주면 `error: --cpu-percent and --cpu are mutually exclusive`가 납니다.

명령으로 줄 수 없는 값은 `autoscaling/v2` YAML로 씁니다. "HorizontalPodAutoscaler Walkthrough" 문서에서 복사하면 빠릅니다.

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: order-api
  namespace: shop
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: order-api
  minReplicas: 2
  maxReplicas: 8
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 60
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
    scaleUp:
      tolerance: 0.05             # 1.37 stable. 목표보다 5% 넘게 높을 때만 확장
```

`tolerance`는 수량 타입이라 저장된 값을 읽으면 `"50m"`으로 나옵니다. 필드가 없으면 kube-controller-manager의 `--horizontal-pod-autoscaler-tolerance`(기본 0.1)가 쓰입니다. 1.37에서는 `HPAScaleToZero`가 beta로 기본 활성이 되어 Object나 External 메트릭을 쓰는 HPA에 한해 `minReplicas: 0`을 허용합니다. CPU와 메모리 같은 Resource 메트릭만 쓰는 HPA에 0을 적으면 거절됩니다.

```text
spec.metrics: Forbidden: must specify at least one Object or External metric to support scaling to zero replicas
```

kind에서 레플리카 2개가 `cpu: 78%/60%`가 되자 `ceil(2 × 78/60) = 3`으로 늘며 `New size: 3; reason: cpu resource utilization (percentage of request) above target`이 남았습니다.

### 3-3. VPA

<details>
<summary>기초부터: VPA의 세 구성요소와 in-place resize가 생긴 이유</summary>

> **핵심 한 줄**: VPA는 실제 사용량을 보고 requests를 맞춰 주는 애드온이고 in-place resize는 그 값을 Pod를 다시 만들지 않고 cgroup 한도만 바꿔 반영하는 기능입니다.

#### 1. 왜 필요한가

requests를 얼마로 잡아야 할지 처음에는 모릅니다.

| requests를 | 결과 |
|---|---|
| 크게 잡으면 | 노드 자리를 낭비 |
| 작게 잡으면(limit도 작게) | CPU 스로틀링이나 `OOMKilled` |

실제 사용량을 보고 값을 맞춰 주는 것이 수직 자동 확장입니다.

#### 2. 세 구성요소

VPA는 쿠버네티스 본체에 없는 애드온이라 설치하면 `kube-system`에 아래 셋이 뜹니다.

| 구성요소 | 하는 일 |
|---|---|
| Recommender | metrics API에서 사용량 이력을 모아 컨테이너별 권장값(Target, Lower Bound, Upper Bound)을 계산해 VPA 객체의 `.status`에 적습니다. Pod는 건드리지 않습니다 |
| Updater | 권장값과 크게 어긋난 Pod를 찾아 축출(evict)하거나 제자리 resize를 요청합니다. 축출할 때 PDB를 지키고 기본 설정에서는 레플리카가 2개 미만인 워크로드를 건드리지 않습니다. 이 하한은 Updater 설정값이고 VPA 객체의 `updatePolicy.minReplicas`로 바꿀 수 있습니다 |
| Admission Controller | Pod 생성 요청을 가로채는 mutating 웹훅입니다. 새 Pod의 requests와 limits를 권장값으로 바꿔 넣습니다 |

#### 3. 어떻게 동작하나 (Recreate 모드)

1. **권장값 계산**: Recommender가 권장값을 계산합니다.
2. **축출**: Updater가 값이 어긋난 Pod를 축출합니다.
3. **다시 요청**: Deployment가 모자란 Pod를 채우려고 새 Pod를 요청합니다.
4. **값 바꿔 넣기**: Admission Controller가 그 요청의 resources를 권장값으로 고칩니다.
5. **새 값으로 시작**: 새 값으로 Pod가 뜹니다. 다시 만들어지는 동안 그 복제본은 요청을 받지 못합니다.

```text
Recreate      : Recommender → Updater(축출) → 새 Pod 요청 → Admission(값 교체) → 재시작
InPlace 계열  : Recommender → Updater(resize 요청) → kubelet이 cgroup 한도만 변경 → 프로세스 유지
```

#### 4. in-place resize가 생긴 이유

| 구분 | 예전 | in-place resize |
|---|---|---|
| resources 변경 | Pod를 다시 만들어야 함 | kubelet이 실행 중인 컨테이너의 cgroup 한도만 바꿈 |
| 프로세스 | 새로 시작. 메모리 캐시를 올려 둔 앱이나 시작이 오래 걸리는 앱에는 비용이 큼 | 살려 둔 채 CPU와 메모리를 고침 |
| 버전 | 해당 없음 | 1.33 beta 기본 활성, 1.35 GA. 기능 게이트를 따로 켤 일이 없음 |

VPA의 `InPlaceOrRecreate`, `InPlace` 모드가 이 기능을 씁니다.

**resizePolicy**: 자원마다 바꿀 때 컨테이너 재시작이 필요한지 적습니다. 앱(예: JVM 힙)이 시작할 때 읽은 메모리 한도를 계속 쓰는 경우 재시작해야 새 한도를 알아차리므로 메모리에 `RestartContainer`를 두기도 합니다.

```yaml
resizePolicy:
  - resourceName: cpu
    restartPolicy: NotRequired        # 기본. 재시작 없이 cgroup만 바꿈
  - resourceName: memory
    restartPolicy: RestartContainer   # 메모리를 바꾸면 컨테이너 재시작
```

#### 5. 한계

- CPU와 메모리만 바꿀 수 있고 QoS 클래스가 달라지는 변경은 거절됩니다.
- 대상 컨테이너에도 제한이 있습니다. 일반 init 컨테이너와 임시(ephemeral) 컨테이너는 바꿀 수 없고 사이드카(`restartPolicy: Always`인 init 컨테이너)는 바꿀 수 있습니다. Windows Pod는 지원하지 않습니다(1.37 문서의 Limitations 절).
- 한 번 적은 request와 limit을 아예 지우는 변경도 받지 않습니다. 다른 값으로 바꾸는 것만 됩니다.
- 메모리 limit을 줄이면 kubelet이 현재 사용량이 새 limit보다 큰지 best-effort로 확인하고 크면 resize를 미뤄 둡니다. 확인한 직후 사용량이 튀는 것까지는 막지 못합니다.

#### 6. HPA와 VPA 고르기

| 구분 | HPA | VPA |
|---|---|---|
| 바꾸는 것 | Pod 개수 | Pod 하나의 requests와 limits |
| 기존 Pod | 그대로 두고 새 Pod를 더함 | `Recreate`면 축출 뒤 다시 만듦. `InPlace` 계열이면 제자리 resize |
| 갑작스러운 부하 | 복제본을 늘려 바로 나눔 | 새 값으로 다시 뜨는 시간만큼 늦음 |
| 잘 맞는 워크로드 | 복제본을 늘리기 쉬운 무상태 웹, API | 복제본을 늘리기 어렵거나 Pod 하나의 크기를 맞춰야 하는 워크로드 |

- 같은 Deployment에 HPA와 VPA를 둘 다 CPU나 메모리 기준으로 걸면 VPA가 requests를 바꿀 때마다 HPA 사용률의 분모가 달라집니다. kubernetes/autoscaler 저장소의 VPA README는 이 조합을 권하지 않고 함께 쓸 때는 HPA를 사용자 정의 메트릭이나 외부 메트릭 기준으로 두라고 적습니다.
- 권장값은 `kubectl describe vpa`의 `Target`(권장), `Lower Bound`(하한), `Upper Bound`(상한)로 봅니다.

> **정리**: 계산은 Recommender, 반영은 Updater와 Admission Controller가 나눠 맡습니다. 같은 Deployment에 HPA가 CPU나 메모리 기준으로 걸려 있으면 VPA를 함께 걸지 않거나 HPA를 사용자 정의, 외부 메트릭 기준으로 둡니다.

</details>

VerticalPodAutoscaler는 사용량에 맞춰 requests와 limits를 조정합니다. "Vertical Pod Autoscaling" 문서 기준으로 CRD(`autoscaling.k8s.io/v1`)로 정의되어 따로 설치해야 하고 예시가 적어서 `kubectl explain`으로 필드를 찾습니다. 설치는 kubernetes/autoscaler 저장소의 `vertical-pod-autoscaler` 디렉터리에서 `./hack/vpa-up.sh`를 실행합니다. 아래 출력은 1.8.0에서 얻은 것이고 2026년 10월 21일에 1.8.1이 나왔습니다.

```bash
kubectl get crd | grep verticalpodautoscaler
kubectl explain vpa.spec
kubectl explain vpa.spec.resourcePolicy.containerPolicies
kubectl describe vpa order-api -n shop           # 권장값(Target, Lower/Upper bound)
```

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: order-api
  namespace: shop
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: order-api
  updatePolicy:
    updateMode: "Off"              # 권장값만 계산
  resourcePolicy:
    containerPolicies:
      - containerName: "*"
        minAllowed: { cpu: 100m, memory: 64Mi }
        maxAllowed: { cpu: "1", memory: 512Mi }
```

이 YAML을 VPA 1.8.0에 적용한 뒤의 `describe vpa`입니다. `Target`은 `Uncapped Target`을 `minAllowed`로 올린 값입니다.

```text
    Container Recommendations:
      Container Name:  nginx
      Lower Bound:     Cpu: 100m   Memory: 250Mi
      Target:          Cpu: 100m   Memory: 250Mi
      Uncapped Target: Cpu: 25m    Memory: 250Mi
      Upper Bound:     Cpu: 1      Memory: 512Mi
```

`updateMode`는 `Off`(권장값만 `.status`에 둠), `Initial`(새 Pod에만 적용), `Recreate`(Pod를 내보내고 새 Pod에 적용), `InPlaceOrRecreate`(제자리 resize를 먼저 시도), `InPlace`(제자리 resize만) 중 하나입니다. 옛 자료의 `Auto`는 VPA 1.4.0부터 deprecated된 `Recreate`의 별칭입니다. 설치된 VPA 버전에 따라 `InPlace` 계열 값이 없을 수 있으니 `kubectl explain vpa.spec.updatePolicy`로 확인합니다.

수직 확장의 다른 길은 in-place resize입니다. 실행 중인 컨테이너의 CPU와 메모리를 Pod를 다시 만들지 않고 바꾸는 기능이고 1.35에서 stable이 됐습니다. Pod의 `resize` 하위 리소스에 패치하며 kubectl 1.32 이상이 필요합니다.

```bash
kubectl patch pod order-api-xxxx -n shop --subresource resize --patch \
  '{"spec":{"containers":[{"name":"nginx","resources":{"requests":{"cpu":"200m"},"limits":{"cpu":"200m"}}}]}}'
kubectl get pod order-api-xxxx -n shop -o jsonpath='{.status.containerStatuses[0].resources}'
```

컨테이너의 `resizePolicy`는 자원마다 `NotRequired`(기본, 재시작 없이 적용)나 `RestartContainer`입니다. QoS 클래스(5-2절)가 바뀌는 변경은 `Pod QOS Class may not change as a result of resizing`으로 거절되고 노드가 바로 들어주지 못하면 `PodResizePending` 조건이 붙습니다. Deployment가 관리하는 Pod를 이렇게 바꾸면 다음 롤아웃 때 템플릿 값으로 돌아갑니다.

### 3-4. 직접 해 보기

request 없는 `order-api`에 HPA를 만들어 `TARGETS`가 `cpu: <unknown>/60%`인지, describe에 `missing request for cpu`가 있는지 봅니다. `kubectl set resources deployment order-api -n shop --requests=cpu=100m` 뒤 `cpu: 0%/60%`로 바뀌면 Walkthrough 문서의 부하 Pod를 띄우고 `kubectl get hpa --watch`로 확장을 봅니다. kind에서는 metrics-server를 따로 넣고 `--kubelet-insecure-tls` 인자를 더해야 합니다([Ch-06](/blog/cert/cka/cka-06-troubleshooting) 3-4절).

## 4. 자가 치유를 만드는 기본 요소

커리큘럼 문구는 "Understand the primitives used to create robust, self-healing, application deployments"입니다. "Kubernetes Self-Healing" 문서 기준으로 컨테이너가 죽으면 kubelet이 `restartPolicy`대로 재시작하고 Pod가 죽으면 Deployment, StatefulSet, DaemonSet 컨트롤러가 대체 Pod를 만듭니다. 준비되지 않은 Pod는 Service 엔드포인트에서 빠집니다.

### 4-1. restartPolicy와 CrashLoopBackOff

Pod의 `restartPolicy`는 `Always`(기본), `OnFailure`, `Never`입니다. Deployment에서는 `Always`만 허용되고 Job은 `OnFailure`나 `Never`만 씁니다.

| 종료 코드 | Always | OnFailure | Never |
|---|---|---|---|
| 0(성공) | 재시작 | 재시작 안 함 | 재시작 안 함 |
| 0이 아님(실패) | 재시작 | 재시작 | 재시작 안 함 |

재시작 사이에는 지수 백오프가 붙습니다. "Pod Lifecycle" 문서 기준으로 10초, 20초, 40초처럼 늘고 300초에서 멈추며 컨테이너가 10분 동안 문제없이 돌면 초기화됩니다. `CrashLoopBackOff`는 이 백오프가 걸려 있다는 표시이고 원인은 `kubectl logs <pod> --previous`로 직전 컨테이너 로그에서 찾습니다.

1.35부터는 컨테이너에 `restartPolicy`와 `restartPolicyRules`(예: `exitCodes`가 `In [42]`일 때만 `Restart`)를 적어 Pod 값을 덮어쓸 수 있습니다(`ContainerRestartRules`, 1.35 beta 기본 활성). 규칙을 쓰면서 컨테이너 `restartPolicy`를 빠뜨리면 `must specify restartPolicy when restart rules are used`로 거절됩니다.

<details>
<summary>기초부터: 재시작이 점점 늦어지는 이유와 CrashLoopBackOff 읽기</summary>

> **핵심 한 줄**: `CrashLoopBackOff`는 원인을 알려 주지 않습니다. "이 컨테이너가 계속 죽어서 다음 재시작까지 기다리는 중"이라는 상태 표시일 뿐이고 진짜 원인은 직전 컨테이너의 로그와 종료 코드에 있습니다.

#### 1. 왜 기다렸다가 다시 띄우나

게시판 API가 시작하자마자 설정 파일을 못 찾아 죽는다고 해 보겠습니다. kubelet이 죽는 즉시 다시 띄우면 1초에도 몇 번씩 죽고 뜨기를 반복하면서 노드의 CPU와 로그만 채웁니다. 설정 파일이 없다는 원인은 재시작으로 고쳐지지 않으니 재시작 간격을 점점 벌려서 노드를 보호합니다.

#### 2. 시간표로 따라가기

문서 기준 간격(10초에서 시작해 두 배씩, 상한 300초)으로 계속 죽는 컨테이너를 따라가면 이렇습니다.

| 몇 번째 재시작 | 직전에 기다린 시간 | `RESTARTS` | `STATUS`에 보이는 것 |
|---|---|---|---|
| 1 | 10초 | 1 | 기다리는 동안 `CrashLoopBackOff` |
| 2 | 20초 | 2 | 〃 |
| 3 | 40초 | 3 | 〃 |
| 4 | 80초 | 4 | 〃 |
| 5 | 160초 | 5 | 〃 |
| 6부터 | 300초(상한) | 6, 7, … | 〃 |

기다리는 동안에는 컨테이너가 없어서 `kubectl logs <pod>`가 비어 있거나 오류를 냅니다. 그래서 `--previous`를 붙여 방금 죽은 컨테이너의 로그를 봅니다. 종료 코드는 `kubectl describe pod`의 `Last State: Terminated`에 `Exit Code`와 `Reason`으로 찍힙니다. `Reason: OOMKilled`(종료 코드 137)이면 메모리 limit 문제이고 `Error`에 코드 1이면 대개 앱이 스스로 끝난 경우입니다.

#### 3. 헷갈리는 점

- 원인을 고쳐도 백오프 대기는 남아 있습니다. 5분을 기다리기 싫으면 Pod를 지워 컨트롤러가 새 Pod를 만들게 합니다. 새 Pod는 백오프 기록이 없습니다.
- 백오프는 컨테이너가 10분 동안 문제없이 돌아야 초기화됩니다. 3분 돌다 죽는 앱은 간격이 계속 커집니다.

> **정리**: `RESTARTS`가 오르고 `CrashLoopBackOff`가 보이면 `logs --previous`와 `describe`의 `Last State`부터 봅니다. 재시작 간격은 증상이고 원인은 컨테이너 안에 있습니다.

</details>

### 4-2. 프로브 셋

| 프로브 | 실패하면 | 쓰는 자리 |
|---|---|---|
| startupProbe | 컨테이너를 죽이고 restartPolicy를 따름. 성공 전에는 나머지 두 프로브를 실행하지 않음 | 시작이 오래 걸리는 앱 |
| livenessProbe | 허용 횟수를 넘기면 컨테이너 재시작 | 살아는 있지만 진행하지 못하는 상태 |
| readinessProbe | 재시작은 안 함. Pod의 `Ready`가 false가 되고 EndpointSlice에서 Pod IP가 빠짐 | 트래픽을 받을 준비가 됐는지 |

기본값은 `periodSeconds` 10초, `timeoutSeconds` 1초, `failureThreshold` 3회, `initialDelaySeconds` 0초라서 liveness는 약 30초 연속 실패해야 재시작합니다. startupProbe는 `failureThreshold × periodSeconds`(아래 예는 300초)만큼 시작 시간을 벌어 줍니다.

```yaml
# 결제 API: 시작에 최대 5분, 이후 /healthz로 생존, /ready로 준비 확인
containers:
  - name: payment-api
    image: <이미지>
    startupProbe:
      httpGet: { path: /healthz, port: 8080 }
      failureThreshold: 30
      periodSeconds: 10
    livenessProbe:
      httpGet: { path: /healthz, port: 8080 }
    readinessProbe:
      httpGet: { path: /ready, port: 8080 }
```

`httpGet` 자리에 `exec: { command: ["cat", "/tmp/healthy"] }`나 `tcpSocket: { port: 5432 }`를 쓸 수 있습니다.

`<이미지>`를 45초 뒤 8080에서 응답하는 `busybox:1.36` httpd로 바꿔 돌리면 이 YAML은 `RESTARTS 0`으로 Ready가 되고 startupProbe를 지운 쪽은 `failed liveness probe, will be restarted`로 재시작을 반복했습니다.

<details>
<summary>기초부터: 프로브 셋이 각각 묻는 질문과 결제 API가 뜨는 1분</summary>

> **핵심 한 줄**: startupProbe는 "다 떴나?", livenessProbe는 "멈춰 버리지 않았나?", readinessProbe는 "지금 손님을 받아도 되나?"를 묻습니다. 실패했을 때 kubelet이 하는 일이 다르니 질문에 맞는 검사를 걸어야 합니다.

#### 1. 왜 셋이나 필요한가

`Running`은 프로세스가 떠 있다는 뜻일 뿐입니다. 결제 API가 떠는 있지만 아직 캐시를 채우는 중일 수도 있고 교착 상태(deadlock)에 빠져 요청을 하나도 처리하지 못할 수도 있습니다. 앞쪽은 기다리면 풀리고 뒤쪽은 다시 띄워야 풀립니다. 이 둘을 섞으면 기다려야 할 Pod를 죽이거나 죽여야 할 Pod를 계속 살려 둡니다.

| 프로브 | 묻는 질문 | 실패하면 | 비유 |
|---|---|---|---|
| startup | 시작이 끝났나 | 시작 실패로 보고 재시작 | 개점 준비가 끝났는지 |
| liveness | 아직 살아서 움직이나 | 재시작 | 직원이 쓰러지지 않았는지 |
| readiness | 지금 요청을 받아도 되나 | Service에서 잠시 뺌 | 계산대에 "잠시 닫음" 팻말 |

#### 2. 위 YAML로 1분 따라가기

앱이 45초 뒤에야 8080에서 응답한다고 하겠습니다. `periodSeconds` 10초라서 startupProbe는 0, 10, 20, 30, 40, 50초에 묻습니다.

| 시각 | 일어나는 일 |
|---|---|
| 0~40초 | startupProbe 5번 실패. 허용치가 30번이라 아무 일도 없음. liveness와 readiness는 아직 실행되지 않음 |
| 45초 | 앱이 응답하기 시작 |
| 50초 | startupProbe 성공. 이때부터 liveness와 readiness가 돌기 시작 |
| 50초 직후 | readinessProbe 성공 → `READY 1/1`, EndpointSlice에 Pod IP가 들어가 트래픽을 받음 |

startupProbe를 지우면 처음부터 liveness가 돕니다. 0, 10, 20초에 세 번 실패하면 재시작하고 앱은 45초까지 가 보지도 못한 채 다시 처음부터 시작합니다. 4-2절 마지막 문단의 `failed liveness probe, will be restarted` 반복이 이 장면입니다.

#### 3. 운영 중에 DB가 느려지면

결제 API의 `/healthz`가 DB 연결까지 확인하도록 짜여 있다고 해 보겠습니다. DB가 잠깐 느려지면 모든 Pod의 liveness가 동시에 실패하고 kubelet이 모든 Pod를 재시작합니다. 재시작으로 DB가 빨라지지는 않으니 얻는 것 없이 처리 중이던 요청만 잃습니다. 재시작한 Pod가 다시 뜨는 동안 남은 Pod에 부하가 몰려 그쪽 liveness까지 무너지는 연쇄도 생깁니다. 그래서 liveness는 프로세스 자신만 확인하고 DB 같은 외부 의존성은 넣지 않는 것이 정석입니다([Colin Breck, Kubernetes Liveness and Readiness Probes: How to Avoid Shooting Yourself in the Foot](https://blog.colinbreck.com/kubernetes-liveness-and-readiness-probes-how-to-avoid-shooting-yourself-in-the-foot/)). 같은 글은 readiness에 모든 Pod가 함께 쓰는 의존성을 넣어도 위험하다고 짚습니다. DB가 느려지는 순간 모든 Pod가 한꺼번에 Service에서 빠져 서비스 전체가 멈추기 때문입니다.

국내에서도 프로브 실패의 원인이 애플리케이션 쪽(DB 부하)에 있었고 프로브 동작 원리를 몰라 원인을 찾는 데 시간이 걸렸다는 경험담이 있습니다([악분, 쿠버네티스에 설정한 probe가 어떻게 실행되는지 알아야 하는 이유](https://akbun.substack.com/p/probe)).

#### 4. 헷갈리는 점

- 프로브를 실행하는 주체는 그 노드의 kubelet입니다. API 서버와 Service는 프로브에 관여하지 않습니다. 그래서 `httpGet`은 Pod IP로 직접 가고 Service 설정과 상관없습니다.
- readiness 실패는 Pod를 죽이지 않으니 `RESTARTS`는 0인 채로 `READY 0/1`만 보입니다. 재시작이 늘면 liveness나 startup 쪽입니다.

> **정리**: `RESTARTS`가 오르면 startup이나 liveness, 재시작 없이 `READY 0/1`이면 readiness 쪽을 봅니다. liveness에는 DB 같은 외부 의존성을 넣지 않습니다.

</details>

### 4-3. 헷갈리는 지점

- liveness 프로브는 readiness 프로브가 성공하기를 기다리지 않습니다. 시작이 느린 앱에 liveness만 걸면 뜨기도 전에 재시작이 반복됩니다. 이때 startupProbe나 `initialDelaySeconds`를 씁니다.
- readiness 실패는 재시작을 일으키지 않습니다. Pod가 `Running`인데 Service로 트래픽이 안 가면 `READY` 열과 EndpointSlice를 봅니다.

### 4-4. 네이티브 사이드카

<details>
<summary>기초부터: 한 Pod에 컨테이너를 여럿 두는 이유와 세 가지 종류</summary>

> **핵심 한 줄**: 앱 곁에 붙어 있어야 하는 보조 프로그램을 따로 만든 이미지로 같은 Pod에 넣습니다. 넣는 자리에 따라 일반, init, 사이드카 세 가지로 나뉩니다.

#### 1. 왜 필요한가

앱이 파일로 쓰는 로그를 밖으로 내보내는 수집기나 앱 앞에서 TLS를 풀어 주는 프록시가 그런 보조 프로그램입니다.

| 방식 | 결과 |
|---|---|
| 앱 이미지에 함께 넣기 | 앱을 고칠 때마다 보조 프로그램까지 다시 빌드 |
| 이미지를 따로 만들어 같은 Pod에 넣기 | 앱 코드는 그대로 두고 기능만 붙임 |

같은 Pod의 컨테이너가 함께 쓰는 것은 넷입니다.

- **네트워크 네임스페이스**: 같은 IP를 쓰고 서로 `localhost:<포트>`로 부릅니다.
- **볼륨**: 같은 `emptyDir`을 두 컨테이너가 마운트하면 한쪽이 쓴 파일을 다른 쪽이 바로 읽습니다.
- **수명**: 같은 노드에 함께 배치되고 함께 지워집니다.
- **복제 단위**: Deployment는 Pod 단위로 늘리고 줄입니다. 레플리카를 3에서 5로 올리면 앱과 보조 컨테이너가 한 쌍씩 함께 늘어나 앱 하나에 보조 하나라는 짝이 유지됩니다.

#### 2. 어떻게 동작하나 (시작 순서)

1. **init 컨테이너**: `initContainers`에 적은 순서대로 하나씩 돌고 앞 것이 성공 종료(exit 0)해야 다음 것이 시작됩니다.
2. **사이드카**: `initContainers`에 있지만 `restartPolicy: Always`가 붙은 것은 started가 되면 다음으로 넘어가고 계속 돕니다.
3. **일반 컨테이너**: init 단계가 모두 끝나면 `containers`가 함께 시작됩니다. 서로 기다리지 않습니다.
4. **종료**: 앱이 끝난 뒤 사이드카가 역순으로 종료 신호를 받습니다.

```text
init-1 (끝남) → init-2 (끝남) → sidecar (계속 돔) → app 시작
                                     │                 │
                                     └─ 앱이 끝난 뒤 종료 ┘
```

#### 3. 한눈에 비교

| 종류 | 적는 곳 | 시작 순서 | 언제까지 도나 | 예 |
|---|---|---|---|---|
| 일반 컨테이너 | `containers` | 보장 없음. 서로 기다리지 않음 | Pod가 사는 동안 | 앱 본체 |
| init 컨테이너 | `initContainers` | 적은 순서대로 하나씩. 앞 것이 성공 종료(exit 0)해야 다음 것이 시작 | 할 일을 마치면 종료 | DB 대기, 설정 파일 받기, 볼륨 권한 맞추기 |
| 사이드카 | `initContainers`에 `restartPolicy: Always` | init 순서대로 시작. started가 되면 다음으로 넘어감 | Pod가 사는 동안. 앱이 끝난 뒤 역순으로 종료 | 로그 수집기, 프록시 |

#### 4. 헷갈리는 점 / 실전에서 보이는 모습

- **init 컨테이너가 따로 있는 이유**: "시작할 때 한 번만" 하는 일을 일반 컨테이너에 넣으면 일을 마치고 끝나는 순간 `restartPolicy: Always` 때문에 다시 실행되고 이것이 반복되면 `CrashLoopBackOff`가 됩니다. `initContainers`는 끝나는 것이 정상인 컨테이너를 위한 자리이고 모두 성공해야 앱이 시작되므로 순서를 보장하는 장치도 됩니다.
- **사이드카를 init 자리에 두는 이유**: 로그 수집기를 일반 컨테이너로 넣으면 앱보다 늦게 떠서 시작 로그를 놓칠 수 있습니다. Job에서는 앱이 끝나도 수집기가 계속 돌아 Pod가 끝나지 않는 문제도 있었습니다. 1.29에 beta로 기본 활성, 1.33에 stable이 됐습니다.
- **init 컨테이너가 실패하면**: kubelet은 실패한 그 init 컨테이너를 백오프를 두고 성공할 때까지 다시 실행합니다. Pod의 `restartPolicy`가 `Never`면 다시 실행하지 않고 Pod 전체를 실패로 처리합니다.

| STATUS | 뜻 | 볼 곳 |
|---|---|---|
| `Init:0/2` | init 컨테이너 2개 중 0개 완료 | `kubectl describe pod` |
| `Init:Error` | init 컨테이너가 0이 아닌 코드로 끝남 | `kubectl logs <pod> -c <init 이름>` |
| `Init:CrashLoopBackOff` | init 컨테이너 실패가 반복되어 재시도 간격이 벌어짐 | `kubectl logs <pod> -c <init 이름> --previous` |

> **정리**: 끝나는 일은 init, 계속 곁에 있어야 하는 일은 사이드카, 앱 본체는 일반 컨테이너에 둡니다. 실패는 STATUS의 `Init:` 접두어로 드러납니다.

</details>

앱과 함께 계속 돌아야 하는 로그 수집기나 프록시는 `initContainers`에 `restartPolicy: Always`를 붙여 만듭니다(`SidecarContainers`, 1.29 기본 활성, 1.33 stable). `containers`에 두면 일반 앱 컨테이너입니다.

"Sidecar Containers" 문서 기준으로 사이드카는 init 목록 순서대로 시작하고 `started`가 되어야(startupProbe가 있으면 그 성공) 다음 init 컨테이너가 뜹니다. Pod가 사는 동안 계속 돌고 앱 컨테이너가 멈춘 뒤 정의 역순으로 종료됩니다.

일반 init 컨테이너(`restartPolicy`를 적지 않은 것)는 하나씩 돌고 앞 것이 성공해야 다음 것이, 모두 끝나야 앱 컨테이너가 뜹니다. 실패하면 성공할 때까지 다시 실행하고 Pod의 `restartPolicy`가 `Never`면 Pod 전체가 실패입니다. DB 이름이 DNS에 잡힐 때까지 `until nslookup order-db; do sleep 2; done`으로 기다리는 것이 흔한 예입니다.

게시판 앱의 로그 파일을 사이드카가 stdout으로 내보내는 예입니다.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: board
  namespace: board
spec:
  initContainers:
  - name: log-shipper
    image: busybox:1.36
    restartPolicy: Always          # 이 한 줄이 사이드카를 만든다
    command: ["sh", "-c", "tail -n+1 -F /var/log/board/access.log"]
    volumeMounts:
    - name: logs
      mountPath: /var/log/board
  containers:
  - name: app
    image: busybox:1.36
    command: ["sh", "-c", "while true; do echo \"$(date) GET /board\" >> /var/log/board/access.log; sleep 1; done"]
    volumeMounts:
    - name: logs
      mountPath: /var/log/board
  volumes:
  - name: logs
    emptyDir: {}
```

```bash
kubectl -n board get pod board                    # READY 2/2: 사이드카도 셈
kubectl -n board logs board -c log-shipper
```

### 4-5. StatefulSet: 고정 이름, headless Service, volumeClaimTemplates

주문 DB처럼 복제본마다 고정된 이름과 자기 데이터가 있어야 하는 워크로드는 StatefulSet으로 띄웁니다.

| 항목 | "StatefulSets" 문서 기준 동작 |
|---|---|
| Pod 이름 | `<StatefulSet 이름>-<순번>`. 순번은 0부터 |
| DNS 이름 | `<Pod 이름>.<Service 이름>.<네임스페이스>.svc.cluster.local` |
| headless Service | 직접 만들고 `serviceName`으로 가리킴 |
| 저장소 | `volumeClaimTemplates` 항목마다 Pod별 PVC 하나. 이름은 `<템플릿 이름>-<Pod 이름>` |
| 삭제와 축소 | PVC와 PV는 남음(`persistentVolumeClaimRetentionPolicy` 기본 `Retain`) |
| 배포 순서 | 기본 `OrderedReady`. 0번이 Ready여야 1번을 만들고 축소는 큰 순번부터 |

```yaml
apiVersion: v1
kind: Service
metadata:
  name: order-db
  namespace: shop
spec:
  clusterIP: None            # headless
  selector:
    app: order-db
  ports:
    - port: 5432
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: order-db
  namespace: shop
spec:
  serviceName: order-db      # 위 headless Service 이름
  replicas: 2
  selector:
    matchLabels:
      app: order-db
  template:
    metadata:
      labels:
        app: order-db
    spec:
      containers:
        - name: db
          image: <이미지>
          volumeMounts:
            - name: data
              mountPath: /var/lib/data
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 1Gi
```

Pod `order-db-0`, `order-db-1`과 PVC `data-order-db-0`, `data-order-db-1`이 생기고 `order-db-0`을 지우면 같은 이름의 Pod가 같은 PVC를 달고 돌아옵니다. StorageClass를 적지 않으면 기본 StorageClass가 쓰입니다([CKA Ch-05](/blog/cert/cka/cka-05-storage)). `kubectl create` 하위 명령이 없어 Deployment 뼈대에서 `kind`를 바꾸고 두 필드를 더합니다.

<details>
<summary>기초부터: 주문 DB를 Deployment로 띄우면 무엇이 깨지나</summary>

> **핵심 한 줄**: Deployment의 Pod는 서로 바꿔 끼울 수 있는 부품이고 StatefulSet의 Pod는 이름과 디스크가 정해진 개인입니다. 복제본마다 자기 데이터와 역할이 있으면 StatefulSet입니다.

#### 1. Deployment로 띄웠을 때 생기는 일

주문 DB 두 대를 Deployment로 띄우고 PVC 하나를 같이 달았다고 해 보겠습니다.

| 문제 | Deployment에서 일어나는 일 | StatefulSet은 |
|---|---|---|
| 이름 | Pod가 죽으면 `order-db-7c9f-x2k`처럼 매번 새 이름으로 돌아옴. "주 DB는 어느 Pod"인지 이름으로 가리킬 수 없음 | 항상 `order-db-0`, `order-db-1` |
| 디스크 | 템플릿에 적은 PVC 하나를 모든 Pod가 같이 씀. `ReadWriteOnce`면 다른 노드의 두 번째 Pod는 붙지 못함 | Pod마다 자기 PVC(`data-order-db-0`, `data-order-db-1`) |
| 주소 | Service 하나 뒤에서 어느 Pod로 갈지 모름. 복제 설정에 "0번에 붙어라"를 적을 수 없음 | `order-db-0.order-db.shop.svc.cluster.local`로 콕 집어 부름 |
| 순서 | 모두 한꺼번에 뜸. 주 DB가 뜨기 전에 복제본이 붙으려다 실패할 수 있음 | 0번이 Ready가 된 뒤 1번 |

#### 2. headless Service가 하는 일

보통 Service는 ClusterIP 하나를 받고 그 뒤의 Pod 중 아무 데로나 보냅니다. `clusterIP: None`인 headless Service는 IP를 받지 않습니다. 대신 클러스터 DNS가 Pod마다 레코드를 만들어 줍니다.

| 질의 | 일반 Service | headless Service |
|---|---|---|
| `order-db.shop.svc.cluster.local` | ClusterIP 하나 | Ready인 Pod IP 전부 |
| `order-db-0.order-db.shop.svc.cluster.local` | 없음 | `order-db-0`의 IP 하나 |

StatefulSet의 `serviceName`은 "Pod별 DNS 이름을 이 headless Service 아래에 만들어 달라"는 뜻입니다. Service를 직접 만들지 않으면 Pod는 떠도 Pod별 이름이 풀리지 않습니다.

#### 3. 헷갈리는 점

- StatefulSet이 복제나 장애 조치를 해 주지는 않습니다. 이름, 디스크, 순서를 고정해 줄 뿐이고 주 DB와 복제본을 맞추는 일은 DB 자신이나 오퍼레이터가 합니다.
- Pod를 지워도 PVC는 남으니 다시 만들면 예전 데이터가 그대로 붙습니다. 데이터를 새로 시작하려면 PVC를 직접 지웁니다.

> **정리**: 이름, 디스크, 순서 셋 중 하나라도 복제본마다 고정돼야 하면 StatefulSet이고 그 이름을 DNS로 풀어 주는 것이 headless Service입니다. 단계별 실습은 [StatefulSet Basics](https://kubernetes.io/docs/tutorials/stateful-application/basic-stateful-set/) 튜토리얼이 같은 흐름을 따라갑니다.

</details>

### 4-6. Job과 CronJob

Job은 지정한 수만큼 Pod가 성공하면 끝나는 컨트롤러이고 `restartPolicy`는 `Never`나 `OnFailure`만 허용됩니다. 자주 더하는 필드는 `completions`(성공해야 하는 Pod 수, 기본 1), `parallelism`(동시 실행 수, 기본 1), `backoffLimit`(실패 판정 전 재시도, 기본 6), `activeDeadlineSeconds`(전체 실행 시간 상한, `backoffLimit`보다 우선하고 넘으면 `reason: DeadlineExceeded`로 실패), `ttlSecondsAfterFinished`(끝난 Job 자동 삭제)입니다.

```bash
# 게시판 통계 집계를 한 번 실행 (뼈대를 파일로 받아 필드 추가)
kubectl create job board-stats -n board --image=busybox:1.36 \
  --dry-run=client -o yaml -- sh -c 'echo done' > job.yaml
kubectl get jobs -n board
kubectl logs -n board job/board-stats

# 결제 대사 작업을 매일 새벽 3시에
kubectl create cronjob payment-reconcile -n payment --image=busybox:1.36 \
  --schedule="0 3 * * *" -- sh -c 'date'

# 일정을 기다리지 않고 지금 한 번 돌려 보기
kubectl create job reconcile-now -n payment --from=cronjob/payment-reconcile
```

CronJob의 `schedule`은 분, 시, 일, 월, 요일 다섯 칸이고 시간대는 `.spec.timeZone`으로 줍니다. `concurrencyPolicy`는 이전 Job이 아직 돌 때 함께 실행(`Allow`, 기본), 건너뛰기(`Forbid`), 교체(`Replace`) 중 하나입니다. Job 설정은 `spec.jobTemplate.spec` 아래로 한 단계 들어갑니다. `backoffLimit`을 CronJob의 `spec` 바로 아래에 적으면 `strict decoding error: unknown field "spec.backoffLimit"`로 거절됩니다.

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: payment-reconcile
  namespace: payment
spec:
  schedule: "0 3 * * *"
  concurrencyPolicy: Forbid
  jobTemplate:
    spec:
      backoffLimit: 2
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: reconcile
              image: busybox:1.36
              command: ["sh", "-c", "date"]
```

<details>
<summary>기초부터: completions와 parallelism, concurrencyPolicy를 시간표로</summary>

> **핵심 한 줄**: Deployment는 "계속 몇 개를 떠 있게"가 목표이고 Job은 "성공을 몇 번 채우면 끝"입니다. `completions`는 목표 성공 수, `parallelism`은 동시에 돌릴 수입니다.

#### 1. `completions: 5`, `parallelism: 2` 따라가기

게시판 통계를 다섯 조각으로 나눠 처리하고 각 Pod는 1분 걸린다고 하겠습니다.

| 시각 | 돌고 있는 Pod | 누적 성공 |
|---|---|---|
| 0분 | 2개 시작 | 0 |
| 1분 | 2개 성공 → 새로 2개 시작 | 2 |
| 2분 | 2개 성공 → 남은 목표가 1이라 1개만 시작 | 4 |
| 3분 | 1개 성공 → Job `Complete` | 5 |

중간에 Pod 하나가 실패하면 그만큼 다시 만들고 실패 횟수가 `backoffLimit`을 넘으면 Job 전체가 `Failed`가 됩니다. `restartPolicy: OnFailure`면 같은 Pod 안에서 컨테이너만 재시작하고 `Never`면 실패한 Pod를 남겨 둔 채 새 Pod를 만듭니다. `Never` 쪽은 실패한 Pod의 로그가 남아 원인을 보기 쉽습니다.

#### 2. concurrencyPolicy 따라가기

결제 대사(payment reconcile) 작업이 매시 정각에 시작하는데 이번엔 90분이 걸렸다고 하겠습니다. 1시에 시작한 Job이 2시 30분까지 돕니다.

| 정책 | 2시 정각에 일어나는 일 |
|---|---|
| `Allow`(기본) | 2시 Job도 시작. 두 대사 작업이 같은 데이터를 동시에 만짐 |
| `Forbid` | 2시 실행을 건너뜀. 다음 기회는 3시 |
| `Replace` | 1시 Job을 지우고 2시 Job을 새로 시작 |

같은 데이터를 두 작업이 동시에 고치면 안 되는 대사나 집계는 `Forbid`를 씁니다. 늘 최신 실행 하나만 의미가 있는 작업(최신 상태를 다시 계산하는 일 등)이면 `Replace`가 맞습니다.

#### 3. 헷갈리는 점

- CronJob은 Job을 만드는 틀이고 실제 Pod를 만드는 것은 Job입니다. 그래서 YAML이 CronJob `spec` → `jobTemplate.spec`(Job 설정) → `template.spec`(Pod 설정)으로 세 겹입니다.
- `kubectl create job --from=cronjob/...`은 일정을 기다리지 않고 같은 틀로 Job을 하나 찍어 냅니다. 설정이 맞는지 확인할 때 씁니다.

> **정리**: Job은 성공 수가 목표에 닿으면 끝나고 CronJob은 시간마다 그 Job을 찍어 냅니다. 앞 실행이 안 끝났을 때의 행동은 `concurrencyPolicy`로 정합니다.

</details>

### 4-7. PodDisruptionBudget와 drain

PodDisruptionBudget(PDB)는 drain 같은 자발적 중단 중에도 남아 있어야 할 Pod 수를 정합니다. PDB를 지키는 쪽은 Eviction API라서 `kubectl drain`은 따르고 Pod를 직접 지우는 것과 노드 장애는 PDB와 무관합니다.

```bash
# 주문 API는 drain 중에도 최소 2개 유지
kubectl create pdb order-api-pdb -n shop --selector=app=order-api --min-available=2
kubectl get pdb -n shop        # ALLOWED DISRUPTIONS 열이 지금 내보낼 수 있는 수
```

YAML로 쓰면 `policy/v1`의 `spec.minAvailable`(또는 `maxUnavailable`, 한 PDB에 하나만)과 `spec.selector.matchLabels`입니다.

- `minAvailable`과 `maxUnavailable`은 정수나 `"50%"` 같은 백분율을 받고 백분율은 올림합니다. Pod 7개에 `minAvailable: "50%"`면 4개가 남아야 합니다.
- `ALLOWED DISRUPTIONS`가 0이면 drain은 아래 줄을 찍으며 재시도하고 대체 Pod가 Ready가 되면 진행합니다. `maxUnavailable: 0`이나 레플리카 수와 같은 `minAvailable`이면 끝나지 않습니다.

```text
error when evicting pods/"order-api-..." -n "shop" (will retry after 5s): Cannot evict pod as it would violate the pod's disruption budget.
```

drain 명령과 `--ignore-daemonsets`, `--delete-emptydir-data`, `--force` 옵션은 [CKA Ch-02](/blog/cert/cka/cka-02-cluster-architecture) 4-7절에 정리했습니다.

<details>
<summary>기초부터: ALLOWED DISRUPTIONS 계산과 drain이 기다리는 이유</summary>

> **핵심 한 줄**: PDB는 "지금 몇 개까지 내보내도 되나"를 숫자 하나(`ALLOWED DISRUPTIONS`)로 계산해 두고 drain은 그 숫자가 0보다 클 때만 Pod를 하나씩 내보냅니다.

#### 1. 계산

`ALLOWED DISRUPTIONS`는 지금 건강한 Pod 수에서 반드시 남아야 할 수를 뺀 값입니다.

| 상황 | 건강한 Pod | 남아야 할 수 | ALLOWED DISRUPTIONS |
|---|---|---|---|
| 레플리카 3, `minAvailable: 2` | 3 | 2 | 1 |
| 위에서 하나가 내보내져 대체 Pod가 아직 뜨는 중 | 2 | 2 | 0 |
| 레플리카 7, `minAvailable: "50%"` | 7 | 4(3.5 올림) | 3 |
| 레플리카 10, `maxUnavailable: 1` | 10 | 9 | 1 |
| 레플리카 3, `minAvailable: 3` | 3 | 3 | 0(영원히) |

#### 2. drain이 주문 API Pod 둘이 있는 노드를 비우는 순서

레플리카 3, `minAvailable: 2`이고 `node01`에 Pod 둘, `node02`에 Pod 하나가 있다고 하겠습니다.

1. drain이 `node01`을 cordon(새 Pod 금지)하고 첫 Pod를 Eviction API로 내보냅니다. 허용 1이라 통과합니다.
2. Deployment가 대체 Pod를 다른 노드에 만듭니다. 그 Pod가 Ready가 되기 전까지 건강한 Pod는 2개, 허용은 0입니다.
3. drain이 두 번째 Pod를 내보내려다 4-7절의 `violate the pod's disruption budget` 메시지를 찍고 5초마다 재시도합니다.
4. 대체 Pod가 Ready가 되면 건강한 Pod가 3개로 돌아와 허용이 1이 되고 두 번째 Pod가 나갑니다.

drain이 "멈춘 것처럼" 보이는 시간은 대체 Pod가 Ready가 되기까지의 시간입니다. 대체 Pod가 갈 노드가 없거나 readiness가 계속 실패하면 drain은 끝나지 않습니다.

#### 3. 헷갈리는 점

- PDB는 자발적 중단(drain, 클러스터 축소 등 Eviction API를 거치는 일)만 막습니다. `kubectl delete pod`, 노드 전원 장애, OOM은 막지 못합니다.
- 레플리카 1개짜리 앱에 `minAvailable: 1`을 걸면 그 노드는 drain할 수 없습니다. 시험에서 drain이 끝나지 않으면 `kubectl get pdb -A`부터 봅니다.

> **정리**: drain이 멈춘 것처럼 보이면 `kubectl get pdb -A`에서 `ALLOWED DISRUPTIONS`가 0인지 봅니다. 대체 Pod가 Ready가 되면 이어 가고 `minAvailable`이 레플리카 수와 같으면 끝나지 않습니다. 백분율 계산 예는 [Specifying a Disruption Budget](https://kubernetes.io/docs/tasks/run-application/configure-pdb/) 문서에 더 있습니다.

</details>

### 4-8. 직접 해 보기

- "Configure Liveness, Readiness and Startup Probes" 문서의 첫 예제(`cat /tmp/healthy`, 30초 뒤 파일 삭제)를 띄우고 Events에 `Liveness probe failed: cat: can't open '/tmp/healthy': No such file or directory`가 세 번 찍힌 뒤 `Container liveness failed liveness probe, will be restarted`가 나오는지 봅니다.
- `order-db-0`을 지우고 같은 이름과 PVC로 돌아오는지 봅니다. Pod별 DNS는 `kubectl run tmp --rm -it --restart=Never --image=busybox:1.36 -n shop -- nslookup order-db-0.order-db.shop.svc.cluster.local`로 확인합니다. busybox 1.36의 `nslookup`은 `order-db-0.order-db`처럼 점이 든 짧은 이름에 `NXDOMAIN`을 돌려주니 FQDN으로 적습니다.
- 워커 두 대에 레플리카 3개와 `minAvailable: 2` PDB를 두고 Pod가 둘 있는 노드를 drain해 4-7절의 재시도 메시지를 봅니다.

## 5. Pod 승인과 스케줄링

커리큘럼 문구는 "Configure Pod admission and scheduling (limits, node affinity, etc.)"입니다. 결론 1번의 세 길목을 따라 읽습니다.

### 5-1. 승인 단계

<details>
<summary>기초부터: 요청 한 건이 etcd에 저장되기까지</summary>

> **핵심 한 줄**: RBAC는 "해도 되는 사람인가"만 보고 승인(admission) 단계가 요청의 내용을 보고 고치거나 막습니다.

#### 1. 왜 필요한가

RBAC는 "이 사용자가 이 네임스페이스에 Pod를 만들어도 되는지"까지만 봅니다. 다음은 RBAC로 판단할 수 없습니다.

- Pod 안에 `privileged: true`가 있는지
- 이미지가 어느 레지스트리 것인지
- 필수 라벨이 붙었는지

요청의 내용을 보고 고치거나 막는 단계가 따로 필요하고 그것이 승인 단계입니다.

#### 2. 어떻게 동작하나

```text
kubectl apply
  → ① 인증(authentication)   누가 보냈나. 인증서, 토큰
  → ② 인가(authorization)    이 동작을 해도 되나. RBAC
  → ③ mutating 승인          빠진 값 채우기, 값 고치기
  → ④ 스키마 검증
  → ⑤ validating 승인        규칙을 어기면 거절
  → ⑥ etcd에 저장
```

1. **인증**: 인증서나 토큰으로 보낸 사람을 확인합니다.
2. **인가**: RBAC로 그 동작이 허용되는지 봅니다.
3. **mutating 승인**: 요청 객체를 고칠 수 있습니다.
4. **스키마 검증**: 필드 형식을 확인합니다.
5. **validating 승인**: 허용과 거절만 정합니다.
6. **저장**: 모두 통과하면 etcd에 씁니다.

#### 3. 한눈에 비교

| 구분 | mutating | validating |
|---|---|---|
| 하는 일 | 빠진 값 채우기, 값 고치기 | 허용 또는 거절 |
| 내장 예 | `DefaultStorageClass`(StorageClass 없는 PVC에 기본 클래스 이름), `ServiceAccount`(Pod에 `default` ServiceAccount) | `NamespaceLifecycle`(없거나 삭제 중인 네임스페이스에 생성 거절, `default`, `kube-system`, `kube-public` 삭제 방지) |
| 순서 | 먼저 | 나중 |

mutating이 먼저 도는 이유는 고쳐진 최종 결과를 validating이 검사해야 하기 때문입니다. 순서가 반대면 검사를 통과한 뒤에 값이 바뀌어 규칙을 피해 갈 수 있습니다. `LimitRanger`처럼 기본값을 채우고 범위도 검사해 두 역할을 다 하는 플러그인도 있습니다.

**내장 플러그인 밖의 규칙을 넣는 두 길**

| 방법 | 동작 | 준비할 것 |
|---|---|---|
| 웹훅 | API 서버가 해당 요청을 `AdmissionReview` JSON으로 웹훅 서버에 보내고 허용 여부를 받음. mutating 웹훅은 고칠 내용을 JSON 패치로 돌려줌 | HTTPS 서버(Deployment와 Service), `ValidatingWebhookConfiguration` 또는 `MutatingWebhookConfiguration`에 `rules`와 Service 등록, `caBundle`에 서버 인증서를 서명한 CA |
| ValidatingAdmissionPolicy | 서버 없이 CEL 식으로 API 서버 안에서 검사(아래 본문) | 정책과 바인딩 |

#### 4. 실전에서 보이는 모습

- **플러그인을 켜고 끄는 곳**: kube-apiserver의 `--enable-admission-plugins`와 `--disable-admission-plugins`입니다. kubeadm에서는 static Pod 매니페스트를 고치면 kubelet이 파일 변경을 보고 API 서버를 다시 띄웁니다.
- **기본 목록 확인**: `kube-apiserver -h`의 `--enable-admission-plugins` 설명에 나옵니다.
- **거절되면**: `kubectl apply`가 승인 컨트롤러 이름이 들어간 에러를 바로 돌려주고 객체는 만들어지지 않습니다. 거절 원인별로 볼 자리는 아래 본문 표에 있습니다.

> **정리**: 인증, 인가 다음에 mutating이 고치고 validating이 막습니다. 내장 규칙 밖은 웹훅이나 ValidatingAdmissionPolicy로 더합니다.

</details>

승인 컨트롤러(admission controller)는 인증과 인가를 통과한 요청을 저장하기 전에 가로채는 API 서버 안의 코드입니다. 값을 고치는 mutating이 먼저, 거절만 하는 validating이 나중에 돕니다. `LimitRanger`, `ResourceQuota`, `Priority`, `DefaultTolerationSeconds`, `ServiceAccount`가 기본으로 켜져 있습니다. kubeadm 클러스터에서 플러그인을 더하고 빼는 자리는 kube-apiserver static Pod 매니페스트이고 저장하면 kube-apiserver가 다시 뜨는 동안 `kubectl`이 잠시 응답하지 않습니다.

```yaml
# kube-apiserver.yaml의 command 일부
    - --enable-admission-plugins=NodeRestriction,AlwaysPullImages
    - --disable-admission-plugins=DefaultStorageClass
```

`--enable-admission-plugins`의 이름은 기본 목록에 더해지고 순서는 상관없습니다. Pod 생성이 승인 단계에서 거절될 때 볼 자리입니다.

| 거절 원인 | 확인할 자리 |
|---|---|
| LimitRange 최솟값, 최댓값 위반 | `kubectl describe limitrange -n <ns>` |
| ResourceQuota 초과, request/limit 미기재 | `kubectl describe quota -n <ns>` |
| 없는 PriorityClass 이름 | `kubectl get priorityclass` |
| Pod Security Admission(`PodSecurity`, 기본 활성) | 네임스페이스 라벨 `pod-security.kubernetes.io/enforce` |
| 어드미션 웹훅 | 웹훅 서버가 죽었는데 `failurePolicy: Fail`이면 생성이 전부 막힘 |

ValidatingAdmissionPolicy(1.30 stable)는 웹훅 서버 없이 CEL 식(`object.spec.replicas <= 5` 같은)으로 규칙을 적는 객체입니다. 정책과 `ValidatingAdmissionPolicyBinding`이 둘 다 있어야 효력이 나고 YAML은 "Validating Admission Policy" 문서의 예제를 고쳐 씁니다. 함정은 둘입니다. 정책의 `resources`에 `deployments`만 적으면 `kubectl scale`이 고치는 `deployments/scale` 하위 리소스는 정책에 걸리지 않습니다. 바인딩의 `validationActions`에 `Deny`와 `Warn`을 함께 적으면 바인딩 자체가 `must not contain both Deny and Warn`으로 거절됩니다.

VAP 거부는 422에 `ValidatingAdmissionPolicy 'max-replicas' with binding 'max-replicas' denied request: replicas must be <= 5`, 서버 없는 웹훅(`failurePolicy: Fail`)은 500에 `failed calling webhook`입니다(응답 코드 표는 [Ch-01b 1-2절](/blog/cert/cka/cka-01b-core-objects-and-flow)).

### 5-2. requests와 limits

<details>
<summary>기초부터: request와 limit은 각각 무엇을 위한 값인가</summary>

> **핵심 한 줄**: request는 스케줄러가 자리를 셈하는 예약 몫이고 limit은 커널이 cgroup으로 집행하는 상한입니다. 메모리 상한을 넘으면 죽고(OOMKilled) CPU 상한을 넘으려 하면 느려집니다(스로틀링).

#### 1. 왜 필요한가

| 값 | 막는 문제 | 누가 보나 |
|---|---|---|
| request | 노드에 자리가 없는데 Pod를 계속 밀어 넣는 일 | 스케줄러. 노드의 실제 사용량을 보지 않고 이미 배치된 Pod들의 request 합만 봄 |
| limit | 한 컨테이너가 노드 자원을 독차지해 이웃 Pod를 굶기는 일 | 노드의 커널(cgroup) |

노드 할당 가능량에서 request 합을 뺀 나머지가 새 Pod의 request보다 작으면 그 노드는 후보에서 빠지고 어느 노드에도 자리가 없으면 Pod는 `Pending`입니다.

#### 2. 어떻게 동작하나

1. **스케줄링**: 스케줄러가 request로 들어갈 노드를 고릅니다.
2. **cgroup 설정**: kubelet과 컨테이너 런타임이 limit을 그 컨테이너의 cgroup 값으로 적습니다.
3. **CPU 집행**: 커널이 주기(period)마다 쓸 수 있는 시간(quota)을 나눠 주고 다 쓰면 그 주기의 남은 시간 동안 실행을 멈춰 둡니다(CFS 대역폭 제어, 스로틀링). 프로세스는 살아 있고 느려질 뿐입니다.
4. **메모리 집행**: 이미 쓴 공간은 강제로 돌려받을 방법이 없습니다. cgroup 사용량이 `memory.max`에 닿고 회수할 수 없으면 커널이 그 cgroup 안에서 OOM killer를 부릅니다. 컨테이너는 restartPolicy대로 다시 뜹니다.

```text
CPU limit 500m (cgroup v2 cpu.max = "50000 100000", 100ms 주기마다 50ms)
  0ms ──── 50ms 사용 ────┤ 스로틀링(대기) ├── 100ms: 다음 주기 시작
  → 응답이 느려짐, 프로세스는 그대로

메모리 limit 256Mi (cgroup v2 memory.max)
  사용량 증가 → 256Mi 도달, 회수 불가 → OOM killer가 SIGKILL(9)
  → exit code 137 (128 + 9), reason OOMKilled → kubelet이 재시작
```

cgroup v2의 `cpu.max`는 `$MAX $PERIOD` 형식이고 기본값은 `max 100000`(제한 없음, 주기 100000µs)입니다. 위 `50000 100000`은 500m을 이 형식으로 옮긴 계산 예시입니다.

#### 3. 한눈에 비교

**단위**

| 표기 | 뜻 |
|---|---|
| CPU `1` | 클라우드의 vCPU 1개, 물리 서버의 하이퍼스레드 1개 |
| CPU `0.5` = `500m` | 1 CPU의 절반. `m`은 1/1000이고 `1m`보다 작게는 못 적음 |
| 메모리 `128Mi` | 128 × 1024 × 1024 바이트(메비바이트) |
| 메모리 `128M` | 128 × 1000 × 1000 바이트(메가바이트) |
| 메모리 `1Gi`, `1G` | 1024³ 바이트(기비바이트), 1000³ 바이트(기가바이트). 쿠버네티스 예시는 대부분 `Mi`, `Gi`를 씀 |

**조합에 따라 달라지는 것**

| 설정 | 결과 |
|---|---|
| 둘 다 없음 | 상한이 없어 한 Pod가 노드 자원을 다 쓸 수 있고 request가 0이라 스케줄러가 자리 계산에서 이 Pod를 셈하지 않음. QoS BestEffort |
| limit만 | request가 limit 값으로 채워짐 |
| request와 limit을 다르게 | 보장 몫과 상한을 따로 둠. 가장 흔한 형태 |
| request만 | 노드에 남는 CPU를 끝까지 쓸 수 있음. 메모리는 상한이 없어 노드 메모리가 모자랄 때 위험 |

그래서 CPU는 request만 두어 남는 CPU를 쓰게 하고 메모리는 limit을 두어 한 Pod가 노드 메모리를 다 먹지 못하게 하는 방식도 운영에서 자주 씁니다.

#### 4. 실전에서 보이는 모습

| 구분 | 메모리 limit 초과 | CPU limit 도달 |
|---|---|---|
| 커널 동작 | OOM killer가 프로세스를 SIGKILL | 주기의 남은 시간 동안 실행 대기 |
| `kubectl get pod` | STATUS `OOMKilled`, `RESTARTS` 증가. 반복되면 `CrashLoopBackOff` | Running 그대로. 겉으로는 정상 |
| 남는 기록 | `lastState.terminated`에 `reason: OOMKilled`, `exitCode: 137` | cgroup `cpu.stat`의 `nr_periods`, `nr_throttled`, `throttled_usec`가 늘어남 |
| 체감 증상 | 컨테이너가 죽고 다시 뜸 | 응답 지연, 타임아웃 |
| 확인 명령 | `kubectl describe pod`의 Last State | 컨테이너 안에서 `cat /sys/fs/cgroup/cpu.stat`(cgroup v2 기준) |

```text
# 예시: 형식만 보여 주는 출력
NAME        READY   STATUS      RESTARTS   AGE
shop-api    0/1     OOMKilled   1          24s

lastState:
  terminated:
    exitCode: 137
    reason: OOMKilled
```

- **CrashLoopBackOff 재시작 간격**: kubelet은 다시 띄울 때마다 기다리는 시간을 10s, 20s, 40s처럼 두 배씩 늘리고 300초(5분)에서 멈춥니다. 컨테이너가 10분 동안 문제없이 돌면 간격이 처음으로 돌아갑니다(기본값 기준. kubelet 설정 `crashLoopBackOff.maxContainerRestartPeriod`로 상한을 줄일 수 있고 1.35 beta 기본 활성).
- **메모리 limit은 사후 집행**: 공식 문서 기준으로 종료는 커널이 메모리 압박을 감지할 때 일어납니다. limit을 잠깐 넘긴 컨테이너가 바로 죽지 않을 수도 있습니다.
- **exit code 137이 항상 OOM은 아님**: 128 + 9(SIGKILL)라서 다른 이유로 SIGKILL을 받아도 137입니다. `reason` 필드가 `OOMKilled`인지 함께 봅니다.

**네임스페이스 단위로 강제하는 두 객체**: LimitRange는 컨테이너 하나하나의 기본값과 허용 범위를(5-3절), ResourceQuota는 네임스페이스 전체 합계를(5-4절) 정합니다. 둘 다 승인 단계에서 동작해서 이미 떠 있는 Pod는 바뀌지 않습니다.

> **정리**: request는 자리, limit은 상한입니다. 메모리 상한은 OOMKilled와 137로, CPU 상한은 겉으로 멀쩡한 스로틀링과 `cpu.stat`의 `nr_throttled`로 드러납니다.

</details>

| 값 | 누가 쓰는지 | 넘으면 |
|---|---|---|
| requests | 스케줄러가 노드를 고를 때. 노드에 배치된 컨테이너 requests 합이 노드 할당 가능량 안이어야 함 | 사용량이 request를 넘는 것은 허용 |
| limits | 노드의 kubelet과 커널 | CPU는 스로틀링, 메모리는 OOM으로 종료(`OOMKilled`) |

limit만 적고 request를 적지 않으면 limit 값이 request로 복사됩니다. 그래서 CPU와 메모리 limit만 적은 Pod는 QoS가 `Guaranteed`입니다. 단위도 자주 틀립니다. CPU `0.1`은 `100m`과 같고 메모리 `400m`은 0.4바이트입니다. 400메비바이트는 `400Mi`입니다.

requests와 limits의 조합이 QoS 클래스를 정합니다.

| QoS | 조건 | 노드 자원이 모자랄 때 축출 순서 |
|---|---|---|
| Guaranteed | 모든 컨테이너에 CPU와 메모리 request와 limit이 있고 각각 같은 값 | 마지막 |
| Burstable | Guaranteed가 아니고 컨테이너 하나 이상에 CPU나 메모리 request 또는 limit이 있음 | BestEffort 다음 |
| BestEffort | 어느 컨테이너에도 CPU와 메모리 request, limit이 없음 | 먼저 |

```bash
kubectl set resources deployment order-api -n shop \
  --requests=cpu=100m,memory=128Mi --limits=cpu=500m,memory=256Mi
kubectl get pod <pod> -n shop -o jsonpath='{.status.qosClass}'
```

kubelet이 cgroup으로 limits를 집행하는 방식은 시험 범위 밖이라 [쿠버네티스 아래의 리눅스 3편](/blog/theory/systems/k8s-linux-03-cgroup-qos)에 따로 정리했습니다.

### 5-3. LimitRange

LimitRange는 네임스페이스 안 컨테이너나 Pod 하나하나의 최솟값, 최댓값, 기본값을 정합니다. 자원을 적지 않은 Pod에 기본값을 넣고 범위를 넘으면 `403 Forbidden`으로 거절합니다. 승인 시점에만 작동해서 이미 떠 있는 Pod는 그대로입니다. `kubectl create` 하위 명령이 없어 YAML로 씁니다.

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: shop-defaults
  namespace: shop
spec:
  limits:
    - type: Container
      default:          # limit 기본값
        cpu: 500m
        memory: 256Mi
      defaultRequest:   # request 기본값
        cpu: 100m
        memory: 128Mi
      max:
        cpu: "1"
        memory: 512Mi
```

이 LimitRange에서 limit `2`를 적은 Pod는 `maximum cpu usage per Container is 1, but limit is 2`로 거절됩니다. request `700m`만 적은 Pod도 실패합니다. 기본 limit 500m이 들어가 request가 limit보다 커지기 때문이고 `must be less than or equal to cpu limit of 500m` 검증 오류가 납니다. LimitRange는 자기가 넣는 기본값끼리 맞는지 검사하지 않습니다.

### 5-4. ResourceQuota

ResourceQuota는 네임스페이스 전체의 합계를 묶습니다.

```bash
kubectl create quota shop-quota -n shop \
  --hard=requests.cpu=2,requests.memory=4Gi,limits.cpu=4,limits.memory=8Gi,pods=10
kubectl describe quota shop-quota -n shop     # Used와 Hard 비교
```

- `cpu`나 `memory` 쿼터가 걸리면 새 Pod마다 해당 자원을 적어야 합니다. 안 적으면 `must specify limits.cpu for: ...`로 거절되니 LimitRange로 기본값을 채웁니다.
- 쿼터를 넘는 생성이나 수정은 `403 Forbidden`입니다.
- Deployment는 만들어지고 Pod만 덜 생깁니다. `pods=3` 쿼터에 레플리카 5개면 Pod 3개만 뜨고 `kubectl describe rs`에 `FailedCreate`와 `exceeded quota: ..., requested: pods=1, used: pods=3, limited: pods=3`이 붙습니다.
- 객체 수는 `count/deployments.apps`, `count/pods`처럼 `count/<리소스>.<그룹>` 형식으로 묶습니다.

<details>
<summary>기초부터: LimitRange와 ResourceQuota는 무엇을 재고 어떤 순서로 검사하나</summary>

> **핵심 한 줄**: LimitRange는 Pod 하나하나를 재는 자이고 ResourceQuota는 네임스페이스 전체의 지갑입니다. 둘 다 승인 단계에서 작동하고 LimitRange가 먼저 기본값을 채운 뒤 ResourceQuota가 합계를 셉니다.

#### 1. 한눈에 비교

| | LimitRange | ResourceQuota |
|---|---|---|
| 재는 단위 | 컨테이너나 Pod 하나 | 네임스페이스 전체 합계 |
| 하는 일 | 기본값 채우기, 한 개의 최소·최대 검사 | 합계가 상한을 넘는지 검사, 객체 수 제한 |
| 비유 | "한 사람당 짐 20kg까지, 안 적으면 10kg로 봄" | "비행기 전체 짐 2톤까지" |
| 만드는 법 | YAML만 | `kubectl create quota` |

#### 2. Pod 하나가 들어올 때의 순서

`shop` 네임스페이스에 5-3절 LimitRange와 5-4절 쿼터(`requests.cpu=2`)가 함께 있고 이미 request 합계가 1.9 CPU라고 하겠습니다. 자원을 적지 않은 Pod를 하나 만듭니다.

1. LimitRange 승인 플러그인이 비어 있는 칸에 기본값을 넣습니다. request 100m, limit 500m이 됩니다.
2. LimitRange가 최대값(limit 1 CPU)을 넘지 않는지 봅니다. 통과합니다.
3. ResourceQuota 승인 플러그인이 합계를 셉니다. 1.9 + 0.1 = 2.0이라 상한 2와 같고 통과합니다.
4. 다음 Pod는 2.0 + 0.1 = 2.1이 되어 `exceeded quota`로 거절됩니다.

순서가 이렇기 때문에 쿼터가 걸린 네임스페이스에서 자원을 안 적은 Pod가 거절될 때 LimitRange를 두면 해결됩니다. 기본값이 먼저 채워져 쿼터가 셀 숫자가 생깁니다.

#### 3. 헷갈리는 점

- 둘 다 이미 떠 있는 Pod에는 소급하지 않습니다. 쿼터를 줄여도 기존 Pod는 그대로이고 `Used`가 `Hard`보다 큰 상태로 보일 수 있습니다.
- Deployment로 만들면 거절 메시지가 `kubectl apply` 화면에 나오지 않습니다. Deployment 자체는 만들어지고 ReplicaSet이 Pod를 만들다 거절당하니 `kubectl describe rs`나 `kubectl get events`에서 찾습니다.

> **정리**: 쿼터가 걸린 네임스페이스에서 자원을 안 적은 Pod가 거절되면 LimitRange로 기본값을 채웁니다. Deployment로 만든 Pod의 거절 메시지는 `kubectl describe rs`나 Events에서 찾습니다.

</details>

### 5-5. nodeSelector와 nodeName

<details>
<summary>기초부터: 스케줄링은 spec.nodeName을 채우는 일</summary>

> **핵심 한 줄**: 스케줄러는 Pod의 `spec.nodeName`에 노드 이름을 적을 뿐이고 실제로 컨테이너를 띄우는 것은 그 노드의 kubelet입니다.

#### 1. 어떻게 동작하나

```text
Pod 생성(nodeName 비어 있음, Pending)
  → kube-scheduler가 노드 선택
  → Binding을 API 서버에 기록 → Pod의 nodeName = node01
  → node01의 kubelet이 자기 이름이 적힌 Pod를 보고 컨테이너 실행
```

1. **저장**: Pod가 만들어지면 `nodeName`이 빈 채로 etcd에 저장됩니다. 이때 STATUS는 `Pending`입니다.
2. **꺼내기**: kube-scheduler는 `nodeName`이 비어 있고 `schedulerName`이 자기 이름인 Pod를 지켜보다 하나씩 꺼냅니다.
3. **고르기**: 갈 수 없는 노드를 거르고(필터) 남은 노드에 점수를 매겨 하나를 고릅니다(5-11절).
4. **바인딩**: 고른 노드를 Binding 객체로 Pod의 `binding` 하위 리소스에 보내고 API 서버가 `nodeName`을 채웁니다.
5. **실행**: 각 노드의 kubelet은 `nodeName`이 자기 이름인 Pod를 지켜보다가 컨테이너를 띄웁니다.

#### 2. 한눈에 비교: 노드를 정하는 세 방법

| 방법 | 건너뛰는 단계 | 장점 | 한계 |
|---|---|---|---|
| 스케줄러에 맡김 | 없음 | 자원 계산, 필터, 점수 모두 적용 | 원하는 노드를 직접 못 고름 |
| YAML에 `nodeName` 직접 | 2~4번(승인 단계는 그대로 거침) | 스케줄러가 없어도 배치 | 자원 계산이 빠져 자리가 모자라면 kubelet이 `OutOfcpu` 같은 이유로 거부. 그 노드가 사라지면 갈 곳이 없음 |
| `nodeSelector` | 없음 | 라벨이 맞는 노드 가운데서 스케줄러가 고름 | 정확히 같은 값의 AND만 가능 |

이미 만들어진 Pod의 `nodeName`은 바꿀 수 없어서 `Pending` Pod는 지우고 다시 만들거나 스케줄러처럼 Binding을 보냅니다(아래 본문).

#### 3. nodeSelector로 라벨 고르기

1. **노드에 라벨**: `kubectl label nodes node01 disktype=ssd`
2. **Pod에 조건**: Pod spec에 `nodeSelector: { disktype: ssd }`
3. **필터**: 스케줄러가 적은 라벨을 모두 정확히 가진 노드만 남깁니다.

#### 4. 헷갈리는 점 / 실전에서 보이는 모습

- **nodeSelector의 한계**: "ssd 또는 nvme"(OR), "small이 아닌 노드"(NOT), "가능하면 ssd"(선호) 같은 조건은 적을 수 없어서 다음 절의 노드 어피니티가 있습니다.
- **맞는 노드가 없으면**: Pod가 `Pending`에 머물고 `kubectl describe pod`의 Events에 `FailedScheduling`과 함께 "몇 개 노드가 어떤 이유로 맞지 않았는지"가 찍힙니다.
- **스케줄러가 죽어 있으면**: 모든 새 Pod가 `Pending`이고 Events에 아무것도 남지 않습니다. `kubectl get pods -n kube-system`에서 kube-scheduler 상태부터 봅니다.

#### 5. Binding을 HTTP로 직접 보내기

옛 강의는 Binding을 kubectl 대신 curl로 API 서버에 보냅니다. 스케줄러가 하는 요청을 손으로 흉내 내는 방식이라 원리를 보기에 좋습니다.

1. **중계 띄우기**: `kubectl proxy`가 내 kubeconfig로 인증을 붙여 주는 중계를 `127.0.0.1:8001`에 띄웁니다([Ch-02](/blog/cert/cka/cka-02-cluster-architecture)).
2. **POST 보내기**: 아래 본문의 Binding JSON을 Pod의 `binding` 하위 리소스 주소로 보냅니다.

```bash
curl -X POST -H "Content-Type: application/json" \
  --data @binding.json \
  http://127.0.0.1:8001/api/v1/namespaces/board/pods/board-web/binding
```

| 방법 | 쓰는 자리 |
|---|---|
| `kubectl create -f binding.json` | 시험. 짧고 인증을 kubectl이 처리 |
| curl + `kubectl proxy` | 스케줄러가 보내는 요청 모양을 직접 볼 때 |
| `kubectl replace --force -f pod.yaml` | `nodeName`을 넣은 YAML로 Pod를 지우고 곧바로 다시 만들 때 |

Binding은 한 번 보내면 끝나는 동작입니다. 같은 파일을 다시 보내면 `409 Conflict`만 돌아오니 저장소에 두고 반복 적용할 매니페스트로 다루지 않습니다.

> **정리**: 스케줄링은 `nodeName` 한 칸을 채우는 일입니다. 직접 채우면 빠르지만 자원 계산이 빠지고 라벨로 고르면 스케줄러가 계산을 이어 갑니다.

</details>

```bash
kubectl label nodes node01 disktype=ssd
kubectl get nodes --show-labels
```

```yaml
spec:
  nodeSelector:
    disktype: ssd
```

nodeSelector는 적은 라벨을 모두 가진 노드에만 Pod를 놓습니다. `nodeName`에 값이 있으면 스케줄러를 건너뛰고 그 노드의 kubelet이 바로 띄웁니다. 승인 단계는 그대로 거치고 자원이 모자라면 `OutOfcpu` 같은 이유로 `Failed`가 됩니다.

스케줄러가 멈춘 클러스터에서 `Pending`인 Pod를 놓는 방법은 둘입니다. Pod를 지우고 `nodeName`을 넣어 다시 만들거나(`edit`, `patch`로 넣는 것은 거절됩니다) Pod의 `binding` 하위 리소스에 Binding 객체를 보냅니다.

```json
{
  "apiVersion": "v1",
  "kind": "Binding",
  "metadata": { "name": "board-web" },
  "target": { "apiVersion": "v1", "kind": "Node", "name": "node02" }
}
```

파일로 저장해 `kubectl create -f binding.json -n board`로 보냅니다. 이미 노드가 정해진 Pod에 다시 보내면 `409 Conflict`와 `pod board-web is already assigned to node "..."`가 돌아옵니다.

### 5-6. 노드 어피니티

<details>
<summary>기초부터: 긴 필드 이름 읽기와 required, preferred의 차이</summary>

> **핵심 한 줄**: `requiredDuringSchedulingIgnoredDuringExecution`은 "배치할 때 반드시 지키고 배치된 뒤에는 따지지 않는다"는 두 토막입니다.

#### 1. 이름 읽기

```text
requiredDuringScheduling  +  IgnoredDuringExecution
   배치할 때 반드시 지킴        배치된 뒤에는 따지지 않음
                               (노드 라벨이 나중에 바뀌어도 돌던 Pod는 그대로)

preferredDuringScheduling  +  IgnoredDuringExecution
   배치할 때 되도록 지킴         배치된 뒤에는 따지지 않음
```

#### 2. 어떻게 동작하나

1. **required (필터 단계)**: 조건에 안 맞는 노드를 후보에서 뺍니다.
2. **preferred (점수 단계)**: 남은 노드 가운데 조건에 맞는 노드에 `weight`만큼 점수를 더합니다.
3. **선택**: 점수가 가장 높은 노드에 배치합니다.

#### 3. 한눈에 비교

| 구분 | required | preferred |
|---|---|---|
| 맞는 노드가 없으면 | `Pending` | 다른 노드에 배치 |
| 스케줄러의 어느 단계에서 | 필터: 안 맞는 노드를 후보에서 뺌 | 점수: 맞는 노드에 `weight`만큼 점수를 더함 |
| 쓰는 자리 | GPU가 있어야만 도는 작업, 특정 존에만 둬야 하는 데이터 | 되도록 SSD 노드, 없으면 다른 노드에서라도 서비스 |

**nodeSelector로 못 하던 조건**(노드 라벨 `size` 예)

| 연산자 | 뜻 |
|---|---|
| `In [large, medium]` | 둘 중 하나면 됨(OR) |
| `NotIn [small]` | small이 아닌 노드 |
| `Exists` | 값과 상관없이 키가 있으면 됨. `values`를 적지 않음 |
| `DoesNotExist` | 그 키가 없는 노드 |
| `Gt`, `Lt` | 값을 정수로 비교(예: `gpu-count Gt 1`) |

#### 4. 실전에서 보이는 모습

- required 조건에 맞는 노드가 없으면 Pod는 `Pending`이고 Events의 `FailedScheduling` 메시지에 노드 어피니티가 맞지 않은 노드 수가 나옵니다.
- 배치 뒤 노드 라벨을 지워도 돌던 Pod는 내려가지 않습니다(`IgnoredDuringExecution`). 새로 만드는 Pod부터 영향을 받습니다.

> **정리**: required에 맞는 노드가 없으면 `Pending`이고 preferred는 맞는 노드가 없어도 다른 노드에 놓입니다. 배치된 뒤 노드 라벨을 바꿔도 돌던 Pod는 그대로입니다.

</details>

`requiredDuringSchedulingIgnoredDuringExecution`은 만족하는 노드가 없으면 `Pending`, `preferredDuringScheduling...`은 만족하는 노드를 먼저 찾고(`weight` 1~100) 없으면 아무 데나 놓습니다. `IgnoredDuringExecution`은 스케줄된 뒤 노드 라벨이 바뀌어도 Pod가 계속 돈다는 뜻입니다. 연산자는 `In`, `NotIn`, `Exists`, `DoesNotExist`, `Gt`, `Lt`입니다.

```yaml
# 결제 Pod는 zone이 a 또는 b인 노드에만
spec:
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
          - matchExpressions:
              - key: topology.kubernetes.io/zone
                operator: In
                values: ["zone-a", "zone-b"]
```

결합 규칙은 꼭 외웁니다. `nodeSelectorTerms` 안의 여러 항목은 OR이고 한 항목의 `matchExpressions` 안 여러 식은 AND입니다. nodeSelector와 nodeAffinity를 함께 쓰면 둘 다 만족해야 합니다. Pod 라벨을 기준으로 하는 Pod 어피니티는 5-12절에 있습니다.

### 5-7. 테인트와 톨러레이션

<details>
<summary>기초부터: 테인트는 밀어내고 어피니티는 끌어당긴다</summary>

> **핵심 한 줄**: 테인트(taint)는 노드에 거는 "견디지 못하는 Pod는 오지 마라"는 표시이고 톨러레이션(toleration)은 Pod에 적는 "그 테인트는 견딘다"는 표시입니다. 끌어당기는 일은 어피니티가 맡습니다.

#### 1. 왜 필요한가

특정 노드에서 일반 Pod를 비워 두고 싶을 때가 있습니다. 대표적인 예가 컨트롤 플레인 노드입니다. kubeadm은 컨트롤 플레인 노드에 `node-role.kubernetes.io/control-plane:NoSchedule`을 걸어 일반 Pod가 그 노드에 가지 않게 하고 kube-apiserver와 etcd의 자원을 지킵니다. `kubectl describe node <컨트롤 플레인 노드> | grep Taints`로 보입니다.

키, 값, effect가 맞는 톨러레이션이 있는 Pod만 그 노드에 들어갈 수 있습니다. Pod 배치를 고르는 장치이고 보안 격리와는 관계가 없습니다.

#### 2. 어떻게 동작하나 (누가 검사하나)

| effect | 검사하는 주체 | 새 Pod | 이미 돌던 Pod |
|---|---|---|---|
| `NoSchedule` | 스케줄러 | 톨러레이션 없으면 배치 안 함 | 건드리지 않음 |
| `PreferNoSchedule` | 스케줄러 | 되도록 피함 | 건드리지 않음 |
| `NoExecute` | 스케줄러 + kube-controller-manager의 테인트 축출 컨트롤러 | 배치 안 함 | 톨러레이션 없는 Pod를 내보냄 |

`kubectl taint`로 건 값은 Node 객체의 `spec.taints`에 `key`, `value`, `effect` 세 필드로 저장됩니다. Pod의 `spec.tolerations` 항목은 이 세 값과 `operator`로 맞춰 봅니다. 노드는 클러스터 자원이라 YAML을 고치기보다 `kubectl taint` 명령으로 거는 것이 보통입니다.

```text
테인트   : 노드 ──X──> 톨러레이션 없는 Pod   (밀어냄)
어피니티 : Pod  ────> 라벨이 맞는 노드       (끌어당김)
```

#### 3. 한눈에 비교: 결제 전용 노드 만들기

테인트는 다른 Pod를 막을 뿐 톨러레이션을 가진 Pod를 그 노드로 끌어오지 않습니다.

| 적용한 것 | 결과 | 남는 문제 |
|---|---|---|
| node02에 테인트, 결제 Pod에 톨러레이션 | 다른 Pod는 node02에 못 들어옴 | 결제 Pod가 일반 노드 node01로 갈 수도 있음 |
| 결제 Pod에 노드 어피니티만 | 결제 Pod는 node02로 감 | 다른 Pod도 node02의 빈자리에 들어옴 |
| 테인트 + 톨러레이션 + 노드 어피니티(또는 nodeSelector) | 결제 Pod는 node02에만, node02에는 결제 Pod만 | 없음 |

#### 4. 실전에서 보이는 모습

- 테인트가 걸린 노드만 남으면 Pod는 `Pending`이고 Events의 `FailedScheduling`에 "untolerated taint"가 있는 노드 수가 나옵니다.
- `NoExecute` 테인트를 걸면 톨러레이션 없는 Pod가 바로 축출되어 다른 노드에서 다시 만들어집니다.
- **톨러레이션 값의 따옴표**: `key`, `value`, `effect`는 문자열 필드라 `value: blue`처럼 따옴표 없이 적어도 됩니다. 값이 `1`이나 `true`처럼 YAML이 숫자나 불리언으로 읽는 모양일 때만 `"1"`처럼 따옴표로 감쌉니다.

> **정리**: 테인트만 걸면 결제 Pod가 다른 노드로 갈 수 있고 어피니티만 걸면 다른 Pod가 그 노드에 들어옵니다. 그래서 전용 노드에는 둘을 함께 씁니다.

</details>

```bash
kubectl taint nodes node02 dedicated=payment:NoSchedule     # 추가
kubectl taint nodes node02 dedicated=payment:NoSchedule-    # 제거(끝의 -)
kubectl describe node node02 | grep -i taints
```

```yaml
spec:
  tolerations:
    - key: dedicated
      operator: Equal
      value: payment
      effect: NoSchedule
```

| effect | 새 Pod | 이미 돌던 Pod |
|---|---|---|
| `NoSchedule` | 맞는 톨러레이션이 없으면 배치 안 함 | 그대로 둠 |
| `PreferNoSchedule` | 가능하면 피함. 보장 안 됨 | 그대로 둠 |
| `NoExecute` | 배치 안 함 | 톨러레이션이 없으면 즉시 축출. `tolerationSeconds`가 있으면 그 시간 뒤 축출 |

`operator`의 기본값은 `Equal`입니다. `Exists`면 `value`를 적지 않고 `key`까지 비우면 모든 테인트에 맞습니다. `DefaultTolerationSeconds` 승인 컨트롤러가 `node.kubernetes.io/not-ready`와 `node.kubernetes.io/unreachable`에 `tolerationSeconds=300`인 톨러레이션을 자동으로 붙입니다. 그래서 노드에 문제가 생기면 5분 뒤에 Pod가 옮겨집니다.

결제 전용 노드는 테인트로 다른 Pod를 막고 결제 Pod에 톨러레이션과 nodeSelector(또는 노드 어피니티)를 함께 넣어 만듭니다. 톨러레이션만 있으면 결제 Pod가 일반 노드에 놓일 수도 있습니다.

### 5-8. static Pod

<details>
<summary>기초부터: static Pod가 필요한 이유(닭과 달걀)</summary>

> **핵심 한 줄**: API 서버가 아직 없을 때 API 서버 Pod를 띄우는 주체는 kubelet입니다. kubelet이 노드 디렉터리의 YAML만 보고 혼자 띄운 Pod가 static Pod입니다.

#### 1. 왜 필요한가

Pod를 띄우려면 API 서버, etcd, 스케줄러가 있어야 합니다. 그런데 kubeadm은 이 컨트롤 플레인 구성요소 자체를 Pod로 돌립니다. API 서버가 아직 없는데 API 서버 Pod는 누가 띄울까요?

kubelet은 API 서버 없이도 노드의 정해진 디렉터리를 감시하다가 YAML 파일이 있으면 바로 컨테이너를 띄웁니다. 이것으로 닭과 달걀 문제가 풀립니다.

#### 2. 어떻게 동작하나 (컨트롤 플레인 노드의 부팅 순서)

1. **kubelet 시작**: systemd가 kubelet을 시작합니다.
2. **매니페스트 읽기**: kubelet이 `staticPodPath`(`/etc/kubernetes/manifests`)의 etcd, kube-apiserver, kube-controller-manager, kube-scheduler 매니페스트를 읽고 띄웁니다.
3. **mirror Pod 등록**: API 서버가 살아나면 kubelet이 static Pod마다 mirror Pod를 API 서버에 등록합니다. 그래서 `kubectl get pods -n kube-system`에 보입니다.
4. **이후 관리**: 파일을 고치면 kubelet이 Pod를 다시 만들고 파일을 지우면 Pod를 내립니다. 컨테이너가 죽으면 kubelet이 다시 띄웁니다.

```text
systemd → kubelet → /etc/kubernetes/manifests/*.yaml
                       ├─ etcd
                       ├─ kube-apiserver ──(살아나면)──> mirror Pod 등록
                       ├─ kube-controller-manager
                       └─ kube-scheduler
```

#### 3. 한눈에 비교

| 구분 | static Pod | DaemonSet |
|---|---|---|
| 만드는 주체 | 노드의 kubelet | API 서버의 DaemonSet 컨트롤러 |
| 정의가 있는 곳 | 노드 디렉터리의 파일 | API 객체(etcd) |
| 스케줄러 | 거치지 않음 | 거침 |
| 주 용도 | 컨트롤 플레인 구성요소 | 노드마다 하나씩 필요한 에이전트 |

#### 4. 헷갈리는 점 / 실전에서 보이는 모습

- **mirror Pod는 읽기용 사본**: 진짜 정의는 노드의 파일입니다. `kubectl edit`으로는 바꿀 수 없고 `kubectl delete`로 지워도 kubelet이 다시 등록합니다.
- **이름 끝에 노드 이름**: mirror Pod는 `kube-apiserver-controlplane`처럼 이름 뒤에 노드 이름이 붙어 구분됩니다.
- **Pod만 static으로 돈다**: kubelet이 이 디렉터리에서 읽는 것은 Pod 매니페스트뿐입니다. Deployment나 ReplicaSet 파일을 넣어도 static으로 돌지 않으니 복제가 필요하면 API 서버의 컨트롤러를 씁니다.
- **경로를 찾는 두 곳**: kubelet 설정 파일(`/var/lib/kubelet/config.yaml`)의 `staticPodPath`가 기본입니다. 옛 클러스터는 kubelet 실행 옵션 `--pod-manifest-path`로 줬을 수 있고 이 플래그는 설정 파일로 옮기라는 deprecated 표시가 붙어 있습니다. `ps -ef | grep kubelet`으로 `--config` 경로부터 찾습니다.
- **매니페스트를 잘못 고치면**: kube-apiserver가 다시 뜨지 못하고 `kubectl`이 `connection refused`로 응답하지 않습니다. 이때는 노드에서 `crictl ps -a`와 `crictl logs`로 컨테이너 상태를 봅니다.

> **정리**: static Pod는 노드 파일이 원본이고 API 서버에 보이는 것은 사본입니다. 바꾸려면 노드에 들어가 파일을 고칩니다.

</details>

static Pod는 API 서버를 거치지 않고 노드의 kubelet이 직접 관리하는 Pod입니다. kubeadm은 kube-apiserver, kube-controller-manager, kube-scheduler, etcd를 static Pod로 돌립니다.

- kubelet은 `staticPodPath`(kubeadm 노드는 `/etc/kubernetes/manifests`, `/var/lib/kubelet/config.yaml`에서 확인)의 점으로 시작하지 않는 모든 파일을 읽습니다. `kube-apiserver.yaml.backup`도 Pod가 되니 백업은 디렉터리 밖에 둡니다.
- API 서버에는 이름 뒤에 `-<노드 이름>`이 붙은 mirror Pod로 보입니다. `kubectl delete`로 지워도 다시 생기니 없애려면 매니페스트 파일을 지웁니다.
- static Pod의 spec은 ServiceAccount, ConfigMap, Secret 같은 다른 API 객체를 참조할 수 없습니다. 1.37에서 이 금지가 기능 게이트 없이 항상 적용됩니다.

시험은 과제마다 지정 호스트에 `ssh`로 들어가는 방식이고 ssh 중첩은 안 됩니다. 매니페스트는 그 노드에서 직접 쓰고 mirror Pod 확인은 kubectl이 설정된 호스트에서 합니다(base 호스트에는 kubectl이 없습니다).

```bash
ssh node01
sudo -i
grep staticPodPath /var/lib/kubelet/config.yaml
vi /etc/kubernetes/manifests/board-check.yaml     # 아래 YAML을 붙여 넣음
exit; exit                                        # root 셸과 ssh에서 나와 kubectl이 있는 호스트로
kubectl get pods -A -o wide | grep board-check    # board-check-node01
```

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: board-check
spec:
  containers:
    - name: board-check
      image: busybox
      command: ["sleep", "3600"]
```

### 5-9. PriorityClass

<details>
<summary>기초부터: 우선순위가 정해지고 선점이 일어나는 순서</summary>

> **핵심 한 줄**: PriorityClass로 Pod 사이의 중요도를 숫자로 매기고 자리가 없으면 스케줄러가 낮은 Pod를 내보내 높은 Pod의 자리를 만듭니다(선점).

#### 1. 왜 필요한가

노드가 꽉 찬 상태에서 결제 API Pod가 새로 떠야 합니다. 노드에는 언제 돌아도 되는 통계 배치 Pod가 자리를 차지하고 있습니다. 모든 Pod를 똑같이 대하면 결제 Pod는 배치가 끝날 때까지 `Pending`입니다.

#### 2. 어떻게 동작하나

1. **클래스 만들기**: 관리자가 PriorityClass(이름과 정수 `value`)를 만듭니다. 네임스페이스에 속하지 않는 클러스터 객체입니다.
2. **값 채우기**: Pod에 `priorityClassName`을 적으면 `Priority` 승인 컨트롤러가 그 클래스 값을 찾아 Pod의 `spec.priority`에 정수로 채웁니다. 없는 이름이면 이 단계에서 거절됩니다.
3. **대기열 정렬**: 스케줄러의 대기열은 우선순위가 높은 Pod부터 꺼냅니다.
4. **선점 시도**: 놓을 노드가 없으면 우선순위가 낮은 Pod 몇 개를 내보내면 자리가 나는 노드를 찾아 그 Pod들(희생자)을 종료시키고 높은 Pod의 `nominatedNodeName`에 그 노드를 적어 둡니다.
5. **배치**: 희생자가 종료 유예 시간을 마치고 사라지면 높은 Pod가 그 노드에 배치됩니다.

```text
결제 Pod (priority 1000) Pending
  → 스케줄러: 들어갈 노드 없음
  → node01의 배치 Pod (priority 100) 종료, 결제 Pod.nominatedNodeName = node01
  → 유예 시간 뒤 배치 Pod 사라짐 → 결제 Pod를 node01에 배치
```

#### 3. 한눈에 비교

| 항목 | 값 |
|---|---|
| 사용자 클래스 범위 | 10억(1000000000) 이하의 32비트 정수. 음수도 됨 |
| 10억보다 큰 값 | `system-cluster-critical`, `system-node-critical` 같은 시스템용 |
| 클래스를 적지 않은 Pod | `globalDefault: true`인 클래스 값. 그런 클래스도 없으면 0 |

| `preemptionPolicy` | 대기열 | 남을 내보내나 |
|---|---|---|
| `PreemptLowerPriority`(기본) | 앞에 섬 | 내보냄 |
| `Never` | 앞에 섬 | 내보내지 않음. 먼저 배치되고 싶지만 돌고 있는 Pod를 죽일 만큼 급하지 않은 작업 |

#### 4. 실전에서 보이는 모습

- **나눠 쓰는 예**: 결제와 주문 API는 높게, 배치와 리포트 작업은 낮게 두면 자원이 모자랄 때 낮은 쪽이 먼저 밀려납니다.
- **노드 압박 축출**: 노드 메모리가 모자라 kubelet이 Pod를 축출할 때도 우선순위가 순서에 반영됩니다.
- **선점 흔적**: 높은 Pod를 `kubectl get pod -o yaml`로 보면 배치 전까지 `status.nominatedNodeName`이 보이고 희생된 Pod의 Events에는 선점으로 종료됐다는 기록이 남습니다.
- **없는 클래스 이름**: Pod 생성이 승인 단계에서 바로 거절됩니다.

#### 5. YAML로 쓰면

`kubectl create priorityclass`가 만드는 객체를 YAML로 옮겼습니다. `value`는 `spec` 아래에 두지 않는 최상위 필드입니다.

```yaml
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: payment-high
value: 100000
globalDefault: false                    # true는 클러스터에 하나만
description: "결제 API용"
preemptionPolicy: PreemptLowerPriority  # 또는 Never
```

> **정리**: 값은 승인 단계에서 채워지고 대기열 순서와 선점에 쓰입니다. 남을 내보내지 않게 하려면 `preemptionPolicy: Never`를 적습니다.

</details>

PriorityClass는 이름에 정수 우선순위를 붙이는 클러스터 범위 객체입니다. 사용자가 만드는 값은 10억(1000000000) 이하이고 그보다 큰 값은 `system-cluster-critical`(2000000000)과 `system-node-critical`(2000001000) 같은 시스템용입니다.

```bash
kubectl create priorityclass payment-high --value=100000 \
  --description="결제 API용"
kubectl create priorityclass batch-low --value=1000 \
  --description="배치, 선점하지 않음" --preemption-policy=Never
```

```yaml
spec:
  priorityClassName: payment-high
```

- 없는 이름은 `no PriorityClass with name nope was found`로, 10억을 넘는 값은 `maximum allowed value of a user defined priority is 1000000000`으로 거절됩니다.
- `globalDefault: true`는 하나만 둘 수 있고 없으면 이름을 적지 않은 Pod의 우선순위는 0입니다.
- 놓을 노드가 없으면 스케줄러가 우선순위 낮은 Pod를 축출해 자리를 만듭니다(선점). `preemptionPolicy: Never`면 대기열 앞에만 서고 선점하지 않습니다.

kind에서 선점이 일어나면 높은 Pod는 희생자의 종료 유예 동안 `Pending`이고 `.status.nominatedNodeName`이 채워집니다.

```text
FailedScheduling  ... preemption: found a potential placement for pod on node node01, preempting 1 victims
Preempted         Preempted by pod <uid> on node node01
```

### 5-10. DaemonSet

<details>
<summary>기초부터: 노드마다 Pod 하나를 놓는 방법</summary>

> **핵심 한 줄**: DaemonSet은 조건에 맞는 노드마다 Pod 하나를 유지합니다. `replicas`가 없고 Pod 수는 노드 수가 정합니다.

#### 1. 왜 필요한가

노드마다 로그 수집기를 하나씩 띄워야 합니다.

| 방식 | 문제 |
|---|---|
| Deployment로 레플리카를 노드 수만큼 | 같은 노드에 둘이 몰릴 수 있고 노드가 늘 때마다 숫자를 고쳐야 함 |
| DaemonSet | 새 노드에는 Pod를 만들고 빠진 노드의 Pod는 정리하며 DaemonSet을 지우면 Pod도 함께 지워짐 |

로그 수집기, 노드 모니터링 에이전트(node-exporter), CNI 플러그인, kube-proxy처럼 모든 노드에 상주해야 하는 프로그램이 이 방식으로 돕니다.

#### 2. 어떻게 동작하나

1. **빈 노드 찾기**: DaemonSet 컨트롤러가 노드 목록을 보고 자기 Pod가 없는 노드를 찾습니다.
2. **Pod 만들기**: 그 노드용 Pod를 만들면서 노드 어피니티에 `matchFields`로 `metadata.name In [<그 노드 이름>]`을 넣고 아래 본문의 톨러레이션들을 자동으로 붙입니다.
3. **스케줄링**: 기본 스케줄러가 그 Pod를 다른 Pod처럼 처리합니다. 어피니티 때문에 후보는 그 노드 하나뿐입니다.

```text
DaemonSet 컨트롤러: node03에 내 Pod 없음
  → Pod 생성 (nodeAffinity: metadata.name In [node03], 톨러레이션 자동 추가)
  → 스케줄러: 후보 node03 하나 → 자원 확인, 필요하면 선점
  → node03 kubelet이 실행
```

#### 3. 예전 방식과 비교

| 구분 | 1.11까지 | 1.12부터(기본) |
|---|---|---|
| 노드 지정 | DaemonSet 컨트롤러가 `nodeName`을 직접 채움 | 노드 어피니티로 그 노드만 후보로 둠 |
| 스케줄러 | 건너뜀 | 거침 |
| 자원 계산, 선점 | 빠짐. 자리가 없으면 kubelet이 `OutOfcpu` 같은 이유로 거부 | 적용. 낮은 우선순위 Pod를 내보내 자리를 만들 수 있음 |
| 승인 단계 | 거침 | 거침 |

두 방식 모두 승인 단계는 거칩니다. `nodeName`으로 만든 Pod도 승인 컨트롤러를 통과해야 저장됩니다.

#### 4. 실전에서 보이는 모습

- `kubectl get ds`의 `DESIRED`와 `CURRENT`, `READY` 숫자가 노드 수와 맞는지 봅니다. 차이가 나면 테인트가 걸린 노드에 톨러레이션이 없는 경우가 흔합니다.

> **정리**: DaemonSet은 노드 수만큼 Pod를 유지하고 1.12부터는 노드 어피니티로 스케줄러를 거쳐 선점과 우선순위를 그대로 씁니다.

</details>

DaemonSet은 조건에 맞는 노드마다 Pod를 하나씩 띄우는 컨트롤러입니다. 로그 수집 에이전트, CNI 플러그인, kube-proxy가 이 방식으로 돕니다. static Pod(5-8절)와 달리 API 서버의 객체이고 컨트롤러와 스케줄러를 거칩니다. `kubectl create` 하위 명령이 없어 Deployment 뼈대를 받아 고칩니다.

```bash
kubectl create deployment log-agent -n kube-system --image=fluent/fluent-bit:3.0 \
  --dry-run=client -o yaml > log-agent.yaml
# kind를 DaemonSet으로 바꾸고 replicas, strategy, status 줄을 지운 뒤
kubectl apply -f log-agent.yaml
kubectl get ds -n kube-system
```

- 컨트롤러가 노드마다 노드 어피니티를 넣은 Pod를 만들고 배치는 기본 스케줄러가 맡습니다. 스케줄러가 멈추면 새 DaemonSet Pod도 `Pending`입니다.
- `not-ready`, `unreachable`, `disk-pressure`, `memory-pressure`, `pid-pressure`, `unschedulable` 톨러레이션이 자동으로 붙어 cordon한 노드에도 뜹니다.
- 컨트롤 플레인의 `node-role.kubernetes.io/control-plane:NoSchedule`은 자동 톨러레이션에 없어 템플릿에 직접 적습니다. 일부 노드에만 띄우려면 `nodeSelector`를 적습니다.

### 5-11. 다중 스케줄러와 스케줄러 프로파일

<details>
<summary>기초부터: 스케줄링 프레임워크의 단계와 프로파일</summary>

> **핵심 한 줄**: 스케줄러의 결정 한 번은 여러 단계(확장 지점)로 나뉘고 nodeSelector, 어피니티, 테인트, 우선순위는 모두 이 단계에 끼운 플러그인입니다.

#### 1. 어떻게 동작하나

```text
대기열 정렬 → preFilter → filter → postFilter → preScore → score → reserve → permit → preBind → bind → postBind
```

1. **대기열 정렬**: 우선순위가 높은 Pod부터 꺼냅니다.
2. **filter**: 갈 수 없는 노드를 뺍니다.
3. **postFilter**: 남은 노드가 없을 때 선점을 시도합니다.
4. **score**: 남은 노드에 점수를 매깁니다.
5. **reserve, permit**: 고른 노드의 자원을 먼저 잡아 두고 배치 허락을 기다립니다.
6. **bind**: API 서버에 Binding을 기록합니다.

| 단계 | 하는 일 | 대표 플러그인 |
|---|---|---|
| 대기열 정렬 | 우선순위가 높은 Pod부터 꺼냄 | `PrioritySort` |
| filter | 갈 수 없는 노드를 뺌 | `NodeResourcesFit`(request 자리), `NodeAffinity`, `TaintToleration`, `NodeUnschedulable`, `NodeName` |
| postFilter | 남은 노드가 없을 때 선점 | `DefaultPreemption` |
| score | 남은 노드에 점수를 매김 | `ImageLocality`(이미지가 이미 있는 노드에 가점), `NodeResourcesBalancedAllocation` |
| reserve, permit | 고른 노드의 자원을 먼저 잡아 두고 배치 허락을 기다림 | |
| bind | API 서버에 Binding 기록 | `DefaultBinder` |

단계 하나하나가 **확장 지점(extension point)**이고 플러그인은 특정 지점에 끼워지는 코드입니다.

- **NormalizeScore**: "Scheduling Framework" 문서는 score 뒤에 같은 플러그인이 자기 점수를 최종 순위 계산 전에 고쳐 맞추는 NormalizeScore 지점을 둡니다. 플러그인마다 점수 범위가 달라도 합산할 수 있게 하는 자리입니다.
- **reserve가 있는 이유**: 바인딩이 끝나기를 기다리는 동안 다른 Pod가 같은 자리를 계산에 넣는 경쟁 상태를 막으려고 고른 노드의 자원을 먼저 잡아 둡니다. bind가 실패하면 Unreserve로 풀어 줍니다.

#### 2. 다른 배치 규칙이 필요할 때의 두 길

1. **스케줄러를 하나 더 띄우기**: kube-scheduler를 Deployment로 하나 더 띄웁니다. 설정 파일(`KubeSchedulerConfiguration`)은 ConfigMap으로 만들어 볼륨으로 마운트하고 노드와 Pod를 읽고 Binding을 쓸 수 있도록 ServiceAccount와 RBAC 권한을 줍니다. 복제본을 여럿 두면 하나만 일하도록 `leaderElection`을 켭니다. Pod에는 `schedulerName: my-scheduler`를 적습니다.
2. **프로파일**: 한 kube-scheduler 프로세스의 설정에 `profiles`를 여러 개 두고 프로파일마다 `schedulerName`과 플러그인 켜고 끄기를 적습니다(1.18부터).

```yaml
apiVersion: kubescheduler.config.k8s.io/v1
kind: KubeSchedulerConfiguration
profiles:
  - schedulerName: default-scheduler
  - schedulerName: no-scoring-scheduler   # 점수 단계를 끈 프로파일
    plugins:
      preScore:
        disabled: [{ name: "*" }]
      score:
        disabled: [{ name: "*" }]
```

플러그인을 더할 때는 같은 확장 지점 아래에 `enabled`를 적습니다. 문서 예시는 score에서 기본 `PodTopologySpread`를 `disabled`로 빼고 직접 만든 플러그인을 `enabled`에 `weight`와 함께 넣습니다. `disabled`의 `name: "*"`는 그 지점의 기본 플러그인을 모두 끕니다.

#### 3. 한눈에 비교

| 구분 | 스케줄러 프로세스 둘 | 프로파일 |
|---|---|---|
| 프로세스 | 둘 | 하나 |
| 대기열과 노드 상태 캐시 | 따로. 서로의 결정을 모른 채 같은 빈자리를 계산 | 함께 씀 |
| 충돌 | 둘이 동시에 같은 자리에 Pod를 놓으면 kubelet이 한쪽을 거부 | 없음 |
| 운영 부담 | Deployment, ConfigMap, RBAC, leaderElection | 설정 파일 하나 |

#### 4. 실전에서 보이는 모습

- Pod의 `schedulerName`에 없는 스케줄러 이름을 적으면 아무도 그 Pod를 꺼내지 않아 `Pending`이고 Events도 남지 않습니다.
- 어느 스케줄러가 배치했는지는 `kubectl get events`의 `Scheduled` 이벤트 출처(source)로 봅니다.

> **정리**: 스케줄링은 단계마다 플러그인이 끼워진 파이프라인입니다. 규칙을 바꿀 때는 충돌이 없는 프로파일 쪽이 편합니다.

</details>

Pod의 `spec.schedulerName`이 담당 스케줄러를 정합니다. 적지 않으면 `default-scheduler`이고 없는 이름이면 `Pending`에 남으며 만든 뒤에는 바꿀 수 없습니다. 스케줄러를 더 두는 방법은 kube-scheduler를 하나 더 띄우기("Configure Multiple Schedulers")와 `KubeSchedulerConfiguration`의 `profiles[].schedulerName`으로 프로파일 여러 개 두기("Scheduler Configuration")입니다. 누가 배치했는지는 이벤트로 봅니다.

```bash
kubectl get events -n board -o wide | grep Scheduled     # SOURCE 열에 my-scheduler
kubectl logs -n kube-system deploy/my-scheduler          # Pending이면 권한, 설정 경로 오류 확인
```

### 5-12. Pod 어피니티, 안티 어피니티, topologySpreadConstraints

Pod 어피니티와 안티 어피니티는 이미 떠 있는 Pod의 라벨을 봅니다. `topologyKey`로 묶은 영역(`kubernetes.io/hostname`이면 노드, `topology.kubernetes.io/zone`이면 존)에 조건에 맞는 Pod가 있으면 `podAffinity`는 그 영역으로 끌어당기고 `podAntiAffinity`는 피합니다. required와 preferred 구분은 노드 어피니티와 같습니다. 장바구니 캐시를 노드마다 하나씩 흩는 예입니다. 캐시가 있는 노드에 API를 붙이려면 같은 모양으로 `podAffinity`를 씁니다.

```yaml
# cart-cache Deployment의 Pod 템플릿 일부: 같은 노드에 cart-cache 둘을 두지 않음
      labels:
        app: cart-cache
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  app: cart-cache
              topologyKey: kubernetes.io/hostname
```

preferred로 쓸 때는 항목을 `- weight: 100`과 `podAffinityTerm:`으로 감싸고 그 안에 `labelSelector`와 `topologyKey`(비울 수 없음)를 둡니다.

- `labelSelector`는 `namespaces`나 `namespaceSelector`가 없으면 이 Pod의 네임스페이스만 봅니다.
- 레플리카가 노드 수보다 많으면 required 안티 어피니티로는 남는 Pod가 `Pending`이 되고 Events에 `didn't match pod anti-affinity rules`가 찍힙니다.

영역마다 개수를 고르게 맞추려면 `topologySpreadConstraints`를 씁니다.

| 필드 | "Pod Topology Spread Constraints" 문서 기준 의미 |
|---|---|
| `maxSkew` | 영역 사이 Pod 수 차이의 허용치. 0보다 커야 함 |
| `topologyKey` | 영역을 가르는 노드 라벨 키 |
| `whenUnsatisfiable` | `DoNotSchedule`(기본, 어기면 배치 안 함) 또는 `ScheduleAnyway`(배치하되 차이를 줄이는 노드에 높은 점수) |
| `labelSelector` | 개수를 셀 Pod. 보통 자기 Pod 템플릿 라벨과 같게 둠 |

```yaml
# order-api Pod 템플릿의 spec 아래: 존 사이 개수 차이를 1 이하로
topologySpreadConstraints:
  - maxSkew: 1
    topologyKey: topology.kubernetes.io/zone
    whenUnsatisfiable: DoNotSchedule
    labelSelector:
      matchLabels:
        app: order-api
```

존 세 개에 2, 2, 1개가 있고 `maxSkew: 1`이면 새 Pod는 1개인 존에만 갑니다. 2개인 존에 가면 차이가 2가 되기 때문입니다.

- `topologyKey` 라벨이 없는 노드는 계산에서 빠지고 이 Pod도 가지 않습니다. 존 라벨이 없는 클러스터에서는 라벨부터 붙입니다.
- `nodeTaintsPolicy` 기본값이 `Ignore`라서 Pod가 갈 수 없는 테인트 노드(컨트롤 플레인 등)도 Pod 0개인 영역으로 셉니다. 워커 2대와 컨트롤 플레인 1대에서 레플리카 4개에 노드 단위 `maxSkew: 1`, `DoNotSchedule`을 걸면 워커마다 1개씩만 뜨고 2개가 `Pending`입니다. 제약에 `nodeTaintsPolicy: Honor`를 더하면 2와 2로 배치됩니다.
- 조건은 스케줄링 시점에만 봅니다. Pod가 지워져 쏠림이 생겨도 다시 맞추지 않습니다.

### 5-13. 직접 해 보기

1. `node02`에 `dedicated=payment:NoSchedule`을 걸고 톨러레이션 없는 Pod가 모두 `node01`로, 톨러레이션과 노드 어피니티를 넣은 결제 Pod는 `node02`로 가는지 봅니다.
2. `pods=3` 쿼터에 레플리카 5개 Deployment를 만들고 ReplicaSet에서 `FailedCreate`를 찾습니다.
3. `/etc/kubernetes/manifests/kube-scheduler.yaml`을 디렉터리 밖으로 옮겨 스케줄러를 멈추고 `Pending` Pod를 Binding으로 놓은 뒤 되돌립니다.
4. `cart-cache` 레플리카를 노드 수보다 하나 많게 만들어 남는 Pod의 Events를 봅니다.
5. "Validating Admission Policy" 문서의 `replicas <= 5` 예제를 `resources: ["deployments"]`만 둔 채 만들고 `kubectl scale --replicas=7`이 통과하는지 확인합니다.

## 6. 확인 문제

위 내용을 바탕으로 직접 만든 연습 과제입니다.

1. `shop` 네임스페이스의 Deployment `order-api` 이미지를 `nginx:1.28`로 바꾸고 롤아웃이 끝나면 바로 이전 리비전으로 되돌리세요.
2. Deployment `board-web`이 롤링 업데이트 중에도 사용 가능한 Pod 4개를 유지하도록 전략을 바꾸세요. 레플리카는 4개입니다.
3. ConfigMap `board-config`의 모든 키를 Deployment `board-web`의 환경 변수로 넣으세요. 나중에 더한 키도 Pod를 다시 만들면 들어가야 합니다.
4. Deployment `order-api`에 CPU 평균 사용률 70%를 목표로 최소 2, 최대 6개의 HPA를 만드세요. HPA의 TARGETS가 `<unknown>`이면 무엇을 확인할지도 적으세요.
5. 네임스페이스 `payment`에 컨테이너 기본 request `cpu=200m,memory=128Mi`, 기본 limit `cpu=400m,memory=256Mi`를 강제하세요.
6. `node02`에서 `app=payment` 라벨이 있는 Pod만 돌게 하세요. 다른 Pod는 `node02`에 새로 놓이지 않아야 합니다.
7. `node01`에 static Pod `board-check`(이미지 busybox, `sleep 3600`)를 만들고 mirror Pod 이름을 확인하세요.
8. 우선순위 50000인 PriorityClass `payment-high`를 만들고 Deployment `payment-api`에 적용하세요.
9. Pod `board`의 앱이 `/var/log/board/access.log`에 쓰는 로그를 앱보다 먼저 떠서 계속 도는 사이드카 `log-shipper`가 stdout으로 내보내게 하세요.
10. `shop` 네임스페이스의 Deployment `order-api`(레플리카 3, 라벨 `app=order-api`)가 노드 drain 중에도 최소 2개 유지되게 하고 레플리카가 같은 노드에 둘 이상 놓이지 않게 하세요.

<details>
<summary>풀이 보기</summary>

1. 컨테이너 이름을 먼저 확인합니다.
   ```bash
   kubectl get deploy order-api -n shop -o jsonpath='{.spec.template.spec.containers[*].name}'
   kubectl set image deployment/order-api -n shop <컨테이너>=nginx:1.28
   kubectl rollout status deployment/order-api -n shop
   kubectl rollout undo deployment/order-api -n shop
   ```
2. `maxUnavailable: 0`이면 `maxSurge`는 0일 수 없습니다.
   ```bash
   kubectl patch deployment board-web -p \
     '{"spec":{"strategy":{"rollingUpdate":{"maxUnavailable":0,"maxSurge":1}}}}'
   ```
3. `set env --from`은 키마다 `env` 항목을 만들어 나중에 더한 키를 받지 못합니다(2-3절). `kubectl edit deployment board-web`으로 컨테이너에 `envFrom: [{configMapRef: {name: board-config}}]`를 적습니다.
4. `kubectl autoscale deployment order-api -n shop --cpu=70% --min=2 --max=6`. `<unknown>`이면 `kubectl describe hpa`에서 `missing request for cpu`를 찾고 `kubectl top pods`로 Metrics Server를 봅니다.
5. 5-3절 YAML에서 `max`를 빼고 `defaultRequest: { cpu: 200m, memory: 128Mi }`, `default: { cpu: 400m, memory: 256Mi }`로 `payment`에 만듭니다. 이미 떠 있는 Pod에는 적용되지 않으니 필요하면 `kubectl rollout restart`로 다시 띄웁니다.
6. 테인트로 다른 Pod를 막고 결제 Pod는 톨러레이션과 nodeSelector로 보냅니다.
   ```bash
   kubectl taint nodes node02 app=payment:NoSchedule
   kubectl label nodes node02 app=payment
   ```
   ```yaml
   # Pod 템플릿의 spec 아래
   nodeSelector: { app: payment }
   tolerations:
     - { key: app, operator: Equal, value: payment, effect: NoSchedule }
   ```
   이미 `node02`에 있던 다른 Pod까지 내보내야 하면 `NoExecute`를 씁니다.
7. 5-8절 순서대로 `ssh node01` 뒤 `staticPodPath` 디렉터리에 매니페스트를 쓰고 `kubectl get pods -A | grep board-check`로 `board-check-node01`을 확인합니다.
8. PriorityClass를 만들고 Pod 템플릿에 이름을 넣습니다.
   ```bash
   kubectl create priorityclass payment-high --value=50000
   kubectl patch deployment payment-api -p \
     '{"spec":{"template":{"spec":{"priorityClassName":"payment-high"}}}}'
   ```
9. 4-4절의 YAML이 답입니다. 사이드카를 `initContainers`에 `restartPolicy: Always`로 두고 앱과 같은 `emptyDir`을 마운트합니다. 기존 Pod가 있으면 `kubectl replace --force -f`로 다시 만들고 `kubectl logs board -c log-shipper`로 확인합니다.
10. `kubectl create pdb order-api-pdb -n shop --selector=app=order-api --min-available=2`를 만들고 `kubectl edit deployment order-api -n shop`으로 5-12절의 required `podAntiAffinity`(`app: order-api`, `topologyKey: kubernetes.io/hostname`)를 넣습니다. 레플리카 3개의 기본 전략은 1-1절 계산대로 `maxUnavailable` 0, `maxSurge` 1입니다. 노드가 세 대뿐이고 모두 옛 Pod가 있으면 새 Pod가 갈 노드가 없어 롤아웃이 멈추니 `maxUnavailable`을 1로 둡니다.

</details>

## 범위와 한계

- 명령과 YAML, 오류 문구는 kind 클러스터(노드 v1.37.0, 컨트롤 플레인 1대와 워커 2대, kubectl v1.37.1)에서 2026년 10월에 직접 돌려 확인했습니다. 노드 이름은 `node01`, `node02`로 바꿔 적었습니다.
- VPA 1.8.0 설치와 3-3절 YAML, startupProbe 예시, 선점, htpasswd 레지스트리 인증, VAP 거부도 같은 kind 클러스터에서 확인했습니다. 웹훅은 이미지 빌드가 필요해 서버 없는 웹훅의 500 응답만 봤습니다.
- 시험 환경에 Metrics Server와 VPA가 미리 설치되어 있는지는 공식 문서로 확인하지 못했습니다.
- 기능 게이트 단계와 `metrics.k8s.io/v1` stable처럼 버전마다 바뀌는 사실은 응시 시점의 kubernetes.io 문서로 다시 확인합니다. 확인 문제는 제가 만든 것이고 실제 시험 문항과 관계없습니다.

## 참고 자료

- CNCF, [CKA Curriculum v1.37](https://github.com/cncf/curriculum/blob/master/CKA_Curriculum_v1.37.pdf); Linux Foundation, [Important Instructions: CKA and CKAD](https://docs.linuxfoundation.org/tc-docs/certification/tips-cka-and-ckad)
- Kubernetes 개념: [Deployments](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/), [ConfigMaps](https://kubernetes.io/docs/concepts/configuration/configmap/), [Secrets](https://kubernetes.io/docs/concepts/configuration/secret/), [Horizontal Pod Autoscaling](https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/), [Vertical Pod Autoscaling](https://kubernetes.io/docs/concepts/workloads/autoscaling/vertical-pod-autoscale/), [Sidecar Containers](https://kubernetes.io/docs/concepts/workloads/pods/sidecar-containers/), [StatefulSets](https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/), [Jobs](https://kubernetes.io/docs/concepts/workloads/controllers/job/), [DaemonSet](https://kubernetes.io/docs/concepts/workloads/controllers/daemonset/)
- Kubernetes 태스크: [HorizontalPodAutoscaler Walkthrough](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale-walkthrough/), [Resize CPU and Memory Resources assigned to Containers](https://kubernetes.io/docs/tasks/configure-pod-container/resize-container-resources/), [Configure Liveness, Readiness and Startup Probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/), [Specifying a Disruption Budget](https://kubernetes.io/docs/tasks/run-application/configure-pdb/), [Create static Pods](https://kubernetes.io/docs/tasks/configure-pod-container/static-pod/)
- Kubernetes 스케줄링과 승인: [Resource Management for Pods and Containers](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/), [Pod Quality of Service Classes](https://kubernetes.io/docs/concepts/workloads/pods/pod-qos/), [Limit Ranges](https://kubernetes.io/docs/concepts/policy/limit-range/), [Resource Quotas](https://kubernetes.io/docs/concepts/policy/resource-quotas/), [Assigning Pods to Nodes](https://kubernetes.io/docs/concepts/scheduling-eviction/assign-pod-node/), [Taints and Tolerations](https://kubernetes.io/docs/concepts/scheduling-eviction/taint-and-toleration/), [Pod Topology Spread Constraints](https://kubernetes.io/docs/concepts/scheduling-eviction/topology-spread-constraints/), [Pod Priority and Preemption](https://kubernetes.io/docs/concepts/scheduling-eviction/pod-priority-preemption/), [Admission Control in Kubernetes](https://kubernetes.io/docs/reference/access-authn-authz/admission-controllers/)
- 튜토리얼과 기술 블로그: [StatefulSet Basics](https://kubernetes.io/docs/tutorials/stateful-application/basic-stateful-set/), Colin Breck, [Kubernetes Liveness and Readiness Probes: How to Avoid Shooting Yourself in the Foot](https://blog.colinbreck.com/kubernetes-liveness-and-readiness-probes-how-to-avoid-shooting-yourself-in-the-foot/), 악분, [쿠버네티스에 설정한 probe가 어떻게 실행되는지 알아야 하는 이유](https://akbun.substack.com/p/probe)
- 버전 변경: [Kubernetes v1.37 릴리스](https://kubernetes.io/blog/2026/08/26/kubernetes-v1-37-release/), [In-place resize GA(v1.35)](https://kubernetes.io/blog/2025/12/19/kubernetes-v1-35-in-place-pod-resize-ga/), [CHANGELOG-1.34](https://github.com/kubernetes/kubernetes/blob/master/CHANGELOG/CHANGELOG-1.34.md)

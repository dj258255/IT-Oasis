---
title: '[CKA] 기본 오브젝트와 컨트롤 플레인: kubectl 한 줄이 Pod가 되기까지'
description: kubectl run 한 줄이 API 서버의 인증, 인가, 어드미션, 스키마 검증을 지나 etcd에 저장되고 스케줄러와 kubelet을 거쳐 Running이 되는 경로를 따라갑니다. 컨트롤 플레인 구성요소와 인증서 방향, Pod와 ReplicaSet, Deployment, Service, Namespace의 관계, 시험에서 쓰는 명령형과 선언형 kubectl, 실행 중인 Pod에서 고칠 수 있는 필드를 정리했습니다.
date: 2026-10-20T00:00:00.000Z
tags:
  - CKA
  - Kubernetes
  - Control Plane
  - kube-apiserver
  - Pod
  - kubectl
category: cert/CKA
topics:
  - cert
coverImage: /uploads/cert/cka/k8s-architecture.webp
draft: false
series: "CKA 공부"
seriesOrder: 4
---

![쿠버네티스 클러스터 구조: 컨트롤 플레인(etcd, API Server, Scheduler, Controller Manager, Cloud Controller Manager)과 워커 노드(kubelet, Container Runtime, kube-proxy)](/uploads/cert/cka/k8s-architecture.webp)

*그림 출처: [DevOps Mojo](https://medium.com/devops-mojo), Ashish Patel*

## 결론부터

1. `kubectl run` 한 줄은 API 서버 안에서 인증(실패 시 401), 인가(실패 시 403), 변형 어드미션, 스키마 검증, 검증 어드미션을 차례로 지나 etcd에 저장됩니다. 이때 `spec.nodeName`은 비어 있고 kubectl은 이 시점에 응답을 받고 끝납니다. 노드를 고르고 컨테이너를 띄우는 일은 그 뒤에 스케줄러와 kubelet이 각자 watch로 알아채서 합니다.
2. etcd와 직접 통신하는 구성요소는 kube-apiserver 하나뿐입니다. 스케줄러, 컨트롤러 매니저, kubelet, kube-proxy는 모두 API 서버의 클라이언트로 붙고 각자 kubeconfig의 클라이언트 인증서로 자신을 증명합니다.
3. `kubectl get pod`의 STATUS 열에 보이는 `ContainerCreating`, `CrashLoopBackOff`는 컨테이너 상태 `Waiting`의 reason이고 그동안 Pod phase는 각각 `Pending`, 대개 `Running`입니다. phase는 Pending, Running, Succeeded, Failed, Unknown 다섯 가지뿐입니다.
4. ReplicaSet은 selector에 맞는 주인 없는 Pod를 자기 것으로 입양합니다. Deployment는 Pod 템플릿이 바뀔 때만 새 리비전을 만들고 레플리카 수 변경은 리비전을 만들지 않습니다.
5. 실행 중인 Pod는 이미지, `activeDeadlineSeconds`, 톨러레이션 추가 정도만 고칠 수 있습니다(`terminationGracePeriodSeconds`는 이전 값이 음수였을 때 1로 바꾸는 경우만 허용). `kubectl edit`이 거부되면 수정본이 임시 디렉터리(리눅스는 `/tmp`)의 `kubectl-edit-*.yaml`에 남으니 그 파일로 `kubectl replace --force -f`를 실행합니다.

이 글은 [3편](/blog/cert/cka/cka-01-why-kubernetes)과 [5편](/blog/cert/cka/cka-02-cluster-architecture) 사이의 기초 편입니다. 뒤 글들이 전제로 까는 요청 흐름과 오브젝트 관계, 시험에서 쓰는 kubectl 방식을 한 번에 잡습니다. 롤링 업데이트와 스케줄링 세부는 [6편](/blog/cert/cka/cka-03-workloads-scheduling)에, Service 타입은 [7편](/blog/cert/cka/cka-04-services-networking)에, 구성요소 장애 대응은 [9편](/blog/cert/cka/cka-06-troubleshooting)에 있습니다.

---

## 1. kubectl run에서 Running까지의 경로

쇼핑몰 주문 API Pod 하나를 만드는 명령으로 따라갑니다.

```bash
kubectl run order-api --image=nginx:1.27 -n shop
```

### 1-1. 전체 흐름

공식 문서 "Controlling Access to the Kubernetes API", "Admission Control", "Scheduling Framework", "API Concepts"에 흩어진 내용을 시간 순서로 이은 그림입니다.

```text
kubectl
  │  HTTPS POST /api/v1/namespaces/shop/pods
  ▼
kube-apiserver
  1) 인증 (Authentication)        실패 → 401 Unauthorized
  2) 인가 (Authorization, RBAC)   실패 → 403 Forbidden
  3) 변형 어드미션 (Mutating)      기본값 주입, ServiceAccount, 톨러레이션 추가
  4) 스키마 검증 (Validation)      필드 형식, 필수값
  5) 검증 어드미션 (Validating)    ResourceQuota, PodSecurity 등. 하나라도 거부하면 전체 거부
  6) etcd 저장  (spec.nodeName 비어 있음)
  │
  ├──▶ kubectl에 201 Created 응답. kubectl은 여기서 끝
  │
  ▼  watch 이벤트 (ADDED)
kube-scheduler
  - nodeName이 빈 Pod를 큐에 넣음
  - Filter로 후보 노드 거르기 → Score로 점수 매기기
  - POST pods/order-api/binding  → API 서버가 spec.nodeName 기록
  │
  ▼  watch 이벤트 (spec.nodeName=<자기 노드>로 걸러서 봄)
kubelet (해당 노드)
  - CRI로 컨테이너 런타임 호출: 샌드박스(pause) 생성, 이미지 받기, 컨테이너 시작
  - PATCH pods/order-api/status  → phase, conditions, containerStatuses, podIP
```

kubectl이 `pod/order-api created`를 출력한 순간에는 아직 노드도 정해지지 않았습니다.

그래서 명령이 성공했는데 Pod가 `Pending`에 남는 일이 생깁니다. API 서버의 관문은 통과했고 스케줄러나 kubelet 쪽에서 멈춘 경우입니다.

같은 경로를 kubectl 소스 코드부터 컨테이너 시작까지 한 단계씩 따라간 글로 Jamie Hannaford의 [What happens when ... Kubernetes edition!](https://github.com/jamiehannaford/what-happens-when-k8s)이 있습니다. 다만 쿠버네티스 1.8 무렵에 쓰인 글이라 옛 내용이 섞여 있습니다.

- `kubectl run`이 Deployment를 만들던 시절의 동작
- 지금은 없어진 Initializers
- Docker 런타임

순서를 잡는 데만 쓰고 세부는 이 글과 공식 문서로 확인합니다.

### 1-2. API 서버 안의 다섯 관문

<details>
<summary>기초부터: 어드미션 컨트롤러는 왜 있고 어떻게 끼어드는지</summary>

> **핵심 한 줄**: **어드미션 컨트롤러**는 인증과 인가를 통과한 쓰기 요청이 etcd에 저장되기 직전에 요청의 내용물을 보고 고치거나 막는 kube-apiserver 안의 플러그인입니다.

#### 1. 왜 필요한가

| 단계 | 묻는 것 | 볼 수 있는 범위 |
|---|---|---|
| 인증 | 누구냐 | 사용자 이름, 그룹 |
| 인가(RBAC) | 이 사람이 shop 네임스페이스에 Pod를 만들어도 되느냐 | 동작의 겉면(동사, 리소스, 네임스페이스) |
| 어드미션 | 만들려는 Pod의 내용이 정책에 맞느냐 | 요청 객체 전체 |

만들려는 Pod가 어느 레지스트리의 이미지를 쓰는지, root로 돌려 하는지, 필수 라벨을 달았는지는 RBAC 규칙으로 표현할 수 없습니다. 요청의 내용물을 보고 고치거나 막는 단계가 따로 있어야 하는데, 그게 어드미션 컨트롤입니다.

#### 2. 어떻게 동작하나

1. **대상 고르기**: 인증과 인가를 통과한 쓰기 요청(생성, 수정, 삭제)만 받습니다. 읽기 요청은 거치지 않습니다.
2. **변형(Mutating)**: 요청 객체를 고쳐서 돌려줍니다.
3. **검증(Validating)**: 고치지 않고 허용이나 거부만 합니다.
4. **저장**: 모두 통과한 객체만 etcd에 들어갑니다.

```text
쓰기 요청 → 인증 → 인가 → 변형 어드미션 → 스키마 검증 → 검증 어드미션 → etcd
                         (값을 고침)                      (허용/거부만)
```

순서는 항상 변형이 먼저이고 검증이 나중입니다. 변형 플러그인이 값을 바꿀 수 있으니 바뀐 최종 모습을 검증해야 빈틈이 없습니다. 검증이 먼저 돌면 통과한 뒤에 값이 바뀌어 정책을 어기는 객체가 저장될 수 있습니다.

#### 3. 한눈에 비교

| 종류 | 하는 일 | 예 |
|---|---|---|
| 변형(Mutating) | 요청 객체를 고쳐서 돌려줌 | `DefaultStorageClass`가 storageClassName 없는 PVC에 기본 클래스를 채움 |
| 검증(Validating) | 고치지 않고 허용이나 거부만 함 | `NamespaceLifecycle`이 없는 네임스페이스로 오는 요청을 거부 |

강의에 자주 나오는 내장 플러그인을 공식 문서 설명으로 정리했습니다.

| 플러그인 | 종류 | 동작 |
|---|---|---|
| `NamespaceLifecycle` | 검증 | 없는 네임스페이스나 삭제 중인 네임스페이스에 객체 생성을 거부. `default`, `kube-system`, `kube-public` 삭제를 막음 |
| `DefaultStorageClass` | 변형 | 클래스를 지정하지 않은 PVC에 기본 StorageClass를 넣음 |
| `AlwaysPullImages` | 변형과 검증 | 모든 새 Pod의 `imagePullPolicy`를 `Always`로 바꿈. 노드에 캐시된 사설 이미지를 자격 증명 없는 다른 사용자가 쓰는 것을 막음. 기본 꺼짐 |
| `EventRateLimit` | 검증 | API 서버로 몰리는 Event 요청 수를 제한. alpha이고 기본 꺼짐, 별도 설정 파일 필요 |

#### 4. 켜고 끄는 법

1. **매니페스트 열기**: kubeadm 클러스터라면 `/etc/kubernetes/manifests/kube-apiserver.yaml`의 `command`를 고칩니다.
2. **플래그 더하기와 빼기**: `--enable-admission-plugins=NodeRestriction,AlwaysPullImages`처럼 더하거나 `--disable-admission-plugins=DefaultStorageClass`로 뺍니다.
3. **저장하면 적용**: 파일을 저장하면 kubelet이 API 서버 static Pod를 다시 만들고 새 설정이 적용됩니다.

기본으로 켜지는 목록은 `kubectl -n kube-system exec kube-apiserver-<노드> -- kube-apiserver -h | grep enable-admission-plugins`로 볼 수 있습니다.

#### 5. 바깥에 판단을 맡기는 웹훅

1. **웹훅 서버 띄우기**: 운영자가 판단 코드를 담은 HTTPS 서버를 Deployment와 Service로 띄웁니다.
2. **등록**: `ValidatingWebhookConfiguration`(또는 `MutatingWebhookConfiguration`)으로 "Pod CREATE 요청이 오면 이 Service의 이 경로에 물어보라"고 등록합니다. `caBundle`은 API 서버가 웹훅 서버의 인증서를 검증할 CA입니다.
3. **질의와 응답**: 요청이 오면 API 서버가 객체를 AdmissionReview JSON에 담아 웹훅에 보내고 `allowed`(변형이면 patch까지)를 받아 처리합니다.

```text
kubectl → API 서버 ──AdmissionReview──▶ 웹훅 Service(shop/image-policy) → 웹훅 Pod
                  ◀──allowed: true/false──
```

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingWebhookConfiguration
metadata:
  name: shop-image-policy
webhooks:
- name: image-policy.shop.example.com
  clientConfig:
    service: {namespace: shop, name: image-policy, path: /validate}
    caBundle: <CA 인증서 base64>
  rules:
  - operations: ["CREATE"]
    apiGroups: [""]
    apiVersions: ["v1"]
    resources: ["pods"]
  admissionReviewVersions: ["v1"]
  sideEffects: None
  failurePolicy: Fail      # 웹훅이 응답하지 않으면 요청도 거부
```

웹훅 서버 없이 정책을 거는 방법도 있습니다. **ValidatingAdmissionPolicy**(v1.30 GA)는 CEL 식으로 조건을 적고 API 서버 안에서 바로 평가합니다. 아래 표의 VAP 422 응답이 이 경로입니다. 예시는 [6편](/blog/cert/cka/cka-03-workloads-scheduling)에 있습니다.

#### 6. 실전에서 보이는 모습

- 쿼터, LimitRange, PodSecurity에 걸리면 `403 Forbidden`과 `exceeded quota`, `violates PodSecurity` 같은 메시지가 돌아옵니다.
- 웹훅 서버가 내려가 있는데 `failurePolicy: Fail`이면 `500 Internal Server Error`와 `failed calling webhook`이 보이고 그 규칙에 걸리는 요청이 모두 막힙니다.
- Deployment는 만들어졌는데 Pod가 없으면 어드미션 거부가 ReplicaSet 쪽에서 일어난 경우입니다. `kubectl describe rs`의 Events를 봅니다.

> **정리**: 누구인지는 인증이, 해도 되는 동작인지는 인가가 보고 RBAC로 표현할 수 없는 내용 조건은 어드미션이 맡습니다. 어드미션은 쓰기 요청에만 변형 다음 검증 순서로 돕니다. 단계별 실패 응답 코드는 바로 아래 표에 있습니다.

</details>

| 단계 | 하는 일 | 실패할 때(kind v1.37에서 `kubectl -v=6`으로 확인) | 시험에서 만나는 예 |
|---|---|---|---|
| 인증 | 클라이언트 인증서, 베어러 토큰(ServiceAccount 토큰 포함) 등으로 사용자 확인 | `401 Unauthorized`. kubectl은 `error: You must be logged in to the server (Unauthorized)` | kubeconfig의 인증서 경로 오류, 만료된 인증서, 잘못된 토큰 |
| 인가 | kubeadm이 켜는 `Node,RBAC` 모드(플래그 자체의 기본값은 `AlwaysAllow`)로 이 사용자가 이 동작을 해도 되는지 판단 | `403 Forbidden`. `pods is forbidden: User "..." cannot list resource "pods" ...` | `kubectl auth can-i`로 확인하는 RBAC 문제 |
| 변형 어드미션 | 요청 객체를 고침 | `403 Forbidden`. 없는 PriorityClass는 `no PriorityClass with name nope was found` | `DefaultTolerationSeconds`가 300초 톨러레이션 추가, `LimitRanger`가 기본 requests 주입 |
| 스키마 검증 | 객체가 API 스키마에 맞는지 확인 | 잘못된 값은 `422 Unprocessable Entity`(`is invalid: spec.replicas: Invalid value: -1`). 오타 난 필드는 kubectl 기본 `fieldValidation=Strict` 때문에 `400 Bad Request`(`strict decoding error: unknown field`) | 음수 replicas, selector와 템플릿 라벨 불일치(422), 필드 이름 오타(400) |
| 검증 어드미션 | 정책 위반이면 거부만 함 | ResourceQuota, LimitRange, PodSecurity는 `403 Forbidden`. ValidatingAdmissionPolicy는 `422`(메시지는 `is forbidden: ValidatingAdmissionPolicy ... denied request`). 웹훅 서버가 없는데 `failurePolicy: Fail`이면 `500 Internal Server Error`(`failed calling webhook`) | `exceeded quota`, `violates PodSecurity "restricted:latest"`, `maximum cpu usage per Container is 200m` |

Admission Control 문서 기준으로 변형 어드미션, 스키마 검증, 검증 어드미션 순서로 돌고 어드미션은 쓰기 요청에만 적용됩니다.

헷갈리기 쉬운 곳이 하나 있습니다. CPU, 메모리, Pod 수 쿼터에 걸리는 Deployment도 `kubectl create`는 성공합니다. 이 쿼터는 Pod가 만들어질 때 계산되므로 거부는 ReplicaSet 컨트롤러가 Pod를 만들려 할 때 일어나고 기록은 `kubectl describe rs`의 Events에 남습니다.

### 1-3. 스케줄러가 노드를 고르는 방식

스케줄러는 `spec.nodeName`이 비어 있는 Pod를 watch해서 하나씩 노드를 정합니다. 순서는 셋입니다.

1. **Filter**: 받을 수 없는 노드를 지웁니다.
   - 남은 CPU와 메모리가 requests보다 작은 노드
   - 견디지 못하는 테인트가 있는 노드
   - nodeSelector나 어피니티에 맞지 않는 노드
2. **Score**: 남은 노드 중 점수가 가장 높은 노드를 고릅니다.
3. **binding**: 결과를 `pods/<이름>/binding` 서브리소스로 보내고 API 서버가 `spec.nodeName`을 채웁니다.

남는 노드가 없으면 Pod는 `Pending`에 머물고 `describe pod`의 Events에 `FailedScheduling`과 이유가 남습니다.

<details>
<summary>기초부터: Filter와 Score를 노드 네 대로 따라가기</summary>

> **핵심 한 줄**: 스케줄러는 "지금 실제로 얼마나 쓰는지"를 보지 않고 **노드에 이미 배정된 Pod들의 requests 합계**를 보고 판단합니다.

#### 1. 예시 상황

주문 API Pod가 `resources.requests.cpu: 500m`을 요청하고 톨러레이션은 없습니다. 워커 노드는 넷이고 모두 할당 가능한 CPU(allocatable)가 2코어입니다.

| 노드 | 이미 배정된 Pod들의 CPU requests 합 | 테인트 | 남은 CPU(2 - 합) |
|---|---|---|---|
| node1 | 1800m | 없음 | 200m |
| node2 | 400m | `dedicated=batch:NoSchedule` | 1600m |
| node3 | 500m | 없음 | 1500m |
| node4 | 1200m | 없음 | 800m |

#### 2. Filter: 받을 수 없는 노드 지우기

| 노드 | 걸리는 검사 | 결과 |
|---|---|---|
| node1 | 남은 200m < 요청 500m (NodeResourcesFit) | 탈락 |
| node2 | 견디지 못하는 테인트 (TaintToleration) | 탈락 |
| node3 | 통과 | 후보 |
| node4 | 통과 | 후보 |

여기서 후보가 하나도 남지 않으면 Events에 `0/4 nodes are available:` 뒤로 노드마다 걸린 이유가 개수와 함께 붙습니다. `1 Insufficient cpu`, `1 node(s) had untolerated taint ...` 같은 조각입니다. 이 문장을 읽으면 어느 검사에서 몇 대가 떨어졌는지 바로 압니다.

#### 3. Score: 남은 후보에 점수 매기기

kube-scheduler 설정 레퍼런스 기준으로 NodeResourcesFit의 기본 점수 전략은 `LeastAllocated`(CPU와 메모리 가중치 같음)입니다. 이 Pod를 올린 뒤에 덜 차 있는 노드일수록 점수가 높습니다.

| 노드 | 올린 뒤 requests 합 | 올린 뒤 사용률 | 남는 비율(점수 감각) |
|---|---|---|---|
| node3 | 1000m | 50% | 50 |
| node4 | 1700m | 85% | 15 |

CPU만 놓고 보면 node3이 이깁니다. 실제 점수는 BalancedAllocation, ImageLocality, PodTopologySpread 같은 다른 플러그인 점수도 가중치를 곱해 더한 값이라 이 표는 감을 잡기 위한 단순화입니다. 점수가 같으면 그중 하나를 무작위로 고릅니다.

#### 4. 헷갈리는 점과 실전에서 보이는 모습

- `kubectl top node`로 보면 node1이 실제로는 CPU 10%만 쓰고 있어도 requests 합이 1800m이면 탈락합니다. 반대로 requests를 안 적은 Pod는 0으로 계산되어 이미 바쁜 노드에도 올라갈 수 있습니다. `kubectl describe node`의 `Allocated resources` 칸이 스케줄러가 보는 숫자입니다.
- 노드를 한 대 고른 뒤 실제 배정은 binding이라는 별도 요청으로 합니다. 그래서 `PodScheduled` condition이 True가 된 뒤에도 kubelet이 아직 일을 시작하지 않은 짧은 구간이 있습니다.

> **정리**: Filter는 "올릴 수 있나"를, Score는 "올릴 수 있는 곳 중 어디가 나은가"를 묻습니다. Pending의 이유는 거의 언제나 Filter 쪽 문장에 적혀 있습니다.

</details>

### 1-4. kubelet이 컨테이너를 띄우고 상태를 보고하는 방식

kubelet은 `spec.nodeName=<자기 노드 이름>` 필드 셀렉터로 자기 노드의 Pod만 골라 watch합니다. 자기 노드에 배정된 Pod가 생기면 CRI로 containerd 같은 런타임을 호출하고 이 순서로 진행합니다.

1. Pod 샌드박스를 만듭니다. 네트워크 네임스페이스를 잡는 pause 컨테이너입니다.
2. CNI로 IP를 받습니다.
3. 이미지를 받고 컨테이너를 시작합니다.
4. 결과를 `pods/<이름>/status` 서브리소스로 API 서버에 올립니다. `kubectl get pod -o wide`의 IP와 NODE 열은 이렇게 채워집니다.

`crictl pods`에 Pod 샌드박스가 따로 보이는 이유가 이 pause 컨테이너입니다. 커널 쪽 동작은 [네임스페이스와 pause 글](/blog/theory/systems/k8s-linux-02-namespaces-pause)에서 다룹니다(시험 범위 밖 심화).

### 1-5. watch

<details>
<summary>기초부터: kubectl이 기다리지 않는 이유와 watch의 동작</summary>

> **핵심 한 줄**: API 서버는 "기록을 받아 저장했다"까지만 책임지고 실행할 구성요소들은 **watch**로 바뀐 내용을 받아 가서 각자 일을 시작합니다.

#### 1. 왜 필요한가

`kubectl run`이 Pod가 뜰 때까지 기다리지 않고 바로 `created`를 찍고 끝나는 것이 처음에는 이상해 보입니다. 노드 배정과 컨테이너 실행은 몇 초에서 몇 분이 걸릴 수 있고 실패할 수도 있어서 저장과 실행을 떼어 놓았습니다.

| 방식 | 하는 일 | 문제 |
|---|---|---|
| 요청 붙잡고 기다리기 | 실행이 끝날 때까지 kubectl 연결 유지 | 연결이 쌓이고 중간에 끊기면 결과도 잃음 |
| 폴링 | 스케줄러가 1초마다 "새 Pod 있어?"라고 목록 전체를 다시 받음 | 클러스터가 커질수록 같은 데이터를 계속 보내 API 서버 부하 증가 |
| watch | 연결 하나를 열어 두고 바뀐 것만 받음 | 위 두 문제를 피함 |

#### 2. 어떻게 동작하나

1. **처음 목록 받기(list)**: 클라이언트가 목록을 한 번 받습니다. 응답에는 그 시점을 가리키는 `resourceVersion` 번호가 붙습니다.
2. **watch 열기**: 그 번호를 붙여 `?watch=true`로 다시 요청합니다. API 서버는 연결을 끊지 않고 열어 둡니다.
3. **이벤트 받기**: 이후 오브젝트가 바뀔 때마다 `ADDED`, `MODIFIED`, `DELETED` 이벤트와 바뀐 객체가 그 연결로 흘러옵니다.
4. **다시 붙기**: 연결이 끊기면 마지막으로 받은 `resourceVersion`부터 다시 watch합니다. 너무 오래된 번호라 이어 갈 수 없으면 목록을 새로 받습니다.

```text
list ──▶ [Pod 목록, resourceVersion=1200]
watch?resourceVersion=1200 ──▶ (연결 유지)
   ◀── ADDED    order-api
   ◀── MODIFIED order-api (nodeName 채워짐)
   ◀── MODIFIED order-api (status Running)
연결 끊김 → watch?resourceVersion=<마지막 번호>로 재개
```

kubelet은 여기에 필드 셀렉터 `spec.nodeName=<자기 노드>`를 붙여 자기 노드 Pod만 받습니다. 노드가 수천 대여도 각 kubelet은 자기 몫만 받으니 전송량이 줄어듭니다.

#### 3. 한눈에 비교: API 서버가 직접 호출하는 push 방식과 watch

API 서버가 Pod를 저장할 때마다 담당 kubelet을 찾아가 "이 컨테이너를 띄워라"라고 직접 호출한다고 해 봅니다.

| 구분 | push 방식 | watch 방식 |
|---|---|---|
| 확장성 | 노드가 수천 대면 API 서버가 그 호출을 모두 들고 결과를 기다려야 함 | 각 구성요소가 연결을 하나씩 열어 두고 자기 몫만 받아 감 |
| 회복력 | 호출 순간 노드가 끊겨 있으면 명령이 사라짐. 재전송 로직 필요 | 다시 붙은 kubelet이 목록을 새로 받아 원하는 상태에 맞춤. 재전송할 명령 자체가 없음 |
| 긴 작업 | 이미지 받기 같은 몇 분짜리 작업을 API 서버가 기다림 | 기다리지 않음. kubelet이 일을 마친 뒤 status로 올림 |

#### 4. 헷갈리는 점과 실전에서 보이는 모습

- kubectl이 받는 `created`는 "etcd에 기록됐다"는 접수 확인입니다. 실제 실행은 그 뒤에 비동기로 따라오므로 명령이 성공해도 Pod가 `Pending`에 남을 수 있습니다.
- 컨트롤러는 이벤트를 "다시 비교해 볼 때가 됐다"는 신호로만 씁니다. 판단은 늘 지금 상태와 원하는 상태의 비교로 하므로([3편 1-2절](/blog/cert/cka/cka-01-why-kubernetes)) 이벤트 한두 개를 놓쳐도 다음 비교에서 바로잡힙니다.
- API 서버가 보관하지 않은 오래된 `resourceVersion`으로 watch를 요청하면 `410 Gone`이 돌아옵니다. 공식 문서([API Concepts](https://kubernetes.io/docs/reference/using-api/api-concepts/#efficient-detection-of-changes)) 기준으로 이때 클라이언트는 로컬 캐시를 비우고 list를 다시 한 뒤 돌아온 `resourceVersion`부터 watch를 시작해야 합니다.
- `kubectl get pods -w`를 띄워 두고 다른 터미널에서 Pod를 만들면 이 이벤트 흐름을 사람 눈으로 볼 수 있습니다.

> **정리**: `created`는 접수 확인일 뿐이라 명령이 성공해도 Pod가 `Pending`에 남을 수 있습니다. 이벤트를 몇 개 놓쳐도 컨트롤러는 다음 비교에서 바로잡습니다. 다음 절의 컨트롤러와 스케줄러, kubelet이 모두 이 구조 위에서 움직입니다.

</details>

스케줄러와 kubelet이 Pod 생성을 알아채는 장치가 watch입니다. 클라이언트가 `?watch=true`로 요청하면 API 서버가 연결을 열어 두고 ADDED, MODIFIED, DELETED 이벤트를 흘려보냅니다. `kubectl get -w`도 같은 watch입니다. 재연결과 `resourceVersion` 처리 같은 클라이언트 쪽 세부는 시험 범위 밖입니다.

### 1-6. Deployment가 Pod 세 개가 되는 경로

컨트롤러는 원하는 상태(spec)와 현재 상태(status)를 비교해 차이를 줄이는 제어 루프입니다([3편 1-2절](/blog/cert/cka/cka-01-why-kubernetes)). `kubectl create deployment order-api --image=nginx:1.27 --replicas=3 -n shop`의 경로는 이렇게 이어집니다.

```text
kubectl ──▶ API 서버: Deployment 저장
deployment 컨트롤러 (watch Deployment)
  └─ 맞는 ReplicaSet이 없음 → ReplicaSet order-api-<hash> 생성 (replicas: 3)
replicaset 컨트롤러 (watch ReplicaSet, Pod)
  └─ selector에 맞는 Pod 0개, 원하는 수 3 → Pod 3개 생성 (nodeName 빈 채)
kube-scheduler
  └─ Pod마다 Filter, Score, binding
kubelet (각 노드)
  └─ CRI 호출, status 보고
replicaset 컨트롤러
  └─ Pod 하나가 지워지면 다시 3과 비교 → 하나 더 생성
```

오브젝트 관계는 Deployment → ReplicaSet → Pod이고 아래쪽 오브젝트의 `metadata.ownerReferences`가 위쪽을 가리킵니다.

- Pod를 지우면 ReplicaSet이 다시 만듭니다.
- ReplicaSet을 지우면 Deployment가 다시 만듭니다.

그래서 개수를 바꾸거나 이미지를 바꾸려면 맨 위의 Deployment를 고칩니다.

```bash
kubectl get pod <Pod> -n shop -o jsonpath='{.metadata.ownerReferences[0].kind}/{.metadata.ownerReferences[0].name}{"\n"}'
# ReplicaSet/order-api-<hash>
```

### 1-7. 직접 해 보기

kind 클러스터에서 해 봅니다.

1. 한쪽 터미널에 `kubectl get pods -n shop -w -o wide`를 띄우고 다른 쪽에서 `kubectl run`을 실행합니다.
2. NODE 열이 `<none>`에서 노드 이름으로, STATUS가 `Pending`에서 `Running`으로 바뀌는 순서를 적습니다.
3. Deployment를 만들고 Pod 하나를 지운 뒤 새 Pod의 `ownerReferences`가 같은 ReplicaSet을 가리키는지 봅니다.

---

## 2. 컨트롤 플레인 구성요소의 역할

<details>
<summary>기초부터: 컨트롤 플레인 구성요소가 일을 나누는 방식</summary>

> **핵심 한 줄**: Pod 하나에 들어 있는 결정 여러 개를 구성요소마다 하나씩 맡기고 모두 API 서버를 watch하다가 자기 몫이 생기면 처리해 결과를 다시 API 서버에 적습니다.

#### 1. 왜 필요한가

Pod 하나를 띄우는 데에도 결정이 여러 개 들어 있습니다. 몇 개를 띄울지, 어느 노드에 둘지, 노드에서 누가 실제로 실행할지, Service로 온 트래픽을 어디로 보낼지입니다. 쿠버네티스는 이 결정을 한 프로그램에 몰지 않고 나눠 맡깁니다.

| 질문 | 맡는 구성요소 |
|---|---|
| 몇 개가 있어야 하고 지금 상태가 맞는가 | kube-controller-manager |
| 이 Pod를 어느 노드에 둘까 | kube-scheduler |
| 배정된 Pod를 실제로 실행하고 상태를 알림 | kubelet |
| Service 주소로 온 패킷을 어느 Pod로 보낼까 | kube-proxy가 깐 커널 규칙 |

#### 2. 어떻게 동작하나

```text
                  ┌──────── kube-apiserver ────────┐
watch/쓰기 ▲      ▲              ▲               ▲
controller-manager  scheduler     kubelet        kube-proxy
(개수 맞춤)        (nodeName 채움) (컨테이너 실행)  (커널 규칙 설치)
```

컨트롤러 매니저 안에는 노드, ReplicaSet, Deployment, EndpointSlice, ServiceAccount 컨트롤러처럼 맡은 오브젝트가 다른 컨트롤러가 수십 개 있습니다. 논리적으로는 각자 독립된 루프입니다. 하지만 프로세스를 따로따로 띄우면 배포와 관리가 번거로워 바이너리 하나, 프로세스 하나로 묶어 돌립니다.

EndpointSlice 컨트롤러 하나를 따라가 보면 컨트롤러가 일하는 모양이 보입니다.

1. **watch**: Service와 Pod를 watch합니다.
2. **계산**: Service의 selector에 맞는 Pod를 찾아 IP, 포트, 준비 상태(ready)를 계산합니다.
3. **기록**: 결과를 EndpointSlice 오브젝트로 API 서버에 기록합니다. Pod가 새로 뜨거나 Ready 상태가 바뀌면 다시 계산해 고칩니다.

#### 3. 한눈에 비교: 하는 일과 하지 않는 일

| 구성요소 | 하는 일 | 하지 않는 일 |
|---|---|---|
| kube-scheduler | 필터로 자원이 모자라거나 테인트를 견디지 못하는 노드를 거르고 점수로 가장 높은 노드를 골라 `spec.nodeName`을 채움 | Pod를 만들거나 실행하지 않음 |
| kube-controller-manager | 원하는 개수와 지금 개수를 비교해 오브젝트를 만들고 지움 | 노드를 고르지 않음 |
| kube-proxy | Service와 EndpointSlice를 watch해 노드 커널에 iptables나 nftables 규칙을 깖 | 트래픽을 직접 받지 않음. 실제 패킷 전달은 커널이 함 |

스케줄러 단계 구조와 프로파일은 [6편 5-11절](/blog/cert/cka/cka-03-workloads-scheduling)에 있습니다.

#### 4. 헷갈리는 점과 실전에서 보이는 모습

- 옛 강의의 "엔드포인트 컨트롤러"는 v1 Endpoints 오브젝트를 만들던 컨트롤러입니다. 지금 kube-proxy가 보는 기준은 EndpointSlice입니다(2-5절).
- kube-proxy는 이름에 proxy가 들어 있어도 규칙만 관리합니다. 그래서 kube-proxy 프로세스가 잠깐 멈춰도 이미 깔린 규칙으로 기존 Service 통신은 이어지고 새 변경만 반영되지 않습니다.
- kube-proxy는 모든 노드에 하나씩 있어야 하므로 kubeadm은 kube-proxy를 DaemonSet으로 띄웁니다.
- 일을 나눠 맡은 결과 고장 위치가 증상으로 드러납니다. 스케줄러가 멈추면 새 Pod는 `spec.nodeName`이 빈 채 `Pending`에 남고 컨트롤러 매니저가 멈추면 Deployment를 만들어도 ReplicaSet과 Pod가 생기지 않습니다.

#### 5. 강의에 나오는 컨트롤러와 점수 단계를 지금 동작으로 다시 읽기

강의는 컨트롤러 셋과 스케줄러 점수를 짧게 소개합니다. 지금 버전의 이름과 실제 동작을 옆에 붙였습니다.

| 대상 | 강의식 설명 | 실제 동작 |
|---|---|---|
| 노드 컨트롤러 | 죽은 노드의 Pod를 다른 노드로 옮김 | node-lifecycle 컨트롤러가 노드를 NotReady로 표시하고 테인트를 붙입니다. 테인트를 견디지 못하는 Pod는 지워지고 replicaset 컨트롤러가 모자란 개수만큼 새 Pod를 만들면 스케줄러가 살아 있는 노드에 둡니다. 원래 Pod가 옮겨 가는 일은 없고 이름과 IP가 다른 새 Pod가 생깁니다 |
| 레플리케이션 컨트롤러 | 개수가 모자라면 더 만듦 | 지금은 replicaset 컨트롤러가 같은 일을 합니다. 개수가 넘치면 지우기도 합니다 |
| 엔드포인트 컨트롤러 | Service와 Pod를 이어 줌 | endpointslice 컨트롤러가 아래 네 단계로 목록을 씁니다 |
| 스케줄러 점수 | 가장 알맞은 노드에 점수를 줌 | 점수 플러그인 여럿의 합입니다. `NodeResourcesFit`(남은 자원), `NodeResourcesBalancedAllocation`(CPU와 메모리 쓰임의 균형), `ImageLocality`(필요한 이미지가 이미 있는 노드에 가점)가 대표입니다 |

endpointslice 컨트롤러가 목록 하나를 고치는 과정입니다.

1. **감지**: Service가 생기거나 Pod의 IP, Ready 상태가 바뀐 이벤트를 watch로 받습니다.
2. **계산**: Service selector에 맞는 Pod의 IP와 포트 목록을 만듭니다.
3. **요청**: 그 목록을 EndpointSlice 오브젝트로 만들거나 고쳐 달라고 API 서버에 보냅니다.
4. **저장**: API 서버가 인증, 인가, 어드미션, 검증을 거친 뒤 etcd에 씁니다. 컨트롤러가 보낸 요청도 kubectl 요청과 같은 관문을 지납니다.

kube-proxy 이름에 proxy가 붙은 데에는 이력이 있습니다. 초기의 userspace 모드에서는 kube-proxy 프로세스가 연결을 직접 받아 Pod로 넘겼고 커널과 사용자 공간을 오가느라 느렸습니다. 그 뒤 커널 규칙만 깔아 두는 iptables 모드가 기본이 되었고 userspace 모드는 1.26에서 제거되었습니다([7편](/blog/cert/cka/cka-04-services-networking)).

> **정리**: 개수는 컨트롤러 매니저, 자리는 스케줄러, 실행은 kubelet, 트래픽 규칙은 kube-proxy 몫입니다. 새 Pod가 `spec.nodeName` 없이 `Pending`이면 스케줄러를, ReplicaSet조차 생기지 않으면 컨트롤러 매니저를 먼저 의심합니다. 이 구성요소들이 kubeadm에서 어떤 형태로 도는지는 다음 표에 있습니다.

</details>

### 2-1. 한눈에 보는 표

Kubernetes Components 문서와 각 구성요소의 명령줄 레퍼런스를 기준으로 했습니다. "kubeadm에서 도는 방식" 열은 kubeadm 클러스터 기준입니다.

| 구성요소 | 맡은 일 | kubeadm에서 도는 방식 | 기본 포트 |
|---|---|---|---|
| kube-apiserver | 모든 요청의 입구. 인증, 인가, 어드미션, 검증, watch 제공. etcd와 직접 통신하는 유일한 구성요소 | static Pod | 6443 |
| etcd | 클러스터 상태를 저장하는 키-값 저장소 | static Pod | 2379(클라이언트), 2380(피어) |
| kube-scheduler | `nodeName`이 빈 Pod에 노드를 정함 | static Pod | 10259 |
| kube-controller-manager | 여러 컨트롤러를 한 프로세스로 묶어 실행 | static Pod | 10257 |
| kubelet | 노드에서 Pod를 실제로 실행하고 상태 보고 | systemd 서비스 | 10250 |
| kube-proxy | Service용 iptables/nftables/IPVS 규칙 관리 | DaemonSet | 10256(헬스 체크). Service 트래픽은 직접 받지 않음 |

### 2-2. kube-apiserver

API 서버는 1장의 인증, 인가, 어드미션, 스키마 검증 외에도 API 버전 사이 변환과 ServiceAccount 토큰 발급을 맡습니다. 다른 구성요소는 모두 API 서버를 거쳐서만 상태를 읽고 씁니다.

그래서 API 서버가 멈추면 `kubectl`이 전부 실패하고 스케줄링과 컨트롤러 동작도 같이 멈춥니다. 이미 떠 있는 Pod는 kubelet이 계속 돌립니다.

### 2-3. etcd

<details>
<summary>기초부터: etcd에는 무엇이 들어 있고 무엇이 없는지</summary>

> **핵심 한 줄**: **etcd**는 클러스터의 모든 오브젝트를 키 하나에 값 하나로 통째로 넣어 두는 키-값 데이터베이스이고 컨테이너 이미지, 로그, 볼륨 안 데이터는 담지 않습니다.

#### 1. 왜 알아야 하나

"etcd를 백업한다"가 무엇을 지키는 일인지 알아야 복구 뒤에 무엇이 돌아오고 무엇이 돌아오지 않는지 판단할 수 있습니다. etcd 키를 직접 볼 일은 거의 없지만 이 구조가 그 판단의 기준입니다.

#### 2. 어떻게 생겼나

1. **키-값 저장**: 관계형 데이터베이스처럼 테이블과 열로 쪼개지 않고 오브젝트 하나를 값 하나로 통째로 넣습니다.
2. **경로 모양 키**: 쿠버네티스는 오브젝트마다 경로 모양의 키를 씁니다.
3. **API 서버만 접속**: API 서버만 etcd에 접속하고 나머지 구성요소는 API 서버를 거칩니다.

```text
/registry/pods/shop/order-api           → order-api Pod 오브젝트 전체
/registry/deployments/shop/order-api    → Deployment 오브젝트 전체
/registry/services/specs/shop/order-api → Service 오브젝트

scheduler, kubelet, kubectl ──▶ kube-apiserver ──▶ etcd
```

#### 3. 한눈에 비교

| etcd에 있음 | etcd에 없음 |
|---|---|
| 모든 오브젝트의 spec과 status(Pod, Deployment, Service, ConfigMap, Secret, RBAC, CRD와 커스텀 객체) | 컨테이너 이미지(레지스트리와 노드 디스크) |
| 노드 등록 정보, Lease, Event | 컨테이너 로그(노드의 `/var/log/pods`) |
| | PV 안의 애플리케이션 데이터(스토리지 장치) |

#### 4. 헷갈리는 점과 실전에서 보이는 모습

- etcd 스냅샷을 되돌리면 "어떤 Pod와 설정이 있어야 하는지"는 돌아오지만 DB 볼륨 안의 주문 데이터는 돌아오지 않습니다.
- 클러스터의 모든 Secret이 들어 있으니 etcd 접속에는 전용 CA로 만든 인증서를 쓰고 스냅샷 파일도 Secret과 같은 수준으로 보관합니다.
- etcd는 여러 대를 묶어 같은 데이터를 나눠 갖는 분산 저장소입니다. 여러 대가 같은 순서로 쓰기를 맞추는 규칙이 Raft 합의이고 과반이 살아 있어야 쓰기가 됩니다.

> **정리**: etcd는 "무엇이 있어야 하는가"의 기록을 담고 실제 데이터와 이미지, 로그는 다른 곳에 있습니다. Raft 원리와 홀수 대수 이야기는 [5편 5-1절](/blog/cert/cka/cka-02-cluster-architecture)에서 이어집니다.

</details>

etcd는 Raft 합의를 쓰는 분산 키-값 저장소입니다. kubeadm 기본 구성(stacked)에서는 컨트롤 플레인 노드마다 static Pod로 돌고 데이터는 hostPath `/var/lib/etcd`에 있습니다. 외부 etcd를 쓰는 클러스터라면 `kube-apiserver.yaml`의 `--etcd-servers`를 보면 위치가 나옵니다. 백업과 복구는 [5편](/blog/cert/cka/cka-02-cluster-architecture)의 etcd 절에 정리했습니다.

### 2-4. kube-scheduler와 nodeName 직접 지정

스케줄러는 Filter로 Pod를 받을 수 없는 노드를 지우고 Score로 남은 노드 중 하나를 고른 뒤 바인딩을 별도 단계로 합니다. 플러그인 확장 포인트 세부는 시험 범위 밖입니다.

`spec.nodeName`을 직접 적은 Pod는 스케줄러를 건너뜁니다. 이미 노드가 정해져 있으니 해당 노드의 kubelet이 바로 받습니다. 스케줄러가 죽었을 때 Pod를 특정 노드에 띄우는 방법으로도 쓰입니다.

건너뛰는 건 스케줄러뿐입니다. API 서버의 인증, 인가, 어드미션은 그대로 거칩니다.

Assigning Pods to Nodes 문서가 적은 차이가 하나 더 있습니다. 스케줄러의 Filter를 거치지 않았으니 노드에 자원이 모자라면 kubelet이 Pod를 거부합니다. 이때 Pod는 `OutOfcpu` 같은 reason과 함께 곧바로 `Failed`가 됩니다.

### 2-5. kube-controller-manager

컨트롤러 매니저 바이너리 하나에 컨트롤러 수십 개가 들어 있습니다. 이 글의 흐름과 맞닿는 것만 고르면 이렇습니다.

| 컨트롤러 | 하는 일 |
|---|---|
| deployment-controller | Deployment에 맞는 ReplicaSet을 만들고 롤아웃 진행 |
| replicaset-controller | ReplicaSet의 Pod 수를 replicas에 맞춤 |
| endpointslice-controller | Service selector에 맞는 Pod로 EndpointSlice를 만듦. kube-proxy가 이것을 봄 |
| node-lifecycle-controller | 노드 하트비트가 끊기면 NotReady/Unknown 표시와 `unreachable`, `not-ready` NoExecute 테인트 부착 |
| taint-eviction-controller | NoExecute 테인트를 견디지 못하는 Pod를 삭제(1.29 beta부터 기본 분리, 1.34 GA) |

옛 v1 Endpoints API는 v1.33부터 deprecated라 조회하면 `v1 Endpoints is deprecated in v1.33+; use discovery.k8s.io/v1 EndpointSlice` 경고가 붙습니다. Service 디버깅은 `kubectl get endpointslices -l kubernetes.io/service-name=<svc>`로 익혀 둡니다.

노드가 죽은 뒤 약 50초 + 300초에 Pod가 옮겨지는 과정은 [3편 3-4절](/blog/cert/cka/cka-01-why-kubernetes)에 있습니다.

`--leader-elect`(기본 true) 때문에 컨트롤 플레인이 여러 대여도 일은 리더 하나만 합니다. 리더는 `kube-system`의 Lease 객체로 정하고 스케줄러도 같은 방식입니다. `kubectl -n kube-system get lease`의 HOLDER로 지금 리더가 어느 노드인지 봅니다.

### 2-6. kubelet

<details>
<summary>기초부터: kubelet이 노드에서 맡는 일과 직접 설치되는 이유</summary>

> **핵심 한 줄**: **kubelet**은 노드마다 하나씩 있는 실행 담당이고 컨테이너 런타임과 static Pod를 다뤄야 하므로 컨테이너 바깥의 호스트에 직접 설치됩니다.

#### 1. 왜 필요한가

스케줄러는 `spec.nodeName`을 채우는 데서 일을 마칩니다. 그 노드에서 이미지를 받고 컨테이너를 띄우고 살아 있는지 살필 누군가가 노드마다 있어야 하는데, 그게 kubelet입니다.

#### 2. 어떻게 동작하나

1. **노드 등록**: 시작하면 자기 노드를 Node 오브젝트로 API 서버에 등록합니다. 등록된 노드여야 스케줄러 후보에 오릅니다.
2. **Pod 실행**: 자기 노드에 배정된 Pod의 spec을 읽고 CRI로 containerd 같은 런타임에 컨테이너 생성과 중지를 요청합니다.
3. **상태 확인과 보고**: liveness, readiness, startup 프로브를 kubelet이 직접 돌립니다. liveness가 실패하면 컨테이너를 다시 시작하고 readiness 결과는 Pod의 `Ready` 조건으로 API 서버에 올립니다. Service는 이 조건이 참인 Pod로만 트래픽을 보냅니다.

```text
API 서버 ──watch(내 노드 Pod)──▶ kubelet ──CRI──▶ containerd ──▶ 컨테이너
         ◀──status(phase, Ready, podIP)──
```

#### 3. 직접 설치되는 이유(닭과 달걀)

| 구성요소 | kubeadm에서 도는 방식 | 띄우는 주체 |
|---|---|---|
| kube-apiserver, etcd, 스케줄러, 컨트롤러 매니저 | static Pod | kubelet이 `/etc/kubernetes/manifests`의 파일을 보고 띄움 |
| kube-proxy, CoreDNS | DaemonSet, Deployment | 컨트롤러가 API 서버를 거쳐 만듦 |
| kubelet | systemd 서비스 | 운영체제 |

API 서버도 Pod인데 Pod는 API 서버를 거쳐야 만들어진다면 처음 API 서버는 누가 띄우느냐는 문제가 생깁니다. kubelet은 API 서버 없이도 매니페스트 디렉터리만 보고 static Pod를 띄울 수 있습니다. 그래서 부팅 때 kubelet이 먼저 서고 컨트롤 플레인 Pod를 띄웁니다. 이 순서 때문에 kubeadm 클러스터의 쿠버네티스 구성요소 가운데 kubelet만 컨테이너 밖에서 systemd 서비스로 돕니다. static Pod 만드는 법은 [6편](/blog/cert/cka/cka-03-workloads-scheduling)의 static Pod 절에 있습니다.

#### 4. 헷갈리는 점과 실전에서 보이는 모습

- `kubectl get pods -n kube-system`에 보이는 `kube-apiserver-<노드>`는 static Pod를 API 서버에 비춰 보여 주는 미러 Pod입니다. kubectl로 지워도 kubelet이 매니페스트를 기준으로 다시 올립니다.
- kubelet이 멈추면 그 노드는 하트비트가 끊겨 `NotReady`가 되고 새 Pod를 받지 못합니다. 이미 떠 있는 컨테이너는 런타임이 계속 돌립니다.

> **정리**: 컨트롤 플레인 static Pod를 띄우는 쪽이 kubelet이라 kubelet만 systemd 서비스로 돕니다. kubelet이 멈추면 노드는 `NotReady`가 되지만 떠 있던 컨테이너는 런타임이 계속 돌립니다. 설정 파일 위치는 바로 아래 본문에 있습니다.

</details>

kubelet이 맡는 일은 여섯 가지입니다.

- 노드 등록
- Pod 실행(CRI 호출)
- 프로브 실행
- 볼륨 마운트
- 노드 압박 시 축출
- 하트비트

하트비트는 Node 객체의 status 갱신과 `kube-node-lease` 네임스페이스의 노드별 Lease 갱신 두 갈래입니다.

kubeadm 클러스터에서 컨트롤 플레인은 static Pod이고 kube-proxy는 DaemonSet인데 kubelet은 systemd 서비스입니다. static Pod를 띄우는 주체가 kubelet이니 kubelet 자신은 그 바깥에 있어야 합니다.

설정 파일은 `/var/lib/kubelet/config.yaml`(여기서 `staticPodPath` 확인)이고 API 서버 접속용 kubeconfig는 `/etc/kubernetes/kubelet.conf`입니다. kubelet이 멈춘 노드의 복구 순서는 [9편](/blog/cert/cka/cka-06-troubleshooting)의 클러스터 구성요소 장에 있습니다.

### 2-7. kube-proxy

kube-proxy는 규칙 관리자입니다. EndpointSlice와 Service를 watch해서 노드 커널의 netfilter나 IPVS 규칙을 고치고 실제 패킷은 커널이 처리합니다. Virtual IPs 문서와 릴리스 글 기준 모드 현황은 이렇습니다.

| 모드 | 상태 |
|---|---|
| `iptables` | 리눅스 기본값. 문서는 앞으로 기본값이 바뀔 수 있으니 모드를 명시하라고 권함 |
| `nftables` | v1.33 GA |
| `ipvs` | v1.35 deprecated. v1.37 릴리스 글 기준 v1.40에서 기본 비활성, v1.43에서 제거 예정 |

kubeadm 클러스터에서는 `kube-system`에 DaemonSet과 ConfigMap `kube-proxy`가 있고 모드는 ConfigMap의 `mode` 값으로 확인합니다. ConfigMap을 고친 뒤에는 `kubectl -n kube-system rollout restart ds kube-proxy`로 다시 띄웁니다.

Cilium 같은 CNI의 kube-proxy 대체 기능을 쓰면 kube-proxy가 아예 없는 클러스터도 있습니다. 규칙 해석은 시험 범위 밖이고 [Service와 iptables, conntrack 글](/blog/theory/systems/k8s-linux-05-service-iptables-conntrack)에서 다룹니다.

### 2-8. 직접 해 보기

컨트롤 플레인 노드에서 차례로 확인합니다.

1. `sudo ls /etc/kubernetes/manifests`로 static Pod 네 개를 확인합니다.
2. `kube-controller-manager.yaml`에서 `--leader-elect` 값을 찾습니다.
3. `kubectl -n kube-system get lease`로 리더를 적습니다.
4. `kubectl -n kube-system get cm kube-proxy -o yaml | grep mode`로 kube-proxy 모드를 적습니다.

구성요소 상태는 deprecated된 `componentstatuses` 대신 `kubectl get --raw='/readyz?verbose'`로 봅니다.

---

## 3. 구성요소 사이의 인증서 방향

<details>
<summary>기초부터: TLS와 인증서, CA를 처음부터</summary>

> **핵심 한 줄**: **TLS**는 네트워크에서 엿보기와 사칭을 막는 규약이고 인증서와 **CA**는 "이 공개 키가 정말 그 서버 것인지"를 보증합니다.

#### 1. 왜 필요한가

API 서버 주소로 오가는 요청에는 Secret 값과 토큰이 실립니다.

| 위협 | 평문일 때 생기는 일 | TLS가 막는 방법 |
|---|---|---|
| 엿보기 | 같은 네트워크의 누구든 패킷을 떠서 읽음 | 데이터를 암호화 |
| 사칭 | 가짜 서버가 끼어들어 요청을 받아 챔 | 인증서로 서버 신원을 확인 |

#### 2. 어떻게 동작하나

1. **대칭 키 암호**: 같은 키 하나로 잠그고 엽니다. 빠르지만 그 키를 상대에게 어떻게 건넬지가 문제입니다. 네트워크로 보내다 가로채이면 끝입니다.
2. **비대칭 키 암호**: 공개 키와 개인 키 한 쌍을 씁니다. 공개 키로 잠근 것은 짝인 개인 키로만 열리고 개인 키로 서명한 것은 공개 키로 누구나 검증할 수 있습니다. 공개 키는 마음껏 나눠 줘도 되고 개인 키만 지키면 됩니다. 대신 계산이 무겁습니다.
3. **둘을 섞은 TLS**: 연결을 시작할 때 비대칭 키 연산으로 서버가 개인 키를 가진 진짜 주인임을 증명하고 이번 연결에서만 쓸 대칭 키를 양쪽이 안전하게 나눠 갖습니다. 그 뒤 실제 데이터는 빠른 대칭 키로 암호화합니다.

```text
[연결 시작] 비대칭 키: 서버 신원 확인 + 대칭 키 합의
[그 뒤]     대칭 키: 실제 데이터 암호화
```

옛 방식은 클라이언트가 만든 대칭 키를 서버 공개 키로 잠가 보냈고 지금 쓰는 TLS 1.3은 양쪽이 임시 키를 교환해 같은 대칭 키를 계산합니다. 어느 쪽이든 "비대칭은 신원 확인과 키 합의에, 대칭은 데이터에"라는 역할 분담은 같습니다.

#### 3. 인증서와 CA

가짜 서버도 자기 키 쌍을 만들어 공개 키를 내밀 수 있습니다. 그래서 공개 키에 보증이 붙어야 합니다.

| 용어 | 뜻 |
|---|---|
| 인증서(`.crt`) | 공개 키에 "이 키의 주인은 kube-apiserver이고 이 이름과 IP로 접속하면 된다(SAN), 유효 기간은 언제까지"를 붙이고 CA가 서명한 문서 |
| CA(인증 기관) | 서명해 주는 쪽. 클라이언트가 CA 인증서(`ca.crt`)를 미리 갖고 있으면 서버가 내민 인증서의 서명을 검증해 위조 여부를 판단 |
| 상호 TLS(mTLS) | 클라이언트도 인증서를 내서 서로를 확인. 웹사이트는 보통 서버만 내고 쿠버네티스 구성요소끼리는 양쪽이 냄 |

브라우저는 공인 CA 목록을 내장하고 있고 쿠버네티스 클러스터는 kubeadm이 만든 자체 CA를 씁니다.

API 서버는 클라이언트 인증서의 CN을 사용자 이름, O를 그룹으로 읽어 RBAC에 넘깁니다.

| 파일 | 내용 | 다루는 법 |
|---|---|---|
| `.crt`, `.pem` | 인증서(공개 키 포함) | 노출돼도 괜찮음 |
| `.key`, `-key.pem` | 개인 키 | 그 자리를 떠나면 안 됨 |

`.pem`은 인코딩 형식 이름이라 인증서와 키 어느 쪽이든 담을 수 있으니 내용을 열어 `BEGIN CERTIFICATE`인지 `BEGIN PRIVATE KEY`인지 봅니다.

#### 4. 인증서를 새로 받는 순서

1. **키 만들기**: 개인 키는 내 자리에서 만들고 밖으로 보내지 않습니다.
2. **CSR 보내기**: 공개 키와 원하는 이름을 담은 서명 요청서(CSR)만 CA에 보냅니다.
3. **인증서 받기**: CA가 서명한 인증서를 돌려받습니다.

```text
내 자리: 개인 키 생성 → CSR(공개 키 + 이름) ──▶ CA 서명 ──▶ 인증서 돌려받음
         (개인 키는 한 번도 네트워크를 타지 않음)
```

[5편 1-9절](/blog/cert/cka/cka-02-cluster-architecture)의 CSR 승인 흐름이 이 순서를 쿠버네티스 API로 옮긴 것입니다.

#### 5. 실전에서 보이는 모습

kubeadm 트러블슈팅 문서([Troubleshooting kubeadm](https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/troubleshooting-kubeadm/))에 나오는 메시지입니다.

- `x509: certificate signed by unknown authority`: kubectl이 가진 CA로 서버 인증서를 검증하지 못했습니다. kubeconfig의 인증서가 클러스터와 맞는지부터 확인합니다.
- `x509: certificate has expired or is not yet valid`: 인증서 유효 기간 밖입니다. 문서에서는 kubelet 클라이언트 인증서 회전이 실패한 사례로 나옵니다.

> **정리**: TLS는 비대칭 키로 신원을 확인하고 대칭 키로 데이터를 지킵니다. 인증서는 CA가 서명한 공개 키 신분증이고 개인 키는 만든 자리를 떠나지 않습니다. 다음 절에서 이 인증서가 클러스터 안 어느 연결에 쓰이는지 나눠 봅니다.

</details>

인증서 문제를 풀 때는 "이 연결에서 누가 클라이언트이고 누가 서버인지"부터 정합니다. 방향이 정해지면 어떤 플래그를 볼지가 따라 나옵니다.

### 3-1. API 서버는 양쪽 역할을 다 한다

<details>
<summary>기초부터: 서버 인증서, 클라이언트 인증서, CA 인증서로 나눠 보기</summary>

> **핵심 한 줄**: 연결마다 "전화를 받는 쪽"과 "거는 쪽"을 정하면 `/etc/kubernetes/pki`의 파일 스무 개가 서버, 클라이언트, CA 세 갈래로 정리됩니다.

#### 1. 왜 필요한가

`/etc/kubernetes/pki`를 처음 열면 파일이 스무 개가 넘어 막막합니다. 인증서 장애를 풀려면 어느 파일이 어느 연결의 어느 쪽에 쓰이는지 먼저 알아야 합니다.

#### 2. 세 갈래로 나누기

| 종류 | 증명하는 것 | 가진 쪽 |
|---|---|---|
| **서버 인증서** | 연결을 받는 쪽이 "내가 진짜 그 서버" | kube-apiserver(`apiserver.crt`), etcd(`etcd/server.crt`), kubelet(10250 포트용 서빙 인증서) |
| **클라이언트 인증서** | 연결을 거는 쪽이 "내가 권한 있는 그 사용자" | 관리자 kubectl, kube-scheduler, kube-controller-manager, kubelet, kube-proxy가 API 서버에 걸 때 |
| **CA 인증서** | 위 두 종류에 서명한 쪽. 상대 인증서를 검증할 때 씀 | 검증하는 쪽 모두 |

kubeadm은 관리자, 스케줄러, 컨트롤러 매니저의 클라이언트 인증서를 별도 `.crt` 파일로 두지 않고 `/etc/kubernetes/*.conf` kubeconfig 안의 `client-certificate-data`에 넣습니다.

#### 3. API 서버의 두 얼굴

1. **서버일 때**: kubectl과 kubelet의 요청을 받습니다. `apiserver.crt`를 씁니다.
2. **etcd의 클라이언트일 때**: 데이터를 쓰러 etcd에 붙습니다. `apiserver-etcd-client.crt`를 씁니다.
3. **kubelet의 클라이언트일 때**: `kubectl logs` 때문에 kubelet에 붙습니다. `apiserver-kubelet-client.crt`를 씁니다.

```text
kubectl, kubelet ──(apiserver.crt로 맞이함)──▶ kube-apiserver
kube-apiserver ──(apiserver-etcd-client.crt)──▶ etcd:2379
kube-apiserver ──(apiserver-kubelet-client.crt)──▶ kubelet:10250
```

#### 4. CA가 셋인 이유

| CA | 파일 | 서명 대상 |
|---|---|---|
| 클러스터 CA | `ca` | API 서버, kubelet, 사용자 등 클러스터 인증서 |
| etcd 전용 CA | `etcd/ca` | etcd 서버와 etcd에 붙는 클라이언트 |
| front-proxy CA | `front-proxy-ca` | API 집계용 |

etcd가 클러스터 CA를 믿는다면 클러스터 CA로 서명받은 사용자 인증서 아무것으로나 etcd에 직접 붙어 볼 수 있습니다. etcd는 전용 CA가 서명한 인증서만 받게 해서 모든 데이터를 쥔 저장소에 붙을 수 있는 주체를 API 서버와 etcd 자신으로 좁힙니다.

#### 5. 실전에서 보이는 모습

- 아래 표의 `--etcd-cafile`이 클러스터 CA로 바뀌면 API 서버가 etcd에 못 붙는 장애가 이 분리에서 생깁니다.
- `kubectl logs`나 `kubectl exec`만 실패하면 API 서버가 kubelet의 클라이언트로 붙는 구간을 의심합니다.

#### 6. 노드 하나가 뚫렸을 때 피해가 멈추는 곳

연결마다 인증서를 따로 두는 이유는 열쇠 하나가 새어 나가도 열리는 문을 줄이기 위해서입니다. etcd에 붙는 열쇠와 노드에 명령하는 열쇠를 나눠 두면 한쪽이 털려도 다른 쪽 권한은 그대로 남습니다.

| 새어 나간 열쇠 | 그 열쇠로 할 수 있는 일 | 막히는 일 |
|---|---|---|
| 워커 노드의 `kubelet.conf` 클라이언트 인증서 | `system:node:<노드>` 자격으로 API 서버에 붙음. kubeadm이 켜 두는 Node 인가(`--authorization-mode=Node,RBAC`)와 `NodeRestriction` 어드미션 때문에 자기 Node 객체, 자기 노드에 배정된 Pod, 그 Pod가 쓰는 Secret과 ConfigMap 정도로 범위가 좁음 | etcd 직접 접속(클러스터 CA가 서명한 인증서라 etcd 전용 CA 검증을 통과하지 못함), 다른 노드 객체 수정 |
| `apiserver-etcd-client` 인증서 | etcd의 모든 데이터를 읽고 씀 | 막히는 것이 거의 없음. 그래서 컨트롤 플레인 노드 밖으로 나가지 않게 둠 |

워커 노드에는 etcd에 붙을 수 있는 인증서가 아예 없으므로 노드 하나가 뚫려도 클러스터 전체 데이터까지 번지지 않습니다.

> **정리**: API 서버는 받는 쪽이자 거는 쪽이라 서버 인증서와 클라이언트 인증서를 둘 다 갖습니다. etcd는 전용 CA로 따로 보호되므로 워커 노드의 인증서가 새어 나가도 etcd까지는 닿지 못합니다.

</details>

kube-apiserver 레퍼런스와 PKI certificates and requirements 문서를 기준으로 kubeadm 기본 경로를 붙였습니다.

| API 서버의 역할 | 상대 | 플래그 | kubeadm 기본 파일 |
|---|---|---|---|
| 서버 | kubectl, 스케줄러, 컨트롤러 매니저, kubelet | `--tls-cert-file`, `--tls-private-key-file` | `/etc/kubernetes/pki/apiserver.crt`, `.key` |
| 서버(클라이언트 인증서 검증) | 위와 같음 | `--client-ca-file` | `/etc/kubernetes/pki/ca.crt` |
| 클라이언트 | etcd | `--etcd-certfile`, `--etcd-keyfile`, `--etcd-cafile` | `apiserver-etcd-client.crt`, `.key`, `etcd/ca.crt` |
| 클라이언트 | kubelet(로그, exec, port-forward) | `--kubelet-client-certificate`, `--kubelet-client-key` | `apiserver-kubelet-client.crt`, `.key` |

`--etcd-cafile`은 etcd 서버 인증서를 검증하는 CA라서 etcd 전용 CA(`/etc/kubernetes/pki/etcd/ca.crt`)를 가리켜야 합니다. 이 값이 클러스터 CA(`/etc/kubernetes/pki/ca.crt`)로 바뀌어 API 서버가 etcd에 붙지 못하는 것이 단골 장애 시나리오입니다.

`kubectl logs`나 `kubectl exec`가 실패할 때는 API 서버가 kubelet의 클라이언트로 붙는 구간을 의심합니다. 이 두 명령은 API 서버가 kubelet의 10250 포트에 다시 요청을 보내서 동작하기 때문입니다.

### 3-2. 스케줄러와 컨트롤러 매니저는 kubeconfig로 붙는다

<details>
<summary>기초부터: 연결을 거는 방향과 컨트롤러별 계정</summary>

> **핵심 한 줄**: 스케줄러와 컨트롤러 매니저는 API 서버로 연결을 거는 쪽이라 자기 신분증(kubeconfig)을 직접 들고 가고 API 서버 쪽에는 이들을 위한 설정이 필요 없습니다.

#### 1. 왜 필요한가

3-1절의 API 서버 매니페스트에는 etcd와 kubelet용 클라이언트 인증서 플래그가 있습니다. 같은 매니페스트에 `--scheduler-client-*` 같은 플래그는 없어서 처음 보면 빠진 것처럼 보입니다. 차이는 누가 연결을 거느냐에 있습니다.

#### 2. 방향으로 나눠 보기

| 연결 | 거는 쪽 | 인증서를 챙기는 쪽 | 설정 위치(kubeadm) |
|---|---|---|---|
| API 서버 → etcd | API 서버 | API 서버 | `kube-apiserver.yaml`의 `--etcd-*` |
| API 서버 → kubelet | API 서버 | API 서버 | `kube-apiserver.yaml`의 `--kubelet-client-*` |
| 스케줄러 → API 서버 | 스케줄러 | 스케줄러 | `scheduler.conf` |
| 컨트롤러 매니저 → API 서버 | 컨트롤러 매니저 | 컨트롤러 매니저 | `controller-manager.conf` |

받는 쪽인 API 서버는 `--client-ca-file` 하나로 들어오는 클라이언트 인증서를 모두 검증합니다. 그래서 클라이언트가 늘어도 API 서버 설정은 그대로입니다.

#### 3. 컨트롤러마다 권한을 나누는 장치

컨트롤러 매니저는 프로세스 하나지만 안의 컨트롤러가 각자 다른 계정으로 API 서버를 부를 수 있습니다. RBAC 문서의 Controller roles 절 기준입니다.

1. **플래그**: `--use-service-account-credentials`를 켜면 컨트롤러마다 `kube-system`의 전용 ServiceAccount(예: `replicaset-controller`)로 요청합니다. kubeadm은 이 값을 `true`로 넣습니다.
2. **역할**: 내장 컨트롤러마다 `system:controller:` 접두사가 붙은 ClusterRole이 있어 그 컨트롤러가 다루는 리소스만 허용합니다.
3. **끈 경우**: 모든 컨트롤러가 컨트롤러 매니저 자신의 자격으로 돌고 그 자격 하나에 필요한 권한을 전부 줘야 합니다.

```bash
grep use-service-account-credentials /etc/kubernetes/manifests/kube-controller-manager.yaml
kubectl get clusterrole | grep 'system:controller:'
```

> **정리**: 연결을 거는 쪽이 인증서를 챙기고 받는 쪽은 CA로 검증만 합니다. 컨트롤러 매니저 안에서도 컨트롤러별 계정으로 권한을 쪼개 한 컨트롤러의 실수가 번지는 범위를 줄입니다.

</details>

API 서버 매니페스트에는 스케줄러나 컨트롤러 매니저를 위한 플래그가 없습니다. 두 구성요소는 각자의 kubeconfig에 들어 있는 클라이언트 인증서로 API 서버에 접속합니다.

| 구성요소 | kubeconfig(kubeadm) |
|---|---|
| kube-scheduler | `/etc/kubernetes/scheduler.conf` |
| kube-controller-manager | `/etc/kubernetes/controller-manager.conf` |
| kubelet | `/etc/kubernetes/kubelet.conf` |
| 관리자 | `/etc/kubernetes/admin.conf` |

이 클라이언트 인증서는 클러스터 CA가 서명했고 API 서버는 `--client-ca-file`로 그 서명을 확인합니다.

인증서의 CN과 O가 RBAC의 사용자 이름과 그룹이 됩니다. 스케줄러의 인증서 CN이 `system:kube-scheduler`이고 그 이름에 기본 ClusterRole `system:kube-scheduler`가 바인딩되어 있는 식입니다.

### 3-3. 유효 기간과 확인 명령

kubeadm이 만든 인증서의 유효 기간은 둘로 나뉩니다.

| 대상 | 유효 기간 | 설정 필드(기본값) |
|---|---|---|
| 리프 인증서 | 1년 | `certificateValidityPeriod` (8760h) |
| CA | 10년 | `caCertificateValidityPeriod` (87600h) |

만료일은 `kubeadm certs check-expiration`으로 봅니다. kubelet 클라이언트 인증서는 이 목록에 나오지 않습니다. `/var/lib/kubelet/pki`에서 자동으로 회전하기 때문입니다.

`kubeadm certs renew all` 뒤 static Pod를 다시 띄우는 절차와 `kubeadm upgrade`가 인증서를 함께 갱신한다는 점은 [5편](/blog/cert/cka/cka-02-cluster-architecture)의 인증서 만료 절에 정리했습니다.

### 3-4. 직접 해 보기

kubeadm VM 클러스터에서 세 가지를 확인합니다.

1. `grep -E 'tls-cert|client-ca|etcd-|kubelet-client' /etc/kubernetes/manifests/kube-apiserver.yaml`로 3-1절 표를 채웁니다.
2. `openssl x509 -in /etc/kubernetes/pki/apiserver.crt -noout -subject -ext subjectAltName`으로 SAN을 확인합니다.
3. `scheduler.conf`의 `client-certificate-data`를 base64로 풀어 CN이 `system:kube-scheduler`인지 봅니다.

---

## 4. Pod

<details>
<summary>기초부터: Pod는 왜 컨테이너를 한 번 더 감싸는지</summary>

> **핵심 한 줄**: **Pod**는 쿠버네티스에서 만들고 관리할 수 있는 가장 작은 배포 단위이고 컨테이너가 하나면 "컨테이너 하나와 그 실행 환경"이라고 보면 됩니다.

#### 1. 왜 필요한가

쿠버네티스는 컨테이너를 직접 다루지 않고 Pod라는 단위로 다룹니다. 함께 움직여야 하는 것들을 하나로 묶기 위해서입니다. 대부분의 Pod에는 컨테이너가 하나 들어 있습니다.

#### 2. 어떻게 묶나

1. **배치와 수명**: 한 Pod의 컨테이너는 항상 같은 노드에 함께 배치되고 함께 시작하고 함께 사라집니다.
2. **네트워크**: 같은 네트워크 네임스페이스를 써서 IP 하나를 나눠 갖고 서로를 `localhost`로 부릅니다.
3. **볼륨**: Pod에 정의한 볼륨을 함께 마운트할 수 있습니다.

```text
Pod order-api (IP 10.244.1.5)
 ├─ pause 컨테이너   ← 네트워크 네임스페이스를 먼저 잡아 둠(1-4절)
 └─ web 컨테이너     ← 그 네임스페이스에 들어가 80 포트를 엶
```

가장 작은 Pod YAML은 이 정도입니다.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: order-api
  namespace: shop
  labels:
    app: order-api
spec:
  containers:
  - name: web
    image: nginx:1.27
    ports:
    - containerPort: 80
```

`kubectl run order-api --image=nginx:1.27 -n shop`이 같은 것을 명령 한 줄로 만듭니다.

#### 3. 헷갈리는 점

| 흔한 오해 | 실제 동작 |
|---|---|
| 요청이 몰리면 Pod에 같은 컨테이너를 더 넣는다 | 늘리기는 Pod 단위입니다. 같은 Pod를 하나 더 만들고 개수는 5장의 ReplicaSet과 Deployment가 정하고 유지합니다 |
| 죽은 Pod를 고쳐서 다시 쓴다 | Pod는 갈아 끼웁니다. 노드가 죽거나 Pod가 지워지면 그 Pod는 끝이고 컨트롤러가 이름과 IP가 다른 새 Pod를 만듭니다 |
| Pod IP를 적어 두고 부른다 | IP가 바뀌므로 6장의 Service로 부릅니다 |

#### 4. 실전에서 보이는 모습

- 실무와 시험 모두 Pod를 단독으로 만드는 일은 점검이나 일회성 작업에 한정하고 서비스는 Deployment로 띄웁니다.
- 단독 Pod를 지우면 다시 생기지 않고 Deployment가 만든 Pod를 지우면 이름이 다른 Pod가 바로 생깁니다.

> **정리**: Pod는 함께 배치되고 IP와 볼륨을 나누는 컨테이너 묶음입니다. 늘리기와 되살리기는 Pod 위의 컨트롤러가 맡고 고정 주소는 Service가 줍니다.

</details>

### 4-1. phase 다섯과 컨테이너 상태 셋

Pod Lifecycle 문서는 Pod 전체의 phase와 컨테이너 하나하나의 상태를 따로 정의합니다.

| 구분 | 값 | 의미 |
|---|---|---|
| Pod phase | Pending | API에는 받아들여졌지만 컨테이너 하나 이상이 아직 준비되지 않음. 스케줄 대기와 이미지 받기 시간이 포함 |
| | Running | 노드에 배정되었고 컨테이너가 모두 만들어졌으며 하나 이상이 실행 중이거나 시작/재시작 중 |
| | Succeeded | 모든 컨테이너가 성공으로 끝났고 재시작하지 않음 |
| | Failed | 모든 컨테이너가 끝났고 하나 이상이 실패로 끝남 |
| | Unknown | 노드와 통신이 끊겨 상태를 알 수 없음 |
| 컨테이너 상태 | Waiting | 시작에 필요한 작업 중. reason에 `ContainerCreating`, `ImagePullBackOff`, `CrashLoopBackOff` 등 |
| | Running | 실행 중 |
| | Terminated | 끝남. exit code와 reason(`Completed`, `Error`, `OOMKilled`) 기록 |

`kubectl get pod`의 STATUS 열은 phase 그대로가 아닙니다. 사람이 읽기 좋게 고른 값이고 컨테이너가 Waiting이면 그 reason을 띄웁니다. 그래서 STATUS와 phase가 엇갈려 보입니다.

| STATUS 열 | 그동안의 phase |
|---|---|
| `ContainerCreating` | `Pending` |
| `CrashLoopBackOff` | 대개 `Running` |

확인은 이렇게 나눠서 합니다.

```bash
kubectl get pod order-api -n shop -o jsonpath='{.status.phase}{"\n"}'
kubectl get pod order-api -n shop -o jsonpath='{.status.containerStatuses[0].state}{"\n"}'
```

<details>
<summary>기초부터: CrashLoopBackOff 하나를 시간순으로 따라가기</summary>

> **핵심 한 줄**: STATUS 열은 순간 사진이고 phase는 Pod 전체의 단계입니다. 컨테이너가 계속 죽어도 다시 띄울 예정이면 phase는 `Running`에 머뭅니다.

#### 1. `kubectl get pod` 한 줄 읽기

```text
NAME        READY   STATUS             RESTARTS      AGE
order-api   0/1     CrashLoopBackOff   4 (30s ago)   3m
```

| 칸 | 뜻 |
|---|---|
| READY | 준비된 컨테이너 수 / 전체 컨테이너 수. `0/1`이면 하나뿐인 컨테이너가 아직 요청을 받을 수 없음 |
| STATUS | 위 4-1절 표의 값 중 사람이 보기 좋은 것 하나. 컨테이너가 Waiting이면 그 reason |
| RESTARTS | 이 Pod 안에서 컨테이너가 다시 시작된 횟수와 마지막 재시작이 얼마 전인지 |
| AGE | Pod가 만들어진 뒤 지난 시간. 컨테이너가 다시 시작돼도 줄지 않음 |

#### 2. 시작하자마자 exit 1로 끝나는 컨테이너

설정 파일 경로를 잘못 줘서 앱이 뜨자마자 종료되는 주문 API를 떠올려 봅니다. `restartPolicy`는 기본값 `Always`입니다.

| 순서 | STATUS 열에 보이는 것 | 컨테이너 상태 | Pod phase |
|---|---|---|---|
| 1. 이미지 받는 중 | `ContainerCreating` | Waiting | Pending |
| 2. 실행 직후 종료 | `Error` | Terminated(exit code 1) | Running |
| 3. kubelet이 다시 띄우기 전 대기 | `CrashLoopBackOff` | Waiting(reason CrashLoopBackOff) | Running |
| 4. 다시 시작했다가 또 종료 | `Error` | Terminated | Running |
| 5. 대기 시간이 점점 길어지며 3과 4 반복 | `CrashLoopBackOff`와 `Error`가 번갈아 | | Running |

"Back-off"는 재시작 사이에 점점 늘어나는 대기를 뜻합니다. Pod Lifecycle 문서 기준으로 이렇게 움직입니다.

- 대기는 10초, 20초, 40초처럼 두 배씩 늘어납니다.
- 최대 300초(5분)에서 더 늘지 않습니다.
- 컨테이너가 문제없이 10분을 버티면 대기 시간이 처음으로 돌아갑니다.

같은 문서에는 최대 대기를 노드마다 바꾸는 kubelet 설정(`crashLoopBackOff.maxContainerRestartPeriod`, v1.35 beta)도 있지만 기본값은 그대로입니다.

phase가 `Running`에 머무는 이유는 phase 정의에 "시작 또는 재시작 중"이 들어 있기 때문입니다. 같은 컨테이너라도 `restartPolicy: Never`였다면 다시 띄우지 않으니 첫 종료에서 phase가 `Failed`가 됩니다.

#### 3. 실전에서 보이는 모습

- 이미 다시 시작된 컨테이너의 `kubectl logs`는 새로 뜬 컨테이너의 로그라 비어 있기 쉽습니다. 죽기 직전 로그는 `kubectl logs order-api --previous`로 봅니다.
- `describe pod`의 `Last State: Terminated`에 직전 종료의 exit code와 reason이 남습니다. `OOMKilled`(exit 137)면 메모리 limit, `Error`(exit 1)면 앱 쪽 문제부터 봅니다.

> **정리**: STATUS는 지금 이 순간의 모습, phase는 Pod 전체의 단계, 컨테이너 상태는 컨테이너 하나의 모습입니다. 세 가지를 따로 읽으면 CrashLoopBackOff인데 phase가 Running인 것이 이상하지 않습니다.

</details>

1.18 이후 `kubectl run`은 Pod 하나만 만듭니다. 옛 자료처럼 Deployment가 생기지 않습니다.

### 4-2. Pod IP는 생성 직후부터 클러스터 안 어디서나 닿는다

쿠버네티스 네트워크 모델에서 Pod는 클러스터 전체에서 고유한 IP를 받고 다른 노드의 Pod끼리도 NAT 없이 그 IP로 직접 통신합니다. 그래서 Pod가 IP를 받으면 다른 노드의 Pod에서도 바로 요청할 수 있습니다.

"어디서나 닿는다"에는 두 가지 단서가 붙습니다.

- 클러스터 바깥에 열려면 NodePort나 LoadBalancer Service, Ingress, Gateway가 필요합니다.
- NetworkPolicy가 있으면 클러스터 안에서도 막힐 수 있습니다.

Pod IP는 Pod가 다시 만들어질 때마다 바뀝니다. Service는 고정 IP와 DNS 이름을 주고 뒤의 Pod 목록은 EndpointSlice로 따라갑니다.

### 4-3. 멀티 컨테이너와 네이티브 사이드카

<details>
<summary>기초부터: 컨테이너 여러 개를 한 Pod에 넣는 경우</summary>

> **핵심 한 줄**: 본 앱 옆에 반드시 하나씩 붙어 다니며 같은 파일이나 `localhost`를 써야 하는 보조 기능은 같은 Pod에 넣습니다.

#### 1. 왜 필요한가

컨테이너 하나에 기능을 다 넣지 않고 따로 이미지를 만드는 이유는 각자 따로 만들고 고치고 재사용하기 위해서입니다.

그런데 어떤 보조 기능은 본 앱 옆에 반드시 하나씩 붙어 있어야 합니다. 게시판 앱이 파일로 남기는 로그를 읽어 중앙 수집기로 보내는 로그 전달기가 그런 예입니다. 앱 인스턴스가 셋이면 전달기도 셋이어야 하고 같은 파일을 읽어야 합니다.

#### 2. 한 Pod에 넣으면 공유하는 것

1. **생명주기**: 같이 배치되고 같이 늘고 같이 사라집니다. 앱만 늘고 전달기는 그대로인 불일치가 생기지 않습니다.
2. **네트워크**: IP와 포트 공간이 하나입니다. 상대 컨테이너를 `localhost:<포트>`로 부르고 Service를 따로 만들 필요가 없습니다.
3. **볼륨**: 같은 볼륨을 양쪽에 마운트해 파일로 주고받습니다.

```text
Pod board-web
 ├─ app          ── 쓰기 ──▶ /var/log/app/board.log ┐
 │                                                  ├─ emptyDir "logs"
 └─ log-shipper  ◀── 읽기 ── /var/log/app/board.log ┘
```

`spec.containers`가 목록이라 컨테이너를 나열하기만 하면 됩니다.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: board-web
spec:
  volumes:
  - name: logs
    emptyDir: {}
  containers:
  - name: app
    image: busybox:1.36
    command: ["sh", "-c", "while true; do date >> /var/log/app/board.log; sleep 5; done"]
    volumeMounts:
    - {name: logs, mountPath: /var/log/app}
  - name: log-shipper
    image: busybox:1.36
    command: ["sh", "-c", "tail -F /var/log/app/board.log"]
    volumeMounts:
    - {name: logs, mountPath: /var/log/app}
```

#### 3. 한눈에 비교: 같은 Pod와 다른 Pod

| 조합 | 판단 | 이유 |
|---|---|---|
| 게시판 앱 + 로그 전달기 | 같은 Pod | 1:1로 붙어 다니고 같은 파일을 읽음 |
| 게시판 웹 + DB | 다른 Pod(다른 Deployment, StatefulSet)와 Service | 늘리는 기준과 수명이 다름 |

"반드시 1:1로 붙어 다니고 같은 파일이나 localhost를 써야 하는지"로 판단합니다.

#### 4. 실전에서 보이는 모습

- 두 컨테이너가 같은 포트를 열면 포트 공간이 하나라서 충돌합니다.
- 여러 컨테이너가 있는 Pod에서 `kubectl logs`나 `exec`를 쓸 때는 `-c <컨테이너 이름>`으로 대상을 고릅니다. `-c`를 빼면 `kubectl.kubernetes.io/default-container` 어노테이션에 적힌 컨테이너가 기본 대상이 됩니다([Well-Known Labels, Annotations and Taints](https://kubernetes.io/docs/reference/labels-annotations-taints/#kubectl-kubernetes-io-default-container)).
- READY 열은 `2/2`처럼 Pod 안 컨테이너 수 기준으로 보입니다.

#### 5. 도커만으로 같은 묶음을 만들 때와 비교

Pod가 대신 해 주는 일은 도커만으로 같은 구성을 만들어 보면 드러납니다.

| 맞춰야 할 것 | 도커만 쓸 때 | Pod로 묶을 때 |
|---|---|---|
| 네트워크 | 보조 컨테이너를 `docker run --network container:<앱 컨테이너>`로 띄워 앱의 네트워크에 붙임 | 같은 Pod면 자동으로 공유 |
| 볼륨 | 이름 있는 볼륨을 만들어 양쪽에 `-v`로 따로 마운트 | `volumes`에 한 번 정의하고 각 컨테이너가 마운트 |
| 수명 | 앱 컨테이너가 지워지면 보조 컨테이너도 사람이나 스크립트가 찾아 지움 | 함께 생기고 함께 사라짐 |
| 개수 | 앱을 셋으로 늘리면 보조 컨테이너 셋과 연결 셋을 직접 맞춤 | Pod 개수만 늘리면 끝 |

> **정리**: 생명주기, 네트워크, 볼륨을 함께 써야 하는 보조 기능만 같은 Pod에 넣습니다. 앱보다 먼저 떠야 하는 보조 컨테이너는 아래 본문의 init 컨테이너와 네이티브 사이드카로 넣습니다.

</details>

한 Pod 안의 컨테이너는 같은 노드에서 함께 뜨고 함께 사라지며 네트워크 네임스페이스를 공유합니다. 같은 Pod의 다른 컨테이너에는 `localhost:<포트>`로 닿고 볼륨은 정의한 만큼 공유합니다.

보조 컨테이너는 두 방식으로 넣습니다. 둘 다 `initContainers`에 적는데 끝나는 시점이 다릅니다.

| 방식 | 적는 법 | 동작 |
|---|---|---|
| 일반 init 컨테이너 | `initContainers` | 순서대로 하나씩 실행되고 모두 성공해야 앱 컨테이너가 시작됨 |
| 네이티브 사이드카(v1.33 GA) | `initContainers`에 `restartPolicy: Always` | 앱보다 먼저 뜨고 Pod가 끝날 때까지 계속 돎 |

예시 YAML은 [6편](/blog/cert/cka/cka-03-workloads-scheduling)의 네이티브 사이드카 절에 있습니다.

### 4-4. 직접 해 보기

1. `kubectl run bad --image=nginx:no-such-tag -n shop`을 실행합니다.
2. 4-1절의 jsonpath 두 줄로 phase와 컨테이너 상태를 따로 기록합니다. STATUS 열이 `ErrImagePull`과 `ImagePullBackOff`를 오가는 동안 phase가 `Pending`인지 확인합니다.
3. 이어서 `kubectl run tmp --rm -it --image=busybox:1.36 -n shop -- wget -qO- -T 2 <order-api Pod IP>`로 다른 Pod에서 Pod IP가 바로 닿는지 봅니다.

---

## 5. ReplicationController, ReplicaSet, Deployment

<details>
<summary>기초부터: Pod를 직접 만들지 않고 ReplicaSet과 Deployment를 쓰는 이유</summary>

> **핵심 한 줄**: Pod에는 "몇 개가 있어야 한다"는 정보가 없어서 그 개수를 지키는 **ReplicaSet**과 템플릿을 갈아타는 **Deployment**를 위에 둡니다.

#### 1. 왜 필요한가

| 상황 | 단독 Pod | ReplicaSet | Deployment |
|---|---|---|---|
| Pod가 지워지거나 노드가 죽음 | 아무도 다시 만들지 않음 | 개수를 맞춰 새로 만듦 | 아래 ReplicaSet이 새로 만듦 |
| 이미지를 바꿈 | 지우고 다시 만들어야 함 | 템플릿을 바꿔도 기존 Pod는 그대로 | 새 ReplicaSet으로 하나씩 갈아탐 |
| 되돌리기 | 없음 | 없음 | 옛 ReplicaSet을 남겨 두어 `rollout undo` 가능 |

#### 2. 어떻게 발전했나

1. **ReplicationController(RC)**: 처음 이 역할을 맡았습니다. "이 라벨의 Pod가 3개 있어야 한다"를 적어 두면 컨트롤러가 개수를 맞춥니다. 노드 여러 대에 걸쳐 Pod를 유지하므로 한 노드가 죽어도 다른 노드에 새로 만듭니다.
2. **ReplicaSet(RS)**: RC의 후속입니다. 하는 일은 같고 셀렉터가 더 풍부해졌습니다(`matchExpressions`). 지금 RC는 레거시입니다.
3. **Deployment**: ReplicaSet 위에 한 층을 더 얹습니다. 이미지를 바꾸면 새 템플릿으로 새 ReplicaSet을 만들고 옛 ReplicaSet은 줄이면서 새 쪽을 늘립니다. 이것이 롤링 업데이트입니다.

```text
Deployment order-api        "nginx:1.28로 3개, 하나씩 바꿔라"
  └─ ReplicaSet order-api-7d9f  "이 템플릿 Pod 3개 유지"  (현재)
  │    ├─ Pod order-api-7d9f-abcde
  │    ├─ Pod order-api-7d9f-fghij
  │    └─ Pod order-api-7d9f-klmno
  └─ ReplicaSet order-api-5c6b  "옛 템플릿, 0개"  (되돌리기용으로 남음)
```

| 오브젝트 | 아는 것 |
|---|---|
| ReplicaSet | "지금 템플릿으로 몇 개" |
| Deployment | "템플릿이 바뀌면 어떻게 갈아탈지" |

YAML에서는 `spec.template`이 "이렇게 생긴 Pod를 찍어 내라"는 틀입니다. 앞 4장의 Pod YAML에서 `apiVersion`과 `kind`를 뺀 `metadata`와 `spec`이 그대로 이 자리에 들어갑니다. 5-4절에서 볼 리비전과 롤아웃은 모두 이 `template`이 바뀌었는지로 정해집니다.

#### 3. 한눈에 비교: RC와 RS

| 항목 | ReplicationController | ReplicaSet |
|---|---|---|
| apiVersion | `v1` | `apps/v1` |
| selector | 생략하면 template 라벨을 그대로 씀 | 필수 |
| selector 형식 | 라벨 일치(`key: value`)만 | `matchLabels`와 `matchExpressions`(In, NotIn, Exists, DoesNotExist) |
| 지금 위치 | 레거시 | Deployment가 내부에서 사용 |

#### 4. 헷갈리는 점

- 사람은 Deployment만 고치고 ReplicaSet을 직접 만들거나 고칠 일은 거의 없습니다. ReplicaSet을 직접 고쳐도 Deployment 컨트롤러가 자기 기준으로 다시 덮어씁니다.
- selector에 맞는 Pod가 이미 떠 있어도 `template`은 생략할 수 없습니다. ReplicaSet의 일은 개수를 계속 지키는 것이라 지금 있는 Pod가 나중에 죽으면 새로 찍어 내야 하고 그때 쓸 틀이 template입니다.
- 개수를 바꾸는 `kubectl scale`은 클러스터의 라이브 객체만 바꿉니다. 손에 든 YAML 파일의 `replicas`는 그대로이니 그 파일로 다시 적용하면 원래 숫자로 돌아갑니다(5-5절).
- 라벨이 맞는 주인 없는 Pod를 자기 것으로 세는 동작(5-2절)은 RC에도 있습니다. ReplicationController 문서는 RC의 selector에 맞는 Pod를 따로 만들지 말라고 경고합니다. RC가 그 Pod를 자기가 만든 것으로 여기기 때문입니다.
- RS는 Pod 여러 개를 유지할 뿐이고 요청을 나눠 보내는 일은 6장의 Service가 합니다. Pod가 여러 노드에 흩어지는 것도 스케줄러의 배치 결과입니다.

#### 5. RC, RS, Deployment YAML 나란히 보기

같은 Pod 3개를 RC로 적으면 이렇습니다.

```yaml
apiVersion: v1
kind: ReplicationController
metadata:
  name: product-web-rc
spec:
  replicas: 3
  # selector를 생략하면 template의 라벨(app: product-web)을 selector로 씀
  template:
    metadata:
      labels:
        app: product-web
    spec:
      containers:
      - name: web
        image: nginx:1.27
```

| 바꿀 곳 | RC | RS | Deployment |
|---|---|---|---|
| `apiVersion` | `v1` | `apps/v1` | `apps/v1` |
| `kind` | `ReplicationController` | `ReplicaSet` | `Deployment` |
| `selector` | 생략 가능. 쓰면 `app: product-web` 형태 | `matchLabels` 아래에 필수 | RS와 같음 |
| `replicas`, `template` | 같음 | 같음 | 같음 |

Deployment의 가장 작은 YAML은 RS 파일에서 `kind`만 바꾼 모양입니다. `strategy`, `revisionHistoryLimit`처럼 Deployment에만 있는 필드는 생략하면 기본값(RollingUpdate, 10)이 들어갑니다.

> **정리**: 개수는 ReplicaSet이, 버전 갈아타기와 되돌리기는 Deployment가 맡습니다. RC는 레거시이고 RS로 옮길 때 바꿀 곳은 바로 아래 5-1절에 있습니다.

</details>

### 5-1. RC와 RS의 차이

ReplicationController 문서는 이 API를 레거시로 표시하고 Deployment와 ReplicaSet을 쓰라고 안내합니다. 옛 YAML을 RS로 고칠 때 바꿀 곳은 둘입니다.

1. apiVersion을 `v1`에서 `apps/v1`로 바꿉니다.
2. 맵 형태의 `selector: {app: order-api}`를 `selector.matchLabels` 아래로 옮깁니다.

RS는 selector를 생략할 수 없습니다.

RS는 `matchExpressions`(In, NotIn, Exists, DoesNotExist)로 집합 기반 selector도 씁니다.

```yaml
apiVersion: apps/v1
kind: ReplicaSet
metadata:
  name: product-web
  namespace: shop
spec:
  replicas: 3
  selector:
    matchLabels:
      app: product-web
    matchExpressions:
      - {key: tier, operator: In, values: [frontend]}
  template:
    metadata:
      labels:
        app: product-web
        tier: frontend
    spec:
      containers:
        - name: web
          image: nginx:1.27
```

### 5-2. 라벨이 맞는 주인 없는 Pod는 입양된다

<details>
<summary>기초부터: 라벨과 셀렉터, 어노테이션</summary>

> **핵심 한 줄**: 쿠버네티스 오브젝트는 서로를 이름으로 찾지 않고 **라벨**과 **셀렉터**로 찾습니다. **어노테이션**은 고르는 데 쓰지 않는 메모입니다.

#### 1. 왜 필요한가

ReplicaSet은 자기가 지켜야 할 Pod를 이름으로 찾지 않습니다. Pod 이름은 다시 만들 때마다 바뀌기 때문입니다. 대신 Pod에 붙은 라벨을 보고 찾습니다.

| 연결 방식 | Pod가 다시 만들어지면 |
|---|---|
| 이름으로 연결 | 이름이 바뀌어 설정을 매번 고쳐야 함 |
| 라벨로 연결 | 새 Pod에도 같은 라벨이 붙으니 설정을 고칠 필요가 없음(느슨한 결합) |

#### 2. 어떻게 동작하나

1. **라벨 붙이기**: 오브젝트의 `metadata.labels`에 키-값 쌍을 붙입니다. `app: product-web`, `tier: frontend`, `env: prod`처럼 한 오브젝트에 여러 개를 붙일 수 있습니다.
2. **셀렉터로 고르기**: "이 라벨을 가진 것"이라는 검색 조건입니다. ReplicaSet, Service, NetworkPolicy가 셀렉터로 대상 Pod를 고르고 사람도 `kubectl get pods -l app=product-web,tier=frontend`처럼 씁니다.
3. **누가 만들었든 대상**: 라벨만 맞으면 누가 만든 Pod든 대상이 됩니다. 아래 본문의 "입양"이 그 결과입니다.

```text
Service selector: app=product-web
   ├──▶ Pod A (app=product-web)  ✔
   ├──▶ Pod B (app=product-web)  ✔
   └──✕ Pod C (app=order-api)
```

ReplicaSet YAML에는 라벨이 세 군데 나와서 헷갈립니다.

```yaml
apiVersion: apps/v1
kind: ReplicaSet
metadata:
  name: product-web
  labels:            # 1) ReplicaSet 자신의 라벨. 다른 것이 이 RS를 찾을 때 씀
    app: product-web
spec:
  selector:          # 2) 이 RS가 관리할 Pod를 고르는 조건
    matchLabels:
      app: product-web
  template:
    metadata:
      labels:        # 3) 새로 찍어 낼 Pod에 붙일 라벨
        app: product-web
```

2번과 3번이 맞아야 합니다. 맞지 않으면 RS가 만든 Pod를 자기가 찾지 못해 끝없이 만들게 되므로 API 서버가 아예 생성을 거부합니다(5-3절). 1번은 2번, 3번과 달라도 동작에는 영향이 없습니다.

#### 3. 한눈에 비교: 라벨과 어노테이션

| 구분 | 라벨 | 어노테이션 |
|---|---|---|
| 위치 | `metadata.labels` | `metadata.annotations` |
| 셀렉터로 고르기 | 됨 | 안 됨 |
| 쓰임 | 쿠버네티스가 오브젝트를 묶는 기준 | 빌드 번호, 담당 연락처, 도구가 읽을 설정처럼 붙여 두기만 할 정보 |
| 예 | `app: product-web` | `kubernetes.io/change-cause`, `kubectl.kubernetes.io/last-applied-configuration` |

#### 4. 실전에서 보이는 모습

- selector와 템플릿 라벨이 다르면 `selector does not match template labels` 메시지와 함께 생성이 거부됩니다(5-3절).
- `kubectl get pods --show-labels`로 각 Pod의 라벨을 한 번에 보고 `-l`로 걸러 셀렉터가 무엇을 잡는지 미리 확인합니다.

> **정리**: RS YAML의 라벨 세 군데 중 selector와 템플릿 라벨은 반드시 맞아야 하고 RS 자신의 라벨은 달라도 됩니다. 셀렉터는 누가 만든 Pod인지 따지지 않으므로 라벨만 맞으면 주인 없는 Pod도 RS에 들어갑니다. 그 동작은 바로 아래 본문에서 이어집니다.

</details>

ReplicaSet 문서의 "Non-Template Pod acquisitions" 절 기준으로, ownerReference가 없는 Pod가 RS의 selector에 맞으면 그 RS가 즉시 그 Pod를 자기 것으로 가져갑니다. 순서가 어느 쪽이든 RS는 개수를 replicas에 맞춥니다.

| 순서 | RS가 하는 일 |
|---|---|
| `app=product-web, tier=frontend` 단독 Pod 2개가 먼저 있고 위 RS(replicas 3)를 만듦 | 2개를 입양하고 Pod를 1개만 새로 만듦 |
| RS가 3개를 유지하는 중에 같은 라벨의 단독 Pod를 만듦 | 입양해서 4개가 되었으니 하나를 지움 |

두 번째 경우 문서 예시에서는 새로 만든 Pod가 입양된 직후 종료됩니다.

### 5-3. selector와 템플릿 라벨이 다르면 생성이 거부된다

`apps/v1`의 RS와 Deployment는 selector가 템플릿 라벨에 맞아야 합니다. 맞지 않으면 1-2절의 스키마 검증 단계에서 거부되고 메시지에 `selector does not match template labels`가 들어 있습니다.

selector는 만든 뒤 바꿀 수도 없습니다. 바꿔야 하면 지우고 다시 만듭니다.

### 5-4. Deployment의 리비전 규칙

Deployment는 ReplicaSet을 관리하고 Pod 템플릿이 바뀔 때마다 새 ReplicaSet을 만듭니다. 이 ReplicaSet 하나하나가 리비전입니다. Deployments 문서에서 기억할 사실은 이렇습니다.

| 항목 | 내용 |
|---|---|
| 리비전이 생기는 조건 | `.spec.template`이 바뀔 때만. replicas 변경은 리비전을 만들지 않음 |
| 기본 전략 | RollingUpdate. 다른 값은 Recreate |
| `maxSurge`, `maxUnavailable` | 기본 각각 25%. maxSurge는 올림, maxUnavailable은 내림으로 계산 |
| 이름 규칙 | RS `<deploy>-<pod-template-hash>`, Pod `<deploy>-<hash>-<임의 문자열>` |
| pause 중 | 템플릿을 바꿔도 롤아웃하지 않고 resume 때 한 번에 반영. 스케일은 됨. `rollout undo`는 못 씀 |
| 변경 사유 기록 | `--record`는 deprecated. `kubernetes.io/change-cause` 어노테이션을 직접 달아야 `rollout history`에 표시 |

replicas가 3이면 maxSurge는 0.75를 올려 1, maxUnavailable은 0.75를 내려 0입니다. 새 Pod 하나가 먼저 Ready가 된 뒤에야 옛 Pod가 하나 줄어드는 순서가 됩니다.

<details>
<summary>기초부터: replicas 3의 롤링 업데이트를 한 단계씩</summary>

> **핵심 한 줄**: maxSurge는 "잠깐 몇 개까지 더 띄워도 되나", maxUnavailable은 "잠깐 몇 개까지 모자라도 되나"입니다.

#### 1. 기본값(maxSurge 1, maxUnavailable 0)일 때

replicas 3이면 Pod는 언제나 3개 이상 Ready이고 4개를 넘지 않아야 합니다. 이미지를 `nginx:1.27`에서 `nginx:1.28`로 바꾸면 이렇게 진행합니다.

| 단계 | 옛 RS | 새 RS | 전체 | 일어난 일 |
|---|---|---|---|---|
| 0 | 3 | 0 | 3 | 업데이트 전 |
| 1 | 3 | 1 | 4 | 새 Pod 하나 생성. 상한 4에 닿아서 Ready를 기다림 |
| 2 | 2 | 1 | 3 | 새 Pod가 Ready가 되자 옛 Pod 하나 삭제 |
| 3 | 2 | 2 | 4 | 새 Pod 하나 더 |
| 4 | 1 | 2 | 3 | 옛 Pod 하나 삭제 |
| 5 | 1 | 3 | 4 | 새 Pod 하나 더 |
| 6 | 0 | 3 | 3 | 마지막 옛 Pod 삭제. 완료 |

Deployments 문서의 예시 설명도 같은 흐름입니다. 새 ReplicaSet을 1로 올려 뜨기를 기다리고 옛 것을 2로, 새 것을 2로 바꿔 가며 "최소 3개 사용 가능, 최대 4개 생성"을 지킵니다.

#### 2. 새 이미지가 잘못됐다면

`nginx:1.28`을 `ngnix:1.28`로 잘못 적었다고 해 봅니다. 단계 1의 새 Pod가 `ImagePullBackOff`에 걸려 Ready가 되지 않으니 단계 2로 넘어가지 못합니다. 옛 Pod 3개는 그대로 요청을 받습니다.

maxUnavailable이 0이면 잘못된 배포가 서비스를 줄이지 못합니다. `kubectl rollout status`가 끝나지 않고 기다리는 것이 이 상태이고 `kubectl rollout undo`로 되돌립니다.

#### 3. 반대로 maxSurge 0, maxUnavailable 1이면

| 단계 | 옛 RS | 새 RS | 전체 | 일어난 일 |
|---|---|---|---|---|
| 1 | 2 | 0 | 2 | 먼저 옛 Pod 하나를 지움 |
| 2 | 2 | 1 | 3 | 빈자리에 새 Pod |
| 3 | 1 | 1 | 2 | 새 Pod가 Ready가 되면 옛 Pod 하나 더 삭제 |
| … | | | | 반복 |

노드 자원이 빠듯해서 Pod 하나를 더 띄울 여유가 없을 때 쓰는 설정입니다. 대신 업데이트 내내 Pod가 2개뿐인 구간이 생깁니다.

> **정리**: maxSurge는 잠깐 쓰는 여분 자원, maxUnavailable은 잠깐 줄어드는 처리량입니다. 둘 다 0일 수는 없고 시험에서는 이 표를 머릿속에서 그릴 수 있으면 충분합니다.

</details>

`set image`, `rollout status`, `undo --to-revision` 같은 명령 묶음은 [6편](/blog/cert/cka/cka-03-workloads-scheduling)의 롤링 업데이트 장에 있습니다.

### 5-5. 스케일 명령 세 가지

```bash
# 1) 파일의 replicas를 고친 뒤 반영
kubectl replace -f product-web-rs.yaml

# 2) 파일을 기준으로 대상을 찾아 라이브 객체만 바꿈 (파일 내용은 그대로)
kubectl scale --replicas=6 -f product-web-rs.yaml

# 3) 이름으로 지정
kubectl scale rs product-web --replicas=6 -n shop
```

2번은 파일을 고치지 않습니다. 나중에 같은 파일로 `apply`나 `replace`를 하면 replicas가 파일의 값 3으로 돌아갑니다.

HPA가 붙어 있는 대상은 HPA가 replicas를 다시 덮어씁니다.

`--current-replicas=3`을 같이 주면 현재 값이 3일 때만 바꾸는 조건부 스케일이 됩니다.

### 5-6. 직접 해 보기

1. `kubectl run p1 --image=nginx:1.27 --labels=app=product-web,tier=frontend -n shop`처럼 단독 Pod 2개를 먼저 만듭니다.
2. 5-1절의 RS를 적용하고 새로 생긴 Pod 수와 각 Pod의 `ownerReferences`를 적습니다.
3. selector를 `app: product-api`로 바꾼 RS를 새 이름으로 적용해 거부 메시지를 기록합니다.
4. Deployment에 `kubectl scale`과 `kubectl set image`를 한 번씩 실행해 `rollout history`의 리비전 수 변화를 비교합니다.

---

## 6. Service와 Namespace

### 6-1. Service의 포트 셋과 NodePort가 열리는 위치

<details>
<summary>기초부터: Service가 필요한 이유와 요청이 Pod에 닿는 경로</summary>

> **핵심 한 줄**: **Service**는 "이 라벨의 Pod들"에 고정된 주소와 DNS 이름 하나를 붙여 IP가 바뀌는 Pod 묶음을 한 이름으로 부르게 해 줍니다.

#### 1. 왜 필요한가

주문 API Pod 3개가 떠 있고 상품 웹이 주문 API를 불러야 한다고 해 봅니다.

| 방식 | 문제 |
|---|---|
| Pod IP를 적어 두고 부름 | Pod가 다시 만들어질 때마다 IP가 바뀜(4장). 3개 중 어디로 보낼지도 상품 웹이 정해야 함 |
| Service 이름으로 부름 | 고정 주소 하나로 부르고 Pod 고르기는 클러스터가 맡음 |

#### 2. 어떻게 동작하나

1. **주소 배정**: Service를 만들면 클러스터 안에서만 쓰는 가상 IP(ClusterIP)가 하나 배정되고 CoreDNS에 `order-api.shop.svc.cluster.local` 이름이 생깁니다.
2. **대상 목록 갱신**: endpointslice 컨트롤러가 Service의 selector에 맞는 Pod의 IP와 준비 상태(ready)를 EndpointSlice 오브젝트에 담아 계속 갱신합니다. kube-proxy는 준비된 Pod로만 보냅니다.
3. **커널 규칙 설치**: 각 노드의 kube-proxy가 Service와 EndpointSlice를 watch해 "이 ClusterIP:포트로 가는 패킷은 이 Pod IP들 중 하나로 보내라"는 커널 규칙(iptables 또는 nftables)을 깝니다.
4. **요청 전달**: 상품 웹이 `order-api.shop:80`으로 요청하면 DNS가 ClusterIP를 돌려주고 노드 커널의 규칙이 목적지를 Pod IP 하나로 바꿔 보냅니다.

```text
상품 웹 → DNS(order-api.shop) → ClusterIP:80 → [노드 커널 규칙] → Pod IP 하나
                                                  ▲
                         kube-proxy ← Service + EndpointSlice watch
```

포트 셋은 요청이 지나가는 순서로 읽습니다.

```text
클라이언트 → 노드IP:nodePort → ServiceIP:port → PodIP:targetPort
              (모든 노드에 열림)   (클러스터 안 주소)   (컨테이너가 듣는 포트)
```

#### 3. 한눈에 비교: Service 타입

타입은 "어디서 들어오는 요청을 받을지"로 고릅니다.

| 타입 | 받는 곳 | 쓰는 때 |
|---|---|---|
| ClusterIP(기본) | 클러스터 안 | Pod끼리 호출 |
| NodePort | 모든 노드 IP의 같은 포트(30000-32767) | 외부 LB가 없을 때 바깥에 열기, 실습 |
| LoadBalancer | 클라우드 LB 주소 | 클라우드에서 바깥에 열기. NodePort 위에 LB를 붙인 구조 |

세 타입은 포함 관계입니다(ClusterIP ⊂ NodePort ⊂ LoadBalancer). 기본 설정에서 NodePort Service를 만들면 ClusterIP도 함께 배정되고 LoadBalancer Service를 만들면 NodePort와 ClusterIP가 함께 생깁니다. 바깥 LB가 노드의 nodePort로 보내고 노드에서 Service 규칙을 거쳐 Pod에 닿는 구조라서 그렇습니다.

#### 4. 헷갈리는 점과 실전에서 보이는 모습

- ClusterIP는 어떤 프로세스도 그 주소로 포트를 열고 있지 않은 가상 주소입니다. 그래서 iptables나 nftables 모드에서는 ClusterIP에 `ping`을 해도 응답이 없는 것이 정상이고 포트로 접속해야 규칙이 동작합니다.
- Service로 요청이 닿지 않으면 selector가 Pod 라벨과 맞는지와 대상 Pod가 Ready인지 봅니다. `kubectl get endpointslices -n shop -l kubernetes.io/service-name=order-api`에 주소가 비어 있으면 보낼 곳이 없는 상태입니다([Debug Services](https://kubernetes.io/docs/tasks/debug/debug-application/debug-service/)).
- LoadBalancer 타입을 Service마다 쓰면 클라우드 LB가 Service 수만큼 생깁니다. 쇼핑몰, 게시판, 결제를 각각 열면 LB가 셋이고 비용과 관리할 외부 주소도 그만큼 늘어납니다. 그래서 바깥에 여는 HTTP 서비스가 여럿이면 LB 하나 뒤에 Ingress나 Gateway를 두고 호스트 이름이나 경로(`/shop`, `/board`)로 나눠 각 ClusterIP Service로 보냅니다. 이 구성은 [7편](/blog/cert/cka/cka-04-services-networking)에서 다룹니다.

#### 5. NodePort와 LoadBalancer를 고를 때

포트 셋을 한 YAML에 모으면 이렇습니다.

```yaml
apiVersion: v1
kind: Service
metadata:
  name: product-web
  namespace: shop
spec:
  type: NodePort
  selector:
    app: product-web
  ports:
  - port: 80          # Service가 받는 포트
    targetPort: 80    # 컨테이너가 듣는 포트
    nodePort: 30008   # 모든 노드에 열리는 포트(기본 범위 30000-32767)
```

| 구분 | NodePort | LoadBalancer |
|---|---|---|
| 바깥에서 부르는 주소 | `<노드IP>:30008`. 사용자에게 노드 IP와 포트를 함께 알려야 함 | 클라우드가 준 LB 주소 하나 |
| 부르던 노드가 죽으면 | 그 노드 IP로 부르던 클라이언트는 끊김. 다른 노드 IP로 바꿔 불러야 함 | 클라우드 LB가 상태 확인으로 응답 없는 노드를 빼고 나머지 노드로 보냄 |
| 비용 | 추가 비용 없음 | Service마다 클라우드 LB 한 대 |

> **정리**: Service는 고정 주소와 이름을, EndpointSlice는 지금 살아 있는 Pod 목록을, kube-proxy가 깐 커널 규칙은 실제 전달을 맡습니다. 포트 셋의 세부 규칙은 바로 아래 본문에 있습니다.

</details>

| 필드 | 뜻 | 생략하면 |
|---|---|---|
| `port` | Service가 받는 포트 | - |
| `targetPort` | Pod 쪽 포트. 이름 있는 포트도 가능 | `port`와 같음 |
| `nodePort` | 노드가 여는 포트 | 30000-32767에서 자동 배정 |

nodePort는 Pod가 있는 노드에만 열리지 않습니다. Service 문서는 NodePort를 "Each node proxies that port (the same port number on every Node)"로 설명합니다. 주문 API Pod가 노드 1에만 있어도 노드 2의 같은 nodePort로 들어온 요청이 노드 1의 Pod까지 전달됩니다.

이 동작은 `externalTrafficPolicy`로 바꿀 수 있습니다.

- `Cluster`(기본값): 아무 노드의 Pod로 전달합니다.
- `externalTrafficPolicy: Local`: 들어온 노드에 있는 Ready Pod로만 전달해 클라이언트 IP를 보존합니다. 그 노드에 Pod가 없으면 트래픽을 버립니다.

타입 네 가지와 headless, `expose` 명령, EndpointSlice는 [7편](/blog/cert/cka/cka-04-services-networking)에 자세히 있습니다.

### 6-2. 네임스페이스 범위와 클러스터 범위

<details>
<summary>기초부터: 네임스페이스는 무엇을 나누는지</summary>

> **핵심 한 줄**: **네임스페이스**는 클러스터 하나를 이름, 권한, 자원 총량 기준으로 나눈 논리적인 칸이고 네트워크와 노드는 나누지 않습니다.

#### 1. 왜 필요한가

클러스터 하나를 여러 팀이나 여러 환경이 같이 쓰면 이름이 겹치고 실수로 남의 것을 지우는 일이 생깁니다. 쇼핑몰 서비스는 `shop`, 게시판은 `board`, 결제는 `payment`에 두는 식으로 칸을 나눕니다.

#### 2. 무엇이 나뉘나

1. **이름**: 같은 kind의 이름은 네임스페이스 안에서만 겹치면 안 됩니다. `shop`과 `board`에 각각 `web`이라는 Deployment를 둘 수 있습니다.
2. **권한**: Role과 RoleBinding은 네임스페이스 안에서만 효력이 있어서 "board 팀은 board 네임스페이스만"을 표현할 수 있습니다([5편 1장](/blog/cert/cka/cka-02-cluster-architecture)).
3. **자원 총량**: ResourceQuota와 LimitRange를 네임스페이스마다 걸어 한 팀이 클러스터 자원을 다 쓰는 것을 막습니다(6-5절).
4. **정리**: 네임스페이스를 지우면 그 안의 오브젝트가 모두 함께 지워집니다.

```text
클러스터
 ├─ ns shop     : Deployment web, Service order-api, Role ...
 ├─ ns board    : Deployment web(이름 겹쳐도 됨), ResourceQuota ...
 └─ ns payment  : ...
 노드 node-1, node-2 ← 어느 네임스페이스에도 속하지 않고 Pod가 섞여 뜸
```

#### 3. 한눈에 비교

| 나뉨 | 나뉘지 않음 |
|---|---|
| 오브젝트 이름 | 네트워크. 기본 상태에서 `board`의 Pod는 `shop`의 Pod IP와 Service에 그대로 닿음. 막으려면 NetworkPolicy |
| Role, RoleBinding 권한 | 노드. 두 네임스페이스의 Pod가 같은 노드에 섞여 뜸 |
| ResourceQuota, LimitRange | 클러스터 범위 리소스(아래 6-2절 표) |

#### 4. 헷갈리는 점과 실전에서 보이는 모습

- 네임스페이스를 고르는 순서는 이렇습니다.

```text
-n 플래그 → kubeconfig 컨텍스트의 기본 네임스페이스 → default
```

- 시험에서 문제마다 네임스페이스가 다르니 `-n`을 빠뜨려 `default`에 만드는 실수가 흔합니다. 이때 정답 네임스페이스에서 조회하면 `NotFound`가 나옵니다.
- 없는 네임스페이스에 만들려 하면 1-2절의 `NamespaceLifecycle` 어드미션이 거부합니다.
- `kube-system`에는 컨트롤 플레인과 CoreDNS, kube-proxy가 있습니다. 여기서 무언가를 지우거나 고치면 클러스터 전체가 영향을 받으니 문제에서 요구할 때만 손댑니다.

#### 5. 자주 쓰는 명령과 한 파일로 만드는 예

```bash
kubectl get ns                                          # 네임스페이스 목록(ns는 namespaces 줄임말)
kubectl get pods -n board                               # 한 네임스페이스만
kubectl get pods -A                                     # 모든 네임스페이스(--all-namespaces)
kubectl config set-context --current --namespace=board  # 현재 컨텍스트의 기본 네임스페이스 바꾸기
kubectl apply -f board.yaml                             # 파일에 적힌 metadata.namespace를 따름
```

네임스페이스와 쿼터, 그 안의 Pod를 `---`로 이어 한 파일에 둘 수 있습니다.

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: board
---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: board-quota
  namespace: board
spec:
  hard:
    pods: "10"             # Pod 수 합계
    requests.cpu: "4"      # requests 합계(스케줄러가 자리를 잡을 때 쓰는 예약량)
    requests.memory: 4Gi
    limits.cpu: "8"        # limits 합계(넘을 수 없는 상한)
    limits.memory: 8Gi
---
apiVersion: v1
kind: Pod
metadata:
  name: board-web
  namespace: board
spec:
  containers:
  - name: web
    image: nginx:1.27
    resources:
      requests: {cpu: 250m, memory: 64Mi}
      limits: {cpu: 500m, memory: 128Mi}
```

쿼터에 `limits.cpu`처럼 limits 항목이 있으면 그 네임스페이스의 Pod도 limits를 적어야 만들어집니다. 그래서 예시 Pod는 requests와 limits를 모두 적었습니다. 적지 않은 Pod를 받으려면 6-5절의 LimitRange로 기본값을 채웁니다.

> **정리**: 네임스페이스는 이름, 권한, 쿼터의 경계이고 네트워크 벽은 NetworkPolicy가 따로 세웁니다. 어떤 리소스가 네임스페이스에 속하는지는 바로 아래 명령과 표로 확인합니다.

</details>

리소스는 네임스페이스 범위와 클러스터 범위로 나뉘고 어느 쪽인지는 이 명령으로 확인합니다.

```bash
kubectl api-resources --namespaced=true
kubectl api-resources --namespaced=false
```

| 네임스페이스 범위 | 클러스터 범위 |
|---|---|
| Pod, Deployment, ReplicaSet, Service, ConfigMap, Secret | Node, Namespace 자체 |
| PersistentVolumeClaim | PersistentVolume, StorageClass |
| Role, RoleBinding, ServiceAccount | ClusterRole, ClusterRoleBinding |
| ResourceQuota, LimitRange, NetworkPolicy | PriorityClass, IngressClass, GatewayClass, CSIDriver |
| Ingress, Gateway, HTTPRoute | CustomResourceDefinition, ValidatingWebhookConfiguration |

PVC는 네임스페이스 범위이고 PV는 클러스터 범위라는 대비가 자주 나옵니다. 클러스터 범위 객체에 `-n`을 붙여도 에러 없이 무시됩니다.

### 6-3. 기본 네임스페이스 넷

| 네임스페이스 | 용도 |
|---|---|
| `default` | 네임스페이스를 지정하지 않은 객체가 들어감 |
| `kube-system` | 쿠버네티스 시스템 구성요소(컨트롤 플레인 static Pod, CoreDNS, kube-proxy) |
| `kube-public` | 인증하지 않은 클라이언트도 읽을 수 있음. 관례상 `cluster-info` ConfigMap |
| `kube-node-lease` | 노드마다 Lease 하나. kubelet이 갱신하는 하트비트 |

kube-node-lease의 Lease가 2-6절에서 본 하트비트입니다. 큰 Node 객체 대신 작은 Lease를 자주 갱신해 API 서버 부담을 줄이고 컨트롤 플레인은 이것으로 노드 장애를 감지합니다.

### 6-4. 다른 네임스페이스의 Service를 부르는 DNS 이름

Service의 전체 이름은 `<service>.<namespace>.svc.cluster.local`입니다. 상품 웹이 `web` 네임스페이스에 있고 주문 API가 `shop` 네임스페이스에 있다면 이렇게 부릅니다.

| 부르는 곳 | 쓸 수 있는 이름 |
|---|---|
| 같은 `shop` 네임스페이스 | `order-api` |
| 다른 네임스페이스(`web`) | `order-api.shop`, `order-api.shop.svc.cluster.local` |

짧은 이름이 통하는 이유는 Pod의 `/etc/resolv.conf`에 들어간 search 도메인(`<자기 ns>.svc.cluster.local svc.cluster.local cluster.local`) 덕분입니다. `cluster.local`은 클러스터 도메인 설정값이라 클러스터마다 다를 수 있습니다.

### 6-5. ResourceQuota와 LimitRange의 관계

두 객체 모두 네임스페이스 범위이고 1-2절의 어드미션 단계에서 작동합니다. 역할이 다릅니다.

| 항목 | ResourceQuota | LimitRange |
|---|---|---|
| 대상 | 네임스페이스 전체 합계 | 개별 Pod, 컨테이너 |
| 정하는 값 | `spec.hard`(예: `requests.cpu`, `limits.memory`, `pods`) | `spec.limits[]`의 `default`, `defaultRequest`, `min`, `max` |
| 어드미션 | 검증(초과하면 거부) | 변형(기본값 주입)과 검증(min/max 위반 거부) |

둘은 이렇게 맞물립니다.

1. ResourceQuota에 `requests.cpu`가 있으면 그 네임스페이스의 Pod는 CPU requests를 반드시 가져야 하고 없으면 생성이 거부됩니다.
2. LimitRange의 `defaultRequest`가 있으면 변형 어드미션 단계에서 값이 채워지니 거부를 피합니다.

두 정책 모두 생성 시점에만 검사합니다. 이미 떠 있는 Pod에는 소급하지 않습니다.

```bash
kubectl create quota shop-quota -n shop --hard=requests.cpu=2,requests.memory=2Gi,pods=10
kubectl describe quota shop-quota -n shop
```

LimitRange는 명령형 생성 명령이 없어서 YAML로 씁니다. 예시와 값 계산은 [6편](/blog/cert/cka/cka-03-workloads-scheduling)의 LimitRange, ResourceQuota 절에 있습니다.

### 6-6. 직접 해 보기

두 가지를 해 봅니다.

1. **DNS**: `web` 네임스페이스의 임시 Pod에서 `nslookup order-api`와 `nslookup order-api.shop`을 차례로 실행하고 `/etc/resolv.conf`의 search 줄을 기록합니다. 이미지는 `registry.k8s.io/e2e-test-images/jessie-dnsutils:1.3`을 씁니다.
2. **쿼터**: `shop`에 6-5절의 쿼터를 만든 뒤 requests 없는 Pod가 거부되는지, `defaultRequest`가 있는 LimitRange를 더하면 만들어지는지 봅니다.

이미지를 따로 고른 데는 이유가 있습니다. `busybox:1.36`의 `nslookup`은 kind에서 search 처리 탓에 `order-api.shop`도 NXDOMAIN으로 보였습니다.

kind에서 확인한 결과는 이렇습니다.

- search 줄: `web.svc.cluster.local svc.cluster.local cluster.local`
- `order-api`는 NXDOMAIN, `order-api.shop`은 ClusterIP로 풀렸습니다.
- 쿼터만 있을 때 Pod 생성은 `403 Forbidden`과 `failed quota: ... must specify requests.cpu` 계열 메시지로 거부됐고 LimitRange를 더하자 만들어졌습니다.
- 같은 쿼터에 걸린 Deployment는 만들어지고 ReplicaSet 이벤트에 `FailedCreate`가 남았습니다.

---

## 7. 오브젝트를 다루는 세 방식

<details>
<summary>기초부터: 명령형과 선언형은 무엇이 다른지</summary>

> **핵심 한 줄**: **명령형**은 매 순간 할 동작을 지시하고 **선언형**은 도착할 모습만 파일에 적어 `apply`가 지금 상태와 비교해 할 일을 정하게 합니다.

택시로 치면 "직진하다가 두 번째 신호에서 좌회전, 다음 골목에서 우회전"처럼 매 순간 할 일을 지시하는 쪽이 명령형이고 "시청역 3번 출구"처럼 도착할 곳만 말하는 쪽이 선언형입니다.

#### 1. 왜 구분하나

같은 일을 두 방식으로 할 수 있고 결과를 다시 만들 수 있는지가 달라집니다.

| 하고 싶은 일 | 명령형 | 선언형 |
|---|---|---|
| Deployment 만들기 | `kubectl create deployment web --image=nginx:1.27` | YAML에 적고 `kubectl apply -f web.yaml` |
| 3개를 5개로 | `kubectl scale deployment web --replicas=5` | 파일의 `replicas`를 5로 고치고 다시 `apply` |
| 이미지 바꾸기 | `kubectl set image deployment/web nginx=nginx:1.28` | 파일의 `image`를 고치고 다시 `apply` |

#### 2. 어떻게 동작하나

1. **명령형 명령**: 사람이 지금 상태를 알고 다음 동작을 고릅니다. 이미 있는 것을 `create`하면 "만들어라"라는 동작을 지시했기 때문에 `AlreadyExists`로 실패합니다.
2. **명령형 오브젝트 구성(`create -f`, `replace -f`)**: 파일을 쓰지만 동작은 여전히 사람이 고릅니다. 없는 객체에 `replace -f`를 하면 `NotFound`로 실패하니 매번 지금 클러스터에 그 객체가 있는지 먼저 알아야 합니다.
3. **선언형(`apply -f`)**: 최종 모습만 파일에 두고 `apply`가 없으면 만들고 있으면 파일과 달라진 부분만 반영합니다.

```text
apply -f web.yaml
  └─ 클러스터에 web 있음? ── 없음 → 생성
                         └─ 있음 → 파일과 다른 필드만 반영 → 같으면 변화 없음
```

몇 번을 실행해도 결과가 같은 이 성질을 멱등(idempotent)이라고 부릅니다. 자동화 스크립트와 Git 기반 배포가 apply를 쓰는 것도 이 성질 때문입니다.

#### 3. 한눈에 비교

| 구분 | 명령형 | 선언형 |
|---|---|---|
| 속도 | 빠름. 시험처럼 시간이 짧고 한 번 만들고 끝나는 작업에 맞음 | 파일을 써야 해서 처음엔 느림 |
| 기록 | 무엇을 했는지 남지 않아 다른 사람이 같은 상태를 재현하기 어려움 | 파일이 곧 기록. Git에 두면 변경 이력이 남고 리뷰와 되돌리기가 됨 |
| 같은 명령 반복 | `create`는 두 번째에 실패 | 같은 파일을 열 번 apply해도 결과가 같음 |
| 쓰는 곳 | 시험, 일회성 작업 | 운영 환경, Helm, Kustomize |

#### 4. 실전에서 보이는 모습

- 시험에서는 둘을 섞어 씁니다. 명령형 명령에 `--dry-run=client -o yaml`을 붙여 YAML 뼈대를 받고 필요한 필드를 고친 뒤 `apply`합니다(7-6절).
- 섞어 쓸 때 조심할 점은 하나입니다. `kubectl scale`처럼 명령으로 바꾼 값은 파일에 없으니 나중에 그 파일로 다시 apply하면 파일 값으로 돌아갑니다.

#### 5. 명령 한 줄로 안 되는 것과 시험에서 섞는 순서

명령형 명령은 플래그로 표현할 수 있는 만큼만 만듭니다. `kubectl run`은 컨테이너 하나짜리 Pod만 만들고 init 컨테이너나 볼륨 마운트를 넣는 플래그가 없습니다. 상황별로 고르는 방법은 이렇습니다.

| 상황 | 쓰는 방법 | 이유 |
|---|---|---|
| Pod, Deployment, Service를 새로 만듦 | `kubectl run`, `kubectl create`, `kubectl expose` | 몇 초면 끝남 |
| 이미 있는 객체의 이미지나 개수 같은 값 하나 | `kubectl set image`, `kubectl scale`, `kubectl edit` | 파일 없이 바로 반영 |
| init 컨테이너, 컨테이너 둘 이상, 볼륨 마운트 | `--dry-run=client -o yaml > file.yaml`로 뼈대 → 파일 수정 → `kubectl apply -f file.yaml` | 플래그로 표현할 수 없음. 틀려도 파일만 고쳐 다시 apply하면 됨 |

- `kubectl edit`은 실행 중인 객체를 메모리에서 바로 고치는 기능처럼 소개되곤 합니다. 실제로는 현재 객체를 임시 파일로 받아 편집기로 열고 저장할 때 API 서버에 보냅니다(7-3절). 실행 중인 Pod는 바꿀 수 있는 필드가 적어 대부분 거부됩니다(7-4절).
- 명령형 명령은 실행한 기록이 셸 히스토리에만 남습니다. 같은 상태를 다시 만들거나 남에게 넘기려면 `-o yaml`로 뽑아 파일로 둡니다.

> **정리**: 시험에서는 명령형으로 뼈대를 빨리 만들고 선언형으로 마무리하는 조합이 기본입니다. `kubectl scale`처럼 명령으로 바꾼 값은 그 파일로 다시 apply하면 파일 값으로 돌아간다는 점만 조심합니다. 세 방식의 공식 구분은 바로 아래 7-1절에 있습니다.

</details>

### 7-1. 세 방식 비교

Object Management 문서는 관리 방식을 셋으로 나눕니다.

| 방식 | 예 | 기록이 남는 곳 | 어울리는 상황 |
|---|---|---|---|
| 명령형 명령 | `kubectl create deployment`, `kubectl expose`, `kubectl scale` | 남지 않음 | 시험, 일회성 작업 |
| 명령형 오브젝트 구성 | `kubectl create -f`, `kubectl replace -f`, `kubectl delete -f` | 파일 | 파일로 관리하지만 매번 동작을 직접 정함 |
| 선언형 오브젝트 구성 | `kubectl apply -f <파일 또는 디렉터리>` | 파일과 객체의 어노테이션 | 운영, Git 기반 관리 |

명령형 오브젝트 구성은 동작을 사람이 고릅니다. 이미 있는 객체에 `create -f`를 하면 `AlreadyExists` 에러가 나고 없는 객체에 `replace -f`를 하면 `NotFound` 에러가 납니다. `apply`는 있으면 고치고 없으면 만듭니다.

### 7-2. apply의 3-way merge와 server-side apply

클라이언트 측 `kubectl apply`는 지난번에 적용한 내용을 객체의 `kubectl.kubernetes.io/last-applied-configuration` 어노테이션에 저장해 둡니다. 다음 apply 때 세 가지를 비교합니다.

```text
새 파일에 있는 필드                         → 라이브 객체에 설정
last-applied에 있었는데 새 파일에서 빠진 필드 → 삭제
어느 쪽에도 없던 필드(다른 주체가 넣은 값)   → 그대로 둠
```

세 번째 줄이 중요합니다. 컨트롤러가 채운 기본값이나 다른 도구가 붙인 어노테이션처럼 파일에 적은 적이 없는 필드는 apply가 건드리지 않습니다. 반대로 `kubectl create`로 만든 객체에는 이 어노테이션이 없어서 처음 apply할 때 경고가 나옵니다(어노테이션은 자동으로 붙음).

<details>
<summary>기초부터: 세 줄 규칙을 Deployment 하나로 따라가기</summary>

> **핵심 한 줄**: apply는 "지난번에 내가 적었던 것"과 "이번에 적은 것"을 비교해 내 몫만 고칩니다. 그래서 파일에 남아 있는 필드는 남이 바꿔 놔도 내 값으로 되돌립니다.

#### 1. 상황

`product-web` Deployment를 apply로 만들었고 그 뒤 HPA가 replicas를 5로 올렸습니다. 이번에 파일에서는 `team: shop` 라벨을 지우고 이미지를 바꿨습니다.

| 필드 | last-applied(지난 파일) | 이번 파일 | 라이브 객체 | apply 뒤 |
|---|---|---|---|---|
| `metadata.labels.team` | `shop` | 없음 | `shop` | 삭제(지난번엔 적었고 이번엔 뺐으니) |
| `spec.template...image` | `nginx:1.27` | `nginx:1.28` | `nginx:1.27` | `nginx:1.28` |
| `spec.replicas` | `3` | `3` | `5`(HPA가 바꿈) | `3`(파일에 있으니 파일 값) |
| `metadata.annotations["deployment.kubernetes.io/revision"]` | 없음 | 없음 | `1` | 그대로 둠(내가 적은 적 없음) |

#### 2. replicas 줄이 함정입니다

HPA는 `/scale` 서브리소스로 replicas를 바꾸므로 last-applied에는 여전히 3이 남아 있습니다. 파일에도 3이 있으니 apply는 "내가 원하는 값은 3"으로 읽고 5를 3으로 내립니다. 경고도 없습니다. LearnKube의 [Server-side apply 글](https://learnkube.com/server-side-apply-kubernetes)이 바로 이 예로 클라이언트 측 apply가 조용히 값을 되돌린다고 설명합니다.

HPA 문서도 HPA를 켠 Deployment는 매니페스트에서 `spec.replicas`를 빼라고 권합니다. 이때 한 번은 조심해야 합니다. last-applied에 있던 replicas를 파일에서 빼면 규칙 두 번째 줄대로 필드가 지워지고 기본값 1이 되어 Pod가 잠깐 하나로 줄어듭니다. 이 일회성 감소를 피하는 방법은 문서에 따로 나옵니다.

#### 3. server-side apply에서는

server-side apply는 필드마다 주인(`metadata.managedFields`)을 기록합니다. HPA 같은 다른 주체가 가진 필드를 내 파일이 다른 값으로 바꾸려 하면 조용히 덮지 않고 충돌로 거부하며 어떤 필드를 누가 가졌는지 알려 줍니다. 덮어쓸 생각이면 `--force-conflicts`, 아니면 파일에서 그 필드를 뺍니다.

> **정리**: 지난번에 적었고 이번에 뺀 필드는 지워집니다. 파일에 있는 필드는 파일 값으로 맞춰집니다. 한 번도 적지 않은 필드는 남습니다. 시험에서 라벨을 지웠는데 apply 뒤에도 남아 있다면 그 라벨이 last-applied에 없었던 경우입니다.

</details>

`kubectl apply --server-side`는 이 비교를 API 서버가 하고 다른 관리자가 소유한 필드를 바꾸려 하면 충돌로 거부합니다. 의도한 변경이면 `--force-conflicts`를 붙입니다.

### 7-3. kubectl edit은 임시 파일을 편집한다

`kubectl edit`은 이렇게 움직입니다.

1. 현재 객체를 받아 임시 파일로 만듭니다.
2. `KUBE_EDITOR` 또는 `EDITOR` 환경 변수의 편집기(리눅스 기본 vi)로 엽니다.
3. 저장하고 닫으면 그 내용을 API 서버에 보냅니다.

반영 중 에러가 나도 수정본은 사라지지 않습니다. kubectl edit 레퍼런스 기준으로 kubectl은 적용하지 못한 수정본을 담은 임시 파일을 디스크에 남깁니다. 경로는 운영체제의 임시 디렉터리 아래 `kubectl-edit-<임의 문자열>.yaml` 형태로 출력되고 리눅스인 시험 호스트에서는 `/tmp`입니다.

터미널에는 이 두 줄이 찍힙니다.

- `error: pods "..." is invalid`
- `A copy of your changes has been stored to "..."`

Forbidden의 상세 문구는 그 임시 파일 머리의 주석에 들어 있습니다.

### 7-4. 실행 중인 Pod에서 바꿀 수 있는 필드

Pod 스펙은 대부분 바꿀 수 없습니다. 바꿀 수 있는 것은 이 정도입니다.

- `spec.containers[*].image`, `spec.initContainers[*].image`
- `spec.activeDeadlineSeconds`
- `spec.terminationGracePeriodSeconds`(이전 값이 음수였을 때 1로 바꾸는 경우만)
- `spec.tolerations`(추가만)

그 밖의 필드, 예를 들어 환경 변수나 포트, 볼륨을 `kubectl edit pod`로 바꾸면 `pod updates may not change fields other than ...`로 시작하는 Forbidden 에러가 납니다.

`terminationGracePeriodSeconds`는 목록에 있어도 헷갈리기 쉽습니다. v1.37 API 서버의 오류 문구에도 `` `spec.terminationGracePeriodSeconds` (allow it to be set to 1 if it was previously negative) ``로 적혀 있어 양수 값을 다른 양수로 바꾸는 것은 거부됩니다.

거부됐을 때의 절차는 이렇습니다.

```bash
kubectl edit pod order-api -n shop
# 저장 → 거부 → 편집기를 닫으면 /tmp/kubectl-edit-xxxx.yaml 경로가 출력됨

kubectl replace --force -f /tmp/kubectl-edit-xxxx.yaml
# 기존 Pod를 지우고 수정본으로 다시 만듦
```

`replace --force`는 삭제 후 재생성이라 Pod IP가 바뀌고 잠시 서비스가 끊깁니다.

Deployment에 속한 Pod라면 이 방법을 쓰지 말고 Deployment의 템플릿을 고칩니다. Deployment 소유 Pod에 `replace --force`를 하면 다시 만든 Pod도 같은 라벨이라 ReplicaSet이 개수 초과로 보고 그 Pod를 지웁니다(kind에서 확인).

CPU와 메모리는 예외입니다. requests, limits는 v1.35에서 GA가 된 in-place resize로 `resize` 서브리소스를 통해 Pod를 다시 만들지 않고 바꿀 수 있습니다(`kubectl patch pod ... --subresource resize`). 자세한 사용법은 [6편](/blog/cert/cka/cka-03-workloads-scheduling)에 있습니다.

### 7-5. -n과 파일의 namespace가 다를 때

네임스페이스는 이 순서로 정해집니다.

| 상황 | 결과 |
|---|---|
| 파일에 `metadata.namespace` 있음, `-n` 없음 | 파일 값 사용. kubeconfig 컨텍스트의 기본 네임스페이스보다 우선 |
| 파일에 없음 | `-n` 값 → 컨텍스트 기본 네임스페이스 → `default` 순서 |
| 파일에 있고 `-n`도 있는데 값이 다름 | 에러 |

세 번째 경우의 메시지는 이런 형태입니다.

```text
error: the namespace from the provided object "shop" does not match the namespace "web". You must pass '--namespace=shop' to perform this operation.
```

시험에서는 문제마다 지정한 네임스페이스가 다르니 한 가지 방식으로 통일합니다. YAML에 `namespace:`를 적었으면 `-n`을 빼고 적지 않았으면 `-n`을 붙입니다.

### 7-6. 시험에서 쓰는 뼈대 명령

YAML을 처음부터 쓰지 않고 명령형 명령으로 뼈대를 뽑아 고칩니다. `--dry-run=client`는 서버에 보내지 않고 객체만 만들고 `-o yaml`이 그 객체를 출력합니다. 값 없이 `--dry-run`만 쓰는 옛 형식은 폐기되었습니다.

```bash
# Pod 뼈대
kubectl run order-api --image=nginx:1.27 -n shop --dry-run=client -o yaml > pod.yaml

# Deployment 뼈대 (replicas 포함)
kubectl create deployment product-web --image=nginx:1.27 --replicas=3 -n shop \
  --dry-run=client -o yaml > deploy.yaml

# 이미 있는 Deployment에 ClusterIP Service 붙이기 (selector를 그대로 가져옴)
kubectl expose deployment product-web --port=80 --target-port=80 -n shop

# Pod와 같은 이름의 ClusterIP Service를 한 번에
kubectl run order-api --image=nginx:1.27 --port=80 --expose -n shop

# 필드 설명 찾기
kubectl explain deployment.spec.strategy.rollingUpdate
kubectl explain pod.spec.containers.resources --recursive | head -30
```

Service를 만드는 두 명령은 selector를 정하는 방식이 다릅니다.

| 명령 | selector | 결과 |
|---|---|---|
| `kubectl expose` | 대상 리소스의 selector를 그대로 씀 | 대상과 맞음 |
| `kubectl create service` | `app=<Service 이름>`으로 고정 | Pod 라벨이 다르면 엔드포인트가 빔 |

그래서 대상이 이미 있으면 `expose`가 안전합니다.

`--dry-run=server`는 API 서버까지 보내 어드미션과 검증을 거치게 하고 저장만 하지 않습니다. 쿼터나 selector 불일치를 미리 확인할 때 씁니다.

### 7-7. 직접 해 보기

1. `kubectl create deployment`로 만든 객체에 `last-applied-configuration`이 없는지 봅니다.
2. 같은 내용을 `apply`해서 경고와 어노테이션이 생기는지 확인합니다.
3. 파일에서 라벨 하나를 지우고 다시 apply해 라이브 객체에서도 지워지는지 봅니다.
4. `kubectl edit pod`로 환경 변수를 추가해 거부되는 과정을 따라가고 남은 임시 파일로 `replace --force`를 실행합니다.

---

## 확인 문제

1. `kubectl run order-api --image=nginx:1.27`이 `pod/order-api created`를 출력했습니다. 이 시점에 확정된 것과 아직 일어나지 않았을 수 있는 것을 하나씩 고르세요.

<details>
<summary>정답</summary>

확정된 것은 API 서버의 인증, 인가, 어드미션, 스키마 검증을 통과해 etcd에 저장되었다는 사실입니다. 노드 배정(스케줄링)과 컨테이너 시작은 아직 일어나지 않았을 수 있습니다. 응답은 etcd 저장 직후에 돌아오고 `spec.nodeName`은 그때 비어 있습니다.

</details>

2. 파일 기반으로 만든 Pod에 ResourceQuota가 걸려 생성이 거부되었습니다. 이 거부는 API 서버의 어느 단계에서 일어났고 HTTP 상태 코드는 무엇일까요? 같은 쿼터에 걸린 Deployment는 `kubectl create`가 성공하는 이유도 설명하세요.

<details>
<summary>정답</summary>

검증 어드미션 단계의 `ResourceQuota` 플러그인이 거부하고 403 Forbidden이 돌아옵니다. CPU, 메모리 쿼터는 Pod가 만들어질 때 계산되므로 Deployment 객체를 만드는 요청은 통과합니다. 그래서 Deployment와 ReplicaSet은 만들어지고 ReplicaSet 컨트롤러가 Pod를 만들 때 거부됩니다. 기록은 `kubectl describe rs`의 Events에서 봅니다.

</details>

3. 스케줄러 Pod가 멈춘 클러스터에서 `payment-check` Pod를 `node01`에 바로 띄워야 합니다. 어떤 필드를 쓰고 그 Pod는 어드미션을 거치는지, 노드 자원이 모자라면 어떻게 되는지 답하세요.

<details>
<summary>정답</summary>

`spec.nodeName: node01`을 적습니다. 스케줄러는 건너뛰지만 API 서버의 인증, 인가, 어드미션은 그대로 거칩니다. 스케줄러의 Filter를 거치지 않았으니 자원이 모자라면 kubelet이 거부하고 Pod는 `OutOfcpu`나 `OutOfmemory` 같은 reason으로 `Failed`가 됩니다.

</details>

4. `app=product-web` 라벨을 단 단독 Pod가 2개 있는 네임스페이스에 selector가 `app: product-web`이고 replicas가 3인 ReplicaSet을 만들면 Pod는 몇 개가 새로 생기나요?

<details>
<summary>정답</summary>

1개입니다. 주인 없는 Pod 2개가 selector에 맞아 ReplicaSet에 입양되고 부족한 1개만 새로 만들어집니다. `kubectl get pod -o jsonpath='{.items[*].metadata.ownerReferences[0].name}'`으로 세 Pod 모두 그 ReplicaSet을 주인으로 가리키는지 확인합니다.

</details>

5. Deployment `order-api`에 다음 순서로 작업했습니다. `rollout history`에 보이는 리비전은 몇 개일까요? (1) 생성 (2) `kubectl scale --replicas=5` (3) `kubectl set image ... nginx=nginx:1.28` (4) `kubectl label deploy order-api team=checkout`

<details>
<summary>정답</summary>

2개입니다. 리비전은 Pod 템플릿(`.spec.template`)이 바뀔 때만 생깁니다. (1) 생성이 리비전 1, (3) 이미지 변경이 리비전 2입니다. (2) replicas 변경과 (4) Deployment 객체 자체의 라벨 변경은 템플릿 밖이라 리비전을 만들지 않습니다.

</details>

6. kube-apiserver가 계속 재시작하고 로그에 etcd 연결 TLS 에러가 남습니다. 매니페스트에서 가장 먼저 볼 플래그 세 개와 각각이 가리켜야 할 kubeadm 기본 파일을 적으세요.

<details>
<summary>정답</summary>

`--etcd-cafile=/etc/kubernetes/pki/etcd/ca.crt`, `--etcd-certfile=/etc/kubernetes/pki/apiserver-etcd-client.crt`, `--etcd-keyfile=/etc/kubernetes/pki/apiserver-etcd-client.key`입니다. 이 연결에서 API 서버는 etcd의 클라이언트입니다. `--etcd-cafile`이 클러스터 CA(`/etc/kubernetes/pki/ca.crt`)를 가리키도록 바뀌어 있는 경우가 흔한 장애입니다. 매니페스트를 고치면 kubelet이 static Pod를 다시 만듭니다.

</details>

7. 단독 Pod `order-api`에 환경 변수 하나를 추가하라는 과제입니다. `kubectl edit pod`로 저장했더니 거부되었습니다. 가장 빠른 다음 동작은 무엇입니까?

<details>
<summary>정답</summary>

환경 변수는 실행 중인 Pod에서 바꿀 수 없는 필드라 Forbidden으로 거부됩니다. 편집기를 닫으면 수정본이 담긴 `/tmp/kubectl-edit-<임의 문자열>.yaml` 경로가 출력되므로 `kubectl replace --force -f <그 파일>`로 Pod를 지우고 수정본으로 다시 만듭니다. Pod IP는 바뀝니다. Deployment에 속한 Pod였다면 Deployment의 템플릿을 고칩니다.

</details>

## 범위와 한계

- 명령과 YAML, 오류 문구는 kind v1.37 클러스터에서 2026년 10월에 직접 돌려 확인했습니다. kubeadm 기본 인증서 경로와 `kubeadm certs check-expiration`은 kind에서 돌리지 않았고 kubeadm 문서 기준입니다.
- 1-2절 표의 응답 코드는 kind에서 `kubectl -v=6`의 `status=` 값으로 확인했습니다. 서드파티 웹훅은 응답에 코드를 직접 넣을 수 있어 다를 수 있습니다.
- Endpoints deprecated(v1.33), taint-eviction 컨트롤러 분리(1.29 beta, 1.34 GA), IPVS deprecated(v1.35), in-place resize GA(v1.35)는 버전에 따라 달라지는 항목입니다.
- 확인 문제는 제가 만든 것이고 실제 시험 문항과 관계없습니다.

## 참고 자료

공식 문서
- CNCF, [CKA Curriculum v1.37](https://github.com/cncf/curriculum/blob/master/CKA_Curriculum_v1.37.pdf)
- Kubernetes, [Kubernetes Components](https://kubernetes.io/docs/concepts/overview/components/), [Controllers](https://kubernetes.io/docs/concepts/architecture/controller/), [Leases](https://kubernetes.io/docs/concepts/architecture/leases/)
- Kubernetes, [Controlling Access to the Kubernetes API](https://kubernetes.io/docs/concepts/security/controlling-access/), [Admission Control in Kubernetes](https://kubernetes.io/docs/reference/access-authn-authz/admission-controllers/)
- Kubernetes, [Assigning Pods to Nodes](https://kubernetes.io/docs/concepts/scheduling-eviction/assign-pod-node/), [Taints and Tolerations](https://kubernetes.io/docs/concepts/scheduling-eviction/taint-and-toleration/)
- Kubernetes, [kube-apiserver](https://kubernetes.io/docs/reference/command-line-tools-reference/kube-apiserver/), [kube-controller-manager](https://kubernetes.io/docs/reference/command-line-tools-reference/kube-controller-manager/), [kubelet](https://kubernetes.io/docs/reference/command-line-tools-reference/kubelet/), [Virtual IPs and Service Proxies](https://kubernetes.io/docs/reference/networking/virtual-ips/)
- Kubernetes Blog, [Decoupled Taint Manager Is Now Stable (v1.34)](https://kubernetes.io/blog/2025/09/15/kubernetes-v1-34-decoupled-taint-manager-is-now-stable/), [Endpoints deprecation](https://kubernetes.io/blog/2025/04/24/endpoints-deprecation/), [Kubernetes v1.37 릴리스](https://kubernetes.io/blog/2026/08/26/kubernetes-v1-37-release/)(ipvs 일정)
- Kubernetes, [PKI certificates and requirements](https://kubernetes.io/docs/setup/best-practices/certificates/), [Certificate Management with kubeadm](https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/kubeadm-certs/)
- Kubernetes, [Pod Lifecycle](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/), [Sidecar Containers](https://kubernetes.io/docs/concepts/workloads/pods/sidecar-containers/), [The Kubernetes network model](https://kubernetes.io/docs/concepts/services-networking/#the-kubernetes-network-model)
- Kubernetes, [ReplicationController](https://kubernetes.io/docs/concepts/workloads/controllers/replicationcontroller/), [ReplicaSet](https://kubernetes.io/docs/concepts/workloads/controllers/replicaset/), [Deployments](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/)
- Kubernetes, [Service](https://kubernetes.io/docs/concepts/services-networking/service/), [DNS for Services and Pods](https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/), [Namespaces](https://kubernetes.io/docs/concepts/overview/working-with-objects/namespaces/), [Resource Quotas](https://kubernetes.io/docs/concepts/policy/resource-quotas/), [Limit Ranges](https://kubernetes.io/docs/concepts/policy/limit-range/)
- Kubernetes, [Kubernetes Object Management](https://kubernetes.io/docs/concepts/overview/working-with-objects/object-management/), [Declarative Management](https://kubernetes.io/docs/tasks/manage-kubernetes-objects/declarative-config/)
- Kubernetes, [kubectl edit](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_edit/), [kubectl apply](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_apply/), [kubectl scale](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_scale/), [kubectl run](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_run/), [kubectl expose](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_expose/)
- Kubernetes, [kube-scheduler Configuration (v1)](https://kubernetes.io/docs/reference/config-api/kube-scheduler-config.v1/)(NodeResourcesFit 기본 전략 LeastAllocated), [Horizontal Pod Autoscaling](https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/)(HPA를 쓸 때 매니페스트에서 replicas 빼기)

기술 블로그
- Jamie Hannaford, [What happens when ... Kubernetes edition!](https://github.com/jamiehannaford/what-happens-when-k8s)(1-1절 흐름 참고. 쿠버네티스 1.8 무렵 내용이라 kubectl run, Initializers, Docker 부분은 옛 동작)
- Chiara Salvatore, LearnKube, [Server-side apply: what happens when you run kubectl apply](https://learnkube.com/server-side-apply-kubernetes)(7-2절 replicas 되돌림 예)

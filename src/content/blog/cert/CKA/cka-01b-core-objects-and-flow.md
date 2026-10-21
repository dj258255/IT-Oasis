---
title: '[CKA Ch-01.5] 기본 오브젝트와 컨트롤 플레인: kubectl 한 줄이 Pod가 되기까지'
description: kubectl run 한 줄이 API 서버의 인증, 인가, 어드미션, 스키마 검증을 지나 etcd에 저장되고 스케줄러와 kubelet의 watch를 거쳐 Running이 되는 경로를 따라갑니다. 그 길에서 만나는 컨트롤 플레인 구성요소와 인증서 방향, Pod와 ReplicaSet, Deployment, Service, Namespace, 그리고 명령형과 선언형 관리 방식을 공식 문서 기준으로 정리했습니다.
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
draft: false
series: "CKA 공부"
seriesOrder: 1.5
---

## 결론부터

1. `kubectl run` 한 줄은 API 서버 안에서 인증(실패 시 401), 인가(실패 시 403), 변형 어드미션, 스키마 검증, 검증 어드미션을 차례로 지나 etcd에 저장됩니다. 이때 `spec.nodeName`은 비어 있고 kubectl은 이 시점에 응답을 받고 끝납니다. 노드를 고르고 컨테이너를 띄우는 일은 그 뒤에 스케줄러와 kubelet이 각자 watch로 알아채서 합니다.
2. etcd와 직접 통신하는 구성요소는 kube-apiserver 하나뿐입니다. 스케줄러, 컨트롤러 매니저, kubelet, kube-proxy는 모두 API 서버의 클라이언트로 붙고 각자 kubeconfig의 클라이언트 인증서로 자신을 증명합니다.
3. `kubectl get pod`의 STATUS 열에 보이는 `ContainerCreating`, `CrashLoopBackOff`는 Pod phase가 아닙니다. 컨테이너 상태 `Waiting`의 reason이고 그동안 phase는 각각 `Pending`, 대개 `Running`입니다. phase는 Pending, Running, Succeeded, Failed, Unknown 다섯 가지뿐입니다.
4. ReplicaSet은 selector에 맞는 주인 없는 Pod를 자기 것으로 입양합니다. Deployment는 Pod 템플릿이 바뀔 때만 새 리비전을 만들고 레플리카 수 변경은 리비전을 만들지 않습니다.
5. 실행 중인 Pod는 이미지, `activeDeadlineSeconds`, 톨러레이션 추가 정도만 고칠 수 있습니다(`terminationGracePeriodSeconds`는 이전 값이 음수였을 때 1로 바꾸는 경우만 허용). `kubectl edit`이 거부되면 수정본이 임시 디렉터리(리눅스는 `/tmp`)의 `kubectl-edit-*.yaml`에 남으니 그 파일로 `kubectl replace --force -f`를 실행합니다.

이 글은 [CKA Ch-01](/blog/cert/cka/cka-01-why-kubernetes)과 [CKA Ch-02](/blog/cert/cka/cka-02-cluster-architecture) 사이에 들어가는 기초 편입니다. RBAC, kubeadm 설치와 업그레이드, 인증서 갱신 절차는 Ch-02에, 롤링 업데이트 명령과 프로브, 사이드카, 스케줄링 세부는 [CKA Ch-03](/blog/cert/cka/cka-03-workloads-scheduling)에, Service 타입과 EndpointSlice, Gateway API는 [CKA Ch-04](/blog/cert/cka/cka-04-services-networking)에, static Pod와 구성요소 장애 대응은 [CKA Ch-06](/blog/cert/cka/cka-06-troubleshooting)에 자세히 적었습니다. 여기서는 그 글들이 전제로 깔고 있는 흐름과 용어를 한 번에 잡습니다.

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

kubectl이 `pod/order-api created`를 출력한 순간에는 아직 노드도 정해지지 않았습니다. 그래서 명령이 성공했는데 Pod가 `Pending`에 남는 일이 생깁니다. API 서버의 관문은 통과했고 스케줄러나 kubelet 쪽에서 멈춘 경우입니다.

### 1-2. API 서버 안의 다섯 관문

| 단계 | 하는 일 | 실패할 때 | 시험에서 만나는 예 |
|---|---|---|---|
| 인증 | 클라이언트 인증서, 베어러 토큰(ServiceAccount 토큰 포함) 등으로 사용자 확인 | 401 | kubeconfig의 인증서 경로 오류, 만료된 인증서 |
| 인가 | 기본 모드 `Node,RBAC`로 이 사용자가 이 동작을 해도 되는지 판단 | 403 | `kubectl auth can-i`로 확인하는 RBAC 문제 |
| 변형 어드미션 | 요청 객체를 고침 | 403 등 거부 응답 | `DefaultTolerationSeconds`가 300초 톨러레이션 추가, `LimitRanger`가 기본 requests 주입 |
| 스키마 검증 | 객체가 API 스키마에 맞는지 확인 | 422 Invalid | 오타 난 필드, selector와 템플릿 라벨 불일치 |
| 검증 어드미션 | 정책 위반이면 거부만 함 | 403 등 | `ResourceQuota` 초과, PodSecurity 위반 |

Admission Control 문서의 순서대로 적으면 변형 어드미션이 먼저 돌고 객체 스키마 검증이 그다음, 검증 어드미션이 마지막입니다. 검증 어드미션이 뒤에 오는 이유는 앞 단계가 고친 최종 객체를 보고 판단해야 하기 때문입니다. 어드미션은 쓰기 요청(create, update, delete, connect)에만 적용되고 get, list, watch 같은 읽기 요청에는 적용되지 않습니다.

CPU, 메모리, Pod 수 쿼터에 걸리는 Deployment도 `kubectl create`는 성공합니다. 이 쿼터는 Pod가 만들어질 때 계산되므로 거부는 ReplicaSet 컨트롤러가 Pod를 만들려 할 때 일어나고 기록은 `kubectl describe rs`의 Events에 남습니다.

### 1-3. 스케줄러가 노드를 고르는 방식

스케줄러는 `spec.nodeName`이 비어 있는 Pod를 watch해서 큐에 넣고 한 번에 하나씩 노드를 정합니다. 두 단계로 나뉩니다.

- Filter: 이 Pod를 받을 수 없는 노드를 지웁니다. 남은 CPU와 메모리가 requests보다 작은 노드, 견디지 못하는 테인트가 있는 노드, nodeSelector나 어피니티에 맞지 않는 노드가 여기서 빠집니다.
- Score: 남은 노드에 점수를 매겨 가장 높은 노드를 고릅니다. 이미지가 이미 받아져 있는 노드에 점수를 더 주는 `ImageLocality`가 Score 플러그인의 예입니다.

노드를 정하면 기본 플러그인 `DefaultBinder`가 `pods/<이름>/binding` 서브리소스에 Binding 객체를 POST합니다. API 서버가 그 결과로 Pod의 `spec.nodeName`을 채웁니다. 스케줄러가 Pod 객체를 직접 고치는 구조는 아닙니다. 걸러 낼 노드만 있고 남는 노드가 없으면 Pod는 `Pending`에 머물고 `describe pod`의 Events에 `FailedScheduling`과 이유가 남습니다.

### 1-4. kubelet이 컨테이너를 띄우고 상태를 보고하는 방식

kubelet은 `spec.nodeName=<자기 노드 이름>` 필드 셀렉터로 자기 노드의 Pod만 골라 watch합니다. 자기 노드에 배정된 Pod가 생기면 CRI로 containerd 같은 런타임을 호출합니다. 순서는 Pod 샌드박스(네트워크 네임스페이스를 잡는 pause 컨테이너)를 만들고 CNI로 IP를 받은 뒤 이미지를 받고 컨테이너를 시작하는 흐름입니다. 결과는 `pods/<이름>/status` 서브리소스로 API 서버에 올립니다. `kubectl get pod -o wide`의 IP와 NODE 열은 이렇게 채워집니다.

pause 컨테이너와 네임스페이스 공유는 CKA 부록의 [네임스페이스와 pause 글](/blog/cert/cka/k8s-linux-02-namespaces-pause)에서 커널 쪽으로 따라갑니다.

### 1-5. watch와 resourceVersion

스케줄러와 kubelet이 Pod 생성을 알아채는 장치가 watch입니다. 클라이언트가 `?watch=true`로 요청하면 API 서버가 연결을 열어 두고 ADDED, MODIFIED, DELETED 이벤트를 흘려보냅니다. 모든 객체에는 `metadata.resourceVersion`이 있고 클라이언트는 마지막으로 본 값부터 watch를 이어 갑니다.

API Concepts 문서의 "Efficient detection of changes" 절이 적은 재연결 규칙은 이렇습니다.

1. 처음에는 list로 전체 목록과 그 시점의 resourceVersion을 받습니다.
2. 그 resourceVersion부터 watch를 엽니다.
3. 연결이 끊기면 마지막으로 받은 resourceVersion부터 다시 watch합니다.
4. 그 버전이 etcd compaction으로 이미 지워졌으면 서버가 `410 Gone`을 돌려줍니다. 클라이언트는 캐시를 버리고 1번부터 다시 list합니다.

클라이언트 라이브러리의 informer가 이 list-watch를 대신 해 줍니다. bookmark 이벤트는 변화가 없을 때도 최신 resourceVersion을 알려 주어 재연결 시 410 Gone을 덜 만나게 하는 장치입니다.

### 1-6. 컨트롤러의 reconcile: Deployment가 Pod 세 개가 되는 경로

watch 스트림 자체는 "무엇이 바뀌었다"는 이벤트를 보내는 구조입니다. 이벤트를 놓쳐도 결과가 맞아떨어지는 이유는 그 위에서 도는 컨트롤러의 방식에 있습니다. Controllers 문서는 컨트롤러를 원하는 상태(spec)와 현재 상태(status)를 비교해 차이를 줄이는 제어 루프로 설명합니다. 이벤트는 "다시 계산해 볼 때가 됐다"는 신호로만 쓰고 매번 전체 상태의 차이를 새로 계산합니다. 이런 방식을 level-triggered라고 부릅니다.

`kubectl create deployment order-api --image=nginx:1.27 --replicas=3 -n shop`의 경로는 이렇게 이어집니다.

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

Pod 하나를 `kubectl delete`로 지워도 곧바로 새 이름의 Pod가 생기는 이유가 마지막 줄입니다. 삭제 이벤트는 계기일 뿐이고 컨트롤러는 지금 개수와 원하는 개수를 다시 비교해 모자란 만큼 만듭니다.

### 1-7. 직접 해 보기

kind 클러스터에서 한쪽 터미널에 `kubectl get pods -n shop -w -o wide`를 띄우고 다른 쪽에서 `kubectl run`을 실행합니다. NODE 열이 `<none>`에서 노드 이름으로, STATUS가 `Pending`에서 `Running`으로 바뀌는 순서를 적습니다. `kubectl get --raw "/api/v1/namespaces/shop/pods?watch=true"`를 띄운 채 Pod를 지워 이벤트의 `type`과 `resourceVersion`도 확인합니다.

---

## 2. 컨트롤 플레인 구성요소의 역할

### 2-1. 한눈에 보는 표

Kubernetes Components 문서와 각 구성요소의 명령줄 레퍼런스를 기준으로 했습니다. "kubeadm에서 도는 방식" 열은 kubeadm 클러스터 기준입니다.

| 구성요소 | 맡은 일 | kubeadm에서 도는 방식 | 기본 포트 |
|---|---|---|---|
| kube-apiserver | 모든 요청의 입구. 인증, 인가, 어드미션, 검증, watch 제공. etcd와 직접 통신하는 유일한 구성요소 | static Pod | 6443 |
| etcd | 클러스터 상태를 저장하는 키-값 저장소 | static Pod | 2379(클라이언트), 2380(피어) |
| kube-scheduler | `nodeName`이 빈 Pod에 노드를 정함 | static Pod | 10259 |
| kube-controller-manager | 여러 컨트롤러를 한 프로세스로 묶어 실행 | static Pod | 10257 |
| kubelet | 노드에서 Pod를 실제로 실행하고 상태 보고 | systemd 서비스 | 10250 |
| kube-proxy | Service용 iptables/nftables/IPVS 규칙 관리 | DaemonSet | (규칙만 관리) |

### 2-2. kube-apiserver

API 서버를 "etcd 앞의 얇은 문"으로 보면 시험 문제를 풀 때 판단이 어긋납니다. 1장에서 본 인증, 인가, 어드미션, 스키마 검증 외에도 API 버전 사이 변환, watch 캐시, ServiceAccount 토큰 발급을 맡습니다. 다른 구성요소는 모두 API 서버를 거쳐서만 상태를 읽고 씁니다. 그래서 API 서버가 멈추면 `kubectl`이 전부 실패하고 스케줄링과 컨트롤러 동작도 같이 멈춥니다. 이미 떠 있는 Pod는 kubelet이 계속 돌립니다.

### 2-3. etcd

etcd는 Raft 합의를 쓰는 분산 키-값 저장소입니다. kubeadm 기본 구성(stacked)에서는 컨트롤 플레인 노드마다 static Pod로 돌고 데이터는 hostPath `/var/lib/etcd`에 있습니다. 외부 etcd를 쓰는 클러스터라면 `kube-apiserver.yaml`의 `--etcd-servers`를 보면 위치가 나옵니다. 백업과 복구는 [CKA Ch-02](/blog/cert/cka/cka-02-cluster-architecture)의 etcd 절에 정리했습니다.

### 2-4. kube-scheduler와 확장 포인트

Scheduling Framework 문서는 스케줄러를 플러그인이 끼어드는 확장 포인트의 연속으로 설명합니다. 순서대로 나열합니다.

| 구간 | 확장 포인트 |
|---|---|
| 큐에 넣기 | PreEnqueue, QueueSort |
| 스케줄링 사이클(Pod 하나씩 직렬) | PreFilter, Filter, PostFilter, PreScore, Score, NormalizeScore, Reserve(실패 시 Unreserve), Permit |
| 바인딩 사이클(여러 Pod 병렬) | PreBind, Bind, PostBind |

PostFilter는 Filter를 통과한 노드가 하나도 없을 때만 돌고 대표 예가 우선순위 기반 선점(preemption)입니다. 시험에서는 Filter와 Score의 구분, 그리고 바인딩이 별도 단계라는 점이면 충분합니다.

`spec.nodeName`을 직접 적은 Pod는 스케줄러를 건너뜁니다. 이미 노드가 정해져 있으니 스케줄러의 watch 조건에 걸리지 않고 해당 노드의 kubelet이 바로 받습니다. API 서버의 인증, 인가, 어드미션은 그대로 거칩니다. Assigning Pods to Nodes 문서가 적은 차이가 하나 더 있습니다. 스케줄러의 Filter를 거치지 않았으니 노드에 자원이 모자라면 kubelet이 Pod를 거부하고 Pod는 `OutOfcpu` 같은 reason과 함께 곧바로 `Failed`가 됩니다. 스케줄러가 죽었을 때 Pod를 특정 노드에 띄우는 방법으로도 쓰입니다.

### 2-5. kube-controller-manager

컨트롤러 매니저는 컨트롤러 수십 개를 한 바이너리에 담은 것입니다. kube-controller-manager 레퍼런스의 `--controllers` 기본값은 `*`(기본 비활성인 bootstrap-signer, token-cleaner, selinux-warning을 뺀 전부)입니다. 이 글의 흐름과 맞닿는 컨트롤러만 고르면 이렇습니다.

| 컨트롤러 | 하는 일 |
|---|---|
| deployment-controller | Deployment에 맞는 ReplicaSet을 만들고 롤아웃 진행 |
| replicaset-controller | ReplicaSet의 Pod 수를 replicas에 맞춤 |
| endpointslice-controller | Service selector에 맞는 Pod로 EndpointSlice를 만듦. kube-proxy가 이것을 봄 |
| endpoints-controller | 옛 v1 Endpoints 객체 유지. Endpoints API는 v1.33부터 deprecated |
| node-lifecycle-controller | 노드 하트비트가 끊기면 NotReady/Unknown 표시와 `unreachable`, `not-ready` NoExecute 테인트 부착 |
| taint-eviction-controller | NoExecute 테인트를 견디지 못하는 Pod를 삭제. v1.34에서 노드 수명주기 컨트롤러와 분리되어 GA |

v1.33 이상에서 Endpoints 객체를 조회하면 `v1 Endpoints is deprecated in v1.33+; use discovery.k8s.io/v1 EndpointSlice` 경고가 붙습니다. Service 디버깅은 `kubectl get endpointslices -l kubernetes.io/service-name=<svc>`로 익혀 둡니다.

노드가 죽으면 node-lifecycle-controller가 `--node-monitor-grace-period`(현재 기본 50초, 옛 자료는 40초) 뒤에 테인트를 붙입니다. Pod에 들어 있는 300초 톨러레이션은 Pod 생성 때 `DefaultTolerationSeconds` 어드미션 플러그인이 넣은 값입니다. 그 시간이 지나면 taint-eviction-controller가 Pod를 지우고 ReplicaSet 컨트롤러가 다른 노드에 새로 만듭니다. 주인 없는 단독 Pod는 그대로 사라집니다.

두 가지 플래그를 더 알아 둡니다.

- `--leader-elect`(기본 true): 컨트롤 플레인이 여러 대면 컨트롤러 매니저도 여러 개 뜨지만 일은 리더 하나만 합니다. 리더는 `kube-system`의 Lease 객체로 정합니다. 스케줄러도 같은 방식입니다. `kubectl -n kube-system get lease`로 `kube-controller-manager`, `kube-scheduler` Lease의 HOLDER를 보면 지금 리더가 어느 노드인지 나옵니다.
- `--use-service-account-credentials`: true면 컨트롤러마다 `kube-system`의 개별 ServiceAccount 자격 증명으로 API를 호출합니다. 컨트롤러별로 RBAC 권한을 나눌 수 있게 됩니다. kubeadm은 이 값을 true로 둡니다.

### 2-6. kubelet

kubelet은 노드 등록, Pod 실행(CRI 호출), 프로브 실행, 볼륨 마운트, 자원 사용량 보고, 노드 압박 시 축출, 하트비트를 맡습니다. 하트비트는 두 갈래입니다. Node 객체의 status 갱신과 `kube-node-lease` 네임스페이스에 노드마다 하나씩 있는 Lease 갱신입니다.

kubeadm 클러스터에서 kubelet은 컨테이너로 돌지 않는 유일한 쿠버네티스 구성요소입니다. 컨트롤 플레인은 static Pod이고 kube-proxy는 DaemonSet인데 kubelet은 systemd 서비스입니다. static Pod를 띄우는 주체가 kubelet이니 kubelet 자신은 그 바깥에 있어야 합니다. 이 설명은 kubeadm 기준입니다. 컨트롤 플레인을 systemd 서비스로 띄우는 설치 방식도 있고 k3s는 구성요소를 한 프로세스로 묶으며 kind는 kubelet을 노드 역할의 컨테이너 안에서 돌립니다.

kubeadm 기준 설정 파일은 `/var/lib/kubelet/config.yaml`(여기서 `staticPodPath` 확인)이고 API 서버 접속용 kubeconfig는 `/etc/kubernetes/kubelet.conf`입니다. kubelet이 멈춘 노드의 증상과 복구 순서, static Pod 매니페스트 백업 위치 같은 실전 내용은 [CKA Ch-06](/blog/cert/cka/cka-06-troubleshooting)의 클러스터 구성요소 장에 있습니다.

### 2-7. kube-proxy

kube-proxy는 규칙 관리자입니다. EndpointSlice와 Service를 watch해서 노드 커널의 netfilter나 IPVS 규칙을 고치고 실제 패킷은 커널이 처리합니다. 프로세스가 패킷을 중계하던 userspace 모드는 v1.26에서 제거되었습니다. Virtual IPs 문서와 KEP 기준 모드 현황은 이렇습니다.

| 모드 | 상태 |
|---|---|
| `iptables` | 리눅스 기본값. 문서는 앞으로 기본값이 nftables로 바뀔 예정이니 모드를 명시하라고 권함 |
| `nftables` | v1.33 GA |
| `ipvs` | v1.35 deprecated(KEP-5495). 제거 버전은 미정 |

eBPF로 Service를 처리하는 것은 Cilium 같은 CNI의 kube-proxy 대체 기능이고 그런 CNI를 쓰면 kube-proxy를 아예 설치하지 않기도 합니다(`kubeadm init --skip-phases=addon/kube-proxy`). kubeadm 클러스터에서는 `kube-system`에 DaemonSet과 ConfigMap `kube-proxy`가 있고 ConfigMap을 고친 뒤에는 `kubectl -n kube-system rollout restart ds kube-proxy`로 다시 띄웁니다. iptables 규칙이 커널에서 어떻게 패킷을 바꾸는지는 [Service와 iptables, conntrack 글](/blog/cert/cka/k8s-linux-05-service-iptables-conntrack)에서 다룹니다.

### 2-8. 직접 해 보기

kind 컨트롤 플레인 노드 컨테이너에서 `ls /etc/kubernetes/manifests`로 static Pod 네 개를 확인하고 `kube-controller-manager.yaml`에서 `--leader-elect`, `--use-service-account-credentials` 값을 찾습니다. `kubectl -n kube-system get lease`로 리더를, `kubectl -n kube-system get cm kube-proxy -o yaml | grep mode`로 kube-proxy 모드를 적습니다. 구성요소 상태는 deprecated된 `componentstatuses` 대신 `kubectl get --raw='/readyz?verbose'`로 봅니다.

---

## 3. 구성요소 사이의 인증서 방향

인증서 문제를 풀 때 가장 먼저 정할 것은 "이 연결에서 누가 클라이언트이고 누가 서버인지"입니다. 방향이 정해지면 어떤 플래그를 볼지가 따라 나옵니다.

### 3-1. API 서버는 양쪽 역할을 다 한다

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

API 서버 매니페스트에는 스케줄러나 컨트롤러 매니저를 위한 플래그가 없습니다. 두 구성요소는 각자의 kubeconfig에 들어 있는 클라이언트 인증서로 API 서버에 접속합니다.

| 구성요소 | kubeconfig(kubeadm) |
|---|---|
| kube-scheduler | `/etc/kubernetes/scheduler.conf` |
| kube-controller-manager | `/etc/kubernetes/controller-manager.conf` |
| kubelet | `/etc/kubernetes/kubelet.conf` |
| 관리자 | `/etc/kubernetes/admin.conf` |

이 클라이언트 인증서는 클러스터 CA가 서명했고 API 서버는 `--client-ca-file`로 그 서명을 확인합니다. 인증서의 CN과 O가 RBAC의 사용자 이름과 그룹이 됩니다. 스케줄러의 인증서 CN이 `system:kube-scheduler`이고 그 이름에 기본 ClusterRole `system:kube-scheduler`가 바인딩되어 있는 식입니다.

### 3-3. 유효 기간과 확인 명령

kubeadm이 만든 리프 인증서는 1년(`certificateValidityPeriod` 기본 8760h), CA는 10년(`caCertificateValidityPeriod` 기본 87600h)입니다. 만료일은 `kubeadm certs check-expiration`으로 보고 kubelet 클라이언트 인증서는 `/var/lib/kubelet/pki`에서 자동으로 회전하므로 이 목록에 나오지 않습니다. `kubeadm certs renew all` 뒤 static Pod를 다시 띄우는 절차와 `kubeadm upgrade`가 인증서를 함께 갱신한다는 점은 [CKA Ch-02](/blog/cert/cka/cka-02-cluster-architecture)의 인증서 만료 절에 정리했습니다.

### 3-4. 직접 해 보기

kubeadm VM 클러스터에서 `grep -E 'tls-cert|client-ca|etcd-|kubelet-client' /etc/kubernetes/manifests/kube-apiserver.yaml`로 3-1절 표를 채우고 `openssl x509 -in /etc/kubernetes/pki/apiserver.crt -noout -subject -ext subjectAltName`으로 SAN을 확인합니다. `scheduler.conf`의 `client-certificate-data`를 base64로 풀어 CN이 `system:kube-scheduler`인지도 봅니다.

---

## 4. Pod

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

`kubectl get pod`의 STATUS 열은 사람이 읽기 좋게 고른 값이고 컨테이너가 Waiting이면 그 reason을 띄웁니다. 그래서 STATUS가 `ContainerCreating`인 동안 phase는 `Pending`이고 `CrashLoopBackOff`인 동안 phase는 대개 `Running`입니다. 확인은 이렇게 나눠서 합니다.

```bash
kubectl get pod order-api -n shop -o jsonpath='{.status.phase}{"\n"}'
kubectl get pod order-api -n shop -o jsonpath='{.status.containerStatuses[0].state}{"\n"}'
```

1.18 이후 `kubectl run`은 Pod 하나만 만듭니다. 옛 자료처럼 Deployment가 생기지 않습니다.

### 4-2. Pod IP는 생성 직후부터 클러스터 안 어디서나 닿는다

쿠버네티스 네트워크 모델에서 Pod는 클러스터 전체에서 고유한 IP를 받습니다. 다른 노드의 Pod끼리도 NAT 없이 그 IP로 직접 통신하고 노드의 에이전트도 그 노드의 Pod와 통신합니다. 그래서 Pod가 Running이 되어 IP를 받으면 다른 노드의 Pod에서도 바로 그 IP로 요청할 수 있습니다. 바로 닿지 않는 쪽은 클러스터 바깥입니다. 외부에 열려면 NodePort나 LoadBalancer Service, Ingress, Gateway가 필요합니다. NetworkPolicy가 있으면 클러스터 안에서도 막힐 수 있습니다.

Service가 필요한 이유도 여기서 나옵니다. Pod IP는 Pod가 다시 만들어질 때마다 바뀝니다. 상품 웹이 주문 API를 Pod IP로 부르면 주문 API가 재배포될 때마다 주소를 다시 알아내야 합니다. Service는 고정 IP와 DNS 이름을 주고 뒤의 Pod 목록은 EndpointSlice로 따라갑니다.

### 4-3. 멀티 컨테이너와 네이티브 사이드카

한 Pod 안의 컨테이너는 같은 노드에서 함께 뜨고 함께 사라지며 네트워크 네임스페이스를 공유합니다. 같은 Pod의 다른 컨테이너에는 `localhost:<포트>`로 닿고 볼륨은 정의한 만큼 공유합니다.

보조 컨테이너는 두 방식으로 넣습니다. 일반 init 컨테이너(`initContainers`)는 순서대로 하나씩 실행되고 앞 것이 성공해야 다음으로 넘어가며 모두 끝나야 앱 컨테이너가 시작됩니다. 네이티브 사이드카는 `initContainers`에 `restartPolicy: Always`를 준 컨테이너로 앱보다 먼저 뜨고 Pod가 끝날 때까지 계속 돕니다. v1.28 알파, v1.29 기본 활성을 거쳐 v1.33에서 GA가 되었습니다. 사이드카의 종료 순서와 프로브 동작, 예시 YAML은 [CKA Ch-03](/blog/cert/cka/cka-03-workloads-scheduling)의 네이티브 사이드카 절에 있습니다.

### 4-4. 직접 해 보기

`kubectl run bad --image=nginx:no-such-tag -n shop`을 실행하고 4-1절의 jsonpath 두 줄로 phase와 컨테이너 상태를 따로 기록합니다. STATUS 열이 `ErrImagePull`과 `ImagePullBackOff`를 오가는 동안 phase가 `Pending`인지 확인합니다. 이어서 `kubectl run tmp --rm -it --image=busybox:1.36 -n shop -- wget -qO- -T 2 <order-api Pod IP>`로 다른 Pod에서 Pod IP가 바로 닿는지 봅니다.

---

## 5. ReplicationController, ReplicaSet, Deployment

### 5-1. RC와 RS의 차이

ReplicationController 문서는 이 API를 레거시로 표시하고 Deployment와 ReplicaSet을 쓰라고 안내합니다. 시험에서 RC를 직접 만들 일은 드물지만 옛 YAML을 RS로 고치는 문제에 대비해 차이를 알아 둡니다.

| 항목 | ReplicationController | ReplicaSet |
|---|---|---|
| apiVersion | `v1` | `apps/v1` |
| selector 형식 | 맵(`selector: {app: order-api}`), 등식만 | `matchLabels`, `matchExpressions`(In, NotIn, Exists, DoesNotExist) |
| selector 생략 | 템플릿 라벨을 그대로 씀 | 필수 |
| 직접 쓰는 경우 | 레거시 | 보통 Deployment가 만들어 줌 |

RS의 `matchExpressions`가 집합 기반 selector입니다. "env가 prod 또는 staging"처럼 값 여러 개를 한 조건으로 고를 수 있습니다.

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

ReplicaSet 문서의 "Non-Template Pod acquisitions" 절은 ownerReference가 없는 Pod가 RS의 selector에 맞으면 그 RS가 즉시 그 Pod를 자기 것으로 가져간다고 적습니다. 그래서 `app=product-web, tier=frontend` 라벨을 단 단독 Pod가 이미 2개 있는 상태에서 위 RS(replicas 3)를 만들면 RS는 Pod를 1개만 새로 만듭니다. 순서가 반대여도 같습니다. RS가 이미 3개를 유지하는 중에 같은 라벨의 단독 Pod를 만들면 RS가 그 Pod를 입양하고 4개가 되었으니 하나를 지웁니다. 문서 예시에서는 새로 만든 Pod가 입양된 직후 종료됩니다.

### 5-3. selector와 템플릿 라벨이 다르면 생성이 거부된다

`apps/v1`의 RS와 Deployment는 selector가 템플릿 라벨에 맞아야 합니다. 맞지 않으면 1-2절의 스키마 검증 단계에서 거부되고 메시지에 `selector does not match template labels`가 들어 있습니다. selector는 만든 뒤 바꿀 수도 없습니다. 바꿔야 하면 지우고 다시 만듭니다.

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

replicas가 3이면 maxSurge는 0.75를 올려 1, maxUnavailable은 0.75를 내려 0입니다. 새 Pod 하나가 먼저 Ready가 된 뒤에야 옛 Pod가 하나 줄어드는 순서가 됩니다. `set image`, `rollout status`, `undo --to-revision` 같은 명령 묶음은 [CKA Ch-03](/blog/cert/cka/cka-03-workloads-scheduling)의 롤링 업데이트 장에 있습니다.

### 5-5. 스케일 명령 세 가지

```bash
# 1) 파일의 replicas를 고친 뒤 반영
kubectl replace -f product-web-rs.yaml

# 2) 파일을 기준으로 대상을 찾아 라이브 객체만 바꿈 (파일 내용은 그대로)
kubectl scale --replicas=6 -f product-web-rs.yaml

# 3) 이름으로 지정
kubectl scale rs product-web --replicas=6 -n shop
```

2번은 파일을 고치지 않습니다. 나중에 같은 파일로 `apply`나 `replace`를 하면 replicas가 파일의 값 3으로 돌아갑니다. HPA가 붙어 있는 대상은 HPA가 replicas를 다시 덮어씁니다. `--current-replicas=3`을 같이 주면 현재 값이 3일 때만 바꾸는 조건부 스케일이 됩니다.

### 5-6. 직접 해 보기

`kubectl run p1 --image=nginx:1.27 --labels=app=product-web,tier=frontend -n shop`처럼 단독 Pod 2개를 먼저 만든 뒤 5-1절의 RS를 적용하고 새로 생긴 Pod 수와 각 Pod의 `ownerReferences`를 적습니다. selector를 `app: product-api`로 바꾼 RS를 새 이름으로 적용해 거부 메시지를 기록합니다. Deployment에 `kubectl scale`과 `kubectl set image`를 한 번씩 실행해 `rollout history`의 리비전 수 변화를 비교합니다.

---

## 6. Service와 Namespace

### 6-1. Service의 포트 셋과 NodePort가 열리는 위치

`port`는 Service가 받는 포트, `targetPort`는 Pod 쪽 포트(생략하면 `port`와 같고 이름 있는 포트도 가능), `nodePort`는 노드가 여는 포트(생략하면 30000-32767에서 자동 배정)입니다. Service 문서의 NodePort 설명은 "Each node proxies that port (the same port number on every Node)"입니다. 주문 API Pod가 노드 1에만 있어도 노드 2, 노드 3의 같은 nodePort로 들어온 요청이 노드 1의 Pod까지 전달됩니다. 노드 하나가 죽으면 그 노드 IP로 접속하던 클라이언트만 끊기고 다른 노드 IP로는 계속 접속됩니다. 그래서 운영에서는 노드들 앞에 로드밸런서를 둡니다.

`externalTrafficPolicy`가 이 전달 방식을 정합니다.

| 값 | 동작 | 대가 |
|---|---|---|
| `Cluster`(기본) | 어느 노드로 들어오든 클러스터 안 아무 Pod로 전달 | 다른 노드로 넘길 때 SNAT이 일어나 Pod가 클라이언트 원래 IP를 못 봄 |
| `Local` | 들어온 노드에 있는 Ready Pod로만 전달 | 클라이언트 IP는 보존. 그 노드에 Pod가 없으면 트래픽을 버림 |

타입 네 가지와 headless, `expose` 명령, EndpointSlice는 [CKA Ch-04](/blog/cert/cka/cka-04-services-networking)에 자세히 있습니다.

### 6-2. 네임스페이스 범위와 클러스터 범위

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

둘은 이렇게 맞물립니다. ResourceQuota에 `requests.cpu`가 있으면 그 네임스페이스의 Pod는 CPU requests를 반드시 가져야 하고 없으면 생성이 거부됩니다. LimitRange의 `defaultRequest`가 있으면 변형 어드미션 단계에서 값이 채워지니 거부를 피합니다. 두 정책 모두 생성 시점에만 검사하므로 이미 떠 있는 Pod에는 소급하지 않습니다.

```bash
kubectl create quota shop-quota -n shop --hard=requests.cpu=2,requests.memory=2Gi,pods=10
kubectl describe quota shop-quota -n shop
```

LimitRange는 명령형 생성 명령이 없어서 YAML로 씁니다. 예시와 값 계산은 [CKA Ch-03](/blog/cert/cka/cka-03-workloads-scheduling)의 LimitRange, ResourceQuota 절에 있습니다.

### 6-6. 직접 해 보기

`web` 네임스페이스의 임시 Pod에서 `nslookup order-api`와 `nslookup order-api.shop`을 차례로 실행하고 `/etc/resolv.conf`의 search 줄을 기록합니다. 이미지는 `registry.k8s.io/e2e-test-images/jessie-dnsutils:1.3`을 씁니다. kind v1.37.0에서 `busybox:1.36`의 `nslookup`은 search 처리 탓에 `order-api.shop`도 NXDOMAIN으로 보였고 같은 Pod의 `wget`으로는 이름이 풀렸습니다. `shop`에 6-5절의 쿼터를 만든 뒤 requests 없는 Pod가 거부되는지, `defaultRequest`가 있는 LimitRange를 더하면 만들어지는지, 그때 `resources`에 어떤 값이 들어갔는지 봅니다.

kind 실측에서 dnsutils Pod의 search 줄은 `web.svc.cluster.local svc.cluster.local cluster.local`이었고 `order-api`는 NXDOMAIN, `order-api.shop`은 ClusterIP로 풀렸습니다. 쿼터만 있을 때 Pod 생성은 `403 Forbidden`과 `failed quota: ... must specify requests.cpu` 계열 메시지로 거부됐습니다. LimitRange를 더하자 만들어졌고 `resources`에 LimitRange의 값이 채워졌습니다. 같은 쿼터에 걸린 Deployment는 Deployment 자체는 만들어지고 ReplicaSet 이벤트에 `FailedCreate`가 남았습니다.

---

## 7. 오브젝트를 다루는 세 방식

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

세 번째 줄이 중요합니다. HPA가 바꾼 replicas나 컨트롤러가 채운 기본값처럼 파일에 적은 적이 없는 필드는 apply가 건드리지 않습니다. 반대로 `kubectl create`로 만든 객체에는 이 어노테이션이 없어서 처음 apply할 때 경고가 나옵니다(어노테이션은 자동으로 붙음).

`kubectl apply --server-side`는 비교를 API 서버가 합니다. 필드마다 누가 그 값을 소유하는지 `metadata.managedFields`에 기록하고 다른 관리자가 소유한 필드를 바꾸려 하면 충돌로 거부합니다. 의도한 변경이면 `--force-conflicts`로 소유권을 가져옵니다.

### 7-3. kubectl edit은 임시 파일을 편집한다

`kubectl edit`은 현재 객체를 받아 임시 파일로 만들고 `KUBE_EDITOR` 또는 `EDITOR` 환경 변수의 편집기(리눅스 기본 vi)로 엽니다. 저장하고 닫으면 그 내용을 API 서버에 보냅니다. kubectl edit 레퍼런스는 반영 중 에러가 나면 적용하지 못한 수정본을 담은 임시 파일을 디스크에 남긴다고 적습니다. 경로는 `/tmp/kubectl-edit-<임의 문자열>.yaml` 형태로 출력됩니다. 위치는 운영체제의 임시 디렉터리라서 macOS의 kubectl v1.37.1에서는 `$TMPDIR`(`/var/folders/...`) 아래에 생겼습니다. 터미널에는 `error: pods "..." is invalid`와 `A copy of your changes has been stored to "..."`가 찍히고 Forbidden의 상세 문구는 그 임시 파일 머리의 주석에 들어 있습니다.

### 7-4. 실행 중인 Pod에서 바꿀 수 있는 필드

Pod 스펙은 대부분 바꿀 수 없습니다. 바꿀 수 있는 것은 이 정도입니다.

- `spec.containers[*].image`, `spec.initContainers[*].image`
- `spec.activeDeadlineSeconds`
- `spec.terminationGracePeriodSeconds`(이전 값이 음수였을 때 1로 바꾸는 경우만)
- `spec.tolerations`(추가만)

그 밖의 필드, 예를 들어 환경 변수나 포트, 볼륨을 `kubectl edit pod`로 바꾸면 `pod updates may not change fields other than ...`로 시작하는 Forbidden 에러가 납니다. v1.37 API 서버의 실제 문구에서 이 항목은 `` `spec.terminationGracePeriodSeconds` (allow it to be set to 1 if it was previously negative) ``로 적혀 있습니다(kind 실측). 양수 값을 다른 양수로 바꾸는 것은 거부됩니다. 이때의 절차는 이렇습니다.

```bash
kubectl edit pod order-api -n shop
# 저장 → 거부 → 편집기를 닫으면 /tmp/kubectl-edit-xxxx.yaml 경로가 출력됨

kubectl replace --force -f /tmp/kubectl-edit-xxxx.yaml
# 기존 Pod를 지우고 수정본으로 다시 만듦
```

`replace --force`는 삭제 후 재생성이라 Pod IP가 바뀌고 잠시 서비스가 끊깁니다. kind에서 단독 Pod로 해 보니 IP가 `.51`에서 `.52`로 바뀌었습니다. Deployment에 속한 Pod라면 Deployment의 템플릿을 고칩니다. kind에서 Deployment 소유 Pod에 `replace --force`를 했더니 다시 만든 Pod도 같은 라벨이라 ReplicaSet이 개수 초과로 보고 그 Pod를 지웠습니다. Pod만 고치면 다음 롤아웃 때 템플릿 값으로 돌아가기 때문입니다. CPU와 메모리 requests, limits는 v1.35에서 GA가 된 in-place resize로 `resize` 서브리소스를 통해 Pod를 다시 만들지 않고 바꿀 수 있습니다(`kubectl patch pod ... --subresource resize`). 자세한 사용법은 [CKA Ch-03](/blog/cert/cka/cka-03-workloads-scheduling)에 있습니다.

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
kubectl expose deployment product-web --port=80 --target-port=8080 -n shop

# Pod와 같은 이름의 ClusterIP Service를 한 번에
kubectl run order-api --image=nginx:1.27 --port=8080 --expose -n shop

# 필드 설명 찾기
kubectl explain deployment.spec.strategy.rollingUpdate
kubectl explain pod.spec.containers.resources --recursive | head -30
```

`kubectl expose`는 대상 리소스의 selector를 그대로 씁니다. `kubectl create service`는 selector를 `app=<Service 이름>`으로 고정해 넣으므로 Pod 라벨이 다르면 엔드포인트가 비게 됩니다. 그래서 대상이 이미 있으면 `expose`가 안전합니다. `--dry-run=server`는 API 서버까지 보내 어드미션과 검증을 거치게 하고 저장만 하지 않습니다. 쿼터나 selector 불일치를 미리 확인할 때 씁니다.

### 7-7. 직접 해 보기

`kubectl create deployment`로 만든 객체에 `last-applied-configuration`이 없는지 보고 같은 내용을 `apply`해서 경고와 어노테이션이 생기는지 확인합니다. 파일에서 라벨 하나를 지우고 다시 apply해 라이브 객체에서도 지워지는지 봅니다. `kubectl edit pod`로 환경 변수를 추가해 거부되는 과정을 따라가고 남은 임시 파일로 `replace --force`를 실행합니다.

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

## 범위와 한계

- 2026-10-20에 kind v0.33 + 노드 v1.37.0(colima, arm64, kubectl v1.37.1 on macOS)에서 1-7부터 7-7까지의 "직접 해 보기"와 확인 문제 풀이를 돌렸습니다. watch 이벤트 순서, static Pod 매니페스트 4개와 리더 Lease, `readyz?verbose`, 인증서 경로와 SAN, phase 관찰, ReplicaSet 입양과 selector 불일치, 롤아웃 리비전, `scale --current-replicas` 오류, 쿼터와 LimitRange, 401/403/422 응답, 네임스페이스 불일치 오류, `kubectl edit` 거부와 `replace --force`를 확인했습니다. 실측과 다르던 곳(7-4의 `terminationGracePeriodSeconds`, 7-3의 임시 파일 위치, 6-6의 busybox `nslookup`)은 고쳤습니다.
- kind 조건: kind의 kubelet 설정에는 `failSwapOn: false`, `cgroupRoot: /kubelet`, `cgroupDriver: systemd`가 들어 있어 kubeadm 기본 노드와 다릅니다. kubeadm init과 upgrade, `kubeadm certs check-expiration`, 패키지 설치, 노드 재부팅은 돌리지 않았습니다.
- 공식 문서는 2026년 10월 20일 기준 kubernetes.io(v1.37)에서 확인했습니다. Endpoints API deprecated(v1.33), nftables GA(v1.33), 네이티브 사이드카 GA(v1.33), taint-eviction-controller 분리 GA(v1.34), IPVS deprecated(v1.35), in-place resize GA(v1.35)는 버전에 따라 달라지는 항목입니다. `--node-monitor-grace-period` 기본값 50초도 옛 자료의 40초와 다릅니다.
- 1-2절 표의 HTTP 상태 코드 중 401과 403은 Controlling Access 문서에 있습니다. 스키마 검증 실패의 422와 어드미션 거부의 응답 코드는 API 규약과 문서 예시를 근거로 적었고 플러그인마다 다를 수 있습니다.
- kubeadm 기본 인증서 파일 경로와 kubeconfig 경로는 kubeadm 기준이고 다른 설치 도구(k3s, 관리형 서비스)에서는 다릅니다.
- 확인 문제는 제가 만든 것이고 실제 시험 문항과 관계없습니다.

## 참고 자료

공식 문서
- CNCF, [CKA Curriculum v1.37](https://github.com/cncf/curriculum/blob/master/CKA_Curriculum_v1.37.pdf)
- Kubernetes, [Kubernetes Components](https://kubernetes.io/docs/concepts/overview/components/), [Controllers](https://kubernetes.io/docs/concepts/architecture/controller/), [Leases](https://kubernetes.io/docs/concepts/architecture/leases/), [Nodes](https://kubernetes.io/docs/concepts/architecture/nodes/)
- Kubernetes, [Controlling Access to the Kubernetes API](https://kubernetes.io/docs/concepts/security/controlling-access/), [Admission Control in Kubernetes](https://kubernetes.io/docs/reference/access-authn-authz/admission-controllers/)
- Kubernetes, [API Concepts: Efficient detection of changes](https://kubernetes.io/docs/reference/using-api/api-concepts/#efficient-detection-of-changes)
- Kubernetes, [Scheduling Framework](https://kubernetes.io/docs/concepts/scheduling-eviction/scheduling-framework/), [Assigning Pods to Nodes](https://kubernetes.io/docs/concepts/scheduling-eviction/assign-pod-node/), [Taints and Tolerations](https://kubernetes.io/docs/concepts/scheduling-eviction/taint-and-toleration/)
- Kubernetes, [kube-apiserver](https://kubernetes.io/docs/reference/command-line-tools-reference/kube-apiserver/), [kube-controller-manager](https://kubernetes.io/docs/reference/command-line-tools-reference/kube-controller-manager/), [kubelet](https://kubernetes.io/docs/reference/command-line-tools-reference/kubelet/), [Virtual IPs and Service Proxies](https://kubernetes.io/docs/reference/networking/virtual-ips/)
- Kubernetes Blog, [Decoupled Taint Manager Is Now Stable (v1.34)](https://kubernetes.io/blog/2025/09/15/kubernetes-v1-34-decoupled-taint-manager-is-now-stable/), [Endpoints deprecation](https://kubernetes.io/blog/2025/04/24/endpoints-deprecation/), [NFTables mode for kube-proxy](https://kubernetes.io/blog/2025/02/28/nftables-kube-proxy/); KEP-5495 [ipvs deprecation](https://www.kubernetes.dev/resources/keps/5495/)
- Kubernetes, [PKI certificates and requirements](https://kubernetes.io/docs/setup/best-practices/certificates/), [Certificate Management with kubeadm](https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/kubeadm-certs/), [kubeadm Implementation details](https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/implementation-details/)
- Kubernetes, [Pod Lifecycle](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/), [Sidecar Containers](https://kubernetes.io/docs/concepts/workloads/pods/sidecar-containers/), [The Kubernetes network model](https://kubernetes.io/docs/concepts/services-networking/#the-kubernetes-network-model)
- Kubernetes, [ReplicationController](https://kubernetes.io/docs/concepts/workloads/controllers/replicationcontroller/), [ReplicaSet](https://kubernetes.io/docs/concepts/workloads/controllers/replicaset/), [Deployments](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/)
- Kubernetes, [Service](https://kubernetes.io/docs/concepts/services-networking/service/), [DNS for Services and Pods](https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/), [Namespaces](https://kubernetes.io/docs/concepts/overview/working-with-objects/namespaces/), [Resource Quotas](https://kubernetes.io/docs/concepts/policy/resource-quotas/), [Limit Ranges](https://kubernetes.io/docs/concepts/policy/limit-range/)
- Kubernetes, [Kubernetes Object Management](https://kubernetes.io/docs/concepts/overview/working-with-objects/object-management/), [Declarative Management](https://kubernetes.io/docs/tasks/manage-kubernetes-objects/declarative-config/), [Server-Side Apply](https://kubernetes.io/docs/reference/using-api/server-side-apply/)
- Kubernetes, [kubectl edit](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_edit/), [kubectl apply](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_apply/), [kubectl scale](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_scale/), [kubectl run](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_run/), [kubectl expose](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_expose/)

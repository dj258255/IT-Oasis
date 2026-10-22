---
title: '[CKA Ch-01.5] 기본 오브젝트와 컨트롤 플레인: kubectl 한 줄이 Pod가 되기까지'
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
seriesOrder: 1.5
---

![쿠버네티스 클러스터 구조: 컨트롤 플레인(etcd, API Server, Scheduler, Controller Manager, Cloud Controller Manager)과 워커 노드(kubelet, Container Runtime, kube-proxy)](/uploads/cert/cka/k8s-architecture.webp)

*그림 출처: [DevOps Mojo](https://medium.com/devops-mojo), Ashish Patel*

## 결론부터

1. `kubectl run` 한 줄은 API 서버 안에서 인증(실패 시 401), 인가(실패 시 403), 변형 어드미션, 스키마 검증, 검증 어드미션을 차례로 지나 etcd에 저장됩니다. 이때 `spec.nodeName`은 비어 있고 kubectl은 이 시점에 응답을 받고 끝납니다. 노드를 고르고 컨테이너를 띄우는 일은 그 뒤에 스케줄러와 kubelet이 각자 watch로 알아채서 합니다.
2. etcd와 직접 통신하는 구성요소는 kube-apiserver 하나뿐입니다. 스케줄러, 컨트롤러 매니저, kubelet, kube-proxy는 모두 API 서버의 클라이언트로 붙고 각자 kubeconfig의 클라이언트 인증서로 자신을 증명합니다.
3. `kubectl get pod`의 STATUS 열에 보이는 `ContainerCreating`, `CrashLoopBackOff`는 컨테이너 상태 `Waiting`의 reason이고 그동안 Pod phase는 각각 `Pending`, 대개 `Running`입니다. phase는 Pending, Running, Succeeded, Failed, Unknown 다섯 가지뿐입니다.
4. ReplicaSet은 selector에 맞는 주인 없는 Pod를 자기 것으로 입양합니다. Deployment는 Pod 템플릿이 바뀔 때만 새 리비전을 만들고 레플리카 수 변경은 리비전을 만들지 않습니다.
5. 실행 중인 Pod는 이미지, `activeDeadlineSeconds`, 톨러레이션 추가 정도만 고칠 수 있습니다(`terminationGracePeriodSeconds`는 이전 값이 음수였을 때 1로 바꾸는 경우만 허용). `kubectl edit`이 거부되면 수정본이 임시 디렉터리(리눅스는 `/tmp`)의 `kubectl-edit-*.yaml`에 남으니 그 파일로 `kubectl replace --force -f`를 실행합니다.

이 글은 [CKA Ch-01](/blog/cert/cka/cka-01-why-kubernetes)과 [CKA Ch-02](/blog/cert/cka/cka-02-cluster-architecture) 사이의 기초 편입니다. 뒤 글들이 전제로 까는 요청 흐름과 오브젝트 관계, 시험에서 쓰는 kubectl 방식을 한 번에 잡습니다. 롤링 업데이트와 스케줄링 세부는 [Ch-03](/blog/cert/cka/cka-03-workloads-scheduling)에, Service 타입은 [Ch-04](/blog/cert/cka/cka-04-services-networking)에, 구성요소 장애 대응은 [Ch-06](/blog/cert/cka/cka-06-troubleshooting)에 있습니다.

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

| 단계 | 하는 일 | 실패할 때(kind v1.37에서 `kubectl -v=6`으로 확인) | 시험에서 만나는 예 |
|---|---|---|---|
| 인증 | 클라이언트 인증서, 베어러 토큰(ServiceAccount 토큰 포함) 등으로 사용자 확인 | `401 Unauthorized`. kubectl은 `error: You must be logged in to the server (Unauthorized)` | kubeconfig의 인증서 경로 오류, 만료된 인증서, 잘못된 토큰 |
| 인가 | 기본 모드 `Node,RBAC`로 이 사용자가 이 동작을 해도 되는지 판단 | `403 Forbidden`. `pods is forbidden: User "..." cannot list resource "pods" ...` | `kubectl auth can-i`로 확인하는 RBAC 문제 |
| 변형 어드미션 | 요청 객체를 고침 | `403 Forbidden`. 없는 PriorityClass는 `no PriorityClass with name nope was found` | `DefaultTolerationSeconds`가 300초 톨러레이션 추가, `LimitRanger`가 기본 requests 주입 |
| 스키마 검증 | 객체가 API 스키마에 맞는지 확인 | 잘못된 값은 `422 Unprocessable Entity`(`is invalid: spec.replicas: Invalid value: -1`). 오타 난 필드는 kubectl 기본 `fieldValidation=Strict` 때문에 `400 Bad Request`(`strict decoding error: unknown field`) | 음수 replicas, selector와 템플릿 라벨 불일치(422), 필드 이름 오타(400) |
| 검증 어드미션 | 정책 위반이면 거부만 함 | ResourceQuota, LimitRange, PodSecurity는 `403 Forbidden`. ValidatingAdmissionPolicy는 `422`(메시지는 `is forbidden: ValidatingAdmissionPolicy ... denied request`). 웹훅 서버가 없는데 `failurePolicy: Fail`이면 `500 Internal Server Error`(`failed calling webhook`) | `exceeded quota`, `violates PodSecurity "restricted:latest"`, `maximum cpu usage per Container is 200m` |

Admission Control 문서 기준으로 변형 어드미션, 스키마 검증, 검증 어드미션 순서로 돌고 어드미션은 쓰기 요청에만 적용됩니다.

CPU, 메모리, Pod 수 쿼터에 걸리는 Deployment도 `kubectl create`는 성공합니다. 이 쿼터는 Pod가 만들어질 때 계산되므로 거부는 ReplicaSet 컨트롤러가 Pod를 만들려 할 때 일어나고 기록은 `kubectl describe rs`의 Events에 남습니다.

### 1-3. 스케줄러가 노드를 고르는 방식

스케줄러는 `spec.nodeName`이 비어 있는 Pod를 watch해서 하나씩 노드를 정합니다. Filter 단계에서 남은 CPU와 메모리가 requests보다 작은 노드, 견디지 못하는 테인트가 있는 노드, nodeSelector나 어피니티에 맞지 않는 노드를 지우고 Score 단계에서 남은 노드 중 점수가 가장 높은 노드를 고릅니다. 결과는 `pods/<이름>/binding` 서브리소스로 보내고 API 서버가 `spec.nodeName`을 채웁니다. 남는 노드가 없으면 Pod는 `Pending`에 머물고 `describe pod`의 Events에 `FailedScheduling`과 이유가 남습니다.

### 1-4. kubelet이 컨테이너를 띄우고 상태를 보고하는 방식

kubelet은 `spec.nodeName=<자기 노드 이름>` 필드 셀렉터로 자기 노드의 Pod만 골라 watch합니다. 자기 노드에 배정된 Pod가 생기면 CRI로 containerd 같은 런타임을 호출합니다. 순서는 Pod 샌드박스(네트워크 네임스페이스를 잡는 pause 컨테이너)를 만들고 CNI로 IP를 받은 뒤 이미지를 받고 컨테이너를 시작하는 흐름입니다. 결과는 `pods/<이름>/status` 서브리소스로 API 서버에 올립니다. `kubectl get pod -o wide`의 IP와 NODE 열은 이렇게 채워집니다.

`crictl pods`에 Pod 샌드박스가 따로 보이는 이유가 이 pause 컨테이너입니다. 커널 쪽 동작은 [네임스페이스와 pause 글](/blog/theory/systems/k8s-linux-02-namespaces-pause)에서 다룹니다(시험 범위 밖 심화).

### 1-5. watch

스케줄러와 kubelet이 Pod 생성을 알아채는 장치가 watch입니다. 클라이언트가 `?watch=true`로 요청하면 API 서버가 연결을 열어 두고 ADDED, MODIFIED, DELETED 이벤트를 흘려보냅니다. `kubectl get -w`도 같은 watch입니다. 재연결과 `resourceVersion` 처리 같은 클라이언트 쪽 세부는 시험 범위 밖입니다.

### 1-6. Deployment가 Pod 세 개가 되는 경로

컨트롤러는 원하는 상태(spec)와 현재 상태(status)를 비교해 차이를 줄이는 제어 루프입니다([Ch-01 1-2절](/blog/cert/cka/cka-01-why-kubernetes)). `kubectl create deployment order-api --image=nginx:1.27 --replicas=3 -n shop`의 경로는 이렇게 이어집니다.

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

오브젝트 관계는 Deployment → ReplicaSet → Pod이고 아래쪽 오브젝트의 `metadata.ownerReferences`가 위쪽을 가리킵니다. Pod를 지우면 ReplicaSet이 다시 만들고 ReplicaSet을 지우면 Deployment가 다시 만듭니다. 개수를 바꾸거나 이미지를 바꾸려면 맨 위의 Deployment를 고칩니다.

```bash
kubectl get pod <Pod> -n shop -o jsonpath='{.metadata.ownerReferences[0].kind}/{.metadata.ownerReferences[0].name}{"\n"}'
# ReplicaSet/order-api-<hash>
```

### 1-7. 직접 해 보기

kind 클러스터에서 한쪽 터미널에 `kubectl get pods -n shop -w -o wide`를 띄우고 다른 쪽에서 `kubectl run`을 실행합니다. NODE 열이 `<none>`에서 노드 이름으로, STATUS가 `Pending`에서 `Running`으로 바뀌는 순서를 적습니다. 이어서 Deployment를 만들고 Pod 하나를 지운 뒤 새 Pod의 `ownerReferences`가 같은 ReplicaSet을 가리키는지 봅니다.

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

API 서버는 1장의 인증, 인가, 어드미션, 스키마 검증 외에도 API 버전 사이 변환과 ServiceAccount 토큰 발급을 맡습니다. 다른 구성요소는 모두 API 서버를 거쳐서만 상태를 읽고 씁니다. 그래서 API 서버가 멈추면 `kubectl`이 전부 실패하고 스케줄링과 컨트롤러 동작도 같이 멈춥니다. 이미 떠 있는 Pod는 kubelet이 계속 돌립니다.

### 2-3. etcd

etcd는 Raft 합의를 쓰는 분산 키-값 저장소입니다. kubeadm 기본 구성(stacked)에서는 컨트롤 플레인 노드마다 static Pod로 돌고 데이터는 hostPath `/var/lib/etcd`에 있습니다. 외부 etcd를 쓰는 클러스터라면 `kube-apiserver.yaml`의 `--etcd-servers`를 보면 위치가 나옵니다. 백업과 복구는 [CKA Ch-02](/blog/cert/cka/cka-02-cluster-architecture)의 etcd 절에 정리했습니다.

### 2-4. kube-scheduler와 nodeName 직접 지정

스케줄러는 Filter로 Pod를 받을 수 없는 노드를 지우고 Score로 남은 노드 중 하나를 고른 뒤 바인딩을 별도 단계로 합니다. 플러그인 확장 포인트 세부는 시험 범위 밖입니다.

`spec.nodeName`을 직접 적은 Pod는 스케줄러를 건너뜁니다. 이미 노드가 정해져 있으니 해당 노드의 kubelet이 바로 받습니다. API 서버의 인증, 인가, 어드미션은 그대로 거칩니다. Assigning Pods to Nodes 문서가 적은 차이가 하나 더 있습니다. 스케줄러의 Filter를 거치지 않았으니 노드에 자원이 모자라면 kubelet이 Pod를 거부하고 Pod는 `OutOfcpu` 같은 reason과 함께 곧바로 `Failed`가 됩니다. 스케줄러가 죽었을 때 Pod를 특정 노드에 띄우는 방법으로도 쓰입니다.

### 2-5. kube-controller-manager

컨트롤러 매니저는 컨트롤러 수십 개를 한 바이너리에 담은 것입니다. 이 글의 흐름과 맞닿는 컨트롤러만 고르면 이렇습니다.

| 컨트롤러 | 하는 일 |
|---|---|
| deployment-controller | Deployment에 맞는 ReplicaSet을 만들고 롤아웃 진행 |
| replicaset-controller | ReplicaSet의 Pod 수를 replicas에 맞춤 |
| endpointslice-controller | Service selector에 맞는 Pod로 EndpointSlice를 만듦. kube-proxy가 이것을 봄 |
| node-lifecycle-controller | 노드 하트비트가 끊기면 NotReady/Unknown 표시와 `unreachable`, `not-ready` NoExecute 테인트 부착 |
| taint-eviction-controller | NoExecute 테인트를 견디지 못하는 Pod를 삭제(1.29 beta부터 기본 분리, 1.34 GA) |

옛 v1 Endpoints API는 v1.33부터 deprecated라 조회하면 `v1 Endpoints is deprecated in v1.33+; use discovery.k8s.io/v1 EndpointSlice` 경고가 붙습니다. Service 디버깅은 `kubectl get endpointslices -l kubernetes.io/service-name=<svc>`로 익혀 둡니다. 노드가 죽은 뒤 약 50초 + 300초에 Pod가 옮겨지는 과정은 [Ch-01 3-4절](/blog/cert/cka/cka-01-why-kubernetes)에 있습니다.

`--leader-elect`(기본 true) 때문에 컨트롤 플레인이 여러 대여도 일은 리더 하나만 합니다. 리더는 `kube-system`의 Lease 객체로 정하고 스케줄러도 같은 방식입니다. `kubectl -n kube-system get lease`의 HOLDER로 지금 리더가 어느 노드인지 봅니다.

### 2-6. kubelet

kubelet은 노드 등록, Pod 실행(CRI 호출), 프로브 실행, 볼륨 마운트, 노드 압박 시 축출, 하트비트를 맡습니다. 하트비트는 Node 객체의 status 갱신과 `kube-node-lease` 네임스페이스의 노드별 Lease 갱신 두 갈래입니다.

kubeadm 클러스터에서 컨트롤 플레인은 static Pod이고 kube-proxy는 DaemonSet인데 kubelet은 systemd 서비스입니다. static Pod를 띄우는 주체가 kubelet이니 kubelet 자신은 그 바깥에 있어야 합니다. 설정 파일은 `/var/lib/kubelet/config.yaml`(여기서 `staticPodPath` 확인)이고 API 서버 접속용 kubeconfig는 `/etc/kubernetes/kubelet.conf`입니다. kubelet이 멈춘 노드의 복구 순서는 [CKA Ch-06](/blog/cert/cka/cka-06-troubleshooting)의 클러스터 구성요소 장에 있습니다.

### 2-7. kube-proxy

kube-proxy는 규칙 관리자입니다. EndpointSlice와 Service를 watch해서 노드 커널의 netfilter나 IPVS 규칙을 고치고 실제 패킷은 커널이 처리합니다. Virtual IPs 문서와 릴리스 글 기준 모드 현황은 이렇습니다.

| 모드 | 상태 |
|---|---|
| `iptables` | 리눅스 기본값. 문서는 앞으로 기본값이 바뀔 수 있으니 모드를 명시하라고 권함 |
| `nftables` | v1.33 GA |
| `ipvs` | v1.35 deprecated. v1.37 릴리스 글 기준 v1.40에서 기본 비활성, v1.43에서 제거 예정 |

kubeadm 클러스터에서는 `kube-system`에 DaemonSet과 ConfigMap `kube-proxy`가 있고 모드는 ConfigMap의 `mode` 값으로 확인합니다. ConfigMap을 고친 뒤에는 `kubectl -n kube-system rollout restart ds kube-proxy`로 다시 띄웁니다. Cilium 같은 CNI의 kube-proxy 대체 기능을 쓰면 kube-proxy가 아예 없는 클러스터도 있습니다. 규칙 해석은 시험 범위 밖이고 [Service와 iptables, conntrack 글](/blog/theory/systems/k8s-linux-05-service-iptables-conntrack)에서 다룹니다.

### 2-8. 직접 해 보기

컨트롤 플레인 노드에서 `sudo ls /etc/kubernetes/manifests`로 static Pod 네 개를 확인하고 `kube-controller-manager.yaml`에서 `--leader-elect` 값을 찾습니다. `kubectl -n kube-system get lease`로 리더를, `kubectl -n kube-system get cm kube-proxy -o yaml | grep mode`로 kube-proxy 모드를 적습니다. 구성요소 상태는 deprecated된 `componentstatuses` 대신 `kubectl get --raw='/readyz?verbose'`로 봅니다.

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

쿠버네티스 네트워크 모델에서 Pod는 클러스터 전체에서 고유한 IP를 받고 다른 노드의 Pod끼리도 NAT 없이 그 IP로 직접 통신합니다. 그래서 Pod가 IP를 받으면 다른 노드의 Pod에서도 바로 요청할 수 있습니다. 클러스터 바깥에 열려면 NodePort나 LoadBalancer Service, Ingress, Gateway가 필요하고 NetworkPolicy가 있으면 클러스터 안에서도 막힐 수 있습니다.

Pod IP는 Pod가 다시 만들어질 때마다 바뀝니다. Service는 고정 IP와 DNS 이름을 주고 뒤의 Pod 목록은 EndpointSlice로 따라갑니다.

### 4-3. 멀티 컨테이너와 네이티브 사이드카

한 Pod 안의 컨테이너는 같은 노드에서 함께 뜨고 함께 사라지며 네트워크 네임스페이스를 공유합니다. 같은 Pod의 다른 컨테이너에는 `localhost:<포트>`로 닿고 볼륨은 정의한 만큼 공유합니다.

보조 컨테이너는 두 방식으로 넣습니다. 일반 init 컨테이너(`initContainers`)는 순서대로 하나씩 실행되고 모두 성공해야 앱 컨테이너가 시작됩니다. 네이티브 사이드카는 `initContainers`에 `restartPolicy: Always`를 준 컨테이너로 앱보다 먼저 뜨고 Pod가 끝날 때까지 계속 돕니다(v1.33 GA). 예시 YAML은 [CKA Ch-03](/blog/cert/cka/cka-03-workloads-scheduling)의 네이티브 사이드카 절에 있습니다.

### 4-4. 직접 해 보기

`kubectl run bad --image=nginx:no-such-tag -n shop`을 실행하고 4-1절의 jsonpath 두 줄로 phase와 컨테이너 상태를 따로 기록합니다. STATUS 열이 `ErrImagePull`과 `ImagePullBackOff`를 오가는 동안 phase가 `Pending`인지 확인합니다. 이어서 `kubectl run tmp --rm -it --image=busybox:1.36 -n shop -- wget -qO- -T 2 <order-api Pod IP>`로 다른 Pod에서 Pod IP가 바로 닿는지 봅니다.

---

## 5. ReplicationController, ReplicaSet, Deployment

### 5-1. RC와 RS의 차이

ReplicationController 문서는 이 API를 레거시로 표시하고 Deployment와 ReplicaSet을 쓰라고 안내합니다. 옛 YAML을 RS로 고칠 때 바꿀 곳은 둘입니다. apiVersion을 `v1`에서 `apps/v1`로 바꾸고 맵 형태의 `selector: {app: order-api}`를 `selector.matchLabels` 아래로 옮깁니다. RS는 selector를 생략할 수 없습니다.

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

`port`는 Service가 받는 포트, `targetPort`는 Pod 쪽 포트(생략하면 `port`와 같고 이름 있는 포트도 가능), `nodePort`는 노드가 여는 포트(생략하면 30000-32767에서 자동 배정)입니다. Service 문서는 NodePort를 "Each node proxies that port (the same port number on every Node)"로 설명합니다. 주문 API Pod가 노드 1에만 있어도 노드 2의 같은 nodePort로 들어온 요청이 노드 1의 Pod까지 전달됩니다.

`externalTrafficPolicy: Local`을 주면 들어온 노드에 있는 Ready Pod로만 전달해 클라이언트 IP를 보존하고 그 노드에 Pod가 없으면 트래픽을 버립니다. 기본값 `Cluster`는 아무 노드의 Pod로 전달합니다.

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

`web` 네임스페이스의 임시 Pod에서 `nslookup order-api`와 `nslookup order-api.shop`을 차례로 실행하고 `/etc/resolv.conf`의 search 줄을 기록합니다. 이미지는 `registry.k8s.io/e2e-test-images/jessie-dnsutils:1.3`을 씁니다. `busybox:1.36`의 `nslookup`은 kind에서 search 처리 탓에 `order-api.shop`도 NXDOMAIN으로 보였습니다. `shop`에 6-5절의 쿼터를 만든 뒤 requests 없는 Pod가 거부되는지, `defaultRequest`가 있는 LimitRange를 더하면 만들어지는지 봅니다.

kind에서 확인한 결과는 이렇습니다. search 줄은 `web.svc.cluster.local svc.cluster.local cluster.local`이었고 `order-api`는 NXDOMAIN, `order-api.shop`은 ClusterIP로 풀렸습니다. 쿼터만 있을 때 Pod 생성은 `403 Forbidden`과 `failed quota: ... must specify requests.cpu` 계열 메시지로 거부됐고 LimitRange를 더하자 만들어졌습니다. 같은 쿼터에 걸린 Deployment는 만들어지고 ReplicaSet 이벤트에 `FailedCreate`가 남았습니다.

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

`kubectl apply --server-side`는 이 비교를 API 서버가 하고 다른 관리자가 소유한 필드를 바꾸려 하면 충돌로 거부합니다. 의도한 변경이면 `--force-conflicts`를 붙입니다.

### 7-3. kubectl edit은 임시 파일을 편집한다

`kubectl edit`은 현재 객체를 받아 임시 파일로 만들고 `KUBE_EDITOR` 또는 `EDITOR` 환경 변수의 편집기(리눅스 기본 vi)로 엽니다. 저장하고 닫으면 그 내용을 API 서버에 보냅니다. kubectl edit 레퍼런스는 반영 중 에러가 나면 적용하지 못한 수정본을 담은 임시 파일을 디스크에 남긴다고 적습니다. 경로는 운영체제의 임시 디렉터리 아래 `kubectl-edit-<임의 문자열>.yaml` 형태로 출력되고 리눅스인 시험 호스트에서는 `/tmp`입니다. 터미널에는 `error: pods "..." is invalid`와 `A copy of your changes has been stored to "..."`가 찍히고 Forbidden의 상세 문구는 그 임시 파일 머리의 주석에 들어 있습니다.

### 7-4. 실행 중인 Pod에서 바꿀 수 있는 필드

Pod 스펙은 대부분 바꿀 수 없습니다. 바꿀 수 있는 것은 이 정도입니다.

- `spec.containers[*].image`, `spec.initContainers[*].image`
- `spec.activeDeadlineSeconds`
- `spec.terminationGracePeriodSeconds`(이전 값이 음수였을 때 1로 바꾸는 경우만)
- `spec.tolerations`(추가만)

그 밖의 필드, 예를 들어 환경 변수나 포트, 볼륨을 `kubectl edit pod`로 바꾸면 `pod updates may not change fields other than ...`로 시작하는 Forbidden 에러가 납니다. v1.37 API 서버의 오류 문구에도 `` `spec.terminationGracePeriodSeconds` (allow it to be set to 1 if it was previously negative) ``로 적혀 있어 양수 값을 다른 양수로 바꾸는 것은 거부됩니다. 이때의 절차는 이렇습니다.

```bash
kubectl edit pod order-api -n shop
# 저장 → 거부 → 편집기를 닫으면 /tmp/kubectl-edit-xxxx.yaml 경로가 출력됨

kubectl replace --force -f /tmp/kubectl-edit-xxxx.yaml
# 기존 Pod를 지우고 수정본으로 다시 만듦
```

`replace --force`는 삭제 후 재생성이라 Pod IP가 바뀌고 잠시 서비스가 끊깁니다. Deployment에 속한 Pod라면 Deployment의 템플릿을 고칩니다. Deployment 소유 Pod에 `replace --force`를 하면 다시 만든 Pod도 같은 라벨이라 ReplicaSet이 개수 초과로 보고 그 Pod를 지웁니다(kind에서 확인). CPU와 메모리 requests, limits는 v1.35에서 GA가 된 in-place resize로 `resize` 서브리소스를 통해 Pod를 다시 만들지 않고 바꿀 수 있습니다(`kubectl patch pod ... --subresource resize`). 자세한 사용법은 [CKA Ch-03](/blog/cert/cka/cka-03-workloads-scheduling)에 있습니다.

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

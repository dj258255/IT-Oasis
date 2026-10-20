---
title: '[CKA Ch-01] 쿠버네티스는 왜 필요한가: 결국 Linux 커널까지 내려가야 이해된다'
description: 쿠버네티스는 원하는 상태를 API 오브젝트로 받아 두고 컨트롤러와 kubelet이 실제 상태를 거기에 맞춥니다. 프로세스를 격리하고 메모리와 CPU를 막는 일은 리눅스 커널의 namespace와 cgroup이 합니다. kind v1.37 클러스터에서 controller-manager를 멈춰 보고 OOMKilled와 CPU 스로틀링을 노드 안의 cgroup 파일과 커널 로그로 확인합니다.
date: 2026-10-15T00:00:00.000Z
tags:
  - CKA
  - Kubernetes
  - Linux Kernel
  - cgroup
  - OOMKilled
  - CPU Throttling
category: cert/CKA
topics:
  - cert
  - systems
draft: false
series: "CKA 공부"
seriesOrder: 1
---

## 결론부터

1. 쿠버네티스 API에 넣는 오브젝트의 `spec`은 원하는 상태이고 `status`는 관측된 상태입니다. 컨트롤러와 kubelet이 둘의 차이를 계속 메웁니다. 노드에서 프로세스를 격리하고 메모리와 CPU를 막는 실제 동작은 리눅스 커널의 namespace와 cgroup이 맡습니다.
2. kube-controller-manager가 멈춰도 이미 떠 있는 파드는 그대로 돕니다. 멈추는 것은 새로 맞추는 일입니다. kind v1.37에서 controller-manager 매니페스트를 빼고 `replicas`를 5로 올렸을 때 파드는 한 개도 늘지 않았고 매니페스트를 되돌리자 1분 안에 5개가 됐습니다.
3. `limits.memory`는 컨테이너를 만들 때 runc가 cgroup의 `memory.max`에 바이트로 적습니다. 사용량이 그 값을 넘으면 커널이 그 cgroup 안에서 OOM killer를 돌립니다. `Exit Code: 137`과 `Reason: OOMKilled`는 kubelet이 끝난 결과를 받아 적은 보고입니다.
4. `limits.cpu: 50m`은 `cpu.max`의 `5000 100000`이 됩니다. kind에서 무한 루프 컨테이너를 2분쯤 돌렸을 때 전체 주기의 91.7%가 스로틀됐습니다. 같은 시점에 kubelet이 내놓은 사용량은 약 50m이라 `kubectl top` 같은 사용량 지표만으로는 정상처럼 보입니다.
5. CKA 비중이 가장 큰 트러블슈팅(30%)에서 쓰는 `kubectl describe`, `crictl`, `journalctl -u kubelet`, `/etc/kubernetes/manifests`는 각각 이 층 구조의 다른 층을 봅니다. 증상이 어느 층에서 생겼는지 알면 어떤 명령부터 칠지 정할 수 있습니다.

이 글은 시리즈의 출발점입니다. 쿠버네티스 쪽은 다음 글 [핵심 오브젝트와 요청 흐름](/blog/cert/cka/cka-01b-core-objects-and-flow)으로 이어지고 커널 쪽은 "쿠버네티스 아래의 리눅스" 시리즈에서 한 기능씩 깊이 들어갑니다. 여기서는 두 시리즈가 만나는 자리를 한 번에 훑어봅니다.

본문의 출력은 2026-10-20에 이 Mac의 colima(arm64 VM, 커널 6.8) 위에 kind v0.33으로 만든 단일 노드 클러스터 `cka-lab-c`(kindest/node:v1.37.0, containerd 2.3.4, runc 1.4.3, cgroup v2)에서 실제로 얻은 값입니다. kind는 노드가 도커 컨테이너라서 경로와 PID가 일반 kubeadm 노드와 조금 다릅니다. 다른 곳은 해당 절에 적었습니다.

---

## 1. 원하는 상태를 적는 API와 그것을 실행하는 노드

### 1-1. spec은 원하는 상태, status는 관측된 상태

공식 문서 "Objects In Kubernetes"는 대부분의 오브젝트가 `spec`과 `status` 두 필드를 가진다고 설명합니다. `spec`은 사용자가 원하는 상태를 적는 곳이고 `status`는 쿠버네티스 시스템과 그 구성요소가 채우고 갱신하는 현재 상태입니다. 쇼핑몰의 상품 목록 API를 Deployment로 띄운다면 이렇게 적습니다.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 3              # 원하는 상태: 파드 3개
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
      - name: nginx
        image: nginx:1.27
```

이 YAML을 `kubectl apply`로 보내면 API 서버는 검증과 승인을 거쳐 etcd에 저장하고 응답합니다. 이 시점에는 파드가 하나도 없습니다. 저장된 것은 "파드 3개"라는 기록뿐이고 파드를 만드는 일은 뒤에서 다른 구성요소가 따로 합니다.

```bash
kubectl get deploy web -o jsonpath='{.spec.replicas} {.status.readyReplicas}{"\n"}'
# 3 3   ← 원하는 수와 관측된 준비 수
```

### 1-2. 컨트롤러는 차이를 계속 메우는 루프

공식 문서 "Controllers"는 컨트롤러를 클러스터 상태를 지켜보다가 필요하면 변경을 만들거나 요청하는 제어 루프로 정의합니다. 각 컨트롤러는 현재 상태를 원하는 상태 쪽으로 옮기려고 합니다. Deployment 하나가 파드가 되기까지 여러 컨트롤러가 이어서 움직입니다.

```
kubectl apply
   │
   ▼
API 서버 ── etcd (spec 저장)
   ▲  watch            ▲ watch            ▲ watch              ▲ watch
   │                   │                  │                    │
Deployment 컨트롤러  ReplicaSet 컨트롤러   kube-scheduler         kubelet(노드마다)
ReplicaSet 생성       파드 오브젝트 생성     파드에 nodeName 기록    자기 노드 파드를 실제로 실행
```

모든 구성요소가 API 서버를 중심으로 watch하는 구조입니다. scheduler와 kubelet도 etcd를 직접 읽지 않습니다. 각자 API 서버에서 오브젝트를 받아 자기 몫의 차이만 메우고 결과를 다시 API 서버에 씁니다.

이 루프는 "파드가 죽었다"는 이벤트 하나하나에 반응하는 방식으로 짜여 있지 않습니다. 원하는 상태와 지금 상태를 비교해서 차이가 있으면 메웁니다. 그래서 루프가 잠시 멈췄다 다시 돌아도 그동안 놓친 이벤트를 복구할 필요가 없습니다. 2장에서 이 성질을 직접 확인합니다.

### 1-3. 노드에서 상태를 바꾸는 층

API 서버에 기록된 파드가 노드의 프로세스가 되기까지 네 층을 지납니다.

| 층 | kind 노드에서 확인한 실체 | 이 층이 하는 일 |
|---|---|---|
| kubelet | `kubelet` 프로세스(v1.37.0) | API 서버에서 자기 노드 파드를 받아 CRI로 런타임을 호출하고 상태를 보고 |
| CRI 런타임 | containerd 2.3.4 | 이미지를 받아 스냅샷을 만들고 OCI 런타임 스펙(config.json)을 작성 |
| OCI 런타임 | runc 1.4.3 | 스펙대로 namespace를 만들고 cgroup 파일에 한도를 적은 뒤 컨테이너 프로세스를 실행 |
| 리눅스 커널 | 6.8.0 (colima VM) | namespace로 보이는 범위를 나누고 cgroup으로 자원을 세고 막음 |

kubelet과 런타임 사이의 표준이 CRI(Container Runtime Interface)입니다. 쿠버네티스는 v1.5에서 CRI를 들여왔고 Docker Engine은 그동안 kubelet 안의 dockershim을 거쳐 붙었습니다. dockershim은 v1.20에서 deprecated, v1.24에서 제거됐습니다. 지금 노드는 containerd나 CRI-O처럼 CRI를 직접 구현한 런타임을 씁니다. 바뀐 것은 kubelet이 런타임에 닿는 경로이고 컨테이너 이미지 형식과 컨테이너 자체는 그대로입니다.

```bash
kubectl get nodes -o wide
# NAME                      STATUS   ...  KERNEL-VERSION              CONTAINER-RUNTIME
# cka-lab-c-control-plane   Ready    ...  6.8.0-117-generic (arm64)   containerd://2.3.4
```

kind 노드는 컨테이너라서 `KERNEL-VERSION`에는 호스트 VM의 커널 버전이 찍힙니다. 클러스터 안의 모든 컨테이너가 이 커널 하나를 함께 씁니다.

### 1-4. 직접 해 보기

```bash
kind create cluster --name lab --image kindest/node:v1.37.0
kubectl create deployment web --image=nginx:1.27 --replicas=3
kubectl delete pod -l app=web --wait=false      # 세 개를 한꺼번에 삭제
kubectl get pods -l app=web -w                  # 새 이름의 파드 세 개가 다시 뜨는지
kubectl get rs                                  # DESIRED 3이 그대로인지
```

확인할 것은 두 가지입니다. 파드 이름이 바뀐다는 점과 ReplicaSet의 `DESIRED`가 그대로라는 점입니다. 새 이름은 컨트롤러가 원하는 수 3과 실제 수 0의 차이를 보고 파드 3개를 새로 만들었다는 표시입니다.

---

## 2. kube-controller-manager가 멈춘 동안 계속되는 일과 멈추는 일

ReplicaSet, Deployment, Node, Job 같은 내장 컨트롤러는 kube-controller-manager라는 프로세스 하나에 묶여 컨트롤 플레인에서 돕니다. 이 프로세스가 멈추면 무엇이 멈추는지 알아 두면 "스케일했는데 파드가 늘지 않는다" 같은 증상을 바로 좁힐 수 있습니다.

### 2-1. kubeadm 계열 클러스터에서 controller-manager는 static Pod

kubeadm으로 만든 클러스터(kind도 내부에서 kubeadm을 씁니다)는 API 서버, controller-manager, scheduler, etcd를 static Pod로 띄웁니다.

```bash
docker exec cka-lab-c-control-plane ls /etc/kubernetes/manifests
# etcd.yaml
# kube-apiserver.yaml
# kube-controller-manager.yaml
# kube-scheduler.yaml
```

공식 문서 "Create static Pods"에 따르면 static Pod는 API 서버가 관리하지 않고 그 노드의 kubelet이 직접 관리합니다. kubelet은 이 디렉터리의 파일을 읽어 컨테이너를 띄우고 API 서버에는 보기용 미러 파드만 만듭니다. 미러 파드의 메타데이터에서 출처를 확인할 수 있습니다.

```bash
kubectl get pod -n kube-system kube-controller-manager-cka-lab-c-control-plane \
  -o jsonpath='{.metadata.annotations.kubernetes\.io/config\.source}{"\n"}{.metadata.ownerReferences}{"\n"}'
# file
# [{"apiVersion":"v1","controller":true,"kind":"Node","name":"cka-lab-c-control-plane",...}]
```

`config.source`가 `file`이고 소유자는 Node입니다. 그래서 controller-manager 컨테이너가 죽으면 그 노드의 kubelet이 다시 띄웁니다. 컨트롤러를 띄우는 데 컨트롤러가 필요 없는 구조입니다.

### 2-2. 실측: 매니페스트를 빼고 스케일하기

static Pod를 멈추는 가장 확실한 방법은 매니페스트 파일을 디렉터리 밖으로 옮기는 것입니다. kubelet이 파일이 사라진 것을 보고 컨테이너를 내립니다. 그 상태에서 Deployment를 3개에서 5개로 늘리고 파드 하나를 지웠습니다.

```bash
docker exec cka-lab-c-control-plane mv /etc/kubernetes/manifests/kube-controller-manager.yaml /root/
docker exec cka-lab-c-control-plane crictl ps -a --name kube-controller-manager
# CONTAINER      ...  STATE    NAME                      ...
# eabfa31cc98ca  ...  Exited   kube-controller-manager   ...

kubectl scale deployment web --replicas=5
kubectl delete pod web-69c6f74b8b-bxxtm
# 20초 기다린 뒤
kubectl get deploy web
# NAME   READY   UP-TO-DATE   AVAILABLE   AGE
# web    3/5     3            3           2m22s
kubectl get rs
# NAME             DESIRED   CURRENT   READY   AGE
# web-69c6f74b8b   3         3         3       2m22s
kubectl get pods -l app=web
# NAME                   READY   STATUS    RESTARTS   AGE
# web-69c6f74b8b-jdrk2   1/1     Running   0          2m22s
# web-69c6f74b8b-vgg57   1/1     Running   0          2m22s
```

출력 세 개가 서로 맞지 않습니다. Deployment의 `spec.replicas`는 5로 바뀌었지만 Deployment 컨트롤러가 없어서 ReplicaSet의 `DESIRED`는 3에 머물렀습니다. 실제 파드는 2개인데 ReplicaSet과 Deployment의 `status`는 3을 가리킵니다. `status`를 갱신하는 주체도 컨트롤러라서 컨트롤러가 멈추면 `status`는 마지막 값으로 굳습니다. 남은 파드 2개는 계속 Running이었습니다.

매니페스트를 되돌리고 40초 뒤에 다시 봤습니다.

```bash
docker exec cka-lab-c-control-plane mv /root/kube-controller-manager.yaml /etc/kubernetes/manifests/
kubectl get deploy web; kubectl get rs; kubectl get pods -l app=web
# web    5/5     5            5           3m10s
# web-69c6f74b8b   5         5         5       3m10s
# web-69c6f74b8b-2q6sh   1/1     Running   0          16s
# web-69c6f74b8b-jdrk2   1/1     Running   0          3m10s
# web-69c6f74b8b-pl9gs   1/1     Running   0          18s
# web-69c6f74b8b-vgg57   1/1     Running   0          3m10s
# web-69c6f74b8b-x4g9n   1/1     Running   0          17s
```

되살아난 controller-manager는 꺼져 있던 동안 무슨 일이 있었는지 묻지 않았습니다. 원하는 수 5와 실제 수 2를 비교해 3개를 새로 만들었을 뿐입니다. 1-2절에서 말한 비교 방식의 루프가 이렇게 동작합니다.

### 2-3. 멈춘 동안의 정리

| 계속되는 일 | 멈추는 일 |
|---|---|
| 이미 떠 있는 파드의 실행(노드의 kubelet과 containerd 담당) | 삭제된 파드를 새로 만들기(ReplicaSet 컨트롤러) |
| 컨테이너가 죽었을 때 같은 파드 안에서 재시작(`restartPolicy`는 kubelet 담당이라 4-6절의 CrashLoopBackOff도 계속됨) | Deployment 롤아웃과 스케일 변경 반영 |
| Service로 들어오는 트래픽 처리(kube-proxy 규칙은 그대로) | Deployment, ReplicaSet 등의 `status` 갱신 |
| scheduler의 배치(이미 만들어진 파드 오브젝트가 있다면) | 응답 없는 노드에 taint를 붙이고 파드를 축출하는 일(node lifecycle 컨트롤러와 taint-eviction 컨트롤러) |

### 2-4. 여러 대일 때는 Lease로 리더 하나만 일함

운영 클러스터는 컨트롤 플레인을 보통 여러 대 두고 controller-manager도 여러 개 띄웁니다. 실제로 루프를 돌리는 것은 리더 하나입니다. `--leader-elect=true`(kind 매니페스트 24행에서 확인)로 켜지는 리더 선출은 `kube-system`의 Lease 오브젝트로 합니다. 리더가 Lease를 계속 갱신하고 갱신이 끊기면 대기 중이던 인스턴스가 가져갑니다.

```bash
kubectl get lease -n kube-system kube-controller-manager -o jsonpath='{.spec.holderIdentity}{"\n"}'
# 멈추기 전: cka-lab-c-control-plane_faaada92-71f1-4d8c-a1dc-f99925855c7e
# 되돌린 뒤: cka-lab-c-control-plane_371fbbf5-7763-4a2f-9a93-0f58b2f0050f
```

단일 노드라 같은 노드 이름 뒤의 식별자만 바뀌었습니다. 새 프로세스가 리더를 새로 잡았다는 뜻입니다.

### 2-5. 누가 누구를 다시 띄우는지

```
ReplicaSet 컨트롤러 등      ← kube-controller-manager 프로세스 안에서 돎
kube-controller-manager    ← kubelet이 static Pod로 다시 띄움
kubelet                    ← systemd 유닛(kind 노드에서 Restart=always, RestartUSec=1s 확인)
systemd                    ← PID 1
```

맨 아래에는 결국 커널 위의 PID 1이 있습니다. 이 사슬의 어느 고리가 끊겼는지에 따라 보는 곳이 달라집니다. 컨트롤러 동작이 이상하면 `kube-system` 파드를 보고 API 서버까지 죽어 kubectl이 안 되면 노드에서 `crictl`을, kubelet 자체가 안 뜨면 `journalctl -u kubelet`을 봅니다.

### 2-6. 노드 전체가 응답을 멈추면 약 50초 + 5분

노드가 상태 갱신을 멈추면 node lifecycle 컨트롤러가 `--node-monitor-grace-period`(현재 기본 50초, 예전 기본 40초)가 지난 뒤 노드 조건을 `Unknown`으로 바꾸고 `node.kubernetes.io/unreachable` taint를 붙입니다. 노드가 응답은 하지만 준비되지 않았다고 보고하면 `node.kubernetes.io/not-ready`가 붙습니다. 파드에는 `DefaultTolerationSeconds` 어드미션 플러그인이 넣은 300초 toleration이 기본으로 있습니다. 그래서 기본 설정에서는 약 50초에 300초를 더한 뒤 그 노드의 파드가 삭제됩니다.

```bash
kubectl get pod <파드> -o jsonpath='{.spec.tolerations}' | jq
# node.kubernetes.io/not-ready, node.kubernetes.io/unreachable 두 항목에
# "effect":"NoExecute", "tolerationSeconds":300 이 들어 있는지 확인
```

파드 삭제는 v1.34부터 별도의 taint-eviction 컨트롤러(KEP-3902 GA)가 맡습니다. 지워진 파드를 다른 노드에 새로 만드는 쪽은 ReplicaSet 같은 워크로드 컨트롤러입니다. StatefulSet 파드는 같은 이름의 파드가 동시에 둘 생기면 안 되므로 노드가 지워지거나 상태가 확인될 때까지 재생성이 막힐 수 있습니다. 이 축출 과정 전체가 controller-manager 안에서 일어나므로 2-2절처럼 controller-manager가 멈춘 동안에는 일어나지 않습니다.

### 2-7. 직접 해 보기

```bash
# 1) 2-2절 재현: 매니페스트를 빼고 스케일, 다시 넣고 관찰
docker exec <클러스터>-control-plane mv /etc/kubernetes/manifests/kube-controller-manager.yaml /root/
kubectl scale deployment web --replicas=5
kubectl get deploy,rs,pods -l app=web
docker exec <클러스터>-control-plane mv /root/kube-controller-manager.yaml /etc/kubernetes/manifests/

# 2) API 서버까지 멈춘 상황에서 노드 쪽 도구로 컨테이너 상태 보기
docker exec <클러스터>-control-plane crictl ps -a --name kube-apiserver
docker exec <클러스터>-control-plane journalctl -u kubelet --since "5 min ago" | tail
```

kubeadm 노드라면 `docker exec` 대신 SSH로 들어가 `sudo`를 붙여 같은 명령을 씁니다. 매니페스트의 들여쓰기나 플래그 이름을 일부러 틀리게 고친 뒤 `crictl ps -a`에서 Exited가 반복되는 것과 `crictl logs`로 원인 메시지를 찾는 연습도 해 볼 만합니다. 시험의 컨트롤 플레인 트러블슈팅이 이 모양입니다.

---

## 3. 노드 안에서 보는 컨테이너: 프로세스와 namespace, cgroup

커널에는 "컨테이너"라는 자료구조가 없습니다. 커널이 아는 것은 프로세스(`task_struct`)와 그 프로세스가 속한 namespace 묶음, 그리고 cgroup입니다. 런타임이 이 둘과 루트 파일시스템을 조합한 결과를 사람이 컨테이너라고 부릅니다. 이 장에서는 4장과 5장 실습에 쓸 파드 하나를 노드 안에서 끝까지 따라갑니다.

### 3-1. 실습 파드와 컨테이너 PID 찾기

CPU 한도 50m인 무한 루프 컨테이너입니다. requests와 limits를 CPU, 메모리 모두 같게 두어 QoS 클래스가 Guaranteed가 되게 했습니다.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: cpu-capped
spec:
  containers:
  - name: spin
    image: busybox:1.36
    command: ["sh", "-c", "while true; do :; done"]
    resources:
      requests:
        cpu: "50m"
        memory: "32Mi"
      limits:
        cpu: "50m"
        memory: "32Mi"
```

노드 안에서 `crictl`로 컨테이너 ID를 찾고 `crictl inspect`로 런타임이 기록한 PID와 cgroup 경로를 꺼냅니다. kind에서는 `docker exec -it <노드> bash`로 들어간 뒤 실행합니다.

```bash
CID=$(crictl ps --name spin -q)
PID=$(crictl inspect $CID | jq .info.pid)
echo $PID
# 2920
crictl inspect $CID | jq '.info.runtimeSpec.linux.resources.cpu'
# {
#   "period": 100000,
#   "quota": 5000,
#   "shares": 51
# }
```

`runtimeSpec`은 containerd가 runc에 넘긴 OCI 스펙입니다. kubelet이 계산한 한도가 여기까지 내려와 있습니다. 같은 파드를 컨테이너 안에서 보면 PID가 다릅니다.

```bash
kubectl exec cpu-capped -- ps
# PID   USER     TIME  COMMAND
#     1 root      0:00 sh -c while true; do :; done
#    14 root      0:00 ps
```

노드에서 2920번인 프로세스가 컨테이너 안에서는 1번입니다. PID namespace가 따로라서 그렇습니다. kind 노드는 그 자체가 도커 컨테이너라서 2920도 노드 컨테이너의 PID namespace 기준 번호입니다. 4-3절의 커널 로그에는 VM 전체 기준 PID가 찍히므로 숫자가 또 다릅니다.

### 3-2. lsns로 보는 namespace 공유 범위

```bash
lsns -p $PID
#         NS TYPE   NPROCS   PID USER  COMMAND
# 4026531837 user       83     1 root  /sbin/init
# 4026534612 time       83     1 root  /sbin/init
# 4026535596 mnt         1  2920 root  sh -c while true; do :; done
# 4026535597 pid         1  2920 root  sh -c while true; do :; done
# 4026535598 cgroup      1  2920 root  sh -c while true; do :; done
# 4026535931 net         2  2890 65535 /pause
# 4026535993 uts         2  2890 65535 /pause
# 4026535994 ipc         2  2890 65535 /pause
```

net, uts, ipc namespace의 대표 프로세스가 PID 2890인 `/pause`이고 프로세스 수가 2입니다. 파드를 만들 때 런타임이 먼저 pause 컨테이너(샌드박스)를 띄워 이 세 namespace를 잡아 두고 앱 컨테이너는 거기에 합류합니다. 같은 파드의 컨테이너끼리 `localhost`로 통신하고 호스트 이름이 같은 이유가 이것입니다. mnt, pid, cgroup은 컨테이너 전용입니다. 파드 스펙에 `shareProcessNamespace: true`를 주면 pid도 파드 단위로 묶입니다. user와 time namespace는 노드의 init과 같아서 이 컨테이너는 user namespace 격리를 쓰지 않습니다.

`/proc/<PID>/ns`의 심볼릭 링크를 노드 셸 자신(`/proc/self/ns`)과 비교해도 같은 결론이 나옵니다. 번호가 같으면 같은 namespace입니다.

### 3-3. /proc/PID/cgroup과 kubepods 계층

```bash
cat /proc/$PID/cgroup
# 0::/kubelet.slice/kubelet-kubepods.slice/kubelet-kubepods-podce56de95_8973_4553_954f_62393f9ba44c.slice/cri-containerd-53e9a7c9...scope
```

cgroup v2는 줄이 하나(`0::`)이고 그 뒤가 통합 계층 안의 경로입니다. 경로를 위에서부터 읽으면 kubelet이 만든 구조가 보입니다.

| 경로 조각 | 의미 |
|---|---|
| `kubelet.slice` | kind는 kubelet 설정에 `cgroupRoot: /kubelet`을 넣습니다. kubeadm 기본값에서는 이 층이 없고 `kubepods.slice`가 맨 위에 옵니다 |
| `kubelet-kubepods.slice` | 모든 파드의 부모. 노드 할당 가능량(allocatable) 한도가 여기에 걸림 |
| `...-pod<UID>.slice` | 파드 하나. Guaranteed 파드는 kubepods 바로 아래, Burstable과 BestEffort는 `kubepods-burstable.slice`, `kubepods-besteffort.slice` 아래에 생김 |
| `cri-containerd-<컨테이너ID>.scope` | 컨테이너 하나 |

`.slice`와 `.scope`라는 이름은 kubelet의 `cgroupDriver: systemd` 때문입니다. kubeadm은 v1.22부터 이 드라이버를 기본으로 씁니다. 실제 파일은 `/sys/fs/cgroup` 아래 같은 경로에 있습니다.

```bash
CG=/sys/fs/cgroup$(cut -d: -f3 /proc/$PID/cgroup)
ls $CG | head
```

4장과 5장에서 이 디렉터리의 `memory.max`, `cpu.max`, `cpu.stat`을 읽습니다.

### 3-4. 루트 파일시스템과 네트워크

namespace와 cgroup 말고도 컨테이너가 성립하려면 두 가지가 더 필요합니다. 이미지 레이어를 하나의 루트로 합쳐 보여 주는 파일시스템과 파드 네트워크 namespace를 노드에 잇는 가상 인터페이스입니다.

```bash
grep " / " /proc/$PID/mountinfo | cut -c1-120
# 6113 6116 0:1331 / / rw,relatime - overlay overlay rw,lowerdir=/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/...

ip -br link | grep veth | head -1          # 노드 쪽 veth 끝
# vethda4594cc@if2 UP  ...
nsenter -t $PID -n ip -br addr             # 파드 쪽 끝
# lo         UNKNOWN  127.0.0.1/8 ::1/128
# eth0@if11  UP       10.244.0.10/24 ...
```

컨테이너의 `/`는 containerd의 overlayfs 스냅샷 디렉터리를 lower로 쓰는 overlay 마운트입니다. 파드의 `eth0`은 노드의 veth 하나와 쌍을 이룹니다. kind의 기본 CNI는 kindnet이라서 다른 CNI(Calico, Cilium 등)와 노드 쪽 구성은 다를 수 있습니다.

| 커널 기능 | 쿠버네티스에서 드러나는 모습 | 이어지는 글 |
|---|---|---|
| 시스템 콜과 커널 경계 | 모든 런타임 동작이 결국 시스템 콜 | [커널 경계](/blog/theory/systems/k8s-linux-01-kernel-boundary) |
| namespace | 파드의 IP와 호스트 이름 공유, 컨테이너 안 PID 1, pause 컨테이너 | [네임스페이스와 pause](/blog/theory/systems/k8s-linux-02-namespaces-pause) |
| cgroup v2 | requests와 limits, QoS, OOMKilled, CPU 스로틀링 | [cgroup과 QoS](/blog/theory/systems/k8s-linux-03-cgroup-qos) |
| overlayfs | 이미지 레이어, 컨테이너 쓰기 계층, 재시작 시 사라지는 파일 | [OverlayFS](/blog/theory/systems/k8s-linux-04-overlayfs) |
| veth, netfilter, conntrack | 파드 네트워크, Service의 가상 IP | [Service, iptables, conntrack](/blog/theory/systems/k8s-linux-05-service-iptables-conntrack) |

mount namespace는 2002년 커널 2.4.19에, cgroup은 2008년 2.6.24에 들어왔습니다. Docker가 처음 공개된 2013년보다 앞섭니다. 컨테이너 도구들은 이 기능들을 조합하는 방법을 표준화했고 쿠버네티스는 그 조합을 여러 노드에 걸쳐 원하는 상태대로 유지합니다.

### 3-5. 직접 해 보기

```bash
docker exec -it <클러스터>-control-plane bash
crictl ps                                       # 컨테이너 목록
crictl pods                                     # 파드 샌드박스 목록
PID=$(crictl inspect $(crictl ps --name <컨테이너이름> -q) | jq .info.pid)
lsns -p $PID                                    # net, uts, ipc가 /pause와 같은지
ls -l /proc/$PID/ns /proc/self/ns               # 번호 비교
cat /proc/$PID/cgroup                           # QoS 클래스별로 경로가 어떻게 다른지
```

BestEffort 파드(resources를 아예 비운 파드)를 하나 더 띄워 경로에 `besteffort`가 들어가는지 비교해 봅니다.

---

## 4. 메모리 한도: 한도를 적는 경로와 한도를 집행하는 경로

### 4-1. 실습 파드

공식 문서 "Assign Memory Resources to Containers and Pods"의 한도 초과 예제와 같은 구성입니다. 한도는 100Mi인데 컨테이너는 250M을 할당하려 합니다.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: mem-over
spec:
  containers:
  - name: stress
    image: polinux/stress
    command: ["stress"]
    args: ["--vm", "1", "--vm-bytes", "250M", "--vm-hang", "1"]
    resources:
      requests:
        memory: "50Mi"
      limits:
        memory: "100Mi"
```

```bash
kubectl get pod mem-over
# NAME       READY   STATUS      RESTARTS      AGE
# mem-over   0/1     OOMKilled   1 (24s ago)   37s
kubectl describe pod mem-over
#     State:          Terminated
#       Reason:       OOMKilled
#       Exit Code:    137
#     Last State:     Terminated
#       Reason:       OOMKilled
#       Exit Code:    137
#     Restart Count:  2
```

### 4-2. 설정 경로: 컨테이너를 만들 때 한 번

```
kubelet        limits.memory 100Mi를 바이트로 계산
  → containerd   OCI 스펙의 linux.resources.memory.limit = 104857600 기록
  → runc         컨테이너 cgroup의 memory.max에 104857600 기록
```

종료된 컨테이너의 런타임 스펙에 이 값이 남아 있습니다.

```bash
C=$(crictl ps -a --name stress -q --state exited | head -1)
crictl inspect $C | jq '.status.exitCode, .status.reason, .info.runtimeSpec.linux.resources.memory, .info.runtimeSpec.process.oomScoreAdj'
# 137
# "OOMKilled"
# {
#   "limit": 104857600,
#   "swap": 104857600
# }
# 995
```

`swap`이 `limit`과 같은 값이라는 것은 스왑을 추가로 허용하지 않는다는 뜻입니다. 파드 단위 cgroup에도 같은 한도가 걸립니다. 모든 컨테이너에 limits가 있으면 kubelet이 파드 slice의 `memory.max`에 그 합을 적습니다.

```bash
cat /sys/fs/cgroup/kubelet.slice/kubelet-kubepods.slice/kubelet-kubepods-burstable.slice/kubelet-kubepods-burstable-pod64fecf23_....slice/memory.max
# 104857600
```

### 4-3. 집행 경로: 한도에 닿았을 때

```
프로세스가 메모리를 더 요청
  → 커널이 그 cgroup에서 회수(reclaim) 시도
  → 회수해도 한도 안으로 못 들어오면 그 cgroup 안에서 OOM killer 실행
  → 희생자에게 SIGKILL
  → containerd가 종료 이벤트를 받고 kubelet이 OOMKilled로 보고
```

이 경로에는 kubelet도 containerd도 끼지 않습니다. 판단과 종료는 커널이 혼자 하고 런타임과 kubelet은 끝난 뒤에 결과를 받습니다. 공식 문서 "Resource Management for Pods and Containers"도 한도를 넘은 컨테이너가 즉시 종료되는 것은 아니고 커널이 메모리 압박을 감지할 때 종료된다고 적습니다.

커널 로그에 이 과정이 그대로 남습니다. kind 노드에서 `dmesg -T`로 본 내용을 줄여 옮깁니다(경로 일부는 `...`로 줄임).

```
oom-kill:constraint=CONSTRAINT_MEMCG,...,oom_memcg=/docker/cae0.../kubelet.slice/kubelet-kubepods.slice/kubelet-kubepods-burstable.slice/kubelet-kubepods-burstable-pod64fecf23_....slice,task_memcg=/docker/cae0.../...pod64fecf23_....slice/cri-containerd-8bf7c339....scope,task=stress,pid=2297318,uid=0
Memory cgroup out of memory: Killed process 2297318 (stress) total-vm:558664kB, anon-rss:101072kB, ... oom_score_adj:995
Tasks in /docker/cae0.../cri-containerd-8bf7c339....scope are going to be killed due to memory.oom.group set
Memory cgroup out of memory: Killed process 2297251 (stress) total-vm:302656kB, anon-rss:512kB, ... oom_score_adj:995
```

읽을 곳은 네 군데입니다.

- `constraint=CONSTRAINT_MEMCG`: 노드 전체 메모리가 아닌 cgroup 한도 때문에 일어난 OOM입니다.
- `oom_memcg`: 한도에 닿은 cgroup입니다. 이 실행에서는 파드 slice가 찍혔습니다. 컨테이너가 하나뿐이라 파드 한도와 컨테이너 한도가 둘 다 100Mi입니다.
- `anon-rss:101072kB`: 죽은 프로세스의 익명 메모리가 약 98.7MiB로 한도 100Mi 바로 아래입니다.
- `oom_score_adj:995`와 `/docker/cae0...` 접두어: 4-5절에서 다룰 점수와 kind 노드가 도커 컨테이너라는 흔적입니다. PID 2297318은 VM 기준 번호입니다.

로그를 못 보는 환경이면 cgroup의 이벤트 카운터로도 확인할 수 있습니다.

```bash
cat <파드 slice>/memory.events
# low 0
# high 0
# max 139
# oom 5
# oom_kill 15
# oom_group_kill 5
```

`max`는 한도에 닿은 횟수, `oom`은 OOM killer가 돈 횟수, `oom_kill`은 죽은 프로세스 수입니다. 다섯 번의 OOM에서 프로세스 15개가 죽었습니다. 다음 절의 `memory.oom.group` 때문에 한 번에 여러 프로세스가 함께 죽습니다.

### 4-4. 137은 128 + 9

```
137 = 128 + 9 (SIGKILL)
```

셸과 컨테이너 런타임은 시그널 N으로 끝난 프로세스의 종료 코드를 128+N으로 적는 관례를 따릅니다(bash 매뉴얼의 EXIT STATUS). 그래서 128보다 큰 값이면 시그널로 끝났을 가능성이 높습니다. 다만 프로세스가 직접 `exit(137)`을 불러도 같은 값이 나오므로 137만 보고 OOM이라고 단정하면 안 됩니다. OOM 여부는 kubelet이 따로 적는 `Reason: OOMKilled`로 판단합니다. SIGKILL은 프로세스가 잡거나 무시할 수 없어서 애플리케이션의 종료 훅이 돌 기회가 없습니다.

### 4-5. memory.oom.group과 oom_score_adj

cgroup v2 노드에서 kubelet은 컨테이너 cgroup에 `memory.oom.group`을 1로 켭니다. 3-1절의 Guaranteed 파드 컨테이너에서 이 값을 읽으면 1이 나옵니다. 그래서 OOM이 나면 그 컨테이너의 프로세스 전체가 함께 끝납니다. 위 커널 로그의 "going to be killed due to memory.oom.group set"이 이 동작입니다. 예전처럼 프로세스 하나만 죽이려면 kubelet 설정 `singleProcessOOMKill: true`를 씁니다(기본값 false).

`oom_score_adj`는 -1000에서 +1000 사이 값으로 OOM killer가 누구를 먼저 고를지 조정합니다. -1000이면 대상에서 빠집니다. 커널은 메모리 사용량으로 0~1000의 기본 점수를 매기고 여기에 adj를 더하므로 `/proc/<pid>/oom_score`의 실질 범위는 0~2000입니다. kubelet은 QoS 클래스에 따라 이 값을 넣습니다.

| 대상 | oom_score_adj | 이 클러스터에서 확인한 값 |
|---|---|---|
| Guaranteed 컨테이너 | -997 | `cpu-capped`: -997 |
| Burstable 컨테이너 | `1000 - (1000 × 메모리 request) / 노드 메모리 용량`을 하한과 999 사이로 맞춤 | `mem-over`: 995 |
| BestEffort 컨테이너 | 1000 | resources 없이 띄운 `be`: 1000 |
| kubelet, containerd 데몬 | -999 | 둘 다 -999 |

`mem-over`의 995는 계산과 맞습니다. 노드 메모리 용량은 `10161128Ki`이고 request는 50Mi(51200Ki)입니다. 1000 × 51200 / 10161128은 정수 나눗셈으로 5이고 1000에서 빼면 995입니다. Burstable의 하한은 공식 문서 공식에서 2이고 kubelet 코드는 3으로 맞춥니다. 메모리 request가 없는 Burstable 파드는 999가 됩니다.

이 점수는 노드 전체 메모리가 바닥났을 때 의미가 큽니다. cgroup 한도에 걸린 OOM은 그 cgroup 안에서만 고르기 때문입니다.

| 종류 | 누가 판단하는지 | 범위 | 파드에 보이는 모습 |
|---|---|---|---|
| cgroup OOM | 커널, 해당 cgroup의 `memory.max` 기준 | 그 cgroup 안의 프로세스 | 컨테이너 `OOMKilled`, 같은 파드에서 재시작 |
| 노드 OOM | 커널, 노드 전체 메모리 기준 | 노드의 모든 프로세스 중 점수 높은 쪽 | 점수 높은 컨테이너부터 `OOMKilled` |
| 노드 압박 축출(eviction) | kubelet, `memory.available`이 임계값(기본 hard 임계 `memory.available<100Mi`) 아래 | 파드 단위 | 파드가 `Failed`, `reason: Evicted` |

kubelet의 `memory.available`은 `/proc/meminfo`의 MemAvailable이 아닌 cgroup의 working set(비활성 파일 캐시 제외)으로 계산합니다. 그래서 `free` 숫자와 축출 시점이 어긋날 수 있습니다. 축출은 kubelet이 결정하는 유일한 경우이고 나머지 둘은 커널이 결정합니다.

### 4-6. 같은 파드 안에서의 재시작과 CrashLoopBackOff

`restartPolicy`의 기본값은 `Always`라서 kubelet은 OOM으로 끝난 컨테이너를 같은 파드 안에서 다시 시작합니다. 파드 오브젝트와 샌드박스(pause, IP)는 그대로입니다. 다시 250M을 잡으면 또 죽으므로 kubelet은 재시작 사이에 간격을 둡니다. 공식 문서 "Pod Lifecycle" 기준으로 간격은 10초에서 시작해 두 배씩 늘고 300초에서 멈춥니다. 컨테이너가 10분 동안 문제없이 돌면 간격이 초기화됩니다. 기다리는 동안의 상태가 `CrashLoopBackOff`이고 이벤트에는 이렇게 남습니다.

```
Warning   BackOff   pod/mem-over   Back-off restarting failed container stress in pod mem-over_default(...)
```

버전별 변화가 둘 있습니다. v1.35부터 `KubeletCrashLoopBackOffMax`(KEP-5593)가 베타로 기본 켜져 있어서 kubelet 설정 `crashLoopBackOff.maxContainerRestartPeriod`로 노드별 상한을 1초~300초 사이로 낮출 수 있습니다. 시작값을 1초, 상한을 60초로 줄이는 `ReduceDefaultCrashLoopBackOffDecay`(KEP-4603)는 v1.33에 알파로 들어왔고 기본으로 꺼져 있습니다.

### 4-7. 직접 해 보기

```bash
kubectl apply -f mem-over.yaml
kubectl get pod mem-over -w                     # OOMKilled와 CrashLoopBackOff가 번갈아 나오는지
kubectl get pod mem-over -o jsonpath='{.status.qosClass} {.status.containerStatuses[0].lastState}{"\n"}'
docker exec <클러스터>-control-plane bash -c 'dmesg -T | grep -iE "oom|killed process" | tail -5'
# 파드 slice 경로를 찾아 memory.max와 memory.events 읽기
UIDP=$(kubectl get pod mem-over -o jsonpath='{.metadata.uid}' | tr - _)
docker exec <클러스터>-control-plane bash -c "P=\$(find /sys/fs/cgroup -type d -name '*pod$UIDP.slice'); cat \$P/memory.max \$P/memory.events"
```

requests를 지운 버전(BestEffort가 되도록 limits도 함께 지움)과 비교해 `oomScoreAdj`가 어떻게 바뀌는지 봅니다. kind 노드는 colima나 Docker Desktop VM의 메모리를 나눠 쓰므로 노드 OOM을 일부러 일으키는 실험은 VM 전체를 불안정하게 만들 수 있습니다. 그 실험은 버려도 되는 리눅스 VM에서 합니다.

---

## 5. CPU 한도: cpu.max와 스로틀링

메모리는 넘으면 죽고 CPU는 넘으면 기다립니다. CPU 한도에 걸린 컨테이너는 종료되지 않고 에러 로그도 남기지 않으면서 느려지기만 합니다. 그래서 원인을 찾는 데 오래 걸립니다.

### 5-1. limits.cpu는 cpu.max, requests.cpu는 cpu.weight

3-1절의 `cpu-capped` 파드 cgroup을 읽었습니다.

```bash
cat $CG/cpu.max $CG/cpu.weight $CG/memory.max $CG/memory.oom.group
# 5000 100000
# 11
# 33554432
# 1
```

`cpu.max`의 두 숫자는 quota와 period(마이크로초)입니다. 100,000μs(100ms) 주기마다 5,000μs(5ms)까지 CPU를 쓸 수 있다는 뜻이고 50m = 0.05코어 × 100ms = 5ms와 맞습니다. 한도가 없으면 이 파일은 `max 100000`입니다. `memory.max`의 33554432는 32Mi입니다.

`cpu.weight`는 CPU가 부족할 때 형제 cgroup 사이에서 시간을 나누는 비율입니다. kubelet은 requests.cpu를 cgroup v1 시절 단위인 shares로 바꾸고(50m × 1024 / 1000 = 51) OCI 런타임이 그것을 v2의 weight로 바꿉니다. 이 변환식이 2026년에 바뀌었습니다. 새 식(runc 1.3.2 이상, crun 1.23 이상)에서 shares 51은 11이 되고 옛 식 `1 + (shares - 2) × 9999 / 262142`로는 2가 됩니다. 이 클러스터에서 컨테이너 scope는 11이었고 파드 slice는 2였습니다. 두 층을 서로 다른 코드가 쓰기 때문에 생긴 차이로 보입니다. 같은 파드 안에서는 형제가 컨테이너뿐이라 동작에 영향은 없지만 cgroup 파일을 직접 비교할 때 혼동하기 쉬운 부분입니다.

### 5-2. 스케줄러가 바뀌어도 cpu.max는 그대로

쿠버네티스의 밀리코어는 커널의 fair 스케줄링 클래스가 처리합니다. 이 자리의 기본 스케줄러는 오랫동안 CFS(Completely Fair Scheduler)였고 커널 6.6부터 EEVDF로 바뀌었습니다. EEVDF가 바꾼 것은 실행 대기 중인 태스크 가운데 누구를 먼저 돌릴지 고르는 정책입니다. cgroup 단위로 쓸 수 있는 시간을 막는 기능은 커널 문서에서 여전히 "CFS Bandwidth Control"이라는 이름으로 설명되고 6.6 이후에도 그대로 동작합니다. cgroup v2에서 그 설정 파일이 `cpu.max`입니다. 이 클러스터의 커널 6.8도 EEVDF 이후 커널입니다.

```
한 주기 100ms, quota 5ms
|■■■■■|---------------------------------------------------------|
 5ms 실행           95ms 동안 실행 가능해도 대기(throttled)
```

### 5-3. cpu.stat 실측

파드를 띄우고 약 2분 뒤에 읽은 값입니다.

```bash
cat $CG/cpu.stat
# usage_usec 5900038
# user_usec 5767282
# system_usec 132755
# core_sched.force_idle_usec 0
# nr_periods 1196
# nr_throttled 1097
# throttled_usec 84880525
# nr_bursts 0
# burst_usec 0
```

| 필드 | 뜻(커널 cgroup-v2 문서) | 값 |
|---|---|---|
| `usage_usec` | 사용한 CPU 시간 | 5.90초 |
| `nr_periods` | 지나간 집행 주기 수 | 1,196 |
| `nr_throttled` | 그중 quota를 다 써서 멈춘 주기 수 | 1,097 |
| `throttled_usec` | 멈춰 있던 시간의 합 | 84.9초 |

스로틀 비율은 1,097 / 1,196 ≈ 91.7%입니다. 주기 1,196개는 약 119.6초이고 그동안 쓴 CPU는 5.90초라서 사용률은 약 4.9%입니다. 한도 5%와 거의 같습니다. `nr_periods`, `nr_throttled`, `throttled_usec`는 cpu 컨트롤러에 한도가 걸려 있을 때만 의미 있는 값이 나옵니다.

나머지 8%의 주기에서 스로틀이 없었던 이유는 이 값만으로 단정하기 어렵습니다. 주기 안에서 실행 기회 자체를 늦게 받은 경우 등이 섞일 수 있습니다. 숫자는 비율로 보고 한 자리 단위의 차이에 의미를 두지 않는 편이 안전합니다.

### 5-4. kubectl top이 보는 값

kind에는 metrics-server가 없어서 `kubectl top pod`는 `error: Metrics API not available`로 끝납니다. metrics-server가 kubelet에서 읽어 가는 원천은 직접 볼 수 있습니다.

```bash
kubectl get --raw /api/v1/nodes/cka-lab-c-control-plane/proxy/metrics/resource | grep cpu-capped
# container_cpu_usage_seconds_total{container="spin",namespace="default",pod="cpu-capped"} 6.515469 ...
# container_memory_working_set_bytes{container="spin",namespace="default",pod="cpu-capped"} 311296 ...
# (스로틀 관련 항목 없음)

kubectl get --raw /api/v1/nodes/cka-lab-c-control-plane/proxy/stats/summary \
  | jq '.pods[] | select(.podRef.name=="cpu-capped") | .containers[0].cpu.usageNanoCores'
# 49807187
```

kubelet이 내놓는 CPU 값은 누적 사용 시간 하나뿐입니다. metrics-server는 이것을 수집 간격(기본 15초) 사이의 변화량으로 나눠 사용률을 만듭니다. summary API의 `usageNanoCores` 49,807,187은 약 49.8m이고 metrics-server가 있었다면 `kubectl top`에 `50m` 근처로 보였을 값입니다. 한도가 50m이니 "한도 안에서 잘 돌고 있다"로 읽히기 쉽습니다. 실제로는 91.7%의 주기에서 멈추고 있었습니다. 100ms 단위로 일어나는 멈춤은 15초 구간 평균에 묻히고 스로틀 카운터는 이 경로로 아예 전달되지 않습니다. metrics-server README도 이 지표를 오토스케일링용으로 만들었고 모니터링 용도가 아니라고 밝힙니다.

같은 summary 응답에는 CPU PSI(pressure stall information)도 들어 있었습니다. `some.avg10`이 68.51로 최근 10초 동안 실행할 수 있는데 CPU를 기다린 시간 비율이 약 69%였다는 뜻입니다. 스로틀링을 대기 시간 쪽에서 보여 주는 지표입니다.

### 5-5. 스로틀링을 보는 메트릭

kubelet에 내장된 cAdvisor는 `cpu.stat`의 값을 Prometheus 형식으로 내보냅니다.

```bash
kubectl get --raw /api/v1/nodes/cka-lab-c-control-plane/proxy/metrics/cadvisor \
  | grep -E '^container_cpu_cfs_(periods|throttled_periods|throttled_seconds)_total' | grep 'pod="cpu-capped"'
# container_cpu_cfs_periods_total{container="spin",...,pod="cpu-capped"} 1137
# container_cpu_cfs_throttled_periods_total{container="spin",...,pod="cpu-capped"} 1038
# container_cpu_cfs_throttled_seconds_total{container="spin",...,pod="cpu-capped"} 79.569924
```

1,038 / 1,137 ≈ 91.3%로 `cpu.stat`에서 직접 계산한 비율과 같은 수준입니다(읽은 시점이 몇 초 다름). Prometheus를 쓰는 환경이라면 `rate(container_cpu_cfs_throttled_periods_total[5m]) / rate(container_cpu_cfs_periods_total[5m])`로 컨테이너별 스로틀 비율을 봅니다. 대시보드의 스로틀링 그래프가 결국 커널의 `nr_periods`와 `nr_throttled`에서 나온다는 점을 알면 숫자가 이상할 때 노드에서 `cpu.stat`을 직접 읽어 대조할 수 있습니다.

### 5-6. 직접 해 보기

```bash
kubectl apply -f cpu-capped.yaml
# 1분 간격으로 두 번 읽어 증가분으로 비율 계산
docker exec <클러스터>-control-plane bash -c '
PID=$(crictl inspect $(crictl ps --name spin -q) | jq .info.pid)
CG=/sys/fs/cgroup$(cut -d: -f3 /proc/$PID/cgroup)
cat $CG/cpu.max; grep -E "nr_periods|nr_throttled|usage_usec" $CG/cpu.stat'
```

`limits.cpu`를 `500m`과 `1`로 바꿔 다시 만들고 비율이 어떻게 변하는지 봅니다. 무한 루프는 스레드 하나라서 한도가 1코어 이상이면 스로틀이 거의 사라져야 합니다. 이어서 `limits.cpu`만 지우고 `requests.cpu`만 남기면 `cpu.max`가 `max 100000`이 되는지 확인합니다.

---

## 6. CKA 공부 전에 이 층을 짚는 이유

### 6-1. 증상이 생긴 층과 처음 칠 명령

CKA의 트러블슈팅 영역은 비중이 30%로 가장 큽니다. 커리큘럼은 클러스터와 노드, 클러스터 구성요소, 리소스 사용량 모니터링, 컨테이너 출력 스트림, 서비스와 네트워킹을 트러블슈팅 대상으로 꼽습니다. 이 글에서 본 층 구조에 증상을 올려 보면 처음 칠 명령이 정해집니다.

| 증상 | 문제가 있는 층 | 처음 볼 것 |
|---|---|---|
| `kubectl`이 아예 응답하지 않음 | API 서버(static Pod) | 노드에서 `crictl ps -a`, `crictl logs`, `/etc/kubernetes/manifests/kube-apiserver.yaml` |
| 스케일이나 삭제 후 파드 수가 안 맞음 | controller-manager | `kubectl get pods -n kube-system`, 매니페스트, 2-2절처럼 `status`가 굳어 있는지 |
| 파드가 `Pending`에 머묾 | scheduler 또는 자원 부족 | `kubectl describe pod`의 Events, scheduler 파드 |
| 노드가 `NotReady` | kubelet 또는 런타임 | `systemctl status kubelet`, `journalctl -u kubelet`, `crictl info` |
| `OOMKilled`, Exit 137 | 커널의 cgroup OOM | `describe`의 Last State, `memory.events`, `dmesg` |
| 죽지 않는데 느림 | 커널의 CPU 대역폭 제어 | `cpu.stat`, cAdvisor의 `container_cpu_cfs_*` |
| 파드 사이 통신 실패 | CNI, kube-proxy, 커널 netfilter | [CKA Ch-04](/blog/cert/cka/cka-04-services-networking)와 커널 시리즈 5편 |

시험장 노드에서 cgroup 파일까지 읽을 일은 드뭅니다. 그래도 `OOMKilled`가 커널이 끝낸 일을 kubelet이 적은 결과라는 것을 알면 실제 사용량과 requests, limits의 관계부터 확인하게 됩니다. 컨트롤 플레인이 static Pod라는 것을 알면 kubectl이 안 될 때 노드로 내려갈 생각을 바로 하게 됩니다.

### 6-2. 이어지는 글

| 다음에 볼 것 | 글 |
|---|---|
| 파드, Deployment, Service가 API 서버를 거쳐 노드에 닿는 흐름 | [CKA Ch-01b 핵심 오브젝트와 요청 흐름](/blog/cert/cka/cka-01b-core-objects-and-flow) |
| 컨트롤 플레인 구성, kubeadm 설치와 업그레이드 | [CKA Ch-02 클러스터 아키텍처](/blog/cert/cka/cka-02-cluster-architecture) |
| requests, limits, QoS를 시험 관점에서 | [CKA Ch-03 워크로드와 스케줄링](/blog/cert/cka/cka-03-workloads-scheduling) |
| 증상별 트러블슈팅 절차 | [CKA Ch-06 트러블슈팅](/blog/cert/cka/cka-06-troubleshooting) |
| 커널 쪽을 한 기능씩 | [커널 경계](/blog/theory/systems/k8s-linux-01-kernel-boundary), [네임스페이스와 pause](/blog/theory/systems/k8s-linux-02-namespaces-pause), [cgroup과 QoS](/blog/theory/systems/k8s-linux-03-cgroup-qos), [OverlayFS](/blog/theory/systems/k8s-linux-04-overlayfs), [Service와 iptables, conntrack](/blog/theory/systems/k8s-linux-05-service-iptables-conntrack) |

---

## 확인 문제

**1.** Deployment의 `spec.replicas`를 3에서 5로 바꿨는데 `kubectl get rs`의 `DESIRED`가 3에 머물러 있습니다. 가장 먼저 의심할 구성요소와 확인 명령은 무엇입니까?

<details><summary>정답</summary>

kube-controller-manager입니다. Deployment 컨트롤러가 ReplicaSet의 `spec.replicas`를 바꾸는데 그 컨트롤러가 controller-manager 안에서 돕니다. `kubectl get pods -n kube-system`으로 controller-manager 파드 상태를 보고 kubeadm 클러스터라면 `/etc/kubernetes/manifests/kube-controller-manager.yaml`을 확인합니다. 2-2절 실측처럼 이 상태에서는 `status` 필드도 마지막 값으로 굳어 실제 파드 수와 다르게 보입니다.

</details>

**2.** controller-manager가 멈춘 동안 다음 중 계속 일어나는 일을 고르십시오. (가) 지운 파드의 재생성 (나) OOM으로 끝난 컨테이너의 같은 파드 안 재시작 (다) 응답 없는 노드의 파드 축출 (라) Service로 들어온 요청의 전달

<details><summary>정답</summary>

(나)와 (라)입니다. 컨테이너 재시작은 노드의 kubelet이 `restartPolicy`에 따라 하고 Service 전달은 각 노드에 이미 깔린 kube-proxy 규칙과 커널이 처리합니다. (가)는 ReplicaSet 컨트롤러, (다)는 node lifecycle 컨트롤러와 taint-eviction 컨트롤러가 하므로 멈춥니다.

</details>

**3.** 컨테이너가 Exit Code 137로 끝났습니다. 이것만으로 메모리 부족이라고 말할 수 있습니까?

<details><summary>정답</summary>

말할 수 없습니다. 137은 128+9, 즉 SIGKILL로 끝났을 가능성이 높다는 관례적 표시입니다. 프로세스가 직접 `exit(137)`을 불러도 같은 값이 나오고 SIGKILL은 OOM 말고도 다른 이유로 보내질 수 있습니다. kubelet이 적는 `Reason: OOMKilled`, 노드의 `memory.events`의 `oom_kill` 증가, 커널 로그의 `Memory cgroup out of memory`로 확인합니다.

</details>

**4.** `limits.memory: 100Mi`인 컨테이너가 한도를 넘었을 때 SIGKILL을 보내는 주체는 누구이고 kubelet은 그 과정에서 무엇을 합니까?

<details><summary>정답</summary>

리눅스 커널입니다. 커널이 그 cgroup에서 메모리 회수를 시도하고 실패하면 cgroup 안에서 OOM killer를 돌려 SIGKILL을 보냅니다. kubelet은 컨테이너를 만들 때 한도를 정해 런타임을 거쳐 `memory.max`에 적게 하고(설정 경로) 끝난 뒤 런타임에게서 종료 정보를 받아 `OOMKilled`로 보고합니다. 종료 순간의 판단에는 끼지 않습니다.

</details>

**5.** 메모리 request가 100Mi인 Burstable 컨테이너가 메모리 용량 4GiB(4194304Ki) 노드에 있습니다. kubelet이 넣는 `oom_score_adj`는 얼마입니까?

<details><summary>정답</summary>

976입니다. 100Mi는 102400Ki이고 1000 × 102400 / 4194304 ≈ 24.4라서 정수로 24입니다. 1000 - 24 = 976이고 하한과 999 사이에 있으므로 그대로 씁니다.

</details>

**6.** `limits.cpu: 200m`인 컨테이너의 `cpu.max`에는 무엇이 적힙니까? 이 컨테이너가 스레드 4개로 CPU를 계속 쓰려 하면 한 주기 안에서 어떻게 됩니까?

<details><summary>정답</summary>

`20000 100000`입니다. 0.2코어 × 100ms = 20ms입니다. quota는 cgroup 전체에 걸리므로 스레드 4개가 동시에 돌면 20ms를 약 5ms 만에 함께 써 버리고 남은 약 95ms 동안 모두 멈춥니다. 스레드 수가 많을수록 주기 초반에 quota를 빨리 소진해 스로틀이 잦아집니다.

</details>

**7.** `kubectl top pod`가 한도와 같은 `50m`을 보여 줍니다. 스로틀링이 있는지 확인하려면 어떤 값을 봐야 합니까?

<details><summary>정답</summary>

컨테이너 cgroup의 `cpu.stat`에서 `nr_throttled / nr_periods`를 계산하거나 cAdvisor 메트릭 `container_cpu_cfs_throttled_periods_total`을 `container_cpu_cfs_periods_total`로 나눠 봅니다. `kubectl top`은 metrics-server가 누적 사용 시간을 15초 간격의 사용률로 바꾼 값이라 스로틀 횟수나 시간을 담지 않습니다. 이 글의 실측에서는 사용량이 약 50m일 때 스로틀 비율이 91.7%였습니다.

</details>

---

## 범위와 한계

- 2026-10-20에 kind v0.33, 노드 이미지 kindest/node:v1.37.0(colima, arm64, 커널 6.8.0, containerd 2.3.4, runc 1.4.3, cgroup v2)에서 이 글의 명령을 실행했습니다. Deployment 재생성, controller-manager를 멈춘 상태의 스케일과 복구, Lease 확인, static Pod 출처 확인, `crictl inspect`, `lsns`, `/proc/<PID>/cgroup`, mountinfo, veth, OOMKilled 재현과 `dmesg`, `memory.max`, `memory.events`, `oom_score_adj`, `cpu.max`, `cpu.weight`, `cpu.stat`, kubelet `/metrics/resource`, `/stats/summary`, `/metrics/cadvisor` 조회가 여기에 해당합니다. 출력의 노드 이름, 파드 UID, PID, 컨테이너 ID는 그 클러스터의 실제 값이고 실습 뒤 클러스터를 지웠습니다.
- CPU 실습에는 공식 문서 "Assign CPU Resources" 예제의 `vish/stress` 대신 `busybox:1.36` 무한 루프를 썼습니다. `vish/stress`는 amd64 이미지만 있어서 arm64 colima에서는 Rosetta 에뮬레이터를 거쳐 실행됐고 프로세스 목록에 에뮬레이터 경로가 섞였기 때문입니다. requests만 둔 파드의 `cpu.max`가 `max 100000`이 되는 것과 BestEffort 파드의 경로와 `oom_score_adj`(1000)도 같은 클러스터에서 확인했습니다.
- kind 노드는 도커 컨테이너입니다. 그래서 커널 로그의 cgroup 경로에 `/docker/<ID>/`가 붙고 PID가 노드 안과 VM 기준으로 다르며 kubelet이 `cgroupRoot: /kubelet`, `failSwapOn: false`로 설정돼 있습니다. kubeadm으로 만든 일반 노드에서는 `/sys/fs/cgroup/kubepods.slice/...`처럼 경로가 짧습니다.
- 노드 전체 OOM, 노드 압박 축출, 노드 장애 뒤 약 50초 + 300초의 축출은 직접 재현하지 않았습니다. 앞의 둘은 VM 전체에 영향을 주고 마지막은 단일 노드 kind에서 의미 있게 재현하기 어렵습니다. 해당 수치는 공식 문서 기준입니다.
- metrics-server를 설치하지 않아 `kubectl top` 출력 자체는 보지 못했습니다. 대신 metrics-server가 읽는 kubelet 엔드포인트와 summary API 값을 보여 줬습니다.
- 5-1절의 컨테이너 scope(11)와 파드 slice(2)의 `cpu.weight` 차이는 두 변환식의 계산값과 맞는다는 것까지 확인했습니다. 어느 코드 경로가 각 값을 쓰는지는 소스로 따라가 확인하지 않았습니다.
- 4-3절에서 `oom_memcg`가 컨테이너 scope가 아닌 파드 slice로 찍힌 것은 이 실행에서 관찰한 결과입니다. 컨테이너가 여럿인 파드에서 어느 cgroup이 먼저 한도에 닿는지는 각 컨테이너 한도와 사용량에 따라 달라집니다.
- CrashLoopBackOff 관련 기능 게이트(KEP-5593, KEP-4603), taint-eviction 컨트롤러 분리(v1.34), node-monitor-grace-period 기본값 50초는 v1.35~v1.37 문서 기준이고 이후 버전에서 바뀔 수 있습니다.

## 참고 자료

- Objects In Kubernetes: https://kubernetes.io/docs/concepts/overview/working-with-objects/
- Controllers: https://kubernetes.io/docs/concepts/architecture/controller/
- Create static Pods: https://kubernetes.io/docs/tasks/configure-pod-container/static-pod/
- Leases: https://kubernetes.io/docs/concepts/architecture/leases/
- kube-controller-manager 플래그: https://kubernetes.io/docs/reference/command-line-tools-reference/kube-controller-manager/
- Taints and Tolerations: https://kubernetes.io/docs/concepts/scheduling-eviction/taint-and-toleration/
- Container Runtime Interface: https://kubernetes.io/docs/concepts/architecture/cri/
- Dockershim 제거 FAQ: https://kubernetes.io/blog/2022/02/17/dockershim-faq/
- About cgroup v2: https://kubernetes.io/docs/concepts/architecture/cgroups/
- Resource Management for Pods and Containers: https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/
- Assign Memory Resources to Containers and Pods: https://kubernetes.io/docs/tasks/configure-pod-container/assign-memory-resource/
- Pod Quality of Service Classes: https://kubernetes.io/docs/concepts/workloads/pods/pod-qos/
- Node-pressure Eviction: https://kubernetes.io/docs/concepts/scheduling-eviction/node-pressure-eviction/
- Pod Lifecycle(컨테이너 재시작 백오프): https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/
- KEP-4603, KEP-5593: https://www.kubernetes.dev/resources/keps/4603/ , https://www.kubernetes.dev/resources/keps/5593/
- cgroup v1에서 v2로의 CPU 변환식 변경: https://kubernetes.io/blog/2026/01/30/new-cgroup-v1-to-v2-cpu-conversion-formula/
- Linux cgroup v2 문서: https://docs.kernel.org/admin-guide/cgroup-v2.html
- CFS Bandwidth Control: https://docs.kernel.org/scheduler/sched-bwc.html
- EEVDF Scheduler: https://docs.kernel.org/scheduler/sched-eevdf.html
- proc_pid_oom_score_adj(5): https://man7.org/linux/man-pages/man5/proc_pid_oom_score_adj.5.html
- namespaces(7): https://man7.org/linux/man-pages/man7/namespaces.7.html
- bash(1) EXIT STATUS: https://man7.org/linux/man-pages/man1/bash.1.html
- cAdvisor Prometheus 메트릭: https://github.com/google/cadvisor/blob/master/docs/storage/prometheus.md
- metrics-server: https://github.com/kubernetes-sigs/metrics-server
- CKA 커리큘럼: https://github.com/cncf/curriculum

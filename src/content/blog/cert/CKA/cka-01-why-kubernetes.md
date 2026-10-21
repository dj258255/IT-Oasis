---
title: '[CKA Ch-01] 쿠버네티스의 동작 방식: 선언형 API, 구성요소, 멈췄을 때 보이는 증상'
description: 쿠버네티스는 원하는 상태를 API 오브젝트로 받아 두고 컨트롤러와 kubelet이 실제 상태를 거기에 맞춥니다. 컨트롤 플레인과 노드 구성요소가 각각 무엇을 하고 하나가 멈추면 무엇이 멈추는지, requests와 limits가 OOMKilled(137)와 CPU 스로틀링으로 이어지는 과정을 시험에서 쓰는 kubectl describe, top, 이벤트로 확인하는 방법을 정리합니다.
date: 2026-10-15T00:00:00.000Z
tags:
  - CKA
  - Kubernetes
  - Control Plane
  - OOMKilled
  - CPU Throttling
category: cert/CKA
topics:
  - cert
draft: false
series: "CKA 공부"
seriesOrder: 1
---

## 결론부터

1. 쿠버네티스 오브젝트의 `spec`은 원하는 상태이고 `status`는 관측된 상태입니다. 컨트롤러와 kubelet이 둘의 차이를 계속 메웁니다. 루프가 잠시 멈췄다 돌아와도 놓친 이벤트를 되짚지 않고 지금 상태와 원하는 상태를 다시 비교합니다.
2. kube-apiserver, etcd, kube-scheduler, kube-controller-manager는 kubeadm 클러스터에서 static Pod로 돌고 kubelet은 systemd 서비스입니다. 이 배치를 알면 "kubectl이 안 된다"는 증상에서 노드로 내려가 `crictl`과 `journalctl`을 칠 생각이 바로 납니다.
3. 구성요소 하나가 멈춰도 이미 떠 있는 Pod는 그대로 돕니다. 멈추는 것은 새로 맞추는 일입니다. controller-manager를 멈추고 `replicas`를 5로 올리면 ReplicaSet의 `DESIRED`가 3에 머물고 되살리면 5가 됩니다.
4. 메모리 limit을 넘은 컨테이너는 커널이 SIGKILL로 끝내고 kubelet이 `Reason: OOMKilled`, `Exit Code: 137`로 적습니다. 137은 128+9라서 시그널 종료의 표시일 뿐이고 OOM인지는 Reason으로 판단합니다.
5. CPU limit을 넘은 컨테이너는 죽지 않고 느려집니다(스로틀링). `kubectl top`은 사용량만 보여 주므로 한도에 붙어 있는 사용량이 스로틀링의 단서입니다.

쿠버네티스 쪽은 다음 글 [기본 오브젝트와 요청 흐름](/blog/cert/cka/cka-01b-core-objects-and-flow)으로 이어집니다. cgroup 파일, 커널 OOM 로그, `cpu.max` 같은 커널 내부는 시험 범위 밖이라 "쿠버네티스 아래의 리눅스" 시리즈로 넘겼습니다.

---

## 1. 원하는 상태를 적는 API와 컨트롤 루프

### 1-1. spec은 원하는 상태, status는 관측된 상태

공식 문서 "Objects In Kubernetes"는 대부분의 오브젝트가 `spec`과 `status` 두 필드를 가진다고 설명합니다. `spec`은 사용자가 원하는 상태를 적는 곳이고 `status`는 쿠버네티스 구성요소가 채우고 갱신하는 현재 상태입니다. 쇼핑몰의 상품 목록 API를 Deployment로 띄운다면 이렇게 적습니다.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 3              # 원하는 상태: Pod 3개
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

이 YAML을 `kubectl apply`로 보내면 API 서버는 검증과 승인을 거쳐 etcd에 저장하고 응답합니다. 이 시점에는 Pod가 하나도 없습니다. 저장된 것은 "Pod 3개"라는 기록뿐이고 Pod를 만드는 일은 뒤에서 다른 구성요소가 따로 합니다.

```bash
kubectl get deploy web -o jsonpath='{.spec.replicas} {.status.readyReplicas}{"\n"}'
# 3 3   ← 원하는 수와 관측된 준비 수
```

시험에서 `spec`과 `status`를 나눠 보는 습관이 쓸모 있는 곳은 트러블슈팅입니다. `spec`은 바뀌었는데 `status`가 따라오지 않으면 그 사이를 메우는 구성요소가 멈춘 것입니다.

### 1-2. 컨트롤러는 차이를 계속 메우는 루프

공식 문서 "Controllers"는 컨트롤러를 클러스터 상태를 지켜보다가 필요하면 변경을 만들거나 요청하는 제어 루프로 정의합니다. Deployment 하나가 Pod가 되기까지 여러 구성요소가 이어서 움직입니다.

```
kubectl apply
   │
   ▼
API 서버 ── etcd (spec 저장)
   ▲  watch            ▲ watch            ▲ watch              ▲ watch
   │                   │                  │                    │
Deployment 컨트롤러  ReplicaSet 컨트롤러   kube-scheduler         kubelet(노드마다)
ReplicaSet 생성       Pod 오브젝트 생성      Pod에 nodeName 기록     자기 노드 Pod를 실제로 실행
```

모든 구성요소가 API 서버를 중심으로 watch합니다. scheduler와 kubelet도 etcd를 직접 읽지 않습니다. 각자 API 서버에서 오브젝트를 받아 자기 몫의 차이만 메우고 결과를 다시 API 서버에 씁니다.

이 루프는 원하는 상태와 지금 상태를 비교해서 차이가 있으면 메웁니다. 그래서 루프가 잠시 멈췄다 다시 돌아도 그동안 놓친 이벤트를 복구할 필요가 없습니다. 3장에서 이 성질을 직접 확인합니다.

### 1-3. 직접 해 보기

```bash
kubectl create deployment web --image=nginx:1.27 --replicas=3
kubectl delete pod -l app=web --wait=false      # 세 개를 한꺼번에 삭제
kubectl get pods -l app=web -w                  # 새 이름의 Pod 세 개가 다시 뜨는지
kubectl get rs                                  # DESIRED 3이 그대로인지
```

Pod 이름이 바뀌고 ReplicaSet의 `DESIRED`는 그대로인지 봅니다. 새 이름은 컨트롤러가 원하는 수 3과 실제 수 0의 차이를 보고 Pod 3개를 새로 만들었다는 표시입니다.

---

## 2. 컨트롤 플레인과 노드 구성요소

### 2-1. 구성요소별 역할과 도는 방식

Kubernetes Components 문서 기준입니다. "도는 방식"은 kubeadm 클러스터 기준이고 시험 클러스터도 kubeadm으로 만든 구조입니다.

| 구성요소 | 맡은 일 | 도는 방식(kubeadm) |
|---|---|---|
| kube-apiserver | 모든 요청의 입구. 인증, 인가, 어드미션, 검증. etcd와 직접 통신하는 유일한 구성요소 | 컨트롤 플레인의 static Pod |
| etcd | 클러스터 상태를 저장하는 키-값 저장소 | 컨트롤 플레인의 static Pod |
| kube-scheduler | `nodeName`이 빈 Pod에 노드를 정함 | 컨트롤 플레인의 static Pod |
| kube-controller-manager | Deployment, ReplicaSet, Node 같은 내장 컨트롤러를 한 프로세스로 실행 | 컨트롤 플레인의 static Pod |
| kubelet | 자기 노드의 Pod를 컨테이너 런타임으로 실행하고 상태 보고 | 노드마다 systemd 서비스 |
| 컨테이너 런타임(containerd 등) | 이미지를 받고 컨테이너를 만듦. kubelet과 CRI로 통신 | 노드마다 systemd 서비스 |
| kube-proxy | Service용 iptables/nftables/IPVS 규칙 관리 | DaemonSet |
| CoreDNS | 클러스터 DNS(Service 이름 해석) | Deployment(`kube-system`) |

각 구성요소의 플래그와 인증서 방향은 [Ch-01.5 2~3장](/blog/cert/cka/cka-01b-core-objects-and-flow)에 정리했습니다.

### 2-2. static Pod는 kubelet이 직접 띄운다

kubeadm으로 만든 클러스터는 컨트롤 플레인 네 구성요소의 매니페스트를 `/etc/kubernetes/manifests`에 둡니다.

```bash
ssh <컨트롤 플레인 노드>
sudo ls /etc/kubernetes/manifests
# etcd.yaml
# kube-apiserver.yaml
# kube-controller-manager.yaml
# kube-scheduler.yaml
```

공식 문서 "Create static Pods"에 따르면 static Pod는 API 서버가 관리하지 않고 그 노드의 kubelet이 직접 관리합니다. kubelet은 이 디렉터리의 파일을 읽어 컨테이너를 띄우고 API 서버에는 보기용 미러 Pod만 만듭니다. 그래서 컨트롤 플레인 구성요소의 설정은 이 파일에서 고치고 저장하면 kubelet이 Pod를 다시 만듭니다. kubelet 자신은 systemd가 다시 띄웁니다(`Restart=always`).

```bash
kubectl get pod -n kube-system kube-controller-manager-<노드> \
  -o jsonpath='{.metadata.annotations.kubernetes\.io/config\.source}{"\n"}{.metadata.ownerReferences[0].kind}{"\n"}'
# file
# Node
```

`config.source`가 `file`이고 소유자는 Node입니다. 컨트롤러를 띄우는 데 컨트롤러가 필요 없는 구조입니다. 매니페스트 경로는 kubelet 설정 `/var/lib/kubelet/config.yaml`의 `staticPodPath`에 적혀 있습니다.

### 2-3. 노드에서 Pod가 프로세스가 되기까지

```
kubelet                      API 서버에서 자기 노드 Pod를 받음
  → CRI → 컨테이너 런타임      containerd나 CRI-O. 샌드박스(pause)를 만들고 이미지를 받음
    → OCI 런타임(runc 등)     namespace와 cgroup을 설정하고 컨테이너 프로세스 실행
      → 리눅스 커널            격리(namespace)와 자원 제한(cgroup)을 집행
```

kubelet과 런타임 사이의 표준이 CRI(Container Runtime Interface)입니다. Docker Engine을 kubelet에 붙이던 dockershim은 v1.24에서 제거됐고 지금 노드는 containerd나 CRI-O처럼 CRI를 직접 구현한 런타임을 씁니다. 노드에서 컨테이너를 볼 때 `crictl`을 쓰는 이유가 이것입니다.

Pod마다 먼저 뜨는 pause 컨테이너가 네트워크 네임스페이스를 잡아 두고 앱 컨테이너가 거기에 합류합니다. `crictl pods`에 Pod 샌드박스가 따로 보이고 같은 Pod의 컨테이너끼리 `localhost`로 통신하는 이유입니다. 커널 쪽 동작은 [네임스페이스와 pause](/blog/theory/systems/k8s-linux-02-namespaces-pause)와 [cgroup과 QoS](/blog/theory/systems/k8s-linux-03-cgroup-qos)에서 다룹니다.

`kubectl get nodes -o wide`의 `CONTAINER-RUNTIME` 열이 그 노드의 kubelet이 붙은 런타임입니다(예: `containerd://2.3.4`).

### 2-4. 직접 해 보기

kubeadm 노드에 ssh로 들어가 `sudo ls /etc/kubernetes/manifests`, `systemctl status kubelet containerd`, `sudo crictl pods`, `sudo crictl ps`를 차례로 실행합니다. `crictl ps`에서 컨트롤 플레인 네 구성요소와 kube-proxy, CoreDNS가 각각 어느 Pod 샌드박스에 속하는지 적습니다. kind라면 `docker exec -it <노드 이름> bash`로 노드에 들어갑니다.

---

## 3. 구성요소가 멈추면 무엇이 멈추는지

### 3-1. controller-manager를 멈추고 스케일하기

static Pod를 멈추는 가장 확실한 방법은 매니페스트 파일을 디렉터리 밖으로 옮기는 것입니다. kubelet이 파일이 사라진 것을 보고 컨테이너를 내립니다. 그 상태에서 Deployment를 3개에서 5개로 늘리고 Pod 하나를 지웠습니다. kind 단일 노드 클러스터에서 실제로 돌린 명령과 출력입니다.

```bash
sudo mv /etc/kubernetes/manifests/kube-controller-manager.yaml /root/
sudo crictl ps -a --name kube-controller-manager
# CONTAINER      ...  STATE    NAME                      ...
# eabfa31cc98ca  ...  Exited   kube-controller-manager   ...

kubectl scale deployment web --replicas=5
kubectl delete pod web-69c6f74b8b-bxxtm
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

출력 세 개가 서로 맞지 않습니다. Deployment의 `spec.replicas`는 5로 바뀌었지만 Deployment 컨트롤러가 없어서 ReplicaSet의 `DESIRED`는 3에 머물렀습니다. 실제 Pod는 2개인데 ReplicaSet과 Deployment의 `status`는 3을 가리킵니다. `status`를 갱신하는 주체도 컨트롤러라서 컨트롤러가 멈추면 `status`는 마지막 값으로 굳습니다. 남은 Pod 2개는 계속 Running이었습니다.

매니페스트를 되돌린 뒤의 출력입니다.

```bash
sudo mv /root/kube-controller-manager.yaml /etc/kubernetes/manifests/
kubectl get deploy web; kubectl get rs
# web    5/5     5            5           3m10s
# web-69c6f74b8b   5         5         5       3m10s
```

되살아난 controller-manager는 원하는 수 5와 실제 수 2를 비교해 3개를 새로 만들었습니다(새 Pod 3개의 AGE가 16~18초). 1-2절의 비교 방식 루프가 이렇게 동작합니다.

### 3-2. controller-manager가 멈춘 동안의 정리

| 계속되는 일 | 멈추는 일 |
|---|---|
| 이미 떠 있는 Pod의 실행(kubelet과 런타임 담당) | 삭제된 Pod를 새로 만들기(ReplicaSet 컨트롤러) |
| 컨테이너가 죽었을 때 같은 Pod 안에서 재시작(`restartPolicy`는 kubelet 담당) | Deployment 롤아웃과 스케일 변경 반영 |
| Service로 들어오는 트래픽 처리(kube-proxy 규칙은 그대로) | Deployment, ReplicaSet 등의 `status` 갱신 |
| scheduler의 배치(이미 만들어진 Pod 오브젝트가 있다면) | 응답 없는 노드에 taint를 붙이고 Pod를 축출하는 일 |

### 3-3. 구성요소별로 멈출 때의 증상과 처음 볼 곳

Troubleshooting Clusters 문서의 장애 시나리오와 각 구성요소의 역할을 묶은 표입니다. 자세한 복구 순서는 [Ch-06 2장](/blog/cert/cka/cka-06-troubleshooting)에 있습니다.

| 멈춘 구성요소 | 보이는 증상 | 처음 볼 곳 |
|---|---|---|
| kube-apiserver | `kubectl` 전체가 실패(`The connection to the server ... was refused`) | 컨트롤 플레인 노드에서 `sudo crictl ps -a`, `sudo crictl logs <ID>`, `kube-apiserver.yaml` |
| etcd | API 서버가 정상 기동하지 못하고 재시작을 반복 | `crictl logs`로 etcd와 API 서버 로그, `kube-apiserver.yaml`의 `--etcd-*` 플래그 |
| kube-scheduler | 새 Pod가 `Pending`에 머물고 NODE가 `<none>`. `describe pod`에 스케줄링 이벤트가 없음 | `kubectl -n kube-system get pods`, `kube-scheduler.yaml` |
| kube-controller-manager | 스케일과 삭제 후 Pod 수가 안 맞고 `status`가 굳음(3-1절) | `kubectl -n kube-system get pods`, `kube-controller-manager.yaml` |
| kubelet | 노드가 `NotReady`. 그 노드에 새 Pod가 뜨지 않음 | `systemctl status kubelet`, `journalctl -u kubelet` |
| 컨테이너 런타임 | 노드가 `NotReady`, kubelet 로그에 런타임 연결 오류 | `systemctl status containerd`, `crictl info` |
| kube-proxy | 이미 깔린 규칙은 남지만 새 Service와 엔드포인트 변경이 그 노드에 반영되지 않음 | `kubectl -n kube-system get pods -l k8s-app=kube-proxy`, `kubectl logs` |
| CoreDNS | Service 이름이 안 풀리고 IP로는 닿음 | `kubectl -n kube-system get pods -l k8s-app=kube-dns`, Corefile ConfigMap |

kube-scheduler 행의 "스케줄링 이벤트가 없음"은 이벤트를 쓰는 주체가 스케줄러라는 데서 나오는 단서입니다. 자원이 모자라 못 뜨는 경우에는 `FailedScheduling` 이벤트가 남습니다.

### 3-4. 노드 전체가 응답을 멈추면 약 50초 + 5분

노드가 상태 갱신을 멈추면 node lifecycle 컨트롤러가 `--node-monitor-grace-period`(1.37 기본 50초, 옛 자료는 40초)가 지난 뒤 노드 조건을 `Unknown`으로 바꾸고 `node.kubernetes.io/unreachable` taint를 붙입니다. 노드가 응답은 하지만 준비되지 않았다고 보고하면 `node.kubernetes.io/not-ready`가 붙습니다. Pod에는 `DefaultTolerationSeconds` 어드미션 플러그인이 넣은 300초 toleration이 기본으로 있습니다. 그래서 기본 설정에서는 약 50초에 300초를 더한 뒤 그 노드의 Pod가 삭제됩니다.

```bash
kubectl get pod <Pod> -o jsonpath='{range .spec.tolerations[*]}{.key} {.effect} {.tolerationSeconds}{"\n"}{end}'
# node.kubernetes.io/not-ready NoExecute 300
# node.kubernetes.io/unreachable NoExecute 300
```

Pod 삭제는 v1.34부터 별도의 taint-eviction 컨트롤러가 맡고 지워진 Pod를 다른 노드에 새로 만드는 쪽은 ReplicaSet 같은 워크로드 컨트롤러입니다. 둘 다 controller-manager 안에서 돌므로 controller-manager가 멈춘 동안에는 축출도 일어나지 않습니다. 주인 없는 단독 Pod는 다시 만들어지지 않습니다.

kind 워커 컨테이너를 `docker stop`으로 멈춰 잰 결과입니다. 약 45초 안에 노드가 `Unknown`이 되고 `unreachable` 테인트가 붙었습니다. `tolerationSeconds: 30`을 준 Pod는 그 30초 뒤, 기본 Pod는 약 300초 뒤 `TaintManagerEviction`(`Marking for deletion Pod shop/web-...`) 이벤트와 함께 `Terminating`이 됐고 Deployment의 대체 Pod는 다른 워커에서 `Running`이 됐습니다. 노드가 돌아오지 않으면 옛 Pod는 `Terminating`에 남습니다.

### 3-5. 직접 해 보기

```bash
# 1) 3-1절 재현
sudo mv /etc/kubernetes/manifests/kube-controller-manager.yaml /root/
kubectl scale deployment web --replicas=5
kubectl get deploy,rs,pods -l app=web
sudo mv /root/kube-controller-manager.yaml /etc/kubernetes/manifests/

# 2) 스케줄러를 같은 방법으로 멈추고 새 Pod를 만들기
sudo mv /etc/kubernetes/manifests/kube-scheduler.yaml /root/
kubectl run probe --image=nginx:1.27
kubectl get pod probe -o wide            # NODE <none>, Pending
kubectl describe pod probe | tail -3     # Events 확인
sudo mv /root/kube-scheduler.yaml /etc/kubernetes/manifests/
```

매니페스트의 플래그 이름을 일부러 틀리게 고친 뒤 `crictl ps -a`에서 Exited가 반복되는 것과 `crictl logs`로 원인 메시지를 찾는 연습도 해 볼 만합니다. 시험의 컨트롤 플레인 트러블슈팅이 이 모양입니다.

---

## 4. 메모리 한도와 OOMKilled

### 4-1. requests는 배치에, limits는 집행에 쓰인다

| 값 | 누가 쓰는지 | 넘었을 때 |
|---|---|---|
| `requests` | 스케줄러가 노드를 고를 때. 노드에 배치된 requests 합이 allocatable 안이어야 함 | 사용량이 request를 넘는 것은 허용 |
| `limits.memory` | kubelet이 런타임을 거쳐 커널(cgroup)에 한도로 적음 | 커널이 컨테이너 프로세스를 SIGKILL로 종료(OOMKilled) |
| `limits.cpu` | 같은 경로로 커널에 CPU 시간 한도로 적음 | 종료되지 않고 실행이 지연(스로틀링) |

requests와 limits 조합이 정하는 QoS 클래스와 LimitRange, ResourceQuota는 [Ch-03 5장](/blog/cert/cka/cka-03-workloads-scheduling)에 있습니다. cgroup 파일에 값이 어떻게 적히는지는 [cgroup과 QoS](/blog/theory/systems/k8s-linux-03-cgroup-qos)에서 다룹니다.

### 4-2. OOMKilled 재현과 describe에서 읽을 곳

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

시험에서 확인할 곳은 `describe`의 `Last State`입니다. 컨테이너가 재시작해 지금 `Running`이어도 직전 종료 이유가 `Last State`에 남습니다. jsonpath로 뽑으면 이렇습니다.

```bash
kubectl get pod mem-over -o jsonpath='{.status.containerStatuses[0].lastState.terminated.reason} {.status.containerStatuses[0].lastState.terminated.exitCode}{"\n"}'
# OOMKilled 137
```

판단과 종료는 커널이 합니다. kubelet은 컨테이너를 만들 때 한도를 런타임에 넘기고 끝난 뒤 결과를 받아 `OOMKilled`로 보고합니다. 공식 문서 "Resource Management for Pods and Containers"는 한도를 넘은 컨테이너가 커널이 메모리 압박을 감지할 때 종료된다고 적습니다. 노드의 커널 로그(`dmesg`)에는 `Memory cgroup out of memory: Killed process ...` 줄이 남습니다.

### 4-3. 137은 128 + 9

```
137 = 128 + 9 (SIGKILL)
```

셸과 컨테이너 런타임은 시그널 N으로 끝난 프로세스의 종료 코드를 128+N으로 적는 관례를 따릅니다(bash 매뉴얼의 EXIT STATUS). 그래서 128보다 큰 값이면 시그널로 끝났을 가능성이 높습니다. 프로세스가 직접 `exit(137)`을 불러도 같은 값이 나오므로 OOM 여부는 kubelet이 따로 적는 `Reason: OOMKilled`로 판단합니다. 자주 보는 값을 함께 적어 둡니다.

| Exit Code | 흔한 원인 | 같이 볼 것 |
|---|---|---|
| 0 | 정상 종료. `restartPolicy: Always`면 다시 시작되어 재시작 횟수가 늘어남 | `command`가 곧바로 끝나는지 |
| 1 | 애플리케이션 오류 | `kubectl logs -p` |
| 137 | SIGKILL. OOM이거나 종료 유예 시간을 넘김 | `Reason`이 `OOMKilled`인지 `Error`인지 |
| 143 | SIGTERM(128+15)으로 정상 종료 요청을 받고 끝남 | 삭제나 롤아웃 중이었는지 |

### 4-4. 같은 Pod 안의 재시작과 CrashLoopBackOff

`restartPolicy`의 기본값은 `Always`라서 kubelet은 OOM으로 끝난 컨테이너를 같은 Pod 안에서 다시 시작합니다. Pod 오브젝트와 IP는 그대로입니다. 다시 250M을 잡으면 또 죽으므로 kubelet은 재시작 사이에 간격을 둡니다. 공식 문서 "Pod Lifecycle" 기준으로 간격은 10초에서 시작해 두 배씩 늘고 300초에서 멈춥니다. 컨테이너가 10분 동안 문제없이 돌면 간격이 초기화됩니다. 기다리는 동안의 상태가 `CrashLoopBackOff`이고 이벤트에는 이렇게 남습니다.

```
Warning   BackOff   pod/mem-over   Back-off restarting failed container stress in pod mem-over_default(...)
```

```bash
kubectl get events --field-selector involvedObject.name=mem-over --sort-by=.lastTimestamp
kubectl logs mem-over -p        # 직전에 죽은 컨테이너의 로그
```

해결은 limit을 실제 사용량에 맞게 올리거나 애플리케이션의 메모리 사용을 줄이는 것입니다. Deployment라면 `kubectl set resources deployment <이름> --limits=memory=256Mi`로 템플릿을 고칩니다.

### 4-5. 노드 메모리가 모자랄 때의 축출

노드 전체 메모리가 모자라면 kubelet이 Pod를 골라 축출합니다(리눅스 기본 hard 임계 `memory.available<100Mi`). 이때 Pod는 `Failed`와 `reason: Evicted`가 되고 노드 조건에 `MemoryPressure=True`가 뜹니다. kubelet은 사용량이 requests를 넘은 Pod를 먼저 보므로 requests가 없는 BestEffort Pod가 가장 먼저 대상이 되고 Guaranteed Pod는 마지막입니다.

kind 워커의 `/var/lib/kubelet/config.yaml`에 `evictionHard: memory.available: 9800Mi`(가용량보다 큰 값)를 넣고 kubelet을 재시작해 본 결과입니다.

```text
MemoryPressure  True  ...  KubeletHasInsufficientMemory  kubelet has insufficient memory available
Taints:         node.kubernetes.io/memory-pressure:NoSchedule
Warning  Evicted  pod/order-api-...  The node was low on resource: memory. Threshold quantity: 9800Mi, available: 9936872Ki. Container nginx was using 7076Ki, request is 0, has larger consumption of memory.
```

축출된 Pod는 `.status.phase`가 `Failed`, `.status.reason`이 `Evicted`인데 `kubectl get pod`의 STATUS 열에는 `Error`나 `ContainerStatusUnknown`으로 보였습니다. 그래서 `kubectl get pod -A --field-selector status.phase=Failed`로 찾습니다.

### 4-6. 직접 해 보기

```bash
kubectl apply -f mem-over.yaml
kubectl get pod mem-over -w                     # OOMKilled와 CrashLoopBackOff가 번갈아 나오는지
kubectl get pod mem-over -o jsonpath='{.status.qosClass}{"\n"}'
kubectl describe pod mem-over | grep -A3 "Last State"
```

limit을 300Mi로 올린 버전으로 다시 만들어 `Running`이 유지되는지 봅니다. requests와 limits를 모두 지운 버전의 `qosClass`가 `BestEffort`인지도 확인합니다.

---

## 5. CPU 한도와 스로틀링

### 5-1. CPU는 넘으면 기다린다

메모리는 넘으면 죽고 CPU는 넘으면 기다립니다. `limits.cpu: 50m`은 100ms마다 5ms까지 CPU를 쓸 수 있다는 한도로 커널에 적히고 그 시간을 다 쓰면 다음 주기까지 실행이 멈춥니다. 컨테이너는 종료되지 않고 에러 로그도 남기지 않으면서 응답만 느려집니다. 그래서 `describe`의 상태와 이벤트만으로는 잡히지 않습니다. 커널 쪽 설정 파일(`cpu.max`)과 스로틀 카운터(`cpu.stat`)는 [cgroup과 QoS](/blog/theory/systems/k8s-linux-03-cgroup-qos)에서 다룹니다.

### 5-2. kubectl top으로 볼 수 있는 것

`kubectl top`은 metrics-server가 kubelet에서 모은 사용량을 보여 줍니다. metrics-server가 없으면 이렇게 끝납니다(kind 기본 상태에서 확인).

```bash
kubectl top pod
# error: Metrics API not available
```

시험에서 쓰는 형태는 이 정도입니다.

```bash
kubectl top node
kubectl top pod -A --sort-by=cpu        # 또는 --sort-by=memory
kubectl top pod <Pod> --containers      # 컨테이너별
```

kind에서 metrics-server v0.9.0 매니페스트에 `--kubelet-insecure-tls`를 더한 뒤의 `kubectl top node`입니다(이 인자가 없으면 로그에 `x509: cannot validate certificate for 172.18.0.5 because it doesn't contain any IP SANs`가 남고 top은 계속 `Metrics API not available`).

```text
NAME                      CPU(cores)   CPU(%)   MEMORY(bytes)   MEMORY(%)
cka-lab-r-control-plane   426m         7%       640Mi           6%
cka-lab-r-worker          92m          1%       168Mi           1%
```

`top`이 보여 주는 것은 사용량뿐입니다. 스로틀 횟수나 시간은 담지 않습니다. CPU 50m 한도의 무한 루프 컨테이너를 kind에서 돌렸을 때 `kubectl top pod`는 `51m`이었고 같은 시점 커널 카운터로는 주기의 약 92%가 스로틀되어 있었습니다. 사용량이 limit에 붙어 있으면 스로틀링을 의심하고 `kubectl describe pod`나 `-o jsonpath='{.spec.containers[*].resources}'`로 limit 값을 확인합니다. 해결은 limit을 올리거나 지우는 것입니다.

메모리 쪽 `top` 값은 working set이라 컨테이너 안의 `free` 숫자와 다르게 나올 수 있습니다. 출력을 읽는 법과 metrics-server가 없을 때의 점검은 [Ch-06 3장](/blog/cert/cka/cka-06-troubleshooting)에 있습니다.

### 5-3. 직접 해 보기

metrics-server를 설치한 클러스터에서 `busybox:1.36` 이미지로 `while true; do :; done`을 도는 Pod를 CPU와 메모리 모두 requests와 limits를 같게(CPU `50m`, 메모리 `32Mi`) 띄웁니다. `kubectl top pod`가 50m 근처에 머무는지, `qosClass`가 `Guaranteed`인지 봅니다. `limits.cpu`를 `500m`으로 바꿔 다시 만들고 사용량이 어떻게 변하는지 비교합니다.

---

## 6. 이어지는 글

증상별로 처음 칠 명령은 3-3절 표에 모았고 시험 비중이 가장 큰 트러블슈팅(30%) 절차는 Ch-06에서 이어집니다.

| 다음에 볼 것 | 글 |
|---|---|
| Pod, Deployment, Service가 API 서버를 거쳐 노드에 닿는 흐름과 kubectl 사용법 | [CKA Ch-01.5](/blog/cert/cka/cka-01b-core-objects-and-flow) |
| kubeadm 설치, 업그레이드, etcd, 인증서 | [CKA Ch-02](/blog/cert/cka/cka-02-cluster-architecture) |
| requests, limits, QoS, LimitRange | [CKA Ch-03](/blog/cert/cka/cka-03-workloads-scheduling) |
| 증상별 트러블슈팅 절차 | [CKA Ch-06](/blog/cert/cka/cka-06-troubleshooting) |
| 시험 범위 밖 심화: 커널 경계, namespace, cgroup, overlayfs, iptables | [쿠버네티스 아래의 리눅스 1편](/blog/theory/systems/k8s-linux-01-kernel-boundary)부터 [5편](/blog/theory/systems/k8s-linux-05-service-iptables-conntrack)까지 |

---

## 확인 문제

**1.** Deployment의 `spec.replicas`를 3에서 5로 바꿨는데 `kubectl get rs`의 `DESIRED`가 3에 머물러 있습니다. 가장 먼저 의심할 구성요소와 확인 명령은 무엇입니까?

<details><summary>정답</summary>

kube-controller-manager입니다. Deployment 컨트롤러가 ReplicaSet의 `spec.replicas`를 바꾸는데 그 컨트롤러가 controller-manager 안에서 돕니다. `kubectl get pods -n kube-system`으로 controller-manager Pod 상태를 보고 kubeadm 클러스터라면 `/etc/kubernetes/manifests/kube-controller-manager.yaml`을 확인합니다. 이 상태에서는 `status` 필드도 마지막 값으로 굳어 실제 Pod 수와 다르게 보입니다.

</details>

**2.** controller-manager가 멈춘 동안 계속 일어나는 일을 고르십시오. (가) 지운 Pod의 재생성 (나) OOM으로 끝난 컨테이너의 같은 Pod 안 재시작 (다) 응답 없는 노드의 Pod 축출 (라) Service로 들어온 요청의 전달

<details><summary>정답</summary>

(나)와 (라)입니다. 컨테이너 재시작은 노드의 kubelet이 `restartPolicy`에 따라 하고 Service 전달은 각 노드에 이미 깔린 kube-proxy 규칙이 처리합니다. (가)는 ReplicaSet 컨트롤러, (다)는 node lifecycle 컨트롤러와 taint-eviction 컨트롤러가 하므로 멈춥니다.

</details>

**3.** 새로 만든 Pod가 모두 `Pending`이고 NODE가 `<none>`입니다. `kubectl describe pod`의 Events는 비어 있습니다. 노드 자원은 넉넉합니다. 무엇을 확인합니까?

<details><summary>정답</summary>

kube-scheduler입니다. 스케줄러가 돌고 있는데 자원이 모자라거나 taint에 걸렸다면 `FailedScheduling` 이벤트가 남습니다. 이벤트조차 없으면 스케줄러가 Pod를 보지 못하고 있는 것입니다. `kubectl -n kube-system get pods`로 scheduler Pod를 보고 컨트롤 플레인 노드의 `/etc/kubernetes/manifests/kube-scheduler.yaml`과 `crictl logs`를 확인합니다.

</details>

**4.** `kubectl get nodes`가 `The connection to the server 192.168.1.10:6443 was refused`로 끝납니다. 어디서 무엇부터 확인합니까?

<details><summary>정답</summary>

API 서버가 응답하지 않으므로 kubectl로는 더 볼 수 없습니다. 컨트롤 플레인 노드에 ssh로 들어가 `sudo crictl ps -a | grep kube-apiserver`로 컨테이너가 Exited를 반복하는지 보고 `sudo crictl logs <ID>`로 원인 메시지를 찾습니다. 매니페스트 `/etc/kubernetes/manifests/kube-apiserver.yaml`의 오타나 인증서 경로를 고치면 kubelet이 static Pod를 다시 만듭니다. kubelet이 멈춰 있으면 static Pod도 뜨지 않으니 `systemctl status kubelet`도 봅니다.

</details>

**5.** 컨테이너가 Exit Code 137로 끝났습니다. 이것만으로 메모리 부족이라고 말할 수 있습니까?

<details><summary>정답</summary>

말할 수 없습니다. 137은 128+9, 즉 SIGKILL로 끝났을 가능성이 높다는 관례적 표시입니다. 종료 유예 시간을 넘겨 강제 종료된 경우에도 137이 나옵니다. `kubectl describe pod`의 `Last State`에서 `Reason: OOMKilled`인지 확인합니다.

</details>

**6.** `kubectl top pod`가 한도와 같은 `50m`을 계속 보여 주고 애플리케이션 응답이 느립니다. 무엇을 의심하고 어떻게 고칩니까?

<details><summary>정답</summary>

CPU 스로틀링입니다. CPU limit을 넘는 컨테이너는 죽지 않고 주기마다 실행이 멈춥니다. `kubectl top`은 사용량만 보여 주므로 사용량이 limit에 붙어 있는 것이 단서입니다. `kubectl describe pod`로 limit 값을 확인하고 Deployment라면 `kubectl set resources deployment <이름> --limits=cpu=500m`처럼 템플릿의 limit을 올립니다. 스로틀 횟수 자체는 노드의 cgroup `cpu.stat`이나 cAdvisor 메트릭에 있고 시험 범위 밖입니다.

</details>

**7.** 노드 하나가 갑자기 꺼졌습니다. 그 노드의 Deployment Pod가 다른 노드에서 다시 뜨기까지 기본 설정에서 대략 얼마가 걸리고 그 시간은 어디서 옵니까?

<details><summary>정답</summary>

약 50초 + 300초입니다. node lifecycle 컨트롤러가 `--node-monitor-grace-period`(기본 50초) 뒤 노드를 `Unknown`으로 바꾸고 `node.kubernetes.io/unreachable:NoExecute` taint를 붙입니다. Pod에는 `DefaultTolerationSeconds`가 넣은 300초 toleration이 있어 그 시간이 지난 뒤 taint-eviction 컨트롤러가 Pod를 지우고 ReplicaSet 컨트롤러가 다른 노드에 새로 만듭니다.

</details>

---

## 범위와 한계

- 명령과 출력은 kind v1.37 클러스터에서 2026년 10월에 직접 돌려 확인했습니다. 노드 압박 축출은 실제 메모리를 쓰지 않고 `evictionHard`를 올려 만들었고 노드 장애는 워커 컨테이너를 멈춰 재현했습니다. kind에서는 노드에 `docker exec`로 들어가고 시험의 kubeadm 노드에서는 ssh 뒤 `sudo`를 붙입니다.
- 노드 전체 메모리를 실제로 소진시키는 OOM은 같은 VM의 다른 작업에 영향을 줄 수 있어 재현하지 않았습니다.
- `--node-monitor-grace-period` 기본값 50초와 taint-eviction 컨트롤러 분리(v1.34)는 버전에 따라 달라진 항목입니다.

## 참고 자료

- Objects In Kubernetes: https://kubernetes.io/docs/concepts/overview/working-with-objects/
- Controllers: https://kubernetes.io/docs/concepts/architecture/controller/
- Kubernetes Components: https://kubernetes.io/docs/concepts/overview/components/
- Create static Pods: https://kubernetes.io/docs/tasks/configure-pod-container/static-pod/
- Troubleshooting Clusters: https://kubernetes.io/docs/tasks/debug/debug-cluster/
- Leases: https://kubernetes.io/docs/concepts/architecture/leases/
- Taints and Tolerations: https://kubernetes.io/docs/concepts/scheduling-eviction/taint-and-toleration/
- Container Runtime Interface: https://kubernetes.io/docs/concepts/architecture/cri/
- Resource Management for Pods and Containers: https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/
- Assign Memory Resources to Containers and Pods: https://kubernetes.io/docs/tasks/configure-pod-container/assign-memory-resource/
- Pod Quality of Service Classes: https://kubernetes.io/docs/concepts/workloads/pods/pod-qos/
- Node-pressure Eviction: https://kubernetes.io/docs/concepts/scheduling-eviction/node-pressure-eviction/
- Pod Lifecycle(컨테이너 재시작 백오프): https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/
- Resource metrics pipeline: https://kubernetes.io/docs/tasks/debug/debug-cluster/resource-metrics-pipeline/
- bash(1) EXIT STATUS: https://man7.org/linux/man-pages/man1/bash.1.html
- CKA 커리큘럼 v1.37: https://github.com/cncf/curriculum/blob/master/CKA_Curriculum_v1.37.pdf

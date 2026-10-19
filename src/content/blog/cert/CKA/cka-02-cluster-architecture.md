---
title: '[CKA Ch-02] 클러스터 아키텍처, 설치, 구성: kubeadm 한 벌로 만들고 올리고 되살리기'
description: CKA 비중 25%인 클러스터 아키텍처 영역을 v1.37 커리큘럼 목차 순서대로 정리합니다. RBAC, 설치 전 노드 준비, kubeadm 생성과 업그레이드, etcd 백업과 복구, 고가용성 컨트롤 플레인, Helm과 Kustomize, CNI·CSI·CRI, CRD와 오퍼레이터를 공식 문서 기준으로 묶고 항목마다 직접 해 볼 과제를 붙였습니다.
date: 2026-10-19T00:00:00.000Z
tags:
  - CKA
  - Kubernetes
  - kubeadm
  - RBAC
  - etcd
  - Helm
  - Kustomize
category: cert/CKA
topics:
  - systems
draft: false
series: "CKA 공부"
seriesOrder: 2
---

## 결론부터

1. 이 영역은 kubeadm 클러스터 한 벌의 일생입니다. 스왑, IP 포워딩, cgroup 드라이버를 맞춰 노드를 준비합니다. 그 위에 `kubeadm init`과 `join`으로 클러스터를 만들고 한 마이너 버전씩 올리고 etcd 스냅샷으로 되살립니다. 커리큘럼 여덟 항목 중 노드 준비, kubeadm 생성, 수명주기 관리, 고가용성 네 항목이 이 흐름 위에 있습니다.
2. RBAC은 네 개의 객체로 끝납니다. 권한 묶음(Role, ClusterRole)과 그 묶음을 누구에게 줄지 정하는 바인딩(RoleBinding, ClusterRoleBinding)입니다. 권한은 더하기만 있고 거부 규칙은 없습니다. 만든 뒤에는 `kubectl auth can-i --as`로 검증합니다.
3. 업그레이드는 마이너 버전을 건너뛸 수 없습니다. 순서는 첫 컨트롤 플레인(`kubeadm upgrade apply`), 나머지 컨트롤 플레인(`kubeadm upgrade node`), 워커 노드이고 노드마다 drain, kubelet 교체, uncordon을 반복합니다.
4. etcd 백업과 복구는 2025년 개정에서 명시 항목에서 빠졌지만 "클러스터 수명주기 관리" 안에 들어갈 여지가 있어 손에 익혀 둡니다. 공식 문서는 스냅샷 확인과 복구에 `etcdctl` 대신 `etcdutl`을 쓰라고 적습니다.
5. 새로 들어온 Helm, Kustomize, CRD는 명령 수가 적어서 문서 위치만 익히면 빨리 풉니다. Helm은 시험 중에 helm.sh/docs를 볼 수 있습니다.

시험 구조와 영역 비중은 [CKA Ch-00](/blog/cert/cka/cka-00-exam-and-study-plan)에, 컨트롤 플레인과 kubelet이 각각 무엇을 하는지는 [CKA Ch-01](/blog/cert/cka/cka-01-why-kubernetes)에 정리했습니다.

---

## 1. RBAC: 권한 묶음 둘과 바인딩 둘

커리큘럼 문구는 "Manage role based access control (RBAC)"입니다.

### 1-1. 객체 네 개의 관계

RBAC은 "어떤 동사를 어떤 리소스에 쓸 수 있는지"를 적은 규칙 묶음과, 그 묶음을 사용자나 그룹, ServiceAccount에 연결하는 바인딩으로 나뉩니다. 공식 문서 "Using RBAC Authorization"의 설명을 표로 옮기면 이렇습니다.

| 객체 | 범위 | 하는 일 |
|---|---|---|
| Role | 네임스페이스 하나 | 그 네임스페이스 안의 리소스 권한 묶음 |
| ClusterRole | 클러스터 전체(네임스페이스 없음) | 네임스페이스 리소스 권한을 여러 네임스페이스에 재사용하거나, 노드 같은 클러스터 범위 리소스 권한을 정의 |
| RoleBinding | 네임스페이스 하나 | Role 또는 ClusterRole을 주체에 연결. 효력은 바인딩의 네임스페이스 안으로 한정 |
| ClusterRoleBinding | 클러스터 전체 | ClusterRole을 주체에 연결. 모든 네임스페이스에 효력 |

문서가 짚는 성질이 셋 있습니다.

- 권한은 더하기만 있습니다. 문서 표현으로 "there are no "deny" rules"입니다. 무언가를 막고 싶으면 그 권한을 주는 바인딩을 지웁니다.
- RoleBinding이 ClusterRole을 가리킬 수 있습니다. 이때 권한은 RoleBinding이 있는 네임스페이스 안에서만 통합니다. 공통 역할을 ClusterRole로 한 번 만들고 네임스페이스마다 RoleBinding으로 나눠 주는 방식이 여기서 나옵니다.
- 바인딩의 `roleRef`는 만든 뒤 바꿀 수 없습니다. 바꾸려 하면 검증 오류가 나고 바인딩을 지우고 다시 만들어야 합니다.

### 1-2. 기본 ClusterRole 네 개

| ClusterRole | 문서 설명 요약 |
|---|---|
| `cluster-admin` | 모든 리소스에 모든 동작. 기본으로 `system:masters` 그룹에 묶여 있음 |
| `admin` | 네임스페이스 안에서 대부분의 읽기와 쓰기, Role과 RoleBinding 생성까지. ResourceQuota와 네임스페이스 자체는 쓰기 불가 |
| `edit` | 대부분의 읽기와 쓰기. Role과 RoleBinding은 보거나 바꿀 수 없음 |
| `view` | 대부분의 읽기 전용. Secret은 볼 수 없음 |

`view`가 Secret을 못 보는 이유도 문서에 있습니다. Secret을 읽으면 ServiceAccount 토큰을 얻을 수 있고 그 토큰으로 다른 ServiceAccount의 권한을 쓰는 권한 상승이 되기 때문입니다.

kubeadm이 만든 `/etc/kubernetes/admin.conf`의 인증서는 `kubeadm:cluster-admins` 그룹이고 이 그룹이 `cluster-admin`에 묶여 있습니다. 같이 생기는 `super-admin.conf`는 `system:masters` 그룹이라 인가 계층(RBAC 포함)을 건너뜁니다. 문서는 둘 다 공유하지 말고 `super-admin.conf`는 안전한 곳으로 옮기라고 적습니다.

### 1-3. 시험에서 쓰는 명령

ServiceAccount의 사용자 이름은 `system:serviceaccount:<네임스페이스>:<이름>` 형식입니다. 단수형 `serviceaccount`는 사용자 이름 접두사이고 복수형 `system:serviceaccounts:`는 그룹 접두사입니다. `--as`에 넣을 때 이 둘을 헷갈리기 쉽습니다.

```bash
# 쇼핑몰 주문 API용 ServiceAccount
kubectl create namespace shop
kubectl create serviceaccount order-api -n shop

# shop 네임스페이스에서 ConfigMap 읽기 권한
kubectl create role config-reader -n shop \
  --verb=get,list,watch --resource=configmaps

kubectl create rolebinding order-api-config-reader -n shop \
  --role=config-reader --serviceaccount=shop:order-api

# 검증: 결과는 yes 또는 no 한 단어
kubectl auth can-i list configmaps -n shop \
  --as=system:serviceaccount:shop:order-api
kubectl auth can-i delete configmaps -n shop \
  --as=system:serviceaccount:shop:order-api
```

YAML이 필요하면 `--dry-run=client -o yaml`을 붙여 뼈대를 받습니다. `--resource-name`으로 특정 이름의 리소스만 허용할 수 있고 서브리소스는 `pods/log`처럼 슬래시로 적습니다. 문서의 예시에 `--resource=pods,pods/status`가 있습니다.

### 1-4. 헷갈리는 지점

- 클러스터 범위 리소스(노드, PV, 네임스페이스)에 대한 권한은 ClusterRole로 정의합니다. Role은 자기 네임스페이스 안의 권한만 담습니다.
- API 그룹이 있는 리소스는 그룹까지 맞아야 합니다. `kubectl create role`에서는 `--resource=deployments.apps`처럼 점 뒤에 그룹을 붙입니다.
- `roleRef`를 바꾸는 과제라면 바인딩을 지우고 다시 만듭니다. `kubectl edit`으로 저장하면 검증 오류가 납니다.

### 1-5. 직접 해 보기

게시판 서비스용 네임스페이스 `board`에 ServiceAccount `board-reader`를 만들고 기본 ClusterRole `view`를 그 네임스페이스에서만 쓰도록 RoleBinding으로 연결합니다. 그 다음 `kubectl auth can-i`로 `board`에서는 Pod 목록이 되고 `default`에서는 안 되는지, `board`에서도 Secret 조회는 안 되는지 확인합니다.

## 2. 설치 전 노드 준비

커리큘럼 문구는 "Prepare underlying infrastructure for installing a Kubernetes cluster"입니다. 공식 문서 "Installing kubeadm"과 "Container Runtimes"의 사전 조건을 모으면 체크리스트 하나가 됩니다.

### 2-1. 기계 조건

| 항목 | 문서 기준 |
|---|---|
| 메모리 | 머신당 2GB 이상 |
| CPU | 컨트롤 플레인은 2개 이상 |
| 네트워크 | 모든 머신 사이 전체 연결 |
| 고유값 | 호스트 이름, MAC 주소, `product_uuid`가 노드마다 달라야 함(`sudo cat /sys/class/dmi/id/product_uuid`로 확인) |
| 포트 | 필요한 포트가 열려 있어야 함. 예: `nc 127.0.0.1 6443 -zv -w 2` |

가상 머신을 복제해 노드를 만들면 MAC이나 `product_uuid`가 같아질 수 있습니다. 문서는 쿠버네티스가 이 값으로 노드를 구분하므로 겹치면 설치가 실패할 수 있다고 적습니다.

### 2-2. 스왑

kubelet은 기본 설정에서 노드에 스왑이 잡혀 있으면 시작하지 않습니다. 길은 둘입니다.

- 스왑을 끕니다. `sudo swapoff -a`는 재부팅하면 풀리니 `/etc/fstab` 같은 설정에서도 지웁니다.
- 스왑을 허용합니다. kubelet 설정에 `failSwapOn: false`를 넣습니다. 이렇게 해도 워크로드가 스왑을 쓰려면 `swapBehavior`를 기본값 `NoSwap` 외의 값으로 따로 정해야 합니다.

### 2-3. IP 포워딩

리눅스 커널은 기본으로 인터페이스 사이 IPv4 패킷 라우팅을 막습니다. 대부분의 네트워크 플러그인이 알아서 켜지만 관리자가 켜 주기를 기대하는 플러그인도 있다고 문서에 적혀 있습니다.

```bash
cat <<EOF | sudo tee /etc/sysctl.d/k8s.conf
net.ipv4.ip_forward = 1
EOF
sudo sysctl --system
sysctl net.ipv4.ip_forward   # 1이면 적용됨
```

### 2-4. 컨테이너 런타임과 cgroup 드라이버

노드마다 CRI를 따르는 런타임(containerd, CRI-O 등)이 있어야 kubelet이 Pod를 띄웁니다. 여기서 가장 흔한 함정이 cgroup 드라이버입니다. kubelet과 런타임이 같은 드라이버를 써야 하고 문서는 이를 "critical"이라고 적습니다.

| 드라이버 | 문서 설명 |
|---|---|
| `cgroupfs` | kubelet 설정의 기본값. systemd가 init인 시스템에서는 권장하지 않음. cgroup v2라면 쓰지 말라고 적음 |
| `systemd` | systemd가 init이면 권장. cgroup 관리자가 하나로 유지됨 |

systemd를 init으로 쓰면서 kubelet과 런타임은 `cgroupfs`를 쓰면 cgroup 관리자가 둘이 됩니다. 문서는 이 상태에서 자원 압박이 오면 노드가 불안정해질 수 있다고 설명합니다. containerd는 `/etc/containerd/config.toml`의 runc 옵션에 `SystemdCgroup = true`를 넣고 kubelet은 `KubeletConfiguration`에 `cgroupDriver: systemd`를 넣습니다. containerd 1.x와 2.x는 설정 섹션 이름이 다르니 문서에서 버전에 맞는 블록을 봅니다.

업그레이드 문서에는 v1.37 기준으로 리눅스 kubelet이 기본적으로 cgroup v2만 지원하고 `FailCgroupV1`이 기본 `true`라는 메모가 있습니다. 오래된 cgroup v1 배포판 위에서 연습하면 kubelet이 뜨지 않을 수 있습니다.

### 2-5. kubeadm, kubelet, kubectl 패키지

패키지 저장소는 `pkgs.k8s.io`이고 마이너 버전마다 저장소 경로가 다릅니다. 예전 `apt.kubernetes.io`와 `yum.kubernetes.io`는 동결되었습니다. 설치 뒤 세 패키지를 `apt-mark hold`로 고정하는 이유는 일반 `apt upgrade`가 쿠버네티스 버전을 몰래 올리지 못하게 하려는 것입니다.

```bash
sudo apt-mark hold kubelet kubeadm kubectl
sudo systemctl enable --now kubelet
```

이 시점의 kubelet은 몇 초마다 재시작합니다. 문서 표현으로는 kubeadm이 할 일을 알려 줄 때까지 crashloop로 기다리는 상태이고 정상입니다.

### 2-6. 직접 해 보기

새 VM 두 대에서 체크리스트를 위에서부터 확인합니다. 스왑 상태(`swapon --show`), `net.ipv4.ip_forward` 값, containerd의 `SystemdCgroup` 값, `product_uuid`를 적어 두고 하나라도 다르면 고친 뒤 다음 절로 갑니다.

## 3. kubeadm으로 클러스터 생성과 관리

커리큘럼 문구는 "Create and manage Kubernetes clusters using kubeadm"입니다.

### 3-1. kubeadm init

```bash
sudo kubeadm init \
  --control-plane-endpoint=cluster-endpoint:6443 \
  --pod-network-cidr=<CNI 문서가 요구하는 대역>
```

"Creating a cluster with kubeadm" 문서 기준으로 플래그의 쓰임새를 정리합니다.

| 플래그 | 언제 쓰는지 |
|---|---|
| `--control-plane-endpoint` | 나중에 고가용성으로 늘릴 계획이 있으면 처음부터 지정. 이 플래그 없이 만든 단일 컨트롤 플레인을 고가용성으로 바꾸는 것은 kubeadm이 지원하지 않음 |
| `--pod-network-cidr` | 쓰려는 CNI 플러그인이 요구할 때. 호스트 네트워크와 겹치면 안 됨 |
| `--apiserver-advertise-address` | 이 컨트롤 플레인 노드의 API 서버가 광고할 주소를 바꿀 때 |
| `--cri-socket` | 노드에 런타임이 여럿이라 어느 것을 쓸지 지정해야 할 때 |

`init`이 끝나면 출력에 kubeconfig 복사 명령과 `kubeadm join` 명령이 나옵니다. 아래는 문서에 실린 출력 모양입니다.

```text
To start using your cluster, you need to run the following as a regular user:

  mkdir -p $HOME/.kube
  sudo cp -i /etc/kubernetes/admin.conf $HOME/.kube/config
  sudo chown $(id -u):$(id -g) $HOME/.kube/config
```

### 3-2. CoreDNS는 CNI 설치 뒤에 시작

문서는 CNI 기반 Pod 네트워크 애드온을 설치해야 Pod끼리 통신하고 네트워크가 설치되기 전에는 CoreDNS가 시작되지 않는다고 적습니다. `init` 직후 CoreDNS가 `Pending`이고 노드가 `NotReady`인 것은 CNI 설치를 기다리는 정상 상태입니다.

### 3-3. 노드 조인과 토큰

```bash
# 워커 노드에서
sudo kubeadm join <컨트롤플레인 주소>:6443 --token <토큰> \
  --discovery-token-ca-cert-hash sha256:<해시>

# 토큰이 만료됐거나 출력을 잃어버렸을 때 컨트롤 플레인에서
kubeadm token create --print-join-command
```

`kubeadm token create`의 `--ttl` 기본값은 24시간입니다. 하루가 지나 init 출력의 join 명령을 그대로 쓰면 실패하는 이유입니다. 토큰을 가진 사람은 누구나 인증된 노드를 붙일 수 있으니 문서는 토큰을 비밀로 다루라고 적습니다.

### 3-4. 컨트롤 플레인 테인트와 노드 제거

kubeadm은 컨트롤 플레인 노드에 `node-role.kubernetes.io/control-plane:NoSchedule` 테인트를 붙입니다. 노드 한 대로 연습할 때는 아래 명령으로 지웁니다. 끝의 `-`가 제거를 뜻합니다.

```bash
kubectl taint nodes --all node-role.kubernetes.io/control-plane-
```

노드를 빼는 순서는 문서에 이렇게 나옵니다.

```bash
kubectl drain <노드> --delete-emptydir-data --force --ignore-daemonsets
sudo kubeadm reset          # 해당 노드에서
kubectl delete node <노드>
```

`kubeadm reset`은 iptables 규칙과 IPVS 테이블을 지우지 않습니다. 같은 노드를 다시 쓸 거라면 문서의 `iptables -F ...`, `ipvsadm -C` 명령으로 직접 정리합니다.

### 3-5. 직접 해 보기

컨트롤 플레인 1대와 워커 1대로 쇼핑몰 연습용 클러스터를 만듭니다. join 명령을 일부러 버린 뒤 `kubeadm token create --print-join-command`로 다시 만들어 워커를 붙이고 `kubectl get nodes`에서 두 노드가 `Ready`가 될 때까지 CNI 설치 전후의 상태 차이를 기록합니다.

## 4. 클러스터 수명주기: 업그레이드, 인증서, etcd

커리큘럼 문구는 "Manage the lifecycle of Kubernetes clusters"입니다. 개정 전 커리큘럼에 따로 있던 kubeadm 업그레이드와 etcd 백업이 이 한 줄에 포함되는지는 공식 문서에 적혀 있지 않습니다. 응시 후기도 갈립니다. 정정일(2025)은 시험 범위 정리에 "ETCD 백업/복구"를 넣었고 Domenic Cassisi(2026)는 etcd 관리 과제가 최근 범위에서 빠졌다고 적었습니다. 저는 둘 다 한 번씩 손으로 해 보는 쪽을 골랐습니다.

### 4-1. 버전 차이 규칙

"Version Skew Policy"와 업그레이드 문서에서 시험에 걸리는 규칙만 추립니다.

- 업그레이드할 때 마이너 버전을 건너뛰는 것은 지원하지 않습니다. 1.35에서 1.37로 가려면 1.36을 거칩니다.
- kubelet은 kube-apiserver보다 새로우면 안 되고 최대 세 마이너 버전까지 오래될 수 있습니다.
- 그래서 순서가 컨트롤 플레인 먼저, kubelet 나중입니다.

### 4-2. 업그레이드 순서

"Upgrading kubeadm clusters" 문서는 현재 1.36.x에서 1.37.x로 올리는 절차를 다룹니다. 시작 전에 패키지 저장소를 목표 마이너 버전(`pkgs.k8s.io`의 해당 경로)으로 바꿔야 새 버전이 보입니다.

첫 번째 컨트롤 플레인 노드에서 하는 일입니다.

```bash
# 1) kubeadm만 먼저 올린다 (x는 패치 버전)
sudo apt-mark unhold kubeadm && \
sudo apt-get update && sudo apt-get install -y kubeadm='1.37.x-*' && \
sudo apt-mark hold kubeadm
kubeadm version

# 2) 계획 확인, 적용
sudo kubeadm upgrade plan
sudo kubeadm upgrade apply v1.37.x
```

문서에 실린 성공 출력은 아래 모양입니다.

```text
[upgrade/successful] SUCCESS! Your cluster was upgraded to "v1.37.x". Enjoy!
[upgrade/kubelet] Now that your control plane is upgraded, please proceed with upgrading your kubelets if you haven't already done so.
```

그 다음 노드마다 같은 네 단계를 반복합니다.

```bash
kubectl drain <노드> --ignore-daemonsets

sudo apt-mark unhold kubelet kubectl && \
sudo apt-get update && sudo apt-get install -y kubelet='1.37.x-*' kubectl='1.37.x-*' && \
sudo apt-mark hold kubelet kubectl

sudo systemctl daemon-reload
sudo systemctl restart kubelet

kubectl uncordon <노드>
```

| 대상 | kubeadm 단계에서 쓰는 명령 | 비고 |
|---|---|---|
| 첫 컨트롤 플레인 | `kubeadm upgrade apply v1.37.x` | `upgrade plan`과 CNI 플러그인 업그레이드도 이 노드에서 |
| 나머지 컨트롤 플레인 | `kubeadm upgrade node` | plan과 CNI 업그레이드는 필요 없음 |
| 워커 | `kubeadm upgrade node` | 워커에서는 kubelet 설정만 갱신 |

`drain`과 `uncordon`은 kubectl이 있는 곳에서 실행합니다. 시험에서는 과제마다 ssh로 노드를 옮기니 kubeadm과 apt 명령은 해당 노드에서, drain은 컨트롤 플레인에서 실행하는 식으로 위치가 바뀝니다.

### 4-3. 업그레이드 실패 시 재실행과 백업 디렉터리

문서는 `kubeadm upgrade`가 멱등이라 중간에 끊겨도 다시 실행하면 된다고 적습니다. 업그레이드 중 kubeadm은 `/etc/kubernetes/tmp` 아래에 두 백업을 남깁니다.

- `kubeadm-backup-etcd-<날짜>-<시각>`: 이 노드의 로컬 etcd 데이터. 자동 롤백이 안 되면 `/var/lib/etcd`로 수동 복원
- `kubeadm-backup-manifests-<날짜>-<시각>`: 이 노드의 static Pod 매니페스트. 자동 롤백이 안 되면 `/etc/kubernetes/manifests`로 수동 복원

이 디렉터리는 업그레이드가 끝나도 남으니 직접 지웁니다.

### 4-4. 인증서 만료

kubeadm이 만든 클라이언트 인증서는 1년 뒤 만료됩니다. CA 기본 유효 기간은 10년입니다. `kubeadm upgrade`는 그 노드에서 관리하는 인증서를 자동으로 갱신하므로 1년 안에 한 번씩 업그레이드하면 만료를 피할 수 있다고 문서는 설명합니다.

```bash
sudo kubeadm certs check-expiration
sudo kubeadm certs renew all
```

컨트롤 플레인이 여러 대면 `renew`를 모든 컨트롤 플레인 노드에서 실행합니다. 갱신한 뒤에는 컨트롤 플레인 Pod를 재시작해야 합니다. 모든 구성요소가 인증서를 동적으로 다시 읽지는 못하기 때문입니다. static Pod는 노드의 kubelet이 관리해서 kubectl로 지우고 다시 띄울 수 없습니다. 그래서 문서는 매니페스트를 `/etc/kubernetes/manifests/` 밖으로 잠시 옮기고 20초(kubelet의 `fileCheckFrequency`)쯤 기다렸다가 되돌리라고 적습니다.

### 4-5. etcd 백업

kubeadm 클러스터의 etcd는 컨트롤 플레인 노드의 static Pod이고 데이터 디렉터리는 `/var/lib/etcd`입니다. 스냅샷은 동작 중인 멤버에서 `etcdctl snapshot save`로 뜹니다. 문서는 스냅샷 생성이 그 멤버의 성능에 영향을 주지 않는다고 적습니다.

```bash
ETCDCTL_API=3 etcdctl --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  snapshot save /opt/backup/etcd-snapshot.db
```

인증서 경로는 문서의 보안 통신 예시에 나온 kubeadm 기본 경로입니다. 시험 환경에서는 경로가 다를 수 있으니 문서 권고대로 etcd Pod 설명에서 확인합니다.

```bash
kubectl -n kube-system describe pod etcd-<노드 이름> | grep -E 'cert|key|trusted'
# 또는 노드에서
sudo cat /etc/kubernetes/manifests/etcd.yaml
```

스냅샷 확인은 `etcdutl`로 합니다. 문서는 `etcdctl snapshot status`가 etcd v3.5부터 사용 중단이고 v3.6에서 제거 예정이라고 적습니다.

```bash
etcdutl --write-out=table snapshot status /opt/backup/etcd-snapshot.db
```

문서에 실린 출력 모양입니다.

```text
+----------+----------+------------+------------+
|   HASH   | REVISION | TOTAL KEYS | TOTAL SIZE |
+----------+----------+------------+------------+
| fe01cf57 |       10 |          7 | 2.1 MB     |
+----------+----------+------------+------------+
```

### 4-6. etcd 복구

복구는 새 데이터 디렉터리를 만드는 일입니다. `etcdutl`로 스냅샷을 새 디렉터리에 풀고 etcd가 그 디렉터리를 보게 매니페스트를 바꿉니다.

```bash
sudo etcdutl --data-dir /var/lib/etcd-restore snapshot restore /opt/backup/etcd-snapshot.db
```

문서 절차에 따르면 이어서 `/etc/kubernetes/manifests/etcd.yaml`에서 `name: etcd-data` 볼륨의 `hostPath.path`를 새 디렉터리로 바꾸고 etcd Pod를 지우거나 `systemctl restart kubelet`으로 다시 띄웁니다. 매니페스트를 고치면 kubelet이 static Pod를 다시 만들기 때문입니다.

문서의 주의 사항도 같이 외웁니다.

- API 서버가 돌고 있는 상태에서 etcd를 복구하지 말라고 적혀 있습니다. 모든 API 서버를 멈추고 모든 etcd를 복구하고 API 서버를 다시 시작하는 순서입니다. kube-scheduler, kube-controller-manager, kubelet도 재시작을 권합니다.
- 같은 major.minor 버전의 etcd에서 뜬 스냅샷으로 복구할 수 있고 패치 버전 차이는 괜찮습니다.
- etcd 멤버 과반이 영구히 죽으면 클러스터는 상태를 바꿀 수 없습니다. 이미 떠 있는 Pod는 돌 수 있어도 새 Pod는 스케줄되지 않습니다.

### 4-7. 직접 해 보기

결제 서비스 네임스페이스 `payment`에 Deployment 하나를 만들고 스냅샷을 뜹니다. 그 다음 Deployment를 지우고 스냅샷을 `/var/lib/etcd-restore`에 복구해 매니페스트를 바꾼 뒤 Deployment가 돌아오는지 확인합니다. 복구 전후에 `etcdutl snapshot status`의 REVISION 값을 적어 둡니다.

## 5. 고가용성 컨트롤 플레인

커리큘럼 문구는 "Implement and configure a highly-available control plane"입니다.

### 5-1. 두 가지 토폴로지

"Options for Highly Available Topology" 문서는 두 구조를 비교합니다.

| 항목 | stacked etcd | external etcd |
|---|---|---|
| etcd 위치 | 컨트롤 플레인 노드마다 로컬 etcd 멤버 | 별도 호스트 |
| 장점 | 구성이 단순하고 kubeadm 기본값 | 컨트롤 플레인 하나나 etcd 하나를 잃어도 다른 쪽 중복성에 영향이 적음 |
| 대가 | 노드 하나가 죽으면 etcd 멤버와 컨트롤 플레인을 함께 잃음 | 호스트가 두 배 필요 |
| 최소 규모 | 컨트롤 플레인 3대 | 컨트롤 플레인 3대와 etcd 3대 |

두 구조 모두 각 컨트롤 플레인 노드가 kube-apiserver, kube-scheduler, kube-controller-manager를 하나씩 돌리고 kube-apiserver는 로드 밸런서 뒤에서 워커에 노출됩니다.

최소가 3대인 이유는 etcd의 과반 규칙입니다. 멤버 3개의 과반은 2개라 1대가 죽어도 쓰기가 됩니다. 2대로는 1대만 죽어도 과반이 깨집니다. "Operating etcd clusters for Kubernetes" 문서는 멤버 수를 홀수로 두고 운영 환경에서는 다섯 멤버를 권합니다.

### 5-2. 만드는 순서

"Creating Highly Available Clusters with kubeadm" 기준입니다.

1. kube-apiserver용 로드 밸런서를 만들고 DNS 이름을 붙입니다. 기본 포트는 6443입니다.
2. 첫 컨트롤 플레인에서 로드 밸런서 주소로 init합니다.

```bash
sudo kubeadm init --control-plane-endpoint "LOAD_BALANCER_DNS:LOAD_BALANCER_PORT" --upload-certs
```

3. 출력에 나온 컨트롤 플레인용 join 명령을 나머지 컨트롤 플레인 노드에서 실행합니다. 워커용 명령과의 차이는 `--control-plane --certificate-key <키>` 두 플래그입니다.

`--upload-certs`는 컨트롤 플레인 인증서를 암호화해 `kubeadm-certs` Secret에 올립니다. 이 Secret과 복호화 키는 2시간 뒤 만료됩니다. 그 뒤에 컨트롤 플레인을 추가하려면 이미 붙은 컨트롤 플레인에서 다시 올립니다.

```bash
sudo kubeadm init phase upload-certs --upload-certs
```

### 5-3. 헷갈리는 지점

- 3-1절의 제약과 연결됩니다. `--control-plane-endpoint` 없이 만든 클러스터를 나중에 고가용성으로 바꾸는 것은 지원하지 않습니다.
- 컨트롤 플레인 노드를 짝수로 늘리면 etcd 장애 허용 수가 늘지 않습니다. 4대의 과반은 3대라 3대일 때처럼 1대까지만 버팁니다.

### 5-4. 직접 해 보기

VM이 넉넉하면 컨트롤 플레인 3대를 stacked 구조로 만들고 한 대의 kubelet을 멈춘 뒤 `kubectl get nodes`가 계속 응답하는지 봅니다. VM이 부족하면 위 init과 join 명령을 문서에서 찾아 실행 순서만 손으로 적어 봅니다.

## 6. Helm과 Kustomize로 구성요소 설치

커리큘럼 문구는 "Use Helm and Kustomize to install cluster components"입니다. 시험 중에 helm.sh/docs를 열 수 있습니다([CKA Ch-00 3-3절](/blog/cert/cka/cka-00-exam-and-study-plan)).

### 6-1. Helm

Helm은 매니페스트 묶음(차트)을 값과 합쳐 클러스터에 설치하고 설치 하나하나를 릴리스로 기록합니다. 설치, 업그레이드, 롤백 때마다 리비전 번호가 하나씩 오릅니다. 2026년 10월 현재 helm.sh 문서의 기본 버전은 4.3.1입니다.

```bash
helm repo add <이름> <URL>
helm repo update
helm search repo <키워드>

# 어떤 값을 바꿀 수 있는지 먼저 본다
helm show values <저장소>/<차트>

# 네임스페이스를 만들면서 설치, 값 덮어쓰기
helm install shop-cache <저장소>/<차트> \
  -n shop --create-namespace \
  --set replicaCount=2

helm list -n shop
helm upgrade shop-cache <저장소>/<차트> -n shop -f values-shop.yaml
helm history shop-cache -n shop
helm rollback shop-cache 1 -n shop
helm uninstall shop-cache -n shop
```

| 명령 | 문서 설명 요약 |
|---|---|
| `helm show values` | 차트에서 설정할 수 있는 값 목록 |
| `--set` | 명령줄에서 값 덮어쓰기 |
| `-f`, `--values` | YAML 파일로 값 덮어쓰기. 여러 번 줄 수 있고 가장 오른쪽 파일이 우선 |
| `--create-namespace` | 릴리스 네임스페이스가 없으면 만든다 |
| `--version` | 차트 버전 제약. 없으면 최신 |
| `helm template` | 차트를 로컬에서 렌더링해 출력만 한다 |
| `helm uninstall` | 릴리스 삭제. `--keep-history`가 없으면 기록도 지움 |

Quickstart 문서처럼 저장소 추가 없이 OCI 주소(`oci://...`)로 바로 설치하는 방식도 있습니다.

### 6-2. Kustomize

Kustomize는 원본 YAML을 고치지 않고 `kustomization.yaml`에 적은 변형(네임스페이스, 이름 접두사, 패치, 이미지 교체)을 덧입혀 결과 매니페스트를 만듭니다. kubectl에는 1.14부터 들어 있어 따로 설치할 필요가 없습니다.

```bash
kubectl kustomize ./overlays/prod   # 결과만 보기
kubectl apply -k ./overlays/prod    # 적용
kubectl get -k ./overlays/prod
kubectl diff -k ./overlays/prod
kubectl delete -k ./overlays/prod
```

```yaml
# overlays/prod/kustomization.yaml (쇼핑몰 주문 API 예)
resources:
  - ../../base
namespace: shop
namePrefix: prod-
images:
  - name: order-api
    newTag: "1.4.2"
patches:
  - path: replica-patch.yaml
configMapGenerator:
  - name: order-config
    literals:
      - LOG_LEVEL=info
```

문서에서 시험에 걸릴 만한 성질은 두 가지입니다.

- base는 overlay를 모릅니다. 같은 base를 여러 overlay가 가져다 접두사나 네임스페이스만 바꿔 씁니다.
- `configMapGenerator`와 `secretGenerator`가 만든 객체 이름 뒤에는 내용 해시가 붙습니다. 내용이 바뀌면 이름이 바뀌고 그 이름을 참조하는 Deployment의 Pod 템플릿도 바뀌어 롤아웃이 일어납니다. 끄려면 `generatorOptions.disableNameSuffixHash: true`를 씁니다.

### 6-3. 헷갈리는 지점

- `helm install`의 인자 순서는 `[NAME] [CHART]`입니다. 릴리스 이름을 빼면 오류가 나고 자동 이름을 원하면 `--generate-name`을 씁니다.
- `kubectl kustomize`는 출력만 하고 적용하지 않습니다. 적용은 `-k`입니다.

### 6-4. 직접 해 보기

게시판 서비스용 base(Deployment와 Service)를 만들고 `dev`, `prod` 두 overlay에서 네임스페이스와 레플리카 수만 다르게 적용합니다. 다음으로 아무 공개 차트 하나를 `helm show values`로 열어 값 하나를 `--set`으로 바꿔 설치하고 `helm upgrade`와 `helm rollback`으로 리비전이 1, 2, 3으로 오르는 것을 `helm history`로 확인합니다.

## 7. 확장 인터페이스: CNI, CSI, CRI

커리큘럼 문구는 "Understand extension interfaces (CNI, CSI, CRI, etc.)"입니다. 셋 다 쿠버네티스 코드를 다시 빌드하지 않고 바깥 구현을 끼워 넣기 위한 규약입니다.

| 인터페이스 | 누가 부르는지 | 무엇을 맡기는지 | 문서에서 확인한 사실 |
|---|---|---|---|
| CRI | kubelet(gRPC 클라이언트) | 컨테이너와 이미지 관리 | 1.26부터 kubelet은 런타임이 `v1` CRI API를 지원해야 노드를 등록. 엔드포인트는 kubelet의 `--container-runtime-endpoint` |
| CNI | 컨테이너 런타임 | Pod 네트워크(IP 할당, 라우팅) | 쿠버네티스 네트워크 모델 구현에 필요. CNI 스펙 v0.4.0 이상 호환 필수, v1.0.0 호환 권장. 설정 파일 기본 위치 `/etc/cni/net.d` |
| CSI | 쿠버네티스 볼륨 계층 | 스토리지 연결과 마운트 | 저장소 업체가 쿠버네티스 코드 밖에서 드라이버를 개발. FlexVolume은 사용 중단 |

### 7-1. CRI

dockershim은 1.24에서 빠졌습니다. 그래서 지금 노드에는 containerd나 CRI-O 같은 CRI 런타임이 있습니다. 문서가 적은 기본 소켓 경로는 containerd `/run/containerd/containerd.sock`, CRI-O `/var/run/crio/crio.sock`, cri-dockerd `/run/cri-dockerd.sock`입니다. 노드에서 컨테이너를 직접 보는 도구가 `crictl`이고 트러블슈팅 영역에서 다시 씁니다.

### 7-2. CNI

kubelet이 CNI를 직접 다루던 `cni-bin-dir`, `network-plugin` 플래그는 1.24에서 사라졌습니다. 지금은 런타임이 CNI 플러그인을 불러옵니다. 그래서 Pod IP가 안 잡히면 `/etc/cni/net.d`의 설정과 플러그인 Pod 상태부터 봅니다. 문서에 적힌 플러그인 바이너리 기본 위치는 `/opt/cni/bin`입니다. NetworkPolicy는 CNI 플러그인이 지원해야 동작하며 이 부분은 Services and Networking 영역에서 다룹니다.

### 7-3. CSI

예전 볼륨 플러그인은 쿠버네티스 바이너리 안에 들어 있는 in-tree 방식이었습니다. 새 스토리지를 붙이려면 쿠버네티스 코드에 기여해야 했습니다. CSI는 이 결합을 끊었습니다. CSI 드라이버가 설치되면 PVC, 일반 임시 볼륨, (드라이버가 지원하면) CSI 임시 볼륨 세 경로로 Pod에 붙일 수 있습니다. StorageClass의 `provisioner`에 적는 이름이 CSI 드라이버 이름이고 Storage 영역에서 다시 나옵니다.

### 7-4. 직접 해 보기

노드에서 아래를 확인해 어떤 런타임과 CNI가 깔려 있는지 표로 적습니다.

```bash
sudo crictl info | head -20
ls /etc/cni/net.d/
kubectl get pods -n kube-system -o wide
kubectl get csidrivers
```

## 8. CRD와 오퍼레이터

커리큘럼 문구는 "Understand CRDs, install and configure operators"입니다.

### 8-1. CRD

CustomResourceDefinition을 만들면 API 서버가 새 REST 경로를 엽니다. 그 뒤로는 내장 리소스처럼 `kubectl get`, `apply`, `delete`를 씁니다. "Extend the Kubernetes API with CustomResourceDefinitions" 문서의 핵심 규칙입니다.

- CRD 자체는 네임스페이스가 없습니다. CRD로 만든 커스텀 객체는 `spec.scope`에 따라 `Namespaced`이거나 `Cluster`입니다.
- CRD 이름은 `<plural>.<group>` 형식이어야 합니다.
- 버전 여러 개를 둘 수 있고 저장 버전(`storage: true`)은 정확히 하나여야 합니다.
- 만든 직후 엔드포인트가 열리기까지 몇 초 걸릴 수 있습니다. CRD의 `Established` condition으로 확인합니다.
- 네임스페이스를 지우면 그 안의 커스텀 객체도 지워집니다.

게시판 예약 작업을 표현하는 CRD를 예로 들면 이렇습니다.

```yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: boardjobs.example.com        # <plural>.<group>
spec:
  group: example.com
  scope: Namespaced
  names:
    plural: boardjobs
    singular: boardjob
    kind: BoardJob
    shortNames: ["bj"]
  versions:
    - name: v1
      served: true
      storage: true
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              properties:
                schedule:
                  type: string
                image:
                  type: string
```

```bash
kubectl apply -f boardjob-crd.yaml
kubectl get crd boardjobs.example.com
kubectl api-resources --api-group=example.com
kubectl explain boardjob.spec
kubectl get bj -A
```

`kubectl explain`이 CRD 스키마도 보여 주므로, 처음 보는 CRD가 시험에 나와도 필드 이름을 터미널에서 찾을 수 있습니다.

### 8-2. 오퍼레이터

"Operator pattern" 문서의 정의는 커스텀 리소스를 써서 애플리케이션을 관리하는 소프트웨어 확장입니다. 컨트롤 루프를 따르고 커스텀 리소스의 컨트롤러 역할을 하는 쿠버네티스 API 클라이언트입니다. 문서의 예시(SampleDB)를 보면 오퍼레이터 하나는 보통 이렇게 구성됩니다.

1. 커스텀 리소스 정의(CRD)
2. 컨트롤러 코드를 돌리는 Deployment
3. 컨트롤러가 API를 읽고 쓰기 위한 권한(ServiceAccount와 RBAC)

그래서 "오퍼레이터를 설치하라"는 과제는 대개 Helm 차트나 매니페스트로 위 세 가지를 한꺼번에 넣는 일이고 "구성하라"는 그 오퍼레이터의 커스텀 리소스를 만드는 일입니다. 설치 뒤에는 `kubectl get crd`로 새 CRD가 생겼는지, 컨트롤러 Pod가 `Running`인지, 커스텀 객체를 만들었을 때 컨트롤러가 하위 리소스를 만드는지 차례로 봅니다.

### 8-3. 헷갈리는 지점

- CRD를 지우면 그 CRD로 만든 커스텀 객체도 함께 사라집니다. 문서에 "Delete a CustomResourceDefinition" 절이 따로 있습니다.
- CRD만 있고 컨트롤러가 없으면 객체는 저장만 되고 아무 일도 일어나지 않습니다. 동작을 만드는 쪽은 오퍼레이터의 컨트롤러입니다.

### 8-4. 직접 해 보기

위 `BoardJob` CRD를 적용하고 커스텀 객체 하나를 만든 뒤 `kubectl get bj -o yaml`로 저장된 내용을 확인합니다. 이어서 CRD를 지우고 커스텀 객체도 사라지는지 봅니다.

## 9. 확인 문제

위 내용을 바탕으로 직접 만든 연습 과제입니다.

1. 네임스페이스 `payment`에 ServiceAccount `settle-bot`을 만들고 이 계정이 `payment`의 Secret을 `get`만 할 수 있게 하세요. `list`는 안 되어야 합니다.
2. 클러스터의 모든 네임스페이스에서 Deployment를 볼 수만 있는 권한을 그룹 `auditors`에 주세요.
3. 이미 있는 RoleBinding `order-binding`이 Role `old-role`을 가리킵니다. `new-role`을 가리키게 바꾸세요.
4. 워커 노드 `node02`의 kubelet만 1.37.x로 올리세요. 컨트롤 플레인은 이미 1.37.x입니다.
5. etcd 스냅샷을 `/opt/backup/shop.db`에 저장하고 상태를 표로 확인하세요.
6. 1시간 전에 받은 join 명령이 동작하지 않습니다. 워커를 붙일 새 명령을 만드세요.
7. Helm 릴리스 `shop-cache`를 바로 전 리비전으로 되돌리세요.
8. Kustomize 디렉터리 `./board/overlays/dev`의 결과를 적용 전에 확인하고 적용하세요.

<details>
<summary>풀이 보기</summary>

1. 동사를 `get` 하나로 제한합니다.
   ```bash
   kubectl create serviceaccount settle-bot -n payment
   kubectl create role secret-getter -n payment --verb=get --resource=secrets
   kubectl create rolebinding settle-bot-secret-getter -n payment \
     --role=secret-getter --serviceaccount=payment:settle-bot
   kubectl auth can-i get secrets -n payment --as=system:serviceaccount:payment:settle-bot    # yes
   kubectl auth can-i list secrets -n payment --as=system:serviceaccount:payment:settle-bot   # no
   ```
2. 모든 네임스페이스라서 ClusterRole과 ClusterRoleBinding입니다.
   ```bash
   kubectl create clusterrole deploy-viewer --verb=get,list,watch --resource=deployments.apps
   kubectl create clusterrolebinding auditors-deploy-viewer \
     --clusterrole=deploy-viewer --group=auditors
   kubectl auth can-i list deployments -A --as=someone --as-group=auditors
   ```
3. `roleRef`는 바꿀 수 없으니 지우고 다시 만듭니다. 기존 주체를 먼저 확인합니다.
   ```bash
   kubectl get rolebinding order-binding -o yaml > /tmp/order-binding.yaml
   kubectl delete rolebinding order-binding
   # /tmp/order-binding.yaml에서 roleRef.name을 new-role로 고치고 metadata의 resourceVersion, uid를 지운 뒤
   kubectl apply -f /tmp/order-binding.yaml
   ```
4. 워커 문서("Upgrading Linux nodes")의 순서는 kubeadm 갱신, `kubeadm upgrade node`, drain, kubelet 갱신, uncordon입니다. drain과 uncordon은 kubectl이 되는 곳에서 실행합니다.
   ```bash
   ssh node02
   sudo apt-mark unhold kubeadm && sudo apt-get update && \
     sudo apt-get install -y kubeadm='1.37.x-*' && sudo apt-mark hold kubeadm
   sudo kubeadm upgrade node
   exit

   kubectl drain node02 --ignore-daemonsets

   ssh node02
   sudo apt-mark unhold kubelet kubectl && sudo apt-get update && \
     sudo apt-get install -y kubelet='1.37.x-*' kubectl='1.37.x-*' && sudo apt-mark hold kubelet kubectl
   sudo systemctl daemon-reload && sudo systemctl restart kubelet
   exit

   kubectl uncordon node02
   ```
5. 인증서 경로를 etcd 매니페스트에서 확인하고 저장, 확인합니다.
   ```bash
   ETCDCTL_API=3 etcdctl --endpoints=https://127.0.0.1:2379 \
     --cacert=/etc/kubernetes/pki/etcd/ca.crt \
     --cert=/etc/kubernetes/pki/etcd/server.crt \
     --key=/etc/kubernetes/pki/etcd/server.key \
     snapshot save /opt/backup/shop.db
   etcdutl --write-out=table snapshot status /opt/backup/shop.db
   ```
6. 토큰 기본 수명은 24시간이라 1시간이면 만료 전입니다. 토큰을 지웠거나 명령을 잘못 옮긴 경우일 수 있으니 새로 만듭니다.
   ```bash
   kubeadm token list
   kubeadm token create --print-join-command
   ```
7. 리비전 번호를 확인하고 되돌립니다.
   ```bash
   helm history shop-cache -n <네임스페이스>
   helm rollback shop-cache <직전 리비전> -n <네임스페이스>
   ```
   `helm rollback` 문서에 따르면 리비전을 생략하거나 0을 주면 직전 릴리스로 돌아갑니다. 번호를 직접 적으면 의도가 명령에 남습니다.
8. 출력 확인 뒤 적용합니다.
   ```bash
   kubectl kustomize ./board/overlays/dev
   kubectl apply -k ./board/overlays/dev
   ```

</details>

## 범위와 한계

- 이 글의 명령은 공식 문서에서 옮긴 것이고 아직 직접 실행하지 않았습니다. 출력 예시는 문서에 실린 모양을 옮긴 것입니다. kubeadm 클러스터를 만든 뒤 실제 출력과 막힌 지점을 덧붙이겠습니다.
- 공식 문서는 2026년 10월 19일 기준 kubernetes.io(v1.37)와 helm.sh(4.3.1)에서 확인했습니다.
- etcd 백업과 업그레이드가 현재 시험에 나오는지는 공식 문서로 확인하지 못했습니다. 후기도 엇갈립니다(4절 첫 문단).
- 확인 문제는 위 문서 내용을 바탕으로 제가 만든 것이고 실제 시험 문항과 관계없습니다. 풀이도 클러스터에서 돌려 보지 않았습니다.
- containerd 설정 블록은 containerd 버전마다 달라 문서의 1.x, 2.x 예시를 그대로 따라야 합니다.

## 참고 자료

공식 문서
- CNCF, [CKA Curriculum v1.37](https://github.com/cncf/curriculum/blob/master/CKA_Curriculum_v1.37.pdf)
- Kubernetes, [Using RBAC Authorization](https://kubernetes.io/docs/reference/access-authn-authz/rbac/), [Authorization](https://kubernetes.io/docs/reference/access-authn-authz/authorization/)
- Kubernetes, [Installing kubeadm](https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/install-kubeadm/), [Container Runtimes](https://kubernetes.io/docs/setup/production-environment/container-runtimes/)
- Kubernetes, [Creating a cluster with kubeadm](https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/create-cluster-kubeadm/), [kubeadm token](https://kubernetes.io/docs/reference/setup-tools/kubeadm/kubeadm-token/)
- Kubernetes, [Version Skew Policy](https://kubernetes.io/releases/version-skew-policy/), [Upgrading kubeadm clusters](https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/kubeadm-upgrade/), [Upgrading Linux nodes](https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/upgrading-linux-nodes/), [Certificate Management with kubeadm](https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/kubeadm-certs/)
- Kubernetes, [Operating etcd clusters for Kubernetes](https://kubernetes.io/docs/tasks/administer-cluster/configure-upgrade-etcd/)
- Kubernetes, [Options for Highly Available Topology](https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/ha-topology/), [Creating Highly Available Clusters with kubeadm](https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/high-availability/)
- Kubernetes, [Declarative Management of Kubernetes Objects Using Kustomize](https://kubernetes.io/docs/tasks/manage-kubernetes-objects/kustomization/)
- Kubernetes, [Container Runtime Interface (CRI)](https://kubernetes.io/docs/concepts/containers/cri/), [Network Plugins](https://kubernetes.io/docs/concepts/extend-kubernetes/compute-storage-net/network-plugins/), [Volumes](https://kubernetes.io/docs/concepts/storage/volumes/)
- Kubernetes, [Extend the Kubernetes API with CustomResourceDefinitions](https://kubernetes.io/docs/tasks/extend-kubernetes/custom-resources/custom-resource-definitions/), [Operator pattern](https://kubernetes.io/docs/concepts/extend-kubernetes/operator/)
- Helm, [Using Helm](https://helm.sh/docs/intro/using_helm/), [Quickstart Guide](https://helm.sh/docs/intro/quickstart/), [helm install](https://helm.sh/docs/helm/helm_install/), [helm template](https://helm.sh/docs/helm/helm_template/), [helm rollback](https://helm.sh/docs/helm/helm_rollback/)

후기
- 정정일, [Certified Kubernetes Administrator (CKA) 합격 및 취득 후기](https://jeongil.dev/ko/blog/reflection/certified-kubernetes-administrator/), 2025
- Domenic Cassisi, [I passed the CKA! My Exam Experience (2026)](https://dcassisi.com/2026/06/09/i-passed-the-cka-my-exam-experience-2026/), 2026

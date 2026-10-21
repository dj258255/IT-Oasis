---
title: '[CKA Ch-02] 클러스터 아키텍처, 설치, 구성: kubeadm 한 벌로 만들고 올리고 되살리기'
description: CKA 비중 25%인 클러스터 아키텍처 영역을 시험에서 쓰는 명령과 함정 위주로 정리합니다. RBAC과 CSR, 노드와 런타임 준비, kubeadm 생성과 업그레이드, 인증서 갱신, etcd 백업과 복구(etcdutl), HA, Helm과 Kustomize, CNI·CSI·CRI, CRD와 오퍼레이터를 다룹니다.
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
  - cert
draft: false
series: "CKA 공부"
seriesOrder: 2
---

## 결론부터

1. 이 영역은 kubeadm 클러스터 한 벌의 일생입니다. 노드를 준비해 `kubeadm init`과 `join`으로 만들고 한 마이너씩 올리고 etcd 스냅샷으로 되살립니다.
2. RBAC은 Role, ClusterRole과 두 바인딩으로 끝나고 `kubectl auth can-i --as`로 검증합니다. 사람 사용자는 CSR 객체로 인증서를 받아 kubeconfig에 넣습니다.
3. 업그레이드는 마이너 버전을 건너뛸 수 없습니다. 첫 컨트롤 플레인은 `kubeadm upgrade apply`, 나머지 노드는 `kubeadm upgrade node`이고 노드마다 drain, kubelet 교체, uncordon을 반복합니다.
4. etcd 백업과 복구는 개정에서 명시 문구가 빠졌지만 수명주기 관리에 걸려 절차를 외워 둡니다. etcd 3.6부터 확인과 복구는 `etcdutl`이고 복구 뒤에는 컨트롤 플레인 static Pod를 다시 띄웁니다.
5. Helm, Kustomize, CRD는 명령 수가 적어 문서 위치와 함정 몇 개(`helm template`은 기본으로 CRD를 뺌 등)만 익히면 빨리 풉니다.

시험 구조와 영역 비중은 [CKA Ch-00](/blog/cert/cka/cka-00-exam-and-study-plan)에, 컨트롤 플레인 구성요소가 각각 무엇을 하는지는 [CKA Ch-01](/blog/cert/cka/cka-01-why-kubernetes)에 정리했습니다.

---

## 1. RBAC: 권한 묶음 둘과 바인딩 둘

커리큘럼 문구는 "Manage role based access control (RBAC)"입니다. 사용자 인증서 발급(CSR)과 ServiceAccount 토큰도 이 항목에 묶어 둡니다.

### 1-1. 객체 네 개의 관계

| 객체 | 범위 | 하는 일 |
|---|---|---|
| Role | 네임스페이스 하나 | 그 네임스페이스 안의 리소스 권한 묶음 |
| ClusterRole | 클러스터 전체 | 여러 네임스페이스에 재사용할 권한, 또는 노드 같은 클러스터 범위 리소스 권한 |
| RoleBinding | 네임스페이스 하나 | Role 또는 ClusterRole을 주체에 연결. 효력은 바인딩의 네임스페이스 안으로 한정 |
| ClusterRoleBinding | 클러스터 전체 | ClusterRole을 주체에 연결. 모든 네임스페이스에 효력 |

"Using RBAC Authorization" 문서가 짚는 성질이 셋 있습니다.

- 권한은 더하기만 있습니다("there are no "deny" rules"). 막으려면 그 권한을 주는 바인딩을 지웁니다.
- RoleBinding이 ClusterRole을 가리키면 권한은 그 RoleBinding의 네임스페이스 안에서만 통합니다.
- 바인딩의 `roleRef`는 만든 뒤 바꿀 수 없습니다.

### 1-2. 기본 ClusterRole 네 개

| ClusterRole | 문서 설명 요약 |
|---|---|
| `cluster-admin` | 모든 리소스에 모든 동작 |
| `admin` | 네임스페이스 안 읽기와 쓰기, Role과 RoleBinding 생성까지 |
| `edit` | 읽기와 쓰기. Role과 RoleBinding은 불가 |
| `view` | 읽기 전용. Secret은 볼 수 없음 |

kubeadm의 `admin.conf` 인증서는 그룹 `kubeadm:cluster-admins`(`cluster-admin`에 바인딩)이고 `super-admin.conf`는 RBAC을 건너뛰는 `system:masters` 그룹입니다.

### 1-3. 시험에서 쓰는 명령

ServiceAccount의 사용자 이름은 `system:serviceaccount:<네임스페이스>:<이름>`입니다. 복수형 `system:serviceaccounts:<네임스페이스>`는 그룹 이름이라 `--as`에 넣을 때 헷갈리기 쉽습니다.

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

YAML 뼈대는 `--dry-run=client -o yaml`로 받습니다. `--resource-name`은 특정 이름만 허용하고 서브리소스는 `pods/log`처럼 적고 사용자와 그룹은 `--user`, `--group`으로 바인딩합니다.

### 1-4. 헷갈리는 지점

- 클러스터 범위 리소스(노드, PV, 네임스페이스)의 권한은 ClusterRole로 정의합니다.
- API 그룹이 있는 리소스는 그룹까지 맞아야 합니다. `kubectl create role`에서는 `--resource=deployments.apps`처럼 점 뒤에 그룹을 붙입니다.
- `roleRef`를 바꾸는 과제라면 바인딩을 지우고 다시 만듭니다. 고치려 하면 이런 오류가 납니다.

```text
The RoleBinding "order-api-config-reader" is invalid: roleRef: Invalid value: ...: field is immutable
```

### 1-5. kubeconfig 컨텍스트와 권한 목록

```bash
kubectl config get-contexts
kubectl config use-context <컨텍스트>
kubectl config set-context --current --namespace=shop

kubectl auth whoami
kubectl auth can-i --list -n shop --as=system:serviceaccount:shop:order-api
kubectl auth can-i get pods --subresource=log -n shop
kubectl --kubeconfig /path/to/user.conf get pods -n shop
```

`--as`는 사칭(impersonation) 권한이 있어야 씁니다. 현재 시험은 과제마다 지정 호스트로 `ssh`하는 방식이라 컨텍스트 전환은 kubeconfig 이해용으로 두고 과제 상자의 명령을 먼저 실행합니다.

### 1-6. RBAC 앞 단계: 인증 방식과 인가 모드

요청은 인증, 인가, 어드미션 순서로 통과하고 RBAC은 인가 단계의 한 모듈입니다. 쿠버네티스에는 User 객체가 없습니다. 클라이언트 인증서라면 Subject의 CN이 사용자 이름, O가 그룹이고 ServiceAccount 토큰이라면 1-3절의 이름 형식입니다.

인가 모드는 kube-apiserver의 `--authorization-mode`에 적힌 순서로 묻고 kubeadm 기본값은 `Node,RBAC`입니다. 모든 모듈이 의견이 없으면 403이고 앞에 `AlwaysAllow`가 있으면 RBAC은 의미가 없어집니다.

```bash
sudo grep authorization-mode /etc/kubernetes/manifests/kube-apiserver.yaml
```

### 1-7. API 그룹과 리소스 이름 찾기

Role의 `apiGroups`에는 리소스가 속한 그룹을 적습니다. pods, services, configmaps, secrets, nodes는 core라 `[""]`, Deployment 계열은 `["apps"]`, jobs와 cronjobs는 `["batch"]`입니다. 헷갈리면 클러스터에 묻습니다.

```bash
kubectl api-resources --namespaced=false        # 클러스터 범위 리소스 (ClusterRole 필요)
kubectl api-resources --api-group=apps -o wide  # 그룹별, 지원 동사(VERBS) 포함
kubectl explain deployment | head -5            # GROUP, KIND, VERSION
```

### 1-8. ServiceAccount 토큰

1.24부터 ServiceAccount를 만들어도 Secret 기반 장기 토큰이 자동으로 생기지 않습니다. Pod에는 TokenRequest API로 받은 짧은 수명의 토큰이 projected 볼륨(`kube-api-access-*`)으로 들어가고 위치는 `/var/run/secrets/kubernetes.io/serviceaccount/`의 `token`, `ca.crt`, `namespace`입니다. 토큰이 필요 없는 Pod는 `automountServiceAccountToken: false`로 끕니다.

```bash
kubectl create token order-api -n shop                  # 수명은 서버가 정함
kubectl create token order-api -n shop --duration=30m
kubectl set serviceaccount deployment order-web order-api -n shop   # Pod 템플릿이 바뀌어 롤아웃
```

최소 수명은 10분입니다. `--duration=5m`은 이렇게 거절됩니다.

```text
spec.expirationSeconds: Invalid value: 300: may not specify a duration less than 10 minutes
```

`kubectl describe sa`에 `Tokens:` 줄이 없는 것도 정상입니다. 만료 없는 토큰이 꼭 필요하면 Secret을 직접 만들고 컨트롤 플레인이 `data.token`을 채웁니다.

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: order-api-token
  namespace: shop
  annotations:
    kubernetes.io/service-account.name: order-api
type: kubernetes.io/service-account-token
```

audience나 수명을 바꾸려면 Pod 스펙의 projected 볼륨에 `serviceAccountToken`을 적습니다. audience를 바꾼 토큰은 API 서버가 `Unauthorized`로 거부합니다.

### 1-8b. 인증서 위치와 용도

인증서는 공개 키와 Subject에 CA가 용도와 기간을 붙여 서명한 문서이고 개인 키(`.key`)는 만든 자리를 떠나지 않습니다. 구성요소끼리는 양쪽이 인증서를 내미는 mTLS로 통신합니다. kubeadm은 CA 세 개(`ca`, `etcd/ca`, `front-proxy-ca`)를 만들고 파일은 `/etc/kubernetes/pki`에 둡니다.

| 연결 | 서버 쪽 | 클라이언트 쪽 | CA |
|---|---|---|---|
| kubectl -> apiserver | `apiserver.crt` | `admin.conf` 안의 인증서 | `ca` |
| kubelet -> apiserver | `apiserver.crt` | `/var/lib/kubelet/pki/`의 회전 인증서 | `ca` |
| apiserver -> kubelet | kubelet 서빙 인증서 | `apiserver-kubelet-client.crt` | `ca` |
| apiserver -> etcd | `etcd/server.crt` | `apiserver-etcd-client.crt` | `etcd/ca` |
| etcdctl(백업) -> etcd | `etcd/server.crt` | `etcd/server.crt` 또는 `etcd/healthcheck-client.crt` | `etcd/ca` |

`ca.key`를 꺼내지 않고 서명받는 길이 1-9절의 CSR API이고 인증서를 읽는 `openssl` 명령은 4-8절에 있습니다.

### 1-9. 사용자 인증서 발급: CSR 승인 흐름

공식 태스크 문서의 절차를 쇼핑몰 정산 담당자 `settle-user`로 옮겼습니다.

```bash
# 1) 키와 CSR 파일 (CN이 사용자 이름, O가 그룹)
openssl genrsa -out settle-user.key 3072
openssl req -new -key settle-user.key -out settle-user.csr -subj "/CN=settle-user/O=finance"

# 2) CSR 객체에 넣을 base64 한 줄
cat settle-user.csr | base64 | tr -d "\n"
```

```yaml
apiVersion: certificates.k8s.io/v1
kind: CertificateSigningRequest
metadata:
  name: settle-user
spec:
  request: <위 base64 한 줄>
  signerName: kubernetes.io/kube-apiserver-client
  expirationSeconds: 86400   # 하루
  usages:
    - client auth
```

```bash
# 3) 제출, 승인, 인증서 꺼내기
kubectl apply -f settle-user-csr.yaml
kubectl get csr                                   # CONDITION: Pending
kubectl certificate approve settle-user           # 거절은 kubectl certificate deny
kubectl get csr settle-user -o jsonpath='{.status.certificate}' | base64 -d > settle-user.crt

# 4) kubeconfig에 등록
kubectl config get-clusters                       # --cluster에 넣을 실제 이름 확인
kubectl config set-credentials settle-user \
  --client-key=settle-user.key --client-certificate=settle-user.crt --embed-certs=true
kubectl config set-context settle-user --cluster=kubernetes --user=settle-user
```

승인 뒤 CONDITION은 `Approved,Issued`가 됩니다. 틀리기 쉬운 곳은 이렇습니다.

- `signerName`은 필수이고 사람용 `kubernetes.io/kube-apiserver-client`는 `usages`에 `client auth`가 있어야 합니다.
- `expirationSeconds` 최솟값은 600입니다. 서명은 kube-controller-manager가 `pki/ca.crt`, `ca.key`로 합니다.
- 승인되거나 거절된 CSR 객체는 1시간 뒤 지워지니 인증서는 바로 꺼내 둡니다.
- `--cluster`에 없는 이름을 넣어도 `set-context`는 성공하고 나중에 접속할 때 엉뚱한 오류가 납니다.

인증서만으로는 권한이 없으니 `--user=settle-user`나 `--group=finance`로 바인딩하고 `kubectl auth can-i ... --as=settle-user`로 확인합니다.

### 1-10. kubeconfig 파일 구조

```yaml
apiVersion: v1
kind: Config
clusters:
  - name: kubernetes
    cluster:
      server: https://cluster-endpoint:6443
      certificate-authority-data: <CA 인증서 base64>
users:
  - name: settle-user
    user:
      client-certificate-data: <인증서 base64>
      client-key-data: <개인 키 base64>
contexts:                 # cluster + user (+ namespace) 조합
  - name: settle-user@kubernetes
    context:
      cluster: kubernetes
      user: settle-user
      namespace: payment
current-context: settle-user@kubernetes
```

`*-data` 필드는 내용을 base64로 넣은 것이고 `-data`가 없으면 파일 경로입니다. 파일을 고르는 순서는 `--kubeconfig`, `KUBECONFIG` 환경 변수, `$HOME/.kube/config`입니다.

### 1-11. 직접 해 보기

네임스페이스 `board`에 ServiceAccount `board-reader`를 만들고 ClusterRole `view`를 RoleBinding으로 연결합니다. `board`의 Pod 목록은 `yes`, `default`는 `no`, `board`의 Secret은 `no`인지 봅니다. 사용자 `board-editor`의 CSR을 승인해 컨텍스트를 만들고 바인딩 전후로 403이 사라지는지 확인합니다. 토큰으로 접속해 볼 때는 `KUBECONFIG=/dev/null kubectl --token=... --server=... --certificate-authority=...`처럼 kubeconfig를 비웁니다. 인증서가 든 kubeconfig가 남아 있으면 인증서 인증이 먼저 성공해 관리자로 붙습니다.

## 2. 설치 전 노드 준비

커리큘럼 문구는 "Prepare underlying infrastructure for installing a Kubernetes cluster"입니다. "Installing kubeadm"과 "Container Runtimes" 문서의 사전 조건이 체크리스트입니다.

### 2-1. 기계 조건

머신당 메모리 2GB 이상, 컨트롤 플레인은 CPU 2개 이상, 머신 사이 전체 연결과 필요한 포트 개방(`nc 127.0.0.1 6443 -zv -w 2`)이 조건입니다. 호스트 이름, MAC 주소, `product_uuid`(`/sys/class/dmi/id/product_uuid`)는 노드마다 달라야 합니다.

### 2-2. 스왑

kubelet은 기본 설정에서 스왑이 켜져 있으면 시작하지 않습니다. `sudo swapoff -a`로 끄고 `/etc/fstab`의 스왑 줄도 지웁니다. 허용하려면 kubelet 설정에 `failSwapOn: false`를 넣습니다.

### 2-3. IP 포워딩과 커널 설정

```bash
cat <<EOF | sudo tee /etc/sysctl.d/k8s.conf
net.ipv4.ip_forward = 1
EOF
sudo sysctl --system
sysctl net.ipv4.ip_forward   # 1이면 적용됨
```

현재 Container Runtimes 문서가 공통 사전 준비로 요구하는 것은 `net.ipv4.ip_forward` 하나이고 다른 sysctl이나 커널 모듈은 쓰는 네트워크 구현의 문서를 보라고 적습니다. 예전 문서에 있던 `overlay`, `br_netfilter` 모듈 단계는 지금 공통 절차에 없습니다. 과제나 CNI 문서가 모듈이나 다른 sysctl을 더 요구하면 `/etc/modules-load.d/`, `/etc/sysctl.d/`에 파일로 적고 `modprobe`, `sysctl --system`으로 적용해 재부팅 뒤에도 유지되게 합니다.

### 2-4. 컨테이너 런타임과 cgroup 드라이버

kubelet과 런타임은 같은 cgroup 드라이버를 써야 하고 systemd가 init인 시스템(대부분의 배포판)에서는 `systemd` 드라이버를 씁니다. containerd는 `config.toml`의 runc 옵션에 `SystemdCgroup = true`를, kubelet은 `KubeletConfiguration`에 `cgroupDriver: systemd`를 넣습니다.

버전에 따라 알아 둘 사실은 셋입니다.

- 1.34부터 kubelet은 드라이버를 런타임에 묻고 자기 설정의 `cgroupDriver`를 무시합니다(`KubeletCgroupDriverFromCRI`). containerd 2.x 노드라면 containerd의 `SystemdCgroup` 값부터 봅니다.
- 1.35부터 kubelet은 cgroup v1 노드에서 기본으로 시작하지 않습니다(`failCgroupV1: true`).
- 1.35가 containerd 1.x를 지원하는 마지막 버전입니다. containerd 호환표 기준 1.37 노드는 containerd 2.3 이상이고 containerd 1.7은 2026-09-30에 지원이 끝났습니다.

cgroup 내부 동작은 [쿠버네티스 아래의 리눅스 3편](/blog/theory/systems/k8s-linux-03-cgroup-qos)에 있습니다.

### 2-4b. 런타임 패키지 설치: containerd와 cri-dockerd

순서는 패키지 설치, 설정 확인, `enable --now`, 소켓 확인, kubeadm에 소켓 경로 지정입니다.

```bash
sudo dpkg -i ./containerd.io_<버전>_amd64.deb      # 또는 sudo apt-get install ./<파일>.deb
sudo mkdir -p /etc/containerd
containerd config default | sudo tee /etc/containerd/config.toml > /dev/null
sudo sed -i 's/SystemdCgroup = false/SystemdCgroup = true/' /etc/containerd/config.toml
sudo systemctl daemon-reload
sudo systemctl enable --now containerd
sudo systemctl restart containerd
ls -l /run/containerd/containerd.sock
```

`containerd config default`가 설치된 버전에 맞는 형식으로 파일을 만드니 그 파일의 `SystemdCgroup` 줄만 바꿉니다. 기본값은 모두 `false`입니다.

| containerd | 첫 줄 `version` | `SystemdCgroup`이 있는 섹션 |
|---|---|---|
| 1.7 | 2 | `[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options]` |
| 2.0 | 3 | `[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.runc.options]` |
| 2.3, 2.4 | 4 | 2.0과 같음 |

패키지가 넣은 설정 파일은 `disabled_plugins`에 `cri`가 들어 있을 수 있어 기본 설정으로 다시 만듭니다. cri-dockerd는 Docker Engine을 CRI로 감싸는 어댑터이고 Docker Engine이 먼저 돌고 있어야 합니다.

```bash
sudo dpkg -i ./cri-dockerd_<버전>.<배포판>_amd64.deb
sudo systemctl daemon-reload
sudo systemctl enable --now cri-docker.socket cri-docker.service
systemctl is-enabled cri-docker.socket            # enabled여야 재부팅 뒤에도 뜸
ls -l /run/cri-dockerd.sock
```

`start`만 하면 재부팅 뒤 서비스가 올라오지 않습니다. Docker를 설치하면 containerd도 함께 깔리고 `--cri-socket` 없이 `kubeadm init`, `join`, `reset`을 실행하면 이 오류로 멈춥니다.

```text
found multiple CRI endpoints on the host. Please define which one do you wish to use by setting the 'criSocket' field in the kubeadm configuration file: unix:///var/run/containerd/containerd.sock, unix:///var/run/cri-dockerd.sock
```

| 런타임 | `--cri-socket` 값 |
|---|---|
| containerd | `unix:///var/run/containerd/containerd.sock` |
| CRI-O | `unix:///var/run/crio/crio.sock` |
| Docker Engine(cri-dockerd) | `unix:///var/run/cri-dockerd.sock` |

값은 `kubeadm init`, `join`, `reset`의 `--cri-socket`과 `crictl --runtime-endpoint`에 똑같이 넣습니다. `/var/run`은 대부분 `/run`을 가리키는 링크라 두 경로는 같은 파일입니다.

### 2-5. kubeadm, kubelet, kubectl 패키지

저장소는 `pkgs.k8s.io`이고 마이너 버전마다 경로가 다릅니다(`.../core:/stable:/v1.37/deb/`). 예전 `apt.kubernetes.io`는 동결되었습니다. 설치 뒤 `apt-mark hold`로 버전을 고정합니다.

```bash
sudo apt-mark hold kubelet kubeadm kubectl
sudo systemctl enable --now kubelet
```

이 시점의 kubelet은 kubeadm이 설정을 줄 때까지 10초마다 재시작하고 이것이 정상입니다. kubeadm 1.36, 1.37 패키지는 `cri-tools`에 의존하지 않아 `crictl`이 없을 수 있습니다. 같은 저장소의 `cri-tools`를 깔고 `/etc/crictl.yaml`에 `runtime-endpoint: unix:///run/containerd/containerd.sock`를 적습니다.

### 2-6. 직접 해 보기

VM 두 대에서 `swapon --show`, `sysctl net.ipv4.ip_forward`, `stat -fc %T /sys/fs/cgroup`(`cgroup2fs`면 v2), `product_uuid`를 확인합니다. 한 대에는 containerd를, 다른 한 대에는 Docker Engine과 cri-dockerd를 넣고 `--cri-socket` 없이 `kubeadm init --dry-run`을 실행해 위 오류를 봅니다. 재부팅 뒤 런타임이 스스로 올라오는지도 확인합니다.

## 3. kubeadm으로 클러스터 생성과 관리

커리큘럼 문구는 "Create and manage Kubernetes clusters using kubeadm"입니다.

### 3-1. kubeadm init

```bash
sudo kubeadm init \
  --control-plane-endpoint=cluster-endpoint:6443 \
  --pod-network-cidr=10.244.0.0/16
```

`--control-plane-endpoint`는 나중에 HA로 늘릴 계획이면 처음부터 지정합니다(없이 만든 클러스터는 HA로 못 바꿈). `--pod-network-cidr`는 CNI가 요구할 때 호스트 네트워크와 다른 대역으로 줍니다. `--apiserver-advertise-address`는 광고 주소를 바꿀 때, `--cri-socket`은 런타임이 여럿일 때 씁니다. `--config` 설정 파일로 init하면 파일의 `apiVersion`은 `kubeadm.k8s.io/v1beta4`입니다. `v1beta3`은 1.37에서 제거됐고 옛 파일은 1.35 kubeadm의 `kubeadm config migrate`로 바꿉니다(CHANGELOG-1.37).

`init`이 끝나면 `admin.conf`를 `$HOME/.kube/config`로 복사하는 명령과 `kubeadm join` 명령이 출력됩니다.

### 3-2. CoreDNS는 CNI 설치 뒤에 시작

`init` 직후 노드가 `NotReady`이고 CoreDNS가 `Pending`인 것은 CNI를 기다리는 정상 상태입니다. 노드 조건 메시지는 이런 모양입니다.

```text
container runtime network not ready: NetworkReady=false reason:NetworkPluginNotReady message:Network plugin returns error: cni plugin not initialized
```

### 3-3. 노드 조인과 토큰

```bash
# 워커 노드에서
sudo kubeadm join <컨트롤플레인 주소>:6443 --token <토큰> \
  --discovery-token-ca-cert-hash sha256:<해시>

# 토큰이 만료됐거나 출력을 잃어버렸을 때 컨트롤 플레인에서
kubeadm token list
kubeadm token create --print-join-command
```

토큰 기본 TTL은 24시간입니다. 하루 지난 init 출력의 join 명령이 실패하는 이유입니다.

### 3-4. 컨트롤 플레인 테인트와 노드 제거

kubeadm은 컨트롤 플레인 노드에 `node-role.kubernetes.io/control-plane:NoSchedule` 테인트를 붙입니다. 노드 한 대로 연습할 때는 지웁니다.

```bash
kubectl taint nodes --all node-role.kubernetes.io/control-plane-

# 노드 빼기
kubectl drain <노드> --delete-emptydir-data --force --ignore-daemonsets
sudo kubeadm reset          # 해당 노드에서
kubectl delete node <노드>
```

`kubeadm reset`은 iptables 규칙, IPVS 테이블, `$HOME/.kube/config`를 지우지 않으니 같은 노드를 다시 쓰려면 직접 지웁니다.

### 3-4b. 만든 뒤 설정 바꾸기: kubeadm-config와 kubelet-config

kubeadm은 이미 배포된 구성요소를 자동으로 재설정하지 않습니다("Reconfiguring a kubeadm cluster"). 클러스터 쪽 원본과 노드 쪽 파일을 각각 고칩니다.

| 대상 | 클러스터 쪽 원본 | 노드 쪽 반영 |
|---|---|---|
| `ClusterConfiguration` | `kube-system` ConfigMap `kubeadm-config` | 컨트롤 플레인의 `/etc/kubernetes/manifests/*.yaml` 수정 |
| `KubeletConfiguration` | ConfigMap `kubelet-config` | 노드마다 `kubeadm upgrade node phase kubelet-config` 후 `systemctl restart kubelet` |
| `KubeProxyConfiguration` | ConfigMap `kube-proxy` | kube-proxy Pod 재생성 |

```bash
kubectl -n kube-system edit cm kubelet-config
sudo kubeadm upgrade node phase kubelet-config     # 노드에서
sudo systemctl restart kubelet
```

ConfigMap 안의 설정은 YAML 문자열이라 저장할 때 검증이 없습니다. `kubeadm upgrade`는 `kubeadm-config`로 static Pod 매니페스트를, `kubelet-config`로 `/var/lib/kubelet/config.yaml`을 다시 만듭니다. 매니페스트에만 넣은 `--event-ttl=2h`가 `upgrade apply` 뒤 사라지는 것을 확인했습니다. 그래서 "API 서버에 플래그를 더하라"는 과제는 매니페스트를 고쳐 바로 반영하고 유지가 필요하면 `kubeadm-config`의 `extraArgs`(v1beta4는 `- name: ...` / `value: ...` 목록)에도 넣습니다.

### 3-5. 직접 해 보기

컨트롤 플레인 1대와 워커 1대로 클러스터를 만들고 join 명령을 `kubeadm token create --print-join-command`로 다시 만들어 붙입니다. `kubelet-config`에 `maxPods: 50`을 넣고 워커에서 `kubeadm upgrade node phase kubelet-config`와 kubelet 재시작을 한 뒤 `kubectl get node <워커> -o jsonpath='{.status.capacity.pods}'`가 50인지 봅니다. 워커 파일만 70으로 바꾼 값은 `kubeadm upgrade node` 뒤 50으로 돌아갑니다.

## 4. 클러스터 수명주기: 업그레이드, 인증서, etcd

커리큘럼 문구는 "Manage the lifecycle of Kubernetes clusters"이고 개정 전의 업그레이드, etcd 백업 문구는 빠졌습니다. 후기도 엇갈립니다. Domenic Cassisi(2026)는 etcd 과제가 빠졌다고 적었고 Talha Juikar(2026)는 etcd 명령과 kubeadm 플래그에서 시간을 썼다고 적었습니다. 절차와 함정만 짧게 외워 둡니다.

### 4-1. 버전 차이 규칙

버전은 x.y.z(메이저.마이너.패치)이고 건너뛰면 안 되는 단위가 마이너입니다. "Version Skew Policy"에서 시험에 걸리는 규칙입니다.

- 마이너를 건너뛰는 업그레이드는 지원하지 않습니다. 1.35에서 1.37로 가려면 1.36을 거칩니다.
- kubelet은 kube-apiserver보다 새로우면 안 되고 세 마이너까지 오래될 수 있습니다. 그래서 컨트롤 플레인이 먼저입니다.

| 구성요소 | kube-apiserver 1.37일 때 허용 |
|---|---|
| 다른 kube-apiserver(HA) | 1.37, 1.36 |
| kube-controller-manager, kube-scheduler | 1.37, 1.36 |
| kubelet, kube-proxy | 1.37 ~ 1.34 |
| kubectl | 1.38, 1.37, 1.36 |

HA에서 apiserver가 1.37과 1.36으로 섞이면 기준은 1.36이라 노드는 모든 컨트롤 플레인이 끝난 뒤 올립니다.

### 4-2. 업그레이드 순서

"Upgrading kubeadm clusters" 문서의 1.36에서 1.37 절차입니다. 먼저 패키지 저장소 경로를 목표 마이너로 바꿔야 새 버전이 보입니다.

```bash
# 0) 저장소를 v1.37로
sudo sed -i 's/v1.36/v1.37/' /etc/apt/sources.list.d/kubernetes.list
sudo apt-get update
apt-cache madison kubeadm                        # 1.37.x-1.1이 보이는지

# 1) 첫 컨트롤 플레인: kubeadm만 먼저
sudo apt-mark unhold kubeadm && \
sudo apt-get install -y kubeadm='1.37.x-*' && \
sudo apt-mark hold kubeadm

# 2) 계획 확인, 적용
sudo kubeadm upgrade plan
sudo kubeadm upgrade apply v1.37.x
```

1.37 kubeadm의 성공 출력은 문서의 옛 문구(`... Enjoy!`)와 다릅니다.

```text
[upgrade] SUCCESS! A control plane node of your cluster was upgraded to "v1.37.1".
[upgrade] Now please proceed with upgrading the rest of the nodes by following the right order.
```

나머지 컨트롤 플레인과 워커는 kubeadm을 올린 뒤 `upgrade apply` 대신 `sudo kubeadm upgrade node`를 실행합니다(plan과 CNI 업그레이드는 첫 노드에서만). 그 다음 노드마다 kubelet을 교체합니다.

```bash
kubectl drain <노드> --ignore-daemonsets          # kubectl이 되는 곳에서

sudo apt-mark unhold kubelet kubectl && \
sudo apt-get update && sudo apt-get install -y kubelet='1.37.x-*' kubectl='1.37.x-*' && \
sudo apt-mark hold kubelet kubectl
sudo systemctl daemon-reload
sudo systemctl restart kubelet

kubectl uncordon <노드>
```

apt와 kubeadm 명령은 해당 노드에서, drain과 uncordon은 kubectl이 되는 호스트에서 실행합니다. 단독 Pod가 있으면 drain이 `cannot delete Pods that declare no controller (use --force to override)`로 멈춥니다(4-7절).

### 4-3. 업그레이드 실패 시 재실행과 백업 디렉터리

`kubeadm upgrade`는 멱등이라 끊겨도 다시 실행하면 됩니다. kubeadm은 `/etc/kubernetes/tmp` 아래에 `kubeadm-backup-etcd-<시각>`(로컬 etcd 데이터, `/var/lib/etcd`로 복원), `kubeadm-backup-manifests-<시각>`(static Pod 매니페스트, `/etc/kubernetes/manifests`로 복원), `kubeadm-kubelet-config-<시각>`(이전 kubelet 설정)을 남깁니다.

### 4-4. 인증서 만료와 갱신

kubeadm이 만든 인증서는 1년, CA는 10년이 기본입니다. `kubeadm upgrade`는 그 노드의 인증서를 자동으로 갱신하므로 1년 안에 한 번씩 올리면 만료를 피합니다.

```bash
sudo kubeadm certs check-expiration
sudo kubeadm certs renew all
sudo openssl x509 -noout -enddate -in /etc/kubernetes/pki/apiserver.crt
```

- `check-expiration` 목록에 `kubelet.conf`는 없습니다. kubelet 인증서는 `/var/lib/kubelet/pki/`에서 자동 회전되고 `renew all`도 건드리지 않습니다. `renew`는 모든 컨트롤 플레인 노드에서 실행합니다.
- `renew all`은 마지막에 `You must restart the kube-apiserver, kube-controller-manager, kube-scheduler and etcd, so that they can use the new certificates.`를 찍습니다. static Pod는 kubectl로 재시작할 수 없으니 매니페스트를 `/etc/kubernetes/manifests/` 밖으로 옮기고 20초쯤(kubelet `fileCheckFrequency`) 기다렸다가 되돌립니다.
- 갱신되는 파일은 `/etc/kubernetes/admin.conf`이니 `~/.kube/config` 사본은 다시 복사합니다.

만료되면 kubectl은 `x509: certificate has expired or is not yet valid`로 실패하고 만료된 상태에서도 `renew all`은 동작합니다. kubelet 인증서 복구는 [Ch-06](/blog/cert/cka/cka-06-troubleshooting)에 있습니다.

### 4-5. etcd 백업

kubeadm 클러스터의 etcd는 컨트롤 플레인의 static Pod이고 데이터 디렉터리는 `/var/lib/etcd`입니다. 스냅샷은 동작 중인 멤버에 접속해 `etcdctl snapshot save`로 뜹니다. 인증서 경로는 매니페스트에서 먼저 확인합니다.

```bash
sudo grep -E 'cert|key|trusted|data-dir|listen-client' /etc/kubernetes/manifests/etcd.yaml

etcdctl --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  snapshot save /opt/backup/etcd-snapshot.db

etcdutl --write-out=table snapshot status /opt/backup/etcd-snapshot.db
```

- `ETCDCTL_API=3`은 필요 없습니다(3.4부터 v3 기본). 붙이면 `unrecognized environment variable` 경고 한 줄 뒤 저장됩니다.
- etcd 3.6에서 `etcdctl snapshot status`와 `restore`가 제거됐고 kubeadm 1.37의 기본 etcd는 3.7.0입니다. 3.7 `etcdctl snapshot`에는 `save`만 있고 `etcdctl snapshot restore --data-dir ...`는 `Error: unknown flag: --data-dir`로 실패합니다.
- `etcdctl`, `etcdutl`은 시험 공식 사전 설치 목록(kubectl, yq, curl, wget, man)에 없습니다. Resources Allowed 문서가 과제에 필요한 패키지 설치는 요구하지 않는다고 적으므로 etcd 과제가 나오는 호스트라면 `etcdctl`은 있을 가능성이 높지만 `etcdutl`은 근거가 없습니다. 과제 호스트에서 `which etcdctl etcdutl`로 먼저 봅니다.

### 4-6. etcd 복구

복구는 스냅샷을 새 데이터 디렉터리에 풀고 etcd가 그 디렉터리를 보게 하는 일입니다.

```bash
sudo etcdutl --data-dir /var/lib/etcd-restore snapshot restore /opt/backup/etcd-snapshot.db
sudo vi /etc/kubernetes/manifests/etcd.yaml   # volumes의 name: etcd-data hostPath.path를 /var/lib/etcd-restore로
```

매니페스트를 고치면 kubelet이 etcd Pod를 다시 만듭니다. 1분 넘게 kubectl이 연결 오류를 낼 수 있으니 매니페스트를 또 고치지 말고 `sudo crictl ps | grep etcd`로 기다립니다. 실측으로 확인한 함정은 셋입니다.

1. etcd가 복구된 데이터로 떠도 kube-apiserver를 다시 띄우기 전까지 지운 객체가 보이지 않았습니다. kube-apiserver, kube-controller-manager, kube-scheduler 매니페스트를 밖으로 옮겼다 되돌립니다. 문서도 API 서버를 멈추고 복구한 뒤 세 구성요소와 kubelet 재시작을 권합니다.
2. 워커 kubelet이 `no relationship found between node ... and this object`로 새 Pod를 `Pending`에 두었고 `systemctl restart kubelet`으로 풀렸습니다. Service 접속은 kube-proxy Pod를 다시 띄운 뒤에 됐습니다.
3. 이후 `kubeadm upgrade apply`는 `kubeadm-config`의 `etcd.local.dataDir`(`/var/lib/etcd`)로 매니페스트를 다시 만들어 복구를 되돌립니다. `dataDir`도 새 경로로 고칩니다.

스냅샷은 같은 major.minor etcd에서 뜬 것으로만 복구할 수 있습니다.

### 4-7. 노드 유지보수: cordon, drain, uncordon

| 명령 | 하는 일 | 이미 떠 있는 Pod |
|---|---|---|
| `cordon` | 스케줄 불가 표시 | 그대로 실행 |
| `drain` | cordon 뒤 Eviction API로 내보냄 | 축출됨 |
| `uncordon` | 다시 스케줄 가능 | 축출된 Pod는 돌아오지 않음 |

drain이 멈추는 경우와 옵션입니다.

- DaemonSet Pod가 있으면 `--ignore-daemonsets`가 필요합니다. DaemonSet Pod는 어느 쪽이든 지우지 않습니다.
- 컨트롤러 없는 단독 Pod가 있으면 `--force`가 필요하고 그 Pod는 다른 노드에 다시 생기지 않습니다.
- emptyDir를 쓰는 Pod는 `--delete-emptydir-data`가 필요하고 데이터는 함께 없어집니다.
- PDB가 허용하는 중단 수가 0이면 `Cannot evict pod as it would violate the pod's disruption budget`을 찍으며 재시도합니다. `--disable-eviction`은 PDB를 건너뛰는 일반 삭제입니다.

drain 없이 노드가 죽으면 `--node-monitor-grace-period`(기본 50s) 뒤 노드가 `Unknown`이 되고 `node.kubernetes.io/unreachable:NoExecute` 테인트가 붙습니다. Pod에 기본으로 들어간 `tolerationSeconds: 300`이 지나면 축출됩니다. 옛 자료의 `--pod-eviction-timeout`은 1.37 플래그 목록에 없습니다.

### 4-8. 인증서 내용 읽기: openssl x509

```bash
sudo openssl x509 -in /etc/kubernetes/pki/apiserver.crt -text -noout
```

```text
        Issuer: CN=kubernetes                           <- 서명한 CA
            Not After : Oct 20 06:23:05 2027 GMT        <- 만료일
        Subject: CN=kube-apiserver                      <- 이 인증서의 주인
            X509v3 Subject Alternative Name:
                DNS:<노드 이름>, DNS:kubernetes, DNS:kubernetes.default, DNS:kubernetes.default.svc,
                DNS:kubernetes.default.svc.cluster.local, IP Address:10.96.0.1, IP Address:<노드 IP>
```

클라이언트 인증서라면 Subject의 CN과 O가 RBAC 바인딩의 사용자, 그룹과 맞는지 봅니다. 서버 인증서라면 접속하는 이름과 IP가 SAN에 있어야 하고 없으면 TLS 검증이 실패합니다.

kubeconfig와 CSR 객체 안의 내용은 꺼내서 디코딩합니다.

```bash
sudo grep client-certificate-data /etc/kubernetes/admin.conf | awk '{print $2}' | base64 -d \
  | openssl x509 -noout -subject -issuer -enddate
kubectl get csr <이름> -o jsonpath='{.spec.request}' | base64 -d | openssl req -noout -subject
```

kubectl이 안 되면 노드에서 `crictl ps -a`, `crictl logs <ID>`로 봅니다([Ch-06](/blog/cert/cka/cka-06-troubleshooting)).

### 4-9. 직접 해 보기

`payment`에 Deployment를 만들고 스냅샷을 뜬 뒤 Deployment를 지웁니다. `/var/lib/etcd-restore`로 복구하고 static Pod를 다시 띄워 Deployment가 돌아오는지 봅니다. `minAvailable: 2` PDB와 레플리카 2개로 drain이 기다리는 모습도 확인합니다.

## 5. 고가용성 컨트롤 플레인

커리큘럼 문구는 "Implement and configure a highly-available control plane"입니다.

### 5-1. 두 가지 토폴로지

| 항목 | stacked etcd | external etcd |
|---|---|---|
| etcd 위치 | 컨트롤 플레인 노드마다 로컬 멤버 | 별도 호스트 |
| 장점 | 구성이 단순, kubeadm 기본값 | 컨트롤 플레인과 etcd 장애가 서로 덜 번짐 |
| 대가 | 노드 하나가 죽으면 etcd 멤버와 컨트롤 플레인을 함께 잃음 | 호스트가 두 배 |
| 최소 규모 | 컨트롤 플레인 3대 | 컨트롤 플레인 3대, etcd 3대 |

두 구조 모두 kube-apiserver는 로드 밸런서 뒤에 있고 최소 3대인 이유는 etcd 쿼럼(floor(n/2)+1)입니다.

| 멤버 수 | 쿼럼 | 견디는 장애 수 |
|---|---|---|
| 1 | 1 | 0 |
| 2 | 2 | 0 |
| 3 | 2 | 1 |
| 4 | 3 | 1 |
| 5 | 3 | 2 |

짝수를 더해도 견디는 장애 수는 늘지 않으니 멤버 수는 홀수로 둡니다. kube-controller-manager와 kube-scheduler는 여러 대가 떠 있어도 리더 한 대만 일하고 리더는 `kubectl get lease -n kube-system`의 HOLDER 열에 보입니다.

### 5-2. 만드는 순서

"Creating Highly Available Clusters with kubeadm" 기준입니다.

kube-apiserver용 로드 밸런서(기본 포트 6443)를 먼저 두고 첫 컨트롤 플레인에서 그 주소로 init합니다. 나머지 컨트롤 플레인은 워커용 join 명령에 `--control-plane --certificate-key <키>`를 더해 붙습니다.

```bash
sudo kubeadm init --control-plane-endpoint "LOAD_BALANCER_DNS:LOAD_BALANCER_PORT" --upload-certs

# 나머지 컨트롤 플레인에서
sudo kubeadm join LOAD_BALANCER_DNS:6443 --token <토큰> \
  --discovery-token-ca-cert-hash sha256:<해시> \
  --control-plane --certificate-key <키>
```

Lima VM 3대(kubeadm 1.37.1)에서 엔드포인트를 첫 노드 IP의 `/etc/hosts` 이름 `k8s-api`로 두고 돌린 init 출력입니다(LB가 없어 첫 노드가 죽으면 API 주소도 사라짐).

```text
[upload-certs] Storing the certificates in Secret "kubeadm-certs" in the "kube-system" Namespace
...
  kubeadm join k8s-api:6443 --token <토큰> \
	--discovery-token-ca-cert-hash sha256:<해시> \
	--control-plane --certificate-key <64자 hex 키>

As a safeguard, uploaded-certs will be deleted in two hours; If necessary, you can use
"kubeadm init phase upload-certs --upload-certs" to reload certs afterward.
```

두 번째 노드에서 이 명령에 `--apiserver-advertise-address=<자기 IP>`를 더하면 `[download-certs]`로 CA를 받고 `[etcd] Announced new etcd member joining to the existing etcd cluster`를 거쳐 join이 끝납니다. 멤버는 etcd Pod 안의 etcdctl로 봅니다.

```bash
kubectl -n kube-system exec etcd-lima-ha1 -- etcdctl --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key member list -w table
# lima-ha1, lima-ha2, lima-ha3 세 줄 모두 STATUS started, IS LEARNER false
```

`--upload-certs`는 CA 세 쌍과 sa 키(Secret 키 `ca.crt`, `etcd-ca.key`, `front-proxy-ca.crt`, `sa.pub` 등 8개)를 암호화해 `kube-system`의 `kubeadm-certs` Secret에 올립니다. Secret의 owner가 `kubeadm token list`에 `Proxy for managing TTL for the kubeadm-certs secret`로 보이는 TTL 토큰이라 2시간 뒤 함께 지워집니다. 이 토큰을 지워 만료를 재현하자 옛 키의 join이 이렇게 실패했습니다.

```text
error: error execution phase control-plane-prepare/download-certs: error downloading certs: error downloading the secret: Secret "kubeadm-certs" was not found in the "kube-system" Namespace. This Secret might have expired. Please, run `kubeadm init phase upload-certs --upload-certs` on a control plane to generate a new one
```

새 키로 만든 명령으로 세 번째 노드가 붙었습니다.

```bash
sudo kubeadm init phase upload-certs --upload-certs            # 새 certificate key 출력
kubeadm token create --print-join-command --certificate-key <새 키>
```

### 5-3. 헷갈리는 지점

- `--control-plane-endpoint` 없이 만든 클러스터는 나중에 HA로 바꿀 수 없습니다.
- 컨트롤 플레인 4대는 3대와 같은 1대까지만 버팁니다.
- stacked 3대에서 1대를 멈추면 그대로 동작하고 리더 Lease가 옮겨 갑니다. 2대를 멈추면 조회도 멈추고 남은 API 서버의 `/readyz`에 `[-]etcd failed`가 나옵니다.

### 5-4. 직접 해 보기

kind로 컨트롤 플레인 3대 클러스터를 만들고 노드 컨테이너를 하나씩 `docker stop`하며 `kubectl get lease -n kube-system`의 HOLDER와 위 동작을 확인합니다. kind는 CA 파일을 복사해 join하므로 `--certificate-key` 흐름은 리눅스 VM 2~3대에서 5-2절 순서로 해 봅니다. 2대면 etcd 멤버 2개라 1대만 죽어도 쿼럼을 잃습니다.

## 6. Helm과 Kustomize로 구성요소 설치

커리큘럼 문구는 "Use Helm and Kustomize to install cluster components"입니다. 시험 중에 helm.sh/docs를 열 수 있습니다. `helm`은 공식 사전 설치 목록에 없지만 Resources Allowed 문서가 과제에 필요한 패키지 설치는 요구하지 않는다고 적으므로 Helm 과제 호스트에는 있을 가능성이 높습니다. 과제 호스트에서 `helm version`으로 있는지와 메이저 버전부터 봅니다. Kustomize는 kubectl에 들어 있습니다.

### 6-1. Helm

Helm은 차트를 값과 합쳐 설치하고 설치를 릴리스로 기록하며 설치, 업그레이드, 롤백마다 리비전이 오릅니다. 2026년 10월 helm.sh 문서의 기본 버전은 4.3.1이고 아래 명령은 Helm 3과 4에 공통입니다.

```bash
helm repo add <이름> <URL>
helm repo update
helm search repo <키워드>
helm show values <저장소>/<차트>                 # 바꿀 수 있는 값

helm install shop-cache <저장소>/<차트> \
  -n shop --create-namespace \
  --set replicaCount=2

helm list -A
helm upgrade --install shop-cache <저장소>/<차트> -n shop -f values-shop.yaml
helm history shop-cache -n shop
helm rollback shop-cache 1 -n shop
helm uninstall shop-cache -n shop
helm get values shop-cache -n shop             # 사용자가 넣은 값. --all이면 전체
```

`-f` 값 파일은 여러 번 줄 수 있고 오른쪽이 우선하며 `--version`은 차트 버전(`Chart.yaml`의 `version`)을 고릅니다. `oci://...` 주소로 바로 설치할 수도 있습니다. Helm 4에서 `--atomic`은 `--rollback-on-failure`로, `--force`는 `--force-replace`로 이름이 바뀌었고 옛 이름은 경고와 함께 동작합니다.

### 6-1b. 차트를 받아 고쳐서 설치

기본 `values.yaml`이나 템플릿을 고쳐야 하는 과제라면 차트를 내려받아 디렉터리로 설치합니다.

```bash
helm pull <저장소>/<차트> --untar               # ./<차트>/ 생성 (Chart.yaml, values.yaml, templates/, crds/)
vi <차트>/values.yaml
helm template shop-cache ./<차트> -n shop | less
helm install shop-cache ./<차트> -n shop --create-namespace --dry-run=client
helm install shop-cache ./<차트> -n shop --create-namespace
```

`--dry-run`은 `=client`나 `=server`를 붙여 씁니다. Helm 4.3.1은 값 없는 `--dry-run`에 사용 중단 경고를 냅니다.

### 6-1c. 차트가 CRD를 가져올 때

오퍼레이터 차트는 대개 `crds/` 디렉터리에 CRD를 담습니다. Helm 문서가 정한 동작은 일반 템플릿과 다릅니다.

| 상황 | 동작 |
|---|---|
| `helm install` | `crds/`를 먼저 올리고 등록을 기다린 뒤 템플릿 설치 |
| CRD가 이미 있음 | 경고와 함께 건너뜀 |
| `helm upgrade`, `rollback` | CRD를 설치하거나 올리지 않음 |
| `helm uninstall` | CRD를 지우지 않음 |
| `helm template` | 기본 출력에 CRD가 빠짐. `--include-crds`가 있어야 포함 |

렌더링 파일을 `kubectl apply -f`로 넣는 과제에서 `--include-crds`를 빠뜨리면 이렇게 실패합니다.

```text
no matches for kind "Refund" in version "pay.example.com/v1"
ensure CRDs are installed first
```

`--include-crds`를 넣어도 CRD가 등록되기 전에 커스텀 객체가 처리되어 같은 오류가 날 수 있으니 `kubectl wait` 뒤 한 번 더 apply합니다. 템플릿이 `{{ .Release.Namespace }}`를 쓰지 않으면 `helm template -n`은 네임스페이스를 넣지 않으니 `kubectl apply`에도 `-n`을 붙입니다.

```bash
helm template payment-op ./payment-operator -n payment --include-crds > payment-op.yaml
kubectl apply -f payment-op.yaml -n payment
kubectl wait --for=condition=Established crd/refunds.pay.example.com
kubectl apply -f payment-op.yaml -n payment
```

차트에 따라 CRD를 `templates/`에 두고 값으로 켜고 끕니다(cert-manager의 `--set crds.enabled=true`). 값 이름은 `helm show values <차트> | grep -i -A3 crd`로 찾습니다.

### 6-2. Kustomize

Kustomize는 원본 YAML을 고치지 않고 `kustomization.yaml`에 적은 변형을 덧입혀 결과를 만듭니다.

```bash
kubectl kustomize ./overlays/prod   # 결과만 출력
kubectl apply -k ./overlays/prod    # 적용
kubectl diff -k ./overlays/prod
kubectl delete -k ./overlays/prod
```

```yaml
# overlays/prod/kustomization.yaml (쇼핑몰 주문 API)
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

- base는 overlay를 모릅니다. 같은 base를 여러 overlay가 가져다 씁니다.
- `configMapGenerator`, `secretGenerator`가 만든 이름에는 내용 해시가 붙습니다. 내용이 바뀌면 이름이 바뀌어 참조하는 Deployment가 롤아웃됩니다. 끄려면 `generatorOptions.disableNameSuffixHash: true`입니다.

### 6-3. Helm 릴리스 기록과 롤백

Helm 3부터 Tiller가 없고 helm은 kubeconfig 자격 증명으로 API 서버에 직접 요청하므로 할 수 있는 일은 그 사용자의 RBAC 권한과 같습니다. 릴리스 기록은 릴리스 네임스페이스의 Secret(`sh.helm.release.v1.<릴리스>.v<리비전>`)에 남고 `kubectl get secret -n shop -l owner=helm`으로 보입니다.

`helm rollback`은 과거 내용으로 새 리비전을 만듭니다. 리비전 3에서 1로 롤백하면 리비전 4가 생기고 설명은 `Rollback to 1`입니다. PV 안의 데이터는 되돌리지 않습니다.

### 6-4. Kustomize 변형 필드와 패치 두 종류

`namePrefix`는 같은 빌드 안의 참조(Deployment의 ConfigMap 이름 등)도 함께 바꿉니다. `labels`는 `includeSelectors: true`일 때만 셀렉터에 들어가고 `commonLabels`는 kustomize v5에서 사용 중단되었습니다. 배포된 Deployment에 셀렉터 레이블을 더하면 `spec.selector: ... field is immutable`로 실패합니다.

개별 수정은 `patches` 하나로 두 형식을 받습니다. strategic merge 파일(`replica-patch.yaml`)은 `apiVersion`, `kind`, `metadata.name`과 바꿀 필드만 담은 Deployment 조각이고 컨테이너 목록은 `name`을 키로 병합됩니다.

```yaml
# overlays/prod/kustomization.yaml
resources:
  - ../../base
patches:
  # 1) strategic merge: 바꿀 부분만 담은 조각. 대상은 파일 안의 kind와 name
  - path: replica-patch.yaml
  # 2) JSON 6902: 연산 목록. target 필수
  - target:
      group: apps
      version: v1
      kind: Deployment
      name: order-api
    patch: |-
      - op: replace
        path: /spec/replicas
        value: 5
```

옛 자료의 `patchesStrategicMerge`, `patchesJson6902`, `bases` 필드는 사용 중단되었습니다. 지금은 `patches`와 `resources`에 적습니다.

### 6-5. kustomize build와 kubectl kustomize

`kustomize build <디렉터리>`와 `kubectl kustomize <디렉터리>`는 둘 다 출력만 합니다. 적용은 `kubectl apply -k` 또는 `kustomize build <디렉터리> | kubectl apply -f -`입니다. 내장 Kustomize 버전은 `kubectl version --client`에 나옵니다. `components`(`kind: Component`)는 범위 밖이라 이름만 알아 둡니다.

### 6-6. 헷갈리는 지점

- `helm install`의 인자 순서는 `[NAME] [CHART]`입니다. 이름을 빼면 `Error: INSTALLATION FAILED: must either provide a name or specify --generate-name`이 납니다.
- `-f`와 `--set`을 함께 주면 `--set`이 우선합니다.
- Kustomize `images`의 `name`은 매니페스트의 이미지 이름과 맞춰집니다. 컨테이너 이름과는 무관합니다.
- 변형 필드는 그 필드를 적은 `kustomization.yaml`이 모은 리소스에만 걸립니다. 루트가 `resources: [api/, db/]`로 하위 디렉터리를 가져오면 루트의 `namespace`, `labels`는 전체에, `api/kustomization.yaml`의 `namePrefix`는 api 리소스에만 걸립니다.

### 6-7. 직접 해 보기

게시판 base(Deployment, Service)와 `dev`, `prod` overlay를 만들고 prod에 6-4절의 두 패치 형식을 넣어 `kubectl kustomize`로 비교합니다. `helm create`로 만든 로컬 차트를 설치, 업그레이드, 롤백한 뒤 `helm history`의 리비전과 `-l owner=helm` Secret 수를 맞춰 봅니다.

## 7. 확장 인터페이스: CNI, CSI, CRI

커리큘럼 문구는 "Understand extension interfaces (CNI, CSI, CRI, etc.)"입니다. 셋 다 쿠버네티스를 다시 빌드하지 않고 바깥 구현을 끼우는 규약입니다.

| 인터페이스 | 누가 부르는지 | 맡기는 일 | 확인할 곳 |
|---|---|---|---|
| CRI | kubelet(gRPC) | 컨테이너와 이미지 관리 | kubelet `--container-runtime-endpoint`, `crictl` |
| CNI | 컨테이너 런타임 | Pod IP 할당과 라우팅 | `/etc/cni/net.d`(설정), `/opt/cni/bin`(플러그인) |
| CSI | 쿠버네티스 볼륨 계층 | 스토리지 연결과 마운트 | `kubectl get csidrivers`, StorageClass `provisioner` |

### 7-1. CRI

dockershim은 1.24에서 빠졌고 노드에는 containerd나 CRI-O 같은 CRI 런타임이 있습니다. Docker Engine을 쓰려면 cri-dockerd가 필요하고 소켓 경로는 2-4b절 표에 있습니다. 노드에서 컨테이너를 보는 도구가 `crictl`입니다.

### 7-2. CNI

1.24부터 kubelet의 `network-plugin` 플래그가 사라졌고 런타임이 CNI 플러그인을 부릅니다. Pod IP가 안 잡히면 `/etc/cni/net.d`의 설정과 플러그인 Pod 상태부터 봅니다. NetworkPolicy는 CNI 플러그인이 지원해야 동작합니다.

CNI 업체 사이트는 허용 문서 목록에 없으니 과제가 주는 매니페스트나 URL을 씁니다. 순서는 클러스터 Pod CIDR 확인(kubeadm은 `--pod-network-cidr`를 kube-controller-manager의 `--cluster-cidr`로 넣음), 매니페스트나 Helm 값의 대역을 클러스터 값에 맞추기, 적용 뒤 노드 `Ready`와 CoreDNS `Running` 확인입니다.

```bash
sudo grep -E 'cluster-cidr|allocate-node-cidrs' /etc/kubernetes/manifests/kube-controller-manager.yaml
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.podCIDR}{"\n"}{end}'

kubectl apply -f <과제가 준 CNI 매니페스트>
kubectl get pods -n kube-system -o wide -w     # 플러그인 DaemonSet Pod
kubectl get nodes                               # NotReady -> Ready
sudo ls /etc/cni/net.d/
```

Calico는 자체 IPAM을 써서 노드의 `spec.podCIDR`(예: `10.244.1.0/24`)와 실제 Pod IP(예: `10.244.140.x`)가 다를 수 있고 클러스터 대역 안이면 정상입니다. Helm 차트라면 `helm show values`로 대역 값의 키 이름부터 찾습니다.

### 7-3. CSI

예전 볼륨 플러그인은 쿠버네티스 바이너리 안(in-tree)에 있었고 CSI가 이 결합을 끊었습니다. CSI 드라이버를 설치하면 StorageClass의 `provisioner`에 그 드라이버 이름을 적어 씁니다([Ch-05](/blog/cert/cka/cka-05-storage)).

### 7-4. 직접 해 보기

노드에서 아래를 실행해 런타임, CNI, CSI 드라이버를 표로 적습니다.

```bash
sudo crictl info | head -20
ls /etc/cni/net.d/
kubectl get pods -n kube-system -o wide
kubectl get csidrivers
kubectl get nodes -o wide        # CONTAINER-RUNTIME 열
```

## 8. CRD와 오퍼레이터

커리큘럼 문구는 "Understand CRDs, install and configure operators"입니다.

### 8-1. CRD

CustomResourceDefinition을 만들면 API 서버가 새 리소스를 열고 그 뒤로는 `kubectl get`, `apply`, `delete`를 그대로 씁니다.

- CRD 자체는 클러스터 범위입니다. 커스텀 객체는 `spec.scope`에 따라 `Namespaced` 또는 `Cluster`입니다.
- CRD 이름은 `<plural>.<group>`입니다.
- 저장 버전(`storage: true`)은 정확히 하나입니다.

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
```

```bash
kubectl apply -f boardjob-crd.yaml
kubectl get crd boardjobs.example.com
kubectl api-resources --api-group=example.com
kubectl explain boardjob.spec
kubectl get bj -A
```

`kubectl explain`은 CRD 스키마도 보여 줍니다. apply 직후 몇 초는 `error: couldn't find resource for "example.com/v1, Resource=boardjobs"`가 나올 수 있고 `Established` condition이 된 뒤 다시 치면 됩니다.

### 8-2. 오퍼레이터

"Operator pattern" 문서의 정의로 오퍼레이터는 커스텀 리소스의 컨트롤러 역할을 하는 API 클라이언트입니다. 보통 CRD, 컨트롤러를 돌리는 Deployment, 컨트롤러용 ServiceAccount와 RBAC 세 부분입니다.

"오퍼레이터를 설치하라"는 대개 Helm 차트나 매니페스트로 이 셋을 넣는 일이고 "구성하라"는 커스텀 리소스를 만드는 일입니다. 설치 뒤에는 CRD, 컨트롤러 Pod, 커스텀 객체가 만드는 하위 리소스를 차례로 봅니다.

```bash
kubectl get crd | grep example.com
kubectl explain boardjob.spec --recursive | head -30
kubectl get boardjobs -A
kubectl get deploy -A | grep -i operator
```

OLM(Operator Lifecycle Manager)은 카탈로그에서 오퍼레이터를 골라 설치해 주는 별도 프로젝트입니다. 커리큘럼 문구와 허용 문서에 없어 이름만 알아 둡니다([operator-framework 문서](https://operator-framework.github.io/operator-controller/)).

### 8-3. 헷갈리는 지점

- CRD를 지우면 그 CRD로 만든 커스텀 객체도 모든 네임스페이스에서 함께 사라집니다. Helm이 uninstall 때 CRD를 남기는 이유입니다(6-1c절).
- CRD만 있고 컨트롤러가 없으면 객체는 저장만 되고 아무 일도 일어나지 않습니다.

### 8-4. 직접 해 보기

`BoardJob` CRD를 적용하고 커스텀 객체 하나를 만든 뒤 `kubectl get bj -o yaml`로 내용을 봅니다. CRD를 지운 직후 목록 조회는 이렇게 나옵니다.

```text
Error from server (NotFound): Unable to list "example.com/v1, Resource=boardjobs": the server could not find the requested resource
```

## 9. 확인 문제

위 내용을 바탕으로 직접 만든 연습 과제입니다.

1. 네임스페이스 `payment`에 ServiceAccount `settle-bot`을 만들고 이 계정이 `payment`의 Secret을 `get`만 할 수 있게 하세요. `list`는 안 되어야 합니다.
2. 모든 네임스페이스에서 Deployment를 볼 수만 있는 권한을 그룹 `auditors`에 주세요.
3. RoleBinding `order-binding`이 Role `old-role`을 가리킵니다. `new-role`을 가리키게 바꾸세요.
4. 워커 노드 `node02`만 1.37.x로 올리세요. 컨트롤 플레인은 이미 1.37.x입니다.
5. etcd 스냅샷을 `/opt/backup/shop.db`에 저장하고 상태를 표로 확인한 뒤 `/var/lib/etcd-restore`로 복구하세요.
6. 사용자 `refund-user`의 CSR `refund-user`가 Pending입니다. 서명자를 확인한 뒤 승인하고 인증서를 `/opt/refund-user.crt`에 저장하세요.
7. 노드 `node01`에 단독 Pod 하나와 emptyDir를 쓰는 Deployment Pod가 있어 drain이 거부됩니다. 필요한 옵션과 각 옵션의 결과를 적으세요.
8. 새 노드 `node03`에 Docker Engine이 있고 `/root/cri-dockerd.deb`가 주어졌습니다. cri-dockerd를 설치해 재부팅 뒤에도 실행되게 하고 이 노드를 클러스터에 붙이세요.
9. 오퍼레이터 차트 `./payment-operator`(`crds/` 있음)를 렌더링해 `/opt/payment-op.yaml`에 저장하고 `kubectl`로 적용한 뒤 CRD가 생겼는지 확인하세요.

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
3. `roleRef`는 바꿀 수 없으니 지우고 다시 만듭니다.
   ```bash
   kubectl get rolebinding order-binding -o yaml > /tmp/order-binding.yaml
   kubectl delete rolebinding order-binding
   # roleRef.name을 new-role로 고치고 metadata의 resourceVersion, uid를 지운 뒤
   kubectl apply -f /tmp/order-binding.yaml
   ```
4. 워커 순서는 kubeadm 갱신, `kubeadm upgrade node`, drain, kubelet 갱신, uncordon입니다(4-2절 명령). 저장소 경로가 v1.37인지 먼저 봅니다. kubeadm과 kubelet 작업은 `ssh node02`에서, drain과 uncordon은 kubectl이 되는 호스트에서 실행합니다.
   ```bash
   kubectl drain node02 --ignore-daemonsets
   # node02에서 kubelet, kubectl 설치 후
   sudo systemctl daemon-reload && sudo systemctl restart kubelet
   kubectl uncordon node02
   ```
5. 인증서 경로를 매니페스트에서 확인하고 저장, 확인, 복구합니다.
   ```bash
   sudo grep -E 'cert|key|trusted' /etc/kubernetes/manifests/etcd.yaml
   etcdctl --endpoints=https://127.0.0.1:2379 \
     --cacert=/etc/kubernetes/pki/etcd/ca.crt \
     --cert=/etc/kubernetes/pki/etcd/server.crt \
     --key=/etc/kubernetes/pki/etcd/server.key \
     snapshot save /opt/backup/shop.db
   etcdutl --write-out=table snapshot status /opt/backup/shop.db
   sudo etcdutl --data-dir /var/lib/etcd-restore snapshot restore /opt/backup/shop.db
   # etcd.yaml의 etcd-data hostPath.path를 /var/lib/etcd-restore로
   ```
   etcd가 다시 뜨면 kube-apiserver, kube-controller-manager, kube-scheduler 매니페스트를 밖으로 옮겼다 되돌려 재시작합니다. 클러스터를 계속 kubeadm으로 업그레이드할 거라면 `kubeadm-config`의 `etcd.local.dataDir`도 고칩니다.
6. 서명자와 요청 내용을 보고 승인합니다. 승인된 CSR은 1시간 뒤 지워지니 바로 꺼냅니다.
   ```bash
   kubectl get csr refund-user -o jsonpath='{.spec.signerName}{"\n"}{.spec.usages}{"\n"}'
   kubectl get csr refund-user -o jsonpath='{.spec.request}' | base64 -d | openssl req -noout -subject
   kubectl certificate approve refund-user
   kubectl get csr refund-user -o jsonpath='{.status.certificate}' | base64 -d > /opt/refund-user.crt
   ```
7. 단독 Pod 때문에 `--force`, emptyDir 때문에 `--delete-emptydir-data`, DaemonSet Pod가 있다면 `--ignore-daemonsets`가 필요합니다. 단독 Pod는 다시 만들어 줄 컨트롤러가 없어 사라지고 emptyDir 데이터도 지워집니다. Deployment Pod는 다른 노드에 다시 생깁니다.
   ```bash
   kubectl drain node01 --ignore-daemonsets --delete-emptydir-data --force
   ```
8. 패키지 설치, 서비스 등록, 소켓 확인, 소켓을 지정한 join 순서입니다. Docker와 함께 containerd 소켓도 있을 수 있어 `--cri-socket`을 명시합니다.
   ```bash
   sudo dpkg -i /root/cri-dockerd.deb                 # node03에서
   sudo systemctl daemon-reload
   sudo systemctl enable --now cri-docker.socket cri-docker.service
   systemctl is-enabled cri-docker.socket; ls -l /run/cri-dockerd.sock
   kubeadm token create --print-join-command          # 컨트롤 플레인에서
   sudo kubeadm join <주소>:6443 --token <토큰> --discovery-token-ca-cert-hash sha256:<해시> \
     --cri-socket unix:///var/run/cri-dockerd.sock
   ```
9. `helm template`은 기본으로 `crds/`를 출력하지 않으니 `--include-crds`가 필요합니다.
   ```bash
   helm template payment-op ./payment-operator -n payment --include-crds > /opt/payment-op.yaml
   kubectl create namespace payment --dry-run=client -o yaml | kubectl apply -f -
   kubectl apply -f /opt/payment-op.yaml -n payment
   kubectl get crd | grep -i payment
   ```
   첫 apply에서 커스텀 객체만 `no matches for kind`로 실패하면 `kubectl wait` 뒤 한 번 더 apply합니다.

</details>

## 범위와 한계

- 명령과 YAML은 kind v1.37 클러스터와 Lima VM의 kubeadm 1.36→1.37 클러스터에서 2026년 10월에 직접 돌려 확인했습니다. HA 장애 동작은 kind 컨트롤 플레인 3대로, `--certificate-key` join과 키 재발급은 Lima VM 3대로 확인했습니다. 이 VM 구성은 LB 없이 첫 노드 IP를 엔드포인트로 썼고 2시간 만료는 TTL 토큰을 지워 재현했습니다.
- etcd 백업과 kubeadm 업그레이드가 현재 시험에 나오는지는 공식 문서로 확인되지 않고 후기도 엇갈립니다.
- 시험 호스트의 `etcdutl`, `crictl`은 공개 자료로 확인할 수 없습니다. `helm`, `etcdctl`은 해당 과제 호스트에 있을 가능성이 높은 정도이고 공식 사전 설치 목록은 kubectl, yq, curl, wget, man입니다.
- etcd 기본 버전(1.37은 3.7.0), containerd 설정 형식, Helm 플래그 이름은 패치나 메이저 버전마다 달라질 수 있으니 시험 노드에서 `--version`과 `config default`로 확인합니다.
- 확인 문제는 문서를 바탕으로 제가 만든 것이고 실제 시험 문항과 관계없습니다.

## 참고 자료

- CNCF, [CKA Curriculum v1.37](https://github.com/cncf/curriculum/blob/master/CKA_Curriculum_v1.37.pdf); Linux Foundation, [Important Instructions: CKA and CKAD](https://docs.linuxfoundation.org/tc-docs/certification/tips-cka-and-ckad); Linux Foundation, [Resources Allowed](https://docs.linuxfoundation.org/tc-docs/certification/certification-resources-allowed)
- Kubernetes, [Using RBAC Authorization](https://kubernetes.io/docs/reference/access-authn-authz/rbac/), [Issue a Certificate for a Kubernetes API Client Using A CertificateSigningRequest](https://kubernetes.io/docs/tasks/tls/certificate-issue-client-csr/), [PKI certificates and requirements](https://kubernetes.io/docs/setup/best-practices/certificates/)
- Kubernetes, [Installing kubeadm](https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/install-kubeadm/), [Container Runtimes](https://kubernetes.io/docs/setup/production-environment/container-runtimes/), [Reconfiguring a kubeadm cluster](https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/kubeadm-reconfigure/)
- Kubernetes, [Version Skew Policy](https://kubernetes.io/releases/version-skew-policy/), [Upgrading kubeadm clusters](https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/kubeadm-upgrade/), [Certificate Management with kubeadm](https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/kubeadm-certs/), [Operating etcd clusters for Kubernetes](https://kubernetes.io/docs/tasks/administer-cluster/configure-upgrade-etcd/), [Creating Highly Available Clusters with kubeadm](https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/high-availability/)
- Kubernetes, [Custom Resources](https://kubernetes.io/docs/tasks/extend-kubernetes/custom-resources/custom-resource-definitions/), [Kustomize](https://kubernetes.io/docs/tasks/manage-kubernetes-objects/kustomization/); Helm, [Using Helm](https://helm.sh/docs/intro/using_helm/), [CRD Best Practices](https://helm.sh/docs/chart_best_practices/custom_resource_definitions/), [Helm 4 Overview](https://helm.sh/docs/overview/)
- etcd, [Announcing etcd v3.6](https://etcd.io/blog/2025/announcing-etcd-3.6/); containerd, [CRI plugin config](https://github.com/containerd/containerd/blob/main/docs/cri/config.md); Mirantis, [cri-dockerd Install](https://mirantis.github.io/cri-dockerd/usage/install/)
- 후기: Domenic Cassisi, [I passed the CKA! (2026)](https://dcassisi.com/2026/06/09/i-passed-the-cka-my-exam-experience-2026/); Talha Juikar, [Passing the CKA Exam](https://talhajuikar.com/posts/passing-cka-exam/)

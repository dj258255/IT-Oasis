---
title: '[CKA Ch-04] 서비스와 네트워킹: Pod IP에서 Gateway API까지 한 줄로 잇기'
description: CKA 커리큘럼 v1.37의 Services and Networking 영역(20%)을 목차 순서대로 정리합니다. Pod 간 연결 모델과 노드 포트, CNI 설정 위치, Pod와 Service 대역 확인법, NetworkPolicy, Service 타입과 EndpointSlice, Gateway API(헤더 매칭, 필터, ReferenceGrant 포함), Ingress와 rewrite-target, Ingress NGINX 은퇴, CoreDNS와 Pod DNS 레코드를 kubernetes.io와 gateway-api.sigs.k8s.io 문서로 확인하고 시험에서 쓸 명령과 YAML, 자주 틀리는 지점, 연습 과제를 붙였습니다.
date: 2026-10-19T00:00:00.000Z
tags:
  - CKA
  - Kubernetes
  - NetworkPolicy
  - Service
  - Gateway API
  - Ingress
  - CoreDNS
category: cert/CKA
topics:
  - cert
draft: false
series: "CKA 공부"
seriesOrder: 4
---

## 결론부터

1. 쿠버네티스 네트워크 모델의 출발점은 "모든 Pod가 클러스터 전체에서 고유한 IP를 받고 NAT 없이 서로 통신한다"는 규칙입니다. 이 규칙을 실제로 구현하는 쪽은 CNI 플러그인이고 NetworkPolicy를 집행하는 쪽도 대개 같은 플러그인입니다. 그래서 정책을 만들었는데 효과가 없으면 플러그인부터 의심합니다.
2. NetworkPolicy는 허용 목록만 있습니다. 어떤 정책이 Pod를 선택하는 순간 그 방향(Ingress 또는 Egress)은 격리되고 정책들의 허용 범위를 합친 만큼만 통신이 열립니다. 시험에서 가장 많이 틀리는 곳은 `from` 아래 `namespaceSelector`와 `podSelector`를 한 항목에 쓰는지(AND) 두 항목으로 나누는지(OR)입니다.
3. Service는 selector로 Pod를 고르고 컨트롤 플레인이 그 결과를 EndpointSlice에 적습니다. Service가 응답하지 않을 때 가장 먼저 볼 것은 `kubectl get endpointslices -l kubernetes.io/service-name=<이름>`의 ENDPOINTS 열입니다. 비어 있으면 selector와 라벨, 또는 Pod의 Ready 상태 문제입니다.
4. Gateway API는 Ingress의 후속 API이고 kubernetes.io 문서도 Ingress 대신 Gateway를 쓰라고 권합니다. GatewayClass, Gateway, HTTPRoute 세 종류를 누가 만들고 무엇을 참조하는지만 잡으면 YAML은 짧습니다. Ingress API는 동결(frozen)됐지만 제거 계획은 없으니 둘 다 손에 익혀 둡니다.
5. CoreDNS의 Service 이름은 호환성 때문에 `kube-dns`이고 Pod 라벨도 `k8s-app=kube-dns`입니다. DNS 문제는 Pod의 `/etc/resolv.conf`, CoreDNS Pod, `kube-dns` Service, 그 EndpointSlice, `coredns` ConfigMap 순서로 좁혀 갑니다.

---

커리큘럼 원문(CNCF, CKA Curriculum v1.37)의 이 영역 항목은 여섯 개입니다. PDF에는 영역 이름이 "Servicing and Networking"으로 적혀 있는데 Linux Foundation 시험 페이지와 이 시리즈의 다른 글에서는 "Services and Networking"으로 부릅니다.

| 순서 | 커리큘럼 원문 | 이 글의 절 |
|---|---|---|
| 1 | Understand connectivity between Pods | 1. Pod 간 연결 |
| 2 | Define and enforce Network Policies | 2. NetworkPolicy |
| 3 | Use ClusterIP, NodePort, LoadBalancer service types and endpoints | 3. Service 타입과 EndpointSlice |
| 4 | Use the Gateway API to manage Ingress traffic | 4. Gateway API |
| 5 | Know how to use Ingress controllers and Ingress resources | 5. Ingress |
| 6 | Understand and use CoreDNS | 6. CoreDNS |

예시는 모두 가상의 쇼핑몰입니다. 네임스페이스 `shop`에 주문 API(`app=order-api`), 결제(`app=payment`), 게시판(`app=board`)이 있다고 둡니다.

## 1. Pod 간 연결

### 1-1. 네트워크 모델 네 가지 문제

kubernetes.io의 Cluster Networking 문서는 쿠버네티스 네트워킹이 풀어야 할 문제를 네 개로 나눕니다.

| 문제 | 해결 수단 |
|---|---|
| 같은 Pod 안 컨테이너끼리 | Pod와 `localhost`. 한 Pod의 컨테이너는 네트워크 네임스페이스를 공유한다 |
| Pod와 Pod | Pod 네트워크(클러스터 네트워크). 이 절의 주제 |
| Pod와 Service | Service |
| 클러스터 밖에서 Service로 | Service(NodePort, LoadBalancer), Ingress, Gateway |

"Services, Load Balancing, and Networking" 개요 문서가 적는 Pod 네트워크의 약속은 다음과 같습니다.

- 클러스터의 모든 Pod는 클러스터 전체에서 고유한 IP를 받습니다.
- 의도적으로 네트워크를 나누지 않았다면 모든 Pod는 같은 노드든 다른 노드든 다른 모든 Pod와 프록시나 NAT 없이 직접 통신할 수 있습니다.
- 노드의 에이전트(시스템 데몬, kubelet)는 그 노드의 모든 Pod와 통신할 수 있습니다.

### 1-2. 누가 무엇을 구현하나

같은 문서는 이 모델 중 쿠버네티스 자신이 구현하는 부분이 적다고 적습니다. 나머지는 API만 정의하고 외부 구성요소가 채웁니다.

| 부분 | 구현 주체 |
|---|---|
| Pod 네트워크 네임스페이스 생성 | CRI를 구현한 컨테이너 런타임 |
| Pod 네트워크 자체 | Pod 네트워크 구현체. 리눅스에서는 대부분 CNI로 런타임과 연결되므로 CNI 플러그인이라 부른다 |
| Service 프록시 | 기본 구현은 kube-proxy. 일부 네트워크 구현체는 자체 프록시를 쓴다 |
| NetworkPolicy | 대개 Pod 네트워크 구현체 |

IP 대역도 셋으로 나뉩니다. Pod IP는 네트워크 플러그인이, Service IP는 kube-apiserver가, 노드 IP는 kubelet 또는 cloud-controller-manager가 할당하고 세 대역은 겹치면 안 됩니다.

kube-proxy는 리눅스에서 `iptables`, `ipvs`, `nftables` 모드를 지원합니다. Virtual IPs and Service Proxies 문서는 모드를 지정하지 않으면 현재 기본값이 `iptables`이고 앞으로 `nftables`로 바뀔 예정이라고 적습니다. `ipvs` 모드는 v1.35부터 사용 중단(deprecated) 상태이고 v1.40에서 기본 비활성화, v1.43에서 제거될 예정입니다. 옛 강의에서 ipvs를 기본처럼 다루면 걸러서 듣습니다.

패킷이 Service IP를 만나 iptables 규칙과 conntrack을 거쳐 Pod로 가는 커널 쪽 경로는 [쿠버네티스 아래의 리눅스 5편](/blog/theory/systems/k8s-linux-05-service-iptables-conntrack)에서 따로 다룹니다. 이 글은 시험에서 쓰는 확인 명령까지만 봅니다.

### 1-3. 노드가 여는 포트 표

노드끼리 통신이 안 되는 과제는 방화벽이나 보안 그룹이 필요한 포트를 막은 경우가 많습니다. Ports and Protocols 문서의 표를 옮깁니다. 모두 기본값이고 바꿀 수 있습니다.

| 노드 | 포트(프로토콜) | 쓰는 구성요소 | 누가 접속하나 |
|---|---|---|---|
| 컨트롤 플레인 | 6443/TCP | kube-apiserver | 전부 |
| 컨트롤 플레인 | 2379-2380/TCP | etcd 클라이언트 API와 피어 | kube-apiserver, etcd |
| 컨트롤 플레인 | 10250/TCP | kubelet API | 자기 자신, 컨트롤 플레인 |
| 컨트롤 플레인 | 10259/TCP | kube-scheduler | 자기 자신 |
| 컨트롤 플레인 | 10257/TCP | kube-controller-manager | 자기 자신 |
| 워커 | 10250/TCP | kubelet API | 자기 자신, 컨트롤 플레인 |
| 워커 | 10256/TCP | kube-proxy 헬스체크 | 자기 자신, 로드밸런서 |
| 워커 | 30000-32767/TCP, UDP | NodePort Service 기본 범위 | 전부 |

표를 외울 때 같이 기억할 사실이 셋 있습니다.

- 10257과 10259의 "누가 접속하나" 열은 자기 자신뿐입니다. kubeadm 소스(`cmd/kubeadm/app/phases/controlplane/manifests.go`)도 kube-controller-manager와 kube-scheduler에 `--bind-address=127.0.0.1`을 넣습니다. kubeadm 클러스터에서는 이 두 포트를 노드 밖에 열 필요가 없습니다.
- kubectl의 `logs`, `exec`, `port-forward`는 API 서버가 kubelet의 10250으로 접속해서 처리합니다. 컨트롤 플레인에서 워커의 10250이 막히면 Pod는 잘 도는데 `kubectl logs`만 실패합니다.
- etcd를 외부에 두거나 API 서버를 443 뒤에 두는 구성도 문서가 언급합니다. 시험 노드에서는 정적 Pod 매니페스트(`/etc/kubernetes/manifests/`)의 `--secure-port`, `--listen-client-urls` 값을 보고 실제 포트를 확인합니다.

CNI 플러그인이 쓰는 포트(VXLAN, BGP 같은 것)는 이 표에 없고 플러그인 문서에 있습니다.

### 1-4. CNI 설정은 컨테이너 런타임이 읽는다

kubelet은 CRI로 런타임에 Pod 샌드박스를 만들어 달라고 요청할 뿐이고 CNI 플러그인을 부르는 쪽은 containerd나 CRI-O입니다. Network Plugins 문서는 런타임이 쿠버네티스 네트워크 모델을 구현하는 데 필요한 CNI 플러그인을 읽도록 설정돼야 한다고 적습니다. 1.24 전에는 kubelet이 `--network-plugin`, `--cni-bin-dir` 같은 옵션으로 CNI를 관리했지만 1.24에서 이 옵션들이 제거됐습니다. 옛 강의에서 "kubelet 옵션에서 CNI 디렉터리를 찾아라"라고 하면 지금은 런타임 설정을 봅니다.

| 위치 | 내용 | 근거 |
|---|---|---|
| `/etc/cni/net.d` | CNI 설정 파일(`.conf`, `.conflist`) | Network Plugins 문서의 기본값, containerd CRI 설정 `conf_dir` 기본값 |
| `/opt/cni/bin` | 플러그인 실행 파일(`bridge`, `host-local`, `loopback`, 서드파티 바이너리) | 같은 문서, containerd `bin_dirs` 기본값 |
| `/etc/containerd/config.toml` | 위 두 경로를 바꾸는 곳 | containerd `docs/cri/config.md` |

containerd의 `max_conf_num` 기본값은 1입니다. 설정 디렉터리에서 파일 이름 순으로 맨 앞 파일 하나만 읽는다는 뜻이라서 `00-old.conflist` 같은 남은 파일이 실제 플러그인 설정보다 앞에 있으면 엉뚱한 설정이 적용됩니다. 설정 파일의 `"type"` 값은 `/opt/cni/bin` 안의 실행 파일 이름과 같아야 합니다.

CNI 문제는 증상이 둘로 나타납니다.

| 증상 | 어디서 보나 |
|---|---|
| 노드가 `NotReady` | `kubectl describe node`의 Ready 조건 메시지에 `container runtime network not ready`가 들어간다(kubelet 소스의 문구) |
| Pod가 `ContainerCreating`에서 멈춤 | `kubectl describe pod`의 이벤트 사유 `FailedCreatePodSandBox` |

두 경우 모두 노드에 들어가 `ls /etc/cni/net.d /opt/cni/bin`으로 파일을 보고 `journalctl -u containerd`(CRI-O면 `-u crio`)와 `journalctl -u kubelet`을 같이 읽습니다. CNI를 직접 실행하는 런타임 쪽 로그가 원인을 더 구체적으로 적는 경우가 많습니다. "cni failed to set up pod"로 시작하는 옛 이벤트 문구는 dockershim 시절 것이라 지금 런타임에서는 모양이 다릅니다.

Weave Net은 옛 강의와 블로그에 자주 나오지만 GitHub의 `weaveworks/weave` 저장소는 보관(archived) 상태이고 마지막 릴리스는 v2.8.1(2021-01-25)입니다(2026년 10월 20일 GitHub API 기준). 운영사 Weaveworks는 2024년 2월에 영업을 접었습니다. 지금 연습 클러스터에는 Calico, Cilium, Flannel처럼 유지되는 플러그인을 씁니다. Flannel 단독 구성은 NetworkPolicy를 집행하지 않는 것으로 알려져 있으니 2절을 연습하려면 Calico나 Cilium을 고릅니다. CKA 시험 환경이 어떤 CNI를 쓰는지는 커리큘럼과 공식 안내에 나오지 않습니다.

### 1-5. Pod 대역, Service 대역, kube-proxy 모드 확인

"이 클러스터의 Pod IP 대역과 Service IP 대역을 적어라" 같은 과제는 어느 구성요소의 옵션에 값이 있는지만 알면 됩니다.

| 알고 싶은 것 | 어디에 있나 | 확인 명령(kubeadm 기준) |
|---|---|---|
| Service IP 대역 | kube-apiserver `--service-cluster-ip-range` | `grep service-cluster-ip-range /etc/kubernetes/manifests/kube-apiserver.yaml` |
| Service IP 대역(API 객체) | 부팅 때 위 값으로 만든 ServiceCIDR `kubernetes` | `kubectl get servicecidrs` |
| 클러스터 전체 Pod 대역 | kube-controller-manager `--cluster-cidr` (`--allocate-node-cidrs=true`일 때만 쓰임) | `grep cluster-cidr /etc/kubernetes/manifests/kube-controller-manager.yaml` |
| 노드별 Pod 대역 | Node의 `spec.podCIDR` | `kubectl get node -o jsonpath='{range .items[*]}{.metadata.name} {.spec.podCIDR}{"\n"}{end}'` |
| kube-proxy 모드 | ConfigMap `kube-proxy`의 `mode` | `kubectl -n kube-system get cm kube-proxy -o yaml \| grep mode` |
| 실제로 돌고 있는 모드 | kube-proxy 메트릭 서버의 `/proxyMode` | 노드에서 `curl -s http://127.0.0.1:10249/proxyMode` |

몇 가지 조건이 붙습니다.

- kubeadm은 `kubeadm init --pod-network-cidr`로 받은 값을 kube-controller-manager의 `--cluster-cidr`에 넣고 이때 `--allocate-node-cidrs=true`도 같이 켭니다(kubeadm 소스). 노드마다 이 대역에서 `/24`(IPv4 기본값, `--node-cidr-mask-size`)를 잘라 `spec.podCIDR`에 적습니다.
- Calico처럼 자체 IPAM을 쓰는 플러그인은 `spec.podCIDR`와 다른 대역에서 IP를 줄 수 있습니다. 그럴 때 실제 Pod 대역은 플러그인 설정(예: Calico의 IPPool)을 봅니다. `kubectl get pod -A -o wide`로 실제 Pod IP를 같이 보면 헷갈리지 않습니다.
- ConfigMap의 `mode`가 빈 문자열이면 기본값(1.37 기준 `iptables`)이 쓰입니다. kube-proxy 레퍼런스의 `--metrics-bind-address` 기본값이 `127.0.0.1:10249`라서 `/proxyMode`는 그 노드 안에서만 부를 수 있습니다. 이 경로는 문서 본문이 아니라 kube-proxy 소스(`cmd/kube-proxy/app/server.go`의 `serveMetrics`)에서 확인했습니다.
- kubeadm이 아닌 클러스터라면 `ps -ef | grep kube-apiserver`로 프로세스 인자를 보거나 `kubectl -n kube-system get pod <apiserver Pod> -o yaml`의 `command`를 봅니다.

### 1-6. 시험에서 연결을 확인하는 방법

Pod 간 연결 문제는 "실제로 패킷이 가는지"를 클러스터 안에서 확인해야 풀립니다. Debug Services 문서가 쓰는 방법은 임시 busybox Pod입니다.

```bash
# 문서(Debug Services)의 방식: 끝나면 지워지는 임시 Pod
kubectl run -it --rm --restart=Never busybox --image=registry.k8s.io/busybox:1.27.2 sh

# 한 줄로 끝내기: 대상 Pod IP와 포트로 직접 요청
kubectl -n shop get pod -o wide            # Pod IP와 노드 확인
kubectl -n shop run tmp --rm -it --restart=Never --image=busybox -- wget -qO- -T 2 10.244.1.23:8080
```

`-T 2`는 busybox `wget`의 타임아웃입니다. 막힌 연결은 응답 없이 기다리기만 할 수 있으므로 타임아웃을 주지 않으면 시험 시간을 잃습니다.

| 확인할 것 | 명령 |
|---|---|
| Pod IP, 올라간 노드 | `kubectl get pod -o wide` |
| 같은 노드 Pod끼리만 되는지 | 다른 노드에 있는 두 Pod로 각각 시험 |
| CNI 플러그인 Pod 상태 | `kubectl -n kube-system get pod -o wide` (플러그인 DaemonSet이 모든 노드에서 Running인지) |
| 노드 조건 | `kubectl describe node <노드>`의 `NetworkUnavailable` 조건 |

### 1-7. 자주 틀리는 지점

- Pod IP는 바뀝니다. 과제에서 "Pod에 연결되는지 확인하라"고 하면 IP로 시험하되 정책이나 설정에 Pod IP를 박아 넣지 않습니다. NetworkPolicy 문서도 `ipBlock`에는 Pod IP처럼 예측할 수 없는 주소 대신 클러스터 밖 IP를 쓰라고 적습니다.
- kubeadm으로 막 만든 클러스터에서 CoreDNS가 `Pending`이면 정상입니다. Troubleshooting kubeadm 문서는 Pod 네트워크 애드온을 설치하기 전까지 CoreDNS가 `Pending`에 머무는 것이 설계라고 적습니다.
- 한 Pod가 자기 Service IP로 자기 자신에게 접속하지 못하는 경우가 있습니다. 같은 문서는 많은 네트워크 애드온이 hairpin 모드를 켜지 않는다고 적습니다. 트러블슈팅 과제에서 "자기 자신 호출만 실패"면 이 경우를 떠올립니다.

### 1-8. 직접 해 보기

1. `shop` 네임스페이스에 `order-api` Deployment(이미지 `nginx`, replicas 2)를 만들고 두 Pod가 서로 다른 노드에 있는지 `-o wide`로 확인합니다.
2. 임시 Pod에서 두 Pod IP의 80번 포트로 각각 `wget`을 보내 둘 다 응답하는지 봅니다.
3. 컨트롤 플레인 노드에서 `ip route`로 Pod 대역 라우트가 어떻게 잡혔는지 보고 사용하는 CNI 플러그인 이름을 `kube-system` Pod 목록에서 찾습니다.
4. 1-5의 표대로 Service 대역, `--cluster-cidr`, 노드별 `spec.podCIDR`, kube-proxy 모드를 적어 보고 실제 Pod IP와 Service IP가 각 대역 안에 있는지 맞춰 봅니다.
5. 워커 노드에서 `/etc/cni/net.d`의 파일을 다른 디렉터리로 잠시 옮기고 새 Pod를 그 노드에 띄워 이벤트와 노드 조건이 어떻게 바뀌는지 본 뒤 되돌립니다. 연습 클러스터에서만 합니다.

## 2. NetworkPolicy 정의와 적용

### 2-1. 격리의 의미

NetworkPolicy는 OSI 3, 4계층(IP와 포트)에서 TCP, UDP, SCTP 트래픽을 제어합니다. 문서가 먼저 못 박는 전제는 둘입니다.

- 네트워크 플러그인이 NetworkPolicy를 지원해야 합니다. 구현하는 컨트롤러 없이 NetworkPolicy를 만들면 아무 효과가 없습니다.
- 기본 상태의 Pod는 Ingress와 Egress 양쪽 모두 격리되지 않은(non-isolated) 상태이고 모든 연결이 허용됩니다.

격리 규칙은 방향마다 따로 적용됩니다.

| 조건 | 결과 |
|---|---|
| 어떤 NetworkPolicy가 Pod를 선택하고 `policyTypes`에 `Ingress`가 있다 | 그 Pod는 Ingress 격리. 노드에서 오는 연결과 정책의 `ingress` 목록이 허용한 연결만 들어온다 |
| 어떤 NetworkPolicy가 Pod를 선택하고 `policyTypes`에 `Egress`가 있다 | 그 Pod는 Egress 격리. 정책의 `egress` 목록이 허용한 연결만 나간다 |
| 정책이 여러 개 | 허용 범위의 합집합. 순서와 충돌이 없다 |
| A에서 B로 가는 연결 | A의 Egress와 B의 Ingress가 둘 다 허용해야 성립 |
| 허용된 연결의 응답 패킷 | 암묵적으로 허용 |

정책은 더하기만 됩니다. 문서의 "할 수 없는 것" 목록에 "명시적으로 거부하는 정책"이 들어 있습니다. 어떤 연결을 막으려면 그 Pod를 격리한 뒤 필요한 연결만 허용합니다.

`policyTypes`를 생략하면 `Ingress`는 항상 들어가고 `Egress`는 정책에 egress 규칙이 있을 때만 들어갑니다. 의도를 분명히 하려고 시험에서는 항상 적습니다.

### 2-2. 선택자 네 가지와 AND/OR

`from`(ingress)과 `to`(egress)에 쓸 수 있는 선택자는 문서 기준 네 가지입니다.

| 선택자 | 고르는 대상 |
|---|---|
| `podSelector` | 정책과 같은 네임스페이스의 Pod |
| `namespaceSelector` | 고른 네임스페이스의 모든 Pod |
| `namespaceSelector`와 `podSelector`를 한 항목에 | 고른 네임스페이스 안의 고른 Pod (AND) |
| `ipBlock` | CIDR 대역. `except`로 일부 제외 |

AND와 OR는 YAML의 대시(`-`) 하나로 갈립니다. 문서의 예를 쇼핑몰로 옮기면 이렇습니다.

```yaml
# AND: 라벨 team=checkout인 네임스페이스 안의 app=order-api Pod만 허용
ingress:
- from:
  - namespaceSelector:
      matchLabels:
        team: checkout
    podSelector:
      matchLabels:
        app: order-api
```

```yaml
# OR: (정책과 같은 네임스페이스의 app=order-api Pod) 또는 (team=checkout 네임스페이스의 모든 Pod)
ingress:
- from:
  - namespaceSelector:
      matchLabels:
        team: checkout
  - podSelector:
      matchLabels:
        app: order-api
```

헷갈리면 문서 권고대로 `kubectl describe networkpolicy <이름>`으로 쿠버네티스가 어떻게 해석했는지 읽습니다.

네임스페이스를 이름으로 직접 지정하는 필드는 없습니다. 대신 컨트롤 플레인이 모든 네임스페이스에 바꿀 수 없는 라벨 `kubernetes.io/metadata.name=<네임스페이스 이름>`을 붙이므로 이 라벨로 고릅니다. 과제가 "네임스페이스 payment에서 오는 트래픽만"이라고 하면 네임스페이스에 라벨을 새로 붙일 필요 없이 이 라벨을 씁니다.

### 2-3. 기본 정책 다섯 가지

문서에 있는 기본 정책들입니다. `kubectl create networkpolicy` 같은 생성 명령이 없어서(kubectl create 하위 명령 목록에 NetworkPolicy가 없습니다) 문서 예제를 복사해 고치는 것이 가장 빠릅니다.

```yaml
# 네임스페이스 shop의 모든 Pod에 대해 들어오는 트래픽 기본 거부
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-ingress
  namespace: shop
spec:
  podSelector: {}        # 빈 선택자 = 네임스페이스의 모든 Pod
  policyTypes:
  - Ingress
```

| 이름(문서 기준) | `podSelector` | `policyTypes` | 규칙 |
|---|---|---|---|
| Default deny all ingress | `{}` | `Ingress` | 없음 |
| Allow all ingress | `{}` | `Ingress` | `ingress: [{}]` |
| Default deny all egress | `{}` | `Egress` | 없음 |
| Allow all egress | `{}` | `Egress` | `egress: [{}]` |
| Default deny all ingress and egress | `{}` | `Ingress`, `Egress` | 없음 |

규칙 필드가 아예 없으면 아무것도 허용하지 않고 빈 규칙 `{}` 하나가 있으면 모든 것을 허용합니다. 이 차이가 시험에서 자주 나옵니다.

### 2-4. Egress를 막으면 DNS도 막힌다

문서는 Default deny all egress 아래에 주의 문구를 둡니다. 모든 Egress를 막는 정책은 DNS 트래픽도 막으므로 이름 해석이 필요하면 클러스터 DNS로 나가는 Egress를 따로 허용해야 합니다. 쇼핑몰의 주문 API가 결제 서비스만 호출하도록 막는 정책을 DNS 허용과 함께 쓰면 이렇습니다.

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: order-api-egress
  namespace: shop
spec:
  podSelector:
    matchLabels:
      app: order-api
  policyTypes:
  - Egress
  egress:
  - to:                              # 결제 Pod의 8080만
    - podSelector:
        matchLabels:
          app: payment
    ports:
    - protocol: TCP
      port: 8080
  - to:                              # CoreDNS (kube-system의 k8s-app=kube-dns)
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: kube-system
      podSelector:
        matchLabels:
          k8s-app: kube-dns
    ports:
    - protocol: UDP
      port: 53
    - protocol: TCP
      port: 53
```

`k8s-app: kube-dns`는 Debugging DNS Resolution 문서가 밝힌 CoreDNS Pod의 라벨입니다. 두 번째 `to` 항목에서 `namespaceSelector`와 `podSelector`가 한 항목에 있으므로 AND입니다.

### 2-5. 그 밖에 문서가 적어 둔 동작

| 항목 | 문서 내용 |
|---|---|
| 포트 범위 | `endPort`로 범위 지정(v1.25 stable). `port`가 있어야 하고 둘 다 숫자여야 하며 `endPort`가 더 크거나 같아야 한다 |
| 노드 트래픽 | Pod가 실행 중인 노드와의 트래픽은 IP와 상관없이 항상 허용 |
| 자기 자신 | Pod는 자기 자신으로의 접근을 막을 수 없다 |
| ICMP 등 | deny all이 보장하는 것은 TCP, UDP, SCTP뿐. ICMP 동작은 플러그인마다 다르다 |
| hostNetwork Pod | 동작은 정의되지 않음. 가장 흔한 구현은 노드 IP 트래픽처럼 취급 |
| 기존 연결 | 정책이 바뀔 때 이미 맺어진 연결에 반영되는지는 구현마다 다르다 |
| 적용 시점 | 새 정책이 처리되기 전에 만들어진 Pod는 잠시 보호 없이 시작할 수 있다 |

### 2-6. 자주 틀리는 지점

- `podSelector: {}`와 `podSelector`에 라벨을 쓴 것을 헷갈립니다. 정책이 적용될 Pod를 고르는 `spec.podSelector`와 허용할 상대를 고르는 `from[].podSelector`는 자리가 다릅니다.
- AND를 써야 할 곳에 대시를 하나 더 넣어 OR로 만들면 허용 범위가 크게 넓어집니다. 채점은 결과로 하므로 "허용돼야 할 것"과 "막혀야 할 것"을 둘 다 시험해 봅니다.
- `ports`를 `from`과 같은 수준에 써야 하는데 `from` 항목 안으로 들여 쓰면 검증에서 걸리거나 의도와 다르게 해석됩니다. 들여쓰기는 문서 예제 그대로 따라갑니다.
- 과제가 Ingress 제한만 요구하는데 `policyTypes`에 `Egress`를 넣으면 그 Pod의 바깥 연결까지 막힙니다.

### 2-7. 직접 해 보기

1. `shop` 네임스페이스에 Default deny all ingress를 적용하고 임시 Pod에서 `order-api`로 요청해 타임아웃이 나는지 봅니다.
2. `app=board` Pod에서는 `order-api`의 80번으로 들어올 수 있게 정책을 하나 더 만들고 같은 요청을 `board` 라벨을 붙인 임시 Pod(`kubectl run tmp --labels=app=board ...`)와 라벨 없는 임시 Pod에서 각각 보내 결과를 비교합니다.
3. 2-4의 Egress 정책에서 DNS 항목을 지운 뒤 `order-api` Pod 안에서 `nslookup payment`가 실패하는지 확인하고 되돌립니다.

## 3. ClusterIP, NodePort, LoadBalancer와 엔드포인트

### 3-1. Service가 필요한 이유

Service 문서의 정의는 "하나 이상의 Pod로 실행되는 네트워크 애플리케이션을 노출하는 방법"입니다. Pod는 언제든 사라지고 IP가 바뀌므로, 클라이언트가 안정적으로 부를 수 있는 이름과 가상 IP를 앞에 둡니다. 동작은 두 단계로 나뉩니다.

1. 컨트롤 플레인의 컨트롤러가 Service의 selector에 맞는 Pod를 계속 찾아 EndpointSlice에 기록합니다.
2. 각 노드의 서비스 프록시(기본은 kube-proxy)가 Service와 EndpointSlice를 감시하다가 Service IP로 가는 트래픽을 백엔드 Pod로 보내도록 데이터 플레인을 설정합니다.

### 3-2. 포트 세 개

| 필드 | 의미 |
|---|---|
| `port` | Service가 받는 포트 |
| `targetPort` | 트래픽을 보낼 Pod의 포트. 생략하면 `port`와 같다. 숫자 또는 Pod 포트의 이름 |
| `nodePort` | NodePort와 LoadBalancer 타입에서 모든 노드가 여는 포트 |

`targetPort`에 이름을 쓰면 Pod 버전마다 실제 포트 번호가 달라도 Service를 바꾸지 않아도 된다고 문서는 설명합니다. 프로토콜 기본값은 TCP입니다.

### 3-3. 타입 네 가지

| 타입 | 동작(문서 기준) | 메모 |
|---|---|---|
| `ClusterIP` | 클러스터 내부 IP로만 노출. `type`을 생략하면 이것 | `clusterIP: None`이면 headless |
| `NodePort` | 모든 노드 IP의 같은 고정 포트로 노출. ClusterIP도 함께 만든다 | 기본 범위 30000-32767 (`--service-node-port-range`) |
| `LoadBalancer` | 외부 로드밸런서로 노출. 쿠버네티스는 로드밸런서를 직접 제공하지 않는다 | 보통 NodePort를 먼저 만들고 cloud-controller-manager가 LB를 그 포트로 연결 |
| `ExternalName` | `spec.externalName`의 DNS 이름으로 CNAME 응답. 프록시 없음 | selector 없음 |

`type` 필드는 앞 단계 위에 기능을 더하는 중첩 구조라고 문서는 설명합니다. NodePort는 ClusterIP를 포함하고 LoadBalancer는 보통 NodePort를 포함합니다. 예외는 `spec.allocateLoadBalancerNodePorts: false`로 노드 포트 할당을 끈 LoadBalancer입니다.

LoadBalancer Service를 만들 수 있는 클라우드가 없는 클러스터(kubeadm으로 만든 연습 클러스터 같은 곳)에서는 외부 IP가 채워지지 않고 `<pending>`으로 남는 것으로 알려져 있습니다. 이 출력은 문서에서 확인하지 못했고 문서는 LB 생성이 비동기로 일어나며 결과가 `.status.loadBalancer`에 기록된다고만 적습니다.

### 3-4. 명령으로 만들기

시험에서는 `kubectl expose`가 가장 빠릅니다. 대상 리소스의 selector를 그대로 가져와 새 Service의 selector로 쓰기 때문입니다(kubectl expose 레퍼런스).

```bash
# ClusterIP: 주문 API Deployment를 80 -> 8080으로
kubectl -n shop expose deployment order-api --port=80 --target-port=8080

# NodePort: 노드 포트 번호는 자동 할당
kubectl -n shop expose deployment board --name=board-np --type=NodePort --port=80 --target-port=8080

# 특정 노드 포트가 필요하면 YAML을 뽑아 nodePort를 넣고 적용
kubectl -n shop expose deployment board --name=board-np --type=NodePort --port=80 \
  --target-port=8080 --dry-run=client -o yaml > board-np.yaml
# board-np.yaml의 ports[0]에 nodePort: 30080 추가 후
kubectl apply -f board-np.yaml
```

`kubectl create service nodeport <이름> --tcp=80:8080 --node-port=30080`도 있습니다. 다만 레퍼런스의 옵션 표에 selector를 지정하는 옵션이 없고 kubectl 소스(`create_service.go`)를 보면 selector를 `app: <Service 이름>`으로 고정해 넣습니다. Pod 라벨이 `app=<같은 이름>`이 아니면 엔드포인트가 비니 만든 뒤 `kubectl get svc <이름> -o yaml`로 selector를 확인하고 필요하면 `kubectl set selector`나 `edit`으로 고칩니다. `kubectl expose`에는 `--selector`, `--session-affinity`, `--cluster-ip` 옵션이 있습니다.

### 3-5. EndpointSlice

EndpointSlice는 Service 뒤 엔드포인트의 일부(slice)를 담는 객체이고 v1.21에 stable이 됐습니다. 문서 기준 사실을 모으면 다음과 같습니다.

| 항목 | 내용 |
|---|---|
| 크기 | 기본으로 한 슬라이스에 엔드포인트 100개까지. kube-controller-manager의 `--max-endpoints-per-slice`로 최대 1000까지 조정 |
| Service와 연결 | 라벨 `kubernetes.io/service-name: <Service 이름>` |
| 조건 | `serving`, `terminating`, `ready`. `ready`는 사실상 "serving이고 terminating이 아님" |
| 옛 Endpoints API | v1.33부터 사용 중단. 듀얼스택 미지원, 1000개 넘으면 잘림 |

```bash
kubectl -n shop get endpointslices -l kubernetes.io/service-name=order-api
```

Debug Services 문서에 실린 출력 모양은 아래와 같습니다(문서 예시이고 이 글에서 실행한 결과는 아닙니다).

```
NAME              ADDRESSTYPE   PORTS   ENDPOINTS
hostnames-ytpni   IPv4          9376    10.244.0.5,10.244.0.6,10.244.0.7
```

ENDPOINTS가 `<none>`이면 Service의 `spec.selector`가 Pod의 `metadata.labels`를 실제로 고르는지 확인하라고 같은 문서는 적습니다. selector는 맞는데 비어 있다면 Pod가 Ready가 아닌지 봅니다. `ready` 조건은 Pod의 Ready 조건에 대응하므로 readiness probe가 실패하는 Pod는 트래픽을 받지 않습니다.

### 3-6. selector 없는 Service

외부 DB나 다른 네임스페이스의 서비스를 Service 이름으로 부르고 싶을 때는 selector 없이 Service를 만들고 EndpointSlice를 직접 씁니다. 이때는 EndpointSlice가 자동으로 생기지 않습니다.

```yaml
apiVersion: v1
kind: Service
metadata:
  name: legacy-payment
  namespace: shop
spec:
  ports:
  - name: http
    protocol: TCP
    port: 80
    targetPort: 9376
---
apiVersion: discovery.k8s.io/v1
kind: EndpointSlice
metadata:
  name: legacy-payment-1
  namespace: shop
  labels:
    kubernetes.io/service-name: legacy-payment   # 이 라벨로 Service와 연결
addressType: IPv4
ports:
- name: http          # Service 포트 이름과 맞춘다
  protocol: TCP
  port: 9376
endpoints:
- addresses:
  - "10.4.5.6"
```

문서의 제약은 두 가지입니다. 엔드포인트 IP로 루프백(127.0.0.0/8)이나 링크 로컬(169.254.0.0/16 등)은 쓸 수 없고 다른 Service의 클러스터 IP도 쓸 수 없습니다. 직접 관리하는 EndpointSlice에는 `endpointslice.kubernetes.io/managed-by` 라벨에 `controller` 이외의 값을 넣으라고 권합니다.

### 3-7. 트래픽 정책과 세션 고정

| 필드 | 값 | 동작 |
|---|---|---|
| `internalTrafficPolicy` | `Cluster`, `Local` | `Local`이면 같은 노드의 Ready 엔드포인트로만. 없으면 kube-proxy가 버린다 |
| `externalTrafficPolicy` | `Cluster`, `Local` | 외부 트래픽에 같은 규칙. `Local`이고 노드에 엔드포인트가 없으면 전달하지 않는다 |
| `sessionAffinity` | `None`(기본), `ClientIP` | `ClientIP`면 같은 클라이언트 IP를 같은 Pod로 |
| `sessionAffinityConfig.clientIP.timeoutSeconds` | 기본 10800 | 3시간 |

### 3-8. 자주 틀리는 지점

- `targetPort`를 Service `port`와 같다고 착각합니다. 컨테이너가 8080에서 듣는데 `targetPort`를 생략하면 80으로 갑니다.
- 숫자 포트를 문자열 `"8080"`으로 쓰면 이름으로 해석될 수 있습니다. Debug Services 문서의 점검 목록에 "숫자 포트를 의도했다면 숫자인지 문자열인지" 항목이 있습니다.
- NodePort를 범위 밖 번호로 지정하면 API 요청이 실패합니다. 기본 범위는 30000-32767입니다.
- 환경 변수로 Service를 찾는 방식은 Service를 클라이언트 Pod보다 먼저 만들어야 변수가 채워진다고 Service 문서가 적습니다. DNS로 찾으면 이 순서 문제가 없습니다.

### 3-9. 직접 해 보기

1. `order-api` Deployment를 ClusterIP Service로 노출하고 `kubectl get endpointslices`로 Pod 수만큼 IP가 있는지 확인합니다.
2. Deployment의 Pod 템플릿 라벨을 `app=order-api-v2`로 바꿔 ENDPOINTS가 비는 것을 관찰하고 Service selector를 고쳐 되돌립니다.
3. `board`를 NodePort 30080으로 노출하고 노드 IP와 30080으로 접속해 봅니다.

## 4. Gateway API로 Ingress 트래픽 관리

### 4-1. 왜 Gateway API인가

kubernetes.io의 Gateway API 문서는 Gateway API를 동적 인프라 프로비저닝과 고급 트래픽 라우팅을 제공하는 애드온 API 묶음으로 소개합니다. 설계 원칙 네 가지는 다음과 같습니다.

| 원칙 | 내용 |
|---|---|
| 역할 지향 | 인프라 제공자, 클러스터 운영자, 애플리케이션 개발자라는 역할에 맞춰 리소스를 나눈다 |
| 이식성 | 커스텀 리소스(CRD)로 정의되고 여러 구현체가 지원한다 |
| 표현력 | 헤더 매칭, 가중치 분배처럼 Ingress에서는 어노테이션으로만 되던 기능을 기본으로 지원 |
| 확장성 | API의 여러 계층에 커스텀 리소스를 연결할 수 있다 |

같은 문서는 Gateway API가 Ingress의 후속이며 Ingress 종류를 포함하지 않으므로 기존 Ingress를 한 번 변환해야 한다고 적습니다.

### 4-2. 리소스 모델

| 종류 | 맡는 역할(Migrating from Ingress 가이드 기준) | 하는 일 |
|---|---|---|
| GatewayClass | 가이드에 명시 없음 | 어느 컨트롤러가 Gateway를 구현하는지(`spec.controllerName`) |
| Gateway | 클러스터 운영자와 애플리케이션 관리자 | 트래픽을 받는 인스턴스. 리스너(프로토콜, 포트, 호스트 이름, TLS) |
| HTTPRoute | 애플리케이션 개발자 | 리스너로 들어온 HTTP 요청을 어떤 Service로 보낼지 |
| GRPCRoute | 가이드에 명시 없음 | gRPC 요청의 라우팅 |

Gateway 하나는 GatewayClass 정확히 하나와 연결됩니다. Route는 `parentRefs`로 Gateway를 가리키고 Gateway는 리스너의 `allowedRoutes`로 붙을 수 있는 Route를 거릅니다. 문서는 이 구조를 양방향 신뢰 모델이라고 부릅니다.

### 4-3. 최소 구성

GatewayClass의 `controllerName`은 구현체마다 다르므로 시험에서는 클러스터에 이미 있는 클래스 이름을 찾아 씁니다.

```bash
kubectl get gatewayclass
kubectl get gateway -A
kubectl get httproute -A
```

Gateway API 저장소의 타입 정의(`apis/v1/gateway_types.go`)를 보면 `kubectl get gateway`의 출력 열은 Class, Address, Programmed, Age이고 HTTPRoute는 Hostnames, Age입니다.

쇼핑몰의 `shop.example.com`으로 들어오는 요청을 경로로 나누는 구성입니다. 클래스 이름 `example-class`는 클러스터에 있는 것으로 바꿉니다.

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: shop-gw
  namespace: shop
spec:
  gatewayClassName: example-class
  listeners:
  - name: http
    protocol: HTTP
    port: 80
    hostname: "shop.example.com"
    allowedRoutes:
      namespaces:
        from: Same           # 기본값. 같은 네임스페이스의 Route만 붙는다
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: shop-route
  namespace: shop
spec:
  parentRefs:
  - name: shop-gw
  hostnames:
  - "shop.example.com"
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /orders
    backendRefs:
    - name: order-api
      port: 80
  - matches:
    - path:
        type: PathPrefix
        value: /board
    backendRefs:
    - name: board
      port: 80
```

kubectl create에는 Gateway나 HTTPRoute 생성 명령이 없어서 YAML을 씁니다. 시험에서 열 수 있는 문서 목록에 gateway-api.sigs.k8s.io가 CKA에 한해 들어 있으니(Ch-00 3-3절) 예제 위치를 미리 알아 둡니다.

### 4-4. 매칭과 가중치

HTTPRoute 타입 정의의 주석과 기본값에서 확인한 규칙입니다.

| 항목 | 규칙 |
|---|---|
| 경로 매칭 타입 | `Exact`, `PathPrefix`, `RegularExpression`. 경로 타입 기본값은 `PathPrefix` |
| `matches` 생략 | `/`에 대한 PathPrefix 매칭이 기본이라 모든 요청이 걸린다 |
| 우선순위 | Exact 경로 > 글자 수가 가장 긴 Prefix > 메서드 매칭 > 헤더 매칭 수 > 쿼리 파라미터 매칭 수. 그래도 같으면 오래된 Route, 그다음 `{namespace}/{name}` 알파벳순 |
| 매칭되는 규칙이 없을 때 | 404 |
| `backendRefs[].weight` | 기본 1. 비율로 나뉜다 |

HTTP traffic splitting 가이드는 `weight`를 비율로 해석한다고 설명하고 백엔드가 하나면 그 백엔드가 트래픽 전부를 받는다고 적습니다. 결제 서비스의 새 버전을 10%만 받게 하는 예입니다.

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: payment-canary
  namespace: shop
spec:
  parentRefs:
  - name: shop-gw
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /pay
    backendRefs:
    - name: payment-v1
      port: 8080
      weight: 90
    - name: payment-v2
      port: 8080
      weight: 10
```

### 4-5. TLS와 네임스페이스 경계

Migrating from Ingress 가이드는 TLS 종료가 Gateway 리스너의 속성이고 인증서와 키는 Secret에 둔다고 설명합니다. 리스너가 Gateway 리소스의 일부이므로 TLS 종료는 클러스터 운영자와 애플리케이션 관리자가 맡는다는 것이 가이드의 설명입니다.

```yaml
listeners:
- name: https
  port: 443
  protocol: HTTPS
  hostname: "shop.example.com"
  tls:
    mode: Terminate
    certificateRefs:
    - kind: Secret
      name: shop-example-com     # kubectl create secret tls 로 만든 Secret
```

다른 네임스페이스를 넘나드는 참조에는 두 장치가 있습니다.

- Gateway에 다른 네임스페이스의 Route를 붙이려면 리스너의 `allowedRoutes.namespaces.from`을 `All` 또는 `Selector`로 바꿉니다. Route에 쓰는 `RouteNamespaces.from`의 값은 `All`, `Selector`, `Same` 셋이고 기본은 `Same`입니다. 타입 정의에 `None`도 있지만 그 값은 ListenerSet을 거르는 `allowedListeners` 쪽 필드(기본 `None`)에만 허용됩니다.
- HTTPRoute의 `backendRefs`가 다른 네임스페이스의 Service를 가리키려면 대상 네임스페이스에 ReferenceGrant가 있어야 한다고 HTTPRoute 타입 정의의 주석이 적습니다.

### 4-6. 헤더 매칭, 필터, ReferenceGrant

HTTPRoute 과제가 경로 나누기보다 한 단계 더 들어가면 매칭 조건과 필터가 나옵니다. HTTPRoute 타입 정의(`httproute_types.go`)에서 확인한 이름과 지원 수준입니다.

| 항목 | 필드 | 지원 수준 |
|---|---|---|
| 헤더 매칭 | `matches[].headers[]`의 `name`, `value`. `type` 기본 `Exact` | Core(Exact) |
| 쿼리 매칭 | `matches[].queryParams[]` | Extended |
| 메서드 매칭 | `matches[].method` | Extended |
| 요청 헤더 바꾸기 | `filters[].type: RequestHeaderModifier`와 `requestHeaderModifier`의 `set`, `add`, `remove` | Core |
| 리다이렉트 | `RequestRedirect`. `scheme`, `hostname`, `path`, `port`, `statusCode`(기본 302, 301·302·303·307·308만) | Core |
| 경로 재작성 | `URLRewrite`. `path.type`은 `ReplaceFullPath` 또는 `ReplacePrefixMatch` | Extended |
| 응답 헤더 바꾸기, 미러링 | `ResponseHeaderModifier`, `RequestMirror` | Extended |

한 규칙 안에 `matches` 항목이 여럿이면 그중 하나만 맞아도 되고 한 항목 안의 경로, 헤더, 쿼리 조건은 모두 맞아야 합니다. NetworkPolicy의 `from`과 같은 대시 규칙이라 같이 외웁니다. `ReplacePrefixMatch`를 쓰는 규칙은 `PathPrefix` 매칭이 정확히 하나여야 한다는 검증 규칙(CEL)이 타입 정의에 있습니다.

결제 API의 새 버전을 `x-canary: "true"` 헤더가 붙은 요청에만 보내고 HTTP 요청은 HTTPS로 돌려보내는 예입니다. 리다이렉트용 Route는 HTTP 리스너에만 붙여야 하니 `parentRefs`의 `sectionName`으로 리스너를 고릅니다.

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: payment-header
  namespace: shop
spec:
  parentRefs:
  - name: shop-gw
    sectionName: https          # 4-5의 HTTPS 리스너 이름
  hostnames:
  - "shop.example.com"
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /pay
      headers:
      - name: x-canary
        value: "true"
    backendRefs:
    - name: payment-v2
      port: 8080
  - matches:
    - path:
        type: PathPrefix
        value: /pay
    filters:
    - type: RequestHeaderModifier
      requestHeaderModifier:
        add:
        - name: x-route
          value: stable
    backendRefs:
    - name: payment-v1
      port: 8080
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: http-to-https
  namespace: shop
spec:
  parentRefs:
  - name: shop-gw
    sectionName: http
  hostnames:
  - "shop.example.com"
  rules:
  - filters:
    - type: RequestRedirect
      requestRedirect:
        scheme: https
        statusCode: 301
```

다른 네임스페이스의 Service로 보내려면 HTTPRoute 쪽 `backendRefs`에 `namespace`를 적고 대상 네임스페이스에 ReferenceGrant를 만듭니다. gateway-api.sigs.k8s.io의 ReferenceGrant 문서는 ReferenceGrant가 자기와 같은 네임스페이스의 리소스에 대한 참조만 허용한다고 적습니다. 쇼핑몰 Route가 `billing` 네임스페이스의 결제 Service를 부르는 예입니다.

```yaml
# shop 네임스페이스의 HTTPRoute 규칙 일부
    backendRefs:
    - name: payment
      namespace: billing
      port: 8080
---
apiVersion: gateway.networking.k8s.io/v1
kind: ReferenceGrant
metadata:
  name: allow-shop-routes
  namespace: billing              # 참조되는 쪽
spec:
  from:
  - group: gateway.networking.k8s.io
    kind: HTTPRoute
    namespace: shop
  to:
  - group: ""
    kind: Service
```

v1.6.1 표준 설치 매니페스트에서 ReferenceGrant는 `v1`과 `v1beta1`이 모두 제공되고 저장 버전은 `v1beta1`입니다. 문서 예시는 `v1`을 씁니다. ReferenceGrant가 없으면 Route의 `ResolvedRefs` 조건이 `False`가 되고 사유는 `RefNotPermitted`입니다(공통 타입 정의의 `RouteReasonRefNotPermitted`). 리스너 쪽에서 막히면 `Accepted` 조건에 `NotAllowedByListeners`나 `NoMatchingListenerHostname`이 보입니다.

```bash
kubectl -n shop describe httproute payment-header     # Conditions의 Accepted, ResolvedRefs
kubectl -n shop get httproute payment-header -o jsonpath='{range .status.parents[*].conditions[*]}{.type}={.status} {.reason}{"\n"}{end}'
kubectl get referencegrant -A
```

### 4-7. Ingress에서 옮기기

| Ingress | Gateway API |
|---|---|
| IngressClass | GatewayClass (가이드 예시는 같은 이름 `prod`를 둘 다 쓴다) |
| Ingress의 진입점과 `tls` | Gateway 리스너 |
| Ingress의 `rules` | HTTPRoute `rules` |
| `pathType: Prefix` | `type: PathPrefix` |
| `defaultBackend` | 대응 필드 없음. `/` PathPrefix 규칙을 직접 만든다 |
| 컨트롤러별 어노테이션 | 리다이렉트, 헤더 수정, 트래픽 분할, 헤더와 쿼리와 메서드 매칭은 HTTPRoute 기본 기능 |

가이드는 Ingress를 HTTPRoute로 바꿔 주는 ingress2gateway 프로젝트도 소개하면서 변환 결과는 항상 시험하고 검증하라고 적습니다. `Exact`를 `Exact`로 옮기는 매핑은 가이드에 표로 나오지 않았습니다. HTTPRoute 타입 정의에 `Exact`가 있어서 그대로 쓰면 된다고 보지만 가이드 문구로 확인한 것은 아닙니다.

### 4-8. 자주 틀리는 지점

- Gateway API는 CRD라서 설치되어 있지 않으면 `kubectl get gateway`가 "리소스 타입을 모른다"는 오류를 냅니다. Getting started 가이드의 설치 명령은 `kubectl apply --server-side -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.6.1/standard-install.yaml`입니다(2026년 10월 20일 가이드 기준). 같은 날 GitHub 릴리스 목록의 최신 안정 패치는 v1.6.3(2026-10-06)이었습니다. v1.6 표준 설치에는 GatewayClass, Gateway, HTTPRoute, GRPCRoute 외에 ListenerSet, TLSRoute, TCPRoute, UDPRoute, BackendTLSPolicy, ReferenceGrant CRD가 들어 있습니다. CRD만 있고 구현체가 없으면 Gateway가 Programmed 상태가 되지 않습니다.
- HTTPRoute의 `parentRefs`에 Gateway 이름을 틀리게 적으면 Route가 붙지 않습니다. `kubectl describe httproute`의 상태 조건 `Accepted`와 `ResolvedRefs`를 봅니다.
- `hostnames`가 Gateway 리스너의 `hostname`과 겹치지 않으면 요청이 이 Route로 오지 않습니다.
- Route가 다른 네임스페이스에 있는데 `allowedRoutes`가 기본값 `Same`이면 붙지 않습니다.

### 4-9. 직접 해 보기

1. 연습 클러스터에 Gateway API CRD와 구현체 하나를 설치하고 `kubectl get gatewayclass`로 클래스 이름을 확인합니다.
2. 4-3의 Gateway와 HTTPRoute를 적용하고 `curl -H "Host: shop.example.com" http://<Gateway 주소>/orders`로 주문 API까지 가는지 봅니다.
3. 4-4의 가중치 Route를 만들고 같은 요청을 100번 보내 v2 응답 비율을 셉니다.
4. 4-6의 헤더 매칭 Route를 적용하고 `curl -H "x-canary: true"` 유무로 응답이 갈리는지, ReferenceGrant를 지웠을 때 `ResolvedRefs`가 어떻게 바뀌는지 봅니다.

## 5. Ingress 컨트롤러와 Ingress 리소스

### 5-1. 현재 위치

Ingress 문서와 Ingress Controllers 문서는 첫머리에 같은 안내를 둡니다. 쿠버네티스 프로젝트는 Ingress 대신 Gateway를 권하고 Ingress API는 동결됐습니다. 동결의 뜻은 두 가지입니다.

- Ingress는 GA이고 GA API의 안정성 보장을 받으며 제거 계획이 없습니다.
- 더 이상 개발하지 않고 변경도 없습니다.

컨트롤러 쪽 소식도 있습니다. Kubernetes 블로그의 "Ingress NGINX Retirement: What You Need to Know"(2025년 11월 11일, SIG Network와 Security Response Committee)는 Ingress NGINX 프로젝트의 best-effort 유지보수가 2026년 3월까지이고 그 뒤로는 릴리스, 버그 수정, 보안 취약점 수정이 없다고 발표했습니다. 같은 글이 정리한 나머지 내용은 세 가지입니다.

- 기존 Ingress NGINX 설치는 계속 동작하고 Helm 차트와 컨테이너 이미지도 계속 받을 수 있습니다. GitHub 저장소는 읽기 전용으로 남습니다.
- 대안으로 Gateway API로 옮기기를 먼저 권하고 Ingress를 계속 써야 하면 쿠버네티스 문서에 나열된 다른 Ingress 컨트롤러를 보라고 적습니다.
- 클러스터가 Ingress NGINX를 쓰는지는 관리자 권한으로 `kubectl get pods --all-namespaces --selector app.kubernetes.io/name=ingress-nginx`를 실행해 확인할 수 있다고 안내합니다.

2026년 10월 20일에 GitHub API로 본 `kubernetes/ingress-nginx` 저장소는 보관(archived) 상태였고 마지막 푸시는 2026년 3월 23일이었습니다. 발표대로 유지보수가 끝난 상태입니다.

은퇴 대상은 컨트롤러 프로젝트이고 Ingress API 자체는 위에서 본 대로 동결된 GA API로 남습니다. 2026년 10월은 유지보수 종료 뒤라 새 연습 환경을 만들 때 Ingress 컨트롤러를 무엇으로 깔지 따로 골라야 합니다. 시험 환경에 어떤 Ingress 컨트롤러가 깔려 있는지는 공식 문서에 나오지 않습니다.

### 5-2. 컨트롤러와 리소스는 별개

Ingress 리소스는 규칙만 담습니다. 규칙을 읽어 실제 프록시를 설정하는 것은 Ingress 컨트롤러이고 컨트롤러가 없으면 Ingress를 만들어도 아무 일이 일어나지 않습니다. kube-controller-manager에 포함된 컨트롤러가 아니므로 따로 설치합니다. 문서는 쿠버네티스 프로젝트가 AWS와 GCE 컨트롤러를 유지하고 나머지는 서드파티(Contour, HAProxy, Istio, Kong, NGINX, Traefik 등)라고 적습니다.

여러 컨트롤러를 둘 때는 IngressClass로 나눕니다.

| 항목 | 내용 |
|---|---|
| Ingress가 클래스를 고르는 법 | `spec.ingressClassName: <IngressClass 이름>` |
| 기본 클래스 | IngressClass에 어노테이션 `ingressclass.kubernetes.io/is-default-class: "true"` |
| 클래스를 생략하면 | 기본으로 표시된 IngressClass가 정확히 하나일 때 그 클래스가 적용된다 |
| 옛 방식 | `kubernetes.io/ingress.class` 어노테이션(문서에 "Deprecated annotation" 절이 있다) |

```bash
kubectl get ingressclass
```

### 5-3. 규칙과 pathType

각 규칙은 선택적인 `host`와 `paths` 목록으로 이루어집니다. `host`를 생략하면 모든 호스트에 적용됩니다. 경로마다 `pathType`이 반드시 있어야 하고 없으면 검증에서 실패합니다.

| `pathType` | 매칭 |
|---|---|
| `Exact` | 경로 전체가 대소문자까지 같아야 한다 |
| `Prefix` | `/`로 나눈 경로 요소 단위의 접두사. `/aaa/bb`는 `/aaa/bbb`와 매칭되지 않는다 |
| `ImplementationSpecific` | IngressClass(컨트롤러)가 정한다 |

문서 표에서 시험에 나올 만한 줄만 옮깁니다.

| 종류 | 규칙 경로 | 요청 경로 | 매칭 |
|---|---|---|---|
| Exact | `/foo` | `/foo/` | 아니오 |
| Prefix | `/foo` | `/foo`, `/foo/` | 예 |
| Prefix | `/aaa/bbb` | `/aaa/bbbxyz` | 아니오. `/`로 나눈 요소 단위로 비교 |
| Prefix | `/`, `/aaa` | `/aaa/ccc` | 예. `/aaa`가 이긴다 |
| 혼합 | `/foo`(Prefix), `/foo`(Exact) | `/foo` | 예. Exact 우선 |

여러 경로가 맞으면 가장 긴 경로가 먼저이고 길이가 같으면 Exact가 Prefix보다 먼저입니다. 어느 규칙에도 맞지 않는 요청은 `defaultBackend`로 가고 `defaultBackend`가 없으면 처리는 컨트롤러에 달려 있습니다. `rules`가 없는 Ingress는 `defaultBackend`가 반드시 있어야 합니다.

### 5-4. 명령으로 만들기

`kubectl create ingress`가 있어서 YAML을 처음부터 쓸 필요가 없습니다. 레퍼런스 예시의 규칙 문법은 `host/path=service:port[,tls[=secret]]`이고 경로 끝에 `*`를 붙이면 `pathType: Prefix`, 붙이지 않으면 `Exact`가 됩니다.

```bash
# 쇼핑몰: /orders 하위는 order-api, /board 하위는 board (둘 다 Prefix)
kubectl -n shop create ingress shop-ing --class=nginx \
  --rule="shop.example.com/orders*=order-api:80" \
  --rule="shop.example.com/board*=board:80"

# TLS: 먼저 Secret을 만들고 규칙에 tls=<Secret 이름>
kubectl -n shop create secret tls shop-tls --cert=shop.crt --key=shop.key
kubectl -n shop create ingress shop-tls-ing --class=nginx \
  --rule="shop.example.com/*=order-api:80,tls=shop-tls"

# 기본 백엔드
kubectl -n shop create ingress shop-default --class=nginx \
  --default-backend=board:80 --rule="shop.example.com/orders*=order-api:80"
```

`*` 규칙과 Exact 기본값은 레퍼런스 예시 주석("pathType as Prefix")에서 읽은 것입니다. 실제로 생성되는 YAML은 `--dry-run=client -o yaml`로 확인하고 적용합니다.

생성 결과를 YAML로 옮기면 이런 모양입니다.

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: shop-ing
  namespace: shop
spec:
  ingressClassName: nginx
  rules:
  - host: shop.example.com
    http:
      paths:
      - path: /orders
        pathType: Prefix
        backend:
          service:
            name: order-api
            port:
              number: 80
```

### 5-5. TLS

Ingress 문서 기준 TLS 규칙입니다.

- Secret에는 `tls.crt`와 `tls.key` 키가 있어야 하고 타입은 `kubernetes.io/tls`입니다.
- Ingress가 지원하는 TLS 포트는 443 하나이고 TLS는 Ingress 지점에서 끝납니다. Service와 Pod까지는 평문입니다.
- `tls` 절의 `hosts`는 `rules`의 `host`와 명시적으로 맞아야 합니다. 기본 규칙(호스트 없는 규칙)에는 TLS가 동작하지 않습니다.
- 컨트롤러마다 TLS 지원 범위가 다릅니다.

### 5-6. 경로 재작성 어노테이션 rewrite-target

Ingress 스펙에는 경로를 바꿔 전달하는 필드가 없습니다. 요청은 `/orders/123`으로 들어오는데 주문 API는 `/123`만 알아듣는 경우 컨트롤러 어노테이션으로 해결합니다. 옛 강의와 연습 문제에 자주 나오는 것은 ingress-nginx의 `nginx.ingress.kubernetes.io/rewrite-target`입니다. ingress-nginx 문서의 Rewrite 예제는 정규식 캡처 그룹을 씁니다.

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: orders-rewrite
  namespace: shop
  annotations:
    nginx.ingress.kubernetes.io/use-regex: "true"
    nginx.ingress.kubernetes.io/rewrite-target: /$2
spec:
  ingressClassName: nginx
  rules:
  - host: shop.example.com
    http:
      paths:
      - path: /orders(/|$)(.*)
        pathType: ImplementationSpecific
        backend:
          service:
            name: order-api
            port:
              number: 80
```

`(.*)`가 잡은 부분이 `$2`로 들어가서 `/orders/123`은 `/123`으로, `/orders`는 `/`로 바뀌어 전달됩니다. 정규식 경로라 `pathType`은 `ImplementationSpecific`입니다. 같은 문서는 0.22.0부터 이 어노테이션의 동작이 바뀌어 옮겨 갈 부분을 캡처 그룹으로 지정해야 한다고 적습니다. 옛 자료에 나오는 `rewrite-target: /` 한 줄짜리 예는 그 이전 동작을 전제로 한 것일 수 있으니 결과를 꼭 `curl`로 확인합니다.

이 어노테이션은 ingress-nginx 전용이고 5-1에서 본 대로 그 프로젝트는 유지보수가 끝났습니다. 다른 컨트롤러에는 다른 이름의 어노테이션이 있습니다. Gateway API에서는 HTTPRoute의 `URLRewrite` 필터(`path.type: ReplacePrefixMatch`, 4-6)가 같은 일을 표준 필드로 합니다.

```yaml
# 같은 재작성을 HTTPRoute로 (Extended 기능이라 구현체 지원 여부 확인)
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /orders
    filters:
    - type: URLRewrite
      urlRewrite:
        path:
          type: ReplacePrefixMatch
          replacePrefixMatch: /
    backendRefs:
    - name: order-api
      port: 80
```

### 5-7. 자주 틀리는 지점

- `ingressClassName`을 빼먹었는데 기본 IngressClass가 없으면 어느 컨트롤러도 이 Ingress를 처리하지 않습니다. `kubectl describe ingress`의 Address가 비어 있으면 먼저 의심합니다.
- 백엔드 Service는 Ingress와 같은 네임스페이스에 있어야 합니다. Ingress의 backend에는 네임스페이스 필드가 없습니다.
- 백엔드 포트를 Service의 `port` 대신 Pod의 `targetPort`로 적는 실수가 잦습니다. Ingress 백엔드는 Service 포트를 가리킵니다.
- 컨트롤러별 어노테이션(경로 재작성 등)은 컨트롤러 전용 설정이라 다른 컨트롤러로 옮기면 동작하지 않습니다.

### 5-8. 직접 해 보기

1. `kubectl get ingressclass`로 기본 클래스가 있는지 보고 없으면 하나에 기본 어노테이션을 붙입니다.
2. 5-4의 첫 명령으로 Ingress를 만들고 `curl -H "Host: shop.example.com" http://<컨트롤러 주소>/orders/123`이 주문 API로 가는지 확인합니다.
3. 같은 Ingress를 4절의 Gateway와 HTTPRoute로 옮겨 보고 두 YAML의 줄 수와 위치를 비교합니다.

## 6. CoreDNS

### 6-1. 어떻게 붙어 있나

Customizing DNS Service 문서 기준으로 정리합니다.

| 항목 | 내용 |
|---|---|
| 정체 | 클러스터 DNS로 쓰는 범용 권한 DNS 서버. 플러그인 구조 |
| Service 이름 | `kube-dns` (`kube-system`). 옛 kube-dns 이름에 기대는 워크로드와의 호환을 위해 |
| Pod 라벨 | `k8s-app=kube-dns` |
| 설정 | `kube-system`의 ConfigMap `coredns`에 든 Corefile |
| Pod가 DNS 서버를 아는 방법 | kubelet의 `--cluster-dns=<DNS Service IP>`가 각 컨테이너에 전달 |
| 클러스터 도메인 | kubelet의 `--cluster-domain=<도메인>`. 문서 예시는 `cluster.local` |

kubeadm 클러스터에서는 이 값들이 kubelet 설정 파일(`/var/lib/kubelet/config.yaml`)에 들어갑니다(Configuring each kubelet in your cluster using kubeadm). 파일 안의 필드 이름은 이번에 확인하지 않았습니다.

### 6-2. 무엇이 어떤 이름을 받나

DNS for Services and Pods 문서 기준입니다.

| 대상 | 이름 | 응답 |
|---|---|---|
| 일반 Service | `<svc>.<ns>.svc.<cluster-domain>` | A/AAAA, 클러스터 IP |
| headless Service | 같음 | 백엔드 Pod IP 전부 |
| 이름 붙은 포트 | `_<port-name>._<protocol>.<svc>.<ns>.svc.<cluster-domain>` | SRV |
| ExternalName Service | `<svc>.<ns>.svc.<cluster-domain>` | CNAME |
| Pod(hostname과 subdomain 지정, 같은 이름의 headless Service 존재) | `<hostname>.<subdomain>.<ns>.svc.<cluster-domain>` | A/AAAA |
| Pod IP 기반 이름 | `<a-b-c-d>.<ns>.pod.<cluster-domain>` (IP의 점을 대시로) | A |

마지막 줄은 IP가 `172.17.0.3`인 `default` 네임스페이스 Pod라면 `172-17-0-3.default.pod.cluster.local`이 됩니다. 문서는 이 형식을 DNS 명세가 생기기 전 kube-dns의 해석 방식으로 소개합니다. CoreDNS에서는 `kubernetes` 플러그인의 `pods` 설정이 이 레코드를 정합니다. coredns.io 문서 기준 `pods`의 기본값은 `disabled`라서 이 이름에 응답하지 않습니다. 6-4의 기본 Corefile처럼 `pods insecure`가 들어 있으면 Pod가 실제로 있는지 확인하지 않고 이름의 IP를 그대로 A 레코드로 돌려줍니다. 그래서 "Pod 레코드는 기본으로 안 생긴다"와 "기본으로 풀린다"는 설명이 둘 다 돌아다닙니다. 시험에서는 `coredns` ConfigMap의 `pods` 줄을 보고 판단합니다. Pod 이름 자체로 부르는 레코드는 없고 이름으로 부르려면 위 표의 hostname, subdomain, headless Service 조합이 필요합니다.

`<cluster-domain>`은 kubelet의 `--cluster-domain`(설정 파일의 `clusterDomain`) 값이고 `cluster.local`은 흔히 쓰는 값일 뿐입니다. kubelet이 Pod에 넣는 DNS 서버 주소도 kubelet 설정의 `clusterDNS` 값을 그대로 옮겨 적은 것입니다. 이 값과 `kube-dns` Service의 클러스터 IP가 어긋나면 Pod의 DNS가 엉뚱한 IP를 봅니다.

kubelet이 Pod에 써 주는 `/etc/resolv.conf`의 모양은 문서 예시로 이렇습니다.

```
nameserver 10.32.0.10
search <namespace>.svc.cluster.local svc.cluster.local cluster.local
options ndots:5
```

`search` 덕분에 같은 네임스페이스에서는 `payment`만으로, 다른 네임스페이스에서는 `payment.billing`처럼 짧게 부를 수 있습니다. 네임스페이스를 빼고 부르면 자기 네임스페이스에서만 찾습니다. `shop`의 Pod가 `billing` 네임스페이스의 `payment`를 `payment`로 부르면 응답이 없습니다.

`options ndots:5`는 resolv.conf 매뉴얼(resolv.conf(5)) 기준으로 점이 5개보다 적은 이름은 `search` 목록을 먼저 붙여 보고 그다음에 이름 그대로 질의한다는 뜻입니다. `api.example.com`(점 2개)처럼 외부 도메인을 부르면 `api.example.com.shop.svc.cluster.local` 같은 질의가 먼저 나가고 실패한 뒤에 원래 이름을 묻습니다. 외부 호출이 많은 Pod에서 DNS 질의가 몇 배로 늘어나는 이유가 이것입니다. 이름 끝에 점을 붙인 FQDN(`api.example.com.`)을 쓰거나 Pod의 `dnsConfig.options`에서 `ndots`를 낮춰 줄일 수 있습니다. 질의 하나가 실제로 어떻게 퍼지는지는 [커널 시리즈 5편](/blog/theory/systems/k8s-linux-05-service-iptables-conntrack)에서 다룹니다.

Pod는 대개 Ready여야 DNS 레코드를 받습니다. Service에 `publishNotReadyAddresses: true`를 주면 예외입니다.

### 6-3. dnsPolicy

| 값 | 동작 |
|---|---|
| `ClusterFirst` | 클러스터 도메인에 맞지 않는 질의는 업스트림으로 전달. `dnsPolicy`를 생략하면 이것 |
| `Default` | Pod가 실행 중인 노드의 이름 해석 설정을 물려받는다. 이름과 달리 기본값이 아니다 |
| `ClusterFirstWithHostNet` | `hostNetwork: true` Pod가 클러스터 DNS를 쓰려면 명시. 안 하면 `Default`처럼 동작 |
| `None` | 쿠버네티스 DNS 설정을 무시하고 `dnsConfig`로 전부 지정 |

### 6-4. 기본 Corefile 읽기

Customizing DNS Service 문서에 실린 기본 Corefile입니다.

```
.:53 {
    errors
    health {
        lameduck 5s
    }
    ready
    kubernetes cluster.local in-addr.arpa ip6.arpa {
        pods insecure
        fallthrough in-addr.arpa ip6.arpa
        ttl 30
    }
    prometheus :9153
    forward . /etc/resolv.conf
    cache 30
    loop
    reload
    loadbalance
}
```

| 플러그인 | 역할(문서와 coredns.io 기준) |
|---|---|
| `errors` | 오류를 stdout에 기록 |
| `health` | `http://localhost:8080/health`로 상태 보고. `lameduck 5s`는 종료 전 5초 동안 unhealthy로 둔다 |
| `ready` | 8181 포트에서 준비되면 200 |
| `kubernetes` | Service와 Pod IP로 응답. `ttl` 기본 5초, 0~3600초. `pods insecure`는 kube-dns 호환용 |
| `prometheus` | `:9153/metrics` |
| `forward` | 클러스터 도메인 밖의 질의를 `/etc/resolv.conf`의 리졸버로 |
| `cache` | 프런트엔드 캐시 |
| `loop` | 단순 전달 루프를 감지하면 CoreDNS 프로세스를 멈춘다 |
| `reload` | Corefile이 바뀌면 자동 재적재. ConfigMap 수정 후 반영까지 2분 정도 |
| `loadbalance` | A, AAAA, MX 응답 순서를 무작위로 |

coredns.io의 kubernetes 플러그인 문서는 `fallthrough`를 이렇게 설명합니다. 원래 플러그인 영역의 질의가 NXDOMAIN이면 그 응답이 최종이지만 `fallthrough`가 있으면 다음 플러그인으로 넘깁니다. 같은 문서는 `pods`의 기본값이 `disabled`이고 `insecure`는 요청의 IP로 확인 없이 A 레코드를 돌려준다고 적습니다.

### 6-5. 설정 바꾸기

특정 도메인만 다른 DNS 서버로 보내는 stub 도메인과 업스트림 변경은 `forward` 플러그인으로 합니다. 쇼핑몰 사내 도메인 `corp.example`을 10.150.0.1로 보내는 예입니다(문서의 Consul 예시를 바꾼 것).

```bash
kubectl -n kube-system edit configmap coredns
```

```
corp.example:53 {
    errors
    cache 30
    forward . 10.150.0.1
}
```

이 블록을 기존 `.:53 { ... }` 블록 옆에 추가합니다. 클러스터 밖 질의를 모두 특정 서버로 보내려면 기존 블록의 `forward . /etc/resolv.conf`를 `forward . 172.16.0.1`처럼 바꿉니다. `reload` 플러그인이 있으면 재시작 없이 반영되지만 시간이 걸리므로 급하면 `kubectl -n kube-system rollout restart deployment coredns`로 다시 띄웁니다. Troubleshooting kubeadm 문서의 예시 명령도 `kube-system`의 `deployment coredns`를 대상으로 합니다. 다른 방식으로 설치한 클러스터라면 `kubectl -n kube-system get deploy`로 이름부터 확인합니다.

### 6-6. DNS 문제를 좁히는 순서

Debugging DNS Resolution 문서의 순서를 그대로 따릅니다.

| 단계 | 명령 | 볼 것 |
|---|---|---|
| 1. 시험용 Pod | `kubectl apply -f https://k8s.io/examples/admin/dns/dnsutils.yaml` | `dnsutils` Pod가 Running |
| 2. 이름 해석 | `kubectl exec -i -t dnsutils -- nslookup kubernetes.default` | 실패하면 다음 단계 |
| 3. resolv.conf | `kubectl exec -ti dnsutils -- cat /etc/resolv.conf` | nameserver가 `kube-dns` IP인지, search 경로 |
| 4. CoreDNS Pod | `kubectl get pods -n kube-system -l k8s-app=kube-dns` | Running 여부 |
| 5. CoreDNS 로그 | `kubectl logs -n kube-system -l k8s-app=kube-dns` | 이상 메시지 |
| 6. Service | `kubectl get svc -n kube-system` | `kube-dns`의 53/UDP, 53/TCP |
| 7. 엔드포인트 | `kubectl get endpointslice -l kubernetes.io/service-name=kube-dns -n kube-system` | CoreDNS Pod IP가 있는지 |
| 8. 질의 수신 | Corefile에 `log` 추가 후 로그 확인 | 질의가 CoreDNS까지 오는지 |
| 9. 권한 | CoreDNS ServiceAccount의 RBAC | Service와 EndpointSlice를 list할 수 있는지 |

### 6-7. 자주 틀리는 지점

- `dnsPolicy: Default`를 "기본값"으로 읽는 실수. 생략 시 기본은 `ClusterFirst`입니다.
- NetworkPolicy로 Egress를 막은 네임스페이스에서 DNS가 안 되는 것을 CoreDNS 장애로 오해합니다. 2-4절의 DNS 허용 규칙부터 확인합니다.
- Corefile 수정 중 중괄호를 하나 잃으면 CoreDNS가 시작하지 못해 `CrashLoopBackOff`에 빠집니다. 수정 전에 ConfigMap을 파일로 백업합니다.
- `loop` 플러그인은 루프를 감지하면 CoreDNS를 멈춥니다. Troubleshooting kubeadm 문서는 CoreDNS가 `CrashLoopBackOff`에 빠지는 원인 하나로 이 루프 감지를 들고 해결 방법은 CoreDNS 저장소의 loop 플러그인 문서로 넘깁니다. 노드의 `/etc/resolv.conf`가 로컬 캐시 주소를 가리켜 루프가 생긴다는 설명은 널리 알려져 있지만 이번에 그 문서까지 열어 확인하지는 않았습니다.

### 6-8. 직접 해 보기

1. `dnsutils` Pod에서 `nslookup order-api.shop`, `nslookup order-api.shop.svc.cluster.local`, `nslookup order-api`를 각각 실행하고 어느 것이 왜 실패하는지 설명해 봅니다.
2. `coredns` ConfigMap에 `log`를 추가하고 같은 질의가 로그에 찍히는지 확인한 뒤 되돌립니다.
3. `order-api`를 headless Service(`clusterIP: None`)로 하나 더 만들고 `nslookup` 결과가 Pod IP 여러 개로 나오는지 봅니다.
4. `coredns` ConfigMap에서 `pods` 줄을 확인하고 `dnsutils` Pod에서 `nslookup <a-b-c-d>.shop.pod.cluster.local`(존재하는 Pod IP와 존재하지 않는 IP 각각)이 어떻게 응답하는지 봅니다.

## 7. 확인 문제

직접 만든 연습 과제입니다. 시험 문항이나 덤프에서 옮긴 것이 아닙니다. 답은 접어 두었습니다.

**문제 1.** 네임스페이스 `shop`의 `app=payment` Pod는 같은 네임스페이스의 `app=order-api` Pod에서 TCP 8080으로만 들어올 수 있어야 합니다. 다른 들어오는 트래픽은 모두 막고 나가는 트래픽은 건드리지 않습니다.

<details>
<summary>답 보기</summary>

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: payment-from-order
  namespace: shop
spec:
  podSelector:
    matchLabels:
      app: payment
  policyTypes:
  - Ingress
  ingress:
  - from:
    - podSelector:
        matchLabels:
          app: order-api
    ports:
    - protocol: TCP
      port: 8080
```

`policyTypes`에 `Egress`를 넣지 않아 나가는 트래픽은 그대로입니다. 검증은 `order-api` 라벨을 붙인 임시 Pod와 라벨 없는 임시 Pod 두 개로 합니다.

</details>

**문제 2.** 아래 정책은 무엇을 허용하나요? 의도가 "billing 네임스페이스의 app=batch Pod만"이었다면 어떻게 고치나요?

```yaml
ingress:
- from:
  - namespaceSelector:
      matchLabels:
        kubernetes.io/metadata.name: billing
  - podSelector:
      matchLabels:
        app: batch
```

<details>
<summary>답 보기</summary>

`from`에 항목이 두 개라 OR입니다. billing 네임스페이스의 모든 Pod, 또는 정책과 같은 네임스페이스의 `app=batch` Pod를 허용합니다. 의도대로 하려면 두 번째 항목 앞의 대시를 지워 한 항목으로 합칩니다.

```yaml
ingress:
- from:
  - namespaceSelector:
      matchLabels:
        kubernetes.io/metadata.name: billing
    podSelector:
      matchLabels:
        app: batch
```

</details>

**문제 3.** `board` Deployment(컨테이너 포트 8080)를 이름 `board-svc`, 포트 80의 NodePort Service로 노출하고 노드 포트는 31080으로 고정합니다.

<details>
<summary>답 보기</summary>

```bash
kubectl -n shop expose deployment board --name=board-svc --type=NodePort \
  --port=80 --target-port=8080 --dry-run=client -o yaml > board-svc.yaml
# ports 항목에 nodePort: 31080 추가
kubectl apply -f board-svc.yaml
kubectl -n shop get svc board-svc
kubectl -n shop get endpointslices -l kubernetes.io/service-name=board-svc
```

31080은 기본 범위 30000-32767 안에 있습니다. 마지막 명령으로 엔드포인트가 비어 있지 않은지까지 확인합니다.

</details>

**문제 4.** `order-api` Service에 요청하면 응답이 없습니다. Service와 Pod는 모두 있고 Pod는 Running입니다. 확인 순서를 세 단계로 적으세요.

<details>
<summary>답 보기</summary>

1. `kubectl get endpointslices -l kubernetes.io/service-name=order-api`로 엔드포인트가 있는지 봅니다. 비어 있으면 selector와 Pod 라벨, Pod의 Ready 여부를 확인합니다.
2. 엔드포인트가 있으면 임시 Pod에서 Pod IP와 `targetPort`로 직접 요청해 Pod 자체가 응답하는지 봅니다. 여기서 실패하면 `targetPort`와 컨테이너 포트가 맞는지, 앱이 그 포트에서 듣는지 봅니다.
3. Pod 직접 요청은 되는데 Service IP로만 실패하면 NetworkPolicy와 kube-proxy(또는 대체 프록시) 상태를 봅니다.

</details>

**문제 5.** `shop.example.com/orders` 하위 경로를 `order-api:80`으로 보내는 HTTPRoute를 Gateway `shop-gw`(같은 네임스페이스)에 붙이세요.

<details>
<summary>답 보기</summary>

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: orders
  namespace: shop
spec:
  parentRefs:
  - name: shop-gw
  hostnames:
  - "shop.example.com"
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /orders
    backendRefs:
    - name: order-api
      port: 80
```

`kubectl describe httproute orders`에서 `Accepted`와 `ResolvedRefs` 조건이 True인지 확인합니다.

</details>

**문제 6.** 다음 Ingress 명령이 만드는 두 경로의 `pathType`은 각각 무엇인가요?

```bash
kubectl create ingress a --rule="shop.example.com/cart=cart:80" --rule="shop.example.com/pay*=payment:80"
```

<details>
<summary>답 보기</summary>

`/cart`는 `*`가 없어 `Exact`, `/pay`는 `*`가 있어 `Prefix`입니다. 레퍼런스 예시 주석을 근거로 한 답이므로 `--dry-run=client -o yaml`로 직접 확인하는 습관을 둡니다.

</details>

**문제 7.** `shop` 네임스페이스의 Pod에서 `payment.billing`은 풀리는데 `payment`는 풀리지 않습니다. 정상인가요?

<details>
<summary>답 보기</summary>

정상입니다. 네임스페이스 없이 부르면 search 목록의 첫 항목인 `shop.svc.cluster.local`부터 붙여 찾으므로 Pod 자신의 네임스페이스에서만 찾습니다. `payment`가 `billing`에 있으면 `payment.billing`처럼 네임스페이스를 붙여야 합니다.

</details>

**문제 8.** kubeadm 클러스터에서 새 워커 노드가 `NotReady`이고 그 노드에 배치된 Pod는 `ContainerCreating`에 머뭅니다. 노드에 들어가서 먼저 볼 디렉터리 두 개와 로그 두 개를 적고 이 클러스터의 Service IP 대역은 어디서 확인하는지 답하세요.

<details>
<summary>답 보기</summary>

디렉터리는 CNI 설정이 있는 `/etc/cni/net.d`와 플러그인 실행 파일이 있는 `/opt/cni/bin`입니다. 설정 파일이 없거나 `"type"`에 적힌 이름의 실행 파일이 없으면 런타임이 네트워크를 만들지 못합니다. CNI를 부르는 쪽은 컨테이너 런타임이므로 로그는 `journalctl -u containerd`와 `journalctl -u kubelet`을 봅니다. Service IP 대역은 컨트롤 플레인 노드의 `/etc/kubernetes/manifests/kube-apiserver.yaml`에 있는 `--service-cluster-ip-range`에 있고 `kubectl get servicecidrs`로도 볼 수 있습니다.

</details>

**문제 9.** `pods insecure`가 설정된 CoreDNS에서 `shop` 네임스페이스의 IP `10.244.1.23` Pod를 IP 기반 이름으로 부르면 이름은 무엇인가요? 클러스터 도메인은 `cluster.local`입니다.

<details>
<summary>답 보기</summary>

`10-244-1-23.shop.pod.cluster.local`입니다. 점을 대시로 바꾸고 Service 이름의 `svc` 자리에 `pod`가 들어갑니다. `pods`가 기본값 `disabled`이면 이 이름은 풀리지 않습니다.

</details>

## 8. 범위와 한계

- 이 글의 명령과 YAML은 문서를 읽고 정리한 것이며 이 글을 쓰는 환경에는 클러스터가 없어 직접 실행하지 않았습니다. 출력 예시는 모두 kubernetes.io 문서에 실린 것이고 그렇게 표시했습니다. 연습 클러스터를 만든 뒤 2-7, 3-9 같은 과제를 실제로 해 보고 결과를 덧붙이겠습니다.
- kubernetes.io 문서는 2026년 10월 19일에 kubernetes/website 저장소의 main 브랜치 원문으로 읽었습니다. 사이트에 게시된 현재 버전과 같은 내용이지만 시험 기준 버전(v1.37)과 문서 버전이 어긋나는 항목이 있을 수 있습니다.
- `kubectl create ingress`에서 `*` 유무에 따른 `pathType`은 레퍼런스 예시 주석으로만 확인했습니다.
- LoadBalancer Service의 `<pending>` 표시, CoreDNS `loop` 오류가 생기는 구체적인 노드 설정은 문서 본문으로 확인하지 못한 항목입니다.
- 시험 환경에 깔린 Ingress 컨트롤러와 Gateway API 구현체, CNI 플러그인 종류는 공식 문서에 없습니다. Weave Net이 시험 환경에서 다른 플러그인으로 바뀌었는지도 공식 자료로 확인하지 못했습니다.
- Flannel 단독 구성이 NetworkPolicy를 집행하지 않는다는 것은 널리 알려진 내용으로만 적었고 Flannel 문서로 확인하지 않았습니다.
- kube-proxy의 `/proxyMode` 경로는 kubernetes.io 문서에 없어서 kube-proxy 소스로 확인했습니다. containerd가 `/etc/cni/net.d`의 파일을 이름 순으로 정렬해 읽는다는 부분은 containerd 설정 문서의 `max_conf_num` 설명과 libcni 동작을 근거로 했고 실행해 보지 않았습니다. `ContainerCreating` 때 런타임 로그에 찍히는 정확한 문구는 확인하지 못했습니다.
- ingress-nginx 저장소의 보관 상태와 Weave Net의 마지막 릴리스는 2026년 10월 20일 GitHub API 응답 기준입니다.
- Gateway API는 v1.6.1 설치 명령 기준이고 HTTPRoute 규칙은 저장소 main 브랜치의 타입 정의 주석으로 확인했습니다. 구현체마다 지원 범위(Extended 기능)가 다릅니다.

## 참고 자료

시험 범위
- CNCF, [CKA Curriculum v1.37](https://github.com/cncf/curriculum/blob/master/CKA_Curriculum_v1.37.pdf)

kubernetes.io
- [Services, Load Balancing, and Networking](https://kubernetes.io/docs/concepts/services-networking/)
- [Cluster Networking](https://kubernetes.io/docs/concepts/cluster-administration/networking/)
- [Network Policies](https://kubernetes.io/docs/concepts/services-networking/network-policies/)
- [Service](https://kubernetes.io/docs/concepts/services-networking/service/)
- [EndpointSlices](https://kubernetes.io/docs/concepts/services-networking/endpoint-slices/)
- [Virtual IPs and Service Proxies](https://kubernetes.io/docs/reference/networking/virtual-ips/)
- [Gateway API](https://kubernetes.io/docs/concepts/services-networking/gateway/)
- [Ingress](https://kubernetes.io/docs/concepts/services-networking/ingress/)
- [Ingress Controllers](https://kubernetes.io/docs/concepts/services-networking/ingress-controllers/)
- [DNS for Services and Pods](https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/)
- [Customizing DNS Service](https://kubernetes.io/docs/tasks/administer-cluster/dns-custom-nameservers/)
- [Debugging DNS Resolution](https://kubernetes.io/docs/tasks/administer-cluster/dns-debugging-resolution/)
- [Debug Services](https://kubernetes.io/docs/tasks/debug/debug-application/debug-service/)
- [Troubleshooting kubeadm](https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/troubleshooting-kubeadm/)
- [Configuring each kubelet in your cluster using kubeadm](https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/kubelet-integration/)
- kubernetes/kubernetes, [staging/src/k8s.io/kubectl/pkg/cmd/create/create_service.go](https://github.com/kubernetes/kubernetes/blob/master/staging/src/k8s.io/kubectl/pkg/cmd/create/create_service.go)
- kubectl 레퍼런스: [kubectl expose](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_expose/), [kubectl create service nodeport](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_create/kubectl_create_service_nodeport/), [kubectl create ingress](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_create/kubectl_create_ingress/), [kubectl create secret tls](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_create/kubectl_create_secret_tls/)
- Kubernetes Blog, [Ingress NGINX Retirement: What You Need to Know](https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/), 2025-11-11
- [Ports and Protocols](https://kubernetes.io/docs/reference/networking/ports-and-protocols/)
- [Network Plugins](https://kubernetes.io/docs/concepts/extend-kubernetes/compute-storage-net/network-plugins/)
- 명령행 레퍼런스: [kube-proxy](https://kubernetes.io/docs/reference/command-line-tools-reference/kube-proxy/), [kube-controller-manager](https://kubernetes.io/docs/reference/command-line-tools-reference/kube-controller-manager/)
- kubernetes/kubernetes, [cmd/kubeadm/app/phases/controlplane/manifests.go](https://github.com/kubernetes/kubernetes/blob/master/cmd/kubeadm/app/phases/controlplane/manifests.go), [cmd/kube-proxy/app/server.go](https://github.com/kubernetes/kubernetes/blob/master/cmd/kube-proxy/app/server.go), [pkg/kubelet/events/event.go](https://github.com/kubernetes/kubernetes/blob/master/pkg/kubelet/events/event.go)

컨테이너 런타임과 CNI
- containerd, [docs/cri/config.md](https://github.com/containerd/containerd/blob/main/docs/cri/config.md)
- [weaveworks/weave](https://github.com/weaveworks/weave) (보관된 저장소)

Ingress 컨트롤러
- ingress-nginx, [Rewrite](https://kubernetes.github.io/ingress-nginx/examples/rewrite/), [kubernetes/ingress-nginx](https://github.com/kubernetes/ingress-nginx) (보관된 저장소)

이 시리즈의 관련 글
- [쿠버네티스 아래의 리눅스 5편: Service의 실체는 커널 규칙](/blog/theory/systems/k8s-linux-05-service-iptables-conntrack)

Gateway API
- [Getting started with Gateway API](https://gateway-api.sigs.k8s.io/guides/)
- [Migrating from Ingress](https://gateway-api.sigs.k8s.io/guides/getting-started/migrating-from-ingress/)
- [HTTP traffic splitting](https://gateway-api.sigs.k8s.io/guides/traffic-splitting/)
- [ReferenceGrant](https://gateway-api.sigs.k8s.io/reference/api-types/referencegrant/)
- kubernetes-sigs/gateway-api, [v1.6.1 standard-install.yaml](https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.6.1/standard-install.yaml), [Releases](https://github.com/kubernetes-sigs/gateway-api/releases), [apis/v1/shared_types.go](https://github.com/kubernetes-sigs/gateway-api/blob/main/apis/v1/shared_types.go)
- kubernetes-sigs/gateway-api, [apis/v1/httproute_types.go](https://github.com/kubernetes-sigs/gateway-api/blob/main/apis/v1/httproute_types.go), [apis/v1/gateway_types.go](https://github.com/kubernetes-sigs/gateway-api/blob/main/apis/v1/gateway_types.go)

CoreDNS
- CoreDNS, [kubernetes plugin](https://coredns.io/plugins/kubernetes/)

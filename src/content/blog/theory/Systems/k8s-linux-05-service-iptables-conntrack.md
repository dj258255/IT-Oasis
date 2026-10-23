---
title: '[쿠버네티스 아래의 리눅스 5] Service의 실체는 커널 규칙: iptables DNAT와 conntrack, 그리고 조용히 끊긴 DNS'
description: ClusterIP로 보낸 패킷이 netfilter 훅과 kube-proxy의 KUBE-SERVICES, KUBE-SVC, KUBE-SEP 체인을 지나 파드 IP로 DNAT되는 과정을 따라갑니다. conntrack이 첫 패킷의 결정을 기억하는 방식과, 낡은 UDP conntrack 항목 때문에 DNS가 계속 타임아웃 난 ThousandEyes 장애(SREcon26 Americas 발표)를 함께 정리합니다.
date: 2026-10-20T00:00:00.000Z
tags:
  - Kubernetes
  - Linux
  - kube-proxy
  - iptables
  - conntrack
  - netfilter
  - DNS
  - CoreDNS
category: theory/Systems
topics:
  - systems
  - distributed
draft: false
series: "쿠버네티스 아래의 리눅스"
seriesOrder: 5
---

## 결론부터

1. ClusterIP를 들고 있는 프로세스는 어디에도 없습니다. kube-proxy(iptables 모드)는 각 노드의 nat 테이블에 규칙을 써 둘 뿐입니다. 패킷을 파드 IP로 바꾸는 일은 커널의 netfilter가 합니다. 그래서 iptables 모드에서는 ClusterIP가 어떤 네트워크 인터페이스에도 붙어 있지 않습니다.
2. 규칙 사슬은 `KUBE-SERVICES`(목적지 IP와 포트로 Service 찾기) → `KUBE-SVC-*`(엔드포인트를 확률로 고르기) → `KUBE-SEP-*`(DNAT)입니다. 엔드포인트가 셋이면 확률은 1/3, 1/2이고 마지막 규칙에는 확률 매치가 없습니다.
3. nat 테이블은 연결의 첫 패킷만 봅니다. 그 뒤의 패킷은 conntrack이 기억한 변환을 그대로 따릅니다. 엔드포인트 선택은 연결 단위로 한 번만 일어납니다.
4. UDP에는 연결 종료가 없어서 conntrack 항목이 타임아웃으로만 사라집니다. 현재 커널 기본값은 단방향 30초, 양방향 흐름 120초입니다. 같은 출발지 포트로 120초 안에 계속 보내면 항목이 영영 만료되지 않습니다.
5. ThousandEyes(Cisco)의 2025년 9월 4일 장애는 이 조합으로 일어났습니다. CoreDNS 파드 OOMKilled, 사이드카 DNS 프록시의 같은 포트 재사용, 낡은 UDP 항목을 지우는 장치가 없던 kube-proxy가 겹쳤습니다. kube-proxy 쪽 수정은 v1.32(PR #127318)에 들어갔습니다.

---

이 시리즈의 [1편](/blog/theory/systems/k8s-linux-01-kernel-boundary)에서 쿠버네티스가 결국 커널 기능을 조합한다는 이야기로 시작했습니다. [2편](/blog/theory/systems/k8s-linux-02-namespaces-pause)은 파드마다 네트워크 네임스페이스와 veth가 생기는 과정을 다뤘습니다. 마지막인 이번 글은 그 네임스페이스 밖으로 나간 패킷이 Service를 만나는 지점을 봅니다. 예시는 가상의 쇼핑몰입니다. 네임스페이스 `shop`에 주문 API `order-api`가 파드 3개로 떠 있다고 가정합니다.

Service를 YAML로 만드는 법과 타입별 사용법은 [CKA Ch-04](/blog/cert/cka/cka-04-services-networking)에 정리했습니다. 여기서는 그 YAML이 노드 커널에 무엇으로 남는지를 따라갑니다.

## 1. 네트워크 기초: 주소 세 종류와 CIDR

### 1-1. 캡슐화 4계층

<details>
<summary>기초부터: 격리된 파드가 통신하는 이유와 계층별 데이터 단위</summary>

> **핵심 한 줄**: 네트워크 네임스페이스는 파드를 따로 떨어진 방으로 만들고 veth, 라우팅, netfilter가 그 방들 사이에 길을 냅니다. 길 위를 지나는 데이터는 계층마다 머리말을 하나씩 더 두릅니다.

#### 1. 왜 필요한가

2편에서 파드마다 네트워크 네임스페이스를 따로 준다고 했습니다. 격리만 있다면 파드끼리는 통신하지 못해야 합니다. 실제로 통신이 되는 것은 커널이 네임스페이스 사이를 veth로 잇고 노드의 라우팅 테이블과 netfilter 규칙으로 목적지를 정해 주기 때문입니다. 이 글은 그중 netfilter 쪽을 따라갑니다.

#### 2. 계층마다 붙는 것과 이름

| 계층 | 하는 일 | 데이터 단위 | 붙는 머리말 |
|---|---|---|---|
| 응용 | DNS 질의, HTTP 요청 같은 메시지를 만듦 | 메시지(데이터) | 없음 |
| 전송 | TCP 또는 UDP를 고르고 포트를 붙임(예: 출발 43726 → 목적 53) | TCP는 세그먼트, UDP는 데이터그램 | 포트 |
| 인터넷 | 출발지와 목적지 IP를 붙임. ClusterIP가 다뤄지는 곳 | 패킷 | IP |
| 링크 | 같은 링크 위의 다음 장비 MAC 주소를 붙임 | 프레임 | MAC |

```text
보낼 때(캡슐화):   DNS 질의 → [UDP|DNS] → [IP|UDP|DNS] → [MAC|IP|UDP|DNS]
받을 때(역캡슐화): 바깥 머리말부터 하나씩 벗겨 위 계층으로 올림
```

#### 3. 실전에서 보이는 모습

계층이 나뉘어 있으면 장애도 계층 단위로 좁힐 수 있습니다. ping은 되는데 이름 해석만 실패한다면 IP 계층까지는 길이 있고 DNS 경로(5장)나 그 경로의 conntrack 항목(4장)을 보면 됩니다. 7장의 사례가 "DNS 타임아웃"으로 범위가 좁혀진 것도 같은 방식입니다.

> **정리**: 격리를 뚫는 길은 커널이 냅니다. 그 길에서 Service가 바꾸는 머리말은 인터넷 계층의 IP와 전송 계층의 포트입니다.

</details>

패킷 한 개는 계층마다 머리말을 하나씩 덧씌운 묶음입니다. 이 글에서 바꾸는 머리말은 주로 3계층(IP)과 4계층(포트)입니다.

| 계층(TCP/IP 모델) | 머리말에 든 주소 | 이 글에서 다루는 것 |
|---|---|---|
| 링크 | MAC 주소 | Calico의 proxy ARP(6-1) |
| 인터넷 | 출발지 IP, 목적지 IP, TTL | DNAT, SNAT, TTL 감소 |
| 전송 | 출발지 포트, 목적지 포트, TCP 플래그 | 포트 변환, conntrack 튜플, handshake |
| 응용 | DNS 질의, HTTP 요청 | DNS 경로(5장) |

DNAT는 목적지 IP와 포트를, SNAT(마스커레이드 포함)는 출발지 IP와 포트를 바꿉니다. 응용 계층 데이터는 건드리지 않습니다. 그래서 주문 API 입장에서는 요청이 ClusterIP를 거쳐 왔는지 직접 왔는지 구분할 수 없습니다.

### 1-2. CIDR 계산

<details>
<summary>기초부터: IPv4 주소와 /숫자 읽는 법</summary>

> **핵심 한 줄**: IPv4 주소는 32비트이고 `/N`은 앞의 N비트가 "어느 네트워크인가"를, 나머지가 "그 안의 어느 장비인가"를 나타낸다는 표시입니다.

#### 1. 어떻게 생겼나

1. **32비트**: `10.0.1.10`은 32비트 이진수를 8비트씩 네 칸으로 끊어 10진수로 쓴 것입니다. 한 칸은 0부터 255까지입니다.
2. **두 영역**: 앞쪽은 네트워크 영역, 뒤쪽은 호스트 영역입니다.
3. **경계선**: `/N`이 그 경계선의 위치입니다. 숫자가 클수록 네트워크 쪽 비트가 늘어 담을 수 있는 주소는 줄어듭니다.

```text
10.244.0.0/16
00001010.11110100 | 00000000.00000000
  네트워크 16비트   |   호스트 16비트 → 2^16 = 65,536개
```

#### 2. 한눈에 비교

| 표기 | 고정되는 칸 | 주소 수 | 흔한 쓰임 |
|---|---|---|---|
| `10.0.0.0/8` | 첫 칸 | 16,777,216 | 큰 사설망 전체 |
| `10.244.0.0/16` | 앞 두 칸 | 65,536 | 클러스터 전체 파드 CIDR |
| `10.244.1.0/24` | 앞 세 칸 | 256(호스트 254) | 노드 하나에 나눠 준 파드 대역 |

> **정리**: `/숫자`가 1 커질 때마다 주소 수는 절반이 됩니다. 클러스터 파드 CIDR을 노드마다 `/24`로 자르는 구성이 본문의 표입니다.

</details>

CIDR 표기의 `/N`은 앞에서부터 N비트가 네트워크 부분이라는 뜻입니다. 나머지 비트 수가 주소 개수를 정합니다.

| 표기 | 호스트 비트 | 주소 수 | 메모 |
|---|---|---|---|
| `/12` | 20 | 1,048,576 | kubeadm 기본 Service CIDR `10.96.0.0/12`의 크기 |
| `/16` | 16 | 65,536 | 클러스터 전체 파드 CIDR로 흔히 쓰는 크기 |
| `/24` | 8 | 256 | 네트워크 주소와 브로드캐스트를 빼면 호스트 254개 |

노드마다 파드 CIDR을 `/24`로 나눠 주는 구성이 많습니다. 주소는 254개지만 kubelet의 기본 `maxPods`가 110이라 실제로는 그쪽 한도가 먼저 걸립니다.

### 1-3. Node IP, Pod IP, ClusterIP

<details>
<summary>기초부터: 주소를 세 종류로 나눈 이유</summary>

> **핵심 한 줄**: Pod IP는 파드가 다시 만들어질 때마다 바뀌므로 바뀌지 않는 가상 주소 ClusterIP를 앞에 세우고 커널이 그 주소를 살아 있는 Pod IP로 바꿔 줍니다(DNAT).

#### 1. 얼마나 자주 바뀌나

| 주소 | 바뀌는 때 | 맡는 역할 |
|---|---|---|
| Node IP | 노드를 교체하거나 네트워크 설정을 바꿀 때 정도 | 외부 트래픽이 처음 닿는 실제 장비 주소 |
| ClusterIP | Service를 지웠다 다시 만들 때까지 그대로 | 클라이언트가 부르는 고정 창구 |
| Pod IP | 파드가 다시 만들어질 때마다 새로 받음 | 패킷의 최종 목적지 |

게시판 API가 결제 파드의 IP를 직접 적어 두면 결제 파드가 재생성되는 순간 연결이 끊깁니다. ClusterIP를 부르면 kube-proxy 규칙이 그 시점의 엔드포인트 중 하나로 바꿔 주므로 이런 일이 없습니다.

#### 2. 실전에서 보이는 모습

```bash
kubectl get nodes -o wide                 # INTERNAL-IP 열이 Node IP
kubectl -n kube-system get pod -o wide    # IP 열을 Node IP와 비교
```

kube-system 파드 중 CoreDNS는 파드 대역 IP를 받습니다. kubeadm 클러스터의 kube-apiserver, etcd, kube-controller-manager, kube-scheduler(정적 파드)와 kube-proxy(DaemonSet)는 `hostNetwork: true`로 떠서 IP 열에 Node IP가 그대로 보입니다. 노드의 네트워크 네임스페이스를 함께 쓰기 때문입니다.

> **정리**: 바뀌는 주소(Pod IP) 앞에 바뀌지 않는 주소(ClusterIP)를 두고 둘 사이를 커널 규칙이 이어 줍니다. 그 규칙이 3장의 내용입니다.

</details>

| 주소 | 누가 정하나 | 어디에 실제로 있나 | 예시(가상) |
|---|---|---|---|
| Node IP | 인프라(클라우드, DHCP, 수동 설정) | 노드의 물리 또는 가상 NIC | `192.168.10.11` |
| Pod IP | CNI 플러그인의 IPAM | 파드 네트워크 네임스페이스 안의 `eth0` | `10.244.1.5` |
| ClusterIP | kube-apiserver가 Service CIDR에서 할당 | 어떤 인터페이스에도 없음(iptables, nftables 모드) | `10.96.120.15` |

kubeadm의 `--service-cidr` 기본값은 `10.96.0.0/12`입니다. kubeadm은 이 범위의 10번째 주소 `10.96.0.10`을 클러스터 DNS로 정해 kubelet 설정의 `clusterDNS`에 넣습니다. 그래서 kubeadm 클러스터에서 `kube-dns` Service의 ClusterIP는 보통 `10.96.0.10`입니다.

ClusterIP에 ping이 안 되는 이유가 마지막 열에 있습니다. ICMP를 받아 줄 인터페이스도 없고 kube-proxy 규칙은 Service에 정의된 프로토콜과 포트만 매치합니다. 공식 문서도 "Service IP는 단일 호스트가 응답하지 않는다"고 적습니다.

### 1-4. 직접 해 보기

kind나 kubeadm 클러스터의 노드에서 해 볼 것입니다.

```bash
ip -br addr                          # 노드 인터페이스 목록. ClusterIP가 있는지 찾아 본다
kubectl get svc -A -o wide           # ClusterIP 목록
kubectl get pod -A -o wide           # Pod IP와 노드
kubectl -n kube-system get cm kubeadm-config -o yaml | grep -i subnet
```

확인할 것은 두 가지입니다. `ip -br addr` 출력에 `10.96.` 대역 주소가 하나도 없는지, kubeadm-config에 `serviceSubnet`과 `podSubnet`이 어떻게 적혀 있는지입니다.

kind v0.33(노드 v1.37.0) 실측 결과입니다. 워커 노드의 `ip -br addr`에는 `lo`, `eth0`(172.18.0.10/16)과 파드마다 생긴 `veth*` 인터페이스만 있었고 10.96 대역 주소는 없었습니다. kindnet의 ptp 플러그인은 노드 쪽 veth마다 같은 게이트웨이 주소 `10.244.1.1/32`를 붙였습니다. kubeadm-config는 `serviceSubnet: 10.96.0.0/16`, `podSubnet: 10.244.0.0/16`이었습니다. kind가 kubeadm 기본값 `/12` 대신 `/16`을 넘기기 때문입니다. `kube-dns` ClusterIP는 그대로 `10.96.0.10`이었습니다.

## 2. Service 타입과 포트 사슬

### 2-1. 타입별로 생기는 규칙

<details>
<summary>기초부터: 노출 범위로 보는 Service 타입과 온프레미스의 LoadBalancer</summary>

> **핵심 한 줄**: ClusterIP는 클러스터 안, NodePort는 노드 주소로, LoadBalancer는 외부 LB 주소로 문을 엽니다. 위 타입은 아래 타입의 규칙을 그대로 깔고 그 위에 문을 하나 더 냅니다.

#### 1. 어떻게 쌓이나

```text
LoadBalancer  외부 LB IP:port
   └─ NodePort    모든 노드의 IP:nodePort(기본 30000-32767)
        └─ ClusterIP   ClusterIP:port → 파드IP:targetPort
```

1. **ClusterIP**: 클러스터 안에서만 닿습니다. 주문 DB나 내부 API처럼 밖에 열 필요가 없는 곳에 씁니다. 호출하는 쪽은 Pod IP 대신 `payment.shop` 같은 이름을 쓰고 CoreDNS가 ClusterIP로 풀어 줍니다(5장).
2. **NodePort**: 모든 노드가 같은 포트를 엽니다. `<아무 노드 IP>:nodePort`로 들어온 패킷은 netfilter에서 ClusterIP와 같은 경로로 파드까지 갑니다.
3. **LoadBalancer**: 외부에 단일 진입 주소를 줍니다. 클라우드에서는 클라우드 컨트롤러가 LB를 만들어 EXTERNAL-IP를 채웁니다.

#### 2. 온프레미스에서 Pending이 나는 이유

kubeadm으로 직접 만든 클러스터에는 LB를 만들어 줄 컨트롤러가 없어서 EXTERNAL-IP가 `<pending>`으로 남습니다. MetalLB 같은 구현을 설치하면 해결됩니다.

| MetalLB 리소스 | 하는 일 |
|---|---|
| `IPAddressPool` | Service에 나눠 줄 로컬 대역 주소 범위(예: `10.0.1.200-10.0.1.220`) |
| `L2Advertisement` | 그 주소를 L2 모드로 알림. 노드 하나가 해당 IP의 ARP 요청에 자기 MAC으로 답함 |

#### 3. 헷갈리는 점

- LoadBalancer가 NodePort를 깔고 가는 것은 기본 동작입니다. `spec.allocateLoadBalancerNodePorts: false`를 주면 nodePort를 할당하지 않을 수 있고 LB 구현이 파드로 직접 보내는 경우에 씁니다.

> **정리**: 타입이 올라갈수록 문이 하나씩 늘 뿐이고 마지막에 파드로 보내는 DNAT 규칙은 같습니다.

</details>

| 타입 | kube-proxy가 노드에 만드는 것 | 메모 |
|---|---|---|
| `ClusterIP` | `ClusterIP:port` 매치 → 엔드포인트 DNAT | `type` 생략 시 기본 |
| `NodePort` | 위 규칙 + 모든 노드의 `nodePort` 매치 규칙(`KUBE-NODEPORTS`) | 기본 범위 30000-32767 |
| `LoadBalancer` | 위 규칙 + 외부 LB IP 매치 규칙 | LB 구현이 없으면 EXTERNAL-IP가 `<pending>` |
| `ExternalName` | 규칙 없음 | DNS가 CNAME으로만 답함 |
| headless(`clusterIP: None`) | 규칙 없음 | DNS가 파드 IP를 직접 돌려줌 |

headless와 ExternalName에는 kube-proxy가 관여하지 않습니다. 이 둘은 DNS만으로 동작하므로 이 글의 DNAT 이야기가 적용되지 않습니다.

### 2-2. nodePort → port → targetPort

<details>
<summary>기초부터: 포트가 가리키는 것</summary>

> **핵심 한 줄**: IP가 "어느 컴퓨터"라면 포트는 "그 컴퓨터 안의 어느 프로그램"입니다. 같은 서버에 웹 서버와 DNS 서버가 함께 떠도 섞이지 않는 이유입니다.

#### 1. 어떻게 동작하나

1. **듣기**: 프로그램이 소켓을 열고 포트 번호에 바인드합니다(예: 웹 서버 8080, DNS 53).
2. **도착**: 커널은 들어온 패킷의 목적지 포트를 보고 그 포트에 바인드한 소켓으로 넘깁니다.
3. **번호 범위**: 포트는 16비트라 0부터 65535까지입니다. TCP와 UDP는 번호 공간이 따로라 53/TCP와 53/UDP가 공존합니다.

#### 2. Service의 네 포트를 한 줄로

| 이름 | 어디에 있는 번호인가 | 아래 예시 |
|---|---|---|
| `nodePort` | 모든 노드가 밖으로 여는 포트 | 30080 |
| `port` | ClusterIP가 받는 포트 | 80 |
| `targetPort` | DNAT할 때 고르는 파드 쪽 포트 | `http` → 8080 |
| `containerPort` | 컨테이너 안 프로그램이 실제로 듣는 포트(선언) | 8080 |

> **정리**: 네 번호 중 커널이 실제로 바꾸는 것은 `nodePort` 또는 `port`에서 `targetPort`로 가는 한 번입니다.

</details>

```yaml
apiVersion: v1
kind: Service
metadata:
  name: order-api
  namespace: shop
spec:
  type: NodePort
  selector:
    app: order-api
  ports:
  - name: http
    protocol: TCP
    nodePort: 30080   # 노드 IP:30080 으로 들어오는 포트
    port: 80          # ClusterIP:80
    targetPort: http  # 파드의 이름 붙은 포트(아래 containerPort 8080)
---
# 파드 템플릿 일부
containers:
- name: app
  image: example/order-api:1.0
  ports:
  - name: http
    containerPort: 8080
```

패킷 기준으로 보면 `노드IP:30080` 또는 `10.96.120.15:80`으로 들어온 패킷이 `파드IP:8080`으로 DNAT됩니다. `targetPort`를 생략하면 `port`와 같은 값이 됩니다.

`containerPort`는 정보 성격의 필드입니다. Pod API 문서는 이 값을 적지 않아도 컨테이너가 `0.0.0.0`에서 듣는 포트로는 접근할 수 있다고 적습니다. 예외가 하나 있습니다. 위 예처럼 `targetPort`에 이름(`http`)을 쓰려면 그 이름을 가진 `containerPort` 선언이 있어야 합니다.

### 2-3. 직접 해 보기

```bash
kubectl -n shop get endpointslice -l kubernetes.io/service-name=order-api -o yaml
```

EndpointSlice의 `ports`에 `8080`이 들어 있는지 봅니다. kube-proxy가 DNAT 목적지로 쓰는 값이 바로 이 EndpointSlice의 주소와 포트입니다. kind에서 nginx 컨테이너에 `name: http, containerPort: 80`을 주고 같은 Service(`targetPort: http`)를 만들었더니 EndpointSlice의 `ports`가 `[{"name":"http","port":80,"protocol":"TCP"}]`로 채워졌습니다. 이름이 숫자로 풀린 것입니다.

## 3. 패킷이 ClusterIP를 만나는 곳: netfilter와 kube-proxy 규칙

<details>
<summary>기초부터: kube-proxy는 패킷을 나르지 않고 규칙을 씁니다</summary>

> **핵심 한 줄**: kube-proxy는 API 서버를 지켜보다가 Service와 엔드포인트가 바뀌면 노드의 nat 테이블 규칙을 다시 씁니다. 패킷을 받아 넘기는 일은 커널이 합니다.

#### 1. 어떻게 동작하나

1. **watch**: kube-proxy는 각 노드에서 Service와 EndpointSlice를 API 서버에서 지켜봅니다.
2. **규칙 생성**: 바뀐 내용을 `KUBE-SERVICES` → `KUBE-SVC-*` → `KUBE-SEP-*` 체인으로 옮겨 씁니다.
3. **패킷 처리**: 패킷은 kube-proxy 프로세스를 지나지 않습니다. netfilter가 규칙대로 목적지를 바꿉니다.

```text
API 서버 ──watch──> kube-proxy ──iptables-restore──> 노드 커널 nat 테이블
                                                     ↑
파드의 패킷 ─────────────────────────────────────────┘ (여기서 DNAT)
```

그래서 kube-proxy가 잠깐 멈춰도 이미 써 둔 규칙으로 기존 Service 통신은 계속됩니다. 그동안 바뀐 엔드포인트가 규칙에 반영되지 않을 뿐입니다.

#### 2. 헷갈리는 점

- `iptables -t nat -L KUBE-SERVICES -n`의 `prot` 칸은 iptables 버전에 따라 `tcp`, `udp` 같은 이름이나 `6`, `17` 같은 번호로 나옵니다. 번호는 IP 머리말의 프로토콜 번호이고 TCP가 6, UDP가 17입니다. conntrack 출력의 `udp 17`도 같은 번호입니다.
- kube-dns Service 줄이 여럿 보이는 것은 포트마다 한 줄이기 때문입니다. UDP 53은 이름 해석, TCP 53은 큰 응답, TCP 9153은 메트릭용입니다(5-3).

> **정리**: Service에는 따로 도는 로드밸런서 프로세스가 없습니다. kube-proxy가 쓴 규칙과 그 규칙을 실행하는 커널이 Service의 실체입니다.

</details>

### 3-1. netfilter 훅 5개

리눅스 커널은 IP 패킷이 지나는 길목 다섯 곳에 훅을 둡니다. iptables의 내장 체인 이름이 이 훅 이름과 같습니다.

```text
           (밖에서 들어온 패킷)
                   |
             [PREROUTING]   conntrack 조회, nat: 목적지 변환(DNAT)
                   |
            라우팅 결정: 내 주소인가?
             /                 \
          예                    아니오
           |                      |
        [INPUT]               [FORWARD]   filter: 통과 여부
           |                      |
     로컬 프로세스                  |
           |                      |
        [OUTPUT]  conntrack 조회, nat: DNAT
           |                      |
            \                    /
             [POSTROUTING]  nat: 출발지 변환(SNAT, MASQUERADE)
                   |
              (밖으로 나감)
```

파드에서 나온 패킷은 파드 네임스페이스의 veth를 지나 노드 네임스페이스에 "밖에서 들어온 패킷"으로 도착합니다. 그래서 PREROUTING을 지납니다. 노드 자체 프로세스(예: 노드에서 직접 `curl`)가 보낸 패킷은 OUTPUT을 지납니다. kube-proxy가 `KUBE-SERVICES`를 nat 테이블의 PREROUTING과 OUTPUT 두 곳에 거는 이유가 이것입니다. kube-proxy 소스(`pkg/proxy/iptables/proxier.go`)의 `iptablesJumpChains` 목록에서 이 연결을 직접 볼 수 있습니다.

| 테이블 | 내장 체인 | 거는 kube-proxy 체인 |
|---|---|---|
| nat | PREROUTING, OUTPUT | `KUBE-SERVICES` |
| nat | POSTROUTING | `KUBE-POSTROUTING` |
| filter | FORWARD | `KUBE-FORWARD`, `KUBE-SERVICES` 등 |
| filter | INPUT, OUTPUT | `KUBE-FIREWALL`, `KUBE-NODEPORTS` 등 |

### 3-2. KUBE-SERVICES: Service 찾기

`KUBE-SERVICES`는 Service 하나의 포트마다 규칙 한 줄을 갖습니다. 목적지 IP와 포트가 맞으면 그 Service의 `KUBE-SVC-*` 체인으로 점프합니다. 체인 이름의 해시는 네임스페이스, Service 이름, 포트 이름, 프로토콜을 합친 문자열로 만듭니다. 아래는 이런 형태로 나온다는 예시이며 해시 값은 지어낸 것입니다.

```text
# iptables -t nat -S KUBE-SERVICES (형태 예시)
-A KUBE-SERVICES -d 10.96.120.15/32 -p tcp -m comment --comment "shop/order-api:http cluster IP" -m tcp --dport 80 -j KUBE-SVC-ABCDEF1234567890
-A KUBE-SERVICES -d 10.96.0.10/32 -p udp -m comment --comment "kube-system/kube-dns:dns cluster IP" -m udp --dport 53 -j KUBE-SVC-TCOU7JCQXEZGVUNU
-A KUBE-SERVICES -m comment --comment "kubernetes service nodeports; NOTE: this must be the last rule in this chain" -m addrtype --dst-type LOCAL -j KUBE-NODEPORTS
```

마지막 줄이 NodePort 처리입니다. 목적지가 노드 자신의 주소인 패킷만 `KUBE-NODEPORTS`로 보내고 거기서 `nodePort` 번호로 Service를 찾습니다.

iptables 모드에서 이 체인은 위에서부터 차례로 비교됩니다. Service가 수천 개면 첫 패킷 하나가 규칙 수천 줄을 훑을 수 있습니다. nftables 모드는 이 부분을 맵 조회로 바꿨습니다. SREcon26 발표 슬라이드도 Cilium이 순차 매칭 대신 맵 기반 조회를 쓴다는 점을 같은 맥락에서 짚습니다.

### 3-3. KUBE-SVC: 확률로 엔드포인트 고르기

엔드포인트가 3개인 `order-api`의 `KUBE-SVC` 체인은 이런 형태입니다.

```text
# iptables -t nat -S KUBE-SVC-ABCDEF1234567890 (형태 예시)
-A KUBE-SVC-ABCDEF1234567890 ! -s 10.244.0.0/16 -d 10.96.120.15/32 -p tcp -m tcp --dport 80 -j KUBE-MARK-MASQ
-A KUBE-SVC-ABCDEF1234567890 -m statistic --mode random --probability 0.33333333349 -j KUBE-SEP-AAAA
-A KUBE-SVC-ABCDEF1234567890 -m statistic --mode random --probability 0.50000000000 -j KUBE-SEP-BBBB
-A KUBE-SVC-ABCDEF1234567890 -j KUBE-SEP-CCCC
```

규칙은 위에서부터 평가됩니다. 첫 규칙이 1/3 확률로 A를 고릅니다. 떨어진 2/3 중 절반이 B로 가므로 B도 전체의 1/3입니다. 남은 1/3은 마지막 규칙으로 갑니다. 마지막 규칙에는 확률 매치가 아예 없고 무조건 점프합니다.

소스로 확인하면 이렇습니다. `proxier.go`는 i번째 엔드포인트에 `1/(남은 개수)`를 소수점 10자리 문자열로 넣습니다. 마지막 엔드포인트에는 statistic 인자를 붙이지 않습니다.

```go
// kubernetes/pkg/proxy/iptables/proxier.go (발췌)
func computeProbability(n int) string {
	return fmt.Sprintf("%0.10f", 1.0/float64(n))
}
...
if i < (numEndpoints - 1) {
	// Each rule is a probabilistic match.
	args = append(args, "-m", "statistic", "--mode", "random",
		"--probability", proxier.probability(numEndpoints-i))
}
// The final (or only if n == 1) rule is a guaranteed match.
natRules.Write(args, "-j", string(epInfo.ChainName))
```

kube-proxy가 쓰는 값은 `0.3333333333`입니다. `iptables-save`로 읽으면 커널에 저장된 내부 표현을 다시 바꾼 `0.33333333349`가 보입니다. 공식 문서의 예시도 이 값입니다.

첫 줄의 `! -s 10.244.0.0/16 ... -j KUBE-MARK-MASQ`는 파드 CIDR 밖에서 온 패킷(예: 노드 프로세스)에 마스커레이드 표시를 붙입니다. 이 줄은 kube-proxy에 클러스터 CIDR 정보가 있을 때 생깁니다. 구성에 따라 모양이 다를 수 있습니다.

### 3-4. KUBE-SEP: DNAT

```text
# iptables -t nat -S KUBE-SEP-AAAA (형태 예시)
-A KUBE-SEP-AAAA -s 10.244.1.5/32 -j KUBE-MARK-MASQ
-A KUBE-SEP-AAAA -p tcp -m tcp -j DNAT --to-destination 10.244.1.5:8080
```

두 번째 줄이 이 글의 핵심인 DNAT입니다. 목적지 `10.96.120.15:80`이 `10.244.1.5:8080`으로 바뀝니다.

첫 줄은 헤어핀 경우를 처리합니다. 헤어핀은 파드가 자기 Service를 불렀는데 자기 자신이 엔드포인트로 뽑힌 경우입니다. 표시가 없다면 어떻게 되는지 따라가 보면 첫 줄이 왜 필요한지 보입니다.

| 단계 | 패킷 | 어디서 |
|---|---|---|
| ① 요청 | `10.244.1.5:51000 → 10.96.120.15:80` | 파드에서 veth를 지나 노드로 나감 |
| ② DNAT | `10.244.1.5:51000 → 10.244.1.5:8080` | 노드 nat PREROUTING. 다시 같은 파드로 들어감 |
| ③ 응답 | `10.244.1.5:8080 → 10.244.1.5:51000` | 목적지가 자기 IP라 파드 안에서 바로 전달. 노드를 거치지 않음 |
| ④ 결과 | 클라이언트 소켓은 `10.96.120.15:80`의 답을 기다리는데 `10.244.1.5:8080`에서 온 패킷을 받음 | 응답이 노드의 conntrack을 지나지 않아 출발지가 ClusterIP로 되돌아가지 못함 |

TCP라면 ④에서 클라이언트 커널이 모르는 연결의 패킷으로 보고 연결이 맺어지지 않습니다. `-s 10.244.1.5/32 -j KUBE-MARK-MASQ`가 붙으면 ②에서 출발지도 노드 쪽 주소로 바뀝니다(3-5). 그러면 ③의 응답은 목적지가 노드 쪽 주소라 파드 밖 노드로 나가고 노드의 conntrack이 출발지와 목적지를 모두 원래대로 되돌린 뒤 파드에 넘깁니다.

### 3-5. KUBE-MARK-MASQ와 KUBE-POSTROUTING

MASQUERADE는 SNAT의 한 종류입니다. SNAT는 바꿀 출발지 주소를 규칙에 적어 두고 MASQUERADE는 패킷이 실제로 나가는 인터페이스의 주소를 그때 골라 씁니다(iptables-extensions(8)). 노드의 인터페이스 주소가 바뀌어도 규칙을 고칠 필요가 없어서 kube-proxy가 이쪽을 씁니다.

마스커레이드는 두 단계로 나뉩니다. `KUBE-MARK-MASQ`는 패킷에 방화벽 마크(기본 `0x4000`)만 붙이고 아무것도 바꾸지 않습니다. 실제 출발지 변환은 패킷이 나가기 직전 nat POSTROUTING에 걸린 `KUBE-POSTROUTING`이 합니다.

```text
# proxier.go가 쓰는 KUBE-POSTROUTING (형태 예시)
-A KUBE-POSTROUTING -m mark ! --mark 0x4000/0x4000 -j RETURN
-A KUBE-POSTROUTING -j MARK --set-xmark 0x4000/0x0
-A KUBE-POSTROUTING -m comment --comment "kubernetes service traffic requiring SNAT" -j MASQUERADE --random-fully
```

kube-proxy 소스는 두 번째 줄을 `--xor-mark 0x4000`으로 쓰지만 `iptables -S`로 읽으면 같은 뜻의 `--set-xmark 0x4000/0x0`으로 보입니다. 위 세 줄은 kind 워커(iptables v1.8.11, nf_tables 백엔드)에서 읽은 실측 그대로입니다. 표시가 없으면 그냥 돌려보냅니다. 있으면 표시를 지운 뒤 MASQUERADE합니다. 표시를 지우는 이유는 소스 주석에 있습니다. 패킷이 네트워크 스택을 다시 지날 때 두 번 마스커레이드되는 일을 막기 위해서입니다. DNAT 판단 시점(PREROUTING)에는 아직 나갈 인터페이스를 모르므로 결정과 실행을 이렇게 나눠 둡니다. 마지막 줄의 `--random-fully`는 바뀐 출발지 포트를 완전히 무작위로 고르라는 옵션입니다. iptables-extensions(8) 매뉴얼은 커널 3.13부터 쓸 수 있고 커널 5.0부터는 `--random`과 같은 동작이라고 적습니다.

### 3-6. kube-proxy 모드와 eBPF

| 모드 | 상태(2026년 10월, v1.37 기준) | ClusterIP가 붙는 곳 |
|---|---|---|
| `iptables` | 리눅스 기본값 | 없음 |
| `nftables` | v1.29 알파, v1.31 베타, v1.33 GA. 커널 5.13 이상 | 없음 |
| `ipvs` | v1.35부터 deprecated. KEP-5495 계획상 v1.40부터 기본 비활성, v1.43 제거 예정 | 더미 인터페이스 `kube-ipvs0` |

공식 문서는 리눅스 기본값이 앞으로 nftables로 바뀔 것이라고 예고하지만 v1.37 시점 기본값은 여전히 iptables입니다. IPVS 모드만 예외적으로 Service IP를 `kube-ipvs0`에 붙입니다. 커널의 IPVS가 로컬 주소로 들어온 패킷만 처리하기 때문입니다.

kube-proxy 자체에는 eBPF 모드가 없습니다. eBPF로 Service를 처리하려면 Cilium처럼 kube-proxy를 대체하는 CNI를 씁니다. SREcon26 슬라이드는 Cilium을 "iptables를 우회해 kube-proxy를 완전히 대체하도록 설정할 수 있는 eBPF 데이터 경로"로 소개합니다. 이 경우 이 장의 iptables 규칙은 노드에 생기지 않습니다.

### 3-7. 직접 해 보기

```bash
# 노드에서 (kind면 docker exec -it <노드 컨테이너> bash)
iptables -t nat -L KUBE-SERVICES -n --line-numbers | head -30
iptables -t nat -S | grep -c '^-A KUBE-SEP'       # 엔드포인트 체인 수
iptables -t nat -S PREROUTING                      # KUBE-SERVICES로 점프하는 줄
iptables -t nat -S OUTPUT
iptables -t nat -S KUBE-POSTROUTING
```

`order-api`를 `kubectl scale --replicas=3`과 `--replicas=4`로 바꿔 가며 `KUBE-SVC` 체인의 확률 값이 어떻게 달라지는지 봅니다. 4개라면 0.25, 0.333..., 0.5, 확률 없음 순서가 나와야 합니다. kube-proxy가 nftables 모드라면 `iptables` 대신 `nft list table ip kube-proxy`로 봅니다.

kind 워커에서 읽은 실측 출력입니다(nginx 파드 3개, `targetPort: http` → 80).

```text
-A KUBE-SERVICES -d 10.96.53.219/32 -p tcp -m comment --comment "shop/order-api:http cluster IP" -m tcp --dport 80 -j KUBE-SVC-2IW3JN2M6PSPKT5G
-A KUBE-SVC-2IW3JN2M6PSPKT5G ! -s 10.244.0.0/16 -d 10.96.53.219/32 -p tcp -m comment --comment "shop/order-api:http cluster IP" -m tcp --dport 80 -j KUBE-MARK-MASQ
-A KUBE-SVC-2IW3JN2M6PSPKT5G -m comment --comment "shop/order-api:http -> 10.244.1.57:80" -m statistic --mode random --probability 0.33333333349 -j KUBE-SEP-MZPCKG4VX24Q3GSJ
-A KUBE-SVC-2IW3JN2M6PSPKT5G -m comment --comment "shop/order-api:http -> 10.244.1.58:80" -m statistic --mode random --probability 0.50000000000 -j KUBE-SEP-TKVPKHP5GZB5SUTP
-A KUBE-SVC-2IW3JN2M6PSPKT5G -m comment --comment "shop/order-api:http -> 10.244.2.53:80" -j KUBE-SEP-UDSVEVMTRFQ4ZM2P
-A KUBE-SEP-MZPCKG4VX24Q3GSJ -s 10.244.1.57/32 -m comment --comment "shop/order-api:http" -j KUBE-MARK-MASQ
-A KUBE-SEP-MZPCKG4VX24Q3GSJ -p tcp -m comment --comment "shop/order-api:http" -m tcp -j DNAT --to-destination 10.244.1.57:80
```

3-3과 3-4의 형태 예시와 구조는 같고 실제 규칙에는 엔드포인트 주소를 적은 `--comment`가 붙어 있습니다. 4개로 늘리자 확률이 `0.25000000000`, `0.33333333349`, `0.50000000000`, 확률 없음 순서로 바뀌었습니다. nat PREROUTING과 OUTPUT에는 `KUBE-SERVICES` 점프 말고도 kind가 넣은 `DOCKER_OUTPUT` 규칙이, POSTROUTING에는 `KIND-MASQ-AGENT` 규칙이 함께 있었습니다.

## 4. 연결을 기억하는 장치: conntrack

<details>
<summary>기초부터: TCP와 UDP, 그리고 연결이 없는 UDP를 커널이 추적하는 법</summary>

> **핵심 한 줄**: TCP는 연결을 맺고 끊는 절차가 있지만 UDP는 그냥 보냅니다. conntrack은 UDP에도 "주고받은 흔적"을 장부로 남겨 연결처럼 다룹니다.

#### 1. 한눈에 비교

| 구분 | TCP | UDP |
|---|---|---|
| 시작 | 3-way handshake(SYN → SYN+ACK → ACK) | 절차 없이 바로 보냄 |
| 신뢰성 | 순서 보장, 유실 시 재전송 | 보장 없음. 필요하면 응용이 재시도 |
| 끝 | FIN 또는 RST로 끝남 | 끝을 알리는 신호가 없음 |
| 흔한 쓰임 | HTTP, DB 연결 | DNS 질의 |

DNS가 UDP를 쓰는 이유는 질의 하나와 응답 하나로 끝나는 짧은 대화이기 때문입니다. 연결을 맺는 왕복을 아끼면 그만큼 빨리 답을 받습니다. 응답이 크면 TCP로 다시 묻습니다(5-3).

tcpdump로 보면 차이가 바로 보입니다. TCP는 `[S]`, `[S.]`, `[.]` 다음에야 데이터(`[P.]`)가 오고 UDP 53은 첫 패킷부터 질의입니다.

#### 2. conntrack이 UDP를 다루는 방식

1. **첫 패킷**: 새 5-튜플이면 항목을 만들고 nat 규칙의 결정(DNAT)을 함께 기록합니다. 5-튜플은 흐름 하나를 가리키는 다섯 값(프로토콜, 출발지 IP, 출발지 포트, 목적지 IP, 목적지 포트)입니다. 다섯 값이 모두 같으면 conntrack은 같은 흐름으로 봅니다.
2. **응답**: 역방향 튜플과 맞는 패킷이 오면 출발지를 ClusterIP로 되돌립니다.
3. **소멸**: 끝 신호가 없으니 마지막 패킷 이후 타임아웃이 지나야 사라집니다(4-3).

#### 3. 헷갈리는 점

- **응답보다 항목이 먼저 만료되면**: 커널이 응답을 그 자리에서 버린다고 설명하는 경우가 있습니다. 실제로는 되돌릴 기록이 없으니 응답의 출발지가 ClusterIP로 바뀌지 않습니다. 클라이언트는 `10.96.0.10:53`에 물었는데 CoreDNS 파드 IP에서 답이 온 셈이라 리졸버가 그 응답을 자기 질의의 답으로 받아들이지 못합니다. 결과는 타임아웃입니다.
- 7장의 사례는 반대 방향의 문제입니다. 사라져야 할 항목이 계속 살아 있었습니다.

> **정리**: UDP는 상태가 없고 conntrack이 그 상태를 대신 기억합니다. 그 기억이 틀린 채로 남으면 패킷은 틀린 곳으로 계속 갑니다.

</details>

### 4-1. 첫 패킷만 nat 규칙을 탄다

iptables(8) 매뉴얼은 nat 테이블을 "새 연결을 만드는 패킷을 만났을 때 참조하는 테이블"로 설명합니다. 3장의 확률 선택과 DNAT는 연결의 첫 패킷에만 일어납니다. 커널의 conntrack은 그 결과를 항목 하나로 기억합니다. 같은 연결의 다음 패킷은 규칙을 다시 훑지 않고 기억한 대로 변환됩니다. SREcon26 슬라이드는 conntrack의 역할을 "이미 본 패킷을 바탕으로 패킷을 활성 연결에 매칭하고 알려진 연결의 패킷이 iptables를 다시 평가하지 않게 해 CPU를 아낀다"고 요약합니다.

이 성질이 장점이자 7장 사례의 원인입니다. 한 번 정해진 엔드포인트는 그 conntrack 항목이 살아 있는 동안 바뀌지 않습니다. 엔드포인트가 사라져도 항목이 남아 있으면 패킷은 사라진 곳으로 계속 갑니다.

### 4-2. 정방향 튜플과 역방향 튜플

conntrack 항목은 튜플 두 개를 갖습니다. 정방향(original)은 클라이언트가 보낸 그대로의 주소이고 역방향(reply)은 응답이 돌아올 때 보일 주소입니다. DNAT가 있으면 두 튜플의 대칭이 깨집니다.

```text
정방향:  src=10.244.2.9  dst=10.96.0.10   sport=40123 dport=53
역방향:  src=10.244.1.7  dst=10.244.2.9   sport=53    dport=40123
                ^ 실제로 고른 CoreDNS 파드 IP
```

응답 패킷이 역방향 튜플과 맞으면 커널이 출발지를 다시 `10.96.0.10:53`으로 되돌려 클라이언트에 넘깁니다. 클라이언트는 ClusterIP와 대화한 것으로 압니다. 역방향 튜플의 `src`를 보면 어느 엔드포인트가 뽑혔는지 알 수 있습니다.

3장의 규칙 사슬과 이 장부를 한 장에 놓으면 이렇습니다. 첫 패킷만 체인을 끝까지 타고 DNAT 결과가 장부에 남습니다. 응답과 같은 흐름의 다음 패킷은 체인을 다시 보지 않고 장부만 봅니다.

![클라이언트 파드 10.244.2.9가 10.96.0.10:53으로 보낸 첫 패킷이 노드 커널의 PREROUTING, KUBE-SERVICES, KUBE-SVC, KUBE-SEP을 차례로 지나 10.244.1.7:53으로 DNAT되고 그 결정이 conntrack 장부에 정방향과 역방향 튜플로 기록되는 그림. 응답은 장부의 역방향 튜플과 맞춰 출발지가 10.96.0.10:53으로 되돌아간다](/uploads/theory/k8s-linux-05-service-iptables-conntrack/first-packet-and-reply.svg)

### 4-3. UDP 타임아웃

TCP는 FIN이나 RST를 보고 항목을 정리할 수 있습니다. UDP에는 그런 신호가 없어서 항목은 타임아웃으로만 사라집니다. 커널 문서(nf_conntrack-sysctl)의 현재 기본값입니다.

| sysctl | 기본값 | 적용 대상 |
|---|---|---|
| `net.netfilter.nf_conntrack_udp_timeout` | 30초 | 일반 UDP 흐름 |
| `net.netfilter.nf_conntrack_udp_timeout_stream` | 120초 | 커널이 UDP 스트림으로 판단한 흐름(양방향 트래픽이 이어지는 경우) |

`_stream` 기본값은 예전에 180초였습니다. Florian Westphal의 커밋 294304e4("netfilter: conntrack: udp: set stream timeout to 2 minutes")에서 120초로 줄었습니다. 오래된 배포판 커널에서는 180초일 수 있으니 노드에서 직접 값을 읽어 확인합니다.

타임아웃은 패킷이 올 때마다 다시 채워집니다. 그래서 같은 5-튜플(프로토콜, 출발지 IP와 포트, 목적지 IP와 포트)로 타임아웃보다 짧은 간격으로 계속 보내면 항목은 사라지지 않습니다.

### 4-4. conntrack -L 읽는 법

```text
# conntrack -L -p udp --dport 53 (형태 예시, 값은 가상)
udp      17 102 src=10.244.2.9 dst=10.96.0.10 sport=40123 dport=53 src=10.244.1.7 dst=10.244.2.9 sport=53 dport=40123 [ASSURED] mark=0 use=1
udp      17 27 src=10.244.2.9 dst=10.96.0.10 sport=51877 dport=53 [UNREPLIED] src=10.244.3.4 dst=10.244.2.9 sport=53 dport=51877 mark=0 use=1
```

| 칸 | 의미 |
|---|---|
| `udp 17` | 프로토콜 이름과 번호 |
| `102`, `27` | 항목이 사라지기까지 남은 초 |
| 첫 번째 `src= dst= sport= dport=` | 정방향 튜플 |
| `[UNREPLIED]` | 아직 응답을 한 번도 못 본 항목 |
| 두 번째 `src= dst= ...` | 역방향 튜플. 여기 `src`가 DNAT된 엔드포인트 |
| `[ASSURED]` | 양방향 트래픽을 확인한 항목 |

kind 실측에서 `nslookup`을 몇 번 돌린 뒤의 항목은 `udp 17 29 src=10.244.1.59 dst=10.96.0.10 sport=51849 dport=53 src=10.244.0.3 dst=10.244.1.59 sport=53 dport=51849 mark=0 use=1`처럼 `[UNREPLIED]`도 `[ASSURED]`도 없었습니다. 질의 하나와 응답 하나로 끝난 UDP 흐름은 ASSURED가 되지 않고 30초 타임아웃을 받습니다. 7-6처럼 같은 포트로 질의를 반복하자 `[ASSURED]`가 붙고 남은 시간이 120초 안쪽으로 올라갔습니다.

두 번째 줄처럼 `[UNREPLIED]` 항목이 같은 엔드포인트로 몰려 있으면 그 엔드포인트가 응답하지 않는다는 신호입니다. 남은 초가 계속 다시 차오르는 항목이 있다면 4-3에서 말한 갱신이 일어나고 있는 것입니다.

### 4-5. 직접 해 보기

```bash
sysctl net.netfilter.nf_conntrack_udp_timeout net.netfilter.nf_conntrack_udp_timeout_stream
conntrack -L -p udp --dport 53 2>/dev/null | head
watch -n 1 'conntrack -L -p udp --dport 53 2>/dev/null | head -5'   # 남은 초가 줄고 다시 차는지
conntrack -S                                                          # CPU별 통계(insert_failed, drop 등)
```

파드 하나에서 `nslookup order-api.shop`을 몇 번 실행한 뒤 위 명령을 다시 봅니다. 역방향 튜플의 `src`가 CoreDNS 파드 IP 중 하나인지 `kubectl -n kube-system get pod -l k8s-app=kube-dns -o wide`와 비교합니다. kind 실측에서 sysctl 값은 30과 120이었고 역방향 `src`는 CoreDNS 파드 IP 10.244.0.3과 10.244.0.4로 나뉘었습니다. `conntrack -S`는 모든 CPU에서 `insert_failed=0 drop=0`이었습니다. 질의용 파드는 5-4의 이유로 busybox 대신 `registry.k8s.io/e2e-test-images/jessie-dnsutils:1.3`을 썼습니다.

### 4-6. insert_failed와 5초씩 늦는 DNS

4-5의 `conntrack -S`에서 `insert_failed`를 본 이유가 있습니다. 쿠버네티스 DNS에서 오래 알려진 conntrack 문제가 이 숫자로 드러나기 때문입니다. 7장 사례와는 다른 문제라서 따로 적습니다.

glibc 리졸버는 기본 설정에서 IPv4 주소(A)와 IPv6 주소(AAAA)를 같은 UDP 소켓으로 거의 동시에 묻습니다. 두 질의는 5-튜플이 같습니다. conntrack 항목은 패킷을 처음 볼 때 만들어지고 패킷이 노드를 떠나기 직전에 테이블에 확정(confirm)됩니다. 확정되기 전의 항목은 다른 패킷이 찾지 못하므로 두 패킷이 각자 "처음 보는 흐름"으로 항목을 만듭니다. DNAT가 끼면 두 항목이 서로 다른 CoreDNS를 고를 수도 있습니다. 둘째 항목을 확정하려는 순간 같은 튜플이 이미 있으니 커널은 그 패킷을 버리고 `insert_failed`를 하나 올립니다.

| 단계 | 질의 A | 질의 AAAA |
|---|---|---|
| ① 같은 소켓에서 거의 동시에 출발 | 새 항목 생성, DNAT 결정 | 새 항목 생성, DNAT 결정 |
| ② 노드를 떠나기 직전 확정 | 테이블에 들어감 | 같은 튜플이 이미 있음 → 패킷 버림, `insert_failed` 증가 |
| ③ 결과 | 응답 받음 | 응답이 오지 않아 리졸버 기본 타임아웃 5초를 기다린 뒤 다시 보냄 |

그래서 증상은 "가끔 DNS가 정확히 5초 늦는다"입니다. Ubuntu 커널 패치 메일링 리스트는 이 경쟁을 "같은 출발지에서 같은 목적지로 동시에 보낸 패킷이 NAT 환경에서 경쟁해 하나가 버려지고 5초 DNS 타임아웃이 생긴다"는 취지로 정리하고 두 커밋을 수정으로 꼽습니다. 하나는 같은 내용의 항목끼리 부딪히면 버리지 않고 합치는 커밋(ed07d9a021df, 4.19)이고 다른 하나는 같은 출발지의 NAT 충돌 처리를 고친 커밋(4e35c1cb9460, 5.0, 4.9.163, 4.14.106, 4.19.29 등에 백포트)입니다([Ubuntu kernel-team](https://lists.snapcraft.io/archives/kernel-team/2019-July/102291.html)).

커널을 바로 올릴 수 없을 때 현장에서 쓴 우회도 정리돼 있습니다. 한 팀은 resolv.conf의 `single-request-reopen`으로는 `insert_failed`가 계속 늘어서 DNS를 TCP로 바꾸는 쪽으로 해결했고 장기 대책으로 NodeLocal DNSCache를 꼽았습니다([Bruno Ferreira, DNS hell in Kubernetes](https://dev.to/bmbferreira/dns-hell-in-k8s-4m6i)). 쿠버네티스의 NodeLocal DNSCache 문서도 도입 이유의 하나로 "iptables DNAT와 conntrack을 건너뛰어 conntrack 경쟁을 줄인다"를 적습니다(7-5).

노드에서 확인하는 순서는 이렇습니다.

```bash
conntrack -S | grep -o 'insert_failed=[0-9]*' | sort | uniq -c   # CPU별 값. 0이 아니고 계속 늘면 의심
uname -r                                                          # 위 두 커밋이 들어간 커널인지
```

4-5의 kind 실측에서는 모든 CPU가 `insert_failed=0`이었습니다. 커널 6.8에는 두 커밋이 모두 들어 있습니다.

## 5. 파드가 이름을 IP로 바꾸는 길

<details>
<summary>기초부터: kube-dns라는 이름과 노드의 127.0.0.53</summary>

> **핵심 한 줄**: 파드가 묻는 DNS 서버는 `kube-dns`라는 Service이고 그 뒤에서 답하는 프로그램은 CoreDNS 파드입니다. 노드 자신은 따로 로컬 캐시(127.0.0.53)를 쓰는 경우가 많습니다.

#### 1. 이름이 kube-dns인 이유

| 보이는 이름 | 정체 |
|---|---|
| Service `kube-dns` | 고정 가상 주소(kubeadm 기본 `10.96.0.10`) |
| 파드 `coredns-*` | 실제로 질의에 답하는 프로그램 |

kubeadm 문서는 CoreDNS Service 이름을 `kube-dns`로 둔 이유를 예전 kube-dns 애드온과의 호환으로 적습니다. 예전 이름을 가리키던 설정과 도구가 DNS 구현을 바꾼 뒤에도 그대로 동작하게 하려는 것입니다.

#### 2. 노드의 resolv.conf는 다를 수 있습니다

Ubuntu처럼 systemd-resolved를 쓰는 노드에서 `cat /etc/resolv.conf`를 하면 `nameserver 127.0.0.53`이 보입니다. systemd-resolved가 루프백 주소에서 듣는 로컬 DNS 캐시입니다.

1. **문제**: CoreDNS 파드는 `dnsPolicy: Default`라서 kubelet이 넘긴 노드 resolv.conf를 상위 서버 목록으로 씁니다. 그 안의 127.0.0.53은 CoreDNS 자기 네트워크 네임스페이스의 루프백이라 밖으로 보낸 질의가 CoreDNS 자신에게 돌아옵니다. 쿠버네티스 문서는 이 구성이 치명적인 포워딩 루프를 만들 수 있다고 적습니다.
2. **해결**: kubelet의 `--resolv-conf`를 `/run/systemd/resolve/resolv.conf`(실제 상위 서버 목록)로 지정합니다.
3. **kubeadm**: 문서 기준으로 systemd-resolved를 감지하면 kubelet 설정을 알아서 맞춥니다.

> **정리**: 파드의 resolv.conf는 kubelet이 쓰고 그 안의 `nameserver`는 kube-dns Service입니다. 노드의 127.0.0.53은 노드 프로세스만을 위한 것입니다.

</details>

### 5-1. getaddrinfo에서 UDP 53까지

주문 API가 결제 서비스를 `payment.shop`으로 부를 때 일어나는 일입니다. SREcon26 발표도 이 경로를 `getaddrinfo(3)`에서 시작해 설명합니다.

```text
애플리케이션: getaddrinfo("payment.shop")
   |
libc 리졸버
   |  glibc: /etc/nsswitch.conf 의 hosts: 줄 순서대로 (보통 files dns)
   |  musl(Alpine): nsswitch.conf를 읽지 않음. /etc/hosts 다음 DNS로 고정
   v
/etc/hosts 확인 → 없음
   |
/etc/resolv.conf 읽기 → nameserver 10.96.0.10, search 목록, ndots:5
   |
UDP 소켓으로 10.96.0.10:53 에 질의
   |
노드 nat PREROUTING → KUBE-SERVICES → KUBE-SVC(kube-dns) → KUBE-SEP → CoreDNS 파드IP:53
```

마지막 줄이 3장 그대로입니다. DNS 질의도 Service를 거치는 평범한 UDP 패킷이므로 conntrack 항목을 남깁니다.

### 5-2. kubelet이 쓰는 resolv.conf

`dnsPolicy: ClusterFirst`(기본값)인 파드에 kubelet이 써 주는 `/etc/resolv.conf`는 공식 문서 기준으로 이런 형태입니다.

```text
nameserver 10.96.0.10
search shop.svc.cluster.local svc.cluster.local cluster.local
options ndots:5
```

`ndots:5`는 점이 5개 미만인 이름을 search 목록부터 붙여 보라는 뜻입니다. `payment.shop`은 점이 1개라서 `payment.shop.shop.svc.cluster.local`, `payment.shop.svc.cluster.local` 순으로 시도하고 두 번째에서 답을 받습니다. 외부 이름 `api.example.com`(점 2개)도 search 목록 세 개를 먼저 다 시도한 뒤에야 그대로 질의합니다. 외부 도메인을 많이 부르는 파드라면 이름 끝에 점을 붙여(`api.example.com.`) 절대 이름으로 쓰거나 파드의 `dnsConfig`로 `ndots`를 낮출 수 있습니다.

musl은 search 목록 처리 방식도 glibc와 다릅니다. Alpine 기반 이미지에서 이름 해석 결과가 다르게 나오면 libc 차이부터 의심합니다.

### 5-3. UDP 응답이 크면 TCP로

CoreDNS를 가리키는 `kube-dns` Service에는 53/UDP, 53/TCP, 9153/TCP(메트릭) 포트가 있습니다. 질의는 UDP로 먼저 갑니다. 응답이 UDP로 보낼 수 있는 크기를 넘으면 서버는 잘린 응답에 TC 비트를 세워 보내고 리졸버가 같은 질의를 TCP로 다시 보냅니다. 그 크기는 EDNS0가 없으면 512바이트이고 EDNS0를 쓰면 클라이언트가 알린 크기(흔히 1232바이트)입니다.

### 5-4. 직접 해 보기

```bash
kubectl -n shop run dnsprobe --image=busybox:1.36 --restart=Never -- sleep 3600
kubectl -n shop exec dnsprobe -- cat /etc/resolv.conf
kubectl -n shop exec dnsprobe -- nslookup payment.shop
kubectl -n kube-system get svc kube-dns -o yaml | grep -A3 ports
```

busybox 이미지는 libc 빌드에 따라 동작이 다를 수 있으니 glibc 기반 이미지(예: `debian`)에서도 같은 질의를 해 보고 비교합니다.

kind v1.37.0 실측에서 `busybox:1.36`의 `nslookup payment.shop`은 Service가 있는데도 `** server can't find payment.shop: NXDOMAIN`을 내고 종료 코드 1로 끝났습니다. 같은 질의를 `registry.k8s.io/e2e-test-images/jessie-dnsutils:1.3` 파드에서 하면 `Name: payment.shop.svc.cluster.local`로 풀렸습니다. busybox `nslookup`으로는 search 목록 동작을 확인할 수 없으니 FQDN으로 묻거나 dnsutils 이미지를 씁니다. 마지막 명령의 `grep -A3`은 첫 포트만 보여 주므로 `kubectl -n kube-system get svc kube-dns -o jsonpath='{range .spec.ports[*]}{.name} {.port}/{.protocol}{"\n"}{end}'`가 낫습니다. 실측 결과는 `dns 53/UDP`, `dns-tcp 53/TCP`, `metrics 9153/TCP`였습니다.

## 6. 파드 사이 통신: 같은 노드와 다른 노드

<details>
<summary>기초부터: L2 전달과 L3 라우팅, 목적지 MAC으로 읽는 경로</summary>

> **핵심 한 줄**: 같은 링크 안이면 상대의 MAC으로 바로 보내고(L2) 다른 대역이면 게이트웨이의 MAC으로 보내 라우터에게 맡깁니다(L3). IP 주소는 끝까지 그대로입니다.

#### 1. 한눈에 비교

| 구분 | L2 전달 | L3 라우팅 |
|---|---|---|
| 조건 | 출발지와 목적지가 같은 대역, 같은 링크 | 대역이 다름 |
| 라우터 | 거치지 않음 | 거침. 거칠 때마다 TTL 1 감소 |
| 프레임의 목적지 MAC | 최종 목적지의 MAC | 다음 홉(게이트웨이)의 MAC |
| 패킷의 목적지 IP | 최종 목적지 | 최종 목적지(바뀌지 않음) |

#### 2. 어떻게 동작하나

1. **라우팅 표 확인**: 보내는 쪽은 목적지 IP가 자기 대역인지 봅니다.
2. **ARP**: 같은 대역이면 목적지의 MAC을, 아니면 게이트웨이의 MAC을 ARP로 묻습니다.
3. **전달**: 그 MAC을 프레임에 적어 내보냅니다.

#### 3. 헷갈리는 점

- 브리지 방식 CNI라면 캡처한 프레임의 목적지 MAC이 상대 파드인지 게이트웨이인지로 같은 노드 통신인지 가늠할 수 있습니다.
- Calico나 kindnet처럼 라우팅만 쓰는 CNI에서는 이 방법이 통하지 않습니다. 파드의 기본 게이트웨이가 하나뿐이라 같은 노드 파드에게 보낼 때도 목적지 MAC은 게이트웨이(노드 쪽 veth)입니다. Calico FAQ 기준으로 `cali*` 인터페이스는 모두 같은 MAC `ee:ee:ee:ee:ee:ee`를 쓸 수 있습니다. 점대점 라우팅이라 MAC이 전달 판단에 쓰이지 않기 때문입니다. 이런 CNI에서는 6-2의 TTL로 구분합니다.

> **정리**: MAC은 한 구간마다 바뀌고 IP는 끝까지 갑니다. 라우팅형 CNI에서는 모든 파드 통신이 L3라서 TTL이 더 믿을 만한 단서입니다.

</details>

### 6-1. Calico를 예로 든 경로

Service를 거치지 않고 파드 IP로 직접 보내는 경우의 경로는 CNI마다 다릅니다. 브리지(`cni0` 같은)에 veth를 모두 꽂는 방식이 있고 Calico처럼 브리지 없이 L3 라우팅만 쓰는 방식이 있습니다. Calico를 예로 들면 이렇습니다.

1. 파드의 기본 게이트웨이는 `169.254.1.1`입니다. 이 주소는 노드 어디에도 없습니다.
2. 파드가 이 게이트웨이의 MAC을 ARP로 물으면 노드 쪽 `cali*` veth가 proxy ARP로 대신 답합니다.
3. 패킷은 노드 네임스페이스로 넘어와 노드 라우팅 테이블에 있는 파드별 `/32` 경로를 따라갑니다.

```text
같은 노드:   파드A eth0 → caliA(노드) → [노드 라우팅, TTL -1] → caliB → 파드B eth0
다른 노드:   파드A → caliA → [노드1 라우팅, TTL -1] → (IPIP, VXLAN, 또는 BGP 경로) → [노드2 라우팅, TTL -1] → caliC → 파드C
```

### 6-2. TTL로 경로 확인하기

TTL(Time To Live)은 IP 머리말의 8비트 칸입니다. 라우터를 하나 지날 때마다 1씩 줄고 0이 되면 패킷을 버립니다. 경로가 고리처럼 꼬여도 패킷이 영원히 돌지 않게 하는 장치입니다. 리눅스는 보낼 때 기본 64로 시작합니다(`net.ipv4.ip_default_ttl`). 그래서 받은 쪽에서 본 TTL이 63이면 라우팅을 한 번, 62면 두 번 거친 것입니다.

라우팅을 한 번 거칠 때마다 TTL이 1 줄어듭니다. Calico에서는 같은 노드의 파드끼리도 노드 라우팅을 한 번 거치므로 TTL이 1 줄어듭니다. 다른 노드면 목적지 노드에서 한 번 더 줄어 2가 됩니다. 캡슐화 없이 BGP로 라우팅하면 중간 물리 라우터 수만큼 더 줄 수 있습니다. 브리지 방식 CNI에서 같은 노드 통신은 L2 스위칭이라 TTL이 줄지 않습니다.

### 6-3. 직접 해 보기

```bash
kubectl -n shop exec dnsprobe -- ip route          # Calico면 default via 169.254.1.1
kubectl -n shop exec dnsprobe -- ping -c 1 <같은 노드 파드 IP>    # ttl= 값 확인
kubectl -n shop exec dnsprobe -- ping -c 1 <다른 노드 파드 IP>

# 노드에서 TCP handshake 플래그 보기
tcpdump -ni any 'tcp port 8080 and host <파드 IP>' -c 10
```

tcpdump 매뉴얼의 표기로 `[S]`는 SYN, `[S.]`는 SYN+ACK, `[.]`는 ACK, `[P.]`는 PSH+ACK입니다. Service를 거쳐 보낸 요청이라면 보낸 파드의 노드 쪽 veth와 노드가 패킷을 내보내는 인터페이스에서 목적지를 비교합니다.

kind 워커에서 `tcpdump -ni any`로 잡은 실측입니다(tcpdump 4.99.5는 `apt-get install tcpdump`로 설치).

```text
veth239ed463 In  IP 10.244.1.60.58130 > 10.96.53.219.80: Flags [S], ...
eth0  Out IP 10.244.1.60.58130 > 10.244.2.53.80: Flags [S], ...
eth0  In  IP 10.244.2.53.80 > 10.244.1.60.58130: Flags [S.], ...
veth239ed463 Out IP 10.96.53.219.80 > 10.244.1.60.58130: Flags [S.], ...
```

보낸 파드의 veth로 들어온 SYN은 아직 ClusterIP를 향합니다. 패킷 캡처 지점이 nat PREROUTING보다 앞이기 때문입니다. 노드 밖으로 나가는 `eth0`에서는 목적지가 파드 IP로 바뀌어 있고 응답은 반대로 veth에 나갈 때 출발지가 ClusterIP로 되돌아가 있습니다. 같은 노드 안의 파드가 뽑혔다면 받는 파드의 veth에서 바뀐 목적지를 봅니다.

kind의 kindnet(ptp 플러그인)도 브리지 없이 라우팅합니다. 파드의 `ip route`는 `default via 10.244.1.1 dev eth0`였고 `ping` TTL은 같은 노드 파드가 63, 다른 노드 파드가 62였습니다. 6-2의 Calico 설명과 같은 모양입니다. colima 위 kind에서는 ClusterIP에 `ping`을 보내도 응답이 왔습니다. 존재하지 않는 `10.123.45.67`도 TTL 62로 응답했으니 VM 바깥 네트워크 계층이 대신 답한 것입니다. 이 환경에서는 1-3의 "ClusterIP에 ping이 안 된다"를 ping으로 확인할 수 없습니다.

## 7. 사례: 낡은 UDP conntrack 항목이 DNS를 막은 날

<details>
<summary>기초부터: 사이드카 DNS 프록시, OOMKilled, 그리고 지표에 안 보이는 장애</summary>

> **핵심 한 줄**: 장애의 재료는 셋입니다. DNS를 가로채는 사이드카, 메모리 한도로 죽은 CoreDNS 파드, 그 파드를 가리키는 채로 남은 conntrack 항목입니다.

#### 1. 사이드카가 DNS를 가로채는 방식

Istio 문서 기준으로 DNS 프록시를 켜면 애플리케이션의 DNS 요청은 모두 사이드카(또는 ztunnel) 프록시로 넘어갑니다.

```text
앱 getaddrinfo() → (가로챔) → 사이드카 DNS 프록시
                                ├─ 아는 이름: 직접 답함
                                └─ 모르는 이름: resolv.conf대로 kube-dns(10.96.0.10:53)로 전달
```

앱 입장에서는 평소처럼 resolv.conf의 서버에 물었다고 생각합니다. 실제로 kube-dns로 나가는 UDP 패킷의 출발지는 사이드카 프록시이고 그 출발지 포트가 7-2의 "같은 클라이언트 포트"입니다.

#### 2. OOMKilled와 종료 코드 137

컨테이너가 메모리 한도(`memory.max`)를 넘으면 커널 OOM killer가 SIGKILL(9번)을 보냅니다. 셸 관례상 시그널로 끝난 프로세스의 종료 코드는 128+시그널 번호라서 137이 보이고 `kubectl describe pod`의 Last State에는 `Reason: OOMKilled`가 찍힙니다.

#### 3. 실전에서 보이는 모습

- CoreDNS 파드 하나가 죽었을 뿐인데 그 파드로 고정된 5-튜플을 쓰는 클라이언트는 다른 CoreDNS가 멀쩡해도 계속 실패합니다. 파드 하나의 장애가 DNS를 쓰는 서비스들 전체의 증상으로 보일 수 있습니다.
- 노드의 CPU, 메모리, 파드 `Running` 상태 같은 지표에는 이 상황이 드러나지 않습니다. 단서는 앱 로그의 `read udp ...:53: i/o timeout`과 노드의 `conntrack -L`에서 역방향 `src`가 이미 없는 파드 IP를 가리키는 항목입니다.

> **정리**: 고정 포트 하나, 남아 있는 항목 하나, 죽은 엔드포인트 하나가 맞물리면 대시보드는 조용한데 DNS만 계속 실패합니다. 아래 절은 그 맞물림을 슬라이드 기준으로 따라갑니다.

</details>

### 7-1. 출처와 범위

이 사례의 출처는 Cisco ThousandEyes의 Lead SRE Ricard Bejarano가 SREcon26 Americas에서 발표한 "The Inconspicuous Role of Conntrack in Kubernetes Networking"의 공개 슬라이드입니다. 장애일은 2025년 9월 4일이고 증상은 DNS `i/o timeout`이었습니다. 슬라이드의 상당 부분은 그림이라 텍스트로 확인한 내용만 옮깁니다. 슬라이드 환경 전제는 upstream 쿠버네티스, 리눅스 5.x 이상, containerd나 CRI-O 같은 일반 런타임입니다.

### 7-2. 슬라이드가 꼽은 원인 셋

슬라이드 마무리 장은 원인을 세 주체로 나눕니다.

| 주체 | 슬라이드 원문 | 이 글의 장과 연결 |
|---|---|---|
| Istio | "Extremely aggressive cache refresh mechanism. Reuse of the same client port for all DNS requests." | 4-3 같은 5-튜플 |
| kube-proxy | "Lack of a cleanup mechanism for stale conntrack entries of terminated pods. Fixed in v1.32." | 4-1 첫 패킷만 nat 규칙 |
| conntrack | "Default bidirectional UDP stream timeout setting of 2 minutes." | 4-3 `_stream` 120초 |

발단은 "A CoreDNS pod was OOMKilled"였습니다. ThousandEyes는 Istio를 사이드카 모드로 쓰고 있었습니다. 슬라이드는 Istio ServiceEntry의 DNS 재해석 주기에 대해 "This interval is hard-coded"라고 적습니다. Istio 문서 기준으로 `resolution: DNS` ServiceEntry의 재해석 주기는 30초이고 설정으로 바꿀 수 없습니다.

### 7-3. 세 원인이 맞물리는 방식

슬라이드의 세 문장을 이 글의 4장에 맞춰 이으면 이렇습니다.

1. 사이드카의 DNS 프록시가 kube-dns ClusterIP로 질의합니다. 첫 패킷이 nat 규칙을 타고 CoreDNS 파드 하나로 DNAT됩니다. conntrack에 그 엔드포인트를 가리키는 UDP 항목이 생깁니다.
2. 프록시는 모든 질의에 같은 클라이언트 포트를 씁니다. 5-튜플이 매번 같으므로 이후 질의는 nat 규칙을 다시 타지 않고 같은 항목을 따라 같은 엔드포인트로 갑니다.
3. 그 CoreDNS 파드가 OOMKilled로 종료됩니다. 이 종료된 파드를 가리키는 항목을 지워야 다음 패킷이 새 엔드포인트를 고릅니다. 당시 kube-proxy에는 이 낡은 항목을 확실히 지우는 장치가 없었습니다.
4. 질의는 30초 간격으로 계속 옵니다. 항목의 남은 시간은 120초(양방향 UDP 스트림 기본값) 안에서 매번 다시 채워지므로 항목이 만료되지 않습니다.
5. 질의가 응답 없는 곳으로 계속 가서 `i/o timeout`이 납니다. 다른 CoreDNS 파드가 멀쩡해도 이 5-튜플은 그쪽으로 갈 기회가 없습니다.

4번이 이 사례의 핵심입니다. conntrack 타임아웃은 "마지막 패킷 이후 경과 시간"으로 재므로 보내는 쪽이 멈추지 않는 한 낡은 항목은 스스로 사라지지 않습니다. 매번 새 출발지 포트를 쓰는 클라이언트였다면 질의마다 새 항목이 생기고 nat 규칙을 다시 타서 살아 있는 엔드포인트로 갔을 것입니다.

### 7-4. kube-proxy 쪽 수정: conntrack reconciler

슬라이드가 가리키는 이슈는 kubernetes/kubernetes #126130 "Implement a kube-proxy conntrack reconciler"(2024-07-16 등록)입니다. 이슈 본문의 설명은 이렇습니다.

- 기존 conntrack 정리 로직은 이벤트 기반이라 무언가 실패하면 다시 맞추지 않는다.
- 낡은 UDP 항목이 트래픽을 블랙홀로 만드는 문제에 많은 작업과 테스트가 들어갔지만 관련 보고가 계속 들어왔다.
- 다른 이슈들에서 이 정리가 필요한 프로토콜은 UDP뿐이라고 결론 냈다.
- reconciler는 낡았다고 확실히 아는 항목만 지우고 나머지는 타임아웃에 맡긴다.

수정 PR은 #127318 "proxy/conntrack: reconciler"이고 2024년 10월 31일 병합되어 v1.32(2024년 12월 출시)에 들어갔습니다. Service나 엔드포인트가 바뀔 때마다 conntrack 테이블을 Service와 엔드포인트 상태와 비교해 낡은 UDP 항목을 지우는 방식입니다. 병합 뒤에도 후속 수정이 이어졌습니다. 예를 들어 #130484 "conntrack reconciler must check the dst port"는 v1.33 마일스톤으로 2025년 3월에 병합됐습니다. 그래서 대응 기준은 후속 수정까지 들어간 최신 패치 버전으로 잡는 편이 안전합니다.

### 7-5. 대응

| 대응 | 하는 일 | 근거와 조건 |
|---|---|---|
| 최신 kube-proxy | 엔드포인트가 사라지면 해당 UDP 항목을 reconciler가 지움 | v1.32 이상, 후속 수정이 들어간 패치 버전 |
| NodeLocal DNSCache | 파드가 노드 로컬 캐시로 질의해 DNAT와 conntrack을 건너뜀. 캐시에서 CoreDNS로는 TCP로 올려 보낼 수 있음 | 공식 문서: TCP 항목은 연결 종료 때 지워지고 UDP 항목은 타임아웃을 기다려야 함 |
| 클라이언트 포트 재사용 점검 | 사이드카나 DNS 프록시가 고정 출발지 포트를 쓰는지 확인 | `conntrack -L`에서 같은 `sport` 항목의 남은 시간이 계속 다시 차는지 봄 |
| CoreDNS 메모리 한도 점검 | 발단인 OOMKilled 자체를 줄임 | [3편](/blog/theory/systems/k8s-linux-03-cgroup-qos)의 memory.max와 OOM 경로 참고 |

장애 중 임시로 항목을 지워야 한다면 `conntrack -D -p udp --orig-dst 10.96.0.10 --dport 53` 같은 명령이 있습니다. 노드의 모든 DNS 흐름을 끊는 명령이라 영향 범위를 알고 써야 합니다. 이 명령은 conntrack 도구의 일반 사용법이며 사례 슬라이드에는 나오지 않습니다.

### 7-6. 직접 해 보기

kind 클러스터에서 재현 실험을 설계해 볼 수 있습니다. 결과는 버전과 CNI에 따라 다를 수 있습니다.

```bash
# 1) 고정 출발지 포트로 10초마다 DNS 질의를 보내는 파드
kubectl -n shop run fixedport --image=nicolaka/netshoot --restart=Never -- \
  sh -c 'while true; do dig @10.96.0.10 -b 0.0.0.0#40000 order-api.shop.svc.cluster.local +tries=1 +time=2; sleep 10; done'

# 2) 노드에서 그 항목과 엔드포인트 확인
conntrack -L -p udp --sport 40000 2>/dev/null

# 3) 역방향 튜플에 보이는 CoreDNS 파드를 지우고 항목이 어떻게 되는지 관찰
kubectl -n kube-system delete pod <해당 CoreDNS 파드>
conntrack -L -p udp --sport 40000 2>/dev/null
```

kube-proxy v1.32 이상이라면 3)에서 해당 항목이 지워지고 다음 질의가 다른 CoreDNS로 가는지 봅니다. 구버전 kind 노드 이미지를 구할 수 있다면 같은 실험을 비교합니다.

kind v1.37.0(kube-proxy v1.37.0)에서 이 실험을 그대로 돌렸습니다. `dig -b 0.0.0.0#40000`은 의도대로 출발지 포트 40000을 고정했고 항목은 `[ASSURED]`, 남은 시간 111~118초로 유지됐습니다. 역방향 `src`가 10.244.0.4인 CoreDNS 파드를 지우자 5초와 10초 시점에는 항목이 그대로였고 15초 시점에는 역방향 `src`가 10.244.0.3인 새 항목(남은 30초 이하, ASSURED 없음)으로 바뀌어 있었습니다. 다음 질의부터 다시 `[ASSURED]`가 붙었고 그동안 `dig` 출력에 실패는 없었습니다. CoreDNS는 종료 신호를 받은 뒤 잠시 응답을 계속하므로 이 실험은 "응답 없는 엔드포인트로 가는" 구버전 증상까지 재현하지는 못합니다. 구버전 이미지 비교는 하지 않았습니다.

## 확인 문제

1. iptables 모드 kube-proxy를 쓰는 노드에서 `ip addr`로 ClusterIP를 찾을 수 없는 이유는 무엇인가요?

<details><summary>정답</summary>

ClusterIP는 nat 테이블 규칙의 매치 조건으로만 존재합니다. kube-proxy가 `KUBE-SERVICES`에 `-d <ClusterIP> --dport <port>` 규칙을 씁니다. 패킷이 그 조건에 맞으면 DNAT됩니다. 주소를 인터페이스에 붙이는 것은 IPVS 모드(`kube-ipvs0`)뿐입니다.

</details>

2. 엔드포인트가 4개인 Service의 `KUBE-SVC` 체인에서 각 규칙의 확률은 어떻게 나오나요?

<details><summary>정답</summary>

0.25, 0.333..., 0.5, 그리고 마지막 규칙은 statistic 매치 없이 무조건 점프입니다. `proxier.go`가 i번째 규칙에 `1/(남은 엔드포인트 수)`를 넣으므로 각 엔드포인트가 전체의 1/4씩 받습니다.

</details>

3. 노드에서 직접 `curl 10.96.120.15`를 실행했을 때와 파드에서 실행했을 때 패킷이 `KUBE-SERVICES`를 만나는 내장 체인은 각각 어디인가요?

<details><summary>정답</summary>

노드 프로세스가 보낸 패킷은 nat OUTPUT, 파드에서 보낸 패킷은 veth를 지나 노드 네임스페이스로 들어오므로 nat PREROUTING입니다. kube-proxy가 두 곳 모두에 `KUBE-SERVICES` 점프를 거는 이유입니다.

</details>

4. `KUBE-MARK-MASQ`는 패킷의 무엇을 바꾸나요?

<details><summary>정답</summary>

주소는 바꾸지 않고 방화벽 마크(기본 `0x4000`)만 붙입니다. 실제 출발지 변환은 nat POSTROUTING의 `KUBE-POSTROUTING`이 그 마크를 보고 MASQUERADE로 합니다.

</details>

5. TCP 연결 하나가 맺어진 뒤 그 연결의 엔드포인트 파드가 Service에서 빠지면 이미 맺어진 연결의 패킷은 어디로 가나요?

<details><summary>정답</summary>

conntrack 항목이 살아 있는 동안은 처음 고른 엔드포인트로 계속 갑니다. nat 규칙은 새 연결의 첫 패킷만 보기 때문입니다. TCP는 종료나 RST로 항목이 정리됩니다. UDP는 타임아웃이 지나야 사라지므로 이 사례처럼 문제가 됩니다.

</details>

6. UDP conntrack 항목의 남은 시간이 120초인데 같은 5-튜플로 30초마다 패킷이 온다면 이 항목은 언제 사라지나요?

<details><summary>정답</summary>

패킷이 계속 오는 한 사라지지 않습니다. 타임아웃은 마지막 패킷을 본 시점부터 다시 계산됩니다. 보내는 쪽이 멈추거나 출발지 포트를 바꾸면 그때부터 타임아웃이 흘러 사라집니다. 그 전에 없애려면 kube-proxy reconciler나 `conntrack -D`가 지워야 합니다.

</details>

7. `dnsPolicy: ClusterFirst` 파드에서 `api.example.com`을 해석할 때 바로 그 이름으로 질의하지 않는 이유는 무엇인가요?

<details><summary>정답</summary>

kubelet이 써 준 resolv.conf에 `options ndots:5`가 있어서 점이 5개 미만인 이름은 search 목록(`<ns>.svc.cluster.local`, `svc.cluster.local`, `cluster.local`)을 먼저 붙여 시도합니다. 끝에 점을 붙인 절대 이름을 쓰면 search 목록을 건너뜁니다.

</details>

8. NodeLocal DNSCache가 이 글의 사례 같은 문제를 줄이는 원리는 무엇인가요?

<details><summary>정답</summary>

파드가 같은 노드의 캐시에 질의하므로 iptables DNAT와 conntrack을 건너뜁니다. 캐시에서 CoreDNS로 가는 구간은 TCP로 올릴 수 있습니다. TCP 항목은 연결 종료 때 지워지므로 낡은 UDP 항목이 오래 남는 상황이 줄어듭니다.

</details>

## 범위와 한계

- 2026-10-20에 kind v0.33 + 노드 v1.37.0(colima, arm64, VM 커널 6.8.0-117-generic, Ubuntu 24.04.4, kube-proxy iptables 모드, CNI kindnet)에서 1-4, 2-3, 3-7, 4-5, 5-4, 6-3, 7-6의 과제를 돌렸습니다. 실측 출력은 각 과제 아래에 붙였습니다. 3-2~3-5의 앞쪽 블록과 4-4의 표 예시는 kube-proxy 소스와 공식 문서로 만든 형태 예시이고 해시와 IP는 지어낸 값입니다.
- 돌리지 못한 것: nftables 모드와 IPVS 모드 비교, Calico 설치(169.254.1.1 게이트웨이와 proxy ARP), 구버전 kube-proxy로 7-6 비교, `conntrack -D` 실행. colima 네트워크가 모든 주소의 ICMP에 대신 응답해서 ClusterIP ping 불가는 이 환경에서 확인하지 못했습니다.
- kube-proxy 모드 상태는 2026년 10월(v1.37) 기준입니다. 리눅스 기본값이 nftables로 바뀌는 시점은 문서가 예고만 하고 버전을 정하지 않았습니다. IPVS의 v1.40 기본 비활성과 v1.43 제거는 KEP-5495의 계획입니다.
- `KUBE-SVC` 첫 줄의 `! -s <파드 CIDR> ... -j KUBE-MARK-MASQ` 형태는 kube-proxy에 클러스터 CIDR 정보가 있을 때 기준이며 `masqueradeAll`이나 로컬 트래픽 판별 방식에 따라 달라집니다. 버전별 차이는 확인하지 않았습니다.
- 사례는 SREcon26 Americas 슬라이드의 텍스트만 근거로 썼습니다. 슬라이드의 그림(타임라인, 경로 도식)은 텍스트로 추출되지 않아 확인하지 못했습니다. 그래서 OOMKilled 뒤 CoreDNS 파드가 같은 IP로 다시 떴는지, 장애가 얼마나 이어졌는지, 어떻게 복구했는지는 쓰지 않았습니다. 7-3의 단계 설명은 슬라이드의 세 원인을 4장의 conntrack 동작에 맞춰 제가 이은 것입니다.
- #127318 이후 후속 수정은 #130484 하나만 직접 확인했습니다. 성능 회귀 보고와 다른 후속 PR, 이전 버전 체리픽(#127780)의 세부와 각 패치 버전 번호는 확인하지 않았습니다.
- UDP 흐름이 `_stream` 타임아웃으로 넘어가는 정확한 조건은 커널 버전마다 다르며 이 글에서는 커널 문서의 설명("UDP stream이 감지되면")까지만 적었습니다.
- Calico의 TTL 동작과 169.254.1.1 게이트웨이는 Calico FAQ 기준입니다. 다른 CNI(Flannel, Cilium 등)에서는 경로와 TTL 변화가 다릅니다.
- 7-6의 재현 실험은 v1.37에서만 돌렸습니다. 고정 포트와 5-튜플 유지는 확인했고 reconciler가 없는 구버전의 블랙홀 증상은 재현하지 않았습니다.

## 참고 자료

쿠버네티스 문서와 소스
- [Virtual IPs and Service Proxies](https://kubernetes.io/docs/reference/networking/virtual-ips/)
- [Service](https://kubernetes.io/docs/concepts/services-networking/service/)
- [DNS for Services and Pods](https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/)
- [Using NodeLocal DNSCache in Kubernetes Clusters](https://kubernetes.io/docs/tasks/administer-cluster/nodelocaldns/)
- [Debugging DNS Resolution](https://kubernetes.io/docs/tasks/administer-cluster/dns-debugging-resolution/)
- [kubeadm init](https://kubernetes.io/docs/reference/setup-tools/kubeadm/kubeadm-init/)
- [Pod v1 API (containerPort)](https://kubernetes.io/docs/reference/kubernetes-api/workload-resources/pod-v1/)
- [kubernetes/pkg/proxy/iptables/proxier.go](https://github.com/kubernetes/kubernetes/blob/master/pkg/proxy/iptables/proxier.go)
- [KEP-5495: Deprecate IPVS mode in kube-proxy](https://kubernetes.dev/resources/keps/5495)
- [Kubernetes v1.33 release blog](https://kubernetes.io/blog/2025/04/23/kubernetes-v1-33-release/)
- [CoreDNS 배포 매니페스트(coredns.yaml.sed)](https://github.com/coredns/deployment/blob/master/kubernetes/coredns.yaml.sed)

이슈와 PR
- [kubernetes #126130: Implement a kube-proxy conntrack reconciler](https://github.com/kubernetes/kubernetes/issues/126130)
- [kubernetes #127318: proxy/conntrack: reconciler](https://github.com/kubernetes/kubernetes/pull/127318)
- [kubernetes #130484: conntrack reconciler must check the dst port](https://github.com/kubernetes/kubernetes/pull/130484)

커널과 도구
- [Netfilter Conntrack Sysfs variables (nf_conntrack-sysctl)](https://docs.kernel.org/networking/nf_conntrack-sysctl.html)
- [netfilter: conntrack: udp: set stream timeout to 2 minutes (294304e4)](https://github.com/torvalds/linux/commit/294304e4c522d797b7ea8200ab74354843fa68e9)
- [iptables(8)](https://man7.org/linux/man-pages/man8/iptables.8.html)
- [nsswitch.conf(5)](https://man7.org/linux/man-pages/man5/nsswitch.conf.5.html)
- [tcpdump(1)](https://www.tcpdump.org/manpages/tcpdump.1.html)
- [RFC 6891: Extension Mechanisms for DNS (EDNS(0))](https://www.rfc-editor.org/rfc/rfc6891)
- [iptables-extensions(8) (MASQUERADE, --random-fully)](https://man7.org/linux/man-pages/man8/iptables-extensions.8.html)
- [Ubuntu kernel-team: Fix nf_conntrack races when dealing with same origin requests in NAT environments (2019)](https://lists.snapcraft.io/archives/kernel-team/2019-July/102291.html)
- [kubernetes #56903: DNS intermittent delays of 5s](https://github.com/kubernetes/kubernetes/issues/56903)
- [Bruno Ferreira, DNS hell in Kubernetes](https://dev.to/bmbferreira/dns-hell-in-k8s-4m6i)

사례와 CNI
- Ricard Bejarano, [The Inconspicuous Role of Conntrack in Kubernetes Networking](https://www.usenix.org/conference/srecon26americas/presentation/bejarano), SREcon26 Americas ([슬라이드 PDF](https://www.usenix.org/system/files/sre26amer_slides_bejarano.pdf))
- [Istio: DNS Proxying](https://istio.io/latest/docs/ops/configuration/traffic-management/dns/)
- [Calico FAQ](https://docs.tigera.io/calico/latest/reference/faq)

이 블로그의 관련 글
- [CKA Ch-04: 서비스와 네트워킹](/blog/cert/cka/cka-04-services-networking)
- [쿠버네티스 아래의 리눅스 2: 네임스페이스와 pause](/blog/theory/systems/k8s-linux-02-namespaces-pause)
- [쿠버네티스 아래의 리눅스 3: cgroup과 QoS](/blog/theory/systems/k8s-linux-03-cgroup-qos)

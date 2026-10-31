---
title: '[CKA] 서비스와 네트워킹: Pod IP에서 Gateway API까지 한 줄로 잇기'
description: CKA 커리큘럼 v1.37의 Services and Networking 영역(20%)을 시험 과제 중심으로 정리합니다. Pod 연결과 대역 확인, NetworkPolicy의 AND/OR와 DNS 허용, Service 타입과 EndpointSlice, Gateway API(HTTPRoute 매칭, 가중치, 필터, TLS, ReferenceGrant), Ingress와 pathType, CoreDNS 설정과 점검 순서를 시험에서 쓰는 명령과 YAML, 자주 틀리는 지점, 연습 과제로 묶었습니다.
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
unlisted: true
series: "CKA 공부"
seriesOrder: 7
---

## 결론부터

1. 모든 Pod는 클러스터 전체에서 고유한 IP를 받고 NAT 없이 서로 통신합니다. 이 규칙을 구현하는 쪽은 CNI 플러그인이고 NetworkPolicy를 집행하는 쪽도 대개 같은 플러그인이라서 정책이 효과가 없으면 플러그인부터 의심합니다.
2. NetworkPolicy는 허용 목록만 있습니다. 어떤 정책이 Pod를 선택하는 순간 그 방향(Ingress 또는 Egress)은 격리되고 정책들의 허용 범위를 합친 만큼만 열립니다. 가장 많이 틀리는 곳은 `from` 아래 `namespaceSelector`와 `podSelector`를 한 항목에 쓰는지(AND) 두 항목으로 나누는지(OR)입니다.
3. Service가 응답하지 않을 때 가장 먼저 볼 것은 `kubectl get endpointslices -l kubernetes.io/service-name=<이름>`의 ENDPOINTS 열입니다. 비어 있으면 selector와 라벨, 또는 Pod의 Ready 상태 문제입니다.
4. Gateway API는 Ingress의 후속입니다. GatewayClass, Gateway, HTTPRoute가 무엇을 참조하는지만 잡으면 YAML은 짧습니다. Ingress API는 동결(frozen)됐지만 제거 계획이 없으니 둘 다 손에 익혀 둡니다.
5. CoreDNS의 Service 이름은 호환성 때문에 `kube-dns`이고 Pod 라벨도 `k8s-app=kube-dns`입니다. DNS 문제는 Pod의 `/etc/resolv.conf`, CoreDNS Pod, `kube-dns` Service와 EndpointSlice, `coredns` ConfigMap 순서로 좁혀 갑니다.

---

커리큘럼(CNCF, CKA Curriculum v1.37)의 이 영역 항목은 여섯 개입니다. 영역 이름은 PDF에 "Servicing and Networking"으로, Linux Foundation 시험 페이지에는 "Services & Networking"으로 나옵니다.

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

<details>
<summary>기초부터: 스위치, 라우터, 게이트웨이와 라우팅 테이블</summary>

> **핵심 한 줄**: 같은 대역은 스위치가 잇고 다른 대역은 라우터가 잇습니다. 어느 라우터로 넘길지는 커널의 라우팅 테이블 한 줄이 정합니다.

#### 1. 왜 필요한가

쿠버네티스 네트워크는 리눅스 네트워크 위에 올라가 있습니다. 노드가 Pod 패킷을 다른 노드로 넘기는 라우터 역할을 하니 Pod끼리 통신이 안 될 때는 노드에서 `ip route`를 읽어야 합니다.

#### 2. 어떻게 동작하나

1. **같은 네트워크 안(스위치)**: A(192.168.1.10)와 B(192.168.1.11)가 같은 대역 192.168.1.0/24에 있으면 스위치에 연결하는 것만으로 통신합니다. 스위치는 MAC 주소를 보고 프레임을 전달합니다. 각 컴퓨터에는 인터페이스(`eth0` 같은 랜카드)가 있고 거기에 IP가 붙어 있어야 합니다.
2. **다른 네트워크로(라우터와 게이트웨이)**: 다른 대역의 C(192.168.2.10)로 보내려면 두 네트워크에 동시에 발을 걸친 라우터가 필요합니다. 라우터는 양쪽에 각각 IP(192.168.1.1, 192.168.2.1)를 두고 한쪽에서 받은 패킷을 다른 쪽으로 넘깁니다. A 입장에서 "저 네트워크로 가려면 여기에 넘겨라"라고 정해 둔 라우터 주소가 게이트웨이입니다. 방에서 밖으로 나가는 문을 정해 두는 것과 비슷하고 실제로는 라우팅 테이블에 한 줄로 적힙니다.
3. **모르는 대역 전부(기본 게이트웨이)**: 인터넷의 모든 대역을 한 줄씩 적을 수 없으니 "어느 줄에도 안 맞으면 여기로"라는 줄을 둡니다. `ip route`에 `default via 192.168.1.1`(0.0.0.0/0과 같은 뜻)로 보입니다. 커널은 목적지와 가장 길게 일치하는 줄을 고르고 맞는 줄이 없을 때 default 줄을 씁니다.
4. **리눅스를 라우터로 쓰기(IP 포워딩)**: 인터페이스가 둘인 리눅스도 기본으로는 한쪽에서 받은 패킷을 다른 쪽으로 넘기지 않습니다. 보안을 위해 꺼 둔 것이라 `net.ipv4.ip_forward`를 1로 켜야 합니다. `sysctl -w`나 `/proc/sys/net/ipv4/ip_forward`에 쓴 값은 재부팅하면 돌아가므로 영구 적용은 `/etc/sysctl.d/` 아래 파일에 적습니다.

```text
A 192.168.1.10 ──스위치── 라우터(192.168.1.1 | 192.168.2.1) ──스위치── C 192.168.2.10
   A의 경로: 192.168.2.0/24 via 192.168.1.1     C의 경로: 192.168.1.0/24 via 192.168.2.1
   (응답이 돌아오려면 양쪽 모두에 경로가 있어야 함)
```

```bash
ip link                                       # 인터페이스 목록과 상태
ip addr                                       # 인터페이스별 IP
ip addr add 192.168.1.10/24 dev eth0          # IP 붙이기 (재부팅하면 사라짐)
ip route                                      # 라우팅 테이블 보기
ip route add 192.168.2.0/24 via 192.168.1.1   # 이 대역은 192.168.1.1로 넘겨라
```

#### 3. 한눈에 비교

| 구분 | 스위치 | 라우터(게이트웨이) |
|---|---|---|
| 잇는 범위 | 같은 대역 안 | 서로 다른 대역 사이 |
| 보는 주소 | MAC 주소 | IP 주소와 라우팅 테이블 |
| 리눅스에서 | 브리지(다음 토글) | `ip route`와 `ip_forward` |

#### 4. 헷갈리는 점 / 실전에서 보이는 모습

- 통신은 왕복입니다. 한쪽에만 경로를 넣으면 요청은 가는데 응답이 돌아오지 못해 타임아웃으로 보입니다.
- 쿠버네티스 노드는 Pod 패킷을 다른 노드로 넘겨야 하니 ip_forward가 켜져 있어야 하고 다른 노드의 Pod 대역으로 가는 경로가 있어야 합니다. 1-6절 점검 표의 마지막 두 줄이 이 둘을 확인하는 명령입니다.

> **정리**: 통신은 왕복이라 경로는 양쪽에 다 있어야 합니다. 리눅스 노드가 라우터 노릇을 하려면 ip_forward도 켜야 합니다. 다음 토글에서는 이 장비들을 한 호스트 안에 가상으로 만듭니다.

</details>

<details>
<summary>기초부터: 네트워크 네임스페이스, veth, 브리지, NAT</summary>

> **핵심 한 줄**: 네트워크 네임스페이스는 커널 안의 독립된 방이고 veth는 방을 잇는 케이블, 브리지는 방들을 모으는 가상 스위치, NAT는 방 주소를 바깥 주소로 바꾸는 규칙입니다.

#### 1. 왜 필요한가

Pod마다 IP가 따로 있는 것은 Pod마다 네트워크 네임스페이스가 따로 있기 때문입니다. 컨테이너 네트워크를 손으로 한 번 만들어 보면 CNI 플러그인이 대신 해 주는 일이 그대로 보입니다.

| 부품 | 비유 | 실제 동작 |
|---|---|---|
| **네트워크 네임스페이스** | 집 안의 방 | 인터페이스, 라우팅 테이블, ARP 테이블, iptables 규칙을 따로 가진 네트워크 스택 한 벌 |
| **veth 쌍** | 양 끝이 있는 케이블 | 한 끝으로 들어간 패킷이 다른 끝으로 나옴. 한쪽을 지우면 짝도 사라짐 |
| **리눅스 브리지** | 가상 스위치 | 여러 veth 끝을 꽂아 한 대역으로 묶음. IP를 주면 호스트와도 통신 |
| **MASQUERADE / DNAT** | 주소 바꿔 쓰기 | 나갈 때 출발지를 호스트 주소로, 들어올 때 목적지를 컨테이너 주소로 바꿈 |

#### 2. 어떻게 동작하나

1. **방 만들기**: `ip netns add red`, `ip netns add blue`. 새 네임스페이스에는 `lo` 하나뿐이고 호스트의 `eth0`은 보이지 않습니다(`ip -n red link`). 호스트(루트 네임스페이스)는 `ip netns` 같은 도구로 모든 방에 들어가 볼 수 있습니다.
2. **두 방을 케이블로 잇기**: veth 쌍의 한 끝을 red에, 다른 끝을 blue에 넣고 IP를 주면 둘이 통신합니다.
3. **방이 많아지면 브리지**: 모든 쌍을 케이블로 이을 수 없으니 호스트에 브리지(`ip link add v-net-0 type bridge`)를 만들고 각 veth 반대쪽 끝을 꽂습니다(`ip link set <끝> master v-net-0`). 브리지에 IP(예: 192.168.15.5)를 주면 호스트와 네임스페이스가 통신합니다.
4. **바깥으로 나가는 경로**: 네임스페이스의 기본 게이트웨이를 브리지 IP로 지정합니다(`ip -n blue route add default via 192.168.15.5`). 호스트는 ip_forward가 켜져 있어야 넘겨 줍니다.
5. **주소 변환**: 192.168.15.x는 바깥이 모르는 사설 주소라 응답이 돌아오지 못합니다. 출발지를 호스트 주소로 바꾸는 MASQUERADE를 겁니다(`iptables -t nat -A POSTROUTING -s 192.168.15.0/24 -j MASQUERADE`). 반대로 호스트 8080으로 온 요청을 192.168.15.2:80으로 보내려면 목적지를 바꾸는 DNAT를 겁니다.

```bash
ip link add veth-red type veth peer name veth-blue
ip link set veth-red netns red
ip link set veth-blue netns blue
ip -n red addr add 192.168.15.1/24 dev veth-red
ip -n blue addr add 192.168.15.2/24 dev veth-blue
ip -n red link set veth-red up
ip -n blue link set veth-blue up
```

```text
[나가는 패킷]  blue(192.168.15.2) → veth → v-net-0(192.168.15.5) → 호스트 라우팅
               → MASQUERADE(출발지를 호스트 IP로) → eth0 → 외부
[들어오는 패킷] 외부 → 호스트 eth0:8080 → DNAT(목적지를 192.168.15.2:80으로) → v-net-0 → veth → blue
```

#### 3. 쿠버네티스에서는

| 손으로 한 것 | 쿠버네티스에서 맡는 곳 |
|---|---|
| 네임스페이스 하나 | Pod 하나. 같은 Pod의 컨테이너는 이 네임스페이스를 함께 써서 `localhost`로 통신 |
| veth 넣기, IP 주기, 경로 잡기 | Pod가 생길 때마다 CNI 플러그인 |
| DNAT | Docker의 `-p 8080:80`, iptables 모드 kube-proxy의 Service 구현이 같은 원리 |

커널 쪽 구조는 [쿠버네티스 아래의 리눅스 2편](/blog/theory/systems/k8s-linux-02-namespaces-pause)에 더 자세히 있습니다.

#### 4. 실전에서 방 안으로 들어가 보기

컨테이너 런타임이 만든 네임스페이스는 `ip netns` 목록에 이름으로 나오지 않는 경우가 많습니다. 이럴 때는 컨테이너 프로세스의 PID로 그 네트워크 네임스페이스에 들어갑니다.

1. **PID 찾기**: 노드에서 `crictl ps`로 컨테이너 ID를 찾고 `crictl inspect <컨테이너 ID>` 출력의 `pid` 값을 봅니다.
2. **들어가서 보기**: `nsenter -t <PID> -n ip addr`, `nsenter -t <PID> -n ip route`처럼 `-n`(네트워크 네임스페이스만)을 주면 노드에 있는 `ip`, `ss`, `tcpdump`를 Pod의 네트워크 시점으로 실행합니다. 이미지에 도구가 없어도 됩니다.
3. **바깥에서 보기**: 노드에서 `ip link`로 veth 끝이 브리지(또는 CNI 인터페이스)에 붙어 있는지, `iptables -t nat -L -n`으로 NAT 규칙이 있는지 봅니다.

| 볼 것 | 정상이면 |
|---|---|
| Pod 안 `ip addr` | `eth0`이 UP이고 Pod 대역 IP가 있다 |
| Pod 안 `ip route` | `default via <게이트웨이>` 줄이 있다 |
| 노드 `sysctl net.ipv4.ip_forward` | 1 |

자주 쓰는 도구를 더 모으면 이렇습니다.

| 하려는 일 | 명령 |
|---|---|
| Docker 컨테이너의 PID | `docker inspect -f '{{.State.Pid}}' <컨테이너>` |
| 이름 붙은 네임스페이스 안 패킷 저장 | `ip netns exec <ns> tcpdump -i any -w out.pcap` |
| NAT가 걸린 연결 목록 | `conntrack -L` (conntrack 도구가 설치돼 있어야 함) |
| NAT 규칙과 적중 횟수, 줄 번호 | `iptables -t nat -L -n -v --line-numbers` |
| 브리지에 꽂힌 끝 | `bridge link` |

Pod 통신이 안 될 때는 안에서 밖으로 넓혀 갑니다.

1. Pod 안의 인터페이스와 기본 경로
2. 노드에서 veth 짝이 브리지(또는 CNI 인터페이스)에 붙었는지
3. iptables와 conntrack과 ip_forward
4. 마지막으로 CNI 에이전트의 상태와 로그

에이전트 상태는 플러그인 도구로도 봅니다(Calico `calicoctl node status`, Cilium `cilium status`).

| 플러그인 | 노드 사이를 잇는 방식(대표 설정) |
|---|---|
| Flannel | VXLAN 터널이 기본 백엔드. 구조가 가장 단순하고 NetworkPolicy는 집행하지 않는다 |
| Calico | 노드 라우팅 테이블에 Pod 경로를 넣고 BGP로 경로를 나눈다. IPIP나 VXLAN 캡슐화도 고를 수 있다 |
| Cilium | eBPF로 패킷을 처리한다. 설정하면 kube-proxy를 대신해 Service도 처리한다 |

> **정리**: Pod 통신이 안 되면 Pod 안 인터페이스와 경로에서 시작해 veth와 브리지, NAT 규칙, CNI 에이전트 순서로 넓혀 봅니다. Docker와 CNI 플러그인이 하는 일은 위의 다섯 단계와 같습니다.

</details>

<details>
<summary>기초부터: Docker 네트워크 모드 none, host, bridge</summary>

> **핵심 한 줄**: Docker의 bridge 모드는 앞 토글에서 손으로 만든 네임스페이스, veth, 브리지, NAT 구조를 자동으로 만든 것이고 Pod 네트워크의 뼈대와 같습니다.

#### 1. 왜 필요한가

Docker가 컨테이너 네트워크를 어떻게 만드는지 보면 쿠버네티스 Pod 네트워크의 뼈대가 보입니다. `docker run --network <모드>`로 고르는 기본 모드는 셋입니다.

#### 2. 한눈에 비교

| 모드 | 컨테이너가 받는 것 | 결과 |
|---|---|---|
| `none` | 자기 네트워크 네임스페이스와 `lo`만 | 외부와도 다른 컨테이너와도 통신하지 못한다 |
| `host` | 호스트의 네트워크 네임스페이스를 그대로 | 포트 매핑 없이 호스트 IP와 포트로 바로 접근된다. 대신 80번을 쓰는 컨테이너 둘을 한 호스트에 띄울 수 없다 |
| `bridge` (기본) | 자기 네임스페이스, veth 한 쌍, 사설 IP | 같은 브리지의 컨테이너끼리 통신한다. 외부에서 들어오려면 포트 매핑이 필요하다 |

#### 3. bridge 모드는 어떻게 동작하나

1. **브리지 준비**: Docker를 설치하면 호스트에 `docker0` 브리지가 생기고 기본으로 172.17.0.1/16 같은 주소를 받습니다.
2. **컨테이너 연결**: 컨테이너마다 네트워크 네임스페이스를 만들고 veth 한 끝은 컨테이너 안 `eth0`으로, 다른 끝(`vethXXXX`)은 `docker0`에 꽂습니다.
3. **나가는 길**: 컨테이너는 172.17.0.x 사설 IP를 받고 기본 게이트웨이는 `docker0`입니다. 바깥으로 나갈 때 호스트의 MASQUERADE 규칙으로 출발지 주소가 바뀝니다.
4. **들어오는 길**: `docker run -p 8080:80 nginx`를 하면 Docker가 nat 테이블에 "호스트 8080으로 온 패킷의 목적지를 컨테이너 IP:80으로 바꿔라"는 DNAT 규칙을 넣습니다.

```text
외부 → 호스트:8080 → [DNAT] → docker0 → vethXXXX → 컨테이너 eth0(172.17.0.2:80)
컨테이너 → eth0 → vethXXXX → docker0 → [MASQUERADE] → 호스트 eth0 → 외부
```

```bash
docker network ls               # bridge, host, none
ip addr show docker0            # 호스트의 브리지
iptables -t nat -L -n           # Docker가 넣은 MASQUERADE, DNAT 규칙
```

- **veth 짝 맞추기**: 호스트 `ip link`에 `vethXXXX@if7`처럼 보이면 짝은 인터페이스 번호 7입니다. 컨테이너 안에서 `ip link`를 보면 `7: eth0@if8`처럼 번호가 서로를 가리킵니다. 짝은 대개 이웃한 번호라 두 줄을 맞춰 보면 어느 veth가 어느 컨테이너 것인지 압니다.
- **컨테이너 쪽 정보**: `docker inspect <컨테이너>`의 `NetworkSettings`에 IP 주소, MAC 주소, 게이트웨이와 네트워크 네임스페이스 파일 경로(`SandboxKey`, `/var/run/docker/netns/` 아래)가 나옵니다.
- **ip netns에 안 보이는 이유**: `ip netns`는 `/var/run/netns` 아래만 읽습니다. Docker는 네임스페이스를 자기 디렉터리에 두므로 그 파일을 `/var/run/netns/<이름>`으로 심볼릭 링크해야 `ip netns exec`로 들어갈 수 있습니다. PID를 아는 경우는 앞 토글의 `nsenter -t <PID> -n`이 더 간단합니다.

#### 4. 쿠버네티스와 이어 보기

| Docker | 쿠버네티스 |
|---|---|
| Docker가 직접 네트워크를 만든다 | 1.24 이후 노드 런타임은 containerd나 CRI-O이고 Pod 네트워크는 CNI 플러그인이 만든다 |
| bridge 모드 | "Pod마다 네임스페이스, veth로 노드에 연결, 노드에서 NAT와 DNAT"라는 같은 뼈대 |
| host 모드 | Pod 스펙의 `hostNetwork: true` |

> **정리**: none은 고립, host는 호스트 공유, bridge는 네임스페이스와 veth와 NAT입니다. 쿠버네티스는 bridge 모드의 뼈대를 노드 여러 대로 넓힌 것이고 그 방법이 다음 토글입니다.

</details>

Cluster Networking 문서는 풀어야 할 문제를 넷으로 나눕니다.

| 통신 | 맡는 것 |
|---|---|
| 같은 Pod 안 컨테이너끼리 | `localhost`(네트워크 네임스페이스 공유) |
| Pod와 Pod | Pod 네트워크 |
| Pod와 Service | Service |
| 클러스터 밖에서 들어오는 트래픽 | NodePort, LoadBalancer, Ingress, Gateway |

이 중 Pod 네트워크가 지켜야 할 약속은 셋입니다.

- 클러스터의 모든 Pod는 클러스터 전체에서 고유한 IP를 받습니다.
- 의도적으로 네트워크를 나누지 않았다면 모든 Pod는 같은 노드든 다른 노드든 프록시나 NAT 없이 직접 통신합니다.
- 노드의 에이전트(시스템 데몬, kubelet)는 그 노드의 모든 Pod와 통신할 수 있습니다.

### 1-2. 누가 무엇을 구현하나

<details>
<summary>기초부터: Pod 네트워크를 직접 만든다면 (노드별 대역, 노드 간 경로, 오버레이)</summary>

> **핵심 한 줄**: 노드마다 겹치지 않는 Pod 대역을 주고 노드 사이에 경로(또는 터널)를 깔면 모든 Pod가 NAT 없이 서로 닿습니다. 이 일을 자동으로 하는 것이 CNI 플러그인입니다.

#### 1. 왜 필요한가

쿠버네티스가 정하는 것은 Pod 네트워크의 규칙뿐입니다. 모든 Pod가 고유 IP를 받고 같은 노드든 다른 노드든 NAT 없이 서로 닿아야 한다는 규칙입니다(1-1절). 이 규칙을 맞추려면 무엇을 해야 하는지 노드 두 대(192.168.1.11, 192.168.1.12)로 따라가 봅니다.

#### 2. 어떻게 동작하나

1. **노드마다 브리지와 서로 다른 대역**: 노드1은 10.244.1.0/24, 노드2는 10.244.2.0/24를 줍니다. 대역이 겹치면 같은 IP의 Pod가 두 노드에 생길 수 있어 고유 IP 규칙이 깨집니다.
2. **Pod가 생길 때마다 연결**: veth 한 끝은 Pod 안 `eth0`으로, 다른 끝은 노드 브리지에 꽂고 남는 IP 하나(10.244.1.2)를 줍니다. 기본 게이트웨이는 브리지 IP(10.244.1.1)입니다. 여기까지면 같은 노드의 Pod끼리 통신합니다.
3. **노드 사이의 경로**: 노드1은 10.244.2.0/24가 어디 있는지 모릅니다. 노드1에 "10.244.2.0/24는 192.168.1.12로", 노드2에 반대 방향 경로를 넣으면 클러스터 전체가 10.244.0.0/16 하나로 묶입니다. 노드들이 같은 L2 네트워크에 있을 때 쓸 수 있습니다.
4. **경로를 넣을 수 없으면 오버레이**: 노드가 다른 서브넷에 있거나 중간 장비가 Pod 대역을 모르면 캡슐화를 씁니다. 출발 노드가 Pod끼리의 원래 패킷을 노드 IP끼리의 바깥 패킷 안에 통째로 넣어 보내고 목적지 노드가 바깥 헤더를 벗겨 Pod에 넘깁니다. 소포를 한 번 더 포장해 보내는 것과 비슷합니다.

```text
[경로 방식]
Pod A 10.244.1.2 → cni 브리지(노드1) → 노드1 라우팅 "10.244.2.0/24 via 192.168.1.12"
   → 노드2 eth0 → cni 브리지(노드2) → Pod B 10.244.2.2

[오버레이(VXLAN) 방식]
Pod A → 노드1 [안: 10.244.1.2→10.244.2.2 | 겉: 192.168.1.11→192.168.1.12로 포장]
   → 물리 네트워크 → 노드2 [겉 헤더 벗김] → Pod B
```

#### 3. 한눈에 비교

| 구분 | 경로 방식 | 오버레이 |
|---|---|---|
| 조건 | 노드가 같은 L2 네트워크, 경로를 넣을 수 있음 | 노드가 다른 서브넷이어도 됨 |
| 패킷 | 원래 패킷 그대로 | 원래 패킷을 노드 IP 패킷 안에 넣음 |
| 예 | 노드 라우팅 테이블에 Pod 대역 경로 | VXLAN. Flannel의 기본 백엔드 |

옛 강의의 Weave Net도 노드마다 에이전트를 DaemonSet으로 띄워 서로 Pod 위치를 공유하고 캡슐화로 전달하는 방식이었습니다(지금은 저장소가 보관된 프로젝트입니다).

#### 4. 누가 자동으로 하나

| 단계 | 맡는 곳 |
|---|---|
| 2단계(Pod 연결) | 런타임이 Pod를 만들 때마다 부르는 CNI 플러그인 |
| 1단계와 3단계(대역 나누기, 경로나 터널 유지) | 플러그인이 DaemonSet으로 띄운 에이전트 |

노드 사이 Pod 통신만 안 되면 이 에이전트부터 봅니다. `kubectl -n kube-system get pod -o wide`로 문제 노드의 에이전트 Pod가 Running인지 확인하고 `kubectl -n kube-system logs <에이전트 Pod>`로 경로나 터널을 만들다 실패한 기록을 읽습니다. 플러그인에 따라 에이전트가 다른 네임스페이스(예: `kube-flannel`)에 있으니 `-A`로 찾습니다.

> **정리**: 노드 사이 통신만 안 되면 플러그인 에이전트 Pod의 상태와 로그부터 봅니다. Pod는 수없이 생기고 사라지니 연결 작업을 사람이 손으로 할 수는 없습니다. 런타임이 플러그인을 부르는 방식이 1-4절의 CNI입니다.

</details>

쿠버네티스는 API만 정의하고 대부분을 외부 구성요소가 채웁니다.

| 부분 | 구현 주체 |
|---|---|
| Pod 네트워크 네임스페이스 생성 | CRI를 구현한 컨테이너 런타임 |
| Pod 네트워크 자체 | 네트워크 플러그인. 리눅스에서는 대부분 CNI로 런타임과 연결되므로 CNI 플러그인이라 부른다 |
| Service 프록시 | 기본 구현은 kube-proxy. 일부 네트워크 구현체는 자체 프록시를 쓴다 |
| NetworkPolicy | 대개 네트워크 플러그인 |

IP 대역은 셋이고 누가 나눠 주는지가 각각 다릅니다.

| 대역 | 할당하는 곳 |
|---|---|
| Pod IP | 네트워크 플러그인 |
| Service IP | kube-apiserver |
| 노드 IP | kubelet 또는 cloud-controller-manager |

세 대역은 겹치면 안 됩니다.

kube-proxy 모드는 리눅스에서 세 가지입니다.

- `iptables`: 지정하지 않을 때의 기본값입니다. 공식 문서 기준으로 앞으로 `nftables`로 바뀔 예정입니다.
- `nftables`: 위 기본값이 옮겨 갈 모드입니다.
- `ipvs`: v1.35부터 사용 중단(deprecated)입니다. v1.37 릴리스 글 기준 v1.40에서 기본 비활성화, v1.43에서 제거 예정입니다.

iptables 체인과 conntrack 해석은 시험 범위 밖이라 [쿠버네티스 아래의 리눅스 5편](/blog/theory/systems/k8s-linux-05-service-iptables-conntrack)에 따로 두었습니다.

### 1-3. 노드가 여는 포트 표

<details>
<summary>기초부터: 노드가 갖춰야 할 것과 포트가 필요한 이유</summary>

> **핵심 한 줄**: 클러스터 구성요소는 네트워크로 대화하므로 노드마다 고유한 신원이 있어야 하고 누가 누구에게 접속하는지에 맞춰 포트가 열려 있어야 합니다.

#### 1. 왜 필요한가

노드를 구별하는 값이 겹치거나 구성요소 사이 포트가 막히면 설치가 실패하거나 일부 기능만 조용히 안 됩니다. kubeadm 설치 문서 기준으로 아래 값은 노드마다 달라야 합니다.

| 값 | 확인 방법 |
|---|---|
| 호스트 이름 | `hostnamectl` |
| MAC 주소 | `ip link` |
| `product_uuid` | `cat /sys/class/dmi/id/product_uuid` |

실물 장비는 대개 다르지만 VM 하나를 복제해 워커를 늘리면 값이 같아질 수 있습니다. 그러면 설치가 실패할 수 있습니다.

#### 2. 연결 방향으로 포트 읽기

1. **모두 → API 서버(6443)**: kubectl, kubelet, 컨트롤러 매니저, 스케줄러가 모두 접속하므로 모두에게 열려 있어야 합니다.
2. **API 서버 → etcd(2379)**: etcd 멤버가 여럿이면 멤버끼리 2380으로 복제합니다.
3. **API 서버 → 각 노드 kubelet(10250)**: 반대 방향 연결입니다. `kubectl logs`, `exec`, `port-forward`가 이 길을 탑니다.
4. **자기 노드 안에서만(10259, 10257)**: 스케줄러와 컨트롤러 매니저는 kubeadm에서 127.0.0.1에만 바인딩됩니다. 바깥에 열 필요가 없습니다.
5. **외부 사용자 → 워커(30000-32767)**: NodePort 범위로 들어옵니다.

```text
kubectl ─┐
kubelet ─┼──→ kube-apiserver:6443 ──→ etcd:2379 (멤버끼리 :2380)
스케줄러 ─┘           │
                      └──→ 각 노드 kubelet:10250 (logs, exec, port-forward)
외부 사용자 ──→ 워커:30000-32767 (NodePort)
```

#### 3. 실전에서 보이는 모습

| 증상 | 먼저 볼 곳 |
|---|---|
| VM 복제 후 설치 실패 | 호스트 이름, MAC, `product_uuid`가 겹치는지 |
| 노드가 `NotReady` | 노드에서 6443으로 나가는 길이 보안 그룹이나 방화벽에서 막혔는지 |
| Pod는 잘 도는데 `kubectl logs`만 타임아웃 | 워커의 10250이 막혔는지 |

클라우드에서 클러스터를 직접 올렸다면 보안 그룹과 노드 방화벽(firewalld, iptables)을 함께 봅니다.

> **정리**: VM을 복제해 노드를 늘렸다면 호스트 이름, MAC, `product_uuid`부터 봅니다. 포트는 누가 누구에게 접속하는지로 읽습니다. 아래 표에 그 방향을 포트 번호로 적었습니다.

</details>

노드끼리 통신이 안 되는 과제는 방화벽이 필요한 포트를 막은 경우가 많습니다. 아래는 Ports and Protocols 문서의 표이며 값은 모두 바꿀 수 있는 기본값입니다.

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

kubectl의 `logs`, `exec`, `port-forward`는 API 서버가 kubelet의 10250으로 접속해서 처리합니다. 그래서 워커의 10250이 막히면 Pod는 잘 도는데 `kubectl logs`만 실패합니다.

실제 포트를 확인하는 곳은 구성요소에 따라 다릅니다.

- **컨트롤 플레인 구성요소**: 정적 Pod 매니페스트(`/etc/kubernetes/manifests/`)의 `--secure-port` 등으로 확인합니다.
- **kubelet**: systemd 서비스로 돌기 때문에 매니페스트에 없습니다. kubelet 설정 파일(`/var/lib/kubelet/config.yaml`)의 `port` 값을 보고 값이 없으면 기본값 10250입니다.

### 1-4. CNI 설정은 컨테이너 런타임이 읽는다

<details>
<summary>기초부터: CNI는 무엇이고 Pod가 만들어질 때 어떤 순서로 불리나</summary>

> **핵심 한 줄**: CNI는 "런타임은 플러그인을 이렇게 부르고 플러그인은 이렇게 답한다"는 규약입니다. 런타임이 Pod 네임스페이스를 만들고 플러그인이 그 안에 네트워크를 꽂습니다.

#### 1. 왜 필요한가

1-2절 토글의 2단계(네임스페이스에 veth 넣기, IP 주기, 경로 잡기)는 어느 컨테이너 플랫폼에나 필요합니다.

| 구분 | 규약이 없으면 | CNI(Container Network Interface) |
|---|---|---|
| 네트워크 코드 | 플랫폼마다 따로 만든다 | 외부 실행 파일(플러그인)로 떼어 낸다 |
| 새 네트워크 솔루션 지원 | 플랫폼 수만큼 일이 생긴다 | 플러그인 하나를 규약에 맞추면 된다 |

#### 2. 역할 나누기

| 컨테이너 런타임(containerd, CRI-O) | CNI 플러그인(bridge, Calico, Cilium, Flannel 등) |
|---|---|
| Pod의 네트워크 네임스페이스를 만든다 | 그 네임스페이스에 인터페이스를 넣고 IP를 준다 |
| `/etc/cni/net.d`의 설정을 읽어 어떤 플러그인을 쓸지 정한다 | 경로와 필요한 규칙을 설정한다 |
| Pod 생성 때 `ADD`, 삭제 때 `DEL`로 플러그인을 실행한다 | 결과(받은 IP 등)를 정해진 JSON 형식으로 돌려준다 |

플러그인은 두 부류입니다.

| 부류 | 예 | 하는 일 |
|---|---|---|
| CNI 프로젝트가 함께 배포하는 기본 플러그인 | 인터페이스용 `bridge`, `ptp`, `macvlan`, `ipvlan`, `vlan`, `host-device`, `loopback`과 IPAM용 `host-local`, `dhcp`, `static` | 한 노드 안의 연결만 만든다 |
| 서드파티 솔루션 | Calico, Cilium, Flannel | 여기에 노드 간 경로, 터널, NetworkPolicy 집행을 더하고 노드의 `/opt/cni/bin`에 자기 실행 파일을 설치한다 |

#### 3. Pod 하나가 만들어질 때의 순서

1. **배정**: 스케줄러가 Pod를 노드에 배정합니다.
2. **샌드박스 요청**: 그 노드의 kubelet이 CRI로 런타임에 Pod 샌드박스를 만들어 달라고 요청합니다. 1.24부터 kubelet은 CNI를 직접 다루지 않습니다.
3. **설정 읽기**: 런타임이 네트워크 네임스페이스를 만들고 `/etc/cni/net.d`에서 파일 이름 순으로 첫 설정 파일을 읽습니다.
4. **플러그인 실행**: 설정의 `"type"` 값과 같은 이름의 실행 파일을 `/opt/cni/bin`에서 찾아 `ADD`로 실행합니다. 네임스페이스 경로와 설정 JSON을 함께 넘깁니다.
5. **완료**: 플러그인이 veth를 만들어 Pod에 넣고 IP를 붙인 뒤 결과를 돌려주면 런타임이 앱 컨테이너를 시작합니다.

```text
스케줄러 → kubelet ─(CRI)→ containerd/CRI-O
                              ├─ netns 생성
                              ├─ /etc/cni/net.d/첫 파일 읽기 ("type": "bridge")
                              └─ /opt/cni/bin/bridge ADD 실행 → (ipam: host-local) → IP 결과 반환
                           → 앱 컨테이너 시작
```

#### 4. 설정 파일 읽기

bridge 플러그인 설정은 대략 이런 모양입니다(값은 예시).

```json
{
  "cniVersion": "1.0.0",
  "name": "mynet",
  "type": "bridge",
  "bridge": "cni0",
  "isGateway": true,
  "ipMasq": true,
  "ipam": {
    "type": "host-local",
    "subnet": "10.244.1.0/24",
    "routes": [{ "dst": "0.0.0.0/0" }]
  }
}
```

| 필드 | 뜻 |
|---|---|
| `type` | 실행할 플러그인 |
| `isGateway` | 브리지에 IP를 줘서 Pod의 게이트웨이로 쓸지 |
| `ipMasq` | 바깥으로 나갈 때 MASQUERADE를 걸지 |
| `ipam` | IP 나눠 주기를 맡을 별도 플러그인(1-5절 토글) |

#### 5. 헷갈리는 점 / 실전에서 보이는 모습

- 3~5단계 중 하나라도 실패하면 Pod는 `ContainerCreating`에 머물고 이벤트에 `FailedCreatePodSandBox`가 남습니다. 아래 표의 두 상황이 이 단계의 실패입니다.
- 노드에서 확인하는 순서는 넷입니다.
  1. `ls /etc/cni/net.d`로 설정 파일이 있는지. 비어 있으면 CNI 플러그인을 아직 설치하지 않았습니다.
  2. 파일이 여럿이면 이름 순으로 맨 앞 파일이 의도한 것인지
  3. 그 파일의 JSON 문법(괄호, 쉼표)과 `"type"` 값
  4. `ls /opt/cni/bin`에 그 `type`과 같은 이름의 실행 파일이 있는지

  JSON이 깨진 파일은 런타임이 불러오지 못하므로 단서가 `journalctl -u containerd`에 남습니다.
- Docker Engine의 네트워크는 자체 모델(CNM)로 만들어져 CNI 규약을 따르지 않습니다. 그래서 dockershim 시절에는 kubelet이 Docker에 네트워크 없는(`none`) 샌드박스 컨테이너를 만들게 한 뒤 그 네임스페이스에 CNI 플러그인을 대신 불렀고 지금은 CNI를 직접 지원하는 런타임이 부릅니다.

> **정리**: kubelet은 런타임을 부르고 런타임은 `/etc/cni/net.d`의 첫 설정과 `/opt/cni/bin`의 실행 파일로 플러그인을 부릅니다. 이 두 경로가 CNI 장애를 볼 때 가장 먼저 열 곳입니다.

</details>

CNI 플러그인을 부르는 쪽은 containerd나 CRI-O입니다. kubelet이 `--network-plugin`, `--cni-bin-dir`로 CNI를 다룬 것은 dockershim 경로뿐이었고 이 옵션들은 1.24에서 dockershim과 함께 제거됐습니다. 지금은 런타임 설정을 봅니다.

| 위치 | 내용 |
|---|---|
| `/etc/cni/net.d` | CNI 설정 파일(`.conf`, `.conflist`) |
| `/opt/cni/bin` | 플러그인 실행 파일(`bridge`, `host-local`, `loopback` 등) |
| `/etc/containerd/config.toml` | 위 두 경로를 바꾸는 곳 |

containerd는 기본으로(`max_conf_num` 1) 설정 디렉터리에서 파일 이름 순으로 맨 앞 파일 하나만 읽습니다.

여기서 잘 걸립니다. `00-old.conflist` 같은 남은 파일이 앞에 있으면 엉뚱한 설정이 적용됩니다. 설정 파일의 `"type"` 값은 `/opt/cni/bin` 안의 실행 파일 이름과 같아야 합니다.

CNI 문제는 증상이 둘로 나타납니다. kind v1.37 워커에서 일부러 만들어 본 오류 문구입니다.

| 만든 상황 | 노드 | Pod |
|---|---|---|
| `/etc/cni/net.d`의 설정 파일을 치움 | `NotReady`. Ready 조건 메시지 `container runtime network not ready: NetworkReady=false reason:NetworkPluginNotReady message:Network plugin returns error: cni plugin not initialized`, `node.kubernetes.io/not-ready` taint | 이벤트 사유 `NetworkNotReady` |
| `/opt/cni/bin/ptp`만 치움 | `Ready` 유지 | `FailedCreatePodSandBox ... plugin type="ptp" failed (add): failed to find plugin "ptp" in path [/opt/cni/bin]` |

두 경우 모두 노드에 들어가 `ls /etc/cni/net.d /opt/cni/bin`으로 파일을 보고 `journalctl -u containerd`(CRI-O면 `-u crio`)와 `journalctl -u kubelet`을 읽습니다. 설정 파일을 `mv`로 되돌렸는데 노드가 Ready로 안 돌아오면 파일을 다시 저장합니다.

NetworkPolicy를 연습하려면 정책을 집행하는 플러그인이 필요합니다.

- **집행하지 않음**: Flannel. README에 따르면 `flanneld`는 NetworkPolicy를 집행하지 않습니다. 실제로 Flannel만 깐 노드에서는 기본 거부 정책을 넣어도 통신이 그대로 됐습니다.
- **집행함**: Calico, Cilium, kind 기본 CNI(kindnet)

옛 강의의 Weave Net은 저장소가 보관(archived)됐고 마지막 릴리스가 2021년입니다.

### 1-5. Pod 대역, Service 대역, kube-proxy 모드 확인

<details>
<summary>기초부터: IPAM, Pod IP는 누가 나눠 주나</summary>

> **핵심 한 줄**: IPAM(IP Address Management)은 어떤 IP가 쓰이는지 장부를 들고 빈 IP를 내주고 돌려받는 일입니다. 노드별 대역 나누기와 대역 안에서 IP 고르기 두 층으로 나뉩니다.

#### 1. 왜 필요한가

Pod가 생길 때마다 겹치지 않는 IP를 하나씩 줘야 하고 Pod가 사라지면 그 IP를 돌려받아야 합니다. 누군가 장부를 들고 있어야 같은 IP가 두 번 나가지 않습니다.

#### 2. 어떻게 동작하나

1. **노드별 대역 나누기**: kube-controller-manager가 `--allocate-node-cidrs=true`일 때 `--cluster-cidr`(예: 10.244.0.0/16)를 노드마다 `/24`로 잘라 Node의 `spec.podCIDR`에 적습니다. kubeadm은 `--pod-network-cidr`를 주면 이것을 켭니다.
2. **플러그인 호출**: 런타임이 CNI 플러그인을 부르면 플러그인이 다시 `ipam.type`의 IPAM 플러그인을 부릅니다.
3. **IP 하나 고르기**: IPAM 플러그인이 대역 안에서 빈 IP를 골라 돌려줍니다.

```text
--cluster-cidr 10.244.0.0/16
   └─(kube-controller-manager)→ node1 spec.podCIDR 10.244.1.0/24, node2 10.244.2.0/24
런타임 → CNI 플러그인(bridge) → IPAM 플러그인(host-local) → 10.244.1.7 할당 → Pod eth0
```

네트워크를 붙이는 방식(bridge, macvlan 등)과 IP를 고르는 방식을 따로 둔 덕분에 둘을 바꿔 끼울 수 있습니다.

#### 3. 한눈에 비교

| `ipam.type` | 장부를 두는 곳 |
|---|---|
| `host-local` | 노드의 로컬 디스크(기본 `/var/lib/cni/networks/<네트워크 이름>/`)에 할당한 IP를 파일로 기록. 가장 흔하다 |
| `dhcp` | 노드 밖 DHCP 서버에서 받아 온다. 노드에 `dhcp` 데몬이 따로 떠 있어야 한다 |

| 플러그인 종류 | Pod IP의 출처 |
|---|---|
| Flannel 등 | 노드의 `spec.podCIDR`를 그대로 쓴다 |
| Calico, Cilium 등 자체 IPAM | 자기 방식으로 블록을 나눠 `spec.podCIDR`와 다른 대역에서 줄 수 있다(아래 목록의 둘째 항목) |

#### 4. 헷갈리는 점

- "이 노드의 Pod 대역"을 묻는 과제에서는 `spec.podCIDR`, CNI 설정 파일의 `ipam`, 실제 Pod IP를 함께 봅니다. 자체 IPAM 플러그인에서는 셋이 다를 수 있습니다.

> **정리**: 자체 IPAM 플러그인에서는 `spec.podCIDR`와 실제 Pod IP가 다를 수 있으니 둘을 같이 봅니다. 아래 명령으로 세 대역(Pod, Service, 노드)을 확인합니다.

</details>

"이 클러스터의 Pod IP 대역과 Service IP 대역을 적어라" 같은 과제는 어느 구성요소의 옵션에 값이 있는지만 알면 됩니다. 시험에서는 과제가 지정한 노드에 `ssh`로 들어가 실행합니다.

| 알고 싶은 것 | 어디에 있나 | 확인 명령(kubeadm 기준) |
|---|---|---|
| Service IP 대역 | kube-apiserver `--service-cluster-ip-range` | `grep service-cluster-ip-range /etc/kubernetes/manifests/kube-apiserver.yaml` |
| Service IP 대역(API 객체) | 위 값으로 만든 ServiceCIDR `kubernetes` | `kubectl get servicecidrs` |
| 클러스터 전체 Pod 대역 | kube-controller-manager `--cluster-cidr` (`--allocate-node-cidrs=true`일 때만 쓰임) | `grep cluster-cidr /etc/kubernetes/manifests/kube-controller-manager.yaml` |
| 노드별 Pod 대역 | Node의 `spec.podCIDR` | `kubectl get node -o jsonpath='{range .items[*]}{.metadata.name} {.spec.podCIDR}{"\n"}{end}'` |
| kube-proxy 모드 | ConfigMap `kube-proxy`의 `mode` | `kubectl -n kube-system get cm kube-proxy -o yaml \| grep mode` |
| 실제로 돌고 있는 모드 | kube-proxy 메트릭 서버의 `/proxyMode` | 노드에서 `curl -s http://127.0.0.1:10249/proxyMode` |

- kubeadm은 `kubeadm init --pod-network-cidr` 값을 `--cluster-cidr`에 넣고 `--allocate-node-cidrs=true`도 켭니다. 노드마다 이 대역에서 `/24`(IPv4 기본값)를 잘라 `spec.podCIDR`에 적습니다.
- Calico처럼 자체 IPAM을 쓰는 플러그인은 `spec.podCIDR`와 다른 블록에서 IP를 줍니다(Calico 클러스터에서 `spec.podCIDR`가 `10.244.1.0/24`인 노드의 Pod IP가 `10.244.140.x`). `kubectl get pod -A -o wide`로 실제 Pod IP를 같이 봅니다.
- ConfigMap의 `mode`가 빈 문자열이면 기본값(1.37 기준 `iptables`)이 쓰입니다. `/proxyMode`는 메트릭 주소 기본값이 `127.0.0.1:10249`라서 그 노드 안에서만 부를 수 있습니다.

### 1-6. 시험에서 연결을 확인하는 방법

연결 문제는 클러스터 안에서 실제로 요청을 보내 봐야 풀립니다. Debug Services 문서가 쓰는 방법은 임시 busybox Pod입니다.

```bash
# 문서(Debug Services)의 방식: 끝나면 지워지는 임시 Pod
kubectl run -it --rm --restart=Never busybox --image=registry.k8s.io/busybox:1.27.2 sh

# 한 줄로 끝내기: 대상 Pod IP와 포트로 직접 요청
kubectl -n shop get pod -o wide            # Pod IP와 노드 확인
kubectl -n shop run tmp --rm -it --restart=Never --image=busybox -- wget -qO- -T 2 10.244.1.23:8080
```

`-T 2`는 busybox `wget`의 타임아웃입니다. 막힌 연결은 응답 없이 기다리기만 하므로 타임아웃을 주지 않으면 시험 시간을 잃습니다.

이미지도 하나 조심합니다. `registry.k8s.io/busybox:1.27.2`는 amd64 전용 이미지라 arm64 연습 환경에서는 `busybox:1.36`이 낫습니다.

| 확인할 것 | 명령 |
|---|---|
| Pod IP, 올라간 노드 | `kubectl get pod -o wide` |
| CNI 플러그인 Pod 상태 | `kubectl -n kube-system get pod -o wide` (플러그인 DaemonSet이 모든 노드에서 Running인지) |
| 노드 조건 | `kubectl describe node <노드>`의 Ready 조건 메시지 |
| 노드의 라우트 표 | 노드에서 `ip route` (다른 노드의 Pod 대역이 어느 장치나 게이트웨이로 가는지) |
| IP 포워딩 | 노드에서 `sysctl net.ipv4.ip_forward`가 1인지 |

### 1-7. 자주 틀리는 지점

- Pod IP는 바뀝니다. 연결 확인에는 IP를 쓰되 정책이나 설정에 Pod IP를 박아 넣지 않습니다. NetworkPolicy 문서도 `ipBlock`은 클러스터 밖 IP에 쓰라고 안내합니다.
- kubeadm으로 막 만든 클러스터에서 CoreDNS가 `Pending`이면 정상입니다. Troubleshooting kubeadm 문서 기준으로 Pod 네트워크 애드온을 설치하기 전까지 CoreDNS가 `Pending`인 것은 설계된 동작입니다.
- 한 Pod가 자기 Service IP로 자기 자신에게 접속하지 못하는 경우가 있습니다. 많은 네트워크 애드온이 hairpin 모드를 켜지 않기 때문입니다(같은 문서).

### 1-8. 직접 해 보기

1. `shop`에 `order-api` Deployment(이미지 `nginx`, replicas 2)를 만들고 두 Pod가 서로 다른 노드에 있는지 `-o wide`로 확인합니다.
2. 임시 Pod에서 두 Pod IP의 80번 포트로 각각 `wget`을 보내 둘 다 응답하는지 봅니다.
3. 1-5의 표대로 Service 대역, `--cluster-cidr`, 노드별 `spec.podCIDR`, kube-proxy 모드를 적고 실제 Pod IP와 Service IP가 각 대역 안에 있는지 맞춰 봅니다.
4. 연습 클러스터의 워커에서 `/etc/cni/net.d`의 파일을 잠시 옮기고 새 Pod를 그 노드에 띄워 1-4 표의 문구가 나오는지 본 뒤 되돌립니다.

## 2. NetworkPolicy 정의와 적용

### 2-1. 격리의 의미

<details>
<summary>기초부터: NetworkPolicy가 왜 필요하고 어떻게 읽나</summary>

> **핵심 한 줄**: NetworkPolicy는 Pod 단위로 "누가 들어올 수 있고 어디로 나갈 수 있는지"를 적는 객체이고 실제로 막는 것은 CNI 플러그인입니다.

#### 1. 왜 필요한가

쇼핑몰에 웹 프런트, 주문 API, 결제 DB가 있다고 하겠습니다.

| 구분 | 정책이 없을 때 | 정책을 넣은 뒤 |
|---|---|---|
| 웹 프런트 → 결제 DB | 바로 접속된다 | 막힌다 |
| 주문 API → 결제 DB | 접속된다 | 3306으로만 허용된다 |

쿠버네티스의 기본 네트워크는 모두 열려 있어서 막을 장치가 따로 필요합니다.

#### 2. 방향은 보호하려는 Pod 기준

| 방향 | 뜻 | 예 |
|---|---|---|
| **Ingress** | 다른 곳에서 이 Pod로 들어오는 연결 | 주문 API → DB는 DB 입장에서 Ingress |
| **Egress** | 이 Pod에서 바깥으로 나가는 연결 | DB → 외부 백업 서버는 DB 입장에서 Egress |

허용된 연결의 응답은 자동으로 통과합니다. DB의 Ingress를 열었다면 DB가 돌려주는 응답을 위해 Egress를 따로 열 필요가 없습니다.

#### 3. 어떻게 동작하나

1. **대상 고르기**: `spec.podSelector`가 라벨로 대상 Pod를 고릅니다. Service가 Pod를 고르는 방식과 같습니다.
2. **격리**: 그 순간 대상 Pod는 `policyTypes`에 적힌 방향으로 격리됩니다. 격리된 방향은 기본 거부입니다.
3. **허용 목록**: `ingress.from`, `egress.to`에 적은 상대와 `ports`에 맞는 연결만 열립니다.
4. **합치기**: 같은 Pod를 고르는 정책이 여럿이면 열린 범위를 모두 합칩니다.
5. **집행**: API 서버는 객체를 저장만 하고 CNI 플러그인이 노드에서 패킷을 거릅니다.

```text
order-api Pod ──TCP 3306──→ [노드의 CNI 플러그인이 정책 확인] ──허용──→ payment-db Pod
web Pod       ──TCP 3306──→ [정책 확인: from 목록에 없음]     ──차단
```

"DB에는 주문 API만 3306으로 들어온다"를 쓰면 이렇습니다.

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: payment-db-ingress
  namespace: shop
spec:
  podSelector:
    matchLabels:
      app: payment-db        # 보호할 Pod
  policyTypes:
  - Ingress
  ingress:
  - from:
    - podSelector:
        matchLabels:
          app: order-api     # 들어올 수 있는 Pod (정책과 같은 네임스페이스)
    ports:
    - protocol: TCP
      port: 3306
```

#### 4. 헷갈리는 점 / 실전에서 보이는 모습

- 정책을 지원하지 않는 플러그인(Flannel 단독)에서는 객체가 오류 없이 만들어지는데 아무것도 막히지 않습니다. 지원하는 예로는 Calico, Cilium, Antrea가 있습니다.
- 정책을 만든 뒤에는 막혀야 할 연결이 정말 막히는지 직접 요청해 확인합니다. 막힌 연결은 거부 응답 없이 타임아웃으로 보이는 경우가 많습니다.

#### 5. 들어오고 나가는 쪽을 한 정책에

"결제 DB는 `env=prod` 네임스페이스의 주문 API에게서만 3306으로 받고 클러스터 밖 백업 서버 192.168.5.1의 80번으로만 내보낸다"를 한 객체로 쓰면 이렇습니다.

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: payment-db-strict
  namespace: shop
spec:
  podSelector:
    matchLabels:
      app: payment-db
  policyTypes:
  - Ingress
  - Egress
  ingress:
  - from:
    - namespaceSelector:       # 대시 하나 아래 두 선택자 = AND
        matchLabels:
          env: prod
      podSelector:
        matchLabels:
          app: order-api
    ports:
    - protocol: TCP
      port: 3306
  egress:
  - to:
    - ipBlock:
        cidr: 192.168.5.1/32   # 클러스터 밖 주소 하나
    ports:
    - protocol: TCP
      port: 80
```

| 읽는 곳 | 뜻 |
|---|---|
| `policyTypes` 두 개 | 이 Pod는 양방향 모두 기본 거부가 된다 |
| `ingress.from` 한 항목 안의 두 선택자 | `env=prod` 라벨이 붙은 네임스페이스에 있으면서 `app=order-api`인 Pod만(2-2절 AND/OR). `env` 같은 라벨은 네임스페이스에 직접 붙여 둬야 하고 자동으로 붙는 것은 `kubernetes.io/metadata.name`뿐이다 |
| `egress.to.ipBlock` | Pod IP는 바뀌므로 클러스터 밖 고정 주소에 쓴다 |

이 정책만 있으면 DB의 DNS 질의도 막힙니다. 백업 서버를 이름으로 부른다면 2-4절처럼 DNS Egress를 함께 엽니다. 들어온 요청에 대한 응답은 Egress 목록과 상관없이 나갑니다.

> **정리**: 정책이 효과가 없으면 플러그인이 NetworkPolicy를 집행하는지부터 확인합니다. 정책을 만든 뒤에는 열려야 할 연결과 막혀야 할 연결을 둘 다 직접 요청해 보고 Egress를 막았다면 DNS도 열어 둡니다.

</details>

NetworkPolicy는 IP와 포트 수준에서 TCP, UDP, SCTP 트래픽을 제어합니다. 네트워크 플러그인이 지원하지 않으면 정책을 만들어도 아무 효과가 없습니다.

출발점은 "모두 열림"입니다. 기본 상태의 Pod는 격리되지 않아 모든 연결이 허용되고 격리는 방향마다 따로 적용됩니다.

| 조건 | 결과 |
|---|---|
| 어떤 NetworkPolicy가 Pod를 선택하고 `policyTypes`에 `Ingress`가 있다 | 그 Pod는 Ingress 격리. 노드에서 오는 연결과 `ingress` 목록이 허용한 연결만 들어온다 |
| 어떤 NetworkPolicy가 Pod를 선택하고 `policyTypes`에 `Egress`가 있다 | 그 Pod는 Egress 격리. `egress` 목록이 허용한 연결만 나간다 |
| 정책이 여러 개 | 허용 범위의 합집합. 순서와 충돌이 없다 |
| A에서 B로 가는 연결 | A의 Egress와 B의 Ingress가 둘 다 허용해야 성립 |
| 허용된 연결의 응답 패킷 | 암묵적으로 허용 |

명시적 거부 정책은 없습니다. 어떤 연결을 막으려면 그 Pod를 격리한 뒤 필요한 연결만 허용합니다.

`policyTypes`를 생략하면 `Ingress`는 항상 들어가고 `Egress`는 egress 규칙이 있을 때만 들어갑니다. 시험에서는 의도를 분명히 하려고 항상 적습니다.

### 2-2. 선택자 네 가지와 AND/OR

`from`(ingress)과 `to`(egress)에 쓸 수 있는 선택자는 문서 기준 네 가지입니다.

| 선택자 | 고르는 대상 |
|---|---|
| `podSelector` | 정책과 같은 네임스페이스의 Pod |
| `namespaceSelector` | 고른 네임스페이스의 모든 Pod |
| `namespaceSelector`와 `podSelector`를 한 항목에 | 고른 네임스페이스 안의 고른 Pod (AND) |
| `ipBlock` | CIDR 대역. `except`로 일부 제외 |

AND와 OR는 YAML의 대시(`-`) 하나로 갈립니다.

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

대시는 "목록의 새 항목"이라는 뜻입니다.

- 대시가 하나: 두 선택자가 한 항목에 들어가 둘 다 맞아야 합니다(AND).
- 대시가 둘: 항목이 두 개라 어느 하나만 맞아도 됩니다(OR).

정책이 `shop` 네임스페이스에 있고 `checkout` 네임스페이스에 라벨 `team=checkout`이 붙어 있다고 두고 네 Pod가 보내는 요청을 따라가 보면 차이가 바로 보입니다.

| 보내는 Pod | AND(대시 하나) | OR(대시 둘) |
|---|---|---|
| `checkout`의 `app=order-api` | 허용 | 허용 |
| `checkout`의 `app=cart` | 거부(Pod 라벨이 안 맞음) | 허용(네임스페이스가 맞음) |
| `shop`의 `app=order-api` | 거부(네임스페이스가 안 맞음) | 허용(같은 네임스페이스의 `podSelector`) |
| `shop`의 `app=board` | 거부 | 거부 |

OR 쪽의 `podSelector`는 혼자 쓰였으므로 정책과 같은 네임스페이스(`shop`)의 Pod만 고릅니다. `checkout`의 `order-api`가 OR에서 허용되는 것은 `namespaceSelector` 항목 덕분입니다.

대시 하나 차이로 허용되는 Pod가 한 개에서 세 개로 늘어납니다.

헷갈리면 문서 권고대로 `kubectl describe networkpolicy <이름>`으로 쿠버네티스가 어떻게 해석했는지 읽습니다.

네임스페이스를 이름으로 지정하는 필드는 없습니다.

대신 컨트롤 플레인이 모든 네임스페이스에 바꿀 수 없는 라벨 `kubernetes.io/metadata.name=<네임스페이스 이름>`을 붙이므로 이 라벨로 고릅니다. 과제가 "네임스페이스 payment에서 오는 트래픽만"이라고 하면 라벨을 새로 붙일 필요 없이 이 라벨을 씁니다.

### 2-3. 기본 정책 다섯 가지

`kubectl create`에 NetworkPolicy 생성 명령이 없어서 문서 예제를 복사해 고치는 것이 가장 빠릅니다.

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

이 표에서 헷갈리는 곳은 규칙 칸입니다.

| 규칙 칸 | 결과 |
|---|---|
| 규칙 필드가 아예 없음 | 아무것도 허용하지 않는다 |
| 빈 규칙 `{}` 하나 | 모든 것을 허용한다 |

둘이 반대로 동작하는 이유는 규칙 하나를 "조건을 모두 통과한 연결을 허용한다"로 읽으면 풀립니다.

- `ingress:` 목록이 비어 있으면 통과시킬 규칙이 하나도 없으니 격리된 Pod에는 아무것도 못 들어옵니다.
- `ingress: [{}]`는 규칙이 하나 있는데 그 규칙에 `from`도 `ports`도 없습니다. 걸러 낼 조건이 없으니 모든 출발지와 모든 포트가 통과합니다.

빈 `podSelector: {}`가 "모든 Pod"인 것과 같은 읽기 방식입니다.

### 2-4. Egress를 막으면 DNS도 막힌다

문서는 Default deny all egress 아래에 주의 문구를 둡니다. 모든 Egress를 막으면 DNS 트래픽도 막히므로 이름 해석이 필요하면 클러스터 DNS로 나가는 Egress를 따로 허용합니다.

주문 API가 결제 서비스만 호출하도록 막는 정책을 DNS 허용과 함께 쓰면 이렇습니다.

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

`k8s-app: kube-dns`는 Debugging DNS Resolution 문서가 밝힌 CoreDNS Pod의 라벨입니다. 두 번째 `to` 항목은 `namespaceSelector`와 `podSelector`가 한 항목에 있으므로 AND입니다.

### 2-5. 그 밖에 문서가 적어 둔 동작

| 항목 | 문서 내용 |
|---|---|
| 포트 범위 | `endPort`로 범위 지정(v1.25 stable). `port`가 있어야 하고 `endPort`가 더 크거나 같아야 한다 |
| 노드 트래픽 | Pod가 실행 중인 노드와의 트래픽은 항상 허용 |
| 자기 자신 | Pod는 자기 자신으로의 접근을 막을 수 없다 |
| ICMP 등 | deny all이 보장하는 것은 TCP, UDP, SCTP뿐. ICMP는 플러그인마다 다르다 |

### 2-6. 자주 틀리는 지점

- 정책이 적용될 Pod를 고르는 `spec.podSelector`와 허용할 상대를 고르는 `from[].podSelector`를 헷갈립니다.
- AND를 써야 할 곳에 대시를 하나 더 넣어 OR로 만들면 허용 범위가 크게 넓어집니다. 채점은 결과로 하므로 "허용돼야 할 것"과 "막혀야 할 것"을 둘 다 시험해 봅니다.
- `ports`는 `from`과 같은 들여쓰기 수준에 씁니다. `from` 항목 안으로 들여 쓰면 검증에서 걸리거나 의도와 다르게 해석됩니다.
- 과제가 Ingress 제한만 요구하는데 `policyTypes`에 `Egress`를 넣으면 그 Pod의 바깥 연결까지 막힙니다.

### 2-7. 직접 해 보기

1. `shop`에 Default deny all ingress를 적용하고 임시 Pod에서 `order-api`로 보낸 요청이 타임아웃 나는지 봅니다.
2. `app=board` Pod만 `order-api`의 80번으로 들어올 수 있게 정책을 더하고 `kubectl run tmp --labels=app=board ...`로 만든 임시 Pod와 라벨 없는 임시 Pod에서 각각 요청해 결과를 비교합니다. `app=board` 쪽만 응답을 받아야 합니다.
3. 2-4의 정책에서 DNS 항목을 지운 뒤 `order-api` Pod 안에서 `getent hosts payment`가 실패하는지 보고 되돌립니다. nginx 이미지에는 `nslookup`이 없어 `executable file not found`가 납니다. kindnet에서 해 보면 `getent`가 종료 코드 2로 실패했습니다.

## 3. ClusterIP, NodePort, LoadBalancer와 엔드포인트

### 3-1. Service가 필요한 이유

<details>
<summary>기초부터: Service의 정체와 kube-proxy가 하는 일</summary>

> **핵심 한 줄**: Service는 "이 IP:포트로 가는 패킷은 이 Pod들 중 하나로 보내라"는 규칙이고 kube-proxy가 그 규칙을 모든 노드의 커널에 깔아 둡니다.

#### 1. 왜 필요한가

주문 API Pod가 세 개 떠 있고 게시판이 주문 API를 부릅니다.

| 구분 | Pod IP로 직접 부를 때 | Service ClusterIP로 부를 때 |
|---|---|---|
| Pod 재시작, 재배치 | IP가 바뀌어 코드를 고쳐야 한다 | 주소가 그대로다 |
| Pod 수 변화 | 목록을 직접 관리해야 한다 | 규칙이 알아서 갱신된다 |

#### 2. 어떻게 동작하나

1. **ClusterIP 배정**: Service를 만들면 kube-apiserver가 `--service-cluster-ip-range`(Service 대역)에서 ClusterIP 하나를 줍니다.
2. **엔드포인트 기록**: EndpointSlice 컨트롤러가 selector에 맞는 Ready Pod의 IP와 포트를 EndpointSlice에 적습니다.
3. **규칙 쓰기**: 각 노드의 kube-proxy가 API 서버를 watch하다가 Service와 EndpointSlice가 바뀌면 그 노드의 커널에 전달 규칙을 다시 씁니다.
4. **DNAT**: 게시판 Pod가 ClusterIP:80으로 보내면 패킷이 노드를 떠나기 전에 커널이 목적지를 Pod IP:targetPort 중 하나로 바꿉니다. 그다음은 일반 Pod 간 통신입니다.

```text
[규칙이 깔리는 길]
Service 생성 → apiserver(ClusterIP 배정) → EndpointSlice 컨트롤러(Ready Pod 기록)
   → 각 노드 kube-proxy(watch) → 커널 iptables/nftables 규칙

[패킷이 지나가는 길]
board Pod → ClusterIP 10.96.0.50:80 → (같은 노드 커널에서 DNAT) → order-api Pod 10.244.2.7:8080
```

#### 3. 프록시 모드

| 모드 | 동작 | 1.37 기준 상태 |
|---|---|---|
| userspace | kube-proxy 프로세스가 연결을 직접 받아 넘김. 커널과 사용자 공간을 오가 느렸다 | 1.26에서 제거 |
| `iptables` | iptables nat 규칙으로 DNAT. 백엔드는 무작위로 고른다 | 기본값 |
| `ipvs` | 커널의 L4 로드밸런서 IPVS가 해시 테이블로 찾고 여러 분산 알고리즘을 지원 | v1.35부터 사용 중단 |
| `nftables` | iptables의 후속인 nftables로 규칙을 씀. Service가 많을 때 iptables보다 규칙 갱신과 처리 부담이 작다 | 앞으로 기본값이 될 예정 |

#### 4. 헷갈리는 점 / 실전에서 보이는 모습

- ClusterIP에는 그 주소를 가진 인터페이스도, 요청을 받는 서버 프로세스도 없습니다. 그래서 iptables 모드 클러스터에서는 ClusterIP로 `ping`을 보내도 응답이 없습니다.
- kube-proxy는 규칙을 쓰기만 하고 패킷을 직접 나르지 않습니다. kube-proxy Pod가 잠시 죽어도 기존 Service는 계속 동작하고 그사이의 변경만 반영되지 않습니다. 패킷이 kube-proxy 프로세스를 거치던 옛 userspace 모드에서는 프로세스가 멈추면 그 노드의 Service 전달도 멈췄습니다.
- iptables 모드는 Service마다 규칙이 늘고 패킷이 규칙 목록을 차례로 비교하므로 Service가 아주 많으면 부담이 커집니다. 해시 테이블로 찾는 IPVS가 그 대안이었고 지금 문서가 가리키는 후속은 `nftables` 모드입니다. IPVS는 노드 커널에 IPVS 모듈이 있어야 했습니다.
- iptables 모드에서 실제 규칙은 노드에서 `sudo iptables-save | grep <Service 이름>`으로 보입니다.
- Pod 대역과 Service 대역은 겹치면 안 됩니다. Service 대역은 kube-apiserver의 `--service-cluster-ip-range`, Pod 대역은 `--cluster-cidr`와 CNI 설정이 정합니다(1-5절).

> **정리**: kube-proxy는 규칙만 쓰고 패킷은 커널이 나릅니다. 규칙의 목적지 목록은 EndpointSlice라서 Service가 응답하지 않으면 아래 본문처럼 "Service는 있는데 EndpointSlice가 비었나"부터 봅니다.

</details>

Service 문서의 정의는 "하나 이상의 Pod로 실행되는 네트워크 애플리케이션을 노출하는 방법"입니다. Pod는 사라지고 IP가 바뀌므로 클라이언트가 부를 이름과 가상 IP를 앞에 둡니다. 동작은 두 단계입니다.

1. 컨트롤 플레인의 컨트롤러가 Service의 selector에 맞는 Pod를 찾아 EndpointSlice에 기록합니다.
2. 각 노드의 서비스 프록시(기본은 kube-proxy)가 Service와 EndpointSlice를 감시하다가 Service IP로 가는 트래픽을 백엔드 Pod로 보내도록 데이터 플레인을 설정합니다.

### 3-2. 포트 세 개

| 필드 | 의미 |
|---|---|
| `port` | Service가 받는 포트 |
| `targetPort` | 트래픽을 보낼 Pod의 포트. 생략하면 `port`와 같다. 숫자 또는 Pod 포트의 이름 |
| `nodePort` | NodePort와 LoadBalancer 타입에서 모든 노드가 여는 포트 |

`targetPort`에 이름을 쓰면 Pod 버전마다 실제 포트 번호가 달라도 Service를 바꾸지 않아도 됩니다. 프로토콜 기본값은 TCP입니다.

세 숫자가 어디서 쓰이는지는 요청 하나를 따라가면 구분됩니다. `port: 80`, `targetPort: 8080`, `nodePort: 30080`인 NodePort Service `web`이 있다고 하겠습니다.

| 누가 보내나 | 보내는 주소 | 쓰이는 필드 | 그다음 |
|---|---|---|---|
| 클러스터 밖 손님 | `<노드IP>:30080` | `nodePort` | 노드 커널이 Pod IP:8080으로 바꿔 보낸다 |
| 클러스터 안 Pod | `web:80` 또는 `<ClusterIP>:80` | `port` | 노드 커널이 Pod IP:8080으로 바꿔 보낸다 |
| (공통 목적지) | `<Pod IP>:8080` | `targetPort` | 컨테이너가 실제로 듣는 포트 |

`port`와 `nodePort`는 Service가 받는 입구이고 `targetPort`는 출구입니다. 입구가 둘이어도 출구는 같은 컨테이너 포트입니다. 그래서 Ingress나 HTTPRoute의 백엔드 포트에는 입구인 `port`(80)를 적고 컨테이너 포트(8080)를 적지 않습니다(5-7절).

### 3-3. 타입 네 가지

| 타입 | 동작(문서 기준) | 메모 |
|---|---|---|
| `ClusterIP` | 클러스터 내부 IP로만 노출. `type`을 생략하면 이것 | `clusterIP: None`이면 headless |
| `NodePort` | 모든 노드 IP의 같은 고정 포트로 노출. ClusterIP도 함께 만든다 | 기본 범위 30000-32767 (`--service-node-port-range`) |
| `LoadBalancer` | 외부 로드밸런서로 노출. 쿠버네티스는 로드밸런서를 직접 제공하지 않는다 | 보통 NodePort를 먼저 만들고 cloud-controller-manager가 LB를 그 포트로 연결 |
| `ExternalName` | `spec.externalName`의 DNS 이름으로 CNAME 응답. 프록시 없음 | selector 없음 |

`type`은 앞 단계 위에 기능을 더하는 구조입니다. NodePort는 ClusterIP를 포함하고 LoadBalancer는 보통 NodePort를 포함합니다. 예외는 `spec.allocateLoadBalancerNodePorts: false`로 노드 포트 할당을 끈 LoadBalancer입니다.

LB 컨트롤러가 없는 클러스터(kubeadm 연습 클러스터, kind)에서 LoadBalancer Service의 `EXTERNAL-IP`는 `<pending>`으로 남습니다. 결과는 `.status.loadBalancer`에 기록됩니다.

Service의 `spec.externalIPs` 필드는 보안 문제(CVE-2020-8554)로 1.36에서 사용 중단됐습니다. `kubectl get svc`의 `EXTERNAL-IP` 열과는 다른 것이고 새 Service에는 쓰지 않습니다([v1.36 공지](https://kubernetes.io/blog/2026/05/14/kubernetes-v1-36-deprecation-and-removal-of-service-externalips/)).

### 3-4. 명령으로 만들기

시험에서는 `kubectl expose`가 가장 빠릅니다. 대상 리소스의 selector를 그대로 가져와 새 Service의 selector로 씁니다.

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

`kubectl create service nodeport <이름> --tcp=80:8080 --node-port=30080`도 있습니다. 다만 selector 옵션이 없고 selector를 `app: <Service 이름>`으로 고정해 넣습니다.

그래서 Pod 라벨이 `app=<같은 이름>`이 아니면 엔드포인트가 빕니다. 만든 뒤에는 이렇게 손봅니다.

1. `kubectl get svc <이름> -o yaml`로 selector를 확인합니다.
2. `kubectl set selector`나 `edit`으로 고칩니다.

### 3-5. EndpointSlice

EndpointSlice는 Service 뒤 엔드포인트의 일부(slice)를 담는 객체이고 v1.21에 stable이 됐습니다.

| 항목 | 내용 |
|---|---|
| 크기 | 기본으로 한 슬라이스에 엔드포인트 100개까지. kube-controller-manager `--max-endpoints-per-slice`로 최대 1000 |
| Service와 연결 | 라벨 `kubernetes.io/service-name: <Service 이름>` |
| 조건 | `serving`, `terminating`, `ready`. `ready`는 사실상 "serving이고 terminating이 아님" |
| 옛 Endpoints API | v1.33부터 사용 중단. 듀얼스택 미지원, 1000개 넘으면 잘림 |

```bash
kubectl -n shop get endpointslices -l kubernetes.io/service-name=order-api
```

Debug Services 문서에 실린 출력 모양입니다(문서 예시).

```
NAME              ADDRESSTYPE   PORTS   ENDPOINTS
hostnames-ytpni   IPv4          9376    10.244.0.5,10.244.0.6,10.244.0.7
```

고르는 Pod가 없을 때 보이는 모습은 명령마다 다릅니다.

| 명령 | 비었을 때 |
|---|---|
| `kubectl get endpointslices` (kubectl v1.37) | ENDPOINTS와 PORTS 열이 `<unset>` |
| 옛 `kubectl get endpoints` | `<none>`과 함께 `Warning: v1 Endpoints is deprecated in v1.33+; use discovery.k8s.io/v1 EndpointSlice` 경고 |

엔드포인트가 비면 두 가지를 차례로 봅니다.

1. Service의 `spec.selector`가 Pod의 `metadata.labels`를 실제로 고르는지 확인합니다.
2. selector가 맞는데도 비어 있으면 Pod가 Ready가 아닌지 봅니다. readiness probe가 실패하는 Pod는 트래픽을 받지 않습니다.

### 3-6. selector 없는 Service

외부 DB나 클러스터 밖 서버를 Service 이름으로 부르고 싶을 때는 selector 없이 Service를 만들고 EndpointSlice를 직접 씁니다. 이때는 EndpointSlice가 자동으로 생기지 않습니다.

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

엔드포인트 IP로 루프백(127.0.0.0/8), 링크 로컬(169.254.0.0/16 등), 다른 Service의 클러스터 IP는 쓸 수 없습니다. 직접 관리하는 EndpointSlice의 `endpointslice.kubernetes.io/managed-by` 라벨에는 `controller` 이외의 값을 넣으라고 문서가 권합니다.

### 3-7. 트래픽 정책과 세션 고정

| 필드 | 값 | 동작 |
|---|---|---|
| `internalTrafficPolicy` | `Cluster`, `Local` | `Local`이면 같은 노드의 Ready 엔드포인트로만. 없으면 버린다 |
| `externalTrafficPolicy` | `Cluster`, `Local` | 외부 트래픽에 같은 규칙. `Local`이면 엔드포인트가 있는 노드만 응답하고 클라이언트 IP를 보존한다 |
| `sessionAffinity` | `None`(기본), `ClientIP` | `ClientIP`면 같은 클라이언트 IP를 같은 Pod로 |
| `sessionAffinityConfig.clientIP.timeoutSeconds` | 기본 10800 | 3시간 |

<details>
<summary>기초부터: Local로 바꾸면 왜 손님 IP가 보이고 왜 어떤 노드는 응답하지 않나</summary>

> **핵심 한 줄**: `Cluster`는 아무 노드로 와도 다른 노드의 Pod까지 데려다주는 대신 출발지를 노드 IP로 바꾸고 `Local`은 자기 노드의 Pod에만 넘기는 대신 출발지를 그대로 둡니다.

#### 1. 왜 필요한가

쇼핑몰 웹 서버가 로그인 실패를 손님 IP별로 세서 같은 IP에서 너무 많이 틀리면 막는다고 하겠습니다. 그런데 접근 로그를 열어 보니 모든 요청의 출발지가 `192.168.0.11`, `192.168.0.12` 같은 노드 IP뿐입니다. 손님 IP가 어디서 사라졌는지가 이 필드의 이야기입니다.

#### 2. 어떻게 동작하나

![externalTrafficPolicy Cluster와 Local 비교. 왼쪽 Cluster는 손님 203.0.113.7이 Pod 없는 노드1의 30080으로 보내면 노드1이 출발지를 자기 IP로 바꾼 뒤 노드2의 web Pod로 넘겨 Pod가 192.168.0.11을 본다. 오른쪽 Local은 노드1로 온 요청을 버리고 노드2로 온 요청만 Pod가 받아 출발지 203.0.113.7을 그대로 본다](/uploads/cert/cka/cka-04-services-networking/external-traffic-policy.svg)

**`Cluster`(기본값)에서 손님이 Pod 없는 노드1로 보낸 경우**

1. 손님(`203.0.113.7`)이 `노드1:30080`으로 요청을 보냅니다.
2. 노드1 커널이 목적지를 노드2에 있는 Pod `10.244.2.7:8080`으로 바꿉니다(DNAT).
3. 같은 순간 출발지도 노드1 자신의 IP로 바꿉니다(SNAT). 이걸 하지 않으면 Pod의 응답이 노드1을 거치지 않고 손님에게 곧장 가려 합니다. 손님은 노드1에 보냈는데 엉뚱한 주소에서 답이 오니 그 응답을 버립니다.
4. Pod는 출발지가 `192.168.0.11`인 요청을 받고 응답은 노드1을 거쳐 손님에게 돌아갑니다.

**`Local`로 바꾸면**

1. 노드1에는 이 Service의 Pod가 없으므로 노드1로 온 요청은 버려집니다.
2. 노드2로 온 요청은 같은 노드의 Pod로만 넘어가므로 다른 노드를 거칠 일이 없습니다. 출발지를 바꿀 이유가 없어 Pod는 `203.0.113.7`을 그대로 봅니다.
3. LoadBalancer 타입이면 쿠버네티스가 `spec.healthCheckNodePort`를 하나 배정합니다. 각 노드가 이 포트의 `/healthz`로 자기에게 엔드포인트가 있는지 답하고 클라우드 LB는 상태 확인에 실패한 노드(노드1)를 대상에서 뺍니다. 손님 요청이 버려지는 노드로 가지 않게 하는 장치입니다.

#### 3. 한눈에 비교

| | `Cluster` | `Local` |
|---|---|---|
| Pod가 보는 출발지 | 노드 IP(SNAT) | 손님 IP |
| Pod 없는 노드로 온 요청 | 다른 노드의 Pod로 전달 | 버림 |
| 노드를 한 번 더 건너는가 | 건널 수 있다 | 건너지 않는다 |
| 부하 분산 | Pod 단위로 고르게 | 노드 단위로 나뉜다. Pod가 노드1에 3개, 노드2에 1개면 노드2의 Pod 하나가 절반을 받을 수 있다 |

`internalTrafficPolicy: Local`도 같은 생각을 클러스터 안 트래픽에 적용합니다. 같은 노드의 Pod로만 보내고 없으면 버립니다. 노드마다 하나씩 뜨는 DaemonSet 에이전트에 로그를 보낼 때처럼 "내 노드의 것과만 이야기하면 되는" 경우에 씁니다.

#### 4. 헷갈리는 점 / 실전에서 보이는 모습

- NodePort가 일부 노드에서만 응답하면 장애가 아닐 수 있습니다. `Local`이면 Pod 없는 노드가 버리는 것이 정상 동작입니다(3-8절).
- 실제로 확인하는 방법은 Using Source IP 튜토리얼에 있습니다. 받은 요청의 출발지를 그대로 찍어 주는 `echoserver` 이미지를 NodePort로 노출하고 정책을 바꿔 가며 `client_address`가 노드 IP에서 손님 IP로 바뀌는지 봅니다.

> **정리**: 손님 IP가 필요하면 `Local`, 어느 노드로 와도 응답해야 하면 `Cluster`입니다. `Local`의 대가는 Pod 없는 노드가 요청을 버린다는 것이고 LB는 `healthCheckNodePort`로 그 노드를 피합니다.

</details>

### 3-8. 자주 틀리는 지점

- 컨테이너가 8080에서 듣는데 `targetPort`를 생략하면 `port`와 같은 80으로 갑니다.
- 숫자 포트를 문자열 `"8080"`으로 쓰면 이름으로 해석될 수 있습니다. Debug Services 문서의 점검 목록에도 있는 항목입니다.
- NodePort를 범위 밖 번호로 지정하면 `provided port is not in the valid range. The range of valid ports is 30000-32767`로 거부됩니다.
- NodePort가 일부 노드에서만 응답하면 `externalTrafficPolicy: Local`인지 봅니다.
- Deployment의 Pod 템플릿 라벨만 바꾸면 Deployment selector와 어긋나 `` `selector` does not match template `labels` ``로 거부됩니다. Service 쪽 selector를 고치는 것이 맞는 경우가 많습니다.

### 3-9. 직접 해 보기

1. `order-api` Deployment를 ClusterIP Service로 노출하고 `kubectl get endpointslices`로 Pod 수만큼 IP가 있는지 확인합니다.
2. `kubectl -n shop set selector svc order-api app=order-api-v2`로 selector를 어느 Pod에도 없는 라벨로 바꿔 ENDPOINTS가 `<unset>`이 되는 것을 보고 `app=order-api`로 되돌립니다.
3. `board`를 NodePort 30080으로 노출하고 노드 IP와 30080으로 접속해 봅니다. kind on Mac에서는 노드 IP가 Mac에서 바로 닿지 않으니 `docker exec <노드 컨테이너> curl -s <노드IP>:30080`처럼 노드 안에서 보냅니다.

## 4. Gateway API로 Ingress 트래픽 관리

### 4-1. 왜 Gateway API인가

<details>
<summary>기초부터: Ingress에서 Gateway API로 넘어온 이유와 요청이 흐르는 길</summary>

> **핵심 한 줄**: Gateway API는 Ingress 한 객체에 섞여 있던 인프라 설정과 앱 라우팅을 GatewayClass, Gateway, HTTPRoute로 나누고 어노테이션 기능을 표준 필드로 올렸습니다.

#### 1. 왜 필요한가

Ingress의 표준 필드는 HTTP 요청을 호스트와 경로로 나누는 것까지입니다. 카나리 비율, 헤더 바꾸기, HTTP→HTTPS 리다이렉트는 컨트롤러마다 다른 어노테이션 문자열로 넣었습니다.

| 문제 | Ingress(어노테이션) | Gateway API |
|---|---|---|
| 오타 검증 | 그냥 문자열이라 API 서버가 검증하지 못하고 틀리면 조용히 무시된다 | 표준 필드라 스키마로 검증된다 |
| 컨트롤러 교체 | 어노테이션을 전부 다시 써야 한다 | 같은 필드를 그대로 쓴다 |
| 팀 간 충돌 | 진입점, TLS, 경로가 한 객체에 섞여 서로 덮어쓰기 쉽다 | 역할별 객체로 나뉜다 |

#### 2. 역할별로 나눈 객체

| 객체 | 비유(건물) | 실제 내용 | 주로 만드는 쪽 |
|---|---|---|---|
| **GatewayClass** | 출입 관리를 맡은 업체 | `controllerName`으로 구현체 컨트롤러를 가리킴 | 인프라 제공자 |
| **Gateway** | 실제 출입문 | 리스너(포트, 프로토콜, 인증서) | 클러스터 운영자 |
| **HTTPRoute** | 문 안의 안내판 | 호스트, 경로, 헤더 매칭과 `backendRefs` | 앱 개발자 |

#### 3. 어떻게 동작하나

1. **설치**: 클러스터에 Gateway API CRD와 구현체(Envoy Gateway, Istio, NGINX Gateway Fabric 등)의 컨트롤러가 있어야 합니다. 쿠버네티스 본체에는 둘 다 들어 있지 않습니다.
2. **클래스 연결**: GatewayClass의 `controllerName`이 그 컨트롤러를 가리킵니다.
3. **프록시 준비**: 운영자가 Gateway를 만들면 컨트롤러가 실제 프록시(Pod와 그 앞의 Service나 로드밸런서)를 준비하고 리스너대로 포트를 엽니다.
4. **라우트 붙이기**: 개발자가 HTTPRoute를 `parentRefs`로 Gateway에 붙이면 컨트롤러가 Route 규칙을 프록시 설정으로 바꿉니다.
5. **요청 처리**: 요청이 Gateway 주소로 들어오면 프록시가 호스트, 경로, 헤더를 Route 규칙과 맞춰 `backendRefs`의 Service 뒤 Pod로 보냅니다.

```text
클라이언트 → Gateway 주소(LB/Service) → 프록시 Pod(리스너 :80/:443)
   → HTTPRoute 규칙 매칭(host, path, header) → backendRefs Service → Pod
         ↑ 설정 반영: GatewayClass.controllerName이 가리키는 컨트롤러가 watch
```

#### 4. 어노테이션이 표준 필드가 된 자리

| 하던 일 | HTTPRoute 필드 |
|---|---|
| 가중치 분배(카나리) | `backendRefs[].weight` |
| 리다이렉트, 경로 재작성, 헤더 변경 | `filters` |
| 요청 복제 | `RequestMirror` 필터. 원래 백엔드가 처리하는 동안 복사본을 새 버전에 보내고 사용자는 원래 백엔드의 응답만 받는다 |

#### 5. 헷갈리는 점

- GatewayClass는 클러스터에 여러 개 둘 수 있습니다. 바깥 공개용과 내부용 프록시를 서로 다른 구현체로 함께 돌리고 Gateway의 `gatewayClassName`으로 어느 쪽에 맡길지 고릅니다.
- kubernetes.io 문서가 stable로 꼽는 종류는 GatewayClass, Gateway, HTTPRoute, GRPCRoute 넷입니다. TCP, UDP, TLS 트래픽용 Route도 프로젝트에 있지만 이 목록에 없으니 쓰려면 설치한 CRD 채널과 구현체의 지원 여부를 확인합니다.

> **정리**: CRD와 컨트롤러가 없으면 객체만 저장되고 아무 일도 일어나지 않습니다. Gateway를 만들었는데 반응이 없으면 설치 여부와 GatewayClass의 `controllerName`이 그 컨트롤러를 가리키는지부터 봅니다.

</details>

Gateway API는 CRD로 설치하는 애드온 API 묶음이고 kubernetes.io 문서가 Ingress의 후속으로 소개합니다. 리소스를 역할별로 나눴고 헤더 매칭이나 가중치 분배처럼 Ingress에서는 컨트롤러 어노테이션으로만 되던 기능을 표준 필드로 지원합니다. Ingress 종류(kind)를 포함하지 않으므로 기존 Ingress는 한 번 변환해야 합니다.

### 4-2. 리소스 모델

| 종류 | 쓰기 권한을 가진 가장 좁은 역할 | 하는 일 |
|---|---|---|
| GatewayClass | 인프라 제공자 | 어느 컨트롤러가 Gateway를 구현하는지(`spec.controllerName`) |
| Gateway | 클러스터 운영자 | 트래픽을 받는 인스턴스. 리스너(프로토콜, 포트, 호스트 이름, TLS) |
| HTTPRoute | 애플리케이션 개발자 | 리스너로 들어온 HTTP 요청을 어떤 Service로 보낼지 |
| GRPCRoute | 애플리케이션 개발자 | gRPC 요청의 라우팅 |

역할 칸은 Gateway API 문서 Security Model의 3단계 쓰기 권한 표를 따랐습니다. 그 표에서 쓸 수 있는 범위는 아래로 갈수록 좁아집니다.

- 인프라 제공자: 셋 다
- 클러스터 운영자: Gateway와 Route
- 애플리케이션 개발자: Route만

kubernetes.io의 Gateway 문서는 세 역할을 소개만 하고 리소스와 짝짓지 않습니다.

Gateway 하나는 GatewayClass 정확히 하나와 연결됩니다. Route는 `parentRefs`로 Gateway를 가리키고 Gateway는 리스너의 `allowedRoutes`로 붙을 수 있는 Route를 거릅니다. 문서는 이 구조를 양방향 신뢰 모델이라고 부릅니다.

### 4-3. 최소 구성

GatewayClass의 `controllerName`은 구현체마다 다르므로 시험에서는 클러스터에 이미 있는 클래스 이름을 찾아 씁니다.

```bash
kubectl get gatewayclass
kubectl get gateway -A
kubectl get httproute -A
```

`shop.example.com`으로 들어오는 요청을 경로로 나누는 구성입니다. 클래스 이름 `example-class`는 클러스터에 있는 것으로 바꿉니다.

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

`kubectl create`에는 Gateway나 HTTPRoute 생성 명령이 없어서 YAML을 씁니다. 시험에서 열 수 있는 문서에 gateway-api.sigs.k8s.io가 CKA에 한해 들어 있으니(1편 3-3절) HTTP routing, Traffic splitting, TLS 가이드의 예제 위치를 미리 알아 둡니다.

### 4-4. 매칭과 가중치

HTTPRoute 타입 정의의 주석과 기본값에서 확인한 규칙입니다.

| 항목 | 규칙 |
|---|---|
| 경로 매칭 타입 | `Exact`, `PathPrefix`, `RegularExpression`. 기본값은 `PathPrefix` |
| `matches` 생략 | `/` PathPrefix 매칭이 기본이라 모든 요청이 걸린다 |
| 우선순위 | Exact 경로 > 가장 긴 Prefix > 메서드 매칭 > 헤더 매칭 수 > 쿼리 매칭 수. 그래도 같으면 오래된 Route, 그다음 `{namespace}/{name}` 알파벳순 |
| 맞는 규칙이 없을 때 | 404 |
| `backendRefs[].weight` | 기본 1. 비율로 나뉜다 |

우선순위 줄은 요청 몇 개를 직접 넣어 보면 익숙해집니다. 한 Gateway에 규칙 세 개(`Exact /orders`, `PathPrefix /orders`, `PathPrefix /`)가 붙어 있다고 하겠습니다.

| 요청 경로 | 맞는 규칙 | 고른 규칙과 이유 |
|---|---|---|
| `/orders` | 셋 다 | `Exact /orders`. Exact가 Prefix보다 먼저 |
| `/orders/123` | `PathPrefix /orders`, `PathPrefix /` | `PathPrefix /orders`. 더 긴 접두사가 먼저 |
| `/ordersheet` | `PathPrefix /`만 | `PathPrefix /`. 접두사는 `/`로 나눈 경로 요소 단위라 `/orders`가 `/ordersheet`에 맞지 않는다 |
| `/board` | `PathPrefix /`만 | `PathPrefix /` |

`/ordersheet` 줄은 문자열 접두사로 생각하면 틀리는 곳입니다. 타입 정의 주석의 예로는 `/abc`가 `/abc`, `/abc/`, `/abc/def`에는 맞고 `/abcd`에는 맞지 않습니다. Ingress의 `Prefix`와 같은 규칙입니다(5-3절).

가중치는 백분율이 아닙니다. 타입 정의 기준으로 각 백엔드의 몫은 `weight / (그 목록의 weight 합)`입니다.

- `90`과 `10`은 `9`와 `1`과 같고 합이 100일 필요도 없습니다.
- `weight: 0`인 백엔드에는 요청을 보내지 않습니다. 새 버전을 잠깐 빼 둘 때 지우지 않고 0으로 내립니다.

결제 서비스의 새 버전이 10%만 받게 하는 예입니다.

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

TLS 종료는 Gateway 리스너의 속성이고 인증서와 키는 Secret에 둡니다(Migrating from Ingress 가이드).

"종료(Terminate)"는 손님 브라우저와 맺은 암호화 연결을 Gateway에서 풀어 평문 HTTP로 만든다는 뜻입니다. 암호를 풀지 않고 그대로 넘기는 방식과 나란히 놓으면 차이가 보입니다.

| 방식 | Gateway가 경로와 헤더를 읽나 | 라우팅을 맡는 Route |
|---|---|---|
| 종료(Terminate) | 읽는다 | HTTPRoute 규칙을 적용 |
| 그대로 넘김(`mode: Passthrough`) | 읽지 못한다 | 연결을 열 때 보이는 호스트 이름(SNI)만으로 고르는 TLSRoute |

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

- Gateway에 다른 네임스페이스의 Route를 붙이려면 리스너의 `allowedRoutes.namespaces.from`을 `All` 또는 `Selector`로 바꿉니다. 값은 `All`, `Selector`, `Same` 셋이고 기본은 `Same`입니다.
- HTTPRoute의 `backendRefs`가 다른 네임스페이스의 Service를 가리키려면 대상 네임스페이스에 ReferenceGrant가 있어야 합니다(4-6).

### 4-6. 헤더 매칭, 필터, ReferenceGrant

HTTPRoute 과제가 경로 나누기보다 한 단계 더 들어가면 매칭 조건과 필터가 나옵니다. 타입 정의(`httproute_types.go`)의 이름과 지원 수준입니다. Extended 기능은 구현체마다 지원 여부가 다릅니다.

| 항목 | 필드 | 지원 수준 |
|---|---|---|
| 헤더 매칭 | `matches[].headers[]`의 `name`, `value`. `type` 기본 `Exact` | Core(Exact) |
| 쿼리 매칭 | `matches[].queryParams[]` | Extended |
| 메서드 매칭 | `matches[].method` | Extended |
| 요청 헤더 바꾸기 | `filters[].type: RequestHeaderModifier`와 `set`, `add`, `remove` | Core |
| 리다이렉트 | `RequestRedirect`. `scheme`, `hostname`, `path`, `port`, `statusCode`(기본 302, 301·302·303·307·308만) | Core |
| 경로 재작성 | `URLRewrite`. `path.type`은 `ReplaceFullPath` 또는 `ReplacePrefixMatch` | Extended |
| 응답 헤더 바꾸기, 미러링 | `ResponseHeaderModifier`, `RequestMirror` | Extended |

조건을 묶는 방식은 NetworkPolicy의 `from`과 같은 대시 규칙입니다.

- 한 규칙 안에 `matches` 항목이 여럿이면 하나만 맞아도 됩니다(OR).
- 한 항목 안의 경로, 헤더, 쿼리 조건은 모두 맞아야 합니다(AND).

`ReplacePrefixMatch`는 그 규칙의 `PathPrefix` 매칭이 정확히 하나일 때만 허용됩니다.

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

다른 네임스페이스의 Service로 보내려면 `backendRefs`에 `namespace`를 적고 대상 네임스페이스에 ReferenceGrant를 만듭니다. ReferenceGrant는 자기와 같은 네임스페이스의 리소스에 대한 참조만 허용합니다.

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

ReferenceGrant가 없으면 Route의 `ResolvedRefs` 조건이 `False`, 사유 `RefNotPermitted`가 됩니다. 리스너 쪽에서 막히면 `Accepted` 조건에 `NotAllowedByListeners`나 `NoMatchingListenerHostname`이 보입니다.

```bash
kubectl -n shop describe httproute payment-header     # Conditions의 Accepted, ResolvedRefs
kubectl -n shop get httproute payment-header -o jsonpath='{range .status.parents[*].conditions[*]}{.type}={.status} {.reason}{"\n"}{end}'
kubectl get referencegrant -A
```

### 4-7. Ingress에서 옮기기

| Ingress | Gateway API |
|---|---|
| IngressClass | GatewayClass |
| Ingress의 진입점과 `tls` | Gateway 리스너 |
| Ingress의 `rules` | HTTPRoute `rules` |
| `pathType: Prefix` | `type: PathPrefix` |
| `pathType: Exact` | `type: Exact` (HTTPRoute의 `PathMatchType`은 `Exact`, `PathPrefix`, `RegularExpression`) |
| `defaultBackend` | 대응 필드 없음. `/` PathPrefix 규칙을 직접 만든다 |
| 컨트롤러별 어노테이션 | 리다이렉트, 헤더 수정, 트래픽 분할, 경로 재작성은 HTTPRoute 필드 |

가이드는 Ingress를 HTTPRoute로 바꿔 주는 ingress2gateway 프로젝트도 소개합니다. 변환 결과는 항상 시험해 보라는 당부가 함께 붙어 있습니다.

### 4-8. 자주 틀리는 지점

- Gateway API는 CRD라서 설치되어 있지 않으면 `kubectl get gateway`가 `the server doesn't have a resource type "gateway"`를 냅니다.
  - Getting started 가이드의 설치 명령은 `kubectl apply --server-side -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.6.1/standard-install.yaml`입니다(2026년 10월 가이드 기준). 같은 줄의 최신 패치는 v1.6.3(2026-10-06, conformance 수정)입니다.
  - CRD만 있고 구현체가 없으면 Gateway가 `Programmed`가 되지 않습니다.
- `parentRefs`에 Gateway 이름을 틀리게 적으면 Route가 붙지 않습니다. `kubectl describe httproute`의 `Accepted`와 `ResolvedRefs`를 봅니다.
- `hostnames`가 리스너의 `hostname`과 겹치지 않으면 요청이 이 Route로 오지 않습니다.
- Route가 다른 네임스페이스에 있는데 `allowedRoutes`가 기본값 `Same`이면 붙지 않습니다.
- `PathPrefix: /orders`는 경로를 바꾸지 않고 넘깁니다. 백엔드에 `/orders` 경로가 없으면 백엔드가 404를 돌려주므로 `URLRewrite`로 접두사를 바꿉니다(5-6 끝의 예).

### 4-9. 직접 해 보기

1. 연습 클러스터에 Gateway API CRD와 구현체 하나(예: Envoy Gateway)를 설치하고 `kubectl get gatewayclass`로 클래스 이름을 확인합니다.
2. 4-3의 Gateway와 HTTPRoute를 적용하고 `curl -H "Host: shop.example.com" http://<Gateway 주소>/orders`로 주문 API까지 가는지 봅니다. kind처럼 LB가 없으면 Gateway가 `Programmed=False`(`AddressNotAssigned`)로 남으니 구현체가 만든 NodePort로 보냅니다.
3. 4-4의 가중치 Route를 만들고 같은 요청을 100번 보내 v2 응답 비율이 10% 근처인지 셉니다.
4. 4-6의 헤더 매칭 Route를 적용해 `curl -H "x-canary: true"` 유무로 응답이 갈리는지, ReferenceGrant를 지웠을 때 `ResolvedRefs`가 `False`(`RefNotPermitted`)로 바뀌는지 봅니다.

## 5. Ingress 컨트롤러와 Ingress 리소스

### 5-1. 현재 위치

Ingress는 지금 "남아는 있지만 더 자라지 않는" 상태입니다. API와 컨트롤러 양쪽에서 소식이 하나씩 있어서 둘을 나눠 기억하면 덜 헷갈립니다.

| 대상 | 상태 |
|---|---|
| Ingress API | 문서 첫머리가 Ingress 대신 Gateway를 권하며 동결됐다고 밝힙니다. GA API라 제거 계획은 없고 개발은 멈췄습니다 |
| Ingress NGINX 컨트롤러 프로젝트 | 유지보수가 2026년 3월로 끝났습니다(Kubernetes 블로그, 2025-11-11 발표) |

은퇴한 것은 컨트롤러 프로젝트이고 Ingress API는 그대로 남습니다.

시험 환경의 Ingress 컨트롤러는 공식 문서에 나오지 않으니 `kubectl get ingressclass`로 확인합니다.

### 5-2. 컨트롤러와 리소스는 별개

<details>
<summary>기초부터: Ingress가 푸는 문제와 컨트롤러가 하는 일</summary>

> **핵심 한 줄**: Ingress는 L7 프록시 하나를 앞에 세워 호스트와 경로로 여러 Service에 나눠 보내는 규칙이고 그 규칙을 실제 프록시 설정으로 바꾸는 것이 Ingress 컨트롤러입니다.

#### 1. 왜 필요한가

쇼핑몰의 주문, 게시판, 결제 화면을 모두 밖에 공개한다고 하겠습니다.

| 방식 | 생기는 일 |
|---|---|
| NodePort | `http://<노드IP>:30080`처럼 포트 번호가 주소에 드러나고 서비스마다 포트가 따로 생긴다 |
| LoadBalancer | Service마다 클라우드 로드밸런서가 하나씩 생겨 비용과 관리할 주소가 서비스 수만큼 늘어난다. HTTPS 인증서도 서비스마다 붙인다 |
| Ingress | 진입점 하나가 호스트와 URL 경로를 보고 알맞은 Service로 나눠 보내고 TLS도 그 자리에서 한 번에 푼다 |

#### 2. 두 부품

| 부품 | 정체 | 누가 설치하나 |
|---|---|---|
| **Ingress 컨트롤러** | 실제로 요청을 받는 프록시와 그 설정을 갱신하는 컨트롤러. 보통 Deployment나 DaemonSet, 프록시 설정을 담는 ConfigMap(구현체에 따라), 바깥에서 들어오게 하는 NodePort나 LoadBalancer Service, API를 watch할 ServiceAccount와 RBAC 권한으로 구성 | 관리자. 쿠버네티스 기본 설치에 들어 있지 않다 |
| **Ingress 리소스** | "이 호스트, 이 경로는 이 Service로"라는 규칙 | 앱 담당자 |

#### 3. 어떻게 동작하나

1. **watch**: 컨트롤러가 Ingress, Service, EndpointSlice를 watch합니다.
2. **설정 반영**: Ingress가 생기거나 바뀌면 그 규칙을 자기 프록시 설정으로 바꿔 적용합니다.
3. **전달**: 요청이 컨트롤러의 Service로 들어오면 프록시가 규칙에 맞는 백엔드 Pod로 보냅니다.

```text
사용자 → LB/NodePort → 컨트롤러 Service → 프록시 Pod
   ├─ shop.example/orders → order-api Service → Pod
   ├─ shop.example/board  → board Service → Pod
   └─ 맞는 규칙 없음      → defaultBackend (없으면 컨트롤러 기본 동작, 대개 404)
```

#### 4. 규칙 모양 세 가지

| 모양 | 쓰는 법 |
|---|---|
| 기본 백엔드만 | `spec.defaultBackend` 하나로 모든 요청을 한 Service로 |
| 경로 기준 | 같은 호스트에서 `/orders`는 주문 API, `/board`는 게시판으로(5-4절의 첫 예) |
| 호스트 기준 | `orders.shop.example`, `board.shop.example`처럼 `rules[]`에 `host`가 다른 항목을 여러 개 |

#### 5. 헷갈리는 점 / 실전에서 보이는 모습

- 컨트롤러 없이 Ingress만 만들면 객체는 저장되지만 아무 일도 일어나지 않습니다.
- 옛 강의가 전제하는 ingress-nginx 컨트롤러는 2026년 3월 유지보수가 끝났습니다. 시험 환경에서는 `kubectl get ingressclass`로 실제 컨트롤러를 확인합니다.

> **정리**: Ingress를 만들었는데 아무 반응이 없으면 `kubectl get ingressclass`로 컨트롤러가 있는지부터 봅니다. 규칙(Ingress)과 실행자(컨트롤러)를 나눈 이 구조를 역할별로 더 쪼갠 것이 앞 절의 Gateway API입니다.

</details>

Ingress 리소스는 규칙만 담습니다. 규칙을 읽어 실제 프록시를 설정하는 것은 Ingress 컨트롤러입니다.

컨트롤러는 kube-controller-manager에 들어 있지 않으므로 따로 설치합니다. 컨트롤러가 없으면 Ingress를 만들어도 아무 일이 일어나지 않습니다.

여러 컨트롤러를 둘 때는 IngressClass로 나눕니다.

| 항목 | 내용 |
|---|---|
| Ingress가 클래스를 고르는 법 | `spec.ingressClassName: <IngressClass 이름>` |
| 기본 클래스 | IngressClass에 어노테이션 `ingressclass.kubernetes.io/is-default-class: "true"` |
| 클래스를 생략하면 | 기본으로 표시된 IngressClass가 정확히 하나일 때 그 클래스가 적용된다 |
| 옛 방식 | `kubernetes.io/ingress.class` 어노테이션(사용 중단) |

```bash
kubectl get ingressclass
```

### 5-3. 규칙과 pathType

각 규칙은 선택적인 `host`와 `paths` 목록으로 이루어집니다. `host`를 생략하면 모든 호스트에 적용됩니다.

경로마다 `pathType`이 반드시 있어야 합니다. 빠뜨리면 검증에서 실패합니다.

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
| Prefix | `/`, `/aaa` | `/aaa/ccc` | 예. `/aaa`가 이긴다 |
| 혼합 | `/foo`(Prefix), `/foo`(Exact) | `/foo` | 예. Exact 우선 |

여러 경로가 맞을 때의 우선순위는 두 줄로 외웁니다.

1. 가장 긴 경로가 먼저
2. 길이가 같으면 Exact가 먼저

어느 규칙에도 맞지 않는 요청은 `defaultBackend`로 갑니다. `defaultBackend`가 없으면 처리는 컨트롤러에 달려 있습니다. `rules`가 없는 Ingress는 `defaultBackend`가 반드시 있어야 합니다.

### 5-4. 명령으로 만들기

`kubectl create ingress`의 규칙 문법은 `host/path=service:port[,tls[=secret]]`입니다.

pathType은 경로 끝의 `*`로 정합니다. 붙이면 `pathType: Prefix`, 붙이지 않으면 `Exact`가 됩니다.

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

`--dry-run=client -o yaml`로 뽑으면 이런 모양입니다. 클래스 이름 `nginx`는 `kubectl get ingressclass`에 나온 이름으로 바꿉니다.

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
- `tls` 절의 `hosts`는 `rules`의 `host`와 명시적으로 맞아야 합니다. 호스트 없는 규칙에는 TLS가 동작하지 않습니다.

### 5-6. 경로 재작성 어노테이션 rewrite-target

요청은 `/orders/123`으로 들어오는데 주문 API는 `/123`만 알아듣는 경우가 있습니다. Ingress 스펙에는 경로를 바꿔 전달하는 필드가 없어서 컨트롤러 어노테이션으로 해결합니다.

연습 문제에 자주 나오는 것은 ingress-nginx의 `rewrite-target`입니다. Rewrite 예제는 정규식 캡처 그룹을 씁니다.

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

`(.*)`가 잡은 부분이 `$2`로 들어갑니다.

| 들어온 요청 | 백엔드에 전달되는 경로 |
|---|---|
| `/orders/123` | `/123` |
| `/orders` | `/` |

정규식 경로라 `pathType`은 `ImplementationSpecific`입니다.

옛 자료를 볼 때 조심할 곳이 있습니다. ingress-nginx 0.22.0부터 캡처 그룹으로 지정해야 하므로 옛 자료의 `rewrite-target: /` 한 줄짜리 예는 결과를 `curl`로 확인합니다.

이 어노테이션은 ingress-nginx 전용입니다. Gateway API에서는 HTTPRoute의 `URLRewrite` 필터가 같은 일을 표준 필드로 합니다.

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

- `ingressClassName`을 빼먹었는데 기본 IngressClass가 없으면 어느 컨트롤러도 이 Ingress를 처리하지 않습니다. `kubectl get ingress`의 ADDRESS가 비어 있으면 먼저 의심합니다.
- 백엔드 Service는 Ingress와 같은 네임스페이스에 있어야 합니다. Ingress의 backend에는 네임스페이스 필드가 없습니다.
- 백엔드 포트에 Pod의 `targetPort`를 적는 실수가 잦습니다. Ingress 백엔드는 Service 포트를 가리킵니다.
- 컨트롤러별 어노테이션은 다른 컨트롤러로 옮기면 동작하지 않습니다.

### 5-8. 직접 해 보기

1. `kubectl get ingressclass`로 기본 클래스가 있는지 보고 없으면 하나에 기본 어노테이션을 붙입니다. 기본 클래스가 있으면 `ingressClassName` 없이 만든 Ingress에도 그 이름이 채워집니다.
2. 5-4의 첫 명령으로 Ingress를 만들고 `curl -H "Host: shop.example.com" http://<컨트롤러 주소>/orders/123`이 주문 API로 가는지 확인합니다.
3. 5-6의 rewrite-target 예제를 적용해 `/orders/123` 요청이 백엔드에 `/123`으로 도착하는지 백엔드 접근 로그로 봅니다.
4. 같은 Ingress를 4절의 Gateway와 HTTPRoute로 옮겨 보고 두 YAML을 비교합니다.

## 6. CoreDNS

### 6-1. 어떻게 붙어 있나

<details>
<summary>기초부터: 리눅스에서 이름이 IP로 바뀌는 과정</summary>

> **핵심 한 줄**: 리눅스 프로그램은 `/etc/nsswitch.conf`가 정한 순서로 `/etc/hosts`와 `/etc/resolv.conf`의 DNS 서버를 보고 이름을 IP로 바꿉니다. Pod 안도 같은 규칙을 따릅니다.

#### 1. 왜 필요한가

| 방식 | 장점 | 한계 |
|---|---|---|
| `/etc/hosts`에 `192.168.1.11 db`처럼 각자 적기 | 빠르고 확실하다 | 서버가 100대면 100대의 파일을 고치고 IP가 바뀔 때마다 다시 고친다 |
| DNS 서버에 장부를 모으기 | 한곳만 고치면 된다 | 어느 서버에 물을지 각 호스트가 알아야 한다(`/etc/resolv.conf`) |

#### 2. 어떻게 동작하나

1. **순서 정하기**: `/etc/nsswitch.conf`의 `hosts: files dns` 줄 순서대로 봅니다. 보통 files(`/etc/hosts`)가 먼저입니다.
2. **hosts 파일**: 맞는 줄이 있으면 그 IP를 씁니다. 쿠버네티스에서는 Pod 스펙의 `hostAliases`로 그 Pod의 `/etc/hosts`에 줄을 넣을 수 있습니다.
3. **search 꼬리 붙이기**: 짧은 이름이면 `search` 목록의 도메인을 차례로 붙여 봅니다. 아래 설정에서 `payment`는 `payment.shop.svc.cluster.local`부터 물어봅니다.
4. **DNS 서버에 묻기**: `nameserver` 줄의 서버에 질의하고 레코드로 답을 받습니다.

```
nameserver 10.96.0.10
search shop.svc.cluster.local svc.cluster.local cluster.local
options ndots:5
```

```text
curl payment → nsswitch(hosts: files dns)
   ├─ files: /etc/hosts에 payment 있나? → 없음
   └─ dns: search 붙이기 → payment.shop.svc.cluster.local → nameserver 10.96.0.10에 질의 → A 레코드
```

같은 네임스페이스의 Service를 이름만으로 부를 수 있는 것도 이 search 줄 덕분입니다. Pod 이름은 이 방식으로 풀리지 않습니다(6-2절).

2단계의 `hostAliases`는 특정 Pod 하나만 다른 주소로 보내 시험할 때 씁니다. Pod 안의 `/etc/hosts`는 kubelet이 관리해서 직접 고친 줄은 컨테이너가 다시 만들어질 때 사라질 수 있으므로 스펙에 적습니다.

```yaml
spec:
  hostAliases:
  - ip: "10.0.0.99"          # 시험용 결제 DB 주소
    hostnames:
    - "payment-db.internal"
```

#### 3. 레코드 종류

| 레코드 | 내용 |
|---|---|
| A | 이름 → IPv4 주소 |
| AAAA | 이름 → IPv6 주소 |
| CNAME | 이름 → 다른 이름(별칭). ExternalName Service의 응답이 이것 |
| SRV | 서비스 이름 → 호스트와 포트. 이름 붙은 Service 포트에 쓰인다 |

#### 4. 헷갈리는 점: 도구마다 보는 곳이 다르다

| 도구 | `/etc/hosts`를 보나 | 쓰는 목적 |
|---|---|---|
| `ping`, `curl`, `getent hosts` | 본다(nsswitch 순서) | 이 Pod의 프로그램이 실제로 어디로 가는지 |
| `nslookup`, `dig` | 보지 않고 DNS 서버에 바로 묻는다 | DNS 서버가 제대로 답하는지 |

hosts 파일로 바꾼 이름을 `nslookup`으로 확인하면 DNS 서버의 원래 답이 나옵니다.

- `dig`는 `nslookup`보다 많이 보여 줍니다. 질의한 서버, 응답 섹션의 레코드와 TTL, 걸린 시간(`Query time`)이 함께 나옵니다.
- `/etc/resolv.conf`에는 `nameserver` 줄을 여러 개 둘 수 있습니다. 리졸버는 앞의 서버가 응답하지 않을 때 다음 서버로 넘어갑니다. 앞 서버가 "그런 이름 없음"이라고 답하면 뒤 서버에 다시 묻지 않습니다.
- hosts 파일 바꿔치기는 DNS 레코드를 바꾸기 전에 내 컴퓨터에서만 새 서버로 접속해 볼 때도 씁니다. 쿠버네티스에서 Pod 하나만 다른 주소로 보낼 때가 위의 `hostAliases`입니다.

> **정리**: `/etc/hosts`나 `hostAliases`로 바꾼 이름은 `nslookup`에 나오지 않으니 `getent hosts`로 확인합니다. 다음 토글에서는 쿠버네티스가 이 resolv.conf를 누가 어떻게 채우는지 봅니다.

</details>

Customizing DNS Service 문서 기준입니다.

| 항목 | 내용 |
|---|---|
| 정체 | 클러스터 DNS로 쓰는 플러그인 구조의 DNS 서버 |
| Service 이름 | `kube-dns` (`kube-system`). 옛 kube-dns 이름에 기대는 워크로드와의 호환용 |
| Pod 라벨 | `k8s-app=kube-dns` |
| 설정 | `kube-system`의 ConfigMap `coredns`에 든 Corefile |
| Pod가 DNS 서버를 아는 방법 | kubelet의 `clusterDNS`(플래그 `--cluster-dns`) 값이 각 컨테이너의 resolv.conf로 들어감 |
| 클러스터 도메인 | kubelet의 `clusterDomain`(플래그 `--cluster-domain`). 흔히 `cluster.local` |

kubeadm 클러스터에서는 이 값들이 kubelet 설정 파일 `/var/lib/kubelet/config.yaml`에 있습니다(예: `clusterDNS: [10.96.0.10]`, `clusterDomain: cluster.local`).

`clusterDNS`와 `kube-dns` Service의 클러스터 IP가 어긋나면 Pod가 엉뚱한 DNS 서버를 봅니다.

이름 때문에 헷갈리는 곳이 하나 있습니다. Service 이름 `kube-dns`와 옛 kube-dns 애드온은 서로 다릅니다.

- CoreDNS의 Service 이름이 `kube-dns`인 것은 옛 kube-dns와의 호환 때문입니다(Debugging DNS Resolution 문서).
- 옛 kube-dns 애드온 빌드는 v1.37 릴리스 글에 따르면 v1.40 이후 중단될 예정입니다.

### 6-2. 무엇이 어떤 이름을 받나

<details>
<summary>기초부터: 클러스터 DNS가 이름을 알고 Pod에 알려 주는 과정</summary>

> **핵심 한 줄**: CoreDNS는 API 서버를 watch해 Service 이름을 알고 kubelet은 각 Pod의 resolv.conf에 CoreDNS 주소를 적어 줍니다. 이 두 줄이 이어져야 이름이 풀립니다.

#### 1. 왜 필요한가

Service는 수시로 생기고 지워집니다. 누가 따로 DNS에 등록하지 않아도 Service를 만들자마자 이름으로 부를 수 있어야 하고 모든 Pod가 같은 DNS 서버를 바라봐야 합니다.

#### 2. 어떻게 동작하나

1. **이름 알기**: CoreDNS는 `kube-system`에 Deployment(kubeadm 기본 복제본 2개)로 뜹니다. `kubernetes` 플러그인이 API 서버를 watch하며 Service와 EndpointSlice를 메모리에 들고 있어서 Service가 생기면 곧바로 답합니다.
2. **Service 앞세우기**: CoreDNS Pod 앞에 `kube-dns`라는 이름의 ClusterIP Service가 있습니다(kubeadm 기본 10.96.0.10).
3. **kubelet 설정**: 각 노드의 kubelet 설정에 `clusterDNS: [10.96.0.10]`, `clusterDomain: cluster.local`이 있습니다. kubelet은 이 설정값을 그대로 쓰고 Service를 조회해서 찾지는 않습니다.
4. **resolv.conf 써 주기**: kubelet이 Pod를 띄울 때 `/etc/resolv.conf`에 `nameserver <clusterDNS>`와 `search <ns>.svc.cluster.local svc.cluster.local cluster.local`을 씁니다.
5. **바깥 이름**: 클러스터 도메인 밖의 이름(예: `example.com`)은 `forward` 플러그인이 CoreDNS Pod의 `/etc/resolv.conf`에 적힌 업스트림 DNS로 넘깁니다.

```text
[CoreDNS가 아는 길]  Service 생성 → API 서버 → (watch) CoreDNS kubernetes 플러그인

[Pod가 묻는 길]
Pod 앱 → /etc/resolv.conf(nameserver 10.96.0.10, kubelet이 씀)
   → kube-dns Service 10.96.0.10:53 → CoreDNS Pod
        ├─ *.cluster.local → 메모리의 Service 정보로 응답
        └─ 그 밖 → forward → 업스트림 DNS
```

#### 3. 이름 구조 읽기

`payment.billing.svc.cluster.local`을 뒤에서부터 읽습니다.

| 조각 | 뜻 |
|---|---|
| `cluster.local` | 클러스터 도메인 |
| `svc` | Service 레코드라는 표시 |
| `billing` | 네임스페이스 |
| `payment` | Service 이름 |

search 목록 덕분에 같은 네임스페이스에서는 `payment`, 다른 네임스페이스에서는 `payment.billing`까지만 써도 됩니다.

| Pod가 받는 이름 | 조건 |
|---|---|
| `10-244-1-5.shop.pod.cluster.local` | IP의 점을 대시로 바꾼 이름. Corefile의 `pods` 설정에 따라 응답(kubeadm 기본 `pods insecure`). search 목록에 없어 전체를 적어야 한다 |
| `order-db-0.order-db...` | Pod에 `hostname`과 `subdomain`을 주고 같은 이름의 headless Service를 둘 때. StatefulSet Pod가 이 방식 |

#### 4. 실전에서 보이는 모습

Debugging DNS Resolution 문서 기준으로 `kubectl exec -i -t dnsutils -- nslookup kubernetes.default`가 아래처럼 나오면 CoreDNS 애드온이나 관련 Service에 문제가 있습니다.

```
Server:    10.0.0.10
Address 1: 10.0.0.10

nslookup: can't resolve 'kubernetes.default'
```

같은 문서의 점검 순서는 이렇습니다.

1. Pod의 `/etc/resolv.conf`를 봅니다(`kubectl exec -ti dnsutils -- cat /etc/resolv.conf`).
2. CoreDNS Pod가 도는지 봅니다(`kubectl get pods -n kube-system -l k8s-app=kube-dns`).
3. CoreDNS 로그를 봅니다(`kubectl logs -n kube-system -l k8s-app=kube-dns`).
4. `kube-dns` Service와 EndpointSlice가 있는지 봅니다(`kubectl get endpointslice -l kubernetes.io/service-name=kube-dns -n kube-system`).

> **정리**: kubelet은 Service를 조회하지 않고 설정값 `clusterDNS`를 그대로 resolv.conf에 씁니다. 이름이 안 풀리면 resolv.conf, CoreDNS Pod, kube-dns Service 순으로 따라갑니다.

</details>

DNS for Services and Pods 문서 기준입니다.

| 대상 | 이름 | 응답 |
|---|---|---|
| 일반 Service | `<svc>.<ns>.svc.<cluster-domain>` | A/AAAA, 클러스터 IP |
| headless Service | 같음 | 백엔드 Pod IP 전부 |
| 이름 붙은 포트 | `_<port-name>._<protocol>.<svc>.<ns>.svc.<cluster-domain>` | SRV |
| ExternalName Service | `<svc>.<ns>.svc.<cluster-domain>` | CNAME |
| Pod(hostname과 subdomain 지정, 같은 이름의 headless Service 존재) | `<hostname>.<subdomain>.<ns>.svc.<cluster-domain>` | A/AAAA |
| Pod IP 기반 이름 | `<a-b-c-d>.<ns>.pod.<cluster-domain>` (IP의 점을 대시로) | A |

마지막 줄은 IP가 `172.17.0.3`인 `default` 네임스페이스 Pod라면 `172-17-0-3.default.pod.cluster.local`입니다.

이 레코드에 답할지는 CoreDNS `kubernetes` 플러그인의 `pods` 설정이 정합니다.

| `pods` 설정 | 동작 |
|---|---|
| `disabled` (기본값) | 응답 안 함 |
| `insecure` (6-4의 Corefile) | Pod가 있는지 확인하지 않고 이름의 IP를 돌려줌 |

Pod 이름 자체로 부르는 레코드는 없습니다.

kubelet이 Pod에 써 주는 `/etc/resolv.conf`는 이런 모양입니다(문서 예시).

```
nameserver 10.32.0.10
search <namespace>.svc.cluster.local svc.cluster.local cluster.local
options ndots:5
```

`search` 덕분에 같은 네임스페이스에서는 `payment`만으로, 다른 네임스페이스는 `payment.billing`처럼 짧게 부릅니다.

네임스페이스를 빼면 자기 네임스페이스에서만 찾습니다. 그래서 `shop`의 Pod가 `billing`의 `payment`를 `payment`로 부르면 풀리지 않습니다.

`ndots:5`는 점이 5개보다 적은 이름에 search 목록을 먼저 붙여 본다는 뜻입니다. 이 탓에 외부 도메인 질의가 몇 배로 늘어납니다. 끝에 점을 붙인 FQDN이나 Pod의 `dnsConfig.options`로 줄입니다.

`shop` 네임스페이스의 주문 API가 외부 결제 대행사 `api.pay.example.com`을 부를 때 실제로 나가는 질의를 순서대로 적으면 이렇습니다. 이 이름에는 점이 3개라 5개보다 적습니다.

| 순서 | 질의하는 이름 | 결과 |
|---|---|---|
| 1 | `api.pay.example.com.shop.svc.cluster.local` | NXDOMAIN |
| 2 | `api.pay.example.com.svc.cluster.local` | NXDOMAIN |
| 3 | `api.pay.example.com.cluster.local` | NXDOMAIN |
| 4 | `api.pay.example.com` | 응답 |

답을 받기까지 이름 네 개를 묻고 앞의 셋은 헛걸음입니다. IPv4(A)와 IPv6(AAAA)를 함께 묻는 리졸버라면 질의 수가 두 배가 됩니다.

반대로 클러스터 안 이름에는 이 설정이 유리합니다. `payment`처럼 점이 없는 이름은 1번에서 바로 풀립니다. ndots를 5로 크게 잡아 두면 `payment.billing`이나 `order-db-0.order-db`처럼 점이 몇 개 있는 클러스터 안 이름도 search 목록으로 먼저 찾습니다.

Marco Pracucci는 같은 현상을 측정한 글에서 외부 이름을 자주 부르는 Pod라면 끝에 점을 붙이거나 그 Pod만 `ndots`를 낮추라고 권했습니다([Kubernetes pods /etc/resolv.conf ndots:5 option, 2018](https://pracucci.com/kubernetes-dns-resolution-ndots-options-and-why-it-may-affect-application-performances.html)).

```yaml
spec:
  dnsConfig:
    options:
    - name: ndots
      value: "2"        # 점이 2개 이상이면 바로 그 이름부터 묻는다
```

Pod는 대개 Ready여야 DNS 레코드를 받습니다. Service에 `publishNotReadyAddresses: true`를 주면 예외입니다.

### 6-3. dnsPolicy

| 값 | 동작 |
|---|---|
| `ClusterFirst` | 클러스터 도메인에 맞지 않는 질의는 업스트림으로 전달. `dnsPolicy`를 생략하면 이것 |
| `Default` | 노드의 이름 해석 설정을 물려받는다. 이름과 달리 기본값이 아니다 |
| `ClusterFirstWithHostNet` | `hostNetwork: true` Pod가 클러스터 DNS를 쓰려면 명시. 안 하면 `Default`처럼 동작 |
| `None` | 쿠버네티스 DNS 설정을 무시하고 `dnsConfig`로 전부 지정 |

### 6-4. 기본 Corefile 읽기

Customizing DNS Service 문서에 실린 기본 Corefile입니다. kubeadm 1.37이 만드는 Corefile은 여기서 두 군데가 다릅니다.

- `forward . /etc/resolv.conf { max_concurrent 1000 }`처럼 동시 질의 상한이 붙습니다.
- `cache 30` 블록 안에 `disable success cluster.local`, `disable denial cluster.local`이 들어갑니다.

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

| 플러그인 | 역할 |
|---|---|
| `health`, `ready` | `:8080/health` 상태 보고, `:8181`에서 준비되면 200 |
| `kubernetes` | Service와 Pod IP로 응답. `fallthrough`는 역방향 조회가 NXDOMAIN이면 다음 플러그인으로 넘긴다 |
| `forward` | 클러스터 도메인 밖의 질의를 `/etc/resolv.conf`의 리졸버로 |
| `cache` | 응답 캐시(초) |
| `loop` | 단순 전달 루프를 감지하면 CoreDNS 프로세스를 멈춘다 |
| `reload` | Corefile이 바뀌면 자동 재적재. 문서 기준 반영까지 2분 정도 |

### 6-5. 설정 바꾸기

특정 도메인만 다른 DNS 서버로 보내는 stub 도메인과 업스트림 변경은 `forward` 플러그인으로 합니다. 클러스터 밖의 별도 DNS 서버가 관리하는 도메인 `corp.example`을 10.150.0.1로 보내는 예입니다(문서의 Consul 예시를 바꾼 것).

```bash
kubectl -n kube-system get configmap coredns -o yaml > coredns-backup.yaml
kubectl -n kube-system edit configmap coredns
```

```
corp.example:53 {
    errors
    cache 30
    forward . 10.150.0.1
}
```

무엇을 바꾸고 싶은지에 따라 고치는 곳이 다릅니다.

| 하고 싶은 일 | 고치는 곳 |
|---|---|
| 특정 도메인만 다른 서버로 | 위 블록을 기존 `.:53 { ... }` 블록 옆에 추가 |
| 클러스터 밖 질의를 모두 특정 서버로 | 기존 블록의 `forward . /etc/resolv.conf`를 `forward . 172.16.0.1`처럼 바꿈 |

`reload`가 있으면 재시작 없이 반영되지만 시간이 걸립니다. 급하면 `kubectl -n kube-system rollout restart deployment coredns`로 다시 띄웁니다. kubeadm이 아닌 클러스터라면 `kubectl -n kube-system get deploy`로 이름부터 확인합니다.

### 6-6. DNS 문제를 좁히는 순서

Debugging DNS Resolution 문서의 순서입니다.

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

`busybox:1.36`의 `nslookup`은 search 처리 탓에 `order-api.shop` 같은 짧은 이름도 NXDOMAIN으로 보일 수 있으니 dnsutils 이미지를 씁니다.

### 6-7. 자주 틀리는 지점

- `dnsPolicy: Default`를 "기본값"으로 읽는 실수. 생략 시 기본은 `ClusterFirst`입니다.
- Egress를 막은 네임스페이스에서 DNS가 안 되는 것을 CoreDNS 장애로 오해합니다. 2-4절의 DNS 허용 규칙부터 확인합니다.
- Corefile 수정 중 중괄호를 하나 잃으면 CoreDNS가 시작하지 못해 `CrashLoopBackOff`에 빠집니다. 수정 전에 ConfigMap을 파일로 백업합니다.
- `loop` 플러그인이 루프를 감지해도 CoreDNS가 `CrashLoopBackOff`에 빠집니다. Troubleshooting kubeadm 문서는 해결 방법을 CoreDNS 저장소의 loop 플러그인 문서로 넘깁니다.

### 6-8. 직접 해 보기

1. default 네임스페이스의 `dnsutils` Pod에서 `nslookup order-api.shop`, `nslookup order-api.shop.svc.cluster.local`, `nslookup order-api`를 실행합니다. 앞의 둘은 풀리고 `order-api`만 NXDOMAIN이어야 합니다. 이유를 search 목록으로 설명해 봅니다.
2. `coredns` ConfigMap에 `log`를 추가하고 같은 질의가 로그에 찍히는지 본 뒤 되돌립니다. search 도메인을 붙인 질의가 먼저 나가는 것도 보입니다.
3. `order-api`를 headless Service(`clusterIP: None`)로 하나 더 만들고 `nslookup` 결과가 Pod IP 여러 개로 나오는지 봅니다.
4. `pods insecure` 설정에서 `nslookup <a-b-c-d>.shop.pod.cluster.local`을 존재하는 Pod IP와 존재하지 않는 IP로 각각 질의합니다. 둘 다 그 IP로 A 레코드가 돌아옵니다.

## 7. 확인 문제

직접 만든 연습 과제입니다. 시험 문항이나 덤프에서 옮긴 것이 아닙니다.

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

**문제 3.** `order-api` Service에 요청하면 응답이 없습니다. Service와 Pod는 모두 있고 Pod는 Running입니다. 확인 순서를 세 단계로 적으세요.

<details>
<summary>답 보기</summary>

1. `kubectl get endpointslices -l kubernetes.io/service-name=order-api`로 엔드포인트가 있는지 봅니다. 비어 있으면 selector와 Pod 라벨, Pod의 Ready 여부를 확인합니다.
2. 엔드포인트가 있으면 임시 Pod에서 Pod IP와 `targetPort`로 직접 요청해 Pod 자체가 응답하는지 봅니다. 실패하면 `targetPort`와 컨테이너 포트가 맞는지, 앱이 그 포트에서 듣는지 봅니다.
3. Pod 직접 요청은 되는데 Service IP로만 실패하면 NetworkPolicy와 kube-proxy(또는 대체 프록시) 상태를 봅니다.

</details>

**문제 4.** 네임스페이스 `web`의 HTTPRoute가 `shop`의 Gateway `shop-gw`를 `parentRefs`로 가리키는데 Route 상태가 `Accepted=False`, 사유 `NotAllowedByListeners`입니다. 무엇을 고치나요?

<details>
<summary>답 보기</summary>

Gateway 리스너의 `allowedRoutes.namespaces.from`이 기본값 `Same`이라 다른 네임스페이스의 Route를 받지 않습니다. `shop-gw`의 리스너에 `from: All`을 주거나 `from: Selector`와 `selector.matchLabels`(`kubernetes.io/metadata.name: web`)를 줍니다. HTTPRoute의 `parentRefs`에는 `namespace: shop`이 있어야 합니다. 이 Route가 다른 네임스페이스의 Service까지 가리킨다면 그때는 ReferenceGrant가 따로 필요합니다(`ResolvedRefs`/`RefNotPermitted`).

</details>

**문제 5.** `shop` 네임스페이스의 Pod에서 `payment.billing`은 풀리는데 `payment`는 풀리지 않습니다. 정상인가요?

<details>
<summary>답 보기</summary>

정상입니다. 네임스페이스 없이 부르면 search 목록의 첫 항목인 `shop.svc.cluster.local`부터 붙여 찾으므로 자기 네임스페이스에서만 찾습니다. `payment`가 `billing`에 있으면 `payment.billing`처럼 네임스페이스를 붙여야 합니다.

</details>

**문제 6.** kubeadm 클러스터에서 새 워커 노드가 `NotReady`이고 그 노드에 배치된 Pod는 `ContainerCreating`에 머뭅니다. 노드에 들어가서 먼저 볼 디렉터리 두 개와 로그 두 개를 적고 이 클러스터의 Service IP 대역은 어디서 확인하는지 답하세요.

<details>
<summary>답 보기</summary>

디렉터리는 둘입니다.

- `/etc/cni/net.d`: CNI 설정
- `/opt/cni/bin`: 플러그인 실행 파일

설정 파일이 없거나 `"type"`에 적힌 이름의 실행 파일이 없으면 런타임이 네트워크를 만들지 못합니다.

CNI를 부르는 쪽은 컨테이너 런타임이므로 로그는 `journalctl -u containerd`와 `journalctl -u kubelet`을 봅니다.

Service IP 대역은 컨트롤 플레인 노드의 `/etc/kubernetes/manifests/kube-apiserver.yaml`에 있는 `--service-cluster-ip-range`이고 `kubectl get servicecidrs`로도 볼 수 있습니다.

</details>

## 참고 자료

시험 범위
- CNCF, [CKA Curriculum v1.37](https://github.com/cncf/curriculum/blob/master/CKA_Curriculum_v1.37.pdf)

kubernetes.io
- [Services, Load Balancing, and Networking](https://kubernetes.io/docs/concepts/services-networking/), [Cluster Networking](https://kubernetes.io/docs/concepts/cluster-administration/networking/), [Ports and Protocols](https://kubernetes.io/docs/reference/networking/ports-and-protocols/)
- [Network Plugins](https://kubernetes.io/docs/concepts/extend-kubernetes/compute-storage-net/network-plugins/), containerd [CRI 설정](https://github.com/containerd/containerd/blob/main/docs/cri/config.md)
- [Virtual IPs and Service Proxies](https://kubernetes.io/docs/reference/networking/virtual-ips/)
- [Network Policies](https://kubernetes.io/docs/concepts/services-networking/network-policies/)
- [Service](https://kubernetes.io/docs/concepts/services-networking/service/)
- [EndpointSlices](https://kubernetes.io/docs/concepts/services-networking/endpoint-slices/)
- [Debug Services](https://kubernetes.io/docs/tasks/debug/debug-application/debug-service/)
- [Using Source IP](https://kubernetes.io/docs/tutorials/services/source-ip/) (externalTrafficPolicy와 healthCheckNodePort)
- [Gateway API](https://kubernetes.io/docs/concepts/services-networking/gateway/)
- [Ingress](https://kubernetes.io/docs/concepts/services-networking/ingress/)
- [Ingress Controllers](https://kubernetes.io/docs/concepts/services-networking/ingress-controllers/)
- [DNS for Services and Pods](https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/)
- [Customizing DNS Service](https://kubernetes.io/docs/tasks/administer-cluster/dns-custom-nameservers/)
- [Debugging DNS Resolution](https://kubernetes.io/docs/tasks/administer-cluster/dns-debugging-resolution/)
- [Troubleshooting kubeadm](https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/troubleshooting-kubeadm/)
- Kubernetes Blog, [Ingress NGINX Retirement: What You Need to Know](https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/), 2025-11-11
- Kubernetes Blog, [Kubernetes v1.37 release](https://kubernetes.io/blog/2026/08/26/kubernetes-v1-37-release/), 2026-08-26

Gateway API
- [Getting started with Gateway API](https://gateway-api.sigs.k8s.io/guides/)
- [Migrating from Ingress](https://gateway-api.sigs.k8s.io/guides/getting-started/migrating-from-ingress/)
- [ReferenceGrant](https://gateway-api.sigs.k8s.io/reference/api-types/referencegrant/)
- [Gateway API Security Model](https://gateway-api.sigs.k8s.io/docs/concepts/security/)
- kubernetes-sigs/gateway-api, [apis/v1/httproute_types.go](https://github.com/kubernetes-sigs/gateway-api/blob/main/apis/v1/httproute_types.go)
- kubernetes-sigs/gateway-api, [apis/v1/shared_types.go의 BackendRef Weight](https://github.com/kubernetes-sigs/gateway-api/blob/main/apis/v1/shared_types.go)

CNI, Ingress 컨트롤러, CoreDNS
- flannel-io, [flannel README](https://github.com/flannel-io/flannel)
- ingress-nginx, [Rewrite](https://kubernetes.github.io/ingress-nginx/examples/rewrite/)
- CoreDNS, [kubernetes plugin](https://coredns.io/plugins/kubernetes/)

기술 블로그
- Marco Pracucci, [Kubernetes pods /etc/resolv.conf ndots:5 option and why it may negatively affect your application performances](https://pracucci.com/kubernetes-dns-resolution-ndots-options-and-why-it-may-affect-application-performances.html), 2018-08-10

이 블로그의 관련 글
- [쿠버네티스 아래의 리눅스 5: Service의 실체는 커널 규칙](/blog/theory/systems/k8s-linux-05-service-iptables-conntrack) (시험 범위 밖 심화)

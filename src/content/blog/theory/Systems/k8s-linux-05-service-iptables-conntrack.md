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

패킷 한 개는 계층마다 머리말을 하나씩 덧씌운 묶음입니다. 이 글에서 바꾸는 머리말은 주로 3계층(IP)과 4계층(포트)입니다.

| 계층(TCP/IP 모델) | 머리말에 든 주소 | 이 글에서 다루는 것 |
|---|---|---|
| 링크 | MAC 주소 | Calico의 proxy ARP(5절) |
| 인터넷 | 출발지 IP, 목적지 IP, TTL | DNAT, SNAT, TTL 감소 |
| 전송 | 출발지 포트, 목적지 포트, TCP 플래그 | 포트 변환, conntrack 튜플, handshake |
| 응용 | DNS 질의, HTTP 요청 | DNS 경로(3절) |

DNAT는 목적지 IP와 포트를, SNAT(마스커레이드 포함)는 출발지 IP와 포트를 바꿉니다. 응용 계층 데이터는 건드리지 않습니다. 그래서 주문 API 입장에서는 요청이 ClusterIP를 거쳐 왔는지 직접 왔는지 구분할 수 없습니다.

### 1-2. CIDR 계산

CIDR 표기의 `/N`은 앞에서부터 N비트가 네트워크 부분이라는 뜻입니다. 나머지 비트 수가 주소 개수를 정합니다.

| 표기 | 호스트 비트 | 주소 수 | 메모 |
|---|---|---|---|
| `/12` | 20 | 1,048,576 | kubeadm 기본 Service CIDR `10.96.0.0/12`의 크기 |
| `/16` | 16 | 65,536 | 클러스터 전체 파드 CIDR로 흔히 쓰는 크기 |
| `/24` | 8 | 256 | 네트워크 주소와 브로드캐스트를 빼면 호스트 254개 |

노드마다 파드 CIDR을 `/24`로 나눠 주는 구성이 많습니다. 주소는 254개지만 kubelet의 기본 `maxPods`가 110이라 실제로는 그쪽 한도가 먼저 걸립니다.

### 1-3. Node IP, Pod IP, ClusterIP

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

## 2. Service 타입과 포트 사슬

### 2-1. 타입별로 생기는 규칙

| 타입 | kube-proxy가 노드에 만드는 것 | 메모 |
|---|---|---|
| `ClusterIP` | `ClusterIP:port` 매치 → 엔드포인트 DNAT | `type` 생략 시 기본 |
| `NodePort` | 위 규칙 + 모든 노드의 `nodePort` 매치 규칙(`KUBE-NODEPORTS`) | 기본 범위 30000-32767 |
| `LoadBalancer` | 위 규칙 + 외부 LB IP 매치 규칙 | LB 구현이 없으면 EXTERNAL-IP가 `<pending>` |
| `ExternalName` | 규칙 없음 | DNS가 CNAME으로만 답함 |
| headless(`clusterIP: None`) | 규칙 없음 | DNS가 파드 IP를 직접 돌려줌 |

headless와 ExternalName에는 kube-proxy가 관여하지 않습니다. 이 둘은 DNS만으로 동작하므로 이 글의 DNAT 이야기가 적용되지 않습니다.

### 2-2. nodePort → port → targetPort

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

EndpointSlice의 `ports`에 `8080`이 들어 있는지 봅니다. kube-proxy가 DNAT 목적지로 쓰는 값이 바로 이 EndpointSlice의 주소와 포트입니다.

## 3. 패킷이 ClusterIP를 만나는 곳: netfilter와 kube-proxy 규칙

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

`KUBE-SERVICES`는 Service 하나의 포트마다 규칙 한 줄을 갖습니다. 목적지 IP와 포트가 맞으면 그 Service의 `KUBE-SVC-*` 체인으로 점프합니다. 체인 이름의 해시는 Service 이름과 포트 이름으로 만듭니다. 아래는 이런 형태로 나온다는 예시이며 해시 값은 지어낸 것입니다.

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

두 번째 줄이 이 글의 핵심인 DNAT입니다. 목적지 `10.96.120.15:80`이 `10.244.1.5:8080`으로 바뀝니다. 첫 줄은 헤어핀 경우를 처리합니다. 파드가 자기 Service를 불렀는데 자기 자신이 뽑히면 출발지와 목적지가 같아집니다. 응답이 돌아올 길이 꼬이지 않게 출발지도 노드 주소로 바꾸라고 표시해 둡니다.

### 3-5. KUBE-MARK-MASQ와 KUBE-POSTROUTING

마스커레이드는 두 단계로 나뉩니다. `KUBE-MARK-MASQ`는 패킷에 방화벽 마크(기본 `0x4000`)만 붙이고 아무것도 바꾸지 않습니다. 실제 출발지 변환은 패킷이 나가기 직전 nat POSTROUTING에 걸린 `KUBE-POSTROUTING`이 합니다.

```text
# proxier.go가 쓰는 KUBE-POSTROUTING (형태 예시)
-A KUBE-POSTROUTING -m mark ! --mark 0x4000/0x4000 -j RETURN
-A KUBE-POSTROUTING -j MARK --xor-mark 0x4000
-A KUBE-POSTROUTING -m comment --comment "kubernetes service traffic requiring SNAT" -j MASQUERADE --random-fully
```

표시가 없으면 그냥 돌려보냅니다. 있으면 표시를 지운 뒤 MASQUERADE합니다. 표시를 지우는 이유는 소스 주석에 있습니다. 패킷이 네트워크 스택을 다시 지날 때 두 번 마스커레이드되는 일을 막기 위해서입니다. DNAT 판단 시점(PREROUTING)에는 아직 나갈 인터페이스를 모르므로 결정과 실행을 이렇게 나눠 둡니다.

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

## 4. 연결을 기억하는 장치: conntrack

### 4-1. 첫 패킷만 nat 규칙을 탄다

iptables(8) 매뉴얼은 nat 테이블을 "새 연결을 만드는 패킷을 만났을 때 참조하는 테이블"로 설명합니다. 3장의 확률 선택과 DNAT는 연결의 첫 패킷에만 일어납니다. 커널의 conntrack은 그 결과를 항목 하나로 기억합니다. 같은 연결의 다음 패킷은 규칙을 다시 훑지 않고 기억한 대로 변환됩니다. SREcon26 슬라이드는 conntrack의 역할을 "이미 본 패킷을 바탕으로 패킷을 활성 연결에 매칭하고 알려진 연결의 패킷이 iptables를 다시 평가하지 않게 해 CPU를 아낀다"고 요약합니다.

이 성질이 장점이자 5장 사례의 원인입니다. 한 번 정해진 엔드포인트는 그 conntrack 항목이 살아 있는 동안 바뀌지 않습니다. 엔드포인트가 사라져도 항목이 남아 있으면 패킷은 사라진 곳으로 계속 갑니다.

### 4-2. 정방향 튜플과 역방향 튜플

conntrack 항목은 튜플 두 개를 갖습니다. 정방향(original)은 클라이언트가 보낸 그대로의 주소이고 역방향(reply)은 응답이 돌아올 때 보일 주소입니다. DNAT가 있으면 두 튜플의 대칭이 깨집니다.

```text
정방향:  src=10.244.2.9  dst=10.96.0.10   sport=40123 dport=53
역방향:  src=10.244.1.7  dst=10.244.2.9   sport=53    dport=40123
                ^ 실제로 고른 CoreDNS 파드 IP
```

응답 패킷이 역방향 튜플과 맞으면 커널이 출발지를 다시 `10.96.0.10:53`으로 되돌려 클라이언트에 넘깁니다. 클라이언트는 ClusterIP와 대화한 것으로 압니다. 역방향 튜플의 `src`를 보면 어느 엔드포인트가 뽑혔는지 알 수 있습니다.

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

두 번째 줄처럼 `[UNREPLIED]` 항목이 같은 엔드포인트로 몰려 있으면 그 엔드포인트가 응답하지 않는다는 신호입니다. 남은 초가 계속 다시 차오르는 항목이 있다면 4-3에서 말한 갱신이 일어나고 있는 것입니다.

### 4-5. 직접 해 보기

```bash
sysctl net.netfilter.nf_conntrack_udp_timeout net.netfilter.nf_conntrack_udp_timeout_stream
conntrack -L -p udp --dport 53 2>/dev/null | head
watch -n 1 'conntrack -L -p udp --dport 53 2>/dev/null | head -5'   # 남은 초가 줄고 다시 차는지
conntrack -S                                                          # CPU별 통계(insert_failed, drop 등)
```

파드 하나에서 `nslookup order-api.shop`을 몇 번 실행한 뒤 위 명령을 다시 봅니다. 역방향 튜플의 `src`가 CoreDNS 파드 IP 중 하나인지 `kubectl -n kube-system get pod -l k8s-app=kube-dns -o wide`와 비교합니다.

## 5. 파드가 이름을 IP로 바꾸는 길

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

## 6. 파드 사이 통신: 같은 노드와 다른 노드

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

라우팅을 한 번 거칠 때마다 TTL이 1 줄어듭니다. Calico에서는 같은 노드의 파드끼리도 노드 라우팅을 한 번 거치므로 TTL이 1 줄어듭니다. 다른 노드면 목적지 노드에서 한 번 더 줄어 2가 됩니다. 캡슐화 없이 BGP로 라우팅하면 중간 물리 라우터 수만큼 더 줄 수 있습니다. 브리지 방식 CNI에서 같은 노드 통신은 L2 스위칭이라 TTL이 줄지 않습니다.

### 6-3. 직접 해 보기

```bash
kubectl -n shop exec dnsprobe -- ip route          # Calico면 default via 169.254.1.1
kubectl -n shop exec dnsprobe -- ping -c 1 <같은 노드 파드 IP>    # ttl= 값 확인
kubectl -n shop exec dnsprobe -- ping -c 1 <다른 노드 파드 IP>

# 노드에서 TCP handshake 플래그 보기
tcpdump -ni any 'tcp port 8080 and host <파드 IP>' -c 10
```

tcpdump 매뉴얼의 표기로 `[S]`는 SYN, `[S.]`는 SYN+ACK, `[.]`는 ACK, `[P.]`는 PSH+ACK입니다. Service를 거쳐 보낸 요청이라면 노드의 `cali*`나 `veth*` 인터페이스에서 잡은 SYN의 목적지가 이미 파드 IP로 바뀌어 있는지 봅니다. 파드 안에서 잡으면 목적지가 ClusterIP로 보이므로 둘을 비교하면 DNAT 지점을 눈으로 확인할 수 있습니다.

## 7. 사례: 낡은 UDP conntrack 항목이 DNS를 막은 날

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

4번이 이 사례의 핵심입니다. conntrack 타임아웃은 "마지막 패킷 이후 경과 시간"으로 재므로, 보내는 쪽이 멈추지 않는 한 낡은 항목은 스스로 사라지지 않습니다. 매번 새 출발지 포트를 쓰는 클라이언트였다면 질의마다 새 항목이 생기고 nat 규칙을 다시 타서 살아 있는 엔드포인트로 갔을 것입니다.

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

패킷이 계속 오는 한 사라지지 않습니다. 타임아웃은 마지막 패킷을 본 시점부터 다시 계산됩니다. 보내는 쪽이 멈추거나 출발지 포트를 바꾸거나, kube-proxy reconciler나 `conntrack -D`가 지워야 사라집니다.

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

- 이 글을 쓴 환경(macOS)에는 쿠버네티스 클러스터도 리눅스 노드도 없어 명령을 하나도 실행하지 않았습니다. iptables 규칙, `conntrack -L`, resolv.conf 출력은 kube-proxy 소스와 공식 문서를 바탕으로 만든 형태 예시이며 해시와 IP는 지어낸 값입니다. 각 장의 "직접 해 보기"는 kind나 리눅스 VM에서 할 과제로 남깁니다.
- kube-proxy 모드 상태는 2026년 10월(v1.37) 기준입니다. 리눅스 기본값이 nftables로 바뀌는 시점은 문서가 예고만 하고 버전을 정하지 않았습니다. IPVS의 v1.40 기본 비활성과 v1.43 제거는 KEP-5495의 계획입니다.
- `KUBE-SVC` 첫 줄의 `! -s <파드 CIDR> ... -j KUBE-MARK-MASQ` 형태는 kube-proxy에 클러스터 CIDR 정보가 있을 때 기준이며 `masqueradeAll`이나 로컬 트래픽 판별 방식에 따라 달라집니다. 버전별 차이는 확인하지 않았습니다.
- 사례는 SREcon26 Americas 슬라이드의 텍스트만 근거로 썼습니다. 슬라이드의 그림(타임라인, 경로 도식)은 텍스트로 추출되지 않아 확인하지 못했습니다. 그래서 OOMKilled 뒤 CoreDNS 파드가 같은 IP로 다시 떴는지, 장애가 얼마나 이어졌는지, 어떻게 복구했는지는 쓰지 않았습니다. 7-3의 단계 설명은 슬라이드의 세 원인을 4장의 conntrack 동작에 맞춰 제가 이은 것입니다.
- #127318 이후 후속 수정은 #130484 하나만 직접 확인했습니다. 성능 회귀 보고와 다른 후속 PR, 이전 버전 체리픽(#127780)의 세부와 각 패치 버전 번호는 확인하지 않았습니다.
- UDP 흐름이 `_stream` 타임아웃으로 넘어가는 정확한 조건은 커널 버전마다 다르며 이 글에서는 커널 문서의 설명("UDP stream이 감지되면")까지만 적었습니다.
- Calico의 TTL 동작과 169.254.1.1 게이트웨이는 Calico FAQ 기준입니다. 다른 CNI(Flannel, Cilium 등)에서는 경로와 TTL 변화가 다릅니다.
- 7-6의 재현 실험은 설계만 했습니다. `nicolaka/netshoot` 이미지와 `dig -b`의 고정 포트 옵션으로 의도한 대로 같은 5-튜플이 유지되는지도 확인하지 못했습니다.

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

사례와 CNI
- Ricard Bejarano, [The Inconspicuous Role of Conntrack in Kubernetes Networking](https://www.usenix.org/conference/srecon26americas/presentation/bejarano), SREcon26 Americas ([슬라이드 PDF](https://www.usenix.org/system/files/sre26amer_slides_bejarano.pdf))
- [Istio: DNS Proxying](https://istio.io/latest/docs/ops/configuration/traffic-management/dns/)
- [Calico FAQ](https://docs.tigera.io/calico/latest/reference/faq)

이 블로그의 관련 글
- [CKA Ch-04: 서비스와 네트워킹](/blog/cert/cka/cka-04-services-networking)
- [쿠버네티스 아래의 리눅스 2: 네임스페이스와 pause](/blog/theory/systems/k8s-linux-02-namespaces-pause)
- [쿠버네티스 아래의 리눅스 3: cgroup과 QoS](/blog/theory/systems/k8s-linux-03-cgroup-qos)

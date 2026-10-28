---
title: '[CKA] 위에서 내려다보는 CKA 지도: kubectl apply 한 번을 따라 아홉 층 내려가기'
description: CKA 공부를 구성요소 목록부터 외우면 어디에 쓰이는지 감이 늦게 옵니다. 쇼핑몰 웹 Deployment와 Service를 kubectl apply로 한 번 올리는 장면을 위에서부터 따라가며 API 서버, etcd, 컨트롤러, 스케줄러, kubelet, CRI·CNI·CSI, Service, Gateway까지 아홉 층을 지나고 층마다 고장 나면 보이는 증상과 이 시리즈에서 자세히 다루는 절을 이어 둡니다.
date: 2026-10-23T00:00:00.000Z
tags:
  - CKA
  - Kubernetes
  - Certification
  - Study Plan
  - Architecture
category: cert/CKA
topics:
  - cert
draft: false
series: "CKA 공부"
seriesOrder: 2
---

## 결론부터

1. CKA 범위는 넓어 보여도 대부분 `kubectl apply` 한 번이 지나가는 길 위에 있습니다. kubectl에서 출발해 API 서버, etcd, 컨트롤러, 스케줄러, kubelet, 런타임과 플러그인, Service, Gateway까지 아홉 층을 내려가면 시험 다섯 영역이 전부 한 번씩 등장합니다.
2. 층마다 고장 나는 모양이 다릅니다. API 서버 앞에서 막히면 `kubectl`이 바로 오류를 돌려주고 그 아래에서 막히면 명령은 성공했는데 Pod가 `Pending`이나 `ContainerCreating`에 남습니다. 증상을 보고 몇 번째 층인지 짚는 것이 트러블슈팅(30%)의 출발점입니다.
3. 이 글은 지도입니다. 층마다 무슨 일이 일어나는지 몇 줄로 적고 자세한 내용은 3편부터 9편의 해당 절로 넘깁니다. 처음 읽을 때는 3장과 4장의 그림 두 장과 5장의 증상 표만 기억해도 됩니다.

---

## 1. 왜 지도부터 보는가

쿠버네티스를 처음 공부할 때 흔히 구성요소 목록부터 봅니다. etcd는 저장소, 스케줄러는 노드 배정, kubelet은 노드 에이전트. 하나하나는 어렵지 않은데 이 목록만으로는 시험 과제와 연결이 잘 안 됩니다. "Deployment는 있는데 Pod가 0개입니다. 고치세요" 같은 과제를 받았을 때 목록 어디를 봐야 하는지가 안 떠오르기 때문입니다.

그래서 이 글은 순서를 거꾸로 잡습니다. 실제로 하는 일 하나를 먼저 정하고 그 일이 클러스터 안에서 어떤 길로 내려가는지 위에서부터 따라갑니다. 구성요소는 그 길 위에서 만날 때 소개합니다. 어떤 구성요소가 멈추면 길의 어디가 끊기는지가 같이 보여서 트러블슈팅을 공부할 때도 같은 지도를 그대로 씁니다. 같은 방식으로 `kubectl run` 한 번을 소스 코드 수준까지 따라간 글로 Jamie Hannaford의 [What happens when I type kubectl run](https://github.com/jamiehannaford/what-happens-when-k8s)이 있습니다. 링크된 소스가 대부분 v1.14 무렵이라 세부는 지금과 다르지만 층을 나누는 순서는 이 글과 같습니다.

따라갈 장면은 쇼핑몰 웹 서버를 올리는 일입니다.

```yaml
# shop-web.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: shop
spec:
  replicas: 3
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
          ports:
            - containerPort: 80
---
apiVersion: v1
kind: Service
metadata:
  name: web
  namespace: shop
spec:
  selector:
    app: web
  ports:
    - port: 80
      targetPort: 80
```

```bash
kubectl apply -f shop-web.yaml
# deployment.apps/web created
# service/web created
```

두 줄이 출력되기까지 1초도 안 걸립니다. 그런데 이 출력이 나온 시점에 컨테이너는 아직 하나도 떠 있지 않습니다. 그 사이에 일어나는 일을 이 글에서 따라갑니다.

## 2. 등장하는 구성요소

먼저 공식 문서의 구성요소 그림으로 등장인물을 한 번 훑습니다. 위쪽 상자가 컨트롤 플레인이고 아래쪽이 워커 노드입니다.

![쿠버네티스 클러스터 구성요소. 컨트롤 플레인에 kube-apiserver, etcd, kube-scheduler, kube-controller-manager, cloud-controller-manager가 있고 각 노드에 kubelet과 kube-proxy가 있다](/uploads/cert/cka-map/components-of-kubernetes.svg)

*그림 출처: [Kubernetes Components](https://kubernetes.io/docs/concepts/overview/components/), The Kubernetes Authors, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). 다크 모드에서 보이도록 흰 배경만 넣었습니다.*

그림을 보면 모든 화살표가 kube-apiserver로 모입니다. 스케줄러도 컨트롤러도 kubelet도 서로 직접 말하지 않고 API 서버에 쓰고 API 서버를 지켜봅니다(watch). 이 구조 덕분에 아래 3장의 흐름이 "누가 무엇을 써 두면 다음 사람이 그걸 보고 움직인다"는 릴레이로 읽힙니다.

<details>
<summary>기초부터: 3장에 나오는 단어를 한 줄씩</summary>

> **핵심 한 줄**: 3장은 처음 보는 단어가 층마다 하나씩 나옵니다. 아래 표를 옆에 두고 읽으면 막히지 않고 끝까지 내려갈 수 있습니다.

#### 1. 릴레이를 식당 주문으로 보기

손님(사용자)이 주문서를 써서 카운터(API 서버)에 내면 카운터는 주문서를 주문 꽂이(etcd)에 꽂습니다. 주방장(컨트롤러)은 꽂이를 지켜보다가 "파스타 3인분"을 보고 접시 세 개 분량의 작업표를 다시 꽂고 배치 담당(스케줄러)은 작업표마다 화구 번호를 적습니다. 화구 앞 요리사(kubelet)는 자기 화구 번호가 적힌 작업표만 집어 요리합니다. 누구도 서로에게 말을 걸지 않고 꽂이만 봅니다. 이 "지켜보다가 바뀌면 받아 보기"가 watch입니다.

비유는 흐름까지만 맞습니다. 실제 etcd는 키-값 저장소이고 API 서버만 etcd에 직접 읽고 씁니다.

#### 2. 단어 표

| 단어 | 한 줄 뜻 |
|---|---|
| kubeconfig, 컨텍스트 | kubectl이 읽는 접속 설정 파일. "어느 클러스터에 누구로"를 묶은 이름이 컨텍스트 |
| watch | 객체 목록을 한 번 받고 이후 바뀐 것만 계속 이어 받는 API 요청 |
| 어드미션 | 인증·인가를 통과한 요청을 저장 직전에 고치거나 거절하는 단계 |
| ClusterIP | Service에 붙는 클러스터 안 전용 가상 IP |
| ReplicaSet | "이 라벨의 Pod를 N개 유지"만 맡는 객체. Deployment가 버전마다 하나씩 만듦 |
| `spec.nodeName` | Pod가 돌 노드 이름. 비어 있으면 아직 배정 전 |
| 테인트, 톨러레이션 | 노드에 붙이는 "아무나 오지 마" 표시와 Pod가 지닌 "이 표시는 견딘다" 허가 |
| 샌드박스(pause) | Pod마다 먼저 뜨는 작은 컨테이너. 네트워크 네임스페이스를 잡아 둠 |
| 라벨, selector | 객체에 붙인 이름표와 그 이름표로 객체를 고르는 조건 |
| EndpointSlice | Service 뒤의 실제 Pod IP와 포트 목록 |
| readiness probe | 컨테이너가 요청을 받을 준비가 됐는지 kubelet이 주기적으로 묻는 검사 |
| DNAT | 패킷의 목적지 주소를 바꿔 쓰는 커널 규칙. ClusterIP를 Pod IP로 바꿈 |

> **정리**: 기록은 API 서버에만 남고 각 구성요소는 watch로 자기 몫의 변화를 받아 움직입니다. 표의 단어는 각 층에서 다시 한 번 짧게 설명합니다.

</details>

## 3. kubectl apply 한 번을 위에서부터 따라가기

![kubectl apply -f shop-web.yaml 한 번이 kubectl, kube-apiserver, etcd, 컨트롤러, kube-scheduler, kubelet, CRI·CNI·CSI, Service와 kube-proxy, Gateway와 Ingress의 아홉 층을 차례로 내려가는 그림.](/uploads/cert/cka-map/apply-top-down.svg)

각 층은 같은 틀로 적었습니다. 무슨 일이 일어나는지 먼저 쓰고 고장 나면 무엇이 보이는지와 어디서 더 보는지를 붙였습니다.

### 3-1. kubectl: 파일을 HTTP 요청으로 바꾼다

kubectl은 kubeconfig에서 API 서버 주소와 자격 증명을 읽고 YAML을 JSON으로 바꿔 HTTPS 요청을 보냅니다. 클러스터에 없는 객체면 생성 요청(POST)이 나가고 이미 있으면 바뀐 부분만 보내는 요청(PATCH)이 나갑니다.

- 고장 나면: `The connection to the server ... was refused`처럼 아예 연결이 안 되거나 엉뚱한 클러스터에 적용됩니다. 시험에서는 과제마다 컨텍스트와 호스트가 달라서 두 번째 경우가 실제로 점수를 깎습니다.
- 더 볼 곳: kubeconfig 구조는 [5편 1-10절](/blog/cert/cka/cka-02-cluster-architecture#1-10-kubeconfig-파일-구조), 과제마다 호스트를 옮기는 규칙은 [1편 3-2절](/blog/cert/cka/cka-00-exam-and-study-plan#3-2-과제마다-다른-호스트)

### 3-2. kube-apiserver: 세 관문을 통과해야 저장된다

요청은 인증(누구인가), 인가(이 동작을 해도 되는가), 어드미션(내용을 고치거나 거절할 것인가)을 차례로 지납니다. 인가는 kubeadm 기본값으로 `Node,RBAC` 모드입니다. 어드미션 단계에서 ServiceAccount나 기본 톨러레이션 같은 값이 채워지고 ResourceQuota나 PodSecurity 위반이면 거절됩니다.

- 고장 나면: 인증 실패는 `401`, 인가 실패는 `403 Forbidden`과 `cannot create resource ...`, 쿼터 위반은 `exceeded quota`가 kubectl 화면에 바로 찍힙니다. 내가 kubectl로 보낸 객체에 대해서는 이 층의 문제가 숨지 않습니다. Deployment가 대신 만드는 Pod가 쿼터에 걸리면 kubectl에는 보이지 않고 3-4절처럼 ReplicaSet 이벤트에 남습니다.
- 더 볼 곳: 관문 다섯 단계의 실패 메시지 표는 [4편 1-2절](/blog/cert/cka/cka-01b-core-objects-and-flow#1-2-api-서버-안의-다섯-관문), RBAC 객체 네 개는 [5편 1장](/blog/cert/cka/cka-02-cluster-architecture)

### 3-3. etcd: 여기까지 오면 kubectl은 끝난다

관문을 통과한 Deployment와 Service는 etcd에 저장되고 kubectl에 `created` 응답이 돌아갑니다. Service는 이때 ClusterIP를 배정받습니다. 이 시점에 Pod는 아직 한 개도 없습니다. kubectl의 성공 메시지는 "원하는 상태를 적어 두었다"는 뜻뿐입니다.

- 고장 나면: etcd가 멈추면 API 서버가 제대로 뜨지 못하고 재시작을 반복합니다. 사용자 눈에는 `kubectl` 전체가 안 되는 것으로 보여서 API 서버 문제와 구분하려면 컨트롤 플레인 노드에서 `crictl logs`를 봐야 합니다.
- 더 볼 곳: etcd의 역할은 [4편 2-3절](/blog/cert/cka/cka-01b-core-objects-and-flow#2-3-etcd), 백업과 복구는 [5편 4-5절](/blog/cert/cka/cka-02-cluster-architecture#4-5-etcd-백업)

### 3-4. 컨트롤러: Deployment가 Pod 세 개가 된다

kube-controller-manager 안의 deployment 컨트롤러가 새 Deployment를 보고 ReplicaSet을 만듭니다. replicaset 컨트롤러는 그 ReplicaSet을 보고 Pod 객체 세 개를 만듭니다. 만들어진 Pod는 `spec.nodeName`이 비어 있습니다. 어느 노드에서 돌지 아직 아무도 정하지 않았습니다.

- 고장 나면: Deployment는 있는데 ReplicaSet이나 Pod가 생기지 않습니다. 스케일을 바꿔도 반응이 없습니다. 쿼터에 걸린 경우에는 `kubectl describe rs`에 `FailedCreate`가 남습니다.
- 더 볼 곳: 컨트롤 루프는 [3편 1장](/blog/cert/cka/cka-01-why-kubernetes), Deployment에서 Pod까지의 경로는 [4편 1-6절](/blog/cert/cka/cka-01b-core-objects-and-flow#1-6-deployment가-pod-세-개가-되는-경로), 롤링 업데이트는 [6편 1장](/blog/cert/cka/cka-03-workloads-scheduling)

### 3-5. kube-scheduler: 노드를 고른다

스케줄러는 `nodeName`이 빈 Pod를 큐에 넣고 Filter 단계에서 못 쓰는 노드를 거른 뒤 Score 단계에서 남은 노드에 점수를 매겨 하나를 고릅니다. 결정은 binding 요청으로 API 서버에 기록됩니다. requests, nodeSelector, 필수(required) 어피니티, `NoSchedule` 테인트와 톨러레이션은 Filter에서 쓰이고 선호(preferred) 어피니티와 `PreferNoSchedule` 테인트는 Score에서 점수로 반영됩니다.

- 고장 나면: Pod가 `Pending`에 남고 NODE 칸이 `<none>`입니다. 스케줄러가 살아 있는데 맞는 노드가 없으면 `FailedScheduling` 이벤트에 이유가 적힙니다. 스케줄러 자체가 멈췄으면 이벤트가 아예 없습니다.
- 더 볼 곳: 스케줄러 동작은 [4편 1-3절](/blog/cert/cka/cka-01b-core-objects-and-flow#1-3-스케줄러가-노드를-고르는-방식), 배치를 바꾸는 값들은 [6편 5장](/blog/cert/cka/cka-03-workloads-scheduling)

### 3-6. kubelet: 자기 노드에 온 Pod를 실행한다

각 노드의 kubelet은 `nodeName`이 자기인 Pod만 걸러 지켜봅니다. 새 Pod가 오면 아래 층의 런타임과 플러그인을 불러 실제로 실행하고 결과를 Pod의 `status`에 보고합니다. kubelet은 노드에서 systemd 서비스로 도는 프로세스라서 고칠 때도 `systemctl`과 `journalctl`을 씁니다.

- 고장 나면: 노드가 `NotReady`가 되고 그 노드에는 새 Pod가 뜨지 않습니다. 기본 설정이면 약 50초 뒤 `unreachable` 테인트가 붙고 다시 300초 뒤 그 노드의 Pod가 축출됩니다.
- 더 볼 곳: 노드에서 Pod가 프로세스가 되는 과정은 [3편 2-3절](/blog/cert/cka/cka-01-why-kubernetes#2-3-노드에서-pod가-프로세스가-되기까지), 노드 장애 대응은 [9편 1장](/blog/cert/cka/cka-06-troubleshooting)

### 3-7. CRI, CNI, CSI: 컨테이너, 네트워크, 디스크를 붙인다

kubelet은 직접 컨테이너를 만들지 않습니다. 세 인터페이스로 일을 나눠 맡깁니다. CRI와 CSI는 kubelet이 직접 부르고 CNI는 CRI 런타임(containerd 등)이 샌드박스를 만들 때 부릅니다.

| 인터페이스 | 맡는 일 | 대표 구현 |
|---|---|---|
| CRI | 이미지를 받고 샌드박스(pause)와 컨테이너를 만든다 | containerd, CRI-O |
| CNI | Pod에 네트워크 인터페이스와 IP를 붙인다 | Calico, Cilium, Flannel |
| CSI | 볼륨을 만들고 노드에 붙여 마운트한다 | 클라우드 디스크 드라이버, 로컬 경로 드라이버 |

- 고장 나면: 이미지를 못 받으면 `ImagePullBackOff`, 볼륨이나 네트워크를 못 붙이면 `ContainerCreating`에 오래 머뭅니다. CNI가 아예 없으면 노드 Ready 조건에 `cni plugin not initialized`가 보이고 노드가 `NotReady`입니다. PVC가 묶일 PV를 못 찾으면 Pod는 그보다 앞인 스케줄 단계에서 `Pending`입니다.
- 더 볼 곳: 세 인터페이스는 [5편 7장](/blog/cert/cka/cka-02-cluster-architecture#7-확장-인터페이스-cni-csi-cri), Pod 간 연결은 [7편 1장](/blog/cert/cka/cka-04-services-networking), PVC가 `Pending`인 이유는 [8편](/blog/cert/cka/cka-05-storage)

### 3-8. Service와 kube-proxy: 바뀌는 Pod IP 앞에 고정 주소를 둔다

Pod가 IP를 받으면 EndpointSlice 컨트롤러가 Service `web`의 selector에 맞는 Pod IP를 Ready 여부(`conditions.ready`)와 함께 EndpointSlice에 적습니다. 각 노드의 kube-proxy는 Service와 EndpointSlice를 지켜보다가 ClusterIP로 온 패킷을 Pod IP 중 하나로 바꾸는 규칙을 커널에 씁니다. 기본 모드는 `iptables`입니다. 이름 `web.shop.svc.cluster.local`은 CoreDNS가 ClusterIP로 풀어 줍니다.

- 고장 나면: Service는 있는데 응답이 없습니다. 가장 흔한 원인은 selector와 Pod 라벨이 어긋나 EndpointSlice가 비어 있는 경우입니다. readiness probe가 실패한 Pod는 EndpointSlice에 `ready: false`로 남고 kube-proxy가 트래픽 대상에서 뺍니다. 이름만 안 풀리고 IP로는 닿으면 CoreDNS 쪽입니다.
- 더 볼 곳: Service 타입과 포트 셋은 [7편 3장](/blog/cert/cka/cka-04-services-networking), 확인 순서는 [9편 5장](/blog/cert/cka/cka-06-troubleshooting), CoreDNS는 [7편 6장](/blog/cert/cka/cka-04-services-networking)

### 3-9. Gateway와 Ingress: 클러스터 바깥에서 들어오는 문

여기까지 오면 클러스터 안에서는 `web`에 닿습니다. 바깥 사용자가 `shop.example.com`으로 들어오게 하려면 HTTP 요청을 Service로 이어 줄 규칙이 하나 더 필요합니다. Gateway API에서는 Gateway가 문을 열고 HTTPRoute가 경로를 Service로 잇습니다. Ingress는 같은 일을 하는 예전 방식이고 시험 범위에는 둘 다 있습니다.

- 고장 나면: HTTPRoute를 만들었는데 트래픽이 안 옵니다. `kubectl describe httproute`의 `Accepted`와 `ResolvedRefs` 조건이 `False`면 사유에 Gateway 이름이나 네임스페이스 허용 문제가 적힙니다. Ingress는 리소스만 있고 컨트롤러가 없으면 아무 일도 일어나지 않습니다.
- 더 볼 곳: [7편 4장 Gateway API](/blog/cert/cka/cka-04-services-networking#4-gateway-api로-ingress-트래픽-관리), [7편 5장 Ingress](/blog/cert/cka/cka-04-services-networking#5-ingress-컨트롤러와-ingress-리소스)

## 4. 반대 방향: 요청 하나가 컨테이너에 닿기까지

3장은 객체가 만들어지는 길이었습니다. 다 만들어진 뒤 사용자 요청이 지나가는 길은 방향이 다르고 거치는 곳도 조금 다릅니다.

![사용자 요청이 Gateway와 HTTPRoute, Service ClusterIP, kube-proxy가 쓴 iptables DNAT 규칙, CNI가 배정한 Pod IP를 거쳐 nginx 컨테이너 프로세스에 닿는 그림. 이름 해석은 CoreDNS, 차단 규칙은 NetworkPolicy가 맡는다](/uploads/cert/cka-map/request-path.svg)

요청이 지나가는 길에는 API 서버도 스케줄러도 컨트롤러도 없습니다. 컨트롤 플레인이 잠깐 멈춰도 이미 깔린 커널 규칙과 떠 있는 컨테이너로 요청은 계속 처리됩니다. 반대로 새 Pod가 뜨거나 Pod IP가 바뀐 것은 반영되지 않습니다. [3편 3장](/blog/cert/cka/cka-01-why-kubernetes#3-구성요소가-멈추면-무엇이-멈추는지)에서 controller-manager를 멈춰 놓고 확인한 것도 이 동작입니다.

## 5. 층별 고장 증상 지도

3장의 "고장 나면"만 모은 표입니다. 시험에서 증상을 받으면 왼쪽 열에서 찾고 오른쪽 절로 갑니다.

| 보이는 증상 | 멈춘 층 | 먼저 칠 명령 | 자세히 |
|---|---|---|---|
| `kubectl` 전체가 연결 거부 | API 서버, etcd | 컨트롤 플레인 노드에서 `sudo crictl ps -a` | [9편 2장](/blog/cert/cka/cka-06-troubleshooting) |
| `403 Forbidden`, `cannot ... resource` | API 서버 인가 | `kubectl auth can-i ... --as <사용자>` | [5편 1장](/blog/cert/cka/cka-02-cluster-architecture) |
| Deployment는 있는데 Pod 0개 | 컨트롤러 | `kubectl -n kube-system get pods`, `describe rs` | [9편 2장](/blog/cert/cka/cka-06-troubleshooting) |
| `Pending`, NODE `<none>` | 스케줄러 또는 배치 조건 | `kubectl describe pod`의 Events | [9편 0-3절](/blog/cert/cka/cka-06-troubleshooting#0-3-pending) |
| 노드 `NotReady` | kubelet, 런타임, CNI | 그 노드에서 `systemctl status kubelet`, `journalctl -u kubelet` | [9편 1장](/blog/cert/cka/cka-06-troubleshooting) |
| `ImagePullBackOff` | CRI | Events의 pull 오류 | [9편 0-4절](/blog/cert/cka/cka-06-troubleshooting#0-4-imagepullbackoff) |
| `ContainerCreating`에 오래 머묾 | CNI, CSI, 설정 객체 | `kubectl describe pod`의 Events | [9편 0-2절](/blog/cert/cka/cka-06-troubleshooting#0-2-증상별-판단-표) |
| `CrashLoopBackOff`, `OOMKilled` | 컨테이너 안의 앱, 메모리 한도 | `kubectl logs --previous`, Last State | [9편 4장](/blog/cert/cka/cka-06-troubleshooting), [3편 4장](/blog/cert/cka/cka-01-why-kubernetes) |
| Service 응답 없음 | Service, EndpointSlice, kube-proxy | `kubectl get endpointslices -l kubernetes.io/service-name=<svc>` | [9편 5장](/blog/cert/cka/cka-06-troubleshooting) |
| 이름만 안 풀림 | CoreDNS, NetworkPolicy | `nslookup kubernetes.default` | [7편 6-6절](/blog/cert/cka/cka-04-services-networking#6-6-dns-문제를-좁히는-순서) |
| 바깥에서만 안 들어옴 | Gateway, Ingress | `kubectl describe httproute` | [7편 4장](/blog/cert/cka/cka-04-services-networking) |

같은 내용을 증상 쪽에서 더 자세히 정리한 표가 [9편 0-2절](/blog/cert/cka/cka-06-troubleshooting#0-2-증상별-판단-표)에 있고 구성요소 쪽에서 정리한 표가 [3편 3-3절](/blog/cert/cka/cka-01-why-kubernetes#3-3-구성요소별로-멈출-때의-증상과-처음-볼-곳)에 있습니다.

## 6. 시험 다섯 영역은 지도의 어디에 있나

![CKA 커리큘럼 v1.37의 다섯 영역 비중. Troubleshooting 30%, Cluster Architecture 25%, Services & Networking 20%, Workloads & Scheduling 15%, Storage 10%](/uploads/cert/cka-map/exam-weights.svg)

| 영역 | 비중 | 지도에서의 위치 | 이 시리즈 |
|---|---|---|---|
| Troubleshooting | 30% | 아홉 층 전부. 어느 층이 끊겼는지 찾는 일 | [9편](/blog/cert/cka/cka-06-troubleshooting) |
| Cluster Architecture, Installation and Configuration | 25% | ①②③과 노드 준비. 인증과 RBAC, kubeadm, etcd, Helm과 Kustomize, CRI·CNI·CSI | [5편](/blog/cert/cka/cka-02-cluster-architecture) |
| Services and Networking | 20% | ⑦의 CNI와 ⑧⑨ | [7편](/blog/cert/cka/cka-04-services-networking) |
| Workloads and Scheduling | 15% | ④⑤. 컨트롤러가 만드는 것과 스케줄러가 고르는 기준 | [6편](/blog/cert/cka/cka-03-workloads-scheduling) |
| Storage | 10% | ⑦의 CSI와 PV, PVC | [8편](/blog/cert/cka/cka-05-storage) |

비중은 [cncf/curriculum의 v1.37 커리큘럼](https://github.com/cncf/curriculum)을 따랐고 세부 항목은 [1편 2-1절](/blog/cert/cka/cka-00-exam-and-study-plan#2-1-영역별-비중과-세부-항목)에 옮겨 두었습니다. 트러블슈팅이 가장 크지만 따로 외울 것은 적습니다. 나머지 네 영역에서 각 층이 정상일 때 어떤 모습인지 알아야 고장 난 모습이 눈에 들어옵니다.

## 7. 읽는 순서

이 시리즈는 번호 순서로 읽어도 되지만 지도를 기준으로 하면 아래 순서를 권합니다. 위층에서 아래층으로 내려간 뒤 마지막에 전체를 고장 내 보는 순서입니다.

1. [1편](/blog/cert/cka/cka-00-exam-and-study-plan): 시험 구조와 환경. 어떤 화면에서 무엇을 하는지 먼저 압니다.
2. [4편 1장](/blog/cert/cka/cka-01b-core-objects-and-flow): 이 글 3장을 명령 출력과 함께 한 번 더 따라갑니다.
3. [3편](/blog/cert/cka/cka-01-why-kubernetes): 컨트롤 루프와 구성요소를 직접 멈춰 보는 실험.
4. [4편 2장 이후](/blog/cert/cka/cka-01b-core-objects-and-flow): Pod, ReplicaSet, Deployment, Service, Namespace 기본 객체.
5. [6편](/blog/cert/cka/cka-03-workloads-scheduling): 컨트롤러와 스케줄러 층을 자세히.
6. [7편](/blog/cert/cka/cka-04-services-networking)과 [8편](/blog/cert/cka/cka-05-storage): 맨 아래 플러그인 층과 트래픽 길.
7. [5편](/blog/cert/cka/cka-02-cluster-architecture): 클러스터를 직접 만들고 올리고 되살리기. 앞의 층을 다 본 뒤라 kubeadm이 무엇을 설치하는지 보입니다.
8. [9편](/blog/cert/cka/cka-06-troubleshooting): 아홉 층을 하나씩 고장 내고 고치기.
9. [10편](/blog/cert/cka/cka-07-resources-and-exam-day)과 [11편](/blog/cert/cka/cka-08-cram-sheet): 연습 환경, 당일 전략, 직전 요약.

5편을 뒤로 미룬 이유는 설치 과정이 앞의 층을 전부 한 번에 깔기 때문입니다. 처음부터 kubeadm을 따라 하면 명령은 끝나는데 무엇이 깔렸는지는 남지 않기 쉽습니다. 시험 비중으로는 두 번째로 크니 미룬 만큼 손으로 여러 번 해 봅니다.

### 7-1. 한 층 더 내려가고 싶을 때: 쿠버네티스 아래의 리눅스

시험 범위는 아니지만 ⑥⑦⑧ 층 아래에서 실제로 일하는 쪽은 리눅스 커널입니다. 증상의 이유가 궁금해지면 이어서 봅니다.

- [1편 커널 경계](/blog/theory/systems/k8s-linux-01-kernel-boundary): kubelet도 kube-proxy도 결국 시스템 콜을 부르는 프로세스라는 이야기로, ⑥층 아래를 다룹니다.
- [2편 네임스페이스와 pause](/blog/theory/systems/k8s-linux-02-namespaces-pause): 한 Pod 안의 컨테이너가 네트워크를 나눠 쓰는 방식. ⑦의 CRI가 만드는 샌드박스의 정체입니다.
- [3편 cgroup v2와 QoS](/blog/theory/systems/k8s-linux-03-cgroup-qos): requests와 limits가 커널 파일이 되고 OOMKilled가 나기까지. ⑤와 ⑥이 정한 값이 집행되는 곳입니다.
- [4편 OverlayFS](/blog/theory/systems/k8s-linux-04-overlayfs): 이미지 레이어가 컨테이너의 루트 파일시스템이 되는 방식. ⑦의 CRI가 이미지를 받은 다음 일입니다.
- [5편 Service와 iptables](/blog/theory/systems/k8s-linux-05-service-iptables-conntrack): ClusterIP가 DNAT 규칙과 conntrack으로 바뀌는 과정으로, ⑧층을 커널 쪽에서 봅니다.

## 8. 범위와 한계

- 이 글은 각 편의 내용을 한 장으로 묶은 안내입니다. 새로 실험한 결과는 없고 층마다 적은 증상은 각 편에서 확인한 내용과 공식 문서를 따랐습니다.
- `kubectl apply`의 흐름은 처음 만드는 경우를 기준으로 적었습니다. 이미 있는 객체를 고치는 경우의 병합 방식(3-way merge, server-side apply)은 [4편 7-2절](/blog/cert/cka/cka-01b-core-objects-and-flow#7-2-apply의-3-way-merge와-server-side-apply)에 있습니다.
- 그림의 kube-proxy는 기본값인 `iptables` 모드로 그렸습니다. `nftables` 모드에서는 규칙을 쓰는 커널 기능만 다르고 흐름은 같습니다.
- 클라우드 컨트롤러 매니저와 LoadBalancer 타입 Service가 클라우드 장비를 만드는 과정은 시험 환경에서 쓰기 어려워 지도에서 뺐습니다.

## 참고 자료

- [Kubernetes Components](https://kubernetes.io/docs/concepts/overview/components/), 구성요소 그림 출처(CC BY 4.0)
- Jamie Hannaford, [What happens when I type kubectl run](https://github.com/jamiehannaford/what-happens-when-k8s), 위에서부터 따라가는 구성 참고(소스 링크는 v1.14 무렵)
- [Efficient detection of changes (watch)](https://kubernetes.io/docs/reference/using-api/api-concepts/#efficient-detection-of-changes)
- [Controlling Access to the Kubernetes API](https://kubernetes.io/docs/concepts/security/controlling-access/)
- [Admission Control in Kubernetes](https://kubernetes.io/docs/reference/access-authn-authz/admission-controllers/)
- [Kubernetes Scheduler](https://kubernetes.io/docs/concepts/scheduling-eviction/kube-scheduler/)
- [Container Runtime Interface (CRI)](https://kubernetes.io/docs/concepts/architecture/cri/)
- [Virtual IPs and Service Proxies](https://kubernetes.io/docs/reference/networking/virtual-ips/)
- [Gateway API](https://kubernetes.io/docs/concepts/services-networking/gateway/)
- [Troubleshooting Clusters](https://kubernetes.io/docs/tasks/debug/debug-cluster/)
- [cncf/curriculum](https://github.com/cncf/curriculum)

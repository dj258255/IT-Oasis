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
unlisted: true
series: "CKA 공부"
seriesOrder: 2
---

## 결론부터

1. CKA 범위는 넓어 보여도 대부분 `kubectl apply` 한 번이 지나가는 길 위에 있습니다. kubectl에서 출발해 API 서버, etcd, 컨트롤러, 스케줄러, kubelet, 런타임과 플러그인, Service, Gateway까지 아홉 층을 내려가면 시험 다섯 영역이 전부 한 번씩 등장합니다.
2. 층마다 고장 나는 모양이 다릅니다. API 서버 앞에서 막히면 `kubectl`이 바로 오류를 돌려주고 그 아래에서 막히면 명령은 성공했는데 Pod가 `Pending`이나 `ContainerCreating`에 남습니다. 증상을 보고 몇 번째 층인지 짚는 것이 트러블슈팅(30%)의 출발점입니다.
3. 이 글은 지도입니다. 층마다 무슨 일이 일어나는지와 고장 나면 무엇이 보이는지를 적었고 더 깊은 내용은 3편부터 9편에서 다룹니다. 처음 읽을 때는 3장과 4장의 그림 두 장과 5장의 증상 표만 기억해도 됩니다.

---

## 1. 왜 지도부터 보는가

쿠버네티스를 처음 공부할 때 흔히 구성요소 목록부터 봅니다. etcd는 저장소, 스케줄러는 노드 배정, kubelet은 노드 에이전트. 하나하나는 어렵지 않습니다.

문제는 이 목록만으로는 시험 과제와 연결이 잘 안 된다는 점입니다. "Deployment는 있는데 Pod가 0개입니다. 고치세요" 같은 과제를 받았을 때 목록 어디를 봐야 하는지가 안 떠오르기 때문입니다.

그래서 이 글은 순서를 거꾸로 잡습니다. 실제로 하는 일 하나를 먼저 정하고 그 일이 클러스터 안에서 어떤 길로 내려가는지 위에서부터 따라갑니다. 구성요소는 그 길 위에서 만날 때 소개합니다.

이렇게 보면 어떤 구성요소가 멈출 때 길의 어디가 끊기는지가 같이 보입니다. 트러블슈팅을 공부할 때도 같은 지도를 그대로 씁니다.

같은 방식으로 `kubectl run` 한 번을 소스 코드 수준까지 따라간 글로 Jamie Hannaford의 [What happens when I type kubectl run](https://github.com/jamiehannaford/what-happens-when-k8s)이 있습니다. 링크된 소스가 대부분 v1.14 무렵이라 세부는 지금과 다르지만 층을 나누는 순서는 이 글과 같습니다.

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

손님(사용자)이 주문서를 써서 카운터(API 서버)에 내면 카운터는 주문서를 주문 꽂이(etcd)에 꽂습니다. 주방장(컨트롤러)은 꽂이를 지켜보다가 "파스타 3인분"을 보고 접시 세 개 분량의 작업표를 다시 꽂고 배치 담당(스케줄러)은 작업표마다 화구 번호를 적습니다. 화구 앞 요리사(kubelet)는 자기 화구 번호가 적힌 작업표만 집어 요리합니다.

누구도 서로에게 말을 걸지 않고 꽂이만 봅니다. 이 "지켜보다가 바뀌면 받아 보기"가 watch입니다.

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

### 3-1. kubectl: 파일을 HTTP 요청으로 바꾼다

kubectl이 하는 일은 생각보다 단순합니다. YAML을 JSON으로 바꿔 API 서버에 HTTPS 요청 하나를 보내는 게 전부입니다.

- 클러스터에 없는 객체면 생성 요청(`POST`)
- 이미 있으면 바뀐 부분만 보내는 요청(`PATCH`)

어디로, 누구 자격으로 보낼지는 kubeconfig에서 읽습니다. 파일은 세 덩어리입니다.

| 부분 | 들어 있는 것 |
|---|---|
| 클러스터 | API 서버 주소, CA 인증서 |
| 사용자 | 클라이언트 인증서와 키 |
| 컨텍스트 | 클러스터 + 사용자 + 기본 네임스페이스를 묶은 이름 |

지금 쓰는 조합이 `current-context`입니다. 파일은 `--kubeconfig` 플래그, `KUBECONFIG` 환경 변수, `$HOME/.kube/config` 순서로 찾습니다.

**고장 나면** 두 가지 모습으로 나타납니다. 하나는 `The connection to the server ... was refused`처럼 아예 연결이 안 되는 경우입니다. 다른 하나는 연결은 잘 되는데 엉뚱한 클러스터에 적용되는 경우입니다.

시험에서 점수를 깎는 건 두 번째입니다. 과제마다 지정된 호스트에 `ssh`로 들어가서 풀고 끝나면 `exit`로 시작 호스트에 돌아와야 합니다. ssh 안에서 다시 ssh는 할 수 없습니다.

### 3-2. kube-apiserver: 세 관문을 통과해야 저장된다

요청은 API 서버 안에서 관문 세 개를 차례로 지납니다.

1. **인증**: 누구인가
2. **인가**: 이 동작을 해도 되는가. kubeadm 기본값은 `Node,RBAC` 모드입니다.
3. **어드미션**: 내용을 고치거나 거절할 것인가. ServiceAccount나 기본 톨러레이션 같은 값이 여기서 채워지고 ResourceQuota나 PodSecurity를 어기면 거절됩니다.

조금 더 잘게 나누면 어드미션이 변형(mutating)과 검증(validating)으로 갈리고 그 사이에 스키마 검증이 끼어서 다섯 단계가 됩니다. 이 구분을 알아 두면 좋은 이유는 실패 코드만 보고 어디서 막혔는지 바로 알 수 있어서입니다.

| 응답 코드 | 막힌 곳 | 예 |
|---|---|---|
| `401` | 인증 | 인증 실패 |
| `403` | 인가, 또는 어드미션 거절 | `cannot create resource ...`, `exceeded quota`, PodSecurity 위반 |
| `422` | 스키마 검증 | 음수 replicas |
| `400` | 요청 형식 | 필드 이름 오타 |

인가에 쓰는 RBAC 객체는 넷인데 두 축으로 놓으면 한 번에 외워집니다.

| 범위 | 권한 묶음 | 묶음을 사용자·ServiceAccount에 연결 |
|---|---|---|
| 네임스페이스 하나 | Role | RoleBinding |
| 클러스터 전체 | ClusterRole | ClusterRoleBinding |

RBAC에는 "금지" 규칙이 없습니다. 권한은 더하기만 되니까 막고 싶으면 그 권한을 준 바인딩을 지웁니다.

**고장 나면** 이 층의 문제는 숨지 않습니다. 내가 kubectl로 보낸 객체가 막히면 위 표의 코드가 화면에 바로 찍힙니다.

함정은 하나입니다. Deployment가 대신 만드는 Pod가 쿼터에 걸리면 kubectl 화면은 조용합니다. 오류는 3-4절에서 보듯 ReplicaSet 이벤트에만 남습니다.

### 3-3. etcd: 여기까지 오면 kubectl은 끝난다

관문을 통과한 Deployment와 Service는 etcd에 저장되고 그제야 kubectl에 `created`가 돌아옵니다. Service는 이때 ClusterIP를 받습니다.

그런데 이 순간 Pod는 한 개도 없습니다. `created`는 "원하는 상태를 적어 두었다"는 데까지만 말해 줍니다. 실제로 띄우는 일은 이제부터 아래층이 합니다.

etcd는 Raft 합의를 쓰는 분산 키-값 저장소입니다. 클러스터의 모든 객체가 여기 있으니 시험에서 손이 가는 건 백업과 복구입니다.

- **위치**: kubeadm 기본 구성에서는 컨트롤 플레인 노드마다 static Pod로 돌고 데이터는 `/var/lib/etcd`에 있습니다.
- **백업**: 동작 중인 멤버에 접속해 `etcdctl snapshot save`로 스냅샷을 뜹니다. 접속에 쓸 인증서 경로는 etcd 매니페스트에서 먼저 확인합니다.
- **복구**: 스냅샷을 새 데이터 디렉터리에 풀고 etcd 매니페스트가 그 디렉터리를 보게 고칩니다. 매니페스트를 고치면 kubelet이 etcd Pod를 알아서 다시 만듭니다.

**고장 나면** etcd가 멈추면 API 서버가 제대로 뜨지 못하고 재시작을 반복합니다. 사용자 눈에는 `kubectl`이 통째로 안 되는 것으로 보여서 API 서버 문제와 구분이 안 됩니다. 컨트롤 플레인 노드에 들어가 `crictl logs`를 봐야 갈립니다.

### 3-4. 컨트롤러: Deployment가 Pod 세 개가 된다

Pod 세 개는 한 번에 생기지 않고 두 단계를 거칩니다. 둘 다 kube-controller-manager 안에서 일어납니다.

1. deployment 컨트롤러가 새 Deployment를 보고 ReplicaSet을 만듭니다.
2. replicaset 컨트롤러가 그 ReplicaSet을 보고 Pod 객체 세 개를 만듭니다.

이렇게 만들어진 Pod는 `spec.nodeName`이 비어 있습니다. 어느 노드에서 돌지 아직 아무도 정하지 않았습니다.

컨트롤러는 모두 같은 일을 되풀이합니다. spec(원하는 상태)과 status(관측한 상태)를 비교해서 차이를 메우는 루프입니다. 스케줄러와 kubelet까지 포함해 누구도 etcd를 직접 읽지 않고 API 서버를 watch합니다.

Deployment, ReplicaSet, Pod는 `metadata.ownerReferences`로 이어져 있습니다. Pod는 ReplicaSet을, ReplicaSet은 Deployment를 주인으로 가리킵니다. 여기서 두 가지가 따라 나옵니다.

- Pod를 지우면 ReplicaSet이 다시 만듭니다. 개수나 이미지를 바꾸려면 맨 위 Deployment를 고칩니다.
- Pod 템플릿을 바꾸면 Deployment가 새 ReplicaSet을 하나 더 만들고 새 쪽을 늘리면서 옛 쪽을 줄입니다. 이게 롤링 업데이트이고 기본값은 `maxUnavailable`과 `maxSurge` 모두 25%입니다. 옛 ReplicaSet은 레플리카 0으로 남아 있다가 롤백하면 다시 늘어납니다.

**고장 나면** Deployment는 있는데 ReplicaSet이나 Pod가 생기지 않고 스케일을 바꿔도 반응이 없습니다. 쿼터에 걸린 경우라면 `kubectl describe rs`에 `FailedCreate`가 남습니다.

### 3-5. kube-scheduler: 노드를 고른다

스케줄러는 `nodeName`이 빈 Pod를 큐에 넣고 두 단계로 노드를 고릅니다.

| 단계 | 하는 일 | 여기서 쓰이는 조건 |
|---|---|---|
| Filter | 못 쓰는 노드를 거른다 | requests, nodeSelector, 필수(required) 어피니티, `NoSchedule` 테인트와 톨러레이션 |
| Score | 남은 노드에 점수를 매겨 하나를 고른다 | 선호(preferred) 어피니티, `PreferNoSchedule` 테인트 |

"반드시"는 Filter, "되도록"은 Score로 외우면 됩니다.

고른 결과는 `binding` 서브리소스로 보내고 API 서버가 `spec.nodeName`을 채웁니다.

`spec.nodeName`을 처음부터 직접 적은 Pod는 스케줄러를 건너뛰고 그 노드의 kubelet이 바로 받습니다. 스케줄러가 멈췄을 때 Pod를 특정 노드에 띄우는 방법으로 씁니다. 다만 Filter를 거치지 않아서 노드 자원이 모자라면 kubelet이 Pod를 거부하고 Pod는 `OutOfcpu` 같은 이유로 곧바로 `Failed`가 됩니다.

**고장 나면** Pod가 `Pending`에 남고 NODE 칸이 `<none>`입니다. 이벤트를 보면 원인이 둘로 갈립니다.

- `FailedScheduling` 이벤트에 이유가 적혀 있으면 스케줄러는 살아 있고 맞는 노드가 없는 경우입니다.
- 이벤트가 아예 없으면 스케줄러 자체가 멈춘 경우입니다.

### 3-6. kubelet: 자기 노드에 온 Pod를 실행한다

각 노드의 kubelet은 `nodeName`이 자기인 Pod만 골라 지켜봅니다. 새 Pod가 오면 이 순서로 움직입니다.

1. CRI로 런타임을 불러 샌드박스를 만듭니다. 네트워크 네임스페이스를 잡아 두는 pause 컨테이너입니다.
2. CNI로 IP를 받습니다.
3. 이미지를 받아 컨테이너를 시작합니다.
4. 결과를 `status` 서브리소스로 올립니다. `kubectl get pod -o wide`의 IP와 NODE 칸이 이 값입니다.

kubelet은 노드에서 systemd 서비스로 도는 프로세스입니다. 그래서 고칠 때도 `systemctl`과 `journalctl`을 쓰고 노드의 컨테이너는 `crictl`로 봅니다.

노드가 살아 있다는 신호는 Lease로 보냅니다. kubelet이 `kube-node-lease` 네임스페이스의 Lease를 기본 10초마다 갱신합니다.

**고장 나면** 노드가 `NotReady`가 되고 그 노드에는 새 Pod가 뜨지 않습니다. 기본 설정이면 약 50초 뒤 `unreachable` 테인트가 붙고 다시 300초 뒤 그 노드의 Pod가 축출됩니다.

`kubectl describe node`에 `Kubelet stopped posting node status.`가 보이면 원인은 노드 쪽입니다. 그 노드로 들어가 kubelet부터 봅니다.

### 3-7. CRI, CNI, CSI: 컨테이너, 네트워크, 디스크를 붙인다

kubelet은 컨테이너를 직접 만들지 않습니다. 세 인터페이스에 일을 나눠 맡깁니다.

| 인터페이스 | 맡는 일 | 대표 구현 |
|---|---|---|
| CRI | 이미지를 받고 샌드박스(pause)와 컨테이너를 만든다 | containerd, CRI-O |
| CNI | Pod에 네트워크 인터페이스와 IP를 붙인다 | Calico, Cilium, Flannel |
| CSI | 볼륨을 만들고 노드에 붙여 마운트한다 | 클라우드 디스크 드라이버, 로컬 경로 드라이버 |

부르는 쪽이 하나 다릅니다. CRI와 CSI는 kubelet이 직접 부르고 CNI는 CRI 런타임(containerd 등)이 샌드박스를 만들 때 부릅니다.

노드에서 볼 곳은 인터페이스마다 정해져 있습니다.

- **CRI**: kubelet의 `--container-runtime-endpoint`가 가리키는 소켓으로 붙습니다. dockershim이 1.24에서 빠졌으니 Docker Engine을 쓰려면 cri-dockerd가 필요합니다.
- **CNI**: 설정은 `/etc/cni/net.d`, 실행 파일은 `/opt/cni/bin`에 있습니다. Pod IP가 안 잡히면 이 두 곳과 플러그인 Pod 상태부터 봅니다. NetworkPolicy도 CNI 플러그인이 지원해야 동작합니다.
- **CSI**: PVC는 조건이 맞는 PV와 일대일로 묶이고 맞는 PV가 없으면 `Pending`으로 남습니다.

네트워크 모델은 한 문장으로 외웁니다. 모든 Pod는 클러스터 전체에서 고유한 IP를 받고 같은 노드든 다른 노드든 NAT 없이 직접 통신합니다.

**고장 나면** 상태 이름이 어느 인터페이스 문제인지 알려 줍니다.

| 보이는 상태 | 원인 |
|---|---|
| `ImagePullBackOff` | 이미지를 못 받음(CRI) |
| `ContainerCreating`에 오래 머묾 | 볼륨이나 네트워크를 못 붙임(CSI, CNI) |
| 노드 `NotReady`, Ready 조건에 `cni plugin not initialized` | CNI가 아예 없음 |
| Pod `Pending` | PVC가 묶일 PV를 못 찾음. 이때는 더 앞인 스케줄 단계에서 멈춤 |

헷갈리기 쉬운 예외가 하나 있습니다. StorageClass의 `volumeBindingMode`가 `WaitForFirstConsumer`이면 그 PVC를 쓰는 Pod가 생길 때까지 `Pending`인 게 정상입니다.

### 3-8. Service와 kube-proxy: 바뀌는 Pod IP 앞에 고정 주소를 둔다

Pod가 IP를 받으면 두 구성요소가 움직입니다.

1. EndpointSlice 컨트롤러가 Service `web`의 selector에 맞는 Pod IP를 Ready 여부(`conditions.ready`)와 함께 EndpointSlice에 적습니다.
2. 각 노드의 kube-proxy가 Service와 EndpointSlice를 지켜보다가 ClusterIP로 온 패킷을 Pod IP 중 하나로 바꾸는 규칙을 커널에 씁니다. 기본 모드는 `iptables`입니다.

이름 `web.shop.svc.cluster.local`은 CoreDNS가 ClusterIP로 풀어 줍니다. CoreDNS는 `kube-system`에서 `kube-dns`라는 Service 이름으로 돌고 설정은 ConfigMap `coredns`의 Corefile에 있습니다. Pod는 kubelet 설정의 `clusterDNS` 값으로 이 DNS 서버 주소를 받습니다.

포트는 셋이라 자주 헷갈립니다.

| 필드 | 뜻 |
|---|---|
| `port` | Service가 받는 포트 |
| `targetPort` | 트래픽을 보낼 Pod의 포트. 생략하면 `port`와 같음 |
| `nodePort` | NodePort, LoadBalancer 타입에서 모든 노드가 여는 포트 |

타입은 쌓아 올리는 구조입니다. ClusterIP 위에 NodePort가 기능을 더하고 LoadBalancer는 보통 NodePort 위에 올라갑니다. ExternalName만 따로 떨어져 있어서 프록시 없이 DNS CNAME만 돌려줍니다.

**고장 나면** Service는 있는데 응답이 없습니다. 가장 흔한 원인은 selector와 Pod 라벨이 어긋나 EndpointSlice가 비어 있는 경우입니다. readiness probe가 실패한 Pod는 EndpointSlice에 `ready: false`로 남고 kube-proxy가 트래픽 대상에서 뺍니다. 이름으로는 안 되는데 IP로는 닿으면 CoreDNS 쪽입니다.

어디가 문제인지 모르겠으면 Debug Services 문서 순서대로 하나씩 지워 나갑니다.

1. Service가 있는가
2. NetworkPolicy가 막고 있지 않은가
3. DNS 이름으로 되는가
4. ClusterIP로 되는가
5. 포트 정의가 맞는가
6. EndpointSlice가 비어 있지 않은가
7. Pod에 직접 닿는가
8. kube-proxy가 돌고 있는가

### 3-9. Gateway와 Ingress: 클러스터 바깥에서 들어오는 문

여기까지 오면 클러스터 안에서는 `web`에 닿습니다. 바깥 사용자가 `shop.example.com`으로 들어오려면 HTTP 요청을 Service로 이어 줄 규칙이 하나 더 필요합니다. 방법은 둘이고 시험 범위에는 둘 다 있습니다.

Gateway API는 역할마다 객체를 나눕니다.

| 객체 | 정하는 것 |
|---|---|
| GatewayClass | 어느 컨트롤러가 Gateway를 구현하는지 |
| Gateway | 리스너(프로토콜, 포트, 호스트 이름, TLS)를 연다 |
| HTTPRoute | 들어온 요청을 어느 Service로 보낼지 |

연결은 양쪽이 서로 허락해야 성립합니다. Route는 `parentRefs`로 Gateway를 가리키고 Gateway는 리스너의 `allowedRoutes`로 붙을 수 있는 Route를 거릅니다.

Ingress는 같은 일을 하는 예전 방식입니다. Ingress 리소스는 규칙만 담고 실제 프록시는 따로 설치한 Ingress 컨트롤러가 설정합니다. 컨트롤러가 여럿이면 `spec.ingressClassName`으로 고르고 경로마다 `pathType`이 반드시 있어야 합니다.

**고장 나면** HTTPRoute를 만들었는데 트래픽이 안 옵니다. `kubectl describe httproute`에서 `Accepted`와 `ResolvedRefs` 조건을 봅니다. `False`면 사유에 Gateway 이름이나 네임스페이스 허용 문제가 적혀 있습니다.

Ingress는 리소스만 있고 컨트롤러가 없으면 아무 일도 일어나지 않습니다.

## 4. 반대 방향: 요청 하나가 컨테이너에 닿기까지

3장은 객체가 만들어지는 길이었습니다. 다 만들어진 뒤 사용자 요청이 지나가는 길은 방향이 다르고 거치는 곳도 조금 다릅니다.

![사용자 요청이 Gateway와 HTTPRoute, Service ClusterIP, kube-proxy가 쓴 iptables DNAT 규칙, CNI가 배정한 Pod IP를 거쳐 nginx 컨테이너 프로세스에 닿는 그림. 이름 해석은 CoreDNS, 차단 규칙은 NetworkPolicy가 맡는다](/uploads/cert/cka-map/request-path.svg)

요청이 지나가는 길에는 API 서버도 스케줄러도 컨트롤러도 없습니다. 컨트롤 플레인이 잠깐 멈춰도 이미 깔린 커널 규칙과 떠 있는 컨테이너로 요청은 계속 처리됩니다.

반대로 새 Pod가 뜨거나 Pod IP가 바뀐 것은 반영되지 않습니다. [3편 3장](/blog/cert/cka/cka-01-why-kubernetes#3-구성요소가-멈추면-무엇이-멈추는지)에서 controller-manager를 멈춰 놓고 확인한 것도 이 동작입니다.

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

비중은 [cncf/curriculum의 v1.37 커리큘럼](https://github.com/cncf/curriculum)을 따랐고 세부 항목은 [1편 2-1절](/blog/cert/cka/cka-00-exam-and-study-plan#2-1-영역별-비중과-세부-항목)에 옮겨 두었습니다.

트러블슈팅이 가장 크지만 따로 외울 것은 적습니다. 나머지 네 영역에서 각 층이 정상일 때 어떤 모습인지 알아야 고장 난 모습이 눈에 들어옵니다.

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

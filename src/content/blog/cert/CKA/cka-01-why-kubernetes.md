---
title: '[CKA] 쿠버네티스의 동작 방식: 선언형 API, 구성요소, 멈췄을 때 보이는 증상'
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
coverImage: /uploads/cert/cka/k8s-architecture.webp
draft: false
series: "CKA 공부"
seriesOrder: 3
---

![쿠버네티스 클러스터 구조: 컨트롤 플레인(etcd, API Server, Scheduler, Controller Manager, Cloud Controller Manager)과 워커 노드(kubelet, Container Runtime, kube-proxy)](/uploads/cert/cka/k8s-architecture.webp)

*그림 출처: [DevOps Mojo](https://medium.com/devops-mojo), Ashish Patel*

## 결론부터

1. 쿠버네티스 오브젝트의 `spec`은 원하는 상태이고 `status`는 관측된 상태입니다. 컨트롤러와 kubelet이 둘의 차이를 계속 메웁니다. 루프가 잠시 멈췄다 돌아와도 놓친 이벤트를 되짚지 않고 지금 상태와 원하는 상태를 다시 비교합니다.
2. kube-apiserver, etcd, kube-scheduler, kube-controller-manager는 kubeadm 클러스터에서 static Pod로 돌고 kubelet은 systemd 서비스입니다. 이 배치를 알면 "kubectl이 안 된다"는 증상에서 노드로 내려가 `crictl`과 `journalctl`을 칠 생각이 바로 납니다.
3. 구성요소 하나가 멈춰도 이미 떠 있는 Pod는 그대로 돕니다. 멈추는 것은 새로 맞추는 일입니다. controller-manager를 멈추고 `replicas`를 5로 올리면 ReplicaSet의 `DESIRED`가 3에 머물고 되살리면 5가 됩니다.
4. 메모리 limit을 넘은 컨테이너는 커널이 SIGKILL로 끝내고 kubelet이 `Reason: OOMKilled`, `Exit Code: 137`로 적습니다. 137은 128+9라서 시그널 종료의 표시일 뿐이고 OOM인지는 Reason으로 판단합니다.
5. CPU limit을 넘은 컨테이너는 죽지 않고 느려집니다(스로틀링). `kubectl top`은 사용량만 보여 주므로 한도에 붙어 있는 사용량이 스로틀링의 단서입니다.

쿠버네티스 쪽은 다음 글 [기본 오브젝트와 요청 흐름](/blog/cert/cka/cka-01b-core-objects-and-flow)으로 이어집니다. cgroup 파일, 커널 OOM 로그, `cpu.max` 같은 커널 내부는 시험 범위 밖이라 "쿠버네티스 아래의 리눅스" 시리즈로 넘겼습니다.

---

## 1. 원하는 상태를 적는 API와 컨트롤 루프

<details>
<summary>기초부터: 컨테이너를 사람이 직접 돌리면 생기는 문제와 쿠버네티스의 자리</summary>

> **핵심 한 줄**: 쿠버네티스는 사람이 서버마다 손으로 하던 컨테이너 관리(재시작, 배치, 이전, 주소, 배포)를 대신 맡는 **컨테이너 오케스트레이터**입니다.

#### 1. 왜 필요한가

쇼핑몰 상품 API를 컨테이너 하나로 띄웠다고 해 봅니다. 서버 한 대에서 `docker run` 한 줄이면 뜨지만 실제로 서비스를 시작하면 질문 다섯 개가 따라옵니다.

1. **재시작**: 컨테이너 프로세스가 죽으면 누가 다시 띄우는지
2. **배치**: 요청이 늘어 세 개로 늘릴 때 어느 서버에 띄울지 누가 고르는지
3. **이전**: 서버 한 대가 꺼지면 그 위의 컨테이너를 누가 다른 서버에서 다시 띄우는지
4. **주소**: 컨테이너가 새로 뜰 때마다 IP가 바뀌는데 다른 서비스는 어떤 주소로 부르는지
5. **배포**: 새 이미지로 바꿀 때 전부 한꺼번에 내리지 않고 하나씩 바꾸는 일을 누가 하는지

| 규모 | 버티는 방식 | 결과 |
|---|---|---|
| 서버 두세 대 | 사람이 스크립트로 확인하고 고침 | 버틸 수 있음 |
| 서버 수십 대, 컨테이너 수백 개 | 사람이 매번 확인하고 손으로 고침 | 무너짐 |
| 오케스트레이터 사용 | 소프트웨어가 계속 확인하고 고침 | 쿠버네티스가 그 대표 |

공식 문서 "Overview"는 쿠버네티스를 컨테이너화된 워크로드와 서비스를 관리하는 이식 가능하고 확장 가능한 오픈소스 플랫폼으로 소개하고 자가 치유, 서비스 디스커버리와 로드 밸런싱, 자동 롤아웃과 롤백, 자동 빈 패킹(bin packing)을 기능으로 듭니다. 위 질문 다섯과 하나씩 짝이 맞습니다.

#### 2. 질문별로 맡는 구성요소

| 질문 | 쿠버네티스에서 맡는 구성요소 |
|---|---|
| 죽으면 다시 띄우기 | 같은 Pod 안 재시작은 kubelet, 지워진 Pod 다시 만들기는 ReplicaSet 컨트롤러 |
| 어느 서버에 띄울지 | kube-scheduler |
| 서버가 꺼졌을 때 옮기기 | node lifecycle 컨트롤러와 워크로드 컨트롤러 |
| 바뀌는 IP를 고정 주소로 부르기 | Service와 CoreDNS |
| 하나씩 바꾸는 배포 | Deployment의 롤링 업데이트 |

#### 3. 어떻게 일하나: 선언형

1. **결과만 적기**: 사람은 "상품 API 컨테이너 3개, 이미지 nginx:1.27"처럼 도달할 결과만 API에 적어 둡니다.
2. **계속 확인하기**: 쿠버네티스 구성요소들이 적힌 결과와 지금 모습을 계속 비교합니다.
3. **차이 메우기**: 다르면 구성요소가 알아서 맞춥니다.

```text
사람: "상품 API 3개" 기록 → API 서버 → 구성요소가 지금 몇 개인지 확인 → 모자라면 더 띄움
```

이 방식을 **선언형(declarative)**이라고 하고 이 장 전체가 그 동작을 다룹니다.

#### 4. 쿠버네티스가 지키려는 두 가지: 고가용성과 자가 치유

| 가치 | 뜻 | 쿠버네티스에서 하는 일 |
|---|---|---|
| **고가용성(High Availability)** | 일부가 죽어도 서비스 전체는 계속 응답함 | 같은 Pod를 여러 개 여러 노드에 띄우고 Service가 살아 있는 Pod로만 보냄 |
| **자가 치유(Self-Healing)** | 장애가 나면 시스템이 먼저 원래 상태로 되돌림 | 컨트롤러가 원하는 수와 지금 수의 차이를 보고 Pod를 다시 만듦 |

고가용성의 반대편에 있는 말이 **SPOF(Single Point of Failure, 단일 장애점)**입니다. 그 하나가 죽으면 전체가 멈추는 지점입니다.

| 구조 | 한 대가 죽으면 |
|---|---|
| 상품 API 서버 1대 | 서비스 전체가 멈춤(SPOF) |
| 상품 API Pod 3개를 노드 3대에 분산 | 나머지 2개가 요청을 받고 컨트롤러가 1개를 다시 띄움 |

운영 방식도 바뀝니다. 예전에는 새벽에 서버가 죽으면 사람이 알람에 깨서 손으로 살렸습니다. 지금은 컨트롤러가 먼저 Pod를 다시 띄우고 사람은 나중에 원인을 봅니다. 다만 컨트롤 플레인 자체가 한 대뿐이면 그것이 SPOF로 남으므로 컨트롤 플레인을 여러 대로 두는 HA 구성은 [5편 5-1절](/blog/cert/cka/cka-02-cluster-architecture#5-1-두-가지-토폴로지)에서 다룹니다.

#### 5. 실전 시나리오: 자가 치유만으로 못 막는 연쇄 장애

새벽에 503(Service Unavailable)이 급증합니다. Pod 한두 개에서 그치지 않고 서비스 전체가 응답하지 못한다는 신호입니다.

```text
트래픽 급증
  → Pod 1이 메모리 limit을 넘어 OOMKilled(종료 코드 137)
  → Pod 1이 받던 요청이 Pod 2, 3으로 몰림
  → Pod 2, 3도 limit을 넘어 차례로 OOMKilled
  → 다시 뜬 Pod도 몰린 요청을 받자마자 죽음(CrashLoopBackOff)
  → 서비스 전체 중단
```

자가 치유는 죽은 Pod를 다시 띄울 뿐 몰려드는 요청을 줄이지는 못합니다. 그래서 애플리케이션이나 앞단 게이트웨이에 방어 장치를 둡니다. 둘 다 쿠버네티스 오브젝트가 아니고 애플리케이션 라이브러리, API 게이트웨이, 서비스 메시 같은 곳에서 거는 설정입니다.

| 방어 장치 | 하는 일 |
|---|---|
| **Rate Limiting(속도 제한)** | 받아들이는 요청 속도에 상한을 두고 넘는 요청은 바로 거절해 감당할 만큼만 처리 |
| **Circuit Breaker(서킷 브레이커)** | 호출하는 대상이 계속 실패하면 한동안 호출 자체를 끊어 실패가 호출하는 쪽으로 번지지 않게 막음 |

원인 확인은 `kubectl describe pod`의 `Last State: Terminated`, `Reason: OOMKilled`, `Exit Code: 137`에서 시작합니다. 137은 128 + 9(SIGKILL)이고 신호를 보낸 쪽은 커널의 OOM killer입니다. 이 경로는 [cgroup과 QoS 글](/blog/theory/systems/k8s-linux-03-cgroup-qos)에 있습니다.

#### 6. 물리 서버, VM, 컨테이너: 왜 지금 모양이 됐나

| 시대 | 한 서버에 앱을 올리는 방식 | 남은 문제 |
|---|---|---|
| 물리 서버 | OS 하나에 여러 앱을 함께 설치 | 라이브러리 버전 충돌, 한 앱의 메모리 누수가 옆 앱까지 멈춤, 일부만 늘릴 수 없음, 롤백이 어려움 |
| 가상 머신(VM) | 하이퍼바이저가 하드웨어를 나눠 VM마다 게스트 OS(커널 포함)를 띄움 | 격리는 강하지만 VM마다 커널과 OS를 따로 들고 있어 무겁고 부팅이 느림 |
| 컨테이너 | 호스트 커널 하나를 공유하고 namespace와 cgroup으로 프로세스를 격리 | 가볍고 빠르지만 커널을 공유하므로 격리가 VM보다 약함 |

컨테이너가 나왔다고 VM이 사라진 것은 아닙니다. 클라우드에서는 보통 VM 위에서 컨테이너를 돌립니다.

```text
물리 서버 → 하이퍼바이저(AWS는 Nitro) → VM(EC2) → 리눅스 커널 → containerd → 컨테이너
```

- **VM 층을 남기는 이유**: 여러 고객이 한 물리 서버를 나눠 쓰는 클라우드에서 고객 사이 경계를 하드웨어 가상화 수준으로 세우기 위해서입니다. 컨테이너는 커널을 공유하므로 컨테이너 밖으로 빠져나오는 공격(container breakout)이 커널까지 닿으면 같은 커널의 다른 컨테이너가 위험해집니다.
- **AWS Nitro**: 네트워크, 스토리지, 보안 처리를 전용 하드웨어(Nitro Card)로 넘기고 하이퍼바이저를 가볍게 만들어 호스트의 CPU와 메모리 대부분을 인스턴스에 주는 구조라고 AWS가 설명합니다.
- **베어 메탈**: 가상화 층 없이 하드웨어 위에 바로 OS를 올립니다. GPU를 직접 쓰는 학습, 지연에 민감한 처리처럼 가상화 비용조차 아까운 곳에서 씁니다.

#### 7. 왜 지금 이 문제가 커졌나: MSA와 컨테이너 수

인프라 모양이 물리 서버에서 VM과 컨테이너로 바뀌는 동안에도 서비스가 멈추지 않게 한다는 목표는 그대로였습니다. 바뀐 쪽은 관리할 대상의 수입니다. 쇼핑몰을 상품, 주문, 결제, 회원 서비스로 잘게 나누는 MSA(Microservice Architecture)로 가면 서비스마다 컨테이너가 여러 개씩 붙어서 전체가 수백에서 수천 개가 됩니다. 이 수를 사람이 하나씩 배포하고 지켜보고 살리는 방식은 버티지 못하므로 1번 표의 셋째 줄(오케스트레이터)로 넘어갑니다.

#### 8. VM이 풀어 준 것과 남긴 것, 하이퍼바이저 두 종류

| 구분 | 내용 |
|---|---|
| VM이 풀어 준 것 | VM끼리 자원 간섭을 막는 격리, VM마다 다른 OS와 라이브러리, 이미지 복제로 빠른 증설 |
| VM이 남긴 것 | VM마다 게스트 OS 전체를 들고 있어 무거움, 뜰 때마다 OS 부팅이라 수십 초에서 분 단위, 앱과 상관없는 OS 유지 비용 |
| 가장 큰 비용 | 커널 중복. VM 10대면 게스트 커널 10개가 각자 메모리를 잡고 앱이 놀아도 OS 백그라운드가 자원을 씀 |

| 유형 | 놓이는 자리 | 쓰는 곳 |
|---|---|---|
| Type 1(베어 메탈형) | 물리 하드웨어 바로 위 | 데이터센터와 퍼블릭 클라우드. 중간 OS가 없어 손실이 적음 |
| Type 2(호스티드형) | Windows나 macOS 같은 기존 OS 위에 프로그램으로 설치 | VirtualBox처럼 개인 PC의 실습과 테스트. 호스트 OS를 한 번 더 거침 |

Type 1이어도 VM마다 커널이 따로 있다는 점은 같습니다. 이 중복을 걷어 내려고 호스트 커널 하나를 함께 쓰는 컨테이너가 나왔습니다.

| 항목 | 컨테이너 | VM |
|---|---|---|
| 커널 | 호스트 커널 공유(OS 수준 격리) | VM마다 게스트 커널(하드웨어 가상화) |
| 쌓인 층 | 앱 → 런타임 → 호스트 커널 → 하드웨어 | 앱 → 게스트 OS → 하이퍼바이저 → 하드웨어 |
| 이미지 크기 | 수 MB에서 수백 MB | 보통 GB 단위 |
| 뜨는 시간 | 밀리초에서 초 | 초에서 분 |
| 한 서버에 올리는 수 | 많음 | 적음 |
| 격리 강도 | 커널을 공유하므로 상대적으로 약함 | 강함 |

그래서 클라우드에서는 둘을 겹쳐 씁니다. VM은 고객 사이 보안 경계를, 컨테이너는 그 안의 자원 효율을 맡습니다. 베어 메탈은 GPU를 직접 붙이는 대규모 학습(HPC), 마이크로초 단위 지연을 다투는 금융 거래, 가상화의 작은 손실도 아까운 대량 배치 처리처럼 특수한 곳에서 씁니다.

#### 9. 컨테이너와 Docker, 그리고 쿠버네티스 런타임의 변화

컨테이너는 리눅스 커널에 오래전부터 있던 기능으로 격리한 **보통의 프로세스 묶음**입니다. 마운트 네임스페이스는 2002년(커널 2.4.19), cgroup은 2008년(커널 2.6.24)에 커널에 들어왔고 2013년에 Solomon Hykes가 공개한 Docker가 이 기능들을 `docker run` 한 줄로 쓰게 포장했습니다. Docker는 컨테이너를 다루는 도구 하나의 이름이고 컨테이너는 커널 기능으로 만든 격리 실행 환경을 가리킵니다.

| 시기 | kubelet과 런타임의 연결 |
|---|---|
| v1.4까지 | kubelet 안의 코드가 Docker API를 직접 호출 |
| v1.5(CRI 알파)부터 v1.23까지 | CRI 표준이 생겼지만 Docker Engine은 CRI를 구현하지 않아 kubelet 안의 dockershim이 번역 |
| v1.24부터 | dockershim 제거. kubelet이 CRI를 구현한 containerd나 CRI-O와 바로 통신 |

컨테이너는 그대로 쓰고 kubelet과 Docker Engine 사이의 번역기만 빠졌습니다. 자세한 층 구조는 2-3절 토글에 있습니다.

#### 10. 지시하는 쪽과 집행하는 쪽

| 구분 | 쿠버네티스 | 리눅스 커널 |
|---|---|---|
| 하는 일 | "이 상태로 유지하라"는 원하는 상태를 받아 두고 맞추라고 지시 | CPU 시간 배분, 메모리 감시, 한도를 넘은 프로세스 종료를 실제로 수행 |
| 비유 | 악보대로 연주하라고 이끄는 지휘자 | 실제로 악기를 울리는 연주자 |
| 장애 때 보이는 것 | `OOMKilled` 같은 상태 문자열 | cgroup 카운터와 커널 로그 |

비유는 역할 분담까지만 맞습니다. 실제로는 kubelet이 런타임을 거쳐 cgroup 파일에 한도를 적어 두고 그 뒤의 판단과 집행은 커널이 혼자 합니다(4-2, 5-1절 토글).

컨테이너는 아래 네 커널 기능으로 만듭니다.

| 커널 기능 | 하는 일 | 쿠버네티스에서 보이는 모습 |
|---|---|---|
| Namespace | 프로세스가 볼 수 있는 범위(PID, 네트워크, 마운트, 호스트명)를 나눔 | Pod마다 따로 보이는 프로세스 목록과 IP |
| cgroup | CPU와 메모리 사용량에 상한을 두고 사용량을 셈 | `OOMKilled`, CPU 스로틀링 |
| OverlayFS | 이미지 레이어 여러 겹을 하나의 파일시스템처럼 겹쳐 보여 줌 | 이미지 레이어와 컨테이너 쓰기 계층 |
| veth 쌍 | 양 끝이 이어진 가상 랜선으로 컨테이너와 호스트를 연결 | Pod 네트워크, 노드 안 Pod 간 통신 |

네 기능의 커널 쪽 동작은 [쿠버네티스 아래의 리눅스 시리즈](/blog/theory/systems/k8s-linux-01-kernel-boundary)에서 한 편씩 다룹니다.

> **정리**: 쿠버네티스는 원하는 상태를 받아 두고 맞추라고 지시하는 쪽이고 실제 집행은 리눅스 커널이 합니다. 컨테이너가 namespace와 cgroup으로 격리한 보통 프로세스라는 바탕은 [커널 경계 글](/blog/theory/systems/k8s-linux-01-kernel-boundary)에 있습니다.

</details>

### 1-1. spec은 원하는 상태, status는 관측된 상태

<details>
<summary>기초부터: 오브젝트 YAML의 네 칸(apiVersion, kind, metadata, spec)</summary>

> **핵심 한 줄**: 오브젝트는 etcd에 저장되는 **기록** 한 건이고 거의 모든 오브젝트 YAML은 `apiVersion`, `kind`, `metadata`, `spec` 네 칸으로 시작합니다.

#### 1. 왜 기록과 실물을 나눠 보나

| 구분 | 무엇인지 | 누가 만드나 |
|---|---|---|
| 기록(오브젝트) | "이런 Pod가 있어야 한다"는 내용 | 사용자가 API 서버에 보냄, etcd에 저장 |
| 실물(컨테이너) | 노드에서 도는 프로세스 | 그 기록을 본 kubelet이 따로 만듦 |

Pod 오브젝트를 만든 시점에 생긴 것은 기록 한 건입니다. 기록과 실물이 나뉘어 있다는 점을 먼저 잡아 두면 뒤의 내용이 쉬워집니다.

#### 2. 네 칸 읽기

```yaml
apiVersion: v1          # 1) 이 오브젝트를 정의한 API 그룹과 버전
kind: Pod               # 2) 오브젝트 종류
metadata:               # 3) 이름표: 이름, 네임스페이스, 라벨
  name: product-api
  namespace: shop
  labels:
    app: product-api
spec:                   # 4) 원하는 상태. kind마다 내용이 다름
  containers:
  - name: web
    image: nginx:1.27
```

| 칸 | 뜻 | 예와 주의점 |
|---|---|---|
| `apiVersion` | 이 kind가 어느 API에 속하는지 | 초창기부터 있던 Pod, Service, ConfigMap은 그룹 없이 `v1`. Deployment는 `apps/v1`, Job은 `batch/v1`처럼 `그룹/버전`. 틀리면 API 서버가 그런 kind를 모른다고 거부 |
| `kind` | 종류 이름 | 첫 글자가 대문자 |
| `metadata` | 오브젝트를 찾고 고르는 정보(이름, 네임스페이스, 라벨) | 같은 네임스페이스 안에서 같은 kind끼리 `name`이 겹칠 수 없음 |
| `spec` | 내가 원하는 모습 | kind마다 내용이 달라서 `kubectl explain pod.spec`처럼 클러스터에 직접 물어봄 |

#### 3. 다섯째 칸 status

| 구분 | `spec` | `status` |
|---|---|---|
| 누가 쓰나 | 사용자 | kubelet과 컨트롤러 |
| 담는 것 | 원하는 상태 | 관측한 결과 |
| YAML 파일에 적으면 | 반영됨 | 무시됨 |

#### 4. 실전에서 보이는 모습

- `kubectl get pod product-api -o yaml`로 받아 보면 내가 쓴 네 칸 아래에 `status`와 `metadata.uid`, `creationTimestamp` 같은 시스템 필드가 붙어 있습니다.
- 그래서 시험에서 이 출력을 그대로 고쳐 다시 만들 때는 시스템 필드를 지웁니다.

> **정리**: 네 칸은 사용자가 쓰고 `status`는 쿠버네티스가 씁니다. 바로 아래 본문에서 `spec`과 `status`의 차이로 트러블슈팅하는 법을 봅니다.

</details>

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

`spec`과 `status`를 나눠 보는 습관은 시험의 트러블슈팅에서 쓸모가 있습니다. `spec`은 바뀌었는데 `status`가 따라오지 않으면 그 사이를 메우는 구성요소가 멈춰 있습니다.

### 1-2. 컨트롤러는 차이를 계속 메우는 루프

<details>
<summary>기초부터: 컨트롤 루프는 온도 조절기처럼 돈다</summary>

> **핵심 한 줄**: 컨트롤러는 원하는 값과 잰 값의 **차이**만 보고 움직이는 루프입니다. 공식 문서 "Controllers"는 이를 방 온도 조절기에 빗댑니다.

#### 1. 온도 조절기 비유

사람은 원하는 온도 24도를 정해 둡니다. 조절기는 현재 온도를 재고 24도보다 낮으면 난방을 켜고 맞으면 끕니다. 사람이 "지금 난방을 켜라"고 지시하지 않아도 정해 둔 값과 잰 값의 차이만 보고 움직입니다. 쿠버네티스 컨트롤러도 이렇게 동작합니다.

| 온도 조절기 | ReplicaSet 컨트롤러 |
|---|---|
| 원하는 온도 24도 | `replicas: 3` |
| 현재 온도 | selector에 맞는 Pod 수 |
| 난방 켜기 | Pod 생성 요청 |

#### 2. 어떻게 동작하나

1. **관찰**: API 서버에서 자기가 맡은 오브젝트의 spec(원하는 상태)과 실제 상황을 읽습니다. ReplicaSet 컨트롤러라면 `replicas: 3`과 selector에 맞는 Pod 수를 봅니다.
2. **비교**: 둘의 차이를 계산합니다. 원하는 수 3, 실제 수 2면 차이는 1입니다.
3. **조치**: 차이를 줄이는 요청을 API 서버에 보냅니다. Pod 하나를 새로 만들어 달라고 요청하고 결과를 status에 적습니다.

```text
관찰(spec 3, 실제 2) → 비교(차이 1) → 조치(Pod 1개 생성 요청) → 다시 관찰 → ...
```

#### 3. 이벤트 기반과 레벨 기반

| 구분 | 이벤트 기반(edge-triggered) | 레벨 기반(level-triggered) |
|---|---|---|
| 무엇에 반응하나 | "Pod가 지워졌다"는 사건 하나하나 | "지금 몇 개여야 하는데 몇 개인지"라는 상태 수준 |
| 사건을 놓치면 | 해야 할 일을 모름 | 다시 돌아와 지금 상태를 한 번 보면 해야 할 일이 그대로 나옴 |
| 쿠버네티스 컨트롤러 | 판단 기준으로 쓰지 않음 | 이쪽으로 판단 |

3장에서 controller-manager를 멈췄다 살리는 실험이 이 성질을 보여 줍니다.

#### 4. 이어 달리기 구조

한 컨트롤러는 한 종류의 일만 합니다.

```text
Deployment 컨트롤러 → ReplicaSet 생성 → ReplicaSet 컨트롤러 → Pod 생성 → 스케줄러 → 노드 배정
```

- Deployment 컨트롤러는 ReplicaSet만 만들고 Pod는 만들지 않습니다.
- 작은 루프 여러 개가 API 서버의 기록을 매개로 이어 달리기를 하는 구조라서 어느 단계에서 멈췄는지 `spec`과 `status`를 차례로 보면 찾을 수 있습니다.

> **정리**: 컨트롤러는 관찰, 비교, 조치를 끝없이 반복하고 상태 수준을 보기 때문에 잠시 멈춰도 다시 따라잡습니다. 아래 본문의 그림이 이 이어 달리기를 구성요소별로 보여 줍니다.

</details>

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

<details>
<summary>기초부터: 클러스터, 노드, 컨트롤 플레인이라는 말</summary>

> **핵심 한 줄**: 컨트롤 플레인은 **판단과 기록**을 맡고 워커 노드는 **실행**을 맡으며 둘은 API 서버를 거쳐서만 이어집니다.

#### 1. 용어 정리

| 용어 | 뜻 |
|---|---|
| 클러스터 | 쿠버네티스가 하나로 묶어 관리하는 서버 무리 전체 |
| 노드 | 클러스터에 속한 서버 한 대. 물리 서버여도 VM이어도 됨 |
| 컨트롤 플레인 | 클러스터의 상태를 저장하고 결정을 내리는 구성요소 묶음. 옛 자료의 "마스터" |
| 워커 노드 | 사용자 Pod가 실제로 도는 노드 |

#### 2. 요청 하나를 따라가기

쇼핑몰 주문 API Pod 하나를 만드는 요청을 따라가면 각 구성요소가 어디서 등장하는지 보입니다.

1. **kubectl**: 사용자가 `kubectl apply`를 칩니다. kubectl은 YAML을 HTTPS 요청으로 바꿔 kube-apiserver에 보냅니다.
2. **kube-apiserver와 etcd**: kube-apiserver가 요청자를 확인하고 내용을 검사한 뒤 etcd에 기록합니다. etcd는 클러스터의 모든 오브젝트를 담는 키-값 저장소입니다.
3. **kube-controller-manager**: 안의 컨트롤러들이 새 기록을 보고 필요한 하위 오브젝트(ReplicaSet, Pod)를 만들어 달라고 다시 API 서버에 요청합니다.
4. **kube-scheduler**: 아직 노드가 정해지지 않은 Pod를 보고 알맞은 노드를 골라 기록합니다.
5. **kubelet**: 그 노드의 kubelet이 "내 노드에 배정된 Pod"를 보고 컨테이너 런타임(containerd 등)에 컨테이너를 만들게 합니다.
6. **kube-proxy**: Service 정보를 보고 노드의 패킷 전달 규칙을 고칩니다. 그래야 다른 Pod가 Service 주소로 주문 API에 닿습니다.

```text
            [컨트롤 플레인: 판단과 기록]
kubectl → kube-apiserver ↔ etcd
               ▲   ▲   ▲
     controller-manager  scheduler
               │
            [워커 노드: 실행]
         kubelet → 컨테이너 런타임
         kube-proxy → 패킷 전달 규칙
```

#### 3. 헷갈리는 점

- 구성요소끼리 직접 말을 걸지 않습니다. API 서버에 기록을 남기고 서로의 기록을 지켜봅니다. 모든 화살표가 API 서버를 거칩니다.
- 그래서 API 서버가 멈추면 새로 바뀌는 일은 전부 멈추지만 이미 노드에서 도는 컨테이너는 kubelet과 런타임이 계속 돌립니다.

| API 서버가 멈췄을 때 | 결과 |
|---|---|
| 새 배포, 스케일, 스케줄링 | 멈춤 |
| 이미 노드에서 도는 컨테이너 | kubelet과 런타임이 계속 돌림 |

> **정리**: API 서버가 멈추면 새로 맞추는 일은 멈추고 이미 도는 컨테이너는 계속 돕니다. 여섯 단계의 구성요소를 kubeadm 기준 실행 방식과 함께 보려면 아래 2-1절 표로 갑니다.

</details>

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

각 구성요소의 플래그와 인증서 방향은 [4편 2~3장](/blog/cert/cka/cka-01b-core-objects-and-flow)에 정리했습니다.

### 2-2. static Pod는 kubelet이 직접 띄운다

<details>
<summary>기초부터: static Pod가 따로 있는 이유와 미러 Pod</summary>

> **핵심 한 줄**: API 서버도 Pod로 돌리고 싶은데 Pod를 만들려면 API 서버가 있어야 합니다. 이 순환을 끊으려고 kubelet이 **디스크의 파일만 보고** 띄우는 Pod가 static Pod입니다.

#### 1. 닭과 달걀

보통 Pod는 "API 서버에 기록 → 스케줄러가 노드 배정 → kubelet이 실행" 순서로 뜹니다. 그런데 클러스터를 처음 켤 때는 API 서버가 아직 없습니다. 그래서 kubeadm은 컨트롤 플레인 네 구성요소를 `/etc/kubernetes/manifests`에 파일로 두고 kubelet이 이 파일을 직접 읽어 띄우게 합니다. 공식 문서 "Static Pods"도 static Pod의 주된 쓰임을 컨트롤 플레인을 스스로 띄우는 일로 듭니다.

#### 2. 미러 Pod

| 구분 | static Pod | 미러 Pod |
|---|---|---|
| 정체 | 노드에서 실제로 도는 컨테이너 | API 서버에 남긴 보기용 기록 |
| 누가 만드나 | kubelet(매니페스트 파일) | kubelet(API 서버가 살아 있을 때) |
| 이름 | 파일 안의 `metadata.name` | 그 이름 뒤에 `-<노드 이름>`이 붙음. 예: `kube-apiserver-controlplane` |
| `kubectl delete`하면 | 영향 없음 | 지워져도 kubelet이 다시 만듦 |

`kubectl get pods -n kube-system`에 컨트롤 플레인 Pod가 보이는 것은 미러 Pod 덕분입니다. 미러 Pod를 kubectl로 지워도 kubelet은 static Pod를 지우지 않습니다(공식 문서 "Create static Pods").

#### 3. 고칠 때는 파일을 고친다

- `kubectl edit`으로 미러 Pod를 고쳐도 실제 컨테이너는 바뀌지 않습니다. 매니페스트 파일을 고치고 저장하면 kubelet이 바뀐 것을 보고 Pod를 새로 만듭니다.
- static Pod의 spec은 ServiceAccount, ConfigMap, Secret 같은 다른 API 객체를 참조할 수 없습니다(Static Pods 문서). 그래서 컨트롤 플레인 매니페스트는 인증서와 설정을 `hostPath` 볼륨으로 노드 디렉터리에서 직접 읽습니다.
- 파일을 지우거나 디렉터리 밖으로 옮기면 kubelet이 그 Pod를 내립니다. 3-1절 실험이 이 방법을 씁니다.

#### 4. 아래 jsonpath의 `\.`

아래 명령의 `kubernetes\.io/config\.source`는 어노테이션 키 하나입니다. jsonpath에서 점은 "한 단계 아래로"라는 뜻이라 키 안의 점을 그대로 쓰면 `kubernetes` 아래의 `io/config` 아래의 `source`로 읽힙니다. 키 안의 점 앞에 `\`를 붙여 글자 그대로의 점이라고 알려 줍니다.

> **정리**: static Pod는 API 서버 없이 뜨는 Pod이고 미러 Pod는 그 모습을 API 서버에 비춰 둔 기록입니다. 컨트롤 플레인을 고칠 때는 kubectl을 내려놓고 노드의 매니페스트 파일을 고칩니다.

</details>

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

<details>
<summary>기초부터: Docker, containerd, CRI, OCI는 어떤 관계인지</summary>

> **핵심 한 줄**: "쿠버네티스가 Docker를 버렸다"는 말에서 빠진 것은 **kubelet과 Docker Engine 사이의 연결**뿐이고 Docker로 만든 이미지는 그대로 쓸 수 있습니다.

#### 1. 왜 헷갈리나

이 말을 들으면 Docker로 만든 이미지도 못 쓰는지 헷갈립니다. Docker 하나에 여러 층이 겹쳐 있었기 때문입니다. 층을 나눠 보면 정리됩니다.

#### 2. 층 나눠 보기

1. **Docker와 containerd**: Docker는 원래 이미지 빌드, 이미지 저장소 연동, 컨테이너 실행을 한 프로그램에 담은 도구였습니다. 그 안에서 컨테이너 실행을 맡던 부분을 떼어 낸 것이 containerd이고 지금은 CNCF 프로젝트입니다. Docker Engine도 내부에서 containerd를 씁니다.
2. **OCI 표준**: 이미지 형식과 컨테이너 실행 방법은 OCI(Open Container Initiative) 표준으로 정해져 있습니다. Docker로 빌드한 이미지는 OCI 형식이라 containerd나 CRI-O도 그대로 받아 실행합니다. 실제로 namespace와 cgroup을 설정해 프로세스를 띄우는 것은 그 아래의 runc 같은 OCI 런타임입니다.
3. **CRI**: kubelet이 런타임에 "Pod 샌드박스를 만들어라", "이 이미지로 컨테이너를 띄워라"라고 말하는 규약이 CRI(Container Runtime Interface)입니다. containerd와 CRI-O는 CRI를 직접 구현했습니다.
4. **dockershim 제거**: Docker Engine은 CRI를 구현하지 않았습니다. 그래서 kubelet 안에 dockershim이라는 번역 코드를 두고 붙였는데 v1.24에서 이 코드가 빠졌습니다. 지금 Docker Engine을 노드 런타임으로 쓰려면 cri-dockerd라는 별도 어댑터가 필요합니다([5편 2-4b절](/blog/cert/cka/cka-02-cluster-architecture)).

```text
v1.23까지: kubelet → dockershim(kubelet 안) → Docker Engine → containerd → runc
지금:      kubelet → CRI → containerd 또는 CRI-O → runc
           kubelet → CRI → cri-dockerd(별도 설치) → Docker Engine → containerd → runc
```

#### 3. 한눈에 비교: 층에 맞는 도구

| 도구 | 말을 거는 대상 | 쓰는 때 |
|---|---|---|
| `docker` | Docker Engine | 개발 PC에서 이미지 빌드와 실행 |
| `crictl` | CRI 소켓(containerd, CRI-O) | 쿠버네티스 노드에서 Pod와 컨테이너 점검. 시험에서 쓰는 도구 |
| `ctr`, `nerdctl` | containerd | containerd 자체 디버깅 |

#### 4. 실전에서 보이는 모습

- containerd를 런타임으로 쓰는 노드에서 kubelet이 만든 컨테이너는 Docker Engine을 거치지 않으므로 `docker ps`에 나오지 않습니다. 노드에서는 `crictl ps`, `crictl pods`로 봅니다.

> **정리**: 이미지는 OCI 표준 덕에 그대로 쓰고 kubelet은 CRI로 런타임과 말합니다. 아래 본문의 그림이 kubelet에서 커널까지 이 층을 위에서 아래로 보여 줍니다.

</details>

```
kubelet                      API 서버에서 자기 노드 Pod를 받음
  → CRI → 컨테이너 런타임      containerd나 CRI-O. 샌드박스(pause)를 만들고 이미지를 받음
    → OCI 런타임(runc 등)     namespace와 cgroup을 설정하고 컨테이너 프로세스 실행
      → 리눅스 커널            격리(namespace)와 자원 제한(cgroup)을 집행
```

kubelet과 런타임 사이의 표준이 CRI(Container Runtime Interface)입니다. Docker Engine을 kubelet에 붙이던 dockershim은 v1.24에서 제거됐고 지금 노드는 containerd나 CRI-O처럼 CRI를 직접 구현한 런타임을 씁니다. 그래서 노드에서 컨테이너를 볼 때는 `crictl`을 씁니다.

Pod마다 먼저 뜨는 pause 컨테이너가 네트워크 네임스페이스를 잡아 두고 앱 컨테이너가 거기에 합류합니다. 그래서 `crictl pods`에 Pod 샌드박스가 따로 보이고 같은 Pod의 컨테이너끼리 `localhost`로 통신합니다. 커널 쪽 동작은 [네임스페이스와 pause](/blog/theory/systems/k8s-linux-02-namespaces-pause)와 [cgroup과 QoS](/blog/theory/systems/k8s-linux-03-cgroup-qos)에서 다룹니다.

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

출력 세 개가 서로 맞지 않습니다. 먼저 각 칸이 어느 필드에서 오는지 알아야 이 어긋남이 읽힙니다.

| 출력 | 칸 | 가져오는 필드 | 위 값 |
|---|---|---|---|
| `get deploy` | READY | `status.readyReplicas` / `spec.replicas` | 3/5 |
| `get deploy` | UP-TO-DATE, AVAILABLE | `status.updatedReplicas`, `status.availableReplicas` | 3, 3 |
| `get rs` | DESIRED | ReplicaSet의 `spec.replicas` | 3 |
| `get rs` | CURRENT, READY | ReplicaSet의 `status.replicas`, `status.readyReplicas` | 3, 3 |

`kubectl scale`은 Deployment의 `spec.replicas`를 API 서버에 직접 고쳐 쓰는 요청이라 컨트롤러 없이도 반영됩니다. READY의 분모가 5로 바뀐 것은 이 때문입니다. 나머지 칸은 모두 컨트롤러가 채우는 값입니다.

이제 출력을 다시 보면 Deployment의 `spec.replicas`는 5로 바뀌었지만 Deployment 컨트롤러가 없어서 ReplicaSet의 `DESIRED`는 3에 머물렀습니다. 실제 Pod는 2개인데 ReplicaSet과 Deployment의 `status`는 3을 가리킵니다. `status`를 갱신하는 주체도 컨트롤러라서 컨트롤러가 멈추면 `status`는 마지막 값으로 굳습니다. 남은 Pod 2개는 계속 Running이었습니다.

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

Troubleshooting Clusters 문서의 장애 시나리오와 각 구성요소의 역할을 묶은 표입니다. 자세한 복구 순서는 [9편 2장](/blog/cert/cka/cka-06-troubleshooting)에 있습니다.

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

<details>
<summary>기초부터: 테인트와 톨러레이션, 그리고 노드가 꺼진 뒤의 시간표</summary>

> **핵심 한 줄**: 테인트는 노드에 붙는 "조건이 맞지 않는 Pod는 오지 말거나 나가라"는 표시이고 톨러레이션은 Pod가 지닌 "이 표시는 몇 초까지 견딘다"는 허가입니다.

#### 1. 세 가지 효과

| effect | 새 Pod 배치 | 이미 도는 Pod |
|---|---|---|
| `NoSchedule` | 막음 | 그대로 둠 |
| `PreferNoSchedule` | 되도록 피함 | 그대로 둠 |
| `NoExecute` | 막음 | 톨러레이션이 없으면 바로, 있으면 `tolerationSeconds` 뒤에 쫓아냄 |

노드 장애 때 붙는 `unreachable`과 `not-ready`는 `NoExecute`입니다. 그래서 이미 도는 Pod까지 정리 대상이 되고 Pod에 기본으로 들어간 300초 톨러레이션이 유예 시간이 됩니다.

#### 2. 노드가 꺼진 뒤 시간표

kubelet은 `kube-node-lease` 네임스페이스의 Lease 객체를 기본 10초마다 갱신해 살아 있다고 알립니다(Leases 문서). 이 갱신이 끊긴 순간을 0초로 잡으면 기본 설정에서 이렇게 흘러갑니다.

| 시각 | 일어나는 일 | 하는 쪽 |
|---|---|---|
| 0초 | 노드가 꺼져 Lease 갱신과 상태 보고가 멈춤 | (노드) |
| 약 50초 | 노드 Ready 조건이 `Unknown`, `unreachable:NoExecute` 테인트가 붙음 | node lifecycle 컨트롤러 |
| 약 350초 | 300초 톨러레이션이 끝나 그 노드의 Pod가 삭제 표시됨(`Terminating`) | taint-eviction 컨트롤러 |
| 그 직후 | 원하는 수보다 모자라니 새 Pod를 만들고 다른 노드에 배치 | ReplicaSet 컨트롤러, 스케줄러 |

꺼진 노드의 kubelet은 컨테이너를 정리했다고 보고할 수 없어서 옛 Pod는 노드가 돌아올 때까지 `Terminating`으로 남습니다. Deployment는 새 Pod를 따로 만들기 때문에 서비스는 이어집니다.

> **정리**: 노드 장애 뒤 Pod가 옮겨 가기까지의 약 6분은 "노드를 의심하는 50초"와 "Pod가 견디는 300초"를 더한 시간입니다. 어느 쪽이든 Pod 스펙의 `tolerationSeconds`나 컨트롤러 플래그로 줄일 수 있습니다.

</details>

```bash
kubectl get pod <Pod> -o jsonpath='{range .spec.tolerations[*]}{.key} {.effect} {.tolerationSeconds}{"\n"}{end}'
# node.kubernetes.io/not-ready NoExecute 300
# node.kubernetes.io/unreachable NoExecute 300
```

Pod 삭제는 별도의 taint-eviction 컨트롤러가 맡고(1.29 beta부터 기본 분리, 1.34 GA) 지워진 Pod를 다른 노드에 새로 만드는 쪽은 ReplicaSet 같은 워크로드 컨트롤러입니다. 둘 다 controller-manager 안에서 돌므로 controller-manager가 멈춘 동안에는 축출도 일어나지 않습니다. 주인 없는 단독 Pod는 다시 만들어지지 않습니다.

kind 워커 컨테이너를 `docker stop`으로 멈춰 잰 결과입니다. 약 45초 안에 노드가 `Unknown`이 되고 `unreachable` 테인트가 붙었습니다. 50초보다 짧은 것은 유예 시간이 멈춘 시각에서 세지 않고 마지막 Lease 갱신 시각에서 세기 때문입니다. 갱신이 10초 간격이라 멈추기 몇 초 전의 갱신이 기준이 됩니다. `tolerationSeconds: 30`을 준 Pod는 그 30초 뒤, 기본 Pod는 약 300초 뒤 `TaintManagerEviction`(`Marking for deletion Pod shop/web-...`) 이벤트와 함께 `Terminating`이 됐고 Deployment의 대체 Pod는 다른 워커에서 `Running`이 됐습니다. 노드가 돌아오지 않으면 옛 Pod는 `Terminating`에 남습니다.

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

<details>
<summary>기초부터: requests와 limits를 적는 자리와 단위</summary>

> **핵심 한 줄**: **requests**는 스케줄러가 자리를 잡을 때 쓰는 예약 값이고 **limits**는 커널이 집행하는 상한입니다.

#### 1. 왜 필요한가

노드 한 대에 Pod 여러 개가 함께 돌면 자원을 나눠 써야 합니다. 아무 표시가 없으면 두 가지 문제가 생깁니다.

| 표시가 없을 때 | 문제 | 막는 값 |
|---|---|---|
| 스케줄러가 Pod가 얼마나 쓸지 모름 | 이미 꽉 찬 노드에 또 배치될 수 있음 | requests |
| 한 Pod가 메모리를 다 먹음 | 막을 장치가 없음 | limits |

#### 2. 어떻게 동작하나

1. **requests(예약)**: "최소한 이만큼은 확보해 달라"는 값입니다. 스케줄러는 노드에 이미 배치된 Pod들의 requests 합과 노드의 할당 가능량(allocatable)을 비교해 들어갈 자리가 있는 노드만 고릅니다. 실제 사용량은 보지 않습니다.
2. **limits(상한)**: "이 이상은 쓰지 못하게 막아 달라"는 값입니다. kubelet이 런타임을 통해 리눅스 cgroup에 값을 적고 커널이 집행합니다.

```text
requests → kube-scheduler(노드 고르기)
limits   → kubelet → 컨테이너 런타임 → cgroup → 커널(집행)
```

#### 3. 적는 자리

```yaml
spec:
  containers:
  - name: web
    image: nginx:1.27
    resources:
      requests:
        cpu: "250m"       # 0.25 코어
        memory: "64Mi"
      limits:
        cpu: "500m"
        memory: "128Mi"
```

#### 4. 단위 비교

| 표기 | 뜻 |
|---|---|
| `cpu: 1` | CPU 코어 1개(가상 코어 1개) |
| `cpu: 250m` | 1000분의 250 코어. `0.25`와 같음 |
| `memory: 128Mi` | 128 × 1024 × 1024 바이트(이진 단위) |
| `memory: 128M` | 128 × 1000 × 1000 바이트(십진 단위). Mi보다 약간 작음 |

#### 5. 헷갈리는 점

- 메모리를 `128m`처럼 소문자 m으로 쓰면 "0.128 바이트"라는 뜻이 되어 엉뚱한 값이 들어갑니다.
- limits만 적고 requests를 비우면 requests는 limits와 같은 값으로 채워집니다.
- requests가 들어갈 노드가 하나도 없으면 Pod는 `Pending`에 머뭅니다. 공식 문서 "Resource Management for Pods and Containers"의 예시 이벤트는 `Warning  FailedScheduling  ...  default-scheduler  0/42 nodes available: insufficient cpu`입니다. 모든 노드가 `cpu: 1`인데 request가 `cpu: 1.1`이면 영원히 배치되지 않습니다.

> **정리**: 두 값을 어떻게 적느냐에 따라 Pod의 QoS 클래스(Guaranteed, Burstable, BestEffort)가 정해지고 노드 메모리가 모자랄 때 어느 Pod부터 축출할지가 여기서 갈립니다. 넘었을 때의 결과는 바로 아래 표에 있습니다.

</details>

| 값 | 누가 쓰는지 | 넘었을 때 |
|---|---|---|
| `requests` | 스케줄러가 노드를 고를 때. 노드에 배치된 requests 합이 allocatable 안이어야 함 | 사용량이 request를 넘는 것은 허용 |
| `limits.memory` | kubelet이 런타임을 거쳐 커널(cgroup)에 한도로 적음 | 커널이 컨테이너 프로세스를 SIGKILL로 종료(OOMKilled) |
| `limits.cpu` | 같은 경로로 커널에 CPU 시간 한도로 적음 | 종료되지 않고 실행이 지연(스로틀링) |

requests와 limits 조합이 정하는 QoS 클래스와 LimitRange, ResourceQuota는 [6편 5장](/blog/cert/cka/cka-03-workloads-scheduling)에 있습니다. cgroup 파일에 값이 어떻게 적히는지는 [cgroup과 QoS](/blog/theory/systems/k8s-linux-03-cgroup-qos)에서 다룹니다.

### 4-2. OOMKilled 재현과 describe에서 읽을 곳

<details>
<summary>기초부터: OOMKilled 뒤에서 커널이 하는 일</summary>

> **핵심 한 줄**: 컨테이너를 죽이는 것은 커널의 OOM killer이고 쿠버네티스는 그 결과를 `OOMKilled`라는 글자로 보여 줄 뿐입니다.

#### 1. 왜 알아야 하나

`describe`에는 `OOMKilled`와 137만 남습니다. 커널이 무엇을 보고 어떤 프로세스를 골랐는지는 노드의 커널 쪽에 남습니다. 한도만 올리고 끝내면 같은 장애가 트래픽이 조금 더 늘 때 다시 옵니다.

#### 2. 어떻게 동작하나

1. **한도 적기(컨테이너를 만들 때)**: kubelet이 CRI로 containerd에 한도를 넘기고 runc가 컨테이너의 cgroup `memory.max` 파일에 그 값을 씁니다. 한도를 넘는 순간에는 kubelet이 끼어들지 않습니다.
2. **넘었을 때(실행 중)**: 사용량이 `memory.max`에 닿으면 커널이 먼저 그 cgroup의 캐시를 회수해 봅니다. 회수해도 모자라면 그 cgroup 안에서 OOM killer가 프로세스를 골라 SIGKILL을 보냅니다.
3. **보고**: 런타임이 종료 사실을 받고 kubelet이 `Reason: OOMKilled`, `Exit Code: 137`로 적습니다.

```text
[생성 시] kubelet → containerd → runc → cgroup memory.max에 한도 기록
[실행 중] 사용량이 memory.max에 닿음 → 커널 회수 시도 → 실패 → OOM killer → SIGKILL(9)
[그 뒤]   런타임이 종료 수거 → kubelet이 OOMKilled, 137로 보고
```

SIGKILL은 프로세스가 잡거나 막거나 무시할 수 없는 시그널입니다(signal(7)). 그래서 애플리케이션은 정리 작업 없이 바로 끝납니다. 정상 종료 요청인 SIGTERM(15번, 받고 끝나면 종료 코드 143)과 다른 점입니다.

#### 3. 커널 로그에서 확인하기

```bash
sudo dmesg -T | grep -i oom | tail -5
```

cgroup 한도로 죽었다면 `Memory cgroup out of memory: Killed process <PID> (<이름>)` 형태의 줄이 남고 커널이 출력하는 프로세스 표에 각 프로세스의 `oom_score_adj`가 함께 찍힙니다.

#### 4. oom_score_adj: 누구부터 죽일지의 가중치

커널 문서 기준으로 `oom_score_adj`는 -1000부터 1000까지이고 -1000이면 OOM killer가 그 프로세스를 고르지 않습니다. 값이 클수록 먼저 고릅니다. kubelet은 Pod의 QoS 클래스에 따라 이 값을 컨테이너마다 정합니다(Node-pressure Eviction 문서).

| QoS 클래스 | kubelet이 주는 `oom_score_adj` |
|---|---|
| Guaranteed | -997 |
| Burstable | min(max(2, 1000 - 1000 × 메모리 request ÷ 노드 메모리 용량), 999) |
| BestEffort | 1000 |

#### 5. OOM이 일어나는 두 범위

| 범위 | 무엇이 모자랐나 | 영향 |
|---|---|---|
| cgroup OOM | 그 컨테이너의 `memory.max` | 그 컨테이너만 종료. 노드의 다른 Pod는 영향 없음 |
| 시스템 OOM | 노드 전체 메모리 | 노드 전체가 위험. 위 `oom_score_adj` 순서로 희생자를 고름 |

시스템 OOM까지 가기 전에 kubelet이 먼저 Pod를 축출하려고 하는 장치가 4-5절의 노드 압박 축출입니다.

#### 6. 장애 대응의 세 단계

| 단계 | 하는 일 | 한계 |
|---|---|---|
| 1. 증상 대응 | `kubectl describe`로 OOMKilled를 보고 limit만 올림 | 당장은 막지만 원인은 그대로 |
| 2. 근거 확인 | `dmesg`로 커널이 어떤 프로세스를 왜 골랐는지 확인 | 원인 후보가 좁혀짐 |
| 3. 구조적 해결 | cgroup 지표와 애플리케이션 메모리 사용 패턴을 함께 보고 설정과 코드의 어긋남을 고침 | 근본 원인 분석(RCA) |

> **정리**: `describe`의 `OOMKilled`와 137만 보고 한도를 올리면 증상만 막습니다. 커널이 고른 프로세스는 `dmesg`에, 희생 순서의 기준은 `oom_score_adj`에 있습니다. 아래 본문은 시험에서 이 결과를 `describe`로 읽는 법입니다.

</details>

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

`describe`는 `get`보다 조금 뒤에 친 출력이라 `Restart Count`가 하나 더 많습니다. 시험에서 확인할 곳은 `describe`의 `Last State`입니다. 컨테이너가 재시작해 지금 `Running`이어도 직전 종료 이유가 `Last State`에 남습니다. jsonpath로 뽑으면 이렇습니다.

```bash
kubectl get pod mem-over -o jsonpath='{.status.containerStatuses[0].lastState.terminated.reason} {.status.containerStatuses[0].lastState.terminated.exitCode}{"\n"}'
# OOMKilled 137
```

판단과 종료는 커널이 합니다. kubelet은 컨테이너를 만들 때 한도를 런타임에 넘기고 끝난 뒤 결과를 받아 `OOMKilled`로 보고합니다. 한도를 넘은 컨테이너는 커널이 메모리 압박을 감지할 때 종료됩니다(공식 문서 "Resource Management for Pods and Containers"). 노드의 커널 로그(`dmesg`)에는 `Memory cgroup out of memory: Killed process ...` 줄이 남습니다.

### 4-3. 137은 128 + 9

```
137 = 128 + 9 (SIGKILL)
```

셸과 컨테이너 런타임은 시그널 N으로 끝난 프로세스의 종료 코드를 128+N으로 적는 관례를 따릅니다(bash 매뉴얼의 EXIT STATUS). 그래서 128보다 큰 값이면 시그널로 끝났을 가능성이 높습니다. 프로세스가 직접 `exit(137)`을 불러도 같은 값이 나오므로 OOM 여부는 kubelet이 따로 적는 `Reason: OOMKilled`로 판단합니다. 자주 보는 값을 함께 적어 둡니다.

| Exit Code | 흔한 원인 | 같이 볼 것 |
|---|---|---|
| 0 | 정상 종료. `restartPolicy: Always`면 다시 시작되어 재시작 횟수가 늘어남 | `command`가 곧바로 끝나는지 |
| 1 | 애플리케이션 오류 | `kubectl logs -p` |
| 137 | SIGKILL. OOM이거나 종료 유예 시간(`terminationGracePeriodSeconds`, 기본 30초)을 넘김 | `Reason`이 `OOMKilled`인지 `Error`인지 |
| 143 | SIGTERM(128+15)으로 정상 종료 요청을 받고 끝남 | 삭제나 롤아웃 중이었는지 |

143과 137이 한 흐름에서 갈리는 경우가 있습니다. Pod를 지우면 kubelet은 먼저 SIGTERM을 보내고 유예 시간(기본 30초)을 기다립니다. 그 안에 프로세스가 스스로 끝나면 143이고 30초가 지나도 살아 있으면 kubelet이 SIGKILL을 보내 137이 됩니다(Pod Lifecycle 문서의 Termination of Pods). 그래서 137인데 Reason이 `OOMKilled`가 아니면 "종료 신호를 받고도 제때 안 끝난 앱"을 의심합니다.

### 4-4. 같은 Pod 안의 재시작과 CrashLoopBackOff

`restartPolicy`의 기본값은 `Always`라서 kubelet은 OOM으로 끝난 컨테이너를 같은 Pod 안에서 다시 시작합니다. Pod 오브젝트와 IP는 그대로입니다. 다시 250M을 잡으면 또 죽으므로 kubelet은 재시작 사이에 간격을 둡니다. 공식 문서 "Pod Lifecycle" 기준으로 간격은 10초에서 시작해 두 배씩 늘고 300초에서 멈춥니다. 컨테이너가 10분 동안 문제없이 돌면 간격이 초기화됩니다. 기다리는 동안의 상태가 `CrashLoopBackOff`이고 이벤트에는 이렇게 남습니다.

| 연속 실패 | 다음 시작까지 대기 |
|---|---|
| 1번째 | 10초 |
| 2번째 | 20초 |
| 3번째 | 40초 |
| 4번째 | 80초 |
| 5번째 | 160초 |
| 6번째부터 | 300초에서 멈춤 |

10분을 문제없이 돌면 대기 시간이 다시 10초부터 시작합니다. 이 기본값을 바꾸는 기능도 있습니다. `ReduceDefaultCrashLoopBackOffDecay`(1.33 알파, 기본 꺼짐)는 시작 1초, 최대 60초로 줄이고 `KubeletCrashLoopBackOffMax`(1.35 베타, 기본 켜짐)는 kubelet 설정으로 최대값을 바꿀 수 있게 합니다. 시험 클러스터에서 설정을 바꿨다는 안내는 없으니 표의 기본값을 기준으로 봅니다.

```
Warning   BackOff   pod/mem-over   Back-off restarting failed container stress in pod mem-over_default(...)
```

```bash
kubectl get events --field-selector involvedObject.name=mem-over --sort-by=.lastTimestamp
kubectl logs mem-over -p        # 직전에 죽은 컨테이너의 로그
```

limit을 실제 사용량에 맞게 올리거나 애플리케이션의 메모리 사용을 줄이면 해결됩니다. Deployment라면 `kubectl set resources deployment <이름> --limits=memory=256Mi`로 템플릿을 고칩니다.

### 4-5. 노드 메모리가 모자랄 때의 축출

노드 전체 메모리가 모자라면 kubelet이 Pod를 골라 축출합니다(리눅스 기본 hard 임계 `memory.available<100Mi`). 이때 Pod는 `Failed`와 `reason: Evicted`가 되고 노드 조건에 `MemoryPressure=True`가 뜹니다. kubelet은 사용량이 requests를 넘은 Pod를 먼저 보므로 requests가 없는 BestEffort Pod가 가장 먼저 대상이 되고 Guaranteed Pod는 마지막입니다.

kind 워커의 `/var/lib/kubelet/config.yaml`에 `evictionHard: memory.available: 9800Mi`(가용량보다 큰 값)를 넣고 kubelet을 재시작해 본 결과입니다.

```text
MemoryPressure  True  ...  KubeletHasInsufficientMemory  kubelet has insufficient memory available
Taints:         node.kubernetes.io/memory-pressure:NoSchedule
Warning  Evicted  pod/order-api-...  The node was low on resource: memory. Threshold quantity: 9800Mi, available: 9936872Ki. Container nginx was using 7076Ki, request is 0, has larger consumption of memory.
```

메시지의 숫자를 읽어 보면 축출 이유가 그대로 나옵니다. `available: 9936872Ki`를 1024로 나누면 약 9,704Mi이고 기준 `9800Mi`보다 작습니다. 그래서 kubelet은 노드가 메모리 압박 상태라고 판단했습니다. `request is 0`은 이 Pod에 메모리 request가 없다는 뜻이라 사용량이 request를 넘은 Pod로 분류되어 먼저 골랐습니다. 실제 메모리는 넉넉했고 기준값을 일부러 올려 만든 상황입니다.

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

<details>
<summary>기초부터: CPU limit을 커널이 집행하는 방식(cpu.max와 cpu.stat)</summary>

> **핵심 한 줄**: `limits.cpu`는 "주기마다 쓸 수 있는 CPU 시간"으로 cgroup `cpu.max`에 적히고 그 시간을 다 쓰면 커널이 다음 주기까지 실행을 세웁니다.

#### 1. 왜 까다로운가

| 메모리 limit 초과 | CPU limit 초과 |
|---|---|
| 컨테이너가 죽고 `OOMKilled`가 남음 | 죽지 않고 에러 로그도 없음 |
| 상태와 이벤트로 바로 보임 | 응답만 느려지고 노드 CPU는 여유 있어 보임 |

신호가 거의 없어서 "인프라는 멀쩡하니 애플리케이션 문제"로 잘못 넘기기 쉽습니다.

#### 2. 어떻게 동작하나

1. **값 적기**: kubelet이 런타임을 거쳐 `limits.cpu`를 `cpu.max`의 `쿼터 주기` 두 숫자로 적습니다. 주기는 kubelet 기본값 100ms(100000µs)입니다.
2. **쓰기**: 한 주기 안에서 그 cgroup의 모든 스레드가 쓴 CPU 시간이 쿼터에 닿을 때까지 실행합니다.
3. **세우기**: 쿼터를 다 쓰면 주기가 끝날 때까지 대기(스로틀)하고 다음 주기에 다시 받습니다.

```text
limits.cpu: 50m  →  cpu.max: "5000 100000"  (100ms마다 5ms)

|■■■■■|----------------------------------------------|
 5ms 실행         95ms 대기(throttled)
|<------------------ 한 주기 100ms ------------------>|
```

이 집행 기능의 커널 문서 이름은 "CFS Bandwidth Control"입니다. 다음에 실행할 태스크를 고르는 정책은 커널 6.6부터 CFS에서 EEVDF로 바뀌기 시작했지만 주기와 쿼터로 상한을 거는 방식은 그대로입니다.

#### 3. 노드에서 직접 보는 순서(시험 범위 밖)

```bash
sudo crictl ps --name <컨테이너 이름> -q                 # 컨테이너 ID
sudo crictl inspect <ID> | jq .info.pid                  # 호스트에서 보이는 PID(jq 필요)
cat /proc/<PID>/cgroup                                   # 0::/kubepods.slice/... 경로
cat /sys/fs/cgroup/<그 경로>/cpu.max                      # 쿼터와 주기
cat /sys/fs/cgroup/<그 경로>/cpu.stat                     # 스로틀 카운터
```

컨테이너 안에서 `ps`로 보면 같은 프로세스가 PID 1로 보입니다. PID 네임스페이스 때문에 안과 밖의 번호가 다르므로 cgroup을 찾을 때는 호스트 PID를 써야 합니다.

#### 4. cpu.stat 읽는 법

| 필드 | 뜻 |
|---|---|
| `nr_periods` | 실행할 태스크가 있었던 주기 수 |
| `nr_throttled` | 그중 쿼터를 다 써서 멈춘 주기 수 |
| `throttled_usec` | 멈춰 있던 시간 합계 |
| `usage_usec` | 실제로 CPU를 쓴 시간 합계 |

예시 값 `nr_periods 7359`, `nr_throttled 6449`, `usage_usec` 약 36.8초로 계산하면 이렇습니다.

- 스로틀 비율은 6449 ÷ 7359 ≈ 87.6%입니다. 주기 열 번 중 아홉 번 가까이 멈췄습니다.
- 지난 시간은 주기 수 × 100ms ≈ 735.9초이고 사용 비율은 36.8 ÷ 735.9 ≈ 5.0%입니다. 50m(1코어의 5%)와 맞습니다.
- `usage_usec`과 `throttled_usec`을 더해 지난 시간으로 쓰면 틀립니다. `throttled_usec`은 CPU별로 멈춘 시간을 합친 값이라 여러 CPU에서 돌면 실제 시간보다 커질 수 있습니다.

#### 5. 헷갈리는 점

- `kubectl top`은 최근 구간의 평균 사용률이라 `50m` 근처로 안정돼 보입니다. 머리가 천장에 닿아 있다는 것은 보여 주지만 몇 번 부딪혔는지는 알려 주지 않습니다.
- 운영에서는 노드마다 들어가 파일을 읽지 않습니다. kubelet에 들어 있는 cAdvisor가 이 카운터를 `container_cpu_cfs_periods_total`, `container_cpu_cfs_throttled_periods_total` 같은 메트릭으로 내놓고 Prometheus 같은 도구가 모읍니다. 대시보드의 스로틀 그래프도 출처는 커널의 `cpu.stat`입니다.

> **정리**: 스로틀 횟수는 `kubectl top`의 평균 사용률에는 드러나지 않고 `cpu.stat`의 `nr_throttled`나 cAdvisor 메트릭에 남습니다. 시험에서는 아래 본문처럼 사용량이 limit에 붙어 있는지로 판단합니다.

</details>

메모리는 넘으면 죽고 CPU는 넘으면 기다립니다. `limits.cpu: 50m`은 100ms마다 5ms까지 CPU를 쓸 수 있다는 한도로 커널에 적히고 그 시간을 다 쓰면 다음 주기까지 실행이 멈춥니다. 컨테이너는 종료되지 않고 에러 로그도 남기지 않으면서 응답만 느려집니다. 그래서 `describe`의 상태와 이벤트만으로는 잡히지 않습니다. 커널 쪽 설정 파일(`cpu.max`)과 스로틀 카운터(`cpu.stat`)는 [cgroup과 QoS](/blog/theory/systems/k8s-linux-03-cgroup-qos)에서 다룹니다.

### 5-2. kubectl top으로 볼 수 있는 것

<details>
<summary>기초부터: kubectl top 뒤의 metrics-server 경로</summary>

> **핵심 한 줄**: `kubectl top`은 API 서버의 Metrics API(`metrics.k8s.io`)를 조회하고 그 API를 채우는 것은 기본 설치에 없는 애드온 **metrics-server**입니다.

#### 1. 왜 알아야 하나

| 겉으로 보이는 모습 | 실제 동작 |
|---|---|
| kubectl이 직접 노드에 가서 재는 명령 같음 | API 서버의 Metrics API를 조회 |
| 어느 클러스터에서나 될 것 같음 | metrics-server가 없으면 kind나 kubeadm 기본 클러스터에서 `Metrics API not available` |

#### 2. 어떻게 동작하나

값이 모이는 경로는 이렇습니다(Resource metrics pipeline 문서 기준).

```text
컨테이너 런타임과 cgroup ─▶ kubelet의 /metrics/resource 엔드포인트
                               ▲
                               │ 기본 15초마다 수집
                         metrics-server (Deployment)
                               │ Metrics API로 등록(APIService)
                               ▼
                    kube-apiserver ◀── kubectl top, HPA
```

1. **kubelet이 내놓기**: 각 노드의 kubelet이 컨테이너별 CPU와 메모리 사용량을 엔드포인트로 내놓습니다.
2. **metrics-server가 긁기**: metrics-server가 모든 kubelet에서 이 값을 주기적으로 긁어 메모리에 들고 있습니다.
3. **API 서버가 넘기기**: API 서버는 `metrics.k8s.io` 요청을 metrics-server로 넘겨 줍니다. 이렇게 API를 다른 서버에 맡기는 장치를 **API 집계(aggregation)**라고 합니다.

#### 3. 한눈에 비교

| 구분 | metrics-server | Prometheus 같은 모니터링 |
|---|---|---|
| 들고 있는 값 | 최근 값만, 기록을 쌓지 않음 | 시간에 따른 기록 |
| 쓰임 | 자동 확장(HPA, VPA)과 `kubectl top` | 지난 한 시간의 그래프 같은 모니터링 |

metrics-server README에도 자동 확장용이니 모니터링 데이터 원천으로 쓰지 말라는 안내가 있습니다.

#### 4. 실전에서 보이는 모습

- metrics-server가 없으면 `kubectl top`이 `Metrics API not available`로 끝납니다.
- metrics-server가 kubelet에 HTTPS로 붙기 때문에 kubelet 서빙 인증서가 노드 IP를 담고 있지 않으면 수집이 실패합니다. 아래 kind 사례의 `--kubelet-insecure-tls`는 그 문제를 우회합니다.

> **정리**: metrics-server는 최근 값만 들고 있어 `kubectl top`으로 지난 기록은 볼 수 없고 kubelet 인증서 문제로 수집 자체가 막히기도 합니다. 아래 본문에서 이 경로가 없을 때와 있을 때의 출력을 봅니다.

</details>

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

`top`이 보여 주는 것은 사용량뿐입니다. 스로틀 횟수나 시간은 담지 않습니다. CPU 50m 한도의 무한 루프 컨테이너를 kind에서 돌렸을 때 `kubectl top pod`는 `51m`이었고 같은 시점 커널 카운터로는 주기의 약 92%가 스로틀되어 있었습니다. 사용량이 limit에 붙어 있으면 스로틀링을 의심하고 `kubectl describe pod`나 `-o jsonpath='{.spec.containers[*].resources}'`로 limit 값을 확인합니다. limit을 올리거나 지우면 풀립니다.

메모리 쪽 `top` 값은 working set이라 컨테이너 안의 `free` 숫자와 다르게 나올 수 있습니다. 출력을 읽는 법과 metrics-server가 없을 때의 점검은 [9편 3장](/blog/cert/cka/cka-06-troubleshooting)에 있습니다.

### 5-3. 직접 해 보기

metrics-server를 설치한 클러스터에서 `busybox:1.36` 이미지로 `while true; do :; done`을 도는 Pod를 CPU와 메모리 모두 requests와 limits를 같게(CPU `50m`, 메모리 `32Mi`) 띄웁니다. `kubectl top pod`가 50m 근처에 머무는지, `qosClass`가 `Guaranteed`인지 봅니다. `limits.cpu`를 `500m`으로 바꿔 다시 만들고 사용량이 어떻게 변하는지 비교합니다.

---

## 6. 이어지는 글

증상별로 처음 칠 명령은 3-3절 표에 모았고 시험 비중이 가장 큰 트러블슈팅(30%) 절차는 9편에서 이어집니다.

| 다음에 볼 것 | 글 |
|---|---|
| Pod, Deployment, Service가 API 서버를 거쳐 노드에 닿는 흐름과 kubectl 사용법 | [4편](/blog/cert/cka/cka-01b-core-objects-and-flow) |
| kubeadm 설치, 업그레이드, etcd, 인증서 | [5편](/blog/cert/cka/cka-02-cluster-architecture) |
| requests, limits, QoS, LimitRange | [6편](/blog/cert/cka/cka-03-workloads-scheduling) |
| 증상별 트러블슈팅 절차 | [9편](/blog/cert/cka/cka-06-troubleshooting) |
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

kube-scheduler입니다. 스케줄러가 돌고 있는데 자원이 모자라거나 taint에 걸렸다면 `FailedScheduling` 이벤트가 남습니다. 이벤트조차 없으면 스케줄러가 Pod를 보지 못하고 있습니다. `kubectl -n kube-system get pods`로 scheduler Pod를 보고 컨트롤 플레인 노드의 `/etc/kubernetes/manifests/kube-scheduler.yaml`과 `crictl logs`를 확인합니다.

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
- `--node-monitor-grace-period` 기본값 50초와 taint-eviction 컨트롤러 분리(1.29 beta 기본 활성, 1.34 GA)는 버전에 따라 달라진 항목입니다.

## 참고 자료

- Objects In Kubernetes: https://kubernetes.io/docs/concepts/overview/working-with-objects/
- Controllers: https://kubernetes.io/docs/concepts/architecture/controller/
- Kubernetes Components: https://kubernetes.io/docs/concepts/overview/components/
- Create static Pods: https://kubernetes.io/docs/tasks/configure-pod-container/static-pod/
- Troubleshooting Clusters: https://kubernetes.io/docs/tasks/debug/debug-cluster/
- Leases: https://kubernetes.io/docs/concepts/architecture/leases/
- Static Pods: https://kubernetes.io/docs/concepts/workloads/pods/static-pods/
- Taints and Tolerations: https://kubernetes.io/docs/concepts/scheduling-eviction/taint-and-toleration/
- Container Runtime Interface: https://kubernetes.io/docs/concepts/containers/cri/
- Resource Management for Pods and Containers: https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/
- Assign Memory Resources to Containers and Pods: https://kubernetes.io/docs/tasks/configure-pod-container/assign-memory-resource/
- Pod Quality of Service Classes: https://kubernetes.io/docs/concepts/workloads/pods/pod-qos/
- Node-pressure Eviction: https://kubernetes.io/docs/concepts/scheduling-eviction/node-pressure-eviction/
- Pod Lifecycle(컨테이너 재시작 백오프): https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/
- Resource metrics pipeline: https://kubernetes.io/docs/tasks/debug/debug-cluster/resource-metrics-pipeline/
- bash(1) EXIT STATUS: https://man7.org/linux/man-pages/man1/bash.1.html
- CKA 커리큘럼 v1.37: https://github.com/cncf/curriculum/blob/master/CKA_Curriculum_v1.37.pdf

---
title: '[CKA Ch-00] CKA 시험 구조와 공부 계획: 2025년 개정 뒤의 범위로 준비하기'
description: CKA는 2시간 동안 터미널에서 15~20개 과제를 푸는 실기 시험이고 66% 이상이면 합격입니다. 커리큘럼 v1.37의 다섯 영역과 2025년 2월 개정으로 바뀐 범위, 과제마다 ssh로 호스트를 옮기는 시험 환경과 허용 문서, 덤프를 쓰지 않은 후기에서 겹친 경향을 공식 문서로 확인하고 이 시리즈(Ch-01~08)를 따라가는 공부 계획을 세웁니다.
date: 2026-10-19T00:00:00.000Z
tags:
  - CKA
  - Kubernetes
  - Certification
  - Study Plan
category: cert/CKA
topics:
  - cert
draft: false
series: "CKA 공부"
seriesOrder: 0
---

## 결론부터

1. CKA는 2시간 동안 15~20개의 실기 과제를 푸는 시험입니다. 답을 고르는 문제가 없고 리눅스 명령줄에서 클러스터를 직접 고칩니다. 66% 이상이면 합격이고 기준 버전은 Kubernetes v1.37입니다.
2. 2025년 2월 18일부터 범위가 바뀌었습니다. 개정 전 커리큘럼(v1.31)과 대조하면 etcd 백업과 복구, kubeadm 버전 업그레이드가 명시 항목에서 빠지고 Helm, Kustomize, Gateway API, CRD와 오퍼레이터, 확장 인터페이스(CNI, CSI, CRI)가 들어왔습니다. 개정 전 강의와 후기는 걸러서 봅니다.
3. 비중이 가장 큰 영역은 트러블슈팅(30%)이고 그다음이 클러스터 아키텍처·설치·구성(25%)입니다. 후기들이 공통으로 꼽는 실패 원인은 시간 부족과 트러블슈팅에서 시간을 잃은 것입니다.
4. 시험은 과제마다 지정된 호스트에 `ssh`로 들어가 풀고 `exit`로 돌아오는 방식입니다. 각 호스트에는 `kubectl`(alias `k`와 자동완성), `yq`, `curl`, `wget`, `man`이 깔려 있고 열 수 있는 문서는 kubernetes.io/docs, kubernetes.io/blog, helm.sh/docs, gateway-api.sigs.k8s.io 네 곳입니다.
5. 공부는 이 시리즈 순서를 따릅니다. Ch-01과 Ch-01.5로 구조를 잡고 Ch-02~06에서 영역별 명령과 YAML을 손에 익힌 뒤 Ch-07의 연습 자료와 killer.sh 2회로 시간을 맞추고 Ch-08로 마무리합니다.

---

## 1. 시험 구조

Linux Foundation(LF) 공식 페이지와 응시 안내 문서로 확인한 내용입니다(2026년 10월 기준).

| 항목 | 내용 |
|---|---|
| 형식 | 온라인 감독, 리눅스 명령줄에서 푸는 실기 과제 15~20개 |
| 시간 | 2시간 |
| 합격 | 66% 이상(LF FAQ, 2026-10-15 갱신판). 2025년 개정 때 74%로 올랐다는 글이 있지만 LF FAQ와 다르다 |
| 기준 버전 | Kubernetes v1.37(2026-08-26 출시). LF 문서는 새 마이너 버전 출시 후 "approximately 4 to 8 weeks" 안에 시험 환경을 맞춘다고 적는다. 실제 안내문 표기는 더 늦을 때가 있었고(1.33은 10주 이상) 1.36은 표기된 적 없이 1.35에서 1.37로 넘어갔다. 1.37 표기는 2026-10-15 갱신된 안내문부터다. 다음 v1.38은 2026-12-16 출시 예정(sig-release 일정)이라 2027년 1~2월 응시자는 Important Instructions의 버전을 다시 본다 |
| 가격 | $445(2025-02-04부터), 재응시 1회 포함(최초 구매일로부터 12개월 안). 결시하면 응시료와 재응시 자격을 모두 잃는다 |
| 시뮬레이터 | killer.sh 2회(활성화 후 각 36시간, 세션당 17문항). 단일 등록 상품(CKA-SINGLE)에는 없다 |
| 유효 기간 | 2년(2024-04-01 이전 취득은 3년). 2026년 6월 18일부터 CKS에 합격하거나 갱신하면 CKA도 연장되고 이미 만료된 CKA는 복원된다(CARE 확장) |
| 결과 | 자동 채점, 시험 종료 후 24시간 안에 이메일 |
| 일정 | 구매 후 12개월 안에 응시. 예약은 최소 24시간 전, 변경과 취소도 24시간 전까지 |

채점은 클러스터의 최종 상태를 봅니다. 응시자 핸드북은 과제를 푸는 방법이 여럿일 수 있다고 적고 문항별 배점과 성적은 공개하지 않습니다. 하위 과제별 부분 점수는 killer.sh FAQ가 설명하는 방식이고 LF FAQ에는 부분 점수에 대한 언급이 없습니다.

<details>
<summary>기초부터: 실기 과제 하나는 어떤 모양인가</summary>

> **핵심 한 줄**: 실기 과제는 "이 호스트에 들어가서 클러스터를 이 상태로 만들어라"라는 지시이고 채점기는 내가 친 명령을 보지 않고 **끝났을 때 클러스터에 남은 상태**를 봅니다.

#### 1. 객관식 시험과 무엇이 다른가

객관식 시험은 답을 아는지 묻습니다. CKA는 답을 손으로 만들 수 있는지 묻습니다. 그래서 개념을 알아도 명령을 치는 속도가 느리면 점수가 나오지 않습니다. 후기들이 시간 부족을 첫 어려움으로 꼽는 이유가 여기에 있습니다(4절).

#### 2. 과제 하나를 푸는 흐름

아래 과제는 흐름을 보이려고 제가 만든 예시이고 실제 출제 문항과는 상관이 없습니다.

```text
과제: 호스트 node-a에서 작업한다. 네임스페이스 shop에 Deployment web을 만든다.
      이미지는 nginx:1.27, 복제본은 3개. 이 Deployment를 포트 80의 ClusterIP Service web으로 노출한다.
```

| 순서 | 하는 일 | 치는 것(예) |
|---|---|---|
| 1 | 지시된 호스트로 이동 | `ssh node-a` |
| 2 | 뼈대 만들기 | `k create deployment web --image=nginx:1.27 --replicas=3 -n shop` |
| 3 | 노출 | `k expose deployment web --port=80 -n shop` |
| 4 | 확인 | `k get deploy,svc,endpointslices -n shop` |
| 5 | 시작 호스트로 복귀 | `exit` |

네임스페이스 `shop`이 없다면 2번 전에 만들어야 합니다. 4번은 건너뛰기 쉬운데 채점은 최종 상태로 하니 확인이 곧 점수 확인입니다. 이름 하나, 네임스페이스 하나만 틀려도 채점기는 그 객체를 찾지 못합니다.

#### 3. 시간 계산

2시간은 120분이고 과제가 15~20개면 과제당 6~8분입니다. 위 예시처럼 명령 몇 줄로 끝나는 과제에서 시간을 벌어 두어야 트러블슈팅처럼 원인을 찾아야 하는 과제에 10분 넘게 쓸 수 있습니다.

> **정리**: 과제는 "호스트 이동, 만들기, 확인, 복귀"의 반복입니다. 채점은 남은 상태로 하므로 이름과 네임스페이스를 지시문과 한 글자씩 맞추고 확인 명령까지 쳐야 끝납니다.

</details>

## 2. 영역과 범위

### 2-1. 영역별 비중과 세부 항목

[cncf/curriculum 저장소의 v1.37 커리큘럼](https://github.com/cncf/curriculum/blob/master/CKA_Curriculum_v1.37.pdf) 원문입니다. v1.33부터 v1.37까지 역량 문구는 같고 버전 숫자만 바뀌었습니다. v1.37 PDF는 v1.35 PDF의 파일 이름만 바꾼 것입니다(cncf/curriculum 커밋 b3c8508, 2026-10-15). 오른쪽 열은 이 시리즈에서 그 영역을 다루는 글입니다.

| 영역 | 비중 | 세부 항목 | 이 시리즈 |
|---|---|---|---|
| Troubleshooting | 30% | 클러스터와 노드, 클러스터 구성요소, 리소스 사용량 모니터링, 컨테이너 출력 스트림, 서비스와 네트워킹 트러블슈팅 | [Ch-06](/blog/cert/cka/cka-06-troubleshooting) |
| Cluster Architecture, Installation and Configuration | 25% | RBAC, 기반 인프라 준비, kubeadm으로 클러스터 생성과 관리, 클러스터 수명주기 관리, 고가용성 컨트롤 플레인, Helm과 Kustomize로 구성요소 설치, 확장 인터페이스(CNI, CSI, CRI), CRD와 오퍼레이터 | [Ch-02](/blog/cert/cka/cka-02-cluster-architecture) |
| Services and Networking | 20% | Pod 간 연결, NetworkPolicy, ClusterIP·NodePort·LoadBalancer와 엔드포인트, Gateway API, Ingress 컨트롤러와 리소스, CoreDNS | [Ch-04](/blog/cert/cka/cka-04-services-networking) |
| Workloads and Scheduling | 15% | 롤링 업데이트와 롤백, ConfigMap과 Secret, 워크로드 자동 확장, 자가 치유 기본 요소, Pod 승인과 스케줄링(리소스 제한, 노드 어피니티 등) | [Ch-03](/blog/cert/cka/cka-03-workloads-scheduling) |
| Storage | 10% | StorageClass와 동적 프로비저닝, 볼륨 타입·접근 모드·회수 정책, PV와 PVC | [Ch-05](/blog/cert/cka/cka-05-storage) |

PDF의 네트워크 영역 제목은 "Servicing and Networking"으로 적혀 있고 LF 시험 페이지는 "Services & Networking"으로 씁니다. LF 시험 페이지의 커리큘럼 링크는 2026년 10월 현재 v1.35 PDF를 가리키지만 문구가 같아 실질 차이는 없습니다.

### 2-2. 2025년 2월 개정에서 바뀐 것

LF는 개정 시행을 2025년 2월 18일 0시(UTC)로 공지했고 기준은 응시일입니다. 개정 전 커리큘럼(v1.31)과 문구를 대조한 결과입니다.

| 빠지거나 바뀐 문구 | 새로 들어온 항목 |
|---|---|
| etcd 백업과 복구 | Helm과 Kustomize로 구성요소 설치 |
| kubeadm으로 버전 업그레이드 | CRD와 오퍼레이터 |
| 노드의 호스트 네트워킹 설정 이해 | 확장 인터페이스(CNI, CSI, CRI) |
| CNI 플러그인 선택 | Gateway API |
| 매니페스트 관리와 템플릿 도구 인식 | NetworkPolicy 정의와 적용 |
| 애플리케이션 확장 방법, 클러스터·노드 로깅 평가, 애플리케이션 모니터링 | 워크로드 자동 확장, Pod 승인 |
| 스토리지 문구의 volume mode | 동적 볼륨 프로비저닝 |
| 고가용성 클러스터 관리(Manage a highly-available Kubernetes cluster) | 고가용성 컨트롤 플레인 구현과 구성(왼쪽 옛 문구를 구체화한 것) |

etcd와 kubeadm 업그레이드는 명시 문구에서 빠졌지만 "클러스터 수명주기 관리"와 HA 항목에 걸리고 kubernetes.io에 태스크 문서로 남아 있습니다. 후기도 갈립니다. Cassisi(2026)는 실러버스에서 빠졌다고 판단했고 Juikar(2026)는 etcd 명령과 kubeadm 플래그에서 시간을 썼다고 적었습니다. 그래서 이 시리즈는 두 절차를 함정 위주로 짧게 남겼습니다([Ch-02 4장](/blog/cert/cka/cka-02-cluster-architecture)).

도구도 바뀌었습니다. etcd 3.6부터 `etcdctl snapshot status`와 `snapshot restore`가 제거되어 확인과 복구는 `etcdutl`로 합니다. kubeadm 1.37이 기본으로 쓰는 etcd는 3.7.0이고(release-1.37 `constants.go`의 `DefaultEtcdVersion`, 1.36은 3.6.8) 둘 다 3.6 이후입니다. `ETCDCTL_API=3`을 붙이던 옛 강의 명령은 그대로 외우지 않습니다. 개정 전 Important Instructions에 있던 "The CKA environment is currently running etcd v3.5." 줄은 2025년 11월 판부터 없습니다.

<details>
<summary>기초부터: 개정으로 들어온 단어를 한 줄씩</summary>

> **핵심 한 줄**: 새로 들어온 항목은 대부분 "클러스터에 무엇을 더 얹고 어떻게 넓히는가"에 관한 것입니다. 이름만 낯설고 하는 일은 한 줄로 설명됩니다.

| 단어 | 한 줄 뜻 | 쇼핑몰로 보면 | 다루는 곳 |
|---|---|---|---|
| Helm | 여러 YAML을 묶은 패키지(차트)를 값만 바꿔 설치하고 올리는 도구 | 결제 모듈 하나를 설치 마법사로 까는 일 | [Ch-02](/blog/cert/cka/cka-02-cluster-architecture) |
| Kustomize | 원본 YAML은 두고 환경별 차이만 덧씌우는 도구. `kubectl apply -k`에 들어 있음 | 같은 상품 API를 개발용은 복제본 1개, 운영용은 3개로 | [Ch-02](/blog/cert/cka/cka-02-cluster-architecture) |
| Gateway API | 바깥 HTTP 요청을 Service로 잇는 새 방식. Ingress의 후속 | `shop.example.com/cart`는 장바구니 Service로 | [Ch-04](/blog/cert/cka/cka-04-services-networking) |
| CRD | 쿠버네티스에 없는 종류(kind)를 새로 등록하는 정의 | `kind: Coupon` 같은 객체를 만들 수 있게 함 | [Ch-02](/blog/cert/cka/cka-02-cluster-architecture) |
| 오퍼레이터 | CRD로 만든 객체를 보고 실제 작업을 하는 컨트롤러 | Coupon 객체가 생기면 만료 처리까지 맡는 프로그램 | [Ch-02](/blog/cert/cka/cka-02-cluster-architecture) |
| CRI, CNI, CSI | 컨테이너, 네트워크, 디스크 일을 외부 플러그인에 맡길 때 쓰는 약속. CRI와 CSI는 kubelet이 부르고 CNI는 컨테이너 런타임이 Pod 샌드박스를 만들 때 부름 | 런타임은 containerd, 네트워크는 Calico처럼 갈아 끼움 | [Ch-02 7장](/blog/cert/cka/cka-02-cluster-architecture#7-확장-인터페이스-cni-csi-cri) |
| HPA | 사용량을 보고 Pod 수를 늘리고 줄이는 자동 확장 | 할인 행사 때 주문 API Pod를 3개에서 10개로 | [Ch-03](/blog/cert/cka/cka-03-workloads-scheduling) |
| etcd | 클러스터의 모든 객체가 저장되는 키-값 저장소 | 주문 장부 원본 | [Ch-01.5](/blog/cert/cka/cka-01b-core-objects-and-flow) |

`etcdctl`과 `etcdutl`은 이름이 한 글자 차이라 헷갈립니다. `etcdctl`은 돌고 있는 etcd 서버에 네트워크로 붙어 묻는 클라이언트이고 `etcdutl`은 서버 없이 etcd 데이터 파일을 직접 다루는 관리 도구입니다([etcd 문서](https://etcd.io/docs/v3.6/op-guide/recovery/)). 스냅숏을 뜨는 일은 서버에 물어야 하니 `etcdctl snapshot save`이고 받아 둔 파일을 확인하고 풀어 놓는 일은 파일 작업이니 `etcdutl snapshot status`, `etcdutl snapshot restore`입니다.

> **정리**: 단어가 낯설어도 하는 일은 "패키지 설치(Helm), 환경별 덧씌우기(Kustomize), 바깥 문(Gateway API), 새 종류 등록(CRD), 그 종류를 돌보는 프로그램(오퍼레이터), 플러그인 약속(CRI·CNI·CSI)"입니다.

</details>

## 3. 시험 환경과 규칙

공부할 때부터 시험 환경에 맞춰 연습해야 해서 따로 정리합니다. 출처는 LF의 Important Instructions: CKA and CKAD, Resources Allowed, ExamUI 문서입니다.

### 3-1. 화면과 조작

| 항목 | 공식 안내 |
|---|---|
| 플랫폼 | PSI Secure Browser(Bridge). 모니터 1대만(듀얼 모니터 불가), 15인치 이상과 1080p 권장. 가상 머신 안에서 응시 불가 |
| 화면 | 문제 콘솔과 리눅스 원격 데스크톱으로 나뉜다. 원격 데스크톱 안에 터미널, Firefox(허용 문서용), VSCodium(확장 설치 금지, 내장 터미널은 사용 가능)이 있다 |
| 복사·붙여넣기 | 터미널은 Ctrl+Shift+C / Ctrl+Shift+V |
| 금지 키 | Ctrl+W는 브라우저 탭을 닫으니 Ctrl+Alt+W. INSERT 키는 금지라 vi에서는 `i`로 입력 모드 |
| 시간 알림 | 30분, 15분, 5분 남았을 때. 연결이 끊겨도 타이머는 멈추지 않는다 |

### 3-2. 과제마다 다른 호스트

공식 안내는 각 과제를 지정된 호스트에서 풀라고 적습니다. `ssh <노드 이름>`으로 들어가고 ssh 안에서 다시 ssh는 할 수 없으며 끝나면 `exit`로 시작 호스트(base)로 돌아옵니다. base 노드는 재부팅하면 안 됩니다. 권한이 필요하면 `sudo -i`나 명령마다 `sudo`를 씁니다. 공식 문구는 ssh 호스트의 kubectl이 미리 설정되어 있다고 적지만 kubectl에 sudo가 필요한지는 적지 않습니다.

| 도구 | 공식 안내 기준 |
|---|---|
| `kubectl`(alias `k`, bash 자동완성 설정됨), `yq`, `curl`, `wget`, `man` | 모든 ssh 호스트에 "pre-installed and pre-configured". base 호스트에는 없음 |
| `jq`, `tmux` | 2025-02-11 판까지 목록에 있었고 2025-03-28 판부터 빠졌다. `jq` 자리는 `yq`로 바뀌었다 |
| `helm`, `etcdctl` | 목록에 없음. Resources Allowed가 패키지 설치는 과제 수행에 필요하지 않다고 적으니 해당 과제가 나오는 호스트에는 있을 가능성이 높다 |
| `etcdutl`, `crictl`, 단독 `kustomize` | 목록에 없고 후기로도 확인되지 않음. 쓰기 전에 `which`로 본다 |
| `kubectl apply -k`, `kubectl kustomize` | kubectl에 내장 |

Resources Allowed는 배포판 패키지를 필요하면 설치해도 된다고 적지만 설치에도 시간이 듭니다. 그래서 이 시리즈의 예시는 `jq` 대신 `-o jsonpath`나 `yq`를 우선합니다.

후기 두 편(Cassisi 2026, Suzuki 2026)이 같은 점을 짚었습니다. 노드를 옮기면 직접 만든 alias가 사라지고 네임스페이스나 컨텍스트 전환용 alias 같은 옛 팁은 필요 없다는 것입니다. `k`는 이미 있으니 다른 설정을 외우는 데 시간을 쓰지 않아도 됩니다.

<details>
<summary>기초부터: base 호스트, ssh 호스트, kubeconfig가 어떻게 이어지나</summary>

> **핵심 한 줄**: 시험 터미널이 처음 열리는 곳이 base 호스트이고 과제마다 지정된 호스트로 `ssh`해서 들어가면 그 호스트의 kubectl이 그 과제의 클러스터를 가리키도록 미리 설정되어 있습니다.

#### 1. 흐름

```text
base 호스트(시작 터미널, kubectl 없음)
  ├─ ssh node-a ──▶ node-a의 kubectl ──▶ 과제 1의 클러스터
  │   exit ◀─────────────────────────────┘
  ├─ ssh node-b ──▶ node-b의 kubectl ──▶ 과제 2의 클러스터
  │   exit
  ...
```

호스트 이름 `node-a`, `node-b`는 설명용입니다. 실제 이름은 과제 지문에 적혀 있습니다.

#### 2. kubeconfig와 컨텍스트

kubectl은 `~/.kube/config` 파일(kubeconfig)을 읽고 어느 클러스터에 누구로 접속할지 정합니다. 파일 안에는 세 가지 목록이 있습니다.

| 칸 | 담는 것 |
|---|---|
| clusters | API 서버 주소와 그 서버의 CA 인증서 |
| users | 접속할 때 내밀 자격 증명(클라이언트 인증서나 토큰) |
| contexts | "이 cluster에 이 user로" 짝을 지은 이름. 지금 쓰는 짝이 `current-context` |

과제 호스트마다 이 파일이 미리 맞춰져 있으니 호스트만 제대로 옮기면 컨텍스트를 따로 바꿀 일이 없다는 것이 공식 안내가 적은 방식입니다. 파일 구조는 [Ch-02 1-10절](/blog/cert/cka/cka-02-cluster-architecture#1-10-kubeconfig-파일-구조)에 있습니다.

#### 3. alias가 사라지는 이유

alias는 셸 하나에만 걸리는 설정입니다. base 호스트에서 `alias kn=...`을 만들어도 `ssh`로 다른 기계에 들어가면 그 기계에서 새 셸이 뜨고 그 기계의 설정 파일만 읽습니다. 그래서 base에서 만든 alias는 따라가지 않습니다. 과제 호스트에는 `k`와 자동완성이 이미 설정되어 있으니 그대로 씁니다.

> **정리**: 과제를 읽으면 호스트 이름부터 보고 `ssh`로 옮긴 뒤 풀고 `exit`로 돌아옵니다. 엉뚱한 호스트에서 푼 과제는 다른 클러스터에 적용되어 점수가 나오지 않습니다.

</details>

### 3-3. 볼 수 있는 문서

| 허용 | 비고 |
|---|---|
| kubernetes.io/docs, kubernetes.io/blog | 사이트 안 검색은 되지만 외부 검색 결과는 열면 안 된다 |
| helm.sh/docs | |
| gateway-api.sigs.k8s.io | CKA만 |
| 과제마다 표시되는 Quick Reference 상자의 링크 | |
| /usr/share 아래 문서, man 페이지 | Important Instructions가 각 ssh 호스트에 `man`과 man 페이지가 있다고 적는다 |

문서는 시험 VM 안의 Firefox로만 엽니다. 번역 문서도 허용되지만 LF는 영어판을 권합니다. Suzuki는 브라우저가 문서 페이지로 자동으로 열리지 않아 URL을 외워 두라고 했습니다. 시험 동사(install, upgrade, configure, troubleshoot)와 직접 맞닿아 미리 위치를 익혀 둘 페이지는 이렇습니다. 경로는 모두 `https://kubernetes.io` 아래입니다.

| 주제 | 경로 |
|---|---|
| kubectl 명령 모음 | /docs/reference/kubectl/quick-reference/ |
| 설치 사전 준비(sysctl, containerd 설정) | /docs/setup/production-environment/container-runtimes/ |
| kubeadm 업그레이드 | /docs/tasks/administer-cluster/kubeadm/kubeadm-upgrade/ |
| etcd 백업·복구 | /docs/tasks/administer-cluster/configure-upgrade-etcd/ |
| 인증서 관리 | /docs/tasks/administer-cluster/kubeadm/kubeadm-certs/ |
| Kustomize | /docs/tasks/manage-kubernetes-objects/kustomization/ |
| HPA 워크스루 | /docs/tasks/run-application/horizontal-pod-autoscale-walkthrough/ |
| NetworkPolicy | /docs/concepts/services-networking/network-policies/ |
| Gateway API | /docs/concepts/services-networking/gateway/ 와 gateway-api.sigs.k8s.io의 HTTP routing, TLS 가이드 |
| PV를 쓰는 Pod | /docs/tutorials/configuration/configure-persistent-volume-storage/ (2026년 3월 Tasks에서 Tutorials > Configuration 아래로 옮겨짐) |
| Service와 DNS 점검 | /docs/tasks/debug/debug-application/debug-service/, /docs/tasks/administer-cluster/dns-debugging-resolution/ |

### 3-4. 신분증과 당일

- 유효기간이 남은 정부 발급 원본 실물 신분증이어야 하고 사본, 전자, 임시 신분증은 안 됩니다. 신분증의 이름과 등록한 이름이 정확히 같아야 하고 신분증 이름이 한국어면 그 문자도 함께 적습니다.
- 시작 30분 전부터 체크인할 수 있고 예정 시각에서 30분이 지나도록 시작하지 않으면 결시 처리됩니다. 결시는 환불도 재응시도 없습니다.
- 메모, 문제를 소리 내어 읽기, 얼굴과 입을 가리는 것, 음식은 금지입니다. 투명한 용기에 담은 투명한 음료만 됩니다.

점검표와 당일 순서는 [Ch-07 6절](/blog/cert/cka/cka-07-resources-and-exam-day)에 있습니다.

## 4. 응시자들의 후기에서 공통으로 나온 것

개정 뒤에 응시했고 덤프나 "실제 시험 문제"를 내건 자료를 썼다는 언급이 없으며 문항을 옮겨 적지 않은 후기만 골랐습니다. 출제 내용은 주제 수준으로만 옮깁니다.

| 글 | 결과 | 준비 | 남긴 말 |
|---|---|---|---|
| Matt Bargenquast(2025-02, 베타 응시) | 글에 없음 | 글에 없음(CKS와 함께 응시) | 개정 CKA는 CKS보다 시간 압박이 커서 몇 문항을 남겼다. 문서 예시를 그대로 베끼는 문제보다 응용 문제가 많았다 |
| Nattapol(2025-06) | 78% | Udemy/KodeKloud, killer.sh, 공식 문서 | 새 주제로 HPA·VPA, Gateway API, CNI·CRI·CRD·Helm·Kustomize 설치. VPA는 문서가 적어 `kubectl explain`이 도움. 준비 못 한 2문항은 건너뜀 |
| 최민석(2025-07) | 합격 | Udemy, killer.sh, Killercoda, 책 3권, 직접 운영한 클러스터 | 2시간이 넉넉하지 않다. 30분 남았을 때 마지막 문제를 버리고 전체를 다시 봤다 |
| yu-min, Zenn(2025-10) | 1차 58%, 2차 69% | KodeKloud 강의·랩·모의고사, killer.sh | 체크인이 여러 번 실패해 시작이 늦었다. 조작마다 2~3초 지연 |
| Atsushi Suzuki(2026-01) | 72%, v1.34 | KodeKloud 모의고사, killer.sh | 시간 안에 다 풀지 못했고 표시해 둔 트러블슈팅 문제로 돌아가지 못했다. 네임스페이스 전환 alias 같은 옛 팁은 불필요 |
| Talha Juikar(2026-01) | 합격(점수 미기재) | KodeKloud 강의와 랩, Killercoda, killer.sh, VM의 kubeadm 클러스터 | 트러블슈팅, 인증서·kubeconfig, etcd 명령과 kubeadm 플래그에서 시간이 들었다. killer.sh가 실제보다 어렵다. Hard Way는 선택 |
| cnative_tkb, Zenn(2026-05) | 점수 비공개 | kubernetes.io, Killercoda, killer.sh, Udemy | 공식 문서가 가장 중요한 자료. 외장 키보드면 입력기 전환을 미리 확인 |
| Domenic Cassisi(2026-06) | 95% | KodeKloud, Killercoda, Kubernetes The Hard Way, killer.sh | 어려움은 주제 전환과 시간. 복잡한 리눅스 명령은 필요 없었다. `kubectl explain`을 두 번 이상 썼다 |
| 109x79m, Qiita(2026-07) | 69% | Udemy, killer.sh, 『Kubernetes完全ガイド』 | 16문항 중 5~6개가 어려웠고 1개는 못 풀었다. 쉬운 것부터 풀었다 |
| yltw27, dev.to(2026) | 결과 대기 | Udemy, killer.sh | 가장 큰 병목은 터미널 속도. 첫 killer.sh가 16/75. 컨트롤 플레인 명령이 오래 걸리면 다른 탭에 두고 다음 작업 |

표에서 겹치는 것을 추리면 다섯 가지입니다. 주제별 경향은 [Ch-07 5절](/blog/cert/cka/cka-07-resources-and-exam-day)에 모았습니다.

- **시간**: 10편 중 대부분이 시간 부족이나 문제 전환 비용을 첫 어려움으로 꼽았습니다. 공식 기준 2시간에 15~20문항이면 문항당 6~8분입니다. 어려운 문제는 표시하고 넘긴 뒤 마지막에 돌아갑니다.
- **실제로 시간이 든 주제**: 트러블슈팅(컨트롤 플레인 구성요소, kubelet, 인증서와 kubeconfig)과 개정으로 들어온 Helm, Kustomize, Gateway API, CRD, CNI 설치입니다.
- **필요 없던 깊이**: Kubernetes The Hard Way 전 과정, 복잡한 리눅스 명령, 직접 만든 alias 모음입니다. 커널 내부를 언급한 후기는 없었습니다.
- **`kubectl explain`**: VPA나 CRD처럼 kubernetes.io에 예시가 적은 리소스에서 특히 자주 나옵니다.
- **killer.sh 점수**: 실제보다 어렵다는 평이 많았고 killer.sh FAQ도 점수를 합격 예측으로 쓰지 말라고 합니다. 풀이를 보고 배우는 용도로 씁니다.

## 5. 내 공부 계획

### 5-1. 단계

이 시리즈의 글 순서가 곧 공부 순서입니다.

| 단계 | 할 일 | 볼 글 | 끝났다고 보는 기준 |
|---|---|---|---|
| 1. 구조 잡기 | 선언형 API와 컨트롤 루프, 구성요소 역할, 요청 흐름, 기본 오브젝트와 kubectl 사용법 | [Ch-01](/blog/cert/cka/cka-01-why-kubernetes), [Ch-01.5](/blog/cert/cka/cka-01b-core-objects-and-flow) | 구성요소 하나가 멈췄을 때의 증상을 말할 수 있다 |
| 2. 아키텍처·설치(25%) | RBAC, kubeadm 설치와 업그레이드, etcd, 인증서, HA, Helm, Kustomize, CNI, CRD | [Ch-02](/blog/cert/cka/cka-02-cluster-architecture) | VM의 kubeadm 클러스터를 문서만 보고 만들고 올린다 |
| 3. 워크로드·스케줄링(15%) | 롤아웃, ConfigMap/Secret, HPA, 프로브, 사이드카, requests/limits, 어피니티, taint | [Ch-03](/blog/cert/cka/cka-03-workloads-scheduling) | 각 과제를 뼈대 명령으로 5분 안에 한다 |
| 4. 서비스·네트워킹(20%) | Service, NetworkPolicy, Gateway API, Ingress, CoreDNS | [Ch-04](/blog/cert/cka/cka-04-services-networking) | Ingress를 Gateway와 HTTPRoute로 옮긴다 |
| 5. 스토리지(10%) | StorageClass, PV/PVC 바인딩, 회수 정책, 확장 | [Ch-05](/blog/cert/cka/cka-05-storage) | Pending PVC의 원인을 바인딩 조건으로 찾는다 |
| 6. 트러블슈팅(30%) | 노드, 컨트롤 플레인, 로그, `kubectl top`, Service와 DNS 점검 | [Ch-06](/blog/cert/cka/cka-06-troubleshooting) | 스스로 망가뜨린 클러스터를 문서만 보고 고친다 |
| 7. 시간 맞추기 | Killercoda 시나리오, 강의 모의고사, killer.sh 2회(시험 2주 전과 1주 전) | [Ch-07](/blog/cert/cka/cka-07-resources-and-exam-day) | killer.sh 2회차에서 표시한 문제까지 돌아간다 |
| 8. 마무리 | 명령, YAML 뼈대, 자주 틀리는 것 복습. 당일 점검표 | [Ch-08](/blog/cert/cka/cka-08-cram-sheet), Ch-07 6절 | 점검표 통과 |

영역 순서는 커리큘럼 순서를 따랐고 트러블슈팅은 앞 영역의 지식을 모두 쓰므로 마지막에 둡니다. 연습 자료 비교, 할인, 홈 랩 구성, D-30 계획은 [Ch-07](/blog/cert/cka/cka-07-resources-and-exam-day)에 있습니다.

"쿠버네티스 아래의 리눅스" 시리즈([1편 커널 경계](/blog/theory/systems/k8s-linux-01-kernel-boundary)부터 5편까지)는 namespace, cgroup, overlayfs, iptables를 커널 쪽에서 보는 시험 범위 밖 심화입니다.

### 5-2. 손에 익힐 것

| 항목 | 이유 |
|---|---|
| `kubectl create`, `kubectl run`에 `--dry-run=client -o yaml`을 붙여 매니페스트 뼈대 만들기 | YAML을 처음부터 쓰지 않는다. 후기 여러 편이 같은 방식을 썼다 |
| `kubectl explain <리소스>.<필드>` | 필드 이름이 기억나지 않을 때와 CRD, VPA처럼 문서 예시가 적은 리소스 |
| `kubectl auth can-i ... --as` | RBAC 과제를 끝낸 뒤 검증 |
| `ssh`, `sudo`, `journalctl -u kubelet`, `crictl ps -a`, `/etc/kubernetes/manifests` | 컨트롤 플레인과 노드 트러블슈팅. [Ch-01 3장](/blog/cert/cka/cka-01-why-kubernetes)에서 구성요소별 증상을 정리 |
| `-o jsonpath`, `yq` | 값을 뽑아 파일로 저장하는 과제. `jq`는 공식 사전 설치 목록에 없다 |
| kubernetes.io 문서의 위치 | Gateway API, NetworkPolicy, PV/PVC, Kustomize, kubeadm 페이지를 검색 없이 찾아간다 |

<details>
<summary>기초부터: 위 표의 명령 세 개를 한 줄씩 읽기</summary>

> **핵심 한 줄**: YAML은 처음부터 쓰지 않고 kubectl에게 뼈대를 받아 고칩니다. 필드 이름은 `kubectl explain`에 묻고 권한 과제는 `kubectl auth can-i`로 끝을 확인합니다.

#### 1. 뼈대 만들기

```bash
k create deployment web --image=nginx:1.27 --replicas=3 -n shop --dry-run=client -o yaml > web.yaml
```

| 조각 | 뜻 |
|---|---|
| `k create deployment web` | 이름이 `web`인 Deployment를 만드는 명령 |
| `--image=nginx:1.27 --replicas=3` | 컨테이너 이미지와 복제본 수 |
| `-n shop` | 네임스페이스 |
| `--dry-run=client` | 서버에 보내지 않고 kubectl 안에서만 객체를 만들어 봄 |
| `-o yaml` | 만든 객체를 YAML로 출력 |
| `> web.yaml` | 출력을 파일로 저장 |

이렇게 받은 파일에 명령 옵션으로 못 넣는 값(볼륨, 프로브, `resources`)만 더 적고 `k apply -f web.yaml`로 보냅니다. 출력에는 `status: {}`처럼 비어 있는 칸이 섞여 있을 수 있는데 그대로 둬도 API 서버가 무시합니다.

#### 2. 필드 이름 묻기

```bash
k explain deployment.spec.strategy
k explain pod.spec.containers.resources --recursive
```

점으로 이어 내려가며 그 자리에 올 수 있는 필드와 설명을 클러스터에서 직접 받습니다. 클러스터에 설치된 CRD도 같은 방식으로 물을 수 있어 문서 예시가 적은 리소스에서 특히 쓸모가 있습니다. `--recursive`는 아래 필드 이름을 한 번에 펼쳐 보여 줍니다.

#### 3. 권한 확인

```bash
k auth can-i create pods -n shop --as=system:serviceaccount:shop:builder
```

"`shop` 네임스페이스의 ServiceAccount `builder`가 Pod를 만들 수 있나"를 묻고 `yes`나 `no` 한 단어로 답을 받습니다. Role과 RoleBinding을 만든 뒤 이 한 줄로 확인하면 바인딩 대상의 이름이나 네임스페이스를 잘못 적은 실수를 바로 잡습니다.

> **정리**: 만들 때는 `--dry-run=client -o yaml`, 모를 때는 `explain`, 끝낼 때는 `get`이나 `auth can-i`로 확인합니다.

</details>

## 6. 범위와 한계

- 시험 규칙과 범위는 2026년 10월에 LF 문서와 cncf/curriculum 저장소에서 확인했습니다. 시험 2주 전에 다시 확인합니다.
- 현재 시험 지문에 클러스터 컨텍스트 전환(`kubectl config use-context`)이 나오는지는 공식 문서에서 확인하지 못했습니다. 공식 안내는 과제마다 ssh로 호스트를 옮기는 방식만 적습니다.
- `etcdutl`과 `crictl`이 과제 호스트에 있는지는 공식 문서와 후기 어디서도 확인하지 못했습니다.
- metrics-server와 VPA가 시험 클러스터에 미리 설치되어 있는지는 확인하지 못했습니다.
- 개정 후 etcd 백업·복구와 kubeadm 업그레이드가 실제로 출제되는지는 후기가 갈려 확인하지 못했습니다.
- 이 글은 응시 전에 쓴 계획이고 후기의 점수와 준비 기간은 각자의 경험입니다.

## 참고 자료

공식 문서
- CNCF, [CKA Curriculum v1.37](https://github.com/cncf/curriculum/blob/master/CKA_Curriculum_v1.37.pdf)
- Linux Foundation, [Certified Kubernetes Administrator (CKA)](https://training.linuxfoundation.org/certification/certified-kubernetes-administrator-cka/), [CKA Program Changes](https://training.linuxfoundation.org/certified-kubernetes-administrator-cka-program-changes/)
- Linux Foundation, [Important Instructions: CKA and CKAD](https://docs.linuxfoundation.org/tc-docs/certification/tips-cka-and-ckad), [Frequently Asked Questions: CKA and CKAD & CKS](https://docs.linuxfoundation.org/tc-docs/certification/faq-cka-ckad-cks), [Resources Allowed](https://docs.linuxfoundation.org/tc-docs/certification/certification-resources-allowed), [ExamUI: Performance Based Exams](https://docs.linuxfoundation.org/tc-docs/certification/lf-handbook2/exam-user-interface/examui-performance-based-exams)
- Linux Foundation, [Expanding CARE: Passing CKS Can Now Extend Your CKA Certification](https://training.linuxfoundation.org/blog/expanding-care-passing-cks-can-now-extend-your-cka-certification/), 2026-06-18
- Kubernetes, [Kubernetes v1.37 릴리스](https://kubernetes.io/blog/2026/08/26/kubernetes-v1-37-release/), [Operating etcd clusters for Kubernetes](https://kubernetes.io/docs/tasks/administer-cluster/configure-upgrade-etcd/)
- etcd, [Announcing etcd v3.6.0](https://etcd.io/blog/2025/announcing-etcd-3.6/), kubernetes/kubernetes [release-1.37 kubeadm constants.go](https://github.com/kubernetes/kubernetes/blob/release-1.37/cmd/kubeadm/app/constants/constants.go)
- Linux Foundation, [Exam Terms of Service](https://docs.linuxfoundation.org/tc-docs/certification/exam-terms-of-service)(재응시 조건), [Important Instructions 2025-02-11 판](https://web.archive.org/web/20250211081937/https://docs.linuxfoundation.org/tc-docs/certification/tips-cka-and-ckad)과 [2025-03-28 판](https://web.archive.org/web/20250328093613/https://docs.linuxfoundation.org/tc-docs/certification/tips-cka-and-ckad)(Wayback Machine, 사전 설치 목록 변경 대조)
- [killer.sh CKA](https://killer.sh/cka), [killer.sh FAQ](https://killer.sh/faq)

후기
- Matt Bargenquast, [CKS and beta CKA 2025](https://bargenqua.st/posts/cks-cka-2025/), 2025
- Nattapol, [I passed the CKA (February 2025 Changes)](https://nattapol.com/i-passed-the-cka-february-2025-changes/), 2025
- 최민석, [CKA 합격 후기](https://minseoky.me/devops/kubernetes/cka_journey), 2025
- yu-min, [業務未経験から半年でKubestronaut達成（KCNA/KCSA/CKA/CKAD/CKS全冠）勉強法まとめ](https://zenn.dev/yuu7751/articles/24f509769b97b5), 2025
- Atsushi Suzuki, [CKA (Certified Kubernetes Administrator) Exam Report 2026: Don't Rely on Old Guides](https://dev.to/suzuki0430/cka-certified-kubernetes-administrator-exam-report-2026-dont-rely-on-old-guides-mastering-the-534m), 2026
- Talha Juikar, [Passing the CKA Exam](https://talhajuikar.com/posts/passing-cka-exam/), 2026
- cnative_tkb, [CKA-JP 更新試験 受験記 — 2026年版](https://zenn.dev/cnative_tkb/articles/2d1447e98a7aed), 2026
- Domenic Cassisi, [I passed the CKA! My Exam Experience (2026)](https://dcassisi.com/2026/06/09/i-passed-the-cka-my-exam-experience-2026/), 2026
- 109x79m, [【2025年2月改訂版】CKA受験体験記](https://qiita.com/109x79m/items/c7057af1d073c43b6575), 2026
- yltw27, [How I Passed the CKA in 2026](https://dev.to/yltw27/how-i-passed-the-cka-in-2026-143c), 2026

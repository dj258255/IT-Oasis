---
title: '[CKA Ch-06] 트러블슈팅: 증상에서 출발해 kubelet과 로그까지 내려가는 순서'
description: CKA 커리큘럼 v1.37에서 비중이 가장 큰 Troubleshooting 영역(30%)을 목차 순서대로 정리합니다. 노드와 클러스터 구성요소(static Pod, kubelet, journalctl, crictl), 리소스 사용량(metrics-server, kubectl top, jsonpath와 custom-columns로 값 뽑기), 컨테이너 출력(kubectl logs, --previous), 서비스와 네트워킹 문제를 kubernetes.io 문서로 확인하고 증상별 판단 표와 연습 과제를 붙였습니다.
date: 2026-10-19T00:00:00.000Z
tags:
  - CKA
  - Kubernetes
  - Troubleshooting
  - kubelet
  - crictl
  - kubectl logs
category: cert/CKA
topics:
  - cert
draft: false
series: "CKA 공부"
seriesOrder: 6
---

## 결론부터

1. 트러블슈팅은 증상에서 출발해 한 층씩 내려갑니다. 순서는 `kubectl get`으로 상태 보기, `kubectl describe`의 Events 읽기, `kubectl logs`로 컨테이너 출력 보기, 노드에 ssh로 들어가 `journalctl -u kubelet`과 `crictl` 보기입니다. 0절의 판단 표가 이 순서를 증상별로 정리한 것입니다.
2. kubeadm 클러스터의 컨트롤 플레인 구성요소(kube-apiserver, kube-controller-manager, kube-scheduler, etcd)는 `/etc/kubernetes/manifests`의 static Pod입니다. kubelet이 이 디렉터리를 보고 Pod를 만들기 때문에 매니페스트를 고치면 kubelet이 다시 띄웁니다. API 서버가 죽어 `kubectl`이 안 되면 노드에서 `crictl ps -a`와 `crictl logs`로 봅니다.
3. kubelet과 컨테이너 런타임은 컨테이너 밖에서 systemd 서비스로 돕니다. 노드가 `NotReady`이면 그 노드에서 `systemctl status kubelet`과 `journalctl -u kubelet`부터 봅니다. kubeadm이 쓰는 kubelet 설정 파일은 `/var/lib/kubelet/config.yaml`입니다.
4. `kubectl top`은 metrics-server(또는 Metrics API를 제공하는 다른 어댑터)가 있어야 동작합니다. 메모리는 working set 기준이라 컨테이너 안에서 본 수치와 다를 수 있습니다.
5. 재시작된 컨테이너의 이전 로그는 `kubectl logs --previous`로 봅니다. kubelet은 재시작된 컨테이너의 종료된 인스턴스 하나와 로그를 보관하고 `kubectl logs`는 회전된 로그 중 최신 파일만 보여 줍니다.

---

커리큘럼 원문(CNCF, CKA Curriculum v1.37)의 Troubleshooting 항목은 다섯 개입니다. 각 절에 앞서 증상별 판단 표를 0절로 둡니다.

| 순서 | 커리큘럼 원문 | 이 글의 절 |
|---|---|---|
| 1 | Troubleshoot clusters and nodes | 1. 클러스터와 노드 |
| 2 | Troubleshoot cluster components | 2. 클러스터 구성요소 |
| 3 | Monitor cluster and application resource usage | 3. 리소스 사용량 모니터링 |
| 4 | Manage and evaluate container output streams | 4. 컨테이너 출력 스트림 |
| 5 | Troubleshoot services and networking | 5. 서비스와 네트워킹 |

예시는 가상의 쇼핑몰입니다. 네임스페이스 `shop`에 주문 API(`order-api`), 결제(`payment`), 게시판(`board`)이 있습니다. [Ch-00](/blog/cert/cka/cka-00-exam-and-study-plan)에서 정리한 후기들이 공통으로 꼽은 실패 원인이 트러블슈팅에서 시간을 잃은 것이었습니다. 그래서 이 글은 "어디부터 볼지"를 정하는 데 비중을 둡니다.

## 0. 증상에서 출발하는 판단 표

### 0-1. 첫 3분

어떤 과제든 처음 세 명령은 같습니다.

```bash
kubectl get pod -n <ns> -o wide          # STATUS, RESTARTS, 노드
kubectl describe pod <pod> -n <ns>       # 맨 아래 Events
kubectl get events -n <ns> --sort-by=.metadata.creationTimestamp
```

Debug Running Pods 문서는 이벤트가 네임스페이스 단위라는 점을 짚습니다. 다른 네임스페이스의 문제를 보려면 `--namespace`를 주고 전체를 보려면 `--all-namespaces`를 씁니다. `--sort-by`로 시간순 정렬하는 것은 문서 예시에 없지만 이벤트가 섞여 나올 때 읽기 편해 함께 적었습니다.

### 0-2. 증상별 판단 표

| 증상 | 의미(문서 기준) | 먼저 볼 것 | 흔한 원인 | 이 글의 절 |
|---|---|---|---|---|
| Pod `Pending` | 노드에 스케줄되지 못함 | `describe pod` Events의 `FailedScheduling` 메시지 | 자원 요청이 어느 노드에도 안 맞음, 노드 셀렉터나 어피니티 불일치, 테인트, `hostPort` 충돌, PVC `Pending` | 0-3 |
| `ContainerCreating`에 오래 머묾 | 노드에 배정됐지만 컨테이너를 못 만듦 | Events | 볼륨 마운트 실패, CNI 문제, Secret이나 ConfigMap 없음 | 1, 5 |
| `ErrImagePull`, `ImagePullBackOff` | 이미지를 받지 못해 `Waiting`. 재시도 간격이 늘어나 최대 300초 | Events의 pull 오류 | 이미지 이름이나 태그 오타, 레지스트리에 없음, 비공개 레지스트리인데 `imagePullSecrets` 없음 | 0-4 |
| `CrashLoopBackOff` | 컨테이너가 시작했다 종료되기를 반복. 재시작 지연이 10초부터 두 배씩 늘어 300초에서 멈춤 | `kubectl logs --previous`, `describe`의 Last State와 Exit Code | 앱 오류, 잘못된 command나 args, 설정 누락, liveness probe 실패, 메모리 부족 | 4 |
| `OOMKilled`(Exit Code 137) | 메모리 한도를 넘어 커널이 종료 | `describe`의 Last State Reason | `limits.memory`가 실제 사용량보다 작음 | [Ch-01](/blog/cert/cka/cka-01-why-kubernetes) |
| `Running`인데 READY `0/1` | readiness probe 실패. EndpointSlice에서 빠져 트래픽을 받지 않음 | `describe`의 Readiness 이벤트 | probe 경로나 포트 오류 | 5 |
| `Terminating`에 멈춤 | 삭제는 요청됐지만 객체를 지우지 못함 | Pod의 finalizers, 웹훅 | finalizer를 지우지 못하게 하는 admission 웹훅 | 0-5 |
| 노드 `NotReady` | 노드 컨트롤러가 kubelet의 상태 보고를 받지 못함 | 그 노드에서 `systemctl status kubelet`, `journalctl -u kubelet` | kubelet 중지, 설정 파일 오류, 런타임 중지, 인증서 문제, CNI 미설치 | 1 |
| `kubectl`이 API 서버에 연결 못 함 | API 서버 응답 없음 | 컨트롤 플레인 노드의 `crictl ps -a`, `/etc/kubernetes/manifests/kube-apiserver.yaml` | 매니페스트 오타, 인증서 경로, etcd 연결 | 2 |
| Pod가 생성되지 않음(Deployment는 있는데 Pod가 0개) | 컨트롤러나 스케줄러가 일을 안 함 | `kube-system`의 kube-controller-manager, kube-scheduler Pod | static Pod 매니페스트 오류 | 2 |
| Service가 응답 없음, 엔드포인트 없음 | selector가 Pod를 못 고르거나 Pod가 Ready 아님 | `kubectl get endpointslices -l kubernetes.io/service-name=<svc>` | selector와 라벨 불일치, `targetPort` 오류, readiness 실패 | 5 |
| 이름 해석 실패 | CoreDNS 경로 어딘가의 문제 | `nslookup kubernetes.default`, CoreDNS Pod와 `kube-dns` Service | CoreDNS 다운, Corefile 오류, Egress NetworkPolicy가 DNS 차단 | 5, [Ch-04](/blog/cert/cka/cka-04-services-networking) |
| `kubectl top` 실패 | Metrics API 없음 | `kubectl get apiservice`, metrics-server Pod | metrics-server 미설치, kubelet 인증서 검증 실패 | 3 |

표의 "의미" 열은 Debug Pods, Pod Lifecycle, Images, Node Status 문서에서 확인한 내용이고 "흔한 원인" 열은 같은 문서들의 원인 목록에 이 시리즈의 스케줄링, 스토리지, 네트워킹 정리에서 나온 원인을 더한 것입니다. Pod가 노드에 배정된 뒤 이미지를 받고 컨테이너가 뜨기까지 어떤 구간을 거치는지는 [DE Ch-07](/blog/data/orchestration/de-07-task-per-pod-cost)에서 Pod condition과 함께 정리했습니다.

### 0-3. Pending

Debug Pods 문서는 `Pending`을 "노드에 스케줄할 수 없는 상태"로 정의하고 대개 어떤 종류의 자원이 모자란 것이라고 설명합니다. `kubectl describe pod`의 Events에 스케줄러가 남긴 이유가 있습니다. 문서가 드는 원인은 둘입니다.

- 클러스터의 CPU나 메모리를 다 써서 요청을 채울 노드가 없음. Pod를 지우거나 요청을 줄이거나 노드를 늘립니다.
- `hostPort`를 쓴 Pod. 같은 포트를 쓸 수 있는 자리가 노드 수만큼만 있습니다.

시험에서 더 자주 보는 것은 Workloads 영역과 겹치는 원인입니다. `nodeSelector`의 라벨이 어느 노드에도 없거나, 노드에 테인트가 있는데 톨러레이션이 없거나, 쓰는 PVC가 `Pending`인 경우입니다. PVC가 원인이면 [Ch-05의 3-6절](/blog/cert/cka/cka-05-storage) 순서로 넘어갑니다.

```bash
kubectl describe pod order-api-xxxx -n shop | sed -n '/Events/,$p'
kubectl describe node <노드> | grep -A5 Taints
kubectl get node --show-labels
```

### 0-4. ImagePullBackOff

Images 문서는 `ImagePullBackOff`를 "이미지를 받지 못해 컨테이너가 시작하지 못한 상태"로 설명하고 이유로 잘못된 이미지 이름과 `imagePullSecret` 없이 비공개 레지스트리에서 받으려 한 경우를 듭니다. `BackOff`는 간격을 늘려 가며 계속 재시도한다는 뜻이고 최대 간격은 300초입니다. Debug Pods 문서의 점검 목록은 세 가지입니다. 이미지 이름이 맞는지, 레지스트리에 푸시됐는지, 직접 pull해서 받아지는지입니다.

```bash
kubectl -n shop get pod order-api-xxxx -o jsonpath='{.spec.containers[*].image}'
kubectl -n shop set image deployment/order-api order-api=nginx:1.27   # 이미지 이름을 고칠 때
# 노드에서 직접 받아 보기
sudo crictl pull nginx:1.27
```

`crictl pull`은 Debugging Kubernetes nodes with crictl 문서의 예시 목록에는 없고 cri-tools 저장소의 `docs/crictl.md` 하위 명령 목록에 "Pull an image from a registry"로 나옵니다.

### 0-5. Terminating에 멈춤

Debug Pods 문서는 이 상태의 흔한 원인으로 finalizer가 있는 Pod와 finalizer 제거를 막는 admission 웹훅을 듭니다. `pods` 리소스의 `UPDATE`를 대상으로 하는 ValidatingWebhookConfiguration이나 MutatingWebhookConfiguration이 있는지 확인하라고 적습니다.

```bash
kubectl get validatingwebhookconfigurations,mutatingwebhookconfigurations
kubectl -n shop get pod board-xxxx -o jsonpath='{.metadata.finalizers}'
```

### 0-6. Running인데 기대와 다르게 동작

Debug Pods 문서의 마지막 경우입니다. Pod 설명에 오타가 있으면 그 키가 조용히 무시될 수 있습니다. 예로 `command`를 `commnd`로 쓰면 Pod는 만들어지지만 의도한 명령을 쓰지 않습니다. 문서는 `kubectl apply --validate -f mypod.yaml`로 다시 만들어 보고 `kubectl get pods/mypod -o yaml`로 API 서버에 저장된 내용과 원본을 비교하라고 권합니다.

## 1. 클러스터와 노드

### 1-1. 노드 목록부터

Troubleshooting Clusters 문서의 첫 단계는 노드가 모두 등록됐고 `Ready`인지 보는 것입니다.

```bash
kubectl get nodes
kubectl describe node <노드>
kubectl get node <노드> -o yaml
kubectl cluster-info dump        # 클러스터 전체 상태를 길게 출력
```

### 1-2. 노드 조건과 하트비트

Node Status 문서의 조건 표입니다.

| 조건 | 뜻 |
|---|---|
| `Ready` | `True`면 정상이고 Pod를 받을 수 있음. `False`면 비정상. `Unknown`이면 노드 컨트롤러가 `node-monitor-grace-period`(기본 50초) 동안 노드 소식을 듣지 못함 |
| `DiskPressure` | 디스크 용량이 부족함 |
| `MemoryPressure` | 노드 메모리가 부족함 |
| `PIDPressure` | 프로세스가 너무 많음 |
| `NetworkUnavailable` | 노드 네트워크가 제대로 설정되지 않음 |

하트비트는 두 형태입니다. kubelet이 Node의 `.status`를 갱신하는 것과 `kube-node-lease` 네임스페이스의 Lease 객체를 갱신하는 것입니다. 문서 기준 Lease 갱신 간격은 기본 10초이고 `.status`는 변화가 없으면 기본 5분마다 갱신합니다. `Ready`가 `node-monitor-grace-period`보다 오래 `Unknown`이나 `False`이면 노드에 `node.kubernetes.io/unreachable` 또는 `node.kubernetes.io/not-ready` 테인트가 붙습니다. Troubleshooting Clusters 문서의 예시는 NotReady가 5분 지속된 뒤 Pod가 축출(evict)되는 모습을 보여 줍니다.

같은 문서에 실린 kubelet이 멈춘 노드의 `describe` 출력 일부입니다(문서 예시이고 이 글에서 실행한 결과는 아닙니다).

```
Taints:             node.kubernetes.io/unreachable:NoExecute
                    node.kubernetes.io/unreachable:NoSchedule
...
  Ready                Unknown   ...   NodeStatusUnknown   Kubelet stopped posting node status.
```

`Kubelet stopped posting node status.`가 보이면 원인은 노드 쪽입니다. 그 노드로 들어갑니다.

### 1-3. 노드 안에서 볼 것

시험 환경은 과제마다 지정된 호스트에 `ssh`로 들어가고 권한이 필요하면 `sudo`를 씁니다([Ch-00 3-2절](/blog/cert/cka/cka-00-exam-and-study-plan)).

```bash
ssh <노드>
sudo systemctl status kubelet
sudo journalctl -u kubelet --no-pager | tail -50
sudo systemctl restart kubelet
sudo systemctl enable --now kubelet      # 꺼져 있고 부팅 시 자동 시작도 안 되게 돼 있을 때
```

Logging Architecture 문서는 systemd를 쓰는 리눅스 노드에서 kubelet과 컨테이너 런타임이 기본으로 journald에 기록하고 `journalctl -u kubelet`으로 읽는다고 적습니다. systemd가 없으면 `/var/log`의 `.log` 파일에 씁니다.

kubeadm이 kubelet에 넘기는 파일 위치는 Configuring each kubelet in your cluster using kubeadm 문서의 systemd drop-in 예시에 있습니다.

| 파일 | 역할 |
|---|---|
| `/var/lib/kubelet/config.yaml` | kubelet ComponentConfig(설정 파일) |
| `/etc/kubernetes/kubelet.conf` | kubelet 고유 신원이 담긴 kubeconfig |
| `/etc/kubernetes/bootstrap-kubelet.conf` | TLS 부트스트랩용. `kubelet.conf`가 없을 때만 사용 |
| `/var/lib/kubelet/kubeadm-flags.env` | `kubeadm init`, `join`이 생성하는 `KUBELET_KUBEADM_ARGS` |
| `/etc/default/kubelet`(DEB), `/etc/sysconfig/kubelet`(RPM) | 사용자 재정의 `KUBELET_EXTRA_ARGS`. 충돌 시 가장 높은 우선순위 |

drop-in 파일 자체의 경로는 설치 방법마다 다르고 문서도 예시라고 밝힙니다. 실제 위치는 `systemctl cat kubelet`으로 확인합니다. 이 명령은 systemd의 일반 기능이며 쿠버네티스 문서에서 본 것은 아닙니다.

kubelet 로그에서 원인을 찾았다면 고치는 대상은 대개 위 파일 중 하나입니다. 예를 들어 설정 파일의 경로를 잘못 바꿨거나, kubeconfig가 가리키는 인증서가 없거나, 컨테이너 런타임 소켓 주소가 틀린 경우입니다. 고친 뒤에는 `systemctl daemon-reload`(drop-in을 고쳤을 때)와 `systemctl restart kubelet`을 하고 `kubectl get nodes`로 Ready를 확인합니다.

### 1-4. kubectl debug로 노드 들여다보기

ssh를 쓸 수 없는 환경이라면 Debug Running Pods 문서의 노드 디버그를 씁니다.

```bash
kubectl debug node/<노드> -it --image=ubuntu
```

문서가 적은 동작은 다음과 같습니다. 노드 이름으로 Pod 이름이 자동으로 정해지고 노드의 루트 파일시스템이 `/host`에 마운트되고 호스트의 IPC, 네트워크, PID 네임스페이스에서 돕니다. Pod가 특권(privileged)이 아니어서 일부 프로세스 정보 읽기나 `chroot /host`가 실패할 수 있고 필요하면 `--profile=sysadmin`을 씁니다. 끝나면 만든 디버그 Pod를 지웁니다.

### 1-5. 노드를 서비스에서 빼고 넣기

트러블슈팅 과제가 "노드를 점검하기 위해 비우라"를 포함하면 cordon과 drain을 씁니다. Nodes 문서와 Safely Drain a Node 문서 기준입니다.

```bash
kubectl cordon <노드>                         # 새 Pod 배치 금지
kubectl drain --ignore-daemonsets <노드>      # Pod 축출. DaemonSet Pod는 건너뜀
kubectl uncordon <노드>                       # 다시 배치 허용
```

문서는 DaemonSet이 관리하는 Pod가 있으면 `--ignore-daemonsets`를 줘야 drain이 성공한다고 설명합니다. DaemonSet 컨트롤러가 사라진 Pod를 같은 노드에 바로 다시 만들기 때문입니다. cordon된 노드는 출력에서 `SchedulingDisabled`로 보이는데 Node Status 문서는 이것이 API의 조건 목록에 없는 출력용 표시라고 적습니다.

### 1-6. 자주 틀리는 지점

- 노드에서 `systemctl restart kubelet`만 하고 `enable`을 빠뜨립니다. 과제가 "재부팅 뒤에도 유지"를 요구하면 enable 상태까지 확인합니다.
- 다른 노드에서 고치는 실수. 과제마다 지정된 호스트가 있고 ssh 안에서 다시 ssh할 수 없습니다.
- 워커 노드 NotReady를 컨트롤 플레인에서 해결하려는 것. kubelet은 각 노드에서 따로 돕니다.
- 노드 조건이 `NetworkUnavailable`이거나 kubelet 로그에 CNI 관련 오류가 있는데 kubelet만 재시작하는 것. 네트워크 플러그인 Pod 상태를 함께 봅니다.

### 1-7. 직접 해 보기

1. 워커 노드에서 `sudo systemctl stop kubelet`을 하고 컨트롤 플레인에서 `kubectl get nodes -w`로 상태가 바뀌는 데 걸리는 시간을 잽니다. 문서의 기본값 50초와 비교합니다.
2. `/var/lib/kubelet/config.yaml`을 백업한 뒤 일부러 YAML 들여쓰기를 망가뜨리고 `journalctl -u kubelet`에서 오류 줄을 찾아 되돌립니다.
3. 노드를 drain해서 쇼핑몰 Deployment의 Pod가 다른 노드로 옮겨지는지 보고 uncordon합니다.

## 2. 클러스터 구성요소

### 2-1. 무엇이 어디서 도나

Logging Architecture 문서는 시스템 구성요소를 둘로 나눕니다.

| 종류 | 구성요소 | 상태와 로그를 보는 곳 |
|---|---|---|
| 컨테이너로 돌지 않음 | kubelet, 컨테이너 런타임 | `systemctl status`, `journalctl -u <서비스>` |
| Pod로 돎(대개 static Pod) | kube-apiserver, kube-controller-manager, kube-scheduler, etcd | `kubectl -n kube-system get pod`, `kubectl logs`. API 서버가 죽었으면 `crictl` |
| DaemonSet | kube-proxy(쓰는 경우) | `kubectl -n kube-system logs` |

kubeadm Implementation details 문서 기준으로 kubeadm은 컨트롤 플레인 구성요소의 static Pod 매니페스트를 `/etc/kubernetes/manifests`에 씁니다. 이 Pod들은 모두 `kube-system`에 생기고 `tier: control-plane`, `component: <구성요소 이름>` 라벨을 받으며 `hostNetwork: true`로 돕니다.

### 2-2. static Pod의 동작

Static Pods와 Create static Pods 문서에서 시험에 필요한 사실을 모았습니다.

| 사실 | 문서 내용 |
|---|---|
| 관리 주체 | 특정 노드의 kubelet이 직접 관리. API 서버는 관여하지 않는다 |
| 매니페스트 위치 | kubelet 설정의 `staticPodPath`(kubeadm은 `/etc/kubernetes/manifests`) |
| 감시 | kubelet이 디렉터리를 주기적으로 스캔해 파일이 생기면 만들고 사라지면 지운다 |
| mirror Pod | kubelet이 API 서버에 거울 Pod를 만든다. 이름 뒤에 `-<노드 호스트 이름>`이 붙는다. `kubernetes.io/config.mirror` 어노테이션으로 구분 |
| kubectl delete | mirror Pod를 지워도 static Pod는 지워지지 않고 mirror Pod가 다시 생긴다 |
| 제약 | ServiceAccount, ConfigMap, Secret 같은 다른 API 객체를 참조할 수 없다. 임시 컨테이너 미지원 |
| 파일 이름 | 점(.)으로 시작하는 파일만 무시한다. 확장자로 거르지 않는다 |

마지막 줄이 실전 함정입니다. Create static Pods 문서의 주의 상자는 `cp kube-apiserver.yaml kube-apiserver.yaml.backup`처럼 디렉터리 안에 백업을 만들면 kubelet이 두 파일을 모두 읽어 같은 이름의 Pod를 두 번 만들려 한다고 경고합니다. 결과는 정의되지 않았고 백업의 옛 스펙이 조용히 적용될 수도 있습니다. 백업은 디렉터리 밖(문서 예시는 `/etc/kubernetes/backup/`)에 둡니다.

```bash
sudo mkdir -p /etc/kubernetes/backup
sudo cp /etc/kubernetes/manifests/kube-apiserver.yaml /etc/kubernetes/backup/
sudo vi /etc/kubernetes/manifests/kube-apiserver.yaml
```

static Pod를 재시작하려면 매니페스트를 잠시 디렉터리 밖으로 옮겼다가 되돌립니다. Certificate Management with kubeadm 문서는 kubelet 설정의 `fileCheckFrequency`만큼(문서는 20초) 기다리라고 적습니다.

```bash
sudo mv /etc/kubernetes/manifests/kube-scheduler.yaml /tmp/
sleep 20
sudo crictl ps | grep kube-scheduler     # 사라졌는지
sudo mv /tmp/kube-scheduler.yaml /etc/kubernetes/manifests/
```

### 2-3. 구성요소가 죽으면 무엇이 멈추나

Troubleshooting Clusters 문서의 장애 시나리오에서 시험과 맞닿은 부분입니다.

| 장애 | 결과(문서 기준) | 시험에서 보이는 모습 |
|---|---|---|
| API 서버 중지 | Pod, Service 등을 새로 만들거나 바꾸지 못한다. API에 기대지 않는 기존 Pod와 Service는 계속 동작 | `kubectl` 명령 전체 실패 |
| API 서버 저장소(etcd) 손실 | kube-apiserver가 정상 기동하지 못한다. kubelet은 기존 Pod를 계속 돌린다 | API 서버 컨테이너가 계속 재시작 |
| 컨트롤러 매니저, 스케줄러 중지 | API 서버 중지와 비슷한 영향. 고유한 영구 상태는 없다 | Deployment는 있는데 Pod가 생기지 않거나(컨트롤러) Pod가 `Pending`에 머묾(스케줄러) |
| kubelet 장애 | 그 노드에서 새 Pod를 시작하지 못하고 노드가 unhealthy로 표시 | 노드 `NotReady` |

오른쪽 열의 "Pod가 생기지 않음"과 "Pending에 머묾" 구분은 두 구성요소의 역할(컨트롤러는 ReplicaSet이 Pod 객체를 만들게 하고 스케줄러는 Pod에 노드를 정한다)에서 끌어낸 것이고 문서 표에 그대로 있지는 않습니다. 스케줄러가 죽었을 때 `describe pod`의 Events에 스케줄링 이벤트가 없는 것도 단서입니다.

### 2-4. API 서버가 응답하지 않을 때

`kubectl`이 쓸모없어지므로 노드 안 도구로 내려갑니다. Debugging Kubernetes nodes with crictl 문서의 명령입니다.

```bash
ssh <컨트롤 플레인 노드>
sudo crictl ps -a | grep kube-apiserver        # 종료된 컨테이너까지
sudo crictl logs <컨테이너 ID>
sudo crictl logs --tail=20 <컨테이너 ID>
sudo crictl pods --name kube-apiserver
```

| 명령 | 용도 |
|---|---|
| `crictl pods` | Pod 목록. `--name`, `--label`로 거르기 |
| `crictl ps`, `crictl ps -a` | 실행 중인 컨테이너, 종료 포함 전체 |
| `crictl logs <ID>` | 컨테이너 로그. `--tail=N` |
| `crictl exec -i -t <ID> <명령>` | 실행 중인 컨테이너에서 명령 |
| `crictl images` | 이미지 목록 |

crictl은 런타임 엔드포인트를 `--runtime-endpoint` 옵션, `CONTAINER_RUNTIME_ENDPOINT` 환경 변수, `/etc/crictl.yaml` 중 하나로 압니다. 문서 예시의 containerd 설정은 `unix:///var/run/containerd/containerd.sock`입니다. 엔드포인트를 지정하지 않으면 알려진 목록을 차례로 시도해 느려질 수 있다고 문서는 적습니다.

Logging Architecture 문서에 따르면 kubelet은 런타임에 컨테이너 로그를 `/var/log/pods` 아래에 쓰게 합니다. crictl이 안 될 때는 이 디렉터리의 로그 파일을 직접 읽을 수 있습니다.

```bash
sudo ls /var/log/pods/ | grep kube-apiserver
sudo tail -50 /var/log/pods/kube-system_kube-apiserver-*/kube-apiserver/*.log
```

`/var/log/pods` 아래의 하위 디렉터리 이름 규칙(`<ns>_<pod>_<uid>/<컨테이너>/<번호>.log`)은 이번에 문서에서 확인하지 못했습니다. `ls`로 직접 찾아 들어갑니다.

### 2-5. 매니페스트에서 자주 망가지는 곳

트러블슈팅 과제는 보통 "일부러 고장 낸 클러스터를 고치라"입니다. kube-apiserver 매니페스트에서 의심할 곳을 적어 둡니다. 아래 목록은 매니페스트 구조에서 끌어낸 제 점검 순서이고 출제 범위를 문서로 확인한 것은 아닙니다.

| 위치 | 확인 |
|---|---|
| `spec.containers[0].command`의 플래그 | 플래그 이름 오타, 존재하지 않는 플래그 |
| 인증서와 키 경로(`--tls-cert-file`, `--etcd-cafile` 등) | 파일이 실제로 있는지, `volumeMounts`와 `hostPath`가 그 디렉터리를 마운트하는지 |
| `--etcd-servers` | etcd의 주소와 포트 |
| `image` | 태그 오타 |
| YAML 문법 | 들여쓰기. 문법이 깨지면 kubelet이 Pod를 만들지 않으니 `journalctl -u kubelet`에 파싱 오류가 남는다 |

### 2-6. 자주 틀리는 지점

- `kubectl delete pod kube-apiserver-<노드>`로 재시작하려는 것. mirror Pod만 지워지고 static Pod는 그대로입니다.
- 매니페스트 백업을 같은 디렉터리에 두는 것. 2-2절의 주의 상자 그대로입니다.
- 매니페스트를 고친 뒤 바로 `kubectl`을 치고 실패를 보고 다시 고치는 것. kubelet이 변경을 감지하고 컨테이너를 다시 띄우는 데 시간이 걸립니다. `crictl ps`로 새 컨테이너가 떴는지 먼저 봅니다.
- 컨트롤 플레인 Pod 로그를 `kubectl logs`로 보려다 API 서버가 죽어서 실패하는 것. 그때는 `crictl logs`입니다.

### 2-7. 직접 해 보기

1. 연습 클러스터에서 kube-scheduler 매니페스트의 이미지 태그를 존재하지 않는 값으로 바꾸고 쇼핑몰 Deployment를 스케일해 새 Pod가 `Pending`에 머무는 것을 봅니다. 원인을 `crictl`과 `kubectl -n kube-system get pod`에서 찾아 되돌립니다.
2. kube-apiserver 매니페스트의 `--etcd-servers` 포트를 바꾸고 `crictl ps -a`, `crictl logs`로 오류 문장을 찾아 되돌립니다. 백업은 `/etc/kubernetes/backup/`에 둡니다.
3. `/etc/kubernetes/manifests`에 정적 웹 서버 Pod를 하나 만들고 `kubectl delete`로 mirror Pod를 지워 다시 나타나는지 봅니다.

## 3. 리소스 사용량 모니터링

### 3-1. 리소스 메트릭 파이프라인

Resource metrics pipeline 문서의 구성은 오른쪽에서 왼쪽으로 흐릅니다.

```
컨테이너 런타임 -> cAdvisor(kubelet에 포함) -> kubelet(/metrics/resource)
   -> metrics-server(각 kubelet에서 수집) -> Metrics API(metrics.k8s.io, API 서버 aggregation)
   -> HPA, VPA, kubectl top
```

| 구성요소 | 역할(문서 기준) |
|---|---|
| cAdvisor | 컨테이너 메트릭을 모으는 데몬. kubelet에 포함 |
| kubelet | `/metrics/resource`와 `/stats` 엔드포인트로 자원 메트릭 제공 |
| metrics-server | 각 kubelet에서 메트릭을 모아 Metrics API로 제공하는 클러스터 애드온. Metrics API의 참조 구현 |
| Metrics API | CPU와 메모리 사용량. API aggregation 계층과 `metrics.k8s.io` APIService 등록이 필요 |

문서는 metrics-server나 다른 어댑터를 배포해야 Metrics API에 접근할 수 있다고 적습니다. 현재 문서는 Metrics API를 1.37 stable로 표시하고 예시 경로를 `/apis/metrics.k8s.io/v1/...`로 적습니다. 클러스터에 설치된 metrics-server 버전이 어느 API 버전을 제공하는지는 `kubectl get apiservice | grep metrics`로 확인합니다.

이 파이프라인이 제공하는 것은 자동 확장에 필요한 최소한의 CPU와 메모리뿐입니다. 더 많은 메트릭이 필요하면 Custom Metrics API를 쓰는 별도 파이프라인을 두라고 문서는 적습니다.

### 3-2. kubectl top

```bash
kubectl top node
kubectl top node --sort-by=cpu
kubectl top pod -n shop
kubectl top pod -n shop --sort-by=memory
kubectl top pod -n shop --containers           # 컨테이너별
kubectl top pod -n shop -l app=order-api --sum # 합계 행 추가
kubectl top pod -A --sort-by=cpu --no-headers | head -1   # 가장 많이 쓰는 Pod 하나
```

`--sort-by`는 `cpu`나 `memory`만 받습니다(kubectl top 레퍼런스). 레퍼런스는 메트릭 파이프라인 지연 때문에 Pod 생성 후 몇 분 동안은 값이 없을 수 있다고 적습니다.

"CPU를 가장 많이 쓰는 Pod 이름을 파일에 적으라" 같은 과제는 위 마지막 줄 같은 방식으로 풀 수 있습니다. 결과를 파일로 옮길 때는 과제가 요구하는 형식(이름만인지, 네임스페이스를 포함하는지)을 다시 읽습니다.

### 3-3. 숫자를 읽는 법

| 자원 | 문서 정의 |
|---|---|
| CPU | cpu 단위의 평균 코어 사용량. 커널이 주는 누적 CPU 카운터의 변화율로 계산. 계산 구간은 Metrics API의 `window` 필드 |
| 메모리 | 수집 순간의 working set(바이트). 이상적으로는 메모리 압박에서도 회수할 수 없는 사용 중 메모리. OS마다 계산이 다르고 파일 캐시 일부가 섞일 수 있다 |

메모리 수치가 컨테이너 안의 `free`와 다르게 나와도 이상한 일은 아닙니다. 메모리 한도를 넘을 때 커널이 컨테이너를 종료하는 과정(OOMKilled, Exit Code 137)은 [Ch-01](/blog/cert/cka/cka-01-why-kubernetes)에서 cgroup까지 내려가 정리했습니다.

### 3-4. kubectl top이 안 될 때

| 확인 | 명령 |
|---|---|
| metrics-server Pod | `kubectl -n kube-system get pod | grep metrics` |
| APIService 상태 | `kubectl get apiservice | grep metrics` |
| metrics-server 로그 | `kubectl -n kube-system logs deploy/metrics-server` (Deployment 이름은 설치 방법에 따라 다를 수 있다) |

Troubleshooting kubeadm 문서에 kubeadm 클러스터 고유의 함정이 있습니다. kubeadm은 kubelet에 자체 서명 서빙 인증서를 배포하므로 metrics-server가 TLS로 kubelet에 붙으면 `x509: certificate signed by unknown authority` 같은 오류가 납니다. 문서는 `--kubelet-insecure-tls`로 우회할 수 있지만 운영 클러스터에는 권하지 않고 서명된 kubelet 서빙 인증서를 쓰는 방법을 안내합니다. 연습 클러스터에서는 이 옵션으로 띄우고 시험장에서는 과제의 지시를 따릅니다.

### 3-5. 출력 형식으로 값 뽑기

"가장 많이 쓰는 Pod 이름을 파일에 적으라"처럼 모니터링 과제는 대개 출력의 일부를 파일로 옮기는 데서 끝납니다. kubectl Quick Reference와 JSONPath Support 문서의 예시를 과제 형태로 묶었습니다.

| 형식 | 쓰는 자리 | 예 |
|---|---|---|
| `--sort-by=<JSONPath>` | 표를 필드 값으로 정렬 | `kubectl get pods --sort-by='.status.containerStatuses[0].restartCount'` |
| `-o jsonpath='{...}'` | 값만 뽑기. `range`와 `end`로 목록 반복 | `kubectl get nodes -o jsonpath='{.items[*].metadata.name}'` |
| `-o custom-columns=<머리>:<경로>,...` | 원하는 열만 표로 | `kubectl get pods -A -o custom-columns='NS:.metadata.namespace,NAME:.metadata.name'` |
| `-o name` | `종류/이름` 한 줄씩 | `kubectl get pods -n shop -o name` |
| `--no-headers` | 머리줄 빼기. `head`, `awk`와 함께 | `kubectl top pod -A --no-headers` |

```bash
# 노드마다 이름과 Ready 상태
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.conditions[?(@.type=="Ready")].status}{"\n"}{end}'

# 재시작이 가장 많은 Pod (오름차순이라 마지막 줄)
kubectl get pods -A --sort-by='.status.containerStatuses[0].restartCount' --no-headers | tail -1

# 쇼핑몰 Pod의 이미지 목록
kubectl get pods -n shop -o custom-columns='NAME:.metadata.name,IMAGE:.spec.containers[*].image'

# 테인트가 걸린 노드 확인 (Quick Reference 예시)
kubectl get nodes -o custom-columns='NODE:.metadata.name,TAINT:.spec.taints[*].key,EFFECT:.spec.taints[*].effect'

# 라벨 이름에 점이 있으면 역슬래시로 이스케이프
kubectl get nodes -o jsonpath='{.items[0].metadata.labels.kubernetes\.io/hostname}'
```

JSONPath Support 문서는 kubectl의 JSONPath가 정규 표현식을 지원하지 않으니 그런 처리가 필요하면 `jq`를 쓰라고 적습니다. 공식 안내가 시험 호스트에 깔려 있다고 적는 도구 목록에는 `yq`가 있고 `jq`는 없습니다([Ch-00 3-2절](/blog/cert/cka/cka-00-exam-and-study-plan)). 그래서 복잡한 가공은 `-o yaml | yq`나 `grep`, `awk`로 합니다. 파일로 옮긴 뒤에는 `cat`으로 과제가 요구한 형식(이름만인지, 네임스페이스를 포함하는지)과 맞는지 다시 봅니다.

### 3-6. 직접 해 보기

1. 연습 클러스터에 metrics-server를 설치하고 `kubectl top node`가 나오기까지 걸리는 시간을 봅니다.
2. 결제 Deployment에 CPU를 쓰는 루프 컨테이너를 넣고 `kubectl top pod --containers --sort-by=cpu`로 맨 위에 오는지 확인합니다.
3. `kubectl get --raw "/apis/metrics.k8s.io/v1/nodes/<노드>"` 결과의 `window`와 `usage`를 읽어 `kubectl top node` 출력과 맞춰 봅니다. 클러스터가 v1beta1만 제공하면 경로를 바꿉니다.

## 4. 컨테이너 출력 스트림

### 4-1. 로그가 어디서 오나

Logging Architecture 문서의 설명을 순서대로 놓으면 이렇습니다.

1. 컨테이너 런타임이 애플리케이션의 `stdout`과 `stderr`를 받아 처리합니다. kubelet과의 연동은 CRI 로그 형식으로 표준화되어 있습니다.
2. kubelet은 런타임에 로그를 `/var/log/pods` 아래에 쓰게 하고 로그 회전을 맡습니다. 기본값은 파일당 `containerLogMaxSize` 10Mi, 컨테이너당 `containerLogMaxFiles` 5개입니다.
3. `kubectl logs`를 실행하면 노드의 kubelet이 요청을 받아 로그 파일을 직접 읽어 돌려줍니다.

여기서 시험에 쓰이는 사실이 세 가지 나옵니다.

| 사실 | 결과 |
|---|---|
| 앱이 파일에만 로그를 쓰면 | `kubectl logs`에 아무것도 안 나온다. stdout, stderr로 보내야 한다 |
| 컨테이너가 재시작되면 | kubelet이 종료된 컨테이너 하나와 그 로그를 보관한다. `--previous`로 본다 |
| Pod가 노드에서 축출되면 | 컨테이너와 로그가 함께 사라진다 |
| 로그가 회전되면 | `kubectl logs`는 최신 파일만 읽는다. 40MiB를 썼고 10MiB마다 회전되면 최대 10MiB만 보인다 |

### 4-2. kubectl logs

kubectl logs 레퍼런스의 예시를 시험 상황에 맞춰 묶었습니다.

```bash
kubectl logs order-api-xxxx -n shop                    # 컨테이너가 하나일 때
kubectl logs order-api-xxxx -n shop -c app             # 컨테이너 지정
kubectl logs order-api-xxxx -n shop -c app --previous  # 직전 종료 인스턴스(-p)
kubectl logs order-api-xxxx -n shop --all-containers=true
kubectl logs -f order-api-xxxx -n shop                 # 계속 따라가기
kubectl logs --tail=20 order-api-xxxx -n shop
kubectl logs --since=1h order-api-xxxx -n shop
kubectl logs order-api-xxxx -n shop --timestamps=true
kubectl logs -l app=order-api -n shop --all-containers=true --prefix
kubectl logs deployment/order-api -n shop              # Deployment의 Pod 하나
kubectl logs deployment/order-api -n shop --all-pods=true
```

| 옵션 | 레퍼런스 기준 |
|---|---|
| `-p`, `--previous` | 이전에 종료된 컨테이너의 로그 |
| `--tail` | 셀렉터가 없으면 기본 -1(전부), `-l` 셀렉터를 쓰면 기본 10줄 |
| `--prefix` | 각 줄 앞에 Pod와 컨테이너 이름 |
| `--max-log-requests` | 셀렉터로 여러 Pod를 볼 때 동시 요청 수. 기본 5 |
| `--all-pods` | `deployment/<이름>`처럼 리소스를 줄 때 모든 Pod |
| `--limit-bytes` | 출력 바이트 제한 |

### 4-3. CrashLoopBackOff를 로그로 읽기

Pod Lifecycle 문서는 `CrashLoopBackOff`를 "컨테이너가 크래시 루프에 빠져 재시작 지연(backoff)이 적용 중인 상태"로 설명합니다. 재시작 지연은 10초, 20초, 40초로 두 배씩 늘어 300초(5분)에서 멈추고 컨테이너가 10분 동안 문제없이 돌면 지연이 초기화됩니다. 문서가 드는 원인은 앱 오류로 인한 종료, 잘못된 환경 변수나 빠진 설정 파일 같은 설정 오류, 시작에 필요한 메모리나 CPU 부족, liveness나 startup probe 실패입니다.

문서의 조사 순서는 로그, 이벤트, 설정, 자원 한도입니다. 이것을 명령으로 옮기면 이렇습니다.

```bash
kubectl -n shop logs payment-xxxx --previous              # 죽기 직전 출력
kubectl -n shop describe pod payment-xxxx                 # Last State, Reason, Exit Code, Events
kubectl -n shop get pod payment-xxxx -o jsonpath='{.status.containerStatuses[0].lastState}'
kubectl -n shop get deploy payment -o yaml | grep -A5 -E 'command|args|env|resources|livenessProbe'
```

`--previous` 없이 `kubectl logs`를 치면 막 재시작된 새 컨테이너의 로그가 나오는데 대개 비어 있거나 짧습니다. 죽은 이유는 이전 인스턴스에 남아 있습니다.

Determine the Reason for Pod Failure 문서는 컨테이너가 `/dev/termination-log`에 쓴 종료 메시지를 `lastState.terminated.message`에서 읽는 방법을 보여 줍니다. `terminationMessagePolicy: FallbackToLogsOnError`를 주면 종료 메시지 파일이 비었고 컨테이너가 오류로 끝났을 때 로그 마지막 부분을 종료 메시지로 쓴다고 같은 문서가 설명합니다. 이때 로그는 2048바이트와 80줄 중 작은 쪽까지만 들어갑니다.

```bash
kubectl get pod <pod> -o go-template="{{range .status.containerStatuses}}{{.lastState.terminated.message}}{{end}}"
```

### 4-4. 셸이 없는 컨테이너

`kubectl exec`로 셸에 들어갈 수 없는 이미지(distroless 등)는 임시 컨테이너를 붙입니다. Debug Running Pods 문서의 예시입니다.

```bash
kubectl debug -it <pod> --image=busybox:1.28 --target=<컨테이너 이름>
```

`--target`은 대상 컨테이너의 프로세스 네임스페이스를 공유하게 합니다. 문서는 런타임이 `--target`을 지원해야 하고 지원하지 않으면 임시 컨테이너가 격리된 프로세스 네임스페이스로 뜰 수 있다고 적습니다. 임시 컨테이너는 v1.25부터 stable입니다. Pod를 복사해 명령이나 이미지를 바꿔 띄우는 `--copy-to`도 같은 문서에 있습니다.

```bash
kubectl debug payment-xxxx -it --copy-to=payment-debug --container=app -- sh
```

### 4-5. 사이드카로 로그 스트림 나누기

Logging Architecture 문서는 앱이 파일에 로그를 쓰는 경우의 해법으로 스트리밍 사이드카를 소개합니다. 사이드카 컨테이너가 공유 볼륨의 로그 파일을 읽어 자기 stdout으로 내보내면 `kubectl logs <pod> -c <사이드카>`로 볼 수 있습니다. 게시판 앱이 접근 로그를 파일로 쓰는 경우의 예입니다.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: board
  namespace: shop
spec:
  containers:
  - name: app
    image: busybox:1.28
    args: [/bin/sh, -c, 'i=0; while true; do echo "$i GET /board" >> /var/log/board/access.log; i=$((i+1)); sleep 1; done']
    volumeMounts:
    - name: logs
      mountPath: /var/log/board
  - name: access-log
    image: busybox:1.28
    args: [/bin/sh, -c, 'tail -n+1 -F /var/log/board/access.log']
    volumeMounts:
    - name: logs
      mountPath: /var/log/board
  volumes:
  - name: logs
    emptyDir: {}
```

```bash
kubectl -n shop logs board -c access-log
```

문서의 예는 같은 구조를 Pod의 일반 컨테이너 두 개로 보여 줍니다. 1.33에서 stable이 된 네이티브 사이드카(`initContainers`에 `restartPolicy: Always`)로 같은 일을 하는 예와 시작, 종료 순서는 [Ch-03 4-4절](/blog/cert/cka/cka-03-workloads-scheduling)에 정리했습니다. 네이티브 사이드카도 로그는 `kubectl logs <pod> -c <사이드카 이름>`으로 봅니다.

stdout과 stderr를 따로 받는 기능(`PodLogsQuerySplitStreams` 기능 게이트, `?stream=Stderr` 쿼리)도 문서에 있지만 알파 기능이라 시험 클러스터에서 켜져 있다고 기대하지 않습니다.

### 4-6. 자주 틀리는 지점

- 멀티 컨테이너 Pod에서 `-c` 없이 `kubectl logs`를 쳐서 엉뚱한 컨테이너 로그를 읽거나 오류를 받는 것.
- 재시작된 Pod에서 `--previous`를 빼먹는 것.
- 로그를 파일로 저장하라는 과제에서 다른 노드의 경로에 저장하는 것. 과제가 지정한 호스트에서 리다이렉트합니다.
- 컨트롤 플레인 구성요소 로그를 `journalctl -u kube-apiserver`로 찾는 것. kubeadm 클러스터에서 API 서버는 static Pod로 돌기 때문에 `kubectl logs`나 `crictl logs`로 봅니다.

### 4-7. 직접 해 보기

1. `command: ["sh","-c","echo start; exit 1"]`로 결제 Pod를 만들어 `CrashLoopBackOff`를 만들고 `kubectl logs`와 `kubectl logs --previous`의 차이를 봅니다. RESTARTS 수가 늘어나는 간격을 재서 문서의 10초, 20초, 40초와 비교합니다.
2. 4-5의 게시판 Pod를 만들고 `kubectl logs board -c app`이 비어 있는 이유를 설명합니다.
3. `kubectl logs -l app=order-api --all-containers=true --prefix --tail=5`로 여러 Pod의 로그를 한 번에 봅니다.

## 5. 서비스와 네트워킹 트러블슈팅

### 5-1. Debug Services 문서의 순서

Debug Services 문서는 질문을 하나씩 확인하는 순서로 짜여 있습니다. 앞 질문이 "예"여야 다음으로 넘어갑니다.

| 순서 | 질문 | 확인 명령 | "아니오"일 때 |
|---|---|---|---|
| 1 | Service가 존재하는지 | `kubectl get svc <svc>` | `kubectl expose`로 만든다 |
| 2 | 대상 Pod에 영향을 주는 NetworkPolicy Ingress 규칙이 있는지 | `kubectl get networkpolicy -n <ns>` | 규칙을 검토한다 |
| 3 | DNS 이름으로 동작하는지 | 클러스터 안 Pod에서 `nslookup <svc>`, `nslookup <svc>.<ns>` | 6절(Ch-04)의 DNS 순서 |
| 4 | Service IP로 동작하는지 | `wget -qO- <ClusterIP>:<port>` | 다음 단계로 원인 좁히기 |
| 5 | Service 정의가 맞는지 | `kubectl get svc <svc> -o yaml` | 포트, `targetPort`, 프로토콜, 이름 붙은 포트 확인 |
| 6 | EndpointSlice가 있는지 | `kubectl get endpointslices -l kubernetes.io/service-name=<svc>` | selector와 Pod 라벨 대조 |
| 7 | Pod 자체가 동작하는지 | 엔드포인트 IP와 Pod 포트로 직접 `wget` | 앱이나 컨테이너 포트 문제 |
| 8 | kube-proxy가 동작하는지 | 노드에서 kube-proxy 실행과 로그 | 프록시 모드, 규칙 생성 확인 |

5번의 점검 목록은 문서 원문을 옮긴 것입니다. 접근하려는 포트가 `spec.ports[]`에 있는지, `targetPort`가 Pod가 쓰는 포트인지, 숫자 포트를 의도했는데 문자열로 쓰지 않았는지, 이름 붙은 포트를 쓰면 Pod가 같은 이름의 포트를 노출하는지, 프로토콜이 맞는지입니다.

6번에서 ENDPOINTS가 `<none>`이면 Service의 `spec.selector`가 Pod의 `metadata.labels`를 실제로 고르는지 확인하라고 문서는 적습니다. 문서가 드는 흔한 실수는 Service는 `app=hostnames`를 고르는데 Deployment는 `run=hostnames`를 쓰는 경우입니다. 라벨은 맞는데 비어 있으면 readiness probe가 실패한 것입니다. Pod Lifecycle 문서는 readiness probe가 실패하면 EndpointSlice 컨트롤러가 그 Pod의 IP를 해당 Service들의 EndpointSlice에서 뺀다고 적습니다.

### 5-2. 쇼핑몰 예로 따라가기

주문 API Service `order-api`가 응답하지 않는다고 가정합니다.

```bash
# 1. 존재
kubectl -n shop get svc order-api

# 3, 4. 클러스터 안에서 이름과 IP로
kubectl -n shop run tmp --rm -it --restart=Never --image=busybox:1.28 -- sh
#   (Pod 안에서)
#   nslookup order-api
#   wget -qO- -T 2 order-api:80
#   wget -qO- -T 2 <ClusterIP>:80

# 5. 정의
kubectl -n shop get svc order-api -o yaml | grep -A8 -E 'ports:|selector:'

# 6. 엔드포인트와 라벨 대조
kubectl -n shop get endpointslices -l kubernetes.io/service-name=order-api
kubectl -n shop get pod --show-labels
kubectl -n shop get pod -l app=order-api       # Service selector 그대로

# 7. Pod 직접
kubectl -n shop get pod -l app=order-api -o wide
#   (임시 Pod 안에서) wget -qO- -T 2 <Pod IP>:<targetPort>

# 2. 정책
kubectl -n shop get networkpolicy
kubectl -n shop describe networkpolicy <이름>
```

순서를 문서와 조금 다르게 섞었습니다. 엔드포인트 확인(6번)이 selector, 라벨, readiness 문제를 한 번에 가르므로 이 글에서는 존재 확인 바로 다음에 두었습니다.

### 5-3. kube-proxy 확인

엔드포인트가 있고 Pod 직접 호출도 되는데 Service IP로만 안 되면 서비스 프록시를 의심합니다. Debug Services 문서는 노드에서 kube-proxy 프로세스가 도는지, 로그에 API 서버 연결 오류가 없는지 보라고 적습니다. kubeadm 클러스터에서 kube-proxy는 DaemonSet이므로 이렇게 봅니다.

```bash
kubectl -n kube-system get ds kube-proxy
kubectl -n kube-system get pod -l k8s-app=kube-proxy -o wide
kubectl -n kube-system logs <kube-proxy Pod>
kubectl -n kube-system get configmap kube-proxy -o yaml | grep mode
```

kubeadm Implementation details 문서는 kube-proxy를 DaemonSet으로 배포하고 API 서버 주소를 ConfigMap에서 읽게 한다고 적고 Troubleshooting kubeadm 문서의 예시 명령은 `kubectl -n kube-system patch ds kube-proxy`입니다. Pod 라벨 `k8s-app=kube-proxy`와 ConfigMap 이름 `kube-proxy`는 kubeadm 기본값으로 알려진 값이며 문서로 확인하지 않았습니다. 시험장에서는 `kubectl -n kube-system get ds,cm`으로 이름부터 확인합니다.

문서의 로그 예시에서 `Using iptables Proxier`가 보이면 iptables 모드입니다. iptables 모드라면 노드에서 `iptables-save | grep <svc 이름>`으로 Service용 규칙이 생겼는지 봅니다(Debug Services 문서의 iptables 절).

클러스터가 kube-proxy를 쓰지 않으면 이 절은 적용되지 않고 대신 쓰는 서비스 구현체를 조사해야 한다고 문서는 적습니다.

### 5-4. 그 밖의 경우

| 증상 | 확인 |
|---|---|
| Pod가 자기 Service IP로 자신에게 접속 못 함 | hairpin 모드. Troubleshooting kubeadm 문서는 많은 네트워크 애드온이 hairpin 모드를 켜지 않는다고 적는다 |
| 특정 노드의 Pod끼리만 통신 실패 | 그 노드의 CNI 플러그인 Pod, 노드 조건 `NetworkUnavailable` |
| NodePort로 외부 접속 실패 | `nodePort` 번호, 노드 방화벽, `externalTrafficPolicy: Local`인데 그 노드에 엔드포인트가 없는지 |
| Ingress나 Gateway 경유 실패 | 백엔드 Service부터 위 순서로 확인한 뒤 Ingress의 `ingressClassName`, HTTPRoute의 `Accepted`와 `ResolvedRefs` 조건 |
| 갑자기 모든 이름 해석 실패 | CoreDNS Pod, Corefile, Egress NetworkPolicy([Ch-04 6-6절](/blog/cert/cka/cka-04-services-networking)) |

### 5-5. 자주 틀리는 지점

- Service를 고치려고 지우고 다시 만들면서 ClusterIP가 바뀌는 것. 고정 IP를 기대하는 설정이 있다면 `kubectl edit`으로 고칩니다.
- 임시 Pod를 기본 네임스페이스에 만들어 짧은 이름으로 다른 네임스페이스의 Service를 찾는 것. `-n`을 맞추거나 `<svc>.<ns>`로 부릅니다.
- 테스트용 임시 Pod를 지우지 않아 채점에 영향을 주는 것. `--rm`을 붙입니다.
- `nslookup`이 성공했으니 Service도 정상이라고 판단하는 것. DNS는 ClusterIP만 알려 줄 뿐이고 엔드포인트가 비어 있어도 이름은 풀립니다.

### 5-6. 직접 해 보기

1. `order-api` Service의 selector를 일부러 `app=order`로 바꾸고 5-2의 순서로 원인을 찾습니다. 몇 번째 명령에서 원인이 드러났는지 기록합니다.
2. `targetPort`를 존재하지 않는 포트로 바꾸고 엔드포인트는 있는데 요청이 실패하는 것을 확인합니다.
3. 주문 API에 실패하는 readiness probe를 붙여 READY `0/1`과 빈 ENDPOINTS를 함께 관찰합니다.

## 6. 확인 문제

직접 만든 연습 과제입니다. 시험 문항이나 덤프에서 옮긴 것이 아닙니다.

**문제 1.** 워커 노드 `node02`가 `NotReady`입니다. `kubectl describe node node02`의 조건 메시지는 `Kubelet stopped posting node status.`입니다. 해결 순서를 적으세요.

<details>
<summary>답 보기</summary>

1. `ssh node02`로 들어갑니다.
2. `sudo systemctl status kubelet`으로 kubelet이 멈췄는지, 실패했는지 봅니다.
3. `sudo journalctl -u kubelet --no-pager | tail -50`으로 실패 이유를 읽습니다. 설정 파일(`/var/lib/kubelet/config.yaml`) 오류, kubeconfig(`/etc/kubernetes/kubelet.conf`)나 인증서 경로, 런타임 엔드포인트를 의심합니다.
4. 원인을 고치고 `sudo systemctl restart kubelet`, 꺼져 있었다면 `sudo systemctl enable --now kubelet`을 합니다.
5. `exit`로 돌아와 `kubectl get nodes`로 `Ready`를 확인합니다.

</details>

**문제 2.** `kubectl get pod` 명령이 API 서버에 연결하지 못합니다. 컨트롤 플레인 노드에서 무엇을 보나요?

<details>
<summary>답 보기</summary>

```bash
sudo crictl ps -a | grep kube-apiserver
sudo crictl logs <가장 최근 컨테이너 ID>
sudo journalctl -u kubelet --no-pager | tail -30
sudo cat /etc/kubernetes/manifests/kube-apiserver.yaml
```

로그에서 가리키는 플래그나 경로를 매니페스트에서 고칩니다. 고치기 전에 매니페스트를 `/etc/kubernetes/manifests` 밖에 백업합니다. kubelet이 변경을 감지해 컨테이너를 다시 띄우면 `crictl ps`에 새 컨테이너가 보이고 `kubectl`이 다시 동작합니다.

</details>

**문제 3.** 네임스페이스 `shop`의 `payment` Pod가 `CrashLoopBackOff`입니다. 컨테이너는 하나이고 이름은 `app`입니다. 죽기 직전 로그를 `/opt/payment-crash.log`에 저장하세요.

<details>
<summary>답 보기</summary>

```bash
kubectl -n shop logs <payment Pod 이름> -c app --previous > /opt/payment-crash.log
```

`--previous`가 핵심입니다. 과제가 지정한 호스트에서 실행해야 파일이 그 호스트에 생깁니다.

</details>

**문제 4.** 모든 네임스페이스에서 메모리를 가장 많이 쓰는 Pod의 이름을 `/opt/top-mem.txt`에 적으세요.

<details>
<summary>답 보기</summary>

```bash
kubectl top pod -A --sort-by=memory --no-headers | head -1
# 출력의 두 번째 열(NAME)을 확인해 기록
kubectl top pod -A --sort-by=memory --no-headers | head -1 | awk '{print $2}' > /opt/top-mem.txt
```

`-A`이면 첫 열이 NAMESPACE라 이름은 두 번째 열입니다. metrics-server가 없으면 이 명령이 실패하므로 3-4절 순서로 먼저 확인합니다.

</details>

**문제 5.** 컨트롤 플레인 노드에서 kube-scheduler 매니페스트를 고치려고 `cp kube-scheduler.yaml kube-scheduler.yaml.bak`을 `/etc/kubernetes/manifests` 안에서 실행했습니다. 무엇이 문제인가요?

<details>
<summary>답 보기</summary>

kubelet은 점으로 시작하지 않는 모든 파일을 static Pod 매니페스트로 읽고 확장자로 거르지 않습니다. 같은 이름의 Pod를 정의한 파일이 둘이 되어 동작이 정의되지 않고 백업의 옛 스펙이 적용될 수도 있습니다. 백업은 `/etc/kubernetes/backup/`처럼 디렉터리 밖에 둡니다.

</details>

**문제 6.** `board` Service의 ENDPOINTS가 비어 있습니다. Pod는 3개 모두 `Running`이고 READY는 `0/1`입니다. 원인과 확인 방법은요?

<details>
<summary>답 보기</summary>

READY `0/1`은 readiness probe가 실패하고 있다는 뜻이고 실패한 Pod의 IP는 EndpointSlice에서 빠집니다. `kubectl describe pod`의 Events에서 readiness 실패 메시지를 읽고 probe의 경로, 포트, 지연 시간을 앱과 대조합니다. selector 문제라면 READY는 `1/1`인데 엔드포인트만 비어 있었을 것입니다.

</details>

**문제 7.** 새 Deployment `board`를 만들었는데 ReplicaSet은 있고 Pod 객체가 하나도 생기지 않습니다. 반대로 Pod 객체는 생겼는데 모두 `Pending`이고 Events에 아무것도 없다면 어떤가요? 각각 어느 구성요소를 보나요?

<details>
<summary>답 보기</summary>

Pod 객체가 생기지 않으면 ReplicaSet 컨트롤러가 일하지 않는 것이므로 kube-controller-manager를 봅니다. Pod는 있는데 Events 없이 `Pending`이면 스케줄러가 노드를 정하지 않은 것이므로 kube-scheduler를 봅니다. 둘 다 `kubectl -n kube-system get pod`로 상태를 보고 `kubectl logs` 또는 `crictl logs`로 원인을 찾은 뒤 `/etc/kubernetes/manifests`의 매니페스트를 고칩니다.

</details>

## 7. 범위와 한계

- 이 글의 명령은 문서를 읽고 정리한 것이며 이 글을 쓰는 환경에는 클러스터가 없어 직접 실행하지 않았습니다. 출력 예시는 kubernetes.io 문서에 실린 것이고 그렇게 표시했습니다. 각 절의 "직접 해 보기"는 연습 클러스터를 만든 뒤 할 목록이며 결과는 나중에 덧붙입니다.
- kubernetes.io 문서는 2026년 10월 19일에 kubernetes/website 저장소의 main 브랜치 원문으로 읽었습니다. Metrics API의 1.37 stable 표시와 `metrics.k8s.io/v1` 경로는 이 원문 기준이며 시험 클러스터의 metrics-server가 어느 버전을 제공하는지는 확인하지 못했습니다.
- kube-proxy의 Pod 라벨과 ConfigMap 이름, metrics-server의 Deployment 이름, `/var/log/pods`의 하위 경로 규칙, `systemctl cat`은 이번에 문서로 확인하지 못했습니다.
- 0-2 표의 "흔한 원인" 열과 2-5 표의 매니페스트 점검 위치는 문서 내용에 제 판단을 더한 것입니다. 실제 시험에 어떤 고장이 나오는지는 공개되지 않았고 후기의 출제 문항은 옮기지 않았습니다.
- etcd 백업과 복구, kubeadm 업그레이드는 [Ch-00](/blog/cert/cka/cka-00-exam-and-study-plan)에서 정리한 대로 커리큘럼 명시 항목에서 빠져 이 글에서는 다루지 않았습니다. 절차는 [Ch-02 4절](/blog/cert/cka/cka-02-cluster-architecture)에 있습니다.

## 참고 자료

시험 범위
- CNCF, [CKA Curriculum v1.37](https://github.com/cncf/curriculum/blob/master/CKA_Curriculum_v1.37.pdf)

kubernetes.io
- [Troubleshooting Clusters](https://kubernetes.io/docs/tasks/debug/debug-cluster/)
- [Debug Pods](https://kubernetes.io/docs/tasks/debug/debug-application/debug-pods/)
- [Debug Running Pods](https://kubernetes.io/docs/tasks/debug/debug-application/debug-running-pod/)
- [Debug Services](https://kubernetes.io/docs/tasks/debug/debug-application/debug-service/)
- [Determine the Reason for Pod Failure](https://kubernetes.io/docs/tasks/debug/debug-application/determine-reason-pod-failure/)
- [Debugging Kubernetes nodes with crictl](https://kubernetes.io/docs/tasks/debug/debug-cluster/crictl/)
- [Resource metrics pipeline](https://kubernetes.io/docs/tasks/debug/debug-cluster/resource-metrics-pipeline/)
- [Logging Architecture](https://kubernetes.io/docs/concepts/cluster-administration/logging/)
- [kubectl Quick Reference](https://kubernetes.io/docs/reference/kubectl/quick-reference/), [JSONPath Support](https://kubernetes.io/docs/reference/kubectl/jsonpath/)
- [Pod Lifecycle](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/)
- [Images](https://kubernetes.io/docs/concepts/containers/images/)
- [Node Status](https://kubernetes.io/docs/reference/node/node-status/)
- [Nodes](https://kubernetes.io/docs/concepts/architecture/nodes/)
- [Safely Drain a Node](https://kubernetes.io/docs/tasks/administer-cluster/safely-drain-node/)
- [Static Pods](https://kubernetes.io/docs/concepts/workloads/pods/static-pods/)
- [Create static Pods](https://kubernetes.io/docs/tasks/configure-pod-container/static-pod/)
- [Implementation details](https://kubernetes.io/docs/reference/setup-tools/kubeadm/implementation-details/) (kubeadm)
- [Configuring each kubelet in your cluster using kubeadm](https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/kubelet-integration/)
- [Troubleshooting kubeadm](https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/troubleshooting-kubeadm/)
- kubernetes-sigs/cri-tools, [docs/crictl.md](https://github.com/kubernetes-sigs/cri-tools/blob/master/docs/crictl.md)
- [Certificate Management with kubeadm](https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/kubeadm-certs/)
- kubectl 레퍼런스: [kubectl logs](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_logs/), [kubectl top pod](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_top/kubectl_top_pod/), [kubectl top node](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_top/kubectl_top_node/), [kubectl debug](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_debug/)

이 블로그의 관련 글
- [CKA Ch-01: OOMKilled와 Exit Code 137](/blog/cert/cka/cka-01-why-kubernetes)
- [DE Ch-07: Pod가 컨테이너를 시작하기까지](/blog/data/orchestration/de-07-task-per-pod-cost)

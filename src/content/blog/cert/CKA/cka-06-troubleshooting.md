---
title: '[CKA Ch-06] 트러블슈팅: 증상에서 출발해 kubelet과 로그까지 내려가는 순서'
description: CKA 커리큘럼 v1.37에서 비중이 가장 큰 Troubleshooting 영역(30%)을 증상, 확인 명령, 고칠 곳 순서로 정리합니다. 노드 NotReady와 kubelet 인증서, static Pod 컨트롤 플레인과 crictl, kubectl top과 Metrics API 버전, JSONPath 값 뽑기, kubectl logs, Service에서 EndpointSlice까지의 점검을 다룹니다.
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

1. 트러블슈팅은 증상에서 출발해 한 층씩 내려갑니다. `kubectl get`으로 상태 보기, `kubectl describe`의 Events 읽기, `kubectl logs`로 컨테이너 출력 보기, 노드에 ssh로 들어가 `journalctl -u kubelet`과 `crictl` 보기 순서입니다. 0절의 판단 표가 이 순서를 증상별로 정리한 것입니다.
2. kubeadm 클러스터의 컨트롤 플레인 구성요소(kube-apiserver, kube-controller-manager, kube-scheduler, etcd)는 `/etc/kubernetes/manifests`의 static Pod입니다. 매니페스트를 고치면 kubelet이 다시 띄웁니다. API 서버가 죽어 `kubectl`이 안 되면 노드에서 `crictl ps -a`와 `crictl logs`, 또는 `/var/log/pods`의 파일을 봅니다.
3. kubelet과 컨테이너 런타임은 systemd 서비스입니다. 노드가 `NotReady`이면 그 노드에서 `systemctl status kubelet`과 `journalctl -u kubelet`부터 봅니다. kubeadm이 쓰는 kubelet 설정 파일은 `/var/lib/kubelet/config.yaml`입니다.
4. `kubectl top`은 metrics-server(또는 Metrics API를 제공하는 다른 어댑터)가 있어야 동작합니다. `--sort-by`는 `cpu`와 `memory`만 받고 메모리 수치는 working set 기준입니다.
5. 재시작된 컨테이너의 이전 로그는 `kubectl logs --previous`로 봅니다. 멀티 컨테이너 Pod에서 `-c`를 빼면 오류 없이 기본 컨테이너의 로그가 나오니 `Defaulted container` 안내를 보면 `-c`를 붙입니다.

---

커리큘럼 원문(CNCF, CKA Curriculum v1.37)의 Troubleshooting 항목은 다섯 개이고 이 글의 1~5절이 차례로 대응합니다. 0절은 다섯 항목에 앞서 증상별 판단 표를 둡니다.

| 순서 | 커리큘럼 원문 | 이 글의 절 |
|---|---|---|
| 1 | Troubleshoot clusters and nodes | 1. 클러스터와 노드 |
| 2 | Troubleshoot cluster components | 2. 클러스터 구성요소 |
| 3 | Monitor cluster and application resource usage | 3. 리소스 사용량 모니터링 |
| 4 | Manage and evaluate container output streams | 4. 컨테이너 출력 스트림 |
| 5 | Troubleshoot services and networking | 5. 서비스와 네트워킹 |

예시는 가상의 쇼핑몰입니다. 네임스페이스 `shop`에 주문 API(`order-api`), 결제(`payment`), 게시판(`board`)이 있습니다. [Ch-00](/blog/cert/cka/cka-00-exam-and-study-plan)에서 정리한 후기들이 공통으로 꼽은 어려움이 트러블슈팅에서 시간을 잃은 것이었습니다. 그래서 이 글은 "어디부터 볼지"를 정하는 데 비중을 둡니다.

## 0. 증상에서 출발하는 판단 표

### 0-1. 첫 3분

어떤 과제든 처음 세 명령은 같습니다.

```bash
kubectl get pod -n <ns> -o wide          # STATUS, RESTARTS, 노드
kubectl describe pod <pod> -n <ns>       # 맨 아래 Events
kubectl get events -n <ns> --sort-by=.metadata.creationTimestamp
```

이벤트는 네임스페이스 단위입니다(Debug Running Pods 문서). 다른 네임스페이스는 `-n`, 전체는 `-A`를 줍니다.

### 0-2. 증상별 판단 표

| 증상 | 의미(문서 기준) | 먼저 볼 것 | 흔한 원인 | 이 글의 절 |
|---|---|---|---|---|
| Pod `Pending` | 노드에 스케줄되지 못함 | `describe pod` Events의 `FailedScheduling` 메시지 | 자원 요청이 어느 노드에도 안 맞음, 노드 셀렉터나 어피니티 불일치, 테인트, `hostPort` 충돌, PVC `Pending` | 0-3 |
| `ContainerCreating`에 오래 머묾 | 노드에 배정됐지만 컨테이너를 못 만듦 | Events | 볼륨 마운트 실패, CNI 문제, Secret이나 ConfigMap 없음 | 1, 5 |
| `ErrImagePull`, `ImagePullBackOff` | 이미지를 받지 못해 `Waiting`. 재시도 간격이 늘어나 최대 300초 | Events의 pull 오류 | 이미지 이름이나 태그 오타, 레지스트리에 없음, 비공개 레지스트리인데 `imagePullSecrets` 없음 | 0-4 |
| `CrashLoopBackOff` | 시작했다 종료되기를 반복. 재시작 지연이 10초부터 두 배씩 늘어 300초에서 멈춤 | `kubectl logs --previous`, `describe`의 Last State와 Exit Code | 앱 오류, 잘못된 command나 args, 설정 누락, liveness probe 실패, 메모리 부족 | 4 |
| `OOMKilled`(Exit Code 137) | 메모리 한도를 넘어 커널이 종료 | `describe`의 Last State Reason | `limits.memory`가 실제 사용량보다 작음 | 3-3 |
| `Running`인데 READY `0/1` | readiness probe 실패. EndpointSlice에서 빠져 트래픽을 받지 않음 | `describe`의 Readiness 이벤트 | probe 경로나 포트 오류 | 5 |
| `Terminating`에 멈춤 | 삭제는 요청됐지만 객체를 지우지 못함 | Pod의 finalizers, 웹훅 | finalizer 제거를 막는 admission 웹훅 | 0-5 |
| 노드 `NotReady` | 노드 컨트롤러가 kubelet의 상태 보고를 받지 못함 | 그 노드에서 `systemctl status kubelet`, `journalctl -u kubelet` | kubelet 중지, 설정 파일 오류, 런타임 중지, 인증서 문제, CNI 미설치 | 1 |
| `kubectl`이 API 서버에 연결 못 함 | API 서버 응답 없음 | 컨트롤 플레인 노드의 `crictl ps -a`, `kube-apiserver.yaml` | 매니페스트 오타, 인증서 경로, etcd 주소 | 2 |
| Deployment는 있는데 Pod가 0개 | 컨트롤러가 Pod 객체를 만들지 않음 | `kube-system`의 kube-controller-manager Pod | static Pod 매니페스트 오류 | 2 |
| Service가 응답 없음, 엔드포인트 없음 | selector가 Pod를 못 고르거나 Pod가 Ready 아님 | `kubectl get endpointslices -l kubernetes.io/service-name=<svc>` | selector와 라벨 불일치, `targetPort` 오류, readiness 실패 | 5 |
| 이름 해석 실패 | CoreDNS 경로 어딘가의 문제 | `nslookup kubernetes.default`, CoreDNS Pod와 `kube-dns` Service | CoreDNS 다운, Corefile 오류, Egress NetworkPolicy가 DNS 차단 | 5, [Ch-04](/blog/cert/cka/cka-04-services-networking) |
| `kubectl top` 실패 | Metrics API 없음 | `kubectl get apiservice`, metrics-server Pod | metrics-server 미설치, kubelet 인증서 검증 실패 | 3 |

### 0-3. Pending

Debug Pods 문서는 `Pending`을 "노드에 스케줄할 수 없는 상태"로 정의하고 원인으로 자원 부족과 `hostPort` 충돌을 듭니다. 시험에서 더 자주 보는 것은 Workloads 영역과 겹치는 원인입니다. `nodeSelector`의 라벨이 어느 노드에도 없거나, 노드에 테인트가 있는데 톨러레이션이 없거나, 쓰는 PVC가 `Pending`인 경우입니다. PVC가 원인이면 [Ch-05](/blog/cert/cka/cka-05-storage)의 PVC 바인딩 점검으로 넘어갑니다.

```bash
kubectl describe pod order-api-xxxx -n shop | sed -n '/Events/,$p'
kubectl describe node <노드> | grep -A5 Taints
kubectl get node --show-labels
```

### 0-4. ImagePullBackOff

Images 문서는 이유로 잘못된 이미지 이름과 `imagePullSecret` 없이 비공개 레지스트리에서 받으려 한 경우를 듭니다. Debug Pods 문서의 점검 목록은 이미지 이름이 맞는지, 레지스트리에 있는지, 직접 pull해서 받아지는지 세 가지입니다.

```bash
kubectl -n shop get pod order-api-xxxx -o jsonpath='{.spec.containers[*].image}'
kubectl -n shop set image deployment/order-api order-api=nginx:1.27   # 이미지 이름을 고칠 때
sudo crictl pull nginx:1.27                                            # 노드에서 직접 받아 보기
```

### 0-5. Terminating에 멈춤

Debug Pods 문서는 흔한 원인으로 finalizer와 finalizer 제거를 막는 admission 웹훅을 듭니다. `pods`의 `UPDATE`를 대상으로 하는 웹훅 설정이 있는지 봅니다.

```bash
kubectl get validatingwebhookconfigurations,mutatingwebhookconfigurations
kubectl -n shop get pod board-xxxx -o jsonpath='{.metadata.finalizers}'
```

### 0-6. Running인데 기대와 다르게 동작

Pod 명세에 오타가 있으면 그 키가 조용히 무시될 수 있습니다. `command`를 `commnd`로 쓰면 Pod는 만들어지지만 의도한 명령을 쓰지 않습니다. Debug Pods 문서는 `kubectl apply --validate -f mypod.yaml`로 다시 만들고 `kubectl get pods/mypod -o yaml`로 저장된 내용과 원본을 비교하라고 권합니다.

## 1. 클러스터와 노드

### 1-1. 노드 목록부터

Troubleshooting Clusters 문서의 첫 단계는 노드가 모두 등록됐고 `Ready`인지 보는 것입니다.

```bash
kubectl get nodes
kubectl describe node <노드>
kubectl get node <노드> -o yaml
```

### 1-2. 노드 조건과 하트비트

Node Status 문서의 조건 표입니다.

| 조건 | 뜻 |
|---|---|
| `Ready` | `True`면 정상. `False`면 비정상. `Unknown`이면 노드 컨트롤러가 `node-monitor-grace-period`(기본 50초) 동안 노드 소식을 듣지 못함 |
| `DiskPressure` | 디스크 용량 부족 |
| `MemoryPressure` | 노드 메모리 부족 |
| `PIDPressure` | 프로세스가 너무 많음 |
| `NetworkUnavailable` | 노드 네트워크가 제대로 설정되지 않음. 이 조건을 설정하는 구성요소(클라우드 라우트 컨트롤러나 일부 CNI)가 있을 때만 보임 |

kubelet은 `kube-node-lease` 네임스페이스의 Lease를 기본 10초마다, Node의 `.status`는 변화가 없으면 기본 5분마다 갱신합니다. `Ready`가 grace period보다 오래 `Unknown`이나 `False`이면 `node.kubernetes.io/unreachable` 또는 `not-ready` 테인트가 붙고 Pod의 기본 톨러레이션(300초)이 지나면 축출됩니다. kubelet을 멈춘 노드의 `describe`는 이렇게 나옵니다(kind v1.37.0 워커에서 확인).

```
Taints:             node.kubernetes.io/unreachable:NoExecute
                    node.kubernetes.io/unreachable:NoSchedule
...
  Ready                Unknown   ...   NodeStatusUnknown   Kubelet stopped posting node status.
```

`Kubelet stopped posting node status.`가 보이면 원인은 노드 쪽이니 그 노드로 들어갑니다. kind 워커 컨테이너를 멈췄을 때는 약 45초 안에 `Unknown`과 테인트가 붙었고 기본 톨러레이션 Pod는 약 300초 뒤 `Terminating`이 되어 노드가 돌아올 때까지 그 상태로 남았습니다.

kind 워커의 `evictionHard`에 가용량보다 큰 `memory.available`을 넣어 압박을 만들면 노드에 `MemoryPressure True ... KubeletHasInsufficientMemory`와 `node.kubernetes.io/memory-pressure:NoSchedule` 테인트가 생겼습니다. 축출된 Pod의 메시지는 `The node was low on resource: memory. Threshold quantity: ...`이고 압박 중 kubelet이 다시 받는 BestEffort Pod는 `Pod was rejected: The node had condition: [MemoryPressure].`로 거절됐습니다. 둘 다 `.status.reason`은 `Evicted`인데 STATUS 열은 `Error`나 `ContainerStatusUnknown`이라 `--field-selector status.phase=Failed`로 찾습니다.

### 1-3. 노드 안에서 볼 것

시험 환경은 과제마다 지정된 호스트에 `ssh`로 들어가고 권한이 필요하면 `sudo`를 씁니다. ssh 안에서 다시 ssh할 수는 없습니다.

```bash
ssh <노드>
sudo systemctl status kubelet
sudo journalctl -u kubelet --no-pager | tail -50
sudo systemctl restart kubelet
sudo systemctl enable --now kubelet      # 꺼져 있고 부팅 시 자동 시작도 꺼져 있을 때
```

kubeadm이 kubelet에 넘기는 파일은 Configuring each kubelet in your cluster using kubeadm 문서에 있습니다.

| 파일 | 역할 |
|---|---|
| `/var/lib/kubelet/config.yaml` | kubelet 설정 파일(KubeletConfiguration) |
| `/etc/kubernetes/kubelet.conf` | kubelet 고유 신원이 담긴 kubeconfig |
| `/etc/kubernetes/bootstrap-kubelet.conf` | TLS 부트스트랩용. `kubelet.conf`가 없을 때만 사용 |
| `/var/lib/kubelet/kubeadm-flags.env` | `kubeadm init`, `join`이 만드는 `KUBELET_KUBEADM_ARGS`. kubeadm 1.36~1.37에서는 비어 있을 수 있고 런타임 소켓은 같은 디렉터리의 `instance-config.yaml`(`containerRuntimeEndpoint`)에 있음(Lima VM에서 확인) |
| `/etc/default/kubelet`(DEB), `/etc/sysconfig/kubelet`(RPM) | 사용자 재정의 `KUBELET_EXTRA_ARGS`. 우선순위가 가장 높음 |

systemd drop-in의 경로는 설치 방법마다 다르니 `systemctl cat kubelet`으로 실제 위치를 봅니다. pkgs.k8s.io 패키지 설치에서는 `/usr/lib/systemd/system/kubelet.service.d/10-kubeadm.conf`였습니다. drop-in을 고쳤으면 `systemctl daemon-reload` 뒤 `systemctl restart kubelet`을 하고 `kubectl get nodes`로 Ready를 확인합니다.

### 1-4. kubelet 설정 파일 오류와 인증서 만료

`systemctl status kubelet`이 `activating (auto-restart)`를 반복하면 kubelet이 시작 단계에서 죽고 있습니다. `config.yaml`의 들여쓰기를 망가뜨리면 `journalctl -u kubelet`에 이런 줄이 반복됩니다(kind v1.37.0, Lima VM kubeadm 1.37.1에서 확인).

```
"command failed" err="failed to load kubelet config file, path: /var/lib/kubelet/config.yaml, error: ... yaml: line 36: mapping values are not allowed in this context"
```

노드 안에서 볼 순서입니다. 명령은 노드에서 `sudo`로 실행합니다.

| 순서 | 확인 | 명령 | 이상하면 |
|---|---|---|---|
| 1 | 노드 자원 | `df -h`, `free -m` | 디스크나 메모리가 바닥이면 `DiskPressure`, `MemoryPressure`와 맞춰 보고 공간부터 확보 |
| 2 | 런타임 | `systemctl status containerd`, `crictl info` | 런타임이 죽어 있으면 kubelet도 Pod를 만들지 못함 |
| 3 | kubelet 로그의 첫 오류 | `journalctl -u kubelet -n 50 --no-pager` | 재시작 루프면 같은 오류가 반복됨. 맨 처음 오류 줄을 읽음 |
| 4 | 설정 파일 경로와 내용 | `systemctl cat kubelet`, `cat /var/lib/kubelet/config.yaml` | drop-in의 `--config`, `--kubeconfig` 경로가 실제 파일과 맞는지, YAML 문법과 필드 이름 |
| 5 | kubeconfig의 API 서버 주소 | `grep server /etc/kubernetes/kubelet.conf` | 주소나 포트(kubeadm 기본 6443)가 틀리면 연결 거부가 로그에 남음 |
| 6 | 클라이언트 인증서 | `openssl x509 -in /var/lib/kubelet/pki/kubelet-client-current.pem -noout -subject -issuer -dates` | 만료됐거나 subject, issuer가 아래와 다르면 인증서 복구 |

버전에 따른 원인도 있습니다. 1.35부터 kubelet의 `failCgroupV1` 기본값이 `true`라 cgroup v1 노드에서는 기본으로 시작하지 않습니다(cgroups 문서). 스왑이 켜진 노드에서 기본 설정의 kubelet이 시작하지 않는 동작도 그대로입니다. 두 경우 모두 로그에 원인이 문장으로 남습니다.

인증서 쪽은 Certificate Management with kubeadm, Troubleshooting kubeadm 문서를 따릅니다.

- kubeadm은 kubelet 클라이언트 인증서를 자동 교체하게 설정합니다. `/etc/kubernetes/kubelet.conf`가 `/var/lib/kubelet/pki/kubelet-client-current.pem`을 가리키고 kubelet이 만료 전에 새 인증서를 받아 이 링크를 바꿉니다.
- 그래서 `kubeadm certs check-expiration` 목록에 `kubelet.conf`가 없고 `kubeadm certs renew all`도 이 인증서를 갱신하지 않습니다. 만료는 표 6번의 `openssl`로 직접 봅니다.
- 정상 subject는 `O = system:nodes, CN = system:node:<노드 이름>`이고 issuer는 클러스터 CA입니다. Node 인가자와 RBAC가 이 그룹과 이름으로 kubelet을 알아보므로 둘이 다르면 인증은 돼도 권한 오류가 납니다.
- "not yet valid"는 노드 시계가 인증서 시작 시각보다 이를 때도 나오니 `date`도 봅니다.

인증서가 만료되면 로그가 단계별로 바뀝니다(Lima VM kubeadm 1.37.1 단일 노드에서 시계를 옮겨 확인).

| 시점 | 로그 | 뜻 |
|---|---|---|
| 만료 직후 | kubelet: `"Failed to update lease" err="... x509: certificate has expired or is not yet valid ..."`, kube-apiserver: `"Unable to authenticate the request" err="[x509: certificate has expired or is not yet valid: ...]"` | 서빙 인증서와 클라이언트 인증서가 모두 만료 |
| `kubeadm certs renew all`과 컨트롤 플레인 재시작 뒤 | kubelet: `User "system:anonymous" cannot get resource "leases"` | 컨트롤 플레인 인증서만 갱신됐고 kubelet 인증서는 그대로. 노드 `NotReady` |
| 그 상태에서 kubelet 재시작 | `part of the existing bootstrap client certificate in /etc/kubernetes/kubelet.conf is expired`, `unable to load bootstrap kubeconfig: stat /etc/kubernetes/bootstrap-kubelet.conf: no such file or directory` | kubelet이 기동하지 못함. 아래 절차로 복구 |

Troubleshooting kubeadm 문서의 복구 절차를 줄이면 이렇습니다.

1. 고장 난 노드에서 `/etc/kubernetes/kubelet.conf`와 `/var/lib/kubelet/pki/kubelet-client*`를 백업하고 지웁니다.
2. `/etc/kubernetes/pki/ca.key`가 있는 컨트롤 플레인 노드에서 새 kubeconfig를 만듭니다. `server`와 클러스터 이름은 원래 `kubelet.conf`에 맞춥니다.
3. 만든 파일을 고장 난 노드의 `/etc/kubernetes/kubelet.conf`로 복사하고 kubelet을 재시작합니다.
4. `/var/lib/kubelet/pki/kubelet-client-current.pem`이 다시 생기면 `kubelet.conf`의 `client-certificate-data`, `client-key-data`를 아래 두 줄로 바꿉니다.
5. kubelet을 다시 재시작하고 노드가 `Ready`인지 봅니다.

```bash
# 2번: 컨트롤 플레인 노드에서 (NODE는 고장 난 노드 이름)
sudo kubeadm kubeconfig user --org system:nodes --client-name system:node:$NODE > kubelet.conf
```

```yaml
# 4번: kubelet.conf의 users 항목
    client-certificate: /var/lib/kubelet/pki/kubelet-client-current.pem
    client-key: /var/lib/kubelet/pki/kubelet-client-current.pem
```

kind v1.37.0 워커와 만료시킨 Lima VM 모두 이 절차 뒤 새 CSR이 자동 승인되고 노드가 `Ready`로 돌아왔습니다.

kubelet 서빙 인증서는 별개입니다. kubeadm이 배포하는 서빙 인증서는 기본이 자체 서명이고 이것이 3-4절 metrics-server `x509` 오류의 원인입니다. `serverTLSBootstrap: true`로 클러스터 CA 서명 인증서를 받게 하면 그 CSR은 자동 승인되지 않아 `kubectl certificate approve`로 승인합니다.

### 1-5. kubectl debug로 노드 들여다보기

ssh를 쓸 수 없으면 Debug Running Pods 문서의 노드 디버그를 씁니다.

```bash
kubectl debug node/<노드> -it --image=ubuntu
```

노드의 루트 파일시스템이 `/host`에 마운트되고 호스트의 IPC, 네트워크, PID 네임스페이스에서 돕니다. 특권 Pod가 아니라서 `chroot /host` 같은 일부 동작이 실패할 수 있고 그때는 `--profile=sysadmin`을 씁니다. 끝나면 디버그 Pod를 지웁니다.

### 1-6. 노드를 서비스에서 빼고 넣기

```bash
kubectl cordon <노드>                         # 새 Pod 배치 금지
kubectl drain --ignore-daemonsets <노드>      # Pod 축출. DaemonSet Pod는 건너뜀
kubectl uncordon <노드>                       # 다시 배치 허용
```

DaemonSet Pod가 있으면 `--ignore-daemonsets`가 있어야 drain이 성공합니다(Safely Drain a Node 문서). cordon된 노드는 출력에 `SchedulingDisabled`로 보이고 Node Status 문서는 이것이 조건 목록에 없는 출력용 표시라고 적습니다.

### 1-7. 자주 틀리는 지점

- `systemctl restart kubelet`만 하고 `enable`을 빠뜨립니다. 과제가 "재부팅 뒤에도 유지"를 요구하면 enable 상태까지 확인합니다.
- 다른 노드에서 고칩니다. 과제마다 지정된 호스트가 있고 kubelet은 각 노드에서 따로 돕니다. 워커 NotReady는 그 워커에서 고칩니다.
- 노드 조건이 `NetworkUnavailable`이거나 kubelet 로그에 CNI 오류가 있는데 kubelet만 재시작합니다. 네트워크 플러그인 Pod 상태를 함께 봅니다.
- `kubeadm certs check-expiration`만 보고 kubelet 인증서가 정상이라고 판단합니다.

### 1-8. 직접 해 보기

1. 워커에서 `sudo systemctl stop kubelet`을 하고 `kubectl get nodes -w`로 `Unknown`이 되는 시점과 테인트를 봅니다.
2. `/var/lib/kubelet/config.yaml`을 백업한 뒤 들여쓰기를 망가뜨리고 `journalctl -u kubelet`에서 오류 줄을 찾아 되돌립니다.
3. 워커에서 1-4절 표 6번의 `openssl`로 kubelet 클라이언트 인증서를 읽고 `ls -l /var/lib/kubelet/pki/`로 `kubelet-client-current.pem`이 가리키는 파일을 확인합니다.

## 2. 클러스터 구성요소

### 2-1. 무엇이 어디서 도나

| 종류 | 구성요소 | 상태와 로그를 보는 곳 |
|---|---|---|
| 컨테이너로 돌지 않음 | kubelet, 컨테이너 런타임 | `systemctl status`, `journalctl -u <서비스>` |
| static Pod(kubeadm) | kube-apiserver, kube-controller-manager, kube-scheduler, etcd | `kubectl -n kube-system get pod`, `kubectl logs`. API 서버가 죽었으면 `crictl` |
| DaemonSet | kube-proxy(쓰는 경우) | `kubectl -n kube-system logs` |

바이너리를 systemd 서비스로 설치한 클러스터라면 컨트롤 플레인 구성요소도 `systemctl status kube-apiserver`, `journalctl -u kube-apiserver`로 봅니다. 어느 방식인지는 `ls /etc/kubernetes/manifests`와 `kubectl -n kube-system get pod`로 먼저 가립니다.

### 2-2. static Pod의 동작

Static Pods와 Create static Pods 문서에서 시험에 필요한 사실을 모았습니다.

| 사실 | 문서 내용 |
|---|---|
| 관리 주체 | 특정 노드의 kubelet이 직접 관리. API 서버는 관여하지 않음 |
| 매니페스트 위치 | kubelet 설정의 `staticPodPath`(kubeadm은 `/etc/kubernetes/manifests`) |
| 감시 | kubelet이 디렉터리를 주기적으로 스캔해 파일이 생기면 만들고 사라지면 지움 |
| mirror Pod | kubelet이 API 서버에 거울 Pod를 만듦. 이름 뒤에 `-<노드 호스트 이름>`이 붙음 |
| kubectl delete | mirror Pod를 지워도 static Pod는 지워지지 않고 mirror Pod가 다시 생김 |
| 제약 | ServiceAccount, ConfigMap, Secret 같은 API 객체를 참조할 수 없음. 1.37부터 `configMapRef`, `secretRef` 참조도 완전히 금지되고 이를 풀던 `PreventStaticPodAPIReferences` 게이트도 제거됨(v1.37 릴리스 글) |
| 파일 이름 | 점(.)으로 시작하는 파일만 무시. 확장자로 거르지 않음 |

마지막 줄이 실전 함정입니다. `cp kube-apiserver.yaml kube-apiserver.yaml.backup`처럼 디렉터리 안에 백업을 만들면 kubelet이 두 파일을 모두 읽어 같은 이름의 Pod를 두 번 만들려 합니다. 결과는 정의되지 않았고 백업의 옛 스펙이 적용될 수도 있습니다. 백업은 디렉터리 밖(문서 예시는 `/etc/kubernetes/backup/`)에 둡니다.

```bash
sudo mkdir -p /etc/kubernetes/backup
sudo cp /etc/kubernetes/manifests/kube-apiserver.yaml /etc/kubernetes/backup/
sudo vi /etc/kubernetes/manifests/kube-apiserver.yaml
```

static Pod를 재시작하려면 매니페스트를 잠시 디렉터리 밖으로 옮겼다가 되돌립니다. Certificate Management with kubeadm 문서는 kubelet의 `fileCheckFrequency`만큼(문서는 20초) 기다리라고 적습니다.

```bash
sudo mv /etc/kubernetes/manifests/kube-scheduler.yaml /tmp/
sleep 20
sudo crictl ps | grep kube-scheduler     # 사라졌는지
sudo mv /tmp/kube-scheduler.yaml /etc/kubernetes/manifests/
```

### 2-3. 구성요소가 죽으면 무엇이 멈추나

Troubleshooting Clusters 문서의 장애 시나리오 중 시험과 맞닿은 부분입니다.

| 장애 | 결과(문서 기준) | 시험에서 보이는 모습 |
|---|---|---|
| API 서버 중지 | 새로 만들거나 바꾸지 못함. 기존 Pod와 Service는 계속 동작 | `kubectl` 명령 전체 실패 |
| etcd 손실 | kube-apiserver가 정상 기동하지 못함 | API 서버 컨테이너가 계속 재시작 |
| 컨트롤러 매니저 중지 | 고유한 영구 상태는 없음. ReplicaSet이 Pod 객체를 만들지 못함 | Deployment는 있는데 Pod 객체가 생기지 않음 |
| 스케줄러 중지 | 만들어진 Pod에 노드를 정하지 못함 | Pod가 이벤트 없이 `Pending`에 머묾 |
| kubelet 장애 | 그 노드에서 새 Pod를 시작하지 못함 | 노드 `NotReady` |

### 2-4. API 서버가 응답하지 않을 때

`kubectl`이 쓸모없어지므로 노드 안 도구로 내려갑니다. Debugging Kubernetes nodes with crictl 문서의 명령입니다.

```bash
ssh <컨트롤 플레인 노드>
sudo crictl ps -a | grep kube-apiserver        # 종료된 컨테이너까지
sudo crictl logs --tail=20 <컨테이너 ID>
sudo crictl pods --name kube-apiserver
```

| 명령 | 용도 |
|---|---|
| `crictl pods` | Pod 목록. `--name`, `--label`로 거르기 |
| `crictl ps`, `crictl ps -a` | 실행 중인 컨테이너, 종료 포함 전체 |
| `crictl logs <ID>` | 컨테이너 로그. `--tail=N` |
| `crictl exec -it <ID> <명령>` | 실행 중인 컨테이너에서 명령 |
| `crictl images`, `crictl pull` | 이미지 목록, 이미지 받기 |

crictl은 런타임 엔드포인트를 `--runtime-endpoint`, `CONTAINER_RUNTIME_ENDPOINT`, `/etc/crictl.yaml` 중 하나로 압니다. containerd는 `unix:///var/run/containerd/containerd.sock`입니다.

crictl은 시험 안내의 사전 설치 도구 목록(`kubectl`, `yq`, `curl`, `wget`, `man`)에 없습니다. pkgs.k8s.io의 kubeadm 1.37 패키지도 cri-tools를 의존성으로 끌어오지 않습니다. 과제 노드에 crictl이 없으면 kubelet이 런타임에 쓰게 하는 로그 파일(Logging Architecture 문서)을 직접 읽습니다. 디렉터리 이름은 `<ns>_<pod>_<uid>/<컨테이너>/<재시작 번호>.log` 꼴입니다(kind 노드에서 확인).

```bash
sudo ls /var/log/pods/ | grep kube-apiserver
sudo tail -50 /var/log/pods/kube-system_kube-apiserver-*/kube-apiserver/*.log
```

### 2-5. 매니페스트에서 자주 망가지는 곳

트러블슈팅 과제는 보통 "일부러 고장 낸 클러스터를 고치라"입니다. 아래는 매니페스트 구조에서 끌어낸 점검 순서이고 출제 범위를 문서로 확인한 것은 아닙니다.

| 위치 | 확인 | 이렇게 보임 |
|---|---|---|
| `command`의 플래그 | 플래그 이름 오타, 없는 플래그 | 컨테이너가 바로 종료. `crictl ps -a`의 Exited 컨테이너 로그에 원인 |
| 인증서와 키 경로(`--tls-cert-file`, `--etcd-cafile` 등) | 파일이 있는지, `volumeMounts`와 `hostPath`가 그 디렉터리를 마운트하는지 | `crictl logs`에 그 파일 경로가 찍힘 |
| `--etcd-servers` | etcd 주소와 포트(2379) | 포트를 2380으로 바꾸면 `kubectl`은 `TLS handshake timeout`, `crictl logs`는 `dial tcp 127.0.0.1:2380: connect: connection refused`(kind) |
| `image` | 태그 오타 | Pod는 `ImagePullBackOff`이고 컨테이너가 만들어진 적이 없어 `crictl ps -a`에 아무것도 없음. `describe pod`나 kubelet 로그를 봄(kind) |
| YAML 문법 | 들여쓰기 | kubelet이 Pod를 만들지 않음. kubelet 로그에 `couldn't parse as pod(yaml: line 60: did not find expected '-' indicator)`(kind) |
| `env`, `envFrom`, `volumes` | ConfigMap, Secret 참조 | mirror Pod가 생기지 않음. kubelet 로그에 `Could not process manifest file" err="static pods may not reference configmaps"`(kind v1.37.0) |

### 2-6. 자주 틀리는 지점

- `kubectl delete pod kube-apiserver-<노드>`로 재시작하려는 것. mirror Pod만 지워집니다.
- 매니페스트를 고친 뒤 바로 `kubectl`을 치고 실패를 보고 다시 고치는 것. kubelet이 변경을 감지하고 컨테이너를 다시 띄우는 데 시간이 걸리니 `crictl ps`로 새 컨테이너부터 봅니다.
- API 서버가 죽은 상태에서 컨트롤 플레인 로그를 `kubectl logs`로 보려는 것. 그때는 `crictl logs`나 `/var/log/pods`입니다.

### 2-7. 직접 해 보기

1. kube-scheduler 매니페스트의 이미지 태그를 없는 값으로 바꾸고 Deployment를 스케일해 새 Pod가 `Pending`에 머무는 것을 봅니다. 원인을 찾아 되돌립니다.
2. kube-apiserver 매니페스트의 `--etcd-servers` 포트를 바꾸고 `crictl ps -a`, `crictl logs`로 오류 문장을 찾아 되돌립니다. 백업은 `/etc/kubernetes/backup/`에 둡니다.
3. 워커의 `/etc/kubernetes/manifests`에 정적 웹 서버 Pod를 만들고 `kubectl delete`로 mirror Pod를 지워 다시 나타나는지 봅니다.

## 3. 리소스 사용량 모니터링

### 3-1. 리소스 메트릭 파이프라인

Resource metrics pipeline 문서의 구성입니다.

```
컨테이너 런타임 -> cAdvisor(kubelet에 포함) -> kubelet(/metrics/resource)
   -> metrics-server(각 kubelet에서 수집) -> Metrics API(metrics.k8s.io, API 서버 aggregation)
   -> HPA, VPA, kubectl top
```

metrics-server는 Metrics API의 참조 구현인 클러스터 애드온이고 이것(또는 다른 어댑터)을 배포해야 Metrics API가 생깁니다. README는 수집 간격 15초, 자동 확장 전용이라고 적습니다. `kubectl top`의 값도 가장 최근 수집값뿐입니다.

API 버전은 두 층을 나눠서 봅니다.

| 층 | 1.37 기준 상태 | 근거 |
|---|---|---|
| API 정의 | `metrics.k8s.io`가 `v1beta1`에서 `v1`로 변경 없이 승격(Stable). `v1beta1`은 전환 기간 동안 계속 쓸 수 있음 | CHANGELOG-1.37, KEP-5207, v1.37 릴리스 글 |
| `kubectl top` | 1.37 kubectl이 `v1` 지원 추가. discovery로 제공 버전을 보고 `v1`이 없으면 `v1beta1`로 내려감 | CHANGELOG-1.37, KEP-5207 |
| metrics-server | 최신 릴리스 v0.9.0(2026-07-13, 쿠버네티스 의존성 1.36.2)은 APIService `v1beta1.metrics.k8s.io`만 등록. `v1.metrics.k8s.io` 등록은 2026-09-04 main 브랜치 커밋이고 이 글을 쓰는 시점에 릴리스되지 않음 | metrics-server 릴리스 노트, `manifests/base/apiservice.yaml` |

aggregation 계층은 등록된 버전만 응답하므로 v0.9.0에서 `/apis/metrics.k8s.io/v1/...`을 직접 부르면 `NotFound`입니다(kind에서 확인, KEP-5207의 버전 표와 같음). `kubectl top`은 버전을 알아서 고르니 경로를 손으로 칠 때만 `kubectl get apiservice | grep metrics`로 버전을 먼저 봅니다.

### 3-2. kubectl top

```bash
kubectl top node
kubectl top node --sort-by=cpu
kubectl top pod -n shop --sort-by=memory
kubectl top pod -n shop --containers           # 컨테이너별
kubectl top pod -n shop -l app=order-api --sum # 합계 행 추가
kubectl top pod -A --sort-by=cpu --no-headers | head -1   # 가장 많이 쓰는 Pod 하나
```

`--sort-by`는 `cpu`나 `memory`만 받습니다. 다른 값을 주면 `--sort-by accepts only cpu or memory`로 실패합니다(kubectl v1.37.1). 막 만든 Pod는 파이프라인 지연 때문에 몇 분 동안 `error: Metrics not available for pod ...`가 나올 수 있습니다. 결과를 파일로 옮길 때는 과제가 요구하는 형식(이름만인지, 네임스페이스를 포함하는지)을 다시 읽습니다.

### 3-3. 숫자를 읽는 법

| 자원 | 문서 정의 |
|---|---|
| CPU | cpu 단위의 평균 코어 사용량. 누적 CPU 카운터의 변화율로 계산. 구간은 Metrics API의 `window` 필드 |
| 메모리 | 수집 순간의 working set(바이트). 압박에서도 회수할 수 없는 사용 중 메모리에 가깝고 파일 캐시 일부가 섞일 수 있음 |

메모리 수치가 컨테이너 안의 `free`와 달라도 이상한 일은 아닙니다. 컨테이너가 `limits.memory`를 넘으면 커널이 종료하고 `describe`의 Last State에 `OOMKilled`, Exit Code 137이 남습니다. 이 과정을 cgroup 쪽에서 본 설명은 [쿠버네티스 아래의 리눅스 3편](/blog/theory/systems/k8s-linux-03-cgroup-qos)에 있습니다(시험 범위 밖 심화).

### 3-4. kubectl top이 안 될 때

| 확인 | 명령 |
|---|---|
| metrics-server Pod | `kubectl -n kube-system get pod \| grep metrics` |
| APIService 상태 | `kubectl get apiservice \| grep metrics`(AVAILABLE이 `True`인지) |
| metrics-server 로그 | `kubectl -n kube-system logs deploy/metrics-server` |

Troubleshooting kubeadm 문서에 kubeadm 클러스터 고유의 함정이 있습니다. kubeadm은 kubelet에 자체 서명 서빙 인증서를 배포하므로 metrics-server가 kubelet에 붙을 때 `x509: certificate signed by unknown authority` 같은 오류가 납니다. 문서는 `--kubelet-insecure-tls`로 우회할 수 있지만 운영에는 권하지 않고 서명된 서빙 인증서(1-4절 끝)를 쓰라고 안내합니다. 시험장에서는 과제 지시를 따릅니다. kind에서는 로그에 `x509: cannot validate certificate for 172.18.0.5 because it doesn't contain any IP SANs`가 찍히고 APIService가 `False (MissingEndpoints)`였으며 metrics-server v0.9.0 매니페스트에 `--kubelet-insecure-tls`를 더해야 Pod가 Ready가 됐습니다.

### 3-5. 출력 형식으로 값 뽑기

모니터링 과제는 대개 출력의 일부를 파일로 옮기는 데서 끝납니다. kubectl Quick Reference와 JSONPath Support 문서의 형식을 과제 형태로 묶었습니다.

| 형식 | 쓰는 자리 | 예 |
|---|---|---|
| `--sort-by=<JSONPath>` | 필드 값으로 정렬(오름차순만) | `kubectl get pods --sort-by='.status.containerStatuses[0].restartCount'` |
| `-o jsonpath='{...}'` | 값만 뽑기. `range`와 `end`로 목록 반복 | `kubectl get nodes -o jsonpath='{.items[*].metadata.name}'` |
| `-o custom-columns=<머리>:<경로>,...` | 원하는 열만 표로 | `kubectl get pods -A -o custom-columns='NS:.metadata.namespace,NAME:.metadata.name'` |
| `--no-headers` | 머리줄 빼기. `head`, `tail`, `awk`와 함께 | `kubectl top pod -A --no-headers` |

```bash
# 노드마다 이름과 Ready 상태
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.conditions[?(@.type=="Ready")].status}{"\n"}{end}'

# 재시작이 가장 많은 Pod (오름차순이라 마지막 줄)
kubectl get pods -A --sort-by='.status.containerStatuses[0].restartCount' --no-headers | tail -1

# 테인트가 걸린 노드 (Quick Reference 예시)
kubectl get nodes -o custom-columns='NODE:.metadata.name,TAINT:.spec.taints[*].key,EFFECT:.spec.taints[*].effect'

```

### 3-6. JSONPath를 jq 없이 쓰기

식은 세 단계로 세웁니다. 먼저 `kubectl get <리소스> -o yaml`로 구조를 봅니다. 필드 이름이 헷갈리면 `kubectl explain pod.status.containerStatuses`로 스키마를 확인합니다. 찾은 경로를 `-o jsonpath='{...}'`에 넣으면 끝입니다. 목록을 조회하면 결과가 `items` 배열로 감싸이고 이름을 준 단일 객체 조회에는 `items`가 없다는 점이 첫 함정입니다.

| 연산자 | 뜻 | 예 |
|---|---|---|
| `.필드` | 자식 | `{.metadata.name}` |
| `[n]`, `[*]` | 배열 원소 하나, 전부 | `{.items[*].metadata.name}` |
| `?()` | 조건 필터. `@`는 지금 보는 원소. `==`, `!=` | `{.status.conditions[?(@.type=="Ready")].status}` |
| `range`, `end` | 원소마다 같은 서식 출력 | `{range .items[*]}{.metadata.name}{"\n"}{end}` |
| `"\t"`, `"\n"` | 따옴표 안 글자는 그대로 출력 | `{.metadata.name}{"\t"}{.status.phase}` |
| `\.` | 필드 이름 안의 점 이스케이프 | `{.metadata.labels.kubernetes\.io/hostname}` |

```bash
# 노드마다 이름과 내부 IP
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.addresses[?(@.type=="InternalIP")].address}{"\n"}{end}'

# 컨테이너가 여럿인 Pod에서 app 컨테이너의 이미지만
kubectl -n shop get pod board -o jsonpath='{.spec.containers[?(@.name=="app")].image}{"\n"}'

# custom-columns는 원소 하나 기준이라 .items[*]를 붙이지 않는다. 필터도 쓸 수 있다
kubectl get node -o custom-columns='NODE:.metadata.name,READY:.status.conditions[?(@.type=="Ready")].status'
```

JSONPath는 정규 표현식을 지원하지 않고 문서는 그럴 때 `jq`를 쓰라고 적습니다. 그런데 시험 호스트의 사전 설치 목록에는 `jq`가 없고 `yq`가 있습니다. 그래서 jq로 하던 일은 이렇게 바꿉니다.

| jq로 하던 일 | 대신 |
|---|---|
| 정규식으로 거르기 | `range`로 한 줄에 하나씩 뽑고 `grep` |
| 개수 세기, 중복 제거 | 한 줄에 하나씩 뽑은 뒤 `wc -l`, `sort \| uniq -c` |
| Secret 값 디코딩 | `-o jsonpath='{.data.password}' \| base64 -d` |
| 복잡한 변환 | `-o yaml \| yq` |

```bash
# 노드별 Pod 수
kubectl get pods -A -o jsonpath='{range .items[*]}{.spec.nodeName}{"\n"}{end}' | sort | uniq -c
```

자주 하는 실수는 네 가지입니다. 식을 작은따옴표로 감싸지 않아 셸이 `[*]`나 `"`를 먼저 해석하는 것, 중괄호를 빼먹는 것, custom-columns에 `.items[*]`를 붙이는 것, 마지막 `{"\n"}`이 없어 파일 끝 줄바꿈이 빠지는 것입니다. 파일로 옮겼다면 `cat -A`로 탭(`^I`)과 줄 끝(`$`)까지 확인합니다.

### 3-7. 직접 해 보기

1. 연습 클러스터에 metrics-server를 설치하고 `kubectl get apiservice | grep metrics`로 등록된 버전을 봅니다. `kubectl get --raw "/apis/metrics.k8s.io/<그 버전>/nodes"`의 `window`와 `usage`를 `kubectl top node`와 맞춰 봅니다.
2. 결제 Deployment에 CPU를 쓰는 루프 컨테이너를 넣고 `kubectl top pod --containers --sort-by=cpu`로 맨 위에 오는지 확인합니다.

## 4. 컨테이너 출력 스트림

### 4-1. 로그가 어디서 오나

Logging Architecture 문서의 흐름입니다. 컨테이너 런타임이 앱의 `stdout`과 `stderr`를 받아 kubelet이 지정한 `/var/log/pods` 아래 파일에 씁니다. kubelet이 로그 회전을 맡고(기본 `containerLogMaxSize` 10Mi, `containerLogMaxFiles` 5개) `kubectl logs`를 치면 그 노드의 kubelet이 파일을 읽어 돌려줍니다.

| 사실 | 결과 |
|---|---|
| 앱이 파일에만 로그를 쓰면 | `kubectl logs`에 아무것도 안 나옴. stdout, stderr로 보내거나 4-5절의 사이드카를 씀 |
| 컨테이너가 재시작되면 | kubelet이 종료된 컨테이너 하나와 그 로그를 보관. `--previous`로 봄 |
| Pod가 노드에서 축출되면 | 컨테이너와 로그가 함께 사라짐 |
| 로그가 회전되면 | `kubectl logs`는 최신 파일만 읽음 |

### 4-2. kubectl logs

```bash
kubectl logs order-api-xxxx -n shop                    # 컨테이너가 하나일 때
kubectl logs order-api-xxxx -n shop -c app             # 컨테이너 지정
kubectl logs order-api-xxxx -n shop -c app --previous  # 직전 종료 인스턴스(-p)
kubectl logs order-api-xxxx -n shop --all-containers=true
kubectl logs -f order-api-xxxx -n shop                 # 계속 따라가기
kubectl logs --tail=20 --since=1h order-api-xxxx -n shop
kubectl logs -l app=order-api -n shop --all-containers=true --prefix
kubectl logs deployment/order-api -n shop --all-pods=true
```

| 옵션 | 레퍼런스 기준 |
|---|---|
| `-p`, `--previous` | 이전에 종료된 컨테이너의 로그 |
| `--tail` | 셀렉터가 없으면 기본 -1(전부), `-l`을 쓰면 기본 10줄 |
| `--prefix` | 각 줄 앞에 Pod와 컨테이너 이름 |
| `--all-pods` | `deployment/<이름>`처럼 리소스를 줄 때 모든 Pod |

멀티 컨테이너 Pod에서 `-c`를 빼면 kubectl은 오류 없이 컨테이너 하나를 골라 보여 줍니다. 고르는 순서는 이렇습니다(kubectl 소스 `logsforobject.go` 기준).

1. Pod에 `kubectl.kubernetes.io/default-container` 어노테이션이 있으면 그 컨테이너
2. 없으면 `spec.containers`의 첫 번째 컨테이너. 표준 오류에 `Defaulted container "app" out of: app, access-log` 꼴의 안내가 찍힘

어노테이션이 없는 이름을 가리키면 `Default container name "nope" not found in pod board` 안내 뒤 첫 컨테이너로 넘어갑니다(kubectl v1.37.1). init 컨테이너와 네이티브 사이드카(`initContainers`에 있음)도 `-c <이름>`으로 봅니다. 이름은 이렇게 확인합니다.

```bash
kubectl -n shop get pod board -o jsonpath='{.spec.containers[*].name}{"\n"}{.spec.initContainers[*].name}{"\n"}'
```

### 4-3. CrashLoopBackOff를 로그로 읽기

Pod Lifecycle 문서 기준으로 재시작 지연은 10초, 20초, 40초로 두 배씩 늘어 300초에서 멈추고 컨테이너가 10분 동안 문제없이 돌면 초기화됩니다. 원인은 앱 오류, 잘못된 환경 변수나 빠진 설정 파일, 자원 부족, liveness나 startup probe 실패입니다. 조사 순서는 로그, 이벤트, 설정, 자원 한도입니다.

```bash
kubectl -n shop logs payment-xxxx --previous              # 죽기 직전 출력
kubectl -n shop describe pod payment-xxxx                 # Last State, Reason, Exit Code, Events
kubectl -n shop get pod payment-xxxx -o jsonpath='{.status.containerStatuses[0].lastState}'
kubectl -n shop get deploy payment -o yaml | grep -A5 -E 'command|args|env|resources|livenessProbe'
```

`--previous`를 붙이는 습관이 안전합니다. 다음 재시작을 기다리는 동안에는 실행 중인 컨테이너가 없어 `kubectl logs`와 `--previous`가 같은 직전 인스턴스를 보여 줍니다. 새 컨테이너가 도는 동안에는 `--previous`를 빼면 새 컨테이너의 짧은 로그가 나옵니다(kind v1.37.0에서 확인).

Determine the Reason for Pod Failure 문서는 컨테이너가 `/dev/termination-log`에 쓴 종료 메시지를 읽는 방법을 보여 줍니다. `terminationMessagePolicy: FallbackToLogsOnError`를 주면 메시지 파일이 비었고 오류로 끝났을 때 로그 마지막 부분(2048바이트와 80줄 중 작은 쪽)을 메시지로 씁니다.

```bash
kubectl get pod <pod> -o go-template="{{range .status.containerStatuses}}{{.lastState.terminated.message}}{{end}}"
```

`lastState`는 재시작된 컨테이너에만 채워집니다. `restartPolicy: Never`인 Pod가 끝났다면 `.lastState`를 `.state`로 바꿉니다.

### 4-4. 셸이 없는 컨테이너

`kubectl exec`로 셸에 들어갈 수 없는 이미지(distroless 등)는 임시 컨테이너를 붙입니다(Debug Running Pods 문서).

```bash
kubectl debug -it <pod> --image=busybox:1.36 --target=<컨테이너 이름>
kubectl debug payment-xxxx -it --copy-to=payment-debug --container=app -- sh   # Pod를 복사해 명령을 바꿔 띄움
```

`--target`은 대상 컨테이너의 프로세스 네임스페이스를 공유하게 합니다. 임시 컨테이너는 v1.25부터 stable이고 static Pod에는 붙일 수 없습니다.

### 4-5. 사이드카로 로그 스트림 나누기

앱이 파일에 로그를 쓰면 Logging Architecture 문서의 스트리밍 사이드카를 씁니다. 사이드카가 공유 볼륨의 로그 파일을 읽어 자기 stdout으로 내보내면 `kubectl logs <pod> -c <사이드카>`로 볼 수 있습니다.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: board
  namespace: shop
spec:
  containers:
  - name: app
    image: busybox:1.36
    args: [/bin/sh, -c, 'i=0; while true; do echo "$i GET /board" >> /var/log/board/access.log; i=$((i+1)); sleep 1; done']
    volumeMounts:
    - name: logs
      mountPath: /var/log/board
  - name: access-log
    image: busybox:1.36
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

이 Pod에서 `-c` 없이 `kubectl -n shop logs board`를 치면 `Defaulted container "app" out of: app, access-log` 안내와 함께 빈 출력이 나옵니다. `app`은 파일에만 쓰기 때문입니다. 같은 구조를 네이티브 사이드카(`initContainers`에 `restartPolicy: Always`, 1.33 stable)로 쓰는 법은 [Ch-03](/blog/cert/cka/cka-03-workloads-scheduling)에 있습니다.

### 4-6. 자주 틀리는 지점

- 멀티 컨테이너 Pod에서 `-c` 없이 쳐서 기본 컨테이너의 로그를 원하는 로그로 착각하는 것.
- 재시작된 Pod에서 `--previous`를 빼먹는 것.
- 로그를 파일로 저장하라는 과제에서 다른 호스트에 저장하는 것. 과제가 지정한 호스트에서 리다이렉트합니다.
- kubeadm 클러스터에서 API 서버 로그를 `journalctl -u kube-apiserver`로 찾는 것. static Pod라서 `kubectl logs`나 `crictl logs`로 봅니다.

### 4-7. 직접 해 보기

1. `command: ["sh","-c","echo start; exit 1"]`로 결제 Pod를 만들어 `CrashLoopBackOff`를 만들고 `kubectl logs`와 `--previous`의 차이, RESTARTS가 늘어나는 간격을 봅니다.
2. 4-5의 게시판 Pod를 만들고 `kubectl logs board -c app`이 비어 있는 이유를 설명합니다.
3. `kubectl logs -l app=order-api --all-containers=true --prefix --tail=5`로 여러 Pod의 로그를 한 번에 봅니다.

## 5. 서비스와 네트워킹 트러블슈팅

### 5-1. Debug Services 문서의 순서

Debug Services 문서는 질문을 하나씩 확인하는 순서로 짜여 있습니다. 앞 질문이 "예"여야 다음으로 넘어갑니다.

| 순서 | 질문 | 확인 명령 | "아니오"일 때 |
|---|---|---|---|
| 1 | Service가 존재하는지 | `kubectl get svc <svc>` | `kubectl expose`로 만든다 |
| 2 | 대상 Pod에 걸린 NetworkPolicy Ingress 규칙이 있는지 | `kubectl get networkpolicy -n <ns>` | 규칙을 검토한다 |
| 3 | DNS 이름으로 동작하는지 | 클러스터 안 Pod에서 `nslookup <svc>`, `nslookup <svc>.<ns>` | [Ch-04](/blog/cert/cka/cka-04-services-networking)의 CoreDNS 점검 |
| 4 | Service IP로 동작하는지 | `wget -qO- <ClusterIP>:<port>` | 다음 단계로 좁히기 |
| 5 | Service 정의가 맞는지 | `kubectl get svc <svc> -o yaml` | 포트, `targetPort`, 프로토콜, 이름 붙은 포트 |
| 6 | EndpointSlice가 있는지 | `kubectl get endpointslices -l kubernetes.io/service-name=<svc>` | selector와 Pod 라벨 대조 |
| 7 | Pod 자체가 동작하는지 | 엔드포인트 IP와 Pod 포트로 직접 `wget` | 앱이나 컨테이너 포트 문제 |
| 8 | kube-proxy가 동작하는지 | kube-proxy Pod 상태와 로그 | 5-3절 |

5번의 점검 목록은 문서 원문입니다. 접근하려는 포트가 `spec.ports[]`에 있는지, `targetPort`가 Pod가 쓰는 포트인지, 숫자 포트를 의도했는데 문자열로 쓰지 않았는지, 이름 붙은 포트라면 Pod가 같은 이름의 포트를 노출하는지, 프로토콜이 맞는지입니다.

6번에서 ENDPOINTS가 비어 있으면(`kubectl get endpointslices`는 `<unset>`, 1.33부터 사용 중단 경고를 찍는 `kubectl get endpoints`는 `<none>`) Service의 `spec.selector`가 Pod의 라벨을 실제로 고르는지 봅니다. 라벨은 맞는데 비어 있으면 readiness probe 실패입니다. Pod Lifecycle 문서는 readiness가 실패한 Pod의 IP를 EndpointSlice 컨트롤러가 뺀다고 적습니다.

### 5-2. 쇼핑몰 예로 따라가기

주문 API Service `order-api`가 응답하지 않는다고 가정합니다. 엔드포인트 확인(6번)이 selector, 라벨, readiness 문제를 한 번에 가르므로 존재 확인 바로 다음에 둡니다.

```bash
# 1. 존재
kubectl -n shop get svc order-api

# 6. 엔드포인트와 라벨 대조
kubectl -n shop get endpointslices -l kubernetes.io/service-name=order-api
kubectl -n shop get pod --show-labels
kubectl -n shop get pod -l app=order-api       # Service selector 그대로

# 5. 정의
kubectl -n shop get svc order-api -o yaml | grep -A8 -E 'ports:|selector:'

# 3, 4, 7. 클러스터 안에서 이름, Service IP, Pod IP로
kubectl -n shop run tmp --rm -it --restart=Never --image=busybox:1.36 -- sh
#   nslookup order-api
#   wget -qO- -T 2 order-api:80
#   wget -qO- -T 2 <Pod IP>:<targetPort>

# 2. 정책
kubectl -n shop get networkpolicy
kubectl -n shop describe networkpolicy <이름>
```

임시 Pod 이미지는 `busybox:1.36`을 씁니다. 문서 예시의 `busybox:1.28`은 arm64 노드에서 `wget`이 `Segmentation fault`로 죽었습니다(kind). 1.36의 `nslookup`은 `order-db-0.order-db`처럼 점이 든 짧은 이름을 풀지 못하니 그럴 때는 `<svc>.<ns>.svc.cluster.local` 전체 이름을 씁니다.

### 5-3. kube-proxy 확인

엔드포인트가 있고 Pod 직접 호출도 되는데 Service IP로만 안 되면 서비스 프록시를 의심합니다. kubeadm 클러스터의 kube-proxy는 DaemonSet입니다.

```bash
kubectl -n kube-system get ds,cm | grep kube-proxy
kubectl -n kube-system get pod -l k8s-app=kube-proxy -o wide
kubectl -n kube-system logs <kube-proxy Pod>
kubectl -n kube-system get configmap kube-proxy -o yaml | grep mode
```

kind v1.37.0에서 ConfigMap의 `mode`는 `iptables`였고 kube-proxy 로그에 `Using iptables Proxier`가 찍혔습니다. iptables 모드라면 노드에서 `sudo iptables-save | grep <svc 이름>`으로 Service용 규칙이 생겼는지 봅니다(Debug Services 문서). 규칙의 체인 구조를 해석하는 것은 시험 범위 밖이고 [쿠버네티스 아래의 리눅스 5편](/blog/theory/systems/k8s-linux-05-service-iptables-conntrack)에 정리했습니다. 클러스터가 kube-proxy를 쓰지 않으면 대신 쓰는 서비스 구현체를 조사합니다.

### 5-4. 그 밖의 경우

| 증상 | 확인 |
|---|---|
| Pod가 자기 Service IP로 자신에게 접속 못 함 | hairpin 모드. Troubleshooting kubeadm 문서는 많은 네트워크 애드온이 hairpin을 켜지 않는다고 적음 |
| 특정 노드의 Pod끼리만 통신 실패 | 그 노드의 CNI 플러그인 Pod, 노드 조건 `NetworkUnavailable` |
| NodePort로 외부 접속 실패 | `nodePort` 번호, 노드 방화벽, `externalTrafficPolicy: Local`인데 그 노드에 엔드포인트가 없는지 |
| Ingress나 Gateway 경유 실패 | 백엔드 Service부터 위 순서로 확인한 뒤 `ingressClassName`, HTTPRoute의 `Accepted`와 `ResolvedRefs` 조건 |
| 갑자기 모든 이름 해석 실패 | CoreDNS Pod, Corefile, Egress NetworkPolicy([Ch-04](/blog/cert/cka/cka-04-services-networking)) |

### 5-5. 자주 틀리는 지점

- Service를 지우고 다시 만들어 ClusterIP가 바뀌는 것. 고칠 때는 `kubectl edit`입니다.
- 임시 Pod를 기본 네임스페이스에 만들어 짧은 이름으로 다른 네임스페이스의 Service를 찾는 것. `-n`을 맞추거나 `<svc>.<ns>`로 부릅니다.
- 테스트용 임시 Pod를 남기는 것. `--rm`을 붙입니다.
- `nslookup`이 성공했으니 Service도 정상이라고 판단하는 것. 엔드포인트가 비어 있어도 이름은 풀립니다.
- 엔드포인트가 있으니 정상이라고 판단하는 것. `targetPort`가 틀려도 슬라이스에는 Pod IP와 잘못된 포트가 그대로 들어갑니다(kind에서 확인).

### 5-6. 직접 해 보기

1. `order-api` Service의 selector를 `app=order`로 바꾸고 5-2의 순서로 원인을 찾습니다. ENDPOINTS 열이 `<unset>`이 되는 것을 봅니다.
2. `targetPort`를 없는 포트로 바꾸고 엔드포인트는 있는데 요청이 실패하는 것을 확인합니다.
3. 주문 API에 실패하는 readiness probe를 붙여 READY `0/1`과 빈 ENDPOINTS를 함께 관찰합니다.

## 6. 확인 문제

직접 만든 연습 과제입니다. 시험 문항이나 덤프에서 옮긴 것이 아닙니다.

**문제 1.** 워커 노드 `node02`가 `NotReady`입니다. `kubectl describe node node02`의 조건 메시지는 `Kubelet stopped posting node status.`입니다. 해결 순서를 적으세요.

<details>
<summary>정답</summary>

1. `ssh node02`로 들어갑니다.
2. `sudo systemctl status kubelet`으로 kubelet이 멈췄는지, 실패를 반복하는지 봅니다.
3. `sudo journalctl -u kubelet --no-pager | tail -50`으로 실패 이유를 읽습니다. 설정 파일(`/var/lib/kubelet/config.yaml`) 오류, kubeconfig(`/etc/kubernetes/kubelet.conf`)나 인증서 경로, 런타임 엔드포인트를 의심합니다.
4. 원인을 고치고 `sudo systemctl restart kubelet`, 꺼져 있었다면 `sudo systemctl enable --now kubelet`을 합니다.
5. `exit`로 돌아와 `kubectl get nodes`로 `Ready`를 확인합니다.

</details>

**문제 2.** `kubectl get pod` 명령이 API 서버에 연결하지 못합니다. 컨트롤 플레인 노드에서 무엇을 보나요?

<details>
<summary>정답</summary>

```bash
sudo crictl ps -a | grep kube-apiserver
sudo crictl logs <가장 최근 컨테이너 ID>
sudo journalctl -u kubelet --no-pager | tail -30
sudo cat /etc/kubernetes/manifests/kube-apiserver.yaml
```

crictl이 없으면 `/var/log/pods/kube-system_kube-apiserver-*/kube-apiserver/` 아래 로그 파일을 읽습니다. 로그가 가리키는 플래그나 경로를 매니페스트에서 고칩니다. 고치기 전에 매니페스트를 `/etc/kubernetes/manifests` 밖에 백업합니다. `crictl ps`에 새 컨테이너가 뜨면 `kubectl`이 다시 동작합니다.

</details>

**문제 3.** 네임스페이스 `shop`의 `payment` Pod가 `CrashLoopBackOff`입니다. 컨테이너 이름은 `app`입니다. 죽기 직전 로그를 `/opt/payment-crash.log`에 저장하세요.

<details>
<summary>정답</summary>

```bash
kubectl -n shop logs <payment Pod 이름> -c app --previous > /opt/payment-crash.log
```

`--previous`가 핵심입니다. 과제가 지정한 호스트에서 실행해야 파일이 그 호스트에 생깁니다.

</details>

**문제 4.** 모든 네임스페이스에서 메모리를 가장 많이 쓰는 Pod의 이름을 `/opt/top-mem.txt`에 적으세요.

<details>
<summary>정답</summary>

```bash
kubectl top pod -A --sort-by=memory --no-headers | head -1 | awk '{print $2}' > /opt/top-mem.txt
cat /opt/top-mem.txt
```

`-A`이면 첫 열이 NAMESPACE라 이름은 두 번째 열입니다. 명령이 실패하면 3-4절 순서로 metrics-server와 APIService부터 확인합니다.

</details>

**문제 5.** 컨트롤 플레인 노드의 `/etc/kubernetes/manifests` 안에서 `cp kube-scheduler.yaml kube-scheduler.yaml.bak`을 실행했습니다. 무엇이 문제인가요?

<details>
<summary>정답</summary>

kubelet은 점으로 시작하지 않는 모든 파일을 static Pod 매니페스트로 읽고 확장자로 거르지 않습니다. 같은 이름의 Pod를 정의한 파일이 둘이 되어 동작이 정의되지 않고 백업의 옛 스펙이 적용될 수도 있습니다. 백업은 `/etc/kubernetes/backup/`처럼 디렉터리 밖에 둡니다.

</details>

**문제 6.** `board` Service의 ENDPOINTS가 비어 있습니다. Pod는 3개 모두 `Running`이고 READY는 `0/1`입니다. 원인과 확인 방법은요?

<details>
<summary>정답</summary>

READY `0/1`은 readiness probe 실패이고 실패한 Pod의 IP는 EndpointSlice에서 빠집니다. `kubectl describe pod`의 Events에서 readiness 실패 메시지를 읽고 probe의 경로, 포트, 지연 시간을 앱과 대조합니다. selector 문제였다면 READY는 `1/1`인데 엔드포인트만 비어 있었을 것입니다.

</details>

**문제 7.** 새 Deployment `board`를 만들었는데 ReplicaSet은 있고 Pod 객체가 하나도 생기지 않습니다. 반대로 Pod 객체는 생겼는데 모두 `Pending`이고 Events에 아무것도 없다면 어떤가요? 각각 어느 구성요소를 보나요?

<details>
<summary>정답</summary>

Pod 객체가 생기지 않으면 kube-controller-manager를 봅니다. Pod는 있는데 Events 없이 `Pending`이면 스케줄러가 노드를 정하지 않은 것이니 kube-scheduler를 봅니다. 둘 다 `kubectl -n kube-system get pod`로 상태를 보고 `kubectl logs` 또는 `crictl logs`로 원인을 찾은 뒤 `/etc/kubernetes/manifests`의 매니페스트를 고칩니다.

</details>

**문제 8.** 워커 `node03`이 `NotReady`이고 kubelet은 `active (running)`입니다. kube-apiserver 로그에 `x509: certificate has expired or is not yet valid`가 반복됩니다. 무엇을 확인하고 어떻게 복구하나요?

<details>
<summary>정답</summary>

`node03`에서 kubelet 클라이언트 인증서와 시계를 봅니다.

```bash
sudo openssl x509 -in /var/lib/kubelet/pki/kubelet-client-current.pem -noout -subject -issuer -dates
date
```

`notAfter`가 지났으면 1-4절 절차를 따릅니다. `kubelet.conf`와 `kubelet-client*`를 백업 후 지웁니다. 컨트롤 플레인 노드에서 `kubeadm kubeconfig user --org system:nodes --client-name system:node:node03`으로 만든 kubeconfig를 복사해 kubelet을 재시작합니다. `kubelet-client-current.pem`이 다시 생기면 `kubelet.conf`가 그 파일을 가리키게 고치고 한 번 더 재시작합니다. 날짜는 유효한데 노드 시계가 시작 시각보다 이르면 시계를 맞춥니다. `kubeadm certs check-expiration`에는 kubelet 인증서가 나오지 않습니다.

</details>

**문제 9.** 모든 노드의 이름과 InternalIP를 탭으로 구분해 한 줄에 하나씩 `/opt/node-ips.txt`에 저장하세요. jq는 쓸 수 없습니다.

<details>
<summary>정답</summary>

```bash
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.addresses[?(@.type=="InternalIP")].address}{"\n"}{end}' > /opt/node-ips.txt
cat -A /opt/node-ips.txt     # 탭은 ^I, 줄 끝은 $
```

`range`와 `end`로 노드마다 한 줄을 만들고 `?(@.type=="InternalIP")` 필터로 주소 배열에서 한 종류만 고릅니다. range 없이 `{.items[*].metadata.name}`처럼 쓰면 모든 이름이 한 줄에 공백으로 붙어 나옵니다.

</details>

## 7. 범위와 한계

- 명령과 오류 문구는 kind v1.37.0 클러스터(arm64)와 Lima VM의 kubeadm 1.37.1 클러스터에서 2026년 10월에 직접 돌려 확인했습니다. 본문에 "(kind)", "(Lima VM)"으로 표시한 출력이 그 결과입니다.
- jq는 2025년 3월 판 시험 안내부터 사전 설치 목록에서 빠졌고 crictl은 있다는 근거가 없습니다. 그래서 `/var/log/pods`와 JSONPath, `yq` 대안을 함께 적었습니다.
- cgroup v1과 스왑 노드, `serverTLSBootstrap` 서빙 인증서 승인, hairpin, NodePort 외부 접속, Ingress와 Gateway 경유 장애는 돌려 보지 못했습니다.
- Metrics API는 1.37에서 `v1`이 Stable이지만 2026년 10월 기준 릴리스된 metrics-server(v0.9.0)는 `v1beta1`만 제공합니다. 시험 클러스터의 metrics-server 버전은 확인하지 못했습니다.
- etcd 백업과 복구, kubeadm 업그레이드 절차는 [Ch-02](/blog/cert/cka/cka-02-cluster-architecture)에 있습니다.

## 참고 자료

- CNCF, [CKA Curriculum v1.37](https://github.com/cncf/curriculum/blob/master/CKA_Curriculum_v1.37.pdf)
- Linux Foundation, [Important Instructions: CKA and CKAD](https://docs.linuxfoundation.org/tc-docs/certification/tips-cka-and-ckad), [Resources Allowed](https://docs.linuxfoundation.org/tc-docs/certification/certification-resources-allowed)
- kubernetes.io, [Troubleshooting Clusters](https://kubernetes.io/docs/tasks/debug/debug-cluster/), [Debug Pods](https://kubernetes.io/docs/tasks/debug/debug-application/debug-pods/), [Debug Running Pods](https://kubernetes.io/docs/tasks/debug/debug-application/debug-running-pod/), [Debug Services](https://kubernetes.io/docs/tasks/debug/debug-application/debug-service/), [Determine the Reason for Pod Failure](https://kubernetes.io/docs/tasks/debug/debug-application/determine-reason-pod-failure/)
- kubernetes.io, [Debugging Kubernetes nodes with crictl](https://kubernetes.io/docs/tasks/debug/debug-cluster/crictl/), [Resource metrics pipeline](https://kubernetes.io/docs/tasks/debug/debug-cluster/resource-metrics-pipeline/), [Logging Architecture](https://kubernetes.io/docs/concepts/cluster-administration/logging/)
- kubernetes.io, [kubectl Quick Reference](https://kubernetes.io/docs/reference/kubectl/quick-reference/), [JSONPath Support](https://kubernetes.io/docs/reference/kubectl/jsonpath/), [kubectl logs](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_logs/), [kubectl top pod](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_top/kubectl_top_pod/)
- kubernetes.io, [Pod Lifecycle](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/), [Images](https://kubernetes.io/docs/concepts/containers/images/), [Node Status](https://kubernetes.io/docs/reference/node/node-status/), [Safely Drain a Node](https://kubernetes.io/docs/tasks/administer-cluster/safely-drain-node/)
- kubernetes.io, [Static Pods](https://kubernetes.io/docs/concepts/workloads/pods/static-pods/), [Create static Pods](https://kubernetes.io/docs/tasks/configure-pod-container/static-pod/), [kubeadm Implementation details](https://kubernetes.io/docs/reference/setup-tools/kubeadm/implementation-details/)
- kubernetes.io, [Configuring each kubelet in your cluster using kubeadm](https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/kubelet-integration/), [Troubleshooting kubeadm](https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/troubleshooting-kubeadm/), [Certificate Management with kubeadm](https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/kubeadm-certs/), [About cgroup v2](https://kubernetes.io/docs/concepts/architecture/cgroups/)
- Kubernetes, [CHANGELOG-1.37](https://github.com/kubernetes/kubernetes/blob/master/CHANGELOG/CHANGELOG-1.37.md), [KEP-5207 metrics.k8s.io API definition](https://github.com/kubernetes/enhancements/tree/master/keps/sig-instrumentation/5207-metrics-k8s-io-api-definition), 블로그 [Kubernetes v1.37: Garhwal](https://kubernetes.io/blog/2026/08/26/kubernetes-v1-37-release/)
- kubernetes-sigs, [metrics-server README](https://github.com/kubernetes-sigs/metrics-server), [metrics-server releases](https://github.com/kubernetes-sigs/metrics-server/releases)
- kubernetes/kubectl, [pkg/polymorphichelpers/logsforobject.go](https://github.com/kubernetes/kubectl/blob/master/pkg/polymorphichelpers/logsforobject.go) (기본 컨테이너 선택)

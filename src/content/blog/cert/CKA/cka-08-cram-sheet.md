---
title: '[CKA Ch-08] 시험 직전 핵심 요약: 30분에 훑는 명령, YAML 뼈대, 함정'
description: CKA(커리큘럼 v1.37) 시험 직전 30분용 요약입니다. 시험 시작 5분에 확인할 것, 영역별 명령과 YAML 뼈대와 함정, kubeadm 업그레이드와 etcd 복구 체크리스트, 버전이 바뀌어 자주 틀리는 것 22개를 표로 정리하고 자세한 글로 연결합니다.
date: 2026-10-20T00:00:00.000Z
tags:
  - CKA
  - Kubernetes
  - Certification
  - Cheat Sheet
  - Exam Strategy
category: cert/CKA
topics:
  - cert
draft: false
series: "CKA 공부"
seriesOrder: 8
---

## 결론부터

1. 과제마다 호스트, 네임스페이스, 리소스 이름 세 가지를 먼저 확인합니다. 지정된 호스트로 `ssh`해서 풀고 끝나면 `exit`로 돌아옵니다. 다른 호스트에 남은 채 다음 과제를 시작하면 엉뚱한 클러스터를 고치게 됩니다.
2. YAML은 처음부터 쓰지 않습니다. `kubectl create`와 `run`에 `--dry-run=client -o yaml`을 붙여 뼈대를 받고 생성 명령이 없는 객체(NetworkPolicy, PV, PVC, StorageClass, Gateway, HTTPRoute)는 문서 예제를 복사해 고칩니다. 필드 이름은 `kubectl explain`으로 터미널에서 찾습니다.
3. 5분을 넘긴 과제는 표시하고 넘어갑니다. 공식 기준 120분에 15~20문항이면 문항당 6~8분이고 합격선은 66%입니다. 15분 알림이 오면 새 과제를 멈추고 이름과 네임스페이스를 다시 확인합니다.
4. 비중이 가장 큰 트러블슈팅(30%)은 `get`, `describe`의 Events, `logs --previous`, 노드의 `journalctl -u kubelet`과 `crictl` 순서로 한 층씩 내려갑니다. API 서버가 죽었으면 `kubectl` 대신 `crictl`입니다.
5. 2024년 이전 자료의 답은 버전이 바뀌어 틀릴 수 있습니다. 스냅샷 확인과 복구는 `etcdutl`, 엔드포인트 확인은 EndpointSlice, 사이드카는 `initContainers`에 `restartPolicy: Always`, HPA는 `--cpu=60%`입니다.

[Ch-00](/blog/cert/cka/cka-00-exam-and-study-plan)부터 [Ch-07](/blog/cert/cka/cka-07-resources-and-exam-day)까지에서 시험 직전에 다시 볼 것만 뽑았고 근거는 링크한 글에 있습니다.

---

## 1. 시험 시작 5분

### 1-1. 호스트에 이미 있는 도구

공식 안내 기준으로 각 호스트에는 `kubectl`(alias `k`와 자동완성 포함), `yq`, `curl`, `wget`, `man`이 있습니다. `jq`는 이 목록에 없습니다. Resources Allowed가 배포판 패키지 설치를 허용하지만 저장소 접근 여부는 공식 문서에 없으니 jsonpath와 `yq`로 연습합니다. 시작 호스트(`base`)에는 `kubectl`이 없고 직접 만든 alias는 ssh로 옮기면 사라집니다.

```bash
type k            # "k is aliased to `kubectl'"이면 준비됨
complete -p k     # 자동완성이 k에도 걸려 있는지
```

둘 중 하나가 비어 있을 때만 kubectl Quick Reference의 줄을 넣습니다.

```bash
source <(kubectl completion bash)
alias k=kubectl
complete -o default -F __start_kubectl k
```

### 1-2. 과제마다 호스트와 네임스페이스 확인

```bash
ssh <과제에 적힌 호스트>           # ssh 안에서 다시 ssh는 안 됨
k config current-context          # 과제가 컨텍스트 명령을 주면 그대로 먼저 실행
k -n <네임스페이스> get all        # 네임스페이스는 명령마다 붙인다
# ... 풀이 ...
exit                              # base로 돌아온다
```

`use-context`를 문항마다 쳤다는 이야기는 2024년 이전 후기이고 현재 안내는 ssh 방식입니다. 권한이 필요하면 `sudo -i`나 `sudo`를 씁니다([Ch-07 6-3절](/blog/cert/cka/cka-07-resources-and-exam-day)).

### 1-3. vim 설정

공식 안내가 말하는 것은 `i`로 입력하고 Esc로 나온다는 것뿐입니다(INSERT 키 금지). 들여쓰기 설정은 관행이고 호스트마다 홈 디렉터리가 따로라 그 호스트에서 다시 넣습니다.

```vim
" ~/.vimrc (관행)
set expandtab tabstop=2 shiftwidth=2
```

붙여 넣을 때 들여쓰기가 계단처럼 밀리면 `:set paste`를 먼저 켜고 붙여 넣은 파일은 `yq . 파일명`으로 문법부터 봅니다. 터미널 복사와 붙여넣기는 Ctrl+Shift+C/V입니다.

### 1-4. 뼈대는 `--dry-run=client -o yaml`

```bash
# 그 호스트에서만 쓰는 변수 (관행)
export do="--dry-run=client -o yaml"

k run pay-api --image=nginx:1.27 -n payment $do > pod.yaml
k create deploy pay-api --image=nginx:1.27 --replicas=2 -n payment $do > deploy.yaml
k expose deploy pay-api --port=80 --target-port=8080 -n payment $do > svc.yaml
```

| 생성 명령이 있음 | 생성 명령이 없음(문서 예제를 복사) |
|---|---|
| Pod(`run`), Deployment, Service(`expose` 권장), ConfigMap, Secret, ServiceAccount, Role, RoleBinding, ClusterRole, ClusterRoleBinding, ResourceQuota(`quota`), PriorityClass, Ingress, Job, CronJob, HPA(`autoscale`) | NetworkPolicy, PV, PVC, StorageClass, LimitRange, DaemonSet(Deployment 뼈대에서 kind를 바꿈), Gateway, HTTPRoute, CRD |

자세한 목록은 [Ch-01.5 7-6절](/blog/cert/cka/cka-01b-core-objects-and-flow)에 있습니다.

### 1-5. 필드 이름은 `kubectl explain`

```bash
k explain deploy.spec.strategy.rollingUpdate
k explain pod.spec.containers.resources --recursive | head -30
k explain networkpolicy.spec.egress.to
k explain boardjob.spec          # CRD 스키마도 보인다
```

YAML 파일에 `namespace:`를 적었다면 `-n`을 빼고 적지 않았다면 `-n`을 붙입니다. 파일 값과 `-n` 값이 다르면 `the namespace from the provided object ... does not match` 오류가 납니다([Ch-01.5 7-5절](/blog/cert/cka/cka-01b-core-objects-and-flow)).

---

## 2. 영역별 외울 것 (v1.37 비중 순)

### 2-1. 트러블슈팅 30%

| 항목 | 외울 명령 | YAML 뼈대 | 함정 | 자세히 |
|---|---|---|---|---|
| 첫 3분 | `k get pod -o wide`, `k describe pod`(Events), `k get events --sort-by=.metadata.creationTimestamp` | 없음 | 이벤트는 네임스페이스 단위 | [Ch-06 0절](/blog/cert/cka/cka-06-troubleshooting) |
| 노드 NotReady | 노드에서 `systemctl status kubelet`, `journalctl -u kubelet -n 50`, `systemctl status containerd`, `crictl info` | `/var/lib/kubelet/config.yaml`, `/etc/kubernetes/kubelet.conf`, `kubeadm-flags.env` | `restart`만 하고 `enable`을 빠뜨림. 1.35부터 cgroup v1 노드는 kubelet이 기본으로 시작 안 함 | [Ch-06 1-3, 1-4절](/blog/cert/cka/cka-06-troubleshooting) |
| 컨트롤 플레인 구성요소 | `crictl ps -a`, `crictl logs <ID>`, `ls /var/log/pods` | `/etc/kubernetes/manifests/*.yaml` | 매니페스트 백업을 같은 디렉터리에 두면 kubelet이 그것도 읽음. mirror Pod를 `delete`해도 다시 생김 | [Ch-06 2절](/blog/cert/cka/cka-06-troubleshooting) |
| 리소스 사용량 | `k top pod -A --sort-by=cpu --no-headers`, `k top pod --containers` | 없음 | `--sort-by`는 `cpu`, `memory`만. metrics-server가 없으면 동작 안 함 | [Ch-06 3-2, 3-4절](/blog/cert/cka/cka-06-troubleshooting) |
| 값 뽑기 | `-o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}'`, `-o custom-columns=NAME:.metadata.name`, `--sort-by=` | 없음 | custom-columns에는 `.items[*]`를 붙이지 않음. JSONPath는 정규식 없음. 식은 작은따옴표로 | [Ch-06 3-5, 3-6절](/blog/cert/cka/cka-06-troubleshooting) |
| 컨테이너 로그 | `k logs <pod> -c <컨테이너> --previous`, `k logs -l app=x --all-containers --prefix` | 없음 | `-c` 없이 치면 기본 컨테이너(어노테이션, 없으면 첫 번째) 로그가 나옴. `Defaulted container` 안내를 본다 | [Ch-06 4절](/blog/cert/cka/cka-06-troubleshooting) |
| Service 응답 없음 | `k get endpointslices -l kubernetes.io/service-name=<svc>`, `k get pod --show-labels`, 임시 Pod에서 `wget -qO- -T 2` | 없음 | ENDPOINTS가 비면 selector와 라벨, 아니면 readiness. `nslookup` 성공은 엔드포인트 존재를 뜻하지 않음 | [Ch-06 5절](/blog/cert/cka/cka-06-troubleshooting) |

### 2-2. 클러스터 아키텍처, 설치, 구성 25%

| 항목 | 외울 명령 | YAML 뼈대 | 함정 | 자세히 |
|---|---|---|---|---|
| RBAC | `k create role/rolebinding/clusterrole/clusterrolebinding`, `k auth can-i <동사> <리소스> -n <ns> --as=system:serviceaccount:<ns>:<sa>` | 명령형으로 만들고 `$do`로 확인 | 클러스터 범위 리소스는 ClusterRole. 그룹 있는 리소스는 `deployments.apps`. `roleRef`는 수정 불가라 지우고 다시 만듦 | [Ch-02 1절](/blog/cert/cka/cka-02-cluster-architecture) |
| 사용자 인증서 | `openssl req ... -subj "/CN=user/O=group"`, `k certificate approve`, `k get csr <이름> -o jsonpath='{.status.certificate}'` | CSR(`signerName: kubernetes.io/kube-apiserver-client`, `usages: [client auth]`) | 승인된 CSR은 1시간 뒤 자동 삭제. 인증서만으로는 권한 없음 | [Ch-02 1-9절](/blog/cert/cka/cka-02-cluster-architecture) |
| kubeadm 업그레이드 | `kubeadm upgrade plan`, `upgrade apply v1.37.x`, `upgrade node`, `drain`, `uncordon` | 없음 | 마이너 버전 건너뛰기 불가. 패키지 저장소를 목표 마이너로 먼저 바꿈 | [Ch-02 4-1, 4-2절](/blog/cert/cka/cka-02-cluster-architecture) |
| etcd | `etcdctl snapshot save`, `etcdutl snapshot status`, `etcdutl --data-dir <새 경로> snapshot restore` | etcd.yaml의 `etcd-data` 볼륨 `hostPath.path` | 인증서 경로는 etcd.yaml에서 확인. etcd 3.6은 `etcdctl snapshot status/restore` 제거 | [Ch-02 4-5, 4-6절](/blog/cert/cka/cka-02-cluster-architecture) |
| 인증서 | `kubeadm certs check-expiration`, `kubeadm certs renew all`, `openssl x509 -noout -enddate -in <crt>` | 없음 | renew 뒤 컨트롤 플레인 static Pod 재시작 필요. `kubelet.conf`는 목록에 없음 | [Ch-02 4-4, 4-8절](/blog/cert/cka/cka-02-cluster-architecture) |
| Helm | `helm show values`, `helm install <이름> <차트> -n <ns> --create-namespace --set k=v`, `helm upgrade --install`, `helm rollback <이름> <리비전>` | values 파일(`-f`) | 인자 순서는 `[NAME] [CHART]`. `--set`이 `-f`보다 우선. Helm 4는 `--atomic`이 `--rollback-on-failure` | [Ch-02 6-1, 6-6절](/blog/cert/cka/cka-02-cluster-architecture) |
| Kustomize | `k kustomize <디렉터리>`(출력만), `k apply -k <디렉터리>` | `kustomization.yaml`의 `resources`, `namespace`, `namePrefix`, `images`, `patches` | `patchesStrategicMerge`, `bases`, `commonLabels`는 사용 중단. `patches`, `resources`, `labels` 사용 | [Ch-02 6-2, 6-4절](/blog/cert/cka/cka-02-cluster-architecture) |
| CNI 설치 | kube-controller-manager.yaml의 `--cluster-cidr`, `k get node -o jsonpath='{.items[*].spec.podCIDR}'`, `ls /etc/cni/net.d` | 과제가 준 매니페스트 | 과제가 지정하지 않았으면 클러스터의 실제 Pod CIDR에 플러그인 값을 맞춤. CNI 전에는 CoreDNS `Pending`이 정상 | [Ch-02 7-2절](/blog/cert/cka/cka-02-cluster-architecture) |
| CRD와 오퍼레이터 | `k get crd`, `k api-resources --api-group=<그룹>`, `k explain <kind>.spec` | CRD(`metadata.name: <plural>.<group>`, `storage: true` 하나) | CRD를 지우면 커스텀 객체도 사라짐. 컨트롤러 없이는 객체만 저장됨 | [Ch-02 8절](/blog/cert/cka/cka-02-cluster-architecture) |

### 2-3. 서비스와 네트워킹 20%

| 항목 | 외울 명령 | YAML 뼈대 | 함정 | 자세히 |
|---|---|---|---|---|
| Pod 간 연결 | `k get pod -o wide`, `k run tmp --rm -it --restart=Never --image=busybox -- wget -qO- -T 2 <IP>:<포트>` | 없음 | `-T 2`로 타임아웃. 정책에 Pod IP를 박지 않음 | [Ch-04 1-6절](/blog/cert/cka/cka-04-services-networking) |
| 대역과 모드 확인 | apiserver의 `--service-cluster-ip-range`, controller-manager의 `--cluster-cidr`, `kube-proxy` ConfigMap의 `mode` | 없음 | kube-proxy `mode`가 빈 값이면 1.37 기본 `iptables` | [Ch-04 1-5절](/blog/cert/cka/cka-04-services-networking) |
| NetworkPolicy | `k describe networkpolicy <이름>`으로 해석 확인 | 3-1절 | `from` 한 항목 안의 `namespaceSelector`+`podSelector`는 AND, 대시를 나누면 OR. Egress를 막으면 DNS도 막힘 | [Ch-04 2절](/blog/cert/cka/cka-04-services-networking) |
| Service | `k expose deploy <이름> --port=80 --target-port=8080 [--type=NodePort]` | 특정 `nodePort`는 `$do`로 뽑아 추가 | `k create service`는 selector를 `app=<서비스 이름>`으로 고정. `targetPort` 생략 시 `port`와 같음. NodePort 기본 범위 30000-32767 | [Ch-04 3절](/blog/cert/cka/cka-04-services-networking) |
| Gateway API | `k get gatewayclass`, `k get gateway,httproute -A`, `k describe httproute` | 3-3절 | 클래스 이름은 클러스터에 있는 것을 씀. 다른 네임스페이스 Route는 `allowedRoutes` 기본값 `Same`이라 안 붙음. `Accepted`, `ResolvedRefs` 조건을 봄 | [Ch-04 4절](/blog/cert/cka/cka-04-services-networking) |
| Ingress | `k create ingress <이름> --class=<클래스> --rule="host/path*=svc:80[,tls=secret]"` | `$do`로 뽑음 | 경로 끝 `*`이면 Prefix, 없으면 Exact. 백엔드는 같은 네임스페이스의 Service 포트 | [Ch-04 5-4, 5-7절](/blog/cert/cka/cka-04-services-networking) |
| CoreDNS | `k exec -it <pod> -- nslookup kubernetes.default`, `k -n kube-system get pod -l k8s-app=kube-dns`, `k -n kube-system get cm coredns -o yaml` | Corefile | Service 이름은 `kube-dns`. `dnsPolicy` 기본값은 `ClusterFirst`. Corefile 중괄호 하나로 CrashLoopBackOff | [Ch-04 6절](/blog/cert/cka/cka-04-services-networking) |

### 2-4. 워크로드와 스케줄링 15%

| 항목 | 외울 명령 | YAML 뼈대 | 함정 | 자세히 |
|---|---|---|---|---|
| 롤아웃 | `k set image deploy/<이름> <컨테이너>=<이미지>`, `k rollout status/history/undo [--to-revision=N]`, `k rollout restart` | 없음 | 레플리카 변경은 리비전을 만들지 않음. 컨테이너 이름은 이미지 이름에서 옴 | [Ch-03 1절](/blog/cert/cka/cka-03-workloads-scheduling) |
| Pod 수정 | `k edit pod` 실패 시 `k replace --force -f /tmp/kubectl-edit-*.yaml` | 없음 | 실행 중 Pod는 이미지, 톨러레이션 추가 등 일부만 수정 가능 | [Ch-03 1-4절](/blog/cert/cka/cka-03-workloads-scheduling) |
| ConfigMap, Secret | `k create cm <이름> --from-literal=K=V`, `k create secret generic/tls`, `k set env deploy/<이름> --from=configmap/<이름>` | `volumes[].configMap`, `env[].valueFrom.secretKeyRef` | 환경 변수 주입은 재시작해야 반영. `subPath` 마운트는 갱신 안 됨 | [Ch-03 2절](/blog/cert/cka/cka-03-workloads-scheduling) |
| HPA | `k autoscale deploy <이름> --cpu=60% --min=2 --max=8` | `autoscaling/v2`의 `behavior` | CPU request가 없으면 CPU 기준 동작 불가. `%`를 빼면 양으로 해석 | [Ch-03 3-2절](/blog/cert/cka/cka-03-workloads-scheduling) |
| in-place resize | `k patch pod <pod> --subresource resize --patch '{...}'` | 없음 | 1.35 stable. CPU와 메모리만, QoS 클래스가 바뀌는 변경은 거절 | [Ch-03 3-3절](/blog/cert/cka/cka-03-workloads-scheduling) |
| 사이드카 | `k logs <pod> -c <사이드카>` | 3-5절 | `initContainers`에 `restartPolicy: Always`. `containers`에 두면 일반 컨테이너 | [Ch-03 4-4절](/blog/cert/cka/cka-03-workloads-scheduling) |
| 자원과 승인 | `k set resources deploy <이름> --requests=cpu=100m --limits=cpu=500m`, `k create quota <이름> --hard=pods=10` | LimitRange(`default`, `defaultRequest`, `max`) | 쿼터 초과 Deployment는 만들어지고 Pod만 안 생김. 메모리 `400m`은 0.4바이트 | [Ch-03 5-2~5-4절](/blog/cert/cka/cka-03-workloads-scheduling) |
| 노드 고르기 | `k label node <노드> k=v`, `k taint node <노드> k=v:NoSchedule[-]` | `nodeSelector`, `affinity.nodeAffinity`, `tolerations` | 톨러레이션만으로는 그 노드로 가지 않음. `nodeSelectorTerms`끼리 OR, `matchExpressions` 안은 AND | [Ch-03 5-5~5-7절](/blog/cert/cka/cka-03-workloads-scheduling) |
| static Pod, DaemonSet | `k run ... $do > f.yaml` 후 노드의 `/etc/kubernetes/manifests`에 복사 | DaemonSet은 Deployment 뼈대에서 `replicas`, `strategy` 삭제 | 컨트롤 플레인 테인트는 DaemonSet 자동 톨러레이션에 없음 | [Ch-03 5-8, 5-10절](/blog/cert/cka/cka-03-workloads-scheduling) |
| PriorityClass | `k create priorityclass <이름> --value=100000 [--preemption-policy=Never]` | `spec.priorityClassName` | 사용자 값은 10억 이하. 없는 이름을 적으면 Pod 거절 | [Ch-03 5-9절](/blog/cert/cka/cka-03-workloads-scheduling) |

### 2-5. 스토리지 10%

| 항목 | 외울 명령 | YAML 뼈대 | 함정 | 자세히 |
|---|---|---|---|---|
| StorageClass | `k get sc`, 기본 클래스 교체는 어노테이션 `storageclass.kubernetes.io/is-default-class`를 patch | 3-2절 | `reclaimPolicy` 생략 시 `Delete`, `volumeBindingMode` 생략 시 `Immediate` | [Ch-05 1절](/blog/cert/cka/cka-05-storage) |
| 접근 모드와 회수 | `k patch pv <pv> -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'` | `accessModes`, `persistentVolumeReclaimPolicy` | RWO는 노드 하나 기준. Pod 하나는 RWOP(CSI 전용). `Recycle`은 사용 중단 | [Ch-05 2절](/blog/cert/cka/cka-05-storage) |
| PV와 PVC | `k get pv,pvc`, `k describe pvc`, `k -n <ns> patch pvc <이름> -p '{"spec":{"resources":{"requests":{"storage":"30Gi"}}}}'` | 3-2절 | `storageClassName` 생략은 기본 클래스, `""`는 클래스 없는 PV만. `WaitForFirstConsumer`는 Pod 전까지 `Pending`이 정상 | [Ch-05 3절](/blog/cert/cka/cka-05-storage) |
| Released 재사용 | `k patch pv <pv> --type=json -p '[{"op":"remove","path":"/spec/claimRef"}]'` | PVC의 `volumeName` | `Retain` PV는 PVC 삭제 뒤 `Released`라 자동으로 다시 묶이지 않음 | [Ch-05 2-3, 3-2절](/blog/cert/cka/cka-05-storage) |

---

## 3. 손으로 바로 쓸 YAML 뼈대

### 3-1. NetworkPolicy: 기본 거부와 DNS 허용

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: shop
spec:
  podSelector: {}            # 네임스페이스의 모든 Pod
  policyTypes: ["Ingress", "Egress"]   # 규칙 필드가 없으면 전부 거부
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns
  namespace: shop
spec:
  podSelector: {}
  policyTypes: ["Egress"]
  egress:
  - to:
    - namespaceSelector:     # 같은 항목 안이라 AND
        matchLabels:
          kubernetes.io/metadata.name: kube-system
      podSelector:
        matchLabels:
          k8s-app: kube-dns
    ports:
    - { protocol: UDP, port: 53 }
    - { protocol: TCP, port: 53 }
```


### 3-2. StorageClass, PV, PVC

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: local-storage
provisioner: kubernetes.io/no-provisioner   # 동적 프로비저닝 없음
volumeBindingMode: WaitForFirstConsumer
---
apiVersion: v1
kind: PersistentVolume
metadata:
  name: board-files-pv
spec:
  storageClassName: manual
  capacity: { storage: 10Gi }
  accessModes: ["ReadWriteOnce"]
  persistentVolumeReclaimPolicy: Retain
  hostPath: { path: /mnt/data }
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: board-files
  namespace: shop
spec:
  storageClassName: manual   # PV와 같게. 생략하면 기본 클래스가 붙는다
  accessModes: ["ReadWriteOnce"]
  resources:
    requests: { storage: 3Gi }
```

Pod 쪽은 `volumes[].persistentVolumeClaim.claimName: board-files`이고 PV 이름을 직접 적지 않습니다.

### 3-3. Gateway와 HTTPRoute

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: shop-gw
  namespace: shop
spec:
  gatewayClassName: <k get gatewayclass 결과>
  listeners:
  - name: http
    protocol: HTTP
    port: 80
    hostname: "shop.example.com"
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: shop-route
  namespace: shop
spec:
  parentRefs:
  - name: shop-gw
  hostnames: ["shop.example.com"]
  rules:
  - matches:
    - path: { type: PathPrefix, value: /orders }
    backendRefs:
    - name: order-api
      port: 80
```

가중치는 `backendRefs[].weight`, 헤더 매칭은 `matches[].headers`입니다. 예제는 시험 중 열 수 있는 gateway-api.sigs.k8s.io에 있습니다([Ch-04 4-4, 4-6절](/blog/cert/cka/cka-04-services-networking)).

### 3-4. RBAC 명령형

```bash
k create sa order-api -n shop
k create role config-reader -n shop --verb=get,list,watch --resource=configmaps
k create rolebinding order-api-config -n shop --role=config-reader --serviceaccount=shop:order-api
k create clusterrole node-reader --verb=get,list --resource=nodes
k create clusterrolebinding settle-node-reader --clusterrole=node-reader --user=settle-user

k auth can-i list configmaps -n shop --as=system:serviceaccount:shop:order-api   # yes
k auth can-i --list -n shop --as=system:serviceaccount:shop:order-api
```

`--as`의 사용자 이름은 `system:serviceaccount:`(단수)이고 그룹은 `system:serviceaccounts:`(복수)입니다.

### 3-5. 사이드카

```yaml
spec:
  initContainers:
  - name: log-shipper
    image: busybox:1.36
    restartPolicy: Always            # 이 줄이 사이드카를 만든다
    command: ["sh", "-c", "tail -n+1 -F /var/log/board/access.log"]
    volumeMounts: [{ name: logs, mountPath: /var/log/board }]
  containers:
  - name: app
    image: <앱 이미지>
    volumeMounts: [{ name: logs, mountPath: /var/log/board }]
  volumes:
  - name: logs
    emptyDir: {}
```

### 3-6. PriorityClass와 HPA

```bash
k create priorityclass payment-high --value=100000 --description="결제 API용"
# Pod 템플릿: spec.priorityClassName: payment-high

k autoscale deploy order-api -n shop --cpu=60% --min=2 --max=8
k get hpa -n shop     # <unknown>이면 metrics-server, CPU request 확인
```

---

## 4. 절차형 과제 체크리스트

### 4-1. kubeadm 업그레이드

```text
[첫 컨트롤 플레인]
1. 패키지 저장소를 목표 마이너(pkgs.k8s.io의 v1.37 경로)로 바꾼다
2. apt-mark unhold kubeadm -> apt-get install kubeadm='1.37.x-*' -> apt-mark hold kubeadm
3. kubeadm upgrade plan -> kubeadm upgrade apply v1.37.x
4. kubectl drain <노드> --ignore-daemonsets
5. kubelet, kubectl 패키지 교체 -> systemctl daemon-reload -> systemctl restart kubelet
6. kubectl uncordon <노드>

[나머지 컨트롤 플레인, 워커]
kubeadm 패키지 교체 -> kubeadm upgrade node -> 4~6 반복
```

컨트롤 플레인을 모두 끝낸 뒤 워커로 갑니다. kubelet은 kube-apiserver보다 새로울 수 없기 때문입니다. `drain`은 kubectl이 있는 호스트에서, apt와 kubeadm은 해당 노드에서 실행합니다([Ch-02 4-2, 4-3절](/blog/cert/cka/cka-02-cluster-architecture)).

### 4-2. etcd 백업과 복구

```bash
# 0) 인증서 경로부터 확인
sudo grep -E 'cert|key|trusted|data-dir' /etc/kubernetes/manifests/etcd.yaml

# 1) 백업: 동작 중인 멤버에 접속하므로 etcdctl
sudo ETCDCTL_API=3 etcdctl --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  snapshot save /opt/backup/etcd-snapshot.db

# 2) 확인: etcdutl
etcdutl --write-out=table snapshot status /opt/backup/etcd-snapshot.db

# 3) 복구: 새 디렉터리에 푼다
sudo etcdutl --data-dir /var/lib/etcd-restore snapshot restore /opt/backup/etcd-snapshot.db

# 4) etcd.yaml에서 name: etcd-data 볼륨의 hostPath.path를 /var/lib/etcd-restore로 바꾼다
sudo vi /etc/kubernetes/manifests/etcd.yaml

# 5) kubelet이 etcd를 다시 띄우는지 확인
sudo crictl ps | grep etcd
```

`ETCDCTL_API=3`은 etcd 3.4부터 기본값입니다. 문서는 API 서버가 도는 중에 복구하지 말라고 적습니다([Ch-02 4-5, 4-6절](/blog/cert/cka/cka-02-cluster-architecture)).

### 4-3. 노드 drain

```bash
k drain <노드> --ignore-daemonsets [--delete-emptydir-data] [--force]
k get node                       # SchedulingDisabled
k uncordon <노드>
```

| 막히는 이유 | 옵션 |
|---|---|
| DaemonSet Pod | `--ignore-daemonsets`(DaemonSet Pod는 어느 쪽이든 지우지 않음) |
| 관리자 없는 단독 Pod | `--force`(지운 Pod는 다른 노드에 다시 생기지 않음) |
| emptyDir 사용 Pod | `--delete-emptydir-data`(데이터 삭제) |
| PDB가 허용하는 중단 수 0 | drain이 재시도하며 대기 |

uncordon해도 내보낸 Pod는 돌아오지 않습니다([Ch-02 4-7절](/blog/cert/cka/cka-02-cluster-architecture)).

### 4-4. 인증서 확인과 갱신

```bash
sudo kubeadm certs check-expiration
sudo kubeadm certs renew all
# 갱신 뒤 컨트롤 플레인 static Pod 재시작: 매니페스트를 잠시 밖으로
sudo mv /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/ && sleep 20 \
  && sudo mv /tmp/kube-apiserver.yaml /etc/kubernetes/manifests/

sudo openssl x509 -in /etc/kubernetes/pki/apiserver.crt -noout -subject -issuer -enddate
# kubelet 클라이언트 인증서는 check-expiration 목록에 없다
sudo openssl x509 -in /var/lib/kubelet/pki/kubelet-client-current.pem -noout -subject -dates
```

kubelet 클라이언트 인증서의 정상 subject는 `O = system:nodes, CN = system:node:<노드 이름>`입니다. 자동 교체가 실패했을 때의 복구 절차는 [Ch-06 1-4절](/blog/cert/cka/cka-06-troubleshooting)에 있습니다.

### 4-5. CSR 승인

```bash
openssl genrsa -out settle-user.key 3072
openssl req -new -key settle-user.key -out settle-user.csr -subj "/CN=settle-user/O=finance"
cat settle-user.csr | base64 | tr -d "\n"     # CSR 객체의 spec.request

k apply -f settle-user-csr.yaml               # signerName, usages: [client auth]
k get csr
k certificate approve settle-user
k get csr settle-user -o jsonpath='{.status.certificate}' | base64 -d > settle-user.crt
k config set-credentials settle-user --client-key=settle-user.key \
  --client-certificate=settle-user.crt --embed-certs=true
```

kube-controller-manager가 자동 승인하는 내장 서명자는 `kubernetes.io/kube-apiserver-client-kubelet`뿐입니다. `serverTLSBootstrap: true`로 받는 kubelet 서빙 인증서 CSR도 손으로 승인합니다.

### 4-6. static Pod 장애 복구

```text
1. ssh <컨트롤 플레인 노드>
2. sudo crictl ps -a | grep <구성요소>        종료된 컨테이너까지
3. sudo crictl logs <컨테이너 ID>            첫 오류 줄
   (컨테이너가 아예 없으면) sudo journalctl -u kubelet -n 50   YAML 파싱 오류
4. sudo cp <매니페스트> /etc/kubernetes/backup/   백업은 manifests 밖에
5. 플래그 오타, 인증서 경로와 hostPath 마운트, --etcd-servers 포트, image 태그, 들여쓰기 확인
6. 저장 후 crictl ps로 새 컨테이너가 뜰 때까지 기다린 뒤 kubectl
```

의심할 곳은 증상마다 다릅니다. `kubectl` 전체 실패는 kube-apiserver나 etcd, Pod 미생성은 kube-controller-manager, 이벤트 없는 `Pending`은 kube-scheduler입니다. `kubectl delete pod kube-apiserver-<노드>`는 mirror Pod만 지웁니다([Ch-06 2절](/blog/cert/cka/cka-06-troubleshooting)).

### 4-7. 런타임 패키지 설치

```text
1. ssh <노드>, sudo dpkg -i <과제가 준 .deb>
2. sudo systemctl daemon-reload            새 유닛 파일 읽기
3. sudo systemctl enable --now <서비스>     cri-dockerd는 cri-docker.service
4. systemctl status <서비스>, ls <소켓>     cri-dockerd 기본 /run/cri-dockerd.sock
5. kubeadm init/join --cri-socket unix:///run/cri-dockerd.sock
```

1.36부터는 containerd 2.0 이상이 필요합니다(v1.35 릴리스 글). sysctl은 `/etc/sysctl.d/`에 쓰고 `sysctl --system`으로 적용합니다([Ch-02 2절](/blog/cert/cka/cka-02-cluster-architecture)).

---

## 5. 자주 틀리는 것 22개

왼쪽은 옛 자료나 흔한 착각, 오른쪽은 문서로 확인한 내용입니다.

| # | 옛 설명이나 흔한 착각 | 지금 기준 | 자세히 |
|---|---|---|---|
| 1 | `etcdctl snapshot status`, `snapshot restore`로 확인과 복구 | etcd 3.6에서 제거. `etcdutl`을 씀. 저장(`save`)만 `etcdctl` | Ch-02 4-5 |
| 2 | 사이드카는 1.29부터 정식 | 1.29 beta(기본 활성), 1.33 stable. `initContainers` + `restartPolicy: Always` | Ch-03 4-4 |
| 3 | in-place resize는 기능 게이트를 켜야 함 | 1.35 stable. `--subresource resize`, kubectl 1.32 이상 | Ch-03 3-3 |
| 4 | `kubectl get endpoints`로 엔드포인트 확인 | Endpoints API는 1.33부터 사용 중단. `get endpointslices -l kubernetes.io/service-name=<svc>` | Ch-04 3-5 |
| 5 | Ingress 컨트롤러는 ingress-nginx | 2026년 3월 유지보수 종료, 저장소 보관. Ingress API는 동결된 GA로 남고 새 기능은 Gateway API | Ch-04 5-1 |
| 6 | `from`의 `podSelector`는 모든 네임스페이스의 Pod | 정책과 같은 네임스페이스의 Pod만. 다른 네임스페이스는 `namespaceSelector`와 같은 항목에 | Ch-04 2-2 |
| 7 | namespaceSelector를 쓰려면 네임스페이스에 라벨을 붙여야 함 | `kubernetes.io/metadata.name` 라벨이 자동으로 붙어 있음 | Ch-04 2-2 |
| 8 | `nodeName`을 쓰면 어드미션을 우회 | 어드미션은 그대로 거치고 건너뛰는 것은 스케줄러뿐. 자원이 모자라면 `OutOfcpu` 등으로 `Failed` | Ch-03 5-5 |
| 9 | `kubectl autoscale --cpu-percent=60` | 1.34부터 `--cpu=60%`. `--cpu-percent`는 사용 중단, 함께 쓰면 오류 | Ch-03 3-2 |
| 10 | kubelet과 kube-proxy는 apiserver보다 두 마이너까지 낮아도 됨 | 1.25 이후 세 마이너까지. apiserver보다 새로울 수는 없음 | Ch-02 4-1 |
| 11 | RWO는 Pod 하나만 쓸 수 있음 | 노드 하나 기준. 같은 노드의 여러 Pod 가능. Pod 하나는 RWOP | Ch-05 2-2 |
| 12 | PVC에서 `storageClassName`을 빼면 클래스 없는 PV에 묶임 | 생략하면 기본 클래스가 붙음. 클래스 없는 PV에 묶으려면 `""` | Ch-05 3-2 |
| 13 | 매니페스트 백업은 같은 디렉터리에 `.bak`으로 | kubelet은 점으로 시작하는 파일만 무시. 백업은 `/etc/kubernetes/manifests` 밖에 | Ch-06 2-2 |
| 14 | 멀티 컨테이너 Pod에서 `-c` 없이 `kubectl logs`를 치면 오류 | 기본 컨테이너(어노테이션, 없으면 첫 번째) 로그를 보여 줌. 사이드카 로그를 원하면 `-c` | Ch-06 4-2 |
| 15 | `kubeadm certs check-expiration`으로 kubelet 인증서도 확인 | `kubelet.conf`는 목록에 없음. `openssl`로 `kubelet-client-current.pem`을 직접 봄 | Ch-06 1-4 |
| 16 | kube-proxy는 IPVS가 최신 권장 모드 | IPVS는 1.35부터 사용 중단. 기본은 1.37 기준 `iptables`, 대체 권장은 nftables | Ch-04 1-5 |
| 17 | 노드가 죽으면 `--pod-eviction-timeout` 5분 뒤 축출 | 이 플래그는 1.37에 없음. `--node-monitor-grace-period`(50s) 뒤 NoExecute 테인트, `tolerationSeconds: 300` 뒤 축출 | Ch-02 4-7 |
| 18 | 테인트를 견디는 톨러레이션을 주면 그 노드로 감 | 톨러레이션은 허가일 뿐. 보내려면 nodeSelector나 노드 어피니티를 함께 | Ch-03 5-7 |
| 19 | PriorityClass 사용자 값은 2억~10억 | 10억 이하의 32비트 정수면 됨. 하한은 없음 | Ch-03 5-9 |
| 20 | Kustomize의 `patchesStrategicMerge`, `bases`, `commonLabels` | 사용 중단. `patches`, `resources`, `labels` | Ch-02 6-4 |
| 21 | HPA `minReplicas`는 1 이상 | 1.37 beta(기본 활성)부터 Object, External 메트릭이면 `0` 가능. CPU, 메모리 기준은 불가 | Ch-07 5-3 |
| 22 | static Pod도 `configMapRef`, `secretRef`를 쓸 수 있음 | API 객체 참조 불가. 1.37부터 완전 금지, 우회 게이트 제거 | Ch-06 2-5 |


---

## 6. 당일 시간 배분

| 구간 | 할 일 |
|---|---|
| 0~5분 | 문항 목록을 훑고 난이도를 가늠 |
| 첫 바퀴(약 80분) | 6~8분 안에 끝낼 과제부터 풀고 검증. 5분을 넘기면 표시하고 넘김 |
| 두 바퀴(약 25분) | 표시한 과제. 부분 점수를 위해 이름이 지정된 리소스부터 만듦 |
| 마지막 10분 | 15분 알림에서 새 과제를 멈추고 리소스 이름, 네임스페이스, 호스트 재확인 |

과제 하나는 호스트 이동, 뼈대 생성, 적용, 검증, `exit` 순서로 풉니다. 알림은 30분, 15분, 5분 남았을 때 오고 연결이 끊겨도 타이머는 멈추지 않습니다. 표시 기능 자체는 LF ExamUI 문서에서 확인하지 못했고 후기들이 표시하고 넘겼다고 적은 것을 옮겼습니다. 당일 체크리스트와 D-30 계획은 [Ch-07 6절과 7절](/blog/cert/cka/cka-07-resources-and-exam-day)에 있습니다.

---

## 범위와 한계

- 이 글은 Ch-00~Ch-07과 Ch-01.5의 요약이고 근거와 출처는 링크한 글에 있습니다. 요약에서 조건이 빠졌다면 원래 글이 기준입니다.
- 명령과 YAML은 클러스터가 없는 Mac에서 쓴 것이라 실행하지 않았습니다. 공식 문서 예시를 쇼핑몰, 게시판, 결제 이름으로 옮겼으니 연습 클러스터에서 확인한 뒤 씁니다.
- 기준은 Kubernetes v1.37, etcd 3.7.0(kubeadm 1.37 기본값), Helm 4.3(2026년 10월)입니다. 시험 환경의 etcd와 Helm 버전은 공식 문서에 없어서 당일 `etcdutl version`, `helm version`으로 확인합니다.
- etcd 백업 복구와 kubeadm 업그레이드는 2025년 개정에서 명시 항목이 아닙니다. "클러스터 수명주기 관리"에 드는지 확인하지 못해 남겼습니다.
- `.vimrc`, `export do=...`, 시간 배분은 관행과 후기에서 온 것입니다. 시험 환경의 Gateway 구현체와 Ingress 컨트롤러 종류도 공식 문서에서 확인하지 못했습니다.

## 참고 자료

공식 문서
- CNCF, [CKA Curriculum v1.37](https://github.com/cncf/curriculum/blob/master/CKA_Curriculum_v1.37.pdf)
- Linux Foundation, [Important Instructions: CKA and CKAD](https://docs.linuxfoundation.org/tc-docs/certification/tips-cka-and-ckad)
- Kubernetes, [kubectl Quick Reference](https://kubernetes.io/docs/reference/kubectl/quick-reference/)
- Kubernetes, [Using RBAC Authorization](https://kubernetes.io/docs/reference/access-authn-authz/rbac/), [Certificates and Certificate Signing Requests](https://kubernetes.io/docs/reference/access-authn-authz/certificate-signing-requests/)
- Kubernetes, [Version Skew Policy](https://kubernetes.io/releases/version-skew-policy/), [Upgrading kubeadm clusters](https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/kubeadm-upgrade/), [Certificate Management with kubeadm](https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/kubeadm-certs/), [Operating etcd clusters for Kubernetes](https://kubernetes.io/docs/tasks/administer-cluster/configure-upgrade-etcd/)
- etcd, [CHANGELOG-3.6](https://github.com/etcd-io/etcd/blob/main/CHANGELOG/CHANGELOG-3.6.md)
- Kubernetes, [Container Runtimes](https://kubernetes.io/docs/setup/production-environment/container-runtimes/), 블로그 [v1.35](https://kubernetes.io/blog/2025/12/17/kubernetes-v1-35-release/), [v1.37](https://kubernetes.io/blog/2026/08/26/kubernetes-v1-37-release/)
- Kubernetes, [Network Policies](https://kubernetes.io/docs/concepts/services-networking/network-policies/), [EndpointSlices](https://kubernetes.io/docs/concepts/services-networking/endpoint-slices/), [Virtual IPs and Service Proxies](https://kubernetes.io/docs/reference/networking/virtual-ips/)
- Kubernetes 블로그, [Ingress NGINX Retirement: What You Need to Know](https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/), 2025-11-11
- Gateway API, [HTTP routing](https://gateway-api.sigs.k8s.io/guides/http-routing/)
- Kubernetes, [Sidecar Containers](https://kubernetes.io/docs/concepts/workloads/pods/sidecar-containers/), [Resize CPU and Memory Resources assigned to Containers](https://kubernetes.io/docs/tasks/configure-pod-container/resize-container-resources/), [Assigning Pods to Nodes](https://kubernetes.io/docs/concepts/scheduling-eviction/assign-pod-node/), [Create static Pods](https://kubernetes.io/docs/tasks/configure-pod-container/static-pod/)
- Kubernetes, [Persistent Volumes](https://kubernetes.io/docs/concepts/storage/persistent-volumes/), [Storage Classes](https://kubernetes.io/docs/concepts/storage/storage-classes/)
- Kubernetes, [Debugging Kubernetes nodes with crictl](https://kubernetes.io/docs/tasks/debug/debug-cluster/crictl/)
- Helm, [Helm 4 Overview](https://helm.sh/docs/overview/), Kustomize, [patchesStrategicMerge](https://kubectl.docs.kubernetes.io/references/kustomize/kustomization/patchesstrategicmerge/)


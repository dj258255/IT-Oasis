---
title: '[CKA Ch-03] 워크로드와 스케줄링: Pod가 어디에 얼마만큼 뜨는지 정하는 값들'
description: CKA 비중 15%인 워크로드와 스케줄링 영역을 v1.37 커리큘럼 목차 순서대로 정리합니다. 롤링 업데이트와 롤백, ConfigMap과 Secret, HPA(kubectl autoscale --cpu, tolerance)와 VPA, in-place resize, 자가 치유를 만드는 restartPolicy와 프로브, 네이티브 사이드카, 그리고 requests와 limits, LimitRange, ResourceQuota, 노드 어피니티, 테인트, static Pod, PriorityClass, DaemonSet, Binding 수동 스케줄링, 다중 스케줄러와 프로파일, 어드미션 웹훅, command와 args, Secret 저장 시 암호화, imagePullSecrets, securityContext를 공식 문서 기준으로 묶고 항목마다 직접 해 볼 과제를 붙였습니다.
date: 2026-10-19T00:00:00.000Z
tags:
  - CKA
  - Kubernetes
  - Deployment
  - HPA
  - Scheduling
  - Taints
category: cert/CKA
topics:
  - cert
draft: false
series: "CKA 공부"
seriesOrder: 3
---

## 결론부터

1. 이 영역의 값은 Pod가 만들어지는 길목 세 곳에서 작동합니다. API 서버의 승인 단계(LimitRange, ResourceQuota, PriorityClass), 스케줄러의 노드 고르기(requests, nodeSelector, 어피니티, 테인트), 노드의 kubelet(limits, 프로브, restartPolicy)입니다. 막힌 길목에 따라 증상이 다릅니다. Pod를 직접 만들 때 승인에서 막히면 생성 자체가 `403 Forbidden`으로 거절되고 스케줄링에서 막히면 Pod가 `Pending`으로 남습니다.
2. Deployment의 롤아웃은 Pod 템플릿(`.spec.template`)이 바뀔 때만 일어납니다. 레플리카 수만 바꾸면 새 리비전이 생기지 않습니다. 기본 전략은 RollingUpdate이고 `maxUnavailable`과 `maxSurge`의 기본값은 각각 25%입니다.
3. ConfigMap을 환경 변수로 넣으면 값을 바꿔도 Pod를 재시작해야 반영됩니다. 볼륨으로 넣으면 kubelet 동기화 주기를 거쳐 결국 반영되지만 `subPath`로 마운트한 파일은 갱신되지 않습니다.
4. HPA는 컨테이너에 CPU request가 없으면 CPU 기준으로 아무것도 하지 못합니다. 사용률을 request 대비 백분율로 계산하기 때문입니다. 메트릭은 Metrics Server가 제공하는 `metrics.k8s.io`에서 옵니다.
5. 테인트는 노드가 Pod를 밀어내는 장치이고 톨러레이션은 그 밀어냄을 견디는 허가입니다. 톨러레이션이 있다고 그 노드로 가지는 않습니다. 특정 노드로 보내려면 nodeSelector나 노드 어피니티를 함께 씁니다.

시험 구조와 영역 비중은 [CKA Ch-00](/blog/cert/cka/cka-00-exam-and-study-plan)에, kubelet이 cgroup으로 limits를 집행하는 원리와 OOMKilled, CPU 스로틀링은 [CKA Ch-01](/blog/cert/cka/cka-01-why-kubernetes)에, 클러스터 설치와 static Pod로 도는 컨트롤 플레인은 [CKA Ch-02](/blog/cert/cka/cka-02-cluster-architecture)에 정리했습니다.

---

## 1. 롤링 업데이트와 롤백

커리큘럼 문구는 "Understand application deployments and how to perform rolling update and rollbacks"입니다.

### 1-1. Deployment, ReplicaSet, 리비전

Deployment는 ReplicaSet을 관리하고 ReplicaSet은 Pod 수를 맞춥니다. Pod 템플릿을 바꾸면 Deployment가 새 ReplicaSet을 만들고 새 쪽을 늘리면서 옛 쪽을 줄입니다. 옛 ReplicaSet은 레플리카 0인 채로 남아 있다가 롤백할 때 다시 늘어납니다. 이 옛 ReplicaSet 하나하나가 리비전입니다.

"Deployments" 문서에서 시험에 걸리는 사실을 모읍니다.

| 항목 | 문서 기준 |
|---|---|
| 롤아웃이 일어나는 조건 | Pod 템플릿(`.spec.template`)이 바뀔 때만. 레플리카 수 변경은 해당 없음 |
| 기본 전략 | `RollingUpdate`. 다른 값은 `Recreate`(옛 Pod를 모두 죽인 뒤 새 Pod 생성) |
| `maxUnavailable` | 기본 25%. 백분율을 절대 수로 바꿀 때 내림 |
| `maxSurge` | 기본 25%. 백분율을 절대 수로 바꿀 때 올림 |
| 두 값의 제약 | 둘 다 0일 수는 없음 |
| `revisionHistoryLimit` | 기본 10. 0으로 두면 롤백할 수 없음 |
| `progressDeadlineSeconds` | 기본 600. 이 시간 안에 진행이 없으면 진행 실패로 보고 |

레플리카 4개라면 25%는 1개입니다. 그래서 기본값에서는 롤아웃 중 사용 가능한 Pod가 3개 아래로 내려가지 않고 전체 Pod는 5개를 넘지 않습니다. 레플리카가 3개면 계산이 달라집니다. `maxUnavailable`은 0.75를 내려 0개, `maxSurge`는 0.75를 올려 1개라서 새 Pod 하나가 먼저 뜬 다음에야 옛 Pod가 줄어듭니다.

### 1-2. 시험에서 쓰는 명령

```bash
# 쇼핑몰 주문 API
kubectl create deployment order-api --image=nginx:1.27 --replicas=3 -n shop

# 이미지 교체로 롤아웃 시작 (컨테이너 이름=이미지)
kubectl set image deployment/order-api nginx=nginx:1.28 -n shop
kubectl annotate deployment/order-api -n shop kubernetes.io/change-cause="image 1.28"

kubectl rollout status deployment/order-api -n shop
kubectl rollout history deployment/order-api -n shop
kubectl rollout history deployment/order-api -n shop --revision=2

# 직전 리비전으로, 또는 특정 리비전으로
kubectl rollout undo deployment/order-api -n shop
kubectl rollout undo deployment/order-api -n shop --to-revision=1

# 여러 변경을 묶어서 한 번에 롤아웃
kubectl rollout pause deployment/order-api -n shop
kubectl rollout resume deployment/order-api -n shop

# 템플릿은 그대로 두고 Pod만 순서대로 새로 띄우기
kubectl rollout restart deployment/order-api -n shop
```

`kubectl create deployment`가 만드는 컨테이너 이름은 이미지 이름에서 옵니다. `nginx:1.27`이면 컨테이너 이름이 `nginx`라서 `set image`에 `nginx=`를 씁니다. 이름이 기억나지 않으면 `kubectl get deploy order-api -o jsonpath='{.spec.template.spec.containers[*].name}'`로 확인합니다.

`rollout history`의 `CHANGE-CAUSE` 열은 Deployment의 `kubernetes.io/change-cause` 어노테이션에서 복사됩니다. 어노테이션을 달지 않으면 빈칸입니다.

### 1-3. 헷갈리는 지점

- `rollout status`는 롤아웃이 끝나면 종료 코드 0을 돌려줍니다. 진행 기한을 넘기면 0이 아닌 코드로 끝납니다. 스크립트로 확인할 때 쓰는 성질입니다.
- 없는 이미지 태그로 바꾸면 롤아웃이 멈춥니다. 문서 설명대로 `maxUnavailable` 덕분에 옛 Pod가 전부 내려가지는 않으니 `rollout undo`로 되돌리면 됩니다.
- `kubectl scale`로 레플리카를 바꾸면 리비전이 늘지 않습니다. 1-1절 표의 첫 줄과 같은 이야기입니다.
- `kubectl set image`나 `kubectl edit`으로 바꾼 값은 손에 든 매니페스트 파일에 남지 않습니다. 나중에 옛 파일로 `kubectl apply`를 하면 옛 이미지로 롤아웃이 다시 일어나니 파일도 함께 고쳐 둡니다.

### 1-4. Pod에서 바꿀 수 있는 필드와 `kubectl edit` 우회

실행 중인 Pod의 spec은 거의 바꿀 수 없습니다. API 서버의 Pod 검증 코드(kubernetes/kubernetes `pkg/apis/core/validation/validation.go`의 `updatablePodSpecFields`)가 허용하는 변경은 이 목록뿐입니다.

| 바꿀 수 있는 필드 | 조건 |
|---|---|
| `spec.containers[*].image`, `spec.initContainers[*].image` | 없음 |
| `spec.activeDeadlineSeconds` | 비어 있던 값을 양수로 넣거나 기존 값보다 줄일 때 |
| `spec.tolerations` | 기존 항목에 더하는 것만 |
| `spec.terminationGracePeriodSeconds` | 음수였던 값을 1로 바꿀 때만 |
| `spec.schedulingGates` | 기존 게이트를 지우는 것만 |
| `spec.nodeSelector`, `spec.affinity.nodeAffinity` | Pod에 스케줄링 게이트가 남아 있는 동안만 |

라벨과 어노테이션 같은 메타데이터는 따로 바꿀 수 있고 CPU와 메모리는 3-3절의 `resize` 하위 리소스로 바꿉니다. 환경 변수, 볼륨, `command`, ServiceAccount 같은 나머지 필드를 고치면 API 서버가 "pod updates may not change fields other than ..."로 시작하는 메시지와 함께 거절합니다.

시험에서는 그래서 Pod를 지우고 다시 만드는 절차를 손에 익혀 둡니다. `kubectl edit`은 저장이 거절되면 수정본을 `/tmp/kubectl-edit-*.yaml`에 남기고 그 경로를 알려 줍니다.

```bash
kubectl edit pod board-web -n board
# 거절되면 안내된 임시 파일로 지우고 다시 만들기
kubectl replace --force -f /tmp/kubectl-edit-<번호>.yaml

# 처음부터 파일로 뽑아 고치는 방법
kubectl get pod board-web -n board -o yaml > board-web.yaml
kubectl replace --force -f board-web.yaml
```

`replace --force`는 기존 객체를 지운 뒤 새로 만듭니다. 그 사이에는 Pod가 없습니다. Deployment가 관리하는 Pod라면 Pod를 건드릴 일이 없습니다. `kubectl edit deployment`로 Pod 템플릿을 고치면 1-1절의 롤아웃이 일어나 새 Pod로 교체됩니다. Deployment가 만든 Pod를 직접 고쳐 다시 만들어도 그 Pod가 다음에 교체될 때 ReplicaSet이 템플릿 값으로 새로 만듭니다. 고친 값을 남기려면 템플릿을 고쳐야 합니다.

### 1-5. 직접 해 보기

`order-api`를 레플리카 4개로 만들고 `maxSurge: 1`, `maxUnavailable: 0`으로 바꿉니다. 존재하지 않는 태그로 `set image`를 실행해 롤아웃이 멈추는 모습을 `rollout status`와 `get rs`로 보고 `rollout undo`로 되돌린 뒤 `rollout history`의 리비전 번호가 어떻게 바뀌는지 적습니다.

## 2. ConfigMap과 Secret으로 애플리케이션 설정

커리큘럼 문구는 "Use ConfigMaps and Secrets to configure applications"입니다.

### 2-1. 넣는 방법 넷, 갱신 방식 둘

"ConfigMaps" 문서는 컨테이너가 ConfigMap을 쓰는 방법을 넷으로 나눕니다. 명령과 인자, 환경 변수, 읽기 전용 볼륨의 파일, 그리고 Pod 안 코드가 API로 직접 읽기입니다. 앞의 셋은 kubelet이 컨테이너를 띄울 때 ConfigMap 값을 씁니다.

| 넣는 방식 | 값을 바꾸면 |
|---|---|
| 환경 변수(`env`, `envFrom`) | 자동 반영 안 됨. Pod 재시작 필요 |
| 볼륨 파일 | 결국 반영됨. 지연은 kubelet 동기화 주기와 캐시 전파 지연을 더한 만큼 |
| `subPath`로 마운트한 볼륨 파일 | 반영 안 됨 |

Secret도 같습니다. 볼륨으로 넣은 Secret은 갱신이 결국 반영되고 `subPath` 마운트는 갱신을 받지 못한다고 "Secrets" 문서에 적혀 있습니다. 크기 제한은 ConfigMap 1MiB, Secret 1MiB입니다.

### 2-2. Secret의 기본 저장 방식과 보호 조치

"Secrets" 문서의 주의 문구를 그대로 옮기면, Secret은 기본적으로 API 서버의 저장소(etcd)에 암호화되지 않은 채 저장됩니다. `data` 필드의 base64는 인코딩일 뿐입니다. 문서가 권하는 최소 조치는 저장 시 암호화 켜기, Secret 접근을 최소 권한 RBAC으로 묶기, Secret을 필요한 컨테이너에만 노출하기, 외부 Secret 저장소 검토입니다. 네임스페이스에서 Pod를 만들 수 있는 사람은 그 네임스페이스의 Secret을 읽을 수 있다는 점도 문서에 있습니다. Pod에 Secret을 마운트하면 되기 때문입니다.

저장 시 암호화를 켜는 방법은 2-6절에 정리했습니다. 외부 저장소 쪽 선택지로는 Secrets Store CSI Driver가 있습니다. Vault나 클라우드 비밀 관리 서비스의 값을 CSI 볼륨으로 Pod에 파일로 넣는 방식이라 기본 설정에서는 쿠버네티스 Secret 객체를 만들지 않습니다(선택하면 Secret으로 동기화할 수도 있습니다). 외부 값이 바뀔 때 다시 가져오는 자동 순환은 드라이버 문서 기준 alpha 기능이고 `--enable-secret-rotation=true`를 줘야 켜집니다.

### 2-3. 시험에서 쓰는 명령

```bash
# 게시판 설정
kubectl create configmap board-config -n board \
  --from-literal=PAGE_SIZE=20 --from-literal=LOG_LEVEL=info

kubectl create secret generic board-db -n board \
  --from-literal=DB_USER=board --from-literal=DB_PASSWORD='change-me'

# 결제 서비스 TLS 인증서
kubectl create secret tls payment-tls -n payment --cert=tls.crt --key=tls.key

# Deployment에 환경 변수로 한꺼번에 주입
kubectl set env deployment/board-web -n board --from=configmap/board-config
kubectl set env deployment/board-web -n board --from=secret/board-db

# 값 확인
kubectl get secret board-db -n board -o jsonpath='{.data.DB_USER}' | base64 -d
```

볼륨으로 넣는 경우는 매니페스트가 필요합니다. Pod 뼈대를 `kubectl run board-web --image=nginx --dry-run=client -o yaml`로 받은 뒤 아래 두 블록을 붙입니다.

```yaml
spec:
  containers:
    - name: board-web
      image: nginx
      volumeMounts:
        - name: config
          mountPath: /etc/board
          readOnly: true
      env:
        - name: DB_PASSWORD
          valueFrom:
            secretKeyRef:
              name: board-db
              key: DB_PASSWORD
  volumes:
    - name: config
      configMap:
        name: board-config
```

### 2-4. 헷갈리는 지점

- `--from-file=<디렉터리>`는 디렉터리 안 일반 파일마다 키 하나를 만듭니다(하위 디렉터리와 심볼릭 링크는 무시). `--from-env-file`은 파일 안의 `VAR=VAL` 줄마다 키 하나를 만들고 따옴표를 따로 처리하지 않아 값에 그대로 들어갑니다.
- `immutable: true`로 표시한 ConfigMap은 표시를 되돌릴 수도, `data`를 바꿀 수도 없습니다. 지우고 다시 만든 뒤 기존 Pod도 다시 만들라고 문서는 권합니다.
- Secret YAML을 손으로 쓸 때 base64 인코딩이 귀찮으면 `stringData` 필드를 씁니다.

### 2-5. command와 args, 이미지의 ENTRYPOINT와 CMD

설정값을 넘기는 또 하나의 길이 컨테이너 실행 명령입니다. Pod API 레퍼런스는 `command`를 "Entrypoint array"로, `args`를 entrypoint에 넘기는 인자로 설명합니다. "Define a Command and Arguments for a Container" 문서도 `command`는 이미지의 ENTRYPOINT에, `args`는 CMD에 대응한다고 적습니다. 이름만 보면 `command`가 CMD와 짝일 것 같아서 자주 틀리는 자리입니다.

| Pod에 적은 것 | 실제로 실행되는 것 |
|---|---|
| 둘 다 없음 | 이미지의 ENTRYPOINT + CMD |
| `args`만 | 이미지의 ENTRYPOINT + `args` |
| `command`만 | `command`만. 이미지의 CMD도 버려짐 |
| 둘 다 | `command` + `args` |

`command`만 적었을 때 CMD까지 버려지는 동작은 containerd CRI 코드(`internal/cri/opts/spec_opts.go`의 `WithProcessArgs`)에서 확인했습니다. `command`가 비어 있을 때만 이미지의 ENTRYPOINT와 CMD를 채우고 `command`가 있으면 `args`만 뒤에 붙입니다.

```yaml
# 이미지가 ENTRYPOINT ["sleep"], CMD ["5"]일 때
containers:
  - name: sleeper
    image: <이미지>
    args: ["10"]                   # sleep 10
#   command: ["sleep", "3600"]     # 이렇게 쓰면 이미지의 ENTRYPOINT와 CMD를 모두 무시
```

`kubectl run`에서는 `--` 뒤의 값이 기본으로 `args`가 되고 `--command`를 붙이면 `command`가 됩니다. 두 필드 모두 Pod를 만든 뒤에는 바꿀 수 없으니(1-4절) 고치려면 Pod를 다시 만듭니다.

```bash
kubectl run sleeper --image=busybox --dry-run=client -o yaml -- sleep 3600            # args
kubectl run sleeper --image=busybox --dry-run=client -o yaml --command -- sleep 3600  # command
```

### 2-6. Secret 저장 시 암호화(EncryptionConfiguration)

2-2절에서 본 것처럼 Secret은 기본적으로 etcd에 평문으로 들어갑니다. 이를 바꾸는 설정이 kube-apiserver의 `--encryption-provider-config`와 그 파일 안의 `EncryptionConfiguration`입니다. "Encrypting Confidential Data at Rest" 문서의 공급자 표를 옮깁니다.

| 공급자 | 강도 | 키 길이 | 문서의 평가 |
|---|---|---|---|
| `identity` | 암호화 없음 | 없음 | 아무것도 지정하지 않을 때의 기본값 |
| `aescbc` | Weak | 16, 24, 32바이트 | CBC 패딩 오라클 공격 때문에 권하지 않음 |
| `aesgcm` | 200,000번 쓰기마다 키 교체 필요 | 16, 24, 32바이트 | 자동 키 교체가 없으면 권하지 않음 |
| `secretbox` | Strong | 32바이트 | 비교적 새 기술이라 엄격한 심사 환경에서는 받아들여지지 않을 수 있음 |
| `kms` v2 | Strongest | 32바이트 | 외부 KMS가 키를 쥠. v1.29부터 stable. `kms` v1은 v1.28부터 deprecated |

`aescbc`, `aesgcm`, `secretbox`는 키가 컨트롤 플레인 호스트의 파일에 있다는 한계를 문서가 함께 적습니다. 시험 문제와 문서 예제는 `aescbc`를 자주 쓰지만 운영에서 고를 때는 이 표를 봅니다.

순서 규칙이 핵심입니다. 목록의 첫 공급자가 쓰기에 쓰이고 읽을 때는 저장된 데이터에 맞는 공급자를 목록 순서대로 시도합니다. 그래서 `identity`를 맨 위에 두면 새로 쓰는 값도 평문으로 저장되고 암호화 공급자를 맨 위에 두고 `identity`를 뒤에 두면 아직 평문인 옛 데이터를 계속 읽을 수 있습니다.

```yaml
# /etc/kubernetes/enc/enc.yaml (문서 예제를 줄인 것)
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
  - resources:
      - secrets
    providers:
      - aescbc:
          keys:
            - name: key1
              secret: <head -c 32 /dev/urandom | base64 결과>
      - identity: {}      # 암호화 전에 저장된 평문 Secret을 읽기 위한 자리
```

kubeadm 클러스터에서는 파일을 컨트롤 플레인 노드에 두고 static Pod인 kube-apiserver 매니페스트에 플래그와 hostPath 마운트를 더합니다. 컨테이너 안에서 파일이 보여야 하기 때문입니다.

```yaml
# /etc/kubernetes/manifests/kube-apiserver.yaml 에 더하는 부분
spec:
  containers:
  - command:
    - kube-apiserver
    - --encryption-provider-config=/etc/kubernetes/enc/enc.yaml
    volumeMounts:
    - name: enc
      mountPath: /etc/kubernetes/enc
      readOnly: true
  volumes:
  - name: enc
    hostPath:
      path: /etc/kubernetes/enc
      type: DirectoryOrCreate
```

암호화는 쓸 때만 일어납니다. 설정 전에 저장된 Secret은 다음에 쓰일 때까지 평문으로 남으니 문서대로 모든 Secret을 한 번씩 다시 씁니다. 확인은 etcd에서 값을 직접 읽어 앞부분이 `k8s:enc:aescbc:v1:`로 시작하는지 봅니다.

```bash
kubectl get secrets --all-namespaces -o json | kubectl replace -f -

ETCDCTL_API=3 etcdctl \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  get /registry/secrets/board/board-db | hexdump -C | head
```

컨트롤 플레인 노드가 여럿이면 모든 노드의 설정 파일이 같아야 합니다. 다르면 어떤 API 서버는 다른 서버가 쓴 데이터를 복호화하지 못한다고 문서는 경고합니다.

### 2-7. 비공개 레지스트리와 imagePullSecrets

이미지 이름에 레지스트리 호스트를 적지 않으면 쿠버네티스는 Docker 공개 레지스트리로 간주합니다("Images" 문서). `nginx`는 Docker Hub의 공식 이미지를 가리킵니다. 쇼핑몰 팀의 비공개 레지스트리에서 이미지를 받으려면 호스트를 이미지 이름에 적고 kubelet이 쓸 자격 증명을 `docker-registry` 타입 Secret으로 만듭니다.

```bash
kubectl create secret docker-registry shop-registry -n shop \
  --docker-server=registry.shop.example \
  --docker-username=<사용자> --docker-password=<비밀번호>
```

```yaml
spec:
  containers:
    - name: order-api
      image: registry.shop.example/shop/order-api:1.0
  imagePullSecrets:          # containers와 같은 높이, Pod spec 바로 아래
    - name: shop-registry
```

문서 기준 조건은 둘입니다. `imagePullSecrets`의 Secret은 Pod와 같은 네임스페이스에 있어야 하고 타입은 `kubernetes.io/dockercfg`나 `kubernetes.io/dockerconfigjson`이어야 합니다. `kubectl create secret docker-registry`는 뒤쪽 타입을 만듭니다. 자격 증명이 틀리면 Pod가 `ErrImagePull`을 거쳐 `ImagePullBackOff`로 남고 `kubectl describe pod`의 Events에 인증 실패가 찍힙니다.

### 2-8. securityContext의 runAsUser와 capabilities

컨테이너 프로세스를 어떤 사용자와 커널 권한으로 돌릴지는 `securityContext`로 정합니다. 두 자리에 쓸 수 있습니다. Pod 수준(`spec.securityContext`)은 Pod 안 모든 컨테이너에 적용되고 컨테이너 수준(`spec.containers[*].securityContext`)은 그 컨테이너에만 적용됩니다. "Configure a Security Context for a Pod or Container" 문서는 두 곳에 같은 필드가 있으면 컨테이너 수준 값이 Pod 수준 값을 덮어쓴다고 적습니다.

```yaml
# 결제 API: Pod 전체는 UID 1000, 한 컨테이너만 UID 2000에 NET_ADMIN 추가
apiVersion: v1
kind: Pod
metadata:
  name: payment-api
  namespace: payment
spec:
  securityContext:
    runAsUser: 1000
  containers:
    - name: api
      image: busybox:1.36
      command: ["sleep", "3600"]
      securityContext:
        runAsUser: 2000            # Pod 수준 1000을 덮어씀
        capabilities:
          add: ["NET_ADMIN"]
    - name: metrics
      image: busybox:1.36
      command: ["sleep", "3600"]   # Pod 수준 값을 받아 UID 1000
```

`capabilities`는 컨테이너 수준 `securityContext`에만 있는 필드입니다. API 레퍼런스의 PodSecurityContext에는 `capabilities`가 없습니다. Pod 수준에 적으면 kubectl의 `--validate` 설정에 따라 unknown field 오류가 나거나 그 줄이 무시됩니다. 어느 쪽이든 권한은 더해지지 않습니다. `runAsUser`, `runAsGroup`, `runAsNonRoot`는 두 수준 모두에 있습니다. 확인은 `kubectl exec payment-api -c api -- id`로 UID를 보고 `kubectl exec payment-api -c api -- grep Cap /proc/1/status`로 권한 비트를 봅니다.

### 2-9. 직접 해 보기

`board-config`를 환경 변수와 볼륨 두 방식으로 같은 Pod에 넣습니다. `kubectl edit configmap`으로 `PAGE_SIZE`를 바꾼 뒤 1분 간격으로 `kubectl exec`해서 `env`와 `cat /etc/board/PAGE_SIZE`를 비교하고 어느 쪽이 언제 바뀌는지 기록합니다.

kubeadm 클러스터에서는 2-6절 순서대로 암호화를 켜 봅니다. 켜기 전에 만든 `board-db`와 켠 뒤에 만든 Secret을 `etcdctl get`으로 읽어 앞부분을 비교하고 `kubectl replace`로 다시 쓴 뒤 옛 Secret의 앞부분이 `k8s:enc:aescbc:v1:`로 바뀌는지 확인합니다. 설정 파일에서 `identity`를 맨 위로 옮기면 새 Secret이 어떻게 저장되는지도 봅니다.

## 3. 워크로드 자동 확장

커리큘럼 문구는 "Configure workload autoscaling"입니다. "Autoscaling Workloads" 문서는 수평 확장(Pod 수)과 수직 확장(Pod에 주는 자원)을 나눕니다.

### 3-1. HPA가 레플리카 수를 고르는 방식

HorizontalPodAutoscaler는 컨트롤 플레인의 컨트롤러가 주기적으로 계산합니다. 기본 주기는 15초입니다. 계산식은 문서에 이렇게 나옵니다.

```text
desiredReplicas = ceil[currentReplicas * ( currentMetricValue / desiredMetricValue )]
```

현재 레플리카 3개, 평균 CPU 사용률 90%, 목표 60%라면 3 × 1.5 = 4.5를 올려 5개가 됩니다. 비율이 1에 충분히 가까우면 움직이지 않는데 그 허용 범위(tolerance)의 기본값은 10%입니다. 축소는 기본 5분(300초) 안정화 구간을 거칩니다. 메트릭이 출렁일 때 레플리카 수가 오르내리는 것을 막기 위해서입니다.

사용률은 각 Pod의 컨테이너 request 대비 백분율로 계산합니다. 그래서 문서는 Pod의 일부 컨테이너에 해당 자원의 request가 없으면 그 Pod의 CPU 사용률이 정의되지 않고 오토스케일러는 그 메트릭으로 아무 동작도 하지 않는다고 적습니다. HPA의 `TARGETS`가 `<unknown>`으로 남으면 먼저 request와 Metrics Server를 봅니다.

### 3-2. 시험에서 쓰는 명령

```bash
kubectl top pods -n shop        # Metrics Server가 동작하는지 확인

kubectl autoscale deployment order-api -n shop --cpu=60% --min=2 --max=8
kubectl get hpa -n shop
kubectl describe hpa order-api -n shop
```

현재 `kubectl autoscale` 레퍼런스의 옵션은 `--cpu`와 `--memory`입니다. 값에 `%`를 붙이면 평균 사용률, `500m`처럼 양으로 주면 평균 값이 목표가 됩니다. 단위 없이 `500`만 쓰면 CPU는 `500m`, 메모리는 `500Mi`로 읽으니 사용률을 원하면 `%`를 꼭 붙입니다. 두 옵션은 1.34 변경 기록(CHANGELOG-1.34)에 추가됐고 같은 항목에서 `--cpu-percent`의 사용 중단이 시작됐습니다. 옛 강의와 "Deployments" 문서 예시에는 `--cpu-percent`가 남아 있습니다. kubectl 소스(`autoscale.go`)를 보면 이 옵션은 사용 중단(deprecated)으로 표시되어 도움말과 레퍼런스에서 숨겨졌을 뿐 아직 동작하고 경고를 냅니다. `--cpu`와 함께 쓰면 "mutually exclusive" 오류가 납니다.

축소 안정화 구간처럼 명령으로 줄 수 없는 값은 `autoscaling/v2` YAML로 씁니다.

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: order-api
  namespace: shop
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: order-api
  minReplicas: 2
  maxReplicas: 8
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 60
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
```

허용 범위도 HPA마다 정할 수 있습니다. "Horizontal Pod Autoscaling" 문서의 Tolerance 절은 `behavior.scaleUp.tolerance`, `behavior.scaleDown.tolerance` 필드를 소개하고 기능 게이트 `HPAConfigurableTolerance`는 1.37에서 stable이 됐습니다. 이 필드가 없으면 kube-controller-manager의 `--horizontal-pod-autoscaler-tolerance`(기본 0.1)가 쓰입니다.

```yaml
  behavior:
    scaleUp:
      tolerance: 0.05   # 목표보다 5% 넘게 높을 때만 확장
```

### 3-3. VPA

VerticalPodAutoscaler는 실제 사용량에 맞춰 requests와 limits를 조정합니다. "Vertical Pod Autoscaling" 문서에 따르면 VPA는 CRD로 정의되어 있어 HPA와 달리 클러스터에 따로 설치해야 하고 현재 안정 API 버전은 `autoscaling.k8s.io/v1`입니다. 시험 환경에 VPA가 설치되어 있는지는 확인하지 못했습니다. 저는 개념과 HPA와의 차이만 정리해 두었습니다.

| 항목 | HPA | VPA |
|---|---|---|
| 바꾸는 것 | 레플리카 수 | Pod의 requests와 limits |
| 위치 | 코어 API(`autoscaling/v2`) | CRD, 별도 설치(`autoscaling.k8s.io/v1`) |
| 대상 | Deployment, StatefulSet 같은 scale 하위 리소스가 있는 객체. DaemonSet은 대상이 아님 | Deployment, StatefulSet 같은 워크로드 리소스 |

VPA는 세 부품으로 돕니다. Recommender가 사용량 이력으로 권장값(Target, Lower bound, Upper bound)을 계산해 VPA 객체의 `.status`에 적고 Updater가 권장값과 많이 다른 Pod를 내보내거나 제자리에서 고칩니다. 새로 만들어지는 Pod에는 mutating 웹훅인 VPA admission controller가 권장값을 넣습니다. 적용 방식은 `updatePolicy.updateMode`로 고릅니다.

| updateMode | 동작 |
|---|---|
| `Off` | 권장값만 계산해 `.status`에 둠 |
| `Initial` | Pod가 새로 만들어질 때만 적용. 떠 있는 Pod는 그대로 |
| `Recreate` | 권장값과 다르면 Pod를 내보내고 새 Pod에 적용 |
| `InPlaceOrRecreate` | 제자리 resize를 먼저 시도하고 안 되면 내보냄 |
| `InPlace` | 제자리 resize만 시도. 내보내지 않음 |
| `Auto` | VPA 1.4.0부터 deprecated. 지금은 `Recreate`의 별칭 |

`kubectl describe vpa <이름>`으로 권장값을 봅니다. 옛 강의 자료에는 `Auto`가 기본 예시로 나오니 새로 쓸 때는 `Recreate`나 `InPlaceOrRecreate`를 적습니다.

수직 확장과 관련해 바뀐 점이 하나 있습니다. Pod를 다시 만들지 않고 실행 중인 컨테이너의 CPU와 메모리를 바꾸는 in-place resize(`InPlacePodVerticalScaling`)가 1.35에서 stable이 됐습니다. "Resize CPU and Memory Resources assigned to Containers" 문서의 방법은 Pod의 `resize` 하위 리소스에 패치하는 것이고 kubectl 1.32 이상이 필요합니다.

```bash
kubectl patch pod order-api-xxxx -n shop --subresource resize --patch \
  '{"spec":{"containers":[{"name":"nginx","resources":{"requests":{"cpu":"200m"},"limits":{"cpu":"200m"}}}]}}'
kubectl get pod order-api-xxxx -n shop -o jsonpath='{.status.containerStatuses[0].resources}'
```

컨테이너의 `resizePolicy`는 자원마다 `NotRequired`(기본, 재시작 없이 적용)와 `RestartContainer` 중 하나입니다. 노드가 바로 들어주지 못하면 Pod에 `PodResizePending` condition이, 적용 중이면 `PodResizeInProgress`가 붙습니다. 문서의 1.37 기준 제약은 이렇습니다. 바꿀 수 있는 자원은 CPU와 메모리뿐이고 Pod의 QoS 클래스(5-2절)가 바뀌는 변경은 거절됩니다. 예를 들어 Guaranteed Pod는 resize 뒤에도 request와 limit이 같아야 합니다. 일반 init 컨테이너는 바꿀 수 없고 사이드카는 바꿀 수 있습니다. 메모리 limit을 줄일 때 kubelet은 현재 사용량이 새 limit을 넘으면 resize를 건너뛰지만 확인 직후 사용량이 튀는 경우까지 막지는 못한다고 문서가 적습니다. Deployment가 관리하는 Pod를 이렇게 바꾸면 Pod 템플릿과 어긋나고 다음 롤아웃에서 템플릿 값으로 돌아간다는 점은 Deployment 동작에서 끌어낸 판단입니다.

### 3-4. 직접 해 보기

`order-api`에 `kubectl set resources deployment order-api -n shop --requests=cpu=100m`로 request를 준 뒤 HPA를 만듭니다. request를 주기 전과 후에 `kubectl get hpa`의 `TARGETS` 열이 어떻게 다른지 적고 "HorizontalPodAutoscaler Walkthrough" 문서의 부하 생성 Pod로 레플리카가 늘어나는 과정을 `--watch`로 봅니다.

## 4. 자가 치유를 만드는 기본 요소

커리큘럼 문구는 "Understand the primitives used to create robust, self-healing, application deployments"입니다. "Kubernetes Self-Healing" 문서는 자가 치유를 네 가지로 나눕니다.

| 무엇이 죽었을 때 | 누가 | 어떻게 |
|---|---|---|
| 컨테이너 | kubelet | `restartPolicy`에 따라 같은 노드에서 재시작 |
| Pod | Deployment(ReplicaSet), StatefulSet, DaemonSet 컨트롤러 | 대체 Pod를 만들어 레플리카 수를 맞춤. DaemonSet은 같은 노드에 다시 만듦 |
| PV가 붙은 Pod의 노드 | PersistentVolume 컨트롤러 | 볼륨을 다른 노드의 새 Pod에 다시 붙임 |
| Service 뒤의 Pod | 엔드포인트 관리 | 실패한 Pod를 Service 엔드포인트에서 뺌 |

문서가 붙인 한계도 있습니다. 쿠버네티스는 컨테이너를 재시작할 수 있지만 애플리케이션 자체의 문제는 따로 고쳐야 합니다.

### 4-1. restartPolicy와 CrashLoopBackOff

Pod의 `restartPolicy`는 `Always`(기본), `OnFailure`, `Never`입니다. Deployment에서는 `Always`만 허용되고 Job은 보통 `OnFailure`나 `Never`를 씁니다.

| 종료 코드 | Always | OnFailure | Never |
|---|---|---|---|
| 0(성공) | 재시작 | 재시작 안 함 | 재시작 안 함 |
| 0이 아님(실패) | 재시작 | 재시작 | 재시작 안 함 |

재시작 사이에는 지수 백오프가 붙습니다. "Pod Lifecycle" 문서 기준으로 10초, 20초, 40초처럼 늘고 300초(5분)에서 멈춥니다. 컨테이너가 10분 동안 문제없이 돌면 백오프가 초기화됩니다. `CrashLoopBackOff`는 이 백오프가 걸려 있다는 표시입니다. 원인을 보려면 `kubectl logs <pod> --previous`로 직전 컨테이너의 로그를 봅니다.

### 4-2. 프로브 셋

| 프로브 | 실패하면 | 쓰는 자리 |
|---|---|---|
| startupProbe | kubelet이 컨테이너를 죽이고 restartPolicy를 따름. 성공 전에는 나머지 두 프로브를 실행하지 않음 | 시작이 오래 걸리는 앱 |
| livenessProbe | 허용 횟수를 넘기면 컨테이너 재시작 | 교착처럼 살아는 있지만 진행하지 못하는 상태 |
| readinessProbe | 재시작은 안 함. Pod의 `Ready`가 false가 되고 EndpointSlice에서 Pod IP가 빠짐 | 트래픽을 받을 준비가 됐는지 |

"Liveness, Readiness, and Startup Probes" 문서의 기본값은 `periodSeconds` 10초, `timeoutSeconds` 1초, `failureThreshold` 3회, `initialDelaySeconds` 0초입니다. 그래서 기본값만 쓰면 liveness 프로브는 약 30초 동안 연속 실패해야 재시작합니다. startupProbe는 `failureThreshold × periodSeconds`만큼 시작 시간을 벌어 줍니다. 30 × 10이면 최대 300초입니다.

```yaml
# 결제 API: 시작에 최대 5분, 이후 /healthz로 생존, /ready로 준비 확인
containers:
  - name: payment-api
    image: <이미지>
    startupProbe:
      httpGet: { path: /healthz, port: 8080 }
      failureThreshold: 30
      periodSeconds: 10
    livenessProbe:
      httpGet: { path: /healthz, port: 8080 }
    readinessProbe:
      httpGet: { path: /ready, port: 8080 }
```

### 4-3. 헷갈리는 지점

- liveness 프로브는 readiness 프로브가 성공하기를 기다리지 않습니다. 시작이 느린 앱에 liveness만 걸면 뜨기도 전에 재시작이 반복됩니다. 이때 startupProbe나 `initialDelaySeconds`를 씁니다.
- readiness 실패는 재시작을 일으키지 않습니다. Pod가 `Running`인데 Service로 트래픽이 안 가면 `READY` 열과 EndpointSlice를 봅니다.

### 4-4. 네이티브 사이드카

로그 수집기나 프록시처럼 앱 컨테이너와 함께 계속 돌아야 하는 보조 컨테이너는 이제 `initContainers`에 `restartPolicy: Always`를 붙여 만듭니다. 기능 게이트 `SidecarContainers`는 1.29부터 기본으로 켜졌고 1.33에서 stable이 됐습니다. "Sidecar Containers" 문서가 적은 동작은 이렇습니다.

| 항목 | 동작 |
|---|---|
| 시작 순서 | init 컨테이너 목록 순서대로. 사이드카가 시작됨(`started`) 상태가 되어야 다음 init 컨테이너가 뜬다. startupProbe가 있으면 그 성공이 기준 |
| 실행 중 | Pod가 사는 동안 계속 돈다. 종료되면 다시 시작된다 |
| readinessProbe | 사이드카에 걸면 그 결과가 Pod의 Ready 판단에 들어간다 |
| 종료 순서 | 앱 컨테이너가 완전히 멈춘 뒤 사이드카를 정의 역순으로 종료 |
| 이미지 변경 | Pod를 다시 만들지 않고 그 컨테이너만 재시작 |

비교 대상인 일반 init 컨테이너(`restartPolicy`를 적지 않은 것)의 규칙도 "Init Containers" 문서로 정리해 둡니다. 목록 순서대로 하나씩 돌고 앞 컨테이너가 성공으로 끝나야 다음 것이 시작됩니다. 모두 끝나야 앱 컨테이너가 뜹니다. 실패하면 kubelet이 그 init 컨테이너를 성공할 때까지 다시 실행하고 Pod의 `restartPolicy`가 `Never`면 Pod 전체를 실패로 처리합니다. 주문 API가 DB 서비스 이름이 DNS에 잡힐 때까지 기다리는 예입니다.

```yaml
spec:
  initContainers:
    - name: wait-db
      image: busybox:1.36
      command: ["sh", "-c", "until nslookup order-db; do echo waiting; sleep 2; done"]
  containers:
    - name: order-api
      image: <이미지>
```

일반 init 컨테이너는 앱 컨테이너보다 먼저 끝나서 앱과 메시지를 주고받을 수 없고 사이드카는 앱과 동시에 돌며 네트워크와(선택하면) 볼륨을 공유합니다. 게시판 앱의 접근 로그 파일을 사이드카가 읽어 stdout으로 내보내는 예입니다.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: board
  namespace: board
spec:
  initContainers:
  - name: log-shipper
    image: busybox:1.36
    restartPolicy: Always          # 이 한 줄이 사이드카를 만든다
    command: ["sh", "-c", "tail -n+1 -F /var/log/board/access.log"]
    volumeMounts:
    - name: logs
      mountPath: /var/log/board
  containers:
  - name: app
    image: busybox:1.36
    command: ["sh", "-c", "while true; do echo \"$(date) GET /board\" >> /var/log/board/access.log; sleep 1; done"]
    volumeMounts:
    - name: logs
      mountPath: /var/log/board
  volumes:
  - name: logs
    emptyDir: {}
```

```bash
kubectl -n board logs board -c log-shipper
kubectl -n board get pod board -o jsonpath='{.status.initContainerStatuses[*].started}'
```

`kubectl get pod`의 READY 열은 앱 컨테이너와 사이드카를 함께 셉니다. 위 Pod가 정상이면 `2/2`로 보인다고 알고 있지만 이번에 문서 출력으로 확인하지는 않았습니다. 자원 계산에서는 사이드카가 앱 컨테이너 쪽 합계에 더해진다고 같은 문서의 "Resource sharing within containers" 절이 적습니다.

### 4-5. 직접 해 보기

게시판 Pod에 `exec` 방식 liveness 프로브(`cat /tmp/healthy`)를 걸고 30초 뒤 파일을 지우는 명령으로 띄웁니다. 문서 "Configure Liveness, Readiness and Startup Probes"의 첫 예제와 같은 구조입니다. `kubectl describe pod`의 Events에서 프로브 실패와 재시작이 언제 찍히는지, `RESTARTS` 값이 몇 초 간격으로 오르는지 적습니다.

## 5. Pod 승인과 스케줄링

커리큘럼 문구는 "Configure Pod admission and scheduling (limits, node affinity, etc.)"입니다. 이 항목은 결론 1번에서 말한 세 길목을 따라 읽으면 정리가 됩니다.

### 5-1. 승인 단계

승인 컨트롤러(admission controller)는 인증과 인가를 통과한 요청을 저장하기 전에 가로채는 API 서버 안의 코드입니다. 값을 고치는 mutating과 거절만 하는 validating이 있고 읽기 요청(get, list, watch)은 거치지 않습니다. "Admission Control in Kubernetes" 문서에 실린 v1.37 기본 활성 목록에는 이 영역과 관련된 `LimitRanger`, `ResourceQuota`, `Priority`, `DefaultTolerationSeconds`가 들어 있습니다. 활성 목록은 `kube-apiserver -h | grep enable-admission-plugins`로 볼 수 있고 kubeadm 클러스터에서는 `/etc/kubernetes/manifests/kube-apiserver.yaml`의 `--enable-admission-plugins`로 더하고 `--disable-admission-plugins`로 뺍니다.

```yaml
# kube-apiserver.yaml의 command 일부
    - --enable-admission-plugins=NodeRestriction,AlwaysPullImages
    - --disable-admission-plugins=DefaultStorageClass
```

static Pod 매니페스트라 저장하면 kubelet이 kube-apiserver를 다시 띄웁니다. 그동안 `kubectl`이 잠시 응답하지 않습니다. `--enable-admission-plugins`에 적은 이름은 기본 활성 목록에 더해지는 것이고 기본 목록을 대체하지 않습니다. 순서도 따로 신경 쓸 필요가 없다고 문서에 적혀 있습니다. 예로 든 `AlwaysPullImages`는 모든 Pod의 `imagePullPolicy`를 `Always`로 바꾸는 mutating 컨트롤러이고 다른 네임스페이스의 Pod가 노드에 이미 받아 둔 비공개 이미지를 자격 증명 없이 쓰는 일을 막습니다.

내장 컨트롤러로 표현하지 못하는 규칙은 웹훅으로 붙입니다. 기본 활성 목록에 들어 있는 `MutatingAdmissionWebhook`과 `ValidatingAdmissionWebhook`이 그 통로입니다. API 서버는 요청을 `MutatingWebhookConfiguration`에 등록된 웹훅 서버로 먼저 보내 값을 고치게 하고 스키마 검증을 거친 뒤 `ValidatingWebhookConfiguration`의 웹훅으로 보내 허용 여부를 묻습니다. "Dynamic Admission Control" 문서가 적은 순서입니다. 고친 결과를 마지막에 검사해야 하니 mutating이 먼저 돕니다. 게시판 네임스페이스의 Pod 생성을 검사하는 설정은 이런 모양입니다.

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingWebhookConfiguration      # 값을 고치려면 MutatingWebhookConfiguration
metadata:
  name: board-pod-policy
webhooks:
  - name: pod-policy.board.example
    rules:
      - operations: ["CREATE"]
        apiGroups: [""]
        apiVersions: ["v1"]
        resources: ["pods"]
        scope: "Namespaced"
    clientConfig:
      service:
        namespace: board
        name: pod-policy-webhook
        path: /validate
      caBundle: <웹훅 서버 인증서를 검증할 CA, base64>
    admissionReviewVersions: ["v1"]
    sideEffects: None
    timeoutSeconds: 5
    failurePolicy: Fail
```

두 Configuration 객체는 클러스터 범위입니다. API 서버는 HTTPS로만 웹훅을 부르므로 `caBundle`로 웹훅 서버 인증서를 검증합니다. `failurePolicy`는 웹훅 호출이 실패했을 때 요청을 거절할지(`Fail`) 통과시킬지(`Ignore`)를 정합니다. 웹훅 서버가 죽었는데 `Fail`이면 해당 리소스 생성이 전부 막히니 Pod가 안 만들어질 때 확인할 자리입니다.

### 5-2. requests와 limits

| 값 | 누가 쓰는지 | 넘으면 |
|---|---|---|
| requests | 스케줄러가 노드를 고를 때. 노드에 이미 배치된 컨테이너 requests 합이 노드 용량 안이어야 함 | 사용량이 request를 넘는 것은 허용 |
| limits | 노드의 kubelet과 커널 | CPU는 스로틀링, 메모리는 커널이 메모리 압박을 감지하면 OOM으로 종료 |

limit만 적고 request를 적지 않으면, 승인 단계에서 기본 request를 넣는 장치가 없는 한 쿠버네티스가 limit 값을 request로 복사합니다. 단위도 자주 틀립니다. CPU `0.1`은 `100m`과 같고 메모리 `400m`은 0.4바이트입니다. 400메비바이트는 `400Mi`입니다.

requests와 limits의 조합은 QoS 클래스를 정합니다. "Pod Quality of Service Classes" 문서 기준입니다.

| QoS | 조건 | 노드 자원이 모자랄 때 축출 순서 |
|---|---|---|
| Guaranteed | 모든 컨테이너에 CPU와 메모리 request와 limit이 있고 각각 같은 값 | 마지막 |
| Burstable | Guaranteed가 아니고 컨테이너 하나 이상에 CPU나 메모리 request 또는 limit이 있음 | BestEffort 다음 |
| BestEffort | 어느 컨테이너에도 CPU와 메모리 request, limit이 없음 | 먼저 |

```bash
kubectl set resources deployment order-api -n shop \
  --requests=cpu=100m,memory=128Mi --limits=cpu=500m,memory=256Mi
kubectl get pod <pod> -n shop -o jsonpath='{.status.qosClass}'
```

### 5-3. LimitRange

LimitRange는 네임스페이스 안 컨테이너나 Pod 하나하나의 최솟값, 최댓값, request 대비 limit 비율, 기본값을 정합니다. "Limit Ranges" 문서의 동작 순서는 이렇습니다.

1. 자원 요구를 적지 않은 Pod에 기본 request와 limit을 넣습니다.
2. 최솟값, 최댓값, 비율을 넘는지 검사합니다. 넘으면 `403 Forbidden`으로 거절합니다.
3. 검사는 승인 시점에만 합니다. LimitRange를 새로 만들거나 바꿔도 이미 떠 있는 Pod는 그대로입니다.

LimitRange는 `kubectl create` 하위 명령이 없어 YAML로 씁니다.

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: shop-defaults
  namespace: shop
spec:
  limits:
    - type: Container
      default:          # limit 기본값
        cpu: 500m
        memory: 256Mi
      defaultRequest:   # request 기본값
        cpu: 100m
        memory: 128Mi
      max:
        cpu: "1"
        memory: 512Mi
```

문서가 짚는 함정이 하나 있습니다. LimitRange는 자기가 넣는 기본값이 서로 맞는지 검사하지 않습니다. 기본 limit이 500m인데 Pod가 request 700m만 적고 limit을 적지 않으면 limit 500m이 들어가 request가 limit보다 커지고 Pod 생성이 실패합니다. 같은 네임스페이스에 LimitRange가 둘 이상이면 어느 기본값이 들어갈지 정해져 있지 않습니다.

### 5-4. ResourceQuota

ResourceQuota는 네임스페이스 전체의 합계를 묶습니다. LimitRange가 Pod 하나의 크기를 정한다면 ResourceQuota는 네임스페이스의 총량을 정합니다.

```bash
kubectl create quota shop-quota -n shop \
  --hard=requests.cpu=2,requests.memory=4Gi,limits.cpu=4,limits.memory=8Gi,pods=10
kubectl describe quota shop-quota -n shop     # Used와 Hard 비교
```

"Resource Quotas" 문서에서 시험에 걸리는 성질입니다.

- `cpu`나 `memory` 쿼터가 걸린 네임스페이스에서는 새 Pod마다 해당 자원의 request나 limit을 적어야 합니다. 적지 않으면 생성이 거절될 수 있습니다. 문서는 이 경우 LimitRange로 기본값을 채우는 방법을 함께 안내합니다.
- 쿼터를 넘는 생성이나 수정은 `403 Forbidden`으로 거절됩니다.
- Deployment가 쿼터를 넘는 Pod를 만들려 하면 Deployment 생성 자체는 성공합니다. Pod만 만들어지지 않으니 `kubectl describe`로 Deployment와 그 ReplicaSet의 상태를 봐야 원인이 보입니다.
- 객체 수는 `count/deployments.apps`, `count/pods`처럼 `count/<리소스>.<그룹>` 형식으로 묶습니다.

### 5-5. nodeSelector와 nodeName

```bash
kubectl label nodes node01 disktype=ssd
kubectl get nodes --show-labels
```

```yaml
spec:
  nodeSelector:
    disktype: ssd
```

nodeSelector는 적은 라벨을 모두 가진 노드에만 Pod를 놓습니다. `nodeName`은 더 직접적입니다. 값이 있으면 스케줄러가 그 Pod를 건너뛰고 지정한 노드의 kubelet이 바로 Pod를 띄웁니다. nodeSelector와 어피니티보다 우선하고 노드가 없거나 자원이 모자라면 실패합니다. 스케줄러를 건너뛸 뿐 승인 단계(5-1절)는 그대로 거칩니다. 자원이 모자라면 kubelet이 `OutOfcpu` 같은 이유로 거부해 Pod가 `Pending`에 머물지 않고 `Failed`가 됩니다.

스케줄러가 하는 일도 결국 이 칸을 채우는 것입니다. 기본 플러그인 `DefaultBinder`가 Pod의 `binding` 하위 리소스에 Binding 객체를 POST하면 API 서버가 `spec.nodeName`을 채웁니다. 스케줄러가 없거나 멈춘 클러스터에서 이미 `Pending`인 Pod를 노드에 놓는 방법은 둘입니다.

1. Pod를 지우고 `nodeName`을 넣어 다시 만듭니다. 이미 만든 Pod에 `nodeName`을 `kubectl edit`으로 넣는 변경은 1-4절 목록에 없어 거절됩니다. `kubectl replace --force -f`가 빠릅니다.
2. 스케줄러가 하는 일을 손으로 합니다. Binding 객체를 `binding` 하위 리소스에 보냅니다.

```json
{
  "apiVersion": "v1",
  "kind": "Binding",
  "metadata": { "name": "board-web" },
  "target": { "apiVersion": "v1", "kind": "Node", "name": "node02" }
}
```

```bash
# 위 내용을 binding.json으로 저장한 뒤 kubectl proxy를 거쳐 POST
kubectl proxy --port=8001 &
curl -X POST -H "Content-Type: application/json" --data-binary @binding.json \
  http://127.0.0.1:8001/api/v1/namespaces/board/pods/board-web/binding
```

`metadata.name`은 바인딩할 Pod 이름이고 `target`이 보낼 노드입니다. 성공하면 `kubectl get pod board-web -n board -o wide`의 NODE 열에 `node02`가 보입니다. 이미 노드가 정해진 Pod에 다시 보내면 거절됩니다.

### 5-6. 노드 어피니티

노드 어피니티는 nodeSelector를 더 풍부한 문법으로 쓰는 방법입니다.

| 종류 | 동작 |
|---|---|
| `requiredDuringSchedulingIgnoredDuringExecution` | 규칙을 만족하는 노드가 없으면 스케줄하지 않음 |
| `preferredDuringSchedulingIgnoredDuringExecution` | 만족하는 노드를 먼저 찾고 없으면 아무 데나. `weight`는 1~100 |

`IgnoredDuringExecution`은 스케줄된 뒤 노드 라벨이 바뀌어도 Pod가 계속 돈다는 뜻입니다. 연산자는 `In`, `NotIn`, `Exists`, `DoesNotExist`, `Gt`, `Lt`입니다.

```yaml
# 결제 Pod는 zone이 a 또는 b인 노드에만
spec:
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
          - matchExpressions:
              - key: topology.kubernetes.io/zone
                operator: In
                values: ["zone-a", "zone-b"]
```

문서의 결합 규칙은 꼭 외웁니다. `nodeSelectorTerms` 안의 여러 항목은 OR이고 한 항목의 `matchExpressions` 안 여러 식은 AND입니다. nodeSelector와 nodeAffinity를 함께 쓰면 둘 다 만족해야 합니다.

Pod 어피니티와 안티 어피니티는 노드 라벨 대신 이미 떠 있는 다른 Pod의 라벨을 기준으로 삼습니다. 범위는 `topologyKey`(예: `kubernetes.io/hostname`이면 노드 단위)로 정하고 모든 노드에 그 라벨이 있어야 의도대로 동작합니다.

### 5-7. 테인트와 톨러레이션

```bash
kubectl taint nodes node02 dedicated=payment:NoSchedule     # 추가
kubectl taint nodes node02 dedicated=payment:NoSchedule-    # 제거(끝의 -)
kubectl describe node node02 | grep -i taints
```

```yaml
spec:
  tolerations:
    - key: dedicated
      operator: Equal
      value: payment
      effect: NoSchedule
```

| effect | 새 Pod | 이미 돌던 Pod |
|---|---|---|
| `NoSchedule` | 맞는 톨러레이션이 없으면 배치 안 함 | 그대로 둠 |
| `PreferNoSchedule` | 가능하면 피함. 보장 안 됨 | 그대로 둠 |
| `NoExecute` | 배치 안 함 | 톨러레이션이 없으면 즉시 축출. `tolerationSeconds`가 있으면 그 시간 뒤 축출 |

`operator`의 기본값은 `Equal`입니다. `Exists`면 `value`를 적지 않습니다. `key`를 비우려면 `operator`가 `Exists`여야 하고 이때는 모든 키와 값에 맞습니다. 쿠버네티스는 `node.kubernetes.io/not-ready`와 `node.kubernetes.io/unreachable`에 대해 `tolerationSeconds=300`인 톨러레이션을 자동으로 붙입니다. 노드가 문제를 보이고 5분 뒤에 Pod가 옮겨지는 이유입니다.

결제 전용 노드를 만들 때는 두 장치를 함께 씁니다. 테인트로 다른 Pod를 막고 결제 Pod에는 톨러레이션과 함께 nodeSelector나 노드 어피니티를 넣어 그 노드로 보냅니다. 톨러레이션만 있으면 결제 Pod가 일반 노드에 놓일 수도 있습니다.

### 5-8. static Pod

static Pod는 API 서버를 거치지 않고 노드의 kubelet이 직접 관리하는 Pod입니다. kubeadm은 kube-apiserver, kube-controller-manager, kube-scheduler, etcd를 static Pod로 돌립니다.

- kubelet 설정의 `staticPodPath`가 가리키는 디렉터리를 주기적으로 훑습니다. kubeadm 클러스터에서는 `/etc/kubernetes/manifests`이고 경로는 노드의 kubelet 설정 파일(kubeadm 노드는 `/var/lib/kubelet/config.yaml`)에서 확인합니다.
- 점으로 시작하지 않는 모든 파일을 읽습니다. 확장자로 거르지 않으니 `kube-apiserver.yaml.backup` 같은 백업 파일을 같은 디렉터리에 두면 그것도 Pod로 만들려고 합니다. 백업은 디렉터리 밖에 둡니다.
- kubelet은 API 서버에 mirror Pod를 만들어 보이게 합니다. 이름 뒤에 `-<노드 이름>`이 붙습니다. `kubectl delete`로 mirror Pod를 지워도 static Pod는 남고 mirror Pod가 다시 생깁니다. 없애려면 매니페스트 파일을 지웁니다.
- static Pod의 spec은 ServiceAccount, ConfigMap, Secret 같은 다른 API 객체를 참조할 수 없습니다.

```bash
# node01에 게시판 점검용 static Pod
kubectl run board-check --image=busybox --restart=Never \
  --dry-run=client -o yaml -- sleep 3600 > board-check.yaml
ssh node01
sudo cp board-check.yaml /etc/kubernetes/manifests/
```

### 5-9. PriorityClass

PriorityClass는 네임스페이스가 없는 객체로, 이름에 정수 우선순위를 붙입니다. 사용자가 만드는 값은 10억(1000000000) 이하이고 그보다 큰 값은 `system-cluster-critical`(2000000000)과 `system-node-critical`(2000001000) 같은 시스템용입니다.

```bash
kubectl create priorityclass payment-high --value=100000 \
  --description="결제 API용"
kubectl create priorityclass batch-low --value=1000 \
  --description="배치, 선점하지 않음" --preemption-policy=Never
```

```yaml
spec:
  priorityClassName: payment-high
```

"Pod Priority and Preemption" 문서의 규칙입니다.

- Priority 승인 컨트롤러가 `priorityClassName`을 정수로 바꿉니다. 없는 이름을 적으면 Pod가 거절됩니다.
- `globalDefault: true`인 PriorityClass는 하나만 둘 수 있습니다. 없으면 `priorityClassName`이 없는 Pod의 우선순위는 0입니다.
- 스케줄러가 Pod를 놓을 노드를 못 찾으면 선점 로직이 돕니다. 우선순위가 낮은 Pod를 몇 개 내보내면 들어갈 수 있는 노드를 찾고 찾으면 그 Pod들을 축출합니다.
- `preemptionPolicy: Never`인 Pod는 대기열에서 낮은 우선순위 Pod보다 앞에 서지만 다른 Pod를 선점하지 않습니다. 기본값은 `PreemptLowerPriority`입니다.

### 5-10. DaemonSet

DaemonSet은 조건에 맞는 노드마다 Pod를 하나씩 띄우는 컨트롤러입니다. 노드가 클러스터에 들어오면 그 노드에 Pod가 생기고 노드가 빠지면 Pod도 정리됩니다. 로그 수집 에이전트, 노드 메트릭 수집기, CNI 플러그인, kubeadm의 kube-proxy가 이 방식으로 돕니다. 매니페스트는 Deployment와 거의 같고 `replicas`와 `strategy` 대신 `updateStrategy`(기본 `RollingUpdate`)를 씁니다. `kubectl create` 하위 명령이 없어 Deployment 뼈대를 받아 고칩니다.

```bash
kubectl create deployment log-agent -n kube-system --image=fluent/fluent-bit:3.0 \
  --dry-run=client -o yaml > log-agent.yaml
# kind를 DaemonSet으로 바꾸고 replicas, strategy, status 줄을 지운 뒤
kubectl apply -f log-agent.yaml
kubectl get ds -n kube-system
```

"DaemonSet" 문서가 설명하는 배치 방식이 시험에 걸립니다.

- DaemonSet 컨트롤러가 노드마다 Pod를 만들면서 `spec.affinity.nodeAffinity`에 `matchFields`(`metadata.name In <노드 이름>`)를 넣습니다. 그다음은 기본 스케줄러가 맡아 `nodeName`을 채웁니다. 자리가 없으면 스케줄러가 우선순위에 따라 다른 Pod를 선점할 수 있습니다.
- 컨트롤러가 톨러레이션을 자동으로 붙입니다. `node.kubernetes.io/not-ready`와 `unreachable`(NoExecute, 시간 제한 없음), `disk-pressure`, `memory-pressure`, `pid-pressure`, `unschedulable`(NoSchedule) 등입니다. 그래서 cordon한 노드에도 DaemonSet Pod는 뜹니다.
- 컨트롤 플레인 노드의 `node-role.kubernetes.io/control-plane:NoSchedule` 테인트는 자동 톨러레이션에 들어 있지 않습니다. 컨트롤 플레인 노드에도 띄우려면 Pod 템플릿에 직접 톨러레이션을 적습니다.
- 일부 노드에만 띄우려면 템플릿에 `nodeSelector`나 노드 어피니티를 적습니다. 컨트롤러는 이 조건으로 대상 노드를 고릅니다.

static Pod(5-8절)와 비교하면 차이가 분명합니다. static Pod는 kubelet이 로컬 파일을 보고 띄우고 API 서버에는 mirror Pod로만 보입니다. DaemonSet은 API 서버의 객체이고 컨트롤러와 스케줄러를 거칩니다.

### 5-11. 다중 스케줄러와 스케줄러 프로파일

Pod의 `spec.schedulerName`이 어느 스케줄러가 그 Pod를 맡을지 정합니다. 적지 않으면 API 서버가 `default-scheduler`를 넣습니다. 다른 이름을 적었는데 그 이름의 스케줄러가 없으면 Pod는 `Pending`에 남습니다.

스케줄러 동작은 `KubeSchedulerConfiguration` 파일로 바꿉니다. "Scheduler Configuration" 문서(v1 API, 1.25부터 stable)가 나열하는 확장 포인트는 스케줄링 순서와 같습니다.

```text
queueSort → preFilter → filter → postFilter(맞는 노드가 없을 때. 선점이 여기) → preScore → score
→ reserve → permit → preBind → bind → postBind
```

플러그인은 이 확장 포인트 하나 이상에 붙습니다. 몇 개만 보면 `PrioritySort`(queueSort), `NodeResourcesFit`, `NodeName`, `NodeUnschedulable`, `TaintToleration`(filter), `ImageLocality`(score, 이미지가 이미 있는 노드에 점수), `DefaultBinder`(bind)입니다. 문서에는 PodGroup 스케줄링용 확장 포인트도 있지만 기본 동작과는 따로입니다.

프로파일은 한 kube-scheduler 프로세스 안에 이름이 다른 스케줄러 설정을 여러 개 두는 방식입니다. Pod는 `schedulerName`으로 프로파일을 고릅니다. 프로세스를 따로 띄우지 않아 같은 노드 자원을 두 스케줄러가 동시에 계산하는 경합이 없습니다.

```yaml
apiVersion: kubescheduler.config.k8s.io/v1
kind: KubeSchedulerConfiguration
profiles:
  - schedulerName: default-scheduler
  - schedulerName: no-scoring-scheduler   # 점수 단계를 끈 프로파일
    plugins:
      preScore:
        disabled:
          - name: '*'
      score:
        disabled:
          - name: '*'
```

문서의 규칙은 셋입니다. 프로파일 이름은 서로 달라야 하고 `default-scheduler` 프로파일이 있어야 `schedulerName`을 적지 않은 Pod가 스케줄됩니다. 모든 프로파일은 queueSort에 같은 플러그인을 써야 합니다. 대기열이 하나이기 때문입니다.

별도 스케줄러를 하나 더 띄우는 방법도 "Configure Multiple Schedulers" 문서에 있습니다. 설정 파일을 ConfigMap으로 만들고 kube-scheduler 이미지를 `--config`로 그 파일을 읽게 해서 `kube-system`에 Deployment로 띄웁니다. 문서 예제는 ServiceAccount를 만들고 ClusterRole `system:kube-scheduler`를 묶습니다. 레플리카가 하나면 `leaderElection.leaderElect: false`로 둡니다.

```yaml
# ConfigMap my-scheduler-config의 데이터
apiVersion: kubescheduler.config.k8s.io/v1
kind: KubeSchedulerConfiguration
profiles:
  - schedulerName: my-scheduler
leaderElection:
  leaderElect: false
```

```yaml
# 이 스케줄러를 쓰는 Pod
spec:
  schedulerName: my-scheduler
```

어느 스케줄러가 배치했는지는 이벤트로 봅니다. 스케줄링 이벤트의 보고 주체가 Pod의 `schedulerName`입니다.

```bash
kubectl get events -n board -o wide | grep Scheduled     # SOURCE 열에 my-scheduler
kubectl logs -n kube-system deploy/my-scheduler          # Pending이면 권한, 설정 경로 오류 확인
```

### 5-12. 직접 해 보기

노드 두 대 클러스터에서 아래 순서로 해 봅니다.

1. `node02`에 `dedicated=payment:NoSchedule` 테인트를 걸고 톨러레이션 없는 Deployment 레플리카 4개가 모두 `node01`로 가는지 봅니다.
2. 결제 Deployment에 톨러레이션과 노드 어피니티를 넣어 `node02`에만 가는지 확인합니다.
3. `shop` 네임스페이스에 ResourceQuota(`pods=3`)를 걸고 레플리카 5개 Deployment를 만든 뒤, 무엇이 실패했고 어디에 이유가 찍히는지 찾습니다.
4. 컨트롤 플레인 노드에서 `/etc/kubernetes/manifests/kube-scheduler.yaml`을 디렉터리 밖으로 옮겨 스케줄러를 멈춥니다. 새 Pod가 `Pending`에 머무는 것을 본 뒤 5-5절의 Binding 요청으로 `node02`에 놓고 매니페스트를 되돌립니다.
5. 같은 상태에서 DaemonSet을 하나 만들어 Pod가 뜨는지 봅니다. 5-10절대로라면 DaemonSet Pod도 기본 스케줄러를 거치니 스케줄러가 멈춘 동안 어떻게 되는지가 확인할 지점입니다. `node02`를 `kubectl cordon`한 뒤 DaemonSet Pod가 그 노드에 남아 있는지도 봅니다.

## 6. 확인 문제

위 내용을 바탕으로 직접 만든 연습 과제입니다.

1. `shop` 네임스페이스의 Deployment `order-api` 이미지를 `nginx:1.28`로 바꾸고 롤아웃이 끝나면 바로 이전 리비전으로 되돌리세요.
2. Deployment `board-web`이 롤링 업데이트 중에도 사용 가능한 Pod 4개를 유지하도록 전략을 바꾸세요. 레플리카는 4개입니다.
3. ConfigMap `board-config`의 모든 키를 Deployment `board-web`의 환경 변수로 넣으세요.
4. Deployment `order-api`에 CPU 평균 사용률 70%를 목표로 최소 2, 최대 6개의 HPA를 만드세요. HPA의 TARGETS가 `<unknown>`이면 무엇을 확인할지도 적으세요.
5. 네임스페이스 `payment`에 컨테이너 기본 request `cpu=200m,memory=128Mi`, 기본 limit `cpu=400m,memory=256Mi`를 강제하세요.
6. `node02`에서 `app=payment` 라벨이 있는 Pod만 돌게 하세요. 다른 Pod는 `node02`에 새로 놓이지 않아야 합니다.
7. `node01`에 static Pod `board-check`(이미지 busybox, `sleep 3600`)를 만들고 mirror Pod 이름을 확인하세요.
8. 우선순위 50000인 PriorityClass `payment-high`를 만들고 Deployment `payment-api`에 적용하세요.
9. 이미지가 `ENTRYPOINT ["sleep"]`, `CMD ["5"]`일 때 Pod에 `command: ["sleep", "100"]`만 적으면 무엇이 실행되나요? `args: ["100"]`만 적으면요?
10. 클러스터의 Secret을 `aescbc`로 저장 시 암호화하도록 설정하고 기존 Secret까지 암호화하세요. `EncryptionConfiguration`의 공급자 순서는 어떻게 두어야 하나요?
11. Pod `payment-api`의 모든 컨테이너를 UID 1000으로 돌리고 그중 컨테이너 `api`에만 `NET_ADMIN` 권한을 더하세요.
12. 이름이 `my-scheduler`인 스케줄러가 클러스터에 떠 있습니다. Pod `board-check`를 이 스케줄러로 배치하고 실제로 이 스케줄러가 배치했는지 확인하세요.

<details>
<summary>풀이 보기</summary>

1. 컨테이너 이름을 먼저 확인합니다.
   ```bash
   kubectl get deploy order-api -n shop -o jsonpath='{.spec.template.spec.containers[*].name}'
   kubectl set image deployment/order-api -n shop <컨테이너>=nginx:1.28
   kubectl rollout status deployment/order-api -n shop
   kubectl rollout undo deployment/order-api -n shop
   kubectl rollout history deployment/order-api -n shop
   ```
2. `maxUnavailable: 0`이면 `maxSurge`는 0일 수 없습니다.
   ```bash
   kubectl patch deployment board-web -p \
     '{"spec":{"strategy":{"type":"RollingUpdate","rollingUpdate":{"maxUnavailable":0,"maxSurge":1}}}}'
   ```
3. `set env --from`으로 한 번에 넣습니다.
   ```bash
   kubectl set env deployment/board-web --from=configmap/board-config
   ```
4. request가 없으면 사용률을 계산할 수 없습니다.
   ```bash
   kubectl autoscale deployment order-api -n shop --cpu=70% --min=2 --max=6
   kubectl get hpa order-api -n shop
   ```
   `<unknown>`이면 컨테이너의 CPU request 유무(`kubectl get deploy order-api -n shop -o yaml | grep -A3 requests`)와 `kubectl top pods`가 동작하는지(Metrics Server)를 봅니다.
5. LimitRange를 YAML로 만듭니다.
   ```yaml
   apiVersion: v1
   kind: LimitRange
   metadata:
     name: payment-defaults
     namespace: payment
   spec:
     limits:
       - type: Container
         defaultRequest: { cpu: 200m, memory: 128Mi }
         default: { cpu: 400m, memory: 256Mi }
   ```
   이미 떠 있는 Pod에는 적용되지 않으니 필요하면 `kubectl rollout restart`로 다시 띄웁니다.
6. 테인트로 다른 Pod를 막고 결제 Pod는 톨러레이션과 nodeSelector로 보냅니다.
   ```bash
   kubectl taint nodes node02 app=payment:NoSchedule
   kubectl label nodes node02 app=payment
   ```
   ```yaml
   spec:
     template:
       spec:
         nodeSelector: { app: payment }
         tolerations:
           - { key: app, operator: Equal, value: payment, effect: NoSchedule }
   ```
   이미 `node02`에 있던 다른 Pod까지 내보내야 하면 `NoExecute`를 씁니다.
7. 매니페스트를 만들어 node01의 static Pod 디렉터리에 넣습니다.
   ```bash
   kubectl run board-check --image=busybox --restart=Never --dry-run=client -o yaml -- sleep 3600 > board-check.yaml
   scp board-check.yaml node01:/tmp/    # 또는 node01에서 직접 작성
   ssh node01
   grep staticPodPath /var/lib/kubelet/config.yaml
   sudo mv /tmp/board-check.yaml /etc/kubernetes/manifests/
   exit
   kubectl get pods -o wide | grep board-check     # board-check-node01
   ```
   시험 환경에서 `scp`가 되는지는 확인하지 못했습니다. 안 되면 node01에서 `vi`로 직접 씁니다.
8. PriorityClass를 만들고 Pod 템플릿에 이름을 넣습니다.
   ```bash
   kubectl create priorityclass payment-high --value=50000
   kubectl patch deployment payment-api -p \
     '{"spec":{"template":{"spec":{"priorityClassName":"payment-high"}}}}'
   kubectl get pods -l app=payment-api -o jsonpath='{.items[*].spec.priority}'
   ```
9. `command`는 ENTRYPOINT 자리를, `args`는 CMD 자리를 채웁니다. `command`만 적으면 이미지의 CMD도 버려져 `sleep 100`이 실행됩니다. `args: ["100"]`만 적으면 이미지의 ENTRYPOINT에 붙어 역시 `sleep 100`입니다. 차이는 `command: ["sleep"]`만 적었을 때 드러납니다. CMD의 `5`가 붙지 않아 인자 없는 `sleep`이 실행되고 바로 오류로 끝납니다.
10. 2-6절 순서대로 합니다. 키를 만들고(`head -c 32 /dev/urandom | base64`) 설정 파일을 `/etc/kubernetes/enc/enc.yaml`에 둔 뒤 kube-apiserver 매니페스트에 `--encryption-provider-config`와 hostPath 마운트를 더합니다. 공급자는 `aescbc`를 맨 위에, `identity: {}`를 그 아래에 둡니다. 첫 공급자로 쓰고 `identity`로 옛 평문을 읽기 위해서입니다. API 서버가 다시 뜨면 기존 Secret을 다시 씁니다.
    ```bash
    kubectl get secrets --all-namespaces -o json | kubectl replace -f -
    ```
11. `runAsUser`는 Pod 수준에, `capabilities`는 컨테이너 수준에만 둘 수 있습니다.
    ```yaml
    spec:
      securityContext:
        runAsUser: 1000
      containers:
        - name: api
          image: <이미지>
          securityContext:
            capabilities:
              add: ["NET_ADMIN"]
    ```
    이미 떠 있는 Pod라면 1-4절 목록에 없는 변경이니 `kubectl replace --force -f`로 다시 만듭니다.
12. `schedulerName`도 만든 뒤 바꿀 수 없으니 새로 만듭니다.
    ```bash
    kubectl run board-check --image=busybox --dry-run=client -o yaml -- sleep 3600 > bc.yaml
    # spec 아래에 schedulerName: my-scheduler 추가
    kubectl apply -f bc.yaml
    kubectl get events -o wide | grep board-check     # Scheduled 이벤트의 SOURCE가 my-scheduler
    ```

</details>

## 범위와 한계

- 이 글의 명령과 YAML은 공식 문서에서 옮기거나 문서 예시를 바탕으로 고친 것이고 아직 직접 실행하지 않았습니다. 출력 예시는 문서에 실린 모양만 옮겼습니다. 클러스터를 만든 뒤 1-5, 2-9, 3-4, 4-5, 5-12절의 결과를 덧붙이겠습니다.
- `command`만 적었을 때 이미지 CMD가 버려지는 동작은 containerd CRI 소스(main 브랜치)로 확인했습니다. CRI-O 같은 다른 런타임 코드는 보지 않았습니다.
- 수정 가능한 Pod 필드 목록은 kubernetes/kubernetes master 브랜치의 `validation.go`에서 옮겼습니다. 스케줄링 게이트 관련 항목은 버전에 따라 달라질 수 있습니다.
- VPA의 updateMode 목록은 kubernetes.io의 "Vertical Pod Autoscaling" 문서 기준이고 설치하는 VPA 버전에 따라 `InPlace` 계열 모드가 없을 수 있습니다. Secrets Store CSI Driver의 자동 순환 상태는 드라이버 문서 기준입니다.
- 공식 문서는 2026년 10월 19일 기준 kubernetes.io(v1.37)에서 확인했습니다.
- 시험 환경에 Metrics Server와 VPA가 설치되어 있는지, 노드 사이 `scp`가 되는지는 확인하지 못했습니다.
- `kubectl autoscale --cpu-percent`의 동작은 kubernetes/kubernetes 저장소 master 브랜치의 `autoscale.go`로 확인했고 v1.37 kubectl 바이너리로 실행해 보지는 않았습니다.
- 확인 문제는 제가 만든 것이고 실제 시험 문항과 관계없습니다. 풀이도 클러스터에서 돌려 보지 않았습니다.

## 참고 자료

공식 문서
- CNCF, [CKA Curriculum v1.37](https://github.com/cncf/curriculum/blob/master/CKA_Curriculum_v1.37.pdf)
- Kubernetes, [Deployments](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/), [kubectl Quick Reference](https://kubernetes.io/docs/reference/kubectl/quick-reference/)
- Kubernetes, [ConfigMaps](https://kubernetes.io/docs/concepts/configuration/configmap/), [Secrets](https://kubernetes.io/docs/concepts/configuration/secret/)
- Kubernetes, [Autoscaling Workloads](https://kubernetes.io/docs/concepts/workloads/autoscaling/), [Horizontal Pod Autoscaling](https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/), [HorizontalPodAutoscaler Walkthrough](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale-walkthrough/), [Vertical Pod Autoscaling](https://kubernetes.io/docs/concepts/workloads/autoscaling/vertical-pod-autoscale/), [kubectl autoscale](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_autoscale/)
- Kubernetes, [Sidecar Containers](https://kubernetes.io/docs/concepts/workloads/pods/sidecar-containers/), [Resize CPU and Memory Resources assigned to Containers](https://kubernetes.io/docs/tasks/configure-pod-container/resize-container-resources/), [Feature Gates](https://kubernetes.io/docs/reference/command-line-tools-reference/feature-gates/)
- kubernetes/kubernetes, [CHANGELOG-1.34](https://github.com/kubernetes/kubernetes/blob/master/CHANGELOG/CHANGELOG-1.34.md), [staging/src/k8s.io/kubectl/pkg/cmd/autoscale/autoscale.go](https://github.com/kubernetes/kubernetes/blob/master/staging/src/k8s.io/kubectl/pkg/cmd/autoscale/autoscale.go)
- Kubernetes, [Kubernetes Self-Healing](https://kubernetes.io/docs/concepts/architecture/self-healing/), [Pod Lifecycle](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/), [Liveness, Readiness, and Startup Probes](https://kubernetes.io/docs/concepts/workloads/pods/probes/), [Configure Liveness, Readiness and Startup Probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/), [Configure a Pod to Use a ConfigMap](https://kubernetes.io/docs/tasks/configure-pod-container/configure-pod-configmap/)
- Kubernetes, [Admission Control in Kubernetes](https://kubernetes.io/docs/reference/access-authn-authz/admission-controllers/), [Resource Management for Pods and Containers](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/), [Pod Quality of Service Classes](https://kubernetes.io/docs/concepts/workloads/pods/pod-qos/)
- Kubernetes, [Limit Ranges](https://kubernetes.io/docs/concepts/policy/limit-range/), [Resource Quotas](https://kubernetes.io/docs/concepts/policy/resource-quotas/)
- Kubernetes, [Assigning Pods to Nodes](https://kubernetes.io/docs/concepts/scheduling-eviction/assign-pod-node/), [Taints and Tolerations](https://kubernetes.io/docs/concepts/scheduling-eviction/taint-and-toleration/)
- Kubernetes, [Static Pods](https://kubernetes.io/docs/concepts/workloads/pods/static-pods/), [Create static Pods](https://kubernetes.io/docs/tasks/configure-pod-container/static-pod/)
- Kubernetes, [Pod Priority and Preemption](https://kubernetes.io/docs/concepts/scheduling-eviction/pod-priority-preemption/)
- Kubernetes, [DaemonSet](https://kubernetes.io/docs/concepts/workloads/controllers/daemonset/), [Scheduler Configuration](https://kubernetes.io/docs/reference/scheduling/config/), [Scheduling Framework](https://kubernetes.io/docs/concepts/scheduling-eviction/scheduling-framework/), [Configure Multiple Schedulers](https://kubernetes.io/docs/tasks/extend-kubernetes/configure-multiple-schedulers/)
- Kubernetes, [Dynamic Admission Control](https://kubernetes.io/docs/reference/access-authn-authz/extensible-admission-controllers/), [Encrypting Confidential Data at Rest](https://kubernetes.io/docs/tasks/administer-cluster/encrypt-data/), [Init Containers](https://kubernetes.io/docs/concepts/workloads/pods/init-containers/)
- Kubernetes, [Define a Command and Arguments for a Container](https://kubernetes.io/docs/tasks/inject-data-application/define-command-argument-container/), [Pod API reference](https://kubernetes.io/docs/reference/kubernetes-api/workload-resources/pod-v1/), [Images](https://kubernetes.io/docs/concepts/containers/images/), [Configure a Security Context for a Pod or Container](https://kubernetes.io/docs/tasks/configure-pod-container/security-context/)
- kubernetes/kubernetes, [pkg/apis/core/validation/validation.go](https://github.com/kubernetes/kubernetes/blob/master/pkg/apis/core/validation/validation.go); containerd, [internal/cri/opts/spec_opts.go](https://github.com/containerd/containerd/blob/main/internal/cri/opts/spec_opts.go)
- Secrets Store CSI Driver, [Secret Auto Rotation](https://secrets-store-csi-driver.sigs.k8s.io/topics/secret-auto-rotation.html)

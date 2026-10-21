---
title: '[CKA Ch-03] 워크로드와 스케줄링: Pod가 어디에 얼마만큼 뜨는지 정하는 값들'
description: CKA 비중 15%인 워크로드와 스케줄링 영역을 v1.37 커리큘럼 순서대로 시험에 쓰는 명령과 YAML 중심으로 정리합니다. 롤아웃과 롤백, ConfigMap과 Secret, HPA와 VPA, in-place resize, 프로브와 사이드카, StatefulSet, Job, PDB, requests와 limits, LimitRange, ResourceQuota, 어피니티, 테인트, static Pod, PriorityClass, DaemonSet을 다룹니다.
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

1. 이 영역의 값은 세 길목에서 작동합니다. 승인 단계(LimitRange, ResourceQuota, PriorityClass)에서 막히면 생성이 `403 Forbidden`으로 거절되고 스케줄러(requests, nodeSelector, 어피니티, 테인트)에서 막히면 `Pending`으로 남습니다. limits, 프로브, restartPolicy는 노드의 kubelet이 집행합니다.
2. Deployment의 롤아웃은 Pod 템플릿(`.spec.template`)이 바뀔 때만 일어납니다. 레플리카 수만 바꾸면 새 리비전이 생기지 않습니다. 기본 전략은 RollingUpdate이고 `maxUnavailable`과 `maxSurge`의 기본값은 각각 25%입니다.
3. ConfigMap을 환경 변수로 넣으면 Pod를 다시 만들어야 반영되고 볼륨으로 넣으면 결국 반영됩니다. `subPath` 마운트는 갱신되지 않습니다.
4. HPA는 CPU request가 없으면 CPU 사용률을 계산하지 못합니다. 1.34부터 `kubectl autoscale`의 옵션은 `--cpu=60%` 형식입니다.
5. 테인트는 노드가 Pod를 밀어내는 장치이고 톨러레이션은 그 밀어냄을 견디는 허가입니다. 톨러레이션만으로는 그 노드로 가지 않습니다. 특정 노드로 보내려면 nodeSelector나 노드 어피니티를 함께 씁니다.

시험 구조는 [CKA Ch-00](/blog/cert/cka/cka-00-exam-and-study-plan)에 정리했습니다. 옛 커리큘럼의 이 영역에 있던 매니페스트 관리 도구와 템플릿 항목은 v1.37 문구에 없고 아키텍처 영역의 "Use Helm and Kustomize to install cluster components"가 그 자리를 맡아 [CKA Ch-02](/blog/cert/cka/cka-02-cluster-architecture) 6장에서 다룹니다.

---

## 1. 롤링 업데이트와 롤백

커리큘럼 문구는 "Understand application deployments and how to perform rolling update and rollbacks"입니다.

### 1-1. Deployment, ReplicaSet, 리비전

Deployment는 ReplicaSet을 관리하고 ReplicaSet은 Pod 수를 맞춥니다. Pod 템플릿을 바꾸면 Deployment가 새 ReplicaSet을 만들고 새 쪽을 늘리면서 옛 쪽을 줄입니다. 옛 ReplicaSet은 레플리카 0인 채로 남아 있다가 롤백할 때 다시 늘어납니다. 이 옛 ReplicaSet 하나하나가 리비전입니다.

| 항목 | "Deployments" 문서 기준 |
|---|---|
| 롤아웃이 일어나는 조건 | Pod 템플릿(`.spec.template`)이 바뀔 때만. 레플리카 수 변경은 해당 없음 |
| 기본 전략 | `RollingUpdate`. 다른 값은 `Recreate`(옛 Pod를 모두 죽인 뒤 새 Pod 생성) |
| `maxUnavailable` | 기본 25%. 백분율을 절대 수로 바꿀 때 내림 |
| `maxSurge` | 기본 25%. 백분율을 절대 수로 바꿀 때 올림 |
| 두 값의 제약 | 둘 다 0일 수는 없음 |
| `revisionHistoryLimit` | 기본 10. 0으로 두면 롤백할 수 없음 |
| `progressDeadlineSeconds` | 기본 600. 이 시간 안에 진행이 없으면 진행 실패로 보고 |

레플리카 4개라면 25%는 1개입니다. 기본값에서는 롤아웃 중 사용 가능한 Pod가 3개 아래로 내려가지 않고 전체 Pod는 5개를 넘지 않습니다. 레플리카가 3개면 `maxUnavailable`은 0.75를 내려 0개, `maxSurge`는 0.75를 올려 1개입니다. 새 Pod 하나가 먼저 뜬 다음에야 옛 Pod가 줄어듭니다.

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

`rollout history`의 `CHANGE-CAUSE` 열은 Deployment의 `kubernetes.io/change-cause` 어노테이션에서 복사됩니다. 어노테이션을 달지 않으면 `<none>`으로 찍힙니다. 어노테이션은 Deployment에 남아 있어서 다음 롤아웃 때 바꾸지 않으면 새 리비전에도 같은 문구가 붙습니다. 롤아웃마다 새로 답니다.

### 1-3. 헷갈리는 지점

- `rollout status`는 롤아웃이 끝나면 종료 코드 0을 돌려줍니다. `--timeout`이나 진행 기한을 넘기면 `error: timed out waiting for the condition`과 함께 0이 아닌 코드로 끝납니다.
- 없는 이미지 태그로 바꾸면 롤아웃이 멈춥니다. `maxUnavailable` 덕분에 옛 Pod가 전부 내려가지는 않으니 `rollout undo`로 되돌립니다.
- 롤백하면 되돌아간 리비전 번호는 빠지고 같은 템플릿이 새 번호로 붙습니다. `1, 2, 3`에서 `undo`로 2에 돌아가면 `1, 3, 4`입니다.
- `kubectl set image`나 `kubectl edit`으로 바꾼 값은 손에 든 매니페스트 파일에 남지 않습니다. 나중에 옛 파일로 `kubectl apply`를 하면 옛 이미지로 롤아웃이 다시 일어나니 파일도 함께 고쳐 둡니다.

### 1-4. Pod에서 바꿀 수 있는 필드와 `kubectl edit` 우회

실행 중인 Pod의 spec은 거의 바꿀 수 없습니다. API 서버의 Pod 검증 규칙이 허용하는 변경은 이 목록뿐입니다.

| 바꿀 수 있는 필드 | 조건 |
|---|---|
| `spec.containers[*].image`, `spec.initContainers[*].image` | 없음 |
| `spec.activeDeadlineSeconds` | 비어 있던 값을 양수로 넣거나 기존 값보다 줄일 때 |
| `spec.tolerations` | 기존 항목에 더하는 것만 |
| `spec.terminationGracePeriodSeconds` | 음수였던 값을 1로 바꿀 때만 |
| `spec.schedulingGates` | 기존 게이트를 지우는 것만 |
| `spec.nodeSelector`, `spec.affinity.nodeAffinity` | Pod에 스케줄링 게이트가 남아 있는 동안만 |

라벨과 어노테이션은 따로 바꿀 수 있고 CPU와 메모리는 3-3절의 `resize` 하위 리소스로 바꿉니다. 환경 변수, 볼륨, `command`, ServiceAccount 같은 나머지 필드를 고치면 "pod updates may not change fields other than ..."로 시작하는 메시지와 함께 거절됩니다.

그래서 Pod를 지우고 다시 만드는 절차를 손에 익혀 둡니다. `kubectl edit`은 저장이 거절되면 `A copy of your changes has been stored to "/tmp/kubectl-edit-....yaml"`로 수정본 경로를 알려 줍니다.

```bash
kubectl edit pod board-web -n board
# 거절되면 안내된 임시 파일로 지우고 다시 만들기
kubectl replace --force -f /tmp/kubectl-edit-<번호>.yaml
# 또는 kubectl get pod ... -o yaml > f.yaml 로 뽑아 고친 뒤 replace --force
```

Deployment가 관리하는 Pod는 템플릿을 고칩니다. Pod만 고쳐 다시 만들면 다음 교체 때 ReplicaSet이 템플릿 값으로 되돌립니다.

### 1-5. 직접 해 보기

`order-api`를 레플리카 4개로 만들고 `maxSurge: 1`, `maxUnavailable: 0`으로 바꿉니다. 없는 태그로 `set image`를 실행한 뒤 확인합니다.

- `kubectl rollout status ... --timeout=40s`가 `error: timed out waiting for the condition`으로 끝나고 `echo $?`가 1인지
- `kubectl get rs`에서 옛 ReplicaSet은 4개 Ready 그대로, 새 ReplicaSet은 1개가 `ErrImagePull`인지
- `rollout undo` 뒤 `rollout history`의 번호가 1-3절대로 바뀌는지

## 2. ConfigMap과 Secret으로 애플리케이션 설정

커리큘럼 문구는 "Use ConfigMaps and Secrets to configure applications"입니다.

### 2-1. 넣는 방법 넷, 갱신 방식 둘

"ConfigMaps" 문서가 꼽는 사용법은 명령과 인자, 환경 변수, 볼륨 파일, API로 직접 읽기 넷입니다.

| 넣는 방식 | 값을 바꾸면 |
|---|---|
| 환경 변수(`env`, `envFrom`) | 자동 반영 안 됨. Pod를 다시 만들어야 함 |
| 볼륨 파일 | 결국 반영됨. 지연은 kubelet 동기화 주기와 캐시 전파 지연을 더한 만큼 |
| `subPath`로 마운트한 볼륨 파일 | 반영 안 됨 |

Secret도 같습니다. 크기 제한은 ConfigMap과 Secret 모두 1MiB입니다.

### 2-2. Secret의 기본 저장 방식과 보호 조치

Secret은 기본적으로 etcd에 암호화되지 않은 채 저장되고 `data` 필드의 base64는 인코딩일 뿐입니다. "Secrets" 문서가 권하는 조치는 저장 시 암호화(2-6절), 최소 권한 RBAC, 필요한 컨테이너에만 노출하기입니다. 네임스페이스에서 Pod를 만들 수 있는 사람은 Secret을 마운트해 읽을 수 있다는 점도 문서에 있습니다.

### 2-3. 시험에서 쓰는 명령

```bash
# 게시판 설정
kubectl create configmap board-config -n board \
  --from-literal=PAGE_SIZE=20 --from-literal=LOG_LEVEL=info

kubectl create secret generic board-db -n board \
  --from-literal=DB_USER=board --from-literal=DB_PASSWORD='change-me'

kubectl create secret tls payment-tls -n payment --cert=tls.crt --key=tls.key

# Deployment에 환경 변수로 한꺼번에 주입
kubectl set env deployment/board-web -n board --from=configmap/board-config
kubectl set env deployment/board-web -n board --from=secret/board-db

# 값 확인
kubectl get secret board-db -n board -o jsonpath='{.data.DB_USER}' | base64 -d
```

`set env --from`은 키마다 `env` 항목을 하나씩 만들어 `valueFrom.configMapKeyRef`로 가리킵니다. 그래서 나중에 ConfigMap에 더한 키는 들어가지 않고 새 키까지 받으려면 YAML에 `envFrom`을 적습니다. 세 주입 방식을 모은 뼈대입니다.

```yaml
spec:
  containers:
    - name: board-web
      image: nginx
      envFrom:                      # 모든 키를 환경 변수로
        - configMapRef:
            name: board-config
      env:                          # 키 하나만 골라서
        - name: DB_PASSWORD
          valueFrom:
            secretKeyRef:
              name: board-db
              key: DB_PASSWORD
      volumeMounts:                 # 키마다 파일 하나
        - name: config
          mountPath: /etc/board
          readOnly: true
  volumes:
    - name: config
      configMap:
        name: board-config          # Secret이면 secret: { secretName: board-db }
```

### 2-4. 헷갈리는 지점

- `--from-file=<디렉터리>`는 일반 파일마다, `--from-env-file`은 `VAR=VAL` 줄마다 키 하나를 만듭니다. `--from-env-file`은 따옴표를 값에 그대로 넣습니다.
- `immutable: true`로 표시한 ConfigMap은 표시를 되돌릴 수도, `data`를 바꿀 수도 없습니다. 지우고 다시 만든 뒤 기존 Pod도 다시 만듭니다.
- Secret YAML을 손으로 쓸 때 base64 인코딩이 귀찮으면 `stringData` 필드를 씁니다.

### 2-5. command와 args, 이미지의 ENTRYPOINT와 CMD

설정값을 넘기는 또 하나의 길이 실행 명령입니다. "Define a Command and Arguments for a Container" 문서 기준으로 `command`는 이미지의 ENTRYPOINT에, `args`는 CMD에 대응합니다. 이름만 보면 `command`가 CMD와 짝일 것 같아서 자주 틀립니다.

| Pod에 적은 것 | 실제로 실행되는 것 |
|---|---|
| 둘 다 없음 | 이미지의 ENTRYPOINT + CMD |
| `args`만 | 이미지의 ENTRYPOINT + `args` |
| `command`만 | `command`만. 이미지의 CMD도 버려짐 |
| 둘 다 | `command` + `args` |

`kubectl run`에서는 `--` 뒤의 값이 `args`가 되고 `--command`를 붙이면 `command`가 됩니다(`kubectl run sleeper --image=busybox --command -- sleep 3600`). 두 필드 모두 Pod를 만든 뒤에는 바꿀 수 없습니다.

### 2-6. Secret 저장 시 암호화(EncryptionConfiguration)

저장 시 암호화 설정은 CKS 커리큘럼 항목이라 원리만 적습니다. kube-apiserver에 `--encryption-provider-config`로 `EncryptionConfiguration` 파일을 주고 그 디렉터리를 static Pod 매니페스트에 hostPath로 마운트합니다. 공급자 목록의 첫 항목으로 쓰고 읽을 때는 목록 순서대로 맞는 공급자를 찾으니 `aescbc` 같은 암호화 공급자를 맨 위에, 옛 평문을 읽을 `identity: {}`를 그 아래에 둡니다. 켠 뒤에는 `kubectl get secrets -A -o json | kubectl replace -f -`로 기존 Secret을 다시 써야 암호화됩니다. 전체 예제는 "Encrypting Confidential Data at Rest" 문서에 있습니다.

### 2-7. 비공개 레지스트리와 imagePullSecrets

비공개 레지스트리 이미지는 호스트를 이미지 이름에 적고(`registry.shop.example/shop/order-api:1.0`) 자격 증명을 `docker-registry` 타입 Secret으로 만들어 Pod spec의 `imagePullSecrets`(`containers`와 같은 높이)에 이름을 적습니다. Secret은 Pod와 같은 네임스페이스에 있어야 합니다. 자격 증명이 틀리면 Pod가 `ErrImagePull`을 거쳐 `ImagePullBackOff`로 남고 Events에 인증 실패가 찍힙니다.

```bash
kubectl create secret docker-registry shop-registry -n shop \
  --docker-server=registry.shop.example \
  --docker-username=<사용자> --docker-password=<비밀번호>

# ServiceAccount에 붙여 새 Pod에 자동으로 채우기
kubectl patch serviceaccount default -n shop \
  -p '{"imagePullSecrets": [{"name": "shop-registry"}]}'
```

ServiceAccount에 붙이면 이후 새로 만드는 Pod에 `ServiceAccount` 승인 컨트롤러가 값을 채웁니다. 이미 떠 있는 Pod에는 들어가지 않습니다.

### 2-8. securityContext의 runAsUser와 capabilities

과제 지문에 나오면 문서에서 찾아 쓰는 정도로 알아 둡니다. Pod 수준(`spec.securityContext`)은 모든 컨테이너에, 컨테이너 수준은 그 컨테이너에만 적용되고 같은 필드가 두 곳에 있으면 컨테이너 수준이 이깁니다. `capabilities`는 컨테이너 수준에만 있습니다.

```yaml
spec:
  securityContext:
    runAsUser: 1000              # 모든 컨테이너 UID 1000
  containers:
    - name: api
      image: busybox:1.36
      command: ["sleep", "3600"]
      securityContext:
        capabilities:
          add: ["NET_ADMIN"]
```

Pod 수준에 `capabilities`를 적으면 `strict decoding error: unknown field "spec.securityContext.capabilities"`로 거절됩니다. 확인은 `kubectl exec <pod> -c api -- id`와 `grep Cap /proc/1/status`로 합니다. root가 아닌 UID의 프로세스는 `NET_ADMIN`을 더해도 `CapBnd`에만 들어가고 실제로 쓰이는 `CapEff`는 0입니다.

### 2-9. 직접 해 보기

2-3절 뼈대에 `subPath` 마운트를 하나 더하고 `kubectl edit configmap`으로 `PAGE_SIZE`를 20에서 50으로 바꿉니다. `kubectl exec`로 보면 볼륨 파일은 1분 안팎에 50이 되고 환경 변수와 `subPath` 파일은 20에 머뭅니다.

## 3. 워크로드 자동 확장

커리큘럼 문구는 "Configure workload autoscaling"입니다. "Autoscaling Workloads" 문서는 수평 확장(Pod 수)과 수직 확장(Pod에 주는 자원)을 나눕니다.

### 3-1. HPA가 레플리카 수를 고르는 방식

HorizontalPodAutoscaler는 컨트롤 플레인의 컨트롤러가 기본 15초마다 계산합니다.

```text
desiredReplicas = ceil[currentReplicas * ( currentMetricValue / desiredMetricValue )]
```

레플리카 3개, 평균 CPU 90%, 목표 60%면 4.5를 올려 5개입니다. 비율이 허용 범위(tolerance, 기본 10%) 안이면 움직이지 않고 축소는 기본 300초 안정화 구간을 거칩니다.

사용률은 각 Pod의 컨테이너 request 대비 백분율입니다. 일부 컨테이너에 해당 자원의 request가 없으면 그 Pod의 사용률이 정의되지 않아 오토스케일러가 아무것도 하지 않습니다. 이때 `kubectl get hpa`의 `TARGETS`는 `cpu: <unknown>/60%`이고 `kubectl describe hpa`의 조건에 원인이 문장으로 찍힙니다.

```text
ScalingActive  False  FailedGetResourceMetric  ... missing request for cpu in container nginx of Pod ...
```

메트릭은 Metrics Server가 제공하는 `metrics.k8s.io` API에서 옵니다. 1.37에서 이 API의 `v1`이 stable이 됐고 전환 기간에는 `v1beta1`도 쓰입니다. `kubectl top pods`가 동작하면 Metrics Server가 살아 있는 것입니다.

### 3-2. 시험에서 쓰는 명령

```bash
kubectl top pods -n shop        # Metrics Server가 동작하는지 확인

kubectl autoscale deployment order-api -n shop --cpu=60% --min=2 --max=8
kubectl get hpa -n shop
kubectl describe hpa order-api -n shop
```

`kubectl autoscale`의 옵션은 1.34부터 `--cpu`와 `--memory`입니다. 값에 `%`를 붙이면 평균 사용률이 목표이고 단위 없이 `500`만 쓰면 CPU는 `500m`, 메모리는 `500Mi`의 평균 값으로 읽습니다. 옛 강의의 `--cpu-percent`는 `Flag --cpu-percent has been deprecated` 경고와 함께 아직 동작하고 `--cpu`와 함께 주면 `error: --cpu-percent and --cpu are mutually exclusive`가 납니다.

명령으로 줄 수 없는 값은 `autoscaling/v2` YAML로 씁니다. "HorizontalPodAutoscaler Walkthrough" 문서에서 복사하면 빠릅니다.

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
    scaleUp:
      tolerance: 0.05             # 1.37 stable. 목표보다 5% 넘게 높을 때만 확장
```

`tolerance`는 수량 타입이라 저장된 값을 읽으면 `"50m"`으로 나옵니다. 필드가 없으면 kube-controller-manager의 `--horizontal-pod-autoscaler-tolerance`(기본 0.1)가 쓰입니다. 1.37에서는 `HPAScaleToZero`가 beta로 기본 활성이 되어 Object나 External 메트릭을 쓰는 HPA에 한해 `minReplicas: 0`을 허용합니다. CPU와 메모리 같은 Resource 메트릭만 쓰는 HPA에 0을 적으면 거절됩니다.

```text
spec.metrics: Forbidden: must specify at least one Object or External metric to support scaling to zero replicas
```

### 3-3. VPA

VerticalPodAutoscaler는 사용량에 맞춰 requests와 limits를 조정합니다. "Vertical Pod Autoscaling" 문서 기준으로 CRD(`autoscaling.k8s.io/v1`)로 정의되어 따로 설치해야 하고 예시가 적어서 `kubectl explain`으로 필드를 찾습니다.

```bash
kubectl get crd | grep verticalpodautoscaler
kubectl explain vpa.spec
kubectl explain vpa.spec.resourcePolicy.containerPolicies
kubectl describe vpa order-api -n shop           # 권장값(Target, Lower/Upper bound)
```

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: order-api
  namespace: shop
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: order-api
  updatePolicy:
    updateMode: "Off"              # 권장값만 계산
  resourcePolicy:
    containerPolicies:
      - containerName: "*"
        minAllowed: { cpu: 100m, memory: 64Mi }
        maxAllowed: { cpu: "1", memory: 512Mi }
```

`updateMode`는 `Off`(권장값만 `.status`에 둠), `Initial`(새 Pod에만 적용), `Recreate`(Pod를 내보내고 새 Pod에 적용), `InPlaceOrRecreate`(제자리 resize를 먼저 시도), `InPlace`(제자리 resize만) 중 하나입니다. 옛 자료의 `Auto`는 VPA 1.4.0부터 deprecated된 `Recreate`의 별칭입니다. 설치된 VPA 버전에 따라 `InPlace` 계열 값이 없을 수 있으니 `kubectl explain vpa.spec.updatePolicy`로 확인합니다.

수직 확장의 다른 길은 in-place resize입니다. 실행 중인 컨테이너의 CPU와 메모리를 Pod를 다시 만들지 않고 바꾸는 기능이고 1.35에서 stable이 됐습니다. Pod의 `resize` 하위 리소스에 패치하며 kubectl 1.32 이상이 필요합니다.

```bash
kubectl patch pod order-api-xxxx -n shop --subresource resize --patch \
  '{"spec":{"containers":[{"name":"nginx","resources":{"requests":{"cpu":"200m"},"limits":{"cpu":"200m"}}}]}}'
kubectl get pod order-api-xxxx -n shop -o jsonpath='{.status.containerStatuses[0].resources}'
```

컨테이너의 `resizePolicy`는 자원마다 `NotRequired`(기본, 재시작 없이 적용)나 `RestartContainer`입니다. QoS 클래스(5-2절)가 바뀌는 변경은 `Pod QOS Class may not change as a result of resizing`으로 거절되고 노드가 바로 들어주지 못하면 `PodResizePending` 조건이 붙습니다. Deployment가 관리하는 Pod를 이렇게 바꾸면 다음 롤아웃 때 템플릿 값으로 돌아갑니다.

### 3-4. 직접 해 보기

request 없는 `order-api`에 HPA를 만들어 `TARGETS`가 `cpu: <unknown>/60%`인지, describe에 `missing request for cpu`가 있는지 봅니다. `kubectl set resources deployment order-api -n shop --requests=cpu=100m` 뒤 `cpu: 0%/60%`로 바뀌면 Walkthrough 문서의 부하 Pod를 띄우고 `kubectl get hpa --watch`로 확장을 봅니다. kind에서는 metrics-server를 따로 넣고 `--kubelet-insecure-tls` 인자를 더해야 합니다([Ch-06](/blog/cert/cka/cka-06-troubleshooting) 3-4절).

## 4. 자가 치유를 만드는 기본 요소

커리큘럼 문구는 "Understand the primitives used to create robust, self-healing, application deployments"입니다. "Kubernetes Self-Healing" 문서 기준으로 컨테이너가 죽으면 kubelet이 `restartPolicy`대로 재시작하고 Pod가 죽으면 Deployment, StatefulSet, DaemonSet 컨트롤러가 대체 Pod를 만듭니다. 준비되지 않은 Pod는 Service 엔드포인트에서 빠집니다.

### 4-1. restartPolicy와 CrashLoopBackOff

Pod의 `restartPolicy`는 `Always`(기본), `OnFailure`, `Never`입니다. Deployment에서는 `Always`만 허용되고 Job은 `OnFailure`나 `Never`만 씁니다.

| 종료 코드 | Always | OnFailure | Never |
|---|---|---|---|
| 0(성공) | 재시작 | 재시작 안 함 | 재시작 안 함 |
| 0이 아님(실패) | 재시작 | 재시작 | 재시작 안 함 |

재시작 사이에는 지수 백오프가 붙습니다. "Pod Lifecycle" 문서 기준으로 10초, 20초, 40초처럼 늘고 300초에서 멈추며 컨테이너가 10분 동안 문제없이 돌면 초기화됩니다. `CrashLoopBackOff`는 이 백오프가 걸려 있다는 표시이고 원인은 `kubectl logs <pod> --previous`로 직전 컨테이너 로그에서 찾습니다.

1.35부터는 컨테이너에 `restartPolicy`와 `restartPolicyRules`(예: `exitCodes`가 `In [42]`일 때만 `Restart`)를 적어 Pod 값을 덮어쓸 수 있습니다(`ContainerRestartRules`, 1.35 beta 기본 활성). 규칙을 쓰면서 컨테이너 `restartPolicy`를 빠뜨리면 `must specify restartPolicy when restart rules are used`로 거절됩니다.

### 4-2. 프로브 셋

| 프로브 | 실패하면 | 쓰는 자리 |
|---|---|---|
| startupProbe | 컨테이너를 죽이고 restartPolicy를 따름. 성공 전에는 나머지 두 프로브를 실행하지 않음 | 시작이 오래 걸리는 앱 |
| livenessProbe | 허용 횟수를 넘기면 컨테이너 재시작 | 살아는 있지만 진행하지 못하는 상태 |
| readinessProbe | 재시작은 안 함. Pod의 `Ready`가 false가 되고 EndpointSlice에서 Pod IP가 빠짐 | 트래픽을 받을 준비가 됐는지 |

기본값은 `periodSeconds` 10초, `timeoutSeconds` 1초, `failureThreshold` 3회, `initialDelaySeconds` 0초라서 liveness는 약 30초 연속 실패해야 재시작합니다. startupProbe는 `failureThreshold × periodSeconds`(아래 예는 300초)만큼 시작 시간을 벌어 줍니다.

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

`httpGet` 자리에 `exec: { command: ["cat", "/tmp/healthy"] }`나 `tcpSocket: { port: 5432 }`를 쓸 수 있습니다.

### 4-3. 헷갈리는 지점

- liveness 프로브는 readiness 프로브가 성공하기를 기다리지 않습니다. 시작이 느린 앱에 liveness만 걸면 뜨기도 전에 재시작이 반복됩니다. 이때 startupProbe나 `initialDelaySeconds`를 씁니다.
- readiness 실패는 재시작을 일으키지 않습니다. Pod가 `Running`인데 Service로 트래픽이 안 가면 `READY` 열과 EndpointSlice를 봅니다.

### 4-4. 네이티브 사이드카

앱과 함께 계속 돌아야 하는 로그 수집기나 프록시는 `initContainers`에 `restartPolicy: Always`를 붙여 만듭니다(`SidecarContainers`, 1.29 기본 활성, 1.33 stable). `containers`에 두면 일반 앱 컨테이너입니다.

"Sidecar Containers" 문서 기준으로 사이드카는 init 목록 순서대로 시작하고 `started`가 되어야(startupProbe가 있으면 그 성공) 다음 init 컨테이너가 뜹니다. Pod가 사는 동안 계속 돌고 앱 컨테이너가 멈춘 뒤 정의 역순으로 종료됩니다.

일반 init 컨테이너(`restartPolicy`를 적지 않은 것)는 하나씩 돌고 앞 것이 성공해야 다음 것이, 모두 끝나야 앱 컨테이너가 뜹니다. 실패하면 성공할 때까지 다시 실행하고 Pod의 `restartPolicy`가 `Never`면 Pod 전체가 실패입니다. DB 이름이 DNS에 잡힐 때까지 `until nslookup order-db; do sleep 2; done`으로 기다리는 것이 흔한 예입니다.

게시판 앱의 로그 파일을 사이드카가 stdout으로 내보내는 예입니다.

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
kubectl -n board get pod board                    # READY 2/2: 사이드카도 셈
kubectl -n board logs board -c log-shipper
```

### 4-5. StatefulSet: 고정 이름, headless Service, volumeClaimTemplates

주문 DB처럼 복제본마다 고정된 이름과 자기 데이터가 있어야 하는 워크로드는 StatefulSet으로 띄웁니다.

| 항목 | "StatefulSets" 문서 기준 동작 |
|---|---|
| Pod 이름 | `<StatefulSet 이름>-<순번>`. 순번은 0부터 |
| DNS 이름 | `<Pod 이름>.<Service 이름>.<네임스페이스>.svc.cluster.local` |
| headless Service | 직접 만들고 `serviceName`으로 가리킴 |
| 저장소 | `volumeClaimTemplates` 항목마다 Pod별 PVC 하나. 이름은 `<템플릿 이름>-<Pod 이름>` |
| 삭제와 축소 | PVC와 PV는 남음(`persistentVolumeClaimRetentionPolicy` 기본 `Retain`) |
| 배포 순서 | 기본 `OrderedReady`. 0번이 Ready여야 1번을 만들고 축소는 큰 순번부터 |

```yaml
apiVersion: v1
kind: Service
metadata:
  name: order-db
  namespace: shop
spec:
  clusterIP: None            # headless
  selector:
    app: order-db
  ports:
    - port: 5432
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: order-db
  namespace: shop
spec:
  serviceName: order-db      # 위 headless Service 이름
  replicas: 2
  selector:
    matchLabels:
      app: order-db
  template:
    metadata:
      labels:
        app: order-db
    spec:
      containers:
        - name: db
          image: <이미지>
          volumeMounts:
            - name: data
              mountPath: /var/lib/data
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 1Gi
```

Pod `order-db-0`, `order-db-1`과 PVC `data-order-db-0`, `data-order-db-1`이 생기고 `order-db-0`을 지우면 같은 이름의 Pod가 같은 PVC를 달고 돌아옵니다. StorageClass를 적지 않으면 기본 StorageClass가 쓰입니다([CKA Ch-05](/blog/cert/cka/cka-05-storage)). `kubectl create` 하위 명령이 없어 Deployment 뼈대에서 `kind`를 바꾸고 두 필드를 더합니다.

### 4-6. Job과 CronJob

Job은 지정한 수만큼 Pod가 성공하면 끝나는 컨트롤러이고 `restartPolicy`는 `Never`나 `OnFailure`만 허용됩니다. 자주 더하는 필드는 `completions`(성공해야 하는 Pod 수, 기본 1), `parallelism`(동시 실행 수, 기본 1), `backoffLimit`(실패 판정 전 재시도, 기본 6), `activeDeadlineSeconds`(전체 실행 시간 상한, `backoffLimit`보다 우선하고 넘으면 `reason: DeadlineExceeded`로 실패), `ttlSecondsAfterFinished`(끝난 Job 자동 삭제)입니다.

```bash
# 게시판 통계 집계를 한 번 실행 (뼈대를 파일로 받아 필드 추가)
kubectl create job board-stats -n board --image=busybox:1.36 \
  --dry-run=client -o yaml -- sh -c 'echo done' > job.yaml
kubectl get jobs -n board
kubectl logs -n board job/board-stats

# 결제 대사 작업을 매일 새벽 3시에
kubectl create cronjob payment-reconcile -n payment --image=busybox:1.36 \
  --schedule="0 3 * * *" -- sh -c 'date'

# 일정을 기다리지 않고 지금 한 번 돌려 보기
kubectl create job reconcile-now -n payment --from=cronjob/payment-reconcile
```

CronJob의 `schedule`은 분, 시, 일, 월, 요일 다섯 칸이고 시간대는 `.spec.timeZone`으로 줍니다. `concurrencyPolicy`는 이전 Job이 아직 돌 때 함께 실행(`Allow`, 기본), 건너뛰기(`Forbid`), 교체(`Replace`) 중 하나입니다. Job 설정은 `spec.jobTemplate.spec` 아래로 한 단계 들어갑니다. `backoffLimit`을 CronJob의 `spec` 바로 아래에 적으면 `strict decoding error: unknown field "spec.backoffLimit"`로 거절됩니다.

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: payment-reconcile
  namespace: payment
spec:
  schedule: "0 3 * * *"
  concurrencyPolicy: Forbid
  jobTemplate:
    spec:
      backoffLimit: 2
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: reconcile
              image: busybox:1.36
              command: ["sh", "-c", "date"]
```

### 4-7. PodDisruptionBudget와 drain

PodDisruptionBudget(PDB)는 drain 같은 자발적 중단 중에도 남아 있어야 할 Pod 수를 정합니다. PDB를 지키는 쪽은 Eviction API라서 `kubectl drain`은 따르고 Pod를 직접 지우는 것과 노드 장애는 PDB와 무관합니다.

```bash
# 주문 API는 drain 중에도 최소 2개 유지
kubectl create pdb order-api-pdb -n shop --selector=app=order-api --min-available=2
kubectl get pdb -n shop        # ALLOWED DISRUPTIONS 열이 지금 내보낼 수 있는 수
```

YAML로 쓰면 `policy/v1`의 `spec.minAvailable`(또는 `maxUnavailable`, 한 PDB에 하나만)과 `spec.selector.matchLabels`입니다.

- `minAvailable`과 `maxUnavailable`은 정수나 `"50%"` 같은 백분율을 받고 백분율은 올림합니다. Pod 7개에 `minAvailable: "50%"`면 4개가 남아야 합니다.
- `ALLOWED DISRUPTIONS`가 0이면 drain은 아래 줄을 찍으며 재시도하고 대체 Pod가 Ready가 되면 진행합니다. `maxUnavailable: 0`이나 레플리카 수와 같은 `minAvailable`이면 끝나지 않습니다.

```text
error when evicting pods/"order-api-..." (will retry after 5s): Cannot evict pod as it would violate the pod's disruption budget.
```

drain 명령과 `--ignore-daemonsets`, `--delete-emptydir-data`, `--force` 옵션은 [CKA Ch-02](/blog/cert/cka/cka-02-cluster-architecture) 4-7절에 정리했습니다.

### 4-8. 직접 해 보기

- "Configure Liveness, Readiness and Startup Probes" 문서의 첫 예제(`cat /tmp/healthy`, 30초 뒤 파일 삭제)를 띄우고 Events에 `Liveness probe failed: cat: can't open '/tmp/healthy': No such file or directory`가 세 번 찍힌 뒤 `Container liveness failed liveness probe, will be restarted`가 나오는지 봅니다.
- `order-db-0`을 지우고 같은 이름과 PVC로 돌아오는지 봅니다. Pod별 DNS는 `kubectl run tmp --rm -it --restart=Never --image=busybox:1.36 -n shop -- nslookup order-db-0.order-db.shop.svc.cluster.local`로 확인합니다. busybox 1.36의 `nslookup`은 `order-db-0.order-db`처럼 점이 든 짧은 이름에 `NXDOMAIN`을 돌려주니 FQDN으로 적습니다.
- 워커 두 대에 레플리카 3개와 `minAvailable: 2` PDB를 두고 Pod가 둘 있는 노드를 drain해 4-7절의 재시도 메시지를 봅니다.

## 5. Pod 승인과 스케줄링

커리큘럼 문구는 "Configure Pod admission and scheduling (limits, node affinity, etc.)"입니다. 결론 1번의 세 길목을 따라 읽습니다.

### 5-1. 승인 단계

승인 컨트롤러(admission controller)는 인증과 인가를 통과한 요청을 저장하기 전에 가로채는 API 서버 안의 코드입니다. 값을 고치는 mutating이 먼저, 거절만 하는 validating이 나중에 돕니다. `LimitRanger`, `ResourceQuota`, `Priority`, `DefaultTolerationSeconds`, `ServiceAccount`가 기본으로 켜져 있습니다. kubeadm 클러스터에서 플러그인을 더하고 빼는 자리는 kube-apiserver static Pod 매니페스트이고 저장하면 kube-apiserver가 다시 뜨는 동안 `kubectl`이 잠시 응답하지 않습니다.

```yaml
# kube-apiserver.yaml의 command 일부
    - --enable-admission-plugins=NodeRestriction,AlwaysPullImages
    - --disable-admission-plugins=DefaultStorageClass
```

`--enable-admission-plugins`의 이름은 기본 목록에 더해지고 순서는 상관없습니다. Pod 생성이 승인 단계에서 거절될 때 볼 자리입니다.

| 거절 원인 | 확인할 자리 |
|---|---|
| LimitRange 최솟값, 최댓값 위반 | `kubectl describe limitrange -n <ns>` |
| ResourceQuota 초과, request/limit 미기재 | `kubectl describe quota -n <ns>` |
| 없는 PriorityClass 이름 | `kubectl get priorityclass` |
| Pod Security Admission(`PodSecurity`, 기본 활성) | 네임스페이스 라벨 `pod-security.kubernetes.io/enforce` |
| 어드미션 웹훅 | 웹훅 서버가 죽었는데 `failurePolicy: Fail`이면 생성이 전부 막힘 |

ValidatingAdmissionPolicy(1.30 stable)는 웹훅 서버 없이 CEL 식(`object.spec.replicas <= 5` 같은)으로 규칙을 적는 객체입니다. 정책과 `ValidatingAdmissionPolicyBinding`이 둘 다 있어야 효력이 나고 YAML은 "Validating Admission Policy" 문서의 예제를 고쳐 씁니다. 함정은 둘입니다. 정책의 `resources`에 `deployments`만 적으면 `kubectl scale`이 고치는 `deployments/scale` 하위 리소스는 정책에 걸리지 않습니다. 바인딩의 `validationActions`에 `Deny`와 `Warn`을 함께 적으면 바인딩 자체가 `must not contain both Deny and Warn`으로 거절됩니다.

### 5-2. requests와 limits

| 값 | 누가 쓰는지 | 넘으면 |
|---|---|---|
| requests | 스케줄러가 노드를 고를 때. 노드에 배치된 컨테이너 requests 합이 노드 할당 가능량 안이어야 함 | 사용량이 request를 넘는 것은 허용 |
| limits | 노드의 kubelet과 커널 | CPU는 스로틀링, 메모리는 OOM으로 종료(`OOMKilled`) |

limit만 적고 request를 적지 않으면 limit 값이 request로 복사됩니다. 그래서 CPU와 메모리 limit만 적은 Pod는 QoS가 `Guaranteed`입니다. 단위도 자주 틀립니다. CPU `0.1`은 `100m`과 같고 메모리 `400m`은 0.4바이트입니다. 400메비바이트는 `400Mi`입니다.

requests와 limits의 조합이 QoS 클래스를 정합니다.

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

kubelet이 cgroup으로 limits를 집행하는 방식은 시험 범위 밖이라 [쿠버네티스 아래의 리눅스 3편](/blog/theory/systems/k8s-linux-03-cgroup-qos)에 따로 정리했습니다.

### 5-3. LimitRange

LimitRange는 네임스페이스 안 컨테이너나 Pod 하나하나의 최솟값, 최댓값, 기본값을 정합니다. 자원을 적지 않은 Pod에 기본값을 넣고 범위를 넘으면 `403 Forbidden`으로 거절합니다. 승인 시점에만 작동해서 이미 떠 있는 Pod는 그대로입니다. `kubectl create` 하위 명령이 없어 YAML로 씁니다.

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

이 LimitRange에서 limit `2`를 적은 Pod는 `maximum cpu usage per Container is 1, but limit is 2`로 거절됩니다. request `700m`만 적은 Pod도 실패합니다. 기본 limit 500m이 들어가 request가 limit보다 커지기 때문이고 `must be less than or equal to cpu limit of 500m` 검증 오류가 납니다. LimitRange는 자기가 넣는 기본값끼리 맞는지 검사하지 않습니다.

### 5-4. ResourceQuota

ResourceQuota는 네임스페이스 전체의 합계를 묶습니다.

```bash
kubectl create quota shop-quota -n shop \
  --hard=requests.cpu=2,requests.memory=4Gi,limits.cpu=4,limits.memory=8Gi,pods=10
kubectl describe quota shop-quota -n shop     # Used와 Hard 비교
```

- `cpu`나 `memory` 쿼터가 걸리면 새 Pod마다 해당 자원을 적어야 합니다. 안 적으면 `must specify limits.cpu for: ...`로 거절되니 LimitRange로 기본값을 채웁니다.
- 쿼터를 넘는 생성이나 수정은 `403 Forbidden`입니다.
- Deployment는 만들어지고 Pod만 덜 생깁니다. `pods=3` 쿼터에 레플리카 5개면 Pod 3개만 뜨고 `kubectl describe rs`에 `FailedCreate`와 `exceeded quota: ..., requested: pods=1, used: pods=3, limited: pods=3`이 붙습니다.
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

nodeSelector는 적은 라벨을 모두 가진 노드에만 Pod를 놓습니다. `nodeName`에 값이 있으면 스케줄러를 건너뛰고 그 노드의 kubelet이 바로 띄웁니다. 승인 단계는 그대로 거치고 자원이 모자라면 `OutOfcpu` 같은 이유로 `Failed`가 됩니다.

스케줄러가 멈춘 클러스터에서 `Pending`인 Pod를 놓는 방법은 둘입니다. Pod를 지우고 `nodeName`을 넣어 다시 만들거나(`edit`, `patch`로 넣는 것은 거절됩니다) Pod의 `binding` 하위 리소스에 Binding 객체를 보냅니다.

```json
{
  "apiVersion": "v1",
  "kind": "Binding",
  "metadata": { "name": "board-web" },
  "target": { "apiVersion": "v1", "kind": "Node", "name": "node02" }
}
```

파일로 저장해 `kubectl create -f binding.json -n board`로 보냅니다. 이미 노드가 정해진 Pod에 다시 보내면 `409 Conflict`와 `pod board-web is already assigned to node "..."`가 돌아옵니다.

### 5-6. 노드 어피니티

`requiredDuringSchedulingIgnoredDuringExecution`은 만족하는 노드가 없으면 `Pending`, `preferredDuringScheduling...`은 만족하는 노드를 먼저 찾고(`weight` 1~100) 없으면 아무 데나 놓습니다. `IgnoredDuringExecution`은 스케줄된 뒤 노드 라벨이 바뀌어도 Pod가 계속 돈다는 뜻입니다. 연산자는 `In`, `NotIn`, `Exists`, `DoesNotExist`, `Gt`, `Lt`입니다.

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

결합 규칙은 꼭 외웁니다. `nodeSelectorTerms` 안의 여러 항목은 OR이고 한 항목의 `matchExpressions` 안 여러 식은 AND입니다. nodeSelector와 nodeAffinity를 함께 쓰면 둘 다 만족해야 합니다. Pod 라벨을 기준으로 하는 Pod 어피니티는 5-12절에 있습니다.

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

`operator`의 기본값은 `Equal`입니다. `Exists`면 `value`를 적지 않고 `key`까지 비우면 모든 테인트에 맞습니다. `DefaultTolerationSeconds` 승인 컨트롤러가 `node.kubernetes.io/not-ready`와 `node.kubernetes.io/unreachable`에 `tolerationSeconds=300`인 톨러레이션을 자동으로 붙입니다. 노드가 문제를 보이고 5분 뒤에 Pod가 옮겨지는 이유입니다.

결제 전용 노드는 테인트로 다른 Pod를 막고 결제 Pod에 톨러레이션과 nodeSelector(또는 노드 어피니티)를 함께 넣어 만듭니다. 톨러레이션만 있으면 결제 Pod가 일반 노드에 놓일 수도 있습니다.

### 5-8. static Pod

static Pod는 API 서버를 거치지 않고 노드의 kubelet이 직접 관리하는 Pod입니다. kubeadm은 kube-apiserver, kube-controller-manager, kube-scheduler, etcd를 static Pod로 돌립니다.

- kubelet은 `staticPodPath`(kubeadm 노드는 `/etc/kubernetes/manifests`, `/var/lib/kubelet/config.yaml`에서 확인)의 점으로 시작하지 않는 모든 파일을 읽습니다. `kube-apiserver.yaml.backup`도 Pod가 되니 백업은 디렉터리 밖에 둡니다.
- API 서버에는 이름 뒤에 `-<노드 이름>`이 붙은 mirror Pod로 보입니다. `kubectl delete`로 지워도 다시 생기니 없애려면 매니페스트 파일을 지웁니다.
- static Pod의 spec은 ServiceAccount, ConfigMap, Secret 같은 다른 API 객체를 참조할 수 없습니다. 1.37에서 이 금지가 기능 게이트 없이 항상 적용됩니다.

시험은 과제마다 지정 호스트에 `ssh`로 들어가는 방식이고 ssh 중첩은 안 됩니다. 매니페스트는 그 노드에서 직접 쓰고 mirror Pod 확인은 kubectl이 설정된 호스트에서 합니다(base 호스트에는 kubectl이 없습니다).

```bash
ssh node01
sudo -i
grep staticPodPath /var/lib/kubelet/config.yaml
vi /etc/kubernetes/manifests/board-check.yaml     # 아래 YAML을 붙여 넣음
kubectl get pods -A -o wide | grep board-check    # board-check-node01
```

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: board-check
spec:
  containers:
    - name: board-check
      image: busybox
      command: ["sleep", "3600"]
```

### 5-9. PriorityClass

PriorityClass는 이름에 정수 우선순위를 붙이는 클러스터 범위 객체입니다. 사용자가 만드는 값은 10억(1000000000) 이하이고 그보다 큰 값은 `system-cluster-critical`(2000000000)과 `system-node-critical`(2000001000) 같은 시스템용입니다.

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

- 없는 이름은 `no PriorityClass with name nope was found`로, 10억을 넘는 값은 `maximum allowed value of a user defined priority is 1000000000`으로 거절됩니다.
- `globalDefault: true`는 하나만 둘 수 있고 없으면 이름을 적지 않은 Pod의 우선순위는 0입니다.
- 놓을 노드가 없으면 스케줄러가 우선순위 낮은 Pod를 축출해 자리를 만듭니다(선점). `preemptionPolicy: Never`면 대기열 앞에만 서고 선점하지 않습니다.

### 5-10. DaemonSet

DaemonSet은 조건에 맞는 노드마다 Pod를 하나씩 띄우는 컨트롤러입니다. 로그 수집 에이전트, CNI 플러그인, kube-proxy가 이 방식으로 돕니다. static Pod(5-8절)와 달리 API 서버의 객체이고 컨트롤러와 스케줄러를 거칩니다. `kubectl create` 하위 명령이 없어 Deployment 뼈대를 받아 고칩니다.

```bash
kubectl create deployment log-agent -n kube-system --image=fluent/fluent-bit:3.0 \
  --dry-run=client -o yaml > log-agent.yaml
# kind를 DaemonSet으로 바꾸고 replicas, strategy, status 줄을 지운 뒤
kubectl apply -f log-agent.yaml
kubectl get ds -n kube-system
```

- 컨트롤러가 노드마다 노드 어피니티를 넣은 Pod를 만들고 배치는 기본 스케줄러가 맡습니다. 스케줄러가 멈추면 새 DaemonSet Pod도 `Pending`입니다.
- `not-ready`, `unreachable`, `disk-pressure`, `memory-pressure`, `pid-pressure`, `unschedulable` 톨러레이션이 자동으로 붙어 cordon한 노드에도 뜹니다.
- 컨트롤 플레인의 `node-role.kubernetes.io/control-plane:NoSchedule`은 자동 톨러레이션에 없어 템플릿에 직접 적습니다. 일부 노드에만 띄우려면 `nodeSelector`를 적습니다.

### 5-11. 다중 스케줄러와 스케줄러 프로파일

Pod의 `spec.schedulerName`이 담당 스케줄러를 정합니다. 적지 않으면 `default-scheduler`이고 없는 이름이면 `Pending`에 남으며 만든 뒤에는 바꿀 수 없습니다. 스케줄러를 더 두는 방법은 kube-scheduler를 하나 더 띄우기("Configure Multiple Schedulers")와 `KubeSchedulerConfiguration`의 `profiles[].schedulerName`으로 프로파일 여러 개 두기("Scheduler Configuration")입니다. 누가 배치했는지는 이벤트로 봅니다.

```bash
kubectl get events -n board -o wide | grep Scheduled     # SOURCE 열에 my-scheduler
kubectl logs -n kube-system deploy/my-scheduler          # Pending이면 권한, 설정 경로 오류 확인
```

### 5-12. Pod 어피니티, 안티 어피니티, topologySpreadConstraints

Pod 어피니티와 안티 어피니티는 이미 떠 있는 Pod의 라벨을 봅니다. `topologyKey`로 묶은 영역(`kubernetes.io/hostname`이면 노드, `topology.kubernetes.io/zone`이면 존)에 조건에 맞는 Pod가 있으면 `podAffinity`는 그 영역으로 끌어당기고 `podAntiAffinity`는 피합니다. required와 preferred 구분은 노드 어피니티와 같습니다. 장바구니 캐시를 노드마다 하나씩 흩는 예입니다. 캐시가 있는 노드에 API를 붙이려면 같은 모양으로 `podAffinity`를 씁니다.

```yaml
# cart-cache Deployment의 Pod 템플릿 일부: 같은 노드에 cart-cache 둘을 두지 않음
      labels:
        app: cart-cache
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  app: cart-cache
              topologyKey: kubernetes.io/hostname
```

preferred로 쓸 때는 항목을 `- weight: 100`과 `podAffinityTerm:`으로 감싸고 그 안에 `labelSelector`와 `topologyKey`(비울 수 없음)를 둡니다.

- `labelSelector`는 `namespaces`나 `namespaceSelector`가 없으면 이 Pod의 네임스페이스만 봅니다.
- 레플리카가 노드 수보다 많으면 required 안티 어피니티로는 남는 Pod가 `Pending`이 되고 Events에 `didn't match pod anti-affinity rules`가 찍힙니다.

영역마다 개수를 고르게 맞추려면 `topologySpreadConstraints`를 씁니다.

| 필드 | "Pod Topology Spread Constraints" 문서 기준 의미 |
|---|---|
| `maxSkew` | 영역 사이 Pod 수 차이의 허용치. 0보다 커야 함 |
| `topologyKey` | 영역을 가르는 노드 라벨 키 |
| `whenUnsatisfiable` | `DoNotSchedule`(기본, 어기면 배치 안 함) 또는 `ScheduleAnyway`(배치하되 차이를 줄이는 노드에 높은 점수) |
| `labelSelector` | 개수를 셀 Pod. 보통 자기 Pod 템플릿 라벨과 같게 둠 |

```yaml
# order-api Pod 템플릿의 spec 아래: 존 사이 개수 차이를 1 이하로
topologySpreadConstraints:
  - maxSkew: 1
    topologyKey: topology.kubernetes.io/zone
    whenUnsatisfiable: DoNotSchedule
    labelSelector:
      matchLabels:
        app: order-api
```

존 세 개에 2, 2, 1개가 있고 `maxSkew: 1`이면 새 Pod는 1개인 존에만 갑니다. 2개인 존에 가면 차이가 2가 되기 때문입니다.

- `topologyKey` 라벨이 없는 노드는 계산에서 빠지고 이 Pod도 가지 않습니다. 존 라벨이 없는 클러스터에서는 라벨부터 붙입니다.
- `nodeTaintsPolicy` 기본값이 `Ignore`라서 Pod가 갈 수 없는 테인트 노드(컨트롤 플레인 등)도 Pod 0개인 영역으로 셉니다. 워커 2대와 컨트롤 플레인 1대에서 레플리카 4개에 노드 단위 `maxSkew: 1`, `DoNotSchedule`을 걸면 워커마다 1개씩만 뜨고 2개가 `Pending`입니다. 제약에 `nodeTaintsPolicy: Honor`를 더하면 2와 2로 배치됩니다.
- 조건은 스케줄링 시점에만 봅니다. Pod가 지워져 쏠림이 생겨도 다시 맞추지 않습니다.

### 5-13. 직접 해 보기

1. `node02`에 `dedicated=payment:NoSchedule`을 걸고 톨러레이션 없는 Pod가 모두 `node01`로, 톨러레이션과 노드 어피니티를 넣은 결제 Pod는 `node02`로 가는지 봅니다.
2. `pods=3` 쿼터에 레플리카 5개 Deployment를 만들고 ReplicaSet에서 `FailedCreate`를 찾습니다.
3. `/etc/kubernetes/manifests/kube-scheduler.yaml`을 디렉터리 밖으로 옮겨 스케줄러를 멈추고 `Pending` Pod를 Binding으로 놓은 뒤 되돌립니다.
4. `cart-cache` 레플리카를 노드 수보다 하나 많게 만들어 남는 Pod의 Events를 봅니다.
5. "Validating Admission Policy" 문서의 `replicas <= 5` 예제를 `resources: ["deployments"]`만 둔 채 만들고 `kubectl scale --replicas=7`이 통과하는지 확인합니다.

## 6. 확인 문제

위 내용을 바탕으로 직접 만든 연습 과제입니다.

1. `shop` 네임스페이스의 Deployment `order-api` 이미지를 `nginx:1.28`로 바꾸고 롤아웃이 끝나면 바로 이전 리비전으로 되돌리세요.
2. Deployment `board-web`이 롤링 업데이트 중에도 사용 가능한 Pod 4개를 유지하도록 전략을 바꾸세요. 레플리카는 4개입니다.
3. ConfigMap `board-config`의 모든 키를 Deployment `board-web`의 환경 변수로 넣으세요. 나중에 더한 키도 Pod를 다시 만들면 들어가야 합니다.
4. Deployment `order-api`에 CPU 평균 사용률 70%를 목표로 최소 2, 최대 6개의 HPA를 만드세요. HPA의 TARGETS가 `<unknown>`이면 무엇을 확인할지도 적으세요.
5. 네임스페이스 `payment`에 컨테이너 기본 request `cpu=200m,memory=128Mi`, 기본 limit `cpu=400m,memory=256Mi`를 강제하세요.
6. `node02`에서 `app=payment` 라벨이 있는 Pod만 돌게 하세요. 다른 Pod는 `node02`에 새로 놓이지 않아야 합니다.
7. `node01`에 static Pod `board-check`(이미지 busybox, `sleep 3600`)를 만들고 mirror Pod 이름을 확인하세요.
8. 우선순위 50000인 PriorityClass `payment-high`를 만들고 Deployment `payment-api`에 적용하세요.
9. Pod `board`의 앱이 `/var/log/board/access.log`에 쓰는 로그를 앱보다 먼저 떠서 계속 도는 사이드카 `log-shipper`가 stdout으로 내보내게 하세요.
10. `shop` 네임스페이스의 Deployment `order-api`(레플리카 3, 라벨 `app=order-api`)가 노드 drain 중에도 최소 2개 유지되게 하고 레플리카가 같은 노드에 둘 이상 놓이지 않게 하세요.

<details>
<summary>풀이 보기</summary>

1. 컨테이너 이름을 먼저 확인합니다.
   ```bash
   kubectl get deploy order-api -n shop -o jsonpath='{.spec.template.spec.containers[*].name}'
   kubectl set image deployment/order-api -n shop <컨테이너>=nginx:1.28
   kubectl rollout status deployment/order-api -n shop
   kubectl rollout undo deployment/order-api -n shop
   ```
2. `maxUnavailable: 0`이면 `maxSurge`는 0일 수 없습니다.
   ```bash
   kubectl patch deployment board-web -p \
     '{"spec":{"strategy":{"rollingUpdate":{"maxUnavailable":0,"maxSurge":1}}}}'
   ```
3. `set env --from`은 키마다 `env` 항목을 만들어 나중에 더한 키를 받지 못합니다(2-3절). `kubectl edit deployment board-web`으로 컨테이너에 `envFrom: [{configMapRef: {name: board-config}}]`를 적습니다.
4. `kubectl autoscale deployment order-api -n shop --cpu=70% --min=2 --max=6`. `<unknown>`이면 `kubectl describe hpa`에서 `missing request for cpu`를 찾고 `kubectl top pods`로 Metrics Server를 봅니다.
5. 5-3절 YAML에서 `max`를 빼고 `defaultRequest: { cpu: 200m, memory: 128Mi }`, `default: { cpu: 400m, memory: 256Mi }`로 `payment`에 만듭니다. 이미 떠 있는 Pod에는 적용되지 않으니 필요하면 `kubectl rollout restart`로 다시 띄웁니다.
6. 테인트로 다른 Pod를 막고 결제 Pod는 톨러레이션과 nodeSelector로 보냅니다.
   ```bash
   kubectl taint nodes node02 app=payment:NoSchedule
   kubectl label nodes node02 app=payment
   ```
   ```yaml
   # Pod 템플릿의 spec 아래
   nodeSelector: { app: payment }
   tolerations:
     - { key: app, operator: Equal, value: payment, effect: NoSchedule }
   ```
   이미 `node02`에 있던 다른 Pod까지 내보내야 하면 `NoExecute`를 씁니다.
7. 5-8절 순서대로 `ssh node01` 뒤 `staticPodPath` 디렉터리에 매니페스트를 쓰고 `kubectl get pods -A | grep board-check`로 `board-check-node01`을 확인합니다.
8. PriorityClass를 만들고 Pod 템플릿에 이름을 넣습니다.
   ```bash
   kubectl create priorityclass payment-high --value=50000
   kubectl patch deployment payment-api -p \
     '{"spec":{"template":{"spec":{"priorityClassName":"payment-high"}}}}'
   ```
9. 4-4절의 YAML이 답입니다. 사이드카를 `initContainers`에 `restartPolicy: Always`로 두고 앱과 같은 `emptyDir`을 마운트합니다. 기존 Pod가 있으면 `kubectl replace --force -f`로 다시 만들고 `kubectl logs board -c log-shipper`로 확인합니다.
10. `kubectl create pdb order-api-pdb -n shop --selector=app=order-api --min-available=2`를 만들고 `kubectl edit deployment order-api -n shop`으로 5-12절의 required `podAntiAffinity`(`app: order-api`, `topologyKey: kubernetes.io/hostname`)를 넣습니다. 레플리카 3개의 기본 전략은 1-1절 계산대로 `maxUnavailable` 0, `maxSurge` 1입니다. 노드가 세 대뿐이고 모두 옛 Pod가 있으면 새 Pod가 갈 노드가 없어 롤아웃이 멈추니 `maxUnavailable`을 1로 둡니다.

</details>

## 범위와 한계

- 명령과 YAML, 오류 문구는 kind 클러스터(노드 v1.37.0, 컨트롤 플레인 1대와 워커 2대, kubectl v1.37.1)에서 2026년 10월에 직접 돌려 확인했습니다. 노드 이름은 `node01`, `node02`로 바꿔 적었습니다.
- VPA(설치하지 않음), startupProbe 예시, 웹훅, 비공개 레지스트리 인증, 선점은 돌리지 않았습니다. 3-3절 VPA YAML은 문서의 필드 구조를 따른 것입니다.
- 시험 환경에 Metrics Server와 VPA가 미리 설치되어 있는지는 공식 문서로 확인하지 못했습니다.
- 기능 게이트 단계와 `metrics.k8s.io/v1` stable처럼 버전마다 바뀌는 사실은 응시 시점의 kubernetes.io 문서로 다시 확인합니다. 확인 문제는 제가 만든 것이고 실제 시험 문항과 관계없습니다.

## 참고 자료

- CNCF, [CKA Curriculum v1.37](https://github.com/cncf/curriculum/blob/master/CKA_Curriculum_v1.37.pdf); Linux Foundation, [Important Instructions: CKA and CKAD](https://docs.linuxfoundation.org/tc-docs/certification/tips-cka-and-ckad)
- Kubernetes 개념: [Deployments](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/), [ConfigMaps](https://kubernetes.io/docs/concepts/configuration/configmap/), [Secrets](https://kubernetes.io/docs/concepts/configuration/secret/), [Horizontal Pod Autoscaling](https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/), [Vertical Pod Autoscaling](https://kubernetes.io/docs/concepts/workloads/autoscaling/vertical-pod-autoscale/), [Sidecar Containers](https://kubernetes.io/docs/concepts/workloads/pods/sidecar-containers/), [StatefulSets](https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/), [Jobs](https://kubernetes.io/docs/concepts/workloads/controllers/job/), [DaemonSet](https://kubernetes.io/docs/concepts/workloads/controllers/daemonset/)
- Kubernetes 태스크: [HorizontalPodAutoscaler Walkthrough](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale-walkthrough/), [Resize CPU and Memory Resources assigned to Containers](https://kubernetes.io/docs/tasks/configure-pod-container/resize-container-resources/), [Configure Liveness, Readiness and Startup Probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/), [Specifying a Disruption Budget](https://kubernetes.io/docs/tasks/run-application/configure-pdb/), [Create static Pods](https://kubernetes.io/docs/tasks/configure-pod-container/static-pod/)
- Kubernetes 스케줄링과 승인: [Resource Management for Pods and Containers](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/), [Pod Quality of Service Classes](https://kubernetes.io/docs/concepts/workloads/pods/pod-qos/), [Limit Ranges](https://kubernetes.io/docs/concepts/policy/limit-range/), [Resource Quotas](https://kubernetes.io/docs/concepts/policy/resource-quotas/), [Assigning Pods to Nodes](https://kubernetes.io/docs/concepts/scheduling-eviction/assign-pod-node/), [Taints and Tolerations](https://kubernetes.io/docs/concepts/scheduling-eviction/taint-and-toleration/), [Pod Topology Spread Constraints](https://kubernetes.io/docs/concepts/scheduling-eviction/topology-spread-constraints/), [Pod Priority and Preemption](https://kubernetes.io/docs/concepts/scheduling-eviction/pod-priority-preemption/), [Admission Control in Kubernetes](https://kubernetes.io/docs/reference/access-authn-authz/admission-controllers/)
- 버전 변경: [Kubernetes v1.37 릴리스](https://kubernetes.io/blog/2026/08/26/kubernetes-v1-37-release/), [In-place resize GA(v1.35)](https://kubernetes.io/blog/2025/12/19/kubernetes-v1-35-in-place-pod-resize-ga/), [CHANGELOG-1.34](https://github.com/kubernetes/kubernetes/blob/master/CHANGELOG/CHANGELOG-1.34.md)

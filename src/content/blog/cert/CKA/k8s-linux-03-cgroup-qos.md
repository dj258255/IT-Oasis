---
title: '[CKA 부록 3] cgroup v2와 QoS: requests와 limits가 커널 파일이 되기까지'
description: 파드의 requests와 limits가 cgroup v2의 cpu.max, cpu.weight, memory.max로 바뀌고 커널이 그 값을 집행하는 과정을 따라갑니다. OOMKilled와 CPU 스로틀링이 각각 어디서 생기는지, QoS 클래스와 oom_score_adj가 누구를 먼저 죽이는지 커널 문서와 kubelet 소스로 확인하고 JVM 서비스의 OOMKilled 포스트모템을 함께 읽습니다.
date: 2026-10-20T00:00:00.000Z
tags:
  - Kubernetes
  - Linux
  - cgroup
  - OOMKilled
  - CPU Throttling
  - QoS
category: cert/CKA
topics:
  - cert
  - systems
draft: false
series: "CKA 공부"
seriesOrder: 9.3
---

## 결론부터

1. 파드 스펙의 `resources`는 컨테이너가 만들어질 때 OCI 런타임(runc, crun)이 cgroup v2 파일에 써 넣습니다. `limits.cpu`는 `cpu.max`, `requests.cpu`는 변환을 거쳐 `cpu.weight`, `limits.memory`는 `memory.max`가 됩니다. 한 번 쓰인 뒤 한도를 지키게 하는 주체는 커널입니다. kubelet과 containerd는 OOM이 일어나는 순간에 끼어들지 않고 결과만 사후에 보고합니다.
2. CPU는 압축 가능한 자원이라 한도를 넘으면 다음 주기까지 기다립니다(스로틀링). 메모리는 압축할 수 없는 자원이라 회수(reclaim)에 실패하면 커널이 cgroup 안의 프로세스를 죽입니다(OOM kill). 그래서 CPU 한도 초과는 느려짐으로, 메모리 한도 초과는 `OOMKilled`와 재시작으로 나타납니다.
3. `memory.max`와 비교되는 값은 `memory.current`입니다. 익명 메모리, 페이지 캐시, 커널 메모리, tmpfs가 모두 들어갑니다. 애플리케이션이 보는 힙 크기나 RSS만으로는 OOMKilled를 설명하지 못하는 경우가 많습니다.
4. 기본 설정(쿠버네티스 1.36 기준)에서 `requests.memory`는 cgroup 파일에 쓰이지 않습니다. 스케줄링, Burstable 컨테이너의 `oom_score_adj` 계산, kubelet eviction 순위에만 쓰입니다.
5. QoS 클래스는 노드 메모리가 부족할 때 누가 먼저 죽을지를 정합니다. BestEffort는 `oom_score_adj` 1000, Guaranteed는 -997, Burstable은 메모리 request 비율로 3~999 사이 값을 받고 kubelet과 containerd는 -999입니다.

---

[2편](/blog/cert/cka/k8s-linux-02-namespaces-pause)에서는 네임스페이스로 컨테이너가 무엇을 볼 수 있는지를 정했습니다. 이 글은 컨테이너가 얼마나 쓸 수 있는지를 정하는 cgroup을 다룹니다. requests와 limits를 쓰는 법은 [CKA Ch-03](/blog/cert/cka/cka-03-workloads-scheduling)에서 정리했으니 여기서는 그 값이 노드에서 어떤 파일이 되고 커널이 어떻게 집행하는지를 따라갑니다.

예시는 가상의 쇼핑몰입니다. 네임스페이스 `shop`에 주문 API(`order-api`)가 있고 컨테이너 하나에 아래 자원을 줍니다.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: order-api
  namespace: shop
spec:
  containers:
  - name: app
    image: registry.example.com/shop/order-api:1.0
    resources:
      requests:
        cpu: 100m
        memory: 128Mi
      limits:
        cpu: 200m
        memory: 170Mi
```

requests와 limits가 다르니 이 파드는 Burstable입니다. 이 글에 나오는 cgroup 값은 이 스펙을 기준으로 계산합니다. 2026-10-20에 kind v0.33 클러스터(노드 이미지 v1.37.0, containerd 2.3.4, runc 1.4.3)를 colima VM(Ubuntu 24.04.4, 커널 6.8.0-117-generic, arm64) 위에 띄워 이 글의 과제 대부분을 돌렸습니다. 실제로 본 값은 해당 절에 "kind 실측"으로 적었고 나머지 출력은 커널 문서와 쿠버네티스 문서의 형식을 따른 예입니다.

## 1. CPU와 메모리의 집행 방식

### 1-1. 압축 가능한 CPU와 압축할 수 없는 메모리

쿠버네티스 문서는 CPU를 압축 가능한(compressible) 자원, 메모리를 압축할 수 없는(incompressible) 자원으로 나눕니다. 한도를 넘었을 때 커널이 하는 일이 둘에서 완전히 다릅니다.

| 항목 | CPU | 메모리 |
|---|---|---|
| 한도 파일 | `cpu.max` | `memory.max` |
| 한도에 닿으면 | 이번 주기의 남은 시간 동안 cgroup의 태스크를 실행하지 않음 | 회수(reclaim)를 시도하고 실패하면 cgroup 안에서 OOM killer 실행 |
| 겉으로 보이는 증상 | 응답 지연, p99 상승 | 컨테이너 종료, `reason: OOMKilled`, 재시작 |
| 기록되는 곳 | `cpu.stat`의 `nr_throttled`, `throttled_usec` | `memory.events`의 `oom`, `oom_kill`, 커널 로그 |
| 쿠버네티스 이벤트 | 없음 | 컨테이너 상태와 재시작 횟수에 남음 |

CPU 시간은 다음 주기에 다시 주어집니다. 메모리는 이미 할당된 페이지를 프로세스에게서 빼앗을 방법이 회수밖에 없습니다. 회수할 수 없는 익명 메모리로 한도를 채우면 커널에게 남는 선택은 프로세스를 죽이는 것뿐입니다.

### 1-2. 설정 경로와 집행 경로

값이 커널에 들어가는 시점과 커널이 그 값을 집행하는 시점은 따로 있습니다. 둘을 한 화살표로 이으면 OOM 순간에 kubelet이 무언가를 결정한다고 오해하기 쉽습니다.

```text
[설정 경로: 컨테이너를 만들 때 한 번]
kubectl apply
  → kube-apiserver (etcd에 저장)
  → kube-scheduler (requests 합으로 노드 선택)
  → kubelet (파드 cgroup 생성, CRI로 컨테이너 생성 요청)
  → containerd (OCI 스펙 작성: linux.resources)
  → runc 또는 crun (cgroup v2 파일에 값 쓰기, 프로세스 시작)

[집행 경로: 컨테이너가 도는 내내]
프로세스가 메모리 할당 또는 CPU 사용
  → 커널 메모리 컨트롤러 / CPU 대역폭 제어가 cgroup 한도와 비교
  → 초과 시 커널이 직접 회수, OOM kill, 스로틀링
  → containerd가 OOM 이벤트를 받아 기록
  → kubelet이 컨테이너 상태를 OOMKilled로 보고, restartPolicy에 따라 재시작
```

컨테이너가 도는 동안 kubelet이 하는 일은 메트릭 수집과 노드 단위 eviction 판단입니다(4장). 컨테이너 한도 위반에 대한 판단은 전부 커널이 합니다.

**직접 해 보기**

- kind 클러스터에서 위 파드를 만든 뒤 `kubectl exec -n shop order-api -- cat /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max`로 두 값을 읽어 봅니다. cgroup v2와 containerd 조합에서는 컨테이너마다 cgroup 네임스페이스가 따로 생겨서 컨테이너 안의 `/sys/fs/cgroup`이 곧 자기 cgroup입니다.
- `stat -fc %T /sys/fs/cgroup`을 노드에서 실행해 `cgroup2fs`가 나오는지 확인합니다. `tmpfs`가 나오면 cgroup v1 노드이고 이 글의 파일 이름이 맞지 않습니다.

## 2. requests와 limits가 바뀌는 cgroup 파일

### 2-1. 매핑 한눈에 보기

| 파드 스펙 | cgroup v2 파일 | `order-api` 값 | 변환 |
|---|---|---|---|
| `limits.cpu: 200m` | `cpu.max` | `20000 100000` | quota = 밀리코어 × period / 1000 |
| `requests.cpu: 100m` | `cpu.weight` | 17 (runc 1.3.2 이상, crun 1.23 이상) 또는 4 (그 이전 런타임) | 밀리코어 → shares → weight |
| `limits.memory: 170Mi` | `memory.max` | `178257920` | 바이트 그대로 |
| `requests.memory: 128Mi` | 기본 설정에서는 없음 | 해당 없음 | 2-5 참고 |

### 2-2. limits.cpu는 cpu.max의 quota가 된다

`cpu.max`는 `$MAX $PERIOD` 두 값을 담습니다. 커널 문서 기준 기본값은 `max 100000`이고 한도가 없다는 뜻입니다. period는 마이크로초 단위이고 kubelet은 기본으로 100000(100ms)을 씁니다. quota는 그 주기 안에서 cgroup이 쓸 수 있는 CPU 시간입니다.

```text
quota = limits.cpu(밀리코어) × 100000 / 1000

200m  → 20000 100000   (100ms마다 CPU 시간 20ms)
50m   → 5000 100000    (100ms마다 5ms)
2     → 200000 100000  (100ms마다 200ms, 즉 CPU 두 개 분량)
```

quota가 period보다 클 수 있다는 점이 중요합니다. limit 2는 100ms 동안 모든 CPU에서 쓴 시간을 합쳐 200ms까지 허용한다는 뜻입니다. 어느 코어에서 실행할지는 정하지 않습니다. kubelet은 quota의 하한을 1000(1ms)으로 두므로 10m보다 작은 limit은 모두 `1000 100000`이 됩니다.

### 2-3. requests.cpu는 shares를 거쳐 cpu.weight가 된다

`cpu.weight`는 1~10000 범위의 상대 가중치이고 기본값은 100입니다. CPU가 남을 때는 아무 의미가 없고 여러 cgroup이 CPU를 두고 다툴 때 나눠 갖는 비율을 정합니다. kubelet은 cgroup v1 시절부터 쓰던 `cpu.shares` 단위로 값을 계산합니다.

```text
shares = 밀리코어 × 1024 / 1000      (최소 2)
100m → 102 shares
1000m → 1024 shares
```

kubelet은 shares까지만 계산하고 이를 weight로 바꾸는 일은 OCI 런타임이 합니다. 이 변환식이 2025~2026년에 바뀌었습니다. 쿠버네티스 블로그(2026-01-30)가 정리한 두 식은 아래와 같습니다.

```text
옛 선형식 (KEP-2254)
  weight = 1 + ((shares - 2) × 9999) / 262142

새 이차식 (opencontainers/cgroups ConvertCPUSharesToCgroupV2Value)
  L = log2(shares)
  weight = ceil(10^((L² + 125L) / 612 - 7/34))
```

| CPU request | shares | 옛 식 weight | 새 식 weight |
|---|---|---|---|
| 100m | 102 | 4 | 17 |
| 1000m | 1024 | 39 | 약 100 (블로그 표는 102) |

옛 식은 shares 2~262144를 weight 1~10000에 직선으로 펼칩니다. 그래서 request 1 CPU가 기본 weight 100의 40%도 안 되는 39를 받았습니다. 쿠버네티스 밖에서 기본 weight 100으로 도는 시스템 프로세스와 경쟁하면 파드가 불리했던 이유입니다. 새 식은 (2, 1), (1024, 100), (262144, 10000) 세 점을 지나게 만들어 1 CPU가 기본값 100 근처로 오게 했습니다. 식에 L = 10을 넣으면 정확히 100이 나옵니다. 블로그 표의 102와 다른 까닭은 확인하지 못했습니다.

새 식은 runc 1.3.2(2025-10-02)와 1.4.0, crun 1.23부터 들어 있습니다. runc 1.3.0과 1.3.1에는 옛 식이 남아 있습니다. 같은 쿠버네티스 버전이어도 노드의 런타임 버전에 따라 `cpu.weight`가 4로도 17로도 나올 수 있습니다.

파드 cgroup 위의 QoS 계층에도 weight가 붙습니다. kubelet은 노드에 있는 Burstable 파드들의 CPU request를 모두 더해 `kubepods-burstable.slice`의 shares를 정하고 파드가 들어오고 나갈 때마다 다시 계산합니다. BestEffort 계층은 항상 2 shares(최솟값)입니다.

kind 실측(v1.37.0, runc 1.4.3)에서는 계층마다 다른 식이 보였습니다. request 100m 컨테이너의 scope는 새 식 값 17이었고 request 50m 컨테이너의 scope는 11이었습니다. 같은 50m 파드의 파드 slice `cpu.weight`는 옛 식 값 2였고 pause 컨테이너 scope는 1이었습니다. BestEffort 계층은 1, Burstable 계층은 Burstable 파드를 하나 더 띄우자 8에서 10으로 바뀌었습니다. 컨테이너 scope는 runc가 쓰고 파드 slice와 QoS slice는 kubelet이 씁니다. kubelet 쪽 변환 경로를 소스에서 직접 추적하지는 않았으니 노드에서 계층별로 읽어 보는 편이 확실합니다.

### 2-4. limits.memory는 바이트 단위 memory.max가 된다

`Mi`는 1024 기반입니다. 170Mi는 170 × 1,048,576 = 178,257,920바이트이고 `memory.max`에 이 숫자가 그대로 들어갑니다. `M`(1000 기반)으로 쓰면 170M = 170,000,000바이트라서 약 4.86% 작습니다. 한도를 넉넉하게 잡았다고 생각했는데 단위 하나 때문에 8MiB 넘게 모자랄 수 있습니다.

커널은 `memory.max`를 페이지 크기 단위로 다룹니다. x86_64에서 페이지는 4KiB이고 arm64는 커널 설정에 따라 16KiB나 64KiB 페이지를 쓰기도 합니다. Mi 단위 값은 어느 쪽이든 나누어떨어집니다.

### 2-5. requests.memory가 쓰이는 세 곳

기본 설정에서 `requests.memory`는 어떤 cgroup 파일에도 들어가지 않습니다. `memory.min`이나 `memory.low`로 바뀐다고 설명하는 자료가 있는데 이건 `MemoryQoS` 기능 게이트를 켰을 때 이야기입니다.

| 버전 | MemoryQoS 상태 |
|---|---|
| 1.22 | 알파로 도입, 기본 꺼짐 |
| 1.36 | 여전히 알파, 기본 꺼짐. 게이트는 `memory.high` 스로틀링만 켜고 `memory.min`/`memory.low` 보호는 kubelet 설정 `memoryReservationPolicy`(기본값 None)로 따로 켬. 켜면 Guaranteed에는 `memory.min`, Burstable에는 `memory.low`가 걸림 |

그러니 일반 클러스터에서 `requests.memory`가 실제로 영향을 주는 곳은 세 군데입니다.

- 스케줄러: 노드의 allocatable에서 이미 놓인 파드들의 request 합을 뺀 만큼만 새 파드를 받습니다.
- `oom_score_adj`: Burstable 컨테이너의 점수를 request 비율로 계산합니다(6장).
- kubelet eviction: 노드 메모리가 부족할 때 사용량이 request를 넘는 파드부터 내보냅니다(4장).

커널이 실제로 막는 메모리 한도는 `limits.memory`에서 온 `memory.max` 하나입니다.

### 2-6. systemd 드라이버의 cgroup 경로

kubelet과 containerd가 systemd cgroup 드라이버를 쓰면 경로가 slice 이름으로 만들어집니다. kubelet은 파드 UID의 `-`를 `_`로 바꿔 slice 이름에 넣습니다(`cgroup_manager_linux.go`).

```text
/sys/fs/cgroup/
└── kubepods.slice/
    ├── kubepods-pod<uid>.slice/                       ← Guaranteed 파드는 바로 아래
    │   └── cri-containerd-<container-id>.scope
    ├── kubepods-burstable.slice/
    │   └── kubepods-burstable-pod<uid>.slice/         ← order-api는 여기
    │       ├── cri-containerd-<pause-id>.scope
    │       └── cri-containerd-<container-id>.scope    ← cpu.max, memory.max가 있는 곳
    └── kubepods-besteffort.slice/
        └── kubepods-besteffort-pod<uid>.slice/
```

kind 노드는 kubelet의 `cgroupRoot`가 `/kubelet`이라 트리 맨 위가 `kubelet.slice/kubelet-kubepods.slice/`이고 그 아래 이름에도 `kubelet-` 접두어가 붙습니다(kind 실측: `kubelet-kubepods-burstable.slice/kubelet-kubepods-burstable-pod<uid>.slice/cri-containerd-<id>.scope`). 파드 UID가 `1234-abcd-5678-efgh`라면 일반 kubeadm 노드에서 slice 이름은 `kubepods-burstable-pod1234_abcd_5678_efgh.slice`입니다. cgroupfs 드라이버를 쓰면 `/kubepods/burstable/pod<uid>/<container-id>` 모양이 됩니다. 컨테이너 한도는 `.scope` 디렉터리에, 파드 전체 한도(컨테이너 limit의 합)는 그 위 파드 slice에 걸립니다. 맨 위 `kubepods.slice`에도 노드 allocatable을 기준으로 한 한도가 걸립니다.

**직접 해 보기**

- 노드에서 `systemd-cgls --unit kubepods.slice`로 트리를 봅니다. kind는 노드 컨테이너 안에서 kubelet을 돌리므로 `docker exec -it kind-control-plane bash`로 들어가서 봅니다. kind v0.33에서는 unit 이름이 `kubelet-kubepods.slice`라 `systemd-cgls --unit kubelet-kubepods.slice --no-pager`로 봐야 트리가 나옵니다. 경로가 다를 수 있으니 `find /sys/fs/cgroup -maxdepth 3 -name '*kubepods*' -type d`로 먼저 위치를 찾습니다.
- 같은 파드의 `cpu.weight`를 읽고 노드의 `runc --version`과 함께 기록합니다. 4가 나오면 옛 식, 17이 나오면 새 식입니다.
- `kubepods-burstable.slice/cpu.weight`를 읽고 Burstable 파드를 하나 더 띄운 뒤 다시 읽어 값이 바뀌는지 봅니다.

## 3. memory.max 초과에서 OOMKilled까지

### 3-1. memory.current가 세는 메모리

cgroup v2 메모리 컨트롤러는 그 cgroup에 charge된 메모리를 모두 `memory.current`에 셉니다. `memory.max`와 비교되는 값이 바로 이것입니다. `memory.stat`에서 항목별로 나눠 볼 수 있습니다.

| 분류 | `memory.stat` 항목 예 | 들어가는 것 |
|---|---|---|
| 익명 메모리 | `anon` | 힙, 스택, malloc, JVM 힙과 다이렉트 버퍼 |
| 파일 페이지 | `file`, `active_file`, `inactive_file` | 컨테이너가 읽고 쓴 파일의 페이지 캐시 |
| 커널 메모리 | `kernel`, `slab`, `kernel_stack`, `pagetables`, `sock` | 커널 객체, 페이지 테이블, 소켓 버퍼 |
| 공유 메모리 | `shmem` | tmpfs(`emptyDir.medium: Memory` 포함), `/dev/shm` |

RSS는 프로세스가 지금 물리 메모리에 올려 둔 페이지 수입니다. 페이지 캐시와 커널 메모리는 RSS에 들어가지 않으니 RSS가 한도보다 작아도 `memory.current`는 한도에 닿을 수 있습니다. 공유 페이지는 처음 건드린 cgroup에 charge됩니다.

페이지 캐시가 많다고 바로 위험하지는 않습니다. 깨끗한 파일 페이지는 회수할 수 있어서 한도에 가까워지면 커널이 먼저 비웁니다. 회수할 수 없는 익명 메모리와 tmpfs가 한도를 채울 때 OOM이 납니다.

### 3-2. reclaim, cgroup OOM, memory.oom.group

커널 문서의 `memory.max` 설명은 이렇습니다. "If a cgroup's memory usage reaches this limit and can't be reduced, the OOM killer is invoked in the cgroup." 순서를 풀면 아래와 같습니다.

```text
할당 요청으로 memory.current가 memory.max에 닿음
  → cgroup 안에서 직접 회수(페이지 캐시 비우기, 스왑이 있으면 스왑 아웃)
  → 회수로 공간을 만들면 할당 성공, 계속 실행
  → 회수 실패 → memory.events의 oom 증가
  → cgroup 범위 OOM killer 실행: 이 cgroup 안의 프로세스 중에서 희생자 선택
  → memory.oom.group이 1이면 cgroup 안의 모든 프로세스를 함께 종료
  → memory.events의 oom_kill(죽인 프로세스 수), oom_group_kill 증가
```

cgroup OOM의 희생자는 그 cgroup 안에서만 고릅니다. 노드에 메모리가 남아 있어도 컨테이너 한도를 넘으면 죽습니다.

cgroup v2 노드에서 kubelet은 컨테이너 cgroup에 `memory.oom.group`을 켭니다. 컨테이너 안에 워커 프로세스가 여럿 있을 때 하나만 죽어 컨테이너가 어정쩡하게 살아남는 상황을 막으려는 설정입니다. kubelet 설정 `singleProcessOOMKill`(기본 false)을 true로 두면 예전처럼 프로세스 하나만 죽입니다.

쿠버네티스 문서는 한 가지를 더 적습니다. 컨테이너는 메모리 압박이 감지될 때만 종료되므로 한도를 넘은 순간 바로 죽지 않을 수 있습니다. 회수할 수 있는 캐시가 남아 있으면 커널은 회수로 버팁니다.

### 3-3. memory.events와 커널 로그

`memory.events`의 형식은 이렇습니다(커널 문서 항목 기준 예시).

```text
low 0
high 0
max 1532
oom 3
oom_kill 3
oom_group_kill 3
```

`max`는 사용량이 한도에 닿아 회수를 시작한 횟수입니다. 이 값만 늘고 `oom`이 0이면 회수로 버티는 중입니다. `oom`은 회수에 실패해 할당이 실패하려던 횟수이고 `oom_kill`은 OOM killer가 죽인 프로세스 수입니다. 하위 cgroup의 이벤트까지 합친 값이라서 그 cgroup 자체의 값만 보려면 `memory.events.local`을 읽습니다.

커널 로그(`dmesg`, `journalctl -k`)에는 `mm/oom_kill.c`가 남기는 줄이 찍힙니다. cgroup 한도로 죽었으면 머리에 `Memory cgroup out of memory`가, 노드 전체 부족으로 죽었으면 `Out of memory`가 붙습니다.

```text
Memory cgroup out of memory: Killed process 4123 (stress) total-vm:..., anon-rss:..., file-rss:..., shmem-rss:..., UID:0 pgtables:... oom_score_adj:...
```

같은 메시지 앞에는 어느 cgroup에서 일어났는지(`oom-kill:constraint=CONSTRAINT_MEMCG,...,oom_memcg=...,task_memcg=...`)와 그 cgroup의 메모리 통계가 함께 찍힙니다. `oom_memcg`는 한도에 닿은 cgroup이고 `task_memcg`는 죽은 프로세스가 속한 cgroup입니다. `oom_memcg`가 `kubepods.slice`이면 파드들의 합이 allocatable을 넘은 경우입니다.

8-1의 oom-lab을 kind에서 돌린 실측 로그는 이랬습니다(경로의 해시는 줄임).

```text
stress invoked oom-killer: gfp_mask=0xcc0(GFP_KERNEL), order=0, oom_score_adj=994
oom-kill:constraint=CONSTRAINT_MEMCG,...,oom_memcg=/docker/<id>/kubelet.slice/kubelet-kubepods.slice/kubelet-kubepods-burstable.slice/kubelet-kubepods-burstable-pod91c7....slice,task_memcg=/docker/<id>/kubelet.slice/.../kubelet-kubepods-burstable-pod91c7....slice/cri-containerd-8ef9....scope,task=stress,pid=2642595,uid=0
Memory cgroup out of memory: Killed process 2642595 (stress) total-vm:507464kB, anon-rss:129492kB, file-rss:0kB, shmem-rss:0kB, UID:0 pgtables:352kB oom_score_adj:994
Tasks in /docker/<id>/.../cri-containerd-8ef9....scope are going to be killed due to memory.oom.group set
```

컨테이너가 하나뿐인 파드는 파드 slice의 `memory.max`도 컨테이너 limit과 같은 128Mi라서 `oom_memcg`가 파드 slice로 찍혔습니다. 그래서 `oom_memcg`만으로 컨테이너 한도인지 파드 한도인지 가르기는 어렵습니다. 경로 앞의 `/docker/<id>/`는 kind 노드 컨테이너의 cgroup이고 일반 노드에서는 없습니다. `memory.oom.group` 때문에 같은 scope의 stress 부모 프로세스도 함께 죽었습니다.

### 3-4. Exit 137과 reason OOMKilled

`kubectl describe pod`에는 아래 모양으로 남습니다.

```text
    Last State:     Terminated
      Reason:       OOMKilled
      Exit Code:    137
```

137은 128 + 9입니다. 셸과 컨테이너 런타임은 시그널 N으로 끝난 프로세스의 종료 코드를 128 + N으로 보고하는 관례를 따르고 9는 SIGKILL입니다. 이 숫자는 관례일 뿐이라 프로세스가 직접 `exit(137)`을 호출해도 똑같이 137이 나옵니다. 그래서 OOM 여부는 `Reason: OOMKilled`와 커널 로그로 판단합니다. 종료 코드 137에 Reason이 `Error`라면 liveness probe 실패 뒤 유예 시간이 지나 SIGKILL을 받은 경우처럼 OOM과 무관한 원인을 먼저 의심합니다.

### 3-5. CrashLoopBackOff 재시작 간격 10초~300초

OOMKilled가 반복되면 파드는 `CrashLoopBackOff`가 됩니다. kubelet은 재시작 사이에 기다리는 시간을 10초에서 시작해 두 배씩 늘리고 300초(5분)에서 멈춥니다. 컨테이너가 10분 동안 문제없이 돌면 간격이 처음으로 돌아갑니다.

이 상한을 바꾸는 기능이 두 가지 있습니다.

| 기능 게이트 | 상태 | 내용 |
|---|---|---|
| `ReduceDefaultCrashLoopBackOffDecay` (KEP-4603) | 1.33 알파, 기본 꺼짐 | 켜면 1초에서 시작해 최대 60초 |
| `KubeletCrashLoopBackOffMax` (KEP-5593) | 1.35 베타, 기본 켜짐 | 노드별 kubelet 설정 `crashLoopBackOff.maxContainerRestartPeriod`로 상한을 1초~300초 사이에서 지정 |

kind 실측에서 oom-lab의 시작 시각은 07:11:01, 07:11:17, 07:11:48이었습니다. 간격이 10초, 20초보다 몇 초씩 긴 것은 `polinux/stress`에 태그가 없어 `imagePullPolicy`가 `Always`가 되고 재시작마다 이미지를 다시 받았기 때문입니다(이벤트에 매번 `Pulled ... in 1.7s~3.4s`가 남음).

**직접 해 보기**

- 실행 중인 컨테이너에서 `cat /sys/fs/cgroup/memory.stat | head -20`으로 `anon`과 `file` 비율을 보고 `dd if=/dev/zero of=/tmp/f bs=1M count=50` 뒤 `file`이 늘어나는지 확인합니다. `/tmp`가 tmpfs가 아니면 `file`이, tmpfs면 `shmem`이 늘어납니다. kind의 busybox:1.36 컨테이너(`/tmp`는 overlay 쓰기 계층)에서 실측하니 `file`이 2236416에서 54874112로 약 50MiB 늘었고 `anon`과 `shmem`은 그대로였습니다.
- `cat /sys/fs/cgroup/memory.oom.group`이 1인지 확인합니다.
- 8장의 OOM 과제를 돌린 뒤 `memory.events`의 `oom_kill`과 `kubectl get pod`의 RESTARTS를 비교합니다.

## 4. 세 종류의 메모리 부족: cgroup OOM, 노드 OOM, eviction

### 4-1. 주체와 증상으로 구분하기

"메모리 때문에 파드가 죽었다"는 말 아래에는 서로 다른 세 사건이 있습니다.

| 구분 | 누가 결정하나 | 언제 | 대상 선택 | 파드에 남는 흔적 |
|---|---|---|---|---|
| cgroup OOM | 커널 | 컨테이너(또는 파드, kubepods) cgroup이 `memory.max`에 닿고 회수 실패 | 그 cgroup 안의 프로세스 | `OOMKilled`, 재시작, 커널 로그 `Memory cgroup out of memory` |
| 노드 전체 OOM | 커널 | 노드 전체 메모리가 바닥나 커널 할당 실패 | 노드의 모든 프로세스 중 `oom_score`가 가장 높은 것 | 컨테이너가 죽었다면 `OOMKilled`로 보일 수 있음, 커널 로그 `Out of memory` |
| kubelet eviction | kubelet | `memory.available`이 eviction 임계값 아래로 내려감 | 4-3의 순위 | 파드가 `Failed`, `Reason: Evicted`, 다른 노드로 다시 만들어짐(컨트롤러가 있을 때) |

eviction은 OOM을 피하려고 kubelet이 미리 하는 일입니다. kubelet은 주기적으로 메모리를 보기 때문에 사용량이 짧은 시간에 치솟으면 eviction보다 커널 OOM이 먼저 일어날 수 있습니다. 노드 OOM에서 누가 먼저 죽는지를 정하는 값이 6장의 `oom_score_adj`입니다.

### 4-2. eviction의 memory.available은 working set 기준

kubelet이 보는 `memory.available`은 cgroupfs에서 구한 값입니다. 노드 압박 eviction 문서의 정의는 이렇습니다.

```text
memory.available := node.status.capacity[memory] - node.stats.memory.workingSet
```

working set은 cgroupfs에서 구한 사용량에서 `inactive_file`(곧 회수할 수 있는 파일 페이지)을 뺀 값입니다. 그래서 `free` 명령이나 `/proc/meminfo`의 `MemAvailable`과 숫자가 다르게 나올 수 있습니다. 리눅스에서 기본 hard eviction 임계값은 `memory.available<100Mi`입니다. hard 임계값에 걸리면 kubelet은 유예 시간 없이 파드를 종료합니다.

`kubectl top`이 보여 주는 메모리도 working set입니다. 그래서 `kubectl top`의 메모리는 `memory.current`보다 작게 나오고 OOM 판단에 쓰이는 값과도 정확히 같지 않습니다.

### 4-3. eviction 순위

kubelet은 메모리 압박에서 파드를 아래 순서로 고릅니다(노드 압박 eviction 문서 기준).

1. 메모리 사용량이 request를 넘는지
2. 파드 Priority
3. request 대비 사용량이 얼마나 큰지

BestEffort 파드는 request가 0이라 쓰는 순간 1번 조건에 걸립니다. Guaranteed 파드와 사용량이 request 안쪽인 Burstable 파드는 뒤로 밀립니다. QoS 클래스 이름이 순위에 직접 들어가지는 않지만 request 설정 방식이 곧 QoS를 정하므로 결과는 QoS 순서와 비슷하게 나옵니다.

**직접 해 보기**

- 노드에서 `cat /sys/fs/cgroup/kubepods.slice/memory.stat | grep -E '^(anon|file|inactive_file) '`를 읽고 `memory.current - inactive_file`을 직접 계산해 `kubectl top node`의 값과 비교합니다.
- `kubectl get --raw "/api/v1/nodes/<노드>/proxy/configz" | jq .kubeletconfig.evictionHard`로 노드의 eviction 임계값을 확인합니다. kind 노드는 `{"imagefs.available":"0%","nodefs.available":"0%","nodefs.inodesFree":"0%"}`로 나왔습니다. kind가 디스크 eviction을 꺼 두고 메모리 항목은 지정하지 않은 설정이라 리눅스 기본값과 다릅니다. kind에서는 첫 번째 과제의 경로도 `/sys/fs/cgroup/kubelet.slice/kubelet-kubepods.slice/memory.stat`입니다.

## 5. CPU 스로틀링 관찰

### 5-1. cpu.stat 필드

CPU 한도 초과는 이벤트를 남기지 않습니다. 기록은 `cpu.stat`에만 있습니다(커널 문서 기준 형식).

```text
usage_usec 81273901
user_usec 60218733
system_usec 21055168
nr_periods 48211
nr_throttled 9310
throttled_usec 512094377
```

| 필드 | 뜻 |
|---|---|
| `usage_usec` | 지금까지 쓴 CPU 시간 합 |
| `nr_periods` | 지나간 대역폭 집행 주기 수 |
| `nr_throttled` | 그중 quota를 다 써서 멈춘 주기 수 |
| `throttled_usec` | 멈춰 있던 시간의 합 |

뒤의 세 필드는 cpu 컨트롤러가 켜져 있을 때만 나오고 fair 스케줄링 클래스의 태스크만 셉니다. 커널 6.6부터 fair 클래스 안에서 다음 태스크를 고르는 정책은 EEVDF로 바뀌는 중이지만 `cpu.max`를 집행하는 대역폭 제어(CFS bandwidth control)는 그대로 있습니다. 메트릭 이름에 남은 `cfs`도 이 기능을 가리킵니다.

cAdvisor(kubelet에 내장)는 같은 값을 Prometheus 메트릭으로 내보냅니다.

| cAdvisor 메트릭 | `cpu.stat` 필드 |
|---|---|
| `container_cpu_cfs_periods_total` | `nr_periods` |
| `container_cpu_cfs_throttled_periods_total` | `nr_throttled` |
| `container_cpu_cfs_throttled_seconds_total` | `throttled_usec` (초 단위) |

### 5-2. 평균 사용률이 낮아도 스로틀링이 생기는 경우

quota는 period 안에서 모든 CPU의 사용 시간을 합쳐 셉니다. limit이 1 CPU(`100000 100000`)인 컨테이너에서 스레드 네 개가 동시에 일을 시작하는 장면을 그려 보겠습니다.

```text
period 100ms, quota 100ms, 스레드 4개가 동시에 실행
0ms ~ 25ms   : 4개 스레드 × 25ms = 100ms 소진 → quota 끝
25ms ~ 100ms : 스로틀링. 75ms 동안 아무 스레드도 실행 못 함
100ms        : 다음 period, quota 다시 100ms
```

이 컨테이너의 평균 사용량은 1 CPU 이하라서 사용률 그래프로는 한도에 닿은 것처럼 보이지 않을 수 있습니다. 그런데 요청 하나가 25ms 지점에서 시작하면 75ms를 그냥 기다립니다. JVM의 GC 스레드나 요청 처리 스레드 풀처럼 짧은 시간에 여러 스레드가 몰리는 애플리케이션에서 p99 지연이 튀는 원인이 됩니다.

### 5-3. 스로틀 비율 계산

아래 숫자는 설명을 위한 가상의 값입니다. 두 시점에 `cpu.stat`을 읽고 차이를 냅니다.

```text
시점 A: nr_periods 120000  nr_throttled 18000  throttled_usec 900000000
시점 B: nr_periods 126000  nr_throttled 21000  throttled_usec 1080000000  (10분 뒤)

구간 주기 수        = 126000 - 120000 = 6000
구간 스로틀 주기 수 = 21000 - 18000   = 3000
스로틀 비율         = 3000 / 6000     = 50%
구간 스로틀 시간    = 180000000µs     = 180초
스로틀된 주기당 평균 대기 = 180초 / 3000 = 60ms
```

10분은 100ms 주기로 6000개라서 이 컨테이너는 구간 내내 실행할 일이 있었습니다. 그 주기의 절반에서 quota를 다 써서 멈췄고 멈출 때마다 평균 60ms를 기다렸습니다. 100ms 주기에서 60ms를 기다렸다면 요청 지연에 바로 드러나는 크기입니다.

Prometheus에서는 같은 계산을 이렇게 씁니다.

```promql
sum by (namespace, pod, container) (rate(container_cpu_cfs_throttled_periods_total{namespace="shop"}[5m]))
/
sum by (namespace, pod, container) (rate(container_cpu_cfs_periods_total{namespace="shop"}[5m]))
```

### 5-4. kubectl top이 보여 주는 범위

`kubectl top`은 metrics-server가 kubelet에서 모은 CPU와 메모리 사용량을 보여 줍니다. metrics-server는 기본 15초 간격으로 수집하고 그 구간의 평균 사용률을 냅니다. 100ms 단위로 quota를 다 쓰고 멈추는 패턴은 15초 평균에 묻히고 스로틀 횟수 자체는 Metrics API에 들어 있지 않습니다. metrics-server README도 이 데이터를 오토스케일링용으로 소개하고 모니터링 용도로 쓰지 말라고 적습니다. 스로틀링은 `cpu.stat`이나 cAdvisor 메트릭으로 봅니다.

**직접 해 보기**

- 8장의 CPU 과제에서 `cpu.stat`을 10초 간격으로 두 번 읽고 5-3의 방식으로 비율을 계산합니다.
- 같은 시간에 `kubectl top pod`을 실행해 CPU 값이 50m 근처에 붙어 있는지 봅니다. 사용량은 한도에 붙어 있는데 스로틀 비율은 높게 나오는 조합을 확인하는 것이 목표입니다.

## 6. QoS 클래스와 oom_score_adj

### 6-1. QoS 클래스 판정

kubelet은 파드의 requests와 limits로 QoS 클래스를 정하고 `status.qosClass`에 적습니다.

| 클래스 | 조건 |
|---|---|
| Guaranteed | 모든 컨테이너가 CPU와 메모리 둘 다 limit을 갖고 request가 limit과 같음(request를 생략하면 limit 값으로 채워짐) |
| Burstable | Guaranteed가 아니고 적어도 한 컨테이너에 CPU나 메모리 request 또는 limit이 있음 |
| BestEffort | 어느 컨테이너에도 request와 limit이 없음 |

### 6-2. 클래스별 oom_score_adj

커널은 OOM 희생자를 고를 때 프로세스마다 badness 점수를 계산합니다. 메모리 사용량 비율을 0~1000으로 환산한 값에 `oom_score_adj`(-1000~+1000)를 더합니다. 결과는 `/proc/<pid>/oom_score`로 보이고 커널 문서상 범위는 0~2000입니다. `oom_score_adj`가 -1000이면 OOM kill 대상에서 완전히 빠집니다.

kubelet은 컨테이너 프로세스에 아래 값을 줍니다(노드 압박 eviction 문서와 `pkg/kubelet/qos/policy.go` 기준).

| 대상 | `oom_score_adj` |
|---|---|
| BestEffort 컨테이너 | 1000 |
| Burstable 컨테이너 | `min(max(2, 1000 - (1000 × 메모리 request) / 노드 메모리 용량), 999)`, kubelet 코드는 하한을 3으로 둠 |
| Guaranteed 컨테이너, `system-node-critical` 파드 | -997 |
| kubelet | -999 (`KubeletOOMScoreAdj`) |
| containerd | -999 (`containerd.service`의 `OOMScoreAdjust=-999`) |

문서의 공식은 하한이 2입니다. 실제 kubelet 코드는 계산 결과가 `1000 + guaranteedOOMScoreAdj`, 즉 3보다 작으면 3으로 올립니다. Burstable이 Guaranteed(-997)보다 항상 높은 점수를 받게 하는 처리입니다. 결과가 1000이면 999로 내려 BestEffort(1000)보다 한 칸 낮게 둡니다.

### 6-3. Burstable 점수 계산 예

메모리 용량 8GiB 노드에 `order-api`(request 128Mi)가 놓였다고 하겠습니다.

```text
1000 × 128Mi / 8192Mi = 15.625 → 정수 나눗셈으로 15
oom_score_adj = 1000 - 15 = 985
```

request를 2Gi로 올리면 1000 - 250 = 750입니다. request가 클수록 점수가 낮아져 노드 OOM에서 늦게 죽습니다. request를 노드 메모리 용량만큼 잡으면 계산값은 0이지만 하한 때문에 3이 됩니다.

이 점수는 노드 전체 OOM이나 `kubepods.slice` 수준 OOM처럼 여러 파드의 프로세스가 한 후보군에 들어갈 때 의미가 있습니다. 컨테이너 자기 한도로 생긴 cgroup OOM에서는 후보가 그 컨테이너 안의 프로세스뿐이라 모두 같은 값을 갖습니다. 거기에 `memory.oom.group`이 켜져 있으면 어차피 전부 함께 죽습니다.

### 6-4. kubelet과 containerd가 -999인 이유

QoS 설계 문서(resource-qos 제안서)는 이 값을 이렇게 설명합니다.

> Kubelet, Docker: OOM_SCORE_ADJ: -999 (won't be OOM killed). Hack, because these critical tasks might die if they conflict with guaranteed containers. In the future, we should place all user-pods into a separate cgroup, and set a limit on the memory they can consume.
>
> 출처: kubernetes/design-proposals-archive, node/resource-qos.md

Guaranteed 컨테이너와 노드 데몬이 메모리를 두고 다투면 데몬이 먼저 죽을 수 있으니 Guaranteed보다 한 칸 낮은 값을 준 것입니다. 문서 스스로 임시방편(hack)이라 부르고 사용자 파드를 별도 cgroup에 넣어 한도를 거는 쪽을 장기 방향으로 적었습니다. 지금의 `kubepods.slice`와 Node Allocatable이 그 방향으로 만들어진 구조입니다. -1000을 쓰지 않은 이유는 설계 문서에 따로 적혀 있지 않습니다.

### 6-5. PID 1이 OOM에서 살아남는 방식

노드의 PID 1(systemd)은 `oom_score_adj`가 보통 0입니다. 그래도 OOM에서 살아남는 이유는 커널 `mm/oom_kill.c`의 `oom_unkillable_task()`가 `is_global_init()`인 태스크를 후보에서 아예 빼기 때문입니다. 컨테이너 안의 PID 1은 자기 PID 네임스페이스에서만 1번이고 호스트에서 보면 평범한 프로세스입니다. 그래서 OOM 대상이 됩니다.

### 6-6. QoS 클래스는 생성 후 고정

QoS 클래스는 파드가 만들어질 때 정해지고 바뀌지 않습니다. in-place resize로 CPU나 메모리 값을 바꿀 때도 QoS 클래스가 바뀌는 변경은 API 서버가 거부합니다. 예를 들어 Guaranteed 파드의 limit만 올려 request와 달라지게 하는 요청은 거부됩니다. 클래스를 바꾸려면 파드를 새로 만들어야 합니다.

**직접 해 보기**

- 같은 노드에 BestEffort, Burstable, Guaranteed 파드를 하나씩 띄우고 각 컨테이너에서 `cat /proc/1/oom_score_adj`를 읽습니다. Burstable 값은 노드 메모리 용량(`kubectl get node -o jsonpath='{.status.capacity.memory}'`)으로 직접 계산한 값과 비교합니다.
- 노드에서 `cat /proc/$(pidof kubelet)/oom_score_adj`, `cat /proc/$(pidof containerd)/oom_score_adj`, `cat /proc/1/oom_score_adj`를 읽습니다.

kind 실측(노드 메모리 용량 10161128Ki)은 이랬습니다. BestEffort 컨테이너 1000, memory request가 없는 Burstable 컨테이너 999, memory request 64Mi인 Burstable 컨테이너 994, Guaranteed 컨테이너 -997이었습니다. 64Mi는 1000 - (1000 × 67108864) / 10404995072 = 1000 - 6 = 994로 공식과 같습니다. kubelet, containerd, kube-proxy 컨테이너는 -999, pause 컨테이너는 -998, 노드 컨테이너의 PID 1(systemd)은 0이었습니다.

## 7. 사례: JVM 서비스의 OOMKilled 포스트모템

### 7-1. 무엇이 일어났나

싱가포르의 자산관리 서비스 Endowus의 엔지니어링 블로그에 Harry Tran이 2023-12-14에 올린 "Understanding and Resolving OOMKilled errors in JVM microservices"는 이 글의 3장을 실제 장애로 보여 줍니다. 아래 숫자는 모두 원문에서 가져왔습니다.

| 항목 | 값 |
|---|---|
| 서비스 | `rebalance` |
| 컨테이너 메모리 한도 | 6GB |
| 힙 설정 | `-XX:MaxRAMPercentage=80` (최대 힙 4.8GB) |
| OOMKilled 직전 힙 사용량 최고치 | 4.37GB |
| 힙 밖에서 쓰인 것으로 보이는 메모리 | 약 1.63GB (6GB - 4.37GB) |

힙은 한도 4.8GB에 닿지도 않았습니다. 그런데도 컨테이너는 6GB 한도로 죽었습니다. JVM이 보여 주는 힙 지표만 보면 설명이 안 되는 장애였습니다.

### 7-2. 힙 밖에서 찾은 세 가지 버퍼

팀은 JVM 지표, Native Memory Tracking(`-XX:NativeMemoryTracking=summary`, `jcmd 1 VM.native_memory`), 힙 덤프를 VisualVM에서 OQL로 분석하는 순서로 힙 밖 메모리를 추적했습니다. JVM 지표가 보여 준 힙 외 사용량을 다 더해도 1.63GB에 못 미쳤고 NMT로 GC 내부 할당 등을 더 찾았습니다. 다이렉트 버퍼(`java.nio.DirectByteBuffer`)를 뒤져 나온 큰 덩어리는 세 가지였습니다.

| 출처 | 크기 | 내용 |
|---|---|---|
| JDK JImage 리더 | 161,255,629바이트(약 153MB) 버퍼 하나 | JVM 시작 시 모듈 이미지를 읽으려고 할당. JVM 지표와 NMT 어디에도 보이지 않았음 |
| Cassandra Datastax 드라이버의 Netty `PooledByteBufAllocator` | 16MB 청크 × 16 아레나 = 약 256MB | 프로세서 수 × 2로 정해지는 기본 아레나 수를 아무도 바꾸지 않았음 |
| Akka Remote Artery의 `EnvelopeBuffer` 풀 | 버퍼 하나 30,000,000바이트, 최악의 경우 약 3.6GB | 과거의 큰 메시지 때문에 `maximum-frame-size`를 28MiB로 올려 둔 상태에서 `buffer-pool-size`가 기본 128 |

### 7-3. 조치와 결론

조치는 두 갈래였습니다. 하나는 서비스 부하에 따라 컨테이너 크기와 힙 비율을 나눈 것입니다. 가벼운 서비스는 2GB에 힙 50%, 부하가 큰 서비스는 4GB에 60%, 큰 메시지를 다루는 서비스는 8GB에 70%로 잡았습니다. 다른 하나는 Akka 설정입니다. 서비스마다 `maximum-frame-size`를 실제 메시지 크기에 맞추고 큰 메시지는 `large-message-destinations`로 따로 보냈습니다. `buffer-pool-size`는 `jvm_memory_buffer_pool_count` 지표를 근거로 128보다 훨씬 낮췄습니다. 몇 달에 걸쳐 단계적으로 배포한 뒤 OOMKill 빈도가 크게 줄었다고 적고 글은 이 문장으로 끝을 맺습니다.

> we feel we've really killed the OOMKilled, at least for now!
>
> 출처: Harry Tran, "Understanding and Resolving OOMKilled errors in JVM microservices", Endowus Tech Blog, 2023-12-14, https://build.endowus.com/oomkilled/

### 7-4. 앱이 보는 힙과 cgroup이 세는 메모리

이 사례를 3장에 겹치면 이렇게 정리됩니다. `-XX:MaxRAMPercentage`는 JVM이 cgroup의 `memory.max`를 읽어 힙 상한을 정하는 옵션입니다. 커널이 `memory.max`와 비교하는 `memory.current`에는 힙 말고도 다이렉트 버퍼, 메타스페이스, 스레드 스택, GC 자료구조, JIT 코드 캐시, 페이지 캐시가 함께 들어갑니다. 힙을 80%로 잡으면 나머지 20%로 이 모두를 감당해야 합니다.

| 관점 | 보이는 값 | 포함 범위 |
|---|---|---|
| JVM 힙 지표 | 4.37GB | 자바 객체 힙 |
| JVM 전체 지표, NMT | 힙 + 일부 네이티브 | JVM이 직접 추적하는 할당 |
| cgroup `memory.current` | 6GB에서 OOM | 그 cgroup에 charge된 모든 페이지 |

OOMKilled를 조사할 때 힙 그래프로 시작하면 이 사례처럼 "힙은 여유가 있었다"에서 멈추기 쉽습니다. 먼저 컨테이너의 `memory.stat`에서 `anon`, `file`, `kernel`, `shmem` 비율을 보고 `anon`이 크면 애플리케이션 안에서 힙과 힙 밖을 나눠 보는 순서가 시간을 아낍니다.

## 8. kind로 해 보는 과제

이 장의 명령은 2026-10-20에 kind v0.33(노드 v1.37.0, colima VM 커널 6.8.0-117-generic, arm64)에서 그대로 돌렸습니다. 각 절 끝에 실측 결과를 붙였습니다.

### 8-1. limit 128Mi 컨테이너에 200M 할당

쿠버네티스 문서 "Assign Memory Resources to Containers and Pods"의 예제와 같은 `polinux/stress` 이미지를 씁니다.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: oom-lab
  namespace: shop
spec:
  containers:
  - name: stress
    image: polinux/stress
    resources:
      requests:
        memory: 64Mi
      limits:
        memory: 128Mi
    command: ["stress"]
    args: ["--vm", "1", "--vm-bytes", "200M", "--vm-hang", "1"]
```

```bash
kubectl apply -f oom-lab.yaml
kubectl get pod -n shop oom-lab -w             # OOMKilled → CrashLoopBackOff 전환 관찰
kubectl describe pod -n shop oom-lab | grep -A4 'Last State'
kubectl get pod -n shop oom-lab -o jsonpath='{.status.qosClass}{"\n"}'   # Burstable
docker exec kind-control-plane dmesg | grep -i -A2 'memory cgroup out of memory'
```

확인할 것은 다섯 가지입니다.

- `Last State`가 `Reason: OOMKilled`, `Exit Code: 137`인지
- `kubectl get pod -w`에서 재시작 간격이 10초, 20초, 40초로 늘어나는지
- 커널 로그 머리가 `Memory cgroup out of memory`이고 `oom_memcg` 경로가 이 컨테이너 scope인지
- 로그 끝의 `oom_score_adj` 값이 6-2 공식으로 계산한 값과 같은지
- 컨테이너가 살아 있는 짧은 순간에 `kubectl exec`로 `memory.max`(134217728)와 `memory.events`를 읽을 수 있는지

kind 노드는 호스트 커널을 함께 씁니다. macOS의 Docker Desktop이나 colima라면 그 커널은 리눅스 VM의 것이고 `dmesg`에는 그 VM의 다른 컨테이너 기록도 섞여 나옵니다. colima에서는 `colima ssh -- sudo dmesg`로도 같은 로그를 봅니다.

kind 실측에서 앞의 네 항목은 확인했고 다섯 번째(`kubectl exec`로 읽기)는 컨테이너가 1초 남짓 살아 있어 하지 못했습니다. 그 대신 노드에서 파드 slice의 파일을 읽었습니다. 재시작 간격은 3-5에 적은 대로 이미지 다시 받기 시간이 더해졌습니다. 46초 뒤 `RESTARTS 2`, `Last State`는 `OOMKilled`와 `exitCode 137`이었고 커널 로그는 3-3에 옮긴 그대로였습니다. `oom_memcg`는 파드 slice로 찍혔고 그 이유는 3-3에 적었습니다. 파드 slice의 `memory.events`는 `max 180`, `oom 4`, `oom_kill 12`, `oom_group_kill 4`였습니다. `oom_kill`이 재시작 수보다 큰 것은 `memory.oom.group` 때문에 한 번에 stress 프로세스 여러 개가 함께 죽어서입니다.

### 8-2. cpu limit 50m에서 cpu.stat 관찰

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: throttle-lab
  namespace: shop
spec:
  containers:
  - name: spin
    image: busybox:1.36
    command: ["sh", "-c", "while :; do :; done"]
    resources:
      requests:
        cpu: 50m
        memory: 16Mi
      limits:
        cpu: 50m
        memory: 16Mi
```

```bash
kubectl apply -f throttle-lab.yaml
kubectl get pod -n shop throttle-lab -o jsonpath='{.status.qosClass}{"\n"}'   # Guaranteed
kubectl exec -n shop throttle-lab -- cat /sys/fs/cgroup/cpu.max                # 5000 100000
kubectl exec -n shop throttle-lab -- cat /sys/fs/cgroup/cpu.weight
kubectl exec -n shop throttle-lab -- cat /sys/fs/cgroup/cpu.stat
sleep 10
kubectl exec -n shop throttle-lab -- cat /sys/fs/cgroup/cpu.stat
kubectl exec -n shop throttle-lab -- cat /proc/1/oom_score_adj                 # -997
```

무한 루프는 모든 주기에서 5ms를 다 쓰고 95ms를 기다리므로 10초 동안 `nr_periods`와 `nr_throttled`가 거의 같은 폭(약 100)으로 늘고 `throttled_usec`는 약 9,500,000 늘어날 것으로 예상됩니다. 실제 값을 이 예상과 비교하고 차이가 나면 그 이유를 적어 봅니다. `cpu.weight`는 50m → 51 shares를 노드 런타임의 변환식에 넣은 값과 비교합니다.

kind 실측 결과입니다. QoS는 `Guaranteed`, `cpu.max`는 `5000 100000`, `cpu.weight`는 11(새 식 값. 옛 식이면 2), `oom_score_adj`는 -997이었습니다. 두 번의 `cpu.stat` 사이에 `kubectl exec` 왕복 시간이 더해져 실제 간격은 약 15초였습니다.

```text
                 첫 번째      두 번째      차이
usage_usec       2853795      3599328      745533
nr_periods       569          720          151
nr_throttled     541          685          144
throttled_usec   32648605     42534916     9886311
```

주기당 사용량은 745533 / 151 ≈ 4.9ms로 quota 5ms와 맞고 151개 주기 중 144개(95%)가 스로틀됐습니다. 스로틀된 주기 하나당 `throttled_usec`는 약 68.7ms로 예상한 95ms보다 짧았습니다. 이 차이의 원인은 확인하지 못했습니다.

## 확인 문제

1. `limits.cpu: 300m`인 컨테이너의 `cpu.max` 내용은 무엇입니까?

<details><summary>정답</summary>

`30000 100000`입니다. kubelet의 기본 period는 100000µs이고 quota는 300 × 100000 / 1000 = 30000입니다.

</details>

2. `requests.cpu: 100m`인 컨테이너의 `cpu.weight`가 노드 A에서는 4, 노드 B에서는 17로 나왔습니다. 무엇이 다를 가능성이 가장 큽니까?

<details><summary>정답</summary>

OCI 런타임 버전입니다. 100m은 102 shares이고 shares를 weight로 바꾸는 일은 런타임이 합니다. 옛 선형식은 4, runc 1.3.2 이상과 1.4, crun 1.23 이상의 새 이차식은 17을 냅니다.

</details>

3. 기본 설정의 쿠버네티스 1.36 클러스터에서 `requests.memory: 1Gi`는 어떤 cgroup 파일에 쓰입니까?

<details><summary>정답</summary>

어떤 파일에도 쓰이지 않습니다. `MemoryQoS`는 1.36에서도 알파이고 기본으로 꺼져 있습니다. 기본 설정에서 `requests.memory`는 스케줄링, Burstable 컨테이너의 `oom_score_adj` 계산, kubelet eviction 순위에 쓰입니다.

</details>

4. 컨테이너 안 프로세스들의 RSS 합은 100MiB인데 `limits.memory: 128Mi` 컨테이너가 OOMKilled 되었습니다. 어떤 메모리를 의심해야 합니까?

<details><summary>정답</summary>

`memory.current`에 들어가는 RSS 밖의 메모리입니다. tmpfs나 `emptyDir.medium: Memory`에 쓴 파일(`shmem`), 커널 메모리(소켓 버퍼, 페이지 테이블, slab)를 먼저 봅니다. 깨끗한 페이지 캐시는 회수할 수 있어서 단독 원인이 되기 어렵습니다. `memory.stat`으로 나눠 확인합니다.

</details>

5. 컨테이너가 Exit Code 137로 종료되었는데 Reason은 `Error`입니다. OOM으로 단정할 수 있습니까?

<details><summary>정답</summary>

단정할 수 없습니다. 137은 SIGKILL(128 + 9)로 끝났다는 관례적 표시일 뿐이고 프로세스가 `exit(137)`을 직접 호출해도 나옵니다. OOM이면 Reason이 `OOMKilled`로 표시되고 커널 로그에 OOM 기록이 남습니다. probe 실패 후 유예 시간이 지나 SIGKILL을 받은 경우 같은 다른 원인을 확인합니다.

</details>

6. 메모리 16GiB 노드에서 메모리 request 4Gi인 Burstable 컨테이너의 `oom_score_adj`는 얼마입니까?

<details><summary>정답</summary>

750입니다. 1000 - (1000 × 4 / 16) = 750이고 3~999 범위 안이라 그대로 쓰입니다.

</details>

7. `kubectl top pod`에서 CPU 사용량이 limit의 60% 수준인데 응답 지연이 큽니다. 무엇을 봐야 합니까?

<details><summary>정답</summary>

`cpu.stat`의 `nr_throttled`와 `throttled_usec`, 또는 `container_cpu_cfs_throttled_periods_total`을 `container_cpu_cfs_periods_total`로 나눈 비율입니다. `kubectl top`은 15초 단위 평균 사용량이라서 100ms 주기 안에서 여러 스레드가 quota를 몰아 쓰고 멈추는 스로틀링을 보여 주지 못합니다.

</details>

8. kubelet의 `oom_score_adj`가 -999인 이유를 QoS 설계 문서는 어떻게 설명합니까?

<details><summary>정답</summary>

Guaranteed 컨테이너와 메모리를 다툴 때 kubelet과 컨테이너 런타임 같은 핵심 데몬이 먼저 죽을 수 있어서 Guaranteed(-997)보다 낮은 값을 준 임시방편(hack)이라고 설명합니다. 장기적으로는 사용자 파드를 별도 cgroup에 넣어 한도를 거는 방향을 적었습니다.

</details>

## 범위와 한계

- 2026-10-20에 kind v0.33 + 노드 v1.37.0(colima, arm64, VM 커널 6.8.0-117-generic, Ubuntu 24.04.4, containerd 2.3.4, runc 1.4.3)에서 돌린 것: 2장의 cgroup 파일 값(`cpu.max`, `cpu.weight`, `memory.max`, `memory.oom.group`)과 계층별 weight, 3장의 `memory.stat`과 `dd`, 8-1 OOM 과제 전체(커널 로그, `memory.events`, 재시작 간격), 8-2 스로틀 과제, 6장의 QoS별 `oom_score_adj`, kubelet `configz`의 `evictionHard`. 5-3의 스로틀 비율 계산에 쓴 숫자는 설명용 가상 값이고 8-2의 실측과 다릅니다.
- 돌리지 못한 것: kind에는 metrics-server가 없어 `kubectl top`과 working set 비교(4장 과제)는 하지 않았습니다. 노드 전체 OOM과 eviction 재현, MemoryQoS, in-place resize 거부는 돌리지 않았습니다. kind 노드는 컨테이너라 cgroup 경로 앞에 `/docker/<id>/`와 `kubelet.slice`가 붙고 eviction 임계값도 일반 노드와 다릅니다.
- 버전 기준은 쿠버네티스 1.35~1.37, 리눅스 커널 6.x, cgroup v2 노드입니다. cgroup v1 노드는 파일 이름과 동작이 다릅니다.
- `cpu.weight` 변환은 노드의 runc나 crun 버전에 따라 다릅니다. 새 식으로 1 CPU를 계산하면 정확히 100이 나오는데 쿠버네티스 블로그 표에는 102로 적혀 있습니다. 이 차이의 이유는 확인하지 못했습니다.
- MemoryQoS와 `memoryReservationPolicy`의 동작은 1.36 블로그와 KEP-2570 기준입니다. 알파 기능이라 이후 버전에서 이름이나 기본값이 바뀔 수 있습니다.
- 노드 전체 OOM으로 컨테이너 프로세스가 죽었을 때도 런타임이 `OOMKilled`로 보고할 수 있다고 적은 부분은 커널이 희생자의 memcg에 `oom_kill` 이벤트를 남긴다는 점에서 추론한 것입니다. containerd 버전별 동작을 직접 확인하지는 않았습니다.
- `kubepods.slice`에 걸리는 한도의 정확한 계산식(kube-reserved, system-reserved, eviction 임계값 중 무엇을 빼는지)은 이 글에서 다루지 않았습니다. Node Allocatable 문서를 따로 확인해야 합니다.
- kind v0.33 노드 안의 cgroup 상위 경로는 `kubelet.slice/kubelet-kubepods.slice`라 2-6의 트리(kubeadm 노드 기준)와 이름이 다릅니다.
- Endowus 사례는 원문의 숫자와 결론만 옮겼습니다. 원문이 쓴 JVM 버전, 노드 사양, 조치 전후의 OOMKill 횟수는 이 글에 넣지 않았습니다.

## 참고 자료

- Linux kernel, Control Group v2: https://docs.kernel.org/admin-guide/cgroup-v2.html
- Linux kernel, CFS Bandwidth Control: https://docs.kernel.org/scheduler/sched-bwc.html
- Linux kernel, EEVDF Scheduler: https://docs.kernel.org/scheduler/sched-eevdf.html
- Linux kernel, The /proc Filesystem (oom_score, oom_score_adj): https://docs.kernel.org/filesystems/proc.html
- Linux kernel source, mm/oom_kill.c: https://github.com/torvalds/linux/blob/master/mm/oom_kill.c
- Kubernetes, Resource Management for Pods and Containers: https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/
- Kubernetes, Node-pressure Eviction: https://kubernetes.io/docs/concepts/scheduling-eviction/node-pressure-eviction/
- Kubernetes, Pod Quality of Service Classes: https://kubernetes.io/docs/concepts/workloads/pods/pod-qos/
- Kubernetes, About cgroup v2: https://kubernetes.io/docs/concepts/architecture/cgroups/
- Kubernetes, Assign Memory Resources to Containers and Pods: https://kubernetes.io/docs/tasks/configure-pod-container/assign-memory-resource/
- Kubernetes, Resize CPU and Memory Resources assigned to Containers: https://kubernetes.io/docs/tasks/configure-pod-container/resize-container-resources/
- Kubernetes, Pod Lifecycle (container restart policy, back-off): https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/
- Kubernetes Blog, New Conversion from cgroup v1 CPU Shares to v2 CPU Weight (2026-01-30): https://kubernetes.io/blog/2026/01/30/new-cgroup-v1-to-v2-cpu-conversion-formula/
- Kubernetes Blog, Kubernetes v1.36 Memory QoS tiered protection (2026-04-29): https://kubernetes.io/blog/2026/04/29/kubernetes-v1-36-memory-qos-tiered-protection/
- KEP-2570 Memory QoS: https://www.kubernetes.dev/resources/keps/2570/
- KEP-4603 Tune CrashLoopBackOff: https://www.kubernetes.dev/resources/keps/4603/
- KEP-5593 Configurable CrashLoopBackOff max: https://www.kubernetes.dev/resources/keps/5593/
- Kubernetes design proposal, resource-qos.md: https://github.com/kubernetes/design-proposals-archive/blob/main/node/resource-qos.md
- kubelet source, pkg/kubelet/qos/policy.go: https://github.com/kubernetes/kubernetes/blob/master/pkg/kubelet/qos/policy.go
- kubelet source, pkg/kubelet/cm/cgroup_manager_linux.go: https://github.com/kubernetes/kubernetes/blob/master/pkg/kubelet/cm/cgroup_manager_linux.go
- kubelet source, pkg/kubelet/cm/qos_container_manager_linux.go: https://github.com/kubernetes/kubernetes/blob/master/pkg/kubelet/cm/qos_container_manager_linux.go
- opencontainers/cgroups, utils.go (ConvertCPUSharesToCgroupV2Value): https://github.com/opencontainers/cgroups/blob/main/utils.go
- runc CHANGELOG: https://github.com/opencontainers/runc/blob/main/CHANGELOG.md
- containerd, containerd.service: https://github.com/containerd/containerd/blob/main/containerd.service
- cAdvisor, Prometheus metrics: https://github.com/google/cadvisor/blob/master/docs/storage/prometheus.md
- metrics-server README: https://github.com/kubernetes-sigs/metrics-server
- bash(1), EXIT STATUS: https://man7.org/linux/man-pages/man1/bash.1.html
- proc_pid_oom_score_adj(5): https://man7.org/linux/man-pages/man5/proc_pid_oom_score_adj.5.html
- Harry Tran, Understanding and Resolving OOMKilled errors in JVM microservices, Endowus Tech Blog (2023-12-14): https://build.endowus.com/oomkilled/

다음 글 [4편](/blog/cert/cka/k8s-linux-04-overlayfs)에서는 컨테이너 이미지 레이어가 OverlayFS로 합쳐지는 과정을 다룹니다.

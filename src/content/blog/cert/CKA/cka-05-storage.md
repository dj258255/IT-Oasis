---
title: '[CKA Ch-05] 스토리지: PVC가 Pending에 머무는 이유를 바인딩 규칙으로 읽기'
description: CKA 커리큘럼 v1.37의 Storage 영역(10%)을 목차 순서대로 정리합니다. StorageClass와 동적 프로비저닝, 볼륨 타입과 접근 모드(ReadWriteOncePod 포함), generic ephemeral volume, 회수 정책, CSI 드라이버가 볼륨을 만들고 붙이는 순서, PV와 PVC의 바인딩 규칙을 kubernetes.io 문서로 확인하고 시험에서 쓸 YAML과 명령, 자주 틀리는 지점, 연습 과제를 붙였습니다.
date: 2026-10-19T00:00:00.000Z
tags:
  - CKA
  - Kubernetes
  - PersistentVolume
  - PersistentVolumeClaim
  - StorageClass
category: cert/CKA
topics:
  - cert
draft: false
series: "CKA 공부"
seriesOrder: 5
---

## 결론부터

1. PVC는 저장 공간 요청이고 PV는 그 요청을 채우는 실제 볼륨입니다. 컨트롤 플레인의 제어 루프가 PVC에 맞는 PV를 찾아 일대일로 묶습니다. 맞는 PV가 없으면 PVC는 무기한 `Pending`으로 남습니다.
2. 바인딩 조건은 StorageClass 이름, 접근 모드, 크기 세 가지가 핵심입니다. `storageClassName`을 생략한 PVC와 `""`로 적은 PVC는 다르게 처리됩니다. 생략하면 기본 StorageClass가 붙고 `""`이면 클래스 없는 PV에만 묶입니다.
3. 동적 프로비저닝은 StorageClass가 있어야 일어납니다. 클래스의 `volumeBindingMode`가 `WaitForFirstConsumer`이면 그 PVC를 쓰는 Pod가 생길 때까지 PVC가 `Pending`인 것이 정상입니다.
4. 회수 정책은 `Retain`, `Delete`, `Recycle` 세 가지이고 `Recycle`은 사용 중단(deprecated) 상태입니다. 동적으로 만든 PV는 StorageClass의 `reclaimPolicy`를 물려받고 기본값은 `Delete`입니다. 데이터가 중요하면 `kubectl patch`로 `Retain`으로 바꿉니다.
5. 접근 모드는 볼륨을 노드 기준으로 제한합니다. `ReadWriteOnce`는 한 노드에서 여러 Pod가 쓸 수 있고 클러스터 전체에서 Pod 하나로 제한하려면 `ReadWriteOncePod`를 씁니다. 문서는 CSI 볼륨 전용이라 적지만 kind의 local-path(hostPath PV)에서도 Pod 하나 제한이 걸렸습니다.

---

커리큘럼 원문(CNCF, CKA Curriculum v1.37)의 Storage 항목은 세 개입니다. 두 번째 항목이 볼륨 타입, 접근 모드, 회수 정책 세 주제를 묶고 있어서 2절은 하위 절로 나눴습니다.

| 순서 | 커리큘럼 원문 | 이 글의 절 |
|---|---|---|
| 1 | Implement storage classes and dynamic volume provisioning | 1. StorageClass와 동적 프로비저닝 |
| 2 | Configure volume types, access modes and reclaim policies | 2. 볼륨 타입, 접근 모드, 회수 정책 |
| 3 | Manage persistent volumes and persistent volume claims | 3. PV와 PVC 관리 |

예시는 가상의 쇼핑몰과 게시판입니다. 네임스페이스 `shop`의 주문 DB(`order-db`)와 게시판 첨부파일 저장소(`board-files`)가 영구 저장소를 씁니다.

## 0. 먼저 잡을 그림

세 리소스의 관계를 먼저 정리합니다. Persistent Volumes 문서의 정의를 옮긴 것입니다.

| 리소스 | 범위 | 누가 만드나 | 비유(문서 표현) |
|---|---|---|---|
| PersistentVolume(PV) | 클러스터 전체(네임스페이스 없음) | 관리자가 직접, 또는 StorageClass로 동적 생성 | 노드처럼 클러스터의 자원 |
| PersistentVolumeClaim(PVC) | 네임스페이스 | 사용자 | Pod가 노드 자원을 쓰듯 PVC는 PV 자원을 쓴다 |
| StorageClass | 클러스터 전체 | 관리자 | 다른 저장 시스템의 "프로파일"과 비슷하다 |

수명 주기는 프로비저닝, 바인딩, 사용, 회수 네 단계입니다.

```
[프로비저닝]          [바인딩]              [사용]                 [회수]
정적: 관리자가 PV 생성   제어 루프가 PVC에 맞는    Pod가 volumes에서       PVC 삭제 후
동적: StorageClass가    PV를 찾아 일대일로 묶음   persistentVolumeClaim   reclaimPolicy대로
      PV 생성                                   으로 참조              Retain/Delete
```

PV는 Pod와 무관한 수명을 가집니다. 반면 `emptyDir` 같은 임시 볼륨은 Pod가 사라질 때 함께 사라집니다. Volumes 문서는 어떤 볼륨 타입이든 컨테이너가 재시작될 때는 데이터가 보존된다고 적습니다.

볼륨이 따로 필요한 이유는 컨테이너 자체의 파일시스템에 있습니다. Volumes 문서는 컨테이너 안 디스크의 파일이 임시라고 적습니다. 컨테이너가 크래시하면 kubelet은 깨끗한 상태로 컨테이너를 다시 시작하고 그동안 만들거나 고친 파일은 모두 사라집니다. 이 파일들이 놓이는 곳은 읽기 전용 이미지 레이어 위에 컨테이너마다 하나씩 붙는 쓰기 레이어입니다. 레이어가 OverlayFS로 겹쳐 컨테이너 루트가 되는 과정과 이미지에 있던 파일을 고칠 때 생기는 copy-up 비용은 [CKA 부록 4](/blog/cert/cka/k8s-linux-04-overlayfs)에서 커널 문서로 정리했습니다. 이 글은 그 쓰기 레이어 바깥에 데이터를 두는 볼륨부터 다룹니다.

## 1. StorageClass와 동적 프로비저닝

### 1-1. StorageClass가 하는 일

Storage Classes 문서는 StorageClass를 관리자가 제공하는 저장소의 "클래스"를 기술하는 방법이라고 설명합니다. 클래스가 무엇을 뜻하는지(성능 등급, 백업 정책 등)는 쿠버네티스가 정하지 않습니다. 각 StorageClass에는 PVC를 채울 PV를 동적으로 만들 때 쓰는 필드가 있습니다.

| 필드 | 의미 | 기본값과 제약 |
|---|---|---|
| `provisioner` | 어떤 볼륨 플러그인(프로비저너)으로 PV를 만드는지 | 필수 |
| `parameters` | 프로비저너에 넘기는 값 | 프로비저너마다 다름 |
| `reclaimPolicy` | 동적으로 만든 PV의 회수 정책 | `Delete` 또는 `Retain`. 생략하면 `Delete` |
| `allowVolumeExpansion` | PVC를 늘려 볼륨을 키울 수 있는지 | 늘리기만 가능, 줄일 수 없음 |
| `mountOptions` | 동적으로 만든 PV의 마운트 옵션 | 검증하지 않는다. 잘못되면 마운트 실패 |
| `volumeBindingMode` | 바인딩과 프로비저닝 시점 | 생략하면 `Immediate` |

StorageClass 이름은 사용자가 PVC에서 클래스를 고르는 열쇠라서 의미가 있는 값입니다.

문서의 예시 클래스를 쇼핑몰 주문 DB용으로 옮기면 이렇습니다. 프로비저너 이름은 클러스터에 설치된 CSI 드라이버 이름으로 바꿔야 합니다.

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: order-fast
  annotations:
    storageclass.kubernetes.io/is-default-class: "false"
provisioner: csi-driver.example-vendor.example
reclaimPolicy: Retain             # 기본값은 Delete
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
parameters:
  guaranteedReadWriteLatency: "true"   # 프로비저너 전용 값
```

kubectl create에 StorageClass, PV, PVC를 만드는 하위 명령이 없으므로(kubectl create 레퍼런스의 하위 명령 목록 기준) 문서 예제를 복사해 고칩니다. 기존 클래스를 본뜰 때는 `kubectl get sc <이름> -o yaml`을 받아 고치는 것도 빠릅니다.

### 1-2. 동적 프로비저닝의 흐름

Dynamic Volume Provisioning 문서를 따라가면 순서는 다음과 같습니다.

1. 관리자가 StorageClass를 하나 이상 만듭니다. 클래스마다 프로비저너와 파라미터가 정해집니다.
2. 사용자가 PVC의 `storageClassName`에 그 클래스 이름을 적습니다(예전의 `volume.beta.kubernetes.io/storage-class` 어노테이션은 v1.9부터 사용 중단).
3. 정적으로 만든 PV 중 맞는 것이 없으면 클러스터가 그 PVC만을 위한 볼륨을 동적으로 만듭니다.
4. 동적으로 만든 PV는 제어 루프가 항상 그 PVC에 묶습니다.

`storageClassName: ""`을 요청한 PVC는 스스로 동적 프로비저닝을 끈 것입니다. 또 문서는 selector가 비어 있지 않은 PVC에는 PV를 동적으로 만들 수 없다고 적습니다.

### 1-3. 기본 StorageClass

PVC가 `storageClassName`을 적지 않으면 기본 StorageClass가 쓰입니다. 조건은 둘입니다.

- StorageClass 하나에 어노테이션 `storageclass.kubernetes.io/is-default-class: "true"`가 있어야 합니다.
- API 서버에서 `DefaultStorageClass` 승인 컨트롤러가 켜져 있어야 합니다. 이 컨트롤러가 클래스를 생략한 PVC에 기본 클래스 이름을 채워 넣습니다.

기본 클래스는 `kubectl get sc` 출력에서 이름 옆에 `(default)`로 표시됩니다. kubectl v1.37에서 기본 어노테이션이 붙은 클래스가 둘일 때 `(default)`는 실제로 쓰이는 하나(가장 최근에 만든 것)에만 붙었습니다(kind 실측). 기본이 몇 개인지는 어노테이션으로 확인합니다. Change the default StorageClass 문서의 방법은 기존 기본 클래스의 어노테이션을 `"false"`로 바꾸고 새 클래스를 `"true"`로 바꾸는 것입니다.

```bash
kubectl get storageclass
kubectl patch storageclass standard -p '{"metadata": {"annotations":{"storageclass.kubernetes.io/is-default-class":"false"}}}'
kubectl patch storageclass order-fast -p '{"metadata": {"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'
```

| 상황 | 문서 기준 동작 |
|---|---|
| 기본 클래스가 둘 이상 | 클래스를 생략한 PVC에는 가장 최근에 만든 기본 클래스가 쓰인다. 문서는 기본은 하나만 두라고 권한다 |
| 기본 클래스가 없는데 클래스를 생략한 PVC를 만듦 | PVC는 만들어지고 `storageClassName`은 비어 있는 채로 남는다 |
| 나중에 기본 클래스가 생김 | 컨트롤 플레인이 `storageClassName`이 없는 기존 PVC를 찾아 새 기본 클래스로 채운다(retroactive, v1.28 stable) |
| `storageClassName: ""`인 기존 PVC | 기본 클래스가 생겨도 바뀌지 않는다 |

### 1-4. volumeBindingMode

| 값 | 바인딩과 프로비저닝 시점 | 쓰는 곳 |
|---|---|---|
| `Immediate` (기본) | PVC를 만들자마자 | 모든 노드에서 접근 가능한 저장소 |
| `WaitForFirstConsumer` | PVC를 쓰는 Pod가 만들어질 때까지 미룸. Pod의 스케줄링 제약(자원 요청, 노드 셀렉터, 어피니티, 테인트와 톨러레이션)을 보고 PV를 고르거나 만든다 | 특정 노드나 존에 묶인 저장소, `local` 볼륨 |

`Immediate`로 특정 존에만 있는 저장소를 쓰면 Pod의 스케줄링 요구를 모른 채 PV가 정해져 Pod를 어디에도 둘 수 없게 될 수 있다고 문서는 설명합니다.

`WaitForFirstConsumer`에는 함정이 하나 있습니다. Pod 스펙에 `nodeName`을 직접 쓰면 스케줄러를 건너뛰므로 PVC가 `pending` 상태로 남습니다. 문서는 대신 `kubernetes.io/hostname` 노드 셀렉터를 쓰라고 적습니다.

### 1-5. local 볼륨과 StorageClass

`local` 볼륨은 동적 프로비저닝을 지원하지 않습니다. 그래도 문서는 `WaitForFirstConsumer` 모드의 StorageClass를 만들어 두라고 권합니다. Pod가 적절한 노드에 스케줄될 때까지 바인딩을 미뤄야 스케줄러가 Pod의 모든 제약을 보고 PV를 고를 수 있기 때문입니다.

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: local-storage
provisioner: kubernetes.io/no-provisioner
volumeBindingMode: WaitForFirstConsumer
```

위 YAML은 Storage Classes 문서의 Local 절이 불러오는 예제 파일(`storageclass-local.yaml`)과 같습니다. 예제의 주석은 `kubernetes.io/no-provisioner`가 자동 프로비저닝을 지원하지 않는 클래스임을 나타낸다고 적습니다.

### 1-6. 자주 틀리는 지점

- PVC의 `storageClassName`을 클래스 이름과 한 글자라도 다르게 쓰면 동적 프로비저닝이 일어나지 않고 PVC가 `Pending`에 머뭅니다. `kubectl describe pvc`의 Events를 봅니다.
- 회수 정책은 PV를 만들 때 클래스에서 정해집니다. Persistent Volumes 문서의 Delete 절은 클래스를 기대에 맞게 설정하지 않았다면 PV를 만든 뒤 직접 편집하거나 patch해야 한다고 적습니다. 수동으로 만들어 클래스로 관리하는 PV는 생성 때 받은 회수 정책을 그대로 가진다고 Storage Classes 문서가 덧붙입니다.
- `WaitForFirstConsumer` 클래스의 PVC가 `Pending`인 것을 오류로 보고 손대는 실수가 있습니다. Pod를 만들면 풀립니다.

### 1-7. 직접 해 보기

1. 연습 클러스터에 local-path 같은 동적 프로비저너를 하나 설치하고 `kubectl get sc`에서 `(default)` 표시를 확인합니다.
2. 기본 표시를 다른 클래스로 옮기고 클래스를 생략한 PVC를 만들어 `kubectl get pvc -o yaml`의 `storageClassName`이 무엇으로 채워졌는지 봅니다.
3. `WaitForFirstConsumer` 클래스로 PVC를 만들어 `Pending`을 확인한 뒤 그 PVC를 쓰는 Pod를 만들어 `Bound`로 바뀌는 순간을 `kubectl get pvc -w`로 지켜봅니다.

kind v0.33(노드 v1.37.0)의 기본 클래스는 `standard`(프로비저너 `rancher.io/local-path`, `Delete`, `WaitForFirstConsumer`, `allowVolumeExpansion` 없음)입니다. 세 과제 모두 기대대로였습니다. 2번에서 기본을 `order-fast`로 옮긴 뒤 만든 PVC는 `storageClassName: order-fast`로 채워졌고 기본 클래스가 없을 때 만든 PVC는 기본이 생기자 소급해서 채워졌습니다. 3번의 `Pending` 동안 Events에는 `waiting for first consumer to be created before binding`이 찍혔습니다. `nodeName`으로 노드를 직접 지정한 Pod는 스케줄러를 건너뛰므로 WFFC PVC가 계속 `Pending`이고 Pod에 `FailedMount ... PVC is not bound`가 반복됐습니다.

## 2. 볼륨 타입, 접근 모드, 회수 정책

### 2-1. 볼륨 타입

Volumes 문서는 볼륨을 "Pod의 컨테이너가 접근할 수 있는 디렉터리"로 설명합니다. 그 디렉터리가 어디서 오고 어떤 매체에 저장되는지는 볼륨 타입이 정합니다. Pod의 `.spec.volumes`에 볼륨을 정의하고 컨테이너마다 `.spec.containers[*].volumeMounts`로 마운트 위치를 따로 적습니다.

시험에서 자주 만날 타입만 추립니다.

| 타입 | 수명 | 문서가 적은 핵심 |
|---|---|---|
| `emptyDir` | Pod | Pod가 노드에 배정될 때 빈 디렉터리로 생성. Pod가 노드에서 제거되면 영구 삭제. 컨테이너 크래시에는 보존. `medium: Memory`면 tmpfs이고 컨테이너 메모리 한도에 포함 |
| `hostPath` | 노드 | 노드의 파일이나 디렉터리를 마운트. 보안 위험이 크고 문서는 가능하면 `local` PV를 쓰라고 경고 |
| `configMap`, `secret` | API 객체 | 설정과 민감 정보를 파일로. `secret`은 tmpfs이고 항상 읽기 전용으로 마운트 |
| `downwardAPI`, `projected` | Pod | Pod 정보를 파일로, 여러 소스를 한 디렉터리로 |
| `ephemeral` (generic ephemeral volume) | Pod | Pod 스펙 안의 `volumeClaimTemplate`으로 PVC를 만든다. Pod가 지워지면 PVC도 지워진다. v1.23 stable |
| `persistentVolumeClaim` | PV | PVC를 Pod에 연결하는 다리 |
| `local` | 노드 디스크 | 정적 PV로만 사용. 동적 프로비저닝 없음. PV의 `nodeAffinity`로 노드를 안다 |
| `nfs` | 외부 | 여러 노드에서 읽기 쓰기 가능 |
| `csi` | 외부 | CSI 드라이버로 연결하는 외부 저장소. 클라우드 디스크 대부분이 이쪽으로 이전 |

`hostPath`의 `type` 값은 시험에 자주 나옵니다.

| `type` | 동작 |
|---|---|
| `""` (기본) | 마운트 전에 아무것도 확인하지 않음 |
| `DirectoryOrCreate` | 없으면 권한 0755로 빈 디렉터리 생성 |
| `Directory` | 디렉터리가 있어야 함 |
| `FileOrCreate` | 없으면 권한 0644로 빈 파일 생성. 상위 디렉터리는 만들지 않는다 |
| `File` | 파일이 있어야 함 |
| `Socket`, `CharDevice`, `BlockDevice` | 해당 종류가 있어야 함(뒤 둘은 리눅스 노드만) |

Persistent Volumes 문서는 `hostPath` PV를 단일 노드 테스트 전용이고 다중 노드 클러스터에서는 동작하지 않는다고 적습니다. 그래도 연습과 시험 과제에서는 PV 개념을 보여 주려고 `hostPath` PV를 자주 씁니다. 공식 튜토리얼(Configure a Pod to Use a PersistentVolume for Storage)도 `hostPath` PV로 진행합니다.

게시판 Pod가 업로드 임시 파일을 `emptyDir`에 두고 크기를 제한하는 예입니다.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: board-upload
  namespace: shop
spec:
  containers:
  - name: app
    image: nginx
    volumeMounts:
    - name: tmp-upload
      mountPath: /var/tmp/upload
  volumes:
  - name: tmp-upload
    emptyDir:
      sizeLimit: 500Mi
```

`sizeLimit`이 있어도 노드의 임시 저장소가 다른 원인(로그, 이미지)으로 먼저 차면 이 한도에 이르기 전에 공간이 부족할 수 있다고 문서는 적습니다.

`emptyDir`은 노드 디스크나 메모리만 씁니다. 임시 데이터라도 정해진 크기의 네트워크 디스크나 StorageClass의 기능(스냅샷, 확장)이 필요하면 generic ephemeral volume을 씁니다. Ephemeral Volumes 문서의 설명을 정리하면 이렇습니다.

- Pod를 만들면 ephemeral volume 컨트롤러가 Pod와 같은 네임스페이스에 실제 PVC를 만듭니다. PVC 이름은 `<Pod 이름>-<볼륨 이름>`으로 정해집니다.
- Pod가 이 PVC의 소유자(owner)라서 Pod를 지우면 가비지 컬렉터가 PVC를 지웁니다. 볼륨이 함께 지워지는지는 StorageClass의 회수 정책을 따릅니다. 기본값 `Delete`면 지워지고 아래 예처럼 `Retain` 클래스(1-1의 `order-fast`)를 쓰면 PV가 `Released`로 남습니다.
- 문서는 이 용도에 `WaitForFirstConsumer` 클래스를 권합니다. 그래야 스케줄러가 Pod에 맞는 노드를 자유롭게 고릅니다.
- 이름 규칙 때문에 같은 네임스페이스에서 이름이 겹칠 수 있습니다(Pod `pod-a`의 볼륨 `scratch`와 Pod `pod`의 볼륨 `a-scratch`). 그 Pod를 위해 만든 PVC가 아니면 쓰지 않으므로 Pod가 시작하지 못합니다.

게시판의 리포트 작업 Pod가 1Gi 임시 작업 공간을 받는 예입니다. 문서 예제의 구조를 그대로 따랐고 클래스 이름은 1-1의 `order-fast`로 바꿨습니다.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: report
  namespace: shop
spec:
  containers:
  - name: app
    image: busybox:1.28
    command: ["sleep", "1000000"]
    volumeMounts:
    - name: scratch
      mountPath: /scratch
  volumes:
  - name: scratch
    ephemeral:
      volumeClaimTemplate:
        spec:
          accessModes: ["ReadWriteOnce"]
          storageClassName: order-fast
          resources:
            requests:
              storage: 1Gi
```

이 Pod가 만들어지면 `kubectl -n shop get pvc`에 `report-scratch`가 보여야 합니다.

### 2-2. 접근 모드

| 모드 | 약어 | 의미(문서 기준) |
|---|---|---|
| `ReadWriteOnce` | RWO | 노드 하나에서 읽기 쓰기로 마운트. 같은 노드의 여러 Pod는 함께 쓸 수 있다 |
| `ReadOnlyMany` | ROX | 여러 노드에서 읽기 전용 |
| `ReadWriteMany` | RWX | 여러 노드에서 읽기 쓰기 |
| `ReadWriteOncePod` | RWOP | Pod 하나에서 읽기 쓰기. 클러스터 전체에서 Pod 하나만. v1.29 stable |

문서가 덧붙이는 사실 네 가지가 시험 함정입니다.

- 접근 모드는 PVC와 PV를 맞추는 데 쓰입니다. 경우에 따라 마운트 위치도 제한하지만 마운트한 뒤의 쓰기 보호는 강제하지 않습니다. `ReadOnlyMany`로 만든 PV가 읽기 전용이라는 보장도 없습니다. 예외는 `ReadWriteOncePod`이고 이것만 실제로 Pod 하나로 제한합니다.
- 볼륨이 여러 모드를 지원해도 한 번에 한 모드로만 마운트됩니다.
- 문서는 `ReadWriteOncePod`를 CSI 볼륨에서만 지원한다고 적고 CSI 사이드카 최소 버전으로 csi-provisioner v3.0.0, csi-attacher v3.3.0, csi-resizer v1.3.0을 듭니다. kind v1.37.0에서는 local-path가 만든 hostPath PV에도 RWOP PVC가 `Bound`됐고 정적 hostPath PV에 RWOP를 적는 것도 허용됐습니다. 같은 PVC를 쓰는 두 번째 Pod는 스케줄러가 `unavailable due to PersistentVolumeClaim with ReadWriteOncePod`로 막았습니다. 제한은 스케줄러와 kubelet이 걸기 때문에 CSI가 아니어도 동작한 것으로 보입니다. 시험 답으로는 "RWOP를 요청한다"가 핵심입니다.
- 지원하는 모드는 볼륨 플러그인마다 다릅니다. 문서 표 기준 HostPath는 RWO만, NFS는 RWO, ROX, RWX, CSI는 드라이버에 따라 다릅니다.

튜토리얼은 단순화를 위해 RWO를 쓰면서 운영 환경에서는 쿠버네티스 프로젝트가 ReadWriteOncePod를 권한다고 적습니다.

주문 DB처럼 Pod 하나만 써야 하는 볼륨이면 이렇게 요청합니다.

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: order-db-data
  namespace: shop
spec:
  accessModes:
  - ReadWriteOncePod
  storageClassName: order-fast
  resources:
    requests:
      storage: 20Gi
```

### 2-3. 회수 정책

PVC를 지운 뒤 PV를 어떻게 할지 정하는 것이 회수 정책(`persistentVolumeReclaimPolicy`)입니다.

| 정책 | PVC 삭제 후 | 메모 |
|---|---|---|
| `Retain` | PV는 남고 `Released` 상태. 이전 데이터가 남아 있어 다른 PVC가 바로 쓸 수 없다 | 관리자가 수동으로 회수 |
| `Delete` | PV 객체와 외부 저장소의 실제 자산을 함께 삭제 | 동적 PV의 기본값(StorageClass 기본값이 Delete) |
| `Recycle` | `rm -rf /thevolume/*`로 지우고 다시 사용 가능 | 사용 중단. 문서 기준 현재 `nfs`와 `hostPath`만 지원. 문서는 동적 프로비저닝을 권한다 |

`Retain` PV를 수동으로 회수하는 순서는 문서 기준으로 이렇습니다.

1. PV를 삭제합니다. 외부 인프라의 실제 저장 자산은 PV를 지워도 남습니다.
2. 저장 자산의 데이터를 필요에 맞게 정리합니다.
3. 저장 자산을 수동으로 삭제합니다.

같은 저장 자산을 다시 쓰고 싶다면 같은 정의로 PV를 새로 만들라고 문서는 적습니다. `Released` PV를 지우지 않고 다시 묶는 방법도 같은 문서에 있습니다. "Recovering from Failure when Expanding Volumes" 절의 관리자 절차가 PV의 `claimRef` 항목을 지워 PV를 `Available`로 만든 뒤 `volumeName`으로 그 PV를 지정한 PVC를 새로 만드는 순서입니다. 확장 실패 복구용으로 실린 절차지만 `claimRef`를 지우면 새 PVC가 묶일 수 있다는 동작은 같습니다.

```bash
kubectl patch pv <PV 이름> --type=json -p '[{"op":"remove","path":"/spec/claimRef"}]'
kubectl get pv <PV 이름>     # STATUS가 Available로 바뀌는지
```

이전 데이터는 그대로 남아 있으니 새 PVC가 그 데이터를 봐도 되는 경우에만 씁니다.

이미 만든 PV의 정책은 Change the Reclaim Policy of a PersistentVolume 문서의 명령으로 바꿉니다.

```bash
kubectl get pv
kubectl patch pv <PV 이름> -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'
kubectl get pv            # RECLAIM POLICY 열 확인
```

같은 문서의 확인 출력은 열 이름이 `ACCESSMODES`, `RECLAIMPOLICY`인 옛 모양입니다. kubectl v1.37에서 `standard` 클래스의 PV를 `Retain`으로 바꾼 뒤 본 실제 출력은 이렇습니다(kind 실측).

```
NAME                                       CAPACITY   ACCESS MODES   RECLAIM POLICY   STATUS   CLAIM                STORAGECLASS   VOLUMEATTRIBUTESCLASS   REASON   AGE
pvc-8560aeed-4a36-48fd-8345-7970fefc501e   1Gi        RWO            Retain           Bound    shop/order-db-data   standard       <unset>                          2s
```

### 2-4. CSI 드라이버가 볼륨을 만들고 붙이는 순서

Volumes 문서의 Out-of-tree volume plugins 절은 예전 볼륨 플러그인이 모두 in-tree였다고 설명합니다. 쿠버네티스 핵심 바이너리와 함께 빌드되고 배포되었기 때문에 새 저장 시스템을 지원하려면 쿠버네티스 코드 저장소에 코드를 넣어야 했습니다. CSI(Container Storage Interface)는 컨테이너 오케스트레이터가 임의의 저장 시스템을 워크로드에 노출하는 표준 인터페이스입니다. 저장소 벤더는 드라이버를 쿠버네티스 코드 밖에서 개발하고 클러스터에 확장으로 설치합니다.

kubernetes-csi 프로젝트의 배포 문서(Deploying a CSI Driver on Kubernetes)는 드라이버를 두 부분으로 나눠 설치한다고 적습니다.

| 부분 | 배포 형태 | 들어 있는 것 |
|---|---|---|
| 컨트롤러 플러그인 | Deployment나 StatefulSet. 여러 개를 띄울 때는 리더 선출로 하나만 활성 | 드라이버의 CSI Controller 서비스와 사이드카(external-provisioner, external-attacher, external-resizer, external-snapshotter 중 필요한 것) |
| 노드 플러그인 | 모든 노드에 DaemonSet | 드라이버의 CSI Node 서비스와 node-driver-registrar. kubelet이 호스트에 공유된 유닉스 소켓으로 호출 |

예제 드라이버는 이 구분을 따르지 않을 수 있습니다. kind에 설치해 본 csi-driver-host-path v1.17.1은 StatefulSet 하나(`csi-hostpathplugin`)에 드라이버와 사이드카 7개를 함께 넣은 구성이었습니다. 단일 노드 데모용이라 그렇습니다.

동적 프로비저닝 PVC 하나가 Pod 안 디렉터리가 되기까지를 사이드카 문서 기준으로 이으면 다음과 같습니다.

```
PVC 생성 (storageClassName: order-fast)
  -> external-provisioner: PVC를 감시하다 CreateVolume 호출
     (StorageClass의 parameters를 요청에 실어 보냄)
  -> PV 생성, PVC와 바인딩
Pod가 노드에 배정됨
  -> 컨트롤 플레인이 VolumeAttachment 객체 생성 (attach가 필요한 드라이버만)
  -> external-attacher: VolumeAttachment를 감시하다 ControllerPublishVolume 호출
     (디스크를 그 노드에 연결)
  -> 그 노드의 kubelet: NodeStageVolume, NodePublishVolume 호출 (포맷과 마운트)
  -> 컨테이너의 volumeMounts 경로에 보임
```

볼륨 생성을 시작하는 것은 PVC입니다. CreateVolume이 불리는 시점은 `volumeBindingMode`가 정합니다(1-4절). `Immediate`는 PVC를 만든 직후이고 `WaitForFirstConsumer`는 Pod가 노드에 배정된 뒤입니다. attach 단계가 필요 없는 드라이버(NFS 계열 등)는 CSIDriver 객체의 `attachRequired: false`로 VolumeAttachment를 건너뜁니다.

이미 있는 디스크를 정적 PV로 등록할 때는 PV의 `csi` 필드를 씁니다. Volumes 문서의 csi 절이 설명하는 필드 중 자주 쓰는 것만 넣었습니다.

```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: order-db-csi-pv
spec:
  storageClassName: order-fast
  capacity:
    storage: 20Gi
  accessModes:
  - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  csi:
    driver: csi-driver.example-vendor.example   # 드라이버가 GetPluginInfo로 알려 주는 이름
    volumeHandle: <저장소의 볼륨 ID>             # CreateVolume 응답의 volume.id에 해당
    fsType: ext4                                # Filesystem 모드에서 쓸 파일시스템
```

CSI 쪽에서 막혔을 때 볼 객체는 다음과 같습니다.

```bash
kubectl get csidriver                       # 설치된 드라이버 이름
kubectl get sc order-fast -o jsonpath='{.provisioner}{"\n"}'   # 위 이름과 같아야 함
kubectl get csinode <노드> -o yaml          # 그 노드의 kubelet에 등록된 드라이버
kubectl get volumeattachment                # 어떤 PV가 어느 노드에 붙었는지, ATTACHED 열
kubectl get pod -A | grep -i csi            # 컨트롤러, 노드 플러그인 Pod
```

in-tree 플러그인에서 CSI로 넘어가는 마이그레이션(`CSIMigration`)은 v1.25부터 stable입니다. Volumes 문서는 in-tree 플러그인을 가리키는 기존 StorageClass, PV, PVC에 대한 작업을 대응하는 CSI 드라이버로 넘기므로 설정을 바꿀 필요가 없다고 설명합니다. 단 그 CSI 드라이버는 관리자가 설치하고 구성해야 하며 쿠버네티스 코어가 대신 설치하지 않는다고 굵게 적어 둡니다. Persistent Volumes 문서 기준으로 `awsElasticBlockStore`, `azureDisk`, `gcePersistentDisk`는 v1.23부터 마이그레이션이 기본으로 켜진 사용 중단 타입이고 `cephfs`와 `rbd`는 v1.31부터 쓸 수 없습니다. Volumes 문서는 `gcePersistentDisk` in-tree 드라이버가 v1.28에서 완전히 제거됐다고 적고 FlexVolume은 v1.23부터 사용 중단입니다. 오래된 자료의 `provisioner: kubernetes.io/gce-pd` 같은 예시는 해당 CSI 드라이버가 설치된 클러스터에서만 동작하니 연습과 시험에서는 `kubectl get sc`로 실제 프로비저너 이름부터 확인합니다.

### 2-5. 자주 틀리는 지점

- RWO를 "Pod 하나"로 읽는 실수. RWO는 노드 하나 기준이라 같은 노드의 여러 Pod가 함께 마운트할 수 있습니다.
- 동적 PV의 회수 정책을 PVC나 Pod에서 바꾸려는 실수. 정책은 PV(`spec.persistentVolumeReclaimPolicy`)나 StorageClass(`reclaimPolicy`)에 있습니다. 필드 이름도 두 곳이 다릅니다.
- `Retain` PV가 `Released`가 되면 새 PVC가 자동으로 묶이지 않습니다. "데이터는 남기고 다시 쓰게 하라"는 과제에서는 이 상태를 먼저 확인합니다.
- `hostPath` `FileOrCreate`는 상위 디렉터리를 만들지 않아 Pod가 시작하지 못할 수 있습니다.
- StorageClass의 `provisioner` 이름이 `kubectl get csidriver` 목록과 다른데 PVC만 고치는 것. 프로비저너 이름이 틀리면 PVC를 처리할 external-provisioner가 없어 PVC가 계속 `Pending`입니다.
- generic ephemeral volume의 PVC를 직접 지우거나 이름이 같은 PVC를 미리 만드는 것. 그 PVC는 Pod가 소유하고 Pod를 위해 만든 것만 쓰입니다.

### 2-6. 직접 해 보기

1. 같은 노드에 고정한 Pod 두 개(`nodeSelector`)가 RWO PVC 하나를 함께 마운트하는지 보고 한 Pod를 다른 노드로 옮겼을 때 어떻게 되는지 `kubectl describe pod`의 Events로 확인합니다.
2. 동적 PVC를 만들고 생성된 PV의 회수 정책을 `Retain`으로 바꾼 뒤 PVC를 지워 PV가 `Released`로 남는 것을 봅니다.
3. `emptyDir`에 파일을 쓰고 컨테이너만 죽였을 때(`kubectl exec ... -- sh -c 'kill 1'`)와 Pod를 지웠을 때 파일이 남는지 비교합니다. nginx 이미지에는 `kill` 실행 파일이 없어 `-- kill 1`은 실패하므로 셸 내장 명령으로 보냅니다. busybox `sleep`이 PID 1이면 SIGTERM을 무시하니 nginx처럼 시그널을 처리하는 이미지로 합니다.
4. 2-1의 `report` Pod를 동적 프로비저너가 있는 클러스터에 만들고 `report-scratch` PVC가 생기는지, Pod를 지운 뒤 PVC가 사라지고 PV는 `order-fast`의 회수 정책(`Retain`)대로 `Released`로 남는지 `kubectl get pvc,pv -w`로 봅니다.
5. CSI 드라이버가 설치된 클러스터(kind라면 csi-driver-host-path 같은 예제 드라이버)에서 `kubectl get csidriver`, `kubectl get csinode`, `kubectl get volumeattachment`를 차례로 보고 Pod를 만들기 전후로 VolumeAttachment가 생기는지 확인합니다. 드라이버가 attach를 쓰지 않으면 생기지 않습니다.

kind v1.37.0 실측입니다. 1번에서 같은 노드의 두 Pod는 RWO PVC를 함께 마운트했습니다. 다른 노드로 고정한 Pod는 local-path PV에 붙은 nodeAffinity 때문에 `FailedScheduling ... didn't match PersistentVolume's node affinity`로 `Pending`이 됐습니다. local 계열 볼륨이라 생긴 결과이고 네트워크 스토리지라면 attach 단계에서 다른 메시지가 납니다. 2번은 `Released`로 남았습니다. 3번은 컨테이너 재시작 뒤에는 파일이 남고 Pod를 다시 만들면 비었습니다. 4번의 PVC 이름은 `report-scratch`, ownerReference는 Pod였습니다. 5번은 csi-driver-host-path v1.17.1(snapshot CRD와 controller 포함, 저장소의 deploy.sh 대신 매니페스트를 `kubectl apply`로 적용)로 했습니다. `ATTACHREQUIRED`가 `true`였고 csinode에 드라이버와 topologyKeys가 보였습니다. Pod를 만들자 VolumeAttachment가 생겼고 Pod를 지우자 사라졌습니다.

## 3. PV와 PVC 관리

### 3-1. 정적 프로비저닝 전체 흐름

공식 튜토리얼과 같은 구성을 게시판 첨부파일 저장소로 옮겼습니다. 노드의 `/mnt/data`를 쓰는 `hostPath` PV, 그것을 요청하는 PVC, PVC를 마운트하는 Pod 순서입니다.

```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: board-files-pv
  labels:
    type: local
spec:
  storageClassName: manual
  capacity:
    storage: 10Gi
  accessModes:
  - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  hostPath:
    path: /mnt/data
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: board-files
  namespace: shop
spec:
  storageClassName: manual
  accessModes:
  - ReadWriteOnce
  resources:
    requests:
      storage: 3Gi
---
apiVersion: v1
kind: Pod
metadata:
  name: board
  namespace: shop
spec:
  containers:
  - name: app
    image: nginx
    volumeMounts:
    - name: files
      mountPath: /usr/share/nginx/html
  volumes:
  - name: files
    persistentVolumeClaim:
      claimName: board-files
```

PVC가 3Gi를 요청했는데 10Gi PV에 묶일 수 있습니다. 문서는 사용자가 요청한 만큼은 반드시 받지만 볼륨이 요청보다 클 수 있다고 적습니다. 튜토리얼에 실린 결과의 모양은 아래와 같습니다(문서 예시, 튜토리얼의 이름 그대로).

```
NAME             CAPACITY   ACCESSMODES   RECLAIMPOLICY   STATUS    CLAIM                   STORAGECLASS   REASON    AGE
task-pv-volume   10Gi       RWO           Retain          Bound     default/task-pv-claim   manual                   2m

NAME            STATUS    VOLUME           CAPACITY   ACCESSMODES   STORAGECLASS   AGE
task-pv-claim   Bound     task-pv-volume   10Gi       RWO           manual         30s
```

튜토리얼의 열 이름은 옛 kubectl 것입니다. kubectl v1.37에서 같은 YAML을 돌리면 `ACCESS MODES`, `RECLAIM POLICY`처럼 띄어 쓴 이름과 `VOLUMEATTRIBUTESCLASS` 열(값 `<unset>`)이 더해져 나오고 PVC의 CAPACITY는 똑같이 10Gi였습니다(kind 실측).

이 출력에서 읽을 것은 PVC의 CAPACITY 열입니다. 요청한 3Gi 대신 묶인 PV의 크기(튜토리얼에서는 10Gi)가 보입니다.

### 3-2. 바인딩 규칙

Persistent Volumes 문서의 바인딩 규칙을 한 표로 모았습니다.

| 항목 | 규칙 |
|---|---|
| 짝짓기 | 제어 루프가 새 PVC를 보고 맞는 PV를 찾아 묶는다. 일대일이고 `claimRef`로 양방향 연결 |
| 크기 | PV가 요청 이상이면 된다. 50Gi PV만 여럿 있으면 100Gi PVC는 묶이지 않는다 |
| 클래스 | 같은 `storageClassName`끼리만. 클래스 없는 PV는 클래스를 요청하지 않은 PVC에만 |
| 접근 모드 | PVC가 요청한 모드를 PV가 지원해야 한다 |
| volumeMode | `Filesystem`(기본)과 `Block` |
| selector | PVC의 `matchLabels`, `matchExpressions`를 모두 만족하는 PV만(AND). 클래스 조건과도 AND |
| 맞는 PV가 없으면 | PVC는 무기한 미바인딩 상태. 맞는 PV가 생기면 그때 묶인다 |
| 네임스페이스 | Pod와 PVC는 같은 네임스페이스. PV 바인딩은 배타적이라 RWX, ROX여도 한 네임스페이스 안에서만 공유 |

특정 PV에 묶고 싶으면 PVC의 `volumeName`에 PV 이름을 적습니다(사전 바인딩). 이때 노드 어피니티 같은 일부 조건은 건너뛰지만 클래스, 접근 모드, 크기는 여전히 검사합니다. 다른 PVC가 그 PV를 먼저 가져가지 못하게 하려면 PV의 `claimRef`에 PVC를 적어 예약합니다. 지정한 PV가 이미 다른 PVC에 묶여 있으면 바인딩이 pending에 머문다고 문서는 적습니다.

```yaml
# PVC 쪽: 이 PV에만 묶이고 싶다
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: order-db-restore
  namespace: shop
spec:
  storageClassName: ""        # 빈 문자열을 명시해야 기본 클래스가 붙지 않는다
  volumeName: order-db-old-pv
  accessModes:
  - ReadWriteOnce
  resources:
    requests:
      storage: 20Gi
---
# PV 쪽: 이 PVC만 받겠다
apiVersion: v1
kind: PersistentVolume
metadata:
  name: order-db-old-pv
spec:
  storageClassName: ""
  claimRef:
    name: order-db-restore
    namespace: shop
  capacity:
    storage: 20Gi
  accessModes:
  - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  hostPath:
    path: /mnt/order-db
```

문서는 이 방법이 `Retain` 정책의 PV를 다시 쓸 때 유용하다고 적습니다.

### 3-3. PV 상태

| `STATUS` | 뜻 |
|---|---|
| `Available` | 아직 어떤 PVC에도 묶이지 않음 |
| `Bound` | PVC에 묶임 |
| `Released` | PVC는 삭제됐지만 클러스터가 아직 회수하지 않음 |
| `Failed` | 자동 회수에 실패 |

PV가 어떤 PVC에 묶였는지는 `kubectl get pv`의 CLAIM 열이나 `kubectl describe persistentvolume <이름>`으로 봅니다.

### 3-4. 사용 중인 객체 보호

Storage Object in Use Protection 기능 때문에 Pod가 쓰고 있는 PVC를 지우면 바로 사라지지 않습니다. PVC를 쓰는 Pod가 모두 없어질 때까지 삭제가 미뤄지고 그동안 상태는 `Terminating`, Finalizers에는 `kubernetes.io/pvc-protection`이 보입니다. PVC에 묶인 PV를 지울 때도 같아서 `kubernetes.io/pv-protection`이 붙습니다.

```bash
kubectl -n shop delete pvc board-files      # 삭제 완료를 기다리느라 명령이 돌아오지 않을 수 있다
kubectl -n shop describe pvc board-files    # Status: Terminating, Finalizers 확인
kubectl -n shop delete pod board            # Pod를 지우면 PVC 삭제가 진행된다
```

`delete pvc`가 멈춘 것처럼 보이면 그 PVC를 쓰는 Pod부터 찾습니다. Pod가 모두 사라지면 보호 Finalizer가 풀리고 삭제가 끝납니다.

### 3-5. 볼륨 확장

| 조건 | 문서 내용 |
|---|---|
| 클래스 | StorageClass의 `allowVolumeExpansion: true`일 때만 PVC를 늘릴 수 있다 |
| 방법 | PVC의 `spec.resources.requests.storage`를 더 큰 값으로 편집. 새 PV를 만들지 않고 기존 볼륨을 키운다 |
| 방향 | 늘리기만 가능 |
| 파일시스템 | XFS, Ext3, Ext4일 때만 크기 조정. Pod가 PVC를 읽기 쓰기로 쓸 때 파일시스템이 늘어난다 |
| 사용 중인 PVC | v1.24 stable. Pod를 다시 만들 필요 없음. 쓰는 Pod가 없으면 확장이 끝나지 않는다 |
| 주의 | PV의 크기를 직접 고친 뒤 PVC를 맞추면 실제 크기 조정은 일어나지 않는다 |
| 확장 실패 | 저장소가 들어줄 수 없는 크기를 요청하면 계속 재시도한다. 1.34부터 stable인 `RecoverVolumeExpansionFailure`로 앞서 요청한 값보다 작은 값으로 다시 요청할 수 있다. 단 `.status.capacity`보다는 커야 한다 |

```bash
kubectl -n shop patch pvc order-db-data -p '{"spec":{"resources":{"requests":{"storage":"30Gi"}}}}'
kubectl -n shop get pvc order-db-data -w
```

### 3-6. PVC가 Pending일 때 확인 순서

1절과 3-2절을 합치면 시험장에서 쓸 점검 목록이 됩니다.

| 순서 | 확인 | 명령 |
|---|---|---|
| 1 | Events에 원인이 적혀 있는지 | `kubectl describe pvc <이름>` |
| 2 | 클래스 이름이 PV나 StorageClass와 정확히 같은지 | `kubectl get pvc,pv -o wide`, `kubectl get sc` |
| 3 | `WaitForFirstConsumer` 클래스라 Pod를 기다리는 중인지 | `kubectl get sc <이름> -o yaml` |
| 4 | 요청 크기보다 큰 `Available` PV가 있는지 | `kubectl get pv` |
| 5 | 접근 모드와 volumeMode가 맞는지 | `kubectl get pv <이름> -o yaml` |
| 6 | PVC selector와 PV 라벨이 맞는지 | `kubectl get pv --show-labels` |
| 7 | `volumeName`으로 지정한 PV가 이미 다른 PVC에 묶였는지 | `kubectl get pv`의 CLAIM 열 |
| 8 | 동적 프로비저닝이면 클래스의 프로비저너가 설치돼 있고 컨트롤러 Pod가 도는지 | `kubectl get csidriver`, `kubectl get pod -A \| grep -i csi`, 컨트롤러 Pod의 `csi-provisioner` 컨테이너 로그 |

### 3-7. 자주 틀리는 지점

- PVC를 Pod와 다른 네임스페이스에 만드는 실수. PV는 네임스페이스가 없지만 PVC는 있습니다.
- `storageClassName`을 PV에는 적고 PVC에는 생략하면 기본 클래스가 PVC에 붙어 PV와 클래스가 달라집니다. 정적 PV를 쓰는 과제에서는 PV와 PVC에 같은 클래스 이름을 쓰거나 둘 다 `""`로 둡니다.
- Pod 스펙에서 `persistentVolumeClaim.claimName` 대신 PV 이름을 적는 실수. Pod는 PV를 직접 참조하지 않습니다.
- 확장할 때 PV 크기를 직접 고치면 실제 크기 조정이 일어나지 않습니다. 항상 PVC를 고칩니다.

### 3-8. 직접 해 보기

1. 3-1의 PV, PVC, Pod를 만들고 노드의 `/mnt/data`에 `index.html`을 써서 Pod 안에서 보이는지 확인합니다.
2. PVC 요청을 20Gi로 바꿔 다시 만들고 `Pending`의 이유를 `kubectl describe pvc` Events에서 읽습니다. kind에서 해 보면 크기 이야기가 나오지 않고 `ProvisioningFailed  storageclass.storage.k8s.io "manual" not found`가 찍힙니다. 맞는 PV가 없으니 `manual` 클래스로 동적 프로비저닝을 시도했는데 그런 StorageClass가 없다는 뜻입니다. 3-6의 확인 순서대로 "맞는 PV가 없다"와 "프로비저너가 없다"를 함께 떠올립니다.

1번과 3번은 kind에서 기대대로였습니다. 1번의 `/mnt/data`는 Pod가 뜬 kind 노드 컨테이너 안의 경로입니다. 3번에서 PVC는 `Terminating`, Finalizers `kubernetes.io/pvc-protection`, `Used By: <Pod 이름>`으로 보였고 Pod를 지우자 사라졌습니다.
3. Pod가 쓰는 PVC를 지워 `Terminating`과 `kubernetes.io/pvc-protection`을 확인한 뒤 Pod를 지워 PVC가 사라지는 것을 봅니다.

## 4. 확인 문제

직접 만든 연습 과제입니다. 시험 문항이나 덤프에서 옮긴 것이 아닙니다.

**문제 1.** 이름 `pay-logs-pv`, 용량 2Gi, 접근 모드 ReadWriteOnce, 회수 정책 Retain, StorageClass `manual`, 노드 경로 `/srv/pay-logs`인 PV를 만들고 네임스페이스 `shop`에 이 PV에 묶일 1Gi PVC `pay-logs`를 만드세요.

<details>
<summary>답 보기</summary>

```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: pay-logs-pv
spec:
  storageClassName: manual
  capacity:
    storage: 2Gi
  accessModes:
  - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  hostPath:
    path: /srv/pay-logs
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: pay-logs
  namespace: shop
spec:
  storageClassName: manual
  accessModes:
  - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
```

`kubectl get pv pay-logs-pv`에서 STATUS가 `Bound`, CLAIM이 `shop/pay-logs`인지 확인합니다. 1Gi를 요청했어도 PVC의 CAPACITY는 2Gi로 보입니다.

</details>

**문제 2.** PVC `order-db-data`가 `Pending`입니다. `kubectl get sc`를 보니 PVC가 요청한 클래스 `order-fast`의 `VOLUMEBINDINGMODE`가 `WaitForFirstConsumer`입니다. 이 PVC를 쓰는 Pod는 아직 없습니다. 무엇을 해야 하나요?

<details>
<summary>답 보기</summary>

아무것도 고칠 필요가 없습니다. `WaitForFirstConsumer`는 PVC를 쓰는 Pod가 만들어질 때까지 바인딩과 프로비저닝을 미룹니다. 과제가 바인딩까지 요구한다면 그 PVC를 마운트하는 Pod를 만들면 됩니다. Pod에 `nodeName`을 직접 쓰면 스케줄러를 건너뛰어 PVC가 계속 `Pending`일 수 있으니 노드를 고정해야 하면 `nodeSelector`의 `kubernetes.io/hostname`을 씁니다.

</details>

**문제 3.** 동적으로 만들어진 PV `pvc-1a2b...`가 있습니다. PVC를 지워도 데이터가 남도록 바꾸세요.

<details>
<summary>답 보기</summary>

```bash
kubectl patch pv pvc-1a2b... -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'
kubectl get pv pvc-1a2b...
```

`RECLAIM POLICY` 열(kubectl v1.37 표기)이 `Retain`이면 됩니다. 앞으로 만들 PV까지 바꾸려면 StorageClass의 `reclaimPolicy`를 `Retain`으로 둔 클래스를 새로 만듭니다.

</details>

**문제 4.** 클러스터에 StorageClass `standard`(기본)와 `order-fast`가 있습니다. 기본을 `order-fast`로 바꾸세요.

<details>
<summary>답 보기</summary>

```bash
kubectl patch storageclass standard -p '{"metadata": {"annotations":{"storageclass.kubernetes.io/is-default-class":"false"}}}'
kubectl patch storageclass order-fast -p '{"metadata": {"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'
kubectl get sc
```

`order-fast` 옆에만 `(default)`가 보여야 합니다. 둘 다 기본으로 두면 가장 최근에 만든 기본 클래스가 쓰입니다. kubectl v1.37은 기본이 둘이어도 실제로 쓰이는 하나에만 `(default)`를 붙였으므로(kind 실측) 표시만 보고 끝내지 말고 `kubectl get sc standard -o jsonpath='{.metadata.annotations}'`로 이전 기본의 어노테이션이 `"false"`인지도 확인합니다.

</details>

**문제 5.** 노드 하나에서 도는 Pod 두 개가 같은 RWO PVC를 마운트하고 있습니다. 이것이 가능한 이유와, Pod 하나만 쓰게 강제하려면 무엇을 바꿔야 하는지 답하세요.

<details>
<summary>답 보기</summary>

RWO는 노드 하나에서 읽기 쓰기로 마운트하는 모드라서 같은 노드의 여러 Pod가 함께 쓸 수 있습니다. Pod 하나로 강제하려면 접근 모드를 `ReadWriteOncePod`로 요청합니다. 문서는 이 모드를 CSI 볼륨 전용으로 적지만 kind v1.37.0에서는 hostPath PV에서도 두 번째 Pod가 스케줄 단계에서 막혔습니다. 실제 클러스터에서는 쓰는 볼륨에서 RWOP가 받아들여지는지 먼저 확인합니다.

</details>

**문제 6.** PVC `order-db-data`를 20Gi에서 30Gi로 늘리려 했는데 거부됩니다. 가장 먼저 확인할 것은 무엇인가요?

<details>
<summary>답 보기</summary>

PVC가 쓰는 StorageClass의 `allowVolumeExpansion`이 `true`인지 봅니다(`kubectl get sc order-fast -o yaml`). false면 PVC를 늘릴 수 없습니다. 그다음 볼륨 타입이 확장을 지원하는지(CSI는 v1.24부터), 줄이려 한 것은 아닌지 확인합니다.

</details>

**문제 7.** 네임스페이스 `shop`의 PVC `board-files`가 `Pending`이고 Events에는 외부 프로비저너가 볼륨을 만들기를 기다린다는 메시지만 반복됩니다. 클래스는 `Immediate` 모드이고 `provisioner`는 `csi-driver.example-vendor.example`입니다. 어디를 확인하나요?

<details>
<summary>답 보기</summary>

```bash
kubectl get csidriver
kubectl get sc <클래스> -o jsonpath='{.provisioner}{"\n"}'
kubectl get pod -A | grep -i csi
kubectl -n <드라이버 네임스페이스> logs <컨트롤러 Pod> -c csi-provisioner
```

PVC를 처리하는 것은 그 드라이버의 컨트롤러 Pod에 있는 external-provisioner입니다. 드라이버 이름이 클래스의 `provisioner`와 다르거나 컨트롤러 Pod가 없거나 죽어 있으면 아무도 CreateVolume을 부르지 않아 PVC가 계속 기다립니다. 컨테이너 이름(`csi-provisioner`)은 드라이버 배포 매니페스트마다 다를 수 있으니 `kubectl describe pod`로 먼저 확인합니다.

</details>

**문제 8.** 네임스페이스 `shop`의 Pod `report`에 이름이 `scratch`인 generic ephemeral volume이 있습니다. 만들어지는 PVC의 이름과 Pod를 지웠을 때 PVC가 어떻게 되는지 답하세요.

<details>
<summary>답 보기</summary>

PVC 이름은 `report-scratch`입니다. Pod가 이 PVC의 소유자이므로 Pod를 지우면 가비지 컬렉터가 PVC를 지웁니다. 클래스의 회수 정책이 `Delete`(기본값)이면 PV와 실제 볼륨도 지워지고 `Retain`이면 볼륨이 남아 따로 정리해야 합니다.

</details>

## 5. 범위와 한계

- 2026-10-20에 kind v0.33 + 노드 v1.37.0(colima, arm64, 기본 StorageClass `standard` = local-path-provisioner)에서 1-7, 2-6, 3-8 과제와 확인 문제의 YAML, 회수 정책 변경과 재바인딩(claimRef 제거 후 `volumeName`으로 다시 묶기), 확장(CSI hostpath에서 `ExternalExpanding` → `Resizing` → `FileSystemResizeRequired`, Pod 재생성 뒤 `FileSystemResizeSuccessful`), 축소 거부, 확장 불가 클래스의 거부 문구, 잘못된 프로비저너 이름을 돌렸습니다. 결과는 각 과제 아래에 적었습니다.
- kind 조건이 결과에 영향을 준 곳: local-path PV는 노드에 묶인 hostPath라 다른 노드로 옮긴 Pod가 스케줄되지 않습니다. local-path는 확장을 지원하지 않아 `allowVolumeExpansion`을 켜도 `waiting for an external controller`에서 멈췄고 확장 실습은 csi-driver-host-path로 했습니다. RWOP 결과는 local-path에서 본 것입니다.
- 돌리지 못한 것: 클라우드 디스크 CSI 드라이버, NFS 같은 RWX 볼륨, 여러 노드에 걸친 attach와 detach.
- kubernetes.io 문서는 2026년 10월 19일에 kubernetes/website 저장소의 main 브랜치 원문으로 읽었습니다.
- 시험 환경에 어떤 동적 프로비저너와 StorageClass가 준비되어 있는지는 공식 문서에 없습니다.
- 2-4절의 CSI 컨트롤러와 노드 플러그인 구조, 사이드카가 부르는 RPC는 kubernetes-csi 프로젝트 문서(배포 문서와 external-provisioner, external-attacher 페이지)를 읽고 정리했습니다. 실제 드라이버마다 배포 Namespace, 컨테이너 이름, attach 사용 여부가 다릅니다. 예제 드라이버 csi-driver-host-path v1.17.1로만 확인했습니다.
- 볼륨 스냅샷, 복제, 볼륨 populator, 원시 블록 볼륨은 커리큘럼 문구에 직접 나오지 않아 다루지 않았습니다.

## 참고 자료

시험 범위
- CNCF, [CKA Curriculum v1.37](https://github.com/cncf/curriculum/blob/master/CKA_Curriculum_v1.37.pdf)

kubernetes.io
- [Persistent Volumes](https://kubernetes.io/docs/concepts/storage/persistent-volumes/)
- [Storage Classes](https://kubernetes.io/docs/concepts/storage/storage-classes/)
- [Dynamic Volume Provisioning](https://kubernetes.io/docs/concepts/storage/dynamic-provisioning/)
- [Volumes](https://kubernetes.io/docs/concepts/storage/volumes/) (csi 절, Migrating to CSI drivers from in-tree plugins 절)
- [Ephemeral Volumes](https://kubernetes.io/docs/concepts/storage/ephemeral-volumes/)
- [Configure a Pod to Use a PersistentVolume for Storage](https://kubernetes.io/docs/tutorials/configuration/configure-persistent-volume-storage/)
- [Change the Reclaim Policy of a PersistentVolume](https://kubernetes.io/docs/tasks/administer-cluster/change-pv-reclaim-policy/)
- [Change the default StorageClass](https://kubernetes.io/docs/tasks/administer-cluster/change-default-storage-class/)
- [kubectl create](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_create/) (하위 명령 목록)
- [Feature Gates](https://kubernetes.io/docs/reference/command-line-tools-reference/feature-gates/) (`RecoverVolumeExpansionFailure`)

CSI
- Container Storage Interface, [CSI spec](https://github.com/container-storage-interface/spec/blob/master/spec.md)
- Kubernetes CSI Developer Documentation, [Deploying a CSI Driver on Kubernetes](https://kubernetes-csi.github.io/docs/deploying.html), [external-provisioner](https://kubernetes-csi.github.io/docs/external-provisioner.html), [external-attacher](https://kubernetes-csi.github.io/docs/external-attacher.html)

이 블로그의 관련 글
- [CKA 부록 4: OverlayFS](/blog/cert/cka/k8s-linux-04-overlayfs)

---
title: '[CKA Ch-05] 스토리지: PVC가 Pending에 머무는 이유를 바인딩 규칙으로 읽기'
description: CKA 커리큘럼 v1.37의 Storage 영역(10%)을 시험 과제 중심으로 정리합니다. StorageClass와 기본 클래스 교체, volumeBindingMode, 볼륨 타입(emptyDir, hostPath, generic ephemeral volume), 접근 모드(ReadWriteOncePod 포함), 회수 정책 변경과 Released PV 재사용, PV와 PVC의 바인딩 규칙, 볼륨 확장, Pending PVC 점검 순서를 시험에서 쓰는 YAML과 명령, 자주 틀리는 지점, 연습 과제로 묶었습니다.
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

1. PVC는 저장 공간 요청이고 PV는 그 요청을 채우는 실제 볼륨입니다. 컨트롤 플레인의 제어 루프가 PVC에 맞는 PV를 찾아 일대일로 묶고 맞는 PV가 없으면 PVC는 무기한 `Pending`으로 남습니다.
2. 바인딩에서 먼저 맞춰 볼 조건은 StorageClass 이름, 접근 모드, 크기입니다. `storageClassName`을 생략한 PVC에는 기본 StorageClass가 붙고 `""`로 적은 PVC는 클래스 없는 PV에만 묶입니다.
3. 동적 프로비저닝은 StorageClass가 있어야 일어납니다. 클래스의 `volumeBindingMode`가 `WaitForFirstConsumer`이면 그 PVC를 쓰는 Pod가 생길 때까지 `Pending`인 것이 정상입니다.
4. 회수 정책은 `Retain`, `Delete`, `Recycle`(사용 중단)입니다. 동적으로 만든 PV는 StorageClass의 `reclaimPolicy`를 물려받고 기본값은 `Delete`입니다. 데이터가 중요하면 `kubectl patch pv`로 `Retain`으로 바꿉니다.
5. 접근 모드는 노드 기준입니다. `ReadWriteOnce`는 한 노드의 여러 Pod가 함께 쓸 수 있고 클러스터 전체에서 Pod 하나로 제한하려면 `ReadWriteOncePod`를 씁니다.

---

커리큘럼(CNCF, CKA Curriculum v1.37)의 Storage 항목은 세 개입니다.

| 순서 | 커리큘럼 원문 | 이 글의 절 |
|---|---|---|
| 1 | Implement storage classes and dynamic volume provisioning | 1. StorageClass와 동적 프로비저닝 |
| 2 | Configure volume types, access modes and reclaim policies | 2. 볼륨 타입, 접근 모드, 회수 정책 |
| 3 | Manage persistent volumes and persistent volume claims | 3. PV와 PVC 관리 |

예시는 가상의 쇼핑몰과 게시판입니다. 네임스페이스 `shop`의 주문 DB(`order-db`)와 게시판 첨부파일 저장소(`board-files`)가 영구 저장소를 씁니다.

## 0. 먼저 잡을 그림

Persistent Volumes 문서의 정의를 표로 옮겼습니다.

| 리소스 | 범위 | 누가 만드나 |
|---|---|---|
| PersistentVolume(PV) | 클러스터 전체(네임스페이스 없음) | 관리자가 직접, 또는 StorageClass로 동적 생성 |
| PersistentVolumeClaim(PVC) | 네임스페이스 | 사용자. Pod가 노드 자원을 쓰듯 PVC는 PV 자원을 쓴다 |
| StorageClass | 클러스터 전체 | 관리자. 저장소의 "클래스"(프로파일)를 기술 |

수명 주기는 프로비저닝, 바인딩, 사용, 회수 네 단계입니다.

```
[프로비저닝]          [바인딩]              [사용]                 [회수]
정적: 관리자가 PV 생성   제어 루프가 PVC에 맞는    Pod가 volumes에서       PVC 삭제 후
동적: StorageClass가    PV를 찾아 일대일로 묶음   persistentVolumeClaim   reclaimPolicy대로
      PV 생성                                   으로 참조              Retain/Delete
```

PV는 Pod와 무관한 수명을 가지고 `emptyDir` 같은 임시 볼륨은 Pod와 함께 사라집니다. 컨테이너 자체의 쓰기 레이어는 컨테이너가 다시 시작되면 비워지므로 남겨야 할 데이터는 볼륨에 둡니다. 쓰기 레이어의 커널 쪽 구조(OverlayFS)는 시험 범위 밖이라 [쿠버네티스 아래의 리눅스 4편](/blog/theory/systems/k8s-linux-04-overlayfs)에 따로 두었습니다.

## 1. StorageClass와 동적 프로비저닝

### 1-1. StorageClass가 하는 일

StorageClass는 관리자가 제공하는 저장소의 "클래스"를 기술합니다. 클래스가 무엇을 뜻하는지(성능 등급, 백업 정책 등)는 쿠버네티스가 정하지 않습니다.

| 필드 | 의미 | 기본값과 제약 |
|---|---|---|
| `provisioner` | 어떤 볼륨 플러그인(프로비저너)으로 PV를 만드는지 | 필수 |
| `parameters` | 프로비저너에 넘기는 값 | 프로비저너마다 다름 |
| `reclaimPolicy` | 동적으로 만든 PV의 회수 정책 | `Delete` 또는 `Retain`. 생략하면 `Delete` |
| `allowVolumeExpansion` | PVC를 늘려 볼륨을 키울 수 있는지 | 늘리기만 가능 |
| `mountOptions` | 동적으로 만든 PV의 마운트 옵션 | 검증하지 않는다. 잘못되면 마운트 실패 |
| `volumeBindingMode` | 바인딩과 프로비저닝 시점 | 생략하면 `Immediate` |

문서의 예시 클래스를 주문 DB용으로 옮겼습니다. 프로비저너 이름은 클러스터에 설치된 드라이버 이름(`kubectl get csidriver`, 2-4절)으로 바꿉니다.

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

`kubectl create`에는 StorageClass, PV, PVC를 만드는 하위 명령이 없으므로 문서 예제를 복사해 고치거나 `kubectl get sc <이름> -o yaml`을 받아 고칩니다.

### 1-2. 동적 프로비저닝의 흐름

Dynamic Volume Provisioning 문서를 따라가면 순서는 다음과 같습니다.

1. 관리자가 StorageClass를 하나 이상 만듭니다.
2. 사용자가 PVC의 `storageClassName`에 그 클래스 이름을 적습니다(옛 `volume.beta.kubernetes.io/storage-class` 어노테이션은 사용 중단).
3. 정적으로 만든 PV 중 맞는 것이 없으면 클러스터가 그 PVC만을 위한 볼륨을 동적으로 만듭니다.
4. 동적으로 만든 PV는 항상 그 PVC에 묶입니다.

`storageClassName: ""`인 PVC는 동적 프로비저닝을 스스로 끈 것입니다. selector가 비어 있지 않은 PVC에도 PV를 동적으로 만들 수 없습니다.

### 1-3. 기본 StorageClass

PVC가 `storageClassName`을 적지 않으면 기본 StorageClass가 쓰입니다. StorageClass 하나에 어노테이션 `storageclass.kubernetes.io/is-default-class: "true"`가 있어야 하고 API 서버의 `DefaultStorageClass` 승인 컨트롤러(기본 켜짐)가 클래스를 생략한 PVC에 그 이름을 채워 넣습니다.

기본 클래스는 `kubectl get sc`에서 이름 옆에 `(default)`로 표시됩니다. Change the default StorageClass 문서의 방법은 기존 기본 클래스의 어노테이션을 `"false"`로 바꾸고 새 클래스를 `"true"`로 바꾸는 것입니다.

```bash
kubectl get storageclass
kubectl patch storageclass standard -p '{"metadata": {"annotations":{"storageclass.kubernetes.io/is-default-class":"false"}}}'
kubectl patch storageclass order-fast -p '{"metadata": {"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'
```

| 상황 | 문서 기준 동작 |
|---|---|
| 기본 클래스가 둘 이상 | 클래스를 생략한 PVC에는 가장 최근에 만든 기본 클래스가 쓰인다. 문서는 하나만 두라고 권한다 |
| 기본 클래스가 없는데 클래스를 생략한 PVC를 만듦 | PVC는 만들어지고 `storageClassName`은 빈 채로 남는다 |
| 나중에 기본 클래스가 생김 | `storageClassName`이 없는 기존 PVC를 새 기본 클래스로 채운다(v1.28 stable) |
| `storageClassName: ""`인 기존 PVC | 기본 클래스가 생겨도 바뀌지 않는다 |

kubectl v1.37은 기본 어노테이션이 붙은 클래스가 둘이어도 실제로 쓰이는 하나(가장 최근 것)에만 `(default)`를 붙였습니다. 기본을 바꾼 뒤에는 이전 클래스의 어노테이션이 `"false"`인지도 확인합니다.

### 1-4. volumeBindingMode

| 값 | 바인딩과 프로비저닝 시점 | 쓰는 곳 |
|---|---|---|
| `Immediate` (기본) | PVC를 만들자마자 | 모든 노드에서 접근 가능한 저장소 |
| `WaitForFirstConsumer` | PVC를 쓰는 Pod가 만들어질 때까지 미룸. Pod의 스케줄링 제약(자원 요청, 노드 셀렉터, 어피니티, 테인트와 톨러레이션)을 보고 PV를 고르거나 만든다 | 특정 노드나 존에 묶인 저장소, `local` 볼륨 |

`Immediate`로 특정 존에만 있는 저장소를 쓰면 Pod의 스케줄링 요구를 모른 채 PV가 정해져 Pod를 어디에도 둘 수 없게 될 수 있습니다.

`WaitForFirstConsumer`에는 함정이 하나 있습니다. Pod 스펙에 `nodeName`을 직접 쓰면 스케줄러를 건너뛰므로 PVC가 `Pending`으로 남고 Pod에는 `FailedMount ... PVC is not bound`가 반복됩니다. 노드를 고정하려면 `kubernetes.io/hostname` 노드 셀렉터를 씁니다.

### 1-5. local 볼륨과 StorageClass

`local` 볼륨은 동적 프로비저닝을 지원하지 않습니다. 그래도 문서는 `WaitForFirstConsumer` 모드의 StorageClass를 만들어 두라고 권합니다. 바인딩을 미뤄야 스케줄러가 Pod의 모든 제약을 보고 PV를 고를 수 있습니다. 아래는 Storage Classes 문서의 예제 그대로입니다.

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: local-storage
provisioner: kubernetes.io/no-provisioner   # 자동 프로비저닝 없음
volumeBindingMode: WaitForFirstConsumer
```

### 1-6. 자주 틀리는 지점

- PVC의 `storageClassName`을 클래스 이름과 한 글자라도 다르게 쓰면 동적 프로비저닝이 일어나지 않고 `Pending`에 머뭅니다. `kubectl describe pvc`의 Events를 봅니다.
- 회수 정책은 PV를 만들 때 클래스에서 정해집니다. 클래스를 나중에 고쳐도 이미 만든 PV는 바뀌지 않으므로 PV를 직접 patch합니다.
- `WaitForFirstConsumer` 클래스의 PVC가 `Pending`인 것을 오류로 보고 손대는 실수가 있습니다. Pod를 만들면 풀립니다.

### 1-7. 직접 해 보기

1. 연습 클러스터의 `kubectl get sc`에서 `(default)` 표시를 확인합니다. kind의 기본 클래스는 `standard`(프로비저너 `rancher.io/local-path`, `Delete`, `WaitForFirstConsumer`)입니다.
2. 기본 표시를 다른 클래스로 옮기고 클래스를 생략한 PVC를 만들어 `kubectl get pvc -o yaml`의 `storageClassName`이 새 기본 클래스로 채워졌는지 봅니다. 기본 클래스가 없을 때 만든 PVC가 기본이 생기자 소급해서 채워지는지도 봅니다.
3. `WaitForFirstConsumer` 클래스로 PVC를 만들어 Events의 `waiting for first consumer to be created before binding`을 확인한 뒤 그 PVC를 쓰는 Pod를 만들어 `kubectl get pvc -w`로 `Bound`가 되는 것을 봅니다.

## 2. 볼륨 타입, 접근 모드, 회수 정책

### 2-1. 볼륨 타입

볼륨은 Pod의 컨테이너가 접근할 수 있는 디렉터리이고 그 디렉터리가 어디서 오는지는 볼륨 타입이 정합니다. Pod의 `.spec.volumes`에 볼륨을 정의하고 컨테이너마다 `volumeMounts`로 마운트 위치를 적습니다.

| 타입 | 수명 | 문서가 적은 핵심 |
|---|---|---|
| `emptyDir` | Pod | Pod가 노드에 배정될 때 빈 디렉터리로 생성. Pod가 노드에서 제거되면 삭제. 컨테이너 크래시에는 보존. `medium: Memory`면 tmpfs이고 컨테이너 메모리 한도에 포함 |
| `hostPath` | 노드 | 노드의 파일이나 디렉터리를 마운트. 보안 위험이 크고 문서는 가능하면 `local` PV를 쓰라고 경고 |
| `configMap`, `secret` | API 객체 | 설정과 민감 정보를 파일로. `secret`은 tmpfs이고 항상 읽기 전용 |
| `downwardAPI`, `projected` | Pod | Pod 정보를 파일로, 여러 소스를 한 디렉터리로 |
| `ephemeral` (generic ephemeral volume) | Pod | Pod 스펙 안의 `volumeClaimTemplate`으로 PVC를 만든다. Pod가 지워지면 PVC도 지워진다 |
| `persistentVolumeClaim` | PV | PVC를 Pod에 연결 |
| `local` | 노드 디스크 | 정적 PV로만. PV의 `nodeAffinity`로 노드를 안다 |
| `nfs` | 외부 | 여러 노드에서 읽기 쓰기 가능 |
| `csi` | 외부 | CSI 드라이버로 연결하는 외부 저장소. 클라우드 디스크 대부분이 이쪽 |

`hostPath`의 `type` 값은 시험에 자주 나옵니다.

| `type` | 동작 |
|---|---|
| `""` (기본) | 마운트 전에 아무것도 확인하지 않음 |
| `DirectoryOrCreate` | 없으면 권한 0755로 빈 디렉터리 생성 |
| `Directory` | 디렉터리가 있어야 함 |
| `FileOrCreate` | 없으면 권한 0644로 빈 파일 생성. 상위 디렉터리는 만들지 않는다 |
| `File` | 파일이 있어야 함 |
| `Socket`, `CharDevice`, `BlockDevice` | 해당 종류가 있어야 함 |

문서는 `hostPath` PV를 단일 노드 테스트 전용이라고 적지만 공식 튜토리얼과 연습 과제는 PV 개념을 보여 주려고 `hostPath` PV를 자주 씁니다.

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

임시 데이터라도 StorageClass의 기능(정해진 크기의 네트워크 디스크, 확장)이 필요하면 generic ephemeral volume을 씁니다. Ephemeral Volumes 문서의 규칙은 셋입니다.

- PVC 이름은 `<Pod 이름>-<볼륨 이름>`이고 Pod와 같은 네임스페이스에 생깁니다.
- Pod가 이 PVC의 소유자(ownerReference)라서 Pod를 지우면 PVC도 지워집니다. 볼륨이 함께 지워지는지는 클래스의 회수 정책을 따릅니다.
- 그 Pod를 위해 만든 PVC가 아니면 쓰지 않으므로 같은 이름의 PVC가 미리 있으면 Pod가 시작하지 못합니다.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: report
  namespace: shop
spec:
  containers:
  - name: app
    image: busybox:1.36
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

이 Pod가 만들어지면 `kubectl -n shop get pvc`에 `report-scratch`가 보입니다.

### 2-2. 접근 모드

| 모드 | 약어 | 의미(문서 기준) |
|---|---|---|
| `ReadWriteOnce` | RWO | 노드 하나에서 읽기 쓰기로 마운트. 같은 노드의 여러 Pod는 함께 쓸 수 있다 |
| `ReadOnlyMany` | ROX | 여러 노드에서 읽기 전용 |
| `ReadWriteMany` | RWX | 여러 노드에서 읽기 쓰기 |
| `ReadWriteOncePod` | RWOP | 클러스터 전체에서 Pod 하나만 읽기 쓰기. v1.29 stable |

문서가 덧붙이는 사실이 시험 함정입니다.

- 접근 모드는 PVC와 PV를 맞추는 데 쓰이고 마운트 뒤의 쓰기 보호는 강제하지 않습니다. `ReadOnlyMany`로 만든 PV가 읽기 전용이라는 보장도 없습니다. 실제로 Pod 하나로 제한하는 것은 `ReadWriteOncePod`뿐입니다.
- 볼륨이 여러 모드를 지원해도 한 번에 한 모드로만 마운트됩니다.
- 지원하는 모드는 볼륨 플러그인마다 다릅니다. 문서 표 기준 HostPath는 RWO만, NFS는 RWO, ROX, RWX, CSI는 드라이버에 따라 다릅니다.
- 문서는 `ReadWriteOncePod`를 CSI 볼륨 전용이라고 적습니다. kind의 local-path(hostPath PV)에서도 RWOP PVC가 묶였고 같은 PVC를 쓰는 두 번째 Pod는 `unavailable due to PersistentVolumeClaim with ReadWriteOncePod`로 스케줄되지 않았습니다.

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
| `Delete` | PV 객체와 외부 저장소의 실제 자산을 함께 삭제 | 동적 PV의 기본값 |
| `Recycle` | `rm -rf /thevolume/*`로 지우고 다시 사용 가능 | 사용 중단. `nfs`와 `hostPath`만 지원 |

이미 만든 PV의 정책은 Change the Reclaim Policy of a PersistentVolume 문서의 명령으로 바꿉니다.

```bash
kubectl get pv
kubectl patch pv <PV 이름> -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'
kubectl get pv            # RECLAIM POLICY 열 확인
```

문서의 확인 출력은 열 이름이 `ACCESSMODES`, `RECLAIMPOLICY`인 옛 모양입니다. kubectl v1.37에서는 이렇게 나옵니다.

```
NAME                                       CAPACITY   ACCESS MODES   RECLAIM POLICY   STATUS   CLAIM                STORAGECLASS   VOLUMEATTRIBUTESCLASS   REASON   AGE
pvc-8560aeed-4a36-48fd-8345-7970fefc501e   1Gi        RWO            Retain           Bound    shop/order-db-data   standard       <unset>                          2s
```

`VOLUMEATTRIBUTESCLASS` 열은 1.34에 GA가 된 VolumeAttributesClass(볼륨의 IOPS 같은 속성을 바꾸는 API)를 보여 줍니다. 커리큘럼 문구 밖이라 `<unset>`이면 넘어가도 됩니다.

`Retain` PV를 수동으로 회수하는 순서는 PV 삭제(외부 저장 자산은 남음), 자산의 데이터 정리, 자산 삭제입니다. 같은 자산을 다시 쓰려면 같은 정의로 PV를 새로 만듭니다.

`Released` PV를 지우지 않고 다시 묶는 방법도 문서(Recovering from Failure when Expanding Volumes 절의 관리자 절차)에 있습니다. PV의 `claimRef`를 지워 `Available`로 만든 뒤 `volumeName`으로 그 PV를 지정한 PVC를 새로 만듭니다(3-2절 YAML). 이전 데이터가 그대로 보이므로 새 PVC가 그 데이터를 봐도 되는 경우에만 씁니다.

```bash
kubectl patch pv <PV 이름> --type=json -p '[{"op":"remove","path":"/spec/claimRef"}]'
kubectl get pv <PV 이름>     # STATUS가 Available로 바뀌는지
```

### 2-4. CSI 드라이버와 프로비저너 이름

CSI(Container Storage Interface)는 저장 시스템을 워크로드에 노출하는 표준 인터페이스이고 저장소 벤더는 드라이버를 쿠버네티스 코드 밖에서 만들어 클러스터에 설치합니다. 시험에서 알아야 할 연결은 하나입니다. StorageClass의 `provisioner` 값이 설치된 CSI 드라이버 이름과 같아야 그 드라이버가 PVC를 보고 볼륨을 만듭니다. 이름이 다르면 아무도 볼륨을 만들지 않아 PVC가 `Pending`에 머뭅니다.

```bash
kubectl get csidriver                       # 설치된 드라이버 이름, ATTACHREQUIRED
kubectl get sc order-fast -o jsonpath='{.provisioner}{"\n"}'   # 위 이름과 같아야 함
kubectl get csinode <노드> -o yaml          # 그 노드의 kubelet에 등록된 드라이버
kubectl get volumeattachment                # 어떤 PV가 어느 노드에 붙었는지
kubectl get pod -A | grep -i csi            # 드라이버의 컨트롤러, 노드 Pod
```

`attachRequired: true`인 드라이버는 Pod가 노드에 배정되면 VolumeAttachment 객체가 생기고 Pod를 지우면 사라집니다. 드라이버의 내부 구조(사이드카 컨테이너, CSI RPC)는 시험 범위 밖입니다.

in-tree 볼륨 플러그인에서 CSI로 넘어가는 마이그레이션은 v1.25부터 stable이고 해당 CSI 드라이버는 관리자가 설치해야 합니다. 옛 자료의 `provisioner: kubernetes.io/gce-pd` 같은 예는 그 드라이버가 있는 클러스터에서만 동작하니 `kubectl get sc`로 실제 프로비저너 이름부터 확인합니다.

### 2-5. 자주 틀리는 지점

- RWO를 "Pod 하나"로 읽는 실수. RWO는 노드 하나 기준이라 같은 노드의 여러 Pod가 함께 마운트할 수 있습니다.
- 회수 정책을 PVC나 Pod에서 바꾸려는 실수. 정책은 PV(`spec.persistentVolumeReclaimPolicy`)나 StorageClass(`reclaimPolicy`)에 있고 필드 이름도 두 곳이 다릅니다.
- `Retain` PV가 `Released`가 되면 새 PVC가 자동으로 묶이지 않습니다. "데이터는 남기고 다시 쓰게 하라"는 과제에서는 이 상태를 먼저 확인합니다.
- `hostPath` `FileOrCreate`는 상위 디렉터리를 만들지 않아 Pod가 시작하지 못할 수 있습니다.
- StorageClass의 `provisioner`가 `kubectl get csidriver` 목록과 다른데 PVC만 고치는 실수.
- generic ephemeral volume의 PVC를 직접 지우거나 같은 이름의 PVC를 미리 만드는 실수.

### 2-6. 직접 해 보기

1. 같은 노드에 고정한 Pod 두 개(`nodeSelector`)가 RWO PVC 하나를 함께 마운트하는지 봅니다. 한 Pod를 다른 노드로 고정하면 kind의 local-path PV에서는 `FailedScheduling ... didn't match PersistentVolume's node affinity`로 `Pending`이 됩니다. 노드에 묶인 볼륨이라 생기는 결과입니다.
2. 동적 PVC를 만들고 생성된 PV의 회수 정책을 `Retain`으로 바꾼 뒤 PVC를 지워 PV가 `Released`로 남는 것을 봅니다. 이어서 `claimRef`를 지워 `Available`이 되는지 봅니다.
3. `emptyDir`에 파일을 쓰고 컨테이너만 죽였을 때(`kubectl exec <Pod> -- sh -c 'kill 1'`)와 Pod를 지웠을 때 파일이 남는지 비교합니다. nginx 이미지에는 `kill` 실행 파일이 없어 셸 내장 명령으로 보냅니다.
4. 2-1의 `report` Pod를 만들고 `report-scratch` PVC가 생기는지, Pod를 지우면 PVC가 사라지는지 `kubectl get pvc,pv -w`로 봅니다.

## 3. PV와 PVC 관리

### 3-1. 정적 프로비저닝 전체 흐름

공식 튜토리얼(Configure a Pod to Use a PersistentVolume for Storage)과 같은 구성을 게시판 첨부파일 저장소로 옮겼습니다. 노드의 `/mnt/data`를 쓰는 `hostPath` PV, 그것을 요청하는 PVC, PVC를 마운트하는 Pod 순서입니다.

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

PVC가 3Gi를 요청했어도 10Gi PV에 묶일 수 있습니다. 요청한 만큼은 반드시 받지만 볼륨이 더 클 수 있어서 `kubectl get pvc`의 CAPACITY에는 묶인 PV의 크기 10Gi가 보입니다.

### 3-2. 바인딩 규칙

Persistent Volumes 문서의 바인딩 규칙을 한 표로 모았습니다.

| 항목 | 규칙 |
|---|---|
| 짝짓기 | 제어 루프가 새 PVC에 맞는 PV를 찾아 묶는다. 일대일이고 `claimRef`로 양방향 연결 |
| 크기 | PV가 요청 이상이면 된다. 50Gi PV만 여럿 있으면 100Gi PVC는 묶이지 않는다 |
| 클래스 | 같은 `storageClassName`끼리만. 클래스 없는 PV는 클래스를 요청하지 않은(`""`) PVC에만 |
| 접근 모드 | PVC가 요청한 모드를 PV가 지원해야 한다 |
| volumeMode | `Filesystem`(기본)과 `Block`이 같아야 한다 |
| selector | PVC의 `matchLabels`, `matchExpressions`를 모두 만족하는 PV만. 클래스 조건과도 AND |
| 맞는 PV가 없으면 | PVC는 무기한 미바인딩. 맞는 PV가 생기면 그때 묶인다 |
| 네임스페이스 | Pod와 PVC는 같은 네임스페이스. PV 바인딩은 배타적이라 RWX, ROX여도 한 네임스페이스 안에서만 공유 |

특정 PV에 묶고 싶으면 PVC의 `volumeName`에 PV 이름을 적습니다(사전 바인딩). 이때도 클래스, 접근 모드, 크기는 검사합니다. 다른 PVC가 그 PV를 먼저 가져가지 못하게 하려면 PV의 `claimRef`에 PVC를 적어 예약합니다. 지정한 PV가 이미 다른 PVC에 묶여 있으면 바인딩이 `Pending`에 머뭅니다.

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
| `Released` | PVC는 삭제됐지만 아직 회수되지 않음 |
| `Failed` | 자동 회수에 실패 |

PV가 어떤 PVC에 묶였는지는 `kubectl get pv`의 CLAIM 열(`<네임스페이스>/<PVC>`)로 봅니다.

### 3-4. 사용 중인 객체 보호

Pod가 쓰고 있는 PVC를 지우면 바로 사라지지 않습니다(Storage Object in Use Protection). PVC를 쓰는 Pod가 모두 없어질 때까지 삭제가 미뤄지고 그동안 상태는 `Terminating`, Finalizers에는 `kubernetes.io/pvc-protection`이 보입니다. PVC에 묶인 PV를 지울 때는 `kubernetes.io/pv-protection`이 붙습니다.

```bash
kubectl -n shop delete pvc board-files      # 삭제 완료를 기다리느라 명령이 돌아오지 않을 수 있다
kubectl -n shop describe pvc board-files    # Status: Terminating, Finalizers, Used By 확인
kubectl -n shop delete pod board            # Pod를 지우면 PVC 삭제가 진행된다
```

`delete pvc`가 멈춘 것처럼 보이면 `describe pvc`의 `Used By`에서 그 PVC를 쓰는 Pod부터 찾습니다.

### 3-5. 볼륨 확장

| 조건 | 문서 내용 |
|---|---|
| 클래스 | StorageClass의 `allowVolumeExpansion: true`일 때만 PVC를 늘릴 수 있다 |
| 방법 | PVC의 `spec.resources.requests.storage`를 더 큰 값으로 편집. 기존 볼륨을 키운다 |
| 방향 | 늘리기만 가능 |
| 파일시스템 | XFS, Ext3, Ext4일 때만 크기 조정. Pod가 PVC를 쓰는 동안 파일시스템이 늘어난다 |
| 사용 중인 PVC | v1.24 stable. Pod를 다시 만들 필요 없음. 쓰는 Pod가 없으면 파일시스템 확장이 끝나지 않는다 |
| 주의 | PV 크기를 직접 고친 뒤 PVC를 맞추면 실제 크기 조정은 일어나지 않는다 |
| 확장 실패 | 저장소가 들어줄 수 없는 크기를 요청하면 계속 재시도한다. v1.34부터 stable인 `RecoverVolumeExpansionFailure`로 앞서 요청한 값보다 작은 값으로 다시 요청할 수 있다. 단 `.status.capacity`보다는 커야 한다 |

```bash
kubectl -n shop patch pvc order-db-data -p '{"spec":{"resources":{"requests":{"storage":"30Gi"}}}}'
kubectl -n shop get pvc order-db-data -w
```

드라이버가 확장을 지원하지 않으면 `allowVolumeExpansion`을 켜도 진행되지 않습니다. kind 기본 local-path는 `waiting for an external controller`에서 멈췄습니다.

### 3-6. PVC가 Pending일 때 확인 순서

1절과 3-2절을 합친 점검 목록입니다.

| 순서 | 확인 | 명령 |
|---|---|---|
| 1 | Events에 원인이 적혀 있는지 | `kubectl describe pvc <이름>` |
| 2 | 클래스 이름이 PV나 StorageClass와 정확히 같은지 | `kubectl get pvc,pv -o wide`, `kubectl get sc` |
| 3 | `WaitForFirstConsumer` 클래스라 Pod를 기다리는 중인지 | `kubectl get sc <이름>` |
| 4 | 요청 크기 이상의 `Available` PV가 있는지 | `kubectl get pv` |
| 5 | 접근 모드와 volumeMode가 맞는지 | `kubectl get pv <이름> -o yaml` |
| 6 | PVC selector와 PV 라벨이 맞는지 | `kubectl get pv --show-labels` |
| 7 | `volumeName`으로 지정한 PV가 이미 다른 PVC에 묶였는지 | `kubectl get pv`의 CLAIM 열 |
| 8 | 동적 프로비저닝이면 클래스의 프로비저너가 설치돼 있고 컨트롤러 Pod가 도는지 | `kubectl get csidriver`, `kubectl get pod -A \| grep -i csi` |

Events 문구로 갈래를 바로 나눌 수 있습니다. 맞는 정적 PV가 없고 PVC의 클래스 이름에 해당하는 StorageClass도 없으면 크기 이야기 대신 `ProvisioningFailed  storageclass.storage.k8s.io "manual" not found`가 찍힙니다. 맞는 PV가 없어서 그 이름으로 동적 프로비저닝을 시도했다는 뜻이라 "맞는 PV가 없다"와 "프로비저너가 없다"를 함께 봅니다.

### 3-7. 자주 틀리는 지점

- PVC를 Pod와 다른 네임스페이스에 만드는 실수. PV는 네임스페이스가 없지만 PVC는 있습니다.
- `storageClassName`을 PV에만 적고 PVC에는 생략하면 기본 클래스가 PVC에 붙어 PV와 클래스가 달라집니다. 정적 PV 과제에서는 PV와 PVC에 같은 클래스 이름을 쓰거나 둘 다 `""`로 둡니다.
- Pod 스펙의 `persistentVolumeClaim.claimName`에 PV 이름을 적는 실수. Pod는 PV를 직접 참조하지 않습니다.
- 확장할 때 PV 크기를 직접 고치는 실수. 항상 PVC를 고칩니다.

### 3-8. 직접 해 보기

1. 3-1의 PV, PVC, Pod를 만들고 노드의 `/mnt/data`에 `index.html`을 써서 Pod 안에서 보이는지 확인합니다. kind라면 Pod가 뜬 노드 컨테이너 안의 경로입니다.
2. PVC 요청을 20Gi로 바꿔 다시 만들고 `kubectl describe pvc` Events에서 `Pending`의 이유를 읽습니다. 3-6 끝의 `ProvisioningFailed` 문구가 나오는지 봅니다.
3. Pod가 쓰는 PVC를 지워 `Terminating`, `kubernetes.io/pvc-protection`, `Used By: <Pod 이름>`을 확인한 뒤 Pod를 지워 PVC가 사라지는 것을 봅니다.

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

**문제 2.** PVC `order-db-data`가 `Pending`입니다. PVC가 요청한 클래스 `order-fast`의 `VOLUMEBINDINGMODE`가 `WaitForFirstConsumer`이고 이 PVC를 쓰는 Pod는 아직 없습니다. 무엇을 해야 하나요?

<details>
<summary>답 보기</summary>

고칠 것이 없습니다. `WaitForFirstConsumer`는 PVC를 쓰는 Pod가 만들어질 때까지 바인딩과 프로비저닝을 미룹니다. 과제가 바인딩까지 요구하면 그 PVC를 마운트하는 Pod를 만듭니다. 노드를 고정해야 하면 `nodeName` 대신 `nodeSelector`의 `kubernetes.io/hostname`을 씁니다. `nodeName`은 스케줄러를 건너뛰어 PVC가 계속 `Pending`입니다.

</details>

**문제 3.** 동적으로 만들어진 PV `pvc-1a2b...`가 있습니다. PVC를 지워도 데이터가 남도록 바꾸세요.

<details>
<summary>답 보기</summary>

```bash
kubectl patch pv pvc-1a2b... -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'
kubectl get pv pvc-1a2b...
```

`RECLAIM POLICY` 열이 `Retain`이면 됩니다. 앞으로 만들 PV까지 바꾸려면 `reclaimPolicy: Retain`인 StorageClass를 따로 만듭니다.

</details>

**문제 4.** 클러스터에 StorageClass `standard`(기본)와 `order-fast`가 있습니다. 기본을 `order-fast`로 바꾸세요.

<details>
<summary>답 보기</summary>

```bash
kubectl patch storageclass standard -p '{"metadata": {"annotations":{"storageclass.kubernetes.io/is-default-class":"false"}}}'
kubectl patch storageclass order-fast -p '{"metadata": {"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'
kubectl get sc
```

`order-fast` 옆에만 `(default)`가 보여야 합니다. kubectl v1.37은 기본이 둘이어도 실제로 쓰이는 하나에만 `(default)`를 붙이므로 `kubectl get sc standard -o jsonpath='{.metadata.annotations}'`로 이전 기본의 어노테이션이 `"false"`인지도 확인합니다.

</details>

**문제 5.** 노드 하나에서 도는 Pod 두 개가 같은 RWO PVC를 마운트하고 있습니다. 이것이 가능한 이유와 Pod 하나만 쓰게 강제하려면 무엇을 바꿔야 하는지 답하세요.

<details>
<summary>답 보기</summary>

RWO는 노드 하나에서 읽기 쓰기로 마운트하는 모드라서 같은 노드의 여러 Pod가 함께 쓸 수 있습니다. Pod 하나로 강제하려면 접근 모드를 `ReadWriteOncePod`로 요청합니다.

</details>

**문제 6.** PVC `order-db-data`를 20Gi에서 30Gi로 늘리려 했는데 거부됩니다. 가장 먼저 확인할 것은 무엇인가요?

<details>
<summary>답 보기</summary>

PVC가 쓰는 StorageClass의 `allowVolumeExpansion`이 `true`인지 봅니다(`kubectl get sc order-fast -o yaml`). false면 PVC를 늘릴 수 없습니다. 그다음 드라이버가 확장을 지원하는지, 줄이려 한 것은 아닌지 확인합니다.

</details>

**문제 7.** 네임스페이스 `shop`의 PVC `board-files`가 `Pending`이고 Events에는 외부 프로비저너가 볼륨을 만들기를 기다린다는 메시지만 반복됩니다. 클래스는 `Immediate` 모드이고 `provisioner`는 `csi-driver.example-vendor.example`입니다. 어디를 확인하나요?

<details>
<summary>답 보기</summary>

```bash
kubectl get csidriver
kubectl get sc <클래스> -o jsonpath='{.provisioner}{"\n"}'
kubectl get pod -A | grep -i csi
```

드라이버 이름이 클래스의 `provisioner`와 다르거나 드라이버의 컨트롤러 Pod가 없거나 죽어 있으면 아무도 볼륨을 만들지 않아 PVC가 계속 기다립니다. 컨트롤러 Pod가 있으면 `kubectl logs`로 프로비저너 컨테이너 로그를 봅니다.

</details>

**문제 8.** 네임스페이스 `shop`의 Pod `report`에 이름이 `scratch`인 generic ephemeral volume이 있습니다. 만들어지는 PVC의 이름과 Pod를 지웠을 때 PVC가 어떻게 되는지 답하세요.

<details>
<summary>답 보기</summary>

PVC 이름은 `report-scratch`입니다. Pod가 이 PVC의 소유자이므로 Pod를 지우면 PVC도 지워집니다. 클래스의 회수 정책이 `Delete`(기본값)이면 PV와 실제 볼륨도 지워지고 `Retain`이면 PV가 `Released`로 남아 따로 정리해야 합니다.

</details>

## 5. 범위와 한계

- 명령과 YAML은 kind v1.37(기본 StorageClass `standard` = local-path-provisioner)에서 2026년 10월에 직접 돌려 확인했습니다. 확장과 VolumeAttachment는 local-path가 지원하지 않아 예제 드라이버 csi-driver-host-path로 확인했습니다.
- 클라우드 디스크 CSI 드라이버, NFS 같은 RWX 볼륨, 여러 노드에 걸친 attach와 detach는 돌리지 못했습니다. 시험 환경에 어떤 프로비저너와 StorageClass가 준비되어 있는지는 공식 문서에 없으니 `kubectl get sc`부터 봅니다.
- 볼륨 스냅샷, 복제, 원시 블록 볼륨은 커리큘럼 문구에 없어 다루지 않았습니다. `RecoverVolumeExpansionFailure`(v1.34 stable)처럼 버전에 따라 바뀌는 항목은 시험 기준 버전의 문서로 다시 확인합니다.

## 참고 자료

시험 범위
- CNCF, [CKA Curriculum v1.37](https://github.com/cncf/curriculum/blob/master/CKA_Curriculum_v1.37.pdf)

kubernetes.io
- [Persistent Volumes](https://kubernetes.io/docs/concepts/storage/persistent-volumes/)
- [Storage Classes](https://kubernetes.io/docs/concepts/storage/storage-classes/)
- [Dynamic Volume Provisioning](https://kubernetes.io/docs/concepts/storage/dynamic-provisioning/)
- [Volumes](https://kubernetes.io/docs/concepts/storage/volumes/)
- [Ephemeral Volumes](https://kubernetes.io/docs/concepts/storage/ephemeral-volumes/)
- [Configure a Pod to Use a PersistentVolume for Storage](https://kubernetes.io/docs/tutorials/configuration/configure-persistent-volume-storage/)
- [Change the Reclaim Policy of a PersistentVolume](https://kubernetes.io/docs/tasks/administer-cluster/change-pv-reclaim-policy/)
- [Change the default StorageClass](https://kubernetes.io/docs/tasks/administer-cluster/change-default-storage-class/)

이 블로그의 관련 글
- [쿠버네티스 아래의 리눅스 4: OverlayFS](/blog/theory/systems/k8s-linux-04-overlayfs) (시험 범위 밖 심화)

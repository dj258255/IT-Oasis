---
title: '[CKA] 스토리지: PVC가 Pending에 머무는 이유를 바인딩 규칙으로 읽기'
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
seriesOrder: 8
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

<details>
<summary>기초부터: 컨테이너는 왜 데이터를 잃나 (이미지 레이어, CoW, 볼륨)</summary>

> **핵심 한 줄**: 컨테이너가 쓰는 파일은 이미지 위에 얹힌 얇은 쓰기 층에 들어가고 그 층은 컨테이너와 함께 사라집니다. 남길 데이터는 쓰기 층 밖의 볼륨에 둡니다.

#### 1. 왜 필요한가

DB 컨테이너가 재시작됐더니 테이블이 비어 있는 상황이 이 구조에서 나옵니다. 쿠버네티스에서는 컨테이너가 재시작되면 새 컨테이너가 새 쓰기 층으로 시작하므로 이전 파일이 보이지 않습니다.

#### 2. 어떻게 동작하나

1. **이미지 레이어**: Dockerfile의 `FROM`, `RUN`, `COPY`는 명령마다 바뀐 파일만 담은 층을 하나씩 만듭니다. 완성된 레이어는 읽기 전용이라 여러 이미지와 컨테이너가 함께 씁니다. 같은 베이스 이미지 컨테이너가 열 개여도 베이스 레이어는 디스크에 한 벌이고 빌드 캐시도 이 구조 덕분입니다.
2. **쓰기 층 얹기**: 컨테이너를 시작하면 런타임이 맨 위에 쓰기 가능한 층을 하나 얹고 층들을 겹쳐 하나의 파일 시스템처럼 보여 줍니다. 컨테이너가 만든 파일, 로그, DB 데이터는 모두 여기에 들어갑니다.
3. **Copy-on-Write(CoW)**: 이미지에 있던 파일을 고치면 원본 레이어는 두고 그 파일을 쓰기 층으로 복사한 뒤 복사본을 고칩니다. 큰 파일일수록 처음 고칠 때 복사 비용이 커서 DB처럼 쓰기가 많은 데이터를 쓰기 층에 두면 느립니다.
4. **삭제**: 쓰기 층은 그 컨테이너의 것이라 컨테이너가 지워지면 함께 지워집니다.

```text
merged (컨테이너가 보는 화면)
  ├─ upperdir  쓰기 층 (컨테이너마다 하나, 컨테이너와 함께 삭제)
  └─ lowerdir  이미지 레이어들 (읽기 전용, 여러 컨테이너가 공유)
       COPY 층 / RUN 층 / FROM 베이스 층

볼륨: 호스트나 외부 저장소의 디렉터리 → 컨테이너 경로에 마운트 (쓰기 층 밖, 컨테이너가 지워져도 남음)
```

층을 겹쳐 보여 주는 일은 스토리지 드라이버(지금은 대부분 overlay2, containerd에서는 overlayfs snapshotter)가 합니다. Docker 단독 환경에서는 `/var/lib/docker/overlay2`, 쿠버네티스 노드의 containerd에서는 `/var/lib/containerd` 아래에 있습니다.

| 스토리지 드라이버 | Docker 문서 기준 상태 |
|---|---|
| `overlay2` | 지금의 기본. 가장 안정적이고 배포판 호환성이 넓다 |
| `aufs` | 예전 Ubuntu 기본. 리눅스 메인라인 커널에 들어간 적이 없어 배포판이 따로 패치를 얹어야 했다. v19.03에서 사용 중단, Docker Engine v24.0에서 제거 |
| `devicemapper` | 예전 RHEL/CentOS 계열. 설정 없이 쓰면 loop-lvm 모드(희소 파일을 루프 장치로 붙임)였는데 이 모드는 느리고 운영에 쓰면 안 되며 운영에는 블록 장치를 쓰는 direct-lvm을 써야 했다. v18.09에서 사용 중단, v25.0에서 제거 |

Docker에서 `docker inspect <컨테이너>`를 보면 `GraphDriver.Data`에 위 그림의 경로가 그대로 나옵니다. `LowerDir`(이미지 레이어들), `UpperDir`(쓰기 층), `MergedDir`(합쳐 보이는 화면), `WorkDir`(커널이 복사 작업에 쓰는 작업 공간)입니다. 네 디렉터리의 커널 쪽 동작은 [쿠버네티스 아래의 리눅스 4편](/blog/theory/systems/k8s-linux-04-overlayfs)에 있습니다.

#### 3. 한눈에 비교

| 방식 | 명령 예 | 디렉터리 위치 |
|---|---|---|
| 볼륨 마운트 | `docker run --mount type=volume,source=order_data,target=/var/lib/mysql mysql` | Docker가 관리(`/var/lib/docker/volumes/`) |
| 바인드 마운트 | `docker run --mount type=bind,source=/data/mysql,target=/var/lib/mysql mysql` | 사용자가 지정한 호스트 경로 |

`-v order_data:/var/lib/mysql`처럼 짧게 쓸 수도 있습니다. Docker 문서는 옵션이 이름으로 드러나고 모든 옵션을 받는 `--mount`를 권합니다.

- 볼륨은 `docker volume create order_data`로 미리 만들 수 있고 없는 볼륨 이름으로 `docker run`을 하면 Docker가 그 자리에서 만듭니다.
- 바인드 마운트는 호스트 경로를 그대로 쓰므로 개발 중 소스 디렉터리를 컨테이너에 비출 때 주로 씁니다.

| 구분 | 스토리지 드라이버 | 볼륨 드라이버 |
|---|---|---|
| 맡는 일 | 이미지 레이어와 쓰기 층 관리 | 볼륨을 만들고 마운트 |
| 예 | overlay2, overlayfs snapshotter | Docker 기본 `local`(호스트 디스크), 서드파티 플러그인(클라우드 디스크, NFS) |
| 쿠버네티스에서 | 런타임 내부 | CSI 드라이버가 이 자리를 맡고 PV, PVC, StorageClass가 그 위에 있다(2-4절) |

Docker에서 볼륨 드라이버를 고르는 자리는 `docker volume create --driver <드라이버> <이름>`이나 `docker run --mount type=volume,source=<이름>,target=<경로>,volume-driver=<드라이버>`입니다. 드라이버가 클라우드 디스크나 NAS를 붙이면 데이터가 호스트 밖에 있으므로 컨테이너나 호스트가 사라져도 남습니다. 쿠버네티스에서는 이 생각이 2-1절의 볼륨 타입과 2-4절의 CSI로 이어집니다.

#### 4. 빌드 캐시와 CI 환경

레이어 캐시는 같은 호스트에서 다시 빌드할 때만 이득이 납니다. 매번 새 러너나 새 Pod에서 빌드하는 CI는 캐시가 비어서 시작합니다.

1. **BuildKit의 빌드 그래프**: 지금 Docker의 빌더인 BuildKit은 빌드 정의를 LLB라는 의존 그래프로 바꾸고 각 단계를 체크섬으로 추적합니다. 문서 기준으로 서로 의존하지 않는 스테이지는 병렬로 빌드하고 최종 결과에 쓰이지 않는 스테이지는 건너뜁니다.
2. **원격 캐시**: `docker buildx build --cache-to type=registry,ref=<레지스트리>/<캐시 이미지> --cache-from type=registry,ref=<같은 곳>`처럼 캐시를 레지스트리에 내보내고 다음 빌드가 받아 씁니다. 백엔드는 `inline`, `registry`, `local`, `gha`(GitHub Actions 캐시, 문서 기준 beta) 등이 있습니다.
3. **캐시 범위**: `mode=min`(기본)은 최종 이미지에 들어간 레이어만, `mode=max`는 중간 스테이지 레이어까지 내보냅니다. `max`는 캐시가 커지는 대신 적중이 늘어납니다.

| 방식 | 장점 | 한계 |
|---|---|---|
| CI 러너에 디스크(블록 볼륨)를 붙여 캐시 보관 | 로컬 디스크 속도 | 블록 디스크는 한 존에 묶이고 RWO라 동시에 도는 빌드끼리 같은 디스크를 쓸 수 없다 |
| 레지스트리 원격 캐시 | 존과 동시성 제약이 없다 | 캐시를 올리고 받는 네트워크 시간이 든다 |

- 기본 `docker` 드라이버는 containerd 이미지 저장소를 켰을 때만 registry 캐시를 내보냅니다. 아니면 `docker buildx create`로 다른 드라이버의 빌더를 만듭니다.
- 큰 캐시를 올리는 시간이 배포를 늦춘다면 캐시 내보내기를 배포와 다른 작업으로 떼어 놓는 구성도 씁니다. 대신 그 작업이 끝나기 전에 시작한 다음 빌드는 이전 캐시를 받습니다.

> **정리**: 이미지 레이어는 여러 컨테이너가 함께 쓰는 읽기 전용이고 쓰기 층은 컨테이너마다 하나씩 붙는 일회용입니다. 쓰기가 많은 DB 데이터는 CoW 비용 때문에도 볼륨으로 빼고 쿠버네티스에서는 그 볼륨을 아래 PV, PVC로 다룹니다.

</details>

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

PV의 수명은 Pod와 무관하고 `emptyDir` 같은 임시 볼륨은 Pod와 함께 사라집니다. 컨테이너 자체의 쓰기 레이어는 컨테이너가 다시 시작되면 비워지므로 남겨야 할 데이터는 볼륨에 둡니다. 쓰기 레이어의 커널 쪽 구조(OverlayFS)는 시험 범위 밖이라 [쿠버네티스 아래의 리눅스 4편](/blog/theory/systems/k8s-linux-04-overlayfs)에 따로 두었습니다.

## 1. StorageClass와 동적 프로비저닝

### 1-1. StorageClass가 하는 일

<details>
<summary>기초부터: 정적 프로비저닝의 불편과 StorageClass</summary>

> **핵심 한 줄**: StorageClass는 "이런 종류의 디스크를 이 프로비저너로 만든다"는 설계도입니다. PVC가 들어올 때 요청한 크기대로 디스크와 PV를 그 자리에서 만듭니다.

#### 1. 왜 필요한가

| 구분 | 정적 프로비저닝(3절) | 동적 프로비저닝(StorageClass) |
|---|---|---|
| 준비 | PVC가 생길 때마다 관리자가 디스크와 PV를 미리 만든다 | PVC가 들어오면 프로비저너가 만든다 |
| 크기 | 일대일 바인딩이라 맞는 PV가 없으면 큰 PV가 묶인다. 1Gi 요청에 100Gi PV만 있으면 99Gi를 다른 PVC가 못 쓴다 | 요청한 크기대로 만들어 남는 용량이 없다 |

주문이 들어오면 그 크기로 만들어 줍니다.

#### 2. 어떻게 동작하나

1. **PVC 생성**: 사용자가 `storageClassName: order-fast`, 크기 20Gi로 PVC를 만듭니다.
2. **프로비저너가 감지**: 그 클래스의 `provisioner` 이름을 맡은 프로비저너(CSI 드라이버라면 external-provisioner 사이드카)가 PVC를 watch하다가 새 PVC를 봅니다. 클래스가 `WaitForFirstConsumer`면 그 PVC를 쓰는 Pod가 노드에 배정될 때까지 기다립니다.
3. **볼륨 생성**: 프로비저너가 `parameters`를 붙여 저장소에 20Gi 볼륨을 만듭니다.
4. **PV 생성**: 프로비저너가 그 볼륨을 가리키는 PV를 만들고 클래스의 `reclaimPolicy`를 PV에 적습니다.
5. **바인딩**: PV와 PVC가 묶여 `Bound`가 되고 Pod가 마운트합니다.

```text
PVC(order-fast, 20Gi) ──storageClassName──→ StorageClass order-fast
                                              │ provisioner: <CSI 드라이버 이름>
                                              │ parameters, reclaimPolicy
                                              ▼
                                   프로비저너(external-provisioner)
                                              │ 저장소에 20Gi 볼륨 생성
                                              ▼
                                   PV(20Gi, reclaimPolicy 복사) ──Bound──→ PVC → Pod 마운트
```

#### 3. 등급 나누기

| 클래스 이름(예) | 뜻 |
|---|---|
| `standard` | 싸고 느린 디스크 |
| `fast` | 빠른 SSD |
| `replicated` | 복제가 붙은 결제 DB용 |

사용자는 PVC의 `storageClassName`만 바꿔 다른 등급을 고릅니다. 클래스가 실제로 무엇을 뜻하는지는 `provisioner`와 `parameters`가 정하고 쿠버네티스는 관여하지 않습니다.

#### 4. 실전에서 보이는 모습

- `WaitForFirstConsumer` 클래스의 PVC는 Pod가 생길 때까지 `Pending`인 것이 정상입니다(1-4절). Events의 `waiting for first consumer to be created before binding` 문구는 1-7절 실습에서 확인합니다.
- `provisioner` 이름이 설치된 CSI 드라이버와 다르면 아무도 볼륨을 만들지 않아 PVC가 `Pending`에 머뭅니다(2-4절).

> **정리**: 정적 방식은 미리 만들어 두고 기다리고 동적 방식은 주문을 받고 만듭니다. 어떤 디스크가 나올지는 클래스의 `provisioner`와 `parameters`가 정합니다.

</details>

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

Dynamic Volume Provisioning 문서 기준 순서입니다.

1. 관리자가 StorageClass를 하나 이상 만듭니다.
2. 사용자가 PVC의 `storageClassName`에 그 클래스 이름을 적습니다(옛 `volume.beta.kubernetes.io/storage-class` 어노테이션은 사용 중단).
3. 정적으로 만든 PV 중 맞는 것이 없으면 클러스터가 그 PVC만을 위한 볼륨을 동적으로 만듭니다.
4. 동적으로 만든 PV는 항상 그 PVC에 묶입니다.

`storageClassName: ""`로 적은 PVC는 동적 프로비저닝을 스스로 끕니다. selector가 비어 있지 않은 PVC에도 PV를 동적으로 만들 수 없습니다.

### 1-3. 기본 StorageClass

PVC가 `storageClassName`을 적지 않으면 기본 StorageClass가 쓰입니다. StorageClass 하나에 어노테이션 `storageclass.kubernetes.io/is-default-class: "true"`가 있어야 하고 API 서버의 `DefaultStorageClass` 승인 컨트롤러(기본 켜짐)가 클래스를 생략한 PVC에 그 이름을 채워 넣습니다.

기본 클래스는 `kubectl get sc`에서 이름 옆에 `(default)`로 표시됩니다. 기본을 바꿀 때는 Change the default StorageClass 문서대로 기존 기본 클래스의 어노테이션을 `"false"`로, 새 클래스의 어노테이션을 `"true"`로 바꿉니다.

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

PVC에 `storageClassName`을 쓰는 방법은 세 가지이고 결과가 모두 다릅니다. 정적 PV 과제에서 점수를 잃는 곳이 대부분 여기입니다.

| PVC에 적은 값 | API 서버가 저장하는 값 | 묶일 수 있는 PV |
|---|---|---|
| 필드를 아예 안 씀 | 기본 클래스 이름이 채워짐(기본 클래스가 있을 때) | 그 기본 클래스의 PV, 없으면 동적 프로비저닝 |
| `storageClassName: ""` | 빈 문자열 그대로 | 클래스가 없는 PV만. 동적 프로비저닝은 일어나지 않음 |
| `storageClassName: manual` | `manual` | `storageClassName: manual`인 PV. 맞는 PV가 없으면 `manual`이라는 StorageClass로 동적 프로비저닝을 시도 |

그래서 관리자가 `manual` 클래스로 만든 PV에 PVC를 묶으려는데 PVC 쪽 필드를 빠뜨리면 기본 클래스(kind라면 `standard`)가 채워져 클래스가 어긋납니다. 묶일 PV가 없으니 PVC는 `standard`의 프로비저너가 새 볼륨을 만들어 줄 때까지 기다리거나 엉뚱한 새 볼륨에 묶입니다.

### 1-4. volumeBindingMode

| 값 | 바인딩과 프로비저닝 시점 | 쓰는 곳 |
|---|---|---|
| `Immediate` (기본) | PVC를 만들자마자 | 모든 노드에서 접근 가능한 저장소 |
| `WaitForFirstConsumer` | PVC를 쓰는 Pod가 만들어질 때까지 미룸. Pod의 스케줄링 제약(자원 요청, 노드 셀렉터, 어피니티, 테인트와 톨러레이션)을 보고 PV를 고르거나 만든다 | 특정 노드나 존에 묶인 저장소, `local` 볼륨 |

`Immediate`로 특정 존에만 있는 저장소를 쓰면 Pod의 스케줄링 요구를 모른 채 PV가 정해져 Pod를 어디에도 둘 수 없게 될 수 있습니다.

말로만 보면 감이 오지 않으니 주문 DB로 따라가 보겠습니다. 클라우드 블록 디스크는 만들어진 존(데이터센터 한 곳)의 노드에만 붙일 수 있습니다.

![같은 PVC를 Immediate와 WaitForFirstConsumer로 만들 때의 차이. Immediate는 PVC를 만들자마자 존 a에 디스크를 만들고 나중에 온 Pod는 자리가 있는 존 c 노드로만 갈 수 있어 Pending이 된다. WaitForFirstConsumer는 Pod가 존 c 노드를 받은 뒤 존 c에 디스크를 만들어 Bound가 된다](/uploads/cert/cka/cka-05-storage/binding-mode-zones.svg)

1. **`Immediate`**: PVC `order-db-data`를 만드는 순간 프로비저너가 디스크를 만듭니다. 아직 이 디스크를 쓸 Pod가 없으니 프로비저너는 존을 아무렇게나 고르고 존 a에 만들었다고 하겠습니다.
2. 이제 주문 DB Pod를 만듭니다. 스케줄러는 PV의 노드 어피니티(존 a)와 Pod의 요구(메모리 8Gi)를 함께 맞춰야 하는데 존 a의 노드는 메모리가 꽉 찼고 여유가 있는 노드는 존 c에만 있습니다.
3. 두 조건을 동시에 만족하는 노드가 없어 Pod는 `Pending`에 머물고 Events에 `volume node affinity conflict`가 찍힙니다. 디스크를 지우고 다시 만들기 전에는 풀리지 않습니다.
4. **`WaitForFirstConsumer`**: PVC는 `Pending`으로 기다립니다. Pod가 만들어지면 스케줄러가 메모리, 테인트, 어피니티를 모두 보고 존 c 노드를 고른 뒤 그 존에 디스크를 만들게 합니다. 순서가 바뀌었을 뿐인데 충돌이 생길 틈이 없습니다.

Kubernetes 블로그는 이 기능을 소개하면서 예전 방식의 문제를 셋으로 꼽았습니다. 볼륨이 만들어진 존에 CPU나 메모리가 모자란 경우, 노드 셀렉터나 어피니티와 맞지 않는 경우, 테인트 때문에 Pod를 못 두는 경우입니다. 볼륨을 여러 개 쓰는 Pod라면 볼륨마다 다른 존에 만들어져 어디에도 못 가는 일도 있었다고 적었습니다([Topology-Aware Volume Provisioning in Kubernetes](https://kubernetes.io/blog/2018/10/11/topology-aware-volume-provisioning-in-kubernetes/), 2018).

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

<details>
<summary>기초부터: 볼륨이 필요한 이유와 hostPath의 한계</summary>

> **핵심 한 줄**: 볼륨은 Pod 스펙에 정의해 컨테이너 경로에 마운트하는 디렉터리이고 볼륨 타입이 그 디렉터리가 실제로 어디 있는지 정합니다. hostPath는 노드 한 대의 디렉터리라서 Pod가 다른 노드로 가면 데이터를 찾지 못합니다.

#### 1. 왜 필요한가

0절 토글에서 본 것처럼 컨테이너의 쓰기 층은 컨테이너와 함께 사라집니다. 그래서 Pod 스펙의 `volumes`에 볼륨을 정의하고 `volumeMounts`로 컨테이너 경로에 붙입니다.

#### 2. hostPath로 따라가 보기

```yaml
spec:
  containers:
  - name: app
    image: busybox:1.36
    command: ["sh", "-c", "echo $RANDOM >> /opt/number.txt; sleep 3600"]
    volumeMounts:
    - name: data
      mountPath: /opt            # 컨테이너 안 경로
  volumes:
  - name: data
    hostPath:
      path: /data                # 노드의 경로
      type: DirectoryOrCreate
```

1. **마운트**: kubelet이 Pod를 띄우면서 노드의 `/data`를 컨테이너의 `/opt`에 마운트합니다.
2. **쓰기**: 컨테이너가 `/opt/number.txt`에 쓴 내용은 실제로 노드의 `/data/number.txt`에 저장됩니다.
3. **Pod 삭제**: Pod를 지워도 노드의 `/data`는 남습니다.

#### 3. 노드가 여럿이면 생기는 문제

```text
1회차: Pod → 노드1 /data (number.txt 있음)
Pod 삭제 후 재생성, 스케줄러가 노드2 선택
2회차: Pod → 노드2 /data (비어 있음)   ← 데이터는 노드1에 그대로 있는데 찾지 못함

노드 밖 저장소를 쓰면:
Pod(노드1 또는 노드2) → PVC → PV → CSI 드라이버 → NFS, Ceph, 클라우드 디스크 (같은 데이터)
```

노드의 디스크는 노드끼리 동기화되지 않습니다. hostPath는 노드의 파일 시스템을 그대로 열어 주는 것이라 보안 위험도 큽니다. 그래서 문서는 hostPath를 단일 노드 테스트나 노드 단위 시스템 구성요소에 쓰는 것으로 봅니다.

#### 4. 한눈에 비교

| 구분 | hostPath | 노드 밖 저장소(CSI + PVC) |
|---|---|---|
| 데이터 위치 | Pod가 뜬 노드의 디렉터리 | NFS, Ceph, 클라우드 블록 디스크 등 |
| 다른 노드로 옮기면 | 빈 디렉터리를 본다 | 같은 데이터를 본다(저장소가 허용하는 범위에서) |
| 쓰임 | 단일 노드 테스트, 노드 단위 시스템 구성요소 | 일반 앱 데이터 |

#### 5. 헷갈리는 점

- 옛 자료의 `awsElasticBlockStore`, `gcePersistentDisk`, `cephfs`처럼 Pod 스펙에 저장소를 직접 적던 in-tree 타입은 CSI로 옮겨졌거나 제거됐습니다.

> **정리**: Pod가 어느 노드로 옮겨 가도 같은 데이터를 보게 하려면 노드 밖 저장소를 CSI와 PVC로 연결합니다. hostPath는 단일 노드 테스트나 노드 단위 시스템 구성요소에 씁니다.

</details>

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

문서상 `hostPath` PV는 단일 노드 테스트 전용이지만 공식 튜토리얼과 연습 과제는 PV 개념을 보여 주려고 `hostPath` PV를 자주 씁니다.

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
- `ReadWriteOncePod`는 문서상 CSI 볼륨 전용입니다. 다만 kind의 local-path(hostPath PV)에서도 RWOP PVC가 묶였고 같은 PVC를 쓰는 두 번째 Pod는 `unavailable due to PersistentVolumeClaim with ReadWriteOncePod`로 스케줄되지 않았습니다.

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

왜 `claimRef`를 지워야 하는지는 PV 컨트롤러가 짝을 확인하는 방법을 보면 풀립니다.

![PV 상태가 바뀌는 길. Available에서 맞는 PVC가 생기면 Bound가 되고 claimRef에 PVC 이름과 UID가 적힌다. PVC를 지우면 Released가 되고 claimRef에는 지운 PVC의 UID가 남는다. Delete 정책이면 PV와 디스크가 지워지고 Retain 정책이면 Released로 남는다. 관리자가 claimRef 전체나 uid만 지우면 다시 Available이 된다](/uploads/cert/cka/cka-05-storage/pv-states.svg)

1. PV가 묶이면 `claimRef`에 PVC의 네임스페이스와 이름, 그리고 UID가 적힙니다. UID는 객체를 만들 때마다 새로 받는 고유 번호라서 같은 이름으로 지웠다 다시 만들어도 값이 달라집니다.
2. PVC를 지우면 컨트롤러는 `claimRef`가 가리키는 PVC를 찾다가 없거나 UID가 다르면 "주인이 사라졌다"고 보고 PV를 `Released`로 바꿉니다.
3. 이 상태에서 같은 이름으로 PVC를 다시 만들어도 UID가 다르니 컨트롤러는 옛 주인이 돌아온 것으로 보지 않습니다. 이전 데이터를 엉뚱한 PVC가 받지 않게 하는 안전장치입니다.
4. `claimRef`를 통째로 지우면 PV는 `Available`이 되고 조건이 맞는 아무 PVC에나 묶일 수 있습니다.

PV 컨트롤러 소스(`pv_controller.go`)에는 중간 방법도 보입니다. `claimRef`의 이름은 두고 `uid`만 지우면 컨트롤러가 "이 PVC를 위해 예약된 PV"로 보고 `Available`로 바꿉니다. 그러면 같은 이름의 PVC만 이 PV를 가져갈 수 있습니다. 소스와 커뮤니티 글로 확인한 내용이고 이 글을 쓰면서 직접 돌려 보지는 않았습니다.

```bash
kubectl patch pv <PV 이름> --type=json -p '[{"op":"remove","path":"/spec/claimRef/uid"}]'
```

`kubectl patch`가 두 모양으로 나와서 헷갈릴 수 있습니다. `--type`을 생략하면 strategic merge patch라서 적은 필드를 기존 객체에 합칩니다(회수 정책을 바꿀 때). 필드를 지우려면 "이 경로를 지워라"를 직접 적는 JSON patch(`--type=json`, `op: remove`)를 씁니다. 세 번째 형식인 `--type=merge`도 있습니다([kubectl patch](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_patch/)).

Delete와 Retain을 나란히 돌려 보고 `Released` PV를 되살리는 연습은 iximiuz Labs의 [PV reclaim policies 챌린지](https://labs.iximiuz.com/challenges/kubernetes-pv-reclaim-policies-5395f28c)에 있습니다(가입 필요).

### 2-4. CSI 드라이버와 프로비저너 이름

<details>
<summary>기초부터: CSI가 생긴 이유와 볼륨이 만들어지고 붙는 순서</summary>

> **핵심 한 줄**: CSI(Container Storage Interface)는 저장소 코드를 쿠버네티스 밖으로 떼어 낸 표준 gRPC 규격입니다. 볼륨은 만들기(CreateVolume), 노드에 붙이기(ControllerPublish), 마운트하기(NodeStage, NodePublish) 순서로 Pod에 닿습니다.

#### 1. 왜 필요한가

| 구분 | 예전(in-tree) | 지금(CSI) |
|---|---|---|
| 저장소 코드 위치 | 쿠버네티스 소스 안 | 업체가 따로 배포하는 드라이버 |
| 새 저장소 지원, 버그 수정 | 쿠버네티스 릴리스를 기다린다 | 드라이버만 새로 배포한다 |
| 설치 | 쿠버네티스에 포함 | 관리자가 클러스터에 설치 |

런타임은 CRI, 네트워크는 CNI로 떼어 냈듯 저장소도 표준 인터페이스로 떼어 냈습니다. CSI 규격은 다른 컨테이너 오케스트레이터도 쓰는 공용 규격입니다.

#### 2. 규격의 내용은 RPC 목록

CSI는 드라이버가 구현해야 할 gRPC 호출과 각 호출의 인자, 오류 코드를 정합니다. 쿠버네티스 쪽에서는 드라이버 옆에 붙은 사이드카 컨테이너와 kubelet이 이 호출을 합니다.

| 호출 | 부르는 쪽 | 하는 일 |
|---|---|---|
| `CreateVolume` / `DeleteVolume` | external-provisioner | 저장소에 볼륨을 만들고 지운다 |
| `ControllerPublishVolume` | external-attacher | 볼륨을 노드에 붙인다(클라우드 디스크를 VM에 연결) |
| `NodeStageVolume` | kubelet | 노드의 공통 경로에 포맷하고 마운트 |
| `NodePublishVolume` | kubelet | Pod 경로에 마운트 |

#### 3. 동적 PVC 하나가 Pod에 붙기까지

1. **만들기**: PVC가 만들어지면 external-provisioner가 드라이버에 `CreateVolume`을 부릅니다(`Immediate`면 바로, `WaitForFirstConsumer`면 Pod가 노드에 배정된 뒤). 저장소에 볼륨이 생기고 PV가 만들어집니다.
2. **붙이기**: Pod가 노드에 배정되면 attach가 필요한 드라이버의 경우 VolumeAttachment 객체가 생기고 external-attacher가 `ControllerPublishVolume`으로 볼륨을 그 노드에 붙입니다.
3. **마운트**: 그 노드의 kubelet이 드라이버의 노드 Pod에 `NodeStageVolume`과 `NodePublishVolume`을 부릅니다.
4. **사용**: 컨테이너가 시작되면 마운트된 경로를 씁니다.

```text
Pod ──claimName──→ PVC ──Bound──→ PV ←──만듦── external-provisioner
                    │                              ↑ (CreateVolume)
                    └─storageClassName─→ StorageClass(provisioner = CSI 드라이버 이름)

[Pod가 노드에 배정된 뒤]
VolumeAttachment → external-attacher ─ControllerPublishVolume→ 저장소 볼륨을 노드에 연결
kubelet ─NodeStageVolume→ 노드 공통 경로 ─NodePublishVolume→ Pod 경로 → 컨테이너
```

#### 4. 헷갈리는 점

- 정리는 거꾸로 갑니다. Pod가 지워지면 언마운트와 detach가 일어나고 볼륨은 남습니다.
- `DeleteVolume`은 PVC가 지워지고 PV의 회수 정책이 `Delete`일 때 불립니다. Pod를 지운다고 저장소의 볼륨이 지워지지는 않습니다.

> **정리**: Pod를 지우면 언마운트와 detach만 일어나고 저장소의 볼륨은 PVC가 지워지고 회수 정책이 `Delete`일 때 지워집니다. 고리의 출발점은 StorageClass의 `provisioner`가 가리키는 드라이버 이름이라 아래 명령으로 하나씩 따라가며 확인합니다.

</details>

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

<details>
<summary>기초부터: PV와 PVC를 나눈 이유</summary>

> **핵심 한 줄**: PV는 "실제 저장소가 여기 있다"는 공급이고 PVC는 "이만큼 필요하다"는 요청입니다. Pod는 PVC 이름만 알고 저장소의 세부는 PV 뒤에 숨습니다.

#### 1. 왜 필요한가

Pod 수백 개의 스펙에 NFS 서버 주소나 디스크 ID를 직접 적었다고 하겠습니다.

| 문제 | 저장소 정보를 Pod에 직접 적으면 | PV와 PVC로 나누면 |
|---|---|---|
| 저장소 이전 | Pod 수백 개를 모두 고친다 | 관리자가 PV 쪽만 바꾼다 |
| 앱 담당자의 부담 | 저장소의 세부 정보까지 알아야 한다 | "이 클래스로 RWO 20Gi"만 적는다 |
| 다른 클러스터로 이식 | 매니페스트가 동작하지 않는다 | Pod와 PVC 매니페스트를 그대로 쓴다 |

#### 2. 요청과 공급

| 구분 | PV | PVC |
|---|---|---|
| 누가 만드나 | 관리자(또는 StorageClass 프로비저너) | 앱 담당자 |
| 담는 내용 | 실제 저장소가 어디 있고 크기와 접근 모드가 무엇인지 | "이 클래스로 RWO 20Gi가 필요하다"는 요청 |
| 범위 | 클러스터 전체 | 네임스페이스 |

#### 3. 묶이는 과정

1. **PV 준비**: 관리자가 PV를 만들면 `Available`입니다.
2. **PVC 요청**: 사용자가 PVC를 만들면 컨트롤 플레인의 PV 컨트롤러가 클래스, 접근 모드, 크기가 맞는 PV를 찾습니다.
3. **바인딩**: 맞는 PV가 있으면 일대일로 묶고 둘 다 `Bound`가 됩니다. PV의 `claimRef`에 PVC가, PVC의 `volumeName`에 PV가 적힙니다.
4. **대기**: 맞는 PV가 없으면 PVC는 `Pending`으로 기다리다가 맞는 PV가 생기면 그때 묶입니다.
5. **사용**: Pod가 `persistentVolumeClaim.claimName`으로 그 PVC를 마운트합니다.

```text
[네임스페이스 shop]                         [클러스터 범위]
Pod ──claimName──→ PVC (3Gi, RWO) ──Bound──→ PV (10Gi, RWO, Available→Bound)
                     volumeName: <PV>  ←→    claimRef: shop/<PVC>
                                              └─→ 실제 저장소(hostPath, NFS, 클라우드 디스크)
```

#### 4. 헷갈리는 점 / 실전에서 보이는 모습

- 일대일이라 요청보다 큰 PV가 묶이면 남는 용량은 다른 PVC가 쓰지 못합니다. 아래 예에서 3Gi 요청이 10Gi PV에 묶이는 것이 그 경우입니다.
- 맞는 볼륨이 없으면 PVC는 무기한 묶이지 않은 채로 남고 맞는 볼륨이 생기면 그때 묶입니다(Persistent Volumes 문서). 50Gi PV만 여럿 있는 클러스터에서 100Gi PVC는 100Gi PV가 추가될 때까지 `Pending`입니다.
- Pod가 쓰는 PVC를 지우면 `Terminating`에 머물고 Finalizers에 `kubernetes.io/pvc-protection`이 보입니다(3-4절).
- PVC를 지운 뒤 PV를 어떻게 할지는 회수 정책이 정합니다(2-3절). 볼륨을 `rm -rf`로 비워 다시 내주던 `Recycle`은 사용 중단됐고 문서는 그 대신 동적 프로비저닝을 쓰라고 권합니다. 요청이 올 때마다 새 볼륨을 만들고 다 쓰면 `Delete`로 지우는 흐름입니다.

> **정리**: 공급(PV)과 요청(PVC)을 나눠 앱과 저장소를 떼어 놓았습니다. 정적 PV에서 생기는 남는 용량과 미리 만드는 수작업은 1절의 동적 프로비저닝으로 줄입니다.

</details>

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

`Retain` 정책의 PV를 다시 쓸 때 이 방법이 유용합니다(Persistent Volumes 문서).

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

"쓰는 Pod가 없으면 파일시스템 확장이 끝나지 않는다"는 줄은 확장이 두 단계라서 나옵니다.

| 단계 | 누가 | 하는 일 | PVC 조건(`kubectl describe pvc`의 Conditions) |
|---|---|---|---|
| 1. 볼륨 키우기 | 컨트롤 플레인 쪽(CSI라면 external-resizer) | 저장소에 디스크 크기를 20Gi에서 30Gi로 늘려 달라고 요청 | `Resizing` |
| 2. 파일시스템 키우기 | 그 볼륨을 마운트한 노드의 kubelet | 디스크 위의 ext4, XFS를 새 크기만큼 넓힘 | `FileSystemResizePending` |

1단계가 끝나도 파일시스템은 아직 20Gi라서 Pod 안에서 `df -h`를 치면 옛 크기가 보입니다. 2단계는 볼륨이 노드에 마운트돼 있어야 kubelet이 할 수 있으므로 쓰는 Pod가 없으면 `FileSystemResizePending`에서 기다립니다. 두 조건 이름의 정의는 쿠버네티스 API 소스(`core/v1/types.go`)에 있습니다. 둘 다 끝나면 조건이 사라지고 `kubectl get pvc`의 CAPACITY가 30Gi로 바뀝니다.

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

`describe pvc`의 Events에 찍히는 문구는 PV 컨트롤러 소스에 그대로 있어서 문구만 보고 위 표의 어느 줄로 갈지 고를 수 있습니다.

| Events 문구 | 뜻 | 볼 곳 |
|---|---|---|
| `waiting for first consumer to be created before binding` | `WaitForFirstConsumer` 클래스이고 아직 Pod가 없음. 고장 아님 | 3번 |
| `no persistent volumes available for this claim and no storage class is set` | 클래스가 빈 PVC(`""`로 적었거나 기본 클래스가 없는데 생략)인데 맞는 PV가 없음 | 4~7번 |
| `Waiting for a volume to be created either by the external provisioner '<이름>' or manually by the system administrator...` | 동적 프로비저닝을 맡겼는데 아직 아무도 볼륨을 안 만듦 | 8번 |
| `storageclass.storage.k8s.io "<이름>" not found` | PVC가 적은 클래스가 클러스터에 없음 | 2번 |

마지막 줄은 조금 더 설명이 필요합니다. 맞는 정적 PV가 없고 PVC의 클래스 이름에 해당하는 StorageClass도 없으면 크기 이야기 대신 `ProvisioningFailed  storageclass.storage.k8s.io "manual" not found`가 찍힙니다. 맞는 PV가 없어서 그 이름으로 동적 프로비저닝을 시도했다는 뜻이라 "맞는 PV가 없다"와 "프로비저너가 없다"를 함께 봅니다.

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
- [kubectl patch](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_patch/)
- Kubernetes Blog, [Topology-Aware Volume Provisioning in Kubernetes](https://kubernetes.io/blog/2018/10/11/topology-aware-volume-provisioning-in-kubernetes/), 2018-10-11

소스 코드
- kubernetes/kubernetes, [release-1.37 pv_controller.go](https://github.com/kubernetes/kubernetes/blob/release-1.37/pkg/controller/volume/persistentvolume/pv_controller.go) (Events 문구, `claimRef` UID 비교, `uid`가 빈 `claimRef`의 예약 처리)
- kubernetes/api, [core/v1/types.go](https://github.com/kubernetes/api/blob/master/core/v1/types.go) (`Resizing`, `FileSystemResizePending` 조건)

연습
- iximiuz Labs, [Kubernetes PV reclaim policies 챌린지](https://labs.iximiuz.com/challenges/kubernetes-pv-reclaim-policies-5395f28c)

이 블로그의 관련 글
- [쿠버네티스 아래의 리눅스 4: OverlayFS](/blog/theory/systems/k8s-linux-04-overlayfs) (시험 범위 밖 심화)

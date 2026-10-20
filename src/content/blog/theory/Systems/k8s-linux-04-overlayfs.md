---
title: '[쿠버네티스 아래의 리눅스 4] OverlayFS: 이미지 레이어가 하나의 루트가 되기까지와 Netflix의 마운트 병목'
description: 컨테이너 이미지 레이어가 OverlayFS의 lowerdir, upperdir, workdir, merged로 쌓여 컨테이너 루트가 되는 과정을 커널 문서와 containerd 소스로 따라갑니다. copy-up, whiteout, 마운트 옵션 한 페이지 제한을 정리하고 레이어마다 만든 마운트가 노드 전체를 멈춘 Netflix 사례를 원문 기준으로 읽습니다.
date: 2026-10-20T00:00:00.000Z
tags:
  - Kubernetes
  - Linux
  - OverlayFS
  - containerd
  - Container Image
  - idmapped mount
category: theory/Systems
topics:
  - systems
  - performance
draft: false
series: "쿠버네티스 아래의 리눅스"
seriesOrder: 4
---

## 결론부터

1. 컨테이너 이미지는 변경분(레이어)의 묶음입니다. Dockerfile에서 파일시스템을 바꾸는 `RUN`, `COPY`, `ADD`가 레이어를 만들고 `ENV`, `CMD`, `LABEL` 같은 명령은 설정(메타데이터)만 바꿉니다. 레이어는 내용의 digest로 식별되므로 digest가 같으면 노드에 한 번만 저장되고 여러 이미지가 함께 씁니다.
2. 노드는 이 레이어들을 OverlayFS로 겹쳐 컨테이너의 루트 디렉터리 하나를 만듭니다. 읽기 전용 레이어는 `lowerdir`, 컨테이너가 쓰는 자리는 `upperdir`, 커널이 작업용으로 쓰는 빈 디렉터리는 `workdir`, 합쳐 보이는 결과는 `merged`입니다.
3. 아래 레이어의 파일을 고치면 파일 전체가 upperdir로 복사(copy-up)된 뒤 고쳐집니다. 지우면 upperdir에 장치 번호 0/0인 문자 디바이스(whiteout)가 생깁니다. 아래 레이어는 끝까지 바뀌지 않습니다.
4. containerd의 overlayfs snapshotter는 레이어를 `/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/<숫자>/fs`에 풀어 두고 컨테이너마다 overlay 마운트 하나를 만듭니다. 커널의 `mount(2)`는 옵션 문자열을 한 페이지(보통 4096바이트)까지만 받기 때문에 레이어가 많으면 경로를 줄이는 우회가 필요합니다.
5. 마운트는 노드 전체가 공유하는 커널 자원입니다. Netflix는 user namespace를 켜면서 레이어마다 idmapped 마운트를 만들게 되었고 컨테이너 100개를 한꺼번에 띄우자 약 20,200번의 mount/umount가 전역 `mount_lock`에서 부딪혔습니다. 해결은 레이어들의 공통 부모 디렉터리를 한 번만 idmap해서 컨테이너당 마운트 수를 레이어 수와 무관하게 만드는 것이었습니다(containerd PR #12092).

---

[2편](/blog/theory/systems/k8s-linux-02-namespaces-pause)에서 컨테이너마다 mount 네임스페이스가 따로 있다고 정리했습니다. mount 네임스페이스는 "어떤 마운트 목록을 볼지"를 나눌 뿐입니다. 그 목록의 맨 위에 놓이는 루트 디렉터리 `/`가 어디서 오는지는 이 글에서 다룹니다. 답은 OverlayFS 마운트 하나입니다. 이 마운트가 어떻게 만들어지고 언제 노드 전체를 느리게 만드는지까지 따라갑니다.

예시는 가상의 쇼핑몰 주문 API(`order-api`) 이미지입니다. 2026-10-20에 kind v0.33 클러스터(노드 이미지 v1.37.0, containerd 2.3.4, util-linux 2.41.5)의 워커 노드 컨테이너 안에서 2장, 3장, 4장, 5장의 과제를 돌렸습니다. 커널은 colima VM(Ubuntu 24.04.4)의 6.8.0-117-generic(arm64, 페이지 4096바이트)입니다. 실측한 출력은 "kind 실측"으로 표시했고 나머지는 커널 문서와 containerd 소스를 근거로 "이런 형태로 나온다"고 쓴 예입니다.

## 1. 이미지 레이어는 파일시스템 변경분의 묶음입니다

### 1-1. 레이어를 만드는 명령은 RUN, COPY, ADD

Docker 스토리지 드라이버 문서는 이미지를 "레이어의 쌓음"으로 설명합니다. 각 레이어는 바로 아래 레이어와의 차이만 담습니다. 문서의 문장으로는 파일시스템을 바꾸는 명령이 새 레이어를 만들고 `LABEL` 같은 명령은 이미지 메타데이터만 바꿉니다.

```dockerfile
FROM eclipse-temurin:21-jre          # 베이스 이미지의 레이어를 그대로 가져옴
WORKDIR /app                         # 디렉터리가 없으면 만듦(빌더에 따라 레이어가 생길 수 있음)
ENV TZ=Asia/Seoul                    # 메타데이터
COPY build/libs/order-api.jar app.jar  # 레이어
RUN useradd -r order                 # 레이어(/etc/passwd 등 변경분)
USER order                           # 메타데이터
CMD ["java", "-jar", "app.jar"]      # 메타데이터
```

| 명령 | 결과 | 비고 |
|---|---|---|
| `FROM` | 베이스 이미지의 레이어 목록을 물려받음 | 새 레이어는 만들지 않음 |
| `RUN`, `COPY`, `ADD` | 파일시스템 레이어 | 바뀐 파일만 담김 |
| `WORKDIR` | 디렉터리가 없으면 만듦 | BuildKit에서는 이 때문에 레이어가 생길 수 있음 |
| `ENV`, `CMD`, `ENTRYPOINT`, `USER`, `LABEL`, `EXPOSE` | 이미지 설정(config)만 바뀜 | 레이어 없음 |

"Dockerfile 한 줄이 레이어 하나"라는 말은 그래서 절반만 맞습니다. 레이어 수를 세려면 파일시스템을 건드린 줄만 세면 됩니다.

### 1-2. digest가 같은 레이어는 노드에 한 번 저장

OCI 이미지 명세에서 이미지는 세 종류의 객체로 이루어집니다.

```
manifest  ─┬─ config (JSON)    : ENV, CMD, USER 같은 설정과 rootfs.diff_ids 목록
           └─ layers[]         : 레이어 압축 파일(tar+gzip 등)마다 digest와 크기
```

manifest의 `layers[].digest`는 압축된 blob의 SHA-256입니다. config의 `rootfs.diff_ids`는 압축을 푼 tar의 SHA-256입니다. 두 값 모두 내용에서 계산하기 때문에 같은 내용이면 같은 값이 나옵니다. 그래서 `order-api`와 `payment` 이미지가 같은 `eclipse-temurin:21-jre` 베이스를 쓰면 노드는 베이스 레이어를 한 번만 내려받고 한 번만 풉니다. 두 번째 이미지를 받을 때 런타임은 "이 digest는 이미 있다"고 판단하고 해당 레이어를 건너뜁니다.

containerd는 이 공유를 두 곳에서 합니다. 압축 blob은 content store(`/var/lib/containerd/io.containerd.content.v1.content/blobs/sha256/`)에 digest 이름으로 저장되고 푼 결과는 snapshotter가 관리하는 디렉터리에 저장됩니다(3장). 압축 파일과 푼 디렉터리가 둘 다 남기 때문에 노드 디스크 사용량을 볼 때는 두 위치를 함께 봐야 합니다.

### 1-3. 빌드 캐시와 Dockerfile 순서

빌더는 각 단계의 입력이 바뀌지 않았으면 이전 결과 레이어를 재사용합니다. Docker 빌드 캐시 문서의 규칙은 단순합니다. 어떤 단계의 캐시가 무효가 되면 그 아래 단계는 전부 다시 실행됩니다. `RUN`은 명령 문자열이 같은지를 보고 `COPY`와 `ADD`는 복사할 파일의 내용이 같은지를 봅니다.

```dockerfile
# 순서 A: 소스가 바뀔 때마다 의존성 다운로드도 다시 실행됨
COPY . .
RUN ./gradlew dependencies && ./gradlew bootJar

# 순서 B: 빌드 스크립트가 그대로면 의존성 레이어는 캐시에서 재사용
COPY build.gradle settings.gradle ./
RUN ./gradlew dependencies
COPY src ./src
RUN ./gradlew bootJar
```

순서 B에서는 소스만 고친 커밋이면 마지막 두 단계만 다시 실행됩니다. 노드 입장에서도 같은 이점이 있습니다. 바뀐 레이어만 digest가 달라지므로 새 버전을 배포할 때 노드가 내려받는 양이 줄어듭니다. 자주 바뀌는 파일을 아래쪽 단계에, 거의 안 바뀌는 파일을 위쪽 단계에 두는 것이 원칙입니다.

### 1-4. 레이어는 불변이고 digest로 검증

레이어 내용은 digest로 이름 붙어 있으므로 받은 뒤 내용이 바뀌면 이름과 맞지 않습니다. containerd는 content store에 blob을 쓸 때 기대 digest와 실제 해시를 비교하고 다르면 커밋을 거부합니다. 이 불변성은 OverlayFS 쪽 규칙과도 맞물립니다. 커널 문서는 overlay에 쓰이는 중인 아래 파일시스템을 바꾸는 것을 허용하지 않는다고 적습니다. 바꾸면 동작이 정의되지 않습니다. 레이어를 여러 컨테이너가 공유해도 안전한 이유가 여기 있습니다. 누구도 레이어를 고치지 않고 모든 변경은 컨테이너 각자의 upperdir에만 쌓입니다.

**직접 해 보기**

- 리눅스 VM에서 `docker build`로 위 순서 A와 B를 각각 빌드하고 소스 파일 하나만 고쳐 다시 빌드합니다. 출력에서 `CACHED`로 표시되는 단계가 어떻게 달라지는지 봅니다.
- `docker image inspect <이미지> --format '{{json .RootFS.Layers}}'`로 diff_id 목록을 보고 `docker history <이미지>`에서 크기가 0B인 단계가 메타데이터 명령인지 확인합니다.
- containerd 노드라면 `ctr -n k8s.io content ls | head`로 content store에 digest 이름의 blob이 있는지 봅니다.

## 2. OverlayFS는 디렉터리 네 개로 하나의 트리를 만듭니다

### 2-1. lowerdir, upperdir, workdir, merged

OverlayFS는 여러 디렉터리를 겹쳐 하나의 디렉터리 트리처럼 보여 주는 커널 파일시스템입니다. 마운트에는 네 가지 디렉터리가 등장합니다.

| 이름 | 역할 | 컨테이너에서 대응하는 것 |
|---|---|---|
| `lowerdir` | 읽기 전용 층. 콜론으로 여러 개를 줄 수 있음 | 이미지 레이어들 |
| `upperdir` | 쓰기 가능한 층. 모든 변경이 여기 기록됨 | 컨테이너 쓰기 계층 |
| `workdir` | 커널이 copy-up과 rename을 원자적으로 하려고 쓰는 작업 공간 | snapshot의 `work` 디렉터리 |
| `merged` | 위 층들을 합쳐 보여 주는 마운트 지점 | 컨테이너의 `/` |

커널 문서가 못 박아 둔 조건이 있습니다. workdir은 upperdir과 같은 파일시스템에 있어야 합니다. copy-up은 workdir에 임시 파일을 만든 뒤 upperdir로 rename해서 마무리합니다. rename은 같은 파일시스템 안에서만 원자적으로 동작하므로 두 디렉터리가 갈라져 있으면 이 방식이 성립하지 않습니다.

lowerdir의 순서도 규칙이 있습니다. `lowerdir=/lower1:/lower2:/lower3`이면 커널 문서 기준으로 `lower1`이 맨 위, `lower3`이 맨 아래입니다. 이미지로 치면 가장 최근 레이어가 왼쪽에 옵니다. 커널 소스(`fs/overlayfs/params.h`)의 `OVL_MAX_STACK`은 500이라 lower 층은 500개까지 쌓을 수 있습니다.

### 2-2. 읽기는 위층부터 아래층으로 찾습니다

merged에서 경로를 찾으면 커널은 upperdir부터 보고 없으면 lowerdir을 왼쪽부터 차례로 봅니다. 처음 찾은 곳의 파일을 돌려줍니다.

```
경로: /app/config.yml

upperdir       (없음)
lower1 (최신)   /app/config.yml   ← 여기서 찾음. 아래층은 보지 않음
lower2          /app/config.yml   (가려짐)
lower3 (베이스)  ...
```

디렉터리는 조금 다릅니다. 같은 이름의 디렉터리가 여러 층에 있으면 내용을 합쳐서 보여 줍니다. `/etc`가 베이스 레이어와 `RUN useradd` 레이어 양쪽에 있으면 merged의 `/etc`에는 두 층의 파일이 함께 보입니다. 같은 이름의 파일이 겹칠 때만 위층이 아래층을 가립니다.

읽기에는 복사가 없습니다. 같은 이미지로 뜬 컨테이너 열 개가 `/usr/lib`의 라이브러리를 읽으면 모두 같은 lowerdir의 같은 inode를 읽습니다. 페이지 캐시도 공유됩니다.

### 2-3. 쓰기는 copy-up으로 파일 전체를 올립니다

아래층 파일을 쓰기 모드로 열거나 권한, 소유자 같은 메타데이터를 바꾸면 copy-up이 일어납니다. 커널은 그 파일과 파일이 들어 있는 디렉터리 경로를 upperdir에 먼저 만들고 이후의 쓰기는 upperdir 사본에 합니다.

```
변경 전                         echo x >> /var/lib/app/data.db 후
upperdir  (비어 있음)            upperdir  /var/lib/app/data.db  (전체 사본 + x)
lower1    /var/lib/app/data.db   lower1    /var/lib/app/data.db  (그대로, 이제 가려짐)
```

복사 단위는 파일 전체입니다. 1GB 파일 끝에 한 줄을 붙여도 처음 한 번은 1GB가 복사됩니다. Docker의 overlayfs 드라이버 문서도 copy_up이 파일 전체를 복사한다고 적고 큰 파일에 처음 쓸 때 지연이 생길 수 있다고 경고합니다. 한 번 올라간 뒤에는 upperdir 사본에 바로 쓰므로 같은 파일에 다시 쓸 때는 복사가 없습니다.

예외는 `metacopy=on` 옵션입니다. 이 옵션을 켜면 `chown`, `chmod`처럼 메타데이터만 바꾸는 작업에서는 메타데이터만 올리고 데이터는 실제로 쓰기용으로 열 때 복사합니다. 커널 문서는 신뢰할 수 없는 upper나 lower 디렉터리에는 이 옵션을 쓰지 말라고 경고합니다. 특수 xattr을 심은 파일로 다른 lower 파일에 접근하는 경로가 생기기 때문입니다.

### 2-4. 삭제는 whiteout, 디렉터리 교체는 opaque

lowerdir은 읽기 전용이니 아래층 파일을 지울 수 없습니다. 그래서 OverlayFS는 upperdir에 "이 이름은 없는 것으로 친다"는 표시를 남깁니다. 이것이 whiteout입니다. 커널 문서 정의는 장치 번호 0/0인 문자 디바이스입니다. merged에서 경로를 찾다가 whiteout을 만나면 아래층을 더 보지 않고 "없음"을 돌려줍니다.

```
rm /app/config.yml 후

upperdir  /app/config.yml   c 0,0  (whiteout)
lower1    /app/config.yml   (그대로 남아 있음, merged에서는 안 보임)
```

이미지 크기 문제가 여기서 나옵니다. 한 `RUN`에서 받은 파일을 다음 `RUN`에서 지우면 앞 레이어에는 파일이 그대로 있고 뒤 레이어에는 whiteout만 추가됩니다. 이미지가 줄지 않습니다. 같은 `RUN` 안에서 받고 지워야 레이어에 남지 않습니다.

디렉터리를 지우고 같은 이름으로 다시 만들면 opaque 디렉터리가 쓰입니다. upperdir의 디렉터리에 xattr `trusted.overlay.opaque="y"`가 붙고 커널은 그 아래층의 같은 이름 디렉터리를 합치지 않습니다. 새로 만든 디렉터리가 빈 디렉터리로 보이는 이유입니다.

커널 문서에는 대체 whiteout 형식도 있습니다. 크기 0인 일반 파일에 `overlay.whiteout` xattr을 붙이는 방식입니다. 커널이 직접 만들지는 않고 사용자 공간 도구가 쓸 수 있도록 열어 둔 형식입니다. 권한 없는 사용자 공간에서 overlay를 쓸 때는 xattr 이름이 `trusted.overlay.*` 대신 `user.overlay.*`가 되는 `userxattr` 옵션도 있습니다. containerd snapshotter는 시작할 때 이 옵션이 필요한지 검사해서 붙입니다.

### 2-5. 디렉터리 rename은 기본 EXDEV

아래층에 있던 디렉터리를 `rename(2)`하면 기본 설정에서는 `EXDEV`(다른 파일시스템 간 이동) 오류가 납니다. 커널 문서 기준으로 `redirect_dir` 기능이 꺼져 있을 때의 동작이고 이것이 기본값입니다. `mv` 같은 도구는 이 오류를 받으면 트리를 복사한 뒤 원본을 지우는 방식으로 넘어가므로 사용자는 대개 모릅니다. 컨테이너 안에서 큰 디렉터리를 `mv`했는데 유난히 오래 걸린다면 이 경로를 의심할 수 있습니다.

### 2-6. 직접 해 보기: overlay를 손으로 마운트하기

리눅스 VM에서 root 권한으로 해 볼 과제입니다. `/tmp`가 tmpfs인 배포판이 있으니 디스크 위 경로(`/var/tmp`)를 씁니다.

```bash
B=/var/tmp/ovl
mkdir -p $B/{lower1,lower2,upper,work,merged}

# 베이스 레이어 역할
echo "base"     > $B/lower2/a.txt
echo "v1"       > $B/lower2/config.txt
mkdir $B/lower2/logs && touch $B/lower2/logs/old.log
# 위 레이어 역할
echo "v2"       > $B/lower1/config.txt

sudo mount -t overlay overlay \
  -o lowerdir=$B/lower1:$B/lower2,upperdir=$B/upper,workdir=$B/work \
  $B/merged

cat $B/merged/config.txt        # v2 (lower1이 lower2를 가림)
echo "more" >> $B/merged/a.txt  # copy-up
rm $B/merged/config.txt         # whiteout
rm -rf $B/merged/logs && mkdir $B/merged/logs   # opaque 디렉터리
```

확인할 것은 세 가지입니다.

```bash
cat $B/lower2/a.txt             # base 한 줄. 아래층은 그대로
cat $B/upper/a.txt              # base, more 두 줄. 전체 사본
ls -l $B/upper                  # config.txt가 문자 디바이스 0, 0으로 보임
sudo getfattr -n trusted.overlay.opaque $B/upper/logs   # "y"
```

`ls -l $B/upper`의 kind 실측 출력입니다(커널 6.8, upper는 ext4).

```
-rw-r--r-- 1 root root   10 Oct 20 07:15 a.txt
c--------- 2 root root 0, 0 Oct 20 07:15 config.txt
drwxr-xr-x 2 root root 4096 Oct 20 07:15 logs
```

whiteout의 링크 수가 2입니다. 같은 시점 `ls -la $B/work/work`에 `#8b4cb` 같은 이름의 `0, 0` 문자 디바이스가 하나 있었습니다. 커널이 workdir에 whiteout 하나를 만들어 두고 하드링크로 재사용하기 때문입니다. `getfattr`로 읽은 `logs`의 값은 `trusted.overlay.opaque="y"`였습니다. kind 노드 이미지에는 `getfattr`가 없어 `apt-get install attr`로 설치했습니다.

`findmnt -t overlay`나 `grep overlay /proc/self/mountinfo`로 방금 만든 마운트의 옵션 문자열도 봐 둡니다. kind 실측에서는 `rw,relatime,lowerdir=...,upperdir=...,workdir=...,uuid=on,nouserxattr`로 나왔습니다. 4장에서 이 문자열의 길이가 문제가 됩니다. 끝나면 `sudo umount $B/merged`로 정리합니다.

## 3. containerd가 레이어를 디렉터리로 펼치는 방식

### 3-1. content store에서 snapshotter로

이미지를 받으면 containerd는 두 단계로 일합니다. 먼저 압축 blob을 content store에 저장하고 digest를 검증합니다(1-4). 그다음 snapshotter가 레이어를 하나씩 풀어 디렉터리로 만듭니다. 쿠버네티스 노드의 containerd는 기본으로 `overlayfs` snapshotter를 씁니다.

레이어 하나를 풀 때마다 snapshotter는 "부모 위에 새 층 준비, 압축 풀어 넣기, 확정"를 반복합니다. 베이스 레이어부터 순서대로 하므로 각 층은 바로 아래 층을 부모로 기억합니다. 이 체인의 식별자로 OCI 명세의 ChainID(diff_id들을 이어 해시한 값)가 쓰입니다.

### 3-2. metadata.db와 snapshots/<숫자>/fs

overlayfs snapshotter의 루트는 `/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/`입니다. containerd 소스(`plugins/snapshots/overlay/overlay.go`) 기준으로 그 아래 구조는 이렇습니다.

```
/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/
├── metadata.db          # bbolt 데이터베이스. 스냅샷 키, 종류, 부모, 숫자 ID
└── snapshots/
    ├── 1/
    │   └── fs/          # 베이스 레이어를 푼 내용
    ├── 2/
    │   └── fs/
    ├── ...
    └── 57/
        ├── fs/          # 컨테이너 쓰기 계층(upperdir)
        └── work/        # workdir. active 스냅샷에만 생김
```

디렉터리 이름의 숫자는 레이어 digest와 관계없습니다. `core/snapshots/storage/bolt.go`에서 bolt 버킷의 `NextSequence()`로 받은 값입니다. 계속 증가하고 재사용되지 않으므로 숫자가 크다는 것은 나중에 만들어졌다는 뜻일 뿐입니다. 어떤 숫자가 어느 레이어인지는 `metadata.db`를 거쳐야 알 수 있습니다.

### 3-3. 스냅샷 종류: active, committed, view

`core/snapshots/snapshotter.go`는 스냅샷 종류를 세 가지로 정의합니다.

| 종류 | 쓰기 | 쓰임 |
|---|---|---|
| Active | 가능 | 레이어를 푸는 중인 층, 실행 중인 컨테이너의 쓰기 계층 |
| Committed | 불가 | 다 풀린 이미지 레이어. 다른 스냅샷의 부모가 됨 |
| View | 불가 | 이미지 내용을 읽기만 할 때의 임시 층 |

`work` 디렉터리는 Active 스냅샷을 만들 때만 생깁니다(`overlay.go`의 `createSnapshot`). Committed 층은 다시 쓰지 않으니 workdir이 필요 없습니다.

### 3-4. 컨테이너 rootfs 마운트

컨테이너를 만들 때 containerd는 이미지의 마지막 Committed 스냅샷을 부모로 Active 스냅샷을 하나 만듭니다. snapshotter의 `mounts()` 함수가 돌려주는 마운트 정보는 대략 다음 모양입니다.

```
type:    overlay
options: index=off, [userxattr],
         workdir=/var/lib/containerd/.../snapshots/57/work,
         upperdir=/var/lib/containerd/.../snapshots/57/fs,
         lowerdir=/var/lib/containerd/.../snapshots/56/fs:.../55/fs:...:.../1/fs
```

lowerdir은 부모 목록 순서대로라 가장 가까운 부모가 왼쪽, 베이스가 오른쪽에 옵니다. 2-1의 "왼쪽이 맨 위" 규칙과 맞습니다. 같은 함수에는 예외도 있습니다. 부모가 하나도 없는 스냅샷은 overlay가 성립하지 않으므로 `fs` 디렉터리를 bind mount로 돌려줍니다. 부모가 하나뿐인 읽기 전용 스냅샷도 bind mount입니다.

이 마운트가 실제로 걸리는 자리는 runtime v2 shim의 작업 디렉터리입니다. 쿠버네티스 노드에서는 네임스페이스가 `k8s.io`이므로 경로가 `/run/containerd/io.containerd.runtime.v2.task/k8s.io/<container-id>/rootfs`가 됩니다. runc는 컨테이너의 mount 네임스페이스 안에서 이 디렉터리를 새 루트로 삼습니다([2편](/blog/theory/systems/k8s-linux-02-namespaces-pause)의 pivot_root 흐름).

**직접 해 보기**

kind 노드는 그 자체가 컨테이너라 snapshotter 구성이 일반 노드와 다를 수 있습니다. kubeadm으로 만든 VM 노드에서 보는 편이 정확합니다. kind v0.33에서는 노드 안 containerd도 `snapshotter = "overlayfs"`를 써서 아래 명령이 그대로 동작했습니다.

```bash
# 노드에서
sudo ctr -n k8s.io snapshots ls | head          # KEY, PARENT, KIND 열
sudo ls /var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots | sort -n | tail
findmnt -t overlay -o TARGET,OPTIONS | head     # rootfs 경로와 lowerdir 목록
sudo crictl ps -q | head -1 | xargs -I{} sudo ctr -n k8s.io snapshots mounts /tmp/x {}
```

- `KIND` 열에 Active와 Committed가 섞여 나오는지, Active의 KEY가 컨테이너 ID와 같은지 봅니다. 마지막 명령은 해당 컨테이너 스냅샷의 마운트 명령을 출력만 하고 실행하지는 않습니다. kind 워커 실측은 Active 28개, Committed 125개였습니다. Active의 KEY는 컨테이너 ID와 같았고 PARENT는 `sha256:` ChainID였습니다. `snapshots mounts` 출력은 `mount -t overlay overlay /tmp/x -o workdir=.../snapshots/238/work,upperdir=.../snapshots/238/fs,lowerdir=.../snapshots/65/fs:...` 모양이었고 `index=off`나 `userxattr`는 붙지 않았습니다.
- `findmnt`의 TARGET이 `/run/containerd/io.containerd.runtime.v2.task/k8s.io/.../rootfs`인지 확인합니다. kind 노드에서는 첫 줄이 노드 컨테이너 자신의 `/`입니다. 그 lowerdir은 colima 쪽 Docker가 쓰는 containerd 스냅샷 경로라 노드 안의 경로와 헷갈리기 쉽습니다. kind 실측에서 rootfs 마운트는 25개였습니다.
- 파드 안에서 파일을 하나 만든 뒤 해당 Active 스냅샷의 `fs` 디렉터리에 같은 파일이 생기는지 봅니다.

## 4. 마운트 옵션 문자열의 4096바이트 제한

### 4-1. mount(2)는 옵션을 한 페이지까지 복사

3-4의 lowerdir 문자열은 레이어 수만큼 길어집니다. 경로 하나가 `/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/123/fs`라면 70바이트가 넘습니다. 레이어 50개면 lowerdir만 3,500바이트를 넘깁니다.

레거시 `mount(2)` 시스템 콜은 옵션 문자열을 커널로 복사할 때 `copy_mount_options()`(`fs/namespace.c`)를 거칩니다. 이 함수는 한 페이지(x86_64 기본 4096바이트)까지만 복사합니다. 그보다 긴 옵션은 잘리므로 런타임이 미리 줄여야 합니다. Docker와 containerd는 이 문제를 다르게 풀었습니다.

### 4-2. Docker overlay2: l/ 아래 짧은 심볼릭 링크

Docker 문서는 overlay2 드라이버의 `/var/lib/docker/overlay2/l/` 디렉터리를 설명합니다. 이 디렉터리에는 레이어마다 짧은 식별자 이름의 심볼릭 링크가 있습니다. 문서는 이 링크가 mount 명령 인자의 페이지 크기 제한을 피하려고 있다고 적습니다. lowerdir에는 `l/` 아래의 짧은 이름이 들어갑니다.

### 4-3. containerd: 공통 디렉터리로 chdir한 뒤 상대 경로

containerd는 경로 자체를 줄입니다. `core/mount/mount_linux.go`의 `mount()`는 overlay 옵션 길이가 `pagesize - 512` 이상이면 `compactLowerdirOption()`을 부릅니다(512는 소스 주석에 적힌 여유분입니다). 이 함수는 lowerdir 경로들의 가장 긴 공통 접두 디렉터리를 찾아 그 부분을 떼어 냅니다.

```
원래: lowerdir=/var/lib/containerd/.../snapshots/56/fs:/var/lib/containerd/.../snapshots/55/fs:...
줄임: chdir /var/lib/containerd/.../snapshots/
      lowerdir=56/fs:55/fs:...
```

그다음 그 공통 디렉터리로 `chdir`한 자식 프로세스에서 상대 경로로 `mount`를 호출합니다(`mountAt`). containerd 데몬 자체의 작업 디렉터리를 바꾸지 않으려고 자식 프로세스를 씁니다. 3장의 숫자 디렉터리 이름은 bolt 시퀀스 값이라 이 우회와는 관계가 없습니다.

### 4-4. 새 mount API의 lowerdir+

커널 문서에 따르면 6.8부터는 새 mount API의 `fsconfig()`로 `lowerdir+` 옵션을 레이어마다 따로 넘길 수 있습니다. 옵션을 한 문자열로 이어 붙이지 않으므로 전체 한 페이지 제한을 피합니다. 다만 `fs/fsopen.c`의 `fsconfig`는 값 하나를 `strndup_user(_value, 256)`로 복사합니다. 경로 하나가 256바이트를 넘으면 안 된다는 새 제약이 생깁니다. 이 글을 쓰는 시점의 containerd main의 일반 경로는 여전히 레거시 `mount(2)`와 chdir 우회를 씁니다. 사람이 치는 `mount` 명령은 다릅니다. kind 노드의 util-linux 2.41.5 `mount`는 lowerdir 전체를 `fsconfig` 값 하나로 넘겼고 그 문자열이 256바이트를 넘자 `EINVAL`로 실패했습니다(4장 직접 해 보기의 실측).

| 방식 | 제한 | 쓰는 곳 |
|---|---|---|
| `mount(2)` + 옵션 문자열 | 전체 한 페이지(보통 4096바이트) | Docker overlay2(짧은 링크로 우회), containerd(chdir로 우회) |
| `fsconfig()` + `lowerdir+` (6.8+) | 값 하나당 256바이트, 레이어 수는 `OVL_MAX_STACK` 500 | 새 mount API를 쓰는 도구 |

**직접 해 보기**

- 2-6의 실습에서 lower 디렉터리를 긴 이름으로 60개쯤 만들어 `mount -t overlay`를 시도해 봅니다. 옵션이 한 페이지를 넘으면 어떤 오류가 나는지, 공통 디렉터리로 `cd`한 뒤 상대 경로로 주면 성공하는지 비교합니다.

kind 실측(util-linux 2.41.5, 커널 6.8)에서는 예상과 다른 결과가 나왔습니다. 최근 util-linux의 `mount` 명령은 `mount(2)` 대신 새 mount API(`fsopen`, `fsconfig`)를 씁니다. 그래서 lowerdir 문자열이 251바이트일 때는 붙고 314바이트에서는 `fsconfig(..., "lowerdir", ...) = -1 EINVAL`로 실패했습니다. 한 페이지보다 훨씬 짧은 값에서 걸리는 것입니다. `LIBMOUNT_FORCE_MOUNT2=always`를 주면 `mount(2)`로 바뀝니다. 이때는 옵션 3895바이트(절대 경로 60개)와 3027바이트(상대 경로 60개) 모두 붙었습니다. 옵션이 5175바이트(절대 경로 80개)일 때는 오류 없이 붙었는데 4096바이트 뒤가 잘려 `upperdir`와 `workdir`가 빠졌습니다. 결과는 lowerdir 64개짜리 읽기 전용 overlay였고 `touch`가 `Read-only file system`으로 실패했습니다. 한 페이지 제한은 오류 없이 옵션을 잘라 버리는 형태로도 나타날 수 있습니다. 시스템 콜 경로는 `strace -e trace=mount,fsopen,fsconfig`로 확인했습니다.
- 레이어가 많은 이미지로 뜬 컨테이너의 `findmnt` 출력에서 lowerdir이 절대 경로인지 상대 경로인지 봅니다. 상대 경로로 보이면 compact 경로를 탄 것입니다. 마운트 정보에 경로를 어떻게 표시하는지는 커널 버전에 따라 다를 수 있으니 containerd 로그와 함께 봅니다.

## 5. 쓰기 많은 데이터는 볼륨으로 보냅니다

### 5-1. 컨테이너 쓰기 계층의 수명

upperdir은 컨테이너 하나에 묶여 있습니다. 컨테이너가 사라질 때 무엇이 남는지 정리하면 이렇습니다.

| 사건 | upperdir(쓰기 계층) | 이미지 레이어 | emptyDir | PV |
|---|---|---|---|---|
| 컨테이너 재시작(같은 파드) | 새 컨테이너는 새 Active 스냅샷으로 시작 | 남음 | 남음 | 남음 |
| 파드 삭제 | 컨테이너와 함께 삭제 | 남음(이미지 GC 대상이 될 때까지) | 삭제 | 남음(reclaim 정책에 따름) |

컨테이너가 재시작되면 kubelet은 새 컨테이너 ID로 컨테이너를 새로 만듭니다. 새 컨테이너는 비어 있는 upperdir에서 시작하므로 이전 컨테이너가 루트 파일시스템에 쓴 내용은 보이지 않습니다.

### 5-2. 볼륨은 overlay 밖의 마운트

쓰기가 많은 데이터를 upperdir에 두면 2장의 비용을 그대로 냅니다. 이미지에 들어 있던 파일을 처음 고칠 때마다 파일 전체가 복사되고 모든 접근이 overlay 층을 거칩니다. Docker 문서도 쓰기가 많은 애플리케이션은 볼륨을 쓰라고 권합니다. 특히 읽기 전용 레이어에 이미 데이터가 있는 경우를 짚습니다.

쿠버네티스의 `emptyDir`과 PV는 컨테이너의 mount 네임스페이스 안에서 overlay 루트 위에 따로 붙는 마운트입니다. 그 경로 아래의 읽기와 쓰기는 overlay를 거치지 않습니다.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: board-search
  namespace: shop
spec:
  containers:
  - name: indexer
    image: registry.example.com/shop/board-search:1.4.2
    volumeMounts:
    - name: index-cache        # 파드와 수명이 같은 임시 색인
      mountPath: /var/cache/index
    - name: data               # 파드가 지워져도 남아야 하는 데이터
      mountPath: /var/lib/search
  volumes:
  - name: index-cache
    emptyDir:
      sizeLimit: 2Gi
  - name: data
    persistentVolumeClaim:
      claimName: board-search-data
```

`emptyDir`은 파드와 함께 사라지므로 다시 만들 수 있는 캐시나 중간 파일에 씁니다. 파드가 바뀌어도 남아야 하는 데이터는 PV에 둡니다. 쿠버네티스 문서 기준으로 컨테이너 쓰기 계층과 로그, 디스크 기반 `emptyDir`은 모두 노드의 local ephemeral storage 사용량으로 집계됩니다. `resources.limits.ephemeral-storage`를 넘으면 파드가 축출될 수 있으니 쓰기 계층에 큰 파일을 쌓는 습관은 축출 원인이 되기도 합니다. 볼륨 종류와 PV 바인딩은 [CKA Ch-05](/blog/cert/cka/cka-05-storage)에서 다룹니다.

**직접 해 보기**

- 같은 파드에서 `/tmp/big`(쓰기 계층)과 emptyDir 경로에 각각 `dd`로 500MB를 쓰고 노드에서 해당 Active 스냅샷의 `fs` 디렉터리와 `/var/lib/kubelet/pods/<uid>/volumes/kubernetes.io~empty-dir/` 중 어디가 커지는지 봅니다.
- 노드에서 `crictl stop <container-id>`로 컨테이너를 멈춰 kubelet이 다시 만들게 한 뒤 `/tmp/big`과 emptyDir 파일이 남아 있는지 확인합니다.

kind 실측(100MB로 줄여서 돌림)에서 쓰기 계층의 파일은 `snapshots/242/fs/tmp/big`(104857600바이트)에, emptyDir 파일은 `/var/lib/kubelet/pods/<uid>/volumes/kubernetes.io~empty-dir/s`(101M)에 생겼습니다. 같은 `fs` 디렉터리에는 루트에 만든 `hello.txt`도 보였습니다. `crictl stop` 뒤 RESTARTS가 1이 됐고 `/tmp/big`과 `/hello.txt`는 사라졌으며 emptyDir의 `/scratch/big`만 남았습니다.

## 6. 사례: 마운트가 노드 전체의 병목이 된 Netflix

Netflix TechBlog의 "Mount Mayhem at Netflix: Scaling Containers on Modern CPUs"(Harshad Sane, Andrew Halaney, 2025-11-07)는 지금까지 본 overlay 마운트가 노드 전체를 멈춘 사례입니다. 아래 수치와 표현은 모두 원문 기준이고 원문에 없는 수치는 넣지 않았습니다.

### 6-1. 배경: 런타임 전환과 컨테이너마다 다른 UID 범위

Netflix는 컨테이너 플랫폼의 노드 런타임을 "virtual kubelet + Docker"에서 "kubelet + containerd"로 옮기고 있었습니다. 이 전환에서 user namespace를 함께 도입했습니다. 원문의 표현으로는 각 컨테이너가 고유한 호스트 사용자 범위를 받습니다. 컨테이너 안의 root(UID 0)가 호스트에서는 컨테이너마다 다른 비특권 UID가 되는 구성입니다. 탈출한 프로세스가 호스트 root 권한을 갖지 못하게 하는 장치입니다.

참고로 쿠버네티스 자체의 user namespace 기능(파드 스펙의 `hostUsers: false`)은 1.36(2026년 4월)에 GA가 되었고 쿠버네티스 문서 기준으로 파드마다 65536개의 UID 범위를 줍니다. 65536은 쿠버네티스 문서의 기본 크기이고 Netflix 원문에 나오는 숫자는 아닙니다.

### 6-2. idmapped mount 때문에 레이어마다 마운트

문제는 파일 소유자입니다. 이미지 레이어의 파일은 디스크에 UID 0 소유로 저장되어 있습니다. 컨테이너 root가 호스트의 다른 UID라면 그 파일들은 컨테이너 입장에서 남의 파일입니다. 옛 방식은 레이어를 복사해 chown하는 것이었는데 디스크와 시간이 많이 듭니다.

리눅스 5.12에 들어온 idmapped mount는 이 문제를 마운트 시점에 풉니다. `open_tree()`로 디렉터리를 복제한 마운트를 만들고 `mount_setattr()`에 `MOUNT_ATTR_IDMAP`과 user namespace를 주면 그 마운트를 통해 보는 파일의 소유자가 매핑되어 보입니다. 디스크의 파일은 그대로입니다. OverlayFS는 5.19부터 idmapped 마운트를 lower와 upper 층으로 받을 수 있습니다.

containerd의 첫 구현(`prepareIDMappedOverlay`)은 레이어 디렉터리 하나하나를 idmapped bind mount로 만든 뒤 그 경로들을 lowerdir로 넘겼습니다. overlay가 마운트되고 나면 임시 idmapped 마운트들은 정리(umount)합니다. 그래서 레이어가 50개인 이미지는 이렇게 계산됩니다.

```
overlay 마운트              1
레이어별 idmapped bind mount  50
정리용 umount               50
                          ───
                          101  × 2 (원문 설명상 같은 과정을 두 번 거침) = 컨테이너당 약 202회
컨테이너 100개 동시 기동      100 × 202 = 약 20,200회의 mount/umount
```

원문은 r5.metal 인스턴스에서 동시 컨테이너가 약 100개일 때 실패가 시작되었고 레이어 50개 이상인 이미지가 문제였다고 씁니다. 헬스체크가 30초 타임아웃에 걸렸고 마운트 테이블을 읽는 것만으로 30초 넘게 걸리는 경우가 있었습니다.

### 6-3. mount_lock과 path_init의 스핀 대기

마운트를 추가하거나 빼는 작업은 커널의 전역 `mount_lock`을 쓰기 쪽으로 잡습니다. `fs/mount.h`에서 이 락은 `seqlock_t`로 선언되어 있습니다. seqlock은 쓰는 쪽이 시퀀스 번호를 올리는 동안 읽는 쪽이 기다리거나 다시 시도하는 구조입니다.

읽는 쪽은 경로 탐색입니다. 프로세스가 파일을 열 때 커널은 `path_init()`(`fs/namei.c`)에서 마운트 구조를 읽기 전에 이 시퀀스를 확인합니다. 쓰는 쪽이 작업 중이면 시퀀스가 끝날 때까지 돌면서 기다립니다. 원문은 프로파일 결과를 "path_init()에서 시퀀스 락을 기다리는 tight spin loop"로 적었고 시간 대부분이 `pause` 명령에 쓰였다고 합니다. CPU를 붙잡은 채 도는 대기입니다.

이 구조가 노드 전체로 번지는 이유가 여기 있습니다. `mount_lock`은 노드에 하나뿐인 전역 락이고 노드의 모든 프로세스가 파일을 열 때 같은 시퀀스를 봅니다. 컨테이너 100개를 띄우면서 2만 번 넘게 쓰기 쪽 락을 잡으면 이미 돌고 있던 다른 컨테이너의 파일 열기까지 같이 느려집니다. 원문의 TMA(Top-down Microarchitecture Analysis) 결과는 경합 접근으로 인한 스톨 95.5%, false sharing 57%였습니다.

### 6-4. CPU 구조에 따라 갈린 결과

같은 부하를 여러 인스턴스 종류에 걸어 본 결과가 원문의 후반부입니다.

| 인스턴스 | 원문의 구조 설명 | 결과 |
|---|---|---|
| r5.metal | 2소켓, NUMA 도메인 여러 개 | 가장 나쁨. 소켓 사이의 추가 홉이 경합을 키움 |
| m7i.metal(Intel) | 단일 소켓, 중앙집중형 캐시(메시와 TOR 큐) | r5보다 나음. 단일 소켓, 단일 NUMA라서 |
| m7a.metal(AMD) | 칩렛(CCX)마다 LLC가 나뉜 분산형 캐시 | 같은 부하를 잘 견딤 |

락 하나의 시퀀스 번호는 캐시 라인 하나에 들어 있습니다. 코어들이 이 라인을 서로 가져가려 할수록 라인이 코어 사이를 오가고 소켓을 건너는 이동은 같은 소켓 안의 이동보다 깁니다. 2소켓 r5.metal에서 가장 크게 터진 것은 이 비용이 겹친 결과입니다. 원문은 하이퍼스레딩 영향도 측정했습니다. m7i.metal-24xl에서 하이퍼스레딩을 끄자 기동 지연이 20~30% 줄었습니다.

### 6-5. 해결: 공통 부모 디렉터리를 한 번만 idmap

CPU를 바꾸면 덜 아프지만 원인은 마운트 횟수입니다. 원문 공저자 Andrew Halaney가 containerd에 올린 PR #12092 "Only idmap once per overlayfs, not per layer"는 이렇게 고쳤습니다. 레이어들은 모두 `.../snapshots/<숫자>/fs` 아래에 있으므로 공통 부모 디렉터리 `.../snapshots/`가 있습니다. 이 디렉터리 하나를 idmapped mount로 만들고 lowerdir은 그 마운트 아래의 상대 경로로 다시 씁니다. 현재 containerd 소스의 `doPrepareIDMappedOverlay`가 그 모양입니다.

```go
commonDir, err := getCommonDirectory(lowerDirs)
...
// IDMapMount the directory containing all the layers
if err := IDMapMountWithAttrs(commonDir, tempRemountsLocation, usernsFd, unix.MOUNT_ATTR_RDONLY, 0); err != nil {
...
// Build new lower dir paths through the idmapped directory
tmpLowerDirs := buildIDMappedPaths(lowerDirs, commonDir, tempRemountsLocation)
```

PR 설명의 문장으로는 idmap 횟수가 레이어 수의 함수에서 overlay당 상수가 됩니다. 컨테이너당 마운트 연산이 O(n)에서 O(1)이 된 것입니다. PR은 2025년 8월 17일 main에 병합되었고 2.0.x와 2.1.x 릴리스 브랜치로 백포트되었으며 containerd 2.2.0에 포함되었습니다.

원문은 다른 해법도 검토했습니다. 새 mount API의 `fsconfig()`에 `lowerdir+`로 idmapped 레이어를 파일 디스크립터로 넘기는 방식입니다(4-4). 수정 효과는 O(n)에서 O(1)이라는 복잡도 변화로 설명합니다.

### 6-6. 내 클러스터에 대입해 보기

이 사례가 내 노드와 관련 있는지는 세 가지 조건으로 판단할 수 있습니다.

1. user namespace를 쓰는 파드가 있는지(`hostUsers: false`). 쓰지 않으면 rootfs에 idmapped 레이어 마운트가 만들어지지 않습니다.
2. containerd 버전이 PR #12092를 포함하는지. 2.2.0 이상이거나 백포트가 들어간 2.0.x, 2.1.x 패치 버전인지 릴리스 노트로 확인합니다.
3. 레이어 수가 많은 이미지를 한 노드에 동시에 많이 띄우는지. 배포 직후나 노드 장애 뒤 재스케줄처럼 기동이 몰리는 순간이 위험 구간입니다.

**직접 해 보기**

- 리눅스 VM에서 `perf top`이나 `perf record -g`를 켠 채 `for i in $(seq 1 2000); do mkdir -p /mnt/x$i; mount --bind /var/tmp/ovl/lower1 /mnt/x$i; done` 같은 마운트 폭주를 만들고 다른 터미널에서 `find /usr > /dev/null`의 시간을 비교해 봅니다. `path_init`이나 seqlock 관련 심볼이 보이는지 확인합니다. 끝나면 마운트를 모두 해제합니다.
- containerd 노드에서 `containerd --version`을 확인하고 릴리스 노트에서 "idmap once per overlayfs" 항목을 찾아봅니다. kind v0.33 노드 이미지 v1.37.0의 containerd는 2.3.4였습니다.

## 확인 문제

1. Dockerfile에 `FROM`, `WORKDIR`, `ENV`, `COPY`, `RUN`, `CMD`가 한 줄씩 있습니다. 파일시스템 레이어를 확실히 만드는 줄은 무엇입니까?

<details><summary>정답</summary>

`COPY`와 `RUN`입니다. `FROM`은 베이스 레이어를 물려받을 뿐이고 `ENV`, `CMD`는 이미지 설정만 바꿉니다. `WORKDIR`은 디렉터리가 없을 때 만들기 때문에 빌더에 따라 레이어가 생길 수 있어 "확실히"에서는 빠집니다.

</details>

2. `lowerdir=/a:/b:/c`로 마운트했고 세 디렉터리에 모두 `x.txt`가 있습니다. merged에서 `cat x.txt`는 어느 파일을 보여 줍니까? upperdir에도 `x.txt`가 있다면요?

<details><summary>정답</summary>

lowerdir만 있다면 맨 왼쪽인 `/a`의 파일입니다. 커널 문서 기준으로 왼쪽이 맨 위 층입니다. upperdir에 있으면 upperdir의 파일이 모든 lower를 가립니다.

</details>

3. 이미지에 들어 있는 2GB 파일에 컨테이너가 1바이트를 덧붙였습니다. 디스크에서는 무슨 일이 일어납니까? `metacopy=on`이면 `chmod`만 했을 때 무엇이 달라집니까?

<details><summary>정답</summary>

첫 쓰기에서 2GB 파일 전체가 upperdir로 copy-up되고 사본에 1바이트가 붙습니다. lowerdir의 원본은 그대로입니다. `metacopy=on`이면 `chmod`처럼 메타데이터만 바꾸는 작업에서는 메타데이터만 올라가고 데이터는 쓰기용으로 열 때 복사됩니다.

</details>

4. 한 `RUN`에서 300MB 압축 파일을 받고 다음 `RUN`에서 `rm`했습니다. 이미지 크기가 줄지 않는 이유를 whiteout으로 설명하십시오.

<details><summary>정답</summary>

앞 레이어에는 300MB 파일이 그대로 들어 있습니다. 뒤 레이어에는 그 경로에 0/0 문자 디바이스(whiteout)만 추가되어 merged에서 안 보이게 가립니다. 레이어는 불변이므로 앞 레이어의 크기는 줄지 않습니다. 같은 `RUN` 안에서 받고 지워야 합니다.

</details>

5. containerd 노드의 `snapshots/` 아래 디렉터리 이름이 `1`, `2`, ... `57`처럼 숫자인 이유는 무엇이고 마운트 옵션 길이 제한은 어떻게 피합니까?

<details><summary>정답</summary>

숫자는 `metadata.db`(bbolt) 버킷의 `NextSequence()` 값이라 단조 증가하고 재사용되지 않습니다. 길이 문제와는 관계없습니다. 옵션이 `pagesize - 512` 이상이면 containerd는 `compactLowerdirOption()`으로 lowerdir들의 공통 디렉터리를 떼어 내고 그 디렉터리로 chdir한 자식 프로세스에서 상대 경로로 mount합니다. 짧은 심볼릭 링크(`l/`)로 피하는 것은 Docker overlay2의 방식입니다.

</details>

6. 파드의 컨테이너가 OOM으로 재시작되었습니다. 컨테이너가 `/tmp`에 써 둔 파일과 emptyDir에 써 둔 파일은 각각 어떻게 됩니까?

<details><summary>정답</summary>

`/tmp`는 쓰기 계층(upperdir)이므로 새 컨테이너에서는 보이지 않습니다. kubelet은 새 컨테이너를 만들고 새 Active 스냅샷에서 시작합니다. emptyDir은 파드 수명에 묶여 있으므로 컨테이너 재시작 뒤에도 남아 있습니다.

</details>

7. Netflix 사례에서 레이어 50개 이미지 컨테이너 100개를 동시에 띄울 때 mount/umount가 약 20,200회가 되는 계산을 쓰고 PR #12092 이후 컨테이너당 횟수가 레이어 수와 어떤 관계가 되는지 답하십시오.

<details><summary>정답</summary>

컨테이너당 (overlay 1 + 레이어 idmap bind mount 50 + 정리 umount 50) × 2 = 202회, 100개면 20,200회입니다. PR #12092는 레이어들의 공통 부모 디렉터리를 한 번만 idmap하므로 컨테이너당 idmap 횟수가 레이어 수와 무관한 상수가 됩니다(O(n)에서 O(1)).

</details>

8. 이 병목이 컨테이너 하나의 문제로 끝나지 않고 노드 전체로 번진 이유를 `mount_lock`과 `path_init()`으로 설명하십시오.

<details><summary>정답</summary>

`mount_lock`은 커널 전역 seqlock입니다. mount/umount는 쓰기 쪽으로 이 락을 잡고 경로 탐색의 `path_init()`은 읽기 쪽으로 시퀀스를 확인하다가 쓰기가 진행 중이면 스핀하며 기다립니다. 노드의 모든 프로세스가 파일을 열 때 같은 락을 보므로 마운트 폭주가 이미 돌던 컨테이너의 파일 열기까지 늦춥니다. 2소켓 NUMA 구조에서는 락이 든 캐시 라인이 소켓을 건너 오가며 비용이 커졌습니다.

</details>

## 범위와 한계

- 2026-10-20에 kind v0.33 + 노드 v1.37.0(colima, arm64, VM 커널 6.8.0-117-generic, Ubuntu 24.04.4)에서 돌린 것: 2-6 수동 overlay 마운트(copy-up, whiteout, opaque), 3장 스냅샷 명령(`ctr snapshots ls/info/mounts`, `content ls`, `findmnt`), 4장 긴 lowerdir 실험(새 mount API와 `mount(2)` 비교), 5장 쓰기 계층과 emptyDir 비교. 실측 출력은 본문에 "kind 실측"으로 표시했습니다.
- 돌리지 못한 것: 1장의 `docker build`, `docker history` 과제, 6장의 `perf` 마운트 폭주 실험(노드에 perf가 없음), `hostUsers: false` 파드(kind에서 sysfs 마운트가 `operation not permitted`로 실패해 idmapped 마운트를 볼 수 없었음). 3-2의 디렉터리 구조와 3-4의 마운트 옵션 일부(`index=off`, `userxattr`)는 containerd 소스 기준이고 kind 노드에서는 그 두 옵션이 보이지 않았습니다. 그 밖의 정의는 커널 문서, containerd 소스(main 브랜치, 2026년 10월 확인), Docker 문서를 근거로 썼습니다.
- Netflix 원문은 이 글을 쓰는 환경에서 직접 내려받지 못했습니다(접근 차단). 사례 수치와 표현은 원문을 대조해 둔 사전 검증 기록을 근거로 썼습니다. 원문에 없는 수치(수정 후 마운트 횟수, 개선 배수, 특정 커널 버전 요구)는 쓰지 않았습니다. "같은 과정을 두 번 거친다"는 부분의 정확한 주체는 원문 설명을 따랐고 containerd 소스에서 두 번의 호출 지점을 직접 추적하지는 않았습니다.
- 버전에 따라 달라지는 항목: idmapped mount(5.12), overlayfs의 idmapped 레이어(5.19), `lowerdir+`와 `fsconfig`(6.8), containerd PR #12092 포함 버전(2.2.0, 2.0.x/2.1.x 백포트), 쿠버네티스 user namespace GA(1.36). 페이지 크기 4096바이트는 x86_64 기본값이고 64KB 페이지를 쓰는 arm64 커널에서는 제한이 다릅니다.
- `hostUsers: false` 파드의 rootfs가 어떤 containerd 설정에서 idmapped overlay 경로를 타는지는 런타임 설정과 커널 지원 여부에 따라 갈립니다. 6-6의 조건은 판단의 출발점이고 실제 노드에서 `findmnt`로 확인해야 합니다.
- `WORKDIR`이 레이어를 만드는지는 빌더(BuildKit, 레거시 빌더)와 디렉터리 존재 여부에 따라 다릅니다. 압축 blob을 푼 뒤 지우는 containerd 설정 같은 디스크 최적화 옵션은 버전마다 위치가 달라 다루지 않았습니다.

## 참고 자료

- Linux kernel, Overlay Filesystem: https://docs.kernel.org/filesystems/overlayfs.html
- Linux kernel, Sequence counters and sequential locks: https://docs.kernel.org/locking/seqlock.html
- torvalds/linux `fs/namespace.c`(copy_mount_options): https://github.com/torvalds/linux/blob/master/fs/namespace.c
- torvalds/linux `fs/fsopen.c`(fsconfig 값 256바이트): https://github.com/torvalds/linux/blob/master/fs/fsopen.c
- torvalds/linux `fs/overlayfs/params.h`(OVL_MAX_STACK): https://github.com/torvalds/linux/blob/master/fs/overlayfs/params.h
- torvalds/linux `fs/mount.h`, `fs/namei.c`: https://github.com/torvalds/linux/blob/master/fs/mount.h , https://github.com/torvalds/linux/blob/master/fs/namei.c
- mount_setattr(2) man page: https://man7.org/linux/man-pages/man2/mount_setattr.2.html
- containerd overlay snapshotter: https://github.com/containerd/containerd/blob/main/plugins/snapshots/overlay/overlay.go
- containerd snapshot 메타데이터 저장소: https://github.com/containerd/containerd/blob/main/core/snapshots/storage/bolt.go
- containerd snapshot 종류: https://github.com/containerd/containerd/blob/main/core/snapshots/snapshotter.go
- containerd `mount_linux.go`(compactLowerdirOption, prepareIDMappedOverlay): https://github.com/containerd/containerd/blob/main/core/mount/mount_linux.go
- containerd PR #12092 "Only idmap once per overlayfs, not per layer": https://github.com/containerd/containerd/pull/12092
- Netflix TechBlog, "Mount Mayhem at Netflix: Scaling Containers on Modern CPUs": https://netflixtechblog.com/mount-mayhem-at-netflix-scaling-containers-on-modern-cpus-f3b09b68beac
- OCI Image Spec, Image Configuration: https://github.com/opencontainers/image-spec/blob/main/config.md
- Docker Docs, Storage drivers: https://docs.docker.com/engine/storage/drivers/
- Docker Docs, OverlayFS storage driver: https://docs.docker.com/engine/storage/drivers/overlayfs-driver/
- Docker Docs, Build cache: https://docs.docker.com/build/cache/
- Kubernetes Docs, User Namespaces: https://kubernetes.io/docs/concepts/workloads/pods/user-namespaces/
- Kubernetes Docs, Volumes: https://kubernetes.io/docs/concepts/storage/volumes/
- Kubernetes Docs, Local ephemeral storage: https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/#local-ephemeral-storage

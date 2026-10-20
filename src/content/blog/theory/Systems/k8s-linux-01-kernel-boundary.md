---
title: '[쿠버네티스 아래의 리눅스 1] 커널 경계: 쿠버네티스 컴포넌트는 프로세스이고 일은 시스템 콜이 한다'
description: kubelet부터 runc까지 쿠버네티스 노드의 구성 요소는 모두 유저 공간 프로세스이고 격리, 제한, 네트워킹은 시스템 콜을 받은 커널이 처리합니다. x86_64 시스템 콜 테이블, procfs와 sysfs, 노드 준비용 커널 설정, seccomp와 LSM, 노드 장애 시간표, EEVDF까지 시리즈 전체의 지도를 공식 문서와 커널 소스 기준으로 정리합니다.
date: 2026-10-20T00:00:00.000Z
tags:
  - Kubernetes
  - Linux
  - Kernel
  - System Call
  - procfs
  - kubelet
category: theory/Systems
topics:
  - systems
draft: false
series: "쿠버네티스 아래의 리눅스"
seriesOrder: 1
---

## 결론부터

1. kube-apiserver, kubelet, containerd, runc는 모두 유저 공간 프로세스입니다. 컨테이너 격리(네임스페이스), 자원 제한(cgroup), 파일시스템 합성(overlayfs), 패킷 전달(netfilter)은 이 프로세스들이 시스템 콜로 요청하고 커널이 수행합니다. 쿠버네티스를 이해하는 일의 절반은 "이 동작은 어느 시스템 콜에서 커널로 넘어가는지"를 아는 일입니다.
2. x86_64 커널의 64비트 시스템 콜 테이블에는 2026년 10월 torvalds/linux master 기준 386개 항목이 있습니다. 번호는 0부터 472까지 가지만 337번부터 423번까지는 비어 있어서 번호의 최댓값과 개수가 다릅니다.
3. `/proc`, `/sys`, `/sys/fs/cgroup`은 디스크에 없는 파일시스템입니다. 파일을 읽는 순간 커널이 내용을 만들어 주기 때문에 `du`는 0에 가깝게 나오고 `stat`의 크기도 0입니다. kubelet, cAdvisor, 런타임은 이 파일들을 읽고 써서 커널과 대화합니다.
4. kubelet의 축출 신호 `memory.available`은 `/proc/meminfo`의 `MemAvailable`과 계산식이 다릅니다. 공식 정의는 노드 메모리 용량에서 cgroup의 working set을 뺀 값입니다.
5. 최신 Container Runtimes 문서에서 노드 준비 필수 커널 설정은 `net.ipv4.ip_forward = 1` 하나입니다. `br_netfilter`와 `bridge-nf-call-iptables`는 리눅스 브리지를 쓰는 CNI에서 필요하고 Calico처럼 라우팅으로 동작하는 CNI에서는 필수 요건에서 빠집니다.
6. 노드 커널이 패닉으로 멈추면 컨트롤 플레인은 기본값 기준 약 50초 뒤 노드를 NotReady(정확히는 Ready 조건 Unknown)로 바꾸고 taint를 붙입니다. 파드는 다시 300초 뒤에 축출됩니다. 합치면 약 5분 50초입니다.

---

이 글은 시리즈 "쿠버네티스 아래의 리눅스"의 첫 글이자 지도입니다. 뒤의 네 편은 이 지도의 한 칸씩을 깊게 팝니다.

| 편 | 다루는 커널 기능 | 쿠버네티스에서 보이는 모습 |
|---|---|---|
| 1. 이 글 | 시스템 콜 경계, procfs/sysfs, 노드 커널 설정, seccomp/LSM | 노드 준비, NotReady, eviction 신호 |
| [2. 네임스페이스와 pause](/blog/theory/systems/k8s-linux-02-namespaces-pause) | `clone`, `unshare`, `setns`, 네임스페이스 8종 | 파드 안 컨테이너의 localhost 공유, pause 컨테이너 |
| [3. cgroup과 QoS](/blog/theory/systems/k8s-linux-03-cgroup-qos) | cgroup v2, `cpu.max`, `memory.max`, OOM killer | requests와 limits, QoS 클래스, OOMKilled |
| [4. OverlayFS](/blog/theory/systems/k8s-linux-04-overlayfs) | overlay 마운트, copy-up, whiteout | 이미지 레이어, 컨테이너 쓰기 계층 |
| [5. Service와 iptables, conntrack](/blog/theory/systems/k8s-linux-05-service-iptables-conntrack) | netfilter, NAT, conntrack | ClusterIP, NodePort, kube-proxy |

이 글을 쓴 환경에는 리눅스 노드도 클러스터도 없습니다. 명령 출력은 공식 문서나 소스에서 확인한 형태를 예시로 보인 것입니다. 각 장 끝의 "직접 해 보기"는 리눅스 VM이나 kind 클러스터에서 확인할 과제입니다.

## 1. 유저 공간, 커널 공간, 그리고 386개의 입구

### 1-1. 두 공간을 가르는 것은 CPU 권한 수준

리눅스에서 프로세스는 유저 모드로 실행됩니다. 유저 모드 코드는 하드웨어 장치, 페이지 테이블, 다른 프로세스의 메모리를 직접 건드릴 수 없습니다. 이런 일은 커널 모드에서 도는 커널 코드만 할 수 있습니다. x86_64에서는 이 구분이 CPU의 권한 링(ring 3과 ring 0)으로 구현됩니다.

유저 프로그램이 파일을 열거나 메모리를 더 받거나 새 프로세스를 만들려면 커널에 부탁해야 합니다. 그 부탁의 공식 통로가 시스템 콜입니다. x86_64에서는 `syscall` 명령어로 커널에 진입하고 `rax` 레지스터에 담은 번호로 어떤 시스템 콜인지 고릅니다. 커널은 그 번호로 시스템 콜 테이블을 찾아 해당 함수를 실행한 뒤 결과를 돌려주고 유저 모드로 복귀합니다.

쿠버네티스에 적용하면 이렇습니다. kubelet이 "이 컨테이너의 메모리를 170Mi로 제한한다"고 결정해도 그 결정은 kubelet 프로세스의 메모리 안에 있는 값일 뿐입니다. 실제 제한은 누군가가 `/sys/fs/cgroup/.../memory.max` 파일에 `openat`과 `write`를 호출해서 커널의 cgroup 자료구조를 바꾼 순간부터 걸립니다. 한도를 넘었을 때 프로세스를 죽이는 것도 커널입니다. 이 경로는 [3편](/blog/theory/systems/k8s-linux-03-cgroup-qos)에서 따라갑니다.

### 1-2. x86_64 시스템 콜 테이블: 386개, 번호는 0~472

x86_64의 시스템 콜 번호는 커널 소스 `arch/x86/entry/syscalls/syscall_64.tbl`에 정의되어 있습니다. 2026년 10월에 torvalds/linux master의 이 파일을 받아 ABI 열이 `common`이거나 `64`인 줄을 세면 다음과 같습니다.

| 항목 | 값 | 설명 |
|---|---|---|
| 64비트 ABI 항목 수 | 386 | `common`과 `64` 항목의 합 |
| 가장 작은 번호 | 0 | `read` |
| 가장 큰 번호 | 472 | `fchroot`(master 기준, 새 커널이 나오면 늘어남) |
| 빈 구간 | 337~423 | 336번 `uprobe` 다음이 424번 `pidfd_send_signal` |
| x32 전용 | 512~547, 36개 | 별도 ABI, 위 개수에 넣지 않음 |

번호가 472까지 있어도 개수가 386인 이유는 빈 구간 때문입니다. 424번 `pidfd_send_signal`부터는 모든 아키텍처가 같은 번호를 쓰도록 맞췄습니다. 그래서 x86_64는 당시 쓰던 번호 다음부터 423번까지를 비워 두었습니다. "시스템 콜이 460개쯤 있다"는 말은 이 번호 최댓값을 개수로 잘못 옮긴 경우가 많습니다. 개수는 커널 버전마다 늘어나므로 숫자를 쓸 때는 커널 버전이나 커밋 기준을 함께 적어야 합니다.

자주 보게 될 번호 몇 개를 적어 둡니다. `read`가 0, `write`가 1, `open`이 2, `openat`이 257입니다. 2편에서 볼 `clone`, `unshare`, `setns`와 4편의 `mount`도 모두 이 테이블에 있습니다.

### 1-3. strace로 본 `cat /proc/cpuinfo`

`strace`는 `ptrace`로 대상 프로세스의 시스템 콜 진입과 복귀를 가로채 출력합니다. `cat /proc/cpuinfo`를 추적하면 "파일을 읽어 화면에 쓴다"는 동작이 몇 개의 시스템 콜로 쪼개지는지 보입니다. 아래는 이런 형태로 나온다는 예시입니다. 버퍼 크기와 반환 바이트 수는 coreutils 버전과 CPU 수에 따라 달라집니다.

```text
$ strace -e trace=openat,fstat,read,write,close cat /proc/cpuinfo > /dev/null
openat(AT_FDCWD, "/etc/ld.so.cache", O_RDONLY|O_CLOEXEC) = 3
...
openat(AT_FDCWD, "/proc/cpuinfo", O_RDONLY) = 3
fstat(3, {st_mode=S_IFREG|0444, st_size=0, ...}) = 0
read(3, "processor\t: 0\nvendor_id\t: Genu"..., 131072) = 3072
write(1, "processor\t: 0\nvendor_id\t: Genu"..., 3072) = 3072
read(3, "", 131072) = 0
close(3) = 0
```

읽을 거리가 세 가지 있습니다.

- 프로그램은 `open`을 호출한 적이 없는데 `openat`이 찍힙니다. glibc의 `open()` 래퍼가 내부에서 `openat` 시스템 콜을 쓰기 때문입니다. 라이브러리 함수와 시스템 콜은 1:1로 대응하지 않습니다.
- `fstat`이 돌려준 `st_size`가 0입니다. 그런데 `read`는 수천 바이트를 돌려줍니다. 파일 크기가 0인데 내용이 있는 이유는 4장에서 설명합니다.
- 파일 디스크립터 3은 커널이 `openat`의 결과로 준 번호입니다. 이후 `read(3, ...)`는 "아까 연 그 파일"을 커널에 가리키는 방법입니다. 1번은 표준 출력입니다.

`strace -c`를 붙이면 호출별 횟수와 시간 합계를 표로 보여 줍니다. `ptrace`는 대상 프로세스를 크게 느리게 하므로 운영 노드에서는 짧게만 씁니다.

**직접 해 보기**

- 리눅스 VM에서 `strace -c ls /` 와 `strace -c cat /proc/meminfo`의 호출 목록을 비교합니다. 어떤 호출이 공통이고 어떤 것이 다른지 적어 봅니다.
- `uname -r`로 커널 버전을 확인하고 그 버전 태그의 `syscall_64.tbl`에서 항목 수를 직접 세어 봅니다.

## 2. kubelet에서 커널까지: 컴포넌트는 전부 프로세스

### 2-1. 노드 위에서 도는 프로세스

kubeadm으로 만든 클러스터의 워커 노드에서 `ps`를 보면 쿠버네티스 관련 프로세스는 대략 다음과 같습니다. 컨트롤 플레인 노드에는 여기에 kube-apiserver, etcd, kube-scheduler, kube-controller-manager가 정적 파드로 더해집니다.

| 프로세스 | 띄우는 주체(kubeadm 기준) | 주로 부르는 커널 기능 |
|---|---|---|
| `kubelet` | systemd 서비스 | cgroupfs 읽기와 쓰기, `/proc` 읽기, 마운트(볼륨) |
| `containerd` | systemd 서비스 | 이미지 압축 해제와 파일 쓰기, overlay 마운트 준비 |
| `containerd-shim-runc-v2` | containerd | 컨테이너 프로세스의 부모 역할, `wait4`로 종료 수거 |
| `runc` | shim이 실행하고 컨테이너를 만든 뒤 종료 | `clone`, `unshare`, `setns`, `mount`, `pivot_root`, cgroup 파일 쓰기, `execve` |
| `kube-proxy` | DaemonSet 파드 | netlink, iptables 또는 nftables 규칙 쓰기 |
| CNI 플러그인 바이너리 | containerd가 파드 생성 시 실행 | veth 생성, 라우팅과 주소 설정(netlink) |
| 앱 컨테이너의 프로세스 | runc가 `execve` | 앱이 부르는 모든 것 |

"kubelet만 컨테이너 밖에서 돈다"는 말은 kubeadm 기준에서만 맞습니다. 컨트롤 플레인을 systemd 서비스로 띄우는 구성도 있고 kind는 kubelet을 노드 역할을 하는 컨테이너 안에서 돌립니다. 어느 구성이든 이들은 같은 커널 위의 평범한 프로세스입니다. root 권한과 capability 덕분에 일반 프로세스보다 많은 시스템 콜을 허락받는 것이 차이의 전부입니다.

### 2-2. 파드 하나가 뜨는 경로

API 서버에 파드가 저장되고 스케줄러가 노드를 정한 뒤의 노드 쪽 경로를 그리면 다음과 같습니다. 화살표 오른쪽이 그 단계에서 커널로 넘어가는 대표 시스템 콜이나 파일입니다.

```text
kubelet  (API 서버를 watch하다 자기 노드에 배정된 파드를 발견)
  │  CRI gRPC, 유닉스 소켓 /run/containerd/containerd.sock
  ▼
containerd (CRI 플러그인)
  │  RunPodSandbox → CNI 플러그인 실행(veth, 라우트: netlink 소켓)     → 2편, 5편
  │  이미지 레이어 준비, overlay 마운트 옵션 계산                       → 4편
  │  ttrpc
  ▼
containerd-shim-runc-v2
  │  fork + execve("runc", ["runc", "create", ...])
  ▼
runc
  │  clone / unshare / setns        네임스페이스 생성과 합류        → 2편
  │  write(/sys/fs/cgroup/.../cpu.max, memory.max)  자원 제한        → 3편
  │  mount("overlay", rootfs, ...), pivot_root   루트 파일시스템    → 4편
  │  seccomp 필터 적재, LSM 프로필 지정                              → 6장
  │  execve(앱 바이너리)
  ▼
커널: 이후 격리, 제한, 스케줄링, OOM 처리는 커널이 혼자 집행
```

마지막 줄이 이 시리즈의 출발점입니다. runc는 컨테이너를 만든 뒤 종료하고 shim이 남아서 컨테이너 프로세스의 부모가 됩니다. 그 뒤로 메모리 한도를 넘은 프로세스를 죽이는 일, CPU 쿼터를 다 쓴 cgroup을 멈추는 일, Service IP로 가는 패킷의 목적지를 바꾸는 일은 사용자 공간의 어느 프로세스도 거치지 않고 커널 안에서 일어납니다. kubelet은 그 결과를 나중에 읽어서 `OOMKilled` 같은 상태로 보고합니다.

### 2-3. kube-proxy도 규칙을 쓰는 프로세스

kube-proxy의 iptables, ipvs, nftables 모드에서 kube-proxy는 패킷을 직접 중계하지 않습니다. Service와 EndpointSlice를 watch하다가 바뀌면 커널의 netfilter 규칙을 다시 씁니다. 실제 패킷의 목적지 변환(DNAT)과 연결 추적(conntrack)은 커널 netfilter가 패킷마다 수행합니다. 패킷을 사용자 공간으로 끌어올려 중계하던 userspace 모드는 v1.26에서 제거되었습니다. 규칙의 구조와 conntrack 문제는 [5편](/blog/theory/systems/k8s-linux-05-service-iptables-conntrack)에서 다룹니다.

**직접 해 보기**

- kubeadm 노드에서 `ps -eo pid,ppid,comm | grep -E 'kubelet|containerd|shim'`으로 부모 관계를 봅니다. 앱 컨테이너 프로세스의 PPID가 shim인지 확인합니다.
- `sudo strace -f -e trace=clone,clone3,unshare,setns,pivot_root,mount -p $(pidof containerd) -o /tmp/trace.txt`를 걸어 둔 상태에서 파드 하나를 만들고 `trace.txt`에서 runc가 부른 호출 순서를 찾아봅니다. 추적이 끝나면 바로 끕니다.
- `sudo systemctl restart containerd` 뒤에도 기존 파드의 컨테이너 프로세스 PID가 그대로인지 확인합니다. 컨테이너의 부모가 shim이고 네임스페이스와 cgroup은 커널 객체라서 containerd가 재시작해도 남습니다.

## 3. 커널 빌트인과 모듈: overlay와 br_netfilter

### 3-1. 빌트인과 모듈의 차이

커널 기능은 커널 이미지에 처음부터 들어간 빌트인과 필요할 때 적재하는 모듈(`.ko` 파일)로 나뉩니다. 어느 쪽으로 빌드할지는 배포판이 커널 설정(`CONFIG_...=y` 또는 `=m`)으로 정합니다.

| 기능 | 보통의 형태 | 이유 |
|---|---|---|
| 네임스페이스, cgroup | 빌트인 | 프로세스 생성과 스케줄링 코드에 엮인 코어 기능이라 모듈로 만들 수 없음 |
| overlay(overlayfs) | 대부분의 배포판에서 모듈 | 파일시스템 드라이버 |
| br_netfilter | 대부분의 배포판에서 모듈 | 브리지와 netfilter를 잇는 선택 기능 |

모듈이 빌트인으로 들어간 커널에서는 `lsmod`에 그 이름이 보이지 않습니다. 그래서 "lsmod에 overlay가 없으니 overlay를 못 쓴다"고 판단하면 틀릴 수 있습니다. `/proc/filesystems`에 `overlay`가 있는지, `/lib/modules/$(uname -r)/modules.builtin`에 이름이 있는지를 함께 봐야 합니다.

### 3-2. lsmod의 숫자 열은 참조 카운트

`lsmod`는 `/proc/modules`를 보기 좋게 출력하는 도구입니다. 출력은 이런 형태입니다.

```text
Module                  Size  Used by
br_netfilter           32768  0
bridge                 421888  1 br_netfilter
overlay                212992  12
```

세 번째 숫자 열("Used by")은 그 모듈을 쓰고 있는 사용자 수, 즉 참조 카운트입니다. 다른 모듈이 의존하거나 커널 객체가 모듈을 붙잡고 있으면 늘어납니다. `bridge` 줄의 `1 br_netfilter`는 `br_netfilter`가 `bridge`에 의존한다는 뜻입니다. overlay의 숫자가 마운트 수와 함께 움직이는 것처럼 보이는 것은 overlay 마운트 하나하나가 모듈 참조를 잡기 때문입니다. 숫자의 정의는 어디까지나 참조 카운트이고 0이 아니면 `rmmod`로 내릴 수 없습니다.

### 3-3. overlay는 마운트할 때 적재되고 br_netfilter는 따로 적재해야 한다

`mount -t overlay ...`처럼 커널이 모르는 파일시스템 타입을 요청받으면 커널은 `fs-overlay`라는 별칭으로 모듈 적재를 시도합니다(`fs/filesystems.c`의 `get_fs_type`이 `request_module("fs-%s")`를 부르고 overlay 모듈은 `MODULE_ALIAS_FS("overlay")`를 선언합니다). 그래서 overlay는 미리 `modprobe` 하지 않아도 containerd가 처음 마운트할 때 올라오는 경우가 많습니다.

br_netfilter는 이런 자동 경로가 없습니다. 적재되기 전에는 `/proc/sys/net/bridge/` 디렉터리 자체가 없어서 `sysctl net.bridge.bridge-nf-call-iptables`가 "No such file or directory"로 실패합니다. 옛 설치 문서가 `/etc/modules-load.d/k8s.conf`에 `overlay`와 `br_netfilter`를 적게 한 것은 부팅 때 확실히 올려 두려는 목적이었습니다. 이 설정이 지금 문서에서 어떻게 바뀌었는지는 5장에서 봅니다.

**직접 해 보기**

- `lsmod | grep -E 'overlay|br_netfilter|bridge'`, `grep overlay /proc/filesystems`, `grep -E 'overlay|br_netfilter' /lib/modules/$(uname -r)/modules.builtin`을 차례로 실행해 내 커널에서 두 기능이 모듈인지 빌트인인지 판단합니다.
- 파드를 몇 개 더 띄운 뒤 `lsmod | grep overlay`의 숫자가 바뀌는지 확인합니다.

## 4. VFS와 디스크에 없는 파일들

### 4-1. VFS 위에 붙은 가상 파일시스템

리눅스의 VFS(Virtual File System)는 `openat`, `read`, `write` 같은 공통 시스템 콜을 받아 실제 파일시스템 구현으로 넘기는 층입니다. ext4나 xfs는 이 요청을 디스크 블록 읽기로 바꿉니다. 반면 procfs, sysfs, cgroup2 같은 가상 파일시스템은 디스크를 건드리지 않고 커널 자료구조에서 그 자리에서 내용을 만들어 돌려줍니다. 쓰기 요청은 커널 설정값을 바꾸는 명령으로 해석합니다.

| 마운트 지점 | 파일시스템 타입 | 무엇을 보여 주나 | 쿠버네티스에서 누가 쓰나 |
|---|---|---|---|
| `/proc` | proc | 프로세스별 정보(`/proc/<pid>/...`), 커널 전역 정보(`cpuinfo`, `meminfo`), sysctl(`/proc/sys`) | kubelet, cAdvisor, 노드 준비 스크립트 |
| `/sys` | sysfs | 장치, 드라이버, 커널 객체 | CNI, 장치 플러그인 |
| `/sys/fs/cgroup` | cgroup2 | cgroup 계층과 컨트롤러 인터페이스 파일 | kubelet, runc |

"모든 것은 파일"이라는 유닉스 설계가 쿠버네티스에서 효과를 내는 지점이 여기입니다. kubelet이 cgroup을 만드는 방법은 `mkdir`이고 한도를 거는 방법은 `write`입니다. 런타임과 kubelet 사이에 커널 전용 API가 따로 필요하지 않습니다.

### 4-2. du가 0인 이유와 /proc/kcore

1장의 strace에서 `/proc/cpuinfo`의 `st_size`가 0이었던 이유가 이것입니다. procfs 파일은 디스크 블록을 차지하지 않고 내용이 읽는 순간 만들어지므로 크기를 미리 알 수 없습니다. 그래서 대부분 0으로 표시되고 `du -sh /proc`도 0에 가깝게 나옵니다. 읽기 프로그램은 크기를 믿지 않고 `read`가 0을 돌려줄 때까지 읽습니다.

예외처럼 보이는 파일이 `/proc/kcore`입니다. 커널 메모리를 ELF core 파일 형식으로 보여 주는 파일인데 `ls -l`로 보면 크기가 수십 TB로 나옵니다. 4단계 페이징을 쓰는 x86_64에서는 약 128TiB(약 140.7TB)가 흔합니다. 이 값은 커널이 매핑할 수 있는 가상 주소 공간의 범위이고 실제 메모리 사용량이나 디스크 사용량과는 관계가 없습니다. 5단계 페이징을 켠 시스템에서는 값이 다릅니다. 디스크 사용량을 조사하는 스크립트가 `/proc`을 제외하지 않으면 이 숫자에 놀라게 됩니다.

### 4-3. /proc/cpuinfo: SMT 판단과 가상 머신 판단

`/proc/cpuinfo`는 논리 CPU마다 한 블록을 출력합니다. 노드 사양을 확인할 때 쓰는 필드는 다음과 같습니다.

| 필드 | 의미 |
|---|---|
| `processor` | 논리 CPU 번호 |
| `physical id` | 소켓(패키지) 번호 |
| `siblings` | 그 패키지의 논리 CPU 수 |
| `cpu cores` | 그 패키지의 물리 코어 수 |
| `flags` | CPU 기능 플래그 |

SMT(인텔의 이름으로 하이퍼스레딩)가 실제로 켜져 있는지는 `siblings`와 `cpu cores`를 비교해서 판단합니다. `siblings`가 `cpu cores`보다 크면(보통 두 배) 코어 하나가 논리 CPU 둘로 보이는 상태입니다. 같으면 SMT가 꺼져 있거나 지원되지 않습니다.

`flags`의 `ht`는 판단 근거로 쓰면 안 됩니다. 이 플래그는 CPUID의 HTT 비트를 그대로 보여 주는 것이라 SMT가 없는 멀티코어 CPU에서도 나옵니다. `flags`에서 쓸모 있는 것은 `hypervisor`입니다. 이 플래그가 있으면 하이퍼바이저 위의 게스트, 즉 가상 머신에서 실행 중이라는 뜻입니다. 클라우드 노드가 베어메탈인지 VM인지 확인할 때 씁니다. `aes`는 AES-NI 명령어 지원 여부입니다.

쿠버네티스에서 노드의 `capacity.cpu`는 논리 CPU 수입니다. SMT가 켜진 노드의 CPU 8개는 물리 코어 4개일 수 있습니다.

### 4-4. /proc/meminfo: MemTotal, MemFree, MemAvailable

`/proc/meminfo`의 앞부분 세 줄은 이름이 비슷해서 자주 헷갈립니다. 커널 문서(`Documentation/filesystems/proc.rst`)의 정의를 옮기면 다음과 같습니다.

| 필드 | 커널 문서 정의 요약 |
|---|---|
| `MemTotal` | 쓸 수 있는 전체 RAM. 물리 RAM에서 예약 영역과 커널 바이너리 코드를 뺀 값 |
| `MemFree` | 어디에도 쓰이지 않는 RAM |
| `MemAvailable` | 스왑 없이 새 애플리케이션을 시작하는 데 쓸 수 있는 메모리의 추정치. `MemFree`, 회수 가능한 slab, 파일 LRU 크기, 존별 low watermark로 계산 |

`MemTotal`이 장착한 RAM보다 작은 것은 정상입니다. 펌웨어가 예약한 영역, `crashkernel=` 부트 옵션으로 kdump용으로 떼어 둔 영역, 커널 코드 자체가 빠집니다. 16GiB 인스턴스의 `MemTotal`이 16GiB에 못 미치는 이유가 이것입니다.

`MemFree`가 작은 것은 정상 상태입니다. 리눅스는 남는 메모리를 페이지 캐시로 씁니다. 이 캐시는 필요하면 비워서 돌려줄 수 있으므로 `MemFree`는 오래 돈 서버일수록 작아집니다. "지금 새 프로세스에 얼마를 줄 수 있나"를 보려면 `MemAvailable`을 봅니다.

### 4-5. kubelet의 memory.available은 다른 숫자

kubelet이 노드 메모리 압박을 판단할 때 쓰는 축출 신호 `memory.available`은 자체 계산식을 씁니다. Node-pressure Eviction 문서의 정의는 다음과 같습니다.

```text
memory.available := node.status.capacity[memory] - node.stats.memory.workingSet
```

문서는 이 값을 cgroupfs에서 구한다고 명시하고 `free -m` 같은 도구는 컨테이너 안에서 제대로 동작하지 않는다고 이유를 답니다. working set은 cgroup의 메모리 사용량에서 `inactive_file`(비활성 LRU 목록에 있는 파일 기반 메모리)을 뺀 값입니다. kubelet은 이 부분을 압박이 오면 회수할 수 있는 메모리로 봅니다. 리눅스 기본 hard eviction 임계값은 `memory.available<100Mi`입니다.

그래서 같은 순간에도 `MemAvailable`과 kubelet의 `memory.available`은 다르게 나올 수 있습니다. 계산에 넣는 캐시의 범위가 다르고 기준값도 `MemTotal`과 노드 capacity로 다릅니다. "free로 보면 아직 여유가 있는데 파드가 축출됐다"는 상황은 대개 이 차이에서 나옵니다. eviction 시점을 예측하려면 루트 cgroup의 `memory.current`와 `memory.stat`의 `inactive_file`을 봐야 합니다. 이 계산은 [3편](/blog/theory/systems/k8s-linux-03-cgroup-qos)에서 더 다룹니다.

**직접 해 보기**

- `mount | grep -E ' type (proc|sysfs|cgroup2) '`로 세 가상 파일시스템의 마운트 지점과 타입을 확인합니다.
- `stat /proc/meminfo`의 Size와 `wc -c /proc/meminfo`를 비교합니다. `ls -l /proc/kcore`의 크기도 봅니다.
- `grep -E 'physical id|siblings|cpu cores' /proc/cpuinfo | sort -u`로 SMT가 켜졌는지 판단하고 `grep -c hypervisor /proc/cpuinfo`로 VM인지 확인합니다. `lscpu`의 "Thread(s) per core"와 결과가 같은지 맞춰 봅니다.
- `grep -E 'MemTotal|MemFree|MemAvailable' /proc/meminfo`를 기록합니다. 같은 시각에 `kubectl get --raw "/api/v1/nodes/<노드>/proxy/stats/summary"`의 `node.memory.workingSetBytes`로 `memory.available`을 직접 계산해 둘을 비교합니다.

## 5. 노드를 준비할 때 만지는 커널 설정

### 5-1. 필수로 남은 것은 ip_forward 하나

쿠버네티스 공식 문서의 Container Runtimes 페이지는 노드 준비 단계의 네트워크 설정으로 IPv4 패킷 포워딩만 요구합니다. 문서의 예시는 이렇습니다.

```bash
cat <<EOF | sudo tee /etc/sysctl.d/k8s.conf
net.ipv4.ip_forward = 1
EOF
sudo sysctl --system
sysctl net.ipv4.ip_forward
```

문서는 리눅스 커널이 기본적으로 인터페이스 사이의 IPv4 라우팅을 허용하지 않는다고 설명합니다. 대부분의 클러스터 네트워크 구현이 이 값을 직접 바꾸지만 관리자에게 맡기는 구현도 있다고 덧붙입니다. 다른 sysctl이나 커널 모듈이 필요한지는 사용하는 네트워크 구현의 문서를 보라고 안내합니다.

예전 판(대략 1.29 이전)의 같은 문서에는 `overlay`, `br_netfilter` 모듈 적재와 sysctl 세 줄(`net.bridge.bridge-nf-call-iptables`, `net.bridge.bridge-nf-call-ip6tables`, `net.ipv4.ip_forward`)이 함께 있었습니다. 인터넷의 설치 글 상당수가 아직 이 판을 옮겨 적고 있습니다. 이 설정이 왜 필요한지 알아야 CNI를 바꿀 때 무엇을 지워도 되는지 판단할 수 있습니다.

`ip_forward`가 필요한 이유는 파드 트래픽의 경로에 있습니다. 파드의 veth 끝에서 나온 패킷이 노드의 다른 인터페이스(물리 NIC나 터널 장치)로 나가려면 노드가 라우터처럼 패킷을 넘겨줘야 합니다. 이 값이 0이면 커널은 자기 주소로 오지 않은 패킷을 버립니다.

### 5-2. br_netfilter와 bridge-nf-call-iptables

리눅스 브리지는 L2 스위치처럼 동작합니다. 같은 브리지에 붙은 인터페이스 사이의 프레임은 원래 IP 계층의 netfilter(iptables)를 거치지 않습니다. `br_netfilter` 모듈은 브리지를 지나는 트래픽도 iptables 체인을 통과하게 만드는 연결 고리입니다. 어느 트래픽을 태울지는 `net.bridge.bridge-nf-call-iptables`(IPv4)와 `bridge-nf-call-ip6tables`(IPv6)가 정합니다.

커널 문서(`ip-sysctl`)에 적힌 이 값의 기본값은 1입니다. 모듈을 적재하기만 하면 브리지 트래픽이 iptables를 거칩니다. 기본값이 0인 것은 `ip_forward` 쪽입니다.

이 설정이 쿠버네티스에서 중요한 이유는 kube-proxy의 Service 규칙이 iptables(또는 nftables)의 nat 체인에 있기 때문입니다. 같은 노드의 파드 A가 Service IP로 보낸 패킷의 응답이 브리지 안에서 바로 파드 A로 돌아가면 그 응답은 netfilter를 거치지 않아 conntrack이 주소를 되돌리지 못합니다. 파드 A는 엔드포인트 파드의 IP를 출발지로 단 응답을 받습니다. 자신이 연결한 Service IP와 맞지 않으므로 이 응답은 버려집니다. 이 비대칭 경로 문제는 [5편](/blog/theory/systems/k8s-linux-05-service-iptables-conntrack)에서 패킷 단위로 따라갑니다.

### 5-3. 브리지형 CNI와 라우팅형 CNI

br_netfilter가 필요한지는 CNI가 파드를 노드에 어떻게 잇는지로 정해집니다.

| 방식 | 대표 | 노드 쪽 구조 | br_netfilter |
|---|---|---|---|
| 브리지형 | bridge 플러그인, Flannel(`cni0`) | 파드의 veth 호스트 쪽 끝을 리눅스 브리지에 연결 | 필요(kube-proxy iptables 모드와 함께 쓸 때) |
| 라우팅형 | Calico | 브리지 없이 파드별 `/32` 라우트, 호스트 쪽 `cali*` veth에 proxy ARP | 파드 트래픽 경로에는 불필요 |
| eBPF 대체 | Cilium의 kube-proxy 대체 모드 | tc/XDP 훅에서 eBPF 프로그램이 처리 | 해당 CNI 문서를 따름 |

Calico는 파드 안의 기본 게이트웨이를 `169.254.1.1`로 잡습니다. 이 주소는 노드 어디에도 없습니다. 호스트 쪽 veth에 `proxy_arp`가 켜져 있어서 노드가 ARP에 대신 응답합니다. 그 뒤 패킷은 브리지를 거치지 않고 L3 라우팅으로 전달되므로 처음부터 netfilter를 통과합니다. 그래서 라우팅형 CNI에서는 br_netfilter가 파드 트래픽의 필수 조건에서 빠집니다. 브리지 구조는 [2편](/blog/theory/systems/k8s-linux-02-namespaces-pause)의 veth 절에서 다시 그립니다.

### 5-4. kubelet이 스스로 맞추는 sysctl

kubelet은 시작할 때 일부 커널 값을 직접 확인합니다. kubelet 소스(`pkg/kubelet/cm/container_manager_linux.go`의 `setupKernelTunables`)가 원하는 값은 다음과 같습니다.

| sysctl | kubelet이 기대하는 값 | 의미 |
|---|---|---|
| `vm.overcommit_memory` | 1 | 메모리 할당 요청을 항상 허용(실제 부족은 OOM killer가 처리) |
| `vm.panic_on_oom` | 0 | OOM 시 커널 패닉 대신 OOM killer 실행 |
| `kernel.panic` | 10 | 패닉 10초 뒤 자동 재부팅 |
| `kernel.panic_on_oops` | 1 | oops가 나면 패닉으로 처리 |
| `kernel.keys.root_maxkeys` | 1000000 | root 키링 키 개수 상한 |
| `kernel.keys.root_maxbytes` | 25000000 | root 키링 바이트 상한 |

기본 동작은 값이 다르면 kubelet이 이 값으로 바꾸는 것입니다. kubelet 설정의 `protectKernelDefaults: true`를 주면 바꾸지 않고 오류를 내며 시작하지 않습니다. 이 옵션을 켜면 위 값을 미리 sysctl 설정 파일에 넣어 두어야 합니다.

`kernel.panic = 10`과 `kernel.panic_on_oops = 1`의 조합은 7장과 이어집니다. oops가 난 커널은 패닉으로 넘어가고 10초 뒤 재부팅됩니다. 노드가 잠깐 사라졌다가 깨끗한 상태로 돌아오므로 컨트롤 플레인은 7장의 시간표 안에서 이 상황을 처리할 수 있습니다.

### 5-5. 스왑: NodeSwap은 1.34 GA, 기본값은 여전히 끔

"쿠버네티스 노드는 스왑을 꺼야 한다"는 말은 기본 설정 기준으로는 지금도 맞습니다. 다만 기능으로서의 스왑 지원은 NodeSwap(KEP-2400)으로 1.22 알파, 1.28 베타를 거쳐 1.34에서 GA가 되었습니다.

| kubelet 설정 | 기본값 | 동작 |
|---|---|---|
| `failSwapOn` | `true` | 스왑이 켜진 노드에서 kubelet이 시작하지 않음 |
| `memorySwap.swapBehavior` | `NoSwap` | `failSwapOn: false`로 시작해도 파드는 스왑을 쓰지 않음 |
| `memorySwap.swapBehavior: LimitedSwap` | 선택 | Burstable 파드만 메모리 요청 비율만큼 스왑 사용, Guaranteed와 BestEffort는 사용 불가 |

예전에 있던 `UnlimitedSwap`은 제거되었습니다. LimitedSwap은 cgroup v2가 필요합니다. 스왑을 켜면 메모리 압박이 OOM보다 지연으로 먼저 나타날 수 있으므로 eviction 임계값과 스왑 I/O 모니터링을 함께 설계해야 합니다.

### 5-6. cgroup v2는 1.35부터 기본 필수

쿠버네티스 1.35에서 cgroup v1 지원이 deprecated 되었습니다. 같은 버전에서 kubelet의 `failCgroupV1` 기본값이 `true`로 바뀌어 cgroup v1 노드에서는 kubelet이 기본적으로 시작하지 않습니다. kubeadm preflight도 오류를 냅니다. `failCgroupV1: false`로 당분간 우회할 수 있으며 코드 제거는 KEP-5573에서 따로 진행 중입니다. 정리하면 "기본적으로 필수, 임시 우회 가능"입니다.

노드가 어느 버전인지는 cgroups 문서가 안내하는 명령으로 확인합니다.

```bash
stat -fc %T /sys/fs/cgroup/
# cgroup2fs 이면 v2, tmpfs 이면 v1
```

cgroup v2에서는 Container Runtimes 문서가 kubelet과 런타임 모두 `systemd` cgroup 드라이버를 쓰라고 권합니다. 둘의 드라이버가 다르면 cgroup 관리자가 둘이 되어 노드가 불안정해질 수 있습니다.

**직접 해 보기**

- `sysctl net.ipv4.ip_forward net.bridge.bridge-nf-call-iptables`를 실행해 두 값과 오류 여부를 확인합니다. br_netfilter가 없는 노드라면 두 번째 값에서 오류가 나는지 봅니다.
- 쓰는 CNI의 노드에서 `ip link show type bridge`와 `ip route | head`를 봅니다. 브리지가 있는지, 파드별 `/32` 라우트가 있는지로 브리지형인지 라우팅형인지 판단합니다.
- `sysctl vm.overcommit_memory kernel.panic kernel.panic_on_oops`가 5-4절 표와 같은지 확인합니다. 같다면 kubelet이 바꿔 놓았을 가능성이 큽니다.
- `swapon --show`, `stat -fc %T /sys/fs/cgroup/`, `grep -E 'failSwapOn|swapBehavior|failCgroupV1|cgroupDriver' /var/lib/kubelet/config.yaml`로 노드의 스왑과 cgroup 상태를 한 번에 기록합니다.

## 6. 보안 경계: seccomp와 LSM

### 6-1. seccomp는 시스템 콜 입구의 필터

컨테이너 안의 프로세스도 결국 같은 커널에 시스템 콜을 부릅니다. 그래서 컨테이너 보안의 첫 경계는 "어떤 시스템 콜을 부를 수 있는가"입니다. seccomp(secure computing mode)는 프로세스에 BPF 필터를 붙여 시스템 콜 번호와 인자를 보고 허용, 거부(`EPERM` 등), 프로세스 종료를 정하는 커널 기능입니다. 1장의 시스템 콜 번호가 바로 이 필터의 입력입니다.

쿠버네티스에서는 파드나 컨테이너의 `securityContext`로 지정합니다.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: board-api
spec:
  securityContext:
    seccompProfile:
      type: RuntimeDefault
  containers:
  - name: app
    image: registry.example.com/board-api:1.4
```

`RuntimeDefault`는 컨테이너 런타임이 제공하는 기본 프로필을 쓰겠다는 뜻입니다. containerd의 기본 프로필은 Docker(moby) 기본 프로필과 같은 계열입니다. Docker 문서는 이 기본 프로필이 `kexec_load`, `reboot` 같은 호출을 막는다고 설명합니다. 필드는 1.19에서 GA가 되었습니다.

주의할 기본값이 있습니다. `seccompProfile`을 지정하지 않은 파드는 `Unconfined`, 즉 필터 없이 실행됩니다. 노드 전체의 기본값을 `RuntimeDefault`로 바꾸려면 kubelet 설정에서 `seccompDefault: true`를 켭니다(1.27 GA, 기본값 false). Pod Security Standards의 Restricted 수준은 `RuntimeDefault`나 `Localhost` 프로필을 요구합니다.

### 6-2. LSM은 커널 객체 접근의 훅

LSM(Linux Security Modules)은 커널 안의 여러 지점(파일 열기, 실행, 소켓 연결, capability 사용 등)에 훅을 두고 보안 모듈이 허용 여부를 판단하게 하는 프레임워크입니다. AppArmor와 SELinux가 대표적인 LSM입니다. seccomp는 LSM과 별개의 기능입니다.

| 장치 | 판단 시점 | 판단 근거 | 쿠버네티스 필드 |
|---|---|---|---|
| seccomp | 시스템 콜 진입 직후 | 시스템 콜 번호와 레지스터 인자 값 | `securityContext.seccompProfile` |
| AppArmor | 커널 내부 객체 접근 시(LSM 훅) | 경로 기반 프로필(이 경로를 읽어도 되는지) | `securityContext.appArmorProfile`(1.30 GA) |
| SELinux | 커널 내부 객체 접근 시(LSM 훅) | 프로세스와 파일에 붙은 라벨 | `securityContext.seLinuxOptions` |
| capability | 특권 동작 검사 시 | 프로세스가 가진 capability 집합 | `securityContext.capabilities` |

둘의 차이를 `openat` 하나로 보면 분명해집니다. seccomp는 "이 프로세스가 `openat`을 부를 수 있는지"를 번호로 판단합니다. 인자로 넘어온 경로 문자열은 사용자 메모리를 가리키는 포인터라서 seccomp 필터는 그 내용을 안전하게 볼 수 없습니다. AppArmor는 커널이 경로를 해석해 파일 객체를 찾은 뒤 훅에서 "이 프로필이 `/etc/shadow`를 읽어도 되는지"를 판단합니다. 그래서 두 장치는 층을 이룹니다. 시스템 콜 경계에서 한 번, 커널 객체 접근에서 또 한 번 거릅니다.

**직접 해 보기**

- `grep Seccomp /proc/<컨테이너 프로세스 pid>/status`로 seccomp 모드를 봅니다. 2이면 필터가 걸린 상태, 0이면 없는 상태입니다. `RuntimeDefault`를 준 파드와 주지 않은 파드를 비교합니다.
- `RuntimeDefault` 파드 안에서 `unshare --user --map-root-user true`처럼 기본 프로필이 제한하는 호출을 시도하고 결과를 봅니다(실습 클러스터에서만).
- 노드에서 `cat /sys/kernel/security/lsm`으로 활성화된 LSM 목록을 확인합니다. AppArmor라면 `aa-status`로 `cri-containerd.apparmor.d` 프로필이 적재되어 있는지 봅니다.

## 7. 노드가 죽었을 때: 커널 패닉에서 파드 축출까지

### 7-1. 패닉 후 약 5분 50초의 시간표

커널이 패닉에 빠지면 그 노드의 모든 유저 공간 프로세스가 함께 멈춥니다. kubelet도 예외가 아닙니다. kubelet은 평소 `kube-node-lease` 네임스페이스의 Lease 객체와 Node 상태를 갱신해 살아 있음을 알립니다. 이 갱신이 끊긴 뒤 컨트롤 플레인 쪽에서 일어나는 일을 기본값 기준 시간표로 적으면 다음과 같습니다.

| 시점(패닉 기준) | 주체 | 일어나는 일 |
|---|---|---|
| 0초 | 노드 커널 | 패닉. kubelet의 Lease와 상태 갱신 중단 |
| 약 50초 | node-lifecycle-controller | `--node-monitor-grace-period`(기본 50s, 옛 자료는 40s) 동안 갱신이 없어 Ready 조건을 `Unknown`으로 바꿈. `node.kubernetes.io/unreachable:NoExecute` taint 추가 |
| 약 50초 + 300초 | taint-eviction-controller | 파드의 `tolerationSeconds: 300`이 지나 파드 삭제 |
| 그 뒤 | ReplicaSet 등 워크로드 컨트롤러 | 삭제된 수만큼 새 파드 생성, 스케줄러가 다른 노드에 배치 |

300초는 파드를 만들 때 `DefaultTolerationSeconds` 어드미션 플러그인이 `node.kubernetes.io/not-ready`와 `node.kubernetes.io/unreachable`에 대한 300초 toleration을 자동으로 넣은 값입니다. 그래서 파드 spec에 이 toleration을 직접 짧게 적으면 그 파드만 더 빨리 축출됩니다.

kubelet이 살아 있는데 노드가 준비되지 않은 경우(예: 런타임 중단)는 Ready 조건이 `False`가 되고 taint 키가 `not-ready`입니다. 커널 패닉처럼 아무 보고도 없으면 `Unknown`과 `unreachable`입니다. `kubectl get node`의 STATUS에는 둘 다 `NotReady`로 보입니다.

5-4절의 `kernel.panic = 10` 덕분에 노드가 10초 뒤 재부팅되고 kubelet이 다시 올라오면 이 시간표는 중간에 끊깁니다. taint가 지워지고 아직 축출되지 않은 파드는 그 노드에서 다시 시작됩니다.

### 7-2. v1.34에서 나뉜 두 컨트롤러

예전에는 node-lifecycle-controller가 taint를 붙이는 일과 taint를 보고 파드를 지우는 일을 함께 했습니다. v1.34에서 KEP-3902가 GA가 되면서 둘이 나뉘었습니다. node-lifecycle-controller는 NoExecute taint를 붙이기만 하고 파드 삭제는 별도의 `taint-eviction-controller`가 맡습니다. 둘 다 kube-controller-manager 안에서 돌고 기본 동작은 같습니다. 달라진 점은 관리자가 taint 기반 축출만 끄거나 직접 구현한 컨트롤러로 바꿀 수 있게 되었다는 것입니다.

축출은 파드 삭제입니다. 새 파드는 워크로드 컨트롤러가 새 이름으로 만듭니다. 컨트롤러 없이 만든 단독 파드는 그대로 사라집니다. StatefulSet 파드는 같은 이름을 다시 써야 합니다. 그래서 죽은 노드의 파드가 실제로 멈췄는지 확인되기 전(노드 객체 삭제나 강제 삭제 전)에는 새 파드가 만들어지지 않고 기다릴 수 있습니다.

**직접 해 보기**

- kind 클러스터에서 `docker stop <클러스터이름>-worker`로 워커 노드 컨테이너를 멈춥니다. `kubectl get node -w`로 NotReady가 되기까지 걸리는 시간을 잽니다. `kubectl describe node`에서 Conditions가 `Unknown`인지와 taint 키를 확인합니다.
- 파드 spec에 `node.kubernetes.io/unreachable`에 대한 `tolerationSeconds: 30`을 넣은 Deployment를 같이 띄워 두고 축출 시점을 비교합니다.
- `kubectl get pod <pod> -o jsonpath='{.spec.tolerations}'`로 어드미션이 넣은 기본 toleration 두 개를 확인합니다.

## 8. CPU 스케줄러: EEVDF와 cpu.max

### 8-1. 6.6에서 바뀐 것은 실행 순서를 고르는 정책

리눅스 6.6(2023년 10월)부터 일반 프로세스(fair 클래스)의 스케줄링 정책이 CFS(Completely Fair Scheduler)에서 EEVDF(Earliest Eligible Virtual Deadline First)로 바뀌기 시작했습니다. 커널 문서도 "전환을 시작했다"고 표현합니다. EEVDF는 각 태스크가 받아야 할 몫과 실제로 받은 몫의 차이(lag)와 가상 마감 시각을 계산해 다음에 실행할 태스크를 고릅니다. 지연에 민감한 태스크가 더 빨리 CPU를 받게 하는 것이 목적입니다.

### 8-2. cpu.max 대역폭 제한은 그대로

쿠버네티스의 CPU limit은 이 정책 교체와 무관하게 같은 방식으로 동작합니다. `limits.cpu`는 cgroup v2의 `cpu.max`로 들어갑니다. 이 파일은 "주기(period)마다 쓸 수 있는 시간(quota)"을 정합니다. 커널 문서에서 이 기능의 이름은 지금도 "CFS Bandwidth Control"입니다.

```text
limits.cpu: 200m   →   cpu.max: "20000 100000"
(100,000µs 주기마다 20,000µs까지 실행, 다 쓰면 주기가 끝날 때까지 스로틀)
```

`requests.cpu`는 `cpu.weight`로 바뀌어 경쟁할 때의 상대적 몫을 정합니다. 이 비중을 실제 실행 순서로 풀어내는 쪽이 6.6 이후로는 EEVDF입니다. 즉 "누가 먼저 도는가"는 EEVDF가, "이 cgroup이 한 주기에 최대 얼마나 도는가"는 대역폭 제어가 맡습니다. 스로틀링 확인 방법(`cpu.stat`의 `nr_throttled`)과 weight 변환식은 [3편](/blog/theory/systems/k8s-linux-03-cgroup-qos)에서 다룹니다.

**직접 해 보기**

- `uname -r`로 노드 커널이 6.6 이상인지 확인합니다.
- `limits.cpu: 200m`인 파드를 띄우고 노드에서 그 컨테이너 cgroup의 `cpu.max`와 `cpu.stat`을 읽습니다. CPU를 계속 쓰는 프로세스를 돌린 뒤 `nr_throttled`가 늘어나는지 봅니다.

## 확인 문제

**1.** x86_64 `syscall_64.tbl`의 최대 번호가 472인데 64비트 항목 수가 386개인 이유는 무엇입니까?

<details>
<summary>정답</summary>

337번부터 423번까지가 비어 있기 때문입니다. 424번 `pidfd_send_signal`부터 모든 아키텍처가 같은 번호를 쓰도록 맞추면서 x86_64는 그 앞 구간을 비워 두었습니다. 개수와 최대 번호는 커널 버전마다 늘어나므로 기준(2026년 10월 master)을 함께 적어야 합니다.

</details>

**2.** `/proc/cpuinfo`의 `flags`에 `ht`가 있습니다. SMT(하이퍼스레딩)가 켜져 있다고 판단해도 됩니까?

<details>
<summary>정답</summary>

판단할 수 없습니다. `ht`는 CPUID의 HTT 비트를 보여 줄 뿐이라 SMT가 없는 멀티코어 CPU에서도 나옵니다. 같은 `physical id` 블록에서 `siblings`가 `cpu cores`보다 크면 SMT가 켜진 것입니다.

</details>

**3.** `free -m`의 available이 2Gi인데 kubelet이 `memory.available<100Mi`로 파드를 축출했습니다. 가능한 설명은 무엇입니까?

<details>
<summary>정답</summary>

kubelet의 `memory.available`은 노드 메모리 capacity에서 cgroupfs로 구한 working set(사용량에서 `inactive_file`을 뺀 값)을 빼서 계산합니다. `MemAvailable`과 회수 가능하다고 보는 범위와 기준값이 달라서 두 숫자가 크게 벌어질 수 있습니다.

</details>

**4.** Calico를 쓰는 클러스터에서 br_netfilter를 적재하지 않았습니다. 파드 간 Service 통신에 문제가 생깁니까? Flannel이라면 어떻습니까?

<details>
<summary>정답</summary>

Calico는 브리지 없이 파드별 `/32` 라우트와 proxy ARP로 L3 라우팅을 하므로 파드 트래픽이 원래 netfilter를 거칩니다. br_netfilter가 파드 트래픽의 필수 조건이 아닙니다. Flannel처럼 `cni0` 브리지를 쓰는 CNI와 kube-proxy iptables 모드 조합에서는 브리지 안에서 오가는 응답이 netfilter를 건너뛰어 conntrack이 주소를 되돌리지 못할 수 있으므로 br_netfilter가 필요합니다.

</details>

**5.** 스왑이 켜진 노드에 kubelet 1.36을 기본 설정으로 설치했습니다. 어떻게 됩니까? `failSwapOn: false`만 바꾸면 파드가 스왑을 씁니까?

<details>
<summary>정답</summary>

기본값 `failSwapOn: true` 때문에 kubelet이 시작하지 않습니다. `failSwapOn: false`로 바꿔도 `swapBehavior`의 기본값이 `NoSwap`이라 파드는 스왑을 쓰지 않습니다. `LimitedSwap`을 설정해야 Burstable 파드가 메모리 요청 비율만큼 스왑을 씁니다.

</details>

**6.** seccomp `RuntimeDefault`를 적용한 컨테이너에서도 AppArmor가 필요한 이유를 `openat`을 예로 설명하십시오.

<details>
<summary>정답</summary>

seccomp는 시스템 콜 진입 시점에 번호와 레지스터 값만 봅니다. `openat`의 경로 인자는 사용자 메모리를 가리키는 포인터라서 어떤 파일을 여는지 안전하게 판단할 수 없습니다. AppArmor는 커널이 경로를 해석해 파일 객체에 접근하는 지점의 LSM 훅에서 "이 프로필이 이 경로를 읽어도 되는지"를 판단합니다. 두 장치는 서로 다른 층을 거릅니다.

</details>

**7.** 기본 설정 클러스터에서 워커 노드 커널이 패닉으로 멈췄고 재부팅되지 않습니다. 그 노드의 Deployment 파드가 다른 노드에서 다시 뜨기까지 대략 얼마가 걸리고 각 구간의 근거는 무엇입니까?

<details>
<summary>정답</summary>

약 5분 50초에 새 파드 기동 시간이 더해집니다. `--node-monitor-grace-period` 기본 50초 뒤 node-lifecycle-controller가 Ready를 `Unknown`으로 바꾸고 `unreachable:NoExecute` taint를 붙입니다. `DefaultTolerationSeconds` 어드미션이 넣은 300초 toleration이 지나면 taint-eviction-controller(v1.34부터 분리)가 파드를 삭제합니다. 그 뒤 ReplicaSet이 새 파드를 만들고 스케줄러가 다른 노드에 배치합니다.

</details>

## 범위와 한계

- 이 글을 쓴 환경(macOS)에는 리눅스 노드와 클러스터가 없어서 명령을 실행하지 않았습니다. strace 출력, lsmod 출력은 형태를 보이기 위한 예시이고 바이트 수와 버퍼 크기는 환경마다 다릅니다.
- 시스템 콜 개수 386, 최대 번호 472, 빈 구간 337~423은 2026년 10월 20일에 torvalds/linux master의 `syscall_64.tbl`을 받아 센 값입니다. 안정 커널 버전별 개수는 따로 세지 않았습니다.
- 쿠버네티스 동작은 2026년 10월 기준 kubernetes.io 문서(1.35~1.37 시점)를 기준으로 했습니다. NodeSwap GA(1.34), cgroup v1 deprecated와 `failCgroupV1` 기본값 변경(1.35), taint-eviction-controller 분리(1.34)처럼 버전에 따라 달라지는 항목은 본문에 버전을 적었습니다.
- containerd 기본 seccomp 프로필의 정확한 차단 목록은 containerd 소스로 대조하지 않았습니다. 본문의 차단 예시(`kexec_load`, `reboot`)는 Docker 문서 기준입니다.
- `/proc/kcore`의 크기 약 128TiB는 4단계 페이징 x86_64에서 흔한 값이고 커널 설정과 5단계 페이징 여부에 따라 다릅니다.
- 6-1의 Pod Security Standards 세부 조항은 이번에 원문으로 다시 확인하지 않았습니다.
- 브리지형 CNI에서 br_netfilter가 없을 때의 실패 양상은 원리로 설명한 것이고 실험으로 재현하지 않았습니다.

## 참고 자료

리눅스 커널
- torvalds/linux, [arch/x86/entry/syscalls/syscall_64.tbl](https://github.com/torvalds/linux/blob/master/arch/x86/entry/syscalls/syscall_64.tbl)
- torvalds/linux, [fs/filesystems.c](https://github.com/torvalds/linux/blob/master/fs/filesystems.c) (`get_fs_type`의 모듈 자동 적재)
- [The /proc Filesystem](https://docs.kernel.org/filesystems/proc.html) (meminfo, kcore)
- [x86 Feature Flags](https://docs.kernel.org/arch/x86/cpuinfo.html)
- [IP Sysctl](https://docs.kernel.org/networking/ip-sysctl.html) (`ip_forward`, `bridge-nf-call-iptables`)
- [Control Group v2](https://docs.kernel.org/admin-guide/cgroup-v2.html)
- [CFS Bandwidth Control](https://docs.kernel.org/scheduler/sched-bwc.html)
- [EEVDF Scheduler](https://docs.kernel.org/scheduler/sched-eevdf.html)
- [Seccomp BPF](https://docs.kernel.org/userspace-api/seccomp_filter.html)
- [Linux Security Module Usage](https://docs.kernel.org/admin-guide/LSM/index.html)

man 페이지
- [syscalls(2)](https://man7.org/linux/man-pages/man2/syscalls.2.html), [strace(1)](https://man7.org/linux/man-pages/man1/strace.1.html)
- [lsmod(8)](https://man7.org/linux/man-pages/man8/lsmod.8.html), [proc_modules(5)](https://man7.org/linux/man-pages/man5/proc_modules.5.html)

kubernetes.io
- [Container Runtimes](https://kubernetes.io/docs/setup/production-environment/container-runtimes/)
- [About cgroup v2](https://kubernetes.io/docs/concepts/architecture/cgroups/)
- [Swap memory management](https://kubernetes.io/docs/concepts/cluster-administration/swap-memory-management/)
- [Node-pressure Eviction](https://kubernetes.io/docs/concepts/scheduling-eviction/node-pressure-eviction/)
- [Taints and Tolerations](https://kubernetes.io/docs/concepts/scheduling-eviction/taint-and-toleration/)
- [Nodes](https://kubernetes.io/docs/concepts/architecture/nodes/)
- [kube-controller-manager](https://kubernetes.io/docs/reference/command-line-tools-reference/kube-controller-manager/)
- [Kubernetes v1.34: Decoupled Taint Manager Is Now Stable](https://kubernetes.io/blog/2025/09/15/kubernetes-v1-34-decoupled-taint-manager-is-now-stable/)
- [Restrict a Container's Syscalls with seccomp](https://kubernetes.io/docs/tutorials/security/seccomp/)
- [Restrict a Container's Access to Resources with AppArmor](https://kubernetes.io/docs/tutorials/security/apparmor/)
- [Virtual IPs and Service Proxies](https://kubernetes.io/docs/reference/networking/virtual-ips/)
- KEP: [2400 NodeSwap](https://www.kubernetes.dev/resources/keps/2400/), [5573 cgroup v1 제거](https://www.kubernetes.dev/resources/keps/5573/)

소스와 기타
- kubernetes/kubernetes, [pkg/kubelet/cm/container_manager_linux.go](https://github.com/kubernetes/kubernetes/blob/master/pkg/kubelet/cm/container_manager_linux.go) (`setupKernelTunables`)
- kubernetes/component-helpers, [node/util/sysctl/sysctl.go](https://github.com/kubernetes/component-helpers/blob/master/node/util/sysctl/sysctl.go)
- containerd, [core/runtime/v2/README.md](https://github.com/containerd/containerd/blob/main/core/runtime/v2/README.md) (shim 구조)
- Docker Docs, [Seccomp security profiles for Docker](https://docs.docker.com/engine/security/seccomp/)
- Tigera, [Calico FAQ](https://docs.tigera.io/calico/latest/reference/faq) (169.254.1.1과 proxy ARP)

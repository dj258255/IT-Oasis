---
title: '[쿠버네티스 아래의 리눅스 2] 네임스페이스와 pause: 파드 안에서 무엇을 나눠 쓰고 무엇을 따로 두는지'
description: 커널에는 컨테이너라는 객체가 없고 프로세스와 네임스페이스만 있습니다. 네임스페이스 8종을 unshare로 하나씩 재현해 보고 runc가 실제로 네임스페이스를 만드는 순서, 파드가 net·ipc·uts를 공유하고 pid·mnt·cgroup을 컨테이너별로 두는 방식, pause 컨테이너와 RunPodSandbox의 역할을 커널·runc·containerd·쿠버네티스 소스 기준으로 정리합니다.
date: 2026-10-20T00:00:00.000Z
tags:
  - Kubernetes
  - Linux
  - Namespace
  - Container
  - runc
  - containerd
category: theory/Systems
topics:
  - systems
draft: false
series: "쿠버네티스 아래의 리눅스"
seriesOrder: 2
---

## 결론부터

1. 리눅스 커널에는 컨테이너라는 자료 구조가 없습니다. 커널이 아는 것은 프로세스(`task_struct`)와 그 프로세스가 가리키는 네임스페이스 묶음(`nsproxy`), cgroup뿐입니다. 컨테이너는 runc 같은 런타임이 네임스페이스와 cgroup, 루트 파일시스템을 조합해 붙인 이름입니다.
2. 네임스페이스는 8종입니다(mnt, uts, ipc, pid, net, user, cgroup, time). 각 프로세스가 어느 네임스페이스에 속하는지는 `/proc/<pid>/ns/` 아래 링크의 inode 번호로 확인합니다. 두 프로세스의 번호가 같으면 같은 네임스페이스입니다.
3. runc는 컨테이너를 만들 때 `clone(CLONE_PARENT)`로 자식을 띄우고 그 자식이 `unshare(flags)`로 새 네임스페이스를 만든 다음 PID 네임스페이스에 실제로 들어가려고 `clone`을 한 번 더 합니다. 파드 샌드박스에 이미 있는 네임스페이스에 합류할 때는 `setns()`를 씁니다.
4. 한 파드의 컨테이너들은 net, ipc, uts 네임스페이스를 공유합니다. pid와 mnt는 컨테이너마다 따로이고(`shareProcessNamespace: true`이면 pid도 공유), cgroup v2와 containerd 조합에서는 cgroup 네임스페이스도 컨테이너마다 따로 생깁니다. user 네임스페이스는 기본값에서 호스트 것을 쓰고 `hostUsers: false`일 때 파드마다 새로 생깁니다(1.36 GA).
5. pause 컨테이너는 파드의 공유 네임스페이스를 붙잡아 두는 샌드박스입니다. CRI에서는 `RunPodSandbox`로 만듭니다. containerd 경로에서는 containerd가 네트워크 네임스페이스를 만들고 CNI를 호출합니다. 그래서 컨테이너가 재시작되어도 파드 IP는 그대로이고 샌드박스가 다시 만들어지면 보통 새 IP를 받습니다.

1편 [커널 경계](/blog/theory/systems/k8s-linux-01-kernel-boundary)에서 쿠버네티스가 결국 시스템 콜로 커널에 일을 시킨다는 흐름을 봤습니다. 이번 글은 그 시스템 콜 중 격리를 만드는 쪽, 즉 `clone`, `unshare`, `setns`를 다룹니다. 자원 제한을 만드는 cgroup은 [3편](/blog/theory/systems/k8s-linux-03-cgroup-qos)에서 다룹니다.

2026-10-20에 kind v0.33 클러스터(노드 v1.37.0, containerd 2.3.4, runc 1.4.3)를 colima VM(Ubuntu 24.04.4, 커널 6.8.0-117-generic, arm64) 위에 띄워 각 장의 "직접 해 보기"를 돌렸습니다. unshare 실습은 kind 노드 컨테이너 안에서 했고 커널은 colima VM의 것입니다. 실측 결과는 과제 아래에 붙였고 본문의 나머지 출력은 man 페이지와 소스, 공식 문서에 나온 형태를 옮긴 것입니다.

---

## 1. 커널이 아는 것은 프로세스와 네임스페이스

### 1-1. 컨테이너는 런타임이 조합한 이름

<details>
<summary>기초부터: 네임스페이스란 무엇이고 컨테이너는 무엇으로 만들어지나</summary>

> **핵심 한 줄**: 네임스페이스는 같은 커널을 쓰는 프로세스들에게 각자 따로 쓰는 것 같은 시야를 주는 커널 기능입니다. 아파트 한 동(커널)에 여러 세대(프로세스 묶음)가 살면서 서로의 집 안을 못 보는 것과 비슷합니다.

#### 1. 왜 필요한가
- 호스트에 직접 설치한 프로그램(systemd, kubelet, containerd, 호스트에 깐 nginx)은 모두 같은 PID 네임스페이스에 있습니다. 노드에서 `readlink /proc/1/ns/pid`와 `readlink /proc/$(pgrep -o kubelet)/ns/pid`를 비교하면 같은 번호가 나오는 형태입니다(초기 PID 네임스페이스는 `pid:[4026531836]`).
- 같은 방에 있으니 서로의 프로세스가 `ps`에 보이고 권한만 있으면 `kill`로 끝낼 수도 있습니다. 쇼핑몰 웹 서버 하나가 실수로 옆 결제 프로세스에 시그널을 보낼 수 있는 구조입니다.
- 컨테이너는 이 공용 공간에서 프로세스 하나를 떼어 내 새 네임스페이스로 옮긴 것입니다.

#### 2. 어떻게 동작하나: 컨테이너를 이루는 세 기둥
| 기둥 | 커널 기능 | 정하는 것 | 이 시리즈 |
|---|---|---|---|
| 격리 | 네임스페이스 | 무엇이 보이는가 | 2편(이 글) |
| 자원 제한 | cgroup | 얼마나 쓸 수 있는가 | 3편 |
| 파일시스템 | OverlayFS 같은 union 마운트 + mount 네임스페이스 | 어떤 루트 파일시스템 위에서 도는가 | 4편 |

Docker, containerd, CRI-O, runc는 이 커널 기능을 편하게 부르는 도구입니다. 도구를 바꿔도 마지막에 도착하는 커널 호출은 같습니다. 그래서 이 시리즈는 도구보다 커널 쪽을 먼저 봅니다.

#### 3. 이 글이 답하는 다섯 질문
| 질문 | 관련 네임스페이스 | 답이 있는 곳 |
|---|---|---|
| 같은 파드의 사이드카에 왜 `localhost`로 닿나 | net | 5-1, 6-6 |
| 다른 컨테이너의 프로세스가 왜 `ps`에 안 보이나 | pid | 2-3 |
| 컨테이너가 재시작되면 IP가 바뀌나 | net + pause | 6-5 |
| 컨테이너 안의 앱은 왜 PID 1인가 | pid | 2-1, 2-2 |
| 컨테이너 안 `hostname`이 왜 파드 이름인가 | uts | 3-1 |

#### 4. 헷갈리는 점
- 세 번째 질문은 "항상 바뀐다"로 정리하는 자료가 있습니다. 컨테이너만 재시작되면 샌드박스가 그대로라 IP도 유지됩니다. IP가 새로 나오는 경우는 샌드박스가 다시 만들어질 때(파드 재생성, pause 사망, 노드 재부팅)이고 그때도 IPAM이 같은 주소를 줄 수 있습니다(6-5).

> **정리**: 커널에는 컨테이너가 없고 프로세스와 그 프로세스가 가리키는 네임스페이스, cgroup, 마운트만 있습니다. 이 글은 그중 네임스페이스를 다룹니다.

</details>

커널 소스에서 `container`라는 구조체를 찾으면 나오지 않습니다. 프로세스를 나타내는 `task_struct`에는 `nsproxy` 포인터가 있고 `nsproxy`는 이 프로세스가 쓰는 uts, ipc, mnt, pid(자식용), net, time, cgroup 네임스페이스를 가리킵니다. user 네임스페이스는 프로세스의 자격 증명(`cred`) 쪽에 달려 있습니다. cgroup 소속은 `css_set`으로 따로 관리합니다.

그래서 "컨테이너 안의 nginx"는 커널 입장에서 이렇게 생긴 평범한 프로세스입니다.

```
task_struct (nginx, 호스트 PID 48211)
  ├─ nsproxy ──> uts_ns(A) ipc_ns(A) mnt_ns(B) net_ns(A) cgroup_ns(C) ...
  ├─ cred ─────> user_ns(초기 user 네임스페이스)
  └─ cgroups ──> css_set(/kubepods.slice/.../cri-containerd-xxx.scope)
```

호스트 PID 48211은 설명용으로 붙인 숫자입니다. 같은 노드의 다른 프로세스와 다른 점은 포인터가 가리키는 대상뿐입니다. 런타임은 이 포인터들이 원하는 곳을 가리키도록 시스템 콜을 순서대로 부르고 그 결과물에 컨테이너라는 이름을 붙입니다.

### 1-2. 쿠버네티스 Namespace와 이름만 같음

쿠버네티스의 `Namespace` 오브젝트(`kube-system`, `default` 같은 것)는 API 서버가 관리하는 이름 범위입니다. 오브젝트 이름이 겹치지 않게 하고 RBAC, ResourceQuota를 거는 단위입니다. 노드의 커널에는 이에 해당하는 것이 아무것도 생기지 않습니다. `shop` Namespace와 `board` Namespace의 파드가 같은 노드에 떠도 커널 수준의 차이는 파드별로 생기는 리눅스 네임스페이스뿐입니다.

이 글에서 "네임스페이스"는 전부 리눅스 커널의 네임스페이스를 뜻합니다. 쿠버네티스 쪽을 말할 때는 영문 `Namespace`로 적습니다.

### 1-3. 네임스페이스 8종과 CLONE_NEW* 플래그

namespaces(7)의 표를 옮기고 clone(2)에 적힌 도입 버전을 붙였습니다.

| 종류 | 플래그 | 격리하는 것 | 도입 커널 |
|---|---|---|---|
| Mount | `CLONE_NEWNS` | 마운트 지점 목록 | 2.4.19 (2002) |
| UTS | `CLONE_NEWUTS` | 호스트 이름, NIS 도메인 이름 | 2.6.19 |
| IPC | `CLONE_NEWIPC` | System V IPC, POSIX 메시지 큐 | 2.6.19 |
| PID | `CLONE_NEWPID` | 프로세스 번호 | 2.6.24 |
| Network | `CLONE_NEWNET` | 네트워크 장치, 스택, 포트, 라우팅 | 2.6.24 |
| User | `CLONE_NEWUSER` | UID/GID, 권한(capability) | 2.6.23부터 단계적, 3.8에서 완성 |
| Cgroup | `CLONE_NEWCGROUP` | cgroup 루트 디렉터리 | 4.6 |
| Time | `CLONE_NEWTIME` | 부팅 시각, monotonic 시계 | 5.6 (2020) |

Mount 네임스페이스만 플래그 이름이 `CLONE_NEWNS`라서 다른 종류와 모양이 다릅니다. mount 네임스페이스가 리눅스에 처음 들어온 네임스페이스였기 때문입니다. 2002년 2.4.19 당시에는 다른 종류가 없었으니 "새 네임스페이스(NEW NameSpace)"라는 이름으로 충분했습니다. 나머지 종류가 몇 년 뒤에 차례로 들어오면서 이름이 비대칭으로 남았습니다.

쿠버네티스 Pod API에는 time 네임스페이스를 고르는 필드가 없어서 파드는 언제나 호스트의 time 네임스페이스를 씁니다. 그래서 이 글의 나머지 부분은 7종을 다룹니다.

Cgroup 네임스페이스는 자원을 제한하지 않습니다. `/proc/self/cgroup`과 `/sys/fs/cgroup`에서 보이는 루트를 자기 cgroup으로 바꿔 바깥 계층 구조를 숨기는 시야 격리입니다. 제한은 cgroup 자체가 합니다.

### 1-4. /proc/<pid>/ns 링크와 inode 번호

프로세스마다 `/proc/<pid>/ns/` 디렉터리에 종류별 심볼릭 링크가 있습니다. 링크 대상은 `종류:[inode 번호]` 형태입니다. namespaces(7) 예시와 같은 모양으로 적으면 이렇습니다.

```
$ ls -l /proc/$$/ns
lrwxrwxrwx 1 root root 0 ... cgroup -> 'cgroup:[4026531835]'
lrwxrwxrwx 1 root root 0 ... ipc -> 'ipc:[4026531839]'
lrwxrwxrwx 1 root root 0 ... mnt -> 'mnt:[4026531832]'
lrwxrwxrwx 1 root root 0 ... net -> 'net:[4026531833]'
lrwxrwxrwx 1 root root 0 ... pid -> 'pid:[4026531836]'
lrwxrwxrwx 1 root root 0 ... pid_for_children -> 'pid:[4026531836]'
lrwxrwxrwx 1 root root 0 ... time -> 'time:[4026531834]'
lrwxrwxrwx 1 root root 0 ... time_for_children -> 'time:[4026531834]'
lrwxrwxrwx 1 root root 0 ... user -> 'user:[4026531837]'
lrwxrwxrwx 1 root root 0 ... uts -> 'uts:[4026531838]'
```

번호가 4026531832부터 4026531839 사이에 몰려 있는 이유는 커널이 부팅 때 만드는 초기 네임스페이스에 고정 번호를 주기 때문입니다. 값은 0xEFFFFFFF에서 아래로 하나씩 내려갑니다.

| 초기 네임스페이스 | 상수 | 10진수 | 고정된 시점 |
|---|---|---|---|
| ipc | `IPC_NS_INIT_INO` 0xEFFFFFFF | 4026531839 | 6.16 이전부터 |
| uts | `UTS_NS_INIT_INO` 0xEFFFFFFE | 4026531838 | 6.16 이전부터 |
| user | `USER_NS_INIT_INO` 0xEFFFFFFD | 4026531837 | 6.16 이전부터 |
| pid | `PID_NS_INIT_INO` 0xEFFFFFFC | 4026531836 | 6.16 이전부터 |
| cgroup | `CGROUP_NS_INIT_INO` 0xEFFFFFFB | 4026531835 | 4.6 도입 때부터 |
| time | `TIME_NS_INIT_INO` 0xEFFFFFFA | 4026531834 | 5.6 도입 때부터 |
| net | `NET_NS_INIT_INO` 0xEFFFFFF9 | 4026531833 | 6.17부터 |
| mnt | `MNT_NS_INIT_INO` 0xEFFFFFF8 | 4026531832 | 6.17부터 |

6.16 이하의 `include/linux/proc_ns.h`에는 위 표의 앞 여섯 개만 고정값(`PROC_*_INIT_INO`)으로 정의되어 있습니다. net과 mnt는 부팅할 때 동적으로 번호를 받았기 때문에 예전 시스템에서는 `net:[4026531992]`처럼 시스템마다 다른 값이 보였습니다. 6.17부터는 상수가 uapi 헤더 `include/uapi/linux/nsfs.h`로 옮겨졌고 net과 mnt도 고정값을 받습니다. 그러니 위 출력 예시의 net, mnt 번호는 6.17 이상 커널을 가정한 것입니다.

이 번호를 쓰는 방법은 단순합니다. 두 프로세스의 같은 종류 링크가 같은 번호를 가리키면 같은 네임스페이스에 있습니다. `lsns` 명령은 이 정보를 모아 표로 보여 줍니다.

네임스페이스는 안에 프로세스가 하나도 없으면 사라집니다. 예외는 namespaces(7)의 "Namespace lifetime" 절에 정리되어 있습니다. 누군가 `/proc/<pid>/ns/*` 파일을 열어 fd를 쥐고 있거나, 그 파일을 다른 곳에 bind mount 했거나, 자식 PID·user 네임스페이스처럼 계층 관계로 참조되는 경우입니다. 뒤에서 볼 `ip netns add`와 containerd의 네트워크 네임스페이스 고정은 bind mount 방식을 씁니다.

### 1-5. 직접 해 보기

리눅스 VM에서 셸 두 개를 열고 각각 `readlink /proc/$$/ns/pid`와 `readlink /proc/$$/ns/net`을 비교합니다. 같은 번호가 나오는지 확인한 뒤 `uname -r`로 커널 버전을 보고 net 번호가 4026531833인지(6.17 이상), 다른 값인지(6.16 이하) 적습니다.

kind 노드 안에서(`docker exec -it kind-control-plane bash`) 같은 명령을 실행하면 pid 번호가 4026531836과 다르게 나옵니다. kind 노드 자체가 컨테이너라서 호스트의 초기 PID 네임스페이스 밖에 있기 때문입니다. 실습 환경이 어느 층에 있는지 이 번호로 알 수 있습니다.

실측(colima VM, 커널 6.8.0-117-generic)에서 VM의 net 번호는 4026531840, mnt 번호는 4026531841이었습니다. 6.16 이하 커널이라 고정 번호와 다른 값이 나왔습니다. kind 노드 안에서는 pid, net, mnt, uts, ipc, cgroup, time이 모두 VM과 다른 번호였고 user만 VM과 같은 4026531837이었습니다. kind 노드는 user 네임스페이스를 따로 만들지 않는 컨테이너입니다.

## 2. PID 네임스페이스: 번호를 두 개 가진 프로세스

### 2-1. unshare --pid --fork --mount-proc로 PID 1 만들기

<details>
<summary>기초부터: --mount-proc을 손으로 풀어 보기와 hostPID 비교</summary>

> **핵심 한 줄**: `--mount-proc`은 "새 mount 네임스페이스를 만들고 그 안에 proc을 다시 마운트"하는 두 동작을 한 옵션으로 줄인 것입니다.

#### 1. 손으로 풀어 쓴 순서
```bash
sudo unshare --pid --mount --fork bash   # PID와 mount 네임스페이스를 새로, bash는 자식으로
mount -t proc proc /proc                 # 새 PID 네임스페이스 기준으로 /proc 다시 마운트
ps aux                                   # bash와 ps만 보이는 형태
echo $$                                  # 1
exit                                     # PID 1이 끝나면 네임스페이스도 정리됨
```

| 조각 | 뜻 |
|---|---|
| `--mount` | 마운트 목록을 따로 갖게 합니다. 이게 없으면 다음 줄의 proc 마운트가 호스트의 `/proc`을 덮어 버립니다 |
| `-t proc` | 파일시스템 종류가 proc이라는 뜻입니다. 디스크에 저장된 내용은 없고 읽을 때마다 커널이 내용을 만들어 줍니다 |
| 앞의 `proc` | 마운트 원본 이름 자리입니다. proc은 장치가 없어서 관례로 `proc`을 적을 뿐이고 다른 문자열이어도 마운트됩니다 |
| 마지막 `/proc` | 마운트할 위치입니다 |

#### 2. 바깥 프로세스는 이름조차 없음
안쪽에서 `kill -0 <호스트의 containerd PID>`를 실행하면 `No such process`가 나오는 형태입니다. `kill -0`은 시그널을 보내지 않고 "그 번호의 프로세스가 있고 내가 시그널을 보낼 수 있는가"만 확인합니다(kill(2)). 바깥 프로세스는 안쪽 네임스페이스에서 부를 번호가 없으니 존재하지 않는 것으로 나옵니다(2-3).

#### 3. 쿠버네티스에서 같은 차이 보기: hostPID
| 파드 설정 | pid 링크 번호 | 의미 |
|---|---|---|
| `hostPID: true` | 노드 init과 같은 번호 | 노드의 PID 네임스페이스에 합류, 격리 없음 |
| `hostPID` 생략(기본 false) | 노드와 다른 번호 | 새 PID 네임스페이스 |

노드에서 `crictl inspect <컨테이너ID>`의 `info.pid`로 호스트 PID를 찾고 `readlink /proc/<PID>/ns/pid`를 노드 init의 값과 비교하면 위 차이가 보입니다. `hostPID: true`의 위험과 PSA 차단은 5-5에 있습니다.

> **정리**: unshare 옵션 하나하나가 시스템 콜 플래그 하나와 마운트 한 번에 대응합니다. 컨테이너 런타임도 같은 조각을 순서대로 실행합니다.

</details>

unshare(1)로 새 PID 네임스페이스를 만들면 그 안에서 셸이 PID 1이 됩니다. root 권한이 필요합니다(또는 `--user --map-root-user`로 user 네임스페이스를 함께 만듭니다).

```bash
sudo unshare --pid --fork --mount-proc bash
# 안쪽 셸에서
echo $$          # 1
ps -ef           # bash와 ps 두 줄만 보이는 형태
```

옵션 세 개는 각자 이유가 있습니다.

| 옵션 | 이유 |
|---|---|
| `--pid` | `unshare(CLONE_NEWPID)`를 호출합니다. 이 호출은 호출한 프로세스 자신을 옮기지 않고 이후에 만드는 자식만 새 PID 네임스페이스에 넣습니다 |
| `--fork` | 그래서 자식을 하나 띄워야 합니다. 이 자식이 새 네임스페이스의 첫 프로세스, 즉 PID 1이 됩니다 |
| `--mount-proc` | `/proc`는 마운트한 시점의 PID 네임스페이스를 보여 줍니다. 새 mount 네임스페이스를 만들고(이 옵션이 `--mount`를 함께 켭니다) 그 안에 proc을 다시 마운트해야 `ps`가 새 네임스페이스 기준으로 나옵니다 |

`--fork`를 빼면 unshare 자신이 `exec`로 bash가 되는데 bash는 원래 PID 네임스페이스에 남아 있습니다. 그 bash가 처음 만드는 자식(예를 들어 첫 번째 `ls`)이 새 네임스페이스의 PID 1이 됩니다. 그 자식이 끝나면 PID 1이 사라진 네임스페이스에서는 더 이상 fork가 되지 않아 `Cannot allocate memory` 오류가 납니다. pid_namespaces(7)에 이 동작이 나옵니다(PID 1이 끝난 네임스페이스에 `fork`하면 `ENOMEM`).

`--mount-proc`를 빼면 `echo $$`는 1인데 `ps`는 호스트의 모든 프로세스를 보여 주는 어긋난 상태가 됩니다. `ps`는 `/proc` 디렉터리를 읽어서 목록을 만들기 때문입니다.

### 2-2. struct pid의 이중 매핑

안쪽에서 PID 1인 bash를 바깥에서 보면 평범한 번호(예: 48211)를 가집니다. 커널은 프로세스 번호를 `struct pid`로 관리합니다. 이 구조체에는 `level`(몇 단계 깊이의 네임스페이스에 속하는지)과 `numbers[]` 배열이 있고 배열의 각 칸(`struct upid`)은 "어느 네임스페이스에서 몇 번인지"를 담습니다.

```
struct pid (안쪽 bash)
  level = 1
  numbers[0] = { nr = 48211, ns = 초기 PID 네임스페이스 }
  numbers[1] = { nr = 1,     ns = 새 PID 네임스페이스   }
```

`getpid()`는 호출한 프로세스가 속한 네임스페이스 칸의 번호를 돌려줍니다. 그래서 안쪽에서는 1, 바깥에서 `ps`로 보면 48211입니다. 이 매핑은 `/proc/<pid>/status`의 `NSpid` 줄로 직접 볼 수 있습니다. 바깥에서 `grep NSpid /proc/48211/status`를 하면 `NSpid: 48211 1` 형태로 두 번호가 나란히 나옵니다.

### 2-3. 안쪽에서 보이는 범위는 자기 네임스페이스와 그 아래

PID 네임스페이스는 트리입니다. 부모 네임스페이스의 프로세스는 자식 네임스페이스의 프로세스를 볼 수 있고 각자 다른 번호로 부릅니다. 반대 방향은 성립하지 않습니다. 바깥의 sshd 같은 프로세스는 `struct pid`에 자식 네임스페이스 칸이 아예 없어서 안쪽에서 부를 번호가 존재하지 않습니다. 안쪽의 `/proc`에도 디렉터리가 생기지 않습니다.

컨테이너에서 `ps`를 치면 자기 프로세스만 보이고 노드에서 `ps`를 치면 모든 컨테이너의 프로세스가 보이는 이유가 이 비대칭입니다.

### 2-4. PID 1이 죽으면 zap_pid_ns_processes

PID 네임스페이스의 첫 프로세스(init)는 두 가지 특별한 책임을 집니다. 하나는 고아가 된 프로세스를 넘겨받아 좀비를 회수하는 일입니다. 다른 하나는 수명입니다. init이 종료하면 커널의 `kernel/pid_namespace.c`에 있는 `zap_pid_ns_processes()`가 그 네임스페이스에 남은 모든 프로세스에 SIGKILL을 보냅니다.

컨테이너의 메인 프로세스가 끝나면 같은 컨테이너 안에서 백그라운드로 돌던 프로세스까지 함께 사라지는 동작이 여기서 나옵니다. 이 정리는 커널이 네임스페이스 단위로 한 번에 합니다.

### 2-5. PID 1의 시그널 규칙

pid_namespaces(7)는 네임스페이스 init에 대한 시그널 규칙을 따로 둡니다.

| 보내는 쪽 | init이 핸들러를 등록한 시그널 | 핸들러가 없는 시그널 |
|---|---|---|
| 같은 네임스페이스의 프로세스 | 전달됨 | 무시됨(권한이 있어도) |
| 조상 네임스페이스의 프로세스 | 전달됨 | 무시됨. 단 SIGKILL과 SIGSTOP은 강제 전달 |

보통 프로세스는 SIGTERM을 받으면 핸들러가 없어도 기본 동작(종료)이 실행됩니다. 네임스페이스 init은 핸들러를 등록한 시그널만 받습니다. 그래서 SIGTERM 핸들러가 없는 애플리케이션을 컨테이너의 PID 1로 띄우면 이렇게 흘러갑니다.

```
kubectl delete pod → kubelet → CRI StopContainer
  → 런타임이 PID 1에 SIGTERM (호스트 = 조상 네임스페이스에서 보냄)
  → 핸들러가 없으므로 무시
  → terminationGracePeriodSeconds(기본 30초) 동안 대기
  → SIGKILL (조상 네임스페이스에서 보낸 SIGKILL은 강제 전달)
```

파드 삭제가 매번 30초씩 걸리고 애플리케이션은 정리 작업 없이 죽습니다. 셸 스크립트(`sh -c "..."`)로 앱을 감싸 띄울 때 자주 생기는 상황입니다. 대응은 애플리케이션이 SIGTERM 핸들러를 두거나, `exec`로 셸을 앱으로 바꿔 앱이 PID 1이 되게 하거나, tini 같은 작은 init을 PID 1로 두는 방법이 있습니다.

### 2-6. 직접 해 보기

리눅스 VM에서 다음을 해 보고 결과를 적습니다.

1. `sudo unshare --pid --fork --mount-proc bash`로 들어가 `echo $$`와 `ps -ef`를 확인합니다.
2. 다른 터미널에서 `ps -ef | grep "unshare --pid"`로 unshare를 찾고 그 자식 bash의 호스트 PID를 구한 뒤 `grep NSpid /proc/<호스트PID>/status`를 봅니다. 두 숫자가 나오는지 확인합니다.
3. 안쪽에서 `sleep 1000 &`을 띄우고 바깥에서 안쪽 bash(PID 1)에 `sudo kill -KILL <호스트PID>`를 보냅니다. 바깥에서 `pgrep -f "sleep 1000"`이 비어 있는지 확인합니다. `zap_pid_ns_processes()`가 sleep까지 정리했는지 보는 과제입니다.
4. `sudo unshare --pid --fork --mount-proc sleep 1000`으로 핸들러 없는 프로그램을 PID 1로 띄우고 바깥에서 `kill -TERM <호스트PID>`를 보냈을 때 살아 있는지 확인합니다.

kind 노드 안 실측입니다. 1번에서 `echo $$`는 1이었습니다. `--fork`를 빼고 `unshare --pid --mount-proc bash`로 들어가면 첫 명령부터 `bash: fork: Cannot allocate memory`가 났습니다. 첫 자식이 PID 1이 된 뒤 bash가 끝나 네임스페이스에 새 프로세스를 만들 수 없게 된 것입니다. 2번의 `NSpid`는 `10528 1`처럼 두 숫자였습니다. 3번에서 PID 1 bash를 KILL로 죽이자 안쪽 sleep도 함께 사라졌습니다. 4번의 sleep은 TERM을 무시하고 살아 있었고 KILL로만 끝났습니다.

## 3. UTS, mount, network 네임스페이스 재현

### 3-1. UTS: 호스트 이름 분리

<details>
<summary>기초부터: 네 종류를 한 번에 만들어 컨테이너 뼈대 보기</summary>

> **핵심 한 줄**: pid, net, uts, mnt 네임스페이스를 동시에 만들면 cgroup과 이미지 파일시스템만 빠진 컨테이너 뼈대가 됩니다.

#### 1. 프롬프트에 새 이름이 바로 안 보이는 이유
`hostname shop-test` 뒤에도 프롬프트는 예전 이름 그대로입니다. bash는 시작할 때 호스트 이름을 읽어 프롬프트(`\h`)를 만들기 때문입니다. `exec bash`로 셸을 새로 띄우면 바뀐 이름이 프롬프트에 나옵니다. `kubectl exec -it`로 들어간 셸 프롬프트에 파드 이름이 보이는 것도 셸이 시작할 때 그 UTS 네임스페이스의 이름을 읽었기 때문입니다.

#### 2. 네 개를 동시에
```bash
sudo unshare --pid --net --uts --mount --fork bash
mount -t proc proc /proc
hostname shop-web && exec bash
echo $$                                   # 1 (pid 격리)
ip addr                                   # lo 하나만 (net 격리)
ps aux | wc -l                            # 헤더, bash, ps, wc 네 줄
readlink /proc/self/ns/{pid,net,uts,mnt}  # 네 번호 모두 바깥과 다름
exit
```

| 확인 | 기대 모양 | 담당 |
|---|---|---|
| `echo $$` | 1 | pid |
| `ip addr` | `lo`만 있고 DOWN | net |
| 프롬프트 | `shop-web` | uts |
| `/proc` 목록 | 안쪽 프로세스만 | mnt + pid |

#### 3. 아직 빠진 것
- 자원 제한이 없습니다. 안쪽에서 무한 루프를 돌리면 노드 CPU를 다 씁니다. cgroup이 필요합니다(3편).
- 루트 파일시스템이 호스트 것 그대로입니다. 이미지 레이어를 합쳐 루트로 바꾸는 일은 OverlayFS와 `pivot_root`가 합니다(4편).

> **정리**: unshare 한 줄로 격리는 거의 다 재현됩니다. 컨테이너가 되려면 여기에 cgroup과 루트 파일시스템 교체가 더해져야 합니다.

</details>

```bash
sudo unshare --uts bash
hostname shop-test
hostname           # shop-test
# 다른 터미널에서
hostname           # 원래 이름 그대로
```

파드의 컨테이너에서 `hostname`을 치면 파드 이름이 나옵니다. 파드 단위로 UTS 네임스페이스를 하나 만들고 그 안의 호스트 이름을 파드 이름으로 설정하기 때문입니다. 같은 파드의 컨테이너는 이 UTS 네임스페이스를 공유하므로 모두 같은 이름을 봅니다.

### 3-2. mount: tmpfs는 안쪽에서만 보임

```bash
sudo unshare --mount bash
mkdir -p /tmp/ns-demo
mount -t tmpfs tmpfs /tmp/ns-demo
echo hello > /tmp/ns-demo/a.txt
findmnt /tmp/ns-demo     # 안쪽: tmpfs가 보임
# 다른 터미널에서
findmnt /tmp/ns-demo     # 바깥: 출력 없음
ls /tmp/ns-demo          # 빈 디렉터리
```

새 mount 네임스페이스는 만들어지는 순간 부모의 마운트 목록을 복사해 갖고 시작합니다. 그 뒤에 일어나는 마운트와 언마운트는 각자의 목록에만 반영됩니다.

여기에 전파(propagation) 설정이 끼어듭니다. systemd를 쓰는 배포판은 `/`를 shared로 마운트해 두고 shared 마운트 아래에서 생긴 마운트는 같은 peer 그룹의 다른 네임스페이스로 전파됩니다. unshare(1)는 `--propagation` 기본값을 `private`으로 두고 새 네임스페이스의 마운트를 모두 private으로 바꿉니다. 위 실습에서 tmpfs가 바깥으로 새지 않는 데는 이 기본값도 한몫합니다.

### 3-3. network: unshare --net 직후에는 lo 하나

<details>
<summary>기초부터: 빈 네트워크 네임스페이스가 바깥과 이어지는 길</summary>

> **핵심 한 줄**: 새 네트워크 네임스페이스는 배선이 안 된 새 방입니다. CNI 플러그인이 veth 케이블을 꽂고 주소와 경로를 넣어야 바깥과 통합니다.

#### 1. 왜 필요한가
막 만든 네트워크 네임스페이스에는 꺼져 있는 `lo` 하나뿐입니다. 외부로 나갈 장치도 경로도 없으니 `ping 8.8.8.8`은 `Network is unreachable`로 끝납니다. 파드도 처음에는 이 상태라서 누군가 배선을 해 줘야 합니다.

#### 2. 어떻게 동작하나
1. **veth 한 쌍 만들기**: veth(virtual ethernet)는 두 끝이 늘 이어져 있는 가상 케이블입니다.
2. **한쪽 끝을 파드 안으로**: 파드 네임스페이스로 옮기고 보통 `eth0`이라는 이름을 붙입니다.
3. **다른 끝은 호스트에**: 호스트 쪽 끝을 어디에 잇는지는 CNI마다 다릅니다.
4. **주소와 경로 넣기**: IPAM이 준 IP를 `eth0`에 넣고 기본 경로를 잡습니다.

```text
파드 eth0 ── veth ── 호스트 쪽 끝 ── (브리지 또는 호스트 라우팅) ── 노드 NIC ── 바깥
```

#### 3. 호스트 쪽 끝을 잇는 두 방식
| 방식 | 대표 | 호스트 쪽 끝 |
|---|---|---|
| 리눅스 브리지 | `bridge` 플러그인(예: `cni0`) | 브리지에 붙이고 같은 브리지의 파드끼리 L2로 통신 |
| 호스트 라우팅 | Calico | 브리지 없이 `cali*` veth마다 `/32` 경로를 호스트 라우팅 테이블에 넣음 |

#### 4. 헷갈리는 점
- "CNI가 veth를 가상 브리지에 꽂는다"는 설명은 bridge 계열 플러그인에 맞습니다. Calico는 기본 구성에서 브리지를 쓰지 않고 호스트 라우팅으로 패킷을 보냅니다.
- `unshare --net`으로 만든 네임스페이스는 프로세스가 끝나면 사라집니다. 오래 두려면 3-4의 `ip netns add`처럼 bind mount로 고정하고 다 쓰면 `ip netns delete`로 직접 지웁니다.

> **정리**: 네트워크 네임스페이스는 비어 있는 상태로 태어나고 CNI가 veth와 주소, 경로를 채웁니다. 파드 사이의 실제 경로는 5편에서 이어서 봅니다.

</details>

```bash
sudo unshare --net bash
ip link
# 1: lo: <LOOPBACK> mtu 65536 qdisc noop state DOWN mode DEFAULT ...
ping -c1 8.8.8.8
# connect: Network is unreachable 형태
```

새 네트워크 네임스페이스에는 루프백 장치 `lo` 하나만 있고 그마저 DOWN 상태입니다. 라우팅 테이블도 비어 있고 iptables 규칙도 따로입니다. 포트 번호 공간도 네임스페이스마다 따로라서 호스트에서 80번을 쓰고 있어도 안쪽에서 80번을 다시 열 수 있습니다.

이 빈 네트워크 네임스페이스에 장치를 꽂고 주소와 라우팅을 채우는 일이 CNI 플러그인의 몫입니다. 쿠버네티스의 파드 네트워크가 어떻게 구성되는지는 [CKA Ch-04](/blog/cert/cka/cka-04-services-networking)와 이 시리즈 [5편](/blog/theory/systems/k8s-linux-05-service-iptables-conntrack)에서 이어서 봅니다.

### 3-4. ip netns와 veth로 두 네임스페이스 잇기

`ip netns add`는 이름 붙은 네트워크 네임스페이스를 만들고 `/var/run/netns/<이름>`에 bind mount로 고정합니다(ip-netns(8)). 안에 프로세스가 없어도 이 마운트 덕분에 네임스페이스가 유지됩니다. 쇼핑몰 웹 서버용 네임스페이스 하나를 만들어 호스트와 veth로 이어 보는 순서입니다.

```bash
sudo ip netns add shop
sudo ip link add veth-host type veth peer name veth-shop
sudo ip link set veth-shop netns shop

sudo ip addr add 10.200.0.1/24 dev veth-host
sudo ip link set veth-host up

sudo ip netns exec shop ip addr add 10.200.0.2/24 dev veth-shop
sudo ip netns exec shop ip link set veth-shop up
sudo ip netns exec shop ip link set lo up

ping -c1 10.200.0.2
sudo ip netns exec shop ip route    # 10.200.0.0/24 dev veth-shop 한 줄
```

veth는 한쪽에 들어간 패킷이 반대쪽에서 나오는 가상 케이블입니다. CNI 플러그인도 파드마다 이런 veth 한 쌍을 만들어 한쪽 끝을 파드의 네트워크 네임스페이스에 넣습니다.

### 3-5. 직접 해 보기

1. 3-1의 UTS 실습을 한 뒤 안쪽에서 `readlink /proc/$$/ns/uts`, 바깥에서 같은 명령을 실행해 번호가 다른지 봅니다. 같은 셸에서 `readlink /proc/$$/ns/net`은 같은 번호인지 확인합니다. 만든 종류만 바뀐다는 점을 확인하는 과제입니다.
2. 3-2의 mount 실습을 `--propagation shared`를 붙여 다시 해 보고 바깥에서 tmpfs가 보이는지 적습니다.
3. 3-4 뒤에 `ls -l /var/run/netns`, `sudo lsns -t net`을 보고 `shop` 네임스페이스의 inode 번호를 `sudo ip netns exec shop readlink /proc/self/ns/net`과 맞춰 봅니다. 끝나면 `sudo ip netns del shop`으로 지웁니다.

kind 노드 안 실측에서 1번은 uts 번호만 바뀌고 net 번호는 같았습니다. 2번은 `--propagation shared`를 붙이자 안쪽 tmpfs가 바깥에서도 보였습니다. kind 노드의 `/`가 shared 마운트라서입니다. `unshare --net` 직후에는 `lo`만 `DOWN` 상태로 있었고 3-4의 `ip netns`와 veth 연결도 그대로 동작했습니다. `lsns -t net`에는 파드마다 `/run/netns/cni-*`가 보였고 그 네임스페이스를 쥔 프로세스는 USER 65535로 도는 pause였습니다.

## 4. runc가 네임스페이스를 만드는 순서

### 4-1. kubelet에서 runc까지

<details>
<summary>기초부터: kubectl 한 줄과 unshare 한 줄이 커널에서 만나는 곳</summary>

> **핵심 한 줄**: 쿠버네티스의 긴 경로와 unshare 명령 한 줄은 출발점만 다르고 커널 안에서는 같은 함수로 새 네임스페이스를 만듭니다.

#### 1. 두 경로 비교
| 경로 | 거치는 단계 | 커널에 닿는 호출 |
|---|---|---|
| 쿠버네티스 | kubectl → API 서버 → scheduler → kubelet → containerd → shim → runc | runc가 `clone`, `unshare`, `setns` |
| 실습 | `unshare` 명령 하나 | `unshare(2)` 뒤 `--fork`면 `fork` |

#### 2. 커널 안에서 만나는 지점
```text
unshare(2) → unshare_nsproxy_namespaces() → create_new_namespaces()
clone(2)   → copy_process() → copy_namespaces() → (CLONE_NEW* 있으면) create_new_namespaces()
```
1. **copy_process()**: 부모를 본떠 새 `task_struct`를 만듭니다.
2. **copy_namespaces()**: 플래그에 `CLONE_NEW*`가 없으면 부모의 `nsproxy`를 함께 쓰고 있으면 새로 만들 차례로 넘깁니다(`kernel/nsproxy.c`).
3. **create_new_namespaces()**: 종류별 네임스페이스 구조체를 할당해 새 `nsproxy`에 답니다.

#### 3. 헷갈리는 점
- "runc가 `clone()`에 `CLONE_NEWPID|CLONE_NEWNET|...`을 한꺼번에 넘긴다"는 그림이 흔합니다. 4-2에서 보듯 현재 runc는 `clone(CLONE_PARENT)`로 자식을 만들고 그 자식이 `unshare(flags)`로 네임스페이스를 만듭니다. 플래그가 커널에 닿는 경로는 그래서 위 두 줄 가운데 첫 줄입니다.
- 새 PID 네임스페이스의 PID 1은 그 뒤 한 번 더 하는 `clone`에서 생깁니다(4-2 stage-2).

> **정리**: 도구가 무엇이든 마지막은 `create_new_namespaces()`입니다. 리눅스 쪽을 알면 런타임이 바뀌어도 같은 그림으로 읽을 수 있습니다.

</details>

파드 하나가 노드에서 프로세스가 되기까지의 경로는 API 서버를 중심으로 돕니다. scheduler와 kubelet은 etcd를 직접 읽지 않고 둘 다 API 서버를 watch합니다.

```
kubectl apply ──> kube-apiserver ──> etcd (저장)
                     ▲     ▲
            watch    │     │ watch
   kube-scheduler ───┘     └─── kubelet (nodeName이 자기인 파드)
   (nodeName 기록)               │ CRI gRPC
                                 ▼
                             containerd
                                 │ ttrpc
                                 ▼
                        containerd-shim-runc-v2
                                 │ exec
                                 ▼
                               runc ──> clone / unshare / setns
```

kubelet은 자기 노드로 배정된 파드를 watch하다가 CRI로 containerd에 샌드박스와 컨테이너를 요청합니다. 네임스페이스를 만드는 시스템 콜은 이 경로의 끝인 runc에서 나옵니다.

### 4-2. nsexec.c의 세 단계

runc의 네임스페이스 처리는 C 코드(`libcontainer/nsenter/nsexec.c`)에 있습니다. Go 런타임은 시작하자마자 여러 스레드를 띄우는데 `setns`나 `unshare(CLONE_NEWUSER)`는 다중 스레드 프로세스에서 제대로 동작하지 않는 경우가 있습니다. 그래서 Go 런타임이 뜨기 전에 실행되는 C 생성자에서 네임스페이스 작업을 끝냅니다. 코드는 세 단계(stage)로 나뉩니다.

```
stage-0 (STAGE_PARENT, "runc:[0:PARENT]")
  └─ clone(CLONE_PARENT | SIGCHLD)  ─────────────┐
                                                 ▼
stage-1 (STAGE_CHILD, "runc:[1:CHILD]")
  ├─ join_namespaces()    : 지정된 경로가 있는 네임스페이스는 setns()로 합류
  ├─ unshare(CLONE_NEWUSER): user 네임스페이스가 필요하면 먼저 단독으로
  │    (uid_map/gid_map 작성은 stage-0에 부탁)
  ├─ unshare(cloneflags)  : 나머지 새 네임스페이스를 한 번에
  └─ clone(CLONE_PARENT | SIGCHLD) ──────────────┐
                                                 ▼
stage-2 (STAGE_INIT, "runc:[2:INIT]")
  └─ 새 PID 네임스페이스의 PID 1. 이후 Go 쪽에서 rootfs, pivot_root,
     cgroup, seccomp 등을 마치고 사용자 프로세스로 exec
```

소스 주석에 각 선택의 이유가 적혀 있습니다.

- 먼저 `clone`하고 자식에서 `unshare`하는 이유: stage-0이 직접 `unshare(CLONE_NEWUSER)`를 하면 stage-0이 원래 네임스페이스의 capability를 모두 잃어 uid/gid 매핑을 여러 줄로 쓰는 일 같은 준비 작업을 할 수 없습니다. 그래서 자식을 먼저 만들고 자식이 unshare하는 동안 stage-0이 바깥에서 매핑을 써 줍니다.
- 네임스페이스 플래그를 `clone`에 바로 넣지 않는 이유: 주석은 "clone(CLONE_PARENT | CLONE_NEWPID)가 깨져 있던 옛 커널 버전이 있어서 clone과 합치지 않는다"고 적고 그 버그가 있던 마지막 메인라인 커널을 3.12로 봅니다.
- user 네임스페이스를 따로 먼저 만드는 이유: 한 번에 다 unshare하면 일부 네임스페이스 객체의 소유자가 잘못 잡히는 경우가 있다고 적습니다. 예로 user 매핑 전에 UTS를 만들면 mqueue 내부 마운트의 SELinux 레이블이 틀어지는 사례를 듭니다.
- stage-2를 위해 한 번 더 `clone`하는 이유: `unshare(CLONE_NEWPID)`와 `setns`는 호출한 프로세스의 PID 네임스페이스를 바꾸지 않습니다. 바꾸면 자기 `getpid()` 값이 달라져 많은 라이브러리가 깨지기 때문입니다. 그래서 새 PID 네임스페이스에 실제로 들어가려면 fork를 한 번 더 해야 합니다. 2-1절에서 `unshare --fork`가 필요했던 이유와 같습니다.
- `CLONE_PARENT`의 효과: 이 플래그로 만든 프로세스는 호출한 프로세스의 부모를 자기 부모로 갖습니다. 그래서 stage-1과 stage-2는 stage-0을 띄운 runc(Go 쪽 부모 프로세스)의 자식으로 붙습니다. 컨테이너 init(stage-2)의 PID는 stage-0을 거쳐 그 부모에게 전달됩니다.

커널 안의 경로도 이 순서를 따라 둘로 나뉩니다. stage-1의 `unshare`는 `unshare_nsproxy_namespaces()`를 거쳐 `create_new_namespaces()`로 새 `nsproxy`를 만듭니다. stage-2를 띄우는 `clone`은 `copy_process()` → `copy_namespaces()`를 거치는데 이때는 NEW 플래그가 없으니 부모(stage-1)의 `nsproxy`를 참조만 늘려 물려받습니다. PID 네임스페이스만은 stage-1의 `pid_for_children`이 가리키는 새 네임스페이스에서 번호를 받습니다.

### 4-3. 기존 네임스페이스 합류는 setns

OCI 런타임 스펙(`config.json`)의 `linux.namespaces` 항목은 종류마다 `path`를 줄 수 있습니다. `path`가 없으면 새로 만들고 있으면 그 경로의 네임스페이스에 합류합니다.

```json
"namespaces": [
  { "type": "pid" },
  { "type": "ipc",     "path": "/proc/48100/ns/ipc" },
  { "type": "uts",     "path": "/proc/48100/ns/uts" },
  { "type": "mount" },
  { "type": "network", "path": "/proc/48100/ns/net" },
  { "type": "cgroup" }
]
```

위 JSON은 kind(containerd 2.3.4)에서 `crictl inspect`로 본 일반 컨테이너의 `runtimeSpec.linux.namespaces`와 같은 순서와 모양이고 PID 48100은 pause 프로세스 자리에 넣은 값입니다. 일반 컨테이너의 network `path`는 pause의 `/proc/<pid>/ns/net`입니다. `/var/run/netns/cni-...` 경로는 pause 컨테이너 자신의 스펙에 나옵니다. 실측한 pause 스펙은 `[pid, ipc, uts, mount, network(path=/var/run/netns/cni-...)]`로 cgroup 항목이 없었습니다. stage-1의 `join_namespaces()`가 `path`가 있는 항목마다 파일을 열어 `setns(fd, type)`을 호출합니다. `path`가 없는 pid, mount, cgroup은 `cloneflags`에 들어가 `unshare`로 새로 만들어집니다. 파드 안 컨테이너들이 net, ipc, uts를 나눠 쓰고 나머지는 따로 갖는 구조가 이 JSON 한 덩어리로 결정됩니다.

### 4-4. 직접 해 보기

kind 노드 안에서 다음을 확인합니다.

1. 아무 파드나 띄우고 `crictl ps`로 컨테이너 ID를 찾습니다. `crictl inspect <ID>`의 출력에서 `runtimeSpec.linux.namespaces`를 찾아 어느 항목에 `path`가 있는지 적습니다.
2. 같은 출력에서 `info.pid`를 찾고 `ls -l /proc/<pid>/ns`로 inode 번호를 봅니다. `crictl inspectp <파드ID>`의 pid(pause)와 비교해 net, ipc, uts가 같고 pid, mnt가 다른지 확인합니다.
3. `strace -f -e trace=clone,clone3,unshare,setns runc run ...`처럼 runc를 직접 추적할 수 있는 리눅스 VM이 있다면 stage-0, stage-1, stage-2의 호출 순서를 출력에서 찾아봅니다.

1번과 2번의 kind 실측은 4-3에 반영했습니다. 3번은 runc를 직접 실행하지 않고 kind 워커의 containerd에 `strace -f`를 걸어 대신 봤습니다. 앱 컨테이너 쪽에서 `setns`가 IPC, UTS, NET 순으로 세 번 불린 뒤 `unshare(CLONE_NEWNS|CLONE_NEWCGROUP|CLONE_NEWPID)`가 나왔습니다. 자세한 줄은 [1편](/blog/theory/systems/k8s-linux-01-kernel-boundary)의 2장 실측에 적었습니다.

## 5. 파드 단위 공유와 컨테이너 단위 격리

### 5-1. 종류별 공유 범위

<details>
<summary>기초부터: 공유 범위 외우기와 IPC 공유 메모리·세마포어</summary>

> **핵심 한 줄**: 파드는 "같은 머신처럼" 보이게 하는 것(net, ipc, uts)을 나누고 "각자의 프로그램"으로 두는 것(pid, mnt, cgroup)은 따로 둡니다.

#### 1. 3-3-2로 외우기
| 묶음 | 네임스페이스 | 이유 |
|---|---|---|
| 파드가 공유 3 | net, ipc, uts | 같은 IP와 `localhost`, 같은 공유 메모리, 같은 호스트 이름 |
| 컨테이너별 3 | pid, mnt, cgroup | 각자 PID 1, 각자 이미지 루트, 각자 cgroup 루트 |
| 기본은 노드 것 2 | user, time | user는 `hostUsers: false`면 파드별, time은 고를 필드 없음 |

user와 cgroup을 "노드 수준"으로 묶어 2-3-2로 외우는 자료도 있습니다. 위 표 기준으로 cgroup 네임스페이스는 cgroup v2와 containerd 조합에서 컨테이너마다 따로 생기므로(5-3) 컨테이너별 묶음에 넣었습니다.

#### 2. IPC가 왜 파드 단위로 공유되나
- 프로세스는 기본으로 자기 메모리만 봅니다. 소켓이나 파이프로 큰 데이터를 넘기면 보내는 쪽 → 커널 버퍼 → 받는 쪽으로 복사가 두 번 일어납니다.
- **공유 메모리**는 커널이 물리 메모리 한 구역을 두 프로세스의 주소 공간에 함께 매핑해 주는 방식입니다. 한 번 매핑한 뒤에는 커널을 거치는 복사 없이 바로 읽고 씁니다.
- 대신 두 프로세스가 같은 자리에 동시에 쓰면 데이터가 섞입니다(경쟁 상태).

#### 3. 세마포어로 순서 정하기
1. **초기값 1**: 공유 구역을 쓸 수 있다는 뜻입니다.
2. **A가 진입**: 값을 1에서 0으로 내리고(`semop`의 감소) 구역에 씁니다.
3. **B가 진입 시도**: 값이 0이라 감소할 수 없으니 커널이 B를 재웁니다.
4. **A가 나감**: 값을 1로 올리면 커널이 B를 깨우고 B가 값을 0으로 내린 뒤 씁니다.

```text
A: 1→0 (잠금) ─ 쓰기 ─ 0→1 (해제)
B:        대기 ............ 깨어남 1→0 ─ 쓰기
```

#### 4. 헷갈리는 점
- IPC 네임스페이스가 나누는 것은 System V 객체(`shmget`, `semget`, `msgget`)와 POSIX 메시지 큐입니다. `shm_open`으로 만드는 POSIX 공유 메모리는 `/dev/shm` 파일이라 mount 쪽에서 공유됩니다.

> **정리**: net, ipc, uts는 파드가 함께 쓰고 pid, mnt, cgroup은 컨테이너가 따로 씁니다. 같은 파드의 두 컨테이너가 공유 메모리로 통신할 수 있는 근거가 ipc 공유입니다.

</details>

| 네임스페이스 | 기본 범위 | 바꾸는 필드 | 근거 |
|---|---|---|---|
| net | 파드 공유 | `hostNetwork: true`면 노드 것 | 파드 안 컨테이너가 IP와 포트 공간을 공유 |
| ipc | 파드 공유 | `hostIPC: true`면 노드 것 | System V IPC, POSIX 메시지 큐 공유 |
| uts | 파드 공유 | `hostNetwork: true`면 노드 것 | 호스트 이름이 파드 이름. hostNetwork이면 containerd가 스펙에서 net과 uts 항목을 함께 빼서 노드 것을 씀(`sandbox_run_linux.go`) |
| pid | 컨테이너별 | `shareProcessNamespace: true`면 파드 공유, `hostPID: true`면 노드 것 | 컨테이너마다 자기 PID 1 |
| mnt | 컨테이너별 | 바꿀 수 없음 | 이미지마다 루트 파일시스템이 다름 |
| cgroup | 컨테이너별 (cgroup v2, 비privileged) | privileged이거나 cgroup v1이면 노드 것 | containerd `container_create.go` |
| user | 노드 것 (기본) | `hostUsers: false`면 파드별 | 1.36 GA |
| time | 노드 것 | 필드 없음 | Pod API에 항목 없음 |

IPC 쪽에는 덧붙일 내용이 있습니다. IPC 네임스페이스가 격리하는 대상은 System V IPC(`shmget`, `semget`, `msgget`)와 POSIX 메시지 큐입니다. POSIX 공유 메모리(`shm_open`)는 `/dev/shm`의 tmpfs 파일이라서 mount 쪽 문제입니다. containerd는 샌드박스의 `/dev/shm`을 파드 안 컨테이너들에 함께 마운트하므로 이것도 결과적으로 파드 안에서 공유됩니다.

net 공유의 결과로 같은 파드의 두 컨테이너는 `localhost`로 서로 통신할 수 있고 같은 포트를 동시에 열 수 없습니다. 웹 컨테이너가 80번을 쓰고 있으면 사이드카는 80번을 bind하지 못합니다.

### 5-2. shareProcessNamespace

`spec.shareProcessNamespace: true`를 주면 파드의 모든 컨테이너가 하나의 PID 네임스페이스를 씁니다. "Share Process Namespace between Containers in a Pod" 문서가 적은 변화는 이렇습니다.

- pause 프로세스가 PID 1이 되고 각 컨테이너의 메인 프로세스는 PID 1이 아닙니다. PID 1이어야 동작하는 이미지(자기가 init이라고 가정하는 프로그램)는 문제를 일으킬 수 있습니다.
- 다른 컨테이너의 프로세스가 `ps`에 보이고 같은 권한이면 시그널을 보낼 수 있습니다. 설정 리로드용으로 nginx에 SIGHUP을 보내는 사이드카 같은 구성이 가능해집니다.
- `/proc/<pid>/root`로 다른 컨테이너의 파일시스템에 접근할 수 있고 `/proc/<pid>/environ`도 같은 권한이면 읽힙니다. 비밀 값을 환경 변수로 넣은 컨테이너가 있다면 같은 파드의 다른 컨테이너가 읽을 수 있다는 뜻입니다.

### 5-3. cgroup 네임스페이스는 컨테이너별

containerd CRI 플러그인은 cgroup v2 노드에서 privileged가 아닌 컨테이너마다 새 cgroup 네임스페이스를 만듭니다. 소스 주석은 목적을 "컨테이너에서 /sys/fs/cgroup을 숨기기 위해"라고 적습니다. 그래서 컨테이너 안에서 `cat /proc/self/cgroup`을 보면 `0::/`처럼 루트로 나오고 `/sys/fs/cgroup`에는 자기 cgroup만 보입니다. 노드에서 같은 프로세스를 보면 `0::/kubepods.slice/kubepods-burstable.slice/...` 같은 긴 경로가 나옵니다.

cgroup v1 노드이거나 privileged 컨테이너이면 노드의 cgroup 네임스페이스를 그대로 씁니다. 쿠버네티스 1.35부터 kubelet은 cgroup v1 노드에서 기본적으로 시작하지 않으니(`failCgroupV1` 기본 true) 지금 만드는 클러스터라면 컨테이너별 cgroup 네임스페이스가 보통입니다. cgroup 자체의 구조는 [3편](/blog/theory/systems/k8s-linux-03-cgroup-qos)에서 다룹니다.

### 5-4. user 네임스페이스와 hostUsers: false

`hostUsers`를 지정하지 않으면(기본 true) 파드는 노드의 user 네임스페이스를 씁니다. 컨테이너 안의 root(UID 0)는 노드에서도 UID 0입니다. 다른 격리 장치(capability 제한, seccomp, LSM)가 막고 있을 뿐 탈출 취약점이 생기면 노드의 root 권한과 이어집니다.

`spec.hostUsers: false`를 주면 파드마다 새 user 네임스페이스를 만들고 컨테이너 안의 UID 0을 노드의 권한 없는 UID 범위로 매핑합니다. 파드마다 겹치지 않는 범위를 받으므로 한 파드에서 탈출해도 다른 파드의 파일에 접근할 권한이 없습니다. 지원 이력은 1.25 알파, 1.30 베타, 1.33 기본 활성 베타, 1.36(2026년 4월) GA입니다. 노드 커널이 idmap 마운트를 지원해야 하고 런타임 버전 요건이 있으니 "User Namespaces" 문서의 요구 사항을 확인하고 켭니다.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: board-api
spec:
  hostUsers: false
  containers:
  - name: api
    image: nginx:1.27
```

### 5-5. hostPID, hostNetwork, hostIPC와 baseline 정책

세 필드는 파드가 해당 네임스페이스를 새로 만들지 않고 노드의 것을 쓰게 합니다. 위험은 종류마다 다릅니다.

| 필드 | 파드가 얻는 것 | 대표적인 위험 |
|---|---|---|
| `hostPID: true` | 노드의 모든 프로세스가 보임 | 같은 UID 프로세스의 `/proc/<pid>/environ`, 명령줄 인자에 담긴 비밀 값 노출, 권한이 있으면 시그널이나 ptrace |
| `hostNetwork: true` | 노드의 네트워크 장치와 포트 공간 | 노드의 localhost에만 열어 둔 서비스 접근, 노드 포트 점유, 네트워크 정책 우회 |
| `hostIPC: true` | 노드의 System V IPC | 노드의 다른 프로세스가 쓰는 공유 메모리 세그먼트 읽기와 쓰기 |

Pod Security Standards의 baseline 정책은 "Host Namespaces" 항목에서 세 필드를 미설정이나 `false`로만 허용합니다. 정책이 누적식이라 restricted도 같고 이 필드를 허용하는 수준은 privileged뿐입니다. 네임스페이스에 `pod-security.kubernetes.io/enforce: baseline` 레이블을 달면 Pod Security Admission이 이런 파드를 생성 단계에서 거절합니다.

### 5-6. 직접 해 보기

1. kind 클러스터에서 `kubectl label ns default pod-security.kubernetes.io/enforce=baseline`을 걸고 `hostPID: true` 파드를 만들어 거절 메시지를 확인합니다. 메시지에 어느 필드가 걸렸는지 나오는지 봅니다.
2. 아무 파드에 `kubectl exec ... -- cat /proc/self/cgroup`을 실행하고 kind 노드 안에서 그 컨테이너의 호스트 PID로 `cat /proc/<pid>/cgroup`을 실행해 두 값을 비교합니다.
3. 클러스터 버전과 노드 커널이 요건을 만족하면 5-4의 `board-api` 파드를 띄우고 kind 노드 안에서 `cat /proc/<nginx PID>/uid_map`을 봅니다. 컨테이너 안 UID 0이 노드의 어느 UID 범위로 매핑되는지 적습니다.

kind 실측입니다. 1번의 거절 메시지는 `violates PodSecurity "baseline:latest": host namespaces (hostPID=true)`로 걸린 필드까지 나왔습니다. 2번은 컨테이너 안에서 `0::/`, 노드에서 `0::/kubelet.slice/kubelet-kubepods.slice/kubelet-kubepods-besteffort.slice/kubelet-kubepods-besteffort-pod<uid>.slice/cri-containerd-<id>.scope`였습니다. colima VM에서 같은 프로세스를 보면 앞에 `/docker/<노드 컨테이너 id>/`가 더 붙습니다. 3번은 kind에서 실패했습니다. `hostUsers: false` 파드가 `FailedCreatePodSandBox`와 `error mounting "sysfs" to rootfs at "/sys": ... operation not permitted`로 뜨지 못했습니다. 노드가 컨테이너인 kind 구조에서 생기는 제약으로 보이고 일반 VM 노드에서는 확인하지 못했습니다.

## 6. pause 컨테이너와 RunPodSandbox

### 6-1. pause.c가 하는 일

<details>
<summary>기초부터: Pod Sandbox와 pause, 그리고 pause가 죽으면</summary>

> **핵심 한 줄**: Pod Sandbox는 CRI가 "파드 하나의 공유 환경"을 부르는 이름이고 pause 컨테이너는 그 환경을 붙잡아 두는 닻입니다.

#### 1. 왜 필요한가
커널은 파드를 모릅니다. 여러 컨테이너가 같은 IP와 호스트 이름을 쓰려면 그 네임스페이스를 누군가 먼저 만들어 계속 쥐고 있어야 합니다. 앱 컨테이너가 그 역할을 맡으면 앱이 재시작될 때마다 네임스페이스가 흔들립니다. 그래서 아무 일도 하지 않는 작은 프로세스를 따로 둡니다.

#### 2. 어떻게 동작하나
1. **샌드박스 먼저**: 파드를 띄우면 앱보다 pause가 먼저 뜹니다(`RunPodSandbox`, 6-3).
2. **잠들기**: pause는 `pause()`로 시그널이 올 때까지 잠들어 CPU를 거의 쓰지 않습니다. 이름이 여기서 왔습니다.
3. **좀비 거두기**: 자식이 끝나면 커널이 부모에게 SIGCHLD를 보내고 pause의 `sigreap`이 `waitpid`로 거둡니다(6-2의 조건에서만 의미 있음).
4. **합류**: 앱 컨테이너는 pause의 `/proc/<pid>/ns/*`로 `setns`해 같은 네임스페이스에 들어갑니다(4-3).

#### 3. pause가 죽으면
| 대상 | 무엇이 쥐고 있나 | pause가 죽은 뒤 |
|---|---|---|
| ipc, uts | pause 프로세스 | 쥔 프로세스가 사라져 정리될 수 있음 |
| net | containerd가 `/var/run/netns/cni-*`에 bind mount | 마운트 덕분에 바로 사라지지는 않음 |
| 파드 IP | 샌드박스 | kubelet이 샌드박스를 다시 만들면 CNI ADD가 다시 불려 보통 새 IP |

#### 4. 헷갈리는 점
- "pause가 죽으면 커널이 네트워크 네임스페이스를 지워 IP가 사라진다"는 설명은 containerd 경로와 맞지 않습니다. 네트워크 네임스페이스는 bind mount로 고정되어 있고 IP가 바뀌는 계기는 샌드박스 재생성입니다(6-5).
- CNI를 부르는 주체가 런타임이 된 시점을 1.24로 적는 자료가 있습니다. containerd 경로는 처음부터 런타임이 불렀고 1.24에서 사라진 것은 dockershim 경로입니다(6-3).

> **정리**: pause는 파드의 공유 네임스페이스를 유지하는 일만 합니다. IP의 수명은 pause 프로세스보다 샌드박스의 수명을 따라갑니다.

</details>

파드마다 노드에 `registry.k8s.io/pause` 이미지로 뜬 컨테이너가 하나씩 더 있습니다. 소스는 kubernetes 저장소의 `build/pause/linux/pause.c` 한 파일이고 하는 일은 세 가지입니다.

```c
static void sigdown(int signo) {
  psignal(signo, "Shutting down, got signal");
  exit(0);
}

static void sigreap(int signo) {
  while (waitpid(-1, NULL, WNOHANG) > 0)
    ;
}

int main(int argc, char **argv) {
  /* -v 옵션 처리 생략 */
  if (getpid() != 1)
    /* Not an error because pause sees use outside of infra containers. */
    fprintf(stderr, "Warning: pause should be the first process\n");

  /* SIGINT, SIGTERM -> sigdown / SIGCHLD -> sigreap (SA_NOCLDSTOP) */
  ...
  for (;;)
    pause();
  ...
}
```

SIGINT와 SIGTERM에 `sigdown`을 등록한 것은 2-5절의 PID 1 규칙 때문입니다. 핸들러가 있어야 SIGTERM으로 끝낼 수 있습니다. SIGCHLD에 등록한 `sigreap`은 넘어온 고아 프로세스를 거둡니다. 나머지 시간은 `pause()`로 시그널이 올 때까지 잠들어 있습니다.

pause가 하는 실질적인 일은 "살아 있기"입니다. 네임스페이스는 안에 프로세스가 있는 동안 유지되므로 pause가 살아 있으면 파드의 ipc, uts 네임스페이스가 유지되고 다른 컨테이너가 `/proc/<pause PID>/ns/*` 경로로 합류할 수 있습니다. 웹 컨테이너가 죽었다 다시 떠도 파드의 공유 네임스페이스는 pause가 붙잡고 있어서 그대로입니다.

### 6-2. 좀비 회수가 의미 있는 조건

`sigreap`은 pause가 PID 1인 PID 네임스페이스 안에서만 쓸모가 있습니다. 기본 설정에서는 컨테이너마다 PID 네임스페이스가 따로이므로 웹 컨테이너 안에서 생긴 고아는 웹 컨테이너의 PID 1이 넘겨받습니다. pause와는 관계가 없습니다.

`shareProcessNamespace: true`일 때는 pause가 파드 전체의 PID 1이므로 모든 컨테이너의 고아가 pause에게 넘어오고 `sigreap`이 이를 회수합니다. 반대로 기본 설정에서 애플리케이션이 자식 프로세스를 만들고 회수하지 않는 구조라면 그 컨테이너의 PID 1이 좀비를 떠안습니다. 이때는 tini 같은 init을 컨테이너 안에 두는 방법을 씁니다.

### 6-3. RunPodSandbox에서 CNI까지

CRI(`cri-api`의 `api.proto`)는 파드를 "샌드박스"로, 그 안의 컨테이너를 "컨테이너"로 나눠 다룹니다. kubelet이 파드 하나를 띄울 때 부르는 순서는 대략 이렇습니다.

```
kubelet
  1. RunPodSandbox(PodSandboxConfig)        → 샌드박스 ID
  2. (각 컨테이너마다) PullImage
  3. CreateContainer(샌드박스 ID, ContainerConfig)
  4. StartContainer(컨테이너 ID)
삭제할 때
  StopContainer → RemoveContainer → StopPodSandbox → RemovePodSandbox
```

`RunPodSandbox`를 받은 containerd는 main 브랜치의 `internal/cri/server/sandbox_run.go` 기준으로 이런 일을 합니다.

1. 네트워크 네임스페이스를 새로 만들고 `/var/run/netns/cni-<id>`에 bind mount로 고정합니다(`netns.NewNetNS`). 3-4절의 `ip netns add`와 같은 방식입니다.
2. 그 경로를 넘겨 CNI 플러그인을 호출합니다(`setupPodNetwork`, CNI ADD). 플러그인이 veth를 만들고 IP를 받아 넣습니다.
3. pause 컨테이너를 그 네트워크 네임스페이스에 넣어 띄웁니다. ipc, uts(그리고 PID를 공유하는 설정이면 pid)는 pause 컨테이너를 만들 때 runc가 새로 만듭니다.

이 경로에서 CNI를 호출하는 주체는 처음부터 런타임이었습니다. kubelet이 CNI 바이너리를 직접 호출한 것은 Docker를 쓰던 dockershim 경로에서뿐이었습니다. dockershim이 1.24에서 제거되면서 kubelet의 `--network-plugin`, `--cni-bin-dir` 플래그도 함께 사라졌고 이제는 어떤 구성이든 CNI 호출이 런타임(containerd, CRI-O)의 일입니다.

### 6-4. containerd-shim이 컨테이너의 부모

노드에서 `ps -ef --forest`를 보면 컨테이너 프로세스의 부모로 `containerd-shim-runc-v2`가 보입니다. runc는 컨테이너를 만든 뒤 종료하는 짧은 명령이고 shim이 subreaper로 등록되어 컨테이너 프로세스를 자식으로 넘겨받습니다. containerd의 `core/runtime/v2/README.md`가 설명하는 구조입니다.

```
systemd(1)
 ├─ containerd
 └─ containerd-shim-runc-v2 -namespace k8s.io -id <샌드박스 ID> ...
     ├─ /pause
     ├─ nginx: master process ...
     │   └─ nginx: worker process
     └─ sh -c while true; do ...; done
```

containerd CRI가 같은 파드의 컨테이너를 샌드박스의 shim 하나에 묶는 형태로 그렸습니다. 이 구조 덕분에 containerd 데몬을 재시작하거나 업그레이드해도 컨테이너는 계속 돕니다. 컨테이너의 부모와 표준 입출력, 종료 코드 수집을 shim이 맡고 있기 때문입니다. 다시 뜬 containerd는 shim의 ttrpc 소켓에 다시 연결해 상태를 이어받습니다.

### 6-5. 파드 IP가 유지되는 범위

파드 IP는 샌드박스의 네트워크 네임스페이스에 붙어 있습니다. 그래서 IP가 바뀌는지는 샌드박스가 새로 만들어지는지로 정해집니다.

| 상황 | 샌드박스 | IP |
|---|---|---|
| 컨테이너가 죽고 `restartPolicy`로 재시작 | 그대로 | 유지 |
| liveness probe 실패로 컨테이너 재시작 | 그대로 | 유지 |
| 파드 삭제 후 컨트롤러가 새 파드 생성(롤아웃 포함) | 새로 생성 | 보통 새 IP |
| 노드 재부팅, pause 컨테이너 사망으로 샌드박스 재생성 | 새로 생성 | 보통 새 IP |

"보통"이라고 적은 이유는 샌드박스가 새로 생기면 CNI ADD가 다시 호출되는데 IPAM이 같은 주소를 다시 줄 수도 있기 때문입니다. Calico처럼 어노테이션으로 IP를 고정하는 기능을 제공하는 CNI도 있습니다. 쿠버네티스가 보장하는 것은 "파드 IP는 그 파드가 사는 동안 유효하다"까지입니다. 파드 IP를 설정 파일에 박아 두지 않고 Service나 DNS 이름을 쓰는 이유입니다.

### 6-6. 직접 해 보기: 쇼핑몰 웹과 로그 수집 사이드카

<details>
<summary>기초부터: 다른 파드와는 무엇이 막히고 무엇이 통하나</summary>

> **핵심 한 줄**: 다른 파드의 프로세스는 볼 수 없지만 네트워크로는 통합니다. pid는 격리되고 net은 격리된 뒤 CNI가 경로로 이어 주기 때문입니다.

#### 1. 같은 노드의 두 파드 비교
아래 과제의 `shop` 파드 옆에 게시판 DB 파드(예: `board-db`, mysql 이미지, 3306 포트)를 같은 노드에 하나 더 띄웠다고 가정합니다.

| 확인 | 명령 | 기대 모양 | 이유 |
|---|---|---|---|
| 프로세스 | `kubectl exec shop -c log-agent -- ps` | mysql이 보이지 않음 | pid 네임스페이스가 파드마다, 컨테이너마다 따로 |
| IP | `kubectl get pod -o wide` | 두 파드 IP가 다름 | net 네임스페이스가 파드마다 따로 |
| L3 | `kubectl exec shop -c log-agent -- ping -c 3 <board-db IP>` | 응답 수신 | CNI가 노드 안 경로를 잡아 둠 |
| L4 | `kubectl exec shop -c log-agent -- nc -z -v -w 3 <board-db IP> 3306` | 연결 성공 | TCP 포트까지 열림 |

#### 2. nc 옵션
| 옵션 | 뜻 |
|---|---|
| `-z` | 연결만 맺고 데이터는 보내지 않음(포트 확인용) |
| `-v` | 결과를 자세히 출력 |
| `-w 3` | 3초 안에 연결이 안 되면 포기 |

busybox의 `nc`는 빌드 설정에 따라 `-z`가 없을 수 있습니다. 그때는 `nc -w 3 <IP> 3306 </dev/null`처럼 바로 끊는 방식으로 확인합니다.

#### 3. 헷갈리는 점
- "보이지 않는다"와 "통신할 수 없다"는 다른 축입니다. pid 격리는 프로세스 목록을 가리고 net 격리는 장치와 포트 공간을 나눕니다. 파드 사이 통신을 막으려면 NetworkPolicy가 따로 필요합니다.
- ping이 막혀도 TCP는 될 수 있습니다. 일부 CNI나 정책은 ICMP를 따로 다루므로 L4 확인을 함께 합니다.

> **정리**: 같은 파드 안은 net을 공유해 `localhost`로, 다른 파드는 각자의 net 사이를 CNI 경로로 잇습니다. 아래 과제는 같은 파드 안쪽을 확인합니다.

</details>

같은 파드의 두 컨테이너가 무엇을 공유하고 무엇을 따로 갖는지 한 번에 확인하는 과제입니다. 쇼핑몰 웹 서버(nginx)와 그 웹 서버를 주기적으로 호출해 로그를 남기는 사이드카를 둡니다. 네이티브 사이드카(`initContainers`의 `restartPolicy: Always`)로 써도 되지만 여기서는 네임스페이스만 볼 것이라 일반 컨테이너 두 개로 둡니다. 네이티브 사이드카는 [CKA Ch-03](/blog/cert/cka/cka-03-workloads-scheduling)에 정리했습니다.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: shop
spec:
  containers:
  - name: shop-web
    image: nginx:1.27
    ports:
    - containerPort: 80
  - name: log-agent
    image: busybox:1.36
    command: ["sh", "-c", "while true; do wget -qO- http://localhost:80 >/dev/null && echo ok; sleep 5; done"]
```

확인할 것을 순서대로 적습니다.

```bash
# 1. localhost 통신: 사이드카 로그에 ok가 쌓이는지
kubectl logs shop -c log-agent --tail=3

# 2. 호스트 이름: 둘 다 shop인지 (UTS 공유)
kubectl exec shop -c shop-web  -- hostname
kubectl exec shop -c log-agent -- hostname

# 3. 각자의 PID 1: 서로 다른 명령줄이 나오는지 (PID 분리)
kubectl exec shop -c shop-web  -- cat /proc/1/cmdline | tr '\0' ' '; echo
kubectl exec shop -c log-agent -- cat /proc/1/cmdline | tr '\0' ' '; echo

# 4. 네임스페이스 번호: net, ipc, uts는 같고 pid, mnt, cgroup은 다른지
kubectl exec shop -c shop-web  -- ls -l /proc/1/ns
kubectl exec shop -c log-agent -- ls -l /proc/1/ns

# 5. 포트 공간 공유: 사이드카에서 80번을 다시 열면 실패하는지
kubectl exec shop -c log-agent -- nc -l -p 80
```

3번에서 웹 컨테이너는 nginx master 프로세스의 명령줄이, 사이드카는 `sh -c while true; ...`가 나오는 형태를 기대합니다. 5번은 웹 컨테이너가 이미 80번을 쓰고 있으니 `Address already in use` 계열 오류가 기대값입니다.

그다음 `spec.shareProcessNamespace: true`를 추가해 파드를 다시 만들고 같은 명령을 반복합니다. 이번에는 3번에서 두 컨테이너 모두 `/pause`가 나오고 `kubectl exec shop -c log-agent -- ps`에 nginx 프로세스가 보여야 합니다. 4번의 pid 번호도 두 컨테이너가 같아집니다. 파드를 다시 만들었으니 `kubectl get pod shop -o wide`의 IP가 이전과 같은지도 함께 적어 둡니다. 6-5절의 표대로라면 보통은 달라집니다.

마지막으로 kind 노드 안에서 `crictl pods --name shop`으로 샌드박스 ID를 찾고 `crictl inspectp <ID>`의 네트워크 네임스페이스 경로(`/var/run/netns/cni-...`)가 6-3절의 설명과 맞는지, `ps -ef --forest`에서 두 컨테이너와 pause의 부모가 shim인지 확인합니다.

kind v1.37.0 실측 결과는 모두 기대값과 같았습니다. 사이드카 로그에 `ok`가 쌓였고 두 컨테이너의 `hostname`은 `shop`이었습니다. PID 1 명령줄은 nginx master와 `sh -c while true; ...`로 달랐습니다. 네임스페이스 번호는 ipc, net, uts가 같고 pid, mnt, cgroup이 달랐으며 time은 kind 노드의 것이었습니다. 5번은 `nc: bind: Address already in use`였습니다. `shareProcessNamespace: true`로 다시 만들자 두 컨테이너의 PID 1이 모두 `/pause`였고 `ps`에 nginx가 보였으며 pid 번호도 같아졌습니다. 파드 IP는 다시 만들 때 `.39`에서 `.40`으로 바뀌었고 컨테이너만 재시작했을 때는 그대로였습니다.

## 확인 문제

**문제 1.** `sudo unshare --pid bash`(`--fork` 없음)로 들어간 뒤 `echo $$`를 하면 1이 나오지 않습니다. 이유는 무엇인가요?

<details><summary>정답</summary>

`unshare(CLONE_NEWPID)`는 호출한 프로세스 자신을 옮기지 않고 이후에 만드는 자식만 새 PID 네임스페이스에 넣습니다. bash는 원래 네임스페이스에 남아 있으므로 자기 번호가 그대로입니다. bash가 처음 만드는 자식이 새 네임스페이스의 PID 1이 됩니다. 그 자식이 끝나면 PID 1 없는 네임스페이스가 되어 이후 fork가 `ENOMEM`으로 실패합니다.

</details>

**문제 2.** 컨테이너의 PID 1로 SIGTERM 핸들러가 없는 프로그램이 돌고 있습니다. `kubectl delete pod`를 하면 기본 설정에서 어떤 일이 일어나나요?

<details><summary>정답</summary>

런타임이 보낸 SIGTERM은 핸들러가 없어서 무시됩니다(네임스페이스 init은 핸들러를 등록한 시그널만 받음). terminationGracePeriodSeconds 기본 30초가 지난 뒤 SIGKILL이 갑니다. 조상 네임스페이스에서 보낸 SIGKILL은 강제로 전달되므로 프로세스가 죽습니다. 그 순간 `zap_pid_ns_processes()`가 같은 PID 네임스페이스의 나머지 프로세스도 SIGKILL로 정리합니다.

</details>

**문제 3.** runc의 nsexec.c가 새 PID 네임스페이스를 만든 뒤 `clone`을 한 번 더 하는 이유는 무엇인가요?

<details><summary>정답</summary>

`unshare(CLONE_NEWPID)`와 `setns`는 호출한 프로세스의 PID 네임스페이스를 바꾸지 않습니다. 바꾸면 그 프로세스의 `getpid()` 값이 달라져 라이브러리가 깨지기 때문입니다. 그래서 stage-1이 unshare한 뒤 stage-2를 clone해야 stage-2가 새 PID 네임스페이스의 PID 1로 들어갑니다.

</details>

**문제 4.** 기본 설정의 파드에서 두 컨테이너가 공유하는 네임스페이스와 따로 갖는 네임스페이스를 나누세요(cgroup v2 노드, containerd, privileged 아님, `hostUsers` 미설정).

<details><summary>정답</summary>

공유: net, ipc, uts. 컨테이너별: pid, mnt, cgroup. 노드 것을 그대로 씀: user(`hostUsers` 기본 true), time. `shareProcessNamespace: true`이면 pid가 공유 쪽으로 옮겨 가고 `hostUsers: false`이면 user가 파드별로 새로 생깁니다.

</details>

**문제 5.** 기본 설정(`shareProcessNamespace` 미설정)에서 pause의 `sigreap`은 어떤 프로세스를 회수하나요?

<details><summary>정답</summary>

사실상 회수할 대상이 없습니다. PID 네임스페이스가 컨테이너마다 따로라서 각 컨테이너의 고아는 그 컨테이너의 PID 1이 넘겨받습니다. pause의 좀비 회수는 PID 네임스페이스를 공유해 pause가 파드 전체의 PID 1일 때 의미가 있습니다. 기본 설정에서 pause의 역할은 살아 있으면서 파드의 공유 네임스페이스를 유지하는 것입니다.

</details>

**문제 6.** containerd를 쓰는 1.37 클러스터에서 파드의 CNI ADD를 호출하는 주체는 누구이고 컨테이너가 liveness 실패로 재시작되면 파드 IP는 어떻게 되나요?

<details><summary>정답</summary>

containerd가 `RunPodSandbox` 처리 중에 네트워크 네임스페이스를 만들고 CNI를 호출합니다. containerd 경로는 1.24 이전에도 런타임이 호출했고 kubelet이 CNI를 직접 다룬 것은 dockershim 경로뿐이었습니다. 컨테이너 재시작은 같은 샌드박스 안에서 일어나므로 IP가 유지됩니다.

</details>

## 범위와 한계

- 2026-10-20에 kind v0.33 + 노드 v1.37.0(colima, arm64, VM 커널 6.8.0-117-generic, Ubuntu 24.04.4, containerd 2.3.4, runc 1.4.3)에서 1-5, 2-6, 3-5, 4-4(1, 2번과 containerd strace), 5-6(1, 2번), 6-6을 돌렸습니다. unshare 실습은 kind 노드 컨테이너 안에서 했으므로 "호스트"는 kind 노드를 뜻합니다.
- 돌리지 못한 것: 5-6의 3번(`hostUsers: false`)은 kind에서 sysfs 마운트 오류로 실패해 uid_map을 보지 못했습니다. 6.17 이상 커널의 고정 net, mnt 번호는 VM이 6.8이라 확인하지 못했습니다. runc를 직접 실행한 stage별 추적은 하지 않았습니다.
- 6-4절의 프로세스 트리는 구조를 보이려고 만든 예시입니다. shim 그룹 방식은 containerd 버전과 설정에 따라 다를 수 있습니다. 4-3절의 JSON은 kind 실측 순서로 고쳤습니다.
- 초기 net, mnt 네임스페이스의 고정 inode 번호는 6.17 커널부터라서 6.16 이하에서는 다른 값이 나옵니다.
- containerd의 샌드박스 생성 순서(네트워크 네임스페이스 생성 → CNI 호출 → pause 시작)와 컨테이너별 cgroup 네임스페이스는 2026년 10월 containerd main 브랜치 소스를 읽고 정리했습니다. containerd 1.x 릴리스에서는 순서가 다를 수 있고 CRI-O의 동작은 확인하지 않았습니다.
- user 네임스페이스는 1.36 GA 기준으로 적었습니다. 노드 커널과 런타임 버전 요건은 버전마다 바뀌므로 "User Namespaces" 문서를 다시 확인해야 합니다.
- nsexec.c의 단계 설명은 2026년 10월 runc main 브랜치 기준입니다. runc 릴리스마다 세부 구현(특히 user 네임스페이스와 time 네임스페이스 처리)이 바뀔 수 있습니다.
- 확인 문제는 제가 만든 것입니다.

## 참고 자료

커널과 man 페이지
- man7.org, [namespaces(7)](https://man7.org/linux/man-pages/man7/namespaces.7.html), [pid_namespaces(7)](https://man7.org/linux/man-pages/man7/pid_namespaces.7.html), [mount_namespaces(7)](https://man7.org/linux/man-pages/man7/mount_namespaces.7.html), [ipc_namespaces(7)](https://man7.org/linux/man-pages/man7/ipc_namespaces.7.html), [cgroup_namespaces(7)](https://man7.org/linux/man-pages/man7/cgroup_namespaces.7.html), [time_namespaces(7)](https://man7.org/linux/man-pages/man7/time_namespaces.7.html), [user_namespaces(7)](https://man7.org/linux/man-pages/man7/user_namespaces.7.html)
- man7.org, [clone(2)](https://man7.org/linux/man-pages/man2/clone.2.html), [unshare(2)](https://man7.org/linux/man-pages/man2/unshare.2.html), [setns(2)](https://man7.org/linux/man-pages/man2/setns.2.html), [unshare(1)](https://man7.org/linux/man-pages/man1/unshare.1.html), [ip-netns(8)](https://man7.org/linux/man-pages/man8/ip-netns.8.html)
- torvalds/linux, [include/uapi/linux/nsfs.h](https://github.com/torvalds/linux/blob/master/include/uapi/linux/nsfs.h), [include/linux/proc_ns.h (v6.16)](https://github.com/torvalds/linux/blob/v6.16/include/linux/proc_ns.h), [kernel/nsproxy.c](https://github.com/torvalds/linux/blob/master/kernel/nsproxy.c), [kernel/pid_namespace.c](https://github.com/torvalds/linux/blob/master/kernel/pid_namespace.c), [kernel/fork.c](https://github.com/torvalds/linux/blob/master/kernel/fork.c)

런타임
- opencontainers/runc, [libcontainer/nsenter/nsexec.c](https://github.com/opencontainers/runc/blob/main/libcontainer/nsenter/nsexec.c)
- opencontainers/runtime-spec, [Linux Container Configuration](https://github.com/opencontainers/runtime-spec/blob/main/config-linux.md)
- containerd/containerd, [internal/cri/server/sandbox_run.go](https://github.com/containerd/containerd/blob/main/internal/cri/server/sandbox_run.go), [internal/cri/server/podsandbox/sandbox_run_linux.go](https://github.com/containerd/containerd/blob/main/internal/cri/server/podsandbox/sandbox_run_linux.go), [internal/cri/server/container_create.go](https://github.com/containerd/containerd/blob/main/internal/cri/server/container_create.go), [core/runtime/v2/README.md](https://github.com/containerd/containerd/blob/main/core/runtime/v2/README.md)

쿠버네티스
- kubernetes/kubernetes, [build/pause/linux/pause.c](https://github.com/kubernetes/kubernetes/blob/master/build/pause/linux/pause.c)
- kubernetes/cri-api, [pkg/apis/runtime/v1/api.proto](https://github.com/kubernetes/cri-api/blob/master/pkg/apis/runtime/v1/api.proto)
- Kubernetes, [Share Process Namespace between Containers in a Pod](https://kubernetes.io/docs/tasks/configure-pod-container/share-process-namespace/), [User Namespaces](https://kubernetes.io/docs/concepts/workloads/pods/user-namespaces/), [Kubernetes v1.36: User Namespaces GA](https://kubernetes.io/blog/2026/04/23/kubernetes-v1-36-userns-ga/)
- Kubernetes, [Pod Security Standards](https://kubernetes.io/docs/concepts/security/pod-security-standards/), [Pod Lifecycle](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/), [Network Plugins](https://kubernetes.io/docs/concepts/extend-kubernetes/compute-storage-net/network-plugins/), [About cgroup v2](https://kubernetes.io/docs/concepts/architecture/cgroups/), [Dockershim Removal FAQ](https://kubernetes.io/blog/2022/02/17/dockershim-faq/)

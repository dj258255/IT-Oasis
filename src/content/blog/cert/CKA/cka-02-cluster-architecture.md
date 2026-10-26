---
title: '[CKA] 클러스터 아키텍처, 설치, 구성: kubeadm 한 벌로 만들고 올리고 되살리기'
description: CKA 비중 25%인 클러스터 아키텍처 영역을 시험에서 쓰는 명령과 함정 위주로 정리합니다. RBAC과 CSR, 노드와 런타임 준비, kubeadm 생성과 업그레이드, 인증서 갱신, etcd 백업과 복구(etcdutl), HA, Helm과 Kustomize, CNI·CSI·CRI, CRD와 오퍼레이터를 다룹니다.
date: 2026-10-19T00:00:00.000Z
tags:
  - CKA
  - Kubernetes
  - kubeadm
  - RBAC
  - etcd
  - Helm
  - Kustomize
category: cert/CKA
topics:
  - cert
draft: false
series: "CKA 공부"
seriesOrder: 5
---

## 결론부터

1. 이 영역은 kubeadm 클러스터 한 벌의 일생입니다. 노드를 준비해 `kubeadm init`과 `join`으로 만들고 한 마이너씩 올리고 etcd 스냅샷으로 되살립니다.
2. RBAC은 Role, ClusterRole과 두 바인딩으로 끝나고 `kubectl auth can-i --as`로 검증합니다. 사람 사용자는 CSR 객체로 인증서를 받아 kubeconfig에 넣습니다.
3. 업그레이드는 마이너 버전을 건너뛸 수 없습니다. 첫 컨트롤 플레인은 `kubeadm upgrade apply`, 나머지 노드는 `kubeadm upgrade node`이고 노드마다 drain, kubelet 교체, uncordon을 반복합니다.
4. etcd 백업과 복구는 개정에서 명시 문구가 빠졌지만 수명주기 관리에 걸려 절차를 외워 둡니다. etcd 3.6부터 확인과 복구는 `etcdutl`이고 복구 뒤에는 컨트롤 플레인 static Pod를 다시 띄웁니다.
5. Helm, Kustomize, CRD는 명령 수가 적어 문서 위치와 함정 몇 개(`helm template`은 기본으로 CRD를 뺌 등)만 익히면 빨리 풉니다.

시험 구조와 영역 비중은 [1편](/blog/cert/cka/cka-00-exam-and-study-plan)에, 컨트롤 플레인 구성요소가 각각 무엇을 하는지는 [3편](/blog/cert/cka/cka-01-why-kubernetes)에 정리했습니다.

---

## 1. RBAC: 권한 묶음 둘과 바인딩 둘

<details>
<summary>기초부터: 클러스터 보안을 층으로 나눠 보기</summary>

> **핵심 한 줄**: 클러스터 보안은 겹겹의 성벽처럼 층으로 쌓습니다. 실제로도 한 층이 뚫리면 다음 층이 막도록 장치를 겹쳐 두고 RBAC은 그중 한 층의 한 단계입니다.

#### 1. 왜 필요한가
RBAC만 잘 걸면 클러스터가 안전할 것 같지만 공격 경로는 여러 층에 있습니다. 바깥에서 안쪽으로 들어가며 층마다 무엇을 막는지 보면 이 시리즈의 보안 주제들이 한 그림에 들어옵니다.

#### 2. 어떻게 동작하나
1. **노드(호스트) 접근**: 컨트롤 플레인 노드에 root로 들어가면 `/etc/kubernetes/pki/ca.key`와 etcd 데이터가 그대로 보입니다. 여기가 뚫리면 위의 모든 장치가 의미를 잃습니다.
2. **API 서버 접근**: 모든 조작이 API 서버를 지나므로 여기서 세 번 묻습니다. 인증으로 누구인지, 인가로 그 동작을 해도 되는지, 어드미션으로 요청 내용이 정책에 맞는지 확인합니다([4편 1-2절](/blog/cert/cka/cka-01b-core-objects-and-flow)).
3. **구성요소 사이 통신**: API 서버, etcd, kubelet, 스케줄러가 서로 TLS 인증서로 신원을 확인하고 암호화해서 말합니다([4편 3장](/blog/cert/cka/cka-01b-core-objects-and-flow)).
4. **Pod 사이 네트워크**: 기본 상태에서는 모든 Pod가 모든 Pod에 닿습니다. NetworkPolicy로 허용한 경로만 엽니다([7편](/blog/cert/cka/cka-04-services-networking)).

```text
공격자
  → [1 노드]        SSH 키 인증만, root 직접 로그인 금지
  → [2 API 서버]    인증(누구?) → 인가(해도 되나?) → 어드미션(내용이 정책에 맞나?)
  → [3 구성요소]    서로 TLS로 신원 확인, 암호화
  → [4 Pod 네트워크] NetworkPolicy로 허용한 경로만
  → 지키려는 것: ca.key, etcd 데이터, 결제 DB
```

#### 3. 한눈에 비교
| 층 | 뚫리면 생기는 일 | 막는 장치 | 다루는 곳 |
|---|---|---|---|
| 노드 | CA 키와 etcd 데이터 노출 | 비밀번호 로그인과 root 직접 로그인 끄기, SSH 키 인증만 허용 | 일반 리눅스 운영, CKS |
| API 서버 | 남의 이름이나 넘치는 권한으로 조작 | 인증, 인가(RBAC), 어드미션 | 이 장의 RBAC, CSR, ServiceAccount |
| 구성요소 통신 | 평문이면 같은 네트워크에서 토큰과 Secret을 엿봄 | TLS 인증서 | 4편 3장 |
| Pod 네트워크 | 상품 웹 Pod 하나가 털리면 그 Pod에서 결제 DB로 바로 접속 시도 | NetworkPolicy | 7편 |

#### 4. 헷갈리는 점
- RBAC은 2번 층 안에서도 인가 단계 하나만 맡습니다. 1번 층이 뚫려 `ca.key`가 새면 공격자가 인증서를 직접 서명해 만들 수 있어 RBAC으로는 막지 못합니다.
- 원칙은 층마다 같습니다. 필요한 최소 권한만 주고(**최소 권한 원칙**) 한 층이 뚫려도 다음 층에서 막히게 겹쳐 둡니다.

#### 5. 노드 층의 SSH 키 인증은 이렇게 돕니다
1. **키 쌍 만들기**: 접속하는 쪽 PC에서 `ssh-keygen`으로 개인 키와 공개 키를 만듭니다.
2. **공개 키 등록**: 서버의 `~/.ssh/authorized_keys`에 공개 키만 넣습니다. 개인 키는 PC를 떠나지 않습니다.
3. **접속**: 서버가 낸 문제에 PC가 개인 키로 서명해 답하고 서버는 등록된 공개 키로 그 서명을 확인합니다.

```text
내 PC: 개인 키(보관)  ──서명──>  서버: authorized_keys의 공개 키로 확인
같은 공개 키를 노드 세 대에 등록 → 개인 키 하나로 세 대 모두 접속
```

- 키 인증에는 네트워크로 오가는 비밀번호가 없어서 비밀번호를 하나씩 넣어 보는 무차별 대입(brute force) 공격이 통하지 않습니다. 다만 비밀번호 로그인이 켜져 있으면 그 경로로는 여전히 시도할 수 있습니다.
- 그래서 키 인증을 켠 뒤 `sshd_config`에서 `PasswordAuthentication no`, `PermitRootLogin no`로 비밀번호 로그인과 root 직접 로그인을 끕니다.

> **정리**: RBAC은 네 층 가운데 2번 층의 인가 단계만 맡습니다. 노드 층이 뚫려 `ca.key`가 새면 RBAC으로는 못 막으니 노드 접근은 SSH 키 인증으로 따로 좁혀 둡니다. 이 장은 2번 층을 다루고 아래에서 RBAC부터 봅니다.

</details>

커리큘럼 문구는 "Manage role based access control (RBAC)"입니다. 사용자 인증서 발급(CSR)과 ServiceAccount 토큰도 이 항목에 묶어 둡니다.

### 1-1. 객체 네 개의 관계

<details>
<summary>기초부터: Role과 RoleBinding YAML을 읽는 법</summary>

> **핵심 한 줄**: RBAC은 권한 묶음(Role)을 먼저 만들고 사람이나 ServiceAccount를 그 묶음에 연결(Binding)하는 방식입니다.

#### 1. 왜 필요한가
| 구분 | ABAC(예전) | RBAC(지금) |
|---|---|---|
| 권한을 붙이는 곳 | 사용자별 정책 파일 | Role에 모아 두고 바인딩으로 연결 |
| 개발자 스무 명의 권한 변경 | 정책 파일 고치고 API 서버 재시작 | Role 하나만 고치면 바인딩된 모두에게 바로 반영 |
| API 서버 재시작 | 필요 | 필요 없음 |

ABAC가 밀려난 이유가 이 차이입니다.

#### 2. 어떻게 읽나
1. **Role**: 규칙(`rules`)의 목록이고 규칙 하나는 "어느 API 그룹의 어느 리소스에 어떤 동사를"로 읽습니다.
2. **RoleBinding**: "누구에게(subjects) 어떤 Role을(roleRef)"입니다.

```text
jane(subjects) ──RoleBinding──> order-developer(Role) ──rules──> shop 네임스페이스의 pods, deployments, configmaps
```

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: order-developer
  namespace: shop
rules:
- apiGroups: [""]                 # core 그룹(pods, configmaps, secrets...)
  resources: ["pods"]
  verbs: ["get", "list", "watch", "create", "delete"]
- apiGroups: ["apps"]
  resources: ["deployments"]
  verbs: ["get", "list"]
- apiGroups: [""]
  resources: ["configmaps"]
  resourceNames: ["order-config"]  # 이 이름 하나만
  verbs: ["get", "update"]
```

| 필드 | 읽는 법 |
|---|---|
| `apiGroups` | Pod처럼 그룹이 없는 core 리소스는 빈 문자열 `""`. Deployment는 `apps`라서 그룹을 틀리면 규칙이 아예 맞지 않음 |
| `verbs` | 위 규칙에는 `update`, `patch`가 없으니 Pod를 만들고 지울 수는 있어도 고칠 수는 없음 |
| `resourceNames` | 특정 이름의 객체로 좁힘. `create`는 요청 시점에 이름을 알 수 없어 이름으로 제한되지 않고 `list`도 전체 목록 조회라 함께 쓰기 어려움. 이름 제한은 `get`, `update`, `delete`에 씀 |

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: jane-order-developer
  namespace: shop                 # Role과 같은 네임스페이스
subjects:
- kind: User
  name: jane                      # 인증을 통과한 사용자 이름(인증서 CN)
  apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: Role
  name: order-developer
  apiGroup: rbac.authorization.k8s.io
```

담당자가 바뀌면 Role은 그대로 두고 `subjects`만 바꿉니다.

#### 3. 한눈에 비교: Role과 ClusterRole
| 묶는 방법 | 효력 범위 | 쓰는 경우 |
|---|---|---|
| Role + RoleBinding | 그 네임스페이스 | 팀 하나에 권한 |
| ClusterRole + ClusterRoleBinding | 모든 네임스페이스 | 클러스터 전체를 돌며 Pod를 수집하는 모니터링 에이전트 |
| ClusterRole + 네임스페이스마다 RoleBinding | RoleBinding이 있는 네임스페이스만 | 팀마다 같은 권한을 재사용 |

노드, PV, 네임스페이스처럼 네임스페이스 밖에 있는 리소스의 권한은 ClusterRole로만 정의할 수 있습니다. ClusterRole과 ClusterRoleBinding의 metadata에는 `namespace`가 없습니다.

#### 4. 실전에서 보이는 모습
- 위 바인딩은 `shop` 안에서만 효력이 있어서 jane이 `board`의 Pod를 지우려 하면 403이 납니다. 메시지는 `Error from server (Forbidden): pods "..." is forbidden: User "jane" cannot delete resource "pods" in API group "" in the namespace "board"` 모양입니다.
- 권한을 미리 확인할 때는 `kubectl auth can-i delete pods -n board --as jane`처럼 묻고 `yes` 또는 `no`로 답을 받습니다.
- 만든 객체는 `kubectl get roles,rolebindings -n shop`으로 목록을 보고 `kubectl describe role order-developer -n shop`으로 규칙을 봅니다. describe는 규칙을 Resources, Non-Resource URLs, Resource Names, Verbs 열의 표로 펼쳐 주니 그룹이나 동사를 빠뜨렸는지 한눈에 보입니다. `kubectl describe rolebinding jane-order-developer -n shop`은 연결된 Role과 Subjects를 보여 줍니다.

> **정리**: Role을 읽을 때는 그룹부터 봅니다. Deployment 규칙에 `apps`가 빠지면 규칙이 아예 맞지 않습니다. 네임스페이스 밖 리소스와 팀마다 재사용할 권한은 ClusterRole로 정의하고 효력 범위는 어떤 바인딩으로 거느냐가 정합니다.

</details>

| 객체 | 범위 | 하는 일 |
|---|---|---|
| Role | 네임스페이스 하나 | 그 네임스페이스 안의 리소스 권한 묶음 |
| ClusterRole | 클러스터 전체 | 여러 네임스페이스에 재사용할 권한, 또는 노드 같은 클러스터 범위 리소스 권한 |
| RoleBinding | 네임스페이스 하나 | Role 또는 ClusterRole을 주체에 연결. 효력은 바인딩의 네임스페이스 안으로 한정 |
| ClusterRoleBinding | 클러스터 전체 | ClusterRole을 주체에 연결. 모든 네임스페이스에 효력 |

"Using RBAC Authorization" 문서에서 시험에 걸리는 성질만 추렸습니다.

- 권한은 더하기만 있습니다("there are no "deny" rules"). 막으려면 그 권한을 주는 바인딩을 지웁니다.
- RoleBinding이 ClusterRole을 가리키면 권한은 그 RoleBinding의 네임스페이스 안에서만 통합니다.
- 바인딩의 `roleRef`는 만든 뒤 바꿀 수 없습니다.

### 1-2. 기본 ClusterRole 네 개

| ClusterRole | 문서 설명 요약 |
|---|---|
| `cluster-admin` | 모든 리소스에 모든 동작 |
| `admin` | 네임스페이스 안 읽기와 쓰기, Role과 RoleBinding 생성까지 |
| `edit` | 읽기와 쓰기. Role과 RoleBinding은 불가 |
| `view` | 읽기 전용. Secret은 볼 수 없음 |

kubeadm의 `admin.conf` 인증서는 그룹 `kubeadm:cluster-admins`(`cluster-admin`에 바인딩)이고 `super-admin.conf`는 RBAC을 건너뛰는 `system:masters` 그룹입니다.

표만 보면 `admin`과 `edit`이 비슷해 보이는데 둘은 남에게 권한을 나눠 줄 수 있느냐에서 갈립니다. 쇼핑몰 `shop` 네임스페이스의 팀장에게 `admin`을 주면 팀원에게 줄 Role과 RoleBinding을 팀장이 직접 만들 수 있고 `edit`만 받은 팀원은 Deployment는 고쳐도 권한 객체는 못 건드립니다. RBAC 문서는 `admin`, `edit`, `view`를 "RoleBinding으로 특정 네임스페이스 안에서 주도록 만든 역할"로 분류합니다. ClusterRole이라고 ClusterRoleBinding으로 주면 모든 네임스페이스에 효력이 생기니 시험에서 "shop에서만"이라는 조건이 붙으면 RoleBinding으로 겁니다.

```bash
# shop 팀장 jane에게 shop 안에서만 admin
kubectl create rolebinding jane-admin -n shop --clusterrole=admin --user=jane
```

`system:masters`는 바인딩을 지워도 막을 수 없습니다. API 서버가 이 그룹을 인가 단계 앞에서 통과시키기 때문입니다. 그래서 kubeadm은 평소 쓰는 `admin.conf`를 일반 그룹으로 바꾸고 `super-admin.conf`는 비상용으로만 둡니다.

### 1-3. 시험에서 쓰는 명령

ServiceAccount의 사용자 이름은 `system:serviceaccount:<네임스페이스>:<이름>`입니다. 복수형 `system:serviceaccounts:<네임스페이스>`는 그룹 이름이라 `--as`에 넣을 때 헷갈리기 쉽습니다.

```bash
# 쇼핑몰 주문 API용 ServiceAccount
kubectl create namespace shop
kubectl create serviceaccount order-api -n shop

# shop 네임스페이스에서 ConfigMap 읽기 권한
kubectl create role config-reader -n shop \
  --verb=get,list,watch --resource=configmaps

kubectl create rolebinding order-api-config-reader -n shop \
  --role=config-reader --serviceaccount=shop:order-api

# 검증: 결과는 yes 또는 no 한 단어
kubectl auth can-i list configmaps -n shop \
  --as=system:serviceaccount:shop:order-api
kubectl auth can-i delete configmaps -n shop \
  --as=system:serviceaccount:shop:order-api
```

YAML 뼈대는 `--dry-run=client -o yaml`로 받습니다. 과제 문장에 자주 붙는 조건과 그에 맞는 옵션은 이렇습니다.

| 과제 문장 | 옵션 | 예 |
|---|---|---|
| "order-config라는 ConfigMap만" | `--resource-name` | `kubectl create role cm-one -n shop --verb=get,update --resource=configmaps --resource-name=order-config` |
| "Pod 로그를 볼 수 있게" | 서브리소스 `pods/log` | `kubectl create role log-reader -n shop --verb=get --resource=pods/log` |
| "사용자 jane에게" | `--user` | `kubectl create rolebinding ... --user=jane` |
| "dev 그룹 전체에" | `--group` | `kubectl create rolebinding ... --group=dev` |
| "ServiceAccount에게" | `--serviceaccount=<ns>:<이름>` | 위 코드 블록 |

`pods`에 `get`을 줘도 `kubectl logs`는 막힙니다. 로그는 `pods/log`라는 별도 서브리소스라 따로 줘야 합니다. `kubectl exec`도 같은 이유로 `pods/exec`에 `create`가 필요합니다.

### 1-4. 헷갈리는 지점

- 클러스터 범위 리소스(노드, PV, 네임스페이스)의 권한은 ClusterRole로 정의합니다.
- API 그룹이 있는 리소스는 그룹까지 맞아야 합니다. `kubectl create role`에서는 `--resource=deployments.apps`처럼 점 뒤에 그룹을 붙입니다.
- `roleRef`를 바꾸는 과제라면 바인딩을 지우고 다시 만듭니다. RBAC 문서가 드는 이유는 둘입니다. 바인딩에 `update` 권한만 받은 사람이 subjects 명단은 관리하되 그 명단에 주는 역할은 못 바꾸게 막으려는 목적이 하나입니다. 또 역할이 바뀌면 사실상 다른 바인딩이니 기존 명단 전원에게 새 역할을 줘도 되는지 다시 확인하게 하려는 뜻도 있습니다. 고치려 하면 이런 오류가 납니다.

```text
The RoleBinding "order-api-config-reader" is invalid: roleRef: Invalid value: ...: field is immutable
```

### 1-5. kubeconfig 컨텍스트와 권한 목록

```bash
kubectl config get-contexts
kubectl config use-context <컨텍스트>
kubectl config set-context --current --namespace=shop

kubectl auth whoami
kubectl auth can-i --list -n shop --as=system:serviceaccount:shop:order-api
kubectl auth can-i get pods --subresource=log -n shop
kubectl --kubeconfig /path/to/user.conf get pods -n shop
```

`--as`는 사칭(impersonation) 권한이 있어야 씁니다. 현재 시험은 과제마다 지정 호스트로 `ssh`하는 방식이라 컨텍스트 전환은 kubeconfig 이해용으로 두고 과제 상자의 명령을 먼저 실행합니다.

### 1-6. RBAC 앞 단계: 인증 방식과 인가 모드

<details>
<summary>기초부터: 사람 사용자와 ServiceAccount, 인증 방식, 인가 모드의 체인</summary>

> **핵심 한 줄**: 쿠버네티스는 사람 계정을 저장하지 않고 "이 요청은 jane이 보냈다"는 증거만 확인(인증)한 뒤 인가 모듈을 순서대로 돌려 허용 여부를 정합니다.

#### 1. 왜 필요한가
조직에는 이미 계정 시스템(LDAP, OIDC를 지원하는 IdP)이 있으니 쿠버네티스는 그쪽을 믿고 증거만 봅니다. 클러스터에 접속하는 주체는 둘로 나뉩니다.

| 주체 | 예 | 쿠버네티스 안의 오브젝트 |
|---|---|---|
| 사람(User) | 관리자, 개발자 | 없음. `kubectl get users`는 없는 명령 |
| 기계(ServiceAccount) | Pod 안의 앱, CI 봇, 모니터링 에이전트 | 있음. 네임스페이스마다 만들고 지움 |

#### 2. 어떻게 동작하나
1. **인증(누구인가)**: 아래 방식 중 하나로 증거를 확인합니다.
2. **인가(해도 되나)**: `--authorization-mode`에 적은 모듈이 순서대로 요청을 봅니다.
3. **체인 규칙**: 모듈은 허용, 거부, 의견 없음(no opinion) 셋 중 하나를 냅니다. 허용이나 거부가 나오면 그 자리에서 결정되고 뒤 모듈은 묻지 않습니다. 의견 없음이면 다음 모듈로 넘어가고 모두 의견 없음이면 403입니다(Authorization 문서).

```text
요청 → 인증(인증서 CN / 토큰) → --authorization-mode=Node,RBAC
          Node:  kubelet 요청?  예 → 허용/거부 결정
                               아니오 → 의견 없음 ↓
          RBAC:  맞는 규칙?     예 → 허용
                               아니오 → 의견 없음 ↓
          모두 의견 없음 → 403 Forbidden
```

#### 3. 한눈에 비교
| 인증 방식 | 증거 | 비고 |
|---|---|---|
| X.509 클라이언트 인증서 | 클러스터 CA가 서명한 인증서. CN이 사용자, O가 그룹 | kubeadm의 `admin.conf`와 1-9절의 CSR |
| 베어러 토큰 | HTTP 헤더 `Authorization: Bearer <토큰>` | ServiceAccount 토큰, OIDC ID 토큰, 부트스트랩 토큰(`kubeadm join`) |
| 정적 토큰 파일 | `--token-auth-file`에 토큰, 사용자, UID, 그룹을 CSV로 | 토큰이 평문으로 남고 바꿀 때마다 API 서버 재시작. 운영에는 안 씀. 비밀번호 파일(`--basic-auth-file`)은 1.19에서 제거 |

| 인가 모드 | 판단 방식 |
|---|---|
| `Node` | kubelet 전용. `system:nodes` 그룹의 `system:node:<노드 이름>` 사용자에게 자기 노드에 필요한 권한만 허용 |
| `RBAC` | Role과 바인딩으로 판단 |
| `ABAC` | 정책 파일로 판단. 바꿀 때마다 API 서버 재시작 |
| `Webhook` | 외부 서비스에 판단을 맡김 |
| `AlwaysAllow`, `AlwaysDeny` | 무조건 허용, 무조건 거부. 테스트용 |

#### 4. 헷갈리는 점 / 실전에서 보이는 모습
- RBAC은 명시적으로 거부하지 않고 맞는 규칙이 없으면 의견 없음을 냅니다. 그래서 `Node,RBAC`에서 kubelet 요청은 대부분 Node가 바로 판단하고 사람의 요청은 Node가 의견 없음으로 넘겨 RBAC이 판단합니다.
- 앞에 `AlwaysAllow`를 두면 모든 요청이 거기서 허용되어 RBAC은 쓸모가 없어집니다.
- 단계마다 실패 코드가 다릅니다. 인증에서 걸리면 401(kubectl에는 `Unauthorized`), 인가에서 걸리면 403(`Forbidden`)입니다. 401이면 인증서나 토큰을, 403이면 RBAC 바인딩을 봅니다.
- 정적 토큰 파일은 한 줄이 `토큰,사용자,UID,"그룹1,그룹2"` 형식의 CSV이고 API 서버는 실행 중에 바뀐 내용을 다시 읽지 않습니다(Authentication 문서). kubeadm 클러스터의 API 서버는 static Pod라서 `--token-auth-file`만 더하면 컨테이너 안에서 파일을 찾지 못합니다. `kube-apiserver.yaml`에 그 파일이 든 디렉터리를 hostPath 볼륨과 volumeMounts로 함께 넣어야 합니다.
- `--authorization-mode`를 아예 적지 않으면 기본값은 `AlwaysAllow`입니다(kube-apiserver 레퍼런스, `--authorization-config`를 쓰지 않을 때). 손으로 띄운 API 서버에서 이 플래그를 빠뜨리면 인증만 통과한 누구나 무엇이든 할 수 있습니다. kubeadm이 `Node,RBAC`을 넣어 주는 것도 그래서입니다.
- `Webhook`은 OPA 같은 외부 정책 엔진에 "이 사용자가 이 동작을 해도 되나"를 HTTP로 묻고 답을 받아 따릅니다. 판단 규칙을 클러스터 밖에서 한곳에 모아 관리하고 싶을 때 씁니다.
- 옛 자료에는 "앞 모듈이 거부하면 다음 모듈로 넘긴다"는 설명이 있는데 다음으로 넘어가는 것은 의견 없음일 때뿐이고 명시적 거부는 그 자리에서 끝납니다.

> **정리**: 막힌 단계는 실패 코드로 가립니다. 401이면 인증서나 토큰을, 403이면 RBAC 바인딩을 봅니다. 거꾸로 막혀야 할 요청이 통과하면 `--authorization-mode` 앞자리에 `AlwaysAllow`가 끼어 있지 않은지 확인합니다.

</details>

요청은 인증, 인가, 어드미션 순서로 통과하고 RBAC은 인가 단계의 한 모듈입니다. 쿠버네티스에는 User 객체가 없습니다. 클라이언트 인증서라면 Subject의 CN이 사용자 이름, O가 그룹이고 ServiceAccount 토큰이라면 1-3절의 이름 형식입니다.

인가 모드는 kube-apiserver의 `--authorization-mode`에 적힌 순서로 묻고 kubeadm 기본값은 `Node,RBAC`입니다. 모든 모듈이 의견이 없으면 403이고 앞에 `AlwaysAllow`가 있으면 RBAC은 의미가 없어집니다.

```bash
sudo grep authorization-mode /etc/kubernetes/manifests/kube-apiserver.yaml
```

### 1-7. API 그룹과 리소스 이름 찾기

<details>
<summary>기초부터: API 경로와 그룹, kubectl proxy</summary>

> **핵심 한 줄**: kubectl은 결국 API 서버에 HTTPS 요청을 보내고 그 URL 모양이 RBAC 규칙의 모양과 같습니다.

#### 1. 왜 필요한가
`kubectl get pods -n shop -v=6`을 치면 실제 URL이 보입니다. URL 구조를 알면 Role의 `apiGroups`, `resources`, `verbs`를 어디서 따올지 바로 보여 Role을 쓰기 쉬워집니다.

#### 2. 어떻게 동작하나
```text
/api/v1/namespaces/shop/pods                    core 그룹(이름 없음)
/apis/apps/v1/namespaces/shop/deployments       apps 그룹
/apis/networking.k8s.io/v1/namespaces/shop/networkpolicies
/apis/certificates.k8s.io/v1/certificatesigningrequests   (클러스터 범위라 namespaces가 없음)
```

1. **core 그룹**: `/api/v1` 아래에 있습니다. Pod, Service, Node, Namespace, ConfigMap, Secret, PV, PVC처럼 초창기부터 있던 리소스입니다. RBAC에서 `apiGroups: [""]`로 씁니다.
2. **이름 있는 그룹**: `/apis/<그룹>/<버전>` 아래에 있습니다. 기능이 늘면서 목적별로 나눠 각 그룹이 따로 alpha, beta, v1 버전을 올릴 수 있게 했습니다.
3. **리소스와 동사**: URL 끝의 리소스(`pods`)와 HTTP 메서드가 RBAC의 `resources`와 `verbs`가 됩니다.

| 요청 | RBAC 동사 |
|---|---|
| GET `.../pods/web-1`(이름 있음) | `get` |
| GET `.../pods`(목록) | `list` |
| GET `.../pods?watch=true` | `watch` |

#### 3. 한눈에 비교: kubectl proxy와 kube-proxy
| 구분 | kubectl proxy | kube-proxy |
|---|---|---|
| 도는 곳 | 내 터미널에서 잠깐 | 모든 노드에서 상시 |
| 하는 일 | 내 kubeconfig 자격 증명으로 API 서버에 붙는 작은 HTTP 중계기를 `127.0.0.1:8001`에 띄움 | Service 트래픽을 Pod로 보내는 커널 규칙을 관리 |
| 정체 | API 접근 도구 | 클러스터 구성요소 |

인증서를 직접 붙여 curl로 부르면 옵션이 길어집니다. proxy를 띄운 뒤로는 `curl http://127.0.0.1:8001/apis/apps/v1`처럼 평문으로 불러도 proxy가 인증을 대신 붙여 보냅니다.

#### 4. 실전에서 보이는 모습
- 클러스터에 그룹 목록을 물을 때는 `kubectl get --raw /apis | head`도 됩니다.
- `kubectl api-resources`는 리소스마다 APIVERSION(그룹/버전)과 NAMESPACED(네임스페이스 범위 여부)를 보여 줍니다. Role의 `apiGroups`가 헷갈릴 때 여기서 확인합니다.
- proxy 없이 curl로 부를 때는 인증서 세 개를 붙입니다. `curl --cacert ca.crt --cert admin.crt --key admin.key https://<API 서버>:6443/apis`처럼 CA(서버 검증), 클라이언트 인증서, 개인 키를 줍니다.
- 인증서를 하나도 안 붙이면 요청은 익명 사용자 `system:anonymous`(그룹 `system:unauthenticated`)로 처리됩니다(`--anonymous-auth` 기본 true). 기본 ClusterRole `system:public-info-viewer`가 이 그룹에도 바인딩되어 있어 `/version`, `/healthz` 같은 공개 정보는 응답하고 `/api/v1/pods` 같은 경로는 인가에서 403으로 막힙니다. 그래서 "인증서 없이 부르면 무조건 401"은 맞지 않습니다.

> **정리**: Role의 `apiGroups`가 헷갈리면 URL을 떠올립니다. `/api/v1` 아래 리소스는 `[""]`, `/apis/<그룹>` 아래 리소스는 그 그룹 이름이고 `kubectl api-resources`로 확인합니다. kubectl proxy는 이 URL을 손으로 불러 보는 도구입니다.

</details>

Role의 `apiGroups`에는 리소스가 속한 그룹을 적습니다. pods, services, configmaps, secrets, nodes는 core라 `[""]`, Deployment 계열은 `["apps"]`, jobs와 cronjobs는 `["batch"]`입니다. 헷갈리면 클러스터에 묻습니다.

```bash
kubectl api-resources --namespaced=false        # 클러스터 범위 리소스 (ClusterRole 필요)
kubectl api-resources --api-group=apps -o wide  # 그룹별, 지원 동사(VERBS) 포함
kubectl explain deployment | head -5            # GROUP, KIND, VERSION
```

### 1-8. ServiceAccount 토큰

<details>
<summary>기초부터: Pod 안의 앱이 API 서버에 자기를 증명하는 방법</summary>

> **핵심 한 줄**: ServiceAccount(SA)는 기계용 신원이고 쿠버네티스가 Pod마다 만료되는 토큰을 발급하고 교체까지 맡습니다.

#### 1. 왜 필요한가
Pod 안의 앱도 API 서버를 부를 때가 있습니다. 배포 도구가 Deployment를 고치거나 모니터링 에이전트가 Pod 목록을 읽는 경우입니다.

| 구분 | 인증서를 이미지에 넣기 | ServiceAccount 토큰 |
|---|---|---|
| 발급 | 사람이 직접 | kubelet이 TokenRequest API로 자동 |
| 유출 시 | 계속 쓸 수 있음 | Pod에 묶여 있고 만료 시간이 있음 |
| 교체 | 이미지를 다시 만들어야 함 | kubelet이 만료 전에 새 토큰으로 바꿔 넣음 |

#### 2. 어떻게 동작하나
1. **기본 SA**: 네임스페이스를 만들면 컨트롤러가 `default`라는 SA를 자동으로 만듭니다. Pod에 `serviceAccountName`을 적지 않으면 이 SA가 붙습니다. `default` SA에는 API 탐색 정도 말고는 권한이 없습니다.
2. **토큰 주입**: Pod가 노드에 배정되면 kubelet이 TokenRequest API로 그 Pod 전용 토큰을 받아 projected 볼륨으로 `/var/run/secrets/kubernetes.io/serviceaccount/token`에 넣습니다. 같은 자리에 API 서버 CA(`ca.crt`)와 `namespace` 파일도 들어갑니다.
3. **교체와 무효화**: kubelet이 만료 전에 새 토큰으로 바꿔 넣고 Pod가 지워지면 토큰도 무효가 됩니다. 1.24 전에는 SA마다 만료 없는 토큰을 Secret으로 만들어 두었는데 유출되면 계속 쓸 수 있어 바뀌었습니다.
4. **호출**: 앱은 이 파일을 읽어 `Authorization: Bearer <토큰>` 헤더로 API 서버를 부릅니다. 사용자 이름은 `system:serviceaccount:<네임스페이스>:<SA 이름>`이고 권한은 이 이름에 RoleBinding으로 줍니다.

```text
Pod 배정 → kubelet → TokenRequest API → 토큰(Pod에 묶임, 만료 있음)
       → /var/run/secrets/kubernetes.io/serviceaccount/{token, ca.crt, namespace}
앱 → Authorization: Bearer <토큰> → API 서버 → system:serviceaccount:board:board-indexer → RBAC
```

#### 3. 실무 원칙과 토큰 수명 직접 정하기
- API를 부를 일이 없는 Pod(정적 웹 서버 같은)는 `automountServiceAccountToken: false`로 토큰을 아예 넣지 않습니다. 토큰이 있으면 그 Pod가 털렸을 때 공격자가 토큰으로 API를 부를 수 있기 때문입니다.
- API를 불러야 하는 Pod는 용도별 SA를 따로 만들어 필요한 권한만 줍니다.
- 토큰 수명을 직접 정하고 싶으면 자동 마운트를 끄고 projected 볼륨을 직접 적습니다.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: board-indexer
  namespace: board
spec:
  serviceAccountName: board-indexer
  automountServiceAccountToken: false
  containers:
  - name: app
    image: busybox:1.36
    command: ["sleep", "3600"]
    volumeMounts:
    - name: api-token
      mountPath: /var/run/secrets/tokens
      readOnly: true
  volumes:
  - name: api-token
    projected:
      sources:
      - serviceAccountToken:
          path: token
          expirationSeconds: 3600   # 최소 600
          # audience를 생략하면 API 서버용 토큰. 다른 값을 넣으면 그 대상 전용이 되어 API 서버가 거부함
```

#### 4. 실전에서 보이는 모습
- 클러스터 밖의 CI 서버처럼 볼륨을 받을 수 없는 곳에는 `kubectl create token <SA> --duration=1h`로 토큰을 발급해 건네줍니다. 이 토큰은 어디에도 저장되지 않고 화면에 한 번 출력되며 기간이 지나면 쓸 수 없습니다.
- 바인딩 없이 API를 부르면 403 메시지에 `User "system:serviceaccount:board:default"`처럼 SA 이름이 찍힙니다. 이 이름을 그대로 RoleBinding의 subjects에 넣으면 됩니다.

> **정리**: 403 메시지에 찍힌 `system:serviceaccount:...` 이름이 그대로 RoleBinding의 subjects가 됩니다. 클러스터 밖에 건넬 토큰은 `kubectl create token`으로, 수명을 직접 정할 토큰은 projected 볼륨으로 받고 API를 안 부르는 Pod에는 토큰을 넣지 않습니다.

</details>

1.24부터 ServiceAccount를 만들어도 Secret 기반 장기 토큰이 자동으로 생기지 않습니다. Pod에는 TokenRequest API로 받은 짧은 수명의 토큰이 projected 볼륨(`kube-api-access-*`)으로 들어가고 위치는 `/var/run/secrets/kubernetes.io/serviceaccount/`의 `token`, `ca.crt`, `namespace`입니다. 토큰이 필요 없는 Pod는 `automountServiceAccountToken: false`로 끕니다.

```bash
kubectl create token order-api -n shop                  # 수명은 서버가 정함
kubectl create token order-api -n shop --duration=30m
kubectl set serviceaccount deployment order-web order-api -n shop   # Pod 템플릿이 바뀌어 롤아웃
```

최소 수명은 10분입니다. `--duration=5m`은 이렇게 거절됩니다.

```text
spec.expirationSeconds: Invalid value: 300: may not specify a duration less than 10 minutes
```

`kubectl describe sa`에 `Tokens:` 줄이 없는 것도 정상입니다. 만료 없는 토큰이 꼭 필요하면 Secret을 직접 만들고 컨트롤 플레인이 `data.token`을 채웁니다.

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: order-api-token
  namespace: shop
  annotations:
    kubernetes.io/service-account.name: order-api
type: kubernetes.io/service-account-token
```

audience나 수명을 바꾸려면 Pod 스펙의 projected 볼륨에 `serviceAccountToken`을 적습니다. audience를 바꾼 토큰은 API 서버가 `Unauthorized`로 거부합니다.

### 1-8b. 인증서 위치와 용도

인증서는 공개 키와 Subject에 CA가 용도와 기간을 붙여 서명한 문서이고 개인 키(`.key`)는 만든 자리를 떠나지 않습니다. 구성요소끼리는 양쪽이 인증서를 내미는 mTLS로 통신합니다. kubeadm은 CA 세 개(`ca`, `etcd/ca`, `front-proxy-ca`)를 만들고 파일은 `/etc/kubernetes/pki`에 둡니다.

| 연결 | 서버 쪽 | 클라이언트 쪽 | CA |
|---|---|---|---|
| kubectl -> apiserver | `apiserver.crt` | `admin.conf` 안의 인증서 | `ca` |
| kubelet -> apiserver | `apiserver.crt` | `/var/lib/kubelet/pki/`의 회전 인증서 | `ca` |
| apiserver -> kubelet | kubelet 서빙 인증서 | `apiserver-kubelet-client.crt` | `ca` |
| apiserver -> etcd | `etcd/server.crt` | `apiserver-etcd-client.crt` | `etcd/ca` |
| etcdctl(백업) -> etcd | `etcd/server.crt` | `etcd/server.crt` 또는 `etcd/healthcheck-client.crt` | `etcd/ca` |

표에서 두 군데는 설명이 더 필요합니다.

- **apiserver -> kubelet 줄**: kubeadm이 까는 kubelet 서빙 인증서는 기본이 자체 서명입니다(kubeadm "Certificate Management" 문서). kubeadm은 API 서버에 `--kubelet-certificate-authority`를 넣지 않으니 API 서버는 이 인증서를 검증하지 않고 붙습니다. 반대로 kubelet은 API 서버가 내미는 클라이언트 인증서를 `ca`로 확인합니다. metrics-server가 `x509: cannot validate certificate` 류의 오류로 kubelet에 못 붙을 때 `--kubelet-insecure-tls`를 넣는 흔한 처방이 이 자체 서명 때문입니다. 제대로 고치려면 kubelet 설정에 `serverTLSBootstrap: true`를 넣고 `kubernetes.io/kubelet-serving` CSR을 승인합니다(1-9절).
- **`front-proxy-ca`**: metrics-server처럼 API 서버 뒤에 붙는 확장 API 서버로 요청을 넘길 때 쓰는 CA입니다. API 서버가 "이 요청은 jane이 보낸 것"이라는 헤더를 붙여 넘기면 확장 서버는 그 헤더를 믿어도 되는지 `front-proxy-client` 인증서로 확인합니다. `kubectl top`이 안 될 때 보는 줄입니다.

`ca.key`를 꺼내지 않고 서명받는 길이 1-9절의 CSR API이고 인증서를 읽는 `openssl` 명령은 4-8절에 있습니다.

### 1-9. 사용자 인증서 발급: CSR 승인 흐름

<details>
<summary>기초부터: CA 서버의 실체와 CSR API가 생긴 이유</summary>

> **핵심 한 줄**: kubeadm 클러스터의 CA는 컨트롤 플레인 노드의 파일 두 개이고 CSR API는 그 키를 꺼내지 않고 서명 요청과 승인을 kubectl로 처리하게 합니다.

#### 1. 왜 필요한가
"CA 서버"라고 하면 거창한 장비를 떠올리기 쉽지만 실체는 `/etc/kubernetes/pki/ca.crt`와 `ca.key`입니다. `ca.key`를 가진 사람은 `system:masters` 그룹 인증서도 직접 서명해 만들 수 있으니 클러스터 전체를 쥔 것과 같습니다. 그래서 이 파일은 노드 밖으로 꺼내지 않습니다.

| 구분 | 직접 서명 | CSR API |
|---|---|---|
| 방법 | 관리자가 노드에 SSH로 들어가 `openssl`로 서명 | 서명 요청과 승인을 API 오브젝트로 처리 |
| `ca.key`를 다루는 사람 | 새 사용자가 생길 때마다 늘어남 | kube-controller-manager만 |
| 쓰는 도구 | SSH, openssl | kubectl |

#### 2. 어떻게 동작하나
1. **사용자**: 자기 PC에서 개인 키를 만들고 그 키로 CSR 파일(공개 키와 원하는 CN, O)을 만듭니다. CSR에는 개인 키로 한 서명이 들어 있어 "이 공개 키의 짝을 실제로 가진 사람"이 요청했다는 것이 증명됩니다. 개인 키는 PC에 남기고 CSR 파일만 넘깁니다.
2. **관리자(제출과 승인)**: CSR 파일을 base64로 바꿔 `CertificateSigningRequest` 오브젝트의 `spec.request`에 넣고 만듭니다. 상태는 Pending입니다. 내용(이름, 그룹, 서명자, 용도)을 확인하고 `kubectl certificate approve`로 승인합니다.
3. **kube-controller-manager(서명)**: 승인된 CSR을 watch하던 서명 컨트롤러가 `--cluster-signing-cert-file`, `--cluster-signing-key-file`(kubeadm은 `ca.crt`, `ca.key`)로 서명하고 결과를 `status.certificate`에 base64로 넣습니다. API 서버는 기록만 하고 서명은 컨트롤러가 합니다.
4. **관리자 또는 사용자(사용)**: `status.certificate`를 디코딩해 `.crt` 파일로 만들고 개인 키와 함께 kubeconfig에 넣습니다.

```text
사용자 PC: 개인 키 → CSR 파일 ──(CSR 파일만)──> 관리자: CSR 오브젝트 생성(Pending)
  → kubectl certificate approve(Approved)
  → kube-controller-manager가 ca.key로 서명 → status.certificate(Issued)
  → .crt + 개인 키 → kubeconfig
```

#### 3. 한눈에 비교: 서명자별 승인 방식
| 서명자 | 승인 | 쓰임 |
|---|---|---|
| `kubernetes.io/kube-apiserver-client-kubelet` | kube-controller-manager가 자동 승인 | 노드 부트스트랩과 갱신용 kubelet 클라이언트 CSR |
| `kubernetes.io/kube-apiserver-client` | 사람이 수동 승인. `usages`에 `client auth` 필요 | 사람용 클라이언트 인증서 |

#### 4. 헷갈리는 점 / 실전에서 보이는 모습
- `kubectl get csr`의 CONDITION이 `Pending` → `Approved,Issued`로 바뀌어야 인증서가 나옵니다.
- 서명 플래그 두 개가 틀리면 승인을 해도 인증서가 나오지 않습니다. 승인만 되고 `status.certificate`가 비어 있으면 kube-controller-manager의 이 플래그부터 봅니다.
- 인증서를 받아도 권한은 0이고 RBAC 바인딩을 따로 해야 합니다.

#### 5. 컨트롤러 매니저 안의 CSR 컨트롤러 셋
kube-controller-manager 레퍼런스의 `--controllers` 목록에 CSR을 맡는 컨트롤러가 셋 있고 모두 기본으로 켜져 있습니다.

| 컨트롤러 | 하는 일 |
|---|---|
| `certificatesigningrequest-approving-controller` | kubelet 클라이언트 CSR(`kube-apiserver-client-kubelet`)을 자동 승인 |
| `certificatesigningrequest-signing-controller` | 승인된 CSR에 `--cluster-signing-*` 키로 서명 |
| `certificatesigningrequest-cleaner-controller` | 끝난 CSR 객체 정리 |

정리 시간은 CSR 문서 기준으로 승인, 거절, 실패한 요청은 1시간, Pending으로 남은 요청은 24시간이고 발급된 인증서가 만료되면 그 CSR도 지워집니다.

> **정리**: 사람용 CSR은 사람이 승인하고 서명은 kube-controller-manager가 합니다. 승인했는데 `status.certificate`가 비어 있으면 `--cluster-signing-*` 플래그부터 봅니다. 인증서가 나와도 권한은 0이라 RBAC 바인딩을 따로 겁니다.

</details>

공식 태스크 문서의 절차를 쇼핑몰 정산 담당자 `settle-user`로 옮겼습니다.

```bash
# 1) 키와 CSR 파일 (CN이 사용자 이름, O가 그룹)
openssl genrsa -out settle-user.key 3072
openssl req -new -key settle-user.key -out settle-user.csr -subj "/CN=settle-user/O=finance"

# 2) CSR 객체에 넣을 base64 한 줄
cat settle-user.csr | base64 | tr -d "\n"
```

```yaml
apiVersion: certificates.k8s.io/v1
kind: CertificateSigningRequest
metadata:
  name: settle-user
spec:
  request: <위 base64 한 줄>
  signerName: kubernetes.io/kube-apiserver-client
  expirationSeconds: 86400   # 하루
  usages:
    - client auth
```

```bash
# 3) 제출, 승인, 인증서 꺼내기
kubectl apply -f settle-user-csr.yaml
kubectl get csr                                   # CONDITION: Pending
kubectl certificate approve settle-user           # 거절은 kubectl certificate deny
kubectl get csr settle-user -o jsonpath='{.status.certificate}' | base64 -d > settle-user.crt

# 4) kubeconfig에 등록
kubectl config get-clusters                       # --cluster에 넣을 실제 이름 확인
kubectl config set-credentials settle-user \
  --client-key=settle-user.key --client-certificate=settle-user.crt --embed-certs=true
kubectl config set-context settle-user --cluster=kubernetes --user=settle-user
```

승인 뒤 CONDITION은 `Approved,Issued`가 됩니다. 틀리기 쉬운 곳은 이렇습니다.

- `signerName`은 필수이고 사람용 `kubernetes.io/kube-apiserver-client`는 `usages`에 `client auth`가 있어야 합니다.
- `expirationSeconds` 최솟값은 600입니다. 서명은 kube-controller-manager가 `pki/ca.crt`, `ca.key`로 합니다.
- 승인되거나 거절된 CSR 객체는 1시간 뒤 지워지니 인증서는 바로 꺼내 둡니다.
- `--cluster`에 없는 이름을 넣어도 `set-context`는 성공하고 나중에 접속할 때 엉뚱한 오류가 납니다.

인증서만으로는 권한이 없으니 `--user=settle-user`나 `--group=finance`로 바인딩하고 `kubectl auth can-i ... --as=settle-user`로 확인합니다.

### 1-10. kubeconfig 파일 구조

<details>
<summary>기초부터: kubeconfig가 해결하는 문제</summary>

> **핵심 한 줄**: kubeconfig는 "어디로 갈지"와 "나는 누구인지"를 파일 하나에 묶어 kubectl이 매번 알아서 읽게 하는 접속 설정입니다.

#### 1. 왜 필요한가
kubeconfig 없이 API 서버를 부르려면 매번 네 가지를 붙여야 합니다.

```bash
kubectl get pods \
  --server https://192.168.56.10:6443 \
  --certificate-authority /etc/kubernetes/pki/ca.crt \
  --client-certificate ./jane.crt \
  --client-key ./jane.key
```

서버 주소와 그 서버를 검증할 CA(어디로), 인증서와 키(나는 누구)를 명령마다 되풀이해야 합니다.

#### 2. 어떻게 구성되나
1. **`clusters`**: 갈 곳 목록입니다. 이름, 서버 주소, CA 인증서를 담습니다.
2. **`users`**: 신원 목록입니다. 이름, 클라이언트 인증서와 키 또는 토큰을 담습니다.
3. **`contexts`**: 위 둘을 짝지은 조합입니다. 클러스터 하나, 사용자 하나, 선택으로 기본 네임스페이스를 묶습니다.
4. **`current-context`**: 지금 쓰는 조합의 이름입니다.

```text
clusters: dev, prod          users: jane, viewer
           \                    /
contexts:  dev-jane = dev + jane (+ namespace: shop)
           prod-viewer = prod + viewer
current-context: dev-jane  → 모든 kubectl 명령이 이 조합으로 감
```

클러스터와 사용자를 따로 적고 컨텍스트로 묶는 이유는 조합이 여러 개이기 때문입니다. 한 사람이 여러 클러스터에 붙기도 하고 한 클러스터에 관리자와 읽기 전용 두 신원으로 붙기도 합니다.

#### 3. 한눈에 비교: 경로와 `-data`
| 쓰는 법 | 예 | 특징 |
|---|---|---|
| 파일 경로 | `certificate-authority: /path/ca.crt` | 인증서 파일이 따로 있어야 함 |
| 내용 직접 | `certificate-authority-data: LS0tLS1C...` | 인증서 내용을 base64로 넣음. 파일 하나만 옮겨도 접속됨 |

`-data`로 넣은 파일에는 개인 키가 들어 있으니 파일 자체를 키처럼 다룹니다.

#### 4. 실전에서 보이는 모습
- `kubectl config use-context <이름>`은 파일의 `current-context` 값만 바꾸고 그 뒤 모든 kubectl 명령이 그 조합으로 갑니다.
- 운영과 개발이 한 파일에 있다면 지울 일을 하기 전에 `kubectl config current-context`로 지금 위치부터 봅니다. `kubectl config get-contexts`는 현재 컨텍스트에 `*`를 붙여 보여 줍니다.
- `kubectl config view`는 `-data` 값을 `DATA+OMITTED`나 `REDACTED`로 가려서 보여 줍니다.
- `clusters`의 `certificate-authority`는 브라우저에 내장된 공인 CA 목록과 같은 역할입니다. 클러스터 CA는 kubeadm이 만든 사설 CA라 어느 PC에도 미리 들어 있지 않으니 kubeconfig에 직접 넣어 줘야 서버 인증서를 믿을 수 있습니다. 사설 CA가 발급한 인증서를 쓰는 내부 사이트를 열려면 그 CA를 PC에 먼저 설치해야 하는 것과 같은 이치입니다.

> **정리**: `use-context`는 `current-context` 값 하나만 바꾸지만 그 뒤 모든 명령의 목적지와 신원이 함께 바뀝니다. 지우는 작업 전에는 `kubectl config current-context`로 지금 위치부터 확인합니다.

</details>

```yaml
apiVersion: v1
kind: Config
clusters:
  - name: kubernetes
    cluster:
      server: https://cluster-endpoint:6443
      certificate-authority-data: <CA 인증서 base64>
users:
  - name: settle-user
    user:
      client-certificate-data: <인증서 base64>
      client-key-data: <개인 키 base64>
contexts:                 # cluster + user (+ namespace) 조합
  - name: settle-user@kubernetes
    context:
      cluster: kubernetes
      user: settle-user
      namespace: payment
current-context: settle-user@kubernetes
```

`*-data` 필드는 내용을 base64로 넣은 것이고 `-data`가 없으면 파일 경로입니다. 파일을 고르는 순서는 `--kubeconfig`, `KUBECONFIG` 환경 변수, `$HOME/.kube/config`입니다.

### 1-11. 직접 해 보기

네임스페이스 `board`에 ServiceAccount `board-reader`를 만들고 ClusterRole `view`를 RoleBinding으로 연결합니다. `board`의 Pod 목록은 `yes`, `default`는 `no`, `board`의 Secret은 `no`인지 봅니다. 사용자 `board-editor`의 CSR을 승인해 컨텍스트를 만들고 바인딩 전후로 403이 사라지는지 확인합니다. 토큰으로 접속해 볼 때는 `KUBECONFIG=/dev/null kubectl --token=... --server=... --certificate-authority=...`처럼 kubeconfig를 비웁니다. 인증서가 든 kubeconfig가 남아 있으면 인증서 인증이 먼저 성공해 관리자로 붙습니다.

## 2. 설치 전 노드 준비

<details>
<summary>기초부터: 클러스터를 세우기 전에 정할 것(용도, 설치 방식, 규모)</summary>

> **핵심 한 줄**: 설치 명령보다 먼저 용도, 운영 주체, 워크로드, 트래픽을 정해야 노드 수와 설치 도구가 정해집니다.

#### 1. 왜 필요한가
학습용 클러스터와 실서비스 클러스터는 필요한 대수와 장애 대비가 전혀 다릅니다. 설치 명령을 치기 전에 정할 질문이 몇 가지 있습니다.

1. **용도**: 공부와 테스트용인지 실제 서비스용인지
2. **운영 주체**: 컨트롤 플레인을 직접 운영할지 클라우드 관리형(EKS, GKE, AKS)에 맡길지
3. **워크로드**: 상태 없는 웹 API 위주인지 DB처럼 디스크 입출력이 큰 상태 있는 워크로드가 있는지
4. **트래픽**: 꾸준한지 특정 시각에 몰리는지

#### 2. 답에 따라 갈리는 구성
| 용도 | 구성 | 도구 |
|---|---|---|
| 개인 학습, 빠른 테스트 | 노드 한 대 또는 컨테이너로 흉내 낸 노드 | kind, minikube |
| 실제 구성 연습, 시험 대비 | VM 여러 대에 컨트롤 플레인 1대와 워커 2대 | kubeadm |
| 실서비스 | 컨트롤 플레인 3대 이상 HA(5장)와 로드 밸런서 | kubeadm 같은 설치 도구 또는 관리형 서비스 |

```text
용도? ── 학습 ───────→ kind, minikube
      ├─ 시험 대비 ──→ kubeadm (CP 1 + 워커 2)
      └─ 실서비스 ──→ 직접 운영? ── 예 → kubeadm HA (CP 3+ + LB)
                                   └ 아니오 → EKS, GKE, AKS
```

쿠버네티스는 리눅스 커널 기능 위에서 돌기 때문에 macOS나 Windows PC에서는 리눅스 VM이나 컨테이너 안에 노드를 띄웁니다. 컨트롤 플레인은 리눅스에서만 돌고 Windows 서버는 워커 노드로만 붙일 수 있습니다(Windows in Kubernetes 문서).

| 도구 | 기계 준비 | 노드 수 |
|---|---|---|
| minikube | VM이나 컨테이너를 스스로 만들고 그 안에 클러스터까지 설치 | 기본 한 대, `--nodes`로 늘림 |
| kubeadm | 이미 있는 리눅스 머신이 전제. 기계는 만들지 않고 쿠버네티스 구성요소만 올림 | 여러 대 |

VM 여러 대를 손으로 만들기 번거로우면 Vagrant 같은 도구로 VM의 CPU, 메모리, IP, OS 이미지를 `Vagrantfile` 한 파일에 적어 두고 `vagrant up`으로 한꺼번에 띄운 뒤 `vagrant ssh <이름>`으로 들어갑니다. 이때 VM에 붙는 `192.168.56.x` 같은 주소는 노드 IP이고 나중에 CNI가 나눠 줄 Pod 대역과는 다른 대역입니다.

#### 3. 한눈에 비교: 관리형과 직접 설치
| 구분 | 관리형 서비스 | 직접 설치 |
|---|---|---|
| 컨트롤 플레인 장애 대응, etcd 백업, OS 패치 | 클라우드 사업자 | 내 몫 |
| 사용자가 보는 범위 | 워커 노드와 워크로드 | 구성 전체를 통제 |
| CKA | 묻지 않음 | 묻는 쪽. 이 장과 다음 장이 kubeadm 기준 |

직접 설치 쪽에도 두 갈래가 있습니다. kubeadm처럼 구성요소만 올려 주는 도구가 있고 kOps나 OpenShift처럼 VM 준비부터 클러스터 구성까지 묶어 주는 배포판(턴키 방식)이 있습니다. 어느 쪽이든 설치가 끝난 뒤 OS 패치, 쿠버네티스 업그레이드, etcd 백업은 내 몫입니다.

#### 4. 숫자와 설계 원칙
- 공식 문서("Considerations for large clusters")의 기준은 클러스터 하나에 노드 5,000대, Pod 150,000개, 컨테이너 300,000개, 노드당 Pod 110개입니다. 숫자를 외울 필요는 없고 노드당 110개가 kubelet `maxPods` 기본값과 같다는 정도만 기억합니다.
- **컨트롤 플레인 노드에 사용자 Pod를 올리지 않습니다.** 사용자 Pod가 메모리를 다 쓰면 API 서버와 etcd가 같이 죽으니 kubeadm은 컨트롤 플레인 노드에 `NoSchedule` 테인트를 붙입니다(3-4절).
- **큰 클러스터에서는 etcd를 별도 노드로 뺍니다.** etcd는 디스크 쓰기 지연에 민감해서 다른 구성요소와 디스크를 다투면 클러스터 전체가 느려집니다(5-1절 external etcd).
- **스토리지는 워크로드에 맞춰 고릅니다.** DB처럼 입출력이 많은 워크로드에는 SSD 기반 볼륨을 쓰고 여러 Pod가 같은 데이터를 동시에 써야 하면(`ReadWriteMany`) NFS 같은 네트워크 스토리지를 씁니다. 종류별로 StorageClass를 만들어 두면 PVC가 필요한 종류를 골라 동적으로 받습니다([8편](/blog/cert/cka/cka-05-storage)).
- **컨트롤 플레인 크기는 노드 수를 따라갑니다.** 관리형 서비스는 노드가 늘면 컨트롤 플레인 자원을 사업자가 맞춰 주고 직접 운영하면 그 산정도 내 몫입니다.

#### 5. 내 PC에 실습 기계 만들기
- **리눅스 PC**: 구성요소 바이너리를 직접 깔아 클러스터를 꾸릴 수도 있습니다. 다만 인증서와 설정을 하나씩 맞춰야 해서 보통 kind, minikube 같은 도구를 쓰거나 VM을 만들어 kubeadm을 올립니다.
- **Windows PC**: Docker Desktop은 리눅스 컨테이너를 WSL 2나 Docker VMM 위에서 돌리고 Hyper-V는 전체 사용자 설치에서만 고를 수 있습니다(Docker Desktop 설치 문서). Docker Desktop의 쿠버네티스도 그 위의 Docker 컨테이너로 돕니다.
- **VM 여러 대**: VirtualBox가 VM을 실제로 돌리고 Vagrant가 `Vagrantfile`에 적힌 사양대로 VM을 한꺼번에 만듭니다. 설치 순서, `Vagrantfile` 예시, `vagrant` 명령은 [10편 홈 랩 구성](/blog/cert/cka/cka-07-resources-and-exam-day#4-홈-랩-구성)에 모아 두었습니다.

> **정리**: 용도와 운영 주체가 도구를 정하고 시험은 kubeadm 직접 설치를 묻습니다. 컨트롤 플레인 격리와 etcd 분리라는 두 원칙은 이 장 뒤에서 다시 나옵니다.

</details>

커리큘럼 문구는 "Prepare underlying infrastructure for installing a Kubernetes cluster"입니다. "Installing kubeadm"과 "Container Runtimes" 문서의 사전 조건이 체크리스트입니다.

### 2-1. 기계 조건

머신당 메모리 2GB 이상, 컨트롤 플레인은 CPU 2개 이상, 머신 사이 전체 연결과 필요한 포트 개방(`nc 127.0.0.1 6443 -zv -w 2`)이 조건입니다. 호스트 이름, MAC 주소, `product_uuid`(`/sys/class/dmi/id/product_uuid`)는 노드마다 달라야 합니다.

CPU와 메모리 조건은 `kubeadm init`이 시작할 때 사전 점검(preflight)으로 확인합니다. 1코어 VM에서 돌리면 `[ERROR NumCPU]`로 멈추고 연습용이라면 `--ignore-preflight-errors=NumCPU`로 넘길 수 있습니다. 고유값 조건은 VM을 복제해 노드를 늘릴 때 걸립니다. 쿠버네티스는 이 값으로 노드를 구별합니다. 설치 문서 기준으로 이미지 하나를 복사한 VM 세 대는 `product_uuid`나 MAC이 같을 수 있고 그러면 설치가 실패할 수 있습니다. 복제한 VM이라면 `ip link`와 `cat /sys/class/dmi/id/product_uuid`를 노드마다 찍어 비교해 봅니다.

### 2-2. 스왑

kubelet은 기본 설정에서 스왑이 켜져 있으면 시작하지 않습니다. `sudo swapoff -a`로 끄고 `/etc/fstab`의 스왑 줄도 지웁니다. 허용하려면 kubelet 설정에 `failSwapOn: false`를 넣습니다.

왜 끄라고 하는지는 메모리 계산을 생각하면 보입니다. Pod에 `limits.memory: 512Mi`를 줬는데 그 일부가 디스크로 밀려나면 Pod가 실제로 얼마를 쓰는지, 노드에 메모리가 얼마 남았는지를 kubelet과 스케줄러가 예측하기 어려워집니다. 노드 스왑 KEP(2400)이 그동안 스왑을 지원하지 않은 이유로 드는 것도 같은 점입니다. 스왑이 끼면 Pod 메모리 사용량을 보장하고 계산하기 어렵습니다. 또 `failSwapOn: false`만 넣으면 kubelet이 뜨기만 할 뿐 Pod는 여전히 스왑을 못 씁니다. 기본 `swapBehavior`가 `NoSwap`이라서 Pod가 스왑을 쓰게 하려면 `memorySwap.swapBehavior: LimitedSwap`을 따로 줘야 합니다(설치 문서). `/etc/fstab` 줄을 안 지우면 재부팅 뒤 스왑이 다시 켜지고 kubelet이 안 떠서 노드가 `NotReady`가 됩니다.

### 2-3. IP 포워딩과 커널 설정

<details>
<summary>기초부터: 스위치, 라우터, 게이트웨이와 ip_forward</summary>

> **핵심 한 줄**: 쿠버네티스 노드는 사실상 라우터라서 한쪽 인터페이스로 받은 패킷을 다른 쪽으로 넘겨 주는 `net.ipv4.ip_forward = 1`이 켜져 있어야 합니다.

#### 1. 왜 필요한가
리눅스 서버에 인터페이스가 두 개 있다고 해서 한쪽에서 받은 패킷을 다른 쪽으로 넘겨 주지는 않습니다. 보안상 기본값이 꺼져 있기 때문입니다. 그런데 Pod 하나하나는 노드 안의 가상 인터페이스(veth) 뒤에 있고 다른 노드의 Pod로 가는 패킷은 노드가 받아 `eth0`으로 넘겨야 합니다. 그래서 Container Runtimes 문서가 공통 사전 준비로 이 값 하나를 요구합니다.

#### 2. 네트워크 기초 네 가지
1. **같은 네트워크 안(스위치)**: 컴퓨터 두 대가 같은 대역(예: `192.168.1.0/24`)에 있으면 스위치에 꽂는 것만으로 통신합니다. 각 컴퓨터에는 인터페이스(`eth0` 같은 랜카드, `ip link`로 확인)와 그 인터페이스에 붙은 IP(`ip addr`로 확인)가 있어야 합니다.
2. **다른 네트워크로(라우터, 게이트웨이)**: 목적지가 `192.168.2.5`처럼 다른 대역이면 스위치로는 못 갑니다. 두 대역 모두에 다리를 걸친 라우터를 거쳐야 하고 내 쪽에서 본 라우터의 주소가 게이트웨이입니다.
3. **라우팅 테이블**: 커널이 패킷을 내보낼 때 보는 표입니다. "이 대역은 이 게이트웨이로"를 줄마다 적습니다. `ip route`로 보고 `ip route add 192.168.2.0/24 via 192.168.1.1`로 더합니다. 통신은 왕복이라 상대 쪽에도 돌아오는 경로가 있어야 응답이 옵니다.
4. **기본 게이트웨이**: 인터넷의 모든 대역을 표에 적을 수는 없으니 "표에 없는 목적지는 전부 여기로"를 한 줄 둡니다. `ip route`에 `default via ...`로 보이는 줄입니다.

```bash
ip route
# default via 192.168.1.1 dev eth0
# 192.168.1.0/24 dev eth0 proto kernel scope link src 192.168.1.10
# 10.244.1.0/24 via 192.168.1.11 dev eth0      ← CNI가 넣은 다른 노드의 Pod 대역 경로(예)
```

```text
노드 A의 Pod(10.244.0.5) → veth → 노드 A 커널 [ip_forward=1이면 넘김] → eth0
  → 노드 B(192.168.1.11) eth0 → 노드 B 커널 [넘김] → veth → 노드 B의 Pod(10.244.1.7)
```

Service로 들어온 패킷도 노드 커널이 목적지를 Pod IP로 바꿔 넘깁니다.

#### 3. 한눈에 비교
| 장치 | 연결 범위 | 리눅스에서 보는 법 |
|---|---|---|
| 스위치 | 같은 대역 | `ip link`, `ip addr` |
| 라우터 | 다른 대역 사이 | `ip route`의 `via` |
| 기본 게이트웨이 | 표에 없는 모든 목적지 | `ip route`의 `default via` |
| `ip_forward` | 이 서버가 라우터 노릇을 할지 | `sysctl net.ipv4.ip_forward` |

#### 4. 실전에서 보이는 모습
- 포워딩이 꺼져 있으면 넘겨 주기가 막혀 Pod 사이 통신이 끊깁니다.
- `/proc/sys/net/ipv4/ip_forward`에 1을 쓰면 바로 켜지지만 재부팅하면 사라지니 위 본문처럼 `/etc/sysctl.d/`에 파일로 둡니다.
- kubeadm은 preflight에서 이 값을 확인하고 0이면 `/proc/sys/net/ipv4/ip_forward contents are not set to 1` 오류로 멈춥니다.

> **정리**: 같은 대역은 스위치, 다른 대역은 라우터와 게이트웨이로 갑니다. 노드는 Pod 대역 사이의 라우터라서 `ip_forward`가 켜져 있어야 하고 Pod 네트워크 안의 라우팅은 [7편](/blog/cert/cka/cka-04-services-networking)과 [Service와 iptables 글](/blog/theory/systems/k8s-linux-05-service-iptables-conntrack)에서 이어집니다.

</details>

```bash
cat <<EOF | sudo tee /etc/sysctl.d/k8s.conf
net.ipv4.ip_forward = 1
EOF
sudo sysctl --system
sysctl net.ipv4.ip_forward   # 1이면 적용됨
```

현재 Container Runtimes 문서는 공통 사전 준비로 `net.ipv4.ip_forward` 하나만 요구하고 다른 sysctl이나 커널 모듈은 쓰는 네트워크 구현의 문서를 따르라고 합니다. 예전 문서에 있던 `overlay`, `br_netfilter` 모듈 단계는 지금 공통 절차에 없습니다. 과제나 CNI 문서가 모듈이나 다른 sysctl을 더 요구하면 `/etc/modules-load.d/`, `/etc/sysctl.d/`에 파일로 적고 `modprobe`, `sysctl --system`으로 적용해 재부팅 뒤에도 유지되게 합니다.

### 2-4. 컨테이너 런타임과 cgroup 드라이버

cgroup은 프로세스 묶음마다 CPU와 메모리 한도를 거는 커널 기능이고 cgroup 드라이버는 "그 cgroup 디렉터리를 누가 만들고 관리하나"를 정하는 방식입니다. `cgroupfs`는 kubelet이나 런타임이 `/sys/fs/cgroup`을 직접 만지고 `systemd`는 systemd에게 부탁해서 만듭니다. systemd는 원래 서비스마다 cgroup을 하나씩 만들어 관리하는데 kubelet이 `cgroupfs`로 따로 만지면 관리자가 둘이 됩니다. 런타임 문서 기준으로 이러면 사용 가능한 자원과 사용 중인 자원을 보는 시각이 둘로 갈리고 자원이 부족할 때 노드가 불안정해질 수 있습니다. 장부를 두 사람이 따로 쓰는 상황입니다.

그래서 kubelet과 런타임은 같은 cgroup 드라이버를 써야 하고 systemd가 init인 시스템(대부분의 배포판)에서는 `systemd` 드라이버를 씁니다. containerd는 `config.toml`의 runc 옵션에 `SystemdCgroup = true`를, kubelet은 `KubeletConfiguration`에 `cgroupDriver: systemd`를 넣습니다.

버전에 따라 달라지는 사실도 챙겨 둡니다.

- 1.34부터 kubelet은 드라이버를 런타임에 묻고 자기 설정의 `cgroupDriver`를 무시합니다(`KubeletCgroupDriverFromCRI`). containerd 2.x 노드라면 containerd의 `SystemdCgroup` 값부터 봅니다.
- 1.35부터 kubelet은 cgroup v1 노드에서 기본으로 시작하지 않습니다(`failCgroupV1: true`).
- 1.35가 containerd 1.x를 지원하는 마지막 버전입니다. containerd 호환표 기준 1.37 노드는 containerd 2.3 이상이고 containerd 1.7은 2026-09-30에 지원이 끝났습니다.

cgroup 내부 동작은 [쿠버네티스 아래의 리눅스 3편](/blog/theory/systems/k8s-linux-03-cgroup-qos)에 있습니다.

### 2-4b. 런타임 패키지 설치: containerd와 cri-dockerd

순서는 패키지 설치, 설정 확인, `enable --now`, 소켓 확인, kubeadm에 소켓 경로 지정입니다.

```bash
sudo dpkg -i ./containerd.io_<버전>_amd64.deb      # 또는 sudo apt-get install ./<파일>.deb
sudo mkdir -p /etc/containerd
containerd config default | sudo tee /etc/containerd/config.toml > /dev/null
sudo sed -i 's/SystemdCgroup = false/SystemdCgroup = true/' /etc/containerd/config.toml
sudo systemctl daemon-reload
sudo systemctl enable --now containerd
sudo systemctl restart containerd
ls -l /run/containerd/containerd.sock
```

`containerd config default`가 설치된 버전에 맞는 형식으로 파일을 만드니 그 파일의 `SystemdCgroup` 줄만 바꿉니다. 기본값은 모두 `false`입니다.

| containerd | 첫 줄 `version` | `SystemdCgroup`이 있는 섹션 |
|---|---|---|
| 1.7 | 2 | `[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options]` |
| 2.0 | 3 | `[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.runc.options]` |
| 2.3, 2.4 | 4 | 2.0과 같음 |

패키지가 넣은 설정 파일은 `disabled_plugins`에 `cri`가 들어 있을 수 있어 기본 설정으로 다시 만듭니다. cri-dockerd는 Docker Engine을 CRI로 감싸는 어댑터이고 Docker Engine이 먼저 돌고 있어야 합니다.

```bash
sudo dpkg -i ./cri-dockerd_<버전>.<배포판>_amd64.deb
sudo systemctl daemon-reload
sudo systemctl enable --now cri-docker.socket cri-docker.service
systemctl is-enabled cri-docker.socket            # enabled여야 재부팅 뒤에도 뜸
ls -l /run/cri-dockerd.sock
```

`start`만 하면 재부팅 뒤 서비스가 올라오지 않습니다. Docker를 설치하면 containerd도 함께 깔리고 `--cri-socket` 없이 `kubeadm init`, `join`, `reset`을 실행하면 이 오류로 멈춥니다.

```text
found multiple CRI endpoints on the host. Please define which one do you wish to use by setting the 'criSocket' field in the kubeadm configuration file: unix:///var/run/containerd/containerd.sock, unix:///var/run/cri-dockerd.sock
```

| 런타임 | `--cri-socket` 값 |
|---|---|
| containerd | `unix:///var/run/containerd/containerd.sock` |
| CRI-O | `unix:///var/run/crio/crio.sock` |
| Docker Engine(cri-dockerd) | `unix:///var/run/cri-dockerd.sock` |

값은 `kubeadm init`, `join`, `reset`의 `--cri-socket`과 `crictl --runtime-endpoint`에 똑같이 넣습니다. `/var/run`은 대부분 `/run`을 가리키는 링크라 두 경로는 같은 파일입니다.

### 2-5. kubeadm, kubelet, kubectl 패키지

<details>
<summary>기초부터: pkgs.k8s.io 저장소 등록부터 버전 고정까지</summary>

> **핵심 한 줄**: 서명 키를 받고 마이너 버전이 박힌 저장소 주소를 등록하고 세 패키지를 설치한 뒤 `hold`로 묶습니다. 모든 노드에서 같은 순서입니다.

#### 1. 왜 필요한가
kubeadm은 kubelet과 kubectl을 대신 설치하거나 관리하지 않습니다. 세 패키지를 노드마다 직접 깔고 버전을 컨트롤 플레인에 맞춰 둬야 합니다. 저장소 하나에는 마이너 버전 하나의 패키지만 있어서 주소를 잘못 적으면 엉뚱한 버전이 깔립니다.

#### 2. 어떻게 하나(Installing kubeadm 문서, Debian/Ubuntu)
```bash
sudo apt-get update
sudo apt-get install -y apt-transport-https ca-certificates curl gpg
sudo mkdir -p -m 755 /etc/apt/keyrings      # Debian 12, Ubuntu 22.04보다 오래된 배포판에는 없음
curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.37/deb/Release.key | \
  sudo gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg
echo 'deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v1.37/deb/ /' | \
  sudo tee /etc/apt/sources.list.d/kubernetes.list
sudo apt-get update
sudo apt-get install -y kubelet kubeadm kubectl
sudo apt-mark hold kubelet kubeadm kubectl
kubeadm version                              # 설치된 버전 확인
```

| 단계 | 하는 일 |
|---|---|
| 키 받기 | 저장소 패키지의 서명을 확인할 공개 키. 모든 저장소가 같은 키라 URL의 버전은 상관없음 |
| 저장소 등록 | URL의 `v1.37`이 설치될 마이너 버전. 다른 버전이면 이 부분을 바꿈 |
| `apt-mark hold` | `apt-get upgrade`가 세 패키지를 몰래 올리지 않게 묶음 |

#### 3. 헷갈리는 점
- 강의 자료는 `v1.31` 경로를 씁니다. 명령 모양은 같고 URL의 버전만 다릅니다.
- `tee`는 `kubernetes.list`를 덮어씁니다. 그래서 업그레이드할 때 이 파일의 버전을 바꿉니다(4-2절).

> **정리**: 깔리는 마이너 버전은 저장소 URL의 `v1.37` 부분이 정하니 업그레이드 때는 이 줄부터 고칩니다. 설치 직후 kubelet이 재시작을 반복하는 것은 init 전의 정상 상태입니다.

</details>

저장소는 `pkgs.k8s.io`이고 마이너 버전마다 경로가 다릅니다(`.../core:/stable:/v1.37/deb/`). 예전 `apt.kubernetes.io`는 동결되었습니다. 설치 뒤 `apt-mark hold`로 버전을 고정합니다.

```bash
sudo apt-mark hold kubelet kubeadm kubectl
sudo systemctl enable --now kubelet
```

이 시점의 kubelet은 kubeadm이 설정을 줄 때까지 10초마다 재시작하는데 이것이 정상입니다. kubeadm 1.36, 1.37 패키지는 `cri-tools`에 의존하지 않아 `crictl`이 없을 수 있습니다. 같은 저장소의 `cri-tools`를 깔고 `/etc/crictl.yaml`에 `runtime-endpoint: unix:///run/containerd/containerd.sock`를 적습니다.

### 2-6. 직접 해 보기

VM 두 대에서 `swapon --show`, `sysctl net.ipv4.ip_forward`, `stat -fc %T /sys/fs/cgroup`(`cgroup2fs`면 v2), `product_uuid`를 확인합니다. 한 대에는 containerd를, 다른 한 대에는 Docker Engine과 cri-dockerd를 넣고 `--cri-socket` 없이 `kubeadm init --dry-run`을 실행해 위 오류를 봅니다. 재부팅 뒤 런타임이 스스로 올라오는지도 확인합니다.

## 3. kubeadm으로 클러스터 생성과 관리

<details>
<summary>기초부터: kubeadm이 대신해 주는 일과 설치 다섯 단계</summary>

> **핵심 한 줄**: kubeadm은 인증서, kubeconfig, static Pod 매니페스트를 커뮤니티 표준 구성으로 만들어 컨트롤 플레인 설치를 명령 몇 개로 줄이는 공식 도구입니다.

#### 1. 왜 필요한가
| 구분 | 손으로 설치 | kubeadm |
|---|---|---|
| CA와 인증서 | 스무 개 가까이 직접 생성 | `certs` 단계가 생성 |
| 구성요소 kubeconfig, 플래그 | 하나씩 쓰고 맞춤 | 표준 구성으로 작성 |
| 노드 붙이기 | 신뢰 관계를 직접 맺음 | `kubeadm join` |
| 실패 위험 | 하나만 틀려도 구성요소끼리 TLS 연결 실패 | 표준값이라 줄어듦 |

kubeadm이 하지 않는 일도 있습니다. VM을 만들거나 컨테이너 런타임을 설치하거나 CNI를 고르지 않습니다.

#### 2. 설치 다섯 단계
1. **기계 준비**: 리눅스 머신 여러 대를 만들고 컨트롤 플레인과 워커 역할을 정합니다(2장의 사전 조건).
2. **모든 노드에 설치**: 컨테이너 런타임(containerd 등)과 kubeadm, kubelet, kubectl을 설치합니다. 쿠버네티스는 컨테이너를 직접 띄우지 못하고 CRI 런타임이 있어야 Pod를 실행합니다.
3. **첫 컨트롤 플레인에서 `kubeadm init`**: 아래 표의 순서로 컨트롤 플레인을 세웁니다.
4. **CNI 설치**: Pod끼리 노드를 넘어 통신하게 하는 네트워크 플러그인을 `kubectl apply`로 넣습니다.
5. **워커에서 `kubeadm join`**: init 출력의 join 명령으로 워커를 붙입니다.

`kubeadm init`이 하는 일을 순서대로 보면 1장과 4편에서 본 파일들이 어디서 왔는지 보입니다(Implementation details 문서 기준).

| 순서 | 하는 일 | 결과물 |
|---|---|---|
| preflight | 스왑, 포트, 런타임, 권한 점검 | 실패하면 여기서 멈춤 |
| certs | 클러스터 CA, etcd CA, front-proxy CA와 각 인증서 생성 | `/etc/kubernetes/pki/` |
| kubeconfig | 관리자, 컨트롤러 매니저, 스케줄러, kubelet용 kubeconfig | `/etc/kubernetes/*.conf` |
| control-plane, etcd | 네 구성요소의 static Pod 매니페스트 작성 | `/etc/kubernetes/manifests/` |
| 대기 | kubelet이 매니페스트로 Pod를 띄우고 API 서버가 응답할 때까지 | |
| upload-config | 클러스터 설정을 ConfigMap으로 저장 | `kubeadm-config`, `kubelet-config` |
| mark-control-plane | 컨트롤 플레인 라벨과 `NoSchedule` 테인트 | |
| bootstrap-token | 워커가 붙을 때 쓸 토큰 생성 | `kubeadm token list` |
| addons | CoreDNS Deployment, kube-proxy DaemonSet | `kube-system` |

#### 3. join이 맺는 두 방향의 신뢰
```text
워커 ──(--discovery-token-ca-cert-hash)──> "받은 CA가 진짜 이 클러스터의 CA인가?" 해시로 확인
컨트롤 플레인 ──(--token)──> "이 워커가 초대받은 노드인가?" 확인
→ 워커 kubelet이 CSR로 자기 클라이언트 인증서를 받음 → 정식 노드로 등록
```

#### 4. 실전에서 보이는 모습
- CNI를 넣기 전까지 노드는 `NotReady`이고 CoreDNS는 `Pending`입니다(3-2절).
- VM에 인터페이스가 둘 이상이면(예: NAT용 `eth0`과 VM끼리 쓰는 사설망 `enp0s8`) kubeadm은 기본 게이트웨이가 걸린 인터페이스의 주소를 API 서버 광고 주소로 고릅니다. 워커가 그 주소로 닿지 못하면 join이 실패하니 init에 `--apiserver-advertise-address=<사설망 IP>`를 줍니다.
- init이 끝나면 출력 안내대로 `/etc/kubernetes/admin.conf`를 `$HOME/.kube/config`로 복사하고 소유자를 바꿔야 일반 사용자로 kubectl을 쓸 수 있습니다.
- 부트스트랩 토큰은 기본 24시간 뒤 만료됩니다. init 출력의 join 명령을 잃었거나 토큰이 만료됐다면 컨트롤 플레인에서 `kubeadm token create --print-join-command`로 새 join 명령을 받습니다.

#### 5. 강의 실습 흐름을 명령으로
노드 IP는 컨트롤 플레인 `192.168.56.11`, 워커 `192.168.56.21`, `192.168.56.22`이고 CNI는 Flannel인 구성입니다.

```bash
# 컨트롤 플레인에서
sudo kubeadm init --apiserver-advertise-address=192.168.56.11 --pod-network-cidr=10.244.0.0/16
mkdir -p $HOME/.kube
sudo cp -i /etc/kubernetes/admin.conf $HOME/.kube/config
sudo chown $(id -u):$(id -g) $HOME/.kube/config
kubectl get nodes                       # CNI 전이라 NotReady

kubectl apply -f https://github.com/flannel-io/flannel/releases/latest/download/kube-flannel.yml
kubectl get pods -n kube-flannel        # 노드마다 flannel Pod 하나
kubectl get nodes                       # Ready로 바뀜

# 워커 두 대에서 init 출력의 join 명령 실행 뒤, 다시 컨트롤 플레인에서
kubectl get nodes                       # 세 대 모두 Ready
kubectl run web --image=nginx           # 시험용 Pod
kubectl get pods -w                     # Running까지 지켜봄(Ctrl+C로 빠져나옴)
kubectl delete pod web
```

- Flannel 매니페스트의 기본 Pod 대역이 `10.244.0.0/16`이라 init에 같은 값을 줍니다. 다른 대역을 쓰려면 매니페스트를 받아 `net-conf.json`의 `Network` 값을 고친 뒤 적용합니다(Flannel README).
- Flannel Pod는 `kube-system`이 아닌 `kube-flannel` 네임스페이스에 뜹니다.

> **정리**: init 직후 노드가 `NotReady`인 것은 CNI를 기다리는 상태입니다. join이 실패하면 API 서버 광고 주소와 토큰 만료부터 보고 인터페이스가 둘인 VM이라면 init에 `--apiserver-advertise-address`를 직접 줍니다.

</details>

커리큘럼 문구는 "Create and manage Kubernetes clusters using kubeadm"입니다.

### 3-1. kubeadm init

```bash
sudo kubeadm init \
  --control-plane-endpoint=cluster-endpoint:6443 \
  --pod-network-cidr=10.244.0.0/16
```

옵션마다 "왜 여기서 정해야 하나"가 있습니다.

| 옵션 | 뜻 | 안 정하면 생기는 일 |
|---|---|---|
| `--control-plane-endpoint` | 모든 노드와 kubeconfig가 API 서버를 부를 주소. 보통 LB나 DNS 이름 | 첫 노드 IP가 인증서와 kubeconfig 곳곳에 박혀 나중에 HA로 늘리지 못함 |
| `--pod-network-cidr` | Pod IP를 나눠 줄 대역. Flannel 기본값이 `10.244.0.0/16` | 노드가 쓰는 사설망과 겹치면 Pod가 같은 대역의 실제 서버로 가는 패킷을 자기 쪽으로 착각해 통신이 깨짐 |
| `--apiserver-advertise-address` | 이 API 서버가 "나는 이 IP로 받는다"고 다른 구성요소에 알리는 주소 | 기본 경로가 걸린 NIC의 IP를 씀. VM에 NIC가 둘(NAT용, 노드 간 통신용)이면 엉뚱한 NAT 주소가 잡혀 워커가 못 붙음 |
| `--cri-socket` | 런타임 소켓 | 소켓이 둘 이상이면 2-4b절 오류로 멈춤 |

첫 줄은 이렇게 생각하면 됩니다. kubeadm은 API 서버 인증서의 SAN(이 인증서가 유효한 이름 목록)과 모든 kubeconfig의 `server:`에 엔드포인트를 적습니다. 처음에 노드 IP로 만들면 그 IP가 사라지거나 LB로 바꾸고 싶을 때 인증서와 kubeconfig를 전부 다시 만들어야 합니다. DNS 이름(`cluster-endpoint`)으로 만들어 두면 이름이 가리키는 곳만 LB로 바꾸면 됩니다. `--config` 설정 파일로 init하면 파일의 `apiVersion`은 `kubeadm.k8s.io/v1beta4`입니다. `v1beta3`은 1.37에서 제거됐고 옛 파일은 1.35 kubeadm의 `kubeadm config migrate`로 바꿉니다(CHANGELOG-1.37).

`init`이 끝나면 `admin.conf`를 `$HOME/.kube/config`로 복사하는 명령과 `kubeadm join` 명령이 출력됩니다.

### 3-2. CoreDNS는 CNI 설치 뒤에 시작

`init` 직후 노드가 `NotReady`이고 CoreDNS가 `Pending`인 것은 CNI를 기다리는 정상 상태입니다. 노드 조건 메시지는 이런 모양입니다.

```text
container runtime network not ready: NetworkReady=false reason:NetworkPluginNotReady message:Network plugin returns error: cni plugin not initialized
```

### 3-3. 노드 조인과 토큰

```bash
# 워커 노드에서
sudo kubeadm join <컨트롤플레인 주소>:6443 --token <토큰> \
  --discovery-token-ca-cert-hash sha256:<해시>

# 토큰이 만료됐거나 출력을 잃어버렸을 때 컨트롤 플레인에서
kubeadm token list
kubeadm token create --print-join-command
```

토큰 기본 TTL은 24시간이라 하루 지난 init 출력의 join 명령은 실패합니다.

### 3-4. 컨트롤 플레인 테인트와 노드 제거

kubeadm은 컨트롤 플레인 노드에 `node-role.kubernetes.io/control-plane:NoSchedule` 테인트를 붙입니다. 노드 한 대로 연습할 때는 지웁니다.

```bash
kubectl taint nodes --all node-role.kubernetes.io/control-plane-

# 노드 빼기
kubectl drain <노드> --delete-emptydir-data --force --ignore-daemonsets
sudo kubeadm reset          # 해당 노드에서
kubectl delete node <노드>
```

`kubeadm reset`은 iptables 규칙, IPVS 테이블, `$HOME/.kube/config`를 지우지 않으니 같은 노드를 다시 쓰려면 직접 지웁니다.

### 3-4b. 만든 뒤 설정 바꾸기: kubeadm-config와 kubelet-config

kubeadm은 이미 배포된 구성요소를 자동으로 재설정하지 않습니다("Reconfiguring a kubeadm cluster"). 클러스터 쪽 원본과 노드 쪽 파일을 각각 고칩니다.

| 대상 | 클러스터 쪽 원본 | 노드 쪽 반영 |
|---|---|---|
| `ClusterConfiguration` | `kube-system` ConfigMap `kubeadm-config` | 컨트롤 플레인의 `/etc/kubernetes/manifests/*.yaml` 수정 |
| `KubeletConfiguration` | ConfigMap `kubelet-config` | 노드마다 `kubeadm upgrade node phase kubelet-config` 후 `systemctl restart kubelet` |
| `KubeProxyConfiguration` | ConfigMap `kube-proxy` | kube-proxy Pod 재생성 |

```bash
kubectl -n kube-system edit cm kubelet-config
sudo kubeadm upgrade node phase kubelet-config     # 노드에서
sudo systemctl restart kubelet
```

ConfigMap 안의 설정은 YAML 문자열이라 저장할 때 검증이 없습니다. `kubeadm upgrade`는 `kubeadm-config`로 static Pod 매니페스트를, `kubelet-config`로 `/var/lib/kubelet/config.yaml`을 다시 만듭니다. 그래서 매니페스트에만 넣은 `--event-ttl=2h` 같은 플래그는 `upgrade apply` 뒤 사라집니다([Reconfiguring a kubeadm cluster](https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/kubeadm-reconfigure/)). "API 서버에 플래그를 더하라"는 과제라면 매니페스트를 고쳐 바로 반영하고 유지가 필요하면 `kubeadm-config`의 `extraArgs`(v1beta4는 `- name: ...` / `value: ...` 목록)에도 넣습니다.

### 3-5. 직접 해 보기

컨트롤 플레인 1대와 워커 1대로 클러스터를 만들고 join 명령을 `kubeadm token create --print-join-command`로 다시 만들어 붙입니다. `kubelet-config`에 `maxPods: 50`을 넣고 워커에서 `kubeadm upgrade node phase kubelet-config`와 kubelet 재시작을 한 뒤 `kubectl get node <워커> -o jsonpath='{.status.capacity.pods}'`가 50인지 봅니다. 워커 파일만 70으로 바꾼 값은 `kubeadm upgrade node` 뒤 50으로 돌아갑니다.

## 4. 클러스터 수명주기: 업그레이드, 인증서, etcd

커리큘럼 문구는 "Manage the lifecycle of Kubernetes clusters"이고 개정 전의 업그레이드, etcd 백업 문구는 빠졌습니다. 후기도 엇갈립니다. Domenic Cassisi(2026)는 etcd 과제가 빠졌다고 적었고 Talha Juikar(2026)는 etcd 명령과 kubeadm 플래그에서 시간을 썼다고 적었습니다. 절차와 함정만 짧게 외워 둡니다.

### 4-1. 버전 차이 규칙

<details>
<summary>기초부터: 버전 번호 읽기와 alpha, beta, GA</summary>

> **핵심 한 줄**: `v1.37.2`는 메이저.마이너.패치이고 새 기능은 alpha, beta, GA 세 단계를 거쳐 기본으로 켜집니다.

#### 1. 왜 필요한가
블로그 곳곳의 "1.33 GA", "1.35 deprecated" 같은 표기와 업그레이드 규칙은 모두 이 버전 체계 위에 서 있습니다. 1년 넘게 업그레이드를 미루면 보안 패치가 끊긴 버전에 남게 된다는 점도 여기서 나옵니다.

#### 2. 버전 번호 읽기
| 자리 | 예 | 뜻 |
|---|---|---|
| 메이저 | 1 | 2015년 1.0 이후 그대로 |
| 마이너 | 37 | 새 기능이 들어오는 릴리스. 대략 1년에 세 번 |
| 패치 | 2 | 버그와 보안 수정. 대략 매달 |

- 프로젝트는 최근 세 마이너의 릴리스 브랜치를 유지하고 1.19 이후 마이너 하나는 약 1년 동안 패치를 받습니다(Version Skew Policy 문서).
- etcd, CoreDNS, containerd는 쿠버네티스와 별개 프로젝트라 버전 번호가 다르고 kubeadm이 그 쿠버네티스 버전에 맞는 etcd와 CoreDNS 버전을 골라 줍니다.
- 반대로 kube-apiserver, kube-controller-manager, kube-scheduler, kubelet, kube-proxy, kubectl은 한 릴리스로 함께 나와 같은 버전 번호를 씁니다. kubeadm이 고른 조합은 `kubeadm config images list`로 확인합니다. 컨트롤 플레인 이미지는 쿠버네티스 버전 그대로, etcd와 CoreDNS 이미지는 각자의 버전으로 찍혀 나옵니다. 이 조합을 임의로 바꾸지 않는 것이 안전합니다.

#### 3. 기능 성숙도 세 단계(Feature Gates 문서)
1. **alpha**: 기본으로 꺼져 있습니다. 쓰려면 구성요소의 `--feature-gates=<기능>=true`로 켭니다. 다음 릴리스에서 동작이 바뀌거나 빠질 수 있습니다.
2. **beta**: 기능 게이트는 대개 기본으로 켜져 있습니다. 다만 1.24부터 새로 들어오는 beta API(새 API 그룹 버전)는 기본으로 꺼져 있어 따로 켜야 합니다.
3. **GA(stable)**: 항상 켜져 있습니다. 몇 릴리스 뒤에는 기능 게이트 자체가 없어지고 끌 수도 없습니다.

```text
alpha(기본 꺼짐) → beta(게이트는 대개 켜짐, 새 beta API는 꺼짐) → GA(항상 켜짐) → 게이트 제거
deprecated: "앞으로 빠질 예정이니 옮겨 가라" → 정해진 기간 뒤 실제 제거
```

#### 4. 헷갈리는 점: 버전 차이 규칙(skew)이 생기는 이유
- 업그레이드는 노드를 한 대씩 바꾸는 과정이라 클러스터 안에 옛 버전과 새 버전이 잠시 섞입니다.
- 섞인 상태에서도 통신이 깨지지 않을 범위를 정한 것이 아래 규칙이고 기준점은 모든 구성요소가 말을 거는 kube-apiserver입니다.
- API 서버보다 새로운 kubelet은 API 서버가 모르는 필드를 보낼 수 있어 허용하지 않습니다.
- 섞인 상태는 `kubectl get nodes`의 VERSION 열에서 노드마다 다른 값으로 보입니다.

> **정리**: 업그레이드 중에는 버전이 섞이고 그 허용 범위는 kube-apiserver를 기준으로 셉니다. kubelet이 API 서버보다 새로우면 안 되니 컨트롤 플레인부터 올립니다. alpha 기능은 기본으로 꺼져 있어 `--feature-gates`로 켭니다.

</details>

버전은 x.y.z(메이저.마이너.패치)이고 건너뛰면 안 되는 단위가 마이너입니다. "Version Skew Policy"에서 시험에 걸리는 규칙입니다.

- 마이너를 건너뛰는 업그레이드는 지원하지 않습니다. 1.35에서 1.37로 가려면 1.36을 거칩니다.
- kubelet은 kube-apiserver보다 새로우면 안 되고 세 마이너까지 오래될 수 있습니다. 그래서 컨트롤 플레인이 먼저입니다.

| 구성요소 | kube-apiserver 1.37일 때 허용 |
|---|---|
| 다른 kube-apiserver(HA) | 1.37, 1.36 |
| kube-controller-manager, kube-scheduler | 1.37, 1.36 |
| kubelet, kube-proxy | 1.37 ~ 1.34 |
| kubectl | 1.38, 1.37, 1.36 |

HA에서 apiserver가 1.37과 1.36으로 섞이면 기준은 1.36이라 노드는 모든 컨트롤 플레인이 끝난 뒤 올립니다.

### 4-2. 업그레이드 순서

<details>
<summary>기초부터: 업그레이드하는 동안 무엇이 멈추고 무엇이 계속 도는지</summary>

> **핵심 한 줄**: 컨트롤 플레인을 올리는 동안에는 관리 기능이 잠시 멈추고 워커를 올리는 동안에는 그 노드의 Pod가 영향을 받으니 "컨트롤 플레인 먼저, 워커는 하나씩"입니다.

#### 1. 왜 필요한가
업그레이드 순서에는 구성요소마다 무엇이 멈추는지가 반영되어 있습니다.

| 올리는 대상 | 멈추는 것 | 계속 도는 것 |
|---|---|---|
| 단일 컨트롤 플레인 | API 서버, 스케줄러, 컨트롤러 매니저가 잠시 내려감. kubectl이 안 되고 죽은 Pod가 다시 만들어지지 않고 새 배포도 안 됨 | 이미 워커에서 도는 Pod는 그대로 요청 처리 |
| HA 컨트롤 플레인 | 한 대씩 올리니 API는 계속 응답 | 전부 |
| 워커 노드 | kubelet을 바꾸는 순간 그 노드 Pod가 영향을 받을 수 있음 | 다른 노드의 Pod |

그래서 워커는 drain으로 Pod를 다른 노드로 옮기고 바꾼 뒤 uncordon으로 돌려놓습니다.

#### 2. 어떻게 진행하나
1. **저장소 경로부터 바꿉니다.** `pkgs.k8s.io` 저장소는 마이너마다 경로가 달라서 바꾸지 않으면 새 버전 패키지가 보이지 않습니다.
2. **kubeadm을 먼저 올립니다.** 업그레이드 계획을 세우고 새 매니페스트를 쓰는 주체가 kubeadm이라 목표 버전의 kubeadm이 있어야 합니다.
3. **`upgrade plan`을 먼저 봅니다.** 지금 버전, 올라갈 수 있는 버전, 구성요소별 변경을 미리 보여 줍니다.
4. **`upgrade apply` 뒤 kubelet, kubectl 패키지를 따로 올립니다.** 그리고 `systemctl restart kubelet`까지 합니다.
5. **`apt-mark hold`로 다시 잠가 둡니다.** 평소 `apt upgrade`에 kubelet이 딸려 올라가 버전 규칙을 깨는 사고를 막습니다. 올릴 때만 `unhold`로 풉니다.

```text
컨트롤 플레인: 저장소 경로 → kubeadm 올림 → upgrade plan → upgrade apply → kubelet/kubectl 올림 → restart kubelet
워커(한 대씩): kubeadm 올림 → upgrade node → drain → kubelet 올림 → restart kubelet → uncordon → 다음 노드
```

#### 3. 한눈에 비교: 워커를 올리는 세 전략
| 전략 | 방법 | 특징 |
|---|---|---|
| 한꺼번에 | 모든 워커를 동시에 | 빠르지만 서비스가 끊김. 테스트 클러스터용 |
| 한 대씩(롤링) | drain → 업그레이드 → uncordon을 노드마다 반복 | 가용성을 유지하는 표준 방법. 시험이 묻는 방식 |
| 새 노드로 교체 | 새 버전 노드를 붙이고 Pod를 옮긴 뒤 옛 노드를 제거 | VM을 쉽게 만드는 클라우드에서 많이 씀 |

#### 4. 헷갈리는 점 / 실전에서 보이는 모습
- kubeadm이 바꾸는 범위를 가장 많이 놓칩니다. `kubeadm upgrade apply`는 static Pod 매니페스트의 이미지 버전, 클러스터 설정, 인증서를 바꿉니다. 노드에 OS 패키지로 깔린 kubelet과 kubectl 바이너리는 건드리지 않습니다.
- 그래서 apply가 성공했는데도 `kubectl get nodes`의 VERSION이 옛 값이면 kubelet 패키지 업그레이드와 재시작을 빠뜨렸다는 신호입니다.

> **정리**: `upgrade apply`가 성공해도 노드의 VERSION은 kubelet 패키지를 올리고 재시작해야 바뀝니다. 시험이 묻는 워커 업그레이드는 drain과 uncordon 사이에서 한 대씩 올리는 롤링 방식입니다.

</details>

"Upgrading kubeadm clusters" 문서의 1.36에서 1.37 절차입니다. 먼저 패키지 저장소 경로를 목표 마이너로 바꿔야 새 버전이 보입니다.

```bash
# 0) 저장소를 v1.37로
sudo sed -i 's/v1.36/v1.37/' /etc/apt/sources.list.d/kubernetes.list
sudo apt-get update
apt-cache madison kubeadm                        # 1.37.x-1.1이 보이는지

# 1) 첫 컨트롤 플레인: kubeadm만 먼저
sudo apt-mark unhold kubeadm && \
sudo apt-get install -y kubeadm='1.37.x-*' && \
sudo apt-mark hold kubeadm

# 2) 계획 확인, 적용
sudo kubeadm upgrade plan
sudo kubeadm upgrade apply v1.37.x
```

1.37 kubeadm의 성공 출력은 문서의 옛 문구(`... Enjoy!`)와 다릅니다.

```text
[upgrade] SUCCESS! A control plane node of your cluster was upgraded to "v1.37.1".
[upgrade] Now please proceed with upgrading the rest of the nodes by following the right order.
```

나머지 컨트롤 플레인과 워커는 kubeadm을 올린 뒤 `upgrade apply` 대신 `sudo kubeadm upgrade node`를 실행합니다(plan과 CNI 업그레이드는 첫 노드에서만). 그 다음 노드마다 kubelet을 교체합니다.

```bash
kubectl drain <노드> --ignore-daemonsets          # kubectl이 되는 곳에서

sudo apt-mark unhold kubelet kubectl && \
sudo apt-get update && sudo apt-get install -y kubelet='1.37.x-*' kubectl='1.37.x-*' && \
sudo apt-mark hold kubelet kubectl
sudo systemctl daemon-reload
sudo systemctl restart kubelet

kubectl uncordon <노드>
```

apt와 kubeadm 명령은 해당 노드에서, drain과 uncordon은 kubectl이 되는 호스트에서 실행합니다. 단독 Pod가 있으면 drain이 `cannot delete Pods that declare no controller (use --force to override)`로 멈춥니다(4-7절).

### 4-3. 업그레이드 실패 시 재실행과 백업 디렉터리

`kubeadm upgrade`는 멱등이라 끊겨도 다시 실행하면 됩니다. kubeadm은 `/etc/kubernetes/tmp` 아래에 `kubeadm-backup-etcd-<시각>`(로컬 etcd 데이터, `/var/lib/etcd`로 복원), `kubeadm-backup-manifests-<시각>`(static Pod 매니페스트, `/etc/kubernetes/manifests`로 복원), `kubeadm-kubelet-config-<시각>`(이전 kubelet 설정)을 남깁니다.

### 4-4. 인증서 만료와 갱신

kubeadm이 만든 인증서는 1년, CA는 10년이 기본입니다. `kubeadm upgrade`는 그 노드의 인증서를 자동으로 갱신하므로 1년 안에 한 번씩 올리면 만료를 피합니다.

```bash
sudo kubeadm certs check-expiration
sudo kubeadm certs renew all
sudo openssl x509 -noout -enddate -in /etc/kubernetes/pki/apiserver.crt
```

- `check-expiration` 목록에 `kubelet.conf`는 없습니다. kubelet 인증서는 `/var/lib/kubelet/pki/`에서 자동 회전되고 `renew all`도 건드리지 않습니다. `renew`는 모든 컨트롤 플레인 노드에서 실행합니다.
- `renew all`은 마지막에 `You must restart the kube-apiserver, kube-controller-manager, kube-scheduler and etcd, so that they can use the new certificates.`를 찍습니다. static Pod는 kubectl로 재시작할 수 없으니 매니페스트를 `/etc/kubernetes/manifests/` 밖으로 옮기고 20초쯤(kubelet `fileCheckFrequency`) 기다렸다가 되돌립니다.
- 갱신되는 파일은 `/etc/kubernetes/admin.conf`이니 `~/.kube/config` 사본은 다시 복사합니다.

만료되면 kubectl은 `x509: certificate has expired or is not yet valid`로 실패하고 만료된 상태에서도 `renew all`은 동작합니다. kubelet 인증서 복구는 [9편](/blog/cert/cka/cka-06-troubleshooting)에 있습니다.

### 4-5. etcd 백업

<details>
<summary>기초부터: 무엇을 백업하는지와 etcdctl 플래그 하나하나의 뜻</summary>

> **핵심 한 줄**: 클러스터 상태는 전부 etcd에 있으니 etcd 스냅샷 하나가 클러스터 기록 전체의 백업이고 etcdctl 플래그는 그 etcd에 mTLS로 붙기 위한 정보입니다.

#### 1. 왜 필요한가
모든 매니페스트를 Git에 두는 선언형 운영이 가장 좋습니다. 그래도 명령형으로 만든 객체나 컨트롤러가 만든 객체가 있으니 클러스터 쪽 백업이 따로 필요합니다. 클러스터 백업에는 두 갈래가 있습니다.

| 방식 | 하는 일 | 쓰는 때 |
|---|---|---|
| 리소스 내보내기 | API 서버에 물어 오브젝트를 YAML로 저장. Velero 같은 도구 | etcd에 접근할 수 없는 관리형 클러스터, 네임스페이스 단위 이전 |
| etcd 스냅샷 | etcd 데이터 전체를 파일 하나로 저장 | 직접 운영하는 kubeadm 클러스터. 시험의 백업 과제 |

`kubectl get all -A -o yaml`은 이름과 달리 ConfigMap, Secret, PVC, RBAC, CRD를 빠뜨려서 백업으로 쓰기에 부족합니다. Velero는 예전 이름이 Heptio Ark였던 도구로 API 서버를 거쳐 리소스를 통째로 받아 두기 때문에 이런 빈틈을 메웁니다.

#### 2. 어떻게 동작하나: 플래그 하나하나
```text
etcdctl ──mTLS──> etcd(127.0.0.1:2379)
  --endpoints   어디로
  --cacert      상대(etcd 서버)가 진짜인지 확인할 CA
  --cert/--key  나는 권한 있는 클라이언트
```

| 플래그 | 뜻 |
|---|---|
| `--endpoints=https://127.0.0.1:2379` | 접속할 etcd. 2379는 클라이언트용 포트, 2380은 멤버끼리 쓰는 피어 포트 |
| `--cacert=.../etcd/ca.crt` | etcd 서버 인증서를 검증할 CA. etcd 전용 CA |
| `--cert=...`, `--key=...` | 내가 권한 있는 클라이언트임을 증명할 인증서와 그 짝인 개인 키 |

#### 3. 한눈에 비교: etcd 관련 인증서(PKI certificates 문서)
| 파일(`/etc/kubernetes/pki/` 아래) | 용도 |
|---|---|
| `etcd/ca.crt`, `etcd/ca.key` | etcd 전용 CA |
| `etcd/server.crt`, `.key` | etcd가 2379에서 내미는 서버 인증서 |
| `etcd/peer.crt`, `.key` | etcd 멤버끼리 2380에서 복제할 때 쓰는 인증서 |
| `etcd/healthcheck-client.crt`, `.key` | 상태 점검과 etcdctl 같은 도구가 etcd에 붙을 때 쓰는 클라이언트 인증서 |
| `apiserver-etcd-client.crt`, `.key` | API 서버가 etcd에 붙는 클라이언트 인증서(`etcd/` 밖에 있음) |

#### 4. 헷갈리는 점
- 본문 예시가 `etcd/server.crt`를 클라이언트 인증서로 쓰는 것은 공식 문서 예시를 따른 것이고 kubeadm이 만든 이 인증서가 클라이언트 용도도 함께 갖고 있어 동작합니다. API 서버 자신은 `server.crt`를 쓰지 않고 `apiserver-etcd-client.crt`로 붙습니다.
- 옛 자료의 `ETCDCTL_API=3`은 etcd 3.3 이전에 기본 API가 v2라서 붙이던 변수입니다. 3.4부터 v3가 기본이라 필요 없습니다.
- 스냅샷 파일의 상태 확인(리비전, 키 수, 크기)과 복구는 etcd 3.6부터 `etcdutl`이 맡습니다. 손상된 파일로 복구를 시도하지 않도록 저장 직후 `snapshot status`로 한 번 봅니다.
- 스냅샷을 얻는 길은 `etcdctl snapshot save` 말고도 둘 더 있습니다(Operating etcd clusters 문서). etcd 프로세스가 쓰지 않는 데이터 디렉터리에서 `member/snap/db` 파일을 복사하는 방법과 etcd가 EBS처럼 스냅샷을 지원하는 볼륨 위에 있으면 그 볼륨을 스냅샷하는 방법입니다. 앞의 방법은 etcd를 멈춰야 하므로 동작 중인 클러스터에는 `snapshot save`를 씁니다.

> **정리**: `--cacert`에는 etcd 전용 CA(`etcd/ca.crt`)를 넣습니다. `kubectl get all`로는 ConfigMap이나 Secret이 빠지니 kubeadm 클러스터의 백업은 etcd 스냅샷으로 뜨고 저장 직후 `etcdutl snapshot status`로 파일이 성한지 봅니다.

</details>

kubeadm 클러스터의 etcd는 컨트롤 플레인의 static Pod이고 데이터 디렉터리는 `/var/lib/etcd`입니다. 스냅샷은 동작 중인 멤버에 접속해 `etcdctl snapshot save`로 뜹니다. 인증서 경로는 매니페스트에서 먼저 확인합니다.

```bash
sudo grep -E 'cert|key|trusted|data-dir|listen-client' /etc/kubernetes/manifests/etcd.yaml

etcdctl --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  snapshot save /opt/backup/etcd-snapshot.db

etcdutl --write-out=table snapshot status /opt/backup/etcd-snapshot.db
```

- `ETCDCTL_API=3`은 필요 없습니다(3.4부터 v3 기본). 붙이면 `unrecognized environment variable` 경고 한 줄 뒤 저장됩니다.
- etcd 3.6에서 `etcdctl snapshot status`와 `restore`가 제거됐고 kubeadm 1.37의 기본 etcd는 3.7.0입니다. 3.7 `etcdctl snapshot`에는 `save`만 있고 `etcdctl snapshot restore --data-dir ...`는 `Error: unknown flag: --data-dir`로 실패합니다.
- `etcdctl`, `etcdutl`은 시험 공식 사전 설치 목록(kubectl, yq, curl, wget, man)에 없습니다. Resources Allowed 문서에 따르면 과제에 필요한 패키지 설치는 요구하지 않으니 etcd 과제가 나오는 호스트라면 `etcdctl`은 있을 가능성이 높지만 `etcdutl`은 근거가 없습니다. 과제 호스트에서 `which etcdctl etcdutl`로 먼저 봅니다.

### 4-6. etcd 복구

<details>
<summary>기초부터: 복구 단계가 그 순서인 이유</summary>

> **핵심 한 줄**: 복구는 "스냅샷 파일을 덮어쓰기"로 끝나지 않고 새 디렉터리에 풀기, etcd가 그곳을 보게 하기, 위 구성요소 재시작, 설정 원본 수정의 네 단계가 각자 다른 문제를 막습니다.

#### 1. 왜 필요한가
etcd 데이터만 과거로 돌리면 옛 멤버 정보, API 서버 캐시, kubeadm 설정이 새 데이터와 어긋납니다. 각 단계가 그 어긋남 하나씩을 막습니다.

#### 2. 어떻게 동작하나
1. **새 데이터 디렉터리에 풉니다.** `etcdutl snapshot restore`는 스냅샷 내용으로 새 데이터 디렉터리를 만들고 멤버 ID와 클러스터 ID도 새로 씁니다. 기존 `/var/lib/etcd`에 섞으면 옛 멤버 정보와 남은 파일이 엉킵니다. 새 경로에 풀면 실패했을 때 원래 디렉터리로 돌아갈 길도 남습니다.
2. **etcd가 새 디렉터리를 보게 합니다.** kubeadm의 etcd는 static Pod라 `etcd.yaml`의 hostPath를 새 경로로 바꾸면 kubelet이 etcd Pod를 다시 만듭니다.
3. **API 서버와 컨트롤러를 다시 띄웁니다.** API 서버는 etcd 데이터를 캐시해 두고 watch로 따라가는데 데이터가 과거 시점으로 돌아가면 캐시와 맞지 않습니다. 공식 문서는 복구 전에 API 서버를 멈추고 복구 뒤 kube-apiserver, kube-controller-manager, kube-scheduler, kubelet을 재시작하라고 권합니다.
4. **클러스터 설정 원본도 고칩니다.** 다음 `kubeadm upgrade`가 `kubeadm-config`의 옛 경로로 매니페스트를 다시 쓰면 복구가 되돌아갑니다.

```text
스냅샷 파일 → etcdutl snapshot restore → 새 디렉터리(새 멤버 ID, 클러스터 ID)
  → etcd.yaml hostPath 변경 → kubelet이 etcd Pod 재생성
  → API 서버, 컨트롤러 매니저, 스케줄러, kubelet 재시작(캐시를 새 데이터에 맞춤)
  → kubeadm-config의 경로도 수정(다음 upgrade 대비)
```

#### 3. 한눈에 비교: 단계별로 막는 문제
| 단계 | 건너뛰면 |
|---|---|
| 새 디렉터리 | 옛 멤버 정보와 남은 파일이 엉키고 되돌아갈 원본도 잃음 |
| hostPath 변경 | etcd가 여전히 옛 데이터를 읽음 |
| 구성요소 재시작 | API 서버 캐시와 etcd 데이터가 맞지 않음. 본문의 실측 함정 1, 2번이 이 증상 |
| `kubeadm-config` 수정 | 다음 `kubeadm upgrade`가 옛 경로로 되돌림 |

#### 4. 헷갈리는 점
- 복구가 돌려주는 범위는 4-5절의 표와 같습니다. 스냅샷 시점 이후에 만든 오브젝트는 사라집니다.
- PV 안의 애플리케이션 데이터는 스냅샷과 관계없이 그대로입니다.

#### 5. etcd를 systemd 서비스로 돌리는 클러스터일 때
kubeadm 밖에서 손으로 세운 클러스터나 external etcd는 etcd가 노드의 systemd 서비스로 돕니다. 이때는 매니페스트 대신 유닛 파일을 고칩니다.

1. **API 서버 멈추기**: kube-apiserver도 서비스라면 `systemctl stop kube-apiserver`로 먼저 멈춥니다.
2. **새 디렉터리에 풀기**: `etcdutl snapshot restore`로 새 경로에 풉니다. 여기까지는 kubeadm과 같습니다.
3. **유닛 파일의 `--data-dir` 바꾸기**: `etcd.service`의 `ExecStart` 줄에서 `--data-dir`를 새 경로로 고칩니다.
4. **systemd에 다시 읽히기**: 유닛 파일을 고친 뒤에는 `systemctl daemon-reload`를 해야 systemd가 바뀐 내용을 압니다. 그다음 `systemctl restart etcd`를 하고 API 서버를 다시 띄웁니다.

```text
static Pod etcd : etcd.yaml hostPath 수정 → kubelet이 알아서 재생성
systemd etcd    : etcd.service --data-dir 수정 → daemon-reload → restart etcd
```

> **정리**: 건너뛴 단계마다 증상이 다릅니다. etcd가 옛 데이터를 읽으면 hostPath를, API 서버가 새 데이터와 어긋나 보이면 구성요소 재시작을 의심하고 다음 upgrade 전에 `kubeadm-config`의 경로까지 고쳤는지 확인합니다. PV 안의 데이터는 스냅샷과 무관합니다.

</details>

복구는 스냅샷을 새 데이터 디렉터리에 풀고 etcd가 그 디렉터리를 보게 하는 일입니다.

```bash
sudo etcdutl --data-dir /var/lib/etcd-restore snapshot restore /opt/backup/etcd-snapshot.db
sudo vi /etc/kubernetes/manifests/etcd.yaml   # volumes의 name: etcd-data hostPath.path를 /var/lib/etcd-restore로
```

매니페스트를 고치면 kubelet이 etcd Pod를 다시 만듭니다. 1분 넘게 kubectl이 연결 오류를 낼 수 있으니 매니페스트를 또 고치지 말고 `sudo crictl ps | grep etcd`로 기다립니다. 실측으로 확인한 함정은 셋입니다.

1. etcd가 복구된 데이터로 떠도 kube-apiserver를 다시 띄우기 전까지 지운 객체가 보이지 않았습니다. kube-apiserver, kube-controller-manager, kube-scheduler 매니페스트를 밖으로 옮겼다 되돌립니다. 문서도 API 서버를 멈추고 복구한 뒤 세 구성요소와 kubelet 재시작을 권합니다.
2. 워커 kubelet이 `no relationship found between node ... and this object`로 새 Pod를 `Pending`에 두었고 `systemctl restart kubelet`으로 풀렸습니다. Service 접속은 kube-proxy Pod를 다시 띄운 뒤에 됐습니다.
3. 이후 `kubeadm upgrade apply`는 `kubeadm-config`의 `etcd.local.dataDir`(`/var/lib/etcd`)로 매니페스트를 다시 만들어 복구를 되돌립니다. `dataDir`도 새 경로로 고칩니다.

스냅샷은 같은 major.minor etcd에서 뜬 것으로만 복구할 수 있습니다.

### 4-7. 노드 유지보수: cordon, drain, uncordon

<details>
<summary>기초부터: 노드가 사라지면 Pod는 어떻게 되고 drain은 무엇을 미리 하는지</summary>

> **핵심 한 줄**: 노드가 예고 없이 사라지면 쿠버네티스는 수 분을 기다린 뒤 Pod를 옮기고 drain은 계획된 작업 전에 그 일을 미리 해 둡니다.

#### 1. 왜 필요한가
네트워크가 잠깐 끊겼거나 재부팅 중일 수 있어서 쿠버네티스는 바로 Pod를 옮기지 않습니다. 10초 끊겼다고 바로 다른 노드에 Pod를 새로 만들었다가 20초 뒤 노드가 돌아오면 같은 Pod가 두 벌이 되고 불필요한 재생성이 반복됩니다.

| 상황 | 예고 없이 꺼짐 | 계획된 작업(커널 패치, 재부팅) |
|---|---|---|
| 쿠버네티스의 반응 | 기다렸다가 옮김 | 기다릴 이유가 없음 |
| 사람이 할 일 | 없음(자동) | drain으로 미리 비움 |
| 처리 능력 공백 | 6분 가까이 그 노드 Pod 몫이 빔 | 대체 Pod가 먼저 뜸 |

#### 2. 어떻게 동작하나: 노드가 사라질 때(1.37 기준)
1. **NotReady/Unknown**: kubelet의 하트비트(Lease 갱신)가 끊기고 `--node-monitor-grace-period`(기본 50초)가 지나면 노드 조건이 `Unknown`이 되고 `node.kubernetes.io/unreachable:NoExecute` 테인트가 붙습니다.
2. **300초 대기 후 제거**: Pod에는 어드미션 단계에서 이 테인트를 300초 견디는 톨러레이션이 들어 있습니다. 300초가 지나면 taint-eviction 컨트롤러가 Pod를 지웁니다.
3. **재생성**: ReplicaSet이나 Deployment에 속한 Pod는 컨트롤러가 다른 노드에 새로 만듭니다. 주인 없는 단독 Pod는 다시 만들어지지 않고 사라집니다.

```text
하트비트 끊김 ─50초─> Unknown + unreachable:NoExecute 테인트 ─300초─> Pod 제거 → 컨트롤러가 다른 노드에 재생성
```

#### 3. 어떻게 동작하나: drain
1. **cordon**: 노드를 스케줄 불가로 표시합니다. 작업 중에 새 Pod가 들어오지 않습니다.
2. **evict**: 노드의 Pod를 Eviction API로 하나씩 내보냅니다. 컨테이너는 SIGTERM을 받고 유예 시간 안에 정리하며 PDB가 허용하는 범위에서만 내보냅니다.
3. **재생성**: 컨트롤러가 다른 노드에 대체 Pod를 만듭니다.

| 명령 | 새 Pod | 돌던 Pod |
|---|---|---|
| `cordon` | 막음 | 그대로 둠. 디스크 경고가 보이는 노드처럼 돌던 작업은 마치게 둘 때 |
| `drain` | 막음 | 내보냄 |
| `uncordon` | 다시 받음 | 옮겨 간 Pod는 돌아오지 않음 |

#### 4. 헷갈리는 점 / 실전에서 보이는 모습
- 옛 자료의 "pod-eviction-timeout 5분"은 지금 플래그 목록에 없고 위 테인트 방식으로 바뀌었습니다.
- cordon한 노드는 `kubectl get nodes`의 STATUS에 `Ready,SchedulingDisabled`로 보입니다.
- drain이 단독 Pod 앞에서 멈추는 것은 의도된 동작입니다. 단독 Pod는 내보내면 영영 사라지니 `--force`로 사람이 확인해야 진행합니다. DaemonSet Pod가 있으면 `--ignore-daemonsets`를 요구합니다.
- uncordon 뒤에도 Pod가 원래 노드로 돌아오지 않는 이유는 스케줄러가 Pod를 처음 배치할 때만 노드를 고르기 때문입니다. 그 노드에는 이후 새로 만들어지는 Pod부터 들어갑니다.

> **정리**: drain이 멈추면 무엇이 막았는지부터 봅니다. DaemonSet Pod는 `--ignore-daemonsets`, 단독 Pod는 `--force`가 필요하고 단독 Pod는 장애든 drain이든 다시 만들어지지 않으니 컨트롤러로 띄웁니다.

</details>

| 명령 | 하는 일 | 이미 떠 있는 Pod |
|---|---|---|
| `cordon` | 스케줄 불가 표시 | 그대로 실행 |
| `drain` | cordon 뒤 Eviction API로 내보냄 | 축출됨 |
| `uncordon` | 다시 스케줄 가능 | 축출된 Pod는 돌아오지 않음 |

drain이 멈추는 경우와 옵션입니다.

- DaemonSet Pod가 있으면 `--ignore-daemonsets`가 필요합니다. DaemonSet Pod는 어느 쪽이든 지우지 않습니다.
- 컨트롤러 없는 단독 Pod가 있으면 `--force`가 필요하고 그 Pod는 다른 노드에 다시 생기지 않습니다.
- emptyDir를 쓰는 Pod는 `--delete-emptydir-data`가 필요하고 데이터는 함께 없어집니다.
- PDB가 허용하는 중단 수가 0이면 `Cannot evict pod as it would violate the pod's disruption budget`을 찍으며 재시도합니다. `--disable-eviction`은 PDB를 건너뛰는 일반 삭제입니다.

drain 없이 노드가 죽으면 `--node-monitor-grace-period`(기본 50s) 뒤 노드가 `Unknown`이 되고 `node.kubernetes.io/unreachable:NoExecute` 테인트가 붙습니다. Pod에 기본으로 들어간 `tolerationSeconds: 300`이 지나면 축출됩니다. 옛 자료의 `--pod-eviction-timeout`은 1.37 플래그 목록에 없습니다.

### 4-8. 인증서 내용 읽기: openssl x509

<details>
<summary>기초부터: 인증서 필드마다 틀렸을 때 보이는 증상과 로그를 찾는 깊이</summary>

> **핵심 한 줄**: 인증서 문제는 "어느 파일을 쓰는지 확인 → 필드 읽기 → 로그 찾기" 순서로 풀고 필드마다 틀렸을 때 나는 오류가 다릅니다.

#### 1. 어느 파일인지부터
kubeadm 클러스터의 컨트롤 플레인은 static Pod라서 실제로 쓰는 인증서 경로는 `/etc/kubernetes/manifests/kube-apiserver.yaml`의 `command` 인자(`--tls-cert-file`, `--tls-private-key-file` 등)에 적혀 있습니다. 경로를 짐작해서 엉뚱한 파일을 열지 않도록 매니페스트부터 봅니다. 손으로 세운 클러스터라면 같은 인자가 systemd 유닛 파일에 있습니다.

#### 2. 필드별 증상
| 필드 | 확인할 것 | 틀렸을 때 |
|---|---|---|
| Subject CN, O | 사용자 이름과 그룹이 RBAC 바인딩과 맞는지 | 인증은 통과하고 인가에서 403 Forbidden |
| SAN | 클라이언트가 부른 이름이나 IP가 목록에 있는지 | `x509: certificate is valid for <목록>, not <부른 이름>` |
| Issuer | 클러스터 CA(`CN=kubernetes`)가 서명했는지 | `x509: certificate signed by unknown authority` |
| Not After | 만료일이 지나지 않았는지 | `x509: certificate has expired or is not yet valid` |

API 서버는 노드 IP, `kubernetes.default.svc`, Service IP `10.96.0.1` 등 여러 이름으로 불리므로 SAN에 그 이름이 모두 있어야 합니다. 로드밸런서 주소를 나중에 붙였다면 SAN에 없어서 위 오류가 납니다.

#### 3. 로그를 찾는 깊이
1. **API 서버가 살아 있을 때**: `kubectl logs -n kube-system <Pod>`로 인증 실패를 반복하는 구성요소의 로그를 봅니다.
2. **API 서버가 죽었을 때**: kubectl이 `connection refused`로 아무것도 못 하니 컨트롤 플레인 노드에 SSH로 들어가 `crictl ps -a`로 멈춘 컨테이너를 찾고 `crictl logs <컨테이너 ID>`로 인증서를 못 읽었다는 원인을 봅니다.

```text
kubectl 됨  → kubectl logs -n kube-system <Pod>
kubectl 안 됨 → ssh 노드 → crictl ps -a → crictl logs <ID>
```

> **정리**: 오류 문구로 틀린 필드를 짚습니다. `valid for ..., not ...`이면 SAN, `unknown authority`면 Issuer, `expired`면 만료일이고 403이면 CN/O와 RBAC 바인딩을 봅니다. API 서버가 내려가 있으면 `crictl logs`로 내려갑니다.

</details>

```bash
sudo openssl x509 -in /etc/kubernetes/pki/apiserver.crt -text -noout
```

```text
        Issuer: CN=kubernetes                           <- 서명한 CA
            Not After : Oct 20 06:23:05 2027 GMT        <- 만료일
        Subject: CN=kube-apiserver                      <- 이 인증서의 주인
            X509v3 Subject Alternative Name:
                DNS:<노드 이름>, DNS:kubernetes, DNS:kubernetes.default, DNS:kubernetes.default.svc,
                DNS:kubernetes.default.svc.cluster.local, IP Address:10.96.0.1, IP Address:<노드 IP>
```

클라이언트 인증서라면 Subject의 CN과 O가 RBAC 바인딩의 사용자, 그룹과 맞는지 봅니다. 서버 인증서라면 접속하는 이름과 IP가 SAN에 있어야 하고 없으면 TLS 검증이 실패합니다.

kubeconfig와 CSR 객체 안의 내용은 꺼내서 디코딩합니다.

```bash
sudo grep client-certificate-data /etc/kubernetes/admin.conf | awk '{print $2}' | base64 -d \
  | openssl x509 -noout -subject -issuer -enddate
kubectl get csr <이름> -o jsonpath='{.spec.request}' | base64 -d | openssl req -noout -subject
```

kubectl이 안 되면 노드에서 `crictl ps -a`, `crictl logs <ID>`로 봅니다([9편](/blog/cert/cka/cka-06-troubleshooting)).

### 4-9. 직접 해 보기

`payment`에 Deployment를 만들고 스냅샷을 뜬 뒤 Deployment를 지웁니다. `/var/lib/etcd-restore`로 복구하고 static Pod를 다시 띄워 Deployment가 돌아오는지 봅니다. `minAvailable: 2` PDB와 레플리카 2개로 drain이 기다리는 모습도 확인합니다.

## 5. 고가용성 컨트롤 플레인

커리큘럼 문구는 "Implement and configure a highly-available control plane"입니다.

### 5-1. 두 가지 토폴로지

<details>
<summary>기초부터: 컨트롤 플레인 한 대가 죽으면 생기는 일과 구성요소별 HA 방식</summary>

> **핵심 한 줄**: 컨트롤 플레인을 여러 대로 늘릴 때 API 서버는 모두 동시에 일하고 컨트롤러 매니저와 스케줄러는 리더 한 대만 일하며 etcd는 Raft로 과반이 데이터를 맞춥니다.

#### 1. 왜 필요한가
컨트롤 플레인이 한 대뿐인 클러스터에서 그 노드가 죽었다고 해 봅니다. 워커에서 이미 돌던 Pod는 계속 요청을 처리합니다. 하지만 관리 기능이 모두 멈춥니다.

| 죽은 구성요소 | 생기는 일 |
|---|---|
| kube-apiserver | kubectl로 조회, 생성, 수정이 하나도 안 됨 |
| 컨트롤러 매니저, 스케줄러 | 워커의 Pod가 죽어도 다시 만들어지지 않음. 자가 치유가 멈춤 |
| etcd(그 노드에만 있었다면) | 디스크가 망가졌을 때 클러스터 기록 전체를 잃음 |

#### 2. 어떻게 동작하나
1. **kube-apiserver(액티브-액티브)**: 모두 동시에 일합니다. 상태를 etcd에만 두고 자기는 들고 있지 않아서 여러 대가 같은 요청을 받아도 결과가 같습니다. 앞에 로드 밸런서를 두고 kubectl, kubelet, 다른 구성요소가 모두 그 주소(`--control-plane-endpoint`)로 붙게 합니다. 한 대가 죽으면 LB가 나머지로 보냅니다.
2. **kube-controller-manager, kube-scheduler(액티브-스탠바이)**: 한 대만 일합니다. 둘이 동시에 ReplicaSet을 맞추면 같은 Pod를 두 번 만들어 원하는 수보다 많아질 수 있습니다. 그래서 `--leader-elect=true`(기본값)로 리더를 뽑습니다.
3. **리더 선출**: `kube-system`의 Lease 오브젝트를 잡는 경쟁입니다. 먼저 Lease를 잡은 인스턴스가 리더가 되고 기본 15초짜리 임대를 10초 안에 계속 갱신합니다. 나머지는 2초마다 Lease를 확인하다가 갱신이 끊겨 임대가 만료되면 그중 하나가 Lease를 잡아 새 리더가 됩니다(lease-duration 15s, renew-deadline 10s, retry-period 2s 기본값).
4. **etcd**: 여러 대가 Raft 합의로 같은 데이터를 맞춥니다. 과반이 살아 있어야 쓰기가 되므로 3대 이상 홀수로 둡니다(아래 토글).

```text
kubectl, kubelet → 로드 밸런서(--control-plane-endpoint)
                    ├→ apiserver 1 ┐
                    ├→ apiserver 2 ├→ etcd 멤버 전부(--etcd-servers)
                    └→ apiserver 3 ┘
controller-manager 1(리더, Lease 보유)  2, 3(대기, 2초마다 Lease 확인)
```

#### 3. 한눈에 비교
| 구성요소 | 방식 | 장애 시 |
|---|---|---|
| kube-apiserver | 액티브-액티브 + LB | LB가 나머지로 보냄 |
| controller-manager, scheduler | 액티브-스탠바이, Lease 리더 선출 | 임대 만료 뒤 대기 중인 하나가 리더 |
| etcd | Raft 합의, 홀수 대수 | 과반이 살아 있으면 계속 동작 |

| etcd 토폴로지 | 구성 | 특징 |
|---|---|---|
| stacked | 컨트롤 플레인 노드 안에 etcd 멤버를 함께 띄움 | 노드 수가 적음. kubeadm 기본값 |
| external | etcd만 도는 노드를 따로 둠 | 컨트롤 플레인 노드 하나를 잃어도 etcd 멤버는 잃지 않음 |

어느 쪽이든 API 서버의 `--etcd-servers`에는 etcd 멤버 주소를 모두 적어 어느 멤버에 붙어도 읽고 쓸 수 있게 합니다.

#### 4. 헷갈리는 점 / 실전에서 보이는 모습
- 옛 자료는 Endpoints 오브젝트를 잠금으로 썼다고 적지만 지금은 Lease를 씁니다. `kubectl get lease -n kube-system`을 치면 `kube-controller-manager`, `kube-scheduler` Lease와 지금 리더(HOLDER)가 보입니다.
- 옛 강의의 "컨트롤 플레인 2대 + stacked etcd" 구성은 etcd 멤버 2개라 1대만 죽어도 쿼럼을 잃으므로 HA가 되지 않습니다.
- API 서버 앞 로드 밸런서로 kubeadm 문서("Options for Software Load Balancing")는 가상 IP를 띄우는 keepalived와 TCP를 나눠 주는 haproxy 조합, 둘을 한 서비스로 합친 kube-vip를 소개합니다. 문서 예시의 상태 확인은 두 도구 모두 API 서버의 `/healthz`를 HTTPS로 부르는 방식입니다(keepalived 검사 스크립트는 curl, haproxy는 `http-check`).
- 강의의 확장 설계는 컨트롤 플레인 2대, LB 전용 노드 1대, 워커 2대로 모두 5대입니다. 위 이유로 실제 HA를 원하면 컨트롤 플레인을 3대로 둡니다. LB 노드가 한 대뿐이면 그 노드가 새 단일 장애 지점이 되므로 운영에서는 keepalived 가상 IP나 클라우드 LB로 LB 자체도 이중화합니다.

> **정리**: 지금 리더가 누구인지는 `kubectl get lease -n kube-system`의 HOLDER로 봅니다. 컨트롤 플레인 2대에 stacked etcd면 1대만 죽어도 쿼럼을 잃으니 HA를 원하면 3대로 둡니다. 왜 홀수인지는 다음 토글의 Raft에서 봅니다.

</details>

<details>
<summary>기초부터: etcd의 Raft 합의와 쿼럼, 홀수 대수</summary>

> **핵심 한 줄**: etcd는 Raft로 리더 한 대가 쓰기를 받아 과반(쿼럼)이 받으면 확정하고 그래서 멤버는 3대나 5대처럼 홀수로 둡니다.

#### 1. 왜 필요한가
etcd 멤버 세 대가 같은 데이터를 갖고 있어야 한다면 "누가 쓴 값이 맞는지"를 정하는 규칙이 필요합니다. 각자 쓰기를 받으면 멤버마다 순서가 달라져 데이터가 어긋납니다. etcd는 Raft 알고리즘으로 이 문제를 풉니다.

#### 2. 어떻게 동작하나
1. **리더와 팔로워**: 리더 하나, 나머지는 팔로워입니다. 쓰기는 리더만 처리하고 팔로워가 쓰기 요청을 받으면 리더에게 넘깁니다.
2. **리더 선출**: 멤버마다 무작위 길이의 선거 타이머가 있습니다. 리더의 하트비트를 일정 시간 받지 못한 멤버의 타이머가 먼저 끝나면 그 멤버가 후보가 되어 다른 멤버에게 투표를 요청합니다. 과반의 표를 얻으면 리더가 되고 하트비트를 보내기 시작합니다. 타이머가 무작위인 이유는 여러 멤버가 동시에 후보로 나서 표가 갈리는 일을 줄이기 위해서입니다.
3. **쓰기 확정**: 리더는 쓰기를 로그에 붙여 팔로워에게 복제하고 과반(쿼럼)의 멤버가 받았다고 답하면 그 쓰기를 확정(commit)합니다. 모든 멤버를 기다리지 않기 때문에 한 대가 느리거나 죽어도 쓰기가 계속됩니다.

```text
클라이언트 → 팔로워 → (넘김) → 리더 → 로그에 추가 → 팔로워들에 복제
                                  ← 과반이 "받음" ← 
                              commit → 응답
```

#### 3. 한눈에 비교: 짝수를 피하는 이유
쿼럼은 `floor(n/2) + 1`이고 아래 본문 표가 그 계산입니다. 짝수를 피하는 이유는 두 가지입니다.

1. **견디는 장애 수가 늘지 않습니다.** 3대에서 4대로 늘려도 견디는 장애 수는 1로 같고 복제할 곳만 늘어납니다.
2. **네트워크가 반으로 갈릴 때 차이가 납니다.**

| 구성 | 갈라진 모양 | 쿼럼 | 결과 |
|---|---|---|---|
| 6대 | 3대 / 3대 | 4 | 양쪽 모두 쿼럼 미달. 멤버 6대가 다 살아 있는데 쓰기가 전부 멈춤 |
| 7대 | 4대 / 3대 | 4 | 4대 쪽이 리더를 뽑고 계속 동작. 3대 쪽만 멈춤 |

홀수면 두 쪽으로 갈라졌을 때 반드시 한쪽이 과반을 가집니다. 세 쪽 이상으로 쪼개지면 홀수여도 모두 과반에 못 미칠 수 있습니다. 실무에서는 3대(1대 장애 견딤)나 5대(2대 장애 견딤)를 씁니다.

본문 표 뒤를 이어 보면 6대는 쿼럼 4라 2대까지 견뎌 5대와 같고 7대는 쿼럼 4라 3대까지 견딥니다. 7대는 더 버티는 대신 쓰기마다 복제할 멤버와 확정에 필요한 응답 수가 늘어 리더의 부담이 커집니다.

#### 4. 실전에서 보이는 모습
- etcd를 손으로 클러스터로 묶을 때는 `--initial-cluster`에 첫 멤버 전원의 이름과 피어 주소(2380)를 적어 서로를 찾게 합니다.
- kubeadm HA에서는 `kubeadm join --control-plane`이 기존 멤버에 새 멤버를 추가하는 일을 대신하므로 직접 적을 일은 거의 없습니다.

> **정리**: 3대를 4대로 늘려도 견디는 장애는 1대 그대로이고 6대는 3대/3대로 갈리면 양쪽 다 쓰기가 멈춥니다. 멤버를 늘릴 때는 3대에서 5대로 갑니다.

</details>

| 항목 | stacked etcd | external etcd |
|---|---|---|
| etcd 위치 | 컨트롤 플레인 노드마다 로컬 멤버 | 별도 호스트 |
| 장점 | 구성이 단순, kubeadm 기본값 | 컨트롤 플레인과 etcd 장애가 서로 덜 번짐 |
| 대가 | 노드 하나가 죽으면 etcd 멤버와 컨트롤 플레인을 함께 잃음 | 호스트가 두 배 |
| 최소 규모 | 컨트롤 플레인 3대 | 컨트롤 플레인 3대, etcd 3대 |

두 구조 모두 kube-apiserver는 로드 밸런서 뒤에 있고 최소 3대인 이유는 etcd 쿼럼(floor(n/2)+1)입니다.

| 멤버 수 | 쿼럼 | 견디는 장애 수 |
|---|---|---|
| 1 | 1 | 0 |
| 2 | 2 | 0 |
| 3 | 2 | 1 |
| 4 | 3 | 1 |
| 5 | 3 | 2 |

짝수를 더해도 견디는 장애 수는 늘지 않으니 멤버 수는 홀수로 둡니다. kube-controller-manager와 kube-scheduler는 여러 대가 떠 있어도 리더 한 대만 일하고 리더는 `kubectl get lease -n kube-system`의 HOLDER 열에 보입니다.

### 5-2. 만드는 순서

"Creating Highly Available Clusters with kubeadm" 기준입니다.

kube-apiserver용 로드 밸런서(기본 포트 6443)를 먼저 두고 첫 컨트롤 플레인에서 그 주소로 init합니다. 나머지 컨트롤 플레인은 워커용 join 명령에 `--control-plane --certificate-key <키>`를 더해 붙습니다.

```bash
sudo kubeadm init --control-plane-endpoint "LOAD_BALANCER_DNS:LOAD_BALANCER_PORT" --upload-certs

# 나머지 컨트롤 플레인에서
sudo kubeadm join LOAD_BALANCER_DNS:6443 --token <토큰> \
  --discovery-token-ca-cert-hash sha256:<해시> \
  --control-plane --certificate-key <키>
```

Lima VM 3대(kubeadm 1.37.1)에서 엔드포인트를 첫 노드 IP의 `/etc/hosts` 이름 `k8s-api`로 두고 돌린 init 출력입니다(LB가 없어 첫 노드가 죽으면 API 주소도 사라짐).

```text
[upload-certs] Storing the certificates in Secret "kubeadm-certs" in the "kube-system" Namespace
...
  kubeadm join k8s-api:6443 --token <토큰> \
	--discovery-token-ca-cert-hash sha256:<해시> \
	--control-plane --certificate-key <64자 hex 키>

As a safeguard, uploaded-certs will be deleted in two hours; If necessary, you can use
"kubeadm init phase upload-certs --upload-certs" to reload certs afterward.
```

두 번째 노드에서 이 명령에 `--apiserver-advertise-address=<자기 IP>`를 더하면 `[download-certs]`로 CA를 받고 `[etcd] Announced new etcd member joining to the existing etcd cluster`를 거쳐 join이 끝납니다. 멤버는 etcd Pod 안의 etcdctl로 봅니다.

```bash
kubectl -n kube-system exec etcd-lima-ha1 -- etcdctl --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key member list -w table
# lima-ha1, lima-ha2, lima-ha3 세 줄 모두 STATUS started, IS LEARNER false
```

`--upload-certs`는 CA 세 쌍과 sa 키(Secret 키 `ca.crt`, `etcd-ca.key`, `front-proxy-ca.crt`, `sa.pub` 등 8개)를 암호화해 `kube-system`의 `kubeadm-certs` Secret에 올립니다. Secret의 owner가 `kubeadm token list`에 `Proxy for managing TTL for the kubeadm-certs secret`로 보이는 TTL 토큰이라 2시간 뒤 함께 지워집니다. 이 토큰을 지워 만료를 재현하자 옛 키의 join이 이렇게 실패했습니다.

```text
error: error execution phase control-plane-prepare/download-certs: error downloading certs: error downloading the secret: Secret "kubeadm-certs" was not found in the "kube-system" Namespace. This Secret might have expired. Please, run `kubeadm init phase upload-certs --upload-certs` on a control plane to generate a new one
```

새 키로 만든 명령으로 세 번째 노드가 붙었습니다.

```bash
sudo kubeadm init phase upload-certs --upload-certs            # 새 certificate key 출력
kubeadm token create --print-join-command --certificate-key <새 키>
```

### 5-3. 헷갈리는 지점

- `--control-plane-endpoint` 없이 만든 클러스터는 나중에 HA로 바꿀 수 없습니다.
- 컨트롤 플레인 4대는 3대와 같은 1대까지만 버팁니다.
- stacked 3대에서 1대를 멈추면 그대로 동작하고 리더 Lease가 옮겨 갑니다. 2대를 멈추면 조회도 멈추고 남은 API 서버의 `/readyz`에 `[-]etcd failed`가 나옵니다.

### 5-4. 직접 해 보기

kind로 컨트롤 플레인 3대 클러스터를 만들고 노드 컨테이너를 하나씩 `docker stop`하며 `kubectl get lease -n kube-system`의 HOLDER와 위 동작을 확인합니다. kind는 CA 파일을 복사해 join하므로 `--certificate-key` 흐름은 리눅스 VM 2~3대에서 5-2절 순서로 해 봅니다. 2대면 etcd 멤버 2개라 1대만 죽어도 쿼럼을 잃습니다.

## 6. Helm과 Kustomize로 구성요소 설치

<details>
<summary>기초부터: YAML 파일 묶음을 다루는 두 가지 방법</summary>

> **핵심 한 줄**: 쿠버네티스는 오브젝트를 하나씩만 알기 때문에 "앱 하나에 속한 YAML 묶음"을 다루는 도구가 따로 필요하고 Helm과 Kustomize가 그 둘입니다.

#### 1. 왜 필요한가
게시판 앱 하나를 띄우는 데 필요한 오브젝트를 세어 봅니다. 웹 서버 Deployment, DB용 StatefulSet이나 Deployment, PVC, 바깥에 여는 Service, 관리자 비밀번호 Secret, 설정 ConfigMap, 정기 백업 CronJob까지 파일이 금방 열 개가 넘습니다. kubectl만으로 관리하면 이런 일이 생깁니다.

1. **설치**: 파일마다 `apply`해야 하고 순서도 신경 써야 합니다.
2. **값 변경**: PVC 크기 20Gi를 100Gi로 바꾸려면 어느 파일 어느 줄인지 찾아 고칩니다.
3. **업그레이드**: 몇 달 뒤 여러 파일을 다시 고치다 엉뚱한 곳을 건드립니다.
4. **삭제**: 이 앱에 속한 오브젝트를 전부 기억해 하나씩 지워야 합니다.
5. **파일 하나로 합치기**: 모든 오브젝트를 `---`로 이어 한 파일에 넣어도 수백 줄 안에서 고칠 곳을 찾는 수고는 그대로입니다.

쿠버네티스가 이 Deployment와 저 Secret이 같은 게시판 앱에 속한다는 사실을 모르니 생기는 일들입니다. 여기에 환경 문제가 겹칩니다. 개발, 스테이징, 운영에서 대부분 같고 레플리카 수나 이미지 태그만 다를 때 디렉터리를 셋으로 복사하면 한쪽만 고치고 다른 쪽을 잊는 불일치가 생깁니다.

#### 2. 어떻게 푸나
```text
Helm:      템플릿({{ .Values.x }}) + values 파일 → 렌더링 → 최종 YAML → 클러스터(릴리스로 기록)
Kustomize: 평범한 YAML(base) + 바꿀 부분(overlay) → 덧입힘 → 최종 YAML → 클러스터
```

#### 3. 한눈에 비교
| 항목 | Helm | Kustomize |
|---|---|---|
| 정체 | 쿠버네티스용 패키지 관리자(리눅스의 apt, yum 같은) | YAML 변형 도구 |
| 방식 | 변수 자리를 뚫어 둔 템플릿(`{{ .Values.replicaCount }}`)에 values 파일 값을 채움 | 평범한 YAML(base)에 바꿀 부분(overlay)을 덧입힘 |
| 원본 파일 | 템플릿이라 그 자체로는 유효한 YAML이 아님 | 전부 유효한 YAML |
| 할 수 있는 것 | 조건문, 반복, 함수, 훅, 설치 이력과 롤백 | 레이블, 네임스페이스, 이름, 이미지 변경과 패치 |
| 설치 | `helm` 바이너리 별도 | kubectl에 내장(`-k`) |
| 어울리는 경우 | 남이 만든 앱을 통째로 설치하고 버전 관리 | 내 매니페스트를 환경별로 조금씩 다르게 |

#### 4. 헷갈리는 점
- Helm은 기능이 많은 만큼 템플릿이 복잡해져 차트가 실제로 무엇을 만드는지 읽기 어려울 수 있습니다. Kustomize는 기능이 적은 대신 결과를 예상하기 쉽습니다.
- 둘을 함께 쓰기도 합니다. Helm으로 렌더링한 결과를 Kustomize로 한 번 더 고치는 식입니다.
- Helm도 환경별 차이를 다룹니다. 템플릿은 하나로 두고 `values-dev.yaml`, `values-prod.yaml`처럼 환경마다 값 파일을 만들어 `helm install shop ./shop-chart -f values-prod.yaml`로 고릅니다. Kustomize의 overlay가 하던 일을 값 파일이 맡습니다.
- 조건문은 Helm에만 있습니다. 템플릿을 `{{- if .Values.ingress.enabled }}`로 감싸 두면 운영 값 파일에서 `ingress.enabled: true`를 줄 때만 Ingress가 만들어집니다. 대신 이런 분기가 쌓일수록 템플릿이 읽기 어려워집니다.
- Helm은 설치와 삭제를 명령 하나로 끝내는 패키지 관리자이면서 업그레이드와 롤백 이력을 쥐는 릴리스 관리자입니다. 두 역할 모두 오브젝트 묶음을 앱 하나로 다루는 데서 출발합니다.
- 시험에서는 "Helm으로 이 차트를 설치하라", "Kustomize overlay를 적용하라"처럼 도구를 지정해 주니 각 도구의 기본 동작을 익혀 두면 됩니다.

> **정리**: 시험은 쓸 도구를 지정해 주니 고를 일은 없고 각 도구의 기본 동작만 익혀 두면 됩니다. 남이 만든 앱을 통째로 설치하고 이력을 관리할 때는 Helm, 내 매니페스트를 환경별로 조금씩 바꿀 때는 Kustomize입니다.

</details>

커리큘럼 문구는 "Use Helm and Kustomize to install cluster components"입니다. 시험 중에 helm.sh/docs를 열 수 있습니다. `helm`은 공식 사전 설치 목록에 없지만 4-5절의 etcdctl과 같은 근거(Resources Allowed 문서)로 Helm 과제 호스트에는 있을 가능성이 높습니다. 과제 호스트에서 `helm version`으로 있는지와 메이저 버전부터 봅니다. Kustomize는 kubectl에 들어 있습니다.

### 6-1. Helm

<details>
<summary>기초부터: 차트, 릴리스, 리비전, 저장소</summary>

> **핵심 한 줄**: 차트는 설계도, 릴리스는 그 설계도로 지은 건물 한 채, 리비전은 고칠 때마다 남는 도면 기록, 저장소는 설계도를 모아 둔 곳입니다. 실제로도 차트 하나로 릴리스 여러 개를 따로 설치하고 릴리스마다 리비전이 쌓입니다.

#### 1. 왜 필요한가
Helm 명령은 거의 모두 이 넷 중 하나를 대상으로 합니다. 용어가 머릿속에서 정리되면 `install`, `upgrade`, `rollback`, `repo` 명령이 무엇을 바꾸는지 바로 보입니다.

#### 2. 어떻게 동작하나
```text
차트 bitnami/wordpress (설계도)
  ├─ 릴리스 shop-blog   (shop 네임스페이스)
  │    ├─ 리비전 1  install
  │    └─ 리비전 2  upgrade
  └─ 릴리스 board-blog  (board 네임스페이스, 같은 차트로 따로 설치)
       └─ 리비전 1  install
```

1. **차트(Chart)**: 템플릿 파일과 기본값(`values.yaml`), 메타데이터(`Chart.yaml`)를 담은 디렉터리나 압축 파일입니다. 오브젝트를 어떻게 만들지 정한 지침이 전부 들어 있습니다. 대부분 직접 쓰지 않고 공개 저장소에서 받습니다.
2. **릴리스(Release)**: 차트를 클러스터에 한 번 설치한 단위입니다. `helm install shop-blog <차트>`의 `shop-blog`가 릴리스 이름입니다. 같은 차트로 이름을 달리해 여러 번 설치할 수 있고 각 릴리스는 따로 올리고 지웁니다. Helm은 릴리스마다 자기가 만든 오브젝트를 알고 있어서 다른 릴리스를 건드리지 않습니다.
3. **리비전(Revision)**: 릴리스에 install, upgrade, rollback을 할 때마다 번호가 하나씩 오르는 스냅샷입니다.
4. **저장소(Repository)**: 차트를 올려 두는 HTTP 서버나 OCI 레지스트리입니다. `helm repo add`로 내 Helm 설정에 등록하고 `helm repo update`로 목록을 새로 받습니다. 받아 둔 목록은 로컬 사본이라 오래되면 새 차트 버전이 안 보이니 `apt-get update`처럼 가끔 갱신합니다.

#### 3. 한눈에 비교: 차트를 찾는 두 곳
| 명령 | 찾는 곳 |
|---|---|
| `helm search repo <키워드>` | 내가 등록한 저장소 안 |
| `helm search hub <키워드>` | 여러 저장소를 모아 둔 색인 사이트 Artifact Hub(artifacthub.io) |

Artifact Hub에서는 프로젝트가 직접 올린 차트에 공식(Official)이나 인증 게시자(Verified Publisher) 표시가 붙으니 가능하면 그런 차트를 고릅니다.

#### 4. 헷갈리는 점 / 실전에서 보이는 모습
- 릴리스 기록(어떤 차트, 어떤 값, 어떤 매니페스트였는지)은 내 PC에 남지 않습니다. 클러스터의 Secret에 저장됩니다(6-3절). 그래서 다른 관리자가 다른 PC에서도 같은 릴리스를 이어서 업그레이드할 수 있습니다.
- 시험 환경에서 외부 사이트에 닿는지는 알 수 없으니 과제가 주는 저장소 주소를 쓰는 연습을 해 둡니다.
- 명령이 기억나지 않으면 `helm --help`, `helm repo --help`처럼 하위 명령마다 도움말을 봅니다. 롤백이 `restore`인지 `rollback`인지 헷갈릴 때 목록에서 바로 확인됩니다.
- 저장소 관리는 `helm repo add`, `helm repo list`(등록한 저장소 보기), `helm repo update`, `helm repo remove` 네 명령으로 끝납니다.
- `helm install`이 끝나면 접속 주소나 초기 비밀번호 확인 방법 같은 안내문이 출력됩니다. 차트의 `templates/NOTES.txt`를 렌더링한 결과이고 나중에 다시 보려면 `helm get notes <릴리스>`를 씁니다.
- Helm은 kubectl과 같은 kubeconfig의 현재 컨텍스트로 클러스터에 붙습니다. 설치 전에 `kubectl config current-context`로 대상 클러스터부터 확인합니다.
- 내 PC에 Helm을 설치할 때는 helm.sh 설치 문서의 공식 스크립트(`get-helm-4`)나 릴리스 바이너리를 씁니다. snap(`sudo snap install helm --classic`), apt, Homebrew 패키지도 있지만 커뮤니티가 관리하는 경로입니다.
- 패키지 경로는 OS마다 다릅니다. Fedora는 `sudo dnf install helm`, FreeBSD는 `pkg install helm`, Windows는 `choco install kubernetes-helm`, `scoop install helm`, `winget install Helm.Helm`입니다(helm.sh 설치 문서). snap의 `--classic`은 격리를 풀고 일반 패키지처럼 시스템 자원에 접근하게 하는 옵션이라 helm이 홈 디렉터리의 `~/.kube/config`를 읽을 수 있습니다.
- Artifact Hub는 예전 Helm Hub를 이어받은 사이트입니다(2020년 10월 helm.sh 공지). 옛 자료의 Helm Hub는 지금 Artifact Hub를 말합니다.

> **정리**: `install`은 릴리스를 만들고 `upgrade`와 `rollback`은 리비전을 하나씩 올립니다. Helm은 kubectl의 현재 컨텍스트로 붙으니 설치 전에 `kubectl config current-context`로 대상 클러스터부터 확인합니다.

</details>

Helm은 차트를 값과 합쳐 설치하고 설치를 릴리스로 기록하며 설치, 업그레이드, 롤백마다 리비전이 오릅니다. 2026년 10월 helm.sh 문서의 기본 버전은 4.3.1이고 아래 명령은 Helm 3과 4에 공통입니다.

```bash
helm repo add <이름> <URL>
helm repo update
helm search repo <키워드>
helm show values <저장소>/<차트>                 # 바꿀 수 있는 값

helm install shop-cache <저장소>/<차트> \
  -n shop --create-namespace \
  --set replicaCount=2

helm list -A
helm upgrade --install shop-cache <저장소>/<차트> -n shop -f values-shop.yaml
helm history shop-cache -n shop
helm rollback shop-cache 1 -n shop
helm uninstall shop-cache -n shop
helm get values shop-cache -n shop             # 사용자가 넣은 값. --all이면 전체
```

`-f` 값 파일은 여러 번 줄 수 있고 오른쪽이 우선하며 `--version`은 차트 버전(`Chart.yaml`의 `version`)을 고릅니다. `oci://...` 주소로 바로 설치할 수도 있습니다. Helm 4에서 `--atomic`은 `--rollback-on-failure`로, `--force`는 `--force-replace`로 이름이 바뀌었고 옛 이름은 경고와 함께 동작합니다.

### 6-1b. 차트를 받아 고쳐서 설치

<details>
<summary>기초부터: 차트 디렉터리 안을 열어 보기와 값 덮어쓰기 순서</summary>

> **핵심 한 줄**: Helm은 `templates/`의 템플릿과 `values.yaml`의 값을 합쳐 최종 YAML을 만들고 기본값은 `-f` 파일과 `--set`으로 덮어씁니다.

#### 1. 왜 필요한가
"기본값 파일을 고쳐 설치하라", "레플리카를 3으로 바꿔 설치하라" 같은 과제는 차트 안 어디에 무엇이 있는지와 값이 어떤 순서로 덮이는지를 알아야 풀립니다.

#### 2. 어떻게 생겼나
`helm pull --untar`로 받은 차트 디렉터리는 이렇게 생겼습니다.

```text
board-app/
├── Chart.yaml        차트 자신의 정보
├── values.yaml       템플릿에 들어갈 기본값
├── templates/        변수 자리가 뚫린 매니페스트 템플릿
│   ├── deployment.yaml
│   └── service.yaml
├── charts/           의존하는 다른 차트(하위 차트)
├── crds/             CRD(있을 때만, 6-1c절)
├── README.md         사람이 읽을 설명(선택)
└── LICENSE           차트 라이선스 전문(선택)
```

템플릿의 한 줄과 값 파일의 한 줄이 짝을 이룹니다.

```yaml
# templates/deployment.yaml 일부
spec:
  replicas: {{ .Values.replicaCount }}
  template:
    spec:
      containers:
      - name: web
        image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
```

```yaml
# values.yaml
replicaCount: 1
image:
  repository: nginx
  tag: "1.27"
```

`Chart.yaml`에서 헷갈리는 필드는 버전 둘입니다.

| 필드 | 뜻 |
|---|---|
| `apiVersion` | 차트 형식 버전. Helm 3 이상용 차트는 `v2`. `v1`은 Helm 2 시절 형식 |
| `version` | 차트 자체의 버전(SemVer). `helm install --version`이 고르는 값 |
| `appVersion` | 차트가 설치하는 앱의 버전. 참고용 정보 |
| `type` | `application`(기본) 또는 다른 차트를 돕는 `library` |
| `dependencies` | 하위 차트 목록. 게시판 차트가 DB 차트를 직접 복사해 넣지 않고 의존성으로 가져옴 |
| `name` | 차트 이름. `apiVersion`, `version`과 함께 필수 필드 |
| `description`, `keywords`, `home`, `icon`, `maintainers` | 설명, 검색용 키워드, 프로젝트 주소, 아이콘 주소, 관리자 목록. 모두 선택 |

`apiVersion: v1` 차트는 의존성을 `Chart.yaml` 대신 별도 `requirements.yaml`에 적었고 `type` 필드도 없었습니다. Helm 3는 `v1` 차트도 설치합니다. Helm 3.3.2부터 표에 없는 임의 필드는 넣을 수 없어 사용자 정의 정보는 `annotations`에 둡니다.

#### 3. 값을 바꾸는 세 방법과 우선순위
1. **`--set key=value`**: 바꿀 값이 몇 개일 때. 중첩 키는 `--set image.tag=1.28`처럼 점으로 잇습니다.
2. **`-f my-values.yaml`(`--values`)**: 바꿀 값이 많을 때. 바꿀 키만 담은 YAML 파일을 따로 만듭니다.
3. **차트 자체 수정**: 차트를 내려받아 `values.yaml`이나 템플릿 자체를 고치고 `helm install <이름> ./board-app`처럼 디렉터리 경로로 설치합니다. 기본값 파일을 직접 고치라는 과제가 이 경우입니다.

```text
낮음 ← 차트의 values.yaml < -f 파일(여러 개면 뒤에 준 파일이 이김) < --set → 높음
```

#### 4. 실전에서 보이는 모습
- 적용 전에는 `helm template`이나 `--dry-run=client`로 최종 YAML을 눈으로 확인합니다.
- `--set image.tag=1.28`이 들어갔는지 볼 때도 렌더링 결과의 `image:` 줄을 확인하면 됩니다.

> **정리**: 같은 키를 여러 곳에서 주면 `--set`이 `-f` 파일을, `-f` 파일이 차트의 `values.yaml`을 이깁니다. 기본값 파일을 고치라는 과제는 `helm pull --untar`로 받아 디렉터리 경로로 설치하고 적용 전에 `helm template`으로 결과를 봅니다.

</details>

기본 `values.yaml`이나 템플릿을 고쳐야 하는 과제라면 차트를 내려받아 디렉터리로 설치합니다.

```bash
helm pull <저장소>/<차트> --untar               # ./<차트>/ 생성 (Chart.yaml, values.yaml, templates/, crds/)
vi <차트>/values.yaml
helm template shop-cache ./<차트> -n shop | less
helm install shop-cache ./<차트> -n shop --create-namespace --dry-run=client
helm install shop-cache ./<차트> -n shop --create-namespace
```

`--dry-run`은 `=client`나 `=server`를 붙여 씁니다. Helm 4.3.1은 값 없는 `--dry-run`에 사용 중단 경고를 냅니다.

### 6-1c. 차트가 CRD를 가져올 때

오퍼레이터 차트는 대개 `crds/` 디렉터리에 CRD를 담습니다. Helm 문서가 정한 동작은 일반 템플릿과 다릅니다.

| 상황 | 동작 |
|---|---|
| `helm install` | `crds/`를 먼저 올리고 등록을 기다린 뒤 템플릿 설치 |
| CRD가 이미 있음 | 경고와 함께 건너뜀 |
| `helm upgrade`, `rollback` | CRD를 설치하거나 올리지 않음 |
| `helm uninstall` | CRD를 지우지 않음 |
| `helm template` | 기본 출력에 CRD가 빠짐. `--include-crds`가 있어야 포함 |

렌더링 파일을 `kubectl apply -f`로 넣는 과제에서 `--include-crds`를 빠뜨리면 이렇게 실패합니다.

```text
no matches for kind "Refund" in version "pay.example.com/v1"
ensure CRDs are installed first
```

`--include-crds`를 넣어도 CRD가 등록되기 전에 커스텀 객체가 처리되어 같은 오류가 날 수 있으니 `kubectl wait` 뒤 한 번 더 apply합니다. 템플릿이 `{{ .Release.Namespace }}`를 쓰지 않으면 `helm template -n`은 네임스페이스를 넣지 않으니 `kubectl apply`에도 `-n`을 붙입니다.

```bash
helm template payment-op ./payment-operator -n payment --include-crds > payment-op.yaml
kubectl apply -f payment-op.yaml -n payment
kubectl wait --for=condition=Established crd/refunds.pay.example.com
kubectl apply -f payment-op.yaml -n payment
```

차트에 따라 CRD를 `templates/`에 두고 값으로 켜고 끕니다(cert-manager의 `--set crds.enabled=true`). 값 이름은 `helm show values <차트> | grep -i -A3 crd`로 찾습니다.

### 6-2. Kustomize

<details>
<summary>기초부터: kustomization.yaml 하나가 하는 일과 build, apply의 차이</summary>

> **핵심 한 줄**: Kustomize는 디렉터리의 `kustomization.yaml`을 읽어 가져오기, 바꾸기, 결과 출력의 세 단계를 하고 build는 출력만, `apply -k`는 적용까지 합니다.

#### 1. 왜 필요한가
Kustomize는 디렉터리 안의 매니페스트 파일을 직접 고르지 않습니다. 그 디렉터리의 `kustomization.yaml`을 찾아 읽습니다. 파일 이름이 정확히 `kustomization.yaml`(또는 `.yml`, `Kustomization`)이어야 합니다. 무엇을 가져오고 무엇을 바꿀지가 전부 이 파일 하나에 적힙니다.

#### 2. 어떻게 동작하나
1. **가져오기**: `resources`에 파일이나 다른 kustomization 디렉터리를 나열합니다.
2. **바꾸기**: 레이블 붙이기, 네임스페이스 지정, 이름 앞뒤에 글자 붙이기, 이미지 바꾸기, 패치 같은 변형을 적습니다.
3. **결과 출력**: 바꾼 최종 YAML을 내보냅니다.

```yaml
# board/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
- deployment.yaml
- service.yaml
labels:
- pairs:
    team: board
```

```text
board/kustomization.yaml → resources 읽기 → 변형 적용 → 최종 YAML
   ├ kubectl kustomize board/   → 화면 출력(미리보기)
   └ kubectl apply -k board/    → 클러스터에 적용
```

#### 3. 한눈에 비교
| 명령 | 결과 |
|---|---|
| `kubectl kustomize board/` 또는 `kustomize build board/` | 최종 YAML을 화면에 출력만 함. 클러스터에는 아무것도 안 생김 |
| `kubectl apply -k board/` | 같은 결과를 바로 적용 |
| `kustomize build board/ \| kubectl apply -f -` | 출력을 파이프로 넘겨 적용. `-f -`의 `-`는 "파일 대신 표준 입력에서 읽으라"는 뜻 |
| `kubectl delete -k board/` | 같은 결과에 해당하는 오브젝트 삭제 |

`-f`가 파일을 뜻하듯 `-k`는 kustomization 디렉터리를 뜻합니다.

#### 4. 헷갈리는 점
- build만 하고 `kubectl get`을 쳐서 아무것도 없다고 놀라는 경우가 많은데 build는 미리보기입니다.
- **base와 overlay**가 이 구조의 확장입니다. base 디렉터리에 모든 환경에 공통인 YAML과 kustomization을 둡니다. overlays/staging, overlays/prod에는 `resources: [../../base]`로 base를 가져오고 그 환경에서 바꿀 것만 적은 kustomization을 둡니다. 개발 환경이 base와 같다면 overlay를 따로 만들 필요도 없습니다. `../../base`는 overlays/prod에서 두 단계 위로 올라가 base로 들어가는 상대 경로입니다.
- kubectl 안에 Kustomize가 들어 있어 따로 설치하지 않아도 됩니다. 다만 kubectl에 내장된 버전은 최신 kustomize보다 늦을 수 있어 새 기능이 필요하면 kustomize 바이너리를 따로 설치합니다. 내장 버전은 `kubectl version --client`에 나옵니다. 따로 설치할 때는 kustomize 문서의 설치 스크립트(`curl -s "https://raw.githubusercontent.com/kubernetes-sigs/kustomize/master/hack/install_kustomize.sh" | bash`)를 씁니다. 이 스크립트는 OS에 맞는 바이너리를 현재 디렉터리에 내려받기만 하므로 PATH에 있는 디렉터리(`/usr/local/bin` 등)로 옮긴 뒤 `kustomize version`으로 확인합니다.

> **정리**: `kubectl kustomize`로 결과를 본 뒤 `kubectl get`에 아무것도 없다면 아직 적용하지 않은 상태입니다. 적용은 `apply -k`로 하고 overlay는 `resources: [../../base]`로 base를 가져와 그 환경에서 바꿀 것만 적습니다.

</details>

Kustomize는 원본 YAML을 고치지 않고 `kustomization.yaml`에 적은 변형을 덧입혀 결과를 만듭니다.

```bash
kubectl kustomize ./overlays/prod   # 결과만 출력
kubectl apply -k ./overlays/prod    # 적용
kubectl diff -k ./overlays/prod
kubectl delete -k ./overlays/prod
```

```yaml
# overlays/prod/kustomization.yaml (쇼핑몰 주문 API)
resources:
  - ../../base
namespace: shop
namePrefix: prod-
images:
  - name: order-api
    newTag: "1.4.2"
patches:
  - path: replica-patch.yaml
configMapGenerator:
  - name: order-config
    literals:
      - LOG_LEVEL=info
```

- base는 overlay를 모릅니다. 같은 base를 여러 overlay가 가져다 씁니다.
- `configMapGenerator`, `secretGenerator`가 만든 이름에는 내용 해시가 붙습니다. 내용이 바뀌면 이름이 바뀌어 참조하는 Deployment가 롤아웃됩니다. 끄려면 `generatorOptions.disableNameSuffixHash: true`입니다.

### 6-3. Helm 릴리스 기록과 롤백

<details>
<summary>기초부터: Helm 2와 3의 차이, 3-way 병합, 롤백이 되돌리지 않는 것</summary>

> **핵심 한 줄**: Helm 3는 Tiller를 없애 내 RBAC 권한으로 직접 동작하고 이전, 새, 라이브 세 상태를 비교해 바꾸며 롤백은 새 리비전을 쌓아 매니페스트만 되돌립니다.

#### 1. 왜 필요한가
온라인 자료에 Helm 2와 3 이야기가 섞여 있어 차이를 알아 두지 않으면 옛 설명을 그대로 믿게 됩니다. Helm 2는 2016년 11월, Helm 3는 2019년 11월에 나왔고 Helm 2는 2020년 11월에 지원이 끝났습니다.

| 구분 | Helm 2 | Helm 3 |
|---|---|---|
| 클러스터 안 서버 | Tiller가 helm CLI 요청을 받아 API 서버에 오브젝트를 만듦 | 없음. helm CLI가 내 kubeconfig로 API 서버에 직접 요청 |
| 권한 | 당시 RBAC이 성숙하지 않아 Tiller가 대개 모든 권한으로 돎. Tiller에 닿는 사람은 누구나 클러스터 전체를 조작 | Helm으로 바꾸든 kubectl로 바꾸든 같은 RBAC 권한이 적용 |
| 변경 계산 | 이전 매니페스트와 새 매니페스트 두 개만 비교 | 이전 매니페스트, 새 매니페스트, 지금 클러스터의 라이브 상태 셋을 비교(3-way 병합) |

#### 2. 어떻게 동작하나: 3-way 병합
1. **라이브 객체가 바뀐 상황**: 누가 `kubectl set image`로 라이브 객체를 직접 바꿨습니다.
2. **Helm 2**: 두 매니페스트에는 그 흔적이 없으니 롤백해도 직접 바꾼 값이 남거나 업그레이드 때 엉뚱하게 처리됐습니다.
3. **Helm 3**: 라이브 상태가 기록과 다르면 그 차이까지 보고 목표 상태로 맞춥니다.
4. **업그레이드에서 보이는 차이**: 서비스 메시가 라이브 Deployment에 사이드카 컨테이너를 주입해 둔 상태에서 차트를 올려 이미지 태그만 바꾼다고 해 봅니다. Helm 2는 이전과 새 매니페스트만 비교하므로 매니페스트에 없는 사이드카를 지웠습니다. Helm 3는 새 매니페스트가 태그를 바꾼다는 점과 라이브 상태에 사이드카가 있다는 점을 함께 보고 태그만 바꾼 뒤 사이드카는 그대로 둡니다.

```text
이전 매니페스트 ┐
새 매니페스트   ├→ 비교 → 목표 상태로 맞춤
라이브 상태     ┘  (kubectl로 직접 바꾼 값도 보임)
```

#### 3. 리비전은 쌓이기만 합니다
```text
리비전 1  install   nginx 차트 버전 A
리비전 2  upgrade   차트 버전 B (이미지가 새 버전으로)
리비전 3  rollback  "Rollback to 1" (내용은 리비전 1과 같음)
```

- `helm rollback <릴리스> 1`은 리비전 1의 내용을 그대로 복사해 새 리비전 3을 만듭니다. 리비전 번호는 앞으로만 나아갑니다.
- 이력이 지워지지 않으니 롤백한 사실도 `helm history`에 남습니다.

| 명령 | 보여 주는 것 |
|---|---|
| `helm list` | 릴리스마다 현재 리비전만 |
| `helm history <릴리스>` | 리비전마다 차트 버전, 앱 버전, 작업 종류(install, upgrade, rollback) |

#### 4. 헷갈리는 점: 롤백이 되돌리지 않는 것
- 롤백은 매니페스트만 되돌립니다. Deployment의 이미지와 설정은 예전으로 돌아가지만 PV 안의 데이터나 외부 DB의 내용은 그대로입니다.
- DB 스키마를 바꾸는 업그레이드였다면 롤백 뒤 옛 앱이 새 스키마를 만나 깨질 수 있습니다. 그래서 상태 있는 앱은 업그레이드 전에 데이터를 따로 백업하고 차트에 따라 훅(hook, 설치나 업그레이드 앞뒤에 Job을 돌리는 기능)으로 백업 단계를 넣습니다.
- WordPress처럼 관리자 비밀번호를 받는 차트는 업그레이드 때 그 값을 다시 넘겨야 하는 경우도 있으니 차트 README를 봅니다.

> **정리**: `helm rollback <릴리스> 1`을 해도 리비전 번호는 줄지 않고 리비전 1을 복사한 새 번호가 `helm history`에 쌓입니다. 롤백은 PV나 외부 DB의 데이터를 건드리지 않으니 상태 있는 앱은 업그레이드 전에 따로 백업합니다.

</details>

Helm 3부터 Tiller가 없고 helm은 kubeconfig 자격 증명으로 API 서버에 직접 요청하므로 할 수 있는 일은 그 사용자의 RBAC 권한과 같습니다. 릴리스 기록은 릴리스 네임스페이스의 Secret(`sh.helm.release.v1.<릴리스>.v<리비전>`)에 남고 `kubectl get secret -n shop -l owner=helm`으로 보입니다.

`helm rollback`은 과거 내용으로 새 리비전을 만듭니다. 리비전 3에서 1로 롤백하면 리비전 4가 생기고 설명은 `Rollback to 1`입니다. PV 안의 데이터는 되돌리지 않습니다.

### 6-4. Kustomize 변형 필드와 패치 두 종류

<details>
<summary>기초부터: 트랜스포머와 패치, 목록 항목을 고치는 법</summary>

> **핵심 한 줄**: 트랜스포머는 가져온 모든 리소스에 같은 변경을 한꺼번에 걸고 패치는 특정 오브젝트만 골라 정밀하게 고칩니다.

#### 1. 왜 필요한가
"모든 리소스에 `team: board` 레이블"과 "웹 Deployment의 두 번째 컨테이너만 삭제"는 범위가 전혀 다른 변경입니다. Kustomize는 이 둘을 트랜스포머와 패치로 나눠 맡깁니다.

#### 2. 트랜스포머
| 필드 | 하는 일 | 예 |
|---|---|---|
| `labels`(옛 `commonLabels`) | 모든 리소스에 레이블. `includeSelectors: true`면 셀렉터에도 | `team: board` |
| `commonAnnotations` | 모든 리소스에 어노테이션 | `oncall: board-team` |
| `namespace` | 모든 리소스의 네임스페이스 지정 | `board` |
| `namePrefix`, `nameSuffix` | 모든 리소스 이름 앞뒤에 글자 | `dev-web-001` |
| `images` | 이미지 이름과 태그 교체 | 아래 |

`commonLabels`는 kustomize v5에서 사용 중단되어 `labels`로 옮겨 가고 `commonAnnotations`는 사용 중단 표시가 없습니다.

`images`의 `name`은 매니페스트의 `image:` 값과 맞춥니다. 컨테이너 이름(`containers[].name`)과는 관계가 없습니다. 컨테이너 이름이 `web`이고 이미지가 `mongo`라면 `name: mongo`로 찾습니다.

```yaml
images:
- name: mongo          # 바꿀 대상 이미지 이름
  newName: postgres    # 이미지 자체 교체(생략 가능)
  newTag: "16.4"       # 태그 교체. 반드시 따옴표
```

#### 3. 패치 두 형식
1. **JSON 6902 패치**: 연산(`op`), 경로(`path`), 값(`value`)의 목록입니다. 연산은 `add`, `remove`, `replace`를 주로 쓰고 `remove`에는 값이 없습니다. 경로는 YAML 트리를 `/`로 내려간 주소이고 목록 항목은 0부터 세는 번호로 가리킵니다. `target`으로 kind, name, namespace, labelSelector 등을 조합해 대상을 고릅니다.
2. **Strategic merge 패치**: 원본 오브젝트에서 바꿀 부분만 남긴 조각입니다. 평범한 매니페스트처럼 읽혀 알아보기 쉽고 대상은 조각 안의 kind와 `metadata.name`으로 정해집니다. 컨테이너 목록은 번호 대신 `name`을 키로 병합됩니다.

```text
JSON 6902:       /spec/template/spec/containers/0/image   ← 번호로 찾아감
Strategic merge: containers: [{name: web, ...}]            ← 이름으로 찾아감
```

| 하고 싶은 일 | JSON 6902 | Strategic merge |
|---|---|---|
| 첫 컨테이너 이미지 교체 | `op: replace`, `path: /spec/template/spec/containers/0/image` | `containers: [{name: web, image: nginx:1.28}]` |
| 컨테이너 추가 | `op: add`, `path: .../containers/-`(끝에 추가. 번호를 주면 그 자리) | 새 이름의 컨테이너를 적으면 기존 목록과 합쳐짐 |
| 두 번째 컨테이너 삭제 | `op: remove`, `path: .../containers/1` | `containers: [{name: db, $patch: delete}]` |

#### 4. 헷갈리는 점 / 실전에서 보이는 모습
- `newTag: 16.4`처럼 따옴표 없이 쓰면 YAML이 숫자로 읽어 `cannot unmarshal number into ... of type string` 오류가 납니다.
- strategic merge에서 삭제에만 `$patch: delete`가 필요한 이유는 "적지 않은 것은 그대로 둔다"가 이 형식의 기본 규칙이기 때문입니다. 지우고 싶다는 뜻을 따로 밝혀야 합니다.
- 두 형식 모두 `patches` 안에 인라인(`patch: |-` 뒤에 내용)으로 쓰거나 별도 파일(`path: replica-patch.yaml`)로 뺄 수 있습니다. 패치가 적으면 인라인, 많으면 파일로 빼서 kustomization.yaml을 짧게 유지합니다.

> **정리**: 목록 항목은 JSON 6902가 번호로, strategic merge가 이름으로 찾고 삭제는 `remove`나 `$patch: delete`로 밝힙니다. `images`의 `name`은 컨테이너 이름과 무관하게 이미지 이름으로 맞추고 `newTag`에는 따옴표를 붙입니다.

</details>

`namePrefix`는 같은 빌드 안의 참조(Deployment의 ConfigMap 이름 등)도 함께 바꿉니다. `labels`는 `includeSelectors: true`일 때만 셀렉터에 들어가고 `commonLabels`는 kustomize v5에서 사용 중단되었습니다. 배포된 Deployment에 셀렉터 레이블을 더하면 `spec.selector: ... field is immutable`로 실패합니다.

개별 수정은 `patches` 하나로 두 형식을 받습니다. strategic merge 파일(`replica-patch.yaml`)은 `apiVersion`, `kind`, `metadata.name`과 바꿀 필드만 담은 Deployment 조각이고 컨테이너 목록은 `name`을 키로 병합됩니다.

```yaml
# overlays/prod/kustomization.yaml
resources:
  - ../../base
patches:
  # 1) strategic merge: 바꿀 부분만 담은 조각. 대상은 파일 안의 kind와 name
  - path: replica-patch.yaml
  # 2) JSON 6902: 연산 목록. target 필수
  - target:
      group: apps
      version: v1
      kind: Deployment
      name: order-api
    patch: |-
      - op: replace
        path: /spec/replicas
        value: 5
```

옛 자료의 `patchesStrategicMerge`, `patchesJson6902`, `bases` 필드는 사용 중단되었습니다. 지금은 `patches`와 `resources`에 적습니다.

### 6-5. kustomize build와 kubectl kustomize

<details>
<summary>기초부터: 디렉터리 계층과 변형의 적용 범위, overlay와 Components</summary>

> **핵심 한 줄**: 변형은 그 변형을 적은 kustomization이 모은 리소스에만 걸리고 overlay와 Components는 이 규칙으로 공통 부분과 선택 기능을 나눕니다.

#### 1. 왜 필요한가
매니페스트가 수십 개로 늘면 `api/`, `db/`처럼 하위 디렉터리로 나누고 싶어집니다. 그냥 나누면 `kubectl apply -f k8s/api/`, `kubectl apply -f k8s/db/`를 디렉터리마다 따로 쳐야 합니다.

| 단계 | 방법 | 한계 |
|---|---|---|
| 루트 하나에 전부 나열 | 루트 kustomization.yaml의 `resources`에 `api/api-deployment.yaml`처럼 모든 파일을 상대 경로로 나열 | `kubectl apply -k k8s/` 한 번이면 되지만 디렉터리가 늘수록 목록이 길어짐 |
| 디렉터리마다 kustomization | 하위 디렉터리마다 자기 파일만 나열하고 루트는 `resources: [api, db]`처럼 디렉터리만 가리킴 | Kustomize가 각 디렉터리로 내려가 그곳의 kustomization을 읽고 결과를 모음 |

#### 2. 어떻게 동작하나: 적용 범위
```text
k8s/
├── kustomization.yaml     resources: [api, db]  namespace: board  namePrefix: board-
├── api/
│   ├── kustomization.yaml resources: [deployment.yaml, service.yaml]  nameSuffix: -web
│   └── ...
└── db/
    ├── kustomization.yaml resources: [deployment.yaml, service.yaml]  images: [{name: mongo, newName: postgres, newTag: "16.4"}]
    └── ...
```

| 변형 | 적은 곳 | 걸리는 리소스 |
|---|---|---|
| `namespace`, `namePrefix` | 루트 | api와 db 모두 |
| `nameSuffix` | `api/` | api 리소스만 |
| `images` | `db/` | db 리소스만 |

전역 규칙은 루트에, 디렉터리별 규칙은 하위에 두는 것이 기본 패턴입니다. 이미지 교체처럼 다른 곳에 같은 이미지가 있을 수 있는 변형은 범위를 좁혀 하위에 둡니다.

#### 3. overlay와 Components
1. **overlay**: 같은 원리입니다. overlay의 kustomization은 base를 `resources`로 가져오고 패치를 얹습니다. base에 없는 리소스도 `resources`에 더할 수 있어서 운영 overlay에만 모니터링 Deployment를 추가하는 식으로 씁니다. overlay의 디렉터리 모양이 base와 같을 필요도 없습니다.
2. **Components**: overlay 몇 개에만 필요한 선택 기능을 묶습니다. 게시판을 dev, premium, standalone 세 변형으로 배포하는데 캐시(Redis)는 premium과 standalone에만, 외부 DB는 dev와 premium에만 필요하다고 해 봅니다. base에 넣으면 세 변형 모두에 들어가고 overlay마다 복사하면 한쪽만 고치는 불일치가 생깁니다. Component는 기능 하나에 필요한 리소스와 패치를 한 디렉터리에 담아 두고 필요한 overlay가 가져다 씁니다.

| 기능 | dev | premium | standalone |
|---|---|---|---|
| 캐시(Redis) | | O | O |
| 외부 DB | O | O | |

```yaml
# components/cache/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1alpha1   # 일반 kustomization과 다름
kind: Component
resources:
- redis-deployment.yaml
patches:
- path: add-cache-env.yaml     # base의 웹 Deployment에 캐시 주소 환경 변수 추가
```

```yaml
# overlays/premium/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
- ../../base
components:
- ../../components/cache
- ../../components/external-db
```

#### 4. 헷갈리는 점
- 옛 자료의 `bases:` 필드는 사용 중단되었고 지금은 `resources:`에 base 경로를 함께 적습니다.
- Component의 `apiVersion`은 `v1alpha1`, `kind`는 `Component`로 일반 kustomization과 다릅니다.

> **정리**: 변형은 적은 자리 아래로만 걸리니 전역은 루트, 국소는 하위에 둡니다. 모든 환경 공통은 base, 환경별 차이는 overlay, 일부 환경만의 기능은 Component로 나눕니다.

</details>

`kustomize build <디렉터리>`와 `kubectl kustomize <디렉터리>`는 둘 다 출력만 합니다. 적용은 `kubectl apply -k` 또는 `kustomize build <디렉터리> | kubectl apply -f -`입니다. 내장 Kustomize 버전은 `kubectl version --client`에 나옵니다. `components`(`kind: Component`)는 범위 밖이라 이름만 알아 둡니다.

### 6-6. 헷갈리는 지점

- `helm install`의 인자 순서는 `[NAME] [CHART]`입니다. 이름을 빼면 `Error: INSTALLATION FAILED: must either provide a name or specify --generate-name`이 납니다.
- `-f`와 `--set`을 함께 주면 `--set`이 우선합니다.
- Kustomize `images`의 `name`은 매니페스트의 이미지 이름과 맞춰집니다. 컨테이너 이름과는 무관합니다.
- 변형 필드는 그 필드를 적은 `kustomization.yaml`이 모은 리소스에만 걸립니다. 루트가 `resources: [api/, db/]`로 하위 디렉터리를 가져오면 루트의 `namespace`, `labels`는 전체에, `api/kustomization.yaml`의 `namePrefix`는 api 리소스에만 걸립니다.

### 6-7. 직접 해 보기

게시판 base(Deployment, Service)와 `dev`, `prod` overlay를 만들고 prod에 6-4절의 두 패치 형식을 넣어 `kubectl kustomize`로 비교합니다. `helm create`로 만든 로컬 차트를 설치, 업그레이드, 롤백한 뒤 `helm history`의 리비전과 `-l owner=helm` Secret 수를 맞춰 봅니다.

## 7. 확장 인터페이스: CNI, CSI, CRI

<details>
<summary>기초부터: 런타임, 네트워크, 스토리지를 왜 인터페이스로 떼어 냈는지</summary>

> **핵심 한 줄**: 쿠버네티스는 무엇을 요청할지만 정하고 구현은 바깥 프로그램이 맡도록 런타임(CRI), 네트워크(CNI), 스토리지(CSI)에 규격을 하나씩 두었습니다.

#### 1. 왜 필요한가
초기 쿠버네티스는 Docker 연동 코드와 여러 클라우드의 스토리지 드라이버를 자기 소스 코드 안(in-tree)에 품고 있었습니다. 이러면 문제가 셋 생깁니다.

1. **새 제품 추가가 느림**: 새 스토리지 제품을 붙이려면 쿠버네티스 본체에 코드를 넣고 릴리스를 기다려야 합니다.
2. **버그 수정이 무거움**: 드라이버 버그를 고치려 해도 쿠버네티스 전체를 다시 배포해야 합니다.
3. **바이너리가 무거움**: 쓰지도 않는 클라우드 코드가 모든 클러스터의 바이너리에 들어갑니다.

| 구분 | in-tree(예전) | 인터페이스(지금) |
|---|---|---|
| 드라이버 위치 | 쿠버네티스 소스 안 | 바깥 프로그램 |
| 새 드라이버 | 본체 수정과 릴리스 대기 | 규격에 맞게 만들면 끝 |
| 설치와 업그레이드 | 쿠버네티스와 함께 | DaemonSet이나 Deployment로 따로 |

#### 2. 어떻게 동작하나
```text
kubelet ──CRI──> 컨테이너 런타임(containerd, CRI-O)
                    └──CNI──> 네트워크 플러그인(Calico, Cilium, Flannel)
볼륨 계층 ──CSI──> 스토리지 드라이버(클라우드 디스크, NFS, Ceph CSI)
```

1. **요청 쪽**: 쿠버네티스 구성요소가 규격에 정해진 호출만 합니다.
2. **구현 쪽**: 벤더는 쿠버네티스 팀의 허락이나 본체 수정 없이 규격에 맞는 드라이버만 만들면 됩니다.
3. **배포**: 사용자는 드라이버를 DaemonSet이나 Deployment로 설치하고 쿠버네티스와 따로 올립니다.

#### 3. 한눈에 비교
| 인터페이스 | 쿠버네티스 쪽 | 바깥 구현 예 |
|---|---|---|
| CRI | kubelet이 컨테이너 생성과 이미지 관리를 요청 | containerd, CRI-O(Docker Engine은 cri-dockerd를 거쳐야 함) |
| CNI | 런타임이 Pod 네트워크 연결을 요청 | Calico, Cilium, Flannel |
| CSI | 볼륨 계층이 디스크 생성, 연결, 마운트를 요청 | 클라우드 디스크 드라이버, NFS, Ceph CSI |

#### 4. 헷갈리는 점
- CNI와 CSI는 쿠버네티스 전용도 아니어서 다른 오케스트레이터도 같은 규격을 씁니다.
- Docker Engine은 CRI를 구현하지 않습니다. 쿠버네티스 안에 있던 Docker 연동 코드(dockershim)는 1.24에서 제거됐고 Docker Engine을 계속 쓰려면 cri-dockerd가 필요합니다. 관계는 [3편 2-3절](/blog/cert/cka/cka-01-why-kubernetes)의 Docker와 containerd 설명을 함께 봅니다.

> **정리**: Docker Engine은 CRI를 구현하지 않아 1.24부터 cri-dockerd를 거쳐야 합니다. 드라이버가 본체 밖으로 나온 만큼 CNI와 CSI 드라이버는 DaemonSet이나 Deployment로 따로 설치하고 올립니다. 아래 두 토글에서 CNI와 CSI가 실제로 어떤 순서로 불리는지 봅니다.

</details>

커리큘럼 문구는 "Understand extension interfaces (CNI, CSI, CRI, etc.)"입니다. 셋 다 쿠버네티스를 다시 빌드하지 않고 바깥 구현을 끼우는 규약입니다.

| 인터페이스 | 누가 부르는지 | 맡기는 일 | 확인할 곳 |
|---|---|---|---|
| CRI | kubelet(gRPC) | 컨테이너와 이미지 관리 | kubelet `--container-runtime-endpoint`, `crictl` |
| CNI | 컨테이너 런타임 | Pod IP 할당과 라우팅 | `/etc/cni/net.d`(설정), `/opt/cni/bin`(플러그인) |
| CSI | 쿠버네티스 볼륨 계층 | 스토리지 연결과 마운트 | `kubectl get csidrivers`, StorageClass `provisioner` |

### 7-1. CRI

dockershim은 1.24에서 빠졌고 노드에는 containerd나 CRI-O 같은 CRI 런타임이 있습니다. Docker Engine을 쓰려면 cri-dockerd가 필요하고 소켓 경로는 2-4b절 표에 있습니다. 노드에서 컨테이너를 보는 도구가 `crictl`입니다.

### 7-2. CNI

<details>
<summary>기초부터: CNI 플러그인이 호출되는 순서와 각자의 몫</summary>

> **핵심 한 줄**: CNI는 "컨테이너 하나를 네트워크에 붙여라, 떼어라"를 부탁하는 규격이고 Pod가 생길 때 런타임이 플러그인 실행 파일을 ADD로 불러 인터페이스와 IP를 받습니다.

#### 1. 왜 필요한가
컨테이너 플랫폼마다 브리지 만들기, IP 나눠 주기, 네임스페이스에 인터페이스 넣기를 따로 구현하던 중복을 없애려고 CNI(Container Network Interface)가 나왔습니다. 규격은 부탁하는 방법과 결과를 돌려주는 방법만 정합니다.

#### 2. 어떻게 동작하나(1.24 이후 노드)
1. **샌드박스 요청**: kubelet이 CRI로 런타임(containerd, CRI-O)에 Pod 샌드박스를 만들라고 요청합니다. kubelet은 CNI를 직접 부르지 않습니다.
2. **네임스페이스 생성**: 런타임이 pause 컨테이너와 새 네트워크 네임스페이스를 만듭니다.
3. **플러그인 호출**: 런타임이 `/etc/cni/net.d/`에서 사전순으로 첫 설정 파일을 읽고 그 안의 `type`에 적힌 플러그인 실행 파일을 `/opt/cni/bin/`에서 찾아 실행합니다. 이때 `CNI_COMMAND=ADD`, 네트워크 네임스페이스 경로, 인터페이스 이름(`eth0`)을 환경 변수로, 설정 JSON을 표준 입력으로 넘깁니다.
4. **실제 연결**: 플러그인이 노드 쪽과 Pod 쪽을 잇는 veth 쌍을 만들어 한쪽을 Pod 네임스페이스에 넣습니다. IPAM으로 IP를 받아 붙이고 경로를 설정합니다. 결과(IP, 경로)를 JSON으로 표준 출력에 돌려줍니다.
5. **정리**: Pod가 지워지면 런타임이 같은 방식으로 `CNI_COMMAND=DEL`을 보내 정리합니다.

```text
kubelet ─CRI─> 런타임: pause 컨테이너 + netns 생성
  → /etc/cni/net.d/ 첫 설정 파일 → type → /opt/cni/bin/<플러그인>
  → ADD (환경 변수 + 표준 입력 JSON)
  → 플러그인: veth 쌍, IPAM으로 IP, 경로 → 결과 JSON(표준 출력)
Pod 삭제 → DEL
```

#### 3. 한눈에 비교
| 런타임이 하는 일 | 플러그인이 하는 일 |
|---|---|
| 네트워크 네임스페이스 생성 | 인터페이스(veth) 만들어 넣기 |
| 생성과 삭제 시점에 ADD, DEL 호출 | IP 할당(IPAM)과 경로 설정 |
| 설정 파일(JSON) 전달 | 결과를 정해진 형식으로 반환 |

| 플러그인 종류 | 예 | 설치 방식 |
|---|---|---|
| CNI 프로젝트 기본 플러그인 | bridge, host-local, loopback, portmap 등 | 실행 파일 |
| 서드파티 | Calico, Cilium, Flannel | 보통 노드마다 DaemonSet으로 에이전트를 띄우고 그 에이전트가 설정 파일과 실행 파일을 위 두 디렉터리에 깔아 줌 |

#### 4. 헷갈리는 점 / 실전에서 보이는 모습
- CNI를 설치하기 전 노드가 `NotReady`인 것도 이 디렉터리가 비어 있어서입니다. `kubectl describe node`의 Ready 조건 메시지에 `NetworkPluginNotReady`, `cni plugin not initialized` 같은 문구가 보입니다.
- Docker는 CNI 대신 자체 모델(CNM)을 써서 Docker CLI의 네트워크와 쿠버네티스 Pod 네트워크는 별개입니다.

> **정리**: kubelet은 CNI를 직접 부르지 않으니 Pod IP 문제는 런타임이 읽는 `/etc/cni/net.d/`와 `/opt/cni/bin/`부터 봅니다. 설정 파일이 없으면 노드는 NotReady에 머뭅니다.

</details>

1.24부터 kubelet의 `network-plugin` 플래그가 사라졌고 런타임이 CNI 플러그인을 부릅니다. Pod IP가 안 잡히면 `/etc/cni/net.d`의 설정과 플러그인 Pod 상태부터 봅니다. NetworkPolicy는 CNI 플러그인이 지원해야 동작합니다.

CNI 업체 사이트는 허용 문서 목록에 없으니 과제가 주는 매니페스트나 URL을 씁니다. 순서는 클러스터 Pod CIDR 확인(kubeadm은 `--pod-network-cidr`를 kube-controller-manager의 `--cluster-cidr`로 넣음), 매니페스트나 Helm 값의 대역을 클러스터 값에 맞추기, 적용 뒤 노드 `Ready`와 CoreDNS `Running` 확인입니다.

```bash
sudo grep -E 'cluster-cidr|allocate-node-cidrs' /etc/kubernetes/manifests/kube-controller-manager.yaml
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.podCIDR}{"\n"}{end}'

kubectl apply -f <과제가 준 CNI 매니페스트>
kubectl get pods -n kube-system -o wide -w     # 플러그인 DaemonSet Pod
kubectl get nodes                               # NotReady -> Ready
sudo ls /etc/cni/net.d/
```

Calico는 자체 IPAM을 써서 노드의 `spec.podCIDR`(예: `10.244.1.0/24`)와 실제 Pod IP(예: `10.244.140.x`)가 다를 수 있고 클러스터 대역 안이면 정상입니다. Helm 차트라면 `helm show values`로 대역 값의 키 이름부터 찾습니다.

### 7-3. CSI

<details>
<summary>기초부터: PVC 하나가 실제 디스크가 되기까지 CSI 호출 순서</summary>

> **핵심 한 줄**: CSI는 오케스트레이터와 스토리지 드라이버 사이의 gRPC 규격이고 PVC가 디스크가 되기까지 생성, 연결, 마운트의 세 호출이 차례로 불립니다.

#### 1. 왜 필요한가
CSI(Container Storage Interface)는 어떤 함수(RPC)를 어떤 매개변수로 부르고 실패하면 어떤 오류 코드를 돌려줄지 정해 둡니다. 덕분에 스토리지 벤더는 이 RPC만 구현하면 됩니다. 드라이버는 보통 두 부분으로 설치됩니다.

| 부분 | 배포 | 맡는 일 |
|---|---|---|
| 컨트롤러 쪽 | 클러스터에 하나(Deployment) | 디스크 생성, 삭제, 노드에 붙이기. 쿠버네티스 오브젝트를 지켜보다 CSI 호출로 바꿔 주는 사이드카(external-provisioner, external-attacher 등)가 붙어 있음 |
| 노드 쪽 | 노드마다(DaemonSet) | 그 노드에서 포맷과 마운트 |

#### 2. 어떻게 동작하나(kubernetes-csi 문서 기준)
1. **생성**: external-provisioner가 새 PVC를 보고 드라이버에 `CreateVolume`(이름, 크기, StorageClass 매개변수)을 부릅니다. 드라이버가 스토리지에 디스크를 만들면 PV가 생기고 PVC에 바인딩됩니다. StorageClass가 `Immediate`면 PVC를 만들자마자, `WaitForFirstConsumer`면 그 PVC를 쓰는 Pod가 노드에 배정된 뒤에 부릅니다.
2. **연결**: Pod가 노드에 배정되면 VolumeAttachment 오브젝트가 생기고 external-attacher가 `ControllerPublishVolume`을 불러 디스크를 그 노드에 붙입니다. NFS처럼 붙이기 단계가 없는 드라이버는 건너뜁니다.
3. **마운트**: 그 노드의 kubelet이 노드 쪽 드라이버에 `NodeStageVolume`(노드 공용 경로에 포맷과 마운트)과 `NodePublishVolume`(Pod 경로에 마운트)을 부릅니다. 이제 컨테이너에서 볼륨이 보입니다.
4. **해제**: Pod가 지워지면 역순으로 언마운트와 분리가 일어납니다. 디스크 자체는 남습니다.
5. **삭제**: `DeleteVolume`은 PVC가 지워지고 PV의 reclaim 정책이 `Delete`일 때 불립니다. Pod를 지울 때는 불리지 않습니다. `Retain`이면 디스크가 남습니다.

```text
PVC 생성 → external-provisioner → CreateVolume → PV 생성, 바인딩
Pod 배정 → VolumeAttachment → external-attacher → ControllerPublishVolume(노드에 붙임)
         → kubelet → NodeStageVolume → NodePublishVolume → 컨테이너에서 보임
Pod 삭제 → 언마운트, 분리(디스크는 남음)
PVC 삭제 + reclaim Delete → DeleteVolume
```

#### 3. 한눈에 비교: 디스크 수명은 무엇을 따라가나
| 사건 | 불리는 호출 | 디스크 |
|---|---|---|
| PVC 생성 | `CreateVolume` | 생김 |
| Pod 생성, 배정 | `ControllerPublishVolume`, `NodeStageVolume`, `NodePublishVolume` | 노드에 붙고 마운트 |
| Pod 삭제 | 언마운트, 분리 | 남음 |
| PVC 삭제(`Delete`) | `DeleteVolume` | 지워짐 |
| PVC 삭제(`Retain`) | 없음 | 남음 |

#### 4. 헷갈리는 점 / 실전에서 보이는 모습
- 옛 강의는 "Pod가 생기면 CreateVolume, Pod가 지워지면 DeleteVolume"으로 줄여 설명하는데 실제로 디스크의 수명은 PVC와 PV를 따라갑니다. 그래서 Pod를 지웠다 다시 만들어도 같은 PVC를 쓰면 데이터가 남습니다.
- `WaitForFirstConsumer` StorageClass의 PVC는 Pod가 생기기 전까지 `Pending`이고 이벤트에 `waiting for first consumer to be created before binding`이 보입니다. 고장이 난 것은 아닙니다.

> **정리**: Pod를 지워도 디스크는 남고 `DeleteVolume`은 PVC를 지울 때 reclaim 정책이 `Delete`여야 불립니다. `WaitForFirstConsumer` PVC가 `Pending`인 것은 Pod가 배정되기 전의 정상 상태입니다. 볼륨과 StorageClass의 시험 쪽 내용은 [8편](/blog/cert/cka/cka-05-storage)에 있습니다.

</details>

예전 볼륨 플러그인은 쿠버네티스 바이너리 안(in-tree)에 있었고 CSI가 이 결합을 끊었습니다. CSI 드라이버를 설치하면 StorageClass의 `provisioner`에 그 드라이버 이름을 적어 씁니다([8편](/blog/cert/cka/cka-05-storage)).

### 7-4. 직접 해 보기

노드에서 아래를 실행해 런타임, CNI, CSI 드라이버를 표로 적습니다.

```bash
sudo crictl info | head -20
ls /etc/cni/net.d/
kubectl get pods -n kube-system -o wide
kubectl get csidrivers
kubectl get nodes -o wide        # CONTAINER-RUNTIME 열
```

## 8. CRD와 오퍼레이터

커리큘럼 문구는 "Understand CRDs, install and configure operators"입니다.

### 8-1. CRD

<details>
<summary>기초부터: CRD가 API를 늘리는 방식과 커스텀 객체가 "저장만" 되는 이유</summary>

> **핵심 한 줄**: CRD는 API 서버에 새 리소스 종류를 가르치는 설계도이고 그 종류로 만든 커스텀 객체는 지켜보는 컨트롤러가 없으면 검사받고 etcd에 저장될 뿐입니다.

#### 1. 왜 필요한가
쿠버네티스 API에는 Pod, Deployment, Service 같은 내장 리소스가 있습니다. 내 서비스에 맞는 새 개념, 예를 들어 "게시판 정기 정리 작업(BoardJob)"을 쿠버네티스 방식(kubectl, RBAC, 선언형)으로 다루고 싶다면 API 서버에 새 종류를 가르쳐야 합니다. CustomResourceDefinition(CRD)이 그 수단입니다.

| 이름 | 정체 | 예 |
|---|---|---|
| CRD | 새 리소스 종류를 정의하는 오브젝트(설계도). 클러스터 범위 | `boardjobs.example.com` |
| CR(커스텀 리소스, 커스텀 객체) | 그 정의로 만든 실제 객체 | `kind: BoardJob`, `name: nightly-cleanup` |

#### 2. 어떻게 동작하나
1. **CRD apply**: API 서버가 `/apis/example.com/v1/namespaces/*/boardjobs` 경로를 새로 엽니다.
2. **내장 리소스처럼 동작**: 그때부터 `kubectl get boardjobs`, `apply`, `delete`, RBAC 규칙이 내장 리소스와 똑같이 동작합니다.
3. **CR 생성**: API 서버는 스키마로 검사하고 etcd에 저장한 뒤 `created`를 돌려줍니다.
4. **그다음**: 아무 일도 일어나지 않습니다. 지켜보는 컨트롤러가 없기 때문입니다.

```text
CRD apply → API 서버에 /apis/example.com/v1/.../boardjobs 경로 생김
BoardJob apply → 스키마 검사 → etcd 저장 → "created"
               → (컨트롤러 없음) → 아무 일도 없음
Deployment apply → etcd 저장 → Deployment 컨트롤러가 watch → ReplicaSet → Pod
```

#### 3. CRD 본문 각 칸의 쓰임
| 칸 | 쓰임 |
|---|---|
| `group`, `names` | API 경로와 kubectl에서 부를 이름(복수형, 단수형, kind, 줄임말). CRD 이름은 `<복수형>.<group>`이어야 함 |
| `scope` | `Namespaced`면 Pod처럼 네임스페이스 안에, `Cluster`면 Node처럼 클러스터에 하나씩 |
| `versions` | 버전마다 API로 노출할지(`served`)와 etcd에 어느 버전으로 저장할지(`storage`, 정확히 하나) |
| `schema.openAPIV3Schema` | 필드 형식 검사. 정수만, 최솟값 1, 최댓값 10 같은 규칙을 적으면 어긋난 객체를 API 서버가 저장 전에 거부. 잘못된 데이터가 etcd에 들어가지 않음 |

```yaml
apiVersion: example.com/v1
kind: BoardJob
metadata:
  name: nightly-cleanup
  namespace: board
spec:
  schedule: "0 3 * * *"
```

#### 4. 헷갈리는 점 / 실전에서 보이는 모습
- Deployment를 만들면 Pod가 생기는 것은 kube-controller-manager의 Deployment 컨트롤러가 지켜보고 일하기 때문인데 BoardJob을 지켜보는 컨트롤러는 아직 없습니다.
- CRD를 만들기 전에 CR부터 apply하면 `no matches for kind "BoardJob" in version "example.com/v1"` 오류가 나고 kubectl이 CRD를 먼저 설치하라고 안내합니다.
- CRD가 생겼는지는 `kubectl get crd`, 새 종류가 API에 보이는지는 `kubectl api-resources`로 확인합니다.

> **정리**: `no matches for kind` 오류는 CRD를 만들기 전에 CR부터 넣었을 때 납니다. CR이 저장됐는데 아무 일도 없다면 그 종류를 맡을 컨트롤러가 없는 상태이고 이 컨트롤러를 묶어 배포하는 방식이 다음 절의 오퍼레이터입니다.

</details>

CustomResourceDefinition을 만들면 API 서버가 새 리소스를 열고 그 뒤로는 `kubectl get`, `apply`, `delete`를 그대로 씁니다.

- CRD 자체는 클러스터 범위입니다. 커스텀 객체는 `spec.scope`에 따라 `Namespaced` 또는 `Cluster`입니다.
- CRD 이름은 `<plural>.<group>`입니다.
- 저장 버전(`storage: true`)은 정확히 하나입니다.

```yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: boardjobs.example.com        # <plural>.<group>
spec:
  group: example.com
  scope: Namespaced
  names:
    plural: boardjobs
    singular: boardjob
    kind: BoardJob
    shortNames: ["bj"]
  versions:
    - name: v1
      served: true
      storage: true
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              properties:
                schedule:
                  type: string
```

```bash
kubectl apply -f boardjob-crd.yaml
kubectl get crd boardjobs.example.com
kubectl api-resources --api-group=example.com
kubectl explain boardjob.spec
kubectl get bj -A
```

`kubectl explain`은 CRD 스키마도 보여 줍니다. apply 직후 몇 초는 `error: couldn't find resource for "example.com/v1, Resource=boardjobs"`가 나올 수 있고 `Established` condition이 된 뒤 다시 치면 됩니다.

### 8-2. 오퍼레이터

<details>
<summary>기초부터: 커스텀 컨트롤러에서 오퍼레이터까지</summary>

> **핵심 한 줄**: 커스텀 컨트롤러는 내가 정의한 리소스에 대해 관찰, 비교, 조치 루프를 도는 프로그램이고 오퍼레이터는 여기에 사람 운영자의 운영 지식까지 담습니다.

#### 1. 왜 필요한가
CRD만 있으면 BoardJob은 저장만 됩니다. 저장된 원하는 상태를 실제 상태로 만들어 줄 주체가 필요하고 그것이 커스텀 컨트롤러입니다. 내장 컨트롤러와 같은 루프를 돕니다([3편 1-2절](/blog/cert/cka/cka-01-why-kubernetes)).

#### 2. 어떻게 동작하나
1. **관찰**: API 서버에서 BoardJob 객체를 watch합니다.
2. **비교**: 객체의 spec(원하는 상태)과 실제 상태(만들어진 CronJob이 있는지, 일정이 맞는지)를 비교합니다.
3. **조치**: 차이를 메웁니다. CronJob을 만들거나 고치고 결과를 BoardJob의 status에 적습니다.

```text
API 서버 ─list/watch─> 인포머(로컬 캐시) ─바뀐 객체만─> workqueue
   → 컨트롤러가 하나씩 꺼냄 → spec과 실제 비교 → CronJob 생성/수정 → BoardJob status 기록
```

이 루프를 바닥부터 짜면 API 서버를 계속 조회하느라 부하가 커지고 재연결, 캐시, 작업 순서 처리를 모두 직접 만들어야 합니다. 그래서 컨트롤러는 대개 Go 언어와 공식 라이브러리 client-go로 만듭니다. client-go의 **인포머**(Informer)는 list와 watch로 객체를 로컬 캐시에 들고 있다가 바뀐 객체만 작업 큐(workqueue)에 넣어 줍니다. 공식 예제 저장소 `kubernetes/sample-controller`가 이 뼈대를 보여 줍니다. 완성된 컨트롤러는 컨테이너 이미지로 만들어 클러스터 안에 Deployment로 띄웁니다.

개발 중에는 클러스터에 올리지 않고 내 PC에서 돌려 봅니다. sample-controller README 기준으로 `go build -o sample-controller .`로 빌드한 뒤 `./sample-controller -kubeconfig=$HOME/.kube/config`로 실행하고 클러스터 안에서 돌 때는 이 플래그가 필요 없습니다. 밖에서는 kubeconfig의 자격 증명으로, 안에서는 Pod에 들어온 ServiceAccount 토큰(1-8절)으로 API 서버에 붙기 때문입니다. 그래서 클러스터 안에 띄울 때는 컨트롤러용 ServiceAccount에 RBAC 권한을 따로 줘야 합니다.

#### 3. 한눈에 비교: 컨트롤러와 오퍼레이터
"Operator pattern" 문서는 오퍼레이터를 커스텀 리소스로 애플리케이션과 그 구성요소를 관리하는 소프트웨어 확장으로 설명합니다. 사람 운영자가 하던 일을 코드로 옮긴다는 뜻에서 이름이 붙었습니다. etcd를 예로 들면 차이가 분명합니다.

| 구분 | 하는 일 |
|---|---|
| 단순 컨트롤러 | "etcd Pod 3개"를 보고 Pod 3개를 띄움 |
| 오퍼레이터 | Pod 띄우기, 멤버를 클러스터로 묶기, 주기적 스냅샷, 죽은 멤버 교체, 한 대씩 버전 올리기, 데이터가 깨졌을 때 스냅샷 복구까지 맡음 |

오퍼레이터 하나를 설치하면 보통 CRD, 컨트롤러 Deployment, 컨트롤러용 ServiceAccount와 RBAC이 함께 들어옵니다. 설치 경로는 셋입니다.

| 설치 경로 | 방법 |
|---|---|
| 매니페스트 | 프로젝트가 주는 매니페스트를 `kubectl apply -f`로 적용 |
| Helm 차트 | 6-1c절 |
| OLM(Operator Lifecycle Manager) | OLM을 먼저 클러스터에 설치하고 OperatorHub.io 같은 카탈로그에서 골라 설치. 앱 스토어에서 앱을 고르듯 설치와 업그레이드를 OLM이 맡음 |

#### 4. 실전에서 보이는 모습
- CKA는 컨트롤러 코드를 짜라고 하지 않습니다.
- 시험은 주어진 방법으로 오퍼레이터를 설치하고 CRD가 생겼는지 확인한 뒤 커스텀 리소스를 만들어 구성하는 일을 묻습니다.
- 커스텀 리소스를 만들었는데 아무 변화가 없으면 컨트롤러 Pod부터 봅니다. 실패하면 `kubectl logs`로 원인을 찾습니다.

> **정리**: 커스텀 리소스를 만들었는데 변화가 없으면 컨트롤러 Pod와 그 로그부터 봅니다. 시험에서는 설치, CRD 확인, CR 작성, 로그 확인 순으로 다룹니다.

</details>

"Operator pattern" 문서의 정의로 오퍼레이터는 커스텀 리소스의 컨트롤러 역할을 하는 API 클라이언트입니다. 보통 CRD, 컨트롤러를 돌리는 Deployment, 컨트롤러용 ServiceAccount와 RBAC 세 부분입니다.

"오퍼레이터를 설치하라"는 대개 Helm 차트나 매니페스트로 이 셋을 넣는 일이고 "구성하라"는 커스텀 리소스를 만드는 일입니다. 설치 뒤에는 CRD, 컨트롤러 Pod, 커스텀 객체가 만드는 하위 리소스를 차례로 봅니다.

```bash
kubectl get crd | grep example.com
kubectl explain boardjob.spec --recursive | head -30
kubectl get boardjobs -A
kubectl get deploy -A | grep -i operator
```

OLM(Operator Lifecycle Manager)은 카탈로그에서 오퍼레이터를 골라 설치해 주는 별도 프로젝트입니다. 커리큘럼 문구와 허용 문서에 없어 이름만 알아 둡니다([operator-framework 문서](https://operator-framework.github.io/operator-controller/)).

### 8-3. 헷갈리는 지점

- CRD를 지우면 그 CRD로 만든 커스텀 객체도 모든 네임스페이스에서 함께 사라집니다. 그래서 Helm은 uninstall 때 CRD를 남깁니다(6-1c절).
- CRD만 있고 컨트롤러가 없으면 객체는 저장만 되고 아무 일도 일어나지 않습니다.

### 8-4. 직접 해 보기

`BoardJob` CRD를 적용하고 커스텀 객체 하나를 만든 뒤 `kubectl get bj -o yaml`로 내용을 봅니다. CRD를 지운 직후 목록 조회는 이렇게 나옵니다.

```text
Error from server (NotFound): Unable to list "example.com/v1, Resource=boardjobs": the server could not find the requested resource
```

## 9. 확인 문제

위 내용을 바탕으로 직접 만든 연습 과제입니다.

1. 네임스페이스 `payment`에 ServiceAccount `settle-bot`을 만들고 이 계정이 `payment`의 Secret을 `get`만 할 수 있게 하세요. `list`는 안 되어야 합니다.
2. 모든 네임스페이스에서 Deployment를 볼 수만 있는 권한을 그룹 `auditors`에 주세요.
3. RoleBinding `order-binding`이 Role `old-role`을 가리킵니다. `new-role`을 가리키게 바꾸세요.
4. 워커 노드 `node02`만 1.37.x로 올리세요. 컨트롤 플레인은 이미 1.37.x입니다.
5. etcd 스냅샷을 `/opt/backup/shop.db`에 저장하고 상태를 표로 확인한 뒤 `/var/lib/etcd-restore`로 복구하세요.
6. 사용자 `refund-user`의 CSR `refund-user`가 Pending입니다. 서명자를 확인한 뒤 승인하고 인증서를 `/opt/refund-user.crt`에 저장하세요.
7. 노드 `node01`에 단독 Pod 하나와 emptyDir를 쓰는 Deployment Pod가 있어 drain이 거부됩니다. 필요한 옵션과 각 옵션의 결과를 적으세요.
8. 새 노드 `node03`에 Docker Engine이 있고 `/root/cri-dockerd.deb`가 주어졌습니다. cri-dockerd를 설치해 재부팅 뒤에도 실행되게 하고 이 노드를 클러스터에 붙이세요.
9. 오퍼레이터 차트 `./payment-operator`(`crds/` 있음)를 렌더링해 `/opt/payment-op.yaml`에 저장하고 `kubectl`로 적용한 뒤 CRD가 생겼는지 확인하세요.

<details>
<summary>풀이 보기</summary>

1. 동사를 `get` 하나로 제한합니다.
   ```bash
   kubectl create serviceaccount settle-bot -n payment
   kubectl create role secret-getter -n payment --verb=get --resource=secrets
   kubectl create rolebinding settle-bot-secret-getter -n payment \
     --role=secret-getter --serviceaccount=payment:settle-bot
   kubectl auth can-i get secrets -n payment --as=system:serviceaccount:payment:settle-bot    # yes
   kubectl auth can-i list secrets -n payment --as=system:serviceaccount:payment:settle-bot   # no
   ```
2. 모든 네임스페이스라서 ClusterRole과 ClusterRoleBinding입니다.
   ```bash
   kubectl create clusterrole deploy-viewer --verb=get,list,watch --resource=deployments.apps
   kubectl create clusterrolebinding auditors-deploy-viewer \
     --clusterrole=deploy-viewer --group=auditors
   kubectl auth can-i list deployments -A --as=someone --as-group=auditors
   ```
3. `roleRef`는 바꿀 수 없으니 지우고 다시 만듭니다.
   ```bash
   kubectl get rolebinding order-binding -o yaml > /tmp/order-binding.yaml
   kubectl delete rolebinding order-binding
   # roleRef.name을 new-role로 고치고 metadata의 resourceVersion, uid를 지운 뒤
   kubectl apply -f /tmp/order-binding.yaml
   ```
4. 워커 순서는 kubeadm 갱신, `kubeadm upgrade node`, drain, kubelet 갱신, uncordon입니다(4-2절 명령). 저장소 경로가 v1.37인지 먼저 봅니다. kubeadm과 kubelet 작업은 `ssh node02`에서, drain과 uncordon은 kubectl이 되는 호스트에서 실행합니다.
   ```bash
   kubectl drain node02 --ignore-daemonsets
   # node02에서 kubelet, kubectl 설치 후
   sudo systemctl daemon-reload && sudo systemctl restart kubelet
   kubectl uncordon node02
   ```
5. 인증서 경로를 매니페스트에서 확인하고 저장, 확인, 복구합니다.
   ```bash
   sudo grep -E 'cert|key|trusted' /etc/kubernetes/manifests/etcd.yaml
   etcdctl --endpoints=https://127.0.0.1:2379 \
     --cacert=/etc/kubernetes/pki/etcd/ca.crt \
     --cert=/etc/kubernetes/pki/etcd/server.crt \
     --key=/etc/kubernetes/pki/etcd/server.key \
     snapshot save /opt/backup/shop.db
   etcdutl --write-out=table snapshot status /opt/backup/shop.db
   sudo etcdutl --data-dir /var/lib/etcd-restore snapshot restore /opt/backup/shop.db
   # etcd.yaml의 etcd-data hostPath.path를 /var/lib/etcd-restore로
   ```
   etcd가 다시 뜨면 kube-apiserver, kube-controller-manager, kube-scheduler 매니페스트를 밖으로 옮겼다 되돌려 재시작합니다. 클러스터를 계속 kubeadm으로 업그레이드할 거라면 `kubeadm-config`의 `etcd.local.dataDir`도 고칩니다.
6. 서명자와 요청 내용을 보고 승인합니다. 승인된 CSR은 1시간 뒤 지워지니 바로 꺼냅니다.
   ```bash
   kubectl get csr refund-user -o jsonpath='{.spec.signerName}{"\n"}{.spec.usages}{"\n"}'
   kubectl get csr refund-user -o jsonpath='{.spec.request}' | base64 -d | openssl req -noout -subject
   kubectl certificate approve refund-user
   kubectl get csr refund-user -o jsonpath='{.status.certificate}' | base64 -d > /opt/refund-user.crt
   ```
7. 단독 Pod 때문에 `--force`, emptyDir 때문에 `--delete-emptydir-data`, DaemonSet Pod가 있다면 `--ignore-daemonsets`가 필요합니다. 단독 Pod는 다시 만들어 줄 컨트롤러가 없어 사라지고 emptyDir 데이터도 지워집니다. Deployment Pod는 다른 노드에 다시 생깁니다.
   ```bash
   kubectl drain node01 --ignore-daemonsets --delete-emptydir-data --force
   ```
8. 패키지 설치, 서비스 등록, 소켓 확인, 소켓을 지정한 join 순서입니다. Docker와 함께 containerd 소켓도 있을 수 있어 `--cri-socket`을 명시합니다.
   ```bash
   sudo dpkg -i /root/cri-dockerd.deb                 # node03에서
   sudo systemctl daemon-reload
   sudo systemctl enable --now cri-docker.socket cri-docker.service
   systemctl is-enabled cri-docker.socket; ls -l /run/cri-dockerd.sock
   kubeadm token create --print-join-command          # 컨트롤 플레인에서
   sudo kubeadm join <주소>:6443 --token <토큰> --discovery-token-ca-cert-hash sha256:<해시> \
     --cri-socket unix:///var/run/cri-dockerd.sock
   ```
9. `helm template`은 기본으로 `crds/`를 출력하지 않으니 `--include-crds`가 필요합니다.
   ```bash
   helm template payment-op ./payment-operator -n payment --include-crds > /opt/payment-op.yaml
   kubectl create namespace payment --dry-run=client -o yaml | kubectl apply -f -
   kubectl apply -f /opt/payment-op.yaml -n payment
   kubectl get crd | grep -i payment
   ```
   첫 apply에서 커스텀 객체만 `no matches for kind`로 실패하면 `kubectl wait` 뒤 한 번 더 apply합니다.

</details>

## 범위와 한계

- 명령과 YAML은 kind v1.37 클러스터와 Lima VM의 kubeadm 1.36→1.37 클러스터에서 2026년 10월에 직접 돌려 확인했습니다. HA 장애 동작은 kind 컨트롤 플레인 3대로, `--certificate-key` join과 키 재발급은 Lima VM 3대로 확인했습니다. 이 VM 구성은 LB 없이 첫 노드 IP를 엔드포인트로 썼고 2시간 만료는 TTL 토큰을 지워 재현했습니다.
- etcd 백업과 kubeadm 업그레이드가 현재 시험에 나오는지는 공식 문서로 확인되지 않고 후기도 엇갈립니다.
- 시험 호스트의 `etcdutl`, `crictl`은 공개 자료로 확인할 수 없습니다. `helm`, `etcdctl`은 해당 과제 호스트에 있을 가능성이 높은 정도이고 공식 사전 설치 목록은 kubectl, yq, curl, wget, man입니다.
- etcd 기본 버전(1.37은 3.7.0), containerd 설정 형식, Helm 플래그 이름은 패치나 메이저 버전마다 달라질 수 있으니 시험 노드에서 `--version`과 `config default`로 확인합니다.
- 확인 문제는 문서를 바탕으로 제가 만든 것이고 실제 시험 문항과 관계없습니다.

## 참고 자료

- CNCF, [CKA Curriculum v1.37](https://github.com/cncf/curriculum/blob/master/CKA_Curriculum_v1.37.pdf); Linux Foundation, [Important Instructions: CKA and CKAD](https://docs.linuxfoundation.org/tc-docs/certification/tips-cka-and-ckad); Linux Foundation, [Resources Allowed](https://docs.linuxfoundation.org/tc-docs/certification/certification-resources-allowed)
- Kubernetes, [Using RBAC Authorization](https://kubernetes.io/docs/reference/access-authn-authz/rbac/), [Issue a Certificate for a Kubernetes API Client Using A CertificateSigningRequest](https://kubernetes.io/docs/tasks/tls/certificate-issue-client-csr/), [PKI certificates and requirements](https://kubernetes.io/docs/setup/best-practices/certificates/)
- Kubernetes, [Installing kubeadm](https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/install-kubeadm/), [Container Runtimes](https://kubernetes.io/docs/setup/production-environment/container-runtimes/), [Reconfiguring a kubeadm cluster](https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/kubeadm-reconfigure/)
- Kubernetes, [Swap memory management](https://kubernetes.io/docs/concepts/cluster-administration/swap-memory-management/), [KEP-2400 Node swap support](https://github.com/kubernetes/enhancements/blob/master/keps/sig-node/2400-node-swap/README.md)
- Kubernetes, [Version Skew Policy](https://kubernetes.io/releases/version-skew-policy/), [Upgrading kubeadm clusters](https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/kubeadm-upgrade/), [Certificate Management with kubeadm](https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/kubeadm-certs/), [Operating etcd clusters for Kubernetes](https://kubernetes.io/docs/tasks/administer-cluster/configure-upgrade-etcd/), [Creating Highly Available Clusters with kubeadm](https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/high-availability/)
- Kubernetes, [Custom Resources](https://kubernetes.io/docs/tasks/extend-kubernetes/custom-resources/custom-resource-definitions/), [Kustomize](https://kubernetes.io/docs/tasks/manage-kubernetes-objects/kustomization/); Helm, [Using Helm](https://helm.sh/docs/intro/using_helm/), [CRD Best Practices](https://helm.sh/docs/chart_best_practices/custom_resource_definitions/), [Helm 4 Overview](https://helm.sh/docs/overview/)
- etcd, [Announcing etcd v3.6](https://etcd.io/blog/2025/announcing-etcd-3.6/); containerd, [CRI plugin config](https://github.com/containerd/containerd/blob/main/docs/cri/config.md); Mirantis, [cri-dockerd Install](https://mirantis.github.io/cri-dockerd/usage/install/)
- 후기: Domenic Cassisi, [I passed the CKA! (2026)](https://dcassisi.com/2026/06/09/i-passed-the-cka-my-exam-experience-2026/); Talha Juikar, [Passing the CKA Exam](https://talhajuikar.com/posts/passing-cka-exam/)

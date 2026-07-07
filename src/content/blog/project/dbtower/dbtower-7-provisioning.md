---
title: '생성과 관제가 끊겨 있으면 도구 모음이다 — K8s·Ansible·Terraform을 관제탑에 잇기'
titleEn: 'If Creation and Control Are Disconnected, It Is a Toolbox — Wiring K8s, Ansible, and Terraform into the Control Tower'
description: "이기종 DBMS 운영 관리 플랫폼 DBTower 7편. 지금까지는 '이미 존재하는 DB'를 수동 등록했지만, 현업에서 DB는 IaC로 태어납니다 — 태어나는 순간 관제탑에 자동 등록되는 것이 Phase C입니다. 그 전제가 되는 멱등 등록 PUT(재실행해도 중복이 아니라 갱신), kind 로컬 클러스터에서 CloudNativePG Operator로 프로비저닝→Secret→등록→health up까지 완주한 e2e, Ansible로 최소 권한 계정 생성과 등록을 멱등(changed=0)으로 검증한 기록, 그리고 Terraform은 validate까지만 하고 apply는 안 했다고 정직하게 표기한 이유까지 — 세 층에서 '생성과 관제를 잇는' 과정을 기록합니다."
descriptionEn: "Part 7 of DBTower. So far, instances were registered by hand — but in production, databases are born from IaC, and Phase C makes them auto-register with the control tower at birth. The prerequisite is an idempotent PUT (re-running registration updates instead of duplicating), a full e2e run on a local kind cluster with the CloudNativePG operator (provision, app Secret, register, health up), an Ansible playbook that creates a least-privilege account and registers it idempotently (changed=0), and the honest decision to stop Terraform at validate because apply needs real AWS credentials."
date: 2026-07-05
tags:
  - Java
  - Spring Boot
  - DBRE
  - Kubernetes
  - Ansible
  - Terraform
category: personal/DBTower
coverImage: /uploads/project/dbtower/cover.svg
draft: false
series: "DBTower"
seriesOrder: 7
---

## 0. 들어가며 — DB는 IaC로 태어난다

[6편](/blog/project/dbtower/dbtower-6-wait-events-and-right-tool)까지의 DBTower에는 한 가지 전제가 숨어 있었어요. **"관리할 DB가 이미 존재한다"**는 전제요. 인스턴스는 사람이 API로 등록했고, 그 DB가 어디서 왔는지는 플랫폼의 관심 밖이었습니다.

그런데 현업에서 DB는 그렇게 오지 않아요. Kubernetes에서는 Operator가 만들고, VM에서는 Ansible이 깔고, 클라우드에서는 Terraform이 RDS를 띄웁니다. DB가 IaC로 태어나는데 관제 등록은 사람이 수동으로 한다면, 생성과 관제 사이가 끊겨 있는 거예요. 이 끊김을 이으려고 이번 축을 만들었습니다. 설계 노트에 적어둔 문장 그대로 — **"생성과 관제가 이어져야 플랫폼이고, 끊어져 있으면 도구 모음이다."**

![Phase C 구조 — 세 층의 프로비저닝이 멱등 PUT 하나로 관제탑에 모인다](/uploads/project/dbtower/provisioning-flow.svg)

## 1. 전제부터 — 등록이 멱등이어야 한다

프로비저닝 도구를 붙이기 전에 먼저 고쳐야 할 게 있었어요. 기존 등록은 `POST /api/instances`인데, IaC는 **재실행되는 물건**입니다. Ansible 플레이북을 두 번 돌리고, Terraform을 다시 apply하고, K8s Job이 재시도되죠. 그때마다 POST가 인스턴스를 하나씩 더 만든다면 관제탑에 같은 DB가 세 개 등록되는 거예요.

그래서 멱등 등록 `PUT /api/instances`를 먼저 만들었습니다.

- **같은 이름이면 갱신**: 접속 정보를 덮어쓰고, 기존 커넥션 풀을 정리한 뒤 새 정보로 접속 검증
- **없으면 신규**: POST와 동일한 경로
- **이름이 논리 식별자**: id가 아니라 이름이 IaC 쪽의 불변 키가 됩니다. `createdAt`은 유지해서 "언제부터 관제했나"가 안 깨지게 했어요
- 등록/삭제와 같은 **ADMIN 경계**

실측으로 같은 이름을 재차 PUT해도 id가 유지되고 중복이 0인 걸 확인했습니다(신규/갱신/접속 실패 거부 단위 테스트 3건). 이 PUT 하나가 이후 세 도구 모두의 **종점**이 돼요.

## 2. Kubernetes — CloudNativePG로 e2e 완주

첫 번째 층은 K8s입니다. 요즘 DB의 Day-1(생성)과 Day-2(페일오버·백업)는 Operator가 맡는 흐름이라, 직접 StatefulSet을 짜는 대신 CNCF의 CloudNativePG를 썼어요. DBTower가 할 일은 생성이 아니라 **생성된 DB를 관제탑에 잇는 것**입니다.

kind 로컬 클러스터에서 실제로 끝까지 완주했어요:

```
kind create cluster (v0.32)            -> Docker 노드 기동
CloudNativePG operator 1.24.1 설치     -> cnpg-controller-manager Available
kubectl apply cluster.yml              -> cluster/dbtower-pg "healthy", pod Running
  Operator가 접속 Secret 자동 생성      -> dbtower-pg-app (username/password/host/port/dbname)
register-job: Secret 읽어 PUT          -> 등록 id 1
DBTower가 그 DB에 실제 접속            -> health up, "PostgreSQL 16.4" (pingMillis 47)
등록 재실행(멱등)                      -> id 1 유지, 중복 0
kind delete cluster                    -> 정리
```

여기서 설계 포인트는 등록 훅이 **CloudNativePG의 규약을 그대로 읽는다**는 거예요. CloudNativePG는 클러스터를 만들면 `<cluster>-app`이라는 이름의 접속 Secret을 자동으로 만들어 줍니다. register-job은 그 Secret을 마운트해서 PUT을 쏘는 게 전부예요. DBTower 쪽에 K8s 전용 코드를 넣은 게 아니라, K8s 쪽 규약과 DBTower의 멱등 PUT이 자연스럽게 만나는 지점을 찾은 겁니다.

## 3. Ansible — 최소 권한 계정까지 함께, 멱등 changed=0

두 번째 층은 온프레미스/VM이에요. 여기서는 등록만 하는 게 아니라 한 가지를 더 했습니다 — [5편](/blog/project/dbtower/dbtower-5-production-safety)에서 실측으로 확정한 **최소 권한 모니터링 계정**을 플레이북이 만들어 주는 거예요. 사람이 root 계정을 등록하는 실수를 구조적으로 막는 거죠.

```
대상 dbtower-postgres에 register-db.yml 실행:
  1차: 모니터링 계정 생성 + pg_read_all_stats 부여 + PUT 등록
       -> changed=1, "등록 완료 HTTP 200"
  2차: 멱등 -> changed=0 (중복도 에러도 없음)
DBTower에서 확인: prod-postgres-01 등록(개수 1),
  최소 권한 계정으로 health up "PostgreSQL 16.14"
```

계정 생성은 `community.postgresql` 모듈(psycopg2), 등록은 `uri` 모듈의 PUT입니다. Ansible의 멱등성 모델과 DBTower의 멱등 PUT이 맞물려서, 2차 실행이 `changed=0`으로 끝나요 — "몇 번을 돌려도 상태는 하나"라는 IaC의 약속이 등록까지 이어집니다. 비밀값은 `secrets.yml`로 분리해서 gitignore에 뒀어요.

## 4. Terraform — validate까지만, 그리고 그렇게 적었다

세 번째 층은 클라우드(RDS)입니다. `aws_db_instance`로 RDS를 만들고 생성 후 `local-exec`로 같은 PUT을 쏘는 모듈을 만들었어요.

그런데 이 층은 검증 수준이 달라요:

```
OpenTofu v1.12.3, aws provider v5.100:
  tofu init      -> provider 설치
  tofu fmt       -> 정상
  tofu validate  -> "configuration is valid"
```

**apply는 실행하지 않았습니다.** 실제 RDS를 띄우려면 AWS 자격증명과 과금이 필요하거든요. 여기서 선택지는 두 개였어요 — "Terraform 연동 완료"라고 뭉뚱그려 적거나, 검증 수준의 차이를 그대로 드러내거나. 시리즈 내내 지켜온 원칙대로 후자를 택했습니다. 문서에는 "validate 통과, apply는 자격증명 필요라 미실행"이라고 적고, 같은 등록 흐름이 실제로 완주되는 건 K8s와 Ansible에서 확인했다고 근거를 연결했어요. 백업 검증의 UNSUPPORTED, 레이턴시 백분위의 ESTIMATED와 같은 계열의 정직성입니다 — **못 본 것을 본 척하지 않기.**

덤으로 하나. 도구는 Terraform이 아니라 OpenTofu를 썼는데, brew에서 terraform 공식 포뮬러가 라이선스 변경(BUSL) 이후 내려가 별도 tap 신뢰가 필요했기 때문이에요. 오픈소스 포크인 OpenTofu가 문법 호환이라 검증 목적에는 차이가 없었습니다.

## 5. 마치며 — 세 층, 하나의 종점

Phase C를 표로 정리하면 이렇게 돼요.

| 환경 | 도구 | 검증 수준 |
|---|---|---|
| Kubernetes | CloudNativePG Operator + 등록 Job | e2e 완주 (프로비저닝 -> Secret -> 등록 -> health up) |
| 온프레미스/VM | Ansible 플레이북 | e2e 완주 (계정 생성 -> 등록, 멱등 changed=0) |
| 클라우드 | Terraform(OpenTofu) RDS 모듈 | validate 통과 (apply는 자격증명 필요 — 정직하게 미실행) |

셋은 서로 완전히 다른 도구지만, 전부 DBTower의 멱등 PUT 하나를 종점으로 씁니다. 4편에서 기종 차이를 `DbmsOperator` 뒤로 숨겼듯, 이번엔 프로비저닝 도구의 차이가 등록 API 하나 뒤로 숨은 거예요. 플랫폼 쪽에 K8s용·Ansible용·Terraform용 코드가 따로 생긴 게 아니라, **잘 정의된 멱등 API 하나가 세 생태계의 접점**이 됐다는 게 이 Phase의 결론입니다.

다음 편은 방향이 바뀝니다. 지금까지는 사람이 화면을 보고 판단하는 도구를 만들었다면, 이제 플랫폼이 스스로 보고 판단하는 축 — 이상 자동 감지부터 통합 헬스 스코어까지, 자율 진단(Phase D)입니다.

코드와 실측 기록 전체는 [GitHub](https://github.com/dj258255/dbtower)에 있습니다.

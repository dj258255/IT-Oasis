---
title: '[CKA Ch-00] CKA 시험 구조와 공부 계획: 2025년 개정 뒤의 범위로 준비하기'
description: CKA는 2시간 동안 터미널에서 15~20개 과제를 푸는 실기 시험이고 66% 이상이면 합격입니다. 2025년 2월 개정으로 etcd 백업과 kubeadm 업그레이드가 명시 항목에서 빠지고 Helm, Kustomize, Gateway API, CRD가 들어왔습니다. 공식 문서로 확인한 시험 규칙과 영역별 범위, 시험 환경의 함정, 국내외 응시자들의 후기에서 공통으로 나온 공부법을 정리하고 내 공부 계획을 세웁니다.
date: 2026-10-19T00:00:00.000Z
tags:
  - CKA
  - Kubernetes
  - Certification
  - Study Plan
category: cert/CKA
topics:
  - cert
draft: false
series: "CKA 공부"
seriesOrder: 0
---

## 결론부터

1. CKA는 2시간 동안 15~20개의 실기 과제를 푸는 시험입니다. 답을 고르는 문제가 없고 터미널에서 클러스터를 직접 고칩니다. 66% 이상이면 합격이고, 결과만 맞으면 푸는 방법은 상관없습니다.
2. 2025년 2월 18일부터 범위가 바뀌었습니다. 공식 커리큘럼을 개정 전(v1.31)과 대조하면 etcd 백업과 복구, kubeadm 버전 업그레이드가 명시 항목에서 빠지고 Helm, Kustomize, Gateway API, CRD와 오퍼레이터, 확장 인터페이스(CNI, CSI, CRI)가 들어왔습니다. 개정 전 강의와 후기는 걸러서 봐야 합니다.
3. 비중이 가장 큰 영역은 트러블슈팅(30%)입니다. 후기들이 공통으로 꼽는 실패 원인도 트러블슈팅 문제에서 시간을 잃은 것입니다.
4. 공부는 개념 강의, 직접 만든 클러스터에서 손으로 해 보기, 무료 시나리오 반복, 공식 시뮬레이터(killer.sh) 2회 순서로 잡습니다. 시험장에서는 공식 문서만 볼 수 있으니 문서 위치를 익히는 것도 공부에 넣습니다.

---

## 1. 시험 구조

Linux Foundation 공식 페이지와 응시 안내 문서로 확인한 내용입니다(2026년 10월 기준).

| 항목 | 내용 |
|---|---|
| 형식 | 온라인 감독, 실기형. 15~20개 과제 |
| 시간 | 2시간 |
| 합격 | 66% 이상 |
| 기준 버전 | Kubernetes v1.37. 새 마이너 버전이 나오면 약 4~8주 안에 시험 환경을 맞춘다 |
| 가격 | $445, 재응시 1회 포함 |
| 시뮬레이터 | killer.sh 2회(활성화 후 각 36시간). 단일 등록 상품에는 없다 |
| 유효 기간 | 2년 |
| 결과 | 시험 종료 후 24시간 안에 이메일 |
| 일정 | 구매 후 12개월 안에 응시. 예약은 최소 24시간 전, 변경과 취소도 24시간 전까지 |

채점은 결과를 봅니다. 응시자 핸드북은 실기 시험에서 과제를 푸는 방법이 여럿일 수 있다고 적습니다. 문항별 배점과 성적은 공개하지 않습니다.

## 2. 영역과 범위

### 2-1. 영역별 비중과 세부 항목

cncf/curriculum 저장소의 v1.37 커리큘럼 원문입니다.

| 영역 | 비중 | 세부 항목 |
|---|---|---|
| Troubleshooting | 30% | 클러스터와 노드, 클러스터 구성요소, 리소스 사용량 모니터링, 컨테이너 출력 스트림, 서비스와 네트워킹 트러블슈팅 |
| Cluster Architecture, Installation and Configuration | 25% | RBAC, 기반 인프라 준비, kubeadm으로 클러스터 생성과 관리, 클러스터 수명주기 관리, 고가용성 컨트롤 플레인, Helm과 Kustomize로 구성요소 설치, 확장 인터페이스(CNI, CSI, CRI), CRD와 오퍼레이터 |
| Services and Networking | 20% | Pod 간 연결, NetworkPolicy, ClusterIP·NodePort·LoadBalancer와 엔드포인트, Gateway API, Ingress 컨트롤러와 리소스, CoreDNS |
| Workloads and Scheduling | 15% | 롤링 업데이트와 롤백, ConfigMap과 Secret, 워크로드 자동 확장, 자가 치유 기본 요소, Pod 승인과 스케줄링(리소스 제한, 노드 어피니티 등) |
| Storage | 10% | StorageClass와 동적 프로비저닝, 볼륨 타입·접근 모드·회수 정책, PV와 PVC |

### 2-2. 2025년 2월 개정에서 바뀐 것

Linux Foundation은 개정 시행을 2025년 2월 18일 0시(UTC)로 공지했고, 기준은 응시일입니다. 개정 전 커리큘럼(v1.31)과 문구를 대조한 결과입니다.

| 빠진 명시 항목 | 새로 들어온 항목 |
|---|---|
| etcd 백업과 복구 | Helm과 Kustomize |
| kubeadm으로 버전 업그레이드 | CRD와 오퍼레이터 |
| 노드의 호스트 네트워킹 설정 이해 | 확장 인터페이스(CNI, CSI, CRI) |
| CNI 플러그인 선택 | Gateway API |
| 매니페스트 관리와 템플릿 도구 인식 | NetworkPolicy 정의와 적용 |
| | 워크로드 자동 확장, Pod 승인 |
| | 고가용성 컨트롤 플레인 구성, 동적 볼륨 프로비저닝 |

업그레이드가 "클러스터 수명주기 관리"에 포함되는지, etcd가 여전히 나오는지는 공식 문서에 적혀 있지 않습니다. 후기에서도 컨트롤 플레인과 static Pod를 직접 만져 본 적이 없어 막혔다는 이야기가 나와서 저는 etcd 백업과 static Pod를 둘 다 손으로 한 번씩은 해 보기로 했습니다. 공식 문서도 바뀌었는데, etcd 문서는 `etcdctl snapshot status`와 `restore`가 etcd 3.5부터 사용 중단 예정이고 `etcdutl`로 하라고 적습니다. 옛 강의의 명령을 그대로 외우면 안 되는 이유입니다.

Domenic Cassisi(2026)도 일부 강의에 아직 etcd 내용이 남아 커리큘럼보다 뒤처져 있다고 지적했고, Atsushi Suzuki(2026)는 글 제목부터 "옛 가이드에 기대지 말라"였습니다.

## 3. 시험 환경과 규칙

공부할 때부터 시험 환경에 맞춰 연습해야 해서 따로 정리합니다.

### 3-1. 화면과 조작

| 항목 | 공식 안내 |
|---|---|
| 플랫폼 | PSI의 Bridge, PSI Secure Browser. 모니터 1대만(듀얼 모니터 불가), 15인치 이상과 1080p 권장. 가상 머신 안에서 응시 불가 |
| 화면 | 문제 콘솔과 원격 데스크톱(리눅스 VM)으로 나뉜다. VM 안에 터미널, Firefox(허용 문서용), VSCodium이 있다 |
| 복사·붙여넣기 | 터미널은 Ctrl+Shift+C / Ctrl+Shift+V, 다른 앱은 Ctrl+C / Ctrl+V |
| 금지 키 | Ctrl+W는 브라우저 탭을 닫으니 Ctrl+Alt+W. INSERT 키는 금지라 vi에서는 `i`로 입력 모드 |
| 시간 알림 | 30분, 15분, 5분 남았을 때. 일시정지해도 타이머는 멈추지 않고 연결이 끊겨도 시간을 돌려주지 않는다 |

### 3-2. 과제마다 다른 호스트

공식 안내는 각 과제를 지정된 호스트에서 풀라고 적습니다. `ssh <노드 이름>`으로 들어가고, ssh 안에서 다시 ssh는 할 수 없으며, 끝나면 `exit`로 돌아옵니다. 권한이 필요하면 `sudo -i`나 `sudo`를 씁니다. 호스트에는 `kubectl`(alias `k`와 자동완성 포함), `yq`, `curl`, `wget`, `man`이 깔려 있습니다.

후기 두 편(Cassisi 2026, Suzuki 2026)이 같은 점을 짚었습니다. 노드를 옮기면 직접 만든 alias가 사라지고, 네임스페이스 전환용 alias 같은 옛 팁은 더 이상 필요 없다는 것입니다. `k`는 이미 있으니 다른 설정을 외우는 데 시간을 쓰지 않아도 됩니다.

### 3-3. 볼 수 있는 문서

| 허용 | 비고 |
|---|---|
| kubernetes.io/docs, kubernetes.io/blog | 사이트 안 검색은 되지만 외부 검색 결과는 열면 안 된다 |
| helm.sh/docs | |
| gateway-api.sigs.k8s.io | CKA만 |
| 과제마다 표시되는 Quick Reference의 문서 | |
| man 페이지, /usr/share의 문서 | |

Suzuki는 브라우저가 문서 페이지로 자동으로 열리지 않아 URL을 외워 두라고 했습니다. kt ds CoE팀의 글(2024)도 공식 문서 검색 키워드를 외워 두라고 권합니다. 문서를 어디서 찾는지가 시험 시간에 직결됩니다.

### 3-4. 신분증과 당일

- 유효기간이 남은 정부 발급 원본 실물 신분증이어야 하고 사본, 전자, 임시 신분증은 안 됩니다. 신분증의 이름과 등록한 이름이 정확히 같아야 합니다. 신분증 이름이 현지어면 현지어로 적으라는 안내에 한국어 예가 있습니다.
- 시작 30분 전부터 체크인할 수 있고, 예정 시각에서 30분이 지나도록 시작하지 않으면 결시 처리됩니다. 결시는 환불도 재응시도 없습니다.
- 메모, 문제를 소리 내어 읽기, 얼굴과 입을 가리는 것, 음식은 금지입니다. 투명한 용기에 담은 투명한 음료만 됩니다. Suzuki는 턱을 만졌다가 감독관에게 경고를 받았다고 적었습니다.

## 4. 응시자들의 후기에서 공통으로 나온 것

개정 뒤에 응시한 후기를 위주로 읽었습니다. 실제 문항을 옮겨 적었거나 기출 모음을 권하는 후기는 뺐습니다.

| 글 | 결과 | 준비 | 남긴 말 |
|---|---|---|---|
| 최민석(2025-07) | 합격 | Udemy, killer.sh, Killercoda, 책 3권, 직접 만든 kubeadm HA 클러스터 | 2시간이 절대 넉넉하지 않다. 30분 남았을 때 마지막 문제를 버리고 전체를 다시 봤다. 원격 화면이 느려 실수 한 번에 몇 분을 잃는다 |
| Domenic Cassisi(2026-06) | 95% | KodeKloud 강의, Killercoda 커뮤니티 시나리오, Kubernetes The Hard Way, killer.sh를 시험 2주 전과 1주 전 | 어려운 문제는 표시하고 넘어간 뒤 마지막에 요구사항을 전부 다시 확인했다. `kubectl explain`을 썼다 |
| Atsushi Suzuki(2026-01) | 72%, 평일 1~2시간씩 약 2개월, 실무 경험 없음 | KodeKloud 모의고사 3회, 유료 모의고사 5회, killer.sh | 시간 안에 다 풀지 못했고 표시해 둔 트러블슈팅 문제로 돌아가지 못했다. 복사·붙여넣기가 승패를 가른다 |
| 109x79m, Qiita(2026-07) | 69%, 약 4개월(평일 1~2시간) | Udemy(Mumshad), killer.sh, 『Kubernetes完全ガイド』 | 16문항 중 5~6개가 어려웠고 1개는 못 풀었다. 난이도를 넷으로 나눠 쉬운 것부터 풀었다. 일본어판(CKA-JP)도 문서는 영어 |
| yu-min, Zenn(2025-10) | 1차 58%, 약 3주 반 뒤 2차 69%, 약 80시간 | KodeKloud 강의·랩·모의고사, killer.sh | 체크인이 여러 번 실패해 시작이 크게 늦었다. 조작마다 2~3초 지연이 있었다 |
| cnative_tkb, Zenn(2026-05) | 점수 비공개, 약 30시간(실무 3년) | kubernetes.io, Killercoda, killer.sh, Udemy(Mumshad) | 시스템 점검 도구를 지운 뒤 시험 소프트웨어를 설치하라. 외장 키보드면 입력기 전환을 미리 확인하라 |
| Aditya Nakadi, Medium(2025-09) | 개정 후 첫 응시 62점, 다음 응시 합격 | Udemy(Mumshad)와 KodeKloud 랩, EC2에 직접 만든 kubeadm 클러스터, Killercoda, killer.sh | 감독관 쪽 영상이 계속 멈춰 시험이 중단됐고 지원팀이 응시 기회를 돌려줬다. 개정 뒤 Helm, Kustomize, Gateway API를 새로 공부했다 |
| techwithmohamed, GitHub README(2026-03) | 89%(자기 보고) | 직접 만든 연습 31개와 모의고사 2회, killer.sh | 저장소에 "actual CKA exam questions"를 싣지 않는다고 밝혔다. Gateway와 HTTPRoute를 만들 줄 알아야 한다 |
| Christophe, KodeKloud 커뮤니티(2026-08) | 61%, 44%로 두 번 불합격, 약 6개월 | KodeKloud 전 과정과 모의고사(90% 안팎), killer.sh | 모의고사 점수가 실제로 이어지지 않았다. CNI 설치와 Gateway API 리소스 관계에서 막혔다 |

표의 후기에서 겹치는 것을 추리면 다섯 가지입니다. 주제별 경향과 함정은 [CKA Ch-07 5절](/blog/cert/cka/cka-07-resources-and-exam-day)에 모았습니다.

- **killer.sh 점수가 낮아도 실제 시험과는 다를 수 있습니다.** killer.sh가 실제 시험보다 어렵다는 평가가 여러 후기와 KodeKloud 커뮤니티에서 나왔으니(공식 비교는 없음) 점수보다 풀이를 보고 배우는 용도로 쓰고 Suzuki는 답안 페이지를 PDF로 저장해 두라고 권했습니다. 활성화 후 36시간이라 시험 2주 전과 1주 전처럼 날짜를 나눠 쓰는 경우가 많았습니다.
- **트러블슈팅에서 시간을 잃습니다.** 비중이 30%로 가장 크고, 정답이 하나로 정해지지 않아 오래 붙들게 됩니다.
- **문제는 끝까지 읽습니다.** 하지 말라는 조건이나 지정한 네임스페이스를 놓치면 결과가 틀립니다.
- **어려운 문제는 넘기고 마지막에 검증합니다.** 공식 기준 2시간에 15~20문항이면 문항당 6~8분입니다.
- **관리형 쿠버네티스 경험만으로는 부족합니다.** 컨트롤 플레인과 kubelet, static Pod는 EKS나 GKE에서 직접 만질 일이 없습니다.

## 5. 내 공부 계획

### 5-1. 단계

| 단계 | 할 일 | 끝났다고 보는 기준 |
|---|---|---|
| 1. 개념 | 강의 하나를 정해 끝까지 듣는다(후기에서 가장 많이 쓴 것은 Udemy와 KodeKloud의 Mumshad 강의). 영역마다 이 시리즈에 노트를 올린다 | 2-1절 표의 세부 항목마다 글이나 노트가 있다 |
| 2. 직접 만들기 | 집 맥에서 kubeadm으로 컨트롤 플레인 1대, 워커 2대 클러스터를 처음부터 만든다. 망가뜨리고 고친다(kubelet 멈추기, static Pod 매니페스트 오타, CoreDNS 지우기) | 스스로 망가뜨린 것을 문서만 보고 고친다 |
| 3. 개정 범위 집중 | Helm 차트 설치와 값 바꾸기, Kustomize, Gateway API(Ingress를 Gateway와 HTTPRoute로 옮기기), CRD 설치, NetworkPolicy | 각각을 공식 문서에서 찾아 5분 안에 한다 |
| 4. 반복 | Killercoda 무료 시나리오, 강의의 모의고사 | 모의고사에서 시간이 남는다 |
| 5. 시뮬레이터 | killer.sh 1회차(시험 2주 전), 틀린 문제 풀이 정리, 2회차(1주 전) | 2회차에서 표시하고 넘긴 문제까지 돌아가서 확인한다 |
| 6. 당일 준비 | 시스템 점검 실행, 유선 네트워크, 단일 모니터, 신분증 이름 확인 | 3절 체크리스트 통과 |

연습 자료 비교, 할인 이력, 홈 랩 구성, 시험 당일 순서와 D-30 마무리 계획은 [CKA Ch-07](/blog/cert/cka/cka-07-resources-and-exam-day)에 따로 정리했습니다.

### 5-2. 손에 익힐 것

| 항목 | 이유 |
|---|---|
| `kubectl create`, `kubectl run`에 `--dry-run=client -o yaml`을 붙여 매니페스트 뼈대 만들기 | YAML을 처음부터 쓰지 않는다. 후기 여러 편이 같은 방식을 썼다 |
| `kubectl explain <리소스>.<필드>` | 필드 이름이 기억나지 않을 때 문서 대신 터미널에서 본다 |
| `kubectl auth can-i` | RBAC 과제를 끝낸 뒤 검증한다 |
| `journalctl -u kubelet`, `crictl ps`, `/etc/kubernetes/manifests` | 컨트롤 플레인과 노드 트러블슈팅. [CKA Ch-01의 "컨트롤러가 죽으면"](/blog/cert/cka/cka-01-why-kubernetes)에서 다룬 경로 |
| kubernetes.io 문서의 위치 | Gateway API, NetworkPolicy, PV/PVC, Kustomize, kubeadm 페이지를 검색 없이 찾아간다 |

이 블로그의 데이터 엔지니어링 시리즈와 겹치는 부분도 있습니다. [DE Ch-07](/blog/data/orchestration/de-07-task-per-pod-cost)에서 Pod가 시작되기까지의 구간과 condition을 정리했고, 트러블슈팅에서 Pod가 왜 안 뜨는지 볼 때 그대로 씁니다.

## 6. 범위와 한계

- 시험 규칙과 범위는 2026년 10월 19일에 Linux Foundation 문서와 cncf/curriculum 저장소에서 확인했습니다. 시험 2주 전에 다시 확인합니다.
- 현재 시험 지문에 클러스터 컨텍스트 전환(`kubectl config use-context`)이 나오는지는 공식 문서에서 확인하지 못했습니다. 공식 안내는 과제마다 ssh로 호스트를 옮기는 방식만 적습니다.
- 문항별 배점, Killercoda 무료 시나리오의 현재 범위는 확인하지 못했습니다.
- 후기의 점수와 준비 기간은 각자의 경험입니다. 후기에 적힌 출제 문항은 시험 규정상 공유가 민감할 수 있어 옮기지 않았습니다.
- 이 글은 응시 전에 쓴 계획입니다. 응시한 뒤 결과와 바뀐 판단을 덧붙이겠습니다.

## 참고 자료

공식 문서
- Linux Foundation, [Certified Kubernetes Administrator (CKA)](https://training.linuxfoundation.org/certification/certified-kubernetes-administrator-cka/)
- Linux Foundation, [Important Instructions: CKA and CKAD](https://docs.linuxfoundation.org/tc-docs/certification/tips-cka-and-ckad), [Frequently Asked Questions: CKA and CKAD & CKS](https://docs.linuxfoundation.org/tc-docs/certification/faq-cka-ckad-cks), [Resources Allowed](https://docs.linuxfoundation.org/tc-docs/certification/certification-resources-allowed)
- Linux Foundation, [CKA Upcoming Program Changes](https://training.linuxfoundation.org/certified-kubernetes-administrator-cka-program-changes/)
- CNCF, [CKA Curriculum v1.37](https://github.com/cncf/curriculum/blob/master/CKA_Curriculum_v1.37.pdf)
- Kubernetes, [Upgrading kubeadm clusters](https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/kubeadm-upgrade/), [Operating etcd clusters for Kubernetes](https://kubernetes.io/docs/tasks/administer-cluster/configure-upgrade-etcd/), [kubectl Quick Reference](https://kubernetes.io/docs/reference/kubectl/quick-reference/)
- [killer.sh CKA](https://killer.sh/cka), [FAQ](https://killer.sh/faq)

후기
- 최민석, [CKA 합격 후기](https://minseoky.me/devops/kubernetes/cka_journey), 2025
- kt ds CoE팀, [CKA 자격증 취득을 위한 여정](https://inblog.ai/ktds-ict-tech4u/cka-%EC%9E%90%EA%B2%A9%EC%A6%9D-%EC%B7%A8%EB%93%9D%EC%9D%84-%EC%9C%84%ED%95%9C-%EC%97%AC%EC%A0%95-27329), 2024
- Domenic Cassisi, [I passed the CKA! My Exam Experience (2026)](https://dcassisi.com/2026/06/09/i-passed-the-cka-my-exam-experience-2026/), 2026
- Atsushi Suzuki, [CKA (Certified Kubernetes Administrator) Exam Report 2026: Don't Rely on Old Guides](https://dev.to/suzuki0430/cka-certified-kubernetes-administrator-exam-report-2026-dont-rely-on-old-guides-mastering-the-534m), 2026
- 109x79m, [【2025年2月改訂版】CKA受験体験記](https://qiita.com/109x79m/items/c7057af1d073c43b6575), 2026
- yu-min, [業務未経験から半年でKubestronaut達成（KCNA/KCSA/CKA/CKAD/CKS全冠）勉強法まとめ](https://zenn.dev/yuu7751/articles/24f509769b97b5), 2025
- cnative_tkb, [CKA-JP 更新試験 受験記 — 2026年版](https://zenn.dev/cnative_tkb/articles/2d1447e98a7aed), 2026
- Aditya Nakadi, [How I passed CKA 2025: My Experience and Strategy](https://medium.com/@adityanakadi3/how-i-passed-cka-2025-my-experience-and-strategy-ad453ba1c513), 2025
- techwithmohamed, [CKA-Certified-Kubernetes-Administrator](https://github.com/techwithmohamed/CKA-Certified-Kubernetes-Administrator), 2026
- KodeKloud 커뮤니티, [CKA real exam 2026 vs Mock ultimate mock and killer sh](https://kodekloud.com/community/t/cka-real-exam-2026-vs-mock-ultimate-mock-and-killer-sh/501584), 2026

---
title: '[CKA Ch-07] 준비 자료와 시험 당일 전략: 공식 규칙, 할인, 연습 환경, 후기 경향 정리'
description: CKA(커리큘럼 v1.37, 2025년 2월 개정 범위)를 준비할 때 쓸 수 있는 정당한 자료를 2026년 10월 기준으로 모았습니다. Linux Foundation 공식 규칙과 점검표, 과제마다 ssh로 옮기는 시험 환경과 사전 설치 도구, 날짜가 확인된 할인 이력, killer.sh와 Killercoda와 KodeKloud와 GitHub 연습 저장소 비교, 홈 랩 구성, 2025~2026년 후기에서 겹친 출제 경향과 함정, 1.33~1.37 변경 중 시험 답에 영향을 주는 것, 시험 당일 순서와 D-30 계획, 덤프를 뺀 근거를 LF 응시 약관 원문으로 정리합니다.
date: 2026-10-20T00:00:00.000Z
tags:
  - CKA
  - Kubernetes
  - Certification
  - killer.sh
  - Exam Strategy
category: cert/CKA
topics:
  - cert
draft: false
series: "CKA 공부"
seriesOrder: 7
---

## 결론부터

1. 응시권 하나($445, 2026년 10월 20일 기준)에는 재응시 1회와 killer.sh 시뮬레이터 2회가 들어 있습니다. 구매 후 12개월 안에 응시해야 하고 예약 변경은 24시간 전까지만 됩니다. 예정 시각에서 30분이 지나도록 시작하지 못하면 결시가 되고 환불도 재응시도 없습니다.
2. 정가로 살 이유는 적습니다. Linux Foundation(LF)은 2024년과 2025년 모두 12월 초 Cyber Week에 단일 시험 50% 할인을 했습니다(2025년은 제3자 기사 기준). 지금 진행 중인 할인은 LF CKA 시험 페이지에서 확인합니다. 국내에서는 LF 공인 교육 파트너로 표기된 프로그래머스가 바우처를 552,000원(20% 할인가, 2026년 10월 20일 확인)에 팝니다.
3. 연습은 강의와 랩(KodeKloud), 무료 시나리오(Killercoda), 공식 시뮬레이터(killer.sh 2회) 순서로 잡습니다. killer.sh가 실제 시험보다 어렵다는 평가는 응시자와 강의 운영진에게서 나왔고 공식 문서에는 그런 비교가 없습니다. 풀이를 보고 배우는 용도로 씁니다.
4. 덤프를 쓰지 않은 2025~2026년 후기에서 반복해 나온 주제는 트러블슈팅(kubelet, 인증서와 kubeconfig, 컨트롤 플레인), Helm, Gateway API, CNI 설치, Kustomize, CRD입니다. 가장 흔한 실패 원인은 시간 부족이었고 모의고사 점수와 실제 점수가 크게 어긋난 사례도 여럿 있었습니다.
5. 시험은 과제마다 `ssh`로 호스트를 옮겨 푸는 방식이라 `kubectl config use-context`를 문항마다 치던 옛 팁은 필요 없습니다. 공식 사전 설치 도구는 `kubectl`(alias `k`), `yq`, `curl`, `wget`, `man`입니다. `jq`와 `tmux`는 2025년 3월 판부터 목록에서 빠졌고 `helm`과 `etcdctl`은 해당 과제 호스트에 있을 가능성이 높은 정도입니다.
6. 덤프와 "실제 시험 문제"를 표방하는 자료는 이 글에서 다루지 않습니다. LF 응시 약관 4.4절은 다른 사람의 기억에 기댄 자료(braindump)를 쓰는 것 자체를 부정행위로 정의하고 자격 취소와 영구 응시 제한까지 적어 둡니다.

시험 구조와 영역별 범위는 [CKA Ch-00](/blog/cert/cka/cka-00-exam-and-study-plan)에, 영역별 내용은 [Ch-02](/blog/cert/cka/cka-02-cluster-architecture)부터 [Ch-06](/blog/cert/cka/cka-06-troubleshooting)까지에 있습니다. 이 글은 그 위에서 자료와 규칙과 당일 운영만 다룹니다.

---

## 1. 공식 자료와 규칙

LF 공식 페이지와 응시자 핸드북(PSI Bridge 판), CKA·CKAD 안내 문서, killer.sh FAQ를 2026년 10월 20일에 읽고 정리했습니다. 키 조작과 허용 문서 목록의 자세한 표는 Ch-00에 있습니다.

### 1-1. 응시권에 들어 있는 것

| 항목 | 내용 | 출처 |
|---|---|---|
| 가격 | 시험만 $445. THRIVE-ONE 연간 구독 묶음 $625, LFS258 강의 묶음 $645 | LF CKA 페이지 |
| 응시 기회 | 2회(첫 응시와 재응시 1회) | LF CKA 페이지, 핸드북 |
| 시뮬레이터 | killer.sh 2회. 활성화 후 각 36시간. 단일 등록 상품(CKA-SINGLE)에는 없음 | LF FAQ |
| 결과 | 자동 채점. 보통 종료 후 24시간 안에 이메일. 문항별 성적은 알려 주지 않음 | LF FAQ, 핸드북 채점 안내 |
| 채점 방식 | 결과가 맞으면 푸는 방법은 상관없음(과제가 방법을 지정하지 않은 경우) | 핸드북 채점 안내 |
| 유효 기간 | 2년. 만료 전에 다시 합격하면 합격일부터 2년 연장 | LF FAQ |
| CKS 연계 | CARE(Certification Advancement & Recertification Experience) 확장. 2026년 6월 18일부터 CKS에 합격하거나 갱신하면 CKA가 자동으로 연장되고 이미 만료된 CKA도 복원된다. CKA 만료일은 새 CKS 날짜에 맞춘다 | LF 공지(2026-06-18), LF FAQ |
| 문제 언어 | 영어, 중국어 간체, 일본어. 한국어는 없음. 감독관 채팅과 터미널은 영어 | LF FAQ, ExamUI 안내 |

### 1-2. 일정과 환불 규칙

| 규칙 | 내용 |
|---|---|
| 응시 가능 기간 | 등록일부터 12개월. 포털의 만료일이 마지막 응시 가능일 |
| 예약 | 최소 24시간 전, 최대 90일 뒤까지 |
| 변경과 취소 | 시작 24시간 전까지. 24시간 안에는 변경 불가 |
| 결시 | 예정 시각 30분이 지나도록 시작하지 않으면 결시. 환불과 재응시 모두 없음 |
| 환불 | 구매 후 3영업일 안이고 아직 예약하거나 응시하지 않았을 때만 |
| 재응시 | 불합격하면 이유와 상관없이 1회(자격이 될 때). 최초 구매일로부터 12개월 안에 응시해야 함. 재응시가 없는 단일 응시 상품도 있음. 두 번 모두 불합격하면 새로 사야 함 |
| 재구매 | 한 번에 활성 주문은 하나. 지금 주문을 다 써야 다음 주문이 열림 |

### 1-3. 시험 전 점검표

| 점검 항목 | 기준 | 출처 |
|---|---|---|
| 모니터 | 1대만 활성. 15인치 이상, 1920x1080 권장. 듀얼 모니터는 Secure Browser가 검사해서 막음 | 핸드북 응시 요건 |
| 가상 머신 | VM 안에서는 응시 불가(호환성 검사를 통과해도 불가) | 핸드북 응시 요건 |
| 회사 장비 | 보안 도구와 업무 앱이 시험 소프트웨어를 방해할 수 있어 권하지 않음. 방화벽이 설치를 막을 수 있음 | 핸드북 응시 요건 |
| 맥 권한 | 시스템 설정의 마이크, 카메라, 자동화, 입력 모니터링에서 PSI Secure Browser 허용 | 핸드북 응시 요건 |
| 메모리와 전원 | 시험 전 재부팅해서 RAM 50% 이상 비워 두기. 노트북은 전원 연결 | 핸드북 응시 요건 |
| 네트워크 | 유선 권장. 같은 네트워크의 대용량 전송과 동기화 중지. `*.s3.amazonaws.com` HTTPS 접근이 막히면 안 됨 | 핸드북 응시 요건 |
| 웹캠 | 방을 비출 수 있게 움직일 수 있어야 함 | 핸드북 응시 요건 |
| 방 | 혼자 있는 닫힌 방. 카페와 개방형 사무실 불가. 책상 위와 아래, 벽에 종이나 기기 없음 | 핸드북 응시 요건 |
| PSI 연습 튜토리얼 | 약 30분, 최대 3번 실행. 예약 150분 전까지 가능. 시험 1~3일 전에 하라고 권함 | 핸드북 PSI 튜토리얼 |
| 이름 | 체크리스트에 신분증과 똑같이 입력. 신분증 이름이 한국어 등 비라틴 문자면 그 문자도 함께 입력. 시험 시작 버튼을 누르기 전이 마지막 수정 기회 | 핸드북 체크리스트 |
| 신분증 | 유효기간이 남은 정부 발급 원본 실물. 사본, 전자, 임시 신분증 불가 | 핸드북 신분 확인 |
| 체크인 | 예정 30분 전부터 입장. 신분증 촬영, 셀카, 방 스캔. 체크인 담당자 대기는 15분을 넘지 않는다고 안내 | 핸드북 응시 안내 |
| 연결 끊김 | 다시 들어가면 체크인부터 반복. 타이머는 멈추지 않고 시간을 돌려주지 않음 | 핸드북 응시 안내 |

### 1-4. 시험 화면에서 알아 둘 것

키 조작(Ctrl+Shift+C/V, Ctrl+Alt+W, INSERT 금지)과 허용 문서(kubernetes.io/docs, kubernetes.io/blog, helm.sh/docs, gateway-api.sigs.k8s.io)는 [Ch-00 3절](/blog/cert/cka/cka-00-exam-and-study-plan)에 있습니다. 공식 안내에서 추가로 확인한 것은 다음과 같습니다.

- 시작 호스트(`base`)에는 `kubectl`이 없습니다. 모든 작업은 과제가 지정한 호스트에 `ssh`로 들어가서 합니다. ssh 안에서 다시 ssh는 할 수 없고 `base`를 재부팅하면 시험 환경이 다시 시작되지 않습니다.
- 모든 ssh 호스트에 `kubectl`(alias `k`, bash 자동완성), `yq`, `curl`, `wget`, `man`이 "pre-installed and pre-configured" 상태입니다. 2025-02-11 판까지 목록에 있던 `jq`와 `tmux`는 2025-03-28 판부터 빠졌고 `jq` 자리에 `yq`가 들어왔습니다(Wayback Machine 대조).
- Resources Allowed는 패키지 설치가 과제 수행에 필요하지 않다고 적습니다. 그래서 `helm`과 `etcdctl`은 해당 과제가 나오는 호스트에 있을 가능성이 높습니다. 도구 이름을 밝힌 공식 문장은 없습니다. `etcdutl`, `crictl`, 단독 `kustomize`는 근거가 없으니 `which`로 먼저 확인합니다. `kubectl apply -k`와 `kubectl kustomize`는 kubectl에 내장입니다.
- 허용 문서 네 곳 외에 과제의 Quick Reference 상자 링크와 /usr/share 아래 문서도 볼 수 있습니다. 허용 문서 안의 검색은 되지만 외부 검색 결과를 여는 것은 안 됩니다.
- VSCodium의 확장 설치는 금지입니다. 내장 터미널은 써도 됩니다.
- Firefox에는 Simple Translate 확장이 깔려 있습니다. 번역된 문서도 허용되지만 LF는 최신 내용인 영어판을 권합니다.
- 화면 확대는 PSI 툴바의 +와 - 버튼으로 하고 설정(톱니) 메뉴에 화면 맞춤과 해상도 변경, Reset Desktop이 있습니다.

### 1-5. killer.sh 시뮬레이터

| 항목 | 내용 |
|---|---|
| 구성 | CKA-A와 CKA-B 두 세트, 각 17문항. 세트마다 문항이 다름 |
| 기준 버전 | Kubernetes 1.37(killer.sh FAQ) |
| 접근 시간 | 활성화 후 36시간. 쓴 시간과 상관없이 활성화 시점부터 흐르므로 여러 날에 나눠 쓸 수 없음 |
| 재시작 | 36시간 안에 Exam Controls의 Restart Session으로 환경 초기화 가능. 부팅 시간만큼 만료가 늦춰짐 |
| 점수 | 하위 과제별 채점. 퍼센트는 보여 주지 않음 |
| 풀이 | 120분 카운트다운이 끝나거나 직접 멈추면 풀이와 점수가 열림. 36시간이 지나도 문제와 풀이는 계속 볼 수 있음 |
| 실제 시험과 다른 점 | Chrome이나 Firefox에서 열림, 접속 가능한 URL 제한 없음, 원격 데스크톱과 원격 터미널을 바꿔 쓸 수 있음 |
| 추가 구매 | 2회 $39.99. 12개월 안에 같은 시뮬레이터를 받은 적이 있으면 1회 $9.99 |

난이도에 대해 killer.sh는 CKA 페이지에서 "The CKA is hard but a rewarding certification"이라고만 적고 실제 시험과 직접 비교하지 않습니다. 실제 시험보다 어렵다는 평가는 KodeKloud 커뮤니티 답변(2026년 3월 KodeKloud 측, 2026년 8월 다른 사용자)과 여러 후기에서 나왔습니다.

## 2. 할인과 비용

날짜와 출처를 확인한 것만 적었습니다. 쿠폰 코드는 금방 바뀌어서 이름은 생략했습니다.

| 시기 | 내용 | 출처와 확인 수준 |
|---|---|---|
| 2024-12-02 ~ 2024-12-11 | Cyber Monday. 개별 강의와 시험 50%. 실기 시험 $395 → $198. THRIVE 연간 구독과 묶으면 65% | LF 공식 블로그 |
| 2025-01-21 ~ 2025-01-31 | 사이트 전체 35%, THRIVE 묶음 40%. 2025-02-04 가격 인상 전 행사 | LF 공식 블로그 |
| 2025-12-01 ~ 2025-12-09 | Cyber Week. 개별 시험 50%, 번들 60%, THRIVE-ONE 묶음 최대 65%. 구매마다 $100 상품권(2026-01-01 ~ 2026-10-31 사용) | 제3자(It's FOSS, techbeatly, DevOpsCube). LF 공식 공지는 찾지 못함 |
| 2026-10-16 ~ 2026-10-23 | Cybersecurity Awareness Month. 사이버보안 교육과 시험 40%, 그 밖의 교육과 시험 35%. CKA는 35% 쪽으로 추정 | [LF 공식 블로그](https://training.linuxfoundation.org/blog/stay-ahead-of-cyber-threats/) |
| 상시 | killer.sh CKA 페이지에 CKA 시험 구매 30% 할인 코드가 적혀 있음 | killer.sh 공식 페이지(2026-10-20 확인) |
| 상시 | 프로그래머스 CKA 바우처 690,000원 → 552,000원(20%). 구매 후 7일 안에 LF 사이트에서 등록, 등록일부터 1년 안에 응시. 환불은 7일 안 미사용 시만 | 프로그래머스 페이지(2026-10-20 확인). 페이지 제목에 "Linux Foundation ATP" 표기 |

확인하지 못한 것도 있습니다.

- 학생 할인은 LF 공식 문서에서 찾지 못했습니다.
- KubeCon 기간 할인은 KodeKloud 커뮤니티 답변에 "블랙프라이데이와 KubeCon 무렵에 할인이 나오곤 했다"는 말이 있을 뿐 LF 공식 근거는 찾지 못했습니다.
- 가격은 행사마다 기준가가 달랐습니다. 2024년 공지는 $395를 기준으로 썼고 2026년 10월 정가는 $445입니다.

정리하면 응시권은 12개월 동안 유효하므로 12월 초 Cyber Week나 상시 할인으로 사 두고 그 뒤에 일정을 잡는 쪽이 비용이 가장 적게 듭니다. 다만 12개월 안에 두 번을 다 써야 하니 공부 시작 시점에 맞춰 사는 편이 안전합니다.

## 3. 연습 자료 비교

"난이도"는 공식 수치가 없어 후기에서 나온 평가를 옮겼습니다. "개정 반영"은 2025년 2월에 들어온 Helm, Kustomize, Gateway API, CRD를 다루는지로 봤습니다.

| 자료 | 비용 | 범위 | 난이도(후기 기준) | 개정 반영 | 링크 |
|---|---|---|---|---|---|
| killer.sh CKA | 응시권에 2회 포함, 추가 2회 $39.99 | 17문항 x 2세트, 풀이와 팁 약 100쪽 | 실제 시험보다 어렵다는 평이 일관됨 | 1.37 기준(FAQ) | [killer.sh/cka](https://killer.sh/cka) |
| KodeKloud CKA 강의(Udemy판도 같은 강사) | 유료 | 17개 모듈, 영상 26시간, 랩 다수, 모의고사 3회 | 모의고사 고득점이 실제 합격으로 이어지지 않은 사례 있음(2026-08) | Helm·Kustomize 2025-01-27 추가, Gateway API와 CRD 랩 있음. 랩 환경 1.35(2026-04-10) | [KodeKloud CKA](https://kodekloud.com/courses/cka-certification-course-certified-kubernetes-administrator) |
| KodeKloud Ultimate CKA Mock Exam Series | 유료 | 모의고사 5회(Suzuki 후기 기준) | 2026-08 후기 1건은 이 시리즈에서 90% 안팎, 실제 시험 61% | 확인 못 함 | KodeKloud 사이트 |
| Killercoda CKA 커뮤니티 시나리오 | 무료(Kim Wüstkamp 시나리오 강좌는 유료 멤버십) | Chad M. Crowell, Sachin H R, Alexis Carbillet 등의 시나리오 | 짧은 단위 반복용. 일부 시나리오가 개정 전 형식이라는 후기 있음 | 시나리오 목록은 페이지가 스크립트로 그려져 확인 못 함 | [killercoda.com/cka](https://killercoda.com/cka) |
| kubernetes.io Tasks | 무료 | 시험장에서 볼 수 있는 바로 그 문서 | 해당 없음 | 최신 | [Tasks](https://kubernetes.io/docs/tasks/) |
| theplatformlab/CKA-Certified-Kubernetes-Administrator(옛 techwithmohamed) | 무료 | 연습 31개, YAML 뼈대 23개, 15문항 모의고사 2회 | 작성자 89%(2026-03, 자기 보고) | v1.35. Gateway API와 Helm 연습 있음, CRD는 얕음 | [GitHub](https://github.com/theplatformlab/CKA-Certified-Kubernetes-Administrator) |
| techiescamp/cka-certification-guide | 무료(유료 강의 홍보 포함) | 영역별 노트, 연습 35문항, Vagrant와 kind 랩 폴더 | 해당 없음 | v1.35와 v1.37 표기가 섞여 있음. Gateway API가 가장 자세하고 Helm·Kustomize·CRD는 짧음 | [GitHub](https://github.com/techiescamp/cka-certification-guide) |
| walidshaari/Kubernetes-Certified-Administrator | 무료 | 영역별 공식 문서 링크 모음과 학습 가이드 | 해당 없음 | v1.35 기준으로 Helm, Kustomize, CRD, Gateway API 항목 있음 | [GitHub](https://github.com/walidshaari/Kubernetes-Certified-Administrator) |
| alijahnas/CKA-practice-exercises | 무료 | 5개 영역 연습 문제와 풀이, Terraform | 해당 없음 | v1.27 기준. 개정 항목 없음 | [GitHub](https://github.com/alijahnas/CKA-practice-exercises) |
| chadmcrowell/CKA-Exercises | 무료 | 5개 영역 연습, 2025 변경 폴더 | 해당 없음 | 본문 버전 표기가 서로 어긋남. 개정 항목은 별도 폴더에만 | [GitHub](https://github.com/chadmcrowell/CKA-Exercises) |
| CK-X(sailor-sh) | 무료(개인·교육용, BSL 1.1) | 로컬 Docker로 띄우는 시험형 시뮬레이터, 자동 채점 | 해당 없음 | CKA 랩 수와 문제 출처는 표기 없음 | [GitHub](https://github.com/sailor-sh/CK-X) |
| Kubernetes The Hard Way | 무료 | kubeadm 없이 컨트롤 플레인을 손으로 구성 | 학습용 | v1.32 기준. 시험 범위 밖 내용도 많음 | [GitHub](https://github.com/kelseyhightower/kubernetes-the-hard-way) |
| 『CKA Study Guide』 2판(O'Reilly, Benjamin Muschko) | 유료 | 책 | 해당 없음 | 2026-02 출간, Helm·Kustomize·Gateway API·CRD 포함(제3자 서평 기준) | 출판사 페이지 |
| 『Acing the CKA Exam』 2판(Manning, Chad M. Crowell 외) | 유료 | 책 | 해당 없음 | 2025-11 출간, 오퍼레이터·Gateway API·Kustomize 포함(제3자 서평 기준) | 출판사 페이지 |

표에 넣은 GitHub 저장소는 모두 연습 문제를 직접 만들었다고 밝히거나 공식 문서 링크를 모은 것입니다. theplatformlab 저장소는 "All exercises are independently designed training scenarios"와 "It does not include, share, or reproduce actual CKA exam questions"라는 문구를 README에 적어 두었습니다. 제목이나 설명에 "실제 시험 문제", "기출", "real exam questions"를 내건 강의와 영상과 저장소는 출처가 응시자 기억일 가능성이 높아 표에서 뺐습니다. 8절의 약관 조항이 그 근거입니다.

자료를 고를 때 본 기준은 세 가지입니다.

- 개정 항목(Helm, Kustomize, Gateway API, CRD)을 실습으로 다루는지. 2025년 이전 자료는 이 넷이 비어 있습니다.
- 시험장 문서(kubernetes.io, helm.sh, gateway-api.sigs.k8s.io)만 보고 풀 수 있게 연습시키는지.
- 문제 출처를 밝히는지.

## 4. 홈 랩 구성

<details>
<summary>기초부터: VirtualBox와 Vagrant로 kubeadm 연습용 VM 준비하기</summary>

> **핵심 한 줄**: VirtualBox는 VM을 실제로 돌리는 엔진이고 Vagrant는 VM 여러 대의 사양을 `Vagrantfile` 한 파일에 적어 두고 명령 한 줄로 만들어 주는 도구입니다.

#### 1. 왜 필요한가

kubeadm은 이미 있는 리눅스 머신 위에 쿠버네티스를 올릴 뿐 머신을 만들지 않습니다. 노드 3대를 손으로 만들면 OS 설치 화면을 세 번 넘겨야 하고 IP를 하나씩 맞추다 실수하기 쉽습니다.

| 방식 | VM 3대 준비 | 다시 만들 때 |
|---|---|---|
| 손으로 설치 | ISO를 받아 VM마다 설치 화면을 넘김 | 처음부터 반복 |
| Vagrant | `vagrant up` 한 번 | `vagrant destroy` 뒤 `vagrant up`이면 같은 환경 |

#### 2. 어떻게 동작하나

1. **준비**: 호스트 OS에 맞는 VirtualBox와 Vagrant를 각 공식 페이지에서 받아 설치합니다.
2. **명세**: `Vagrantfile`에 box(OS 이미지), VM 이름, CPU, 메모리, 사설 IP를 적습니다. 강의 저장소를 클론하면 이 파일이 이미 들어 있습니다.
3. **생성**: `vagrant up`이 box를 받고 파일에 적힌 순서대로 VM을 만들어 부팅합니다.
4. **접속**: `vagrant ssh <이름>`으로 들어가고 `exit`(또는 `logout`)로 나옵니다.

```ruby
Vagrant.configure("2") do |config|
  config.vm.box = "<box 이름>"
  ["controlplane", "node01", "node02"].each_with_index do |name, i|
    config.vm.define name do |node|
      node.vm.hostname = name
      node.vm.network "private_network", ip: "192.168.56.#{11 + i}"
      node.vm.provider "virtualbox" do |vb|
        vb.cpus = 2
        vb.memory = 2048
      end
    end
  end
end
```

```bash
vagrant status            # 만들기 전에는 not created, 만든 뒤에는 running
vagrant up                # 전부 생성하고 부팅. 처음에는 box를 받느라 오래 걸림
vagrant ssh controlplane  # 노드 안으로
vagrant halt              # 전부 끄기
vagrant destroy -f        # 전부 지우기
```

#### 3. 헷갈리는 점

- `192.168.56.x`는 VM끼리 통하는 노드 IP입니다. 나중에 CNI가 Pod에 나눠 줄 대역과 겹치지 않게 둡니다. 리눅스와 macOS의 VirtualBox는 host-only 네트워크에 기본으로 `192.168.56.0/21` 범위만 허용해서 예제가 이 대역을 씁니다.
- 강의 저장소의 `Vagrantfile`은 VM 이름을 `kubemaster`, `kubenode01`, `kubenode02`로 씁니다. 위 예시의 `controlplane`, `node01`과 이름만 다르고 구조는 같으니 `vagrant ssh kubemaster`처럼 저장소에 적힌 이름으로 들어갑니다.
- 오래된 강의 저장소는 지원이 끝난 Ubuntu 18.04 box를 쓰기도 합니다. 지금 kubeadm 패키지를 올리려면 지원 중인 Ubuntu box로 바꿔 씁니다.
- 애플 실리콘 맥은 아래 본문처럼 VirtualBox 대신 Multipass 스크립트를 씁니다.

> **정리**: VM은 Vagrant로 찍고 그 위에 kubeadm을 올립니다. 노드 IP와 Pod 대역을 따로 잡아 두는 것이 다음 단계(Ch-02의 kubeadm init)를 편하게 합니다.

</details>

시험 환경은 kubeadm으로 만든 클러스터에 노드마다 ssh로 들어가는 구조입니다. 그래서 연습 환경도 주제에 따라 나눠 쓰는 편이 맞습니다.

| 환경 | 만드는 방법 | 맞는 연습 | 한계 |
|---|---|---|---|
| kind | `kind create cluster --config`로 컨트롤 플레인 1대와 워커 여러 대. 안정 버전 v0.33.0(2026-10 문서) | RBAC, 워크로드, Service, NetworkPolicy, Helm, Kustomize, Gateway API, CRD. `disableDefaultCNI: true`로 CNI 설치 연습 | 노드가 컨테이너라 kubeadm 업그레이드나 노드 조인처럼 노드 자체를 다루는 연습에는 덜 맞음(판단) |
| minikube | `minikube start --nodes 2 -p <이름>` | 단일 기능 확인 | 기본 hostpath 프로비저너가 다중 노드를 지원하지 않아 PV 연습에는 CSI Hostpath 애드온이 필요 |
| VM에 kubeadm | 머신마다 2GB 이상 RAM, 컨트롤 플레인 2 CPU 이상, 스왑 처리. 맥은 Multipass | kubeadm init과 join, 업그레이드, etcd 백업과 복구, static Pod와 kubelet 트러블슈팅 | 메모리를 많이 씀 |
| Killercoda 플레이그라운드 | 브라우저에서 바로 | 설치 없이 짧게 반복 | 세션 시간이 제한됨 |

애플 실리콘 맥이면 KodeKloud가 공개한 [certified-kubernetes-administrator-course 저장소](https://github.com/kodekloudhub/certified-kubernetes-administrator-course)의 `kubeadm/kubeadm-clusters/apple-silicon` 스크립트가 Multipass로 VM을 만들고 `/etc/hosts`까지 맞춰 줍니다. KodeKloud 안내는 최소 8GB(이때는 컨트롤 플레인 1대와 워커 1대), 3노드는 16GB 이상을 권합니다. KodeKloud 커뮤니티에는 ARM 맥에서 VirtualBox가 동작하지 않는다는 답변이 있고 LF 포럼(LFS258)에는 Multipass 노드를 껐다 켜면 `/etc/hosts`가 되돌아가 워커 조인이 깨졌다는 보고가 있습니다.

kind로 CNI 설치까지 연습하는 설정은 공식 문서의 옵션 둘을 합치면 됩니다.

```yaml
# kind-cka.yaml: CNI 없이 1+2 노드 클러스터
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
networking:
  disableDefaultCNI: true
  podSubnet: "10.244.0.0/16"
nodes:
- role: control-plane
- role: worker
- role: worker
```

```bash
kind create cluster --name cka --config kind-cka.yaml
kubectl get nodes   # CNI가 없어 NotReady인 상태에서 시작
```

kubeadm 클러스터를 처음부터 만드는 순서는 [Ch-02 2~4절](/blog/cert/cka/cka-02-cluster-architecture)에, 일부러 망가뜨리고 고치는 과제는 [Ch-06](/blog/cert/cka/cka-06-troubleshooting)의 "직접 해 보기"에 있습니다.

## 5. 2025~2026년 후기에서 공통으로 나온 출제 경향과 함정

2025년 2월 개정 뒤에 응시했고 덤프나 기억 기반 문제집을 쓰지 않았다고 확인되는 글만 읽었습니다. 출제 내용은 주제 수준으로만 옮깁니다.

| 글 | 결과 | 준비 | 이 절에서 쓴 내용 |
|---|---|---|---|
| Matt Bargenquast, 개인 블로그(2025-02, 베타) | 글에 없음 | 글에 없음 | CKS보다 시간 압박이 커서 몇 문항을 남김. 문서 예시를 베끼는 문제보다 응용 문제. 문서 검색에 쓸 시간이 거의 없음 |
| KodeKloud 커뮤니티 스레드(2025-02 ~ 2025-03) | 응시자 여럿 | 해당 없음 | 개정 직후 응시자가 언급한 주제: CRD, Helm, 컨테이너 런타임·CNI·CSI 설치, HPA, PriorityClass, 기본 StorageClass, Ingress, NetworkPolicy |
| Nattapol, 개인 블로그(2025-06) | 78% | Udemy/KodeKloud, killer.sh, 공식 문서 | 새 주제로 HPA·VPA, Gateway API, CNI·CRI·CRD·Helm·Kustomize 설치. VPA는 `kubectl explain`이 도움. 17문항 중 준비 못 한 2문항은 건너뜀 |
| yu-min, Zenn(2025-10) | 1차 58%, 2차 69%, 약 80시간 | KodeKloud, killer.sh | 체크인 실패가 반복돼 시작이 크게 늦어짐. 조작마다 2~3초 지연. 울트라와이드 모니터는 화면 전체를 못 씀 |
| Atsushi Suzuki, dev.to(2026-01) | 72% | KodeKloud 모의고사 3회와 유료 모의고사 5회, killer.sh | 시간 부족으로 표시해 둔 트러블슈팅 문제에 돌아가지 못함. 문서 URL을 외워 둘 것. 네임스페이스 전환 alias 같은 옛 팁은 불필요 |
| Talha Juikar, 개인 블로그(2026-01) | 합격(점수 미기재) | KodeKloud, Killercoda, killer.sh, VM의 kubeadm 클러스터 | 트러블슈팅, 인증서·kubeconfig, etcd 명령과 kubeadm 플래그에서 시간이 듦. killer.sh가 실제보다 어려움. Hard Way는 선택 |
| cnative_tkb, Zenn(2026-05) | 점수 비공개, 약 30시간(실무 3년) | kubernetes.io, Killercoda, killer.sh, Udemy(Mumshad) | 시스템 점검 도구를 지운 뒤 시험 소프트웨어 설치. 윈도우 집중 모드와 업데이트 일시 정지. 외장 키보드면 입력기 전환 미리 확인 |
| Domenic Cassisi, 개인 블로그(2026-06) | 95% | KodeKloud, Killercoda 커뮤니티 시나리오, Kubernetes The Hard Way, killer.sh | 막히면 넘기고 마지막에 요구사항 재확인. `kubectl explain` 사용. 직접 만든 alias는 ssh 이동 때 사라짐. 복잡한 리눅스 명령은 불필요 |
| 109x79m, Qiita(2026-07) | 69%, 약 4개월 | Udemy(Mumshad), killer.sh, 『Kubernetes完全ガイド』 | 16문항 중 5~6개가 어려웠고 1개는 못 풂. 쉬운 것부터. CKA-JP로 응시해도 문서는 영어 |
| yltw, dev.to(2026-07) | 글 작성 시점 결과 미확인 | Udemy, killer.sh(16/75 → 58/93) | 5분 규칙, 오래 걸리는 컨트롤 플레인 명령은 다른 터미널 탭에 두고 다음 작업 |
| Christophe, KodeKloud 커뮤니티(2026-08) | 61%, 44%(두 번 불합격) | KodeKloud 전 과정, 약 6개월 | KodeKloud 모의고사는 90% 안팎이었음. CNI 설치와 Gateway API 리소스 관계에서 막힘 |

### 5-1. 주제 수준의 경향

- 트러블슈팅: 노드가 NotReady일 때 kubelet과 컨테이너 런타임 확인, 망가진 컨트롤 플레인 구성요소 복구가 여러 글에 나옵니다. 비중 30% 영역이라 [Ch-06](/blog/cert/cka/cka-06-troubleshooting)의 판단 순서를 손에 익히는 것이 가장 큽니다.
- 설치형 과제: CNI 설치, 컨테이너 런타임 설치, Helm 차트 설치가 개정 직후부터 계속 언급됩니다. 2026년 8월 불합격 후기는 CNI 설치에서 Pod CIDR을 바꿔야 하는지 판단이 서지 않았다고 적었습니다. 과제가 요구하지 않은 값은 바꾸지 않고 클러스터의 실제 Pod CIDR을 먼저 확인하는 습관이 필요합니다. 확인 명령과 순서는 [Ch-02 7-2절](/blog/cert/cka/cka-02-cluster-architecture)에 정리했습니다.
- Gateway API: 2026년 8월 불합격 후기는 Gateway, GatewayClass, HTTPRoute, 호스트 이름, NodePort Service가 어떻게 이어지는지 헷갈렸다고 적었고 Nattapol(2025-06)과 Suzuki(2026-01)도 Gateway API를 새로 공부한 주제로 꼽았습니다. 허용 문서인 gateway-api.sigs.k8s.io의 위치를 미리 익혀 둡니다. 내용은 [Ch-04 4절](/blog/cert/cka/cka-04-services-networking)에 있고 헤더 매칭, 필터, 다른 네임스페이스 참조(ReferenceGrant)는 4-6절에 따로 모았습니다.
- Helm과 Kustomize: 커리큘럼 문구는 "Helm과 Kustomize로 클러스터 구성요소 설치"입니다. 개정 직후 응시자들이 Helm 과제를 언급했고 2026년 8월 후기 작성자는 모의고사에서 Helm 문제를 건너뛰었다고 적었습니다. Kustomize는 yltw가 시험 전에 익힌 명령으로 꼽았습니다. 정리는 [Ch-02 6절](/blog/cert/cka/cka-02-cluster-architecture)에 있습니다.
- etcd와 kubeadm 업그레이드: 개정 커리큘럼에서 명시 항목이 빠졌고 후기도 갈립니다. Cassisi는 etcd가 실러버스에서 빠졌다고 판단했고 Juikar는 etcd 명령과 kubeadm 플래그에서 시간을 썼다고 적었습니다. 절차를 한 번씩은 손으로 해 봅니다([Ch-02 4장](/blog/cert/cka/cka-02-cluster-architecture)).
- 인증서와 kubeconfig: Juikar가 시간이 든 주제로 따로 꼽았습니다. `kubeadm certs check-expiration`, kubeconfig의 서버 주소와 인증서 경로 확인은 [Ch-06 1-4절](/blog/cert/cka/cka-06-troubleshooting)에 있습니다.
- 깊이: Cassisi는 복잡한 리눅스 명령이 필요 없었다고 적었고 커널 내부를 언급한 후기는 없었습니다. Hard Way 전 과정도 Cassisi와 Juikar 모두 선택으로 봤습니다.

### 5-2. 반복된 함정

- 시간: 합격한 후기에서도 "다 못 풀었다"(Suzuki), "1개는 못 풀었다"(Qiita)가 나옵니다. 공식 기준 120분에 15~20문항이면 문항당 6~8분입니다.
- 모의고사 점수: KodeKloud 모의고사 90% 안팎에서 실제 61%와 44%가 나온 사례, 1차 58%에서 2차 69%로 붙은 사례가 있습니다. 모의고사는 범위 점검용이고 실제 점수를 예측하지 못합니다.
- 플랫폼과 장비: 체크인 실패 반복과 원격 화면 지연이 여러 글에 나옵니다. 연결 문제가 생기면 시각과 증상을 적어 두고 그날 LF 지원에 문의합니다.
- 호스트 이동: 공식 안내상 ssh 안에서 다시 ssh는 안 되고 과제가 끝나면 `exit`로 돌아와야 합니다. 이전 과제의 노드에 남은 채 다음 과제를 시작하면 엉뚱한 클러스터를 고치게 됩니다.
- 화면 크기: 노트북 화면에서는 문서와 터미널을 오가며 시간이 샌다는 후기가 많았습니다. 단일 외장 모니터를 쓸 수 있으면 씁니다(노트북 화면은 꺼야 함).

### 5-3. 1.33~1.37 변경 중 답이 달라지는 것

시험 환경은 v1.37입니다. LF 안내문의 버전 표기는 1.35에서 1.36을 건너뛰고 2026-10-15 갱신판에서 1.37로 바뀌었습니다(출시 후 약 7주). 2024년 이전 강의와 후기는 그보다 4~5개 마이너 버전 앞이라 명령이나 기본값이 달라진 곳이 있습니다. 공식 문서와 릴리스 기록으로 확인한 것만 모았고 자세한 내용은 각 장에 있습니다.

| 버전 | 바뀐 것 | 시험 답에 주는 영향 | 근거 | 이 시리즈 |
|---|---|---|---|---|
| 1.33 | 네이티브 사이드카(`SidecarContainers`) stable | 사이드카 과제는 `initContainers`에 `restartPolicy: Always` | Sidecar Containers, Feature Gates | Ch-03 4-4 |
| 1.33 | Endpoints API 사용 중단 | Service 점검은 `kubectl get endpointslices -l kubernetes.io/service-name=<이름>` | Service, EndpointSlices | Ch-04 3-5 |
| 1.34(kubectl) | `kubectl autoscale --cpu`, `--memory` 추가, `--cpu-percent` 사용 중단 시작 | 사용률이면 `--cpu=60%`처럼 `%`를 붙인다 | CHANGELOG-1.34, kubectl autoscale 레퍼런스 | Ch-03 3-2 |
| 1.34 | `KubeletCgroupDriverFromCRI` stable, 스왑(`NodeSwap`) stable | kubelet이 런타임에서 cgroup 드라이버를 받는다. 스왑 기본 동작(kubelet 시작 실패)은 그대로 | Container Runtimes, Installing kubeadm | Ch-02 2-2, 2-4 |
| 1.34 | `RecoverVolumeExpansionFailure` stable | 확장에 실패한 PVC를 더 작은 값으로 다시 요청 가능 | Persistent Volumes | Ch-05 3-5 |
| 1.35 | in-place Pod resize stable | `kubectl patch pod ... --subresource resize` | Resize CPU and Memory Resources assigned to Containers | Ch-03 3-3 |
| 1.35 | kube-proxy `ipvs` 모드 사용 중단(1.40 기본 비활성, 1.43 제거 예정), cgroup v1 사용 중단 | 기본 모드는 여전히 `iptables`. kubelet `failCgroupV1` 기본 `true`라 cgroup v1 노드에서는 kubelet이 시작하지 않음 | Virtual IPs and Service Proxies, cgroups | Ch-04 1-2, Ch-02 2-4 |
| 1.36 | containerd 2.0 이상 필요. 1.35가 containerd 1.x를 지원하는 마지막 버전. containerd 호환표 기준 1.37은 2.3 이상, containerd 1.7은 2026-09-30 지원 종료 | 런타임 설정은 2.x 경로(`plugins.'io.containerd.cri.v1.runtime'...`)로 쓴다 | v1.35 릴리스 글, Container Runtimes | Ch-02 2-4 |
| 1.36 | Service `externalIPs` 사용 중단 | 새로 쓰지 않는다. 외부 노출은 NodePort, LoadBalancer, Gateway | v1.36 externalIPs 공지 | Ch-04 3-3 |
| 1.37 | kubeadm 설정 API `v1beta3` 제거 | 설정 파일은 `apiVersion: kubeadm.k8s.io/v1beta4`. 옛 파일은 1.35 kubeadm의 `kubeadm config migrate`로 바꾼다 | CHANGELOG-1.37 | Ch-02 3-1 |
| 1.37 | HPA `behavior.scaleUp/scaleDown.tolerance` stable | 허용 범위를 HPA마다 지정 | Horizontal Pod Autoscaling | Ch-03 3-2 |
| 1.37 | HPA scale to zero beta, 기본 활성 | Object나 External 메트릭을 쓰는 HPA는 `spec.minReplicas: 0` 가능. CPU와 메모리 기준으로는 불가 | v1.37 릴리스 글 | Ch-03 3절 |
| 1.37 | static Pod의 Secret, ConfigMap 참조가 완전히 금지되고 `PreventStaticPodAPIReferences` 게이트 제거 | static Pod 매니페스트에 `configMapRef`, `secretRef`를 넣으면 안 된다 | v1.37 릴리스 글 | Ch-06 2-5 |
| 1.37 | `metrics.k8s.io/v1` stable(v1beta1도 전환 기간 사용 가능) | `kubectl top` 명령은 같다. metrics-server 버전에 따라 제공 API 버전이 다를 수 있음 | v1.37 릴리스 글 | Ch-06 3-1 |
| 1.37 | kube-dns 애드온 빌드 1.40 이후 중단 예정 | CoreDNS도 Service 이름은 `kube-dns`를 그대로 쓴다. 이름과 애드온을 혼동하지 않는다 | v1.37 릴리스 글 | Ch-04 6절 |
| etcd 3.6 이후(kubeadm 1.37 기본 3.7.0, 1.36은 3.6.8) | `etcdctl snapshot status`, `snapshot restore` 제거 | 확인과 복구는 `etcdutl` | etcd CHANGELOG-3.6, kubeadm constants | Ch-02 4-5, 4-6 |
| Helm 4(2025-11) | `--atomic`이 `--rollback-on-failure`, `--force`가 `--force-replace`로 이름 변경. 새 릴리스는 server-side apply | 옛 이름은 경고와 함께 동작 | Helm 4 Overview | Ch-02 6-1 |
| 2026-03 | Ingress NGINX 유지보수 종료 | Ingress API는 동결된 GA로 남음. 새 기능은 Gateway API | Kubernetes 블로그 | Ch-04 5-1 |

Pod Security Admission(`pod-security.kubernetes.io/enforce` 같은 네임스페이스 라벨)은 v1.37 CKA 커리큘럼 문구에 없고 정책 설계는 CKS 쪽 주제입니다. Pod 생성이 거부될 때 `kubectl get ns <이름> --show-labels`로 이 라벨이 있는지 보는 정도면 충분합니다. 커리큘럼의 "Pod 승인" 항목은 [Ch-03 5-1절](/blog/cert/cka/cka-03-workloads-scheduling)의 LimitRange, ResourceQuota, PriorityClass로 정리했습니다.

## 6. 시험 당일 전략과 체크리스트

### 6-1. 시간 배분: 두 바퀴

| 구간 | 할 일 |
|---|---|
| 0~5분 | 문항 목록을 훑고 문항마다 난이도를 가늠 |
| 첫 바퀴(약 80분) | 6~8분 안에 끝낼 수 있는 과제부터 끝까지 풀고 검증. 5분을 넘기면 표시하고 넘김 |
| 두 바퀴(약 25분) | 표시해 둔 과제. killer.sh FAQ가 실제 시험도 하위 과제별 부분 점수가 있다고 하므로 이름이 지정된 리소스부터 만들어 둠 |
| 마지막 10분 | 30분, 15분, 5분 알림 중 15분 알림에서 새 과제를 멈추고 리소스 이름, 네임스페이스, 호스트를 다시 확인 |

표시 기능은 LF ExamUI 문서에서 확인하지 못했고 후기들이 표시하고 넘겼다고 적은 것을 옮겼습니다.

### 6-2. 과제 하나를 푸는 순서

결제 서비스를 예로 들면 이렇습니다.

```bash
# 1. 과제 상자에 적힌 호스트로 이동
ssh <과제에 적힌 노드 이름>

# 2. 네임스페이스를 명령마다 붙인다
k -n payment get deploy,svc

# 3. 매니페스트는 명령으로 뼈대를 만든다
k -n payment create deploy pay-api --image=nginx:1.27 --replicas=2 \
  --dry-run=client -o yaml > pay-api.yaml
k -n payment apply -f pay-api.yaml
k -n payment expose deploy pay-api --port=80

# 4. 필드 이름은 터미널에서 먼저 찾는다
k explain deploy.spec.strategy.rollingUpdate

# 5. 결과를 확인한다
k -n payment rollout status deploy/pay-api
k -n payment get endpointslices -l kubernetes.io/service-name=pay-api
k auth can-i list pods -n payment --as=system:serviceaccount:payment:pay-sa

# 6. base로 돌아온다
exit
```

- 과제를 끝까지 읽습니다. "하지 말라"는 조건, 출력 파일 경로, 네임스페이스를 놓쳐 점수를 잃었다는 후기가 많습니다.
- 권한이 필요하면 `sudo -i`나 명령 앞에 `sudo`를 붙입니다(공식 안내).
- `kubectl`(alias `k`와 자동완성), `yq`, `curl`, `wget`, `man`은 각 호스트에 이미 깔려 있어 alias를 따로 만들 필요가 적습니다. 값을 뽑을 때는 공식 목록에 없는 `jq` 대신 `-o jsonpath`나 `yq`를 씁니다.
- Service 연결은 임시 Pod에서 확인합니다. `k run tmp --rm -it --image=busybox:1.36 --restart=Never -- wget -qO- http://pay-api.payment` 같은 식입니다.

### 6-3. 호스트 이동과 권한

공식 안내는 과제마다 ssh로 호스트를 옮기는 방식만 적습니다. 과제 상자에 적힌 `ssh <노드>`를 먼저 실행하고 끝나면 `exit`로 base로 돌아옵니다. 권한이 필요하면 `sudo -i`나 명령마다 `sudo`를 씁니다. 공식 문구는 모든 ssh 호스트의 `kubectl`이 "pre-installed and pre-configured"라고 적으므로 `kubectl config use-context`를 문항마다 치던 옛 팁(2024년 이전 후기)은 필요 없습니다. 들어가면 `k get nodes`로 과제 클러스터인지 한 번 확인합니다. 과제가 특정 kubeconfig 파일을 주면 `--kubeconfig <파일>`을 붙입니다. kubeconfig 구조와 컨텍스트 개념은 [Ch-02 1-5절](/blog/cert/cka/cka-02-cluster-architecture)에 있습니다.

### 6-4. vim과 YAML

공식 안내가 말하는 것은 `i`로 입력 모드에 들어가고 Esc로 나온다는 것뿐입니다. 들여쓰기 설정은 일반적인 관행이고 공식 근거는 없습니다. 호스트마다 홈 디렉터리가 따로라 필요하면 그 호스트에서 다시 넣어야 합니다.

```vim
" ~/.vimrc (관행)
set expandtab tabstop=2 shiftwidth=2
```

문서에서 YAML을 붙여 넣다가 들여쓰기가 계단처럼 밀리면 붙여 넣기 전에 `:set paste`를 켭니다. 붙여 넣은 뒤 `yq . 파일명`으로 문법을 먼저 확인하면 `apply` 오류로 시간을 쓰는 일이 줄어듭니다.

### 6-5. 당일 체크리스트

| 시점 | 할 일 |
|---|---|
| D-3 ~ D-1 | PSI 연습 튜토리얼 실행(최대 3번, 예약 150분 전까지). 회사 장비 피하기. 맥이면 PSI 권한 4개 허용 |
| D-1 저녁 | 책상 위와 아래 비우기. 벽의 종이 떼기. 신분증 유효기간과 체크리스트 이름 확인 |
| 2시간 전 | 재부팅, 다른 앱 종료, 백신 검사 일시 정지, 전원 연결, 유선 연결, 가족에게 시간 알리기 |
| 30분 전 | 포털에서 시험 시작 버튼. 신분증 촬영, 셀카, 방 스캔. 라벨 없는 투명 용기의 음료만 |
| 시험 중 | 문제는 속으로 읽기. 얼굴과 입은 화면에 보이게. 과제마다 호스트 확인과 `exit` |
| 연결이 끊기면 | PSI 대시보드의 Access로 다시 들어가 체크인 반복. 시각과 증상을 적어 두고 그날 LF 지원에 문의 |
| 종료 후 | End Exam, End Session. 결과는 보통 24시간 안에 이메일 |

## 7. D-30 마무리 계획

[Ch-00의 공부 계획](/blog/cert/cka/cka-00-exam-and-study-plan) 1~4단계를 마친 뒤 시험 30일 전부터의 순서입니다. killer.sh는 활성화 후 36시간만 열리니 날짜를 정해 두고 씁니다.

| 기간 | 할 일 | 끝났다고 보는 기준 |
|---|---|---|
| D-30 ~ D-22 | 영역별 약점 정리. Ch-02~Ch-06의 "확인 문제"를 시간을 재며 풀기 | 영역마다 한 번씩 시간 안에 풂 |
| D-21 ~ D-15 | Killercoda 시나리오와 강의 모의고사를 실제 시간 제한으로. 문서는 kubernetes.io와 helm.sh, gateway-api.sigs.k8s.io만 열기 | 모의고사에서 시간이 남음 |
| D-14 | killer.sh A세트 활성화. 첫 120분은 실전처럼, 남은 시간에 풀이를 보며 다시 풀기. 풀이 페이지 저장 | 틀린 과제 목록이 생김 |
| D-13 ~ D-8 | 틀린 과제의 주제를 홈 랩에서 다시. 문서 위치를 메모 없이 찾아가기 | 같은 주제를 5분 안에 풂 |
| D-7 | killer.sh B세트. 두 바퀴 방식과 15분 알림 규칙을 그대로 연습 | 표시한 과제까지 돌아감 |
| D-6 ~ D-3 | 두 세트 풀이 복습, 트러블슈팅 순서 반복. PSI 연습 튜토리얼 | 튜토리얼 통과 |
| D-2 ~ D-1 | 새 공부는 멈추고 6-5절 점검표 확인 | 점검표 통과 |
| D-day | 6-1절 시간 배분대로 | |

불합격해도 재응시 기회가 남습니다. yu-min은 1차 불합격(5월 19일) 뒤 약 3주 반 만에 다시 응시해 합격했습니다. LF FAQ는 시뮬레이터를 "two attempts (per exam registration)"라고 적습니다. 재응시도 같은 등록 안의 기회라서 첫 응시 전에 2회를 다 썼다면 재응시 대비 세션은 추가로 사야 합니다.

## 8. 덤프를 뺀 근거: LF 응시 약관

이 글에서 덤프 사이트와 "실제 시험 문제"를 내건 자료를 이름도 링크도 없이 뺀 근거는 LF 응시 약관(LF Global Certification & Confidentiality Agreement)입니다. 시험 체크인 때 이 약관에 동의해야 시험이 열립니다.

2.1절(기밀 유지)은 시험 내용을 밝히는 것을 막습니다.

> You are expressly prohibited from disclosing, publishing, reproducing, or transmitting any exam and any related information including, without limitation, questions, answers, ... in whole or in part, in any form or by any means, oral or written, electronic or mechanical, for any purpose.

4.4절(부정행위)은 덤프를 쓰는 쪽도 부정행위로 정의합니다.

> Seeking and/or obtaining unauthorized access to examination materials (this includes using recollections of others or materials from previous administration of any Exam, a.k.a. braindump material, and/or any unauthorized publication of Exam questions with or without answers)

같은 절은 "reconstruction through memorization"을 포함해 실제 시험 내용을 퍼뜨리는 행위와 시험 중 AI 도움("using AI or ChatGPT")도 금지 목록에 둡니다. 결과도 적혀 있습니다. 부정행위가 확인되면 시험을 끝내지 못하고 결과를 받지 못하며 다른 LF 시험도 볼 수 없고 가진 자격도 회수될 수 있습니다(4.4절). 3.4절은 LF가 재량으로 모든 자격을 취소하고 영구히 응시를 막을 수 있다고 적습니다. 핸드북의 채점 안내는 "Data Forensics"라는 통계 분석으로 부정행위와 문제 유출을 감시한다고 밝힙니다.

실기 시험이라는 점도 덤프의 쓸모를 줄입니다. 채점은 클러스터의 최종 상태를 보고 과제는 지정된 노드에서 직접 고쳐야 합니다. 이 시리즈가 영역별로 "직접 해 보기"를 붙인 이유도 같습니다.

자료를 고를 때 걸러 낸 신호는 다음과 같습니다.

- 제목이나 설명에 "실제 시험 문제", "기출", "real exam questions", "exact questions"가 들어간 강의, 영상, 문서
- 응시자가 기억해 낸 문항을 모았다고 밝히는 글
- 문제 출처를 밝히지 않으면서 "실제 시험과 거의 같다"고 홍보하는 자료

후기를 고를 때도 같은 기준을 썼습니다. 읽은 후기 중 상당수가 이런 영상이나 강의를 썼다고 적었거나 기억한 문항을 옮겨 적어서 이 글과 표에서 뺐습니다.

## 9. 범위와 한계

- 공식 규칙, 가격, 할인, 프로그래머스 가격은 2026년 10월 20일과 21일에 확인했습니다. 가격과 할인은 자주 바뀝니다. 2025년 Cyber Week 할인은 LF 공식 공지를 찾지 못해 제3자 기사 세 곳이 일치하는 범위만 적었습니다.
- `etcdutl`과 `crictl`이 과제 호스트에 있는지, ExamUI에 문항 표시(flag) 기능이 있는지는 확인하지 못했습니다.
- metrics-server와 VPA가 시험 클러스터에 미리 설치되어 있는지는 확인하지 못했습니다.
- 개정 후 etcd 백업·복구와 kubeadm 업그레이드가 실제로 출제되는지는 후기가 갈려 확인하지 못했습니다.
- 후기는 개정 뒤 응시했고 덤프나 "실제 시험 문제" 자료를 썼다는 언급이 없는 것만 골랐습니다. Reddit과 일부 Medium 글은 접속이 막혀 읽지 못했습니다.
- 이 글은 응시 전에 쓴 정리입니다.

## 참고 자료

공식 문서
- Linux Foundation, [Certified Kubernetes Administrator (CKA)](https://training.linuxfoundation.org/certification/certified-kubernetes-administrator-cka/)
- Linux Foundation, [Frequently Asked Questions: CKA and CKAD & CKS](https://docs.linuxfoundation.org/tc-docs/certification/faq-cka-ckad-cks), [Important Instructions: CKA and CKAD](https://docs.linuxfoundation.org/tc-docs/certification/tips-cka-and-ckad), [Resources Allowed](https://docs.linuxfoundation.org/tc-docs/certification/certification-resources-allowed), [Exam Terms of Service](https://docs.linuxfoundation.org/tc-docs/certification/exam-terms-of-service)
- Wayback Machine, Important Instructions [2025-02-11 판](https://web.archive.org/web/20250211081937/https://docs.linuxfoundation.org/tc-docs/certification/tips-cka-and-ckad), [2025-03-28 판](https://web.archive.org/web/20250328093613/https://docs.linuxfoundation.org/tc-docs/certification/tips-cka-and-ckad)
- Linux Foundation 핸드북, [Candidate Requirements](https://docs.linuxfoundation.org/tc-docs/certification/lf-handbook2/candidate-requirements), [Exam Preparation Checklist](https://docs.linuxfoundation.org/tc-docs/certification/lf-handbook2/exam-preparation-checklist), [Scheduling or Rescheduling an Exam](https://docs.linuxfoundation.org/tc-docs/certification/lf-handbook2/scheduling-or-rescheduling-an-exam), [Taking the Exam](https://docs.linuxfoundation.org/tc-docs/certification/lf-handbook2/taking-the-exam), [Candidate Identification and Authentication](https://docs.linuxfoundation.org/tc-docs/certification/lf-handbook2/candidate-identification-and-authentication), [Exam Refund Policy](https://docs.linuxfoundation.org/tc-docs/certification/lf-handbook2/exam-refund-policy), [Repurchasing the Exam](https://docs.linuxfoundation.org/tc-docs/certification/lf-handbook2/repurchasing-the-exam), [Exam Scoring and Notification](https://docs.linuxfoundation.org/tc-docs/certification/lf-handbook2/exam-scoring-and-notification), [ExamUI: Performance Based Exams](https://docs.linuxfoundation.org/tc-docs/certification/lf-handbook2/exam-user-interface/examui-performance-based-exams), [PSI Remote Testing Tutorial](https://docs.linuxfoundation.org/tc-docs/certification/lf-handbook2/psi-remote-testing-tutorial-test-the-secure-browser-+-add-appointment-to-your-online-calendar), [Exam Rules and Policies](https://docs.linuxfoundation.org/tc-docs/certification/lf-handbook2/exam-rules-and-policies)
- Linux Foundation, [Expanding CARE: Passing CKS Can Now Extend Your CKA Certification](https://training.linuxfoundation.org/blog/expanding-care-passing-cks-can-now-extend-your-cka-certification/), 2026-06-18
- Linux Foundation, [LF Global Certification & Confidentiality Agreement](https://docs.linuxfoundation.org/tc-docs/certification/lf-cert-agreement), [Zero Tolerance for Linux Foundation Exam Misconduct](https://training.linuxfoundation.org/blog/zero-tolerance-for-linux-foundation-exam-misconduct/)
- [killer.sh CKA](https://killer.sh/cka), [killer.sh FAQ](https://killer.sh/faq), [Killercoda CKA](https://killercoda.com/cka)

할인
- Linux Foundation, [Cyber Monday Savings Are Here!](https://training.linuxfoundation.org/blog/cyber-monday-savings-are-here-2/), 2024-12-02
- Linux Foundation, [Hurry! Grab 35% Savings Before Cert Prices Increase](https://training.linuxfoundation.org/blog/hurry-grab-35-savings-before-cert-prices-increase/), 2025-01-24
- It's FOSS, [Upgrade Your DevOps Skills Cheap: Linux Foundation Cyber Week Brings 65% Off Certifications](https://itsfoss.com/news/linux-foundation-cyber-sale-2025/), 2025-12-01
- techbeatly, [Explore the Cyber Monday Deals and Grab the Best IT and DevOps Offers](https://techbeatly.com/cyber-week/)
- DevOpsCube 뉴스레터, [Linux Foundation Cyber Monday](https://newsletter.devopscube.com/p/linux-foundation-cyber-monday), 2025-11-30
- 프로그래머스, [CKA 시험 (Certified Kubernetes Administrator)](https://lf.programmers.co.kr/cka), 2026-10-20 확인

연습 자료와 홈 랩
- KodeKloud, [Certified Kubernetes Administrator (CKA)](https://kodekloud.com/courses/cka-certification-course-certified-kubernetes-administrator), [Demo Setting Up Virtual Machines on Mac](https://notes.kodekloud.com/docs/Kubernetes-for-the-Absolute-Beginners-Hands-on-Tutorial/Appendix/Demo-Setting-Up-Virtual-Machines-on-Mac/page), [kodekloudhub/certified-kubernetes-administrator-course](https://github.com/kodekloudhub/certified-kubernetes-administrator-course)
- GitHub, [theplatformlab/CKA-Certified-Kubernetes-Administrator](https://github.com/theplatformlab/CKA-Certified-Kubernetes-Administrator), [techiescamp/cka-certification-guide](https://github.com/techiescamp/cka-certification-guide), [walidshaari/Kubernetes-Certified-Administrator](https://github.com/walidshaari/Kubernetes-Certified-Administrator), [alijahnas/CKA-practice-exercises](https://github.com/alijahnas/CKA-practice-exercises), [chadmcrowell/CKA-Exercises](https://github.com/chadmcrowell/CKA-Exercises), [sailor-sh/CK-X](https://github.com/sailor-sh/CK-X), [kelseyhightower/kubernetes-the-hard-way](https://github.com/kelseyhightower/kubernetes-the-hard-way)
- computingforgeeks, [Best Kubernetes Certification Books](https://computingforgeeks.com/best-kubernetes-certification-books/), 2026-10-04 갱신
- kind, [Quick Start](https://kind.sigs.k8s.io/docs/user/quick-start/), [Configuration](https://kind.sigs.k8s.io/docs/user/configuration/)
- minikube, [Using Multi-Node Clusters](https://minikube.sigs.k8s.io/docs/tutorials/multi_node/)
- Kubernetes, [Installing kubeadm](https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/install-kubeadm/), [Creating a cluster with kubeadm](https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/create-cluster-kubeadm/), [kubectl Quick Reference](https://kubernetes.io/docs/reference/kubectl/quick-reference/), [kubectl explain](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_explain/)
- Linux Foundation 포럼, [LFS258 Lab 3.1 - Something overwriting edits to /etc/hosts file](https://forum.linuxfoundation.org/discussion/comment/37706/)

버전 변경 근거
- Kubernetes, [Feature Gates](https://kubernetes.io/docs/reference/command-line-tools-reference/feature-gates/), [Sidecar Containers](https://kubernetes.io/docs/concepts/workloads/pods/sidecar-containers/), [Resize CPU and Memory Resources assigned to Containers](https://kubernetes.io/docs/tasks/configure-pod-container/resize-container-resources/), [Horizontal Pod Autoscaling](https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/), [Virtual IPs and Service Proxies](https://kubernetes.io/docs/reference/networking/virtual-ips/), [About cgroup v2](https://kubernetes.io/docs/concepts/architecture/cgroups/), [Container Runtimes](https://kubernetes.io/docs/setup/production-environment/container-runtimes/), [EndpointSlices](https://kubernetes.io/docs/concepts/services-networking/endpoint-slices/), [Persistent Volumes](https://kubernetes.io/docs/concepts/storage/persistent-volumes/)
- kubernetes/kubernetes, [CHANGELOG-1.34](https://github.com/kubernetes/kubernetes/blob/master/CHANGELOG/CHANGELOG-1.34.md), [release-1.37 kubeadm constants.go](https://github.com/kubernetes/kubernetes/blob/release-1.37/cmd/kubeadm/app/constants/constants.go), [release-1.36 kubeadm constants.go](https://github.com/kubernetes/kubernetes/blob/release-1.36/cmd/kubeadm/app/constants/constants.go)
- Kubernetes Blog, [Kubernetes v1.35: Timbernetes](https://kubernetes.io/blog/2025/12/17/kubernetes-v1-35-release/), [Kubernetes v1.37: Garhwal](https://kubernetes.io/blog/2026/08/26/kubernetes-v1-37-release/), [Deprecation and removal of Service ExternalIPs](https://kubernetes.io/blog/2026/05/14/kubernetes-v1-36-deprecation-and-removal-of-service-externalips/)
- etcd, [CHANGELOG-3.6](https://github.com/etcd-io/etcd/blob/main/CHANGELOG/CHANGELOG-3.6.md)
- Helm, [Helm 4 Overview](https://helm.sh/docs/overview/)
- Kubernetes Blog, [Ingress NGINX Retirement: What You Need to Know](https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/), 2025-11-11

후기와 커뮤니티
- Matt Bargenquast, [CKS and beta CKA 2025](https://bargenqua.st/posts/cks-cka-2025/), 2025
- Nattapol, [I passed the CKA (February 2025 Changes)](https://nattapol.com/i-passed-the-cka-february-2025-changes/), 2025
- Talha Juikar, [Passing the CKA Exam](https://talhajuikar.com/posts/passing-cka-exam/), 2026
- Domenic Cassisi, [I passed the CKA! My Exam Experience (2026)](https://dcassisi.com/2026/06/09/i-passed-the-cka-my-exam-experience-2026/), 2026
- Atsushi Suzuki, [CKA (Certified Kubernetes Administrator) Exam Report 2026: Don't Rely on Old Guides](https://dev.to/suzuki0430/cka-certified-kubernetes-administrator-exam-report-2026-dont-rely-on-old-guides-mastering-the-534m), 2026
- 109x79m, [【2025年2月改訂版】CKA受験体験記](https://qiita.com/109x79m/items/c7057af1d073c43b6575), 2026
- yu-min, [業務未経験から半年でKubestronaut達成（KCNA/KCSA/CKA/CKAD/CKS全冠）勉強法まとめ](https://zenn.dev/yuu7751/articles/24f509769b97b5), 2025
- cnative_tkb, [CKA-JP 更新試験 受験記 — 2026年版](https://zenn.dev/cnative_tkb/articles/2d1447e98a7aed), 2026
- yltw, [How I Passed the CKA in 2026](https://dev.to/yltw27/how-i-passed-the-cka-in-2026-143c), 2026
- KodeKloud 커뮤니티, [CKA real exam 2026 vs Mock ultimate mock and killer sh](https://kodekloud.com/community/t/cka-real-exam-2026-vs-mock-ultimate-mock-and-killer-sh/501584), 2026-08
- KodeKloud 커뮤니티, [Am I ready for the CKA? (KodeKloud Mocks vs. Killer.sh Difficulty)](https://kodekloud.com/community/t/am-i-ready-for-the-cka-kodekloud-mocks-vs-killer-sh-difficulty/496955), 2026-03
- KodeKloud 커뮤니티, [CKA 2025 Exam Syllabus - Tips and feedback request](https://kodekloud.com/community/t/cka-2025-exam-syllabus-tips-and-feedback-request/474245), 2025-02 ~ 2025-03

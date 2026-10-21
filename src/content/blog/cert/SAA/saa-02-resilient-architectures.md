---
title: '[SAA Ch-02] 영역 2 복원력 있는 아키텍처 설계: 구성 요소 사이에 큐를 두고 한 곳의 장애를 견디는 설계'
description: SAA-C03 영역 2(채점 비중 26%)를 공식 시험 안내서의 과제 2.1과 2.2, 지식·기술 항목 순서대로 정리합니다. SQS·SNS·EventBridge·Step Functions로 결합을 끊는 방법, API Gateway와 Lambda·컨테이너의 한도, Auto Scaling과 캐싱, Route 53 라우팅과 상태 확인, 재해 복구 네 가지 전략과 RPO·RTO, RDS·Aurora·DynamoDB·S3의 장애 조치와 복제를 공식 문서와 DR 백서 기준으로 확인했습니다.
date: 2026-10-19T00:00:00.000Z
tags:
  - AWS
  - SAA
  - Certification
  - Resilience
  - Disaster Recovery
  - SQS
  - Route 53
category: cert/SAA
topics:
  - cert
draft: false
series: "SAA 공부"
seriesOrder: 2
---

## 결론부터

1. 영역 2는 과제 두 개입니다. 2.1은 부하가 늘어도 버티도록 구성 요소를 나누고 늘리는 설계(큐, 이벤트, 서버리스, 컨테이너, Auto Scaling, 캐시), 2.2는 한 AZ나 한 리전이 멈춰도 서비스가 이어지는 설계(Multi-AZ, Route 53, DR 전략, DB 장애 조치, 복제)입니다.
2. "느슨한 결합"이 나오면 먼저 SQS를 떠올립니다. 순서와 중복 제거가 필요하면 FIFO 큐, 한 이벤트를 여러 곳에 동시에 보내야 하면 SNS 팬아웃, 규칙으로 여러 대상에 라우팅하면 EventBridge, 여러 단계를 순서와 재시도로 묶으면 Step Functions입니다.
3. 재해 복구는 백업과 복원, 파일럿 라이트, 웜 스탠바이, 다중 사이트 액티브/액티브 네 가지이고 오른쪽으로 갈수록 RPO와 RTO가 짧아지고 비용과 복잡도가 커집니다. 파일럿 라이트와 웜 스탠바이의 차이는 DR 리전이 지금 바로 요청을 처리할 수 있는지입니다. DR 백서는 이 둘을 가르는 기준을 그렇게 적습니다.
4. DB 장애 조치 시간은 서비스마다 다릅니다. RDS Multi-AZ DB 인스턴스는 보통 60~120초이고 대기 인스턴스는 읽기를 처리하지 않습니다. Aurora는 복제본이 있으면 보통 60초 안, 자주 30초 안에 복구됩니다. Aurora Global Database는 리전 간 복제 지연이 보통 1초 미만이고 2026년 10월 사용자 가이드 기준 보조 리전을 최대 10개 둡니다(2021년판 DR 백서는 5개).
5. DR 백서는 장애 조치에 데이터 플레인 작업만 쓰라고 권합니다. Route 53 상태 확인 기반 장애 조치와 ARC 라우팅 제어는 데이터 플레인이고 가중치 변경이나 Auto Scaling 확장은 컨트롤 플레인입니다. 그래서 DR 리전의 서비스 할당량을 미리 올려 두라는 문장이 안내서의 "대기 환경의 서비스 할당량" 항목과 이어집니다.

---

## 1. 공식 안내서의 목차

| 과제 | 안내서의 지식 항목(요약) | 안내서의 기술 항목(요약) | 이 글 |
|---|---|---|---|
| 2.1 확장 가능하고 느슨하게 결합된 아키텍처 | API Gateway, 관리형 서비스(Transfer Family, SQS, Secrets Manager), 캐싱, 마이크로서비스(상태 저장과 비저장), 이벤트 기반, 수평·수직 확장, 엣지 가속(CDN), 컨테이너 전환, 로드 밸런싱, 다계층, 큐와 발행/구독, 서버리스(Fargate, Lambda), 스토리지 유형(객체, 파일, 블록), 컨테이너 오케스트레이션(ECS, EKS), 읽기 복제본, 워크플로 오케스트레이션(Step Functions) | 이벤트 기반·마이크로서비스·다계층 설계, 확장 전략, 느슨한 결합에 필요한 서비스, 컨테이너와 서버리스를 쓸 시점, 컴퓨팅·스토리지·네트워크·DB 선택, 목적별 서비스 | 2절 |
| 2.2 고가용성과 내결함성 | 글로벌 인프라(AZ, 리전, Route 53), AWS 관리형 서비스(Comprehend, Polly 예시), 라우팅 테이블, DR 전략과 RPO·RTO, 분산 설계 패턴, 장애 조치 전략, 불변 인프라, 로드 밸런싱, 프록시(RDS Proxy), 서비스 할당량과 스로틀링, 스토리지 내구성과 복제, 가시성(X-Ray) | 인프라 무결성 자동화, 리전·AZ 간 HA 서비스, 비즈니스 지표, 단일 장애 지점 제거, 데이터 내구성(백업), DR 전략 선택, 수정할 수 없는 레거시 앱의 신뢰성 향상, 목적별 서비스 | 3절 |

## 2. 과제 2.1 확장 가능하고 느슨하게 결합된 아키텍처

### 2-1. 수평 확장, 수직 확장, 상태 비저장

| 방식 | 하는 일 | 한계 |
|---|---|---|
| 수직 확장 | 인스턴스 유형을 키운다 | 한 인스턴스의 최대 크기에서 멈추고 바꿀 때 재시작이 따른다. 단일 장애 지점이 남는다 |
| 수평 확장 | 같은 인스턴스를 여러 대로 늘린다 | 요청이 어느 인스턴스로 가도 같은 결과가 나와야 한다 |

수평 확장의 전제는 상태 비저장입니다. 쇼핑몰의 장바구니를 웹 서버 메모리에 두면 다음 요청이 다른 인스턴스로 갔을 때 장바구니가 사라집니다. 세션과 장바구니를 ElastiCache나 DynamoDB 같은 외부 저장소로 옮기면 인스턴스를 자유롭게 늘리고 줄일 수 있습니다. 안내서가 마이크로서비스 설계 원칙의 예로 "상태 저장과 상태 비저장 워크로드 비교"를 든 이유가 여기 있다고 읽었습니다.

### 2-2. 다계층 아키텍처와 로드 밸런싱

웹 계층(ALB), 애플리케이션 계층(Auto Scaling 그룹이나 컨테이너), 데이터 계층(RDS, DynamoDB)을 나누고 각 계층을 AZ 두 개 이상에 걸칩니다. 계층마다 따로 늘릴 수 있고 한 계층의 장애가 다른 계층으로 번지는 범위가 줄어듭니다. 로드 밸런서 종류(ALB, NLB, GWLB)의 차이는 Ch-00의 4-2절 표에 정리해 두었습니다.

로드 밸런서 설정 중 시험에 자주 걸리는 세 가지를 ELB 사용자 가이드와 ALB 대상 그룹 속성 문서(2026년 10월 20일 확인)로 정리했습니다.

| 설정 | 문서 내용 | 시험 문구 |
|---|---|---|
| 교차 영역 로드 밸런싱 | 켜면 각 노드가 모든 AZ의 대상에 나눠 보낸다. ALB는 로드 밸런서 수준에서 항상 켜져 있고 대상 그룹 수준에서만 끌 수 있다. NLB와 GWLB는 기본으로 꺼져 있고 언제든 켤 수 있다 | "AZ마다 인스턴스 수가 달라 일부 인스턴스에만 부하가 몰림" |
| 고정 세션(sticky session) | 대상 그룹 단위. 로드 밸런서가 만드는 `AWSALB` 쿠키(기간 1초~7일)나 애플리케이션 쿠키 기반. 교차 영역을 끈 대상 그룹에서는 쓸 수 없다 | "세션을 서버 메모리에 두는 레거시 앱이 로그인이 풀림" |
| 등록 취소 지연(deregistration delay) | 기본 300초 동안 진행 중 요청을 마치게 기다린 뒤 대상을 뺀다 | "축소할 때 처리 중이던 요청이 끊김" |

예제로 보면 AZ A에 대상 2개, AZ B에 8개가 있고 교차 영역이 꺼져 있으면 A의 대상은 각각 25%, B의 대상은 각각 6.25%를 받는다고 문서가 설명합니다. 켜면 10개가 10%씩 받습니다. 고정 세션은 상태를 서버에 두는 앱을 수정 없이 살리는 방법이지만 부하가 고르게 퍼지지 않으니 2-1절처럼 세션을 외부 저장소로 옮기는 것이 근본 해결입니다.

### 2-3. 큐: SQS

SQS 큐 유형 문서의 비교를 옮겼습니다.

| 항목 | 표준 큐 | FIFO 큐 |
|---|---|---|
| 처리량 | 작업(API)당 초당 호출 수가 거의 무제한 | 배치 없이 API 작업당 초당 300건. 배치(10개)로 초당 3,000메시지. 높은 처리량 모드를 켜면 리전에 따라 더 높다 |
| 전달 | 최소 한 번. 중복이 생길 수 있어 멱등 처리가 필요 | 정확히 한 번 처리. `MessageDeduplicationId`나 내용 기반 중복 제거 |
| 순서 | 최선 노력. 순서 보장 없음 | 메시지 그룹 안에서 보낸 순서대로 |
| 예시 | 업로드 후 썸네일 생성 같은 백그라운드 작업 분리 | 가격 변경을 순서대로 반영, 계정 등록 뒤 수강 신청 |

높은 처리량 모드의 한도는 리전마다 다릅니다. 메시지 할당량 문서(2026년 10월 20일 확인)의 배치 없는 호출 기준은 다음과 같고 배치(10개)를 쓰면 메시지 수로 열 배입니다.

| 리전 | 초당 API 호출(배치 없음) |
|---|---|
| 미국 동부(버지니아 북부), 미국 서부(오리건), 유럽(아일랜드) | 70,000 |
| 미국 동부(오하이오), 유럽(프랑크푸르트) | 19,000 |
| 아시아 태평양(뭄바이, 싱가포르, 시드니, 도쿄), 유럽(스페인) | 9,000 |
| 유럽(런던), 남아메리카(상파울루) | 4,500 |
| 그 밖의 리전 | 2,400 |

서울 리전은 이름이 따로 나오지 않아 "그 밖의 리전"인 초당 2,400건(배치로 24,000메시지)에 해당합니다. 더 필요하면 Service Quotas로 증가를 요청합니다.

| 메시지 할당량 | 값 |
|---|---|
| 메시지 크기 | 1바이트 ~ 1,048,576바이트(1MiB). 더 크면 Extended Client Library로 S3에 본문을 두고 참조만 보낸다(최대 2GB) |
| 보존 기간 | 기본 4일, 최소 60초, 최대 14일 |
| 표시 제한 시간(visibility timeout) | 기본 30초, 최소 0초, 최대 12시간 |
| 전달 지연 | 기본 0초, 최대 15분 |
| 배치 | 요청당 최대 10개 |

메시지 최대 크기는 예전 자료에 256KB로 적힌 곳이 많습니다. 2026년 10월 문서는 1MiB이니 문항이 옛 숫자를 전제로 할 수도 있다는 점만 기억해 두었습니다.

표시 제한 시간은 소비자가 메시지를 받은 뒤 다른 소비자에게 보이지 않는 시간입니다. 처리 시간보다 짧으면 같은 메시지가 두 번 처리됩니다. "주문이 가끔 두 번 처리된다"는 시나리오에서는 표시 제한 시간을 처리 시간보다 길게 늘리거나 처리를 멱등하게 만드는 보기가 답입니다. 일정 횟수 실패한 메시지는 배달 못한 편지 큐(DLQ)로 옮겨 따로 살펴봅니다. 롱 폴링(`WaitTimeSeconds`)은 빈 응답을 줄여 API 호출을 아낍니다.

### 2-4. 발행/구독: SNS와 팬아웃

SNS는 발행자가 토픽에 보낸 메시지를 모든 구독자에게 밀어 넣습니다. SQS 큐를 구독자로 붙이는 팬아웃은 Ch-00에서 정리했습니다. 한 이벤트를 여러 소비자가 각자 속도로 처리해야 할 때 씁니다.

기본으로 구독자는 토픽의 모든 메시지를 받습니다. 구독에 필터 정책을 붙이면 메시지 속성이나 본문(JSON)의 조건에 맞는 메시지만 받습니다. 결제 서비스가 `결제완료` 이벤트를 한 토픽에 발행하고 정산 큐는 모든 메시지를, 고액 결제 검토 큐는 금액 속성이 기준 이상인 메시지만 받게 하는 식입니다.

### 2-5. 이벤트 기반: EventBridge

EventBridge 문서는 이벤트를 처리하는 방식을 이벤트 버스와 파이프 두 가지로 나누고 여기에 스케줄러를 따로 둡니다.

| 기능 | 하는 일 |
|---|---|
| 이벤트 버스 | AWS 서비스, SaaS, 자체 애플리케이션에서 온 이벤트를 규칙으로 걸러 0개 이상의 대상으로 보낸다. 다대다 라우팅 |
| 파이프 | 하나의 원본에서 하나의 대상으로 가는 점대점 통합. 변환과 보강 지원 |
| 스케줄러 | cron, rate 표현식이나 일회성 일정으로 작업을 호출 |

2026년 10월 문서에는 이벤트를 정한 기간 보존하고 순서 전달과 재생을 지원하는 새 Custom Event Bus와 기존 규칙 기반 버스(Custom Event Bus - Classic)가 함께 나옵니다. 문서는 새 애플리케이션이면 새 Custom Event Bus로 시작하라고 권하고 Classic도 계속 쓸 수 있다고 적습니다. 시험 문항은 규칙과 대상 중심의 기존 모델을 전제로 할 가능성이 높다고 보고 있습니다.

SNS와 EventBridge가 함께 보기에 나오면 이벤트 내용으로 세밀하게 걸러 여러 AWS 서비스나 SaaS로 보내는 쪽이 EventBridge, 대량 구독자에게 단순히 밀어 넣는 쪽이 SNS로 구분했습니다. 이 구분은 두 서비스 문서를 나란히 놓고 정리한 것이고 AWS가 이렇게 비교한 문서를 이번에 찾지는 못했습니다.

### 2-6. 워크플로 오케스트레이션: Step Functions

| 항목 | 표준 워크플로 | 익스프레스 워크플로 |
|---|---|---|
| 최대 실행 시간 | 1년 | 5분 |
| 실행 보장 | 정확히 한 번 | 비동기는 최소 한 번, 동기는 최대 한 번 |
| 적합한 작업 | 멱등하지 않은 작업(결제 처리, EMR 클러스터 시작) | 멱등한 대량 이벤트 처리(스트리밍 변환, 모바일 백엔드) |
| 실행 기록 | 완료 후 90일까지 API로 조회 | Step Functions가 기록하지 않음. CloudWatch Logs를 켜야 한다 |
| 요금 기준 | 상태 전환 수 | 실행 수, 실행 시간, 메모리 |
| `.sync`, 콜백 패턴 | 지원 | 미지원 |

워크플로 유형은 만든 뒤 바꿀 수 없습니다. 쇼핑몰의 주문 흐름(재고 확인, 결제, 배송 요청, 실패 시 보상 처리)은 결제가 들어 있어 정확히 한 번이 필요하므로 표준 워크플로입니다. 여러 Lambda를 직접 서로 호출하게 엮는 보기보다 Step Functions로 단계와 재시도를 정의하는 보기가 운영 부담이 적은 답이 됩니다.

### 2-7. API 생성과 관리: API Gateway

| 항목 | REST API | HTTP API |
|---|---|---|
| 엔드포인트 | 엣지 최적화, 리전, 프라이빗 | 리전 |
| WAF 연결 | 가능 | 불가 |
| API 키, 사용량 계획, 클라이언트별 제한 | 가능 | 불가 |
| 캐싱 | 가능 | 불가 |
| 요청 검증 | 가능 | 불가 |
| 리소스 정책 | 가능 | 불가 |
| JWT 권한 부여자 | Lambda 권한 부여자로 구현 | 기본 지원 |
| X-Ray 추적 | 가능 | 불가 |

API Gateway 문서는 HTTP API를 기능을 줄이고 가격을 낮춘 제품으로 설명하고 API 키, 클라이언트별 제한, 요청 검증, WAF, 프라이빗 엔드포인트가 필요하면 REST API를 고르라고 적습니다.

| 할당량(2026년 10월) | 값 |
|---|---|
| 계정·리전당 스로틀 | 초당 10,000요청(증가 요청 가능), 버스트 버킷 5,000요청(고객이 따로 바꿀 수 없고 AWS가 RPS 한도에 맞춰 정함). 일부 신규 리전은 2,500과 1,250 |
| REST API 통합 제한 시간 | 50밀리초 ~ 29초. 리전·프라이빗 API는 29초보다 늘릴 수 있지만 리전 스로틀 한도가 줄 수 있다. 엣지 최적화는 늘릴 수 없다 |
| 페이로드 | 10MB |
| 캐시 TTL | 기본 300초, 0~3,600초 |

Lambda 문서에는 API Gateway의 기본 스로틀(초당 10,000)과 Lambda의 기본 동시성(1,000)이 맞지 않아 API Gateway가 받은 요청을 Lambda가 다 처리하지 못할 수 있다는 예시가 있습니다. 안내서 2.2의 "서비스 할당량과 스로틀링" 항목과 이어지는 내용입니다.

### 2-8. 서버리스: Lambda와 Fargate

| Lambda 할당량(2026년 10월) | 값 |
|---|---|
| 동시 실행 | 계정·리전당 기본 1,000(수만까지 늘릴 수 있음). 신규 계정은 더 낮게 시작 |
| 메모리 | 128MB ~ 10,240MB. 1,769MB에서 vCPU 1개 상당 |
| 제한 시간 | 900초(15분) |
| `/tmp` | 512MB ~ 10,240MB |
| 호출 페이로드 | 동기 요청·응답 각 6MB, 비동기 1MB |
| 배포 패키지 | zip 업로드 50MB, 압축 해제 250MB. 컨테이너 이미지 10GB |

2026년 10월 할당량 문서에는 Lambda Managed Instances라는 실행 방식이 있고 이 방식의 비동기 호출과 일부 이벤트 소스 매핑은 최대 90분까지 돈다고 적혀 있습니다. 시험 안내서보다 나중에 생긴 것이라 문항은 "Lambda 최대 15분"을 전제로 한다고 보는 편이 안전합니다.

15분을 넘는 작업, 계속 떠 있어야 하는 프로세스, 큰 로컬 상태가 필요한 작업은 Lambda 대신 Fargate나 EC2가 맞습니다. Fargate는 ECS 문서에서 서버 관리, 용량 계획, 워크로드 격리를 직접 하지 않는 서버리스 사용량 기반 컴퓨팅 엔진으로 설명됩니다.

### 2-9. 컨테이너: ECS, EKS, Fargate

| 선택 | 언제 |
|---|---|
| ECS + Fargate | AWS 방식의 오케스트레이션, 서버 관리 없음 |
| ECS + EC2 | GPU, 특정 인스턴스 유형, 호스트 수준 제어가 필요할 때 |
| ECS Managed Instances | EC2 인스턴스 유형을 고르되 프로비저닝, 패치, 확장은 AWS에 맡길 때(2026년 10월 문서) |
| EKS | 이미 쿠버네티스를 쓰거나 쿠버네티스 API와 생태계가 필요할 때 |

"컨테이너로 옮기는 방법"이라는 안내서 항목은 기존 애플리케이션을 컨테이너 이미지로 만들어 ECR에 올리고 ECS 서비스로 띄우는 흐름으로 이해했습니다. ECS 문서는 서비스를 "오래 실행되는 상태 비저장 애플리케이션", 태스크를 "작업을 하고 끝나는 애플리케이션"으로 구분합니다. EKS 문서는 쿠버네티스 컨트롤 플레인을 AWS가 관리한다고 적고 노드 관리까지 맡기는 EKS Auto Mode, 온프레미스에서 쓰는 EKS Anywhere와 Hybrid Nodes를 함께 소개합니다.

### 2-10. Auto Scaling

| 정책 | 동작 |
|---|---|
| 대상 추적 | CloudWatch 지표와 목표값을 정하면 그 값에 맞게 용량을 조정한다. 온도 조절기에 비유한다 |
| 단계 조정 | 경보 위반 크기에 따라 단계별로 다르게 조정한다 |
| 단순 조정 | 한 번 조정하고 휴지 기간(cooldown)을 기다린다 |

문서는 대상 추적을 강하게 권하고 용량에 반비례하는 지표(평균 CPU 사용률, 대상당 요청 수)를 고르라고 합니다. 용량을 두 배로 늘리면 지표가 절반으로 줄어드는 지표여야 비례 조정이 맞게 일어난다는 이유입니다. 정책이 여러 개 동시에 발동하면 가장 큰 용량을 주는 정책을 따릅니다.

SQS 소비자를 늘릴 때는 큐 길이 대신 인스턴스당 처리할 메시지 수(backlog per instance)를 지표로 쓰는 문서가 따로 있습니다(이번에는 목차에서 제목만 확인). 예약 조정은 정한 시각에 원하는 용량과 최소·최대를 바꾸는 예약 작업이고 한 번만 실행하거나 cron으로 반복할 수 있으며 동적 조정 정책과 함께 쓸 수 있습니다. 예측 조정은 과거 부하에서 일 단위·주 단위 패턴을 찾아 예상 부하보다 먼저 용량을 늘리고 문서는 업무 시간 주기 트래픽, 반복 배치, 초기화가 오래 걸리는 앱에 맞다고 적습니다.

조정 정책 말고도 인스턴스가 들어오고 나가는 순간을 다루는 기능 두 가지가 문제에 나옵니다. EC2 Auto Scaling 사용자 가이드(2026년 10월 20일 확인) 기준입니다.

| 기능 | 하는 일 | 값과 제약 |
|---|---|---|
| 수명 주기 후크(lifecycle hook) | 시작 중이거나 종료 중인 인스턴스를 대기 상태로 잡아 두고 사용자 작업(소프트웨어 설치, 로그 내려받기)을 마친 뒤 다음 상태로 보낸다 | 기본 하트비트 제한 시간 1시간. 대기 최대는 48시간과 하트비트의 100배 중 작은 값. 종료 후크는 기본으로 최선 노력(best effort)이고 인스턴스 수명 주기 정책의 보존 설정과 함께 쓸 수 있다. Spot 회수는 막지 못한다 |
| 웜 풀(warm pool) | 부팅이 아주 오래 걸리는 앱을 위해 미리 초기화한 인스턴스를 그룹 옆에 두었다가 확장할 때 꺼내 쓴다 | 상태는 Stopped, Hibernated, Running 중 선택. Stopped나 Hibernated면 인스턴스 요금 없이 EBS와 탄력적 IP 요금만 낸다. Running은 권하지 않는다 |

"새 인스턴스가 설정 스크립트를 끝내기 전에 ALB가 트래픽을 보내 오류" 또는 "축소 전에 로그를 S3로 옮겨야 함"은 수명 주기 후크입니다. "부팅에 10분 넘게 걸려 급증에 늦게 대응, 상시 과다 프로비저닝은 싫음"은 웜 풀입니다.

### 2-11. 캐싱 전략

| 위치 | 서비스 | 캐시하는 것 |
|---|---|---|
| 엣지 | CloudFront | 정적·동적 웹 콘텐츠. 기본 TTL 24시간, 최소 0초 |
| API | API Gateway REST API 캐시 | API 응답. 기본 TTL 300초 |
| 애플리케이션과 DB 사이 | ElastiCache(Valkey, Redis OSS, Memcached) | 조회 결과, 세션 |
| DynamoDB 앞 | DAX | DynamoDB API와 호환되는 인메모리 캐시. 최종 일관 읽기를 한 자릿수 밀리초에서 마이크로초로. 강력 일관 읽기나 쓰기 위주 앱에는 맞지 않음 |

ElastiCache 문서의 캐시 채우기 전략입니다.

| 전략 | 동작 | 장점 | 단점 |
|---|---|---|---|
| 지연 로딩(lazy loading) | 캐시에 없으면 DB에서 읽어 캐시에 넣는다 | 요청된 데이터만 캐시. 노드가 죽어도 지연만 늘고 동작한다 | 미스마다 왕복 세 번. 데이터가 낡을 수 있다 |
| 쓰기 통과(write-through) | DB에 쓸 때 캐시도 갱신한다 | 캐시 데이터가 낡지 않는다 | 새 노드에는 데이터가 없다. 읽지 않을 데이터로 캐시가 찬다 |
| TTL 추가 | 키마다 만료 시간을 둔다 | 두 전략의 장점을 함께 가져가고 낡는 정도를 제한 | 만료 직후 DB 조회가 생긴다 |

게시판의 인기글 목록처럼 몇 초 낡아도 되는 데이터는 지연 로딩 + TTL, 상품 가격처럼 쓰자마자 맞아야 하는 데이터는 쓰기 통과가 맞습니다. CloudFront는 S3, ELB, API Gateway 같은 AWS 원본에서 CloudFront로 오는 전송 요금이 없다고 문서가 적습니다.

### 2-12. 읽기 복제본을 쓸 때

RDS 읽기 복제본은 원본 DB의 엔진 기능으로 비동기 복제되는 읽기 전용 인스턴스입니다. 문서가 드는 용도는 읽기 부하 분산, 원본이 백업이나 유지 보수로 I/O를 멈출 때의 읽기, 보고서 쿼리 분리, 다른 리전 DR(승격)입니다.

| 항목 | 내용 |
|---|---|
| 복제 | 비동기. 복제본 데이터는 원본보다 늦을 수 있다 |
| 개수 | 원본 DB 인스턴스당 기본 할당량 15개(RDS 할당량 문서, 2026년 10월 20일 확인). MySQL, MariaDB, PostgreSQL은 2022년 10월 발표로 5개에서 15개가 됐다. Oracle은 15개까지 되지만 복제 지연 때문에 5개 이하를 권한다 |
| 자동 확장 | RDS는 읽기 복제본의 자동 추가·삭제를 지원하지 않는다. 직접 만든다 |
| 요금 | 같은 리전 안 복제 데이터 전송은 무료. 복제본은 일반 DB 인스턴스 요금 |
| 승격 | 독립 DB 인스턴스로 승격 가능. 원본을 지우면 같은 리전 복제본은 독립 인스턴스로 승격된다 |

Aurora는 클러스터당 읽기 전용 Aurora 복제본을 최대 15개 두고 장애 조치 대상으로도 씁니다. Multi-AZ와 읽기 복제본의 차이는 3-7절에서 다룹니다.

### 2-13. 스토리지 유형: 객체, 파일, 블록

| 유형 | 서비스 | 범위 | 특징 |
|---|---|---|---|
| 객체 | S3 | 리전(Standard는 AZ 3개 이상) | HTTP API, 무제한 확장, 내구성 99.999999999% |
| 파일 | EFS | 리전(권장) 또는 One Zone | NFSv4.1/4.0, EC2·ECS·EKS·Lambda·Fargate에서 동시 마운트. Windows 미지원 |
| 블록 | EBS | 하나의 AZ | 같은 AZ의 인스턴스에만 연결. 일부 유형은 Multi-Attach |

EFS 문서는 리전 파일 시스템이 여러 AZ에 데이터를 중복 저장해 하나 이상의 AZ가 멈춰도 접근할 수 있고 One Zone은 AZ 손상 시 데이터를 잃을 수 있다고 적습니다. 여러 AZ의 웹 서버가 같은 업로드 디렉터리를 공유해야 하면 EFS 리전 파일 시스템, 한 인스턴스의 DB 볼륨이면 EBS입니다.

안내서가 관리형 서비스 예시로 든 Transfer Family는 SFTP, FTPS, FTP, AS2, 브라우저 기반 전송으로 S3나 EFS에 파일을 넣고 빼는 서비스입니다. "거래처가 SFTP로 파일을 보내는 방식을 바꾸지 않고 S3로 받기"가 전형적인 시나리오입니다.

### 2-14. 과제 2.1에서 갈리는 조건

| 시나리오의 단어 | 가리키는 답 |
|---|---|
| 요청이 몰릴 때 뒤 단계가 버티지 못함, 비동기 처리 가능 | SQS로 분리 |
| 순서 보장, 중복 없이 | SQS FIFO |
| 한 이벤트를 여러 시스템이 각각 처리 | SNS + SQS 팬아웃 |
| 이벤트 내용별로 다른 대상, SaaS 이벤트 수신, 일정 기반 호출 | EventBridge |
| 여러 단계, 재시도, 사람 승인 대기, 최대 1년 | Step Functions 표준 |
| 대량 이벤트, 5분 안에 끝남, 멱등 | Step Functions 익스프레스 |
| API 키와 사용량 계획, WAF, 캐시 | API Gateway REST API |
| 최저 비용의 단순 프록시 API | API Gateway HTTP API |
| 15분 넘는 작업, 서버 관리 없음 | Fargate |
| 쿠버네티스 매니페스트 그대로 | EKS |
| 세션을 인스턴스 밖에 | ElastiCache나 DynamoDB |
| 앱을 못 고치는데 세션이 서버 메모리에 있음 | ALB 고정 세션(대상 그룹) |
| 새 인스턴스가 준비되기 전 트래픽을 받음, 종료 전 로그 수집 | Auto Scaling 수명 주기 후크 |
| 부팅이 매우 느려 확장이 늦음 | Auto Scaling 웜 풀(Stopped 상태) |
| NLB 뒤 AZ별 대상 수가 달라 부하 불균형 | NLB 교차 영역 로드 밸런싱 켜기 |
| 읽기 부하만 큼, 쓰기는 그대로 | 읽기 복제본이나 캐시 |
| 여러 인스턴스가 공유하는 파일 | EFS |
| SFTP 거래처 연동 | Transfer Family |
| 전 세계 사용자에게 정적 콘텐츠 | CloudFront |

## 3. 과제 2.2 고가용성과 내결함성

### 3-1. 글로벌 인프라와 Multi-AZ로 충분한 경우

DR 백서의 업무 연속성 계획 절은 AWS 리전 안의 AZ가 서로 의미 있는 거리를 두고 위치가 계획되어 흔한 재해는 한 AZ에만 영향을 준다고 설명하고 그래서 리전 안 Multi-AZ 아키텍처가 위험 완화 요구의 상당 부분을 이미 충족할 수 있다고 적습니다. 같은 백서는 물리 데이터센터 하나의 손실이 재해의 정의라면 백업과 복원만으로도 될 수 있고 리전 전체 손실이나 규제 요구까지 고려하면 파일럿 라이트 이상을 검토하라고 합니다.

시험 문제에서 "AZ 하나의 장애에도 서비스 유지"는 Multi-AZ, "리전 장애에도 유지"는 다중 리전 문제로 읽습니다. 리전 문제에 Multi-AZ만 답한 보기, AZ 문제에 다중 리전 액티브/액티브를 답한 보기는 각각 요구 미달과 과잉 비용으로 걸러집니다.

### 3-2. 단일 장애 지점 제거

| 구성 요소 | 단일 장애 지점이 되는 구성 | 고친 구성 |
|---|---|---|
| NAT 게이트웨이 | AZ 하나에 하나만 두고 모든 AZ가 공유 | AZ마다 하나, 같은 AZ의 NAT로 라우팅(또는 리전 NAT 게이트웨이) |
| EC2 웹 서버 | 인스턴스 한 대 | 여러 AZ에 걸친 Auto Scaling 그룹 + ALB |
| RDS | Single-AZ | Multi-AZ |
| 파일 공유 | EBS 하나를 한 인스턴스에서 NFS로 공유 | EFS 리전 파일 시스템 |
| EFS | One Zone | 리전 파일 시스템 |
| Site-to-Site VPN | 고객 게이트웨이 장비 하나 | 장비 이중화, 또는 DX + VPN 백업 |

### 3-3. Route 53 라우팅 정책

| 정책 | 쓰는 자리 |
|---|---|
| 단순(simple) | 한 기능을 하는 리소스 하나 |
| 장애 조치(failover) | 액티브/패시브 장애 조치 |
| 지리 위치(geolocation) | 사용자의 위치로 라우팅(국가별 언어, 콘텐츠 권리) |
| 지리 근접(geoproximity) | 리소스의 위치로 라우팅하고 선택적으로 한 위치에서 다른 위치로 트래픽을 옮긴다 |
| 지연 시간(latency) | 여러 리전 중 지연이 가장 낮은 리전 |
| IP 기반 | 요청이 시작된 IP 주소로 사용자 위치를 정해 라우팅 |
| 다중 값 응답(multivalue answer) | 정상인 레코드를 무작위로 최대 8개 응답 |
| 가중치(weighted) | 정한 비율로 여러 리소스에 분산(카나리 배포, 점진 전환) |

IP 기반을 뺀 나머지는 프라이빗 호스팅 영역에서도 쓸 수 있다고 문서가 적습니다. 다중 값 응답은 로드 밸런서를 대신하지는 못하지만 상태 확인과 함께 쓰면 비정상 IP를 응답에서 뺍니다.

### 3-4. Route 53 상태 확인

| 유형 | 확인하는 것 |
|---|---|
| 엔드포인트 | IP나 도메인 이름으로 지정한 엔드포인트에 인터넷으로 요청(HTTP, HTTPS, TCP). HTTP·HTTPS는 2xx나 3xx를 정상으로 본다 |
| 계산된(calculated) | 다른 상태 확인 최대 256개의 결과를 AND, OR, "y개 중 x개 이상"으로 묶는다 |
| CloudWatch 경보 | 경보가 보는 지표 데이터 스트림. 같은 계정의 경보만, 고해상도 지표와 지표 수학은 미지원 |

| 설정 | 내용 |
|---|---|
| 요청 간격 | 30초(표준) 또는 10초(빠름, 추가 요금). 만든 뒤 바꿀 수 없다 |
| 실패 임계값 | 상태를 바꾸기 전에 연속으로 성공하거나 실패해야 하는 횟수 |
| 문자열 일치 | 응답 본문 첫 5,120바이트 안에 검색 문자열이 있는지(추가 요금) |
| 상태 확인 리전 | 직접 고르면 최소 3개 |

Route 53은 사설·로컬·라우팅 불가 IP 범위의 엔드포인트는 직접 확인할 수 없습니다. VPC 안의 사설 리소스 상태로 장애 조치하려면 그 리소스의 지표에 CloudWatch 경보를 만들고 경보 기반 상태 확인을 씁니다. 실패 임계값은 Route 53 API 참조의 `HealthCheckConfig` 기준 1~10 범위이고 지정하지 않으면 3입니다. 요청 간격도 지정하지 않으면 30초입니다.

### 3-5. Global Accelerator와 CloudFront 원본 장애 조치

| 항목 | Global Accelerator | CloudFront |
|---|---|---|
| 진입점 | 고정 애니캐스트 IPv4 두 개(듀얼 스택은 IPv6 두 개 추가) | 배포 도메인 이름 |
| 대상 | NLB, ALB, EC2, 탄력적 IP(여러 리전 가능) | S3, HTTP 원본 |
| 캐시 | 하지 않는다 | 엣지에서 캐시 |
| 장애 조치 | 상태 확인으로 정상 엔드포인트로 즉시 전환. 트래픽 다이얼로 비율 조정 | 원본 그룹의 원본 장애 조치. 요청 단위로 다음 원본에 보내고 다음 요청은 다시 기본 원본으로 간다 |

DR 백서는 Global Accelerator가 DNS 캐시 문제를 피하고 AWS 엣지 네트워크로 트래픽을 일찍 태워 지연을 줄인다고 설명합니다. "고정 IP가 필요한 거래처 방화벽", "TCP/UDP 게임 서버", "DNS TTL 때문에 장애 조치가 늦음"이 나오면 Global Accelerator, "정적 콘텐츠 캐시"면 CloudFront입니다.

### 3-6. 재해 복구 전략과 RPO, RTO

DR 백서의 정의입니다.

- RTO(복구 시간 목표): 서비스 중단과 복원 사이에 허용할 수 있는 최대 지연. 서비스가 쓸 수 없는 상태로 허용되는 시간입니다.
- RPO(복구 시점 목표): 마지막 데이터 복구 지점 이후 허용할 수 있는 최대 시간. 마지막 복구 지점과 중단 사이에 잃어도 되는 데이터의 양입니다.

| 전략 | DR 리전에 있는 것 | 장애 시 할 일 | RPO / RTO 경향 | 비용 |
|---|---|---|---|---|
| 백업과 복원 | 백업(리전 간 복사)과 IaC 템플릿 | 인프라 배포, 데이터 복원, 코드 배포 | 백업 주기만큼 / 가장 길다 | 가장 낮다 |
| 파일럿 라이트 | 계속 복제되는 데이터(DB, 객체 저장소)와 꺼진 핵심 인프라 | 앱 서버를 켜고 확장한다 | 짧다(연속 복제) / 수십 분 단위로 이해(백서는 숫자를 들지 않음) | 낮다 |
| 웜 스탠바이 | 축소되었지만 완전히 동작하는 프로덕션 복사본 | 확장만 한다 | 짧다 / 파일럿 라이트보다 짧다 | 중간 |
| 다중 사이트 액티브/액티브 | 모든 리전이 트래픽을 처리 | 실패한 리전에서 트래픽을 뺀다 | 거의 0에 가깝게(데이터 손상은 백업 의존) / 거의 0 | 가장 높다 |

백서가 적은 파일럿 라이트와 웜 스탠바이의 구분은 이렇습니다. 둘 다 DR 리전에 주 리전 자산의 복사본이 있지만 파일럿 라이트는 추가 조치 없이는 요청을 처리할 수 없고 웜 스탠바이는 줄어든 용량으로 즉시 트래픽을 처리합니다. 파일럿 라이트는 서버를 켜고 비핵심 인프라를 배포하고 확장해야 하고 웜 스탠바이는 확장만 하면 됩니다.

백서는 같은 용량을 DR 리전에 미리 둔 정적 안정 구성을 핫 스탠바이라고 부르고 액티브/액티브와 함께 묶어 설명합니다. 핫 스탠바이는 트래픽을 한 리전에서만 받는 액티브/패시브입니다.

전략과 함께 기억할 백서의 원칙이 두 가지 있습니다.

| 원칙 | 백서 내용 | 시험에서의 의미 |
|---|---|---|
| 데이터 플레인으로 장애 조치 | 데이터 플레인은 컨트롤 플레인보다 가용성 설계 목표가 높으니 장애 조치에는 데이터 플레인 작업만 쓰라고 한다. Route 53 상태 확인 기반 DNS 장애 조치와 ARC 라우팅 제어는 데이터 플레인, Route 53 가중치 변경과 Global Accelerator 트래픽 다이얼 조정은 컨트롤 플레인 | "가장 신뢰할 수 있는 수동 장애 조치"는 ARC 라우팅 제어 |
| 연속 복제와 시점 백업은 별개 | 연속 복제는 데이터 손상이나 악의적 삭제까지 복제할 수 있어 시점 복구 백업이 함께 필요하다 | "랜섬웨어로 데이터가 암호화됨"의 복구는 복제본보다 시점 백업 |

자동 장애 조치에 대해서도 백서는 조심하라고 적습니다. 거짓 경보로 장애 조치하면 RTO와 RPO만큼의 손실을 그대로 입기 때문에 수동으로 시작하되 단계는 자동화해 버튼 하나로 만드는 방식을 많이 쓴다고 합니다.

### 3-7. DB 장애 조치: RDS Multi-AZ, Aurora, RDS Proxy

| 구성 | 복제 | 대기·복제본의 읽기 | 장애 조치 |
|---|---|---|---|
| RDS Multi-AZ DB 인스턴스 | 다른 AZ의 대기 인스턴스와 동기 | 대기 인스턴스는 읽기를 처리하지 않는다 | 보통 60~120초. 큰 트랜잭션이나 긴 복구는 더 걸린다. DNS 레코드가 대기 인스턴스를 가리키도록 바뀌어 연결을 다시 맺어야 한다 |
| RDS Multi-AZ DB 클러스터(MySQL, PostgreSQL) | 반동기. 서로 다른 AZ 3개에 쓰기 1개와 읽을 수 있는 대기 2개 | 읽기 가능 | RDS Multi-AZ 기능 페이지 기준 보통 35초 미만(2026년 10월 21일 확인) |
| RDS 읽기 복제본 | 비동기 | 읽기 전용 | 자동 장애 조치 없음. 승격은 몇 분이 걸리고 재부팅이 포함된다(DR 백서) |
| Aurora | 클러스터 볼륨이 여러 AZ의 저장 노드 6개에 동기 복제 | Aurora 복제본 최대 15개, 읽기 가능 | 복제본이 있으면 보통 60초 미만, 자주 30초 미만. 복제본이 없으면 같은 AZ에 새 기본 인스턴스를 만들어 보통 10분 미만 |

Multi-AZ 장애 조치가 일어나는 조건으로 문서는 OS 패치, 기본 호스트 비정상, 네트워크 단절, 고객의 인스턴스 수정, 응답 없는 기본 인스턴스, 저장 볼륨 장애, 사용자가 요청한 장애 조치(장애 조치를 포함한 재부팅)를 듭니다. 애플리케이션이 JVM이면 DNS 캐시 TTL을 60초 이하로 두라고 권합니다.

Aurora 복제본에는 0(최우선)부터 15까지 승격 우선순위를 줄 수 있습니다. 같은 우선순위면 크기가 큰 복제본을 먼저 승격합니다. 연결 문자열은 클러스터 엔드포인트를 쓰면 장애 조치 뒤에도 그대로입니다.

RDS Proxy는 DB 연결 풀을 만들어 재사용하고 장애 조치 때 애플리케이션 연결을 유지한 채 새 인스턴스로 라우팅합니다. Aurora 문서는 DNS 캐시를 우회해 Aurora Multi-AZ의 장애 조치 시간을 최대 66% 줄인다고 적습니다. 클라이언트에 IAM 인증을 강제하고 DB 자격 증명은 Secrets Manager나 IAM DB 인증으로 처리합니다. 프록시는 DB와 같은 VPC에 있어야 하고 공개 접근이 불가능합니다. RDS DB 인스턴스의 복제 구성에서는 프록시를 쓰기 인스턴스에만 연결할 수 있습니다. Aurora에서는 기본 프록시 엔드포인트가 쓰기 인스턴스로 가고 읽기 전용 프록시 엔드포인트를 만들면 클러스터의 리더 엔드포인트로 읽기를 나눌 수 있습니다.

"Lambda가 동시에 수백 개 떠서 RDS 연결이 바닥난다"는 RDS Proxy의 대표 시나리오입니다. "앱 코드를 고칠 수 없는데 장애 조치 시간을 줄이고 싶다"도 RDS Proxy가 답이 되는 경우가 많습니다. 안내서 2.2의 프록시 개념 항목이 이것입니다.

### 3-8. Aurora Global Database

| 항목 | 2026년 10월 문서 |
|---|---|
| 구성 | 쓰기를 받는 기본 리전 1개와 읽기 전용 보조 리전 최대 10개 |
| 복제 | 전용 인프라로 저장 계층에서 복제. 지연은 보통 1초 미만 |
| 보조 클러스터 | 읽기 전용 인스턴스 최대 16개(일반 클러스터 15개보다 하나 많음) |
| 스위치오버 | 계획된 리전 이동. 데이터 손실 없음 |
| 장애 조치 | 기본 리전 장애 시 다른 리전으로 |
| 쓰기 전달 | 보조 클러스터가 쓰기 SQL을 기본 클러스터로 전달 |

DR 백서는 보조 리전을 "최대 5개"로 적고 있어 서비스 문서와 다릅니다. 2026년 10월 20일에 Aurora 사용자 가이드의 "Using Amazon Aurora Global Database" 페이지를 다시 열어 "up to 10 secondary DB clusters in different Regions"라는 문장을 확인했고 엔진(MySQL, PostgreSQL)을 가리지 않는 서술입니다. 백서는 2021년판이라 이전 한도로 보고 사용자 가이드의 10개를 따랐습니다. 시험 문항이 숫자 자체를 묻는다면 출제 시점에 따라 5가 정답일 수도 있어서 "리전 여러 개에 읽기 전용 사본, 1초 미만 복제"라는 성격으로 기억해 둡니다. 백서는 보조 리전을 1분 안에 읽기·쓰기로 승격할 수 있다고 적습니다.

### 3-9. DynamoDB 글로벌 테이블

글로벌 테이블은 여러 리전에 복제본을 두고 어느 복제본에서든 읽고 쓰는 다중 액티브 기능입니다. 한 리전에 복제본은 하나이고 모든 복제본이 같은 테이블 이름과 기본 키 스키마를 씁니다.

| 항목 | 다중 리전 최종 일관성(MREC) | 다중 리전 강력 일관성(MRSC) |
|---|---|---|
| 기본값 | 지정하지 않으면 MREC | |
| 충돌 해결 | 마지막 쓰기 우선(last writer wins) | |
| 복제 방식 | DynamoDB Streams를 읽어 다른 복제본에 적용. 복제본의 Streams는 끌 수 없다 | 복제에 Streams를 쓰지 않아 기본으로 꺼져 있다. 필요하면 켤 수 있다 |
| 리전 | | 정확히 리전 3개(복제본 3개, 또는 복제본 2개와 감시 리전 1개). 서울을 포함한 15개 리전에서 지원 |
| RPO | 보통 몇 초 | 0 |
| TTL | 지원 | 미지원 |
| 트랜잭션 | 호출한 리전 안에서만 원자적 | 미지원 |
| 계정 | 같은 계정, 여러 계정 | 같은 계정만 |
| 지표 | `ReplicationLatency` 발행 | 발행하지 않음 |

일관성 모드는 만든 뒤 바꿀 수 없습니다. 글로벌 테이블의 가용성 SLA는 99.999%이고 단일 리전 테이블은 99.99%입니다. MRSC는 쓰기와 강력 일관 읽기에 리전 간 통신이 필요해 MREC보다 지연이 큽니다. 빈 테이블에서만 만들 수 있고 만든 뒤에는 복제본을 더할 수 없습니다(DynamoDB 글로벌 테이블 동작 문서, 2026년 10월 21일 확인).

DR 백서는 쓰기 전략을 셋으로 나눕니다. 모든 쓰기를 한 리전으로 보내는 write global(Aurora Global Database가 맞음), 가까운 리전에 쓰는 write local(DynamoDB 글로벌 테이블이 맞음), 사용자 ID 같은 키로 쓰기 리전을 정하는 write partitioned(양방향 S3 복제 등)입니다.

### 3-10. S3 복제

| 구분 | 내용 |
|---|---|
| 실시간 복제 | 설정 이후 새로 쓰이거나 바뀐 객체를 복제. 그 전에 있던 객체는 복제하지 않는다 |
| 온디맨드 복제 | S3 Batch Replication으로 기존 객체, 실패한 객체, 이미 복제된 객체를 복제 |
| CRR | 다른 리전 버킷으로. 규정 준수 거리, 지연 단축 |
| SRR | 같은 리전 버킷으로. 로그 모으기, 운영·테스트 계정 동기화, 데이터 주권 |
| 버전 관리 | 원본과 대상 모두 켜야 한다 |
| S3 RTC | 새 객체의 99.99%를 15분 안에 복제하도록 설계됐고 SLA는 리전 쌍마다 99.9%를 약속한다. Batch Replication에는 적용되지 않는다 |
| 삭제 마커 | 기본으로 원본에서 객체를 지우면 원본에만 삭제 마커가 생긴다(DR 백서). 복제할지 설정할 수 있다 |
| 양방향 복제 | 복제본 수정 동기화를 켜서 ACL, 태그, 객체 잠금 변경까지 맞춘다 |

S3 복제 문서 안에 99.99%와 99.9%가 함께 나오는 이유는 S3 FAQ가 설명합니다. 99.99%는 설계 목표이고 SLA가 약속하는 값은 리전 쌍마다 99.9%입니다. 두 숫자가 가리키는 대상이 다릅니다.

### 3-11. 백업으로 데이터 내구성 지키기

DR 백서가 시점 복구를 지원한다고 든 서비스는 EBS 스냅샷, DynamoDB 백업, RDS 스냅샷, Aurora 스냅샷, EFS 백업(AWS Backup 사용 시), Redshift 스냅샷, Neptune, DocumentDB, FSx입니다. AWS Backup은 이들을 중앙에서 계획하고 리전 간·계정 간 복사를 합니다. 계정 간 백업은 내부자 위협이나 계정 탈취까지 대비합니다.

AWS Backup 개발자 가이드의 리전 간 복사 페이지(2026년 10월 20일 확인)에서 문제에 쓸 만한 동작을 모았습니다.

| 항목 | 문서 내용 |
|---|---|
| 방법 | 백업 계획의 규칙에 복사 대상 리전과 저장소를 넣어 자동으로, 또는 복구 지점을 골라 수동(온디맨드)으로 |
| 첫 복사 | 전체 복사. 이후 증분을 지원하는 서비스는 같은 리전으로 가는 다음 복사부터 증분 |
| 암호화 | 대상 저장소의 고객 관리형 키로 다시 암호화. EBS는 다른 KMS 키를 쓰는 저장소로 복사하면 전체 복사가 된다 |
| 제약 | 콜드 스토리지 계층의 백업은 리전 간 복사를 지원하지 않는다. RDS는 사용자 지정 옵션 그룹을 함께 복사하지 않아 대상 리전에 같은 옵션 그룹을 미리 만들어야 한다 |

"규정상 백업을 운영 리전과 떨어진 곳에 자동으로 보관"은 백업 계획의 복사 규칙이 답이고 Lambda로 스냅샷을 복사하는 보기는 운영 부담이 큰 쪽입니다.

백서는 백업 복원이 컨트롤 플레인 작업이라서 재해 때 쓸 수 없을 수도 있으니 주기적으로 DR 리전에 미리 복원해 두는 방법을 권합니다. 2021년판 백서는 AWS Backup에 예약 복원이 없어 SDK로 직접 자동화한다고 적었습니다. 지금 AWS Backup에는 정한 주기마다 복원을 실행해 복원 가능 여부와 걸린 시간을 보는 복원 테스트(restore testing) 기능이 있습니다. 다만 테스트로 만든 리소스는 끝나면 지워지므로 DR 리전에 복원본을 계속 두려면 여전히 직접 자동화합니다. 백업은 복원 테스트까지 해야 백업이라는 것이 백서의 주의 사항입니다.

### 3-12. 앱 수정 없이 레거시 애플리케이션의 신뢰성 높이기

안내서는 "애플리케이션을 바꿀 수 없을 때 레거시 앱의 신뢰성을 높이는 AWS 서비스"를 기술 항목에 넣었습니다. 이번에 확인한 문서에서 이 조건에 맞는 것을 모았습니다.

| 서비스 | 앱 수정 없이 얻는 것 |
|---|---|
| AWS Elastic Disaster Recovery | 온프레미스나 다른 클라우드, EC2의 서버를 블록 수준으로 계속 복제하고 장애 시 몇 분 안에 복구 인스턴스를 띄운다. DR 백서는 이 서비스를 파일럿 라이트 전략으로 분류한다 |
| RDS Proxy | 대부분의 애플리케이션에 코드 변경 없이 연결 풀과 장애 조치 단축 |
| ALB + Auto Scaling | 한 대짜리 서버를 여러 AZ로 복제(앱이 상태 비저장일 때) |
| Transfer Family | 기존 SFTP 클라이언트 설정을 유지한 채 S3로 |
| SQS | 동기 호출을 큐로 분리(일부 수정 필요) |

Elastic Disaster Recovery 사용자 가이드는 RPO와 RTO 숫자를 명시하지 않고 "몇 분 안에 복구 인스턴스를 띄운다"고만 적습니다. 같은 서비스의 FAQ는 "RPOs of seconds", "RTOs of minutes"라고 적어 흔히 보이는 "RPO 초 단위, RTO 분 단위"의 출처가 FAQ임을 확인했습니다(2026년 10월 20일). 복제 원본으로는 물리 서버, VMware vSphere, Microsoft Hyper-V, 다른 클라우드를 듭니다.

다만 2026년 10월 20일에 연 SAA-C03 범위 안 서비스 목록에는 Elastic Disaster Recovery가 없고 Migration and Transfer 범주에 AWS Application Migration Service가 있습니다. 이관(한 번 옮기기)이 목적이면 Application Migration Service, 계속 복제하다가 장애 때 띄우는 DR이 목적이면 Elastic Disaster Recovery라고 구분해 두었습니다. Application Migration Service는 2026년 10월 제품 페이지와 사용자 가이드에서 AWS Transform MGN으로 이름이 바뀌어 있고 시험 범위 목록에는 옛 이름으로 남아 있습니다. 문서는 물리·가상·클라우드 서버를 블록 수준으로 계속 복제해 AWS에서 띄우는 리호스팅 서비스로 설명합니다.

### 3-13. 불변 인프라와 자동화

DR 백서는 백업과 복원 전략에서도 인프라를 IaC(CloudFormation, CDK)로 배포하라고 강조합니다. IaC가 없으면 복구 리전에서 인프라를 다시 세우기 복잡해져 RTO를 넘길 수 있다는 이유입니다. 그 밖에 백서가 드는 도구는 Image Builder로 만든 골든 AMI를 두 리전에 복사하는 것, CloudFormation 의사 파라미터와 조건으로 DR 리전에는 축소 구성만 배포하는 것, StackSets로 여러 계정과 리전에 같은 스택을 배포하는 것입니다.

불변 인프라는 실행 중인 서버를 고치지 않고 새 이미지로 교체하는 방식입니다. 쇼핑몰의 배포를 새 AMI로 만든 Auto Scaling 그룹을 띄우고 ALB 대상을 옮기는 방식으로 하면 "서버마다 설정이 조금씩 다르다"는 문제가 생기지 않습니다. 이 정의는 안내서 항목 이름에서 출발한 일반적인 설명이고 이번에 AWS의 정의 문서를 따로 찾지는 않았습니다.

### 3-14. 서비스 할당량과 스로틀링

DR 백서는 웜 스탠바이에서 DR 리전을 프로덕션 용량으로 늘릴 때 그 리전의 서비스 할당량이 충분히 높게 설정되어 있는지 확인하라고 적습니다. 평소 DR 리전은 작게 돌기 때문에 할당량을 올려 두지 않으면 정작 장애 때 확장이 할당량에 막힙니다.

스로틀링은 서비스 사이의 한도 차이에서도 생깁니다. 2-7절의 API Gateway 초당 10,000요청과 Lambda 기본 동시성 1,000이 그 예이고 Lambda 문서는 예상 트래픽에 맞춰 동시성 한도를 미리 올리고 부하 테스트로 한도를 찾으라고 권합니다.

### 3-15. 가시성: X-Ray

X-Ray는 애플리케이션이 처리한 요청과 그 요청이 부른 AWS 리소스, 마이크로서비스, DB, 외부 API 호출을 추적합니다. 추적 데이터로 트레이스 맵을 만들어 병목, 지연 급증 같은 문제를 찾게 합니다. SDK는 세그먼트를 UDP로 X-Ray 데몬에 보내고 데몬이 모아서 올립니다. Lambda는 추적 데이터를 보내고 데몬을 대신 실행합니다. X-Ray 문서는 2026년 2월 25일부터 X-Ray SDK와 데몬이 유지 관리 모드에 들어가 보안 수정만 받는다고 공지하고 새 계측에는 OpenTelemetry로 옮기라고 권합니다. 트레이스를 모아 보는 X-Ray 서비스 자체는 그대로입니다.

"마이크로서비스 여러 개 중 어디서 느려지는지 모름"은 X-Ray, "지표 임계값 알림"은 CloudWatch 경보로 구분합니다. 안내서의 "비즈니스 요구에 맞는 지표 식별" 항목은 가용성을 무엇으로 잴지(오류율, 지연, 큐 적체)를 정하는 문제로 읽었습니다.

### 3-16. AWS 관리형 서비스 항목에 대해

안내서 2.2의 지식 항목에는 "AWS Managed Services (AMS) with appropriate use cases (for example, Amazon Comprehend, Amazon Polly)"가 있습니다. AMS라는 이름의 별도 운영 대행 서비스가 있지만 예시는 관리형 AI 서비스입니다. 저는 이 항목을 "직접 모델과 서버를 운영하지 않고 목적별 관리형 서비스로 해결하는 선택"으로 읽었습니다. Comprehend는 문서에서 엔터티, 핵심 구문, 언어, 감정을 뽑는 자연어 처리 서비스이고 토픽 모델링, 이벤트 감지, 프롬프트 안전 분류 기능은 신규 고객에게 더 이상 제공되지 않습니다. Polly는 텍스트를 음성으로 바꾸는 서비스이고 생성형, 장문형, 뉴럴, 표준 음성을 고를 수 있습니다.

### 3-17. 과제 2.2에서 갈리는 조건

| 시나리오의 단어 | 가리키는 답 |
|---|---|
| AZ 하나 장애에도 DB 유지, 읽기 확장 불필요 | RDS Multi-AZ |
| Multi-AZ 대기 인스턴스로 읽기 분산 | 불가. 읽기 복제본이나 Multi-AZ DB 클러스터, Aurora 복제본 |
| 장애 조치 30초 안팎, MySQL 호환 | Aurora(복제본 포함) |
| 리전 장애, RPO 1초 수준, 쓰기는 한 리전 | Aurora Global Database |
| 여러 리전에서 동시에 쓰기 | DynamoDB 글로벌 테이블 |
| S3 객체를 다른 리전에 15분 안에, SLA | S3 CRR + RTC |
| 이미 있던 객체도 복제 | S3 Batch Replication |
| 비용 최소, 몇 시간 RTO 허용 | 백업과 복원 |
| DB는 계속 복제, 앱 서버는 장애 시 시작 | 파일럿 라이트 |
| DR 리전이 작게라도 즉시 트래픽 처리 | 웜 스탠바이 |
| RTO 거의 0, 비용 무관 | 다중 사이트 액티브/액티브 |
| 주 리전 비정상 시 DNS 자동 전환 | Route 53 장애 조치 라우팅 + 상태 확인 |
| 사설 리소스 상태로 DNS 장애 조치 | CloudWatch 경보 기반 상태 확인 |
| 신뢰할 수 있는 수동 장애 조치 스위치 | ARC 라우팅 제어 |
| 고정 IP, 빠른 리전 전환, DNS 캐시 회피 | Global Accelerator |
| 온프레미스 서버의 DR을 AWS로, 앱 수정 없이 | Elastic Disaster Recovery |
| Lambda 동시 실행으로 DB 연결 고갈 | RDS Proxy |
| DR 리전에서 확장이 막힘 | DR 리전 서비스 할당량 사전 상향 |
| 분산 호출의 병목 추적 | X-Ray |

## 4. 확인 문제

직접 만든 시나리오입니다. 실제 시험 문항이나 문제집에서 가져온 것은 없습니다.

**문제 1.** 쇼핑몰의 주문 API가 결제 서비스를 동기로 호출합니다. 할인 행사 때 결제 서비스가 느려지면 주문 API까지 타임아웃이 납니다. 주문은 접수만 빠르게 하고 결제는 몇 분 늦어도 됩니다. 같은 주문이 두 번 결제되면 안 됩니다. 가장 알맞은 설계는 무엇입니까?

A. 결제 서비스 인스턴스를 더 큰 유형으로 바꾼다
B. 주문 API가 SQS FIFO 큐에 결제 요청을 넣고 결제 서비스가 큐를 소비한다. 중복 제거 ID로 주문 번호를 쓴다
C. 주문 API가 SNS 토픽에 발행하고 결제 서비스가 HTTP로 구독한다
D. 결제 서비스 앞에 ALB를 두고 Auto Scaling을 붙인다

<details>
<summary>정답과 이유</summary>

B입니다. 큐가 두 서비스 사이를 끊어 결제가 느려도 주문 접수는 계속되고 FIFO 큐의 중복 제거로 같은 주문 번호가 두 번 들어오는 것을 막습니다. A는 수직 확장이라 결합은 그대로입니다. C는 SNS가 밀어 넣는 방식이라 결제 서비스가 느릴 때 재시도와 적체 관리가 큐보다 약합니다. D는 결제 서비스 확장에는 도움이 되지만 동기 결합과 중복 문제는 남습니다. 표준 큐를 고르면 최소 한 번 전달이라 결제 쪽을 반드시 멱등하게 만들어야 합니다.
</details>

**문제 2.** 게시판에 글이 올라오면 검색 색인 갱신, 알림 발송, 통계 집계 세 작업이 각각 일어나야 합니다. 세 작업은 처리 속도가 다르고 하나가 멈춰도 나머지는 계속되어야 합니다. 어떤 구성이 맞습니까?

A. 글 저장 Lambda가 세 작업을 순서대로 호출한다
B. SNS 토픽에 발행하고 작업마다 SQS 큐를 구독시켜 각자 소비한다
C. SQS 표준 큐 하나에 넣고 세 작업이 같은 큐를 소비한다
D. Step Functions 익스프레스 워크플로로 세 작업을 직렬로 묶는다

<details>
<summary>정답과 이유</summary>

B입니다. SNS와 SQS 팬아웃은 한 메시지를 큐마다 복사하므로 작업이 각자 속도로 처리하고 하나가 멈춰도 그 큐에만 쌓입니다. C는 한 메시지를 한 소비자만 가져가므로 세 작업이 메시지를 나눠 갖게 됩니다. A와 D는 직렬이라 한 작업의 실패가 나머지에 영향을 줍니다. 이벤트 내용에 따라 대상을 다르게 고르는 조건이 붙으면 EventBridge 규칙도 후보입니다.
</details>

**문제 3.** 결제 서비스의 RDS for MySQL이 Multi-AZ DB 인스턴스로 구성되어 있습니다. 월말 정산 보고서 쿼리 때문에 기본 인스턴스 CPU가 높아집니다. 개발자는 대기 인스턴스로 보고서 쿼리를 보내자고 제안합니다. 맞는 판단은 무엇입니까?

A. 대기 인스턴스 엔드포인트로 보고서 쿼리를 보낸다
B. 대기 인스턴스는 읽기를 처리하지 않으니 읽기 복제본을 만들어 보고서 쿼리를 보낸다
C. Multi-AZ를 끄고 그 비용으로 인스턴스를 키운다
D. 보고서 쿼리를 ElastiCache에 넣는다

<details>
<summary>정답과 이유</summary>

B입니다. RDS 문서는 Multi-AZ DB 인스턴스의 대기 복제본이 읽기 트래픽을 처리할 수 없고 읽기에는 읽기 복제본이나 Multi-AZ DB 클러스터를 쓰라고 적습니다. 보고서 분리는 문서가 든 읽기 복제본 용도 중 하나입니다. A는 불가능합니다. C는 가용성을 잃습니다. D는 매번 다른 집계 쿼리라 캐시 효과가 적습니다. 읽기 복제본은 비동기라 보고서가 몇 초 늦은 데이터를 볼 수 있다는 점을 받아들일 수 있어야 합니다.
</details>

**문제 4.** 쇼핑몰은 서울 리전에서 운영합니다. 경영진은 리전 장애 시 RTO 4시간, RPO 1시간을 요구하고 DR 비용은 가장 적게 쓰기를 원합니다. 어떤 전략이 맞습니까?

A. 다중 사이트 액티브/액티브
B. 웜 스탠바이
C. 백업과 복원. 1시간보다 짧은 주기의 백업을 DR 리전으로 복사하고 인프라는 IaC로 둔다
D. Multi-AZ 구성만 유지한다

<details>
<summary>정답과 이유</summary>

C입니다. RTO 4시간과 RPO 1시간은 비교적 여유 있는 목표이고 백업과 복원이 네 전략 중 비용이 가장 낮습니다. RPO를 맞추려면 백업 주기가 1시간보다 짧아야 하고 RTO를 맞추려면 DR 백서가 강조하는 대로 IaC로 인프라를 빠르게 다시 세울 수 있어야 합니다. A와 B는 요구를 넘는 비용입니다. D는 리전 장애에 대비하지 못합니다. 실제로 4시간 안에 복원되는지는 복원 테스트로 확인해야 합니다.
</details>

**문제 5.** 결제 서비스의 DR 리전에는 데이터가 Aurora Global Database 보조 클러스터로 복제되고 있고 애플리케이션 서버는 AMI와 템플릿만 준비되어 있으며 실행 중인 인스턴스는 없습니다. 이 구성은 어떤 전략이고 장애 시 무엇을 해야 합니까?

A. 웜 스탠바이. 트래픽만 돌리면 된다
B. 파일럿 라이트. 보조 클러스터를 승격하고 앱 서버를 시작해 확장한 뒤 트래픽을 돌린다
C. 백업과 복원. 스냅샷에서 DB를 복원한다
D. 액티브/액티브. 할 일이 없다

<details>
<summary>정답과 이유</summary>

B입니다. 데이터는 계속 복제되어 켜져 있고 앱 서버는 꺼져 있으니 백서의 파일럿 라이트 정의와 같습니다. 백서는 파일럿 라이트가 추가 조치 없이는 요청을 처리할 수 없다고 적습니다. A는 앱 서버가 작게라도 돌고 있어야 합니다. C는 데이터가 연속 복제되고 있어 맞지 않습니다. DR 리전에서 앱 서버를 프로덕션 규모로 늘릴 수 있도록 서비스 할당량을 미리 올려 두는 것도 준비에 들어갑니다.
</details>

**문제 6.** 게시판 서비스가 두 리전에서 ALB로 운영됩니다. 주 리전이 비정상이면 DNS가 자동으로 보조 리전을 가리켜야 합니다. 주 리전의 정상 여부는 사설 서브넷의 DB 연결 오류율로 판단하려 합니다. 어떤 구성이 맞습니까?

A. Route 53 가중치 라우팅으로 50:50 분산
B. 사설 DB 엔드포인트를 대상으로 하는 Route 53 엔드포인트 상태 확인
C. DB 연결 오류율에 CloudWatch 경보를 만들고 그 경보를 보는 Route 53 상태 확인을 주 레코드에 연결한 장애 조치 라우팅
D. 지연 시간 기반 라우팅

<details>
<summary>정답과 이유</summary>

C입니다. Route 53은 사설 IP 범위의 엔드포인트를 직접 확인할 수 없으므로 사설 리소스의 상태는 CloudWatch 경보 기반 상태 확인으로 반영합니다. 장애 조치 라우팅이 액티브/패시브 구성에 맞습니다. A는 두 리전에 트래픽을 나누는 설정입니다. B는 사설 IP라 불가능합니다. D는 지연 기준이고 정상 여부 판단 조건이 없습니다. 경보는 상태 확인과 같은 계정에 있어야 하고 지표 수학 경보는 지원되지 않는다는 제약이 있습니다.
</details>

**문제 7.** 쇼핑몰의 상품 조회 API는 Lambda와 RDS for PostgreSQL로 되어 있습니다. 행사 때 Lambda 동시 실행이 수백 개로 늘면서 DB 연결 수 한도에 걸려 오류가 납니다. 코드 변경은 최소로 하고 싶습니다. 가장 알맞은 방법은 무엇입니까?

A. DB 인스턴스 유형을 키운다
B. RDS Proxy를 두고 Lambda가 프록시 엔드포인트에 연결하게 한다
C. Lambda 예약 동시성을 1로 낮춘다
D. 읽기 복제본을 15개 만든다

<details>
<summary>정답과 이유</summary>

B입니다. RDS Proxy는 연결 풀을 만들어 재사용하고 즉시 처리할 수 없는 연결은 큐에 넣거나 제한해 DB를 과부하에서 보호합니다. 대부분의 애플리케이션은 연결 엔드포인트만 바꾸면 됩니다. A는 연결 한도를 조금 늘릴 뿐 급증을 흡수하지 못합니다. C는 처리량을 버립니다. D는 읽기 전용 연결을 나눌 수는 있지만 복제본마다 연결 수 문제가 반복되고 RDS Proxy는 복제 구성에서 쓰기 인스턴스에만 붙는다는 제약도 함께 봐야 합니다.
</details>

**문제 8.** 결제 기록을 담은 S3 버킷을 다른 리전에 복제하려 합니다. 이미 있는 객체 수천만 개도 복제해야 하고 새 객체는 규정상 15분 안에 대상 리전에 있어야 합니다. 맞는 구성은 무엇입니까? (두 개 고르기)

A. 원본과 대상 버킷에 버전 관리를 켜고 CRR에 S3 RTC를 켠다
B. 기존 객체는 S3 Batch Replication으로 복제한다
C. 기존 객체는 CRR 규칙을 만들면 자동으로 복제된다
D. 버전 관리 없이 CRR만 켠다
E. RTC가 기존 객체에도 15분 SLA를 적용한다

<details>
<summary>정답과 이유</summary>

A와 B입니다. CRR은 원본과 대상 모두 버전 관리가 필요하고 RTC는 새 객체의 99.99%를 15분 안에 복제하도록 설계됐으며 99.9%까지를 SLA로 보장합니다. 실시간 복제는 설정 이전 객체를 복제하지 않으므로 기존 객체는 Batch Replication을 씁니다. C와 D는 문서와 반대입니다. E는 문서가 RTC는 Batch Replication에 적용되지 않는다고 명시합니다.
</details>

## 5. 범위와 한계

- 2026년 10월 19일에 열어 본 AWS 공식 문서, SAA-C03 시험 안내서, DR 백서(Disaster Recovery of Workloads on AWS)로 정리했습니다. 한도와 요금은 바뀌므로 응시 전에 다시 확인합니다.
- 실습은 아직 하지 않았습니다. SQS 표시 제한 시간과 DLQ 동작, Route 53 장애 조치 전환 시간, RDS 장애 조치 시간은 문서 수치를 옮긴 것이고 직접 잰 값이 아닙니다. Ch-00의 3단계에서 SQS와 SNS 팬아웃부터 만들어 볼 계획입니다.
- 2026년 10월 21일 보강: DynamoDB MRSC의 리전 수와 지연 특성, Auto Scaling 예약·예측 조정, Application Migration Service(AWS Transform MGN), DAX, EKS, Comprehend, Polly를 각 문서로 확인해 본문에 넣었습니다. S3 RTC 99.99%와 99.9%의 차이, AWS Backup 복원 테스트, X-Ray SDK·데몬 유지 관리 모드, Aurora에서 RDS Proxy 읽기 전용 엔드포인트도 고쳤습니다.
- 2026년 10월 20일 보강: 읽기 복제본 15개는 RDS 할당량 문서의 "Read replicas per primary" 기본값 15로, Route 53 실패 임계값 기본값 3은 API 참조로, Elastic Disaster Recovery의 RPO 초·RTO 분은 FAQ로, 서울 리전의 SQS FIFO 높은 처리량 한도(그 밖의 리전 2,400)는 메시지 할당량 문서로 확인했습니다. ELB 교차 영역·고정 세션·등록 취소 지연, Auto Scaling 수명 주기 후크·웜 풀, AWS Backup 리전 간 복사를 새로 넣었습니다.
- 문서끼리 숫자가 다른 곳은 Aurora Global Database 보조 리전 수(사용자 가이드 10개, 2021년판 DR 백서 5개)입니다. 본문에 어느 쪽을 따랐는지 적었습니다.
- SQS 메시지 최대 크기(1MiB), Lambda 비동기 페이로드 1MB와 Managed Instances 90분, EventBridge의 새 Custom Event Bus, ECS Managed Instances, 리전 NAT 게이트웨이는 시험 안내서 이후 바뀌거나 생긴 것으로 보이며 문항 반영 여부는 알 수 없습니다. Elastic Disaster Recovery는 2026년 10월 범위 안 서비스 목록에 없습니다.
- "시험에서 갈리는 조건" 표와 SNS·EventBridge 구분은 문서 설명을 시나리오 단어와 짝지은 제 정리입니다. 확인 문제는 직접 만든 것입니다.

## 참고 자료

시험 안내서와 백서
- AWS, [AWS Certified Solutions Architect - Associate (SAA-C03)](https://docs.aws.amazon.com/aws-certification/latest/solutions-architect-associate-03/solutions-architect-associate-03.html)
- AWS, [Content Domain 2: Design Resilient Architectures](https://docs.aws.amazon.com/aws-certification/latest/solutions-architect-associate-03/solutions-architect-associate-03-domain2.html)
- AWS Whitepaper, Disaster Recovery of Workloads on AWS: [Business Continuity Plan (BCP)](https://docs.aws.amazon.com/whitepapers/latest/disaster-recovery-workloads-on-aws/business-continuity-plan-bcp.html), [Disaster recovery options in the cloud](https://docs.aws.amazon.com/whitepapers/latest/disaster-recovery-workloads-on-aws/disaster-recovery-options-in-the-cloud.html)

결합 끊기와 확장
- Amazon SQS Developer Guide: [Amazon SQS queue types](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-queue-types.html), [Amazon SQS message quotas](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-messages.html)
- Amazon SNS Developer Guide, [Amazon SNS message filtering](https://docs.aws.amazon.com/sns/latest/dg/sns-message-filtering.html)
- Amazon EventBridge User Guide, [What Is Amazon EventBridge?](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-what-is.html)
- AWS Step Functions Developer Guide, [Choosing workflow type in Step Functions](https://docs.aws.amazon.com/step-functions/latest/dg/choosing-workflow-type.html)
- Amazon API Gateway Developer Guide: [Choose between REST APIs and HTTP APIs](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-vs-rest.html), [Amazon API Gateway quotas](https://docs.aws.amazon.com/apigateway/latest/developerguide/limits.html), [Quotas for configuring and running a REST API in API Gateway](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-execution-service-limits-table.html)
- AWS Lambda Developer Guide, [Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html)
- Amazon ECS Developer Guide, [What is Amazon Elastic Container Service?](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/Welcome.html)
- Amazon EC2 Auto Scaling User Guide, [Dynamic scaling for Amazon EC2 Auto Scaling](https://docs.aws.amazon.com/autoscaling/ec2/userguide/as-scale-based-on-demand.html)
- Amazon ElastiCache, [Caching strategies for Memcached](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/Strategies.html)
- Amazon CloudFront Developer Guide, [What is Amazon CloudFront?](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/Introduction.html)
- Amazon RDS User Guide: [Working with DB instance read replicas](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_ReadRepl.html), [Differences between read replicas for DB engines](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_ReadRepl.Overview.Differences.html)
- AWS What's New, [Amazon RDS for MySQL, MariaDB and PostgreSQL now support up to 15 read replicas for 3X read capacity](https://aws.amazon.com/about-aws/whats-new/2022/10/amazon-rds-mysql-mariadb-postgre-sql-support-15-read-replicas-3x-read-capacity/), 2022
- [What is Amazon Elastic File System?](https://docs.aws.amazon.com/efs/latest/ug/whatisefs.html), [Amazon EBS volumes](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-volumes.html), [What is AWS Transfer Family?](https://docs.aws.amazon.com/transfer/latest/userguide/what-is-aws-transfer-family.html)

가용성과 복구
- Amazon Route 53 Developer Guide: [Choosing a routing policy](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/routing-policy.html), [Types of Amazon Route 53 health checks](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/health-checks-types.html), [Values that you specify when you create or update health checks](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/health-checks-creating-values.html)
- AWS Global Accelerator Developer Guide, [What is AWS Global Accelerator?](https://docs.aws.amazon.com/global-accelerator/latest/dg/what-is-global-accelerator.html)
- Amazon RDS User Guide: [Multi-AZ DB instance deployments for Amazon RDS](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZSingleStandby.html), [Failing over a Multi-AZ DB instance for Amazon RDS](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZ.Failover.html), [Amazon RDS Proxy](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.html)
- Amazon Aurora User Guide: [High availability for Amazon Aurora](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Concepts.AuroraHighAvailability.html), [Using Amazon Aurora Global Database](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-global-database.html)
- Amazon DynamoDB Developer Guide: [Global tables - multi-active, multi-Region replication](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GlobalTables.html), [Global tables core concepts](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/globaltables-CoreConcepts.html)
- Amazon S3 User Guide, [Replicating objects within and across Regions](https://docs.aws.amazon.com/AmazonS3/latest/userguide/replication.html)
- AWS Backup Developer Guide, [What is AWS Backup?](https://docs.aws.amazon.com/aws-backup/latest/devguide/whatisbackup.html)
- AWS Elastic Disaster Recovery User Guide, [What is Elastic Disaster Recovery?](https://docs.aws.amazon.com/drs/latest/userguide/what-is-drs.html)
- AWS X-Ray Developer Guide, [What is AWS X-Ray?](https://docs.aws.amazon.com/xray/latest/devguide/aws-xray.html)

2026년 10월 20일 보강 때 연 문서
- Elastic Load Balancing User Guide, [How Elastic Load Balancing works](https://docs.aws.amazon.com/elasticloadbalancing/latest/userguide/how-elastic-load-balancing-works.html)
- User Guide for Application Load Balancers, [Edit target group attributes for your Application Load Balancer](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-target-group-attributes.html)
- Amazon EC2 Auto Scaling User Guide: [Amazon EC2 Auto Scaling lifecycle hooks](https://docs.aws.amazon.com/autoscaling/ec2/userguide/lifecycle-hooks.html), [Decrease latency for applications with long boot times using warm pools](https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-warm-pools.html)
- Amazon Route 53 API Reference, [HealthCheckConfig](https://docs.aws.amazon.com/Route53/latest/APIReference/API_HealthCheckConfig.html)
- AWS, [AWS Elastic Disaster Recovery FAQs](https://aws.amazon.com/disaster-recovery/faqs/)
- AWS Backup Developer Guide, [Creating backup copies across AWS Regions](https://docs.aws.amazon.com/aws-backup/latest/devguide/cross-region-backup.html)
- Amazon RDS User Guide, [Quotas and constraints for Amazon RDS](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_Limits.html)

2026년 10월 21일 보강 때 연 문서
- AWS, [Amazon S3 FAQs](https://aws.amazon.com/s3/faqs/), [S3 Replication Time Control SLA](https://aws.amazon.com/s3/sla-rtc/)
- AWS Backup Developer Guide, [Restore testing](https://docs.aws.amazon.com/aws-backup/latest/devguide/restore-testing.html)
- AWS X-Ray Developer Guide, [X-Ray SDK and daemon support timeline](https://docs.aws.amazon.com/xray/latest/devguide/xray-sdk-daemon-timeline.html)
- [AWS Transform MGN](https://aws.amazon.com/application-migration-service/), [Amazon RDS Proxy for Aurora](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/rds-proxy.html), [Multi-AZ DB cluster deployments](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/multi-az-db-clusters-concepts.html)
- Amazon DynamoDB Developer Guide, [How global tables work](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/V2globaltables_HowItWorks.html), [In-memory acceleration with DAX](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DAX.html)
- EC2 Auto Scaling: [Scheduled scaling](https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-scheduled-scaling.html), [Predictive scaling](https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-predictive-scaling.html)
- [What is Amazon EKS?](https://docs.aws.amazon.com/eks/latest/userguide/what-is-eks.html), [What is Amazon Comprehend?](https://docs.aws.amazon.com/comprehend/latest/dg/what-is.html), [Amazon Comprehend availability change](https://docs.aws.amazon.com/comprehend/latest/dg/comprehend-availability-change.html), [What is Amazon Polly?](https://docs.aws.amazon.com/polly/latest/dg/what-is.html)
- AWS, [In-Scope AWS Services (SAA-C03)](https://docs.aws.amazon.com/aws-certification/latest/solutions-architect-associate-03/saa-03-in-scope-services.html)

---
title: '[SAA] SAA 전체 지도: 주문 요청 하나를 따라 위에서 아래로'
description: SAA 시리즈 본편은 시험 영역 순서(보안, 복원력, 성능, 비용)로 서비스를 하나씩 다룹니다. 이 글은 반대로 쇼핑몰 사용자가 주문 버튼을 누른 요청 하나를 Route 53에서 S3까지 위에서 아래로 따라가며 층마다 시험이 묻는 결정과 그 내용을 다룬 챕터의 절을 잇습니다. 본편을 읽기 전과 다 읽은 뒤에 펼쳐 보는 지도입니다.
date: 2026-10-23T00:00:00.000Z
tags:
  - AWS
  - SAA
  - Certification
  - Study Plan
  - Architecture
category: cert/SAA
topics:
  - cert
draft: false
series: "SAA 공부"
seriesOrder: 2
---

## 결론부터

1. SAA 본편(3~6편)은 시험 영역 순서대로 쓰여 있어서 서비스 하나하나는 자세한데 서로 어디서 만나는지는 잘 안 보입니다. 이 글은 주문 요청 하나가 지나가는 길을 따라 그 서비스들을 한 줄로 세웁니다.
2. 요청은 Route 53, CloudFront, ALB, Auto Scaling 그룹, ElastiCache와 RDS, SQS, S3 순서로 내려가고 그 전부가 VPC, IAM, KMS라는 바닥 위에 올라가 있습니다.
3. 층 하나에서 시험이 묻는 결정은 대개 두 영역에 걸칩니다. ALB는 복원력(상태 확인)과 보안(TLS)이 같이 나오고 Auto Scaling 그룹은 복원력(AZ 분산)과 비용(구매 옵션)이 같이 나옵니다.
4. 시험 비중이 가장 큰 보안(30%)은 대부분 바닥에서 나옵니다. 그래서 바닥을 먼저 그릴 수 있어야 위층 문제도 잘 풀립니다.
5. 읽는 순서는 이 지도로 큰 그림을 잡고 3편(바닥)부터 본편을 읽은 뒤 다시 이 지도로 돌아와 층마다 "여기서 무엇을 고르는지"를 말로 설명해 보는 것입니다.

---

## 1. 왜 위에서 아래로 한 번 더 보는가

[1편](/blog/cert/saa/saa-00-exam-and-study-plan)에서 정한 대로 본편은 공식 시험 안내서의 영역과 과제 순서를 그대로 따랐습니다. 시험 범위를 빠짐없이 훑기에는 이 순서가 맞습니다. 다만 공부하다 보면 이런 순간이 옵니다. SQS는 4편에서 읽었고 ElastiCache는 5편에서 읽었는데 두 서비스가 같은 쇼핑몰 안에서 어떻게 이어지는지 물으면 머뭇거리게 됩니다.

시험 문제는 영역별로 묶여 나오지 않습니다. "주문이 몰릴 때 결제 단계가 느려진다. 가장 운영 부담이 적은 방법은?" 같은 문제 하나에 ALB, Auto Scaling, SQS, RDS가 한꺼번에 보기로 나옵니다. 그래서 요청 하나가 어디를 거쳐 가는지 머릿속에 지도가 있어야 보기 네 개를 지도 위 어느 칸에 놓을지 바로 보입니다.

이 글은 그 지도입니다. 새 내용은 거의 없고 본편의 절로 가는 길을 겁니다.

## 2. 지도 한 장

![주문 요청 하나가 사용자 브라우저에서 Route 53, CloudFront와 S3 정적 파일, ALB, Auto Scaling 그룹, ElastiCache와 RDS, SQS와 워커, S3를 차례로 지나가는 그림. 층마다 관련 시험 영역(보안, 복원력, 성능, 비용)과 챕터 절 번호가 붙어 있고 맨 아래에 VPC, 서브넷, 보안 그룹, IAM 역할, KMS 바닥이 깔려 있다](/uploads/cert/saa-map/request-path.svg)

예제는 시리즈 전체에서 써 온 쇼핑몰입니다. 사용자가 `shop.example.com`에 들어와 상품 이미지를 보고 주문 버튼을 누릅니다. 서버는 주문을 DB에 쓰고 결제 알림과 메일은 나중에 처리하도록 큐에 넣은 뒤 바로 응답합니다. 영수증과 접속 기록은 S3에 쌓입니다.

오른쪽의 색 딱지는 그 층에서 자주 나오는 시험 영역입니다. 빨강은 보안, 초록은 복원력, 파랑은 성능, 노랑은 비용입니다.

## 3. 층별로 내려가기

층마다 세 가지를 적었습니다. 그 층에서 실제로 일어나는 일, 시험이 그 층에서 묻는 결정, 본편에서 그 내용을 다룬 절입니다.

### 3-1. Route 53: 이름을 주소로 바꾼다

브라우저는 `shop.example.com`이 어디 있는지 모릅니다. 먼저 DNS에 묻고 Route 53이 이 도메인의 답을 정하는 권한 있는 서버로 답합니다. ALB와 CloudFront는 IP가 바뀔 수 있어서 A 레코드에 IP를 적지 않고 별칭(Alias) 레코드로 가리킵니다. 별칭은 `example.com` 같은 꼭대기 이름에도 쓸 수 있습니다([Route 53 개발자 안내서: 별칭과 비별칭 레코드](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resource-record-sets-choosing-alias-non-alias.html)).

시험이 여기서 묻는 것은 누구에게 어떤 답을 줄지입니다.

- 주 리전이 죽으면 보조 리전으로 보내려면 장애 조치 라우팅과 상태 확인을 함께 씁니다.
- 가까운 리전으로 보내려면 지연 시간 기반, 나라별로 다른 사이트를 보이려면 지리적 위치 기반입니다.
- 새 버전에 트래픽 10%만 보내려면 가중치 기반입니다.

읽을 곳: [4편 3-3 라우팅 정책](/blog/cert/saa/saa-02-resilient-architectures#3-3-route-53-라우팅-정책), [4편 3-4 상태 확인](/blog/cert/saa/saa-02-resilient-architectures#3-4-route-53-상태-확인)

### 3-2. CloudFront와 S3: 정적 파일은 엣지에서 끝낸다

상품 이미지와 CSS 같은 정적 파일은 서버까지 갈 이유가 없습니다. CloudFront가 사용자와 가까운 엣지 로케이션에 사본을 두고 거기서 바로 돌려줍니다. 사본이 없을 때만 원본인 S3 버킷에서 가져옵니다. 주문 API처럼 매번 달라지는 요청은 경로 패턴(`/api/*`)으로 나눠 ALB 원본으로 넘깁니다.

시험이 묻는 결정은 두 영역에 걸칩니다.

- **보안**: 버킷을 공개로 열지 않고 CloudFront만 읽게 하려면 OAC(원본 액세스 제어)를 씁니다. 특정 사용자에게만 잠깐 내려받게 하려면 미리 서명된 URL입니다.
- **성능**: HTTP 콘텐츠를 캐시하면 CloudFront이고 TCP/UDP에 고정 IP가 필요하면 Global Accelerator입니다.
- **비용**: AWS 오리진에서 CloudFront로 가는 전송에는 요금이 붙지 않습니다.

읽을 곳: [3편 4-8 OAC와 미리 서명된 URL](/blog/cert/saa/saa-01-secure-architectures#4-8-버킷을-비공개로-둔-채-내보내기-cloudfront-oac와-미리-서명된-url), [5편 5-2 CloudFront와 Global Accelerator](/blog/cert/saa/saa-03-high-performing-architectures#5-2-cloudfront와-global-accelerator), [6편 6-6 CDN과 엣지 캐싱](/blog/cert/saa/saa-04-cost-optimized-architectures#6-6-cdn과-엣지-캐싱)

### 3-3. ALB: 하나의 입구에서 살아 있는 서버로

주문 요청은 ALB에 도착합니다. ALB는 HTTPS 443 리스너에서 요청을 받고 ACM 인증서로 TLS를 풉니다. 경로나 호스트 이름을 보는 규칙으로 대상 그룹을 고르고 상태 확인을 통과한 대상에게만 요청을 넘깁니다. ALB를 만들 때 고른 AZ마다 노드가 생기니 AZ 하나가 멈춰도 입구는 남습니다.

시험이 묻는 결정은 이렇습니다.

- HTTP 경로와 호스트로 나눠 보내면 ALB, 초당 수백만 연결이나 고정 IP나 TCP/UDP면 NLB입니다.
- 서버가 죽었는데도 요청이 가면 상태 확인 설정을 봅니다.
- SQL 인젝션이나 특정 국가 차단이 나오면 ALB나 CloudFront에 WAF를 붙입니다.

읽을 곳: [4편 2-2 다계층과 로드 밸런싱](/blog/cert/saa/saa-02-resilient-architectures#2-2-다계층-아키텍처와-로드-밸런싱), [3편 4-6 ACM과 TLS](/blog/cert/saa/saa-01-secure-architectures#4-6-전송-중-암호화-acm과-tls), [3편 3-6 WAF와 Shield](/blog/cert/saa/saa-01-secure-architectures#3-6-외부-위협-waf와-shield), [5편 5-5 로드 밸런싱 전략](/blog/cert/saa/saa-03-high-performing-architectures#5-5-로드-밸런싱-전략)

### 3-4. Auto Scaling 그룹: 서버 수를 부하에 맞춘다

ALB 뒤에는 주문 API를 돌리는 EC2 인스턴스들이 Auto Scaling 그룹으로 묶여 있습니다. 그룹은 최소, 최대, 원하는 용량을 갖고 두 AZ에 인스턴스를 나눠 둡니다. 상태 확인에 실패한 인스턴스는 그룹이 종료하고 새로 띄웁니다. 컨테이너로 돌린다면 ECS나 EKS 서비스가 같은 자리에 들어가고 서버 관리를 없애려면 Fargate입니다.

이 층은 세 영역이 다 걸립니다.

- **복원력**: 한 AZ에 몰아 두면 AZ 장애에 같이 멈춥니다. 서버에 세션을 저장하면 인스턴스가 바뀔 때 로그인이 풀리니 세션은 ElastiCache나 DynamoDB로 뺍니다(상태 비저장).
- **성능**: 확장 정책은 대상 추적(예: 평균 CPU 50% 유지)이 기본값입니다. 매일 같은 시간에 몰리면 예약된 조정을 더합니다.
- **비용**: 꾸준한 기준 부하에는 Savings Plans, 중단돼도 되는 작업에는 Spot, 나머지에는 On-Demand를 섞습니다. 주문 API처럼 중단되면 안 되는 곳에 Spot만 쓰는 보기는 오답입니다.

읽을 곳: [4편 2-1 수평 확장과 상태 비저장](/blog/cert/saa/saa-02-resilient-architectures#2-1-수평-확장-수직-확장-상태-비저장), [4편 2-10 Auto Scaling](/blog/cert/saa/saa-02-resilient-architectures#2-10-auto-scaling), [5편 3-3 대상 추적](/blog/cert/saa/saa-03-high-performing-architectures#3-3-auto-scaling-정책-대상-추적이-기본값), [6편 4-1 구매 옵션](/blog/cert/saa/saa-04-cost-optimized-architectures#4-1-구매-옵션)

### 3-5. ElastiCache와 RDS: 읽기는 캐시, 쓰기는 주 DB

주문 API는 상품 정보를 읽고 주문을 씁니다. 상품 정보는 자주 읽히고 잘 바뀌지 않으니 ElastiCache에 먼저 묻고 없을 때만 DB에서 읽어 캐시에 넣습니다(지연 로딩). 주문은 RDS 주 인스턴스에 씁니다. Multi-AZ로 만들면 다른 AZ에 대기 인스턴스가 생기고 동기로 복제됩니다. 주 인스턴스가 죽으면 보통 60~120초 안에 대기 인스턴스로 넘어갑니다. 대기 인스턴스는 읽기를 받지 않습니다.

이 층에서 시험이 가장 자주 가르는 것이 "장애 조치"와 "읽기 확장"의 구분입니다.

| 문제의 문장 | 고르는 것 |
|---|---|
| AZ 하나가 멈춰도 DB가 이어져야 한다 | RDS Multi-AZ |
| 읽기가 주 DB에 몰린다 | 읽기 복제본(비동기)이나 Aurora 복제본 |
| 같은 키를 반복해서 읽는다 | ElastiCache, DynamoDB면 DAX |
| Lambda가 늘어날 때 연결 수가 폭주한다 | RDS Proxy |
| 한가한 시간이 긴 관계형 DB 비용 | Aurora Serverless v2 |

읽을 곳: [4편 2-11 캐싱 전략](/blog/cert/saa/saa-02-resilient-architectures#2-11-캐싱-전략), [4편 3-7 DB 장애 조치](/blog/cert/saa/saa-02-resilient-architectures#3-7-db-장애-조치-rds-multi-az-aurora-rds-proxy), [5편 4-2 읽기 복제본](/blog/cert/saa/saa-03-high-performing-architectures#4-2-rds-읽기-복제본), [5편 4-6 ElastiCache](/blog/cert/saa/saa-03-high-performing-architectures#4-6-elasticache-memcached와-valkeyredis-oss), [6편 5-1 부하 모양으로 고르기](/blog/cert/saa/saa-04-cost-optimized-architectures#5-1-부하-모양으로-서비스-고르기)

### 3-6. SQS와 워커: 늦어도 되는 일은 큐로 미룬다

주문을 DB에 쓴 다음 결제 알림과 메일까지 기다렸다가 응답하면 메일 서버가 느려질 때 주문도 같이 느려집니다. 그래서 주문 API는 "주문이 생겼다"는 메시지를 SNS 주제에 보내고 바로 응답합니다. SNS가 결제용 큐와 알림용 큐 두 SQS에 같은 메시지를 넣고(팬아웃) 각 워커가 자기 속도로 꺼내 처리합니다.

워커가 메시지를 받으면 메시지는 지워지지 않고 표시 제한 시간 동안 다른 워커에게 보이지 않습니다. 처리를 마치고 삭제해야 사라지고 그 전에 워커가 죽으면 다시 보여서 다른 워커가 가져갑니다. 계속 실패하는 메시지는 DLQ로 옮겨집니다. 같은 메시지가 두 번 처리될 수 있으니 워커는 같은 주문을 두 번 받아도 결과가 같게 만들어야 합니다.

시험이 묻는 결정은 이렇습니다.

- "느슨한 결합", "급증에도 요청을 잃지 않게"가 나오면 SQS를 먼저 떠올립니다.
- 순서와 중복 제거가 필요하면 FIFO 큐, 한 이벤트를 여러 곳에 보내면 SNS 팬아웃, 규칙으로 라우팅하면 EventBridge, 여러 단계를 순서와 재시도로 묶으면 Step Functions입니다.

읽을 곳: [4편 2-3 SQS](/blog/cert/saa/saa-02-resilient-architectures#2-3-큐-sqs), [4편 2-4 SNS 팬아웃](/blog/cert/saa/saa-02-resilient-architectures#2-4-발행구독-sns와-팬아웃), [4편 2-5 EventBridge](/blog/cert/saa/saa-02-resilient-architectures#2-5-이벤트-기반-eventbridge), [4편 2-6 Step Functions](/blog/cert/saa/saa-02-resilient-architectures#2-6-워크플로-오케스트레이션-step-functions)

### 3-7. S3: 쌓이는 것은 싸게 오래

워커가 만든 영수증 PDF와 ALB, CloudFront의 접속 기록은 S3에 쌓입니다. 처음 한 달은 자주 열어 보지만 그 뒤로는 거의 안 봅니다. 그래서 수명 주기 규칙으로 30일 뒤 Standard-IA, 1년 뒤 Glacier 계열로 내립니다. 접근 패턴을 모르면 Intelligent-Tiering에 맡깁니다. 128KB보다 작은 객체는 기본적으로 전환되지 않는다는 점이 문제에 함정으로 나옵니다.

보안 쪽에서는 영수증 버킷의 암호화(SSE-S3나 SSE-KMS)와 삭제 방지(버전 관리, Object Lock)가 같이 나옵니다.

읽을 곳: [6편 3-1 저장 클래스를 고르는 순서](/blog/cert/saa/saa-04-cost-optimized-architectures#3-1-저장-클래스를-고르는-순서), [6편 3-2 수명 주기 규칙의 제약](/blog/cert/saa/saa-04-cost-optimized-architectures#3-2-수명-주기-규칙의-제약), [3편 4-5 S3 저장 시 암호화](/blog/cert/saa/saa-01-secure-architectures#4-5-s3-저장-시-암호화), [3편 4-9 보존과 삭제 방지](/blog/cert/saa/saa-01-secure-architectures#4-9-보존과-삭제-방지-버전-관리-object-lock-mfa-delete)

### 3-8. 주문 그 뒤: 데이터 쪽 갈래

주문 이벤트는 분석에도 쓰입니다. 주문이 생길 때마다 Data Firehose로 보내면 버퍼링해서 S3에 Parquet으로 쓰고 Athena로 바로 쿼리할 수 있습니다. 실시간에 가깝게 여러 소비자가 다시 읽어야 하면 Kinesis Data Streams, 이미 Kafka를 쓰고 있으면 MSK입니다. 그림에는 넣지 않았지만 시험 과제 3.5가 이 갈래를 묻습니다.

읽을 곳: [5편 6절 데이터 수집과 변환](/blog/cert/saa/saa-03-high-performing-architectures#6-과제-35-고성능-데이터-수집과-변환)

## 4. 바닥: VPC, IAM, KMS

위의 층은 모두 VPC 안에 놓이고 서로 부를 때마다 IAM 권한을 거치고 저장할 때 KMS 키로 암호화됩니다. 바닥을 펼치면 이런 모양입니다.

![VPC 10.0.0.0/16 안에 AZ a와 AZ c 두 열이 있고 각 AZ에 공용 서브넷(ALB 노드, NAT 게이트웨이), 사설 앱 서브넷(보안 그룹으로 감싼 EC2), 사설 DB 서브넷(RDS 주 인스턴스와 대기 인스턴스)이 세 줄로 놓인 그림. 인터넷 게이트웨이는 위에, S3 게이트웨이 엔드포인트와 IAM 역할, KMS 키는 아래에 있다](/uploads/cert/saa-map/foundation.svg)

그림에서 읽어야 할 결정은 다섯 가지입니다.

1. **서브넷 세 줄**: ALB는 공용 서브넷, 앱 서버는 사설 서브넷, DB는 인터넷 경로가 아예 없는 격리 서브넷에 둡니다. 서브넷은 AZ를 넘지 못하니 AZ마다 같은 모양을 반복합니다.
2. **보안 그룹과 네트워크 ACL**: 앱 서버의 보안 그룹은 ALB의 보안 그룹에서 오는 트래픽만 허용합니다. 보안 그룹은 상태 저장이고 허용 규칙만 있습니다. 특정 IP를 차단하라는 문제가 나오면 네트워크 ACL이나 WAF입니다.
3. **NAT 게이트웨이**: 사설 서브넷의 앱 서버가 외부 결제사 API를 부르려면 NAT를 거칩니다. 영역 NAT 게이트웨이는 AZ 안에 만들어지니 AZ마다 하나씩 둡니다. 시간과 처리한 GB에 요금이 붙어서 비용 문제에도 나옵니다.
4. **게이트웨이 엔드포인트**: 앱 서버가 S3에 영수증을 쓸 때 NAT를 거치면 처리 요금이 붙습니다. S3와 DynamoDB는 추가 요금이 없는 게이트웨이 엔드포인트로 돌립니다.
5. **IAM 역할과 KMS**: 앱 서버에 액세스 키를 넣지 않고 인스턴스 프로파일로 역할을 붙입니다. 저장 암호화 키를 누가 통제하는지(AWS 관리형 키, 고객 관리형 키, CloudHSM)가 보안 영역에서 자주 갈립니다.

읽을 곳: [3편 3-1 서브넷 분리](/blog/cert/saa/saa-01-secure-architectures#3-1-서브넷-분리), [3편 3-2 보안 그룹과 네트워크 ACL](/blog/cert/saa/saa-01-secure-architectures#3-2-보안-그룹과-네트워크-acl), [3편 3-3 NAT 게이트웨이](/blog/cert/saa/saa-01-secure-architectures#3-3-nat-게이트웨이), [3편 3-4 VPC 엔드포인트](/blog/cert/saa/saa-01-secure-architectures#3-4-vpc-엔드포인트), [3편 2-3 IAM 사용자, 그룹, 역할, 정책](/blog/cert/saa/saa-01-secure-architectures#2-3-iam-사용자-그룹-역할-정책), [3편 4-1 KMS 키의 세 종류](/blog/cert/saa/saa-01-secure-architectures#4-1-kms-키의-세-종류), [6편 6-2 NAT 게이트웨이 요금 구조](/blog/cert/saa/saa-04-cost-optimized-architectures#6-2-nat-게이트웨이-요금-구조)

## 5. 영역과 챕터 대응

지도는 요청이 지나가는 순서이고 시험 점수는 영역 단위로 나옵니다. 둘을 잇는 표입니다.

| 영역 | 비중 | 챕터 | 지도에서 주로 나오는 곳 |
|---|---|---|---|
| 1. 보안 | 30% | [3편](/blog/cert/saa/saa-01-secure-architectures) | 바닥(VPC, IAM, KMS), CloudFront OAC, ALB의 TLS와 WAF, S3 암호화 |
| 2. 복원력 | 26% | [4편](/blog/cert/saa/saa-02-resilient-architectures) | Route 53 장애 조치, ALB 상태 확인, Auto Scaling AZ 분산, RDS Multi-AZ, SQS |
| 3. 성능 | 24% | [5편](/blog/cert/saa/saa-03-high-performing-architectures) | CloudFront 캐시, ElastiCache, 읽기 복제본, 확장 정책, 데이터 갈래 |
| 4. 비용 | 20% | [6편](/blog/cert/saa/saa-04-cost-optimized-architectures) | 구매 옵션, S3 저장 클래스, NAT와 엔드포인트, Aurora Serverless |

문제를 읽을 때는 이 표를 거꾸로 씁니다. 마지막 문장의 조건이 영역을 알려 주고 영역이 지도 위의 층을 좁혀 줍니다.

![보안 30%, 복원력 26%, 성능 24%, 비용 20% 네 열에 각각 대표 조건 문구 세 개("최소 권한, 다른 계정", "AZ 하나가 멈춰도", "읽기가 한 DB에 몰린다", "가장 비용 효율적으로" 등)가 있고 아래로 3편부터 6편까지 이어지는 그림](/uploads/cert/saa-map/condition-to-chapter.svg)

조건이 둘이면 둘 다 만족하는 보기만 남깁니다. "AZ 하나가 멈춰도"와 "가장 비용 효율적으로"가 같이 나오면 다중 리전 액티브/액티브는 요구를 넘는 비용이라 빠지고 Multi-AZ가 남습니다. 자주 비교되는 서비스 쌍은 [1편 4-2](/blog/cert/saa/saa-00-exam-and-study-plan#4-2-자주-비교되는-서비스공식-문서-기준)에 표로 모아 두었습니다.

## 6. 추천 읽기 순서

1. **이 글을 먼저 훑습니다.** 서비스 이름을 다 몰라도 됩니다. 3절의 층이 여덟 개(그림에는 데이터 갈래인 3-8을 뺀 일곱 개)이고 바닥이 하나라는 것만 잡습니다.
2. **3편을 먼저 읽습니다.** 바닥(VPC, IAM, KMS)을 모르면 위층 문제의 보기 절반이 무슨 말인지 안 들어옵니다. 비중도 가장 큽니다.
3. **4, 5, 6편 순서로 읽습니다.** 읽다가 서비스 하나가 지도 어디에 있는지 헷갈리면 2절 그림으로 돌아옵니다.
4. **다시 이 글로 돌아옵니다.** 3절의 층마다 "여기서 무엇을 고르는지"를 링크를 누르지 않고 말로 설명해 봅니다. 막히는 층이 다시 읽을 절입니다.
5. **손으로 만들어 봅니다.** [7편 4-4](/blog/cert/saa/saa-05-resources-and-exam-day#4-4-쇼핑몰-예제로-묶은-실습-순서)의 실습 순서가 이 지도의 바닥, ALB와 Auto Scaling, SNS와 SQS, S3를 그대로 따라갑니다. 끝나면 만든 순서의 반대로 지웁니다.

## 7. 이 지도에 없는 것

- **여러 리전과 재해 복구**: 지도는 한 리전 안의 모양입니다. 백업과 복원부터 다중 사이트 액티브/액티브까지 네 가지 DR 전략과 Aurora Global Database, S3 복제는 [4편 3-6](/blog/cert/saa/saa-02-resilient-architectures#3-6-재해-복구-전략과-rpo-rto) 이후에 있습니다.
- **여러 계정**: Organizations, SCP, Control Tower는 [3편 2-8](/blog/cert/saa/saa-01-secure-architectures#2-8-여러-계정-보안-organizations-scp-rcp-control-tower)에 있습니다.
- **서버리스로 바꾼 모양**: ALB와 Auto Scaling 그룹 자리를 API Gateway와 Lambda로 바꾸는 구성은 [4편 2-7](/blog/cert/saa/saa-02-resilient-architectures#2-7-api-생성과-관리-api-gateway)과 [2-8](/blog/cert/saa/saa-02-resilient-architectures#2-8-서버리스-lambda와-fargate)에 있습니다.
- **하이브리드 연결**: 온프레미스 데이터 센터와 잇는 VPN, Direct Connect, Storage Gateway는 지도 밖에 두었습니다.

지도는 시험 범위를 다 덮지 않습니다. 범위 전체는 [1편 2절](/blog/cert/saa/saa-00-exam-and-study-plan#2-영역과-과제)의 과제 목록이 기준입니다.

## 참고 자료

- [AWS Certified Solutions Architect - Associate (SAA-C03) 시험 안내서](https://docs.aws.amazon.com/aws-certification/latest/solutions-architect-associate-03/solutions-architect-associate-03.html)
- [Route 53 개발자 안내서: 별칭 레코드와 비별칭 레코드 중 선택](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resource-record-sets-choosing-alias-non-alias.html)
- [AWS Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html)
- 그림 세 장(`request-path.svg`, `foundation.svg`, `condition-to-chapter.svg`)은 이 글을 위해 직접 그렸습니다.

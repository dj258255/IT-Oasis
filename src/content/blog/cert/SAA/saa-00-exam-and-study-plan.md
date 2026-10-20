---
title: '[SAA Ch-00] AWS SAA 시험 구조와 공부 계획: 서비스를 외우기 전에 비교하는 법부터'
description: AWS Certified Solutions Architect Associate(SAA-C03)는 130분 동안 65문항을 푸는 시나리오형 객관식 시험이고 1,000점 만점에 720점이면 합격입니다. 공식 시험 안내서의 영역별 과제와 서비스 범위, Well-Architected Framework와의 관계, 공식 샘플 문항이 보여 주는 출제 방식, 자주 비교되는 서비스의 공식 문서 기준 차이, 응시자 후기에서 공통으로 나온 공부법을 정리하고 데이터 엔지니어 관점의 공부 계획을 세웁니다.
date: 2026-10-19T00:00:00.000Z
tags:
  - AWS
  - SAA
  - Certification
  - Study Plan
  - Well-Architected
category: cert/SAA
topics:
  - cert
draft: false
series: "SAA 공부"
seriesOrder: 0
---

## 결론부터

1. SAA-C03은 65문항(채점 50, 비채점 15)을 130분에 푸는 객관식 시험이고 100~1,000점 척도에서 720점이면 합격입니다. 영역별 기준은 없고 전체 점수만 봅니다. 한국어로 응시할 수 있습니다.
2. 문제는 대부분 "가장 비용 효율적인", "운영 부담이 가장 적은" 같은 조건이 붙은 시나리오입니다. 공식 샘플 문항에서도 가장 싼 선택지(Spot 인스턴스)가 조건(중단 불가) 때문에 오답이었습니다. 서비스 이름을 외우는 것보다 비슷한 서비스끼리의 차이를 아는 것이 점수를 가릅니다.
3. 영역은 보안 30%, 복원력 26%, 성능 24%, 비용 20%입니다. 영역 이름이 Well-Architected Framework의 기둥 이름과 겹치니 그 문서가 시험의 관점을 정리해 줍니다.
4. 데이터 엔지니어링 서비스(S3, Kinesis, Firehose, Glue, Athena, EMR, Lake Formation, MSK)는 범위 안이고 과제 하나가 데이터 수집과 변환입니다. Airflow 관리형(MWAA)은 범위 밖입니다.
5. 후기 중에는 유출 문항(덤프)으로 공부했다는 글이 꽤 있습니다. AWS는 의도치 않게 접근한 것도 규정 위반이고 자격을 나중에 무효화할 수 있다고 공지했습니다. 이 계획은 공식 자료와 정식 모의고사만 씁니다.

---

## 1. 시험 구조

AWS 공식 시험 페이지와 시험 안내서(SAA-C03, Version 1.1)로 확인한 내용입니다(2026년 10월 기준).

| 항목 | 내용 |
|---|---|
| 문항 | 65문항(점수에 들어가는 50문항 + 들어가지 않는 15문항). 어느 것이 비채점인지는 알 수 없다 |
| 유형 | 객관식(정답 1, 오답 3), 복수 응답(보기 5개 이상 중 정답 2개 이상) |
| 시간 | 130분 |
| 합격 | 100~1,000점 척도에서 720점. 보상형 채점이라 영역별 기준은 없다 |
| 감점 | 답하지 않은 문항은 오답, 틀려도 감점은 없다. 모든 문항에 답한다 |
| 가격 | 150 USD |
| 언어 | 한국어 포함 |
| 응시 | Pearson VUE 시험장 또는 온라인 |
| 유효 기간 | 3년 |
| 권장 경험 | AWS로 클라우드 솔루션을 설계한 실무 1년 이상 |

영어로 응시하는 비원어민은 ESL +30분을 신청할 수 있습니다. 시험을 등록하기 전에 계정의 응시 편의 요청에서 한 번 신청하면 이후 등록에 모두 적용됩니다. 한국어로 응시하면 해당하지 않습니다. 대만의 응시자(De-Wei Ye, 2026)는 이 신청을 잊어 시험을 취소하고 다시 예약했다고 적었습니다.

새 버전(SAA-C04)이 나온다는 글이 몇 곳 있지만 AWS 공식 시험 페이지와 "Coming soon" 페이지에는 없습니다(2026년 10월 확인).

## 2. 영역과 과제

### 2-1. 영역별 과제(Task Statement)

| 영역 | 비중 | 과제 |
|---|---|---|
| 1. 보안 아키텍처 설계 | 30% | 1.1 AWS 리소스에 대한 안전한 접근 / 1.2 안전한 워크로드와 애플리케이션 / 1.3 데이터 보안 통제 |
| 2. 복원력 있는 아키텍처 설계 | 26% | 2.1 확장 가능하고 느슨하게 결합된 아키텍처 / 2.2 고가용성 또는 내결함성 아키텍처 |
| 3. 고성능 아키텍처 설계 | 24% | 3.1 스토리지 / 3.2 컴퓨팅 / 3.3 데이터베이스 / 3.4 네트워크 / 3.5 데이터 수집과 변환 |
| 4. 비용 최적화 아키텍처 설계 | 20% | 4.1 스토리지 / 4.2 컴퓨팅 / 4.3 데이터베이스 / 4.4 네트워크 |

영역 3과 4는 같은 네 축(스토리지, 컴퓨팅, DB, 네트워크)을 성능과 비용 두 관점으로 다시 묻습니다. 서비스 하나를 공부할 때 "빠르게 하려면"과 "싸게 하려면"을 같이 정리하는 게 효율적입니다.

### 2-2. 범위 안과 밖의 서비스

시험 안내서 부록에는 범위 안 서비스가 16개 범주로 나와 있고 AWS는 이 목록이 완전하지 않으며 바뀔 수 있다고 적습니다.

| 범주(일부) | 범위 안 서비스 |
|---|---|
| Analytics | Athena, Data Exchange, Data Firehose, EMR, Glue, Kinesis, Lake Formation, MSK, OpenSearch Service, Redshift 등 |
| Application Integration | SQS, SNS, EventBridge, Step Functions |
| Database | Aurora, Aurora Serverless, DynamoDB, ElastiCache, RDS |
| Networking | CloudFront, Direct Connect, ELB, Global Accelerator, PrivateLink, Route 53, Transit Gateway, VPC |
| Security | KMS, CloudHSM, WAF, Shield, GuardDuty, Macie, IAM Identity Center, Inspector, Network Firewall, Firewall Manager, RAM, Artifact 등 |
| Storage | S3, S3 Glacier, EBS, EFS, FSx, Storage Gateway, Backup |
| Management and Governance | CloudTrail, CloudWatch, Config, Control Tower, Organizations, Compute Optimizer, Trusted Advisor, Well-Architected Tool 등 |
| Migration and Transfer | Application Migration Service, DataSync, DMS, Snow Family, Transfer Family |

2026년 10월 20일에 다시 연 목록에는 AWS Elastic Disaster Recovery가 없고 Application Migration Service는 있습니다. 둘 다 블록 수준 복제를 쓰는 서비스라 보기에 함께 나올 수 있어 [Ch-02](/blog/cert/saa/saa-02-resilient-architectures) 3-12절에 짧게 정리했습니다.

범위 밖 예시로는 MWAA(관리형 Airflow), Lightsail, CDK, CodeBuild, CodeDeploy, IoT 전체 등이 나옵니다. 시험에서는 짧은 공식 이름(예: Amazon SNS)으로 표기하고 시험 중 도움말에서 정식 명칭과의 대응표를 볼 수 있습니다.

## 3. Well-Architected Framework와의 관계

시험 안내서는 이 시험이 AWS Well-Architected Framework에 기반한 설계 능력을 검증한다고 적습니다. 프레임워크의 여섯 기둥 정의(2024년 11월판)입니다.

| 기둥 | 정의 요지 | 시험 영역 |
|---|---|---|
| 운영 우수성 | 워크로드를 효과적으로 운영하고 프로세스를 개선하는 능력 | 독립 영역 없음 |
| 보안 | 데이터, 시스템, 자산을 보호하는 방법 | 1. 보안 |
| 안정성 | 기대되는 시점에 의도한 기능을 올바르고 일관되게 수행하는 능력 | 2. 복원력 |
| 성능 효율성 | 자원을 효율적으로 써서 요구를 충족하고 수요가 변해도 유지하는 능력 | 3. 고성능 |
| 비용 최적화 | 가장 낮은 가격으로 비즈니스 가치를 제공하는 능력 | 4. 비용 |
| 지속 가능성 | 에너지 소비를 줄여 영향을 개선하는 능력 | 독립 영역 없음 |

오른쪽 열의 대응은 AWS가 적은 것이 아니고 이름을 나란히 놓고 짝지은 것입니다. 프레임워크 문서에는 시험의 정답을 고를 때 도움이 되는 문장이 있습니다. 기둥 사이에는 맞바꾸는 관계가 있지만 보안과 운영 우수성은 대체로 다른 기둥과 맞바꾸지 않는다는 것입니다. 보기 중 비용은 싸지만 보안을 약하게 만드는 선택지는 대체로 오답이라고 읽을 수 있습니다.

프레임워크로 실제 워크로드를 점검하는 도구가 Well-Architected Tool이고 범위 안 서비스입니다. 제품 페이지는 콘솔에서 워크로드를 프레임워크 기준으로 평가하고 렌즈(lens)로 분야별 질문을 더하며 마일스톤으로 시점별 상태를 저장하고 개선 계획을 준다고 설명합니다. "아키텍처를 모범 사례에 비춰 검토하고 위험 항목을 추적"이 이 도구의 문구입니다. 요금은 이번에 연 제품 페이지에 적혀 있지 않았습니다.

## 4. 문제는 조건으로 갈린다

### 4-1. 공식 샘플 문항

AWS가 공개한 SAA-C03 샘플 문항 10개에서 출제 방식을 보면 이렇습니다.

| 문항 | 조건 | 정답과 이유 |
|---|---|---|
| Q6 | 가장 비용 효율적으로, 중단할 수 없는 작업 | On-Demand. 해설은 Spot이 가장 싸지만 중단 불가·시간 제한 작업에는 맞지 않는다고 적는다 |
| Q7 | 가장 효율적으로, 중단 없이 | 투표가 DB에 몰리는 상황을 SQS로 분리 |
| Q10 | Aurora의 읽기 부하 분리 | Aurora Replica를 추가하고 읽기 엔드포인트를 쓴다. "Multi-AZ 대기 인스턴스에서 읽기"는 오답 |
| Q5 | 암호화 키를 온프레미스에 둬야 함 | 고객 제공 키 서버 측 암호화(SSE-C)나 클라이언트 측 암호화 |

Ryan Pothecary의 글(2023)도 "가장 비용 효율적인", "운영 부담이 가장 적은", "가장 효율적인" 같은 문구가 정답 방향을 가리킨다고 설명합니다. 같은 글은 범위 안 서비스가 SAA-C02의 39개에서 SAA-C03의 131개로 늘었다고 적었습니다.

### 4-2. 자주 비교되는 서비스(공식 문서 기준)

공부하면서 표로 계속 늘려 갈 목록이고 처음 몇 개만 공식 문서로 정리했습니다.

**SNS와 SQS, Kinesis, MSK**

| | SNS | SQS | Kinesis Data Streams | MSK |
|---|---|---|---|---|
| 방식 | 구독자에게 밀어 넣기(push) | 소비자가 가져가기(poll) | 샤드에서 읽기 | Kafka |
| 순서 | | 표준 큐는 보장하지 않음 | 샤드 안 순서(같은 파티션 키는 같은 샤드) | 파티션 안 순서(DE Ch-11) |
| 다시 읽기 | 안 됨 | 처리 후 삭제 | 여러 앱이 같은 스트림을 읽고 재처리 가능. 보존 기본 24시간, 최대 365일 | 보존 기간 동안 가능 |
| 확장 | | 프로비저닝 없이 확장 | 샤드를 미리 정한다 | 브로커를 정한다 |

SNS 문서는 SNS와 SQS를 함께 쓰는 팬아웃을 설명합니다. 즉시 알림을 받으면서 메시지는 큐에 남겨 나중에 처리합니다. Kinesis FAQ는 스트리밍을 처음 한다면 Kinesis Data Streams를, 이미 Kafka 애플리케이션이 있다면 MSK를 권합니다.

**S3 스토리지 클래스**

| 클래스 | 가용성 | AZ | 최소 보관 | 비고 |
|---|---|---|---|---|
| Standard | 99.99% | 3개 이상 | 없음 | |
| Standard-IA | 99.9% | 3개 이상 | 30일 | 꺼낼 때 요금, 최소 과금 크기 128KB |
| One Zone-IA | 99.5% | 1개 | 30일 | 꺼낼 때 요금, 최소 과금 크기 128KB. AZ를 잃으면 데이터도 잃는다 |
| Intelligent-Tiering | 99.9% | 3개 이상 | 없음 | 객체당 모니터링 요금, 꺼낼 때 요금 없음. 128KB 미만 객체는 모니터링하지 않음 |
| Express One Zone | 99.95% | 1개(직접 고름) | 없음 | 디렉터리 버킷, 한 자리 밀리초 지연 |
| Glacier Instant Retrieval | 99.9% | 3개 이상 | 90일 | 밀리초 접근, 꺼낼 때 요금, 최소 과금 크기 128KB |
| Glacier Flexible Retrieval | 99.99%(복원 후) | 3개 이상 | 90일 | 분~시간, 복원 필요. 객체마다 메타데이터 40KB 추가 과금 |
| Glacier Deep Archive | 99.99%(복원 후) | 3개 이상 | 180일 | 시간 단위, 복원 필요. 객체마다 메타데이터 40KB 추가 과금 |

S3 사용자 가이드의 스토리지 클래스 비교표(2026년 10월 20일 확인) 기준입니다. 내구성은 모두 99.999999999%로 같습니다. 클래스 사이의 차이는 가용성, AZ 수, 꺼내는 시간과 요금, 최소 보관 기간입니다. 문서는 One Zone-IA와 Express One Zone을 뺀 모든 클래스가 AZ 하나의 물리적 손실을 견디도록 설계됐다고 적습니다.

**RDS Multi-AZ와 읽기 복제본, Aurora**

| | 목적 | 복제 | 읽기 |
|---|---|---|---|
| RDS Multi-AZ(인스턴스) | 장애 조치 | 대기 인스턴스와 동기 | 대기 인스턴스는 읽기를 처리하지 않는다. 장애 조치는 보통 60~120초(사용자 가이드) |
| RDS Multi-AZ(DB 클러스터, MySQL·PostgreSQL) | 장애 조치 + 읽기 | 읽을 수 있는 대기 2개 | 장애 조치는 보통 35초 미만 |
| RDS 읽기 복제본 | 읽기 확장, 다른 리전 DR | 비동기 | 읽기 전용. 원본당 기본 할당량 15개. 독립 인스턴스로 승격할 수 있다 |
| Aurora 복제본 | 읽기 확장 + 장애 조치 | 같은 클러스터 볼륨을 공유(AZ 여러 곳의 저장 노드 6개) | 최대 15개, 장애 조치 대상. 복제본이 있으면 장애 조치는 보통 60초 미만 |

샘플 Q10의 오답 "Multi-AZ 대기 인스턴스에서 읽기"가 이 표의 첫 줄에서 나옵니다.

**ALB, NLB, Gateway Load Balancer**

| | ALB | NLB | GWLB |
|---|---|---|---|
| 계층 | L7(HTTP, HTTPS, gRPC) | L4(TCP, UDP, TLS) | L3 게이트웨이 |
| 고정 IP | 안 됨 | 됨 | 안 됨 |
| Lambda 대상 | 됨 | 안 됨 | 안 됨 |

AWS는 아주 높은 성능과 고정 IP가 필요하면 NLB를 권합니다.

**VPC 게이트웨이 엔드포인트**: S3와 DynamoDB만 지원하고 추가 요금이 없습니다. 라우팅 테이블에 경로를 추가하는 방식이고 다른 리전의 S3로 가는 트래픽은 이 엔드포인트를 타지 않습니다. 다른 서비스는 PrivateLink 기반 인터페이스 엔드포인트를 씁니다.

**KMS 키**: 고객 관리형 키는 월 요금과 사용 요금이 있고 회전과 키 정책을 직접 정합니다. AWS 관리형 키는 월 요금이 없고 매년 자동 회전되며 다른 계정과 공유할 수 없습니다.

## 5. 데이터 엔지니어 관점

시험 안내서의 과제 3.5(고성능 데이터 수집과 변환)가 데이터 엔지니어링 영역입니다. 지식 예시로 Athena, Lake Formation, DataSync, Storage Gateway, Glue, Kinesis를 들고 기술로 데이터 레이크 구축과 보안, 스트리밍 아키텍처 설계, 처리용 컴퓨팅 선택(EMR), 형식 변환(CSV를 Parquet으로)을 듭니다. 과제 4.3에는 컬럼 형식과 시계열 형식 같은 비용 효율적인 DB 유형이 나옵니다.

| 서비스 | 공식 문서에서 확인한 것 | 이 블로그에서 이어지는 글 |
|---|---|---|
| Data Firehose | JSON을 Parquet이나 ORC로 바꿔 S3에 쓴다. 스키마는 Glue Data Catalog에 있어야 하고 CSV는 Lambda로 먼저 JSON으로 바꾼다 | |
| Athena | 스캔한 데이터 1TB당 요금. 요금 페이지 예시에서 GZIP 압축과 Parquet을 쓰면 같은 쿼리 비용이 $15에서 $1.25가 된다 | DE Ch-18(컬럼 통계로 파일 거르기) |
| Lake Formation | IAM을 보완하는 권한 모델. 컬럼, 행, 셀 단위 통제를 Athena, Redshift Spectrum, EMR, Glue에 적용한다 | |
| MSK | 범위 안. 이미 Kafka를 쓰면 MSK | DE Ch-11~13 |
| MWAA | 범위 밖 | DE Ch-02~07 |

## 6. 응시자들의 후기에서 공통으로 나온 것

유출 문항을 썼다고 밝힌 후기는 빼고 공식 자료와 정식 강의, 모의고사로 준비한 후기만 모았습니다.

| 글 | 결과 | 준비 | 남긴 말 |
|---|---|---|---|
| Ryan Pothecary, DEV(2023) | 여러 번 응시한 경험 | | 비용, 운영 부담, 효율 같은 조건 문구가 정답 방향을 정한다. Lake Formation 같은 새 서비스는 가끔 나오고 용도만 알면 대부분 풀린다 |
| Pravesh Sudha, DEV(2025-08) | 800점, 약 25일(하루 2시간) | freeCodeCamp의 50시간 강의, Tutorials Dojo 요약 자료 | 전체 모의고사는 보지 않았다 |
| De-Wei Ye, dwye.dev(2026-01) | 823점, 약 4개월(주 10시간) | Udemy 강의와 모의고사 390문항, AWS 공식 연습 문항 20개. 모의고사 정답률 약 70~80% | 업무에서 쓰지 않는 데이터 파이프라인, 스트리밍, 분석 서비스를 따로 보충하라 |
| 伊藤 寛晃, SoftBank 블로그(2025-10) | 정답률 74%로 합격(필자 표기), 약 1.5개월(60~70시간) | Udemy 강의와 문제집 390문항. 문제집 정답률 52~61% | S3, ECS와 EKS, Lambda가 자주 나왔다. 실제 시험 일본어 문장이 기계 번역처럼 읽혔다 |
| Nishath J P, DEV(2025-10) | 863점, 1.5개월 이상 | Maarek 강의, Maarek, Bonso, Davis 모의고사 21회, 공식 연습 문항 | 실제 시험이 모의고사보다 쉬웠다. 문항당 1~2분, 바로 못 풀면 표시하고 넘긴다 |
| Hadomen, Zenn(2026-03) | 824점, 약 3주(100~120시간) | AWS 경험 없음. 일본어 교재, Udemy, 일본어 웹 문제집, 공식 샘플과 연습 문항 | 문제집에서 못 본 서비스가 나왔다. 약 30문항을 표시하고 다시 봤다 |
| Y.M, Mynavi 엔지니어 블로그(2026-04) | 773점, 약 4주 | 일본어 교재, Udemy 문제집, 노트로 만든 자체 문제 | 모의고사 41%에서 시작해 하루 전 74%. VPC 엔드포인트, 보안 그룹과 NACL, S3 클래스가 약점이었다 |
| IwatsukaYura, Zenn(2026-08) | 786점, 약 3주(약 40시간) | 일본어 웹 문제집, Udemy 문제집, 공식 연습 문항 | S3, VPC, Lambda, RDS와 DynamoDB가 많았다. 첫 회독 약 100분, 남은 시간에 표시한 15문항 검토 |

후기들이 주로 쓴 강의는 Udemy의 Stephane Maarek, Adrian Cantrill, Tutorials Dojo 모의고사였습니다. 이 셋을 비교한 공식 자료는 없으니 하나를 골라 끝까지 듣는 것이 낫다고 판단했습니다.

AWS 공식 준비 경로는 Skill Builder의 4단계입니다. 공식 연습 문항(Official Practice Question Set)으로 시작해 실습(Builder Labs, Cloud Quest, Jam)과 복습을 거쳐 공식 모의고사(Official Practice Exam)로 준비 상태를 확인합니다.

### 6-1. 덤프에 대한 AWS의 공지

AWS 시험 보안팀은 2025년 6월 글 "Protecting AWS Certification value through security measures"에서 실제 시험 문항이 담긴 덤프를 의도치 않게 접근한 것도 AWS 자격 프로그램 약관 위반이라고 적었습니다. 제재는 경고부터 프로그램 정지까지 있고 데이터 분석으로 이상 패턴이 확인되면 자격증을 발급한 뒤에도 결과를 무효화할 수 있다고 합니다. 국내와 중국 후기 여럿이 "덤프 몇백 문항을 반복했다", "실제 시험과 대부분 같았다"고 적습니다. 같은 방법을 따르면 이 위험을 지게 됩니다.

## 7. 내 공부 계획

| 단계 | 할 일 | 끝났다고 보는 기준 |
|---|---|---|
| 1. 기준 잡기 | 공식 시험 안내서의 과제 목록(2-1절)과 범위 안 서비스를 읽고 공식 샘플 문항 10개를 풀어 지금 수준을 본다 | 틀린 문항마다 어느 과제에 해당하는지 적는다 |
| 2. 강의 | 강의 하나를 골라 끝까지 듣는다. 서비스마다 "무엇을 위해, 무엇과 비교해서" 노트를 이 시리즈에 올린다 | 4-2절 같은 비교표가 영역마다 있다 |
| 3. 손으로 해 보기 | 프리 티어로 VPC(공용·사설 서브넷, NAT, 게이트웨이 엔드포인트), S3 수명주기 규칙, SQS와 SNS 팬아웃, Firehose로 Parquet 쓰기와 Athena 쿼리를 만들어 본다. 끝나면 지운다 | 각각을 그림 없이 설명한다 |
| 4. 공식 연습 문항 | Skill Builder의 공식 연습 문항을 풀고 틀린 이유를 영역별로 분류한다 | 약한 영역이 정해진다 |
| 5. 모의고사 | 정식 모의고사로 시간을 재고 푼다. 문제의 마지막 문장(조건)을 먼저 읽는다 | 130분 안에 다 풀고 정답률이 꾸준히 합격선 위 |
| 6. 마무리 | 공식 모의고사(Official Practice Exam)로 준비 상태를 확인한다 | |

무료와 구독 자료의 구분, 연습 자료 비교, 프리 티어 실습 비용 관리, 시험 당일 전략과 D-30 마무리 계획은 [SAA Ch-05](/blog/cert/saa/saa-05-resources-and-exam-day)에 정리했습니다.

데이터 엔지니어링 시리즈를 이미 쓰고 있어서 과제 3.5는 상대적으로 익숙합니다. 반대로 후기에서 어렵다고 한 보안(VPC, IAM 정책, KMS)과 네트워크는 직접 만들어 보는 시간을 더 잡습니다.

## 8. 범위와 한계

- 시험 정보는 2026년 10월 19일 AWS 공식 페이지와 시험 안내서로 확인했습니다. 등록 전에 다시 확인합니다.
- 4-2절의 서비스 비교는 공식 문서 기준이지만 요금과 기본값은 바뀝니다. 처음 쓸 때 확인하지 못했던 읽기 복제본 개수와 Aurora 사본 수는 2026년 10월 20일 RDS 할당량 문서(원본당 읽기 복제본 15개, Oracle은 15개까지 되지만 5개 이하 권장)와 Aurora 고가용성 문서(저장 노드 6개)로 확인해 표에 넣었습니다.
- 3절의 기둥과 영역 대응은 AWS가 적은 것이 아닙니다.
- 이 글은 응시 전에 쓴 계획입니다. 응시한 뒤 결과와 바뀐 판단을 덧붙이겠습니다.

## 참고 자료

공식 자료
- AWS, [AWS Certified Solutions Architect - Associate](https://aws.amazon.com/certification/certified-solutions-architect-associate/)
- AWS, [SAA-C03 시험 안내서](https://docs.aws.amazon.com/aws-certification/latest/solutions-architect-associate-03/solutions-architect-associate-03.html)
- AWS, [SAA-C03 Sample Exam Questions](https://d1.awsstatic.com/training-and-certification/docs-sa-assoc/AWS-Certified-Solutions-Architect-Associate_Sample-Questions.pdf)
- AWS, [Before testing: 응시 편의(ESL +30분)](https://aws.amazon.com/certification/policies/before-testing/), [Coming soon](https://aws.amazon.com/certification/coming-soon/)
- AWS Training and Certification Blog, [Protecting AWS Certification value through security measures](https://aws.amazon.com/blogs/training-and-certification/protecting-aws-certification-value-through-security-measures/), 2025
- AWS, [Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html), [AWS Well-Architected Tool](https://aws.amazon.com/well-architected-tool/)
- AWS 문서: [SNS 팬아웃](https://docs.aws.amazon.com/sns/latest/dg/sns-sqs-as-subscriber.html), [Kinesis Data Streams FAQ](https://aws.amazon.com/kinesis/data-streams/faqs/), [S3 storage classes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/storage-class-intro.html), [RDS Multi-AZ](https://aws.amazon.com/rds/features/multi-az/), [ELB features](https://aws.amazon.com/elasticloadbalancing/features/), [Gateway endpoints](https://docs.aws.amazon.com/vpc/latest/privatelink/gateway-endpoints.html), [Athena pricing](https://aws.amazon.com/athena/pricing/)
- AWS 문서: [Quotas and constraints for Amazon RDS](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_Limits.html), [High availability for Amazon Aurora](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Concepts.AuroraHighAvailability.html), [In-Scope AWS Services (SAA-C03)](https://docs.aws.amazon.com/aws-certification/latest/solutions-architect-associate-03/saa-03-in-scope-services.html)

후기
- Ryan Pothecary, [Sitting the AWS Solution Architect Associate SAA-C03 exam 60 times](https://dev.to/ryanpothecary/sitting-the-aws-solution-architect-associate-saa-c03-exam-60-times-2e7p), 2023
- Pravesh Sudha, [My Journey to Passing the AWS Solutions Architect Associate Exam](https://dev.to/aws-builders/my-journey-to-passing-the-aws-solutions-architect-associate-exam-1588), 2025
- De-Wei Ye, [下班四個月考過 AWS Solution Architect Associate (SAA-C03) 心得](https://dwye.dev/post/saa-c03/), 2026
- 伊藤 寛晃, [クラウド経験半年の初心者がAWS認定ソリューションアーキテクト – アソシエイト（SAA）に挑戦してみた](https://www.softbank.jp/biz/blog/cloud-technology/articles/202510/aws-saa/), 2025
- Nishath J P, [How I Passed the AWS Solutions Architect Associate (SAA-C03) Exam with 863 Marks](https://dev.to/nishath_jp/how-i-passed-the-aws-solutions-architect-associate-saa-c03-exam-with-863-marks-102a), 2025
- Hadomen, [【合格体験記】AWS未経験からSAA-C03に約3週間で合格したので勉強方法などの共有](https://zenn.dev/hadomen/articles/e73abb020ccc15), 2026
- Y.M, [【AWS】SAA-C03 試験に何とか一発合格できた](https://engineerblog.mynavi.jp/technology/aws_saa_c03_pass/), 2026
- IwatsukaYura, [【3週間で合格】AWS SAA合格記](https://zenn.dev/iwatsukayura/articles/aws-saa-c03-passed), 2026

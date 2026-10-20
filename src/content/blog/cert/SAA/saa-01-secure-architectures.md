---
title: '[SAA Ch-01] 영역 1 보안 아키텍처 설계: 누가, 어디로, 무엇을 읽는지 세 겹으로 나눠 보기'
description: SAA-C03 영역 1(채점 비중 30%)을 공식 시험 안내서의 과제 1.1~1.3과 지식·기술 항목 순서대로 정리합니다. IAM 정책 평가 로직과 SCP, VPC 보안 그룹과 네트워크 ACL, NAT와 VPC 엔드포인트, WAF와 Shield, KMS와 S3 데이터 보호를 공식 문서의 기본값과 한도로 확인하고 시나리오의 어떤 단어가 어떤 서비스를 가리키는지 표로 묶었습니다.
date: 2026-10-19T00:00:00.000Z
tags:
  - AWS
  - SAA
  - Certification
  - IAM
  - VPC
  - KMS
  - Security
category: cert/SAA
topics:
  - cert
draft: false
series: "SAA 공부"
seriesOrder: 1
---

## 결론부터

1. 영역 1은 과제 세 개로 나뉩니다. 1.1은 사람과 워크로드가 AWS API를 부를 권한(IAM, 페더레이션, 여러 계정), 1.2는 네트워크와 애플리케이션 경계(VPC, WAF, Shield, Cognito, Secrets Manager), 1.3은 데이터 자체(KMS, 암호화, 백업, 보존)입니다. 시나리오를 읽을 때 "누가 접근하는지", "어느 경로로 들어오는지", "무엇을 보호하는지" 중 무엇을 묻는지부터 가르면 보기를 걸러 내기 쉬워집니다.
2. IAM 정책 평가는 명시적 거부가 항상 이깁니다. 같은 계정 안에서는 자격 증명 기반 정책과 리소스 기반 정책 중 하나만 허용해도 되지만 다른 계정의 리소스에 접근하면 양쪽 계정에서 모두 허용해야 합니다. SCP와 권한 경계는 권한을 주지 않고 상한만 정합니다.
3. 보안 그룹은 인스턴스(네트워크 인터페이스) 단위의 상태 저장 방화벽이고 허용 규칙만 있습니다. 네트워크 ACL은 서브넷 단위의 상태 비저장 필터이고 거부 규칙이 있으며 번호 순서대로 평가합니다. "특정 IP를 차단"이 나오면 네트워크 ACL이나 WAF입니다.
4. 사설 서브넷에서 S3나 DynamoDB로 가는 트래픽은 게이트웨이 엔드포인트(추가 요금 없음)로 NAT를 우회하게 만들 수 있습니다. 다른 서비스는 PrivateLink 기반 인터페이스 엔드포인트를 씁니다.
5. 데이터 보호에서 시험이 자주 가르는 지점은 키를 누가 통제하는지입니다. AWS 소유 키, AWS 관리형 키, 고객 관리형 키, CloudHSM 순서로 통제권과 운영 부담이 함께 커집니다. 삭제를 막아야 하면 S3 Object Lock 규정 준수 모드나 AWS Backup Vault Lock이 답에 가깝습니다.
6. 2026년 10월에 확인한 문서에는 시험 안내서가 나온 뒤 바뀐 것이 몇 가지 있습니다. 새 S3 범용 버킷은 2026년 4월부터 SSE-C가 꺼진 상태로 만들어지고 영역 단위로 확장되는 리전 NAT 게이트웨이가 생겼습니다. 시험 문항이 이 변화를 반영하는지는 알 수 없어서 본문에 따로 표시했습니다.

---

## 1. 공식 안내서의 목차

시험 안내서의 영역 1 페이지는 과제마다 "지식(Knowledge of)"과 "기술(Skills in)"을 나열합니다. 이 글의 절 번호를 그 목록에 맞춰 붙였습니다.

| 과제 | 안내서의 지식 항목 | 안내서의 기술 항목 | 이 글 |
|---|---|---|---|
| 1.1 안전한 접근 | 여러 계정의 접근 통제, 페더레이션과 자격 증명 서비스(IAM, IAM Identity Center), 글로벌 인프라, 최소 권한, 공동 책임 모델 | IAM 사용자와 루트 사용자 보호(MFA), 사용자·그룹·역할·정책 설계, 역할 기반 접근(STS, 역할 전환, 교차 계정), 여러 계정 전략(Control Tower, SCP), 리소스 정책, 디렉터리 페더레이션 | 2절 |
| 1.2 안전한 워크로드 | 애플리케이션 설정과 자격 증명 보안, 서비스 엔드포인트, 포트·프로토콜·트래픽 통제, 보안 서비스(Cognito, GuardDuty, Macie), 외부 위협(DDoS, SQL 주입) | 보안 그룹·라우팅 테이블·네트워크 ACL·NAT 게이트웨이 설계, 공용·사설 서브넷 분리, Shield·WAF·IAM Identity Center·Secrets Manager 통합, VPN·Direct Connect 외부 연결 | 3절 |
| 1.3 데이터 보안 통제 | 데이터 접근과 거버넌스, 데이터 복구, 보존과 분류, 암호화와 키 관리 | 규정 준수, 저장 시 암호화(KMS), 전송 중 암호화(ACM, TLS), 키 접근 정책, 백업과 복제, 접근·수명 주기·보호 정책, 키 회전과 인증서 갱신 | 4절 |

## 2. 과제 1.1 AWS 리소스에 대한 안전한 접근

### 2-1. 공동 책임 모델

AWS는 공동 책임 모델을 "클라우드의 보안"과 "클라우드 안의 보안"으로 나눕니다. AWS는 모든 서비스를 실행하는 인프라를 보호하고 고객의 책임 범위는 고객이 고른 서비스에 따라 정해집니다.

| 서비스 유형 | AWS가 맡는 것 | 고객이 맡는 것 |
|---|---|---|
| EC2 같은 IaaS | 물리 인프라, 하이퍼바이저 | 게스트 OS 패치, 설치한 소프트웨어, 보안 그룹 설정 |
| S3, DynamoDB 같은 추상화된 서비스 | 인프라, OS, 플랫폼 | 데이터, 암호화 옵션 선택, 자산 분류, IAM 권한 |

시험에서는 "OS 패치를 누가 하는지"를 묻는 형태로 나옵니다. EC2 위에 직접 설치한 데이터베이스는 고객이 패치하고 RDS는 AWS가 엔진 패치를 맡는다는 차이로 보기를 거릅니다.

### 2-2. 루트 사용자와 MFA

루트 사용자는 계정을 만들 때 쓴 이메일과 비밀번호로 로그인하는 신원이고 모든 서비스와 리소스에 완전한 접근 권한을 가집니다. IAM 문서는 루트 사용자를 루트만 할 수 있는 작업에만 쓰라고 권합니다. 루트 사용자의 MFA는 기본으로 강제되지만 계정을 만들 때나 로그인 중 안내가 나올 때 고객이 MFA 장치를 등록해야 합니다.

루트 자격 증명이 있어야 하는 작업은 문서에 목록으로 나와 있습니다. 시험 대비로 기억할 만한 것만 추렸습니다.

| 분류 | 루트만 할 수 있는 작업 |
|---|---|
| 계정 | Organizations에 속하지 않은 단독 계정의 이메일·루트 비밀번호 변경, 단독 계정 해지와 재개, 유일한 관리자가 자기 권한을 지웠을 때 복구 |
| 결제 | Billing 콘솔에 IAM 접근 활성화 |
| S3 | 버킷에 MFA Delete 설정, 모든 주체를 거부하는 잘못된 버킷 정책 수정이나 삭제 |
| SQS | 모든 주체를 거부하는 큐 정책 수정이나 삭제 |
| EC2 | 예약 인스턴스 마켓플레이스 판매자 등록 |

Organizations를 쓰면 멤버 계정의 루트 자격 증명을 중앙에서 지울 수 있습니다. 문서는 이 기능을 켠 뒤 새로 만든 멤버 계정에는 루트 자격 증명이 기본으로 없고 잘못된 버킷 정책 해제 같은 특권 작업은 관리 계정이나 위임된 관리자가 대신 수행한다고 적습니다.

IAM 모범 사례 문서가 MFA에 대해 정한 기준은 세 가지입니다. 사람과 워크로드는 역할을 통한 임시 자격 증명을 씁니다. 그래도 IAM 사용자나 루트 사용자가 필요하면 MFA를 요구합니다. MFA는 가능하면 패스키나 보안 키 같은 피싱 저항형을 쓰라고 합니다.

### 2-3. IAM 사용자, 그룹, 역할, 정책

| 구성 요소 | 무엇인지 | 언제 쓰는지 |
|---|---|---|
| IAM 사용자 | 장기 자격 증명(비밀번호, 액세스 키)을 가진 신원 | 역할을 쓸 수 없는 워크로드나 IAM Identity Center를 지원하지 않는 서드파티 도구처럼 문서가 예외로 든 경우 |
| 그룹 | 사용자 묶음. 정책을 붙이는 단위 | 같은 권한을 여러 사용자에게 줄 때 |
| 역할 | 장기 자격 증명이 없고 맡을 때마다 임시 자격 증명을 받는 신원 | EC2, Lambda 같은 워크로드, 페더레이션 사용자, 다른 계정 사용자 |
| 자격 증명 기반 정책 | 사용자, 그룹, 역할에 붙는 정책 | 이 신원이 무엇을 할 수 있는지 |
| 리소스 기반 정책 | S3 버킷, SQS 큐, KMS 키 같은 리소스에 붙는 정책 | 누가 이 리소스에 접근할 수 있는지. 다른 계정 주체를 지정할 수 있다 |
| 권한 경계 | 자격 증명 기반 정책이 줄 수 있는 최대 권한 | 개발자에게 역할 생성 권한을 위임하면서 상한을 걸 때 |

모범 사례 문서는 AWS 관리형 정책으로 시작해 고객 관리형 정책으로 좁혀 가라고 권합니다. AWS 관리형 정책은 모든 고객이 쓰도록 만든 것이라 특정 사용 사례의 최소 권한과 맞지 않을 수 있다는 이유입니다. IAM Access Analyzer는 CloudTrail에 기록된 접근 활동으로 최소 권한 정책을 만들어 주고 공개 접근이나 교차 계정 접근을 허용하는 리소스를 찾아 결과(finding)로 보여 줍니다.

예를 들어 쇼핑몰의 주문 처리 Lambda가 주문 테이블만 써야 한다면 함수의 실행 역할에 `dynamodb:PutItem`을 주문 테이블 ARN으로 한정해 붙이고 액세스 키를 코드에 넣지 않습니다. 시험 보기 중 "IAM 사용자의 액세스 키를 환경 변수에 저장"은 대부분 오답입니다.

### 2-4. 정책 평가 로직

요청이 들어오면 AWS는 인증, 요청 컨텍스트 처리, 정책 평가 순서로 허용 여부를 정합니다. 문서가 정책 유형의 조합마다 적은 결과를 한 표로 모았습니다.

| 조합 | 결과 | 명시적 거부 |
|---|---|---|
| 자격 증명 기반 + 리소스 기반(같은 계정) | 합집합. 어느 한쪽만 허용해도 허용 | 어느 쪽에 있든 허용을 이긴다 |
| 자격 증명 기반 + 권한 경계 | 교집합. 둘 다 허용해야 허용 | 어느 쪽에 있든 이긴다 |
| 자격 증명 기반 + SCP + RCP(Organizations 멤버, 리소스 정책 없음) | 교집합. 셋 다 허용해야 허용 | 어느 쪽에 있든 이긴다 |
| 교차 계정 요청 | 신뢰받는 계정(요청자)과 신뢰하는 계정(리소스) 두 번 평가해서 둘 다 허용해야 허용 | 한쪽에서라도 거부되면 거부 |

아무 정책도 허용하지 않으면 기본은 거부(암묵적 거부)입니다. 시험에서 자주 보이는 함정은 "관리자 정책(`*:*`)을 붙였는데도 실패한다"는 시나리오입니다. 그 계정이 Organizations 멤버이고 상위 OU의 SCP가 막고 있으면 관리자 정책도 효과가 없습니다.

문서의 교차 계정 예시가 이 구조를 잘 보여 줍니다. 계정 A의 역할에 "로그 버킷은 모두 거부"라는 명시적 거부가 있으면 계정 B의 버킷 정책이 허용하더라도 계정 A 평가에서 거부되어 최종 결과는 거부입니다.

### 2-5. 역할 전환, STS, 교차 계정 접근

역할을 맡는 방법마다 세션 길이가 다릅니다. 문서의 표를 그대로 옮겼습니다(2026년 10월 확인).

| 방법 | 누가 맡는지 | 최소 / 최대 / 기본 |
|---|---|---|
| 콘솔 역할 전환 | 사용자나 역할 | 15분 / 역할의 최대 세션 설정 / 1시간 |
| `AssumeRole` API | 사용자나 역할 | 15분 / 역할의 최대 세션 설정 / 1시간 |
| `AssumeRoleWithSAML` | SAML로 인증한 사용자 | 15분 / 역할의 최대 세션 설정 / 1시간 |
| `AssumeRoleWithWebIdentity` | OIDC로 인증한 사용자 | 15분 / 역할의 최대 세션 설정 / 1시간 |

역할의 최대 세션 설정은 1시간에서 12시간 사이입니다. 한 역할의 자격 증명으로 다른 역할을 맡는 역할 체이닝은 세션이 1시간으로 제한됩니다. EC2 인스턴스 프로필로 받은 자격 증명은 이 최대 세션 설정의 적용을 받지 않습니다.

교차 계정 접근을 만드는 방법은 두 가지입니다.

| 방법 | 구성 | 특징 |
|---|---|---|
| 역할 위임 | 리소스 계정에 역할을 만들고 신뢰 정책에 상대 계정을 주체로 적는다. 상대 계정 사용자에게 `sts:AssumeRole` 권한을 준다 | 역할을 맡는 동안 원래 권한은 쓰지 않는다. 그 계정의 여러 리소스에 접근할 수 있다 |
| 리소스 기반 정책 | S3 버킷 정책, KMS 키 정책 등에 상대 계정 주체를 적는다 | 요청자가 자기 권한을 유지한 채 접근한다. 리소스 정책을 지원하는 서비스에서만 가능 |

게시판 서비스의 운영 계정에 있는 첨부 파일 버킷을 분석 계정에서 읽어야 하는 경우를 생각해 보면 둘 다 가능합니다. 버킷 하나만 읽으면 버킷 정책에 분석 계정의 역할 ARN을 적는 쪽이 단순합니다. 운영 계정의 여러 서비스를 다뤄야 하면 운영 계정에 읽기 전용 역할을 만들고 분석 계정이 그 역할을 맡게 합니다.

### 2-6. 리소스 기반 정책을 쓰는 자리

안내서 기술 항목에 "AWS 서비스의 리소스 정책을 언제 쓸지"가 있습니다. 정리하면 리소스 쪽에서 접근 주체를 정해야 하는 경우입니다.

| 리소스 정책 | 주로 쓰는 상황 |
|---|---|
| S3 버킷 정책 | 다른 계정 접근, 특정 VPC 엔드포인트에서만 접근(`aws:SourceVpce`), HTTPS 강제(`aws:SecureTransport`) |
| KMS 키 정책 | 모든 KMS 키에 반드시 하나 있다. 4-2절 |
| SQS 큐 정책 | SNS 토픽이나 S3 이벤트가 큐에 메시지를 넣도록 허용 |
| Lambda 리소스 정책 | API Gateway, S3, EventBridge가 함수를 호출하도록 허용 |
| IAM 역할 신뢰 정책 | 누가 이 역할을 맡을 수 있는지 |
| VPC 엔드포인트 정책 | 엔드포인트를 통해 어떤 주체가 어떤 리소스에 접근할지. 기본 정책은 모두 허용 |

### 2-7. 페더레이션: IAM Identity Center, IAM, Cognito

IAM 문서는 사람 사용자가 자격 증명 공급자(IdP)를 통한 페더레이션으로 AWS에 접근하라고 권합니다. 페더레이션 방식은 세 가지이고 문서의 비교표를 옮기면 이렇습니다.

| 방식 | 계정 범위 | 대상 | 지원하는 자격 증명 원본 |
|---|---|---|---|
| IAM Identity Center | Organizations로 묶인 여러 계정 | 조직 구성원(워크포스) | SAML 2.0, AWS Managed Microsoft AD, Identity Center 디렉터리 |
| IAM 페더레이션 | 단일 계정 | 단기·소규모 사람 사용자, 머신 사용자 | SAML 2.0, OIDC |
| Cognito 자격 증명 풀 | 제한 없음 | AWS 리소스에 직접 접근해야 하는 앱 사용자 | SAML 2.0, OIDC, 일부 소셜 IdP |

IAM Identity Center는 조직 인스턴스와 계정 인스턴스가 있고 문서는 조직 인스턴스를 모범 사례로 듭니다. 조직 인스턴스는 관리 계정에 배포되고 AWS 계정 접근을 관리할 수 있는 유일한 인스턴스 유형입니다. 권한 세트(permission set)로 직무별 권한을 정의해 여러 계정에 배포하고 사용자와 그룹에 할당합니다. 2022년 7월 26일에 AWS Single Sign-On에서 이름이 바뀌었으니 보기에 SSO가 나오면 같은 서비스입니다.

"사내 Active Directory 사용자가 여러 AWS 계정 콘솔에 로그인"은 IAM Identity Center에 AD를 자격 증명 원본으로 연결하는 것이 답입니다. "디렉터리를 IAM 역할과 페더레이션할 시점"이라는 안내서 항목은 이 표의 첫 두 줄을 고르는 문제로 읽었습니다.

GitHub Actions처럼 AWS 밖에서 도는 CI가 배포해야 하면 OIDC로 IAM에 페더레이션하고 역할을 맡게 합니다. 액세스 키를 CI 비밀 변수에 넣는 보기는 장기 자격 증명이라 오답 쪽입니다. AWS 밖의 서버라면 X.509 인증서로 임시 자격 증명을 받는 IAM Roles Anywhere도 문서에 나옵니다.

### 2-8. 여러 계정 보안: Organizations, SCP, RCP, Control Tower

SCP는 조직의 IAM 사용자와 역할이 쓸 수 있는 최대 권한을 정합니다. 문서에서 시험과 직결되는 문장을 모았습니다.

| 항목 | 문서 내용 |
|---|---|
| 권한 부여 | SCP는 권한을 주지 않는다. 권한은 자격 증명 기반 정책이나 리소스 기반 정책으로 준다 |
| 관리 계정 | SCP는 관리 계정의 사용자와 역할에 영향을 주지 않는다. 멤버 계정에만 적용된다 |
| 멤버 계정 루트 | 멤버 계정의 루트 사용자도 SCP의 제한을 받는다 |
| 서비스 연결 역할 | SCP의 영향을 받지 않는다 |
| 외부 계정 | 조직 밖 계정의 사용자에게는 적용되지 않는다. 리소스 정책을 직접 바꾸지도 않는다 |
| 상속 | 계정은 위의 모든 부모(루트, OU)가 허용한 권한만 쓴다 |
| 기본 정책 | `FullAWSAccess`. 대체 정책 없이 떼면 멤버 계정의 모든 작업이 실패한다 |
| 사용 조건 | 모든 기능(all features)을 켠 조직에서만 쓸 수 있다. 통합 결제만 켠 조직에서는 안 된다 |

RCP(리소스 제어 정책)는 SCP와 짝을 이루는 조직 정책으로, SCP가 주체 쪽 상한이면 RCP는 리소스 쪽 상한입니다. IAM 모범 사례 문서는 둘 다 권한을 주지 않는다고 명시합니다. KMS 문서에는 RCP가 AWS 관리형 키에는 적용되지 않는다는 문장이 있습니다.

Control Tower는 Organizations, Service Catalog, IAM Identity Center를 조합해 랜딩 존을 한 시간 안에 만든다고 문서가 설명하는 서비스입니다.

| 구성 | 내용 |
|---|---|
| 랜딩 존 | 보안·규정 준수 모범 사례에 맞춘 다중 계정 환경 |
| 컨트롤(가드레일) | 예방(preventive), 탐지(detective), 사전(proactive) 세 종류. 필수, 강력 권장, 선택 세 단계로 분류 |
| Account Factory | 승인된 설정으로 새 계정을 만드는 템플릿 |
| 대시보드 | 계정, 활성화된 컨트롤, 규정 미준수 리소스 |

"수십 개 계정을 모범 사례대로 빠르게 세우고 계속 통제"는 Control Tower, "특정 리전 밖에서 리소스 생성을 금지"처럼 한 가지 금지를 조직 전체에 거는 것은 SCP가 답에 가깝습니다.

### 2-9. 과제 1.1에서 갈리는 조건

| 시나리오의 단어 | 가리키는 답 |
|---|---|
| EC2나 Lambda가 S3에 접근, 자격 증명을 코드에 두지 않음 | 인스턴스 프로필이나 실행 역할 |
| 사내 디렉터리, 여러 계정, 단일 로그인 | IAM Identity Center |
| 모바일 앱 사용자가 자기 S3 경로에 직접 업로드 | Cognito 사용자 풀 + 자격 증명 풀 |
| 조직 전체에서 특정 서비스나 리전 사용 금지 | SCP |
| 개발자가 역할을 만들되 관리자 권한은 못 주게 | 권한 경계 |
| 다른 계정이 우리 버킷 하나를 읽음 | 버킷 정책에 상대 주체 지정 |
| 관리자 정책을 붙였는데 거부됨 | 상위 SCP나 명시적 거부 확인 |
| 공개되거나 외부 계정과 공유된 리소스 찾기 | IAM Access Analyzer |

## 3. 과제 1.2 안전한 워크로드와 애플리케이션

### 3-1. 서브넷 분리

서브넷은 VPC 안의 IP 범위이고 하나의 가용 영역(AZ)에만 속합니다. 서브넷의 종류는 라우팅으로 정해집니다.

| 종류 | 라우팅 | 둘 것 |
|---|---|---|
| 공용 서브넷 | 인터넷 게이트웨이로 가는 직접 경로가 있다 | ALB, NAT 게이트웨이(영역 NAT 기준), 배스천 호스트 |
| 사설 서브넷 | 인터넷 게이트웨이로 가는 직접 경로가 없다. 인터넷에 나가려면 NAT 장치가 필요하다 | 애플리케이션 서버, 컨테이너 |
| VPN 전용 서브넷 | 가상 프라이빗 게이트웨이를 통한 Site-to-Site VPN 경로만 있다 | 온프레미스와만 통신하는 서버 |
| 격리 서브넷 | VPC 밖으로 가는 경로가 없다 | 같은 VPC 안에서만 접근하는 데이터베이스 |

쇼핑몰을 3계층으로 나누면 ALB는 공용 서브넷, 웹·앱 서버는 사설 서브넷, 주문 DB는 격리 서브넷에 두고 AZ 두 개 이상에 같은 구성을 반복합니다. VPC 문서의 서브넷 그림도 AZ마다 공용·사설 서브넷 한 쌍을 둡니다.

### 3-2. 보안 그룹과 네트워크 ACL

VPC 문서의 비교표입니다.

| 특성 | 보안 그룹 | 네트워크 ACL |
|---|---|---|
| 동작 수준 | 인스턴스 수준 | 서브넷 수준 |
| 적용 범위 | 그 보안 그룹에 연결된 인스턴스 | 연결된 서브넷의 모든 인스턴스 |
| 규칙 유형 | 허용만 | 허용과 거부 |
| 평가 | 모든 규칙을 본 뒤 결정 | 번호 오름차순으로 보다가 처음 맞는 규칙에서 결정 |
| 응답 트래픽 | 자동 허용(상태 저장) | 명시적으로 허용해야 함(상태 비저장) |

문서는 보안 그룹을 주 통제 수단으로 쓰고 네트워크 ACL은 특정 트래픽 거부나 서브넷 단위 가드레일 같은 보조 수단으로 쓰라고 권합니다. 보안 그룹은 다른 보안 그룹을 출발지로 참조할 수 있어서 "ALB 보안 그룹에서 오는 트래픽만 앱 서버 8080 허용"처럼 IP 없이 규칙을 쓸 수 있습니다.

기본값과 한도(VPC 할당량 페이지, 2026년 10월 확인)도 문제에 나올 수 있습니다.

| 항목 | 기본값 | 조정 |
|---|---|---|
| 보안 그룹당 인바운드 또는 아웃바운드 규칙 | 60개(인바운드와 아웃바운드, IPv4와 IPv6를 각각 따로 센다) | 가능. 네트워크 인터페이스당 보안 그룹 수와 곱해 1,000을 넘을 수 없다 |
| 네트워크 인터페이스당 보안 그룹 | 5개 | 최대 16개 |
| 네트워크 ACL당 규칙 | 인바운드 20, 아웃바운드 20 | 각각 최대 40 |
| 기본 네트워크 ACL | 모든 인바운드·아웃바운드 허용 | 수정 가능 |

네트워크 ACL이 상태 비저장이라는 점 때문에 생기는 문제가 있습니다. 인바운드 443을 허용해도 응답이 나가는 임시 포트(ephemeral port) 범위를 아웃바운드에서 허용하지 않으면 응답이 막힙니다. NAT 게이트웨이 문서는 NAT 게이트웨이가 1024~65535 포트를 쓴다고 적습니다.

### 3-3. NAT 게이트웨이

NAT 게이트웨이는 사설 서브넷의 인스턴스가 밖으로 연결을 시작할 수 있게 하고 밖에서 먼저 들어오는 연결은 받지 않습니다. 공용 NAT 게이트웨이는 공용 서브넷에 만들고 탄력적 IP를 붙입니다. 사설 NAT 게이트웨이는 다른 VPC나 온프레미스로 나갈 때 쓰고 탄력적 IP를 붙일 수 없습니다.

| 항목 | 문서 내용 |
|---|---|
| 가용성 | 영역(zonal) NAT 게이트웨이는 특정 AZ에 만들어지고 그 AZ 안에서 이중화된다. 여러 AZ가 하나를 공유하다 그 AZ가 멈추면 다른 AZ의 리소스도 인터넷 접근을 잃는다. AZ마다 하나씩 두고 같은 AZ의 NAT를 쓰도록 라우팅하라고 권한다 |
| 대역폭 | 5Gbps에서 시작해 100Gbps까지 자동 확장 |
| 패킷 | 초당 100만 패킷에서 1,000만 패킷까지 확장. 넘으면 버린다 |
| 보안 그룹 | 붙일 수 없다. 서브넷의 네트워크 ACL로 통제한다 |
| 연결 수 | IPv4 주소 하나당 같은 목적지로 동시 55,000개. 주소를 최대 8개까지 붙여 늘린다 |

2026년 10월 문서에는 리전(regional) NAT 게이트웨이가 있습니다. 워크로드가 있는 AZ를 감지해 자동으로 확장합니다. 공용 서브넷 없이 만들 수 있고 AZ마다 IP를 최대 32개까지 붙입니다. 새 AZ로 확장하는 데 최대 60분이 걸리고 그동안 트래픽은 기존 AZ를 거쳐 처리됩니다. 사설 NAT는 지원하지 않습니다. 시험 안내서와 기존 문항은 영역 NAT 게이트웨이를 전제로 쓰였을 가능성이 높아서 "AZ마다 NAT 게이트웨이"를 기본 답으로 기억하고 리전 NAT 게이트웨이는 새 선택지로만 알아 두었습니다.

### 3-4. VPC 엔드포인트

| 구분 | 게이트웨이 엔드포인트 | 인터페이스 엔드포인트 |
|---|---|---|
| 대상 서비스 | S3, DynamoDB만 | 대부분의 AWS 서비스, PrivateLink 엔드포인트 서비스 |
| 기반 | PrivateLink를 쓰지 않는다. 라우팅 테이블에 서비스 접두사 목록 경로가 추가된다 | PrivateLink. 지정한 서브넷마다 엔드포인트 네트워크 인터페이스(사설 IP)가 생긴다 |
| 요금 | 추가 요금 없음 | 시간당과 처리 데이터량 요금(이번에 금액은 확인하지 않음) |
| 접근 통제 | 엔드포인트 정책, 버킷 정책의 `aws:SourceVpce` | 엔드포인트 정책, 보안 그룹 |
| 범위 | 같은 리전의 서비스만. 다른 리전의 S3로 가는 트래픽은 인터넷 게이트웨이로 간다 | |

S3와 DynamoDB는 두 방식을 모두 지원합니다. 게이트웨이 엔드포인트는 라우팅 테이블 기반이라 온프레미스에서 VPN이나 Direct Connect로 들어온 트래픽이 쓰기 어렵고 이 경우는 인터페이스 엔드포인트를 씁니다. 이 부분은 S3 문서의 엔드포인트 유형 비교를 아직 열어 보지 않아 조건을 정확히 확인하지 못했습니다.

결제 서비스의 사설 서브넷 서버가 영수증 PDF를 S3에 올린다면 게이트웨이 엔드포인트를 만들고 버킷 정책에 `aws:SourceVpce` 조건을 걸어 그 엔드포인트에서 오는 요청만 받게 합니다. 트래픽이 NAT를 거치지 않으니 NAT 처리 요금도 줄어듭니다.

### 3-5. 외부 연결: Site-to-Site VPN과 Direct Connect

| 항목 | Site-to-Site VPN | Direct Connect |
|---|---|---|
| 경로 | 인터넷 위 IPsec 터널 | 전용 물리 회선 |
| 암호화 | IPsec으로 암호화 | 기본으로 암호화하지 않는다. MACsec 지원 연결이나 DX 위 VPN으로 암호화 |
| 이중화 | VPN 연결마다 터널 두 개 | 회선과 위치를 이중화해야 한다 |
| 대역폭 | 터널당 기본 1.25Gbps. Transit Gateway나 Cloud WAN에 붙인 연결은 터널당 최대 5Gbps 설정이 있다 | 회선 속도에 따름 |
| 구축 시간 | 짧다 | 회선 개통이 필요하다(기간은 이번에 확인하지 않음) |

Direct Connect 문서는 DX와 VPN을 함께 쓰면 IPsec으로 암호화된 사설 연결을 얻으면서 인터넷 VPN보다 일관된 네트워크 경험을 준다고 적습니다. "전용 회선 + 전송 중 암호화 요구"가 함께 나오면 DX 위 VPN이나 MACsec입니다. "빨리 연결하고 나중에 전용 회선"이면 VPN으로 시작해 DX를 추가하고 VPN을 백업으로 남기는 구성이 흔한 답입니다.

### 3-6. 외부 위협: WAF와 Shield

안내서가 외부 위협 예시로 든 DDoS와 SQL 주입은 각각 Shield와 WAF로 이어집니다.

WAF는 보호 대상 리소스로 들어오는 HTTP(S) 요청을 검사하는 웹 애플리케이션 방화벽입니다. 2026년 10월 문서 기준 연결할 수 있는 리소스는 CloudFront 배포, API Gateway REST API, ALB, AppSync GraphQL API, Cognito 사용자 풀, App Runner 서비스, Verified Access 인스턴스, Amplify, Bedrock AgentCore Gateway입니다. NLB와 HTTP API는 목록에 없습니다. 요청이 규칙에 걸리면 403이나 사용자 지정 응답을 돌려줍니다.

| WAF 규칙 | 하는 일 |
|---|---|
| SQL 주입 공격 규칙 문 | 쿼리 문자열이나 본문 같은 요청 구성 요소에서 악성 SQL 코드를 찾는다. 민감도 LOW(기본)와 HIGH(권장, 오탐 증가) |
| 속도 기반 규칙 | 기준에 따라 요청을 묶어 세고 너무 빠르면 제한한다 |
| IP 집합, 지역 일치 | 특정 IP나 국가에서 온 요청 차단 |

Shield Standard는 모든 AWS 고객에게 추가 요금 없이 자동 적용되고 흔한 네트워크·전송 계층(L3, L4) DDoS 공격을 막습니다. 문서는 Route 53 호스팅 영역, CloudFront 배포, Global Accelerator 표준 가속기가 특히 이 보호를 넓게 받는다고 적습니다.

Shield Advanced는 구독형입니다. 요금 페이지의 예시에는 월 3,000달러가 나오고 1년 약정이 필요하며 DDoS 비용 보호를 포함한 모든 혜택은 1년 기간을 채우는 것이 전제라고 적혀 있습니다. 보호 대상 리소스의 표준 WAF 요금(웹 ACL, 규칙, 요청 검사)을 1,500 WCU와 기본 본문 크기 범위 안에서 포함합니다.

| 요구 | 답 |
|---|---|
| 일반 DDoS 방어, 추가 비용 없이 | Shield Standard(이미 켜져 있음) |
| 대규모 공격 중 전문 대응팀 지원, 공격으로 늘어난 비용 보호 | Shield Advanced |
| SQL 주입, XSS, 특정 국가 차단, 초당 요청 제한 | WAF |
| 공격을 엣지에서 흡수 | CloudFront나 Global Accelerator 앞단 배치 + Shield |

### 3-7. 탐지 서비스: GuardDuty, Macie

| 서비스 | 보는 데이터 | 찾는 것 | 하지 않는 것 |
|---|---|---|---|
| GuardDuty | 기본 데이터 원본으로 CloudTrail 관리 이벤트, VPC 흐름 로그, DNS 로그. 보호 플랜으로 S3 데이터 이벤트, EKS 감사 로그, RDS 로그인 활동, EBS 볼륨(맬웨어), 런타임 이벤트 등 | 유출된 자격 증명, 암호화폐 채굴, 악성 IP 통신, 비정상 로그인 | 트래픽을 직접 차단하지 않는다. 결과를 EventBridge로 보내 Lambda 등으로 대응을 자동화한다 |
| Macie | S3 범용 버킷과 객체 | 개인정보(PII), 금융 정보, 자격 증명 같은 민감 데이터, 공개된 버킷 | S3 밖 데이터는 대상이 아니다 |

GuardDuty는 켜기만 하면 기본 데이터 원본을 자동으로 분석하고 별도 에이전트 설치가 필요 없습니다. 런타임 모니터링만 보안 에이전트를 씁니다. 두 서비스 모두 처음 켜면 30일 무료 체험이 있습니다.

게시판 서비스가 사용자가 올린 첨부 파일에 주민등록번호 같은 개인정보가 섞여 있는지 정기적으로 확인하고 싶다면 Macie의 민감 데이터 검색 작업입니다. "누군가 탈취한 키로 새벽에 다른 리전에서 인스턴스를 만든다"를 탐지하고 싶다면 GuardDuty입니다.

### 3-8. 애플리케이션 사용자 인증: Cognito

Cognito 문서는 두 구성 요소를 "이 사용자는 누구인지(인증)"와 "이 사용자가 어떤 AWS 리소스에 닿을 수 있는지(인가)"로 나눕니다.

| 구성 요소 | 하는 일 | 결과물 |
|---|---|---|
| 사용자 풀 | 회원 가입, 로그인, MFA, 소셜·SAML·OIDC 페더레이션 | JWT(ID 토큰, 액세스 토큰) |
| 자격 증명 풀 | 신뢰하는 토큰을 받아 STS 임시 자격 증명으로 교환. 로그인하지 않은 게스트에게도 제한된 자격 증명 발급 가능 | AWS 임시 자격 증명 |

API Gateway는 사용자 풀 토큰을 검증하는 권한 부여자를 지원하므로 "로그인한 사용자만 주문 API 호출"은 사용자 풀 + API Gateway Cognito 권한 부여자입니다. 앱이 S3나 DynamoDB를 직접 부르려면 자격 증명 풀이 필요합니다. 문서는 Cognito의 고객 측 설계로는 PCI DSS를 충족할 수 없다고 적어 두었습니다(AWS 쪽 클라우드의 보안은 PCI DSS 준수). 결제 카드 데이터를 다루는 시나리오라면 이 점을 함께 봐야 합니다.

### 3-9. 자격 증명과 설정 보관: Secrets Manager와 Parameter Store

Parameter Store 문서에 세 서비스 비교표가 있습니다.

| 항목 | Parameter Store | AppConfig | Secrets Manager |
|---|---|---|---|
| 용도 | 정적 설정, 키-값 | 자주 바뀌는 앱 설정, 기능 플래그 | DB 자격 증명, API 키, 토큰 |
| 암호화 | `SecureString`과 KMS로 선택 | AWS 관리 암호화 | KMS로 저장 시 암호화 |
| 자격 증명 회전 | 없음 | 해당 없음 | 자동. 네이티브 DB 통합 |
| 요금 | 표준 계층 무료, 고급 계층 유료 | 설정 요청당 | 비밀당 월 요금 + API 호출당 |

Secrets Manager는 대부분의 관리형 비밀에 Lambda 없이 동작하는 관리형 회전을 쓰고 그 밖의 비밀은 Lambda 함수로 회전합니다. 회전 주기는 최소 4시간, 최대 999일이고 회전 창은 최소 1시간입니다. Parameter Store 표준 계층은 계정·리전당 파라미터 10,000개, 값 4KB이고 고급 계층은 100,000개, 8KB입니다.

"DB 비밀번호를 30일마다 자동으로 바꾸고 앱 코드는 고치지 않음"은 Secrets Manager입니다. "AMI ID나 엔드포인트 URL을 환경별로 저장, 비용 최소"는 Parameter Store 표준 계층입니다.

### 3-10. 과제 1.2에서 갈리는 조건

| 시나리오의 단어 | 가리키는 답 |
|---|---|
| 특정 IP 대역 차단 | 네트워크 ACL 거부 규칙(서브넷 단위) 또는 WAF IP 집합(HTTP 단위) |
| 앱 서버는 ALB에서 온 요청만 | 앱 서버 보안 그룹의 출발지를 ALB 보안 그룹으로 |
| 사설 서브넷에서 패치 다운로드 | NAT 게이트웨이(AZ마다) |
| 사설 서브넷에서 S3로, 인터넷 경유 금지 | S3 게이트웨이 엔드포인트 |
| 사설 서브넷에서 SQS, Secrets Manager 등으로 | 인터페이스 엔드포인트 |
| 온프레미스와 일관된 대역폭 | Direct Connect. 암호화까지면 DX 위 VPN이나 MACsec |
| SQL 주입, 봇, 요청 폭주 | WAF(SQL 주입 규칙, 속도 기반 규칙) |
| DDoS 대응팀, 비용 보호 | Shield Advanced |
| S3의 개인정보 검색 | Macie |
| 이상 API 호출, 악성 IP 통신 탐지 | GuardDuty |
| 앱 회원 로그인 | Cognito 사용자 풀 |
| DB 비밀번호 자동 회전 | Secrets Manager |

## 4. 과제 1.3 데이터 보안 통제

### 4-1. KMS 키의 세 종류

| 항목 | 고객 관리형 키 | AWS 관리형 키 | AWS 소유 키 |
|---|---|---|---|
| 어디 있는지 | 내 계정 | 내 계정(`aws/서비스` 별칭) | AWS 서비스 계정 |
| 키 정책 | 고객이 통제 | 서비스가 통제, 고객은 조회만 | 서비스만 통제하고 조회 |
| 로그 | CloudTrail | CloudTrail | 볼 수 없음 |
| 회전 | 선택(자동, 온디맨드, 수동) | 매년 자동, 바꿀 수 없음 | 서비스가 정함 |
| 요금 | 월 요금 + 사용 요금 | 월 요금 없음, 사용 요금 | 없음 |
| 다른 계정과 공유 | 키 정책으로 가능 | 불가 | 서비스 기능에 따름 |

문서는 AWS 관리형 키를 2021년부터 새 서비스에는 만들지 않는 레거시 유형으로 설명하고 새 서비스는 기본 암호화에 AWS 소유 키를 쓴다고 적습니다. 정리하면 통제와 감사가 중요하면 고객 관리형 키, 편의가 중요하면 AWS 소유 키입니다.

"다른 계정에 암호화된 스냅샷을 공유"는 고객 관리형 키여야 합니다. AWS 관리형 키로 암호화한 리소스는 다른 계정과 공유할 수 없다고 문서가 명시합니다.

### 4-2. 키 정책과 봉투 암호화

KMS 키에는 반드시 정확히 하나의 키 정책이 있습니다. 문서의 핵심 문장은 두 가지입니다. 루트 사용자나 키 생성자를 포함해 어떤 주체도 키 정책, IAM 정책, 권한 부여(grant) 중 하나에서 명시적으로 허용되고 거부되지 않아야 키를 쓸 수 있습니다. 키 정책이 허용하지 않으면 IAM 정책으로 허용해도 효과가 없고 기본 키 정책에는 IAM 정책을 활성화하는 문장이 들어 있습니다. 키 정책은 리전 단위라 다른 리전의 키에는 영향을 주지 않습니다.

`Encrypt` API로 직접 암호화할 수 있는 평문은 대칭 키 기준 최대 4,096바이트입니다. 그보다 큰 데이터는 봉투 암호화를 씁니다.

1. `GenerateDataKey`로 데이터 키를 받습니다. 평문 사본과 KMS 키로 암호화된 사본이 함께 옵니다.
2. 평문 데이터 키로 KMS 밖에서 데이터를 암호화하고 평문 키는 메모리에서 지웁니다.
3. 암호화된 데이터 키를 데이터 옆에 저장합니다.
4. 복호화할 때 암호화된 데이터 키를 `Decrypt`로 풀고 그 키로 데이터를 풉니다.

KMS는 데이터 키를 저장하거나 추적하지 않습니다. S3, EBS 같은 서비스의 서버 측 암호화가 내부에서 이 방식을 씁니다.

### 4-3. 키 회전

| 키 | 자동 회전 | 온디맨드 회전 |
|---|---|---|
| 고객 관리형 대칭 키(KMS가 만든 키 자료) | 선택. 기본 주기 365일, 90~2,560일로 설정 | 가능 |
| 고객 관리형 대칭 키(가져온 키 자료) | 불가 | 가능 |
| 비대칭 키, HMAC 키, 사용자 지정 키 스토어의 키 | 불가 | 불가. 새 키를 만들어 별칭을 옮기는 수동 회전 |
| AWS 관리형 키 | 매년 자동. 2022년 5월에 3년에서 1년으로 바뀜 | 불가 |

회전은 현재 키 자료만 바꾸고 키 ID와 ARN, 정책은 그대로입니다. 복호화할 때 KMS가 암호화에 쓴 키 자료 버전을 알아서 고르므로 애플리케이션을 고칠 필요가 없습니다. 회전은 이미 암호화된 데이터를 다시 암호화하지 않고 키가 만든 데이터 키도 바꾸지 않습니다. 시험 보기 중 "회전하면 기존 데이터를 다시 암호화해야 한다"는 틀린 설명입니다.

### 4-4. CloudHSM이 필요한 자리

CloudHSM은 단일 테넌트 HSM이고 FIPS 모드 클러스터는 FIPS 140-2 레벨 3 또는 FIPS 140-3 레벨 3 검증을 받았습니다. 데이터 플레인이 종단 간 암호화되어 AWS가 볼 수 없고 사용자 관리도 고객이 IAM 밖에서 합니다. PKCS #11, JCE, CNG 같은 표준 API를 쓰는 기존 애플리케이션을 옮기기 쉽습니다. 문서는 HSM을 직접 운영할 필요가 없으면 KMS를 고려하라고 적습니다.

| 요구 | 답 |
|---|---|
| 관리형 키, AWS 서비스와 통합, 감사 로그 | KMS 고객 관리형 키 |
| 단일 테넌트 HSM, 키를 AWS도 못 봄, 표준 암호 API | CloudHSM |
| 키를 AWS 밖(온프레미스)에 둬야 함 | S3라면 SSE-C나 클라이언트 측 암호화(Ch-00의 샘플 Q5) |

### 4-5. S3 저장 시 암호화

| 방식 | 키 관리 | 특징 |
|---|---|---|
| SSE-S3 | S3 관리 키 | 2023년 1월 5일부터 모든 새 객체에 기본 적용. 추가 비용 없음. 객체마다 고유 키, AES-256 |
| SSE-KMS | KMS 키(AWS 관리형 또는 고객 관리형) | 키 정책 통제, CloudTrail로 키 사용 추적 |
| DSSE-KMS | KMS 키 + S3 관리 키, 두 겹 | 다층 암호화 규정 요구용. S3 Bucket Key 미지원 |
| SSE-C | 고객이 요청마다 키를 보냄 | 2026년 4월부터 새 범용 버킷에서 기본 비활성. 쓰려면 `PutBucketEncryption`으로 켜야 한다 |

기본 암호화를 SSE-KMS로 바꿔도 이미 있는 객체의 암호화 방식은 바뀌지 않습니다. 기존 객체를 바꾸려면 S3 Batch Operations의 복사 작업으로 다시 씁니다.

SSE-KMS는 객체마다 KMS 요청이 생겨 요청량이 많으면 비용과 KMS 요청 한도가 문제가 됩니다. S3 Bucket Key를 켜면 버킷 수준 키가 S3 안에서 일정 시간 데이터 키를 만들어 KMS 요청 비용을 최대 99% 줄인다고 문서가 적습니다. 켜면 암호화 컨텍스트와 CloudTrail 기록이 객체 ARN에서 버킷 ARN으로 바뀌므로 객체 ARN을 조건으로 쓰는 정책은 고쳐야 합니다.

SSE-C 기본 비활성화는 시험 안내서보다 나중 변화입니다. Ch-00에서 본 공식 샘플 문항은 "키를 온프레미스에 둬야 함"의 답으로 SSE-C를 들었는데 2026년 4월 이후 새 버킷에서는 SSE-C를 명시적으로 켜야 한다는 조건이 붙습니다.

### 4-6. 전송 중 암호화: ACM과 TLS

ACM은 공용·사설 SSL/TLS 인증서의 발급, 저장, 갱신을 맡습니다. ACM으로 관리하는 SSL/TLS 인증서에는 추가 요금이 없습니다.

| 항목 | 문서 내용 |
|---|---|
| 리전 | 인증서는 리전 리소스다. 여러 리전의 ELB에 같은 도메인을 쓰려면 리전마다 요청하거나 가져와야 하고 리전 사이에 복사할 수 없다 |
| CloudFront | 인증서를 미국 동부(버지니아 북부) 리전에서 요청하거나 가져와야 한다 |
| 자동 갱신 | DNS 검증이면 자동 갱신, 이메일 검증이면 만료 전 알림. ELB나 CloudFront에 연결된 인증서는 대상 |
| 갱신 대상 아님 | 가져온(import) 인증서, 이미 만료된 인증서, ACME로 발급한 인증서 |
| EC2에서 직접 TLS | 공개 인증서를 EC2 같은 자체 서버에 쓰려면 ACME 프로토콜로 발급·갱신을 자동화하라고 안내 |

"인증서 만료로 장애가 났다, 재발 방지"는 ACM 발급 인증서 + DNS 검증 + ELB나 CloudFront 연결입니다. 가져온 인증서는 자동 갱신이 없으니 만료 이벤트를 모니터링해야 합니다.

S3로 가는 요청에 HTTPS를 강제하려면 버킷 정책에 `aws:SecureTransport`가 `false`인 요청을 거부하는 문장을 넣습니다. S3 보안 모범 사례 문서가 권하는 방법이고 AWS Config 관리형 규칙 `s3-bucket-ssl-requests-only`로 지속 점검할 수 있습니다. 같은 문서는 S3 인증서를 고정(pinning)하지 말라고 합니다. S3가 인증서를 만료 전 아무 때나 갱신하고 갱신할 때 키 쌍이 바뀌기 때문입니다.

### 4-7. S3 접근 통제: 버킷 정책, Block Public Access, Object Ownership

S3 Block Public Access 설정은 네 개이고 액세스 포인트, 버킷, 계정, 조직 수준에 걸 수 있습니다. 수준마다 다르면 가장 제한적인 조합을 적용합니다. 새 버킷, 액세스 포인트, 객체는 기본으로 공개 접근을 허용하지 않습니다.

| 설정 | 효과 |
|---|---|
| `BlockPublicAcls` | 공개 ACL을 지정하는 `PutBucketAcl`, `PutObjectAcl`, `PutObject` 요청을 실패시킨다 |
| `IgnorePublicAcls` | 이미 있는 공개 ACL을 무시한다 |
| `BlockPublicPolicy` | 공개 접근을 허용하는 버킷 정책 설정을 거부한다. 계정 수준에 거는 것을 권장 |
| `RestrictPublicBuckets` | 공개 정책이 있는 버킷을 AWS 서비스 주체와 버킷 소유 계정의 권한 있는 사용자만 접근하게 제한한다 |

Object Ownership의 기본값은 "버킷 소유자 적용(bucket owner enforced)"이고 ACL이 꺼진 상태입니다. 문서는 객체마다 따로 접근을 통제해야 하는 경우가 아니면 ACL을 끄라고 권합니다. 정적 웹사이트처럼 공개가 필요한 경우는 CloudFront 앞단에 두고 원본 접근 통제로 S3를 비공개로 유지하는 구성이 흔하지만 이 절에서는 CloudFront OAC 문서를 따로 확인하지 않았습니다.

### 4-8. 보존과 삭제 방지: 버전 관리, Object Lock, MFA Delete

| 기능 | 막는 것 | 조건 |
|---|---|---|
| 버전 관리 | 덮어쓰기와 삭제로 인한 손실. 이전 버전으로 복구 | 버킷 단위 |
| MFA Delete | MFA 없는 버전 영구 삭제와 버전 관리 상태 변경 | 루트 사용자만 설정 |
| Object Lock 거버넌스 모드 | 대부분 사용자의 삭제와 덮어쓰기 | `s3:BypassGovernanceRetention` 권한과 헤더가 있으면 해제 가능 |
| Object Lock 규정 준수 모드 | 루트 사용자를 포함한 누구의 삭제와 덮어쓰기. 보존 기간 단축 불가 | 기간 전에 지우는 방법은 계정 삭제뿐 |
| 법적 보존(legal hold) | 기간 없이 삭제 방지 | `s3:PutObjectLegalHold` 권한으로 걸고 푼다 |

Object Lock은 버전 관리가 켜진 버킷에서만 동작하고 객체 버전 단위로 걸립니다. 버전 ID 없이 삭제하면 삭제 마커가 생길 뿐 잠긴 버전은 남습니다. Cohasset Associates가 SEC 17a-4, CFTC, FINRA 환경에서 쓸 수 있는지 평가했다고 문서에 적혀 있습니다. 2026년 10월 문서에는 보존 기간을 나중 이벤트로 정하는 가변 보존(variable retention)도 있는데 시험 범위에 들어가는지는 알 수 없습니다.

결제 내역을 7년 동안 누구도 지울 수 없게 보관하라는 요구가 나오면 규정 준수 모드 Object Lock입니다. 감사 전까지 기간을 모른 채 묶어 둬야 하면 법적 보존입니다.

### 4-9. 백업과 복제

AWS Backup은 백업 계획(backup plan)으로 여러 서비스의 백업을 중앙에서 일정에 맞춰 만들고 리전 간과 계정 간 복사를 지원합니다. Organizations와 연동하면 백업 정책을 조직 계정 전체에 적용합니다.

Backup Vault Lock은 백업 저장소(vault)에 WORM을 겁니다.

| 모드 | 동작 |
|---|---|
| 거버넌스 | 충분한 IAM 권한이 있는 사용자가 잠금을 해제할 수 있다 |
| 규정 준수 | 유예 시간(최소 3일, 72시간)이 지나면 고객, 루트 사용자, AWS 누구도 잠금과 저장소 설정을 바꾸거나 지울 수 없다. 복구 지점이 수명 주기를 다할 때까지 남는다 |

Vault Lock 자체는 추가 요금이 없지만 잠긴 백업은 기간이 끝날 때까지 저장 요금이 계속 나갑니다. 문서는 보존 기간을 "항상(Always)"으로 둔 복구 지점이 있으면 유예 시간이 지난 뒤 영원히 남는다고 경고합니다. 계정을 해지하면 90일 동안 백업을 유지하고 그 뒤에는 잠금이 있어도 삭제한다는 예외도 있습니다.

S3 교차 리전 복제는 원본과 대상 버킷 모두 버전 관리가 켜져 있어야 합니다. 복제와 복구 전략은 Ch-02(복원력)에서 RPO, RTO와 함께 다시 다룹니다.

### 4-10. 규정 준수와 데이터 거버넌스

안내서의 "규정 준수 요구에 맞는 기술 정렬"과 "데이터 보존과 분류" 항목에 걸리는 서비스를 S3 보안 모범 사례 문서 기준으로 묶었습니다.

| 하려는 것 | 서비스 |
|---|---|
| 누가 언제 어떤 API를 불렀는지 기록 | CloudTrail(객체 수준은 데이터 이벤트를 따로 켠다) |
| 리소스 설정이 기준에 맞는지 지속 점검 | AWS Config 관리형 규칙(예: `s3-bucket-public-read-prohibited`, `s3-bucket-versioning-enabled`) |
| 민감 데이터 분류 | Macie |
| 여러 서비스의 보안 결과 모아 보기 | Security Hub CSPM |
| 보안 사건의 원인 조사 | Detective |
| 백업이 정책대로 되는지 감사 | AWS Backup Audit Manager |

### 4-11. 과제 1.3에서 갈리는 조건

| 시나리오의 단어 | 가리키는 답 |
|---|---|
| 키 사용을 감사, 키 정책 직접 통제 | KMS 고객 관리형 키 |
| 운영 부담 최소, 기본 암호화면 충분 | SSE-S3(기본값) |
| 단일 테넌트, FIPS 140 레벨 3 | CloudHSM |
| 4KB보다 큰 데이터를 KMS로 | 봉투 암호화(`GenerateDataKey`) |
| SSE-KMS 요청 비용이 큼 | S3 Bucket Key |
| 매년 키 교체 요구, 코드 수정 없이 | 고객 관리형 키 자동 회전 |
| 인증서 자동 갱신 | ACM(DNS 검증) |
| CloudFront에 사용자 도메인 인증서 | us-east-1의 ACM |
| HTTP 요청 차단 | 버킷 정책 `aws:SecureTransport` 거부 |
| 계정의 모든 버킷 공개 금지 | 계정 수준 Block Public Access |
| 누구도 지울 수 없는 보존 | Object Lock 규정 준수 모드, Backup Vault Lock 규정 준수 모드 |
| 실수로 지운 객체 복구 | 버전 관리 |
| 백업을 다른 리전과 다른 계정에 | AWS Backup 리전 간·계정 간 복사 |

## 5. 확인 문제

직접 만든 시나리오입니다. 문제의 조건에서 답이 갈리도록 썼고 실제 시험 문항이나 문제집에서 가져온 것은 없습니다.

**문제 1.** 쇼핑몰 회사는 AWS Organizations로 계정 30개를 관리합니다. 보안팀은 모든 멤버 계정에서 서울과 도쿄 외 리전에 리소스를 만들지 못하게 하려 합니다. 각 계정 관리자는 자기 계정에서 `AdministratorAccess`를 쓰고 있습니다. 가장 적은 운영 부담으로 요구를 만족하는 방법은 무엇입니까?

A. 각 계정의 모든 IAM 역할에 리전 조건을 넣은 거부 정책을 붙인다
B. 조직 루트나 해당 OU에 `aws:RequestedRegion` 조건으로 거부하는 SCP를 붙인다
C. 각 계정에 AWS Config 규칙을 만들어 다른 리전 리소스를 탐지하면 삭제한다
D. IAM Identity Center 권한 세트에서 리전을 제한한다

<details>
<summary>정답과 이유</summary>

B입니다. SCP는 멤버 계정의 모든 사용자와 역할(루트 사용자 포함)의 최대 권한을 정하므로 계정 관리자가 관리자 정책을 갖고 있어도 막힙니다. A는 계정 30개의 모든 역할을 고쳐야 하고 관리자가 다시 뗄 수 있습니다. C는 사후 탐지라 생성 자체를 막지 못합니다. D는 Identity Center로 로그인한 사람에게만 적용되고 워크로드 역할은 막지 못합니다. 관리 계정은 SCP의 영향을 받지 않는다는 점은 남는 한계입니다.
</details>

**문제 2.** 게시판 서비스의 분석 계정(B)에 있는 역할이 운영 계정(A)의 첨부 파일 버킷 하나에서 객체를 읽어야 합니다. A의 버킷 정책은 B의 역할 ARN에 `s3:GetObject`를 허용합니다. 그런데 B에서 요청하면 거부됩니다. 가장 가능성 높은 원인은 무엇입니까?

A. 버킷의 Block Public Access가 켜져 있다
B. B 역할의 자격 증명 기반 정책이 A 버킷의 `s3:GetObject`를 허용하지 않는다
C. 교차 계정 접근에는 반드시 역할 전환이 필요하다
D. 버킷이 SSE-S3로 암호화되어 있다

<details>
<summary>정답과 이유</summary>

B입니다. 교차 계정 요청은 신뢰받는 계정(B)과 신뢰하는 계정(A)에서 두 번 평가되고 둘 다 허용해야 합니다. 버킷 정책이 허용해도 B 쪽 자격 증명 기반 정책에 허용이 없으면 거부됩니다. A는 특정 계정 주체를 지정한 정책은 공개 정책으로 보지 않으므로 원인이 아닙니다. C는 리소스 기반 정책으로도 교차 계정 접근이 됩니다. D의 SSE-S3는 접근 권한이 있으면 투명하게 복호화됩니다. 객체가 고객 관리형 KMS 키로 암호화되어 있었다면 키 정책도 확인해야 했을 것입니다.
</details>

**문제 3.** 결제 서비스의 애플리케이션 서버가 사설 서브넷에 있습니다. 서버는 S3에 영수증을 올리고 SQS 큐에서 메시지를 읽습니다. 보안 요구는 이 트래픽이 인터넷 게이트웨이나 NAT를 거치지 않는 것입니다. 어떤 조합이 맞습니까? (두 개 고르기)

A. S3 게이트웨이 엔드포인트
B. SQS 게이트웨이 엔드포인트
C. SQS 인터페이스 엔드포인트
D. NAT 게이트웨이를 AZ마다 하나씩
E. 사설 서브넷 라우팅 테이블에 인터넷 게이트웨이 경로 추가

<details>
<summary>정답과 이유</summary>

A와 C입니다. 게이트웨이 엔드포인트는 S3와 DynamoDB만 지원하므로 SQS는 PrivateLink 기반 인터페이스 엔드포인트를 씁니다. B는 존재하지 않는 유형입니다. D와 E는 요구 조건(NAT, 인터넷 게이트웨이를 거치지 않음)을 어깁니다. S3 게이트웨이 엔드포인트는 추가 요금이 없어서 비용 조건이 붙어도 A가 유리합니다.
</details>

**문제 4.** 쇼핑몰 웹 서버 앞에 ALB가 있습니다. 특정 IP 대역에서 초당 수천 건의 로그인 시도가 들어오고 일부 요청 본문에는 SQL 구문이 섞여 있습니다. 애플리케이션을 고치지 않고 가장 빨리 대응하는 방법은 무엇입니까?

A. 웹 서버 보안 그룹에 해당 IP 대역 거부 규칙을 추가한다
B. ALB에 WAF 웹 ACL을 연결하고 속도 기반 규칙과 SQL 주입 규칙을 넣는다
C. Shield Advanced를 구독한다
D. GuardDuty를 켠다

<details>
<summary>정답과 이유</summary>

B입니다. WAF는 ALB에 연결할 수 있고 속도 기반 규칙으로 요청 폭주를, SQL 주입 공격 규칙 문으로 본문의 악성 SQL을 걸러 냅니다. A는 보안 그룹에 거부 규칙이 없어서 불가능합니다. C는 대규모 DDoS 대응과 비용 보호용이고 SQL 주입 필터링은 결국 WAF 규칙으로 합니다. D는 탐지만 하고 차단하지 않습니다. IP 대역만 막는 것이 목적이었다면 서브넷의 네트워크 ACL 거부 규칙도 후보가 됩니다.
</details>

**문제 5.** 게시판 서비스의 모바일 앱 사용자가 로그인한 뒤 자기 프로필 사진을 S3의 자기 경로(`users/{사용자ID}/`)에 직접 올리게 하려 합니다. 장기 자격 증명을 앱에 넣으면 안 됩니다. 어떤 구성이 맞습니까?

A. 사용자마다 IAM 사용자를 만들고 액세스 키를 앱에 내려 준다
B. Cognito 사용자 풀로 로그인하고 자격 증명 풀에서 토큰을 임시 자격 증명으로 교환한다. 역할 정책은 사용자 식별자로 경로를 제한한다
C. IAM Identity Center에 앱 사용자를 등록한다
D. 버킷을 공개 쓰기로 열고 경로 이름으로 구분한다

<details>
<summary>정답과 이유</summary>

B입니다. Cognito 문서는 사용자 풀을 인증(누구인지), 자격 증명 풀을 AWS 리소스 인가(무엇에 닿을 수 있는지)로 나눕니다. 앱이 S3를 직접 부르려면 자격 증명 풀이 STS 임시 자격 증명을 줘야 합니다. A는 장기 자격 증명입니다. C는 조직 구성원(워크포스)용입니다. D는 Block Public Access와 최소 권한에 모두 어긋납니다.
</details>

**문제 6.** 결제 데이터를 담은 S3 버킷이 있습니다. 규정상 객체는 5년 동안 누구도(관리자 포함) 지우거나 덮어쓸 수 없어야 합니다. 어떤 설정이 맞습니까?

A. 버전 관리와 수명 주기 규칙
B. Object Lock 거버넌스 모드, 보존 기간 5년
C. Object Lock 규정 준수 모드, 보존 기간 5년
D. MFA Delete

<details>
<summary>정답과 이유</summary>

C입니다. 규정 준수 모드는 루트 사용자를 포함해 누구도 보존 기간 동안 객체 버전을 지우거나 덮어쓸 수 없고 기간을 줄일 수도 없습니다. B는 `s3:BypassGovernanceRetention` 권한이 있으면 해제됩니다. A는 이전 버전을 남기지만 버전 자체의 삭제를 막지 못합니다. D는 MFA가 있으면 지울 수 있습니다. Object Lock은 버전 관리가 켜진 버킷에서만 동작한다는 전제도 기억해 둡니다.
</details>

**문제 7.** 쇼핑몰이 SSE-KMS(고객 관리형 키)로 S3 객체 수억 개를 암호화해 두었습니다. 조회가 몰리는 시간에 KMS 요청 비용이 크게 늘었습니다. 보안 수준을 낮추지 않고 비용을 줄이는 방법은 무엇입니까?

A. SSE-S3로 바꾼다
B. 버킷에 S3 Bucket Key를 켠다
C. 고객 관리형 키를 AWS 관리형 키로 바꾼다
D. 키 자동 회전을 끈다

<details>
<summary>정답과 이유</summary>

B입니다. S3 Bucket Key는 버킷 수준 키로 S3 안에서 데이터 키를 만들어 KMS 요청 비용을 최대 99% 줄인다고 문서가 적습니다. A는 키 정책 통제와 CloudTrail의 키 사용 기록을 잃어 보안 요구가 바뀝니다. C도 키 정책 통제를 잃고 사용 요금은 그대로 붙습니다. D는 요청 비용과 관계가 없습니다. Bucket Key를 켜면 새 객체부터 적용되고 기존 객체는 복사로 다시 써야 한다는 점, 암호화 컨텍스트가 버킷 ARN으로 바뀐다는 점이 함께 따라옵니다.
</details>

**문제 8.** 결제 서비스가 ALB에 HTTPS를 붙이려 합니다. 인증서 갱신을 사람이 챙기지 않게 하고 싶습니다. 같은 도메인을 CloudFront에도 붙일 예정입니다. 맞는 설명은 무엇입니까?

A. ACM 인증서를 한 번 만들면 모든 리전의 ALB와 CloudFront에서 쓸 수 있다
B. ALB용은 ALB가 있는 리전의 ACM에서, CloudFront용은 us-east-1의 ACM에서 DNS 검증으로 발급한다
C. 외부 CA 인증서를 ACM으로 가져오면 ACM이 자동 갱신한다
D. ACM 인증서를 EC2로 내보내 웹 서버에 직접 설치하는 것이 가장 단순하다

<details>
<summary>정답과 이유</summary>

B입니다. ACM 인증서는 리전 리소스라 리전 사이에 복사할 수 없고 CloudFront는 us-east-1의 인증서를 써야 합니다. DNS 검증을 쓰고 ELB나 CloudFront에 연결하면 자동 갱신 대상입니다. C는 가져온 인증서가 관리형 갱신 대상에서 빠지므로 틀립니다. D는 문서가 EC2 같은 자체 서버의 공개 인증서에는 ACME 자동화를 안내하고 있어 갱신 부담이 남습니다.
</details>

## 6. 범위와 한계

- 이 글은 2026년 10월 19일에 열어 본 AWS 공식 문서와 SAA-C03 시험 안내서로 정리했습니다. 한도와 요금은 바뀌므로 응시 전에 다시 확인합니다.
- 실습은 아직 하지 않았습니다. 정책 평가 순서, 네트워크 ACL의 임시 포트 문제, 엔드포인트 정책 동작은 문서로만 확인했고 Ch-00의 3단계(손으로 해 보기)에서 직접 만들어 볼 계획입니다.
- 확인하지 못한 것: 인터페이스 엔드포인트와 Direct Connect의 요금·개통 기간, 온프레미스에서 S3 게이트웨이 엔드포인트를 쓸 수 없는 정확한 조건, CloudFront 원본 접근 통제(OAC) 세부, Amazon Inspector와 AWS Artifact·Audit Manager의 세부 기능. 본문에서 해당 문장에 "확인하지 않음"을 붙였습니다.
- 리전 NAT 게이트웨이, S3 SSE-C 기본 비활성화, Object Lock 가변 보존, WAF의 Bedrock AgentCore Gateway 연결은 시험 안내서 이후에 생긴 것으로 보이며 시험 문항에 반영되었는지는 알 수 없습니다.
- "시험에서 갈리는 조건" 표는 공식 문서의 서비스 설명을 시나리오 단어와 짝지은 제 정리이고 AWS가 만든 표가 아닙니다.
- 확인 문제는 직접 만든 것이라 실제 시험의 난도나 문체와 다를 수 있습니다.

## 참고 자료

시험 안내서
- AWS, [AWS Certified Solutions Architect - Associate (SAA-C03)](https://docs.aws.amazon.com/aws-certification/latest/solutions-architect-associate-03/solutions-architect-associate-03.html)
- AWS, [Content Domain 1: Design Secure Architectures](https://docs.aws.amazon.com/aws-certification/latest/solutions-architect-associate-03/solutions-architect-associate-03-domain1.html)

IAM과 여러 계정
- AWS, [Shared Responsibility Model](https://aws.amazon.com/compliance/shared-responsibility-model/)
- IAM User Guide: [AWS account root user](https://docs.aws.amazon.com/IAM/latest/UserGuide/root-user-tasks.html), [Security best practices in IAM](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html), [Policy evaluation logic](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_evaluation-logic.html), [Cross-account policy evaluation logic](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_evaluation-logic-cross-account.html), [Methods to assume a role](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_use.html), [Identity providers and federation into AWS](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers.html)
- AWS IAM Identity Center User Guide, [What is IAM Identity Center?](https://docs.aws.amazon.com/singlesignon/latest/userguide/what-is.html)
- AWS Organizations User Guide, [Service control policies (SCPs)](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_scps.html)
- AWS Control Tower User Guide, [What Is AWS Control Tower?](https://docs.aws.amazon.com/controltower/latest/userguide/what-is-control-tower.html)

네트워크와 애플리케이션
- Amazon VPC User Guide: [Infrastructure security in Amazon VPC](https://docs.aws.amazon.com/vpc/latest/userguide/infrastructure-security.html), [Subnets for your VPC](https://docs.aws.amazon.com/vpc/latest/userguide/configure-subnets.html), [Amazon VPC quotas](https://docs.aws.amazon.com/vpc/latest/userguide/amazon-vpc-limits.html), [NAT gateways](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-nat-gateway.html), [NAT gateway basics](https://docs.aws.amazon.com/vpc/latest/userguide/nat-gateway-basics.html), [Regional NAT gateways for automatic multi-AZ expansion](https://docs.aws.amazon.com/vpc/latest/userguide/nat-gateways-regional.html)
- AWS PrivateLink Guide: [AWS PrivateLink concepts](https://docs.aws.amazon.com/vpc/latest/privatelink/concepts.html), [Gateway endpoints](https://docs.aws.amazon.com/vpc/latest/privatelink/gateway-endpoints.html)
- [What is AWS Site-to-Site VPN?](https://docs.aws.amazon.com/vpn/latest/s2svpn/VPC_VPN.html), [Encryption in AWS Direct Connect](https://docs.aws.amazon.com/directconnect/latest/UserGuide/encryption-in-transit.html)
- AWS WAF Developer Guide: [AWS WAF](https://docs.aws.amazon.com/waf/latest/developerguide/waf-chapter.html), [SQL injection attack rule statement](https://docs.aws.amazon.com/waf/latest/developerguide/waf-rule-statement-type-sqli-match.html), [Using rate-based rule statements in AWS WAF](https://docs.aws.amazon.com/waf/latest/developerguide/waf-rule-statement-type-rate-based.html), [AWS Shield Standard overview](https://docs.aws.amazon.com/waf/latest/developerguide/ddos-standard-summary.html), [AWS Shield Advanced overview](https://docs.aws.amazon.com/waf/latest/developerguide/ddos-advanced-summary.html)
- AWS, [AWS Shield Pricing](https://aws.amazon.com/shield/pricing/)
- [What is Amazon GuardDuty?](https://docs.aws.amazon.com/guardduty/latest/ug/what-is-guardduty.html), [What is Amazon Macie?](https://docs.aws.amazon.com/macie/latest/user/what-is-macie.html), [What is Amazon Cognito?](https://docs.aws.amazon.com/cognito/latest/developerguide/what-is-amazon-cognito.html)
- [Rotate AWS Secrets Manager secrets](https://docs.aws.amazon.com/secretsmanager/latest/userguide/rotating-secrets.html), [Rotation schedules](https://docs.aws.amazon.com/secretsmanager/latest/userguide/rotate-secrets_schedule.html), [AWS Systems Manager Parameter Store](https://docs.aws.amazon.com/systems-manager/latest/userguide/systems-manager-parameter-store.html)

데이터 보호
- AWS KMS Developer Guide: [AWS KMS keys](https://docs.aws.amazon.com/kms/latest/developerguide/concepts.html), [Key policies in AWS KMS](https://docs.aws.amazon.com/kms/latest/developerguide/key-policies.html), [Generate data keys](https://docs.aws.amazon.com/kms/latest/developerguide/data-keys.html), [Rotate AWS KMS keys](https://docs.aws.amazon.com/kms/latest/developerguide/rotate-keys.html), [Enable automatic key rotation](https://docs.aws.amazon.com/kms/latest/developerguide/rotating-keys-enable.html)
- AWS KMS API Reference, [Encrypt](https://docs.aws.amazon.com/kms/latest/APIReference/API_Encrypt.html)
- [What is AWS CloudHSM?](https://docs.aws.amazon.com/cloudhsm/latest/userguide/introduction.html)
- Amazon S3 User Guide: [Protecting data with server-side encryption](https://docs.aws.amazon.com/AmazonS3/latest/userguide/serv-side-encryption.html), [Reducing the cost of SSE-KMS with Amazon S3 Bucket Keys](https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucket-key.html), [Blocking public access to your Amazon S3 storage](https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-control-block-public-access.html), [Locking objects with Object Lock](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html), [Security best practices for Amazon S3](https://docs.aws.amazon.com/AmazonS3/latest/userguide/security-best-practices.html)
- AWS Certificate Manager User Guide: [What is AWS Certificate Manager?](https://docs.aws.amazon.com/acm/latest/userguide/acm-overview.html), [Managed certificate renewal in AWS Certificate Manager](https://docs.aws.amazon.com/acm/latest/userguide/managed-renewal.html)
- AWS Backup Developer Guide: [What is AWS Backup?](https://docs.aws.amazon.com/aws-backup/latest/devguide/whatisbackup.html), [AWS Backup Vault Lock](https://docs.aws.amazon.com/aws-backup/latest/devguide/vault-lock.html)

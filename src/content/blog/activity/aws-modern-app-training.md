---
title: AWS 모던 애플리케이션 교육 일지
titleEn: AWS Modern Application Training Journal
description: '원광대학교에서 진행된 AWS 모던 애플리케이션 교육에 참가하여 AWS JAM 실습으로 3등을 하고, IaC, 배포 전략, 멀티 클라우드 트렌드를 배운 이틀간의 교육 일지를 정리했어요.'
descriptionEn: 'A two-day training journal from the AWS Modern Application course, covering AWS JAM hands-on practice (3rd place), IaC, deployment strategies, and multi-cloud trends.'
date: 2023-12-11T00:00:00.000Z
tags:
  - AWS
  - IaC
  - Terraform
  - Packer
  - Multi-Cloud
category: activity
coverImage: /uploads/activity/aws-modern-app-training/group-photo-1.jpeg
draft: false
---

**작성일**: 2023년 12월 11일 (제 개인 노션에 있는걸 옮겨왔어요)

***

## 1일차

### 출발

오전 6시에 일어나서 6시 50분부터 버스를 타고 익산에서 서울까지 이동했어요.

![](/uploads/activity/aws-modern-app-training/bus-to-seoul.jpeg)

들어서자마자 보이는 트리예요.

![](/uploads/activity/aws-modern-app-training/christmas-tree.jpeg)

여긴 신기하게 QR을 찍으면 엘리베이터 문이 열리고 특정 층까지 자동으로 이동해요. 엘리베이터 안에 버튼이 없었거든요!

![](/uploads/activity/aws-modern-app-training/qr-elevator.jpeg)

![](/uploads/activity/aws-modern-app-training/classroom.jpeg)

원광대학교 모던 애플리케이션 교육 현장이에요. 이틀 동안 강의를 들을 강의실이었어요.

***

### AWS JAM

![](/uploads/activity/aws-modern-app-training/aws-jam-intro.png)

첫날에는 AWS JAM에 대한 간략한 설명을 듣고 바로 실습으로 이어졌어요.

**AWS JAM이란?**

* AWS 실습으로 JAM이라는 점수를 받아서 랭킹을 매기는 시스템
* 같이 강의를 들은 수강생들과 선의의 경쟁을 했어요

![](/uploads/activity/aws-modern-app-training/jam-3rd-place.png)

결국 JAM에서 **999포인트로 3등**을 했어요!

열심히 풀었는데 갈피가 안 잡히는 건 힌트를 마구 열어서 풀어버렸어요. 힌트를 열어도 네트워크에 대해선 갈피가 잘 안 잡혔는데, 강사님이 친절하게 알려주셨어요.

* "Security boundaries for your VPC" - 해결!
* "Are you up for a network challenge?" - 마지막 스텝에서 꼬여서 시간 부족으로 못 풀었다

![](/uploads/activity/aws-modern-app-training/prize-humidifier.jpeg)

3등 상품으로 가습기(+공기청정기)를 받았어요!

***

## 2일차

2일차에는 오전 9시 30분부터 교육을 받았어요. 배운 내용을 정리해볼게요.

***

### Two Pizza Team

국내 용어로 "목적형 조직"이라고 해요.

* 한 팀이 마이크로서비스 앱의 기능을 모두 수행할 수 있는 인력을 보유한 '분대' 형태
* Cloud Native 트렌드와 함께 DevOps, CI/CD를 구성하기 위한 핵심 요소
* 오너십과 책임감을 갖고 서비스를 운영
* 서비스의 Dev + Ops를 담당

> 주력 분야가 있으면서 다른 팀이 뭐 하는지 대충 알기 때문에, 다른 팀이 휴가를 가도 대충 땜빵을 할 수 있다. 일부 풀스택 엔지니어를 대체할 수 있다!

***

### 골든 이미지와 Packer

#### 골든 이미지의 필요성

* 각 회사에는 표준 솔루션들이 존재 (대표적으로 보안 솔루션)
* 클라우드 전에도 있었던 형태이며, 클라우드에서도 활용
* 클라우드에는 Machine Image (예: AWS AMI)와 연계하여 활용
* 멀티클라우드 환경으로 확장하기 위해 **Packer** 같은 솔루션 사용
* 추가로 널리 활용되는 스크립팅 기술로 **Ansible** 등이 존재

#### Packer의 장점

| 특징     | 설명                        |
| ------ | ------------------------- |
| 사용 편의성 | HCL 사용, Terraform과 손쉬운 연동 |
| 확장성    | 사용 환경과 무관하게 단일 언어로 이미지 관리 |
| 오픈 소스  | 기존 커뮤니티 템플릿 활용 및 직접 작성 가능 |

**핵심**: "표준화", "자동화"를 위한 "코드화!!"

***

### IaC (Infrastructure as Code)

클라우드의 설계도를 그림 형태로 이용할 수 있지만, 실제로 환경을 동일하게 생성하려면 새로운 작업이 필요해요. 이를 해결하기 위해 설계도를 코드 형태로 작성하는 방법론이 **IaC**예요.

> IaC는 컴퓨터에서 읽을 수 있는 정의 파일을 사용하여 클라우드 인프라를 관리하고 프로비저닝하는 프로세스이며, 실행 가능한 '문서'다.

***

### 배포 전략

#### 블루/그린 (Blue/Green)

* 블루(현재 버전)를 끄고 그린(새 버전)을 키는 방식
* 실제 블루에서 운영 중일 때 v2도 계속 돌아가면서 트래픽을 보내 정상 작동하는지 테스트 가능
* 그린 운영 후 블루를 몇 시간 테스트해보고 "문제없네" 확인 후 종료
* **규모가 크면 클수록 블루/그린이 가장 이상적**이에요 (활용도가 높아요)

#### 카나리 (Canary)

* 일부 트래픽만 새 버전으로 보내는 방식
* 롤링은 순차적으로 끄는 거고, 카나리는 일부 포지션을 옆에서 돌리는 것

#### 롤링 (Rolling)

* 순차적으로 인스턴스를 교체하는 방식

***

### 멀티 클라우드 트렌드

다양한 클라우드의 조합으로 서비스를 구성하는 거예요. 전략적인 클라우드 인프라 구성이 가능하다는 점에서 하나의 트렌드로 각광받고 있어요.

#### 멀티 클라우드의 배경

* 모든 클라우드가 같은 서비스를 제공하는 것이 아님
  * MS Azure의 ChatGPT/Co-pilot, Google의 BigQuery 등
* 모든 나라와 장소에 리전이 존재하는 것이 아님
  * 인도: AWS는 뭄바이, Azure는 벵갈루루에 리전
  * 인도네시아: GCP가 먼저 리전을 만들고 진출

#### 장점

* 필요한 서비스를 선택적으로 골라서 조합하고 활용 가능
* 각 클라우드의 숙련도, 선호도, 비용적 이점 등 여러 고려사항에 따라 유연한 설계 가능
* IaC 등의 도구들도 멀티 클라우드를 지원

#### 고려사항

* 각 클라우드마다 특징이 다름 (AWS Lambda, Azure AD, Google App Engine 등)
* 클라우드들을 어떻게 연결할 것인가? (보안, 인증, 네트워크, 서비스 배치)
* 한 가지 방법: **Terraform, k8s 기반으로 통일하여 배포**

#### 비용사항

* 클라우드는 데이터를 밖으로 보낼 때 비용이 발생 (egress)
* 데이터 전송량이 많은 업무는 잘 분배하여 설계 필요
* 그럼에도 멀티 클라우드는 강점이 있어서 추상화하여 설계하는 것이 필요

***

### 실습: HCP Packer + Terraform Cloud

설명을 들은 것을 바탕으로 직접 실습을 시작했어요.

1. **데모 리소스 설정**
   ![](/uploads/activity/aws-modern-app-training/demo-resources.png)
2. **런북 코드화**
   ![](/uploads/activity/aws-modern-app-training/runbook-code.png)
3. **HCP Packer에 이미지 넣고 TFC로 배포**

![](/uploads/activity/aws-modern-app-training/hcp-packer-deploy.png)

1. 작업을 Azure로 변환 (환경변수 오류로 못함)
2. 트랙 리소스 정리

아쉽게 환경변수 오류 때문에 Azure 변환부터는 못했지만, TFC로 배포하는 것까지는 성공했어요!

***

## 마무리 총평

* **첫째 날**: JAM 실습으로 순위를 매겨 3등
* **둘째 날**: 클라우드에 대한 강의를 듣고 직접 실습

열심히 했는데 확실히 시간이 많이 없어서 더 자세하게 못 배운 게 아쉬웠어요. 하지만 개념적인 여러 용어들을 눈에 익히고 많이 배워서 너무 좋았어요.

**진짜로 좋았던 건 시야가 확 트인 느낌이었어요.**

자세하게 배우는 건 나의 의지에 따르는 거라 나중에 한번 깊게 공부해야 할 것 같아요. AWS에서 요즘 모던 애플리케이션이 왜 중요한지, 사용할 때 주의할 점도 많이 알려주셨어요.

| 일자  | 시간             | 내용                |
| --- | -------------- | ----------------- |
| 1일차 | 10:00 \~ 17:00 | AWS JAM 실습        |
| 2일차 | 09:30 \~ 17:00 | 모던 애플리케이션 실습 & 교육 |

![](/uploads/activity/aws-modern-app-training/group-photo-1.jpeg)
![](/uploads/activity/aws-modern-app-training/group-photo-2.jpeg)

같이 강의를 들은 수강생들과 강사님, 멘토님들과의 사진 한 컷이에요!

<!-- EN -->

**Written on**: December 11, 2023 (Migrated from my personal Notion)

***

## Day 1

### Departure

Woke up at 6 AM and took a bus from Iksan to Seoul starting at 6:50 AM.

![](/uploads/activity/aws-modern-app-training/bus-to-seoul.jpeg)

A Christmas tree greeted us at the entrance.

![](/uploads/activity/aws-modern-app-training/christmas-tree.jpeg)

Interestingly, scanning a QR code opens the elevator and automatically takes you to a specific floor. There were no buttons inside the elevator!

![](/uploads/activity/aws-modern-app-training/qr-elevator.jpeg)

![](/uploads/activity/aws-modern-app-training/classroom.jpeg)

The Wonkwang University Modern Application training venue. This is the classroom where we'd attend lectures for two days.

***

### AWS JAM

![](/uploads/activity/aws-modern-app-training/aws-jam-intro.png)

On the first day, we received a brief introduction to AWS JAM and jumped straight into hands-on practice.

**What is AWS JAM?**

* A system where you earn JAM points through AWS hands-on exercises and compete on a leaderboard
* We had friendly competition with fellow trainees

![](/uploads/activity/aws-modern-app-training/jam-3rd-place.png)

I finished **3rd place with 999 points** in the JAM!

I worked hard, but when I got stuck, I freely used hints to solve problems. Even with hints, networking challenges were tricky, but the instructor kindly helped.

* "Security boundaries for your VPC" - Solved!
* "Are you up for a network challenge?" - Got tangled at the last step and ran out of time

![](/uploads/activity/aws-modern-app-training/prize-humidifier.jpeg)

I received a humidifier (+ air purifier) as the 3rd place prize!

***

## Day 2

Day 2 started at 9:30 AM. Here's a summary of what I learned.

***

### Two Pizza Team

In Korean terminology, this is called a "purpose-driven organization."

* A 'squad' where one team has all the personnel needed to perform all functions of a microservice app
* A key element for building DevOps and CI/CD alongside the Cloud Native trend
* Operating services with ownership and responsibility
* Handling both Dev + Ops for services

> Since team members have their specialties while roughly knowing what other teams do, they can fill in when other teams are on vacation. This can partially replace full-stack engineers!

***

### Golden Images and Packer

#### Why Golden Images?

* Every company has standardized solutions (especially security solutions)
* Existed before cloud, still utilized in cloud environments
* Linked with Machine Images in cloud (e.g., AWS AMI)
* Solutions like **Packer** are used for multi-cloud expansion
* **Ansible** and similar scripting tools are also widely used

#### Packer's Advantages

| Feature     | Description                                                    |
| ----------- | -------------------------------------------------------------- |
| Ease of use | Uses HCL, easy integration with Terraform                      |
| Scalability | Manage images with a single language regardless of environment |
| Open source | Leverage community templates or write your own                 |

**Key takeaway**: "Codification!!" for "Standardization" and "Automation"

***

### IaC (Infrastructure as Code)

While cloud architectures can be visualized as diagrams, replicating identical environments requires additional work. IaC solves this by writing infrastructure blueprints as code.

> IaC is the process of managing and provisioning cloud infrastructure using machine-readable definition files — essentially executable 'documentation.'

***

### Deployment Strategies

#### Blue/Green

* Switch from blue (current version) to green (new version)
* While blue is in production, v2 can run simultaneously with test traffic to verify functionality
* After green goes live, test blue for a few hours, confirm "no issues," then shut down
* **The larger the scale, the more ideal blue/green becomes** (high utility)

#### Canary

* Route only some traffic to the new version
* Rolling shuts down sequentially; canary runs some instances alongside

#### Rolling

* Sequentially replace instances

***

### Multi-Cloud Trends

Composing services with combinations of different clouds. This approach is gaining attention for enabling strategic cloud infrastructure design.

#### Background

* Not all clouds offer the same services
  * MS Azure's ChatGPT/Co-pilot, Google's BigQuery, etc.
* Not all countries have regions for every provider
  * India: AWS in Mumbai, Azure in Bengaluru
  * Indonesia: GCP established regions first

#### Advantages

* Select and combine services as needed
* Flexible design based on cloud expertise, preferences, and cost benefits
* IaC tools support multi-cloud

#### Considerations

* Each cloud has different characteristics (AWS Lambda, Azure AD, Google App Engine, etc.)
* How to connect clouds? (Security, authentication, networking, service placement)
* One approach: **Standardize deployment with Terraform and k8s**

#### Cost Considerations

* Clouds charge for outbound data transfer (egress)
* Data-heavy workloads need careful distribution
* Despite costs, multi-cloud has advantages worth abstracting in design

***

### Hands-on: HCP Packer + Terraform Cloud

Based on the lectures, we started hands-on practice.

1. **Demo resource setup**
   ![](/uploads/activity/aws-modern-app-training/demo-resources.png)
2. **Runbook codification**
   ![](/uploads/activity/aws-modern-app-training/runbook-code.png)
3. **Image to HCP Packer and deploy via TFC**

![](/uploads/activity/aws-modern-app-training/hcp-packer-deploy.png)

1. Convert to Azure (failed due to environment variable error)
2. Track resource cleanup

Unfortunately, I couldn't complete the Azure conversion due to an environment variable error, but I successfully deployed via TFC!

***

## Final Thoughts

* **Day 1**: JAM hands-on practice, ranked 3rd
* **Day 2**: Cloud lectures and hands-on practice

I worked hard but there wasn't enough time to dive deeper, which was disappointing. However, I familiarized myself with many conceptual terms and learned a lot.

**The best part was the feeling of having my perspective broadened.**

Deeper learning depends on my own initiative, so I plan to study more thoroughly later. AWS taught us why modern applications matter and many important considerations when using them.

| Day   | Time           | Content                                |
| ----- | -------------- | -------------------------------------- |
| Day 1 | 10:00 \~ 17:00 | AWS JAM Hands-on                       |
| Day 2 | 09:30 \~ 17:00 | Modern Application Practice & Training |

![](/uploads/activity/aws-modern-app-training/group-photo-1.jpeg)
![](/uploads/activity/aws-modern-app-training/group-photo-2.jpeg)

A group photo with fellow trainees, the instructor, and mentors!

---
title: '[SAA] 준비 자료와 시험 당일: 무료 공식 자료부터 쓰고 모의고사는 시간을 재고 푼다'
description: AWS SAA-C03을 2026년 10월 기준으로 준비할 때 쓸 수 있는 정식 자료를 모았습니다. Skill Builder의 무료와 구독 구분, 응시료와 할인 바우처, Tutorials Dojo와 Udemy, Adrian Cantrill, freeCodeCamp 같은 연습 자료 비교, 2025년 7월에 바뀐 프리 티어에서 실습 비용을 묶어 두는 법, 2025~2026년 후기에서 나온 주제 수준의 출제 경향, 한국어 응시자의 영어 원문 보기와 130분 배분, D-30 마무리 계획을 공식 문서와 원문 후기 기준으로 정리합니다.
date: 2026-10-20T00:00:00.000Z
tags:
  - AWS
  - SAA
  - Certification
  - Exam Strategy
  - Practice Exams
  - Free Tier
category: cert/SAA
topics:
  - cert
draft: false
series: "SAA 공부"
seriesOrder: 7
---

## 결론부터

1. 무료 공식 자료만으로 시작할 수 있습니다. 시험 안내서, 샘플 문항 10개, Skill Builder의 공식 연습 문항(Official Practice Question Set) 20개, 2시간짜리 표준 Exam Prep 과정이 무료입니다. 실제 시험과 같은 길이의 공식 모의고사(Official Practice Exam)와 실습 랩은 Skill Builder 구독(개인 월 29 USD)이 있어야 합니다.
2. 응시료는 150 USD이고 원화로는 197,287원입니다(2026년 10월 AWS 표, 세금 별도 가능). 떨어지면 14일 뒤 다시 볼 수 있고 매번 전액을 냅니다. AWS 시험에 한 번 합격하면 다음 시험 50% 할인 바우처가 나옵니다. 2026년 10월 21일에 연 AWS 바우처 캠페인 약관에는 SAA를 대상으로 한 캠페인이 없었습니다.
3. 유료 연습 자료 중 가격과 문항 출처를 직접 확인한 것은 Tutorials Dojo 모의고사(14.99 USD, 자체 작성 명시)와 Adrian Cantrill 강의(40 USD, 모의고사 2회 포함)입니다. freeCodeCamp의 약 50시간 강의는 무료입니다.
4. 2025년 7월 15일 이후 만든 AWS 계정은 크레딧 방식 프리 티어(가입 100 USD, 활동 보상 최대 100 USD, 무료 플랜 최대 6개월)를 받습니다. 무료 플랜은 요금이 나가지 않지만 AWS Organizations에 가입하면 유료 플랜으로 자동 전환됩니다. 2026년 10월 일부 고객에게 열린 새 가입 방식은 리전을 고를 수 없고 IAM Access Analyzer를 쓸 수 없어 SAA 실습에는 기존(advanced) 가입이 맞습니다. 예산 알림은 8~12시간 늦게 올 수 있어 NAT 게이트웨이처럼 시간당 요금이 붙는 리소스는 실습이 끝나면 바로 지웁니다.
5. 2025~2026년 후기 중 유출 문항을 쓰지 않은 8건(이 글 6건, 1편 2건)을 보면 자주 나왔다고 꼽힌 서비스는 S3, VPC, Lambda, RDS와 DynamoDB, ECS와 EKS였고 S3와 Lambda는 두 글이 함께 꼽았습니다. 모의고사 정답률과 실제 점수의 관계는 제각각이었습니다. 문제집 정답률이 52~61%였는데 합격한 사례도 있고 94%를 받고 824점을 받은 사례도 있습니다.
6. 시험장에서는 문제의 마지막 문장(요구 조건)을 먼저 읽고 확신이 없는 문항은 표시해 두고 넘깁니다. 한국어로 응시해도 문항마다 영어 원문으로 바꿔 볼 수 있습니다. 온라인 응시는 시험 중 자리를 뜰 수 없습니다.

시험 구조와 영역별 비중은 [1편](/blog/cert/saa/saa-00-exam-and-study-plan)에, 영역별 내용은 [3편 보안](/blog/cert/saa/saa-01-secure-architectures), [4편 복원력](/blog/cert/saa/saa-02-resilient-architectures), [5편 고성능](/blog/cert/saa/saa-03-high-performing-architectures), [6편 비용](/blog/cert/saa/saa-04-cost-optimized-architectures)에 있습니다. 이 글은 그 내용을 어떤 자료로 다지고 시험 당일 어떻게 푸는지만 다룹니다.

---

## 1. 공식 자료와 규칙

### 1-1. Skill Builder 4단계에서 무료인 것과 구독인 것

AWS 시험 페이지는 SAA-C03 준비 경로를 Skill Builder의 4단계 계획으로 안내합니다. 단계 이름은 시험 페이지에서, 무료와 구독 구분은 AWS 시험 준비 페이지와 Training FAQ에서 확인했습니다(2026년 10월 20일).

| 단계 | 자료 | 무료 여부 | 내용 |
|---|---|---|---|
| 1. 시험 형식 익히기 | Official Practice Question Set | 무료 | AWS가 만든 20문항. 문항마다 해설과 참고 자료가 붙는다 |
| 2. 지식 보충 | Exam Prep 표준 과정 | 무료 | 2시간 디지털 과정. 시험 영역을 훑는다 |
| 2. 지식 보충 | Exam Prep 향상(enhanced) 과정 | 구독 | 6~8시간. 영상, 실습 랩, 공식 모의고사 포함 |
| 3. 복습과 실습 | AWS Cloud Quest | 기본 역할 무료, Solutions Architect 역할은 구독 | 게임 형식 실습 |
| 3. 복습과 실습 | 실습 랩(Builder Labs), AWS Jam | 구독 | 실제 콘솔에서 하는 과제 |
| 3. 복습과 실습 | AWS Escape Room(SAA-C03용) | 구독 | 2025년 7월 추가. 해설이 붙은 시험형 문항과 실습 랩, 퍼즐 |
| 4. 준비 상태 확인 | Official Practice Exam | 구독 | 시험 준비 페이지 표현으로 전체 길이(full-length) 모의고사. 실제 시험과 같은 문항 형식과 난도, 합격·불합격과 척도 점수 |

구독료는 Training FAQ 기준으로 개인 월 29 USD, 연 449 USD이고 자동 갱신됩니다. 연 구독에는 AWS Digital Classroom 과정이 더 붙습니다. FAQ에 무료 체험 항목은 없고 처음 구매한 날부터 3일 안에 요청하면 즉시 해지와 전액 환불을 받을 수 있다고 적혀 있습니다.

이 표에서 돈을 아끼는 순서가 나옵니다. 1~3단계는 무료 자료와 외부 강의로 채우고 시험 1~2주 전에 한 달만 구독해 공식 모의고사와 랩을 쓰는 방법입니다. 공식 모의고사의 정확한 문항 수는 구독 없이 볼 수 있는 페이지에 숫자로 나와 있지 않고 "전체 길이"라는 표현만 있습니다.

### 1-2. 시험 안내서 다음으로 읽을 문서

AWS 시험 안내서는 이 시험이 Well-Architected Framework에 기반한 설계 능력을 검증한다고 적습니다. 그래서 첫 번째로 읽을 문서는 [Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html)입니다. 기둥과 시험 영역의 관계는 [1편의 3절](/blog/cert/saa/saa-00-exam-and-study-plan)에 정리했습니다.

AWS가 SAA용 백서 목록을 따로 내지는 않습니다. 외부 자료가 추천하는 목록을 보면 이렇습니다.

| 문서 | 추천한 곳 | 이 시리즈에서 다룬 곳 |
|---|---|---|
| Disaster Recovery of Workloads on AWS(2021년 2월) | AWS 공식 백서. 네 가지 DR 전략과 RPO, RTO | [4편 3-6절](/blog/cert/saa/saa-02-resilient-architectures) |
| Cost Optimization Pillar | Tutorials Dojo 학습 경로 | [6편](/blog/cert/saa/saa-04-cost-optimized-architectures) |
| SQS, DynamoDB, ElastiCache, Kinesis, Lambda, API Gateway, IAM, KMS FAQ | Tutorials Dojo 시험 팁(2024년 8월 갱신) | 3~5편 |
| Auto Scaling, ELB, EC2, RDS, CloudWatch FAQ | 같은 글 | 4, 5편 |

Tutorials Dojo의 팁 글은 2024년에 갱신된 것이라 목록에 지금은 시험 범위 밖인 배포 관련 백서(Blue/Green Deployments 등)도 섞여 있습니다. 범위 안인지는 시험 안내서의 범위 안 서비스 목록으로 다시 거릅니다.

### 1-3. 시험장과 온라인 응시

두 방식 모두 Pearson VUE가 진행합니다. AWS 정책 페이지와 Pearson VUE의 AWS용 OnVUE 안내에서 확인한 차이입니다(2026년 10월 20일).

| 항목 | 시험장 | 온라인(OnVUE) |
|---|---|---|
| 도착, 접속 | 예약 15~30분 전 도착 | 30분 전부터 체크인. 15분 넘게 늦으면 시작할 수 없고 응시료를 잃는다 |
| 사전 준비 | 신분증 | 같은 컴퓨터와 같은 네트워크로 시스템 테스트 통과. Windows 10 또는 macOS 14 이상, 다운로드 6Mbps와 업로드 2Mbps 이상 |
| 금지 | 소지품은 보관함에 | 헤드폰, 이어폰, 보조 모니터, 가상 머신, VPN, 회사 네트워크, 공용 네트워크 |
| 공간 | 시험장 제공 | 혼자 있는 조용한 방. 책상 위는 컴퓨터와 라벨 없는 음료뿐. 360도 방 촬영 |
| 메모 | AWS 페이지에 규정 없음(확인 못 함) | 화면 속 디지털 화이트보드만 허용. 종이와 펜, 실물 화이트보드는 금지 |
| 휴식 | 예정된 휴식 없음. 비예정 휴식은 가능하지만 시간은 계속 흐르고 건물 밖으로 나갈 수 없다 | 휴식 없음. 화장실을 포함해 카메라 밖으로 나갈 수 없다 |
| 감독관과 대화 | 현장 직원 | 영어는 24시간, 일본어는 월~토 9~16시(JST). 한국어 감독은 목록에 없다 |

예약 변경은 24시간 전까지, 한 예약당 두 번까지 됩니다. 24시간 전까지 취소하면 환불되고 그 안에는 취소도 변경도 할 수 없습니다.

후기 중 일본어권 응시자 셋(Hadomen, IwatsukaYura, SoftBank 블로그)은 모두 시험장을 골랐습니다. IwatsukaYura는 이전 온라인 시험에서 감독관과 영어로 소통하는 일과 주변 방해가 부담이었다고 적었습니다. 집 네트워크가 회사 VPN에 묶여 있거나 혼자 있을 방을 구하기 어렵다면 시험장이 안전합니다.

### 1-4. 한국어로 응시할 때

- 한국어 시험에서도 문항마다 영어 원문을 볼 수 있습니다. AWS 정책 페이지는 "Candidates who sign up for a localized exam can also view questions in English during the exam by using the toggle feature."라고 적습니다.
- 이 전환 기능은 Pearson VUE의 AWS 페이지에 있는 AWS Exam Demo에서 미리 눌러 볼 수 있습니다. 같은 데모에서 검토 표시(Flag for Review)와 색 대비 옵션도 써 볼 수 있습니다.
- 영어로 응시하는 비원어민은 ESL +30분을 받을 수 있습니다. 시험 등록 전에 AWS Certification 계정에서 한 번 신청하면 이후 등록에 모두 적용됩니다. 한국어 시험에는 해당하지 않습니다. 영어 실력이 충분하면 영어 시험에 +30분을 받는 것도 선택지입니다.

### 1-5. 결과, 점수표, 재응시, 갱신

| 항목 | 공식 규정 |
|---|---|
| 결과 | 시험 종료 후 5영업일 안에 AWS Certification 계정에 올라온다. 보안이나 기술 검토 중이면 늦어진다 |
| 점수표 | Exam History에서 PDF로 내려받는다. 영역별 수준 분류표가 들어갈 수 있고 안내서는 이 분류를 조심해서 해석하라고 적는다 |
| 합격선 | 100~1,000 척도에서 720. 영역별 기준은 없다 |
| 재응시 | 불합격하면 14일 뒤부터. 횟수 제한은 없고 매번 전액 |
| 합격 후 | 같은 시험은 2년 동안 다시 볼 수 없다 |
| 유효 기간과 갱신 | 3년. 최신 SAA를 다시 통과하거나 Solutions Architect Professional에 합격하면 3년 연장. Skill Builder에서 유지(maintain) 과정을 마치는 방법은 유료 구독이 필요하고 1년만 연장 |

후기에 적힌 결과 도착 시간은 시험 당일 저녁이 많았습니다. Hadomen은 같은 날 21시쯤, IwatsukaYura와 SoftBank 블로그 필자는 20시쯤, Mynavi 블로그 필자는 약 6시간 뒤, Nishath J P는 약 8시간 뒤에 받았습니다. 공식 기준은 5영업일입니다.

2026년 10월 21일 확인 기준으로 SAA-C03의 새 버전 공지는 없습니다. AWS 블로그는 2026년 9월 1일 글에서 Solutions Architect Professional이 2026년 11월 17일부터 SAP-C03으로(SAP-C02 마지막 응시일 11월 16일), Developer Associate가 12월 1일부터 DVA-C03으로 바뀐다고 공지했습니다. 두 새 시험 모두 등록은 10월 27일에 열립니다. SAA 갱신을 Professional 합격으로 하려면 새 버전 범위를 보고 준비해야 합니다.

## 2. 비용과 할인

| 항목 | 금액, 조건 | 확인한 곳 |
|---|---|---|
| 응시료(Associate) | 150 USD, 197,287원. 세금이 붙을 수 있다. 환율 반영 가격은 최소 매년 5월에 갱신하고 그 사이에도 30일 전 공지 후 바뀔 수 있다 | AWS Before testing(2026-10-21) |
| 재응시 | 매번 전액. 14일 대기 | AWS After testing |
| 합격 혜택 | 다음 시험이나 갱신 시험에 쓰는 50% 할인 바우처 | AWS Benefits, Recertification |
| Skill Builder 구독 | 개인 월 29 USD, 연 449 USD | AWS Training FAQ |
| 2026년 2분기 바우처 캠페인(마감) | 무료 재응시가 붙는 바우처. Professional과 Specialty만 해당. 바우처 구매는 2026-06-30에 마감했고 첫 응시는 2026-12-31까지 | AWS Voucher Campaigns Terms |
| 2026년 AI 업스킬링 캠페인(마감) | AI Practitioner 50% 할인, 합격하면 Cloud Practitioner 무료. AIF-C01 응시 기간은 2026-09-30에 끝났고 무료 CLF-C02는 이미 자격을 얻은 사람만 2026-11-30까지 응시 | 같은 문서 |
| re:Invent 2026 현장 참가자 | 원하는 AWS 시험 50% 바우처 1장. 현장 등록자만 해당(온라인 참가 제외). 참가자 포털에서 받고 2027-01-31까지 응시. 다른 할인과 중복 불가. 행사는 2026-11-30 ~ 12-04 라스베이거스 | [re:Invent FAQ](https://aws.amazon.com/events/reinvent/faqs/)(2026-10-22) |
| Emerging Talent Community 포인트 바우처 | 현재 할인 바우처를 주지 않는다고 적은 대학 안내가 있다(미확인) | UT Dallas 안내 |

50% 바우처를 쓰는 조건은 공식 페이지가 짧게만 적습니다. r/AWSCertifications 위키(2026년 6월 갱신)는 자격이 유효한 동안 3년간 쓸 수 있고 한 번만 쓰며 양도할 수 없다고 정리했습니다. 공식 문서로 확인한 내용은 아닙니다.

할인 경로를 정리하면 이렇습니다. SAA가 첫 AWS 시험이면 지금(2026년 10월 22일) 누구나 쓸 수 있는 공식 할인은 없습니다. Linux Foundation처럼 매달 도는 사이트 할인 행사도 AWS에는 없고 할인은 합격 혜택, 캠페인 바우처, 행사 참가 혜택 세 갈래로만 나옵니다. 캠페인은 AWS FAQ가 "global certification challenge promotions"로 부르는 것으로 Skill Builder와 AWS Training 블로그 공지를 지켜봐야 합니다. 시험 바우처를 정가보다 싸게 판다는 제3자 판매처는 공식 경로 밖이라 다루지 않습니다. Cloud Practitioner나 AI Practitioner를 먼저 따면 50% 바우처로 SAA를 75 USD에 볼 수 있습니다. 다만 그 시험 응시료(100 USD)를 더하면 SAA만 보는 쪽보다 비쌉니다. 기초 시험이 공부에 도움이 될 때만 의미가 있습니다. AWS Summit 학생 대상 배포처럼 행사 단위 바우처도 있지만 대상과 날짜가 행사마다 달라 이 글에서는 다루지 않았습니다.

## 3. 연습 자료 비교표

가격과 분량은 2026년 10월 20일에 각 판매 페이지에서 본 값입니다. Udemy 강의 페이지는 직접 열리지 않아 강의 목록을 옮겨 둔 외부 페이지로 확인했고 가격은 할인 행사에 따라 자주 바뀌어 적지 않았습니다.

| 자료 | 만든 곳 | 형식 | 분량 | 가격 | 문항 출처 표기 |
|---|---|---|---|---|---|
| Official Practice Question Set | AWS | 문제와 해설 | 20문항 | 무료 | AWS 제작 |
| Official Practice Exam | AWS | 시간 제한 모의고사 | 전체 길이(문항 수는 공개 페이지에 없음) | Skill Builder 구독 | AWS 제작 |
| AWS 샘플 문항 PDF | AWS | 문제와 해설 | 10문항 | 무료 | AWS 제작 |
| Tutorials Dojo 모의고사(Jon Bonso) | Tutorials Dojo | 시간 제한 9세트, 복습 모드 9세트, 영역별 4세트, 주제별 13개, 무작위 65문항 | 문제 은행 400문항 이상(학습 경로 글 기준) | 14.99 USD, 1년 이용 | 시험 안내서와 자체 응시 경험을 바탕으로 직접 썼다고 명시. 덤프가 아니라고 적음 |
| Tutorials Dojo 치트 시트 | 같은 곳 | 서비스별, 비교형 요약 | 웹 문서 | 무료 | 공식 문서 링크 첨부 |
| Ultimate AWS Certified Solutions Architect Associate(Stéphane Maarek) | Udemy | 영상 강의, 실습 강의, 모의고사 1회 | 2025년 12월 갱신. 강의 시간은 외부 페이지 값이 9시간과 27시간으로 엇갈려 확인 못 함 | Udemy 변동 | 해당 없음 |
| Practice Exams(Stéphane Maarek, Abhishek Singh) | Udemy | 모의고사 | 390문항, 2025년 10월 갱신 | Udemy 변동 | "written from scratch"라고 표기 |
| AWS SAA-C03(Adrian Cantrill) | learn.cantrill.io | 영상 강의 약 370개, 데모 약 75개, 모의고사 2회, 섹션 퀴즈 150문항 이상 | 2025년 12월 갱신 표시 | 40 USD | 자체 제작 강의 |
| freeCodeCamp SAA 강의(Andrew Brown) | freeCodeCamp YouTube | 영상 강의 | 약 50시간(2024년 5월 공개 글 기준) | 무료 | 해당 없음 |
| Digital Cloud Training 모의고사(Neal Davis) | Digital Cloud Training | 시험 모드 6세트(각 65문항), 학습 모드, 최종 시뮬레이터 | 500문항 이상 | 구독. 금액 확인 못 함 | 페이지에 표기 없음 |
| Whizlabs | Whizlabs | 모의고사, 실습 랩, 샌드박스 | 확인 못 함 | 확인 못 함 | 확인 못 함 |
| AWS Workshops | AWS | 단계별 실습 안내서 | 주제마다 다름 | 안내서는 무료. 자기 계정에서 하면 리소스 요금이 붙는다 | 해당 없음 |

후기에서 자주 나온 조합은 강의 하나와 모의고사 하나입니다. Nishath J P(2025)는 Maarek, Bonso, Davis 모의고사를 21회 풀고 863점을 받았습니다. 그는 Maarek 모의고사가 개념 정리에는 좋지만 실제 시험과 닮지 않았고 Bonso와 Davis 쪽이 더 닮았다고 적었습니다. 한 사람의 체감이라 일반화할 수는 없습니다.

고를 때는 판매 페이지가 문항을 직접 썼다고 밝히는지, 해설이 공식 문서로 연결되는지, 마지막 갱신일이 SAA-C03 범위 안인지를 봤습니다. "실제 시험 문항", "적중", "100% 합격 보장" 같은 문구를 내세우는 문제집은 8절의 이유로 쓰지 않습니다.

## 4. 프리 티어로 실습할 때 비용 사고 막기

### 4-1. 2025년 7월 15일부터 바뀐 프리 티어

AWS는 2025년 7월 15일 이후 만든 계정에 크레딧 방식 프리 티어를 적용합니다. 그 전에 만든 계정은 12개월 무료 체험이 있는 기존 방식 그대로입니다.

| | 무료 플랜 | 유료 플랜 |
|---|---|---|
| 크레딧 | 가입 100 USD + 활동 보상 최대 100 USD | 같음 |
| 활동 보상 | EC2 인스턴스 실행 후 종료, RDS DB 구성, 함수 URL이 있는 Lambda 앱, Bedrock 플레이그라운드 프롬프트, AWS Budgets 알림 생성. 각 20 USD | 같음 |
| 쓸 수 있는 서비스 | 일부. Savings Plans, Reserved Instances, 일부 Marketplace 상품 등은 막혀 있다 | 전부 |
| 요금 | 나가지 않는다 | 크레딧을 넘는 사용량은 청구 |
| 끝나는 시점 | 6개월이 지나거나 크레딧을 다 쓰면 계정이 닫힌다. 90일 안에 유료로 바꾸지 않으면 데이터가 지워진다 | 크레딧을 다 써도 계정은 유지 |
| 크레딧 유효 기간 | 활동 보상 크레딧은 가입 후 12개월. 가입 크레딧은 FAQ의 일반 항목에 6개월, 유료 플랜 항목에 12개월로 엇갈려 적혀 있어 콘솔의 Credits 화면에서 만료일을 확인 | 같음 |

SAA 공부에서 조심할 점이 하나 있습니다. 무료 플랜 계정이 AWS Organizations에 가입하거나 Control Tower 랜딩 존을 만들면 유료 플랜으로 자동 전환되고 FAQ 기준으로 그 시점부터 활동 보상도 더 받을 수 없습니다. SCP나 여러 계정 구조를 실습하려면 활동 보상을 먼저 받고 이 전환을 감안해 시작합니다. 남은 크레딧은 유료 전환 뒤에도 청구서에 적용됩니다.

가입 화면도 하나 확인합니다. AWS 계정 관리 문서(2026년 10월 21일 확인)는 일부 고객에게 먼저 여는 새 가입 방식(Sign up for AWS (new))과 기존 방식(advanced)을 비교합니다. 새 방식은 리소스를 프로젝트 단위로 묶고 월 지출 한도를 걸 수 있지만 리전을 직접 고를 수 없고 IAM Access Analyzer, Savings Plans, Marketplace를 쓸 수 없으며 Organizations와 IAM Identity Center에 자동으로 들어갑니다. VPC를 원하는 리전에 만들고 IAM 정책을 직접 다뤄야 하는 SAA 실습에는 기존 방식이 맞습니다. 새 방식으로 만들었다면 고급 기능(advanced features)을 켜면 되지만 FAQ는 그 뒤로 활동 보상 크레딧을 더 받을 수 없다고 적습니다.

### 4-2. 실습 전에 거는 예산 알림

AWS Budgets 템플릿 중 두 가지를 먼저 만듭니다.

- Zero spend budget: 프리 티어 한도를 넘어 지출이 생기면 알린다.
- Monthly cost budget: 정한 월 금액을 넘었거나 넘을 것으로 예측되면 알린다.

이 알림은 늦게 옵니다. Budgets 문서는 정보가 하루 최대 세 번, 보통 8~12시간 간격으로 갱신된다고 적고 알림을 받기 전에 비용이 이미 임계를 넘을 수 있다고 경고합니다. 알림 금액은 낮게 잡고 실습이 끝나면 알림과 상관없이 리소스를 지웁니다. 예산 액션으로 IAM 정책을 자동 적용해 새 리소스 생성을 막는 방법도 문서에 있습니다. 비용 관리 도구 자체는 [6편 2절](/blog/cert/saa/saa-04-cost-optimized-architectures)에 정리했습니다.

### 4-3. 켜 두기만 해도 요금이 붙는 리소스

| 리소스 | 요금 구조(확인한 값) | 실습 후 할 일 |
|---|---|---|
| NAT 게이트웨이 | 미국 동부(오하이오) 시간당 0.045 USD + 처리 GB당 0.045 USD. 한 달(720시간) 켜 두면 시간 요금만 32.4 USD | 실습 직후 삭제. 연결된 탄력적 IP도 해제 |
| 퍼블릭 IPv4 주소 | 2024년 2월 1일부터 연결 여부와 상관없이 시간당 0.005 USD | 쓰지 않는 탄력적 IP 해제 |
| EC2, RDS | 인스턴스 시간과 스토리지 | 종료. RDS는 스냅샷 보존 여부 확인 |

서울 리전 NAT 게이트웨이는 시간당 0.059 USD, 처리 GB당 0.059 USD입니다(VPC 요금 페이지가 불러오는 공식 요금 데이터, 2026년 10월 21일 확인). 한 달 켜 두면 시간 요금만 42.48 USD입니다. 실습 리전을 하나로 정해 두면 지우지 못한 리소스를 찾기 쉽습니다.

### 4-4. 쇼핑몰 예제로 묶은 실습 순서

[1편 7절](/blog/cert/saa/saa-00-exam-and-study-plan)의 3단계(손으로 해 보기)를 쇼핑몰 예제 하나로 이으면 리소스를 한 번에 정리하기 쉽습니다.

1. VPC: 공용 서브넷과 사설 서브넷을 두 AZ에 만들고 S3 게이트웨이 엔드포인트를 붙인다. NAT 게이트웨이는 사설 서브넷에서 인터넷이 필요한 단계에서만 만들고 확인 뒤 지운다.
2. 웹 계층: ALB 뒤에 Auto Scaling 그룹을 두고 인스턴스 하나를 종료해 대체되는지 본다.
3. 주문 처리: 주문 이벤트를 SNS로 보내고 SQS 두 개(결제, 알림)가 받게 하는 팬아웃을 만든다.
4. 상품 이미지: S3 수명 주기 규칙과 CloudFront 배포를 만든다.
5. 정리: 만든 순서의 반대로 지우고 다음 날 Cost Explorer에서 0이 아닌 항목을 확인한다.

## 5. 2025~2026 후기에서 공통으로 나온 출제 경향(주제 수준)

### 5-1. 모은 후기

유출 문항을 썼다고 적은 후기는 뺐습니다. 2025~2026년 한국어 후기와 중국어 후기는 찾은 글 대부분이 유출 문항 풀이를 공부법으로 적어서 표에 남은 글이 없습니다. 아래 표는 일본어와 영어 후기이고 [1편 6절](/blog/cert/saa/saa-00-exam-and-study-plan)의 후기 표에 이어지는 목록입니다.

| 글 | 결과 | 준비 | 연습 점수와 실제 점수 |
|---|---|---|---|
| Hadomen, Zenn(2026-03) | 824점 | 약 3주, 100~120시간. AWS 경험 없음. 일본어 교재, Udemy 실습 강의와 문제집, 일본어 웹 문제집, 공식 샘플 10문항과 공식 연습 문항 20개 | 교재 모의고사 약 80%, Udemy 문제집 첫 세트 약 40%, 웹 문제집 모의고사 94% |
| IwatsukaYura, Zenn(2026-08) | 786점 | 약 3주, 약 40시간. Cloud Practitioner 보유. 일본어 웹 문제집, Udemy 문제집, 공식 연습 문항 | Udemy 첫 회 60~70%, 두 번째 약 80%. 전날 공식 연습 문항 80~90% |
| Y.M, Mynavi 엔지니어 블로그(2026-04) | 773점 | 약 4주. 일본어 교재, Udemy 문제집과 강의, 노트로 만든 자체 문제 | 4주 전 41%, 1주 전 64%, 하루 전 74%. 실제 점수를 같은 식으로 환산하면 74.8% |
| Hiroaki Ito, SoftBank 블로그(2025-10) | 정답률 74%로 합격(필자 표기) | 약 1.5개월, 60~70시간. Udemy 강의(47.5시간)와 문제집(390문항) | 문제집 6회 52~61%. 문제집이 실제 시험보다 어려웠다고 적음 |
| Nishath J P, DEV(2025-10) | 863점 | 1.5개월 이상. Maarek 강의와 PDF, Maarek, Bonso, Davis 모의고사 21회, 공식 연습 문항 | 모의고사 80% 이상을 목표로 함. "실제 시험이 모의고사보다 쉬웠다" |
| Fabio Alessandro Locati, 개인 블로그(2025-10) | 재응시(점수 미기재) | 3년 전 같은 시험 합격, 이번에는 준비 시간 없음 | AI 관련 문항이 전보다 많았다는 체감 |
| Pravesh Sudha(2025-08), De-Wei Ye(2026-01), Ryan Pothecary(2023) | 1편 표 참고 | | |

### 5-2. 겹치는 경향

자주 나왔다고 적힌 서비스: IwatsukaYura는 S3, VPC, Lambda, RDS와 DynamoDB를 꼽았습니다. SoftBank 블로그는 S3, ECS와 EKS, Lambda를 꼽았습니다. 두 글 모두 S3와 Lambda가 들어갑니다.

시나리오의 축: SoftBank 블로그는 비용과 보안을 맞바꾸는 시나리오가 많았다고 적었습니다. 정해진 시간에만 도는 작업에 EC2보다 EventBridge와 Lambda 조합을 고르는 식의 문제입니다. 1편 4절의 공식 샘플 문항에서 본 "조건이 정답을 가른다"는 관찰과 같은 방향입니다.

헷갈린 영역: Mynavi 필자는 VPC 엔드포인트와 보안 그룹, 보안 그룹과 네트워크 ACL의 차이, S3 스토리지 클래스, ECS와 EKS, Kinesis를 약점으로 적었습니다. 이 다섯은 [3편](/blog/cert/saa/saa-01-secure-architectures) 3-2절과 3-4절, [5편](/blog/cert/saa/saa-03-high-performing-architectures) 3-6절과 6-2절, [6편](/blog/cert/saa/saa-04-cost-optimized-architectures) 3-1절에서 다뤘습니다.

처음 보는 서비스: Hadomen, SoftBank, Mynavi 세 글이 모두 문제집에서 못 본 서비스가 나왔다고 적었습니다. Mynavi 필자는 SageMaker, EFS, Direct Connect를 예로 들었습니다. 그래서 범위 안 서비스 목록을 한 번은 처음부터 끝까지 읽어 둡니다.

체감이 갈린 영역: IwatsukaYura는 AI/ML과 IAM 권한 문항이 예상보다 적었다고 했고 Locati는 AI 관련 문항이 전보다 많았다고 했습니다. 응시자마다 받는 문항 세트가 다르니 한쪽 체감으로 공부 범위를 줄이지 않습니다.

모의고사 점수: 표의 다섯 사례만 봐도 연습 점수와 실제 점수의 관계가 일정하지 않습니다. 52~61%로 합격한 SoftBank 사례, 94%를 받고 824점을 받은 Hadomen 사례가 함께 있습니다. 시험은 척도 점수(scaled score)라 정답률을 그대로 옮길 수도 없습니다. 모의고사 점수는 같은 자료 안에서 오르는 추세를 보는 용도로 씁니다.

번역: SoftBank 필자는 실제 시험 일본어 문장이 기계 번역처럼 읽혀 문제집보다 해석이 어려웠다고 적었습니다. 한국어 시험도 같은 번역 과정을 거칠 것으로 보고 6-4절의 영어 원문 보기를 연습해 둡니다.

## 6. 시험 당일 전략과 체크리스트

### 6-1. 문제를 읽는 순서

AWS 블로그 두 글이 같은 방법을 다른 말로 설명합니다.

- "5 tips for AWS Certification exams from AWS Solutions Architects"(2023)는 문제의 마지막 줄을 먼저 읽어 무엇을 묻는지 확인하고 그다음 앞부분과 보기를 읽으라고 권합니다. 분명히 틀린 보기를 먼저 지우는 소거법도 같은 글에 있습니다.
- "Breaking down the questions on AWS Certification exams"(2021)는 문제를 요구(무엇이 필요한지), 조건(어떤 상황인지), 최선의 해법(모범 사례에 맞는 것) 세 부분으로 나눠 읽습니다.

이 둘을 합치면 읽는 순서가 이렇게 됩니다.

1. 마지막 문장에서 요구와 수식어를 찾는다. "가장 비용 효율적인", "운영 부담이 가장 적은", "가장 적은 변경으로" 같은 말이다.
2. 앞부분에서 조건을 찾는다. 중단 가능 여부, 데이터 크기와 빈도, 지연 요구, 규정 요구가 여기 있다.
3. 보기 중 조건 하나라도 어기는 것을 지운다. 보안을 약하게 만드는 보기는 비용이 싸도 대개 오답이다(1편 3절).
4. 남은 보기 둘 중에서 수식어(비용, 운영 부담)로 고른다.

네 단계를 제가 만든 문제 하나에 대 보면 이렇습니다. 실제 시험 문항이 아니고 순서를 보이려고 쓴 예입니다.

> 쇼핑몰이 매일 밤 주문 로그 약 200GB를 S3에 쌓습니다. 분석 담당자가 한 달에 몇 번 지난 석 달 치를 SQL로 조회합니다. 팀은 서버를 따로 관리하고 싶어 하지 않습니다. 운영 부담이 가장 적은 방법은 무엇입니까?
> A. EC2에 MySQL을 설치하고 로그를 매일 적재한다
> B. Redshift 프로비저닝 클러스터를 만들고 로그를 적재한다
> C. Glue Data Catalog에 테이블을 정의하고 Athena로 S3를 바로 조회한다
> D. EMR 클러스터를 상시 띄워 Spark SQL로 조회한다

| 단계 | 이 문제에서 찾은 것 |
|---|---|
| 1. 마지막 문장 | 요구는 SQL 조회, 수식어는 "운영 부담이 가장 적은" |
| 2. 조건 | 데이터가 이미 S3에 있다, 조회는 가끔이다, 서버 관리를 원하지 않는다 |
| 3. 지우기 | A와 D는 서버(인스턴스, 클러스터)를 직접 운영합니다. B도 상시 켜 두는 클러스터와 적재 작업이 생깁니다 |
| 4. 고르기 | C. Athena는 서버 없이 S3를 바로 조회하고 스캔한 양만큼만 냅니다([5편](/blog/cert/saa/saa-03-high-performing-architectures) 6-6절) |

조건 하나만 바꿔도 답이 바뀝니다. "조회가 하루 종일 수백 명에게서 몰리고 응답이 1초 안이어야 한다"가 붙으면 B 쪽을 다시 봐야 합니다. 키워드 표(6-2절)는 출발점으로만 쓰고 2단계에서 조건을 빠짐없이 적어 두는 쪽이 점수를 지킵니다.

복수 응답 문항은 문제에 고를 개수가 적혀 있습니다. 개수를 맞추지 않으면 오답이니 마지막에 다시 셉니다.

### 6-2. 키워드와 서비스 대응

시나리오 문구가 가리키는 서비스를 이 시리즈의 각 장에서 뽑았습니다. 키워드는 출발점일 뿐이고 조건 하나가 정답을 바꿀 수 있습니다.

| 시나리오 문구 | 먼저 떠올릴 서비스 | 자세한 곳 |
|---|---|---|
| 구성 요소 사이를 끊어 한쪽 장애나 폭주를 버틴다 | SQS | 4편 2-3절 |
| 한 이벤트를 여러 소비자에게 동시에 | SNS와 SQS 팬아웃 | 4편 2-4절 |
| 사설 서브넷에서 S3나 DynamoDB로, 추가 요금 없이 | 게이트웨이 엔드포인트 | 3편 3-4절, 6편 6-3절 |
| 다른 서비스를 사설 연결로 | 인터페이스 엔드포인트(PrivateLink) | 3편 3-4절 |
| 읽기 부하를 나눈다 | 읽기 복제본, Aurora 복제본 | 5편 4-2절, 4-3절 |
| 같은 리전 안 자동 장애 조치 | RDS Multi-AZ | 4편 3-7절 |
| 전 세계 사용자에게 정적 콘텐츠를 낮은 지연으로 | CloudFront | 5편 5-2절 |
| 고정 IP와 TCP, UDP의 전역 가속 | Global Accelerator | 5편 5-2절 |
| 중단돼도 되는 배치를 가장 싸게 | Spot 인스턴스 | 6편 4-1절 |
| 이미 Kafka를 쓴다 | MSK | 5편 6-4절 |
| S3에 있는 데이터를 서버 없이 SQL로 | Athena | 5편 6-6절 |
| SQL 인젝션, 웹 공격 차단 | WAF | 3편 3-6절 |
| 접근 패턴을 모르는 S3 객체 | Intelligent-Tiering | 6편 3-3절 |

### 6-3. 130분 배분

65문항을 130분에 풀면 문항당 2분입니다. 비채점 15문항이 어느 것인지 알 수 없으니 모든 문항에 같은 시간을 씁니다.

| 구간 | 목표 | 근거 |
|---|---|---|
| 첫 회독 | 약 100분 안에 65문항 전부 답하기. 한 문항에 2분이 넘으면 가장 그럴듯한 답을 고르고 표시한 뒤 넘긴다 | IwatsukaYura와 SoftBank 필자 모두 첫 회독에 약 100분을 썼다. AWS 블로그 필자는 문항 읽기에 45~60초를 정해 둔다 |
| 검토 | 남은 약 30분에 표시한 문항만 다시 본다 | IwatsukaYura는 약 15문항, Hadomen은 약 30문항을 표시했다 |
| 마지막 5분 | 빈 답 확인 | 답하지 않은 문항은 오답이고 틀려도 감점은 없다. 5분 남으면 화면에 경고가 뜬다 |

표시한 문항도 일단 답은 골라 둡니다. 그래야 검토 시간이 모자라도 빈칸이 남지 않습니다. 시험 시작 직후 행동 수칙 동의 화면은 5분 안에 동의해야 하고 넘기면 시험이 끝납니다.

### 6-4. 한국어 문제가 어색할 때 영어 원문 보기

한국어 문장이 어색하거나 서비스 이름이 낯설게 번역됐다면 그 문항만 영어로 바꿔 봅니다(1-4절). 다음 습관이 도움이 됩니다.

- 공부할 때 서비스 이름과 기능 이름을 영어로 외운다. 시험은 AWS가 정한 짧은 공식 이름(Amazon SNS 같은)을 쓰고 시험 중 도움말에서 정식 명칭 대응표를 볼 수 있다.
- 수식어를 영어로 알아 둔다. "most cost-effective", "least operational overhead", "fewest changes" 같은 말이 요구를 정한다.
- 시험 전에 AWS Exam Demo에서 전환 버튼 위치를 확인해 둔다.

### 6-5. 체크리스트

| 시점 | 할 일 |
|---|---|
| 등록할 때 | 영어 응시라면 ESL +30분을 먼저 신청. AWS 계정 이름과 신분증 이름이 같은지 확인 |
| D-7 | 온라인이면 시험 볼 컴퓨터와 네트워크로 시스템 테스트. 회사 노트북과 VPN은 피한다. 시험장이면 위치와 이동 시간 확인 |
| D-2 | 일정 변경이 필요하면 24시간 전까지(두 번까지) |
| D-1 | 새 문제 대신 오답 노트와 6-2절 표 복습. 온라인이면 책상과 벽을 비운다 |
| 당일, 온라인 | 30분 전 체크인 시작. 신분증 촬영, 360도 방 촬영. 휴대폰은 손이 닿지 않는 곳에. 화장실은 미리 |
| 당일, 시험장 | 15~30분 전 도착. 신분증. 소지품 보관 |
| 시험 중 | 마지막 문장 먼저, 2분 넘으면 답 고르고 표시, 첫 회독 100분, 검토 30분 |

## 7. D-30 마무리 계획

1편의 공부 계획에서 강의와 실습(2~3단계)을 마친 뒤 시험 30일 전부터 쓰는 계획입니다. "끝났다고 보는 기준"의 정답률은 후기와 판매처가 권한 값(80% 이상, Tutorials Dojo는 90% 이상)을 참고한 것이고 합격을 보장하지 않습니다.

| 기간 | 할 일 | 끝났다고 보는 기준 |
|---|---|---|
| D-30~D-24 | 공식 연습 문항 20개와 샘플 10개를 다시 풀어 기준선을 잡는다. 외부 모의고사 1세트를 복습 모드로 푼다 | 틀린 문항을 과제 번호(1.1~4.4)로 분류했다 |
| D-23~D-15 | 약한 과제 두세 개를 3~6편에서 다시 읽고 4-4절 실습 중 해당 부분을 다시 만든다. 영역별 문제를 푼다 | 약한 과제마다 비교표 한 장 |
| D-14~D-8 | 시간 제한 모의고사를 이틀에 한 번. 오답을 세 종류(지식 부족, 조건을 놓침, 번역이나 문장 해석)로 나눈다 | 첫 회독이 100분 안에 끝난다 |
| D-7~D-3 | 필요하면 Skill Builder를 한 달 구독해 공식 모의고사를 본다. 같은 문제집을 반복해 답을 외운 상태라면 새 세트로 바꾼다 | 처음 보는 세트에서 정답률이 꾸준히 오른다 |
| D-2~D-1 | 오답 노트와 6-2절 표만 본다. 시스템 테스트나 시험장 위치를 다시 확인한다 | 6-5절 체크리스트 완료 |

같은 문제집을 여러 번 풀면 정답률이 실력보다 높게 나옵니다. IwatsukaYura도 반복해서 푼 문제의 답을 외우게 돼 새 문제로 바꿨다고 적었습니다. D-14 이후의 정답률은 처음 보는 세트에서 잰 값만 기준으로 씁니다.

## 8. 덤프를 쓰지 않는 이유

AWS Certification Program Agreement(2026년 7월 17일 갱신)는 시험 자료 전체를 AWS 기밀 정보로 정합니다(1.6절). 2.2절은 시험 내용을 공개하거나 퍼뜨리는 것과 승인되지 않은 공개 자료(Unauthorized Content Disclosures)를 가지거나 접근하거나 쓰는 것을 금지합니다. 6절은 AWS 허락 없이 외부 웹사이트에 올라온 시험 자료를 이 범주로 정의합니다. 위반하면 2.4절에 따라 시험 결과 취소와 프로그램 참여 금지까지 갈 수 있고 응시료는 돌려받지 못합니다. 2.5절은 데이터 분석으로 이상이 발견돼도 같은 조치를 할 수 있다고 적습니다.

AWS 시험 보안팀은 2025년 6월 25일 글 "Protecting AWS Certification value through security measures"에서 이 조항을 풀어 설명했습니다. 실제 문항이 담긴 자료에 의도치 않게 접근한 것도 약관 위반이고 제재는 경고부터 프로그램 정지까지 있으며 자격증을 발급한 뒤에도 결과를 무효로 할 수 있다고 적었습니다. 시험 성적을 계속 통계로 분석해 비정상 패턴을 찾는다는 내용도 있습니다.

규정 말고도 이유가 있습니다. 5절의 후기에서 보듯 문항은 응시자마다 다르고 문제집에 없던 서비스가 나옵니다. 답을 외운 상태로는 처음 보는 조건에 대응하기 어렵습니다. 그래서 이 시리즈는 영역마다 비교표를 만들고 확인 문제를 직접 썼습니다.

## 9. 범위와 한계

- 공식 규정, 가격, 캠페인은 2026년 10월 20일에 연 AWS와 Pearson VUE 페이지 기준이고 21일에 시험 페이지, 응시 정책, 바우처 약관, Training FAQ, 프리 티어 FAQ를 다시 확인했습니다. 등록 전에 다시 확인합니다.
- 확인하지 못한 것: 공식 모의고사의 정확한 문항 수, Stéphane Maarek 강의의 현재 시간, Digital Cloud Training과 Whizlabs의 가격과 문항 출처 방침, 시험장에서 종이나 메모판을 주는지, 50% 바우처의 세부 조건(위키 기준).
- 5절 후기 중 일본어 후기가 쓴 일본어 웹 문제집과 Udemy 일본어 문제집은 문항 출처 방침을 확인하지 못했습니다. 후기의 경향만 옮겼고 자료를 추천하지 않습니다.
- 후기는 한 사람의 체감입니다. 일본어 후기는 일본어 시험 기준이라 한국어 번역 품질과 같다고 볼 근거가 없습니다.
- 4-4절의 실습 순서는 직접 만들어 청구서를 확인한 것이 아니고 1편의 계획을 예제로 묶은 것입니다.
- 이 글은 응시 전에 쓴 정리입니다. 응시한 뒤 시험 당일 경험과 바뀐 판단을 덧붙이겠습니다.

## 참고 자료

공식 시험 정보와 정책
- AWS, [AWS Certified Solutions Architect - Associate](https://aws.amazon.com/certification/certified-solutions-architect-associate/)
- AWS, [SAA-C03 시험 안내서](https://docs.aws.amazon.com/aws-certification/latest/solutions-architect-associate-03/solutions-architect-associate-03.html)
- AWS, [Before testing](https://aws.amazon.com/certification/policies/before-testing/), [During testing](https://aws.amazon.com/certification/policies/during-testing/), [After testing](https://aws.amazon.com/certification/policies/after-testing/), [General information](https://aws.amazon.com/certification/policies/general-information/)
- AWS, [Prepare for your AWS Certification Exam](https://aws.amazon.com/certification/certification-prep/), [AWS Training FAQ](https://aws.amazon.com/training/faqs/), [AWS Certification FAQs](https://aws.amazon.com/certification/faqs/)
- AWS, [Benefits](https://aws.amazon.com/certification/benefits/), [Recertification](https://aws.amazon.com/certification/recertification/), [Coming soon](https://aws.amazon.com/certification/coming-soon/)
- AWS, [Voucher Campaigns Terms and Conditions](https://aws.amazon.com/certification/bulk-voucher/terms-and-conditions/)
- AWS, [AWS Certification Program Agreement](https://aws.amazon.com/certification/certification-agreement/), 2026-07-17
- AWS Exam Security, [Protecting AWS Certification value through security measures](https://aws.amazon.com/blogs/training-and-certification/protecting-aws-certification-value-through-security-measures/), 2025-06-25
- AWS Training and Certification Blog, [July 2025 new offerings](https://aws.amazon.com/blogs/training-and-certification/july-2025-new-offerings/), [Certification updates: September 2026](https://aws.amazon.com/blogs/training-and-certification/september-2026-new-offerings/), [Addition of new exam question types](https://aws.amazon.com/blogs/training-and-certification/aws-certification-new-exam-question-types/)
- Pearson VUE, [Online testing for Amazon Web Services (AWS)](https://www.pearsonvue.com/us/en/aws/onvue.html)
- AWS, [Disaster Recovery of Workloads on AWS: Recovery in the Cloud](https://docs.aws.amazon.com/whitepapers/latest/disaster-recovery-workloads-on-aws/disaster-recovery-workloads-on-aws.html), 2021

시험 전략
- Grey Newell, Joshua Kurz, [5 tips for AWS Certification exams from AWS Solutions Architects](https://aws.amazon.com/blogs/training-and-certification/5-tips-for-aws-certification-exams-from-aws-solutions-architects/), 2023
- Manikanta Gona, [Breaking down the questions on AWS Certification exams](https://aws.amazon.com/blogs/training-and-certification/breaking-down-the-questions-on-aws-certification-exams/), 2021
- Elizabeth Davis, Joe Hanko, [Increase your AWS Certification exam readiness](https://aws.amazon.com/blogs/training-and-certification/tips-for-increasing-your-aws-certification-exam-readiness/), 2020
- Jon Bonso, [AWS Certified Solutions Architect Associate Exam Tips](https://tutorialsdojo.com/aws-solutions-architect-associate-exam-tips/), 2024, [SAA-C03 Study Path](https://tutorialsdojo.com/aws-certified-solutions-architect-associate-exam-saa-c03-study-path/)

프리 티어와 비용
- AWS, [AWS Free Tier](https://aws.amazon.com/free/)
- AWS News Blog, [AWS Free Tier update: New customers can get started and explore AWS with up to $200 in credits](https://aws.amazon.com/blogs/aws/aws-free-tier-update-new-customers-can-get-started-and-explore-aws-with-up-to-200-in-credits/), 2025
- AWS, [Choosing a plan](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier-plans.html), [AWS Free Tier FAQs](https://aws.amazon.com/free/free-tier-faqs/), [Compare sign-up options](https://docs.aws.amazon.com/accounts/latest/reference/sign-up-for-aws.html)
- AWS, [Using a budget template](https://docs.aws.amazon.com/cost-management/latest/userguide/budget-templates.html), [Managing your costs with AWS Budgets](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html)
- AWS, [Amazon VPC pricing](https://aws.amazon.com/vpc/pricing/), [New – AWS Public IPv4 Address Charge](https://aws.amazon.com/blogs/aws/new-aws-public-ipv4-address-charge-public-ip-insights/)
- AWS, [AWS Educate](https://aws.amazon.com/education/awseducate/)

연습 자료(판매, 소개 페이지)
- Tutorials Dojo, [AWS Certified Solutions Architect Associate Practice Exams SAA-C03](https://portal.tutorialsdojo.com/courses/aws-certified-solutions-architect-associate-practice-exams/)
- Adrian Cantrill, [AWS Certified Solutions Architect - Associate (SAA-C03)](https://learn.cantrill.io/p/aws-certified-solutions-architect-associate-saa-c03)
- freeCodeCamp, [Pass the AWS Certified Solutions Architect Associate Certification](https://www.freecodecamp.org/news/pass-the-aws-certified-solutions-architect-associate-certification/), 2024
- Digital Cloud Training, [AWS Certified Solutions Architect Associate Practice Exams](https://learn.digitalcloud.training/course/aws-certified-solutions-architect-associate-practice-exams?/)
- Udemy 강의 정보(외부 목록 페이지): [Ultimate AWS Certified Solutions Architect Associate 2026](https://www2.ctgoodjobs.hk/Learning/1321386127/udemy/ultimate-aws-certified-solutions-architect-associate-2026), [Practice Exams | AWS Certified Solutions Architect Associate](https://www2.ctgoodjobs.hk/Learning/1324165609/udemy/practice-exams-aws-certified-solutions-architect-associate)
- r/AWSCertifications Wiki, [Vouchers & Discounts](https://awscertifications.github.io/AWSCertificationsWiki/vouchers-discounts/), 2026-06
- UT Dallas, [AWS Certification Program and Discounts](https://atlas.utdallas.edu/TDClient/30/Portal/KB/Article/1397/AWS-Certification-Program-and-Discounts)

후기
- Hadomen, [【合格体験記】AWS未経験からSAA-C03に約3週間で合格したので勉強方法などの共有](https://zenn.dev/hadomen/articles/e73abb020ccc15), 2026
- IwatsukaYura, [【3週間で合格】AWS SAA合格記](https://zenn.dev/iwatsukayura/articles/aws-saa-c03-passed), 2026
- Y.M, [【AWS】SAA-C03 試験に何とか一発合格できた](https://engineerblog.mynavi.jp/technology/aws_saa_c03_pass/), 2026
- 伊藤 寛晃, [クラウド経験半年の初心者がAWS認定ソリューションアーキテクト – アソシエイト（SAA）に挑戦してみた](https://www.softbank.jp/biz/blog/cloud-technology/articles/202510/aws-saa/), 2025
- Nishath J P, [How I Passed the AWS Solutions Architect Associate (SAA-C03) Exam with 863 Marks](https://dev.to/nishath_jp/how-i-passed-the-aws-solutions-architect-associate-saa-c03-exam-with-863-marks-102a), 2025
- Fabio Alessandro Locati, [AWS SSA-C03 exam](https://fale.io/blog/2025/10/16/aws-ssa-c03-exam), 2025

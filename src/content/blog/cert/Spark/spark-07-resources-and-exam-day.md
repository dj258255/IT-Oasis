---
title: '[Spark Ch-07] 시험 준비 자료와 당일 전략: 공식 자료, 바우처, Docker 실습, 기본값 체크리스트'
description: Databricks Certified Associate Developer for Apache Spark를 2026년 10월 기준으로 준비하는 데 필요한 공식 자료, 비용과 할인 바우처, 연습 자료의 새 시험 반영 여부, Java 없이 Docker와 Colab으로 실습하는 방법, 새 시험 후기에서 겹치는 경향, 시험 전날 외울 기본값과 당일 시간 배분을 정리합니다.
date: 2026-10-20T00:00:00.000Z
tags:
  - Spark
  - Databricks
  - PySpark
  - Certification
  - Exam Strategy
  - Docker
category: cert/Spark
topics:
  - cert
draft: false
series: "Spark 공부"
seriesOrder: 7
---

## 결론부터

1. 기준 자료는 2026년 10월 8일에 갱신된 시험 안내서입니다. 출제 영역과 비중은 2025년 10월판과 같습니다. 채점하지 않는 문항이 최대 10개라 화면에는 최대 55문항이 나온다는 문장과 샘플 문항 해설이 새로 들어갔습니다. Databricks는 공식 모의고사를 제공하지 않는다고 FAQ에 적습니다.
2. 공식 권장 자기 주도 과정 네 개(Apache Spark Developer 학습 경로)는 2025년 6월 공지 기준으로 Databricks Academy에서 무료로 들을 수 있습니다. 같은 경로를 Learning Festival 기간 안에 끝내면 시험 50% 할인 바우처를 받습니다. 가장 최근 회차는 2026년 9월 16일부터 10월 14일까지였고 바우처는 2027년 1월 17일 전에 써야 합니다.
3. 연습 자료 가운데 2025년 개편을 확실히 반영한 것은 공식 자료(안내서 샘플 10문항, Academy 과정, Spark 문서)뿐이었습니다. 유료 모의고사는 판매자 설명만으로는 새 범위(Structured Streaming, Spark Connect, pandas API) 반영 정도를 확인하기 어려웠습니다.
4. 로컬에 Java가 없어도 Docker 공식 이미지(`spark:python3`, Spark 4.2.0과 Java 21)나 Google Colab(2026년 10월 3일 기준 PySpark 4.0.4와 OpenJDK 21 기본 설치)으로 Spark UI와 캐시, RDD를 실습할 수 있습니다. Free Edition은 Spark Connect 체감용으로 남깁니다.
5. 시험은 90분에 최대 55문항이니 문항당 평균 98초입니다. 시험 중 메모는 약관으로 금지되어 있어 기본값은 머리에 넣어 가야 합니다. 6절의 한 장 체크리스트를 전날 외웁니다.

---

## 1. 공식 자료와 규칙

### 1-1. 시험 안내서 2026년 10월판

자격증 페이지가 2026년 10월 20일 현재 연결하는 안내서는 파일 이름이 `...exam-guide-august-2026.pdf`이지만 본문에는 "Exam Published October 8, 2026"과 "Exam Guide Updated October 8, 2026"이 적혀 있습니다. 2025년 10월판과 비교한 결과는 아래와 같습니다.

| 항목 | 2025년 10월 30일판 | 2026년 10월 8일판 |
|---|---|---|
| 출제 영역과 비중 | 7개 영역, 20/20/30/10/10/5/5% | 같음(목표 문장도 오탈자 수정 말고는 같음) |
| 채점 문항 | 45개 | 45개 |
| 채점하지 않는 문항 | 있을 수 있다고만 적음 | 최대 10개, 화면에 보이는 문항은 최대 55개 |
| 응시료 | 200 USD | 200 USD에 현지 세금 별도 |
| 보조 자료 | API 문서를 포함해 없음 | 없음(None allowed) |
| 권장 과정 | 강사 과정 1개, 자기 주도 과정 4개 | 같음 |
| 샘플 문항 | 10개 | 10개, 정답마다 해설 추가 |
| 그 밖에 | | AI Prep Guide와 Free Edition 실습을 준비 방법으로 안내 |

출제 범위가 같아서 [Ch-00](/blog/cert/spark/spark-00-exam-and-study-plan)의 영역 표와 Ch-01부터 Ch-06까지의 내용은 그대로 씁니다. 안내서는 시험 2주 전에 다시 확인하라고 적으니 D-14에 한 번 더 내려받습니다.

### 1-2. 권장 과정과 접근 방법

안내서가 권장하는 과정은 다섯 개입니다. 강사 과정 하나가 자기 주도 과정 넷으로 쪼개져 있는 구조입니다.

| 과정 | 형태 | 카탈로그 기준 길이 | 비용(2026-10 열람) |
|---|---|---|---|
| Apache Spark Programming with Databricks | 강사 과정 | 16시간(4시간 모듈 4개) | 공개 강좌 1,500 USD |
| Introduction to Apache Spark | 자기 주도 | 2시간 또는 3시간(목록마다 다름) | 가격 표시 없음 |
| Developing Applications with Apache Spark | 자기 주도 | 3시간 | 가격 표시 없음 |
| Stream Processing and Analysis with Apache Spark | 자기 주도 | 3시간 | 가격 표시 없음 |
| Monitoring and Optimizing Apache Spark Workloads on Databricks | 자기 주도, 강사 과정 | 3시간 또는 4시간(목록마다 다름) | 한 목록은 Paid & Subscription 표시, 강사 공개 강좌 750 USD |

카탈로그 페이지에는 자기 주도 과정 가격이 적혀 있지 않습니다. 무료로 볼 수 있다는 근거는 2025년 6월 11일 Databricks 블로그의 Free Edition 발표입니다. Databricks Academy가 모든 자기 주도 과정을 모든 사용자에게 무료로 연다고 적었습니다. Monitoring 과정의 한 카탈로그 목록에 붙은 Paid & Subscription 표시는 실습 포함판을 가리키는 것으로 보이지만 확인하지 못했습니다. 과정에 딸린 실습 환경(Academy Labs)은 따로 돈을 받습니다. 커뮤니티 매니저 답변(2025년 11월)에 따르면 연간 구독이 200 USD이고 과정별 단품이 75 USD입니다. 강사 과정 등록자는 실습 환경을 7일 쓸 수 있다는 답변도 있었습니다(2025년 7월).

계정은 고객용 Customer Academy와 파트너사 직원용 Partner Academy로 나뉩니다. 과정 카탈로그는 두 경로 모두에서 등록할 수 있게 연결하지만 Learning Festival 바우처는 Customer Academy 사용자만 받습니다(2-1절).

### 1-3. 공식 모의고사와 AI Prep Guide

Databricks 자격증 FAQ는 "We currently do not offer any practice exams"라고 적고 이유로 모의고사 결과가 실제 시험만큼 엄격하게 만들어지지 않아 오해를 부르기 쉽다는 점을 듭니다. 2025년 7월 커뮤니티 질문에도 Databricks 직원이 안내서와 그 안의 샘플 문항을 보라고 답했습니다. 공식 모의고사를 풀었다는 후기는 예전 Spark 3.0 시험 시절 이야기입니다.

2026년 6월에는 "AI Prep Guide: Any Databricks Certification"이라는 PDF가 나왔습니다. 쓰는 챗봇에 안내서를 올리고 영역마다 개요, 진단 10문항, 약점 심화, 모의고사, 오답 복기를 돌리는 방법입니다. 문서 스스로 AI가 만든 모의고사로는 준비도를 보정된 방식으로 잴 수 없다고 적습니다. 모든 주장은 공식 문서로 확인하라고 권합니다. 이 시리즈가 Ch마다 공식 문서 문장을 근거로 붙이는 방식과 같습니다.

### 1-4. 등록과 응시 규칙

| 항목 | 내용 | 출처 |
|---|---|---|
| 등록 | Webassessor의 Databricks 전용 페이지 | 자격증 페이지 |
| 응시 자격 | 만 18세 이상 | FAQ |
| 일정 변경 | 온라인은 24시간 전, 시험장은 72시간 전까지. 넘기면 수수료 | FAQ, Kryterion |
| 재응시 | 14일 뒤부터, 횟수 제한 없음, 매번 같은 가격, 무료 재응시 바우처 없음 | FAQ |
| 결과 | 제출 직후. 합격하면 Accredible 배지가 메일로 오고 credentials.databricks.com에서 본다 | FAQ |
| 유효 기간 | 받은 날부터 2년. 갱신은 그때 살아 있는 시험 전체를 다시 본다 | FAQ, 안내서 |
| 지원 | 시험 중단 같은 문제는 Databricks 교육 지원 창구(help.databricks.com)에 티켓으로 | 커뮤니티 직원 답변(2026년 4월) |

온라인 감독 시험의 환경 요건은 Kryterion 지원 문서(2026년 10월 9일 갱신)를 기준으로 정리했습니다. 예전 글에 나오는 Sentinel은 지금 문서에 나오지 않고 Respondus Secure Browser를 설치하라고 적혀 있습니다.

| 항목 | Kryterion 문서 내용 |
|---|---|
| 운영체제 | Windows 10, 11 또는 macOS 12(Monterey) 이상. 가상 머신 금지 |
| 브라우저 | 최신 Chrome 또는 Firefox와 Secure Browser(설치에 관리자 권한이 필요할 수 있음) |
| 장비 | 웹캠과 마이크. 외장 웹캠은 USB 연결 |
| 회선 | 업로드와 다운로드 각각 1.0Mbps 이상 |
| 컴퓨터 | 개인 컴퓨터를 강하게 권장(회사 방화벽과 권한 문제) |
| 사전 점검 | kryterion.com/systemcheck. 응시 화면에 Start Readiness Exam 버튼이 보이면 미리 돌린다 |
| 입장 | Launch 버튼은 예약 10분 전에 열리고 20분 동안 유지된다 |
| 신분 확인 | 원본, 유효기간 안, 등록 이름과 정확히 같은 정부 발급 신분증. 얼굴 대조와 방 스캔 |
| 시험장 | 신분증 2개(하나는 정부 발급 사진 신분증) |

감독관이 문제 삼는 행동도 Kryterion 문서에 목록으로 있습니다. 문제를 소리 내어 읽기, 다른 사람과 말하기, 자리 이탈, 방에 다른 사람이 있는 것, 허가되지 않은 물건(책, 종이, 필기구, 휴대전화), 화면 촬영입니다. Databricks 약관은 온라인 시험 중 쉬는 시간이 없고 음식, 음료, 이어폰을 금지한다고 적습니다. 코드를 읽을 때 입으로 중얼거리는 습관이 있으면 연습할 때부터 고쳐 둡니다.

## 2. 비용과 바우처

| 항목 | 금액 | 조건 |
|---|---|---|
| 응시료 | 200 USD와 현지 세금 | 2026년 10월판 안내서. 세금은 응시 지역 법에 따라 붙는다 |
| 재응시 | 200 USD | 무료 재응시 없음 |
| 자기 주도 과정 4개 | 0 USD | 2025년 6월 공지 기준. Customer Academy 계정 |
| Academy Labs 연간 구독 | 200 USD | 커뮤니티 매니저 답변 기준, Learning Festival 쿠폰으로 20% 할인 |
| 강사 과정 | 1,500 USD | 공개 강좌 가격 |

### 2-1. Learning Festival 회차

Learning Festival은 정해진 기간 안에 학습 경로 하나를 처음부터 끝까지 마치면 시험 50% 할인 바우처와 Academy Labs 20% 할인 쿠폰을 주는 행사입니다. 행사 페이지와 FAQ를 열어 확인한 회차는 다섯 번입니다.

| 회차 | 기간 | 바우처 발송 | 바우처 만료 | Apache Spark Developer 경로 |
|---|---|---|---|---|
| Virtual Learning Festival | 2025-10-10 ~ 10-31 | 11월 초 | 2026-01-30 | FAQ에서 확인하지 못함 |
| Self-Paced Learning Festival | 2026-01-09 ~ 01-30 | 2026-02-06 | 확인하지 못함 | 포함(7번 경로) |
| Learning Festival (Self-paced): Global | 2026-03-16 ~ 04-03 | 2026-04-09 | 2026-07-08 전 | 포함 |
| Advanced Learning Festival | 2026-06-15 ~ 07-06 | 2026년 7월 | 2026-10-06 전 | 포함 |
| Advanced Learning Festival | 2026-09-16 ~ 10-14 | 2026-10-19 | 2027-01-17 전 | 포함 |

Apache Spark Developer 경로의 네 모듈은 1-2절의 자기 주도 과정 넷과 같습니다. 일정이 맞으면 과정 수강과 응시료 할인을 한 번에 챙깁니다. 2026년 9월판 FAQ 기준 조건은 아래와 같습니다.

- Customer Academy 사용자만 대상이고 Partner Academy 사용자는 빠집니다. FAQ는 파트너가 다른 프로그램으로 할인을 받기 때문이라고 적습니다.
- 경로를 여러 개 마쳐도 바우처 하나, 쿠폰 하나입니다. 다른 할인이나 success credit과 합쳐 쓸 수 없습니다.
- 소개 영상까지 모든 구성 요소가 완료로 표시되어야 합니다. 행사 전에 끝낸 과정은 인정하지 않는다는 직원 답변이 있었습니다.
- 바우처는 Academy 계정 이메일에 묶입니다. Webassessor도 같은 이메일로 만들거나 그 주소를 보조 이메일로 추가해야 씁니다.
- 유효 기간은 약 90일이고 그 안에 예약과 응시를 모두 마쳐야 합니다.

다음 회차 날짜는 2026년 10월 20일 현재 공지를 찾지 못했습니다. 2026년 4월 커뮤니티 답글 하나가 "July and October"라고 적었고 실제로 6~7월과 9~10월에 열렸습니다. 2025년 10월과 2026년 1월에도 열렸으니 2027년 1월 전후에 다음 회차가 열릴 가능성은 있습니다. 공지로 확인한 일정은 아직 없습니다. 행사 공지는 Databricks 커뮤니티의 Learning Events 게시판에 올라옵니다.

무료 바우처를 요청하는 커뮤니티 글은 2026년에도 여럿 있었지만 이번에 확인한 범위에서 Spark 시험에 쓸 무료 바우처를 주는 공식 행사는 찾지 못했습니다.

## 3. 연습 자료 비교

새 시험 반영 여부는 아래 기준으로 판정했습니다. 2025년 4월 개편 뒤에 만들었거나 고쳤는지, Structured Streaming과 Spark Connect, pandas API on Spark를 다루는지, 2026년 10월 현재 접근할 수 있는지입니다.

| 자료 | 형태와 비용 | 새 시험 반영 | 확인한 내용 | 주의 |
|---|---|---|---|---|
| 시험 안내서 샘플 10문항 | PDF, 무료 | 반영 | 2026-10-08판은 정답마다 해설이 있다. 오답 보기가 왜 틀렸는지(없는 메서드, 없는 인자)까지 적는다 | 문항 수가 적어 형식 확인용 |
| AI Prep Guide | PDF, 무료 | 안내서 기반 | 영역별 5단계 학습 루프, 실습 과제 6~10개 만들기 | AI 모의고사로는 준비도를 보정된 방식으로 잴 수 없다고 문서가 적는다 |
| Academy 자기 주도 과정 4개 | 강의, 무료(2025-06 공지) | 반영(안내서 권장 목록) | 각 3시간 안팎. 영어, 일부 한국어판 | 커뮤니티 응시자 한 명은 과정만으로는 부족했다고 적었다 |
| Academy Labs | 실습 환경, 연 200 USD | 반영 | 과정과 짝을 이루는 실습 노트북 | Free Edition으로는 Spark UI 실습을 못 한다는 커뮤니티 답변 |
| PySpark 공식 Live Notebook | Binder 노트북, 무료 | 문서와 같은 버전 | DataFrame, Spark Connect, pandas API on Spark 세 개 | 설치 없이 열리지만 이번에 실행해 보지 않았다 |
| Spark 공식 문서 | 웹, 무료 | 최신(4.2.0) | 이 시리즈의 근거 | 시험 기준 버전이 공개되지 않았다 |
| Udemy, Florian Roscheck "Databricks Certified Developer for Spark Practice Exams 2025" | 유료 | 일부 | 본문 설명은 180문항을 직접 썼다고 밝히지만 영역 비중(DataFrame API 72%)과 Community Edition 언급은 예전 3.0 시험 기준 | 검색 결과 요약에는 2025년 11월 갱신과 Streaming, Connect, pandas API 보너스 17문항이 나오지만 페이지에서 직접 확인하지 못했다 |
| 그 밖의 "2026" 표기 Udemy 모의고사 | 유료 | 확인 불가 | 판매자 설명에 공식 목표 기반이라고만 적힌 경우가 많다 | 아래 확인 기준으로 거른다 |
| Afaque Ahmad 유튜브 채널 | 영상, 무료 | 아키텍처와 튜닝 영역 | 메모리 관리, 캐시와 저장 레벨, broadcast 조인과 AQE, salting, DAG와 쿼리 계획 읽기 영상 | Spark 일반 강의다. Sarah Chua 후기가 추천 |
| Spark: The Definitive Guide | 책. Databricks가 일부 장을 무료 발췌본으로 배포 | 미반영 | 예제 저장소의 마지막 push가 2020-08-26 | Spark Connect(3.4), pandas API on Spark 이전 |
| Learning Spark 2판 | 책 | 미반영(Spark 3.0) | 예제 저장소 LearningSparkV2의 마지막 push가 2025-01-28 | Databricks의 예전 무료 배포 주소는 2026년 10월 현재 다른 eBook 페이지로 넘어간다 |
| Packt 책과 예제 저장소 | 책 | 미반영 | 저장소 마지막 push 2024-06-13 | Structured Streaming을 범위 밖으로 둔다(Ch-00 참고) |
| Spark By Examples | 웹 | 글마다 다름 | 버전 표기가 없는 글이 많다 | 2026년 10월 열람 시 cache와 persist 비교 글은 회원 전용이었다 |

유료 모의고사를 고를 때는 네 가지를 봤습니다. 설명에 Spark Connect와 pandas API on Spark가 영역으로 들어 있는지, 마지막 갱신일이 2025년 4월 이후인지, 문항을 직접 썼다고 밝히는지, 해설에 공식 문서 링크가 붙는지입니다. "실제 시험 문항"이나 "기출"을 내세우는 상품은 9절의 약관 문제 때문에 고르지 않습니다. 안내서 샘플 문항은 공개된 공식 자료라서 7-2절에 해설의 요점만 인용했습니다. 문항 전체는 안내서 PDF에서 직접 풉니다.

## 4. 실습 환경 구성

이 노트북에는 Java가 없어서 PySpark를 바로 띄울 수 없습니다. Java를 컨테이너나 원격 런타임에 맡기는 방법을 두 가지 확인했고 Free Edition과 역할을 나눴습니다. 아래 명령은 모두 공식 문서와 이미지 정의를 읽고 적은 것이고 이 환경에서 Docker나 Java로 실행하지 않았습니다.

| 환경 | 맡길 일 | Java | 비고 |
|---|---|---|---|
| Docker `spark:python3` | Spark UI, 캐시와 저장 레벨, RDD와 accumulator, 로그, Spark Connect 서버 | 이미지 안(Java 21) | Spark 4.2.0. 3.5 동작 비교는 `spark:3.5.9-python3` |
| Docker `quay.io/jupyter/pyspark-notebook` | pandas API on Spark, pandas UDF를 노트북으로 | 이미지 안(OpenJDK 21) | pandas와 pyarrow, grpcio 포함 |
| Google Colab | 설치 없이 DataFrame API와 SQL 연습 | 런타임에 OpenJDK 21 | 2026-10-03 기준 PySpark 4.0.4 기본 설치 |
| Databricks Free Edition | Spark Connect 기반 서버리스 체감, Delta 파일에 SQL | 필요 없음 | Spark UI, `cache()`, RDD 불가([Ch-00](/blog/cert/spark/spark-00-exam-and-study-plan) 4절) |

### 4-1. Docker 공식 이미지

Docker Official Image 문서는 PySpark 셸을 이렇게 띄우라고 적습니다. 태그 `python3`는 2026년 10월 현재 `4.2.0-scala2.13-java21-python3-ubuntu`를 가리킵니다.

```bash
# 문서 원문 명령
docker run -it spark:python3 /opt/spark/bin/pyspark

# Spark UI(4040)를 보려고 포트를 연 형태. --rm과 -p는 Docker 일반 옵션이고 문서 명령에 덧붙인 것
docker run -it --rm -p 4040:4040 spark:python3 /opt/spark/bin/pyspark
```

셸이 뜨면 `spark.range(1000 * 1000 * 1000).count()`가 1,000,000,000을 돌려준다고 문서가 적습니다. 그 Job을 브라우저의 `localhost:4040`에서 열어 Ch-01의 Job, Stage, Task와 Ch-04의 Executors 탭을 따라가면 됩니다. Apache Spark 프로젝트가 따로 올리는 `apache/spark` 이미지도 같은 방식(`docker run -it apache/spark /opt/spark/bin/pyspark`)으로 씁니다.

이미지의 Python 레이어는 `python3`와 `python3-pip`만 설치합니다. pandas와 pyarrow가 들어 있다는 내용은 Dockerfile에 없어서 pandas API와 pandas UDF는 다음 이미지로 넘깁니다.

### 4-2. Jupyter pyspark-notebook

Jupyter Docker Stacks 문서의 예시 명령입니다. 이 이미지는 2023년 10월 20일부터 Quay.io에만 올라가고 Docker Hub의 `jupyter/` 이미지는 더 갱신되지 않습니다.

```bash
docker run --detach -p 8888:8888 -p 4040:4040 -p 4041:4041 quay.io/jupyter/pyspark-notebook
```

Dockerfile은 OpenJDK 21과 최신 Spark를 받고 Spark 버전에 맞춘 pandas, pyarrow, grpcio를 설치합니다. SparkContext가 새로 생길 때마다 UI 포트가 4040, 4041로 올라가서 포트를 여러 개 열어 두라고 문서가 적습니다. 노트북 주소의 토큰은 `docker logs`로 확인합니다.

### 4-3. Spark Connect 서버를 컨테이너에, 클라이언트를 노트북에

Ch-06의 Spark Connect는 이 조합이 가장 직관적입니다. Spark 4.0.0부터 `start-connect-server.sh`에 `--wait` 옵션이 생겨 서버가 포그라운드에서 돕니다(소스의 `SPARK_NO_DAEMONIZE` 처리). 컨테이너의 메인 프로세스로 쓰기 알맞습니다.

```bash
# 컨테이너: Connect 서버(기본 포트 15002). 인증 토큰이 기본으로 없으니 로컬 주소에만 연다
docker run -it --rm -p 127.0.0.1:15002:15002 -p 4040:4040 spark:python3 \
  /opt/spark/sbin/start-connect-server.sh --wait

# 노트북: 순수 Python 클라이언트. 설치 문서는 JAR와 JRE가 필요 없다고 적는다
pip install pyspark-client==4.2.0
```

```python
from pyspark.sql import SparkSession

spark = SparkSession.builder.remote("sc://localhost:15002").getOrCreate()
orders = spark.createDataFrame([(1, "PAID", 32000), (2, "CANCELLED", 15000)],
                               "order_id INT, status STRING, amount INT")
orders.groupBy("status").count().show()
# spark.sparkContext  -> Connect 세션이라 쓸 수 없다(Ch-06 3절)
```

`pyspark-client`는 4.0.0에 처음 PyPI에 올라왔고 `spark.remote`와 접속 문자열만 지원합니다. 서버 바인딩 주소(`spark.connect.grpc.binding.address`)를 지정하지 않으면 서버가 모든 인터페이스에서 받는 것을 소스에서 확인했습니다. 그래서 포트 매핑을 `127.0.0.1`로 묶었습니다.

### 4-4. Google Colab

Colab이 공개하는 런타임 패키지 목록(googlecolab/backend-info, 2026-10-03 커밋)에 `pyspark==4.0.4`, `pandas==2.2.3`, `pyarrow==23.0.1`과 `openjdk-21-jdk-headless`가 설치되어 있습니다. 예전 블로그 글처럼 Java 8을 apt로 깔고 `JAVA_HOME`을 맞추는 단계는 지금 목록 기준으로 필요 없어 보입니다. 다만 런타임 구성은 Colab이 수시로 바꾸니 첫 셀에서 확인합니다.

```python
!java -version
!pip show pyspark | head -2
from pyspark.sql import SparkSession
spark = SparkSession.builder.master("local[*]").getOrCreate()
spark.version
```

Colab에서 Spark UI 포트를 브라우저로 여는 방법은 이번에 확인하지 못했습니다. Spark UI를 봐야 하는 Ch-01과 Ch-04 실습은 Docker 쪽에 둡니다.

## 5. 새 시험 후기 두 건에서 나온 경향

2025년 개편 뒤 시험을 실제로 보고 쓴 글 가운데 이 글에 넣은 것은 두 건입니다. Reddit은 이번 조사 환경에서 열리지 않아 확인하지 못했고 LinkedIn, DEV, velog, tistory, CSDN, 知乎, Zenn에서는 새 시험 후기를 찾지 못했습니다. 예전 60문항 시험 후기, 문항 모음 사이트를 권하는 글, 연습 문제가 실제 문항과 거의 같았다고 밝힌 글은 뺐습니다.

| 글 | 시험과 결과 | 준비 | 주제 수준 관찰 |
|---|---|---|---|
| Sarah Chua, Medium(2025-09-03) | 시험장 응시. 채점 45문항에 채점하지 않는 10문항이 더 나왔고 시간 안에 마쳤다. 제출 직후 영역별 정답률과 합격 여부가 나왔다 | 당시 새 시험용 강의가 없어 안내서 항목마다 문서와 글, 영상을 찾았다. Afaque Ahmad 영상, 시험 직전 주말에 Udemy 모의고사 5회 | 모의고사가 실제와 관련이 많았지만 일부 답과 해설이 미심쩍었다. Python 전용 |
| Databricks 커뮤니티 "Seeking Guidance for Spark Certification"(2025-07~08) | 응시자 한 명이 "quite difficult"라고 적음 | 공식 과정을 들었다 | 과정은 항목마다 예제가 하나뿐이라 실제 문항이 더 넓고 어렵다고 느꼈다. 다른 사용자는 Free Edition에서 Spark UI를 볼 수 없어 과정 일부를 못 따라갔다 |

두 글과 공식 안내서를 함께 놓고 정리한 경향은 넷입니다.

- 화면에 보이는 문항 수는 45개보다 많을 수 있습니다. Sarah Chua는 채점 문항 45개에 채점하지 않는 문항 10개를 더 받아 55문항을 풀었고 2026년 10월판 안내서도 "최대 55문항"이라고 적습니다. 어느 문항이 채점되지 않는지 표시되지 않으니 모든 문항을 같은 무게로 풉니다.
- 비중이 작은 영역은 한 문항의 무게가 큽니다. 공식 비중으로 Spark Connect와 pandas API on Spark는 각각 5%라서 45문항으로 환산하면 2문항 남짓입니다(공식 문항 수는 공개되지 않았습니다). 문항이 적어 하나만 틀려도 영역 점수가 크게 흔들립니다. [Ch-06](/blog/cert/spark/spark-06-connect-pandas-api)의 배포 모드와 pandas UDF 시그니처를 따로 외워 둘 이유입니다.
- Spark UI를 읽는 문항이 범위에 있습니다. 안내서 샘플 2번은 Spark UI의 Stages 탭에서 익스큐터 로그를 찾는 문항이고 4영역 목표도 드라이버와 익스큐터 로그로 메모리 부족과 저사용을 진단하라고 적습니다. 화면 구성은 직접 열어 봐야 익숙해지니 4절의 Docker 환경에서 4040 포트를 열어 Jobs, Stages, Executors 탭과 DAG를 보는 시간을 8절 계획에 넣었습니다.
- 준비 범위가 공식 과정 바깥으로 넓어졌습니다. 커뮤니티 응시자는 과정만으로 부족했다고 적었고 Sarah Chua는 안내서 항목마다 문서를 찾아 읽었습니다.

Parquet 스키마 병합은 이 시리즈에서 다루지 않았지만 2영역의 파일 읽기와 겹쳐서 기본값을 적어 둡니다. 공식 문서 기준으로 1.5.0부터 기본으로 꺼져 있고 읽기 옵션 `mergeSchema`를 `true`로 주거나 SQL 설정 `spark.sql.parquet.mergeSchema`(기본 `false`)를 `true`로 바꿔 켭니다.

## 6. 시험 전날 외울 기본값 체크리스트

전날 이 표 한 장만 다시 봅니다. 출처는 각 Ch의 공식 문서 인용이고 Spark 4.2.0 문서 기준입니다.

| 영역 | 외울 것 | Ch |
|---|---|---|
| 아키텍처 | 액션 1개가 Job 1개, 셔플 경계에서 Stage가 나뉘고 파티션마다 Task 1개 | [Ch-01](/blog/cert/spark/spark-01-architecture) |
| 아키텍처 | `explain()`, `printSchema()`, `cache()`는 Job을 만들지 않는다 | [Ch-01](/blog/cert/spark/spark-01-architecture) |
| 아키텍처 | DataFrame `cache()`는 `MEMORY_AND_DISK_DESER`, RDD `cache()`는 `MEMORY_ONLY`, `spark.catalog.cacheTable()`은 `MEMORY_AND_DISK` | [Ch-01](/blog/cert/spark/spark-01-architecture) |
| 아키텍처 | 통합 메모리는 (힙 - 300MiB)의 60%(`spark.memory.fraction`), 그 절반이 저장 보호 구간(`spark.memory.storageFraction` 0.5) | [Ch-01](/blog/cert/spark/spark-01-architecture) |
| 아키텍처 | 배포 모드 client(기본), cluster, local. local은 드라이버와 익스큐터가 한 JVM | [Ch-06](/blog/cert/spark/spark-06-connect-pandas-api) |
| 파티션 | `spark.sql.shuffle.partitions` 200, `spark.sql.files.maxPartitionBytes` 128MB | [Ch-04](/blog/cert/spark/spark-04-troubleshooting-tuning) |
| 파티션 | `coalesce`는 셔플 없이 줄이기만, `repartition`은 전체 셔플로 늘리고 줄이기 | [Ch-04](/blog/cert/spark/spark-04-troubleshooting-tuning) |
| 튜닝 | AQE는 3.2.0부터 기본 켜짐. 쏠림 판정은 중앙값 5배 초과이면서 256MB 초과 | [Ch-04](/blog/cert/spark/spark-04-troubleshooting-tuning) |
| 튜닝 | `spark.sql.autoBroadcastJoinThreshold` 10MB, -1이면 끔 | [Ch-04](/blog/cert/spark/spark-04-troubleshooting-tuning) |
| 튜닝 | 익스큐터 로그는 Spark UI의 Executors 탭이나 Stage 상세의 Task 표에서. Web UI 기본 포트 4040 | [Ch-04](/blog/cert/spark/spark-04-troubleshooting-tuning) |
| SQL | 저장 모드 기본 `errorifexists`. 나머지는 append, overwrite, ignore | [Ch-02](/blog/cert/spark/spark-02-spark-sql) |
| SQL | 형식 기본 `parquet`. CSV `header`와 `inferSchema` 기본 false. JSON은 한 줄에 객체 하나 | [Ch-02](/blog/cert/spark/spark-02-spark-sql) |
| SQL | `bucketBy`와 `sortBy`는 `saveAsTable` 전용, `partitionBy`는 둘 다 | [Ch-02](/blog/cert/spark/spark-02-spark-sql) |
| SQL | 임시 뷰는 SparkSession 수명, 전역 임시 뷰는 `global_temp.이름` | [Ch-02](/blog/cert/spark/spark-02-spark-sql) |
| SQL | Parquet `mergeSchema` 기본 false | 5절 |
| DataFrame | `withColumn(이름, Column)`, `withColumnRenamed(기존, 새)`. 없는 컬럼의 `drop`과 rename은 오류 없이 무시 | [Ch-03](/blog/cert/spark/spark-03-dataframe-api) |
| DataFrame | `na.drop()` 기본 `how='any'`. `thresh`를 주면 `how` 무시 | [Ch-03](/blog/cert/spark/spark-03-dataframe-api) |
| DataFrame | `F.count(col)`은 null 제외, `count(*)`와 `df.count()`는 전체 | [Ch-03](/blog/cert/spark/spark-03-dataframe-api) |
| DataFrame | `approx_count_distinct` 기본 상대 오차 0.05 | [Ch-03](/blog/cert/spark/spark-03-dataframe-api) |
| DataFrame | `join` 기본 `inner`. `on`에 이름을 주면 키 컬럼 하나, 조건식을 주면 둘 | [Ch-03](/blog/cert/spark/spark-03-dataframe-api) |
| DataFrame | `union`과 `unionAll`은 위치로 맞추고 중복 유지. 이름으로는 `unionByName` | [Ch-03](/blog/cert/spark/spark-03-dataframe-api) |
| DataFrame | `from_unixtime` 기본 형식 `yyyy-MM-dd HH:mm:ss`. `udf` 반환 타입 기본 `StringType` | [Ch-03](/blog/cert/spark/spark-03-dataframe-api) |
| DataFrame | null 비교는 `col.isNull()`. `col == None`은 아무 행도 통과하지 못한다 | [Ch-03](/blog/cert/spark/spark-03-dataframe-api) |
| Streaming | 출력 모드 기본 Append. 워터마크 없는 집계는 Complete와 Update만, 집계 없는 쿼리는 Complete 불가 | [Ch-05](/blog/cert/spark/spark-05-structured-streaming) |
| Streaming | 파일 싱크 exactly-once, Kafka와 foreach 싱크 at-least-once | [Ch-05](/blog/cert/spark/spark-05-structured-streaming) |
| Streaming | 워터마크 없는 `dropDuplicates`는 상태를 계속 쌓는다. `dropDuplicatesWithinWatermark`는 3.5.0부터 | [Ch-05](/blog/cert/spark/spark-05-structured-streaming) |
| Connect | `sc://host:15002`, gRPC로 논리 계획을 보내고 Arrow로 받는다. `SparkContext`와 RDD 불가 | [Ch-06](/blog/cert/spark/spark-06-connect-pandas-api) |
| pandas | 기본 인덱스 `distributed-sequence`. `to_pandas()`는 드라이버로 모은다 | [Ch-06](/blog/cert/spark/spark-06-connect-pandas-api) |
| pandas | pandas UDF는 타입 힌트로 종류를 정한다(Series→Series, Iterator, Series→스칼라). Arrow 기본값은 4.2부터 true, 3.5까지 false | [Ch-06](/blog/cert/spark/spark-06-connect-pandas-api) |

버전에 따라 갈리는 항목(ANSI 모드, Arrow 기본값, Python UDF의 Arrow 사용)은 시험이 기준 버전을 밝히지 않아서 보기에 버전 단서가 있는지 먼저 봅니다. 이 판단 순서는 [Ch-03](/blog/cert/spark/spark-03-dataframe-api) 4-2절과 [Ch-06](/blog/cert/spark/spark-06-connect-pandas-api) 9절에 적었습니다.

## 7. 시험 당일 전략

### 7-1. 시간 배분

90분에 최대 55문항이면 문항당 평균 약 98초입니다. 채점 문항 45개만 세면 2분이지만 어느 문항이 채점되는지 알 수 없어 55문항 기준으로 잡았습니다.

| 구간 | 할 일 |
|---|---|
| 0~60분 | 1차로 전부 푼다. 문항당 1분 안팎. 2분이 넘어가면 가장 그럴듯한 보기를 고르고 넘어간다 |
| 60~85분 | 확신하지 못한 문항만 다시 읽는다. 코드 문항은 반환 타입부터 다시 따라간다 |
| 85~90분 | 빈 답이 없는지 확인한다 |

후기 두 건에는 문항당 시간을 적은 내용이 없었고 Sarah Chua는 시간 안에 모두 마쳤다고만 적었습니다. 문항에 표시(flag)를 남기거나 앞 문항으로 돌아가는 기능이 있는지는 공식 문서에서 확인하지 못했습니다. 시험 중 메모는 약관으로 금지라서 다시 볼 문항 번호를 적어 둘 수도 없습니다. 표시 기능이 없으면 1차에서 일단 답을 고르고 검토 구간에 화면을 처음부터 넘기는 수밖에 없습니다.

### 7-2. 코드 읽기 순서

API 문서가 없으니 보기 네 개를 눈으로 실행해야 합니다. 안내서 샘플 해설이 오답을 설명하는 방식에서 순서를 가져왔습니다.

1. 존재하지 않는 메서드와 인자부터 지웁니다. 샘플 4번 해설은 `schema()`(실제로는 속성), `toList()`, `descending=True`를 없는 것으로 짚습니다. `sort`와 `orderBy`의 내림차순은 `ascending=False`나 `col.desc()`입니다.
2. 인자 순서를 확인합니다. 샘플 3번의 오답은 `withColumnRenamed("state", "division")`처럼 기존 이름과 새 이름을 뒤집었습니다.
3. 체인 끝의 반환 타입을 따라갑니다. `show()`는 `None`을 돌려주니 그 뒤에 이어 붙인 코드는 틀립니다. `collect()`는 `Row` 리스트, `take(n)`도 리스트입니다.
4. 기본값이 답을 가르는지 봅니다. 샘플 6번은 `na.drop()`의 기본 `how='any'`와 `"all"`의 차이를 묻습니다.
5. 스트리밍 문항은 쿼리 모양(집계 여부, 워터마크 유무)을 먼저 적용 가능한 출력 모드에 대 봅니다.

예를 들어 쇼핑몰 주문 DataFrame을 금액 내림차순으로 정렬해 상위 3건을 리스트로 받는 보기가 있다면 `orders.orderBy(F.col("amount").desc()).limit(3).collect()`는 리스트가 되고 `orders.sort("amount", descending=True).show(3)`은 없는 인자를 쓰고 반환값도 `None`이라 두 번 틀립니다.

### 7-3. 응시 전후

- 온라인이면 전날 시스템 체크와 Readiness 점검을 같은 컴퓨터, 같은 네트워크로 마칩니다. Kryterion 권장대로 개인 컴퓨터를 씁니다.
- 책상 위를 비우고 모니터를 하나만 연결합니다. 문제는 속으로 읽습니다.
- 시험장이면 신분증 2개를 챙기고 72시간 규칙을 기억합니다. Sarah Chua는 장비 호환성과 방 스캔 걱정을 덜려고 시험장을 골랐습니다.
- 제출하면 영역별 정답률이 바로 나옵니다. 떨어지면 그 표로 약한 영역을 정해 14일 뒤 재응시를 계획합니다.

## 8. D-30 마무리 계획

시험일을 먼저 잡고 거꾸로 셉니다. 이 계획은 Ch-00 6절의 공부 계획 중 마지막 단계(모의고사)를 30일로 펼친 것입니다.

| 기간 | 할 일 | 끝났다고 보는 기준 |
|---|---|---|
| D-30 ~ D-22 | 안내서 샘플 10문항을 풀고 틀린 영역을 적는다. Docker 환경을 띄워 Ch-01과 Ch-03의 예제를 재현한다 | 4040 포트에서 Job과 Stage를 찾아 설명한다 |
| D-21 ~ D-15 | Ch-02와 Ch-04. 쏠린 데이터로 AQE 전후 계획을 비교하고 DAG와 SQL 탭을 읽는다 | 저장 모드 네 개와 `explain` 모드를 문서 없이 쓴다 |
| D-14 | 안내서를 다시 내려받아 판이 바뀌었는지 본다 | 바뀐 항목이 있으면 계획에 넣는다 |
| D-14 ~ D-8 | Ch-05와 Ch-06. 파일 소스 스트리밍, 컨테이너 Connect 서버, pandas UDF | 영역마다 쓸 수 없는 것과 이유를 말한다 |
| D-7 ~ D-3 | AI Prep Guide 4단계 루프의 Practice(전체 모의고사)와 새 범위가 들어간 연습 문제를 시간을 재고 푼다. 오답은 6절 표의 해당 Ch로 돌아가 확인한다 | 55문항 기준 60분 안에 1차를 마친다 |
| D-2 | 온라인이면 시스템 체크, 시험장이면 위치와 신분증 확인 | 점검 화면을 끝까지 통과한다 |
| D-1 | 6절 체크리스트만 본다 | 표를 가리고 기본값을 말한다 |

Learning Festival 바우처를 쓰려면 행사 기간 안에 경로를 끝내고 약 90일 안에 응시해야 합니다. 2026년 9~10월 회차 바우처라면 2027년 1월 17일 전이 마감입니다.

## 9. 덤프와 Databricks 약관

Databricks 자격증 약관(Effective Date: June 11, 2024)은 시험 내용을 기밀 정보로 정의합니다. 문항, 정답, 시험에 관한 모든 의사소통이 들어갑니다. 금지 행위 목록에 다음 항목이 있습니다.

- "Using unauthorized materials (including brain-dump material and/or unauthorized publication of Exam questions"
- "Disseminating actual Exam content by any means including but not limited to web postings"
- "Making notes of any kind during the Exam"

위반이 확인되면 Databricks 자격증을 모두 잃고 다른 Databricks 시험도 볼 수 없게 될 수 있다고 적습니다. 위반이 의심될 때도 Databricks 재량으로 자격증을 취소할 수 있다는 문장이 있습니다. Kryterion 문서도 시험 내용을 얻거나 복제하려는 시도는 확인되든 의심되든 즉시 시험 중단 사유라고 적습니다.

그래서 이 시리즈의 확인 문제는 전부 직접 만들었고 실제 문항을 기억해 옮긴 자료나 그런 자료를 모은 사이트는 이름도 링크도 남기지 않습니다. 후기를 고를 때도 그런 자료를 썼다고 밝히거나 권한 글은 뺐습니다. 실용적인 이유도 있습니다. 안내서는 판이 바뀔 때마다 범위가 달라집니다. FAQ는 비공식 모의고사 결과가 실제 시험만큼 엄격하지 않아 오해를 부른다고 적습니다. Spark를 실제로 이해하면 판이 바뀌어도 그대로 쓸 수 있습니다.

## 10. 범위와 한계

- 시험 정보는 2026년 10월 20일에 Databricks 자격증 페이지, FAQ, 약관, 2026년 10월 8일판과 2025년 10월 30일판 안내서로 확인했습니다.
- 4절의 Docker와 Colab 명령은 이 환경에서 실행하지 않았습니다. 이 노트북에 Java가 없고 이번 작업에서 Docker도 돌리지 않았습니다. 이미지 문서, Dockerfile, Spark 소스, Colab 패키지 목록을 읽고 적었습니다.
- 다음 Learning Festival 날짜, Udemy 강의의 2025년 11월 갱신 내용, Colab에서 Spark UI를 여는 방법, 시험 화면의 문항 표시 기능은 확인하지 못했습니다.
- Udemy 페이지는 접속이 막혀 일부를 읽기 도구와 검색 결과 요약으로만 봤습니다. Medium 글은 RSS로 본문을 확인했습니다. Reddit은 이 환경에서 열리지 않았습니다.
- 새 시험 후기는 두 건뿐이라 5절의 경향은 표본이 작습니다. 그래서 5절의 영역 비중 판단은 공식 안내서 수치에서 가져왔습니다.
- 과정 가격과 Academy Labs 가격은 카탈로그와 커뮤니티 매니저 답변 기준이고 지역과 시점에 따라 다를 수 있습니다.

## 참고 자료

공식 자료
- Databricks, [Databricks Certified Associate Developer for Apache Spark](https://www.databricks.com/learn/certification/apache-spark-developer-associate)
- Databricks, [Exam Guide, 2026-10-08판(파일명 august-2026)](https://www.databricks.com/sites/default/files/2026-10/databricks-certified-associate-developer-apache-spark-exam-guide-august-2026.pdf), [Exam Guide, Oct 2025](https://www.databricks.com/sites/default/files/2025-10/databricks-certified-associate-developer-apache-spark-exam-guide-oct-2025.pdf)
- Databricks, [AI Prep Guide: Any Databricks Certification](https://www.databricks.com/sites/default/files/2026-06/ai-prep-guide-any-databricks-certification.pdf)
- Databricks, [Certification and Badging FAQ](https://www.databricks.com/learn/certification/faq), [Terms and Conditions](https://www.databricks.com/learn/certification/terms-and-conditions)
- Databricks Training Catalog: [Apache Spark Programming with Databricks](https://www.databricks.com/training/catalog/apache-spark-programming-with-databricks-134), [Introduction to Apache Spark](https://www.databricks.com/training/catalog/introduction-to-apache-spark-3898), [Developing Applications with Apache Spark](https://www.databricks.com/training/catalog/developing-applications-with-apache-spark-3957), [Stream Processing and Analysis with Apache Spark](https://www.databricks.com/training/catalog/stream-processing-and-analysis-with-apache-spark-3944), [Monitoring and Optimizing Apache Spark Workloads on Databricks](https://www.databricks.com/training/catalog/monitoring-and-optimizing-apache-spark-workloads-on-databricks-3990)
- Databricks, [Introducing Databricks Free Edition](https://www.databricks.com/blog/introducing-databricks-free-edition), 2025-06-11
- Databricks, [Spark: The Definitive Guide (발췌본 페이지)](https://pages.databricks.com/definitive-guide-spark.html)

Learning Festival
- Databricks Community, [FAQ for Databricks Learning Festival (Virtual): 10 October - 31 October 2025](https://community.databricks.com/t5/databricks-academy-learners/faq-for-databricks-learning-festival-virtual-10-october-31/td-p/128193)
- Databricks Community, [Self-Paced Learning Festival: 09 January - 30 January 2026](https://community.databricks.com/t5/learning-events/self-paced-learning-festival-09-january-30-january-2026/ec-p/147822)
- Databricks Community, [Databricks Learning Festival (Self-paced): Global](https://community.databricks.com/t5/learning-events/databricks-learning-festival-self-paced-global/ev-p/150223), [FAQ for Virtual Learning Festival: 16 March - 03 April 2026](https://community.databricks.com/t5/training-offerings/faq-for-virtual-learning-festival-16-march-03-april-2026/m-p/150220)
- Databricks Community, [Advanced Learning Festival: 15 June - 06 July 2026](https://community.databricks.com/t5/learning-events/advanced-learning-festival-15-june-06-july-2026/ev-p/156932), [FAQ for Virtual Advanced Learning Festival: 15 June - 06 July 2026](https://community.databricks.com/t5/training-offerings/faq-for-virtual-advanced-learning-festival-15-june-06-july-2026/td-p/156697)
- Databricks Community, [Databricks Advanced Learning Festival: September 16 - October 14](https://community.databricks.com/t5/learning-events/databricks-advanced-learning-festival-september-16-october-14/ev-p/166157), [FAQ for Advanced Learning Festival September 16 - October 14 2026](https://community.databricks.com/t5/databricks-academy-learners/faq-for-advanced-learning-festival-september-16-october-14-2026/td-p/166151)
- Databricks Community, [Learning Festival events - 2026](https://community.databricks.com/t5/certifications/learning-festival-events-2026/td-p/153478)

Kryterion
- Kryterion, [Online Testing Requirements: What You Need to Know](https://support.kryterion.com/en_us/online-testing-requirements:-what-you-need-to-know-ry42HLJsJl.md)
- Kryterion, [Online Proctored Exams and Behaviors to Consider](https://support.kryterion.com/en_us/online-proctored-exams-and-behaviors-to-consider-BJ7nBU1j1e.md)
- Kryterion, [How to Launch an Online Proctored (OLP) Exam](https://support.kryterion.com/en_us/how-to-launch-an-online-proctored-olp-exam-Byr5BLJi1e.md)
- Kryterion, [What Type of Identification Must I Bring to the Testing Center?](https://support.kryterion.com/en_us/what-type-of-identification-must-i-bring-to-the-testing-center-HJKCH8JjJx.md)
- Kryterion, [What to Bring on Test Day: A Complete Guide to Kryterion ID Requirements](https://www.kryterion.com/blog/what-to-bring-on-test-day-a-complete-guide-to-kryterion-id-requirements/), 2025-11-28

커뮤니티 답변
- Databricks Community, [Official practice exams for -- Databricks Certified Associate Developer for Apache Spark - Python](https://community.databricks.com/t5/certifications/official-practice-exams-for-databricks-certified-associate/td-p/125642), 2025
- Databricks Community, [Acedemy Labs - "Included" courses free or charge?](https://community.databricks.com/t5/training-offerings/acedemy-labs-quot-included-quot-courses-free-or-charge/td-p/138082), 2025
- Databricks Community, [Databricks Exam got suspended due to a power cut](https://community.databricks.com/t5/certifications/databricks-exam-got-suspended-due-to-a-power-cut/td-p/154939), 2026

후기
- Sarah Chua, [Databricks Certified Associate Developer for Apache Spark — 2025](https://sarahchua-sg.medium.com/databricks-certified-associate-developer-for-apache-spark-2025-a1d39fd9808d), Medium, 2025-09-03
- Databricks Community, [Seeking Guidance for Spark Certification](https://community.databricks.com/t5/certifications/seeking-guidance-for-spark-certification/td-p/125639), 2025

연습 자료
- Udemy, [Databricks Certified Developer for Spark Practice Exams 2025](https://www.udemy.com/course/databricks-certified-developer-for-apache-spark-30-practice-exams/) (Florian Roscheck)
- Afaque Ahmad, [YouTube 채널](https://www.youtube.com/@afaqueahmad7117)
- GitHub, [databricks/LearningSparkV2](https://github.com/databricks/LearningSparkV2), [databricks/Spark-The-Definitive-Guide](https://github.com/databricks/Spark-The-Definitive-Guide), [PacktPublishing/Databricks-Certified-Associate-Developer-for-Apache-Spark-Using-Python](https://github.com/PacktPublishing/Databricks-Certified-Associate-Developer-for-Apache-Spark-Using-Python)
- Apache Spark, [PySpark Getting Started(Live Notebook 링크 포함)](https://spark.apache.org/docs/latest/api/python/getting_started/index.html)

실습 환경
- Docker Official Images, [spark README](https://github.com/docker-library/docs/blob/master/spark/README.md)
- Apache, [apache/spark-docker OVERVIEW](https://github.com/apache/spark-docker/blob/master/OVERVIEW.md), [4.2.0 python3 Dockerfile](https://github.com/apache/spark-docker/blob/master/4.2.0/scala2.13-java21-python3-ubuntu/Dockerfile)
- Apache Spark, [sbin/start-connect-server.sh](https://github.com/apache/spark/blob/v4.2.0/sbin/start-connect-server.sh), [Spark Connect Overview](https://spark.apache.org/docs/latest/spark-connect-overview.html), [PySpark 설치(Python Spark Connect Client)](https://spark.apache.org/docs/latest/api/python/getting_started/install.html), [Parquet Files](https://spark.apache.org/docs/latest/sql-data-sources-parquet.html)
- Jupyter Docker Stacks, [docs/using/specifics.md](https://github.com/jupyter/docker-stacks/blob/main/docs/using/specifics.md), [pyspark-notebook Dockerfile](https://github.com/jupyter/docker-stacks/blob/main/images/pyspark-notebook/Dockerfile)
- Google Colab, [googlecolab/backend-info](https://github.com/googlecolab/backend-info)

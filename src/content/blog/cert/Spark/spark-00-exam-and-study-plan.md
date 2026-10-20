---
title: '[Spark Ch-00] Databricks Spark 자격증 시험 구조와 공부 계획: API 문서 없이 기본값까지 외워야 하는 시험'
description: Databricks Certified Associate Developer for Apache Spark는 90분 동안 채점 문항 45개를 푸는 Python 전용 시험이고 2025년에 범위가 크게 바뀌었습니다. 공식 페이지와 2025년 10월판 시험 안내서로 영역별 비중과 출제 항목을 정리하고, 자주 헷갈리는 동작을 Spark 공식 문서 기준으로 확인한 뒤, 실습 환경의 제약과 응시 후기를 바탕으로 공부 계획을 세웁니다.
date: 2026-10-19T00:00:00.000Z
tags:
  - Spark
  - Databricks
  - PySpark
  - Certification
  - Study Plan
category: cert/Spark
topics:
  - cert
draft: false
series: "Spark 공부"
seriesOrder: 0
---

## 결론부터

1. 시험은 채점 문항 45개, 90분, 200 USD이고 영어로만 칩니다. 합격 점수는 공개하지 않습니다. 인터넷에 도는 "70%"와 "60문항, 120분"은 2025년 4월에 폐지된 예전 시험 기준입니다.
2. 새 시험은 API 문서를 제공하지 않습니다. 예전 시험은 검색이 안 되는 문서라도 볼 수 있었습니다. 그래서 함수 시그니처와 기본값(저장 모드, 캐시 저장 레벨, union이 컬럼을 맞추는 방식 등)을 외워야 합니다.
3. 비중은 DataFrame API 30%, 아키텍처 20%, Spark SQL 20%, 튜닝 10%, Structured Streaming 10%, Spark Connect 5%, pandas API on Spark 5%입니다. Streaming, Connect, pandas API는 예전 책과 강의에 없거나 범위 밖으로 되어 있습니다.
4. Databricks Free Edition은 서버리스 컴퓨트만 줍니다. Spark UI, `cache()`, RDD API를 쓸 수 없어서 출제 항목 일부는 거기서 실습할 수 없습니다. 로컬에 PySpark를 깔아 같이 씁니다. Community Edition은 2026년 1월 1일에 종료됐습니다.
5. 공부 순서는 시험 안내서의 항목을 하나씩 공식 문서로 확인하고, 로컬에서 코드로 재현해 이 시리즈에 정리하는 것입니다. 새 시험 후기가 아직 적어서 강의 하나에 기대기 어렵습니다.

---

## 1. 시험 구조

Databricks 자격증 페이지, 자격증 FAQ, 2025년 10월판 시험 안내서로 확인했습니다(2026년 10월 기준).

| 항목 | 내용 |
|---|---|
| 문항 | 채점 문항 45개. 채점하지 않는 문항이 추가로 나올 수 있고 그만큼 시간이 더 주어진다 |
| 시간 | 90분 |
| 언어 | 영어. 코드는 Python |
| 가격 | 200 USD. 재응시도 같은 가격이고 무료 재응시는 없다 |
| 합격 점수 | 공개하지 않는다. FAQ는 통계적으로 정하고 바뀔 수 있어서 공개하지 않는다고 적는다 |
| 재응시 | 마지막 응시 후 14일 이상 지나야 한다. 횟수 제한은 없다 |
| 응시 | Webassessor로 등록하고 Kryterion이 감독한다. 온라인 또는 시험장 |
| 보조 자료 | API 문서를 포함해 제공하지 않는다 |
| 권장 경험 | Spark 실무 6개월 이상 |
| 결과 | 비공식 결과는 제출 직후 나온다 |

시험장 응시를 다시 예약하려면 72시간 전까지 해야 합니다. 응시 후기(Sarah Chua, 2025)에 따르면 제출 직후 주제별 정답률과 합격 여부가 화면에 나왔고, 45문항 외에 채점하지 않는 문항 10개가 더 나왔습니다.

### 1-1. 2025년에 무엇이 바뀌었나

| | 예전 시험(Spark 3.0) | 지금 시험 |
|---|---|---|
| 상태 | 2025년 4월 15일 등록 마감, 폐지 | 2025년 4월판 안내서부터 |
| 문항과 시간 | 60문항, 120분 | 45문항, 90분 |
| 합격선 | 70%로 공개 | 공개하지 않음 |
| 시험 중 문서 | 제공(검색 불가) | 제공하지 않음 |
| 범위 | 아키텍처와 DataFrame API 중심 | Streaming, Spark Connect, pandas API on Spark 추가 |

시험이 기준으로 하는 Spark 버전(3.5인지 4.x인지)은 공식 페이지와 안내서 어디에도 없습니다. 안내서는 "Apache Spark"라고만 씁니다. 버전을 적은 곳은 상업 강의 페이지뿐이었습니다. 이 글의 동작 설명은 열람 시점의 Spark 공식 문서(4.2.0) 기준이고, 버전 사이에 바뀐 동작은 따로 표시했습니다.

## 2. 영역과 출제 항목

비중은 자격증 페이지에 있고, 항목은 2025년 10월판 안내서를 요약했습니다.

| 영역 | 비중 | 항목 |
|---|---|---|
| 1. 아키텍처와 구성 요소 | 20% | 드라이버, 익스큐터, 코어, 메모리의 역할 / 실행 계층(Job, Stage, Task) / 셔플과 파티션 / 트랜스포메이션, 액션, 지연 평가 / 캐시와 저장 레벨, GC / 모듈(Core, SQL, pandas API, Streaming, MLlib) |
| 2. Spark SQL | 20% | JDBC와 파일 읽기·쓰기, overwrite와 컬럼 기준 파티셔닝 / 파일에 직접 SQL 실행(ORC, JSON, CSV, Text, Delta) / 저장 모드 / 정렬·파티셔닝을 적용한 영구 테이블 / 임시 뷰 |
| 3. DataFrame/Dataset API | 30% | 컬럼 추가·삭제·분리·이름 변경, 필터, 배열 explode / 중복 제거와 검증 / count, approx_count_distinct, mean, summary / 날짜(epoch를 문자열로, 날짜 요소 추출) / 조인(inner, left, broadcast, 다중 키, cross), union / 스키마를 지정한 읽기·쓰기 / 정렬, printSchema, 리스트 변환 / UDF / broadcast 변수와 accumulator |
| 4. 문제 해결과 튜닝 | 10% | repartition, coalesce, 데이터 쏠림, 셔플 줄이기 / AQE / 드라이버·익스큐터 로그로 메모리 부족과 저사용 진단 |
| 5. Structured Streaming | 10% | 마이크로배치, exactly-once, 장애 복구 / 출력 모드와 싱크 / 선택, 윈도, 집계 / 워터마크가 있을 때와 없을 때의 중복 제거 |
| 6. Spark Connect | 5% | Spark Connect의 특징 / 배포 모드(Client, Cluster, Local) |
| 7. pandas API on Spark | 5% | 장점 / pandas UDF 만들기와 호출 |

안내서에는 샘플 문항 10개와 정답이 실려 있습니다. 다루는 것은 `partitionBy`와 overwrite, Spark UI에서 익스큐터 로그 찾기, `withColumn`과 `withColumnRenamed`, `spark.sql.shuffle.partitions`의 기본값 200, `na.drop()`, Local 모드, `approx_count_distinct`(HyperLogLog) 등입니다. 대부분 동작이나 기본값을 정확히 아는지 묻습니다.

## 3. 헷갈리기 쉬운 동작(공식 문서 기준)

시험에서 문서를 볼 수 없으니 기본값과 예외를 표로 모았습니다. 출처는 모두 Spark 4.2.0 공식 문서이고, 이 시리즈에서 하나씩 코드로 재현할 목록입니다.

| 주제 | 공식 문서의 내용 | 헷갈리는 지점 |
|---|---|---|
| 지연 평가 | 트랜스포메이션은 결과가 드라이버로 돌아가야 할 때(액션) 계산한다 | `count()`, `collect()`, `save` 같은 액션이 Job을 만든다 |
| 실행 계층 | Job은 액션마다, Stage는 Job을 나눈 Task 묶음, Task는 익스큐터 하나로 가는 작업 단위 | Stage 경계는 셔플이다 |
| `coalesce` | 좁은 의존성(narrow dependency)이라 1000개를 100개로 줄일 때 셔플이 없다. 파티션을 늘리려 하면 현재 수를 유지한다 | 1개처럼 급격히 줄이면 `repartition()`을 쓰라고 권한다 |
| `repartition` | 해시 파티셔닝, 데이터 전체를 셔플한다 | 늘리고 줄이기 모두 된다 |
| DataFrame `cache()` | 기본 저장 레벨은 `MEMORY_AND_DISK_DESER`(3.0에서 Scala와 맞춤) | RDD의 `cache()` 기본값은 `MEMORY_ONLY`라 서로 다르다 |
| broadcast 조인 | `spark.sql.autoBroadcastJoinThreshold` 기본 10MB, -1이면 끈다. `broadcast(df)`로 지정할 수 있다 | 힌트는 BROADCAST, MERGE, SHUFFLE_HASH, SHUFFLE_REPLICATE_NL |
| accumulator | 결합·교환 법칙이 성립하는 연산으로 더하기만 한다 | broadcast 변수는 읽기 전용 |
| AQE | 3.2.0부터 기본으로 켜져 있다 | 쏠림 판정은 파티션이 중앙값의 5배를 넘고 동시에 256MB를 넘을 때 |
| `union` | 컬럼을 위치로 맞추고(이름은 보지 않는다) 중복을 없애지 않는다 | 이름으로 맞추려면 `unionByName` |
| 저장 모드 | 기본은 `errorifexists`. 그 밖에 append, overwrite, ignore | `bucketBy`와 `sortBy`는 `saveAsTable()`과 함께 쓴다 |
| 임시 뷰 | temp view는 SparkSession, global temp view는 애플리케이션 수명 | global은 `global_temp` 데이터베이스로 조회 |
| `explode` | SELECT 하나에 explode 하나만 | null이나 빈 배열을 남기려면 `explode_outer` |
| `approx_count_distinct` | 기본 상대 오차 0.05 | 0.01보다 작게 잡을 거면 `count_distinct()`가 낫다고 문서가 적는다 |
| `from_unixtime` | epoch 초를 현재 시스템 시간대 기준 문자열로 | 기본 형식 `yyyy-MM-dd HH:mm:ss` |
| `udf` | 반환 타입 기본값은 `StringType`, 기본으로 결정적 함수로 본다 | 4.2.0부터 Arrow를 기본으로 쓴다. 시험 기준 버전이 이전이면 다를 수 있다 |
| Streaming 출력 모드 | Append(기본), Complete(집계), Update | 집계 없는 쿼리에 Complete는 쓸 수 없다 |
| Streaming 보장 | 체크포인트와 WAL로 종단 간 exactly-once. 파일 싱크는 exactly-once, Kafka 싱크와 foreachBatch는 기본 at-least-once | Continuous 처리는 at-least-once |
| Streaming 중복 제거 | 워터마크가 없으면 과거 전체를 상태로 보관한다 | `dropDuplicatesWithinWatermark`(3.5.0~)는 워터마크가 필수 |
| Spark Connect | 3.4에서 도입. 클라이언트가 논리 계획을 gRPC로 보내고 결과를 Arrow로 받는다 | SparkContext와 RDD API를 쓸 수 없다 |
| pandas API on Spark | `to_pandas()`는 모든 데이터를 클라이언트로 모은다 | Spark DataFrame에서 바꾸면 기본 인덱스가 새로 생긴다 |

Structured Streaming의 워터마크와 상태는 DE 시리즈의 Flink 글과 같은 개념을 다룹니다([DE Ch-15](/blog/data/streaming/de-15-flink-time-watermark)). 셔플과 파티션은 Kafka 파티셔닝 글([DE Ch-11](/blog/data/streaming/de-11-kafka-log-partition-group))과 같은 질문(어떤 키로 데이터를 나누는가)에서 시작합니다.

## 4. 실습 환경의 제약

| 환경 | 되는 것 | 안 되는 것 |
|---|---|---|
| Databricks Free Edition | 무료, 서버리스 컴퓨트, 노트북, 소형 SQL 웨어하우스 1개 | Spark UI, DataFrame·SQL 캐시 API(`cache()`가 예외를 낸다), RDD API, 클러스터 설정, Scala와 R. 하루 쿼터를 넘으면 그날 컴퓨트가 꺼진다 |
| Databricks Academy Labs | 강의용 실습 | 유료 구독이나 강사 과정 등록자만 |
| 로컬 PySpark | Spark UI(기본 4040 포트), 캐시와 저장 레벨, RDD, accumulator, 로컬 Spark Connect 서버 | Delta와 Databricks 전용 기능은 따로 설정해야 한다 |

Free Edition의 서버리스 컴퓨트 자체가 Spark Connect로 동작하니, Connect 영역은 오히려 Free Edition에서 확인하기 좋습니다. 반대로 영역 1과 4의 캐시, Spark UI, 로그는 로컬에서 봐야 합니다.

로컬 설치는 PySpark 문서 기준으로 Python 3.10 이상과 Java 17 이상(`JAVA_HOME` 설정)이 필요합니다.

```bash
pip install "pyspark[sql,pandas_on_spark,connect]"

# 로컬 Spark Connect 서버(기본 포트 15002)에 붙기
$SPARK_HOME/sbin/start-connect-server.sh
pyspark --remote "sc://localhost"
```

아직 이 노트북에서 실행해 보지 않은 명령입니다. 다음 글에서 설치하고 결과를 남기겠습니다.

## 5. 후기에서 확인한 것

새 시험 후기는 아직 적습니다. 국내와 중국 블로그, DEV에서는 새 시험 후기를 찾지 못했고, Medium 글 하나와 Databricks 커뮤니티 글을 찾았습니다.

| 글 | 시험 | 내용 |
|---|---|---|
| [Sarah Chua, Medium(2025-09)](https://sarahchua-sg.medium.com/databricks-certified-associate-developer-for-apache-spark-2025-a1d39fd9808d) | 새 시험 | 당시 새 시험용 영상 강의가 없어서 안내서의 항목마다 문서를 찾아 읽었다. 메모리, 쏠림, 파티션을 다룬 영상을 봤고 시험 직전 주말에 Udemy 모의고사 5회를 풀었는데 실제와 관련이 많았지만 일부 답과 해설은 미심쩍었다. 지금은 Python 전용 |
| Databricks 커뮤니티 "Seeking Guidance for Spark Certification"(2025-07~08) | 새 시험 | 한 응시자는 생각보다 어렵고 범위가 넓다고 했다. 다른 사람은 시나리오형 문항이 늘었다고 적었다. Free Edition에서는 Spark UI를 볼 수 없다는 답이 달렸다 |
| NewNewDaddy, velog(2023-09) | 예전 시험, 합격 | 60문항, 120분. 시험 중 문서는 있었지만 검색이 안 됐다. 실제 코드 문제가 약 70% |

예전 시험 자료를 쓸 때 조심할 점이 있습니다. Packt 책(중국어 번역본도 있음)은 Structured Streaming을 시험 범위 밖으로 둡니다. Learning Spark 2판(2020)은 Spark 3.0을 다루고 Spark Connect(3.4 도입)보다 먼저 나왔습니다. 위 velog의 개념 정리 글은 union이 컬럼 이름이 달라도 이어 붙는다고 설명하는데, 공식 문서 기준으로 union은 위치로 맞춥니다. 예전 자료는 범위와 동작을 지금 문서로 다시 확인해야 합니다.

예전 시험 후기 중에는 유출 문항을 썼다고 밝힌 것이 있어 그 부분은 참고하지 않았습니다.

## 6. 내 공부 계획

| 단계 | 할 일 | 끝났다고 보는 기준 |
|---|---|---|
| 1. 기준 잡기 | 2025년 10월판 안내서의 항목(2절)을 체크리스트로 옮기고 샘플 문항 10개를 푼다 | 틀린 문항마다 해당 항목을 적는다 |
| 2. 환경 | 로컬 PySpark와 Free Edition을 준비한다 | 로컬에서 Spark UI가 뜨고 Free Edition에서 노트북이 돈다 |
| 3. 아키텍처와 DataFrame API(50%) | 3절 표의 동작을 하나씩 코드로 재현하고 Spark UI에서 Job, Stage, 셔플을 확인한다. 쇼핑몰 주문과 회원 데이터 같은 작은 예제로 조인, 집계, 날짜 처리를 연습한다 | 기본값과 시그니처를 문서 없이 쓴다 |
| 4. Spark SQL(20%) | 파일에 직접 SQL, 저장 모드, `partitionBy`와 `bucketBy`, 임시 뷰를 재현한다 | 각 저장 모드가 기존 데이터에 무엇을 하는지 설명한다 |
| 5. 튜닝, Streaming, Connect, pandas API(30%) | 쏠린 데이터로 AQE 전후 계획을 비교하고, 파일 소스 스트리밍으로 출력 모드와 워터마크 중복 제거를 확인한다. 로컬 Connect 서버로 RDD가 막히는 것을 본다 | 각 영역에서 안 되는 것을 이유와 함께 말한다 |
| 6. 모의고사 | 공식 Academy 과정을 마치고 안내서 샘플 문항과 새 범위가 반영된 모의고사로 시간을 재고 푼다. Databricks는 공식 모의고사를 제공하지 않는다 | 90분 안에 다 풀고 꾸준히 여유 있게 넘는다 |

합격선이 공개되지 않아 모의고사 목표치를 정할 근거가 약합니다. 커뮤니티에서는 80% 정도를 목표로 하라는 개인 의견이 있었습니다.

6단계를 시험 30일 전부터 어떻게 나눌지, 연습 자료가 새 시험을 반영했는지, Java 없이 Docker와 Colab으로 실습하는 방법, 시험 전날 외울 기본값과 당일 시간 배분은 [Ch-07](/blog/cert/spark/spark-07-resources-and-exam-day)에 정리했습니다.

## 7. 범위와 한계

- 시험 정보는 2026년 10월 19일 Databricks 공식 페이지, FAQ, 2025년 10월판 안내서로 확인했습니다. 2026년 10월 20일에 2026년 10월 8일판 안내서를 찾았고 출제 영역과 비중은 같았습니다. 바뀐 점은 [Ch-07](/blog/cert/spark/spark-07-resources-and-exam-day) 1-1절에 적었습니다.
- 3절의 동작은 Spark 4.2.0 문서 기준입니다. 시험의 기준 버전이 공개되지 않아 버전에 따라 다를 수 있습니다.
- 4절의 명령과 6절의 재현은 아직 실행하지 않았습니다. 실행한 뒤 결과를 이 시리즈에 남기겠습니다.
- 새 시험 후기는 두 건만 확인했습니다. Medium 글은 2026년 10월 20일에 작성자 RSS로 원문 주소와 본문을 확인해 링크를 붙였습니다.

## 참고 자료

공식 자료
- Databricks, [Databricks Certified Associate Developer for Apache Spark](https://www.databricks.com/learn/certification/apache-spark-developer-associate)
- Databricks, [Certification and Badging FAQ](https://www.databricks.com/learn/certification/faq)
- Databricks, [Exam Guide, Oct 2025](https://www.databricks.com/sites/default/files/2025-10/databricks-certified-associate-developer-apache-spark-exam-guide-oct-2025.pdf), [Exam Guide, Apr 2025](https://www.databricks.com/sites/default/files/2025-04/Databricks-Certified-Associate-Developer-for-Apache-Spark_Exam-Guide_1_Apr_2025.pdf)
- Databricks Community, [Official Certification Exam Retake Policy Announcement](https://community.databricks.com/t5/certifications/official-certification-exam-retake-policy-announcement/td-p/50296), 2023
- Databricks, [Free Edition](https://www.databricks.com/learn/free-edition), [Free Edition limitations](https://docs.databricks.com/aws/en/getting-started/free-edition-limitations), [Serverless compute limitations](https://docs.databricks.com/aws/en/compute/serverless/limitations)
- Apache Spark: [PySpark 설치](https://spark.apache.org/docs/latest/api/python/getting_started/install.html), [RDD Programming Guide](https://spark.apache.org/docs/latest/rdd-programming-guide.html), [Cluster Mode Overview](https://spark.apache.org/docs/latest/cluster-overview.html), [Performance Tuning](https://spark.apache.org/docs/latest/sql-performance-tuning.html), [Structured Streaming](https://spark.apache.org/docs/latest/streaming/index.html), [Spark Connect Overview](https://spark.apache.org/docs/latest/spark-connect-overview.html), [Arrow와 pandas UDF](https://spark.apache.org/docs/latest/api/python/tutorial/sql/arrow_pandas.html)

후기와 커뮤니티
- Sarah Chua, [Databricks Certified Associate Developer for Apache Spark — 2025](https://sarahchua-sg.medium.com/databricks-certified-associate-developer-for-apache-spark-2025-a1d39fd9808d), Medium, 2025-09-03
- Databricks Community, [Seeking Guidance for Spark Certification](https://community.databricks.com/t5/certifications/seeking-guidance-for-spark-certification/td-p/125639), 2025
- Databricks Community, [Databricks workspace issue (Community Edition 종료 안내)](https://community.databricks.com/t5/databricks-free-edition-help/databricks-workspace-issue/m-p/144991), 2026
- NewNewDaddy, [Apache Spark 자격증 취득기](https://velog.io/@newnew_daddy/spark02), 2023

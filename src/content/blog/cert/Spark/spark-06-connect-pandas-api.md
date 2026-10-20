---
title: '[Spark Ch-06] Spark Connect와 pandas API on Spark: 클라이언트는 계획만 보내고 pandas 코드는 분산으로 돈다'
description: Databricks Spark 자격증 6영역(Spark Connect, 5%)과 7영역(pandas API on Spark, 5%)을 시험 안내서 항목 순서대로 정리합니다. Spark Connect의 구조와 쓸 수 없는 API, 배포 모드와 master URL, pandas API on Spark의 기본 인덱스와 변환 비용, pandas UDF와 pandas Function API, Arrow 설정을 Spark 4.2.0 공식 문서 기준으로 확인하고 3.5와 달라진 기본값을 표시합니다.
date: 2026-10-19T00:00:00.000Z
tags:
  - Spark
  - Databricks
  - PySpark
  - Certification
  - Spark Connect
  - pandas
category: cert/Spark
topics:
  - cert
draft: false
series: "Spark 공부"
seriesOrder: 6
---

## 결론부터

1. Spark Connect(3.4에서 도입)는 클라이언트가 DataFrame 연산을 해석 전 논리 계획(unresolved logical plan)으로 만들어 protocol buffers로 인코딩하고 gRPC로 서버에 보내는 구조입니다. 서버가 분석, 최적화, 실행을 하고 결과는 Arrow로 인코딩한 행 배치로 돌려줍니다.
2. 클라이언트가 드라이버 프로세스 밖에 있어서 `SparkContext`, RDD API, 정적 설정, `df._jdf` 같은 JVM 내부 접근을 쓸 수 없습니다. 접속 주소는 `sc://host:port` 형식이고 기본 포트는 15002입니다.
3. 배포 모드는 드라이버가 어디서 뜨는지로 나눕니다. client(기본)는 제출한 쪽, cluster는 클러스터 안, local은 드라이버와 익스큐터가 한 JVM에서 돕니다. `local[*]`는 논리 코어 수만큼 스레드를 씁니다.
4. pandas API on Spark(`import pyspark.pandas as ps`)는 pandas 문법으로 Spark에서 분산 실행합니다. Spark DataFrame에서 바꾸면 기본 인덱스가 새로 붙고 기본 종류는 `distributed-sequence`입니다. `to_pandas()`는 모든 데이터를 드라이버로 모으니 작은 결과에만 씁니다.
5. pandas UDF는 `pandas_udf`와 타입 힌트로 종류를 정합니다. Series에서 Series, Series 반복자에서 Series 반복자, Series에서 스칼라(집계)가 있습니다. DataFrame 단위로 함수를 적용할 때는 `mapInPandas`와 `groupBy().applyInPandas()`를 씁니다. Arrow 변환(`spark.sql.execution.arrow.pyspark.enabled`)은 4.2에서 기본 true가 됐고 3.5, 4.0, 4.1에서는 기본 false였습니다.

---

## 1. 시험 안내서 항목과 이 글의 순서

| 영역 | 안내서 항목(원문 요약) | 이 글 |
|---|---|---|
| 6. Spark Connect로 애플리케이션 배포(5%) | Spark Connect의 특징 설명 | 2~4절 |
| | 배포 모드(Client, Cluster, Local) 설명 | 5절 |
| 7. pandas API on Spark(5%) | pandas API on Spark의 장점 설명 | 6~9절 |
| | pandas UDF 만들고 호출하기 | 10~12절 |

안내서 샘플 문항 7번이 6영역에서 나왔습니다. "모든 익스큐터가 워커 노드 하나에서 돌아야 하는 배포 모드는 무엇인가"이고 정답은 Local 모드입니다. 두 영역을 합쳐 10%라서 문항 수로는 4~5개 정도로 짐작합니다(45문항 × 10%로 계산한 값이고 실제 배분은 공개되지 않았습니다).

예제 데이터는 쇼핑몰 주문(`orders`)과 결제(`payments`)입니다.

## 2. Spark Connect의 구조

### 2-1. 요청이 오가는 순서

Spark Connect Overview 문서의 "How Spark Connect works" 절을 단계로 나누면 이렇습니다.

1. 클라이언트 라이브러리가 DataFrame 연산을 해석 전 논리 계획으로 바꾸고 protocol buffers로 인코딩합니다.
2. 이 계획을 gRPC로 서버에 보냅니다.
3. Spark 서버에 붙은 Spark Connect 엔드포인트가 해석 전 계획을 Spark의 논리 계획 연산자로 옮깁니다. 문서는 SQL을 파싱해 처음 파스 계획을 만드는 것과 비슷하다고 설명합니다.
4. 그다음은 보통의 Spark 실행 과정이라 옵티마이저와 실행 엔진의 최적화를 그대로 씁니다.
5. 결과는 Apache Arrow로 인코딩한 행 배치로 gRPC 스트림을 통해 클라이언트로 돌아옵니다.

해석 전 계획을 보낸다는 점이 시험 보기를 가르는 기준입니다. 클라이언트는 컬럼 이름이 실제로 있는지 모른 채 계획을 보내고 이름 확인(analysis)은 서버가 합니다. 그래서 Connect에서는 존재하지 않는 컬럼을 참조해도 그 줄에서 바로 오류가 나지 않고 액션이나 스키마 조회처럼 서버에 물어볼 때 오류가 날 수 있습니다. 이 오류 시점은 구조에서 추론한 것이고 실행해서 확인하지 않았습니다.

### 2-2. 클래식 PySpark와 비교

| | 클래식 PySpark | Spark Connect |
|---|---|---|
| 클라이언트와 드라이버 | 같은 프로세스 쪽. Python이 Py4J로 드라이버 JVM을 부른다 | 분리. 클라이언트는 드라이버 JVM에 직접 닿지 못한다 |
| 통신 | Py4J | gRPC(HTTP/2), 계획은 protobuf, 결과는 Arrow |
| 세션 타입 | `pyspark.sql.session.SparkSession` | `pyspark.sql.connect.session.SparkSession` |
| RDD, `SparkContext` | 쓸 수 있다 | 쓸 수 없다 |
| 정적 Spark 설정 | 세션 생성 때 줄 수 있다 | 클라이언트가 접근할 수 없다 |
| 지원 언어 | Python, Scala, Java, R | PySpark(3.4부터), Scala(3.5부터) |

세션 타입은 문서 예제로 확인할 수 있습니다.

```python
>>> type(spark)
<class 'pyspark.sql.connect.session.SparkSession'>
```

### 2-3. 운영에서 얻는 것

문서가 드는 이점은 셋입니다.

| 이점 | 문서의 설명 |
|---|---|
| 안정성 | 메모리를 많이 쓰는 애플리케이션이 자기 프로세스 안에서만 영향을 준다. 의존성을 클라이언트에 두니 드라이버와 충돌하지 않는다 |
| 업그레이드 | 드라이버를 애플리케이션과 따로 올릴 수 있다. 서버 쪽 RPC 정의가 하위 호환이면 애플리케이션은 그대로 쓴다 |
| 디버깅과 관측 | IDE에서 대화형으로 디버깅하고 애플리케이션 프레임워크의 지표와 로깅으로 본다 |

여러 사용자가 클러스터 하나를 함께 쓸 때(멀티테넌트) 생기는 문제를 줄인다는 맥락입니다. Databricks의 서버리스 컴퓨트와 Free Edition도 Spark Connect로 돌아서 Ch-00에서 Free Edition에서는 RDD API를 쓸 수 없다고 적었습니다.

## 3. Spark Connect의 API 지원 범위

문서의 "How Spark Connect client applications differ from classic Spark applications"와 "What is supported" 절을 합쳤습니다.

| 쓸 수 없는 것 | 이유 |
|---|---|
| `SparkContext`(`spark.sparkContext`) | 세션 단위 클라이언트라 모든 클라이언트의 환경을 바꾸는 클러스터 속성에 접근하지 못한다 |
| RDD API(`df.rdd`, `sc.parallelize`) | 프로토콜이 논리 계획을 추상화로 써서 RDD 같은 실행 API를 지원하지 않는다 |
| 정적 Spark 설정 | 위와 같은 이유 |
| `df._jdf` 같은 JVM 내부 필드 | 클라이언트가 Py4J를 쓰지 않는다 |

쓸 수 있는 것은 DataFrame, functions, Column 등 PySpark API 대부분과 Streaming API 대부분(`DataStreamReader`, `DataStreamWriter`, `StreamingQuery`, `StreamingQueryListener`)입니다. UDF도 됩니다. PySpark API 문서는 함수마다 "Supports Spark Connect" 표시를 달아서 옮기기 전에 확인하라고 안내합니다.

RDD에 기대던 코드는 DataFrame 함수로 바꿔야 합니다.

```python
# 클래식에서만 되는 코드
n = orders.rdd.getNumPartitions()
sc = spark.sparkContext
acc = sc.accumulator(0)
bc = sc.broadcast({"PAID": 1, "CANCELLED": 0})

# Connect에서도 되는 대안
from pyspark.sql import functions as F
part_sizes = orders.groupBy(F.spark_partition_id().alias("pid")).count()
status_map = spark.createDataFrame([("PAID", 1), ("CANCELLED", 0)], "status string, flag int")
flagged = orders.join(F.broadcast(status_map), "status", "left")
```

accumulator와 broadcast 변수는 `SparkContext`에 달린 API라 Connect에서 막힌다고 보는 게 맞습니다. 이 둘이 막힌다는 문장을 문서에서 따로 찾지는 못했고 `SparkContext`를 쓸 수 없다는 문장에서 추론했습니다.

헷갈리는 지점입니다.

- `spark.sparkContext.setLogLevel()`도 `SparkContext`를 거쳐서 Connect에서 쓸 수 없습니다.
- 스트리밍의 `foreachBatch`는 Connect에서 함수가 바깥 변수에 접근하지 못한다고 API 문서가 적습니다(Ch-05 6-2).
- Spark Connect 자체에는 인증이 들어 있지 않습니다. 문서는 gRPC HTTP/2 인터페이스 앞에 인증 프록시를 두는 방식을 설명합니다. 접속 문자열의 `token`은 bearer 토큰을 보내는 자리입니다.

## 4. Spark Connect에 연결하기

### 4-1. 서버 띄우기

```bash
# 내려받은 Spark 배포판 폴더에서
./sbin/start-connect-server.sh
# 서버는 localhost:15002에서 받는다
```

서버 포트 설정은 `spark.connect.grpc.binding.port`(기본 15002, 3.4.0)입니다. 문서는 클라이언트 패키지 버전을 서버 Spark 버전과 맞추라고 적습니다.

### 4-2. 클라이언트 세 가지 방법

| 방법 | 코드 |
|---|---|
| 환경 변수 | `export SPARK_REMOTE="sc://localhost"` 후 `./bin/pyspark`. 코드는 그대로 |
| 셸 옵션 | `./bin/pyspark --remote "sc://localhost"` |
| 코드에서 | `SparkSession.builder.remote("sc://localhost").getOrCreate()` |

```python
from pyspark.sql import SparkSession

spark = (SparkSession.builder
         .remote("sc://localhost:15002")
         .appName("ch06-connect")
         .getOrCreate())

orders = spark.read.parquet("/data/orders")
orders.groupBy("status").count().show()
```

PySpark Quickstart: Spark Connect 노트북은 원격 세션을 만들기 전에 기존 일반 세션을 멈춥니다. 같은 프로세스에서 일반 세션과 원격 세션이 함께 있을 수 없다고 적습니다.

독립 애플리케이션용으로는 클라이언트만 담은 패키지가 있습니다. 4.2.0 문서는 `pip install pyspark-client==4.2.0`을 안내합니다. PyPI의 릴리스 목록에서 가장 이른 버전은 4.0.0(2025년 5월 23일 업로드)이라 3.5에는 이 패키지가 없습니다.

4.0.0에서 생긴 `spark.api.mode`(기본 `classic`)를 `connect`로 두면 Spark Classic 애플리케이션이 로컬 Spark Connect 서버를 자동으로 띄워 붙습니다(Configuration 문서의 설명). 같은 4.0.0에서 서버 바인딩 주소 설정 `spark.connect.grpc.binding.address`(기본 없음)도 생겼습니다. 시험 기준 버전이 3.5라면 둘 다 범위 밖입니다.

### 4-3. 접속 문자열

Spark 저장소의 클라이언트 접속 문자열 문서 기준입니다. 형식은 `sc://host:port/;param1=value;param2=value`이고 스킴은 `sc://`로 고정, 경로는 비워야 하며 매개변수 이름은 대소문자를 구분합니다.

| 매개변수 | 기본값 | 뜻 |
|---|---|---|
| `port` | 15002 | gRPC 엔드포인트 포트 |
| `token` | 없음 | bearer 토큰 인증. 설정하면 SSL도 켜진다 |
| `use_ssl` | false | TLS로 연결 |
| `user_id` | 없음 | 사용자 ID |
| `session_id` | 임의 UUID | 서버 쪽 세션 캐시 키 |
| `grpc_max_message_size` | 134217728(128MiB) | gRPC 메시지 최대 크기 |

```text
sc://localhost
sc://spark.example.com:443/;token=ABCDEFG;user_id=analyst
```

## 5. 배포 모드와 master URL

### 5-1. client, cluster, local

Cluster Mode Overview의 용어표는 배포 모드(deploy mode)를 "드라이버 프로세스가 어디서 뜨는지 구분하는 것"으로 정의합니다.

| 모드 | 드라이버 위치 | 익스큐터 | 쓰임 |
|---|---|---|---|
| client(기본) | `spark-submit`을 실행한 프로세스 안. 클러스터 밖일 수 있다 | 클러스터 워커 노드 | 셸, 노트북처럼 콘솔 입출력이 필요한 대화형 작업 |
| cluster | 클러스터 매니저가 클러스터 안의 노드에 띄운다 | 클러스터 워커 노드 | 노트북 같은 먼 곳에서 제출해 드라이버와 익스큐터 사이 지연을 줄일 때 |
| local | 한 머신, 한 JVM | 드라이버와 같은 JVM의 스레드 | 개발, 테스트, 학습 |

`spark-submit --deploy-mode` 기본값은 client이고 설정으로는 `spark.submit.deployMode`(기본 `client`)입니다. Submitting Applications 문서는 게이트웨이 머신이 워커와 같은 곳에 있으면 client 모드가 맞다고 봅니다. 노트북처럼 워커에서 먼 곳에서 제출하면 cluster 모드가 흔하다고 적습니다. 같은 문서가 Standalone 클러스터는 Python 애플리케이션의 cluster 모드를 지원하지 않는다고 적습니다.

local 모드는 엄밀히 말하면 `--deploy-mode` 값이 아니고 master URL을 `local`로 준 실행 방식입니다. 시험 안내서는 Client, Cluster, Local을 나란히 배포 모드로 부르므로 시험 맥락에서는 셋을 같이 외웁니다.

### 5-2. master URL

| master URL | 뜻 |
|---|---|
| `local` | 워커 스레드 1개. 병렬 처리 없음 |
| `local[K]` | 워커 스레드 K개. 코어 수에 맞추길 권한다 |
| `local[K,F]` | 스레드 K개, 최대 실패 F회(`spark.task.maxFailures`) |
| `local[*]` | 논리 코어 수만큼 스레드 |
| `local[*,F]` | 논리 코어 수만큼 스레드, 최대 실패 F회 |
| `local-cluster[N,C,M]` | 단위 테스트 전용. 한 JVM 안에서 워커 N개, 워커당 코어 C개, 메모리 M MiB를 흉내 |
| `spark://HOST:PORT` | Standalone 마스터. 기본 포트 7077 |
| `spark://HOST1:PORT1,HOST2:PORT2` | ZooKeeper로 대기 마스터를 둔 Standalone 고가용성 구성. 마스터 호스트를 모두 적는다 |
| `yarn` | YARN. client와 cluster는 `--deploy-mode`로. 위치는 `HADOOP_CONF_DIR`이나 `YARN_CONF_DIR`로 찾는다 |
| `k8s://HOST:PORT` | Kubernetes API 서버. 기본 TLS |

```bash
# 로컬 4스레드로 주문 집계 스크립트 실행
./bin/spark-submit --master "local[4]" order_report.py

# YARN cluster 모드
./bin/spark-submit --master yarn --deploy-mode cluster \
  --executor-memory 4G --num-executors 10 order_report.py
```

헷갈리는 지점입니다.

- 로컬 모드에서 `spark.default.parallelism`은 머신의 코어 수입니다. `local[2]`로 띄우면 스레드가 둘이라 Task도 동시에 둘만 돕니다.
- `sc://host:port`는 master URL 표에 없습니다. Submitting Applications 문서의 master URL은 클러스터 매니저를 고르는 값이고 `sc://`는 `--remote`나 `builder.remote()`에 주는 Spark Connect 서버 주소입니다. 보기에 `--master sc://...`가 나오면 섞어 놓은 오답으로 봅니다.
- Spark Connect 서버도 하나의 Spark 드라이버 애플리케이션입니다. `start-connect-server.sh`에 `--master`를 주면 그 서버가 어느 클러스터에서 돌지 정합니다. 이 스크립트가 `spark-submit` 옵션을 받는다는 점은 문서 문장으로 확인하지 못했습니다.
- client 모드에서 드라이버가 죽으면 애플리케이션 전체가 끝납니다. cluster 모드의 Standalone에는 `--supervise`(`spark.driver.supervise`, 기본 false)로 0이 아닌 종료 코드일 때 드라이버를 자동 재시작하는 옵션이 있습니다.

## 6. pandas API on Spark의 장점

PySpark 문서 첫 화면의 설명을 정리하면 장점은 넷입니다.

- pandas 워크로드를 여러 노드에 분산해서 데이터 크기에 맞게 키울 수 있습니다.
- pandas에 익숙하면 코드를 거의 바꾸지 않고 옮길 수 있습니다.
- 코드베이스 하나로 pandas(테스트, 작은 데이터셋)와 Spark(운영, 분산 데이터셋)를 모두 다룹니다.
- pandas API와 pandas API on Spark 사이를 쉽게 오갑니다.

같은 문서는 Spark를 처음 쓰거나 어떤 API를 쓸지 고르는 중이라면 PySpark DataFrame을 권한다고도 적습니다. pandas API on Spark는 pandas에서 넘어오는 길을 쉽게 하려는 도구라는 위치입니다.

```python
import pyspark.pandas as ps

psdf = ps.read_parquet("/data/orders")
paid = psdf[psdf["status"] == "PAID"]
by_store = paid.groupby("store_id")["amount"].sum().sort_values(ascending=False)
print(by_store.head(10))
```

pandas와 다른 점 세 가지를 같이 기억합니다.

| | pandas | pandas API on Spark |
|---|---|---|
| 실행 | 즉시, 한 머신 메모리 | 지연 평가, 분산. `psdf.spark.explain()`으로 계획 확인 |
| 행 순서와 인덱스 | 메모리 순서 그대로 | 분산이라 기본 인덱스를 따로 만들어야 한다(7절) |
| 일부 API | 모두 | `__iter__` 같은 일부는 의도적으로 구현하지 않음. 클라이언트로 전부 모으는 것을 막기 위해서 |

모든 Spark 기능(History Server, Web UI, 배포 모드)을 그대로 쓰고 이미 떠 있는 SparkSession이 있으면 그 세션을 자동으로 씁니다. Arrow 같은 설정은 세션을 만들 때 넣습니다.

Best Practices 문서가 권하는 것을 줄이면 이렇습니다.

- 실행 전에 `psdf.spark.explain()`으로 계획을 봅니다.
- 계획이 너무 커지면 `spark.checkpoint()`나 `spark.local_checkpoint()`로 끊습니다.
- `sort_values`처럼 셔플이 드는 연산을 줄입니다.
- `DataFrame.rank`처럼 파티션 없이 Window를 써서 데이터를 파티션 하나로 모으는 API는 큰 데이터에서 `GroupBy.rank`로 바꿉니다.

## 7. 기본 인덱스

### 7-1. 세 가지 종류

pandas-on-Spark DataFrame은 인덱스가 필요합니다. Spark DataFrame에서 바꿀 때처럼 인덱스를 모르면 기본 인덱스를 붙이고 종류는 `compute.default_index_type`으로 고릅니다.

| 종류 | 만드는 방법 | 특징 |
|---|---|---|
| `sequence` | 파티션 지정 없는 Window 함수로 1씩 증가 | 전체가 파티션 하나에 모일 수 있다. 큰 데이터에서는 피하라고 문서가 적는다 |
| `distributed-sequence`(기본) | group-by와 group-map 방식으로 분산 계산 | 전역으로 1씩 증가하는 순번. 큰 데이터에서 순번이 꼭 필요할 때 |
| `distributed` | `monotonically_increasing_id` | 값이 비결정적이고 연속이 아니다. 성능 손해가 거의 없다 |

```python
ps.set_option("compute.default_index_type", "distributed")
ps.get_option("compute.default_index_type")   # 'distributed'
ps.reset_option("compute.default_index_type")
```

`distributed` 예제의 인덱스 값은 `[25769803776, 60129542144, 94489280512]`처럼 큰 수로 나옵니다(문서의 `ps.range(3)` 예제). 순번이 필요 없으면 이 종류를 쓰라고 문서가 권합니다. 기본값 `distributed-sequence`는 3.5.6 문서와 4.2.0 문서가 같아서 버전에 따라 답이 갈리지 않습니다.

### 7-2. distributed-sequence의 주의점

4.2.0 Options and settings 문서에는 경고가 하나 있습니다. `distributed-sequence`는 인덱스 자체는 전역 순번이지만 각 인덱스에 대응하는 행은 데이터를 읽을 때마다 달라질 수 있습니다. `apply()`, `groupby()`, `transform()` 중에 인덱스를 새로 만들면 원래 행과 계산 값이 어긋날 수 있다고 적습니다. 경고가 연결하는 Best Practices 문서의 "Handling index misalignment with distributed-sequence" 절이 예방법 셋을 제시합니다.

1. 함수를 적용하기 전에 `set_index("order_id")`로 인덱스를 명시합니다.
2. `psdf.spark.persist()`로 행 순서를 고정합니다.
3. `sequence` 인덱스를 씁니다(성능 대가가 있습니다).

### 7-3. 다른 DataFrame끼리 연산

서로 다른 pandas-on-Spark DataFrame(또는 Series)끼리 연산하면 내부적으로 조인이 일어납니다. 옵션 이름은 `compute.ops_on_diff_frames`입니다.

| 버전 | 기본값 |
|---|---|
| 3.5까지 | False. 다른 DataFrame끼리 연산하면 예외 |
| 4.0부터 | True(PySpark 마이그레이션 가이드) |

4.2.0 옵션 문서 본문은 아직 "기본으로 막는다"고 쓰면서 옵션 표에는 True로 적혀 있어 문서 안에서 서술이 어긋납니다. 시험 기준 버전에 따라 답이 갈릴 수 있는 지점이라 표시해 둡니다. `distributed` 인덱스를 쓰면서 이 옵션을 켜면 두 DataFrame의 인덱스가 같다는 보장이 없어서 예상과 다른 결과가 나올 가능성이 크다고 문서가 경고합니다.

그 밖의 옵션 기본값입니다.

| 옵션 | 기본값 | 뜻 |
|---|---|---|
| `display.max_rows` | 1000 | repr로 보여 줄 최대 행 수 |
| `compute.max_rows` | 1000 | 현재 DataFrame의 한도. 한도가 있으면 데이터를 드라이버로 모아 pandas API로 처리하는 지름길을 쓰고 None이면 PySpark로 처리 |
| `compute.shortcut_limit` | 1000 | 이 행 수만 먼저 계산해 그 스키마를 쓴다. DataFrame이 이보다 길면 PySpark로 계산 |
| `compute.default_index_cache` | `MEMORY_AND_DISK_SER` | `distributed-sequence` 인덱스 계산에 쓰는 임시 RDD 캐시 레벨 |
| `plotting.backend` | `plotly` | 그래프 백엔드 |

`compute.max_rows`와 `compute.shortcut_limit`의 설명은 옵션 표 문장을 줄여 옮겼고 어떤 연산이 이 지름길을 쓰는지는 문서에 목록이 없었습니다.

## 8. 변환과 비용

```python
DataFrame.pandas_api(index_col=None)              # Spark DataFrame -> pandas-on-Spark (3.2.0)
pyspark.pandas.DataFrame.to_spark(index_col=None) # pandas-on-Spark -> Spark DataFrame
pyspark.pandas.DataFrame.to_pandas()              # pandas-on-Spark -> pandas
pyspark.pandas.from_pandas(pdf)                   # pandas -> pandas-on-Spark
DataFrame.toPandas()                              # Spark DataFrame -> pandas
```

| 변환 | 데이터 이동 | 비용 |
|---|---|---|
| Spark → pandas-on-Spark(`pandas_api`) | 없음(같은 분산 데이터) | 기본 인덱스를 새로 만든다. `index_col`을 주면 피한다 |
| pandas-on-Spark → Spark(`to_spark`) | 없음 | 인덱스 정보를 잃는다. `index_col`로 컬럼으로 남길 수 있다 |
| pandas-on-Spark → pandas(`to_pandas`) | 모든 데이터를 클라이언트(드라이버)로 | 결과가 작을 때만. 문서는 가능하면 pandas API on Spark나 PySpark API를 쓰라고 권한다 |
| pandas → pandas-on-Spark(`from_pandas`) | 클라이언트에서 클러스터로 | 데이터 크기만큼 전송 |

인덱스를 지키면서 오가는 문서 예제를 주문 데이터로 바꾸면 이렇습니다.

```python
psdf = ps.DataFrame({"amount": [12000, 5300, 87000]}, index=[101, 102, 103])

sdf = psdf.to_spark(index_col="order_id")          # 인덱스를 order_id 컬럼으로
sdf = sdf.filter("amount > 10000")
psdf2 = sdf.pandas_api(index_col="order_id")       # order_id를 다시 인덱스로
```

`pandas_api` 문서는 pandas-on-Spark에서 Spark로 갔다가 돌아오면 인덱스 정보를 잃고 원래 인덱스가 일반 컬럼이 된다고 적습니다. 4.0에서 예전 이름 `to_koalas`와 `to_pandas_on_spark`가 제거되고 `pandas_api`만 남았습니다.

헷갈리는 지점입니다.

- `to_pandas()`(pandas-on-Spark 메서드)와 `toPandas()`(Spark DataFrame 메서드)는 이름 표기가 다르고 둘 다 드라이버로 모읍니다.
- Spark DataFrame과 pandas-on-Spark DataFrame 사이 변환은 데이터를 옮기지 않습니다. 시험 보기의 "to_spark()는 데이터를 드라이버로 모은다"는 틀린 문장입니다.

## 9. Arrow 설정

Arrow는 JVM과 Python 사이에서 데이터를 컬럼 형식으로 주고받는 데 씁니다. pandas UDF는 추가 설정 없이 Arrow로 데이터를 옮긴다고 문서가 적습니다. `toPandas()`와 pandas DataFrame으로 `createDataFrame()`을 할 때는 아래 설정을 따릅니다.

| 설정 | 4.2.0 | 4.0.0, 4.1.0 | 3.5.6 | 뜻 |
|---|---|---|---|---|
| `spark.sql.execution.arrow.pyspark.enabled` | `spark.sql.execution.arrow.enabled` 값을 따르고 그 값이 true | 같은 방식, 그 값이 false | 같은 방식, 그 값이 false | `toPandas()`, pandas나 NumPy 입력의 `createDataFrame()`에 Arrow 사용 |
| `spark.sql.execution.arrow.pyspark.fallback.enabled` | `spark.sql.execution.arrow.fallback.enabled` 값(true) | 같음 | 같음 | Arrow 경로에서 오류가 나면 Arrow 없는 경로로 자동 전환 |
| `spark.sql.execution.arrow.maxRecordsPerBatch` | 10000 | 10000 | 10000 | Arrow 레코드 배치 하나의 최대 행 수. 0 이하면 제한 없음 |
| `spark.sql.execution.pythonUDF.arrow.enabled` | true | false | false | 일반 Python UDF에 Arrow 최적화(3.4.0에 생김). 인자가 하나 이상인 함수에만 적용 |

값은 각 버전 Configuration 문서의 표에서 옮겼습니다. 두 기본값이 true로 바뀐 버전은 4.2이고 4.0과 4.1은 3.5와 같이 false입니다.

4.2 마이그레이션 가이드가 두 기본값 변경을 적습니다. PySpark와 JVM 사이 컬럼 데이터 교환이 기본으로 Arrow를 쓰게 됐고 일반 Python UDF도 기본으로 Arrow 최적화가 됐습니다. 예전 동작이 필요하면 각각 false로 돌립니다. 같은 4.2에서 PyArrow 최소 버전이 18.0.0으로 올랐습니다.

```python
spark.conf.set("spark.sql.execution.arrow.pyspark.enabled", "true")   # 3.5에서는 직접 켠다
pdf = orders.filter("status = 'PAID'").limit(10000).toPandas()
```

Arrow를 켜도 `toPandas()`는 모든 레코드를 드라이버로 모읍니다. 바뀌는 것은 직렬화 방식입니다. 문서가 Arrow 변환에서 지원하지 않는다고 적은 타입은 `TimestampType`의 `ArrayType`이고 `MapType`과 중첩 `StructType`의 `ArrayType`은 PyArrow 2.0.0 이상에서만 됩니다. 파티션을 Arrow 배치로 바꾸면서 JVM 메모리를 순간적으로 많이 쓸 수 있어서 컬럼이 많으면 `maxRecordsPerBatch`를 낮추라고 문서가 권합니다.

## 10. pandas UDF

### 10-1. 시그니처와 종류

```python
pyspark.sql.functions.pandas_udf(f=None, returnType=None, functionType=None)
```

데코레이터나 함수 감싸기로 만들고 추가 설정은 필요 없습니다. 3.0부터 Python 타입 힌트로 종류를 정하고 `functionType`(`PandasUDFType`)은 호환용으로 남아 있으며 앞으로 deprecated 예정입니다. `returnType`은 `DataType` 객체나 DDL 문자열입니다.

| 종류 | 타입 힌트 | 입출력 | 호출 위치 |
|---|---|---|---|
| Series에서 Series | `pd.Series, ... -> pd.Series` | 배치마다 Series 하나 이상을 받아 같은 길이의 Series | `select`, `withColumn` |
| Series 반복자에서 Series 반복자 | `Iterator[pd.Series] -> Iterator[pd.Series]` | 입력 컬럼 하나. 전체 출력 길이가 전체 입력 길이와 같다 | 위와 같음 |
| 여러 Series 반복자 | `Iterator[Tuple[pd.Series, ...]] -> Iterator[pd.Series]` | 입력 컬럼 여러 개 | 위와 같음 |
| Series에서 스칼라 | `pd.Series, ... -> Any`(구체 스칼라 타입 권장) | 그룹이나 윈도의 Series를 받아 값 하나 | `select`, `groupBy().agg()`, `Window` |

구조체(`StructType`) 컬럼을 입력이나 출력으로 쓸 때만 `pd.Series` 자리에 `pd.DataFrame`을 씁니다.

### 10-2. Series에서 Series

내부적으로 컬럼을 배치로 나눠 배치마다 함수를 부르고 결과를 이어 붙입니다. 출력 길이는 항상 입력 길이와 같아야 합니다.

```python
import pandas as pd
from pyspark.sql.functions import pandas_udf, col

@pandas_udf("double")
def with_vat(amount: pd.Series, rate: pd.Series) -> pd.Series:
    return amount * (1 + rate)

priced = orders.withColumn("amount_vat", with_vat(col("amount"), col("vat_rate")))
```

같은 함수는 로컬 pandas 데이터로 먼저 시험할 수 있습니다. 문서도 pandas UDF로 쓸 함수는 로컬 pandas 데이터로도 돌아가야 한다고 적습니다.

### 10-3. Series 반복자

비싼 초기화를 한 번만 하고 모든 배치에 재사용할 때 씁니다.

```python
from typing import Iterator

@pandas_udf("string")
def normalize_coupon(batches: Iterator[pd.Series]) -> Iterator[pd.Series]:
    table = load_coupon_alias_table()      # 한 번만 읽는 별칭 표(가정한 함수)
    for s in batches:
        yield s.str.upper().map(lambda c: table.get(c, c))

orders.select(normalize_coupon("coupon_code"))
```

입력 컬럼이 여러 개면 `Iterator[Tuple[pd.Series, pd.Series]]`로 받고 `for a, b in batches:`로 풉니다.

### 10-4. Series에서 스칼라

PySpark 집계 함수처럼 동작합니다.

```python
@pandas_udf("double")
def trimmed_mean(v: pd.Series) -> float:
    lo, hi = v.quantile(0.05), v.quantile(0.95)
    return float(v[(v >= lo) & (v <= hi)].mean())

payments.groupBy("method").agg(trimmed_mean("amount").alias("amount_tm"))
```

문서의 제약입니다. 부분 집계를 하지 않아서 그룹이나 윈도의 데이터가 전부 메모리에 올라갑니다. 윈도에는 경계가 없는(unbounded) 윈도만 됩니다. 반환 타입은 기본 데이터 타입이어야 합니다.

### 10-5. 헷갈리는 지점

- pandas UDF 안에서는 조건식이나 불리언 단축 평가가 지원되지 않아 모든 행에서 함수가 실행됩니다. 특정 행에서 실패할 수 있으면 조건을 함수 안에 넣으라고 API 문서가 적습니다.
- 호출하는 쪽에서 키워드 인자를 쓸 수 없다고 적혀 있습니다. 4.0.0에서 SCALAR와 GROUPED_AGG 종류는 키워드 인자를 지원하게 바뀌었다는 표시도 같은 문서에 있어서 버전에 따라 다릅니다.
- 같은 API 문서에 4.1.0에서 GROUPED_MAP 종류가, 4.2.0에서 GROUPED_AGG 종류가 반복자 API를 지원하게 됐다는 변경 표시가 있습니다. 시험 기준 버전이 이전이면 범위 밖입니다.
- `ArrayType`의 `TimestampType`과 중첩 `StructType`은 출력 타입으로 지원하지 않는다고 API 문서가 적습니다.
- 반환한 Series의 타입이 `returnType`과 다르면 Spark가 변환을 시도하고 그 변환이 맞다는 보장이 없습니다. 4.1부터 `spark.sql.execution.pandas.convertToArrowArraySafely`가 기본으로 켜져서 정수 넘침 같은 안전하지 않은 변환에 오류를 냅니다.

## 11. pandas Function API

pandas UDF가 컬럼(Column) 단위라면 pandas Function API는 DataFrame 단위로 Python 함수를 적용합니다. 내부적으로 Arrow와 pandas를 쓰는 점은 같습니다. Arrow 문서는 Function API의 타입 힌트가 선택이고 지금은 동작에 영향을 주지 않는다고 적습니다. 다만 4.2.0 `applyInPandas` API 문서는 4.1.0에 추가된 반복자 형태를 타입 힌트(`Iterator[pd.DataFrame]`)로 받는 예제를 보여서 4.1 이후에는 힌트가 형태를 가를 수 있습니다.

| API | 함수 형태 | 출력 길이 | 시그니처 |
|---|---|---|---|
| `DataFrame.mapInPandas` | `Iterator[pd.DataFrame] -> Iterator[pd.DataFrame]` | 자유 | `mapInPandas(func, schema, barrier=False, profile=None)`(3.0.0) |
| `GroupedData.applyInPandas` | `pd.DataFrame -> pd.DataFrame`(그룹마다), 키 튜플을 첫 인자로 받을 수도 | 자유 | `applyInPandas(func, schema)`(3.0.0) |
| `PandasCogroupedOps.applyInPandas` | 두 `pd.DataFrame` -> `pd.DataFrame`, 키 튜플을 첫 인자로 받을 수도 | 자유 | `df1.groupBy(k).cogroup(df2.groupBy(k)).applyInPandas(func, schema)`(3.0.0) |

```python
# 고객별 주문 금액에서 고객 평균을 빼기(split-apply-combine)
def center_amount(pdf: pd.DataFrame) -> pd.DataFrame:
    return pdf.assign(amount=pdf.amount - pdf.amount.mean())

centered = (orders.select("customer_id", "order_id", "amount")
                  .groupBy("customer_id")
                  .applyInPandas(center_amount,
                                 schema="customer_id string, order_id string, amount double"))

# 배치마다 큰 주문만 남기기
def big_orders(batches):
    for pdf in batches:
        yield pdf[pdf.amount >= 100000]

large = orders.mapInPandas(big_orders, schema=orders.schema)
```

헷갈리는 지점입니다.

- `applyInPandas`는 함수를 적용하기 전에 그룹 하나의 데이터를 전부 메모리에 올립니다. 그룹 크기가 쏠리면 OOM이 날 수 있고 `maxRecordsPerBatch`는 그룹에 적용되지 않는다고 문서가 적습니다. Ch-04 10절의 익스큐터 OOM 원인 표에 이 API를 넣은 이유입니다. 4.1.0부터는 pandas DataFrame 반복자를 받는 형태도 지원하고 API 문서는 이 형태로 OOM 위험을 줄일 수 있다고 적습니다. cogroup 쪽은 코그룹 하나의 데이터를 전부 메모리에 올린다는 같은 주의가 있습니다.
- 반환 DataFrame의 컬럼 라벨은 `schema`를 문자열로 주면 필드 이름과 맞아야 하고 정수 인덱스처럼 문자열이 아니면 위치로 맞춥니다.
- `mapInPandas`의 각 pandas DataFrame 크기는 `maxRecordsPerBatch`로 조절됩니다.
- 3.0 이전의 grouped map pandas UDF(`PandasUDFType.GROUPED_MAP`과 `groupby().apply()`)는 `applyInPandas`로 옮기라고 문서가 권합니다.

## 12. 세 가지 Python UDF 비교

| | 일반 Python UDF(`udf`) | Arrow Python UDF(`udf(useArrow=True)`) | pandas UDF(`pandas_udf`) |
|---|---|---|---|
| 처리 단위 | 행 하나씩 | 행 하나씩. 전송만 Arrow 배치 | pandas Series 배치 |
| 직렬화 | pickle(4.2부터 기본 Arrow) | Arrow | Arrow |
| 기본 반환 타입 | `StringType` | `StringType` | 지정 필수 |
| 켜는 방법 | 기본 | `useArrow=True` 또는 `spark.sql.execution.pythonUDF.arrow.enabled=true`(설정은 `useArrow`가 None일 때만 적용) | 기본 |
| 벡터화 연산 | 안 됨(4.1부터 예외 있음, 아래) | 안 됨 | 된다 |

Arrow Python UDF는 따로 있는 함수가 아니고 `udf()`에 `useArrow`를 준 것입니다. 시그니처가 `udf(f=None, returnType=StringType(), *, useArrow=None)`이라 기본 반환 타입은 둘 다 `StringType`입니다. 4.2부터 일반 Python UDF가 기본으로 Arrow 최적화를 쓰면서 타입 변환(coercion) 동작이 달라졌습니다. 반환 값이 지정 타입과 맞지 않을 때 결과가 3.5와 다를 수 있다는 뜻입니다.

4.2.0 `udf` API 문서에는 4.1.0 변경 표시가 하나 더 있습니다. 함수에 pandas UDF의 타입 힌트 패턴(예: `pd.Series -> pd.Series`)을 달고 `useArrow`를 따로 주지 않으면 `udf`로 만들어도 pandas UDF로 처리됩니다. 3.5 기준 보기에서는 `@udf`가 행 단위라는 판단이 맞지만 4.1 이후 문서로 공부했다면 이 차이를 같이 기억합니다.

## 13. 확인 문제

시험 안내서 항목을 보고 직접 만든 문제입니다. 덤프나 문제 은행에서 가져온 것은 없습니다.

**문제 1.** Spark Connect 클라이언트가 서버로 보내는 것은 무엇입니까?

- A. Python 바이트코드
- B. 해석 전 논리 계획(protocol buffers, gRPC)
- C. 최적화된 물리 계획
- D. 직렬화한 RDD

<details>
<summary>정답과 근거</summary>

B입니다. 클라이언트는 DataFrame 연산을 해석 전 논리 계획으로 만들어 protocol buffers로 인코딩하고 gRPC로 보냅니다. 분석과 최적화, 물리 계획은 서버가 만듭니다. 결과는 Arrow 배치로 돌아옵니다.

</details>

**문제 2.** Spark Connect 세션에서 실패하는 코드는 무엇입니까?

- A. `orders.groupBy("status").count().show()`
- B. `orders.rdd.map(lambda r: r.amount).sum()`
- C. `orders.select(F.spark_partition_id()).distinct().count()`
- D. `orders.createOrReplaceTempView("orders")`

<details>
<summary>정답과 근거</summary>

B입니다. Spark Connect 프로토콜은 RDD 같은 실행 API를 지원하지 않고 `df.rdd`를 쓸 수 없습니다. 나머지는 DataFrame과 SQL API라 됩니다.

</details>

**문제 3.** 노트북에서 `spark-submit`으로 YARN에 제출했고 드라이버가 클러스터 안의 노드에서 뜨기를 원합니다. 어떤 옵션입니까?

<details>
<summary>정답과 근거</summary>

`--master yarn --deploy-mode cluster`입니다. 배포 모드는 드라이버가 어디서 뜨는지를 정하고 기본값 client는 제출한 프로세스 안에서 드라이버를 띄웁니다.

</details>

**문제 4.** `local[*]`과 `local`의 차이는 무엇입니까?

<details>
<summary>정답과 근거</summary>

`local`은 워커 스레드 하나로 병렬 처리가 없습니다. `local[*]`은 머신의 논리 코어 수만큼 스레드를 씁니다. 둘 다 드라이버와 실행이 한 JVM 안에서 도는 로컬 모드입니다.

</details>

**문제 5.** 1억 행 Spark DataFrame을 `pandas_api()`로 바꿨더니 느립니다. 행 순서와 연속 번호는 필요 없습니다. 무엇을 바꾸면 됩니까?

<details>
<summary>정답과 근거</summary>

기본 인덱스 비용을 줄입니다. 인덱스로 쓸 컬럼이 있으면 `pandas_api(index_col="order_id")`로 기본 인덱스 생성을 건너뜁니다. 없으면 `ps.set_option("compute.default_index_type", "distributed")`로 `monotonically_increasing_id` 기반 인덱스를 씁니다. `sequence`는 파티션 하나로 모을 수 있어 피합니다.

</details>

**문제 6.** 주문 금액 컬럼에 같은 길이의 결과를 내는 벡터화 함수를 적용하려고 합니다. 맞는 정의는 무엇입니까?

- A. `@pandas_udf("double")` + `def f(s: pd.Series) -> float`
- B. `@pandas_udf("double")` + `def f(s: pd.Series) -> pd.Series`
- C. `udf(lambda a: a * 1.1, "double")`
- D. `orders.mapInPandas(f, "double")`

<details>
<summary>정답과 근거</summary>

B입니다. Series에서 Series 타입 힌트가 같은 길이 결과를 내는 pandas UDF입니다. A는 Series에서 스칼라라 집계 UDF가 됩니다. C는 타입 힌트가 없는 일반 Python UDF라 행 하나씩 처리합니다. 결과 길이는 같지만 벡터화 함수는 아닙니다. D의 `mapInPandas`는 DataFrame 반복자를 받는 API이고 스키마도 DataFrame 스키마여야 합니다. 4.1부터는 `@udf`에 B와 같은 타입 힌트를 달아도 pandas UDF가 되지만(12절) 보기 C처럼 힌트가 없으면 해당하지 않습니다.

</details>

**문제 7.** `orders.groupBy("customer_id").applyInPandas(func, schema)`가 특정 고객 몇 명 때문에 익스큐터 OOM을 냅니다. `spark.sql.execution.arrow.maxRecordsPerBatch`를 1000으로 낮추면 해결됩니까?

<details>
<summary>정답과 근거</summary>

해결되지 않습니다. `applyInPandas`는 그룹 하나를 통째로 메모리에 올리고 `maxRecordsPerBatch`는 그룹에 적용되지 않습니다. 쏠린 그룹을 쪼개거나(Ch-04 salting) 그룹 단위 로직을 다시 짜야 합니다. 4.1 이상이면 함수를 `Iterator[pd.DataFrame]`을 받는 형태로 바꾸는 방법도 API 문서가 제시합니다.

</details>

**문제 8.** Spark 3.5에서 `toPandas()`가 Arrow를 쓰게 하려면 무엇을 합니까? 4.2에서는 어떻습니까?

<details>
<summary>정답과 근거</summary>

3.5에서는 `spark.sql.execution.arrow.pyspark.enabled`를 true로 켭니다. 기본값이 `spark.sql.execution.arrow.enabled`(false)를 따르기 때문입니다. 4.0과 4.1도 같습니다. 4.2에서는 기본이 true라서 따로 켤 필요가 없습니다. 어느 쪽이든 `toPandas()`는 모든 데이터를 드라이버로 모읍니다.

</details>

## 14. 범위와 한계

- 동작과 기본값은 2026년 10월 19일에 연 Spark 4.2.0 문서(Spark Connect Overview, Cluster Mode Overview, Submitting Applications, Configuration)와 PySpark 4.2.0 문서(Apache Arrow in PySpark, pandas API on Spark의 Options and settings, From/to pandas and PySpark DataFrames, Best Practices, Upgrading PySpark, API 참조)를 기준으로 했습니다. 3.5 기본값은 3.5.6 Configuration 문서로, 4.0과 4.1의 Arrow 기본값은 4.0.0과 4.1.0 Configuration 문서로 2026년 10월 20일에 다시 확인했습니다. `pyspark-client`의 첫 버전은 PyPI 릴리스 목록으로 확인했습니다.
- 이 글의 코드는 아직 실행하지 않았습니다. 이 노트북에 Java가 없어서 PySpark와 로컬 Connect 서버를 띄우지 못했습니다. Python 문법 검사(`ast.parse`)만 했습니다. `load_coupon_alias_table()`은 설명용으로 가정한 함수입니다.
- 확인하지 못한 것을 따로 적습니다. Connect에서 존재하지 않는 컬럼 오류가 나는 시점, accumulator와 broadcast 변수가 막히는지, `start-connect-server.sh`가 `spark-submit` 옵션을 받는지는 문서 문장으로 확인하지 못했습니다. 1절의 영역별 문항 수 짐작은 비중으로 계산한 값입니다.
- Spark Connect 위에서 pandas API on Spark가 어디까지 되는지는 다루지 않았습니다. 이번에 연 문서에서 지원 범위 표를 찾지 못했습니다.

## 참고 자료

공식 자료
- Databricks, [Exam Guide, Oct 2025](https://www.databricks.com/sites/default/files/2025-10/databricks-certified-associate-developer-apache-spark-exam-guide-oct-2025.pdf) (6, 7영역 항목과 샘플 문항 7)
- Apache Spark 4.2.0, [Spark Connect Overview](https://spark.apache.org/docs/latest/spark-connect-overview.html)
- PySpark 4.2.0, [Quickstart: Spark Connect](https://spark.apache.org/docs/latest/api/python/getting_started/quickstart_connect.html)
- Apache Spark 저장소, [client-connection-string.md](https://github.com/apache/spark/blob/master/sql/connect/docs/client-connection-string.md) (master 브랜치)
- Apache Spark 4.2.0, [Cluster Mode Overview](https://spark.apache.org/docs/latest/cluster-overview.html), [Submitting Applications](https://spark.apache.org/docs/latest/submitting-applications.html)
- Apache Spark 4.2.0, [Spark Configuration](https://spark.apache.org/docs/latest/configuration.html), 4.1.0 [Spark Configuration](https://spark.apache.org/docs/4.1.0/configuration.html), 4.0.0 [Spark Configuration](https://spark.apache.org/docs/4.0.0/configuration.html), 3.5.6 [Spark Configuration](https://spark.apache.org/docs/3.5.6/configuration.html)
- PySpark 3.5.6, [Options and settings](https://spark.apache.org/docs/3.5.6/api/python/user_guide/pandas_on_spark/options.html)
- PyPI, [pyspark-client](https://pypi.org/project/pyspark-client/) (릴리스 목록)
- PySpark 4.2.0, [PySpark Overview](https://spark.apache.org/docs/latest/api/python/index.html) (pandas API on Spark 소개)
- PySpark 4.2.0, [Options and settings](https://spark.apache.org/docs/latest/api/python/tutorial/pandas_on_spark/options.html), [From/to pandas and PySpark DataFrames](https://spark.apache.org/docs/latest/api/python/tutorial/pandas_on_spark/pandas_pyspark.html), [Best Practices](https://spark.apache.org/docs/latest/api/python/tutorial/pandas_on_spark/best_practices.html)
- PySpark 4.2.0, [Apache Arrow in PySpark](https://spark.apache.org/docs/latest/api/python/tutorial/sql/arrow_pandas.html)
- PySpark 4.2.0, [Upgrading PySpark](https://spark.apache.org/docs/latest/api/python/migration_guide/pyspark_upgrade.html)
- PySpark 4.2.0 API: [functions.pandas_udf](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.functions.pandas_udf.html), [DataFrame.mapInPandas](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.mapInPandas.html), [GroupedData.applyInPandas](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.GroupedData.applyInPandas.html), [PandasCogroupedOps.applyInPandas](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.PandasCogroupedOps.applyInPandas.html), [functions.udf](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.functions.udf.html), [DataStreamWriter.foreachBatch](https://spark.apache.org/docs/latest/api/python/reference/pyspark.ss/api/pyspark.sql.streaming.DataStreamWriter.foreachBatch.html), [DataFrame.pandas_api](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.DataFrame.pandas_api.html), [pyspark.pandas.DataFrame.to_spark](https://spark.apache.org/docs/latest/api/python/reference/pyspark.pandas/api/pyspark.pandas.DataFrame.to_spark.html), [pyspark.pandas.DataFrame.to_pandas](https://spark.apache.org/docs/latest/api/python/reference/pyspark.pandas/api/pyspark.pandas.DataFrame.to_pandas.html), [SparkSession.builder.remote](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql/api/pyspark.sql.SparkSession.builder.remote.html)

이 시리즈
- [Spark Ch-00: 시험 구조와 공부 계획](/blog/cert/spark/spark-00-exam-and-study-plan), [Spark Ch-04: 문제 해결과 튜닝](/blog/cert/spark/spark-04-troubleshooting-tuning), [Spark Ch-05: Structured Streaming](/blog/cert/spark/spark-05-structured-streaming)

---
title: '[DE Ch-01] 데이터 파이프라인의 큰 그림: 입력이 끝나는지, 원본을 남기는지'
description: 데이터가 생겨서 쓰이기까지 다섯 단계를 거칩니다. 배치와 스트림은 속도보다 입력이 끝나는지로 갈리고 Lambda와 Kappa는 같은 계산을 몇 벌 유지하는지로 갈립니다. 메달리온 구조가 원본을 고치지 않고 남기는 이유를 DuckDB로 버그를 냈다가 되살리며 확인합니다.
date: 2026-10-19T00:00:00.000Z
tags:
  - Data Engineering
  - Data Pipeline
  - Batch
  - Stream Processing
  - Lambda Architecture
  - Medallion Architecture
  - DuckDB
category: data/Foundations
topics:
  - pipeline
  - messaging
draft: false
series: "DE 공부"
seriesOrder: 1
---

## 결론부터

1. 데이터는 생성, 저장, 수집, 변환, 서빙 다섯 단계를 거쳐 쓰입니다. 단계마다 깨지는 방식이 다르고 그 밑에는 보안, 데이터 관리, 오케스트레이션처럼 모든 단계에 걸친 일이 깔려 있습니다.
2. 배치와 스트림을 가르는 기준은 입력이 끝나는지입니다. 끝이 있는 입력(bounded)은 다 모은 뒤 한 번에 계산할 수 있고 끝이 없는 입력(unbounded)은 언제 결과를 낼지부터 정해야 합니다.
3. Lambda 아키텍처는 같은 계산을 배치와 스트림 두 벌로 유지하는 비용 때문에 비판받았습니다. Kappa는 로그를 충분히 오래 보관해서 다시 읽는 것으로 배치를 대신합니다.
4. 메달리온 구조(Bronze, Silver, Gold)의 핵심은 Bronze에 받은 원본을 고치지 않고 남기는 것입니다. Silver 로직에 버그가 있었다는 걸 나중에 알아도 Bronze에서 다시 만들 수 있습니다.

---

## 1. 데이터를 옮기는 도중에 생기는 일

데이터 엔지니어링을 처음 들으면 데이터를 A에서 B로 옮기는 일로 이해하기 쉽습니다. 틀린 말은 아닌데, 이 설명으로는 왜 그렇게 많은 도구와 단계가 필요한지가 안 보입니다.

옮기는 도중에 생기는 일을 적어 보면 감이 옵니다.

- 같은 이벤트가 두 번 들어옵니다.
- 가격 칸에 숫자 대신 `ERR`이 들어옵니다.
- 10시 1분에 생긴 이벤트가 10시 5분에 도착합니다.
- 어제 돌린 정제 로직에 버그가 있었다는 걸 일주일 뒤에 압니다.

이런 일이 생겨도 결과를 믿을 수 있게 만드는 것이 데이터 엔지니어링의 대부분입니다. 그래서 먼저 데이터가 거치는 단계를 나누고 단계마다 무엇이 깨지는지 보는 데서 시작합니다.

## 2. 데이터 엔지니어링 수명주기 다섯 단계

『Fundamentals of Data Engineering』(Reis, Housley)은 데이터가 생겨서 쓰이기까지를 다섯 단계로 나눕니다.

```
생성(Generation) → 저장(Storage) → 수집(Ingestion) → 변환(Transformation) → 서빙(Serving)
```

| 단계 | 하는 일 | 쇼핑몰 예 | 여기서 깨지는 것 |
|---|---|---|---|
| 생성 | 원천 시스템이 데이터를 만든다 | 앱이 상품 조회 이벤트를 남긴다 | 원천 스키마가 예고 없이 바뀐다 |
| 저장 | 어디에 어떤 형태로 둘지 정한다 | 객체 스토리지, 데이터 웨어하우스 | 비용, 보관 기간, 읽기 패턴이 안 맞는다 |
| 수집 | 원천에서 가져온다 | Kafka로 받거나 매일 밤 덤프를 가져온다 | 중복, 유실, 순서 뒤바뀜 |
| 변환 | 쓸 수 있는 모양으로 바꾼다 | 중복 제거, 타입 정리, 집계 | 로직 버그, 늦게 온 데이터 |
| 서빙 | 쓰는 쪽에 내준다 | 대시보드, 추천 모델 학습 데이터 | 지표 정의가 팀마다 다르다 |

저장이 수집보다 앞에 있는 게 어색해 보일 수 있습니다. 책은 저장을 모든 단계에 걸친 결정으로 봅니다. 수집한 데이터도 변환 중간 결과도 결국 어딘가에 저장되기 때문입니다.

다섯 단계 밑에는 모든 단계에 걸친 여섯 가지가 깔려 있습니다(undercurrents). 보안, 데이터 관리, DataOps, 데이터 아키텍처, 오케스트레이션, 소프트웨어 엔지니어링입니다. 이 시리즈의 Ch-02부터 다룰 오케스트레이션이 여기에 들어갑니다. 단계마다 언제, 어떤 순서로, 실패하면 어떻게 다시 돌릴지를 정하는 일이라 특정 단계 하나에 속하지 않습니다.

## 3. 배치와 스트림은 입력이 끝나는지로 갈린다

배치는 느리고 스트림은 빠르다고 설명하는 경우가 많습니다. 결과만 보면 대체로 맞지만 기준으로 쓰기에는 부족합니다. 5분마다 도는 배치도 있고 결과를 하루에 한 번 내는 스트림 작업도 있습니다.

Tyler Akidau는 2015년 글 "Streaming 101"에서 입력의 성질로 나눕니다. 끝이 없는 데이터를 unbounded, 끝이 있는 데이터를 bounded라고 부르고 스트리밍은 "무한한 데이터를 염두에 두고 설계한 처리 엔진"으로 따로 정의합니다. 그리고 잘 설계한 스트리밍 시스템은 배치 기능을 모두 포함한다고 적습니다.

| | 끝이 있는 입력(bounded) | 끝이 없는 입력(unbounded) |
|---|---|---|
| 예 | 어제 하루치 주문 파일 | 지금도 들어오는 상품 조회 이벤트 |
| 계산 방식 | 다 읽은 뒤 계산한다 | 들어오는 대로 계산하면서 언제 결과를 낼지 정한다 |
| 늦게 온 데이터 | 다 모은 뒤 계산하므로 순서가 상관없다 | 이미 낸 결과를 고칠지, 버릴지 정해야 한다 |
| 다시 계산 | 같은 파일로 다시 돌리면 된다 | 지난 입력을 어딘가에 보관하고 있어야 한다 |

여기서 갈리는 지점은 "언제 결과를 내도 되는지"입니다. 끝이 있는 입력은 다 읽었을 때가 답입니다. 끝이 없는 입력은 10시 1분 집계를 10시 2분에 내도 되는지, 10시 5분에 늦게 온 10시 1분 이벤트를 어떻게 할지를 따로 정해야 합니다. 이 질문은 Ch-15(watermark)에서 다시 나옵니다.

## 4. Lambda와 Kappa: 같은 계산을 몇 벌 유지하는가

### 4-1. Lambda 아키텍처

Lambda 아키텍처는 Kreps의 표현으로 MapReduce와 Storm 같은 시스템 위에 스트림 처리 애플리케이션을 만드는 방식입니다. 배치 계층과 속도 계층(speed layer)을 함께 둡니다.

```
                ┌→ 배치 계층: 전체 데이터를 주기적으로 다시 계산 (정확, 느림) ─┐
원천 이벤트 ────┤                                                         ├→ 서빙 계층에서 합침
                └→ 속도 계층: 최근 데이터만 스트림으로 계산 (빠름, 근사) ──┘
```

스트림 처리기가 정확한 결과를 보장하기 어렵던 시절에 나온 구조입니다. 빠른 근사값은 스트림으로 보여 주고 나중에 배치가 정확한 값으로 덮어씁니다.

### 4-2. Kreps의 비판과 Kappa

Jay Kreps는 2014년 "Questioning the Lambda Architecture"에서 이 구조의 비용을 짚었습니다. 글의 표현으로는 복잡한 분산 시스템 두 곳에서 같은 결과를 내야 하는 코드를 유지하는 일입니다. 로직을 하나 고치면 두 군데를 고쳐야 하고 두 구현은 시간이 지나면서 조금씩 어긋납니다.

그가 제안한 방식은 나중에 Kappa 아키텍처로 불립니다.

1. 다시 처리하고 싶은 데이터 전체를 Kafka 같은 로그에 보관합니다. 30일치를 다시 처리하고 싶으면 보존 기간을 30일로 둡니다.
2. 로직을 고치면 스트림 처리 작업의 두 번째 인스턴스를 띄워 보관된 데이터의 처음부터 처리하게 합니다.
3. 두 번째 작업이 따라잡으면 애플리케이션이 새 결과 테이블을 읽게 바꿉니다.
4. 옛 작업을 멈추고 옛 결과 테이블을 지웁니다.

Kappa가 성립하려면 전제가 하나 있습니다. 다시 계산하고 싶은 기간만큼 로그를 보관하고 있어야 합니다. 1년치를 다시 계산하려면 1년치 로그가 있어야 합니다. 이 전제가 비싸면 결국 배치 재계산 경로를 따로 두게 됩니다.

## 5. 메달리온 구조: Bronze에 원본을 남긴다

Kappa가 로그를 보관해서 재계산을 가능하게 했다면, 메달리온 구조(medallion architecture)는 테이블 층으로 같은 일을 합니다. Databricks가 문서와 블로그에서 쓰면서 퍼진 이름이고 지금은 여러 클라우드 문서에 같은 이름으로 나옵니다.

| 층 | 들어 있는 것 | 바꾸는 것 |
|---|---|---|
| Bronze | 받은 그대로의 원본. 중복, 잘못된 값 포함 | 바꾸지 않는다. 받은 시각 같은 메타데이터만 붙인다 |
| Silver | 정리된 데이터 | 중복 제거, 타입 정리, 잘못된 값 제거, 키 맞추기 |
| Gold | 쓰는 쪽이 원하는 모양 | 집계, 비즈니스 지표 |

층을 셋으로 나누는 이유는 Bronze에 있습니다. Silver 로직은 사람이 짜는 코드라 버그가 생깁니다. Bronze를 고치지 않고 남겨 두면 버그를 고친 Silver 로직으로 Bronze부터 다시 만들 수 있습니다. Bronze까지 정리된 상태로만 저장했다면 버그로 잃은 정보는 되돌릴 방법이 없습니다.

## 6. 재현: DuckDB로 버그를 냈다가 Bronze에서 되살리기

### 6-1. 환경과 데이터

- DuckDB 하나로 Bronze, Silver, Gold 세 테이블을 만듭니다. Kafka나 클러스터는 쓰지 않습니다.
- 원천은 쇼핑몰 상품 조회 로그 1만 건입니다. 사용자 5명, 0.1초 간격입니다.
- 일부러 섞은 문제는 세 가지입니다.
  - 300번째마다 같은 이벤트가 두 번 들어옵니다(34건).
  - 500번째마다 가격이 `ERR`입니다(20건).
  - 100~300번째 사이 200건의 순서를 섞었습니다.
- 난수 시드를 고정해서 어디서 돌려도 결과가 같습니다.

전체 코드는 [labs/de-study/ch01](https://github.com/dj258255/IT-Oasis/tree/main/labs/de-study/ch01)에 있습니다. 핵심은 세 층의 SQL입니다.

```sql
-- Bronze: 받은 그대로
CREATE TABLE bronze AS
SELECT * FROM read_json('bronze.jsonl',
  columns = {'user': 'VARCHAR', 'ts': 'DOUBLE', 'price': 'VARCHAR'});

-- Silver: 중복 제거, 타입 정리, 잘못된 값 걸러내기
CREATE TABLE silver AS
SELECT DISTINCT "user", to_timestamp(ts) AS ts, CAST(price AS BIGINT) AS price
FROM bronze
WHERE TRY_CAST(price AS BIGINT) IS NOT NULL;

-- Gold: 사용자별 1분간 본 상품 평균 가격
CREATE TABLE gold AS
SELECT "user", time_bucket(INTERVAL '1 minute', ts) AS minute,
       round(avg(price)) AS avg_price, count(*) AS views
FROM silver GROUP BY ALL ORDER BY ALL;
```

Bronze에서 가격 칸을 `VARCHAR`로 받은 데 이유가 있습니다. 숫자 타입으로 받으면 `ERR`이 들어온 행에서 적재가 실패하거나 값이 사라집니다. 원본을 그대로 남기려면 가장 너그러운 타입으로 받고 정리는 Silver에서 합니다.

### 6-2. 결과

| | Bronze | Silver | Gold 조회 수 합계 |
|---|---|---|---|
| 정상 | 10,034행 | 9,980행 | 9,980 |
| Silver에서 `DISTINCT`를 빼먹음 | 10,034행 | 10,007행 | 10,007 |

행 수가 줄어든 이유를 하나씩 맞춰 보면 이렇습니다.

- Bronze 10,034행은 원본 1만 건에 두 번 들어온 34건을 더한 값입니다.
- 잘못된 가격은 20건인데, 그중 7건(1,500번째마다)은 두 번 들어온 이벤트이기도 해서 Bronze에는 27행입니다.
- Silver 9,980행은 10,034행에서 잘못된 가격 27행과 남은 중복 27행을 뺀 값입니다.

`DISTINCT`를 빼먹으면 중복 27건이 Gold 조회 수에 그대로 들어갑니다. 1분 평균 가격도 중복된 이벤트에 가중치가 두 배로 붙어서 조금씩 달라집니다. 이 버그는 에러를 내지 않습니다. 테이블은 만들어지고 숫자도 그럴듯해 보입니다.

### 6-3. Bronze가 있어서 되살릴 수 있었다

버그를 알게 된 뒤 할 일은 간단합니다. Silver SQL에 `DISTINCT`를 다시 넣고 Silver와 Gold를 Bronze부터 다시 만들면 9,980으로 돌아옵니다.

Bronze 없이 Silver만 저장했다면 사정이 다릅니다. 버그가 있는 Silver에는 어떤 행이 중복이었는지 표시가 없습니다. 같은 사용자가 같은 시각에 같은 가격 상품을 정말 두 번 봤을 수도 있어서 Silver만 보고는 중복을 확정할 수 없습니다.

늦게 도착한 이벤트 200건은 이 재현에서 아무 문제도 일으키지 않았습니다. 다 모은 뒤 계산하는 배치라서 순서가 결과에 영향을 주지 않기 때문입니다. 같은 데이터를 스트림으로 1분마다 집계했다면 10시 1분 결과를 이미 낸 뒤에 10시 1분 이벤트가 도착하는 경우가 생깁니다. 3절에서 말한 "언제 결과를 내도 되는지"가 여기서 갈립니다.

## 7. 트레이드오프

| 선택 | 얻는 것 | 내는 비용 |
|---|---|---|
| Bronze에 원본을 남긴다 | 버그를 고친 뒤 다시 만들 수 있다. 원천 시스템이 지운 데이터도 남는다 | 저장 공간, 개인정보 같은 원본 데이터의 보관 책임 |
| 층을 셋으로 나눈다 | 문제가 어느 층에서 생겼는지 좁힐 수 있다 | 같은 데이터가 세 벌 있고 갱신 지연이 층마다 쌓인다 |
| Kappa로 하나만 유지한다 | 로직이 한 벌이다 | 재계산하려는 기간만큼 로그를 보관해야 한다 |
| Lambda로 두 벌 유지한다 | 배치로 정확한 값을 확정할 수 있다 | 같은 로직을 두 번 구현하고 맞춰야 한다 |

메달리온의 층 이름은 정해진 표준이 아닙니다. 회사마다 raw, staging, mart처럼 다르게 부르고 층 수도 다릅니다. 중요한 것은 원본을 고치지 않고 남기는 층이 있는지입니다.

## 8. 중국과 국내 빅테크 사례

### 8-1. 중국의 데이터 웨어하우스 계층: ODS, DWD, DWS, ADS

중국 빅테크의 데이터 웨어하우스 글에는 메달리온 대신 ODS, DWD, DWS, ADS 같은 계층 이름이 나옵니다. Alibaba Cloud MaxCompute 문서는 ODS, CDM(DIM, DWD, DWS), ADS 세 층으로 나누고 ODS를 "구조가 원천 시스템과 같게 유지되는 층"으로, DWD를 "업무 과정을 기준으로 가장 잘게 쪼갠 명세 사실 테이블을 만드는 층"으로 정의합니다.

Meituan의 2019년 글 "OneData建设探索之路：SaaS收银运营数仓建设"은 표준 흐름을 ODS → DWD → DWA → APP로 두고 두 가지 규칙을 적었습니다. ODS 테이블은 DWD만 참조할 수 있고 거꾸로 의존하는 것을 금지합니다. 계층을 다시 짜기 전에는 각자 따로 만드는 굴뚝식 개발, 혈연(lineage) 추적의 어려움, SLA 보장의 어려움이 있었다고 적었습니다.

두 계층 이름을 나란히 놓으면 이렇게 대응합니다. 아래 표는 두 회사의 문서를 놓고 이 글에서 짝지은 것이고 이 대응을 직접 적은 글은 찾지 못했습니다.

| 메달리온 | 중국식 계층 | 공통점 |
|---|---|---|
| Bronze | ODS | 원천과 같은 구조로 받아 둔다 |
| Silver | DWD(와 DIM) | 정리하고 가장 잘게 쪼갠 사실 데이터 |
| Gold | DWS, ADS | 집계하고 쓰는 쪽에 맞춘 데이터 |

Meituan의 "ODS는 DWD만 참조" 규칙은 5절의 "Bronze를 고치지 않고 Silver가 Bronze에서 만든다"와 같은 원칙입니다.

### 8-2. Kappa의 중간 저장소를 바꾼 Tencent

Tencent 데이터플랫폼부의 2021년 발표 정리 "数据湖｜Flink + Iceberg 全场景实时数仓的建设实践"은 Kappa 아키텍처의 중간 저장소를 Kafka에서 Iceberg로 바꾸자고 제안합니다. 입수 지연이 시간이나 일 단위에서 분이나 초 단위로 줄어드는 대신 엄밀한 실시간에서 준실시간이 된다는 대가를 함께 적었습니다. 4-2절에서 본 Kappa의 전제(다시 계산하려는 기간만큼 로그 보관)를 Kafka보다 싼 저장소로 지키는 방법입니다. Tencent 微视의 2022년 글은 Kafka의 단위 저장 비용이 Hive의 10배를 넘는다고 적었습니다.

## 9. 범위와 한계

- 재현은 1만 건짜리 장난감 데이터입니다. 실제 규모에서 Bronze 보관 비용이나 재계산 시간은 재지 않았습니다.
- 스트림 쪽 재현은 하지 않았습니다. 늦게 온 데이터가 스트림 결과를 어떻게 바꾸는지는 Ch-15~16에서 다룹니다.
- 메달리온에서 Bronze를 얼마나 오래 보관할지, 개인정보를 Bronze에 그대로 둬도 되는지는 규정과 비용으로 정할 문제라 여기서 답하지 않았습니다.

## 10. 헷갈렸던 것

**Q. Bronze에 원본을 다 남기면 Silver에서 지운 잘못된 값도 계속 남는데 괜찮은가요?**

남는 게 맞습니다. 오늘 잘못된 값으로 판단한 규칙이 틀렸을 수도 있기 때문입니다. 예를 들어 가격 0원을 잘못된 값으로 걸렀는데 나중에 무료 상품이 생기면, Bronze가 있어야 그 행들을 되살릴 수 있습니다.

**Q. Kappa면 배치는 아예 필요 없나요?**

계산 로직을 한 벌로 줄인다는 뜻입니다. 지난 데이터를 다시 계산하는 일은 여전히 있고 Kappa는 그 일을 로그를 처음부터 다시 읽는 스트림 작업으로 합니다. 로그 보관 기간이 짧으면 그 기간 밖은 다시 계산할 수 없습니다.

**Q. 오케스트레이터는 이 그림에서 어디에 있나요?**

모든 단계에 걸쳐 있습니다. 수집 작업이 끝나면 Silver를 만들고 Silver가 끝나면 Gold를 만들고 중간에 실패하면 다시 돌리는 순서를 정하는 일입니다. 다음 글(Ch-02)에서 다룹니다.

## 참고 자료

- Joe Reis, Matt Housley, 『Fundamentals of Data Engineering』, O'Reilly, 2022. [2장 The Data Engineering Lifecycle](https://oreilly.com/library/view/fundamentals-of-data/9781098108298/ch02.html)
- Joe Reis, [The Data Engineering Lifecycle and Undercurrents, 4 Years Later](https://joereis.substack.com/p/the-data-engineering-lifecycle-and)
- Tyler Akidau, [Streaming 101: The world beyond batch](https://www.oreilly.com/radar/the-world-beyond-batch-streaming-101/), O'Reilly Radar, 2015
- 더 읽을거리: Martin Kleppmann, 『데이터 중심 애플리케이션 설계』 10장(일괄 처리), 11장(스트림 처리)
- Jay Kreps, [Questioning the Lambda Architecture](https://www.oreilly.com/radar/questioning-the-lambda-architecture/), O'Reilly Radar, 2014
- Databricks, [What is the medallion lakehouse architecture?](https://docs.databricks.com/aws/en/lakehouse/medallion)
- 실습 코드: [labs/de-study/ch01](https://github.com/dj258255/IT-Oasis/tree/main/labs/de-study/ch01)

중국과 국내 빅테크 사례
- Alibaba Cloud, [数仓分层介绍及架构](https://help.aliyun.com/zh/maxcompute/getting-started/divide-a-data-warehouse-into-layers)(MaxCompute 문서)
- Meituan, [OneData建设探索之路：SaaS收银运营数仓建设](https://tech.meituan.com/2019/10/17/meituan-saas-data-warehouse.html), 2019
- 苏舒(Tencent), [数据湖｜Flink + Iceberg 全场景实时数仓的建设实践](https://cloud.tencent.com/developer/article/1867867), 2021
- 黄彬耕(Tencent), [Iceberg在腾讯微视实时场景的应用](https://cloud.tencent.com/developer/article/2099307), 2022

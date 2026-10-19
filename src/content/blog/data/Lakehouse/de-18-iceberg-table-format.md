---
title: '[DE Ch-18] 테이블 포맷이 필요한 이유: Iceberg는 디렉터리 대신 파일 목록을 기록한다'
description: Hive 방식 테이블은 디렉터리를 나열해서 테이블의 상태를 알아냅니다. 그래서 원자적 커밋이 없고 객체 스토리지에서 계획 시간이 파티션 수에 비례합니다. Iceberg는 테이블에 속한 파일을 메타데이터 계층으로 기록하고 메타데이터 포인터를 원자적으로 바꿔 커밋합니다. PyIceberg로 로컬 Iceberg 테이블을 만들어 커밋마다 생기는 파일과 스냅샷을 직접 보고 낙관적 동시성, 숨은 파티셔닝, 스키마 진화, 행 단위 삭제를 명세 기준으로 정리합니다.
date: 2026-10-19T00:00:00.000Z
tags:
  - Data Engineering
  - Iceberg
  - Lakehouse
  - Table Format
  - PyIceberg
  - Snapshot
category: data/Lakehouse
topics:
  - pipeline
  - database
draft: false
series: "DE 공부"
seriesOrder: 18
---

## 결론부터

1. Hive 방식 테이블은 파티션을 디렉터리로 두고 그 안의 파일을 나열해서 테이블을 읽습니다. 바꾸는 단위가 파일과 디렉터리라 여러 파일에 걸친 변경을 한 번에 반영할 수 없고 계획할 때 파티션 수만큼 나열을 호출합니다.
2. Iceberg는 테이블에 속한 파일 하나하나를 메타데이터에 기록합니다. 카탈로그 → metadata.json → manifest list(스냅샷) → manifest → 데이터 파일의 계층이고 커밋은 카탈로그가 가리키는 metadata.json을 원자적으로 바꾸는 일입니다.
3. PyIceberg로 확인해 보니 커밋 한 번마다 metadata.json이 하나씩 늘었고(4번 커밋 뒤 5개), 스냅샷마다 manifest list가 생겼습니다. 덮어쓰기 한 번은 delete 스냅샷과 append 스냅샷 두 개를 한 커밋으로 만들었습니다.
4. 커밋은 낙관적 동시성으로 합니다. 두 쓰기가 같은 버전을 기준으로 동시에 커밋하면 하나만 성공하고 나머지는 새 버전을 기준으로 다시 시도합니다.
5. 파티션 값을 컬럼에서 자동으로 만들어(숨은 파티셔닝) 쿼리가 파티션 구조를 몰라도 되고 컬럼을 이름 대신 ID로 추적해서 이름 바꾸기와 삭제가 안전합니다.

---

## 1. 디렉터리로 테이블을 표현할 때의 문제

Ch-01의 메달리온 구조에서 Bronze, Silver, Gold는 결국 객체 스토리지(S3 같은) 위의 파일입니다. 파일 묶음을 테이블처럼 쓰는 가장 오래된 방법이 Hive 방식입니다.

```
s3://shop/orders/day=2026-10-01/part-0001.parquet
s3://shop/orders/day=2026-10-01/part-0002.parquet
s3://shop/orders/day=2026-10-02/part-0001.parquet
```

파티션은 디렉터리이고 테이블을 읽으려면 디렉터리 안의 파일을 나열합니다. Iceberg의 Reliability 문서가 이 방식의 문제를 정리합니다.

| 문제 | 문서의 설명 |
|---|---|
| 원자적 변경이 없다 | 파티션은 중앙 메타스토어에, 파일은 파일시스템에 두고 추적해서 테이블 내용을 원자적으로 바꿀 수 없다 |
| 나열이 틀릴 수 있다 | 결과적 일관성 스토리지에서는 파일을 나열해 테이블 상태를 재구성하다 틀린 결과가 나올 수 있다 |
| 계획이 느리다 | 계획할 때 파티션 수에 비례하는 느린 나열 호출이 필요하다(O(n)) |

Partitioning 문서는 Hive 파티셔닝의 문제를 더 듭니다. Hive는 파티션 값을 검증하지 않아서 쓰는 쪽이 형식을 잘못 넣으면 쿼리가 실패하지 않고 조용히 틀린 결과를 냅니다. 쿼리가 파티션 구조에 묶여 있어서 일 단위 파티션을 시간 단위로 바꾸려면 새 테이블이 필요합니다. 파티션 컬럼 조건을 빠뜨리면 테이블 전체를 읽습니다.

Ch-03의 "덮어쓰기 도중에 죽으면" 문제가 여기서 다시 나옵니다. 10월 1일 파티션의 파일 셋을 새 파일 셋으로 바꾸는 도중에 죽으면, 디렉터리에는 옛 파일과 새 파일이 섞여 남습니다. 읽는 쪽은 그 섞인 상태를 그대로 봅니다.

Netflix의 Ryan Blue와 Owen O'Malley는 2018년 Strata NY 발표에서 이 문제를 Iceberg의 출발점으로 소개했습니다. 발표 자료의 사례는 한 달치 데이터(파일 270만 개, 파티션 2,688개)를 조회할 때 Hive 테이블은 계획(EXPLAIN)에 9.6분이 걸렸고 Iceberg는 파티션과 min/max 통계로 거른 계획이 25초였습니다.

## 2. Iceberg의 메타데이터 계층

### 2-1. 구조

Iceberg 명세는 테이블이 디렉터리 대신 개별 데이터 파일을 추적한다고 적습니다.

```
카탈로그: "shop.orders의 현재 메타데이터는 00004-....metadata.json"
   │
   ▼
metadata.json   스키마, 파티션 설정, 속성, 스냅샷 목록
   │
   ▼
manifest list   스냅샷 하나 = 그 시점에 테이블을 이루는 manifest 목록
   │
   ▼
manifest        데이터 파일 목록과 각 파일의 파티션 값, 통계(행 수, 컬럼별 min/max)
   │
   ▼
데이터 파일      parquet
```

명세의 설명입니다. 테이블 상태는 메타데이터 파일에 있고 모든 변경은 새 메타데이터 파일을 만들어 옛 것을 원자적으로 바꿉니다. 스냅샷의 데이터 파일은 manifest가 추적하고 잘 바뀌지 않는 메타데이터를 다시 쓰지 않으려고 manifest를 여러 스냅샷이 재사용합니다.

읽는 쪽은 디렉터리를 나열하지 않습니다. 카탈로그에서 metadata.json 위치를 받고 거기서 현재 스냅샷의 manifest list를, manifest에서 파일 목록과 통계를 읽습니다. Reliability 문서는 이걸 O(n) 디렉터리 나열 대신 O(1) 호출로 계획한다고 표현합니다. manifest의 통계로 조건에 맞지 않는 파일은 열기 전에 거릅니다.

### 2-2. 재현: 커밋마다 생기는 파일

PyIceberg 0.12.0으로 로컬에 Iceberg 테이블을 만들었습니다. 카탈로그는 SQLite 파일, 데이터는 로컬 폴더입니다([labs/de-study/ch18](https://github.com/dj258255/IT-Oasis/tree/main/labs/de-study/ch18)의 `iceberg_snapshots.py`). PyIceberg 문서는 이 SQLite 카탈로그가 확장성 때문에 운영에 쓰면 안 된다고 적습니다.

```python
catalog = SqlCatalog("local", uri=f"sqlite:///{WH}/catalog.db", warehouse=f"file://{WH}")
table = catalog.create_table("shop.orders", schema=...)
table.append(orders([(1, "10-01", 30000), (2, "10-01", 12000)]))
```

주문을 세 번 append하고 4번 주문 금액을 고치려고 한 번 overwrite했습니다.

| 작업 | 현재 스냅샷의 operation | 행 | metadata.json | manifest/list(.avro) | parquet |
|---|---|---|---|---|---|
| 테이블 생성 | 없음 | 0 | 1 | 0 | 0 |
| append 10/1 주문 2건 | append | 2 | 2 | 2 | 1 |
| append 10/2 주문 1건 | append | 3 | 3 | 4 | 2 |
| append 10/2 주문 1건 더 | append | 4 | 4 | 6 | 3 |
| overwrite(4번 금액 정정) | append | 4 | 5 | 10 | 4 |

- 커밋 한 번에 metadata.json이 하나씩 생깁니다. 옛 파일은 지워지지 않고 남습니다.
- append 한 번에 .avro가 두 개(manifest 하나, manifest list 하나)씩 늘었습니다.
- overwrite는 커밋 한 번(metadata.json +1)인데 .avro가 네 개 늘었습니다. 스냅샷 이력을 보면 그 커밋 안에서 스냅샷 두 개가 생겼습니다.

```
3639411749371604280  parent=None  op=append  added-records=2
7829734376561471578  parent=3639…  op=append  added-records=1
2825750422608796448  parent=7829…  op=append  added-records=1
4943397126216921616  parent=2825…  op=delete  deleted-records=4
8795853182159907769  parent=4943…  op=append  added-records=4
```

PyIceberg의 overwrite는 기존 행을 지우는 delete 스냅샷과 새 행을 넣는 append 스냅샷을 만들어 한 커밋으로 반영했습니다. 커밋이 하나라서 현재 테이블을 읽는 쪽은 중간 상태를 보지 않습니다. Ch-03에서 트랜잭션으로 막았던 "지우고 넣는 사이"가 메타데이터 포인터 교체 한 번으로 해결됩니다. 다만 스냅샷 기록에는 중간 상태가 남는데 Ch-19의 시간 여행에서 다시 봅니다. 스냅샷 ID는 실행할 때마다 달라집니다.

## 3. 커밋과 동시성

### 3-1. 낙관적 동시성

명세의 커밋 규칙입니다.

- 메타데이터 파일 하나를 다른 것으로 원자적으로 바꾸는 것이 직렬화 가능 격리의 바탕입니다.
- 쓰는 쪽은 자기가 기준으로 삼은 버전이 커밋 전까지 바뀌지 않는다고 가정하고 새 메타데이터를 만듭니다. 커밋은 테이블의 메타데이터 포인터를 기준 버전에서 새 버전으로 바꾸는 것입니다.
- 기준 버전이 더 이상 현재가 아니면 새 현재 버전을 기준으로 다시 시도해야 합니다.

메타스토어나 DB 카탈로그는 포인터를 check-and-put(현재 값이 기대한 값일 때만 바꾸기)으로 갱신합니다. 같은 버전을 기준으로 두 커밋이 동시에 오면 하나만 성공합니다.

다시 시도할 때는 작업 종류에 따라 확인할 것이 다릅니다. 명세는 append는 아무 조건 없이 항상 다시 적용할 수 있고 파일을 바꾸는 작업(replace)은 지울 파일이 아직 테이블에 있는지 확인해야 한다고 적습니다. Reliability 문서의 예로, 컴팩션이 `file_a`와 `file_b`를 `merged`로 합치는 커밋은 두 원본이 아직 테이블에 있을 때만 성공합니다. 그 사이 다른 작업이 `file_a`를 지웠다면 컴팩션 결과를 반영하면 안 되기 때문입니다.

### 3-2. 운영에서는 check-and-put이 되는 카탈로그를 쓴다

명세는 파일시스템에서 rename으로 `v<V>.metadata.json`을 만드는 커밋 방식을 v4에서 없앨 예정이라고 적고 객체 스토리지와 로컬 파일시스템에서 안전하지 않다고 설명합니다. S3의 rename은 원자적이지 않기 때문입니다. 그래서 운영에서는 DB나 메타스토어, REST 카탈로그처럼 check-and-put이 되는 카탈로그를 씁니다.

## 4. 숨은 파티셔닝과 진화

### 4-1. 숨은 파티셔닝

Iceberg는 파티션 값을 컬럼에서 변환으로 만듭니다. Partitioning 문서의 예로, Iceberg가 `event_time`을 `event_date`로 바꾸는 일을 맡고 그 관계를 기록하므로 데이터를 쓰는 쪽도 읽는 쪽도 `event_date`를 볼 필요가 없습니다. 쿼리는 `WHERE event_time >= '2026-10-01'`처럼 원래 컬럼으로 조건을 걸고 Iceberg가 그 조건에서 파티션 조건을 끌어냅니다. 1절에서 본 "파티션 값 형식 오류"와 "파티션 조건 누락"이 생기지 않습니다.

### 4-2. 파티션 진화

파티션 설정을 바꾸면 이전 데이터는 이전 설정 그대로 두고 새 데이터만 새 설정으로 씁니다. 문서는 파티션 진화가 메타데이터 작업이고 파일을 미리 다시 쓰지 않는다고 적습니다. 읽을 때는 설정별로 나눠서 계획합니다. Hive에서 새 테이블이 필요했던 일 단위 → 시간 단위 변경을 같은 테이블에서 할 수 있습니다.

### 4-3. 스키마 진화: ID로 컬럼을 찾는다

명세는 데이터 파일의 컬럼을 필드 ID로 고른다고 적습니다. 새 필드에는 새 ID를 주고 이름을 바꿀 때는 이름만 바꾸고 ID는 그대로 둡니다. Evolution 문서는 이름으로 컬럼을 추적하는 형식은 지운 컬럼의 이름을 재사용하면 그 컬럼의 옛 데이터가 되살아날 수 있고 위치로 추적하는 형식은 컬럼을 지우면 뒤 컬럼의 이름이 밀린다고 설명합니다. Iceberg의 스키마 변경(추가, 삭제, 이름 바꾸기, 타입 넓히기, 순서 바꾸기)은 메타데이터 변경이라 데이터 파일을 다시 쓰지 않습니다. Ch-14의 Protobuf가 필드 번호로 호환성을 지키는 것과 같은 발상입니다.

## 5. 행 단위 삭제

v1 테이블은 파일 단위로만 바꿀 수 있어서 행 하나를 지우려면 그 행이 든 파일 전체를 다시 썼습니다. v2에서 삭제 파일이 들어왔습니다.

| 방식 | 명세의 정의 |
|---|---|
| position delete | 데이터 파일 경로와 행 위치로 지운 행을 표시한다. v2는 position delete 파일, v3는 deletion vector로 기록한다 |
| equality delete | `id = 5`처럼 컬럼 값으로 지운 행을 표시한다. v2와 v3 테이블에서만 만들 수 있다 |

v3의 deletion vector는 Roaring bitmap으로 저장하고 한 스냅샷에서 데이터 파일 하나에 deletion vector가 많아야 하나라서 새 삭제를 기존 것과 합쳐 씁니다. 명세는 position delete 파일보다 실행할 때 효율적이라고 적습니다.

삭제와 수정을 반영하는 방식은 두 가지이고 테이블 속성으로 고릅니다.

| 방식 | 동작 | 기본값(`write.delete.mode`, `write.update.mode`, `write.merge.mode`) |
|---|---|---|
| copy-on-write | 바뀐 행이 든 파일을 다시 쓴다. 쓰기가 무겁고 읽기가 가볍다 | 이것 |
| merge-on-read | 삭제 파일만 쓰고 읽을 때 합친다. 쓰기가 가볍고 읽기가 무겁다 | |

Ch-20의 CDC 스트리밍 반영은 merge-on-read 쪽이라 삭제 파일이 계속 쌓이고 Ch-19의 유지보수가 필요해집니다. `format-version` 기본값은 1.4.0부터 2입니다. 명세에는 아직 채택되지 않은 v4도 개발 중으로 올라와 있습니다.

## 6. 중국과 국내 빅테크 사례

### 6-1. Hive에서 옮긴 이유

| 회사 | 글 | 옮긴 이유와 결과 |
|---|---|---|
| LINE Plus | "Hive에서 Iceberg로: 데이터 반영 속도 12배 향상의 비밀" | Hive에서는 바뀐 데이터를 반영하려고 매번 수억 건 전체를 다시 썼습니다. Flink Iceberg 싱크의 upsert로 바꿔 반영 주기가 60분에서 5분(체크포인트 5분)이 됐습니다. 상품 테이블 약 9억 건, CDC 초당 약 1만 건 규모입니다 |
| ByteDance | "字节跳动基于 Apache Hudi 构建实时数仓的实践" | 오프라인 웨어하우스는 일이나 시간 단위였고 갱신하려면 파티션을 다시 돌려야 했습니다. Flink로 Hudi에 직접 쓰는 구조로 바꿨고 수백 TB 규모에서 Bloom Filter 인덱스의 오탐이 많아 키 해시로 파일을 바로 찾는 Bucket 인덱스로 교체했습니다 |

1절에서 본 Hive의 문제 중 "여러 파일에 걸친 변경을 한 번에 반영할 수 없다"가 두 회사 모두의 출발점이었습니다.

### 6-2. 스트리밍 갱신을 위해 나온 포맷: Paimon과 Amoro

Iceberg는 배치 처리를 중심으로 설계됐습니다. 스트리밍으로 자주 갱신되는 테이블을 다루려고 중국에서 시작된 프로젝트가 둘 있습니다.

- **Apache Paimon(Alibaba)**: 2022년 1월 Flink 커뮤니티에서 Flink Table Store로 시작해 Apache 인큐베이터 제안서 기준 주요 개발자가 Alibaba 소속입니다. Flink 커뮤니티의 2024년 글 "Apache Paimon: Streaming Lakehouse is Coming"은 Iceberg가 배치 처리를 위해 설계됐다는 점을 출발점으로 들고 레이크 포맷에 LSM 트리를 결합해 스트리밍 갱신을 받습니다. 같은 글은 권장 갱신 주기를 Iceberg 연동 1시간, Hudi 연동 10분, Paimon 1~5분으로 적습니다. Paimon 진영의 시각이라는 점을 감안해서 읽어야 합니다.
- **Amoro(NetEase, 구 Arctic)**: NetEase는 2020년 Flink와 Iceberg로 시작했지만 운영 환경과 거리가 멀었다고 적었습니다. 당시 Iceberg에 upsert가 없었고 작은 파일을 누가 관리할지가 문제였습니다. 변경 데이터를 받는 change store와 기본 데이터인 base store를 나누고 플랫폼이 최적화를 자동으로 돌리는 구조로 만들었고 2023년 Amoro로 이름을 바꿔 Apache 인큐베이터에 들어갔습니다.

小米는 2025년 발표 정리에서 레이크하우스는 주로 Iceberg를 쓰지만 스트림 조인, 실시간 중복 제거, 일부 컬럼 갱신 같은 스트리밍 의미를 지원하기 어려워 Paimon을 들였다고 적었습니다. 이유로 든 것이 5절의 equality delete입니다. Iceberg의 equality delete는 적용 범위가 모든 과거 파일에 걸쳐 매번 거의 모든 과거 파일을 다시 써야 할 수 있다고 설명합니다.

### 6-3. 국내: 카카오의 Iceberg CDC

카카오의 2024년 글 "Apache Iceberg와 Flink CDC 심층 탐구"는 매일 MySQL 전체를 배치로 가져오던 방식을 Iceberg CDC로 바꾼 과정입니다. 배치에 자원을 늘리면 DB 디스크 사용률이 순식간에 100%에 닿는 문제가 출발점이었습니다. 이 글의 유지보수 경험은 Ch-19에서 다룹니다.

## 7. 범위와 한계

- 2-2절은 PyIceberg 0.12.0과 SQLite 카탈로그, 로컬 파일시스템으로 확인했습니다. Spark나 Flink로 쓰면 overwrite가 만드는 스냅샷 구성이 다를 수 있습니다.
- 동시 커밋 충돌은 재현하지 않았고 명세의 설명을 옮겼습니다.
- copy-on-write와 merge-on-read의 동작 차이를 설명한 공식 문서의 산문은 찾지 못해 설정 문서의 기본값과 명세의 삭제 방식으로 정리했습니다.

## 8. 헷갈렸던 것

**Q. Iceberg는 데이터베이스인가요?**

저장 형식과 메타데이터 규칙입니다. 쿼리 엔진(Spark, Flink, Trino)이 이 규칙대로 읽고 쓰고 커밋의 원자성은 카탈로그의 check-and-put이 맡습니다. 그래서 "테이블 포맷"이라고 부릅니다.

**Q. metadata.json이 커밋마다 쌓이면 문제가 되지 않나요?**

됩니다. 스트리밍처럼 커밋이 잦으면 메타데이터 파일과 manifest가 빠르게 늘어납니다. 오래된 메타데이터 파일 정리와 스냅샷 만료가 Ch-19의 주제입니다.

**Q. 파티션을 잘못 잡았으면 새 테이블을 만들어야 하나요?**

Iceberg에서는 파티션 설정을 바꾸고 새 데이터부터 새 설정으로 쓰면 됩니다. 옛 데이터까지 새 설정으로 바꾸고 싶으면 그 부분만 다시 쓰면(Ch-19의 데이터 파일 재작성) 됩니다.

## 참고 자료

명세와 공식 문서
- Apache Iceberg, [Iceberg Table Spec](https://iceberg.apache.org/spec/)([GitHub 원문](https://github.com/apache/iceberg/blob/main/format/spec.md))
- Apache Iceberg, [Reliability](https://iceberg.apache.org/docs/latest/reliability/), [Partitioning](https://iceberg.apache.org/docs/latest/partitioning/), [Evolution](https://iceberg.apache.org/docs/latest/evolution/), [Configuration](https://iceberg.apache.org/docs/latest/configuration/)
- PyIceberg, [Getting started](https://py.iceberg.apache.org/), [API](https://py.iceberg.apache.org/api/)

발표
- Ryan Blue, Owen O'Malley, [Iceberg: A modern table format for big data (Strata NY 2018)](https://www.slideshare.net/slideshow/iceberg-a-modern-table-format-for-big-data-strata-ny-2018/115016477)
- 실습 코드: [labs/de-study/ch18](https://github.com/dj258255/IT-Oasis/tree/main/labs/de-study/ch18)

중국과 국내 빅테크 사례
- 김성도, 고상일, [Hive에서 Iceberg로: 데이터 반영 속도 12배 향상의 비밀](https://techblog.lycorp.co.jp/ko/from-hive-to-iceberg-12x-faster-data-updates), LINE
- 张友军(ByteDance), [字节跳动基于 Apache Hudi 构建实时数仓的实践](https://developer.volcengine.com/articles/7220261658042564666)
- Apache Flink Community, [Apache Paimon: Streaming Lakehouse is Coming](https://www.alibabacloud.com/blog/apache-paimon-streaming-lakehouse-is-coming_601357), 2024
- Apache Incubator, [PaimonProposal](https://cwiki.apache.org/confluence/display/INCUBATOR/PaimonProposal), [AmoroProposal](https://cwiki.apache.org/confluence/spaces/INCUBATOR/pages/293046808/AmoroProposal)
- 网易数帆, [开源流式湖仓服务 Arctic 详解：并非另一套 Table Format](https://segmentfault.com/a/1190000042340694), 2022
- 钟宇江(小米), [小米基于 Apache Paimon 的流式湖仓实践](https://segmentfault.com/a/1190000046151194), 2025
- louis.sml, [Apache Iceberg와 Flink CDC 심층 탐구](https://tech.kakao.com/posts/656), 카카오, 2024

---
title: '[DE] 테이블 포맷이 필요한 이유: Iceberg는 디렉터리 대신 파일 목록을 기록한다'
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
seriesOrder: 19
---

## 결론부터

1. Hive 방식 테이블은 파티션을 디렉터리로 두고 그 안의 파일을 나열해서 테이블을 읽습니다. 바꾸는 단위가 파일과 디렉터리라 여러 파일에 걸친 변경을 한 번에 반영할 수 없고 계획할 때 파티션 수만큼 나열을 호출합니다.
2. Iceberg는 테이블에 속한 파일 하나하나를 메타데이터에 기록합니다. 카탈로그 → metadata.json → manifest list(스냅샷) → manifest → 데이터 파일의 계층이고 커밋은 카탈로그가 가리키는 metadata.json을 원자적으로 바꾸는 일입니다.
3. PyIceberg로 확인해 보니 커밋 한 번마다 metadata.json이 하나씩 늘었고(4번 커밋 뒤 5개) 스냅샷마다 manifest list가 생겼습니다. 덮어쓰기 한 번은 delete 스냅샷과 append 스냅샷 두 개를 한 커밋으로 만들었습니다.
4. 커밋은 낙관적 동시성으로 합니다. 두 쓰기가 같은 버전을 기준으로 동시에 커밋하면 하나만 성공하고 나머지는 새 버전을 기준으로 다시 시도합니다.
5. 파티션 값을 컬럼에서 자동으로 만들어(숨은 파티셔닝) 쿼리가 파티션 구조를 몰라도 되고 컬럼을 이름 대신 ID로 추적해서 이름 바꾸기와 삭제가 안전합니다.

---

## 1. 디렉터리로 테이블을 표현할 때의 문제

이 글 전체를 한 질문으로 줄이면 이렇습니다. **"지금 이 테이블에 속한 파일은 정확히 어떤 것들인가?"** 데이터베이스는 이 질문을 내부에서 알아서 답해 주니 우리가 신경 쓸 일이 없습니다. 객체 스토리지 위에 parquet 파일을 쌓아 두고 테이블처럼 쓰면 이 답을 누군가 따로 관리해야 합니다. Hive 방식은 "디렉터리에 들어 있는 파일이 곧 테이블"이라고 답했고 Iceberg는 "메타데이터에 적힌 파일만 테이블"이라고 답합니다. 이 차이 하나에서 나머지가 전부 따라 나옵니다.

2편의 메달리온 구조에서 Bronze, Silver, Gold도 따지고 보면 객체 스토리지(S3 같은) 위의 파일입니다. 파일 묶음을 테이블처럼 쓰는 가장 오래된 방법이 Hive 방식입니다.

```
s3://shop/orders/day=2026-10-01/part-0001.parquet
s3://shop/orders/day=2026-10-01/part-0002.parquet
s3://shop/orders/day=2026-10-02/part-0001.parquet
```

파티션은 디렉터리이고 테이블을 읽으려면 디렉터리 안의 파일을 나열합니다.

여기서 "나열"이 생각보다 비쌉니다. S3에는 진짜 디렉터리가 없습니다. `orders/day=2026-10-01/`은 파일 이름(키) 앞부분이 같다는 뜻일 뿐이라 "이 앞부분으로 시작하는 키를 보여 달라"는 API(`ListObjectsV2`)를 불러야 하고 한 번 부르면 키를 최대 1,000개까지 돌려줍니다([AWS 문서](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html)). 일 단위 파티션으로 1년치를 읽으려면 파티션 365개마다 적어도 한 번씩, 파일이 1,000개 넘는 파티션은 여러 번 네트워크 왕복을 해야 쿼리 계획을 시작할 수 있습니다.

Iceberg의 Reliability 문서가 이 방식의 문제를 정리합니다.

| 문제 | 문서의 설명 |
|---|---|
| 원자적 변경이 없다 | 파티션은 중앙 메타스토어에, 파일은 파일시스템에 두고 추적해서 테이블 내용을 원자적으로 바꿀 수 없다 |
| 나열이 틀릴 수 있다 | 결과적 일관성 스토리지에서는 파일을 나열해 테이블 상태를 재구성하다 틀린 결과가 나올 수 있다 |
| 계획이 느리다 | 계획할 때 파티션 수에 비례하는 느린 나열 호출이 필요하다(O(n)) |

표의 용어 두 개를 풀어 둡니다.

- **원자적 변경**: 여러 파일을 바꾸는 작업이 읽는 쪽에게 "전부 바뀌었거나 하나도 안 바뀌었거나" 둘 중 하나로만 보이는 것입니다. 10월 1일 파티션의 파일 3개를 새 파일 3개로 바꾸는 작업이라면 읽는 쪽이 옛 파일 2개와 새 파일 1개가 섞인 상태를 보는 순간이 없어야 합니다. S3는 키 하나를 덮어쓰는 것까지만 원자적이고 여러 키를 한 번에 바꾸는 방법은 없다고 문서에 적혀 있습니다([S3 데이터 일관성 모델](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html#ConsistencyModel)).
- **결과적 일관성**: 방금 쓴 파일이 나열 결과에 바로 안 보이고 조금 뒤에 보이는 성질입니다. S3는 2020년 12월부터 쓰기 직후의 읽기와 나열을 강한 일관성으로 바꿔서([AWS 발표](https://aws.amazon.com/blogs/aws/amazon-s3-update-strong-read-after-write-consistency/)) 지금 S3에서는 이 문제가 사라졌습니다. 그래도 표의 나머지 두 줄, 여러 파일을 한 번에 바꿀 수 없다는 것과 나열이 느리다는 것은 그대로 남습니다.

Partitioning 문서는 Hive 파티셔닝의 문제를 더 듭니다. Hive는 파티션 값을 검증하지 않아서 쓰는 쪽이 형식을 잘못 넣으면 쿼리가 실패하지 않고 조용히 틀린 결과를 냅니다. 쿼리가 파티션 구조에 묶여 있어서 일 단위 파티션을 시간 단위로 바꾸려면 새 테이블이 필요합니다. 파티션 컬럼 조건을 빠뜨리면 테이블 전체를 읽습니다.

4편의 "덮어쓰기 도중에 죽으면" 문제가 여기서 다시 나옵니다. 10월 1일 파티션의 파일 셋을 새 파일 셋으로 바꾸는 도중에 죽으면 디렉터리에는 옛 파일과 새 파일이 섞여 남습니다. 읽는 쪽은 그 섞인 상태를 그대로 봅니다.

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

처음 보면 층이 왜 이렇게 많은지부터 걸립니다. 파일 목록 하나만 두면 안 될까요? 주문 테이블에 파일이 10만 개 있고 오늘 새 파일 1개를 넣는다고 해 봅시다. 목록이 파일 하나라면 10만 줄짜리 목록을 통째로 다시 써야 합니다. 층을 나누면 새 파일 1개를 적은 작은 manifest 하나와 "기존 manifest들 + 새 manifest"를 가리키는 manifest list 하나만 새로 쓰면 됩니다. 기존 manifest는 손대지 않고 그대로 가리킵니다. 명세가 말하는 "잘 바뀌지 않는 메타데이터를 다시 쓰지 않으려고 manifest를 재사용한다"가 이 뜻이고 2-3절에서 실제 파일로 확인합니다.

층마다 맡은 질문을 정리하면 이렇습니다.

| 층 | 답하는 질문 | 바뀌는 때 |
|---|---|---|
| 카탈로그 | 이 테이블의 최신 metadata.json은 어디 있나 | 커밋마다 포인터 하나만 바뀜 |
| metadata.json | 스키마, 파티션 설정, 스냅샷 목록, 지금 스냅샷은 무엇인가 | 커밋마다 새 파일 |
| manifest list | 이 스냅샷은 어떤 manifest들로 이루어지나 | 스냅샷마다 새 파일 |
| manifest | 이 묶음에 든 데이터 파일과 각 파일의 통계는 무엇인가 | 바뀐 묶음만 새 파일 |

읽는 쪽은 디렉터리를 나열하지 않습니다. 카탈로그에서 metadata.json 위치를 받고 거기서 현재 스냅샷의 manifest list를, manifest에서 파일 목록과 통계를 읽습니다. Reliability 문서는 이걸 O(n) 디렉터리 나열 대신 O(1) 호출로 계획한다고 표현합니다. manifest의 통계로 조건에 맞지 않는 파일은 열기 전에 거릅니다.

`WHERE amount >= 100000`(10만 원 이상 주문)을 읽는다고 하면 거르는 과정은 이렇게 됩니다.

1. 카탈로그에 물어 현재 metadata.json을 열고 현재 스냅샷의 manifest list 경로를 얻습니다.
2. manifest list에는 manifest마다 파티션 값의 범위 요약이 있습니다. 파티션 조건이 있다면 여기서 manifest 단위로 먼저 거릅니다.
3. 남은 manifest를 열면 파일마다 `amount` 컬럼의 최솟값과 최댓값이 있습니다. 최댓값이 5만 원인 파일에는 10만 원 이상 주문이 있을 수 없으니 그 파일은 열지 않습니다.
4. 끝까지 남은 파일만 실제로 읽습니다.

1절의 Strata 발표에서 Hive 테이블로 9.6분 걸리던 계획이 Iceberg에서 25초였던 것은 나열 호출이 없어진 데다 이 2, 3단계로 파일을 미리 걸렀기 때문입니다.

### 2-2. 재현: 커밋마다 생기는 파일

PyIceberg 0.12.0으로 로컬에 Iceberg 테이블을 만들었습니다. 카탈로그는 SQLite 파일, 데이터는 로컬 폴더입니다([labs/de-study/ch18](https://github.com/dj258255/IT-Oasis/tree/main/labs/de-study/ch18)의 `iceberg_snapshots.py`). PyIceberg 문서는 이 SQLite 카탈로그가 확장성 때문에 운영에 쓰면 안 된다고 적습니다.

```python
catalog = SqlCatalog("local", uri=f"sqlite:///{WH}/catalog.db", warehouse=f"file://{WH}")
table = catalog.create_table("shop.orders", schema=...)
table.append(orders([(1, "10-01", 30000), (2, "10-01", 12000)]))
```

세 줄이 하는 일입니다.

- `SqlCatalog(...)`: 1층의 카탈로그를 만듭니다. `uri`의 SQLite 파일에 "테이블 이름 → 현재 metadata.json 경로" 한 줄이 저장되고 `warehouse`는 데이터와 메타데이터 파일을 쓸 폴더입니다.
- `create_table`: 빈 테이블을 만듭니다. 이때 스냅샷 없는 metadata.json(00000)이 하나 생깁니다.
- `append`: 주문 두 건(주문 번호, 날짜, 금액)을 parquet 파일 하나로 쓰고 그 파일을 가리키는 manifest, manifest list, 새 metadata.json을 차례로 쓴 뒤 카탈로그의 포인터를 새 metadata.json으로 바꿉니다. 이 마지막 포인터 교체가 커밋입니다.

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

PyIceberg의 overwrite는 기존 행을 지우는 delete 스냅샷과 새 행을 넣는 append 스냅샷을 만들어 한 커밋으로 반영했습니다. 커밋이 하나라서 현재 테이블을 읽는 쪽은 중간 상태를 보지 않습니다. 4편에서 트랜잭션으로 막았던 "지우고 넣는 사이"가 메타데이터 포인터 교체 한 번으로 해결됩니다. 다만 스냅샷 기록에는 중간 상태가 남는데 20편의 시간 여행에서 다시 봅니다. 스냅샷 ID는 실행할 때마다 달라집니다.

4번 주문 하나만 고쳤는데 왜 테이블 전체를 지우고 다시 썼을까요? 코드에서 `overwrite`에 조건(`overwrite_filter`)을 주지 않았기 때문입니다. PyIceberg 소스의 설명을 보면 이 인자의 기본값은 "전부 덮어쓰기"(`ALWAYS_TRUE`)이고 overwrite는 상황에 따라 DELETE(파일을 통째로 뺄 수 있을 때), OVERWRITE(파일 일부 행만 빼야 해서 다시 쓸 때), APPEND(새 행을 넣을 때) 스냅샷을 만든다고 적혀 있습니다([PyIceberg 소스](https://github.com/apache/iceberg-python/blob/pyiceberg-0.12.0/pyiceberg/table/__init__.py)). 이 실습은 기존 파일 셋을 통째로 뺄 수 있었으니 DELETE와 APPEND 두 개가 나왔습니다. 실제로 한 행만 고치려면 `overwrite_filter`로 범위를 좁히거나 5절의 행 단위 삭제를 씁니다.

### 2-3. 파일 안을 열어 보면: 스냅샷마다 무엇을 가리키나

표의 숫자만으로는 "manifest를 재사용한다"가 잘 안 보입니다. 실습 폴더에 남아 있는 warehouse의 manifest list와 manifest 파일(avro, deflate 압축)을 풀어서 각 파일이 어떤 파일 이름을 담고 있는지 확인했습니다.

| 스냅샷 | manifest list가 가리키는 manifest | 그 manifest가 가리키는 데이터 파일 |
|---|---|---|
| S1 append | M1 | M1 → 파일 c1b5…(주문 1, 2) |
| S2 append | M1, M2 | M2 → 파일 a357…(주문 3) |
| S3 append | M1, M2, M3 | M3 → 파일 2053…(주문 4) |
| S4 delete | M4 | M4 → 파일 c1b5…, a357…, 2053… |
| S5 append | M5 | M5 → 파일 7afe…(주문 1~4) |

![커밋마다 새로 쓰는 파일과 그대로 가리키는 파일. metadata.json 00001~00003은 각각 S1~S3 append 스냅샷을, 00004는 S4 delete와 S5 append 두 스냅샷을 가리킨다. S2는 새 manifest M2와 함께 S1의 M1을 다시 가리키고 S3는 M1, M2, M3를 가리킨다. S4의 manifest M4는 옛 데이터 파일 셋을 지운 것으로 기록하고 S5의 M5는 주문 1~4를 다시 쓴 새 파일 하나를 가리킨다](/uploads/data/de-18-iceberg-table-format/commit-tree.svg)

그림을 위에서부터 차례로 읽어 봅니다.

1. append 한 번에 새로 쓴 manifest는 하나뿐입니다. S2의 manifest list는 새 M2와 함께 S1 때 쓴 M1을 그대로 가리킵니다. 그래서 2-2절 표에서 append마다 .avro가 두 개(manifest 하나, manifest list 하나)씩만 늘었습니다.
2. S4의 M4는 데이터 파일을 더하지 않고 옛 파일 셋을 "지웠다"고 적은 manifest입니다. 파일 자체는 디스크에서 지워지지 않았고 이후 스냅샷이 더 이상 가리키지 않을 뿐입니다.
3. S5는 주문 1~4를 담은 새 파일 하나를 가리킵니다. 그래서 overwrite 한 번에 .avro가 네 개(S4의 list와 manifest, S5의 list와 manifest) 늘었습니다.
4. S4와 S5는 metadata.json 00004 하나에 함께 들어 있습니다. 카탈로그 포인터는 00003에서 00004로 한 번만 움직였으니 읽는 쪽은 S3 다음에 바로 S5를 봅니다.

옛 metadata.json, 옛 manifest, 옛 데이터 파일이 하나도 지워지지 않고 남는다는 점이 20편의 출발점입니다.

## 3. 커밋과 동시성

### 3-1. 낙관적 동시성

명세의 커밋 규칙입니다.

- 메타데이터 파일 하나를 다른 것으로 원자적으로 바꾸는 것이 직렬화 가능 격리의 바탕입니다.
- 쓰는 쪽은 자기가 기준으로 삼은 버전이 커밋 전까지 바뀌지 않는다고 가정하고 새 메타데이터를 만듭니다. 커밋은 테이블의 메타데이터 포인터를 기준 버전에서 새 버전으로 바꾸는 것입니다.
- 기준 버전이 더 이상 현재가 아니면 새 현재 버전을 기준으로 다시 시도해야 합니다.

메타스토어나 DB 카탈로그는 포인터를 check-and-put(현재 값이 기대한 값일 때만 바꾸기)으로 갱신합니다. 같은 버전을 기준으로 두 커밋이 동시에 오면 하나만 성공합니다.

용어부터 풀면 **직렬화 가능 격리**는 여러 작업이 동시에 돌아도 결과가 "어떤 순서로 하나씩 차례로 돌린 것"과 같다는 보장입니다. **낙관적**이라는 말은 미리 잠그지 않는다는 뜻입니다. 충돌은 드물다고 보고 일단 각자 파일을 다 써 둔 다음 마지막 포인터 교체 순간에만 "그사이 누가 먼저 바꿨나"를 확인합니다.

주문 적재 작업 A와 컴팩션 작업 B가 같은 테이블에 동시에 쓰는 경우를 따라가 보겠습니다.

| 순서 | 작업 A(주문 5 append) | 작업 B(컴팩션) | 카탈로그 포인터 |
|---|---|---|---|
| 1 | v3를 읽고 시작 | v3를 읽고 시작 | v3 |
| 2 | 새 데이터 파일, manifest, manifest list, v4 후보를 씀 | 합친 파일과 v4 후보를 씀 | v3 |
| 3 | "포인터가 v3이면 내 v4로" 요청, 성공 | | v4(A) |
| 4 | | "포인터가 v3이면 내 v4로" 요청, 실패 | v4(A) |
| 5 | | v4(A)를 기준으로 다시 확인하고 v5 후보를 씀 | v4(A) |
| 6 | | "포인터가 v4이면 내 v5로" 요청, 성공 | v5(B) |

5번에서 B가 처음부터 다 다시 하지는 않습니다. 명세는 manifest를 한 번 써 두면 재시도에서 그대로 재사용할 수 있고 재시도 때는 스냅샷의 맨 위 파일(manifest list)만 다시 쓰면 된다고 적습니다. 무거운 데이터 파일과 manifest는 그대로 두고 맨 위만 바꿔 다시 줄을 섭니다.

재시도 때 확인할 것은 작업 종류마다 다릅니다. 명세 기준으로 append는 아무 조건 없이 항상 다시 적용할 수 있고 파일을 바꾸는 작업(replace)은 지울 파일이 아직 테이블에 있는지 확인해야 합니다. Reliability 문서의 예로, 컴팩션이 `file_a`와 `file_b`를 `merged`로 합치는 커밋은 두 원본이 아직 테이블에 있을 때만 성공합니다. 그 사이 다른 작업이 `file_a`를 지웠다면 컴팩션 결과를 반영하면 안 되기 때문입니다. 위 표에서 A가 주문을 append한 경우는 B가 합친 파일과 겹치지 않으니 B의 재시도가 통과했습니다. A가 `file_a`를 지우거나 다시 쓰는 작업이었다면 B는 재시도에서 충돌로 실패하고 컴팩션을 다음 기회로 미룹니다.

### 3-2. 운영에서는 check-and-put이 되는 카탈로그를 쓴다

명세는 파일시스템에서 rename으로 `v<V>.metadata.json`을 만드는 커밋 방식을 v4에서 없앨 예정이라고 적고 객체 스토리지와 로컬 파일시스템에서 안전하지 않다고 설명합니다. S3의 rename은 원자적이지 않기 때문입니다. 그래서 운영에서는 DB나 메타스토어, REST 카탈로그처럼 check-and-put이 되는 카탈로그를 씁니다.

## 4. 숨은 파티셔닝과 진화

### 4-1. 숨은 파티셔닝

Iceberg는 파티션 값을 컬럼에서 변환으로 만듭니다. Partitioning 문서의 예로, Iceberg가 `event_time`을 `event_date`로 바꾸는 일을 맡고 그 관계를 기록하므로 데이터를 쓰는 쪽도 읽는 쪽도 `event_date`를 볼 필요가 없습니다. 쿼리는 `WHERE event_time >= '2026-10-01'`처럼 원래 컬럼으로 조건을 걸고 Iceberg가 그 조건에서 파티션 조건을 끌어냅니다. 1절에서 본 "파티션 값 형식 오류"와 "파티션 조건 누락"이 생기지 않습니다.

주문 테이블을 주문 시각(`ordered_at`)의 날짜로 나눈다고 하면 두 방식의 차이가 코드에서 보입니다(Spark SQL 예시입니다).

```sql
-- Hive 방식: 파티션 컬럼 day를 따로 두고 쓰는 쪽이 값을 만들어 넣는다
CREATE TABLE orders_hive (order_id BIGINT, ordered_at TIMESTAMP, amount BIGINT)
PARTITIONED BY (day STRING);
-- 읽을 때도 day 조건을 직접 붙여야 파티션을 건너뛴다
SELECT sum(amount) FROM orders_hive
WHERE day = '2026-10-01' AND ordered_at >= '2026-10-01 09:00:00';

-- Iceberg: 변환 함수 days()를 테이블 정의에 적어 둔다
CREATE TABLE orders_ice (order_id BIGINT, ordered_at TIMESTAMP, amount BIGINT)
USING iceberg PARTITIONED BY (days(ordered_at));
-- 원래 컬럼 조건만 쓰면 Iceberg가 날짜 파티션 조건을 끌어낸다
SELECT sum(amount) FROM orders_ice
WHERE ordered_at >= '2026-10-01 09:00:00' AND ordered_at < '2026-10-02 00:00:00';
```

Hive 쪽은 사람이 `day` 값을 손으로 맞춰 넣고 읽을 때도 `day` 조건을 기억해야 합니다. 쓰는 작업 하나가 `day`를 `2026/10/01` 형식으로 넣으면 `day = '2026-10-01'` 조건에 그 파일이 걸리지 않아 매출이 조용히 줄어듭니다. Iceberg 쪽은 `ordered_at`에서 날짜를 만드는 일을 테이블이 맡으니 이런 실수가 끼어들 자리가 없습니다.

### 4-2. 파티션 진화

파티션 설정을 바꾸면 이전 데이터는 이전 설정 그대로 두고 새 데이터만 새 설정으로 씁니다. 문서는 파티션 진화가 메타데이터 작업이고 파일을 미리 다시 쓰지 않는다고 적습니다. 읽을 때는 설정별로 나눠서 계획합니다. Hive에서 새 테이블이 필요했던 일 단위 → 시간 단위 변경을 같은 테이블에서 할 수 있습니다.

### 4-3. 스키마 진화: ID로 컬럼을 찾는다

명세는 데이터 파일의 컬럼을 필드 ID로 고른다고 적습니다. 새 필드에는 새 ID를 주고 이름을 바꿀 때는 이름만 바꾸고 ID는 그대로 둡니다. Evolution 문서는 이름으로 컬럼을 추적하는 형식은 지운 컬럼의 이름을 재사용하면 그 컬럼의 옛 데이터가 되살아날 수 있고 위치로 추적하는 형식은 컬럼을 지우면 뒤 컬럼의 이름이 밀린다고 설명합니다. Iceberg의 스키마 변경(추가, 삭제, 이름 바꾸기, 타입 넓히기, 순서 바꾸기)은 메타데이터 변경이라 데이터 파일을 다시 쓰지 않습니다. 15편의 Protobuf가 필드 번호로 호환성을 지키는 것과 같은 발상입니다.

"지운 컬럼의 옛 데이터가 되살아난다"는 말이 바로 와닿지 않아서 순서대로 적어 봤습니다. 주문 테이블에 배송 메모 컬럼 `memo`가 있었다고 합시다.

| 단계 | 이름으로 찾는 형식 | Iceberg(ID로 찾음) |
|---|---|---|
| 처음 | `order_id`, `amount`, `memo`. 옛 파일에 "문 앞에 두세요" 같은 메모가 들어 있다 | 같은 컬럼에 ID 1, 2, 3 |
| `memo` 삭제 | 스키마에서 빠진다. 옛 파일 안의 `memo` 데이터는 그대로 있다 | ID 3이 스키마에서 빠진다 |
| 쿠폰 코드용으로 `memo`를 다시 추가 | 이름이 같으니 옛 파일의 배송 메모가 쿠폰 코드 자리에 읽혀 나온다 | 새 컬럼은 ID 4를 받는다. 옛 파일에는 ID 4가 없으니 null로 읽힌다 |

이름은 사람이 붙인 표지일 뿐이고 Iceberg가 컬럼을 알아보는 진짜 이름표는 ID입니다. 이름을 바꿔도 ID가 그대로라 옛 파일의 값을 계속 제 컬럼으로 읽을 수 있습니다.

## 5. 행 단위 삭제

v1 테이블은 파일 단위로만 바꿀 수 있어서 행 하나를 지우려면 그 행이 든 파일 전체를 다시 썼습니다. v2에서 삭제 파일이 들어왔습니다.

| 방식 | 명세의 정의 |
|---|---|
| position delete | 데이터 파일 경로와 행 위치로 지운 행을 표시한다. v2는 position delete 파일, v3는 deletion vector로 기록한다 |
| equality delete | `id = 5`처럼 컬럼 값으로 지운 행을 표시한다. v2와 v3 테이블에서만 만들 수 있다 |

주문 파일 `f1.parquet`의 37번째 행에 주문 4가 있다고 하면 두 방식은 이렇게 기록합니다.

```
position delete:  (file = f1.parquet, pos = 36)    ← 0부터 세니 37번째 행
equality delete:  (order_id = 4)
```

position delete는 "어느 파일 몇 번째 행"을 정확히 짚으니 읽을 때 그 행만 건너뛰면 돼서 가볍습니다. 대신 쓰는 쪽이 주문 4가 어느 파일 몇 번째에 있는지 먼저 찾아야 합니다. equality delete는 찾을 필요 없이 "주문 번호 4인 행은 없는 셈 쳐라"고만 적으니 쓰기가 빠릅니다. 대신 읽는 쪽이 읽는 행마다 이 조건과 맞춰 봐야 합니다. 21편의 스트리밍 CDC는 그래서 equality delete를 씁니다. 변경 이벤트가 초당 수천 건 오는데 매번 "그 행이 어느 파일에 있나"를 찾아다닐 수는 없습니다([RisingWave, CDC to Apache Iceberg](https://risingwave.com/blog/cdc-to-iceberg-upsert-delete/)).

삭제 파일이 어느 데이터 파일에 적용되는지는 시퀀스 번호로 정해집니다. 커밋마다 번호가 하나씩 커지고(정확히는 스냅샷마다 붙습니다. 2-2절 실습의 metadata.json을 열어 보면 한 커밋에 함께 든 S4와 S5의 `sequence-number`가 4와 5로 다릅니다) 명세의 규칙은 이렇습니다.

- equality delete는 자기보다 시퀀스 번호가 **작은**(같은 것 제외) 데이터 파일에만 적용합니다.
- position delete는 시퀀스 번호가 **같거나 작은** 데이터 파일에 적용합니다.

equality delete에서 "같은 것 제외"가 중요합니다. 주문 4의 금액을 고치는 upsert는 한 커밋(스냅샷 하나) 안에서 `order_id = 4` 삭제와 새 주문 4 행을 함께 씁니다. 같은 커밋의 새 행에도 삭제가 적용되면 방금 넣은 행까지 지워집니다. 규칙 덕분에 삭제는 그 커밋 전의 옛 행에만 걸립니다.

v3의 deletion vector는 Roaring bitmap으로 저장하고 한 스냅샷에서 데이터 파일 하나에 deletion vector가 많아야 하나라서 새 삭제를 기존 것과 합쳐 씁니다. Roaring bitmap은 "지운 행 번호"를 비트 하나씩으로 표시하되 비어 있는 구간은 압축하는 자료구조입니다. 위의 position delete 예라면 `f1.parquet`의 비트맵에서 36번 비트 하나를 켜는 것과 같습니다. 명세는 position delete 파일보다 실행할 때 효율적이라고 적습니다.

삭제와 수정을 반영하는 방식은 두 가지이고 테이블 속성으로 고릅니다.

| 방식 | 동작 | 기본값(`write.delete.mode`, `write.update.mode`, `write.merge.mode`) |
|---|---|---|
| copy-on-write | 바뀐 행이 든 파일을 다시 쓴다. 쓰기가 무겁고 읽기가 가볍다 | 이것 |
| merge-on-read | 삭제 파일만 쓰고 읽을 때 합친다. 쓰기가 가볍고 읽기가 무겁다 | |

얼마나 차이가 나는지는 Dremio의 Alex Merced가 든 예가 감을 잡기 좋습니다. 고객 한 명의 주문을 지우는 `DELETE FROM orders WHERE customer_id = 42`가 256MB짜리 파일 50개에 걸쳐 있다면 copy-on-write는 그 50개(합계 약 12.5GB)를 모두 읽어서 다시 씁니다. merge-on-read는 `customer_id = 42`라고 적은 작은 삭제 파일 하나를 씁니다([Dremio, Copy-On-Write vs. Merge-On-Read](https://www.dremio.com/blog/row-level-changes-on-the-lakehouse-copy-on-write-vs-merge-on-read-in-apache-iceberg/)). 그 대신 merge-on-read는 이후 그 50개 파일을 읽는 쿼리마다 삭제 파일을 맞춰 보는 비용을 냅니다. 그래서 가끔 큰 수정이 있고 읽기가 많은 테이블은 copy-on-write, 작은 수정이 끊임없이 들어오는 테이블은 merge-on-read에 주기적인 컴팩션을 붙이는 조합이 흔합니다.

21편의 CDC 스트리밍 반영은 merge-on-read 쪽이라 삭제 파일이 계속 쌓이고 20편의 유지보수가 필요해집니다. `format-version` 기본값은 1.4.0부터 2입니다. 명세에는 아직 채택되지 않은 v4도 개발 중으로 올라와 있습니다.

## 6. 중국과 국내 빅테크 사례

### 6-1. Hive에서 옮긴 이유

| 회사 | 글 | 옮긴 이유와 결과 |
|---|---|---|
| LINE Plus | "Hive에서 Iceberg로: 데이터 반영 속도 12배 향상의 비밀" | Hive에서는 바뀐 데이터를 반영하려고 매번 수억 건 전체를 다시 썼습니다. Flink Iceberg 싱크의 upsert로 바꿔 반영 주기가 60분에서 5분(체크포인트 5분)이 됐습니다. 상품 테이블 약 9억 건, CDC 초당 약 1만 건 규모입니다 |
| ByteDance | "字节跳动基于 Apache Hudi 构建实时数仓的实践" | 오프라인 웨어하우스는 일이나 시간 단위였고 갱신하려면 파티션을 다시 돌려야 했습니다. Flink로 Hudi에 직접 쓰는 구조로 바꿨고 수백 TB 규모에서 Bloom Filter 인덱스의 오탐이 많아 키 해시로 파일을 바로 찾는 Bucket 인덱스로 교체했습니다 |

1절에서 본 Hive의 문제 중 "여러 파일에 걸친 변경을 한 번에 반영할 수 없다"가 두 회사 모두의 출발점이었습니다.

### 6-2. 스트리밍 갱신을 위해 나온 포맷: Paimon과 Amoro

Iceberg는 배치 처리를 중심으로 설계됐습니다. 스트리밍으로 자주 갱신되는 테이블을 다루려고 중국에서 시작된 프로젝트가 둘 있습니다.

- **Apache Paimon(Alibaba)**: 2022년 1월 Flink 커뮤니티에서 Flink Table Store로 시작해 Apache 인큐베이터 제안서 기준 주요 개발자가 Alibaba 소속입니다. Flink 커뮤니티의 2024년 글 "Apache Paimon: Streaming Lakehouse is Coming"은 Iceberg가 배치 처리를 위해 설계됐다는 점을 출발점으로 듭니다. Paimon은 레이크 포맷에 LSM 트리를 결합해 스트리밍 갱신을 받습니다. 같은 글은 갱신 주기를 Iceberg 연동 1시간, Hudi 연동 10분으로 적고 Paimon은 1~5분 지연을 내세웁니다. Paimon 진영의 시각이라는 점을 감안해서 읽어야 합니다. LSM 트리는 들어오는 쓰기를 메모리에 모았다가 정렬된 파일로 내려 쓰고 그 파일들을 뒤에서 계속 합치는 구조입니다. 잦은 갱신을 "기존 파일 고치기" 대신 "새 파일 덧붙이기와 나중에 합치기"로 바꿔서 받습니다.
- **Amoro(NetEase, 구 Arctic)**: NetEase는 2020년 Flink와 Iceberg로 시작했지만 운영 환경과 거리가 멀었다고 적었습니다. 당시 Iceberg에 upsert가 없었고 작은 파일을 누가 관리할지가 문제였습니다. 변경 데이터를 받는 change store와 기본 데이터인 base store를 나누고 플랫폼이 최적화를 자동으로 돌리는 구조로 만들었습니다. 2023년 Amoro로 이름을 바꿨고 2024년 3월 Apache 인큐베이터에 들어갔습니다([Apache Incubator, Amoro](https://incubator.apache.org/projects/amoro.html)).

小米는 2025년 발표 정리에서 레이크하우스는 주로 Iceberg를 쓰지만 스트림 조인, 실시간 중복 제거, 일부 컬럼 갱신 같은 스트리밍 의미를 지원하기 어려워 Paimon을 들였다고 적었습니다. 이유로 든 것이 5절의 equality delete입니다. Iceberg의 equality delete는 적용 범위가 모든 과거 파일에 걸쳐 매번 거의 모든 과거 파일을 다시 써야 할 수 있다고 설명합니다.

### 6-3. 국내: 카카오의 Iceberg CDC

카카오의 2024년 글 "Apache Iceberg와 Flink CDC 심층 탐구"는 매일 MySQL 전체를 배치로 가져오던 방식을 Iceberg CDC로 바꾼 과정입니다. 배치에 자원을 늘리면 DB 디스크 사용률이 순식간에 100%에 닿는 문제가 출발점이었습니다. 이 글의 유지보수 경험은 20편에서 다룹니다.

## 7. 범위와 한계

- 2-2절은 PyIceberg 0.12.0과 SQLite 카탈로그, 로컬 파일시스템으로 확인했습니다. Spark나 Flink로 쓰면 overwrite가 만드는 스냅샷 구성이 다를 수 있습니다.
- 2-3절의 표는 그 실행이 남긴 avro 파일에서 파일 이름 문자열만 뽑아 본 것입니다. manifest 항목의 상태 값(추가, 기존, 삭제)까지 해석하지는 않았고 S4의 M4가 "지운 파일"을 적은 것은 스냅샷 요약의 `op=delete`, `deleted-records=4`와 맞춰 판단했습니다.
- 동시 커밋 충돌은 재현하지 않았고 명세의 설명을 옮겼습니다. 3-1절의 작업 A, B 표도 그 규칙을 따라 그린 설명용 예입니다.
- copy-on-write와 merge-on-read의 동작 차이를 설명한 공식 문서의 산문은 찾지 못해 설정 문서의 기본값과 명세의 삭제 방식으로 정리했습니다.

## 8. 헷갈렸던 것

**Q. Iceberg는 데이터베이스인가요?**

저장 형식과 메타데이터 규칙입니다. 쿼리 엔진(Spark, Flink, Trino)이 이 규칙대로 읽고 쓰고 커밋의 원자성은 카탈로그의 check-and-put이 맡습니다. 그래서 "테이블 포맷"이라고 부릅니다.

**Q. 스냅샷과 manifest list는 같은 것인가요?**

거의 같은 것을 다른 쪽에서 부르는 이름입니다. 스냅샷은 metadata.json 안의 한 항목(ID, 부모 ID, 시각, 요약)이고 그 항목이 가리키는 파일이 manifest list입니다. 스냅샷 하나에 manifest list 하나가 붙으니 2-3절 그림에서는 한 칸으로 그렸습니다.

**Q. metadata.json이 커밋마다 쌓이면 문제가 되지 않나요?**

됩니다. 스트리밍처럼 커밋이 잦으면 메타데이터 파일과 manifest가 빠르게 늘어납니다. 오래된 메타데이터 파일 정리와 스냅샷 만료가 20편의 주제입니다.

**Q. 파티션을 잘못 잡았으면 새 테이블을 만들어야 하나요?**

Iceberg에서는 파티션 설정을 바꾸고 새 데이터부터 새 설정으로 쓰면 됩니다. 옛 데이터까지 새 설정으로 바꾸고 싶으면 그 부분만 다시 쓰면(20편의 데이터 파일 재작성) 됩니다.

## 참고 자료

명세와 공식 문서
- Apache Iceberg, [Iceberg Table Spec](https://iceberg.apache.org/spec/)([GitHub 원문](https://github.com/apache/iceberg/blob/main/format/spec.md))
- Apache Iceberg, [Reliability](https://iceberg.apache.org/docs/latest/reliability/), [Partitioning](https://iceberg.apache.org/docs/latest/partitioning/), [Evolution](https://iceberg.apache.org/docs/latest/evolution/), [Configuration](https://iceberg.apache.org/docs/latest/configuration/)
- PyIceberg, [Getting started](https://py.iceberg.apache.org/), [API](https://py.iceberg.apache.org/api/), [0.12.0 소스의 overwrite 설명](https://github.com/apache/iceberg-python/blob/pyiceberg-0.12.0/pyiceberg/table/__init__.py)
- AWS, [ListObjectsV2](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html), [Amazon S3 data consistency model](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html#ConsistencyModel)
- Jeff Barr, [Amazon S3 Update: Strong Read-After-Write Consistency](https://aws.amazon.com/blogs/aws/amazon-s3-update-strong-read-after-write-consistency/), AWS News Blog, 2020

설명을 참고한 글
- Alex Merced, [Row-Level Changes on the Lakehouse: Copy-On-Write vs. Merge-On-Read in Apache Iceberg](https://www.dremio.com/blog/row-level-changes-on-the-lakehouse-copy-on-write-vs-merge-on-read-in-apache-iceberg/), Dremio
- RisingWave, [CDC to Apache Iceberg: Upsert and Delete Semantics Explained](https://risingwave.com/blog/cdc-to-iceberg-upsert-delete/), 2026

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

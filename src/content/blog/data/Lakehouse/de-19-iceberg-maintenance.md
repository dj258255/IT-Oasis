---
title: '[DE Ch-19] Iceberg 유지보수: 시간 여행이 남긴 파일은 누군가 치워야 한다'
description: Iceberg는 커밋마다 스냅샷을 남겨 과거 시점의 테이블을 그대로 읽게 해 줍니다. 그 대가로 스냅샷이 참조하는 옛 파일과 메타데이터가 계속 쌓입니다. PyIceberg로 스냅샷마다 시간 여행을 해 보고 스냅샷을 만료해도 데이터 파일은 남는다는 것을 확인합니다. 스냅샷 만료, 오래된 메타데이터 정리, 고아 파일 삭제, 컴팩션의 기본값과 주의점, 작은 파일과 스냅샷이 쌓인 실제 사례를 정리합니다.
date: 2026-10-19T00:00:00.000Z
tags:
  - Data Engineering
  - Iceberg
  - Lakehouse
  - Time Travel
  - Compaction
  - Snapshot Expiration
category: data/Lakehouse
topics:
  - pipeline
  - database
draft: false
series: "DE 공부"
seriesOrder: 19
---

## 결론부터

1. Iceberg의 스냅샷은 그 시점의 파일 목록이라 스냅샷 ID나 시각으로 과거 테이블을 그대로 읽을 수 있습니다(시간 여행). PyIceberg로 확인해 보니 다섯 스냅샷마다 행 수와 매출 합계가 그 시점 그대로 나왔고 overwrite가 만든 중간 delete 스냅샷은 행이 0개로 보였습니다.
2. 스냅샷을 만료하면 메타데이터에서 빠져 시간 여행을 할 수 없게 됩니다. 그런데 PyIceberg 0.12.0에서는 만료 뒤에도 parquet 파일 4개가 그대로 남았습니다. 남은 파일을 지우는 일은 따로 해야 합니다.
3. Iceberg 문서가 권장하는 유지보수는 스냅샷 만료, 오래된 메타데이터 파일 정리, 고아 파일 삭제 셋입니다. 스냅샷 보존 기본값은 5일이고 오래된 metadata.json은 기본으로 지우지 않으며 고아 파일 삭제는 기본 3일보다 오래된 것만 지웁니다.
4. 커밋이 잦으면 작은 파일이 쌓여 읽기가 느려집니다. 컴팩션(데이터 파일 재작성)으로 합치되, 합친 뒤 스냅샷을 만료해야 옛 작은 파일이 실제로 사라집니다.

---

## 1. 스냅샷이 주는 것과 남기는 것

Ch-18에서 Iceberg가 커밋마다 새 스냅샷을 만들고 옛 파일을 지우지 않는다고 했습니다. 옛 파일을 지우지 않기 때문에 과거 시점의 테이블을 읽을 수 있고 같은 이유로 파일이 계속 쌓입니다.

이 글은 "무엇이 쌓이고 누가 치우나"를 한 장의 표로 먼저 보고 한 줄씩 내려갑니다.

| 쌓이는 것 | 왜 생기나 | 치우는 작업 | 절 |
|---|---|---|---|
| 옛 스냅샷이 붙들고 있는 데이터 파일 | 수정과 삭제가 새 파일을 쓰고 옛 파일은 옛 스냅샷이 계속 가리킨다 | 스냅샷 만료 | 3 |
| 옛 metadata.json | 커밋마다 하나씩 새로 생긴다 | 메타데이터 정리 설정 | 4-1 |
| 어디에도 적히지 않은 파일 | 커밋이 실패했거나 도구가 만료 뒤 파일을 안 지웠다 | 고아 파일 삭제 | 4-2 |
| 작은 파일 | 작은 배치로 자주 커밋한다 | 컴팩션 | 5 |

첫 줄의 "옛 스냅샷이 붙들고 있다"가 이 글의 핵심이라 비유를 하나 들겠습니다. 스냅샷은 도서관 대출 기록과 비슷합니다. 책(데이터 파일)을 서가에서 치우려면 그 책을 빌려 간 기록(스냅샷)이 하나도 남지 않아야 합니다. 스냅샷 만료는 기록을 지우는 일이고 책을 실제로 치우는 일은 그다음입니다.

## 2. 시간 여행

### 2-1. 재현

Ch-18의 실습 테이블(주문 세 번 append, 한 번 overwrite)에서 스냅샷마다 테이블을 읽었습니다([labs/de-study/ch18](https://github.com/dj258255/IT-Oasis/tree/main/labs/de-study/ch18)의 `iceberg_snapshots.py`).

```python
for s in table.snapshots():
    t = table.scan(snapshot_id=s.snapshot_id).to_arrow()
```

| 스냅샷(순서) | operation | 행 | 매출 합계 |
|---|---|---|---|
| 1 | append | 2 | 42,000원 |
| 2 | append | 3 | 50,000원 |
| 3 | append | 4 | 55,000원 |
| 4 | delete | 0 | 0원 |
| 5(현재) | append | 4 | 55,500원 |

4번 주문 금액을 5,000원에서 5,500원으로 고치기 전의 테이블(3번 스냅샷)을 그대로 읽을 수 있습니다. "어제 리포트는 왜 55,000원이었나"를 그 시점의 데이터로 확인할 수 있습니다.

코드는 두 줄입니다. `table.snapshots()`가 metadata.json에 적힌 스냅샷 목록을 시간순으로 돌려주고 `table.scan(snapshot_id=...)`은 그 스냅샷의 manifest list에서 출발해 그 시점의 파일만 읽습니다. 지금 테이블과 같은 방식으로 읽되 출발점만 옛 스냅샷으로 바꾸는 것이라 시간 여행이라고 해도 따로 복원 작업이 없습니다.

4번 스냅샷은 PyIceberg의 overwrite가 만든 중간 단계입니다. 현재 테이블을 읽는 쪽은 4번과 5번이 한 커밋으로 반영되어 이 상태를 보지 않습니다. 하지만 스냅샷 ID로 직접 4번을 읽으면 빈 테이블이 나옵니다. [Ch-18 2-3절](/blog/data/lakehouse/de-18-iceberg-table-format#2-3-파일-안을-열어-보면-스냅샷마다-무엇을-가리키나)에서 본 것처럼 4번의 manifest는 옛 파일 셋을 지웠다고만 적었고 새 파일은 5번에서야 더해지기 때문입니다. 스냅샷 목록에서 시점을 고를 때는 operation이 무엇인지 함께 봐야 합니다.

### 2-2. 엔진에서 쓰는 방법

| 엔진 | 방법 |
|---|---|
| Spark SQL | `SELECT * FROM t VERSION AS OF 10963874102873`(스냅샷 ID, 브랜치, 태그), `TIMESTAMP AS OF '2026-10-01 00:00:00'` |
| Spark DataFrame | 읽기 옵션 `snapshot-id`, `as-of-timestamp`, `branch`, `tag` |
| PyIceberg | `table.scan(snapshot_id=...)`, `table.snapshot_as_of_timestamp(ms)` |

`TIMESTAMP AS OF`는 "그 시각에 현재였던 스냅샷", 다시 말해 그 시각 이전에 커밋된 스냅샷 중 가장 최근 것을 읽습니다. 10월 1일 0시를 주면 9월 30일 밤에 마지막으로 커밋된 상태가 나옵니다.

명세의 스냅샷은 ID, 부모 ID, 시각, manifest list 위치, 요약(operation 포함)을 가집니다. operation은 append(데이터 파일 추가만), overwrite(논리적 덮어쓰기), delete(삭제), replace(데이터는 그대로 두고 파일만 바꿈, 예: 컴팩션) 넷입니다.

### 2-3. 브랜치와 태그

스냅샷에 이름을 붙일 수 있습니다. 태그는 특정 스냅샷에 붙인 이름이고 브랜치는 계속 움직이는 이름입니다. 각자 보존 기간을 따로 둘 수 있어서 "월말 마감 스냅샷은 1년 보존"처럼 쓸 수 있습니다.

```sql
ALTER TABLE prod.shop.orders CREATE TAG `EOM-2026-10` AS OF VERSION 7 RETAIN 365 DAYS;
```

한 줄씩 읽으면 "주문 테이블의 7번 스냅샷에 `EOM-2026-10`(10월 말 마감)이라는 이름을 붙이고 365일 동안 지키라"는 뜻입니다. 이름이 붙은 스냅샷은 3절의 만료 대상에서 빠지니 1년 뒤에도 "10월 마감 때 매출이 얼마였나"를 그대로 읽을 수 있습니다. git에 비유하면 태그는 한 커밋에 박아 둔 이름표이고 브랜치는 새 커밋이 생길 때마다 앞으로 따라가는 이름표입니다. 우리가 평소 읽고 쓰는 현재 테이블이 `main` 브랜치이고 `main` 브랜치는 만료되지 않습니다.

## 3. 스냅샷 만료

### 3-1. 기본값

| 설정 | 기본값 | 뜻 |
|---|---|---|
| `history.expire.max-snapshot-age-ms` | 432000000(5일) | 이보다 오래된 스냅샷을 만료 대상으로 본다 |
| `history.expire.min-snapshots-to-keep` | 1 | 최소한 남길 스냅샷 수 |
| `history.expire.max-ref-age-ms` | 무한 | 브랜치와 태그의 보존 기간 |

처음 두 설정은 함께 봐야 합니다. 스냅샷 하나가 만료되려면 5일보다 오래됐고 동시에 "최소한 남길 개수" 안에 들지 않아야 합니다. 매시간 커밋하는 테이블이라면 5일 × 24시간이라 대략 최근 120개 스냅샷이 남습니다. 반대로 한 달에 한 번만 커밋하는 테이블은 마지막 스냅샷이 30일 전이어도 최소 1개 규칙에 걸려 남습니다. 지금 테이블이 통째로 사라지는 일은 없다는 뜻입니다.

Maintenance 문서는 필요 없는 데이터 파일을 지우고 테이블 메타데이터를 작게 유지하려면 스냅샷을 주기적으로 만료하라고 권합니다. 만료된 스냅샷은 메타데이터에서 빠져 시간 여행에 쓸 수 없습니다. Spark의 `expire_snapshots` 프로시저는 기본으로 5일보다 오래된 것을 만료하고 최소 1개를 남기며 만료되지 않은 스냅샷이 아직 참조하는 파일은 지우지 않고 브랜치나 태그가 가리키는 스냅샷도 지우지 않습니다.

### 3-2. 재현: 만료해도 파일이 남는다

실습 테이블에서 현재 스냅샷만 남기고 나머지 네 개를 만료했습니다.

```python
table.maintenance.expire_snapshots().by_ids(old_ids).commit()
```

| 확인 | 결과 |
|---|---|
| 남은 스냅샷 | 5개 → 1개 |
| 만료된 스냅샷으로 시간 여행 | 실패(ValueError) |
| parquet 파일 | 4개 → 4개 |

메타데이터에서는 스냅샷이 사라졌는데 데이터 파일은 그대로입니다.

![스냅샷 만료가 끊는 것은 참조이고 파일은 따로 지워야 한다는 그림. 만료 전에는 S1~S3가 파일 A, B, C를, S5가 파일 D를 가리킨다. S1~S4를 만료한 뒤에는 S5와 파일 D만 연결되어 있고 파일 A, B, C는 가리키는 스냅샷이 없지만 디스크에 그대로 남아 있다](/uploads/data/de-19-iceberg-maintenance/expire-references.svg)

그림의 왼쪽이 만료 전, 오른쪽이 만료 뒤입니다. 화살표는 Ch-18 2-3절에서 avro를 풀어 확인한 실제 참조를 스냅샷에서 데이터 파일로 줄여 그린 것입니다. 만료 뒤 파일 A, B, C(주문 1~4의 옛 버전)를 가리키는 스냅샷은 하나도 없습니다. 이제 지워도 되는 파일이지만 누군가 지워 주기 전까지는 디스크를 차지합니다. 만약 S3를 남기고 만료했다면 S3가 파일 A, B, C를 계속 가리키니 지우면 안 되는 파일이 됩니다. "더 이상 아무 스냅샷도 가리키지 않는 파일만 지운다"가 모든 정리 작업의 규칙입니다.

PyIceberg 0.12.0의 `ExpireSnapshots`는 메타데이터에서 스냅샷을 빼는 일만 하고 소스에서 파일을 실제로 지우는 코드는 찾지 못했습니다. Java와 Spark의 만료 작업은 더 이상 참조되지 않는 파일을 지우는 쪽으로 문서화되어 있으니 도구마다 만료가 무엇까지 하는지 확인해야 합니다.

이렇게 남은 파일, 그리고 커밋이 실패해서 어느 스냅샷에도 들어가지 못한 파일이 고아 파일(orphan file)입니다. 뒤쪽 경우는 PyIceberg 소스의 overwrite 설명에도 나옵니다. 쓰는 도중에 실패하면 스냅샷은 커밋되지 않지만 이미 써 둔 데이터 파일이 어느 스냅샷에도 속하지 않은 채 남을 수 있으니 만료와 고아 파일 정리로 치우라고 적혀 있습니다([PyIceberg 소스](https://github.com/apache/iceberg-python/blob/pyiceberg-0.12.0/pyiceberg/table/__init__.py)).

## 4. 오래된 메타데이터와 고아 파일

### 4-1. metadata.json 정리

커밋마다 metadata.json이 하나씩 생긴다고 Ch-18에서 봤습니다. 이 파일은 스냅샷 만료로 지워지지 않습니다.

| 설정 | 기본값 |
|---|---|
| `write.metadata.delete-after-commit.enabled` | false(지우지 않음) |
| `write.metadata.previous-versions-max` | 100 |

삭제를 켜면 커밋할 때 최근 100개만 남기고 오래된 metadata.json을 지웁니다. 문서는 이 설정을 켜기 전에 이미 쌓인 파일은 추적 목록에서 빠지면 고아 파일 정리로만 지울 수 있다고 적습니다.

### 4-2. 고아 파일 삭제의 위험

`remove_orphan_files`는 테이블 위치 아래의 파일 중 어떤 메타데이터에도 없는 파일을 지웁니다. 문서가 붙인 주의는 둘입니다.

- 지금 진행 중인 쓰기의 파일도 아직 커밋 전이라 메타데이터에 없습니다. 쓰기가 끝나는 데 걸리는 시간보다 짧은 기준으로 고아 파일을 지우면 테이블이 깨질 수 있습니다. 기본 기준은 3일입니다.
- 파일 경로 문자열로 비교합니다. HDFS 주소가 바뀌는 등으로 메타데이터의 경로와 실제 경로가 달라지면 살아 있는 파일을 지워 데이터를 잃습니다. 그래서 경로 형식 차이를 다루는 옵션(`equal_schemes`, `prefix_mismatch_mode`)이 있고 `dry_run`으로 먼저 목록을 볼 수 있습니다.

첫 번째 주의가 왜 위험한지 시간순으로 놓아 보면 분명해집니다. 기준을 1시간으로 줄였다고 합시다.

| 시각 | 일어나는 일 |
|---|---|
| 01:00 | 월간 매출 재계산 작업이 시작되어 새 데이터 파일을 쓰기 시작한다 |
| 01:05 | 첫 파일 `part-0001.parquet`을 다 썼다. 커밋 전이라 메타데이터에는 없다 |
| 02:30 | 고아 파일 삭제가 돈다. 1시간보다 오래됐고 메타데이터에 없는 `part-0001`을 지운다 |
| 03:00 | 재계산 작업이 커밋한다. 새 스냅샷이 `part-0001`을 가리키지만 파일은 이미 없다 |
| 03:10 | 그 스냅샷을 읽는 쿼리가 파일이 없다는 오류로 실패한다 |

기준을 "가장 오래 걸리는 쓰기 작업"보다 길게 잡아야 하는 이유가 이것입니다.

두 번째 주의의 "경로 문자열 비교"도 예를 들면 이렇습니다. 메타데이터에는 `s3a://shop-lake/orders/data/f1.parquet`으로 적혀 있는데 저장소를 나열하면 `s3://shop-lake/orders/data/f1.parquet`으로 나옵니다. 같은 파일인데 앞부분(scheme)이 달라 문자열로는 다른 파일이 되고 "메타데이터에 없는 파일"로 잡혀 지워집니다. `equal_schemes`는 `s3a`와 `s3`를 같은 것으로 보라고 알려 주는 옵션이고 `dry_run`은 실제로 지우지 않고 지울 목록만 보여 줍니다. 처음 돌릴 때는 `dry_run`으로 목록을 먼저 보는 편이 안전합니다.

문서는 이 작업이 오래 걸릴 수 있고 자주 돌릴 필요는 없다고 적습니다.

## 5. 컴팩션

### 5-1. 작은 파일

커밋마다 새 파일이 생기니 작은 배치로 자주 쓰면 작은 파일이 쌓입니다. Ch-20의 CDC 스트리밍이나 Ch-17의 체크포인트마다 커밋하는 Flink 싱크가 그렇습니다. Spark 프로시저 문서는 작은 파일이 불필요하게 많은 메타데이터와 파일 여는 비용으로 쿼리를 느리게 한다고 적습니다.

작은 파일이 왜 느린지 감을 잡아 보겠습니다. 같은 1GB를 512MB 파일 2개로 두면 쿼리는 파일 2개를 열고 manifest에 2줄을 적습니다. 1MB 파일 1,000개로 두면 파일을 1,000번 열고 1,000번 요청을 보내고 manifest에도 1,000줄이 생깁니다. 읽는 데이터 양은 같아도 "파일을 찾고 여는" 고정 비용이 파일 수만큼 늘어납니다.

`rewrite_data_files`가 작은 파일을 합칩니다. 기본 전략은 binpack이고 sort도 됩니다(z-order는 sort 전략에 `sort_order => 'zorder(c1, c2)'`로 지정합니다). binpack은 이삿짐 싸기처럼 작은 파일들을 목표 크기 상자에 차곡차곡 채워 넣는 방식이고 sort는 합치면서 지정한 컬럼으로 정렬까지 하는 방식입니다(7-2절). 결과는 replace 스냅샷으로 커밋됩니다.

어떤 파일을 고르는지는 숫자로 따라가 보는 편이 빠릅니다. 목표 파일 크기 기본값은 512MB(`write.target-file-size-bytes`)입니다.

1. **파일 고르기**: 목표의 75%(384MB)보다 작거나 180%(약 922MB)보다 큰 파일이 후보입니다. 20MB 파일은 후보이고 400MB 파일은 범위 안이라 후보가 아닙니다. 다만 크기가 범위 안이어도 삭제 파일이 `delete-file-threshold`개 이상 붙었거나 지운 행 비율이 `delete-ratio-threshold`(기본 0.3) 이상인 파일은 후보가 됩니다(main 브랜치의 `BinPackRewriteFilePlanner.filterFiles`).
2. **묶기**: 후보를 파티션별로 모아 묶음(file group)을 만듭니다.
3. **묶음 고르기**: 묶음 안 파일이 5개 이상이거나(`min-input-files`), 2개 이상이면서 합친 크기가 목표(512MB)를 넘거나, 합친 크기가 최대 크기(922MB)를 넘거나, 삭제 파일이 많이 붙은 파일이 들어 있으면 그 묶음을 다시 씁니다.

예를 들어 한 파티션에 20MB 파일 3개만 있으면 3단계의 어느 조건에도 맞지 않아 그대로 둡니다. 20MB 파일 5개면 개수 조건으로, 200MB 파일 3개면 합친 600MB가 목표를 넘어서 다시 씁니다. 이 조건은 Spark 프로시저 문서의 옵션 표와 Iceberg 소스의 묶음 선택 코드(`BinPackRewriteFilePlanner`)로 확인했습니다.

### 5-2. 사례: 실험으로 본 효과

Sapota의 2026년 글은 노트북에서 일부러 작은 파일 문제를 만들었습니다(Spark 3.5 `local[4]`, Iceberg 1.9.2, 약 400만 행을 8,000행씩 500번 append).

| 확인 | 결과 |
|---|---|
| 데이터 파일 | 2,500개 → 컴팩션 후 5개 |
| 쿼리 중앙값 | 3.612초 → 0.430초 |
| 메타데이터 크기 | 데이터(약 48MiB)의 약 3배인 133.64MiB(파일 1,502개) |

그리고 3-2절과 같은 현상을 확인했습니다. 최근 5개 스냅샷을 남기고 만료했더니 manifest와 manifest list는 지워졌지만 데이터 파일은 0개 지워졌습니다. 남은 스냅샷이 아직 작은 파일을 참조하고 있었기 때문입니다. 오래된 metadata.json은 삭제 설정과 고아 파일 정리를 거친 뒤에야 줄었습니다.

### 5-3. 사례: 운영에서 쌓인 스냅샷

어피닛 팀 블로그의 2026년 글 "Apache Iceberg 테이블 운영 실전기: 스냅샷 관리부터 Compaction까지"는 Iceberg 테이블 약 350개를 Airflow로 매시간 증분 MERGE하는 환경(Spark on EMR로 쓰고 Athena로 조회, copy-on-write)의 경험을 적었습니다.

- 보존 정책 없이 하루 약 8,400개(350 × 24)의 스냅샷이 쌓였고 약 6개월 뒤 798,873개, 스토리지 약 500TB가 됐습니다.
- 하루 마감 스냅샷에 14일 보존 태그를 붙이고 3일보다 오래된 스냅샷 만료와 고아 파일 삭제를 돌렸습니다. 첫 정리에 약 7시간이 걸렸습니다.
- 스냅샷이 16,031개(98% 감소), 스토리지가 약 50TB로 줄었습니다.
- 한 테이블은 파일 98,659개에 평균 0.4MB로 MERGE 중 S3 타임아웃이 났습니다. 쓰기 분산 설정(`write.distribution-mode`)이 none(셔플 없이 쓰기)이라 작업마다 파티션 전체에 작은 파일을 흩뿌린 것이 원인이었습니다. 글은 none을 기본값이라 적었지만 지금 Iceberg [Spark Writes 문서](https://iceberg.apache.org/docs/latest/spark-writes/#writing-distribution-modes)의 기본값은 hash이고 none은 이전 기본값입니다. 분산 방식과 목표 크기를 바꾸고 컴팩션한 뒤 스냅샷을 만료하는 순서로 정리해 전체 파일이 648,789개에서 30,354개로 줄었습니다.

copy-on-write로 매시간 MERGE하면 바뀐 행이 든 파일을 매번 다시 씁니다. 옛 파일은 스냅샷이 참조하는 동안 남으니 만료 없이 6개월이면 같은 데이터의 옛 버전이 열 배쯤 쌓일 수 있다는 것을 이 사례가 보여 줍니다.

## 6. 순서

공식 문서는 실행 순서를 명시하지 않습니다. 목차는 권장 유지보수(스냅샷 만료, 오래된 메타데이터 정리, 고아 파일 삭제)와 선택 유지보수(데이터 파일 컴팩션, manifest 재작성, 삭제 파일 재작성 등)로 나뉩니다. 3~5절의 동작에서 나오는 순서는 이렇습니다.

1. 컴팩션: 작은 파일을 합친 replace 스냅샷을 만든다. 옛 작은 파일은 아직 이전 스냅샷이 참조한다.
2. 스냅샷 만료: 옛 스냅샷을 빼면 옛 작은 파일을 참조하는 곳이 사라진다(도구에 따라 이때 파일도 지운다).
3. 고아 파일 삭제: 남은 파일과 실패한 쓰기의 파일을 지운다. 진행 중인 쓰기보다 오래된 것만.

어피닛 사례의 정리 순서도 이와 같았습니다.

순서를 거꾸로 하면 어떻게 될까요? 만료를 먼저 하고 컴팩션을 나중에 하면 컴팩션 직전 스냅샷이 옛 작은 파일을 여전히 가리킵니다. 다음 만료 주기가 돌 때까지 작은 파일과 합친 파일이 둘 다 남아 같은 데이터를 두 벌로 저장합니다. 1 → 2 → 3 순서는 한 번의 정리로 끝내기 위한 순서입니다.

## 7. 중국과 국내 빅테크 사례

### 7-1. 스트리밍 커밋이 만드는 작은 파일

| 회사 | 겪은 일과 대응 |
|---|---|
| Tencent 데이터플랫폼부(2021) | 1분마다 커밋하면 하루 1,440번 커밋이고 커밋이 막히면 앞의 쓰기까지 막힌다고 적었습니다. Flink 싱크와 함께 도는 컴팩션 연산자를 만들어 커밋마다 합치기 작업을 띄우고 스냅샷 수 같은 테이블 속성으로 조절했습니다. 파일이 수천 개 쌓인 오래된 테이블은 온라인 작업에서 합치지 않고 SQL 확장으로 컴팩션, 남은 파일 삭제, 스냅샷 만료를 따로 돌렸습니다 |
| Tencent 광고 로그 플랫폼(2022) | Iceberg에 들어 있는 작은 파일 합치기 서비스가 계산 자원을 너무 많이 썼습니다. 쓰기 전에 태스크 수를 줄여(coalesce) 한 번에 생기는 파일 수를 약 7분의 1로 줄였습니다. 매시간 입수하고 단일 파티션이 수십 TB인 규모입니다 |
| ByteDance(Hudi) | 컴팩션을 Flink 밖의 독립 서비스(Spark 배치)로 떼어 냈습니다. Flink는 증분 쓰기와 컴팩션 계획만 맡습니다 |
| NetEase Amoro | 작은 파일 합치기와 만료된 파일 정리를 사용자가 직접 해야 하는 문제를 플랫폼의 자동 최적화로 풀었습니다. 16MB 미만 조각을 수 분 단위로 합치는 Minor, 시간 단위의 Major, 일 단위의 Full 세 단계입니다 |
| B站(Hudi) | 커밋 기록을 오래 보관하면 파일이 너무 많아져 타임라인 조회 성능이 떨어진다고 적었습니다 |

### 7-2. 컴팩션 전략: 합치기만 할지, 정렬할지

Tencent 微视의 2022년 글은 Spark 컴팩션의 BinPack(크기만 맞춰 합치기)과 Sort(정렬해서 다시 쓰기)를 비교했습니다. 명세 테이블을 사용자 ID로 정렬하자 BinPack보다 테이블 크기가 40~70% 줄었고 사용자 3명을 조회할 때 읽는 파일이 BinPack 77개, Sort 3개였습니다. Ch-18 2-1절의 manifest 통계(컬럼별 min/max)로 파일을 거를 때 정렬된 파일은 값 범위가 좁아 거르기가 잘 됩니다.

왜 그런지 쇼핑몰 주문 테이블로 바꿔 보겠습니다. 회원 번호가 1부터 100만까지이고 주문 파일이 100개라고 합시다.

| 합치는 방식 | 파일마다 `user_id`의 최솟값과 최댓값 | 회원 42번의 주문을 찾을 때 여는 파일 |
|---|---|---|
| BinPack(들어온 순서대로 합침) | 거의 모든 파일이 1 ~ 1,000,000 | 통계로 거를 수 없어 100개 전부 |
| Sort(`user_id`로 정렬해 합침) | 파일 1은 1 ~ 10,000, 파일 2는 10,001 ~ 20,000, … | 42가 범위에 드는 파일 1 하나 |

숫자는 설명용으로 고른 것이지만 微视 사례의 "77개 대 3개"가 같은 원리입니다. 정렬하면 비슷한 값이 한 파일에 모여 압축도 잘 되니 테이블 크기가 줄어든 것도 같은 이유로 볼 수 있습니다.

### 7-3. 국내: 카카오와 토스

카카오의 2024년 글 "Apache Iceberg와 Flink CDC 심층 탐구"(Flink 1.17.1, Iceberg 1.5.0)는 30억 레코드에 하루 평균 400만 건이 바뀌는 테이블을 체크포인트 10분으로 CDC 반영하며 쟀습니다.

- 전체 조회가 첫날 2.8분에서 7일 뒤 60분으로 늘었습니다. 7일째 컴팩션은 39분 걸렸고 그 뒤 조회는 1.7분이었습니다.
- 목표 파일 크기를 250MB로 두자 187.5~450MB 사이 파일은 컴팩션 대상에서 빠졌습니다(5-1절의 75%~180% 범위). 그 파일들이 참조하는 삭제 파일이 계속 남아 스냅샷 만료와 고아 파일 정리로도 지워지지 않았고 4만 개 넘게 쌓였습니다. 모든 파일을 다시 쓰는 옵션(`rewrite-all=true`)으로 풀었습니다.

5-1절의 기본 크기 범위가 실제로 무엇을 놓치는지 보여 주는 사례입니다.

토스의 2024년 글 "입수는 Datalake로! (feat. Iceberg)"는 Kafka Connect 기반으로 약 1,000개의 입수 파이프라인을 세 명이 관리하며 쓰는 유지보수 설정을 공개했습니다.

- 스냅샷은 최근 2개만 남깁니다.
- 데이터 파일 재작성은 목표 약 230MB, 최대 512MB입니다.
- CDC 테이블의 delete 파일을 정리하려고 `delete-file-threshold`를 0으로 둡니다. 이 옵션은 "삭제 파일이 이 개수 이상 붙은 데이터 파일을 다시 쓴다"는 뜻이고 Iceberg 소스는 `삭제 파일 수 >= 기준값`으로 비교합니다. 0이면 삭제 파일이 없는 파일도 조건을 만족하니 사실상 모든 데이터 파일이 재작성 대상이 됩니다. 삭제 파일이 하나라도 붙은 파일만 고르려면 1입니다.
- 쓰기와 재작성이 동시에 일어나면 메타데이터가 손상될 수 있어 유지보수 중에는 입수를 잠시 멈춥니다. 고아 파일 삭제는 진행 중인 쓰기의 파일을 지울 위험이 있다고 적었습니다(4-2절과 같은 경고).
- 파티션 컬럼 타입이 맞지 않아 파티션 거르기가 실패하자 한 쿼리가 124.12TB(파일 655,173개)를 읽었습니다. 타입을 맞춘 뒤 3.70TB(파일 19,054개)로 줄었습니다.

## 8. 범위와 한계

- 2절과 3-2절은 PyIceberg 0.12.0, SQLite 카탈로그, 로컬 파일시스템으로 확인했습니다. Spark의 `expire_snapshots`는 직접 돌리지 않았습니다.
- 5절의 수치는 각 글쓴이의 환경입니다. 어피닛 글은 요약 도구를 거쳐 확인했으니 수치를 인용할 때는 원문을 다시 보길 권합니다.
- PyIceberg 0.12.0에서 컴팩션과 고아 파일 삭제 API는 찾지 못했습니다.
- 4-2절의 시간표, 7-2절의 회원 번호 표는 원리를 보이려고 만든 예이고 실측이 아닙니다.
- 5-1절의 컴팩션 대상 조건과 7-3절의 `delete-file-threshold` 해석은 Iceberg main 브랜치 소스 기준입니다. 2024년 무렵 버전인 1.5.0 소스(`SizeBasedDataRewriter`)도 같은 비교(`삭제 파일 수 >= 기준값`)였습니다. 토스 글이 쓴 Iceberg 버전은 확인하지 못했습니다.

## 9. 헷갈렸던 것

**Q. 시간 여행이 되면 백업이 필요 없나요?**

스냅샷은 보존 기간이 지나면 만료되고 같은 저장소 안에 있습니다. 저장소가 망가지거나 테이블을 지우면 스냅샷도 함께 사라집니다. 시간 여행은 "최근 며칠 안의 실수 되돌리기"에 가깝고 백업을 대신하지 않습니다.

**Q. 스냅샷 보존을 길게 하면 안전하지 않나요?**

그만큼 옛 파일이 남습니다. 5-3절처럼 자주 다시 쓰는 테이블은 보존 기간이 곧 저장 비용입니다. 오래 남길 시점은 태그로 골라 남기고 나머지는 짧게 만료하는 것이 사례의 방식이었습니다.

**Q. 고아 파일 삭제 기준을 1시간으로 줄이면 빨리 치울 수 있지 않나요?**

1시간 넘게 걸리는 쓰기 작업이 있으면 그 작업이 쓰고 있던 파일을 지워 테이블이 깨집니다. 가장 오래 걸리는 쓰기보다 넉넉하게 잡습니다. 기본 3일이 보수적인 이유입니다.

## 참고 자료

공식 문서와 명세
- Apache Iceberg, [Maintenance](https://iceberg.apache.org/docs/latest/maintenance/), [Spark Procedures](https://iceberg.apache.org/docs/latest/spark-procedures/), [Configuration](https://iceberg.apache.org/docs/latest/configuration/)
- Apache Iceberg, [Queries](https://iceberg.apache.org/docs/latest/spark-queries/)(Time travel), [Branching and Tagging](https://iceberg.apache.org/docs/latest/branching/)
- Apache Iceberg, [Iceberg Table Spec](https://iceberg.apache.org/spec/)
- Apache Iceberg 소스, [BinPackRewriteFilePlanner](https://github.com/apache/iceberg/blob/main/core/src/main/java/org/apache/iceberg/actions/BinPackRewriteFilePlanner.java), [SizeBasedFileRewritePlanner](https://github.com/apache/iceberg/blob/main/core/src/main/java/org/apache/iceberg/actions/SizeBasedFileRewritePlanner.java)(컴팩션 대상 선택 조건)
- PyIceberg, [API](https://py.iceberg.apache.org/api/), [0.12.0 소스의 overwrite 설명](https://github.com/apache/iceberg-python/blob/pyiceberg-0.12.0/pyiceberg/table/__init__.py)

사례
- Jess Jang, [Apache Iceberg 테이블 운영 실전기: 스냅샷 관리부터 Compaction까지](https://blog.afinit.com/apache-iceberg-table-operations), 어피닛, 2026
- Data Engineering Team, [We Reproduced the Iceberg Small Files Problem on Purpose: What Maintenance Actually Buys You](https://www.sapotacorp.vn/blog/iceberg-small-files-compaction-lab), Sapota, 2026
- 실습 코드: [labs/de-study/ch18](https://github.com/dj258255/IT-Oasis/tree/main/labs/de-study/ch18)

중국과 국내 빅테크 사례
- 苏舒(Tencent), [数据湖｜Flink + Iceberg 全场景实时数仓的建设实践](https://cloud.tencent.com/developer/article/1867867), 2021
- 腾讯大数据, [实时湖仓一体规模化实践：腾讯广告日志平台](https://cloud.tencent.com/developer/article/2113866), 2022
- 黄彬耕(Tencent), [Iceberg在腾讯微视实时场景的应用](https://cloud.tencent.com/developer/article/2099307), 2022
- 张友军(ByteDance), [字节跳动基于 Apache Hudi 构建实时数仓的实践](https://developer.volcengine.com/articles/7220261658042564666)
- Apache Incubator, [AmoroProposal](https://cwiki.apache.org/confluence/spaces/INCUBATOR/pages/293046808/AmoroProposal)
- 周晖栋(bilibili), [B 站构建实时数据湖的探索和实践](https://developer.aliyun.com/article/1211753), 2023
- louis.sml, [Apache Iceberg와 Flink CDC 심층 탐구](https://tech.kakao.com/posts/656), 카카오, 2024
- 조승완, [입수는 Datalake로! (feat. Iceberg)](https://toss.tech/article/datalake-iceberg), 토스, 2024

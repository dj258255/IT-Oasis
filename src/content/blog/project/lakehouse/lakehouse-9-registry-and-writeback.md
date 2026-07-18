---
title: '추출만 늘리면 되는 줄 알았는데 전제가 셋 다 깨졌고, 게이트를 그대로 재면 정상이 오탐이었습니다'
titleEn: 'I Thought I''d Just Extract More Tables, but All Three Assumptions Broke, and Reusing the Gate As-Is Turned Normal States into False Alarms'
description: '이 파이프라인의 존재 이유는 "DBTower가 7일 뒤 버리는 데이터의 두 번째 삶"인데, 정작 지금까지 내리는 건 query_snapshot 하나뿐이었습니다. 백업 이력도, 플랜 변경 이력도, 대기 이벤트도 똑같이 7일 뒤 사라집니다. "추출 코드는 그대로 두고 테이블만 늘리면 된다"고 생각했는데, DBTower 쪽을 실제로 분석하니 전제가 셋 다 깨졌습니다. wait event는 원천에 영속 테이블 자체가 없고(추출할 것이 없음), plan_snapshot은 보존이 카운트 기반이라 하루가 닫히기 전에 행이 지워질 수 있고, backup_run은 verify가 나중에 UPDATE하는 사후 변이 테이블이라 "닫힌 dt는 불변"이라는 이 파이프라인의 기본 전제가 안 맞습니다. 그래서 단수 상수(SOURCE_TABLE)를 복수로 늘리는 대신 테이블 스펙 레지스트리로 일반화했습니다. 워터마크 컬럼·불변성·게이트 프로필이 스펙의 일부입니다. 게이트 프로필이 필요한 이유는 실데이터가 증명했습니다. 그날 백업이 돈 인스턴스는 6개 중 3개뿐이었는데 그게 정상이라서, 4축 게이트를 그대로 재면 completeness FAIL로 정상 상태가 차단됩니다. 프로필은 그 축을 끄되 SKIP으로 보고서에 남깁니다. 안 잰 것을 잰 척하지 않습니다. 그리고 방향이 반대인 일을 하나 더 했습니다. 장기 dow×hour 베이스라인 마트를 만들어 원천 쪽 별도 테이블로 되쓰는(writeback) 경로입니다. 7일 창 이상감지가 못 잡는 주간 계절성 오탐을 줄이기 위해 DBTower가 기계로 소비할 화물입니다. 원천 readonly 봉인을 지키려고 별도 역할(lakehouse_writer)에 해당 테이블만 권한을 주고 단일 트랜잭션 DELETE+INSERT로 32,498행 왕복을 실측했으며, 그 역할로 query_snapshot을 읽으려 하면 permission denied가 나는 것까지 확인했습니다. 기본 상태의 베이스라인 마트는 0행입니다. 이력이 6일뿐이라 8관측 게이트를 못 넘는 게 정직한 결과이고, 이력이 쌓이면 찹니다.'
descriptionEn: 'This pipeline exists to give a second life to data DBTower deletes after seven days — yet until now it only offloaded query_snapshot. Backup history, plan-change history, and wait events vanish just the same. I assumed I could keep the extraction code and just add tables, but analyzing the DBTower side broke all three assumptions: wait events have no persistent source table at all (nothing to extract), plan_snapshot uses count-based retention so rows can be swept before a day closes, and backup_run is post-mutating (verify UPDATEs it later), violating this pipeline''s "closed dt is immutable" premise. So instead of multiplying a singular constant (SOURCE_TABLE), I generalized to a table-spec registry where the watermark column, mutability, and gate profile are part of the spec. Real data proved why gate profiles matter: only 3 of 6 instances ran backups that day — which is normal — so reusing the 4-axis gate as-is would block a normal state with a completeness FAIL. The profile turns those axes off but records them as SKIP: never pretend to have measured what you didn''t. And I built one thing in the opposite direction: a long-term dow×hour baseline mart written back to a separate table on the source side — cargo for DBTower''s anomaly detector to consume, reducing weekly-seasonality false alarms a 7-day window can''t see. To preserve the source''s read-only seal, a separate role (lakehouse_writer) gets permissions on that one table only; I measured a 32,498-row round trip in a single DELETE+INSERT transaction, and confirmed that role gets permission denied when reading query_snapshot. In its default state the baseline mart has 0 rows — with only six days of history it can''t pass the 8-observation gate, which is the honest result; it fills as history accumulates.'
date: 2026-07-18
tags:
  - Data Engineering
  - Airflow
  - dbt
  - DuckDB
  - Reverse ETL
category: personal/lakehouse
coverImage: /uploads/project/lakehouse/cover.svg
draft: false
series: "lakehouse"
seriesOrder: 9
---

## 0. 존재 이유의 구멍이 세 테이블에 남아 있었다

0편에서 이 프로젝트의 존재 이유를 "버려지는 관측 데이터의 두 번째 삶"이라고 썼습니다.
그런데 여덟 편이 지나도록 내리는 건 `query_snapshot` 하나였습니다. DBTower의 메타
DB에는 백업 이력(backup_run)과 플랜 변경 이력(plan_snapshot)도 쌓이는데, 이것들도
똑같이 보존 정책에 걸려 지워집니다. "이번 분기 백업 실패율 추세"나 "이 쿼리의 플랜이
지난달 몇 번 뒤집혔나" 같은 질문은 장기 이력이 있어야 답할 수 있는데, 그 이력이 지금도
매일 사라지고 있었습니다. 존재 이유였던 그 구멍이 세 테이블에 아직 남아 있던 겁니다.

계획은 단순해 보였습니다. offload는 이미 멱등하고, 게이트도 있고, 파티션 규약도
있으니 **"추출 대상 테이블만 늘리면 된다."** 코드 변경은 거의 없을 줄 알았습니다.

## 1. 전제가 셋 다 깨졌다

착수 전에 DBTower 쪽을 실제로 분석했고, "그냥 늘리면 된다"의 전제가 전부 무너졌습니다.

**첫째, wait event는 추출할 것 자체가 없습니다.** DBTower는 wait event를 5기종에서
조회해 화면에 보여주지만, 메타 DB에 주기적으로 **영속하지는 않습니다.** 조회 API만
있고 테이블이 없으니 내릴 것이 없습니다. 이건 DBTower 쪽에 `wait_event_snapshot`
테이블과 수집 잡을 신설해야 풀리는 문제라, 이번 범위에서는 "원천 테이블이 생기면
바로 편입되도록 자리만 예약"하기로 했습니다.

**둘째 문제는 plan_snapshot의 카운트 기반 보존입니다.** 쿼리당 최신 20개를 넘으면 한
시간마다 도는 스윕이 오래된 행을 지웁니다. 플랜이 자주 뒤집히는 쿼리라면 "어제
하루치"가 닫히기 전에 어제 행이 지워질 수 있다는 뜻입니다. 시간 창으로 추출하는 이
파이프라인의 전제와 정면으로 어긋납니다. 근본 해결은 DBTower 쪽에 시간 기반 보존을
병행하는 것이고, 그 전까지는 "당일 추출분이 불완전할 수 있음"을 계약 문서에 정직하게
적어 두는 것이 맞다고 판단했습니다.

**셋째, backup_run은 닫힌 뒤에도 변합니다.** 백업이 끝나고 나서 복원 검증(verify)과
원격 업로드가 **나중에 그 행을 UPDATE**합니다. 이 파이프라인은 지금까지 "닫힌 dt는
불변"을 전제로 멱등을 설계했는데, 이 테이블은 어제 뽑은 행이 오늘 달라질 수 있습니다.
그래서 이 테이블의 계약은 **D+1 스냅샷**입니다. "어제 dt를 오늘 뽑은 시점의 모습"
이고, 이후 갱신은 다음 날 재추출이 반영합니다. 워터마크도 변하지 않는 `started_at`을
씁니다.

같은 "테이블 추가"인데 세 테이블의 성질이 전부 다릅니다. 이건 상수 하나를 배열로
바꾸는 문제가 아니었습니다.

## 2. 단수 상수를 레지스트리로

그래서 `SOURCE_TABLE`이라는 단수 상수를 **테이블 스펙 레지스트리**로 일반화했습니다.
스펙에는 컬럼과 parquet 스키마만이 아니라, 위에서 드러난 성질들이 그대로 들어갑니다.

```python
@dataclass(frozen=True)
class TableSpec:
    name: str                        # 원천 테이블명
    select_columns: tuple[str, ...]  # 추출 컬럼
    schema: pa.Schema                # parquet 명시 스키마
    watermark_col: str               # 하루창 필터 컬럼 (backup_run은 started_at)
    gate: GateProfile                # 어떤 게이트 축을 강제할까
    immutable: bool = True           # False = 사후 변이(D+1 스냅샷 계약)
    available: bool = True           # False = 원천에 테이블이 아직 없음
```

offload는 이 스펙을 받아 도는 일반 함수가 됐고, 기존 호출부는 기본값(query_snapshot)
으로 무변경 동작합니다. 57개 pytest가 그대로 통과해 회귀가 없음을 확인했습니다.

`available=False`가 재미있는 부분입니다. wait_event_snapshot은 스펙이 예약돼 있지만
원천에 테이블이 없으므로, 추출을 시도하면 **시끄럽게 거부**합니다.

```
RuntimeError: wait_event_snapshot은 원천에 영속 테이블이 아직 없다(레지스트리
available=False). DBTower 쪽 D1 작업이 선결이다.
```

조용히 빈 결과를 내는 것과 명확히 거부하는 것 사이의 선택인데, 이 저장소는 언제나
후자입니다. 셀프호스트 문서에서 "database_instance 권한이 빠지면 조용히 빈 결과"를
최다 함정으로 경고해 놓고, 스스로 같은 패턴을 만들 수는 없습니다.

실제 원천에서 돌려 봤습니다. backup_run 24행, plan_snapshot 13행이 각각 내려왔고,
두 번 돌려도 행수가 같았습니다(멱등 승계).

## 3. 게이트를 그대로 재면 정상이 오탐이다

여기서 이번 편의 핵심 발견이 나옵니다. 그날 backup_run이 있는 인스턴스는 **6개 중
3개**였습니다. 나머지 셋은 백업이 안 돌았습니다. 그리고 그게 **정상**입니다. 백업
정책이 모든 인스턴스에 매일 걸려 있지 않기 때문입니다.

그런데 기존 게이트의 completeness 축은 "레지스트리의 모든 인스턴스가 파티션에 존재"를
요구합니다. query_snapshot에는 맞는 검문입니다. 수집기는 등록된 전 인스턴스를 매일
훑으니, 빠지면 수집 장애입니다. 하지만 backup_run에 같은 잣대를 대면 **정상 상태가
매일 FAIL**입니다. fail-closed 게이트라 다운스트림까지 차단됩니다. freshness도
마찬가지입니다. "최신 행이 하루 경계에 근접"은 연속 수집의 전제인데, 백업은 하루 한두
번 도는 이벤트입니다.

그래서 게이트 축의 적용 여부를 테이블 스펙의 일부(**게이트 프로필**)로 만들었습니다.
backup_run과 plan_snapshot은 정합(원천 행수 = parquet 행수)과 스키마 드리프트만
강제하고, completeness·freshness는 끕니다. 단, 끈 축은 보고서에서 사라지는 게 아니라
**SKIP으로 남습니다.**

```
dt           check           status  detail
2026-07-16   reconciliation  OK      PG=parquet=24행 (3인스턴스)
             completeness    SKIP    저빈도 테이블 — 전 인스턴스 존재를 요구하면 오탐
             freshness       SKIP    이벤트성 테이블 — 경계 근접 전제가 부적합
             schema_drift    OK      기대 11컬럼 전부 타입 일치
             = dt verdict    OK      통과
```

안 잰 것을 잰 척하지 않는다는, 3편에서 게이트를 만들 때 세운 원칙이 프로필에도 그대로
적용됩니다. DAG에는 이 보조 추출·게이트를 **주 체인과 분리된 브랜치**로 달았습니다.
보조 테이블이 실패했다고 주 경로의 heartbeat가 굶으면, deadman이 "파이프라인 전체가
침묵한다"는 오경보를 내기 때문입니다.

![Airflow 실화면. snapshot_offload DAG 그래프에 주 체인(offload→quality_gate→transform→publish→heartbeat)과 분리된 보조 브랜치(offload_aux→quality_gate_aux), heartbeat와 병렬인 writeback이 보인다](/uploads/project/lakehouse/lh14_dag_graph_ui.png)

## 4. 반대 방향의 일: 장기 베이스라인 되쓰기

이번 편의 나머지 절반은 방향이 반대입니다. 지금까지 데이터는 늘 원천 → 분석계로
흘렀는데, 이번엔 분석계가 원천 쪽에 **주는** 것을 하나 만들었습니다.

동기는 DBTower의 이상 감지입니다. 베이스라인이 7일 창(요일×시간대)이라, 매주
월요일 아침 배치 피크가 반복되는 인스턴스에서 "평소와 다름" 오탐이 납니다. 4주 전
같은 요일과 비교할 이력이 관제탑에는 없기 때문입니다. 7일 뒤 지우니까요. 그런데
그 이력을 가진 곳이 바로 여기, lakehouse입니다.

시간대별 팩트(`fct_query_hourly`, 일간 팩트와 같은 양 끝 차분을 (dt, hour)
창으로)를 신설하고, 그 위에 장기 베이스라인 마트를 얹었습니다. (instance, query,
요일, 시간대)별 시간당 호출량의 평균·표준편차입니다. 가드 둘을 달았습니다.
관측 8개 미만 버킷은 통계가 아니라 소음이므로 거르고(min_observations), 인스턴스당
호출량 상위 500개 쿼리만 계산합니다(인스턴스×쿼리×168버킷은 카디널리티 폭발
경로라서). 잘린 쿼리는 "장기 베이스라인 없음 → DBTower가 현행 7일 창으로 폴백"이
계약이지 오류가 아닙니다.

이 마트를 원천 쪽 별도 테이블(`baseline_longterm`)로 되쓰는(writeback) 모듈이 이번
편의 마지막 조각입니다. 여기서 제일 신경 쓴 건 **원천 readonly 봉인**입니다. 1편부터
이 파이프라인의 안전 논거는 "분석이 운영을 오염시키지 않는다"였고, offload는 세션
레벨 readonly까지 겁니다. 되쓰기가 그 봉인을 깨면 안 됩니다. 그래서:

- 되쓰기는 **별도 역할** `lakehouse_writer`로만 접속합니다. 이 역할은
  baseline_longterm 한 테이블에만 권한이 있습니다. 원천 접속 설정(SourceConfig)은
  코드에서 재사용 자체를 금지했습니다.
- DELETE+INSERT를 **단일 트랜잭션**으로 묶었습니다. DBTower의 이상 감지 폴러가
  되쓰기 도중에 읽어도, PG MVCC 덕에 이전 버전을 봅니다. 빈 테이블을 읽는 순간이
  없습니다.
- 행수 대조가 어긋나면 롤백합니다(발행 태스크의 불변식을 그대로 이식).
- WRITEBACK 설정이 없으면 조용한 실패가 아니라 **명시적 no-op 로그**를 남깁니다.

실측입니다. 마트 32,498행을 DuckLake에 발행하고 되쓰기를 돌리니 원천 쪽 테이블에
32,498행이 단일 트랜잭션으로 들어갔고 행수 대조가 통과했습니다. 그리고 봉인도 검증했습니다.
그 writer 역할로 query_snapshot을 읽으려 하면:

```
ERROR:  permission denied for table query_snapshot
```

쓰라고 만든 역할이 관측 데이터를 읽지도 못합니다. 봉인이 실제로 잠겨 있습니다.

## 5. 남은 것을 정직하게

- **기본 상태의 베이스라인 마트는 0행입니다.** 이력이 6일뿐이라 각 (요일, 시간대)
  버킷의 관측이 최대 1개이고, 8관측 게이트를 못 넘습니다. 로직은 게이트를 1로 낮춘
  검증 빌드(32,498 버킷 통계 산출)로 확인했고, 기본값으로 원복했습니다. 6편의 롤링
  마트가 실데이터에서 정직하게 비었던 것과 같은 상태입니다. 이력이 쌓이면 찹니다.
- **수신 쪽(DBTower)의 병합은 아직입니다.** baseline_longterm 테이블의 정식 DDL은
  DBTower의 마이그레이션이 소유해야 하고(이번 검증에선 수동 생성으로 대행), 장기
  베이스라인을 7일 창과 가중 병합하는 로직도 그쪽 저장소의 몫입니다. "월요일 피크를
  더는 오탐하지 않는다"는 최종 검증은 그 병합과 4주 이력이 갖춰진 뒤에야 가능합니다.
- **wait event는 여전히 자리만 예약입니다.** 원천에 영속 테이블이 생기면 레지스트리
  스펙의 available을 켜는 것으로 편입됩니다.
- **plan_snapshot의 보존 경합은 문서로만 막았습니다.** 시간 기반 보존이 원천에
  병행되기 전까지, 당일 추출분이 불완전할 수 있다는 계약 표기가 방어의 전부입니다.

---

이번 편에서 배운 건, "그냥 테이블만 늘리면 된다"는 문장이 세 번 틀리는 동안 파이프라인
설계에서 진짜 일반화해야 할 것이 드러났다는 점입니다. 테이블마다 다른 건 이름이
아니라 성질이었습니다. 워터마크가 뭔지, 닫힌 뒤에 변하는지, 어떤 검문이 의미
있는지. 그 성질을 스펙으로 만들고 나니 추출·게이트·DAG가 전부 스펙을 읽는 일반
장치가 됐고, 아직 존재하지 않는 테이블(wait event)조차 "자리 예약 + 시끄러운 거부"로
정직하게 다룰 수 있게 됐습니다. 그리고 되쓰기는 분석계가 처음으로 원천에 무언가를
주면서도, 봉인을 여는 게 아니라 옆문을 하나 만들고 그 문에만 열쇠를 준 일이었습니다. 방향이
반대인 두 일을 한 편에서 했지만, 지키려던 원칙은 하나였습니다. 운영계를 오염시키지
않으면서 운영계가 못 보는 것을 보게 해 주는 것.

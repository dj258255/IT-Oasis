---
title: '남이 그대로 띄우게 만들고, 두 저장소가 되쓰기로 손잡다'
titleEn: 'Making It Run for Others As-Is, and Two Repos Joining Hands via Writeback'
description: '여기까지 "전부 로컬에서 e2e 재현 가능"이라고 여러 번 써 왔는데, 남이 clone하면 아무것도 안 떴습니다. 원천이 없어 인스턴스 0개로 조용히 빈 결과가 나기 때문입니다. 그래서 데모 위성을 떼어내 셀프호스트 어플라이언스로 만들었습니다. docker-compose.standalone.yml과 demo 프로필로 DBTower 없이도 offload부터 게이트, dbt, 발행까지 e2e가 돌고, 격리 실측에서 외부 의존은 0이었습니다. 범용 도구로 넓히지는 않았습니다. DBTower를 셀프호스트하는 사람이 자기 관제 옆에 이 창고를 같이 띄우는 것까지가 목표라 초점을 좁힌 결정입니다. 그다음 두 저장소가 손을 잡았습니다. 원천을 query_snapshot 하나만 내리던 걸 테이블 스펙 레지스트리로 일반화해 백업·플랜·대기 이력까지 편입하는데, 전제가 셋 다 깨졌습니다. wait event는 원천에 영속 테이블이 없고, plan_snapshot은 카운트 기반 보존이라 하루가 닫히기 전 지워질 수 있고, backup_run은 verify가 나중에 UPDATE하는 사후 변이 테이블입니다. 그래서 워터마크·불변성·게이트 프로필을 스펙의 일부로 넣었고, 게이트를 그대로 재면 백업 안 도는 인스턴스가 정상인데도 completeness FAIL로 정상이 차단되는 걸 확인해 프로필로 그 축을 SKIP으로 남겼습니다. 방향이 반대인 일도 하나 했습니다. 장기 dow×hour 베이스라인을 계산해 원천 쪽으로 되쓰는 경로입니다. readonly 봉인을 깨지 않으려 별도 역할에 해당 테이블만 권한을 주고 단일 트랜잭션으로 32,498행 왕복을 실측했으며, 그 역할로 query_snapshot을 읽으면 permission denied가 나는 것까지 확인했습니다.'
descriptionEn: 'I had written many times that everything reproduces locally end to end, yet cloning it showed nothing, because with no source the instance list is empty and results go silently blank. So I split off the demo satellite into a self-host appliance. With docker-compose.standalone.yml and a demo profile, offload through gate, dbt, and publish run end to end without DBTower, and in isolation external dependencies were zero. I did not widen it into a general tool; the goal stops at letting someone who self-hosts DBTower run this warehouse beside their monitor, a deliberately narrowed decision. Then two repos joined hands. Generalizing the single query_snapshot offload into a table-spec registry to admit backup, plan, and wait history broke all three assumptions: wait events have no persistent source table, plan_snapshot uses count-based retention so rows can vanish before a day closes, and backup_run is post-mutating as verify updates it later. So watermark, mutability, and gate profile became part of the spec, and reusing the gate as-is would block a normal state (instances that skip backups) with a completeness FAIL, so the profile records that axis as SKIP. I also did the opposite-direction work: computing a long-term dow-by-hour baseline and writing it back to the source. To keep the read-only seal, a separate role gets permission on that one table only, and I measured a 32,498-row round trip in a single transaction and confirmed that role gets permission denied reading query_snapshot.'
date: 2026-07-15
tags:
  - Data Engineering
  - dbt
  - Docker
  - Reverse ETL
category: personal/lakehouse
coverImage: /uploads/project/lakehouse/cover.svg
draft: false
series: "lakehouse"
seriesOrder: 4
---

## 0. "로컬에서 재현된다"는 문장의 숨은 전제

여기까지 오면서 저는 README와 블로그에 "전부 로컬에서 e2e 재현 가능"이라고 여러 번
썼습니다. 게이트가 반쪽 데이터를 막고, DuckLake가 타임트래블을 하고, 증분 fct가
407초를 4초로 줄이는 걸 전부 라이브로 돌려 보였으니 틀린 말은 아니라고 생각했습니다.

그런데 어느 날 이 질문이 걸렸습니다. **"남이 이걸 clone하면 뜰까?"** 머릿속으로
따라가 보니 답은 "안 뜬다"였습니다. 제 재현은 전부 **제 데모 스택이 옆에 이미 떠
있을 때**의 재현이었기 때문입니다.

`docker-compose.yml`의 맨 아래를 다시 봤습니다.

```yaml
networks:
  default:
    name: dbtower_default
    external: true
```

`external: true`. 이건 "dbtower_default라는 네트워크가 **이미 존재한다**고 가정하고
거기 붙는다"는 뜻입니다. 그 네트워크는 DBTower 데모 스택이 만든 것이고, 원천 PG도
싱크 MinIO도 전부 그 스택의 컨테이너입니다. compose 안에는 이런 것들이 박혀 있었습니다.

```yaml
SRC_PG_HOST: dbtower-postgres
SRC_PG_PASSWORD: dbtower1234
S3_ENDPOINT: http://dbtower-minio:9000
```

호스트명도 비밀번호도 제 데모 스택 전용입니다. 남의 컴퓨터엔 `dbtower-postgres`라는
호스트도, `dbtower_default`라는 네트워크도 없습니다. `docker compose up`은 네트워크가
없다며 즉시 죽습니다. 즉 이 저장소는 독립 실행되는 물건이 아니라 **제 데모 스택에
기생하는 위성**이었습니다. 로컬 재현은 "내 환경에서"라는 별표가 붙은 재현이었던
겁니다.

## 1. 범용으로 넓히지 않고 애드온으로 좁힌다

여기서 갈림길이 하나 있었습니다. "그럼 아무 DB에나 붙게 만들까?" 원천을 DBTower로
고정하지 말고 임의의 Postgres를 받게 하면, 이건 범용 쿼리 분석 도구가 됩니다.

이 유혹을 접었습니다. "쿼리 성능을 장기 저장해서 분석"하는 셀프호스트 도구는 이미
성숙한 레드오션입니다. Percona PMM과 pgwatch가 있고, Parquet+S3+DataFusion 구조가
이 스택과 거의 같은 OpenObserve까지 나와 있습니다. 여기 solo 프로젝트로 뛰어들면 결과물은
"OpenObserve만 못한 재구현"입니다. 무엇보다, 범용화하는 순간 **이 프로젝트만의
유일한 자산이 죽습니다.** 저는 원천(DBTower)도 직접 만들었습니다. 관측 플랫폼과 그
장기 기억 레이어를 둘 다 소유한 구조는 흔치 않고, 그게 정확히 Prometheus와 Thanos의
관계입니다. Prometheus는 짧게만 보관하고, Thanos가 그걸 객체 스토리지에 장기
보관·분석합니다. DBTower가 7일 뒤 스냅샷을 지우고, 이 파이프라인이 그걸 영구
보관합니다.

그래서 "실제 사용자"의 정직한 정의를 이렇게 잡았습니다. **DBTower를
셀프호스트하는 사람.** 그 사람이 자기 DBTower 옆에 이걸 같이 띄울 수 있게 하는
것까지가 목표입니다. 범용화는 안 합니다. 초점을 좁힌 결정입니다.

그리고 형태는 **어플라이언스**로 정했습니다. 배터리가 다 들어 있는 상자. 셀프호스트
한다는 건 원래 그 도구의 스택을 통째로 받는다는 뜻입니다. Grafana를 셀프호스트하면
그 저장 엔진이 같이 오고, GitLab을 띄우면 Postgres와 Redis가 딸려옵니다. 아무도
"Redis를 굴리기 싫다"고 하지 않습니다. 상자 안에 있어 안 보이니까요. 마찬가지로
사용자가 DuckDB나 DuckLake라는 단어를 한 번도 볼 필요가 없어야 합니다. `.env`에 자기
DBTower만 적고 `up`을 치면, 보이는 건 Metabase 대시보드 하나입니다.

## 2. 결합의 핵심은 한 줄이었다

무엇을 떼어내야 하는지 코드에서 찾다가, 결합의 급소가 생각보다 작다는 걸
알았습니다. `extract/config.py`의 이 부분입니다.

```python
class DuckLakeConfig:
    # 카탈로그 PG 접속 — SourceConfig와 같은 인스턴스, DB만 다르다.
    catalog_host: str = os.getenv("SRC_PG_HOST", "localhost")
    catalog_port: int = int(os.getenv("SRC_PG_PORT", "15432"))
```

DuckLake 카탈로그(파이프라인의 메타데이터가 사는 PG)가 **원천과 같은 PG 인스턴스를
재사용**하고 있었습니다. 데모 스택에선 이게 맞습니다. DBTower의 PG 하나에 관측 DB와
카탈로그 DB가 나란히 있으니까요. 하지만 어플라이언스에선 갈라져야 합니다. 원천은
**남의 외부 DBTower**이고, 카탈로그는 **우리가 번들한 PG**입니다. 이 둘이 같은
`SRC_PG_HOST`를 보면 안 됩니다.

분리는 이렇게 했습니다.

```python
# 카탈로그 PG 접속. DUCKLAKE_CATALOG_* 가 있으면 원천과 독립, 없으면 SRC_PG_* 폴백.
catalog_host: str = os.getenv("DUCKLAKE_CATALOG_HOST", os.getenv("SRC_PG_HOST", "localhost"))
catalog_port: int = int(os.getenv("DUCKLAKE_CATALOG_PORT", os.getenv("SRC_PG_PORT", "15432")))
```

`DUCKLAKE_CATALOG_*`를 새로 받되, 없으면 기존 `SRC_PG_*`로 폴백합니다. 이 폴백이
중요합니다. 데모 스택(개발용 compose)은 이 새 변수를 안 주니까 예전 그대로 동작하고,
standalone만 이 변수를 채워 카탈로그를 번들 PG로 보냅니다. **기존 경로를 한 톨도 안
건드리고** 분리한 겁니다. 리팩터는 하위호환이 지켜질 때만 성립합니다.

## 3. 상자를 짓는다: 번들과 시크릿

그 위에 `docker-compose.standalone.yml`을 새로 지었습니다. 개발용 compose는 그대로
두고(내 데모 스택에 붙는 위성으로 여전히 쓰니까), standalone은 별도 파일입니다.
차이는 이렇습니다.

- external 네트워크 전제를 걷어내고 자체 `default` 네트워크를 씁니다.
- 원천 MinIO·카탈로그 PG를 재사용하지 않고 **직접 번들**합니다. `minio`,
  `minio-init`(버킷 생성 후 종료), `catalog-postgres`, `airflow-postgres`,
  Airflow 3종, `metabase`가 들어갑니다.
- 유일한 외부 의존은 "사용자의 DBTower 메타 PG"뿐입니다. `SRC_PG_*`로 주입받습니다.

![standalone 어플라이언스 구조. 번들(Airflow·MinIO·카탈로그 PG·Metabase)과 외부 의존(사용자의 DBTower 메타 PG 두 테이블), demo 프로필의 샘플 원천](/uploads/project/lakehouse/lh11_appliance_box.svg)

시크릿은 하드코딩을 전부 없앴습니다. 데모 스택은 `airflow/airflow`, `dbtower1234` 같은
평문이 compose에 박혀 있었는데, 이건 로컬에선 편하지만 외부에 노출되는 순간 전부
취약점입니다. 특히 Airflow는 기본 웹서버에 인증이 없고, 과거 CVE는 로그와 UI로
시크릿이 새어 나간 이력이 있습니다. 그래서 이렇게 바꿨습니다.

```yaml
AIRFLOW__CORE__FERNET_KEY: ${AIRFLOW_FERNET_KEY:?set AIRFLOW_FERNET_KEY in .env}
AIRFLOW__WEBSERVER__SECRET_KEY: ${AIRFLOW_WEBSERVER_SECRET_KEY:?set AIRFLOW_WEBSERVER_SECRET_KEY in .env}
```

`${VAR:?메시지}`는 그 변수가 없으면 compose가 **기동을 거부**합니다. 커넥션 암호화
키(fernet)와 웹 세션 서명 키(secret_key)는 반드시 새로 생성해야 하는 값인데, 기본값을
주면 누군가는 그걸 그대로 씁니다. 아예 없이는 못 뜨게 막았습니다. 생성 명령은
`.env.standalone.example`의 주석에 적어 뒀습니다.

Metabase 앱 DB도 옮겼습니다. 기존엔 H2(파일 기반 임베디드)를 볼륨에 영속했는데, 이건
Metabase 공식 문서가 프로덕션에서 쓰지 말라고 명시한 것입니다. 마침 카탈로그 PG를 이미
번들하니, 거기에 `metabase_app`이라는 별도 DB를 하나 더 만들어 Metabase 앱 DB로
흡수했습니다. 서비스는 하나도 안 늘고 프로덕션 위생만 챙긴 셈입니다.

![standalone Metabase 첫 화면. 번들 PG 앱 DB 위에서 갓 부팅한 셋업 위저드다. 사용자가 처음 만나는 화면이 이것이다](/uploads/project/lakehouse/lh11_standalone_metabase.png)

마지막으로 코드입니다. 개발용 compose는 `./dags`, `./extract`, `./dbt`를 bind-mount로
컨테이너에 얹습니다. 편집이 바로 반영돼 개발엔 좋지만, 프로덕션에선 호스트 코드를
마운트하는 게 재현성·보안 양쪽에서 위험합니다. 그래서 Dockerfile에 `COPY`를 추가해
이미지에 구웠습니다.

```dockerfile
COPY --chown=airflow:0 dags/ /opt/airflow/dags/
COPY --chown=airflow:0 extract/ /opt/airflow/extract/
COPY --chown=airflow:0 dbt/ /opt/airflow/dbt/
```

여기서도 하위호환이 살아 있습니다. 개발용 compose는 여전히 bind-mount로 이 baked
코드를 덮어쓰니 개발 경로는 불변이고, standalone만 bind-mount가 없어 구운 코드를
씁니다.

## 4. 밟은 함정 세 개

깔끔하게 한 번에 되진 않았습니다. 세 군데서 걸렸습니다.

**첫째, compose YAML의 콜론.** 시크릿 에러 메시지를 친절하게 쓴다고
`${AIRFLOW_FERNET_KEY:?generate: python -c "..."}`처럼 적었는데, `config` 검증이
`mapping values are not allowed in this context`로 죽었습니다. `generate: python`의
콜론-공백을 YAML이 매핑 키로 오해한 것입니다. 에러 메시지에서 콜론을 빼고 생성 명령은
`.env` 예시에만 남겼습니다. 문서와 설정의 역할을 섞지 말라는 교훈이었습니다.

**둘째, cryptography 없는 fernet 생성.** `.env` 예시에 fernet 키 생성 명령을
`from cryptography.fernet import Fernet ...`로 적었는데, 정작 검증 스크립트를 돌리니
그 모듈이 없었습니다. Airflow 안에는 있지만 컨테이너를 띄우기 *전*에 키를 만들어야
하는데, 그 시점엔 아무것도 없습니다. 표준 라이브러리만 쓰는 명령으로 바꿨습니다.
`python3 -c "import base64,os; print(base64.urlsafe_b64encode(os.urandom(32)).decode())"`.
fernet 키는 결국 32바이트 랜덤의 urlsafe base64라, 외부 의존 없이 만들 수 있었습니다.

**셋째, 호스트용 러너가 컨테이너 venv를 못 본다.** standalone을 띄우고 전체 파이프라인을
돌리려 `python -m extract.run_pipeline`을 컨테이너 안에서 쳤더니 `No module named 'dbt'`가
났습니다. 이유를 파보니, dbt는 Airflow 의존성 충돌을 피하려고 **분리된 venv
(`/opt/dbt-venv`)**에 깔려 있는데, `run_pipeline.py`는 "호스트용"이라 기본 python으로
dbt를 부릅니다. 컨테이너의 실제 경로는 DAG가 씁니다(`DBT_BIN = "/opt/dbt-venv/bin/dbt"`).
DAG와 똑같이 그 바이너리로 불렀습니다. 한 번 더 걸린 게 있는데, `dbt build`로
돌리니 unit test가 하나 실패했습니다. 이건 결함이 아니라, 외부 `read_parquet` 소스는
물리 relation이 없어 dbt-duckdb가 introspect를 못 하는 알려진 제약이고, DAG는 그래서
unit test를 빼고 `dbt run` + `dbt test --select test_type:data`만 돌립니다. DAG의 명령을
그대로 따랐더니 통과했습니다.

## 5. 격리해서 실제로 재봤다

여기서 조심할 게 있었습니다. 제 dev 스택(Airflow·Metabase·MinIO)이 5일째 8080·13001
포트로 돌고 있습니다. standalone을 같은 포트로 띄우면 충돌합니다. 그래서 별도
프로젝트명(`-p lakehouse-standalone`), 별도 컨테이너명(`lh-standalone-*`), 오버라이드
포트(18080 등)로 **격리**해서 띄웠습니다. 실측입니다.

먼저 결합 분리 확인입니다.

```
$ docker compose -f docker-compose.standalone.yml config | grep -c 'external: true'
0
네트워크: name: lakehouse-standalone   (external 아님)
```

`external: true`가 0입니다. 위성 전제가 사라졌습니다.

그다음 `--profile demo up`. 7개 컨테이너가 전부 healthy로 떴고, 버킷이 자동 생성됐고,
샘플 원천에 `database_instance=2`, `query_snapshot=10`이 시드됐습니다.

![standalone Airflow 첫 화면. 이미지에 구운 DAG 3개(snapshot_offload·ducklake_maintenance·deadman_watch)가 전부 Paused 상태로, 런 이력 없이 떠 있다. 남이 clone해서 처음 띄운 그 화면이다](/uploads/project/lakehouse/lh11_standalone_airflow.png)

**내
DBTower 없이** 파이프라인을 돌렸습니다.

```
offload 2026-01-01 → {"instances":{"1":4,"2":2},"total_rows":6}
offload 2026-01-02 → total_rows 4
번들 MinIO(DuckDB httpfs count): 10행 · 2dt · 2instance

게이트: reconciliation OK · completeness OK · freshness OK · schema_drift OK → PASS
dbt run:  PASS=3   (stg_query_snapshot · fct_query_daily · mart_query_regression)
dbt test: PASS=18  (데이터 테스트)
```

`offload → 게이트 → dbt run → dbt test`가 번들 MinIO·PG만으로 완주했습니다. 제 데모
스택은 이 실행에 전혀 참여하지 않았습니다. Metabase 앱 DB도 확인했습니다. 번들
PG의 `metabase_app`에 **151개 테이블**이 생겼고 `core_user`가 존재합니다. H2가 아니라
PG에 영속된다는 뜻입니다.

마지막으로 격리 확인입니다. `down -v`로 내린 뒤 `lh-standalone-*` 컨테이너 잔존은
0이었고, dev 스택(`lakehouse-*`, `dbtower-*`)은 그대로 돌고 있었습니다. standalone이
dev를 한 번도 건드리지 않았습니다.

## 6. 남은 것을 정직하게

- **TLS·리버스 프록시는 안 붙였습니다.** Airflow와 Metabase를 인터넷에 열려면 Caddy
  같은 프록시 뒤에 TLS·인증으로만 노출하고 MinIO·PG 포트는 절대 공개하지 말아야
  합니다. 다만 이건 "인터넷에 열 때만"의 선택 계층입니다. 사내망 셀프호스트라면
  프록시까지는 불필요해서, 이번 범위에선 뺐습니다.
- **카탈로그 PG 자기 백업 절차가 없습니다.** 카탈로그가 날아가면 DuckLake 메타가
  소실됩니다. 대상 백업은 있지만 자기 자신 백업은 RUNBOOK 확장 대상으로 남깁니다.
- **데모 원천은 파일 규모가 아니라 로직 대표 경로만 담습니다.** ci_fixture의 10행
  (정상 증가·지문 충돌·순리셋)이라, "몇백 대에서 버티나"는 규모 편의 인스턴스 수 축 실측이 답합니다.
- **결과를 자기 창고(Snowflake 등)로 내보내는 건 안 했습니다.** dbt 어댑터 교체로 열려
  있지만, 어플라이언스 사용자의 다수는 번들로 만족하므로 지금 구현하지 않습니다.
  필요해지는 사람이 생기면 그때입니다.

---

이번 편에서 제가 배운 건, "재현된다"는 문장에 붙은 별표를 정직하게 읽는 일이었습니다.
저는 로컬에서 다 돌아간다고 믿었지만, 그건 제 데모 스택이 옆에 떠 있다는 전제가 숨은
재현이었습니다. 그 전제를 떼어내니 결합의 급소는 config.py 한 줄이었고, 폴백 하나로
기존 경로를 안 깨고 분리할 수 있었습니다. 그 위에 상자를 짓고 격리해서 실제로 띄워
보니, 남이 clone해도 뜨는 물건이 됐습니다. 범용으로 넓히지 않고 애드온으로 좁힌 것도
같은 정직함의 일부입니다. 못 이길 싸움을 피하고, 내가 유일하게 가진 것(원천을 직접
만들었다는 사실)을 지키는 선택이었습니다.


## 7. 존재 이유의 구멍이 세 테이블에 남아 있었다

0편에서 이 프로젝트의 존재 이유를 "버려지는 관측 데이터의 두 번째 삶"이라고 썼습니다.
그런데 여덟 편이 지나도록 내리는 건 `query_snapshot` 하나였습니다. DBTower의 메타
DB에는 백업 이력(backup_run)과 플랜 변경 이력(plan_snapshot)도 쌓이는데, 이것들도
똑같이 보존 정책에 걸려 지워집니다. "이번 분기 백업 실패율 추세"나 "이 쿼리의 플랜이
지난달 몇 번 뒤집혔나" 같은 질문은 장기 이력이 있어야 답할 수 있는데, 그 이력이 지금도
매일 사라지고 있었습니다. 존재 이유였던 그 구멍이 세 테이블에 아직 남아 있던 겁니다.

계획은 단순해 보였습니다. offload는 이미 멱등하고, 게이트도 있고, 파티션 규약도
있으니 **"추출 대상 테이블만 늘리면 된다."** 코드 변경은 거의 없을 줄 알았습니다.

## 8. 전제가 셋 다 깨졌다

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

## 9. 단수 상수를 레지스트리로

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

## 10. 게이트를 그대로 재면 정상이 오탐이다

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

안 잰 것을 잰 척하지 않는다는, 앞서 게이트를 만들 때 세운 원칙이 프로필에도 그대로
적용됩니다. DAG에는 이 보조 추출·게이트를 **주 체인과 분리된 브랜치**로 달았습니다.
보조 테이블이 실패했다고 주 경로의 heartbeat가 굶으면, deadman이 "파이프라인 전체가
침묵한다"는 오경보를 내기 때문입니다.

![Airflow 실화면. snapshot_offload DAG 그래프에 주 체인(offload→quality_gate→transform→publish→heartbeat)과 분리된 보조 브랜치(offload_aux→quality_gate_aux), heartbeat와 병렬인 writeback이 보인다](/uploads/project/lakehouse/lh14_dag_graph_ui.png)

## 11. 반대 방향의 일: 장기 베이스라인 되쓰기

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

## 12. 남은 것을 정직하게

- **기본 상태의 베이스라인 마트는 0행입니다.** 이력이 6일뿐이라 각 (요일, 시간대)
  버킷의 관측이 최대 1개이고, 8관측 게이트를 못 넘습니다. 로직은 게이트를 1로 낮춘
  검증 빌드(32,498 버킷 통계 산출)로 확인했고, 기본값으로 원복했습니다. 규모 편의 롤링
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

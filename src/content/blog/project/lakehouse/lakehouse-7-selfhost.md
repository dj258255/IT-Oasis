---
title: '로컬에서 재현된다고 써 왔지만 남이 clone하면 아무것도 안 떴고, 데모 위성을 떼어내 어플라이언스로 만들었습니다'
titleEn: 'I Kept Writing "Reproducible Locally," but Nothing Booted When Someone Else Cloned It, So I Peeled Off the Demo Satellite and Made It an Appliance'
description: '6편까지 저는 "전부 로컬에서 e2e 재현 가능"이라고 써 왔습니다. 그런데 그건 제 DBTower 데모 스택이 옆에 떠 있을 때만 참이었습니다. compose가 dbtower_default라는 external 네트워크를 전제하고, 원천 호스트명(dbtower-postgres)과 크리덴셜(dbtower1234)이 하드코딩돼 있어서, 남이 git clone하고 docker compose up을 치면 아무것도 안 뜹니다. 즉 이건 독립 실행이 아니라 제 데모 스택에 얹힌 위성이었습니다. 그래서 방향을 정했습니다. 아무 DB에나 붙는 범용 도구로 넓히지 않고(그 자리는 PMM·pgwatch·OpenObserve로 이미 붐빕니다), DBTower를 셀프호스트하는 사람이 옆에 같이 띄우는 애드온으로 남깁니다. DBTower가 Prometheus면 이건 Thanos입니다. 결합의 핵심은 config.py에서 DuckLake 카탈로그가 원천 PG를 재사용하던 한 줄이었고, DUCKLAKE_CATALOG_*를 독립 주입하되 없으면 SRC_PG_*로 폴백하게 해서 데모 경로를 안 깨고 분리했습니다. 그 위에 자체 MinIO·카탈로그 PG·Metabase를 번들한 docker-compose.standalone.yml을 짓고, 시크릿을 전부 ${VAR:?}로 필수화하고, Metabase 앱 DB를 H2에서 번들 PG로 옮기고, 내 DBTower 없이도 체험하도록 샘플 원천을 --profile demo로 동봉했습니다. 돌고 있는 dev 스택과 격리해서 실제로 띄워 재보니 external:true는 0이었고, DBTower 없이 offload→게이트(4축 OK)→dbt run(PASS=3)→데이터 테스트(PASS=18)가 완주했으며, 번들 MinIO에 10행·2dt·2인스턴스가 적재됐고, Metabase는 번들 PG에 151테이블을 영속했습니다. 가는 길에 compose YAML의 콜론, cryptography 없는 fernet 생성, 호스트용 러너가 컨테이너의 분리 venv를 못 보는 함정을 밟았습니다.'
descriptionEn: 'Through part 6 I kept writing "fully reproducible locally." But that was only true while my DBTower demo stack sat next to it. The compose file assumed an external network (dbtower_default) and hardcoded the source hostname (dbtower-postgres) and credentials (dbtower1234), so if someone cloned the repo and ran docker compose up, nothing booted. It wasn''t a standalone thing; it was a satellite bolted onto my demo stack. So I made a call: don''t widen it into a generic tool for any database (that space is already crowded with PMM, pgwatch, OpenObserve), keep it as an add-on that someone self-hosting DBTower runs alongside. If DBTower is Prometheus, this is Thanos. The core coupling was one line in config.py where the DuckLake catalog reused the source PG; I split it by injecting DUCKLAKE_CATALOG_* independently while falling back to SRC_PG_* so the demo path stayed intact. On top of that I wrote docker-compose.standalone.yml bundling its own MinIO, catalog PG, and Metabase, made every secret required via ${VAR:?}, moved Metabase''s app DB from H2 to the bundled PG, and shipped a sample source under --profile demo so it runs without my DBTower. Booting it in isolation from the running dev stack, external:true was 0, the pipeline ran offload→gate (4 axes OK)→dbt run (PASS=3)→data tests (PASS=18) without DBTower, 10 rows across 2 dt and 2 instances landed in the bundled MinIO, and Metabase persisted 151 tables to the bundled PG. Along the way I hit traps: a colon in compose YAML, fernet generation without cryptography, and a host-only runner that couldn''t see the container''s separate venv.'
date: 2026-07-15
tags:
  - Data Engineering
  - Docker
  - Self-Hosting
  - Airflow
  - Metabase
category: personal/lakehouse
coverImage: /uploads/project/lakehouse/cover.svg
draft: false
series: "lakehouse"
seriesOrder: 7
---

## 0. "로컬에서 재현된다"는 문장의 숨은 전제

6편까지 오면서 저는 README와 블로그에 "전부 로컬에서 e2e 재현 가능"이라고 여러 번
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

그래서 "실제 사용자"의 정직한 정의를 이렇게 잡았습니다. **아무나가 아니라, DBTower를
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

![standalone Metabase 첫 화면 — 번들 PG 앱 DB 위에서 갓 부팅한 셋업 위저드. 사용자가 처음 만나는 화면이 이것이다](/uploads/project/lakehouse/lh11_standalone_metabase.png)

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
  (정상 증가·지문 충돌·순리셋)이라, "몇백 대에서 버티나"는 다음 편(인스턴스 수 축
  규모)의 몫입니다.
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

---
title: '"새 기종 = 구현체 1개"를 증명하러 Oracle과 MongoDB를 추가했다'
titleEn: 'Adding Oracle and MongoDB to Prove That a New Engine Costs Exactly One Implementation'
description: '이기종 DBMS 운영 관리 플랫폼 DBTower 4편. 문서에 계속 적어온 ''새 기종 추가 = Operator 구현체 1개''라는 주장을 검증하러, 성격이 정반대인 두 기종을 실제로 추가한 기록. SQL도 JDBC도 없는 MongoDB가 인터페이스 뒤로 들어오는 과정, 같은 FULL 백업이 네 가지 실행 모델(env·stdin·서버 SQL·서버 API)로 갈라지는 현실, Hibernate가 만든 CHECK 제약이 enum 확장을 막는 함정, 그리고 mongodump stdin에 숨어 있던 YAML 주입 가능성을 보안 리뷰로 잡아 막은 이야기까지, 수집과 비교, 회귀 감지, 웹, MCP 어느 코어 경로도 수정 0줄이라는 결과와 함께 남깁니다.'
descriptionEn: 'Part 4 of DBTower. To verify the claim that a new engine costs exactly one Operator implementation, I added two engines with opposite personalities: MongoDB, which has neither SQL nor JDBC, and Oracle, a commercial DB with its own privilege and backup model. The same FULL backup policy splits into four execution models (env, stdin, server-side SQL, server-side API), a Hibernate-generated CHECK constraint blocks enum expansion, and a YAML injection hiding in mongodump''s stdin config gets caught by security review, all with zero changes to the core paths of collection, comparison, regression detection, web console, and MCP.'
date: 2026-05-25
tags:
  - Java
  - Spring Boot
  - DBRE
  - MongoDB
  - Oracle
category: personal/DBTower
coverImage: /uploads/project/dbtower/cover.svg
draft: false
series: "DBTower"
seriesOrder: 4
---

## 0. 들어가며, 주장은 검증 전까지 빚이다

1편부터 같은 문장을 써 왔습니다. "새 기종 지원 = Operator 구현체 1개 추가, 플랫폼 코드는 수정 없음." SQL Server를 세 번째로 붙일 때 확인은 했지만 MySQL·PostgreSQL·SQL Server는 결국 다 SQL이고 다 JDBC입니다. 추상화가 진짜 시험대에 오르는 건 전제가 깨지는 기종이 들어올 때입니다.

그래서 성격이 정반대인 둘을 골랐습니다.

- **Oracle**은 JDBC는 맞지만 통계 소스(V$SQL)와 권한 모델, 백업(Data Pump)이 전부 다른 상용 DB입니다.
- **MongoDB**는 SQL도 JDBC도 없고, 실행계획이 JSON이며, 통계 소스가 시스템 뷰 대신 컬렉션입니다.

## 1. 인터페이스가 SQL을 전제하지 않았는지 MongoDB로 확인하는 시험

`DbmsOperator`의 7개 메서드(health, queryStats, slowQueries, explain, tableStats, backup, replicationState)를 MongoDB로 하나씩 옮겨보면, 추상화 경계를 어디에 그었는지가 드러납니다.

| 운영 행위 | JDBC 계열 | MongoDB |
|---|---|---|
| 쿼리 통계 | performance_schema / V$SQL 조회 | system.profile 컬렉션을 queryHash로 집계 |
| 실행계획 | `EXPLAIN` + SQL 문자열 | `explain` 명령 + **명령 JSON** |
| 읽기 전용 가드 | "SELECT로 시작해야 함" | 첫 키가 find/aggregate/count/distinct인지 검사 |
| 커넥션 관리 | 인스턴스별 HikariCP 풀 | MongoClient 자체가 풀이라 인스턴스별 캐시 |

explain 입력이 SQL이 아니라 `{"find": "users", "filter": {"name": {"$regex": "user123"}}}` 같은 JSON이 되는데도 인터페이스 시그니처는 그대로입니다. 경계를 "SQL을 실행한다"가 아니라 **"실행계획을 받아온다"라는 운영 행위**에 그었기 때문입니다. 규칙 분석기도 같습니다. MySQL의 `access_type=ALL`이 하던 역할을 MongoDB에서는 `COLLSCAN` 스테이지가 합니다. 신호 문자열만 다르지 "인덱스 없이 전부 훑는다"는 판정은 같습니다.

한 가지 성질 차이는 문서에 박아뒀습니다. 다른 기종의 통계는 서버 기동 이후 무한 누적 카운터인데, `system.profile`은 **capped collection**이라 가득 차면 오래된 기록을 덮어씁니다. 합계가 줄어들 수 있다는 뜻인데, 시점 비교가 카운터 리셋 대비로 이미 갖고 있던 음수 클램프가 이 경우도 흡수합니다. 설계 때 넣은 방어가 예상 못 한 기종에서 제값을 한 순간이었습니다.

## 2. 같은 "FULL 백업"이 네 갈래로 갈리고, stdin의 함정까지

2편에서 백업이 세 갈래로 갈라진다고 했는데, 다섯 기종이 되니 실행 모델이 네 가지가 됐습니다.

| 모델 | 기종 | 비밀번호 전달 |
|---|---|---|
| 외부 CLI + 환경변수 | MySQL(mysqldump), PostgreSQL(pg_dump) | `MYSQL_PWD` / `PGPASSWORD` |
| 외부 CLI + stdin | MongoDB(mongodump) | `--config /dev/stdin` |
| 서버 사이드 SQL | SQL Server | 필요 없음 (`BACKUP DATABASE`) |
| 서버 사이드 API | Oracle | 필요 없음 (`DBMS_DATAPUMP` PL/SQL) |

mongodump가 재미있는 경우입니다. 비밀번호 환경변수가 아예 없어서, argv에 싣지 않으려면(ps에 노출되니까) `--config` 파일로 줘야 하는데 임시 파일은 만들기 싫었습니다. `--config /dev/stdin`으로 표준입력에 `password: ...` 한 줄을 흘렸습니다.

그런데 푸시 직후 자동 보안 리뷰가 이 지점을 찔렀습니다. **stdin에 값을 그대로 이어붙이면, 비밀번호에 개행이 들어올 때 YAML의 다른 설정 키를 주입할 수 있다**는 겁니다. `x\nuri: mongodb://공격자서버` 같은 값이면 덤프가 다른 곳으로 갈 수도 있었습니다. 등록자가 관리자라 실현 가능성은 낮지만 관리 플랫폼은 심층 방어가 기본입니다. 제어 문자를 거부하고 YAML 작은따옴표 스칼라로 감싸는(`'` → `''`) 이스케이프를 넣은 뒤, 주입 시도가 거부되는 것을 테스트로 고정했습니다.

Oracle은 반대쪽 극단입니다. expdp CLI 대신 `DBMS_DATAPUMP` PL/SQL API로 **서버가 직접** 덤프를 씁니다. CLI 미설치 환경 제약과 비밀번호 노출 문제가 동시에 사라집니다. SQL Server의 `BACKUP DATABASE`와 같은 "서버 사이드" 모델인데, SQL 한 문장이냐 API 패키지냐만 다릅니다.

## 3. 예상 못 한 곳에서 등록을 막은 Hibernate CHECK 제약

코드를 다 붙이고 MongoDB 인스턴스를 등록하는데 500이 떨어졌습니다.

```
ERROR: new row for relation "database_instance"
       violates check constraint "database_instance_type_check"
```

원인은 코드가 아니라 **메타데이터 DB에 남아 있던 과거**였습니다. Hibernate가 처음 테이블을 만들 때 enum 컬럼에 `CHECK (type IN ('MYSQL','POSTGRESQL','MSSQL'))` 제약을 같이 생성해뒀는데, `ddl-auto: update`는 컬럼은 추가해도 **기존 CHECK 제약은 갱신하지 않습니다**. enum에 값을 추가하는 순간, 배포로 끝날 일이 스키마 마이그레이션으로 바뀝니다.

수동 ALTER로 풀었지만 교훈은 명확했습니다. enum을 DDL 제약으로 내려보내는 순간 enum 확장은 코드 배포만으로 끝나지 않는다. Flyway 같은 마이그레이션 도구가 왜 필요한지를 교과서보다 내 프로젝트에서 먼저 만났습니다.

## 4. 결산, 정말 0줄이었나

정직하게 세어보면 이렇습니다.

- **새로 만든 것**: OracleOperator, MongoOperator, MongoClientCache, 그리고 백업 실행 유틸(BackupCommands, 원래 JDBC 골격 안에 있던 것을 비 JDBC 기종이 생기면서 분리)
- **몇 줄 수정**: enum 값 2개, 팩토리 case 2줄, 규칙 분석기 case 2블록, CSS 색 2줄
- **0줄 수정**: 스냅샷 폴러, 시점 비교, 회귀 감지, 웹 콘솔, MCP 서버

등록하고 부하를 걸자 MongoDB의 활동 그래프에 QPS 급증(0 → 10.67)이 그려지고, 시점 비교가 신규 쿼리 2건을 NEW로 잡고, regex 검색이 호출당 20,000 문서를 훑는다는 것(rowsExamined)까지 수치로 나왔습니다. MCP로도 여섯 인스턴스가 그대로 보입니다. 채널도 코어도 새 기종이 온 것을 모릅니다.

![다섯 기종 여섯 인스턴스를 한 화면에 같은 카드와 같은 그래프로 담은 대시보드](/uploads/project/dbtower/dashboard.png)

마무리로 이 산식들이 회귀하지 않게 단위 테스트 31건(시점 비교 차분·경계, 회귀 감지 임계값·쿨다운, 백업 명령 주입 방어, MCP 프로토콜 규약, 5기종 판정 규칙)을 깔고 GitHub Actions CI를 붙였습니다. 테스트가 실 DB 없이 돌도록 인메모리 H2 설정을 분리한 것까지가 확장의 끝입니다.

코드와 실측 기록 전체는 [GitHub](https://github.com/dj258255/dbtower)에 있습니다.

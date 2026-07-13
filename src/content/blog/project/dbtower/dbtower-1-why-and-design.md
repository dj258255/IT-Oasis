---
title: 'DB를 만들어봤으니, 이번에는 DB들을 부리는 플랫폼 DBTower를 설계했습니다'
titleEn: 'Having Built a Database, I Designed DBTower, the Platform That Manages Them'
description: 'MySQL·PostgreSQL·SQL Server처럼 서로 다른 DBMS를 하나의 플랫폼에서 등록·모니터링·백업까지 일괄 관리하는 컨트롤 플레인 DBTower 시리즈 1편. 왜 DB 운영을 자동화하는 플랫폼을 만들기로 했는지, 기종마다 전부 다른 통계 소스(performance_schema·pg_stat_statements·DMV)를 DbmsOperator 인터페이스 하나로 어떻게 묶었는지, 그리고 ''부하 상위 쿼리가 곧 범인이 아니다''라는 문제의식에서 나온 시점 비교 기능의 원리까지, 설계 결정과 그 이유를 기록합니다.'
descriptionEn: 'Part 1 of DBTower, a control plane that registers, monitors, and backs up heterogeneous DBMSs (MySQL, PostgreSQL, SQL Server) in one place. It explains why I decided to build a DB operations automation platform, how per-engine stat sources (performance_schema, pg_stat_statements, DMVs) are unified behind a single DbmsOperator interface, and the principle behind window comparison, born from the insight that the heaviest query is not always the culprit.'
date: 2026-03-17
tags:
  - Java
  - Spring Boot
  - DBRE
  - MySQL
  - PostgreSQL
  - SQL Server
  - Control Plane
category: personal/DBTower
coverImage: /uploads/project/dbtower/cover.svg
draft: false
series: "DBTower"
seriesOrder: 1
---

## 0. 들어가며, DB를 만들었으면 다음은 운영이다

[db-hobby](/blog/project/db-hobby/db-internals-01-storage)에서 관계형 DB를 C로 밑바닥부터 만들어 봤습니다. 페이지·버퍼풀·B+Tree·WAL·MVCC까지 한 겹씩 쌓고 나니, DB가 안에서 어떻게 도는지는 어느 정도 손에 잡혔습니다. 그런데 현업에서 DB를 다루는 분들 이야기를 듣다 보니, 진짜 어려움은 정작 **운영하는 쪽**에 있다는 걸 알게 됐습니다. DBMS는 MySQL·PostgreSQL·SQL Server·Oracle로 여러 종류가 섞여 있고 대수는 수십·수백 대인데, 백업·모니터링·계정 관리 같은 일은 기종마다 구문이 전부 달라서 사람 손을 계속 탄다는 겁니다.

현직 DB 엔지니어인 지인에게 조언을 구했더니 이런 얘기를 해줬습니다. "백업을 예로 들면, DBMS마다 데이터 파일과 로그 파일 구현이 다르고 구문도 다른데, 플랫폼에서 하나의 기능으로 '30분 주기로 백업하고 싶어' 하면 각 DBMS가 알아서 자기 구문으로 백업하게 만드는 것"이라고요. 추상화 수준에서 정책을 설계하고 인터페이스를 상속받아 기종별로 특화 구현하는 일인 셈입니다. 이게 SRE의 DB 버전인 **DBRE**(Database Reliability Engineering)라는 것도 그때 알았습니다. 정형화된 운영 업무를 자동화해서 서비스와 DB가 늘어나도 필요한 사람 손이 선형으로 늘지 않게 만드는 엔지니어링입니다.

마침 당근 SRE 밋업에서 DB팀이 KDMS라는 사내 DB 어드민 플랫폼을 발표한 것을 봤는데, 문제의식이 정확히 같았습니다. DB 이슈가 나면 개발자는 지표가 흩어진 여러 도구를 오가다 결국 DBA에게 문의하게 되고, DBA는 같은 질문에 반복해서 답하게 된다. 그래서 한 곳에서 개발자가 스스로 분석할 수 있게 만들었다고 합니다. 그 축소판을 직접 설계해 보기로 했습니다. 그게 **DBTower**입니다.

## 1. 무엇을 만드나, 곧 관제탑(컨트롤 플레인)

DBTower는 데이터를 저장하는 DB 위에 한 겹 얹혀, **여러 DB를 등록해 두고 감시·진단·운영하는 관리층**입니다. 이런 걸 컨트롤 플레인이라고 부릅니다.

| 기능 | 설명 |
|---|---|
| 이기종 등록 | DB 인스턴스를 등록하면 기종에 맞는 Operator가 자동 연결. 등록 시 실제 접속 검증 |
| 통합 쿼리 통계 | 기종별로 다른 통계 소스를 하나의 API로 묶어 시간 점유율(load%) 기준 랭킹 |
| 시점 비교 | 평소 구간과 문제 구간을 비교해 신규 쿼리·호출량 급증·읽는 행수 폭증을 검출 |
| 실행계획 분석 | EXPLAIN 결과를 기종별 판단 규칙(풀스캔·filesort·Seq Scan 등)으로 자동 지적 |
| 백업 정책 | "30분 주기 전체 백업" 같은 추상 정책을 기종별 구문으로 실행 |
| 통합 모니터링 | Prometheus·Grafana, 복제 상태 통합 뷰 |

스택은 Java 21 + Spring Boot입니다. 관리 대상은 docker compose로 띄운 MySQL 8.4, PostgreSQL 16, SQL Server 2022 세 종입니다.

## 2. 기종별 차이를 인터페이스 뒤로 숨긴 핵심 설계

이 프로젝트의 심장은 `DbmsOperator` 인터페이스 하나입니다. 플랫폼의 모든 기능은 이 여섯 개 연산에만 의존하고, 기종 분기는 팩토리 한 곳에만 존재합니다.

```java
public interface DbmsOperator {
    HealthStatus health();
    List<QueryStat> queryStats(int limit);
    List<SlowQuery> slowQueries(int limit);
    String explain(String sql);
    void backup(BackupPolicy policy);
    ReplicationState replicationState();
}
```

왜 추상화가 필요한지는 실제로 구현해 보면 바로 드러납니다. 같은 "쿼리 통계"인데 기종마다 이렇게 다릅니다.

| | MySQL | PostgreSQL | SQL Server |
|---|---|---|---|
| 통계 소스 | performance_schema digest | pg_stat_statements | dm_exec_query_stats |
| 정규화 방식 | 텍스트 앞 N바이트 | 파싱 결과 기반 | query_hash |
| 함정 | max_digest_length(1024) 넘는 긴 쿼리가 하나로 뭉개짐 | 확장 프리로드 필요, 클러스터 전역이라 dbid 필터 필수 | 플랜 캐시 축출 시 통계 소실 |
| 시간 단위 | 피코초 | 밀리초 | 마이크로초 |

시간 단위만 봐도 피코초·밀리초·마이크로초로 제각각입니다. 이 차이를 각 Operator가 흡수하고, 플랫폼 코드는 "쿼리별 호출수와 누적 시간(ms)"이라는 하나의 모델만 봅니다. 새 DBMS 지원이 구현체 하나 추가로 끝나는지가 이 설계의 성공 기준인데, 실제로 SQL Server 어댑터를 마지막에 붙일 때 플랫폼 코드 수정은 없었습니다.

## 3. 시점 비교, 부하 상위 쿼리가 곧 범인이 아니다

처음엔 "부하 상위 쿼리를 보여주면 되는 것 아닌가" 했는데, 그게 함정이었습니다. 부하 1위 쿼리는 평소에도 1위였을 수 있기 때문입니다. 장애의 진짜 범인은 **새로 유입된 쿼리**거나, **평소 대비 급증한 쿼리**인 경우가 많습니다. 그래서 "평소 구간"과 "문제 구간"을 비교하는 기능이 필요합니다.

원리는 이렇습니다. 각 기종의 쿼리 통계는 서버 기동 이후의 **누적 카운터**입니다. 그래서 주기적으로 스냅샷을 쌓아 두면, 구간 양 끝 스냅샷의 차분이 그 구간 동안 실제로 발생한 양이 됩니다. 구간 길이가 달라도 비교할 수 있게 QPS로 정규화하고 평소 구간에 없던 쿼리는 신규로 표시합니다.

일부러 장애 상황을 만들어 검증해 봤습니다. 평소 구간에는 점조회만 돌리고 문제 구간에는 호출량을 두 배로 올리면서 8,000행 테이블을 풀스캔하는 LIKE 쿼리를 새로 흘렸습니다. 결과는:

```
증감 — 호출 +114% | 평균 레이턴시 +125% | 읽은 행수 +58,428% | 신규 쿼리 1개

- SELECT * FROM users WHERE NAME LIKE ?   <<< 신규 쿼리
  QPS 0 -> 1.0 | rows/call 0 -> 8000      (풀스캔 신호)
- SELECT * FROM users WHERE id = ?
  QPS 6.67 -> 13.33 (+100%)               (호출량 급증 신호)
```

신규 쿼리, 호출량 급증, 호출당 읽는 행수 폭증이라는 세 신호가 전부 잡혔습니다. rows/call은 실행계획 변화나 IN절 파라미터 폭증 같은 문제의 대리 신호인데, 8,000이라는 숫자는 그 테이블 전체 행수와 같으니 풀스캔이라는 뜻입니다.

여기서 함정도 하나 만났습니다. 누적 카운터 차분 방식은 구간 경계가 스냅샷 시각을 포함해야 합니다. 경계를 스냅샷보다 1초만 늦게 잡아도 그 사이 발생량이 전부 이전 스냅샷에 흡수돼서 차분이 0이 됩니다. KDMS가 CPU 그래프를 드래그해서 구간을 고르게 만든 이유를 몸으로 이해했습니다.

![두 구간의 쿼리별 증감률과 신규 쿼리 NEW 뱃지를 보여주는 시점 비교 화면](/uploads/project/dbtower/compare.png)

## 4. 플랫폼으로 플랫폼 자신을 진단하는 도그푸딩

이 프로젝트에서 제일 재미있었던 부분입니다. 플랫폼 자체 데이터(레지스트리·스냅샷)를 PostgreSQL에 저장하는데, 그 PostgreSQL을 **DBTower 자신에게 관리 대상으로 등록**했습니다. 그러면 DBTower의 진단 기능으로 DBTower 자신의 쿼리를 볼 수 있기 때문입니다.

시점 비교가 읽는 스냅샷 테이블을 일부러 인덱스 없이 시작했고, 50만 행을 채운 뒤 DBTower의 explain API로 자기 쿼리를 진단시켰습니다. 자체 분석기가 "Seq Scan 발생, 인덱스를 검토하세요"라고 자기 자신을 지적했고 실행 시간은 21.269ms였습니다. 등치 조건인 instance_id를 선두에 둔 복합 인덱스를 추가하고 같은 API로 재진단하니 "규칙에 걸린 비효율 신호가 없습니다"로 바뀌었고 실행 시간은 0.062ms로 343배 차이였습니다.

이 방식이 좋았던 건, 개선 전후를 측정한 도구가 곧 제가 만든 기능이라는 점입니다. 커넥션 풀 도입(수집 지연 최대 4.0배 개선), 스냅샷 저장의 JDBC 배치 전환(행당 13.8배), MySQL digest 절단 재현 같은 나머지 개선 기록과 함께 전부 실측 로그로 남겨 뒀습니다.

## 5. 다음 편 예고

- 백업 정책 컴포넌트, "30분 주기 백업해줘"가 mysqldump / pg_basebackup / BACKUP DATABASE로 갈라지는 과정
- Prometheus·Grafana 통합과 복제 상태 뷰
- 시점 비교를 사람 손을 거치지 않고 플랫폼이 스스로 돌리게 만드는 쿼리 회귀 자동 감지

코드와 실측 기록 전체는 [GitHub](https://github.com/dj258255/dbtower)에 있습니다.

---
title: '"30분 주기 백업해줘" 한 줄이 세 갈래로 갈라지는 현실을 추상화로 받아내고, 회귀 감지는 플랫폼에 맡겼습니다'
titleEn: 'Absorbing How One "Back Up Every 30 Minutes" Splits Three Ways, and Letting the Platform Detect Regressions'
description: '이기종 DBMS 운영 관리 플랫폼 DBTower 2편. 같은 ''백업''이 mysqldump·pg_dump·BACKUP DATABASE로 갈라지는 과정을 DbmsOperator 인터페이스로 흡수한 이야기, 플랫폼이 자기 자신을 관리 대상으로 등록해 병목을 진단·개선한 도그푸딩(Seq Scan 21ms에서 0.06ms), 그리고 시점 비교를 사람이 아니라 플랫폼이 스스로 돌리는 쿼리 회귀 자동 감지와 Discord 알림까지, 만들면서 실제로 겪은 이슈와 수치를 기록합니다.'
descriptionEn: 'Part 2 of DBTower, a heterogeneous DBMS operations platform. It covers how the DbmsOperator interface absorbs the same ''backup'' splitting into mysqldump, pg_dump, and BACKUP DATABASE, dogfooding where the platform registers itself as a target to diagnose and fix its own bottleneck (Seq Scan 21ms to 0.06ms), and query regression detection that runs window comparison automatically with Discord alerts, along with the real issues and numbers hit along the way.'
date: 2026-04-05
tags:
  - Java
  - Spring Boot
  - DBRE
  - Ansible
  - Prometheus
  - Discord
category: personal/DBTower
coverImage: /uploads/project/dbtower/cover.svg
draft: false
series: "DBTower"
seriesOrder: 2
---

## 0. 들어가며, 추상화가 진짜로 값을 하는 순간

[1편](/blog/project/dbtower/dbtower-1-why-and-design)에서 `DbmsOperator` 인터페이스 하나로 기종 차이를 흡수하겠다고 했습니다. 인터페이스를 나눠두는 건 쉽지만, 그게 정말 값을 하는지는 실제 기능을 붙여봐야 압니다. 이번 편은 백업·복제·회귀 감지를 붙이면서 "같은 요청 한 줄이 기종마다 완전히 다른 실행으로 갈라지는" 지점을 직접 만난 기록입니다.

## 1. "30분 주기 백업해줘" 한 줄이 세 갈래로

현직 DB 엔지니어 지인이 준 예시가 그대로 이 기능의 스펙이 됐습니다. "플랫폼에서 하나의 기능으로 30분 주기 백업하고 싶어 하면, 각 DBMS가 알아서 자기 구문으로 백업하게." 사용자는 추상 정책만 정합니다.

```java
public record BackupPolicy(String cron, BackupType type) {
    public enum BackupType { FULL, LOG }
}
```

그런데 이 추상 정책 하나가 실행 단계에서 완전히 다른 모델로 갈라집니다.

| 기종 | 실행 모델 | 방식 |
|---|---|---|
| MySQL | 클라이언트 도구 | `mysqldump --single-transaction` (InnoDB MVCC로 락 없이 일관 스냅샷) |
| PostgreSQL | 클라이언트 도구 | `pg_dump` (비밀번호는 인자가 아니라 `PGPASSWORD` 환경변수) |
| SQL Server | 서버 사이드 SQL | `BACKUP DATABASE ... TO DISK` (외부 도구 없이 서버가 직접 파일 기록) |

MySQL·PostgreSQL은 외부 CLI를 실행하고 SQL Server는 SQL 한 줄이면 서버가 알아서 파일을 씁니다. 실행 모델 자체가 다릅니다. 이걸 각 `Operator`의 `backup()` 구현이 흡수하고 플랫폼 코드는 "백업해라"만 압니다.

## 2. 첫 실행은 2/3이 실패했고 그게 진짜 운영이었다

기능을 붙이고 3종을 한 번에 돌렸더니 SQL Server만 성공하고 둘이 실패했습니다. 그런데 이 실패가 오히려 현업에서 마주치는 이슈 그대로였습니다.

```
MySQL  FAILED: Can't connect to MySQL server on '127.0.0.1:13306'
PG     FAILED: server version: 16.14; pg_dump version: 14.19 — version mismatch
MSSQL  SUCCESS
```

첫째, MySQL은 컨테이너 **안**에서 `mysqldump`를 실행하는데 호스트 관점 주소(`127.0.0.1:13306`)를 넘겼습니다. 컨테이너 안에서는 그 주소가 자기 자신이 아닙니다. 네트워크 관점의 차이입니다. 둘째, PostgreSQL은 호스트의 `pg_dump`가 14인데 서버가 16이라 **버전이 낮으면 거부**당했습니다. DBA라면 한 번쯤 겪는 고전적인 클라이언트-서버 버전 호환 문제입니다.

해결책으로 백업 명령을 플레이스홀더 템플릿으로 바꿨습니다.

```yaml
mysqldump-command: "docker exec -e MYSQL_PWD dbtower-mysql mysqldump -h localhost -P 3306 -u {user} --single-transaction --databases {db}"
pg-dump-command: "docker exec dbtower-postgres pg_dump -U {user} -d {db}"
```

실행 위치(호스트/컨테이너/원격 에이전트)마다 달라지는 접속 관점을 **코드 대신 설정이 흡수**하게 만든 것입니다. 수정 후 3종 전부 성공했습니다(214KB / 165KB / 서버측 bak). 1분 주기 정책을 걸자 폴러가 정확히 1분 간격으로 실행되는 것도 확인했습니다.

여기서 배운 것이 있습니다. 이 방식은 지금은 잘 되지만 운영급으로 가면 결국 **Ansible 같은 구성 관리 도구**로 옮겨야 합니다. 버전 호환·원격 호스트·백업 파일의 원격 저장(R2/S3)은 Ansible playbook이 훨씬 깔끔하게 흡수하기 때문입니다. 지금 구조가 명령 템플릿이라 playbook 호출로 바꾸는 건 설정 교체 수준이라는 점이 다행이었습니다.

## 3. 보안 리뷰가 잡아준 것들

백업 명령에 사용자 입력이 들어가니 자동 보안 리뷰가 몇 가지를 지적했습니다. 흘려듣지 않고 고쳤습니다.

- **인자 주입**: 처음엔 치환한 뒤 공백으로 split 했는데, 값에 공백을 넣으면 인자를 몰래 주입할 수 있습니다. 토큰으로 먼저 나눈 뒤 토큰 안에서만 치환하고, 치환 값은 `[A-Za-z0-9._-]`만 통과시키고 `-`로 시작하는 값(플래그 주입)을 거부하게 했습니다.
- **비밀번호를 argv에서 제거**: `ps`로 프로세스 인자를 보면 비밀번호가 노출되니, `mysqldump`는 `MYSQL_PWD`, `pg_dump`는 `PGPASSWORD` 환경변수로만 전달합니다. `{password}` 플레이스홀더 자체를 금지해서 실수로도 argv에 못 싣게 했습니다.
- **MSSQL 식별자 이스케이프**: `BACKUP DATABASE [name]`에서 DB 이름은 바인딩이 안 되니, `]`를 `]]`로 이스케이프해 대괄호 탈출을 막았습니다.

관리 플랫폼은 대상 DB 권한이 크기 때문에 이런 지점을 짚고 넘어가는 게 중요하다고 느꼈습니다.

## 4. 도그푸딩, 플랫폼으로 플랫폼을 진단하다

이 프로젝트에서 제일 좋아하는 부분입니다. 플랫폼 자체 데이터(레지스트리·스냅샷)를 PostgreSQL에 저장하는데, 그 PostgreSQL을 **DBTower 자신에게 관리 대상으로 등록**했습니다(`dbtower-self`). 그러면 DBTower의 진단 기능으로 DBTower 자신의 쿼리를 볼 수 있습니다.

시점 비교가 읽는 스냅샷 테이블을 일부러 인덱스 없이 시작했고 벤치마크용 합성 데이터 50만 행을 채운 뒤 DBTower의 explain API로 자기 쿼리를 진단시켰습니다. 자체 규칙 분석기가 자기 자신을 이렇게 지적했습니다.

```
findings: ["Seq Scan 발생 — 테이블 전체를 읽고 있습니다. WHERE 조건에 맞는 인덱스를 검토하세요"]
Execution Time: 21.269 ms
```

`instance_id` 등치 + `captured_at` 범위 조건이니 등치 컬럼을 선두에 둔 복합 인덱스를 추가하고 같은 API로 재진단하니 판정이 바뀌었습니다.

```
findings: ["규칙에 걸린 비효율 신호가 없습니다"]
Execution Time: 0.062 ms
```

21.269ms에서 0.062ms로 줄었으니 343배였습니다. 개선 전후를 측정한 도구가 곧 제가 만든 기능이라는 점이 좋았습니다. 이것 말고도 커넥션 풀 도입(수집 지연 최대 4배), 스냅샷 저장의 JDBC 배치 전환(행당 13.8배), MySQL digest 절단 재현 같은 개선을 전부 실측 로그로 남겨 뒀습니다.

수집을 붙이면서 정합성 버그도 하나 잡았습니다. PostgreSQL의 `pg_stat_statements`는 클러스터 전역 뷰라 `dbid` 필터 없이 조회하면 같은 클러스터의 다른 데이터베이스 쿼리까지 섞입니다. `sample`과 `dbtower`가 서로의 쿼리를 보고 있던 걸 발견하고 현재 DB로 필터를 걸었습니다. 이런 건 DB 내부를 알아야 보이는 지점인데, [db-hobby](/blog/project/db-hobby/db-internals-01-storage)에서 저장 계층을 만들어봤던 게 도움이 됐습니다.

![도그푸딩 때 자기 쿼리의 풀스캔을 잡아낸 실행계획 화면](/uploads/project/dbtower/explain.png)

## 5. 시점 비교를 사람이 아니라 플랫폼이 돌리는 회귀 자동 감지

1편의 시점 비교는 사람이 "평소 구간"과 "문제 구간"을 골라야 했습니다. 이걸 자동화하고 싶었습니다. 플랫폼이 주기적으로 "최근 구간 vs 직전 베이스라인 구간"을 스스로 비교해 회귀를 잡는 겁니다. Datadog의 Query Regression Detection을 스냅샷 차분으로 축소해 구현한 셈입니다.

감지 규칙은 네 가지입니다. 신규 쿼리 유입, 호출량 급증(QPS +200%), 레이턴시 회귀(평균 +200%), 읽는 행수 폭증(rows/call +500%)입니다. 마지막 항목은 실행계획 변화나 IN절 파라미터 폭증을 대신 잡아내는 신호입니다. 같은 쿼리로 알림이 반복되지 않게 쿼리별 쿨다운도 뒀습니다.

실제로 유발해 봤습니다. 점조회 베이스라인을 2,249회 돌린 뒤 신규 LIKE 풀스캔과 호출 급증을 주입했더니, 폴러가 자동으로 잡아 알림을 보냈습니다.

```
INFO RegressionDetector: 회귀 감지 알림 instance=local-mysql findings=2
웹훅 발송 실패: 0건
```

## 6. 웹훅도 "이기종"이다

알림을 Discord로 받고 싶었는데, 여기서 재미있는 점이 있었습니다. 웹훅도 이기종이라 URL을 보고 포맷을 고르는 어댑터로 만들면 이 프로젝트의 추상화 철학과 딱 맞습니다.

```java
String payload = webhookUrl.contains("discord.com")
        ? "{\"content\": %s}".formatted(json(message))   // Discord
        : "{\"text\": %s}".formatted(json(message));     // Slack
```

Discord는 `content`, Slack은 `text`를 써서 필드 이름만 다릅니다. URL은 비밀값이라 커밋하지 않고 환경변수(`DBTOWER_WEBHOOK_URL`)로만 주입합니다. 실제로 Discord 웹훅을 걸어 회귀 감지 알림이 채널에 뜨는 것까지 확인했습니다(HTTP 204).

## 7. 판단을 통째로 맡기지 않는 AI 1차 분석

마지막으로 감지된 회귀에 AI 1차 분석을 붙였습니다. 그런데 레퍼런스 사례 발표에서 배운 게 있었습니다. 실행계획을 AI가 자동 분석하되, DB팀의 효율/비효율 판단 기준을 프롬프트에 명시해 둔다는 것이었습니다. 같은 입력에 같은 판정이 나와야 운영 도구로 신뢰할 수 있기 때문입니다.

그래서 `docs/ai-analysis-rules.md`에 정리한 기종별 판단 규칙을 그대로 system 프롬프트로 넣고 "반드시 이 기준에 근거해서만 판정하고 수치를 지어내지 말라"고 못 박았습니다. AI에게 판단을 통째로 맡기지는 않습니다. 사람이 정한 기준 위에서 AI가 1차로 훑게 한 것입니다. Anthropic Java SDK로 붙였고 API 키가 없으면 조용히 비활성화돼서 규칙 기반 알림만 나갑니다. 분석 실패가 알림 자체를 막으면 안 되기 때문입니다.

## 8. 마치며

DbmsOperator 인터페이스 하나가 백업·복제·통계·회귀 감지까지 붙이는 내내 값을 했습니다. 새 기능을 붙일 때마다 "이건 기종마다 어떻게 다른가"를 먼저 묻고 그 차이를 구현체 안으로 밀어 넣으면 플랫폼 코드는 계속 단순하게 유지됐습니다. SQL Server 어댑터를 마지막에 붙일 때 플랫폼 코드 수정이 0이었다는 것이 그 증거입니다.

만들면서 겪은 실패들이 오히려 이 도메인의 진짜 어려움이 어디에 있는지 알려줬습니다. 백업 버전 불일치, digest 절단, 통계 오염 같은 것들입니다. 코드와 실측 기록 전체는 [GitHub](https://github.com/dj258255/dbtower)에 있습니다.

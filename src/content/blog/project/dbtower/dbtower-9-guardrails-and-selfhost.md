---
title: '진단이 부하가 되면 안 된다는 보호장치를 달고, Grafana처럼 셀프호스트로 v1.0.0을 찍었습니다'
titleEn: 'Guardrails So Diagnosis Never Becomes the Load, and a v1.0.0 Shipped Self-Hosted Like Grafana'
description: '이기종 DBMS 운영 관리 플랫폼 DBTower 마지막 9편. 마지막으로 꼭 필요하다고 생각한 기능은 겸손한 것이었습니다. 진단 도구가 대상 DB의 부하 유발자가 되지 않게 하는 보호장치입니다. 모든 JDBC 조회가 상속하는 단일 지점 쿼리 타임아웃, MongoDB에서 CSOT 대신 소켓 상한을 택한 이유, 죽은 인스턴스를 매 틱 두드리는 것 자체가 부하라서 넣은 지수 백오프(건너뛸틱 1→2 라이브 관측)까지 담았습니다. 그리고 ''이걸 누구에게 어떻게 줄 것인가''라는 질문에는 자격증명 수탁·사설망·멀티테넌시·비용이라는 SaaS의 네 벽을 피해 Grafana/PMM처럼 셀프호스트로 가기로 답했습니다. 백업 CLI를 번들한 배터리 포함 이미지(자신이 겪은 pg_dump 버전 스큐를 이미지에서 해결), docker compose 원커맨드, 태그가 곧 게시인 GHCR 릴리스로 v1.0.0을 찍은 기록입니다.'
descriptionEn: 'The final part 10 of DBTower. The last feature the tool truly needed was not flashy but humble: guardrails so the diagnostic tool never becomes the load on its targets. That means a single-point query timeout inherited by every JDBC read, a socket read cap chosen over CSOT for MongoDB, and exponential backoff for dead instances (skip-ticks 1 to 2 observed live), because re-knocking a dead DB every tick is itself load. Then comes the question of how to hand this to people. Avoiding SaaS''s four walls (credential custody, private networks, multi-tenancy, cost), the project goes self-hosted like Grafana/PMM, with a batteries-included image bundling backup CLIs (fixing the pg_dump version skew the project itself once hit), a one-command docker compose, and a GHCR release where pushing a tag is the release, landing at v1.0.0.'
date: 2026-07-05
tags:
  - Java
  - Spring Boot
  - DBRE
  - Docker
  - GitHub Actions
  - Self-hosted
category: personal/DBTower
coverImage: /uploads/project/dbtower/cover.svg
draft: false
series: "DBTower"
seriesOrder: 9
---

## 0. 들어가며, 마지막 항목은 화려하지 않다

[8편](/blog/project/dbtower/dbtower-8-diagnosis)을 끝내니 미뤄둔 기능이 딱 하나 남았습니다. **분석 보호장치**, 진단 도구가 대상 DB의 부하 유발자가 되지 않게 하는 장치입니다. 이상 감지나 심층 진단과는 결이 다른, "진단 도구가 대상 DB에 부하를 주지 않게 하라"는 겸손한 항목입니다.

8편 마지막 문장이 정확히 이 항목을 가리켰습니다. "실제 실행은 읽기여도 부하다." D9만의 얘기가 아닙니다. DBTower는 1분마다 대상 DB들의 통계를 읽고, 요청마다 세션과 Wait Event를 조회합니다. 관제 도구가 관제 대상을 느리게 만들면 본말전도입니다. 이번 편은 그 마지막 항목을 닫고 **"이걸 누구에게 어떻게 줄 것인가"**라는 질문에 답하며 v1.0.0을 찍는 기록입니다.

## 1. 보호장치 하나, 타임아웃은 단일 지점에

D9는 만들 때부터 타임아웃이 있었지만 정작 **평범한 조회들**(query-stats·wait-events·sessions)엔 상한이 없었습니다. 시스템 뷰 조회야 가볍지만, 대상 DB가 힘든 순간엔 가벼운 쿼리도 오래 붙잡힙니다. 그때 진단 도구까지 커넥션을 물고 늘어지면 안 됩니다.

메서드 수십 개에 하나씩 심는 대신 구조를 이용했습니다. 6편의 정리 아크에서 Operator의 모든 JDBC 조회를 `jdbc()` 헬퍼 하나로 모아뒀기 때문입니다. 그 **한 곳**에 `setQueryTimeout`을 걸면 끝입니다.

```java
protected JdbcTemplate jdbc() {
    JdbcTemplate t = new JdbcTemplate(pools.getDataSource(instance, jdbcUrl()));
    t.setQueryTimeout(pools.queryTimeoutSeconds());  // 모든 JDBC 조회가 상속
    return t;
}
```

설정은 `dbtower.query-timeout-seconds`(기본 15초) 하나입니다. Datadog DBM 같은 상용 모니터링도 수집 쿼리에 statement timeout을 거는 것과 같은 원칙입니다. 개별 기능(D9의 explain 실행 등)은 더 짧은 명시적 타임아웃으로 덮어씁니다.

MongoDB는 갈래가 달랐습니다. 드라이버에 CSOT(클라이언트 전역 operation timeout)라는 정석이 있지만 **일부러 안 썼습니다.** CSOT를 켜면 드라이버가 D9가 명령에 직접 실은 `maxTimeMS`를 무시하고 자기 예산으로 재계산하기 때문입니다. 전역 안전장치가 정밀 안전장치를 덮어쓰는 간섭입니다. 대신 같은 설정값을 소켓 read 상한에 걸고, 무거운 실행 경로는 기존 `maxTimeMS`(서버 측 상한)를 유지했습니다. 이유는 코드 주석에 남겼습니다. 나중에 누가 "왜 정석을 안 썼지?"라며 CSOT로 바꾸면 D9가 조용히 망가지기 때문입니다.

## 2. 보호장치 둘, 죽은 DB를 계속 두드리는 것도 부하다

두 번째는 수집 폴러입니다. 대상 인스턴스가 죽으면 스냅샷 수집이 실패하는데, 기존 코드는 **다음 틱에 또 두드립니다.** 실패한 접속 시도도 공짜가 아닙니다. TCP 연결, 인증 핸드셰이크, 타임아웃 대기가 다 따라붙습니다. 죽어가는 DB엔 이것도 부하고, 완전히 죽은 DB엔 무의미한 낭비입니다.

그래서 인스턴스별 지수 백오프를 넣었습니다. 연속 실패하면 건너뛸 틱을 1, 2, 4, 8, 16(상한)으로 늘리고 **한 번 성공하면 즉시 정상 주기로 복귀**합니다. 회복한 DB를 벌주지 않는 게 포인트입니다. 한 인스턴스의 백오프가 나머지 수집을 막지 않는 격리는 그대로 유지했습니다.

닿지 않는 포트로 죽은 인스턴스를 등록해 라이브로 관측했습니다:

```
22:13:00  수집 실패 instance=a9-dead-canary ... 다음_건너뛸틱=1
22:13:56  (틱 — canary 건너뜀, 나머지 6개는 정상 수집)
22:14:54  수집 실패 instance=a9-dead-canary ... 다음_건너뛸틱=2
```

실패 로그 사이 간격이 정상 틱의 두 배로 벌어졌습니다. 한 틱을 통째로 쉬고 재시도한 뒤 백오프가 2로 자란 것입니다. 지수 수열과 즉시 복귀는 단위 테스트 4건으로 고정했습니다. 이걸로 만들려 적어둔 기능이 전부 닫혔습니다.

## 3. SaaS의 네 벽, 그래서 셀프호스트

기능이 끝났으니 배포의 질문이 남습니다. 처음엔 웹에 올려 사람들이 그냥 써보게 하고 싶었습니다. 그런데 이걸 SaaS로 만들려 하면 네 개의 벽에 부딪힙니다.

1. **자격증명 수탁**. 사용자가 자기 DB의 접속 정보를 남의 서버에 맡겨야 합니다. 관리 도구가 요구하기엔 너무 큰 신뢰입니다
2. **사설망 도달**. 진짜 운영 DB는 공인 IP가 없습니다. SaaS가 닿으려면 터널이나 에이전트가 필요한데, 그 순간 "간단히 써보세요"가 무너집니다
3. **멀티테넌시**. 테넌트 격리와 과금, 남의 쿼리 텍스트(민감 정보) 보관 책임이 따라옵니다
4. **비용**. 상시 서버와 저장소는 제가 부담해야 합니다

그런데 이 넷은 전부 **도구가 사용자 인프라 안으로 들어가면 사라집니다.** 자격증명은 사용자 네트워크를 안 떠나고, 사설망 안이니 도달 문제가 없고, 테넌트는 하나고, 서버는 사용자 것. Grafana, Percona PMM, pganalyze 셀프호스트판이 전부 이 모델인 이유입니다. DBTower도 **자기 인프라에 띄우고 자기 DB를 붙이는 도구**로 이 길을 따릅니다.

![자격증명·쿼리 텍스트·백업이 사용자 인프라 경계를 넘지 않는 셀프호스트 구조](/uploads/project/dbtower/selfhost-architecture.svg)

## 4. 배터리 포함, 백업이 조용히 실패하지 않게

셀프호스트의 최소 단위는 컨테이너 이미지입니다. 멀티스테이지 Dockerfile로 빌드 스테이지에서 jar를 만들고(`clean bootJar`를 쓴 건 `build`를 부르면 실행 불가능한 `-plain.jar`가 같이 생겨 COPY가 모호해지기 때문입니다), 런타임은 JRE + 비루트 사용자 + actuator 헬스체크로 구성했습니다.

고민은 이미지 구성이었습니다. DBTower의 백업/복원은 mysqldump·pg_dump·mongodump로 shell-out하는데(2편), 이 바이너리가 이미지에 없으면 **셀프호스트 사용자의 백업이 조용히 실패합니다.** 이미지가 ~250MB 커지지만 "정직하게 동작하는 제품"이 되려면 클라이언트를 번들해야 한다고 판단했습니다(배터리 포함, 최종 751MB). 반대로 SQL Server는 서버 사이드 T-SQL이라 클라이언트가 필요 없고, Oracle 백업은 UNSUPPORTED입니다. 그 둘의 CLI는 **안 넣었습니다.** 필요 근거가 있는 것만 담습니다.

pg_dump엔 각주가 붙습니다. 로컬 개발 때 직접 밟은 문제인데, 호스트의 pg_dump(14)가 서버(16)보다 낮아 백업이 안 됐습니다. pg_dump는 서버 이상 버전이어야 합니다. 그래서 이미지엔 배포판 기본 패키지 대신 PGDG 저장소의 postgresql-client-16을 넣었습니다. **자신이 겪은 함정을 사용자가 못 밟게 이미지 차원에서 제거**한 것입니다.

명령 형태도 갈라야 했습니다. 로컬 개발의 백업 명령은 `docker exec`로 형제 컨테이너의 바이너리를 빌려 썼는데, 컨테이너로 배포되면 대상이 형제에서 사용자의 원격 DB로 바뀝니다. `docker` 프로파일(application-docker.yml)이 백업 명령을 "번들된 클라이언트로 대상에 직접 네트워크 접속"으로 덮어쓰고 로컬 설정은 그대로 둡니다.

## 5. 원커맨드와 릴리스, 태그가 곧 게시

사용자 경험은 Grafana를 기준으로 잡았습니다. `.env.example`를 복사해 채우고, 한 줄:

```bash
docker compose -f docker-compose.app.yml up -d   # 앱 + 전용 메타 DB
```

meta-db가 pg_isready로 Healthy가 된 뒤 앱이 뜨고, Flyway가 새 메타 DB에 스키마를 깔고, 관리자 계정이 부트스트랩됩니다(5편의 fail-closed 원칙 그대로, 기본 비밀번호를 하드코딩하지 않고 환경변수나 랜덤으로 생성합니다). 실측으로 빈 볼륨에서 health 200까지, 컨테이너 안에서 mysqldump 8.0.46 / pg_dump 16.14 / mongodump 100.17.0이 실제로 실행되는 것까지 확인했습니다.

게시는 GitHub Actions로 합니다. `v1.0.0` 태그를 push하면 테스트 게이트를 통과한 뒤 GHCR에 이미지가 올라갑니다(semver 태그 자동 파생). 사람이 하는 일은 태그 하나입니다.

## 6. 마치며, 9편을 하나의 매듭으로

버전을 1.0.0으로 올리며 시리즈도 여기서 접습니다. 1편의 문제 정의에서 시작해 추상화(2편), 채널(3편), 5기종 증명(4편), 운영 안전(5편), 적재적소(6편), 프로비저닝(7편), 자율 진단(8편), 심층 원인(8편), 보호장치와 제품화(9편)까지 왔습니다. 필요하다 생각한 기능은 전부 닫혔고, 남은 건 의도적 잔여(쿨다운 설정 외부화, Vault 동적 계정, 백업 원격 보관)로 문서에 정직하게 적어뒀습니다.

돌아보면 마지막 두 작업이 이 프로젝트의 성격을 제일 잘 보여줍니다. 마지막에 추가한 기능이 "내가 남에게 부하가 되지 않게 하는 장치"였고, 제품화의 첫 결정이 "사용자의 비밀은 사용자의 인프라를 떠나지 않는다"였습니다. 관제 도구는 힘이 세지는 쪽보다 **믿을 수 있게 되는 방향**으로 완성됩니다. 열 편을 관통한 결론입니다.

코드와 실측 기록 전체는 [GitHub](https://github.com/dj258255/dbtower)에 있습니다. 셀프호스트로 직접 띄워보실 수 있습니다.

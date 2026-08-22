---
title: '자동 배포를 만들었는데 스키마를 바꿀 수가 없었습니다'
description: >-
  GitLab CI를 GitHub Actions로 옮기고 OCI ARM64 서버에 자동 배포를 붙였습니다.
  그리고 다음 작업에서 컬럼 하나를 추가하려다 막혔습니다. ddl-auto는 테스트 프로필에만
  있었고 마이그레이션 도구는 없었습니다. Flyway를 baseline-on-migrate로 도입하고
  Testcontainers로 실제 MySQL에서 검증한 과정입니다.
date: 2026-08-22
tags:
  - EduMeet
  - GitHub Actions
  - Docker
  - OCI
  - Flyway
  - Testcontainers
  - DevOps
category: team/EduMeet
coverImage: /uploads/project/EduMeet/EduMeetTitle.png
draft: false
series: "EduMeet"
seriesOrder: 3
---

팀 프로젝트 때는 GitLab CI를 썼습니다. 개인 리팩토링으로 넘어오면서 GitHub Actions로 옮기고, 제가 가진 **OCI Ampere A1 (aarch64, 2 OCPU / 12GB)** 에 자동 배포를 붙였습니다.

## ARM64를 QEMU로 빌드하지 않습니다

첫 번째 선택지는 x86 러너에서 QEMU로 ARM64 이미지를 크로스 빌드하는 것이었습니다. 흔한 방법이지만 **에뮬레이션이라 빌드가 몇 배 느립니다.**

GitHub가 **`ubuntu-24.04-arm` 네이티브 ARM64 러너**를 제공하고, 퍼블릭 저장소에서는 무료입니다.

```yaml
runs-on: ubuntu-24.04-arm
```

한 줄로 끝났습니다. 배포 대상이 ARM이니 **빌드도 ARM에서 하는 게 자연스럽습니다.** 에뮬레이션 계층이 사라지면 "로컬에서는 되는데 서버에서 안 되는" 아키텍처 관련 문제도 같이 사라집니다.

## Dockerfile에서 고친 것

기존 이미지는 `openjdk`를 쓰고 있었습니다. **이 이미지는 2022년에 deprecated 됐습니다.** 후속인 Eclipse Temurin으로 바꾸고, 런타임에는 JDK가 필요 없으니 JRE 이미지를 썼습니다.

그리고 하나 더:

```dockerfile
ENV JAVA_OPTS="-XX:MaxRAMPercentage=70 -XX:+ExitOnOutOfMemoryError"
```

**이게 없으면 JVM이 컨테이너 제한이 아니라 호스트 메모리를 보고 힙을 잡습니다.** 12GB 호스트에서 컨테이너에 2GB를 줘도 JVM은 3GB를 잡으려 하고, 그러면 컨테이너가 OOMKilled 됩니다. 로그에는 아무것도 안 남고 컨테이너만 조용히 죽습니다.

## docker-compose에서 발견한 것

기존 compose는 MySQL과 Redis를 이렇게 열고 있었습니다.

```yaml
ports:
  - "3306:3306"
  - "6379:6379"
```

로컬 개발에서는 편합니다. 그런데 **공인 IP가 붙은 서버에서 이러면 인터넷 전체에 DB가 노출됩니다.**

같은 compose 네트워크 안에서는 서비스명으로 접근되므로 포트를 호스트에 공개할 이유가 없습니다.

```yaml
expose:
  - "3306"      # 컨테이너 네트워크 안에서만
```

그리고 `depends_on`도 고쳤습니다.

```yaml
depends_on:
  mysql:
    condition: service_healthy
```

`condition` 없이 `depends_on`만 쓰면 **MySQL 프로세스가 뜬 순간 앱이 시작합니다.** MySQL이 아직 초기화 중이면 앱은 커넥션 실패로 죽습니다. 재시작 정책 때문에 결국은 뜨지만, 로그에는 이유 없는 실패가 몇 번 남습니다.

## 그리고 다음 작업에서 막혔습니다

배포 파이프라인을 머지하고, 다음 작업에서 `meeting` 테이블에 컬럼 두 개를 추가하려 했습니다. 그리고 **추가할 방법이 없다는 걸 알았습니다.**

```
$ grep -rn "ddl-auto" src/main/resources/
application-test.yml:  ddl-auto: create-drop
application-perf.yml:  ddl-auto: create
```

운영 프로필에는 없었습니다. 그리고 `ddl-auto`의 기본값은 DB 종류에 따라 갈립니다. **임베디드 DB(H2 등)면 `create-drop`, 그 외에는 `none`입니다.** MySQL이니 운영에서 Hibernate는 테이블을 만들지도 고치지도 않습니다.

Flyway도 Liquibase도 없었습니다. **스키마 변경 경로가 존재하지 않았습니다.**

지금까지 문제가 안 됐던 이유는 단순합니다 — **스키마를 바꾼 적이 없었습니다.**

그리고 이건 제가 방금 만든 자동 배포의 구멍이기도 합니다. push하면 새 이미지가 뜨는데, 컬럼이 없으면 런타임에 죽습니다. 헬스체크가 감지는 하지만 **막는 게 아니라 롤백만 시킵니다.**

> `application-prod.yml` 자체가 없다는 것도 이때 알았습니다. Dockerfile은 `SPRING_PROFILES_ACTIVE=prod`를 켜는데 해당 파일이 없었습니다. 에러는 아니지만(프로필 파일은 선택) **운영 전용 설정을 둘 곳이 없었습니다.**

## baseline은 손으로 쓰지 않습니다

Flyway를 넣기로 하고 첫 번째 문제를 만났습니다. **운영 DB에는 이미 18개 테이블이 있습니다.** V1에 무엇을 써야 하나?

운영 DB를 직접 볼 수 없는 상태에서 스키마를 SQL로 역생성하는 건 위험합니다. 대신 **엔티티에서 DDL을 뽑았습니다.**

```java
@TestPropertySource(properties = {
    "spring.jpa.properties.jakarta.persistence.schema-generation.scripts.action=create",
    "spring.jpa.properties.jakarta.persistence.schema-generation.scripts.create-target=build/schema-mysql.sql",
    "spring.jpa.properties.hibernate.dialect=org.hibernate.dialect.MySQLDialect"
})
class SchemaExportTest { @Test void export() { } }
```

컨텍스트를 띄우기만 하면 Hibernate가 DDL 파일을 씁니다. 18개 테이블, FK 20개가 나왔습니다. **손으로 쓴 baseline은 반드시 실제와 어긋납니다.**

그리고 `baseline-on-migrate`를 씁니다.

| DB 상태 | Flyway 동작 |
|---|---|
| 기존 운영 DB (스키마 있음, 이력 테이블 없음) | V1을 **실행하지 않고** V1로 표시만 |
| 빈 DB (신규 개발자) | V1부터 **실제로 실행** |

이 파일은 "운영 스키마의 사본"이 아니라 **"엔티티가 기대하는 스키마"** 입니다. 둘이 다르면 V2 이후 마이그레이션에서 드러납니다.

## 검증은 진짜 MySQL에서 합니다

테스트 프로필은 H2를 씁니다. 그런데 baseline에는 이런 게 들어 있습니다.

```sql
session_type enum ('BROADCAST','INTERACTIVE') not null
) engine=InnoDB;
```

**H2의 MySQL 호환 모드로도 이건 깨집니다.** 그래서 Testcontainers로 진짜 MySQL 8.0을 띄웠습니다.

```java
@Container
static final MySQLContainer<?> MYSQL = new MySQLContainer<>("mysql:8.0");
```

이 테스트가 없으면 *"마이그레이션을 넣었다"* 는 주장은 **배포 시점에야 검증됩니다.** CI에서 ARM64 러너로도 통과하는 걸 확인했습니다.

## 브리틀한 단언이 바로 걸렸습니다

첫 버전에 이렇게 썼습니다.

```java
assertThat(meetingColumns).isEqualTo(8);
```

그리고 다음 작업에서 V2로 컬럼 두 개를 추가하자마자 깨졌습니다. **개수를 세는 단언은 마이그레이션이 추가될 때마다 깨집니다.**

```java
assertThat(columnsOf("meeting"))
        .contains("summary_md_url", "summary_pdf_url");
```

개수가 아니라 **"엔티티가 요구하는 컬럼이 있는가"** 를 보게 바꿨습니다. 테스트가 깨진 게 나쁜 일은 아니었습니다 — **스키마가 바뀌었다는 걸 정확히 알려줬으니까요.** 다만 알려주는 방식이 잘못돼 있었습니다.

## 정리

배포 자동화를 먼저 만들고 스키마 관리를 나중에 발견한 순서가 좋았다고는 못 하겠습니다. 다만 **"자동 배포와 수동 스키마 관리는 공존할 수 없다"는 걸 실제로 막혀보고 알았습니다.**

파이프라인은 코드를 바꿀 수 있게 해줬지만, 그 코드가 요구하는 스키마를 바꿀 수단이 없으면 반쪽입니다.

---

- CI/CD 구조: [`docs/ops/01-cicd-and-deploy.md`](https://github.com/dj258255/edumeet/blob/master/docs/ops/01-cicd-and-deploy.md)
- PR: [#26 CI/CD](https://github.com/dj258255/edumeet/pull/26) · [#30 Flyway](https://github.com/dj258255/edumeet/pull/30)

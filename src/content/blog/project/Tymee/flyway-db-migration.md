---
title: 'Flyway로 DB 형상 관리하기'
description: JPA ddl-auto의 위험성, Flyway와 Liquibase 비교, 환경별 마이그레이션 전략, 체크섬 오류 해결법을 정리한다.
date: 2025-11-25T00:00:00.000Z
tags:
  - Flyway
  - Database Migration
  - JPA
  - Spring Boot
  - Schema Management
category: personal/Tymee
draft: false
coverImage: "/uploads/project/Tymee/flyway-db-migration/gradle-version-catalog.svg"
series: "Tymee"
---

> 데이터베이스 스키마 변경을 코드처럼 버전 관리하는 방법

## JPA 자동 생성 vs 마이그레이션 도구

### ddl-auto의 편리함과 위험

JPA의 `ddl-auto=update`는 개발 초기에 매우 편리합니다. 엔티티만 수정하면 스키마가 자동으로 변경됩니다.

하지만 [JetBrains 블로그](https://blog.jetbrains.com/idea/2024/11/how-to-use-flyway-for-database-migrations-in-spring-boot-applications/)에서 지적하듯:

> "Automatically updating the database schema based on JPA entity changes is risky and error-prone, especially in production environments. Instead, it is recommended to use a database migration tool like Flyway."

**ddl-auto=update의 숨겨진 동작:**
- 컬럼 이름을 변경하면? -> 기존 컬럼은 그대로, 새 컬럼만 추가됨
- 컬럼을 삭제하면? -> JPA는 절대 컬럼을 삭제하지 않음
- NOT NULL을 추가하면? -> 기존 데이터가 NULL이면 실패

이런 동작들이 개발 환경에서는 "그냥 DB 초기화하면 되지"로 넘어가지만, 운영 환경에서는 장애로 이어집니다.

### 그렇다면 항상 마이그레이션 도구를 써야 할까?

아닙니다. 프로젝트 단계에 따라 다릅니다.

| 단계                      | ddl-auto     | 마이그레이션 도구 |
|---------------------------|--------------|-------------------|
| 프로토타이핑/PoC          | 적합         | 오버헤드          |
| 초기 개발 (스키마 불안정) | 편리함       | 잦은 변경 부담    |
| 베타 테스트               | 위험 시작    | 권장              |
| 프로덕션 운영             | 위험         | 필수              |

---

## Flyway와 Liquibase

Flyway와 Liquibase를 비교했습니다. Flyway는 SQL 파일만 작성하면 되고 Spring Boot가 기본 auto-configuration을 제공해서 학습 곡선이 낮습니다. Liquibase는 XML/YAML로 DB 독립적 마이그레이션을 작성할 수 있고 무료 롤백 기능을 지원하지만, 별도 문법을 배워야 합니다. 단일 DB(MySQL)만 쓰고 롤백보다 새 마이그레이션으로 수정하는 방식을 선호해서 Flyway를 선택했습니다.

---

## 의존성 설정

**gradle/libs.versions.toml**

![gradle-version-catalog](/uploads/project/Tymee/flyway-db-migration/gradle-version-catalog.svg)


**bootstrap/build.gradle.kts**

![build-gradle-flyway](/uploads/project/Tymee/flyway-db-migration/build-gradle-flyway.svg)


---

## application.yml 설정

![application-yml-flyway](/uploads/project/Tymee/flyway-db-migration/application-yml-flyway.svg)


### 설정 옵션별 상황

| 옵션                  | 활성화 시                             | 비활성화 시                     |
|-----------------------|---------------------------------------|--------------------------------|
| `baseline-on-migrate` | 기존 DB에 Flyway 즉시 적용 가능       | 깨끗한 DB에서만 시작 가능      |
| `validate-on-migrate` | 불일치 감지, 안전함                   | 빠른 시작, 불일치 놓칠 수 있음 |
| `out-of-order`        | 브랜치 병합 후 순서 꼬임 허용         | 엄격한 순서 강제               |
| `clean-disabled`      | 실수로 DB 날리는 것 방지              | `flyway clean` 사용 가능       |

---

## 마이그레이션 파일 명명 규칙

### 기본 형식

```
{Prefix}{Version}{Separator}{Description}{Suffix}
```

| 요소        | 설명                    | 예시                |
|-------------|-------------------------|---------------------|
| Prefix      | 마이그레이션 타입       | `V`, `R`, `U`       |
| Version     | 버전 번호               | `1`, `20241230120000` |
| Separator   | 더블 언더스코어 (필수)  | `__`                |
| Description | 설명 (snake_case)       | `create_users_table`|
| Suffix      | 파일 확장자             | `.sql`              |

### 버전 번호 방식 선택

**순차 번호 방식:**
```
V1__create_users_table.sql
V2__add_posts_table.sql
V3__add_comments_table.sql
```
- 단순하고 직관적
- 혼자 개발하거나 소규모 팀에 적합
- 단점: 여러 브랜치에서 동시 작업 시 버전 충돌 가능

**타임스탬프 방식:**
```
V20241230120000__create_users_table.sql
V20241230143052__add_posts_table.sql
V20241231091500__add_comments_table.sql
```
- 버전 충돌 가능성 거의 없음
- 팀 협업에 적합
- 생성 시점을 알 수 있음

### 마이그레이션 타입

| 접두사 | 타입       | 용도                                    | 재실행 여부   |
|--------|------------|-----------------------------------------|---------------|
| `V`    | Versioned  | 테이블 생성, 컬럼 추가 등 스키마 변경   | 한 번만 실행  |
| `R`    | Repeatable | 뷰, 저장 프로시저, 함수 재생성          | 변경 시 재실행|
| `U`    | Undo       | V 마이그레이션 롤백 (유료 버전)         | 롤백 시 실행  |

**Repeatable(R) 사용 시 주의:**
- 매번 DROP 후 CREATE 해야 함 (기존 객체 삭제)
- 체크섬이 변경되면 자동 재실행
- 실행 순서: V 마이그레이션 -> R 마이그레이션 (알파벳순)

---

## flyway_schema_history 테이블

Flyway는 마이그레이션 이력을 `flyway_schema_history` 테이블에 기록합니다.

```sql
SELECT version, description, checksum, success, execution_time
FROM flyway_schema_history;
```

| version | description        | checksum    | success | execution_time |
|---------|--------------------|-------------|---------|----------------|
| 1       | create users table | 1884708740  | true    | 45             |
| 2       | add posts table    | -1560729926 | true    | 32             |

**체크섬의 의미:**
- 마이그레이션 파일 내용의 해시값
- 파일이 수정되면 체크섬 불일치로 에러 발생
- "적용된 마이그레이션은 불변"이라는 원칙을 강제

---

## 체크섬 오류 해결 - 상황별 대응

### 오류 메시지 예시

```
Migration checksum mismatch for migration version 1
-> Applied to database : 1884708740
-> Resolved locally    : -1560729926
```

### 상황 1: 포맷팅만 변경된 경우 (공백, 줄바꿈)

[Redgate 공식 문서](https://www.red-gate.com/hub/product-learning/flyway/flyways-repair-command-explained-simply)에 따르면:

> "The Repair command modifies details recorded in the schema history table to make them consistent with the current set of migration files."

```bash
./gradlew flywayRepair
```

### 상황 2: 실제 SQL이 변경된 경우

**선택지 A: 체크섬 강제 업데이트 (위험)**

![checksum-force-update](/uploads/project/Tymee/flyway-db-migration/checksum-force-update.svg)

**선택지 B: 새 마이그레이션으로 수정 (권장)**

![new-migration-fix](/uploads/project/Tymee/flyway-db-migration/new-migration-fix.svg)


### 상황 3: 실패한 마이그레이션이 남아있는 경우

![failed-migration-cleanup](/uploads/project/Tymee/flyway-db-migration/failed-migration-cleanup.svg)


**주의:** 실패한 마이그레이션이 DB를 부분적으로 변경했을 수 있으므로, 삭제 전 DB 상태 확인 필수

---

## 환경별 전략

| 환경       | ddl-auto     | Flyway   | 이유                                   |
|------------|--------------|----------|----------------------------------------|
| 로컬 개발  | update       | enabled  | 빠른 개발 + 마이그레이션 테스트        |
| 테스트     | create-drop  | disabled | 매 테스트마다 깨끗한 스키마 보장       |
| 스테이징   | validate     | enabled  | 프로덕션과 동일하게, 불일치 감지       |
| 프로덕션   | none         | enabled  | JPA는 스키마 건드리지 않음             |

**로컬에서 `ddl-auto=update`와 Flyway 동시 사용 시:**
- Flyway가 먼저 실행되어 스키마 생성
- JPA가 엔티티와 스키마 비교 후 차이 있으면 수정
- 장점: 마이그레이션 빠뜨려도 개발 진행 가능
- 단점: 마이그레이션 없이 스키마가 변경될 수 있음

---

## 마이그레이션 vs 엔티티, 어느 것이 진실인가?

두 가지 관점이 있습니다.

엔티티 우선(Code First)은 JPA 엔티티가 진실이고 마이그레이션이 이를 따라가는 방식입니다. 마이그레이션 우선(DB First)은 마이그레이션이 진실이고 엔티티가 이를 반영하는 방식으로, DBA가 스키마를 설계하면 개발자가 엔티티를 맞춥니다.

실무에서는 **하이브리드** 방식이 많습니다.
1. 엔티티 먼저 작성
2. `ddl-auto=update`로 개발 환경에서 동작 확인
3. 스키마 변경 사항을 마이그레이션 파일로 수동 작성
4. PR 리뷰 시 엔티티와 마이그레이션 함께 검토

---

## 초기 마이그레이션 예시

**db/migration/V1__create_users_table.sql**

![initial-migration](/uploads/project/Tymee/flyway-db-migration/initial-migration.svg)


---

## 이 프로젝트의 선택

마이그레이션 도구는 Flyway, 버전 번호는 순차 방식(`V1__`, `V2__`)을 선택했습니다. SQL 직접 작성이 직관적이고, Spring Boot 기본 통합을 지원하며, 1인 개발이라 브랜치 충돌이 없어서 순차 번호가 충분합니다. 팀 협업으로 전환되면 타임스탬프 방식을 고려할 예정입니다.

환경별로는 local에서 `ddl-auto=update` + Flyway enabled로 빠른 개발, test에서 `create-drop` + Flyway disabled로 깨끗한 테스트, staging에서 `validate` + Flyway enabled로 불일치 감지, prod에서 `none` + Flyway enabled로 안전하게 운영합니다.

---

## 참고 자료

- [How to Use Flyway for Database Migrations in Spring Boot - JetBrains](https://blog.jetbrains.com/idea/2024/11/how-to-use-flyway-for-database-migrations-in-spring-boot-applications/)
- [Flyway's Repair Command Explained Simply - Redgate](https://www.red-gate.com/hub/product-learning/flyway/flyways-repair-command-explained-simply)
- [How to troubleshoot common Flyway errors - Makolyte](https://makolyte.com/how-to-troubleshoot-common-flyway-errors/)

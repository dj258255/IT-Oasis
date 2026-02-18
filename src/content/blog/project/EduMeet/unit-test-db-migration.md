---
title: '단위 테스트 DB를 MySQL에서 H2로 전환한 이유'
titleEn: 'Why We Switched Unit Test DB from MySQL to H2'
description: 단위 테스트 환경을 MySQL에서 H2 인메모리로 전환하여 테스트 속도를 45% 개선한 과정과 Spring Profile 분리 전략을 정리한다.
descriptionEn: Documents the process of switching unit test environment from MySQL to H2 in-memory, achieving 45% speed improvement with Spring Profile separation.
date: 2025-08-22T00:00:00.000Z
tags:
  - H2
  - Unit Test
  - MySQL
  - Spring Profile
  - TDD
  - CI/CD
category: project/EduMeet
draft: false
---

## 배경

EduMeet 프로젝트는 단위 테스트에서 MySQL을 사용하고 있었다. EC2 배포를 앞두고 테스트 환경을 점검하면서, MySQL 기반 테스트의 한계가 드러났다.

문제는 단순히 "H2가 더 빠르다"가 아니었다. MySQL 기반 테스트가 개발 생산성 전체에 미치는 부정적 영향이 핵심이었다.

- 테스트 실행 시간이 길어 개발 흐름이 끊김
- CI/CD 파이프라인에서 테스트 단계가 병목
- 느린 테스트 때문에 개발자가 테스트 실행 자체를 회피

---

## H2 Database 개요

H2는 Java로 작성된 오픈소스 RDBMS다. 별도 설치 없이 `build.gradle`과 `application.properties` 설정만으로 실행할 수 있다.

![](/uploads/project/EduMeet/unit-test-db-migration/h2.png)

### 1. 서버 모드 (TCP Server Mode)

독립된 서버 프로세스로 실행하는 모드다. 데이터가 애플리케이션 외부에 저장되며, 종료해도 데이터가 유지된다.

### 2. 인메모리 모드 (In-Memory Mode)

데이터베이스를 메모리에 생성하고, 애플리케이션 종료 시 데이터가 모두 사라지는 모드다. 엔진을 별도 설치하지 않고 애플리케이션 내부에서 실행된다.

### 3. 파일 모드 (Embedded/Persistent File Mode)

인메모리 모드와 동일하게 애플리케이션 내부 엔진을 사용하지만, 데이터를 디스크 파일에 저장하는 모드다.

### H2의 한계

H2는 가볍고 빠른 대신, 대규모 데이터 처리에는 적합하지 않다. 따라서 H2는 **단위 테스트, 프로토타입, 빠른 개발 사이클**에 적합하며, 운영 환경에서는 MySQL이나 PostgreSQL 같은 RDBMS를 사용해야 한다.

---

## MySQL 유지 시나리오 검토

H2 전환을 결정하기 전에, MySQL을 유지하면서 문제를 해결할 수 있는 방안들을 먼저 검토했다.

### 방안 1: 트랜잭션 롤백 방식

각 테스트마다 트랜잭션을 시작하고, 테스트 완료 후 롤백하는 방식이다.

**문제점:** `auto_increment` PK는 롤백해도 초기화되지 않는다. **테스트의 예측 가능성**이 깨진다.

### 방안 2: 별도 테스트 데이터베이스 구축

운영 DB와 완전히 분리된 테스트 전용 MySQL 인스턴스를 사용하는 방식이다.

장점보다 단점의 영향이 컸다. 특히 CI/CD 병목과 인프라 비용은 6주 프로젝트에서 감당하기 어려웠다.

---

## 전환 결정

MySQL 유지 방안들의 한계를 확인한 후, **단위 테스트는 H2 인메모리 모드**, **통합 테스트는 MySQL**로 역할을 분리하기로 결정했다.

핵심 근거:

1. **개발 흐름 보호**: 테스트가 느리면 개발자가 테스트 실행을 회피하게 되고, 테스트 없이 커밋하는 습관이 생긴다.
2. **CI/CD 효율성**: 테스트 단계가 병목이 되면 배포 주기 전체가 느려진다.
3. **TDD 실천 가능성**: 빠른 피드백 사이클이 없으면 TDD를 유지할 수 없다.

---

## 구현: Spring Profile 분리

기존에는 `application.properties` 하나에 MySQL 설정을 몰아넣고 있었다. 이를 프로파일별로 분리했다.

![](/uploads/project/EduMeet/unit-test-db-migration/h2-02.png)

`application.properties`에서 기본 프로파일을 production으로 설정하고, 테스트 환경에서는 H2 프로파일이 활성화되도록 구성했다.

![](/uploads/project/EduMeet/unit-test-db-migration/h2-03.png)

- `application-production.properties`: MySQL 설정
- `application-test.properties`: H2 인메모리 설정

### H2 연결 테스트

![](/uploads/project/EduMeet/unit-test-db-migration/h2-connection-test.png)
![](/uploads/project/EduMeet/unit-test-db-migration/h2-connection-test-02.png)
![](/uploads/project/EduMeet/unit-test-db-migration/h2-connection-test-03.png)
![](/uploads/project/EduMeet/unit-test-db-migration/h2-connection-test-04.png)

### MySQL 연결 테스트

![](/uploads/project/EduMeet/unit-test-db-migration/mysql-connection-test.png)
![](/uploads/project/EduMeet/unit-test-db-migration/mysql-connection-test-02.png)
![](/uploads/project/EduMeet/unit-test-db-migration/mysql-connection-test-03.png)
![](/uploads/project/EduMeet/unit-test-db-migration/mysql-connection-test-04.png)

---

## 속도 비교

H2 인메모리 모드와 MySQL의 단위 테스트 성능을 수치로 비교했다.

H2 테스트 결과:
![](/uploads/project/EduMeet/unit-test-db-migration/speed-diff-comparison.png)

MySQL 테스트 결과:
![](/uploads/project/EduMeet/unit-test-db-migration/speed-diff-comparison-02.png)

### 개별 테스트 성능 비교

| 테스트 | MySQL (ms) | H2 (ms) | 성능 향상률 |
|--------|-----------|---------|-----------|
| 이미지와함께 게시글읽기 | 266.60 | 123.88 | **-53.53%** |
| 게시글리스트 페이징 | 284.89 | 145.32 | **-49.00%** |
| 댓글읽기 | 129.71 | 75.23 | **-42.00%** |
| 게시글읽기 | 125.49 | 70.85 | **-43.53%** |
| 게시글 수정 | 92.41 | 58.33 | **-36.86%** |

### 전체 테스트 소요 시간

| 항목 | MySQL | H2 | 차이 |
|------|-------|-----|------|
| 전체 수행 시간 | 9.57초 | 5.23초 | **-45.34%** |

### 분석

H2 인메모리 모드는 MySQL 대비 개별 테스트 평균 약 47%, 전체 테스트 약 45% 더 빠르게 완료했다. 특히 읽기(read) 위주의 테스트에서 성능 차이가 컸다. 디스크 I/O 없이 메모리에서 직접 처리하는 구조 덕분이다.

![](/uploads/project/EduMeet/unit-test-db-migration/analysis.png)

---

## Reference

- [H2 in-memory DB를 이용한 테스트 DB 전환](https://zzang9ha.tistory.com/415)
- [H2 Database 모드 정리](https://maltyy.tistory.com/19)

<!-- EN -->

## Background

The EduMeet project was using MySQL for unit tests. While preparing for EC2 deployment and reviewing the test environment, the limitations of MySQL-based testing became apparent.

The issue wasn't simply "H2 is faster." The core problem was the negative impact of MySQL-based tests on overall development productivity.

- Long test execution times disrupted development flow
- Test stage became a bottleneck in the CI/CD pipeline
- Developers avoided running tests due to slow speeds

---

## H2 Database Overview

H2 is an open-source RDBMS written in Java. It runs without separate installation — just `build.gradle` and `application.properties` configuration.

![](/uploads/project/EduMeet/unit-test-db-migration/h2.png)

### 1. TCP Server Mode
Runs as an independent server process. Data is stored externally and persists after shutdown.

### 2. In-Memory Mode
Creates the database in memory. All data disappears when the application terminates. Runs internally without separate engine installation.

### 3. Embedded/Persistent File Mode
Uses the same internal engine as in-memory mode but stores data in disk files.

### H2 Limitations

H2 is lightweight and fast but not suitable for large-scale data processing. It's best for **unit tests, prototypes, and rapid development cycles**, while production environments should use MySQL or PostgreSQL.

---

## Evaluating MySQL Retention Options

Before deciding on H2, we first evaluated options to keep MySQL while addressing the issues.

### Option 1: Transaction Rollback

Start a transaction for each test and rollback after completion.

**Problem:** `auto_increment` PKs don't reset on rollback, breaking **test predictability**.

### Option 2: Dedicated Test Database

Use a completely separate MySQL instance for testing.

The downsides outweighed the benefits. CI/CD bottlenecks and infrastructure costs were particularly difficult to manage in a 6-week project.

---

## Decision to Switch

After confirming the limitations of MySQL retention options, we decided to split roles: **H2 in-memory for unit tests**, **MySQL for integration tests**.

Key rationale:

1. **Protect development flow**: Slow tests lead developers to skip testing, creating habits of committing without tests.
2. **CI/CD efficiency**: Test bottlenecks slow down the entire deployment cycle.
3. **TDD viability**: Without fast feedback cycles, TDD cannot be maintained.

---

## Implementation: Spring Profile Separation

Previously, all MySQL settings were in a single `application.properties`. We separated them by profile.

![](/uploads/project/EduMeet/unit-test-db-migration/h2-02.png)

The default profile was set to production in `application.properties`, with H2 profile activated in the test environment.

![](/uploads/project/EduMeet/unit-test-db-migration/h2-03.png)

- `application-production.properties`: MySQL configuration
- `application-test.properties`: H2 in-memory configuration

### H2 Connection Test

![](/uploads/project/EduMeet/unit-test-db-migration/h2-connection-test.png)
![](/uploads/project/EduMeet/unit-test-db-migration/h2-connection-test-02.png)
![](/uploads/project/EduMeet/unit-test-db-migration/h2-connection-test-03.png)
![](/uploads/project/EduMeet/unit-test-db-migration/h2-connection-test-04.png)

### MySQL Connection Test

![](/uploads/project/EduMeet/unit-test-db-migration/mysql-connection-test.png)
![](/uploads/project/EduMeet/unit-test-db-migration/mysql-connection-test-02.png)
![](/uploads/project/EduMeet/unit-test-db-migration/mysql-connection-test-03.png)
![](/uploads/project/EduMeet/unit-test-db-migration/mysql-connection-test-04.png)

---

## Speed Comparison

Numerically compared unit test performance between H2 in-memory and MySQL.

H2 results:
![](/uploads/project/EduMeet/unit-test-db-migration/speed-diff-comparison.png)

MySQL results:
![](/uploads/project/EduMeet/unit-test-db-migration/speed-diff-comparison-02.png)

### Individual Test Performance

| Test | MySQL (ms) | H2 (ms) | Improvement |
|------|-----------|---------|-------------|
| Read post with images | 266.60 | 123.88 | **-53.53%** |
| Post list pagination | 284.89 | 145.32 | **-49.00%** |
| Read comments | 129.71 | 75.23 | **-42.00%** |
| Read post | 125.49 | 70.85 | **-43.53%** |
| Update post | 92.41 | 58.33 | **-36.86%** |

### Total Test Duration

| Metric | MySQL | H2 | Difference |
|--------|-------|-----|------------|
| Total execution time | 9.57s | 5.23s | **-45.34%** |

### Analysis

H2 in-memory mode completed individual tests approximately 47% faster and overall tests approximately 45% faster than MySQL. The performance gap was especially large for read-heavy tests, thanks to the in-memory processing structure that eliminates disk I/O.

![](/uploads/project/EduMeet/unit-test-db-migration/analysis.png)

---

## Reference

- [Switching Test DB Using H2 In-Memory DB](https://zzang9ha.tistory.com/415)
- [H2 Database Mode Summary](https://maltyy.tistory.com/19)

---
title: '범수 — DBMS 플랫폼 엔지니어링 포트폴리오'
description: 'DBMS 운영 관리 플랫폼 직무를 위해 정리한 포트폴리오입니다. 이기종 5기종 관제 플랫폼 DBTower, 관측 데이터 장기 분석 파이프라인 DBTower-lakehouse, 고정길이 전문 연계 게이트웨이 관문, 오픈소스 기여를 실측 수치와 함께 담았습니다.'
date: 2026-07-13T00:00:00.000Z
tags:
  - Portfolio
  - Backend
  - DBRE
  - DBMS
  - Platform Engineering
category: portfolio
coverImage: /uploads/project/dbtower/cover.svg
draft: false
unlisted: true
---

# 범수 — DBMS 플랫폼 엔지니어링 포트폴리오

DBMS 운영 관리 플랫폼을 직접 만들어 공개 배포까지 완주한 백엔드 엔지니어입니다. 모든 수치는 직접 측정했고, 명령과 출력이 담긴 재현 기록이 저장소에 공개되어 있습니다.

| 항목 | 내용 |
|---|---|
| 핵심 프로젝트 | DBTower: 이기종 DBMS 5기종 운영 관리 플랫폼 (개인 100%) |
| 관리 기종 | MySQL, PostgreSQL, SQL Server, Oracle, MongoDB |
| 검증 | 테스트 585건(360+57+168) CI 게이트, 재현 기록 62절 공개 |
| 배포 | GHCR 멀티아치 공개 이미지, compose 원커맨드 셀프호스트 |
| 오픈소스 | Spring Boot 4.1.0-M2 반영, Apache Lucene main 병합 |

## 1. DBTower: 이기종 DBMS 5기종 운영 관리 플랫폼

**저장소**: [github.com/dj258255/dbtower](https://github.com/dj258255/dbtower) · **시리즈 총정리**: [블로그 0편](/blog/project/dbtower/dbtower-0-overview) · **재현 기록**: [VERIFICATION.md 62절](https://github.com/dj258255/dbtower/blob/main/docs/VERIFICATION.md)

![DBTower 아키텍처](/uploads/project/dbtower/architecture-full.svg)

### 왜 만들었나

DB에 이슈가 나면 개발자는 흩어진 도구를 오가다 결국 DBA에게 묻고, DBA는 같은 질문에 반복해서 답합니다. 관리 대상 DB가 늘수록 사람 손이 선형으로 늘어나는 이 구조를 인터페이스 하나로 끊고 싶었습니다. 등록부터 진단, 백업, 자율 감시까지 웹 콘솔 한 화면에서 처리하는 컨트롤 플레인입니다.

### 설계 결정: 경계를 SQL이 아니라 운영 행위에 긋다

다섯 기종은 같은 쿼리 통계를 주는 방식이 전부 다릅니다. 추상화 경계를 통계 조회, 실행계획, 백업 같은 운영 행위에 그었더니 SQL이 없는 MongoDB까지 같은 틀에 들어왔습니다. 성격이 정반대인 Oracle과 MongoDB를 실제로 추가해 검증했고, 수집·비교·회귀 감지·웹·MCP 코어 경로는 수정 0줄이었습니다. 이후 기능 확장도 인터페이스 메서드 1개 추가의 반복이었습니다.

### 진단: 추정과 실제의 괴리로 원인을 지목

인덱스가 있는데 풀스캔을 타는 쿼리는 추정 실행계획만으로 설명되지 않습니다. 실제 실행계획을 얻는 방법이 기종마다 달라 5기종 각각 구현했고, 추정 300행 대 실제 1행이라는 괴리로 암시적 형변환을 지목해 원클릭 재진단으로 수정 전후를 증명했습니다.

![심층 진단 전후 비교](/uploads/project/dbtower/deep-before-after.png)

같은 진단을 플랫폼 자신에게 적용해 자기 풀스캔(50만 행)을 잡았습니다. 인덱스 적용 후 21.269ms에서 0.062ms로 343배 개선됐습니다. Wait Event 분석, 요일과 시간대를 반영한 베이스라인 이상 감지(z-score), 데드락 수집, 헬스 스코어, SLO 에러 버짓까지 운영 시야를 넓혔습니다.

### 운영 안전: 진단이 부하 유발자가 되면 안 된다

- 대상 DB 보호를 위한 인스턴스별 커넥션 풀 상한, 단일 지점 쿼리 타임아웃
- 수집 병목을 원인부터 측정: 커넥션 풀 전환으로 수집 47.1ms에서 11.8ms, JDBC 배치 쓰기로 행당 1.51ms에서 0.11ms
- 백업은 성공 로그가 아니라 복구 검증 3값(성공/실패/미지원)으로 판정, 3-2-1 원칙의 S3 오프사이트
- 계정은 기종별 최소 권한 문서화, 자격 증명은 AES-256-GCM 암호화
- 처리 상한 실측: k6 부하로 2,832 req/s, P95 5.86ms, 실패 0

### 제품화와 자기 검증

GHCR에 멀티아치 공개 이미지로 배포해 compose 한 번이면 뜹니다. v1.0.0 이후 실사용에서 나온 요구로 심화 네 아크(플랜 플립, p95 정직 등급, 데드락, 스케일 제어)를 팠고, 제 코드를 네 가지 관점으로 스스로 감사해 실행 중인 시스템의 진짜 버그(XXE, 단위 오류, 타임존)를 잡아 고쳤습니다. 테스트 360건이 CI 게이트로 돌고 있습니다.

## 2. DBTower-lakehouse: 버려지는 관측 데이터의 장기 분석 파이프라인

**저장소**: [github.com/dj258255/dbtower-lakehouse](https://github.com/dj258255/dbtower-lakehouse) · **시리즈 총정리**: [블로그 0편](/blog/project/lakehouse/lakehouse-0-why)

DBTower의 관측 데이터는 7일 뒤 삭제됩니다. 지난 분기 대비 가장 악화된 쿼리 같은 장기 질문에 답할 수 없어서, 만료 전에 데이터를 내려 장기 분석 자산으로 만드는 파이프라인을 Airflow와 dbt로 구축했습니다.

- 원천, 적재본, 조회 결과의 3자 대조 149,259행 일치를 확인한 뒤에야 변환이 도는 4축 fail-closed 품질 게이트. 장애 주입(20,158행 삭제)으로 다운스트림 차단을 실측
- 실데이터 3일치로는 규모 증명이 안 되어 1년치 5,400만 행을 합성해 측정. 병목이 마트 재빌드 407초 하나임을 확인한 뒤에야 증분 전환으로 4초(약 100배)
- 파일 직결 서빙의 동시성 문제를 재현하고 DB 트랜잭션이 중재하는 DuckLake 구조로 재설계, 발행 중 연속 41회 질의 무중단
- pytest 57건과 dbt 검증 26개가 CI 게이트로 동작

## 3. 관문(gwanmun): 고정길이 전문과 REST 사이의 연계 게이트웨이

**저장소**: [github.com/dj258255/gwanmun](https://github.com/dj258255/gwanmun) · **시리즈 총정리**: [블로그 0편](/blog/project/gwanmun/gwanmun-0-why)

고정길이 전문과 TCP로만 말하는 레거시 계정계와 JSON REST 사이의 통역기입니다. 전문 파서와 프레이밍을 순수 소켓으로 직접 구현하고 서킷브레이커, 멱등키, 3값 원장을 얹었습니다. 게이트웨이 오버헤드 0.21ms, 한계 약 10~12k req/s를 부하로 실측했고 테스트 168건이 CI로 돌고 있습니다.

## 4. 오픈소스 기여

- **spring-projects/spring-boot** [PR #49063](https://github.com/spring-projects/spring-boot/pull/49063): TestEntityManager에 Kotlin reified 확장 함수 추가. 메인테이너 커밋으로 4.1.0-M2 New Features에 기록
- **apache/lucene** [PR #15675](https://github.com/apache/lucene/pull/15675): IndexWriter 초기화 실패 시 스레드 풀 누수 수정. main 병합, CHANGES.txt에 bug fix로 기록

## 5. 일하는 방식

측정할 수 있는 것은 측정하고, 주장에는 재현 기록을 남깁니다. 두 저장소의 VERIFICATION 문서(62절, 12절)에 모든 수치의 명령과 출력이 있어 누구든 같은 기준으로 재검증할 수 있습니다. AI는 실행자로 쓰되 계획 승인과 검증 게이트는 사람이 쥐는 워크플로우로 개발하며, AI 진단 루프에는 읽기 전용 도구 화이트리스트로 권한 경계를 설계했습니다.

## 링크

| 구분 | 주소 |
|---|---|
| GitHub | [github.com/dj258255](https://github.com/dj258255) |
| 기술 블로그 | [dj258255.github.io/IT-Oasis](https://dj258255.github.io/IT-Oasis) |
| DBTower 시리즈 14편 | [총정리 0편](/blog/project/dbtower/dbtower-0-overview) |
| lakehouse 시리즈 7편 | [총정리 0편](/blog/project/lakehouse/lakehouse-0-why) |
| 관문 시리즈 6편 | [총정리 0편](/blog/project/gwanmun/gwanmun-0-why) |

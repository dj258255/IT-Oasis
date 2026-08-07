---
title: '검색엔진이 시스템을 마비시킨 과정과 대응'
description: LIKE 검색이 Full Table Scan으로 1,215만 행을 스캔하며 HikariCP 커넥션 풀을 고갈시켜 시스템을 마비시킨 원인을 분석하고, 긴급 완화 조치로 시스템 안정성을 확보한 과정을 정리한다.
date: 2026-02-01T00:00:00.000Z
tags:
  - MySQL
  - LIKE Search
  - Full Table Scan
  - HikariCP
  - Connection Pool
  - EXPLAIN
category: personal/WikiEngine
draft: false
coverImage: "/uploads/project/WikiEngine/search-system-crash/server-status.png"
series: "WikiEngine"
---

나무위키(57만 건) + 한국어 위키백과(74만 건) + 영어 위키백과(714만 건) + 뉴스(16만 건) + 웹 콘텐츠(354만 건), 총 약 1,215만 건의 데이터를 MySQL에 적재하고 검색 기능을 구현하는 프로젝트입니다.

**기술 스택:** Java 25, Spring Boot 4.0, MySQL 8.0, HikariCP

검색은 가장 단순한 방식인 `LIKE '%keyword%'`로 시작했습니다.
각 단계에서 병목을 직접 측정하고, 해당 기술의 한계가 드러나는 지점에서 다음 기술로 전환하는 방식으로 진행합니다.
단계마다 성능, 구현 복잡도, 운영 비용의 트레이드오프를 비교하여 최적의 전환 시점을 판단하는 것이 이 프로젝트의 핵심입니다.

---

## 1. 정상 상태

검색 API는 제목(`title`)과 본문(`content`)에 대해 `LIKE '%keyword%'` 패턴으로 검색합니다.

```sql
SELECT * FROM posts
WHERE title LIKE '%keyword%' OR content LIKE '%keyword%'
ORDER BY created_at DESC
LIMIT 20 OFFSET 0;
```

이 시점에서는 인덱스가 없고, 테이블에는 약 1,215만 행이 존재합니다.

### 서버 현황

![](/uploads/project/WikiEngine/search-system-crash/server-status.png)

- App Server: ARM 2코어 / 12GB RAM
  - Spring Boot: 컨테이너 2GB / JVM 힙 1GB (`-Xmx1g`)
  - MySQL 8.0: 컨테이너 4GB / InnoDB Buffer Pool 2GB
  - 나머지: Nginx(256MB), Promtail(256MB), cAdvisor(256MB), Exporter 등 → 합계 ~7GB, 나머지 ~5GB는 OS 캐시
- HikariCP 기본 설정 (maximumPoolSize=10)
- 검색 외 다른 API(게시글 목록, 상세 조회 등)는 정상 동작

---

## 2. 문제 발생: 검색 한 번에 시스템 전체가 마비

검색 API를 한 번 호출하자 다음과 같은 현상이 발생했습니다:

1. **검색 API 자체가 응답하지 않음** - 수십 초 이상 대기
2. **다른 API까지 전부 503 응답** - 게시글 목록, 상세 조회 등 전혀 무관한 API도 실패
3. **서버 전체가 사실상 다운 상태**

### 503 응답 확인

![](/uploads/project/WikiEngine/search-system-crash/503-timeout-response.png)

검색과 무관한 API까지 모두 503을 반환하는 것은, 문제가 검색 쿼리 자체가 아니라 **공유 리소스의 고갈**임을 의미합니다.

---

## 3. 원인 분석

### 3-1. Full Table Scan

`LIKE '%keyword%'`는 와일드카드가 앞에 있어 **B-Tree 인덱스를 사용할 수 없습니다**.
MySQL은 1,215만 행 전체를 순차 스캔합니다.

```sql
EXPLAIN SELECT * FROM posts
WHERE title LIKE '%keyword%' OR content LIKE '%keyword%';
```

![](/uploads/project/WikiEngine/search-system-crash/explain-result.png)

- `type: ALL` → Full Table Scan
- `rows: 27,443,742` → 전체 행 스캔

`content` 컬럼은 `LONGTEXT`이므로, 각 행마다 수 KB~수십 KB의 텍스트를 메모리에 로드하여 패턴 매칭합니다.

### 3-2. HikariCP 커넥션 풀 고갈

![](/uploads/project/WikiEngine/search-system-crash/connection-pool-error.png)

```
HikariPool-1 - Connection is not available, request timed out after 30000ms
```

**연쇄 장애 시나리오:**

1. 검색 쿼리가 커넥션 1개를 점유하고 수십 초간 반환하지 않음
2. 후속 요청들이 커넥션을 기다리며 큐에 쌓임
3. HikariCP의 `maximumPoolSize=10`이 금방 소진
4. 모든 API가 커넥션을 얻지 못해 30초 후 타임아웃 → 503

**핵심:** 단 하나의 느린 쿼리가 커넥션 풀을 점유하면, 그 커넥션 풀을 공유하는 **모든 기능이 연쇄적으로 마비**됩니다.

---

## 4. 긴급 완화 조치

문제의 근본 원인은 "인덱스 없는 LIKE 검색"이지만, 당장의 시스템 안정성을 확보하기 위해 4가지 긴급 조치를 적용했습니다.

### 4-1. content LIKE 제거 → title만 검색

가장 큰 비용은 `LONGTEXT`인 `content` 컬럼의 LIKE 검색입니다.

```sql
-- Before
WHERE title LIKE '%keyword%' OR content LIKE '%keyword%'

-- After
WHERE title LIKE '%keyword%'
```

![](/uploads/project/WikiEngine/search-system-crash/title-only-search.png)

`content` LIKE를 제거하면 각 행에서 비교하는 데이터 크기가 수 KB → 수십 바이트로 줄어듭니다.
여전히 Full Table Scan이지만, I/O와 CPU 비용이 크게 감소합니다.

### 4-2. 쿼리 타임아웃 설정

```java
@Transactional(readOnly = true, timeout = 5)
public Page<PostSearchResponse> search(...) { ... }
```

![](/uploads/project/WikiEngine/search-system-crash/transactional-timeout.png)

5초 이내에 완료되지 않는 쿼리는 강제 종료하여 커넥션을 반환합니다.

### 4-3. HikariCP fail-fast 설정

```yaml
spring:
  datasource:
    hikari:
      connection-timeout: 3000   # 기본 30초 → 3초
      maximum-pool-size: 10
```

커넥션을 3초 이상 얻지 못하면 즉시 실패시켜, 요청이 큐에 쌓이는 것을 방지합니다.

### 4-4. 타임아웃 전용 예외 처리

```java
@ExceptionHandler(QueryTimeoutException.class)
public ResponseEntity<ErrorResponse> handleQueryTimeout(QueryTimeoutException e) {
    return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
        .body(new ErrorResponse("검색 시간이 초과되었습니다. 더 구체적인 키워드로 검색해주세요."));
}
```

![](/uploads/project/WikiEngine/search-system-crash/timeout-exception-handler.png)

타임아웃이 발생하면 사용자에게 명확한 메시지를 반환합니다.

### 조치 결과

![](/uploads/project/WikiEngine/search-system-crash/timeout-working-log.png)

- 검색이 5초를 초과하면 타임아웃 → 커넥션 즉시 반환
- 다른 API가 영향받지 않음 → **시스템 안정성 확보**
- 단, 검색 자체의 성능 문제는 여전히 미해결

---

## 5. Baseline 측정

긴급 조치 후, 현재 상태의 정확한 성능을 측정하여 개선의 기준점을 잡습니다.

### EXPLAIN 결과

```sql
EXPLAIN SELECT * FROM posts
WHERE title LIKE '%keyword%'
ORDER BY created_at DESC
LIMIT 20;
```

![](/uploads/project/WikiEngine/search-system-crash/explain-baseline.png)

| 항목 | 값 |
|------|-----|
| type | ALL (Full Table Scan) |
| rows | 27,443,742 |
| filtered | 11.11% |
| Extra | Using where; Using filesort |

### EXPLAIN ANALYZE 시도

```sql
EXPLAIN ANALYZE SELECT * FROM posts
WHERE title LIKE '%keyword%'
ORDER BY created_at DESC
LIMIT 20;
```

![](/uploads/project/WikiEngine/search-system-crash/explain-analyze-fail.png)

`EXPLAIN ANALYZE`는 실제로 쿼리를 실행하므로, 1,215만 행 Full Table Scan + filesort를 수행합니다.
5초 타임아웃에 의해 중단되어 실제 실행 시간은 측정할 수 없었습니다.

---

## 6. 현재 위치

### 서버 현황

| 서버 | 스펙 | 역할 |
|------|------|------|
| App Server | ARM 2코어 / 12GB RAM | Nginx + Spring Boot + MySQL |
| Monitoring #1 | AMD 1GB + Swap 1GB | Loki + Grafana + Nginx (HTTPS) |
| Monitoring #2 | AMD 1GB + Swap 1GB | Prometheus |

> App Server 12GB 내부 배분: Spring Boot 2GB(JVM 힙 1GB) + MySQL 4GB(InnoDB BP 2GB) + 모니터링 에이전트 ~1GB = 합계 ~7GB. 나머지 ~5GB는 OS 페이지 캐시.

### 검색 상태

| 항목 | 현재 상태 |
|------|-----------|
| 검색 방식 | `LIKE '%keyword%'` (title만) |
| 스캔 방식 | Full Table Scan (27,443,742 rows) |
| 인덱스 | 없음 |
| 정렬 | filesort (created_at DESC) |
| 타임아웃 | 5초 (`@Transactional timeout`) |
| 커넥션 풀 | HikariCP 10개, fail-fast 3초 |

**긴급 조치로 시스템 안정성은 확보했지만, 검색 성능 자체는 최악의 상태입니다.**

다음 단계에서는 MySQL의 인덱스를 활용하여 Full Table Scan을 제거하는 것을 목표로 합니다.

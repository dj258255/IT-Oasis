---
title: 'COUNT(*) 제거와 페이지 제한으로 19,424ms → 8ms'
titleEn: 'Eliminating COUNT(*) and Page Limits — From 19,424ms to 8ms on 14M Rows'
description: 1,425만 건 테이블에서 COUNT(*) 제거(Page→Slice), 30페이지 제한, Deferred Join을 조합하여 최신 게시글 목록 조회를 19,424ms에서 8.33ms로 개선하고, k6 load 테스트(100 VU, 20분)에서 에러율 32.53%→0%를 달성한 과정을 정리합니다.
descriptionEn: Combined COUNT(*) elimination (Page to Slice), 30-page limit, and Deferred Join to reduce post listing from 19,424ms to 8.33ms on 14.25M rows, achieving 0% error rate under 100 VU k6 load test.
date: 2026-03-05T00:00:00.000Z
tags:
  - MySQL
  - Pagination
  - COUNT
  - Slice
  - k6
  - Performance
  - Grafana
category: project/WikiEngine
draft: false
---

## 이전 글

[Deferred Join 적용기](/blog/project/wikiengine/deferred-join-optimization)에서 1,475만 건 OFFSET 페이지네이션에 Deferred Join을 적용하고, 기대 대비 낮은 개선율의 원인을 분석했습니다.

---

## 이전 글 요약

[이전 글](/blog/project/wikiengine/lucene-decision)에서 Lucene + Nori 형태소 분석기로 검색엔진을 전환했습니다.
1,425만 건 전체 검색, 고빈도 토큰 타임아웃 해소, false positive 제거까지 완료했습니다.

k6 부하 테스트를 처음 실행한 결과, **검색이 아니라 최신 게시글 목록 조회가 최대 병목**이었습니다.

| 시나리오 | smoke (5 VU) | load (100 VU) |
|----------|-------------|---------------|
| 검색 (Lucene) | 66ms | 3,328ms |
| 자동완성 (Lucene) | 25ms | 3,339ms |
| **최신 게시글 목록 (MySQL OFFSET)** | **2,518ms** | **19,424ms** |
| 상세 조회 (MySQL) | 53ms | 3,345ms |
| 에러율 | 0% | **32.53%** |

smoke에서 검색(66ms)보다 최신 게시글 목록 조회(2,518ms)가 **38배 느렸습니다.**
load에서는 최신 게시글 목록 조회의 heavy OFFSET이 CPU를 포화시키면서 **모든 시나리오가 연쇄적으로 무너졌습니다.**

---

## 1. 문제 발견 — 검색이 아니라 최신 게시글 목록 조회가 병목이었다

> 이 문제는 **최신 게시글 목록 조회**(`GET /api/v1.0/posts`)에 해당합니다.
> Lucene 검색(`GET /api/v1.0/posts/search`)은 역색인에서 직접 결과를 반환하므로 OFFSET 문제가 없습니다.

k6 스크립트에서 30% 확률로 page=100~1000을 요청하는 조건이었습니다.
page 1000 = `OFFSET 20,000`이므로, MySQL이 20,020개 행을 읽고 20,000개를 버려야 합니다.

```sql
-- 최신 글 목록: created_at DESC로 정렬
SELECT * FROM posts
ORDER BY created_at DESC
LIMIT 20 OFFSET 20000;  -- page 1001
```

---

## 2. 원인 분석 — SELECT * + OFFSET의 구조적 비효율

MySQL의 `SELECT *` + OFFSET은 다음 과정을 거칩니다:

```
1. 세컨더리 인덱스(idx_posts_created_at)에서 PK를 순차 획득
2. 각 PK로 클러스터 인덱스에서 전체 행(LONGTEXT 포함) 랜덤 I/O
3. OFFSET 20,000개를 읽고 버림 → 20,000 × ~13KB(위키 본문 평균) ≈ ~260MB를 읽고 버림
4. 나머지 20개만 반환
```

`PostSummaryResponse`는 `content`를 사용하지 않습니다. 필요 없는 LONGTEXT를 읽고 있었습니다.

**CPU 포화 원인 체인 (k6 load 결과):**

```
최신 게시글 목록 조회의 deep OFFSET (OFFSET 20,000) → CPU-bound 인덱스 스캔
→ 2코어 CPU 포화 (System CPU 100%, Load Average 20)
→ 같은 CPU를 쓰는 MySQL + App 전체 지연 (Slow Query 14.8K)
→ 검색·자동완성·상세까지 연쇄 지연 (66ms → 3,300ms)
→ Spring Boot 스레드 폭증 (20→120), 요청 타임아웃
→ HTTP 500 에러 → k6 에러율 32.53%
```

핵심 증거: **InnoDB Buffer Pool 히트율 100%**(디스크 I/O 0)인데도 Slow Query가 14.8K건 발생했습니다. 메모리가 아닌 CPU가 병목이었습니다.

---

## 3. 해결 1: Deferred Join (지연 조인)

### 원리

내부 서브쿼리에서 `SELECT id`만 하여 Covering Index Scan으로 처리하고,
외부 쿼리에서 최종 20개 PK로만 클러스터 인덱스를 조회합니다.

```sql
-- Before: 전체 행(LONGTEXT 포함) 20,020건 랜덤 I/O
SELECT * FROM posts
ORDER BY created_at DESC
LIMIT 20 OFFSET 20000;

-- After: Covering Index로 PK만 추출 후, 20건만 클러스터 I/O
SELECT p.* FROM posts p
INNER JOIN (
    SELECT id FROM posts ORDER BY created_at DESC
    LIMIT 20 OFFSET 20000
) AS tmp ON p.id = tmp.id
ORDER BY p.created_at DESC;
```

> `idx_posts_created_at`에는 `(created_at, id)` 두 값이 들어 있으므로
> `SELECT id ... ORDER BY created_at DESC`는 이 인덱스만으로 완결됩니다 (Covering Index).

### 현재 구현

`PostRepository.java`:

```java
@Query(value = """
    SELECT p.* FROM posts p
    INNER JOIN (
        SELECT id FROM posts ORDER BY created_at DESC
        LIMIT :#{#pageable.pageSize} OFFSET :#{#pageable.offset}
    ) AS tmp ON p.id = tmp.id
    ORDER BY p.created_at DESC
    """,
    countQuery = "SELECT COUNT(*) FROM posts",
    nativeQuery = true)
Page<Post> findAllWithDeferredJoin(Pageable pageable);
```

`PostService.java`:

```java
public Page<Post> getPosts(Pageable pageable) {
    return postRepository.findAllWithDeferredJoin(pageable);
}
```

### EXPLAIN 결과

| id | select_type | table | type | key | rows | Extra |
|----|-------------|-------|------|-----|------|-------|
| 2 | DERIVED | posts | index | idx_posts_created_at | 20,020 | **Using index** (Covering) |
| 1 | PRIMARY | `<derived2>` | ALL | NULL | 20,020 | Using temporary; Using filesort |
| 1 | PRIMARY | p | eq_ref | PRIMARY | 1 | |

클러스터 인덱스 랜덤 I/O: **20,020회 → 20회** (1,000배 감소)

### 측정 결과 (k6 smoke, 5 VU, 2분)

| 메트릭 | Before | After | 개선율 |
|--------|--------|-------|--------|
| 평균 응답시간 | 2,518ms | 2,199ms | -13% |
| P95 | 3,372ms | 2,741ms | -19% |

### 기대(40배) 대비 낮은 개선율(13%) 원인

EXPLAIN 분석 결과:
- 전체 비용의 **~85%는 인덱스 20,020개 엔트리 순차 스캔** (Deferred Join이 제거할 수 없는 부분)
- LONGTEXT I/O는 ~15%뿐 → 이것만 제거해서 13%
- 추가로 임시 테이블 생성(Using temporary; Using filesort) 오버헤드가 일부 상쇄

| OFFSET 크기 | Deferred Join 개선율 | 이유 |
|-------------|---------------------|------|
| OFFSET 200 (page 10) | ~60% | 클러스터 I/O 비중이 큼 |
| OFFSET 2,000 (page 100) | ~40% | |
| OFFSET 10,000 (page 500) | ~20% | |
| OFFSET 20,000 (page 1000) | ~13% | 인덱스 스캔이 지배적 |

> 사용자 트래픽의 ~90%는 page 1~10이므로, 평균 체감 개선은 k6 측정치(13%)보다 높습니다.

---

## 4. 해결 2: 최대 페이지 수 제한

OFFSET의 근본 한계(O(N) 스캔)는 Deferred Join으로 완화되지만, 무제한 페이지는 여전히 위험합니다.
Google은 ~30페이지, 네이버도 ~30페이지가 한계입니다. **최대 페이지 수를 제한하여 worst-case를 통제합니다.**

### 현업 페이지 제한 비교

| 서비스 | 페이지당 결과 | 최대 페이지 | 최대 결과 수 |
|--------|-------------|-----------|------------|
| Google | 10건 | ~30페이지 | ~300건 |
| 네이버 | 15건 | ~30페이지 | ~450건 |
| **wikiEngine** | **20건** | **31페이지 (0~30)** | **620건** |

### 구현

**Step 1: ErrorCode 추가**

`ErrorCode.java`에 `PAGE_LIMIT_EXCEEDED` 추가:

```java
// 400 Bad Request
PAGE_LIMIT_EXCEEDED(HttpStatus.BAD_REQUEST, "최대 페이지 수를 초과했습니다"),
```

**Step 2: PostService에 페이지 제한 로직 추가**

```java
private static final int MAX_LIST_PAGE = 30;    // 최신 게시글 목록
private static final int MAX_SEARCH_PAGE = 30;   // Lucene 검색

private void validatePageLimit(Pageable pageable, int maxPage) {
    if (pageable.getPageNumber() > maxPage) {
        throw new BusinessException(ErrorCode.PAGE_LIMIT_EXCEEDED);
    }
}
```

**왜 30페이지인가:**

| 최대 페이지 | 최대 OFFSET | Deferred Join 실측 |
|------------|------------|-------------------|
| 1,000 (제한 없음) | 19,980 | 19.4ms (Covering Index 스캔) |
| **30 (Google/네이버 수준)** | **580** | **~1ms** |

- Deferred Join 덕분에 page 1000도 19.4ms이지만, 30페이지면 OFFSET 580으로 사실상 비용 0
- Google, 네이버 모두 ~30페이지 제한. 사용자 기대치와 일치합니다
- 최신 게시글 목록: 30페이지(620건) 이후는 검색으로 유도합니다
- 검색: Lucene이 relevance 순으로 정렬하므로 30페이지 이후는 관련성이 낮습니다

### 참고: 커서 기반 페이지네이션 (무한 스크롤 전환 시)

현재는 페이지 번호 UI이므로 OFFSET + 페이지 제한이 적합합니다.
무한 스크롤 UI로 전환 시 Keyset Pagination을 재검토할 예정입니다.

```sql
-- 커서 방식: 항상 O(LIMIT)만 읽음, 페이지 깊이 무관
SELECT * FROM posts
WHERE created_at < :lastCreatedAt
ORDER BY created_at DESC
LIMIT 20;
```

| 방식 | 장점 | 단점 | 사용 사례 |
|------|------|------|-----------|
| OFFSET (페이지 번호) | 특정 페이지 바로 이동 | 깊은 페이지에서 느려짐 | Google, 위키 검색 |
| 커서 (무한 스크롤) | 일관된 성능 | 순차 접근만 가능 | Twitter, Instagram |

---

## 5. 해결 3: COUNT(*) 제거

### 문제

"총 N개 결과" 표시를 위해 매 **최신 게시글 목록 조회**마다 COUNT(*) 쿼리가 실행되고 있었습니다.

현재 `PostRepository.findAllWithDeferredJoin`의 `countQuery`:

```java
countQuery = "SELECT COUNT(*) FROM posts"
```

Spring Data의 `Page<T>` 반환 시 이 countQuery가 **매 요청마다** 자동 실행됩니다.
1,425만 건 테이블에서 COUNT(*)는 InnoDB가 가장 작은 세컨더리 인덱스를 풀 스캔해야 하므로 비용이 높습니다.

> Lucene 검색(`GET /api/v1.0/posts/search`)은 `totalHits`를 역색인에서 즉시 반환하므로 COUNT 문제 없음.
> 이 문제는 **최신 게시글 목록 조회(`GET /api/v1.0/posts`)에만** 해당합니다.

---

### 트레이드오프 분석 — "총 N개" 표시가 정말 필요한가?

COUNT(*)를 제거하려면 "총 N개 결과" 표시를 포기해야 합니다.
이 트레이드오프를 판단하기 위해, 실제 서비스들이 어떻게 하고 있는지 조사했습니다.

#### 현업 사례 조사

**1) Google — 2024년에 결과 수 표시를 아예 제거**

Google은 검색 초기부터 "약 45,700,000개 결과"를 표시해왔습니다.
하지만 2024년, [검색 결과 페이지에서 이 숫자를 완전히 제거했습니다](https://searchengineland.com/google-hides-search-results-count-under-tools-section-440299).

제거 이유:
- 이 숫자는 **추정치**였습니다 — 페이지를 넘기면 값이 바뀌는 현상이 일상적이었습니다
- 사용자에게 유용하지 않다고 판단 — "4,570만 개 결과"를 보고 의사결정하는 사용자는 없습니다
- 계산 비용 대비 가치가 없습니다

```
Before (2024년 이전):
  "약 45,700,000개 결과 (0.52초)"  ← 화면 상단에 표시

After (2024년~):
  결과 수 표시 없음. 도구(Tools) 메뉴 안에 숨겨짐
```

> 출처: [Google Drops Result Count From Search Results Page — Search Engine Roundtable](https://www.seroundtable.com/google-drops-result-count-from-search-results-page-37348.html)

**2) Slack — offset+page에서 cursor로 전환, total_count 제거**

Slack은 초기에 `count` + `page` 파라미터로 OFFSET 페이지네이션을 제공했습니다.
이후 [cursor 기반으로 전환하면서 total_count를 제거했습니다](https://slack.engineering/evolving-api-pagination-at-slack/).

전환 이유:
- OFFSET이 커질수록 DB가 이전 행을 모두 읽어야 해서 느려집니다
- 아이템이 추가/삭제되면 페이지 윈도우가 밀려서 **중복/누락** 발생
- `total_count` 계산 = COUNT(*) = 대규모 테이블에서 풀 스캔

Slack의 현재 API: `next_cursor`가 빈 문자열이면 마지막 페이지. 총 건수 없음.

> 내부적으로 `limit + 1`개를 조회하여 다음 페이지 존재 여부를 판별합니다.
> 이것이 Spring Data의 `Slice<T>`와 동일한 패턴입니다.

> 출처: [Evolving API Pagination at Slack — Slack Engineering](https://slack.engineering/evolving-api-pagination-at-slack/)

**3) 네이버 — 섹션별 분리 + 최대 ~30페이지 제한, 전체 건수 미노출**

네이버는 Google과 달리 통합 검색 결과를 **섹션별로 분리**합니다 (블로그, 뉴스, 카페, 웹문서 등).
각 섹션은 최초 5건 정도만 보여주고 "더보기"로 해당 섹션 전용 페이지로 이동시킵니다.

- **전체 검색 결과 건수를 통합 검색 페이지에 표시하지 않습니다**
- 섹션 전용 페이지(블로그 탭, 뉴스 탭)에서도 **최대 ~30페이지까지만 제공**
  ([SerpApi — Naver Search API](https://serpapi.com/naver-search-api))
- 페이지네이션은 `start` 파라미터 기반 OFFSET 방식이며, 웹 검색은 페이지당 10건, 쇼핑은 40건

네이버의 접근법은 Google과 다르지만 결론은 같습니다:
**"총 N건" 같은 전체 건수를 사용자에게 보여주지 않으며, 깊은 페이지 접근을 구조적으로 차단합니다.**

> 네이버는 2024년 이후 AI 기반 검색(Cue:)으로 전환을 진행 중이며,
> 전통적인 10-blue-links 페이지네이션 자체가 줄어드는 추세입니다.

**4) Twitter(X), Instagram — 무한 스크롤, 총 건수 없음**

피드 기반 서비스는 총 건수 자체가 의미 없습니다.
커서 기반 + `hasNext`만으로 동작합니다.

**4) Stack Overflow, Reddit — 페이지 번호 UI + 총 건수 표시**

전통적인 게시판 UI를 유지하는 서비스는 여전히 총 건수를 표시합니다.
다만 이 서비스들은 데이터 규모가 상대적으로 작거나, 캐싱으로 COUNT 비용을 흡수하고 있습니다.

#### 정리: 총 건수 표시 방식 스펙트럼

| 방식 | 대표 서비스 | 장점 | 단점 |
|------|-----------|------|------|
| **정확한 COUNT** | Stack Overflow, 전통 게시판 | 정확한 총 페이지 표시 | 대규모 테이블에서 매 요청 풀 스캔 |
| **추정치 표시** | Google (2024년 이전) | 규모감 제공, COUNT 비용 절감 | 추정치가 부정확 (페이지 넘기면 변동) |
| **총 건수 없음 (hasNext만)** | Google (현재), Slack, Twitter | COUNT 쿼리 0, 최고 성능 | "총 N페이지" 표시 불가 |
| **섹션별 분리 + 페이지 제한** | 네이버 | 섹션별 최적화, 깊은 페이지 차단 | 통합 건수 없음, 최대 ~30페이지 |

#### UX 관점 — 총 페이지 수가 100 이상이면 무의미합니다

[NN/g(Nielsen Norman Group) 연구](https://www.nngroup.com/articles/item-list-view-all/)와 [UX 디자인 가이드](https://coyleandrew.medium.com/design-better-pagination-a022a3b161e1)에 따르면:

- 페이지 수가 **수십~수백 개 이상이면** 총 페이지 수 표시가 사용자에게 도움이 되지 않습니다
- 사용자는 "71,250페이지 중 3페이지"를 보고 아무런 의사결정을 하지 않습니다
- 반면 **30페이지 이하**라면 총 페이지 수가 "끝이 보인다"는 심리적 효과를 줍니다

이 프로젝트: 1,425만 건 / 20건 페이지 = **71만 페이지**. 총 건수 표시는 완전히 무의미합니다.

---

### 결론: Google 현재 방식을 따른다 — hasNext만, 총 건수 없음

| 판단 기준 | 이 프로젝트의 상황 | 결론 |
|----------|-----------------|------|
| 데이터 규모 | 1,425만 건 (71만 페이지) | 총 건수 무의미 |
| COUNT(*) 비용 | InnoDB 풀 스캔 (1,425만 행) | 매 요청 비용 높음 |
| UI 타입 | 페이지 번호 | hasNext + 현재 주변 페이지로 충분 |
| 사용자 행동 | 90%가 1~3페이지 | 뒷페이지 네비게이션 거의 없음 |
| 최대 페이지 제한 | 30페이지 | 유한한 범위 → 총 건수 불필요 |

**`Page<T>` → `Slice<T>` 전환. COUNT(*) 완전 제거. 추정치도 불필요.**

페이지 번호 UI는 `hasNext`로 충분히 구현 가능합니다:

```
hasNext=true  →  [이전] [1] [2] [3] [4] [5] [다음]
hasNext=false →  [이전] [1] [2] [3]                  (3이 마지막)
```

현재 주변 2~3페이지 + [이전]/[다음] 버튼만 표시하면 됩니다.
Google 검색도 2024년 이후 이 방식을 사용하고 있습니다.

> **만약 나중에 "약 N개 결과"가 필요해지면?**
> `information_schema.tables.table_rows`로 추정치를 즉시 조회할 수 있습니다 (±10% 오차).
> 별도 API로 제공하면 최신 게시글 목록 조회 성능에 영향 없이 추가 가능합니다.
> 하지만 Google이 이것마저 제거한 이유를 생각하면, 필요해질 가능성은 낮습니다.

---

### 구현 계획

#### 주의: Slice + nativeQuery + Deferred Join 조합의 함정

현재 `findAllWithDeferredJoin`은 서브쿼리 안에 명시적 `LIMIT/OFFSET`이 있는 nativeQuery입니다.
이 구조에서 `Slice<T>`를 반환 타입으로 단순 교체하면 문제가 발생할 수 있습니다.

**왜 충돌하는가? — Spring Data의 페이지네이션 내부 동작**

Spring Data JPA가 `Pageable` 파라미터를 처리하는 과정:

```
1. Repository 메서드 호출 시 Pageable 감지
2. Hibernate Query 객체에 다음을 설정:
   - query.setFirstResult(pageable.getOffset())   // → SQL OFFSET
   - query.setMaxResults(pageable.getPageSize())   // → SQL LIMIT
3. Slice<T> 반환 시: setMaxResults(pageSize + 1)로 변경 (다음 페이지 판별용)
4. Hibernate가 DB 방언(Dialect)에 맞게 SQL에 LIMIT/OFFSET을 추가
```

**JPQL에서는** Hibernate가 쿼리 구조를 파싱하여 깨끗하게 LIMIT/OFFSET을 추가합니다.

**nativeQuery에서는** Hibernate가 SQL을 파싱하지 못합니다.
대신 쿼리 문자열 끝에 LIMIT/OFFSET을 기계적으로 덧붙이거나,
일부 DB 방언에서는 **전체 쿼리를 서브쿼리로 감싸서** 외부에 페이지네이션을 적용합니다.

Deferred Join 쿼리의 경우, 이 자동 처리가 두 가지 방식으로 충돌합니다:

```sql
-- 우리가 작성한 Deferred Join 쿼리 (서브쿼리에 명시적 LIMIT/OFFSET)
SELECT p.* FROM posts p
INNER JOIN (
    SELECT id FROM posts ORDER BY created_at DESC
    LIMIT 20 OFFSET 0          ← ① 우리가 명시한 LIMIT
) AS tmp ON p.id = tmp.id
ORDER BY p.created_at DESC
LIMIT 21                        ← ② Hibernate가 자동 추가한 LIMIT (Slice +1)
```

**충돌 시나리오:**

| # | 현상 | 원인 |
|---|------|------|
| ① | 서브쿼리 LIMIT과 외부 LIMIT 이중 적용 | Hibernate가 nativeQuery 끝에 LIMIT을 기계적으로 추가. 서브쿼리의 LIMIT과 의도가 다름 |
| ② | Slice인데 COUNT 쿼리 실행 | `nativeQuery + Slice` 조합에서 Spring Data가 `PageImpl`을 반환하는 버그 ([DATAJPA-1464](https://github.com/spring-projects/spring-data-jpa/issues/1782)) |
| ③ | 정렬(ORDER BY) 유실 | Spring Data가 nativeQuery에 동적 정렬을 적용하려다 기존 ORDER BY를 덮어쓸 수 있음 ([#2260](https://github.com/spring-projects/spring-data-jpa/issues/2260)) |

핵심: **Spring Data의 자동 페이지네이션은 "쿼리의 최종 결과에 LIMIT/OFFSET을 건다"는 가정**으로 동작합니다.
Deferred Join처럼 **서브쿼리 안에 이미 LIMIT/OFFSET이 있는 구조**에서는 이 가정이 깨집니다.
Spring Data는 nativeQuery의 내부 구조를 파싱하지 못하므로, 서브쿼리의 LIMIT과 외부의 자동 LIMIT이 의도와 다르게 중첩됩니다.

> 출처: [Vlad Mihalcea — Query Pagination with JPA and Hibernate](https://vladmihalcea.com/query-pagination-jpa-hibernate/),
> [Spring Data JPA #2260](https://github.com/spring-projects/spring-data-jpa/issues/2260),
> [Spring Data JPA #1782 (DATAJPA-1464)](https://github.com/spring-projects/spring-data-jpa/issues/1782)

**안전한 방법: `List<Post>` 반환 + 서비스에서 수동 `SliceImpl` 구성**

이 패턴은 현업에서 널리 검증된 방식입니다:

- **Slack Engineering** — `limit + 1`개를 조회하여 `has_more`를 판별하는 것이 Slack의 cursor 기반 페이지네이션의 핵심 메커니즘
  ([Evolving API Pagination at Slack](https://slack.engineering/evolving-api-pagination-at-slack/))
- **Baeldung** — Hibernate `query.setMaxResults(pageSize + 1)` + 수동 `SliceImpl` 구성을 "extra row" 패턴으로 소개
  ([Hibernate Pagination — Baeldung](https://www.baeldung.com/hibernate-pagination))
- **Vlad Mihalcea (Hibernate 핵심 기여자)** — nativeQuery에서 `setFirstResult`/`setMaxResults`를 직접 제어할 것을 권장
  ([Query Pagination with JPA and Hibernate](https://vladmihalcea.com/query-pagination-jpa-hibernate/))
- **Spring Data JPA GitHub Gist** — `List<T>` 반환 + `new SliceImpl<>(content, pageable, hasNext)` 패턴이 Specification 기반 쿼리에서도 사용됨
  ([GitHub Gist — Limit results without count query](https://gist.github.com/tcollins/0ebd1dfa78028ecdef0b))

Spring Data의 자동 처리에 의존하지 않으므로 nativeQuery 호환성 문제가 없습니다.
**이 패턴이 Deferred Join + nativeQuery에서 가장 안전하고 확실한 방법입니다.**

**Step 1: Repository — `List<Post>` 반환, LIMIT/OFFSET 명시적 파라미터**

```java
// Before: Page<T> — countQuery 자동 실행 (매 요청 COUNT(*) 풀 스캔)
@Query(value = """
    SELECT p.* FROM posts p
    INNER JOIN (
        SELECT id FROM posts ORDER BY created_at DESC
        LIMIT :#{#pageable.pageSize} OFFSET :#{#pageable.offset}
    ) AS tmp ON p.id = tmp.id
    ORDER BY p.created_at DESC
    """,
    countQuery = "SELECT COUNT(*) FROM posts",
    nativeQuery = true)
Page<Post> findAllWithDeferredJoin(Pageable pageable);

// After: List<T> — COUNT 없음, LIMIT+1은 서비스에서 처리
@Query(value = """
    SELECT p.* FROM posts p
    INNER JOIN (
        SELECT id FROM posts ORDER BY created_at DESC
        LIMIT :limit OFFSET :offset
    ) AS tmp ON p.id = tmp.id
    ORDER BY p.created_at DESC
    """, nativeQuery = true)
List<Post> findAllWithDeferredJoin(@Param("limit") int limit, @Param("offset") long offset);
```

**Step 2: Service — 수동 Slice 구성 (LIMIT+1 패턴)**

```java
// PostService.java
public Slice<Post> getPosts(Pageable pageable) {
    if (pageable.getPageNumber() > MAX_LIST_PAGE) {
        throw new BusinessException(ErrorCode.PAGE_LIMIT_EXCEEDED);
    }

    int pageSize = pageable.getPageSize();
    long offset = pageable.getOffset();

    // 핵심: pageSize + 1개를 조회하여 다음 페이지 존재 여부 판별
    List<Post> results = postRepository.findAllWithDeferredJoin(pageSize + 1, offset);

    boolean hasNext = results.size() > pageSize;
    if (hasNext) {
        results = results.subList(0, pageSize);  // 실제 표시할 20개만
    }

    return new SliceImpl<>(results, pageable, hasNext);
}
```

> `SliceImpl`은 Spring Data의 `Slice<T>` 구현체입니다.
> `new SliceImpl<>(content, pageable, hasNext)`로 생성하며,
> `hasNext()`, `hasPrevious()`, `getContent()`, `getNumber()` 등을 모두 지원합니다.

**Step 3: Controller — 반환 타입 변경**

```java
// PostController.java
@GetMapping
public Slice<PostSummaryResponse> getPosts(
        @RequestParam(required = false) Long categoryId,
        @PageableDefault(size = 20) Pageable pageable) {

    Slice<Post> posts = (categoryId != null)
            ? postService.getPostsByCategory(categoryId, pageable)
            : postService.getPosts(pageable);

    return posts.map(PostSummaryResponse::from);
}
```

> **카테고리별 목록(`getPostsByCategory`)도 동일한 패턴 적용 필요.**
> 현재 `findByCategoryIdOrderByCreatedAtDesc`는 Spring Data 파생 쿼리이므로
> 반환 타입을 `Slice<Post>`로 변경하면 자동으로 COUNT가 제거됩니다.
> nativeQuery가 아니므로 함정 없음.

> **검색은 변경 불필요**: `LuceneSearchService.search()`는 Lucene의 `totalHits`로 `Page<T>`를 생성하고 있습니다.
> Lucene의 totalHits는 역색인에서 즉시 반환되므로 COUNT(*) 문제가 없습니다. 그대로 유지합니다.

### Spring Data: Page vs Slice 비교

| 항목 | `Page<T>` | `Slice<T>` |
|------|-----------|------------|
| COUNT 쿼리 | **매 요청 실행** | 실행 안 함 |
| `getTotalElements()` | O | X |
| `getTotalPages()` | O | X |
| `hasNext()` | O | O |
| `getContent()` | O | O |
| `getNumber()` (현재 페이지) | O | O |
| DB 쿼리 수 | **2개** (데이터 + COUNT) | **1개** (데이터만, LIMIT+1) |

> 출처: [Spring Data JPA — Slice vs Page](https://docs.spring.io/spring-data/jpa/reference/jpa/query-methods.html), [JHipster — Boost Infinite Scroll Performance with Slice](https://www.jhipster.tech/tips/019_tip_infinite_scroll_with_slice.html)

### 성과 (예상)

| 지표 | Before (Page) | After (Slice) | 개선 |
|------|--------------|---------------|------|
| DB 쿼리 수/요청 | 2개 (데이터 + COUNT) | 1개 (데이터만) | **50% 감소** |
| COUNT(*) 시간 | 2,038ms (1,477만 건 스캔) | 0ms (제거) | **100% 제거** |
| 총 건수 정확도 | 100% | 표시 안 함 | - |
| 사용자 체감 | 동일 | 동일 (Google도 제거함) | - |

---

## 6. Before/After 측정

### 변경 전 캡처

코드 변경 전에 아래 항목을 캡처했습니다. After와 동일 조건 비교를 위한 증거입니다.

| #   | 캡처 항목                    | 방법                                                 | 용도                                                     |
| --- | ------------------------ | -------------------------------------------------- | ------------------------------------------------------ |
| 1   | COUNT(*) 단건 실행 비용        | `EXPLAIN ANALYZE SELECT COUNT(*) FROM posts;`      | COUNT 제거 효과의 기준점                                       |
| 2   | 현재 API 응답 JSON (Page 구조) | `GET /api/v1.0/posts?page=0&size=20`               | `totalElements`, `totalPages` 필드가 Slice 전환 후 사라지는 것 확인 |
| 3   | k6 smoke (5 VU, 2분)      | `k6 run --env PROFILE=smoke baseline-load-test.js` | 성능 baseline                                            |
| 4   | Grafana 대시보드 (smoke 중)   | QPS, CPU, Slow Query, 스레드 수 패널 캡처                  | 인프라 baseline                                           |
| 5   | MySQL 상태 스냅샷             | `SHOW GLOBAL STATUS LIKE 'Slow_queries';`          | Slow Query 누적 건수                                       |
| 6   | (선택) deep OFFSET 실행시간 비교 | `EXPLAIN ANALYZE` page 200 vs page 1000            | 페이지 제한이 왜 필요한지 근거                                      |

#### 캡처 결과

**1. COUNT(*) 실행 비용:**

![EXPLAIN ANALYZE SELECT COUNT(*) FROM posts — actual time=2014ms](/uploads/project/WikiEngine/query-refactoring-optimization/phase6-before-count-explain.png)

![쿼리 실행 Duration — COUNT(*) 2.038초, SHOW GLOBAL STATUS 0.015초](/uploads/project/WikiEngine/query-refactoring-optimization/phase6-before-query-duration.png)

```
-> Count rows in posts  (actual time=2014..2014 rows=1 loops=1)
```

**매 최신 게시글 목록 조회마다 약 2초가 COUNT(*)에 소비되고 있었습니다.** Duration: 2.038 sec.

**2. API 응답 JSON (Page 구조):**

`GET /api/v1.0/posts?page=0&size=20` 응답 (페이지네이션 메타데이터 부분):

```json
{
  "totalElements": 14769132,
  "totalPages": 738457,
  "number": 0,
  "size": 20,
  "first": true,
  "last": false,
  "numberOfElements": 20
}
```

**`totalElements: 14,769,132` (약 1,477만 건), `totalPages: 738,457` (약 74만 페이지).**
Slice 전환 후 `totalElements`와 `totalPages` 필드가 사라지고, `hasNext: true/false`만 남습니다.

**3. k6 smoke Before:**

[이전 글](/blog/project/wikiengine/lucene-decision)(Lucene 전환) 직후 측정한 smoke 결과를 baseline으로 사용합니다.
([lucene-decision — k6-smoke-result.png](/uploads/project/WikiEngine/lucene-decision/k6-smoke-result.png))

| 메트릭 | 검색 | 자동완성 | 최신 게시글 목록 | 상세 조회 | 쓰기 |
|--------|------|---------|----------|----------|------|
| 평균 | 66ms | 25ms | 2,518ms | 53ms | 62ms |
| P95 | 128ms | 37ms | 3,372ms | 93ms | 124ms |

| 전체 | 값 |
|------|------|
| 총 요청 수 | 214건 |
| 에러율 | 0.00% |
| 전체 P95 | 2,239ms |

**4. Grafana 스크린샷 (k6 load 중):**

이전 글의 load 프로필(100 VU, 20분) 측정 시 Grafana 캡처를 baseline으로 사용합니다:

- MySQL 지표: Buffer Pool 히트율 100%, Slow Query 14.8K건, QPS 30~50
  ([lucene-decision — k6-load-mysql.png](/uploads/project/WikiEngine/lucene-decision/k6-load-mysql.png))
- 컨테이너 리소스: System CPU 100% 포화, Load Average 20+
  ([lucene-decision — k6-load-container.png](/uploads/project/WikiEngine/lucene-decision/k6-load-container.png))
- Spring Boot HTTP: 스레드 20→120 폭증, 5xx 에러율 최대 40%
  ([lucene-decision — k6-load-springboot-http.png](/uploads/project/WikiEngine/lucene-decision/k6-load-springboot-http.png))

**5. MySQL 상태:**

![SHOW GLOBAL STATUS LIKE 'Slow_queries' — 79,505건](/uploads/project/WikiEngine/query-refactoring-optimization/phase6-before-slow-queries.png)

```
Slow_queries: 79505
```

누적 Slow Query: **79,505건** (서버 시작 이후 전체 누적).

**6. Deep OFFSET 실행 비용 (page 1000, Deferred Join 적용 상태):**

![EXPLAIN ANALYZE — Deferred Join + OFFSET 19,980 실행 계획](/uploads/project/WikiEngine/query-refactoring-optimization/phase6-explain-deep-offset-page1000.png)

```sql
EXPLAIN ANALYZE
SELECT p.* FROM posts p
INNER JOIN (
    SELECT id FROM posts ORDER BY created_at DESC
    LIMIT 20 OFFSET 19980
) AS tmp ON p.id = tmp.id
ORDER BY p.created_at DESC;
```

```
-> Sort row IDs: p.created_at DESC  (actual time=19.4..19.4 rows=20 loops=1)
    -> Nested loop inner join  (actual time=11.2..18.5 rows=20 loops=1)
        -> Table scan on tmp  (actual time=6.62..6.63 rows=20 loops=1)
            -> Materialize  (actual time=6.62..6.62 rows=20 loops=1)
                -> Limit/Offset: 20/19980 row(s)  (actual time=6.61..6.61 rows=20 loops=1)
                    -> Covering index scan on posts using idx_posts_created_at
                       (cost=13774 rows=20000) (actual time=2.48..5.75 rows=20000 loops=1)
        -> Single-row index lookup on p using PRIMARY (id=tmp.id)
           (cost=0.997 rows=1) (actual time=0.586..0.586 rows=1 loops=20)
```

**핵심**: Deferred Join 덕분에 page 1000(OFFSET 19,980)도 **19.4ms**에 완료됩니다.
Covering Index(`idx_posts_created_at`)만 스캔하여 20,000행을 읽고(5.75ms), PK로 20건만 클러스터 조회(0.586ms×20).
page 30(OFFSET 580)이면 600행만 스캔하므로 사실상 무시할 수준입니다. **페이지 제한은 성능보다 UX 관점의 결정입니다.**

---

### 변경 후 API 응답 검증

**1. Slice 응답 확인** — `GET /api/v1.0/posts?page=0&size=20`:

```json
{
  "empty": false,
  "first": true,
  "last": false,
  "number": 0,
  "numberOfElements": 20,
  "size": 20,
  "pageable": {
    "offset": 0,
    "pageNumber": 0,
    "pageSize": 20,
    "paged": true
  }
}
```

**`totalElements`, `totalPages` 필드 완전 제거됨.** COUNT(*) 쿼리가 더 이상 실행되지 않습니다.

**2. 페이지 제한 확인** — `GET /api/v1.0/posts?page=11&size=20`:

![page=11 요청 시 400 PAGE_LIMIT_EXCEEDED 응답](/uploads/project/WikiEngine/query-refactoring-optimization/phase6-after-page-limit-exceeded.png)

```json
{
  "status": 400,
  "message": "최대 페이지 수를 초과했습니다",
  "code": "PAGE_LIMIT_EXCEEDED",
  "timestamp": "2026-03-08T15:23:52.003214037Z"
}
```

page=31(0-indexed, 즉 32번째 페이지) 요청 시 `MAX_LIST_PAGE = 30`을 초과하여 400 에러 반환합니다. 정상 동작 확인.
(스크린샷은 초기 테스트 시 MAX_LIST_PAGE=10일 때 page=11로 캡처)

---

### k6 smoke (5 VU, 2분) — 변경 전후 비교

![k6 smoke After 결과 — 에러율 0%, 최신 게시글 목록 17.56ms](/uploads/project/WikiEngine/query-refactoring-optimization/phase6-after-smoke-result.png)

| 시나리오 | Before (Deferred Join만) | After (+ 페이지 30 제한 + COUNT 제거) | 개선율 |
|----------|------------------------|------------------------------------|--------|
| 검색 | 66ms | 55.39ms | -16% |
| 자동완성 | 25ms | 13.98ms | -44% |
| 최신 게시글 목록 | 2,518ms | 17.56ms | **-99.3%** |
| 상세 조회 | 53ms | 29.20ms | -45% |
| 쓰기 | 62ms | 39.63ms | -36% |
| 에러율 | 0.00% | 0.00% | - |

> **참고: 테스트 경로 차이**
> Before는 `http://내부IP:8080`(앱서버 직접), After는 `https://api.studywithtymee.com`(nginx + SSL 경유).
> After가 네트워크 홉이 더 많은데도 빠르므로, 실제 백엔드 개선은 수치보다 더 큽니다.
> 검색·자동완성·상세 조회 등 변경하지 않은 시나리오도 빨라진 이유는,
> COUNT(*) + deep OFFSET이 사라지면서 MySQL 커넥션/CPU 경합이 해소된 연쇄 효과입니다.

**왜 최신 게시글 목록이 99.3% 감소했는가?**

Before(2,518ms)에는 세 가지 병목이 겹쳐 있었습니다:

1. **COUNT(*) 제거 (→ -2,038ms)**: 매 요청마다 1,477만 행 Full Table Scan으로 `totalElements`를 구했습니다. `Page<T>` → `Slice<T>` 전환으로 이 쿼리가 완전히 사라졌습니다. 단일 요청 기준으로 2,518ms 중 ~2,038ms가 COUNT(*)였으므로 **80%는 이것만으로 제거**.

2. **Deep OFFSET 제거 (→ 최대 page 30)**: Before k6는 30% 확률로 page 100~1000(OFFSET 2,000~20,000)을 요청했습니다. OFFSET이 클수록 세컨더리 인덱스 → 클러스터 인덱스 랜덤 I/O가 비례 증가합니다. page 30 제한으로 최대 OFFSET이 580으로 줄었습니다.

3. **Deferred Join 효과 극대화**: page 0~30 범위에서는 서브쿼리가 Covering Index(`idx_posts_created_at`)만 스캔하여 PK 20개를 추출하고, 외부 쿼리가 클러스터 인덱스에서 정확히 20행만 읽습니다. OFFSET이 작을수록 Deferred Join의 효율이 극대화됩니다.

| 병목                          | Before 기여분          | After             |
| --------------------------- | ------------------- | ----------------- |
| COUNT(*)                    | ~2,038ms            | 0ms (Slice)       |
| Deep OFFSET (page 100~1000) | ~300~500ms (30% 확률) | 0ms (page 30 제한)  |
| Deferred Join (page 0~30)   | ~50ms               | ~18ms             |
| **합계**                      | **~2,518ms**        | **~18ms**         |

### k6 load (100 VU, 20분) — 변경 전후 비교

![k6 load After 결과 — 42,401 요청, 에러율 0%, 최신 게시글 목록 8.33ms](/uploads/project/WikiEngine/query-refactoring-optimization/phase6-load-k6-result.png)

| 시나리오 | Before | After | 개선율 |
|----------|------------------------|-------------------|--------|
| 검색 평균 / P95 | 3,328ms / 5,010ms | 20.51ms / 54.95ms | **-99.4%** |
| 자동완성 평균 / P95 | 3,339ms / 5,008ms | 5.91ms / 14.33ms | **-99.8%** |
| 최신 게시글 목록 평균 / P95 | 19,424ms / 28,987ms | 8.33ms / 19.01ms | **-99.96%** |
| 상세 조회 평균 / P95 | 3,345ms / — | 15.06ms / 28.80ms | **-99.6%** |
| 쓰기 평균 / P95 | — | 19.05ms / 48.84ms | — |
| 전체 평균 / P95 / P99 | — | 30.12ms / 118.82ms / 228ms | — |
| 총 요청 수 | — | 42,401건 | — |
| 에러율 | **32.53%** | **0.00%** | **에러 완전 해소** |

> Before에서는 최신 게시글 목록의 deep OFFSET이 2코어 CPU를 포화시켜 **모든 API가 연쇄적으로 무너졌습니다** (에러율 32.53%).
> After에서는 COUNT(*) 제거 + 30페이지 제한 + Deferred Join 조합으로 CPU 병목이 해소되어 **전 API가 ms 단위로 복귀**했습니다.

#### 검색 빈도별 성능 비교 (load 테스트)

![Grafana — 검색 빈도별 평균/P95 응답시간](/uploads/project/WikiEngine/query-refactoring-optimization/phase6-load-grafana-k6-detail.png)

k6 스크립트에서 검색어를 빈도별로 분류하여 Lucene posting list 길이에 따른 성능 차이를 측정했습니다:

| 빈도 | 비율 | 평균 | P95 | 특성 |
|------|------|------|-----|------|
| 희귀 토큰 | 10% | 20.36ms | 60.86ms | posting list 짧음, 캐시 miss 위주 |
| 중빈도 토큰 | 60% | 18.35ms | 48.29ms | 일반 사용자 검색 패턴 |
| 고빈도 토큰 | 30% | 24.77ms | 63.72ms | posting list 길음, 스트레스 |

고빈도 토큰(대한민국, 역사 등)이 중빈도 대비 평균 35% 느립니다.
posting list가 길수록 더 많은 문서를 스코어링해야 하므로 Lucene의 구조적 특성입니다.
다만 고빈도에서도 P95 63.72ms로 충분히 빠르며, **부하 테스트 기준 SLA(P95 < 300ms)를 여유있게 충족**합니다.

### Grafana 대시보드 — k6

![k6 Grafana Overview — 평균 30.1ms, P95 119ms, P99 228ms, 에러율 0%](/uploads/project/WikiEngine/query-refactoring-optimization/phase6-load-grafana-k6-overview.png)

- 평균 응답시간 30.1ms, P95 119ms, P99 228ms
- 처리량: 평균 17.6 req/s, 피크 58.8 req/s (100 VU 구간)
- 동시 사용자: 최대 100 VU
- 에러율: 0%

### MySQL 지표 비교

![Grafana MySQL — QPS 300, Buffer Pool 100%, Slow Queries 95.4K](/uploads/project/WikiEngine/query-refactoring-optimization/phase6-load-grafana-mysql.png)

| MySQL 지표 | Before | After | 변화 |
|-----------|--------|-------|------|
| QPS (피크) | 30~50 | **~300** | **6배 증가** (CPU 여유로 더 많은 쿼리 처리) |
| InnoDB Buffer Pool 히트율 | 100% | **100%** | 동일 (디스크 I/O 없음) |
| Slow Queries (누적) | 79,505건 | 95,400건 | +15,895건 (smoke+load 합산) |
| Table Locks | — | **0** | 락 경합 없음 |

> **QPS 6배 증가**: Before에서는 CPU 포화로 30~50 QPS가 한계였지만, After에서는 CPU 여유가 생기면서 동일 100 VU에서 ~300 QPS를 처리합니다.

### 인프라 지표 비교

![Grafana Infrastructure — CPU ~35%, Load Average ~3](/uploads/project/WikiEngine/query-refactoring-optimization/phase6-load-grafana-infrastructure.png)

![Grafana Containers — App CPU ~90%, MySQL ~10%](/uploads/project/WikiEngine/query-refactoring-optimization/phase6-load-grafana-containers.png)

| 인프라 지표 | Before | After | 변화 |
|-----------|--------|-------|------|
| Host CPU (피크) | **100% (포화)** | **~35%** | CPU 포화 해소 |
| Load Average (1m) | **20+** | **~3** | 85% 감소 |
| App Container CPU | 100% | ~90% (피크) | 여유 확보 |
| JVM 스레드 수 | 20→**120** | 28→**34** | 스레드 폭증 해소 |

### Spring Boot 지표

![Spring Boot HTTP — 평균 응답시간, 처리량](/uploads/project/WikiEngine/query-refactoring-optimization/phase6-load-grafana-springboot-http.png)

![Spring Boot JVM — Heap 안정, GC Pause ~1ms](/uploads/project/WikiEngine/query-refactoring-optimization/phase6-load-grafana-springboot-jvm.png)

![Spring Boot HikariCP — Active 20, Pending 0](/uploads/project/WikiEngine/query-refactoring-optimization/phase6-load-grafana-springboot-hikari.png)

![Spring Boot System — App CPU 60%, 스레드 34](/uploads/project/WikiEngine/query-refactoring-optimization/phase6-load-grafana-springboot-system.png)

| Spring Boot 지표 | Before | After | 변화 |
|----------------|--------|-------|------|
| JVM Heap | OldGen 증가 추세 | **안정** (1 GiB 내) | 메모리 압박 해소 |
| GC Pause | — | **~1ms** | 정상 |
| HikariCP Active | 20 (풀 고갈) | **20** (정상 사용) | Pending 0 |
| HikariCP Acquire Time | — | **0.03~0.05ms** | 커넥션 즉시 획득 |
| App CPU | 100% | **~60%** | 40% 여유 |
| System CPU | 100% | **~70%** (피크) | 30% 여유 |

---

## 출처

**OFFSET 페이지네이션:**
- [Use The Index, Luke — No Offset](https://use-the-index-luke.com/no-offset)
- [Percona — Efficient Pagination Using Deferred Joins](https://www.percona.com/blog/efficient-pagination-using-deferred-joins/)
- [High Performance MySQL, 4th Edition — Optimizing LIMIT and OFFSET](https://www.oreilly.com/library/view/high-performance-mysql/9781492080503/)

**COUNT(*) 제거 / 페이지네이션 트레이드오프:**
- [Google Drops Result Count From Search Results Page — Search Engine Roundtable (2024)](https://www.seroundtable.com/google-drops-result-count-from-search-results-page-37348.html)
- [Evolving API Pagination at Slack — Slack Engineering](https://slack.engineering/evolving-api-pagination-at-slack/)
- [Percona — COUNT(*) for InnoDB Tables](https://www.percona.com/blog/count-for-innodb-tables/)
- [Spring Data JPA — Slice vs Page](https://docs.spring.io/spring-data/jpa/reference/jpa/query-methods.html)
- [JHipster — Boost Infinite Scroll Performance with Slice](https://www.jhipster.tech/tips/019_tip_infinite_scroll_with_slice.html)
- [Estimated Counts for Faster Django Admin — SquadStack Engineering](https://medium.com/squad-engineering/estimated-counts-for-faster-django-admin-change-list-963cbf43683e)

**네이버 검색 페이지네이션:**
- [SerpApi — Naver Search Engine Results API](https://serpapi.com/naver-search-api)
- [SearchAPI — Naver Search API Documentation](https://www.searchapi.io/docs/naver-api)

**Spring Data JPA Slice + nativeQuery 이슈:**
- [Spring Data JPA #2260 — NativeQuery with Pagination](https://github.com/spring-projects/spring-data-jpa/issues/2260)
- [Spring Data JPA #1782 — Slice returns PageImpl and executes COUNT with nativeQuery (DATAJPA-1464)](https://github.com/spring-projects/spring-data-jpa/issues/1782)
- [Pagination in Spring Data JPA: Issues, Solutions, and 2026 Best Practices](https://copyprogramming.com/howto/issue-of-pagination-in-spring-data-jpa)
- [Vlad Mihalcea — Query Pagination with JPA and Hibernate](https://vladmihalcea.com/query-pagination-jpa-hibernate/)
- [GitHub Gist — Limit results using Specifications without count query](https://gist.github.com/tcollins/0ebd1dfa78028ecdef0b)

**페이지네이션 UX:**
- [Nielsen Norman Group — Users' Pagination Preferences and "View All"](https://www.nngroup.com/articles/item-list-view-all/)
- [Design Better Pagination — Andrew Coyle](https://coyleandrew.medium.com/design-better-pagination-a022a3b161e1)
- [UX Patterns for Developers — Pagination Pattern](https://uxpatterns.dev/patterns/navigation/pagination)

**API 페이지네이션 설계:**
- [REST API Pagination Best Practices — Speakeasy](https://www.speakeasy.com/api-design/pagination)
- [API Pagination Explained: Techniques & Best Practices — QuarkAndCode](https://medium.com/@QuarkAndCode/api-pagination-explained-techniques-best-practices-real-world-tips-825ff43e3088)
- [Slack Developer Docs — Pagination](https://docs.slack.dev/apis/web-api/pagination/)

**스레드풀 튜닝:**
- [Zalando Engineering — How to Set an Ideal Thread Pool Size](https://engineering.zalando.com/posts/2019/04/how-to-set-an-ideal-thread-pool-size.html)
- [HikariCP — About Pool Sizing](https://github.com/brettwooldridge/HikariCP/wiki/About-Pool-Sizing)

**k6 부하 테스트:**
- [k6 — Test Types (smoke, load, stress, soak)](https://k6.io/docs/test-types/)
- [k6 — Thresholds](https://k6.io/docs/using-k6/thresholds/)

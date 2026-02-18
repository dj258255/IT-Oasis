---
title: 'FULLTEXT ngram 인덱스'
titleEn: 'FULLTEXT ngram Index'
description: B-Tree 인덱스의 한계를 넘어 FULLTEXT ngram 역색인으로 LIKE 검색을 대체하고, 57만 건 한국어 데이터에서 12초→6ms로 약 2,100배 성능을 개선한 과정과 ngram의 알려진 한계점을 정리한다.
descriptionEn: Replaces LIKE search with FULLTEXT ngram inverted index beyond B-Tree limitations, achieving ~2,100x performance improvement from 12s to 6ms on 570K Korean documents, and documents known ngram limitations.
date: 2026-02-12T00:00:00.000Z
tags:
  - MySQL
  - FULLTEXT
  - ngram
  - Inverted Index
  - Information Retrieval
  - BOOLEAN MODE
category: 프로젝트/WikiEngine
draft: false
---

## 이전 단계 요약

자동완성(`LIKE 'prefix%'`)에 B-Tree 복합 인덱스를 추가하여 타임아웃을 해소했습니다.
(EXPLAIN rows 27,440,000 -> 1, >5,000ms -> 8ms)

하지만 검색(`LIKE '%keyword%'`)은 선행 와일드카드이므로 B-Tree 인덱스를 사용할 수 없습니다.
여전히 Full Table Scan -> 5초 타임아웃 -> 검색 기능 사용 불가 상태입니다.

---

## 1. 검색의 기대 동작

사용자가 검색어를 입력하면, 제목 또는 본문에 해당 키워드가 포함된 게시글을 반환하는 기능입니다.

1단계에서는 제목과 본문을 모두 검색하되, 최신순(`ORDER BY created_at DESC`)으로 정렬했습니다:

![](/uploads/프로젝트/WikiEngine/fulltext-ngram-index/search-expected.png)


하지만 content(LONGTEXT) 스캔이 커넥션 풀을 고갈시켜 시스템을 마비시켰고, 긴급 조치로 content 검색을 제거한 상태입니다.

현재는 title만 검색하고 있으며, 이번 단계에서 FULLTEXT 인덱스를 title + content 모두에 적용하여 본문 검색을 복원하고, 정렬도 관련도순으로 전환합니다.

---

## 2. 문제 상태 — 검색 100% 타임아웃

인덱스 적용 후에도 검색 쿼리는 변함없이 타임아웃이 발생합니다.

![](/uploads/프로젝트/WikiEngine/fulltext-ngram-index/search-timeout.png)

### EXPLAIN 확인

![](/uploads/프로젝트/WikiEngine/fulltext-ngram-index/explain-before-1.png)
![](/uploads/프로젝트/WikiEngine/fulltext-ngram-index/explain-before-2.png)

| 항목            | 값                               | 의미                         |
| ------------- | ------------------------------- | -------------------------- |
| type          | **ALL**                         | Full Table Scan            |
| possible_keys | **NULL**                        | 사용 가능한 인덱스 없음              |
| key           | **NULL**                        | 실제 사용한 인덱스 없음              |
| rows          | **27,440,000**                  | 전체 행 스캔 (InnoDB 옵티마이저 추정치) |
| Extra         | **Using where; Using filesort** | WHERE 필터 + 정렬 모두 디스크 처리    |

> **참고:** EXPLAIN의 rows=27,440,000은 InnoDB 옵티마이저의 추정치입니다.
> 실제 `COUNT(*)`로 측정한 행 수는 14,768,700건이며, InnoDB는 통계 샘플링 방식의 한계로 실제와 2~5배 차이가 날 수 있습니다.
> 이후 실측값을 기준으로 분석합니다.

자동완성은 동작하지만, 검색은 여전히 사용 불가.
1,477만 건의 데이터에서 키워드로 문서를 찾을 수 없는 상태입니다.

---

## 3. 대안 검토 — 왜 FULLTEXT ngram인가

### B-Tree 인덱스의 한계

`LIKE '%keyword%'`는 선행 와일드카드입니다.
B-Tree 인덱스는 값의 **앞부분부터 정렬**되어 있으므로, 키워드가 문자열 어디에 위치하는지 알 수 없어 인덱스를 사용할 수 없습니다.

```
B-Tree 인덱스 (title)
  "대한민국" -> "대한민국의 역사" -> "대한항공" -> "페텔기우스" -> ...
```

- `LIKE '페텔%'` -> "페" 위치부터 range scan 가능
- `LIKE '%페텔%'` -> "페텔"이 문자열 어디에 있는지 알 수 없음 -> 전체 스캔

이것은 B-Tree 자료구조의 본질적 한계입니다. B-Tree가 해결하는 것은 "이 값으로 시작하는 행을 찾아라"이고, 지금 필요한 것은 "이 값이 어딘가에 포함된 행을 찾아라"입니다.

자료구조 자체가 다른 문제를 풀고 있으므로, B-Tree 위에서 아무리 튜닝해도 해결할 수 없습니다.

그렇다면 "특정 키워드가 포함된 문서를 빠르게 찾는" 자료구조는 무엇일까?
이 질문에서 출발하여 정보 검색(Information Retrieval) 분야를 학습하게 되었습니다.

### 역색인 — IR 교재에서 찾은 해답

*Introduction to Information Retrieval* 3장(토큰과 텀)과 [정보검색의 이론과 실제] 2장(역색인)에서, 텍스트 검색의 핵심 자료구조가 **역색인(inverted index)**이라는 것을 학습했습니다.

역색인은 **사전(Dictionary)**과 **포스팅 목록(Posting List)**으로 구성됩니다.
사전은 문서 모음에 포함된 모든 텀의 목록이고, 각 텀은 해당 텀이 출현한 문서를 가리키는 포스팅 목록으로 연결됩니다.

```
사전(Dictionary)     포스팅 목록(Posting List)
  "페텔"          -> [문서13, 문서4521, ...]
  "한민"          -> [문서7, 문서42, 문서890, ...]
  "기우"          -> [문서13, 문서55, ...]
```

`LIKE '%keyword%'`가 느린 이유는 역색인이 없기 때문입니다.
역색인 없이는 키워드가 어떤 문서에 포함되어 있는지 알 수 없어 **모든 행을 읽어야** 합니다.
역색인이 있으면 키워드를 사전에서 찾고, 포스팅 목록에서 문서 ID를 바로 반환할 수 있습니다.

```
역색인 없이 (현재)
  LIKE '%페텔%' -> 14,768,700행 전부 읽기 -> 30초+

역색인 있으면
  "페텔" -> 사전에서 O(1) 탐색 -> 포스팅 목록 [문서13, 문서4521, ...] 반환 -> ms 단위
```

이것이 KMP, Trie, Bloom Filter 같은 문자열 알고리즘과의 근본적 차이입니다.
KMP는 **행 1개 안에서 비교 속도를 O(n*m) -> O(n+m)으로** 줄이는 것이고, 역색인은 **읽어야 할 행 수 자체를 줄이는 것**입니다.
병목은 문자열 비교가 아니라 1,477만 행을 디스크에서 읽는 I/O이므로, 역색인이 필요합니다.

### 역색인 구현 방식 비교

역색인이 필요하다는 것을 확인한 후, [MySQL 8.0 Full-Text Search 공식 문서](https://dev.mysql.com/doc/refman/8.0/en/fulltext-search.html)에서 MySQL이 내장 역색인(FULLTEXT 인덱스)을 지원한다는 것을 확인했습니다.
외부 검색엔진과 함께 구현 방식을 비교했습니다.

| 방식                           | 역색인 구현              | 장점                       | 단점                         | 판단    |
| ---------------------------- | ------------------- | ------------------------ | -------------------------- | ----- |
| **MySQL FULLTEXT ngram**     | MySQL 내장, ngram 토큰화 | 추가 인프라 불필요, 즉시 적용 가능     | 형태소 분석 미지원, false positive | **O** |
| **Elasticsearch**            | Lucene 기반 역색인       | 형태소 분석, BM25 스코어링, 분산 처리 | 클러스터 운영, 데이터 동기화, 인프라 비용   | 시기상조  |
| **PostgreSQL GIN + trigram** | GIN 인덱스 기반 역색인      | trigram으로 부분 문자열 검색      | MySQL에서 미지원, DB 마이그레이션 필요  | X     |

### Elasticsearch를 지금 도입하지 않는 이유

Elasticsearch도 내부적으로 Lucene의 역색인을 사용합니다.
궁극적 해결책이지만, 현 시점에서 도입하면:

1. **운영 복잡성**: 클러스터 운영, 모니터링, 장애 대응
2. **데이터 동기화**: MySQL <-> Elasticsearch 간 일관성 보장 (Debezium/CDC 추가 인프라)
3. **인프라 비용**: 최소 힙 16GB+, ARM 서버 메모리 한계
4. **현재 요구사항 대비 과잉**: title + content 키워드 검색이면 MySQL 내장 FULLTEXT로 충분

추가 인프라 없이 MySQL 내장 FULLTEXT ngram으로 먼저 검색을 동작시키고, 검색 품질 한계가 드러나는 시점에 Lucene으로 전환합니다.

---

## 4. 해결 — FULLTEXT ngram 인덱스

### ngram parser란

[MySQL 공식 문서: ngram Full-Text Parser](https://dev.mysql.com/doc/refman/8.0/en/fulltext-search-ngram.html)에 따르면, ngram parser는 텍스트를 n글자 단위로 쪼개서 토큰을 만들고, 각 토큰이 어떤 문서에 포함되어 있는지를 역색인으로 저장합니다.

**ngram_token_size=2 일 때:**

```
"대한민국" -> ["대한", "한민", "민국"]
"페텔기우스" -> ["페텔", "텔기", "기우", "우스"]

역색인
  "페텔" -> [문서13, 문서4521, ...]
  "텔기" -> [문서13, ...]
  "한민" -> [문서7, 문서42, 문서890, ...]
```

검색 시 `MATCH(title, content) AGAINST('페텔' IN BOOLEAN MODE)`을 실행하면, MySQL은 역색인에서 "페텔" 토큰을 찾아 해당 문서 ID들을 즉시 반환합니다.
1,477만 행을 스캔할 필요가 없습니다.

### ngram_token_size=2를 선택한 이유

`ngram_token_size`는 토큰의 글자 수를 결정하며, **이 값보다 짧은 단어는 인덱싱되지 않습니다.**
MySQL 공식 문서와 [MySQL 공식 한국어 블로그](https://dev.mysql.com/blog-archive/innodb-full-text-n-gram-parser-ko/)는 CJK(중국어/일본어/한국어)에서 2(bigram)를 권장합니다.

| token_size | 검색 가능 최소 단위 | 한국어 적합성 |
|:---:|---|---|
| 1 | 1글자 (`물`, `산`) | 한글 완성형이 ~11,172자뿐이라 거의 모든 문서에 매칭 -> 노이즈 극심 |
| **2** | 2글자 (`사랑`, `학교`) | **한국어 최빈 2음절 단어 정확 매칭, MySQL CJK 공식 권장** |
| 3 | 3글자 (`프로그`, `데이터`) | 1~2음절 단어(`사랑`, `학교`, `물`) 검색 불가 -> 치명적 |

전체 데이터는 영어 위키피디아(~1,420만 건)가 한국어 나무위키(~57만 건)보다 압도적으로 많지만, `ngram_token_size=2`는 영어에도 유효합니다.
영어 단어는 2글자 이상이 대부분이고, ngram parser는 공백을 하드코딩된 스탑워드로 처리하여 단어 단위 토큰화가 자연스럽게 이루어집니다.
CJK와 영어 모두에서 2가 최적입니다.

### BOOLEAN MODE를 선택한 이유

MySQL FULLTEXT는 두 가지 검색 모드를 제공합니다.
[MySQL 공식 문서: Boolean Full-Text Searches](https://dev.mysql.com/doc/refman/8.0/en/fulltext-boolean.html)와 [MySQL 공식 한국어 블로그](https://dev.mysql.com/blog-archive/innodb-full-text-n-gram-parser-ko/)를 참고하여 선택했습니다.

ngram parser에서 두 모드의 핵심 차이는 **검색어를 토큰으로 변환하는 방식**입니다:

| 모드                    | ngram 변환 방식             | 예시 (`'페텔기'` 검색) | 문제점                                                                |
| --------------------- | ----------------------- | --------------- | ------------------------------------------------------------------ |
| NATURAL LANGUAGE MODE | ngram **합집합** (OR)      | `페텔 OR 텔기`      | "페텔" 또는 "텔기"만 포함해도 매칭 → false positive 증가. 50% threshold로 흔한 토큰 무시 |
| **BOOLEAN MODE**      | ngram **구문 검색** (순서 매칭) | `"페텔 텔기"`       | "페텔" 다음에 "텔기"가 순서대로 있어야 매칭 → false positive 감소                     |

BOOLEAN MODE를 선택한 이유는 두 가지입니다:

1. **구문 검색 변환**: ngram 토큰이 순서대로 매칭되어야 하므로, NATURAL LANGUAGE MODE의 합집합 방식보다 false positive가 적습니다. 예를 들어 `'대한민국'`을 검색하면 BOOLEAN MODE는 `"대한 한민 민국"`(순서 매칭)으로 변환되어, "대한"만 포함된 문서는 제외됩니다.
2. **50% threshold 없음**: NATURAL LANGUAGE MODE는 전체 행의 50% 이상에 매칭되는 토큰을 무시합니다. 57만 건에서 흔한 한국어 2-gram 토큰(예: "한국", "대한")이 이 임계값을 넘을 수 있어 검색 결과가 누락됩니다.

### 인덱스 생성 전 테이블 측정

FULLTEXT 인덱스를 생성하기 전에, 현재 테이블의 디스크 크기와 content 컬럼의 통계를 먼저 측정했습니다.

테이블 디스크 크기 — 데이터 122GB, 인덱스 0MB:

![](/uploads/프로젝트/WikiEngine/fulltext-ngram-index/table-disk-size.png)

content 컬럼 통계 — 14,768,700행, 평균 6,586자, 최대 2,521,624자 (쿼리 소요 439초):

![](/uploads/프로젝트/WikiEngine/fulltext-ngram-index/content-stats.png)

**인덱스 생성 전 테이블 현황:**

| 항목 | 값 |
|------|-----|
| 총 행 수 | **14,768,700** (약 1,477만 건) |
| 데이터 크기 | **122 GB** (125,364 MB) |
| 기존 인덱스 크기 | 0 MB |
| 평균 title 길이 | 27자 |
| 평균 content 길이 | **6,586자** |
| 최대 content 길이 | **2,521,624자** (약 252만 자) |

**ngram 토큰 수 추정:**

| 대상 | 문서당 평균 토큰 수 | 총 토큰 수 |
|------|---------------------|------------|
| title만 | 26개 | ~3.8억 개 |
| content만 | 6,585개 | ~973억 개 |
| **title + content** | **~6,611개** | **~976억 개** |

content 포함 시 토큰 수가 title만 대비 **약 250배** 증가합니다.
인덱스 크기와 생성 시간이 크게 늘어날 것으로 예상됩니다.

### FULLTEXT 인덱스 생성

MySQL 서버 설정에 `ngram_token_size=2`를 추가한 후, 제목과 본문을 하나의 복합 FULLTEXT 인덱스로 생성합니다.

```yaml
# docker-compose.yml
command: >
  --character-set-server=utf8mb4
  --collation-server=utf8mb4_unicode_ci
  --ngram-token-size=2
```

```sql
CREATE FULLTEXT INDEX ft_title_content ON posts(title, content) WITH PARSER ngram;
```

### posts 테이블 인덱스 생성 시도 — 디스크 초과

1,477만 건 posts 테이블에 FULLTEXT ngram 인덱스를 생성했으나, 85분 경과 시점에 디스크가 가득 찼습니다.

![](/uploads/프로젝트/WikiEngine/fulltext-ngram-index/disk-exceeded.png)

[MySQL 공식 문서 (Online DDL Space Requirements)](https://dev.mysql.com/doc/refman/8.0/en/innodb-online-ddl-space-requirements.html)에 따르면, FULLTEXT 인덱스 생성 시 MySQL은 **임시 정렬 파일(temporary sort files)**을 생성합니다.
이 파일은 토큰을 정렬하여 역색인에 병합하기 위한 것으로, **테이블 데이터 + 기존 인덱스 크기만큼**의 추가 디스크를 사용합니다. 병합이 완료되면 자동으로 삭제됩니다.

```
인덱스 생성 중 필요한 디스크
= 원본 데이터(122GB) + 임시 정렬 파일(~122GB) + 최종 FULLTEXT 인덱스(생성 중)
= 300GB+ 필요
```

서버 디스크 여유(253GB)로는 감당할 수 없어 `KILL` 명령으로 인덱스 생성을 중단했습니다.

### 나무위키 데이터만 분리하여 실험

posts 테이블에는 인덱스를 생성할 수 없으므로, 범위를 좁혀야 합니다.
데이터의 카테고리별 분포를 확인했습니다:

| category_id | 데이터        |         행 수 |
| :---------: | ---------- | ----------: |
|      1      | 나무위키 (한국어) |     571,364 |
|      2      | 영/한 위키피디아  | ~14,197,336 |

전체 1,477만 건 중 나무위키(category_id=1)는 약 57만 건으로, **전체의 3.9%**입니다. 이 범위라면 FULLTEXT 인덱스 크기가 수십 MB 수준으로 예상되어, 디스크 문제 없이 실험할 수 있습니다.

나무위키를 먼저 선택한 이유는 두 가지입니다:
1. **한국어 ngram 검증**: `ngram_token_size=2`가 한국어 검색에 실제로 동작하는지 확인해야 함
2. **사용자 검색 패턴**: 서비스 특성상 한국어 검색이 주 사용 패턴

```sql
-- 한국어 데이터 전용 테이블 생성
CREATE TABLE tmp_namu_posts LIKE posts;

-- 배치 INSERT (5만 건씩, InnoDB 락 테이블 크기 제한으로 분할)
INSERT INTO tmp_namu_posts SELECT * FROM posts WHERE category_id = 1 ORDER BY id LIMIT 50000 OFFSET 0;
INSERT INTO tmp_namu_posts SELECT * FROM posts WHERE category_id = 1 ORDER BY id LIMIT 50000 OFFSET 50000;
-- ... (571,364건 완료)

-- FULLTEXT ngram 인덱스 생성 (57만 건 대상)
CREATE FULLTEXT INDEX ft_title_content ON tmp_namu_posts(title, content) WITH PARSER ngram;
```

> **배치 INSERT를 사용한 이유:** `CREATE TABLE AS SELECT`로 한 번에 복사하면 57만 건 x LONGTEXT를 하나의 트랜잭션으로 처리하게 됩니다.
> InnoDB는 트랜잭션 중 변경된 모든 행에 대해 락을 유지하는데, content(LONGTEXT)가 포함된 57만 행의 락이 `innodb_buffer_pool_size`를 초과하여 **Error 1206 (lock table size exceeded)**가 발생했습니다.
> 5만 건씩 분할하여 각 INSERT를 독립 트랜잭션으로 처리하면 락이 누적되지 않습니다.

| 항목 | posts 테이블 (posts) | 한국어만 (tmp_namu_posts) |
|------|-------------------|------------------------|
| 행 수 | 14,768,700 | 571,364 |
| 데이터 크기 | 122 GB | 12 GB |
| FULLTEXT 인덱스 크기 | 300 GB+ (디스크 초과) | **6.7 GB** |
| 인덱스 생성 | 중단 (85분 경과) | 성공 |

> **참고:** `information_schema.tables.index_length`는 B-Tree 인덱스만 포함하며, InnoDB FULLTEXT 인덱스는 별도의 FTS 보조 테이블(`fts_*`)에 저장됩니다.
> 실제 FULLTEXT 인덱스 크기는 MySQL 데이터 디렉토리에서 FTS 파일 크기를 합산해야 정확합니다.

![](/uploads/프로젝트/WikiEngine/fulltext-ngram-index/namu-posts-index.png)

### 검색 쿼리 변경

Spring Data JPA의 JPQL(Java Persistence Query Language)은 JPA 스펙에 정의된 SQL-like 문법만 지원합니다.
`MATCH...AGAINST`는 MySQL 고유 구문(vendor-specific syntax)이므로 JPQL에서 파싱할 수 없어, `nativeQuery = true`로 MySQL에 직접 SQL을 전달해야 합니다.

정렬도 기존 `created_at DESC`(최신순)에서 `MATCH...AGAINST` 반환값(관련도 스코어) 기반으로 전환합니다.
FULLTEXT 검색에서 `MATCH...AGAINST`는 0 이상의 부동소수점 값을 반환하며, 이 값이 높을수록 검색어와의 관련도가 높습니다.

검색 대상 테이블을 `tmp_namu_posts`로 변경하여, 한국어 데이터에 대해서만 FULLTEXT 검색을 수행합니다.

```java
@Query(value = """
    SELECT * FROM tmp_namu_posts
    WHERE MATCH(title, content) AGAINST(:keyword IN BOOLEAN MODE)
    ORDER BY MATCH(title, content) AGAINST(:keyword IN BOOLEAN MODE) DESC, created_at DESC
    LIMIT :#{#pageable.pageSize}
    OFFSET :#{#pageable.offset}
    """,
    countQuery = """
    SELECT COUNT(*) FROM tmp_namu_posts
    WHERE MATCH(title, content) AGAINST(:keyword IN BOOLEAN MODE)
    """,
    nativeQuery = true)
Page<Post> searchByKeyword(@Param("keyword") String keyword, Pageable pageable);
```

---

## 5. Before vs After

> 동일 데이터(tmp_namu_posts, 57만 건)에 동일 검색어("페텔")로 비교했습니다.
> Before는 인덱스 없이 `LIKE` 검색, After는 FULLTEXT ngram 인덱스 적용 후 `MATCH AGAINST` 검색입니다.

### EXPLAIN 비교

![](/uploads/프로젝트/WikiEngine/fulltext-ngram-index/explain-like-before.png)
![](/uploads/프로젝트/WikiEngine/fulltext-ngram-index/explain-fulltext-after.png)

| 구분 | type | key | rows | Extra |
|------|------|-----|------|-------|
| Before — `LIKE '%페텔%'` | ALL | NULL | 577,017 | Using where; Using filesort |
| After — `MATCH AGAINST` | fulltext | ft_title_content | 1 | Using where; Ft_hints: sorted, limit = 20 |

- **type**: ALL(전체 행 스캔) → fulltext(역색인 탐색). 스캔 방식 자체가 바뀌었습니다.
- **rows**: 577,017 → 1. 옵티마이저가 역색인에서 바로 결과를 가져오므로 추정 스캔 행이 1입니다.
- **Extra**: `Using filesort`(디스크 정렬) → `Ft_hints: sorted, limit = 20`. FULLTEXT 엔진이 관련도순 정렬과 LIMIT을 내부적으로 처리하여 별도 정렬이 불필요합니다.

### 응답시간 측정

Before — `LIKE '%페텔%'`: 12.766초, 6건 반환 (title만 검색):

![](/uploads/프로젝트/WikiEngine/fulltext-ngram-index/like-response-time.png)
![](/uploads/프로젝트/WikiEngine/fulltext-ngram-index/like-results.png)

After — `MATCH(title, content) AGAINST('페텔' IN BOOLEAN MODE)`: 0.006초, 20건 반환 (title + content 검색):

![](/uploads/프로젝트/WikiEngine/fulltext-ngram-index/fulltext-response-time.png)
![](/uploads/프로젝트/WikiEngine/fulltext-ngram-index/fulltext-results.png)

| 항목              | Before (LIKE)   | After (FULLTEXT)      | 비고                           |
| --------------- | --------------- | --------------------- | ---------------------------- |
| 응답시간            | 12,766ms        | **6ms**               | **약 2,100배 개선**              |
| 검색 결과 수         | 6건 (title만)     | 20건 (title + content) | 본문 검색 복원                     |
| 스캔 방식           | Full Table Scan | 역색인 탐색                | EXPLAIN type: ALL → fulltext |
| 정렬 방식           | filesort (디스크)  | FULLTEXT 엔진 내부 정렬     | 별도 정렬 비용 제거                  |
| 테이블 크기          | —               | 12 GB (57만 건)         | tmp_namu_posts 데이터           |
| FULLTEXT 인덱스 크기 | 없음              | 6.7 GB                | 데이터 대비 약 56%                 |

### 결과 수 차이 — 6건 vs 20건

Before(6건)와 After(20건)의 결과 수 차이는 **검색 범위**가 다르기 때문입니다.

- **Before**: `LIKE '%페텔%'`는 **title만** 검색합니다.
  1단계에서 content(LONGTEXT) 스캔이 커넥션 풀을 고갈시켜 시스템을 마비시켰고, 긴급 조치로 content 검색을 제거한 상태였습니다.
  57만 건 중 제목에 "페텔"이 포함된 문서는 6건뿐입니다.
- **After**: `MATCH(title, content)`는 **title + content 모두** 검색합니다.
  FULLTEXT 인덱스 덕분에 content를 스캔하지 않고 역색인에서 토큰을 찾으므로, 본문 검색을 복원해도 성능 문제가 없습니다.
  제목에는 없지만 본문에서 "페텔기우스"를 언급하는 문서(예: 별자리, 천문학 관련 문서)가 추가로 매칭됩니다.

즉, FULLTEXT 인덱스는 **속도 개선뿐 아니라 검색 품질(recall) 개선**도 함께 달성했습니다.
기존에는 성능 문제로 포기했던 본문 검색이 복원되면서, 같은 검색어로 더 많은 관련 문서를 찾을 수 있게 되었습니다.

---

## 6. 알려진 한계점

ngram FULLTEXT는 `LIKE '%keyword%'` 대비 극적인 성능 개선을 제공하지만, 다음과 같은 한계가 있습니다.

### 6-1. False Positive (오탐)

2-gram 토큰화는 단어 경계 정보를 보존하지 않습니다.

```
"한국어" 검색 시:
  토큰: ["한국", "국어"]

매칭되는 문서:
  ✓ "한국어 문법"     -> 의도한 결과
  ✗ "대한국제공항"     -> "한국" 토큰이 매칭 (오탐)
  ✗ "미국어학연수"     -> "국어" 토큰이 매칭 (오탐)
```

### 6-2. 형태소 분석 미지원

ngram은 글자 단위로 잘라낼 뿐 형태소 분석을 수행하지 않습니다.

```
"대한민국을" -> ["대한", "한민", "민국", "국을"]
"대한민국"   -> ["대한", "한민", "민국"]

-> "국을" 토큰이 달라서 검색 정확도 하락
```

### 6-3. 고빈도 토큰 성능 저하 ([MySQL Bug #85880](https://bugs.mysql.com/bug.php?id=85880))

"한국", "대한" 같은 흔한 2-gram 토큰이 수만 건 이상 매칭되면, MySQL 내부적으로 역색인의 포스팅 리스트를 직렬 탐색하여 성능이 급격히 저하됩니다.

이 문제는 InnoDB FULLTEXT 내부 구현(`fts0que.cc`)에서 토큰 매칭 결과를 **vector(배열) 순차 탐색**으로 교집합을 구하기 때문에 발생합니다.
알고리즘 수준의 비효율이므로 파라미터 튜닝으로는 해결할 수 없습니다.
Bug #85880은 2017년 보고 이후 2026년 현재까지 Open(미해결) 상태이며, 보고자가 제출한 패치도 Oracle이 merge하지 않았습니다.

MySQL 자체 튜닝 가능성을 검토한 결과:

| 방법 | 효과 | 판단 |
|------|------|------|
| `innodb_ft_result_cache_limit` 증가 | X — 메모리 상한만 조절, 탐색 알고리즘 그대로 | 효과 없음 |
| `ngram_token_size` 3으로 증가 | 고빈도 2-gram 문제 감소 | **"한국", "사과", "경제" 등 2글자 검색 불가** → 한국어에서 치명적 |
| 커스텀 스톱워드 ("대한" 등 제거) | 해당 토큰 타임아웃 해소 | **해당 단어 포함 검색 자체 불가능** → 위키 검색에서 허용 불가 |
| WHERE 조건 추가로 범위 축소 | X — MySQL은 FULLTEXT를 먼저 전체 스캔 후 WHERE 적용 | FULLTEXT 단계 병목 그대로 |

Lucene의 Nori 형태소 분석기는 "대한민국"을 형태소 단위로 분석하므로, ngram의 고빈도 2-gram 토큰 문제가 원천적으로 발생하지 않습니다.

### 6-4. 인덱스 크기와 생성 비용

![](/uploads/프로젝트/WikiEngine/fulltext-ngram-index/index-size-1.png)

![](/uploads/프로젝트/WikiEngine/fulltext-ngram-index/index-size-2.png)


title + content 복합 FULLTEXT 인덱스는 content(LONGTEXT)의 모든 2-gram 토큰을 역색인에 포함하므로 인덱스 크기가 상당합니다.

한국어 57만 건(데이터 12GB)에 대해서도 FULLTEXT 인덱스가 **6.7GB**(데이터 대비 56%)를 차지합니다.

Posts 테이블(1,477만 건, 122GB)에 인덱스를 생성했을 때는 **300GB를 초과**하여 서버 디스크(여유 253GB)로 감당이 불가능했습니다.
전체 데이터 검색을 위해서는 Lucene 전환이 필수적입니다.

> **결론:** ngram FULLTEXT는 "검색이 아예 안 되는 상태"를 "제목 + 본문 검색이 동작하는 상태"로 전환하는 데 효과적입니다. 검색 품질(정확도, 형태소 분석)은 6단계 Lucene + Nori 형태소 분석기로 해결합니다.

---

## 7. 현재 위치와 남은 문제

**해결된 것:**
- 자동완성 `LIKE 'prefix%'` -> B-Tree 인덱스
- 검색 `LIKE '%keyword%'` -> FULLTEXT ngram 인덱스 (한국어 57만 건 대상)

**확인된 한계:**
- **인덱스 크기**: posts 테이블(1,477만 건) 대상 FULLTEXT ngram 인덱스가 300GB+로, 현재 서버 디스크로 감당 불가. 한국어 데이터만 분리하여 우회 중
- **검색 범위**: 현재 한국어(나무위키) 데이터만 검색 가능, 영어 위키 데이터는 검색 대상에서 제외
- **검색 품질**: False Positive, 형태소 분석 미지원
- **고빈도 토큰 타임아웃**: "페텔"처럼 희귀한 토큰은 6ms 만에 406건을 반환하지만, "대한"처럼 수만 건 이상의 문서에 등장하는 고빈도 토큰은 포스팅 리스트 탐색에 5초 이상 소요되어 타임아웃이 발생한다. MySQL Bug #85880에 해당하는 문제로, 내부 알고리즘(vector 순차 탐색) 수준의 비효율이라 파라미터 튜닝으로는 해결 불가능하다

<!-- EN -->

## Previous Step Summary

Added a B-Tree composite index to autocomplete (`LIKE 'prefix%'`) to resolve the timeout.
(EXPLAIN rows 27,440,000 -> 1, >5,000ms -> 8ms)

However, search (`LIKE '%keyword%'`) uses a leading wildcard, so it cannot use B-Tree indexes.
Still in Full Table Scan -> 5-second timeout -> search functionality unusable state.

---

## 1. Expected Search Behavior

When a user enters a search term, the system returns posts containing that keyword in the title or body.

In step 1, both title and body were searched, sorted by newest first (`ORDER BY created_at DESC`):

![](/uploads/프로젝트/WikiEngine/fulltext-ngram-index/search-expected.png)

However, content (LONGTEXT) scanning exhausted the connection pool and brought the system down, so content search was removed as an emergency measure.

Currently only title is searched. In this step, we apply FULLTEXT index to both title + content to restore body search and switch sorting to relevance-based.

---

## 2. Problem State -- 100% Search Timeout

Even after applying indexes, search queries consistently time out.

![](/uploads/프로젝트/WikiEngine/fulltext-ngram-index/search-timeout.png)

### EXPLAIN Analysis

![](/uploads/프로젝트/WikiEngine/fulltext-ngram-index/explain-before-1.png)
![](/uploads/프로젝트/WikiEngine/fulltext-ngram-index/explain-before-2.png)

| Item | Value | Meaning |
|------|-------|---------|
| type | **ALL** | Full Table Scan |
| possible_keys | **NULL** | No available indexes |
| key | **NULL** | No index used |
| rows | **27,440,000** | Full row scan (InnoDB optimizer estimate) |
| Extra | **Using where; Using filesort** | WHERE filter + sort both processed on disk |

> **Note:** EXPLAIN's rows=27,440,000 is an InnoDB optimizer estimate. The actual row count measured with `COUNT(*)` is 14,768,700. InnoDB's statistical sampling can differ from actual by 2-5x. Subsequent analysis uses actual measurements.

Autocomplete works, but search remains unusable. Cannot find documents by keyword across 14.77 million records.

---

## 3. Alternative Evaluation -- Why FULLTEXT ngram

### B-Tree Index Limitations

`LIKE '%keyword%'` uses a leading wildcard. B-Tree indexes are sorted **from the beginning of values**, so they cannot determine where a keyword is located within a string and thus cannot use the index.

```
B-Tree index (title)
  "대한민국" -> "대한민국의 역사" -> "대한항공" -> "페텔기우스" -> ...
```

- `LIKE '페텔%'` -> Can range scan from the "페" position
- `LIKE '%페텔%'` -> Cannot determine where "페텔" is in the string -> full scan

This is a fundamental limitation of the B-Tree data structure. B-Tree solves "find rows starting with this value," but what we need is "find rows containing this value somewhere." Since the data structure is solving a different problem, no amount of tuning on B-Tree can solve this.

Then what data structure can "quickly find documents containing a specific keyword"? This question led us to study the field of Information Retrieval (IR).

### Inverted Index -- The Answer from IR Textbooks

From *Introduction to Information Retrieval* Chapter 3 (Tokens and Terms) and [Theory and Practice of Information Retrieval] Chapter 2 (Inverted Index), we learned that the core data structure for text search is the **inverted index**.

An inverted index consists of a **Dictionary** and **Posting Lists**. The dictionary is a list of all terms in the document collection, and each term links to a posting list pointing to documents where that term appears.

```
Dictionary          Posting List
  "페텔"          -> [doc13, doc4521, ...]
  "한민"          -> [doc7, doc42, doc890, ...]
  "기우"          -> [doc13, doc55, ...]
```

The reason `LIKE '%keyword%'` is slow is the absence of an inverted index. Without one, there is no way to know which documents contain the keyword, so **every row must be read**. With an inverted index, you look up the keyword in the dictionary and immediately return document IDs from the posting list.

```
Without inverted index (current)
  LIKE '%페텔%' -> Read all 14,768,700 rows -> 30s+

With inverted index
  "페텔" -> O(1) dictionary lookup -> posting list [doc13, doc4521, ...] -> ms range
```

This is the fundamental difference from string algorithms like KMP, Trie, or Bloom Filter. KMP **reduces comparison speed within a single row from O(n*m) to O(n+m)**, while inverted indexes **reduce the number of rows that need to be read**. The bottleneck is not string comparison but disk I/O reading 14.77 million rows, so an inverted index is needed.

### Inverted Index Implementation Comparison

After confirming the need for an inverted index, the [MySQL 8.0 Full-Text Search documentation](https://dev.mysql.com/doc/refman/8.0/en/fulltext-search.html) confirmed MySQL supports built-in inverted indexes (FULLTEXT indexes). We compared implementation approaches with external search engines.

| Approach | Inverted Index Implementation | Pros | Cons | Decision |
|----------|------------------------------|------|------|----------|
| **MySQL FULLTEXT ngram** | MySQL built-in, ngram tokenization | No additional infrastructure, immediately applicable | No morphological analysis, false positives | **O** |
| **Elasticsearch** | Lucene-based inverted index | Morphological analysis, BM25 scoring, distributed processing | Cluster operations, data sync, infrastructure cost | Premature |
| **PostgreSQL GIN + trigram** | GIN index-based inverted index | Substring search via trigram | Not supported in MySQL, requires DB migration | X |

### Why Not Adopt Elasticsearch Now

Elasticsearch also uses Lucene's inverted index internally. It is the ultimate solution, but adopting it now means:

1. **Operational complexity**: Cluster operations, monitoring, incident response
2. **Data synchronization**: Ensuring consistency between MySQL <-> Elasticsearch (additional Debezium/CDC infrastructure)
3. **Infrastructure cost**: Minimum heap 16GB+, ARM server memory limits
4. **Overkill for current requirements**: Title + content keyword search is sufficient with MySQL built-in FULLTEXT

We first make search work with MySQL built-in FULLTEXT ngram without additional infrastructure, then transition to Lucene when search quality limitations become apparent.

---

## 4. Solution -- FULLTEXT ngram Index

### What is ngram Parser

According to [MySQL documentation: ngram Full-Text Parser](https://dev.mysql.com/doc/refman/8.0/en/fulltext-search-ngram.html), the ngram parser splits text into n-character tokens and stores which documents contain each token in an inverted index.

**When ngram_token_size=2:**

```
"대한민국" -> ["대한", "한민", "민국"]
"페텔기우스" -> ["페텔", "텔기", "기우", "우스"]

Inverted Index
  "페텔" -> [doc13, doc4521, ...]
  "텔기" -> [doc13, ...]
  "한민" -> [doc7, doc42, doc890, ...]
```

When executing `MATCH(title, content) AGAINST('페텔' IN BOOLEAN MODE)`, MySQL finds the "페텔" token in the inverted index and immediately returns matching document IDs. No need to scan 14.77 million rows.

### Why ngram_token_size=2

`ngram_token_size` determines the number of characters per token, and **words shorter than this value are not indexed**. MySQL documentation and the [MySQL official Korean blog](https://dev.mysql.com/blog-archive/innodb-full-text-n-gram-parser-ko/) recommend 2 (bigram) for CJK (Chinese/Japanese/Korean).

| token_size | Minimum Searchable Unit | Korean Suitability |
|:---:|---|---|
| 1 | 1 character (`물`, `산`) | Korean has only ~11,172 complete syllables, matching almost every document -> extreme noise |
| **2** | 2 characters (`사랑`, `학교`) | **Exact match for most frequent Korean 2-syllable words, MySQL CJK official recommendation** |
| 3 | 3 characters (`프로그`, `데이터`) | Cannot search 1-2 syllable words (`사랑`, `학교`, `물`) -> critical |

Overall data has far more English Wikipedia (~14.2M) than Korean Namuwiki (~570K), but `ngram_token_size=2` is also effective for English. Most English words are 2+ characters, and the ngram parser treats spaces as hardcoded stopwords, naturally achieving word-level tokenization. 2 is optimal for both CJK and English.

### Why BOOLEAN MODE

MySQL FULLTEXT provides two search modes. We chose based on [MySQL documentation: Boolean Full-Text Searches](https://dev.mysql.com/doc/refman/8.0/en/fulltext-boolean.html) and the [MySQL official Korean blog](https://dev.mysql.com/blog-archive/innodb-full-text-n-gram-parser-ko/).

The key difference between modes in ngram parser is **how the search term is converted to tokens**:

| Mode | ngram Conversion | Example (searching `'페텔기'`) | Issues |
|------|-----------------|--------------------------|--------|
| NATURAL LANGUAGE MODE | ngram **union** (OR) | `페텔 OR 텔기` | Matches if only "페텔" or "텔기" present -> more false positives. 50% threshold ignores common tokens |
| **BOOLEAN MODE** | ngram **phrase search** (order matching) | `"페텔 텔기"` | "페텔" followed by "텔기" in order required -> fewer false positives |

Two reasons for choosing BOOLEAN MODE:

1. **Phrase search conversion**: ngram tokens must match in order, resulting in fewer false positives than NATURAL LANGUAGE MODE's union approach. For example, searching `'대한민국'` converts to `"대한 한민 민국"` (order matching) in BOOLEAN MODE, excluding documents containing only "대한."
2. **No 50% threshold**: NATURAL LANGUAGE MODE ignores tokens matching 50%+ of all rows. Among 570K records, common Korean 2-gram tokens (e.g., "한국", "대한") could exceed this threshold, causing missing search results.

### Pre-Index Table Measurements

Before creating the FULLTEXT index, we measured the current table's disk size and content column statistics.

Table disk size -- Data 122GB, Index 0MB:

![](/uploads/프로젝트/WikiEngine/fulltext-ngram-index/table-disk-size.png)

Content column statistics -- 14,768,700 rows, average 6,586 chars, max 2,521,624 chars (query took 439s):

![](/uploads/프로젝트/WikiEngine/fulltext-ngram-index/content-stats.png)

**Pre-index table summary:**

| Item | Value |
|------|-------|
| Total rows | **14,768,700** (~14.77M) |
| Data size | **122 GB** (125,364 MB) |
| Existing index size | 0 MB |
| Average title length | 27 chars |
| Average content length | **6,586 chars** |
| Maximum content length | **2,521,624 chars** (~2.52M chars) |

**ngram token count estimate:**

| Target | Avg tokens per document | Total tokens |
|--------|------------------------|--------------|
| title only | 26 | ~380M |
| content only | 6,585 | ~97.3B |
| **title + content** | **~6,611** | **~97.6B** |

Including content increases token count by **~250x** compared to title only. Index size and creation time are expected to increase significantly.

### FULLTEXT Index Creation

After adding `ngram_token_size=2` to MySQL server settings, we create a composite FULLTEXT index on title and content.

```yaml
# docker-compose.yml
command: >
  --character-set-server=utf8mb4
  --collation-server=utf8mb4_unicode_ci
  --ngram-token-size=2
```

```sql
CREATE FULLTEXT INDEX ft_title_content ON posts(title, content) WITH PARSER ngram;
```

### Posts Table Index Attempt -- Disk Exceeded

Creating a FULLTEXT ngram index on the 14.77M row posts table failed when disk ran out after 85 minutes.

![](/uploads/프로젝트/WikiEngine/fulltext-ngram-index/disk-exceeded.png)

According to [MySQL documentation (Online DDL Space Requirements)](https://dev.mysql.com/doc/refman/8.0/en/innodb-online-ddl-space-requirements.html), MySQL creates **temporary sort files** during FULLTEXT index creation. These files sort tokens for merging into the inverted index, using additional disk space equal to **table data + existing index size**. They are automatically deleted after merging completes.

```
Disk needed during index creation
= Original data (122GB) + Temporary sort files (~122GB) + Final FULLTEXT index (in progress)
= 300GB+ required
```

Server disk headroom (253GB) was insufficient, so index creation was killed with the `KILL` command.

### Separating Namuwiki Data for Experimentation

Since index creation is impossible on the posts table, we need to narrow the scope. We checked the data distribution by category:

| category_id | Data | Rows |
|:-----------:|------|-----:|
| 1 | Namuwiki (Korean) | 571,364 |
| 2 | EN/KR Wikipedia | ~14,197,336 |

Namuwiki (category_id=1) is about 570K of the total 14.77M records, or **3.9% of total**. At this scale, the FULLTEXT index size is expected to be in the tens of MB range, enabling experimentation without disk issues.

Two reasons for choosing Namuwiki first:
1. **Korean ngram verification**: Need to confirm `ngram_token_size=2` actually works for Korean search
2. **User search patterns**: Korean search is the primary usage pattern given the service characteristics

```sql
-- Create Korean-only table
CREATE TABLE tmp_namu_posts LIKE posts;

-- Batch INSERT (50K per batch, split due to InnoDB lock table size limit)
INSERT INTO tmp_namu_posts SELECT * FROM posts WHERE category_id = 1 ORDER BY id LIMIT 50000 OFFSET 0;
INSERT INTO tmp_namu_posts SELECT * FROM posts WHERE category_id = 1 ORDER BY id LIMIT 50000 OFFSET 50000;
-- ... (571,364 rows completed)

-- Create FULLTEXT ngram index (570K target)
CREATE FULLTEXT INDEX ft_title_content ON tmp_namu_posts(title, content) WITH PARSER ngram;
```

> **Why batch INSERT:** Using `CREATE TABLE AS SELECT` processes 570K x LONGTEXT rows in a single transaction. InnoDB maintains locks on all modified rows during a transaction, and locks for 570K rows with content (LONGTEXT) exceeded `innodb_buffer_pool_size`, causing **Error 1206 (lock table size exceeded)**. Splitting into 50K batches makes each INSERT an independent transaction, preventing lock accumulation.

| Item | posts table | Korean only (tmp_namu_posts) |
|------|-------------|------------------------------|
| Rows | 14,768,700 | 571,364 |
| Data size | 122 GB | 12 GB |
| FULLTEXT index size | 300 GB+ (disk exceeded) | **6.7 GB** |
| Index creation | Aborted (85 min elapsed) | Succeeded |

> **Note:** `information_schema.tables.index_length` includes only B-Tree indexes. InnoDB FULLTEXT indexes are stored in separate FTS auxiliary tables (`fts_*`). Accurate FULLTEXT index size requires summing FTS file sizes in the MySQL data directory.

![](/uploads/프로젝트/WikiEngine/fulltext-ngram-index/namu-posts-index.png)

### Search Query Change

Spring Data JPA's JPQL (Java Persistence Query Language) only supports SQL-like syntax defined in the JPA spec. `MATCH...AGAINST` is MySQL vendor-specific syntax that JPQL cannot parse, requiring `nativeQuery = true` to pass SQL directly to MySQL.

Sorting also changes from `created_at DESC` (newest first) to `MATCH...AGAINST` return value (relevance score). In FULLTEXT search, `MATCH...AGAINST` returns a non-negative floating-point value where higher values indicate greater relevance.

The search target table is changed to `tmp_namu_posts` to perform FULLTEXT search only on Korean data.

```java
@Query(value = """
    SELECT * FROM tmp_namu_posts
    WHERE MATCH(title, content) AGAINST(:keyword IN BOOLEAN MODE)
    ORDER BY MATCH(title, content) AGAINST(:keyword IN BOOLEAN MODE) DESC, created_at DESC
    LIMIT :#{#pageable.pageSize}
    OFFSET :#{#pageable.offset}
    """,
    countQuery = """
    SELECT COUNT(*) FROM tmp_namu_posts
    WHERE MATCH(title, content) AGAINST(:keyword IN BOOLEAN MODE)
    """,
    nativeQuery = true)
Page<Post> searchByKeyword(@Param("keyword") String keyword, Pageable pageable);
```

---

## 5. Before vs After

> Compared on identical data (tmp_namu_posts, 570K rows) with the same search term ("페텔"). Before is `LIKE` search without index, After is `MATCH AGAINST` search with FULLTEXT ngram index applied.

### EXPLAIN Comparison

![](/uploads/프로젝트/WikiEngine/fulltext-ngram-index/explain-like-before.png)
![](/uploads/프로젝트/WikiEngine/fulltext-ngram-index/explain-fulltext-after.png)

| Case | type | key | rows | Extra |
|------|------|-----|------|-------|
| Before -- `LIKE '%페텔%'` | ALL | NULL | 577,017 | Using where; Using filesort |
| After -- `MATCH AGAINST` | fulltext | ft_title_content | 1 | Using where; Ft_hints: sorted, limit = 20 |

- **type**: ALL (full row scan) to fulltext (inverted index lookup). The scan method itself changed.
- **rows**: 577,017 to 1. The optimizer retrieves results directly from the inverted index, so estimated scan rows is 1.
- **Extra**: `Using filesort` (disk sort) to `Ft_hints: sorted, limit = 20`. The FULLTEXT engine handles relevance sorting and LIMIT internally, eliminating separate sorting.

### Response Time

Before -- `LIKE '%페텔%'`: 12.766s, 6 results (title only):

![](/uploads/프로젝트/WikiEngine/fulltext-ngram-index/like-response-time.png)
![](/uploads/프로젝트/WikiEngine/fulltext-ngram-index/like-results.png)

After -- `MATCH(title, content) AGAINST('페텔' IN BOOLEAN MODE)`: 0.006s, 20 results (title + content):

![](/uploads/프로젝트/WikiEngine/fulltext-ngram-index/fulltext-response-time.png)
![](/uploads/프로젝트/WikiEngine/fulltext-ngram-index/fulltext-results.png)

| Item | Before (LIKE) | After (FULLTEXT) | Note |
|------|--------------|------------------|------|
| Response time | 12,766ms | **6ms** | **~2,100x improvement** |
| Result count | 6 (title only) | 20 (title + content) | Body search restored |
| Scan method | Full Table Scan | Inverted index lookup | EXPLAIN type: ALL -> fulltext |
| Sort method | filesort (disk) | FULLTEXT engine internal sort | Separate sort cost eliminated |
| Table size | -- | 12 GB (570K rows) | tmp_namu_posts data |
| FULLTEXT index size | None | 6.7 GB | ~56% of data |

### Result Count Difference -- 6 vs 20

The difference between Before (6) and After (20) results is due to **different search scopes**.

- **Before**: `LIKE '%페텔%'` searches **title only**. In step 1, content (LONGTEXT) scanning exhausted the connection pool and brought the system down, so content search was removed as an emergency measure. Only 6 documents out of 570K have "페텔" in the title.
- **After**: `MATCH(title, content)` searches **both title and content**. Thanks to the FULLTEXT index, tokens are found in the inverted index without scanning content, so restoring body search causes no performance issues. Documents mentioning "페텔기우스" in the body (e.g., constellation, astronomy articles) are additionally matched.

In other words, the FULLTEXT index achieved **not only speed improvement but also search quality (recall) improvement**. With body search restored -- previously abandoned due to performance issues -- more relevant documents can be found with the same search term.

---

## 6. Known Limitations

ngram FULLTEXT provides dramatic performance improvement over `LIKE '%keyword%'`, but has the following limitations.

### 6-1. False Positives

2-gram tokenization does not preserve word boundary information.

```
Searching "한국어":
  Tokens: ["한국", "국어"]

Matching documents:
  O "한국어 문법"     -> intended result
  X "대한국제공항"     -> "한국" token matches (false positive)
  X "미국어학연수"     -> "국어" token matches (false positive)
```

### 6-2. No Morphological Analysis

ngram simply splits by character count without performing morphological analysis.

```
"대한민국을" -> ["대한", "한민", "민국", "국을"]
"대한민국"   -> ["대한", "한민", "민국"]

-> Different "국을" token reduces search accuracy
```

### 6-3. High-Frequency Token Performance Degradation ([MySQL Bug #85880](https://bugs.mysql.com/bug.php?id=85880))

When common 2-gram tokens like "한국" or "대한" match tens of thousands of documents, MySQL internally traverses the inverted index posting lists sequentially, causing dramatic performance degradation.

This occurs because InnoDB FULLTEXT's internal implementation (`fts0que.cc`) computes intersections of token match results using **vector (array) sequential traversal**. This is an algorithm-level inefficiency that cannot be resolved by parameter tuning. Bug #85880 was reported in 2017 and remains Open (unresolved) as of 2026, with patches submitted by the reporter not merged by Oracle.

MySQL self-tuning options reviewed:

| Method | Effect | Decision |
|--------|--------|----------|
| Increase `innodb_ft_result_cache_limit` | X -- Only adjusts memory ceiling, search algorithm unchanged | No effect |
| Increase `ngram_token_size` to 3 | Reduces high-frequency 2-gram issue | **Cannot search 2-char words like "한국", "사과", "경제"** -> critical for Korean |
| Custom stopwords (remove "대한", etc.) | Resolves timeout for that token | **Makes search for that word completely impossible** -> unacceptable for wiki search |
| Add WHERE conditions to narrow scope | X -- MySQL fully scans FULLTEXT first then applies WHERE | FULLTEXT stage bottleneck remains |

Lucene's Nori morphological analyzer analyzes "대한민국" at the morpheme level, so ngram's high-frequency 2-gram token problem does not occur at all.

### 6-4. Index Size and Creation Cost

![](/uploads/프로젝트/WikiEngine/fulltext-ngram-index/index-size-1.png)

![](/uploads/프로젝트/WikiEngine/fulltext-ngram-index/index-size-2.png)

The title + content composite FULLTEXT index includes all 2-gram tokens from content (LONGTEXT) in the inverted index, making the index size substantial.

Even for Korean-only 570K records (12GB data), the FULLTEXT index occupies **6.7GB** (56% of data).

When creating the index on the posts table (14.77M rows, 122GB), it **exceeded 300GB**, beyond the server disk capacity (253GB free). Transitioning to Lucene is essential for full data search.

> **Conclusion:** ngram FULLTEXT is effective for transitioning from "search completely broken" to "title + body search working." Search quality (precision, morphological analysis) will be addressed in step 6 with Lucene + Nori morphological analyzer.

---

## 7. Current Status and Remaining Issues

**Resolved:**
- Autocomplete `LIKE 'prefix%'` -> B-Tree index
- Search `LIKE '%keyword%'` -> FULLTEXT ngram index (targeting 570K Korean documents)

**Confirmed limitations:**
- **Index size**: FULLTEXT ngram index for posts table (14.77M rows) exceeds 300GB+, beyond current server disk capacity. Workaround by separating Korean data only
- **Search scope**: Currently only Korean (Namuwiki) data is searchable; English Wikipedia data is excluded from search
- **Search quality**: False positives, no morphological analysis
- **High-frequency token timeout**: Rare tokens like "페텔" return 406 results in 6ms, but high-frequency tokens like "대한" appearing in tens of thousands of documents take 5+ seconds for posting list traversal, causing timeout. This corresponds to MySQL Bug #85880, an algorithm-level inefficiency (vector sequential traversal) that cannot be resolved through parameter tuning

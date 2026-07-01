---
title: 'Lucene 검색 고도화 — 동의어 확장과 쿼리 이해'
titleEn: 'Lucene Query Enhancement — Synonym Expansion and Query Understanding'
description: Lucene 기반 검색 엔진에 동의어 처리(쿼리 확장)와 Query Understanding(오타 교정, 복합어 분리, 의도 파악)을 적용하는 설계를 정리합니다.
descriptionEn: Designs synonym expansion (query expansion) and query understanding (spelling correction, query segmentation, intent detection) for a Lucene-based search engine.
date: 2026-03-05T00:00:00.000Z
tags:
  - Lucene
  - Nori
  - Query Expansion
  - Synonym
  - Search Engine
category: personal/WikiEngine
draft: true
series: "WikiEngine"
---

## 이전 글

[MySQL 검색을 버리고 Lucene을 선택한 이유](/blog/project/wikiengine/lucene-decision)에서 임베디드 Lucene + Nori 형태소 분석기를 적용하여 1,425만 건 전체 검색을 구현했습니다.
이 글에서는 검색 품질을 더 높이기 위한 개선 로드맵과 구체적인 기법을 다룹니다.

---

## 0. 검색 고도화 로드맵

현재 구현은 BM25 기본 설정 + Nori 형태소 분석기로 동작합니다. 아래는 필요 시점에 적용할 개선 항목입니다.

### 0-1. BM25 변형 비교

| 변형 | 특징 | 적용 시점 |
|------|------|----------|
| BM25 (현재) | Lucene/ES/Solr 기본값, k1=1.2, b=0.75 | 현재 사용 중 |
| BM25+ | 긴 문서 패널티 보정 — 긴 문서가 불공정하게 낮은 점수를 받는 문제 해결 | 문서 길이 편차가 크고 긴 문서가 누락될 때 |
| BM25L | BM25+와 유사, 긴 문서 부스트 | 위와 동일 |
| BM25F | 필드별 가중치 (title, content 등을 스트림으로 분리) | 필드 가중치를 정밀 제어해야 할 때 |

[뉴스 코퍼스 3개 실험 결과](https://pmc.ncbi.nlm.nih.gov/articles/PMC7148026/), BM25 변형 간 유의미한 성능 차이는 없었습니다.
현재 `MultiFieldQueryParser`로 title:3, content:1 가중치를 이미 적용 중이므로, BM25F의 효과를 일부 대체하고 있습니다.
**결론: 기본 BM25에서 시작하고, 검색 품질 이슈가 실제로 발생하면 변형을 검토합니다.**

### 0-2. 검색 품질 개선

| 기능 | 설명 | 적용 시점 |
|------|------|----------|
| Nori 사용자 사전 | "운동화"를 "운동"+"화"로 분해하지 않고 단일 토큰 보존 | 복합어 분해로 검색 정확도가 떨어질 때 |
| Dual Field (title_exact) | StringField로 비분석 필드 추가, 붙여쓰기 매칭 | "나이키에어맥스"(붙여쓰기) 검색 실패 사례 발생 시 |
| Snippet 저장 | StoredField로 본문 200자 미리보기 저장 | 검색 결과에 미리보기 표시가 필요할 때 |
| BM25 k1/b 파라미터 튜닝 | k1: TF 포화 속도, b: 문서 길이 정규화 | k6 부하 테스트 후 검색 품질 A/B 테스트 |

### 0-3. 인덱싱 성능 개선

| 기능                      | 설명                                           | 적용 시점             |
| ----------------------- | -------------------------------------------- | ----------------- |
| 병렬 배치 인덱싱               | IndexWriter는 thread-safe, 2000건 x N스레드 병렬 처리 | 전체 리인덱싱이 다시 필요할 때 |
| Near Real-Time (NRT) 색인 | 새 게시글 작성/수정/삭제를 Lucene에 실시간 반영               | 구현 완료           |

---

## 1. 쿼리 확장: 동의어 처리

사용자가 "AI"를 검색했을 때 "인공지능" 문서도 함께 검색되도록 쿼리를 확장합니다.

### 동의어 사전 설계

```sql
CREATE TABLE synonyms (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  term VARCHAR(100) NOT NULL,
  synonym VARCHAR(100) NOT NULL,
  weight DOUBLE DEFAULT 1.0,
  INDEX idx_term (term),
  INDEX idx_synonym (synonym)
);

INSERT INTO synonyms (term, synonym, weight) VALUES
  ('AI', '인공지능', 1.0),
  ('인공지능', 'AI', 1.0),
  ('ML', '머신러닝', 1.0),
  ('머신러닝', 'ML', 1.0),
  ('DB', '데이터베이스', 1.0),
  ('데이터베이스', 'DB', 1.0);
```

### 대안: Lucene SynonymGraphFilter

Lucene은 `SynonymGraphFilter`를 네이티브 지원합니다. 인덱스 타임 또는 쿼리 타임에 분석기 체인에 동의어 맵을 주입하여 DB 조회 없이 동의어를 처리할 수 있습니다.

| 방식 | 장점 | 단점 |
|------|------|------|
| **DB 기반 쿼리 확장** (아래 구현) | 동의어 추가/삭제가 즉시 반영, 가중치 제어 가능 | 매 쿼리마다 DB 조회 추가 |
| **SynonymGraphFilter** (인덱스 타임) | DB 조회 없음, 분석기 체인에 통합 | 동의어 변경 시 전체 재색인 필요 |
| **SynonymGraphFilter** (쿼리 타임) | DB 조회 없음, 재색인 불필요 | Analyzer를 두 벌 관리해야 함 |

현재 동의어가 자주 변경될 수 있고, 가중치 제어가 필요하므로 DB 기반 방식을 먼저 설계합니다. 운영 안정화 후 SynonymGraphFilter(쿼리 타임)로 전환을 검토합니다.

### 쿼리 확장 구현

```java
@Service
public class QueryExpansionService {

    private final SynonymRepository synonymRepository;

    public List<ExpandedTerm> expandQuery(List<String> originalTerms) {
        List<ExpandedTerm> expanded = new ArrayList<>();

        for (String term : originalTerms) {
            expanded.add(new ExpandedTerm(term, 1.0, true));

            List<Synonym> synonyms = synonymRepository.findByTerm(term);
            for (Synonym syn : synonyms) {
                expanded.add(new ExpandedTerm(
                    syn.getSynonym(), syn.getWeight(), false
                ));
            }
        }
        return expanded;
    }
}
```

### 자동 동의어 추출 (위키 리다이렉트 활용)

위키피디아의 리다이렉트 정보를 활용하면 동의어를 자동으로 추출할 수 있습니다.

```sql
SELECT
  redirect_title as term,
  title as synonym,
  0.8 as weight
FROM posts
WHERE redirect_title IS NOT NULL;
-- 예: "인공 지능" -> "인공지능"으로 리다이렉트
```

### 주의사항

| 이슈 | 설명 | 해결 |
|------|------|------|
| 쿼리 폭발 | 동의어가 많으면 검색 term 수 급증 | 동의어 개수 제한 (term당 최대 3개) |
| 의미 변질 | "Apple" → "사과" vs "애플(회사)" | 문맥 기반 동의어 선택 (고급) |
| 성능 저하 | term 수 증가 → posting list 조회 증가 | 동의어에 낮은 가중치, 캐싱 적용 |

---

## 2. Query Understanding (쿼리 이해)

사용자 쿼리를 분석하고 의도를 파악하여 검색 품질을 높이는 전처리 단계입니다.

| 기법 | 설명 | 예시 |
|------|------|------|
| **Query Rewriting** | 쿼리 재작성 | "삼성폰" → "삼성 스마트폰" |
| **Spelling Correction** | 오타 교정 | "컴퓨텨" → "컴퓨터" |
| **Query Segmentation** | 복합어 분리 | "인공지능기술" → "인공지능 기술" |
| **Intent Detection** | 검색 의도 파악 | "아이폰 가격" → 구매 의도 |

### 대안: Lucene DirectSpellChecker

Lucene은 `DirectSpellChecker`를 내장하고 있어, 인덱스의 term dictionary를 사전으로 사용하여 편집 거리(Damerau-Levenshtein) 기반 오타 교정이 가능합니다. 별도 사전 구축이 불필요하고 인덱스가 곧 사전이 됩니다. 운영 초기에는 DirectSpellChecker로 시작하고, 검색 로그가 쌓이면 아래의 로그 기반 "Did you mean?"으로 보강하는 전략이 합리적입니다.

### 오타 교정 구현

```java
@Service
public class SpellingCorrectionService {

    public String correct(String query) {
        List<String> tokens = tokenize(query);
        List<String> corrected = new ArrayList<>();

        for (String token : tokens) {
            if (dictionary.contains(token)) {
                corrected.add(token);
                continue;
            }
            // 편집 거리 1~2 이내의 후보 찾기
            String candidate = findClosestMatch(token);
            if (candidate != null && editDistance(token, candidate) <= 2) {
                corrected.add(candidate);
            } else {
                corrected.add(token);
            }
        }
        return String.join(" ", corrected);
    }
}
```

### "Did you mean?" 제안

```java
public Optional<String> suggestCorrection(String query) {
    return searchLogRepository
        .findSimilarQueries(query, 0.8)  // 유사도 80% 이상
        .stream()
        .filter(q -> q.getResultCount() > 0)  // 결과가 있는 쿼리만
        .max(Comparator.comparing(SearchLog::getSearchCount))
        .map(SearchLog::getQuery);
}
```

---

## 3. 전체 재색인 + 무중단 인덱스 교체

현재 NRT 증분 색인(create/update/delete → 즉시 반영)은 구현 완료 상태입니다. 하지만 분석기 변경, 필드 매핑 변경 등 인덱스 구조를 바꿔야 할 때는 **전체 재색인(Full Reindex)**이 필요합니다.

### 전체 색인 vs 부분 색인 전략

1,425만 건의 위키 데이터는 대부분 변경되지 않으므로, 색인을 전체(full)와 부분(incremental)으로 나눕니다.

```
전체 색인 (Full Reindex):
- 언제: 분석기 변경, 필드 매핑 변경, 인덱스 구조 변경 시
- 방법: DB 전체 스캔 -> 새 인덱스 디렉토리에 색인 -> 교체
- 빈도: 수동 트리거 (드물게)
- 소요: 1,425만 건 × 평균 6,586자 = 수십 분~수 시간

부분 색인 (Incremental Reindex) — 구현 완료:
- 언제: 게시글 생성/수정/삭제 시
- 방법: 변경된 문서만 updateDocument() / deleteDocuments()
- 빈도: 실시간 (NRT)
- 소요: ms 단위
```

### 동시 색인 방지

전체 색인 실행 중 부분 색인이 동시에 돌면 데이터 정합성이 깨질 수 있습니다.
Lucene의 IndexWriter가 `write.lock` 파일로 단일 writer를 보장하지만, 전체 색인을 별도 디렉토리에 구축하는 경우 플래그로 제어합니다.

```java
// 전체 색인 진행 중이면 부분 색인 스킵
private final AtomicBoolean fullReindexInProgress = new AtomicBoolean(false);

public void incrementalIndex(Post post) throws IOException {
    if (fullReindexInProgress.get()) {
        log.warn("Full reindex in progress, skipping incremental for post={}", post.getId());
        return;
    }
    writer.updateDocument(new Term("id", String.valueOf(post.getId())), toDocument(post));
    writer.commit();
}
```

### 무중단 인덱스 교체

전체 색인은 시간이 오래 걸리므로, 색인 중에도 검색이 중단되면 안 됩니다.

**Elasticsearch의 Alias 방식 (참고):**
```
index_v1 (현재 서비스) <-- alias: "wiki-search"
index_v2 (새로 색인 중)

색인 완료 후:
POST /_aliases
  remove: { index: index_v1, alias: wiki-search }
  add:    { index: index_v2, alias: wiki-search }
-> 클라이언트는 alias만 바라보므로 무중단 전환
```

**Lucene의 Directory Swap 방식:**
```java
// 1. 새 디렉토리에 전체 색인
Directory newDir = MMapDirectory.open(Paths.get("/data/lucene/wiki-index-new"));
IndexWriter newWriter = new IndexWriter(newDir, config);
// ... 전체 색인 수행 ...
newWriter.close();

// 2. 심볼릭 링크 교체 (원자적)
// /data/lucene/wiki-index -> wiki-index-v1  (현재)
// /data/lucene/wiki-index -> wiki-index-v2  (교체 후)
Files.deleteIfExists(Paths.get("/data/lucene/wiki-index"));
Files.createSymbolicLink(
    Paths.get("/data/lucene/wiki-index"),
    Paths.get("/data/lucene/wiki-index-v2")
);

// 3. SearcherManager refresh
searcherManager.maybeRefresh();
```

기존 검색 요청은 이전 searcher로 완료되고, 새 요청만 새 searcher를 사용합니다.

> **주의: MMapDirectory와 심볼릭 링크 호환성**
> MMapDirectory는 파일을 메모리에 매핑하므로, 심볼릭 링크를 교체해도 이미 매핑된 파일은 이전 디렉토리를 계속 참조합니다. `searcherManager.maybeRefresh()`가 새 디렉토리의 파일을 올바르게 감지하려면, SearcherManager를 닫고 새 Directory로 다시 생성하거나, IndexWriter를 새 디렉토리로 교체한 후 refresh해야 할 수 있습니다. 실제 구현 시 검증이 필요합니다.

---

## 출처

- [Nori: The Official Elasticsearch Plugin for Korean — Elastic](https://www.elastic.co/blog/nori-the-official-elasticsearch-plugin-for-korean-language-analysis)
- [NHN FORWARD 22 — Elasticsearch를 이용한 상품 검색 엔진](https://forward.nhn.com/2022/sessions/14)
- [오늘의집 — 데이터 엔지니어의 좌충우돌 검색 개발기](https://www.bucketplace.com/post/2021-12-15-%EB%8D%B0%EC%9D%B4%ED%84%B0-%EC%97%94%EC%A7%80%EB%8B%88%EC%96%B4%EC%9D%98-%EC%A2%8C%EC%B6%A9%EC%9A%B0%EB%8F%8C-%EA%B2%80%EC%83%89-%EA%B0%9C%EB%B0%9C%EA%B8%B0/)

<!-- EN -->

## Previous

In [Why I Picked Lucene Over MySQL Search](/blog/project/wikiengine/lucene-decision) we adopted embedded Lucene + the Nori morphological analyzer to build full-text search across 14.25M docs. This post lays out the roadmap and concrete techniques for pushing search quality further.

---

## 0. Search-Enhancement Roadmap

The current implementation runs on stock BM25 + Nori. Below are the improvements to apply when needed.

### 0-1. BM25 Variants Compared

| Variant | Notes | When to apply |
|---|---|---|
| BM25 (current) | Lucene/ES/Solr default, k1=1.2, b=0.75 | currently in use |
| BM25+ | Long-document penalty correction — fixes long docs being unfairly under-scored | when doc-length variance is high and long docs go missing |
| BM25L | similar to BM25+, boosts long docs | same as above |
| BM25F | Per-field weighting (separate streams for title, content, etc.) | when you need precise per-field weighting |

[According to a 3-corpus news experiment](https://pmc.ncbi.nlm.nih.gov/articles/PMC7148026/), there was no meaningful performance difference between BM25 variants. We already apply title:3, content:1 weighting via `MultiFieldQueryParser`, which partially substitutes for BM25F. **Conclusion: start with stock BM25 and only consider variants when search-quality issues actually surface.**

### 0-2. Search-Quality Improvements

| Feature | Description | When to apply |
|---|---|---|
| Nori user dictionary | preserve "운동화" as a single token instead of decomposing into "운동"+"화" | when compound decomposition hurts accuracy |
| Dual Field (title_exact) | add an unanalyzed StringField for whitespace-insensitive matching | when "나이키에어맥스" (no spaces) starts failing to match |
| Stored snippet | StoredField with a 200-char body preview | when search results need preview |
| BM25 k1/b tuning | k1: TF saturation, b: doc-length normalization | after k6 load tests, via search-quality A/B testing |

### 0-3. Indexing Performance

| Feature | Description | When to apply |
|---|---|---|
| Parallel batch indexing | IndexWriter is thread-safe — process 2000-doc batches across N threads | when a full reindex is needed again |
| Near Real-Time (NRT) indexing | reflect post create/update/delete in Lucene in real time | already implemented |

---

## 1. Query Expansion: Synonyms

When a user searches "AI", we want documents about "인공지능" (artificial intelligence) to come back too. We do this by expanding the query.

### Synonym dictionary design

```sql
CREATE TABLE synonyms (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  term VARCHAR(100) NOT NULL,
  synonym VARCHAR(100) NOT NULL,
  weight DOUBLE DEFAULT 1.0,
  INDEX idx_term (term),
  INDEX idx_synonym (synonym)
);

INSERT INTO synonyms (term, synonym, weight) VALUES
  ('AI', '인공지능', 1.0),
  ('인공지능', 'AI', 1.0),
  ('ML', '머신러닝', 1.0),
  ('머신러닝', 'ML', 1.0),
  ('DB', '데이터베이스', 1.0),
  ('데이터베이스', 'DB', 1.0);
```

### Alternative: Lucene SynonymGraphFilter

Lucene natively supports `SynonymGraphFilter`. By injecting a synonym map into the analyzer chain at index-time or query-time, you can handle synonyms without DB lookups.

| Approach | Pros | Cons |
|---|---|---|
| **DB-based query expansion** (impl below) | adds/removes apply instantly, weight control | DB lookup per query |
| **SynonymGraphFilter** (index-time) | no DB lookup, integrated in analyzer chain | full reindex needed when synonyms change |
| **SynonymGraphFilter** (query-time) | no DB lookup, no reindex | have to manage two analyzers |

Given that synonyms may change often and we need weight control, we design the DB-based approach first. Once operations stabilize, we will reconsider switching to SynonymGraphFilter (query-time).

### Query expansion implementation

```java
@Service
public class QueryExpansionService {

    private final SynonymRepository synonymRepository;

    public List<ExpandedTerm> expandQuery(List<String> originalTerms) {
        List<ExpandedTerm> expanded = new ArrayList<>();

        for (String term : originalTerms) {
            expanded.add(new ExpandedTerm(term, 1.0, true));

            List<Synonym> synonyms = synonymRepository.findByTerm(term);
            for (Synonym syn : synonyms) {
                expanded.add(new ExpandedTerm(
                    syn.getSynonym(), syn.getWeight(), false
                ));
            }
        }
        return expanded;
    }
}
```

### Auto-synonym extraction (using Wikipedia redirects)

We can mine synonyms automatically from Wikipedia redirect data.

```sql
SELECT
  redirect_title as term,
  title as synonym,
  0.8 as weight
FROM posts
WHERE redirect_title IS NOT NULL;
-- e.g., "인공 지능" -> "인공지능" redirect
```

### Caveats

| Issue | Description | Mitigation |
|---|---|---|
| Query explosion | many synonyms blow up search-term count | cap synonyms (max 3 per term) |
| Semantic drift | "Apple" → "사과" vs "Apple Inc." | context-aware synonym selection (advanced) |
| Performance hit | more terms → more posting list lookups | low weights on synonyms, plus caching |

---

## 2. Query Understanding

A preprocessing layer that analyzes the user's query and infers intent to lift search quality.

| Technique | Description | Example |
|---|---|---|
| **Query Rewriting** | rewrite the query | "삼성폰" → "삼성 스마트폰" |
| **Spelling Correction** | fix typos | "컴퓨텨" → "컴퓨터" |
| **Query Segmentation** | split compounds | "인공지능기술" → "인공지능 기술" |
| **Intent Detection** | infer search intent | "아이폰 가격" → purchase intent |

### Alternative: Lucene DirectSpellChecker

Lucene ships `DirectSpellChecker`, which uses the index's term dictionary as the dictionary and does edit-distance (Damerau-Levenshtein) corrections. No separate dictionary needed — the index *is* the dictionary. A reasonable strategy is to start with DirectSpellChecker and, once search logs accumulate, reinforce with the log-based "Did you mean?" below.

### Spell-correction implementation

```java
@Service
public class SpellingCorrectionService {

    public String correct(String query) {
        List<String> tokens = tokenize(query);
        List<String> corrected = new ArrayList<>();

        for (String token : tokens) {
            if (dictionary.contains(token)) {
                corrected.add(token);
                continue;
            }
            // candidates within edit distance 1-2
            String candidate = findClosestMatch(token);
            if (candidate != null && editDistance(token, candidate) <= 2) {
                corrected.add(candidate);
            } else {
                corrected.add(token);
            }
        }
        return String.join(" ", corrected);
    }
}
```

### "Did you mean?" suggestion

```java
public Optional<String> suggestCorrection(String query) {
    return searchLogRepository
        .findSimilarQueries(query, 0.8)  // similarity ≥ 80%
        .stream()
        .filter(q -> q.getResultCount() > 0)  // only queries with results
        .max(Comparator.comparing(SearchLog::getSearchCount))
        .map(SearchLog::getQuery);
}
```

---

## 3. Full Reindex + Zero-Downtime Index Swap

NRT incremental indexing (create/update/delete → instant reflection) is already in place. But for **structural changes** like analyzer changes or field-mapping changes, you need a **full reindex**.

### Full vs incremental indexing strategy

Most of the 14.25M wiki rows do not change, so we split indexing into full and incremental.

```
Full reindex:
- When: analyzer change, field mapping change, structural change
- How: full DB scan -> index into a fresh directory -> swap
- Frequency: manual trigger (rare)
- Cost: 14.25M docs × ~6,586 chars avg = tens of minutes to hours

Incremental — already implemented:
- When: post create/update/delete
- How: updateDocument() / deleteDocuments() for changed docs only
- Frequency: real-time (NRT)
- Cost: ms range
```

### Preventing concurrent indexing

If incremental indexing runs while a full reindex is in progress, data consistency can break. Lucene's IndexWriter enforces a single writer via a `write.lock` file, but when the full reindex builds a separate directory we control it with a flag.

```java
// skip incremental while full reindex is in progress
private final AtomicBoolean fullReindexInProgress = new AtomicBoolean(false);

public void incrementalIndex(Post post) throws IOException {
    if (fullReindexInProgress.get()) {
        log.warn("Full reindex in progress, skipping incremental for post={}", post.getId());
        return;
    }
    writer.updateDocument(new Term("id", String.valueOf(post.getId())), toDocument(post));
    writer.commit();
}
```

### Zero-downtime index swap

Full reindex takes a long time, so search must not pause during it.

**Elasticsearch alias approach (for reference):**
```
index_v1 (live)  <-- alias: "wiki-search"
index_v2 (being indexed)

Once indexing is done:
POST /_aliases
  remove: { index: index_v1, alias: wiki-search }
  add:    { index: index_v2, alias: wiki-search }
-> clients only see the alias, so cutover is zero-downtime
```

**Lucene Directory swap approach:**
```java
// 1. full reindex into a new directory
Directory newDir = MMapDirectory.open(Paths.get("/data/lucene/wiki-index-new"));
IndexWriter newWriter = new IndexWriter(newDir, config);
// ... run the full reindex ...
newWriter.close();

// 2. swap the symlink (atomic)
// /data/lucene/wiki-index -> wiki-index-v1  (current)
// /data/lucene/wiki-index -> wiki-index-v2  (after swap)
Files.deleteIfExists(Paths.get("/data/lucene/wiki-index"));
Files.createSymbolicLink(
    Paths.get("/data/lucene/wiki-index"),
    Paths.get("/data/lucene/wiki-index-v2")
);

// 3. SearcherManager refresh
searcherManager.maybeRefresh();
```

In-flight queries finish with the old searcher; only new requests pick up the new one.

> **Caveat: MMapDirectory + symlink interaction**
> MMapDirectory maps files into memory, so swapping the symlink does not redirect already-mapped files — they still reference the old directory. For `searcherManager.maybeRefresh()` to actually pick up the new directory's files, you may have to close the SearcherManager and recreate it on the new Directory, or swap IndexWriter to the new directory then refresh. This needs verification at implementation time.

---

## Sources

- [Nori: The Official Elasticsearch Plugin for Korean — Elastic](https://www.elastic.co/blog/nori-the-official-elasticsearch-plugin-for-korean-language-analysis)
- [NHN FORWARD 22 — Search engine for products with Elasticsearch](https://forward.nhn.com/2022/sessions/14)
- [Today's House — A data engineer's bumpy search-development story](https://www.bucketplace.com/post/2021-12-15-%EB%8D%B0%EC%9D%B4%ED%84%B0-%EC%97%94%EC%A7%80%EB%8B%88%EC%96%B4%EC%9D%98-%EC%A2%8C%EC%B6%A9%EC%9A%B0%EB%8F%8C-%EA%B2%80%EC%83%89-%EA%B0%9C%EB%B0%9C%EA%B8%B0/)

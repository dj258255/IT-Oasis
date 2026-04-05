---
title: Nori 형태소 분석기 Stop Filter 문제 — "안녕" 0건과 "안녕하세" 노이즈 해결
titleEn: Nori Analyzer Stop Filter Fix — Resolving Zero Results and Noisy Rankings
description: Lucene Nori 분석기에서 "안녕" 검색이 0건이 되는 IC 필터링 문제와, "안녕하세" 검색 시 "하세" 관련 문서만 나오는 형태소 분석 한계를 분석합니다. IC 제거 + title_ngram dis_max + PrefixQuery 폴백 3단계 해결을 적용하고, 자동완성 title_raw fallback까지 포함합니다.
descriptionEn: Fixes two Nori analyzer issues — "안녕" returning zero results due to IC stop tag filtering, and "안녕하세" surfacing only "하세" documents due to incomplete morphological tokenization. Applies IC removal + title_ngram dis_max + PrefixQuery fallback, plus autocomplete title_raw fallback.
date: 2026-04-04T00:00:00.000Z
tags:
  - Lucene
  - Nori
  - Korean NLP
  - Search Engine
  - Morphological Analysis
  - Stop Filter
  - Troubleshooting
  - Spring Boot
  - Wiki
category: project/WikiEngine
coverImage: /uploads/project/WikiEngine/nori-stop-filter-fix/search-annyeong-zero.png
draft: false
---

## 이전 글

[AI 검색 요약 — RAG 파이프라인 + SSE 스트리밍 + 비용 모니터링](/blog/project/wikiengine/search-rag)에서 Lucene BM25 검색 결과를 LLM 컨텍스트에 주입하는 RAG 파이프라인을 구축했다. 검색 기능이 모두 갖춰진 상태에서, **특정 키워드가 검색되지 않거나 엉뚱한 결과가 나오는 문제**를 발견했다.

---

## 1. 정상 상태

wikiEngine은 Lucene 10.3.2 + Nori 한국어 형태소 분석기 기반의 검색 시스템이다.

| 항목 | 상세 |
|------|------|
| 데이터 규모 | 1,215만 건 (위키 845만 + 뉴스 16만 + 웹 354만) |
| 인덱스 크기 | 약 36GB (MMapDirectory) |
| 분석기 | Nori KoreanAnalyzer + UserDictionary 158K 엔트리 |
| 랭킹 | BM25 + viewCount/likeCount saturation + recency decay |
| 서버 | ARM 2코어 / 12GB RAM × 2대 (Primary + Replica) |

"삼성전자", "인공지능", "자바스크립트" 등 일반 명사 검색은 정상 동작한다.

---

## 2. 문제 — 두 가지 증상

### 증상 1: "안녕" 검색 시 0건

"안녕하세요"를 검색하면 결과가 나오지만, "안녕"만 입력하면 **결과가 없다**.

![안녕 검색 0건](/uploads/project/WikiEngine/nori-stop-filter-fix/search-annyeong-zero.png)

### 증상 2: "안녕하세" 검색 시 "하세" 문서만 나옴

"안녕하세"를 검색하면 "안녕하세요" 관련 문서가 아니라 **"하세"(일본 성씨) 관련 문서가 최상위**에 노출된다.

![안녕하세 하세 결과](/uploads/project/WikiEngine/nori-stop-filter-fix/before-search-annyeonghase-hase-results.png)

> Did-you-mean은 "안녕하"를 제안하지만, 검색 결과는 "하세", "하세쿠라", "하세 히로시" 등 관련 없는 문서가 점령한다.

### 자동완성도 이상

| 입력 | 자동완성 결과 | 비고 |
|------|------------|------|
| "안" | 안경, 안녕, 안녕하 | 정상 |
| "안녕" | **없음** | 비정상 |
| "안녕하세요" | 다수 결과 | 정상 |
| "황치열" | **없음** | 비정상 |

---

## 3. 원인 분석

### 증상 1 원인 — IC(감탄사) Stop Filter

Nori의 `DEFAULT_STOP_TAGS`에 IC(감탄사)가 포함되어 있다. 같은 "안녕"이라도 문맥에 따라 품사 태깅이 달라진다:

```
"안녕하세요"  → Nori: '안녕'(NNG, 명사) + '하'(XSV) + '세요'(EF)
               → Stop Filter: '안녕' 생존 ✓
               → 인덱스: ['안녕']

"안녕"       → Nori: '안녕'(IC, 감탄사)
              → Stop Filter: '안녕' 제거 ✗
              → 쿼리: [] (빈 쿼리 → 0건)
```

**핵심**: "안녕"이 단독으로 쓰이면 감탄사(IC)로 태깅되어 필터링된다. 하지만 인덱스에는 "안녕하세요"의 일부로 '안녕'(NNG)이 저장되어 있다. **인덱싱은 됐는데 검색이 안 되는 비대칭 문제**.

### 증상 2 원인 — 불완전 입력의 비표준적 토큰화

"안녕하세"는 Nori 사전에 없는 미완성 형태다. Nori는 이를 비표준적으로 분리한다:

```
"안녕하세" → Nori: '안녕'(NNG) + '하세'(???)
           → 쿼리: ['안녕', '하세'] (OR)
```

OR 기반 쿼리에서 "하세"라는 제목의 문서(일본 성씨)가 title^3 boost로 완전 일치하여 BM25 점수가 극도로 높다. 반면 "안녕하세요" 문서의 인덱스 토큰은 '안녕' 하나뿐이라 '하세' 토큰과 매칭되지 않는다.

| 문서 | 인덱스 토큰 | 쿼리 '안녕' 매칭 | 쿼리 '하세' 매칭 | BM25 |
|------|-----------|:---:|:---:|------|
| "하세" (일본 성씨) | ['하세'] | X | O (title 완전 일치) | **매우 높음** |
| "안녕하세요" | ['안녕'] | O (부분 매칭) | X | 낮음 |

### 자동완성 원인 — title_jamo PrefixQuery의 한계

Lucene fallback에서 title_jamo 필드의 PrefixQuery를 사용하는데, 12M건의 자모 분해 term이 너무 많아 완성 한글("황치열") 검색이 실패한다.

---

## 4. 선택지

두 증상이 원인이 다르므로 각각 해결책이 필요하다.

### 증상 1 해결 — IC 제거

| 선택지 | 장점 | 단점 |
|--------|------|------|
| **A. Stop Tags에서 IC 제거** | 근본 해결, 1줄 수정 | IC 전체가 인덱싱됨 |
| 사전에 '안녕' NNG 등록 | IC 유지 | 모든 감탄사를 수동 등록 불가 |

IC를 제거하면 감탄사가 인덱싱되어 인덱스가 약간 커지지만, 한국어에서 감탄사 비중은 미미하다.

### 증상 2 해결 — n-gram 보완

| 선택지 | "안녕하세" → "안녕하세요" | 기존 검색 영향 | 비용 |
|--------|:---:|------|------|
| **B. title_ngram + dis_max** | **O** | 없음 | +8% 인덱스 |
| AND 연산자 전환 | X (recall 감소) | **심각** | 없음 |
| PhraseQuery boost | X (토큰 1개라 구절 불가) | 없음 | 없음 |
| 현상 유지 + Did-you-mean | X | 없음 | 없음 |

title 필드에만 2-3gram 분석기를 추가하고 dis_max로 결합하면, 형태소 분석이 실패해도 n-gram이 문자 시퀀스 매칭으로 관련 문서를 올린다. 콘텐츠 전체를 n-gram으로 하면 토큰 6.5배 폭발이 발생하지만, title만 적용하면 36GB → 39GB(+8%)로 최소화된다.

### 보험 — 토큰 전멸 폴백

| 선택지 | 설명 |
|--------|------|
| **C. PrefixQuery 폴백** | Nori 분석 후 토큰이 0개면 원본 키워드로 PrefixQuery 실행 |

A와 B로 커버되지 않는 미지의 엣지 케이스에 대한 보험이다.

---

## 5. 구현 — A + B + C

세 레이어가 각각 다른 실패 모드를 커버한다:
- **A(IC 제거)**: 감탄사가 필터링되는 문제
- **B(dis_max)**: 형태소 분석이 불완전한 입력을 잘못 토큰화하는 문제
- **C(PrefixQuery)**: 토큰이 전부 사라지는 미지의 케이스

### A. Stop Tags 커스터마이징

```java
// LuceneConfig.java
private Analyzer createNoriAnalyzer() {
    UserDictionary userDict = loadUserDictionary();
    Set<POS.Tag> stopTags = EnumSet.copyOf(
        KoreanPartOfSpeechStopFilter.DEFAULT_STOP_TAGS);
    stopTags.remove(POS.Tag.IC);  // IC(감탄사) 제거
    return new KoreanAnalyzer(userDict,
        KoreanTokenizer.DEFAULT_DECOMPOUND, stopTags, false);
}
```

### B. title_ngram + dis_max

**PerFieldAnalyzerWrapper:**

```java
@Bean
Analyzer luceneAnalyzer() {
    Analyzer noriAnalyzer = createNoriAnalyzer();
    Analyzer ngramAnalyzer = createNgramAnalyzer(); // 2-3gram
    return new PerFieldAnalyzerWrapper(noriAnalyzer,
        Map.of("title_ngram", ngramAnalyzer));
}
```

**인덱싱 시 title_ngram 필드 추가:**

```java
// LuceneIndexService.java
doc.add(new TextField("title_ngram", post.getTitle(), Field.Store.NO));
```

**dis_max 쿼리:**

```java
new DisjunctionMaxQuery(
    List.of(
        textQuery,                           // Nori 형태소 분석
        new BoostQuery(ngramQuery, 2.0f)     // 2-3gram
    ),
    0.1f  // tie_breaker
);
```

#### dis_max 튜닝 과정

처음부터 이 구조가 나온 게 아니라 시행착오가 있었다.

**1차 — MUST + SHOULD 구조:**

```
textQuery(MUST) + ngramQuery(SHOULD)
```

textQuery가 MUST이므로 형태소 분석 결과가 검색을 지배한다. "안녕하세"에서 '하세' 토큰이 title^3 boost로 "하세" 문서를 상위에 올리고, n-gram은 SHOULD라서 순위를 뒤집지 못했다.

**2차 — dis_max, textQuery에 3.0 boost:**

```
dis_max([BoostQuery(textQuery, 3.0), ngramQuery], tie_breaker=0.1)
```

textQuery 3.0 × title 내부 3.0 = 9배 부스트. "하세" 완전 일치가 n-gram을 압도해서 결과가 동일했다.

**3차 — dis_max, boost 없이:**

title^3 내부 boost만으로도 "하세" title 완전 일치의 BM25 점수가 너무 높아 n-gram 부분 매칭으로는 부족했다.

**최종 — ngramQuery에 2.0 boost:**

n-gram에 2.0 boost를 줘서 title^3과 경쟁할 수 있게 했다.

| | textQuery 점수 | ngramQuery 점수 | dis_max 결과 |
|---|---|---|---|
| "하세" 문서 | 높음 (title 완전일치) | 낮음 | textQuery 선택 |
| "안녕하세요" 문서 | 낮음 ('안녕'만 매칭) | **높음** (4글자 n-gram × 2.0) | **ngramQuery 선택 → 상위** |

### C. 토큰 전멸 PrefixQuery 폴백

```java
// LuceneSearchService.java
if (allTokens.isEmpty()) {
    return new PrefixQuery(new Term("title", queryStr.toLowerCase()));
}
```

### D. 자동완성 title_raw fallback

기존 Lucene fallback이 title_jamo PrefixQuery만 사용해서 완성 한글 검색("황치열")이 실패했다. 완성 한글과 자모 입력을 분리했다:

```java
// RedisAutocompleteService.java
if (JamoDecomposer.isCompleteHangul(prefix)) {
    // "황치열" → title_raw PrefixQuery
    return luceneSearchService.autocompleteFallback(prefix, "title_raw");
} else {
    // "ㅎㅊㅇ" → title_jamo PrefixQuery
    return luceneSearchService.autocompleteFallback(
        JamoDecomposer.decompose(prefix), "title_jamo");
}
```

title_raw는 분석기를 타지 않는 StringField로 이미 인덱싱되어 있어 추가 비용이 없다.

---

## 6. 검증 — Before / After

### Before

**"안녕하세" 검색 — "하세" 문서만:**

![안녕하세 하세 결과](/uploads/project/WikiEngine/nori-stop-filter-fix/before-search-annyeonghase-hase-results.png)

**"황치열" 자동완성 — 빈 결과:**

![황치열 자동완성 안 됨](/uploads/project/WikiEngine/nori-stop-filter-fix/before-autocomplete-hwang-empty.png)

### After

**"안녕" 검색 — 정상 반환 + AI 요약:**

![안녕 검색 정상](/uploads/project/WikiEngine/nori-stop-filter-fix/after-search-annyeong.png)

**"안녕하세" 검색 — "안녕하세요" 관련 문서 상위:**

![안녕하세 dis_max 결과](/uploads/project/WikiEngine/nori-stop-filter-fix/after-search-annyeonghase-dismax.png)

**"황" 자동완성 — "황치열" 정상:**

![황 자동완성 정상](/uploads/project/WikiEngine/nori-stop-filter-fix/after-autocomplete-hwang.png)

### 개선 요약

| 항목 | Before | After |
|------|--------|-------|
| "안녕" 검색 | **0건** | 정상 반환 |
| "안녕하세" 검색 | **"하세" 문서만** | **"안녕하세요" 문서 상위** |
| "황치열" 자동완성 | **빈 결과** | 정상 제안 |
| 인덱스 크기 | 36GB | 39GB (+8%) |
| 재색인 | - | 필수 (12M건, 69분) |

수정 파일: `LuceneConfig.java` (IC 제거 + PerFieldAnalyzerWrapper), `LuceneIndexService.java` (title_ngram 필드), `LuceneSearchService.java` (dis_max 쿼리 + PrefixQuery 폴백), `RedisAutocompleteService.java` (title_raw fallback).

---

## 7. Nori의 구조적 한계

이번에 발견한 문제들은 Nori만의 문제가 아니라 **사전 기반 형태소 분석기의 공통 한계**다.

| 한계 | 설명 |
|------|------|
| IC 품사 과필터링 | stop tags에 IC가 포함되어 standalone 감탄사가 검색 불가 |
| 불완전 입력 | 미완성 활용형("안녕하세")을 비표준적으로 토큰화 |
| OOV(미등록어) | 신조어, 고유명사를 처리하지 못함 |
| 조사/어미 세분화 부족 | "J", "E" 대분류만 존재하여 특정 조사/어미만 제거 불가 |

이 프로젝트에서는 Nori의 성능(3,000+ docs/sec)과 메모리 효율이 12M 규모에 적합하므로 Nori를 유지하되, **IC 제거 + title_ngram dis_max + PrefixQuery 폴백 + 자동완성 title_raw fallback**으로 한계를 보완하는 접근을 선택했다.

---

## 출처

- [Lucene 10.3.2 — KoreanPartOfSpeechStopFilter.java](https://github.com/apache/lucene/blob/main/lucene/analysis/nori/src/java/org/apache/lucene/analysis/ko/KoreanPartOfSpeechStopFilter.java)
- [Elastic Blog — Nori: The Official Elasticsearch Plugin for Korean](https://www.elastic.co/blog/nori-the-official-elasticsearch-plugin-for-korean-language-analysis)
- [Elastic Blog — How to Search CJK Text Part 2: Multi-fields](https://www.elastic.co/blog/how-to-search-ch-jp-kr-part-2)
- [Sease — When and How to Use N-grams in Elasticsearch](https://sease.io/2023/12/when-and-how-to-use-n-grams-in-elasticsearch.html)

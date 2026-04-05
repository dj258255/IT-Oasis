---
title: 'Nori 형태소 분석기 Stop Filter 문제 — "안녕" 검색 0건의 원인과 해결'
titleEn: 'Nori Analyzer Stop Filter Issue — Why Searching "안녕" Returns Zero Results'
description: Lucene Nori 한국어 분석기의 DEFAULT_STOP_TAGS에 IC(감탄사)가 포함되어 있어, standalone "안녕"이 감탄사로 태깅→필터링→빈 쿼리→0건이 되는 비대칭 검색 문제를 분석합니다. 같은 "안녕"이 "안녕하세요"에서는 NNG(명사)로 정상 인덱싱되는 품사 태깅 문맥 의존성이 근본 원인입니다. Stop Tags 커스터마이징(IC 제거), Multi-field N-gram + dis_max, Query-time 폴백 3가지 선택지를 현업 사례(배달의민족, 딜리셔스, Elastic 공식 CJK 검색 가이드)와 함께 트레이드오프하고, A(IC 제거) + B(title_ngram + dis_max) + C(토큰 전멸 PrefixQuery 폴백) 조합을 선택합니다.
descriptionEn: Analyzes an asymmetric search failure in Lucene Nori Korean analyzer where standalone "안녕" is tagged as IC (interjection) and filtered by DEFAULT_STOP_TAGS, producing zero results, while the same morpheme "안녕" in "안녕하세요" is tagged as NNG (noun) and indexed normally. Evaluates three solutions — custom stop tags, multi-field n-gram + dis_max, and query-time fallback — with production case studies (Baemin, Dealicious, Elastic CJK search guide), and selects A (IC removal) + B (title_ngram + dis_max) + C (zero-token PrefixQuery fallback).
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

[AI 검색 요약 — RAG 파이프라인 + SSE 스트리밍 + 비용 모니터링](/blog/project/wikiengine/search-rag)에서 Lucene BM25 검색 결과를 LLM 컨텍스트에 주입하는 RAG 파이프라인을 구축했습니다.

| 지표 | 결과 |
|------|------|
| RAG | Spring AI 2.0 + Gemini 2.0 Flash, Top-5 문서 주입 |
| 스트리밍 | SSE 실시간 답변 생성 |
| 비용 | Redis 캐싱으로 LLM 호출 40-60% 절감 |

검색 기능이 모두 갖춰진 상태에서, **특정 키워드가 검색되지 않는 문제**를 발견했습니다.

---

## 1. 정상 상태 — 현재 검색 시스템

wikiEngine은 Lucene 10.3.2 + Nori 한국어 형태소 분석기 기반의 검색 시스템입니다.

| 항목 | 상세 |
|------|------|
| 데이터 규모 | 1,215만 건 (위키 845만 + 뉴스 16만 + 웹 354만) |
| 인덱스 크기 | 약 36GB (MMapDirectory) |
| 분석기 | Nori KoreanAnalyzer + UserDictionary 158K 엔트리 |
| 랭킹 | BM25 + viewCount/likeCount saturation + recency decay |
| 서버 | ARM 2코어 / 12GB RAM × 2대 (Primary + Replica) |

검색 흐름: 사용자 입력 → Nori 형태소 분석 → BM25 쿼리 → 랭킹 → 결과 반환

대부분의 검색 키워드에서 정상적으로 결과가 반환됩니다. "삼성전자", "인공지능", "자바스크립트" 등 일반 명사 검색은 문제없이 동작합니다.

---

## 2. 문제 발생 — "안녕" 검색 시 0건

"안녕하세요"를 검색하면 결과가 정상적으로 나오지만, "안녕"만 입력하면 **검색 결과가 없습니다**.

### "안녕" 검색 — 0건

![안녕 검색 0건](/uploads/project/WikiEngine/nori-stop-filter-fix/search-annyeong-zero.png)

### "안녕하세" 검색 — 정상

![안녕하세 검색 정상](/uploads/project/WikiEngine/nori-stop-filter-fix/search-annyeonghase.png)

> "안녕하세"로 검색하면 "하세" 관련 문서가 정상 반환되고, Did-you-mean으로 "안녕하"를 제안합니다.

### 자동완성도 패턴이 다름

| 입력 | 자동완성 | 검색 |
|------|---------|------|
| "안" | 안경, 안녕, 안에, 안녕하 | - |
| "안녕해" | 안녕하 (1건) | - |
| "안녕하세요" | 다수 결과 | 정상 |
| **"안녕"** | **없음** | **0건** |

!["안" 자동완성 — 안경, 안녕, 안에, 안녕하](/uploads/project/WikiEngine/nori-stop-filter-fix/autocomplete-an.png)

!["안녕해" 자동완성 — 안녕하 1건](/uploads/project/WikiEngine/nori-stop-filter-fix/autocomplete-annyeonghae.png)

!["안녕하세요" 자동완성 — 다수 결과](/uploads/project/WikiEngine/nori-stop-filter-fix/autocomplete-annyeonghaseyo.png)

"안녕하세요"는 되는데 "안녕"은 안 되는 것은, 단순한 인덱싱 누락이 아니라 **형태소 분석 과정에서 토큰이 사라지는 문제**입니다.

---

## 3. 원인 분석 — Nori의 품사 태깅과 Stop Filter

### Nori 형태소 분석기 구조

wikiEngine은 Lucene 10.3.2의 Nori(KoreanAnalyzer)를 사용합니다:

```java
// LuceneConfig.java
@Bean
Analyzer luceneAnalyzer() {
    UserDictionary userDict = loadUserDictionary();
    return new KoreanAnalyzer(
            userDict,
            KoreanTokenizer.DEFAULT_DECOMPOUND,
            KoreanPartOfSpeechStopFilter.DEFAULT_STOP_TAGS, // ← 문제 지점
            false
    );
}
```

`KoreanPartOfSpeechStopFilter`는 특정 품사(POS)에 해당하는 토큰을 제거합니다. `DEFAULT_STOP_TAGS`에 포함된 품사 목록(Lucene 10.3.2 소스):

```java
// KoreanPartOfSpeechStopFilter.java (Lucene 10.3.2)
public static final Set<POS.Tag> DEFAULT_STOP_TAGS =
    Collections.unmodifiableSet(EnumSet.of(
        POS.Tag.EP,   // 선어말어미
        POS.Tag.EF,   // 종결어미
        POS.Tag.EC,   // 연결어미
        POS.Tag.ETN,  // 명사형 전성어미
        POS.Tag.ETM,  // 관형형 전성어미
        POS.Tag.IC,   // ← 감탄사 (Interjection)
        POS.Tag.JKS,  // 주격조사
        POS.Tag.JKC,  // 보격조사
        // ... JKG, JKO, JKB, JKV, JKQ, JX, JC (조사류)
        POS.Tag.MAG,  // 일반부사
        POS.Tag.MAJ,  // 접속부사
        POS.Tag.MM,   // 관형사
        // ... SP, SSC, SSO, SC, SE (구두점/기호)
        POS.Tag.XPN,  // 접두사
        POS.Tag.XSA,  // 형용사 접미사
        POS.Tag.XSN,  // 명사 접미사
        POS.Tag.XSV,  // 동사 접미사
        // ... UNA, NA, VSV (미상)
    ));
```

**핵심**: `POS.Tag.IC`(감탄사)가 기본 stop tags에 포함되어 있습니다.

### 같은 "안녕", 다른 품사

한국어에서 "안녕"은 **문맥에 따라 다른 품사**로 태깅됩니다:

| 문맥 | Nori 분석 결과 | 품사 | Stop Filter |
|------|-------------|------|------------|
| "안녕**하세요**" | 안녕 + 하 + 세요 | **NNG**(명사) + XSV + EF | 안녕 **통과** ✓ |
| "안녕**하**" | 안녕 + 하 | **NNG**(명사) + XSV | 안녕 **통과** ✓ |
| "안녕" (standalone) | 안녕 | **IC**(감탄사) | 안녕 **제거** ✗ |

mecab-ko 사전(Nori가 사용하는 사전)에서 "안녕"은 NNG(명사, "평안")과 IC(감탄사, 인사말) 두 가지 엔트리를 가집니다. 뒤에 "하"(동사 접미사)가 오면 **명사+하다 패턴**으로 인식하여 NNG로 태깅하지만, 단독으로 쓰이면 인사말(감탄사)로 우선 분류합니다.

### 비대칭 현상의 전체 흐름

![Nori 형태소 분석 비대칭 현상 — 같은 '안녕'이 문맥에 따라 NNG/IC로 다르게 태깅](/uploads/project/WikiEngine/nori-stop-filter-fix/nori-asymmetric-flow.svg)

인덱스에 "안녕" 토큰이 저장되어 있지만, 검색 시 쿼리 자체가 사라져서 매칭할 수 없습니다. 같은 단어가 **인덱싱 시점(NNG)과 검색 시점(IC)에서 다른 품사로 태깅**되는 것이 핵심 원인입니다.

---

## 4. 선택지 비교

### A. Stop Tags 커스터마이징 (IC 제거)

`DEFAULT_STOP_TAGS`에서 `POS.Tag.IC`를 제외한 커스텀 Set을 사용합니다.

**현업 근거:**

- Elastic 공식 Guide Book(김종민 저): "한글 검색에서는 보통 명사, 동명사 정도만 검색하고 조사, 형용사 등은 제거하는 것이 바람직" — 이 원칙에 따르면 IC도 제거 대상이지만, **검색어 자체가 IC로 태깅되어 쿼리가 소멸하는 것은 의도된 동작이 아닙니다.**
- Elasticsearch `nori_part_of_speech` 필터에서 `stoptags` [커스터마이징은 공식 문서에서 명시적으로 지원](https://www.elastic.co/guide/en/elasticsearch/plugins/current/analysis-nori-speech.html)하는 기능입니다.

| 항목 | 분석 |
|------|------|
| 인덱스 크기 | 변화 없음 — IC 토큰은 코퍼스에서 빈도가 낮음 |
| 재색인 | **불필요** — 쿼리 쪽만 고치면 기존 인덱스의 NNG '안녕'과 매칭됨 |
| 랭킹 품질 | BM25 정상 작동. '아', '와' 같은 노이즈 감탄사도 인덱싱되지만 IDF가 자연 감쇄 |
| 해결 범위 | IC 품사 한정 |

### B. Multi-field N-gram 폴백

같은 콘텐츠를 Nori 필드 + edge_ngram 필드로 이중 인덱싱합니다.

**현업 근거:**

- **딜리셔스(B2B 플랫폼)**: Nori + 일본어(kuromoji) + 영어 analyzer를 multi-field로 구성, 2-phase 검색(keyword 필터 → multi-field match 폴백). SQL JOIN+LIKE 대비 **173배 성능 향상**(9.87s → 0.057s).
- **배달의민족(50M 상품)**: 분석기를 ES 밖으로 빼서 애플리케이션 레이어로 이전. `_analyze` API 호출 오버헤드와 segment merge 시 분석 요청 거부 문제를 해결.
- **Sease(2023 벤치마크)**: n-gram(1-2gram)은 "the fox" 2토큰 → **13토큰으로 6.5배 토큰 폭발**, "substantial impact on storage size, memory footprint, and CPU".

| 항목 | 분석 |
|------|------|
| 인덱스 크기 | **+50~100%** (36GB → 55~72GB) |
| 재색인 | **필수** — 2시간(로컬) + rsync 배포 |
| 메모리 | Term dictionary 증가 → MMap 페이지 캐시 히트율 하락 |
| 해결 범위 | **모든 토큰 손실 케이스** — 가장 넓음 |

### C. Query-time 폴백

토큰화 결과가 0건이면 PrefixQuery로 재시도합니다.

**현업 근거:**

- **Elasticsearch #51840(2020~현재 Open)**: 커뮤니티에서 `fallback_query` 기능을 요청. 제안된 패턴: Phrase → AND → OR → Fuzzy ("continuum of sloppiness"). Julie Tibshirani(Elastic 개발자): "multiple search requests를 보내는 대안 대비 충분한 가치를 제공할지 의문" — Elastic 자체적으로도 아직 네이티브 구현이 없습니다.
- **Bloomreach(상용 검색 플랫폼)**: query relaxation을 기본 활성화, API 응답에 `"mode": "relaxedQuery"` 메타데이터를 포함합니다.

| 항목 | 분석 |
|------|------|
| 인덱스 크기 | 변화 없음 |
| 재색인 | 불필요 |
| 랭킹 품질 | 폴백 시 BM25 대신 PrefixQuery → 랭킹 품질 저하 |
| 해결 범위 | **토큰 전멸** 케이스만 커버 (부분 손실은 감지 불가) |

### 비교 매트릭스

| | A. IC 제거 | B. Multi-field N-gram | C. Query 폴백 |
|---|---|---|---|
| 수정 규모 | 1줄 | 스키마+쿼리+재색인 | 쿼리 빌더 분기 |
| 인덱스 크기 | ±0 | **+50~100%** | ±0 |
| 재색인 | 불필요 | 필수 (2h+rsync) | 불필요 |
| ARM 2코어 부담 | 없음 | **높음** | 없음 |
| 해결 범위 | IC 한정 | 모든 토큰 손실 | 토큰 전멸만 |
| 랭킹 품질 | BM25 유지 | 튜닝 필요 | 폴백 시 저하 |
| 현업 채택 | ES 기본 커스텀 | 배민/딜리셔스급 | Bloomreach 상용 |

---

## 5. 결정 — A + B + C

### 처음에는 A + C만 적용했습니다

처음에는 B(Multi-field N-gram)를 빼고 A + C만 적용하려 했습니다. 콘텐츠 전체를 n-gram으로 이중 인덱싱하면 인덱스가 36GB에서 55~72GB로 늘어나는데, 2코어 ARM 서버에서 MMap 페이지 캐시의 워킹셋이 그만큼 커지면 I/O thrashing이 발생할 수 있고, 재색인에 2시간 이상이 필요한 점도 부담이었습니다.

A(IC 제거)만으로 "안녕" 검색 0건 문제는 해결됐고, C(토큰 전멸 폴백)를 보험으로 두면 충분하다고 판단했습니다.

### 그런데 "안녕하세" 문제가 남았습니다

A + C를 배포하고 검증하는 과정에서 "안녕하세" 검색 시 "하세" 문서만 노출되는 문제를 발견했습니다(섹션 7에서 상세 분석). 이 문제는 IC 필터링과는 별개로, 형태소 분석기가 불완전한 입력을 비표준적으로 토큰화하면서 발생하는 구조적 한계였습니다.

A와 C로는 이 케이스를 커버할 수 없었습니다. A는 IC 품사만 해결하고, C는 토큰이 **전부** 사라질 때만 작동하지 일부 토큰이 잘못 분리되는 경우는 감지하지 못합니다.

### B를 추가한 이유

여기서 다시 B를 검토했습니다. 핵심은 n-gram을 **전체 콘텐츠가 아니라 title 필드에만** 적용하는 것이었습니다. title만 n-gram으로 추가하면 인덱스 증가폭이 36GB → 39GB(+8%)로 최소화되어, 처음에 B를 제외했던 디스크/메모리 부담이 사실상 사라집니다.

Elastic 공식 CJK 검색 가이드에서 제시한 형태소+n-gram multi-field 조합 패턴을 참고하여, 형태소 분석 쿼리와 n-gram 쿼리를 dis_max로 결합하면 형태소가 실패하는 케이스에서 n-gram이 안전망 역할을 합니다.

### A + B + C 세 레이어가 각각 다른 실패 모드를 커버합니다

- **A(IC 제거)**: "안녕" 같은 감탄사가 IC로 필터링되는 문제를 근본적으로 해결합니다. IC를 제거하면 "안녕"이 정상적인 BM25 토큰으로 생존하여 title^3 boost와 동의어 확장이 정상 동작합니다. n-gram만으로 대체하면 BM25 랭킹 품질이 떨어지고 동의어 확장도 비활성화되기 때문에, A를 빼고 B만으로는 동일한 품질을 얻을 수 없습니다.
- **B(title_ngram + dis_max)**: "안녕하세"처럼 형태소 분석이 불완전한 입력을 비표준적으로 토큰화할 때, n-gram이 문자 시퀀스 매칭으로 관련 문서를 상위에 올립니다.
- **C(PrefixQuery 폴백)**: A와 B가 커버하지 못하는 미지의 엣지 케이스에 대한 보험입니다. A를 적용하면 IC 케이스에서 C는 트리거되지 않고, B가 대부분의 불완전 입력을 처리하므로, C는 순수하게 아직 발견되지 않은 엣지 케이스만 커버합니다.

IC 외에 비슷한 문제가 생길 수 있는 품사:

| 품사 | 예시 | 검색 빈도 | 필터링 시 문제? |
|------|------|----------|----------------|
| **IC** (감탄사) | 안녕, 감사, 축하 | **높음** | **높음** ← 이 이슈 |
| MAG (부사) | 빨리, 정말, 매우 | 중간 | 낮음 (단독 검색 드묾) |
| MM (관형사) | 이, 그, 저 | 낮음 | 낮음 (stop word 역할) |

IC가 유일하게 **유의미한 단어인데 필터되는** 케이스입니다. MAG/MM은 진짜 stop word에 가깝습니다.

---

## 6. 구현

### A. Stop Tags 커스터마이징

```java
// LuceneConfig.java
@Bean
Analyzer luceneAnalyzer() {
    UserDictionary userDict = loadUserDictionary();

    // DEFAULT_STOP_TAGS에서 IC(감탄사) 제거
    // "안녕"이 IC로 태깅 → 필터링 → 빈 쿼리 → 0건이 되는 문제 해결
    // IC 제거 시 '아', '와' 같은 노이즈 감탄사도 인덱싱되지만,
    // BM25 IDF가 고빈도 토큰의 가중치를 자연 감쇄시키므로 랭킹 영향은 무시 가능
    Set<POS.Tag> stopTags = EnumSet.copyOf(
            KoreanPartOfSpeechStopFilter.DEFAULT_STOP_TAGS);
    stopTags.remove(POS.Tag.IC);

    return new KoreanAnalyzer(
            userDict,
            KoreanTokenizer.DEFAULT_DECOMPOUND,
            stopTags,
            false
    );
}
```

`EnumSet.copyOf()`로 기존 DEFAULT_STOP_TAGS의 mutable 복사본을 만든 뒤 IC만 제거합니다. 나머지 29개 stop tag는 그대로 유지됩니다.

### C. 토큰 전멸 폴백

```java
// LuceneSearchService.java — buildTextQueryWithSynonyms()
List<String> tokens = tokenize(keyword);

// 토큰 전멸 폴백: Nori가 모든 토큰을 stop filter로 제거한 경우
// title 필드의 term dictionary에서 prefix 매칭으로 결과를 반환한다
if (tokens.isEmpty()) {
    log.info("토큰 전멸 폴백 적용: keyword={}", keyword);
    return new PrefixQuery(new Term("title", keyword));
}

List<QueryExpansionService.ExpandedTerm> expanded =
        queryExpansionService.expand(tokens);
// ... 이하 기존 동의어 확장 로직
```

A를 적용하면 "안녕"은 더 이상 IC로 필터링되지 않으므로 `tokens`가 비어있지 않습니다. 이 폴백은 **아직 발견되지 않은 다른 품사 태깅 엣지 케이스**에서만 작동합니다.

PrefixQuery는 title 필드의 term dictionary에서 해당 접두사로 시작하는 텀을 찾습니다. BM25 랭킹 대신 constant score가 적용되므로 정상 검색보다 랭킹 품질은 떨어지지만, **0건보다는 결과를 반환하는 것이 낫습니다**.

### B. Multi-field N-gram + dis_max

형태소 분석기가 불완전한 입력을 비표준적으로 토큰화하는 문제를 보완하기 위해, title 필드에 2-3gram 분석기를 추가하고 dis_max 쿼리로 결합합니다.

**PerFieldAnalyzerWrapper 구성:**

```java
// LuceneConfig.java
@Bean
Analyzer luceneAnalyzer() {
    Analyzer noriAnalyzer = createNoriAnalyzer();
    Analyzer ngramAnalyzer = createNgramAnalyzer();
    return new PerFieldAnalyzerWrapper(noriAnalyzer, Map.of("title_ngram", ngramAnalyzer));
}
```

기본 분석기는 Nori(IC 제거 적용), `title_ngram` 필드만 2-3gram 분석기를 사용합니다. 콘텐츠 전체를 n-gram으로 인덱싱하면 토큰 폭발(6.5배)이 발생하므로, title만 n-gram으로 제한하여 인덱스 증가를 최소화합니다.

**인덱싱 시 title_ngram 필드 추가:**

```java
// LuceneIndexService.java
doc.add(new TextField("title_ngram", post.getTitle(), Field.Store.NO));
```

기존 title 필드(Nori 분석)와 별도로 title_ngram 필드를 추가합니다. `Field.Store.NO`로 원본 텍스트는 저장하지 않아 디스크 사용을 최소화합니다.

**dis_max 쿼리 구조:**

```java
// LuceneSearchService.java
Query textOrNgram = new DisjunctionMaxQuery(
        List.of(
                textQuery,
                new BoostQuery(ngramQuery, 2.0f)
        ),
        0.1f
);

BooleanQuery.Builder builder = new BooleanQuery.Builder()
        .add(textOrNgram, BooleanClause.Occur.MUST)
        .add(viewBoost, BooleanClause.Occur.SHOULD)
        .add(likeBoost, BooleanClause.Occur.SHOULD)
        .add(recencyBoost, BooleanClause.Occur.SHOULD);
```

**dis_max의 동작 원리:**

- 형태소 분석(textQuery)과 n-gram(ngramQuery) 중 **높은 점수를 선택**합니다
- `tie_breaker=0.1`: 양쪽 모두 매칭될 때 낮은 쪽 점수의 10%를 보너스로 추가합니다
- n-gram boost=2.0: textQuery 내부의 `title^3` boost와 경쟁할 수 있도록 가중치를 부여합니다

**기존 구조 vs dis_max 구조:**

| | 기존 (MUST + SHOULD) | dis_max |
|---|---|---|
| 쿼리 | textQuery(**MUST**) + ngram(SHOULD) | dis_max(textQuery, ngram)(**MUST**) |
| "안녕하세" | textQuery에서 '하세' 매칭 → '하세' 문서 상위 | n-gram에서 '안녕하세' 매칭 → '안녕하세요' 문서 상위 |
| 핵심 차이 | MUST에서 탈락하면 ngram이 구제 불가 | **둘 중 하나만 매칭되면 통과** |

기존에는 `textQuery`가 MUST였기 때문에 형태소 분석 결과가 검색 결과를 완전히 지배했습니다. dis_max 구조에서는 형태소 분석이 실패해도 n-gram이 매칭되면 문서가 반환됩니다.

### 비용

- **인덱스 크기**: 36GB → 39GB (+8%, title_ngram만 추가)
- **재색인**: **필수** — title_ngram 필드 추가 (12M건, 69분)
- **서버 영향**: MMap 페이지 캐시 약간 증가, 체감 영향 없음

---

## 7. 추가 발견 — "안녕하세" 검색 시 "하세" 결과가 나오는 문제

IC 수정을 검증하는 과정에서 또 다른 문제를 발견했습니다. "안녕하세"를 검색하면 **"안녕하세요" 관련 문서가 아닌 "하세" 관련 문서**가 최상위에 노출됩니다.

![안녕하세 검색 시 하세 결과](/uploads/project/WikiEngine/nori-stop-filter-fix/after-search-annyeonghase.png)

> 혹시 "안녕하"를 찾으셨나요? (Did-you-mean)은 정상 동작하지만, 실제 검색 결과는 "하세", "하세쿠라", "하세 히로시" 등 관련 없는 문서가 반환됩니다.

### 원인 분석 — 불완전한 입력과 형태소 분석의 충돌

"안녕하세"는 **"안녕하세요"의 미완성 입력**입니다. Nori는 이를 문법적으로 불완전한 형태로 분석합니다:

```
"안녕하세요" (완성형)
  → Nori: '안녕'(NNG) + '하'(XSV) + '세요'(EF)
  → Stop Filter: '안녕' 생존
  → 인덱스 토큰: ['안녕']

"안녕하세" (미완성형)
  → Nori: '안녕'(NNG/IC) + '하세'(???)
  → Stop Filter: '안녕' 생존 + '하세' 생존
  → 쿼리 토큰: ['안녕', '하세']
```

핵심 문제: "안녕하세요"는 Nori 사전에 있는 표준형이라 정상 분석되지만, "안녕하세"는 사전에 없는 불완전한 형태이므로 **비표준적 토큰 분리**가 발생합니다.

### 왜 "하세" 문서가 상위에 노출되는가

현재 `MultiFieldQueryParser`는 기본 연산자가 **OR(SHOULD)** 입니다:

```
쿼리: (title:"안녕"^3 OR content:"안녕") OR (title:"하세"^3 OR content:"하세")
```

"하세"라는 제목의 문서(일본 성씨)는 title 필드에서 **완전 일치**하므로 BM25 점수가 매우 높습니다. title에 3배 boost가 걸려 있어 "안녕"이 본문에만 등장하는 문서보다 "하세" 제목 문서가 더 높은 점수를 받습니다.

반면, 인덱스에서 "안녕하세요"는 '안녕' 단일 토큰으로 저장되어 있으므로, 쿼리의 '하세' 토큰과는 매칭되지 않습니다.

### 선택지 비교

#### D-1. 기본 연산자를 AND로 변경

```java
parser.setDefaultOperator(QueryParser.Operator.AND);
```

| 항목 | 분석 |
|------|------|
| 동작 | 모든 토큰이 문서에 존재해야 매칭 |
| "안녕하세" | "안녕" AND "하세" → "하세" 전용 문서 제외 ✓ |
| **문제** | "안녕하세요" 문서도 매칭 실패 (인덱스에 '하세' 토큰이 없음) ✗ |
| 부작용 | 재현율(recall) 감소. "삼성 반도체"처럼 두 단어가 모두 있어야 매칭 |

Google, Bing 등 대형 검색엔진은 AND를 기본으로 사용하지만, 이들은 **수십억 문서 규모에서 충분한 재현율이 확보**되기 때문입니다. 12M 규모에서는 AND로 전환하면 0건이 되는 케이스가 늘어날 수 있습니다.

#### D-2. PhraseQuery Boost 추가

원본 키워드를 phrase query로 만들어 높은 boost를 부여합니다.

```java
// 기존 OR 쿼리에 PhraseQuery를 SHOULD로 추가 (boost=5.0)
PhraseQuery.Builder pb = new PhraseQuery.Builder();
pb.setSlop(2);
for (String token : tokens) pb.add(new Term("title", token));
builder.add(new BoostQuery(pb.build(), 5.0f), BooleanClause.Occur.SHOULD);
```

| 항목 | 분석 |
|------|------|
| 동작 | 토큰이 연속 출현하는 문서에 추가 점수 부여 |
| 장점 | 기존 OR 동작 유지 + 구절 매칭 시 순위 상승 |
| **문제** | "안녕하세요"의 인덱스 토큰은 '안녕' 하나뿐이므로 구절 매칭 자체가 불가능 ✗ |

#### D-3. title_raw 필드에 PrefixQuery 추가

분석되지 않은 원본 제목 필드에서 접두사 매칭합니다.

```java
// 원래 쿼리 + title_raw 접두사 매칭을 SHOULD로 결합
Query prefixBoost = new BoostQuery(
    new PrefixQuery(new Term("title_raw", keyword.toLowerCase())), 5.0f);
builder.add(prefixBoost, BooleanClause.Occur.SHOULD);
```

| 항목 | 분석 |
|------|------|
| 동작 | "안녕하세" → title_raw에서 "안녕하세"로 시작하는 제목을 prefix 매칭 |
| 장점 | "안녕하세요" 제목 문서가 **직접 매칭**되어 상위 노출 |
| 한계 | 제목 접두사만 매칭 (본문 검색에는 영향 없음) |
| 인덱스 영향 | title_raw 필드가 이미 존재하므로 추가 비용 없음 |

#### D-4. 현재 상태 유지 (Did-you-mean 의존)

현재 Did-you-mean이 "안녕하"를 제안하고 있으며, 이를 클릭하면 정상 결과가 나옵니다.

| 항목 | 분석 |
|------|------|
| 동작 | 검색 결과는 "하세" 문서를 보여주되, Did-you-mean으로 올바른 검색어를 안내 |
| 장점 | 추가 구현 없음. 사용자가 Did-you-mean을 클릭하면 해결 |
| **한계** | 사용자 경험이 나쁨 — 원하는 결과를 바로 볼 수 없음 |

### 비교 매트릭스

| | D-1. AND 연산자 | D-2. Phrase Boost | D-3. title_raw Prefix | D-4. 현상 유지 |
|---|---|---|---|---|
| "안녕하세" → "안녕하세요" 매칭 | ✗ (AND 실패) | ✗ (구절 불가) | **✓** | ✗ (하세 노출) |
| "하세" 노이즈 제거 | ✓ | △ (순위만 조정) | **✓** (prefix가 상위) | ✗ |
| 기존 검색 영향 | **재현율 감소** | 없음 | 없음 | 없음 |
| 구현 복잡도 | 1줄 | 중간 | 3줄 | 없음 |

### 판단 — B(dis_max) + D-4(Did-you-mean) 조합

D-1~D-3은 각각 구조적 한계가 있지만, 앞서 결정한 **B(title_ngram + dis_max)**가 이 문제를 부분적으로 해결합니다.

- dis_max로 n-gram 결과가 상위에 올라오면서 "안녕하세요" 관련 문서가 노출됩니다. 기존에는 textQuery(MUST) 구조에서 형태소 분석 결과('하세')가 랭킹을 지배했지만, dis_max 구조에서는 n-gram이 '안녕하세'를 매칭하여 관련 문서를 상위로 올립니다.
- Did-you-mean이 "안녕하"를 제안하여 사용자가 올바른 검색어로 재검색할 수 있습니다.
- 현업에서도 자동완성/Did-you-mean으로 불완전 입력을 보정하는 패턴이 표준입니다(Google, Naver).

이 문제는 **형태소 분석기의 구조적 한계**(불완전한 입력 처리 불가)와 **OR 기반 쿼리의 노이즈 문제**가 결합된 케이스이며, IC 수정과는 별개의 이슈입니다. dis_max가 랭킹을 개선하고, Did-you-mean이 UX를 보정하는 이중 구조로 대응합니다.

---

## 8. 한국어 형태소 분석의 구조적 한계

이 글에서 다룬 두 가지 문제(IC 필터링, 불완전 입력)는 Nori만의 문제가 아니라, **사전 기반 형태소 분석기의 구조적 한계**입니다.

### 알려진 Nori 이슈들

| 이슈 | 설명 | 출처 |
|------|------|------|
| 빈 토큰 생성 | "그레이맨" 분석 시 zero-length 토큰 생성 | [LUCENE-8524](https://github.com/apache/lucene/issues/9570) |
| 아래아(ㆍ) 처리 | U+318D 이후 모든 문자가 하나의 토큰으로 합쳐짐 | [LUCENE-8524](https://github.com/apache/lucene/issues/9570) |
| 조사/어미 세분화 부족 | "J", "E" 대분류만 존재하여 특정 조사/어미만 제거 불가 | [LUCENE-11778](https://github.com/apache/lucene/issues/11778) |
| OOV(미등록어) | 신조어, 고유명사를 처리하지 못함 | 사전 기반 분석기 공통 |
| **불완전 입력** | 미완성 활용형("안녕하세")을 비표준적으로 토큰화 | 이 글에서 발견 |

### 현업의 대응 방향

| 접근 | 사용처 | 설명 |
|------|--------|------|
| 사전 기반 + 커스텀 | ES + Nori (대부분) | stop tags, user dictionary 커스터마이징 |
| ML 기반 | 카카오 Khaiii | CNN 기반 형태소 분석, F1 97.11 |
| 비지도 학습 | 네이버 연구 | 원시 텍스트에서 통계적 어휘 추출 |
| 하이브리드 | 대규모 검색 | 형태소 분석(정밀도) + 서브워드(재현율) 결합 |
| Query Understanding | Google, 네이버 | ML 기반 쿼리 의도 분류 + 자동 보정 |

이 프로젝트에서는 Nori의 성능(3,000+ docs/sec)과 메모리 효율이 12M 규모에 적합하므로 Nori를 유지하되, stop tags 커스터마이징(IC 제거) + title_ngram + dis_max + 토큰 전멸 폴백으로 한계를 보완하는 접근을 선택했습니다. 불완전 입력 문제는 dis_max가 n-gram 기반 랭킹을 개선하고, Did-you-mean이 UX 보정을 담당합니다.

---

## 9. 검증 — Before / After

### Before — 수정 전 상태

**"안녕" 자동완성 — 정상 동작 (Redis 기반):**

![안녕 자동완성](/uploads/project/WikiEngine/nori-stop-filter-fix/before-autocomplete-annyeong.png)

**"안녕" 검색 — AI 요약은 나오지만 게시글 0건:**

![안녕 검색 AI 요약만](/uploads/project/WikiEngine/nori-stop-filter-fix/before-search-annyeong-ai.png)

> AI 요약은 이전 캐시에서 결과를 가져왔지만, 실제 검색 결과는 "검색 결과가 없습니다." IC 필터링으로 쿼리 자체가 소멸한 상태.

**"안녕하세" 검색 — 0건 (수정 전):**

![안녕하세 검색 0건](/uploads/project/WikiEngine/nori-stop-filter-fix/before-search-annyeonghase-zero.png)

**"안녕하세" 검색 — "하세" 문서만 노출 (MUST 구조):**

![안녕하세 하세 결과](/uploads/project/WikiEngine/nori-stop-filter-fix/before-search-annyeonghase-hase-results.png)

> textQuery(MUST) 구조에서 Nori가 ['안녕', '하세']로 토큰화 → "하세" 완전 일치 문서가 title^3 boost로 상위 독점.

**"황치열" 자동완성 — 빈 결과:**

![황치열 자동완성 안 됨](/uploads/project/WikiEngine/nori-stop-filter-fix/before-autocomplete-hwang-empty.png)

> Lucene fallback에서 title_jamo PrefixQuery 사용 시 12M건의 자모 분해 term이 너무 많아 매칭 실패.

### After — A + B + C 적용 후

**"안녕" 자동완성 — 정상:**

![안녕 자동완성 정상](/uploads/project/WikiEngine/nori-stop-filter-fix/after-autocomplete-annyeong.png)

**"안녕" 검색 — 정상 반환 + AI 요약:**

![안녕 검색 정상](/uploads/project/WikiEngine/nori-stop-filter-fix/after-search-annyeong.png)

> IC 제거로 "안녕"이 감탄사로 필터링되지 않아 정상 매칭. AI 요약도 검색 결과를 기반으로 정상 생성.

**"안녕하세" 검색 — "안녕하세요" 관련 문서 상위 노출:**

![안녕하세 dis_max 결과](/uploads/project/WikiEngine/nori-stop-filter-fix/after-search-annyeonghase-dismax.png)

> dis_max + n-gram으로 "안녕하세요 안녕하세요.", "안녕하세요. 안녕하세요." 등 관련 문서가 상위에 노출. Did-you-mean "안녕하" 제안도 정상.

**"황" 자동완성 — "황치열" 정상 동작:**

![황 자동완성 정상](/uploads/project/WikiEngine/nori-stop-filter-fix/after-autocomplete-hwang.png)

> title_raw PrefixQuery로 변경하여 완성 한글 자동완성 정상 동작.

**"황치열" 검색 — 정상 반환 + AI 요약:**

![황치열 검색 정상](/uploads/project/WikiEngine/nori-stop-filter-fix/after-search-hwang.png)

### 개선 요약

| 항목 | Before | After |
|------|--------|-------|
| "안녕" 검색 | **0건** | **정상 반환** (안녕에 안녕, 안녕하세요 등) |
| "안녕" 자동완성 | **없음** | **정상** (안녕, 안녕하세, 안녕하) |
| "안녕하세" 검색 | **"하세" 문서만** | **"안녕하세요" 관련 문서 상위** + Did-you-mean |
| "황" 자동완성 | **빈 결과** | **"황치열" 정상 제안** |
| 인덱스 크기 | 36GB | 39GB (+8%) |
| 재색인 | - | 필수 (12M건, 69분) |
| 랭킹 | BM25 only | dis_max(BM25, N-gram) + 인기도 + 최신성 |

수정 사항: LuceneConfig.java (IC 제거 + PerFieldAnalyzerWrapper), LuceneIndexService.java (title_ngram 필드), LuceneSearchService.java (dis_max 쿼리 + 자동완성 title_raw fallback).

---

## 출처

- [Lucene 10.3.2 — KoreanPartOfSpeechStopFilter.java](https://github.com/apache/lucene/blob/main/lucene/analysis/nori/src/java/org/apache/lucene/analysis/ko/KoreanPartOfSpeechStopFilter.java)
- [Elastic Guide Book — Nori 한글 형태소 분석기](https://esbook.kimjmin.net/06-text-analysis/6.7-stemming/6.7.2-nori)
- [Elastic Blog — Nori: The Official Elasticsearch Plugin for Korean](https://www.elastic.co/blog/nori-the-official-elasticsearch-plugin-for-korean-language-analysis)
- [LUCENE-8524 — Nori tokenization issues](https://github.com/apache/lucene/issues/9570)
- [LUCENE-11778 — Detailed POS tags for particles/endings](https://github.com/apache/lucene/issues/11778)
- [Elasticsearch #51840 — Fallback Query](https://github.com/elastic/elasticsearch/issues/51840)
- [배달의민족 기술블로그 — ES 인덱스 & 쿼리 최적화](https://techblog.woowahan.com/20161/)
- [딜리셔스 기술블로그 — Elasticsearch 도입기](https://dealicious-inc.github.io/2021/11/22/dealibird-elastic-search.html)
- [Sease — When and How to Use N-grams in Elasticsearch](https://sease.io/2023/12/when-and-how-to-use-n-grams-in-elasticsearch.html)
- [카카오 기술블로그 — Khaiii 형태소 분석기](https://tech.kakao.com/posts/358)
- [Elastic Blog — How to implement Japanese full-text search](https://www.elastic.co/blog/how-to-implement-japanese-full-text-search-in-elasticsearch)
- [Elastic Blog — How to Search CJK Text Part 2: Multi-fields](https://www.elastic.co/blog/how-to-search-ch-jp-kr-part-2)

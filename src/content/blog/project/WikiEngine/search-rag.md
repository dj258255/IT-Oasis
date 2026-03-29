---
title: 'AI 검색 요약 — RAG 파이프라인 + SSE 스트리밍 + 비용 모니터링'
titleEn: 'AI Search Summary — RAG Pipeline + SSE Streaming + Cost Monitoring'
description: Lucene BM25 검색 결과 Top-5 문서를 LLM 컨텍스트에 주입하는 RAG(Retrieval-Augmented Generation) 파이프라인을 구축합니다. Spring AI 2.0 + Gemini 2.0 Flash로 SSE 스트리밍 답변을 생성하고, 인라인 출처 배지를 파싱하여 게시글 링크로 연결합니다. 할루시네이션 방지(문서 기반 답변 제한 + 인용 강제), AI 요약 트리거 조건(네비게이션 의도 스킵), Redis Token Bucket rate limiting(10 RPM 전역), 동일 쿼리 캐싱(TTL 30분, LLM 비용 40-60% 절감), Grafana 7패널 대시보드(RPM, 응답시간, 토큰, 피드백, 비용 추정)까지 포함합니다. BM25가 이 프로젝트에서 Dense Retrieval보다 적합한 근거와, Hybrid Retrieval 전환 로드맵도 정리합니다.
descriptionEn: Builds a RAG pipeline injecting Lucene BM25 Top-5 search results into LLM context. Uses Spring AI 2.0 + Gemini 2.0 Flash for SSE streaming answers with inline citation badges parsed to post links. Includes hallucination prevention, trigger conditions (skip navigation intent), Redis Token Bucket rate limiting (10 RPM global), query caching (30min TTL, 40-60% LLM cost reduction), and Grafana 7-panel dashboard. Documents why BM25 outperforms Dense Retrieval for this project and the Hybrid Retrieval roadmap.
date: 2026-03-28T00:00:00.000Z
tags:
  - Lucene
  - Search Engine
  - RAG
  - LLM
  - Spring AI
  - Gemini
  - SSE
  - Redis
  - Grafana
  - Performance
  - Spring Boot
  - Wiki
category: project/WikiEngine
coverImage: /uploads/project/WikiEngine/search-rag/ai-summary-full-with-results.png
draft: false
---

## 이전 글

[콘텐츠 필터링 — 운영 안전장치](/blog/project/wikiengine/search-content-filter)에서 Aho-Corasick 금칙어 필터링, 블라인드 게시글 검색 제외, Negative Caching, 자동완성 안전장치를 구축했습니다.

| 지표 | 결과 |
|------|------|
| 금칙어 필터링 | Aho-Corasick O(N+Z) 탐지, 16,090개 |
| 블라인드 | Occur.MUST_NOT blinded=true |
| Negative Caching | 빈 결과 30초 TTL (cache penetration 방지) |

검색 기능(품질, 인프라, 안전장치)이 모두 갖춰졌습니다. 이 글에서 **검색 결과를 AI가 요약하여 사용자에게 직접적인 답변을 제공**합니다.

---

## 1. 정상 상태 — 현재 검색 경험

```
사용자: "자바 가비지 컬렉션 원리"
  -> 검색 결과: 10건의 게시글 링크 (제목 + snippet)
  -> 사용자가 직접 각 게시글을 클릭하여 읽어야 함
  -> 원하는 답을 찾기까지 평균 2~3개 게시글 탐색 필요
```

프론트엔드에 "AI 요약" 섹션이 있지만, 현재 구현은 **검색 결과와 무관하게 LLM에 쿼리만 전달**하는 방식이다 — 검색된 문서를 컨텍스트로 주입하지 않으므로 **할루시네이션 위험이 높고, 출처 인용이 불가능**하다.

| | 기존 구현 | RAG (이 글) |
|---|---|---|
| 컨텍스트 | 쿼리만 전달 | **검색된 Top-5 문서** 주입 |
| 할루시네이션 | 높음 (LLM 자체 지식에 의존) | 낮음 (문서 기반 답변 제한) |
| 출처 인용 | 불가 | **[문서 N] 인용 + 게시글 링크** |
| 답변 품질 | LLM 학습 데이터 의존 | 실제 인덱스 문서 기반 |

### 검색 엔진의 AI 요약 트렌드

| 서비스 | AI 검색 기능 | 방식 |
|--------|------------|------|
| Google | AI Overviews (SGE) | 검색 결과 상단에 AI 요약 |
| Perplexity | 전체 응답이 AI 요약 | 검색 -> 요약 -> 출처 표시 |
| Bing | Copilot | 대화형 검색 + 출처 인용 |
| 네이버 | Cue: | AI 기반 답변 + 출처 |

---

## 2. 문제 상황 — 기존 검색의 한계

1. **정보 탐색 비용**: 10개 링크 중 어떤 게시글이 답을 포함하는지 모름
2. **지식 종합 불가**: "자바 GC 종류와 각각의 장단점"처럼 여러 문서에 분산된 정보를 하나로 종합할 수 없음
3. **질문형 쿼리 미지원**: "왜 자바는 포인터가 없나?"처럼 자연어 질문에 대한 직접 답변 불가

### RAG로 해결

```
RAG 파이프라인:
  1. Retrieval: 사용자 쿼리로 관련 문서 검색 (기존 Lucene)
  2. Augmentation: 검색된 문서를 LLM 컨텍스트에 주입
  3. Generation: LLM이 문서를 기반으로 답변 생성 + 출처 표시
```

---

## 3. 대안 검토

### LLM 선택

| 모델 | 장점 | 단점 | 판단 |
|------|------|------|------|
| **OpenAI GPT-4o** | 고품질, API 간편 | 유료, 외부 의존 | API 비용 고려 |
| **Anthropic Claude** | 긴 컨텍스트, 정확한 인용 | 유료, 외부 의존 | 대안 |
| **Ollama (로컬 LLM)** | 무료, 데이터 프라이버시 | 로컬 GPU 필요, 품질 제한 | Free Tier에서 GPU 없음 |
| **Google Gemini** | 무료 티어 존재, 한국어 우수 | API 제한 | **선택** |

**선택**: 외부 LLM API (Gemini 무료 티어) + Lucene 검색. Free Tier 서버에서 로컬 LLM은 불가(GPU 없음).

### BM25 vs Dense Retrieval

| 방식 | Retrieval 품질 | 인프라 비용 | 판단 |
|------|-------------|----------|------|
| **BM25 (현재 Lucene)** | 키워드 매칭 기반, 충분히 좋음 | 추가 비용 없음 | **선택** |
| **Dense Retrieval (임베딩)** | 의미 유사도 기반, 더 정확 | 임베딩 모델 + 벡터 DB 필요 | 후반 도입 검토 |
| **Hybrid (BM25 + Dense)** | 최상의 Retrieval | BM25 + 벡터 DB 모두 필요 | **최종 목표** |

**BM25가 이 프로젝트에서 충분한 근거**: wikiEngine은 위키피디아/나무위키 데이터 기반으로 기술 용어 키워드 검색이 주 사용 패턴이다. RAG Retrieval 비교 실험에서 BM25는 키워드 전용 쿼리 NDCG 0.88로 Dense Retrieval(혼합 쿼리 0.65) 대비 우위를 보였다 (출처: [BM25 vs Dense Retrievers 비교](https://medium.com/@siddharth_58896/rag-techniques-bm25-vs-dense-retrievers-a-complete-practical-guide-b1302ee35b7b)). 엔지니어링 로그, 금융 데이터, 법률/과학 문서 등 키워드가 명확한 도메인에서는 BM25가 Dense보다 나을 수 있다는 것이 [Anthropic RAG 가이드](https://docs.anthropic.com/en/docs/build-with-claude/retrieval-augmented-generation)의 평가이기도 하다. "AI" to "인공지능" 수준의 동의어는 [쿼리 확장 구현](/blog/project/wikiengine/search-query-enhancement)의 DB 기반 쿼리 확장으로 이미 해결되었다.

### Retrieval 개선 로드맵

[Eugene Yan의 "Search: Query Matching"](https://eugeneyan.com/writing/search-query-matching/)에서 정리한 것처럼 검색 시스템은 **Lexical(BM25) to Graph(동의어) to Embedding(벡터)** 순서로 진화한다.

```
쿼리 확장 구현: BM25 + 동의어 확장 (DB 기반 쿼리 확장) -- 완료
  -> "AI" 검색 시 "인공지능" 문서도 반환

이 글 초기: BM25 + RAG (LLM으로 답변 생성) -- 현재
  -> BM25로 Top-5 문서 검색 -> LLM 컨텍스트 주입 -> 답변 생성
  -> "BM25만으로 Retrieval이 충분한가?" 평가

향후: Hybrid Retrieval (BM25 + Dense) -- 벡터 도입
  -> BM25 Retrieval 품질이 부족한 케이스가 실측으로 확인되면:
    예) "환경 오염의 영향" 검색 -> "공해", "대기질", "수질 오염" 문서 누락
  -> Lucene KnnFloatVectorField(HNSW) + Reciprocal Rank Fusion으로 병합
```

**벡터 검색 도입 시 인프라:**

```
방안 A: Lucene KnnVectorField (임베디드, 추가 인프라 없음) -- 적합
  - 현재 Lucene 10.3.2에 HNSW 기반 벡터 검색 포함
  - 임베딩 모델만 추가 (sentence-transformers all-MiniLM-L6-v2, 384차원)
  - 1,215만 건 x 384차원 = ~21GB 추가 인덱스

방안 B: 외부 벡터 DB (Pinecone, pgvector 등) -- 별도 서버 필요
방안 C: LLM API 임베딩 -- API 비용 + 지연
```

---

## 4. 구현

### 4-1. RAG 파이프라인

```
사용자: "자바 가비지 컬렉션 원리"
  |
[1. Query Understanding] (이전 글에서 구현)
  오타 교정 + 동의어 확장
  |
[2. Retrieval -- Lucene BM25]
  Top-5 문서 검색 (제목 + 본문)
  |
[3. Context 구성]
  검색된 5개 문서의 핵심 내용을 프롬프트에 주입
  |
[4. Generation -- LLM API]
  System: "아래 문서를 참고하여 질문에 답변하세요. 반드시 출처를 표시하세요."
  Context: [문서1 제목+내용], [문서2 제목+내용], ...
  User: "자바 가비지 컬렉션 원리"
  |
[5. Response]
  AI 요약 답변 + 출처 (게시글 링크) + 기존 검색 결과 목록
```

### 4-2. Context 구성

```java
@Service
public class RAGContextBuilder {

    private static final int MAX_CONTEXT_CHARS = 8000;  // ~2000 토큰
    private static final int MAX_DOCS = 5;

    /**
     * 검색 결과 Top-N 문서에서 LLM 컨텍스트를 구성한다.
     * 문서당 최대 글자 수를 제한하여 컨텍스트 윈도우 내에 맞춘다.
     */
    public String buildContext(List<PostSearchResult> results) {
        int perDocLimit = MAX_CONTEXT_CHARS / Math.min(results.size(), MAX_DOCS);
        StringBuilder context = new StringBuilder();

        for (int i = 0; i < Math.min(results.size(), MAX_DOCS); i++) {
            PostSearchResult result = results.get(i);
            String truncated = truncate(result.getContent(), perDocLimit);
            context.append(String.format(
                "[문서 %d] 제목: %s\nID: %d\n내용: %s\n\n",
                i + 1, result.getTitle(), result.getId(), truncated
            ));
        }
        return context.toString();
    }
}
```

### 4-3. LLM API 호출 -- Spring AI 2.0

```java
@Service
public class RagService {

    // Spring AI 2.0.0-M4 + spring-ai-starter-model-google-genai (Gemini 2.0 Flash)

    public AISummaryResponse summarize(String query, List<PostSearchResult> results) {
        String context = buildContext(results);

        String systemPrompt = """
            당신은 검색 결과를 요약하는 AI 어시스턴트입니다.
            아래 제공된 문서만을 참고하여 사용자의 질문에 답변하세요.

            규칙:
            1. 문서에 없는 내용은 답변하지 마세요.
               "제공된 문서에서 해당 정보를 찾을 수 없습니다"라고 답하세요.
            2. 답변에 사용한 문서의 번호를 [문서 N] 형태로 인용하세요.
            3. 한국어로 답변하세요.
            4. 300자 이내로 요약하세요.
            """;

        String userPrompt = String.format("검색 결과:\n%s\n\n질문: %s", context, query);
        String aiResponse = chatClient.prompt(systemPrompt, userPrompt).call().content();

        return new AISummaryResponse(
            aiResponse,
            extractCitations(aiResponse, results),
            results
        );
    }
}
```

### 4-4. SSE 스트리밍

LLM 응답은 1~5초 걸릴 수 있으므로, Server-Sent Events로 토큰 단위 스트리밍한다.

```java
@GetMapping(value = "/search/ai-summary", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
public SseEmitter aiSummaryStream(@RequestParam String q) {
    SseEmitter emitter = new SseEmitter(30_000L);

    // Virtual Thread에서 비동기 실행
    Thread.startVirtualThread(() -> {
        try {
            List<PostSearchResult> results = searchService.search(q);
            // SSE 이벤트: delta (토큰), citations (출처), done, skip, error
            ragService.streamSummary(q, results, emitter);
        } catch (Exception e) {
            emitter.complete();
        }
    });

    return emitter;
}
```

### 4-5. AI 요약 트리거 조건

모든 검색에 AI 요약을 제공하면 비용 낭비다. AiSummaryDecisionService에서 쿼리 의도를 분류한다:

- **네비게이션 의도** ("네이버", "구글", "위키백과") -> AI 요약 스킵
- **거래 의도** ("구매", "가격") -> AI 요약 스킵
- **물음표 쿼리** ("자바 GC?") -> 결과 1건이라도 AI 답변 (Google AI Overviews 동일: 질문형 출현율 28~38%)
- **일반 쿼리** -> 결과 3건 이상일 때만 AI 답변

### 4-6. 할루시네이션 방지

| 전략 | 설명 |
|------|------|
| **문서 기반 답변 제한** | 시스템 프롬프트에 "제공된 문서만 참고" 명시 |
| **인용 강제** | 답변에 [문서 N] 인용 필수, 인용 없는 문장 경고 |
| **Retrieval 품질 확인** | 검색 결과 BM25 스코어가 임계값 미만이면 AI 요약 스킵 |
| **사용자 피드백** | "이 답변이 도움이 되었나요?" 버튼으로 품질 모니터링 |

---

## 5. 비용 분석 + 모니터링

### Rate Limiting -- Redis Token Bucket

```
AtomicInteger(서버별) -> Redis INCR + EXPIRE(전역)로 전환
- 10 RPM 전역 공유 (서버 2대)
- Redis 장애 시 rate limit 통과 허용 (Gemini 자체 429로 2차 방어)
```

### 동일 쿼리 캐싱

```
Redis 캐싱 (TTL 30분):
- 캐시 히트 시 Gemini 호출 없이 즉시 SSE 전송 (비용 0, 지연 ~ms)
- 현업 기준 동일 쿼리 반복률 30%+ -> LLM 비용 40-60% 절감
```

### 비용 추정

| 항목 | 추정 비용 |
|------|---------|
| **Gemini 2.0 Flash (무료 티어)** | **15 RPM**, 1,000 RPD, 250K TPM |
| Gemini 2.0 Flash (Tier 1 유료) | $0.10/1M input + $0.40/1M output |
| 예상 사용량 (일 1,000건 AI 검색) | ~1.2M input + ~0.3M output 토큰 |
| 월 비용 (Tier 1 유료) | ~$4.8/월 |
| 월 비용 (무료) | $0 (무료 티어 내, 일 1,000건 한계) |

**토큰 수 산출 근거**: Top-5 문서 x 500자 context = 2,500자. 약 1,000 토큰/건. 시스템 프롬프트(~200 토큰) + 쿼리(~10 토큰) = ~1,210 토큰/건. Output 평균 300자. 약 300 토큰/건.

### 피드백 시스템

```sql
CREATE TABLE ai_summary_feedback (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    query VARCHAR(500) NOT NULL,
    rating TINYINT NOT NULL,  -- 1=up, 0=down
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

- Micrometer 카운터: ai_summary_feedback_total{rating=up/down} -> Grafana 자동 노출
- 활용: thumbs_up_rate 추이 모니터링 -> 부정적 피드백 집중 쿼리 패턴 분석 -> 시스템 프롬프트 수동 개선
- RLHF는 불가 (자체 모델 아닌 외부 API). 외부 API 호출 서비스에서 피드백은 프롬프트 개선 + 품질 모니터링 용도

### Grafana 대시보드

Spring Boot 대시보드에 "AI 요약" 섹션 추가 -- 7개 패널:
- LLM 호출 RPM, 응답시간 avg/max, 토큰 사용량, 피드백 결과, 일별 토큰, 일별 비용 추정
- 비용 임계값: $1(노랑), $5(빨강) -- Gemini 2.0 Flash 단가 기준

---

## 6. 검증 -- Before/After

### AI 요약 + 출처 + 피드백

![AI 요약 + 출처 + 피드백](/uploads/project/WikiEngine/search-rag/ai-summary-citations-feedback.png)

### AI 요약 전체 화면 (검색 결과와 함께)

![AI 요약 전체](/uploads/project/WikiEngine/search-rag/ai-summary-full-with-results.png)

### AI 요약 전체 흐름 데모

![AI 요약 전체 흐름 데모](/uploads/project/WikiEngine/search-rag/phase21-ai-summary-full-demo.gif)

> "자바" 검색 -> BM25 Top-5 문서 Retrieval -> Gemini 2.0 Flash SSE 스트리밍 -> 토큰 단위 타이핑 -> 인라인 출처 배지 + 하단 출처 링크 표시. 검색 결과는 즉시 렌더링되고, AI 요약은 별도 SSE 채널로 비동기 수신.

### 트리거 스킵 -- 네비게이션 의도

![트리거 스킵](/uploads/project/WikiEngine/search-rag/trigger-skip-naver.png)

> "네이버" 검색 시 AI 요약 미표시 (네비게이션 의도 -- 사용자가 네이버에 가고 싶은 것이지, 네이버에 대한 설명을 원하는 게 아님).

### 자동완성 자모 매칭 + prefix 하이라이트

![자동완성 하이라이트](/uploads/project/WikiEngine/search-rag/autocomplete-jamo-highlight.png)

### Grafana AI 요약 대시보드

![Grafana AI 요약 대시보드](/uploads/project/WikiEngine/search-rag/grafana-llm-panels.png)

- LLM 호출 수 (RPM): gemini-2.5-flash-lite 모델별 분당 요청 수
- LLM 응답시간 (ms): avg ~1.5초, max ~2초
- 토큰 사용량 (per min): input ~100 tokens/min, output ~20 tokens/min
- AI 요약 피드백: thumbs up 1건 기록

---

## 7. 배포 이슈 및 해결

운영 환경 배포 시 발견된 문제들. 모두 **로컬(ddl-auto: update)에서는 자동 처리되지만 운영(ddl-auto: validate + Flyway)에서는 수동 조치가 필요한** 차이에서 기인한다.

| # | 이슈 | 원인 | 해결 |
|---|------|------|------|
| 1 | ai_summary_feedback.rating 타입 불일치 | DB: TINYINT, Hibernate 기대: INTEGER | @Column(columnDefinition = "TINYINT") 명시 |
| 2 | GEMINI_API_KEY 환경변수 미전달 | Ansible env 템플릿 + docker-compose에 누락 | docker-compose environment + .env.prod에 추가 |
| 3 | posts.blinded 컬럼 미존재 | Flyway V4 마이그레이션 누락 | V4 마이그레이션 추가 (idempotent SQL) |
| 4 | Flyway V4 실패 기록 잔존 | 이전 시도에서 실패 -> flyway_schema_history에 success=0 기록 | 수동 DELETE + idempotent SQL로 재실행 |
| 5 | Replica DB 스키마 불일치 | [MySQL Replication](/blog/project/wikiengine/replication) 끊김 -> DDL 전파 안 됨 | banned_words, ai_summary_feedback 테이블 + blinded 컬럼 수동 추가 |
| 6 | Ansible 헬스체크 타임아웃 | 42GB Lucene 인덱스 로딩으로 부팅 3분+ | Docker restart policy로 자동 재시작 |

### 교훈

1. **운영 배포 전 Flyway 마이그레이션 체크리스트** 필요: 엔티티 변경 -> V 마이그레이션 작성 -> Replica 전파 확인
2. **docker-compose environment 블록에 새 환경변수 추가 누락** 방지: Ansible 템플릿 변경 시 서버1(environment)/서버2(env_file) 차이 인지
3. **MySQL Replication 상태 모니터링** 필요: 끊기면 Flyway DDL이 Replica에 전파 안 됨

---

## 8. snippetSource 개선 -- Wikipedia CirrusSearch 패턴

### 문제

검색 결과에서 일부 문서의 snippet이 빈 문자열로 표시되는 현상.

```
"삼성전자" -> snippet 없음 (빈 문자열)
"삼성전기 삼성SDI 삼성SDS 삼성코닝." -> snippet 정상 표시
```

### 원인 분석

snippetSource stored field에 **raw 위키 마크업**이 그대로 저장되어 있었다:

```
snippetSource = "[include(틀:회원수정)]\n[include(틀:삼성)]\n[include(틀:삼성전자)]..."
```

UnifiedHighlighter가 마크업 토큰에서 offset 불일치 -> 빈 snippet 반환.

### 현업 사례

| 시스템 | 접근법 |
|--------|--------|
| **Wikipedia CirrusSearch** | source_text(raw) + text(clean) 별도 필드. 검색/하이라이팅은 clean text 사용 |
| **Elasticsearch 공식** | Ingest Pipeline html_strip processor로 target_field에 clean text 저장 |
| **Solr** | HTMLStripFieldUpdateProcessorFactory로 인덱스 타임에 정제 |

**결론**: raw 마크업을 stored field에 저장하고 쿼리 타임에 정리하는 것은 **안티패턴**. 인덱스 타임에 clean text를 저장하는 것이 업계 표준.

### 해결

LuceneIndexService.toDocument() 변경:

```java
// Before: raw 위키 마크업 저장
String snippetSource = content.substring(0, 500);

// After: clean plain text 저장 (Wikipedia CirrusSearch 패턴)
String cleaned = PostSearchResponse.stripMarkup(content.substring(0, 1500));
String snippetSource = cleaned.substring(0, Math.min(cleaned.length(), 500));
```

마크업이 콘텐츠의 30~60%를 차지하므로, 원본 1500자에서 정리하여 500자 clean text 확보.

| 항목 | Before | After |
|------|--------|-------|
| snippetSource 내용 | raw 위키 마크업 | **clean plain text** |
| 유의미한 텍스트 밀도 | 40~70% (마크업 포함) | **100%** |
| Highlighter 매칭 성공률 | 낮음 (마크업 토큰 간섭) | **높음** |

---

## 이전 글 전체 목록

이 글은 검색 고도화 시리즈의 마지막 글입니다:

| 순서 | 글 | 핵심 |
|------|------|------|
| 1 | [카테고리 검색 필터링 + Facet 집계](/blog/project/wikiengine/search-category-facet) | Lucene FILTER 절, DB GROUP BY Facet |
| 2 | [쿼리 확장 + Query Understanding](/blog/project/wikiengine/search-query-enhancement) | 동의어, 오타 교정, UnifiedHighlighter, 재색인 인프라 |
| 3 | [콘텐츠 필터링 -- 운영 안전장치](/blog/project/wikiengine/search-content-filter) | Aho-Corasick 금칙어, 블라인드, Negative Caching |
| 4 | **AI 검색 요약 -- RAG** (이 글) | RAG 파이프라인, SSE, 비용 모니터링 |

---

## 출처

- [Anthropic RAG Guide](https://docs.anthropic.com/en/docs/build-with-claude/retrieval-augmented-generation)
- [BM25 vs Dense Retrievers -- A Complete Practical Guide](https://medium.com/@siddharth_58896/rag-techniques-bm25-vs-dense-retrievers-a-complete-practical-guide-b1302ee35b7b)
- [Eugene Yan -- Search: Query Matching](https://eugeneyan.com/writing/search-query-matching/)
- [Wikipedia CirrusSearch -- MediaWiki](https://www.mediawiki.org/wiki/Extension:CirrusSearch)
- [Elasticsearch Ingest Pipeline -- html_strip](https://www.elastic.co/docs/reference/elasticsearch/ingest-processors/html-strip-processor)
- [Spring AI Documentation](https://docs.spring.io/spring-ai/reference/)

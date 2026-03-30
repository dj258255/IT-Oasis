---
title: 'WikiEngine 총정리 — 1,215만 건 검색 엔진의 설계부터 RAG까지'
titleEn: 'WikiEngine Retrospective — From Design to RAG with 12.15M Documents'
description: 2개월간 26편의 기술 블로그로 기록한 WikiEngine 검색 엔진 프로젝트를 총정리합니다. MySQL LIKE 5,000ms 타임아웃에서 시작하여 임베디드 Lucene + Nori 한국어 형태소 분석으로 전환하고, Caffeine+Redis 2계층 캐시(82% 히트율), MySQL Replication R/W 분리, Nginx 스케일아웃(에러율 13.25%→0%), Debezium+Kafka CDC, Redis 3노드 Consistent Hashing까지 분산 아키텍처를 완성합니다. 검색 품질은 동의어 확장, 오타 교정, UnifiedHighlighter snippet, LTR(NDCG +4.8%p), 카테고리 28개 자동 분류, Aho-Corasick 금칙어 필터링으로 고도화하고, RAG(Gemini SSE 스트리밍)로 AI 검색 요약을 제공합니다. 자동완성 시스템 설계(CQRS + MapReduce + CDC)의 이론과 실제 구현의 매핑, 26편 전체 시리즈 링크, 핵심 수치 총정리를 포함합니다.
descriptionEn: A comprehensive retrospective of the WikiEngine search engine project documented across 26 technical blog posts over 2 months. From MySQL LIKE 5,000ms timeout to embedded Lucene + Nori, two-tier cache (82% hit), MySQL Replication, Nginx scale-out (error 13.25%→0%), Debezium+Kafka CDC, Redis 3-node Consistent Hashing. Search quality enhanced with synonyms, spell check, UnifiedHighlighter, LTR (NDCG +4.8%p), 28-category auto-classification, Aho-Corasick content filtering, and RAG with Gemini SSE streaming.
date: 2026-03-30T00:00:00.000Z
tags:
  - Lucene
  - Search Engine
  - MySQL
  - Redis
  - Kafka
  - Debezium
  - CDC
  - Nori
  - BM25
  - LTR
  - RAG
  - k6
  - Grafana
  - Architecture
  - Retrospective
  - Spring Boot
  - Wiki
category: project/WikiEngine
draft: false
---

## 프로젝트 개요

WikiEngine은 위키피디아 + 나무위키 데이터 **1,215만 건**을 대상으로 한 검색 엔진이다. OCI Free Tier ARM 2코어 서버 2대에서 운영되며, 2개월간 검색 인프라 구축 → 분산 아키텍처 전환 → 검색 품질 고도화 → AI 검색 요약까지 진행했다.

| 항목 | 수치 |
|------|------|
| 총 문서 수 | 12,156,589건 |
| Lucene 인덱스 | 42GB (5개 세그먼트) |
| 인프라 | OCI Free Tier ARM Ampere A1 x 2대 (각 2코어/12GB) |
| 기술 스택 | Spring Boot, Lucene 10.3.2, Nori, MySQL 8, Redis 3노드, Kafka+Debezium, Next.js |
| 블로그 시리즈 | 26편 (2026-01-27 ~ 2026-03-30) |

---

## 아키텍처 진화

### 1단계: 단일 서버 + MySQL 검색

```
사용자 → Spring Boot → MySQL LIKE '%keyword%'
```

- [검색 시스템 장애 방지](/blog/project/wikiengine/search-system-crash) — `LIKE '%keyword%'` Full Table Scan 27,443,742건 → 5,000ms 타임아웃
- [B-Tree 인덱스 자동완성](/blog/project/wikiengine/autocomplete-btree-index) — `LIKE 'prefix%'` 복합 인덱스 → 5,000ms → **8ms**
- [FULLTEXT ngram 인덱스](/blog/project/wikiengine/fulltext-ngram-index) — 본문 검색 12초 → 6ms (2,100배). 하지만 고빈도 토큰 "대한" 타임아웃

### 2단계: 임베디드 Lucene 전환

```
사용자 → Spring Boot → Lucene (BM25 + Nori)
                      → MySQL (CRUD)
```

- [MySQL을 버리고 Lucene을 선택한 이유](/blog/project/wikiengine/lucene-decision) — FULLTEXT 한계(300GB+ 인덱스, false positive) → 임베디드 Lucene + Nori. **추가 인프라 비용 $0**
- [검색 품질 평가](/blog/project/wikiengine/search-quality) — PhraseQuery(slop=2) + BM25 + FeatureField 랭킹. P@10 0.827 → **0.853**
- [Deferred Join 최적화](/blog/project/wikiengine/deferred-join-optimization) — OFFSET 14,750,000건 페이지네이션 2,518ms → Covering Index + Deferred Join
- [쿼리 리팩토링](/blog/project/wikiengine/query-refactoring-optimization) — COUNT(*) 2,038ms 제거, Page→Slice. **에러율 32.53% → 0%**

### 3단계: 캐시 + 자동완성

```
사용자 → Spring Boot → Caffeine(L1) → Lucene
                      → Trie 자동완성
```

- [캐싱 전략](/blog/project/wikiengine/caching-strategy) — Caffeine L1 캐시 99.9% 히트. 776ms → **54ms** (14.4배)
- [Trie 자동완성](/blog/project/wikiengine/trie-autocomplete) — 검색 로그 + Trie + 한국어 자모 분해. "삼ㅅ" → "삼성전자"

### 4단계: 분산 아키텍처

```
사용자 → Nginx(L7 LB) → App 1 → Caffeine(L1) → Redis(L2) → Lucene
                       → App 2      ↓
                                  MySQL Primary ←→ Replica
                                  Kafka + Debezium (CDC)
                                  Redis 3노드 (Consistent Hashing)
```

- [부하 테스트 튜닝](/blog/project/wikiengine/stress-test-tuning) — 단일 서버 한계 100-150 VU. CPU 100% 포화, Load Average 20+
- [Redis L2 캐시](/blog/project/wikiengine/redis-l2-cache) — L1 73% + L2 9% = **82% 히트율**. Trie → Redis flat KV O(1). Stateless 전환 완료
- [MySQL Replication](/blog/project/wikiengine/replication) — GTID 비동기, Primary 5 + Replica 15 커넥션풀. Lag 0~1초
- [App 스케일아웃](/blog/project/wikiengine/scaleout) — Nginx least_conn. **에러 13.25% → 0%, P95 2,300ms → 158ms**
- [조회수 Redis INCR](/blog/project/wikiengine/view-count-redis) — GET 요청 UPDATE 충돌 해결. Write-Behind 30초 배치 플러시
- [CDC — 이벤트 기반 동기화](/blog/project/wikiengine/cdc) — dual-write 제거. Spring Event → Debezium+Kafka CDC. **생성 5,315ms → 33ms (160배)**
- [Redis 샤딩](/blog/project/wikiengine/redis-sharding) — KEYS 블로킹 제거(SCAN), 3노드 Consistent Hashing, 워크로드 격리
- [분산 안정성 검증](/blog/project/wikiengine/distributed-stability) — 200 VU stress. **에러율 0.09%** (단일 13.25%), **처리량 109 req/s (3.6배)**

### 5단계: 검색 품질 고도화

- [카테고리 검색 필터링](/blog/project/wikiengine/search-category-facet) — Occur.FILTER bitset 캐싱, DB GROUP BY 간이 Facet
- [쿼리 확장 + Query Understanding](/blog/project/wikiengine/search-query-enhancement) — 동의어("AI"→"인공지능"), 오타 교정("프로그래링"→"프로그래밍"), UnifiedHighlighter snippet, **12,156,589건 무중단 재색인 (~2시간)**
- [LTR 재랭킹 + 카테고리 자동 분류](/blog/project/wikiengine/search-ltr-ranking) — XGBoost LambdaMART **NDCG +4.8%p**, 카테고리 28개(83%), Nori 사전 158K, Facet 네이티브 전환
- [콘텐츠 필터링](/blog/project/wikiengine/search-content-filter) — Aho-Corasick 16,090개 금칙어 O(N+Z), 블라인드 MUST_NOT, Negative Caching 30초
- [AI 검색 요약 — RAG](/blog/project/wikiengine/search-rag) — BM25 Top-5 → Gemini SSE 스트리밍, 출처 인용, Redis Lua rate limit, 쿼리 캐싱(LLM 비용 40~60% 절감)

---

## 자동완성 시스템 — 이론 설계 vs 실제 구현

대규모 자동완성 시스템 설계 이론을 WikiEngine에 어떻게 적용했는지 매핑한다.

### CQRS 패턴

| 이론 | WikiEngine 구현 |
|------|----------------|
| 읽기(자동완성)와 쓰기(업데이트)를 분리 | **Redis flat KV O(1) GET**(읽기) + **배치 빌드**(쓰기) 분리 |
| 240ms SLA | Redis GET P95 **2.5ms**, Lucene fallback P95 **68ms** |
| 최종 일관성(Eventual Consistency) | 배치 주기 1시간 → 최대 1시간 지연 허용 |

**관련 글**: [Redis L2 캐시 + 자동완성 flat KV](/blog/project/wikiengine/redis-l2-cache)

### MapReduce 배치 패턴

| 이론 | WikiEngine 구현 |
|------|----------------|
| Map: 검색어 → 접두사 분해 | SQL GROUP BY → prefix 분해 (원본 + 자모 + 초성) |
| Reduce: 접두사별 Top-K 집계 | PriorityQueue Top-10 → Redis 버전 네임스페이스 적재 |
| 파티셔닝(Shuffling) | Redis 키 해시 기반 3노드 분산 |
| 실행 주기 | `@Scheduled` → **Spring Batch Job+Tasklet** (이력 관리, 실패 복구) |

**관련 글**: [Redis L2 캐시](/blog/project/wikiengine/redis-l2-cache) (후속 개선 — Spring Batch 전환), [Redis 샤딩](/blog/project/wikiengine/redis-sharding)

### CDC (Change Data Capture)

| 이론 | WikiEngine 구현 |
|------|----------------|
| MapReduce 결과 → CDC → 자동완성 서비스 | MySQL binlog → **Debezium** → Kafka → Lucene+캐시 동기화 |
| 변경된 레코드의 이벤트만 발행 | Debezium CDC가 INSERT/UPDATE/DELETE 자동 캡처 |
| 메시지 브로커 | **Kafka** (KRaft 단일 브로커, fallback 내장) |
| DLQ + 에러 핸들링 | DefaultErrorHandler + FixedBackOff 9회 + DLT 격리 |

**관련 글**: [CDC — 이벤트 기반 동기화](/blog/project/wikiengine/cdc) (후속 개선 — DLQ 강화)

### Trie 배제 → Flat KV

| 이론 | WikiEngine 구현 |
|------|----------------|
| Trie는 수십억 건에서 메모리/성능 부적합 | [Trie 자동완성](/blog/project/wikiengine/trie-autocomplete)에서 소규모 Trie 구현 → 한계 확인 |
| 접두사 → Top-K 매핑의 flat 저장소 | **Redis flat KV** — `prefix:v{version}:{접두사}` → JSON 배열 |
| O(1) 조회 | Redis GET 단일 명령 |

**관련 글**: [Trie 자동완성](/blog/project/wikiengine/trie-autocomplete) (소규모 Trie 구현 + 한계), [Redis L2 캐시](/blog/project/wikiengine/redis-l2-cache) (Trie → Redis flat KV 전환)

### 샤딩 + 핫스팟 해결

| 이론 | WikiEngine 구현 |
|------|----------------|
| 해시 함수 기반 샤딩 | **Consistent Hashing** (MurmurHash3) |
| 핫스팟 방지 — 동적 복제 | 워크로드별 전용 인스턴스 격리 (자동완성/캐시/블랙리스트) |
| KEYS 블로킹 | **KEYS → SCAN** 전환 (34.6ms SLOWLOG 제거) |

**관련 글**: [Redis 샤딩 — Consistent Hashing](/blog/project/wikiengine/redis-sharding)

### 서비스 확장

| 이론 | WikiEngine 구현 |
|------|----------------|
| 로드 밸런서 + 인스턴스 그룹 | **Nginx L7** least_conn + App 2대 |
| 수평 확장 전제조건 | Stateless 전환 (Caffeine/Trie/TokenBlacklist → Redis 외부화) |
| Replication으로 읽기 분산 | **MySQL GTID Replication** + DataSource R/W 라우팅 |

**관련 글**: [App 스케일아웃](/blog/project/wikiengine/scaleout), [MySQL Replication](/blog/project/wikiengine/replication)

---

## 핵심 수치 총정리

### 검색 성능

| 지표 | 시작 | 최종 | 개선 |
|------|------|------|------|
| 본문 검색 | LIKE 5,000ms+ 타임아웃 | Lucene BM25 **29ms** (P95 100ms) | **170배+** |
| 자동완성 | LIKE 5,000ms+ | Redis GET **11ms** (P95 68ms) | **450배+** |
| 캐시 히트율 | 0% (캐시 없음) | L1 73% + L2 9% = **82%** | - |
| 에러율 | 32.53% | **0%** | 완전 해소 |
| P95 응답시간 (100 VU) | 2,300ms | **190ms** | **12배** |
| 처리량 | ~30 req/s | **109 req/s** | **3.6배** |

### 검색 품질

| 지표 | Before | After | 방법 |
|------|--------|-------|------|
| P@10 | 0.827 | **0.853** | PhraseQuery + BM25 FeatureField |
| NDCG@10 | 0.6910 | **0.7387** (+4.8%p) | XGBoost LambdaMART LTR |
| "AI" → "인공지능" | 미포함 | **1위** | 동의어 확장 |
| 오타 "프로그래링" | 결과 0건 | **"프로그래밍" 제안** | DirectSpellChecker |
| snippet | 앞 150자 (무관) | **검색어 주변 맥락** | UnifiedHighlighter |
| Facet | 없음 | **30개 카테고리 전체 집계** | SortedSetDocValuesFacetCounts |

### 인프라

| 항목 | 수치 |
|------|------|
| Lucene 인덱스 | 42GB (12,156,589건) |
| 재색인 | ~2시간 (무중단 Directory Swap) |
| Nori 사용자 사전 | 158,539개 |
| 금칙어 | 16,090개 (Aho-Corasick) |
| Redis 노드 | 3개 (Consistent Hashing) |
| MySQL Replication | Primary 5 + Replica 15 커넥션풀 |
| Kafka CDC | Debezium + KRaft 단일 브로커 |
| 카테고리 | 28개 주제별 (자동 분류 83%) |
| AI 요약 | Gemini 2.0 Flash (무료 티어) |

---

## 실패와 교훈

모든 것이 순탄하지는 않았다. 프로젝트에서 겪은 주요 실패와 그로부터 얻은 교훈.

### 1. LTR ON 시 72배 성능 악화

[LTR 재랭킹](/blog/project/wikiengine/search-ltr-ranking)에서 XGBoost LambdaMART로 NDCG +4.8%p를 달성했지만, k6 부하 테스트에서 **평균 42ms → 3,088ms (72배 악화)**. 2코어 ARM에서 문서당 14개 피처 추출이 CPU를 완전 포화시켰다. `LTR_ENABLED=false`로 비활성화. **교훈**: 기능 검증과 프로덕션 적용은 별개. 인프라 제약을 먼저 확인해야 한다.

### 2. LLM 학습 데이터 생성 98% 실패

[LTR 재랭킹](/blog/project/wikiengine/search-ltr-ranking)에서 Gemini API 15 RPM 제한을 초과하여 900건 중 18건만 성공 (2%). Spring AI가 HTTP 429를 재시도하지 않고, 메모리 전용 저장으로 실패를 인지 못했다. **교훈**: 외부 API rate limit을 정확히 계산하고, 데이터는 즉시 디스크에 저장해야 한다.

### 3. CDC 배포 후 검색 미반영

[CDC](/blog/project/wikiengine/cdc)에서 멀티 인스턴스 환경의 Consumer-IndexWriter 위치 불일치. App 2에서 CDC 이벤트를 수신했지만 IndexWriter가 null이라 인덱싱 skip. **교훈**: CDC 파이프라인은 end-to-end 검증이 필수.

### 4. Flyway 마이그레이션 Replica 미전파

[AI 검색 요약](/blog/project/wikiengine/search-rag)에서 MySQL Replication이 끊겨 DDL이 Replica에 전파되지 않음. `ddl-auto: validate`(운영)와 `update`(로컬)의 차이. **교훈**: 배포 전 Replication 상태 + Flyway 마이그레이션 체크리스트 필수.

### 5. snippetSource에 raw 마크업 저장

[AI 검색 요약](/blog/project/wikiengine/search-rag)에서 위키 마크업이 그대로 저장되어 UnifiedHighlighter가 빈 snippet 반환. Wikipedia CirrusSearch 패턴(clean text 별도 필드)으로 해결. **교훈**: raw 데이터를 stored field에 저장하는 것은 안티패턴. 인덱스 타임에 정제해야 한다.

---

## 기술 선택의 근거

### 왜 Elasticsearch가 아니라 임베디드 Lucene인가

| 관점 | Lucene (선택) | Elasticsearch |
|------|-------------|--------------|
| 인프라 비용 | **$0** (앱 내장) | 최소 6G RAM (3노드) |
| 검색 성능 | **네트워크 홉 없음** (7~10배 빠름) | REST API 오버헤드 |
| 운영 | 앱과 함께 배포 | 별도 클러스터 관리 |
| Free Tier | **가능** | **불가능** |

### 왜 Kafka를 쓰는가 (볼륨 작은데 오버엔지니어링 아닌가)

ROI 비교: Kafka 주간 운영 30분~1시간 vs dual-write 불일치 발생 시 디버깅+재인덱싱 수 시간. fallback 구조(`@ApplicationModuleListener`)로 Kafka 장애 시에도 서비스 연속성 확보. [상세 분석](/blog/project/wikiengine/cdc)

### 왜 BM25가 Dense Retrieval보다 적합한가

위키피디아 기술 용어 키워드 검색이 주 패턴. 키워드 전용 쿼리에서 BM25 NDCG 0.88 > Dense 0.65. "AI"→"인공지능" 수준은 동의어 확장으로 해결 완료. 벡터 검색은 의미 검색 필요 케이스가 실측 확인되면 Lucene HNSW + RRF로 전환. [상세 분석](/blog/project/wikiengine/search-rag)

---

## 시리즈 전체 목록

### 검색 인프라 구축

| # | 글 | 핵심 수치 |
|---|------|---------|
| 1 | [WikiEngine 프로젝트 개요](/blog/project/wikiengine/wiki-search-overview) | 12,156,589건, 아키텍처 설계 |
| 2 | [검색 시스템 장애 방지](/blog/project/wikiengine/search-system-crash) | LIKE 27M건 Full Scan → 타임아웃 방어 |
| 3 | [B-Tree 인덱스 자동완성](/blog/project/wikiengine/autocomplete-btree-index) | 5,000ms → 8ms (99.8%+) |
| 4 | [FULLTEXT ngram 인덱스](/blog/project/wikiengine/fulltext-ngram-index) | 12초 → 6ms (2,100배) |
| 5 | [MySQL → Lucene 전환](/blog/project/wikiengine/lucene-decision) | FULLTEXT 한계 → 임베디드 Lucene |
| 6 | [Deferred Join 최적화](/blog/project/wikiengine/deferred-join-optimization) | OFFSET 14.75M건 페이지네이션 |
| 7 | [쿼리 리팩토링](/blog/project/wikiengine/query-refactoring-optimization) | 에러율 32.53% → 0% |
| 8 | [검색 품질 평가](/blog/project/wikiengine/search-quality) | P@10 0.827 → 0.853 |
| 9 | [캐싱 전략](/blog/project/wikiengine/caching-strategy) | 776ms → 54ms (14.4배) |
| 10 | [Trie 자동완성](/blog/project/wikiengine/trie-autocomplete) | 자모 분해 + 검색 로그 기반 |

### 분산 아키텍처

| # | 글 | 핵심 수치 |
|---|------|---------|
| 11 | [부하 테스트 튜닝](/blog/project/wikiengine/stress-test-tuning) | 단일 서버 한계 100-150 VU |
| 12 | [Redis L2 캐시](/blog/project/wikiengine/redis-l2-cache) | L1+L2 82% 히트율, Stateless 전환 |
| 13 | [MySQL Replication](/blog/project/wikiengine/replication) | GTID 비동기, R/W 분리 |
| 14 | [App 스케일아웃](/blog/project/wikiengine/scaleout) | 에러 13.25% → 0%, P95 12배 개선 |
| 15 | [조회수 Redis INCR](/blog/project/wikiengine/view-count-redis) | Write-Behind 배치 플러시 |
| 16 | [CDC — 이벤트 기반 동기화](/blog/project/wikiengine/cdc) | dual-write 제거, 생성 160배 개선 |
| 17 | [Redis 샤딩](/blog/project/wikiengine/redis-sharding) | 3노드 Consistent Hashing |
| 18 | [분산 안정성 검증](/blog/project/wikiengine/distributed-stability) | 200 VU 에러 0.09%, 처리량 3.6배 |

### 검색 품질 고도화

| # | 글 | 핵심 수치 |
|---|------|---------|
| 19 | [카테고리 검색 필터링](/blog/project/wikiengine/search-category-facet) | Occur.FILTER + DB GROUP BY Facet |
| 20 | [쿼리 확장 + Query Understanding](/blog/project/wikiengine/search-query-enhancement) | 동의어, 오타 교정, UnifiedHighlighter |
| 21 | [LTR 재랭킹 + 카테고리 분류](/blog/project/wikiengine/search-ltr-ranking) | NDCG +4.8%p, 카테고리 83% |
| 22 | [콘텐츠 필터링](/blog/project/wikiengine/search-content-filter) | Aho-Corasick 16,090개 금칙어 |
| 23 | [AI 검색 요약 — RAG](/blog/project/wikiengine/search-rag) | Gemini SSE, 비용 모니터링 |

### 참고 자료

| # | 글 | 내용 |
|---|------|------|
| 24 | [포트폴리오 가이드](/blog/project/wikiengine/portfolio-resume-guide) | 이력서 작성 프레임워크 |
| 25 | [면접 예상 질문](/blog/project/wikiengine/interview-qa) | 프로젝트 전체 면접 Q&A |
| 26 | **WikiEngine 총정리** (이 글) | 설계부터 RAG까지 전체 회고 |

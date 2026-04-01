---
title: 'WikiEngine 총정리 — 1,215만 건 검색 엔진의 설계부터 RAG까지'
titleEn: 'WikiEngine Retrospective — From Design to RAG with 12.15M Documents'
description: 나무위키+한국어 위키백과+영어 위키백과+뉴스+웹텍스트+C4 한국어 코퍼스 1,215만 건 검색 엔진 프로젝트를 2개월간 26편의 기술 블로그로 기록하고 총정리합니다. MySQL LIKE 5,000ms 타임아웃에서 시작하여 임베디드 Lucene + Nori 한국어 형태소 분석으로 전환하고, Caffeine+Redis 2계층 캐시(82% 히트율), MySQL Replication R/W 분리, Nginx 스케일아웃(에러율 13.25%→0%), Debezium+Kafka CDC, Redis 3노드 Consistent Hashing까지 분산 아키텍처를 완성합니다. 검색 품질은 동의어 확장, 오타 교정, UnifiedHighlighter snippet, LTR(NDCG +4.8%p), 카테고리 28개 자동 분류, Aho-Corasick 금칙어 필터링으로 고도화하고, RAG(Gemini SSE 스트리밍)로 AI 검색 요약을 제공합니다. 자동완성 시스템 설계(CQRS + MapReduce + CDC)의 이론과 실제 구현의 매핑, 26편 전체 시리즈 링크, 핵심 수치 총정리를 포함합니다.
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
coverImage: /uploads/project/WikiEngine/wiki-engine-retrospective/wikiengine-architecture.svg
draft: false
---

## 프로젝트 개요

WikiEngine은 나무위키, 한국어/영어 위키백과, 뉴스, 웹텍스트 등 6개 소스에서 수집한 **1,215만 건**의 데이터를 대상으로 한 검색 엔진입니다. OCI Free Tier ARM 2코어 서버 2대에서 운영되며, 2개월간 검색 인프라 구축부터 분산 아키텍처 전환, 검색 품질 고도화, AI 검색 요약까지 진행했습니다.

### 데이터 소스

| 소스 | 포맷 | 문서 수 | 설명 |
|------|------|---------|------|
| 나무위키 (2021.03) | JSON | 571,364건 | 나무마크 본문, 한국어 커뮤니티 문서 |
| 한국어 위키백과 (2026.03) | XML | 739,791건 | MediaWiki XML 덤프 (ns=0 일반 문서만) |
| 영어 위키백과 (2026.02) | XML | 7,139,510건 | MediaWiki XML 덤프 (ns=0 일반 문서만) |
| 한국어 뉴스 | JSON | 159,639건 | 뉴스 기사 텍스트 |
| 한국어 웹텍스트 | JSON | 1,284,822건 | 웹 크롤링 텍스트 |
| C4 한국어 클린 | JSON | 2,261,463건 | 한국어 웹 코퍼스 |
| **합계** | | **12,156,589건** | **30개 카테고리, 고유 태그 ~216만 개** |

위키 문서를 그대로 사용하지 않고 실제 커뮤니티 게시판처럼 변환하여 적재했습니다. 위키 `[[분류:XXX]]`는 태그+카테고리로 변환하고, 뉴스/웹 콘텐츠는 소스별 고정 카테고리를 부여했으며, author_id는 10만 명의 더미 유저에게 균등 배정, created_at은 2020~2025 범위 내 랜덤 생성했습니다.

### 프로젝트 규모

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

프로젝트 초기에는 MySQL `LIKE '%keyword%'`로 본문 검색을 처리했습니다. 하지만 27,443,742건에 대한 Full Table Scan이 발생하면서 5,000ms 이상 타임아웃이 빈번했습니다.

- [검색 시스템 장애 방지](/blog/project/wikiengine/search-system-crash)에서 `LIKE` 쿼리의 Full Table Scan 문제를 발견하고, 5초 타임아웃 + fail-fast 3초로 장애 전파를 방지했습니다.
- [B-Tree 인덱스 자동완성](/blog/project/wikiengine/autocomplete-btree-index)에서 `LIKE 'prefix%'`에 복합 인덱스를 적용하여 5,000ms → **8ms**로 개선했습니다. 27,443,742건을 1건만 스캔하는 구조로 변경한 것입니다.
- [FULLTEXT ngram 인덱스](/blog/project/wikiengine/fulltext-ngram-index)에서 본문 검색을 12초 → 6ms (2,100배)로 개선했지만, 고빈도 토큰 "대한"에서 타임아웃이 발생하는 한계를 확인했습니다.

### 2단계: 임베디드 Lucene 전환

![2단계 아키텍처 — 임베디드 Lucene + MySQL CRUD](/uploads/project/WikiEngine/wiki-engine-retrospective/architecture-phase2.svg)

MySQL FULLTEXT의 근본적 한계(300GB+ 인덱스 추정, false positive, 한국어 지원 미흡)를 확인한 후, 임베디드 Lucene으로 전환했습니다. Elasticsearch는 별도 3노드 클러스터에 최소 6GB RAM이 추가로 필요하지만, 임베디드 Lucene은 앱 JVM 내에서 동작하여 **별도 프로세스 없이 기존 서버 메모리로 운영**할 수 있다는 점이 결정적이었습니다.

- [MySQL을 버리고 Lucene을 선택한 이유](/blog/project/wikiengine/lucene-decision)에서 FULLTEXT의 한계를 분석하고, Nori 한국어 형태소 분석기를 적용한 임베디드 Lucene으로 전환했습니다.
- [검색 품질 평가](/blog/project/wikiengine/search-quality)에서 PhraseQuery(slop=2) + BM25 + FeatureField(viewCount, likeCount) + Recency Decay 랭킹을 구현했습니다. 15개 테스트 쿼리로 측정한 P@10이 0.827 → **0.853** (+3.2%)로 개선되었습니다.
- [Deferred Join 최적화](/blog/project/wikiengine/deferred-join-optimization)에서 OFFSET 14,750,000건 페이지네이션이 Lucene 검색보다 38배 느린 문제(2,518ms vs 66ms)를 Covering Index + Deferred Join으로 해결했습니다.
- [쿼리 리팩토링](/blog/project/wikiengine/query-refactoring-optimization)에서 14,250,000건에 대한 COUNT(*) 2,038ms를 제거하고 Page→Slice로 전환했습니다. **에러율이 32.53% → 0%**로 해소되었습니다.

### 3단계: 캐시 + 자동완성

```
사용자 → Spring Boot → Caffeine(L1) → Lucene
                      → Trie 자동완성 (검색 로그 기반)
```

Lucene 검색 자체는 빠르지만, 반복 쿼리에 대해 매번 인덱스를 탐색하는 것은 CPU 낭비입니다. 캐시 레이어를 추가하여 반복 요청의 응답 속도를 극적으로 개선했습니다.

- [캐싱 전략](/blog/project/wikiengine/caching-strategy)에서 Caffeine L1 캐시를 적용하여 776ms → **54ms** (14.4배)로 개선했습니다. 히트율 99.9%를 달성했습니다.
- [Trie 자동완성](/blog/project/wikiengine/trie-autocomplete)에서 검색 로그 기반 인기 검색어를 Trie 자료구조에 적재하고, 한국어 자모 분해(초성/중성/종성)를 적용하여 "삼ㅅ" 입력 시 "삼성전자"가 제안되도록 구현했습니다.

### 4단계: 분산 아키텍처

![4단계 아키텍처 — 분산 시스템](/uploads/project/WikiEngine/wiki-engine-retrospective/architecture-phase4.svg)

단일 서버의 한계(100-150 VU에서 CPU 100% 포화)를 k6 부하 테스트로 확인한 후, 6개 컴포넌트를 도입하여 분산 아키텍처로 전환했습니다.

- [부하 테스트 튜닝](/blog/project/wikiengine/stress-test-tuning)에서 200 VU stress 테스트를 수행했습니다. CPU 100% 포화, Load Average 20+, P95 1,413ms로 단일 서버의 한계가 100-150 VU임을 확인했습니다. JVM 튜닝(G1GC, HikariCP)은 근본적 해결이 되지 않았습니다.
- [Redis L2 캐시](/blog/project/wikiengine/redis-l2-cache)에서 Caffeine(L1) + Redis(L2) 2계층 캐시를 구축했습니다. **L1 73% + L2 9% = 82% 히트율**을 달성하여 Origin 도달률을 19%로 낮췄습니다. Trie를 Redis flat KV O(1)로 전환하고, TokenBlacklist를 Redis로 외부화하여 Stateless 전환을 완료했습니다. 이후 `@Scheduled` 배치를 **Spring Batch Job+Tasklet**으로 전환하여 실행 이력 관리와 실패 복구를 확보했습니다.
- [MySQL Replication](/blog/project/wikiengine/replication)에서 GTID 비동기 Replication을 구성하고, `AbstractRoutingDataSource` + `LazyConnectionDataSourceProxy`로 R/W 자동 라우팅을 구현했습니다. Primary 5 + Replica 15 커넥션풀로 분리했습니다.
- [App 스케일아웃](/blog/project/wikiengine/scaleout)에서 Nginx L7 least_conn 로드 밸런싱 + App 2대로 확장했습니다. **에러율 13.25% → 0%, P95 2,300ms → 158ms, 평균 482ms → 37ms**로 개선되었습니다.
- [조회수 Redis INCR](/blog/project/wikiengine/view-count-redis)에서 GET 요청 내 UPDATE가 R/W 분리와 충돌하는 문제를 Redis INCR + Write-Behind 30초 배치 플러시로 해결했습니다. 에러율 11.10% → 0%로 해소되었습니다.
- [CDC — 이벤트 기반 동기화](/blog/project/wikiengine/cdc)에서 PostService의 dual-write(MySQL + Lucene 동시 업데이트)를 제거했습니다. Spring Event → `@ApplicationModuleListener` → Debezium+Kafka CDC 3단계로 진화시켜, MySQL binlog 기반으로 모든 변경 경로를 자동 캡처하는 구조를 만들었습니다. **게시글 생성 5,315ms → 33ms (160배 개선)**. 이후 **DLQ(Dead Letter Topic) + 예외 throw + AckMode.RECORD**로 에러 핸들링을 강화했습니다.
- [Redis 샤딩](/blog/project/wikiengine/redis-sharding)에서 KEYS 블로킹(34.6ms SLOWLOG)을 SCAN으로 전환하고, 3노드 Consistent Hashing으로 자동완성/캐시/블랙리스트 워크로드를 격리했습니다.
- [분산 안정성 검증](/blog/project/wikiengine/distributed-stability)에서 200 VU stress 테스트를 수행했습니다. **에러율 0.09%** (단일 서버 13.25%에서), **처리량 109 req/s (3.6배)**. MySQL, Redis, Kafka, Nginx 모두 여유가 있었고 App CPU만이 여전히 근본 병목임을 소거법으로 확인했습니다.

### 5단계: 검색 품질 고도화 + AI

분산 인프라가 안정화된 후, 검색 기능 자체의 품질을 고도화했습니다.

- [카테고리 검색 필터링](/blog/project/wikiengine/search-category-facet)에서 Lucene `Occur.FILTER` 절로 카테고리 필터링을 구현했습니다. `FILTER`는 `MUST`와 달리 스코어에 기여하지 않으면서 bitset 캐싱 대상이 되어 반복 검색 시 성능 이점이 있습니다. DB GROUP BY 간이 Facet으로 카테고리 분포를 먼저 제공했습니다.
- [쿼리 확장 + Query Understanding](/blog/project/wikiengine/search-query-enhancement)에서 세 가지 검색 품질 한계를 동시에 해결했습니다. DB 기반 동의어 확장으로 "AI" 검색 시 "인공지능" 문서가 **1위**에 노출되도록 Recall을 개선했고, DirectSpellChecker로 "프로그래링" → "프로그래밍" 오타 교정을 구현했으며, UnifiedHighlighter + snippetSource 500자 StoredField로 검색어 주변 맥락을 snippet에 정확히 표시했습니다. **12,156,589건 무중단 재색인 인프라**(Directory Swap + SearcherManager 재생성)도 이 글에서 구축했습니다.
- [LTR 재랭킹 + 카테고리 자동 분류](/blog/project/wikiengine/search-ltr-ranking)에서 BM25 수동 가중치의 한계를 ML 모델로 극복했습니다. 카테고리 28개 자동 분류(키워드 기반, 정확도 83%), Lucene 네이티브 Facet(`SortedSetDocValuesFacetCounts`) 전환, 태그 216만 건 인덱싱을 1회 재색인으로 통합 반영했습니다. LLM-as-a-Judge(Gemini)로 학습 데이터를 생성하고 XGBoost LambdaMART 14개 피처로 학습하여 **NDCG@10이 0.6910 → 0.7387 (+4.8%p)** 개선되었습니다. 다만 2코어 ARM에서 LTR ON 시 CPU 포화(72배 악화)가 발생하여 `LTR_ENABLED=false`로 비활성화했습니다.
- [콘텐츠 필터링](/blog/project/wikiengine/search-content-filter)에서 운영 안전장치를 구축했습니다. Aho-Corasick 알고리즘(O(N+Z))으로 16,090개 금칙어를 탐지하여 자동완성에서 유해 검색어를 필터링하고, 블라인드 게시글을 `Occur.MUST_NOT`으로 검색에서 제외합니다. 빈 결과에 대한 Negative Caching(30초 TTL)으로 cache penetration도 방지했습니다.
- [AI 검색 요약 — RAG](/blog/project/wikiengine/search-rag)에서 BM25 Top-5 문서를 LLM 컨텍스트에 주입하는 RAG 파이프라인을 구축했습니다. Spring AI + Gemini 2.0 Flash로 SSE 스트리밍 답변을 생성하고, 인라인 출처 배지를 파싱하여 게시글 링크로 연결합니다. Redis Lua 스크립트 atomic rate limiting(10 RPM 전역), 동일 쿼리 캐싱(TTL 30분, LLM 비용 40~60% 절감), Grafana 7패널 대시보드(RPM, 응답시간, 토큰, 피드백, 비용 추정)까지 포함합니다.

---

## 자동완성 시스템 — 이론 설계 vs 실제 구현

대규모 자동완성 시스템의 설계 이론을 WikiEngine에 어떻게 적용했는지 매핑합니다.

### CQRS 패턴 — 읽기와 쓰기의 분리

이론에서는 자동완성 조회와 검색어 집계가 같은 기능처럼 보여도 실제 요구사항은 다르다고 봅니다. 자동완성은 매우 빠른 응답이 중요하지만, 검색어 집계는 약간의 지연을 허용하더라도 안정적인 누적이 더 중요하기 때문입니다.

| 이론 | WikiEngine 구현 |
|------|----------------|
| 읽기 경로: 접두사 → Top-K 매핑을 빠르게 조회 | 접두사별 추천 결과를 미리 저장해 즉시 조회 |
| 쓰기 경로: 검색어를 수집하여 배치 처리 | 검색어를 누적한 뒤 주기적으로 다시 집계 |
| 240ms SLA | Redis GET P95 **2.5ms**, Lucene fallback P95 **68ms** |
| 최종 일관성(Eventual Consistency) | 배치 주기 1시간 → 최대 1시간 지연 허용 |

즉, 빠르게 보여주는 경로와 천천히 누적해도 되는 경로를 분리함으로써, 조회는 단순하고 예측 가능하게 만들고 집계는 안정적으로 유지하는 방향을 택했습니다.

**관련 글**: [Redis L2 캐시 + 자동완성 flat KV](/blog/project/wikiengine/redis-l2-cache)

### MapReduce 배치 패턴 — 접두사 분해와 Top-K 집계

이론에서는 검색어를 가능한 모든 접두사로 분해한 뒤, 접두사별로 상위 추천 결과를 다시 집계하는 흐름을 권장합니다.

| 이론 | WikiEngine 구현 |
|------|----------------|
| **Map**: 검색어 → 모든 접두사 분해 | 원본/자모/초성 기준으로 접두사 후보 생성 |
| **Reduce**: 접두사별 Top-K 정렬 | 각 접두사마다 상위 10개 추천 결과 유지 |
| **Write**: 결과를 키/값 저장소에 적재 | 새 버전을 먼저 적재한 뒤 포인터만 전환 |
| **파티셔닝**: 해시 함수로 키 분산 | Redis 키 해시 기반 3노드 분산 (Consistent Hashing) |
| **실행 주기**: 30분~1시간 | `@Scheduled` → **Spring Batch Job+Tasklet** (이력 관리, 실패 복구) |

WikiEngine에서는 "bat" → ["b", "ba", "bat"]처럼, "삼성전자"도 "ㅅ", "사", "삼", "삼ㅅ", "삼성" 식으로 잘게 나눠 각 접두사 후보에 반영했습니다. 핵심은 실시간 계산 대신 미리 계산된 결과를 만들어두고 조회 시에는 바로 반환하도록 한 것입니다. 초기에는 단순한 스케줄 작업으로 시작했지만, 이후에는 실행 이력과 실패 복구를 다룰 수 있는 형태로 발전시켜 운영 부담을 줄였습니다.

**관련 글**: [Redis L2 캐시](/blog/project/wikiengine/redis-l2-cache) (후속 개선 — Spring Batch 전환), [Redis 샤딩](/blog/project/wikiengine/redis-sharding)

### Trie 배제 → Flat KV — 규모에 맞는 자료구조 선택

이론에서는 단순한 접두사 탐색 구조가 수십억 건 규모에서 메모리와 탐색 비용 측면에서 한계를 가질 수 있다고 봅니다. 특히 1~2글자 접두사처럼 후보가 폭발하는 구간에서는, 탐색 이후 다시 정렬하는 비용까지 감안해야 합니다.

WikiEngine에서는 **실제로 Trie를 먼저 구현한 뒤 한계를 체감**하고 전환했습니다:

| 이론 | WikiEngine 구현 |
|------|----------------|
| 접두사 탐색 구조 | [Trie 자동완성](/blog/project/wikiengine/trie-autocomplete)에서 인기순 추천과 한글 자모 입력 문제를 먼저 해결 |
| 접두사 → Top-K 매핑의 flat 저장소 | 접두사별 상위 추천 결과를 미리 만들어 저장 |
| O(1) 조회 | 탐색과 정렬을 조회 시점이 아니라 집계 시점으로 이동 |

WikiEngine에서는 실제로 Trie를 먼저 구현해 검색 품질 문제를 해결한 뒤, 더 큰 규모와 다중 인스턴스 환경을 고려해 접두사별 추천 결과를 미리 대응시켜 두는 구조로 전환했습니다. 이렇게 바꾸면서 탐색 비용을 줄였을 뿐 아니라, 어떤 인스턴스가 응답하더라도 동일한 추천 결과를 보여줄 수 있게 됐습니다.

**관련 글**: [Trie 자동완성](/blog/project/wikiengine/trie-autocomplete) (소규모 Trie 구현 + 한계), [Redis L2 캐시](/blog/project/wikiengine/redis-l2-cache) (Trie → Redis flat KV 전환)

### CDC (Change Data Capture) — 변경 이벤트 기반 동기화

이론에서는 집계 결과를 서비스에 반영할 때, 전체를 다시 밀어넣기보다 실제로 변경된 부분만 뒤에서 전파하는 방식이 더 효율적이라고 봅니다.

WikiEngine에서는 MySQL binlog를 감시하는 Debezium + Kafka CDC로 구현했습니다. 단순히 자동완성 동기화뿐 아니라, **Lucene 인덱스 + L1/L2 캐시 무효화까지 하나의 파이프라인**으로 처리합니다.

| 이론 | WikiEngine 구현 |
|------|----------------|
| 결과 DB → 변경 전파 → 서비스 | 저장소 변경이 검색 인덱스와 캐시에 자동 반영 |
| 변경된 레코드의 이벤트만 발행 | 전체 재반영 대신 실제 변경분만 전달 |
| 메시지 브로커 | 변경 이력을 안전하게 보관하고 재처리 가능하도록 구성 |
| 에러 핸들링 | 실패한 메시지를 분리하고 재시도할 수 있도록 설계 |

기존에는 데이터 저장과 검색 반영을 하나의 요청 안에서 직접 처리했지만, 이후에는 저장만 끝나면 나머지 반영은 뒤에서 자동으로 이어지는 구조로 바꿨습니다. 그 결과 요청 경로는 가벼워지고, 변경 전파는 더 일관되게 관리할 수 있게 됐습니다.

**관련 글**: [CDC — 이벤트 기반 동기화](/blog/project/wikiengine/cdc) (후속 개선 — DLQ 강화)

### 샤딩 + 핫스팟 해결 — 워크로드 격리

이론에서는 해시 함수 기반 샤딩만으로는 핫스팟 문제를 해결할 수 없다고 합니다. 인기 있는 접두사가 있는 샤드에 트래픽이 집중되기 때문입니다. Shard Manager를 두어 동적으로 복제본을 추가/제거하는 것을 권장합니다.

WikiEngine에서는 동적 복제 대신 **워크로드별 전용 인스턴스 격리**로 해결했습니다:

| 이론 | WikiEngine 구현 |
|------|----------------|
| 해시 함수 기반 샤딩 | **Consistent Hashing** (MurmurHash3) |
| 핫스팟 방지 — Shard Manager | 워크로드별 전용 인스턴스 격리 (자동완성/캐시/블랙리스트) |
| KEYS 블로킹 방지 | **KEYS → SCAN** 전환 (34.6ms SLOWLOG 제거) |
| 동적 복제 관리 | Free Tier 제약으로 3노드 고정. 확장 시 Redis Sentinel/Cluster 전환 |

자동완성 배치(`buildPrefixTopK`)가 매시간 수만 개 키를 동시에 SET하면서 실시간 GET/INCR과 같은 싱글스레드에서 경합하는 문제가 있었습니다. 워크로드를 물리적으로 다른 Redis 인스턴스로 분리하여 간섭을 제거했습니다.

**관련 글**: [Redis 샤딩 — Consistent Hashing](/blog/project/wikiengine/redis-sharding)

### 서비스 계층 확장 — 로드 밸런서 + 인스턴스 그룹

이론에서는 로드 밸런서 뒤에 인스턴스 그룹을 배치하여 수평 확장하라고 합니다.

WikiEngine에서는 Stateless 전환(Caffeine/Trie/TokenBlacklist → Redis 외부화)을 선행한 후 스케일아웃을 진행했습니다. Stateless가 되지 않으면 인스턴스 간 상태 불일치가 발생하기 때문입니다.

| 이론 | WikiEngine 구현 |
|------|----------------|
| 로드 밸런서 + 인스턴스 그룹 | **Nginx L7** least_conn + App 2대 |
| 수평 확장 전제조건 | Stateless 전환 완료 (Redis 외부화) |
| Replication으로 읽기 분산 | **MySQL GTID Replication** + DataSource R/W 라우팅 |
| 스케일아웃 결과 | 에러율 13.25% → **0%**, P95 2,300ms → **158ms** |

**관련 글**: [App 스케일아웃](/blog/project/wikiengine/scaleout), [MySQL Replication](/blog/project/wikiengine/replication)

---

## 핵심 수치 총정리

### 검색 성능 추이

| 지표 | 시작 | 최종 | 비고 |
|------|------|------|------|
| 본문 검색 | LIKE 타임아웃 (5,000ms+) | Lucene BM25 **29ms** (P95 100ms) | 타임아웃 → 안정 응답 |
| 자동완성 | LIKE 타임아웃 (5,000ms+) | Redis GET **11ms** (P95 68ms) | Trie DFS 5ms → Redis O(1) |
| 캐시 히트율 | 0% (캐시 없음) | L1 73% + L2 9% = **82%** | Origin 도달률 19% |
| 에러율 (쿼리) | 32.53% (COUNT* 타임아웃) | **0%** | Page→Slice 전환 |
| 에러율 (부하) | 13.25% (단일 서버 100VU) | **0%** (분산 100VU) | 스케일아웃 효과 |
| P95 응답시간 (100 VU) | 2,300ms (단일) | **190ms** (분산) | **12배 개선** |
| 처리량 | ~30 req/s (단일) | **109 req/s** (분산) | **3.6배** |
| 검색 최종 (Facet+태그 포함) | - | **548ms** (P95 2.61s) | LTR OFF, 인덱스 42GB |

### 검색 품질 추이

| 지표 | Before | After | 방법 |
|------|--------|-------|------|
| P@10 | 0.827 | **0.853** | PhraseQuery + BM25 FeatureField |
| NDCG@10 | 0.6910 | **0.7387** (+4.8%p) | XGBoost LambdaMART LTR |
| "AI" → "인공지능" | 미포함 | **1위** | 동의어 확장 (DB 기반 쿼리 타임) |
| 오타 "프로그래링" | 결과 0건 | **"프로그래밍" 제안** | DirectSpellChecker |
| snippet | 앞 150자 (무관) | **검색어 주변 맥락** | UnifiedHighlighter + snippetSource |
| Facet | 없음 | **30개 카테고리 전체 집계** | SortedSetDocValuesFacetCounts |
| AI 요약 | 없음 (문서 목록만) | **RAG 기반 답변 + 출처** | BM25 Top-5 → Gemini SSE |

### 인프라 규모

| 항목 | 수치 |
|------|------|
| Lucene 인덱스 | 42GB (12,156,589건, 5세그먼트) |
| 무중단 재색인 | ~2시간 (Directory Swap + SearcherManager) |
| Nori 사용자 사전 | 158,539개 (open-korean-text) |
| 금칙어 | 16,090개 (한국어 3,094 + 영어 12,996) |
| Redis 노드 | 3개 (Consistent Hashing, 워크로드 격리) |
| MySQL Replication | Primary 5 + Replica 15 커넥션풀 |
| Kafka CDC | Debezium + KRaft 단일 브로커 + DLQ |
| 카테고리 | 28개 주제별 자동 분류 (정확도 83%) |
| AI 요약 | Gemini 2.0 Flash (무료 티어 15 RPM) |

---

## 실패와 교훈

모든 것이 순탄하지는 않았습니다. 프로젝트에서 겪은 주요 실패와 그로부터 얻은 교훈을 정리합니다.

### 1. LTR ON 시 72배 성능 악화

[LTR 재랭킹](/blog/project/wikiengine/search-ltr-ranking)에서 NDCG +4.8%p를 달성했지만, k6 부하 테스트에서 **평균 42ms → 3,088ms (72배 악화)**가 발생했습니다. Rescore window 200에서 문서당 14개 피처 추출(BM25 3필드 x 200문서 = 600회 Scorer 생성 + Nori 토큰화 600회+)이 2코어 ARM에서 CPU를 완전 포화시켰습니다. LTR 무관 API(자동완성)까지 동반 악화되는 queueing avalanche가 발생했습니다.

**교훈**: 기능 검증과 프로덕션 적용은 별개입니다. 현업에서는 피처 사전 계산(인덱스 타임), 피처 캐싱, 전용 다코어 서버에서 LTR을 처리합니다.

### 2. LLM 학습 데이터 생성 98% 실패

[LTR 재랭킹](/blog/project/wikiengine/search-ltr-ranking)에서 Gemini API의 15 RPM 제한을 초과하여 900건 중 18건만 성공했습니다(2% 성공률). 라운드 간 딜레이 2초로 분당 30요청이 되었고, Spring AI가 HTTP 429를 `NonTransientAiException`으로 분류하여 재시도하지 않았습니다. 메모리 전용 저장(`ArrayList`)이라 실패를 인지하지 못했습니다.

**교훈**: 외부 API rate limit을 정확히 계산하고, 데이터는 즉시 디스크에 저장(CSV append)해야 합니다. status API에 성공/실패 구분이 필수입니다.

### 3. CDC 배포 후 검색 미반영

[CDC](/blog/project/wikiengine/cdc)에서 멀티 인스턴스 환경의 Consumer-IndexWriter 위치 불일치가 발생했습니다. App 2에서 CDC 이벤트를 수신했지만 Lucene IndexWriter가 null이라 인덱싱이 skip되었습니다. App 1은 docker-compose에서 환경변수 매핑이 빠져 Kafka 연결 자체가 실패했습니다.

**교훈**: 임베디드 검색 인덱스는 분산 환경에서 Consumer-Writer 위치 보장이 어렵습니다. CDC 파이프라인은 end-to-end 검증 테스트가 필수입니다.

### 4. Flyway 마이그레이션 Replica 미전파

[AI 검색 요약](/blog/project/wikiengine/search-rag)에서 MySQL Replication이 끊겨 DDL이 Replica에 전파되지 않았습니다. `ddl-auto: validate`(운영)와 `update`(로컬)의 차이로 로컬에서는 자동 처리되던 스키마 변경이 운영에서 실패했습니다.

**교훈**: Flyway 마이그레이션 후 Replica 전파 확인 체크리스트가 필요합니다. Replication 상태 모니터링이 필수입니다.

### 5. snippetSource에 raw 위키 마크업 저장

[AI 검색 요약](/blog/project/wikiengine/search-rag)에서 위키 마크업이 그대로 stored field에 저장되어 UnifiedHighlighter가 빈 snippet을 반환했습니다. Wikipedia CirrusSearch 패턴(clean text 별도 필드)으로 해결했습니다.

**교훈**: raw 데이터를 stored field에 저장하는 것은 안티패턴입니다. 인덱스 타임에 정제해야 합니다.

---

## 기술 선택의 근거

### 왜 Elasticsearch가 아니라 임베디드 Lucene인가

| 관점 | Lucene (선택) | Elasticsearch |
|------|-------------|--------------|
| 메모리 사용 | **앱 JVM 내 공유** (별도 프로세스 없음) | 단일 노드도 JVM 2G+ 별도 필요, HA 시 3노드(6G+) |
| 검색 성능 | **네트워크 홉 없음** — 같은 프로세스 내 직접 호출 | REST API + 네트워크 직렬화/역직렬화 오버헤드 |
| 운영 복잡도 | 앱과 함께 배포, 별도 프로세스 관리 없음 | 별도 클러스터 배포 + 모니터링 + 버전 관리 |
| 인프라 제약 | **OCI Free Tier 12GB 서버에서 운영 가능** | 12GB 서버에서 ES(단일이라도 JVM 2G+) + 앱 + MySQL + Redis + Kafka 동시 운영 시 메모리 압박 |
| LTR | Rescorer API 직접 구현 | elasticsearch-learning-to-rank 플러그인 |
| 분산 검색 | 앱 레벨 샤딩 (구현 필요) | 네이티브 샤딩+복제 |

현재 인프라(Free Tier 2대, 총 24GB RAM)에서 앱(Spring Boot + Lucene) + MySQL + Redis 3노드 + Kafka를 모두 운영하고 있습니다. 여기에 Elasticsearch를 단일 노드라도 추가하면 JVM 2GB+ 메모리가 별도로 필요하여, 이미 빠듯한 메모리에 압박이 가중됩니다. Lucene 임베디드는 앱 JVM 내에서 동작하여 별도 프로세스가 없고, 네트워크 홉도 없어 응답시간이 더 빠릅니다. 검색 품질, 캐싱, LTR, Facet, 동의어, 오타 교정까지 모두 Lucene API만으로 구현할 수 있었습니다. 다만 분산 검색이 필요해지면 앱 레벨 샤딩을 직접 구현해야 하는 한계가 있으며, 인프라가 확장되면 Elasticsearch 마이그레이션을 검토합니다.

### 왜 Kafka를 쓰는가 (볼륨이 작은데 오버엔지니어링 아닌가)

ROI 비교: Kafka 주간 운영 30분~1시간 vs dual-write 불일치 발생 시 디버깅+재인덱싱(28분) 수 시간. `@ConditionalOnProperty` fallback으로 Kafka 장애 시에도 `@ApplicationModuleListener`로 자동 전환되어 서비스 연속성이 확보됩니다. Kafka는 "평시의 정확성 보장"이고, fallback은 "장애 시 서비스 연속성 보장"으로 역할이 분리됩니다.

### 왜 BM25가 Dense Retrieval보다 적합한가

위키피디아 기술 용어 키워드 검색이 주 패턴입니다. 키워드 전용 쿼리에서 BM25 NDCG 0.88 > Dense 0.65입니다. "AI"→"인공지능" 수준의 의미 확장은 동의어 확장으로 이미 해결되었습니다. 벡터 검색은 "환경 오염" → "대기질" 같은 의미 검색 필요 케이스가 실측으로 확인되면 Lucene KnnFloatVectorField(HNSW) + Reciprocal Rank Fusion으로 전환합니다.

---

## 시리즈 전체 목록

### 검색 인프라 구축 (10편)

| # | 글 | 핵심 수치 |
|---|------|---------|
| 1 | [WikiEngine 프로젝트 개요](/blog/project/wikiengine/wiki-search-overview) | 12,156,589건, 아키텍처 설계 |
| 2 | [검색 시스템 장애 방지](/blog/project/wikiengine/search-system-crash) | LIKE 27M건 Full Scan → 타임아웃 방어 |
| 3 | [B-Tree 인덱스 자동완성](/blog/project/wikiengine/autocomplete-btree-index) | 5,000ms → 8ms (99.8%+) |
| 4 | [FULLTEXT ngram 인덱스](/blog/project/wikiengine/fulltext-ngram-index) | 12초 → 6ms (2,100배) |
| 5 | [MySQL → Lucene 전환](/blog/project/wikiengine/lucene-decision) | FULLTEXT 한계 → 임베디드 Lucene |
| 6 | [Deferred Join 최적화](/blog/project/wikiengine/deferred-join-optimization) | OFFSET 14.75M건 페이지네이션 해결 |
| 7 | [쿼리 리팩토링](/blog/project/wikiengine/query-refactoring-optimization) | 에러율 32.53% → 0% |
| 8 | [검색 품질 평가](/blog/project/wikiengine/search-quality) | P@10 0.827 → 0.853 (+3.2%) |
| 9 | [캐싱 전략](/blog/project/wikiengine/caching-strategy) | 776ms → 54ms (14.4배) |
| 10 | [Trie 자동완성](/blog/project/wikiengine/trie-autocomplete) | 자모 분해 + 검색 로그 기반 |

### 분산 아키텍처 (8편)

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

### 검색 품질 고도화 (5편)

| # | 글 | 핵심 수치 |
|---|------|---------|
| 19 | [카테고리 검색 필터링](/blog/project/wikiengine/search-category-facet) | Occur.FILTER + DB GROUP BY Facet |
| 20 | [쿼리 확장 + Query Understanding](/blog/project/wikiengine/search-query-enhancement) | 동의어, 오타 교정, UnifiedHighlighter |
| 21 | [LTR 재랭킹 + 카테고리 분류](/blog/project/wikiengine/search-ltr-ranking) | NDCG +4.8%p, 카테고리 83% |
| 22 | [콘텐츠 필터링](/blog/project/wikiengine/search-content-filter) | Aho-Corasick 16,090개 금칙어 |
| 23 | [AI 검색 요약 — RAG](/blog/project/wikiengine/search-rag) | Gemini SSE, 비용 모니터링 |

---

## 최종 아키텍처

![WikiEngine Infrastructure](/uploads/project/WikiEngine/wiki-engine-retrospective/wikiengine-architecture.svg)

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

처음부터 거대한 검색 플랫폼을 한 번에 완성하려고 한 프로젝트는 아니었습니다. 오히려 "지금 가장 큰 병목이 무엇인지"를 먼저 확인하고, 그 병목이 애플리케이션 코드에 있는지, 데이터 구조에 있는지, 운영 방식에 있는지를 하나씩 분리해가며 구조를 바꿔 본 과정에 더 가까웠습니다. 그래서 이 회고도 단순히 어떤 기술을 붙였는지보다, 왜 그 시점에 그 선택을 했는지와 무엇을 배우며 다음 단계로 넘어갔는지를 중심으로 정리했습니다.

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

## 아키텍처 변화와 선택

### 1단계: 단일 서버 + MySQL 검색

```
사용자 → Spring Boot → MySQL LIKE '%keyword%'
```

처음부터 검색 전용 인프라를 두기보다, 가장 단순한 구조에서 어디가 먼저 깨지는지를 확인하고 싶었습니다. 그래서 단일 서버에서 MySQL `LIKE '%keyword%'`로 본문 검색을 처리하며 병목을 관찰했습니다. 이 단계에서 얻고 싶었던 것은 "얼마나 느린가"보다 "어떤 쿼리가 어떤 방식으로 전체 시스템을 무너뜨리는가"였습니다. 실제로 27,443,742건에 대한 Full Table Scan이 발생하면서 5,000ms 이상 타임아웃이 빈번했고, 검색 한 번의 지연이 다른 요청까지 밀어내는 모습이 확인됐습니다.

- [검색 시스템 장애 방지](/blog/project/wikiengine/search-system-crash)에서 `LIKE` 쿼리의 Full Table Scan 문제를 발견하고, 5초 타임아웃 + fail-fast 3초로 장애 전파를 방지했습니다.
- [B-Tree 인덱스 자동완성](/blog/project/wikiengine/autocomplete-btree-index)에서 `LIKE 'prefix%'`에 복합 인덱스를 적용하여 5,000ms → **8ms**로 개선했습니다. 27,443,742건을 1건만 스캔하는 구조로 변경한 것입니다.
- [FULLTEXT ngram 인덱스](/blog/project/wikiengine/fulltext-ngram-index)에서 본문 검색을 12초 → 6ms (2,100배)로 개선했지만, 고빈도 토큰 "대한"에서 타임아웃이 발생하는 한계를 확인했습니다.

### 2단계: 임베디드 Lucene 전환

![2단계 아키텍처 — 임베디드 Lucene + MySQL CRUD](/uploads/project/WikiEngine/wiki-engine-retrospective/architecture-phase2.svg)

MySQL 안에서 해결할 수 있는 범위를 충분히 확인한 뒤에는, "같은 서버 자원 안에서 검색 정확도와 속도를 동시에 높일 방법"이 필요했습니다. FULLTEXT는 일부 쿼리에서 의미 있는 개선을 줬지만, 인덱스 크기 추정과 false positive, 한국어 처리 한계를 함께 안고 있었습니다. 그래서 별도 검색 클러스터를 늘리는 대신, 현재 인프라 제약 안에서 더 정밀한 제어가 가능한 방향을 택했고, 그 결과가 임베디드 Lucene 전환이었습니다. 이 선택의 핵심은 최신 기술을 쓰는 것이 아니라, **주어진 메모리와 CPU 안에서 가장 예측 가능한 검색 경로를 만드는 것**이었습니다.

- [MySQL을 버리고 Lucene을 선택한 이유](/blog/project/wikiengine/lucene-decision)에서 FULLTEXT의 한계를 분석하고, Nori 한국어 형태소 분석기를 적용한 임베디드 Lucene으로 전환했습니다.
- [검색 품질 평가](/blog/project/wikiengine/search-quality)에서 PhraseQuery(slop=2) + BM25 + FeatureField(viewCount, likeCount) + Recency Decay 랭킹을 구현했습니다. 15개 테스트 쿼리로 측정한 P@10이 0.827 → **0.853** (+3.2%)로 개선되었습니다.
- [Deferred Join 최적화](/blog/project/wikiengine/deferred-join-optimization)에서 OFFSET 14,750,000건 페이지네이션이 Lucene 검색보다 38배 느린 문제(2,518ms vs 66ms)를 Covering Index + Deferred Join으로 해결했습니다.
- [쿼리 리팩토링](/blog/project/wikiengine/query-refactoring-optimization)에서 14,250,000건에 대한 COUNT(*) 2,038ms를 제거하고 Page→Slice로 전환했습니다. **에러율이 32.53% → 0%**로 해소되었습니다.

### 3단계: 캐시 + 자동완성

```
사용자 → Spring Boot → Caffeine(L1) → Lucene
                      → Trie 자동완성 (검색 로그 기반)
```

Lucene 전환 이후에는 "검색 자체가 느린가"보다 "같은 계산을 너무 자주 반복하고 있지 않은가"가 더 중요한 질문이 됐습니다. 실제 사용 패턴을 보면 전체 트래픽은 고르게 퍼지지 않았고, 일부 인기 검색어와 반복 조회가 CPU를 계속 태우고 있었습니다. 그래서 이 단계에서는 검색 엔진을 더 바꾸기보다, **같은 요청을 더 적은 자원으로 처리하는 구조**에 집중했습니다. 캐시와 자동완성은 모두 이 판단에서 나온 선택이었습니다.

- [캐싱 전략](/blog/project/wikiengine/caching-strategy)에서 Caffeine L1 캐시를 적용하여 776ms → **54ms** (14.4배)로 개선했습니다. 히트율 99.9%를 달성했습니다.
- [Trie 자동완성](/blog/project/wikiengine/trie-autocomplete)에서 검색 로그 기반 인기 검색어를 Trie 자료구조에 적재하고, 한국어 자모 분해(초성/중성/종성)를 적용하여 "삼ㅅ" 입력 시 "삼성전자"가 제안되도록 구현했습니다.

### 4단계: 분산 아키텍처

![4단계 아키텍처 — 분산 시스템](/uploads/project/WikiEngine/wiki-engine-retrospective/architecture-phase4.svg)

이 단계에서 가장 경계했던 것은 "서버를 늘리면 해결될 것"이라는 단순한 기대였습니다. 단일 서버의 한계(100-150 VU에서 CPU 100% 포화)는 확인됐지만, 상태를 그대로 들고 있는 구조에서 인스턴스 수만 늘리면 병목과 불일치가 더 넓게 퍼질 수 있었습니다. 그래서 스케일아웃 자체보다 먼저, **늘려도 같은 결과를 낼 수 있는 구조인지**를 확인하는 데 집중했습니다. 상태 외부화, 읽기/쓰기 분리, 변경 전파, 캐시 계층화는 모두 그 전제조건을 맞추는 작업이었습니다.

- [부하 테스트 튜닝](/blog/project/wikiengine/stress-test-tuning)에서 200 VU stress 테스트를 수행했습니다. CPU 100% 포화, Load Average 20+, P95 1,413ms로 단일 서버의 한계가 100-150 VU임을 확인했습니다. JVM 튜닝(G1GC, HikariCP)은 근본적 해결이 되지 않았습니다.
- [Redis L2 캐시](/blog/project/wikiengine/redis-l2-cache)에서 Caffeine(L1) + Redis(L2) 2계층 캐시를 구축했습니다. **L1 73% + L2 9% = 82% 히트율**을 달성하여 Origin 도달률을 19%로 낮췄습니다. Trie를 Redis flat KV O(1)로 전환하고, TokenBlacklist를 Redis로 외부화하여 Stateless 전환을 완료했습니다. 이후 `@Scheduled` 배치를 **Spring Batch Job+Tasklet**으로 전환하여 실행 이력 관리와 실패 복구를 확보했습니다.
- [MySQL Replication](/blog/project/wikiengine/replication)에서 GTID 비동기 Replication을 구성하고, `AbstractRoutingDataSource` + `LazyConnectionDataSourceProxy`로 R/W 자동 라우팅을 구현했습니다. Primary 5 + Replica 15 커넥션풀로 분리했습니다.
- [App 스케일아웃](/blog/project/wikiengine/scaleout)에서 Nginx L7 least_conn 로드 밸런싱 + App 2대로 확장했습니다. **에러율 13.25% → 0%, P95 2,300ms → 158ms, 평균 482ms → 37ms**로 개선되었습니다.
- [조회수 Redis INCR](/blog/project/wikiengine/view-count-redis)에서 GET 요청 내 UPDATE가 R/W 분리와 충돌하는 문제를 Redis INCR + Write-Behind 30초 배치 플러시로 해결했습니다. 에러율 11.10% → 0%로 해소되었습니다.
- [CDC — 이벤트 기반 동기화](/blog/project/wikiengine/cdc)에서 PostService의 dual-write(MySQL + Lucene 동시 업데이트)를 제거했습니다. Spring Event, `@ApplicationModuleListener`, Debezium+Kafka CDC를 순서대로 검토하며 당시 제약에 맞는 구조를 선택했고, 최종적으로는 MySQL binlog 기반으로 모든 변경 경로를 자동 캡처하는 방식으로 정리했습니다. **게시글 생성 5,315ms → 33ms (160배 개선)**. 이후 **DLQ(Dead Letter Topic) + 예외 throw + AckMode.RECORD**로 에러 핸들링을 강화했습니다.
- [Redis 샤딩](/blog/project/wikiengine/redis-sharding)에서 KEYS 블로킹(34.6ms SLOWLOG)을 SCAN으로 전환하고, 3노드 Consistent Hashing으로 자동완성/캐시/블랙리스트 워크로드를 격리했습니다.
- [분산 안정성 검증](/blog/project/wikiengine/distributed-stability)에서 200 VU stress 테스트를 수행했습니다. **에러율 0.09%** (단일 서버 13.25%에서), **처리량 109 req/s (3.6배)**. MySQL, Redis, Kafka, Nginx 모두 여유가 있었고 App CPU만이 여전히 근본 병목임을 소거법으로 확인했습니다.

### 5단계: 검색 품질 고도화 + AI

성능과 안정성이 어느 정도 통제되기 전까지는 검색 품질을 아무리 올려도 운영에서는 버티기 어렵다고 봤습니다. 그래서 인프라를 먼저 안정화한 뒤, 이 단계에서는 "더 빠르게"보다 "더 맞게 찾게 하는 것"으로 초점을 옮겼습니다. 여기서부터는 같은 검색 시스템 안에서도 recall, precision, snippet 품질, 안전장치, AI 요약처럼 사용자 체감에 더 가까운 문제들을 다뤘습니다.

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

WikiEngine에서는 "bat" → ["b", "ba", "bat"]처럼, "삼성전자"도 "ㅅ", "사", "삼", "삼ㅅ", "삼성" 식으로 잘게 나눠 각 접두사 후보에 반영했습니다. 핵심은 실시간 계산 대신 미리 계산된 결과를 만들어두고 조회 시에는 바로 반환하도록 한 것입니다. 초기에는 단순한 스케줄 작업으로 시작했지만, 이후에는 실행 이력과 실패 복구를 다룰 수 있는 형태로 바꿔 운영 부담을 줄였습니다.

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

기존에는 데이터 저장과 검색 반영을 하나의 요청 안에서 직접 처리했지만, 이후에는 저장만 끝나면 나머지 반영은 뒤에서 자동으로 이어지는 구조로 바꿨습니다. 여기서 중요했던 것은 단순히 비동기로 돌리는 것이 아니라, **서비스 코드가 모든 후처리를 직접 책임지지 않도록 경계를 다시 그은 것**이었습니다. 그 결과 요청 경로는 가벼워졌고, 변경 전파는 특정 메서드의 구현에 묶이지 않고 더 일관된 기준으로 관리할 수 있게 됐습니다.

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

여기서의 핵심 판단은 "서버를 늘리는 일"보다 "서버를 늘려도 문제를 복제하지 않는 일"이었습니다. 그래서 서비스 계층 확장은 단순한 인스턴스 추가가 아니라, 상태와 읽기 부하를 먼저 정리한 뒤 마지막에 밸런서를 올리는 순서로 진행했습니다.

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

**교훈**: 정확도 지표가 좋아졌다는 이유만으로 운영 경로에 바로 넣으면 안 된다는 점을 배웠습니다. 검색 품질 개선은 모델 성능만의 문제가 아니라, 그 품질을 현재 인프라가 감당할 수 있는가까지 함께 검증해야 합니다. 이후에는 "좋은 모델인가?"보다 "지금 구조에서 감당 가능한 개선인가?"를 먼저 보게 됐습니다.

### 2. LLM 학습 데이터 생성 98% 실패

[LTR 재랭킹](/blog/project/wikiengine/search-ltr-ranking)에서 Gemini API의 15 RPM 제한을 초과하여 900건 중 18건만 성공했습니다(2% 성공률). 라운드 간 딜레이 2초로 분당 30요청이 되었고, Spring AI가 HTTP 429를 `NonTransientAiException`으로 분류하여 재시도하지 않았습니다. 메모리 전용 저장(`ArrayList`)이라 실패를 인지하지 못했습니다.

**교훈**: 외부 API를 활용한 파이프라인은 "기능이 된다"보다 "실패를 관측할 수 있는가"가 먼저여야 했습니다. 특히 배치성 작업에서는 중간 결과를 메모리에만 두는 순간 실패가 조용히 사라질 수 있습니다. 이후에는 호출 한도를 먼저 예산처럼 계산하고, 결과는 즉시 영속화하며, 성공/실패를 분리해서 보도록 관점을 바꿨습니다.

### 3. CDC 배포 후 검색 미반영

[CDC](/blog/project/wikiengine/cdc)에서 멀티 인스턴스 환경의 Consumer-IndexWriter 위치 불일치가 발생했습니다. App 2에서 CDC 이벤트를 수신했지만 Lucene IndexWriter가 null이라 인덱싱이 skip되었습니다. App 1은 docker-compose에서 환경변수 매핑이 빠져 Kafka 연결 자체가 실패했습니다.

**교훈**: 분산 구조에서는 개별 컴포넌트가 살아 있다는 사실만으로는 충분하지 않았습니다. 이벤트를 읽는 위치, 인덱스를 쓰는 위치, 설정이 실제 배포 경로에서 어떻게 연결되는지를 끝까지 따라가 봐야 했습니다. 이후에는 "모든 컴포넌트가 healthy인가"보다 "사용자 변경이 끝까지 반영되는가"를 확인하는 end-to-end 검증을 더 중요하게 보게 됐습니다.

### 4. Flyway 마이그레이션 Replica 미전파

[AI 검색 요약](/blog/project/wikiengine/search-rag)에서 MySQL Replication이 끊겨 DDL이 Replica에 전파되지 않았습니다. `ddl-auto: validate`(운영)와 `update`(로컬)의 차이로 로컬에서는 자동 처리되던 스키마 변경이 운영에서 실패했습니다.

**교훈**: 로컬에서 자연스럽게 흘러가던 가정이 운영에서는 그대로 성립하지 않는다는 점을 다시 확인했습니다. 마이그레이션은 SQL 실행 자체보다, 그 변경이 읽기 경로 전체에 전파됐는지까지 확인해야 끝나는 작업이었습니다. 이후에는 배포 완료의 기준을 "마이그레이션 성공"이 아니라 "Primary와 Replica가 같은 스키마 상태에 도달했는가"로 두게 됐습니다.

### 5. snippetSource에 raw 위키 마크업 저장

[AI 검색 요약](/blog/project/wikiengine/search-rag)에서 위키 마크업이 그대로 stored field에 저장되어 UnifiedHighlighter가 빈 snippet을 반환했습니다. Wikipedia CirrusSearch 패턴(clean text 별도 필드)으로 해결했습니다.

**교훈**: 검색 시스템에서는 "저장된 원문"과 "검색에 적합한 표현"이 같지 않을 수 있다는 점을 체감했습니다. 원본을 그대로 보관하는 편의보다, 검색과 하이라이팅에 맞는 형태로 인덱스 시점에 정제하는 편이 전체 시스템 품질에 더 중요했습니다.

---

## 기술 선택의 근거

### 왜 Elasticsearch가 아니라 임베디드 Lucene인가

이 선택에서 제가 가장 중요하게 본 기준은 "더 유명한 검색 엔진인가"가 아니라, **지금 가진 자원으로 가장 안정적으로 운영할 수 있는가**였습니다. 이 프로젝트에서 먼저 필요했던 것은 대규모 분산 검색 자체가 아니라, 제한된 메모리 안에서 예측 가능한 응답시간과 디버깅 가능한 검색 경로를 확보하는 일이었습니다. 그런 조건에서는 별도 검색 클러스터를 늘리기보다, 애플리케이션 안에서 제어 가능한 검색 엔진을 두는 편이 훨씬 현실적이었습니다.

| 관점 | Lucene (선택) | Elasticsearch |
|------|-------------|--------------|
| 메모리 사용 | **앱 JVM 내 공유** (별도 프로세스 없음) | 단일 노드도 JVM 2G+ 별도 필요, HA 시 3노드(6G+) |
| 검색 성능 | **네트워크 홉 없음** — 같은 프로세스 내 직접 호출 | REST API + 네트워크 직렬화/역직렬화 오버헤드 |
| 운영 복잡도 | 앱과 함께 배포, 별도 프로세스 관리 없음 | 별도 클러스터 배포 + 모니터링 + 버전 관리 |
| 인프라 제약 | **OCI Free Tier 12GB 서버에서 운영 가능** | 12GB 서버에서 ES(단일이라도 JVM 2G+) + 앱 + MySQL + Redis + Kafka 동시 운영 시 메모리 압박 |
| LTR | Rescorer API 직접 구현 | elasticsearch-learning-to-rank 플러그인 |
| 분산 검색 | 앱 레벨 샤딩 (구현 필요) | 네이티브 샤딩+복제 |

현재 인프라(Free Tier 2대, 총 24GB RAM)에서 앱(Spring Boot + Lucene) + MySQL + Redis 3노드 + Kafka를 모두 운영하고 있습니다. 여기에 Elasticsearch를 단일 노드라도 추가하면 JVM 2GB+ 메모리가 별도로 필요하여, 이미 빠듯한 메모리에 압박이 가중됩니다. Lucene 임베디드는 앱 JVM 내에서 동작하여 별도 프로세스가 없고, 네트워크 홉도 없어 응답시간이 더 빠릅니다. 검색 품질, 캐싱, LTR, Facet, 동의어, 오타 교정까지 모두 Lucene API만으로 구현할 수 있었습니다. 다만 분산 검색이 필요해지면 앱 레벨 샤딩을 직접 구현해야 하는 한계가 있으며, 인프라가 확장되면 Elasticsearch 마이그레이션을 검토합니다.

### 왜 Kafka를 쓰는가 (볼륨이 작은데도 선택한 이유)

이 질문은 타당했습니다. WikiEngine은 초당 수만 건을 처리하는 서비스가 아니고, 글 생성량만 보면 메시지 브로커까지 도입하는 것이 과해 보일 수 있습니다. 그래서 이 프로젝트에서도 처음부터 Kafka를 전제로 두지 않았습니다. 오히려 [CDC — 이벤트 기반 동기화](/blog/project/wikiengine/cdc)에서 정리한 것처럼 **Spring Event → `@ApplicationModuleListener`**처럼 더 가볍고 단순한 선택부터 먼저 검토했습니다. 이때 기준은 "최신 기술인가"가 아니라, `PostService`가 MySQL 저장, Lucene 인덱싱, 캐시 무효화를 한 요청 안에서 모두 직접 처리하던 **dual-write 구조의 결합과 불일치 위험**을 어느 정도까지 줄일 수 있는가였습니다.

여기까지는 로컬 이벤트만으로도 꽤 많은 문제가 해결됐습니다. 쓰기 지연은 줄었고, 서비스 코드도 훨씬 단순해졌습니다. 하지만 운영 관점에서 보면 한계가 분명히 남아 있었습니다.

- 애플리케이션을 통하지 않는 DB 변경은 잡을 수 없었습니다. 마이그레이션 스크립트, 벌크 업데이트, 긴급 운영 수정처럼 ORM 밖에서 일어난 변경은 검색 인덱스와 캐시에 자동 반영되지 않았습니다.
- 이벤트가 JVM 내부에 머무르는 구조라, 멀티 인스턴스 환경에서는 어느 인스턴스에서 이벤트가 발생했는지에 따라 후속 처리 범위가 달라졌습니다.
- 무엇보다 실패 후 복구가 어려웠습니다. [부하 테스트 튜닝](/blog/project/wikiengine/stress-test-tuning)에서 실제로 Lucene 인덱싱이 `IOException`으로 실패한 적이 있었고, 이 경우 DB에는 저장됐지만 검색 인덱스에는 반영되지 않는 불일치가 생깁니다. 당시 구조에서는 이를 자동으로 감지하거나 다시 재생할 방법이 없었습니다.

즉, 여기서 Kafka를 쓴 이유는 "처리량이 커서"가 아니라 **정확성과 복구 가능성을 더 우선시했기 때문**이었습니다. 애플리케이션이 여러 저장소에 직접 쓰는 대신, DB에 실제로 기록된 변경 사실을 기준으로 뒤에서 전파하는 구조로 바꾸면, 서비스 코드 바깥에서 발생한 변경까지 하나의 기준으로 수렴시킬 수 있습니다. 그리고 Kafka는 그 변경 이벤트를 **보관하고, 다시 읽고, 필요하면 재생할 수 있는 공용 로그** 역할을 맡았습니다. 이 차이는 단순히 이벤트를 비동기로 흘리는 것과는 결이 다릅니다.

이미 Redis를 쓰고 있었기 때문에 "그냥 Redis Stream이면 되지 않나?"라는 질문도 가능했습니다. 하지만 이 프로젝트에서 필요했던 것은 실시간성이 아니라, **문제가 생겼을 때 다시 따라가며 복구할 수 있는 기록**이었습니다. 자동완성처럼 일정 지연을 허용하는 경로도 있었고, 검색 인덱스가 틀어졌을 때는 짧게 전달하는 것보다 **남겨두고 다시 읽을 수 있는 로그**가 더 중요했습니다. 이 비교는 [인터뷰 예상 질문 정리](/blog/project/wikiengine/interview-qa)와 [CDC 글](/blog/project/wikiengine/cdc)에 더 자세히 적어두었습니다.

그래서 이 프로젝트에서 Kafka의 가치는 "대용량 스트리밍 처리"라기보다, **dual-write를 서비스 코드에서 걷어내고 변경 전파를 재생 가능한 로그 위에 올린 것**에 있었습니다. 볼륨이 작아도 한 번 불일치가 나면 비용은 트래픽이 아니라 복구 방식에 비례합니다. 실제로 Kafka 주간 운영 비용은 대략 30분~1시간 수준이었지만, 불일치가 발생하면 디버깅, 원인 추적, 재인덱싱(28분), 사용자 영향 확인까지 몇 시간이 쉽게 소모될 수 있습니다. 반대로 말하면, Kafka가 "더 좋은 구조라서" 선택된 것이 아니라 **가벼운 대안들과 비교했을 때 이 프로젝트에서는 correctness와 replay 요구사항을 가장 잘 만족시켰기 때문에** 선택된 셈입니다.

물론 Free Tier 제약 때문에 Kafka도 이상적인 형태는 아니었습니다. 단일 브로커 구성이라 브로커 자체 장애에는 취약했고, 그래서 이 구조를 Kafka 하나에만 의존하지 않도록 설계했습니다. `@ConditionalOnProperty` fallback으로 Kafka가 내려가면 다시 `@ApplicationModuleListener` 기반 비동기 처리로 자동 전환되게 만들었습니다. 즉, Kafka는 **평시의 정확성과 재생 가능성 보장**, fallback은 **장애 시 서비스 연속성 보장**이라는 식으로 역할을 분리했습니다. 자세한 운영 판단과 예외 상황은 [CDC — 이벤트 기반 동기화](/blog/project/wikiengine/cdc)와 [분산 안정성 검증](/blog/project/wikiengine/distributed-stability)에서 이어서 다루고 있습니다.

### 왜 BM25가 Dense Retrieval보다 적합한가

이 프로젝트에서 먼저 풀어야 했던 검색 문제는 "의미적으로 넓게 비슷한 문서를 찾는 것"보다, 사용자가 입력한 기술 용어와 개념을 얼마나 정확하게 맞히는가에 가까웠습니다. 실제 쿼리도 "스프링 시큐리티", "트랜잭션 전파", "자바 NIO"처럼 명시적인 키워드 검색이 대부분이었습니다. 이런 상황에서는 단어 일치와 필드별 가중치, 최신성, 조회수 같은 신호를 직접 제어할 수 있는 쪽이 더 중요했습니다.

그래서 WikiEngine에서는 먼저 BM25를 중심으로 품질을 끌어올리고, 동의어 확장과 오타 교정, snippet 품질 개선으로 부족한 부분을 메웠습니다. "AI" → "인공지능" 수준의 의미 확장은 이 단계에서 이미 충분히 커버할 수 있었고, 실제 평가에서도 키워드 중심 쿼리에서는 BM25가 더 안정적인 결과를 보였습니다.

벡터 검색은 분명 강력하지만, 이 프로젝트에서는 먼저 필요성이 실측으로 확인되지 않았습니다. 그래서 처음부터 복잡도를 올리기보다, 현재 사용자 검색 패턴에 가장 잘 맞는 방식을 택했습니다. 다만 "환경 오염" → "대기질"처럼 명시적 키워드가 없어도 관련 문서를 찾아야 하는 요구가 분명해지는 시점에는 Lucene의 벡터 검색과 하이브리드 랭킹을 검토할 계획입니다.

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

최종 구조를 한 문장으로 요약하면, **무거운 계산은 뒤로 밀고, 사용자 요청 경로는 최대한 짧고 단순하게 유지하는 방향**으로 정리됐습니다. 검색은 빠르게 읽히는 경로와 뒤에서 정리되는 경로를 분리했고, 상태는 가능한 한 외부화했으며, 변경 전파는 서비스 코드의 직접 호출보다 더 일관된 기준 위에 올리려고 했습니다.

돌이켜보면 이 프로젝트에서 가장 크게 배운 것은 "좋은 구조"가 처음부터 정답처럼 주어지는 것이 아니라는 점이었습니다. 병목을 관찰하고, 실패를 겪고, 지금 단계에서 가장 큰 제약이 무엇인지를 다시 정의하면서 구조를 조금씩 바꾸는 과정 자체가 엔지니어링이었다고 생각합니다. 그래서 WikiEngine은 단순히 검색 엔진을 만든 프로젝트라기보다, **제약 안에서 무엇을 먼저 해결해야 하는지 판단하는 연습**에 더 가까운 프로젝트로 남아 있습니다.

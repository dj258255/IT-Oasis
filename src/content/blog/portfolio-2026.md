---
title: '범수: Backend Engineer 포트폴리오'
description: 오픈소스 기여(Spring Boot, Apache Lucene), 1,215만 건 데이터로 자체 구축한 임베디드 검색 엔진 WikiEngine, 실시간 협업 워크스페이스 Balruno를 정리한 백엔드 엔지니어 포트폴리오입니다.
date: 2026-05-21T00:00:00.000Z
tags:
  - Portfolio
  - Backend
  - Lucene
  - Search Engine
  - Spring Boot
  - Kafka
  - Redis
  - Architecture
category: portfolio
coverImage: /uploads/project/WikiEngine/wiki-engine-retrospective/wikiengine-architecture.svg
draft: false
unlisted: true
---

# 범수: Backend Engineer

- 블로그: <http://dj258255.github.io/IT-Oasis>
- 깃허브: <https://github.com/dj258255>

이 포트폴리오는 세 가지 축으로 구성됩니다.

1. **오픈소스 기여**: Spring Boot, Apache Lucene
2. **WikiEngine**: 1,215만 건 위키 데이터로 자체 구축한 임베디드 검색 엔진
3. **Balruno**: 게임 기획·밸런싱 워크플로우를 한 화면에 통합한 실시간 협업 워크스페이스

---

## 1. 오픈소스 기여

### Spring Boot 기여: Kotlin 테스트 API 사용성 개선

Spring Boot의 JPA 테스트 유틸리티인 `TestEntityManager`에 Kotlin reified extension functions를 추가했습니다.

기존 Kotlin 테스트 코드에서는 `find(Foo::class.java, id)`처럼 Java class reference를 직접 전달해야 했지만, `find<Foo>(id)` 형태로 더 간결하고 타입 안전하게 사용할 수 있도록 개선했습니다.

**주요 구현**

- `find<Foo>(id)`
- `persistAndGetId<Long>(entity)`
- `getId<Long>(entity)`

**검증**: Mockito 기반 단위 테스트를 작성해 각 확장 함수가 기존 `TestEntityManager` API로 올바르게 위임되는지 검증했습니다.

**성과**: Spring Boot 4.1.0-M2 New Features에 반영.

### Apache Lucene 기여: IndexWriter 초기화 실패 시 리소스 누수 방지

Apache Lucene의 `IndexWriter` 초기화 실패 경로에서 발생하던 thread pool leak 문제를 수정했습니다.

`ConcurrentMergeScheduler`는 초기화 과정에서 `CachedExecutor`를 생성하지만, 이후 `IndexWriter` 생성자가 실패하면 기존 예외 처리 로직이 `writeLock`만 닫고 `MergeScheduler`를 닫지 않아 `ThreadPoolExecutor`가 종료되지 않는 문제가 있었습니다.

**검증**: `OpenMode.APPEND`와 빈 디렉터리를 사용해 초기화 실패 상황을 재현하고, `MergeScheduler.close()` 호출 여부를 `AtomicBoolean`으로 검증하는 회귀 테스트를 추가했습니다.

**성과**: Apache Lucene main branch merge, CHANGES.txt bug fix 기록.

---

## 2. WikiEngine: 1,215만 건 임베디드 검색 엔진

- Github: <https://github.com/dj258255/wikiEngine>
- Blog: <https://dj258255.github.io/IT-Oasis/blog/project/wikiengine/wiki-engine-retrospective/>

### 프로젝트 개요

WikiEngine은 나무위키, 한국어/영어 위키백과, 뉴스, 웹텍스트 등 6개 소스에서 수집한 **12,156,589건**의 데이터를 대상으로 한 검색 엔진입니다. 위키 문서를 그대로 사용하지 않고, 실제 커뮤니티 게시판처럼 변환하여 적재했습니다. 위키 `[[분류:XXX]]`는 태그+카테고리로 변환하고, 뉴스/웹 콘텐츠는 소스별 고정 카테고리를 부여했습니다. `author_id`는 10만 명의 더미 유저에게 균등 배정, `created_at`은 2020~2025 범위 내 랜덤 생성했습니다.

**사용한 기술**

- Backend: Java, Spring Boot, Spring Batch, Spring Kafka, JPA/Hibernate
- Search/Data: Lucene, Nori, MySQL, Redis, Caffeine
- Messaging/Data Sync: Kafka, CDC, Debezium
- Infra/DevOps: Docker, Nginx, Ansible, GitHub Actions
- Observability/Test: Prometheus, Grafana, k6

**인프라 구성**

- 서버 1 (ARM 2코어/12GB): Spring Boot App(Primary) + MySQL(Primary) + Redis(Shard1) + Nginx + Lucene 42GB
- 서버 2 (ARM 2코어/12GB): Spring Boot App(Replica) + MySQL(Replica) + Kafka + Debezium + Redis(Shard2,3)
- 서버 3 (AMD 1GB): Grafana + Loki + InfluxDB(k6)
- 서버 4 (AMD 1GB): Prometheus (500MB, 30일 보존)

**데이터 소스**

| 소스 | 문서 수 | 설명 |
|------|---------|------|
| 나무위키 (2021.03) | 571,364건 | HuggingFace `Bingsu/namuwiki_20210301_filtered` JSON |
| 한국어 위키백과 (2026.03) | 739,791건 | Wikimedia Dumps(kowiki), ns=0 일반 문서만 |
| 영어 위키백과 (2026.02) | 7,139,510건 | Wikimedia Dumps(enwiki), ns=0 일반 문서만 |
| 한국어 뉴스 | 159,639건 | HuggingFace `sieu-n/korean-newstext-dump` |
| 한국어 웹텍스트 | 1,284,822건 | HuggingFace `HAERAE-HUB/KOREAN-WEBTEXT` |
| C4 한국어 클린 | 2,261,463건 | HuggingFace `blueapple8259/c4-ko-cleaned-2` |
| **합계** | **12,156,589건** | 30개 카테고리, 고유 태그 ~216만 개 |

모든 데이터는 HuggingFace 및 Wikimedia의 공개 데이터셋이며 MySQL에 임포트했습니다.

### 최종 데이터플레인

![WikiEngine 최종 아키텍처](/uploads/project/WikiEngine/wiki-engine-retrospective/wikiengine-architecture.svg)

![인프라 토폴로지](/uploads/project/WikiEngine/wiki-search-overview/architecture.png)

### 핵심 트러블슈팅 요약

**01 검색엔진 전환**: MySQL LIKE → FULLTEXT ngram → 임베디드 Lucene + Nori

- 문제: LIKE 5,000ms 타임아웃. HikariCP 커넥션(10) 고갈로 검색 외 전체 API 503 cascade failure. `EXPLAIN` 결과 `type=ALL`, `Rows=27,443,742`, MEDIUMTEXT Full Table Scan
- 분석: FULLTEXT ngram 시도 시 일부 쿼리 12s→6ms 개선되었으나 고빈도 토큰에서 12,766ms 타임아웃. 인덱스 추정 300GB+로 과도
- 결정: 단일 서버 제약 → ES 대신 임베디드 Lucene + Nori 결정 (별도 프로세스 없이 JVM 내에서 직접 제어, 한국어 형태소 랭킹·하이라이팅까지 세밀 조정 가능)
- 결과 (K6 부하 테스트 실측): 검색 P95 5,000ms+ → 100ms[평균 29ms], 에러율 32.53% → 0%, P@10 0.827 → 0.853

**02 분산 아키텍처**: Stateless · R/W 분리 · Scale-out · CDC · Redis 샤딩

- 단계: 상태 외부화(Stateless) → MySQL R/W 분리 → App 2대 스케일 아웃 → 조회수 Redis INCR + Write-Behind 30초 배치
- 정합성: Debezium + Kafka CDC로 dual-write 제거. MySQL binlog를 단일 원본으로 삼고, 각 App이 Kafka consumer로 자기 Lucene을 비동기 갱신
- 확장: Redis 3노드 Consistent Hashing, KEYS 블로킹을 SCAN 전환으로 해소
- 결과 (K6 100 VU 실측): P95(100 VU) 2,300 → 190ms[12배], 에러율 13.25% → 0%, 게시글 생성(CDC) 5,315ms → 33ms[160배]

**03 검색 품질**: 동의어 · 오타교정 · LTR · 카테고리 분류 · RAG · 금칙어

- 쿼리 이해: DB 동의어 쿼리타임 확장(AI → 인공지능), DirectSpellchecker 오타 교정, UnifiedHighlighter snippet
- 랭킹/분류: XGBoost LambdaMART 14피처 LTR, 키워드 배치 분류로 28개 카테고리 자동 부여
- 생성/필터: Gemini SSE 스트리밍 RAG(캐시 30분, 전역 RPM 제한, 인라인 인용 강제), Aho-Corasick O(N+Z) 금칙어 탐지
- 결과: NDCG@10 0.691 → 0.739(+4.8%p), 카테고리 분류 28개[83% 정확도], 금칙어/RAG 16,090개 탐지

**최종 수치**: 데이터 1,215만 건, 검색 p95 119ms, 부하 에러율 0%, NDCG +4.8%p, Lucene 인덱스 42GB, Redis 73MB / 256MB

---

### 프로젝트 설계: 자동완성 요구사항 정의

구현에 앞서 자동완성 시스템이 정확히 무엇을 해야 하는지부터 명확히 했습니다.

**기능적 요구사항**

- 검색어 제안 기준: 전체 사용자가 최근 24시간 내 입력한 검색어 빈도 기반
- 제안 개수: 접두사당 상위 10개
- 지원 언어: 한국어, 영어 / 최대 접두사 길이 60자
- 대소문자 구분 없음(내부적으로 소문자 통일), URL 인코딩/디코딩 처리

**비기능적 요구사항**

- 처리 규모: OCI Free Tier 2코어 ARM, k6 부하 테스트 100 VU 기준 실측
- 응답 시간: 평균 입력 속도(초당 4자)보다 빨라야 하므로 최대 240ms 이내
- 데이터 최신성: 제안 결과 최대 1시간 지연 허용, 최종 일관성(Eventual Consistency)

**설계 전 핵심 판단**

1. **Trie 자료구조는 대용량 자동완성에 적합하지 않다고 봤습니다.** 최대 60자 입력과 대규모 데이터셋 기준으로 메모리 비용이 크고, DFS 탐색·인기순 정렬 비용까지 더해지면 목표 응답시간 안에 안정적으로 처리하기 어렵다고 판단했습니다. 그래서 요청마다 후보를 탐색·정렬하는 대신, 접두사별 상위 추천 결과를 미리 집계해두고 조회 시 바로 반환하는 구조를 선택했습니다.
2. **자동완성 조회와 검색어 집계는 분리해야 했습니다.** `GET /posts/autocomplete?prefix=`는 240ms 이내 응답해야 하는 읽기 전용 API이고, `GET /posts/search?q=`는 검색어 빈도를 누적하는 쓰기 성격의 API입니다. 하나의 구조로 두 책임을 함께 처리하면 읽기와 쓰기가 서로 방해할 수 있다고 판단해 분리했습니다.
3. **자동완성은 실시간 계산보다 주기적 집계가 더 적합하다고 판단했습니다.** 최대 1시간 지연이 허용됐기 때문에, 모든 입력을 실시간 처리하는 대신 검색어를 모아 일정 주기로 집계하고 접두사별 상위 추천 결과를 갱신하는 구조를 택했습니다.

---

### 1. 검색 엔진 전환: 정상 상태에서 Lucene까지

**정상 상태 → 문제 인식.** 초기 검색은 MySQL `LIKE %keyword%`로 본문을 검색했습니다. 대상 데이터는 12,156,589건이었고, `posts.content`는 위키 마크업이 포함된 MEDIUMTEXT(평균 6,586자)였습니다. k6 부하 테스트에서 검색 API가 5,000ms+로 타임아웃됐고, `EXPLAIN` 결과는 `type=ALL`, `rows=27,443,742`로 사실상 전체 테이블을 순차 스캔하고 있었습니다. `LIKE %keyword%`는 앞쪽 와일드카드 때문에 B-Tree 인덱스를 사용할 수 없었습니다. 더 큰 문제는 cascade failure였습니다. 검색 쿼리 하나가 HikariCP 커넥션을 수 초간 점유하면 다른 API도 함께 막혔고, `maximumPoolSize=10` 환경에서는 검색 쿼리 3~4개만 동시 실행돼도 나머지 커넥션이 모두 대기 상태에 빠졌습니다.

![EXPLAIN 전체 테이블 스캔](/uploads/project/WikiEngine/search-system-crash/explain-result.png)

![503 cascade failure](/uploads/project/WikiEngine/search-system-crash/503-timeout-response.png)

**1차 시도, FULLTEXT ngram.** MySQL FULLTEXT ngram을 적용해 성능이 12초 → 6ms로 크게 개선됐습니다. 하지만 ngram은 2글자 단위로 토큰을 분리하기 때문에 `대한` 같은 고빈도 토큰이 수백만 건에 매칭됐고, posting list 순회 비용이 다시 폭증하면서 5,000ms+ 타임아웃이 재발했습니다. 인덱스 크기도 300GB+로 추정돼 운영 부담이 매우 컸습니다.

![고빈도 토큰 폭발](/uploads/project/WikiEngine/fulltext-ngram-index/high-freq-token-explosion.svg)

MySQL FULLTEXT에는 세 가지 구조적 한계가 있습니다. (1) ngram 토큰 폭발(`대한민국` → `대한`, `한민`, `민국`), (2) 12M건·평균 6,586자 기준 300GB+ 추정 인덱스, (3) NL mode에서 50% 이상 문서에 포함된 term 자동 제외. MySQL 기본 검색만으로는 1,215만 건 규모를 안정적으로 처리하기 어렵다고 판단했고, 별도의 전문 검색 엔진이 필요했습니다.

**대안 비교: 어떤 엔진이 제약에 맞는가.** 핵심은 기능이 가장 많은 엔진이 아니라, 2코어·12GB RAM 단일 서버에서 실제로 운영 가능한 검색 구조였습니다. Elasticsearch/OpenSearch는 별도 프로세스를 띄우는 순간 JVM 힙과 페이지 캐시가 추가로 필요해 단일 서버에서 부담이 컸고, MySQL과의 데이터 동기화 문제도 남았습니다. 반면 임베디드 Lucene은 애플리케이션 내부에서 직접 제어할 수 있어 별도 프로세스 없이 현재 자원 안에서 운영할 수 있었고, 한국어 형태소 분석·랭킹 조정·하이라이팅도 필요한 수준까지 직접 제어할 수 있었습니다.

![ngram vs Nori posting list](/uploads/project/WikiEngine/lucene-decision/ngram-vs-nori-posting-list.svg)

![Lucene 전환 후 성능](/uploads/project/WikiEngine/lucene-decision/step5-performance.png)

**결과.** 본문 검색은 더 이상 타임아웃에 기대는 기능이 아니라 29ms, P95 100ms 수준으로 안정화됐습니다. 제목·본문 가중치와 인기도·최신성 신호를 함께 반영하면서 P@10도 0.827 → 0.853으로 개선됐습니다. 다만 본문 검색은 빨라졌지만 최신 게시글 목록 조회에서 `COUNT(*)`와 deep OFFSET 비용이 남아 다시 병목으로 드러났습니다. 불필요한 전체 건수 계산을 제거하고 deep OFFSET 경로를 최적화하면서 `COUNT(*)` 2,038ms를 제거했고, 최신 목록 조회는 2,518ms → 17.56ms, 에러율은 32.53% → 0%로 개선됐습니다. 이 단계의 가장 큰 배움은 검색 엔진 전환이 문제를 끝내는 작업이 아니라, 어디까지가 검색 엔진의 책임이고 어디부터가 읽기 경로 설계의 문제인지를 구분하게 만든 전환점이었다는 점입니다.

### 2. 캐시 전략 + 자동완성

**검색 캐시 최적화.** Lucene 검색 자체는 29ms까지 빨라졌지만, 동일 검색어에 대해 매번 인덱스를 다시 탐색하는 것은 CPU를 반복 소모했고, 100 VU 환경에서 CPU가 80~100%까지 포화됐습니다. 검색 결과는 키워드·페이지 조합으로 경우의 수가 빠르게 늘어 외부 캐시에 단순히 밀어두기 어려웠던 반면, 같은 인스턴스에서 반복되는 요청은 네트워크 비용 없이 즉시 반환하는 편이 효율적이었기에 우선 애플리케이션 내부 L1 로컬 캐시를 두기로 판단했습니다.

![다계층 캐시 구조](/uploads/project/WikiEngine/caching-strategy/multi-layer-cache.svg)

결과는 다음과 같습니다. searchResults 히트율 81.8%, autocomplete 99.9%, postDetail 40.5%, 전체 응답시간 775.89ms → 53.83ms(14.4배). 이 수치는 캐시에 유리한 조건이 아니라 희귀 토큰 10%·중빈도 60%·고빈도 30%를 섞고 postDetail은 1,200만 건 중 랜덤 조회로 캐시 미스를 계속 유도한 보수적 조건에서 나온 값이었습니다.

**자동완성 품질 개선.** 로컬 캐시 적용으로 응답시간 368ms → 4.67ms, 히트율 99.9%까지 올랐지만 품질 문제가 남았습니다. Prefix 기반 자동완성은 사전순으로 반환해 `삼성`을 입력해도 `삼성전자`보다 `르노삼성 QM3`가 먼저 노출됐고, `삼ㅅ`처럼 완성되지 않은 한글 입력에서는 추천이 끊겼습니다. 검색 로그 기반 인기 검색어를 인메모리 Trie에 적재해 검색 빈도순 Top-10을 반환하도록 하고, 초성·중성·종성 분해를 적용해 원본 Trie와 자모 Trie를 분리했습니다.

![자모 중간 입력 자동완성](/uploads/project/WikiEngine/trie-autocomplete/C-2-api-jamo-middle.png)

자동완성은 사전순 → 인기순으로 바뀌었고, 한글 자모 중간 입력·초성 검색도 지원하게 됐습니다. 다만 Trie는 조회 시 DFS·정렬 비용과 Copy-on-Write 메모리 부담이 있어, 이후 스케일아웃 단계에서 접두사별 추천 결과를 미리 계산해 조회하는 flat KV 구조로 확장했습니다.

### 3. 분산 아키텍처

**단일 서버 한계 확인.** 읽기 경로와 자동완성까지 최적화한 뒤 단일 서버에서 k6 stress 테스트(200 VU, 25분)를 수행했습니다. 100 VU까지는 안정적이었지만 200 VU 구간 약 5분부터 CPU가 100% 포화되고 Load Average가 20+까지 치솟으면서 P95가 1,413ms까지 상승했습니다. 병목은 설정 문제가 아니었습니다. 메모리는 여유가 있었고 GC pause 최대 3ms, DB 버퍼 풀 히트율 거의 100%, 락 경합도 거의 없었습니다. CPU만 지속 포화됐고, 힙·스레드 튜닝은 오히려 응답시간을 악화시켰습니다. 필요한 것은 더 세밀한 튜닝이 아니라 요청을 여러 인스턴스로 분산하는 구조였고, 그 전제로 먼저 애플리케이션을 stateless하게 바꿔야 했습니다.

**1) Stateless 전환 + 공유 상태 외부화.** 앱 내부에는 로컬 캐시, Trie 자동완성, 토큰 무효화 상태처럼 인스턴스마다 달라질 수 있는 데이터가 있었습니다. 검색 결과는 로컬 캐시가 반복 요청을 처리하고 캐시 미스는 공유 캐시가 보완하는 계층 구조로 나눴고, 자동완성도 인메모리 Trie 대신 접두사별 추천 결과를 미리 계산해 공유 저장소에서 읽도록 바꿨습니다.

| 지표 | Before(Trie) | After(flat KV) | |
|------|------|------|------|
| 응답(캐시 히트) | ~0.1ms (Caffeine) | ~2.5ms (Redis P95) | 네트워크 비용 추가 |
| 응답(캐시 미스) | ~5ms (Trie DFS) | ~2.5ms (Redis GET) | DFS 제거 |
| CPU 부하 | Trie DFS + Copy-on-Write | 없음(Redis가 처리) | App CPU에서 제거 |
| 메모리 | ~66MB (JVM 힙) | ~73MB (Redis) | JVM 힙 절약 |
| 스케일 아웃 | 인스턴스별 중복 | Redis 공유 | 일관성 확보 |

**2) 읽기/쓰기 분리.** 핵심 질문은 "지금 MySQL이 느린가?"가 아니라 "App 인스턴스를 늘린 뒤에도 현재 DB 구조가 버틸 수 있는가"였습니다. 당시 MySQL은 직접적인 병목이 아니었지만, App만 늘리면 읽기 요청과 커넥션이 함께 증가해 단일 DB가 다음 병목이 될 수 있었습니다. 서비스 코드에 이미 읽기 전용/일반 트랜잭션 구분이 있어 이를 기준으로 경로를 나누는 방식이 별도 프록시보다 단순했습니다. 일관성은 최종 일관성을 허용했고 실제 복제 지연도 0~1초 수준이었습니다.

![Replication 토폴로지](/uploads/project/WikiEngine/replication/replication-topology.svg)

**3) App 스케일아웃.** 쿼리·캐시·자동완성 개선 뒤에도 100 VU 구간에서 App CPU가 100%에 가까워졌고 P95 2,300ms, 에러율 13.25%까지 상승했습니다. 활성 연결이 적은 인스턴스로 보내는 방식(least_conn)으로 읽기를 분산하고, 쓰기는 한쪽에 고정해 Lucene 인덱스 동기화 경로를 단순하게 유지했습니다(단일 writer + replica 동기화). 전환 후 평균 응답 482ms → 40.93ms, P95 2,300ms → 175ms. 다만 상세 조회 GET 안에 조회수 DB UPDATE가 남아 에러율 11.10%가 새로 발생했고, 조회수 증가를 읽기 경로 밖으로 옮겨 공유 카운터에 원자적으로 누적한 뒤 짧은 주기 배치로 DB 반영하도록 바꿨습니다.

![스케일아웃 토폴로지](/uploads/project/WikiEngine/scaleout/scaleout-topology.svg)

| 지표 | Before | After | |
|------|------|------|------|
| 평균 응답시간 | 482ms | 37ms | 92%↓ |
| P95 | 2,300ms | 158ms | 93%↓ |
| 처리량(피크) | ~30 req/s | ~58 req/s | 1.9배↑ |
| App CPU(피크) | ~100%(1대) | ~50%(2대) | 50%↓ |
| 에러율 | 13.25% | 0% | 100%↓ |
| 총 요청 수(20분) | 21,120 | 41,873 | 2배↑ |

**4) 변경 전파 구조 재설계: dual-write 제거.** 게시글 저장 후 검색 인덱스를 바로 갱신하고 캐시까지 직접 무효화하는 dual-write는 partial failure 시 정합성이 쉽게 흔들렸습니다. 먼저 애플리케이션 내부 비동기 이벤트로 전환해 게시글 생성 지연을 5,315ms → 33ms로 줄였지만, 이 방식은 애플리케이션을 통하지 않는 DB 변경을 반영할 수 없었습니다. 그래서 Kafka와 CDC를 선택한 이유는 처리량이 아니라 **correctness와 replay 가능성** 때문이었습니다. DB에 기록된 변경 사실을 기준으로 검색 인덱스와 캐시가 각자 독립적으로 소비하도록 바꿨고, Kafka는 변경 이벤트를 보관·재생할 수 있는 공용 로그 역할을 맡았습니다. 단일 브로커 제약 때문에 Kafka 장애 시에는 애플리케이션 내부 비동기 이벤트로 자동 전환되도록 설계했습니다.

![CDC 파이프라인](/uploads/project/WikiEngine/cdc/cdc-pipeline-overview.svg)

**5) Redis 워크로드 분리.** 한 인스턴스에 자동완성 추천 결과(배치 갱신), 일반 캐시(TTL), 조회수 카운터(고빈도 증가), 토큰 블랙리스트(유실 불가 보안 데이터)가 섞여 있었습니다. 조회수 배치 중 전체 키를 훑는 명령이 Redis 내부 블로킹을 일으켜 실시간 GET/INCR도 함께 대기했습니다. 전체 스캔 안티패턴을 커서 기반 순회(SCAN)로 바꿔 블로킹을 없애고, 목적별로 분리해 배치성 쓰기·실시간 요청·보안 데이터를 같은 공간에 두지 않도록 했습니다.

![Consistent Hashing 링](/uploads/project/WikiEngine/redis-sharding/consistent-hashing-ring.svg)

| 용도 | 키 패턴 | 특성 |
|------|---------|------|
| 자동완성 KV | `prefix:v{version}:{prefix}` | 배치 캐싱, TTL 2시간 |
| 게시글/검색 캐시(L2) | `post:{id}`, `search:{keyword}:{page}:{size}` | TTL 기반 |
| 조회수 카운터 | `post:views:{id}` | 30초 flush 후 삭제 |
| 토큰 블랙리스트 | `blacklist:{token}` | TTL = JWT 잔여시간 |

**검증.** 분산 아키텍처(2 App + MySQL Replication + Redis 3샤드 + Kafka CDC) 전환 후 k6 200 VU stress 테스트 결과 에러율 13.25% → 0.00%, 처리량 30 → 109 req/s, P95 2,300 → 190ms로 개선됐고 100 VU에서 P95 200ms로 SLA 300ms를 충족했습니다. 분산 전환은 단일 서버 한계를 크게 완화했지만 최종 병목은 여전히 App CPU라는 점을 확인한 단계였습니다.

### 4. 검색 품질: 동의어 + 오타 교정 + Snippet

검색 응답속도는 이미 충분했지만 세 가지 품질 한계가 남았습니다. (1) 동의어 미이해(`AI` 검색 시 `인공지능` 문서 누락), (2) 오타에 취약(`프로그래링` → 0건), (3) snippet이 문서 앞 150자만 잘라 검색어가 뒤쪽이면 왜 나왔는지 설명 못 함. 동의어는 인덱스 통계를 보존하고 운영 유연성도 확보할 수 있는 **DB 기반 쿼리 타임 확장**을 택했고, 오타는 기존 인덱스를 활용하는 `DirectSpellChecker`, snippet은 본문 전체 대신 `snippetSource` 500자 별도 저장 + `UnifiedHighlighter`로 해결했습니다.

![쿼리 이해 파이프라인](/uploads/project/WikiEngine/search-query-enhancement/query-understanding-flow.svg)

![동의어 확장 전](/uploads/project/WikiEngine/search-query-enhancement/phase18-before-search-ai.png)

![동의어 확장 후](/uploads/project/WikiEngine/search-query-enhancement/phase18-after-search-ai-synonym.png)

Nori 사용자 사전 158,539개를 적용해 복합어 보존도 개선했고, 필드·분석기 변경은 전체 재색인이 필요했기에 12,156,589건 데이터를 대상으로 Directory Swap + SearcherManager 재생성 기반의 **무중단 재색인** 구조도 함께 구축했습니다. 인덱스 크기는 약 42GB였습니다.

### 5. LTR 재랭킹: XGBoost LambdaMART

BM25 기반에 제목/본문 가중치와 일부 popularity 신호를 수동 부스팅하는 구조였지만, 최종 순위는 사람이 정한 선형 규칙에 의존했습니다. `자바` 검색에서 사용자는 프로그래밍 언어를 기대하지만 `자바 더 헛` 같은 문서가 위에 노출되고 프로그래밍 언어 문서는 4위까지 밀렸습니다. LambdaMART는 `titleLength`, `tagOverlap`, `bm25Title` 같은 피처의 interaction을 학습할 수 있어 적합했습니다.

![랭킹 미스매치](/uploads/project/WikiEngine/search-ltr-ranking/ranking-mismatch.svg)

학습 데이터가 문제였습니다. 트래픽이 거의 없어 클릭 로그가 부족했기에 cold start에서는 **LLM-as-a-Judge**로 라벨을 부트스트랩했습니다. 검색어 45개의 BM25 Top-20에 대해 900개 `(query, doc)` 쌍을 만들고 같은 쌍을 3회 평가해 평균을 냈습니다. 첫 실행 성공률은 2%였는데 rate limit과 실패 감지 구조 문제였고, 요청 간격 조정·지수 백오프·CSV 즉시 기록·resume 구조를 적용해 다시 수집했습니다.

![LTR 재랭킹 전 (자바)](/uploads/project/WikiEngine/search-ltr-ranking/phase19-ltr-before-java-frontend.png)

![LTR 재랭킹 후 (자바)](/uploads/project/WikiEngine/search-ltr-ranking/phase19-ltr-after-java-frontend.png)

품질은 분명히 개선됐습니다. BM25 baseline NDCG@10 0.6910, LambdaMART 5-Fold CV NDCG@10 0.7387(+4.8%p). `자바`도 프로그래밍 언어가 1위로 올라왔습니다. **하지만 운영 테스트에서는 다른 결론이 나왔습니다.** 2코어 ARM에서 LTR를 켠 채 100 VU 부하를 주면 전체 평균 응답시간 42.81ms → 3,088ms, 검색 29.18ms → 8,826ms로 급격히 악화됐습니다. 문서당 14개 피처를 Top-200에 대해 추출하는 과정이 CPU를 과도하게 소모했기 때문입니다. 실제 운영에서는 `LTR_ENABLED=false`로 비활성화했고, 검색 품질 개선 가능성을 데이터로 검증하는 동시에 현재 인프라에서는 그 비용을 감당할 수 없다는 사실까지 확인한 단계였습니다.

### 6. 카테고리 자동 분류 + Facet 네이티브 전환

기존 카테고리는 위키 namespace 기반이라 약 97% 문서가 한 카테고리에 몰려 Facet으로서 탐색 가치가 거의 없었고, DB GROUP BY 기반 집계는 근사 집계라 실제 매칭 문서 분포를 정확히 반영하지 못했습니다. namespace 분류 대신 컴퓨터 과학·수학·물리학·역사·음악·게임·스포츠 등 **28개 주제 카테고리로 자동 분류**(90건 수동 검증 기준 약 83% 정확도)하고, 카테고리 필터와 Facet 집계를 모두 Lucene 내부로 옮겨 같은 검색 패스에서 계산되도록 정리했습니다. 216만 건 고카디널리티 태그는 Facet 비용·UI 복잡도만 키운다고 판단해 인덱싱 용도로만 활용했습니다.

![카테고리 필터 적용 후](/uploads/project/WikiEngine/search-category-facet/phase17-after-category-filter-search.png)

### 7. 콘텐츠 필터링: 운영 안전장치

게시글 작성 시 유해 콘텐츠 검사가 없어 어떤 문자열이든 저장됐고, 이것이 검색 결과·자동완성 후보까지 오염시켰습니다. `String.contains()` 순회는 금칙어가 수만 개로 늘면 비용이 선형 증가하기에, 여러 패턴을 한 번의 텍스트 순회로 동시 탐지하는 **Aho-Corasick**(O(N+Z))을 선택했습니다. 한국어는 부분 일치만으로 문제 표현이 될 수 있어 영어(단어 경계)와 다른 기준으로 처리했습니다. 금칙어 게시글은 즉시 삭제 대신 `blinded` 상태로 관리(검색 제외하되 복원 가능)했고, 앱 기동 직후 빈 결과는 짧은 TTL로만 캐시해 cache penetration을 막았습니다.

![금칙어 자동완성 차단](/uploads/project/WikiEngine/search-content-filter/phase20-autocomplete-banned-babo.png)

### 8. AI 검색 요약: RAG 파이프라인

검색 결과는 보여줄 수 있었지만 사용자는 여러 게시글을 직접 클릭해 읽어야 답을 얻었습니다. 기존 AI 요약은 검색 문서를 컨텍스트로 주지 않고 쿼리만 LLM에 전달해 답변이 실제 결과와 어긋날 수 있었고 출처도 붙일 수 없었습니다. 검색 결과를 그대로 LLM 입력 컨텍스트로 연결하는 **RAG 파이프라인**(쿼리 정제 → Lucene BM25 검색 → 상위 5개 문서 컨텍스트 → LLM 답변 → SSE 스트리밍)을 구성했습니다.

![RAG 파이프라인](/uploads/project/WikiEngine/search-rag/rag-pipeline-simple.svg)

Retrieval은 기술 용어·개념 중심 키워드 검색 패턴과 이미 적용된 동의어 확장을 고려해 기존 BM25를 그대로 사용했습니다. 네비게이션·거래 의도 쿼리는 AI 요약을 생략해 비용·안전성을 확보하고, 동일 쿼리 캐시(30분)와 전역 RPM 제한을 걸었습니다. 할루시네이션 방지를 위해 시스템 프롬프트에 제공 문서만 참고하도록 제한하고 `[문서 N]` 형태의 인라인 인용을 강제했으며, 검색 품질이 낮으면 AI 요약 자체를 건너뛰도록 했습니다.

![AI 요약 + 출처 인용](/uploads/project/WikiEngine/search-rag/ai-summary-full-with-results.png)

### 9. 실패와 교훈

**1) LTR 활성화 시 성능 72배 악화.** 오프라인 NDCG@10 +4.8%p였지만 2코어 ARM·100 VU에서 전체 평균 42.81ms → 3,088ms, 검색 29.18ms → 8,826ms. rescore window=200 기준 문서당 14개 피처 추출이 CPU 집약적이라 App CPU 최대 160%, Load Average 60까지 치솟았습니다. **기능 검증과 프로덕션 적용은 별개**였고, 피처를 인덱스 타임에 미리 계산하거나 전용 서버에서 처리해야 한다는 결론을 내렸습니다.

**2) LLM 학습 데이터 생성 98% 실패.** 3회 호출 + 2초 딜레이가 분당 ~30요청을 만들어 Gemini 15 RPM 제한을 초과했고, Spring AI 기본 retry는 HTTP 429를 재시도하지 않았으며 데이터를 메모리에만 쌓아 성공/실패를 구분하지 못했습니다. 요청 간격 조정·지수 백오프·CSV append+flush·status API·resume를 추가해 crash-safe 수집 파이프라인으로 개선했습니다. **외부 API 연동에서는 rate limit 계산·실패 감지·복구 가능성이 기능 자체만큼 중요**했습니다.

**3) CDC 배포 후 검색 미반영.** DB에는 저장됐지만 검색 인덱스에 반영되지 않았습니다. 멀티 인스턴스에서 CDC Consumer와 Lucene IndexWriter 위치가 어긋나, 이벤트를 받은 App 2는 Lucene replica라 인덱싱을 못 했고 App 1은 Kafka 연결 환경변수 누락으로 이벤트 자체를 못 받았습니다. **분산 환경에서 embedded 인덱스는 Consumer와 Writer 위치를 일관되게 보장하기 어렵고, CDC는 수신부터 인덱스 반영까지 end-to-end로 검증해야 한다**는 점, 그리고 왜 검색 인덱스를 애플리케이션에 embedded하지 않는지를 실제로 체감했습니다.

### 최종 아키텍처 + 핵심 수치

**검색 성능 (k6 부하 테스트 실측)**

| | Before | After | 측정조건 |
|------|------|------|------|
| 본문 검색 | LIKE 타임아웃(5,000ms+) | Lucene BM25 29ms (P95 100ms) | EXPLAIN rows=27,443,742 |
| B-Tree 자동완성 | LIKE 타임아웃(5,000ms+) | 8ms | 복합 인덱스 idx_title_viewcount |
| FULLTEXT ngram | 12,766ms | 8ms | 57만건, 인덱스 6.7GB |
| Redis 자동완성 | Trie DFS 5ms | Redis GET 11ms (P95 68ms) | flat KV O(1), 5,000 prefix 키 |
| 캐시 전체 응답 | 776ms | 54ms (14.4배) | Caffeine 99.9% 히트 |
| L1+L2 히트율 | 0%(캐시 없음) | 82% (L1 73% + L2 9%) | Origin 도달률 19% |
| Redis 메모리 | - | 73MB / 256MB (28.4%) | Eviction 0, Lettuce P95 2.5ms |

**분산 아키텍처 (k6 stress 200 VU, 25분)**

| | 단일 서버 | 분산(2 App) | 변화 |
|------|------|------|------|
| 에러율(쿼리) | 32.53%(COUNT* 타임아웃) | 0% | Page → Slice 전환 |
| 에러율(100VU) | 13.25% | 0% | 스케일 아웃 효과 |
| 에러율(200VU) | - | 0.09% | MySQL/Redis/Kafka 여유 |
| 평균 응답(100VU) | 482ms | 37ms (92%↓) | Nginx least_conn + App 2대 |
| P95(100VU) | 2,300ms | 190ms (12배) | SLA 300ms 충족 |
| 처리량 | ~30 req/s | 109 req/s (3.6배) | 피크 기준 |
| 상세 조회 에러 | 11.10%(DB UPDATE 충돌) | 0% (Redis INCR) | Write-Behind 30초 배치 |
| 게시글 생성 | 5,315ms (dual-write) | 33ms (CDC, 160배) | Debezium+Kafka |

**검색 품질**

| | Before | After | |
|------|------|------|------|
| P@10 | 0.827 | 0.853 | PhraseQuery(slop=2) + FeatureField |
| NDCG@10 | 0.6910 | 0.7387 (+4.8%p) | XGBoost LambdaMART 14피처 (5-Fold CV) |
| AI 검색 | 영문 AI 문서만 | '인공지능' 1위 | DB 동의어 쿼리 타임 확장 |
| 오타 교정 | 결과 0건 | '프로그래밍' 제안 | DirectSpellChecker 편집거리 2 |
| Snippet | 앞 150자(무관) | 검색어 주변 맥락 | UnifiedHighlighter 500자 StoredField |
| Facet | 없음 | 30개 카테고리 집계 | SortedSetDocValuesFacetCounts |
| 카테고리 분류 | Namespace(97% 편중) | 28개 주제별(83% 정확도) | 키워드 배치 분류, 90건 검증 |
| 금칙어 | 없음 | 16,090(KO 3,904+EN 12,996) | Aho-Corasick O(N+Z) |
| AI요약 | 없음 | RAG + SSE + 출처 링크 | Gemini 15 RPM, 캐시 30분 TTL |
| LTR ON 한계 | - | 3,088ms(72배 악화) | 2코어 ARM CPU 포화 → OFF |

**인프라 규모**: Lucene 42GB(5seg), 재색인 ~2h, Nori 158,539, Redis 3노드(4,620키), HikariCP 5+15, Kafka KRaft+DLQ

---

## 3. Balruno: 실시간 협업 워크스페이스

1인 오픈소스 SaaS (클라이언트 MIT, 백엔드 AGPL v3)

- 깃허브: <https://github.com/dj258255/balruno>
- 후기: <https://dj258255.github.io/IT-Oasis/blog/project/balruno/balruno-retrospective/>
- 사이트: <https://balruno.com/>

### 프로젝트 개요

Balruno는 캐릭터 스탯, 무기 수치, 레벨 곡선, 드롭 확률처럼 게임 기획 데이터가 자연스럽게 쌓이는 스프레드시트와 문서를 함께 다루는 협업 도구입니다. 단순히 표를 편집하는 수준이 아니라, 여러 사용자가 동시에 수정해도 데이터가 어긋나지 않도록 동기화 구조를 설계하고, 실제 운영 가능한 배포·백업·모니터링 환경까지 직접 구축했습니다.

![게임 특화 시각화](/uploads/project/Balruno/game-design-tool-intro/game-specialized-visualization-created.png)

**사용 기술**

- Backend: Java 25, Spring Boot 4, Spring Security 7, Hibernate 7, Spring Modulith
- DB/Storage: PostgreSQL 18, JSONB, GIN, UUIDv7, Cloudflare R2
- Realtime: Spring WebSocket, Hocuspocus, yjs
- Frontend: Next.js 16, React 19, Electron 41, Tiptap
- Infra/DevOps: OCI Always Free, Ansible, Nginx, Cloudflare
- Observability/Test: Prometheus, Loki, Alloy, Grafana, InfluxDB, blackbox_exporter, k6, JUnit 5, Testcontainers

**맡은 역할**: (1) 백엔드 아키텍처 설계, (2) 실시간 동기화 구조 설계 및 구현, (3) DB 비교 실험 및 저장 구조 결정, (4) 배포·백업·모니터링 환경 구축, (5) 서비스 운영 및 성능 측정

### 문제를 어떻게 정의했는가

1. 작업 단위는 셀 1개가 아니라 시트 전체로 본다.
2. 사용자는 미리 정해진 스키마 없이 16종 동적 컬럼을 고른다.
3. 같은 셀이나 트리 노드를 동시에 수정해도 데이터 손실이 없어야 한다.
4. 게임 기획에 필요한 70여 개 함수와 CSV / C# export까지 한 흐름으로 이어져야 한다.
5. 사용자 100명까지는 단일 인스턴스로 버티고, 시트 GET p95는 200ms 이하를 목표로 둔다.
6. 데이터의 기준은 항상 서버 DB로 두고, 로컬 저장소는 반응 속도를 위한 캐시로만 쓴다.
7. 초반에는 무료 인프라 + 단계적 확장만 허용한다.

이 기준을 세운 뒤에는 기술 이름보다 구조를 먼저 판단했습니다. (1) 시트와 문서를 같은 방식으로 동기화할지/나눌지, (2) 시트를 정규화할지 JSON 기반으로 받을지, (3) 온프레미스·매니지드·무료 인프라 중 무엇으로 시작할지. 이 세 갈래가 Balruno 전체 방향을 거의 결정했습니다.

### 데이터 영역

| 영역 | 위치 | 변경 빈도 | 충돌 빈도 | 처리 방식 |
|------|------|------|------|------|
| 시트 셀 | `Projects.data` JSONB 안 `sheets[].rows[].cells[]` | 매우 높음 | 중간 | 서버 기준 부분 수정 |
| 시트 트리 | `Projects.sheet_tree` JSONB | 중간 | 낮음 | 서버 기준 트리 변경 |
| 문서 트리 | `Projects.doc_tree` JSONB | 중간 | 낮음 | 서버 기준 트리 변경 |
| 문서 본문 | `Documents.binary` BYTEA(yjs) | 매우 높음 | 자동 머지 | Yjs + Hocuspocus |

### 핵심 설계와 구현

**1) 스프레드시트 도메인에 맞는 DB를 직접 비교하고 선택.** 스프레드시트는 통째 조회와 부분 수정이 모두 많고 컬럼도 고정되지 않았습니다. 정규화 모델, MySQL JSON, PostgreSQL JSONB, MongoDB를 같은 CRUD API와 같은 부하 조건(50,000 시트 / 50 VU / 5분)에서 직접 비교했습니다.

| 항목 | PostgreSQL JSONB | MySQL JSON | MongoDB |
|------|------|------|------|
| 시트 GET p95 | 16ms | 25ms | 45ms |
| Name UPDATE p95 | 40ms | 63ms | 37ms |

쓰기만 보면 MongoDB가 조금 빨랐지만 차이는 크지 않았고, 읽기 성능은 PostgreSQL이 더 안정적으로 앞섰습니다. 한정된 인프라에서 DB를 둘로 나누지 않고 하나로 운영하는 편이 단순하다고 판단해 PostgreSQL JSONB를 선택했습니다.

**2) 시트와 문서를 도메인에 맞게 나눠 설계.** 둘 다 실시간 공동 편집이 필요했지만 충돌 처리 방식이 달랐습니다. 시트는 값과 구조를 서버가 확실히 판단해야 했고(서버 기준 구조), 문서 본문은 글자 단위 자동 병합이 자연스러워 Hocuspocus + yjs를 사용했습니다.

**3) WebSocket을 프로젝트 단위로 통합.** 처음에는 시트마다 WebSocket을 따로 열었지만 여러 시트를 동시에 보면 연결 수가 그대로 늘었습니다. `/ws/projects/{projectId}` 단일 엔드포인트로 바꾸고 시트 셀·시트 트리·문서 트리를 같은 연결에서 처리하도록 통합했습니다. 모든 메시지에 (1) 클라이언트가 보고 있던 현재 버전, (2) 요청을 구분하는 클라이언트 메시지 ID를 함께 넣어, 서버는 늦게 도착한 변경은 거절하고 같은 요청이 다시 와도 두 번 반영되지 않도록 처리했습니다.

![셀 입력 동기화](/uploads/project/Balruno/cell-input-sync/cover.svg)

**4) 기존 nginx 자산을 살리면서 무중단 배포 구조 직접 구축.** 기존 `docker compose pull && up -d`는 배포마다 30~60초 502가 발생했습니다. Kubernetes·Kamal·nginx 직접 구성을 비교한 끝에, 기존 nginx + Ansible + Cloudflare 자산을 그대로 살릴 수 있는 nginx 기반 blue/green 배포를 직접 구성했습니다.

| 항목 | 결과 |
|------|------|
| 기존 방식 | 배포마다 30~60초 502 |
| 첫 전환 | 21초 이하 |
| 두 번째 배포부터 | 관측 범위에서 502 0건 |

### 결과

1. PostgreSQL JSONB 선택: 시트 GET p95 16ms, Name UPDATE p95 40ms
2. 시트 도메인 100% 서버 기준 구조 전환
3. 시트 영역 약 80,000라인 정리
4. 프로젝트 단위 WebSocket 통합
5. nginx blue/green 배포 직접 구축
6. 실제 운영 가능한 백업·모니터링 환경 구성

![Balruno MVP - 밸런스 분석](/uploads/project/Balruno/balruno-mvp-release/balance-analysis-1.png)

![Balruno MVP - 전투 시뮬레이션](/uploads/project/Balruno/balruno-mvp-release/combat-simulation-1.png)

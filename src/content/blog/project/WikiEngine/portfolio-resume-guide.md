---
title: '위키 검색엔진 — 이력서·포트폴리오 작성 가이드'
titleEn: 'Wiki Search Engine — Resume & Portfolio Writing Guide'
description: 위키 검색엔진 프로젝트의 모든 경험을 이력서와 포트폴리오에 효과적으로 녹이는 방법을 정리합니다. STAR 기법 기반 문장 템플릿, 면접 대비 질문, 기술 키워드를 포함합니다.
descriptionEn: A comprehensive guide for converting all WikiEngine project experiences into effective resume and portfolio entries.
date: 2026-03-15T00:00:00.000Z
tags:
  - Resume
  - Portfolio
  - Career
category: project/WikiEngine
draft: true
series: "WikiEngine"
---

> **이 문서는 비공개(draft)입니다.** 이력서·포트폴리오 작성 시 참고용으로만 사용합니다.

---

## 작성 원칙

### 면접관은 30초 안에 판단한다

실무자는 이력서를 평균 30초 이내로 스캔합니다. 핵심 정보가 첫 2~3줄에 없으면 다음 이력서로 넘어갑니다.

**절대 하지 말 것:**
- "성능을 개선했습니다" — 얼마나? 뭐가? 왜?
- "Lucene을 적용했습니다" — 왜? 다른 선택지는?
- "캐싱을 도입했습니다" — 뭘? 어떤 근거로?
- 기술 스택 나열만 하기 — "Java, Spring Boot, MySQL, Lucene"만으로는 아무것도 증명 안 됨

**반드시 할 것:**
- 모든 문장에 **수치(Before/After)**를 포함
- "왜 그 선택을 했는지" 한 줄이라도 근거
- 읽는 사람이 "그래서?"를 던질 틈이 없도록
- 행동 동사(action verb)로 시작: "분석했다", "진단했다", "설계했다", "측정했다"

> 출처: [Resume Worded — Backend Developer Resume Examples](https://resumeworded.com/backend-developer-resume-example), [우아한형제들 기술블로그 — 왕초보 신입 개발자의 우당탕탕 이력서 작성기](https://techblog.woowahan.com/11998/)

### STAR 기법을 압축한다

이력서에는 STAR(Situation-Task-Action-Result)를 **2~4줄로 압축**합니다. 블로그 포스트처럼 장문으로 쓰면 안 됨. 포트폴리오에서 상세 링크를 걸어 깊이를 보여줍니다.

```
[상황 + 문제] 한 줄 — 수치로 문제의 심각성을 보여줌
[원인 분석] 한 줄 — "왜"를 짚어서 분석 능력을 보여줌
[해결] 한 줄 — 대안 비교가 있으면 가산점
[결과] 한 줄 — Before/After 수치, 정량적
```

> 출처: [개발자 이력서, STAR 기법으로 성과를 빛내세요!](https://dataengineeringstoic.co.kr/entry/%EA%B0%9C%EB%B0%9C%EC%9E%90-%EC%9D%B4%EB%A0%A5%EC%84%9C-STAR-%EA%B8%B0%EB%B2%95%EC%9C%BC%EB%A1%9C-%EC%84%B1%EA%B3%BC%EB%A5%BC-%EB%B9%9B%EB%82%B4%EC%84%B8%EC%9A%94), [Teal — Junior Backend Developer Resume Example](https://www.tealhq.com/resume-example/junior-backend-developer)

---

## 프로젝트 한 줄 소개

### 이력서용 (1줄)

> 1,215만 건 위키 데이터 기반 커뮤니티 검색엔진 — LIKE → B-Tree → FULLTEXT ngram → Lucene 단계적 전환으로 시스템 마비 상태에서 P95 119ms, 에러율 0%까지 개선

### 포트폴리오용 (3줄)

> 나무위키 + 위키피디아 덤프 데이터 1,215만 건을 MySQL에 적재하고, 실제 커뮤니티 수준의 트래픽을 감당하는 검색엔진을 구축한 프로젝트. 가장 느린 상태(LIKE Full Table Scan → 시스템 마비)에서 시작하여, 각 단계에서 병목을 수치로 증명하고 기술의 한계가 드러나는 시점에 다음 기술로 전환하는 과정을 기록했다. k6 부하 테스트(100 VU, 20분) + Grafana 모니터링으로 모든 최적화의 Before/After를 실측했다.

---

## 핵심 경험별 이력서 문장

> 아래 각 경험은 **이력서용(압축 2~4줄)**과 **포트폴리오용(상세 5~10줄)**을 모두 제공합니다.
> 이력서에는 압축 버전을, 포트폴리오에는 상세 버전 + 블로그 링크를 사용합니다.

---

### 경험 1: 시스템 장애 대응 — 검색 한 번에 전체 API 마비

**블로그:** [검색엔진이 시스템을 마비시킨 과정과 대응](/blog/project/wikiengine/search-system-crash)

#### 이력서용 (3줄)

> `LIKE '%keyword%'` 검색이 1,215만 행 Full Table Scan을 유발하여 HikariCP 커넥션 풀(10개)을 고갈시키고, 검색 외 전체 API가 503을 반환하는 cascade failure를 발견했다. EXPLAIN으로 원인을 특정(type=ALL, rows=27,443,742)한 뒤, content LONGTEXT 검색 제거 + @Transactional(timeout=5) + HikariCP fail-fast(connectionTimeout 30초→3초) 긴급 조치로 검색 외 API의 가용성을 즉시 복구했다.

#### 포트폴리오용 (상세)

> **상황:** 1,215만 건 위키 데이터가 적재된 MySQL에서 `LIKE '%keyword%'` 검색 API를 호출하자, 검색뿐 아니라 게시글 목록·상세 조회 등 **전혀 무관한 API까지 503을 반환**하며 서버 전체가 마비되었다.
>
> **원인 분석:** EXPLAIN으로 확인한 결과 `type=ALL`, `rows=27,443,742` — 인덱스 없이 전체 행을 순차 스캔하고 있었다. `content` 컬럼이 LONGTEXT(평균 6,586자)이므로 행마다 수 KB~수십 KB를 메모리에 로드하여 패턴 매칭하면서, 쿼리 하나가 수십 초간 커넥션을 점유했다. HikariCP `maximumPoolSize=10`이 소진되면서 **모든 API가 커넥션을 얻지 못해 연쇄 타임아웃**이 발생한 것이 핵심이었다.
>
> **긴급 조치 (4가지):**
> 1. content LIKE 제거 → 행당 비교 데이터 수 KB → 수십 바이트로 감소
> 2. `@Transactional(readOnly=true, timeout=5)` → 5초 초과 쿼리 강제 종료
> 3. HikariCP `connectionTimeout` 30초 → 3초 (fail-fast) → 큐 적체 방지
> 4. `QueryTimeoutException` 전용 예외 처리 → 사용자에게 명확한 에러 메시지 반환
>
> **결과:** 검색 자체의 성능 문제는 미해결이지만, **검색 외 API의 가용성을 즉시 복구**했다. 이후 B-Tree → FULLTEXT ngram → Lucene 단계적 전환의 출발점이 되었다.

#### 이 경험이 증명하는 것

| 역량 | 증거 |
|------|------|
| 장애 진단 | EXPLAIN으로 Full Table Scan 특정, 커넥션 풀 고갈 연쇄 장애 패턴 인식 |
| 긴급 대응 | 근본 해결 전 시스템 안정성 먼저 확보하는 판단 |
| 우선순위 | "검색 성능"과 "시스템 가용성"을 분리하여 가용성 우선 처리 |

#### 면접 대비 질문

- "커넥션 풀 사이즈를 20으로 늘리면 안 되나요?" → 근본 해결이 아닌 증상 완화. Full Table Scan이 해결 안 되면 20개도 소진됨
- "검색 전용 커넥션 풀 분리는 검토했나요?" → Bulkhead 패턴. 유효하지만 긴급 상황에서는 설정 변경이 더 빠름
- "fail-fast 3초가 너무 공격적이지 않나요?" → 정상 쿼리는 ms 단위. 3초 걸리는 쿼리는 이미 비정상

---

### 경험 2: MySQL 검색 한계 분석 → Lucene 전환 결정

**블로그:** [FULLTEXT ngram 인덱스](/blog/project/wikiengine/fulltext-ngram-index) + [MySQL 검색을 버리고 Lucene을 선택한 이유](/blog/project/wikiengine/lucene-decision)

#### 이력서용 (4줄)

> MySQL FULLTEXT ngram으로 57만 건 한국어 검색을 12초→6ms(2,100배)로 복구했으나, 3가지 구조적 한계를 발견했다: (1) 고빈도 2-gram 토큰("대한")이 19.6만 건 포스팅 리스트를 순차 탐색하여 5초+ 타임아웃(InnoDB FTS ib_vector_t — MySQL Bug #85880), (2) 1,477만 건 전체 인덱스 300GB+ 디스크 초과(Row-Oriented 구조 한계), (3) 단어 경계 미보존 false positive. Lucene/Elasticsearch/벡터DB를 서버 비용 + CDC + 인건비까지 비교하고, 단일 서버에서 임베디드 Lucene + Nori 형태소 분석기를 선택하여 고빈도 토큰 타임아웃→12ms 해소, 전체 1,215만 건 검색 가능, false positive 제거를 달성했다.

#### 포트폴리오용 (상세)

> **상황:** LIKE 검색의 대안으로 MySQL FULLTEXT ngram 인덱스를 적용하여 57만 건 한국어 데이터에서 검색이 동작하게 만들었다(12초→6ms). 하지만 "동작한다"와 "쓸 수 있다"는 달랐다.
>
> **문제 3가지:**
> 1. **고빈도 토큰 타임아웃:** "대한"을 검색하면 19.6만 건의 포스팅 리스트를 순차 탐색하여 5초+ 타임아웃. MySQL 소스코드(`fts0que.cc`)를 분석한 결과, 교집합 단계에서 RB-tree를 쓰지만 **구절 검증 단계에서 `ib_vector_t`(동적 배열) 순차 탐색**이 병목이었다. [MySQL Bug #85880](https://bugs.mysql.com/bug.php?id=85880)에서 보고자가 75만 배 개선 패치를 제안했으나 Oracle이 9년간 미merge.
> 2. **인덱스 크기 폭발:** 1,477만 건 전체에 ngram 인덱스 생성 시 300GB+ 필요. Row-Oriented 구조에서 content 컬럼만 읽을 수 없어 122GB 전체를 스캔해야 하는 구조적 한계.
> 3. **false positive:** "한국어" 검색 시 "대한국제공항"이 매칭. 2-gram이 단어 경계를 보존하지 않기 때문.
>
> **대안 비교 (비용 관점):**
>
> | 기술 | 서버 비용 (월) | CDC 비용 | 합계 |
> |------|-------------|---------|------|
> | 임베디드 Lucene | $44~87 | 불필요 | **$44~87** |
> | ES 자체 호스팅 | $87~174 | $80~339 | $167~513 |
> | AWS OpenSearch (프로덕션) | $455 | $339 | $794 |
>
> ES의 장점(Replica 자동 승격, Alias 무중단 교체, 모니터링)을 알면서도, **분산이 필요 없는 단일 서버 + 1,477만 건 규모**에서 분산 레이어에 RAM을 쓰는 것은 낭비라고 판단. Source of Truth가 MySQL이므로 인덱스 유실 시 재구축 가능.
>
> **결과:**
> - "대한" 검색: 5초+ 타임아웃 → **12ms**
> - 검색 대상: 57만 건(한국어만) → **1,215만 건(전체)**
> - 인덱스 크기: 6.7GB(57만 건) → 29GB(1,215만 건) — ngram 대비 4.3배 감소
> - false positive: "대한국제공항" 매칭 → **매칭 안 됨** (Nori 형태소 분석)
> - 추가 인프라 비용: **$0** (기존 서버에 내장)

#### 이 경험이 증명하는 것

| 역량 | 증거 |
|------|------|
| 탐구심 | MySQL 소스코드(fts0que.cc)까지 파고들어 한계의 구조적 원인 특정 |
| 기술 결정 | ES의 장점을 정직하게 인정하면서도, 현 요구사항에서 Lucene이 합리적인 근거를 비용까지 포함해 제시 |
| 비용 감각 | "서버 비용이 아니라 인건비가 진짜 비용"이라는 비용 구조 이해 |

#### 면접 대비 질문

- "ES의 장점을 이렇게 많이 알면서 왜 Lucene?" → 분산 불필요 + 단일 서버 12GB에서 ES 힙 8~16GB는 물리적 불가
- "처음부터 Lucene 쓸 수 있었던 거 아닌가요?" → ngram 단계에서 역색인 원리, IDF, BM25를 학습해야 Lucene을 제대로 쓸 수 있었다. 단계적 학습이 의도적
- "인덱스 손상 시 대응은?" → MySQL이 Source of Truth. 전체 재인덱싱(6시간 40분)으로 복구 가능
- "Lucene을 직접 쓴 기업이 있나요?" → Twitter(Earlybird), LinkedIn(Galene), Uber(Sia). 전부 ES로 해결 불가능한 극단적 요구사항 + 검색 전담 팀 보유

---

### 경험 3: OFFSET 페이지네이션 최적화 — 99.96% 개선

**블로그:** [Deferred Join 적용기](/blog/project/wikiengine/deferred-join-optimization) + [COUNT(*) 제거와 페이지 제한으로 19,424ms → 8ms](/blog/project/wikiengine/query-refactoring-optimization)

#### 이력서용 (4줄)

> k6 부하 테스트(100 VU, 20분)에서 최신 게시글 목록의 deep OFFSET이 CPU를 포화시켜 전체 API cascade failure(에러율 32.53%)를 유발했다. InnoDB Buffer Pool 히트율 100%인데 Slow Query 14.8K건으로 **CPU 병목**을 진단했다. Deferred Join(클러스터 I/O 20,020회→20회) + 30페이지 제한(OFFSET 20,000→580) + COUNT(*) 제거(Page→Slice, EXPLAIN ANALYZE 실측 2,038ms 완전 제거)를 조합하여 **19,424ms→8.33ms(-99.96%), 에러율 32.53%→0%**. Spring Data의 nativeQuery+Slice LIMIT 이중 적용 함정(DATAJPA-1464)을 GitHub 이슈까지 추적하여 List\<T\>+수동 SliceImpl 패턴으로 우회했다.

#### 포트폴리오용 (상세)

> **상황:** Lucene 검색 전환 후 k6 load 테스트를 최초 실행한 결과, **검색(66ms)이 아니라 최신 게시글 목록 조회(19,424ms)가 병목**이었다. 에러율 32.53%로 시스템이 무너졌다.
>
> **원인 분석:** k6 스크립트에서 30% 확률로 page=100~1000(OFFSET 최대 20,000)을 요청하는 조건이었다. `SELECT *` + deep OFFSET은 세컨더리 인덱스에서 PK를 획득한 뒤, 각 PK로 클러스터 인덱스에서 전체 행(LONGTEXT 포함)을 읽어야 한다. 20,000행 × ~13KB = ~260MB를 읽고 버리는 구조. InnoDB Buffer Pool 히트율이 100%인데 Slow Query가 14.8K건 — **메모리가 아닌 CPU가 병목**이었다.
>
> **해결 (3가지 조합):**
>
> | # | 조치 | 효과 |
> |---|------|------|
> | 1 | **Deferred Join** — 서브쿼리에서 `SELECT id`만 하여 Covering Index Scan, 외부에서 20개 PK만 클러스터 조회 | 클러스터 I/O 20,020회→20회 |
> | 2 | **30페이지 제한** — Google/네이버 기준. OFFSET 20,000→580 | worst-case 34배 축소 |
> | 3 | **COUNT(*) 제거** — Page\<T\>→Slice\<T\>. EXPLAIN ANALYZE로 COUNT(*) 단독 2,038ms 실측 | 매 요청 2,038ms 완전 제거 |
>
> Spring Data의 `nativeQuery=true` + `Slice<T>` 조합에서 Hibernate가 LIMIT을 이중 적용하는 함정([DATAJPA-1464](https://github.com/spring-projects/spring-data-jpa/issues/1782))을 발견. `List<T>` 반환 + 서비스에서 수동 `SliceImpl` 구성(LIMIT+1 패턴)으로 우회했다. Slack Engineering, Vlad Mihalcea(Hibernate 핵심 기여자)가 권장하는 검증된 패턴.
>
> **결과:**
> - 최신 게시글 목록: 19,424ms → **8.33ms** (-99.96%)
> - 검색: 3,328ms → **20.51ms** (-99.4%) — cascade failure 해소로 원래 속도 복귀
> - 에러율: 32.53% → **0.00%**
> - CPU: 100% 포화 → 35%
> - QPS: 50 → 300 (6배 증가)

#### 이 경험이 증명하는 것

| 역량 | 증거 |
|------|------|
| 진단 능력 | BP 100% + Slow Query 14.8K → "디스크가 아닌 CPU 병목" 진단 |
| 정직함 | Deferred Join "기대 40배 vs 현실 13%" — EXPLAIN으로 인덱스 스캔 85%임을 분석 |
| 프레임워크 이해 | Spring Data 내부 동작(Hibernate setMaxResults)을 GitHub 이슈까지 추적 |
| cascade failure | 단일 병목(deep OFFSET)이 전체 시스템을 무너뜨리는 패턴을 2번(여기 + 캐싱) 경험 |

#### 면접 대비 질문

- "Keyset Pagination은 왜 안 썼나요?" → 페이지 번호 UI에서 "N번째 페이지로 점프"가 불가능. 무한 스크롤 전환 시 재검토
- "Deferred Join이 기대만큼 안 빨랐던 이유?" → 전체 비용의 ~85%가 인덱스 스캔. LONGTEXT I/O는 ~15%
- "COUNT(*) 제거하면 프론트에서 총 페이지 수를 못 보여주는데?" → Google이 2024년에 결과 수 표시를 제거. hasNext로 충분

---

### 경험 4: Caffeine L1 캐시 — cascade failure 해소

**블로그:** [캐싱 전략 — Caffeine L1 로컬 캐시로 검색 응답 14배 개선](/blog/project/wikiengine/caching-strategy)

#### 이력서용 (3줄)

> 검색 품질 고도화(BM25 + FeatureField + RecencyDecay) 도입 후 복합 스코어링이 CPU를 포화시켜 100 VU에서 전체 API cascade failure 발생. Zipf 분포를 따르는 검색 트래픽 특성을 근거로 Caffeine L1 캐시를 도입하고, Redis/CDN과 비용·상황별 비교 후 단일 서버에서 비용 $0인 Caffeine을 선택했다. 전체 평균 776ms→54ms(14배), 검색 히트율 81.8%, CPU 80~100%→20~40%, cascade failure 완전 해소.

#### 포트폴리오용 (상세)

> **상황:** [검색 품질 고도화](/blog/project/wikiengine/search-quality)에서 BM25 + FeatureField(조회수·좋아요) + RecencyDecay(최신성) 복합 스코어링을 도입한 후, 검색이 20ms→1,443ms(70배)로 regression. 100 VU 부하에서 CPU 포화로 검색 외 API(자동완성 5ms→368ms, 목록 8ms→392ms)까지 연쇄 지연.
>
> **원인 분석:** 복합 스코어링에서 매칭 문서마다 DocValues 3회 읽기(viewCount, likeCount, createdAt)가 추가되어, Block-Max WAND 최적화가 제한됨. 고빈도 토큰("대한민국")에서 수만 건을 스코어링할 때 CPU 시간이 급증. 2코어 CPU가 포화되면서 모든 요청이 CPU 대기열에 갇힘.
>
> **대안 비교:**
>
> | 캐시 | 레이턴시 | 비용 | 적합 상황 |
> |------|---------|------|----------|
> | **Caffeine (L1)** | < 0.1ms | $0 | 단일 서버, 인기 검색어 캐싱 |
> | Redis (L2) | 0.5~2ms | $24,000+/년 | 다중 서버, 캐시 일관성 |
> | CDN (L3) | 5~50ms | $6,000+/년 | 전세계 사용자, 정적 콘텐츠 |
>
> **구현:** 검색 결과(TTL 5분, W-TinyLFU), 자동완성(TTL 10분), 게시글 상세(@CacheEvict 즉시 무효화). Cache-Control stale-while-revalidate 브라우저 캐싱. Actuator + Prometheus + Grafana 히트율 모니터링.
>
> **결과:**
> - 전체 평균: 776ms → **54ms** (14배)
> - 자동완성: 368ms → **4.67ms** (smoke 5VU 수준 복귀)
> - 검색 히트율: **81.8%**, 자동완성 히트율: **99.9%**
> - CPU: 80~100% → 20~40%, HikariCP Pending: 50 → 0
> - OOM 안전성: 4K/10K entries, TTL이 maximumSize보다 먼저 작동

#### 면접 대비 질문

- "Redis 대신 Caffeine을 선택한 이유?" → 단일 서버에서 네트워크 없이 마이크로초 응답. 서버 추가 시 Redis 도입
- "캐시 일관성은?" → 검색: TTL 5분(Google도 인덱스 갱신에 시간 걸림), 상세: @CacheEvict 즉시 무효화
- "Cache Stampede는?" → 부하 테스트에서 TTL 만료 시 영향 제한적 확인. refreshAfterWrite는 필요 시 추가

---

### 경험 5: 검색 품질 정량 평가

**블로그:** [검색 품질 고도화 — 구절 검색, 커뮤니티 랭킹, P@10/MAP 평가](/blog/project/wikiengine/search-quality)

#### 이력서용 (3줄)

> Nori 형태소 분석기의 복합명사 분해 차이를 흡수하는 PhraseQuery(slop=2) 구절 검색을 구현하고, Reddit/Stack Overflow/네이버 랭킹 알고리즘을 분석하여 BM25 + FeatureField(조회수·좋아요 saturation) + ExponentialDecay(반감기 30일) 커뮤니티 랭킹을 설계했다. 15개 테스트 쿼리로 P@10/MAP을 측정하여 검색 품질을 정량 평가하고, FeatureField 기반 인기도 부스트가 BM25 텍스트 관련성과 균형을 이루는 것을 검증했다.

#### 면접 대비 질문

- "P@10 +3.2%는 유의미한가요?" → 15개 쿼리 × 10개 결과 = 150개 판정에서 4~5개 차이. 통계적 유의성보다 "기존 품질 미훼손 + 소폭 개선 방향" 확인이 목적
- "가중치 3.0/2.0/5.0은 어떻게 결정?" → BM25 점수(5~15) 대비 부스트가 역전하지 않는 수준. 운영 데이터 축적 후 A/B 테스트로 재검증 필요

---

## 기술 역량 섹션 — 키워드 문장

이력서의 "기술 역량" 또는 "Skills" 섹션에 기술 스택을 나열하지 말고, **경험과 연결된 문장**으로 쓰세요.

| 영역 | 문장 |
|------|------|
| **DB 최적화** | EXPLAIN/EXPLAIN ANALYZE 기반 쿼리 진단, Deferred Join(Covering Index), Page→Slice COUNT(*) 제거, OFFSET 페이지 제한. 1,215만 건 테이블에서 19,424ms→8ms |
| **검색엔진** | MySQL FULLTEXT ngram 한계 분석(fts0que.cc 소스 수준) → Lucene 임베디드 + Nori 형태소 분석기 전환. BM25 + FeatureField 랭킹, PhraseQuery 구절 검색, P@10/MAP 정량 평가 |
| **캐싱** | Caffeine L1 W-TinyLFU, @CacheEvict 즉시 무효화, Cache-Control stale-while-revalidate, Actuator 히트율 모니터링. 검색 히트율 81.8%, cascade failure 해소 |
| **부하 테스트** | k6 smoke/load 프로필, InfluxDB+Grafana, 시나리오별 SLA. cascade failure 2회 진단(OFFSET CPU 포화, 복합 스코어링 CPU 포화) |
| **장애 대응** | HikariCP 커넥션 풀 고갈 → fail-fast 격리. InnoDB BP 100% + Slow Query 14.8K → CPU 병목 진단 |

---

## 프로젝트 기술 여정 — 시계열 요약

포트폴리오에 "이 프로젝트의 전체 흐름"을 보여줄 때 사용합니다.

| 순서 | 포스트 | 핵심 변화 |
|------|--------|----------|
| 1 | [검색엔진이 시스템을 마비시킨 과정과 대응](/blog/project/wikiengine/search-system-crash) | LIKE Full Table Scan → 시스템 마비 → 긴급 조치(타임아웃, fail-fast)로 가용성 확보 |
| 2 | [자동완성 B-Tree 인덱스 걸기](/blog/project/wikiengine/autocomplete-btree-index) | B-Tree 복합 인덱스 → 자동완성 해소 (>5,000ms → 8ms) |
| 3 | [FULLTEXT ngram 인덱스](/blog/project/wikiengine/fulltext-ngram-index) | 검색 동작 복구 (12초 → 6ms, 57만 건). 고빈도 토큰 타임아웃·300GB+ 인덱스·false positive 한계 발견. InnoDB FTS 소스코드(fts0que.cc) 수준 원인 분석 |
| 4 | [MySQL 검색을 버리고 Lucene을 선택한 이유](/blog/project/wikiengine/lucene-decision) | Lucene + Nori → 전체 1,215만 건 검색 (타임아웃 → 12ms). Lucene/ES/벡터DB 비용 비교 후 임베디드 Lucene 결정 |
| 5 | [Deferred Join 적용기](/blog/project/wikiengine/deferred-join-optimization) + [COUNT(*) 제거와 페이지 제한](/blog/project/wikiengine/query-refactoring-optimization) | 19,424ms → 8ms, 에러율 32.53% → 0%. cascade failure 진단: CPU 포화가 전체 API를 무너뜨림 |
| 6 | [검색 품질 고도화](/blog/project/wikiengine/search-quality) | 구절 검색 + 커뮤니티 랭킹 + P@10/MAP 정량 평가 |
| 7 | [캐싱 전략](/blog/project/wikiengine/caching-strategy) | Caffeine L1 캐시 → 전체 14배 개선, cascade failure 해소. 검색 히트율 81.8%, CPU 80%→20% |

---

## 이 프로젝트에서 면접관이 가장 깊이 물어볼 질문 TOP 10

| # | 질문 | 답변 핵심 |
|---|------|----------|
| 1 | "ES 대신 Lucene을 선택한 근거?" | 서버 RAM + CDC + 인건비 비교. 단일 서버 + 1,477만 건에서 분산 불필요 |
| 2 | "cascade failure가 뭐고, 어떻게 진단?" | BP 100% + Slow Query 14.8K → CPU 병목. deep OFFSET이 공유 CPU 독점 |
| 3 | "ngram이 고빈도 토큰에서 느린 이유?" | fts0que.cc ib_vector_t 순차 탐색. 2-gram "대한" 19.6만 건 선형 O(N) |
| 4 | "Deferred Join이 기대만큼 안 빨랐던 이유?" | 인덱스 스캔 ~85%, LONGTEXT I/O ~15%. 후자만 제거하여 13% |
| 5 | "캐시 일관성 어떻게 관리?" | 검색 TTL 5분, 상세 @CacheEvict 즉시, 자동완성 TTL 10분 |
| 6 | "COUNT(*) 제거하면 프론트에서 총 페이지 수를?" | Google 2024년 결과 수 제거. hasNext + 주변 페이지로 충분 |
| 7 | "Keyset Pagination은 왜 안 씀?" | 페이지 번호 UI에서 N번째 점프 불가. 무한 스크롤 전환 시 재검토 |
| 8 | "BM25 b=0.5로 바꾼 근거?" | 위키 문서 길이 편차 큼. 긴 문서 과도한 페널티 완화. A/B 테스트로 재검증 필요 |
| 9 | "인덱스 손상 시 대응?" | MySQL = Source of Truth. 전체 재인덱싱 6시간 40분으로 복구 |
| 10 | "이 프로젝트를 한마디로?" | "가장 느린 상태에서 시작하여 병목이 드러날 때마다 수치로 증명하고 전환한 과정" |

---

## 수치 요약 — 한눈에 보는 Before/After

| 지표 | 최초 상태 | 최종 상태 | 개선율 |
|------|---------|---------|--------|
| 검색 (고빈도 "대한") | 시스템 마비 (Full Table Scan) | **12ms** (Lucene + Nori) | 타임아웃 해소 |
| 최신 게시글 목록 (100 VU) | 19,424ms / 에러율 32.53% | **8.33ms / 에러율 0%** | **-99.96%** |
| 전체 평균 (100 VU, 캐시 후) | 776ms | **54ms** | **14배** |
| 검색 히트율 (Caffeine) | 0% (캐시 없음) | **81.8%** | — |
| CPU (100 VU) | 100% 포화 | **20~40%** | 60%p 감소 |
| 검색 대상 | 1,215만 건 (전체) | **1,215만 건 (전체)** | 25배 확대 |
| 인덱스 크기 | 300GB+ (생성 불가) | **29GB** (Lucene) | 생성 가능 |
| 추가 인프라 비용 | $0 | **$0** (Lucene 내장) | ES 대비 연 $3,036~$9,528 회피 |

---

## 참고 자료

**이력서 작성:**
- [Resume Worded — Backend Developer Resume Examples 2026](https://resumeworded.com/backend-developer-resume-example)
- [Teal — Junior Backend Developer Resume Example 2025](https://www.tealhq.com/resume-example/junior-backend-developer)
- [우아한형제들 기술블로그 — 왕초보 신입 개발자의 우당탕탕 이력서 작성기](https://techblog.woowahan.com/11998/)
- [개발자 이력서, STAR 기법으로 성과를 빛내세요!](https://dataengineeringstoic.co.kr/entry/%EA%B0%9C%EB%B0%9C%EC%9E%90-%EC%9D%B4%EB%A0%A5%EC%84%9C-STAR-%EA%B8%B0%EB%B2%95%EC%9C%BC%EB%A1%9C-%EC%84%B1%EA%B3%BC%EB%A5%BC-%EB%B9%9B%EB%82%B4%EC%84%B8%EC%9A%94)
- [GitHub — Awesome Resume Portfolio](https://github.com/codingmonster-tv/Awesome_Resume_Portfolio)
- [내일배움캠프 — 백엔드 포트폴리오 예시 모아보기](https://nbcamp.spartaclub.kr/blog/%EB%B0%B1%EC%97%94%EB%93%9C-%ED%8F%AC%ED%8A%B8%ED%8F%B4%EB%A6%AC%EC%98%A4-%EC%98%88%EC%8B%9C-%EB%AA%A8%EC%95%84%EB%B3%B4%EA%B8%B0-%EC%9E%91%EC%84%B1-%EA%BF%80%ED%8C%81%EA%B3%BC-8%EA%B0%9C-%ED%8F%AC%ED%8A%B8%ED%8F%B4%EB%A6%AC%EC%98%A4-%EA%B3%B5%EC%9C%A0--62754)

**이력서 액션 동사:**
- [Resume Worded — Software Engineering Action Verbs](https://resumeworded.com/software-engineer-resume-action-verbs)
- [Interview Kickstart — Software Engineering Resume Action Verbs](https://interviewkickstart.com/blogs/articles/action-verbs-software-engineering)

<!-- EN -->

> **This document is private (draft).** It is meant only as a reference when writing a resume / portfolio.

---

## Writing Principles

### Recruiters decide in 30 seconds

Practitioners scan a resume in about 30 seconds on average. If the key information is not in the first 2-3 lines, they move on.

**Never do:**
- "Improved performance" — by how much? what? why?
- "Adopted Lucene" — why? what were the alternatives?
- "Introduced caching" — what? on what basis?
- Just listing tech stacks — "Java, Spring Boot, MySQL, Lucene" alone proves nothing

**Always do:**
- Include **numbers (Before/After)** in every line
- One line of justification on *why* you chose what you chose
- Leave the reader no room to ask "so what?"
- Start with action verbs: "analyzed", "diagnosed", "designed", "measured"

> Sources: [Resume Worded — Backend Developer Resume Examples](https://resumeworded.com/backend-developer-resume-example), [Woowahan Tech Blog — A rookie dev's bumpy resume-writing journey](https://techblog.woowahan.com/11998/)

### Compress STAR

Resume lines compress STAR (Situation-Task-Action-Result) into **2-4 lines**. Do not write long paragraphs like a blog post. Use the portfolio with a deeper link to show depth.

```
[Situation + Problem] one line — show severity with numbers
[Root cause] one line — name the "why" to demonstrate analysis
[Solution] one line — bonus if you compared alternatives
[Result] one line — Before/After numbers, quantitative
```

> Sources: [Showcase your achievements with STAR — for developer resumes](https://dataengineeringstoic.co.kr/entry/%EA%B0%9C%EB%B0%9C%EC%9E%90-%EC%9D%B4%EB%A0%A5%EC%84%9C-STAR-%EA%B8%B0%EB%B2%95%EC%9C%BC%EB%A1%9C-%EC%84%B1%EA%B3%BC%EB%A5%BC-%EB%B9%9B%EB%82%B4%EC%84%B8%EC%9A%94), [Teal — Junior Backend Developer Resume Example](https://www.tealhq.com/resume-example/junior-backend-developer)

---

## Project One-Liner

### Resume version (1 line)

> A community search engine over 12.15M wiki documents — incrementally migrated LIKE → B-Tree → FULLTEXT ngram → Lucene, taking the system from full meltdown to P95 119ms with 0% error rate.

### Portfolio version (3 lines)

> Built a search engine over 12.15M docs from Namuwiki + Wikipedia dumps in MySQL, capable of handling community-grade traffic. Started from the slowest possible state (LIKE Full Table Scan → system meltdown) and documented each step where bottlenecks were proven with numbers and the next technology was adopted exactly when the current one's limit was exposed. Every Before/After was measured under k6 load tests (100 VU, 20 minutes) + Grafana monitoring.

---

## Resume Lines per Key Experience

> Each experience below provides both a **resume version (compressed 2-4 lines)** and a **portfolio version (5-10 lines + blog link)**.
> Use the compressed one in the resume, the detailed one + blog link in the portfolio.

---

### Experience 1: Incident Response — One Search Took Down the Entire API

**Blog:** [How a search engine paralyzed the system, and how we responded](/blog/project/wikiengine/search-system-crash)

#### Resume (3 lines)

> Discovered a cascade failure where `LIKE '%keyword%'` on 12.15M rows triggered a Full Table Scan, exhausted the HikariCP pool (10 conns) and made every non-search API return 503. After identifying the cause via EXPLAIN (`type=ALL, rows=27,443,742`), I immediately restored availability for non-search APIs through emergency mitigations: removed LIKE on the content LONGTEXT, set `@Transactional(timeout=5)`, and switched HikariCP to fail-fast (connectionTimeout 30s → 3s).

#### Portfolio (detailed)

> **Situation:** Calling the `LIKE '%keyword%'` search API on the MySQL with 12.15M wiki rows caused **completely unrelated APIs (post listing, post detail, etc.) to also return 503**. The whole server went down, not just search.
>
> **Root cause:** EXPLAIN showed `type=ALL`, `rows=27,443,742` — the entire table was being scanned without an index. Because `content` is LONGTEXT (~6,586 chars on average), each row had to load a few KB to tens of KB into memory for pattern matching, and a single query held the connection for tens of seconds. With HikariCP `maximumPoolSize=10` exhausted, **every API failed to acquire a connection and timed out in cascade.**
>
> **Emergency response (4 actions):**
> 1. Removed content LIKE → per-row comparison data went from KB-range to bytes
> 2. `@Transactional(readOnly=true, timeout=5)` → kill any query over 5 seconds
> 3. HikariCP `connectionTimeout` 30s → 3s (fail-fast) → prevent queue buildup
> 4. Dedicated `QueryTimeoutException` handler → return clear errors to clients
>
> **Result:** The search performance issue itself was unresolved, but **availability for non-search APIs was instantly restored.** This became the starting point for the staged migration B-Tree → FULLTEXT ngram → Lucene.

#### What this experience demonstrates

| Skill | Evidence |
|---|---|
| Incident diagnosis | Identified Full Table Scan via EXPLAIN; recognized connection-pool-exhaustion cascade pattern |
| Emergency response | Decided to secure system stability *before* root-cause fix |
| Prioritization | Separated "search performance" from "system availability"; treated availability first |

#### Interview prep

- "Why not just bump pool size to 20?" → Symptom relief, not a fix. If the Full Table Scan is unresolved, 20 will exhaust too.
- "Did you consider a separate pool for search?" → The Bulkhead pattern. Valid, but config changes are faster in an emergency.
- "Isn't 3-second fail-fast too aggressive?" → Normal queries are in the ms range. Anything taking 3 seconds is already abnormal.

---

### Experience 2: Analyzing MySQL Search Limits → Choosing Lucene

**Blog:** [FULLTEXT ngram index](/blog/project/wikiengine/fulltext-ngram-index) + [Why I dropped MySQL search and chose Lucene](/blog/project/wikiengine/lucene-decision)

#### Resume (4 lines)

> Restored 570K-row Korean search from 12s → 6ms (2,100×) with MySQL FULLTEXT ngram, but discovered three structural limits: (1) high-frequency 2-gram tokens (e.g., "대한") triggered linear scans over 196K-entry posting lists and timed out at 5s+ (InnoDB FTS `ib_vector_t` — MySQL Bug #85880); (2) full-corpus 14.77M index needed 300GB+ disk (row-oriented limitation); (3) false positives from broken word boundaries. Compared Lucene / Elasticsearch / vector DBs including server cost + CDC + headcount, chose embedded Lucene + Nori on a single server, eliminating high-frequency-token timeouts (5s+ → 12ms), enabling full 12.15M-doc search, and removing false positives.

#### Portfolio (detailed)

> **Situation:** As an alternative to LIKE, applied MySQL FULLTEXT ngram and got Korean search working on 570K rows (12s → 6ms). But "working" was different from "usable."
>
> **Three problems:**
> 1. **High-frequency token timeout:** searching "대한" linearly walked a 196K-entry posting list and hit 5s+ timeouts. Reading the MySQL source (`fts0que.cc`) showed that the intersection step uses an RB-tree, but the **phrase-verification step is bottlenecked by linear scans on `ib_vector_t` (a dynamic array)**. [MySQL Bug #85880](https://bugs.mysql.com/bug.php?id=85880) has a reporter-proposed 750,000× speedup patch that Oracle has not merged for 9 years.
> 2. **Index-size explosion:** Building the ngram index over the full 14.77M corpus would need 300GB+. The row-oriented layout cannot read just the content column — it scans the entire 122GB.
> 3. **False positives:** searching "한국어" matched "대한국제공항" because 2-gram does not preserve word boundaries.
>
> **Alternative comparison (cost view):**
>
> | Option | Server cost (mo) | CDC cost | Total |
> |---|---|---|---|
> | Embedded Lucene | $44-87 | none | **$44-87** |
> | Self-hosted ES | $87-174 | $80-339 | $167-513 |
> | AWS OpenSearch (prod) | $455 | $339 | $794 |
>
> Even knowing ES's strengths (auto replica promotion, alias-based zero-downtime swap, monitoring), I judged that **a single server + 14.77M-doc workload** does not need a distributed layer; spending RAM on it would be waste. MySQL is the source of truth, so the index can be rebuilt if lost.
>
> **Result:**
> - "대한" search: 5s+ timeout → **12ms**
> - Search corpus: 570K (Korean only) → **12.15M (full)**
> - Index size: 6.7GB (570K) → 29GB (12.15M) — 4.3× smaller relative to ngram
> - False positives: "대한국제공항" matched → **no longer matched** (Nori morphological analysis)
> - Extra infra cost: **$0** (embedded into the existing server)

#### What this experience demonstrates

| Skill | Evidence |
|---|---|
| Curiosity | Drilled down to MySQL source (`fts0que.cc`) to identify the structural cause of the limit |
| Tech decision | Honestly acknowledged ES's strengths, but argued why Lucene is the rational choice for current requirements — costs included |
| Cost sense | Understood that "server cost is not the real cost; headcount is" |

#### Interview prep

- "If you know ES's strengths so well, why Lucene?" → No need for distribution; ES heap of 8-16GB on a single 12GB server is physically impossible.
- "Couldn't you have used Lucene from day one?" → Going through the ngram phase was needed to learn inverted-index principles, IDF, and BM25 properly. Staged learning was deliberate.
- "What if the index is corrupted?" → MySQL is the source of truth. Recoverable via full reindex (6h 40m).
- "Any companies using Lucene directly?" → Twitter (Earlybird), LinkedIn (Galene), Uber (Sia). All have extreme requirements ES cannot satisfy + dedicated search teams.

---

### Experience 3: OFFSET Pagination Optimization — 99.96% Improvement

**Blog:** [Applying Deferred Join](/blog/project/wikiengine/deferred-join-optimization) + [Removing COUNT(*) and capping pages: 19,424ms → 8ms](/blog/project/wikiengine/query-refactoring-optimization)

#### Resume (4 lines)

> Under k6 load (100 VU, 20 min), deep OFFSET on the latest-posts list saturated CPU and triggered cascade failure across the entire API (32.53% error rate). With InnoDB Buffer Pool hit rate at 100% but 14.8K Slow Queries, diagnosed it as **CPU-bound**. Combined Deferred Join (cluster I/O 20,020 → 20), 30-page cap (OFFSET 20,000 → 580), and COUNT(*) removal (Page → Slice; EXPLAIN ANALYZE measured 2,038ms eliminated) for **19,424ms → 8.33ms (-99.96%), error rate 32.53% → 0%**. Worked around Spring Data's nativeQuery + Slice double-LIMIT trap (DATAJPA-1464) by tracking the GitHub issue and using a manual `List<T>` + `SliceImpl` pattern.

#### Portfolio (detailed)

> **Situation:** After migrating to Lucene, the first k6 load test showed the bottleneck was **not search (66ms) but the latest-posts list (19,424ms)**. Error rate 32.53% — the system collapsed.
>
> **Root cause:** The k6 script requested `page=100~1000` (OFFSET up to 20,000) 30% of the time. `SELECT *` + deep OFFSET reads the PK from the secondary index, then loads each full row (LONGTEXT included) from the cluster index. 20,000 rows × ~13KB = ~260MB read and discarded. InnoDB Buffer Pool hit rate was 100% but 14.8K Slow Queries — the bottleneck was **CPU, not memory.**
>
> **Solution (3 combined):**
>
> | # | Action | Effect |
> |---|---|---|
> | 1 | **Deferred Join** — `SELECT id` only in subquery for Covering Index Scan; outer reads only 20 PKs from the cluster | cluster I/O 20,020 → 20 |
> | 2 | **30-page cap** — Google/Naver standard. OFFSET 20,000 → 580 | worst-case 34× reduction |
> | 3 | **COUNT(*) removal** — Page → Slice. EXPLAIN ANALYZE showed COUNT(*) alone took 2,038ms | 2,038ms removed per request |
>
> Discovered Spring Data's `nativeQuery=true` + `Slice<T>` trap where Hibernate applies LIMIT twice ([DATAJPA-1464](https://github.com/spring-projects/spring-data-jpa/issues/1782)). Worked around with `List<T>` returns and manual `SliceImpl` (LIMIT+1 pattern). Same proven pattern recommended by Slack Engineering and Vlad Mihalcea (Hibernate core contributor).
>
> **Result:**
> - Latest posts: 19,424ms → **8.33ms** (-99.96%)
> - Search: 3,328ms → **20.51ms** (-99.4%) — back to normal speed once the cascade was resolved
> - Error rate: 32.53% → **0.00%**
> - CPU: 100% saturated → 35%
> - QPS: 50 → 300 (6×)

#### What this experience demonstrates

| Skill | Evidence |
|---|---|
| Diagnosis | BP 100% + Slow Queries 14.8K → diagnosed CPU bottleneck (not disk) |
| Honesty | Deferred Join "expected 40× vs actual 13%" — analyzed via EXPLAIN that index scan accounted for 85% |
| Framework understanding | Tracked Spring Data internals (Hibernate `setMaxResults`) into the GitHub issue |
| Cascade failure | Experienced (twice — here + caching) the pattern of a single bottleneck collapsing the whole system |

#### Interview prep

- "Why not Keyset Pagination?" → Page-number UI cannot "jump to page N". Reconsider when migrating to infinite scroll.
- "Why was Deferred Join not as fast as expected?" → ~85% of total cost was index scan; LONGTEXT I/O was ~15%.
- "How do you show total page count without COUNT(*)?" → Google removed result-count display in 2024. `hasNext` is sufficient.

---

### Experience 4: Caffeine L1 Cache — Cascade Failure Resolved

**Blog:** [Caching strategy — Caffeine L1 local cache for 14× search response](/blog/project/wikiengine/caching-strategy)

#### Resume (3 lines)

> After introducing search-quality enhancements (BM25 + FeatureField + RecencyDecay), composite scoring saturated CPU and caused cascade failure across the API at 100 VU. Justifying with Zipf-distributed search traffic, introduced a Caffeine L1 cache, and after comparing Redis/CDN by cost and fit chose Caffeine ($0 on a single server). Overall avg 776ms → 54ms (14×), search hit rate 81.8%, CPU 80-100% → 20-40%, cascade failure fully resolved.

#### Portfolio (detailed)

> **Situation:** After [search-quality enhancements](/blog/project/wikiengine/search-quality) introduced composite scoring (BM25 + FeatureField for views/likes + RecencyDecay), search regressed 20ms → 1,443ms (70×). At 100 VU, CPU saturation cascaded into non-search APIs (autocomplete 5ms → 368ms, listing 8ms → 392ms).
>
> **Root cause:** Composite scoring adds 3 DocValue reads per matching doc (viewCount, likeCount, createdAt), limiting Block-Max WAND optimization. For high-frequency tokens like "대한민국", scoring tens of thousands of docs spiked CPU time. With only 2 cores, every request got stuck in the CPU run queue.
>
> **Alternative comparison:**
>
> | Cache | Latency | Cost | Best for |
> |---|---|---|---|
> | **Caffeine (L1)** | < 0.1ms | $0 | single server, hot-query caching |
> | Redis (L2) | 0.5-2ms | $24,000+/yr | multi-server, cache coherency |
> | CDN (L3) | 5-50ms | $6,000+/yr | global users, static content |
>
> **Implementation:** Search results (TTL 5 min, W-TinyLFU), autocomplete (TTL 10 min), post detail (`@CacheEvict` for instant invalidation). Browser caching via Cache-Control stale-while-revalidate. Hit-rate monitoring via Actuator + Prometheus + Grafana.
>
> **Result:**
> - Overall avg: 776ms → **54ms** (14×)
> - Autocomplete: 368ms → **4.67ms** (back to smoke 5VU level)
> - Search hit rate: **81.8%**, autocomplete hit rate: **99.9%**
> - CPU: 80-100% → 20-40%, HikariCP Pending: 50 → 0
> - OOM safety: 4K/10K entries cap, TTL kicks in before maximumSize

#### Interview prep

- "Why Caffeine over Redis?" → Single-server, microsecond response without network. When adding servers, introduce Redis.
- "Cache consistency?" → Search: TTL 5 min (Google also takes time to refresh the index); detail: `@CacheEvict` for instant invalidation.
- "Cache stampede?" → Confirmed limited impact at TTL expiry under load test. `refreshAfterWrite` to be added if needed.

---

### Experience 5: Quantitative Search-Quality Evaluation

**Blog:** [Search-quality enhancement — phrase search, community ranking, P@10/MAP evaluation](/blog/project/wikiengine/search-quality)

#### Resume (3 lines)

> Implemented PhraseQuery (slop=2) phrase search to absorb Nori's compound-noun decomposition variance. After analyzing Reddit/Stack Overflow/Naver ranking algorithms, designed BM25 + FeatureField (views/likes saturation) + ExponentialDecay (30-day half-life) community ranking. Quantitatively evaluated search quality with P@10/MAP across 15 test queries and verified that FeatureField-based popularity boost balances with BM25 text relevance.

#### Interview prep

- "Is P@10 +3.2% meaningful?" → 15 queries × 10 results = 150 judgments; 4-5-judgment difference. Goal was "no quality regression + slight improvement direction" rather than statistical significance.
- "How did you decide weights 3.0/2.0/5.0?" → Such that boosts do not invert BM25 scores (5-15). Needs A/B re-validation once production data accumulates.

---

## Skills Section — Sentence Patterns

In the resume "Skills" section, do not just list tech stacks — write **sentences linked to experience.**

| Area | Sentence |
|---|---|
| **DB optimization** | EXPLAIN/EXPLAIN ANALYZE-driven query diagnosis, Deferred Join (Covering Index), Page → Slice COUNT(*) removal, OFFSET page cap. 19,424ms → 8ms on a 12.15M-row table |
| **Search engine** | Analyzed MySQL FULLTEXT ngram limits (down to fts0que.cc source) → migrated to embedded Lucene + Nori. BM25 + FeatureField ranking, PhraseQuery phrase search, P@10/MAP quantitative evaluation |
| **Caching** | Caffeine L1 W-TinyLFU, `@CacheEvict` instant invalidation, Cache-Control stale-while-revalidate, Actuator hit-rate monitoring. Search hit rate 81.8%, cascade failure resolved |
| **Load testing** | k6 smoke/load profiles, InfluxDB+Grafana, per-scenario SLAs. Diagnosed cascade failure twice (OFFSET CPU saturation, composite-scoring CPU saturation) |
| **Incident response** | HikariCP exhaustion → fail-fast isolation. InnoDB BP 100% + 14.8K Slow Queries → diagnosed CPU bottleneck |

---

## Project Tech Journey — Timeline Summary

Use this when showing "the full arc of this project" in a portfolio.

| # | Post | Key change |
|---|---|---|
| 1 | [Search engine paralyzes the system, response](/blog/project/wikiengine/search-system-crash) | LIKE Full Table Scan → meltdown → emergency mitigations (timeout, fail-fast) for availability |
| 2 | [Autocomplete B-Tree index](/blog/project/wikiengine/autocomplete-btree-index) | composite B-Tree index → autocomplete fixed (>5,000ms → 8ms) |
| 3 | [FULLTEXT ngram index](/blog/project/wikiengine/fulltext-ngram-index) | search restored (12s → 6ms, 570K). Found high-frequency timeout, 300GB+ index, false-positive limits. Source-level cause analysis (fts0que.cc) |
| 4 | [Why I chose Lucene over MySQL search](/blog/project/wikiengine/lucene-decision) | Lucene + Nori → full 12.15M search (timeout → 12ms). Cost-compared Lucene/ES/vector DBs and decided embedded Lucene |
| 5 | [Deferred Join](/blog/project/wikiengine/deferred-join-optimization) + [COUNT(*) removal & page cap](/blog/project/wikiengine/query-refactoring-optimization) | 19,424ms → 8ms, error rate 32.53% → 0%. Diagnosed cascade failure: CPU saturation collapses entire API |
| 6 | [Search quality enhancement](/blog/project/wikiengine/search-quality) | phrase search + community ranking + P@10/MAP quantitative evaluation |
| 7 | [Caching strategy](/blog/project/wikiengine/caching-strategy) | Caffeine L1 cache → 14× overall improvement, cascade failure resolved. Search hit rate 81.8%, CPU 80% → 20% |

---

## TOP 10 Deepest Interview Questions for This Project

| # | Question | Answer essence |
|---|---|---|
| 1 | "Why Lucene over ES?" | Compared server RAM + CDC + headcount. Single server + 14.77M does not need distribution |
| 2 | "What is cascade failure, and how did you diagnose it?" | BP 100% + Slow Queries 14.8K → CPU bottleneck. Deep OFFSET monopolized shared CPU |
| 3 | "Why is ngram slow on high-frequency tokens?" | fts0que.cc `ib_vector_t` linear scan. 2-gram "대한" 196K linear O(N) |
| 4 | "Why didn't Deferred Join give the expected speedup?" | Index scan ~85%, LONGTEXT I/O ~15%. Removing only the latter gives 13% |
| 5 | "How do you manage cache consistency?" | Search TTL 5 min, detail `@CacheEvict` instant, autocomplete TTL 10 min |
| 6 | "Without COUNT(*), how do you show total page count on the front?" | Google removed result counts in 2024. `hasNext` + nearby pages is enough |
| 7 | "Why not Keyset Pagination?" | Page-number UI cannot jump to page N. Reconsider on infinite-scroll migration |
| 8 | "Why BM25 b=0.5?" | Wiki doc length variance is large. Reduces over-penalty for long docs. Re-validate via A/B |
| 9 | "What if the index is corrupted?" | MySQL = source of truth. Full reindex (6h 40m) recovers it |
| 10 | "Sum up the project in one line?" | "Started from the slowest possible state and migrated step by step, proving each bottleneck with numbers" |

---

## Numbers Summary — Before/After at a Glance

| Metric | Initial | Final | Improvement |
|---|---|---|---|
| Search (high-frequency "대한") | system meltdown (Full Table Scan) | **12ms** (Lucene + Nori) | timeout resolved |
| Latest posts (100 VU) | 19,424ms / 32.53% errors | **8.33ms / 0% errors** | **-99.96%** |
| Overall avg (100 VU, with cache) | 776ms | **54ms** | **14×** |
| Search hit rate (Caffeine) | 0% (no cache) | **81.8%** | — |
| CPU (100 VU) | 100% saturated | **20-40%** | -60pp |
| Search corpus | 12.15M (full) | **12.15M (full)** | 25× expansion |
| Index size | 300GB+ (cannot build) | **29GB** (Lucene) | buildable |
| Extra infra cost | $0 | **$0** (Lucene embedded) | avoided $3,036-$9,528/yr vs ES |

---

## References

**Resume writing:**
- [Resume Worded — Backend Developer Resume Examples 2026](https://resumeworded.com/backend-developer-resume-example)
- [Teal — Junior Backend Developer Resume Example 2025](https://www.tealhq.com/resume-example/junior-backend-developer)
- [Woowahan Tech Blog — A rookie dev's bumpy resume-writing journey](https://techblog.woowahan.com/11998/)
- [Showcase your achievements with STAR — for developer resumes](https://dataengineeringstoic.co.kr/entry/%EA%B0%9C%EB%B0%9C%EC%9E%90-%EC%9D%B4%EB%A0%A5%EC%84%9C-STAR-%EA%B8%B0%EB%B2%95%EC%9C%BC%EB%A1%9C-%EC%84%B1%EA%B3%BC%EB%A5%BC-%EB%B9%9B%EB%82%B4%EC%84%B8%EC%9A%94)
- [GitHub — Awesome Resume Portfolio](https://github.com/codingmonster-tv/Awesome_Resume_Portfolio)

**Resume action verbs:**
- [Resume Worded — Software Engineering Action Verbs](https://resumeworded.com/software-engineer-resume-action-verbs)
- [Interview Kickstart — Software Engineering Resume Action Verbs](https://interviewkickstart.com/blogs/articles/action-verbs-software-engineering)

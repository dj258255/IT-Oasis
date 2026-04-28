# G마켓 Search Backend 면접 준비

## 1. 먼저 깔고 가야 할 전제

- 2026년 4월 1일 마감된 `Search Backend Engineer (Entry Level)` 공고 기준으로, G마켓 Search Engineering 조직은 다음을 명시했다.
- `Elasticsearch 또는 자체 엔진 기반 검색 서비스 개발 및 운영`
- `검색 색인(Indexing) 및 데이터 처리 파이프라인 개발`
- `상품 데이터 및 검색 품질 개선을 위한 Backend Batch/API 개발`
- `서비스 안정성 및 성능 개선을 위한 모니터링 및 이슈 대응`
- 같은 조직의 경력 공고도 `검색 색인 파이프라인 설계 및 대량 데이터 동기화 처리`, `Elasticsearch 운영 경험 우대`를 적고 있다.
- 따라서 면접에서는 `ES를 아느냐`를 직접 묻거나, 적어도 `ES 관점으로 설명해보라`는 질문이 나올 가능성이 높다.
- 다만 공고 표현이 `Elasticsearch 또는 자체 엔진`이므로, `실제 내부 구현이 100% ES다`라고 단정하는 표현은 피하는 편이 안전하다.

## 2. 면접관이 보고 싶어할 당신의 포지션

- `검색을 처음부터 구현해본 사람`
- `Lucene 레벨까지 이해해서 ES 개념도 깊게 연결할 수 있는 사람`
- `대용량 색인, 검색 품질, 랭킹, 캐시, CDC, 운영 안정성`을 실제로 수치로 말할 수 있는 사람
- `ES를 안 썼더라도, 왜 안 썼는지와 언제 ES로 가야 하는지 설명할 수 있는 사람`

면접에서 가장 좋은 프레이밍:

> "제 프로젝트는 비용 제약 때문에 임베디드 Lucene을 선택했지만, 검색 품질과 검색 엔진 원리는 ES와 거의 같은 층위에서 다뤘습니다. 오히려 Lucene 내부를 직접 구현하면서 ES가 제공하는 분산/운영 기능의 가치를 더 선명하게 이해하게 됐습니다."

## 3. 내 포스팅 기준 핵심 스토리라인

### 3-1. 1분 요약

> "WikiEngine은 1,200만 건 이상의 위키 문서를 대상으로 검색 엔진을 만든 프로젝트입니다. 처음에는 MySQL LIKE와 FULLTEXT로 시작했지만, 고빈도 토큰 타임아웃과 인덱스 크기 폭증, 한국어 검색 품질 한계 때문에 Lucene + Nori로 전환했습니다. 그 뒤로는 단순 검색 구현에서 멈추지 않고, 쿼리 확장, 오타 교정, Facet, LTR, 자동완성, 캐시, CDC, 스케일아웃까지 단계적으로 확장했습니다. 특히 검색 품질과 운영 안정성을 모두 숫자로 검증하려고 했고, 실제로 NDCG 개선이나 응답속도 개선뿐 아니라, LTR ON 시 72배 성능 악화처럼 안 되는 것도 수치로 확인하고 운영 판단까지 내린 점이 가장 큰 학습이었습니다."

### 3-2. 핵심 숫자

- 문서 수: `12,156,589건`
- 인덱스 크기: `42GB`
- 재색인 시간: `약 2시간`
- 검색 성능: `Lucene BM25 평균 29ms, P95 100ms`
- 전체 응답: `776ms -> 54ms`
- L1+L2 캐시 히트율: `82%`
- LTR 품질: `NDCG@10 0.6910 -> 0.7387 (+4.8%p)`
- 그러나 LTR 운영 성능: `42.81ms -> 3,088ms`, 검색 평균 `29.18ms -> 8,826ms`
- CDC 전환 후 쓰기 성능: `5,315ms -> 33ms`

## 4. 내 포스팅과 Elasticsearch의 관계

### 4-1. 공통점

- 본질적으로 같은 검색 엔진 계층이다. ES도 내부는 Lucene이다.
- BM25, inverted index, analyzer, segment, refresh, highlight, facet/aggregation 철학이 이어진다.
- Nori 분석기, query-time synonym, unified highlighter, reranking 같은 개념은 ES에서도 거의 그대로 대응된다.

### 4-2. 차이점

- 내 프로젝트는 `embedded Lucene`이라 검색 엔진을 JVM 내부에 직접 붙였다.
- ES는 Lucene 위에 `분산`, `REST API`, `샤드/레플리카`, `클러스터 관리`, `alias`, `aggregation`, `모니터링`, `운영 편의성`을 올린 제품이다.
- 나는 `Directory Swap + SearcherManager 재생성`으로 무중단 재색인을 직접 구현했다.
- ES였다면 일반적으로 `새 인덱스 생성 -> reindex -> alias swap`으로 처리했을 것이다.
- 나는 `LongField/FILTER`, `SortedSetDocValuesFacetCounts`, `UnifiedHighlighter`, `DirectSpellChecker`를 직접 조합했다.
- ES였다면 같은 문제를 `bool filter`, `terms aggregation`, `unified highlighter`, `suggest`, `synonym set` 등으로 더 제품화된 방식으로 풀 수 있다.

### 4-3. "왜 ES 안 썼어요?"에 대한 좋은 답

> "안 쓴 이유는 ES를 몰라서가 아니라, 당시 제약이 Free Tier 단일 서버였기 때문입니다. 검색 품질만 보면 Lucene과 ES는 같은 엔진 계층이라 BM25와 Nori를 그대로 쓸 수 있습니다. 하지만 그 시점의 제 프로젝트는 1,200만 건 규모를 단일 노드에서 충분히 처리할 수 있었고, ES를 도입하면 클러스터 운영, 별도 메모리, 데이터 동기화 비용까지 함께 가져와야 했습니다. 그래서 먼저 Lucene으로 검색 품질과 핵심 구조를 검증했고, 실제로 나중에 3대 이상 인스턴스나 실시간 색인 동기화 복잡도가 커지면 ES로 가는 기준점까지 정리해두었습니다."

### 4-4. "그래도 실무에서는 ES가 더 낫지 않나요?"에 대한 좋은 답

> "대부분의 회사 실무에서는 맞습니다. 특히 이커머스처럼 상품 검색이 곧 매출과 연결되고, 여러 서비스가 검색 인프라를 공유하고, 운영 안정성과 관측성이 중요하면 ES의 가치가 큽니다. 제 프로젝트가 Lucene을 택한 건 비용 제약과 학습 목적이 강했기 때문이고, 실무 팀이라면 저도 ES를 우선 검토할 겁니다. 대신 Lucene을 직접 다뤄본 경험 덕분에 ES를 단순 사용자가 아니라 내부 원리까지 이해한 상태로 운영할 수 있다는 점이 제 강점입니다."

### 4-5. 면접에서 바로 쓸 수 있는 ES 매핑표

| 내 프로젝트 | Elasticsearch로 치면 |
|---|---|
| `MultiFieldQueryParser + BM25` | `multi_match`, `match`, `bool should` |
| `Occur.FILTER + LongField.newExactQuery` | `bool.filter`, `term/range query` |
| `SortedSetDocValuesFacetCounts` | `terms aggregation` |
| `UnifiedHighlighter` | `highlight.type=unified` |
| `DirectSpellChecker` | `term/phrase suggester` |
| `DB 기반 query-time synonym` | query-time synonym expansion / synonym set |
| `Directory Swap + SearcherManager recreate` | blue-green reindex + alias swap |
| `CDC + Kafka + Debezium` | DB -> Kafka -> ES indexing pipeline |
| `SearcherManager maybeRefresh` | `refresh_interval` |
| `FeatureField + Rescorer + XGBoost4J` | function score / rescore / LTR plugin 계열 |

## 5. 후기 기반 면접 질문 총정리

### 5-1. 거의 무조건 나오는 축

- 지원동기, 이직사유
- 프로젝트 설명
- 가장 어려웠던 문제
- Java/Spring DI, IoC, Transaction
- 자료구조/알고리즘
- DB/인덱스/트랜잭션
- 네트워크/운영체제
- 장애 대응 경험
- 왜 G마켓이고 왜 Search 팀인지

### 5-2. Search 팀이라서 추가로 나올 축

- 검색 엔진 동작 원리
- Elasticsearch 기본 구조
- 색인 파이프라인
- 대량 데이터 동기화
- 검색 품질 평가
- 랭킹/리랭킹
- 필터/Facet/Aggregation
- 자동완성
- 캐시 전략
- 모니터링/장애 대응

### 5-3. 실제 질문 뱅크

- 왜 G마켓 Search 팀인가요?
- 왜 검색 백엔드인가요?
- 본인 프로젝트 중 검색과 가장 가까운 경험은?
- MySQL 검색의 한계는 뭐였나요?
- Lucene과 Elasticsearch 차이는?
- inverted index를 설명해보세요.
- analyzer, tokenizer, token filter 차이는?
- 한국어 검색에서 Nori를 왜 쓰나요?
- n-gram과 형태소 분석의 trade-off는?
- query-time synonym과 index-time synonym 차이는?
- 오타 교정은 어떻게 구현할 건가요?
- highlight/snippet은 어떻게 만드나요?
- filter와 facet/aggregation 차이는?
- 상품 태그 facet이 왜 어려운가요?
- shard와 replica는 각각 왜 필요하죠?
- refresh는 무엇이고 왜 중요하죠?
- mapping 변경 시 무중단 재색인은 어떻게 하나요?
- full indexing과 incremental indexing을 어떻게 나누나요?
- CDC, Outbox, dual-write 차이를 설명해보세요.
- 색인 지연이 발생하면 어디부터 볼 건가요?
- 검색 품질은 어떤 지표로 보나요?
- CTR과 NDCG가 충돌하면 어떻게 해석하나요?
- 랭킹과 리랭킹 차이는?
- LTR를 붙이려면 어떤 피처를 쓸 건가요?
- 캐시 전략은 어떻게 짤 건가요?
- hot keyword 대응은 어떻게 할 건가요?
- zero-result query는 어떻게 개선하겠나요?
- 장애 시 source of truth와 read model 관계는?
- 상품 검색과 위키 검색의 가장 큰 차이는?
- 광고와 자연검색의 균형은 어떻게 보나요?

## 6. 예상 질문 + 꼬리질문 + 모범답안

### Q1. 자기소개와 Search 팀 지원동기를 말씀해주세요.

**답변**

> "저는 검색을 단순 API 기능이 아니라, 데이터 구조, 랭킹, 품질, 운영 안정성까지 함께 설계하는 문제로 보는 백엔드 엔지니어입니다. 개인 프로젝트로 1,200만 건 규모의 WikiEngine 검색 시스템을 직접 만들면서 MySQL 검색 한계, Lucene 전환, 쿼리 확장, 오타 교정, Facet, LTR, CDC, 캐시, 스케일아웃까지 단계적으로 경험했습니다. 그 과정에서 검색은 작은 품질 차이가 곧 사용자 경험 차이로 이어지고, 결국 서비스 가치와도 직결된다는 걸 많이 느꼈습니다. G마켓 Search 팀은 대규모 상품 데이터와 사용자 행동 데이터를 기반으로 검색 품질을 지속적으로 개선하는 조직이라, 제가 해온 경험을 더 큰 실서비스 문제에 연결해볼 수 있는 가장 적합한 팀이라고 생각해 지원했습니다."

**꼬리질문**

- 왜 일반 백엔드가 아니라 Search인가요?
- 왜 이커머스 Search인가요?

**짧은 추가 답**

> "일반 백엔드가 요청을 안정적으로 처리하는 문제라면, Search는 사용자의 의도를 해석해서 가장 좋은 결과를 앞에 두는 문제라서 더 흥미롭습니다. 특히 이커머스는 검색 결과 품질이 클릭, 전환, 매출로 직접 이어지기 때문에 개선 효과가 명확하다는 점이 매력적입니다."

### Q2. 본인 프로젝트를 3분 안에 설명해보세요.

**답변**

> "WikiEngine은 1,200만 건 이상의 위키 문서를 검색하는 시스템입니다. 처음에는 MySQL LIKE와 FULLTEXT로 시작했는데, 고빈도 토큰에서 타임아웃이 나고 한국어 검색 품질도 좋지 않았습니다. 그래서 Lucene + Nori로 전환했고, 그 이후에는 단순 키워드 검색에서 멈추지 않고 동의어 확장, 오타 교정, UnifiedHighlighter 기반 snippet, 카테고리 필터와 Facet, 자동완성, Redis L2 캐시, CDC, 스케일아웃, LTR까지 확장했습니다. 제가 가장 강조하고 싶은 부분은 두 가지입니다. 첫째, 검색 품질과 운영 안정성을 둘 다 다뤘다는 점입니다. 둘째, 좋은 결과만 아니라 안 되는 것도 수치로 판단했다는 점입니다. 예를 들어 LTR은 NDCG는 좋아졌지만 운영 지연이 너무 커서 비활성화했고, 그런 판단까지 포함해 프로젝트를 정리했습니다."

**꼬리질문**

- 가장 큰 전환점은 뭐였나요?
- 가장 잘한 선택과 가장 아쉬운 선택은?

### Q3. MySQL FULLTEXT 대신 Lucene으로 전환한 이유가 뭔가요?

**답변**

> "핵심은 세 가지였습니다. 첫째, 고빈도 토큰 타임아웃입니다. 예를 들어 '대한' 같은 고빈도 2-gram은 posting list가 너무 커서 사실상 실사용이 어려웠습니다. 둘째, 전체 1,400만 건 이상으로 확장하려고 했을 때 FULLTEXT 인덱스 생성 비용이 너무 컸습니다. 셋째, n-gram 기반이라 false positive가 많았습니다. 반면 Lucene + Nori는 한국어를 의미 단위로 다뤄 precision을 높일 수 있었고, 검색 품질과 확장성 모두 더 적합했습니다."

**꼬리질문**

- 그럼 왜 처음부터 ES가 아니라 Lucene이었나요?
- Nori를 쓰면 recall이 떨어질 수 있는데 어떻게 봤나요?

### Q4. Elasticsearch와 Lucene의 차이를 설명해주세요.

**답변**

> "Lucene은 검색 라이브러리이고, Elasticsearch는 Lucene 위에 분산 시스템과 운영 기능을 얹은 검색 엔진 제품이라고 보는 게 가장 정확합니다. Lucene은 inverted index, analyzer, BM25, segment 같은 핵심 검색 엔진 기능을 제공합니다. ES는 거기에 샤드/레플리카, REST API, 클러스터 관리, aggregation, alias 기반 무중단 재색인, 모니터링 같은 실무 운영 기능을 추가합니다. 즉 검색 원리 자체는 같고, 차이는 운영과 확장 레이어에 있습니다."

**꼬리질문**

- ES를 쓰면 편해지는 점 3가지만 말해보세요.
- 반대로 Lucene을 직접 쓰는 장점은 뭐죠?

**짧은 추가 답**

- ES 장점: `분산`, `운영 편의성`, `기능 제품화`
- Lucene 장점: `낮은 오버헤드`, `세밀한 제어`, `단일 노드에서 단순한 구조`

### Q5. Elasticsearch를 쓴다고 가정하면 상품 검색 인덱싱 파이프라인을 어떻게 설계하겠습니까?

**답변**

> "상품 원본 데이터의 source of truth는 RDBMS라고 가정하겠습니다. 상품 생성/수정/삭제 이벤트를 CDC나 Outbox 기반으로 추출하고, 메시지 브로커를 통해 색인 파이프라인으로 전달합니다. 색인 단계에서는 상품명, 카테고리, 브랜드, 속성, 가격, 재고, 배송, 셀러 상태 같은 검색/필터 필드를 명확히 분리합니다. 검색용 텍스트 필드와 집계용 keyword/doc_values 필드를 따로 두고, 검색 품질에 필요한 analyzer를 적용합니다. 색인 실패는 DLQ와 재처리 전략을 둬야 하고, mapping 변경이 필요한 경우엔 새 인덱스를 만든 뒤 alias swap으로 무중단 전환하겠습니다."

**꼬리질문**

- full indexing과 incremental indexing은 어떻게 나눌 건가요?
- 중복 이벤트나 역순 이벤트는 어떻게 처리하나요?
- delete는 hard delete로 할 건가요, soft delete로 할 건가요?

### Q6. 검색 품질을 어떻게 평가하실 건가요?

**답변**

> "오프라인과 온라인을 나눠 보겠습니다. 오프라인에서는 대표 쿼리셋과 relevance judgment를 만들어 NDCG@K, MRR, Recall 같은 지표를 보겠습니다. 온라인에서는 CTR, add-to-cart rate, conversion, zero-result rate, reformulation rate를 보겠습니다. 검색은 클릭률만 높다고 좋은 게 아니기 때문에, 클릭 이후 전환까지 연결되는지 보는 게 중요하다고 생각합니다."

**꼬리질문**

- 오프라인 지표는 좋아졌는데 CTR이 떨어지면?
- 상품검색에서 NDCG와 매출이 충돌하면?

### Q7. Query-time synonym을 택한 이유가 뭔가요?

**답변**

> "인덱스 타임 동의어는 document frequency를 왜곡해서 BM25 IDF에 영향을 줄 수 있고, 동의어 변경 시 재색인이 필요합니다. 제 프로젝트에서는 운영 유연성이 더 중요했기 때문에 DB 기반 query-time synonym expansion을 선택했습니다. 이 방식은 인덱스 term statistics를 건드리지 않고, 동의어 추가/삭제도 더 유연합니다. 장기적으로는 ES나 Lucene의 파일 기반 synonym 체계로 운영할 수 있지만, 초기 단계에선 query-time이 더 합리적이었습니다."

**꼬리질문**

- query-time synonym의 단점은?
- multi-term synonym은 어떻게 처리할 건가요?

### Q8. Facet과 filter는 어떻게 다릅니까?

**답변**

> "Filter는 결과 집합을 줄이는 역할이고, Facet은 결과 집합의 분포를 보여주는 역할입니다. 예를 들어 '운동화' 검색에서 `브랜드=나이키`는 filter이고, 검색 결과 안에 브랜드별 건수를 보여주는 건 facet입니다. 제 프로젝트에서는 처음엔 DB GROUP BY 기반 근사 집계를 썼지만, 이후엔 `SortedSetDocValuesFacetCounts`로 Lucene 내부에서 정확한 집계를 하도록 바꿨습니다. ES라면 보통 bool filter와 terms aggregation 조합으로 설명할 수 있습니다."

**꼬리질문**

- 왜 tag facet은 포기했나요?
- facet이 많은 환경에서 성능은 어떻게 관리하나요?

### Q9. LTR를 도입한 이유와, 결국 운영에서 끈 이유를 말해주세요.

**답변**

> "수동 부스팅은 설명은 쉽지만 한계가 명확했습니다. 예를 들어 '자바' 검색에서 사용자가 기대하는 프로그래밍 언어 문서보다 다른 문서가 위에 오는 문제가 있었습니다. 그래서 LambdaMART로 14개 피처를 사용해 Top-200 rescore 구조를 만들었고, 오프라인에서는 NDCG@10이 0.6910에서 0.7387로 개선됐습니다. 다만 2코어 ARM 환경에서 운영 성능을 측정해보니 전체 평균 응답시간이 42.81ms에서 3,088ms로 악화됐습니다. 그래서 저는 이걸 실패라고 보지 않고, 품질 개선이 실제 운영 비용을 감당할 수 있는지까지 확인한 실험이라고 정리합니다."

**꼬리질문**

- 그럼 실무에서는 LTR를 어떻게 살릴 건가요?
- 어떤 피처를 precompute할 수 있나요?

### Q10. 검색 색인과 원본 DB의 정합성은 어떻게 보장했나요?

**답변**

> "초기에는 PostService가 DB 저장과 Lucene 인덱싱을 같이 하는 dual-write 구조였는데, 이건 부분 실패 시 정합성이 깨질 위험이 컸습니다. 그래서 먼저 이벤트 기반으로 분리하고, 최종적으로는 Debezium + Kafka CDC로 DB 변경을 기준으로 색인을 갱신하는 구조를 도입했습니다. 검색 인덱스는 source of truth가 아니라 파생 read model이기 때문에, 정합성 설계의 핵심은 '원본은 DB에만 쓴다'고 두는 것이었습니다."

**꼬리질문**

- Outbox 대신 CDC를 택한 이유는?
- exactly-once는 어떻게 볼 건가요?
- 결국 ES라면 어떤 동기화 방식이 가장 현실적인가요?

### Q11. 검색 캐시는 어떻게 설계하시겠어요?

**답변**

> "검색은 hot query와 cold query 편차가 크기 때문에, 캐시는 단순 key-value가 아니라 계층적으로 보는 편이 좋습니다. 제 프로젝트에서는 Caffeine L1과 Redis L2를 둬서 히트율 82%를 만들었습니다. 실무라면 query normalization, 필터 조합 폭발, personalization 여부를 고려해 캐시 키를 설계해야 하고, TTL만으로 부족하면 이벤트 기반 무효화도 함께 검토해야 합니다. 다만 검색 캐시는 stale 허용 범위와 invalidation cost를 항상 같이 봐야 합니다."

**꼬리질문**

- 캐시 스탬피드는 어떻게 막을 건가요?
- personalized result도 캐싱할 건가요?

### Q12. G마켓 상품 검색에서는 위키 검색과 뭐가 다를까요?

**답변**

> "가장 큰 차이는 검색 의도와 정렬 신호입니다. 위키 검색은 정보 탐색이 중심이라 텍스트 relevance가 강하고, 상품 검색은 구매 의도와 탐색 의도가 섞여 있습니다. 그래서 텍스트 relevance 외에도 가격, 재고, 배송, 리뷰, 판매량, 광고, 브랜드, 카테고리 구조 같은 신호가 함께 중요해집니다. 또 위키 문서는 상대적으로 정적인 반면 상품은 가격, 재고, 상태가 자주 바뀌기 때문에 indexing freshness와 운영 안정성이 훨씬 더 중요합니다."

**꼬리질문**

- 상품 검색에서 `정확도`보다 중요한 게 있나요?
- 광고상품과 자연검색의 균형은 어떻게 보나요?

### Q13. ES 운영 관점에서 꼭 봐야 할 지표는 뭔가요?

**답변**

> "검색 품질 지표와 인프라 지표를 같이 봐야 합니다. 인프라 쪽은 cluster health, node heap 사용률, GC, segment 수, indexing latency, refresh/merge 시간, query latency, cache hit, shard skew를 보겠습니다. 애플리케이션 관점에선 zero-result rate, slow query, indexing backlog, DLQ 적체도 중요합니다. 결국 검색 장애는 '결과가 안 나오는 문제'와 '결과는 나오지만 너무 느린 문제' 둘 다 포함합니다."

### Q14. ES에서 shard와 replica는 각각 왜 필요한가요?

**답변**

> "Shard는 데이터를 나눠 저장하고 병렬 처리하기 위한 단위이고, replica는 가용성과 읽기 확장을 위한 복제본입니다. 즉 shard는 scale-out의 축이고, replica는 fault tolerance와 read scalability의 축입니다. 다만 shard 수를 무조건 늘리면 좋은 게 아니라, 작은 shard가 너무 많아지면 오히려 메모리와 관리 비용이 커집니다. 그래서 예상 문서 수, query 패턴, 노드 수를 같이 보고 shard 수를 잡아야 합니다."

**꼬리질문**

- shard가 많으면 무조건 빠른가요?
- replica는 write 성능에 어떤 영향을 주나요?

### Q15. 상품 검색 인덱스의 mapping/analyzer는 어떻게 잡겠습니까?

**답변**

> "텍스트 검색 필드와 필터/집계 필드를 분리하겠습니다. 예를 들어 상품명은 `text`로 두고 한국어 analyzer를 적용하되, exact match나 정렬이 필요하면 `.keyword` 서브필드를 같이 두겠습니다. 브랜드, 카테고리, 판매자 상태 같은 필드는 집계와 필터가 중요하므로 keyword/doc values 중심으로 두겠습니다. 가격, 할인율, 리뷰수, 판매량은 numeric으로 두고 range/filter/sort가 잘 되게 설계하겠습니다. 핵심은 검색 relevance 필드와 탐색/집계 필드를 섞지 않는 것입니다."

**꼬리질문**

- 상품명에 edge-ngram을 쓰면 어떤 문제가 있나요?
- analyzer는 인덱스 타임과 검색 타임을 다르게 가져갈 건가요?

### Q16. Java/Spring에서 면접관이 많이 물을 만한 질문

**좋은 짧은 답**

- DI/IoC: "객체 생성과 의존성 연결 책임을 컨테이너가 가져가서 결합도를 낮추는 구조입니다. 저는 생성자 주입을 선호합니다."
- `@Transactional`: "경계는 서비스 레이어에 두고, self-invocation이나 readOnly 라우팅 같은 함정을 항상 같이 봅니다."
- 생성자 주입 선호 이유: "불변성, 테스트 용이성, 순환참조 조기 발견 때문입니다."

### Q17. 자료구조/알고리즘 질문에서 Search 직무답게 말하는 법

**예시**

> "정렬 알고리즘의 복잡도를 외우는 것에서 끝나지 않고, 실제 검색 시스템에서는 top-k를 다 구하는 대신 heap, partial sort, inverted index 기반 후보 축소가 더 중요하다고 생각합니다."

## 7. 후기 기반 인성 질문 모범답안

### 왜 이직하려고 하나요?

> "지금까지는 검색과 데이터 시스템을 개인 프로젝트나 제한된 환경에서 깊게 파고들었다면, 이제는 실제 대규모 사용자 트래픽과 상품 데이터 환경에서 검색 품질 개선을 해보고 싶습니다. 특히 이커머스 검색은 개선 결과가 사용자 경험과 비즈니스 지표로 바로 연결되기 때문에, 더 큰 임팩트를 낼 수 있다고 판단했습니다."

### 프로젝트에서 가장 어려웠던 부분은?

> "기술적으로는 LTR가 가장 어려웠습니다. 품질은 좋아졌지만 운영 성능이 무너졌기 때문에, 단순히 모델을 붙이는 것보다 운영 가능한 구조를 만드는 게 더 중요하다는 걸 배웠습니다. 저는 그걸 억지로 밀어붙이지 않고, 성능 측정 결과를 근거로 비활성화한 뒤 다음 조건을 정의하는 방향으로 정리했습니다."

### 장애 대응 경험은?

> "저는 장애를 '에러가 났다'보다 '사용자 경험이 깨졌다'로 정의하는 편입니다. 예를 들어 CDC 배포 후 검색 반영이 안 되던 문제에서는 개별 컴포넌트 health가 아니라 이벤트 소비 위치, 실제 인덱싱 위치, 환경변수 매핑까지 end-to-end로 따라가며 원인을 좁혔습니다. 임시 복구와 근본 원인 제거를 분리해서 보는 편입니다."

### 모르는 질문이 나오면 어떻게 하나요?

> "모른다고 말하되, 완전히 멈추기보다는 제가 아는 레벨까지 분해해서 설명하려고 합니다. 실제 프로젝트에서도 정답을 외워서 해결한 것보다, 원인을 단계적으로 좁히며 해결한 경험이 더 많았기 때문입니다."

## 8. 이 포지션에서 특히 위험한 답변

- `ES는 안 써봐서 잘 모릅니다`
- `Lucene이 ES보다 무조건 낫습니다`
- `검색 품질은 BM25 튜닝만 잘하면 됩니다`
- `검색은 DB 튜닝이랑 크게 다르지 않습니다`
- `LTR는 좋아 보여서 넣었습니다`
- `CDC는 그냥 최신 기술이라 넣었습니다`

대신 이렇게 바꾸면 좋다.

- `ES를 직접 운영한 경험은 없지만, Lucene 기반으로 같은 개념을 구현해봤고 ES의 운영 레이어 가치도 비교해봤습니다`
- `그 시점 제약에서는 Lucene이 맞았고, 실무 대규모 서비스라면 ES를 우선 검토하겠습니다`
- `검색 품질은 analyzer, recall/precision, synonym, typo, ranking, metrics를 같이 봐야 합니다`

## 9. 면접 직전 10분 체크리스트

- `왜 G마켓 Search 팀인가` 30초 버전
- `WikiEngine 1분 요약`
- `Lucene vs Elasticsearch 차이`
- `왜 query-time synonym이었는가`
- `왜 LTR를 껐는가`
- `왜 CDC가 필요했는가`
- `상품 검색과 위키 검색 차이`
- `검색 품질 지표 3개`
- `가장 큰 실패와 배운 점`
- `질문 1개 준비`: "현재 팀에서 검색 품질 개선 과제는 relevance 쪽이 더 큰지, indexing freshness/운영 안정성 쪽이 더 큰지 궁금합니다."

## 10. 출처

- G마켓 Search Backend Engineer (Entry Level): https://kr.linkedin.com/jobs/view/search-backend-engineer-entry-level-at-gmarket-4386596324
- G마켓 Search Engineer: https://kr.linkedin.com/jobs/view/search-engineer-at-gmarket-4358131866
- G마켓 검색 PM 인터뷰: https://news.gmarket.com/index.php/blog-2/?vid=918
- 로컬 포스팅:
- `src/content/blog/project/WikiEngine/lucene-decision.md`
- `src/content/blog/project/WikiEngine/search-query-enhancement.md`
- `src/content/blog/project/WikiEngine/search-category-facet.md`
- `src/content/blog/project/WikiEngine/search-ltr-ranking.md`
- `src/content/blog/project/WikiEngine/cdc.md`
- `src/content/blog/project/WikiEngine/wiki-engine-retrospective.md`

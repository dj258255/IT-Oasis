---
title: 'WikiEngine 면접 예상 질문 모음'
titleEn: 'WikiEngine Interview Q&A Collection'
description: WikiEngine 프로젝트 전체에서 나올 수 있는 면접 예상 질문과 답변을 정리합니다.
descriptionEn: Collection of expected interview questions and answers from the WikiEngine project.
date: 2026-03-20T00:00:00.000Z
tags:
  - Interview
  - WikiEngine
  - Replication
  - DataSource
  - CDC
  - Debezium
  - Kafka
  - Dual-Write
  - Lucene
  - Faceted Search
  - Nori
  - RAG
  - LLM
  - Aho-Corasick
category: project/WikiEngine
draft: true
---

## Redis L2 캐시 + 자동완성 flat KV

**Q: "왜 Redis를 도입했나요?"**

stress 테스트에서 200 VU 시 CPU가 100% 포화되었습니다. 원인은 Caffeine 캐시 4% 미스가 Lucene BM25 검색을 트리거하는 것이었습니다. Redis L2 캐시를 도입하여 L1+L2 합산 히트율 82%를 달성하고, Origin 도달률을 19%로 낮췄습니다. 자동완성은 Trie DFS 대신 Redis flat KV O(1) GET으로 전환하여 Lettuce P95 2.5ms를 달성했습니다. 또한 스케일아웃 시 다중 인스턴스 간 캐시 일관성을 확보하기 위해 공유 캐시가 필요했습니다.

**Q: "왜 Memcached가 아니라 Redis?"**

Memcached는 순수 key-value 캐시에 특화되어 있지만, 이 프로젝트에서는 캐시 이상의 기능이 필요했습니다. 자동완성 데이터 영속성(RDB), TokenBlacklist(Set + TTL), L1 캐시 무효화(Pub/Sub). 캐시 데이터가 수십MB로 소규모이기 때문에 Memcached의 메모리 효율 이점도 의미가 없었습니다.

**Q: "Caffeine만 쓰면 안 되나요?"**

Caffeine은 인스턴스별 독립 캐시입니다. 스케일아웃하면 인스턴스 A에서 캐싱한 데이터를 B에서 또 조회해야 합니다. 실측 L1 73%, L2 9%, Origin 19%로 분포되었고, L1이 반복 요청을 0.1ms에 처리하면서 Redis 비용은 L1 미스 시에만 발생합니다.

**Q: "Redis 없이 DB 버퍼풀이나 Caffeine 사이즈 키우면 안 됐어?"**

InnoDB Buffer Pool은 이미 100% 히트율이었습니다. DB I/O가 아닌 CPU가 병목이므로 효과 없습니다. Caffeine 4% 미스는 캐시 용량이 아니라 cold query입니다. 사이즈를 2배로 해도 처음 검색되는 쿼리는 여전히 미스이고, 스케일아웃 시 인스턴스별 독립이라 근본 해결이 안 됩니다.

**Q: "Redis 추가하면 서버 메모리 부담은?"**

서버 12GB RAM 중 Redis 300MB 할당. 실측 메모리 사용률 28.4%(73MB/256MB), Eviction 0 ops/s. 페이지 캐시가 ~1% 감소하지만, Origin 도달률 19%로 실제 Lucene 접근 빈도가 감소하여 상쇄됩니다. AWS 환경이라면 ElastiCache 월 ~3만원 추가에 RDS 다운스케일 ~13만원 절감으로 총 비용이 줄어드는지가 도입 근거입니다.

**Q: "L1-L2 데이터 불일치는?"**

같은 인스턴스에서의 수정은 L1+L2 동시 evict → 즉시 반영. 현재는 단일 인스턴스라 불일치 없음. 스케일아웃 시 Redis Pub/Sub + L1 TTL(5분) 이중 보완 전략 적용. Pub/Sub은 at-most-once이지만, 유실 시에도 TTL 만료로 자연 갱신됩니다.

**Q: "prefix_topk 갱신의 원자성은?"**

RENAME은 5,000개 키를 개별 실행하므로 중간 실패 시 불일치. 버전 네임스페이스 방식으로 새 데이터를 별도 적재 후 `prefix:current_version`(단일 키)만 원자적으로 SET합니다. 적재 도중 실패해도 이전 버전이 유지됩니다.

**Q: "Redis가 죽으면?"**

Redis는 "있으면 빨라지는 것"입니다. TieredCacheService에서 try-catch로 L2를 스킵, L1 + Origin으로 fallback합니다. 자동완성은 Lucene PrefixQuery fallback으로 전환됩니다. Trie를 퇴역시키되 PrefixQuery를 유지한 이유입니다.

**Q: "Spring @Cacheable 안 쓴 이유는?"**

Spring Cache Abstraction은 단일 계층 전제 설계입니다. L1 → L2 → Origin 순서 조회 + L2 히트 시 L1 승격 흐름은 기본 지원하지 않습니다. CompositeCacheManager도 조회 순서와 승격 로직을 미지원하여 직접 구현이 가장 단순했습니다.

---

## MySQL Replication + DataSource 라우팅

**Q: "왜 MySQL Replication을 도입했나요?"**

[App 스케일아웃](/blog/project/wikiengine/scaleout)의 전제조건입니다. 현재 MySQL은 병목이 아니지만(InnoDB 버퍼 풀 히트율 99.5%, Table Lock 0), App을 2대로 늘리면 HikariCP 커넥션이 40개(20×2)로 단일 MySQL에 집중됩니다. 미리 읽기를 Replica로 분리하면 Primary는 쓰기(~50 ops/s)만, Replica는 읽기(~200 ops/s)를 담당하여 스케일아웃 시 DB가 병목이 되지 않습니다. 실측 결과 Replication Lag은 부하 시에도 0~1초로 커뮤니티 서비스에 영향 없었습니다.

**Q: "ProxySQL 같은 프록시를 안 쓰고 앱 레벨에서 라우팅한 이유는?"**

ProxySQL은 쿼리를 SQL 레벨에서 파싱하여 SELECT/INSERT를 분기합니다. 앱 코드 변경 없이 R/W 분리가 가능하다는 장점이 있지만, 프록시 서버 추가로 인한 자원 소모(Free Tier 제약), 쿼리 파싱 오버헤드, 장애 포인트 추가가 단점입니다. 이 프로젝트에서는 이미 서비스 코드에 `@Transactional(readOnly=true)` 분리가 되어 있어서, Spring의 `AbstractRoutingDataSource`로 트랜잭션 속성 기반 라우팅을 하면 코드 변경이 최소이고 별도 인프라가 불필요합니다. 단, `LazyConnectionDataSourceProxy`로 감싸야 트랜잭션 속성이 설정된 후에 커넥션을 획득합니다.

**Q: "비동기 Replication이면 데이터 유실 위험이 있지 않나요?"**

비동기 Replication에서 Primary가 장애 나면 Replica에 아직 전파되지 않은 트랜잭션은 유실될 수 있습니다. 하지만 이 프로젝트에서는 Replica를 '읽기 분산' 용도로만 사용하고, Primary 장애 시 Replica를 승격(failover)하는 구조가 아닙니다. Replica가 죽으면 모든 읽기가 Primary로 fallback되고, Primary가 죽으면 서비스 전체가 중단됩니다. 자동 failover가 필요하면 반동기(Semi-sync) 또는 InnoDB Cluster(최소 3대)를 검토해야 하지만, Free Tier 2대 제약에서는 비동기 + 수동 복구가 현실적입니다.

**Q: "DataSource 라우팅은 어떻게 구현했나요?"**

`AbstractRoutingDataSource`를 상속하여 `TransactionSynchronizationManager.isCurrentTransactionReadOnly()`로 readOnly 트랜잭션이면 'replica', 아니면 'primary'를 반환합니다. 핵심은 `LazyConnectionDataSourceProxy`로 감싸는 것입니다. Spring은 트랜잭션 동기화 전에 `getConnection()`을 호출하므로, LazyProxy 없이는 readOnly 플래그가 항상 false를 반환합니다. HikariCP 풀은 Primary 5개 + Replica 15개로 분리했고(합계 20개 유지), 실측 결과 Primary Active 0~2, Replica Active 3~5로 안정적이었습니다. 또한 `@Configuration(proxyBeanMethods=false)` 환경에서는 `@Qualifier` 파라미터 주입을 써야 `@ConfigurationProperties`가 적용된 빈을 받을 수 있습니다 — 직접 메서드 호출은 빈 HikariDataSource를 생성합니다.

**Q: "Replication Lag이 크면 어떻게 되나요?"**

읽기 전용 트랜잭션은 Replica에서 읽으므로, Lag만큼 오래된 데이터를 볼 수 있습니다. 커뮤니티 게시판에서 게시글 목록이 1-2초 늦게 갱신되는 것은 UX에 영향이 없습니다. Write 후 Read 일관성 문제는 검토했는데, 수정/삭제 후 조회가 별개 HTTP 요청(별개 트랜잭션)이므로 Replica로 갈 수 있습니다. 하지만 비동기 Replication의 lag은 일반적으로 수십~수백 ms 수준이고, 사용자가 수정 후 페이지 리로드까지 1-2초가 걸리므로 대부분 자연스럽게 해소됩니다. 만약 이게 문제가 된다면 PUT 응답 자체에 수정된 데이터를 포함시켜 별도 GET을 줄이는 방법을 검토할 수 있습니다.

**Q: "LazyConnectionDataSourceProxy를 안 쓰면 어떻게 되나요?"**

모든 쿼리가 Primary로 갑니다. Spring의 `DataSource.getConnection()`은 `@Transactional` AOP가 트랜잭션 동기화 매니저를 초기화하기 전에 호출됩니다. 그래서 `TransactionSynchronizationManager.isCurrentTransactionReadOnly()`가 항상 false를 반환하고, RoutingDataSource는 항상 Primary를 선택합니다. LazyConnectionDataSourceProxy가 실제 Statement 생성 시점까지 커넥션 획득을 지연시켜서, 트랜잭션 속성이 설정된 후에 라우팅 결정을 하게 만듭니다. 이건 Spring 공식 이슈(#30969)에서도 논의된 알려진 문제입니다.

**Q: "HikariCP 풀을 왜 5:15로 나눴나요?"**

커뮤니티 게시판의 트래픽 패턴에서 읽기(SELECT)가 80-90%, 쓰기(INSERT/UPDATE/DELETE)가 10-20%입니다. 기존 단일 풀 20개를 이 비율에 맞춰 Primary 5개 + Replica 15개로 분배했습니다. 합계 20개로 기존 MySQL 커넥션 총량을 유지합니다. 만약 쓰기 비율이 예상보다 높으면 Primary를 10개로 올리고 Replica를 10개로 줄이면 됩니다. 실측 후 HikariCP Active 커넥션 분포를 보고 조정할 예정입니다.

**Q: "Flyway 마이그레이션은 Replica에서도 실행되나요?"**

아닙니다. Flyway는 반드시 Primary에서만 실행되어야 합니다. Routing DataSource를 쓰면 Flyway가 LazyProxy를 받아서 마이그레이션 시점에 어떤 DataSource를 탈지 불확실해집니다. `@FlywayDataSource` 어노테이션으로 Primary DataSource를 명시하여 마이그레이션이 항상 Primary에서 실행되도록 설정합니다. Replica에는 Replication을 통해 스키마 변경이 자동으로 전파됩니다.

**Q: "Replica가 죽으면 어떻게 되나요?"**

현재 구조에서 Replica 커넥션 획득에 실패하면 예외가 전파되어 읽기 요청이 실패합니다. 자동 failover는 미구현입니다. `AbstractRoutingDataSource`의 `lenientFallback`은 lookup key가 매핑에 없을 때만 동작하고, DataSource가 등록되어 있지만 커넥션 실패인 경우에는 적용되지 않습니다. 자동 failover를 구현하려면 `getConnection()` override + try-catch + Primary fallback이 필요한데, 서킷 브레이커, 헬스체크 등 복잡도가 높아서 이 프로젝트에서는 Grafana 알림 + 수동 대응으로 판단했습니다. Free Tier 물리 서버 장애 빈도가 매우 낮기 때문입니다.

**Q: "1,215만 건 덤프는 얼마나 걸리나요?"**

posts 테이블에 LONGTEXT content가 포함되어 있어 덤프 파일이 수십 GB에 달할 수 있습니다. `--single-transaction --quick`으로 행 단위 스트리밍 덤프를 하면 메모리를 절약하면서 Primary 쓰기도 계속 가능합니다. 다만 덤프 동안 undo log가 증가하고 metadata lock이 DDL을 차단할 수 있으므로, 서비스 트래픽이 적은 새벽 시간대에 실행합니다. 실제로는 mysqldump에서 문제가 발생하여 CLONE PLUGIN으로 전환했고, 133.5GB를 ~83MB/s로 약 28분 만에 복사 완료했습니다.

---

## App 스케일아웃 + Nginx L7 로드밸런싱

**Q: "앱을 2대로 늘린 이유는?"**

Replication After 측정에서 100 VU 부하 시 App CPU가 100%에 도달하여 에러율 13.25%, P95 2.3초가 발생했습니다. 병목은 Lucene BM25 스코어링과 Nori 형태소 분석으로, CPU-bound 연산입니다. MySQL은 InnoDB 히트율 99.5%, Slow Query 0건으로 여유 있었고, Redis도 Lettuce P95 3ms로 병목이 아니었습니다. Oracle Cloud에서 서버 스펙 변경이 불가하므로, 서버 2에 App 인스턴스를 추가하여 CPU 2코어를 확보하는 스케일아웃이 유일한 선택지였습니다.

**Q: "Lucene 인덱스 동기화는 어떻게 했나요?"**

MySQL Primary-Replica와 동일한 패턴을 적용했습니다. Nginx에서 HTTP 메서드 기반 라우팅으로 쓰기(POST/PUT/DELETE)를 App 1(Lucene Primary)로 고정하고, 읽기(GET)를 양쪽에 분산합니다. App 2의 Lucene은 5분 주기 rsync로 App 1의 인덱스를 복사합니다. 단순 rsync만으로는 안전하지 않습니다 — rsync는 파일 복사 순서를 보장하지 않아 segments_N이 세그먼트 파일보다 먼저 도착할 수 있고(LUCENE-628), IndexWriter 머지 중 세그먼트가 삭제될 수도 있습니다. 이를 해결하기 위해 두 가지 메커니즘을 적용합니다: App 1 측 `SnapshotDeletionPolicy`로 세그먼트 삭제를 방지하고, App 2 측 Refresh Pause로 rsync 중 `maybeRefresh()` 발동을 차단합니다.

**Q: "NFS로 Lucene 인덱스를 공유하면 안 되나요?"**

NFS는 단일 인덱스를 유지할 수 있다는 장점이 있지만, Lucene MMapDirectory는 로컬 디스크의 OS 페이지 캐시를 활용하여 성능을 최적화합니다. NFS를 사용하면 매 검색 I/O마다 네트워크 왕복이 발생하여 검색 성능이 크게 저하됩니다. rsync로 로컬 복사본을 유지하는 것이 성능과 단순성 모두에서 우수합니다.

**Q: "왜 모든 요청을 round-robin으로 분배하지 않고 쓰기를 App 1로 고정했나요?"**

Lucene IndexWriter는 단일 프로세스에서만 사용할 수 있습니다(write.lock). 두 App이 각자 로컬 Lucene에 쓰면 인덱스 불일치가 발생합니다. 쓰기를 App 1로 고정하는 것이 가장 단순하면서도 일관성을 보장하는 방법입니다. 쓰기는 전체 트래픽의 10-20%이므로 App 1에 집중되어도 부하 불균형은 미미합니다.

**Q: "TokenBlacklist를 왜 Redis로 옮겼나요?"**

기존 Caffeine 기반 TokenBlacklist는 JVM 로컬 메모리에 저장됩니다. App 2대 환경에서 사용자가 App 1에서 로그아웃하면 App 1의 Caffeine에만 블랙리스트가 기록되고, App 2는 이를 모릅니다. Redis로 전환하면 양쪽 App이 같은 블랙리스트를 공유합니다. TTL은 JWT 전체 만료시간이 아니라 **현재 시점부터 만료까지 남은 시간**으로 설정합니다. Redis 장애 시에는 보수적 정책(모든 토큰 거부)을 적용하여 보안을 우선합니다.

**Q: "Nginx에서 `if` 대신 `map`을 쓴 이유는?"**

Nginx 공식 위키에서 `if` 디렉티브를 `location` 블록 내에서 사용하는 것을 'if is evil'로 경고합니다. `map`은 설정 로드 시 해시 테이블을 컴파일하고, 요청 시 O(1) 해시 lookup으로 변수를 평가합니다(lazy evaluation). `proxy_pass http://$variable`과 안전하게 조합됩니다.

**Q: "로드밸런싱 알고리즘으로 `least_conn`을 선택한 이유는?"**

검색 요청은 Lucene BM25 스코어링으로 수십~수백 ms 걸리고, 캐시 히트 요청은 ~1ms입니다. `round-robin`은 이 편차를 무시하고 순차 분배하므로, 느린 검색 요청이 몰린 인스턴스가 과부하될 수 있습니다. `least_conn`은 현재 활성 커넥션이 적은 쪽으로 분배하여, 처리시간이 긴 요청이 집중되는 것을 방지합니다.

**Q: "App 2가 죽으면 어떻게 되나요?"**

Nginx의 `max_fails=3 fail_timeout=30s` 설정에 의해 App 2가 3회 연속 실패하면 30초간 풀에서 제외됩니다. 모든 요청이 App 1로 라우팅되어 서비스는 지속됩니다.

**Q: "App 1이 죽으면 어떻게 되나요?"**

읽기 요청은 App 2가 처리하여 검색/조회 서비스는 유지됩니다. 하지만 쓰기 요청은 App 1로 고정(Lucene Primary)되어 있으므로 게시글 생성/수정/삭제가 실패합니다. 자동 failover는 복잡도가 높아 미구현입니다.

**Q: "Lucene replica 모드에서 SearcherManager는 어떻게 새 세그먼트를 감지하나요?"**

SearcherManager를 Directory에서 직접 생성하면, `maybeRefresh()` 호출 시 `DirectoryReader.openIfChanged()`를 실행합니다. Directory 기반 SearcherManager는 committed 변경사항만 감지합니다. Replica 모드에서는 rsync 주기(5분) + refresh 주기(30초) = 최대 ~5.5분 지연이 있습니다.

**Q: "rsync로 Lucene 인덱스를 복사하는 게 안전한가요?"**

rsync는 파일 복사 순서를 보장하지 않습니다. `SnapshotDeletionPolicy`로 커밋 포인트의 세그먼트 파일을 삭제에서 보호하고, App 2 측 Refresh Pause로 rsync 중 `maybeRefresh()` 발동을 차단합니다. Lucene 커미터 Mike McCandless도 'rsync 시 SnapshotDeletionPolicy를 사용하라'고 권고합니다.

**Q: "선형 확장이 안 되는 이유는? Amdahl's Law인가요?"**

Amdahl's Law는 직렬 분율만 고려합니다. 실제로는 coherence penalty(App 2가 서버 1의 Redis에 네트워크로 접근하는 오버헤드, 인스턴스 간 캐시 중복 등)도 존재합니다. Neil Gunther의 USL(Universal Scalability Law)이 이를 더 정확히 모델링합니다.

**Q: "Redis가 죽으면 TokenBlacklist는 어떻게 되나요?"**

보수적 정책을 적용하여 Redis 연결 실패 시 `true`(블랙리스트됨)를 반환합니다. 정상 토큰도 일시적으로 거부되지만, 로그아웃된 토큰이 통과하는 보안 구멍보다 낫습니다.

**Q: "App 1이 stateful(Lucene Primary)인데 이게 진정한 스케일아웃인가요?"**

읽기(80-90%)는 완전한 stateless 분산이고, 쓰기(10-20%)만 App 1에 affinity가 있습니다. CPU 병목은 읽기 경로에 있으므로, 읽기 분산만으로도 핵심 병목이 해소됩니다. MySQL도 쓰기는 Primary 고정이지만, 이를 스케일아웃이 아니라고 하지는 않습니다.

---

## 조회수 Redis INCR + 배치 flush

**Q: "조회수를 왜 Redis로 옮겼나요?"**

App 스케일아웃에서 GET 요청이 2대에 분산되는데, 기존 `incrementViewCount()`가 `@Transactional` DB UPDATE를 하고 있었습니다. `AbstractRoutingDataSource`로 R/W 분리 중인 환경에서, GET 안의 write 호출이 간헐적으로 Replica에 UPDATE를 시도하여 `read-only` 에러가 발생했습니다. Redis INCR로 전환하여 GET에서 DB 쓰기를 완전히 제거했습니다. 30초 주기로 DB에 배치 flush합니다. Sentry, YouTube 등에서 검증된 Write-Behind 패턴입니다.

**Q: "트랜잭션을 분리하면(REQUIRES_NEW) 되지 않나요?"**

`REQUIRES_NEW`로 R/W 라우팅 문제 자체는 해결되지만, 매 GET마다 DB UPDATE가 여전히 실행되므로 Primary MySQL 부하는 동일하고, 100 VU 동시 접속 시 InnoDB 배타적 행 잠금(X Lock)이 발생하여 트랜잭션이 직렬화됩니다. Redis INCR은 R/W 충돌, Row Lock, DB 부하, 커넥션 소비, 동시성 5가지 문제를 전부 해결합니다.

**Q: "낙관적 락이나 비관적 락으로 동시성만 해결하면 안 되나요?"**

두 방식 모두 매 GET마다 Primary MySQL에 UPDATE를 실행한다는 근본 문제가 동일합니다. 이 문제의 핵심은 '동시성'이 아니라 'GET 요청에서 DB 쓰기가 발생하는 구조'입니다.

**Q: "Redis 대신 Caffeine 로컬 캐시로 카운터를 누적하면 안 되나요?"**

App 재시작 시 카운터 유실, 멀티 인스턴스에서 중복 방지 불가, 관측성 부재 3가지 문제가 있습니다. 결국 중복 방지를 위해서라도 Redis가 필요하므로, 처음부터 Redis INCR을 사용하는 것이 합리적입니다.

**Q: "Redis가 죽으면 조회수는 어떻게 되나요?"**

`increment()`에서 `RedisConnectionFailureException`을 catch하고 로그만 남깁니다. 게시글 조회 자체는 정상 반환됩니다. 최대 30초간의 조회수가 유실될 수 있지만, 커뮤니티에서 조회수는 '대략적인 인기도 지표'이므로 허용 가능합니다.

**Q: "새로고침으로 조회수를 올릴 수 있지 않나요?"**

프로덕션에서는 `SET post:viewed:{sessionId}:{postId} 1 NX EX 86400`으로 24시간 내 동일 사용자 중복을 방지합니다. Redis의 `SET NX EX`는 원자적이라 레이스 컨디션이 없고, TTL로 자동 만료됩니다. 향후 개선 항목으로 기록해두었습니다.

**Q: "`keys()` 명령은 프로덕션에서 위험하지 않나요?"**

맞습니다. Redis `KEYS` 명령은 O(N)이고 프로덕션에서 블로킹 위험이 있습니다. 현재 규모에서는 문제없지만, 스케일 시 `SCAN` 커서 기반 반복으로 전환하거나, flush 대상 키를 별도 Set으로 관리하는 방식으로 개선해야 합니다.

---

## 시스템 디자인: 대규모 자동완성 시스템

> 이 섹션은 wikiEngine 프로젝트의 구현이 아닌, **수십억 쿼리 규모의 검색 자동완성** 시스템 설계 면접 답안이다. [Trie 자동완성](/blog/project/wikiengine/trie-autocomplete)에서 학습한 내용을 대규모로 확장한 사고 실험.

**Q: "수십억 사용자 규모의 자동완성 시스템을 설계해보세요"**

요구사항부터 정리합니다. 한국어·영어 지원, 자동완성 제안 10개, 최근 24시간 인기 검색어 기반, 최대 응답 시간 240ms, 데이터 신선도 최대 1시간 지연 허용, 최종 일관성(Eventual Consistency). API는 `GET /complete?q=`(자동완성)과 `GET /search?q=`(검색, 내부적으로 순위 업데이트) 두 개입니다. 영어는 소문자 정규화, 한국어는 자모(Jamo) 분해 정규화(`한` → `ㅎ+ㅏ+ㄴ`)를 적용합니다.

핵심 관찰은 읽기(자동완성, 240ms 미만)와 쓰기(순위 업데이트, 느려도 됨)의 성능 요구사항이 완전히 다르다는 것입니다. CQRS 패턴으로 분리하여, AutoComplete Service(읽기 최적화 KV 저장소)와 AutoComplete Updater Service(검색어 수집 + 배치 처리)를 독립 운영합니다. 데이터 신선도 1시간 허용이므로 실시간이 아닌 배치 처리(MapReduce)로 접두사→Top-K 매핑을 생성하고, CDC로 변경분만 AutoComplete Service에 전파합니다.

**Q: "Trie를 쓰면 안 되나요?"**

순수(naive) Trie는 이 규모에서 부적합합니다. 영어는 노드당 26개 분기지만, 한국어를 음절 단위로 처리하면 노드당 **11,172개**(가~힣) 분기가 발생합니다. 자모 분해로 줄여도 68개(초성 19 + 중성 21 + 종성 28)로 영어의 2.6배입니다. 수십억 검색어 × 양 언어 지원이면 단일 서버 메모리를 초과합니다. 또한 1~2글자 접두사에 대해 모든 하위 분기를 순회하고 인기순 정렬하는 비용이 과도합니다.

**하지만 모든 Trie 계열이 부적합한 것은 아닙니다.** Elasticsearch의 Completion Suggester는 FST(Finite State Transducer, 접미사 공유로 메모리 극적 축소) 기반이고, PruningRadixTrie는 각 노드에 자식의 최대 rank를 저장하여 비유망 분기를 pruning해 표준 Trie 대비 1000배 빠른 prefix search를 달성합니다 ([wolfgarbe/PruningRadixTrie](https://github.com/wolfgarbe/PruningRadixTrie)). 실제 대규모 시스템은 **오프라인에서 FST/PruningRadixTrie로 매핑을 생성하고, 온라인 서빙은 flat KV lookup(O(1))**으로 수행하는 2단계 구조입니다.

**Q: "한국어 자동완성은 영어와 뭐가 다른가요?"**

근본적으로 다릅니다. 영어는 알파벳이 곧 입력 단위(`h` → `ho` → `how`)지만, 한국어는 자모 조합 과정에서 **음절 자체가 변형**됩니다(`ㅎ` → `하` → `한` → `한ㄱ` → `한구` → `한국`). 미완성 음절(`ㅎ`, `한ㄱ`) 상태에서도 자동완성이 동작해야 합니다.

해결은 **자모 분해**입니다. `한국`을 `ㅎㅏㄴㄱㅜㄱ`으로 분해하여 접두사 키로 사용하면, `ㅎ` 입력만으로 `한국`, `해외`, `호텔` 등 모든 ㅎ 시작 음절을 매칭할 수 있습니다. 분기 수도 11,172 → 68로 축소됩니다. 네이버·다음 같은 한국 포털은 자모 분해 + 초성 검색(`ㅎㄱ` → `한국`, `학교`)을 병행합니다.

단, 같은 음절 수라도 한국어가 영어보다 자모가 많아서 Map 단계 출력량과 자동완성 API 호출 수가 더 많습니다. `bat`(3글자)은 접두사 3개, `한국`(2음절)은 자모 분해 시 접두사 6개.

**Q: "MapReduce는 레거시 아닌가요?"**

맞습니다. Google 자체가 2014년부터 내부 MapReduce 사용을 줄이고 Dremel/BigQuery로 전환했습니다. 이 설계에서 MapReduce를 사용하는 건 **개념적 설명**을 위해서이고, 프로덕션에서는 Apache Flink(이벤트 단위 실시간, 2025-26년 스트림 처리 de facto 표준), Kafka Streams(경량, 별도 클러스터 불필요), Spark Structured Streaming(마이크로배치) 등 현대적 스트림 처리 기술을 사용합니다.

아키텍처 관점에서는 배치(MapReduce) + 실시간(스트리밍)을 이중 운영하는 **Lambda 아키텍처**와, 스트리밍 단일 경로로 통합하는 **Kappa 아키텍처**가 있습니다. 현대 자동완성 시스템은 대부분 Kappa(Flink + Kafka)에 가깝습니다. 이 설계에서 "1시간 신선도"를 요구했으므로 배치도 이론적으로 충분하지만, 실시간성을 높이려면 Kappa로 전환하여 수 분 단위 신선도를 달성할 수 있습니다.

**Q: "핫스팟 문제는 어떻게 해결하나요?"**

접두사→제안 매핑을 해시 기반으로 샤딩하면 **데이터 분산**은 되지만 **부하 분산**이 안 됩니다. 1글자 접두사(`ㅎ`, `s`)가 3글자보다 훨씬 많이 조회되므로, 인기 키가 있는 샤드에 트래픽이 집중됩니다(핫스팟).

해결은 **동적 복제**(Meta Shard Manager, [SOSP 2021](https://dl.acm.org/doi/pdf/10.1145/3477132.3483546))입니다. 각 호스트가 네트워크 트래픽·CPU 사용률을 Shard Manager에 보고하면, 상한 초과 시 읽기 전용 복제본을 추가 프로비저닝하고, 하한 미달 시 제거합니다. CockroachDB의 Load-Based Splitting(range 자동 분할)이나 DynamoDB의 Adaptive Capacity도 유사 패턴입니다.

현실적으로는 자동화된 Shard Manager를 직접 구현하기보다 Redis Cluster 자동 rebalancing이나 Vitess(MySQL 샤딩 표준)를 활용하고, 모니터링 + 수동 스케일링으로 시작하는 것이 일반적입니다.

**Q: "1% 샘플링이면 정확한가요?"**

검색어 빈도는 Zipf 분포를 따릅니다. 상위 1%가 전체 트래픽의 ~20%, 상위 10%가 ~60%를 차지합니다 ([PMC 연구](https://pmc.ncbi.nlm.nih.gov/articles/PMC4176592/)). 이 극단적 skew 덕분에 1% 샘플(시간당 400만 건)에서도 상위 검색어의 상대적 순위가 안정적으로 보존됩니다.

한계는 Long tail 검색어(빈도 1~2회)의 순위 불안정과 신규 trending 검색어 미탐지입니다. Top-10 자동완성에는 영향 없지만, trending 감지가 필요하면 별도 실시간 레이어(Flink 등)를 보완합니다. 대안으로 Count-Min Sketch(고정 메모리 빈도 근사)나 HyperLogLog(cardinality 추정) 같은 확률적 자료구조를 병행하면 메모리 효율과 정확도를 동시에 확보할 수 있습니다.

**Q: "CDC를 어떻게 활용하나요?"**

MapReduce 결과를 DB에 쓸 때 CDC(Change Data Capture)로 **변경분만** AutoComplete Service에 전파합니다. 전체 갱신(TRUNCATE + INSERT)은 모든 행에 이벤트가 발생하여 폭증하고, 증분 갱신(UPSERT)은 실제 순위가 변경된 접두사만 이벤트가 발생합니다. 대부분의 접두사에 대한 top-10은 1시간 주기로 크게 변하지 않으므로, 증분 갱신으로 CDC 이벤트를 전체의 5~10% 수준으로 줄일 수 있습니다.

**Q: "글로벌 배포는 어떻게 하나요?"**

멀티 데이터센터로 고가용성(한 DC 장애 시 서비스 유지)과 낮은 대기시간(사용자 근접 DC 응답)을 확보합니다. 한국어 자동완성 데이터는 아시아 DC에 복제 우선순위를 높이고, 영어는 글로벌 균등 복제합니다.

---

## CDC (Change Data Capture) — 이벤트 기반 동기화

**Q: "왜 Kafka를 안 쓰고 Spring Event부터 시작하나요?"**

Kafka + Debezium은 최소 5~8G RAM이 필요합니다. Oracle Cloud Free Tier에서 서버 2대의 여유 메모리로는 부족합니다. 하지만 문제의 핵심은 '메시지 브로커가 없다'가 아니라 'PostService가 6개 Read Model에 직접 결합되어 있다'입니다. Spring ApplicationEvent로 디커플링하면, 나중에 Kafka로 전환할 때 EventHandler만 Consumer로 교체하면 됩니다. 이 점진적 진화는 실무에서도 일반적인 접근입니다 — 처음부터 Kafka를 도입하기보다, 먼저 이벤트 기반 구조를 잡고 인프라를 점진적으로 확장합니다.

**Q: "Spring Event는 이벤트가 유실될 수 있지 않나요?"**

맞습니다. `@TransactionalEventListener(AFTER_COMMIT)`는 커밋 후 같은 스레드에서 실행되므로, 리스너 실행 중 앱이 죽으면 이벤트가 유실됩니다. 하지만 이 프로젝트는 Spring Modulith 2.0.2를 사용하고 있어서, Modulith의 Event Publication Log를 활용할 수 있습니다. Event Publication Log는 이벤트를 DB 테이블에 기록하고, 리스너 실패 시 미완료 이벤트를 자동 재시도합니다. 이는 Transactional Outbox 패턴과 유사한 효과를 Spring Modulith가 프레임워크 수준에서 제공하는 것입니다.

**Q: "dual-write 문제가 실제로 발생한 적이 있나요?"**

[부하 테스트 튜닝](/blog/project/wikiengine/stress-test-tuning)(200 VU)에서 Lucene indexing이 IOException으로 실패한 케이스가 있었습니다. CPU 포화 상태에서 MMapDirectory I/O 타임아웃이 발생하여, DB에는 게시글이 저장되었지만 Lucene 인덱스에는 없는 불일치가 발생했습니다. 현재는 `try-catch + log.error()`로만 처리하고 있어서, 이 불일치를 감지하거나 자동 복구하는 방법이 없습니다. CDC를 도입하면 이벤트 리플레이로 불일치를 복구할 수 있습니다.

**Q: "Transactional Outbox의 폴링이 DB에 부하를 주지 않나요?"**

1초 주기로 `SELECT * FROM outbox_events WHERE published = FALSE ORDER BY id LIMIT 100`을 실행합니다. `(published, id)` 복합 인덱스가 있으므로 Index Scan이고, 미발행 이벤트가 없으면 빈 결과를 즉시 반환합니다. 현재 MySQL QPS가 ~200 ops/s인 상황에서 1 ops/s 추가는 무시 가능합니다.

**Q: "멀티 인스턴스에서 Outbox 폴링 중복 처리는 어떻게 하나요?"**

`SELECT ... FOR UPDATE SKIP LOCKED`를 사용합니다. 한 인스턴스가 이벤트를 처리 중이면 다른 인스턴스는 해당 행을 건너뛰고 다음 행을 처리합니다. MySQL 8.0의 `SKIP LOCKED`는 InnoDB에서 지원되며, 큐 패턴에 최적화되어 있습니다.

**Q: "EventHandler 멱등성은 어떻게 보장하나요?"**

Lucene의 `updateDocument()`는 Term 기준으로 기존 문서를 삭제 후 재삽입하므로 자연 멱등적입니다. 캐시 `evict()`도 키가 없으면 no-op이라 멱등적입니다. 주의할 건 좋아요 카운터입니다 — `INCREMENT` 방식은 중복 실행 시 이중 증가하므로, 이벤트에 변경 후 절대값(예: likeCount=42)을 포함하여 `SET` 방식으로 갱신합니다. 설계 원칙은 '이벤트 핸들러는 SET, INCREMENT 금지'입니다.

**Q: "이미 Redis 쓰고 있는데 Redis Stream으로 하면 안 되나요? 왜 Kafka?"**

두 가지 이유로 Redis Stream은 적합하지 않습니다. 첫째, 자동완성은 1시간 지연을 허용하는 배치 처리 구조라 Redis Stream의 실시간 기능이 불필요합니다. 둘째, Kafka와의 근본적 차이가 있습니다: (1) Redis Stream은 메모리 기반이라 커널 패닉 시 유실 가능, Kafka는 디스크 기반 + replication으로 브로커 장애에도 보존. (2) Redis Stream은 MAXLEN 트리밍 시 영구 소실, Kafka는 retention으로 수 주 보존 + 리플레이 가능. (3) Redis Stream은 단일 스레드, Kafka는 파티션 기반 수평 확장. 검색 인덱스 손상 시 Kafka 토픽을 리플레이하여 재구축할 수 있다는 것은 결정적 이점입니다.

**Q: "볼륨도 작은데 왜 Kafka를 쓰나요? 오버엔지니어링 아닌가요?"**

두 가지로 답합니다. 첫째, **ROI 비교**입니다. Kafka 주간 운영 비용은 약 30분~1시간(Grafana 알림 자동 + 주 1회 5분 수동 점검)인데, dual-write 불일치가 발생하면 디버깅 + 전체 재인덱싱(28분) + 사용자 불만 대응에 수 시간이 소모됩니다. [부하 테스트 튜닝](/blog/project/wikiengine/stress-test-tuning)에서 실제로 Lucene indexing IOException이 발생한 바 있고, 이를 감지하는 메커니즘이 없는 상태였습니다. 둘째, **fallback 구조** 덕분에 Kafka가 죽어도 서비스는 `@ApplicationModuleListener`로 자동 전환됩니다. Kafka는 "평시의 정확성 보장"이고, fallback은 "장애 시 서비스 연속성 보장"으로 역할이 분리됩니다.

**Q: "KRaft 단일 브로커가 프로덕션에 적합한가요?"**

적합하지 않습니다. Confluent 공식 문서에서도 KRaft combined mode는 개발/테스트 전용이라고 명시합니다. 이 프로젝트에서는 Free Tier 메모리 제약(12G 서버)으로 단일 브로커를 택했고, `@ConditionalOnProperty` fallback으로 Kafka 장애 시 서비스 연속성을 확보했습니다. 프로덕션 확장 시에는 KRaft 3노드 컨트롤러 + 전용 브로커로 HA를 확보해야 합니다. 핵심은 "단일 브로커이므로 Kafka의 이점이 없다"가 아니라, "정상 동작 시 binlog 기반 모든 변경 캡처 + 이벤트 리플레이 + 양쪽 L1 캐시 무효화"가 확보되며, 장애 시에는 fallback이 커버한다는 것입니다.

**Q: "Elasticsearch를 쓰면 CDC 자체가 불필요하지 않나요?"**

Elasticsearch를 도입해도 MySQL → ES 동기화 문제는 동일합니다. ES 공식 문서에서도 Logstash JDBC Input이나 Debezium CDC를 권장합니다. 비용 비교: embedded Lucene + CDC는 6G RAM(Kafka 4G + Debezium 2G)인데, ES HA 구성은 최소 12G RAM(4G × 3노드)이고, AWS OpenSearch Serverless는 월 ~$200부터 시작합니다. Embedded Lucene은 검색 성능도 7~10배 빠릅니다(네트워크 홉 없이 직접 접근). 인프라 비용을 최소화하면서 같은 정확성을 달성하는 것이 embedded Lucene + CDC의 선택 이유입니다.

**Q: "Debezium CDC lag이 15~20분까지 발생할 수 있다는데, 어떻게 대응하나요?"**

Debezium Connector는 단일 스레드로 binlog을 소비하므로, 대량 DML 시 lag이 누적될 수 있습니다. 대응 전략은 세 가지입니다. 첫째, Prometheus + Grafana로 `MilliSecondsBehindSource` 메트릭을 모니터링하여 lag이 임계값(예: 5분)을 초과하면 알림. 둘째, topic별 partition을 늘려서 Consumer 병렬화. 셋째, 대량 배치 작업은 off-peak 시간에 실행. 일 200건 수준이므로 당장은 문제없지만, 확장 시 모니터링 체계부터 구축합니다.

**Q: "'직접 SQL 미감지'를 CDC의 핵심 이점으로 드셨는데, 관리자가 직접 SQL을 치는 일이 실제로 얼마나 있나요?"**

핵심은 PostService(ORM)를 통하지 않는 모든 DB 변경 경로가 문제라는 것입니다. 다섯 가지 경로가 있습니다: (1) Flyway 마이그레이션 스크립트의 UPDATE 배치, (2) 스팸 봇 게시글 일괄 삭제 등 긴급 데이터 수정, (3) `@Modifying` JPQL 벌크 연산, (4) MySQL Replication의 Primary/Replica 불일치, (5) 향후 서비스 확장 시 다른 모듈의 DB 접근. CDC는 MySQL이 이미 제공하는 변경 감지 인프라(binlog)를 재사용하는 것입니다.

**Q: "CDC 도입 과정에서 실제로 겪은 문제가 있나요?"**

배포 후 게시글 생성이 검색에 노출되지 않는 문제를 발견했습니다. 원인은 멀티 인스턴스 환경에서 CDC Consumer와 Lucene IndexWriter의 위치 불일치였습니다. App 2(Kafka와 같은 서버)에서 CDC Consumer가 이벤트를 수신했지만, App 2는 Lucene Replica(IndexWriter가 null)라 인덱싱이 skip됐습니다. App 1은 docker-compose에서 `SPRING_KAFKA_BOOTSTRAP_SERVERS` 환경변수 매핑이 빠져 있어서 Kafka 연결에 실패하고 있었습니다. 이 경험에서 현업에서 검색 인덱스가 앱에 embedded 되지 않는 이유를 체감했고, CDC 파이프라인은 end-to-end 검증 테스트가 필수라는 것을 배웠습니다.

---

## LTR 재랭킹 + 카테고리 자동 분류

> 출처: [LTR 재랭킹 + 카테고리 자동 분류](/blog/project/wikiengine/search-ltr-ranking)

**Q: "왜 Linear Model이 아니라 LambdaMART를 선택했나요?"**

OpenSource Connections의 분석에 따르면 "Elasticsearch boosts are nothing but coefficients in a linear regression"입니다. 같은 3개 피처(viewCount, likeCount, recency)로 Linear Model을 학습해도 기존 수동 가중치와 거의 동일한 결과가 나옵니다. tree model인 LambdaMART는 피처 간 interaction을 학습할 수 있습니다. 예를 들어 "titleLength가 짧으면서 tagOverlap이 높은 경우"처럼 비선형 관계를 포착합니다. 실제로 Feature Importance에서 titleLength(1.0)와 tagOverlap(0.9)이 최상위를 차지했습니다.

**Q: "LLM-as-a-Judge로 학습 데이터를 생성했는데, LLM 판정을 신뢰할 수 있나요?"**

SIGIR 2024(Thomas et al.) 연구에서 GPT-4의 relevance 판정이 crowdsource annotator와 Cohen's Kappa 0.6~0.7로 일치합니다. crowdsource 간 일치율이 0.4~0.6이므로 동등 이상입니다. 다만 LLM은 temperature=0이어도 완전 deterministic이 아니므로, 3회 호출 후 평균 반올림으로 분산을 줄였습니다. 이는 TREC LLMJudge 참가팀(RMIT-IR)이 사용한 방법입니다. 궁극적으로는 사용자 클릭 데이터(implicit feedback)로 전환할 계획이며, 클릭 로그 인프라를 이미 구축했습니다.

**Q: "1차 LLM 데이터 생성이 98% 실패한 근본 원인은?"**

라운드 간 딜레이 2초로 3회 호출이 약 6초, 분당 30요청으로 Gemini 무료 티어 15 RPM을 초과했습니다. Spring AI 기본 retry가 HTTP 429를 NonTransientAiException(4xx)으로 분류하여 재시도하지 않았고, 데이터가 메모리 전용(ArrayList)이라 status API에 성공/실패 구분이 없어 98% 실패를 인지하지 못했습니다. 딜레이를 5초로 변경하고(12 RPM), 지수 백오프 재시도, CSV append로 디스크 저장, resume 기능을 추가하여 해결했습니다.

**Q: "NDCG@10이 +4.8%p인데, train set에서는 0.9228이잖아요. 과적합 아닌가요?"**

맞습니다. train set 0.9228은 과적합이 반영된 수치이고, 면접에서 말하는 수치는 5-Fold Cross Validation 기준 0.7387(+-0.04)입니다. 10쿼리 200쌍 소규모 데이터에서 +4.8%p입니다. Sanderson & Zobel 연구에 따르면 100쿼리 기준 +5% 이상이면 통계적으로 감지 가능한 수준입니다. 학습 데이터를 늘리면(45쿼리 목표) 개선폭이 커질 것으로 예상합니다.

**Q: "LTR ON에서 72배 성능 악화인데, 왜 프로덕션에서 끄기로 결정했나요? 최적화할 수 없었나요?"**

근본 원인은 Rescore window 200에서 문서당 14개 피처 추출이 CPU-intensive하다는 것입니다. BM25 3필드 곱하기 200문서 = 600회 Scorer 생성 + Nori 토큰화가 2코어 ARM에서 포화됩니다. 현업에서는 피처 사전 계산(인덱스 타임에 피처를 stored field로 저장), 피처 캐싱, 전용 다코어 서버에서 처리합니다. 2코어 Free Tier에서는 이런 최적화를 해도 한계가 있습니다. LTR 파이프라인 전체(데이터 생성 → 학습 → 추론 → 평가)를 검증하는 것이 목적이었으므로, 기능 검증 완료 후 LTR_ENABLED=false로 비활성화하고 인프라 확장 시 재활성화합니다.

**Q: "XGBoost4J를 선택한 이유는? ONNX Runtime이나 다른 옵션은?"**

세 가지를 검토했습니다. xgboost-predictor-java는 XGBoost 2.x 모델 포맷(UBJSON)과 비호환이고 deprecated입니다. ONNX Runtime은 onnxmltools가 XGBRanker를 ONNX로 변환하는 것을 지원하지 않습니다(Issue #382). XGBoost4J는 Python save_model() 포맷을 변환 없이 직접 로드할 수 있고, ARM64 Linux 네이티브 라이브러리가 JAR에 번들되어 있으며, inplace_predict()가 thread-safe라서 DMatrix 생성 없이 flat float 배열로 직접 추론할 수 있습니다.

---

## 카테고리 검색 필터링 + Facet 집계

> 출처: [카테고리 검색 필터링 + Facet 집계](/blog/project/wikiengine/search-category-facet)

**Q: "카테고리 필터링을 왜 Lucene에서 하나? DB WHERE 절로 하면 안 되나?"**

검색은 Lucene이 처리하고 카테고리만 DB에서 필터하면 pagination이 깨집니다. Lucene이 20건을 반환한 뒤 DB에서 10건이 필터되면 페이지에 10건만 표시됩니다. Lucene에서 FILTER 절로 처리하면 처음부터 해당 카테고리 결과만 정확히 20건 반환합니다. 또한 Occur.FILTER는 Lucene 내부적으로 LRUQueryCache를 통해 bitset 캐싱되어 동일 카테고리 반복 검색 시 성능 이점이 있습니다.

**Q: "Occur.FILTER와 Occur.MUST의 차이가 뭔가요?"**

둘 다 필수 조건(문서가 반드시 매칭해야 함)입니다. 차이는 스코어 기여 여부입니다. MUST는 BM25 스코어에 영향을 주고, FILTER는 스코어에 기여하지 않습니다. 카테고리 필터는 "이 카테고리에 속하는가?"만 판단하면 되므로 관련도 스코어와 무관합니다. FILTER는 스코어를 계산하지 않기 때문에 Lucene의 쿼리 캐시(LRUQueryCache)에서 bitset으로 캐싱됩니다. 같은 카테고리로 반복 검색하면 캐시된 bitset을 재사용하여 더 빠릅니다.

**Q: "Facet을 DB GROUP BY로 한 이유는? Lucene에 네이티브 Facet API가 있지 않나?"**

Lucene의 SortedSetDocValuesFacetCounts는 SortedSetDocValuesFacetField 필드가 인덱스에 있어야 합니다. 현재 인덱스에는 LongField("categoryId")만 있고 SortedSetDocValuesField는 없습니다. 이 필드를 추가하려면 1,425만 건 전체 재색인이 필요한데, 재색인 인프라가 아직 없었습니다. DB GROUP BY로 간이 Facet을 먼저 제공하고, 재색인 인프라 구축 후 네이티브 Facet으로 전환했습니다.

**Q: "DB GROUP BY로 Facet을 하면 상위 1,000건만 집계하는 거 아닌가? 정확하지 않잖아?"**

맞습니다. 전체 매칭 문서가 아닌 BM25 Top-1,000에 대한 근사 집계입니다. 하지만 검색 엔진에서 사용자가 관심 있는 건 상위 결과의 분포이지, 10만 번째 결과의 카테고리가 아닙니다. 상위 1,000건의 카테고리 분포는 전체와 유사한 경향을 보이므로 UX 관점에서 충분합니다. 정확한 집계가 필요해지면 재색인 시 Lucene Facet API로 전환합니다.

---

## 쿼리 확장 + Query Understanding

> 출처: [쿼리 확장 + Query Understanding](/blog/project/wikiengine/search-query-enhancement)

**Q: "동의어를 인덱스 타임이 아니라 쿼리 타임에 확장한 이유는?"**

인덱스 타임 동의어(SynonymGraphFilter)는 인덱스에 동의어 term을 추가하여 document frequency를 인위적으로 높입니다. "AI"를 인덱싱할 때 "인공지능"도 함께 추가하면, "인공지능"의 DF가 실제보다 부풀려져 BM25 IDF 계산이 왜곡됩니다. 해당 term의 가중치가 낮아져 검색 품질이 저하됩니다. 쿼리 타임 확장은 인덱스 term 통계가 불변이므로 이 문제가 없습니다. 또한 동의어 추가/삭제 시 재색인이 불필요하여 운영 유연성이 높습니다.

**Q: "DirectSpellChecker는 한국어에서 어떤 한계가 있나요?"**

DirectSpellChecker는 Damerau-Levenshtein 편집 거리 기반으로 동작하는데, 한국어 음절 단위로 비교합니다. "컴퓨텨"에서 "컴퓨터"는 편집 거리 1이라 잡히지만, 자모 레벨의 미세한 오타는 음절 단위에서 편집 거리가 1 이상이 될 수 있어 교정이 불안정합니다. 또한 Nori가 복합어를 분해하므로 인덱스 term이 원형과 다를 수 있어, 인덱스에 해당 term 자체가 없으면 후보를 찾지 못합니다. 이 한계는 검색 로그 기반 "Did you mean?" 시스템으로 보강합니다.

**Q: "BM25 기본값(k1=1.2, b=0.75)을 왜 그대로 썼나요? 튜닝은 안 했나요?"**

BM25 변형(BM25+, BM25L, BM25F) 간 비교 연구를 검토했습니다. 뉴스 코퍼스 3개 대상 실험에서 변형 간 유의미한 성능 차이는 없었습니다. MultiFieldQueryParser로 title:3, content:1 가중치를 이미 적용 중이므로 BM25F(필드별 가중치)의 효과를 일부 대체하고 있습니다. 기본값에서 시작하고, 검색 품질 이슈가 실제로 발생하면 k1/b 파라미터를 조정하는 것이 합리적 순서입니다.

**Q: "UnifiedHighlighter에서 content를 Store.YES로 하지 않고 snippetSource 500자만 저장한 이유는?"**

content 전체를 Store.YES로 하면 1,425만 건 곱하기 평균 6,586자 = 인덱스 크기 100GB 이상으로 폭증합니다. 앞 500자만 별도 StoredField로 저장하면 약 7GB 추가로 인덱스 42GB 수준입니다. 검색어가 문서 앞부분 500자 안에 있을 확률이 높고(제목, 서론, Infobox), 500자 밖의 검색어는 DB 조회 후 자르는 기존 방식으로 fallback합니다. 인덱스 크기와 snippet 품질 사이의 트레이드오프를 선택한 것입니다.

**Q: "무중단 재색인을 어떻게 구현했나요?"**

새 디렉토리에 전체 색인을 수행한 뒤, 심볼릭 링크를 원자적으로 교체(Files.move ATOMIC_MOVE)합니다. 핵심은 심볼릭 링크 교체만으로는 부족하다는 점입니다. MMapDirectory는 파일을 메모리에 매핑하므로, 심볼릭 링크를 교체해도 이미 매핑된 파일은 이전 디렉토리를 계속 참조합니다. 따라서 SearcherManager를 닫고 새 Directory로 재생성해야 합니다. 재색인 중 증분 인덱싱은 AtomicBoolean 플래그로 차단하되, CDC 이벤트는 Kafka에 남아있으므로 재색인 완료 후 자동 재처리됩니다.

**Q: "Nori 사용자 사전 158,539개는 어디서 가져왔나요?"**

수동 복합어 30개 + open-korean-text 프로젝트(Apache 2.0 라이선스)의 wikipedia_title_nouns 158,509개를 합쳐 총 158,539개입니다. 위키피디아 제목 명사는 복합어 보존이 필요한 고유명사를 포함하고 있어 Nori의 과도한 분해를 방지하는 데 적합합니다. 사용자 사전 변경 시 Analyzer가 바뀌므로 전체 재색인이 필요합니다.

---

## 콘텐츠 필터링 - 운영 안전장치

> 출처: [콘텐츠 필터링 - 운영 안전장치](/blog/project/wikiengine/search-content-filter)

**Q: "금칙어 필터링을 왜 Aho-Corasick으로 했나요? String.contains() 루프면 안 되나요?"**

String.contains() 루프는 O(N 곱하기 M) 시간이 걸립니다(N=텍스트 길이, M=금칙어 수). 금칙어가 16,090개이므로 매 텍스트마다 16,090번 순회합니다. Aho-Corasick은 Trie에 failure link를 추가하여 텍스트를 한 번만 순회하면서 모든 패턴을 동시에 매칭합니다. O(N+Z)로 금칙어 수에 무관합니다(Z=매칭 수). 자동완성 결과 필터링처럼 요청마다 실행되는 곳에서 성능 차이가 유의미합니다.

**Q: "영어 금칙어에서 Scunthorpe 문제를 어떻게 처리했나요?"**

영어 금칙어는 단어 경계(word boundary) 매칭을 적용합니다. "ass"를 금칙어로 등록해도 "assassination", "class", "Scunthorpe" 같은 정상 단어는 차단하지 않습니다. 한국어는 교착어 특성상 부분 일치가 더 적합합니다. "매춘"을 등록하면 "매춘부", "매춘업소" 등 합성어까지 모두 잡아야 하기 때문입니다. 따라서 한국어 Trie(부분 일치)와 영어 Trie(단어 경계)를 분리하여 운영합니다.

**Q: "블라인드 게시글을 왜 Lucene 인덱스에서 삭제하지 않고 MUST_NOT으로 필터했나요?"**

복원 가능성 때문입니다. 블라인드는 "검색에서 숨기기"이지 "삭제"가 아닙니다. 관리자가 리뷰 후 반려하면 블라인드를 해제하고 검색에 복원해야 합니다. 인덱스에서 삭제하면 복원 시 재인덱싱이 필요하지만, blinded=true 필드를 두고 MUST_NOT으로 필터하면 blinded=false로 업데이트만 하면 즉시 검색에 복원됩니다.

**Q: "Negative Caching의 TTL을 30초로 정한 근거는?"**

앱 기동 시 Lucene SearcherManager 초기화(42GB 인덱스 로딩)가 수 초에서 수십 초 걸립니다. 이 시간 동안 검색 결과가 0건이고, 이를 캐시하면 인덱스 로딩 완료 후에도 빈 결과가 유지됩니다. 30초면 인덱스 로딩이 완료된 후 캐시가 만료되어 다음 요청에서 정상 결과를 반환합니다. 빈 결과를 아예 캐시하지 않으면 cache penetration(동일 쿼리가 매번 origin까지 관통)이 발생합니다.

---

## AI 검색 요약 - RAG

> 출처: [AI 검색 요약 - RAG](/blog/project/wikiengine/search-rag)

**Q: "왜 벡터 검색(Dense Retrieval)이 아니라 BM25를 Retrieval로 썼나요?"**

wikiEngine은 위키피디아/나무위키 데이터 기반으로 기술 용어 키워드 검색이 주 사용 패턴입니다. 키워드가 명확한 도메인에서는 BM25가 Dense Retrieval보다 우수할 수 있습니다. RAG 비교 실험에서 BM25는 키워드 전용 쿼리 NDCG 0.88로 Dense Retrieval(혼합 쿼리 0.65)보다 높았습니다. Anthropic RAG 가이드에서도 기술 용어, 법률/과학 문서 등 키워드가 명확한 도메인에서는 BM25가 강력한 baseline이라고 평가합니다. "AI"에서 "인공지능" 수준의 의미 확장은 쿼리 타임 동의어 확장으로 이미 해결되었으므로, 벡터 검색 도입의 ROI가 낮습니다.

**Q: "할루시네이션을 어떻게 방지했나요?"**

네 가지 전략입니다. 첫째, 시스템 프롬프트에 "제공된 문서만 참고하여 답변하세요"를 명시합니다. 둘째, 답변에 [문서 N] 형태의 인용을 필수로 요구합니다. 셋째, 검색 결과 BM25 스코어가 임계값 미만이면 AI 요약 자체를 스킵합니다. 넷째, 사용자 피드백으로 품질을 지속 모니터링하고, 부정적 피드백이 집중되는 쿼리 패턴을 분석하여 프롬프트를 개선합니다.

**Q: "AI 요약 트리거 조건은 어떻게 결정했나요?"**

모든 검색에 AI 요약을 생성하면 LLM API 비용이 낭비됩니다. 네비게이션 의도("네이버", "구글")는 사용자가 해당 사이트에 가고 싶은 것이지 설명을 원하는 게 아니므로 스킵합니다. 물음표 쿼리("자바 GC?")는 결과 1건이라도 AI 답변합니다. Google AI Overviews에서도 질문형 쿼리의 AI 요약 출현율이 28에서 38%로 가장 높습니다. 일반 쿼리는 결과 3건 이상일 때만 AI 답변합니다.

**Q: "Rate Limiting을 AtomicInteger에서 Redis로 전환한 이유는?"**

서버가 2대이기 때문입니다. AtomicInteger는 JVM 단위이므로 서버별로 독립적인 카운터가 됩니다. 서버 A에서 5건, 서버 B에서 5건 = 실제 10건인데 각 서버는 5건으로 인식합니다. Gemini 무료 티어가 15 RPM이므로 10 RPM 전역 제한을 걸어 버퍼를 두었습니다. Redis INCR + EXPIRE로 전역 공유 카운터를 구현합니다. Redis 장애 시에는 rate limit을 통과시키고, Gemini 자체 429 응답으로 2차 방어합니다.

**Q: "동일 쿼리 캐싱 TTL을 30분으로 정한 근거는?"**

LLM 답변은 시간에 민감하지 않습니다. 같은 검색어에 대한 위키피디아 기반 답변은 30분 사이에 바뀌지 않습니다. 현업 기준 검색 엔진에서 동일 쿼리 반복률은 30% 이상입니다. TTL 30분이면 대부분의 반복 쿼리가 캐시 히트되어 Gemini 호출 없이 즉시 SSE 전송됩니다. LLM 비용을 40에서 60% 절감할 수 있습니다. TTL을 더 길게 잡으면 Redis 메모리 사용량이 증가하고, 더 짧게 잡으면 캐시 히트율이 떨어집니다. 30분은 비용 절감과 메모리 사용의 균형점입니다.

**Q: "snippetSource에 raw 위키 마크업이 저장되어 snippet이 빈 문자열로 반환되는 문제를 어떻게 해결했나요?"**

Wikipedia CirrusSearch 패턴을 참고했습니다. CirrusSearch는 source_text(raw)와 text(clean)을 별도 필드로 관리하고, 검색/하이라이팅은 clean text만 사용합니다. raw 마크업을 stored field에 저장하고 쿼리 타임에 정리하는 것은 안티패턴입니다. 인덱스 타임에 마크업을 정리한 clean text를 저장하는 것이 업계 표준입니다. 원본 1,500자에서 마크업을 정리하여 500자 clean text를 확보합니다.

**Q: "배포 시 Flyway 마이그레이션이 Replica에 전파되지 않는 문제를 어떻게 발견하고 해결했나요?"**

운영 배포 후 ai_summary_feedback 테이블과 blinded 컬럼이 Replica에 없어서 읽기 쿼리가 실패했습니다. MySQL Replication이 끊겨 있었기 때문입니다. Primary에서 Flyway V4 마이그레이션이 실행되었지만, DDL이 Replica에 전파되지 않았습니다. Replica에 수동으로 테이블과 컬럼을 추가하고, Replication을 재연결했습니다. 교훈은 세 가지입니다: Flyway 마이그레이션 후 Replica 전파 확인 체크리스트 필요, MySQL Replication 상태를 모니터링해야 함, ddl-auto validate(운영)와 update(로컬) 차이를 인지해야 합니다.

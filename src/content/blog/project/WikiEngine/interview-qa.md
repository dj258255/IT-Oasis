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

13단계 App 스케일아웃의 전제조건입니다. 현재 MySQL은 병목이 아니지만(InnoDB 버퍼 풀 히트율 99.5%, Table Lock 0), App을 2대로 늘리면 HikariCP 커넥션이 40개(20×2)로 단일 MySQL에 집중됩니다. 미리 읽기를 Replica로 분리하면 Primary는 쓰기(~50 ops/s)만, Replica는 읽기(~200 ops/s)를 담당하여 스케일아웃 시 DB가 병목이 되지 않습니다. 실측 결과 Replication Lag은 부하 시에도 0~1초로 커뮤니티 서비스에 영향 없었습니다.

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

**Q: "1,425만 건 덤프는 얼마나 걸리나요?"**

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

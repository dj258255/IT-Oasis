---
title: 'WikiEngine 면접 예상 질문 모음'
titleEn: 'WikiEngine Interview Q&A Collection'
description: WikiEngine 프로젝트 전체에서 나올 수 있는 면접 예상 질문과 답변을 정리합니다.
descriptionEn: Collection of expected interview questions and answers from the WikiEngine project.
date: 2026-03-19T00:00:00.000Z
tags:
  - Interview
  - WikiEngine
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

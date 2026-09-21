---
title: 'Spring 백엔드 개발자가 성능 지표를 읽는 법'
description: 'Latency, throughput, concurrency, connection pool, cache, CPU 지표를 각각의 정의로 외우는 대신 어디에서 만나고 어떻게 이어지는지로 정리한다. RED와 USE, 그리고 장애에서 요청이 어디서 기다리는지 따라가는 순서.'
date: 2026-09-20
tags:
  - Performance
  - Latency
  - Throughput
  - Concurrency
  - Connection Pool
  - HikariCP
  - Cache
  - CPU
  - Observability
  - Spring Boot
category: theory/Performance
coverImage: /uploads/covers/theory/reading-performance-metrics.svg
draft: false
---

백엔드 개발을 하다 보면 이런 말을 자주 접한다.

- "p99 latency가 튄다."
- "throughput이 더 이상 안 나온다."
- "connection pool이 포화됐다."
- "CPU utilization은 낮은데 saturation이 발생했다."
- "cache hit rate가 떨어졌다."
- "동시성을 높였더니 오히려 느려졌다."

처음에는 각각 별개의 용어처럼 보인다. 그런데 성능 테스트나 장애 분석을 해보면 이 숫자들은 대부분 연결되어 있다.

예를 들어 API가 느려졌다고 해보자.

![API 하나가 느려질 때 트래픽 증가에서 시작해 DB 요청, 쿼리 지연, 커넥션 반환 지연, 풀 대기를 거쳐 API p95 증가로 이어지는 흐름](/uploads/theory/reading-performance-metrics/perf-metric-chain.svg)

그래서 각각의 정의를 외우는 것보다 **어디에서 이 지표를 만나고 다른 지표와 어떤 관계가 있는지** 이해하는 쪽이 오래 남는다. 이 글은 `Latency → Throughput → Concurrency → Connection Pool → Cache → CPU → Availability`를 그 관계로 이어 정리한다.

## 1. Latency: 요청 하나가 얼마나 걸렸는가

Latency는 어떤 작업을 시작한 뒤 결과를 얻기까지 걸린 시간이다. Spring MVC API라면 가장 익숙한 형태는 이렇다.

![Client에서 Spring Controller, Service, Repository, DB를 거쳐 Response로 돌아오는 요청 경로와 그 전체 구간을 가리키는 latency](/uploads/theory/reading-performance-metrics/perf-request-path.svg)

이 요청의 latency는 120ms다.

Spring Boot Actuator를 붙이면 Spring MVC와 WebFlux 요청에 대해 `http.server.requests`라는 metric이 기본으로 생성된다. Grafana나 Prometheus를 다루다 보면 latency라는 개념을 특히 자주 만나게 된다.

### 평균만 보면 안 되는 이유

요청 시간이 이렇게 나왔다고 해보자.

```text
20ms
21ms
22ms
20ms
23ms
24ms
21ms
900ms
```

평균을 내면 대부분의 사용자가 실제로 겪은 시간과 꽤 다른 숫자가 된다. 그래서 서버에서는 percentile을 쓴다.

```text
p50   일반적인 요청은 어느 정도인가?
p95   느린 쪽 5%는 어느 정도인가?
p99   느린 쪽 1%는 어디까지 느려지는가?
```

`p50 = 30ms`, `p95 = 120ms`, `p99 = 850ms`라면 대부분의 요청은 빠르지만 일부 요청에서 상당한 지연이 생긴다는 뜻이다.

### Spring 개발자는 어디서 만나나

- API 응답 시간
- 외부 API 호출 시간
- Redis GET latency
- SQL query latency
- DB connection acquisition time
- Kafka produce/consume 처리 시간
- lock wait
- GC pause
- 부하 테스트의 p95/p99

그래서 "API가 느리다"는 말을 들으면 첫 질문은 보통 이것이 된다.

> 전체 latency 중 **어디에서 시간이 소비되고 있는가?**

## 2. Throughput: 얼마나 많이 처리할 수 있는가

Latency가 요청 하나의 시간이라면 throughput은 일정 시간 동안 처리한 양이다. 웹 서버에서는 흔히 RPS(Requests Per Second)를 쓴다.

```text
1초

→ Request
→ Request
→ Request
→ Request
→ Request

1초에 5개 처리

Throughput = 5 RPS
```

DB에서는 TPS(Transaction Per Second), QPS(Query Per Second) 같은 표현도 본다.

여기서 중요한 점이 하나 있다. **Latency가 낮다고 throughput이 반드시 높지는 않다.** 요청 하나를 10ms에 처리하지만 동시에 하나밖에 못 하는 서버와, 요청 하나에 50ms가 걸려도 수백 개를 동시에 처리하는 서버는 특성이 전혀 다르다.

그래서 성능 테스트에서 "응답 시간이 100ms입니다"만 기록하면 부족하다. 최소한 이 정도는 함께 봐야 한다.

```text
Traffic     1,000 RPS
p50            35ms
p95           120ms
p99           430ms
Error Rate    0.1%
```

## 3. Latency와 Throughput은 언제 충돌할까

여기서부터 트레이드오프가 시작된다. 대표적인 예가 batching이다.

![즉시 처리와 묶어서 처리 비교. 즉시 처리는 요청마다 DB를 호출하고, 묶어서 처리하면 여러 요청을 Batch 하나로 모아 DB를 한 번만 호출한다](/uploads/theory/reading-performance-metrics/perf-batching.svg)

각 요청을 바로 처리하면 기다리는 시간은 줄일 수 있다. 반대로 여러 작업을 모으면 DB round trip과 작업 비용을 줄여 전체 throughput을 높일 수 있다. 대신 첫 번째 요청은 batch가 만들어질 때까지 기다릴 수도 있다.

```text
Batch Size ↑

Throughput       ↑
Efficiency       ↑

하지만

Waiting Time     ↑ 가능
Latency          ↑ 가능
Memory Usage     ↑ 가능
```

하나를 얻으면서 다른 비용을 지불하는 구조다.

## 4. Concurrency와 Parallelism은 다르다

**Concurrency** 는 여러 작업이 같은 시간 구간에 **진행 중인 상태**다. **Parallelism** 은 여러 작업이 실제 같은 순간에 **동시에 실행되는 것**이다.

4 Core CPU를 생각해보자.

![왼쪽은 Core 네 개가 서로 다른 작업을 같은 순간에 실행하는 parallelism이고, 오른쪽은 한 순간에 하나만 실행되지만 여러 작업이 번갈아 진행되는 concurrency다](/uploads/theory/reading-performance-metrics/perf-parallelism-concurrency.svg)

왼쪽은 parallelism이다. 오른쪽은 하나의 CPU에서도 여러 작업을 번갈아 처리하는 concurrency다.

Spring에서는 이 개념이 아주 자주 등장한다.

```text
HTTP Request
Thread Pool
Virtual Thread
@Async
CompletableFuture
WebClient
DB Connection Pool
Kafka Consumer
Batch Worker
Scheduler
```

여기서 중요한 함정이 하나 생긴다.

> 동시 처리량을 계속 높이면 성능도 계속 좋아질까?

그렇지 않다.

## 5. Concurrency를 계속 높이면 무슨 일이 생길까

처음에는 concurrency를 높이면 CPU나 DB가 놀던 시간을 채울 수 있다. 그런데 어느 순간 시스템이 처리할 수 있는 한계에 도달한다.

![동시성을 높이면 처리량은 어느 지점부터 평평해지고 지연은 그 뒤로 치솟는 모습](/uploads/theory/reading-performance-metrics/perf-concurrency-knee.svg)

처음에는 concurrency 증가와 함께 throughput도 증가한다. 자원이 포화되면 throughput은 더 이상 크게 늘지 않는다. 기다리는 요청만 늘어나면서 latency가 급격히 오른다.

그래서 "스레드를 100개에서 1,000개로 늘렸습니다"는 그 자체로 성능 개선이 아니다. **어떤 자원을 기다리는 1,000개의 작업이 되었는가**를 봐야 한다.

## 6. DB Connection과 Connection Wait

Spring + JPA/JDBC 개발자가 정말 자주 만나는 사례다. Spring Boot는 DataSource에 대해 active, idle, maximum, minimum connection gauge를 제공하고 HikariCP를 쓰면 `hikaricp` metric도 별도로 제공한다.

HikariCP의 maximum pool size가 10이라고 해보자.

![풀의 커넥션 10개가 모두 사용 중이고 요청 11부터는 커넥션이 반환될 때까지 기다리는 상태](/uploads/theory/reading-performance-metrics/perf-connection-wait.svg)

여기서 **connection wait**가 등장한다. pool이 maximum size에 도달하고 idle connection이 없으면 `getConnection()` 호출은 connection이 반환될 때까지 기다린다. `connectionTimeout`을 넘기면 timeout된다.

이런 상태라면

| 구간 | 시간 |
|---|---|
| Connection Wait | 850ms |
| SQL Execution | 200ms |
| Others | 150ms |
| **HTTP p95 latency** | **1,200ms** |

Controller 코드를 아무리 최적화해도 큰 효과가 없다. 요청이 CPU를 쓰는 자리가 아니라 **DB connection을 기다리는 자리**에 걸려 있기 때문이다. 커넥션 풀 자체를 더 깊이 보려면 [DB 커넥션 풀](/blog/theory/db-connection-pool) 편을 참고하면 된다.

## 7. 그러면 Connection Pool을 키우면 되지 않을까

여기가 성능 튜닝에서 재미있는 부분이다. `maximumPoolSize`를 10에서 50으로 올리면 애플리케이션에서 connection을 기다리는 요청은 줄어들 수 있다. 대신 DB 입장에서는

```text
기존

10 Queries
    ↓
   DB


변경

50 Queries
    ↓
   DB
```

가 된다. 그러면 DB CPU, Disk I/O, Lock Contention, Context Switching이 함께 올라가고 Query Latency가 늘어날 수 있다.

![풀을 10에서 50으로 키우면 애플리케이션에서 기다리던 요청이 DB에서 기다리게 되는 모습](/uploads/theory/reading-performance-metrics/perf-pool-queue-shift.svg)

결국 대기열의 **위치만 옮긴 것**일 수도 있다. HikariCP의 공식 pool sizing 문서도 connection을 무작정 늘리는 접근을 경계하면서 실제 workload로 크기를 측정하라고 권한다.

그래서 봐야 하는 것은 `connection = 30` 하나가 아니다.

```text
Active Connection
Pending/Waiting
Connection Acquisition Time

DB Query Latency
DB CPU
DB Lock Wait
DB I/O
```

## 8. Cache Hit Rate: DB까지 가지 않은 요청은 얼마나 되는가

상품 조회가 100번 들어왔다고 해보자.

![요청이 Redis에서 HIT이면 바로 응답하고, MISS일 때만 DB를 거쳐 응답하는 흐름](/uploads/theory/reading-performance-metrics/perf-cache-hit-miss.svg)

그중 Redis에서 90번 찾았다면 `Cache Hit Rate = 90%`다. 캐시를 붙인 이유가 DB 부하를 줄이기 위한 것이었다면 중요한 지표다.

| 지표 | 전 | 후 |
|---|---|---|
| Cache Hit Rate | 95% | 70% |
| DB QPS | 500 | 2,000 |
| DB CPU | 40% | 85% |
| SQL p95 | 30ms | 180ms |

이렇게 연결될 수 있다. 그래서 장애 상황에서 "DB가 갑자기 느려졌습니다"라고 할 때 DB 자체가 원인이 아닐 수 있다. 캐시 hit rate가 먼저 떨어졌고 그 결과 DB traffic이 늘었을 수도 있다. 캐시 계층을 더 보려면 [Redis 캐싱](/blog/theory/redis-caching-guide) 편을 참고하면 된다.

## 9. Hit Rate가 높으면 무조건 좋은가

이것도 아니다. `Hit Rate 99%`라도 캐시 value 하나가 매우 크면

![Redis에서 꺼낸 값이 네트워크 전송, 압축 해제, 역직렬화를 거쳐 자바 객체가 되기까지의 비용](/uploads/theory/reading-performance-metrics/perf-cache-value-pipeline.svg)

비용이 상당할 수 있다. TTL을 길게 잡아 hit rate를 높이면

```text
TTL ↑

Cache Hit Rate ↑
DB Load ↓

하지만

Stale Data ↑
Memory Usage ↑
Invalidation Complexity ↑
```

같은 비용이 생긴다. 그래서 cache를 분석할 때도 hit rate 하나만 보지 않는다.

```text
Hit Rate
Cache GET Latency
Value Size
Network Traffic
Serialization Cost
Memory Usage
Eviction
```

## 10. CPU Utilization과 CPU Saturation

두 단어는 반드시 구분해서 알아야 한다.

**Utilization** 은 CPU가 얼마나 사용되고 있는지를 나타낸다. `CPU Utilization = 70%`처럼 본다.

**Saturation** 은 CPU를 쓰고 싶은 작업이 있는데 CPU가 부족해 **기다리는 상태**를 말한다.

![Core 네 개가 작업을 실행 중이고, 그 아래에 CPU를 받지 못한 작업 다섯 개가 대기하는 상태](/uploads/theory/reading-performance-metrics/perf-cpu-util-saturation.svg)

CPU는 열심히 일하고 있다. 중요한 것은 아래쪽이다. **CPU를 원하는 작업이 줄을 서기 시작했다.** Brendan Gregg의 USE Method도 자원을 볼 때 `Utilization`, `Saturation`, `Errors`를 함께 확인하라고 정리한다. Saturation은 처리할 수 없는 추가 작업이 queue에 쌓인 정도로 설명된다.

## 11. CPU 70%니까 CPU 문제는 아니다?

이렇게 판단하면 위험하다. 모니터링 시스템이 5분 평균을 보여준다고 해보자.

![5분 평균 CPU 사용률 70% 그래프. 짧은 구간에서만 100%까지 올라가고 나머지는 낮게 유지되어 평균이 burst를 가린다](/uploads/theory/reading-performance-metrics/perf-cpu-average.svg)

몇 초 동안 CPU가 100%에 도달하며 queue가 만들어졌어도 평균값에서는 70%로 보일 수 있다. Brendan Gregg도 낮아 보이는 평균 utilization이 짧은 burst의 saturation을 숨길 수 있다고 말한다.

```text
CPU Utilization
CPU Run Queue
Scheduler Latency
Load
Context Switch
Application Latency
```

를 연결해서 봐야 하는 이유다.

## 12. Availability와 Reliability

**Availability** 는 사용자가 서비스를 **사용할 수 있는가**에 초점을 둔다.

서비스가 정상적으로 요청을 받을 수 있는 상태다.

**Reliability** 는 서비스가 일정 기간 동안 **의도한 동작을 올바르게 수행하는가**에 가깝다. 결제 서버를 생각해보자.

![두 경우 모두 200 OK다. 정상적으로 처리된 경우에는 승인 기록이 남지만, 결제 처리가 실제로 수행되지 않은 경우에도 응답은 200이다](/uploads/theory/reading-performance-metrics/perf-ok-vs-record.svg)

HTTP 서버 자체는 살아 있다. 그런데 사용자가 기대한 결제 처리는 올바르게 수행되지 않았다. 그래서 운영에서는 단순 uptime 외에도

```text
Error Rate
Timeout
Correctness
Duplicate Processing
Data Consistency
Retry
Recovery
```

가 중요해진다.

## 13. 결국 이 지표들은 하나의 장애에서 만난다

상품 조회 API의 p95 latency가 갑자기 `100ms → 1,800ms`가 되었다고 해보자.

처음 발견한 것은 latency다. 그다음 traffic을 확인한다.

```text
RPS
500 → 900
```

CPU를 확인한다.

```text
Application CPU
45%
```

CPU가 충분히 남아 있다. 그런데 HikariCP를 보니

```text
Active Connection
30 / 30

Pending
120

Connection Wait p95
900ms
```

이다. 그렇다면 요청 흐름을 다시 쪼개본다.

![API latency 1,800ms를 커넥션 대기 900ms, SQL 600ms, 애플리케이션 300ms로 쪼갠 비율](/uploads/theory/reading-performance-metrics/perf-latency-split.svg)

여기서 "Connection Pool이 부족하네. 30에서 100으로 올리자"라고 바로 결론 내리면 안 된다. DB를 확인해보니

```text
DB CPU = 95%

SQL
20ms → 600ms
```

였다. 조금 더 거슬러 올라가니

```text
Cache Hit Rate
95% → 60%
```

으로 떨어져 있었다. 전체 흐름은 이랬던 것이다.

![캐시 hit rate 하락에서 시작해 DB QPS, 사용률, 포화, 쿼리 지연, 커넥션 점유, 풀 포화, 커넥션 대기를 거쳐 API p95로 이어지는 원인 사슬](/uploads/theory/reading-performance-metrics/perf-incident-chain.svg)

API latency는 **결과**였고 connection pool saturation은 **중간 증상**이었다. 더 앞쪽의 원인은 cache miss 증가였다. 이렇게 지표를 연결해서 보는 것이 성능 분석의 핵심이다.

## 14. Spring 백엔드에서 어디를 먼저 볼 것인가

두 가지 틀을 같이 기억하면 편하다. 서비스에서는 RED를 본다.

![서비스는 Rate, Errors, Duration으로 보고 자원은 Utilization, Saturation, Errors로 보는 두 틀](/uploads/theory/reading-performance-metrics/perf-red-use.svg)

Spring API라면 자연스럽게 `RPS`, `HTTP 5xx`, `p50 / p95 / p99`로 연결된다. 문제가 아래 계층으로 내려갔다면 CPU, Memory, Disk, Network, Connection Pool, Thread Pool 같은 자원에서 `Utilization`, `Saturation`, `Errors`를 확인한다. Brendan Gregg도 RED를 서비스 관점에서 Request Rate, Errors, Duration으로, USE를 자원 관점에서 Utilization, Saturation, Errors로 정리한다.

## 15. 장애를 볼 때 쓰는 순서

![장애를 볼 때 따라가는 순서. API가 느리다에서 Traffic과 Errors를 보고, Latency로 내려가 어디서 기다리는지 CPU·DB·Cache를 확인한 뒤 Network·Disk로 내려간다](/uploads/theory/reading-performance-metrics/perf-debug-order.svg)

여기서 가장 중요한 질문은 하나다.

> **요청은 지금 어디에서 기다리고 있는가?**

CPU를 기다리는가? DB connection을 기다리는가? DB lock을 기다리는가? 외부 API를 기다리는가? Redis 응답을 기다리는가? Thread Pool에서 실행 순서를 기다리는가?

이 질문을 따라가면 "서버가 느립니다"에서 훨씬 구체적인 원인으로 내려갈 수 있다.

## 16. 성능 개선에서 숫자 하나만 보면 안 되는 이유

예를 들어 최적화 후 "CPU 사용률이 53% 감소했다"고 하자. 이것만으로는 좋은 결과인지 알 수 없다. Throughput까지 절반으로 떨어졌을 수도 있다.

그래서 같은 workload에서 비교한다.

| 지표 | Before | After |
|---|---|---|
| RPS | 1,000 | 1,000 |
| p50 | 35ms | 24ms |
| p95 | 180ms | 90ms |
| p99 | 600ms | 210ms |
| CPU Utilization | 78% | 41% |
| CPU Queue | 3.2 | 0.4 |
| DB Active Conn | 28/30 | 14/30 |
| Conn Wait p95 | 85ms | 2ms |
| Cache Hit Rate | 70% | 94% |

같은 1,000 RPS를 처리하면서 CPU 사용량, CPU 대기, DB connection 대기, tail latency가 동시에 내려간 것을 확인하고 나서야 설명이 강해진다.

## 17. 결국 성능 튜닝은 트레이드오프를 고르는 일이다

성능 용어를 공부하면서 크게 느낀 점은 **좋은 숫자 하나를 만드는 것이 목적이 아니라는 것**이다. 거의 모든 결정에 반대쪽 비용이 있다.

![값을 올리면 무엇을 얻고 무엇을 내는지 여섯 쌍. 초록이 얻는 쪽이고 빨강이 대가다](/uploads/theory/reading-performance-metrics/perf-tradeoff-chains.svg)

그래서 성능 테스트에서 물어야 할 질문은 "빨라졌는가?" 하나가 아니다.

> **무엇을 개선했고 그 대가로 무엇이 나빠졌으며 지금 workload에서 그 교환이 받아들일 만한가?**

그리고 장애 상황에서는

> **지금 요청은 어디에서 기다리고 있는가?**

부터 시작한다. 이 두 질문을 기준으로 보면 latency, throughput, concurrency, cache hit rate, connection wait, CPU saturation 같은 용어가 따로 떨어진 개념으로 보이지 않는다. 하나의 요청이 시스템을 통과하면서 남기는 **연결된 신호**로 보이기 시작한다.

## 참고

- 자원을 Utilization, Saturation, Errors로 나눠 보는 틀: [The USE Method (Brendan Gregg)](https://www.brendangregg.com/usemethod.html)
- 서비스 지표를 Rate, Errors, Duration으로 나눠 보는 틀: [Google SRE Book · Monitoring Distributed Systems](https://sre.google/sre-book/monitoring-distributed-systems/)
- 커넥션 풀을 무작정 키우지 말라는 근거: [HikariCP · About Pool Sizing](https://github.com/brettwooldridge/HikariCP/wiki/About-Pool-Sizing)
- Spring MVC 요청 지표 `http.server.requests`: [Spring Boot Actuator metrics](https://docs.spring.io/spring-boot/reference/actuator/metrics.html)
- tail latency가 평균과 다른 이유: [The Tail at Scale (Dean & Barroso)](https://research.google/pubs/pub40801/)

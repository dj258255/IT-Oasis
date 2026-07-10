---
title: '통로를 외부에 열기 전에 — 문지기를 손으로: 인증·라우팅·유량제어 필터 체인'
titleEn: 'Before Opening the Path to the Outside — A Gatekeeper by Hand: Auth, Routing, Rate-Limit Filter Chain'
description: "앞 편에서 전문↔JSON 왕복 통로를 열었습니다. 그런데 이 통로는 아무나 드나들 수 있습니다. 그래서 /api/gateway/** 앞에 필터 체인을 손으로 세웠습니다 — 인증(X-API-Key, 없으면 401·잘못되면 403), 라우팅(모르는 경로 404), 유량제어(클라이언트별 토큰버킷, 초과 429 + Retry-After). 완제품 프레임워크에 맡기지 않고 GatewayFilter 인터페이스와 체인 실행기, 서블릿 브릿지로 직접 짰습니다. 직접 짜는 유량제어의 두 함정(벽시계로 인한 시간 역행, 같은 버킷을 치는 스레드 경쟁)을 단조 시계와 버킷 단위 동기화로 막고, 401/403/404/429를 진짜 curl 응답과 화면으로 남겼습니다. 겸사겸사 코드베이스를 Spring Modulith 모듈러 모놀리스로 재정렬해, 모듈 경계를 verify()가 강제하게 했습니다."
descriptionEn: "In stage 2 I opened a path that translates messages to JSON and back. But anyone could walk through it. So I put a filter chain in front of /api/gateway/** by hand: authentication (X-API-Key; 401 if missing, 403 if wrong), routing (404 for unknown paths), and rate limiting (per-client token bucket; 429 + Retry-After on excess). Instead of leaning on a finished framework, I wrote a GatewayFilter interface, a chain runner, and a servlet bridge myself. I closed the two traps of a hand-rolled rate limiter — clock going backwards with wall-clock time, and threads racing on the same bucket — with a monotonic clock and per-bucket synchronization, and captured 401/403/404/429 as real curl responses and on screen. Along the way I restructured the codebase into a Spring Modulith modular monolith so that verify() enforces the module boundaries."
date: 2025-08-02
tags:
  - Java
  - Spring Boot
  - API Gateway
  - 인증
  - 유량제어
  - Spring Modulith
category: personal/gwanmun
coverImage: /uploads/project/gwanmun/cover.svg
draft: false
series: "gwanmun"
seriesOrder: 3
---

## 1. 상황 — 통로를 외부에 열면 아무나 들어온다

[2편](/blog/project/gwanmun/gwanmun-2-tcp-framing)에서 통로를 열었습니다. REST로 들어온 잔액조회를 요청 전문으로 만들어 TCP로 계정계에 보내고, 응답 전문을 받아 JSON으로 돌려주는 왕복. 통역기가 소켓 앞에 선 셈입니다.

문제는, 이 통로가 **무방비**라는 것입니다. `POST /api/gateway/balance`에 계좌번호만 넣으면 누구나 계정계에 질의를 밀어넣을 수 있습니다. 이 통로가 외부(다른 팀, 외부 클라이언트)에 열리는 순간 세 가지가 필요해집니다.

- 이 요청은 **누가** 보낸 것인가 (인증)
- 이 요청은 **어디로** 가야 하는가 (라우팅)
- 한 클라이언트가 **얼마나** 자주 쳐도 되는가 (유량제어)

각 백엔드가 따로 이걸 처리하면 중복이고 관리가 안 됩니다. 통로 앞단에서 한 번에 걸러야 합니다.

![gwanmun 두 층 — 위쪽 API 게이트웨이(인증·라우팅·유량제어)와 아래쪽 연계 통역(전문↔JSON)](/uploads/project/gwanmun/architecture.svg)

이번 편의 목표는 하나입니다.

> `/api/gateway/**` 앞에 문지기를 세운다. 요청이 인증 → 라우팅 → 유량제어를 순서대로 통과해야만 뒤쪽 전문 왕복에 닿는다. 그리고 그 문지기를 **완제품에 맡기지 않고 손으로 짠다.**

## 2. 함정 — 직접 짜는 유량제어는 두 곳에서 샌다

인증과 라우팅은 비교적 정직합니다. 헤더를 보고 맞으면 통과, 아니면 상태코드. 진짜 함정은 **유량제어**에 있습니다. "클라이언트별 분당 N건"을 직접 구현하려고 토큰버킷을 짜면, 두 곳에서 조용히 샙니다.

**함정 하나 — 시계가 거꾸로 간다.** 토큰버킷의 핵심은 "지난번 이후 흐른 시간만큼 토큰을 채운다"입니다. 이때 무심코 벽시계(`System.currentTimeMillis()`)를 쓰면, NTP 시간 보정이나 서머타임 전환으로 시계가 **뒤로** 점프할 수 있습니다. 그러면 "흐른 시간"이 음수가 되고, 계산에 따라 토큰이 폭증하거나 음수로 꺼집니다. 로컬에선 안 보이다가 운영 서버의 시간 동기화 한 번에 터지는 종류입니다.

**함정 둘 — 같은 버킷을 여러 스레드가 동시에 친다.** 웹 요청은 스레드 풀에서 병렬로 처리됩니다. 한 클라이언트가 동시에 여러 요청을 보내면, 여러 스레드가 **같은 버킷**의 토큰을 동시에 소비하려 듭니다. `if (남은 토큰 > 0) 토큰--` 같은 검사-후-실행(check-then-act)은 원자적이지 않아서, 두 스레드가 동시에 "토큰 있음"을 보고 둘 다 통과해 버립니다. 용량 5인데 6건이 통과하는 초과 소비가 생깁니다.

이 둘을 막지 못하면 "유량제어를 한다"는 말이 코드로 증명되지 않습니다.

## 3. 판단 — 필터 체인을 인터페이스로, 시계는 단조로, 버킷은 잠근다

세 가지를 정했습니다.

**하나, 필터 체인은 직접 추상화한다.** 요청이 순서대로 통과하는 체인을 `GatewayFilter` 인터페이스 + 체인 실행기로 짭니다. 각 필터는 통과(다음으로 넘김) 아니면 차단(상태코드·사유 남기고 멈춤)을 결정합니다. 서블릿 API에 묶이지 않는 순수 자바로 두어 필터 로직만 단독 테스트할 수 있게 하고, 서블릿과의 연결은 얇은 브릿지 하나로 격리합니다.

**둘, 시계는 단조(monotonic) 시계를 쓴다.** `System.nanoTime()`은 뒤로 가지 않음이 보장됩니다. 게다가 테스트에서 시간을 마음대로 흘릴 수 있게 시계를 주입 가능한 `LongSupplier`로 둡니다(가짜 시계로 보충 로직을 결정론적으로 검증).

**셋, 버킷은 버킷 단위로 잠근다.** 클라이언트마다 버킷 하나를 `ConcurrentHashMap`에 두되, 버킷의 소비 연산은 `synchronized`로 묶습니다. 락 범위가 그 클라이언트 버킷 하나라, 다른 클라이언트끼리는 서로 안 막습니다.

## 4. 개선 — 체인, 시계, 잠금

### 4-1. 필터 인터페이스와 체인 실행기

필터는 통과면 `chain.next(...)`를 부르고, 차단이면 `response.block(...)`을 부른 뒤 next를 **안** 부릅니다. 그 순간 체인이 멈춥니다.

```java
public interface GatewayFilter {
    void filter(GatewayRequest request, GatewayResponse response, GatewayFilterChain chain);
    int order();  // 인증 10 → 라우팅 20 → 유량제어 30. 순서를 코드로 드러낸다.
}

public final class GatewayFilterChain {
    private final List<GatewayFilter> filters;
    private int index;
    public void next(GatewayRequest request, GatewayResponse response) {
        if (response.blocked()) return;          // 이미 막혔으면 멈춤
        if (index < filters.size()) {
            filters.get(index++).filter(request, response, this);
        }
    }
}
```

인증 필터는 이렇게 통과/차단을 가릅니다.

```java
String apiKey = request.header("X-API-Key");
if (apiKey == null || apiKey.isBlank()) {
    response.block(401, "인증 실패: X-API-Key 헤더가 없습니다.");
    return;                                       // next를 안 부른다 = 체인 종료
}
String clientId = registry.clientFor(apiKey);
if (clientId == null) {
    response.block(403, "인증 실패: 등록되지 않은 API 키입니다.");
    return;
}
request.clientId(clientId);                        // 뒤 필터가 쓸 클라이언트 id를 실어 준다
response.header("X-Gateway-Client", clientId);     // 통과 흔적을 응답에 남긴다
chain.next(request, response);
```

라우팅 필터는 "메서드 + 경로"를 라우팅 테이블에서 찾고, 없으면 404로 끊습니다. 테이블 구조라 거래가 늘면 줄만 추가하면 됩니다(지금은 목업 계정계로 가는 잔액조회 한 줄).

### 4-2. 토큰버킷 — 단조 시계로 채운다

```java
private void refill() {
    long now = clock.getAsLong();                 // System::nanoTime (주입)
    long elapsed = now - lastRefillNanos;
    if (elapsed > 0) {                            // 단조 시계라 음수일 리 없지만, 0으로 방어
        tokens = Math.min(capacity, tokens + elapsed * refillPerNano);
        lastRefillNanos = now;
    }
}

public synchronized boolean tryConsume() {
    refill();
    if (tokens >= 1.0) { tokens -= 1.0; return true; }
    return false;
}
```

`elapsed > 0` 가드가 함정 하나(시간 역행)를 막습니다. 벽시계였다면 여기서 `elapsed`가 음수가 돼 `tokens`가 요동쳤을 겁니다. 단조 시계라 그럴 일이 없고, 혹시 몰라 가드까지 둡니다.

### 4-3. 유량제어 필터 — 버킷을 원자적으로 만들고, 버킷 단위로 잠근다

```java
TokenBucket bucket = buckets.computeIfAbsent(clientId,
        k -> new TokenBucket(capacity, refillPerSecond, clock));
if (bucket.tryConsume()) {                         // tryConsume은 synchronized
    response.header("X-RateLimit-Remaining", Long.toString(bucket.remaining()));
    chain.next(request, response);
    return;
}
long retrySec = Math.max(1, (long) Math.ceil(bucket.millisUntilRefill() / 1000.0));
response.header("Retry-After", Long.toString(retrySec));
response.block(429, "요청이 너무 잦습니다(클라이언트 '" + clientId + "' 분당 한도 초과). "
        + retrySec + "초 후 재시도하세요.");
```

`computeIfAbsent`는 키별로 원자적이라, 첫 요청이 동시에 여럿 와도 버킷은 하나만 생깁니다. 소비는 `tryConsume()`이 버킷 단위로 동기화하므로, 여러 스레드가 같은 버킷을 쳐도 토큰이 정확히 하나씩만 빠집니다. 이게 함정 둘(초과 소비)을 막는 부분입니다.

### 4-4. 서블릿에 잇는 브릿지

손으로 짠 체인을 서블릿 파이프라인에 연결하는 건 얇은 브릿지 하나입니다. `HttpServletRequest`에서 필요한 것만 뽑아 체인을 태우고, **막히면** 그 상태코드·사유로 응답하고 백엔드로 안 넘깁니다. **통과하면** 체인이 남긴 헤더를 응답에 실어 준 뒤 컨트롤러로 넘깁니다. `/api/gateway/*`에만 걸어, 통역만 하던 나머지 API(`/api/build` 등)는 문지기 밖입니다.

## 5. 왜 모듈러 모놀리스인가 — 경계를 코드가 강제하게

이번에 필터 층이 들어오며 클래스가 늘었습니다. 통역 코덱, 계정계 연동, 관문 필터, REST 컨트롤러가 한 프로젝트에 섞이기 시작하는 지점입니다. 여기서 코드베이스를 [Spring Modulith](https://spring.io/projects/spring-modulith) 기반 **모듈러 모놀리스**로 재정렬했습니다. 기술적 근거는 셋입니다.

**하나, 모듈 경계를 코드가 강제한다.** `io.gwanmun` 바로 아래 각 패키지를 하나의 애플리케이션 모듈로 둡니다 — `message`(전문 코덱, 순수), `core`(계정계 연동), `gateway`(관문 필터 체인), `web`(REST 조립). 각 모듈은 자기 기반 패키지의 타입만 API로 내놓고, 하위 패키지(예: 필터 구현 세부)는 내부에 감춥니다. 이 경계가 문서상 약속이 아니라 **테스트로 검증**됩니다.

```java
ApplicationModules.of(GwanmunApplication.class).verify();  // 그린 = 경계 지켜짐
```

**둘, 순환참조를 차단한다.** `verify()`는 모듈 간 순환 의존이나 다른 모듈 내부 패키지 직접 참조를 빨갛게 막습니다. 실제 의존은 단방향 DAG입니다.

```
web      → gateway, message
gateway  → message, core
core     → message
message  → (없음 — 순수 모듈)
```

누가 실수로 `message`가 `web`을 참조하게 만들면(순환) 테스트가 즉시 깨집니다. 경계를 사람 눈이 아니라 빌드가 지킵니다.

**셋, 단일 배포 단위를 유지한다.** 이건 마이크로서비스가 아닙니다. 프로세스도, 배포도 하나입니다. 다만 모듈 경계가 코드로 강제되니, 나중에 필요하면 쪼갤 수 있는 선택지를 남겨둘 뿐입니다. 지금 필요하지도 않은 분산을 미리 지불하지 않으면서, 경계의 이점만 취하는 선택입니다.

`message` 모듈은 다른 모듈이 전문 필드를 다뤄야 하므로 `dto`·`spec` 하위 패키지만 `@NamedInterface`로 열고 나머지는 감췄습니다. 모듈 다이어그램은 Documenter로 생성해 `docs/modules/`에 남겼습니다(components.puml, 모듈별 puml·adoc).

## 6. 실측 — 401 / 403 / 404 / 429, 진짜 응답

앱을 8090에 띄우고(내장 목업 계정계 9099 포함) curl로 다섯 경로를 실제로 쳤습니다. 기동 로그에 체인 순서가 찍힙니다.

```
ApiKeyRegistry   : API 키 2개 로드: [demo-key-fintech-a, demo-key-fintech-b]
GatewayFilterConfig : 관문 필터 체인 등록(순서): [AuthenticationFilter#10, RoutingFilter#20, RateLimitFilter#30]
```

**키 없음 → 401, 잘못된 키 → 403** (값은 손대지 않은 실제 출력):

```
$ curl -i -X POST /api/gateway/balance -d '{"accountNo":"12345678901234"}'
HTTP/1.1 401
{"blocked":true,"status":401,"reason":"인증 실패: X-API-Key 헤더가 없습니다."}

$ curl -i ... -H "X-API-Key: wrong-key" ...
HTTP/1.1 403
{"blocked":true,"status":403,"reason":"인증 실패: 등록되지 않은 API 키입니다."}
```

**정상 키 → 통과, 계정계 왕복 성공.** 판정 헤더가 응답에 드러납니다.

```
$ curl -i ... -H "X-API-Key: demo-key-fintech-a" ...
HTTP/1.1 200
X-Gateway-Client: fintech-a
X-Gateway-Route: core-banking-balance
X-RateLimit-Remaining: 4
X-Gateway-Decision: pass
...
"json":{"balance":"6879445000","responseCode":"0000","responseMessage":"정상 처리되었습니다"}
```

문지기(인증→라우팅→유량제어)를 다 통과한 뒤에야 2편의 전문 왕복이 실행됩니다. 문 통과 후 통역입니다.

**유량제어 → N+1번째에서 429.** 용량 5로 두고 한 클라이언트로 8회 연속 전송했습니다.

```
요청 1 → 200  (remaining: 4)  통과
요청 2 → 200  (remaining: 3)  통과
요청 3 → 200  (remaining: 2)  통과
요청 4 → 200  (remaining: 1)  통과
요청 5 → 200  (remaining: 0)  통과
요청 6 → 429  (Retry-After: 2s)  차단
요청 7 → 429  (Retry-After: 2s)  차단
요청 8 → 429  (Retry-After: 2s)  차단
```

정확히 5건이 통과하고 6번째부터 429 + Retry-After가 붙습니다. 화면에도 같은 걸 붙였습니다 — 키와 횟수를 정해 연속 전송하면 통과(초록)와 차단(빨강)이 줄줄이 찍히고 합계가 뜹니다.

![게이트웨이 방어 — 5건 통과 후 429 차단 3건, 클라이언트별 토큰버킷](/uploads/project/gwanmun/gateway-guard.png)

**알 수 없는 경로 → 404.** 인증은 통과했지만(`X-Gateway-Client` 헤더가 찍힘) 라우팅에서 막힙니다.

```
$ curl -i -X POST /api/gateway/unknown -H "X-API-Key: demo-key-fintech-a" -d '{}'
HTTP/1.1 404
X-Gateway-Client: fintech-a
{"blocked":true,"status":404,"reason":"알 수 없는 라우트: POST /api/gateway/unknown"}
```

가장 중요한 두 함정은 테스트로 강제했습니다. **동시성**은 8스레드가 각 100회, 총 800회를 같은 클라이언트 버킷에 던져 통과가 **정확히 용량만큼**(초과 없이)인지 봅니다.

```java
// 시계 고정(보충 배제) → 통과는 딱 capacity건이어야 한다
assertThat(passed.get()).isEqualTo(capacity);
assertThat(blocked.get()).isEqualTo(threads * attemptsPerThread - capacity);
```

**시계 역행**은 가짜 시계를 과거로 되돌려도 토큰이 폭증하지 않는지 봅니다.

```java
now.set(과거값);                          // 벽시계 보정 흉내
assertThat(bucket.tryConsume()).isFalse(); // 폭증 없음
```

모듈 경계 검증까지 합쳐 `./gradlew test`는 **52개 전부 그린**입니다(앞 두 편의 37개 + 이번 15개). `ModularityTest`의 `verify()`가 그린이라는 건, 위에 그린 모듈 DAG가 코드로 지켜지고 있다는 뜻입니다.

## 7. 잔여 — 정직하게 안 한 것

- **분산 환경 rate limit 공유 안 됨.** 토큰버킷은 **단일 노드 인메모리**입니다. 인스턴스를 여럿으로 늘리면 각자 따로 세므로 전역 한도가 안 맞습니다. 공유하려면 Redis 같은 외부 저장소에 카운터를 둬야 하는데, 그 순간 네트워크 왕복·원자 연산·장애 시 동작이라는 새 문제가 붙습니다. 여기선 단일 노드로 명시하고 확장 지점으로 남깁니다.
- **JWT/OAuth 미구현.** 인증은 정적 API 키 검증까지입니다. 토큰 만료·서명 검증(JWT)이나 발급/위임 흐름(OAuth)은 범위 밖입니다. 인터페이스는 같은 자리(인증 필터)라 나중에 교체할 수 있게만 뒀습니다.
- **API 키 평문 보관.** 설정·인메모리에 평문으로 둡니다. 실서비스라면 시크릿 스토어에 두고 해시로 대조하겠지만, 학습판의 경계입니다.
- **모듈러 모놀리스 ≠ 마이크로서비스.** 단일 배포 단위입니다. 경계가 코드로 강제될 뿐 프로세스·DB·배포는 하나입니다.

이제 통로 앞에 문지기가 섰습니다. 누가 보냈는지 확인하고, 갈 곳이 있는지 보고, 너무 자주 치면 잠시 막습니다. 그 관문을 통과한 요청만 2편의 전문 왕복에 닿습니다. 하지만 운영 중 "잔액조회가 가끔 실패한다"는 말이 나오면, 지금 구조로는 **어디서 깨졌는지**가 안 보입니다 — 인증에서? 라우팅에서? 백엔드 타임아웃에서? 다음 편은 그 거래의 경로를 남기고 실패 지점을 드러냅니다.

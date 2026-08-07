---
title: '완제품 없이 세운 문지기, 인증·라우팅·유량제어 필터 체인부터 가변 프레이밍과 커넥션 풀까지'
description: '전문↔JSON 왕복 통로는 열렸지만 아무나 드나들 수 있었습니다. 1부에서 /api/gateway/** 앞에 문지기를 손으로 세웁니다. 인증(X-API-Key, 없으면 401·잘못되면 403), 라우팅(모르는 경로 404), 유량제어(클라이언트별 토큰버킷, 용량 5 초과 시 6번째 429 + Retry-After)입니다. 완제품 프레임워크 없이 GatewayFilter 인터페이스와 체인 실행기, 서블릿 브릿지로 직접 짰고, 직접 짜는 유량제어의 두 함정(벽시계로 인한 시간 역행, 같은 버킷을 치는 스레드 경쟁)을 단조 시계와 버킷 단위 동기화로 막았습니다. 겸사겸사 코드베이스를 Spring Modulith 모듈러 모놀리스로 재정렬해 모듈 경계를 verify()가 강제하게 했습니다. 2부는 통로에 남은 두 구멍을 메웁니다. 거래내역 조회 응답처럼 레코드가 건수만큼 붙어 길이가 매번 다른 전문은 4byte 길이 헤더의 2단계 프레이밍으로 자르고(가변 309B 왕복, 비정상 길이는 fail-closed 거절), 요청마다 소켓을 새로 열던 것은 최대 크기·유휴 반납·검증·고갈 거절을 갖춘 스레드 안전 커넥션 풀로 바꿨습니다. 순차 6회 조회에 소켓 1개 재사용, 동시 10건 폭주에도 created=4(==max)·reused=12를 진짜 실행으로 남겼습니다.'
date: 2025-08-16
tags:
  - Java
  - Spring Boot
  - API Gateway
  - 인증
  - 유량제어
  - Spring Modulith
  - TCP
  - 프레이밍
  - 커넥션 풀
category: personal/gwanmun
coverImage: /uploads/project/gwanmun/cover.svg
draft: false
series: "gwanmun"
seriesOrder: 2
---

## 1부. 문지기를 손으로 짜는 인증·라우팅·유량제어 필터 체인

### 1. 상황, 통로를 외부에 열면 아무나 들어온다

[1편](/blog/project/gwanmun/gwanmun-1-parser-and-framing) 2부에서 통로를 열었습니다. REST로 들어온 잔액조회를 요청 전문으로 만들어 TCP로 계정계에 보내고 응답 전문을 받아 JSON으로 돌려주는 왕복. 통역기가 소켓 앞에 선 셈입니다.

문제는, 이 통로가 **무방비**라는 것입니다. `POST /api/gateway/balance`에 계좌번호만 넣으면 누구나 계정계에 질의를 밀어넣을 수 있습니다. 이 통로가 외부(다른 팀, 외부 클라이언트)에 열리는 순간 세 가지가 필요해집니다.

- 이 요청은 **누가** 보낸 것인가 (인증)
- 이 요청은 **어디로** 가야 하는가 (라우팅)
- 한 클라이언트가 **얼마나** 자주 쳐도 되는가 (유량제어)

각 백엔드가 따로 이걸 처리하면 중복이고 관리가 안 됩니다. 통로 앞단에서 한 번에 걸러야 합니다.

![gwanmun의 두 층 구조. 위쪽은 API 게이트웨이(인증·라우팅·유량제어), 아래쪽은 연계 통역(전문↔JSON)](/uploads/project/gwanmun/architecture.svg)

이번 편의 목표는 하나입니다.

> `/api/gateway/**` 앞에 문지기를 세운다. 요청이 인증 → 라우팅 → 유량제어를 순서대로 통과해야만 뒤쪽 전문 왕복에 닿는다. 그리고 그 문지기를 **완제품 없이 손으로 짠다.**

### 2. 함정, 직접 짜는 유량제어는 두 곳에서 샌다

인증과 라우팅은 비교적 정직합니다. 헤더를 보고 맞으면 통과, 아니면 상태코드. 진짜 함정은 **유량제어**에 있습니다. "클라이언트별 분당 N건"을 직접 구현하려고 토큰버킷을 짜면, 두 곳에서 조용히 샙니다.

**함정 하나, 시계가 거꾸로 간다.** 토큰버킷의 핵심은 "지난번 이후 흐른 시간만큼 토큰을 채운다"입니다. 이때 무심코 벽시계(`System.currentTimeMillis()`)를 쓰면, NTP 시간 보정이나 서머타임 전환으로 시계가 **뒤로** 점프할 수 있습니다. 그러면 "흐른 시간"이 음수가 되고 계산에 따라 토큰이 폭증하거나 음수로 꺼집니다. 로컬에선 안 보이다가 운영 서버의 시간 동기화 한 번에 터지는 종류입니다.

**함정 둘, 같은 버킷을 여러 스레드가 동시에 친다.** 웹 요청은 스레드 풀에서 병렬로 처리됩니다. 한 클라이언트가 동시에 여러 요청을 보내면, 여러 스레드가 **같은 버킷**의 토큰을 동시에 소비하려 듭니다. `if (남은 토큰 > 0) 토큰--` 같은 검사-후-실행(check-then-act)은 원자적이지 않아서 두 스레드가 동시에 "토큰 있음"을 보고 둘 다 통과해 버립니다. 용량 5인데 6건이 통과하는 초과 소비가 생깁니다.

이 둘을 막지 못하면 "유량제어를 한다"는 말이 코드로 증명되지 않습니다.

### 3. 판단, 필터 체인은 인터페이스로 짜고 시계는 단조로, 버킷은 잠근다

세 가지를 정했습니다.

**하나, 필터 체인은 직접 추상화한다.** 요청이 순서대로 통과하는 체인을 `GatewayFilter` 인터페이스 + 체인 실행기로 짭니다. 각 필터는 통과(다음으로 넘김) 아니면 차단(상태코드·사유 남기고 멈춤)을 결정합니다. 서블릿 API에 묶이지 않는 순수 자바로 두어 필터 로직만 단독 테스트할 수 있게 하고 서블릿과의 연결은 얇은 브릿지 하나로 격리합니다.

**둘, 시계는 단조(monotonic) 시계를 쓴다.** `System.nanoTime()`은 뒤로 가지 않음이 보장됩니다. 게다가 테스트에서 시간을 마음대로 흘릴 수 있게 시계를 주입 가능한 `LongSupplier`로 둡니다(가짜 시계로 보충 로직을 결정론적으로 검증).

**셋, 버킷은 버킷 단위로 잠근다.** 클라이언트마다 버킷 하나를 `ConcurrentHashMap`에 두되, 버킷의 소비 연산은 `synchronized`로 묶습니다. 락 범위가 그 클라이언트 버킷 하나라, 다른 클라이언트끼리는 서로 안 막습니다.

### 4. 개선, 체인을 짜고 단조 시계로 채우고 버킷을 잠근다

#### 4-1. 필터 인터페이스와 체인 실행기

필터는 통과면 `chain.next(...)`를 부르고 차단이면 `response.block(...)`을 부른 뒤 next를 **안** 부릅니다. 그 순간 체인이 멈춥니다.

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

라우팅 필터는 "메서드 + 경로"를 라우팅 테이블에서 찾고 없으면 404로 끊습니다. 테이블 구조라 거래가 늘면 줄만 추가하면 됩니다(지금은 목업 계정계로 가는 잔액조회 한 줄).

#### 4-2. 토큰버킷, 단조 시계로 채운다

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

`elapsed > 0` 가드가 함정 하나(시간 역행)를 막습니다. 벽시계였다면 여기서 `elapsed`가 음수가 돼 `tokens`가 요동쳤을 겁니다. 단조 시계라 그럴 일이 없고 혹시 몰라 가드까지 둡니다.

#### 4-3. 유량제어 필터, 버킷을 원자적으로 만들고 버킷 단위로 잠근다

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

#### 4-4. 서블릿에 잇는 브릿지

손으로 짠 체인을 서블릿 파이프라인에 연결하는 건 얇은 브릿지 하나입니다. `HttpServletRequest`에서 필요한 것만 뽑아 체인을 태우고 **막히면** 그 상태코드·사유로 응답하고 백엔드로 안 넘깁니다. **통과하면** 체인이 남긴 헤더를 응답에 실어 준 뒤 컨트롤러로 넘깁니다. `/api/gateway/*`에만 걸어, 통역만 하던 나머지 API(`/api/build` 등)는 문지기 밖입니다.

### 5. 왜 모듈러 모놀리스인가, 경계를 코드가 강제하니까

이번에 필터 층이 들어오며 클래스가 늘었습니다. 통역 코덱, 계정계 연동, 관문 필터, REST 컨트롤러가 한 프로젝트에 섞이기 시작하는 지점입니다. 여기서 코드베이스를 [Spring Modulith](https://spring.io/projects/spring-modulith) 기반 **모듈러 모놀리스**로 재정렬했습니다. 기술적 근거는 셋입니다.

**하나, 모듈 경계를 코드가 강제한다.** `io.gwanmun` 바로 아래 각 패키지를 하나의 애플리케이션 모듈로 둡니다. `message`는 전문 코덱(순수), `core`는 계정계 연동, `gateway`는 관문 필터 체인, `web`은 REST 조립을 맡습니다. 각 모듈은 자기 기반 패키지의 타입만 API로 내놓고 하위 패키지(예: 필터 구현 세부)는 내부에 감춥니다. 이 경계는 문서에 적어 둔 약속에 머물지 않고 **테스트로 검증**됩니다.

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

누가 실수로 `message`가 `web`을 참조하게 만들면(순환) 테스트가 즉시 깨집니다. 경계를 사람 눈 대신 빌드가 지킵니다.

**셋, 단일 배포 단위를 유지한다.** 이건 마이크로서비스가 아닙니다. 프로세스도, 배포도 하나입니다. 다만 모듈 경계가 코드로 강제되니, 나중에 필요하면 쪼갤 수 있는 선택지를 남겨둘 뿐입니다. 지금 필요하지도 않은 분산을 미리 지불하지 않으면서, 경계의 이점만 취하는 선택입니다.

`message` 모듈은 다른 모듈이 전문 필드를 다뤄야 하므로 `dto`·`spec` 하위 패키지만 `@NamedInterface`로 열고 나머지는 감췄습니다. 모듈 다이어그램은 Documenter로 생성해 `docs/modules/`에 남겼습니다(components.puml, 모듈별 puml·adoc).

### 6. 실측, 401 / 403 / 404 / 429의 진짜 응답

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

문지기(인증→라우팅→유량제어)를 다 통과한 뒤에야 1편의 전문 왕복이 실행됩니다. 문 통과 후 통역입니다.

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

정확히 5건이 통과하고 6번째부터 429 + Retry-After가 붙습니다. 화면에도 같은 걸 붙였습니다. 키와 횟수를 정해 연속 전송하면 통과(초록)와 차단(빨강)이 줄줄이 찍히고 합계가 뜹니다.

![게이트웨이 방어 장면. 5건 통과 후 429로 3건 차단, 클라이언트별 토큰버킷](/uploads/project/gwanmun/gateway-guard.png)

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

모듈 경계 검증까지 합쳐 `./gradlew test`는 **52개 전부 그린**입니다(1편의 37개 + 이번 15개). `ModularityTest`의 `verify()`가 그린이라는 건, 위에 그린 모듈 DAG가 코드로 지켜지고 있다는 뜻입니다.

### 7. 잔여, 정직하게 안 한 것

- **분산 환경 rate limit 공유 안 됨.** 토큰버킷은 **단일 노드 인메모리**입니다. 인스턴스를 여럿으로 늘리면 각자 따로 세므로 전역 한도가 안 맞습니다. 공유하려면 Redis 같은 외부 저장소에 카운터를 둬야 하는데, 그 순간 네트워크 왕복·원자 연산·장애 시 동작이라는 새 문제가 붙습니다. 여기선 단일 노드로 명시하고 확장 지점으로 남깁니다.
- **JWT/OAuth 미구현.** 인증은 정적 API 키 검증까지입니다. 토큰 만료·서명 검증(JWT)이나 발급/위임 흐름(OAuth)은 범위 밖입니다. 인터페이스는 같은 자리(인증 필터)라 나중에 교체할 수 있게만 뒀습니다.
- **API 키 평문 보관.** 설정·인메모리에 평문으로 둡니다. 실서비스라면 시크릿 스토어에 두고 해시로 대조하겠지만 학습판의 경계입니다.
- **모듈러 모놀리스 ≠ 마이크로서비스.** 단일 배포 단위입니다. 경계가 코드로 강제될 뿐 프로세스·DB·배포는 하나입니다.

이제 통로 앞에 문지기가 섰습니다. 누가 보냈는지 확인하고 갈 곳이 있는지 보고 너무 자주 치면 잠시 막습니다. 그 관문을 통과한 요청만 1편의 전문 왕복에 닿습니다. 하지만 운영 중 "잔액조회가 가끔 실패한다"는 말이 나오면, 지금 구조로는 **어디서 깨졌는지**가 안 보입니다. 인증에서? 라우팅에서? 백엔드 타임아웃에서? 3편은 그 거래의 경로를 남기고 실패 지점을 드러냅니다.

그 전에, 1편 2부가 잔여로 남겨 둔 통로의 구멍 둘, 곧 가변 전문과 소켓 재사용부터 2부에서 메웁니다.

## 2부. 가변 프레이밍과 커넥션 풀

### 1. 상황, 1편 2부가 남겨 둔 두 개의 구멍

[1편](/blog/project/gwanmun/gwanmun-1-parser-and-framing) 2부에서 통로를 열 때, 잔여로 두 가지를 정직하게 적어 뒀습니다.

> 커넥션 풀 없음(요청당 소켓), 길이 헤더(가변 전문) 미구현.

1편 2부의 프레이밍은 "한 전문 = 고정 61byte"만 다뤘습니다. 프레임 길이를 상수로 아니까, 그 길이만큼 모이면 잘라 내보내면 됐습니다. 하지만 실제 거래에는 **길이가 매번 다른 전문**이 있습니다. 대표적인 게 거래내역 조회 응답입니다. 계좌에 거래가 3건이면 레코드 3개, 12건이면 12개가 붙어 전문 전체 길이가 조회할 때마다 달라집니다. 프레임 길이 상수를 못 씁니다.

두 번째 구멍은 소켓입니다. 1편 2부의 클라이언트는 `exchange()`가 불릴 때마다 소켓을 새로 열고 응답을 받고 닫았습니다. 요청 한 건에 TCP 3-way 핸드셰이크 한 번, 소켓 자원 한 벌을 매번 지불한 셈입니다. 한두 건이면 티가 안 나지만 초당 수백 건이 흐르면 이 반복 비용이 그대로 지연이 됩니다.

이번 편의 목표는 그 두 구멍을 메우는 것입니다.

> 하나, 길이 헤더로 가변 전문을 프레이밍한다. 둘, 커넥션 풀로 소켓을 재사용한다.

### 2. 함정, 가변 프레이밍의 2단계와 풀의 동시성·고갈

#### 함정 하나, 헤더도 반쪽으로 온다

가변 전문의 정석은 "전문 앞에 본문이 몇 byte인지 적은 길이 헤더를 두는 것"입니다. 받는 쪽은 헤더를 읽어 본문 길이 L을 알고 L byte를 모으면 한 전문이 완성됩니다.

문제는 TCP가 바이트 스트림이라는 점이 여기서 한 겹 더 깊어진다는 것입니다. 1편 2부에서 "고정 61byte도 한 번에 안 온다"를 다뤘는데, 가변에서는 **길이 헤더조차 반쪽으로 옵니다.** 4byte 헤더 중 2byte만 먼저 오면, 본문 길이를 아직 읽을 수조차 없습니다. 그러니 읽기가 2단계여야 합니다.

1. **1단계**: 헤더 4byte가 다 모일 때까지 기다린다(헤더 반쪽 방어).
2. **2단계**: 헤더로 본문 길이 L을 안 뒤, 본문 L byte가 다 모일 때까지 더 기다린다(본문 반쪽 방어).

여기에 1편 2부의 함정들이 그대로 얹힙니다. 여러 전문이 붙어 오는 뭉침과 한 전문 반쪽만 남는 경계 말입니다.

#### 함정 둘, 길이 헤더를 믿으면 안 된다

길이 헤더 방식의 조용한 위험은, **헤더에 적힌 숫자를 그대로 믿는다는 것**입니다. 스트림에 쓰레기 바이트가 섞이거나 헤더가 손상되면, 헤더가 "본문 9999byte"라고 거짓말할 수 있습니다. 그걸 믿고 "9999byte 올 때까지 기다리자"고 하면, 오지도 않을 바이트를 무한정 기다리거나 거대한 버퍼를 잡으려 듭니다. 자원 고갈로 번지는 표면입니다. 그래서 헤더는 **검증하고 어긋나면 즉시 끊어야** 합니다(fail-closed).

#### 함정 셋, 풀은 동시성과 고갈에서 샌다

커넥션 풀은 개념은 단순하지만("연 소켓을 쥐고 있다가 다음에 재사용") 두 곳에서 샙니다.

- **동시성**: 웹 요청은 스레드 풀에서 병렬로 처리됩니다. 여러 스레드가 동시에 풀에서 빌리고 반납하면, 카운터와 유휴 큐가 경쟁 상태에 빠져 "최대 4개"라던 풀이 5개, 6개를 열 수 있습니다.
- **고갈**: 최대 크기까지 다 빌려 나간 상태에서 또 요청이 오면 어떻게 할 것인가. 무한정 기다리면 스레드가 끝없이 적체됩니다. 정책을 정해야 합니다.

### 3. 판단, 2단계 누적기와 검증하는 헤더, 잠그고 거절하는 풀

**하나, 가변 프레이밍은 고정 프레이밍과 나란히 둔다.** 1편 2부의 `FixedLengthFramer` 옆에 `LengthPrefixedFramer`를 새로 만듭니다. 둘 다 "소켓 조각을 누적하다가 한 전문이 완성되면 잘라 내보낸다"는 같은 골격이되, 경계를 잡는 방법만 다릅니다(상수 길이 vs 헤더가 알려주는 길이).

**둘, 헤더는 4byte ASCII 십진수로 두되 반드시 검증한다.** 헤더가 숫자가 아니거나, 설정한 상한을 넘는 길이를 요구하면 그 자리에서 실패시킵니다. 4byte ASCII로는 음수를 표현할 수 없지만 그 자리에 온 비-숫자·과대 길이가 현실의 "비정상 길이"입니다. 믿지 않고 끊습니다.

**셋, 가변 전문 코덱은 고정 코덱을 두 번 쓰는 것으로 만든다.** 응답 본문은 "고정 헤더 + 고정 레코드 × N"입니다. 1편의 고정 코덱을 앞 헤더에 한 번, 뒤 레코드에 건수만큼 쓰면 됩니다. 경계는 이미 전송 계층의 길이 헤더가 확정해 주므로, 본문 전체 길이에서 역산합니다.

**넷, 풀은 하나의 락으로 관리하고 가득 차면 거절한다.** 카운터·유휴 큐 갱신은 전부 하나의 `ReentrantLock` 안에서 하고 느린 소켓 open만 락 밖에서 합니다. 최대 크기까지 다 나간 상태에서 또 빌리면, 정해진 시간만 기다리다 그래도 자리가 없으면 무한 대기 대신 예외로 거절합니다(빠른 실패).

### 4. 개선, 헤더로 자르고 코덱을 두 번 쓰고 풀로 재사용한다

#### 4-1. 길이 프리픽스 프레이머, 2단계로 자른다

핵심은 `next()`입니다. 헤더가 덜 왔으면 1단계에서, 본문이 덜 왔으면 2단계에서 각각 `null`을 돌려주고 다음 조각을 기다립니다.

```java
public byte[] next() throws MalformedFrameException {
    if (size < HEADER_LENGTH) {
        return null;                       // 1단계: 헤더가 아직 반쪽
    }
    int bodyLength = parseHeader();        // 헤더를 읽어 본문 길이를 안다(검증 포함)
    int frameLength = HEADER_LENGTH + bodyLength;
    if (size < frameLength) {
        return null;                       // 2단계: 본문이 아직 덜 참
    }
    byte[] body = Arrays.copyOfRange(buffer, HEADER_LENGTH, frameLength);
    int remaining = size - frameLength;
    System.arraycopy(buffer, frameLength, buffer, 0, remaining); // 남은 건 다음 전문
    size = remaining;
    return body;
}
```

`parseHeader()`가 함정 둘(믿으면 안 되는 헤더)을 막습니다. 숫자가 아니면, 상한을 넘으면, 그 자리에서 끊습니다.

```java
private int parseHeader() throws MalformedFrameException {
    String header = new String(buffer, 0, HEADER_LENGTH, US_ASCII);
    int bodyLength = 0;
    for (int i = 0; i < HEADER_LENGTH; i++) {
        char c = header.charAt(i);
        if (c < '0' || c > '9') {          // 손상·쓰레기 바이트
            throw new MalformedFrameException("길이 헤더가 숫자가 아닙니다: '" + header + "'");
        }
        bodyLength = bodyLength * 10 + (c - '0');
    }
    if (bodyLength > maxBodyLength) {      // 자원 고갈 방어
        throw new MalformedFrameException("길이 헤더가 상한을 초과합니다: " + bodyLength);
    }
    return bodyLength;
}
```

읽는 쪽(`LengthPrefixedConnection`)은 1편 2부의 `FramedConnection`과 같은 골격입니다. read 버퍼를 일부러 작게(16byte) 잡아, 헤더·본문이 한 번에 안 오는 상황을 코드가 구조적으로 다루게 합니다.

#### 4-2. 가변 전문 코덱, 고정 코덱을 두 번 쓴다

응답 본문은 `고정 헤더(30byte) + 레코드(55byte) × N`입니다. 헤더는 **건수(recordCount)**와 **전체 본문 길이(totalLength)**를 담아, 뒤에 몇 건이 얼마만큼 붙는지 스스로 설명합니다(self-describing). 파싱은 전체 길이에서 건수를 역산합니다.

```java
public <H, R> VariableMessage<H, R> parse(byte[] body, Class<H> headerType, Class<R> recordType) {
    int headerLen = MessageSpec.of(headerType).totalLength();   // 30
    int recordLen = MessageSpec.of(recordType).totalLength();   // 55
    int recordArea = body.length - headerLen;
    if (recordArea % recordLen != 0) {                          // 딱 안 떨어지면 잘린 전문
        throw new GwanmunParseException("레코드 영역이 레코드 길이로 나눠떨어지지 않습니다");
    }
    int count = recordArea / recordLen;
    H header = codec.parse(Arrays.copyOfRange(body, 0, headerLen), headerType);
    List<R> records = new ArrayList<>(count);
    for (int i = 0; i < count; i++) {
        int start = headerLen + i * recordLen;
        records.add(codec.parse(Arrays.copyOfRange(body, start, start + recordLen), recordType));
    }
    return new VariableMessage<>(header, records);
}
```

클라이언트는 파싱 후 헤더가 밝힌 건수·전체길이가 실제와 맞는지 교차검증합니다. 전문의 자기 설명이 거짓이 아닌지 확인하는 셈입니다.

#### 4-3. 커넥션 풀, 하나의 락으로 재사용하고 고갈되면 거절한다

풀은 유휴 연결을 큐에 두고 빌릴 때 검증부터 합니다. 유휴가 있으면 재사용, 없으면 최대 크기 안에서 새로 열고 가득 차면 대기 후 거절합니다.

```java
public Lease borrow() throws IOException, InterruptedException {
    long deadlineNanos = System.nanoTime() + borrowTimeoutMs * 1_000_000L;
    lock.lock();
    try {
        while (true) {
            Entry e = idle.pollFirst();
            if (e != null) {
                if (e.conn.isValid()) {                // 유휴 중 죽지 않았나 검증
                    active++; e.reuseCount++; reusedCount++;
                    return new Lease(e);               // 재사용
                }
                closeQuietly(e.conn); total--; destroyedCount++;
                continue;                              // 죽은 건 버리고 다시
            }
            if (total < maxSize) {
                total++;                               // 슬롯 선점(초과 생성 차단)
                lock.unlock();
                C conn = factory.create();             // 느린 소켓 open은 락 밖에서
                lock.lock();
                createdCount++; active++;
                return new Lease(new Entry(conn));
            }
            long remaining = deadlineNanos - System.nanoTime();
            if (remaining <= 0) {
                throw new PoolExhaustedException(name, maxSize, borrowTimeoutMs); // 거절
            }
            slotAvailable.awaitNanos(remaining);       // 반납을 기다린다
        }
    } finally {
        if (lock.isHeldByCurrentThread()) lock.unlock();
    }
}
```

`total < maxSize`에서 먼저 `total++`로 슬롯을 선점하는 게 동시성 방어의 핵심입니다. 여러 스레드가 동시에 "여유 있다"를 봐도, 슬롯을 선점한 스레드만 실제로 새 소켓을 열기 때문에 최대 크기를 넘지 않습니다. 반납(`release`)은 연결을 검증해 살아 있으면 유휴 큐로 돌리고 죽었거나 처리 중 깨졌으면(`invalidate`) 폐기합니다.

`CoreBankingClient`(1편 2부, 고정 61byte)와 새 `TransactionHistoryClient`(가변)가 각자 이 풀을 하나씩 들고 `exchange()`/`query()`가 빌려 쓰고 반납합니다. 계정계가 keep-alive라 한 소켓으로 여러 전문을 주고받을 수 있어(서버측 처리 루프가 프레임이 더 안 올 때까지 읽습니다) 풀이 성립합니다.

### 5. 실측, 진짜 실행

앱을 8090에 띄우고(내장 목업 계정계 두 개: 잔액조회 9099, 거래내역 9098), 실제로 왕복시켰습니다.

#### 가변 전문 왕복, 길이 헤더가 보인다

`12345678901234` 계좌의 거래내역 5건을 조회했습니다. 요청 전선은 44byte(길이 헤더 4 + 본문 40), 응답 전선은 309byte입니다. 응답의 앞 4byte가 길이 헤더입니다(실제 출력).

```
응답 전선 앞부분 (hex):
0000  30 33 30 35 30 33 31 30   0305 0310   ← 앞 4byte "0305" = 본문 305 byte
0008  31 32 33 34 35 36 37 38   12345678
...
총 309 byte (길이 헤더 4 + 본문 305 = 헤더 30 + 레코드 55 × 5)
```

헤더 `30 33 30 35`는 ASCII `"0305"`, 즉 본문이 305byte라는 선언입니다. 305 = 헤더 30 + 레코드 55 × 5건. 파싱하면 헤더와 레코드 5건이 나옵니다(응답 JSON에서 발췌).

```json
"header": { "messageType": "0310", "accountNo": "12345678901234",
            "recordCount": "5", "totalLength": "305", "responseCode": "0000" },
"records": [
  { "seq": "1", "txDate": "20260621", "txType": "입금", "amount": "477000",
    "balanceAfter": "6879922000", "summary": "급여이체" },
  { "seq": "2", "txDate": "20260624", "txType": "출금", "amount": "8000",
    "balanceAfter": "6879914000", "summary": "카드결제" },
  ... (3건 더)
]
```

`txType`(입금/출금)과 `summary`(급여이체·카드결제…)가 한글입니다. 레코드 슬라이스도 byte 오프셋으로 잘라 EUC-KR로 디코딩하므로, 2byte 한글이 경계에서 안 깨집니다(1편의 원칙이 레코드에도 그대로).

건수를 바꾸면 전체 길이가 따라 바뀝니다. 3건이면 본문 195byte, 10건이면 본문 580byte입니다. 이게 "가변"의 실측입니다.

#### 커넥션 풀, 순차는 소켓 1개, 동시는 최대 크기까지

같은 클라이언트로 순차로 6번 조회하면, 첫 왕복만 소켓을 새로 열고 이후는 재사용합니다(실제 출력).

```
조회 1: created(신규 소켓)       pool[created=1 reused=0 idle=1]
조회 2: reused #1            pool[created=1 reused=1 idle=1]
조회 3: reused #2            pool[created=1 reused=2 idle=1]
조회 4: reused #3            pool[created=1 reused=3 idle=1]
조회 5: reused #4            pool[created=1 reused=4 idle=1]
조회 6: reused #5            pool[created=1 reused=5 idle=1]
```

`created`가 1로 고정입니다. 소켓을 딱 하나만 열어 여섯 번 재사용했습니다. 1편 2부라면 여기서 소켓을 여섯 번 열고 닫았을 겁니다.

같은 풀에 동시에 10건을 폭주시키면, 이번엔 여러 소켓이 필요합니다. 하지만 최대 크기(4) 이상은 절대 열지 않습니다(실제 출력).

```
동시 폭주 후: created=4 (== max 4) · reused=12 · idle=4 · destroyed=0
```

`created=4`가 정확히 최대 크기와 같습니다. 10개 요청이 동시에 몰려도 소켓은 4개까지만 열고 나머지는 반납된 걸 이어받아 재사용했습니다. 슬롯 선점 방어가 동시성에서 초과 생성을 막은 결과입니다. 잔액조회(고정 61byte) 풀도 같은 방식으로 붙어, 세 번 조회하면 `created=1 reused=2`로 소켓 하나를 재사용합니다.

화면에도 같은 걸 붙였는데, 가변 전문 왕복은 길이 헤더가 노랗게 강조된 hex 덤프와 레코드 표를, 풀 상태는 활성/유휴/재사용 카운터를 보여줍니다.

![가변 전문 왕복(길이 헤더 강조 hex + 레코드 5건)과 커넥션 풀 상태(순차 재사용·동시 최대 크기)](/uploads/project/gwanmun/variable-length-demo.png)

#### 함정은 테스트로 강제했다

가장 중요한 경계들은 화면 데모로는 부족해 테스트로 못 박았습니다. `./gradlew test`는 **80개 전부 그린**입니다(1편과 1부의 52개 + 이번 28개).

- `LengthPrefixedFramerTest`(11)에서는 헤더 반쪽, 본문 반쪽, 한 바이트씩, 뭉침(길이 다른 세 전문), 한 전문 반, 빈 본문, 그리고 비정상 길이 거절(숫자 아님·상한 초과)을 검증합니다.
- `VariableMessageCodecTest`(4)에서는 레코드 5건 왕복 무손실(한글 포함), 0·1·12건 가변, 잘린 전문 거절을 확인합니다.
- `ConnectionPoolTest`(7)에서는 재사용(같은 소켓 객체), 죽은 연결 폐기, `invalidate` 폐기, 고갈 거절(대기 후 `PoolExhausted`), 대기자가 반납분을 이어받음, 동시성(8스레드×50회가 최대 3짜리 풀을 쳐도 활성이 3을 절대 안 넘음), 닫힌 풀 거절을 다룹니다.
- `MockTransactionHistoryServerTest`(6)에서는 실제 소켓 가변 왕복, 건수별 길이 차이, 결정론, 풀 재사용(한 소켓으로 keep-alive 3건), 서버측 partial read(길이 헤더 중간·본문 중간에서 쪼갠 요청 재조립), 동시 8건을 검증합니다.

동시성 테스트는 소켓 없이 가짜 연결로 풀 계약만 봅니다. 활성 수가 최대를 넘지 않고 재사용이 실제로 일어나며 만들어진 연결이 최대 크기 이하인지 확인합니다.

```java
assertThat(maxObservedActive.get()).isLessThanOrEqualTo(maxSize); // 초과 생성 없음
assertThat(ids.get()).isLessThanOrEqualTo(maxSize);               // 최대만큼만 열림
assertThat(pool.stats().reused()).isGreaterThan(0);               // 재사용이 실제로
```

#### 모듈 경계는 계속 코드가 강제한다

1부에서 세운 모듈러 모놀리스 경계는 이번에도 `ApplicationModules.verify()`가 그린으로 지킵니다. 클래스가 늘었지만(가변 프레이머·풀·거래내역 클라이언트는 `core`에, 가변 코덱·레코드 DTO는 `message`에, 새 컨트롤러는 `web`에) 전부 제자리에 들어가 순환이 생기지 않았습니다. 의존은 여전히 단방향 DAG이고 이번에 `web → core` 한 줄이 늘었습니다(새 컨트롤러가 거래내역 클라이언트를 씀).

```
web      → gateway, message, core
gateway  → message, core
core     → message
message  → (없음 — 순수 모듈)
```

Documenter가 다시 그린 다이어그램은 `docs/modules/`에 갱신돼 있습니다.

### 6. 잔여, 정직하게 안 한 것

- **길이 헤더는 4byte ASCII 십진수 한 종류.** 본문 최대 9999byte까지만 표현합니다. 실무에는 2byte·4byte 바이너리(빅엔디언), 헤더에 본문 외 다른 필드까지 포함하는 변형이 많지만 여기선 한 종류로 원리를 보였습니다. 더 큰 전문·다른 헤더 규격은 프레이머의 헤더 해석부만 바꾸면 되는 자리로 남깁니다.
- **풀은 최소 기능.** 최대 크기·유휴 반납·검증·고갈 거절까지입니다. 유휴 연결의 최대 생존 시간(오래 놀던 소켓 선제 폐기), 주기적 헬스체크, 최소 유휴 수 유지(warm pool), 연결 누수 감지 같은 상용 풀의 기능은 없습니다. 검증은 빌려주기/반납 시점의 소켓 상태 확인까지입니다.
- **파이프라이닝 없음.** 한 연결에서 요청→응답을 끝낸 뒤 다음을 보냅니다. 응답을 기다리지 않고 요청을 연달아 밀어 넣는 파이프라이닝은 범위 밖입니다(프레이머는 뭉침을 처리하니 받는 쪽 토대는 있지만 보내는 쪽 상관관계 관리는 안 했습니다).
- **가변 전문은 대표 한 종.** 거래내역 조회 하나로 "고정 헤더 + 반복 레코드" 구조를 보였습니다. 중첩 가변(레코드 안에 또 가변 배열)이나 선택 필드가 있는 전문은 다루지 않았습니다.

1편 2부가 남긴 두 구멍을 메웠습니다. 이제 길이가 매번 다른 전문도 프레이밍으로 정확히 자르고 소켓은 요청마다 새로 열지 않고 재사용합니다. 통로가 더 튼튼해졌습니다.

---
title: '부하를 걸었더니 감사가 예고한 서킷 레이스가 드러났다 — A3 stale 귀속 수정과 k6 실측'
titleEn: 'Load Testing Surfaced the Circuit Race the Audit Predicted — Fixing A3 Stale Attribution, Measured with k6'
description: "7편의 감사는 A3(서킷 stale 결과 귀속)를 '난이도 대비 실익이 낮다'며 백로그로 미뤘습니다. 8편에서 부하 테스트를 붙이자 그 미룬 버그가 실제로 드러났습니다 — 서킷이 열렸다 닫혔다 하는 15초 부하 창에서 stale 결과 보고가 197번 발생했고, staleResultsTotal 카운터가 그걸 셌습니다. A3는 CLOSED에서 나간 호출이 OPEN→HALF_OPEN 전이 뒤 늦게 돌아올 때, 그 성공이 HALF_OPEN을 거짓으로 닫거나(회복 확인도 안 하고) 실패가 탐침 정원을 음수로 깎는 레이스입니다. 고친 방법: acquire()가 상태 세대를 담은 permit 토큰을 발급하고, 결과 보고는 세대가 일치할 때만 상태에 반영합니다. 세대 가드를 무력화해 돌리면 정확히 A3 두 건만 빨갛게 떠서, 수정 전/후가 결정론적으로 갈립니다. 그리고 세 가지를 실측했습니다 — (a) 한계 TPS·P95 곡선(무릎 ~10-12k req/s, 6k까지 p95<1ms, 실패율 전 구간 0%), (b) 게이트웨이 경유 오버헤드(같은 클라이언트로 목업에 직접 붙은 기준선 대비 ~0.21ms/req, 처리량 병목은 TCP 풀이 아니라 웹 계층 — 커넥터 40k vs 전체 경로 12k req/s), (c) 빠른 실패의 값(죽은 백엔드에서 서킷 off는 351 req/s·p50 8초로 붕괴, on은 9,425 req/s·p50 0.68ms로 즉시 거절). CI(GitHub Actions), MIT LICENSE, Spring Boot 3.5.4 업그레이드(문서 API 한 줄만 적응, 150건 그린)까지 함께 소진했습니다."
descriptionEn: "Stage 7's audit deferred A3 (stale-result attribution in the circuit breaker) as 'low payoff for the difficulty.' Stage 8 attached a load test and the deferred bug surfaced for real — in a 15-second window where the circuit flapped open and closed, stale result reports arrived 197 times, and a staleResultsTotal counter caught them. A3 is a race: when a call that left in CLOSED returns late, after an OPEN to HALF_OPEN transition, its success falsely closes HALF_OPEN (without confirming recovery) or its failure drives the probe count negative. The fix: acquire() issues a permit token stamped with the state generation, and result reports only affect state when the generation still matches. Neutralize the generation guard and exactly the two A3 tests go red — pre-fix and post-fix split deterministically. Three things measured: (a) the knee/P95 curve (knee at ~10-12k req/s, p95 under 1ms up to 6k, 0% errors throughout), (b) gateway-through overhead (~0.21ms/req over a same-client direct-to-mock baseline; the throughput bottleneck is the web layer, not the TCP pool — connector 40k vs full path 12k req/s), (c) the value of fast failure (against a dead backend the circuit-off path collapses to 351 req/s at 8s p50, while circuit-on serves 9,425 req/s at 0.68ms p50 by rejecting instantly). Also landed: CI on GitHub Actions, an MIT LICENSE, and a Spring Boot 3.5.4 upgrade that needed only a one-line docs-API adaptation (150 tests green)."
date: 2025-10-19
tags:
  - Java
  - Spring Boot
  - 서킷브레이커
  - 부하테스트
  - k6
  - 동시성
category: personal/gwanmun
coverImage: /uploads/project/gwanmun/cover.svg
draft: false
series: "gwanmun"
seriesOrder: 8
---

## 1. 상황 — 테스트는 로컬에서만 돌고, 서킷은 부하 앞에서 미지수였다

[7편](/blog/project/gwanmun/gwanmun-7-audit-fixes)까지 테스트가 147건 쌓였습니다. 문제는 그게 **제 노트북에서만** 돈다는 것이었습니다. 커밋을 밀어도 아무도 확인하지 않고, 공개 레포인데 LICENSE 파일도 없었습니다. 그리고 더 큰 공백 — 이 게이트웨이가 **부하 앞에서 어떻게 되는지** 재 본 적이 한 번도 없었습니다. 지금까지의 실측은 전부 curl 동시 8건 수준이었으니까요.

7편 감사는 확정 결함 하나를 "난이도 대비 실익이 낮다"며 백로그로 미뤘습니다. **A3 — 서킷 stale 결과 귀속.**

> OPEN 전이 직전에 나가 있던 호출의 늦은 onSuccess/onFailure가 새 상태에 섞일 수 있다.

그때는 "실익이 낮다"고 적었는데, 돌이켜 보면 그건 **부하를 걸어 본 적이 없어서 실익을 몰랐던 것**이기도 했습니다. A3는 동시성과 상태 전이가 겹쳐야 드러나는 버그라, curl 몇 방으로는 절대 안 보입니다. 그래서 8편의 순서는 자연스럽게 정해졌습니다 — **부하 하네스를 붙이고, 그게 드러낸 A3를 고치고, 다시 잰다.**

## 2. 한계 — A3는 왜 부하에서만 보이는가

서킷브레이커의 결과 보고 코드는 6편부터 이렇게 생겼습니다. `onSuccess()`와 `onFailure()`는 **현재 상태만** 봅니다.

```java
public synchronized void onSuccess() {
    if (state == State.HALF_OPEN) {   // 지금 HALF_OPEN이면
        probesInFlight--;
        transition(State.CLOSED, "탐침 성공 — 계정계 회복 확인");
    }
    consecutiveFailures = 0;
}
```

여기 숨은 가정은 "onSuccess를 부르는 호출 = 방금 이 상태에서 나간 호출"입니다. 한산할 땐 참입니다. 하지만 부하가 걸리면 이렇게 어긋납니다.

1. 호출 A가 **CLOSED**에서 허가를 받고 계정계로 나갑니다. 아직 응답이 안 왔습니다.
2. 그 사이 다른 호출들이 줄줄이 실패해 서킷이 **CLOSED → OPEN**으로 전이합니다.
3. 대기가 지나 **OPEN → HALF_OPEN**, 탐침 정원(1)을 진짜 탐침 하나가 차지합니다.
4. **이제서야** 1번의 호출 A가 성공으로 돌아와 `onSuccess()`를 부릅니다.

4번 시점의 `state`는 HALF_OPEN입니다. 그래서 코드는 A의 성공을 **탐침 성공으로 착각**해 `probesInFlight--` 하고 서킷을 닫아 버립니다 — **회복을 확인하지도 않았는데.** 반대로 A가 실패로 돌아오면 `probesInFlight`가 음수가 되고 갓 진입한 HALF_OPEN을 다시 열어, 회복 판단이 통째로 뒤집힙니다. 결과가 **어느 상태 세대에서 나간 호출의 것인지**를 코드가 모르는 게 근본 원인입니다.

한 가지가 더 있었습니다. **버그가 수치를 오염시킵니다.** A3를 안 고친 채 부하를 재면 서킷 관련 숫자가 못 믿을 값이 됩니다. 그래서 순서는 A3 먼저, 측정은 그다음이어야 했습니다.

## 3. 판단 — 결과에 세대(generation)를 새긴다

답은 감사가 예고한 대로 **permit 토큰**입니다. `acquire()`가 그냥 통과시키는 게 아니라, "이 호출이 **어느 상태 세대**에서 허가를 받았는가"를 담은 토큰을 발급합니다. 상태가 한 번 전이할 때마다 세대가 오릅니다. 결과 보고는 permit의 세대가 **현재 세대와 같을 때만** 상태에 반영합니다.

```java
public synchronized Permit acquire() throws CircuitOpenException {
    // ... OPEN이면 거절 / 대기 지나면 HALF_OPEN 전이 ...
    if (state == State.HALF_OPEN) {
        if (probesInFlight >= halfOpenMaxProbes) { /* 거절 */ }
        probesInFlight++;
        return new Permit(generation, true);   // 이 탐침의 세대
    }
    return new Permit(generation, false);      // CLOSED 통과의 세대
}

public synchronized void onSuccess(Permit permit) {
    if (isStale(permit)) return;               // 세대가 다르면 무시
    if (state == State.HALF_OPEN) {
        probesInFlight--;
        transition(State.CLOSED, "탐침 성공 — 계정계 회복 확인");
    }
    consecutiveFailures = 0;
}

private void transition(State to, String why) {
    state = to;
    generation++;   // 전이할 때마다 세대를 올려, 이전 세대의 늦은 결과를 stale로 만든다
    log.warn("서킷 '{}' {} → {} ({})", name, from, to, why);
}
```

앞의 시나리오를 다시 밟으면: 호출 A는 CLOSED에서 세대 0의 permit을 받았습니다. 그 뒤 두 번 전이해 세대가 2가 됐습니다. A가 늦게 돌아와 `onSuccess(permit0)`을 부르면 `permit.generation(0) != generation(2)` — **stale이라 무시**됩니다. HALF_OPEN은 오염되지 않고, 진짜 탐침이 회복을 확인할 때까지 열린 채로 남습니다. 무시한 횟수는 `staleResultsTotal`로 세어 지표로 노출합니다(이게 뒤에서 결정적 증거가 됩니다).

한 가지 더 손봤습니다. 실행기가 받은 permit을 **`finally`로 반드시 정산**하게 했습니다. 어떤 분기로도 못 갚고 빠져나가면(예: Error) 탐침 정원이 새기 때문입니다.

```java
CircuitBreaker.Permit permit = breaker.acquire();
boolean settled = false;
try {
    T result = attempt.call(attemptTimeoutMs);
    breaker.onSuccess(permit); settled = true;
    return result;
} catch (IOException e) {
    breaker.onFailure(permit); settled = true;
    // ...
} finally {
    if (!settled) breaker.onAborted(permit);   // Error로 위를 못 탄 허가를 미사용 반납
}
```

세대 하나만 봐도 되는 이유가 깔끔합니다 — 세대가 같으면 그 사이 전이가 없었다는 뜻이니, permit이 발급된 상태가 지금 상태와 반드시 같습니다. 그래서 "CLOSED에서 받은 permit인데 지금 HALF_OPEN" 같은 애매한 경우를 따로 다룰 필요가 없습니다. 세대가 다르면 무시, 끝.

## 4. 개선 — CI, 부하 하네스, 그리고 실측용 프로파일

수리와 함께 하네스를 깔았습니다.

**CI (GitHub Actions).** `.github/workflows/ci.yml` — push·PR마다 JDK 21에서 `./gradlew test`를 돌립니다. `ApplicationModules.verify()`(모듈 경계 검증)까지 이 테스트 스위트 안에 있어서, 한 번의 실행이 단위·통합·모듈 검증을 모두 덮습니다. 로컬에서만 돌던 150건이 이제 원격에서도 강제됩니다. README에 배지를 붙이고, 공개 레포에 빠져 있던 **MIT LICENSE**도 추가했습니다.

**실측용 `loadtest` 프로파일.** 데모용으로 일부러 낮춰 둔 값(풀 4·rate 5)은 부하 앞에서 인위적 병목이 됩니다. 그래서 별도 프로파일로 풀 100, 유량제어 사실상 해제(rate-capacity 200만), 조회성 재시도 0(순수 1회 왕복 처리량), 목업 지연 0으로 둡니다. 이 값들을 문서에 명시해 재현 가능하게 했습니다. **목표는 "N TPS 달성"이 아니라 한계 TPS·P95·병목 지점을 드러내는 것**입니다(우아한형제들 성능 글의 피크 역산 관례).

**부하 도구 세 종.**
- (a) `loadtest/gw_balance.js` — k6로 `POST /api/gateway/balance`에 고정 도착률을 걸어 한계·P95 곡선.
- (b) `DirectCoreBenchmark` — **같은 클라이언트 코드(`CoreBankingClient`)로** 목업에 직접 붙어 순수 TCP 왕복만 재는 기준선. 별도 소켓 코드를 새로 짜면 비교가 공정하지 않으니 게이트웨이가 쓰는 그 클라이언트를 그대로 씁니다.
- (c) 죽은 백엔드를 두고 서킷 off/on을 대비하는 k6 실행.

한 가지 못을 박아 둡니다 — k6·앱·목업이 **한 머신에서 CPU를 나눠 씁니다.** 그래서 아래 절대 수치는 "결합 시스템의 천장"이지 순수 서버 성능이 아닙니다. 다만 상대 비교(게이트웨이 vs 직접, 서킷 on vs off)는 유효합니다. 지어낼 수 없는 건 지어내지 않습니다.

## 5. 실측 — 부하가 드러낸 A3

### A3, 결정론적으로 갈린다

먼저 회귀 테스트입니다. `CircuitBreakerTest`에 시계와 상태를 주입한 결정론적 재현 3건을 넣었습니다. 세대 가드를 무력화하면(수정 전 동작을 재현) **정확히 A3 두 건만** 빨갛게 뜹니다.

```
CircuitBreakerTest > A3: CLOSED에서 나간 늦은 성공은 HALF_OPEN을 거짓으로 닫지 못한다  FAILED
CircuitBreakerTest > A3: CLOSED에서 나간 늦은 실패는 HALF_OPEN 탐침 정원을 깎거나 서킷을 다시 열지 못한다  FAILED
8 tests completed, 2 failed
```

세대 가드를 되살리면 8건 전부 그린. 수정 전과 후가 이렇게 딱 갈리는 게 좋은 회귀입니다.

### 그런데 이게 실제로 벌어지긴 하나 — staleResultsTotal=197

결정론적 테스트는 "이럴 수 있다"를 증명하지, "실제로 벌어진다"를 증명하진 않습니다. 그건 부하가 증명했습니다. 시나리오 (c)의 서킷 플래핑 부하(죽은 백엔드, HALF_OPEN 탐침이 붙었다 떨어졌다)를 **15초** 돌린 뒤 서킷 상태:

```
GET /api/circuit/stats → coreBanking:
  {"state":"OPEN","openedTotal":2,"rejectedTotal":141268,"staleResultsTotal":197}
```

**staleResultsTotal=197.** stale 결과 보고가 15초에 197번 도착했습니다. 수정 전이라면 이 197건이 전이·탐침 정원에 잘못 섞여 서킷 상태를 오염시켰을 것입니다. A3는 이론상의 레이스가 아니라, 부하가 걸리면 **초당 열몇 번씩 실제로 일어나는** 일이었습니다. 감사가 "실익이 낮다"고 본 게 틀렸던 셈입니다 — 실익이 낮았던 게 아니라 부하를 안 재서 안 보였던 겁니다.

### (a) 한계 TPS · P95 곡선

정상 백엔드에 도착률을 올려 가며 k6를 반복했습니다.

| 목표 TPS | 달성 req/s | p50 | p95 | 실패율 | dropped |
|---:|---:|---:|---:|---:|---:|
| 500 | 500 | 0.49ms | 0.98ms | 0% | 0 |
| 1,000 | 1,000 | 0.37ms | 0.50ms | 0% | 0 |
| 2,000 | 2,000 | 0.31ms | 0.47ms | 0% | 0 |
| 4,000 | 4,000 | 0.26ms | 0.42ms | 0% | 0 |
| 6,000 | 6,000 | 0.27ms | 0.68ms | 0% | 0 |
| 8,000 | 7,914 | 0.31ms | 4.99ms | 0% | 1,271 |
| 10,000 | 9,986 | 0.31ms | 3.28ms | 0% | 202 |
| 12,000 | 11,922 | 0.42ms | 11.6ms | 0% | 1,169 |
| 15,000 | 14,188 | 3.97ms | 36.4ms | 0% | 12,002 |

무릎은 **~10–12k req/s**입니다. ~6k까지 p95가 1ms 밑을 유지하다가 그 위에서 꺾이고, 12k를 넘기면 k6가 목표 도착률 자체를 못 채웁니다(dropped_iterations 급증). 눈여겨볼 건 **실패율이 전 구간 0%**라는 점입니다 — 게이트웨이는 과부하에서 틀린 답을 내는 게 아니라 지연으로 degrade합니다. 원장도, 서킷도 계속 정상입니다.

### (b) 게이트웨이 경유 오버헤드

같은 클라이언트로 목업에 직접 붙은 기준선과 게이트웨이 경유를 나란히 놓습니다.

```
직접 왕복(1스레드, 20k회):  p50=0.048ms  p95=0.079ms  mean=0.055ms
직접 왕복(16스레드):        39,231 req/s  p50=0.331ms
직접 왕복(50스레드):        44,465 req/s  p50=1.153ms
게이트웨이(비포화, 4k/s):    p50=0.264ms
```

**게이트웨이 경유 오버헤드 ≈ 0.21ms/req**입니다(게이트웨이 p50 0.26ms − 직접 왕복 p50 0.05ms). 이 0.21ms가 HTTP 파싱 + 관문 필터 체인(인증·라우팅·유량제어) + 전문 build + 원장 비동기 적재 + JSON 직렬화의 값입니다. 얇습니다.

더 흥미로운 건 처리량 천장입니다. **순수 커넥터는 ~40–44k req/s를 내는데, REST 게이트웨이 전체 경로는 ~12k req/s에서 막힙니다.** 병목은 TCP 커넥션 풀이 아닙니다 — 이 지연대(0.05ms 왕복)에서는 동시 소켓 3개면 1만 TPS를 감당합니다. 진짜 한계는 **웹 계층**입니다. 요청 하나가 서블릿 스레드 하나를 동기 TCP 왕복 동안 통째로 붙잡는 blocking thread-per-request 구조. 이건 "다음에 뭘 최적화할지"의 실측 근거가 됩니다 — 풀을 키우는 게 아니라 웹 계층을 손대야 한다는 것.

### (c) 빠른 실패의 값

마지막으로, 서킷이 왜 있는지를 숫자로 봅니다. 도달 불가 백엔드(connect-timeout 300ms 확정)를 두고 서킷 off와 on을 대비했습니다.

```
서킷 OFF (임계 1억 — 안 열림):  351 req/s   p50=8.11s  p95=8.98s  실패 100%
서킷 ON  (임계 3):             9,425 req/s  p50=0.68ms p95=95.9ms  즉시 거절
```

**서킷이 없으면 죽은 백엔드가 게이트웨이를 같이 눕힙니다.** 모든 요청이 300ms connect 타임아웃을 기다리며 서블릿 스레드를 붙잡아, 처리량이 351 req/s로 붕괴하고 지연이 **8초**로 치솟습니다. 요청이 스레드 풀에 쌓이기만 하니까요.

**서킷이 있으면** 3연속 실패로 열린 뒤 나머지는 계정계 호출 없이 튕겨 냅니다 — 처리량 27배(351 → 9,425 req/s), p50 지연은 8.11초에서 0.68ms로 약 1.2만 배 떨어집니다. 빠른 실패는 처리량을 높이려는 장치가 아닙니다. **스레드를 죽은 백엔드에 헌납하지 않으려는** 장치입니다. 이 숫자가 6편에서 서킷을 손으로 짠 이유를 뒤늦게 정당화해 줍니다.

### Boot 3.5 업그레이드 — 강행 대신 검증

3.3.x는 OSS 지원이 끝났습니다. Spring Boot **3.3.5 → 3.5.4**, Spring Modulith **1.2.7 → 1.4.3**으로 올렸습니다. 백로그에 "실익 대비 위험 있음"이라 적어 뒀던 항목이라, 깨지면 되돌리고 정직히 남긴다는 전제로 마지막에 시도했습니다.

결과는 **채택**입니다. 유일한 파손은 문서 생성 API 한 줄이었습니다 — `Documenter.withOutputFolder(String)` 체이닝이 사라지고 출력 폴더가 생성자의 `Documenter.Options`로 옮겨졌습니다. 적응 후 **150건 전부 그린 + verify() 그린**, 앱 기동·잔액조회·prometheus 노출 모두 정상. rabbit hole이 아니라 원포인트 수정이라 강행이 아닌 채택으로 갈 수 있었습니다. 만약 이게 광범위하게 깨졌다면 되돌리고 "무엇 때문에 보류"를 여기 적었을 겁니다.

### 테스트 — 147 → 150

`./gradlew test` **150건 그린**입니다(기존 147 + A3 회귀 3), Boot 3.5.4 위에서. A3 회귀 3건(늦은 성공 무시·늦은 실패 무시·정상 세대 반영)에 더해, 기존 서킷 테스트는 permit 시그니처로 갱신했습니다.

## 6. 잔여 — 정직하게 안 한 것

- **부하 수치는 단일 머신 결합 천장입니다.** k6·앱·목업이 한 CPU를 나눠 쓴 값이라, 분리된 부하 발생기·전용 서버에서의 절대 성능은 측정하지 않았습니다 — 이번 목적은 상대 비교(게이트웨이 vs 직접, 서킷 on vs off)와 병목 규명이었습니다. "금융권 표준 P95" 같은 공개 근거 없는 수치는 지어내지 않습니다.
- **웹 계층이 병목이라는 건 알았지만 안 건드렸습니다.** thread-per-request가 ~12k에서 막힌다는 실측은 나왔지만, 가상 스레드 전환 같은 처방은 다음 문제입니다(그마저도 카카오페이 실측은 "기본 off, I/O 무거운 구간만 선별 적용"이라, 전면 전환은 애초에 답이 아닙니다).
- **멱등키·EOD 대사 배치·DBTower 연계**는 백로그에 그대로 둡니다.

7편이 "자기 자신이 만든 예외에도 무너지지 않는 게이트웨이"였다면, 8편은 그 감사가 **미뤄 둔 버그를 부하로 끄집어낸** 이야기입니다. "실익이 낮다"는 판단은 종종 "아직 안 재 봤다"의 다른 말입니다. staleResultsTotal이 197을 셀 때, 미뤄 둔 게 실은 초당 열몇 번씩 벌어지고 있었다는 걸 알았습니다. 부하 테스트의 값은 결국 그겁니다 — **모르던 걸 숫자로 보이게 만드는 것.**

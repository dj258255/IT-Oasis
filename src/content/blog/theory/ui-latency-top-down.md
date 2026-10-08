---
title: '느린 UI는 어디서 느린가: 상호작용 하나를 골라 구간으로 나누는 순서'
description: 'UI가 느릴 때 서버, API, 렌더링, 프레임워크를 매번 전부 재는 것은 정석이 아닙니다. Google web.dev의 INP 세 구간과 Brendan Gregg의 드릴다운 분석, Slack·LinkedIn·Notion·Trendyol·Taboola 사례를 근거로 필드에서 좁히고 가장 큰 구간 하나만 여는 순서를 정리했습니다.'
date: 2026-10-08
tags:
  - Performance
  - INP
  - Web Vitals
  - Frontend
  - React
  - Observability
  - Distributed Tracing
category: theory/Performance
coverImage: /uploads/covers/theory/ui-latency-top-down.svg
draft: false
---

"UI 반응이 느린 거라 서버 쪽인지, API 콜 쪽인지, 렌더링 쪽인지, 전부 다인지 측정하고 UI 프레임워크 동작도 까 봐야 되고 피곤하네."

측정으로 원인을 가려야 한다는 방향은 맞습니다. 다만 업계에서 정석으로 쓰는 방법은 네 군데를 매번 다 재는 방식과 다릅니다. 사용자가 느리다고 느낀 상호작용 하나를 먼저 고르고 그 시간을 구간으로 나누고 가장 큰 구간 하나에만 다음 도구를 엽니다. 이 글은 그 순서를 공식 문서와 해외 기술 블로그 사례로 확인한 기록입니다. 백엔드 쪽 지표를 읽는 법은 [Spring 백엔드 개발자가 성능 지표를 읽는 법](/blog/theory/reading-performance-metrics)에 따로 정리했고 여기서는 브라우저에서 시작해 서버까지 내려가는 길을 다룹니다.

## 1. 정석의 뼈대는 드릴다운 분석입니다

성능 분석 방법론을 정리한 Brendan Gregg는 드릴다운 분석(Drill-Down Analysis)을 네 줄로 적습니다.

> 1. Start at highest level
> 2. Examine next-level details
> 3. Pick most interesting breakdown
> 4. If problem unsolved, go to 2

같은 페이지의 지연 분석(Time Division Method)도 순서가 같습니다. 작업 시간을 재고 논리적인 구성 요소로 나누고 지연의 원인이 나올 때까지 계속 나누고 고치면 얼마나 빨라질지 어림합니다.

여기서 피곤함을 줄이는 열쇠는 3번입니다. 각 단계에서 모든 가지를 동시에 재지 않고 가장 의심되는 가지 하나만 고릅니다. 같은 페이지는 반대 사례에도 이름을 붙여 두었습니다. 익숙하거나 인터넷에서 찾았거나 아무거나 손에 잡힌 관측 도구부터 집어 드는 습관을 "가로등 안티 메서드(Streetlight Anti-Method)"라고 부릅니다. 서버 로그, API 응답 시간, 렌더링 프로파일러를 손에 익은 순서대로 다 열어 보는 일이 피곤한 이유가 여기 있습니다. 어디서 시작할지를 손에 익은 도구가 정하고 있기 때문입니다.

웹에서 "가장 높은 수준"에 해당하는 것은 사용자가 느낀 상호작용 하나입니다. 그 기준을 Google이 표준으로 정해 두었습니다.

## 2. 기준은 INP 200ms와 그 안의 세 구간입니다

INP(Interaction to Next Paint)는 2024년 3월 12일 FID를 대체해 Core Web Vitals가 됐습니다. 페이지에 머무는 동안 일어난 클릭, 터치, 키 입력을 관찰하고 필드에서 페이지 로드의 75번째 백분위수를 기준으로 200ms 이하이면 좋음, 500ms를 넘으면 나쁨으로 봅니다.

web.dev는 상호작용 하나를 세 구간으로 나눕니다.

| 구간 | web.dev 정의 | 이 구간이 길면 먼저 의심할 것 |
|---|---|---|
| 입력 지연 | 사용자가 상호작용을 시작한 때부터 이벤트 콜백이 실행되기 시작할 때까지 | 그 순간 메인 스레드를 잡고 있던 다른 작업(초기 로드 스크립트, 서드파티) |
| 처리 시간 | 이벤트 콜백이 끝까지 실행되는 데 걸린 시간 | 이벤트 핸들러와 그 안에서 일어난 프레임워크 렌더 |
| 표시 지연 | 상호작용의 결과를 담은 다음 프레임을 브라우저가 그리기까지 걸린 시간 | 스타일 계산, 레이아웃, 페인트 |

예전 RAIL 모델은 "사용자 입력이 시작한 전환을 100ms 안에 끝내라", "100ms 안에 보이는 응답을 주려면 입력 이벤트를 50ms 안에 처리하라"는 예산을 제시했습니다. 지금 web.dev는 목표를 정할 때 RAIL보다 Core Web Vitals를 권합니다. 그래도 50ms라는 숫자는 남아 있습니다. Long Tasks API가 긴 작업을 판정하는 기준이 50ms이고 그 뒤에 나온 Long Animation Frames API(LoAF)도 같은 50ms를 씁니다.

### INP가 재는 범위는 다음 프레임까지입니다

여기서 질문이 두 갈래로 나뉩니다. web.dev는 INP의 의도를 이렇게 적었습니다. "the intent of INP is not to measure all the eventual effects of an interaction—such as network fetches and UI updates from other asynchronous operations." 클릭하자마자 로딩 표시가 뜨고 데이터는 3초 뒤에 오는 화면은 INP가 좋게 나올 수 있습니다.

그래서 "UI 반응이 느리다"는 말을 들으면 먼저 둘 중 어느 쪽인지 정합니다.

- **"눌렀는데 화면이 굳는다."** 다음 프레임이 늦게 그려지는 문제이고 INP로 잽니다. 원인은 브라우저의 메인 스레드 안에 있습니다.
- **"눌렀더니 반응은 했는데 결과가 늦게 뜬다."** INP 밖의 문제입니다. 클릭부터 결과가 그려질 때까지를 따로 재야 하고 원인은 네트워크나 서버 쪽에 있을 가능성이 큽니다.

이 갈림길 하나로 네 군데를 다 재야 할 일이 둘로 줄어듭니다. 앞쪽은 3장과 4장, 뒤쪽은 5장에서 다룹니다.

## 3. 1단계는 필드 데이터로 느린 상호작용 하나를 고르는 일입니다

web.dev의 순서는 분명합니다. 실제 사용자에게 어떤 상호작용이 문제인지 알려면 필드 데이터가 가장 좋은 정보원이라고 적었습니다. 자체 RUM(실사용자 측정)이 없으면 CrUX(Chrome 사용자 경험 보고서)에서 시작하라고 합니다. 랩 진단은 그다음입니다. "Only after identifying problematic interactions should you reproduce them in controlled environments."

필드에서도 구간까지 볼 수 있습니다. `web-vitals` 라이브러리의 attribution 빌드는 INP 값과 함께 입력 지연, 처리 시간, 표시 지연을 나눠 주고 LoAF 항목으로 어떤 스크립트가 느리게 만들었는지까지 넘겨 줍니다. 입력 지연이 우리 코드 때문인지 서드파티 스크립트 때문인지를 사용자 기기에서 바로 가를 수 있습니다.

필드를 먼저 보는 이유는 개발자 노트북에서 재현한 값과 사용자 화면이 다르기 때문입니다. web.dev는 랩 데이터를 한 기기, 한 네트워크, 한 지역에서 잰 값으로 설명하고 필드 데이터는 사용자의 실제 기기와 네트워크와 지역을 반영한다고 구분합니다. 같은 페이지라도 랩에서 Moto G4를 흉내 내면 텍스트 블록이 LCP 요소로 잡히고 큰 화면 기기를 쓰는 실제 사용자에게서는 다른 요소가 잡히는 예를 듭니다.

redBus 사례가 이 순서를 보여 줍니다. 버스 검색 페이지의 반응 문제는 `web-vitals`로 모은 필드 데이터를 ELK에 쌓아 95번째 백분위수를 보고서야 드러났습니다. 원인은 스크롤 중의 작업이 메인 스레드를 다투는 데 있었습니다. 고친 뒤 INP가 870~900ms에서 350~370ms로 내려갔습니다.

## 4. 2단계는 그 상호작용을 성능 패널에서 세 구간으로 나누는 일입니다

필드에서 고른 상호작용을 Chrome DevTools 성능 패널에서 재현합니다. web.dev는 느린 상호작용을 진단하는 도구로 Chrome 성능 프로파일러를 권하고 처음 볼 곳으로 맨 위 활동 요약을 꼽습니다. 긴 작업이 빨간 막대로 보입니다.

그다음 Interactions 트랙을 봅니다. 상호작용마다 수염 모양의 선이 붙어 있는데 왼쪽 선의 길이가 입력 지연이고 오른쪽 선이 표시 지연입니다. 200ms를 넘은 상호작용에는 오른쪽 위에 빨간 삼각형이 붙습니다. 표시 지연이 길면 메인 스레드에 스타일 계산과 레이아웃(보라색), 페인트와 합성(초록색) 블록이 길게 보입니다.

세 구간 중 가장 긴 것 하나를 고르면 다음에 열 도구가 정해집니다.

![가장 긴 구간에 따라 다음에 여는 도구가 갈리는 그림. 입력 지연은 LoAF 스크립트 귀속, 처리 시간은 프레임워크 프로파일러, 표시 지연은 렌더링 블록, 결과가 늦으면 Resource Timing과 Server-Timing과 추적](/uploads/theory/ui-latency-top-down/decision.svg)

### 입력 지연이 길면 LoAF로 그 순간의 스크립트를 찾습니다

Long Tasks API는 메인 스레드가 50ms 이상 쉬지 않고 일한 구간을 알려 줍니다. 그러나 그 작업이 어느 컨테이너에서 일어났는지까지만 알려 주고 어떤 스크립트나 함수가 불렀는지는 알려 주지 않습니다. LoAF는 `scripts` 배열에 스크립트별 출처와 호출 정보를 담아 이 빈칸을 채웁니다. 다만 Chrome과 Edge 123 이상에서만 지원합니다.

Taboola가 이 도구로 서드파티 문제를 풀었습니다. 퍼블리셔 사이트에 들어가는 자사 스크립트 가운데 무엇이 반응을 막는지 처음에는 가를 수 없었고 LoAF를 붙인 뒤에야 `RELEASE.js` 하나가 서드파티 블로킹 시간 691ms의 대부분을 차지한다는 것을 확인했습니다. 고친 뒤 블로킹 시간이 485ms(70%) 줄었습니다. Taboola는 교훈을 이렇게 적었습니다. "attribution of INP to specific scripts removes any guesswork."

QuintoAndar도 입력 지연에서 출발했습니다. 매물 검색에서 75번째 백분위수 상호작용이 4초까지 걸렸습니다. 원인은 초기 로드 중 메인 스레드를 오래 잡는 작업이었습니다. 모바일 INP를 1,006ms에서 216ms로 줄였고 전년 대비 전환이 36% 올랐다고 밝혔습니다.

### 처리 시간이 길면 그때 프레임워크 프로파일러를 엽니다

질문에 나온 "UI 프레임워크 동작도 까 봐야 한다"는 이 자리에서만 필요합니다. 활동 요약에 긴 작업이 보이고 그 작업이 이벤트 콜백 안의 애플리케이션 코드나 프레임워크 렌더를 가리킬 때입니다. 시간이 입력 지연이나 표시 지연에 몰려 있으면 컴포넌트 프로파일러를 열어도 원인이 나오지 않습니다. 이 기준을 한 문장으로 적어 둔 공식 문서는 찾지 못했습니다. INP 세 구간의 정의와 web.dev 진단 순서를 합쳐서 제가 내린 판단입니다.

Trendyol이 정확히 이 경우였습니다. 상품 목록 페이지의 모바일 INP가 963ms였는데(2023년 9월 5일) Lighthouse의 자바스크립트 실행 시간 감사는 `search-result-v2` 스크립트가 메인 스레드를 가장 오래 잡는다고 알려 줬습니다. 스크립트까지는 맞았지만 고칠 곳은 아직 나오지 않은 상태였습니다. 성능 패널에서 CPU를 4배 느리게 두고 다시 보니 700~900ms짜리 긴 작업이 있었고 그 안은 React 컴포넌트에 붙은 Intersection Observer 콜백이 `setState`를 불러 비싼 리렌더를 일으키는 자리였습니다. 이것을 고쳐 INP를 50% 줄였고 목록에서 상품 상세로 넘어가는 클릭률이 1% 올랐습니다.

React 쪽 도구는 두 층입니다.

- **`<Profiler>`와 React DevTools Profiler.** `onRender`가 넘기는 `actualDuration`(이번 렌더에 실제로 걸린 시간)과 `baseDuration`(메모이제이션 없이 서브트리 전체를 렌더하면 걸릴 추정 시간)을 비교하면 메모이제이션이 효과를 내는지, 그 서브트리가 원래 비싼지를 가를 수 있습니다.
- **React 19.2의 Performance Tracks(2025년 10월).** Chrome 성능 패널 타임라인에 React 전용 트랙이 함께 뜹니다. Scheduler 트랙은 렌더가 어떤 우선순위(Blocking, Transition, Suspense, Idle)로 돌았는지 보여 주고 Components 트랙은 컴포넌트별 렌더 시간과 props가 바뀌지 않았는데 다시 그린 렌더를 보여 줍니다. 네트워크 요청과 자바스크립트 실행과 같은 타임라인에 놓이기 때문에, 예전처럼 성능 패널로 긴 작업을 찾고 나서 React DevTools를 따로 띄워 다시 녹화하는 두 번의 측정이 한 번으로 줄어듭니다. 개발 빌드와 프로파일링 빌드에서만 켜집니다.

프레임워크 안에서도 원인을 한 번 더 나눕니다. 필요한 렌더인데 비싸서 입력을 막는 경우라면 `useTransition`이나 `useDeferredValue`로 그 렌더를 다른 업데이트가 끼어들 수 있는 낮은 우선순위로 돌립니다. 필요 없는 렌더가 반복되는 경우라면 메모이제이션 쪽입니다. 2025년 10월 7일 정식 버전이 나온 React Compiler가 빌드 시점에 자동으로 메모이제이션을 넣어 줍니다. Angular DevTools 프로파일러도 변경 감지 사이클별 막대 그래프와 플레임 그래프를 제공하고 Vue DevTools는 Timeline 탭에서 컴포넌트 렌더와 업데이트 시간을 보여 줍니다.

### 표시 지연이 길면 렌더링 블록을 봅니다

콜백은 빨리 끝났는데 다음 프레임이 늦게 그려지면 성능 패널의 보라색(스타일 계산, 레이아웃)과 초록색(페인트, 합성) 블록이 그 시간을 차지합니다. 이번에 찾은 기업 사례 중에는 표시 지연을 주원인으로 짚은 글이 없어서 이 갈래는 도구의 위치만 적어 둡니다.

## 5. 결과가 늦게 뜨면 서버와 API를 같은 추적으로 이어서 봅니다

2장의 두 번째 갈래, 즉 화면은 반응했는데 결과가 늦는 경우는 브라우저 밖까지 내려가야 합니다. 여기서도 한 번에 한 층씩 내려갑니다.

### 브라우저가 이미 재 둔 네트워크 구간부터 나눕니다

`PerformanceResourceTiming`은 요청 하나를 구간으로 쪼갤 수 있는 시각을 이미 기록해 둡니다. MDN이 제시하는 계산은 이렇습니다.

| 구간 | 계산 |
|---|---|
| DNS 조회 | `domainLookupEnd - domainLookupStart` |
| TCP 연결 | `connectEnd - connectStart` |
| TLS 협상 | `requestStart - secureConnectionStart` |
| 요청을 보내고 첫 바이트를 받기까지 | `responseStart - requestStart` |

마지막 줄은 네트워크 왕복과 서버 내부 처리가 섞인 값입니다. 서버 안을 더 나누려면 서버가 응답 헤더로 알려 줘야 합니다. `Server-Timing: db;dur=53, app;dur=47.2`처럼 단계별 시간을 실어 보내면 브라우저의 `PerformanceServerTiming`과 DevTools 네트워크 탭에서 그대로 보입니다. 다른 출처의 응답이면 `Timing-Allow-Origin` 헤더가 있어야 읽을 수 있습니다.

### 클릭과 백엔드 요청은 traceparent 추적 ID로 잇습니다

"이 클릭이 어느 백엔드 요청과 같은 일인지"를 알려면 시간 값만으로는 부족하고 같은 추적 ID가 필요합니다. 표준은 W3C Trace Context의 `traceparent` 헤더이고 모양은 `00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01`처럼 버전, 추적 ID, 부모 스팬 ID, 플래그입니다. OpenTelemetry 브라우저 SDK 문서는 서버가 HTML 템플릿에 `traceparent`를 동적으로 심어 주고 브라우저 쪽 문서 로드, 사용자 상호작용, fetch 자동 계측이 만든 스팬을 같은 추적에 붙이는 방법을 안내합니다. 이렇게 이어 두면 백엔드 쪽은 [p95가 튀었을 때 보는 순서](/blog/theory/reading-performance-metrics)를 그대로 따라 내려가면 됩니다.

Slack이 이 연결을 직접 만든 회사입니다. Slack의 클라이언트 추적 글은 "앱이 느리다"는 고객 문의로 시작합니다. 로그를 보면 안드로이드에서 채널을 바꾸는 데 1.5초가 넘게 걸리는데 무엇이 느린지는 로그에서 더 나오지 않았다고 적었습니다. 이런 막다른 길이 클라이언트 추적을 만든 계기였습니다. 해법은 서버 추적에 쓰던 추적 ID를 HTTP 요청 헤더로 실어 보내 클라이언트 로그와 서버 로그를 같은 추적 안에 두는 것이었습니다. 추적을 붙인 뒤에는 API 호출 하나가 큐 대기, HTTP 요청, 파싱으로 나뉘어 보였습니다.

같은 글의 다른 사례는 원인이 클라이언트 안에 있었습니다. 일부 사용자의 채널 목록 갱신이 예상보다 훨씬 오래 걸렸습니다. 추적을 보니 다이렉트 메시지 47개를 갱신하면서 DB에서 600개 가까이를 읽고 있었습니다. 목록에는 몇 개만 보여 주면서 사용자가 나눈 모든 대화를 불러오던 코드였습니다. 이것을 고친 뒤 해당 p95 사례의 시간이 40% 가까이 줄었습니다. 클라이언트와 서버가 한 추적 안에 있으면 원인이 어느 쪽에 있든 같은 화면에서 찾을 수 있습니다.

### 병렬 요청에서는 페이지 전체를 붙잡는 요청을 찾습니다

결과가 늦는 화면에는 요청이 여러 개 걸려 있는 경우가 많습니다. LinkedIn은 2016년 홈페이지의 워터폴 수백만 건을 Resource Timing과 Navigation Timing으로 모아 분석한 글(BOSS, 2017)에서 이렇게 적었습니다. "Finding a bottleneck is not as easy as simply finding the longest request in a waterfall since if there are other calls in parallel, just fixing the longest request can't reduce the page load time." 병렬로 도는 요청이 있으면 가장 긴 요청을 고쳐도 페이지가 빨라지지 않습니다. 찾아야 할 것은 다른 요청을 막고 있어서 그것이 늦으면 페이지 전체가 늦어지는 요청입니다.

LinkedIn이 내놓은 홈페이지 지연의 기여도는 서버 응답 27.32%, 네트워크 활동이 없는 빈 시간 22.16%, CDN 객체 20.16%, AJAX 호출 9.21%, 광고 호출 7.57% 순이었습니다. 실제로 손댄 곳은 광고였습니다. 광고가 뒤따르는 요청을 막지 않도록 비동기로 바꾸자 홈페이지 로드 시간이 21% 빨라졌습니다.

Google SRE 책은 같은 현상을 서버 쪽에서 설명합니다. 초당 1,000건에 평균 100ms인 서비스에서도 1%의 요청은 쉽게 5초가 걸릴 수 있다고 적었습니다. 또 한 백엔드의 99번째 백분위수가 그 앞 프런트엔드에서는 중앙값이 되기 쉽다고 했습니다. 화면 하나가 기다리는 요청이 많을수록 사용자는 백엔드의 꼬리 지연을 더 자주 만납니다.

## 6. 처음 짚은 곳과 실제 원인은 한 단계씩 어긋났습니다

여기까지의 사례를 "처음 가리킨 곳"과 "실제로 고친 곳"으로 다시 놓으면 공통점이 보입니다.

| 회사 | 처음 가리킨 곳 | 실제로 고친 곳 | 결과 |
|---|---|---|---|
| Trendyol | Lighthouse가 지목한 `search-result-v2` 스크립트 | 그 안 React 컴포넌트의 Intersection Observer 콜백과 `setState` | INP 50% 감소 |
| Taboola | 어느 스크립트인지 가를 수 없던 서드파티 블로킹 | LoAF로 찾은 `RELEASE.js` | 블로킹 691ms 중 485ms 감소 |
| LinkedIn | 워터폴에서 가장 긴 요청 | 뒤 요청을 막던 광고 호출 | 홈페이지 로드 21% 단축 |
| Notion | 브라우저 SQLite 캐시가 API 왕복보다 늘 빠르다는 가정 | 느린 기기를 위해 SQLite 조회와 API 호출을 경주시키는 구조 | 페이지 이동 20% 단축, 인도 33% |
| Slack | 로그로는 원인이 안 보이던 느린 갱신 | 클라이언트가 47개를 갱신하려고 600개 가까이 읽던 코드 | 해당 p95 40% 가까이 감소 |

Notion은 2024년 브라우저에 WASM SQLite 캐시를 붙여 페이지 이동을 전체 20% 줄였습니다. 서버에서 먼 지역일수록 효과가 커서 호주 28%, 중국 31%, 인도 33%가 빨라졌습니다. 그런데 처음 페이지를 열 때는 WASM 라이브러리를 받는 동안 다른 작업이 막혀 오히려 느려졌습니다. 그래서 라이브러리를 비동기로 받게 바꿨습니다. 느린 기기를 위해서는 SQLite 조회와 API 호출을 동시에 보내 먼저 끝난 쪽을 쓰게 했습니다.

Trendyol과 Taboola는 메인 스레드라는 구간을, LinkedIn은 요청 쪽이라는 구간을 처음부터 맞혔습니다. 어긋난 곳은 그 구간 안에서 한 단계 더 내려가야 하는 자리였습니다. Notion과 Slack은 가정 하나(캐시가 늘 빠르다, 로그를 보면 알 수 있다)를 실측과 추적으로 바꾸고 나서야 고칠 곳이 보였습니다. 하향식 분석에서 조심할 자리는 맞게 짚은 구간 안에서 한 단계 일찍 멈추는 순간입니다. 드릴다운의 4번 "문제가 안 풀렸으면 2번으로"가 이 자리를 위해 있습니다.

## 7. 늘 켜 두는 것은 체감 지표 두 개와 서버 응답 분포입니다

질문으로 돌아가면 피곤함은 "무엇을 늘 재고 무엇을 지목될 때만 여는지"를 나누는 데서 줄어듭니다.

| 언제 | 무엇을 | 도구 |
|---|---|---|
| 늘 | 사용자 체감 지표 두 개: 상호작용 반응(INP와 세 구간), 클릭부터 결과가 그려질 때까지의 시간 | `web-vitals` attribution, CrUX, 직접 심은 사용자 타이밍 |
| 늘 | 서버 응답 시간 분포(p95, p99) | 서버 메트릭 대시보드 |
| 느린 상호작용이 지목되면 | 그 상호작용 하나의 세 구간 | DevTools 성능 패널 Interactions 트랙 |
| 입력 지연이 클 때 | 그 순간 메인 스레드를 잡은 스크립트 | LoAF |
| 처리 시간이 프레임워크 코드를 가리킬 때 | 컴포넌트 렌더 | React Performance Tracks, React Profiler, Angular·Vue DevTools |
| 결과가 늦을 때 | 요청 구간과 서버 내부 | Resource Timing, Server-Timing, traceparent 추적 |

늘 켜 두는 것은 위 두 줄(체감 지표 두 개와 서버 응답 분포)입니다. 나머지는 위 단계가 가리킬 때만 엽니다. 처음 질문에 나온 네 군데는 모두 이 표 어딘가에 들어 있습니다. 순서만 지표가 정하게 두면 됩니다.

## 이 글에서 확인하지 못한 것

- Server-Timing 헤더나 W3C `traceparent`를 실제로 쓴다고 이름을 밝힌 기업 블로그 사례는 찾지 못했습니다. Slack은 추적 ID를 HTTP 헤더로 보낸다고만 적었습니다. Pinterest는 서버가 HTML 조각을 내보내는 시각을 직접 계측했지만 Server-Timing이라는 이름은 쓰지 않았습니다.
- DevTools의 CPU 4배 감속이 실제 저사양 기기와 얼마나 다른지에 대한 공식 수치는 찾지 못했습니다. 그래서 랩 결과는 필드에서 고른 상호작용을 재현하는 데까지만 썼습니다.
- 국내 기술 블로그 사례는 원문으로 확인한 것이 토스 한 건이라 이 글에는 넣지 않았습니다.

## 참고

- [Brendan Gregg - Performance Analysis Methodology](https://www.brendangregg.com/methodology.html)
- [web.dev - Interaction to Next Paint (INP)](https://web.dev/articles/inp)
- [web.dev - Optimize Interaction to Next Paint](https://web.dev/articles/optimize-inp)
- [web.dev - INP becomes a Core Web Vital on March 12](https://web.dev/blog/inp-cwv-march-12)
- [web.dev - Measure performance with the RAIL model](https://web.dev/articles/rail)
- [web.dev - Find slow interactions in the field](https://web.dev/articles/find-slow-interactions-in-the-field)
- [web.dev - Diagnose slow interactions in the lab](https://web.dev/articles/diagnose-slow-interactions-in-the-lab)
- [web.dev - Why lab and field data can be different](https://web.dev/articles/lab-and-field-data-differences)
- [Chrome for Developers - Long Animation Frames API](https://developer.chrome.com/docs/web-platform/long-animation-frames)
- [Chrome for Developers - Performance panel reference](https://developer.chrome.com/docs/devtools/performance/reference)
- [MDN - PerformanceResourceTiming](https://developer.mozilla.org/en-US/docs/Web/API/PerformanceResourceTiming)
- [MDN - Server-Timing](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Server-Timing)
- [W3C - Trace Context](https://www.w3.org/TR/trace-context/)
- [OpenTelemetry - Getting Started (Browser)](https://opentelemetry.io/docs/languages/js/getting-started/browser/)
- [react.dev - Profiler](https://react.dev/reference/react/Profiler)
- [react.dev - React Performance Tracks](https://react.dev/reference/dev-tools/react-performance-tracks)
- [react.dev - useTransition](https://react.dev/reference/react/useTransition)
- [react.dev - React Compiler v1.0](https://react.dev/blog/2025/10/07/react-compiler-1)
- [Angular - DevTools Profiler](https://angular.dev/tools/devtools/profiler)
- [Vue DevTools - Features](https://devtools.vuejs.org/getting-started/features)
- [Slack Engineering - Client Tracing](https://slack.engineering/client-tracing-understanding-mobile-and-desktop-application-performance-at-scale/)
- [LinkedIn Engineering - BOSS: Automatically Identifying Performance Bottlenecks through Big Data](https://www.linkedin.com/blog/engineering/archive/boss-automatically-identifying-performance-bottlenecks-through-)
- [Notion - How we sped up Notion in the browser with WASM SQLite](https://www.notion.com/blog/how-we-sped-up-notion-in-the-browser-with-wasm-sqlite)
- [Pinterest Engineering - Web Performance Regression Detection (Part 2)](https://medium.com/pinterest-engineering/web-performance-regression-detection-part-2-of-3-9e0b9d35a11f)
- [web.dev - Trendyol INP case study](https://web.dev/case-studies/trendyol-inp)
- [web.dev - Taboola INP case study](https://web.dev/case-studies/taboola-inp)
- [web.dev - QuintoAndar INP case study](https://web.dev/case-studies/quintoandar-inp)
- [web.dev - redBus INP case study](https://web.dev/case-studies/redbus-inp)
- [Google SRE Book - Monitoring Distributed Systems](https://sre.google/sre-book/monitoring-distributed-systems/)

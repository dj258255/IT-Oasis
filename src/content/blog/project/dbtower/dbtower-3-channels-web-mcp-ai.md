---
title: '분석 코어는 하나만 두고 웹 콘솔, MCP, API 키 없는 AI 분석으로 채널만 갈아끼웠습니다'
titleEn: 'Keeping One Analysis Core and Swapping Channels, from a Web Console to MCP to AI Analysis Without an API Key'
description: '이기종 DBMS 운영 관리 플랫폼 DBTower 3편. 같은 분석 코어를 사람에게는 웹 콘솔로, AI 에이전트에게는 MCP 도구로, 온콜에게는 웹훅 push로 노출하는 채널 설계 이야기입니다. 활동 그래프를 드래그해서 시점 비교 구간을 고르는 UI, JSON-RPC 2.0을 SDK 없이 직접 구현하며 배운 MCP 프로토콜의 규약들, 그리고 API 키가 없으면 claude CLI를 headless로 불러 쓰는 AI 백엔드 자동 선택까지, hidden 속성이 display:flex에 지는 것 같은 사소하지만 실전적인 함정들과 함께 기록합니다.'
descriptionEn: 'Part 3 of DBTower, a heterogeneous DBMS operations platform. It exposes one analysis core through three channels: a web console for humans, MCP tools for AI agents, and webhook push for on-call. Drag-to-select comparison windows on an activity graph, MCP protocol lessons from implementing JSON-RPC 2.0 without an SDK, and an AI backend that falls back to headless claude CLI when no API key is set are all recorded, along with small but practical pitfalls like the hidden attribute losing to display:flex.'
date: 2026-05-04
tags:
  - Java
  - Spring Boot
  - DBRE
  - MCP
  - Claude
category: personal/DBTower
coverImage: /uploads/project/dbtower/cover.svg
draft: false
series: "DBTower"
seriesOrder: 3
---

## 0. 들어가며, 기능은 다 있는데 쓸 사람이 없다

[2편](/blog/project/dbtower/dbtower-2-abstraction-and-regression)까지 만든 것을 냉정하게 보면, 시점 비교도 회귀 감지도 전부 REST API였습니다. curl을 칠 줄 아는 나만 쓸 수 있는 플랫폼이었던 것입니다. 레퍼런스 사례 발표를 다시 보니 기능 목록보다 **화면**이 먼저 눈에 들어왔습니다. CPU 그래프를 드래그해서 구간을 고르면 그 구간의 상위 쿼리가 나오고 클릭하면 분석이 나오는 흐름. 기능이 같아도 채널이 없으면 운영 도구가 아닙니다.

그래서 이번 편은 채널 이야기입니다. 같은 코어를 세 방향으로 노출했습니다.

- **사람**에게는 웹 콘솔입니다 (그래프 드래그 → 비교 표 → 클릭 분석)
- **AI 에이전트**는 MCP 서버로 붙습니다 (필요할 때 도구로 당겨쓰는 pull)
- **온콜**은 웹훅 알림을 받습니다 (2편에서 만든, 플랫폼이 사람에게 미는 push)

## 1. 프레임워크 없이, 의존성 0으로 만든 웹 콘솔

프론트는 정적 파일 세 개(HTML/CSS/JS)로 만들었습니다. React를 몰라서가 아니라 이 프로젝트의 본질이 백엔드이기 때문입니다. 빌드 파이프라인 없이 `java -jar` 하나로 API부터 화면까지 다 뜨는 게 운영 도구로는 오히려 장점입니다.

핵심 인터랙션은 레퍼런스에서 배운 그대로입니다. 활동 그래프(QPS 시계열)를 **드래그하면 그 구간이 시점 비교의 조회 구간이 되고** 한 번 더 드래그하면 베이스라인 구간이 됩니다. 마우스 이벤트 세 개(mousedown/mousemove/mouseup)로 SVG 위에 반투명 사각형을 그리는 90줄짜리 코드인데, "장애 시각을 숫자로 입력하세요"와 "그래프에서 튄 부분을 드래그하세요"는 완전히 다른 도구입니다.

비교 표에는 쿼리마다 증감을 붙였습니다. `12.3 (▲ 460%)` 같은 셀에, base 구간에 없던 쿼리는 NEW 뱃지. 실측 부하(점조회 베이스라인 → 급증 + 신규 LIKE 풀스캔)에서 호출량 +461%, 읽은 행수 +852%, 신규 쿼리 1건이 표에 그대로 잡혔습니다.

### 사소하지만 실전적인 함정 둘

**hidden이 display:flex에 진다.** 요약 스트립을 `el.hidden = true`로 숨겼는데 화면에 계속 보였습니다. HTML 표준에서 `hidden` 속성은 UA 스타일시트의 `display: none`으로 구현되는데, 제가 CSS에 쓴 `.summary-strip { display: flex }`가 **명시도에서 이겨버립니다**. `.summary-strip[hidden] { display: none }`을 추가해서 해결했습니다. 표준 문서에도 있는 동작인데, 직접 밟으니까 잊히지 않았습니다.

**innerHTML에 넣는 모든 값은 이스케이프.** 비교 표의 쿼리 텍스트는 DB에서 온 값이고 DB에는 무엇이든 들어올 수 있습니다. `esc()` 함수 하나 만들어서 innerHTML로 가는 모든 동적 값에 예외 없이 적용했습니다. 관리 도구는 내부용이라고 방심하기 쉬운데, 내부 도구야말로 세션 권한이 세서 XSS가 치명적입니다.

## 2. AI 에이전트의 채널 MCP, SDK 없이

웹 콘솔이 사람의 채널이라면, AI 에이전트에게는 MCP(Model Context Protocol)가 채널입니다. Claude 같은 에이전트가 DBTower의 시점 비교와 EXPLAIN, 헬스체크를 **도구로 직접 호출**하게 됩니다. "어제 오후에 뭐가 느려졌지?"라고 물으면 에이전트가 compare를 불러 표를 읽고 답하는 그림입니다.

SDK를 쓰지 않고 JSON-RPC 2.0부터 직접 구현했습니다. 프로토콜을 알아야 디버깅이 되기 때문입니다. 구현하면서 배운 규약들이 이 프로토콜의 설계 의도를 보여줍니다.

- **id가 없는 메시지는 알림(notification)이고 알림에는 절대 응답하지 않는다.** `notifications/initialized`에 무심코 200과 본문을 돌려주면 스펙 위반입니다. HTTP 전송에서는 202 Accepted + 빈 본문.
- **도구 실행이 실패해도 JSON-RPC error로 던지지 않고 `result.isError: true`로 돌려준다.** 처음엔 이게 이상했는데, 이유가 명확합니다. 프로토콜 에러는 클라이언트 코드가 처리하지만 도구 실패는 **LLM이 읽고 스스로 정정**해야 하기 때문입니다. "없는 인스턴스 id입니다"를 에이전트가 읽으면 list_instances를 먼저 부르는 식입니다.
- **stdio 전송은 "한 줄 = 메시지 하나".** 로그를 stdout에 찍는 순간 프로토콜이 깨집니다. 로그는 전부 stderr로.

전송(stdio/HTTP)과 프로토콜 처리를 분리해둔 덕에, 두 전송이 코어 하나를 공유합니다. 그리고 웹 콘솔의 MCP 카드에는 등록 명령 복사 버튼과 함께 도구 목록을 그려두었는데, 이 목록은 **화면이 직접 POST /mcp로 tools/list를 호출한 실시간 응답**입니다. 하드코딩이 아닙니다. 목록이 보인다는 것 자체가 엔드포인트가 살아 있다는 증거가 되도록 만들었습니다.

```bash
claude mcp add --transport http dbtower http://localhost:8080/mcp
```

![MCP 연동 카드. 도구 목록은 tools/list 실시간 응답이고, 목록이 보인다는 것 자체가 살아 있다는 증거](/uploads/project/dbtower/mcp.png)

## 3. AI 1차 분석, API 키가 없으면 CLI를 부른다

2편에서 AI 분석은 "API 키 없으면 조용히 비활성화"였습니다. 그런데 로컬에서 개발하는 동안 매번 키를 발급받는 것도 애매하고 이미 Claude 구독으로 claude CLI를 쓰고 있었습니다. 그래서 백엔드를 자동 선택하게 바꿨습니다.

```
ANTHROPIC_API_KEY 있음   → Anthropic Java SDK (운영 구성)
없음 + claude CLI 설치됨 → claude -p headless 호출 (로컬 개발)
둘 다 없음               → 비활성화 (규칙 기반 분석만)
```

CLI 호출에서 배운 것 두 가지가 핵심입니다.

**프롬프트는 argv 대신 stdin으로.** 분석 대상이 SQL과 실행계획인데, 여기엔 따옴표든 개행이든 뭐든 들어옵니다. 인자로 넘기면 어딘가에서 파싱이 깨집니다. stdin으로 흘리면 내용이 무엇이든 무관합니다.

**`--setting-sources ""`로 사용자 설정을 배제.** 처음 돌렸을 때 분석 결과에 제 로컬 Claude 설정의 출력 스타일 블록이 섞여 나왔습니다. 플랫폼이 호출하는 CLI가 호출자 개인의 설정을 물려받으면, 같은 코드가 환경마다 다른 형식을 뱉는 겁니다. 설정 소스를 비워서 어떤 로컬에서도 순수한 분석 텍스트가 나오게 고정했습니다. 판단 기준 문서는 `--append-system-prompt`로 주입하니 API 백엔드와 프롬프트가 동일합니다.

실측에서는 LIKE '%...%' 풀스캔 쿼리(8,118행)의 access_type=ALL 원인을 앞 와일드카드로 특정하고 문서에 없는 수치에는 "주어진 계획만으로 판단할 수 없다"고 답했습니다. "근거 없으면 모른다고 말하라"는 프롬프트 규칙이 지켜지는 것까지 확인하고서야 이 기능을 믿기로 했습니다.

![AI 1차 분석. 판단 기준 문서를 시스템 프롬프트로 쓰는 일관 판정](/uploads/project/dbtower/ai-analysis.png)

## 4. 채널 셋을 놓고 보니

| 채널 | 대상 | 방향 | 쓰는 순간 |
|---|---|---|---|
| 웹 콘솔 | 사람 | pull | "지금 뭐가 느리지?" 하고 직접 볼 때 |
| MCP | AI 에이전트 | pull | 에이전트가 분석 도구로 당겨쓸 때 |
| 웹훅 | 온콜 | push | 플랫폼이 회귀를 먼저 발견했을 때 |

셋 다 시점 비교와 EXPLAIN, 규칙 분석이라는 같은 코어를 부릅니다. 채널을 추가하는 동안 코어는 한 줄도 바뀌지 않았습니다. 기종 차이를 `DbmsOperator` 뒤로 숨긴 것과 정확히 같은 구도가 채널 쪽에도 성립한 것입니다. 안쪽 경계는 기종을 숨기고 바깥 경계는 소비자를 숨긴다.

다음 편은 이 주장의 검증입니다. "새 기종 = 구현체 1개"라고 계속 말해 왔는데, SQL도 JDBC도 없는 MongoDB와 상용 DB인 Oracle을 실제로 추가하면 플랫폼 코드가 정말 몇 줄 바뀌는지 세어봤습니다. 코드와 실측 기록은 [GitHub](https://github.com/dj258255/dbtower)에 있습니다.

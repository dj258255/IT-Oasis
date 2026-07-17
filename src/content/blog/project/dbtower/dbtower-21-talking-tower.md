---
title: '관제탑과 대화하기 — 알림이 카드가 되고, 이모지가 진단을 부르고, 로그인 창이 토큰을 만든다'
titleEn: 'Talking to the Control Tower — Alerts Become Cards, an Emoji Summons a Diagnosis, and a Login Page Mints Your Token'
description: '이기종 DBMS 운영 관리 플랫폼 DBTower 21편. 알림에서 진단까지의 왕복을 완성했습니다. 첫째, 회귀·이상·운영 경보가 밋밋한 텍스트에서 구조화된 Discord embed 카드가 됐습니다 — 심각도 색, 담당 팀, AI 1차 분석, 클릭하면 질문이 미리 채워진 콘솔로 열리는 진단 딥링크까지. 둘째, 알림 메시지에 돋보기 이모지를 달면 봇이 그 인스턴스를 AI로 진단해 답글을 붙입니다. 여기의 함정 둘 — 🔍와 🔎는 다른 유니코드고, 웹훅이 쓴 메시지의 embed를 봇이 읽으려면 특권 인텐트가 필요합니다. 후자는 발사 시점에 message_id를 인스턴스에 매핑해두는 것으로 권한 0개로 풀었습니다. 대상이 하필 죽어 있던 인스턴스라 진단 도구가 전부 빈손이었는데, AI 답글이 수치를 지어내는 대신 "근본원인을 확정하지 못했습니다"라고 답한 것이 이번 편에서 제일 마음에 드는 실측입니다. 셋째, MCP 클라이언트의 정적 토큰을 OAuth 2.1 브라우저 로그인으로 바꿨습니다 — 미인증 /mcp가 401 대신 302 로그인 페이지로 덮이던 함정(전용 필터 체인, 그리고 sendError가 아니라 setStatus), 커밋 리뷰가 잡아준 redirect_uri userinfo 우회(http://localhost:8080@evil.com)까지. 덤으로 Vault 동적 자격증명 — 모니터링 계정의 유출 창이 "발각부터 수동 회전까지"에서 TTL 2분으로 줄었습니다.'
descriptionEn: 'Part 21 of DBTower — closing the loop from alert to diagnosis. Detection alerts become structured Discord embed cards with severity colors, owning team, AI first-pass analysis, and a deep link that opens the console with the question pre-filled. React to an alert with a magnifier emoji and a Gateway bot diagnoses that instance and replies in-thread — past two traps: 🔍 and 🔎 are different codepoints, and reading webhook embeds requires a privileged intent, which we avoided entirely by mapping message_id to instance at send time. My favorite measurement: the target happened to be down, every tool came back empty, and the AI reply said "I could not determine the root cause" instead of inventing numbers. Third, MCP static tokens replaced by an OAuth 2.1 browser login — including the trap where unauthenticated /mcp got a 302 login page instead of 401 (dedicated filter chain, setStatus not sendError) and a review-caught redirect_uri userinfo bypass. Plus Vault dynamic credentials: the monitoring account leak window shrank from discovery-to-manual-rotation down to a 2-minute TTL.'
date: 2026-07-24
tags:
  - Java
  - Spring Boot
  - Discord
  - OAuth
  - MCP
  - DBRE
category: personal/DBTower
coverImage: /uploads/project/dbtower/cover.svg
draft: false
series: "DBTower"
seriesOrder: 21
---

## 0. 들어가며, 알림은 목소리지 대화가 아니었다

지금까지 관제탑은 말을 걸 줄만 알았습니다. 회귀·이상·운영 경보가 웹훅으로 날아오긴 하는데, 받은 사람이 할 수 있는 건 콘솔을 따로 열어 처음부터 찾아 들어가는 것뿐이었죠. 레퍼런스로 삼은 사내 플랫폼 사례에서 제일 부러웠던 게 이 지점입니다 — 알럿 스레드에 이모지를 달면 AI 분석이 댓글로 붙는, 알림과 진단이 같은 자리에서 완결되는 루프요. 이번 편은 그 왕복을 만든 이야기입니다. 그리고 후반부는 그 통로들의 자물쇠 이야기고요.

## 1. 텍스트 알림을 카드로

출발점은 가독성 불만이었습니다. 회귀 경보가 개행 없는 텍스트 덩어리로 날아와서, 새벽에 받으면 어디부터 읽어야 할지 모르겠는 상태였거든요. 이미 "DB팀 문의" 기능이 쓰던 embed 카드 형식이 있어서, 감지 알림 세 종류(회귀·이상·운영)를 같은 결로 통일했습니다. 인스턴스와 기종, 맥락(회귀는 비교 구간, 이상은 베이스라인), 담당 팀, 감지 내용 불릿, AI 1차 분석이 각각 필드로 갈라지고, 심각도는 색으로 — 운영 경보 빨강, 회귀 앰버, 이상 감지 보라. 콘솔의 심각도 색과 같게 맞췄습니다.

![회귀·이상 감지 알림 embed 카드 — 구간·감지 내용·AI 1차 분석·진단 딥링크가 필드로 갈라진다](/uploads/project/dbtower/alert-embed-reaction.png)

디테일 함정 하나. "콘솔에서 진단하기" 딥링크를 마크다운 마스킹 링크(`[라벨](URL)`)로 넣었는데 Discord가 원문 URL을 그대로 보여줬습니다. 알고 보니 embed 필드의 마스킹 링크는 URL이 길면 렌더가 깨지는 조건이 있어서, 딥링크에 미리 채워 보내는 질문을 짧게 줄여야 했습니다. 링크를 클릭하면 콘솔이 해당 인스턴스로, 진단 질문이 미리 채워진 채 열립니다 — "방금 온 회귀 알림의 원인을 분석해줘"까지 클릭 한 번입니다.

## 2. 이모지가 진단을 부른다 — 특권 없이

핵심은 반대 방향입니다. 채팅에서 콘솔로 건너오는 게 아니라, 채팅 안에서 끝나는 것. Discord Gateway에 웹소켓으로 상시 연결하는 봇을 만들었습니다 — 외부 라이브러리 없이 `java.net.http.WebSocket`으로 IDENTIFY·하트비트·재접속을 직접 구현했고(프론트를 의존성 0으로 유지해온 것과 같은 결), 알림 메시지에 돋보기 이모지가 달리면 그 알림의 대상 인스턴스를 자연어 진단에 태워 결과를 답글로 붙입니다.

함정 첫 번째는 사소한데 치명적이었습니다. 트리거 이모지를 🔍로 등록해뒀는데 제가 채팅에서 단 건 🔎였습니다 — 왼쪽 돋보기(U+1F50D)와 오른쪽 돋보기(U+1F50E)는 **다른 유니코드**입니다. 이벤트는 오는데 판정만 조용히 실패하는, 로그 없이는 못 잡는 종류의 버그죠. 트리거를 집합으로 바꿔 둘 다 받게 했습니다.

두 번째 함정이 이 절의 본체입니다. 반응 이벤트(MESSAGE_REACTION_ADD)에는 message_id만 옵니다. "어느 인스턴스의 알림인지"를 알려면 그 메시지의 embed를 읽어야 하는데 — 웹훅이 쓴 메시지의 본문·embed를 봇이 REST로 읽는 데는 **Message Content 특권 인텐트**가 필요합니다. 승인 심사가 붙는 권한이죠. 그런데 생각해보면 이 정보는 애초에 우리가 만든 겁니다. 알림을 **보내는 시점에** 웹훅을 `?wait=true`로 호출해 생성된 message_id를 돌려받고, message_id → 인스턴스 매핑을 유한 캐시에 적어두면 — 반응이 왔을 때 조회 한 번으로 끝납니다. 특권 인텐트 0개. 매핑에서 밀려난 오래된 알림만 embed 제목 파싱으로 폴백합니다.

e2e를 돌렸더니 예상 밖의 수확이 있었습니다. 하필 반응을 단 알림의 대상이 데모용으로 꺼둔 인스턴스라, 진단 도구 다섯 개가 전부 빈 결과와 리다이렉트만 물고 왔거든요. 그때 봇이 단 답글이 이랬습니다.

> [mssql-pitr] 솔직히 이번엔 근본원인을 확정하지 못했습니다. 진단에 필요한 도구가 모두 데이터를 주지 못했기 때문입니다.
> (…시도한 근거 수집 5단계와 각각의 실패 사유…)
> 따라서 '알림이 온 이유'가 실제 DB 부하 때문인지, 수집 중단 자체를 알린 것인지조차 현재 데이터로는 구분할 수 없습니다. 수치를 지어내지 않겠습니다.

이 시리즈 내내 코드에 강제해온 원칙 — 값을 지어내지 않는다, 모르면 모른다고 말한다 — 이 판정 기준 문서를 타고 런타임 AI 응답까지 관통한 겁니다. 화려한 성공 케이스보다 이 답글이 더 마음에 듭니다.

정상 케이스는 이렇게 옵니다. 회귀 알림에 돋보기를 달았더니, 부하는 오히려 줄었는데 레이턴시만 오른 걸 compare로 잡고, 자원이 평온한 걸 metrics로 확인하고, "실제 장애가 아니라 극저부하 상태의 지표 튐"이라고 결론까지 근거 세 개와 함께 답글로 붙습니다.

![알림에 돋보기 반응을 달면 봇이 그 인스턴스를 진단해 답글을 단다 — 근거 3개와 결론](/uploads/project/dbtower/bot-diagnosis-reply.png)

함정 세 번째는 운영해보고 나서야 나왔습니다. 진단이 도는 동안 Gateway 연결이 자꾸 끊겨 재접속을 반복했는데(code=1000), 원인은 진단과 하트비트가 같은 단일 스레드를 쓰고 있던 것이었습니다 — "워커로 넘긴다"는 주석을 달아놓고 정작 같은 풀에 넣었으니, 분 단위 진단이 스레드를 점유하면 하트비트가 굶고, Discord는 응답 없는 연결을 정리해버립니다. 진단 전용 워커로 분리하니 5스텝 진단 동안 재접속 0회. 덤으로 재접속마다 취소 없이 누적되던 하트비트 태스크도 잡았고, AI 답글도 알림과 같은 embed 카드로 통일했습니다 — 메시지 본문 한도(2000자)보다 embed 본문(4096자)이 긴 진단 답변에 알맞기도 합니다.

물론 문은 좁게 열었습니다. 채널·유저 화이트리스트는 기본 거부고, 봇 토큰이 없으면 Gateway 연결 자체를 하지 않고, 봇 자신의 반응은 무시합니다(반응 판정은 순수 함수로 분리해 단위로 고정). 슬래시 커맨드(/dbtower) 경로도 함께 있는데, 이쪽은 Ed25519 요청 서명을 Java 표준 EdDSA로 검증하고 — 진단이 3초 응답 제한보다 느리니 DEFERRED로 받아두고 팔로업으로 결과를 채웁니다.

## 3. 로그인 창이 토큰을 만든다 — MCP OAuth 2.1

MCP 채널의 인증은 지금까지 정적 Bearer 토큰이었습니다. 관리자가 토큰을 만들어 설정 파일에 손으로 붙여넣는 방식 — 돌아가지만, 유출되면 수동 폐기 전까지 유효하고 권한도 발급 시점에 고정됩니다. MCP 생태계의 표준 답은 OAuth 2.1입니다. 클라이언트가 서버에 붙으면 브라우저에 로그인 창이 뜨고, 로그인하면 토큰이 자동 발급되는 흐름이요. DBTower엔 이미 로그인·유저·세션이 있으니 그 위에 인가 서버를 얹었습니다 — 메타데이터 discovery(RFC 9728/8414), 동적 클라이언트 등록(RFC 7591), PKCE(S256 전용), refresh 회전까지.

![MCP 클라이언트가 authorize를 열면 뜨는 DBTower 로그인 창 — 로그인하면 토큰이 자동 발급된다](/uploads/project/dbtower/oauth-login-prompt.png)

함정은 discovery의 첫 관문에서 나왔습니다. 미인증 /mcp는 401과 WWW-Authenticate 헤더를 줘야 클라이언트가 "아, OAuth구나"를 알아채는데, 우리 서버는 **302 로그인 페이지**를 주고 있었습니다. 두 겹이었어요. 폼 로그인 체인이 /mcp까지 관할하고 있던 게 하나 — 전용 stateless 필터 체인으로 분리했습니다. 그런데도 302가 남았습니다. 엔트리포인트에서 쓴 `sendError(401)`가 서블릿 컨테이너의 에러 디스패치를 유발해 요청이 필터를 **다시 통과**했고, 거기서 또 로그인 리다이렉트로 덮인 겁니다. `setStatus(401)`로 바꾸니 끝났습니다. 프레임워크의 친절(에러 페이지 처리)이 프로토콜의 정확성을 깨는, 전형적인 케이스였습니다.

더 무서운 건 커밋 자동 리뷰가 잡아준 쪽입니다. redirect_uri 검증을 문자열 prefix로 하고 있었는데, `http://localhost:8080@evil.com/`이 통과합니다 — URL에서 @ 앞은 userinfo라서, 이 주소의 실제 호스트는 evil.com이고 **인가 코드가 공격자에게 흘러갑니다**. URI를 구조적으로 파싱해 스킴·호스트를 검증하고 userinfo·fragment를 거부하게 바꿨고, 같은 리뷰에서 나온 오픈 리다이렉트(클라이언트 검증 전에 에러 리다이렉트부터 하던 순서)와 동의 화면 부재(로그인된 사용자가 악성 링크만 클릭해도 코드가 발급되는 auth code injection)까지 함께 막았습니다. 전부 단위 테스트로 고정해뒀습니다 — 보안 수정은 재발 방지까지가 수정이니까요.

브라우저 전체 플로우 실측: 동적 등록으로 client_id 발급 → authorize를 열면 로그인 창 → 로그인 → 콜백으로 code 전달 → PKCE verifier와 교환해 토큰 발급 → 그 토큰으로 /mcp 도구 14종 호출 성공. 틀린 verifier, 재사용된 refresh, 미등록 redirect_uri는 각각 명확히 거부됩니다.

## 4. 덤 — 아예 비밀번호가 없는 계정

인증 이야기가 나온 김에 하나 더. 대상 DB 모니터링 계정의 비밀번호는 암호화해 저장하지만, 정적이라는 본질은 그대로입니다 — 유출되면 사람이 알아채고 돌릴 때까지 유효하죠. Vault의 database secrets engine을 붙이면 이 창이 TTL로 줄어듭니다. 인스턴스 username을 `vault:<경로>`로 등록하면 접속 시점에 수명 있는 계정을 발급받고, 리스의 80% 시점에 선제 갱신하고, 만료된 계정은 DB에서 자동 소멸합니다. 실측에서 발급 → pg_stat_activity에 발급 계정 실접속 → 96초 뒤 새 계정 발급과 풀 교체 → 옛 계정 소멸까지 전체 수명주기를 확인했습니다. 여기도 리뷰가 한 건 잡았습니다 — creds 경로가 관리자 입력에서 오니 토큰 ACL이 닿는 임의 시크릿을 읽을 수 있어, database/creds/ 마운트로 봉인했습니다.

18편의 디스크 포화 예측에도 접점이 하나 늘었습니다. Prometheus에 직결돼 있던 지표 소스를 인터페이스로 갈라 CloudWatch(RDS FreeStorageSpace) 구현을 추가했는데 — RDS는 총 용량 메트릭이 없어서 여유 %를 지어내는 대신 null로 두고, 판정이 "있는 축만으로" 동작하게 확장했습니다. 라이브 검증은 에뮬레이터(LocalStack)와 SDK의 프로토콜 세대 차이로 실 AWS가 필요해 정직하게 남겨뒀습니다.

이제 관제탑은 말을 걸고, 대답을 듣고, 문을 잠글 줄 압니다. 남은 큰 조각은 저장소 바깥에 있습니다 — 쌓인 스냅샷을 레이크하우스로 흘려보내고 장기 베이스라인을 되받는, 두 저장소가 손잡는 이야기요.

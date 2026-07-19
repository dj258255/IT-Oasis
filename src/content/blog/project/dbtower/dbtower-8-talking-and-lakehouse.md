---
title: '관제탑과 대화하고 두 저장소를 잇다. 이모지로 진단을 부르고, 창고가 계산한 평소로 오탐을 지운다'
titleEn: 'Talking to the Control Tower and Joining Two Repositories — an Emoji Summons a Diagnosis, and the Warehouse''s "Normal" Kills False Alarms'
description: '이기종 DBMS 운영 관리 플랫폼 DBTower. 앞부분은 알림에서 진단까지의 왕복을 완성합니다. 회귀·이상·운영 경보가 밋밋한 텍스트에서 구조화된 Discord embed 카드가 됩니다(심각도 색·담당 팀·AI 1차 분석·질문이 미리 채워진 진단 딥링크). 알림에 돋보기 이모지를 달면 봇이 그 인스턴스를 AI로 진단해 답글을 붙이죠. 여기엔 함정이 둘 있었습니다. 왼쪽 돋보기(U+1F50D)와 오른쪽 돋보기(U+1F50E)가 서로 다른 유니코드라는 점, 그리고 웹훅이 쓴 메시지의 embed를 봇이 읽으려면 특권 인텐트가 필요하다는 점입니다. 후자는 발사 시점에 message_id를 인스턴스에 매핑해 권한 0개로 풀었습니다. 대상이 하필 죽어 있어 진단 도구가 전부 빈손이었을 때, AI 답글은 수치를 지어내는 대신 "근본원인을 확정하지 못했습니다"라고 답했습니다. 이번 실측에서 가장 인상적인 대목이었습니다. MCP 정적 토큰은 OAuth 2.1 브라우저 로그인으로 바꿨고(302 대신 401 함정, redirect_uri userinfo 우회), Vault 동적 자격증명으로 유출 창을 TTL 2분으로 줄였습니다. 뒷부분은 lakehouse(장기 분석계)와의 루프를 양방향으로 닫습니다. 받아오는 쪽에서는, lakehouse가 수개월 이력으로 계산한 요일×시간대 베이스라인을 V24 테이블로 받아 14일 창에 충분통계량 복원(Σx=n·m, Σx²=(n−1)s²+n·m²)으로 가중 병합했습니다. 실측 스파이크(psql 3,000회)의 판정이 장기 테이블 내용에 따라 뒤집혀 z=7.42로 발화했고, 관측 수가 101(장기 100+단기 1)로 찍히며 병합이 실제로 작동한 자국이 남았습니다. 내보내는 쪽에서는, 대기 이벤트(V25)와 오브젝트 크기(V26)를 주기 영속하는 잡을 신설하고 plan_snapshot 보존에 48시간 하한을 병행했습니다. 자연어 서빙은 Metabot이 Cloud 전용이라 생긴 갭을 MCP 도구 두 개(장기 마트 SELECT·Metabase 카드 생성)로 메웠고, 카드 76이 실제로 생성되어 bar 차트가 143ms에 렌더됐습니다.'
descriptionEn: 'DBTower, a multi-engine DBMS operations platform. The first half closes the loop from alert to diagnosis. Detection alerts become structured Discord embed cards (severity colors, owning team, AI first-pass, a deep link that opens the console with the question pre-filled), and reacting with a magnifier emoji makes a Gateway bot diagnose that instance and reply in-thread. Two traps showed up along the way. The left magnifier (U+1F50D) and the right one (U+1F50E) are different codepoints, and reading webhook embeds requires a privileged intent. The latter was avoided entirely by mapping message_id to instance at send time. When the target happened to be down and every tool came back empty, the AI said "I could not determine the root cause" instead of inventing numbers. That was the most telling moment of the whole run. MCP static tokens became an OAuth 2.1 browser login (the 302-instead-of-401 trap, a redirect_uri userinfo bypass), and Vault dynamic credentials shrank the leak window to a 2-minute TTL. The second half closes the lakehouse loop in both directions. On the receiving side, long-term day-of-week × hour baselines arrive in a V24 table and get weight-merged via sufficient statistics (Σx=n·m, Σx²=(n−1)s²+n·m²); a real spike (3,000 psql executions) flipped based on what the long-term table said, firing z=7.42 with an observation count of 101 (100 long-term + 1 short-term). On the supplying side, new persistence jobs cover wait events (V25) and object sizes (V26), plus a 48-hour retention floor on plan snapshots. Natural-language serving fills the Cloud-only Metabot gap with two MCP tools (long-term mart SELECT, Metabase card creation), and card 76 was actually created, rendering a bar chart in 143ms.'
date: 2026-07-24
tags:
  - Java
  - Spring Boot
  - Discord
  - OAuth
  - MCP
  - Reverse ETL
  - DBRE
category: personal/DBTower
coverImage: /uploads/project/dbtower/bot-diagnosis-reply.png
draft: false
series: "DBTower"
seriesOrder: 8
---

## 0. 들어가며, 알림은 한 방향의 목소리였다

관제탑은 말을 걸 줄만 알았습니다. 회귀·이상·운영 경보가 웹훅으로 날아와도, 받은 사람은 콘솔을 따로 열어 처음부터 찾아 들어가야 했죠. 레퍼런스 사내 플랫폼에서 제일 부러웠던 건 알럿 스레드에 이모지를 달면 AI 분석이 댓글로 붙는, 알림과 진단이 한자리에서 완결되는 루프였습니다. 이번 편은 그 왕복을, 후반부는 통로들의 자물쇠를 다룹니다.

## 1. 텍스트 알림을 카드로

출발점은 가독성이었습니다. 회귀 경보가 개행 없는 텍스트 덩어리로 날아와, 새벽엔 어디부터 읽을지 막막했거든요. 이미 "DB팀 문의"가 쓰던 embed 카드 형식으로 감지 알림 세 종류(회귀·이상·운영)를 통일했습니다. 인스턴스와 기종, 맥락(회귀는 비교 구간, 이상은 베이스라인), 담당 팀, 감지 내용 불릿, AI 1차 분석이 필드로 갈라지고, 심각도는 색으로 가릅니다. 운영은 빨강, 회귀는 앰버, 이상은 보라로, 콘솔의 심각도 색과 맞췄습니다.

![회귀·이상 감지 알림 embed 카드, 구간·감지 내용·AI 1차 분석·진단 딥링크가 필드로 갈라진다](/uploads/project/dbtower/alert-embed-reaction.png)

디테일 함정 하나. "콘솔에서 진단하기" 딥링크를 마크다운 마스킹 링크(`[라벨](URL)`)로 넣었는데 Discord가 원문 URL을 그대로 보여줬습니다. embed 필드의 마스킹 링크는 URL이 길면 렌더가 깨져, 미리 채워 보내는 질문을 짧게 줄여야 했습니다. 링크를 클릭하면 콘솔이 해당 인스턴스로, 진단 질문이 채워진 채 열립니다. "방금 온 회귀 알림의 원인을 분석해줘"까지 클릭 한 번입니다.

## 2. 이모지가 진단을 부른다, 특권 없이

핵심은 반대 방향, 채팅 안에서 끝나는 것입니다. Discord Gateway에 웹소켓으로 상시 연결하는 봇을 만들었습니다. 외부 라이브러리 없이 `java.net.http.WebSocket`으로 IDENTIFY·하트비트·재접속을 직접 구현했고(프론트를 의존성 0으로 유지해온 것과 같은 결), 알림에 돋보기 이모지가 달리면 대상 인스턴스를 자연어 진단에 태워 결과를 답글로 붙입니다.

함정 첫 번째는 사소한데 치명적이었습니다. 트리거를 왼쪽 돋보기(U+1F50D)로 등록했는데, 제가 단 건 오른쪽 돋보기(U+1F50E)였습니다. 둘은 **다른 유니코드**입니다. 이벤트는 오는데 판정만 조용히 실패하는, 로그 없이는 못 잡는 버그죠. 트리거를 집합으로 바꿔 둘 다 받게 했습니다.

두 번째 함정이 이 절의 본체입니다. 반응 이벤트(MESSAGE_REACTION_ADD)에는 message_id만 옵니다. "어느 인스턴스의 알림인지"는 그 메시지의 embed를 읽어야 아는데, 웹훅이 쓴 메시지를 봇이 REST로 읽으려면 **Message Content 특권 인텐트**가 필요합니다. 승인 심사가 붙는 권한이죠. 그런데 이 정보는 애초에 우리가 만든 겁니다. **보내는 시점에** 웹훅을 `?wait=true`로 호출해 message_id를 돌려받고, message_id → 인스턴스 매핑을 유한 캐시에 적어두면, 반응이 왔을 때 조회 한 번으로 끝납니다. 특권 인텐트 0개. 매핑에서 밀려난 오래된 알림만 embed 제목 파싱으로 폴백합니다.

e2e에서 예상 밖의 수확이 있었습니다. 하필 대상이 데모용으로 꺼둔 인스턴스라, 진단 도구 다섯 개가 전부 빈 결과와 리다이렉트만 물고 왔거든요. 그때 봇이 단 답글입니다.

> [mssql-pitr] 솔직히 이번엔 근본원인을 확정하지 못했습니다. 진단에 필요한 도구가 모두 데이터를 주지 못했기 때문입니다.
> (…시도한 근거 수집 5단계와 각각의 실패 사유…)
> 따라서 '알림이 온 이유'가 실제 DB 부하 때문인지, 수집 중단 자체를 알린 것인지조차 현재 데이터로는 구분할 수 없습니다. 수치를 지어내지 않겠습니다.

코드에 강제해온 원칙(값을 지어내지 않는다, 모르면 모른다고 말한다)이 판정 기준 문서를 타고 런타임 AI 응답까지 관통한 겁니다. 화려한 성공 케이스보다 이 답글이 더 마음에 듭니다.

정상 케이스는 이렇습니다. 회귀 알림에 돋보기를 달면 activity로 스파이크 부재를, compare로 "호출량은 늘었는데 레이턴시는 오히려 개선"을, query_stats·wait_events·slow_queries로 IO·Lock 병목 부재까지 근거 다섯 개를 모은 뒤, "사실상 유휴 상태고 알림 규칙 자체의 오탐일 가능성이 크다"는 결론과 어떤 정보가 더 있으면 좁힐 수 있는지를 카드 한 장에 담아 붙입니다.

![봇의 진단 답글 embed 카드, 근거 다섯 개와 정직한 한계 고지, 오탐 가능성 결론까지](/uploads/project/dbtower/bot-diagnosis-reply.png)

함정 세 번째는 운영에서야 나왔습니다. 진단 중 Gateway 연결이 자꾸 끊겨 재접속을 반복했는데(code=1000), 원인은 진단과 하트비트가 같은 단일 스레드를 쓰던 것이었습니다. "워커로 넘긴다"는 주석을 달아놓고 정작 같은 풀에 넣었으니, 분 단위 진단이 스레드를 점유하면 하트비트가 굶고 Discord는 응답 없는 연결을 정리해버립니다. 진단 전용 워커로 분리하니 5스텝 진단 동안 재접속 0회. 덤으로 재접속마다 취소 없이 누적되던 하트비트 태스크도 잡았고, AI 답글도 알림과 같은 embed 카드로 통일했습니다. 긴 답변엔 메시지 본문 한도(2000자)보다 embed 본문(4096자)이 알맞기도 합니다.

문은 좁게 열었습니다. 채널·유저 화이트리스트는 기본 거부, 봇 토큰이 없으면 Gateway 연결 자체를 안 하고, 봇 자신의 반응은 무시합니다(반응 판정은 순수 함수로 분리해 단위로 고정). 슬래시 커맨드(/dbtower) 경로는 Ed25519 요청 서명을 Java 표준 EdDSA로 검증하고, 진단이 3초 응답 제한보다 느리니 DEFERRED로 받아두고 팔로업으로 결과를 채웁니다.

## 3. 로그인 창이 토큰을 만든다, MCP OAuth 2.1

MCP 채널 인증은 지금까지 정적 Bearer 토큰, 관리자가 만들어 설정 파일에 손으로 붙여넣는 방식이었습니다. 돌아가지만 유출되면 수동 폐기 전까지 유효하고, 권한도 발급 시점에 고정됩니다. 표준 답은 OAuth 2.1입니다. 클라이언트가 붙으면 브라우저에 로그인 창이 뜨고, 로그인하면 토큰이 자동 발급되죠. DBTower엔 이미 로그인·유저·세션이 있으니 그 위에 인가 서버를 얹었습니다. 메타데이터 discovery(RFC 9728/8414), 동적 클라이언트 등록(RFC 7591), PKCE(S256 전용), refresh 회전까지입니다.

![MCP 클라이언트가 authorize를 열면 뜨는 DBTower 로그인 창, 로그인하면 토큰이 자동 발급된다](/uploads/project/dbtower/oauth-login-prompt.png)

함정은 discovery의 첫 관문에서 나왔습니다. 미인증 /mcp는 401과 WWW-Authenticate 헤더를 줘야 클라이언트가 "아, OAuth구나"를 알아채는데, 우리 서버는 **302 로그인 페이지**를 주고 있었습니다. 두 겹이었어요. 하나는 폼 로그인 체인이 /mcp까지 관할하던 것이라, 전용 stateless 필터 체인으로 분리했습니다. 그런데도 302가 남았습니다. 엔트리포인트의 `sendError(401)`가 서블릿 컨테이너의 에러 디스패치를 유발해 요청이 필터를 **다시 통과**했고, 거기서 또 로그인 리다이렉트로 덮인 겁니다. `setStatus(401)`로 바꾸니 끝났습니다. 프레임워크의 친절(에러 페이지 처리)이 프로토콜의 정확성을 깨는 전형적 케이스였습니다.

더 무서운 건 커밋 자동 리뷰가 잡아준 쪽입니다. redirect_uri 검증을 문자열 prefix로 하고 있었는데, `http://localhost:8080@evil.com/`이 통과합니다. @ 앞은 userinfo라 실제 호스트는 evil.com이고, **인가 코드가 공격자에게 흘러갑니다**. URI를 구조적으로 파싱해 스킴·호스트를 검증하고 userinfo·fragment를 거부하게 바꿨습니다. 같은 리뷰가 짚은 오픈 리다이렉트(클라이언트 검증 전에 에러 리다이렉트부터 하던 순서)와 동의 화면 부재(로그인된 사용자가 악성 링크만 클릭해도 코드가 발급되는 auth code injection)까지 함께 막고, 전부 단위 테스트로 고정했습니다. 보안 수정은 재발 방지까지가 수정이니까요.

브라우저 전체 플로우 실측: 동적 등록으로 client_id 발급 → authorize를 열면 로그인 창 → 로그인 → 콜백으로 code 전달 → PKCE verifier와 교환해 토큰 발급 → 그 토큰으로 /mcp 도구 14종 호출 성공. 틀린 verifier, 재사용된 refresh, 미등록 redirect_uri는 각각 명확히 거부됩니다.

## 4. 덤, 아예 비밀번호가 없는 계정

인증 김에 하나 더. 대상 DB 모니터링 계정 비밀번호는 암호화해 저장하지만 정적이라, 유출되면 사람이 알아채고 돌릴 때까지 유효합니다. Vault의 database secrets engine을 붙이면 이 창이 TTL로 줄어듭니다. 인스턴스 username을 `vault:<경로>`로 등록하면 접속 시점에 수명 있는 계정을 발급받고, 리스의 80% 시점에 선제 갱신하고, 만료된 계정은 DB에서 자동 소멸합니다. 실측에서 발급 → pg_stat_activity에 발급 계정 실접속 → 96초 뒤 새 계정 발급과 풀 교체 → 옛 계정 소멸까지 전체 수명주기를 확인했습니다. 여기도 리뷰가 한 건 잡았습니다. creds 경로가 관리자 입력에서 오니 토큰 ACL이 닿는 임의 시크릿을 읽을 수 있어, database/creds/ 마운트로 봉인했습니다.

7편의 디스크 포화 예측에도 접점이 늘었습니다. Prometheus에 직결돼 있던 지표 소스를 인터페이스로 갈라 CloudWatch(RDS FreeStorageSpace) 구현을 추가했습니다. RDS는 총 용량 메트릭이 없어 여유 %를 지어내는 대신 null로 두고, 판정이 "있는 축만으로" 동작하게 확장했습니다. 라이브 검증은 에뮬레이터(LocalStack)와 SDK의 프로토콜 세대 차이로 실 AWS가 필요해 정직하게 남겨뒀습니다.

대화 채널도 둘 더 늘었습니다. 하나는 알람 스킵. 레퍼런스 알림엔 "알람 스킵" 버튼이 있지만 Discord 웹훅 메시지엔 버튼을 달 수 없어(봇이 보낸 메시지 전용), 우리 봇의 문법대로 풀었습니다. 알림에 음소거 이모지를 달면 봇이 그 인스턴스의 알림을 1시간 중지하고 확인 답글을 답니다. 강제 지점은 알림이 전부 지나가는 웹훅 어댑터 한 곳이고, 만료되면 자동 재개됩니다. 다른 하나는 Slack Events 인바운드. 레퍼런스의 원 채널 방식 그대로, v0 HMAC 서명 검증(리플레이 5분 창)과 url_verification, 이모지 이벤트를 받아 스레드 답글로 진단을 붙입니다. 실 워크스페이스가 없어 서명 시뮬레이션까지가 검증 범위라는 것도 Discord 슬래시 커맨드 때와 같은 정직한 선입니다.

여기까지가 관제탑이 사람과 주고받는 층이었습니다. 남은 큰 조각은 저장소 바깥에 있습니다. 쌓인 스냅샷을 레이크하우스로 흘려보내고 장기 베이스라인을 되받는, 두 저장소가 손잡는 이야기입니다.

## 5. 반쪽짜리 악수

lakehouse 쪽 3편에서 "두 저장소가 손잡기"의 절반은 끝나 있었습니다. 창고(lakehouse)가 장기 베이스라인 마트를 계산해 원천 테이블로 되쓰는(writeback) 경로를 만들고, 32,498행 왕복과 권한 격리(permission denied)까지 실측해 뒀죠. 그런데 그 화물을 받는 테이블의 정식 DDL도, 판정에 쓰는 병합 로직도 이쪽(DBTower)엔 없었습니다. 화물은 도착하는데 아무도 안 뜯는 상태. 내릴 원료 쪽도 구멍이 있었습니다. 대기 이벤트는 화면에만 보여주고 영속을 안 했고(추출할 것이 없음), 크기는 "지금"만 알았습니다(추세를 계산할 시계열이 없음).

이번엔 그 반쪽들을 전부 닫은 기록입니다. 받는 쪽 하나(D8)와 주는 쪽 셋(V25·V26·보존 하한)을 닫고, 그 위에 자연어 서빙까지 얹었습니다.

## 6. 받는 쪽: 평소를 아는 창고, 판정하는 관제탑

BaselineService의 이상 감지는 14일 창의 (요일×시간대) 버킷 통계로 z-score를 냅니다. 문제는 주간 계절성입니다. "매주 월요일 아침 배치 피크"는 14일 창엔 버킷당 관측이 최대 2개라, 관측 부족으로 판정이 보류되거나 얕은 표본이 평범한 주기 부하를 이상으로 오탐합니다. 그 이력은 lakehouse에 있습니다. 같은 데이터의 수개월치가 있으니까요.

V24로 수신 테이블(`baseline_longterm`)을 정의하고, 병합을 이렇게 설계했습니다.

- **충분통계량 복원.** 누적기(Acc)는 n·Σx·Σx²를 들고 있습니다. 장기 요약(n, mean, stddev)에서 Σx = n·m, Σx² = (n−1)s² + n·m²를 복원해 더하면, 원시 관측을 일일이 더한 것과 수학적으로 동일한 가중 결합입니다. 근사가 아닙니다.
- **단위 정합.** 장기는 "시간당 호출량", 단기는 QPS입니다. /3600 선형 스케일이라 mean도 stddev도 같은 배율로 접힙니다.
- **장기가 나르는 축은 호출량뿐.** 레이턴시·행수는 단기 관측이 충분할 때만 판정합니다. 얕은 단기 표본을 장기 게이트에 얹으면, 오탐을 줄이려던 병합이 되레 오탐 문을 여니까요.
- **회귀 0이 계약.** 테이블이 없거나 비면 병합할 것이 없어 판정은 병합 전과 완전히 동일합니다. 같은 입력을 스위치 on/off 두 서비스에 넣어 z까지 일치함을 테스트로 고정했습니다.

라이브 검증. psql로 `SELECT 1 AS d8_spike`를 5분간 3,000번 날려 실측 스파이크를 만들고, 그 쿼리의 장기 버킷을 조작하며 같은 스캔을 반복했습니다.

```
장기 없음(신규 쿼리)   → 학습중 (판정 보류 — 기존 동작)
장기 = "평소 0.2qps"   → 이상 발화: qps 현재=7.47, 장기평균=0.3, z=7.42, 관측=101
```

**관측=101.** 장기 100 + 단기 1. 가중 병합으로 게이트를 넘겨 판정이 가능해졌고, z가 병합 통계로 계산됐다는 실물 증거가 응답에 찍혔습니다. 반대 방향(장기가 "평소가 원래 5.0"임을 알아 같은 5.0 스파이크를 무경보 처리)은 단위 테스트(`월요일_피크를_아는_장기_평균이_오탐을_없앤다`)로 고정했습니다. 라이브에선 배치 타이밍이 스파이크 꼬리를 놓쳐 그 방향의 증명력이 없었다는 것도 정직하게 적어 둡니다.

운영 발견 하나. 검증용 수동 테이블을 지우고 Flyway가 재생성하자 lakehouse_writer의 GRANT가 함께 사라져 첫 되쓰기가 permission denied로 죽었습니다. **DDL 재생성은 GRANT 재적용을 요구한다**. 역할·권한은 환경 소유라 마이그레이션에 넣지 않고, 운영 절차에 이 함정을 남겼습니다.

## 7. 주는 쪽: 세 개의 공급 잡

**V25 대기 이벤트(5분 주기).** waitEvents()는 5기종을 조회해 화면에 보여줄 뿐 영속이 없었습니다. "지난달 그 장애 때 뭘 기다렸나"는 이력이 있어야 답하죠. 첫 사이클이 기종별 실형을 드러냈습니다: MSSQL 37·Oracle 50·Mongo 6·PG 3. 미지원이거나 대기가 없는 기종은 빈 목록이고, 행을 지어내지 않습니다.

**V26 오브젝트 크기(6시간 주기).** "이 DB 몇 달 뒤 꽉 차나"는 크기의 시계열이 필요합니다. 단기 디스크 ETA(7편의 Prometheus 라이브 카나리아)와는 지평이 다른 층이죠. 첫 사이클은 6인스턴스 43오브젝트(self-PG 185MB, PG 70MB). 이 원료로 lakehouse가 선형 추세와 임계 D-day를 계산합니다(그쪽 unit test가 기지값으로 산식을 고정: +10MB/일·임계 2000MB → 잔여 81일). volume 계열 컬럼은 계약상 nullable로 두고 채우지 않았습니다. 기종별 볼륨 조회는 후속이라, 없는 값을 채워 넣지 않습니다.

**plan_snapshot 보존 48시간 하한.** 카운트 보존(쿼리당 최신 20)은 플랜이 자주 뒤집히는 쿼리에서 "어제" 행을 하루가 닫히기 전에 밀어낼 수 있습니다. lakehouse가 어제 하루창을 D+1에 추출하는 계약과 정면 충돌이죠. 스윕에 시간 하한을 병행해 어린 행은 세대를 초과해도 남깁니다. 테이블이 일시적으로 상한을 넘는 것이 의도된 트레이드오프입니다(추출 정합 > 상한 엄격성).

함정 하나. `compileJava`는 리소스를 복사하지 않습니다. V26을 넣고 컴파일만 한 채 재기동했더니 마이그레이션이 classpath(build/resources)에 없어 조용히 적용되지 않았습니다. `classes` 태스크가 정답이었습니다.

## 8. Metabot 없이, 말로 물으면 차트가 생긴다

Metabase의 AI(Metabot)는 Cloud 전용이라 셀프호스트에 없습니다. 그 갭을 부품 재조립으로 메웠습니다: 에이전트 → MCP(14→16종) → REST → **Metabase API** → DuckLake 장기 마트.

DuckDB JDBC와 확장을 DBTower에 직접 얹는 선택지를 접은 게 설계의 핵심입니다. DuckLake의 서빙 계층은 이미 Metabase입니다(lakehouse 7단계 계약: "Metabase는 DuckLake만 read-only"). 경유하면 새 의존이 0이고, read-only 봉인도 Metabase 커넥션 구조가 최종 방어선이 됩니다.

- `lakehouse_query`: 장기 마트 SELECT. 도구 설명에 **실재 테이블·컬럼을 명시**해 에이전트가 스키마를 지어내지 못하게 했고, SELECT/WITH 전용 가드(주석 제거 후 판정, 세미콜론·쓰기·DDL 거부)와 행 상한을 걸었습니다.
- `lakehouse_card_create`: 질의를 Metabase 카드로 저장하고 URL을 돌려줍니다. 에이전트가 만든 카드는 "DBTower AI" 전용 컬렉션에 격리돼, 사람의 대시보드를 오염시키지 않습니다.

실측입니다. 용량 예측 마트 질의는 깔끔한 6행을 돌려줬고, `DELETE FROM ...`은 400("SELECT/WITH로 시작하는 읽기 질의만 허용한다")으로 거부됐고, 카드 생성은 `{"card_id":76, "url":".../question/76", "collection":"DBTower AI"}`를 반환했습니다. 그 URL을 열면:

![에이전트가 만든 Metabase 카드 76, "인스턴스별 관측 오브젝트 총 크기(MB)" bar 차트가 DBTower AI 컬렉션 아래 6행·143ms로 렌더된 실화면](/uploads/project/dbtower/dbtower19_ai_card.png)

에이전트가 만든 질문이 실제 차트로 서 있습니다. 대화는 에이전트(Claude·Discord)에서 일어나고 결과물이 Metabase에 남습니다. Metabot의 "화면 안 채팅"과는 다른 모양이고, 그 차이는 그대로 남깁니다. 대신 이 경로는 Metabot이 못 하는 걸 합니다: 장기 마트 조회와 라이브 진단(기존 14도구)과 차트 생성을 **한 대화에서** 섞을 수 있습니다.

마지막 함정. Boot 4의 기본 직렬화는 Jackson 3입니다. Metabase 응답을 Jackson 2 JsonNode로 들고 있다가 컨트롤러에서 그대로 반환했더니, 스프링이 그 노드를 POJO로 직렬화해 `{"array":false,"bigDecimal":false,...}` 같은 메타데이터 덤프가 나갔습니다. JSON 문자열로 직접 응답해 해소했습니다.

## 9. 남은 것을 정직하게

- **병합의 억제 방향 라이브 실증은 4주 이력 뒤의 몫입니다.** 합성 주입 없이 실버킷이 차오르면, "월요일 피크 무경보"를 실측으로 다시 확인합니다.
- **volume·max_bytes는 공급되지 않습니다(NULL).** 기종별 볼륨 조회(MSSQL dm_os_volume_stats·Oracle maxbytes)는 후속 아크입니다.
- **되쓰기 스케줄의 deadman 편입은 lakehouse 쪽 결정으로 남아 있습니다.**
- **Metabase 60의 공식 MCP 서버**가 DuckDB 드라이버의 60 지원과 함께 오면, 카드 생성 도구는 공식 경로와 비교해 재평가합니다.

---

배운 건, 두 시스템의 루프는 계약으로 닫힌다는 것이었습니다. 받는 쪽은 "빈 테이블이면 회귀 0", 주는 쪽은 "없는 값은 NULL"을 계약으로 삼았고, 보존은 추출 창이 닫히기 전엔 지우지 않으며, 서빙은 SELECT만 전용 컬렉션에 남깁니다. 계약이 명시돼 있으니 어느 쪽이 먼저 배포되든, 어느 쪽이 죽어 있든 시스템은 약속대로 동작합니다. 관측=101이라는 숫자 하나가 그 계약들이 실제로 맞물려 돌아간다는 증거로 남았습니다.

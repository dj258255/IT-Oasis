---
title: '말이 다른 두 시스템 사이에서 — 연계 게이트웨이를 만드는 이유'
titleEn: 'Between Two Systems That Do Not Speak the Same Language — Why Build an Integration Gateway'
description: "은행 계정계는 20년 된 시스템이라 고정길이 전문(電文)과 TCP로만 말하고, 모바일 앱은 JSON과 HTTP REST로만 말합니다. 둘은 직접 대화가 안 되는데, 계정계를 뜯어고치는 건 수백억짜리 프로젝트라 불가능합니다. 그래서 중간에 통역기를 세웁니다 — 전문과 JSON을 서로 바꾸고(연계), 그 통로를 외부에 열면서 인증·라우팅·유량제어로 지키는(API 게이트웨이) 미들웨어. 마이데이터·오픈뱅킹이 정확히 이 상황이고, 이 시리즈는 그 통역기를 작게 직접 만들어보는 기록입니다."
descriptionEn: "A bank's core system, twenty years old, speaks only fixed-length messages over TCP; the mobile app speaks only JSON over HTTP REST. They cannot talk directly, and rewriting the core is a multi-hundred-million-dollar project. So we put a translator in the middle — middleware that converts between fixed-length messages and JSON (integration), and guards that channel with authentication, routing, and rate limiting when it opens to the outside (API gateway). MyData and open banking are exactly this situation, and this series is a record of building that translator, small and by hand."
date: 2026-07-08
tags:
  - Java
  - Spring Boot
  - Netty
  - TCP
  - API Gateway
  - EAI
category: personal/gwanmun
coverImage: /uploads/project/gwanmun/cover.svg
draft: false
series: "gwanmun"
seriesOrder: 0
---

## 0. 상황 — 두 시스템이 말이 안 통한다

은행에 모바일 잔액조회를 붙여야 한다고 해봅시다. 문제는 양쪽이 쓰는 언어가 완전히 다르다는 거예요.

- **계정계(코어뱅킹)** 는 20년 된 시스템이라 이렇게 말합니다:
  ```
  "0200"  "12345678901234"  "IN01"  공백패딩...
  └전문구분┘ └──계좌번호(14)──┘ └거래코드┘
  ```
  띄어쓰기와 자릿수가 곧 의미인 **고정길이 전문(電文)**, 그것도 **TCP 소켓**으로.
- **모바일 앱** 은 이렇게 말합니다: `{"account":"12345678901234"}` — **JSON**을 **HTTP REST**로.

이 둘은 직접 대화가 안 됩니다. 그런데 계정계를 JSON/REST로 통째로 뜯어고치는 건 현실적으로 감당하기 어려운 규모예요. 그래서 못 고칩니다.

## 1. 판단 — 둘 다 못 고치면, 중간에 통역기를 세운다

두 시스템을 못 바꾸니 답은 하나입니다. **가운데에 통역기를 세우는 것.** 이 통역기가 하는 일은 두 층으로 나뉩니다.

- **연계(통역) 층** — JSON을 계정계가 알아듣는 전문으로 바꾸고, TCP로 보내고, 돌아온 전문을 다시 JSON으로. 프로토콜(HTTP↔TCP)과 포맷(JSON↔전문)을 동시에 변환합니다.
- **API 게이트웨이 층** — 이 통로가 외부(핀테크·마이데이터)에 열리면 아무나 들어오면 안 되니, 앞단에서 인증·라우팅·유량제어로 지킵니다. 아파트 단지 입구의 경비실 같은 거예요 — 신분 확인하고, 어디로 갈지 안내하고, 방문 횟수를 제한하되, 집 안 살림(잔액 계산)엔 관여하지 않습니다.

![gwanmun 아키텍처 — ① API 게이트웨이 층과 ② 연계(통역) 층이 모바일 REST와 레거시 전문 사이를 잇는다](/uploads/project/gwanmun/architecture.svg)

이게 바로 **마이데이터·오픈뱅킹**의 구조입니다. 외부 핀테크가 REST로 요청하면, 게이트웨이가 문지기 역할을 하고, 그 아래 연계층이 계정계의 전문으로 통역하죠.

## 2. 그래서 이 시리즈가 만드는 것

이 시리즈는 **그 통역기를 작게 직접 만듭니다.** 진짜 은행 없이 로컬에서 전 과정을 재현해요 — 목업 계정계(전문을 주고받는 작은 TCP 서버)까지 세워서요.

핵심 소재는 이겁니다:

- **바이트가 진실인 세계** — 고정길이 전문은 한글이 EUC-KR 2바이트라, `substring(오프셋, 길이)`로 자르면 글자가 깨집니다. 문자 인덱스가 아니라 바이트 인덱스로 다뤄야 하는, JSON에선 겪을 일 없는 함정들.
- **TCP는 스트림이라 한 전문이 한 번에 안 온다** — "고정길이 200바이트"인데 120바이트만 왔다가 나머지가 나중에 오는(partial read) 걸 손으로 다뤄야 합니다.
- **게이트웨이를 프레임워크 없이 손으로** — 인증·라우팅·유량제어를 필터 체인으로 직접 짜서, 게이트웨이가 안에서 무슨 일을 하는지 이해합니다.

정직하게 범위를 긋자면, 금융결제원 표준 전문을 전수 구현하는 건 아닙니다 — 대표 거래 몇 종으로 핵심 흐름을 다룹니다.

만드는 원칙은 다른 프로젝트(DBTower)에서 지켜온 그대로입니다 — **필요한 것부터, 실측으로 확인하고, 못 하는 것은 못 한다고 적는다.** 각 편은 "어떤 상황에서 무엇이 깨지고, 그래서 무엇을 만드는가"의 개선 아크로 씁니다.

코드는 [GitHub](https://github.com/dj258255/gwanmun)에 공개합니다.

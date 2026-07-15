---
title: '여러 팀이 한 콘솔을 쓰기 시작할 때 — 404로 숨기는 접근 제어와 재시작을 견디는 로그인'
titleEn: 'When Multiple Teams Share One Console — Access Control That Hides with 404, and Logins That Survive Restarts'
description: '이기종 DBMS 운영 관리 플랫폼 DBTower 17편. Phase 3의 기록입니다. 인스턴스에 심어둔 팀 라벨이 드디어 제 역할을 합니다 — 팀 사용자는 자기 팀 인스턴스와 전역 인스턴스만 보고, 남의 팀 인스턴스는 목록에서 사라질 뿐 아니라 id로 직접 찔러도 403이 아니라 404를 받습니다. 존재 자체를 숨기는 겁니다. 강제 지점은 단 한 곳(RegistryService)이고, 스코프는 로그인 시 authority로 실려 모듈 경계를 넘지 않습니다. 후반부는 공유 세션 — 세션을 메타 DB에 저장해 앱을 죽였다 살려도 같은 쿠키로 로그인이 살아남는 것을 실측했는데, 그 과정에서 Boot 자동구성이 인메모리로 조용히 폴백하는 함정과, 명시 어노테이션이 테스트 스키마 초기화를 우회하는 함정을 연달아 밟았습니다. 조용한 폴백은 재시작 생존이라는 계약을 소리 없이 깹니다.'
descriptionEn: 'Part 17 of DBTower — Phase 3. The team labels planted on instances finally do their job: team users see only their team''s instances plus global ones, and probing another team''s instance by id returns 404, not 403 — hiding existence itself. Enforcement lives in exactly one place (RegistryService), with scope carried as a login authority so no module boundary is crossed. The second half is shared sessions: storing sessions in the meta DB so logins survive an app restart — measured live, after stepping on two traps in a row: Boot auto-configuration silently falling back to in-memory sessions, and the explicit annotation bypassing test schema initialization. Silent fallbacks break the restart-survival contract without a sound.'
date: 2026-07-16
tags:
  - Java
  - Spring Boot
  - Security
  - Spring Session
  - DBRE
category: personal/DBTower
coverImage: /uploads/project/dbtower/cover.svg
draft: false
series: "DBTower"
seriesOrder: 17
---

## 0. 들어가며, 혼자 쓰는 도구에서 팀들이 쓰는 플랫폼으로

지금까지 DBTower는 사실상 "관리자 한 명"의 도구였습니다. ADMIN과 VIEWER 역할 구분은 있었지만, 로그인만 하면 등록된 인스턴스 전부가 보였습니다. 회사라면 이야기가 다릅니다. 주문 팀의 개발자가 정산 팀 DB의 슬로우 쿼리를 들여다볼 이유도, 권한도 없습니다. Phase 3는 그 경계를 긋는 일입니다 — 그리고 여러 팀이 쓰는 플랫폼답게, 로그인 자체도 서버 재시작쯤엔 흔들리지 않아야 합니다.

## 1. 강제 지점은 한 곳이어야 한다

접근 제어에서 제일 무서운 건 "깜빡한 컨트롤러"입니다. 인스턴스를 다루는 API가 수십 개인데 각 컨트롤러마다 권한 검사를 뿌리면, 언젠가 하나는 빠집니다. 그래서 구조부터 정했습니다 — DBTower의 모든 모듈(insight, alert, backup, advisor, mcp...)은 인스턴스를 `RegistryService.findById/findAll` 두 메서드로만 얻습니다. 이 두 메서드가 곧 **단일 경계**입니다. 여기 한 곳에 스코프 필터를 넣으면 시점 비교든 백업이든 MCP든 전부 걸러집니다.

규칙은 네 줄입니다. 인증이 없는 호출(백그라운드 폴러)은 전역 — 수집과 경보는 팀과 무관하게 전체를 지켜야 하니까요. ADMIN은 전역 — 관리자가 자기 눈을 가리면 관리가 안 됩니다. 팀 라벨이 있는 사용자는 자기 팀 인스턴스와 라벨 없는(전역) 인스턴스만. 라벨 없는 사용자는 기존처럼 전역(하위 호환).

재미있는 설계 문제는 "registry가 사용자의 팀을 어떻게 아느냐"였습니다. 사용자 정보는 security 모듈 소관이라 registry가 그걸 조회하면 모듈 의존이 생깁니다. 답은 스코프를 **로그인 시점에 authority로 실어 보내는 것** — 인증이 성공하면 `ROLE_VIEWER`와 함께 `TEAM_주문팀` 같은 권한이 붙고, registry는 SecurityContext만 읽으면 됩니다. Spring Security 코어 외엔 아무것도 참조하지 않습니다. 부수 효과로 팀 변경은 다음 로그인부터 적용되는데, 이건 감수할 만한 명확성입니다.

## 2. 403이 아니라 404 — 존재를 숨긴다

스코프 밖 인스턴스를 id로 직접 찌르면 어떻게 될까요. 403 Forbidden을 주면 "당신은 못 보지만, **그 id의 인스턴스는 존재한다**"는 사실이 샙니다. 공격자 입장에선 id를 순회하며 인프라 지도를 그릴 수 있죠. 그래서 스코프 밖은 미등록과 **완전히 같은 404, 완전히 같은 메시지**를 받습니다. "등록되지 않은 인스턴스: 7" — 이 응답만 보고는 7번이 없는 건지, 남의 팀 것인지 구분할 수 없습니다. 단위 테스트가 이 메시지 동일성을 직접 단언합니다.

라이브로 확인했습니다. local-mysql에 team-a, local-postgres에 team-b를 달고 viewer 계정을 team-a로 지정한 뒤 viewer로 로그인하니 — 목록에 5개(team-a 뱃지가 붙은 mysql + 라벨 없는 전역 4개)만 남고 postgres는 사라졌습니다. admin 화면엔 7개 전부 보이고요. postgres의 id를 직접 호출하면 404, 자기 팀 mysql은 200. 화면 스크린샷과 함께 검증 기록에 남겼습니다.

## 3. 재시작을 견디는 로그인 — 그리고 조용한 폴백 두 번

여러 팀이 쓰는 플랫폼에서 배포 한 번에 전원이 로그아웃되는 건 곤란합니다. 세션을 서버 메모리가 아니라 메타 DB에 저장하면(spring-session-jdbc) 재시작에도, 나중에 노드를 늘려도 로그인이 살아남습니다. ShedLock 때와 같은 판단입니다 — 이미 있는 메타 DB를 재사용하고, Redis는 규모가 커지면 승급하면 됩니다.

구현 자체는 의존성 하나와 마이그레이션 하나(표준 DDL)인데, 함정을 연달아 두 번 밟았습니다. 첫 번째: 의존성과 `store-type: jdbc` 설정만으로 됐겠지 하고 재시작 생존을 실측하니 **401**. DB의 세션 테이블도 비어 있었습니다. Boot 자동구성이 어떤 이유로든 조건이 어긋나면 **인메모리로 조용히 폴백**합니다 — 로그에 경고 한 줄 없이요. 명시적으로 `@EnableJdbcHttpSession`을 붙이니 그제야 세션이 DB에 쌓이고 재시작 후에도 같은 쿠키로 200이 나왔습니다.

두 번째 함정은 그 명시 어노테이션의 대가였습니다. 이 어노테이션은 Boot의 `initialize-schema` 속성을 **우회**합니다. 운영은 Flyway가 테이블을 만들어주니 문제없지만, 테스트는 H2 인메모리에 Flyway를 끄고 도는 구조라 SPRING_SESSION 테이블이 없어 통합 테스트가 우수수 떨어졌습니다. 해법은 책임을 명확히 가르는 것 — 운영 스키마는 Flyway가, 테스트 스키마는 spring-session이 제공하는 H2용 스크립트를 `sql.init`으로 직접 주입해서 만듭니다.

이 이야기의 교훈은 하나입니다. **"조용한 폴백"은 계약을 소리 없이 깹니다.** 재시작 생존은 기능이 아니라 계약이고, 계약은 켜졌다고 믿는 게 아니라 죽였다 살려서 확인하는 겁니다. 실제로 앱을 kill하고 다시 띄운 뒤 같은 쿠키로 `/api/me`가 200을 돌려주는 것까지가 검증이었습니다.

## 4. 덤 — 백업에 화면을, 스크립트에 방어를

이번 아크에 작은 조각 둘이 함께 들어갔습니다. 하나는 백업/PITR 카드 — 16편의 백업 기능들이 API로만 있었는데, 복원 가능 창과 복원 문안, 이력(SUCCESS 초록 / FAILED 빨강 / UNSUPPORTED 회색 — "못 하는 것"을 실패로 위장하지 않는 색 구분)을 콘솔에서 보게 됐습니다. 다른 하나는 커밋 보안 리뷰가 잡아준 진짜 취약점 — RMAN 스크립트는 `CONNECT user/pass@...` **다음 줄부터가 곧 실행 명령**이라, 비밀번호에 개행 하나만 섞이면 `SHUTDOWN IMMEDIATE;`가 실행될 수 있었습니다. 자격증명에 개행·따옴표가 있으면 조용히 지우는 대신 명확히 거부하도록 고쳤습니다. 조용한 변조는 인증 실패의 원인만 흐립니다.

다음은 스케일의 나머지 조각들입니다 — 디스크가 차오르는 속도를 미리 계산하는 예측 경보(기반이 되는 Prometheus 클라이언트는 이미 모니터링 아크에서 만들어져 있습니다), 그리고 수천 대를 향한 Phase 4의 잔여들. 관제탑이 "지금"만이 아니라 "며칠 뒤"를 말하기 시작할 차례입니다.

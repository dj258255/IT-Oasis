---
title: '타이미 - 집중력 타이머 앱을 직접 만드는 이유'
titleEn: 'Tymee - Why I Am Building a Focus Timer App'
description: 게이미피케이션 기반 집중력 타이머 서비스 타이미의 개발 동기, Linear-GitHub-Slack 자동화, 모바일 OAuth 인증, 코드 품질 파이프라인을 정리했습니다.
descriptionEn: A retrospective on building Tymee, a gamification-based focus timer service, covering project automation, mobile OAuth, and code quality pipelines.
date: 2026-02-10
tags:
  - Retrospective
  - Spring Boot
  - React Native
  - GitHub Actions
  - Linear
  - OAuth
category: 프로젝트/Tymee
coverImage: /uploads/프로젝트/Tymee/retrospective/title.svg
draft: false
---

## 프로젝트 소개

타이미는 **게이미피케이션 기반 집중력 향상 타이머 서비스**입니다.

개발하는 친구가 항상 타이머 앱을 켜고 공부하는 모습을 보면서 시작됐습니다. 앱스토어 상위 타이머 앱 5개를 2주간 직접 사용해봤는데, "지속 동기 부여가 안 된다"는 피드백이 공통적이었습니다. 공부/업무는 결과가 나오기까지 시간이 오래 걸리지만, 게임은 레벨업이나 아이템 획득 같은 **즉각적인 보상**이 있어서 빠져들게 됩니다. 이 간극을 게이미피케이션으로 채워보려 합니다.

![타이미 집중 타이머](/uploads/프로젝트/Tymee/retrospective/focus-timer.png)

**기간**: 2025.11.25 - 진행 중
**형태**: 개인 프로젝트
**기술 스택**: Spring Boot, React Native, Redis, GitHub Actions, Linear

---

## 왜 직접 만드나

팀 프로젝트에서는 항상 정해진 사용자(팀원, 심사위원)만 서비스를 써봤습니다. **실제 유저에게 피드백을 받아 개선하는 경험**을 해보고 싶어서 개인 프로젝트를 시작했습니다.

![공부 기록 화면](/uploads/프로젝트/Tymee/retrospective/study-record.png)

---

## 주요 구현

### Linear-GitHub-Slack 자동화 파이프라인

1인 개발이지만 체계적인 이슈 관리가 필요했습니다. Linear에서 이슈 생성 → 브랜치 자동 생성 → PR 머지 → 이슈 자동 종료 → Slack 알림까지, 매번 수동으로 5단계를 거치는 게 비효율적이었습니다.

자동화 파이프라인을 구축해서 **이슈 하나당 수동 작업 5번을 0번으로 줄였습니다**. 117개 이슈를 놓치지 않고 추적하고 있습니다.

![Linear 보드](/uploads/프로젝트/Tymee/retrospective/linear-board.png)

> 도입 과정: [타이미 소개](/blog/프로젝트/tymee/tymee-introduction)

### 모바일 OAuth + JWT + Redis 인증 시스템

웹과 모바일은 인증 방식이 다릅니다. 웹은 HttpOnly Cookie + XSS 방어가 핵심이지만, 모바일은 네이티브 앱이라 쿠키 개념이 없고 XSS도 불가능합니다. 대신 **멀티 디바이스 지원**이 필수입니다.

Google(라이브러리), Apple(공개키 직접 fetch + 캐싱), Kakao(REST API)별 OAuth 검증을 구현하고, **Refresh Token Rotation**으로 토큰 탈취 감지, `deviceId`별 독립 세션으로 기기별 선택적 로그아웃을 지원합니다.

> 상세 분석: [모바일 JWT 인증](/blog/프로젝트/tymee/mobile-jwt-auth)

### 코드 품질 자동화 파이프라인

SonarQube는 Private 레포가 유료이고 3GB+ RAM 서버가 필요합니다. 개별 도구를 조합해서 완전 무료로 구축했습니다:
- **Spotless**: Google Java Format 자동 포맷팅
- **Checkstyle**: 네이밍/import/블록 규칙 검사
- **SpotBugs**: 바이트코드 분석으로 NPE, 리소스 누수 탐지
- **JaCoCo**: 라인 커버리지 60% / 브랜치 커버리지 70% 기준

![CI 알림](/uploads/프로젝트/Tymee/retrospective/ci-alerts.png)

> 상세 분석: [코드 품질 관리](/blog/프로젝트/tymee/code-quality-management)

---

## 기억에 남는 트러블슈팅

### Spring Boot 4 API Versioning + Swagger 충돌

Spring Boot 4에서 새로 도입된 API Versioning을 활성화하니 Swagger에 접근할 때 `InvalidApiVersionException`이 발생했습니다. 신규 기능이라 레퍼런스가 거의 없었습니다. springdoc GitHub 이슈까지 뒤져서 **화이트리스트 방식 ApiVersionResolver**로 해결했습니다.

> 상세 분석: [Spring Boot 4 API Versioning + Swagger 충돌](/blog/프로젝트/tymee/spring-boot4-api-versioning)

### 이슈 추적 누락 문제

초기에 GitHub Issues만 사용했는데, PR을 머지해도 이슈 상태가 자동으로 바뀌지 않아서 완료된 작업이 Open 상태로 남는 문제가 있었습니다. 117개 이슈 중 실제 진행률을 파악할 수 없었습니다. Linear의 GitHub Integration으로 전환해서 해결했습니다.

![GitHub PR 기반 워크플로우](/uploads/프로젝트/Tymee/retrospective/github_pr.png)

---

## 현재 진행 상황과 느낀 점

API 설계 완료, React Native UI 구현 중이고, Spring Boot 백엔드 개발을 진행하고 있습니다.

### 자동화는 "귀찮음"에서 시작된다

혼자 개발하면서 2주차에 "이 기능 구현했었나?"를 3번이나 검색했습니다. 초기 설정에 2시간을 투자했지만, 이후 **매일 10분씩 절약**하고 있습니다. "나중에 귀찮을 일"을 발견하면 바로 자동화하는 습관이 생겼습니다.

### 실제 유저를 위한 코드

팀 프로젝트와 개인 프로젝트의 가장 큰 차이는 **모든 의사결정의 책임이 온전히 나에게 있다**는 것입니다. 아키텍처 선택부터 UI 디자인까지, 왜 이렇게 했는지 스스로에게 설명할 수 있어야 합니다. 이 경험이 기술적 판단력을 키워주고 있다고 느낍니다.

> 아키텍처 선택 과정: [타이미 아키텍처 선택](/blog/프로젝트/tymee/tymee-architecture-selection)

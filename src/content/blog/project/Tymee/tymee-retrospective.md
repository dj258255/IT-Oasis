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
category: project/Tymee
coverImage: /uploads/project/Tymee/retrospective/title.svg
draft: false
---

## 프로젝트 소개

타이미는 **게이미피케이션 기반 집중력 향상 타이머 서비스**입니다.

개발하는 친구가 항상 타이머 앱을 켜고 공부하는 모습을 보면서 시작됐습니다. 앱스토어 상위 타이머 앱 5개를 2주간 직접 사용해봤는데, "지속 동기 부여가 안 된다"는 피드백이 공통적이었습니다. 공부/업무는 결과가 나오기까지 시간이 오래 걸리지만, 게임은 레벨업이나 아이템 획득 같은 **즉각적인 보상**이 있어서 빠져들게 됩니다. 이 간극을 게이미피케이션으로 채워보려 합니다.

![타이미 집중 타이머](/uploads/project/Tymee/retrospective/focus-timer.png)

**기간**: 2025.11.25 - 진행 중
**형태**: 개인 프로젝트
**기술 스택**: Spring Boot, React Native, Redis, GitHub Actions, Linear

---

## 왜 직접 만드나

팀 프로젝트에서는 항상 정해진 사용자(팀원, 심사위원)만 서비스를 써봤습니다. **실제 유저에게 피드백을 받아 개선하는 경험**을 해보고 싶어서 개인 프로젝트를 시작했습니다.

![공부 기록 화면](/uploads/project/Tymee/retrospective/study-record.png)

---

## 주요 구현

### Linear-GitHub-Slack 자동화 파이프라인

1인 개발이지만 체계적인 이슈 관리가 필요했습니다. Linear에서 이슈 생성 → 브랜치 자동 생성 → PR 머지 → 이슈 자동 종료 → Slack 알림까지, 매번 수동으로 5단계를 거치는 게 비효율적이었습니다.

자동화 파이프라인을 구축해서 **이슈 하나당 수동 작업 5번을 0번으로 줄였습니다**. 117개 이슈를 놓치지 않고 추적하고 있습니다.

![Linear 보드](/uploads/project/Tymee/retrospective/linear-board.png)

> 도입 과정: [타이미 소개](/blog/project/tymee/tymee-introduction)

### 모바일 OAuth + JWT + Redis 인증 시스템

웹과 모바일은 인증 방식이 다릅니다. 웹은 HttpOnly Cookie + XSS 방어가 핵심이지만, 모바일은 네이티브 앱이라 쿠키 개념이 없고 XSS도 불가능합니다. 대신 **멀티 디바이스 지원**이 필수입니다.

Google(라이브러리), Apple(공개키 직접 fetch + 캐싱), Kakao(REST API)별 OAuth 검증을 구현하고, **Refresh Token Rotation**으로 토큰 탈취 감지, `deviceId`별 독립 세션으로 기기별 선택적 로그아웃을 지원합니다.

> 상세 분석: [모바일 JWT 인증](/blog/project/tymee/mobile-jwt-auth)

### 코드 품질 자동화 파이프라인

SonarQube는 Private 레포가 유료이고 3GB+ RAM 서버가 필요합니다. 개별 도구를 조합해서 완전 무료로 구축했습니다:
- **Spotless**: Google Java Format 자동 포맷팅
- **Checkstyle**: 네이밍/import/블록 규칙 검사
- **SpotBugs**: 바이트코드 분석으로 NPE, 리소스 누수 탐지
- **JaCoCo**: 라인 커버리지 60% / 브랜치 커버리지 70% 기준

![CI 알림](/uploads/project/Tymee/retrospective/ci-alerts.png)

> 상세 분석: [코드 품질 관리](/blog/project/tymee/code-quality-management)

---

## 기억에 남는 트러블슈팅

### Spring Boot 4 API Versioning + Swagger 충돌

Spring Boot 4에서 새로 도입된 API Versioning을 활성화하니 Swagger에 접근할 때 `InvalidApiVersionException`이 발생했습니다. 신규 기능이라 레퍼런스가 거의 없었습니다. springdoc GitHub 이슈까지 뒤져서 **화이트리스트 방식 ApiVersionResolver**로 해결했습니다.

> 상세 분석: [Spring Boot 4 API Versioning + Swagger 충돌](/blog/project/tymee/spring-boot4-api-versioning)

### 이슈 추적 누락 문제

초기에 GitHub Issues만 사용했는데, PR을 머지해도 이슈 상태가 자동으로 바뀌지 않아서 완료된 작업이 Open 상태로 남는 문제가 있었습니다. 117개 이슈 중 실제 진행률을 파악할 수 없었습니다. Linear의 GitHub Integration으로 전환해서 해결했습니다.

![GitHub PR 기반 워크플로우](/uploads/project/Tymee/retrospective/github_pr.png)

---

## 현재 진행 상황과 느낀 점

API 설계 완료, React Native UI 구현 중이고, Spring Boot 백엔드 개발을 진행하고 있습니다.

### 자동화는 "귀찮음"에서 시작된다

혼자 개발하면서 2주차에 "이 기능 구현했었나?"를 3번이나 검색했습니다. 초기 설정에 2시간을 투자했지만, 이후 **매일 10분씩 절약**하고 있습니다. "나중에 귀찮을 일"을 발견하면 바로 자동화하는 습관이 생겼습니다.

### 실제 유저를 위한 코드

팀 프로젝트와 개인 프로젝트의 가장 큰 차이는 **모든 의사결정의 책임이 온전히 나에게 있다**는 것입니다. 아키텍처 선택부터 UI 디자인까지, 왜 이렇게 했는지 스스로에게 설명할 수 있어야 합니다. 이 경험이 기술적 판단력을 키워주고 있다고 느낍니다.

> 아키텍처 선택 과정: [타이미 아키텍처 선택](/blog/project/tymee/tymee-architecture-selection)

<!-- EN -->

## About the Project

Tymee is a **gamification-based focus timer service for improving concentration**.

It started from watching a developer friend who always had a timer app running while studying. I personally used the top 5 timer apps on the App Store for 2 weeks, and the common feedback was "it doesn't sustain motivation." Study and work take a long time to show results, but games hook you with **instant rewards** like leveling up or acquiring items. I'm trying to bridge this gap with gamification.

![Tymee Focus Timer](/uploads/project/Tymee/retrospective/focus-timer.png)

**Duration**: Nov 25, 2025 – In Progress
**Type**: Personal Project
**Tech Stack**: Spring Boot, React Native, Redis, GitHub Actions, Linear

---

## Why I'm Building It Myself

In team projects, only predetermined users (teammates, judges) ever used the service. I wanted the experience of **receiving feedback from real users and iterating on it**, which is why I started this personal project.

![Study Record Screen](/uploads/project/Tymee/retrospective/study-record.png)

---

## Key Implementations

### Linear-GitHub-Slack Automation Pipeline

Even as a solo developer, I needed systematic issue management. The flow from creating an issue in Linear → auto-creating a branch → merging a PR → auto-closing the issue → Slack notification — doing these 5 steps manually every time was inefficient.

By building an automation pipeline, I **reduced manual work from 5 steps to 0 per issue**. I'm tracking 117 issues without missing a single one.

![Linear Board](/uploads/project/Tymee/retrospective/linear-board.png)

> Introduction post: [Tymee Introduction](/blog/project/tymee/tymee-introduction)

### Mobile OAuth + JWT + Redis Authentication System

Web and mobile authentication work differently. Web relies on HttpOnly Cookie + XSS defense, but mobile apps have no cookie concept and XSS is impossible. Instead, **multi-device support** is essential.

I implemented OAuth verification for Google (library), Apple (direct public key fetch + caching), and Kakao (REST API), with **Refresh Token Rotation** for token theft detection and independent sessions per `deviceId` for selective per-device logout.

> Detailed analysis: [Mobile JWT Authentication](/blog/project/tymee/mobile-jwt-auth)

### Code Quality Automation Pipeline

SonarQube charges for private repos and requires 3GB+ RAM servers. I assembled individual tools to build a fully free pipeline:
- **Spotless**: Google Java Format auto-formatting
- **Checkstyle**: Naming/import/block rule checking
- **SpotBugs**: Bytecode analysis to detect NPE, resource leaks
- **JaCoCo**: Line coverage 60% / Branch coverage 70% thresholds

![CI Alerts](/uploads/project/Tymee/retrospective/ci-alerts.png)

> Detailed analysis: [Code Quality Management](/blog/project/tymee/code-quality-management)

---

## Memorable Troubleshooting

### Spring Boot 4 API Versioning + Swagger Conflict

Enabling the newly introduced API Versioning in Spring Boot 4 caused `InvalidApiVersionException` when accessing Swagger. Being a new feature, references were scarce. I dug through springdoc's GitHub issues and resolved it with a **whitelist-based ApiVersionResolver**.

> Detailed analysis: [Spring Boot 4 API Versioning + Swagger Conflict](/blog/project/tymee/spring-boot4-api-versioning)

### Issue Tracking Gaps

Initially, I used only GitHub Issues, but merging PRs didn't automatically update issue status — completed tasks remained in Open state. I couldn't gauge actual progress across 117 issues. Switching to Linear's GitHub Integration solved this.

![GitHub PR-Based Workflow](/uploads/project/Tymee/retrospective/github_pr.png)

---

## Current Progress and Takeaways

API design is complete. I'm implementing React Native UI while developing the Spring Boot backend.

### Automation Starts from "Annoyance"

Two weeks into solo development, I found myself searching "Did I already build this feature?" three times. The initial setup took 2 hours, but it now **saves me 10 minutes every day**. I've built a habit of automating immediately when I spot something that will be annoying later.

### Code for Real Users

The biggest difference between team and personal projects is that **every decision is entirely my own responsibility**. From architecture choices to UI design, I need to be able to explain why I made each choice to myself. I feel this experience is building my technical judgment.

> Architecture selection process: [Tymee Architecture Selection](/blog/project/tymee/tymee-architecture-selection)

---
title: 'IT Oasis 기술 블로그를 만들다'
titleEn: 'Building the IT Oasis Tech Blog'
description: Astro 기반 정적 블로그를 직접 설계하고 구축한 과정을 정리한다. TinaCMS 연동, i18n, 카테고리 시스템, 다크모드 등 주요 기술 결정을 다룬다.
descriptionEn: A summary of designing and building a static blog with Astro. Covers key technical decisions including TinaCMS integration, i18n, category system, and dark mode.
date: 2026-02-18T00:00:00.000Z
tags:
  - Astro
  - TinaCMS
  - Static Site
  - i18n
  - Blog
category: project/IT Oasis
draft: false
---

## 왜 직접 만들었나

기존 블로그 플랫폼(Velog, Medium, Tistory)을 쓰다가 한계를 느꼈다. 카테고리 구조를 내 맘대로 잡고 싶었고, 한/영 전환도 지원하고 싶었다. 결국 직접 만드는 게 가장 빠르다는 결론에 도달했다.

## 기술 스택 선택

### Astro

정적 사이트 생성기 중 Astro를 선택한 이유는 간단하다.

- **Zero JS by default** — 블로그에 무거운 런타임이 필요 없다
- **Island Architecture** — 필요한 부분에만 인터랙티브 컴포넌트를 넣을 수 있다
- **Content Collections** — 마크다운 기반 글 관리가 깔끔하다

### TinaCMS

마크다운을 직접 수정해도 되지만, 비주얼 에디터가 있으면 글쓰기에 집중할 수 있다. TinaCMS는 Git 기반이라 별도 DB 없이 동작하고, 로컬/클라우드 모두 지원한다.

### 배포

Vercel로 배포한다. Push만 하면 자동 빌드/배포되니 신경 쓸 게 없다.

## 주요 기능

### 카테고리 시스템

2단계 계층 구조를 지원한다. `프로젝트/IndiBalancing`처럼 부모/자식 형태로 분류하고, 사이드바에서 펼쳐볼 수 있다. 카테고리별 아이콘, 순서, 한/영 이름을 JSON으로 관리하며 TinaCMS에서 편집 가능하다.

### 한/영 전환 (i18n)

글로벌 토글 하나로 전체 UI와 본문을 전환한다. 세 가지 패턴을 사용한다:

1. `data-ko` / `data-en` 속성 — 짧은 텍스트
2. `.lang-ko` / `.lang-en` CSS 클래스 — 블록 단위
3. `<!-- EN -->` 구분자 — 본문 영역

### 다크모드

시스템 설정을 따르되, 수동 전환도 가능하다. `localStorage`에 선호값을 저장하고, 페이지 로드 시 FOUC(Flash of Unstyled Content) 없이 즉시 적용된다.

### 글래스모피즘 UI

전체적으로 글래스모피즘 디자인을 적용했다. `backdrop-filter: blur()`와 반투명 배경으로 가벼우면서 정돈된 느낌을 준다.

### 목차 (TOC)

데스크톱에서는 오른쪽 플로팅 TOC가 표시된다. IntersectionObserver로 현재 읽는 섹션을 하이라이트하고, 프로그레스바로 진행률을 보여준다. 목차가 길면 자체 스크롤이 작동한다.

## 마무리

직접 만든 블로그라 자유롭게 기능을 붙일 수 있는 게 가장 큰 장점이다. 앞으로도 필요한 기능이 생기면 바로 추가할 계획이다.

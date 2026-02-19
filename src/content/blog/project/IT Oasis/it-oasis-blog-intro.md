---
title: 'IT Oasis 기술 블로그를 만들다'
titleEn: 'Building the IT Oasis Tech Blog'
description: Astro 기반 정적 블로그를 직접 설계하고 구축한 과정을 정리했어요. TinaCMS 연동, i18n, 카테고리 시스템, 다크모드 등 주요 기술 결정을 다뤄요.
descriptionEn: A summary of designing and building a static blog with Astro. Covers key technical decisions including TinaCMS integration, i18n, category system, and dark mode.
date: 2026-02-18T00:00:00.000Z
tags:
  - Astro
  - TinaCMS
  - Static Site
  - i18n
  - Blog
category: project/IT Oasis
coverImage: /uploads/project/IT-Oasis/it-oasis-blog-intro/blog-homepage.png
draft: false
---

## 왜 직접 만들었나

예전에 Velog를 쓰면서 블로그를 운영했었는데, 쓰다 보니 아쉬운 점들이 하나둘 생기더라고요.
카테고리 구조를 제 입맛에 맞게 잡고 싶었고, 한영 전환도 넣고 싶었는데 기존 플랫폼에서는 그게 쉽지 않았어요.
이것저것 찾아보다가 결국 "그냥 내가 직접 만드는 게 제일 빠르겠다"는 결론에 도달했어요.

## 기술 스택 선택

### Astro

정적 사이트 생성기를 여러 개 비교해봤는데, Astro가 딱이었어요.

- **Zero JS by default** — 블로그에 무거운 런타임은 필요 없잖아요.
JS 번들 걱정 없이 순수한 HTML로 떨어지는 게 마음에 들었어요.
- **Island Architecture** — 필요한 곳에만 인터랙티브 컴포넌트를 얹을 수 있어서 유연해요.
검색이나 다크모드 토글 같은 부분에만 JS를 쓸 수 있어요.
- **Content Collections** — 마크다운 기반 글 관리가 깔끔해요.
프론트매터 타입 체크까지 해주니까 오타 같은 실수도 잡아줘서 좋아요.

### TinaCMS

마크다운을 직접 수정해도 되긴 하지만, 비주얼 에디터가 있으면 글쓰기에 훨씬 집중할 수 있거든요.
TinaCMS는 Git 기반이라 별도 DB 없이도 동작하고, 로컬에서든 클라우드에서든 모두 쓸 수 있어서 선택했어요.
무엇보다 마크다운 파일 자체를 수정하는 구조라 락인 걱정이 없다는 게 결정적이었어요.

### 배포

배포는 Vercel을 쓰고 있어요.
Push만 하면 자동으로 빌드/배포가 되니까, 이 부분은 딱히 신경 쓸 게 없어요.
정적 사이트라 CDN 캐싱도 잘 되고 응답 속도도 빠릅니다.

## 주요 기능

### 카테고리 시스템

2단계 계층 구조를 지원해요.
`프로젝트/IndiBalancing`처럼 부모/자식 형태로 분류할 수 있고, 사이드바에서 펼쳐서 볼 수 있어요.
카테고리별 아이콘, 정렬 순서, 한/영 이름은 JSON으로 관리하고 있어서 TinaCMS에서도 편집이 가능해요.

### 한/영 전환 (i18n)

글로벌 토글 하나로 전체 UI와 본문을 한 번에 전환할 수 있어요.
내부적으로는 세 가지 패턴을 섞어 쓰고 있어요.

1. `data-ko` / `data-en` 속성 — 버튼이나 레이블 같은 짧은 텍스트에 사용해요.
2. `.lang-ko` / `.lang-en` CSS 클래스 — 블록 단위로 통째로 바꿀 때 씁니다.
3. `<!-- EN -->` 구분자 — 본문 영역에서 한글과 영문 버전을 나눠요.

처음엔 좀 복잡해 보였는데, 쓰다 보니 각각 역할이 달라서 나름 합리적인 구성이 됐어요.

### 다크모드

시스템 설정을 기본으로 따르되, 수동 전환도 가능해요.
`localStorage`에 사용자 선호값을 저장해두고, 페이지 로드 시 깜빡임(FOUC) 없이 바로 적용되게 처리했어요.

### 글래스모피즘 UI

전체적으로 글래스모피즘 디자인을 적용해봤어요.
`backdrop-filter: blur()`와 반투명 배경을 조합해서, 가벼우면서도 정돈된 느낌을 줄 수 있었어요.
개인적으로 이 스타일이 블로그 분위기에 잘 어울린다고 생각해요.

### 목차 (TOC)

데스크톱에서는 오른쪽에 플로팅 목차가 표시돼요.
IntersectionObserver로 현재 읽고 있는 섹션을 하이라이트해주고, 프로그레스바로 전체 진행률도 보여줘요.
목차가 길어지면 자체 스크롤이 작동하도록 만들었어요.

## 마무리

직접 만든 블로그라 이것저것 자유롭게 기능을 붙일 수 있는 게 가장 큰 장점이에요.
앞으로도 필요한 기능이 생기면 바로 추가할 생각이에요.
이 블로그의 코드는 GitHub에 공개되어 있으니, 궁금하신 분은 편하게 둘러보셔도 돼요.

<!-- EN -->

## Why I Built It From Scratch

I used to run a blog on Velog, but over time I started running into limitations.
I wanted to organize categories exactly the way I liked, and I also wanted Korean/English toggle support — but that wasn't easy to pull off on existing platforms.
After looking into various options, I ended up concluding that just building it myself would be the fastest route.

## Choosing the Tech Stack

### Astro

I compared several static site generators, and Astro was a perfect fit.

- **Zero JS by default** — A blog doesn't need a heavy runtime, right?
I liked that it outputs pure HTML without worrying about JS bundles.
- **Island Architecture** — It's flexible because you can add interactive components only where you need them.
I can use JS just for things like search and dark mode toggle.
- **Content Collections** — Managing markdown-based posts is really clean.
It even type-checks frontmatter, which is great for catching typos and mistakes.

### TinaCMS

You could just edit markdown files directly, but having a visual editor makes it so much easier to focus on writing.
I chose TinaCMS because it's Git-based, works without a separate database, and supports both local and cloud usage.
The deciding factor was that it edits the markdown files themselves, so there's no lock-in concern.

### Deployment

I'm using Vercel for deployment.
Just push and it automatically builds and deploys — nothing to worry about on this front.
Since it's a static site, CDN caching works well and response times are fast.

## Key Features

### Category System

It supports a two-level hierarchy.
You can classify posts in a parent/child format like `Project/IndiBalancing`, and expand them in the sidebar.
Category icons, sort order, and Korean/English names are managed in JSON, so they're editable from TinaCMS as well.

### Korean/English Toggle (i18n)

A single global toggle switches the entire UI and content at once.
Under the hood, I'm using a mix of three patterns:

1. `data-ko` / `data-en` attributes — For short text like buttons and labels.
2. `.lang-ko` / `.lang-en` CSS classes — For swapping entire blocks at once.
3. `<!-- EN -->` separator — Splits Korean and English versions in the body content.

It seemed a bit complex at first, but since each pattern serves a different role, it turned out to be a pretty reasonable setup.

### Dark Mode

It follows the system setting by default, but manual switching is also available.
User preferences are saved in `localStorage`, and it applies instantly on page load without any flash (FOUC).

### Glassmorphism UI

I applied glassmorphism design throughout the blog.
By combining `backdrop-filter: blur()` with semi-transparent backgrounds, I was able to achieve a light yet polished look.
Personally, I think this style fits the blog's vibe quite well.

### Table of Contents (TOC)

On desktop, a floating TOC appears on the right side.
It highlights the section you're currently reading using IntersectionObserver, and shows overall reading progress with a progress bar.
When the TOC gets long, it scrolls independently.

## Wrapping Up

The biggest advantage of building my own blog is the freedom to add whatever features I want.
I plan to keep adding new features whenever the need arises.
The source code for this blog is public on GitHub, so feel free to take a look if you're curious.

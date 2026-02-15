---
title: "Astro로 GitHub 블로그 만들기"
description: "Astro 프레임워크를 사용해 나만의 GitHub Pages 블로그를 세팅하는 과정을 정리합니다."
date: 2026-02-14
tags: ["Astro", "GitHub Pages", "튜토리얼"]
category: "개발/Frontend"
coverImage: "/blog/cover-astro-blog.jpg"
---

## 왜 Astro인가?

정적 블로그를 만들 때 Astro를 선택한 이유:

1. **제로 JS** — 기본적으로 JavaScript를 전혀 보내지 않음
2. **빠른 빌드** — Vite 기반으로 빌드 속도가 빠름
3. **자유로운 커스텀** — React, Vue, Svelte 컴포넌트를 혼용 가능
4. **Markdown 지원** — Content Collections로 타입 안전한 콘텐츠 관리

## 프로젝트 구조

```
src/
├── components/    # 재사용 컴포넌트
├── content/blog/  # 마크다운 블로그 글
├── layouts/       # 페이지 레이아웃
├── pages/         # 라우팅 페이지
└── styles/        # 글로벌 스타일
```

## 시작하기

```bash
npm create astro@latest -- --template minimal
npx astro add tailwind
```

이렇게 간단하게 시작할 수 있습니다.

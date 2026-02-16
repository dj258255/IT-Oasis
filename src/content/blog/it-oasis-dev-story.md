---
title: "IT Oasis 블로그 개발기"
description: "Astro + Tailwind CSS + TinaCMS로 나만의 기술 블로그를 처음부터 만든 과정을 정리합니다."
date: 2026-02-15
tags: ["Astro", "Tailwind CSS", "TypeScript", "TinaCMS"]
category: "프로젝트/IT Oasis"
coverImage: "/projects/it-oasis.jpg"
---

## 왜 직접 만들었나

기존 블로그 플랫폼(Velog, Tistory 등)을 쓰다가 결국 직접 만들기로 했습니다. 이유는 단순합니다:

- **디자인 자유도** — 원하는 대로 UI를 만들고 싶었음
- **기술 스택 학습** — Astro, Tailwind CSS 등을 실전에서 배우고 싶었음
- **완전한 소유권** — 내 콘텐츠를 내 저장소에서 관리하고 싶었음

## 기술 스택

| 기술 | 역할 |
|------|------|
| **Astro 5** | 정적 사이트 생성 (SSG) |
| **Tailwind CSS** | 유틸리티 기반 스타일링 |
| **TypeScript** | 타입 안전한 개발 |
| **TinaCMS** | Git 기반 콘텐츠 관리 |
| **GitHub Pages** | 무료 호스팅 |

## 주요 기능

### Liquid Glass 디자인

Apple의 Liquid Glass에서 영감을 받아, `backdrop-filter: blur()`와 반투명 배경을 활용한 유리 질감 카드 디자인을 구현했습니다.

```css
.glass-card {
  background: rgba(255, 255, 255, 0.6);
  backdrop-filter: blur(20px);
  border: 1px solid rgba(255, 255, 255, 0.3);
}
```

### 다크모드

시스템 설정에 따라 자동 전환되고, 수동으로도 토글할 수 있습니다. `<html>` 태그에 `dark` 클래스를 추가하는 방식으로 Tailwind의 `dark:` 접두사와 연동됩니다.

### 한/영 전환

`data-ko`, `data-en` 속성과 `.lang-ko`, `.lang-en` CSS 클래스를 활용한 클라이언트 사이드 번역 시스템을 직접 구현했습니다. 페이지 새로고침 없이 즉시 전환됩니다.

### TinaCMS 어드민

마크다운 파일을 직접 편집하지 않아도 웹 UI에서 글을 작성하고, 사이트 설정을 변경할 수 있습니다.

## 배운 점

- Astro의 Island Architecture 덕분에 거의 제로 JS로 빠른 블로그를 만들 수 있었습니다
- CSS-only View Transitions으로 페이지 전환 애니메이션을 구현하면 JS 번들 없이도 부드러운 네비게이션이 가능합니다
- TinaCMS는 Git 기반이라 별도 DB 없이 콘텐츠 관리가 가능해서 정적 사이트와 궁합이 좋습니다

<!-- EN -->

## Why Build From Scratch

After using platforms like Velog and Tistory, I decided to build my own blog. The reasons were simple:

- **Design freedom** — I wanted full control over the UI
- **Learning** — Hands-on experience with Astro, Tailwind CSS, etc.
- **Ownership** — My content in my own repository

## Tech Stack

| Tech | Role |
|------|------|
| **Astro 5** | Static Site Generation (SSG) |
| **Tailwind CSS** | Utility-first styling |
| **TypeScript** | Type-safe development |
| **TinaCMS** | Git-based content management |
| **GitHub Pages** | Free hosting |

## Key Features

### Liquid Glass Design

Inspired by Apple's Liquid Glass, I implemented a glass-texture card design using `backdrop-filter: blur()` and translucent backgrounds.

```css
.glass-card {
  background: rgba(255, 255, 255, 0.6);
  backdrop-filter: blur(20px);
  border: 1px solid rgba(255, 255, 255, 0.3);
}
```

### Dark Mode

Auto-switches based on system settings with manual toggle support. Uses Tailwind's `dark:` prefix via a `dark` class on `<html>`.

### KO/EN Toggle

A custom client-side translation system using `data-ko`/`data-en` attributes and `.lang-ko`/`.lang-en` CSS classes. Switches instantly without page reload.

### TinaCMS Admin

Write posts and manage site settings through a web UI without editing markdown files directly.

## Lessons Learned

- Astro's Island Architecture enables near-zero JS for a fast blog
- CSS-only View Transitions provide smooth navigation without JS bundles
- TinaCMS works great with static sites since it's Git-based with no separate DB needed

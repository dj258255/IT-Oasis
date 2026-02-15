---
title: "Tailwind CSS 실전 팁 5가지"
description: "프로젝트에서 바로 적용할 수 있는 Tailwind CSS 실전 팁과 패턴을 정리합니다."
date: 2026-02-13
tags: ["Tailwind CSS", "CSS", "튜토리얼"]
category: "개발/Frontend"
---

## 1. 커스텀 유틸리티 클래스

Tailwind의 `@apply`를 활용하면 반복되는 스타일을 깔끔하게 관리할 수 있습니다.

```css
.btn-primary {
  @apply px-4 py-2 rounded-lg bg-blue-500 text-white hover:bg-blue-600 transition-colors;
}
```

## 2. 반응형 디자인 전략

모바일 퍼스트로 작성하고, `sm:`, `md:`, `lg:` 접두사를 활용합니다.

```html
<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
  <!-- cards -->
</div>
```

## 3. 다크 모드 처리

`dark:` variant를 활용하면 다크 모드를 쉽게 구현할 수 있습니다.

## 4. 애니메이션

Tailwind의 내장 애니메이션과 커스텀 키프레임을 조합하세요.

## 5. 컨테이너 쿼리

`@container`를 활용한 컴포넌트 기반 반응형 디자인이 트렌드입니다.

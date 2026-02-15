---
title: "알아두면 좋은 JavaScript 패턴"
description: "실무에서 자주 쓰이는 JavaScript 디자인 패턴과 모던 문법 활용법을 소개합니다."
date: 2026-02-12
tags: ["JavaScript", "패턴"]
category: "개발/JavaScript"
---

## 옵셔널 체이닝과 널 병합

```javascript
const name = user?.profile?.name ?? 'Anonymous';
```

## 구조 분해 할당 활용

```javascript
const { data, error, isLoading } = useFetch('/api/users');
```

## Promise.allSettled

여러 비동기 작업을 병렬로 처리할 때 유용합니다.

```javascript
const results = await Promise.allSettled([
  fetchUsers(),
  fetchPosts(),
  fetchComments(),
]);
```

> 모던 JavaScript의 핵심은 가독성과 안전성입니다.

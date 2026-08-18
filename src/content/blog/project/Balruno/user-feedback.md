---
title: '첫 사용자 피드백으로 24개 항목 개선'
description: 실제 사용자 피드백을 바탕으로 입력값 손실 버그, 드래그 성능, ESC 처리, 키보드 네비게이션 등 24개 항목을 개선한 과정을 정리했습니다.
date: 2026-01-28T00:00:00.000Z
tags:
  - User Feedback
  - Bug Fix
  - UX
  - Performance
  - React
  - Spreadsheet
  - Accessibility
category: personal/Balruno
coverImage: "/uploads/project/Balruno/user-feedback/cover.svg"
draft: false
series: "Balruno"
---

## 프로젝트 개요

게임 기획자를 위한 밸런싱 스프레드시트 웹 앱입니다. 실제 사용자 피드백을 받아 24개 항목을 개선했습니다.

---

## 깊이 판 것 셋

24개 중 원인까지 파고든 건 셋이었습니다. 나머지는 원인이 분명해서 고치는 데 오래 걸리지 않았습니다.

### 입력값이 잘려서 저장되던 버그

React 스프레드시트에서 "12345"를 입력하고 다른 셀을 클릭하면 "12"만 저장됐습니다. 입력 데이터가 유실되니 작업 자체를 믿을 수 없게 되는 문제였습니다.

원인은 stale closure였습니다. `onBlur` 핸들러가 이전 렌더링 시점에 캡처된 상태를 참조하고 있었습니다.

```javascript
// 문제 코드: localValue가 stale closure
const handleBlur = () => {
  saveCell(localValue); // localValue는 이전 렌더링 시점의 값
};
```

`useCallback` 안의 상태 참조는 의존성 배열이 갱신될 때만 새로 잡힙니다. 빠르게 타이핑하면 상태 업데이트보다 blur 이벤트가 먼저 도착해서 과거 값을 읽습니다.

```javascript
const localValueRef = useRef(localValue);
localValueRef.current = localValue; // 매 렌더링마다 동기화

const handleBlur = useCallback(() => {
  saveCell(localValueRef.current); // ref는 항상 최신값
}, []);
```

ref는 렌더링과 무관하게 항상 최신값을 들고 있어서 이 문제가 사라집니다. 같은 패턴을 수식 바와 메모 입력 등 5개 컴포넌트에 적용했습니다.

### 드래그 선택이 버벅이던 문제

100행 20열에서 마우스로 드래그하면 0.5초쯤 UI가 밀리면서 선택 박스가 커서를 못 따라왔습니다. mousemove가 초당 60~120회 발생하는데 매번 setState를 호출해 2000개 셀이 전부 리렌더링되고 있었습니다.

requestAnimationFrame throttle과 DOM 직접 조작, 좌표 캐싱으로 프레임 처리 시간을 45ms에서 3ms로 줄였습니다. 원인 분석과 O(N)에서 O(1)로 바꾼 자료구조 변경까지는 [테이블 입력 UX 기술 디테일](/blog/project/balruno/table-input-ux)에 따로 적었습니다.

### 모달마다 ESC 동작이 달랐던 문제

15개 모달 중 일부만 ESC로 닫히고 나머지는 안 먹혔습니다. 재사용 가능한 훅으로 뽑아 통일했습니다.

```javascript
export function useEscapeKey(onClose: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose, enabled]);
}
```

---

## 나머지 21개

### 테이블 조작

셀과 셀 사이 1px 경계선을 클릭하면 아무것도 선택되지 않던 문제는 `box-sizing: border-box`로 잡고, 그 경계에 열 너비 리사이즈 핸들도 같이 붙였습니다. 헤더 경계를 드래그하면 크기가 바뀌고 더블클릭하면 내용에 맞게 자동 조절됩니다.

테이블 바깥에서 드래그를 시작해도 선택이 되도록 컨테이너 전체에 mousedown을 걸었고, 반대로 테이블 밖을 클릭하면 선택이 풀리도록 document mousedown으로 처리했습니다. 행 번호를 클릭하면 행 전체가, Ctrl이나 Shift와 함께 열 헤더를 클릭하면 열 전체가 선택됩니다. 선택 영역은 TSV로 복사해서 Excel이나 Google Sheets와 양방향으로 오갑니다.

`<label>` 안에 `<button>`이 있어서 클릭이 두 번 발생하던 체크박스는 div 단일 요소로 바꿔서 해결했습니다.

### 편집 경험

Zustand 기반 히스토리 스토어로 Ctrl+Z와 Ctrl+Y를 최대 50단계까지 지원합니다. 키보드 네비게이션은 편집 모드 여부로 분기해서, 편집 중에는 Enter가 저장이고 Escape가 취소이며 선택 모드에서는 화살표로 셀을 옮깁니다. 수식을 입력하면 파싱해서 참조 셀을 색상별로 하이라이트합니다. 저장은 Zustand persist로 자동 처리하고 헤더에 상태를 띄웁니다.

### 보기와 일관성

기본 폰트를 12px에서 14px로, 행 높이를 36px로 올려 숫자 가독성을 높였습니다. 선택 색상은 테마별로 CSS 변수를 나눠 대비를 맞췄습니다.

```css
:root {
  --selection-bg: rgba(59, 130, 246, 0.15);
  --selection-border: rgba(59, 130, 246, 0.8);
}

[data-theme="dark"] {
  --selection-bg: rgba(96, 165, 250, 0.2);
  --selection-border: rgba(96, 165, 250, 0.9);
}
```

공통 패널 레이아웃 컴포넌트를 도입해 모든 도구 패널의 헤더 높이와 패딩, 버튼 위치를 맞췄습니다. `window.confirm()` 12개소는 디자인 시스템과 일관된 ConfirmDialog로 교체하면서 `role="alertdialog"`와 `aria-modal="true"`도 넣었습니다. 파비콘은 시스템 테마를 따라 자동으로 바뀝니다.

```html
<link rel="icon" href="/favicon-light.svg" media="(prefers-color-scheme: light)">
<link rel="icon" href="/favicon-dark.svg" media="(prefers-color-scheme: dark)">
```

### 도구 목록과 스크롤

도구를 드래그해 옮길 때 주변 아이템이 갑자기 튀지 않고 macOS Dock처럼 밀려나게 했습니다.

```javascript
const getItemTransform = (index, draggedIndex, dropTargetIndex) => {
  if (draggedIndex < dropTargetIndex) {
    if (index > draggedIndex && index < dropTargetIndex) return -52;
  } else if (draggedIndex > dropTargetIndex) {
    if (index < draggedIndex && index >= dropTargetIndex) return 52;
  }
  return 0;
};
```

드래그 중 휴지통 영역이 나타나고 거기 떨구면 도구가 숨겨집니다. 각 도구에는 `helpUrl`을 붙여 도움말 버튼이 해당 가이드 섹션으로 바로 가게 했고, 스크롤바 트랙을 클릭하면 그 위치로 즉시 점프합니다.

---

## 개선 요약

| 분류 | 항목 수 | 주요 내용 |
|------|--------|----------|
| 버그 수정 | 7개 | 입력값 손실, 체크박스 토글, 선택 해제, 키보드 네비게이션 등 |
| 성능 최적화 | 3개 | RAF 기반 드래그, DOM 직접 조작, 범위 캐싱 |
| UI 개선 | 6개 | 폰트 크기, 색상 대비, 레이아웃 정렬, 파비콘 등 |
| UX 개선 | 8개 | ESC 닫기, 도움말 연동, 스크롤, Undo/Redo, 자동 저장 등 |
| 신규 기능 | 6개 | 외부 드래그, 리사이즈, 드래그 삭제, 수식 하이라이트 등 |

---

## 기술 스택

- **Frontend**: Next.js 16, React 19, TypeScript
- **상태 관리**: Zustand (persist middleware로 localStorage 동기화)
- **스타일링**: Tailwind CSS, CSS Variables (다크모드)
- **테이블**: TanStack Table v8
- **차트**: Recharts
- **성능 최적화**: requestAnimationFrame, DOM 직접 조작, useRef 패턴

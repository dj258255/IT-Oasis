---
title: '첫 사용자 피드백으로 24개 항목 개선'
titleEn: '24 Improvements from First User Feedback'
description: 실제 사용자 피드백을 바탕으로 입력값 손실 버그, 드래그 성능, ESC 처리, 키보드 네비게이션 등 24개 항목을 개선한 과정을 정리한다.
descriptionEn: Documents 24 improvements including input loss bugs, drag performance, ESC handling, and keyboard navigation based on real user feedback.
date: 2026-01-28T00:00:00.000Z
tags:
  - User Feedback
  - Bug Fix
  - UX
  - Performance
  - React
  - Spreadsheet
  - Accessibility
category: project/IndiBalancing
draft: false
---

## 프로젝트 개요

게임 기획자를 위한 밸런싱 스프레드시트 웹 앱이다. 실제 사용자 피드백을 받아 24개 항목을 개선했다.

---

## 1. 입력값 손실 버그

### 문제 상황
**환경**: React 스프레드시트 컴포넌트에서 셀 편집 중
**현상**: 사용자가 "12345"를 입력한 뒤 다른 셀을 클릭하면 "12"만 저장됨
**문제점**: 사용자 입력 데이터가 유실되어 작업 신뢰성이 무너짐

### 원인 분석
**정상 동작**: input의 onBlur 이벤트에서 현재 입력값을 읽어 저장해야 함
**실제 동작**: onBlur 핸들러가 클로저에 캡처된 과거 상태값을 참조함

```javascript
// 문제 코드: localValue가 stale closure
const handleBlur = () => {
  saveCell(localValue); // localValue는 이전 렌더링 시점의 값
};
```

**근본 원인**: React의 함수형 컴포넌트에서 useCallback 내부의 상태 참조는 의존성 배열이 업데이트될 때만 갱신됨. 빠른 타이핑 중에는 상태 업데이트보다 blur 이벤트가 먼저 발생하여 과거 값을 참조함.

### 해결
```javascript
const localValueRef = useRef(localValue);
localValueRef.current = localValue; // 매 렌더링마다 동기화

const handleBlur = useCallback(() => {
  saveCell(localValueRef.current); // ref는 항상 최신값
}, []);
```

입력값이 100% 정확하게 저장됨. 동일 패턴을 수식 바, 메모 입력 등 5개 컴포넌트에 적용.

---

## 2. 드래그 선택 성능 저하

### 문제 상황
**환경**: 100행 x 20열 테이블에서 마우스 드래그로 다중 셀 선택 시
**현상**: 드래그 중 0.5초 정도 UI가 버벅이며 선택 박스가 마우스를 따라가지 못함

### 원인 분석
```
mousemove 이벤트 → setState(selectedCells) → React 재렌더링 → 2000개 셀 DOM 비교
```

mousemove는 초당 60~120회 발생하나, 매번 setState 호출로 전체 테이블 리렌더링. 2000개 셀의 선택 상태를 매 프레임 React가 비교/업데이트.

### 해결
1. **requestAnimationFrame 기반 throttle**: 마지막 마우스 위치만 처리
2. **DOM 직접 조작**: 드래그 중에는 React 상태 우회
3. **범위 캐싱**: 드래그 시작 시 열/행 좌표를 한 번만 계산

프레임 처리 시간: 45ms → 3ms (93% 감소). 1000행 테이블에서도 버벅임 없음.

---

## 3. 모달 ESC 닫기 불일치

### 문제 상황
15개 모달/다이얼로그 컴포넌트 중 일부만 ESC로 닫히고 나머지는 안 먹히는 불일치.

### 해결
재사용 가능한 커스텀 훅으로 추출:

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

15개 모달 모두 ESC 동작 통일.

---

## 4. 셀 경계 클릭 불가

### 문제
셀과 셀 사이 1px 경계선을 클릭하면 아무 셀도 선택되지 않음.

### 해결
```css
td {
  box-sizing: border-box; /* border를 요소 크기에 포함 */
  border: 1px solid #e5e7eb;
}
```

추가로 경계 영역에 열 너비 리사이즈 핸들도 추가.

---

## 5. macOS Dock 스타일 애니메이션

### 문제
도구를 드래그해서 옮길 때 목록 아이템들이 갑자기 위치가 바뀜.

### 해결
macOS Dock처럼 드래그 중 주변 아이템들이 자연스럽게 밀려나는 애니메이션 구현:

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

```css
.dock-item {
  transition: transform 0.25s cubic-bezier(0.25, 0.46, 0.45, 0.94);
}
```

---

## 6. 브라우저 기본 팝업 → 커스텀 디자인

`window.confirm()` 12개소를 앱 디자인 시스템과 일관된 ConfirmDialog 컴포넌트로 교체. `role="alertdialog"`, `aria-modal="true"` 등 접근성 고려.

---

## 7. 체크박스 토글 버그

### 원인
`<label>` 안에 `<button>`이 있어서 클릭 이벤트 두 번 발생 → 토글 두 번 실행 → 원래 상태로 복귀.

### 해결
label+button 구조를 div 단일 요소로 변경.

---

## 8. 외부에서 드래그 선택

테이블 바깥에서 드래그를 시작해도 선택 영역이 형성되도록 컨테이너 전체에 mousedown 이벤트 등록. 커서 위치의 셀을 즉시 선택, 드래그하면 박스 선택으로 확장.

---

## 9. 도움말 버튼과 패널 연동

각 도구에 `helpUrl` 속성 추가. 도움말 버튼 클릭 시 해당 도구의 가이드 섹션으로 바로 이동.

---

## 10. 스크롤 트랙 클릭 위치 이동

스크롤바 트랙 클릭 시 클릭한 위치로 즉시 점프하도록 개선:

```javascript
scrollbar.addEventListener('click', (e) => {
  const clickRatio = e.offsetX / scrollbar.offsetWidth;
  const scrollPosition = clickRatio * (container.scrollWidth - container.clientWidth);
  container.scrollLeft = scrollPosition;
});
```

---

## 11. 도구 드래그로 삭제 (휴지통)

드래그 중 휴지통 영역 표시, 드롭하면 도구 숨김. macOS Dock 스타일.

---

## 12. 열 너비 / 행 높이 리사이즈

헤더 경계에 리사이즈 핸들 추가. 드래그로 크기 조절, 더블클릭으로 내용에 맞게 자동 조절.

---

## 13. 폰트 크기 가독성

기본 폰트 크기 12px → 14px, 행 높이 36px로 조정. 숫자 가독성 향상.

---

## 14. 선택 색상 대비

CSS 변수로 테마별 선택 색상 정의:

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

---

## 15. 레이아웃 정렬 불일치

공통 패널 레이아웃 컴포넌트 도입으로 모든 도구 패널이 일관된 헤더 높이, 패딩, 버튼 위치를 가짐.

---

## 16. 행 번호 클릭으로 전체 행 선택

행 번호 클릭 시 해당 행 전체 선택, Shift+클릭으로 범위 선택 지원.

---

## 17. 열 헤더 클릭으로 전체 열 선택

Ctrl/Shift+클릭으로 열 전체 선택, 일반 클릭은 정렬 유지.

---

## 18. 선택 영역 복사 시 형식 유지

클립보드에 TSV 형식으로 복사하여 Excel, Google Sheets와 양방향 호환.

---

## 19. Undo/Redo 히스토리 관리

Zustand 기반 히스토리 스토어. Ctrl+Z 되돌리기, Ctrl+Y 다시 실행. 최대 50단계.

---

## 20. 키보드 네비게이션

편집 모드 여부에 따른 분기: 편집 중에는 Enter로 저장/Escape로 취소, 선택 모드에서는 화살표로 셀 이동.

---

## 21. 수식 입력 시 셀 참조 하이라이트

수식 파싱 후 참조 셀 추출, 색상별 하이라이트 표시.

---

## 22. 자동 저장 표시기

Zustand persist로 자동 저장 + 헤더에 실시간 저장 상태 표시.

---

## 23. 다크모드 파비콘

시스템 테마 감지하여 라이트/다크 파비콘 자동 전환:

```html
<link rel="icon" href="/favicon-light.svg" media="(prefers-color-scheme: light)">
<link rel="icon" href="/favicon-dark.svg" media="(prefers-color-scheme: dark)">
```

---

## 24. 셀 선택 해제 버그

테이블 외부 클릭 시 선택 해제되도록 document mousedown 이벤트로 처리.

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

<!-- EN -->

## Project Overview

A balancing spreadsheet web app for game designers. 24 items were improved based on real user feedback.

---

## 1. Input Value Loss Bug

### Problem
**Environment**: Editing cells in a React spreadsheet component
**Symptom**: User types "12345" then clicks another cell, only "12" is saved

### Root Cause
The onBlur handler referenced a stale closure value. React's useCallback only refreshes state references when the dependency array updates. During fast typing, the blur event fires before the state update, referencing old values.

### Solution
```javascript
const localValueRef = useRef(localValue);
localValueRef.current = localValue; // Sync every render

const handleBlur = useCallback(() => {
  saveCell(localValueRef.current); // ref always has latest value
}, []);
```

Input values now saved 100% accurately. Same pattern applied to 5 components.

---

## 2. Drag Selection Performance

### Problem
In a 100x20 table, UI stutters ~0.5s during drag, selection box can't keep up with mouse.

### Solution
1. **requestAnimationFrame-based throttle**: Process only last mouse position
2. **Direct DOM manipulation**: Bypass React state during drag
3. **Bounds caching**: Calculate row/column coordinates once at drag start

Frame processing: 45ms → 3ms (93% reduction). No stutter even with 1000-row tables.

---

## 3. Modal ESC Close Inconsistency

Extracted reusable `useEscapeKey` hook. All 15 modals now have unified ESC behavior.

---

## 4. Cell Border Click Issue

Clicking the 1px border between cells selected nothing. Fixed with `box-sizing: border-box`. Also added column resize handles at borders.

---

## 5. macOS Dock-Style Animation

Implemented smooth push-aside animation during drag-and-drop reordering, similar to macOS Dock behavior.

---

## 6. Browser Default Popups → Custom Design

Replaced 12 `window.confirm()` calls with design-system-consistent ConfirmDialog components with accessibility support.

---

## 7. Checkbox Toggle Bug

`<label>` containing `<button>` caused double click events → toggle fired twice → reverted to original state. Fixed by replacing with single `<div>` element.

---

## 8. Drag Selection from Outside Table

Registered mousedown event on entire container so drag selection can start from outside the table area.

---

## 9. Help Button and Panel Linking

Added `helpUrl` property to each tool. Help button click scrolls directly to that tool's guide section.

---

## 10. Scrollbar Track Click Navigation

Clicking scrollbar track now jumps directly to clicked position instead of page-by-page movement.

---

## 11. Drag-to-Delete Tools (Trash Zone)

Shows trash zone during drag, dropping there hides the tool. macOS Dock style.

---

## 12. Column Width / Row Height Resize

Added resize handles at header borders. Drag to resize, double-click to auto-fit content.

---

## 13. Font Size Readability

Default font size 12px → 14px, row height 36px. Improved number readability.

---

## 14. Selection Color Contrast

Defined theme-specific selection colors via CSS variables for both light and dark modes.

---

## 15. Layout Alignment Inconsistency

Introduced common panel layout component for consistent header height, padding, and button positions across all tool panels.

---

## 16. Row Number Click for Full Row Selection

Click row numbers to select entire rows, Shift+click for range selection.

---

## 17. Column Header Click for Full Column Selection

Ctrl/Shift+click for full column selection, normal click maintains sort behavior.

---

## 18. Copy Format Preservation

Copies to clipboard in TSV format for bidirectional compatibility with Excel and Google Sheets.

---

## 19. Undo/Redo History

Zustand-based history store. Ctrl+Z undo, Ctrl+Y redo. Up to 50 steps.

---

## 20. Keyboard Navigation

Branching based on edit mode: Enter to save/Escape to cancel during editing, arrow keys for cell movement in selection mode.

---

## 21. Formula Cell Reference Highlighting

Parses formulas to extract cell references, displays color-coded highlights.

---

## 22. Auto-Save Indicator

Auto-save via Zustand persist + real-time save status display in header.

---

## 23. Dark Mode Favicon

Auto-switches favicon based on system theme detection:

```html
<link rel="icon" href="/favicon-light.svg" media="(prefers-color-scheme: light)">
<link rel="icon" href="/favicon-dark.svg" media="(prefers-color-scheme: dark)">
```

---

## 24. Cell Deselection Bug

Fixed by handling document mousedown event to clear selection when clicking outside the table.

---

## Improvement Summary

| Category | Count | Key Items |
|----------|-------|-----------|
| Bug Fixes | 7 | Input loss, checkbox toggle, deselection, keyboard navigation |
| Performance | 3 | RAF-based drag, direct DOM manipulation, bounds caching |
| UI Improvements | 6 | Font size, color contrast, layout alignment, favicon |
| UX Improvements | 8 | ESC close, help linking, scroll, Undo/Redo, auto-save |
| New Features | 6 | External drag, resize, drag-delete, formula highlights |

---

## Tech Stack

- **Frontend**: Next.js 16, React 19, TypeScript
- **State Management**: Zustand (persist middleware for localStorage sync)
- **Styling**: Tailwind CSS, CSS Variables (dark mode)
- **Table**: TanStack Table v8
- **Charts**: Recharts
- **Performance**: requestAnimationFrame, direct DOM manipulation, useRef patterns

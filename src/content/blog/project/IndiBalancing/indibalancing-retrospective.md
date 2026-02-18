---
title: '인디밸런싱 - 게임 밸런싱 도구를 직접 만들다'
titleEn: 'IndiBalancing - Building a Game Balancing Tool from Scratch'
description: 게임 기획자를 위한 오픈소스 밸런싱 플랫폼 인디밸런싱의 개발 과정과 GDC/NDC 이론 학습 경험을 정리했습니다.
descriptionEn: A retrospective on building IndiBalancing, an open-source game balancing platform, including learnings from GDC/NDC theory.
date: 2026-02-15
tags:
  - Retrospective
  - React
  - TypeScript
  - Zustand
  - Game Design
category: project/IndiBalancing
coverImage: /uploads/project/IndiBalancing/retrospective/title.png
draft: false
---

## 프로젝트 소개

인디밸런싱은 **게임 기획자를 위한 오픈소스 밸런싱 플랫폼**입니다.

인디게임을 개발할 때 캐릭터 스탯, 무기 수치, 레벨 테이블 같은 밸런스 데이터를 엑셀로 관리하면 여러 불편함이 있습니다. 게임 특화 수식(DAMAGE, TTK, DPS 등)이 없고, 시트 간 연동이 번거롭고, JSON 내보내기도 수동입니다. 이 문제를 해결하는 웹 툴을 만들고 있습니다.

![인디밸런싱](/uploads/project/IndiBalancing/retrospective/title.png)

**기간**: 2025.01 - 진행 중
**형태**: 개인 프로젝트
**기술 스택**: React, TypeScript, Zustand, TailwindCSS, Vercel

---

## 이론 공부부터 시작

처음에는 "그냥 스프레드시트 만들면 되겠지"라고 생각했습니다. 하지만 어떤 기능이 필요한지, 어떤 수식이 표준인지 전혀 몰랐습니다.

GDC Vault, NDC 2018(넥슨), Zynga 공식 자료를 찾아보면서 게임 밸런싱 이론을 학습했습니다:
- **TTK 계산**(Time to Kill): 마지막 타격에는 쿨다운을 포함하지 않는다는 것
- **Faucet/Sink 모델**: Faucet(유입)이 Sink(소모)보다 작아야 인플레이션을 방지할 수 있다는 것
- **Flow 이론**: 난이도가 실력과 적절하게 맞아야 몰입 상태가 유지된다

> 시장 조사 상세: [게임 밸런스 도구 시장 조사](/blog/project/indibalancing/indie-balance-tool-market-research)

"만들면서 배우기"도 좋지만, **먼저 이론을 공부하면 시행착오를 줄일 수 있다**는 걸 이 과정에서 배웠습니다.

---

## 주요 구현

### 게임 특화 수식 23개

엑셀에는 `DAMAGE(atk, def)`, `SCALE(base, level, rate, type)`, `TTK(hp, damage, attackSpeed)` 같은 게임 특화 함수가 없습니다. 감소율 공식 DAMAGE, 4가지 성장 곡선(Linear/Exponential/Logarithmic/S-Curve) SCALE, 정확한 킬타임 TTK, 시트 간 참조 REF 등 **23개 함수**를 구현했습니다.

기획자가 `=DAMAGE(100, 50)`을 입력하면 즉시 `66.67`을 계산합니다.

### 밸런스 검증기

유닛 하나씩 수동으로 밸런스를 확인하면 시간도 오래 걸리고 누락이 생깁니다. 기준값(HP, ATK, DEF, 공속) 설정 후 역할별(탱커/딜러/서포터/밸런스) DPS/EHP 허용 범위를 정의하면, 유닛 추가 시 **자동으로 범위 이탈 여부를 표시**합니다.

> 기술 포스트: [게임 디자인 도구 소개](/blog/project/indibalancing/game-design-tool-intro) · [MVP 릴리즈](/blog/project/indibalancing/indibalancing-mvp-release)

---

## 기억에 남는 트러블슈팅

### 테이블 드래그 성능

셀이 많아지면 드래그가 버벅거리는 문제가 있었습니다. 가상화와 이벤트 최적화로 해결했습니다.

> 상세 분석: [테이블 드래그 성능 개선](/blog/project/indibalancing/table-drag-performance)

### IME 한글 입력 처리

한글 입력 시 조합 중인 글자가 중복 입력되는 문제가 발생했습니다. `compositionstart`/`compositionend` 이벤트로 IME 상태를 추적해서 해결했습니다.

> 상세 분석: [IME 입력 처리](/blog/project/indibalancing/ime-input-handling)

---

## 현재 진행 상황과 느낀 점

MVP를 배포한 상태이고, 계속 기능을 추가하고 있습니다. 개인 프로젝트라서 일정 압박은 없지만, **검증된 이론을 기반으로 설계하는 습관**은 이 프로젝트를 통해 확실히 갖추게 됐습니다.

팀 프로젝트에서는 경험하기 어려운 **처음부터 끝까지 모든 의사결정을 직접 하는 경험**이 기획-설계-구현-배포 전 과정에 대한 이해를 넓혀주고 있습니다.

<!-- EN -->

## About the Project

IndiBalancing is an **open-source balancing platform for game designers**.

When developing indie games, managing balance data like character stats, weapon values, and level tables in Excel comes with several pain points. There are no game-specific formulas (DAMAGE, TTK, DPS, etc.), cross-sheet references are cumbersome, and JSON export is manual. I'm building a web tool to solve these problems.

![IndiBalancing](/uploads/project/IndiBalancing/retrospective/title.png)

**Duration**: Jan 2025 – In Progress
**Type**: Personal Project
**Tech Stack**: React, TypeScript, Zustand, TailwindCSS, Vercel

---

## Starting with Theory

At first, I thought "I'll just build a spreadsheet." But I had no idea what features were needed or which formulas were standard.

I studied game balancing theory from GDC Vault, NDC 2018 (Nexon), and Zynga official materials:
- **TTK Calculation** (Time to Kill): The final hit shouldn't include cooldown
- **Faucet/Sink Model**: Faucets (income) must be smaller than Sinks (spending) to prevent inflation
- **Flow Theory**: Difficulty must match skill level to maintain a state of flow

> Market research details: [Game Balance Tool Market Research](/blog/project/indibalancing/indie-balance-tool-market-research)

"Learning by building" is great, but I learned from this process that **studying theory first can reduce trial and error**.

---

## Key Implementations

### 23 Game-Specific Formulas

Excel lacks game-specific functions like `DAMAGE(atk, def)`, `SCALE(base, level, rate, type)`, `TTK(hp, damage, attackSpeed)`. I implemented **23 functions** including the diminishing returns formula DAMAGE, 4 growth curves (Linear/Exponential/Logarithmic/S-Curve) SCALE, accurate kill-time TTK, and cross-sheet reference REF.

When a designer enters `=DAMAGE(100, 50)`, it instantly calculates `66.67`.

### Balance Validator

Manually checking balance for each unit is time-consuming and error-prone. After setting baseline values (HP, ATK, DEF, attack speed) and defining DPS/EHP tolerance ranges by role (Tank/DPS/Support/Balanced), the validator **automatically flags units that fall outside their expected range** when added.

> Technical posts: [Game Design Tool Introduction](/blog/project/indibalancing/game-design-tool-intro) · [MVP Release](/blog/project/indibalancing/indibalancing-mvp-release)

---

## Memorable Troubleshooting

### Table Drag Performance

As the number of cells grew, dragging became sluggish. I resolved it through virtualization and event optimization.

> Detailed analysis: [Table Drag Performance Improvement](/blog/project/indibalancing/table-drag-performance)

### IME Korean Input Handling

During Korean input, characters being composed would get duplicated. I tracked the IME state using `compositionstart`/`compositionend` events to resolve the issue.

> Detailed analysis: [IME Input Handling](/blog/project/indibalancing/ime-input-handling)

---

## Current Progress and Takeaways

The MVP is deployed, and I'm continuing to add features. There's no schedule pressure since it's a personal project, but I've definitely built the habit of **designing based on validated theory** through this project.

The experience of **making every decision from start to finish on my own** — something hard to get in team projects — is broadening my understanding of the entire pipeline from planning to design to implementation to deployment.

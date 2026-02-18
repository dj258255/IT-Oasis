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
category: 프로젝트/IndiBalancing
coverImage: /uploads/프로젝트/IndiBalancing/retrospective/title.png
draft: false
---

## 프로젝트 소개

인디밸런싱은 **게임 기획자를 위한 오픈소스 밸런싱 플랫폼**입니다.

인디게임을 개발할 때 캐릭터 스탯, 무기 수치, 레벨 테이블 같은 밸런스 데이터를 엑셀로 관리하면 여러 불편함이 있습니다. 게임 특화 수식(DAMAGE, TTK, DPS 등)이 없고, 시트 간 연동이 번거롭고, JSON 내보내기도 수동입니다. 이 문제를 해결하는 웹 툴을 만들고 있습니다.

![인디밸런싱](/uploads/프로젝트/IndiBalancing/retrospective/title.png)

**기간**: 2025.01 - 진행 중
**형태**: 개인 프로젝트
**기술 스택**: React, TypeScript, Zustand, TailwindCSS, Vercel

---

## 이론 공부부터 시작

처음에는 "그냥 스프레드시트 만들면 되겠지"라고 생각했습니다. 하지만 어떤 기능이 필요한지, 어떤 수식이 표준인지 전혀 몰랐습니다.

GDC Vault, NDC 2018(넥슨), Zynga 공식 자료를 찾아보면서 게임 밸런싱 이론을 학습했습니다:
- **TTK(Time to Kill) 계산**: 마지막 타격에는 쿨다운을 포함하지 않는다는 것
- **Faucet/Sink 모델**: Faucet(유입) < Sink(소모)가 인플레이션 방지의 핵심
- **Flow 이론**: 난이도가 실력과 적절하게 맞아야 몰입 상태가 유지된다

> 시장 조사 상세: [게임 밸런스 도구 시장 조사](/blog/프로젝트/IndiBalancing/indie-balance-tool-market-research)

"만들면서 배우기"도 좋지만, **먼저 이론을 공부하면 시행착오를 줄일 수 있다**는 걸 이 과정에서 배웠습니다.

---

## 주요 구현

### 게임 특화 수식 23개

엑셀에는 `DAMAGE(atk, def)`, `SCALE(base, level, rate, type)`, `TTK(hp, damage, attackSpeed)` 같은 게임 특화 함수가 없습니다. 감소율 공식 DAMAGE, 4가지 성장 곡선(Linear/Exponential/Logarithmic/S-Curve) SCALE, 정확한 킬타임 TTK, 시트 간 참조 REF 등 **23개 함수**를 구현했습니다.

기획자가 `=DAMAGE(100, 50)`을 입력하면 즉시 `66.67`을 계산합니다.

### 밸런스 검증기

유닛 하나씩 수동으로 밸런스를 확인하면 시간도 오래 걸리고 누락이 생깁니다. 기준값(HP, ATK, DEF, 공속) 설정 후 역할별(탱커/딜러/서포터/밸런스) DPS/EHP 허용 범위를 정의하면, 유닛 추가 시 **자동으로 범위 이탈 여부를 표시**합니다.

> 기술 포스트: [게임 디자인 도구 소개](/blog/프로젝트/IndiBalancing/game-design-tool-intro) · [MVP 릴리즈](/blog/프로젝트/IndiBalancing/indibalancing-mvp-release)

---

## 기억에 남는 트러블슈팅

### 테이블 드래그 성능

셀이 많아지면 드래그가 버벅거리는 문제가 있었습니다. 가상화와 이벤트 최적화로 해결했습니다.

> 상세 분석: [테이블 드래그 성능 개선](/blog/프로젝트/IndiBalancing/table-drag-performance)

### IME 한글 입력 처리

한글 입력 시 조합 중인 글자가 중복 입력되는 문제가 발생했습니다. `compositionstart`/`compositionend` 이벤트로 IME 상태를 추적해서 해결했습니다.

> 상세 분석: [IME 입력 처리](/blog/프로젝트/IndiBalancing/ime-input-handling)

---

## 현재 진행 상황과 느낀 점

MVP를 배포한 상태이고, 계속 기능을 추가하고 있습니다. 개인 프로젝트라서 일정 압박은 없지만, **검증된 이론을 기반으로 설계하는 습관**은 이 프로젝트를 통해 확실히 갖추게 됐습니다.

팀 프로젝트에서는 경험하기 어려운 **처음부터 끝까지 모든 의사결정을 직접 하는 경험**이 기획-설계-구현-배포 전 과정에 대한 이해를 넓혀주고 있습니다.

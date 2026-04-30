---
title: '발루노 — 만들면서 배우고, 지금도 다듬는 게임 밸런싱 도구'
titleEn: 'Balruno — A Game Balancing Tool I Am Still Iterating On'
description: 게임 기획자를 위한 오픈소스 밸런싱 플랫폼 발루노의 설계·구현·첫 사용자 반응에서 얻은 인사이트와, 그 피드백을 바탕으로 지금도 진행 중인 온보딩·UX·백엔드 개선 방향을 한 글에 정리했어요.
descriptionEn: How Balruno was designed and built, what early user feedback taught me, and the onboarding/UX/backend improvements that are currently in progress.
date: 2026-04-02
tags:
  - Retrospective
  - User Feedback
  - Product
  - React
  - TypeScript
  - Zustand
  - Game Design
  - Balruno
category: project/Balruno
coverImage: /uploads/project/Balruno/retrospective/title.png
draft: false
series: "Balruno"
---

## 프로젝트 소개

발루노는 **게임 기획자를 위한 오픈소스 밸런싱 플랫폼**이에요.

인디게임을 개발할 때 캐릭터 스탯, 무기 수치, 레벨 테이블 같은 밸런스 데이터를 엑셀로 관리하면 여러 불편함이 있어요. 게임 특화 수식(DAMAGE, TTK, DPS 등)이 없고, 시트 간 연동이 번거롭고, JSON 내보내기도 수동입니다. 이 문제를 해결하는 웹 툴을 만들고 있어요.

![발루노](/uploads/project/Balruno/retrospective/title.png)

- **기간**: 2025.01 — 진행 중
- **형태**: 개인 프로젝트
- **기술 스택**: React, TypeScript, Zustand, TailwindCSS, Vercel (백엔드 추가 진행 중)

---

## 이론부터 공부하고 시작하다

처음에는 *"그냥 스프레드시트 만들면 되겠지"* 라고 생각했어요. 하지만 어떤 기능이 필요한지, 어떤 수식이 표준인지 전혀 몰랐습니다.

GDC Vault, NDC 2018 밸런스 기획 세션, Zynga 공식 자료를 찾아보면서 게임 밸런싱 이론을 학습했어요:

- **TTK 계산**(Time to Kill): 마지막 타격에는 쿨다운을 포함하지 않는다는 것
- **Faucet/Sink 모델**: Faucet(유입)이 Sink(소모)를 초과하면 인플레이션이 발생하므로, 둘 사이의 균형을 유지해야 한다는 것
- **Flow 이론**: 난이도가 실력과 적절하게 맞아야 몰입 상태가 유지된다

> 시장 조사 상세: [게임 밸런스 도구 시장 조사](/blog/project/balruno/indie-balance-tool-market-research)

*"만들면서 배우기"* 도 좋지만, **먼저 이론을 공부하면 시행착오를 줄일 수 있다** 는 걸 이 과정에서 분명히 느꼈어요.

---

## 핵심 구현

### 게임 특화 수식 (70+)

엑셀에는 `DAMAGE(atk, def)`, `SCALE(base, level, rate, type)`, `TTK(hp, damage, attackSpeed)` 같은 게임 특화 함수가 없어요. 감소율 공식 DAMAGE, 4가지 성장 곡선(Linear/Exponential/Logarithmic/S-Curve) SCALE, 정확한 킬타임 TTK, 시트 간 참조 REF 등 핵심 함수 23개에서 시작해 현재 **70개 이상**으로 확장했어요.

기획자가 `=DAMAGE(100, 50)`을 입력하면 즉시 `66.67`을 계산합니다.

### 밸런스 검증기

유닛 하나씩 수동으로 밸런스를 확인하면 시간도 오래 걸리고 누락이 생겨요. 기준값(HP, ATK, DEF, 공속) 설정 후 역할별(탱커/딜러/서포터/밸런스) DPS/EHP 허용 범위를 정의하면, 유닛 추가 시 **자동으로 범위 이탈 여부를 표시** 합니다.

> 기술 포스트: [게임 디자인 도구 소개](/blog/project/balruno/game-design-tool-intro) · [MVP 릴리즈](/blog/project/balruno/balruno-mvp-release)

### 인터랙션 디테일

스프레드시트 UX의 체감은 결국 작은 인터랙션에서 결정돼요. Balruno도 셀 입력·드래그·IME 처리 같은 부분에서 여러 차례 다듬었어요.

> 기술 포스트: [테이블/입력 UX 기술 디테일](/blog/project/balruno/table-input-ux) (드래그 성능 + 셀 동기화 + IME 처리 통합)

---

## 첫 사용자 반응에서 얻은 인사이트

주변에서 인디게임 밸런싱을 하던 친구가 직접 써주면서 *"문제의식 자체가 틀린 건 아니다"* 는 신호는 분명히 받았어요. 적어도 누군가에게는 가치가 있는 도구라는 점은 확인했죠.

다만 외부에 더 알려보니 반응은 예상보다 신중했습니다. 관심을 보이는 사람은 있었지만 들어와서 끝까지 써보는 사람은 많지 않았어요. *"필요해 보인다"* 와 *"실제로 쓰게 된다"* 는 전혀 다른 문제라는 점을 이때 확실히 체감했습니다.

![](/uploads/project/Balruno/powerbalance-feedback.png)

가장 큰 인사이트는 **사용성 피드백** 이었어요. 방향성과 기능 자체는 흥미롭다는 평이 많았지만, 처음 켰을 때 무엇부터 해야 할지 막막하고 진입 장벽이 높다는 의견이 반복됐어요. 개발자 입장에서는 기능이 많을수록 좋다고 생각하기 쉽지만, **사용자는 처음 5분 안에 감이 오지 않으면 그대로 떠납니다**. 이 한 줄을 사용자 반응에서 직접 들으면서 다음 개선의 방향이 분명해졌어요.

돌이켜보면 사람들은 이미 각자 익숙한 작업 흐름이 있어요. 누군가는 엑셀을, 누군가는 구글 시트를, 누군가는 머릿속과 메모로도 충분히 작업합니다. 내가 보기엔 불편해 보여도, 그들에게는 이미 굴러가고 있는 흐름이 있어요. **그 흐름을 바꿀 만큼 명확한 이유** 를 처음 5분 안에 보여주는 것 — 이게 Balruno가 풀어야 할 진짜 과제예요.

---

## 지금도 진행 중인 개선

그래서 지금은 그 방향으로 다음 버전을 적극적으로 다듬고 있어요.

- **온보딩 재설계** — 처음 켜자마자 *"내가 무엇을 할 수 있는지"* 가 한눈에 보이도록, 빈 화면 대신 가벼운 샘플 시나리오와 가이드 흐름을 기본으로.
- **진입 장벽 낮추기** — 모든 기능을 한 번에 보여주지 않고, *처음 5분 안에 가치를 느끼는 경로* 를 우선.
- **백엔드 도입** — 지금까지는 클라이언트 중심 구조였지만, 협업·저장·시뮬레이션 결과 공유를 자연스럽게 하기 위해 **서버를 새로 붙이고 곧 배포** 합니다.
- **사용성 피드백 반영** — 친구와 초기 사용자에게서 받은 구체적인 피드백을 우선순위로 두고 인터랙션을 조정 중.

이 경험은 다른 프로젝트에서도 그대로 살아 있어요. [CodingTestKit](/blog/project/codingtestkit/codingtestkit-introduction)을 만들 때는 *"기능이 많은가"* 가 아니라 *"사람이 지금 당장 왜 이걸 써야 하는가"* 를 훨씬 더 의식했고, 처음 설치한 사람이 설명 없이도 바로 가치를 느낄 수 있는 지점을 우선 설계했어요. 그 방향성 위에서 나온 CodingTestKit은 다운로드 254회를 기록했고, **같은 원칙을 Balruno에도 그대로 적용해서 다시 다듬는 중** 이에요.

그래서 지금 시점에서 Balruno는 *"실패한 프로젝트"* 가 아니라, **첫 사용자 반응에서 다음 방향을 명확히 잡은 진행 중인 프로젝트** 입니다. 좋은 기능을 만드는 것과 사람들이 실제로 쓰는 도구를 만드는 것은 다르다는 — 그 차이를 직접 확인했고, 그 위에서 지금도 계속 만들어가고 있어요.

---

## 이 프로젝트를 통해 얻고 있는 것

팀 프로젝트에서는 경험하기 어려운 **처음부터 끝까지 모든 의사결정을 직접 하는 경험** 이 기획-설계-구현-배포 전 과정에 대한 이해를 넓혀주고 있어요. 그 위에 *"검증된 이론을 기반으로 설계하는 습관"* 과 *"사용자가 실제로 쓰기 시작하는 지점을 우선 설계하는 습관"* 이 함께 자리 잡아가는 중입니다.

<!-- EN -->

## About the Project

Balruno is an **open-source balancing platform for game designers**.

Managing indie-game balance data — character stats, weapon values, level tables — in Excel comes with several pain points. There are no game-specific formulas (DAMAGE, TTK, DPS), cross-sheet references are cumbersome, and JSON export is manual. I am building a web tool to solve these problems.

![Balruno](/uploads/project/Balruno/retrospective/title.png)

- **Duration**: Jan 2025 — In Progress
- **Type**: Personal project
- **Stack**: React, TypeScript, Zustand, TailwindCSS, Vercel (backend currently being added)

---

## Starting With Theory First

At first I thought *"I'll just build a spreadsheet."* But I had no idea what features were needed or which formulas were standard.

I studied game balancing theory from GDC Vault, NDC 2018 balance design sessions, and Zynga official materials:

- **TTK (Time to Kill)**: the final hit should not include cooldown
- **Faucet/Sink Model**: when Faucets (income) exceed Sinks (spending), inflation occurs — so the two must stay in equilibrium
- **Flow Theory**: difficulty must match skill to keep the user in flow

> Market research details: [Game Balance Tool Market Research](/blog/project/balruno/indie-balance-tool-market-research)

*"Learning by building"* is great, but this process made it clear that **studying theory first cuts down trial and error**.

---

## Key Implementations

### Game-Specific Formulas (70+)

Excel lacks game-specific functions like `DAMAGE(atk, def)`, `SCALE(base, level, rate, type)`, `TTK(hp, damage, attackSpeed)`. Starting with 23 core functions — diminishing-returns DAMAGE, 4 growth curves (Linear/Exponential/Logarithmic/S-Curve) SCALE, accurate kill-time TTK, cross-sheet reference REF — the library has expanded to **over 70 functions**.

When a designer enters `=DAMAGE(100, 50)`, it instantly returns `66.67`.

### Balance Validator

Manually checking balance per unit is slow and error-prone. After setting baseline values (HP, ATK, DEF, attack speed) and defining DPS/EHP tolerance ranges by role (Tank/DPS/Support/Balanced), the validator **automatically flags units that fall outside their expected range** when added.

> Technical posts: [Game Design Tool Introduction](/blog/project/balruno/game-design-tool-intro) · [MVP Release](/blog/project/balruno/balruno-mvp-release)

### Interaction Details

Spreadsheet UX is decided in tiny interactions. Balruno's cell input, drag, and IME handling went through several iterations.

> Technical post: [Table / Input UX engineering details](/blog/project/balruno/table-input-ux) (drag perf + cell sync + IME handling, consolidated)

---

## What Early User Feedback Taught Me

A friend who works on indie game balancing actually used it and gave the signal that *"the underlying problem is real."* That at least confirmed value for some users.

But once I showed it more broadly, the response was more cautious than I expected. People showed interest, but few stuck around to use it end to end. That is when I really felt the difference between *"this looks useful"* and *"I actually use this."*

![](/uploads/project/Balruno/powerbalance-feedback.png)

The most valuable insight was **usability feedback**. The direction and feature set were interesting, but multiple people said they did not know what to do first when they opened the app — the entry barrier felt too high. As a builder it is easy to assume more features means a better product, but **users leave within the first five minutes if the value is not obvious.** Hearing that directly made the next iteration's direction clear.

Looking back, everyone already has a workflow that works for them. Some use Excel, some use Google Sheets, some manage with notes and intuition. Even if those workflows look inefficient to me, they are running fine for the people using them. **Showing a clear reason to switch — within the first five minutes** — that is the real challenge Balruno needs to solve.

---

## What Is Currently Being Improved

That direction is exactly what I am actively working on for the next version.

- **Onboarding redesign** — instead of an empty canvas, the app starts with a lightweight sample scenario and a guided flow so users can see *"what I can do here"* at a glance.
- **Lower the entry barrier** — instead of exposing every feature at once, prioritize the path that *delivers value within the first five minutes*.
- **Backend introduction** — Balruno has been client-side so far; to make collaboration, persistence, and sharing simulation results feel natural, **a server is being added and will ship soon**.
- **Acting on real feedback** — the specific feedback from my friend and early users is the top input shaping ongoing interaction tweaks.

This experience continues to inform other projects. When I built [CodingTestKit](/blog/project/codingtestkit/codingtestkit-introduction), I focused much more on *"why would someone use this right now?"* rather than *"how many features can I add?"*, and made sure first-time users could feel the value without explanation. That direction got CodingTestKit to 254 downloads, and **I am applying the same principle back to Balruno as I iterate**.

So at this point, Balruno is not a *"failed project"* — it is **a project that locked in a clear next direction from the first round of user feedback, and is actively being improved**. Building good features and building something people actually use are not the same thing — I confirmed that difference firsthand, and I am still building on top of it.

---

## What This Project Keeps Giving Me

The experience of **making every decision from start to finish on my own** — something hard to get in team projects — is broadening my understanding of the entire pipeline from planning to design to implementation to deployment. On top of that, two habits are settling in: *"design from validated theory"* and *"design first for the moment a user actually starts using it."*

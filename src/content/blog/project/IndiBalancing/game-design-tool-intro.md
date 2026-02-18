---
title: '인디밸런싱 - 게임 밸런스 데이터 관리 툴'
titleEn: 'IndiBalancing - Game Balance Data Management Tool'
description: 인디게임 개발자를 위한 웹 기반 게임 밸런스 데이터 관리 툴의 기능, 수식 체계, 시뮬레이션, 게임 엔진 연동을 소개한다.
descriptionEn: Introduces the web-based game balance data management tool for indie developers, covering formulas, simulations, and game engine integration.
date: 2025-12-14T00:00:00.000Z
tags:
  - Game Balance
  - Spreadsheet
  - Monte Carlo
  - DPS
  - TTK
  - Unity
  - Godot
  - Unreal
category: project/IndiBalancing
draft: false
coverImage: "/uploads/project/IndiBalancing/game-design-tool-intro/image.png"
---

![](/uploads/project/IndiBalancing/game-design-tool-intro/image.png)
![](/uploads/project/IndiBalancing/game-design-tool-intro/image-2.png)

---

## 프로젝트 개요

인디밸런싱은 인디게임 개발자를 위한 웹 기반 게임 밸런스 데이터 관리 툴이다. 엑셀이나 구글 시트보다 게임 개발에 특화된 시트 시스템과 수식을 제공한다.

---

## 문제 인식

게임 밸런싱 작업에는 반복적으로 필요한 것들이 있다.

- DAMAGE, SCALE, TTK 같은 게임 공식을 쉽게 적용해야 한다
- 캐릭터 스탯 변경 시 관련 데이터가 자동으로 재계산되어야 한다
- 성장 곡선, 능력치 비교 등을 차트로 빠르게 확인해야 한다
- JSON, CSV 연동으로 게임 엔진에서 바로 쓸 수 있는 형태로 데이터를 추출할 수 있어야 한다

기존 도구(엑셀, 구글 시트)로도 가능하지만, 게임 특화 함수가 없어 매번 수식을 직접 작성하거나 VBA 스크립트를 유지보수해야 한다.

---

## 이론적 배경

게임 밸런싱 방법론을 다음 자료를 기반으로 학습했다.

- GDC Vault: Zynga의 공식 기반 접근법, Slay the Spire 데이터 기반 밸런싱
- NDC 2018: 넥슨의 밸런스 기획 프로세스
- 학술자료: Csikszentmihalyi의 Flow 이론, 게임 경제학의 Faucet/Sink 모델
- Ian Schreiber의 Game Balance Concepts 강의

![](/uploads/project/IndiBalancing/game-design-tool-intro/where-study.png)

추가로 실무 게임 개발 블로그에서 TTK/DPS 계산 공식, RPG 성장 곡선 설계를 참고했고, LoL/WoW의 데미지 공식(방어력 수확체감 `100/(100+DEF)`, 방어관통 시스템)을 분석했다.

**학습을 통해 정리한 밸런스 데이터 관리 사이클:**

1. 기준 설정
2. 수식화
3. 시각화
4. 검증

게임마다 공통으로 쓰이는 수식(데미지 감소율, 성장 곡선, TTK)이 존재하며, 통계적 검증 방법으로 Wilson Score Interval, 몬테카를로 시뮬레이션을 적용할 수 있다.

---

## 핵심 기능

### 게임 특화 수식 (70개 이상)

| 수식 | 설명 |
|------|------|
| `DAMAGE(atk, def)` | 감소율 공식 `atk * (100 / (100 + def))` |
| `SCALE(base, level, rate, type)` | 4가지 성장 곡선 지원 |
| `TTK(hp, dps)` | 정확한 킬타임 계산 |
| `DPS(atk, speed, crit, critDmg)` | 초당 데미지 계산 |
| `EHP(hp, def)` | 유효 체력 계산 |
| `DIMINISH(value, soft, hard)` | 수확체감 계산 |
| `REF("시트명", "행이름", "컬럼명")` | 시트 간 자동 참조 |

시트 간 자동 참조를 통해 데이터가 자동으로 재계산된다. 순환 참조가 감지되면 경고를 표시한다.

### 게임 특화 시각화

![](/uploads/project/IndiBalancing/game-design-tool-intro/game-specialized-visualization-created.png)

1. **성장 곡선 차트**: Linear, Exponential, Logarithmic, Quadratic, S-Curve 비교
2. **레이더 차트**: 캐릭터/아이템 능력치 비교
3. **TTK/DPS 계산기**: 무기 효율 분석

### 게임 엔진 연동

Unity, Godot, Unreal 코드를 자동으로 생성한다.

| 엔진 | Import | Export |
|------|--------|--------|
| Unity | `.json`, `.cs` | ScriptableObject + JSON |
| Godot | `.json`, `.gd` | Resource + JSON |
| Unreal | `.csv`, `.h` | USTRUCT + CSV |

- `.cs` 파일에서 public 필드 및 `[SerializeField]` 자동 추출
- `.gd` 파일에서 `@export` 변수 자동 추출
- `.h` 파일에서 `UPROPERTY` 필드 자동 추출

### 몬테카를로 시뮬레이션

- 1,000 ~ 100,000회 전투 시뮬레이션
- Wilson 신뢰구간 95% 통계 분석
- 1:1, 1:N, N:N 팀 전투 지원
- 다양한 데미지 공식 (단순, MMORPG, 퍼센트, 랜덤)
- 방어관통 시스템 (LoL/Dota 스타일)
- 스킬 쿨타임, HP 트리거, 시너지 로직 지원
- 턴별 전투 로그 상세 재생

### 밸런스 분석

- Z-score 기반 이상치 자동 감지
- 파워 커브 분석 (선형/지수/로그)
- Perfect Imbalance 분석 (가위바위보 상성)
- 승률 매트릭스 생성
- 피어슨 상관관계 분석
- 목표 기반 역산 (Goal Solver): 원하는 TTK에서 필요한 DPS를 역산

---

## 현재 한계점

| 한계 | 설명 |
|------|------|
| 구간별 복합 곡선 미지원 | "1~10렙은 지수, 10~50렙은 고정" 같은 복합 곡선 미지원 |
| 특수 효과 시뮬 미지원 | 무적, 부활 같은 특수 스킬은 시뮬레이션 미지원 |
| 사용자 정의 수식 없음 | 현재는 내장 함수만 사용 가능, 커스텀 공식 조합 기능은 개발 예정 |
| 협업 기능 없음 | 개인 사용 목적, 클라우드/팀 기능은 추후 추가 예정 |
| 자동 밸런싱 AI 아님 | 이상치 탐지만 제공, 수치 자동 조절 기능 없음 |

![](/uploads/project/IndiBalancing/game-design-tool-intro/limitations.png)

---

## 향후 확장 계획

1. 커뮤니티 템플릿: 사용자가 만든 모듈을 공유/조합 가능하게
2. 구간별 복합 곡선 지원: "1~10렙 지수, 10~50렙 고정" 같은 구조
3. 사용자 정의 수식: 캡슐화된 기능들의 조합 방식
4. 특수 효과 시뮬: 무적, 부활 등
5. 계정 기반 클라우드 저장
6. 실시간 협업
7. AI 이상치 경고 (자동 밸런싱이 아닌 탐지)

최종 목표는 경제 시스템, 가챠/뽑기 시스템 설계, 로그라이크 아이템 시너지까지 지원하는 것이다.

---

## 수익 모델

기본 기능은 무료로 제공한다. 추후 클라우드 저장, 협업 기능 같은 부분을 유료화할 계획이다.

---

## FAQ

**Q: 구글 시트에 Apps Script를 쓰면 되지 않나?**
A: 가능하다. 다만 스크립트 작성과 유지보수 시간을 고려하면 게임 개발에 집중하는 편이 나을 수 있다.

**Q: 전투 시뮬레이터가 있는가?**
A: 몬테카를로 시뮬레이션으로 1,000~100,000회 전투를 돌릴 수 있고, Wilson 신뢰구간 95%로 통계적 검증이 가능하다. 1:1, 1:N, N:N 팀 전투를 지원한다.

**Q: 브라우저 캐시를 지우면 데이터가 날아가는가?**
A: IndexedDB를 사용하므로 일반 캐시 삭제로는 날아가지 않는다. 다만 브라우저 데이터 전체 삭제 시에는 소실될 수 있으므로 백업이 필수다.

**Q: 게임 엔진 코드 내보내기가 되는가?**
A: Unity ScriptableObject(.cs + .json), Godot Resource(.gd + .json), Unreal USTRUCT(.h + .csv) 형태로 자동 생성한다.

**Q: 이론적 근거가 있는가?**
A: Flow 이론, Faucet/Sink 모델, Ian Schreiber의 Game Balance Concepts, NDC/GDC 발표 자료 등을 기반으로 했다.

**Q: TTK 계산에서 왜 단순히 HP/DPS로 나누면 안 되는가?**
A: 마지막 타격에는 쿨다운이 없기 때문이다. HP 100, DPS 100이면 TTK는 1초가 아니라 0.9초다.

**Q: 노션이나 에어테이블을 쓰면 되지 않는가?**
A: 노션에는 `DAMAGE(atk, def)` 같은 게임 특화 함수가 없다. 시트 간 자동 연동이나 성장 곡선 차트도 마찬가지다. 노션은 범용 툴이고, 이 툴은 게임 밸런스에 특화되어 있다.

**Q: MVP가 시트+수식+저장이면 그냥 엑셀 아닌가?**
A: 엑셀에는 `SCALE(base, level, rate, "exponential")` 같은 게임 특화 함수가 없다. 순환 참조 감지 경고, 몬테카를로 시뮬레이션, 게임 엔진 코드 자동 생성도 엑셀에는 없는 기능이다.

**Q: AI한테 시뮬레이션 돌리는 것보다 장점이 무엇인가?**
A: AI는 매번 컨텍스트를 설명해야 하고, 대화가 끊기면 다시 설명해야 하며, 데이터가 축적되지 않는다. 수치를 바꿀 때마다 다시 물어봐야 한다. 간단한 일회성 계산은 AI가 빠르지만, 지속적인 데이터 관리와 수정이 필요한 상황에서는 전용 툴이 유리하다.

**Q: 웹 기반이면 오프라인에서 못 쓰는가?**
A: IndexedDB는 로컬 저장이라 인터넷 없이도 작동한다.

<!-- EN -->

![](/uploads/project/IndiBalancing/game-design-tool-intro/image.png)
![](/uploads/project/IndiBalancing/game-design-tool-intro/image-2.png)

---

## Project Overview

IndiBalancing is a web-based game balance data management tool for indie game developers. It provides a sheet system and formulas more specialized for game development than Excel or Google Sheets.

---

## Problem Recognition

Game balancing work has recurring needs:

- Game formulas like DAMAGE, SCALE, and TTK must be easily applicable
- Related data should auto-recalculate when character stats change
- Growth curves and stat comparisons need quick chart visualization
- Data must be extractable in game engine-ready formats via JSON/CSV integration

While existing tools (Excel, Google Sheets) can do this, they lack game-specific functions, requiring manual formula writing or VBA script maintenance.

---

## Theoretical Background

Game balancing methodology was studied based on:

- GDC Vault: Zynga's formula-based approach, Slay the Spire data-driven balancing
- NDC 2018: Nexon's balance design process
- Academic materials: Csikszentmihalyi's Flow Theory, Faucet/Sink model in game economics
- Ian Schreiber's Game Balance Concepts lectures

![](/uploads/project/IndiBalancing/game-design-tool-intro/where-study.png)

Additionally, TTK/DPS calculation formulas and RPG growth curve design were referenced from game development blogs. LoL/WoW damage formulas (diminishing returns `100/(100+DEF)`, armor penetration systems) were also analyzed.

**Balance data management cycle derived from study:**

1. Set baselines
2. Formulate
3. Visualize
4. Validate

Common formulas exist across games (damage reduction, growth curves, TTK), and statistical validation methods like Wilson Score Interval and Monte Carlo simulation can be applied.

---

## Core Features

### Game-Specific Formulas (70+)

| Formula | Description |
|---------|-------------|
| `DAMAGE(atk, def)` | Reduction formula `atk * (100 / (100 + def))` |
| `SCALE(base, level, rate, type)` | 4 growth curve types supported |
| `TTK(hp, dps)` | Precise time-to-kill calculation |
| `DPS(atk, speed, crit, critDmg)` | Damage per second calculation |
| `EHP(hp, def)` | Effective HP calculation |
| `DIMINISH(value, soft, hard)` | Diminishing returns calculation |
| `REF("sheetName", "rowName", "colName")` | Cross-sheet auto-reference |

Data auto-recalculates through cross-sheet references. Circular references trigger warnings.

### Game-Specific Visualization

![](/uploads/project/IndiBalancing/game-design-tool-intro/game-specialized-visualization-created.png)

1. **Growth Curve Charts**: Compare Linear, Exponential, Logarithmic, Quadratic, S-Curve
2. **Radar Charts**: Compare character/item stats
3. **TTK/DPS Calculator**: Weapon efficiency analysis

### Game Engine Integration

Automatically generates code for Unity, Godot, and Unreal.

| Engine | Import | Export |
|--------|--------|--------|
| Unity | `.json`, `.cs` | ScriptableObject + JSON |
| Godot | `.json`, `.gd` | Resource + JSON |
| Unreal | `.csv`, `.h` | USTRUCT + CSV |

- Auto-extracts public fields and `[SerializeField]` from `.cs` files
- Auto-extracts `@export` variables from `.gd` files
- Auto-extracts `UPROPERTY` fields from `.h` files

### Monte Carlo Simulation

- 1,000 to 100,000 combat simulations
- Wilson confidence interval 95% statistical analysis
- 1v1, 1vN, NvN team battles supported
- Various damage formulas (simple, MMORPG, percentage, random)
- Armor penetration system (LoL/Dota style)
- Skill cooldowns, HP triggers, synergy logic
- Turn-by-turn combat log replay

### Balance Analysis

- Z-score based anomaly auto-detection
- Power curve analysis (linear/exponential/logarithmic)
- Perfect Imbalance analysis (rock-paper-scissors matchups)
- Win rate matrix generation
- Pearson correlation analysis
- Goal Solver: reverse-calculate required DPS from desired TTK

---

## Current Limitations

| Limitation | Description |
|------------|-------------|
| No compound curves per range | Doesn't support "exponential for levels 1-10, flat for 10-50" |
| No special effect simulation | Skills like invincibility, resurrection not simulated |
| No custom formulas | Only built-in functions available; custom formula composition planned |
| No collaboration features | Personal use only; cloud/team features planned |
| Not an auto-balancing AI | Only provides anomaly detection, not automatic value adjustment |

![](/uploads/project/IndiBalancing/game-design-tool-intro/limitations.png)

---

## Future Expansion Plans

1. Community templates: share and combine user-created modules
2. Compound curve support per range
3. Custom formulas: composition of encapsulated functions
4. Special effect simulation: invincibility, resurrection, etc.
5. Account-based cloud storage
6. Real-time collaboration
7. AI anomaly warnings (detection, not auto-balancing)

The ultimate goal is to support economy systems, gacha/draw system design, and roguelike item synergies.

---

## Revenue Model

Basic features are provided for free. Cloud storage and collaboration features are planned for paid tiers.

---

## FAQ

**Q: Can't I just use Apps Script with Google Sheets?**
A: You can. However, considering the time spent writing and maintaining scripts, it might be better to focus on game development.

**Q: Is there a combat simulator?**
A: Monte Carlo simulation can run 1,000 to 100,000 battles with Wilson 95% confidence interval statistical validation. Supports 1v1, 1vN, and NvN team battles.

**Q: Will clearing browser cache delete my data?**
A: IndexedDB is used, so regular cache clearing won't delete data. However, clearing all browser data may cause loss, so backups are essential.

**Q: Can it export game engine code?**
A: Auto-generates Unity ScriptableObject (.cs + .json), Godot Resource (.gd + .json), and Unreal USTRUCT (.h + .csv).

**Q: Is there theoretical backing?**
A: Based on Flow Theory, Faucet/Sink model, Ian Schreiber's Game Balance Concepts, and NDC/GDC presentations.

**Q: Why can't TTK be simply calculated as HP/DPS?**
A: Because there's no cooldown on the last hit. With HP 100 and DPS 100, TTK is 0.9 seconds, not 1 second.

**Q: Can't I use Notion or Airtable instead?**
A: Notion doesn't have game-specific functions like `DAMAGE(atk, def)`. Neither does it have cross-sheet auto-linking or growth curve charts. Notion is a general-purpose tool; this tool is specialized for game balance.

**Q: If MVP is sheets + formulas + save, isn't it just Excel?**
A: Excel doesn't have game-specific functions like `SCALE(base, level, rate, "exponential")`. Circular reference warnings, Monte Carlo simulation, and game engine code auto-generation are features Excel doesn't have.

**Q: What's the advantage over running simulations with AI?**
A: AI requires explaining context every time, needs re-explaining when conversations break, and data doesn't accumulate. You have to ask again every time values change. For simple one-off calculations AI is faster, but for continuous data management and modifications, a dedicated tool is superior.

**Q: Can't I use it offline since it's web-based?**
A: IndexedDB stores data locally, so it works without internet.

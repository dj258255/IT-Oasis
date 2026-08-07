---
title: '발루노 MVP 15가지 핵심 기능 소개'
description: MVP로 공개한 발루노의 계산기, 성장곡선, 전투 시뮬레이션, 밸런스 분석 등 15가지 핵심 기능을 소개합니다.
date: 2026-01-19T00:00:00.000Z
tags:
  - MVP
  - Game Balance
  - Simulation
  - Growth Curve
  - DPS
  - Economy Simulator
  - Curve Fitting
category: personal/Balruno
draft: false
coverImage: "/uploads/project/Balruno/balruno-mvp-release/calculator-feature.png"
series: "Balruno"
---

MVP(Minimum Viable Product)로 공개한 발루노의 15가지 핵심 기능을 정리해 봤습니다.

---

## 1. 계산기

![](/uploads/project/Balruno/balruno-mvp-release/calculator-feature.png)

게임 밸런싱에 필요한 단순 수치 계산을 수행하는 도구입니다. DPS, EHP, TTK 등 게임 특화 수식을 바로 적용할 수 있습니다.

---

## 2. 비교분석

![](/uploads/project/Balruno/balruno-mvp-release/compareanalysis-feature.png)

같은 시트에 있는 데이터를 레이더 차트와 막대 차트로 비교하는 기능입니다. 분포 히스토그램으로 특정 열의 데이터 분포를 확인할 수 있습니다.

---

## 3. 성장곡선 차트

![](/uploads/project/Balruno/balruno-mvp-release/growthcurvechart-1.png)

레벨업 시 스탯 증가량을 시각화하는 그래프입니다. 수치를 직접 커스텀할 수 있습니다.

![](/uploads/project/Balruno/balruno-mvp-release/growthcurvechart-2.png)

다중 시나리오와 구간별 그래프를 설정할 수 있습니다.

![](/uploads/project/Balruno/balruno-mvp-release/growthcurvechart-3.png)

곡선 전환 시점의 보간(interpolation)을 지원합니다.

![](/uploads/project/Balruno/balruno-mvp-release/growthcurvechart-4.png)
![](/uploads/project/Balruno/balruno-mvp-release/growthcurvechart-5.png)

성장률 분석 기능입니다.

![](/uploads/project/Balruno/balruno-mvp-release/growthcurvechart-6.png)

레벨별 XP 요구량을 확인할 수 있습니다.

![](/uploads/project/Balruno/balruno-mvp-release/growthcurvechart-7.png)

실제 플레이어가 만렙까지 며칠 걸릴지 예측하는 기능입니다.

---

## 4. 프리셋 비교

![](/uploads/project/Balruno/balruno-mvp-release/compare.png)

시트의 스냅샷을 찍어 임시 저장한 뒤, 값을 변경했을 때 이전 상태와 비교하는 기능입니다. 밸런스 패치 전후 수치 변화를 확인할 때 유용합니다.

---

## 5. 불균형 감지

![](/uploads/project/Balruno/balruno-mvp-release/image.png)

Z-score 기반으로 행의 값이 급격히 상승하거나 감소하면 경고하는 시스템입니다.

---

## 6. 목표 역산 (Goal Solver)

![](/uploads/project/Balruno/balruno-mvp-release/image-2.png)

원하는 결과값(예: TTK 3초)을 입력하면 필요한 수치(예: DPS 500)를 역산하는 기능입니다.

---

## 7. 밸런스 분석

![](/uploads/project/Balruno/balruno-mvp-release/balance-analysis-1.png)
![](/uploads/project/Balruno/balruno-mvp-release/balance-analysis-2.png)

유닛 간 시뮬레이션(최대 100회)을 돌려 상성을 비교하는 승률 매트릭스 기능입니다.

![](/uploads/project/Balruno/balruno-mvp-release/balance-analysis-3.png)

파워 커브 분석 기능입니다. 선형/지수/로그 곡선으로 유닛 파워를 시각화합니다.

![](/uploads/project/Balruno/balruno-mvp-release/balance-analysis-4.png)

피어슨 상관관계 분석 기능입니다. 스탯 간 상관관계를 수치로 확인할 수 있습니다.

![](/uploads/project/Balruno/balruno-mvp-release/balance-analysis-5.png)

활용되지 않는 스탯 구간을 탐지하는 기능입니다.

![](/uploads/project/Balruno/balruno-mvp-release/balance-analysis-6.png)

레벨별 스탯 성장표 자동 생성 기능입니다. 현재 HP, ATK, DEF, SPEED를 지원합니다.

---

## 8. 경제 시뮬레이터

![](/uploads/project/Balruno/balruno-mvp-release/simulator-1.png)
![](/uploads/project/Balruno/balruno-mvp-release/simulator-2.png)
![](/uploads/project/Balruno/balruno-mvp-release/simulator-3.png)

온라인 게임과 싱글 게임 모드를 지원합니다. 게임 내 재화 흐름을 시뮬레이션하여 인플레이션과 디플레이션을 예측하는 기능입니다.

---

## 9. DPS 분산 분석

![](/uploads/project/Balruno/balruno-mvp-release/dps-analysis-1.png)
![](/uploads/project/Balruno/balruno-mvp-release/dps-analysis-2.png)
![](/uploads/project/Balruno/balruno-mvp-release/dps-analysis-3.png)

DPS 시뮬레이션을 돌려 분석 결과를 그래프로 확인하고, 빌드 간 비교가 가능합니다.

---

## 10. 곡선피팅

![](/uploads/project/Balruno/balruno-mvp-release/curve-1.png)
![](/uploads/project/Balruno/balruno-mvp-release/curve-2.png)
![](/uploads/project/Balruno/balruno-mvp-release/curve-3.png)

그래프를 직접 드로잉하면 해당 곡선에 맞는 수식 코드를 자동 생성하는 기능입니다.

---

## 11. 수식 도우미

![](/uploads/project/Balruno/balruno-mvp-release/formula.png)

현재 툴에서 사용 가능한 함수 목록과 공식 설명을 제공합니다. 엑셀의 VLOOKUP 대신 자체 참조 문법을 사용하고 있습니다.

```
이전행.컬럼이름
=글로벌설정.BASE_ATK * ATK배율
```

기획자가 직관적으로 이해할 수 있는 수식 체계를 목표로 설계했습니다.

---

## 12. 밸런스 검증기

![](/uploads/project/Balruno/balruno-mvp-release/balance-verification.png)

유닛을 만들기 전에 역할에 맞는 밸런스인지 이론적으로 검증하는 기능입니다. 사전 검증 단계로 활용합니다.

---

## 13. 난이도 곡선

![](/uploads/project/Balruno/balruno-mvp-release/curve-1-2.png)

스테이지별 난이도를 시각화합니다.

![](/uploads/project/Balruno/balruno-mvp-release/curve-2-2.png)

게임의 전체 난이도 흐름을 확인하고, 예상 플레이타임(일/시간 단위)을 측정할 수 있습니다.

---

## 14. 전투 시뮬레이션

![](/uploads/project/Balruno/balruno-mvp-release/combat-simulation-1.png)

1:1 및 팀 전투 시뮬레이션 기능입니다. 지원하는 스킬 유형:

- 데미지, 즉시 힐, 지속 힐
- 무적, 부활 (자신/타인 선택 가능)
- 범위 공격, 범위 힐

![](/uploads/project/Balruno/balruno-mvp-release/combat-simulation-2.png)

유닛별 스탯과 스킬을 설정합니다.

![](/uploads/project/Balruno/balruno-mvp-release/combat-simulation-3.png)
![](/uploads/project/Balruno/balruno-mvp-release/combat-simulation-4.png)

시뮬레이션 결과를 그래프로 확인할 수 있습니다. 스킬 사용 시점도 그래프에 표시됩니다.

![](/uploads/project/Balruno/balruno-mvp-release/combat-simulation-5.png)

승률 통계와 신뢰구간을 제공합니다.

![](/uploads/project/Balruno/balruno-mvp-release/combat-simulation-6.png)

샘플 전투 로그를 상세히 재생할 수 있습니다. 크리티컬 발생, 스킬 사용 등 모든 이벤트가 기록됩니다.

![](/uploads/project/Balruno/balruno-mvp-release/combat-simulation-7.png)
![](/uploads/project/Balruno/balruno-mvp-release/combat-simulation-8.png)

팀 전투(N:N)도 지원합니다.

---

## 15. 엔티티 정의

![](/uploads/project/Balruno/balruno-mvp-release/1.png)

기존 시트 데이터를 기반으로 엔티티를 정의하는 기능입니다.

![](/uploads/project/Balruno/balruno-mvp-release/2.png)

ID, 이름, 레벨 컬럼을 매핑합니다.

![](/uploads/project/Balruno/balruno-mvp-release/3.png)

스탯을 설정합니다.

![](/uploads/project/Balruno/balruno-mvp-release/4.png)
![](/uploads/project/Balruno/balruno-mvp-release/5.png)

유닛을 선택하면 스탯 그래프가 표시됩니다.

![](/uploads/project/Balruno/balruno-mvp-release/6.png)
![](/uploads/project/Balruno/balruno-mvp-release/7.png)

테이블 생성 버튼을 누르면 설정에 맞는 시트가 자동으로 생성됩니다.

![](/uploads/project/Balruno/balruno-mvp-release/8.png)

왼쪽 사이드바와 하단 독바에서 도구를 마우스 드래그로 이동할 수 있습니다. 레이아웃도 자유롭게 커스터마이징할 수 있습니다.

---

## 성능

![](/uploads/project/Balruno/balruno-mvp-release/image-3.png)

스프레드시트 특성상 렌더링 최적화가 필수적이었습니다. requestAnimationFrame 기반 throttle, DOM 직접 조작, Set 자료구조를 활용한 O(1) 조회 등 오픈소스 코드를 분석해서 적용했습니다.

---

## 링크

- **사이트**: https://www.balruno.com/
- **오픈소스**: https://github.com/dj258255/balruno

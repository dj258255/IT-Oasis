---
title: '시장조사 후 - 인디게임 밸런스 툴을 만들게 된 과정'
titleEn: 'After Market Research - How We Decided to Build an Indie Game Balance Tool'
description: 2,200명 규모 인디게임 개발 커뮤니티에서 설문조사와 피드백 분석을 통해 게임 밸런스 툴의 시장 수요를 검증한 과정을 정리한다.
descriptionEn: Documents the process of validating market demand for a game balance tool through surveys and feedback analysis in a 2,200-member indie game development community.
date: 2025-12-05T00:00:00.000Z
tags:
  - Market Research
  - Survey
  - Indie Game
  - Product Validation
  - User Feedback
  - Game Balance
category: 프로젝트/IndiBalancing
draft: false
---

## 1. 문제 인식: 왜 이 프로젝트를 시작했는가

### 1.1 관찰한 현상

인디게임 개발 커뮤니티를 관찰하면서, 그리고 직접 인디게임을 개발해본 경험에서 반복되는 패턴을 발견했다.

**패턴**:
1. 개발자가 캐릭터 HP를 1500으로 설정함
2. "이게 적정한 수치인가?" 확신이 없음
3. 직접 플레이하며 "감"으로 조정
4. 출시 후 유저 피드백: "이 캐릭터 너무 OP임"
5. 급하게 핫픽스

**왜 이런 일이 발생하는가**:
- 대형 스튜디오에는 전담 밸런스 디자이너와 내부 툴이 있음
- 1~2인 인디 개발자에게는 그런 리소스가 없음
- 혹은 대형 스튜디오에서는 엑셀/구글 시트를 사용하지만, 게임 특화 기능이 없어서 기획자가 힘들어 하는 경우가 많음

### 1.2 문제 정의

| 문제 | 구체적 상황 | 왜 문제인가 |
|------|-------------|-------------|
| **수치의 근거 부재** | HP 1500이 적정한지 모름 | 시간이 지나면 왜 이 숫자로 했는지 까먹음 |
| **검증의 어려움** | 유닛끼리 붙었을 때 밸런스가 맞는지 일일이 테스트 | 조합이 많아지면 수작업 테스트 불가능 |
| **도구의 부재** | 게임 특화 수식, 시뮬레이션, 시각화 도구가 분산됨 | 엑셀, 별도 시뮬레이터, 차트 툴을 따로 써야 함 |

### 1.3 가설

"DPS/EHP/TTK 같은 게임 공식을 자동 계산하고, 시뮬레이션으로 승률을 검증하고, 이상치를 자동 탐지하는 도구가 있으면 인디 개발자들이 사용할 것이다."

이 가설을 검증하기 위해 시장조사를 진행했다.

---

## 2. 시장조사: 가설 검증

### 2.1 조사 방법

- **대상**: 인디게임 개발 오픈카톡방 (2,200명 규모, 현업 개발자 다수)
- **방식**: 설문조사 + 커뮤니티 반응 수집
- **기간**: 약 1주

![](/uploads/indie-balance-tool-market-research/21-research.png)

### 2.2 홍보 문구

```
안녕하세요, 취업 준비하고 있는 개발자입니다.

요즘 사이드 프로젝트로 인디게임 기획 서포트 도구를 만들고 있는데요,
프로젝트 이름은 인디밸런싱 입니다.

저도 게임 만들면서 캐릭터 스탯이나 스킬 수치 잡을 때 고민이 좀 있었거든요.
HP를 1500으로 잡았는데 이게 적정한 건지 감이 잘 안 오고,
시간 지나면 왜 이 숫자로 했는지 까먹기도 하고,
유닛끼리 붙었을 때 밸런스가 맞는지 일일이 테스트하기도 번거롭고 그랬어요.

그래서 이런 기능들을 넣어봤는데요.

- DPS/EHP/TTK 같은 게임 공식을 자동으로 계산
- 몬테카를로 시뮬레이션 1,000번~10만 번 → 승률 + 신뢰구간
- Z-score 기반 비정상 유닛 자동 탐지
- Unity, Godot, Unreal 코드 내보내기

지금 시장조사 중이라 설문 하나 만들었는데요, 3분 정도면 끝나요.
```

### 2.3 커뮤니티 즉각 반응

2,200명 규모 방에서의 반응을 정리했다.

**긍정적 반응**:
- "흥미롭다"
- "지금 사용할 수 있나요?"
- "언제 써볼 수 있나요?"
- "오 정말 멋진거 만드시네요"
- "일단 다크테마가 있는 시점에서 행복합니다"

**기술적 질문**:

> Q: 전투 연산은 프레임 단위를 돌리나요? 아니면 턴제만 가능한지

A: 현재는 프레임(시간) 기반으로 돌리고 있습니다. 턴제 게임에도 사용 가능하지만 FPS나 MOBA, 액션 RPG 같은 실시간 전투 밸런싱을 생각하면서 만들었습니다.

> Q: 난이도 곡선 설계 섹션에서는, 기준에 대한 세부 조정이 사용자 의도대로 수정 가능한건가요?

A: 네 맞습니다. 하지만 아직 초기 단계라 조정 중입니다.

**분석**: 즉각적인 관심이 있다는 것은 "문제를 겪고 있는 사람들이 존재한다"는 증거다. 다만 "관심"과 "실제 사용"은 다르므로 설문조사로 더 깊이 파악했다.

---

## 3. 설문조사 결과 분석

2,200명 규모 방에 올렸을 때 12명이 응답했다. 보상(기프티콘 등) 없이 진행했음에도 12명이 응답한 것은 관심이 있다는 신호로 해석했다.

### 3.1 응답자 프로필

![](/uploads/indie-balance-tool-market-research/image.png)

| 역할 | 인원 |
|------|------|
| 현직자 | 6명 |
| 학생/취준생 | 2명 |
| 1인 인디 개발자 | 2명 |
| 취미 개발자 | 1명 |
| 인디 팀 개발자 | 1명 |

**분석**: 응답자의 절반이 현직자다. 즉, 실제 업무에서 밸런싱을 하는 사람들이 관심을 가졌다.

### 3.2 개발 중인 장르

![](/uploads/indie-balance-tool-market-research/game.png)

**분석**: 로그라이크, RPG, 시뮬레이션이 상위권이다. 이 장르들의 공통점은 "수치 밸런싱이 중요하다"는 것이다. 장르 특성상 타겟 유저가 맞다는 신호다.

### 3.3 개발 경험

![](/uploads/indie-balance-tool-market-research/dev.png)

**분석**: 12명 중 10명이 프로젝트 완성/출시 경험이 있다. 즉, "실제로 밸런싱 작업을 해본 사람들"이 응답했다. 경험 없는 사람의 의견보다 신뢰도가 높다.

### 3.4 현재 사용 도구

![](/uploads/indie-balance-tool-market-research/tool.png)

**분석**: 대다수가 엑셀/구글 시트를 사용한다. 이 도구의 한계를 해결하면 전환할 가능성이 있다. Unity Inspector를 쓰는 사람도 있는데, 이는 "엔진 내에서 해결하고 싶다"는 니즈를 보여준다.

별도 의견: "언리얼 테이블은 기획자가 대규모 작업할 때 짜증난다"
→ 기존 도구에 불만이 있다는 증거

### 3.5 현재 방식의 불편한 점

![](/uploads/indie-balance-tool-market-research/image-2.png)

**분석**: 이 질문의 응답이 핵심이다. "어떤 불편함을 해결해야 하는가"를 직접적으로 보여준다.

### 3.6 밸런싱 작업에서 어려운 점

![](/uploads/indie-balance-tool-market-research/image-3.png)

**분석**: "밸런스가 맞는지 확인하기 어렵다"가 핵심 페인 포인트다. 이것이 몬테카를로 시뮬레이션 기능의 근거가 된다.

### 3.7 정보 습득 경로

![](/uploads/indie-balance-tool-market-research/image-4.png)

**분석**: 레퍼런스 게임 분석, 커뮤니티, 유튜브가 상위권이다. 즉, "체계적인 학습 경로가 없다"는 뜻이다. 이론적 배경을 제공하면 차별화 포인트가 될 수 있다.

### 3.8 원하는 기능 (주관식)

![](/uploads/indie-balance-tool-market-research/feature.png)

**주요 의견**:
- 자동 DPS 계산
- 난이도 곡선 시각화
- 다른 게임 수치 레퍼런스

**분석**: "자동 DPS 계산", "난이도 곡선 시각화"는 이미 구현했다. "다른 게임 레퍼런스"는 참고자료 섹션으로 제공 가능하다. 커뮤니티 기능을 추가하면 사용자 간 레퍼런스 공유로 이 니즈를 해소할 수 있다. 전반적으로 시각화에 대한 수요가 높았다.

### 3.9 사용 의향

![](/uploads/indie-balance-tool-market-research/image-5.png)

**분석**: 대다수가 "사용할 의향이 있다"고 응답했다. 가설 "도구가 있으면 사용할 것이다"가 어느 정도 검증되었다.

### 3.10 중요하게 생각하는 것

![](/uploads/indie-balance-tool-market-research/image-6.png)

**분석**: 사용 편의성, 게임 엔진 연동, 시각화가 상위권이다. 이 세 가지가 핵심 기능이 되어야 한다.

### 3.11 가격 민감도

![](/uploads/indie-balance-tool-market-research/311.png)

**분석**: 무료~월 5천원 대가 대다수다. 고가 유료화는 어렵고, 프리미엄 모델(기본 무료 + 고급 기능 유료)이 적합하다는 증거다.

### 3.12 자유 의견

![](/uploads/indie-balance-tool-market-research/image-7.png)

### 3.13 베타테스트 참여 의향

![](/uploads/indie-balance-tool-market-research/image-8.png)

**분석**: 2명이 연락처를 남겼다. 초기 사용자 확보 가능성이 있다.

---

## 4. 상세 피드백 분석

설문 외에 개인 메시지로 받은 상세 피드백을 분석했다.

### 4.1 시뮬레이션 기능 관련 피드백

> Q: 피드백이라고 하기엔 애매하고... 제가 예전에 취준하면서 비슷한것 만들었을때는 시뮬레이터 쪽에 아래 같은 정보도 넣었습니다.
>
> 1. 평균적으로 전투가 종료되는 시간 (전투가 늘어지는 경향이 있는지)
> 2. 종료 시 HP 추세 (적은 피로 이기면 더 쫄깃하기도 하니까)
> 3. 치명타 관련 정보들 (치명타에 의해서 얼마나 게임이 뒤집혔는지)
>
> 외적인 기능엔
> 1. 파티플레이
> 2. 전투 스킬 (공격, 범위 공격, 힐, 범위 힐, 무적 등)
> 3. 시뮬레이션 데이터 결과 export

**분석**:
- 전투 종료 시간, 종료 시 HP 추세는 "게임 페이스"를 분석하는 지표다
- 치명타 역전 분석은 "운 요소"의 영향을 측정하는 것
- 파티플레이는 현재 N:N 팀 전투로 구현됨
- 스킬 시스템은 부분 구현 (쿨타임, HP 트리거), 무적/부활은 미구현
- 결과 export는 구현 예정

**액션 아이템**:
- 전투 로그 export 기능 추가
- 평균 전투 시간, 종료 시 HP 분포 시각화 추가 검토

### 4.2 이상치 탐지 관련 피드백

> Q: 개인적으로는 저런 검증툴은 실제적인 전투 감각 텐션 검증은 어렵다고 생각해요. 그래서 저런 것이 대신 해주면 좋은 것은 이상점 탐지라고 봅니다.
>
> 버프가 무지막지하게 튀는 지점이 있는지? DPS가 의도보다 너무 높아지는 구간이 있는지?
>
> 개체 A가 가진 스탯을 모든 프레임이나 턴을 기반으로 그래프화해서 보여주면 유리한 점이 있을겁니다.

**분석**:
- "실제 전투 감각 검증은 어렵다"는 것은 맞는 지적이다. 이 도구가 "모든 것을 해결해준다"고 주장하면 안 된다.
- 핵심 가치는 "이상치 탐지"다. Z-score 기반 이상치 탐지 기능이 이미 있지만, 프레임별 스탯 변화 그래프는 추가 검토 필요.

> Q: 리얼 밸런스를 저 툴로 다 맞춘다하면 그야말로 지옥이라서요. 그건 내려놓고 할 수 있는 부분을 최대한 커버하는 쪽으로 가시면 효율이 좋아질듯. 그것만 해도 엄청난 툴이 됩니다.

**분석**:
- 범위 설정이 중요하다. "만능 툴"이 아니라 "특정 문제를 확실히 해결하는 툴"로 포지셔닝해야 한다.
- 명시적으로 "하지 않는 것"을 문서화해야 한다.

### 4.3 확장성 관련 피드백

> Q: 게임마다 밸런스의 특성이 다르고 비표준적인 작업을 해야 할 경우가 많다고 생각해서요.
>
> A. 레벨업 요구 경험치가 지수적으로 증가하지만, 10렙부터 50렙까지는 레벨업당 요구 경험치가 10만으로 일정한 그래프가 있어도 대응할 수 있는가?
>
> B. 무적 스킬의 쿨타임이 0초라거나 사망시 90%확률로 부활하는 캐릭터라면 그 때의 승률은 어떤지?

**분석**:
- A 케이스: "구간별 성장 곡선"이 필요하다. 현재는 단일 곡선만 지원. 로드맵에 추가.
- B 케이스: 특수 효과(무적, 부활)는 현재 미지원. 커스텀 스크립트 기능으로 해결 가능할 수 있음.

> Q: 약간 캡슐화된 기능들의 조합 방식으로 간다거나, 접근 방식을 뒤집는 것도 상상해 볼 수 있을 것 같아요.
>
> 예를들면 성장그래프 개형을 '드로잉' 하면 구간별로 나눠서 구간별 공식을 도출해주는 역순의 접근법이라거나요..

**분석**:
- "역방향 계산" (Goal Solver) 기능이다. "원하는 결과를 입력하면 필요한 수치를 역산"하는 기능.
- 이미 Goal Solver 기능이 있지만, "드로잉 → 공식 도출"은 더 직관적인 UX. 장기 로드맵에 추가.

### 4.4 수익화 관련 피드백

> Q: 지속적이고 반복적인 수요가 발생하는 지점을 노려 강화하시면 좋을것 같습니다.
>
> 4~5년에 1번 사용할 굉장히 유용하고 신기한 기능보다는...
>
> 매번 업데이트마다 밸런스 검증의 수요라던지, 신작 게임 개발사에서 한번쯤 테스트해볼만한 밸런스 기반 플레이타임(볼륨) 산출 도우미라던지요!

**분석**:
- "반복 수요"가 핵심이다. 한 번 쓰고 끝나는 기능보다 "매번 업데이트마다 쓰는 기능"이 유료화에 적합하다.
- 밸런스 검증(패치 전 시뮬레이션), 버전 비교(이전 버전 vs 새 버전) 기능이 반복 수요를 만들 수 있다.

---

## 5. 비판적 피드백과 대응

### 5.1 받은 비판

> Q: 의도는 알겠는데 쉽지않을거같음
>
> 1. 엑셀처럼 자유로운 사용방식과 최대한 비슷해야 기획자가 쓸려고함 (언리얼테이블조차 잘안쓸려하더라)
> 2. 엑셀에 익숙하고 비쥬얼베이직도 조금다루는사람이 넘어갈만한 메리트가 안보임
>
> 현상태는 포폴로써는 좋아보이지만 이걸 사업비전으로하는건 메리트를 못느낌
>
> 인디겜개발자 수준에서는 필요할수도있지만 유료로 쓰지않을거고 어느정도 회사크기가 있게되면 확장성이 최우선이기때문에 유지보수가 쉬워야함

### 5.2 비판 분석

| 비판 | 타당성 | 대응 |
|------|--------|------|
| 엑셀처럼 자유로워야 함 | O | UI를 스프레드시트 형태로 설계함 |
| VBA 사용자가 넘어갈 메리트 없음 | △ | VBA로 직접 만들 수 있는 사람은 타겟이 아님. "직접 만들 시간이 없는 사람"이 타겟 |
| 인디 개발자는 유료로 안 씀 | O | 기본 기능 무료, 클라우드 기능만 유료 (Open Core 모델) |
| 확장성이 최우선 | O | 오픈소스로 공개하여 직접 수정 가능하게 함 |

### 5.3 타겟 재정의

비판을 반영하여 타겟을 명확히 했다:

**타겟**:
- 1~5인 규모의 인디 개발자/팀
- 전담 밸런스 디자이너가 없는 환경
- 엑셀은 쓰지만 VBA 스크립트를 직접 짤 시간/역량이 없는 사람
- "이 정도면 충분하다"는 80% 솔루션을 원하는 사람

**타겟이 아닌 사람**:
- 대형 스튜디오
- VBA/Apps Script를 자유자재로 다루는 사람 (직접 만드는 게 나음)
- 100% 커스텀이 필요한 사람 (확장성 한계)

다만 인디 개발자/팀에서 출발하되, 장기적으로는 대형 스튜디오에서도 사용할 수 있는 수준으로 확장하는 것이 목표다.

---

## 6. 설문 결과 기반 의사결정

설문조사와 피드백을 바탕으로 다음 결정을 내렸다.

### 6.1 핵심 기능 우선순위

| 우선순위 | 기능 | 근거 |
|----------|------|------|
| 1 | 사용 편의성 (스프레드시트 UI) | 설문 Q10 1위 |
| 2 | 게임 엔진 연동 | 설문 Q10 2위 |
| 3 | 시각화 | 설문 Q10 3위 |
| 4 | DPS/EHP/TTK 자동 계산 | 설문 Q8 주관식 |
| 5 | 시뮬레이션 | 커뮤니티 반응 |

### 6.2 수익 모델

| 구분 | 기능 | 가격 |
|------|------|------|
| 무료 | 모든 로컬 기능, 수식, 시뮬레이션, 내보내기 | 0원 |
| 유료 | 클라우드 저장, 버전 히스토리, 팀 협업 | 월 5,000원 이하 |

근거: 설문 Q11에서 대다수가 "무료~월 5천원"을 선택

### 6.3 명시적으로 하지 않는 것

피드백 "리얼 밸런스를 다 맞추는 건 지옥"을 반영:

- 게임을 만들어주는 도구가 아님
- AI가 밸런스를 자동으로 잡아주지 않음 (이상치 탐지만 함)
- 모든 게임의 모든 케이스를 커버하지 않음 (80% 솔루션)
- 게임 엔진 플러그인이 아님 (데이터 내보내기만 제공)

---

## 7. 추가 반응: 러브콜

프로젝트를 홍보하면서 예상치 못한 반응도 있었다:

- "프로젝트 상용화를 위해 뛰어다니는 게 맘에 들었다"
- "사원 수 100명 이상, 캐주얼 게임 운영 중인 회사에서 본격적으로 만들어보는 건 어떻겠냐"

이런 반응은 "시장에서 이 문제를 인식하고 있다"는 신호로 해석했다.

---

## 8. 결론: 무엇을 배웠는가

### 8.1 검증된 것

1. **문제는 실재한다**: 인디 개발자들이 밸런싱 도구의 부재를 느끼고 있다
2. **관심은 있다**: 홍보 시 즉각적인 긍정 반응이 있었다
3. **사용 의향은 있다**: 설문에서 대다수가 "사용하겠다"고 응답

### 8.2 주의할 것

1. **"관심"과 "실제 사용"은 다르다**: 출시 후 실제 사용률을 봐야 함
2. **유료 전환은 어렵다**: 무료 기능이 충분하면 굳이 돈을 안 냄
3. **범위 설정이 중요하다**: "만능 툴"을 목표로 하면 안 됨

### 8.3 다음 단계

1. MVP 출시 → 실제 사용 데이터 수집
2. 피드백 기반 개선 (구간별 성장 곡선, 전투 로그 export 등)
3. 클라우드 기능 개발 → 유료화 테스트

<!-- EN -->

## 1. Problem Recognition: Why This Project Started

### 1.1 Observed Pattern

While observing indie game development communities and from personal experience developing indie games, a recurring pattern was discovered.

**Pattern**:
1. Developer sets character HP to 1500
2. No confidence whether "this is the right number"
3. Adjusts by "feel" through playtesting
4. Post-launch user feedback: "This character is too OP"
5. Emergency hotfix

**Why this happens**:
- Large studios have dedicated balance designers and internal tools
- 1-2 person indie developers lack those resources
- Even large studios using Excel/Google Sheets struggle without game-specific functions

### 1.2 Problem Definition

| Problem | Specific Situation | Why It's a Problem |
|---------|-------------------|-------------------|
| **No basis for values** | Don't know if HP 1500 is appropriate | Forget why this number was chosen over time |
| **Difficulty validating** | Testing balance when units fight one by one | Manual testing impossible as combinations grow |
| **Lack of tools** | Game formulas, simulation, visualization scattered | Need separate Excel, simulator, charting tools |

### 1.3 Hypothesis

"If there's a tool that auto-calculates game formulas like DPS/EHP/TTK, validates win rates through simulation, and auto-detects anomalies, indie developers will use it."

Market research was conducted to validate this hypothesis.

---

## 2. Market Research: Hypothesis Validation

### 2.1 Research Method

- **Target**: Indie game development open chat room (2,200 members, many working professionals)
- **Method**: Survey + community reaction collection
- **Duration**: Approximately 1 week

![](/uploads/indie-balance-tool-market-research/21-research.png)

### 2.3 Immediate Community Response

Responses from the 2,200-member room were compiled.

**Positive reactions**:
- "This is interesting"
- "Can I use it now?"
- "When can I try it?"
- "Wow, you're building something really cool"
- "I'm happy just knowing it has dark theme"

**Technical questions**:

> Q: Does the combat calculation run frame-by-frame? Or is it turn-based only?

A: Currently runs on frame (time) basis. Usable for turn-based games too, but designed with real-time combat balancing in mind for FPS, MOBA, action RPGs.

> Q: In the difficulty curve design section, can the baseline adjustments be customized to user intent?

A: Yes. But it's still in early stages and being refined.

**Analysis**: Immediate interest proves "people experiencing this problem exist." However, "interest" and "actual usage" differ, so deeper investigation was done through surveys.

---

## 3. Survey Results Analysis

12 people responded when posted to the 2,200-member room. Getting 12 responses without incentives (gift cards, etc.) was interpreted as a signal of interest.

### 3.1 Respondent Profile

![](/uploads/indie-balance-tool-market-research/image.png)

| Role | Count |
|------|-------|
| Working professionals | 6 |
| Students/Job seekers | 2 |
| Solo indie developers | 2 |
| Hobby developers | 1 |
| Indie team developers | 1 |

**Analysis**: Half the respondents are working professionals. People who actually do balancing work showed interest.

### 3.2 Genres in Development

![](/uploads/indie-balance-tool-market-research/game.png)

**Analysis**: Roguelike, RPG, and simulation ranked highest. The common trait: "numerical balancing is critical." Genre characteristics signal the target users are correct.

### 3.3 Development Experience

![](/uploads/indie-balance-tool-market-research/dev.png)

**Analysis**: 10 out of 12 have completed/shipped projects. These are "people who've actually done balancing work." More credible than opinions from inexperienced respondents.

### 3.4 Current Tools Used

![](/uploads/indie-balance-tool-market-research/tool.png)

**Analysis**: Majority use Excel/Google Sheets. Solving these tools' limitations creates switching potential. Some use Unity Inspector, showing a desire to "solve it within the engine."

Additional comment: "Unreal tables are annoying for planners doing large-scale work"
→ Evidence of dissatisfaction with existing tools

### 3.5 Pain Points with Current Methods

![](/uploads/indie-balance-tool-market-research/image-2.png)

**Analysis**: This question's responses are key. Directly shows "what inconveniences need to be solved."

### 3.6 Balancing Difficulties

![](/uploads/indie-balance-tool-market-research/image-3.png)

**Analysis**: "Hard to verify if balance is correct" is the core pain point. This justifies the Monte Carlo simulation feature.

### 3.7 Information Sources

![](/uploads/indie-balance-tool-market-research/image-4.png)

**Analysis**: Reference game analysis, communities, and YouTube ranked highest. This means "there's no systematic learning path." Providing theoretical background could be a differentiator.

### 3.8 Desired Features (Open-ended)

![](/uploads/indie-balance-tool-market-research/feature.png)

**Key opinions**:
- Auto DPS calculation
- Difficulty curve visualization
- Other game value references

**Analysis**: "Auto DPS calculation" and "difficulty curve visualization" are already implemented. "Other game references" can be provided through a references section. Adding community features could address this need through user-to-user reference sharing. Overall, high demand for visualization.

### 3.9 Usage Intent

![](/uploads/indie-balance-tool-market-research/image-5.png)

**Analysis**: Majority responded "willing to use." The hypothesis "they'll use it if it exists" is somewhat validated.

### 3.10 What Matters Most

![](/uploads/indie-balance-tool-market-research/image-6.png)

**Analysis**: Ease of use, game engine integration, and visualization ranked highest. These three should be core features.

### 3.11 Price Sensitivity

![](/uploads/indie-balance-tool-market-research/311.png)

**Analysis**: Free to 5,000 KRW/month dominated. High-price monetization is difficult; evidence supports a freemium model (basic free + premium features paid).

### 3.12 Free Comments

![](/uploads/indie-balance-tool-market-research/image-7.png)

### 3.13 Beta Test Participation

![](/uploads/indie-balance-tool-market-research/image-8.png)

**Analysis**: 2 people left contact information. Early user acquisition is possible.

---

## 4. Detailed Feedback Analysis

Detailed feedback received via personal messages beyond the survey was analyzed.

### 4.1 Simulation Feature Feedback

**Analysis**:
- Combat end time and ending HP trends are metrics for analyzing "game pace"
- Critical hit reversal analysis measures "luck factor" impact
- Party play is currently implemented as NvN team battles
- Skill system partially implemented (cooldowns, HP triggers); invincibility/resurrection not yet
- Result export is planned

**Action items**:
- Add combat log export feature
- Review adding average combat time and ending HP distribution visualization

### 4.2 Anomaly Detection Feedback

**Analysis**:
- "Actual combat feel validation is difficult" is a valid point. The tool shouldn't claim to "solve everything."
- Core value is "anomaly detection." Z-score based detection exists, but frame-by-frame stat change graphs need review.
- Scope setting matters. Position as "a tool that definitively solves specific problems," not a "universal tool."
- Explicitly document "what it doesn't do."

### 4.3 Extensibility Feedback

**Analysis**:
- Case A: "Range-based growth curves" needed. Currently only single curves supported. Added to roadmap.
- Case B: Special effects (invincibility, resurrection) currently unsupported. May be solvable with custom scripting.
- "Reverse calculation" (Goal Solver) feature. Goal Solver exists, but "drawing → formula derivation" is more intuitive UX. Added to long-term roadmap.

### 4.4 Monetization Feedback

**Analysis**:
- "Recurring demand" is key. Features used "every update" suit paid tiers better than one-time-use features.
- Balance validation (pre-patch simulation), version comparison (old vs new) can create recurring demand.

---

## 5. Critical Feedback and Response

### 5.1 Criticism Received

Feedback essentially said: intent is clear but execution will be difficult. Excel-like freedom is needed, VBA users see no merit in switching, indie developers won't pay, and larger companies need extensibility and maintainability.

### 5.2 Criticism Analysis

| Criticism | Validity | Response |
|-----------|----------|----------|
| Must be free like Excel | O | UI designed as spreadsheet format |
| No merit for VBA users to switch | △ | VBA-capable users aren't the target. Target is "people without time to build their own" |
| Indie developers won't pay | O | Basic features free, only cloud features paid (Open Core model) |
| Extensibility is top priority | O | Open-sourced for direct modification |

### 5.3 Target Redefinition

Targets were clarified reflecting criticism:

**Target**:
- 1-5 person indie developers/teams
- Environments without dedicated balance designers
- People who use Excel but lack time/ability to write VBA scripts
- People wanting an "80% solution that's good enough"

**Not the target**:
- Large studios
- People fluent in VBA/Apps Script (better off building their own)
- People needing 100% customization (extensibility limitations)

Starting with indie developers/teams, the long-term goal is expanding to a level usable by large studios.

---

## 6. Survey-Based Decisions

Based on surveys and feedback, the following decisions were made.

### 6.1 Core Feature Priority

| Priority | Feature | Basis |
|----------|---------|-------|
| 1 | Ease of use (spreadsheet UI) | Survey Q10 #1 |
| 2 | Game engine integration | Survey Q10 #2 |
| 3 | Visualization | Survey Q10 #3 |
| 4 | DPS/EHP/TTK auto calculation | Survey Q8 open-ended |
| 5 | Simulation | Community response |

### 6.2 Revenue Model

| Tier | Features | Price |
|------|----------|-------|
| Free | All local features, formulas, simulation, export | 0 KRW |
| Paid | Cloud storage, version history, team collaboration | Under 5,000 KRW/month |

Basis: Majority selected "free to 5,000 KRW" in survey Q11

### 6.3 Explicitly Not Doing

Reflecting the feedback "perfectly balancing with this tool would be hell":

- Not a tool that makes games
- AI doesn't auto-balance (only anomaly detection)
- Doesn't cover every case for every game (80% solution)
- Not a game engine plugin (only data export)

---

## 7. Unexpected Responses

While promoting the project, unexpected reactions emerged:

- "I like that you're hustling to commercialize the project"
- "How about building it seriously at a company with 100+ employees running casual games?"

These reactions were interpreted as signals that "the market recognizes this problem."

---

## 8. Conclusion: What Was Learned

### 8.1 What Was Validated

1. **The problem is real**: Indie developers feel the absence of balancing tools
2. **Interest exists**: Immediate positive reactions when promoted
3. **Usage intent exists**: Majority responded "willing to use" in surveys

### 8.2 Caveats

1. **"Interest" and "actual usage" differ**: Need to observe actual usage rates post-launch
2. **Paid conversion is difficult**: If free features are sufficient, people won't pay
3. **Scope setting is critical**: Don't aim for a "universal tool"

### 8.3 Next Steps

1. MVP launch → collect actual usage data
2. Feedback-based improvements (range-based growth curves, combat log export, etc.)
3. Cloud feature development → monetization testing

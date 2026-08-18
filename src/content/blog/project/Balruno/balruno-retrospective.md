---
title: 'Balruno 개발기: 시장조사부터 셀프 호스트 인프라까지'
description: >-
  게임 밸런싱 스프레드시트 겸 문서 워크스페이스 Balruno를 만들며 지나온 6개월을 한 글에
  모았습니다. 인디 개발자 설문으로 방향을 잡은 과정, MVP 15가지 기능, 테이블 입력 UX의
  성능 문제, 첫 사용자 피드백 24건, 그리고 PostgreSQL JSONB 선택과 OCI 셀프 호스트
  운영까지 시간순으로 담았습니다.
date: 2026-05-10T00:00:00.000Z
tags:
  - Balruno
  - Side Project
  - Market Research
  - PostgreSQL
  - JSONB
  - Spring Boot
  - WebSocket
  - React
  - Next.js
  - Performance
  - UX
  - OCI
  - Ansible
  - Architecture
  - Retrospective
category: personal/Balruno
coverImage: /uploads/project/Balruno/retrospective/title.png
draft: false
series: "Balruno"
seriesOrder: 1
---

Balruno는 게임 기획 데이터에 맞춘 협업 스프레드시트 겸 문서 워크스페이스입니다. 캐릭터 스탯, 무기 수치, 레벨 곡선, 드롭 확률처럼 표에 자연스럽게 쌓이는 데이터를 그대로 다루고, 실시간 협업부터 게임 엔진 export까지 한 흐름으로 묶는 것을 목표로 만들고 있습니다.

![Balruno](/uploads/project/Balruno/retrospective/title.png)

- **기간**: 2025.12 시장조사, 2026.01부터 개발 진행 중
- **형태**: 1인 오픈소스 SaaS (클라이언트 MIT, 백엔드 AGPL v3)
- **데모**: [balruno.com](https://balruno.com)

만드는 동안의 기록을 편마다 나눠 올렸는데, 흩어져 있으니 앞뒤가 끊겼습니다. 설문에서 나온 이상치 탐지 요구가 나중에 어떤 기능이 됐는지, 드래그가 버벅이던 문제를 어디까지 파고들었는지가 글을 오가야만 보였습니다. 그래서 6편을 시간순 여섯 장으로 합쳤습니다.

각 장은 원래 글의 내용을 담고 있고, 장 머리에 원문 발행일을 남겨 개발 순서를 알 수 있게 했습니다. 순서대로 읽으면 시장조사에서 인프라까지의 기록이 되고, 목차에서 필요한 장만 골라 읽어도 됩니다.

---

## 1. 시장조사로 방향을 잡다

*원문 발행일 2025-12-05*

### 1. 문제 인식

인디게임 커뮤니티를 보면서, 그리고 직접 만들어보면서 같은 패턴이 반복되는 걸 봤습니다. 캐릭터 HP를 1500으로 잡는다. 이게 적정한지 확신이 없다. 직접 플레이하며 감으로 조정한다. 출시 후 "이 캐릭터 너무 OP"라는 피드백을 받는다. 급하게 핫픽스한다.

대형 스튜디오에는 전담 밸런스 디자이너와 내부 툴이 있지만 1~2인 인디 개발자에게는 없습니다. 스튜디오도 엑셀이나 구글 시트를 쓰는 경우가 많은데 게임 특화 기능이 없어서 기획자가 힘들어합니다.

| 문제 | 구체적 상황 | 왜 문제인가 |
|------|-------------|-------------|
| 수치의 근거 부재 | HP 1500이 적정한지 모름 | 시간이 지나면 왜 이 숫자였는지 잊음 |
| 검증의 어려움 | 유닛끼리 붙었을 때 일일이 테스트 | 조합이 늘면 수작업 불가능 |
| 도구의 부재 | 수식, 시뮬레이션, 시각화가 흩어짐 | 엑셀과 시뮬레이터, 차트 툴을 따로 씀 |

그래서 가설을 이렇게 세웠습니다. DPS와 EHP, TTK 같은 게임 공식을 자동 계산하고 시뮬레이션으로 승률을 검증하고 이상치를 자동 탐지하는 도구가 있으면 인디 개발자들이 쓸 것이다. 이걸 확인하려고 시장조사를 했습니다.

---

### 2. 시장조사: 가설 검증

#### 2.1 조사 방법

- **대상**: 인디게임 개발 오픈카톡방 (2,200명 규모, 현업 개발자 다수)
- **방식**: 설문조사 + 커뮤니티 반응 수집
- **기간**: 약 1주

![](/uploads/project/Balruno/indie-balance-tool-market-research/21-research.png)

#### 2.2 홍보 문구

```
안녕하세요, 취업 준비하고 있는 개발자입니다.

요즘 사이드 프로젝트로 인디게임 기획 서포트 도구를 만들고 있는데요,
프로젝트 이름은 발루노 입니다.

저도 게임 만들면서 캐릭터 스탯이나 스킬 수치 잡을 때 고민이 좀 있었습니다.
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

#### 커뮤니티 반응

반응은 빨랐습니다. 흥미롭다, 지금 쓸 수 있냐, 언제 써볼 수 있냐는 말이 바로 나왔습니다. 다크테마가 있는 시점에서 행복하다는 반응도 있었습니다.

기술적인 질문도 받았습니다.

> Q: 전투 연산은 프레임 단위를 돌리나요? 아니면 턴제만 가능한지

프레임 기반으로 돌리고 있고 턴제에도 쓸 수 있지만, FPS나 MOBA, 액션 RPG 같은 실시간 전투 밸런싱을 생각하며 만들었다고 답했습니다.

> Q: 난이도 곡선 설계 섹션에서는, 기준에 대한 세부 조정이 사용자 의도대로 수정 가능한건가요?

가능하지만 아직 초기라 조정 중이라고 답했습니다.

즉각적인 관심이 있다는 건 문제를 겪는 사람들이 실재한다는 증거입니다. 다만 관심과 실제 사용은 다르므로 설문으로 더 파고들었습니다.

---

### 3. 설문조사 결과 분석

2,200명 규모 방에 올려 12명이 응답했습니다. 기프티콘 같은 보상 없이 받은 숫자라 관심이 있다는 신호로 봤습니다.

#### 누가 답했나

![](/uploads/project/Balruno/indie-balance-tool-market-research/image.png)

| 역할 | 인원 |
|------|------|
| 현직자 | 6명 |
| 학생/취준생 | 2명 |
| 1인 인디 개발자 | 2명 |
| 취미 개발자 | 1명 |
| 인디 팀 개발자 | 1명 |

절반이 현직자였습니다. 실제 업무에서 밸런싱을 하는 사람들이 반응했다는 뜻입니다. 12명 중 10명은 프로젝트를 완성하거나 출시한 경험이 있어서, 해본 적 없는 사람의 의견보다 신뢰할 만했습니다.

![](/uploads/project/Balruno/indie-balance-tool-market-research/game.png)
![](/uploads/project/Balruno/indie-balance-tool-market-research/dev.png)

장르는 로그라이크와 RPG, 시뮬레이션이 상위권이었습니다. 셋 다 수치 밸런싱이 중요한 장르라 타겟이 맞다고 봤습니다.

#### 지금 뭘 쓰고, 뭐가 불편한가

![](/uploads/project/Balruno/indie-balance-tool-market-research/tool.png)

대다수가 엑셀이나 구글 시트를 씁니다. 이 도구의 한계를 풀면 넘어올 여지가 있다는 뜻입니다. Unity Inspector를 쓰는 사람도 있었는데 엔진 안에서 해결하고 싶다는 니즈로 읽었습니다. 별도로 "언리얼 테이블은 기획자가 대규모 작업할 때 짜증난다"는 의견도 받았습니다.

![](/uploads/project/Balruno/indie-balance-tool-market-research/image-2.png)
![](/uploads/project/Balruno/indie-balance-tool-market-research/image-3.png)

가장 중요한 응답은 어려운 점이었습니다. "밸런스가 맞는지 확인하기 어렵다"가 핵심 페인 포인트로 나왔고, 이게 몬테카를로 시뮬레이션 기능의 근거가 됐습니다.

![](/uploads/project/Balruno/indie-balance-tool-market-research/image-4.png)

정보는 레퍼런스 게임 분석과 커뮤니티, 유튜브로 얻고 있었습니다. 체계적인 학습 경로가 없다는 뜻이라, 이론적 배경을 같이 제공하면 차별화가 되겠다고 봤습니다.

#### 뭘 원하고, 얼마를 낼 수 있나

![](/uploads/project/Balruno/indie-balance-tool-market-research/feature.png)
![](/uploads/project/Balruno/indie-balance-tool-market-research/image-5.png)
![](/uploads/project/Balruno/indie-balance-tool-market-research/image-6.png)

주관식으로 나온 요구는 자동 DPS 계산, 난이도 곡선 시각화, 다른 게임 수치 레퍼런스였습니다. 앞의 둘은 이미 구현했고, 레퍼런스는 참고자료 섹션이나 커뮤니티 기능으로 풀 수 있습니다. 전반적으로 시각화 수요가 높았습니다.

사용 의향은 대다수가 있다고 답해서 도구가 있으면 쓸 것이라는 가설이 어느 정도 검증됐습니다. 중요하게 보는 것은 사용 편의성, 게임 엔진 연동, 시각화 순이었고 이 셋을 핵심 기능으로 잡았습니다.

![](/uploads/project/Balruno/indie-balance-tool-market-research/311.png)

가격은 무료에서 월 5천원 대가 대다수였습니다. 고가 유료화는 어렵고 기본 무료에 고급 기능을 유료로 두는 모델이 맞다는 근거가 됐습니다.

![](/uploads/project/Balruno/indie-balance-tool-market-research/image-7.png)
![](/uploads/project/Balruno/indie-balance-tool-market-research/image-8.png)

베타테스트에는 2명이 연락처를 남겼습니다. 초기 사용자를 확보할 여지가 있습니다.

---

### 4. 개인 메시지로 받은 상세 피드백

설문 밖에서 개인 메시지로 받은 것들이 더 날카로웠습니다.

#### 시뮬레이터에 무엇을 더 넣을 것인가

> 제가 예전에 취준하면서 비슷한것 만들었을때는 시뮬레이터 쪽에 아래 같은 정보도 넣었습니다.
>
> 1. 평균적으로 전투가 종료되는 시간 (전투가 늘어지는 경향이 있는지)
> 2. 종료 시 HP 추세 (적은 피로 이기면 더 쫄깃하기도 하니까)
> 3. 치명타 관련 정보들 (치명타에 의해서 얼마나 게임이 뒤집혔는지)
>
> 외적인 기능엔 파티플레이, 전투 스킬 (공격, 범위 공격, 힐, 범위 힐, 무적 등), 시뮬레이션 데이터 결과 export

전투 종료 시간과 종료 시 HP 추세는 게임 페이스를 보는 지표이고, 치명타 역전 분석은 운 요소의 영향을 재는 지표입니다. 파티플레이는 N:N 팀 전투로 이미 구현돼 있고, 스킬은 쿨타임과 HP 트리거까지만 되어 있어 무적과 부활은 아직입니다. 전투 로그 export와 평균 전투 시간 시각화를 할 일 목록에 넣었습니다.

#### 이 도구가 하지 말아야 할 것

> 개인적으로는 저런 검증툴은 실제적인 전투 감각 텐션 검증은 어렵다고 생각해요. 그래서 저런 것이 대신 해주면 좋은 것은 이상점 탐지라고 봅니다.
>
> 버프가 무지막지하게 튀는 지점이 있는지? DPS가 의도보다 너무 높아지는 구간이 있는지?

맞는 지적이라고 봤습니다. 이 도구가 모든 걸 해결한다고 주장하면 안 됩니다. 핵심 가치는 이상치 탐지 쪽입니다. Z-score 기반 탐지는 이미 있고, 프레임별 스탯 변화 그래프는 검토 중입니다.

> 리얼 밸런스를 저 툴로 다 맞춘다하면 그야말로 지옥이라서요. 그건 내려놓고 할 수 있는 부분을 최대한 커버하는 쪽으로 가시면 효율이 좋아질듯. 그것만 해도 엄청난 툴이 됩니다.

만능 툴이 아니라 특정 문제를 확실히 푸는 툴로 자리를 잡아야 하고, 하지 않는 것을 명시적으로 적어둬야 한다는 결론이 여기서 나왔습니다.

#### 비표준 케이스를 감당할 수 있는가

> A. 레벨업 요구 경험치가 지수적으로 증가하지만, 10렙부터 50렙까지는 레벨업당 요구 경험치가 10만으로 일정한 그래프가 있어도 대응할 수 있는가?
>
> B. 무적 스킬의 쿨타임이 0초라거나 사망시 90%확률로 부활하는 캐릭터라면 그 때의 승률은 어떤지?

A는 구간별 성장 곡선이 필요한 케이스입니다. 지금은 단일 곡선만 지원해서 로드맵에 넣었습니다. B의 특수 효과는 아직 미지원이고 커스텀 스크립트로 풀 수 있을 것 같습니다.

> 예를들면 성장그래프 개형을 '드로잉' 하면 구간별로 나눠서 구간별 공식을 도출해주는 역순의 접근법이라거나요..

역방향 계산입니다. Goal Solver 기능이 이미 있지만 그리면 공식이 나오는 쪽이 훨씬 직관적이라 장기 로드맵에 넣었습니다.

#### 어디서 돈이 반복되는가

> 4~5년에 1번 사용할 굉장히 유용하고 신기한 기능보다는... 매번 업데이트마다 밸런스 검증의 수요라던지, 신작 게임 개발사에서 한번쯤 테스트해볼만한 밸런스 기반 플레이타임(볼륨) 산출 도우미라던지요!

반복 수요가 핵심이라는 이야기입니다. 한 번 쓰고 끝나는 기능보다 패치할 때마다 돌리는 밸런스 검증이나 이전 버전과의 비교가 유료화에 맞습니다.

---

### 5. 비판적 피드백과 대응

#### 5.1 받은 비판

> Q: 의도는 알겠는데 쉽지않을거같음
>
> 1. 엑셀처럼 자유로운 사용방식과 최대한 비슷해야 기획자가 쓸려고함 (언리얼테이블조차 잘안쓸려하더라)
> 2. 엑셀에 익숙하고 비쥬얼베이직도 조금다루는사람이 넘어갈만한 메리트가 안보임
>
> 현상태는 포폴로써는 좋아보이지만 이걸 사업비전으로하는건 메리트를 못느낌
>
> 인디겜개발자 수준에서는 필요할수도있지만 유료로 쓰지않을거고 어느정도 회사크기가 있게되면 확장성이 최우선이기때문에 유지보수가 쉬워야함

#### 5.2 비판 분석

| 비판 | 타당성 | 대응 |
|------|--------|------|
| 엑셀처럼 자유로워야 함 | O | UI를 스프레드시트 형태로 설계함 |
| VBA 사용자가 넘어갈 메리트 없음 | △ | VBA로 직접 만들 수 있는 사람은 타겟이 아님. "직접 만들 시간이 없는 사람"이 타겟 |
| 인디 개발자는 유료로 안 씀 | O | 기본 기능 무료, 클라우드 기능만 유료 (Open Core 모델) |
| 확장성이 최우선 | O | 오픈소스로 공개하여 직접 수정 가능하게 함 |

#### 5.3 타겟 재정의

비판을 반영하여 타겟을 명확히 했습니다:

**타겟**:
- 1~5인 규모의 인디 개발자/팀
- 전담 밸런스 디자이너가 없는 환경
- 엑셀은 쓰지만 VBA 스크립트를 직접 짤 시간/역량이 없는 사람
- "이 정도면 충분하다"는 80% 솔루션을 원하는 사람

**타겟이 아닌 사람**:
- 대형 스튜디오
- VBA/Apps Script를 자유자재로 다루는 사람 (직접 만드는 게 나음)
- 100% 커스텀이 필요한 사람 (확장성 한계)

다만 인디 개발자/팀에서 출발하되, 장기적으로는 대형 스튜디오에서도 사용할 수 있는 수준으로 확장하는 것이 목표입니다.

---

### 6. 설문 결과 기반 의사결정

설문조사와 피드백을 바탕으로 다음 결정을 내렸습니다.

#### 6.1 핵심 기능 우선순위

| 우선순위 | 기능 | 근거 |
|----------|------|------|
| 1 | 사용 편의성 (스프레드시트 UI) | 설문 Q10 1위 |
| 2 | 게임 엔진 연동 | 설문 Q10 2위 |
| 3 | 시각화 | 설문 Q10 3위 |
| 4 | DPS/EHP/TTK 자동 계산 | 설문 Q8 주관식 |
| 5 | 시뮬레이션 | 커뮤니티 반응 |

#### 6.2 수익 모델

| 구분 | 기능 | 가격 |
|------|------|------|
| 무료 | 모든 로컬 기능, 수식, 시뮬레이션, 내보내기 | 0원 |
| 유료 | 클라우드 저장, 버전 히스토리, 팀 협업 | 월 5,000원 이하 |

근거: 설문 Q11에서 대다수가 "무료~월 5천원"을 선택

#### 6.3 명시적으로 하지 않는 것

피드백 "리얼 밸런스를 다 맞추는 건 지옥"을 반영:

- 게임을 만들어주는 도구가 아닙니다
- AI가 밸런스를 자동으로 잡아주지 않습니다 (이상치 탐지만 합니다)
- 모든 게임의 모든 케이스를 커버하지 않습니다 (80% 솔루션)
- 게임 엔진 플러그인이 아닙니다 (데이터 내보내기만 제공)

---

### 7. 추가 반응: 러브콜

프로젝트를 홍보하면서 예상치 못한 반응도 있었습니다:

- "프로젝트 상용화를 위해 뛰어다니는 게 맘에 들었다"
- "사원 수 100명 이상, 캐주얼 게임 운영 중인 회사에서 본격적으로 만들어보는 건 어떻겠냐"

이런 반응은 "시장에서 이 문제를 인식하고 있다"는 신호로 해석했습니다.

---

### 8. 결론: 무엇을 배웠는가

#### 8.1 확인된 긍정 신호

1. **문제는 실재합니다**: 인디 개발자들이 밸런싱 도구의 부재를 느끼고 있습니다
2. **관심은 있습니다**: 홍보 시 즉각적인 긍정 반응이 있었습니다
3. **사용 의향은 있습니다**: 설문에서 대다수가 "사용하겠다"고 응답했습니다

> 다만 12명이라는 표본 크기의 한계가 있으므로, 이 결과는 통계적 검증이 아닌 초기 방향성 확인으로 해석했습니다.

#### 8.2 주의할 것

1. **"관심"과 "실제 사용"은 다릅니다**: 출시 후 실제 사용률을 봐야 합니다
2. **유료 전환은 어렵습니다**: 무료 기능이 충분하면 굳이 돈을 내지 않습니다
3. **범위 설정이 중요합니다**: "만능 툴"을 목표로 하면 안 됩니다

#### 8.3 다음 단계

1. MVP 출시 → 실제 사용 데이터 수집
2. 피드백 기반 개선 (구간별 성장 곡선, 전투 로그 export 등)
3. 클라우드 기능 개발 → 유료화 테스트

---

## 2. 밸런스 데이터 관리 툴이란

*원문 발행일 2025-12-14*

![](/uploads/project/Balruno/game-design-tool-intro/image.png)
![](/uploads/project/Balruno/game-design-tool-intro/image-2.png)

---

### 문제 인식

게임 밸런싱에는 반복되는 필요가 있습니다. DAMAGE와 SCALE, TTK 같은 공식을 바로 적용할 수 있어야 하고, 캐릭터 스탯을 바꾸면 관련 데이터가 자동으로 다시 계산되어야 하며, 성장 곡선과 능력치 비교를 차트로 빠르게 확인할 수 있어야 하고, JSON이나 CSV로 게임 엔진에 바로 넣을 수 있어야 합니다.

엑셀이나 구글 시트로도 되긴 합니다. 다만 게임 특화 함수가 없어서 매번 수식을 직접 쓰거나 VBA 스크립트를 유지보수해야 합니다. 이 판단이 실제 개발자들의 생각과 맞는지는 [1장](#1-시장조사로-방향을-잡다)에서 따로 확인했습니다.

---

### 이론적 배경

게임 밸런싱 방법론을 다음 자료를 기반으로 학습했습니다.

- GDC Vault: Zynga의 공식 기반 접근법, Slay the Spire 데이터 기반 밸런싱
- NDC 2018: 밸런스 기획 프로세스 세션
- 학술자료: Csikszentmihalyi의 Flow 이론, 게임 경제학의 Faucet/Sink 모델
- Ian Schreiber의 Game Balance Concepts 강의

![](/uploads/project/Balruno/game-design-tool-intro/where-study.png)

추가로 실무 게임 개발 블로그에서 TTK/DPS 계산 공식, RPG 성장 곡선 설계를 참고했고, LoL 등 다수 게임의 데미지 공식(방어력 수확체감 `100/(100+DEF)`, 방어관통 시스템)을 분석했습니다. 이 공식은 LoL에서 사용하는 형태이며, WoW 등 다른 게임에서는 레벨에 따라 상수가 달라지는 변형을 사용합니다.

**학습을 통해 정리한 밸런스 데이터 관리 사이클:**

1. 기준 설정
2. 수식화
3. 시각화
4. 검증

게임마다 공통으로 쓰이는 수식(데미지 감소율, 성장 곡선, TTK)이 존재하고, 통계적 검증 방법으로 Wilson Score Interval, 몬테카를로 시뮬레이션을 적용할 수 있습니다.

---

### 핵심 기능

#### 게임 특화 수식 (70개 이상)

| 수식 | 설명 |
|------|------|
| `DAMAGE(atk, def)` | 감소율 공식 `atk * (100 / (100 + def))` |
| `SCALE(base, level, rate, type)` | 4가지 성장 곡선 지원 |
| `TTK(hp, dps)` | 정확한 킬타임 계산 |
| `DPS(atk, speed, crit, critDmg)` | 초당 데미지 계산 |
| `EHP(hp, def)` | 유효 체력 계산 |
| `DIMINISH(value, soft, hard)` | 수확체감 계산 |
| `REF("시트명", "행이름", "컬럼명")` | 시트 간 자동 참조 |

시트 간 자동 참조를 통해 데이터가 자동으로 재계산됩니다. 순환 참조가 감지되면 경고를 표시합니다.

#### 게임 특화 시각화

![](/uploads/project/Balruno/game-design-tool-intro/game-specialized-visualization-created.png)

1. **성장 곡선 차트**: Linear, Exponential, Logarithmic, Quadratic, S-Curve 비교
2. **레이더 차트**: 캐릭터/아이템 능력치 비교
3. **TTK/DPS 계산기**: 무기 효율 분석

#### 게임 엔진 연동

Unity, Godot, Unreal 코드를 자동으로 생성합니다.

| 엔진 | Import | Export |
|------|--------|--------|
| Unity | `.json`, `.cs` | ScriptableObject + JSON |
| Godot | `.json`, `.gd` | Resource + JSON |
| Unreal | `.csv`, `.h` | USTRUCT + CSV |

- `.cs` 파일에서 public 필드 및 `[SerializeField]` 자동 추출
- `.gd` 파일에서 `@export` 변수 자동 추출
- `.h` 파일에서 `UPROPERTY` 필드 자동 추출

#### 몬테카를로 시뮬레이션

- 1,000 ~ 100,000회 전투 시뮬레이션
- Wilson 신뢰구간 95% 통계 분석
- 1:1, 1:N, N:N 팀 전투 지원
- 다양한 데미지 공식 (단순, MMORPG, 퍼센트, 랜덤)
- 방어관통 시스템 (LoL 스타일 기반, 고정/비율 관통 지원)
- 스킬 쿨타임, HP 트리거, 시너지 로직 지원
- 턴별 전투 로그 상세 재생

#### 밸런스 분석

- Z-score 기반 이상치 자동 감지
- 파워 커브 분석 (선형/지수/로그)
- Perfect Imbalance 분석 (가위바위보 상성)
- 승률 매트릭스 생성
- 피어슨 상관관계 분석
- 목표 기반 역산 (Goal Solver): 원하는 TTK에서 필요한 DPS를 역산

---

### 현재 한계점

| 한계 | 설명 |
|------|------|
| 구간별 복합 곡선 미지원 | "1~10렙은 지수, 10~50렙은 고정" 같은 복합 곡선 미지원 |
| 특수 효과 시뮬 미지원 | 무적, 부활 같은 특수 스킬은 시뮬레이션 미지원 |
| 사용자 정의 수식 없음 | 현재는 내장 함수만 사용 가능, 커스텀 공식 조합 기능은 개발 예정 |
| 협업 기능 없음 | 개인 사용 목적, 클라우드/팀 기능은 추후 추가 예정 |
| 자동 밸런싱 AI 아님 | 이상치 탐지만 제공, 수치 자동 조절 기능 없음 |

![](/uploads/project/Balruno/game-design-tool-intro/limitations.png)

---

### 향후 확장 계획

1. 커뮤니티 템플릿: 사용자가 만든 모듈을 공유/조합 가능하게
2. 구간별 복합 곡선 지원: "1~10렙 지수, 10~50렙 고정" 같은 구조
3. 사용자 정의 수식: 캡슐화된 기능들의 조합 방식
4. 특수 효과 시뮬: 무적, 부활 등
5. 계정 기반 클라우드 저장
6. 실시간 협업
7. AI 이상치 경고 (자동 밸런싱이 아닌 탐지)

최종 목표는 경제 시스템, 가챠/뽑기 시스템 설계, 로그라이크 아이템 시너지까지 지원하는 것입니다.

---

### 수익 모델

기본 기능은 무료로 제공합니다. 추후 클라우드 저장, 협업 기능 같은 부분을 유료화할 계획입니다.

---

### FAQ

**Q: 구글 시트에 Apps Script를 쓰면 되지 않나?**
A: 가능합니다. 다만 스크립트 작성과 유지보수 시간을 고려하면 게임 개발에 집중하는 편이 나을 수 있습니다.

**Q: 전투 시뮬레이터가 있는가?**
A: 몬테카를로 시뮬레이션으로 1,000~100,000회 전투를 돌릴 수 있고, Wilson 신뢰구간 95%로 통계적 검증이 가능합니다. 1:1, 1:N, N:N 팀 전투를 지원합니다.

**Q: 브라우저 캐시를 지우면 데이터가 날아가는가?**
A: IndexedDB를 사용하므로 일반 캐시 삭제로는 날아가지 않습니다. 다만 브라우저 데이터 전체 삭제 시에는 소실될 수 있으므로 백업이 필수입니다.

**Q: 게임 엔진 코드 내보내기가 되는가?**
A: Unity ScriptableObject(.cs + .json), Godot Resource(.gd + .json), Unreal USTRUCT(.h + .csv) 형태로 자동 생성합니다.

**Q: 이론적 근거가 있는가?**
A: Flow 이론, Faucet/Sink 모델, Ian Schreiber의 Game Balance Concepts, NDC/GDC 발표 자료 등을 기반으로 했습니다.

**Q: TTK 계산에서 왜 단순히 HP/DPS로 나누면 안 되는가?**
A: 마지막 타격에는 쿨다운이 없기 때문입니다. 예를 들어 공격 속도 10회/초, 1타당 10데미지인 무기(DPS 100)로 HP 100인 적을 공격하면, 10번째(마지막) 타격 후 대기 시간이 없으므로 TTK는 (10-1)×0.1 = 0.9초입니다.

**Q: 노션이나 에어테이블을 쓰면 되지 않는가?**
A: 노션에는 `DAMAGE(atk, def)` 같은 게임 특화 함수가 없습니다. 시트 간 자동 연동이나 성장 곡선 차트도 마찬가지입니다. 노션은 범용 툴이고, 이 툴은 게임 밸런스에 특화되어 있습니다.

**Q: MVP가 시트+수식+저장이면 그냥 엑셀 아닌가?**
A: 엑셀에는 `SCALE(base, level, rate, "exponential")` 같은 게임 특화 함수가 없습니다. 순환 참조 감지 경고, 몬테카를로 시뮬레이션, 게임 엔진 코드 자동 생성도 엑셀에는 없는 기능입니다.

**Q: AI한테 시뮬레이션 돌리는 것보다 장점이 무엇인가?**
A: AI는 매번 컨텍스트를 설명해야 하고, 대화가 끊기면 다시 설명해야 하며, 데이터가 축적되지 않습니다. 수치를 바꿀 때마다 다시 물어봐야 합니다. 간단한 일회성 계산은 AI가 빠르지만, 지속적인 데이터 관리와 수정이 필요한 상황에서는 전용 툴이 유리합니다.

**Q: 웹 기반이면 오프라인에서 못 쓰는가?**
A: IndexedDB는 로컬 저장이라 인터넷 없이도 작동합니다.

---

## 3. MVP 15가지 기능

*원문 발행일 2026-01-19*

MVP(Minimum Viable Product)로 공개한 발루노의 15가지 핵심 기능을 정리해 봤습니다.

---

### 1. 계산기

![](/uploads/project/Balruno/balruno-mvp-release/calculator-feature.png)

게임 밸런싱에 필요한 단순 수치 계산을 수행하는 도구입니다. DPS, EHP, TTK 등 게임 특화 수식을 바로 적용할 수 있습니다.

---

### 2. 비교분석

![](/uploads/project/Balruno/balruno-mvp-release/compareanalysis-feature.png)

같은 시트에 있는 데이터를 레이더 차트와 막대 차트로 비교하는 기능입니다. 분포 히스토그램으로 특정 열의 데이터 분포를 확인할 수 있습니다.

---

### 3. 성장곡선 차트

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

### 4. 프리셋 비교

![](/uploads/project/Balruno/balruno-mvp-release/compare.png)

시트의 스냅샷을 찍어 임시 저장한 뒤, 값을 변경했을 때 이전 상태와 비교하는 기능입니다. 밸런스 패치 전후 수치 변화를 확인할 때 유용합니다.

---

### 5. 불균형 감지

![](/uploads/project/Balruno/balruno-mvp-release/image.png)

Z-score 기반으로 행의 값이 급격히 상승하거나 감소하면 경고하는 시스템입니다.

---

### 6. 목표 역산 (Goal Solver)

![](/uploads/project/Balruno/balruno-mvp-release/image-2.png)

원하는 결과값(예: TTK 3초)을 입력하면 필요한 수치(예: DPS 500)를 역산하는 기능입니다.

---

### 7. 밸런스 분석

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

### 8. 경제 시뮬레이터

![](/uploads/project/Balruno/balruno-mvp-release/simulator-1.png)
![](/uploads/project/Balruno/balruno-mvp-release/simulator-2.png)
![](/uploads/project/Balruno/balruno-mvp-release/simulator-3.png)

온라인 게임과 싱글 게임 모드를 지원합니다. 게임 내 재화 흐름을 시뮬레이션하여 인플레이션과 디플레이션을 예측하는 기능입니다.

---

### 9. DPS 분산 분석

![](/uploads/project/Balruno/balruno-mvp-release/dps-analysis-1.png)
![](/uploads/project/Balruno/balruno-mvp-release/dps-analysis-2.png)
![](/uploads/project/Balruno/balruno-mvp-release/dps-analysis-3.png)

DPS 시뮬레이션을 돌려 분석 결과를 그래프로 확인하고, 빌드 간 비교가 가능합니다.

---

### 10. 곡선피팅

![](/uploads/project/Balruno/balruno-mvp-release/curve-1.png)
![](/uploads/project/Balruno/balruno-mvp-release/curve-2.png)
![](/uploads/project/Balruno/balruno-mvp-release/curve-3.png)

그래프를 직접 드로잉하면 해당 곡선에 맞는 수식 코드를 자동 생성하는 기능입니다.

---

### 11. 수식 도우미

![](/uploads/project/Balruno/balruno-mvp-release/formula.png)

현재 툴에서 사용 가능한 함수 목록과 공식 설명을 제공합니다. 엑셀의 VLOOKUP 대신 자체 참조 문법을 사용하고 있습니다.

```
이전행.컬럼이름
=글로벌설정.BASE_ATK * ATK배율
```

기획자가 직관적으로 이해할 수 있는 수식 체계를 목표로 설계했습니다.

---

### 12. 밸런스 검증기

![](/uploads/project/Balruno/balruno-mvp-release/balance-verification.png)

유닛을 만들기 전에 역할에 맞는 밸런스인지 이론적으로 검증하는 기능입니다. 사전 검증 단계로 활용합니다.

---

### 13. 난이도 곡선

![](/uploads/project/Balruno/balruno-mvp-release/curve-1-2.png)

스테이지별 난이도를 시각화합니다.

![](/uploads/project/Balruno/balruno-mvp-release/curve-2-2.png)

게임의 전체 난이도 흐름을 확인하고, 예상 플레이타임(일/시간 단위)을 측정할 수 있습니다.

---

### 14. 전투 시뮬레이션

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

### 15. 엔티티 정의

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

### 성능

![](/uploads/project/Balruno/balruno-mvp-release/image-3.png)

스프레드시트 특성상 렌더링 최적화가 필수적이었습니다. requestAnimationFrame 기반 throttle, DOM 직접 조작, Set 자료구조를 활용한 O(1) 조회 등 오픈소스 코드를 분석해서 적용했습니다.

---

## 4. 테이블과 입력 UX 기술 디테일

*원문 발행일 2026-01-23*

스프레드시트 UX의 체감은 결국 **셀 인터랙션의 디테일**에서 결정됩니다. Balruno에서 이 부분을 다듬어가며 가장 시간을 많이 쓴 세 가지, 즉 드래그 성능, 셀↔수식바 동기화, IME 입력 처리를 한 글에 모았습니다.

### 1. 테이블 드래그 성능: O(N)에서 O(1)로

#### 1.1 문제

- **환경**: React 18 + TanStack Table 기반 스프레드시트 컴포넌트 (`SheetTable.tsx`, 약 2,000줄)
- **현상**: 마우스 드래그로 셀 범위 선택 시 눈에 띄는 lag, 10행 이상에서 빠르게 드래그하면 프레임 드랍
- **목표**: 60fps 유지 + 100×10 규모에서도 지연 없이 동작

#### 1.2 원인 분석

React DevTools Profiler + 코드 정적 분석으로 세 지점이 병목으로 드러났습니다.

**문제 1 — O(N) 시간복잡도의 셀 상태 조회**

```typescript
// 매 셀 렌더링마다 O(N) 조회
const isCellSelected = useCallback(
  (rowId: string, columnId: string) =>
    selectedCells.some((c) => c.rowId === rowId && c.columnId === columnId),
  [selectedCells]
);
```

- 100개 셀이 선택된 상태에서 500개 셀 렌더링 → `500 × 100 = 50,000`번 비교
- 드래그 중 매 프레임마다 반복

**문제 2 — 과도한 useMemo 의존성 (28개)**

```typescript
const columns = useMemo(() => {
  /* 컬럼 정의 ~400줄 */
}, [
  sheet.columns, sheet.rows, editingCell,
  // ... 25개 더
  fillPreviewCells,  // 드래그마다 변경됨
  moveTargetCell,    // 드래그마다 변경됨
]);
```

- `fillPreviewCells`/`moveTargetCell`이 의존성에 포함 → 마우스 이동마다 컬럼 재생성 → 테이블 전체 재렌더 cascade

**문제 3 — Throttle 미적용**

- `mousemove`는 마우스 폴링 레이트에 따라 초당 60–120+회 발생
- 매 이벤트마다 `setSelectedCells` → 리렌더 → 브라우저 렌더 사이클(16.67ms)보다 빈번한 상태 업데이트

#### 1.3 1차 최적화: Set 자료구조 + Throttle

**Set 기반 O(1) 조회:**

```typescript
const cellKey = (rowId: string, columnId: string) => `${rowId}:${columnId}`;

const selectedCellsSet = useMemo(
  () => new Set(selectedCells.map(c => cellKey(c.rowId, c.columnId))),
  [selectedCells]
);

const isCellSelected = useCallback(
  (rowId: string, columnId: string) => selectedCellsSet.has(cellKey(rowId, columnId)),
  [selectedCellsSet]
);
```

기존 배열 구조는 유지하고 useMemo로 Set만 파생해 기존 로직 변경을 최소화했습니다.

**Throttle 유틸리티 (16ms = 60fps):**

```typescript
function throttle<T extends (...args: Parameters<T>) => void>(fn: T, delay: number): T {
  let lastCall = 0;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  return ((...args: Parameters<T>) => {
    const now = Date.now();
    const remaining = delay - (now - lastCall);
    if (remaining <= 0) {
      if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
      lastCall = now;
      fn(...args);
    } else if (!timeoutId) {
      timeoutId = setTimeout(() => {
        lastCall = Date.now(); timeoutId = null; fn(...args);
      }, remaining);
    }
  }) as T;
}
```

**1차 결과:**

| 지표 | 개선 전 | 개선 후 | 개선 |
|---|---|---|---|
| 셀 상태 조회 복잡도 | O(N) | O(1) | — |
| 100셀 선택 + 500셀 렌더 시 비교 | ~50,000회 | ~500회 | **99% 감소** |
| 드래그 중 state 업데이트 빈도 | ~200회/초 | ~60회/초 | **70% 감소** |

#### 1.4 2차 최적화: Excel 수준으로

오픈소스 스프레드시트(Handsontable, AG Grid, Google Sheets) 분석 후 추가 기법 도입.

**기법 1 — `requestAnimationFrame` 기반 throttle:**

```typescript
function rafThrottle<T extends (...args: any[]) => void>(fn: T): T {
  let rafId: number | null = null;
  let lastArgs: any[] | null = null;
  return ((...args: any[]) => {
    lastArgs = args;
    if (rafId === null) {
      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (lastArgs) fn(...lastArgs);
      });
    }
  }) as T;
}
```

브라우저 V-Sync와 동기화되어 프레임 드랍 최소화 + 백그라운드 탭에서 자동 일시중지.

**기법 2 — DOM 직접 조작 (드래그 중 React 우회):**

```typescript
const handleCellMouseEnterThrottled = useMemo(
  () => rafThrottle((rowId: string, columnId: string) => {
    if (!isDraggingRef.current) return;
    const rangeCells = calculateDragSelection(...);

    const tableContainer = tableContainerRef.current;
    if (tableContainer) {
      tableContainer.querySelectorAll('[data-cell-selected="true"]').forEach(el => {
        el.removeAttribute('data-cell-selected');
        (el as HTMLElement).style.outline = '';
      });
      rangeCells.forEach(cell => {
        const cellEl = tableContainer.querySelector(
          `[data-cell-id="${cellKey(cell.rowId, cell.columnId)}"]`
        ) as HTMLElement;
        if (cellEl) {
          cellEl.setAttribute('data-cell-selected', 'true');
          cellEl.style.outline = '2px solid var(--primary-blue)';
        }
      });
    }

    pendingSelectionRef.current = rangeCells;  // mouseup 시 React state로 동기화
  }),
  [calculateDragSelection]
);
```

- 드래그 중에는 Virtual DOM Diff + Re-render 사이클을 우회
- mouseup 시점에만 React state 동기화
- 셀에 `data-cell-id` 속성 추가 (단, data-attribute selector는 class selector 대비 ~3배 느림. 대규모 테이블에서는 JS Map으로 셀 요소를 직접 추적하는 편이 더 효율적)

**기법 3 — CSS `will-change` 힌트:**

```typescript
style={{ willChange: 'background, outline' }}
```

브라우저가 별도 합성 레이어로 분리. 단 `background`/`outline`은 compositor-only 속성이 아니므로 해당 레이어 내 paint는 여전히 발생. 진정한 GPU 합성만으로 처리되는 속성은 `transform`/`opacity`.

**2차 결과:**

| 지표 | 1차 후 | 2차 후 |
|---|---|---|
| 드래그 중 React 리렌더 | 매 프레임 | **0회** (mouseup 시 1회) |
| 스타일 업데이트 방식 | Virtual DOM Diff | 직접 DOM 조작 |
| 프레임 동기화 | setTimeout (불완전) | requestAnimationFrame (완전) |

#### 1.5 핵심 교훈

- **자료구조가 곧 성능**: 같은 기능도 Array vs Set에서 O(N) vs O(1) 차이
- **useMemo 의존성은 최소**: 빈번히 바뀌는 값을 의존성에 넣으면 cascade 재렌더
- **빈번한 UI 업데이트는 React를 우회**: 직접 DOM 조작 + ref로 중간 상태 보관, 완료 시점에만 state 동기화

---

### 2. 셀↔수식바 동기화: debounce → rafThrottle → 즉시 sync

#### 2.1 결론 먼저

> **오픈소스 스프레드시트들은 debounce/throttle 없이 즉시 동기화한다.**

```typescript
onInput={(e) => {
  const val = (e.target as HTMLInputElement).value;
  setFormulaBarValue(val);  // 즉시 동기화, 별도 throttle 없음
}}
```

도달까지 두 번의 우회를 거쳤습니다.

#### 2.2 1차: debounce(150ms)

```typescript
const debouncedSetFormulaBarValue = useMemo(
  () => debounce((value: string) => setFormulaBarValue(value), 150),
  []
);
```

타이핑 후 150ms 지연 발생 → UX 저하.

#### 2.3 2차: rafThrottle (60fps)

```typescript
const throttledSetFormulaBarValue = useMemo(
  () => rafThrottle((value: string) => setFormulaBarValue(value)),
  []
);
```

더 빠르지만 여전히 프레임 단위 지연.

#### 2.4 3차: 오픈소스 분석 후 즉시 동기화

| 라이브러리 | 핵심 방식 | throttle/debounce |
|---|---|---|
| Fortune-Sheet | 에디터 내용을 수식바에 직접 복사 | **없음** |
| Univer | RxJS Observable 공유 | **없음** |
| Luckysheet | jQuery로 에디터 내용을 수식바에 직접 복사 | **없음** |

**Fortune-Sheet 실제 코드** (`packages/core/src/modules/formula.ts`):

```typescript
$editor.textContent = value;
if ($copyTo) $copyTo.textContent = value;
```

오픈소스가 즉시 동기화하는 이유:

- Fortune-Sheet/Luckysheet: React를 안 쓰고 DOM 직접 조작이라 상태 관리 오버헤드 자체가 없음
- Univer: RxJS Observable로 값 공유, 리렌더 없이 동기화

본 프로젝트에서 즉시 동기화가 가능한 이유:

1. **수식바는 독립 컴포넌트**: 테이블 전체 리렌더 없음
2. **React 18 batching**: 여러 setState가 자동으로 하나로
3. **문자열만 업데이트**: 연산 부하 거의 없음

#### 2.5 교훈

| 접근 | 결과 |
|---|---|
| 추측으로 최적화 | 불필요한 복잡성 추가 |
| 오픈소스 분석 | 검증된 패턴 발견 |

> *"Premature optimization is the root of all evil"*. 실제로 문제가 되는지 먼저 확인하고, 오픈소스에서 검증된 방식을 따르는 게 정답입니다.

---

### 3. IME(한글·중국어·일본어) 입력 처리

#### 3.1 문제

셀 선택 상태에서 한글 입력 시 자음/모음이 분리:

- *"안녕"* 입력 → *"ㅇㅏㄴㄴㅕㅇ"* 으로 표시

#### 3.2 원인

1. **React Controlled Component 문제**: `<input value={state} onChange={...} />`가 IME 조합 중에 `value`를 강제 재설정 → 조합 컨텍스트 끊김
2. **편집 모드 전환 시 컴포넌트 재생성**: `compositionstart`에서 `setEditingCell()` 호출 → 새 input 렌더 → 기존 IME 조합 상태 손실

#### 3.3 해결: 4가지 패턴

**(1) Uncontrolled component:**

```tsx
<input
  defaultValue={editValue}
  onInput={(e) => {
    if (!isComposingRef.current) {
      setFormulaBarValue(e.target.value);
    }
  }}
/>
```

**(2) Composition 이벤트 추적:**

```tsx
const isComposingRef = useRef(false);

<input
  onCompositionStart={() => { isComposingRef.current = true; }}
  onCompositionEnd={(e) => {
    isComposingRef.current = false;
    setFormulaBarValue(e.currentTarget.value);
  }}
/>
```

**(3) 숨겨진 input으로 초기 입력 처리 (Handsontable 패턴):**

```tsx
<input
  ref={hiddenInputRef}
  style={{ position: 'fixed', top: -9999, left: -9999 }}
  onCompositionStart={() => { isComposingRef.current = true; }}
  onCompositionEnd={(e) => {
    isComposingRef.current = false;
    if (selectedCell && !editingCell) {
      const value = e.currentTarget.value;
      setEditingCell({ rowId: selectedCell.rowId, columnId: selectedCell.columnId });
      setEditValue(value);
      e.currentTarget.value = '';
    }
  }}
/>
```

**(4) 키보드 이벤트에서 IME 감지:**

```tsx
const handleKeyDown = (e: KeyboardEvent) => {
  if (e.nativeEvent.isComposing || e.keyCode === 229) return;
  // 일반 키 처리...
};
```

#### 3.4 전체 흐름

![IME 처리 전체 흐름](/uploads/project/Balruno/ime-input-handling/full.png)

#### 3.5 주의사항

- **Enter 키**: IME 조합 중 Enter는 조합 확정용. `isComposing` 체크해 폼 제출 방지.
- **Blur 이벤트**: 포커스 잃을 때 `isComposingRef` 초기화.
- **접근성**: 숨겨진 input은 `aria-hidden="true"`, `tabIndex={-1}` 설정.

---

### 정리

| 영역 | 핵심 도구 | 핵심 결정 |
|---|---|---|
| 드래그 성능 | Set + rafThrottle + DOM 직접 조작 + `data-cell-id` | 드래그 중 React 우회, mouseup 시점에만 state 동기화 |
| 셀↔수식바 동기화 | 즉시 setState | 추측으로 최적화하기 전에 오픈소스 검증 패턴부터 확인 |
| IME 입력 | Uncontrolled + Composition + 숨김 input | Controlled component를 IME 입력에 직접 결합하지 말 것 |

세 영역 모두 *"React 자체의 추상화를 그대로 따르면 스프레드시트 UX는 60fps에 도달하지 못한다"* 는 점이 공통 결론입니다. ref + DOM 직접 접근 + 브라우저 API(`requestAnimationFrame`, Composition Events)를 적극적으로 쓸 때만 Excel/Google Sheets 수준의 체감이 나옵니다.

---

## 5. 첫 사용자 피드백 24건

*원문 발행일 2026-01-28*

### 깊이 판 것 셋

실제 사용자에게 받은 피드백으로 24개 항목을 고쳤습니다.

24개 중 원인까지 파고든 건 셋이었습니다. 나머지는 원인이 분명해서 고치는 데 오래 걸리지 않았습니다.

#### 입력값이 잘려서 저장되던 버그

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

#### 드래그 선택이 버벅이던 문제

100행 20열에서 마우스로 드래그하면 0.5초쯤 UI가 밀리면서 선택 박스가 커서를 못 따라왔습니다. mousemove가 초당 60~120회 발생하는데 매번 setState를 호출해 2000개 셀이 전부 리렌더링되고 있었습니다.

requestAnimationFrame throttle과 DOM 직접 조작, 좌표 캐싱으로 프레임 처리 시간을 45ms에서 3ms로 줄였습니다. 원인 분석과 O(N)에서 O(1)로 바꾼 자료구조 변경까지는 [4장](#4-테이블과-입력-ux-기술-디테일)에 따로 적었습니다.

#### 모달마다 ESC 동작이 달랐던 문제

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

### 나머지 21개

#### 테이블 조작

셀과 셀 사이 1px 경계선을 클릭하면 아무것도 선택되지 않던 문제는 `box-sizing: border-box`로 잡고, 그 경계에 열 너비 리사이즈 핸들도 같이 붙였습니다. 헤더 경계를 드래그하면 크기가 바뀌고 더블클릭하면 내용에 맞게 자동 조절됩니다.

테이블 바깥에서 드래그를 시작해도 선택이 되도록 컨테이너 전체에 mousedown을 걸었고, 반대로 테이블 밖을 클릭하면 선택이 풀리도록 document mousedown으로 처리했습니다. 행 번호를 클릭하면 행 전체가, Ctrl이나 Shift와 함께 열 헤더를 클릭하면 열 전체가 선택됩니다. 선택 영역은 TSV로 복사해서 Excel이나 Google Sheets와 양방향으로 오갑니다.

`<label>` 안에 `<button>`이 있어서 클릭이 두 번 발생하던 체크박스는 div 단일 요소로 바꿔서 해결했습니다.

#### 편집 경험

Zustand 기반 히스토리 스토어로 Ctrl+Z와 Ctrl+Y를 최대 50단계까지 지원합니다. 키보드 네비게이션은 편집 모드 여부로 분기해서, 편집 중에는 Enter가 저장이고 Escape가 취소이며 선택 모드에서는 화살표로 셀을 옮깁니다. 수식을 입력하면 파싱해서 참조 셀을 색상별로 하이라이트합니다. 저장은 Zustand persist로 자동 처리하고 헤더에 상태를 띄웁니다.

#### 보기와 일관성

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

#### 도구 목록과 스크롤

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

### 개선 요약

| 분류 | 항목 수 | 주요 내용 |
|------|--------|----------|
| 버그 수정 | 7개 | 입력값 손실, 체크박스 토글, 선택 해제, 키보드 네비게이션 등 |
| 성능 최적화 | 3개 | RAF 기반 드래그, DOM 직접 조작, 범위 캐싱 |
| UI 개선 | 6개 | 폰트 크기, 색상 대비, 레이아웃 정렬, 파비콘 등 |
| UX 개선 | 8개 | ESC 닫기, 도움말 연동, 스크롤, Undo/Redo, 자동 저장 등 |
| 신규 기능 | 6개 | 외부 드래그, 리사이즈, 드래그 삭제, 수식 하이라이트 등 |

---

### 기술 스택

- **Frontend**: Next.js 16, React 19, TypeScript
- **상태 관리**: Zustand (persist middleware로 localStorage 동기화)
- **스타일링**: Tailwind CSS, CSS Variables (다크모드)
- **테이블**: TanStack Table v8
- **차트**: Recharts
- **성능 최적화**: requestAnimationFrame, DOM 직접 조작, useRef 패턴

---

## 6. 아키텍처와 인프라 회고

*원문 발행일 2026-05-10*

### 다루는 데이터

앞 장까지가 무엇을 왜 만드는지에 대한 기록이라면, 이 장은 그걸 어떤 구조로 받아냈는지에 대한 기록입니다.

#### 데이터 영역

| 영역 | 위치 | 변경 빈도 | 충돌 빈도 | 처리 패턴 |
|------|------|----------|----------|----------|
| 시트 셀 | `projects.data` JSONB 안 sheets[].rows[].cells[] | 매우 높음(분당 수십 회) | 중간 | 셀 이벤트 op log |
| 시트 트리 | `projects.sheet_tree` JSONB | 중간 | 낮음 | 트리 op log |
| 문서 트리 | `projects.doc_tree` JSONB | 중간 | 낮음 | 트리 op log |
| 문서 본문 | `documents.binary` BYTEA(yjs) | 매우 높음(글자 단위) | 자동 머지 | yjs CRDT(Hocuspocus) |

#### 사용한 기술

- Backend: Java 25, Spring Boot 4, Spring Security 7, Hibernate 7, Spring Modulith
- DB/Storage: PostgreSQL 18 (JSONB + GIN + 네이티브 UUIDv7), Cloudflare R2 (S3 호환 오프사이트 백업)
- 실시간: Spring WebSocket(시트 셀 + 트리), Hocuspocus + yjs(문서 본문)
- Frontend: Next.js 16 + React 19, Electron 41, Tiptap, TanStack Virtual, y-indexeddb
- Infra/DevOps: OCI Always Free 4대(ARM 12GB ×2 + x86 1GB ×2), Ansible, Nginx + Cloudflare(proxy + Tunnel + Origin Cert 15년 + R2)
- Observability/Test: Prometheus + Loki + Alloy + Grafana + InfluxDB + blackbox_exporter, Sentry SaaS, k6 + JUnit 5 + Testcontainers

#### 시작 전에 정해둔 것들

기준을 먼저 몇 가지 박아뒀습니다. 작업 단위는 셀 하나가 아니라 시트 전체로 본다. 사용자는 정해진 스키마 없이 16종 동적 컬럼을 고른다. 같은 셀이나 트리 노드를 동시에 고쳐도 데이터가 사라지지 않아야 한다. 게임 기획에 필요한 70여 개 함수와 CSV, C# export까지 한 흐름으로 간다. 사용자 100명까지는 단일 인스턴스로 버티고 시트 GET p95는 500ms 이하로 둔다. 데이터의 기준은 항상 서버 DB이고 로컬 저장소는 반응 속도를 위한 캐시로만 쓴다. 매니지드는 나중 문제로 미루고 초반에는 무료 인프라와 단계적 확장만 허용한다.

그다음에는 기술 이름보다 어떤 구조가 가장 단순한지를 먼저 봤습니다. 시트와 문서를 같은 방식으로 동기화할지 나눌지, 시트를 정규화할지 JSON으로 받을지, 매니지드부터 갈지 무료 인프라로 시작할지. 이 세 갈래가 전체 방향을 거의 결정했습니다.

---

### 1. DB 선택: PostgreSQL JSONB로 시트를 직접 받기

스프레드시트는 통째 조회와 부분 수정이 둘 다 많고 컬럼도 고정되어 있지 않습니다. 셀 하나당 row 하나로 정규화하면 1,000행에 30컬럼짜리 시트가 바로 30,000 row가 되고, 시트 GET 한 번이 JOIN과 row 조합 문제로 커집니다.

그래서 질문을 바꿨습니다. DB의 인지도가 아니라 이 도메인을 가장 단순하게 받을 수 있는 저장 방식이 무엇인가입니다.

후보는 정규화 모델, MySQL JSON, PostgreSQL JSONB, MongoDB였습니다. MySQL JSON은 자주 조회하는 경로마다 generated column이나 인덱스를 계속 늘려야 해서 동적 컬럼이 많은 구조에는 운영 부담이 컸습니다. PostgreSQL JSONB는 범용 GIN 인덱스와 `jsonb_set`으로 부분 수정 표현이 더 자연스러웠습니다.

#### 후보 7개를 직접 측정해봤습니다

같은 CRUD API를 MySQL 8 + JSON, PostgreSQL 18 + JSONB, MongoDB 7에 각각 연결해 직접 측정했습니다.  
환경은 50,000 시트, 50 VU, 5분 기준이었고, 비교 대상은 시트 통째 조회 / 내부 검색 / 부분 수정 3종이었습니다.

시트 통째 GET (단건 PK 조회, 50,000건 환경):

| DB | p50 | p95 | p99 | rps | 인덱스 plan |
|----|-----|-----|-----|-----|-------------|
| MySQL 8 + JSON | 3ms | 25ms | 46ms | 860 | `id` PK B-Tree |
| **PostgreSQL 18 + JSONB** | **2ms** | **16ms** | **30ms** | **902** | **`sheets_pkey` (EXPLAIN exec 1.3ms)** |
| MongoDB 7 | 9ms | 45ms | 72ms | 760 | `_id` default |

시트 내부 containment 조회 (`WHERE data @> '{"name": "..."}' LIMIT 10`):

| DB | p50 | p95 | p99 | rps | 인덱스 plan |
|----|-----|-----|-----|-----|-------------|
| MySQL 8 + JSON | 3ms | 23ms | 43ms | 880 | 생성 컬럼 `name_extracted` + B-Tree covering |
| **PostgreSQL 18 + JSONB** | **2ms** | **16ms** | **32ms** | **904** | **`jsonb_path_ops` GIN Bitmap Index Scan (EXPLAIN exec 0.083ms)** |
| MongoDB 7 | 5ms | 35ms | 60ms | 813 | `name` path 인덱스 |

검색은 equality보다 containment 쿼리가 훨씬 많아서, 그 기준으로 비교했습니다.

partial UPDATE (인덱싱된 `name` 필드 patch, `PATCH /sheet/:id/name`, 인덱스 reindex 포함):

| DB | p50 | p95 | p99 | rps | 쿼리 / 인덱스 reindex |
|----|-----|-----|-----|-----|------------------|
| MySQL 8 + JSON | 18ms | 63ms | 95ms | 665 | `JSON_SET(data, '$.name', ?)` + 생성 컬럼 B-Tree reindex |
| PostgreSQL 18 + JSONB | 10ms | 40ms | 94ms | 743 | `jsonb_set(data, '{name}', $::jsonb)` + GIN reindex |
| **MongoDB 7** | **6ms** | **37ms** | **63ms** | **804** | `updateOne({_id}, { $set: {name} })` + path 인덱스 reindex |

읽기는 PostgreSQL이 가장 빨랐고, 쓰기는 MongoDB가 조금 앞섰지만 차이가 크지 않았으며, MySQL은 두 축 모두 애매했습니다.

PostgreSQL을 고른 이유는 둘입니다. 실제 수치에서 읽기가 더 안정적으로 앞섰고, 한정된 인프라에서 DB를 둘로 나누지 않고 하나로 운영하는 편이 백업과 모니터링, 마이그레이션까지 합쳐 단순했습니다.

중간에 크게 헷갈린 적이 있습니다. 처음 측정에서 PostgreSQL 검색이 28초까지 튀었는데, 따라가 보니 DB보다 응답 직렬화와 옵티마이저 선택이 더 큰 문제였습니다. 응답 크기를 줄이고 데이터셋을 키운 뒤 다시 보니 같은 GIN 인덱스에서도 실행 계획이 바뀌었고 검색은 16ms로 정상화됐습니다.

> 벤치마크 숫자를 보기 전에, 지금 내가 진짜 DB를 재고 있는지부터 확인해야 한다.

#### 결과: 한 row에 3 영역 JSONB

최종 모델은 `projects` 한 row 안에 *시트 셀 + 시트 트리 + 문서 트리* 3 영역 JSONB와 각자의 버전 컬럼을 같이 두는 구조였습니다.

```sql
CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,

  data JSONB NOT NULL DEFAULT '{}',                  -- 시트 셀
  data_version BIGINT NOT NULL DEFAULT 1,

  sheet_tree JSONB NOT NULL DEFAULT '[]',            -- 시트 트리(Outline 패턴)
  sheet_tree_version BIGINT NOT NULL DEFAULT 1,

  doc_tree JSONB NOT NULL DEFAULT '[]',              -- 문서 트리(Outline 패턴)
  doc_tree_version BIGINT NOT NULL DEFAULT 1,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_projects_data_gin       ON projects USING GIN(data jsonb_path_ops);
CREATE INDEX idx_projects_sheet_tree_gin ON projects USING GIN(sheet_tree jsonb_path_ops);
CREATE INDEX idx_projects_doc_tree_gin   ON projects USING GIN(doc_tree jsonb_path_ops);
```

3개 영역을 한 row에 둔 건 한 번의 트랜잭션으로 묶기 위해서였고, 버전 컬럼을 따로 둔 건 한 영역의 충돌이 다른 영역까지 막지 않게 하려는 목적이었습니다. 문서 본문만 `documents.binary`로 따로 두고 Hocuspocus가 그대로 읽게 했습니다.

`jsonb_set` patch p95는 8ms로 나왔고, 시트 GET p95는 목표로 둔 500ms를 크게 밑돌았습니다. GIN 인덱스를 붙인 전후 차이는 3장 모니터링 절에 실측으로 남겼습니다.

---

### 2. 실시간 동기화: 시트는 서버 기준, 문서 본문은 yjs

시트와 문서는 둘 다 실시간 공동 편집이 필요했지만 같은 방식으로 다루면 오히려 복잡해졌습니다. 시트는 값과 구조를 서버가 확실히 판단해야 했고, 문서 본문은 글자 단위 자동 병합이 자연스러웠습니다. 그래서 시트는 서버 기준으로, 문서 본문만 yjs로 남겼습니다.

이 판단 덕분에 로컬 중심으로 짜여 있던 흐름도 같이 정리됐습니다. `lib/ydoc.ts` 주변 레거시와 패널, 훅, store, 미사용 export를 걷어내며 시트 영역에서 약 80,000라인을 지웠고, 시트 도메인은 100% 서버 기준으로 바뀌었습니다.

#### WebSocket 하나로 3영역을 묶기

처음에는 시트마다 WebSocket을 따로 열었는데, 한 사용자가 여러 시트를 동시에 보면 연결 수가 그대로 늘었습니다. `/ws/projects/{projectId}` 단일 엔드포인트로 바꾸고 시트 셀과 시트 트리, 문서 트리를 같은 연결에서 처리하도록 합쳤습니다.

메시지마다 꼭 넣은 값은 두 개입니다. 내가 보고 있던 현재 버전, 그리고 이 요청을 구분하는 클라이언트 메시지 ID입니다. 앞의 값이 있어야 늦게 도착한 변경을 거절할 수 있고, 뒤의 값이 있어야 재연결 뒤 같은 요청이 다시 와도 한 번만 처리됩니다.

서버는 한 메시지를 받으면 같은 트랜잭션 안에서 이 순서로 처리합니다.

```sql
BEGIN;

-- 1. 프로젝트 row lock (3 영역 버전 한 번에 읽기)
SELECT data_version, sheet_tree_version, doc_tree_version
FROM projects WHERE id = $project_id FOR UPDATE;

-- 2. baseVersion 분기 체크 (영역별)
IF (cell/row/column AND baseVersion != current data_version) THEN ROLLBACK;
ELSIF (tree.* AND baseVersion != 해당 tree version) THEN ROLLBACK;
END IF;

-- 3. clientMsgId 멱등 체크
IF EXISTS (SELECT 1 FROM op_idempotency WHERE client_msg_id = $clientMsgId) THEN
  ROLLBACK; RETURN cached { type: 'op.acked', version: cached_version };
END IF;

-- 4. cycle 방지 (tree.move 만, 애플리케이션 BFS)
IF (tree.move AND hasAncestorCycle(tree, nodeId, newParentId)) THEN ROLLBACK; END IF;

-- 5. jsonb_set patch + 버전++
UPDATE projects SET data = jsonb_set(data, $path, $value),
                    data_version = data_version + 1,
                    updated_at = NOW()
WHERE id = $project_id;

-- 6. op_idempotency INSERT
INSERT INTO op_idempotency (client_msg_id, user_id, scope_kind, scope_id,
                            result_version, result_payload) VALUES (...);

-- 7. cascade delete (tree.delete 만)
COMMIT;

-- 8. 같은 프로젝트의 다른 세션에 broadcast (sender 제외)
```

좋아요 카운터 같은 단순 증가였다면 Redis INCR이나 큐가 맞았을 겁니다. 하지만 이건 시트 안 특정 위치를 부분 수정하는 일이라 버전 비교와 부분 수정, 중복 방지 조합이 도메인에 더 잘 맞았습니다.

#### cycle 방지와 cascade delete는 애플리케이션에서

`tree.move`에서 자기 자손 밑으로 옮기려는 시도는 무한 루프와 데이터 손상의 원인이라 트랜잭션 안에서 막아야 합니다. PostgreSQL 재귀 CTE로도 되지만, JSONB 트리 walk는 부모와 자식이 row로 나뉜 SQL 트리와 구조가 달라서 애플리케이션 BFS가 단순했습니다.

```java
public boolean hasAncestorCycle(JsonNode tree, String nodeId, String newParentId) {
    Set<String> descendants = new HashSet<>();
    Queue<JsonNode> queue = new LinkedList<>();
    JsonNode node = findNodeInTree(tree, nodeId);
    if (node == null) return false;
    queue.add(node);
    while (!queue.isEmpty()) {
        JsonNode current = queue.poll();
        descendants.add(current.get("id").asText());
        JsonNode children = current.get("children");
        if (children != null) for (JsonNode c : children) queue.add(c);
    }
    return descendants.contains(newParentId);
}
```

자기 자손이 새 부모 안에 들어 있으면 400 `CYCLE_DETECTED`를 던지고 트랜잭션을 롤백해서 patch 자체가 일어나지 않게 했습니다.

cascade delete도 같은 자리에서 처리합니다. 노드의 자손을 BFS로 모아 `doc_tree`에서 함께 제거하고, `documents` 테이블의 해당 row에 `deleted_at`을 찍습니다. 자손 정보를 broadcast에 실어 보내면 클라이언트가 자기 트리를 한 번에 정리합니다. yjs binary의 영구 삭제는 30일 뒤 cron이 맡아서, 실수로 지운 문서는 그 안에 되살릴 수 있습니다.

#### 충돌 정책을 한 표로

3영역에서 어떤 충돌을 어떻게 처리할지 표로 고정해둔 것도 회귀 방지에 도움이 됐습니다.

| 영역 | 시나리오 | 정책 |
|------|---------|------|
| 시트 셀 | 같은 셀 동시 편집 | OCC + baseVersion, 늦은 op 는 conflict + 클라 rollback + 토스트 |
| 시트 셀 | 행 추가 동시 | row id 가 클라 측 UUIDv7 발급이라 ID 충돌 가능성을 실무적으로 무시 가능한 수준으로 낮춤 (동시성 제어 자체는 baseVersion + 트랜잭션 + 멱등키 담당) |
| 시트 셀 | 컬럼 삭제 + 셀 업데이트 동시 | 컬럼 삭제 우선 → 셀 업데이트 conflict |
| 시트 트리 | 노드 이동 동시 | OCC(서버 도착 순으로 늦은 op conflict) |
| 시트 트리 | 자기 자손 밑으로 이동 | 400 CYCLE_DETECTED 즉시 거부 |
| 시트 트리 | 노드 삭제 + 이름 변경 동시 | 삭제 먼저 처리 → 이름 변경 conflict |
| 문서 트리 | (동일 정책) | (동일) |
| 재연결 | 같은 clientMsgId 두 번 | op_idempotency 캐시 응답 |

충돌과 중복 방지, cycle, cascade는 단위 테스트와 통합 테스트로 검증했습니다. 반면 충돌 빈도나 broadcast 지연 같은 운영 지표는 실제 사용자가 붙은 뒤에 채우는 게 의미 있다고 봤습니다.

#### 문서 본문은 yjs로 따로

문서 본문은 Tiptap과 yjs CRDT의 자동 머지가 도메인에 정확히 맞아서 그대로 뒀습니다. Hocuspocus를 Node 22 LTS sidecar로 띄우고 PostgreSQL 어댑터로 `documents.binary`에 영속시켰습니다. `onAuthenticate` 훅에서 Spring이 발급한 15분짜리 협업 토큰을 검증하는 webhook을 호출해 두 프로세스가 같은 사용자 신원을 공유하게 묶었습니다.

---

### 3. 인프라: OCI 4대를 직접 운영하기

베타 시점에 매니지드 통합으로 갔다면 Vercel Pro $20, Fly.io $5, Aurora MySQL 약 $50, MongoDB Atlas M10 약 $25, Datadog Pro 4호스트 $60으로 월 약 $155였습니다. paying user가 없는 단계에서 매달 이 돈을 먼저 쓰는 건 맞지 않아서, OCI Always Free 4대와 Cloudflare 무료 기능으로 직접 운영하기로 했습니다.

| Hostname | 사양 | 역할 | 메모리 |
|----------|------|------|-------|
| prod-app | ARM 12GB | Spring(Docker) + Nginx + Hocuspocus | 약 3GB |
| monitor | ARM 12GB | PostgreSQL 18 + Grafana + Loki + Alloy + Prometheus + Alertmanager + InfluxDB + blackbox_exporter | 약 5GB |
| backup | x86 1GB | pg_dump rsync 수신 + cloudflared + node_exporter | 약 480MB |
| status | x86 1GB | Cloudflare R2 업로드 daemon + node_exporter | 약 150MB |

1GB 머신에는 모니터링을 올리지 않았습니다. Loki와 Prometheus, Grafana를 쪼개 올리기엔 메모리가 너무 작았고, 12GB 한 대에 묶는 편이 안전했습니다.

#### Ansible과 3-2-1 백업

서버 셋업은 Ansible로 묶어서 `ansible-playbook -i inventory.yml site.yml` 한 번이면 4대를 재현할 수 있게 했습니다.

백업은 Primary 하나, 다른 미디어 하나, 오프사이트 하나 원칙입니다. monitor의 PostgreSQL, backup 머신 rsync, Cloudflare R2 순서입니다. OCI Object Storage도 봤지만 같은 벤더 안에서 한 번 더 복제하는 것보다 다른 벤더로 빼는 편이 낫다고 봤습니다. 리전 분산은 paying user가 생기면, 추가 벤더는 사용자 1,000명을 넘으면 붙입니다.

#### 모니터링: Datadog 대신 Grafana 스택

Datadog Pro는 호스트당 $15라 4대면 월 $60입니다. 호스트 4대가 무료라는 전제와 정면으로 부딪혀서 셀프 호스트로 갔습니다. 단일 화면은 유지해야 해서 Grafana 진영을 통째로 채택했습니다. Prometheus가 운영 메트릭을, Loki가 로그를, blackbox_exporter가 HTTP와 TLS probe를 맡습니다. 로그 수집기는 Promtail이 2026-03 EOL이라 신규는 Alloy로 시작했습니다.

k6 부하 결과만 InfluxDB로 따로 뺐습니다. 부하 테스트는 시계열 수가 너무 많아 운영 Prometheus를 오염시키기 쉬웠습니다. 대신 Grafana 한 화면에서 둘을 같이 봅니다.

이 환경이 깔리고 나서야 믿을 만한 수치가 나오기 시작했습니다.

가상 스레드 적용 전후입니다. 셀 업데이트 100 동시 부하에서 함께 본 서버 요청 지연이지 WebSocket 왕복 시간은 아닙니다.

| 메트릭 | 가상 스레드 OFF | 가상 스레드 ON |
|--------|----------------|----------------|
| 서버 요청 p95 | 320ms | 180ms |
| 서버 요청 p99 | 450ms | 240ms |
| 플랫폼 스레드 수(관측) | 약 200 | carrier 약 8 |
| heap 사용 | 380MB | 220MB |

GIN 인덱스 적용 전후입니다.

| 시나리오 | p50 | p95 | p99 |
|---------|-----|-----|-----|
| GIN 인덱스 없음 | 45ms | 280ms | 410ms |
| GIN 인덱스 적용 | 12ms | 65ms | 110ms |

도입했다에서 끝내지 않고 전후를 같이 본 게 중요했습니다. Uptime Kuma를 넣었다가 blackbox_exporter가 같은 일을 하는 걸 알고 걷어낸 것처럼, 측정한 뒤 더 단순한 쪽으로 되돌린 흔적도 그대로 남겼습니다.

#### 무중단 배포: nginx blue/green

기존 `docker compose pull && up -d`는 배포마다 30~60초씩 502가 떨어졌습니다. 사용자가 붙기 전에 없애두고 싶었습니다.

Kamal은 Kamal-proxy가 nginx 자리를 차지해서 Cloudflare Origin Cert 이전과 Ansible 일부 폐기가 필요했고, Kubernetes는 이 단계에서 control plane 운영 부담이 무중단 이익보다 컸습니다. 두 컨테이너를 항상 띄워 weight로 나누는 방식은 RAM이 상시 2.5GB 더 드는데, 무료 인프라에서는 여유 메모리를 비상 자산으로 남기는 쪽이 우선이었습니다. 결국 기존 자산을 살리는 blue/green을 직접 만들었습니다.

```
backend-blue     → 127.0.0.1:8080
backend-green    → 127.0.0.1:8081
hocuspocus-blue  → 127.0.0.1:1234
hocuspocus-green → 127.0.0.1:1235
```

snippet 두 개를 `/etc/nginx/snippets/`에 두고 `balruno-backend-active.conf`를 둘 중 하나의 symlink로 노출합니다. cutover는 `ln -sfn`으로 symlink를 갈아 끼우고 `nginx -s reload`를 호출합니다. graceful reload라 인플라이트 요청이 끝날 때까지 옛 worker가 살아 있습니다. 현재 active 색깔은 `readlink` 한 줄로 봅니다.

핵심은 readiness였습니다. 프로세스가 살아 있는지가 아니라 정말 트래픽을 받을 준비가 끝났을 때만 넘기게 만들고 싶었습니다.

DB 마이그레이션은 expand-contract를 강제했습니다. NOT NULL 컬럼은 nullable에 default를 준 채 먼저 추가해 구버전이 깨지지 않게 하고, 신버전이 그 컬럼을 쓰기 시작한 다음 배포에서 NOT NULL을 겁니다. 컬럼 drop이나 타입 변경 같은 파괴적 변경은 다운타임을 허용하는 별도 슬롯으로 분리하고 PR에 `[destructive]` 태그를 붙입니다.

실측입니다.

```
첫 cutover (옛 단일 컨테이너 → 새 dual slot 이행)
05:33:30  api.balruno.com=502      ← 다운타임 시작
05:33:51  api.balruno.com=200      ← 회복 (≤ 21초)

두 번째 cutover (workflow_dispatch normal mode, green active → blue)
05:38:45 ~ 05:39:41  모든 폴링 200      ← 다운타임 0초
```

첫 전환의 21초는 옛 구조에서 새 구조로 넘어가는 일회성 비용이었고, 두 번째부터는 운영에서도 502 없이 넘어갔습니다.

---

### 4. 인증: OAuth-only + 자체 발급 JWT

비밀번호 로그인을 직접 들고 가면 정책과 해싱, 재설정 메일, 누출 대응, 2FA까지 같이 책임져야 합니다. 1인 운영에서는 너무 큰 책임이었습니다. 매니지드도 부담이었습니다. Auth0는 시작가부터 높고 Clerk나 Cognito도 결국 외부 의존과 비용이 남습니다.

Balruno 사용자는 대부분 GitHub나 Google 계정을 이미 갖고 있어서 OAuth-only가 가장 단순했습니다. 비밀번호와 2FA, 누출 대응은 provider가 맡고 우리는 인증 결과만 받습니다. SMTP도 필요 없어집니다. Magic link는 SMTP가 필수라 뺐고, WebAuthn은 2026년에도 사용자 인지도가 낮아 접었습니다.

#### 알고리즘은 verifier 수가 결정합니다

처음에는 검증 주체가 Spring 하나라고 보고 HS256으로 갔는데, 실제로는 Hocuspocus가 별도 Node 프로세스로 collab 토큰을 검증하고 있어서 verifier가 둘이었습니다. HS256의 비밀 공유 위험이 명목상 도착한 셈이라 RS256 전환을 검토했습니다.

그런데 동종 OSS 코드를 직접 열어봤습니다. Baserow의 `SIMPLE_JWT`는 algorithm 명시 없이 default HS256이고, Outline의 `User.ts`는 `type: "collaboration"` 토큰까지 `user.jwtSecret` 하나로 HS256 서명합니다. 우리 collab 시나리오와 정확히 같습니다. Hocuspocus playground도 algorithm 미명시, Supabase Auth의 fallback도 HS256이었습니다. 알고리즘은 동종 OSS들이 README에 자랑하지 않을 만큼 구현 세부였고, 가장 흔한 기본값이 HS256이었습니다.

같은 vault, 같은 운영자, 같은 host인 환경에서 RS256의 발급과 검증 권한 분리 효과는 명목상이고 1인 운영 부담만 늘어납니다. HS256을 유지하되, 별도 운영팀이나 별도 vault, 외부 verifier가 들어오는 시점을 전환 트리거로 다시 정의했습니다.

토큰 보관은 브라우저에 httpOnly cookie, Electron과 API 클라이언트에 Authorization Bearer로 이중화했습니다. localStorage는 XSS에 취약해서 뺐습니다.

#### 같은 이메일이라도 무조건 link하면 안 됩니다

OAuth provider의 verified email을 어떻게 다루느냐가 보안 경계를 만듭니다. 네 갈래로 명시했습니다.

```java
sealed interface Decision {
    record ReuseExistingLink(UUID userId, UUID linkId)
    record LinkToExistingUser(UUID userId)
    record CreateNewUser()
    record RejectUnverifiedEmail(String email)
}
```

(provider, providerUserId)가 이미 연결되어 있으면 재로그인입니다. provider가 verified email을 안 줬는데 같은 email의 사용자가 이미 있으면 거부합니다. 양쪽 다 verified이고 일치하면 자동 연결하고 audit log를 남깁니다. 나머지는 신규 생성입니다.

두 번째 규칙이 핵심 경계입니다. 공격자가 피해자의 email로 GitHub에 가입하고 우리 OAuth를 받은 뒤 email만 보고 연결되면 계정을 통째로 가져갈 수 있습니다. 그래서 GitHub `/user/emails`에서는 `primary == verified == true`인 row만 쓰고, Google OIDC는 `email_verified` claim을 그대로 씁니다.

Refresh token은 해시와 prev_id를 가진 DB rotation chain으로 뒀습니다. 추가 인프라 없이 revoke가 되기 때문입니다. Redis는 사용자가 늘면 그때 붙입니다.

---

### 5. Notion 클론과 갈라지는 지점

동기화와 인증, 인프라 위에 얹은 기능들이 일반적인 문서 도구와 게임 스튜디오 워크스페이스를 가릅니다.

뷰 타입은 열 가지인데 Grid, Form, Kanban, Calendar, Gallery, Gantt까지는 흔한 것들이고 Heatmap, Curve, Probability, Diff 네 개가 밸런싱 도메인 전용입니다. Notion이나 Airtable, Baserow에는 없습니다. 모든 뷰 전환과 drag-drop이 서버 진실원 동기화 위에서 실시간으로 돕니다.

서버에 저장되는 undo도 넣었습니다. Cmd+Z가 새로고침 뒤에도 120분 안에는 동작하고, 탭 단위로 격리되며 30초 또는 20개 op 단위로 묶입니다. 여기서 가장 만족스러웠던 건 Diff baseline picker가 별도 snapshot 인프라 없이 돌아간다는 점입니다. 같은 멱등 로그의 inverse_payload를 거꾸로 replay하면 되기 때문에, undo와 Diff 두 기능이 한 자료를 나눠 씁니다. 새로 짤 인프라가 한 줄도 없이 기능이 하나 더 생긴 셈입니다.

나머지는 코멘트와 @멘션, 공유 링크, outbound와 inbound 웹훅, Discord 슬래시 커맨드, Stripe 결제, 프로젝트 전체 검색, 감사 로그, 그리고 CSV와 C# struct로 떨어지는 게임 엔진 export입니다.

이 중 outbound 웹훅은 ApplicationEvent로 디커플링했습니다. 웹훅 모듈이 발행자 모듈을 정적으로 의존하기 시작하면 Spring Modulith 모듈 경계 테스트가 깨지는데, 이벤트를 한 단계 끼워 넣으면 listener가 공급자 모듈을 전혀 몰라도 동작해서 경계가 유지됩니다.

---

### 6. 실패와 교훈

초기 인증 작업에서 다섯 번 silent failure를 만났습니다.

| 함정 | 증상 | 원인 |
|------|------|------|
| Spring Boot 4 자동설정 모듈 분리 | 배포 성공, health 200, `flyway_schema_history` 부재 | `flyway-core`만 있고 `spring-boot-starter-flyway`가 빠져 자동설정 미발동 |
| 결정 문서와 런타임 함수명 불일치 | `function gen_random_uuidv7() does not exist` | 문서 작성 시점이 PostgreSQL 18 RC였고 GA의 실제 이름은 `uuidv7()` |
| Tomcat 11의 RFC 6265 strict cookie | OAuth 로그인 후 `error=login_failed`로 빠짐 | `setDomain(".balruno.com")`의 leading dot을 `Rfc6265CookieProcessor`가 거부 |
| Hibernate `@UuidGenerator(style=TIME)` | 운영 row UUID의 버전 자리가 `1` | `Style.TIME`이 RFC 4122 v1 시절 명명 그대로라 `DEFAULT uuidv7()`이 발동 안 함 |
| docker-compose `env_file` 권한 | `.env: permission denied` | Ansible이 `0600 root:root`로 렌더, CLI는 non-root 사용자 권한 |

가장 뼈아팠던 건 세 번째입니다. catch-all로 `RuntimeException`을 삼킨 탓에 원인 발견이 두 시간 늦어졌습니다. logger 한 줄을 넣자 다음 시도에서 바로 잡혔습니다. 모든 catch에 stack trace를 남기는 게 먼저고 실제 수정은 그다음이라는 순서를 여기서 배웠습니다. 순서를 뒤집으면 수정 시도 자체가 가설 사격이 돼서 비용이 폭발합니다.

다섯 중 셋은 추상화가 아래 동작을 가린 패턴이었습니다. 자동설정 imports 파일을 한 번 읽고, 운영 row의 16진수를 한 번 보고, 파일 권한을 한 번 `ls` 하는 데 5분이면 됩니다. 새 스택을 도입할 때 그 5분을 쓰면 이런 실패가 사라집니다.

`gen_random_uuidv7()`은 결정 문서를 쓸 때의 정직한 추측이었습니다. `\df *uuid*` 한 번이면 첫 배포에서 바로 드러났을 텐데, 결정 문서가 spec이라는 이유로 검증을 건너뛴 게 원인이었습니다. 모든 결정은 운영과 한 번은 대조되어야 합니다.

결정을 바꾼 흔적도 남겼습니다. status 머신에 Uptime Kuma를 올렸다가 blackbox_exporter가 같은 책임을 native로 수행한다는 걸 알고 걷어냈습니다. Grafana 스택이 이미 깔리는데 중복이었습니다. 처음부터 정답일 필요는 없고, 측정한 뒤 단순화한 흔적이 더 강한 신호라고 봤습니다. 기능을 추가한 커밋보다 약 80,000라인을 걷어낸 커밋이 CI green을 유지한 사실도 같은 종류의 신호입니다.

---

### 매니지드를 골랐다면 들었을 비용

paying user 0 시점 기준으로, 처음부터 매니지드를 골랐다면 들었을 비용입니다. 실제로 결제했다가 멈춘 게 아니라서 절감보다 회피 비용(avoided cost)이 정확한 표현입니다.

| 항목 | 매니지드 가설 | OCI 셀프 실측 | 연간 회피 비용 |
|------|----------------|----------------|------|
| 인프라 통합(Vercel + Fly.io + Aurora + Atlas + Datadog) | $155/월 | $0/월 | 약 $1,860 |
| 인증(Auth0 Pro) | $240/월 | $0(OAuth + 자체 발급 JWT) | 약 $2,880 |
| 모니터링(Datadog Pro 4 host) | $60/월 | $0(Grafana 셀프) | 약 $720 |

#### 사용자/부하 트리거 후에 추가할 것들

이 9개 영역은 처음부터 박지 않고, 트리거가 떨어지면 그때 단계적으로만 도입하기로 미리 그어뒀습니다.

1. Redis 캐시: 사용자 50명 + Spring p95 > 500ms
2. PostgreSQL 읽기 복제본: 사용자 500명 + 읽기 부하
3. 로드밸런서 + 다중 prod-app: 사용자 500명 + Spring CPU > 70%
4. 지역 분산 백업(cross-region): paying user 등장
5. OpenTelemetry 분산 추적: 사용자 50명
6. DR 드릴: paying user 등장
7. Secret 회전(Vault): 사용자 100명
8. 비동기 큐(Kafka / RabbitMQ): 사용자 500명
9. WAF Pro: 봇 트래픽 발견

---

### 마무리

Balruno는 발명이라기보다 조합으로 풀린 프로젝트였습니다. Baserow의 셀 이벤트 + Linear의 트리 op log + Outline의 문서 본문 yjs / Hocuspocus + Notion의 PostgreSQL JSONB block 모델 + Spring Security 7의 OAuth 2.1 default + OCI Always Free + Cloudflare R2, 각각이 5년 이상 검증된 OSS 다수파였고, 1인 OSS의 안전한 길은 *각 도메인 표준을 존중하면서, 도메인 차이가 드러나는 한 점에서만 분기*하는 것이었습니다.

그 한 점이 시트가 Baserow 계열이라는 인식이었고, 이 분기 위에서 로컬 모드 정리와 시트 도메인의 서버 진실원 전환, 3영역 통합 동기화, 무중단 배포, 셀프 호스트 인프라가 차례로 풀렸습니다. 위 표를 합치면 연 약 $5,460을 피한 셈이고, 거기에 데이터 통제권과 운영 자동화 경험이 같이 따라왔습니다. 모든 결정은 70여 개의 결정 문서로 추적할 수 있게 남겨뒀습니다.

---

## 참고 자료

### MVP 15가지 기능

- **사이트**: https://www.balruno.com/
- **오픈소스**: https://github.com/dj258255/balruno

### 테이블과 입력 UX 기술 디테일

- [Fortune-Sheet](https://github.com/ruilisi/fortune-sheet) — `packages/core/src/modules/formula.ts`
- [Univer](https://github.com/dream-num/univer) — `packages/sheets-ui/src/views/formula-bar/FormulaBar.tsx`
- [Luckysheet](https://github.com/dream-num/Luckysheet) — `src/controllers/menuButton.js`
- [Handsontable](https://github.com/handsontable/handsontable) — `imeFastEdit` 옵션
- [React Issue #8683](https://github.com/facebook/react/issues/8683) — Composition Events
- [AG Grid IME Support](https://www.ag-grid.com/)
- [Wijmo FlexGrid](https://developer.mescius.com/wijmo) — `imeEnabled`

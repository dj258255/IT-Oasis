---
title: 'AI 심판의 평가를 믿기 전에 순서 편향을 검증해야 하는 이유'
description: '사람이 고른 표본이 0건이라 심판 모델로 1차 신호를 만들려 했다. 생성자와 계열이 다른 모델을 세우고 A/B 순서를 바꿔 두 번 물었더니 여덟 건 전부 뒤집혔다. 심판이 고른 것은 답의 질이 아니라 앞에 놓인 쪽이었다.'
date: 2026-09-20
category: study/be-commerce
coverImage: "/uploads/covers/project/be-commerce/be-commerce-ch24-judge-order-flip.svg"
draft: false
unlisted: true
series: "결제 시스템 만들기"
seriesOrder: 24
tags:
  - Payment
  - LLM
  - 평가
  - 결제 시스템
---

개인 프로젝트로 만든 이커머스 백엔드 BE-commerce의 결제 개발 기록입니다. 실무 운영 경험이 아닙니다.

[받는 사람이 가드를 정하게 한 편](/blog/project/be-commerce/be-commerce-ch23-receiver-decides-guards)에서 운영자용 서술의 기본값을 켜지 못한 이유는 **사람이 고른 표본이 0건**이었기 때문입니다. 그래서 심판 모델로 1차 신호라도 만들어 보기로 했습니다.

자기선호 편향은 생성자와 **계열이 다른** `llama3.1:8b`가 심판을 보게 해 막고, 위치 편향은 A/B를 바꿔 **두 번 묻고 답이 뒤집히면 동점**으로 세어 막았습니다.

## 여덟 건 전부 뒤집혔다

```
템플릿 0 · 모델 0 · 동점 8  (그중 순서 뒤집힘 8)
```

**여덟 건 전부 뒤집혔습니다.** 심판이 고른 것은 글의 질이 아니라 **앞에 놓인 쪽**이었습니다.

문헌의 위치 편향은 순서만 바꿔도 최대 30%가 반전되고 평균 order-flip이 0.236인데 우리는 100%였습니다. 프롬프트에 A/B 자리 표시가 남아 있어 내용보다 자리를 먼저 읽었을 가능성이 큽니다(추정).

## 순서를 안 뒤집었으면 깨끗한 숫자가 나왔을 것이다

**순서를 안 뒤집었으면 8:0이든 0:8이든 깨끗한 숫자가 나왔을 것이고, 그걸 근거로 모델을 켰을 겁니다.** 어느 쪽이 나왔든 판단은 틀렸을 것입니다.

그래서 기본값은 그대로 `template`입니다. 이유가 정확해졌습니다. **표본이 없어서가 아니라, 모델 심판으로는 이 차이를 못 가린다는 것을 확인해서**입니다.

## 남은 구멍

- 심판의 정밀도·재현율을 잴 라벨 세트가 아직 없습니다. 그전에 프롬프트에서 A/B 자리 표시를 없애고 다시 재봐야 합니다.
- 케이스 모양을 넷으로 갈라 30건을 새로 뽑아 다시 물은 시도도 있었지만, 그때는 심판이 어느 쪽이 템플릿인지 알 수 있는 형태였습니다(템플릿 출력이 "그다음"으로 이어 붙인 사슬). 블라인드가 깨진 선호는 자기선호 편향과 구별되지 않습니다.

## 참고

- 평가자의 위치·길이·자기선호 편향: [arXiv 2410.20266](https://arxiv.org/pdf/2410.20266), [Judging the Judges (arXiv 2406.07791)](https://arxiv.org/abs/2406.07791)
- 쌍 비교와 절대 점수: [SuperAnnotate](https://www.superannotate.com/blog/llm-as-a-judge-vs-human-evaluation), [Eugene Yan](https://eugeneyan.com/writing/llm-evaluators/)
- 앞 편(받는 사람이 가드를 정하게 한 기록): [같은 AI 출력인데 고객에게는 막고 운영자에게는 허용했다](/blog/project/be-commerce/be-commerce-ch23-receiver-decides-guards)

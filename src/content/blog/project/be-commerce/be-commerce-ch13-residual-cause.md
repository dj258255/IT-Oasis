---
coverImage: /uploads/covers/ai-generated/project/be-commerce/be-commerce-ch13-residual-cause.png
title: '대사 원인 분류 자동화의 판단 기준'
description: '규칙이 후보를 내지 못한 대사 예외에 모델을 붙여 개발 표본에서 유형별 정확도 91~100%를 얻었지만 실제 잔여 분포에서는 규칙 분류기와 같은 답을 냈다. 손으로 쓴 표본과 엔진이 만든 분포가 왜 다른 결론을 냈는지, 가드가 막는 것과 못 막는 것, 규칙 대비 이득이 0일 때 기본값을 규칙으로 둔 기준을 정리한다.'
date: 2026-08-31
category: study/be-commerce
topics:
  - ai
  - payments
draft: false
series: "BE-commerce"
seriesOrder: 13
tags:
  - Payment
  - AI
  - LLM
  - 운영 자동화
  - 결제 시스템
---

규칙 분류기 위에 모델을 얹는 자동화의 판단 기준은 규칙 대비 추가 이득입니다. 모델 혼자 몇 퍼센트를 맞혔는지는 그 이득을 말해 주지 않습니다. 규칙이 이미 같은 답을 내는 자리에서 모델이 100%를 맞혀도 자동화로 얻는 것은 0이고 표본이 실제 분포와 다르면 그 100%조차 운영에서 재현되지 않습니다.

대사는 내 결제 기록과 PG 정산 파일을 하루치씩 대조해 맞지 않는 건을 찾고 사람이 원인을 골라 확정하는 작업입니다. 그 화면에는 11곳에서 모은 이력, 산수로 후보 내기, 안내 초안 쓰기가 붙어 있습니다. 이 글은 PG 정산 파일에는 있는데 우리 장부에는 없는 결제를 대사 예외로 분류하는 자리에 모델을 붙여 본 기록입니다. 개발 표본에서는 유형별 정확도가 91~100%까지 나왔지만 규칙이 실제로 남기는 잔여 분포에서 다시 재자 규칙 분류기가 이미 같은 답을 내고 있어 개선이 0이었습니다. 모델은 켜지 않았습니다.

## 결론부터

- 규칙이 후보를 내지 못한 잔여 건만 좁혀 모델에 넘겼습니다.
- 원인 코드의 정의를 프롬프트에 넣자 개발 표본 정확도는 올랐지만 손으로 만든 표본만으로는 자동화 효과를 증명할 수 없었습니다.
- 실제 잔여 40건을 홀드아웃으로 다시 재자 모델의 추가 이득은 0이었습니다. 기본값은 `template`로 유지했습니다.

## 1. 원인 코드의 정의는 왜 필요할까?

원인 코드는 이름만으로는 갈리지 않았습니다. 개발 표본 12건(정답 9, 기권 3, 원인 일곱 종)에 세 모델을 붙여 이름만 준 1차와 한 줄 정의를 함께 준 2차를 비교했습니다.

| 모델 | 1차 일치 | 기권 | 형식·목록 밖 | 2차 | 차이 |
|---|---|---|---|---|---|
| qwen3:8b | 6 / 12 | 2 | 0 | 9 / 12 | +3 |
| qwen3:14b | 7 / 12 | 2 | 0 | 12 / 12 | +5 |
| llama3.1:8b | 3 / 12 | 0 | 0 | 8 / 12 | +5 |

1차에서 틀린 자리는 모델과 무관하게 겹쳤습니다. `TIMEZONE_BOUNDARY`와 `PG_FILE_DELAY`는 둘 다 "다른 날짜 파일에 있다"는 사실이라 방향을 주지 않으면 가를 수 없습니다. 그래서 정의 아홉 줄을 붙였습니다.

```
- TIMEZONE_BOUNDARY: 거래일 경계. KST 새벽 건이 PG 기준으로 <전날> 파일에 잡힘
- PG_FILE_DELAY: PG 파일이 늦게 도착. <다음> 거래일 파일에 포함됨
  두 원인은 방향으로 가릅니다. 전날 파일이면 경계, 다음날 파일이면 지연입니다.
```

정의를 붙인 효과가 모델을 키운 효과보다 컸습니다. 8B에서 14B로 키운 것이 +1이었고 같은 8B에 정의를 붙인 것이 +3이었습니다. 계열이 다른 llama도 3에서 8로 올랐습니다. 뜻을 적지 않은 원인이 생기면 테스트가 걸리도록 `ResidualPromptBuilder`에 고정했습니다. 다만 이 +3과 +5는 그 12건에 맞춘 값일 수 있었습니다. 그 의심이 다음 절의 홀드아웃으로 이어졌습니다.

## 2. 손으로 쓴 표본으로 판단해도 될까?

손으로 쓴 표본은 실제 분포를 대표하지 못했습니다. 같은 모델이 손으로 쓴 홀드아웃 15건에서 14건을 맞히고 엔진이 만든 잔여 40건에서는 0건을 맞혔습니다.

화면 연결은 순환 의존(`ReconciliationAdminService`→`assist`) 때문에 창구를 `assist`에 두고 두 번 부르게 했고 응답에는 `source`를 실었습니다.

![표본이 달라지자 같은 모델의 결과가 달라졌다. 손으로 쓴 홀드아웃 15건에서는 14건을 맞혔다. 엔진이 만든 320건 중 규칙이 답하지 못한 잔여는 40건이었고 그 40건에서는 세 모델 모두 0건을 맞혔다](/uploads/project/be-commerce/diagrams/residual-funnel.svg)

외부 리뷰가 "고친 프롬프트를 같은 12건으로 다시 쟀다"는 점을 짚었습니다. 그래서 프롬프트를 손대지 않고 보지 않은 15건(정답 11, 기권 4)을 한 번만 쟀습니다.

| 모델 | 홀드아웃 15건 | 분류 11 정답 | 기권 4 성공 전→후 | 단정 전→후 | 가드 6 후 전체 |
|---|---|---|---|---|---|
| qwen3:8b | 10 / 15 | 8 | 2→3 | 2→1 | 11 / 15 |
| qwen3:14b | 14 / 15 | 11 | 3→4 | 1→0 | 15 / 15 |
| llama3.1:8b | 10 / 15 | 9 | 1→3 | 3→1 | 12 / 15 |

14B는 15건 중 14건으로 유지됐습니다. 그런데 표본의 크기와 출처가 문제였습니다. 참고한 연구는 표본 크기를 이렇게 적습니다.

> 정확도는 250~500개에서 안정화되기 시작한다. 다만 1,000개가 의미상 비슷하면 실제로는 수백 개만큼의 검정력밖에 없다.

그래서 조건 축만 정하고 사실 문장은 대사 엔진이 만들게 했습니다(금액 8종 × 조건 8종 × 변형 5개 = 320건). 그중 규칙이 아무 후보도 내지 못한 건은 40건뿐이었습니다. 금액 불일치는 배제법으로 걸러지고 외부에만 있는 건은 규칙이 `INTERNAL_RECORD_LOST`로 답합니다. 손으로 만든 27건은 실제로 오지 않을 건들이었습니다.

그 40건에 세 모델 모두 0/40이었고 전부 `INTERNAL_RECORD_LOST`를 냈습니다. 신뢰도는 95, 96, 100이었습니다. 뜻은 "PG에는 있는데 내부에 기록이 없음"이라 적어 뒀는데 실제 40건은 정반대인 "내부에만 있음"이었습니다.

14/15는 실제로 오지 않는 분포에서 잰 값이었습니다. 두 결과의 차이를 만든 것은 표본이었고 모델은 같았습니다.

## 3. 가드로 무엇까지 막을 수 있을까?

가드는 조회 실패처럼 코드가 판정할 수 있는 조건을 막고 완전한 사실에서 틀린 추론을 하는 경우는 막지 못합니다. 가드 일곱을 걸었습니다(호출 범위, 출력 목록, 금지 유형, 신뢰도 임계, 숫자 출처 `NumericProvenanceGuard`, 사실 완전성, `resolve` 금지).

신뢰도 임계는 모델마다 다르게 듭니다. 원인을 고른 건만 모아 임계별 통과/정답/오답을 셌습니다.

| 임계 | qwen3:14b | qwen3:8b | llama3.1:8b |
|---|---|---|---|
| 70 | 12 / 11 / 1 | 13 / 8 / 5 | 14 / 9 / 5 |
| 80 | 12 / 11 / 1 | — | — |
| 85 (채택) | 11 / 11 / 0 | 6 / 5 / 1 | 1 / 1 / 0 |
| 90 | 7 / 7 / 0 | — | — |
| 95 | 1 / 1 / 0 | 2 / 2 / 0 | — |

14B에서 85는 오답만 걷어냅니다. llama에서 85는 14건 중 1건만 통과시켜 기능을 끄는 것과 같고 8B는 85에서 정답 셋을 잃고도 오답이 하나 남습니다. 코드에 박아 둔 "임계 70"에는 근거가 없었습니다.

프롬프트로 알려 줘도 모델은 지키지 않았습니다. 14B가 단정한 건은 전부 사실 목록이 불완전한 건이었습니다.

```
H-15  사실:  승인 120,000원 / 파일 119,000원 / 취소 이력 조회 실패
      프롬프트: "주의: 일부 출처 조회가 실패해 이 목록은 불완전합니다."
      14b :  FEE_CALCULATION_DIFF, confidence 80
```

그래서 코드가 막게 했습니다. 조회가 한 곳이라도 실패하면 원인을 가릴 수 없으니 모델을 부르지 않습니다. 같은 15건을 다시 돌리자 14B가 15/15가 됐습니다(위 표). 모델도 프롬프트도 그대로였고 바뀐 것은 코드뿐입니다.

> 프롬프트 엔지니어링은 행동에 영향을 줄 수는 있어도 강제 가능한 통제 경계를 만들지 못한다. 실패가 사업에 영향을 주는 순간부터는 모델이 잘 답해 주기를 바라는 것보다 결정적 검증이 더 믿을 만하다.

> 모델 가중치는 드리프트하거나 파인튜닝으로 덮일 수 있지만 코드의 조건문은 그렇지 않다.

사실이 완전한데도 틀리는 경우가 남습니다.

```
H-12  사실:  승인 62,000원 / 금액 불일치, 차액 15,500원   ← 목록은 완전하다
      8b·llama:  FEE_CALCULATION_DIFF, confidence 80
```

이 경우는 있는 정보로 틀린 추론을 한 것이라 조건문으로 막을 수 없습니다. 출처가 맞는 숫자로도 틀린 주장을 할 수 있습니다. 그것은 [자동 채점 점수와 발송 가능성의 차이](/blog/project/be-commerce/be-commerce-ch11-ruler-fooled-me)이 잡을 일입니다. 출처를 재는 일과 주장이 맞는지 재는 일은 다른 층입니다.

## 4. 유형을 좁혀 켜면 규칙보다 나을까?

좁혀 켠 유형은 100%를 유지했지만 그 유형에서는 규칙 분류기가 이미 같은 답을 냈습니다. 코퍼스(대사 기록이 만들어지지 않던 것)와 가드 1(후보가 하나라도 있으면 → 결정적 후보가 있으면)을 고치자 잔여가 40건에서 272건이 됐습니다.

![좁혀서 켠 범위. 잔여 272건 중 켠 유형은 60건(약 22%)이고 나머지 78%는 사람에게 간다. 켠 유형은 판정 기준을 명시한 뒤 60건 중 60건을 맞혔다. 새 표본 45건에서 기권해야 할 유형은 세 모델 모두 15건 중 0건이었다](/uploads/project/be-commerce/diagrams/narrowed-scope.svg)

| 유형 | qwen3:14b | qwen3:8b | llama3.1:8b |
|---|---|---|---|
| PG엔 있고 우리엔 없음 | 100% | 100% | 100% |
| 기권해야 하는 건 | 30% | 50% | 0% |
| 같은 거래가 여러 행 | 30% | 0% | 0% |
| 부분취소 미반영 | 0% | 0% | 0% |

맨 위 유형은 사실이 "파일에 있고 내부에 없다"로 단순하고 다른 유형과 겹치지 않습니다. 맨 아래는 셋 다 차액이 있으면 수수료로 답합니다. 값을 그 하나로 줄이자 60건 중 대부분을 그 하나로 찍어 정확도가 15%로 떨어졌습니다. 모델은 "고를 게 하나뿐"을 "그러니 그걸 골라라"로 읽었습니다. 판정 기준을 명시하고 나서야 됐습니다.

| 모델 | 좁히기 전 | 후 |
|---|---|---|
| qwen3:14b | 40% | 100% (60/60) |
| qwen3:8b | 37% | 100% (60/60) |
| llama3.1:8b | 25% | 91% (55/60) |

프롬프트를 한 글자도 바꾸지 않고 새 표본 45건으로 다시 쟀습니다.

| 유형 | 정답 | qwen3:14b | qwen3:8b | llama3.1:8b |
|---|---|---|---|---|
| 외부에만 있음 | `INTERNAL_RECORD_LOST` | 15/15 | 15/15 | 15/15 |
| 금액만 다름 | 기권 | 15/15 | 0/15 | 10/15 |
| 내부에만 있음 | 기권 | 0/15 | 0/15 | 0/15 |
| 전체 | | 67% | 33% | 56% |

켠 유형은 살아남았고 무너진 것은 기권해야 할 쪽이었습니다. 프롬프트가 켠 유형만 보여 주니 오답이 전부 그 값이 되고 유형 가드도 신뢰도(95~100)도 다 통과했습니다. 기본 모델이 8B였으니 45건 중 30건에서 틀린 후보가 운영자에게 갔을 것입니다. 프롬프트에 적어 둔 조건을 코드로도 강제했습니다.

결국 껐습니다. 모델이 낼 수 있는 값은 그 하나 또는 기권뿐이고 그 값이 통과하는 조건인 "외부에만 있음"에서는 규칙 분류기가 이미 같은 답(`INTERNAL_RECORD_LOST`)을 냅니다. 유형별로는 갈라 쟀지만 규칙 대비로는 재지 않았던 것입니다. 기본값을 `template`으로 되돌렸습니다. 재현 가능한 평가 하네스(`./gradlew -p commerce evalTest`), 가드, 홀드아웃 절차는 남겼습니다. 잣대를 먼저 두고 모델을 나중에 보는 판단은 [11편](/blog/project/be-commerce/be-commerce-ch10-ruler-first)과 같습니다.

## 5. 무엇이 남아 있을까?

재는 장치는 채택률(`assist.residual.accepted`, 앵커링에 오염됨), 확정 소요 시간, `blind` 태그를 짝으로 배선했습니다. `blind`는 후보의 일부(기본 20%)를 화면에 주지 않고 기록만 합니다. 저장소는 두지 않았습니다. 표본이 쌓이기 전에 스키마부터 굳기 때문입니다.

> 채택률은 작업이 깨끗하게 끝났는지, 뒤에 비용이 생겼는지를 답하지 못한다. 채택률이 높은데 재작업률과 검토 시간도 높다면 낮은 품질을 받아들이고 있다는 뜻이다.

나머지 유형은 세 모델 모두 0~50%라 열 수 없고 실제 업무 개선을 말할 표본은 아직 없습니다.

## 6. 승인 게이트는 왜 만들지 않았을까?

자동 확정 조건 셋(증거가 결정적일 것, 금액이 중요성 임계 미만일 것, 그 유형의 실측 오류율이 선언한 한도 안일 것)은 적어 뒀습니다. 셋째 조건은 사람이 그 유형의 통계를 만든 뒤에야 켤 수 있고 지금은 그 통계가 없습니다.

> 되돌릴 수 있는 단계(초안 작성, 요약)는 끝까지 자동화해도 되고 되돌릴 수 없는 단계(발행, 고객에게 이메일, 돈 옮기기)는 명시적 승인으로 막아야 한다.

> 사람이 모든 행동을 승인해야 한다면 아무것도 자동화하지 않은 것이고 검토자는 곧 읽지 않고 승인을 누르는 법을 배운다. 거수기는 게이트가 없는 것보다 나쁘다. 감독의 실체 없이 겉모습만 만들기 때문이다.

[백오피스 확정 화면](/blog/project/be-commerce/be-commerce-ch8-reconciliation-judgement)도 경고만 띄우고 버튼은 그대로 눌립니다. 승인 절차를 얹으면 누르는 횟수만 늘어납니다.

## 7. 출처 검증은 왜 틀린 답을 못 막을까?

출처 검증은 인용이 실재하는지를 볼 뿐이고 그 인용에서 끌어낸 결론이 맞는지는 보지 못합니다. 같은 벽에 세 번 부딪혔습니다.

> 근거 없이 "차액 7,000원은 수수료 차이"라고 단정한 오답이 출력 검증 다섯을 전부 통과했다. 인용한 7,000원은 실제로 있는 값이었다. 출처가 맞는 숫자로 틀린 주장을 할 수 있다.

그 뒤 같은 일이 두 번 더 있었습니다. 잔여 원인의 0/15(신뢰도 95~100)와 장애 로그를 읽고 원인을 고르는 기능에서 큐 적체 로그에 `RACE_CONDITION`을 찍은 것입니다.

```
CAUSE: RACE_CONDITION
EVIDENCE: 웹훅이 결제보다 먼저 도착 — 보류 paymentKey=tviva… retry=6
```

인용은 진짜였습니다. 틀린 것은 그 줄에서 끌어낸 결론이었습니다. 틀린 답을 막을 방법을 찾지 못해 세 번째 기능도 켜지 않았습니다.

12건의 케이스 정의와 프롬프트 전문, 모델별 응답 원문은 [저장소](https://github.com/dj258255/BE-commerce)에 남겨 뒀습니다.

## 참고

- Ramp 거래 재분류 에이전트: [ZenML LLMOps Database](https://www.zenml.io/llmops-database/ai-agent-for-automated-merchant-classification-and-transaction-matching)
- Modern Treasury 대사에 AI 붙이기: [Modern Treasury Journal](https://www.moderntreasury.com/journal/adding-ai-to-modern-treasury-reconciliation)
- 토스 Flowise + LLM 에러 분석 자동화: [토스 테크](https://toss.tech/article/flowise-llm-error-analysis-automation)
- LINE 평가 하네스 자동화: [LY Corporation 기술블로그](https://techblog.lycorp.co.jp/ko/automating-llm-application-evaluation-with-harness)
- 말로 표현한 신뢰도의 보정 문제: [Overconfidence is Key (arXiv 2405.02917)](https://arxiv.org/html/2405.02917), [On Verbalized Confidence Scores (arXiv 2412.14737)](https://arxiv.org/pdf/2412.14737)
- 라벨 설명이 분류 정확도에 미치는 영향: [PoliPrompt (arXiv 2409.01466)](https://arxiv.org/html/2409.01466v1)
- 기권과 선택적 예측: [Uncertainty-Aware Abstention (arXiv 2607.04430)](https://arxiv.org/pdf/2607.04430)
- 채택률의 한계: [The rise and looming fall of acceptance rate (LeadDev)](https://leaddev.com/reporting/the-rise-and-looming-fall-of-acceptance-rate)
- 심판의 앵커링: [Understanding the Anchoring Effect of LLM (arXiv 2505.15392)](https://arxiv.org/pdf/2505.15392)
- 대사에 AI 붙이기: [AI reconciliation 사례 정리 (Ledge)](https://www.ledge.co/content/ai-reconciliation)
- 프롬프트로 시키는 기권이 실패하는 이유: [Prompt-Based Abstention Fails Under Misleading Context (arXiv 2608.22228)](https://arxiv.org/html/2608.22228)
- 승인 게이트를 어디에 둘 것인가: [Building a Human-in-the-Loop Approval Gate for Autonomous Agents](https://machinelearningmastery.com/building-a-human-in-the-loop-approval-gate-for-autonomous-agents/)
- 대역 외 승인(Slack·이메일): [Human approval for async AI agent actions (WorkOS)](https://workos.com/blog/ciba-human-approval-ai-agents)
- Klarna 가 되돌린 기록: [Klarna Reverses Course on AI Customer Support](https://www.fintechweekly.com/magazine/articles/klarna-hires-customer-service-after-ai-pivot)
- 결정적 가드레일: [Designing Deterministic Guardrails for LLM Systems](https://bh3r1th.medium.com/from-harness-to-enforcement-designing-deterministic-guardrails-for-llm-systems-6a9912ba7eba), [Pre-LLM & Post-LLM Best Practices (Arthur)](https://www.arthur.ai/blog/best-practices-for-building-agents-guardrails)

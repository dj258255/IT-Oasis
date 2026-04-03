---
title: '요즘 재밌는 걸 하고 있습니다.'
titleEn: 'I Have Been Working on Something Fun Lately'
description: 지인에게 추천받은 PretextBreaker를 계기로, AI와 함께 정규식보다 빠른 문자열 검사 방식을 끝없이 실험해보고 있는 요즘의 기록입니다.
descriptionEn: A personal note on being inspired by PretextBreaker and using AI to keep experimenting with faster string matching ideas beyond regular expressions.
date: 2026-04-03T00:00:00.000Z
tags:
  - 일상
  - 개발
  - 실험
  - 정규식
  - AI
category: daily
coverImage: /uploads/banners/banner-main.png
draft: false
---

요즘 꽤 재밌는 걸 하고 있다.

며칠 전 지인에게 [PretextBreaker](https://pretextbreaker.com/)를 추천받았다.
처음에는 프론트엔드 쪽 이야기인 줄만 알았다.
실제로도 그 기술은 검색이나 백엔드와 직접 연결되는 건 아니었다.
그런데 내가 흥미로웠던 건 기술 자체보다, 그 기술이 만들어진 방식이었다.

기존의 틀 안에서 조금 더 잘 만드는 게 아니라, 아예 다른 발상을 계속 던져보고 그중에서 되는 걸 남기는 방식.
그리고 그 과정에 AI를 적극적으로 끌어들였다는 점이 재밌었다.
지인은 “이걸 검색에 그대로 쓰라는 뜻이 아니라, 저런 식의 사고를 정규식 검사 쪽에도 해보면 재밌지 않겠냐”고 말했다.
그 말을 듣고 바로 꽂혔다.

생각해보면 문자열 검사나 정규식 매칭은 익숙한 문제인데도, 실제로는 느릴 때가 많다.
특히 패턴이 많아지거나, 같은 정규식을 반복해서 돌리거나, 병적인 케이스를 만나면 생각보다 금방 비용이 커진다.
그래서 “정규식을 더 잘 쓰는 법”보다, “정규식 검사 과정 자체를 다르게 만들 수는 없을까”라는 질문이 머리에 남았다.

그 뒤로는 거의 작은 실험실처럼 작업하고 있다.
한 번에 완벽한 엔진을 만들겠다는 생각보다는, 아이디어를 하나씩 분리해서 만들어보고, 기존 정규식 엔진보다 실제로 빠른지 검증하고, 아니면 버리거나 보류하는 식이다.
AI에게도 그냥 코드를 짜달라고 하기보다, 새로운 실행 아이디어를 계속 제안하게 하고, 그걸 검증 루프에 태워보는 식으로 굴리고 있다.

지금은 `prepare -> match`를 분리한 실험 구조를 먼저 만들어 두었다.
패턴을 미리 분석해서 길이, prefix, suffix, literal chain 같은 정보를 뽑아두고, 실행 시점에는 그 정보를 이용해 빠르게 탈락시키거나 전용 matcher로 바로 들어가는 방식이다.
그리고 모든 아이디어는 별도 자바 파일로 남겨두고 있다.
무슨 엔진이 이겼는지, 어떤 패턴에서 빨랐는지, 어떤 시도는 왜 별 의미가 없었는지까지 계속 누적되도록 만들고 있다.

이 과정이 재밌는 이유는 “새 이론을 발명했다”는 느낌보다는, 문제를 보는 방식이 조금 달라졌다는 데 있다.
예전 같으면 정규식 엔진 하나를 고치려 했을 텐데, 지금은 패턴의 모양에 따라 아예 다른 전용 엔진이 더 맞을 수도 있다고 생각하게 됐다.
어떤 패턴은 고정 길이 스텐실이 잘 먹히고, 어떤 패턴은 구분자 중심 탐색이 잘 먹히고, 어떤 패턴은 그냥 기존 방식이 제일 낫다.
즉, 하나의 만능 해답을 찾는 게 아니라 패턴 형태별로 승자를 찾아가는 구조가 되어가고 있다.

무엇보다 마음에 드는 건, 이걸 “그럴 것 같다”로 끝내지 않는다는 점이다.
검증 케이스를 계속 돌리고, baseline과 비교하고, 벤치마크를 다시 보고, 안 맞으면 다른 아이디어를 또 넣는다.
AI가 낸 아이디어도 예외 없이 같은 검증을 통과해야 한다.
결국 중요한 건 AI가 뭔가 있어 보이는 말을 했느냐가 아니라, 진짜로 regex보다 빠른지, 그리고 기존 동작과 동일한지다.

아직 이게 어디까지 갈지는 모르겠다.
정규식을 완전히 대체하는 엔진이 될지, 특정 패턴군에서만 압도적으로 빠른 실험실이 될지, 아니면 검색 쪽 prefilter 같은 다른 형태로 이어질지도 모르겠다.
그래도 요즘은 이런 식의 작업이 꽤 즐겁다.
누가 던져준 낯선 아이디어 하나가, 전혀 예상 못 한 방향의 실험으로 이어지는 순간들이 있다.

아마 당분간은 이걸 계속 해볼 것 같다.
AI에게 계속 새로운 발상을 던지게 하고, 실제로 구현해보고, 벤치마크에서 지면 버리고, 이기면 남기면서.
그렇게 “정규식을 더 잘 쓰는 방법”이 아니라 “정규식 검사 자체를 다르게 만드는 방법”을 조금 더 끝까지 파보고 싶다.

이런 종류의 작업은 당장 실무 기능 하나를 더 만드는 것과는 다르지만, 개발이 왜 재밌는지를 다시 느끼게 해준다.
기존 답을 조금 개선하는 게 아니라, 질문 자체를 바꿔보는 일.
요즘 내가 제일 재밌게 하고 있는 건 딱 그런 종류의 실험이다.

<!-- EN -->

Lately, I have been working on something that feels genuinely fun.

A few days ago, a friend recommended [PretextBreaker](https://pretextbreaker.com/) to me.
At first I thought it was just a frontend thing.
And in a direct sense, it is not really about search or backend systems.
What caught my attention was not the exact technology itself, but the way it was created.

It was not just about improving an existing pattern a little.
It was about throwing many different ideas at the problem, keeping what worked, and using AI as part of that exploration.
My friend said, “I am not saying this is related to search directly. I just think the same kind of thinking could be interesting for regex matching.”
That idea stuck with me immediately.

When you think about it, string matching and regular expressions are familiar problems, but they still become expensive surprisingly fast.
Patterns get more complex, some cases trigger pathological behavior, and repeated matching adds up.
So the question that stayed in my head was not “how do I use regex better,” but “can the whole process of regex matching be redesigned?”

Since then, I have been treating it like a small lab.
Instead of trying to build one perfect engine, I keep creating separate ideas, testing them against the baseline, keeping the ones that win, and setting aside the ones that do not.
I am also using AI less like a code generator and more like a source of strange execution ideas that I can force through the same verification loop.

Right now, I have a structure that separates `prepare -> match`.
The pattern is analyzed ahead of time to extract things like length, prefix, suffix, or literal chains, and then the runtime path uses that information to reject quickly or jump into a specialized matcher.
Each idea is kept as its own Java file, so the lab keeps a record of what was attempted, where it won, and where it was not worth keeping.

What makes this fun is that it changed the way I look at the problem.
In the past, I probably would have tried to improve one generic engine.
Now I think more in terms of pattern shapes.
Some patterns benefit from fixed-shape stencil matching, some from separator-based scans, and some are still best handled by the ordinary engine.
So instead of looking for one universal answer, the project is slowly turning into a system that finds the best winner for each class of pattern.

The part I like most is that none of this stays at the level of “this sounds clever.”
Everything gets verified, benchmarked, and compared against the baseline.
If an AI-generated idea loses, it loses.
If it wins, it stays.
What matters is not whether the idea sounds impressive, but whether it is actually faster than regex while still behaving correctly.

I still do not know where this will end up.
Maybe it becomes a serious alternative for a subset of regex work.
Maybe it turns into a lab for highly specialized matchers.
Maybe some of the ideas end up being more useful as search-side prefilters than as a true replacement.
Either way, I want to keep pushing it for a while.

There is something deeply fun about taking a strange recommendation from someone else, letting it collide with your own domain, and then turning it into a real experiment.
Lately, that has been the most enjoyable kind of development for me:
not just improving an existing answer, but trying to change the shape of the question itself.

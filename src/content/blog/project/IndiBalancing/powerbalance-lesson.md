---
title: 'PowerBalance를 만들고 나서 배운 것'
titleEn: 'What I Learned After Building PowerBalance'
description: 인디게임 밸런싱 도구 PowerBalance를 만들며 느꼈던 가능성과, 실제 사용자 반응이 기대와는 달랐던 경험, 그리고 그 배움이 이후 CodingTestKit에 어떻게 이어졌는지를 정리한 글입니다.
descriptionEn: A retrospective on building PowerBalance, the gap between a promising idea and real user adoption, and how that lesson later shaped CodingTestKit.
date: 2026-04-02
tags:
  - Retrospective
  - User Feedback
  - Product
  - Game Design
  - IndiBalancing
category: project/IndiBalancing
coverImage: /uploads/project/IndiBalancing/powerbalance-feedback.png
draft: false
series: "IndiBalancing"
---

PowerBalance를 처음 만들 때는 나름 꽤 획기적이라고 생각했다.

게임 밸런싱은 분명히 반복 계산이 많고, 엑셀이나 구글 시트만으로는 불편한 점도 많았다.
그래서 게임 기획자에게 필요한 수식, 시뮬레이션, 검증 기능을 한곳에 모아두면 분명히 도움이 될 거라고 믿었다.

실제로 주변에서 인디게임 밸런싱을 하던 친구도 만족해했다.
내가 생각했던 문제의식 자체가 완전히 틀린 건 아니었다고 느꼈다.
적어도 누군가에게는 분명히 필요한 도구였다.

하지만 막상 홍보를 해보니 사람들의 반응은 생각보다 훨씬 냉정했다.
관심을 보이는 사람은 있었지만, 실제로 들어와서 써보는 사람은 많지 않았다.
그리고 더 중요한 건, "필요해 보인다"와 "실제로 쓰게 된다"는 전혀 다른 문제라는 점이었다.

![](/uploads/project/IndiBalancing/powerbalance-feedback.png)

특히 기억에 남았던 건 사용성에 대한 피드백이었다.
기능 자체나 방향성은 흥미롭지만, 처음 켰을 때 무엇부터 해야 하는지 막막하고 진입 장벽이 높다는 반응이었다.
개발하는 입장에서는 기능을 많이 넣을수록 더 좋아질 거라고 생각하기 쉽지만, 실제 사용자 입장에서는 처음 5분 안에 감이 오지 않으면 그대로 이탈하게 된다는 걸 이때 더 분명하게 느꼈다.

돌이켜보면 사람들은 이미 각자 익숙한 방식이 있었다.
누군가는 엑셀을 썼고, 누군가는 구글 시트를 썼고, 누군가는 그냥 머릿속과 메모로도 작업하고 있었다.
내가 보기엔 불편해 보여도, 그 사람들에게는 이미 굴러가고 있는 흐름이 있었던 거다.
그 흐름을 바꾸게 만들 만큼의 명확한 이유가 없다면, 아무리 기능이 많아도 실제 사용으로 이어지기 어렵다는 걸 배웠다.

이 경험은 이후 프로젝트를 만들 때 꽤 오래 남았다.
특히 나중에 CodingTestKit을 만들 때는 "기능이 많으냐"보다 "사람이 지금 당장 왜 이걸 써야 하는가"를 훨씬 더 조심해서 보게 됐다.
기존 작업 흐름을 크게 바꾸지 않으면서도 바로 편해지는 지점이 있는지, 처음 설치한 사람이 설명 없이도 바로 가치를 느낄 수 있는지를 더 많이 고민했다.

결과적으로 그 차이는 꽤 컸다.
PowerBalance에서는 내가 만든 도구의 가능성과 한계를 동시에 배웠고, 그 배움을 바탕으로 다음 프로젝트에서는 실제 사용성과 진입 장벽을 더 의식하게 됐다.
그 흐름 위에서 나온 CodingTestKit은 결국 다운로드 수 254를 기록했다.

그래서 지금 돌아보면 PowerBalance는 "실패한 프로젝트"라기보다, 내가 제품을 보는 눈을 바꾸게 만든 프로젝트에 더 가깝다.
좋은 기능을 만드는 것과, 사람들이 실제로 쓰는 도구를 만드는 것은 다르다는 걸 이때 확실히 배웠다.

아마 그때 이 경험이 없었다면, 다음 프로젝트에서도 비슷한 실수를 반복했을 것 같다.
그래서 지금도 이 프로젝트는 나한테 꽤 중요한 의미로 남아 있다.

<!-- EN -->

When I first built PowerBalance, I genuinely thought it was a pretty breakthrough idea.

Game balancing clearly involves a lot of repetitive calculation, and spreadsheets like Excel or Google Sheets have obvious limitations for that kind of work.
So I believed that if I put game-specific formulas, simulations, and validation tools in one place, it would definitely help game designers.

And to be fair, it did help at least one real person.
A friend of mine who was working on indie game balancing was satisfied with it, which made me feel that the problem I was trying to solve was not wrong.
The need itself was real.

But once I tried promoting it, the reaction was much colder than I expected.
Some people showed interest, but very few actually tried using it.
And that made one thing very clear:
something that "looks useful" and something that people actually adopt are two very different things.

![](/uploads/project/IndiBalancing/powerbalance-feedback.png)

What stayed with me most was the feedback around usability.
The direction and feature set seemed interesting, but people felt lost when they first opened the app and did not know what to do first.
As a builder, it is easy to assume that more features make a product better.
But from the user's side, if the value is not clear within the first few minutes, they are likely to leave.

Looking back, most people already had their own workflow.
Some used Excel, some used Google Sheets, and some managed things with notes and experience.
Even if I thought those workflows looked inconvenient, they were already familiar and working well enough for them.
Unless I could give them a very clear reason to switch, a richer feature set alone was not enough.

That lesson stayed with me for a long time.
Later, when I built CodingTestKit, I became much more careful about one question:
why should someone use this right now?
I paid more attention to whether the tool improved an existing workflow immediately, and whether a first-time user could feel the value without much explanation.

In the end, that difference mattered.
PowerBalance taught me both the potential and the limit of a good idea, and that lesson shaped how I approached the next project.
CodingTestKit eventually reached 254 downloads.

So when I look back now, I do not really see PowerBalance as a failed project.
It was the project that changed the way I think about products.
It taught me that building good features and building something people actually use are not the same thing.

If I had not learned that lesson then, I probably would have repeated the same mistake in the next project.
That is why this project still matters a lot to me.

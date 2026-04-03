---
title: '진짜 중요한 게 뭘까'
titleEn: 'What Really Matters'
description: Redis나 Kafka 같은 기술 이름보다, 왜 그 기술이 필요해졌는지와 어떤 문제를 해결하려고 하는지를 이해하는 것이 더 중요하다고 느낀 요즘의 생각을 정리한 글입니다.
descriptionEn: A personal note on realizing that understanding why a technology became necessary matters more than simply knowing its name.
date: 2026-04-03T00:00:00.000Z
tags:
  - 일상
  - 개발
  - 백엔드
  - 성장
  - 고민
category: daily
coverImage: /uploads/banners/banner-main.png
draft: false
---

백엔드 개발자로서 대용량 처리가 중요하다는 말을 자주 듣는다.
Redis, Kafka, CDC 같은 기술도 분명 중요하다.
그런데 요즘은 이런 생각이 자꾸 든다.
정말 중요한 건 대용량 처리 기술을 얼마나 많이 아느냐일까, 아니면 왜 그 기술이 필요해졌는지를 이해하는 일일까.

가끔은 내가 기술 이름에 너무 쉽게 끌리고 있는 건 아닐까 돌아보게 된다.
다른 사람들이 많이 쓰니까,
공고에 자주 나오니까,
나도 당연히 알아야 한다고 생각했던 건 아닐까 싶다.
하지만 결국 그런 기술들도 처음부터 목적이었던 건 아니다.
사용하는 사람들이 불편했고,
기존 구조로는 그 불편을 감당할 수 없었기 때문에 나온 선택지였을 뿐이라는 생각이 든다.

진짜 엔지니어는 기술을 많이 아는 사람이라기보다,
문제를 제대로 보는 사람에 더 가까운 것 같다.
내가 만들고 싶은 것,
내가 멋지다고 느끼는 구조,
내가 공부하고 싶은 기술도 중요하다.
그런데 결국 서비스는 사용하는 사람이 있어야 의미가 있다.
사용자들은 어디서 불편했는지,
운영하는 사람들은 무엇 때문에 힘들었는지,
팀은 어떤 구조에서 계속 비용을 치르고 있었는지를 먼저 봐야 하는 것 같다.

어쩌면 나는 그동안 너무 나의 관점에서만 개발을 봤던 것 같다.
내가 성장하고 있는지,
내가 어려운 기술을 다루고 있는지,
내가 복잡한 구조를 만들 수 있는지 같은 것들 말이다.
물론 그런 고민도 필요하다.
하지만 정말 중요한 건,
사용하는 사람들이 덜 불편해졌는지,
일하는 사람들이 덜 힘들어졌는지,
문제가 생겼을 때 더 쉽게 이해하고 복구할 수 있게 되었는지일지도 모른다.

결국 백엔드에서 여러 기술이 등장한 이유도 비슷하다고 생각한다.
트래픽이 많아서,
데이터가 커서,
장애가 잦아서,
정합성이 중요해서,
응답속도가 느려서.
즉, 기술이 먼저 있었던 게 아니라 문제와 불편이 먼저 있었고,
그걸 해결하기 위해 기술이 필요해졌을 뿐이라는 것이다.

그래서 이제는 기술을 공부할 때도 조금 다른 기준을 가져가고 싶다.
이 기술이 유명하니까 알아야지가 아니라,
어떤 문제를 해결하려고 나온 기술인지,
이 기술이 아니면 안 되는 순간은 언제인지,
오히려 쓰지 않는 게 더 나은 상황은 언제인지,
이걸 더 중요하게 보고 싶다.

공고에서 특정 기술을 요구하는 것도 결국 비슷한 의미일 것 같다.
회사가 그 기술 자체를 사랑해서라기보다,
지금 자기들이 겪고 있는 문제를 그 기술 위에서 풀고 있기 때문에,
그 맥락을 이해하는 사람이 와주길 바라는 것에 더 가깝지 않을까 싶다.
겉으로 보이는 스택은 달라도,
결국 바닥에 깔린 질문은 비슷하다.
무슨 문제가 있었고,
왜 그것이 필요했고,
어떤 trade-off 끝에 지금 구조가 선택되었는가.

아마 진짜 엔지니어는
기술에 종속되는 사람이 아니라,
기술을 문제의 맥락 속에서 이해하는 사람인 것 같다.

그리고 나도 점점 그런 사람이 되고 싶다.
Redis를 쓸 줄 아는 사람보다,
왜 여기서는 Redis가 필요했고 다른 곳에서는 필요 없었는지 설명할 수 있는 사람.
Kafka를 붙여본 사람보다,
왜 어떤 시스템은 Kafka가 맞고 어떤 시스템은 오버엔지니어링이 되는지 판단할 수 있는 사람.

결국 중요한 건 기술 이름이 아니라
불편을 발견하는 시선,
문제를 정의하는 힘,
그리고 그 문제에 맞는 선택을 할 수 있는 태도라는 생각이 든다.

아직은 그런 시선이 충분하지 않을 때도 많다.
그래도 적어도 이제는
어려운 기술을 썼다는 사실 자체보다,
왜 그 기술을 선택했는지 설명할 수 있는 사람이 되고 싶다.
요즘 자꾸 드는 생각은 결국 그쪽에 더 가까워지고 있다는 신호인 것 같다.

<!-- EN -->

People often say that large-scale processing is important for backend engineers.
Technologies like Redis, Kafka, and CDC are clearly important too.
But lately I keep coming back to a different question:
what really matters more, knowing many large-scale technologies, or understanding why those technologies became necessary in the first place?

Sometimes I wonder if I have been drawn too easily to the names of technologies.
Maybe I thought I had to learn them simply because everyone uses them,
or because they appear so often in job postings.
But in the end, those technologies were never the true goal.
They became options only because users were uncomfortable,
and because older structures could no longer absorb that discomfort.

The more I think about it, the more I feel that a real engineer is not just someone who knows many technologies.
It is someone who sees the problem clearly.
What I want to build matters.
The structures I personally find elegant matter.
The technologies I want to study matter too.
But a service only becomes meaningful when there are people actually using it.
So I think I need to look first at where users felt friction,
what made operators struggle,
and what kind of structural cost a team kept paying over time.

Maybe I spent too much time looking at development only from my own perspective.
Whether I was growing,
whether I was handling difficult technologies,
whether I could build something complicated.
Those questions still matter.
But maybe what matters more is whether users became less uncomfortable,
whether the people working on the system became less exhausted,
and whether the system became easier to understand and recover when something went wrong.

I think that is also why so many backend technologies appeared in the first place.
Traffic grew.
Data grew.
Failures became frequent.
Consistency mattered.
Latency became painful.
So technology did not come first.
Problems and discomfort came first,
and technology followed because something had to solve them.

That is why I want to use a different standard when I study technology now.
Not “this is famous, so I should learn it,”
but:
what problem was this created to solve,
when is this truly necessary,
and when is not using it actually the better decision?

I think job postings mean something similar.
Companies are not asking for a technology because they love the name itself.
They are usually dealing with a set of problems on top of that stack,
and they want someone who can understand that context.
The visible stack may differ,
but the underlying questions are often the same:
what was the problem,
why was this needed,
and what trade-offs led to the current structure?

Maybe a real engineer is not someone who is attached to technology,
but someone who understands technology inside the context of a problem.

And I want to become that kind of person more and more.
Not just someone who knows how to use Redis,
but someone who can explain why Redis is necessary in one place and unnecessary in another.
Not just someone who has used Kafka,
but someone who can judge when Kafka makes sense and when it becomes overengineering.

In the end, what matters is not the name of a technology.
It is the ability to notice discomfort,
the ability to define a problem,
and the attitude to choose what fits that problem.

I still feel far from that sometimes.
But at least now, more than simply wanting to say I used a difficult technology,
I want to become someone who can explain why that technology was chosen at all.
Lately, I think that desire itself is already pushing me in a better direction.

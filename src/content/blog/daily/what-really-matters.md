---
title: '기술보다 문제가 먼저다'
titleEn: 'Problems Come Before Technology'
description: 기술 이름이 아니라 문제를 먼저 보는 개발자가 되고 싶다는 생각을 정리한 글입니다. 왜 그 기술이 필요했는지, 어떤 trade-off를 거쳤는지를 설명할 수 있는 것이 진짜 실력이라고 느낀 과정을 기록합니다.
descriptionEn: A note on growing as an engineer who sees problems before reaching for technology, and who can explain the why behind every technical decision.
date: 2026-04-03T00:00:00.000Z
tags:
  - 일상
  - 개발
  - 백엔드
  - 성장
category: daily
coverImage: /uploads/banners/banner-main.png
draft: false
---

한동안 이런저런 생각을 많이 했다.

나는 개발하는 걸 좋아한다.
무언가를 만들고, 문제를 붙잡고, 왜 안 되는지 파고들다가 결국 해결되는 순간이 좋다.
그런데 좋아하는 것과 잘하는 것은 다른 문제라는 걸 요즘 더 자주 느끼게 된다.

예전에는 많이 만들고, 많이 시도하면 자연스럽게 실력이 늘 거라고 생각했다.
물론 그런 시간도 필요하지만, 돌아보면 "일단 되게 만드는 것"에 만족했던 적이 꽤 있었다.
왜 이 구조가 맞는지, 왜 이 선택이 더 나은지를 끝까지 붙잡는 건 아직 연습이 더 필요하다.

---

## 기술 이름보다 문제

백엔드 개발을 하다 보면 Redis, Kafka, CDC 같은 기술을 공부하는 건 자연스러운 일이다.
그런데 요즘은 기술을 공부할 때 이런 질문을 먼저 해보게 됐다.

- 이 기술이 어떤 문제를 해결하려고 나온 건지
- 이 기술이 아니면 안 되는 순간은 언제인지
- 오히려 쓰지 않는 게 더 나은 상황은 언제인지

생각해보면, 기술이 먼저 있었던 건 아니었다.
트래픽이 많아서, 데이터가 커서, 장애가 잦아서, 응답이 느려서.
문제가 먼저 있었고, 그걸 해결하기 위해 기술이 필요해진 것뿐이었다.

가끔은 내가 기술 이름에 너무 쉽게 끌렸던 건 아닌가 돌아보게 된다.
다른 사람들이 많이 쓰니까, 공고에 자주 나오니까, 당연히 알아야 한다고 생각했던 건 아닌지.

---

## 누구를 위한 건지

프로젝트를 하면서 점점 느끼는 게 있다.
나는 종종 내 관점에서만 개발을 봤던 것 같다.
내가 성장하고 있는지, 내가 어려운 기술을 다루고 있는지 같은 것들.

물론 그런 고민도 필요하다.
하지만 결국 서비스는 사용하는 사람이 있어야 의미가 있으니까,
사용하는 사람들이 덜 불편해졌는지, 운영하는 사람들이 덜 힘들어졌는지를 같이 봐야 한다는 걸 깨달았다.

직접 프로젝트를 운영하면서 느낀 건, 기술적으로 멋진 구조보다
실제로 문제가 줄어들었는지가 더 중요하다는 거였다.
조회수 처리 방식을 바꿨을 때도, 이벤트 구조를 분리했을 때도,
내가 정말 고민한 건 "이게 기술적으로 맞는가"보다 "이걸로 진짜 문제가 해결되는가"에 더 가까웠다.

---

## 깊이 있게 해보기

요즘은 하나를 하더라도 더 깊게 해보려고 한다.
구현으로 끝내지 않고, 로그를 보고, 실행 계획을 보고, 공식 문서를 보고, 다른 대안과 비교해보고,
내가 왜 그 선택을 했는지 설명할 수 있을 때까지 붙잡아보는 식으로.
아마 이 과정은 느릴 수 있지만, 그렇게 쌓인 이해가 결국 실력이 된다고 믿는다.

---

## 결국

Redis를 쓸 줄 아는 것보다, 왜 여기서는 Redis가 필요했고 다른 곳에서는 필요 없었는지 설명할 수 있는 게 더 중요한 것 같다.
Kafka를 붙여본 것보다, 왜 어떤 시스템에서는 Kafka가 맞고 어떤 시스템에서는 과한 선택인지 판단할 수 있는 게.

아직 그런 시선이 충분하지 않을 때도 많다.
그래도 적어도 이제는, 어려운 기술을 썼다는 사실 자체보다
왜 그 기술을 선택했는지 설명할 수 있는 사람이 되고 싶다.
나는 지금 그 방향으로 잘 가고 있는 것 같다.

<!-- EN -->

I have been thinking about a lot of things lately.

I like development.
I like building things, digging into problems, and that moment when something finally clicks.
But lately I keep realizing that liking something and being good at it are different things.

I used to think that building a lot and trying a lot would naturally make me better.
That kind of time matters too, but looking back, I was often satisfied just making things work.
Pushing through questions like why this structure makes sense, or why one choice is better than another — that still needs more practice.

## Problems before technology

Studying Redis, Kafka, and CDC is natural for a backend engineer.
But these days I try to ask different questions first:

- What problem was this technology created to solve?
- When is it truly necessary?
- When is not using it actually the better decision?

Technology did not come first. Traffic grew, data grew, failures became frequent, latency became painful.
Problems came first, and technology followed to solve them.

Sometimes I wonder if I was drawn too easily to the names of technologies.
Maybe I thought I had to learn them just because everyone else uses them, or because they appear in job postings.

## Who is it for

While working on projects, I started noticing something.
I was often looking at development only from my own perspective.
Whether I was growing, whether I was handling something impressive.

Those questions matter too. But a service is only meaningful when there are people using it.
I realized I need to also look at whether users became less frustrated, whether operators became less exhausted.

What I felt through running my own project was that what matters more than an elegant architecture
is whether the actual problem was reduced.
When I changed how view counts were handled, or when I separated the event structure,
what I was really thinking about was closer to "does this actually solve the problem" than "is this technically correct."

## Going deeper

These days I try to go deeper on each thing I work on.
Not stopping at implementation, but reading logs, checking execution plans, comparing alternatives, and holding onto the problem until I can explain why I made a certain choice.
It might be slower, but I believe that kind of understanding is what eventually becomes real skill.

## In the end

Knowing how to use Redis matters less than being able to explain why Redis was necessary in one place and unnecessary in another.
Having set up Kafka matters less than being able to judge when Kafka makes sense and when it becomes an excessive choice.

I still do not always have that perspective.
But at least now, more than wanting to say I used a difficult technology,
I want to become someone who can explain why it was chosen.
I think I am heading in the right direction.

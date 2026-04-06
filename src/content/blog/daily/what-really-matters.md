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

나는 개발하는 걸 좋아한다.
무언가를 만들고, 문제를 붙잡고, 왜 안 되는지 파고들다가 결국 해결되는 순간이 좋다.

그런데 최근에 생각이 많이 바뀌었다.
예전에는 많이 만들고, 많이 시도하면 자연스럽게 실력이 늘 거라고 생각했다.
요즘은 다르게 본다. 중요한 건 **얼마나 많이 했느냐가 아니라 얼마나 깊게 이해했느냐**라는 걸 느끼고 있다.

---

## 기술 이름에 끌리지 않기

백엔드 개발자로서 Redis, Kafka, CDC 같은 기술을 공부하는 건 당연하다.
하지만 요즘은 이런 기준을 더 중요하게 본다.

- 이 기술이 **어떤 문제를 해결하려고** 나온 건지
- 이 기술이 아니면 안 되는 순간은 **언제**인지
- 오히려 **쓰지 않는 게 더 나은** 상황은 언제인지

기술이 먼저 있었던 게 아니다.
트래픽이 많아서, 데이터가 커서, 장애가 잦아서, 정합성이 중요해서, 응답이 느려서.
**문제가 먼저 있었고, 그걸 해결하기 위해 기술이 필요해졌을 뿐이다.**

---

## 사용하는 사람의 관점

프로젝트를 하면서 점점 느끼는 건, 결국 서비스는 사용하는 사람이 있어야 의미가 있다는 것이다.

내가 만들고 싶은 것, 내가 멋지다고 느끼는 구조도 중요하다.
하지만 더 중요한 건:

- 사용하는 사람들이 **덜 불편해졌는지**
- 운영하는 사람들이 **덜 힘들어졌는지**
- 문제가 생겼을 때 **더 쉽게 이해하고 복구할 수 있게** 되었는지

wikiEngine에서 조회수를 Redis INCR로 옮긴 것도, CDC로 이벤트를 디커플링한 것도, 결국 이 기준에서 나온 판단이었다.

---

## 깊이 있는 이해가 실력이다

코드를 짜는 속도보다 중요한 건 **문제를 정확히 정의하는 힘**이다.
성능 이슈를 만나면 감으로 넘기지 않고 **수치로 확인**하는 습관이다.
동작하는 기능을 만든 뒤에도 **구조와 trade-off를 다시 돌아보는** 태도다.

하나를 하더라도 더 깊게 해보려고 한다.
구현으로 끝내지 않고, 로그를 보고, 실행 계획을 보고, 공식 문서를 보고, 다른 대안과 비교해보고,
**내가 왜 그 선택을 했는지 설명할 수 있을 때까지** 붙잡아보려고 한다.

---

## 되고 싶은 개발자

Redis를 쓸 줄 아는 사람보다, **왜 여기서는 Redis가 필요했고 다른 곳에서는 필요 없었는지** 설명할 수 있는 사람.

Kafka를 붙여본 사람보다, **왜 어떤 시스템은 Kafka가 맞고 어떤 시스템은 오버엔지니어링이 되는지** 판단할 수 있는 사람.

Elasticsearch를 안 쓰고 Lucene을 직접 쓴 이유를 설명할 수 있고, 규모가 커지면 언제 전환해야 하는지도 말할 수 있는 사람.

결국 중요한 건 기술 이름이 아니라
**불편을 발견하는 시선, 문제를 정의하는 힘, 그리고 그 문제에 맞는 선택을 할 수 있는 태도**라고 생각한다.

그리고 나는 지금 그 방향으로 가고 있다.

<!-- EN -->

I like development.
I like building things, digging into problems, and that moment when something finally clicks.

But my thinking has shifted recently.
I used to believe that building more and trying more would naturally make me better.
Now I see it differently. What matters is not how much you do, but how deeply you understand what you did.

## Looking past technology names

Studying Redis, Kafka, and CDC is natural for a backend engineer.
But I now prioritize different questions:

- What problem was this technology created to solve?
- When is it truly necessary?
- When is not using it actually the better decision?

Technology did not come first.
Traffic grew, data grew, failures became frequent, consistency mattered, latency became painful.
Problems came first, and technology followed because something had to solve them.

## Thinking from the user's perspective

Building something I find elegant matters.
But what matters more is whether users became less uncomfortable, whether operators became less exhausted, and whether the system became easier to understand and recover when things broke.

Moving view counts to Redis INCR, decoupling events through CDC — those decisions came from this perspective.

## Deep understanding is real skill

More important than coding speed is the ability to define problems clearly, to verify performance with numbers instead of intuition, and to revisit structure and trade-offs even after a feature works.

I want to go deeper on each thing I work on. Not stopping at implementation, but reading logs, checking execution plans, comparing alternatives, and holding onto the problem until I can explain why I made a certain choice.

## The kind of engineer I want to be

Not just someone who knows how to use Redis, but someone who can explain why Redis was necessary in one place and unnecessary in another.

Not just someone who has set up Kafka, but someone who can judge when Kafka makes sense and when it becomes overengineering.

Someone who can explain why they used Lucene directly instead of Elasticsearch, and when the right time to switch would be.

What matters is not the name of a technology.
It is the ability to notice discomfort, to define problems, and to choose what fits.

And I am moving in that direction.

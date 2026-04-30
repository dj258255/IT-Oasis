---
title: 'Balruno를 만들면서 배우고, 지금도 다듬는 것'
titleEn: 'What I Am Learning From Building Balruno — Still Iterating'
description: 인디게임 밸런싱 도구 Balruno의 첫 사용자 반응에서 얻은 배움과, 그 피드백을 바탕으로 진입 장벽·온보딩·백엔드까지 지금도 진행 중인 개선 방향을 정리한 글입니다.
descriptionEn: How early user feedback on Balruno is reshaping its onboarding, UX, and the backend rebuild that is currently in progress.
date: 2026-04-02
tags:
  - Retrospective
  - User Feedback
  - Product
  - Game Design
  - Balruno
category: project/Balruno
coverImage: /uploads/project/Balruno/powerbalance-feedback.png
draft: false
series: "Balruno"
---

Balruno를 처음 만들 때는 꽤 가능성이 보이는 방향이라고 생각했다.

게임 밸런싱은 분명히 반복 계산이 많고, 엑셀이나 구글 시트만으로는 불편한 점도 많다.
그래서 게임 기획자에게 필요한 수식, 시뮬레이션, 검증 기능을 한곳에 모아두면 분명히 도움이 될 거라는 확신이 있었다.

실제로 주변에서 인디게임 밸런싱을 하던 친구도 만족스럽게 써줬다.
내가 잡았던 문제의식 자체는 틀리지 않았다는 신호였다.
적어도 누군가에게는 분명히 가치가 있는 도구라는 점은 확인했다.

다만 막상 외부에 알려보니 반응은 예상보다 신중했다.
관심을 보이는 사람은 있었지만 들어와서 끝까지 써보는 사람은 많지 않았다.
*"필요해 보인다"* 와 *"실제로 쓰게 된다"* 는 전혀 다른 문제라는 점을 이때 확실히 체감했다.

![](/uploads/project/Balruno/powerbalance-feedback.png)

특히 가장 큰 인사이트는 **사용성에 대한 피드백** 이었다.
방향성과 기능 자체는 흥미롭다는 평이 많았지만, 처음 켰을 때 무엇부터 해야 할지 막막하고 진입 장벽이 높다는 의견이 반복됐다.
개발자 입장에서는 기능이 많을수록 좋다고 생각하기 쉽지만, **사용자는 처음 5분 안에 감이 오지 않으면 그대로 떠난다**.
이 한 줄을 사용자 반응에서 직접 들으면서 다음 개선의 방향이 분명해졌다.

돌이켜보면 사람들은 이미 각자 익숙한 작업 흐름이 있다.
누군가는 엑셀을 쓰고, 누군가는 구글 시트를 쓰고, 누군가는 머릿속과 메모로도 충분히 작업한다.
내가 보기엔 불편해 보여도, 그들에게는 이미 굴러가고 있는 흐름이 있는 거다.
**그 흐름을 바꿀 만큼 명확한 이유** 를 처음 5분 안에 보여주는 것 — 이게 Balruno가 풀어야 할 진짜 과제였다.

그래서 지금은 그 방향으로 다음 버전을 적극적으로 다듬고 있다.

- **온보딩 재설계** — 처음 켜자마자 *"내가 무엇을 할 수 있는지"* 가 한눈에 보이도록, 빈 화면 대신 가벼운 샘플 시나리오와 가이드 흐름을 기본으로.
- **진입 장벽 낮추기** — 모든 기능을 한 번에 보여주지 않고, *처음 5분 안에 가치를 느끼는 경로* 를 우선.
- **백엔드 도입** — 지금까지는 클라이언트 중심 구조였지만, 협업·저장·시뮬레이션 결과 공유를 자연스럽게 하기 위해 **서버를 새로 붙이고 곧 배포** 한다.
- **사용성 피드백 반영** — 친구와 초기 사용자에게서 받은 구체적인 피드백을 우선순위로 두고 인터랙션을 조정 중.

이 경험은 다른 프로젝트에서도 그대로 살아 있다.
[CodingTestKit](/blog/project/codingtestkit/codingtestkit-introduction)을 만들 때는 *"기능이 많은가"* 가 아니라 *"사람이 지금 당장 왜 이걸 써야 하는가"* 를 훨씬 더 의식했고, 처음 설치한 사람이 설명 없이도 바로 가치를 느낄 수 있는 지점을 우선 설계했다.
그 방향성 위에서 나온 CodingTestKit은 다운로드 254회를 기록했고, **같은 원칙을 Balruno에도 그대로 적용해서 다시 다듬는 중** 이다.

그래서 지금 시점에서 Balruno는 *"실패한 프로젝트"* 가 아니라, **첫 사용자 반응에서 다음 방향을 명확히 잡은 진행 중인 프로젝트** 다.
좋은 기능을 만드는 것과 사람들이 실제로 쓰는 도구를 만드는 것은 다르다는 — 그 차이를 직접 확인했고, 그 위에서 지금도 계속 만들어가고 있다.

<!-- EN -->

When I first built Balruno, I saw real potential in the direction.

Game balancing involves a lot of repetitive computation, and spreadsheets like Excel or Google Sheets have clear limitations for that kind of work.
So I was confident that bringing the formulas, simulations, and validation a game designer needs into one place would genuinely help.

A friend who was working on indie game balancing actually used it and was happy with it.
That confirmed the underlying problem was real — at least for some people, the tool clearly created value.

When I started showing it more broadly, however, the reception was more cautious than I expected.
People showed interest, but few stuck around to use it end to end.
That is when I really felt the difference between *"this looks useful"* and *"I actually use this."*

![](/uploads/project/Balruno/powerbalance-feedback.png)

The most valuable insight came from **usability feedback**.
The direction and feature set were interesting, but multiple people said they did not know what to do first when they opened the app — the entry barrier felt too high.
As a builder it is easy to assume more features means a better product, but **users leave within the first five minutes if the value is not obvious**.
Hearing that directly from real users made the next iteration's direction clear.

Looking back, everyone already has a workflow that works for them.
Some use Excel, some use Google Sheets, some manage with notes and intuition.
Even if those workflows look inefficient to me, they are already running for the people using them.
**Showing a clear reason to switch — within the first five minutes** — that is the real challenge Balruno needs to solve.

So that is exactly what I am actively working on for the next version.

- **Onboarding redesign** — instead of an empty canvas, the app starts with a lightweight sample scenario and a guided flow so users can see *"what I can do here"* at a glance.
- **Lower the entry barrier** — instead of exposing every feature at once, prioritize the path that *delivers value within the first five minutes*.
- **Backend introduction** — Balruno has been client-side so far, but to make collaboration, persistence, and simulation-result sharing feel natural, **a server is being added and will ship soon**.
- **Acting on real feedback** — the specific feedback from my friend and early users is the top input shaping ongoing interaction tweaks.

This experience continues to inform other projects.
When I built [CodingTestKit](/blog/project/codingtestkit/codingtestkit-introduction), I focused much more on *"why would someone use this right now?"* rather than *"how many features can I add?"*, and made sure first-time users could feel the value without explanation.
That direction got CodingTestKit to 254 downloads, and **I am applying the same principle back to Balruno as I iterate**.

So at this point, Balruno is not a *"failed project"* — it is **a project that locked in a clear next direction from the first round of user feedback, and is actively being improved**.
Building good features and building something people actually use are not the same thing — I confirmed that difference firsthand, and I am still building on top of it.

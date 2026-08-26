---
title: '자막을 저장했더니 요약 입력이 됐습니다'
description: >-
  실시간 자막과 회의 요약은 같은 transcript에서 나오지만 병목이 다릅니다.
  자막은 지연, 요약은 토큰입니다. 둘을 한 경로에 두지 않고 나눈 기록입니다.
date: 2026-08-26
tags:
  - EduMeet
  - STT
  - LLM
  - Spring Boot
  - MySQL
  - FastAPI
category: team/EduMeet
coverImage: /uploads/project/EduMeet/EduMeetTitle.png
draft: false
series: "EduMeet"
seriesOrder: 10
---

이 서비스의 존재 이유는 **청각장애 학습자를 위한 실시간 자막**입니다.

그 경로를 잇고 나니 옆에 붙어 있던 기능이 다시 보였습니다. 회의 요약입니다. 둘 다 STT가 만든 transcript에서 나옵니다. 그래서 처음에는 같은 경로에 두려고 했습니다.

**나누는 쪽이 맞았습니다.** 단위가 다르기 때문입니다.

## 자막은 시간으로, 요약은 토큰으로 과금됩니다

| | 무엇으로 재나 | 먼저 무너지는 것 |
|---|---|---|
| 실시간 자막 | STT — **오디오 시간** | 지연 |
| 회의 요약 | LLM — **토큰** | 장문 문맥 |

같은 원천인데 비용의 단위가 다릅니다. 자막은 강의가 한 시간이면 한 시간어치를 냅니다. 사람이 얼마나 말했는지와 무관합니다. 요약은 반대입니다. 조용한 한 시간은 거의 공짜고, 빽빽한 20분이 더 비쌉니다.

여기서 나온 결론이 하나 있습니다.

> **자막 hot path에서는 LLM을 부르지 않습니다.**

부르면 모델 지연과 장애점이 **자막 조각마다** 붙습니다. 조각이 초당 하나씩 나오는데 그 하나하나가 외부 API 호출이 되는 구조입니다.

대신 결정적인 용어 사전을 씁니다.

```python
(re.compile(r"\bpython\b", re.IGNORECASE), "파이썬"),
(re.compile(r"\bspring\s*boot\b", re.IGNORECASE), "스프링 부트"),
(re.compile(r"\bweb\s*socket\b", re.IGNORECASE), "WebSocket"),
```

한국어 강의 안의 영어 기술어가 STT에서 제일 많이 흔들립니다. 그 부분만 규칙으로 잡습니다. 문법이나 문맥은 건드리지 않습니다 — 그건 모델이 할 일이고, 모델은 회의가 끝난 뒤에 부르면 됩니다.

## partial 자막은 저장하지 않습니다

자막에는 두 종류가 있습니다. 화면에서 계속 바뀌는 중간 결과(partial)와 확정된 것(final)입니다.

partial을 저장하면 요약이 망가집니다.

```
"오늘은"
"오늘은 백엔"
"오늘은 백엔드를"
"오늘은 백엔드를 봅니다"
```

네 줄이 저장되고, 요약 프롬프트는 같은 말을 네 번 읽습니다. **토큰을 중간 결과에 씁니다.** 그리고 transcript가 "사용자가 본 화면"과 "실제 발화"가 뒤섞인 물건이 됩니다.

그래서 `final_segment = true`인 것만 저장합니다.

## 저장을 발행 경로 밖으로 뺐습니다

자막이 화면에 도달하는 것과 DB에 남는 것은 급한 정도가 다릅니다.

```java
// 브로드캐스트가 먼저다. 저장은 큐에 넣고 반환한다.
CaptionBroadcast broadcast = publish(...);
if (request.finalSegment()) {
    captionArchiveQueue.offer(...);
}
return broadcast;
```

시험으로 이 순서를 고정했습니다.

```java
assertThat(captionArchiveQueue.queuedCount())
        .as("요청 반환 시점에 큐에 있어야 한다. DB 저장까지 기다리면 hot path 가 느려진다")
        .isEqualTo(1);
assertThat(captionSegmentRepository.countByMeetingId(meetingId))
        .as("반환 시점에 이미 DB 에 있으면 동기 저장이다")
        .isZero();
```

**"반환 시점에 아직 DB에 없어야 한다"를 단언합니다.** 있으면 동기 저장이라는 뜻이고, 그건 자막 표시가 DB를 기다린다는 뜻입니다.

## 순서를 무엇으로 세울 것인가

저장이 비동기가 되면서 문제가 하나 생겼습니다. **저장 순서와 발화 순서가 다릅니다.**

```java
ORDER BY
  CASE WHEN c.sequence IS NULL THEN 1 ELSE 0 END,   -- sequence 없는 조각은 뒤로
  c.sequence ASC,
  c.spokenAt ASC,
  c.id ASC
```

`sequence`가 있으면 그것이 기준입니다. 없는 과거·비정상 입력은 발화 시각과 id로 뒤에 붙입니다. 이 JavaDoc에 한 줄을 적어 뒀습니다.

> **여기서 순서가 흔들리면 요약 결과도 흔들린다.**

나중에 이 한 줄이 다른 결정을 하나 더 만들게 됩니다. 다음 글에서 씁니다.

## 지금 이것은 실시간 자막이 아닙니다

정직하게 적어 둡니다.

파이썬은 CLOVA **batch** STT를 씁니다. 녹음이 끝난 뒤 파일 하나를 던지고 전체 텍스트를 한 덩어리로 받습니다. 회의가 끝나야 텍스트가 나오는데 실시간일 수가 없습니다.

그래서 계약에 이렇게 적습니다.

```
realtime: false
approximate_timing: true
```

그럼에도 지금 잇는 이유는 두 가지입니다.

- **소스를 바꾸는 순간 붙일 곳이 있어야 합니다.** CLOVA 스트리밍으로 바꾸는 것은 파이썬 쪽 작업이고, 자바·프론트 경로는 그대로 씁니다.
- **지금도 쓸 데가 있습니다.** 문장 단위로 보내면 다시보기 자막이 됩니다.

실시간 STT로 바꾸지 않은 것은 능력의 문제가 아니라 순서의 문제입니다. 스트리밍 API는 유료이고, 지금 이 프로젝트에서 재고 싶은 것은 STT 정확도가 아니라 **경로가 끊기지 않는가**입니다.

## 정리

| | |
|---|---|
| 자막 hot path | LLM 없음. 결정적 용어 사전만 |
| 요약 | 회의 후 batch. map → reduce |
| 저장 | final만, 발행 경로 밖에서 비동기 |
| 순서 | `sequence` → `spokenAt` → `id` |

**같은 원천에서 나온다고 같은 경로에 둘 이유는 없습니다.** 무엇으로 과금되는지가 다르면 무너지는 곳도 다릅니다.

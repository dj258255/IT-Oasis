---
title: '실행할 수 없는 기능을 테스트하는 법'
description: >-
  HLS 송출을 붙였는데 로컬에서도 서버에서도 egress를 띄울 수 없었습니다.
  요청을 값으로 분리해 함정 네 개를 고정했고, 오픈소스 소스를 읽어
  우리 서버가 오디오 방송만 돌릴 수 있다는 것을 확인했습니다.
  그리고 마지막에, 그 모든 코드가 애초에 실행된 적 없다는 것을 알았습니다.
date: 2026-08-23
tags:
  - EduMeet
  - LiveKit
  - HLS
  - WebRTC
  - Spring Boot
  - Testing
  - JPA
category: team/EduMeet
coverImage: /uploads/project/EduMeet/EduMeetTitle.png
draft: false
series: "EduMeet"
seriesOrder: 5
---

EduMeet에는 방송 모드가 세 개 있습니다.

```
INTERACTIVE       화상채팅        1초 미만
BROADCAST         라이브스트리밍   수 초
AUDIO_BROADCAST   오디오스트리밍   수 초
```

채팅은 이 셋 모두의 공통 기능입니다. 이번에는 이 세 모드를 실제로 쓸 수 있게 만드는 작업을 했습니다.

---

## 1. 채팅이 정말 공통인지부터 확인했습니다

"공통 기능"이라는 말은 코드에 있었지만 테스트에는 없었습니다.
기존 STOMP 테스트는 `INTERACTIVE`와 `BROADCAST`만 덮고 있었고, `AUDIO_BROADCAST` 채팅은 검증된 적이 없었습니다.

찾아보니 채팅 코드에서 세션 타입으로 갈리는 곳은 **저장 정책 하나뿐**이었습니다.

```java
// 접근 정책 — 모드 무관. 이 방에 참가했는가만 봅니다
MeetingParticipant.findActive(meetingId, email)

// 저장 정책 — 모드별
sessionType.persistsChatInline()
```

이 분리가 맞는 모양이라고 판단했습니다. 섞이면 모드가 늘 때마다 접근 로직을 건드리게 되니까요.

테스트는 `@EnumSource(SessionType.class)`로 썼습니다.
**모드를 추가하면 이 테스트가 그 모드에 대해서도 돕니다.** 새 모드에서 채팅이 안 되는 것을 잊고 넘어갈 수 없습니다.

---

## 2. "오디오 전용"이 클라이언트 관례에 불과했습니다

`SessionType.isAudioOnly()`를 만들어 뒀는데, 참조하는 곳을 찾아보니 **테스트뿐이었습니다.**

토큰 발급 코드는 이렇게 되어 있었습니다.

```java
token.addGrants(
        new RoomJoin(true),
        new RoomName(roomName),
        new CanPublish(canPublish),   // 발행 여부만 있고
        new CanSubscribe(true)        // 무엇을 발행하는지는 없습니다
);
```

LiveKit은 `canPublishSources` 클레임이 **없으면 모든 소스를 허용합니다.**
즉 오디오 방송의 호스트가 카메라를 켤 수 있었습니다. 클라이언트 UI가 버튼을 안 보여줄 뿐이었습니다.

수정한 뒤 검증은 **발급된 JWT를 직접 열어서** 했습니다.

```java
String payload = jwt.split("\\.")[1];
JsonNode video = MAPPER.readTree(Base64.getUrlDecoder().decode(payload)).path("video");

assertThat(sources).containsExactly("microphone");
```

서비스가 무엇을 **의도했는지**가 아니라 **SFU에게 실제로 무엇을 말했는지**를 봐야 한다고 생각했습니다.
`canPublish` 필드만 확인하는 테스트였다면 이 버그는 그대로 통과했을 겁니다.

### 비디오 세션에는 일부러 넣지 않았습니다

`INTERACTIVE`에도 `["camera","microphone","screen_share"]`를 명시할 수 있었지만 하지 않았습니다.
**표현되는 정책이 없기 때문입니다.** 그냥 오늘의 소스 목록을 얼려서, LiveKit이 나중에 소스를 추가하면
화상 세션이 조용히 막히게 만들 뿐입니다.

그래서 테스트는 이렇게 씁니다.

```java
assertThat(video.has("canPublishSources")).isFalse();
```

**"빠뜨린 것"과 "일부러 안 넣은 것"을 구분해서 고정합니다.**

---

## 3. egress를 띄울 수 없었습니다

HLS 송출은 LiveKit Egress로 합니다. 그런데 egress 인스턴스를 띄우려면 이게 필요합니다.

```
--cap-add=SYS_ADMIN
Chrome + Xvfb + PulseAudio
Redis (livekit server와 같은 주소)
최소 4 CPU
```

**제 노트북에도 없고 우리 OCI 서버에도 없습니다.**

그런데 HLS의 실패는 대부분 **요청에서 나고, 조용합니다.** 잘못 만든 요청은 에러를 내지 않고
**이상한 방송**을 만듭니다.

| 실수 | 증상 |
|---|---|
| `live_playlist_name` 미지정 | 라이브인데 VOD 플레이리스트가 나갑니다. 방송 시작점부터 재생되고 플레이리스트가 무한 누적됩니다 |
| 두 플레이리스트가 다른 디렉터리 | LiveKit이 `ErrInvalidInput`으로 거부합니다 |
| `segment_duration` 기본값 4초 | 지연이 12초에서 출발합니다 (세그먼트 × 플레이어 버퍼 3개) |
| `forcePathStyle` 미설정 | R2가 가상 호스트 주소를 받지 않아 업로드가 실패합니다 |

**실행해서 눈으로 확인할 수 없는 종류의 버그입니다.**

그래서 요청 생성을 **네트워크를 타지 않는 순수 계산**으로 분리했습니다.

```
HlsEgressPlanner   요청을 만듭니다. 함정이 전부 여기 있습니다
HlsEgressPlan      요청 + LiveKit이 매길 CPU 비용
HlsEgressService   부르고 기록합니다
```

처음엔 `HlsEgressPlanner`의 설정값을 필드 `@Value`로 받았는데, 그러면 Spring 컨텍스트 없이는
인스턴스를 만들 수 없어서 "순수 계산"이라는 목적이 테스트에서 무너집니다. **생성자 주입으로 바꿨습니다.**

함정 네 개를 각각 되돌려서 테스트가 전부 잡는 것을 확인했습니다.

---

## 4. 소스를 읽고 우리 서버의 경계를 확인했습니다

조사 단계에서 적어 둔 문서에는 `room_composite_cpu_cost: 3.0`이라고 되어 있었습니다.
구현하면서 LiveKit egress 소스를 직접 읽어 봤습니다.

```go
// pkg/config/service.go
roomCompositeCpuCost      = 4      // 3.0이 아니었습니다
audioRoomCompositeCpuCost = 1
trackCpuCost              = 0.5
```

**문서에 적어 둔 값이 낡아 있었습니다.**

선택 로직도 확인했습니다.

```go
// pkg/stats/monitor.go
if r.RoomComposite.AudioOnly { costs.cpu = AudioRoomCompositeCpuCost }   // 1
else                         { costs.cpu = RoomCompositeCpuCost }        // 4

required := costs.cpu
accept   := available >= required        // 아니면 ErrNotEnoughCPU
```

우리 서버는 **2 OCPU**입니다.

| | 필요 | `2 >= 필요` | |
|---|---:|---|---|
| 비디오 방송 HLS | 4 | 거짓 | **거부됩니다** |
| 오디오 방송 HLS | 1 | 참 | **됩니다** |

### 싼 게 아니라 파이프라인이 다릅니다

왜 4배가 아니라 아예 다른 값인지 궁금해서 더 봤더니, 오디오 전용은 `ShouldUseSDKSource` 경로를 탑니다.
**헤드리스 Chrome 합성을 통째로 건너뜁니다.** Chromium, Xvfb, 화면 합성이 전부 빠집니다.

### 그리고 이게 제일 고약한 부분입니다

시작 시점 검사는 이렇게 되어 있습니다.

```go
func (m *Monitor) validateCPUConfig() error {
    sort.Float64s(requirements)
    if m.cpuStats.NumCPU() < requirements[0] {   // 가장 싼 타입(0.5)과만 비교합니다
        return errors.New("not enough cpu")
    }
```

**egress 프로세스는 정상으로 뜹니다.** 헬스체크도 초록입니다.
**비디오 방송 시작만 실패합니다.**

처음엔 "2코어면 egress가 아예 안 뜨겠구나"라고 생각했는데, 소스를 읽어 보니 틀렸습니다.
이런 종류가 운영에서 원인 찾기 가장 어려운 모양이라고 생각합니다.
그래서 이 숫자를 **코드에 상수로 박고 테스트로 고정했습니다.** 문서에만 적으면 잊습니다.

```java
assertThat(plan.fitsOn(2)).isFalse();   // 비디오 방송은 우리 서버에서 안 됩니다
```

---

## 5. 그런데 방송 세션을 만들 수가 없었습니다

여기까지 만들고 "그럼 방송 세션은 어떻게 만들지?"를 따라가 봤습니다.

```java
public class MeetingCreateRequestDto {
    private String title;
    private String description;
    private Long classId;
    // sessionType이 없습니다
}
```

```java
Meeting meeting = Meeting.builder()
        .title(...)
        .description(...)
        .startTime(LocalDateTime.now())
        .classRoom(classRoom)
        .build();          // sessionType을 넣지 않습니다
```

**API로 만든 모든 세션이 필드 기본값인 `INTERACTIVE`였습니다.**

그래서 아래가 전부 도달할 수 없는 코드였습니다.

```
세션 타입별 정원·발행 정책    도달 불가
오디오 방송 + 자막            도달 불가
오디오 전용 토큰 강제         도달 불가
HLS 송출                      절대 실행 불가
```

HLS는 특히 고약합니다. `INTERACTIVE`를 **명시적으로 거부하도록** 짜 뒀는데,
만들 수 있는 세션이 `INTERACTIVE`뿐이었으니 **어떤 입력으로도 성공할 수 없는 코드**였습니다.

### 왜 테스트가 못 잡았을까요

테스트는 전부 통과하고 있었습니다. `BROADCAST` 세션을 **테스트 안에서 직접 만들어서** 검증했기 때문입니다.

> 테스트가 부품을 검증했지, 부품이 연결되어 있는지는 검증하지 않았습니다.
> 테스트가 픽스처를 직접 만들면, 그 픽스처가 **실제로 만들어질 수 있는지는 영원히 안 물어보게 됩니다.**

이 프로젝트에서 "선언은 있는데 아무도 안 쓴다"를 만난 게 네 번째입니다.
[4편](/blog/project/EduMeet/config-that-does-nothing)에서 다룬 것들은 기능 하나가 죽어 있었지만,
이번엔 **기능 네 개가 통째로** 죽어 있었습니다.

### 방송은 누가 열 수 있나

고치면서 하나 정했습니다. **방송은 클래스 생성자만 엽니다.**

권한 문제이기 이전에 자원 문제입니다. 방송은 egress 인스턴스를 점유하고(코어 1~4개, 인스턴스 하나가 방 하나),
클래스를 대표해서 외부로 나갑니다. 참가자가 열 수 있으면 한 명이 인스턴스를 통째로 점유해
다른 방송을 전부 막을 수 있습니다.

**화상강의는 참가자도 엽니다.** 스터디 모임을 막을 이유가 없습니다.

---

## 6. 곁다리로 나온 것 — 실패 지점이 원인에서 20줄 떨어져 있었습니다

세션 타입을 고치려고 `create()`를 테스트에서 부르자 `LazyInitializationException`이 났습니다.
`@Transactional`이 없었고 `open-in-view: false`였습니다.

```java
ClassRoom classRoom = classRepository.findById(...)      // 여기서 세션이 닫힙니다
...
boolean isCreator = classRoom.getMember().getId()...     // ← 통과합니다
...
.email(classRoom.getMember().getEmail())                 // ← 20줄 뒤, 여기서 터집니다
```

`ClassRoom.member`는 `LAZY`입니다. 그런데 왜 권한 검사는 통과했을까요.

**Hibernate 프록시는 식별자를 이미 갖고 있어서 `getId()`는 DB를 타지 않습니다.**
초기화가 필요한 첫 필드는 응답을 만들 때 나오는 `email`이었습니다.

### 더 나쁜 것

`meetingRepository.save()`는 `SimpleJpaRepository.save`라 **자기 트랜잭션으로 먼저 커밋됩니다.**

> **DB에는 세션이 생기는데 클라이언트는 500을 받습니다.**
> 아무도 존재를 모르는 세션이 계속 쌓입니다.

컨트롤러가 `catch (Exception e)`로 삼키고 있어서 로그에도 원인이 흐리게 남았습니다.

---

## 결과

테스트 **244 → 274개**.

| 무엇 | |
|---|---|
| 채팅이 세 모드 공통임을 고정 | `@EnumSource`로 새 모드 자동 검증 |
| 오디오 전용을 서버가 강제 | JWT를 열어 검증 |
| HLS 요청 함정 4개 고정 | egress 없이 |
| 우리 서버 CPU 경계 | 소스 확인 후 코드에 상수로 |
| 방송 세션 생성 경로 | **없어서 위 전부가 죽어 있었습니다** |
| 세션 생성 트랜잭션 | 500 + 유령 세션 |

## 아직 못 한 것

**실제로 재생되는지, 지연이 몇 초인지는 재지 않았습니다.** egress 인스턴스를 붙여야 잽니다.
`segment_duration`을 4에서 2로 낮춘 트레이드오프(요청 수 2배, 키프레임이 잦아져 비트레이트 상승)도
같이 재야 합니다.

## 배운 것

**실행할 수 없는 코드도 테스트할 수 있습니다.** 실패가 요청에서 난다면, 요청을 값으로 두면 됩니다.

다만 그게 **실행된 적 있는지**는 별개의 질문이고, 이번엔 그 질문을 늦게 했습니다.
기능을 다 만들고 나서 "그럼 이걸 어떻게 쓰지?"를 물어본 게 아니라,
**만들기 전에 물었어야 했습니다.**

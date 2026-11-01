---
title: '[DE] MQTT: QoS는 한 구간씩, 세션은 끊긴 동안을 맡는다'
description: MQTT는 연결이 자주 끊기는 기기를 위한 가벼운 메시징 프로토콜입니다. QoS 0, 1, 2는 발행자에서 브로커, 브로커에서 구독자 구간마다 따로 적용되고 구독 쪽이 낮으면 낮은 쪽으로 내려갑니다. QoS 2의 정확히 한 번도 한 구간 안의 이야기입니다. MQTT 5.0 명세로 토픽 와일드카드, QoS 흐름, retained 메시지, 세션을 정리하고 Mosquitto 설정과 MQTT에서 Kafka로 넘길 때의 전달 보장을 봅니다.
date: 2026-10-19T00:00:00.000Z
tags:
  - Data Engineering
  - MQTT
  - QoS
  - Mosquitto
  - Kafka Connect
  - Messaging
category: data/Streaming
topics:
  - pipeline
  - messaging
draft: false
series: "DE 공부"
seriesOrder: 11
---

## 결론부터

1. MQTT의 QoS는 보내는 쪽 하나와 받는 쪽 하나 사이, 한 구간에만 적용됩니다. 발행자에서 브로커, 브로커에서 구독자는 따로 계산하고 구독자가 받는 QoS는 발행 QoS와 구독 때 허락된 QoS 중 낮은 쪽입니다.
2. QoS 1은 "적어도 한 번"이라 중복이 생기고 명세는 받는 쪽이 중복을 걸러 주지 않게 정해 두었습니다. QoS 2의 "정확히 한 번"도 한 구간 안의 보장이고 발행자에서 최종 구독자까지 이어진다는 문장은 명세에 없습니다.
3. 끊겨 있는 동안의 메시지는 세션이 맡습니다. MQTT 5는 3.1.1의 Clean Session 하나를 Clean Start와 Session Expiry Interval 둘로 나눴습니다. 재전송도 세션이 남아 있는 채로 다시 붙을 때만 일어납니다.
4. retained 메시지는 토픽마다 마지막 하나만 남고 세션과 상관없이 유지됩니다. 나중에 구독한 쪽이 현재 상태를 바로 받는 용도입니다.
5. MQTT에서 Kafka로 넘기는 브리지 중 정확히 한 번을 문서에 적은 것은 찾지 못했습니다. Confluent 커넥터는 at-least-once, EMQX 문서에는 중복과 순서 바뀜 가능성이 나옵니다. Kafka 쪽에서 멱등하게 받아야 합니다.

---

## 1. 왜 HTTP 말고 MQTT인가

배달 앱을 생각해 봅시다. 라이더 앱 수천 개가 몇 초마다 위치를 보내고 매장 태블릿은 주문을 받아야 합니다. 이 기기들은 지하에 들어가면 끊기고 배터리와 데이터 요금을 아껴야 합니다.

MQTT는 이런 환경을 위해 만들어진 발행·구독(publish/subscribe) 프로토콜입니다. 기기는 브로커에 TCP 연결 하나를 유지하고 메시지를 토픽에 발행하거나 토픽을 구독합니다. 발행자와 구독자는 서로를 모르고 브로커만 압니다.

| | HTTP 요청 | MQTT |
|---|---|---|
| 연결 | 요청마다(또는 keep-alive) | 기기당 하나를 계속 유지 |
| 방향 | 클라이언트가 묻고 서버가 답한다 | 서버가 먼저 보낼 수 있다(구독) |
| 끊겼을 때 | 다시 요청한다 | 세션이 남아 있으면 못 받은 메시지를 이어 받는다 |
| 전달 보장 | 애플리케이션이 정한다 | QoS 0, 1, 2 중 고른다 |

표의 둘째 줄이 체감상 가장 큰 차이입니다. HTTP로 "새 주문 있나요?"를 알려면 매장 태블릿이 몇 초마다 서버에 물어봐야 합니다. 대부분은 "없음"이라는 답을 받으려고 요청을 보내는 셈이라 배터리와 데이터가 샙니다. MQTT에서는 태블릿이 `store/7/order` 토픽을 한 번 구독해 두면 주문이 생길 때 브로커가 열려 있는 연결로 밀어 줍니다.

브로커는 우체국에 가깝습니다. 라이더 앱은 "rider/42/location이라는 주소로 이 위치를 보낸다"만 알고 그걸 누가 받는지 모릅니다. 관제 화면, 손님 앱의 배달 추적 화면, 위치 기록을 쌓는 수집기가 같은 토픽을 구독하고 있으면 브로커가 한 번 받은 메시지를 세 곳에 나눠 줍니다. 받는 쪽이 늘어도 라이더 앱 코드는 바뀌지 않습니다.

## 2. 토픽과 와일드카드

토픽은 `/`로 레벨을 나눈 문자열입니다. 구독할 때는 와일드카드를 쓸 수 있고 발행할 때는 쓸 수 없습니다.

| 필터 | 맞는 토픽 | 맞지 않는 토픽 |
|---|---|---|
| `rider/+/location` | `rider/42/location` | `rider/42/status`, `rider/42/location/raw` |
| `rider/#` | `rider`, `rider/42`, `rider/42/location` | `store/7` |
| `+/+` | `/finance`(빈 레벨도 레벨이다) | `finance` |

- `+`는 정확히 한 레벨을 차지합니다.
- `#`은 필터의 마지막에만 오고 상위 레벨 자신(`rider`)에도 맞습니다.
- `#`이나 `+`로 시작하는 필터는 `$`로 시작하는 토픽에 맞지 않습니다. 그래서 `#`을 구독해도 브로커 상태 토픽 `$SYS/...`는 오지 않습니다. `$SYS`는 명세가 널리 쓰이는 관례라고 비규범 주석으로 적은 것이고 표준은 아닙니다.

표의 셋째 줄이 가장 헷갈립니다. 레벨은 `/`를 기준으로 자른 조각입니다. `/finance`는 맨 앞에 `/`가 있어서 잘라 보면 빈 문자열 하나와 `finance` 하나, 두 레벨이 나옵니다. `+/+`는 "레벨 정확히 두 개"라서 맞습니다. `finance`는 레벨이 하나뿐이라 맞지 않습니다. 같은 이유로 `/rider/42`와 `rider/42`는 다른 토픽입니다. 그래서 실무에서는 토픽을 `/`로 시작하지 말라는 조언이 자주 보입니다.

실제로 쓰는 모습으로 옮기면 이렇습니다. 관제 화면은 모든 라이더의 위치만 필요하니 `rider/+/location`을 구독합니다. 라이더 관련 메시지를 전부 쌓는 수집기는 `rider/#`을 구독합니다. 라이더 42번 앱 하나는 자기 주문만 보면 되니 와일드카드 없이 `rider/42/order`를 구독합니다.

## 3. QoS 0, 1, 2

QoS(Quality of Service)는 "보낸 메시지가 도착했는지 어떻게 확인할까"를 고르는 값입니다. 확인을 안 하면 빠르지만 잃을 수 있습니다. 확인을 하면 잃지는 않지만 확인 응답이 사라졌을 때 같은 메시지를 다시 보내게 됩니다. 0, 1, 2는 이 확인을 몇 단계로 하느냐의 차이입니다.

### 3-1. 흐름

아래 그림의 `id=7`은 packet identifier입니다. 확인 응답이 어느 메시지에 대한 것인지 짝을 맞추는 번호이고 QoS 1, 2에만 붙습니다. 확인이 끝나면 그 번호는 다른 메시지에 다시 쓸 수 있습니다.

```
QoS 0  발행자 ── PUBLISH ──→ 받는 쪽                         (응답 없음, 재시도 없음)

QoS 1  발행자 ── PUBLISH(id=7) ──→ 받는 쪽
              ←──── PUBACK(7) ────                          (못 받으면 다시 보낸다)

QoS 2  발행자 ── PUBLISH(id=7) ──→ 받는 쪽
              ←──── PUBREC(7) ────
              ──── PUBREL(7) ───→
              ←──── PUBCOMP(7) ───                          (네 번 오간다)
```

| QoS | 이름 | 보장 | 명세가 정한 것 |
|---|---|---|---|
| 0 | at most once | 한 번 가거나 안 간다 | packet id가 없고 재시도하지 않는다 |
| 1 | at least once | 한 번 이상 간다 | 재전송하면 DUP 플래그를 1로 둔다. 받는 쪽은 PUBACK을 보낸 뒤 같은 id로 다시 온 PUBLISH를 DUP와 상관없이 새 메시지로 다룬다 |
| 2 | exactly once | 정확히 한 번 간다 | 받는 쪽은 PUBREL을 받기 전까지 같은 id가 다시 와도 PUBREC만 보내고 다음 수신자에게 중복을 넘기지 않는다 |

QoS 1의 마지막 칸이 중요합니다. 프로토콜이 중복을 걸러 주지 않습니다. 같은 "결제 완료" 메시지를 두 번 받을 수 있으니 받는 쪽이 메시지 ID로 걸러야 합니다(4, 7편).

표만 보면 감이 잘 안 옵니다. 확인 응답 하나가 사라지는 장면을 두 QoS로 나란히 따라가 보겠습니다.

![왼쪽은 QoS 1. 라이더 앱이 PUBLISH id 7을 보내고 브로커가 구독자에게 전달한 뒤 PUBACK이 사라진다. 다시 붙어서 DUP 1로 다시 보내면 브로커는 새 메시지로 다뤄 구독자에게 한 번 더 전달한다. 오른쪽은 QoS 2. PUBREC이 사라져 다시 보내도 브로커가 id 7을 기억하고 있어 전달하지 않고 PUBREC만 돌려준다. 이어서 PUBREL과 PUBCOMP로 id를 지운다](/uploads/data/de-10-mqtt-qos-session/qos-ack-lost.svg)

**QoS 1에서 PUBACK이 사라지면**

1. 라이더 앱이 "결제 완료"를 `id=7`로 보냅니다. 브로커는 받자마자 구독자에게 넘깁니다.
2. 브로커가 보낸 `PUBACK 7`이 네트워크에서 사라집니다.
3. 라이더 앱 입장에서는 확인을 못 받았으니 다시 연결해서 같은 메시지를 `DUP=1`로 다시 보냅니다.
4. 브로커는 이미 `PUBACK`을 보낸 뒤라 이 메시지를 새 메시지로 다룹니다. 구독자는 "결제 완료"를 두 번 받습니다.

HiveMQ의 MQTT Essentials 글은 DUP 플래그가 프로토콜 내부용 표시일 뿐이고 받는 쪽은 DUP와 상관없이 PUBACK을 보낸다고 설명합니다. 그래서 중복을 거르려면 payload에 주문 번호 같은 고유 ID를 넣고 받는 쪽이 기억해 둬야 한다고 권합니다([HiveMQ, MQTT Essentials Part 6](https://www.hivemq.com/blog/mqtt-essentials-part-6-mqtt-quality-of-service-levels/)).

**QoS 2는 왜 네 번이나 오가나**

QoS 2에서는 받는 쪽이 "id 7은 이미 받았다"를 기억해 둡니다. 그러면 같은 id가 다시 와도 넘기지 않을 수 있습니다. 그럼 이 기억은 언제 잊어도 될까요?

- `PUBREC 7`만 보내고 바로 잊으면 안 됩니다. `PUBREC`이 사라지면 보내는 쪽이 다시 보낼 텐데 그때 id를 잊었으면 새 메시지로 착각합니다.
- 그래서 보내는 쪽이 "이제 다시 안 보낸다"를 알려 줘야 합니다. 그게 `PUBREL`(release)입니다. 받는 쪽은 `PUBREL`을 받고 나서야 id 7을 지우고 `PUBCOMP`로 "지웠다"고 답합니다.
- 보내는 쪽은 `PUBCOMP`를 받은 뒤에 id 7을 다른 메시지에 다시 씁니다.

정리하면 앞의 두 번(`PUBLISH`, `PUBREC`)은 "메시지가 건너갔다"를 확인하고 뒤의 두 번(`PUBREL`, `PUBCOMP`)은 "id를 잊어도 된다"를 확인합니다. 이 기억 덕분에 중복이 없는 대신 왕복이 두 배이고 양쪽이 id를 들고 있는 시간이 깁니다. HiveMQ 글이 QoS 1을 가장 흔히 쓰는 수준으로 꼽는 것도 이 비용 때문입니다.

### 3-2. QoS는 구간마다 따로, 낮은 쪽으로

명세 4.3절은 전달 프로토콜이 보내는 쪽 하나와 받는 쪽 하나 사이의 전달만 다룬다고 적습니다. 브로커가 구독자에게 보내는 QoS는 발행자에게서 받은 QoS와 다를 수 있습니다.

```
라이더 앱 ──QoS 2──→ 브로커 ──QoS ?──→ 관제 화면
                                 └ min(발행 QoS 2, 구독 때 허락된 QoS)
```

"구독 때 허락된 QoS"는 구독자가 정합니다. 구독자는 `SUBSCRIBE` 패킷에 "이 토픽은 최대 QoS 1까지 받겠다"처럼 원하는 수준을 적어 보내고 브로커는 `SUBACK`으로 실제로 허락한 값을 돌려줍니다. 브로커는 그 뒤로 이 구독자에게 이 값을 넘는 QoS로 보내지 않습니다.

관제 화면이 QoS 0으로 구독했다면 라이더 앱이 QoS 2로 보내도 관제 화면은 QoS 0으로 받습니다. 이 구간에서는 유실될 수 있습니다. QoS 2의 "정확히 한 번"은 발행자와 브로커 사이 한 구간의 이야기이고 끝에서 끝까지의 보장으로 읽으면 안 됩니다. QoS 1로 구독했다면 앞 절의 PUBACK 분실이 브로커와 관제 화면 사이에서 그대로 일어나니 발행자가 QoS 2로 보냈어도 관제 화면은 같은 메시지를 두 번 받을 수 있습니다.

### 3-3. 순서

브로커는 기본적으로 한 클라이언트가 보낸 메시지를 같은 토픽, 같은 QoS 안에서 받은 순서대로 전달해야 합니다. 다만 명세의 비규범 주석은 재전송된 중복본이 그보다 뒤에 보낸 메시지 다음에 도착할 수 있다고 적습니다. 명세의 예는 1, 2, 3, 4를 보냈는데 3을 보낸 직후 연결이 끊겨 구독자가 1, 2, 3, 2, 3, 4로 받는 경우입니다. 각 메시지의 마지막 사본은 보낸 순서를 지킵니다.

어떻게 이런 순서가 나오는지 따라가 보면 3-1절의 장면과 같습니다. `A`와 `B`를 보냈고 브로커는 둘 다 받아서 넘겼는데 두 PUBACK이 돌아오기 전에 연결이 끊깁니다. 발행자가 다시 연결해서 확인 못 받은 `A`, `B`를 원래 순서대로 다시 보내면 구독자에게는 `A, B, A, B`가 도착합니다. 받는 쪽이 주문 상태를 "마지막에 온 값"으로 덮어쓰고 있었다면 세 번째 메시지가 도착한 순간 `B`(배달 출발)가 `A`(결제 완료)로 되돌아가고 마지막 `B`가 올 때까지 틀린 상태가 보입니다. 재전송 전에 다시 끊기면 그 상태로 오래 남을 수도 있습니다. 상태를 덮어쓸 때는 메시지 안에 순번이나 시각을 넣고 더 오래된 값이면 버리는 처리가 필요합니다.

## 4. 세션: 끊긴 동안을 맡는 것

### 4-1. MQTT 5의 Clean Start와 Session Expiry

세션은 브로커가 클라이언트별로 기억하는 상태입니다. 구독 목록, 확인이 안 끝난 QoS 1, 2 메시지, 아직 보내지 못한 QoS 1, 2 메시지가 들어갑니다.

| 설정 | 뜻 |
|---|---|
| Clean Start = 1 | 기존 세션을 버리고 새로 시작한다 |
| Clean Start = 0 | 남아 있는 세션이 있으면 이어서 쓴다 |
| Session Expiry Interval | 연결이 끊긴 뒤 세션을 몇 초 남길지. 0이면 끊기자마자 버린다(기본값), 0xFFFFFFFF면 버리지 않는다 |

MQTT 3.1.1에는 Clean Session 플래그 하나만 있었습니다. 1이면 연결이 살아 있는 동안만 세션이 있고 0이면 세션을 계속 남기되 만료 개념이 없었습니다. MQTT 5는 이걸 둘로 나눴고 "Clean Start 1 + Session Expiry 0"이 3.1.1의 Clean Session 1과 같습니다.

반대쪽인 Clean Session 0에 해당하는 값은 "Clean Start 0 + Session Expiry 0xFFFFFFFF"입니다. MQTT 5 명세의 비규범 주석은 Session Expiry를 아예 안 적은 경우를 Clean Session 0과 같다고 적었는데 같은 명세가 "값이 없으면 0으로 본다"고 정해 두어서 실제로는 끊기자마자 세션이 사라집니다. 이 어긋남은 OASIS 이슈 [MQTT-538](https://issues.oasis-open.org/browse/MQTT-538)로 올라가 있고 아직 해결 표시가 없습니다. 3.1.1 코드를 MQTT 5로 옮기면서 Clean Start 0만 주고 Session Expiry를 빼먹으면 세션이 남지 않습니다. 9절의 `mosquitto_sub`은 `-c`만 줘도 만료 시간을 무한(-1)으로 채워 주지만 클라이언트 라이브러리마다 기본값이 다르니 직접 적는 편이 안전합니다.

손님 앱 하나로 조합을 바꿔 보면 차이가 보입니다. 앱이 `order/1001`을 QoS 1로 구독하고 있다가 10분 동안 꺼졌고 그 사이 "배달 출발" 메시지가 발행됐다고 하겠습니다.

| Clean Start | Session Expiry | 10분 뒤 다시 켜면 |
|---|---|---|
| 1 | 0 | 세션이 매번 새로 시작합니다. "배달 출발"을 받지 못하고 구독도 다시 해야 합니다 |
| 0 | 3600(1시간) | 남아 있던 세션을 이어 씁니다. 구독이 살아 있고 쌓여 있던 "배달 출발"을 받습니다 |
| 0 | 300(5분) | 끊긴 지 5분 만에 세션이 사라졌습니다. 이어 쓸 세션이 없어 첫째 줄과 같습니다 |
| 1 | 3600 | 이번 연결은 새로 시작합니다. 대신 다음에 끊기면 1시간 동안 세션이 남습니다 |

브로커는 연결 응답(`CONNACK`)의 Session Present 플래그로 이전 세션을 찾았는지 알려 줍니다. EMQX의 세션 설명 글은 이 플래그를 보고 다시 구독할지 정하라고 권하고 client ID를 고정해야 한다고 강조합니다. 연결할 때마다 ID가 바뀌면 브로커는 매번 다른 클라이언트로 보고 새 세션을 만듭니다([EMQX, MQTT Persistent Session and Clean Session Explained](https://www.emqx.com/en/blog/mqtt-session)).

### 4-2. 재전송은 다시 붙을 때만

MQTT 5 명세는 확인받지 못한 메시지를 다시 보내는 경우를 하나로 정합니다. Clean Start 0으로 다시 연결했고 세션이 남아 있을 때입니다. 그 밖의 경우에는 다시 보내면 안 됩니다. 같은 연결 안에서 응답이 늦다고 다시 보내지 않고 연결이 끊긴 것으로 판단되면 다시 붙어서 보냅니다.

왜 같은 연결 안에서는 다시 보내지 않을까요. MQTT는 TCP 위에서 돕니다. 연결이 살아 있는 동안 패킷 유실과 재전송은 TCP가 이미 처리하니 MQTT가 한 번 더 보내 봐야 중복만 늘어납니다. MQTT가 다시 보내야 하는 경우는 TCP 연결 자체가 끊겨서 그 안에 있던 것들이 어디까지 갔는지 모르게 됐을 때입니다. 명세의 규칙은 이렇게 읽으면 자연스럽습니다.

연결이 끊겼는지는 Keep Alive로 판단합니다. 브로커는 Keep Alive의 1.5배 동안 클라이언트에게서 아무 패킷도 받지 못하면 연결을 닫습니다. Keep Alive를 60초로 두었다면 90초 동안 조용한 클라이언트를 끊긴 것으로 봅니다. 보낼 메시지가 없는 클라이언트는 그 사이에 `PINGREQ`를 보내 살아 있음을 알리고 브로커는 `PINGRESP`로 답합니다([EMQX, MQTT Keep Alive](https://www.emqx.com/en/blog/mqtt-keep-alive)). 지하 주차장에 들어간 라이더 앱처럼 TCP가 끊긴 줄도 모르고 조용해진 경우를 이 타이머가 잡아냅니다.

### 4-3. 브로커가 재시작하면

명세는 세션을 디스크에 저장하라고 요구하지 않습니다. 장애로 세션 상태가 사라질 수 있다고 주석에 적어 두었습니다. 재시작 뒤에도 QoS 1, 2 보장이 이어지는지는 브로커 구현과 설정에 달렸습니다.

## 5. retained 메시지와 Will

### 5-1. retained: 지금 상태를 바로 받기

RETAIN 플래그를 켜고 발행하면 브로커가 그 토픽의 마지막 메시지로 기억합니다. 새로 구독한 클라이언트는 다음 발행을 기다리지 않고 기억된 메시지를 바로 받습니다.

- 토픽마다 하나만 남습니다. 새 retained 메시지가 오면 이전 것을 교체합니다.
- payload가 0바이트인 retained 메시지를 보내면 기억된 것을 지웁니다.
- retained 메시지는 세션 상태에 들어가지 않아서 세션이 끝나도 지워지지 않습니다.

매장 영업 상태(`store/7/status`)처럼 "지금 값"이 중요한 토픽에 씁니다. 앱을 새로 켠 손님 화면이 다음 상태 변화까지 기다리지 않아도 됩니다.

### 5-2. Will: 갑자기 끊기면 대신 알리기

연결할 때 Will 메시지를 등록해 두면 클라이언트가 정상 종료 없이 끊겼을 때 브로커가 대신 발행합니다. 라이더 앱이 `rider/42/status`에 "offline"을 Will로 걸어 두는 식입니다. MQTT 5의 Will Delay Interval을 주면 그 시간 안에 같은 세션으로 다시 붙을 경우 Will을 보내지 않습니다. 명세는 잠깐 끊겼다 바로 붙는 경우를 위한 기능이라고 설명합니다.

## 6. 흐름 제어와 공유 구독(MQTT 5)

| 기능 | 내용 |
|---|---|
| Receive Maximum | 확인을 기다리는 QoS 1, 2 메시지를 동시에 몇 개까지 받을지. 기본 65,535. QoS 0은 제한할 방법이 없다 |
| Shared Subscription | `$share/{그룹}/{필터}`로 구독하면 맞는 메시지가 그룹 안의 구독자 하나에게만 간다. 여러 소비자가 일을 나눠 가질 때 쓴다. 3-3절의 순서 규정은 공유 구독에는 적용되지 않는다 |

Receive Maximum은 받는 쪽이 정하는 "한 번에 들고 있을 수 있는 미확인 메시지 수"입니다. 저사양 매장 태블릿이 10으로 적어 보내면 브로커는 확인이 안 끝난 QoS 1, 2 메시지가 10개에 닿는 순간 11번째를 보내지 않고 앞의 확인을 기다립니다. 처리 속도보다 빨리 밀려와서 기기 메모리가 넘치는 일을 막는 장치입니다.

공유 구독은 Kafka의 컨슈머 그룹(12편)과 비슷해 보이지만 순서를 보장하는 단위가 없다는 점이 다릅니다. 주문 알림을 보내는 워커 세 대가 `$share/notify/order/#`로 구독하면 주문 하나는 셋 중 한 대에만 가서 일이 나뉩니다. 대신 같은 주문의 "결제 완료"와 "배달 출발"이 서로 다른 워커로 갈 수 있어서 처리 순서는 장담할 수 없습니다. Kafka는 같은 키를 같은 파티션에 모아 이 문제를 풉니다.

## 7. Mosquitto 설정에서 볼 것

Eclipse Mosquitto는 가볍고 널리 쓰이는 오픈소스 브로커입니다. `mosquitto.conf` 문서에서 전달 보장과 관련된 값입니다.

| 설정 | 기본값 | 뜻 |
|---|---|---|
| `persistence` + `autosave_interval` | 1800초 | 세션과 메시지를 디스크에 쓰는 주기. 0이면 종료할 때나 SIGUSR1을 받을 때만 쓴다 |
| `max_inflight_messages` | 20 | 클라이언트별로 확인을 기다리는 QoS 1, 2 메시지 수. 1로 두면 순서가 보장된다고 문서가 적는다 |
| `max_queued_messages` | 1000 | 클라이언트별로 큐에 쌓아 두는 QoS 1, 2 메시지 수 |
| `max_queued_bytes` | 0(무제한) | 한도에 닿으면 그 뒤 메시지는 조용히 버려진다 |
| `queue_qos0_messages` | false | 끊긴 세션에 QoS 0도 쌓을지. 문서가 비표준 동작이라고 적는다 |

`autosave_interval`이 1800초이니 브로커가 갑자기 죽으면 최대 30분치 세션 상태를 잃을 수 있습니다. 4-3절의 "재시작 뒤 보장은 설정에 달렸다"가 여기서 숫자가 됩니다. `max_queued_messages`를 넘은 메시지는 버려지므로 오래 끊겨 있던 클라이언트는 세션이 남아 있어도 메시지를 다 받지 못할 수도 있습니다.

Mosquitto가 단일 스레드라는 설명이 자주 보입니다. 1차 근거로 찾은 것은 개발자가 2014년 메일링 리스트에 쓴 "브로커는 전부 단일 스레드"라는 답과 벤더 비교 글뿐이고 현재 2.x의 구조는 공식 문서로 확인하지 못했습니다.

## 8. MQTT에서 Kafka로

기기 메시지를 분석하려면 Kafka 같은 로그로 옮겨야 하는 경우가 많습니다. 브리지 문서에서 전달 보장을 찾아봤습니다.

| 브리지 | 문서에서 확인한 것 |
|---|---|
| Confluent MQTT Source Connector(상용) | at-least-once. 이를 위해 `mqtt.clean.session.enabled=false`로 persistent 세션을 써야 한다. task 수나 토픽 목록을 바꾸면 client ID가 바뀌어 데이터를 잃을 수 있다고 경고한다. Kafka 레코드 키는 MQTT 토픽 |
| Lenses stream-reactor(Apache 2.0) | `INSERT INTO kafka_topic SELECT * FROM mqtt_topic` 형태의 설정. `connect.mqtt.clean` 기본 true. 전달 보장 설명은 없다 |
| EMQX Kafka 통합 | 메모리 버퍼는 노드 재시작 때 잃는다. 요청 시간 초과 뒤 다시 연결해 배치를 다시 보내 중복이 생길 수 있다. max inflight가 1보다 크면 순서가 바뀔 수 있다 |
| HiveMQ Kafka Extension(상용) | 키 기반 파티셔닝이면 MQTT 토픽 단위 순서가 Kafka 파티션까지 유지된다. 전달 보장 수준은 문서에 없다 |

정확히 한 번을 적은 브리지는 없었습니다. 3절에서 본 QoS의 구간별 보장에 브리지 구간이 하나 더 붙는 셈이라 Kafka 뒤의 처리는 같은 메시지가 두 번 올 수 있다고 보고 메시지 ID로 걸러야 합니다.

브리지가 왜 정확히 한 번을 약속하기 어려운지는 일의 순서를 따라가면 보입니다. 브리지는 MQTT 브로커 입장에서 구독자 하나이고 Kafka 입장에서 프로듀서 하나입니다. 주문 메시지 하나를 옮길 때 할 일은 두 가지입니다.

1. Kafka에 쓴다.
2. MQTT 브로커에 확인(PUBACK)을 보낸다.

1을 먼저 하면 1과 2 사이에 브리지가 죽었을 때 브로커는 확인을 못 받았으니 다시 연결한 브리지에 같은 주문을 또 보냅니다. Kafka에는 두 번 쓰입니다(at-least-once). 2를 먼저 하면 2와 1 사이에 죽었을 때 브로커는 이미 확인을 받았으니 다시 보내지 않고 Kafka에는 한 번도 안 쓰입니다(유실). 두 시스템에 걸친 일을 한 번에 묶을 방법이 없으니 잃지 않는 쪽을 고르고 중복은 뒤에서 거르는 구성이 됩니다. Confluent 커넥터가 at-least-once를 적은 것도 이 선택입니다.

## 9. 직접 돌려 볼 실습

Docker로 Mosquitto를 띄우고 `mosquitto_pub`, `mosquitto_sub`로 와일드카드, retained, 세션, QoS 낮추기를 확인하는 명령을 [labs/de-study/ch10](https://github.com/dj258255/IT-Oasis/tree/main/labs/de-study/ch10)에 정리했습니다. 세션 실험 하나만 옮기면 이렇습니다.

```bash
# MQTT 5, Clean Start 0, 세션 만료 1시간, QoS 1로 구독하고 1초 뒤 끊는다
mosquitto_sub -V mqttv5 -c -x 3600 -i app-1 -q 1 -t 'order/#' -v -W 1
mosquitto_pub -q 1 -t order/1001 -m 'paid'      # app-1이 끊겨 있는 동안 발행
mosquitto_sub -V mqttv5 -c -x 3600 -i app-1 -q 1 -t 'order/#' -v -W 2
# 다시 붙으면 끊긴 동안의 paid를 받는다. -c를 빼면(Clean Start 1) 받지 못한다
```

옵션이 많아 한 줄씩 풀면 이렇습니다.

| 옵션 | 뜻 | 이 실험에서 하는 일 |
|---|---|---|
| `-V mqttv5` | MQTT 5로 연결 | Clean Start와 Session Expiry를 쓰기 위해 |
| `-c` | Clean Start 0(세션 이어 쓰기) | 끊긴 뒤에도 세션을 남기라고 요청 |
| `-x 3600` | Session Expiry Interval 3600초 | `-c`만 주면 `mosquitto_sub`은 만료 없음으로 채우지만 4-1절의 함정을 의식해 만료 시간을 직접 적음 |
| `-i app-1` | client ID | 세션을 찾는 열쇠. 두 번째 실행도 같은 ID여야 같은 세션을 찾음 |
| `-q 1` | 구독 QoS 1 | Mosquitto 기본 설정에서 QoS 0 메시지는 끊긴 세션에 쌓이지 않아서 |
| `-t 'order/#'` | 구독할 토픽 필터 | `order/1001`에 맞음 |
| `-v` | 받은 메시지 앞에 토픽 이름도 출력 | 어느 토픽에서 왔는지 보이게 |
| `-W 1` | 1초 뒤 스스로 종료 | "앱이 꺼진 상태"를 만듦 |

첫 줄이 세션을 만들고 끊깁니다. 둘째 줄의 발행은 app-1이 꺼져 있는 동안 일어나니 브로커가 app-1의 세션에 `paid`를 쌓아 둡니다. 셋째 줄이 같은 ID로 다시 붙으면 쌓인 `paid`가 바로 출력됩니다. 셋째 줄에서 `-c`를 빼면 Clean Start 1이라 브로커가 쌓아 둔 세션을 버리고 아무것도 출력되지 않아야 합니다.
이 실습은 아직 직접 돌려 결과를 기록하지 않았습니다.

## 10. 중국 사례: EMQX의 클러스터 구조

중국 EMQ가 만든 EMQX는 대규모 MQTT 브로커로 많이 쓰입니다. 벤더가 자기 제품을 설명한 2022년 글 "Mria + RLOG 新架构下的 EMQX 5.0 如何实现 1 亿 MQTT 连接"에 따르면 4.x는 모든 노드가 서로 연결되는 구조(Mnesia)라 노드를 3~7개로 권했고 노드가 늘면 네트워크가 갈라질 때 두 쪽이 따로 움직이는(split-brain) 위험이 커졌습니다. 5.0은 상태를 가진 Core 노드와 상태가 없고 쓰기를 하지 않는 Replicant 노드로 나눠 "Core 3개 + Replicant N개"를 권합니다. 7절의 Mosquitto는 단일 브로커 프로세스였고 연결이 많아지면 이렇게 브로커 자체를 여러 노드로 나누는 구조가 필요합니다. 국내 MQTT 운영 사례는 찾지 못했습니다.

## 11. 범위와 한계

- 이 글은 MQTT 5.0, 3.1.1 명세와 Mosquitto 문서를 근거로 썼습니다. 브로커마다 명세 밖의 동작(예: `queue_qos0_messages`)이 있습니다.
- 성능 수치는 넣지 않았습니다. 찾은 벤치마크(EMQX 1억 연결, HiveMQ 2억 연결)는 모두 벤더가 자기 제품으로 잰 것이고 Mosquitto 처리량을 비교한 표는 테스트 조건이 적혀 있지 않았습니다.
- Confluent 커넥터의 설정 기본값과 EMQX Kafka 통합을 오픈소스판에서 쓸 수 있는지는 확인하지 못했습니다.

## 12. 헷갈렸던 것

**Q. 그럼 다 QoS 2로 보내면 안전하지 않나요?**

QoS 2는 메시지 하나에 네 번 오가서 QoS 0보다 왕복이 많고 브로커와 클라이언트가 상태를 더 오래 들고 있어야 합니다. 그리고 구독 쪽이 낮으면 거기서 내려가고 브로커가 재시작하면 설정에 따라 상태를 잃습니다. 위치처럼 몇 초 뒤 새 값이 오는 데이터는 QoS 0으로 충분하고 주문처럼 하나도 잃으면 안 되는 데이터는 QoS 1에 받는 쪽 중복 제거를 붙이는 구성이 흔합니다.

**Q. retained 메시지와 persistent 세션은 무엇이 다른가요?**

retained는 토픽에 붙은 마지막 값 하나이고 누가 구독하든 받습니다. persistent 세션은 클라이언트 하나에 붙은 상태이고 그 클라이언트가 끊겨 있던 동안 놓친 메시지를 쌓아 둡니다. "지금 매장이 열려 있나"는 retained, "끊긴 동안 들어온 주문 전부"는 세션으로 받습니다.

**Q. 끊겼다 다시 붙을 때 client ID가 바뀌면요?**

세션은 client ID로 찾습니다. ID가 바뀌면 브로커에게는 다른 클라이언트라 이전 세션의 메시지를 받지 못합니다. 8절의 Confluent 커넥터 경고가 이 경우입니다.

## 참고 자료

명세와 공식 문서
- OASIS, [MQTT Version 5.0](https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html)
- OASIS, [MQTT Version 3.1.1](http://docs.oasis-open.org/mqtt/mqtt/v3.1.1/os/mqtt-v3.1.1-os.html)
- OASIS, [MQTT-538: Clarify SessionExpiry value for MQTT 5.0 equivalence of CleanSession to 0](https://issues.oasis-open.org/browse/MQTT-538)
- Eclipse Mosquitto, [mosquitto.conf man page](https://mosquitto.org/man/mosquitto-conf-5.html)
- Confluent, [MQTT Source Connector](https://docs.confluent.io/kafka-connectors/mqtt/current/mqtt-source-connector/overview.html)
- Lenses, [MQTT source connector](https://docs.lenses.io/latest/connectors/kafka-connectors/sources/mqtt)
- EMQX, [Stream MQTT Data into Apache Kafka](https://docs.emqx.com/en/emqx/latest/data-integration/data-bridge-kafka.html)
- HiveMQ, [Enterprise Extension for Kafka](https://docs.hivemq.com/hivemq-kafka-extension/latest/)

개념 설명 글
- HiveMQ, [What is MQTT Quality of Service (QoS) 0, 1, & 2? MQTT Essentials Part 6](https://www.hivemq.com/blog/mqtt-essentials-part-6-mqtt-quality-of-service-levels/)
- EMQX, [MQTT Persistent Session and Clean Session Explained](https://www.emqx.com/en/blog/mqtt-session)
- EMQX, [What is the MQTT Keep Alive parameter for?](https://www.emqx.com/en/blog/mqtt-keep-alive)

그 밖
- mosquitto-dev 메일링 리스트, [2014-12 스레딩 관련 답변](https://www.eclipse.org/lists/mosquitto-dev/msg00343.html)
- 실습: [labs/de-study/ch10](https://github.com/dj258255/IT-Oasis/tree/main/labs/de-study/ch10)

중국과 국내 빅테크 사례
- EMQX Team, [Mria + RLOG 新架构下的 EMQX 5.0 如何实现 1 亿 MQTT 连接](https://www.emqx.com/zh/blog/how-emqx-5-0-achieves-100-million-mqtt-connections), 2022(벤더 글)

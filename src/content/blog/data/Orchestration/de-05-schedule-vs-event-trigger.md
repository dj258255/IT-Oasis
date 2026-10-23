---
title: '[DE Ch-05] 스케줄 트리거와 이벤트 트리거: 시각을 기다릴지, 데이터를 기다릴지'
description: 데이터가 언제 도착할지 모르면 cron은 너무 이르거나 너무 늦습니다. 센서로 폴링하면 확인 비용과 발견 지연이 생기고 이벤트로 받으면 중복과 유실을 따로 다뤄야 합니다. Airflow 3의 Asset과 AssetWatcher, Argo Events가 이벤트를 어떻게 합치고 거르는지 공식 문서로 정리하고 폴링 비용을 시뮬레이션으로 셉니다.
date: 2026-10-19T00:00:00.000Z
tags:
  - Data Engineering
  - Workflow Orchestration
  - Airflow
  - Asset
  - AssetWatcher
  - Argo Events
  - Event-Driven
category: data/Orchestration
topics:
  - pipeline
  - messaging
draft: false
series: "DE 공부"
seriesOrder: 5
---

## 결론부터

1. 작업을 시작시키는 방법은 셋입니다. 정해진 시각에 시작하는 스케줄, 조건이 될 때까지 주기적으로 확인하는 센서(폴링), 외부에서 온 신호로 시작하는 이벤트 트리거입니다.
2. 폴링은 확인 주기만큼 발견이 늦고 확인할 때마다 비용이 듭니다. Airflow의 기본 센서(poke 모드)는 기다리는 내내 워커 슬롯을 잡고 있어서 Airbnb에서는 실행 중인 태스크의 70% 이상이 센서였습니다.
3. Airflow의 Asset 스케줄링은 이벤트를 합칩니다. 소비 DAG가 돌기 전에 같은 asset이 여러 번 갱신돼도 실행은 한 번입니다. 이벤트 N건이 실행 N번이 되지 않는다는 점을 알고 써야 합니다.
4. 이벤트 전달은 보통 at-least-once라 같은 이벤트가 두 번 올 수 있습니다. Argo Events의 Sensor는 최근 5분 동안 받은 이벤트 ID만 메모리에 기억해 거릅니다. 그보다 오래된 중복은 받는 쪽이 멱등하게 처리해야 합니다(Ch-03, Ch-06).

---

## 1. 데이터가 언제 올지 모를 때

매일 새벽 주문 파일이 외부에서 들어오는데 도착 시각이 01시에서 05시 사이로 들쭉날쭉하다고 해 봅시다. Ch-02의 일일 매출 DAG를 cron으로 걸면 고를 수 있는 시각이 애매합니다.

| cron 시각 | 생기는 일 |
|---|---|
| 01:00 | 파일이 아직 없는 날이 많다. 빈 입력으로 돌거나 실패한다 |
| 05:30 | 거의 항상 파일이 있다. 대신 01시에 도착한 날도 4시간 반을 기다린다 |

시각을 기다리는 대신 데이터를 기다리는 방법이 두 가지 있습니다. 주기적으로 "왔는지" 확인하는 폴링과, 데이터가 왔다는 신호를 받는 이벤트입니다.

택배로 치면 폴링은 현관문을 5분마다 열어 보는 것이고 이벤트는 초인종이 울리면 나가는 것입니다. 문을 자주 열수록 빨리 알지만 그만큼 수고가 듭니다. 초인종은 수고가 없지만 고장 나면 택배가 왔는지조차 모릅니다. 이 글의 나머지는 이 두 가지 대가를 숫자와 도구로 따져 보는 내용입니다.

## 2. 폴링: Airflow 센서의 세 가지 모드

### 2-1. poke, reschedule, deferrable

Airflow에서 폴링은 센서로 합니다. 센서는 "조건이 참이 될 때까지 기다렸다가 성공하는 태스크"입니다. 예를 들어 `S3KeySensor`는 지정한 경로에 파일이 생길 때까지 기다립니다.

센서의 비용을 이해하려면 워커 슬롯부터 알아야 합니다. 워커 하나가 동시에 돌릴 수 있는 태스크 수는 설정으로 정해져 있고 그 한 칸을 슬롯이라고 부릅니다. 슬롯이 16개인 워커에서 센서 16개가 기다리고 있으면 진짜 일을 하는 태스크는 들어갈 자리가 없습니다. 같은 센서라도 기다리는 방식이 셋이고 차이는 이 슬롯을 언제 쥐고 언제 놓느냐입니다.

| 모드 | 기다리는 동안 | 맞는 경우 |
|---|---|---|
| poke(기본값) | 워커 슬롯을 계속 잡고 있다 | 초 단위로 확인할 때 |
| reschedule | 확인할 때만 슬롯을 쓰고 나머지 시간은 슬롯을 놓는다 | 분 단위로 확인할 때 |
| deferrable | trigger를 등록하고 워커를 놓는다. triggerer가 비동기로 기다리다 조건이 되면 태스크를 다시 큐에 넣는다 | 오래 기다릴 때. 확인 조건이 시간이 아니어도 된다 |

![같은 날 세 모드가 워커 슬롯을 쓰는 모양. 파일이 03:00에 도착할 때 poke는 00:00부터 03:00까지 약 3시간 동안 슬롯을 쥐고 있고 reschedule은 5분마다 1초씩 37번만 슬롯을 쓰며 deferrable은 처음 등록과 마지막 재개 때만 워커를 쓰고 그사이는 triggerer가 기다린다](/uploads/data/de-05-schedule-vs-event-trigger/sensor-modes.svg)

reschedule이 늘 이기는 것은 아닙니다. 확인할 때마다 태스크를 다시 스케줄해야 해서 스케줄러 일이 늘어납니다. Astronomer 가이드는 확인 주기가 5분보다 짧으면 poke를 쓰라고 권하고 그보다 짧은 주기에 reschedule을 쓰면 스케줄러에 부담이 갈 수 있다고 적습니다. 센서의 기본 timeout이 7일이라 기다릴 시간에 맞게 줄여 두라는 조언도 같은 글에 있습니다([Astronomer, Airflow sensors](https://www.astronomer.io/docs/learn/what-is-a-sensor)).

Airflow 문서는 일반 오퍼레이터와 센서가 "아무것도 안 하는 동안에도 실행 시간 내내 워커 슬롯 하나를 통째로 차지한다"고 적습니다. triggerer는 asyncio 이벤트 루프 하나로 수백에서 수만 개 trigger를 기다릴 수 있고 기다리는 태스크는 기본적으로 pool 슬롯도 차지하지 않습니다. 대신 triggerer를 하나 더 띄울 때마다 DB 연결이 하나 더 상주합니다.

### 2-2. 폴링 비용이 쌓인 사례: Airbnb Smart Sensor

Airbnb는 Airflow 2.0을 앞두고 AIP-17(Smart Sensor)을 제안했습니다. 제안서에 적힌 당시 상황은 이렇습니다.

- 실행 중인 태스크의 70% 이상이 센서였습니다.
- 센서 잡의 40% 이상은 같은 조건을 확인하는 중복이었습니다.
- 센서는 3분마다 확인했습니다.

여러 센서의 확인을 한곳에 모아 중복을 없앤 뒤 센서용 프로세스가 2만 개 이상에서 50~80개로, 센서가 쓰던 워커 슬롯이 85% 줄었다고 보고했습니다. 이후 Airflow는 같은 문제를 deferrable 오퍼레이터와 triggerer로 풀었습니다.

### 2-3. 재현: 5분 폴링의 확인 횟수와 발견 지연

1절의 상황을 시뮬레이션했습니다.

- 30일 동안 매일 01:00~05:00 사이 무작위 시각에 파일이 도착합니다(시드 고정).
- 센서는 00:00부터 5분마다 확인하고 확인 한 번은 1초가 걸린다고 칩니다.
- 코드는 [labs/de-study/ch05](https://github.com/dj258255/IT-Oasis/tree/main/labs/de-study/ch05)의 `polling_vs_event.py`입니다.

| 지표 | 결과 |
|---|---|
| 하루 평균 확인 횟수 | 35.2회(poke, reschedule 같음) |
| 발견 지연 | 평균 2.6분, 최대 4.9분 |
| 워커 슬롯 점유(하루 평균) | poke 2.8시간, reschedule 35초 |

표의 숫자는 손으로도 대략 맞춰 볼 수 있습니다.

- 발견 지연: 파일은 확인과 확인 사이 아무 때나 도착합니다. 5분 간격 안에서 고르게 도착한다면 다음 확인까지 평균 절반인 2.5분을 기다리고 아무리 늦어도 5분을 넘지 않습니다. 결과의 평균 2.6분, 최대 4.9분이 이 계산과 맞습니다.
- 확인 횟수: 00:00부터 5분마다 확인하니 파일을 발견하기까지의 확인 횟수는 발견 시각(분) ÷ 5 + 1입니다. 평균 35.2회를 거꾸로 풀면 이 30일 표본의 평균 발견 시각은 약 2시 51분입니다.
- 슬롯 점유: poke는 00:00부터 발견할 때까지 슬롯을 쥐고 있으니 평균 약 171분, 곧 2.8시간입니다. reschedule은 확인 한 번에 1초씩만 쓰니 35.2회 × 1초 ≈ 35초입니다.

확인 주기 5분은 발견 지연의 상한을 5분으로 만듭니다. 주기를 1분으로 줄이면 지연은 줄지만 확인 횟수가 다섯 배가 됩니다. poke 모드는 파일이 늦게 오는 날일수록 슬롯을 오래 잡습니다. 이 DAG가 하나면 하루 2.8시간이 별것 아니지만 Airbnb처럼 센서가 태스크의 대부분이 되면 워커 전체가 기다리는 데 쓰입니다.

## 3. Airflow Asset: 데이터 갱신으로 DAG를 시작한다

### 3-1. 생산자와 소비자

Airflow 2.4에서 Dataset으로 들어왔고 3.0에서 Asset으로 이름이 바뀌었습니다(`airflow.sdk.Asset`). 생산자 태스크가 `outlets`로 asset을 선언하고 소비자 DAG는 `schedule`에 asset을 겁니다.

```python
from airflow.sdk import Asset, dag, task

orders = Asset("s3://shop/orders/")

@dag(schedule="@daily")
def load_orders():
    @task(outlets=[orders])          # 이 태스크가 성공하면 orders가 갱신된 것으로 기록된다
    def load():
        ...
    load()

@dag(schedule=[orders])              # orders가 갱신되면 돈다
def daily_sales():
    ...
```

### 3-2. 이벤트가 생기는 시점과 합쳐지는 방식

공식 문서에서 확인한 동작은 셋입니다.

- asset 이벤트는 생산자 태스크가 성공했을 때만 생깁니다. 실패하거나 skip되면 생기지 않습니다.
- 여러 asset은 `&`(모두 갱신)와 `|`(하나라도 갱신)로 묶을 수 있습니다. 괄호로 `a | (b & c)`처럼 조합합니다.
- 소비자 DAG는 마지막 실행 이후 소비하는 asset이 모두 한 번 이상 갱신돼야 돕니다. 문서는 "다른 asset이 갱신되기 전에 한 asset이 여러 번 갱신돼도 소비자 DAG는 한 번만 돈다"고 적습니다.

세 번째가 이 글에서 가장 헷갈리기 쉬운 대목이라 시간 순서로 풀어 보겠습니다. 소비자 DAG가 `schedule=(orders & products)`로 두 asset을 모두 기다린다고 합시다.

| 시각 | 일어난 일 | 소비자 DAG |
|---|---|---|
| 09:00 | `orders` 갱신(이벤트 1) | `products`가 아직이라 기다린다 |
| 10:00 | `orders` 갱신(이벤트 2) | 기다린다 |
| 11:00 | `orders` 갱신(이벤트 3) | 기다린다 |
| 11:30 | `products` 갱신 | 조건이 찼다. 실행 1번. `triggering_asset_events`에 `orders` 이벤트 3건과 `products` 1건이 들어 있다 |

이벤트는 네 건이 왔는데 실행은 한 번입니다. 이 실행이 "가장 최근 `orders` 이벤트의 파일 하나만 읽는다"고 짜여 있으면 09시와 10시 파일은 아무도 처리하지 않습니다.

주문 파일이 시간마다 갱신되는데 소비자 DAG가 `orders & products`를 기다린다면 `products`가 갱신되기 전까지 들어온 `orders` 이벤트 여러 건은 실행 한 번으로 합쳐집니다. 소비자 DAG가 "이벤트마다 그 이벤트의 데이터만 처리한다"고 짜여 있으면 합쳐진 이벤트의 데이터를 놓칩니다. 실행 한 번에 들어온 이벤트 목록은 `triggering_asset_events`로 받을 수 있으니 그걸 다 처리하거나 처리 범위를 이벤트 대신 테이블 상태로 정해야 합니다.

### 3-3. Airflow가 기록하는 것은 생산자 태스크의 성공뿐이다

asset은 URI 문자열에 붙인 이름입니다. 여러 문서가 Airflow는 그 URI가 가리키는 데이터가 실제로 바뀌었는지 확인하지 않는다고 설명합니다. 생산자 태스크가 성공했다는 사실만 기록합니다. 태스크가 성공했는데 파일을 비워 썼다면 소비자는 빈 데이터로 돕니다. 이 부분은 공식 문서 문장으로는 확인하지 못했고 2차 자료 기준입니다.

## 4. AssetWatcher: 외부 이벤트로 asset을 갱신한다

3절의 asset 이벤트는 Airflow 안의 태스크가 만듭니다. 데이터가 Airflow 밖에서 들어온다면 외부 신호를 받아야 합니다. 3.0에서 들어온 AssetWatcher가 이 일을 합니다. 메시지 큐 같은 외부 소스를 지켜보다 이벤트가 오면 asset을 갱신합니다.

```python
from airflow.providers.common.messaging.triggers.msg_queue import MessageQueueTrigger
from airflow.sdk import Asset, AssetWatcher

trigger = MessageQueueTrigger(scheme="kafka", ...)   # 큐 종류마다 필요한 인자가 다르다. provider 문서를 본다
orders = Asset("orders_topic", watchers=[AssetWatcher(name="orders_watcher", trigger=trigger)])
```

watcher는 triggerer에서 돕니다. 쓸 때 걸리는 조건이 있습니다.

| 조건 | 내용 |
|---|---|
| trigger 종류 | `BaseEventTrigger`를 상속한 trigger만 쓸 수 있다. Airflow의 모든 trigger가 되는 것은 아니다 |
| 상태를 기다리는 trigger 금지 | "파일이 있다", "잡이 성공했다"처럼 한 번 참이 되면 계속 참인 조건을 기다리는 trigger(예: `S3KeyTrigger`)는 쓰면 안 된다. 문서는 무한 재스케줄로 이어질 수 있다고 경고한다 |
| 받을 수 있는 큐 | common-messaging provider의 `MessageQueueTrigger`는 `scheme`으로 고른다. 문서 예시는 `sqs`, `kafka`, `redis+pubsub` |

두 번째 조건이 이벤트와 상태의 차이를 보여 줍니다. 이벤트는 "파일이 새로 생겼다"처럼 한 번 일어나고 끝나는 일입니다. 상태는 "파일이 있다"처럼 계속 참인 사실입니다. 상태를 이벤트처럼 받으면 확인할 때마다 이벤트가 새로 생깁니다.

### 4-1. 3.3에서 문서에 생긴 문장: at-least-once

3.3 문서에는 같은 소스를 읽는 trigger들이 폴링 하나를 공유하는 shared stream이 추가됐고 이렇게 적혀 있습니다. 장애가 나면 같은 이벤트가 두 번 전달될 수는 있어도 유실되지는 않으며 그래서 구독자는 멱등해야 한다. 3.2 문서에는 이 문장이 없습니다.

AWS가 MWAA와 Airflow 3 AssetWatcher, SQS로 구성한 글도 운영 주의점으로 같은 결을 짚습니다.

- triggerer가 죽으면 메시지는 큐에 쌓이기만 합니다.
- SQS 보존 기간(기본 4일, 최대 14일)을 넘기면 메시지가 사라지므로 DLQ를 둡니다. DLQ(dead-letter queue)는 여러 번 처리에 실패한 메시지를 따로 옮겨 두는 큐라 나중에 사람이 보고 다시 넣을 수 있습니다.
- VisibilityTimeout이 짧으면 같은 메시지를 다시 받아 DAG가 중복 실행됩니다. SQS는 메시지를 꺼내 간 소비자가 삭제할 때까지 그 메시지를 잠시 다른 소비자에게 숨기는데 그 시간이 VisibilityTimeout입니다. 처리가 이 시간보다 오래 걸리면 메시지가 다시 보이고 다른 소비자가 또 가져갑니다.

## 5. Argo Events: EventSource, EventBus, Sensor, Trigger

Argo Events는 이벤트를 받아 Argo Workflow 같은 쿠버네티스 리소스를 만듭니다. 이름 하나를 미리 짚고 갑니다. Argo Events의 Sensor는 2절의 Airflow 센서와 이름만 같고 하는 일이 다릅니다. Airflow 센서는 조건을 직접 확인하러 가는 폴링 태스크이고 Argo Events의 Sensor는 이미 도착한 이벤트들을 받아 조건이 맞는지 따지는 부품입니다.

```
EventSource ──→ EventBus ──→ Sensor ──(조건 충족)──→ Trigger ──→ Workflow 생성
(웹훅, Kafka,    (JetStream,    (의존성과 조건을      (submit, resubmit,
 S3, cron 등)     Kafka)         평가한다)             suspend, resume ...)
```

| 부품 | 하는 일 | 문서에서 확인한 것 |
|---|---|---|
| EventSource | 외부 이벤트를 받는다 | |
| EventBus | EventSource와 Sensor 사이를 잇는다 | NATS Streaming은 2023년 6월 지원 종료라 JetStream을 권한다. JetStream 기본 구성은 replica 3개 StatefulSet |
| Sensor | 여러 이벤트 의존성을 조건으로 묶는다 | `A && B`, `A \|\| B`. 조건이 참이 되면 의존성마다 가장 최근 이벤트를 쓰고 이전 이벤트는 버린다. `conditionsReset`으로 쌓인 상태를 정해진 시각에 비울 수 있다 |
| Trigger | 조건이 참이면 동작한다 | Workflow를 submit할 때 `generateName`으로 이름이 겹치지 않게 만든다. 기본은 재시도가 없고 `retryStrategy`로 켠다. `rateLimit`도 설정해야 생긴다 |

### 5-1. 중복 이벤트

at-least-once는 "적어도 한 번은 전달한다"는 약속입니다. 보낸 쪽이 받았다는 확인을 못 받으면 다시 보내니 유실은 막지만 확인 응답만 사라진 경우에는 같은 이벤트가 두 번 도착합니다(Ch-13). 문서는 NATS Streaming이 at-least-once 전달을 보장하고 JetStream은 exactly-once에 더 가까운 기능이 있다고 적습니다. Sensor 쪽에는 최근 5분 동안 전달된 이벤트 ID를 메모리에 캐시해 중복을 거르는 장치가 있습니다.

이 캐시는 두 가지 한계가 있습니다. 메모리에 있으니 Sensor Pod가 재시작하면 비워지고 5분이 지난 뒤 같은 이벤트가 다시 오면 거르지 못합니다. 문서가 이 한계를 직접 적지는 않았지만 "메모리 캐시, 5분"이라는 설명에서 나오는 결론입니다. 그 밖의 중복은 Trigger가 Workflow를 하나 더 만드는 것으로 이어집니다. 그래서 Workflow 쪽에서 막는 장치(mutex, semaphore, 이벤트 키로 정한 이름)가 필요하고 Ch-06에서 다룹니다.

국내에서는 비브로스(똑닥)가 2024년 Argo Events 도입기를 썼습니다. 패턴 없이 몰리는 마케팅 트래픽에 맞춰 스케일링하려고 Webhook EventSource, JetStream EventBus, Sensor로 구성했고 Workflow 이름에 이벤트 시각을 붙여 이름이 겹치지 않게 했습니다. Helm 템플릿의 `{{ }}`가 Argo 템플릿 문법과 충돌한 문제와 Sensor의 RBAC 권한 부족도 정리했습니다.

## 6. 세 방식 비교

| | 스케줄(cron) | 폴링(센서) | 이벤트 |
|---|---|---|---|
| 시작 시점 | 정해진 시각 | 확인 주기마다 조건을 본다 | 신호가 왔을 때 |
| 발견 지연 | 도착부터 다음 cron까지 | 확인 주기 이하 | 전달 시간 |
| 비용 | 거의 없다 | 확인 횟수, poke면 워커 슬롯 | 메시지 브로커와 받는 쪽 운영 |
| 데이터가 안 오면 | 빈 입력으로 돈다 | 타임아웃까지 기다린다 | 아무 일도 안 일어난다. 안 온 것을 따로 감시해야 한다 |
| 중복 | 없다 | 거의 없다 | at-least-once면 생긴다 |
| 이벤트 여러 건 | 해당 없음 | 해당 없음 | 도구에 따라 합쳐지거나(Airflow Asset) 각각 실행된다(Argo Trigger) |

"데이터가 안 오면" 줄이 이벤트 방식에서 놓치기 쉬운 부분입니다. cron은 정해진 시각에 돌면서 입력이 없다는 걸 드러내고 센서는 타임아웃으로 실패합니다. 이벤트 방식은 신호가 안 오면 조용합니다. 그래서 이벤트로 시작하는 파이프라인에도 "오늘 05시까지 이벤트가 없으면 알린다" 같은 시간 기준 감시를 하나 붙여 두는 경우가 많습니다. Airflow 3의 `AssetOrTimeSchedule`로 asset 이벤트와 시간 스케줄을 함께 걸 수 있다고 문서에 나오지만 동작은 이번에 확인하지 못했습니다.

## 7. 중국 빅테크 사례: 폴링을 이벤트로 바꾼 스케줄러

| 회사 | 내용 |
|---|---|
| 京东 Buffalo(2024) | 폴링하면 매번 가져오는 태스크 목록이 수십만에서 백만 건이 되고 대부분의 확인이 쓸모없는 확인이라 이벤트 구동으로 바꿨습니다 |
| ByteDance FlowX(2023) | 의존이 아직 충족되지 않으면 그 이벤트는 버리고 상위 태스크의 성공 이벤트가 하위 태스크를 깨웁니다. 상위 상태를 폴링하느라 자원을 쓰지 않으려는 것입니다. 외부 데이터를 기다리는 센서는 계속 폴링하지 않고 자동 재시도로 5분 뒤 다시 확인합니다(고정 간격) |
| 快手(2022) | 폴링 없이 태스크 발행, 스케줄링, 실행, 재시도를 모두 이벤트로 일으킵니다. 스케줄러를 정기, 트리거, 재계산(补数据), 차단 네 종류로 나눴고 차단은 대형 행사 때 우선순위가 낮은 태스크를 일부러 늦추는 데 씁니다 |
| Tencent US(2023) | 폴링과 트리거를 함께 씁니다. 폴링은 주기가 긴 대량 태스크용, 트리거는 분 단위 저지연 태스크용이고 트리거 쪽이 메모리를 더 씁니다 |

2절의 센서 비용(Airbnb)이 오케스트레이터 내부의 의존성 확인에서도 똑같이 생긴다는 것을 보여 줍니다. ByteDance의 5분 재확인은 2절의 reschedule 모드와 같은 발상입니다.

## 8. 범위와 한계

- 2-3절은 시뮬레이션입니다. 이벤트 방식의 전달 지연은 재지 않았습니다.
- AssetWatcher와 Argo Events를 직접 띄워 중복 전달을 재현하지는 않았습니다. 5-1절의 캐시 한계는 문서 설명에서 끌어낸 결론입니다.
- Airbnb Smart Sensor의 수치는 AIP-17 제안서에 적힌 값입니다. Smart Sensor가 이후 어떻게 정리됐는지는 확인하지 못했습니다.
- Kafka EventBus의 전달 보장과 Argo Events의 이벤트 순서 보장은 문서에서 찾지 못했습니다.

## 9. 헷갈렸던 것

**Q. 이벤트 트리거면 센서는 필요 없나요?**

데이터를 만드는 쪽이 이벤트를 보내 줄 때만 그렇습니다. 외부 회사가 SFTP에 파일을 올리기만 하고 아무 신호도 안 보낸다면 결국 누군가는 폴링해야 합니다. 이때도 deferrable 센서로 워커 슬롯을 놓고 기다리게 할 수 있습니다.

**Q. Airflow Asset 이벤트가 합쳐지면 데이터를 놓치지 않나요?**

소비자 DAG가 "이벤트마다 그 조각만 처리"하게 짜여 있으면 놓칩니다. 실행 한 번에 들어온 `triggering_asset_events`를 전부 처리하거나, 처리 범위를 "아직 처리하지 않은 파티션 전부"처럼 상태로 정하면 합쳐져도 안전합니다.

**Q. 이벤트가 두 번 오면 결과가 두 번 쌓이나요?**

받는 작업이 멱등하면 결과는 같습니다(Ch-03의 파티션 덮어쓰기). 다만 실행 자체는 두 번 일어나서 비용과 시간이 듭니다. 실행을 한 번으로 줄이려면 Ch-06의 방법이 필요합니다.

## 참고 자료

공식 문서
- [Airflow, Asset-aware scheduling](https://airflow.apache.org/docs/apache-airflow/stable/authoring-and-scheduling/asset-scheduling.html)
- [Airflow, Event-driven scheduling](https://airflow.apache.org/docs/apache-airflow/stable/authoring-and-scheduling/event-scheduling.html) ([3.2.0판](https://airflow.apache.org/docs/apache-airflow/3.2.0/authoring-and-scheduling/event-scheduling.html))
- [Airflow, Sensors](https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/sensors.html)
- [Airflow, Deferrable Operators & Triggers](https://airflow.apache.org/docs/apache-airflow/stable/authoring-and-scheduling/deferring.html)
- [Airflow common-messaging provider, Triggers](https://airflow.apache.org/docs/apache-airflow-providers-common-messaging/stable/triggers.html)
- [Argo Events, EventBus](https://argoproj.github.io/argo-events/eventbus/eventbus/), [JetStream](https://argoproj.github.io/argo-events/eventbus/jetstream/)
- [Argo Events, More about Sensors and Triggers](https://argoproj.github.io/argo-events/sensors/more-about-sensors-and-triggers/)
- [Argo Events, Trigger Conditions](https://argoproj.github.io/argo-events/sensors/trigger-conditions/)
- [Argo Events, Argo Workflow Trigger](https://argoproj.github.io/argo-events/sensors/triggers/argo-workflow/)

사례
- [AIP-17 Smart Sensor](https://cwiki.apache.org/confluence/spaces/AIRFLOW/pages/103093484/AIP-17+Consolidate+and+de-duplicate+sensor+tasks+in+airflow+Smart+Sensor)
- AWS Big Data Blog, [Event-driven pipeline orchestration with Amazon MWAA and Airflow 3.0](https://aws.amazon.com/blogs/big-data/event-driven-pipeline-orchestration-with-amazon-mwaa-and-airflow-3-0/) (2026)
- Astronomer, [Event-driven scheduling](https://www.astronomer.io/docs/learn/airflow-event-driven-scheduling)
- Astronomer, [Airflow sensors](https://www.astronomer.io/docs/learn/what-is-a-sensor)
- 비브로스, [Argo Events 도입기](https://boostbrothers.github.io/2024-04-15-infra-argo-events/) (2024)

이 시리즈
- 실습 코드: [labs/de-study/ch05](https://github.com/dj258255/IT-Oasis/tree/main/labs/de-study/ch05)

중국과 국내 빅테크 사례
- 京东, [京东百万级调度系统(Buffalo)架构解密](https://developer.jdcloud.com/article/3944), 2024
- 火山引擎数智平台(ByteDance), [火山引擎DataLeap背后的支持者 - 工作流编排调度系统FlowX](https://developer.volcengine.com/articles/7293813926247170111), 2023
- 张蕤(快手), [快手大数据任务调度系统设计与实践](https://www.tonguebusy.com/a/tuiguang/weixintuiguang/1107.html), DataFunTalk 재게시, 2022
- 马朋勃(Tencent), [腾讯大数据分布式任务调度平台——US](https://www.modb.pro/db/647438), DataFun 재게시, 2023

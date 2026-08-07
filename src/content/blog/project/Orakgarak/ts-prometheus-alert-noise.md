---
title: '[트러블슈팅] Prometheus 알림 폭풍'
description: 서버 재시작할 때마다 알림이 50-100건씩 쏟아져서 정작 중요한 알림을 놓치고 있었다. for 절과 inhibit_rules로 노이즈를 90% 줄인 과정을 정리한다.
date: 2025-10-27T00:00:00.000Z
tags:
  - Troubleshooting
  - Prometheus
  - Alertmanager
  - Alert Fatigue
  - Monitoring
category: team/Orakgarak
draft: false
coverImage: "/uploads/project/Orakgarak/ts-prometheus-alert-noise/alertmanager-routing.svg"
series: "Orakgarak"
---

## 한 줄 요약

서버 재시작할 때마다 Mattermost에 알림이 50-100건씩 쏟아져서 정작 중요한 알림을 놓치고 있었습니다.
`for` 절로 일시적 스파이크를 걸러내고, inhibit_rules로 중복 알림을 억제해서 노이즈를 90% 줄였습니다.

---

## 증상

배포하거나 서버를 재시작할 때마다 Mattermost에 수십 건의 알림이 동시에 쏟아졌습니다.
ApplicationDown, HighCPU, HighMemory, HighResponseTime이 한꺼번에 울리는데, 원인은 서버 재시작 하나였습니다.

문제는 알림 피로였습니다.
알림이 너무 자주 오니까 슬슬 무시하게 되고, 진짜 장애가 났을 때도 "또 노이즈겠지"하고 넘기는 상황이 생겼습니다.

## 환경

- Prometheus + Alertmanager + Grafana
- Mattermost Webhook 연동
- Docker Compose 단일 서버 구성

---

## 원인 분석

두 가지가 겹쳤습니다.

### 1. for 절 없이 즉시 알림

기존 알림 규칙에 `for` 절이 없었습니다.
Prometheus가 15초 간격으로 스크래핑하도록 설정(기본값은 1분이지만 빠른 감지를 위해 15초로 변경)했는데, 한 번이라도 임계값을 넘으면 바로 알림이 나갔습니다.

서버 재시작 시 CPU와 메모리가 일시적으로 튀는 건 정상입니다.
JVM 워밍업, 커넥션 풀 초기화, Kafka Consumer 리밸런싱 등이 동시에 일어납니다.
그런데 이걸 전부 장애로 인식하고 있었습니다.

### 2. 억제 규칙이 없었다

서버가 죽으면 ApplicationDown(Critical)이 뜹니다.
그런데 서버가 죽었으니 당연히 CPU도 응답시간도 비정상이 됩니다.
HighCPU(Warning), HighResponseTime(Warning)이 같이 울립니다.
근본 원인은 하나인데 알림이 4건 나오는 구조였습니다.

---

## 해결

### 1. for 절로 지속 시간 필터링

서버/DB 다운 같은 Critical은 `for: 1m`으로 빠르게 감지하되, Warning은 `for: 5m`으로 충분한 지속 시간을 확인한 뒤에만 알림을 보내도록 했습니다.

| 알림 | for 값 | 심각도 | 임계값 |
|------|--------|--------|--------|
| ApplicationDown | 1m | critical | `up == 0` |
| HighErrorRate | 3m | critical | 5xx > 10% |
| HighResponseTime | 5m | warning | P95 > 2초 |
| HighCPUUsage | 5m | warning | > 80% |
| HighMemoryUsage | 5m | warning | > 85% |
| MySQLDown | 1m | critical | `up == 0` |
| KafkaConsumerLag | 5m | warning | > 1000 |

서버 재시작 후 CPU 스파이크는 보통 1-2분 안에 안정화됩니다.
`for: 5m`이면 이런 일시적 이상은 걸러집니다.

### 2. Alertmanager 라우팅 분리

![](/uploads/project/Orakgarak/ts-prometheus-alert-noise/alertmanager-routing.svg)

Critical은 `group_wait: 10s`로 빠르게 보내고, Warning은 `group_wait: 2m`으로 모아서 보냅니다.

### 3. 억제 규칙(Inhibit Rules)

![](/uploads/project/Orakgarak/ts-prometheus-alert-noise/inhibit-rules.svg)

ApplicationDown(Critical)이 발생하면 같은 인스턴스의 HighCPU, HighMemory, HighResponseTime(Warning)을 자동 억제합니다.

적용 전: ApplicationDown + HighCPU + HighMemory + HighResponseTime = 4건
적용 후: ApplicationDown 1건만

---

## 실제 알림 규칙 전체 (28개)

**애플리케이션 (4개)**: ApplicationDown(`for: 1m`, critical), HighResponseTime(`for: 5m`, warning), HighErrorRate(`for: 3m`, critical), HighJVMMemoryUsage(`for: 5m`, warning)

**인프라 (3개)**: HighCPUUsage(`for: 5m`, warning), HighMemoryUsage(`for: 5m`, warning), HighDiskUsage(`for: 5m`, warning)

**데이터베이스 (4개)**: MySQLDown/RedisDown(`for: 1m`, critical), MySQLHighConnections(`for: 5m`, warning), RedisHighMemoryUsage(`for: 5m`, warning)

**Kafka (2개)**: KafkaDown(`for: 1m`, critical), KafkaConsumerLag(`for: 5m`, warning)

**컨테이너 (3개)**: ContainerRestartingFrequently(`for: 0m`, warning, 즉시 감지), ContainerHighCPU/MemoryUsage(`for: 5m`, warning)

---

## 결과

| 지표 | 개선 전 | 개선 후 |
|------|--------|--------|
| 배포 시 알림 수 | 50~100건 | 3~5건 |
| 알림 노이즈 | 높음 | 90% 감소 |
| Critical 대응 속도 | 알림 피로로 지연 | 즉시 대응 |

---

## 참고 자료

- [Alertmanager Configuration](https://prometheus.io/docs/alerting/latest/configuration/)
- [Prometheus Alerting Rules](https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/)

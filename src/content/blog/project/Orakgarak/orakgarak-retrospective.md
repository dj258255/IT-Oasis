---
title: '오락가락 개발기: 음성 분석 파이프라인과 모니터링을 세운 5주'
description: >-
  목소리로 노래를 추천하는 플랫폼 오락가락을 6인 팀으로 5주간 만들며 내린 기술 결정을
  시간순으로 모았습니다. Prometheus와 Grafana, Loki로 모니터링을 세운 과정, Presigned URL과
  EventBridge 업로드, Kafka 이벤트 드리븐 파이프라인, 그리고 GPU OOM과 파티션 불균형,
  알림 폭풍을 잡은 트러블슈팅까지 담았습니다.
date: 2025-10-27
tags:
  - Orakgarak
  - Team Project
  - Spring Boot
  - Kafka
  - Prometheus
  - Grafana
  - Loki
  - AWS S3
  - EventBridge
  - Monitoring
  - Troubleshooting
  - Retrospective
category: team/Orakgarak
coverImage: /uploads/project/Orakgarak/retrospective/title.png
draft: false
series: "Orakgarak"
seriesOrder: 1
---

오락가락은 내 목소리 데이터를 기반으로 노래를 추천하는 플랫폼입니다. 노래방에서 뭘 부를지 고민하는 상황을 팀원 6명 중 5명이 겪어봤다는 데서 시작했습니다. 일반적인 음악 추천은 청취 기록을 보지만, 내가 좋아하는 노래와 내가 잘 부를 수 있는 노래는 다릅니다. 사용자가 노래를 부르면 AI가 음역대와 음색을 분석해서 비슷한 음역대의 인기 곡을 추천합니다.

![오락가락 아키텍처](/uploads/project/Orakgarak/retrospective/architecture.png)

| | |
|---|---|
| **기간** | 2025.08.26 ~ 2025.09.30 (5주) |
| **팀 구성** | 6명 (프론트엔드 2명, 백엔드 3명, AI 1명) |
| **기술 스택** | Java, Spring Boot, Kafka, AWS S3, Prometheus, Grafana, Loki, Docker |

백엔드 33%와 인프라 50%를 담당했습니다. 파일 업로드 시스템과 앨범 및 녹음 관리, 그리고 모니터링 인프라 전체를 맡았습니다. 이벤트 드리븐 아키텍처와 모니터링 시스템을 실무 수준으로 세워본 건 이 프로젝트가 처음이었습니다.

아래 여덟 장의 배경은 전부 같습니다. Docker Compose로 단일 서버에 Spring Boot와 MySQL, Redis, Kafka, Prometheus, Grafana, Loki를 함께 올려 운영했고, 알림은 Mattermost Webhook으로 받았습니다. 장마다 환경을 다시 적지 않고 여기에 한 번만 적어둡니다.

만드는 동안의 기록을 편마다 나눠 올렸는데, 흩어져 있으니 앞뒤가 끊겼습니다. 1장에서 세운 모니터링이 왜 8장의 알림 폭풍으로 이어졌는지, 4장의 Kafka 파이프라인이 6장의 파티션 불균형과 어떻게 맞물리는지가 글을 오가야만 보였습니다. 그래서 시간순 아홉 장으로 합쳤습니다. 장 머리에 원문 발행일을 남겨 개발 순서를 알 수 있게 했습니다.

---

## 1. Prometheus와 Grafana, Loki로 모니터링 세우기

*원문 발행일 2025-09-01*

처음에는 장애를 사람이 발견했습니다. 누군가 "서비스 안 되는데요" 하면 SSH로 들어가 로그를 `grep`하는 식이었습니다. 원인을 찾는 데 몇 시간이 걸리기도 했습니다. 5주 프로젝트에서 그 시간은 그대로 손해였습니다.

메트릭은 Prometheus, 로그는 Loki, 화면은 Grafana로 묶었습니다.

수집은 Exporter로 나눠 걸었습니다.

| Exporter | 수집 대상 | 주요 메트릭 |
|----------|-----------|-------------|
| Spring Actuator | 애플리케이션 | JVM, HTTP, 커스텀 메트릭 |
| Node Exporter | 호스트 서버 | CPU, 메모리, 디스크, 네트워크 |
| cAdvisor | Docker 컨테이너 | 컨테이너별 CPU, 메모리, I/O |
| MySQL Exporter | MariaDB | 연결 수, 쿼리 성능, InnoDB |
| Redis Exporter | Redis | 메모리, 히트율, 커맨드 통계 |
| Kafka Exporter | Kafka | Consumer Lag, 파티션, 브로커 |

CloudWatch도 후보였습니다. 관리형이라 손이 덜 가지만, 커스텀 메트릭과 조회에 건당 비용이 붙고 PromQL 같은 쿼리 표현력이 아쉬웠습니다. 무엇보다 Exporter 생태계를 그대로 쓸 수 있다는 게 컸습니다. Kafka Consumer Lag처럼 우리가 꼭 봐야 하는 값을 붙이는 데 Prometheus 쪽이 훨씬 빨랐습니다.

로그는 ELK 대신 Loki로 갔습니다. Elasticsearch는 로그 본문을 전문 색인하기 때문에 메모리를 많이 씁니다. 단일 서버에 Kafka와 MySQL, Redis가 이미 올라가 있는 상황에서 2GB 넘게 쓰는 스택을 더 얹을 수 없었습니다. Loki는 라벨만 색인하고 본문은 압축해 보관해서 훨씬 가볍고, 이미 Grafana를 쓰고 있으니 화면도 하나로 합쳐집니다.

![](/uploads/project/Orakgarak/prometheus-grafana-loki-monitoring/monitoring-stack-architecture.png)

알림은 Alertmanager로 Mattermost에 보냈습니다. Critical과 Warning을 나눠 대기 시간과 반복 간격을 다르게 뒀고, 규칙은 29개를 정의했습니다. 이 알림이 나중에 폭풍이 되어 손보게 되는데, 그 과정은 [8장](#8-알림이-하루에-100건씩-쏟아졌다)에 적었습니다.

단일 서버 구성의 한계도 알고 갔습니다. 모니터링 스택이 감시 대상과 같은 서버에 있으니, 서버가 통째로 죽으면 알림도 같이 죽습니다. 외부에서 찔러보는 감시는 이 프로젝트에서 넣지 못했습니다.

![](/uploads/project/Orakgarak/prometheus-grafana-loki-monitoring/monitoring-server-separation.png)

| 지표 | 개선 전 | 개선 후 |
|------|--------|--------|
| 장애 감지 시간 | 수동 확인 (수분에서 수시간) | Critical 약 85초, Warning 약 5분 |
| 로그 검색 시간 | SSH 접속 후 grep (수십 초) | Grafana에서 즉시 |
| 근본 원인 분석 | 수시간 | 10분 이내 |

---

## 2. 다중 FilterChain으로 경로별 인증 분리

*원문 발행일 2025-09-09*

### 문제 상황

오락가락 서비스의 보안 요구사항은 경로마다 달랐습니다.

`/api/webhook/**`은 EventBridge에서 호출하는 내부 엔드포인트입니다.
인증 없이 접근 가능해야 합니다.
`/api/**`는 사용자 API인데, JWT Bearer Token으로 인증이 필수입니다.
`/actuator/**`는 Prometheus가 메트릭을 수집하는 모니터링용 엔드포인트인데, 외부에 노출되면 안 되니 Basic Auth로 보호해야 했습니다.

하나의 SecurityFilterChain에 이 세 가지를 넣으려고 하면 충돌합니다.
Webhook은 `permitAll()`이어야 하고 API는 `authenticated()`여야 하는데, `/api/webhook/**`이 `/api/**`에 포함되기 때문입니다.

처음에는 단일 FilterChain에서 `requestMatchers` 순서로 해결하려 했습니다.
`/api/webhook/**`을 먼저 `permitAll()`로 설정하고 `/api/**`를 `authenticated()`로 설정하면 경로 우선순위로 동작할 수 있지만, 실제로 Actuator의 Basic Auth(`httpBasic()`)와 API의 JWT Bearer Token은 **Filter 자체가 달라야** 합니다.
`httpBasic()`이 활성화된 Chain에서 JWT 요청이 들어오면 Basic Auth 실패로 401이 반환되는 문제가 발생했습니다.

---

### 3개의 FilterChain 분리

@Order 어노테이션과 securityMatcher로 경로별 독립적인 FilterChain을 구성했습니다.

| 순서 | 경로 | 인증 방식 | 이유 |
|------|------|----------|------|
| @Order(1) | `/api/webhook/**` | 없음 (permitAll) | EventBridge 내부 통신 |
| @Order(2) | `/actuator/**` | Basic Auth | Prometheus 메트릭 수집 |
| @Order(3) | `/api/**` | JWT Bearer Token | 사용자 API |

![](/uploads/project/Orakgarak/spring-security-multi-filterchain/filterchain-flow.svg)

요청이 들어오면 Order가 낮은 Chain부터 securityMatcher를 확인합니다.
매칭되면 해당 Chain에서 처리하고, 아니면 다음 Chain으로 넘어갑니다.
Webhook 경로가 먼저 매칭되니, API Chain의 JWT 필터를 타지 않습니다.

---

### Webhook에 인증이 없어도 되는 이유

보안이 없는 엔드포인트가 있다는 게 불안할 수 있습니다.
하지만 이 경로는 여러 계층에서 이미 보호되고 있습니다.

1. EventBridge Rule이 특정 S3 버킷의 ObjectCreated 이벤트만 트리거합니다.
2. EC2의 Security Group으로 인바운드 접근을 제한합니다. (단, EventBridge API Destination은 퍼블릭 인터넷을 경유하므로 VPC 내부 격리가 아닌 Security Group + HTTPS가 보호 계층입니다.)
3. 경로가 `/api/webhook/**`으로 한정되어 있어 다른 API에 영향이 없습니다.
4. 핸들러에서 S3 ObjectCreated 이벤트 구조를 검증합니다.
형식이 맞지 않으면 무시합니다.

AWS 인프라 레벨의 보안이 앞단에서 걸러주는 구조입니다.

**HMAC 서명 검증은 왜 안 했는가**: EventBridge → HTTP 엔드포인트 호출에서 HMAC 서명을 직접 추가하려면 Lambda를 중간에 끼워야 합니다. EventBridge 자체는 HTTP 헤더에 서명을 넣는 기능이 없습니다. AWS API Destination + Connection으로 OAuth/API Key 인증은 가능하지만, Security Group + HTTPS로 접근이 제한된 상태에서 Lambda를 추가하는 건 5주 프로젝트 기준 과잉이라 판단했습니다. (EventBridge API Destination은 퍼블릭 인터넷을 경유하므로 VPC 격리가 아닌 Security Group이 보호 계층입니다.)

프로덕션이라면 EventBridge → API Destination에 `Authorization` 헤더를 설정하거나, Webhook 핸들러에서 EventBridge 이벤트의 `source`, `detail-type` 필드를 검증하는 방식이 더 적합합니다.

---

### 구현 상세

![](/uploads/project/Orakgarak/spring-security-multi-filterchain/security-config.svg)

---

### 결과

| 경로 | 변경 전 (단일 FilterChain) | 변경 후 (3개 FilterChain) |
|------|------------------------|------------------------|
| `/api/webhook/**` | JWT 필터에 걸려 EventBridge 호출 실패 (401) | `permitAll()`로 정상 처리 |
| `/actuator/**` | JWT 인증 요구 → Prometheus 수집 실패 | Basic Auth로 Prometheus 정상 수집 |
| `/api/**` | JWT 인증 정상 (단, httpBasic 충돌 시 401) | JWT Bearer Token 전용, 충돌 없음 |

각 Chain이 독립된 Filter 구성을 갖기 때문에, 한 경로의 인증 방식이 다른 경로에 영향을 주지 않습니다.
새로운 인증 방식이 필요한 경로가 추가돼도 기존 Chain을 수정하지 않고 새 Chain만 추가하면 됩니다.

---

## 3. Presigned URL과 EventBridge로 업로드 받기

*원문 발행일 2025-09-17*

처음에는 Presigned URL로 S3에 바로 올리면 끝이라고 생각했습니다. 그런데 AI 담당 팀원이 추론 서버는 WAV만 처리한다고 했습니다. 브라우저 녹음은 WebM으로 나오니 어딘가에서 변환이 필요했습니다. 그래서 서버가 파일을 받아 변환한 뒤 S3에 올리는 방식으로 갔습니다. 동작은 했지만 여기서 문제가 나왔습니다.

### 서버를 거치게 하면 셋이 걸린다

첫째, 파일 데이터가 서버 메모리를 경유합니다. 음성 파일 하나가 30~50MB인데 동시 업로드가 10건만 겹쳐도 디스크 I/O와 메모리 버퍼링으로 수백 MB가 순간 점유되고, S3 전송까지 포함하면 요청당 30~40초씩 자원을 물고 있습니다. 실제로 OOM이 터진 건 아니지만 힙 압박에서 Full GC로, 다시 응답 지연과 스레드 점유 누적으로 이어지는 구조였습니다.

둘째, 파일이 네트워크를 두 번 탑니다. 클라이언트에서 서버로 한 번, 서버에서 S3로 또 한 번입니다. 업로드 시간이 두 배가 되고 서버와 S3 구간에서 실패하면 클라이언트부터 다시 보내야 합니다.

셋째, 업로드가 서버 상태에 묶입니다. 배포 중에는 업로드가 끊기고, 수평 확장을 해도 각 서버가 파일을 버퍼링해야 하니 스케일아웃의 이점이 상쇄됩니다.

### 그러면 WAV 변환은 어디서 하나

Presigned URL을 쓰면 서버가 파일을 받지 않으니 변환 시점이 달라집니다. 프론트에서 할지 백엔드에서 할지 골라야 했습니다.

프론트에서 변환하면 용량이 문제입니다. WebM은 압축 포맷이라 5MB 정도인데 WAV는 비압축이라 50MB까지 늘어납니다. 모바일에서 50MB를 올리게 만들 수는 없었습니다. 실패 복구도 다릅니다. 프론트에서 변환 중 실패하면 사용자가 다시 녹음해야 하는데, 백엔드에서 실패하면 S3에 원본이 남아 있으니 재시도할 수 있습니다. 품질도 FFmpeg로 샘플레이트와 비트뎁스를 정밀하게 제어하는 쪽이 브라우저 Web Audio API보다 유리했습니다.

그래서 원본 WebM을 S3로 직접 올리고 백엔드에서 FFmpeg로 변환하는 쪽으로 정했습니다.

### 최종 흐름

클라이언트가 Presigned URL을 요청하면 서버가 DB에 PENDING 상태의 Upload 레코드를 만들고 URL을 발급합니다. 클라이언트는 S3에 직접 올립니다. 업로드가 끝나면 S3의 ObjectCreated 이벤트가 EventBridge를 거쳐 Spring Boot 핸들러로 들어오고, 거기서 WAV 변환과 AI 분석이 이어집니다.

![](/uploads/project/Orakgarak/presigned-url-eventbridge-upload/full-flow-diagram.png)

서버는 파일 데이터를 만지지 않고 URL 발급과 이벤트 처리만 합니다. 이 구조가 [4장](#4-kafka-이벤트-드리븐-파일-처리-파이프라인)의 비동기 파이프라인으로 이어졌습니다.

---

## 4. Kafka 이벤트 드리븐 파일 처리 파이프라인

*원문 발행일 2025-09-25*

사용자가 녹음한 음성은 평균 30~50MB WebM입니다. 이걸 FFmpeg로 WAV로 바꾸고 GPU 8GB짜리 Python FastAPI 서버에서 분석해야 합니다. 처음에는 업로드 API 안에서 둘을 동기로 처리했습니다.

WAV 변환에 5~10초, AI 분석에 20~30초가 걸렸습니다. 사용자는 녹음 버튼을 누르고 최대 40초를 빈 화면 앞에서 기다렸습니다. 동시 업로드가 4건 겹치면 Tomcat 스레드 4개가 각각 30~40초씩 잡히고, 그 동안 FFmpeg가 CPU를 물고 있어서 다른 API 응답까지 느려졌습니다.

비동기로 떼야 하는 건 명확했습니다. 문제는 무엇으로 뗄 것인가였습니다.

### 자체 큐부터 관리형 큐까지 훑어본 과정

같은 JVM 안에서 도는 모노레포였으니 `BlockingQueue`가 가장 먼저 떠올랐습니다. 구현이 간단하고 외부 의존성도 없습니다. 그런데 서버를 재시작하면 큐에 있던 작업이 전부 날아갑니다. 30초 넘게 걸리는 분석 작업인데 배포할 때마다 처리 중인 건이 사라지면 사용자가 다시 녹음해야 합니다. 하루에 몇 번씩 배포하는 프로젝트에서 감수할 수 없었습니다. AI 서버가 Python으로 분리돼 있어 JVM 내부 큐로는 통신도 안 되고, 실패한 작업을 추적할 방법도 없었습니다.

RabbitMQ는 라우팅이 유연하고 지연도 낮습니다. 다만 소비자가 ack하면 큐에서 지워집니다. durable queue로 브로커 재시작은 버티지만, 이미 소비된 메시지를 되감아 재처리하는 건 불가능합니다. 장애가 났을 때 이 파일이 어떤 이벤트를 거쳤는지 원본을 다시 볼 수 없다는 뜻입니다. 같은 `uploadId`의 순서 보장도 consistent hash exchange를 따로 설정해야 됩니다.

SQS도 봤습니다. AWS를 쓰고 있으니 관리형이 매력이었습니다. Standard는 순서 보장이 안 되고, FIFO는 기본 초당 300건에 High Throughput을 켜면 3,000건까지 갑니다. 우리 트래픽에는 충분한 수치였습니다. 다만 여기도 소비 후 삭제라 되감기가 안 되고, Python 쪽에 Lambda를 따로 둬야 했습니다.

### Kafka를 고른 이유

Spring Boot와 Python FastAPI가 같은 토픽으로 JSON을 주고받는 구조가 깔끔했습니다. 각 서비스가 독립적으로 배포되고 한쪽이 죽어도 메시지는 Kafka에 남습니다.

`uploadId`를 파티션 키로 쓰면 같은 파일의 모든 이벤트가 같은 파티션에 들어갑니다. WAV 변환이 끝나기 전에 AI 분석이 먼저 도는 문제를 구조적으로 막을 수 있습니다. 별도 설정 없이 파티션 키만 지정하면 되는 기본 동작이라는 점이 RabbitMQ와 갈린 지점이었습니다.

같은 이벤트를 여러 컨슈머 그룹이 독립적으로 가져갈 수 있다는 것도 컸습니다. 음성 처리와 로그 수집, 나중의 추천 데이터 파이프라인이 한 토픽에서 각자 읽어갑니다.

실패 처리도 자연스럽습니다. 오프셋을 커밋하지 않으면 자동 재시도되고, 최대 재시도를 넘기면 DLQ로 갑니다. retention을 7일로 뒀으니 그 안에는 오프셋 리셋으로 언제든 재처리할 수 있습니다. 배포할 때도 마지막 커밋 오프셋부터 재개되니 유실이 없습니다.

### 솔직한 평가

맞는 판단이었다고 생각하지만 비용도 분명했습니다.

현재 트래픽만 보면 SQS FIFO로도 충분했습니다. MessageGroupId로 순서 보장이 되고 DLQ도 네이티브로 지원합니다. 비용으로 보면 SQS FIFO는 월 $5 미만인데, Kafka는 별도 EC2를 안 띄웠으니 추가 인프라 비용은 0이지만 브로커가 메모리와 디스크를 먹습니다. 공식 문서는 KRaft 브로커에 최소 4~5GB를 권하는데, 토픽과 파티션이 적어서 JVM 힙을 1GB로 제한해 운영했습니다. 관리형 MSK는 최소 사양이 월 $150 이상이라 프로젝트 규모에 과했습니다.

Kafka를 고른 가장 큰 이유 중 하나는 빅데이터 추천 트랙 프로젝트에서 Kafka 파이프라인 경험을 쌓고 싶었기 때문입니다. 그리고 Spark나 Flink로의 확장은 구현하지 않았습니다. Kafka에서 Pinecone까지는 붙였지만, 할 수 있는 구조와 실제로 한 것은 다릅니다.

### 성과

| 지표 | 개선 전 | 개선 후 |
|------|--------|--------|
| 업로드 응답 시간 | 5~30초 | 200ms |
| 복구 방식 | 수동 확인 | 30분 주기 배치 스캔 + 최대 3회 자동 재시도 |
| 실패 처리 | 영구 Stuck | DLQ 이동 후 Mattermost 알림 |
| 장애 영향 범위 | 전체 API 지연 | 해당 처리만 격리 |

비동기로 바꾸니 프론트가 완료를 아는 방법도 바뀌었습니다. 업로드 API는 `uploadId`만 즉시 반환하고, 프론트는 그걸로 상태를 폴링합니다. 응답에 PENDING에서 CONVERTING, ANALYZING을 거쳐 COMPLETED나 FAILED로 가는 현재 상태가 담겨 있어서 진행 상황을 보여줄 수 있습니다. WebSocket과 SSE도 봤지만 3초 폴링이면 충분했고 구현이 훨씬 간단했습니다.

---

## 5. 동시 요청에 GPU가 OOM으로 죽었다

*원문 발행일 2025-10-03*

### 증상

운영 중에 음성 분석 요청이 몰리면 Python AI 서버가 죽었습니다.
Pod가 OOMKilled 상태로 재시작되고, 재시작되는 동안 모든 분석 요청이 타임아웃.
하루에 5-10회 반복됐습니다.
Grafana의 컨테이너 모니터링 대시보드에서 AI 서버 Pod의 재시작 횟수가 하루 단위로 올라가는 걸 확인했습니다.

### 원인 분석

GPU 메모리를 계산해봤습니다.

GPU 전체 메모리 8GB 중 모델 로딩에 약 3GB가 상시 점유됩니다.
추론 1건당 약 2-3GB를 씁니다.
최대 동시 처리는 (8 - 3) / 2.5 = 약 2건입니다.

그런데 Kafka Consumer에서 이벤트가 들어오는 대로 AI 서버에 요청을 쏘고 있었습니다.
동시에 5건만 들어오면 필요 메모리가 VRAM을 초과하니 OOM이 나는 게 당연했습니다.

AI 분석 담당 팀원과 같이 `nvidia-smi`로 GPU 메모리 사용량을 모니터링하면서 동시 요청 수와 OOM 발생 시점을 대조했습니다.
동시 3건까지는 안정적이고, 4건부터 가끔 스파이크가 나고, 5건 이상이면 거의 확실하게 OOM이 터졌습니다.

---

### 해결: ThreadPool + Semaphore 이중 제어

단순히 동시 요청을 줄이면 되는 문제가 아니었습니다.
WAV 변환과 AI 분석이 같은 Consumer에서 처리되는데, WAV 변환은 CPU 바운드라 빠르게 끝나고 AI 분석은 GPU를 오래 점유합니다.
같은 스레드풀로 처리하면 AI 분석이 WAV 변환까지 블로킹합니다.

그래서 두 가지를 분리했습니다.

**ThreadPool(max=4)**: 시스템 내부 리소스(CPU, 메모리) 보호.
최대 4개 스레드까지 작업을 처리합니다.

**Semaphore(permits=2)**: 외부 서비스(AI 서버 GPU) 보호.
4개 스레드가 동시에 실행되더라도 AI 서버에는 2개만 동시 요청합니다.

permits를 2로 잡은 이유는, GPU 계산상 최대 동시 처리가 약 2건이고, 요청마다 메모리 사용량이 다르기 때문에(음성 길이, 복잡도에 따라 편차) 안전 마진을 포함한 수치입니다.

#### 검토했지만 선택하지 않은 대안

| 방식 | 장점 | 단점 | 판단 |
|------|------|------|------|
| **Kafka `max.poll.records` 조절** | 설정만 변경 | Consumer 레벨 제한이라 GPU 메모리와 직접 연동 안 됨. WAV 변환까지 같이 제한됨 | 탈락 |
| **Resilience4j RateLimiter** | 시간 기반 요청률 제한 | AI 분석은 시간당 N건이 아니라 동시 N건이 문제. 처리 시간이 가변적이라 rate 기반은 부적합 | 탈락 |
| **ThreadPool만 (Semaphore 없이)** | 단순 | WAV 변환과 AI 분석이 같은 풀이면 AI가 WAV를 블로킹. 풀을 분리해도 AI 전용 풀 max=2로 하면 Semaphore와 사실상 동일 | 부분 채택 |
| **ThreadPool + Semaphore** | 내부(CPU) + 외부(GPU) 자원을 독립 제어 | 구현 약간 복잡 | **선택** |

ThreadPool만으로도 가능하지만, Semaphore로 "외부 GPU 자원에 대한 동시 접근 제한"을 명시적으로 분리한 게 Bulkhead 패턴의 의도를 더 잘 표현합니다.

![](/uploads/project/Orakgarak/ts-gpu-oom-concurrent-requests/threadpool-semaphore-dual-control.svg)

#### Semaphore Bean 설정

![](/uploads/project/Orakgarak/ts-gpu-oom-concurrent-requests/semaphore-bean-config.svg)

#### ThreadPool 설정

![](/uploads/project/Orakgarak/ts-gpu-oom-concurrent-requests/threadpool-config.svg)

#### Semaphore 사용 코드

![](/uploads/project/Orakgarak/ts-gpu-oom-concurrent-requests/semaphore-usage-code.svg)

---

### 작업별 리소스 분리

| 작업 타입 | ThreadPool | Semaphore | 이유 |
|----------|------------|-----------|------|
| WAV 변환 | 5~10 | 8 | CPU 바운드, 빠른 처리 |
| 음성 분석 | 2~4 | 2 | GPU 사용, 무거운 AI 처리 |
| 이미지 처리 | 3~6 | 4 | 중간 수준 |
| 배치 복구 | 2~4 | 3 | 백그라운드 처리 |

무거운 작업(AI 분석)이 가벼운 작업(WAV 변환)을 블로킹하지 않도록 풀을 분리한 게 핵심입니다.

---

### 결과

| 지표 | 개선 전 | 개선 후 |
|------|--------|--------|
| AI 서버 OOM 발생 | 하루 5-10회 | 0회 |
| 평균 분석 대기 시간 | 실패로 무한 대기 | 30초 |
| GPU 활용률 | 불안정 (100% 스파이크) | 85% 안정 |
| 분석 성공률 | ~70% | 99%+ |

요청이 폭주해도 세마포어 대기열에서 순차 처리되니 Pod 재시작이 0회가 됐습니다.

---

## 6. Kafka 파티션 불균형으로 처리가 밀렸다

*원문 발행일 2025-10-11*

### 증상

Kafka Exporter로 Consumer Lag을 파티션별로 확인하니, 특정 파티션에만 메시지가 몰려 있었습니다.
파티션 0의 Lag이 5000인데 파티션 1은 5, 파티션 2는 3이었습니다.
파티션 0에 붙은 Consumer만 바쁘게 돌고, 나머지 Consumer는 유휴 상태였습니다.

결과적으로 파티션 0에 걸린 사용자의 음성 분석이 5분 넘게 대기하는 반면, 다른 파티션에 걸린 사용자는 바로 처리됐습니다.

### 원인: 파티션 키가 userId

기존에 userId를 파티션 키로 쓰고 있었습니다.
"같은 사용자의 이벤트는 순서대로 처리되어야 한다"는 생각이었습니다.

문제는 활동적인 사용자 한 명이 하루에 100건의 녹음을 올리면, 그 100건이 전부 같은 파티션에 들어간다는 것입니다.
비활동 사용자는 하루 3-5건이니, 파티션 간 부하 차이가 수십 배까지 벌어집니다.

---

### 대안 검토

| 방식 | 장점 | 단점 | 판단 |
|------|------|------|------|
| **Round-robin (키 없음)** | 완벽한 균등 분산 | 같은 파일의 이벤트가 다른 파티션으로 가서 순서 보장 불가 | 탈락 |
| **userId 유지 + 파티션 수 증가** | 기존 코드 변경 없음 | 헤비 유저 문제는 파티션 수와 무관. 한 유저의 100건이 여전히 한 파티션에 집중 | 탈락 |
| **uploadId 기반 파티셔닝** | UUID 해시라 균등 분산 + 같은 파일 내 순서 보장 | 같은 사용자의 서로 다른 업로드 간 순서는 미보장 (하지만 필요 없음) | **선택** |
| **Custom Partitioner** | 특정 로직 구현 가능 | uploadId 해시만으로 충분한데 커스텀은 과잉 | 탈락 |

---

### 해결: uploadId 기반 파티셔닝

생각해보니 "같은 사용자의 모든 업로드"가 순서를 보장할 필요는 없었습니다.
순서가 필요한 건 "같은 파일의 처리 단계" 뿐입니다.
UPLOADED → CONVERTING → COMPLETED가 순서대로 실행되면 되지, 사용자의 첫 번째 녹음과 두 번째 녹음 사이에 순서가 필요한 건 아닙니다.

uploadId를 파티션 키로 바꿨습니다.
업로드마다 UUID가 다르니 해시 분포가 고르게 퍼집니다.
같은 파일의 이벤트만 같은 파티션에 들어가면서 순서도 보장됩니다.

![](/uploads/project/Orakgarak/ts-kafka-partition-imbalance/uploadid-partitioning.svg)

---

### Consumer Group 구성

각 토픽별로 독립적인 Consumer Group을 구성했습니다.

![](/uploads/project/Orakgarak/ts-kafka-partition-imbalance/consumer-group-config.svg)

#### 토픽 구성

| 토픽 | 용도 | 파티션 키 |
|------|------|----------|
| upload-events | 업로드 완료 이벤트 | uploadId |
| processing-status | 처리 상태 변경 | uploadId |
| processing-results | 처리 결과 | uploadId |
| voice-analysis-events | 음성 분석 요청 | uploadId |
| upload-events-retry | 재시도 대기 | uploadId |
| upload-events-dlq | 최종 실패 | uploadId |

모든 토픽에서 uploadId를 파티션 키로 통일했습니다.

---

### 결과

| 지표 | 개선 전 | 개선 후 |
|------|--------|--------|
| 파티션별 처리량 편차 | 10배 | 1.2배 |
| 최대 Consumer Lag | 5000 | 200 |
| 처리 완료 시간 p99 | 5분 | 1분 |
| 유휴 Consumer 비율 | 66% | 0% |

**Before**
![](/uploads/project/Orakgarak/ts-kafka-partition-imbalance/partition-distribution-before.png)

**After**
![](/uploads/project/Orakgarak/ts-kafka-partition-imbalance/section.png)

---

## 7. Loki가 스택트레이스를 못 읽었다

*원문 발행일 2025-10-19*

### 정상 상태

Spring Boot + Log4j2가 텍스트 포맷(PatternLayout)으로 로그를 stdout에 출력하고, Promtail이 이를 수집해서 Loki로 전송하는 구조였습니다.
일반 로그(단일 줄)는 정상적으로 수집되고 Grafana에서 검색이 가능했습니다.

---

### 증상

Grafana에서 `NullPointerException`을 검색하면 에러 메시지 한 줄만 나오고, 실제 스택트레이스는 보이지 않았습니다.
스택트레이스의 각 줄이 별도의 로그 엔트리로 저장되고 있었습니다.

예를 들어 이런 로그가 있으면:

```
2024-01-01 10:00:00.123 ERROR [main] c.e.Service - 처리 실패
java.lang.NullPointerException: null
    at com.example.Service.method(Service.java:10)
    at com.example.Controller.handle(Controller.java:20)
```

Promtail이 줄 단위로 파싱해서 첫 줄, 둘째 줄, 셋째 줄이 각각 별개의 로그 엔트리가 됩니다.
"NullPointerException"을 검색하면 둘째 줄만 나오는데, 그 로그에 대한 컨텍스트(어떤 서비스에서, 어떤 요청에 의해)가 전혀 없습니다.

### 원인 분석

Promtail은 기본적으로 `\n`(개행)을 로그 엔트리 경계로 인식합니다.
Java 스택트레이스는 여러 줄로 출력되니, Promtail이 각 줄을 독립된 로그 엔트리로 분리하는 건 당연한 동작입니다.

---

### 대안 검토

| 방식 | 장점 | 단점 | 판단 |
|------|------|------|------|
| **Promtail multiline stage** | 기존 텍스트 포맷 유지 | 정규표현식으로 시작 패턴을 정의해야 하고, 로그 포맷이 바뀌면 정규식도 수정 필요. 구조화 쿼리 불가 | 탈락 |
| **Log4j2 JSON 포맷 전환** | 스택트레이스가 JSON 필드 안에 이스케이프되어 자동으로 한 줄. 구조화 쿼리(level, traceId 등) 가능 | 로그 크기 증가 (JSON 메타데이터), 사람이 읽기 어려움 | **선택** |
| **Fluentd/Fluent Bit** | 멀티라인 파서 내장 | Promtail을 교체해야 함. Loki와의 호환성 유지가 목표인데 인프라 변경 과잉 | 탈락 |

multiline stage도 검토했지만, 텍스트 로그에서 정규식으로 멀티라인을 묶으면 "타임스탬프로 시작하는 줄"을 엔트리 경계로 잡아야 하는데, 로그 포맷이 바뀔 때마다 정규식을 수정해야 합니다. JSON 전환하면 멀티라인 문제가 원천적으로 사라지고, 덤으로 구조화 쿼리(level="ERROR", traceId 기반 추적)가 가능해져서 JSON을 택했습니다.

---

### 해결: Log4j2 JSON 포맷 + Promtail 파이프라인

핵심은 스택트레이스를 한 줄로 만드는 것이었습니다.
JSON 포맷으로 바꾸면 스택트레이스가 `thrown` 필드(Log4j2 JsonLayout 기준) 안에 이스케이프된 문자열로 들어가니, 전체 로그 이벤트가 한 줄의 JSON이 되어 Promtail이 하나의 엔트리로 인식합니다.

#### 1. Log4j2 JSON Layout 적용

Log4j2의 JsonLayout을 사용해서 로그를 JSON으로 출력하게 변경했습니다.

![](/uploads/project/Orakgarak/ts-loki-stacktrace-parsing/log4j2-json-layout.svg)

결과 JSON:

![](/uploads/project/Orakgarak/ts-loki-stacktrace-parsing/json-log-output.svg)

#### 2. Promtail JSON 파이프라인 설정

Promtail이 JSON을 파싱해서 level, logger 등을 Loki 레이블로 추출하도록 설정했습니다.

![](/uploads/project/Orakgarak/ts-loki-stacktrace-parsing/promtail-pipeline.svg)

#### 3. 환경별 로그 레벨 분리

운영 환경에서는 Kafka, Redis 내부 로그를 WARN 이상만 남기도록 설정했습니다.
이런 라이브러리 로그가 Loki 용량을 불필요하게 차지하는 걸 방지하기 위해서입니다.

![](/uploads/project/Orakgarak/ts-loki-stacktrace-parsing/log-level-config.svg)

#### 4. 비동기 로깅

로그 출력이 애플리케이션 스레드를 블로킹하지 않도록 AsyncLogger를 적용했습니다.

![](/uploads/project/Orakgarak/ts-loki-stacktrace-parsing/async-logging.svg)

#### 5. ERROR 로그 별도 파일 관리

![](/uploads/project/Orakgarak/ts-loki-stacktrace-parsing/error-log-management.svg)

---

### Grafana 검색 비교

**Before (텍스트 로그)**
```
{job="orakgaraki"} |= "NullPointerException"
→ 스택트레이스 없이 에러 메시지만 표시
```

**After (JSON 로그)**
```
{job="orakgaraki"} | json | level="ERROR" | line_format "{{.message}}"
→ 전체 스택트레이스 포함, 구조화 쿼리 가능
```

traceId 기반 요청 추적도 가능해졌습니다:
```
{job="orakgaraki"} | json | traceId="3fa414eac33375e9"
```

---

### 결과

| 지표 | 개선 전 | 개선 후 |
|------|--------|--------|
| 스택트레이스 검색 | 불가능 | 가능 |
| 에러 분석 시간 | 서버 SSH 접속 필요 | Grafana에서 즉시 |
| 로그 필터링 | 텍스트 매칭만 | 구조화 쿼리 |
| 요청 추적 | 수동 | traceId로 자동 추적 |

---

## 8. 알림이 하루에 100건씩 쏟아졌다

*원문 발행일 2025-10-27*

### 증상

배포하거나 서버를 재시작할 때마다 Mattermost에 수십 건의 알림이 동시에 쏟아졌습니다.
ApplicationDown, HighCPU, HighMemory, HighResponseTime이 한꺼번에 울리는데, 원인은 서버 재시작 하나였습니다.

문제는 알림 피로였습니다.
알림이 너무 자주 오니까 슬슬 무시하게 되고, 진짜 장애가 났을 때도 "또 노이즈겠지"하고 넘기는 상황이 생겼습니다.

### 원인 분석

두 가지가 겹쳤습니다.

#### 1. for 절 없이 즉시 알림

기존 알림 규칙에 `for` 절이 없었습니다.
Prometheus가 15초 간격으로 스크래핑하도록 설정(기본값은 1분이지만 빠른 감지를 위해 15초로 변경)했는데, 한 번이라도 임계값을 넘으면 바로 알림이 나갔습니다.

서버 재시작 시 CPU와 메모리가 일시적으로 튀는 건 정상입니다.
JVM 워밍업, 커넥션 풀 초기화, Kafka Consumer 리밸런싱 등이 동시에 일어납니다.
그런데 이걸 전부 장애로 인식하고 있었습니다.

#### 2. 억제 규칙이 없었다

서버가 죽으면 ApplicationDown(Critical)이 뜹니다.
그런데 서버가 죽었으니 당연히 CPU도 응답시간도 비정상이 됩니다.
HighCPU(Warning), HighResponseTime(Warning)이 같이 울립니다.
근본 원인은 하나인데 알림이 4건 나오는 구조였습니다.

---

### 해결

#### 1. for 절로 지속 시간 필터링

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

#### 2. Alertmanager 라우팅 분리

![](/uploads/project/Orakgarak/ts-prometheus-alert-noise/alertmanager-routing.svg)

Critical은 `group_wait: 10s`로 빠르게 보내고, Warning은 `group_wait: 2m`으로 모아서 보냅니다.

#### 3. 억제 규칙(Inhibit Rules)

![](/uploads/project/Orakgarak/ts-prometheus-alert-noise/inhibit-rules.svg)

ApplicationDown(Critical)이 발생하면 같은 인스턴스의 HighCPU, HighMemory, HighResponseTime(Warning)을 자동 억제합니다.

적용 전: ApplicationDown + HighCPU + HighMemory + HighResponseTime = 4건
적용 후: ApplicationDown 1건만

---

### 결과

| 지표 | 개선 전 | 개선 후 |
|------|--------|--------|
| 배포 시 알림 수 | 50~100건 | 3~5건 |
| 알림 노이즈 | 높음 | 90% 감소 |
| Critical 대응 속도 | 알림 피로로 지연 | 즉시 대응 |

---
## 9. 5주가 남긴 것

*원문 발행일 2025-09-30*

### 장애는 막는 것보다 빨리 복구하는 것

파일 업로드 파이프라인에서 처리가 멈춘 파일이 하루 10~20건 나왔습니다. Kafka consumer 에러 로그와 DB에서 PROCESSING 상태가 30분 넘게 유지되는 건을 조회해서 센 수치입니다.

처음에는 모든 예외 상황을 방어하려 했습니다. 그랬더니 방어 로직이 복잡해져서 오히려 새 버그가 생겼습니다. 방향을 바꿨습니다. 장애는 일어난다고 두고, 대신 빨리 복구하는 쪽으로 갔습니다. 12단계 상태 머신과 DLQ 패턴을 넣고 나서 멈춘 파일이 0건이 됐습니다. DLQ로 넘어간 건은 Mattermost 알림으로 받아 수동 확인하는 방식이라, 정확히는 30분 이상 PROCESSING에 머무는 건이 사라졌다는 뜻입니다.

### 문서화의 적정선

1주차에 Swagger로 완벽한 API 문서를 만들었습니다. 그런데 개발하면서 API가 계속 바뀌니 문서랑 다르다는 피드백이 끊이지 않았습니다.

2주차부터는 플로우차트로 전체 흐름만 먼저 공유하고 세부 스펙은 구현하면서 맞춰갔습니다. 그러자 다음에 뭐 하냐는 류의 질문이 거의 사라졌습니다. 완성된 문서보다 지금 어디까지 왔고 다음이 무엇인지 보이는 그림이 더 쓸모 있었습니다.

![플로우차트 기반 협업](/uploads/project/Orakgarak/retrospective/chatting-flow.png)

---

## 참고 자료

### Prometheus와 Grafana, Loki로 모니터링 세우기

- [Prometheus 공식 문서](https://prometheus.io/docs/)
- [Grafana Loki Documentation](https://grafana.com/docs/loki/latest/)
- [Alertmanager Configuration](https://prometheus.io/docs/alerting/latest/configuration/)
- [AWS CloudWatch Pricing](https://aws.amazon.com/cloudwatch/pricing/)
- [Elasticsearch Hardware Requirements - Opster](https://opster.com/guides/elasticsearch/capacity-planning/elasticsearch-minimum-requirements/)

### 다중 FilterChain으로 경로별 인증 분리

- [Spring Security Multiple HttpSecurity](https://docs.spring.io/spring-security/reference/servlet/configuration/java.html#_multiple_httpsecurity)
- [Spring Security Architecture](https://docs.spring.io/spring-security/reference/servlet/architecture.html)

### Presigned URL과 EventBridge로 업로드 받기

- [Spring Boot에서 S3에 파일을 업로드하는 세 가지 방법 - 우아한형제들](https://techblog.woowahan.com/11392/)
- [S3 Uploads - Proxies vs Presigned URLs vs Presigned POSTs](https://zaccharles.medium.com/s3-uploads-proxies-vs-presigned-urls-vs-presigned-posts-9661e2b37932)
- [Comparing Two Ways to Trigger Lambda from S3](https://eoins.medium.com/comparing-two-ways-to-trigger-lambda-from-s3-b5da8cfe1aee)

### Kafka 이벤트 드리븐 파일 처리 파이프라인

- [Kafka 공식 문서 - Design](https://kafka.apache.org/documentation/#design)
- [Spring Kafka Reference](https://docs.spring.io/spring-kafka/reference/)
- [RabbitMQ Reliability Guide](https://www.rabbitmq.com/docs/reliability)
- [AWS SQS FIFO High Throughput](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/high-throughput-fifo.html)

### 동시 요청에 GPU가 OOM으로 죽었다

- [Java Semaphore - Oracle Docs](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/util/concurrent/Semaphore.html)
- [Bulkhead Pattern - Microsoft Azure](https://learn.microsoft.com/en-us/azure/architecture/patterns/bulkhead)

### Kafka 파티션 불균형으로 처리가 밀렸다

- [Kafka Partitioner 공식 문서](https://kafka.apache.org/documentation/#producerconfigs_partitioner.class)
- [Kafka Consumer Group](https://kafka.apache.org/documentation/#consumerconfigs)

### Loki가 스택트레이스를 못 읽었다

- [Log4j2 JSON Layout](https://logging.apache.org/log4j/2.x/manual/layouts.html#JSONLayout)
- [Promtail Pipeline Stages](https://grafana.com/docs/loki/latest/clients/promtail/stages/)
- [Loki LogQL](https://grafana.com/docs/loki/latest/logql/)

### 알림이 하루에 100건씩 쏟아졌다

- [Prometheus Alerting Rules](https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/)

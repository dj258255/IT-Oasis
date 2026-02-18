---
title: '오락가락 - 음성 분석 파이프라인과 모니터링의 세계'
titleEn: 'Orakgarak - Voice Analysis Pipeline and the World of Monitoring'
description: 음성 기반 노래 추천 플랫폼 오락가락을 5주간 개발하며 Kafka 파이프라인, GPU OOM 방어, Prometheus+Grafana 모니터링을 구축한 이야기입니다.
descriptionEn: A retrospective on building Orakgarak, a voice-based song recommendation platform, covering Kafka pipelines, GPU OOM defense, and Prometheus+Grafana monitoring.
date: 2025-09-30
tags:
  - Retrospective
  - Spring Boot
  - Kafka
  - Prometheus
  - Grafana
  - AWS S3
category: 프로젝트/오락가락
coverImage: /uploads/프로젝트/오락가락/retrospective/title.png
draft: false
---

## 프로젝트 소개

오락가락은 **내 목소리 데이터를 기반으로 노래를 추천해주는 플랫폼**입니다. 노래방에서 "뭐 부르지?" 고민하는 상황, 팀원 6명 중 5명이 비슷한 경험이 있었습니다. 일반적인 음악 추천은 "청취 기록" 기반이지만, 내가 좋아하는 노래와 내가 잘 부를 수 있는 노래는 다릅니다. 사용자가 노래를 부르면 AI가 음역대와 음색을 분석해서, 비슷한 음역대의 인기 곡을 추천합니다.

![오락가락 아키텍처](/uploads/프로젝트/오락가락/retrospective/architecture.png)

**기간**: 2025.08.26 - 2025.09.30 (5주)
**팀 구성**: 6명 (프론트엔드 2명, 백엔드 3명, AI 1명)
**기술 스택**: Java, Spring Boot, Kafka, AWS S3, Prometheus, Grafana, Loki, Docker

---

## 내 역할

백엔드(33%) + 인프라(50%)를 담당했습니다. **파일 업로드 시스템**, **앨범/녹음 관리**, 그리고 **모니터링 인프라** 전체를 맡았습니다.

이 프로젝트에서 처음으로 **이벤트 드리븐 아키텍처**와 **모니터링 시스템**을 실무 수준으로 구축해봤습니다.

---

## 주요 구현

### 파일 업로드 시스템 (Presigned URL + EventBridge)

서버를 경유해서 파일을 올리면 100MB 파일 기준으로 서버 메모리를 점유하고 대역폭을 2배 소모합니다. **Presigned URL**로 클라이언트가 S3에 직접 업로드하게 해서 서버 부하를 제거했습니다. S3 이벤트를 EventBridge를 통해 Kafka로 전달하는 이벤트 드리븐 파이프라인을 설계했고, **12단계 상태 머신**으로 파일이 어디서 실패했는지 즉시 파악할 수 있게 했습니다.

![업로드 아키텍처](/uploads/프로젝트/오락가락/retrospective/upload-architecture.png)

> 상세 분석: [Presigned URL + EventBridge 업로드](/blog/프로젝트/오락가락/presigned-url-eventbridge-upload) · [Kafka 이벤트 드리븐 파이프라인](/blog/프로젝트/오락가락/kafka-event-driven-pipeline)

### GPU OOM 3단계 방어 전략

음성 분석 모델 하나당 GPU 메모리 2-3GB를 사용하는데, 8GB GPU에서 3개 이상 동시 실행하면 OOM이 발생합니다. **3중 방어**를 적용했습니다:
1. **Kafka 큐**로 요청 버퍼링 (AI 서버가 pull 방식으로 처리)
2. `Semaphore(permits=2)`로 동시 실행 제한
3. **파일 100MB 제한**으로 단일 요청 메모리 상한

3주 운영 기간 동안 **OOM 0회**를 달성했습니다.

> 상세 분석: [GPU OOM 방어 전략](/blog/프로젝트/오락가락/ts-gpu-oom-concurrent-requests)

### 모니터링 인프라 (Prometheus + Grafana + Loki)

장애가 발생한 후 로그를 grep하면 MTTR(복구 시간)이 길어집니다. **선제적 모니터링**으로 장애 징후를 미리 감지하고 싶었습니다. Prometheus 6개 Exporter, Grafana 대시보드, Loki JSON 로그, 29개 Alert 규칙을 구축해서 **장애 감지 30초 이내**를 달성했습니다.

![Grafana 대시보드](/uploads/프로젝트/오락가락/retrospective/grafana.png)

> 상세 분석: [Prometheus+Grafana+Loki 모니터링](/blog/프로젝트/오락가락/prometheus-grafana-loki-monitoring)

---

## 기억에 남는 트러블슈팅

### Prometheus 알림 폭풍

서버를 재시작하면 메트릭이 일시적으로 0이 되면서 수백 건의 Mattermost 알림이 동시에 쏟아졌습니다. 진짜 장애와 일시적 스파이크를 구분할 수 없으니 **알림 피로(Alert Fatigue)**가 심각했습니다.

`for`절로 지속 시간 필터링(Critical 1분, Warning 5분)을 적용하고, `inhibit_rules`로 상위 알림 발생 시 하위 알림을 억제했습니다. 알림 노이즈가 **일 50건에서 5건으로 90% 감소**했습니다.

> 상세 분석: [알림 폭풍 해결](/blog/프로젝트/오락가락/ts-prometheus-alert-noise)

### Loki 스택트레이스 파싱 실패

Promtail이 줄 단위로 로그를 파싱해서 Exception 스택트레이스가 10~20개 별도 로그로 분리되는 문제가 있었습니다. Grafana에서 "NullPointerException"을 검색해도 첫 줄만 나오고 원인 코드는 찾을 수 없었습니다.

Log4j2 JSON 포맷으로 변경해서 스택트레이스를 단일 필드에 포함시키고, traceId로 요청 추적이 가능하게 만들었습니다.

> 상세 분석: [Loki 스택트레이스 파싱](/blog/프로젝트/오락가락/ts-loki-stacktrace-parsing)

### Kafka 파티션 불균형

userId 기반 파티셔닝을 적용했더니 헤비 유저의 이벤트가 한 파티션에 집중되어, 3개 파티션 중 1개가 전체 메시지의 70%를 처리하고 나머지 2개는 놀고 있었습니다.

**uploadId 기반 파티셔닝**으로 변경하니 같은 파일의 이벤트만 같은 파티션에서 순서가 보장되고, 서로 다른 파일은 균등 분산됐습니다. 편차가 **10배에서 1.2배로 개선**됐습니다.

> 상세 분석: [Kafka 파티션 불균형](/blog/프로젝트/오락가락/ts-kafka-partition-imbalance)

---

## 느낀 점

### 장애는 예방보다 복구가 중요하다

파일 업로드 파이프라인에서 "Stuck 파일"(처리가 멈춘 파일)이 일 10-20건 발생했습니다. 모든 예외 상황을 방어하려 했더니 방어 로직이 복잡해져서 오히려 새 버그가 생겼습니다. **12단계 상태 머신 + DLQ 패턴**으로 "장애는 발생한다, 대신 빨리 복구한다"는 방향으로 전환하니 Stuck 파일이 0건이 됐습니다.

### 문서화의 적정선

1주차에 Swagger로 완벽한 API 문서를 만들었지만, 개발하면서 API가 계속 바뀌면서 "문서랑 다른데요?" 피드백이 끊이지 않았습니다. 2주차부터 **플로우차트로 전체 흐름만 먼저 공유**하고 세부 스펙은 구현하면서 맞춰가니, "다음에 뭐 해요?" 류의 질문이 거의 사라졌습니다.

![플로우차트 기반 협업](/uploads/프로젝트/오락가락/retrospective/chatting-flow.png)

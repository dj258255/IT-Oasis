---
title: '오락가락: 목소리로 부를 노래를 추천하는 음성 분석 플랫폼'
description: '오락가락은 사용자의 음성을 분석해 음역대와 음색에 맞는 노래를 추천하고, 녹음을 모아 앨범도 만드는 음성 기반 음악 플랫폼이다. SSAFY 6인 팀이 5주 동안 만든 과정과 역할 분담을 다룬다.'
date: 2025-10-01
tags:
  - Orakgarak
  - Team Project
  - SSAFY
  - Spring Boot
  - React
  - FastAPI
  - Kafka
  - AWS S3
  - Prometheus
  - Grafana
category: team/Orakgarak
coverImage: /uploads/project/Orakgarak/retrospective/title.png
draft: false
---

오락가락은 **목소리를 분석해서 부를 노래를 추천하는 음성 기반 음악 플랫폼**입니다. 마이크로 노래를 부르면 음역대와 음색을 분석해서 비슷한 음역대의 인기 곡을 추천합니다. 녹음한 곡을 모아 앨범을 만듭니다. 다른 사용자와 공유할 수도 있습니다.

![오락가락 서비스 소개 이미지. 목소리에 맞는 노래를 찾고 공유한다는 문구와 앨범 재생, 음역대 찾기, 피드 공유 기능이 나열되어 있습니다](/uploads/project/Orakgarak/retrospective/title.png)

## 한눈에 보기

| 항목 | 내용 |
|---|---|
| 한 줄 소개 | 목소리의 음역대와 음색을 분석해 부를 노래를 추천하고 녹음으로 앨범을 만드는 음악 플랫폼 |
| 기간 | 2025.08.26 ~ 2025.09.30 (5주, SSAFY 13기) |
| 팀 | 6명 (프론트엔드 2, 백엔드 3, AI 1) |
| 내 역할 | 백엔드 33%, 인프라 50%. 파일 업로드, 앨범과 녹음 관리, 모니터링 인프라 전체 |
| 기술 | Java, Spring Boot, React, TypeScript, FastAPI, Kafka, MySQL, Redis, AWS S3, Prometheus, Grafana, Loki, Docker |
| 서비스 | SSAFY 제공 도메인(j13c103.p.ssafy.io)에 배포했습니다. 교육 과정이 끝난 뒤로는 운영하지 않습니다 |
| 코드 | [github.com/dj258255/orakgarak](https://github.com/dj258255/orakgarak) |

## 왜 만들었나

노래방에서 뭘 부를지 고민하는 상황을 팀원 6명 중 5명이 겪어봤다는 데서 시작했습니다. 일반적인 음악 추천은 청취 기록을 봅니다. 그런데 내가 좋아하는 노래와 내가 잘 부를 수 있는 노래는 다릅니다. 오락가락은 좋아하는 노래 대신 부를 수 있는 노래를 추천하는 쪽으로 방향을 잡았습니다.

## 누구를 위한 서비스인가

| 쓰는 사람 | 이 사람이 하는 일 |
|---|---|
| 노래방에서 부를 노래를 못 정하는 사람 | 목소리를 녹음하면 음역대와 음색에 맞는 인기곡을 추천받습니다 |
| 자기 목소리로 앨범을 만들고 싶은 사람 | 녹음한 트랙을 모아 앨범을 만들고 커버를 지정해 3D 캐러셀로 감상합니다 |
| 다른 사용자와 소통하고 싶은 사람 | 피드에서 앨범을 공유하고 좋아요와 댓글, 팔로우로 반응합니다 |

## 주요 기능

### 1. 음성 분석과 노래 추천

마이크로 부른 노래는 FastAPI 서버가 멜스펙트로그램에서 MFCC(13차원 음색 계수)와 최저·최고·평균 음정을 뽑습니다. 곡 쪽도 같은 방식으로 특징을 미리 뽑아 둡니다. 두 값을 StandardScaler로 같은 스케일로 맞춘 뒤 코사인 유사도로 가장 비슷한 곡을 고릅니다. 플레이리스트 등장 횟수와 좋아요, 유튜브 조회수로 산출한 인기도가 기준치를 넘는 곡만 후보에 남깁니다. 후보가 없으면 인기도 조건만 적용해서 상위 10곡을 추천합니다. Kafka에서 Pinecone 벡터 검색까지 연결은 해 두었습니다. 다만 실제 추천은 이 코사인 유사도 경로로 나갑니다.

### 2. 앨범 제작과 재생

녹음한 트랙을 모아 앨범을 만듭니다. 트랙은 앨범 하나에 최대 10개까지 담을 수 있습니다. 커버 이미지도 지정합니다. 재생 화면은 CSS Transform 기반 3D 캐러셀로 만들어서 드래그와 터치, 키보드로 넘겨 볼 수 있습니다.

### 3. 커뮤니티

피드에서 다른 사용자의 앨범을 보고 좋아요와 댓글을 남깁니다. 팔로우로 관심 있는 사용자의 새 앨범을 챙겨 봅니다.

### 4. 파일 업로드 파이프라인

사용자가 브라우저에서 녹음하면 WebM 파일이 나옵니다. Presigned URL로 S3에 직접 올립니다. 업로드가 끝나면 S3의 ObjectCreated 이벤트가 EventBridge를 거쳐 백엔드로 들어옵니다. 서버는 파일 데이터를 직접 만지지 않고 URL 발급과 이벤트 처리만 합니다. 여기서 FFmpeg로 WAV 변환을 하고 Kafka로 AI 분석 요청을 넘깁니다. 업로드 상태는 PENDING에서 CONVERTING, ANALYZING을 거쳐 COMPLETED나 FAILED로 바뀝니다. 프론트는 이 상태를 3초마다 폴링해서 진행 상황을 보여줍니다.

![Presigned URL 업로드부터 EventBridge로 이벤트가 전달되는 흐름. S3에 올라간 파일이 EventBridge Rule과 API Destination을 거쳐 백엔드로 전달됩니다](/uploads/project/Orakgarak/retrospective/upload-architecture.png)

### 5. 운영 모니터링

메트릭은 Prometheus, 로그는 Loki, 화면은 Grafana로 묶었습니다. Spring Actuator와 Node Exporter, cAdvisor, MySQL Exporter, Redis Exporter, Kafka Exporter 여섯 종으로 애플리케이션과 서버, 컨테이너, DB, Kafka를 모두 걷어 올립니다. Alertmanager 규칙 29개를 정의해서 이상이 생기면 Mattermost 웹훅으로 알립니다.

## 구조

저장소는 백엔드와 프론트엔드, AI 서버를 한 곳에 담은 모노레포입니다.

| 폴더 | 역할 |
|---|---|
| `back/` | Spring Boot 3.5, Java 17. API, 파일 업로드, 앨범과 녹음 관리, 모니터링 연동 |
| `front/` | React 18, TypeScript, Vite. 랜딩, 녹음, 앨범, 피드, 마이페이지 |
| `python/` | FastAPI. 음성 특징 추출과 노래 추천 |

운영 환경은 Docker Compose로 단일 EC2 서버에 Spring Boot와 MySQL, Redis, Kafka, Prometheus, Grafana, Loki를 함께 올렸습니다. CI/CD는 GitLab에 올린 코드를 Jenkins가 받아 빌드하고 배포합니다.

![오락가락 전체 아키텍처. GitLab과 Jenkins로 이어지는 배포 흐름, Presigned URL과 EventBridge를 거치는 업로드 경로, Prometheus·Grafana·Loki 모니터링 스택, Kafka와 FastAPI로 이어지는 AI 분석 경로가 한 그림에 있습니다](/uploads/project/Orakgarak/retrospective/architecture.png)

## 내가 한 일

백엔드에서는 파일 업로드 시스템과 앨범, 녹음 관리를 맡았습니다. Presigned URL 발급 API를 만들고 업로드 레코드의 상태를 관리했습니다. EventBridge 웹훅으로 업로드 완료 이벤트를 받아 FFmpeg로 WAV 변환을 실행했습니다. 앨범과 녹음의 CRUD, 앨범과 트랙을 잇는 매핑 API도 만들었습니다.

인프라는 모니터링 전체를 맡았습니다. Prometheus와 Grafana, Loki 스택을 구성하고 Exporter 여섯 종을 연동했습니다. Alertmanager 규칙과 Mattermost 웹훅 알림, Kafka 소비자의 DLQ와 재시도 처리, 로그를 텍스트에서 JSON 포맷으로 바꾸는 작업까지 했습니다.

이 과정에서 정답이 하나로 정해지지 않는 선택이 몇 번 있었습니다.

**이벤트 파이프라인을 무엇으로 만들 것인가.** 같은 JVM에서 도는 `BlockingQueue`는 배포할 때마다 처리 중인 작업이 날아간다는 문제가 있었습니다. RabbitMQ는 소비자가 ack하면 큐에서 지워져서 장애가 났을 때 원본 이벤트를 다시 볼 수 없었습니다. SQS FIFO는 관리형이라 매력적이었지만 여기도 소비 후 삭제라 되감기가 안 됐습니다. 결국 Kafka로 정했습니다. 오프셋을 유지하는 동안 언제든 재처리할 수 있습니다. Spring Boot와 FastAPI가 같은 토픽을 주고받는 구조도 깔끔했습니다. 다만 이 선택에는 비용이 있었습니다. 지금 트래픽만 보면 SQS FIFO로도 충분했습니다. Kafka 브로커는 별도 EC2 비용은 없지만 메모리와 디스크를 계속 먹습니다. Kafka를 고른 이유 중 하나는 이벤트 드리븐 파이프라인 경험을 쌓고 싶었던 것도 있었습니다. 맞는 판단이었다고 생각하지만 과잉일 수 있다는 점도 같이 적어 둡니다.

**WAV 변환을 어디서 할 것인가.** Presigned URL로 서버를 거치지 않고 S3에 바로 올리기로 정한 뒤, WAV 변환을 프론트에서 할지 백엔드에서 할지가 남았습니다. 프론트에서 변환하면 비압축 WAV가 50MB까지 늘어나서 모바일에 부담이 큽니다. 변환 중 실패하면 사용자가 다시 녹음해야 합니다. 백엔드에서 변환하면 S3에 원본이 남아 있어서 실패해도 재시도할 수 있습니다. FFmpeg로 샘플레이트와 비트뎁스도 더 정밀하게 다룰 수 있습니다. 그래서 원본 WebM을 S3로 직접 올리고 백엔드에서 변환하는 쪽으로 정했습니다.

**모니터링 스택을 무엇으로 세울 것인가.** CloudWatch는 관리형이라 손이 덜 가지만 커스텀 메트릭에 건당 비용이 붙습니다. Kafka Consumer Lag처럼 우리가 꼭 봐야 하는 값을 붙이는 속도도 느렸습니다. 로그는 ELK 대신 Loki를 골랐습니다. Elasticsearch는 로그 본문을 전문 색인해서 메모리를 많이 씁니다. 단일 서버에 Kafka와 MySQL, Redis가 이미 올라간 상태에서 그만큼을 더 얹을 수 없었습니다. Prometheus와 Loki를 고른 대신 단일 서버 구성의 한계도 그대로 남았습니다. 모니터링 스택이 감시 대상과 같은 서버에 있어서 서버가 통째로 죽으면 알림도 같이 죽습니다.

## 일정과 작업 방식

팀은 GitLab 이슈와 MR로 작업을 관리했습니다. 저장소에 이슈 템플릿(`FEAT_ISSUE.md`)과 MR 템플릿이 남아 있습니다. 이슈 번호를 문 브랜치(`feature/#3-fileupload`)도 있었습니다. 실제로는 `Feature/album`, `Feature/record`처럼 설명형 이름을 쓴 브랜치가 더 많았습니다.

실제 커밋 이력(`git log`, 전체 702커밋, 2025-08-25 ~ 2025-09-29)을 주 단위로 보면 갈수록 커밋이 늘었습니다.

| 주차 | 기간 | 커밋 수 | 그 주에 한 일 |
|---|---|---:|---|
| 1주차 | 08.25 ~ 09.01 | 7 | 저장소와 Docker Compose, 폴더 구조 준비 |
| 2주차 | 09.02 ~ 09.08 | 9 | Spring Boot와 React 초기 세팅, 멜스펙트로그램 추출 구현 |
| 3주차 | 09.09 ~ 09.15 | 139 | 파일 업로드, 녹음, 앨범, 마이페이지 등 핵심 기능 |
| 4주차 | 09.16 ~ 09.22 | 226 | 기능 이어 붙이기와 통합 |
| 5주차 | 09.23 ~ 09.29 | 259 | 모니터링, Kafka 이벤트 파이프라인, 마무리 수정 |

작업은 폴더를 기준으로 나뉘었습니다. `back/`은 백엔드 3명, `front/`는 프론트엔드 2명, `python/`은 AI 1명이 주로 손을 댔습니다. 제 커밋은 09.08 ~ 09.12(파일 업로드, Presigned URL)와 09.22 ~ 09.28(모니터링, Kafka DLQ, 시큐리티) 두 구간에 몰려 있습니다. 그 사이에는 앨범과 녹음 API 같은 다른 백엔드 작업을 했습니다.

문서화 방식은 실제로 한 번 바뀌었습니다. 1주차에 Swagger로 API 문서를 빠짐없이 만들었습니다. 그런데 개발하면서 API가 계속 바뀌니 문서와 다르다는 얘기가 나왔습니다. 2주차부터는 플로우차트로 전체 흐름만 먼저 공유하고 세부 스펙은 구현하면서 맞춰갔습니다. 그러자 다음에 뭘 하냐는 질문이 줄었습니다.

![플로우차트로 전체 흐름을 먼저 공유하고 세부는 구현하며 맞춰 간 협업 방식](/uploads/project/Orakgarak/retrospective/chatting-flow.png)

## 직접 재 본 결과

| 확인한 것 | 전 | 후 |
|---|---:|---:|
| 업로드 API 응답 시간(동기 처리를 비동기로 바꾼 뒤, Presigned URL 발급 기준) | 5~30초 | 200ms |
| AI 서버 OOM 발생(Grafana 컨테이너 재시작 횟수, 하루 기준) | 5~10회 | 0회 |
| Kafka 파티션별 처리량 편차(Kafka Exporter로 측정한 Consumer Lag 기준) | 10배 | 1.2배 |
| 배포나 재시작 시 Mattermost 알림 건수 | 50~100건 | 3~5건 |

## 아직 못 한 것

- 외부에서 서비스를 찔러보는 감시는 넣지 못했습니다. 모니터링 스택이 감시 대상과 같은 서버에 있어서 서버가 통째로 죽으면 알림도 같이 죽는 구조입니다.
- Kafka에서 Pinecone까지 연결은 해 두었지만 실제 추천은 코사인 유사도 경로로 나갑니다. Spark나 Flink로 확장하는 것도 구현하지 않았습니다.
- Webhook 엔드포인트에는 HMAC 서명 검증을 넣지 않았습니다. Security Group과 HTTPS, 이벤트 구조 검증으로만 보호합니다.
- 실사용자 트래픽은 없습니다. SSAFY 교육 기간에 j13c103.p.ssafy.io로 배포했습니다. 과정이 끝난 뒤로는 운영하지 않습니다.

## 더 보기

- 코드: [GitHub 저장소](https://github.com/dj258255/orakgarak)
- 추천 로직 상세: [python/README.md](https://github.com/dj258255/orakgarak/blob/master/python/README.md)

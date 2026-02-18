---
title: 'Presigned URL + EventBridge 기반 파일 업로드 아키텍처'
titleEn: 'File Upload Architecture with Presigned URL and EventBridge'
description: 서버를 거치는 업로드 방식이 OOM과 이중 전송 문제를 일으킨다는 걸 파악하고, Presigned URL로 S3 직접 업로드 + EventBridge로 완료 감지하는 구조로 전환한 과정을 정리한다.
descriptionEn: Documents migrating from server-proxied uploads (causing OOM and double transfer) to S3 direct upload via Presigned URL with EventBridge completion detection.
date: 2025-09-17T00:00:00.000Z
tags:
  - AWS S3
  - Presigned URL
  - EventBridge
  - File Upload
  - Architecture
category: 프로젝트/오락가락
draft: false
---

## 한 줄 요약

서버를 거치는 업로드 방식이 OOM과 이중 전송 문제를 일으킨다는 걸 파악하고, Presigned URL로 S3 직접 업로드 + EventBridge로 완료 감지하는 구조로 전환했다.

---

## 배경

오락가락은 사용자의 음성을 분석해 음악을 추천하는 서비스다. 사용자가 브라우저에서 녹음한 음성 파일을 서버에 올리고, 이걸 WAV로 변환한 뒤 AI 서버가 분석한다.

처음 설계할 때는 "Presigned URL로 S3에 바로 올리면 되겠다"고 생각했다. 그런데 AI 분석 담당 팀원이 "추론 서버가 WAV 포맷만 처리할 수 있다"고 했다. 브라우저 녹음은 WebM으로 나오니까, 어딘가에서 WAV 변환이 필요했다.

그래서 처음엔 파일을 서버로 받아서 변환 후 S3에 저장하는 방식으로 갔다. 동작은 했지만, 여기서 문제가 터졌다.

---

## 서버 업로드 방식의 문제

### OOM 위험

서버 업로드는 파일 전체를 메모리에 올린다. Spring Boot의 `MultipartFile`이 기본적으로 파일을 메모리에 버퍼링하기 때문이다.

음성 파일 하나가 대략 30-50MB였다. 동시 업로드가 10건만 겹쳐도 500MB가 순간 점유되고, 여기에 GC 압박까지 더해지면 응답 지연이 시작된다. 동시 20건이면 1GB를 넘기면서 OOM 가능성이 현실적인 수치가 된다.

### 이중 네트워크 전송

![](/uploads/presigned-url-eventbridge-upload/double-handling-network-cost.png)

파일이 네트워크를 두 번 탄다. 클라이언트에서 서버로 한 번, 서버에서 S3로 한 번. 업로드 시간이 두 배고, 서버-S3 구간에서 실패하면 클라이언트부터 다시 보내야 한다.

### 서버 상태에 종속

서버가 다운되면 업로드도 불가능하다. 배포 중에도 업로드가 끊긴다. 서버를 수평 확장해도 각 서버가 파일을 버퍼링해야 하니, 스케일아웃의 이점이 상쇄된다.

---

## WAV 변환을 어디서 할 것인가

Presigned URL을 쓰기로 결정하면, 서버가 파일을 직접 받지 않으니 변환 시점이 달라진다. 프론트엔드에서 변환할지, 백엔드에서 변환할지 선택해야 했다.

프론트엔드 변환의 문제는 용량이었다. WebM은 압축 포맷이라 5MB 정도인데, WAV는 비압축이라 50MB까지 늘어난다. 모바일에서 50MB 업로드는 사용성이 나빠진다.

실패 복구도 다르다. 프론트에서 변환 중 실패하면 사용자가 다시 녹음해야 한다. 백엔드에서 변환에 실패하면 S3에 원본이 남아있으니 재시도가 가능하다.

변환 품질도 백엔드가 유리했다. FFmpeg로 샘플레이트와 비트뎁스를 정밀하게 제어할 수 있다. 브라우저의 Web Audio API는 이 부분에서 제약이 있다.

결론: 원본(WebM)을 S3에 직접 업로드하고, 백엔드에서 FFmpeg로 변환하는 방식을 택했다.

---

## 최종 아키텍처

![](/uploads/presigned-url-eventbridge-upload/event-driven-architecture.png)

### 전체 플로우

![](/uploads/presigned-url-eventbridge-upload/full-flow-diagram.png)

1. 클라이언트가 Presigned URL 발급 요청
2. 서버가 DB에 Upload 레코드(PENDING) 생성 + S3 Presigned URL 발급
3. 클라이언트가 S3에 직접 업로드
4. S3 ObjectCreated 이벤트 → EventBridge → Spring Boot 핸들러
5. WAV 변환 → AI 분석 → 완료

### 상태 흐름

![](/uploads/presigned-url-eventbridge-upload/state-flow-diagram.png)

---

## 왜 클라이언트 콜백이 아닌 서버 이벤트인가

처음에는 "S3 업로드 후 클라이언트가 완료 API를 호출하면 되지 않나?"라고 생각했다.

세 가지가 문제였다. 브라우저를 닫으면 완료 처리가 안 된다. 네트워크 오류 시 DB와 S3 상태가 어긋난다. 업로드 없이 완료 API를 호출하는 악의적 요청도 가능하다.

S3 이벤트 기반이면 실제로 파일이 올라왔을 때만 트리거된다. 서버 상태와 무관하게 동작하고, 신뢰성이 보장된다.

---

## 왜 S3 Lambda Trigger가 아닌 EventBridge인가

S3 이벤트를 받는 방법은 두 가지가 있다. S3 Event Notification(Lambda)과 EventBridge다.

S3 Event Notification은 버킷에 직접 설정한다. 간단하지만, 같은 prefix에 Lambda 하나만 연결할 수 있다. 타겟을 추가하려면 버킷 설정을 고쳐야 한다. 한 번 실패하면 복구도 어렵다.

EventBridge는 S3 버킷 설정과 이벤트 처리 로직이 분리된다. 같은 이벤트를 Kafka, Step Functions 등 여러 서비스로 라우팅할 수 있고, 이벤트 아카이브에서 재생도 가능하다. 새로운 처리 로직을 추가할 때 버킷 설정을 건드릴 필요가 없다.

느슨한 결합과 확장성에서 EventBridge가 명확하게 나았다.

---

## 고아 파일(Orphan Files) 처리

Presigned URL 방식에서 피할 수 없는 문제가 고아 파일이다.

발생 시나리오는 세 가지다.
- Presigned URL을 발급받고 업로드하지 않으면 DB에 PENDING 레코드만 남는다.
- 업로드는 성공했는데 EventBridge가 실패하면 S3에 파일만 있고 DB는 PENDING이다.
- WAV 변환 중 서버가 크래시하면 S3에 WebM과 WAV가 둘 다 있을 수 있다.

이걸 DB 상태 기반 배치 스캔으로 자동 정리한다.

| 유형 | 감지 방법 | 처리 |
|------|----------|------|
| DB 고아 (PENDING 24시간 이상) | 배치 스캔 | EXPIRED 처리 |
| S3 고아 (FAILED/EXPIRED 14일 이상) | DB 상태 기반 스캔 | S3 파일 + DB 레코드 삭제 |
| 처리 중단 (Stuck 30분 이상) | 배치 스캔 | Kafka 재발행 또는 DLQ |

![](/uploads/presigned-url-eventbridge-upload/orphan-file-batch-scan.svg)

![](/uploads/presigned-url-eventbridge-upload/orphan-file-cleanup-flow.svg)

---

## 구현 핵심

### Presigned URL 발급

![](/uploads/presigned-url-eventbridge-upload/presigned-url-issue-flow.svg)

URL 발급 시 DB에 Upload 레코드를 먼저 만든다. S3 이벤트가 올 때 "누구의 어떤 파일인지" 알아야 하기 때문이다. S3 키에 UUID를 포함시키고(`recordings/{uuid}_{filename}`), EventBridge 이벤트에서 UUID를 추출해 레코드를 조회한다.

### S3 이벤트 핸들러

![](/uploads/presigned-url-eventbridge-upload/s3-event-handler.svg)

---

## 솔직한 평가

Presigned URL 방식도 완벽하지 않다.

업로드 전에 파일을 검증할 수 없다는 게 가장 큰 단점이다. 서버를 거치면 파일 포맷, 크기, 악성코드 등을 업로드 전에 체크할 수 있지만, S3 직접 업로드에서는 올라온 뒤에야 확인 가능하다.

구현 복잡도도 올라간다. Presigned URL 발급, EventBridge 설정, 고아 파일 처리 배치잡까지 관리 포인트가 늘어난다. 클라이언트에서 S3로 직접 보내니 디버깅도 어렵다.

다만 우리 서비스에서는 음성 파일 특성상 업로드 전 검증이 크게 필요 없었고, OOM 방지가 더 중요했다. 그래서 이 트레이드오프를 감수했다.

---

## 참고 자료

- [Spring Boot에서 S3에 파일을 업로드하는 세 가지 방법 - 우아한형제들](https://techblog.woowahan.com/11392/)
- [S3 Uploads - Proxies vs Presigned URLs vs Presigned POSTs](https://zaccharles.medium.com/s3-uploads-proxies-vs-presigned-urls-vs-presigned-posts-9661e2b37932)
- [Comparing Two Ways to Trigger Lambda from S3](https://eoins.medium.com/comparing-two-ways-to-trigger-lambda-from-s3-b5da8cfe1aee)

<!-- EN -->

## Summary

Identified OOM risks and double network transfer in server-proxied uploads, then migrated to S3 direct upload via Presigned URL with EventBridge for completion detection.

---

## Background

Orak is a service that analyzes users' voices to recommend music. Users record voice in the browser, upload it to the server, convert to WAV, then the AI server analyzes it.

Initially planned to use Presigned URLs for direct S3 upload, but the AI team's inference server only handles WAV format. Browser recordings come as WebM, so WAV conversion was needed somewhere.

The first approach was receiving files on the server, converting, then storing in S3. It worked, but problems emerged.

---

## Problems with Server Upload

### OOM Risk

Server uploads load entire files into memory. Spring Boot's `MultipartFile` buffers files in memory by default. Audio files were 30-50MB each. 10 concurrent uploads means 500MB of instant memory pressure; 20 concurrent uploads crosses 1GB with realistic OOM risk.

### Double Network Transfer

![](/uploads/presigned-url-eventbridge-upload/double-handling-network-cost.png)

Files traverse the network twice: client to server, then server to S3. Upload time doubles, and server-to-S3 failures require retransmission from the client.

### Server Dependency

Server downtime means no uploads. Deployments interrupt uploads. Horizontal scaling is undermined since each server must buffer files.

---

## Where to Convert WAV

With Presigned URLs, the server doesn't receive files directly, changing when conversion happens.

Frontend conversion has a size problem: WebM is ~5MB compressed, WAV expands to ~50MB uncompressed. Uploading 50MB on mobile degrades UX. Failure recovery also differs: frontend failure requires re-recording, while backend failure allows retry since the original remains in S3. FFmpeg on the backend also offers precise sample rate and bit depth control.

Decision: upload original WebM directly to S3, convert with FFmpeg on the backend.

---

## Final Architecture

![](/uploads/presigned-url-eventbridge-upload/event-driven-architecture.png)

### Full Flow

![](/uploads/presigned-url-eventbridge-upload/full-flow-diagram.png)

1. Client requests Presigned URL
2. Server creates Upload record (PENDING) in DB + issues S3 Presigned URL
3. Client uploads directly to S3
4. S3 ObjectCreated event → EventBridge → Spring Boot handler
5. WAV conversion → AI analysis → Complete

### State Flow

![](/uploads/presigned-url-eventbridge-upload/state-flow-diagram.png)

---

## Why Server Events, Not Client Callbacks

Initially considered having the client call a completion API after S3 upload.

Three problems: closing the browser skips completion processing; network errors desync DB and S3 state; malicious requests can call the completion API without uploading.

S3 event-based triggers only fire when files actually arrive, working independently of server state with guaranteed reliability.

---

## Why EventBridge, Not S3 Lambda Trigger

S3 Event Notification is configured directly on the bucket. Simple, but only one Lambda per prefix. Adding targets requires modifying bucket settings. Recovery from failures is difficult.

EventBridge decouples bucket configuration from event processing logic. The same event can route to Kafka, Step Functions, and more. Event archives enable replay. New processing logic doesn't require touching bucket settings.

EventBridge was clearly superior for loose coupling and extensibility.

---

## Orphan File Handling

Orphan files are unavoidable with Presigned URLs.

Three scenarios: URL issued but never uploaded (PENDING record remains), upload succeeds but EventBridge fails (file in S3, DB still PENDING), server crashes during WAV conversion (both WebM and WAV in S3).

Automated cleanup via DB-state-based batch scanning:

| Type | Detection | Action |
|------|-----------|--------|
| DB orphan (PENDING > 24hr) | Batch scan | Mark EXPIRED |
| S3 orphan (FAILED/EXPIRED > 14 days) | DB-state scan | Delete S3 file + DB record |
| Stuck processing (> 30min) | Batch scan | Kafka republish or DLQ |

![](/uploads/presigned-url-eventbridge-upload/orphan-file-batch-scan.svg)

![](/uploads/presigned-url-eventbridge-upload/orphan-file-cleanup-flow.svg)

---

## Implementation Details

### Presigned URL Issuance

![](/uploads/presigned-url-eventbridge-upload/presigned-url-issue-flow.svg)

Upload records are created in DB before issuing URLs, so S3 events can identify "whose file." UUIDs are embedded in S3 keys (`recordings/{uuid}_{filename}`), extracted from EventBridge events to query records.

### S3 Event Handler

![](/uploads/presigned-url-eventbridge-upload/s3-event-handler.svg)

---

## Honest Assessment

Presigned URLs aren't perfect. The biggest downside is inability to validate files before upload. Server-proxied uploads can check format, size, and malware beforehand; direct S3 uploads can only verify after arrival.

Implementation complexity also increases: Presigned URL issuance, EventBridge configuration, orphan file batch jobs all add management overhead.

However, for our service, audio files didn't require pre-upload validation, and OOM prevention was more critical. This trade-off was accepted.

---

## References

- [Three Ways to Upload Files to S3 in Spring Boot - Woowahan Bros](https://techblog.woowahan.com/11392/)
- [S3 Uploads - Proxies vs Presigned URLs vs Presigned POSTs](https://zaccharles.medium.com/s3-uploads-proxies-vs-presigned-urls-vs-presigned-posts-9661e2b37932)
- [Comparing Two Ways to Trigger Lambda from S3](https://eoins.medium.com/comparing-two-ways-to-trigger-lambda-from-s3-b5da8cfe1aee)

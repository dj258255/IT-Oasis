---
title: '[트러블슈팅] AI 서버 동시 요청 시 GPU OOM'
titleEn: '[Troubleshooting] GPU OOM on Concurrent AI Server Requests'
description: 동시 요청 제한 없이 AI 서버에 보내다가 하루 5-10회 GPU OOM이 터졌다. ThreadPool + Semaphore 이중 동시성 제어로 OOM 0회를 달성한 과정을 정리한다.
descriptionEn: Documents resolving daily 5-10 GPU OOM crashes by implementing dual concurrency control with ThreadPool and Semaphore, achieving zero OOM incidents.
date: 2025-10-03T00:00:00.000Z
tags:
  - Troubleshooting
  - GPU
  - OOM
  - Semaphore
  - ThreadPool
  - Concurrency
category: 프로젝트/오락가락
draft: false
---

## 한 줄 요약

동시 요청 제한 없이 AI 서버에 보내다가 하루 5-10회 GPU OOM이 터졌다. ThreadPool(max=4) + Semaphore(permits=2)로 이중 동시성 제어를 걸어서 OOM 0회로 잡았다.

---

## 증상

운영 중에 음성 분석 요청이 몰리면 Python AI 서버가 죽었다. Pod가 OOMKilled 상태로 재시작되고, 재시작되는 동안 모든 분석 요청이 타임아웃. 하루에 5-10회 반복됐다. Grafana의 컨테이너 모니터링 대시보드에서 AI 서버 Pod의 재시작 횟수가 하루 단위로 올라가는 걸 확인했다.

## 환경

- Python FastAPI (AI 서버), PyTorch + GPU (16GB VRAM)
- Spring Boot (API 서버), WebClient 비동기 호출
- Docker Compose 단일 서버 구성

---

## 원인 분석

GPU 메모리를 계산해봤다.

GPU 전체 메모리 16GB 중 모델 로딩에 4GB가 상시 점유된다. 추론 1건당 약 3GB를 쓴다. 최대 동시 처리는 (16 - 4) / 3 = 약 4건이다.

그런데 Kafka Consumer에서 이벤트가 들어오는 대로 AI 서버에 요청을 쏘고 있었다. 동시에 10건이 들어오면 30GB가 필요한데 16GB밖에 없으니 OOM이 나는 게 당연했다.

AI 분석 담당 팀원과 같이 `nvidia-smi`로 GPU 메모리 사용량을 모니터링하면서 동시 요청 수와 OOM 발생 시점을 대조했다. 동시 3건까지는 안정적이고, 4건부터 가끔 스파이크가 나고, 5건 이상이면 거의 확실하게 OOM이 터졌다.

---

## 해결: ThreadPool + Semaphore 이중 제어

단순히 동시 요청을 줄이면 되는 문제가 아니었다. WAV 변환과 AI 분석이 같은 Consumer에서 처리되는데, WAV 변환은 CPU 바운드라 빠르게 끝나고 AI 분석은 GPU를 오래 점유한다. 같은 스레드풀로 처리하면 AI 분석이 WAV 변환까지 블로킹한다.

그래서 두 가지를 분리했다.

**ThreadPool(max=4)**: 시스템 내부 리소스(CPU, 메모리) 보호. 최대 4개 스레드까지 작업을 처리한다.

**Semaphore(permits=2)**: 외부 서비스(AI 서버 GPU) 보호. 4개 스레드가 동시에 실행되더라도 AI 서버에는 2개만 동시 요청한다.

permits를 GPU 계산상 최대 4건까지 가능하지만 2로 잡은 이유는, 요청마다 메모리 사용량이 다르고(음성 길이, 복잡도에 따라 편차), 안전 마진을 둬야 했기 때문이다.

![](/uploads/ts-gpu-oom-concurrent-requests/threadpool-semaphore-dual-control.svg)

### Semaphore Bean 설정

![](/uploads/ts-gpu-oom-concurrent-requests/semaphore-bean-config.svg)

### ThreadPool 설정

![](/uploads/ts-gpu-oom-concurrent-requests/threadpool-config.svg)

### Semaphore 사용 코드

![](/uploads/ts-gpu-oom-concurrent-requests/semaphore-usage-code.svg)

---

## 작업별 리소스 분리

| 작업 타입 | ThreadPool | Semaphore | 이유 |
|----------|------------|-----------|------|
| WAV 변환 | 5~10 | 8 | CPU 바운드, 빠른 처리 |
| 음성 분석 | 2~4 | 2 | GPU 사용, 무거운 AI 처리 |
| 이미지 처리 | 3~6 | 4 | 중간 수준 |
| 배치 복구 | 2~4 | 3 | 백그라운드 처리 |

무거운 작업(AI 분석)이 가벼운 작업(WAV 변환)을 블로킹하지 않도록 풀을 분리한 게 핵심이다.

---

## 결과

| 지표 | 개선 전 | 개선 후 |
|------|--------|--------|
| AI 서버 OOM 발생 | 하루 5-10회 | 0회 |
| 평균 분석 대기 시간 | 실패로 무한 대기 | 30초 |
| GPU 활용률 | 불안정 (100% 스파이크) | 85% 안정 |
| 분석 성공률 | ~70% | 99%+ |

요청이 폭주해도 세마포어 대기열에서 순차 처리되니 Pod 재시작이 0회가 됐다.

---

## 참고 자료

- [Java Semaphore - Oracle Docs](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/util/concurrent/Semaphore.html)
- [Bulkhead Pattern - Microsoft Azure](https://learn.microsoft.com/en-us/azure/architecture/patterns/bulkhead)

<!-- EN -->

## Summary

Eliminated daily 5-10 GPU OOM crashes by implementing dual concurrency control: ThreadPool (max=4) for system resources and Semaphore (permits=2) for GPU protection, achieving zero OOM incidents.

---

## Symptoms

During operation, the Python AI server crashed when voice analysis requests spiked. Pods restarted as OOMKilled, causing all analysis requests to timeout during restart. This repeated 5-10 times daily. Grafana's container monitoring dashboard showed the AI server Pod restart count climbing daily.

## Environment

- Python FastAPI (AI server), PyTorch + GPU (16GB VRAM)
- Spring Boot (API server), WebClient async calls
- Docker Compose single-server setup

---

## Root Cause

GPU memory calculation: 16GB total, 4GB constant for model loading, ~3GB per inference. Maximum concurrent processing: (16 - 4) / 3 ≈ 4.

But the Kafka Consumer was firing requests to the AI server as fast as events arrived. 10 concurrent requests need 30GB on 16GB hardware — OOM was inevitable.

Monitoring GPU memory with `nvidia-smi` alongside the AI team, we correlated concurrent request counts with OOM timing. 3 concurrent was stable, 4 showed occasional spikes, 5+ almost guaranteed OOM.

---

## Solution: ThreadPool + Semaphore Dual Control

Simply reducing concurrent requests wasn't enough. WAV conversion and AI analysis share the same Consumer, but WAV conversion is CPU-bound (fast) while AI analysis occupies the GPU long. A shared thread pool lets AI analysis block WAV conversion.

Two mechanisms were separated:

**ThreadPool (max=4)**: Protects internal system resources (CPU, memory). Up to 4 threads process tasks.

**Semaphore (permits=2)**: Protects external service (AI server GPU). Even with 4 threads running, only 2 can simultaneously request the AI server.

Permits were set to 2 (not the theoretical max of 4) because per-request memory varies by audio length and complexity, requiring a safety margin.

![](/uploads/ts-gpu-oom-concurrent-requests/threadpool-semaphore-dual-control.svg)

### Semaphore Bean Config

![](/uploads/ts-gpu-oom-concurrent-requests/semaphore-bean-config.svg)

### ThreadPool Config

![](/uploads/ts-gpu-oom-concurrent-requests/threadpool-config.svg)

### Semaphore Usage Code

![](/uploads/ts-gpu-oom-concurrent-requests/semaphore-usage-code.svg)

---

## Per-Task Resource Isolation

| Task Type | ThreadPool | Semaphore | Reason |
|-----------|------------|-----------|--------|
| WAV Conversion | 5~10 | 8 | CPU-bound, fast |
| Voice Analysis | 2~4 | 2 | GPU-heavy AI processing |
| Image Processing | 3~6 | 4 | Medium workload |
| Batch Recovery | 2~4 | 3 | Background processing |

The key is separating pools so heavy tasks (AI analysis) don't block light tasks (WAV conversion).

---

## Results

| Metric | Before | After |
|--------|--------|-------|
| AI server OOM | 5-10/day | 0 |
| Avg analysis wait | Infinite (failures) | 30s |
| GPU utilization | Unstable (100% spikes) | 85% stable |
| Analysis success rate | ~70% | 99%+ |

Even under request surges, sequential processing via semaphore queue reduced Pod restarts to zero.

---

## References

- [Java Semaphore - Oracle Docs](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/util/concurrent/Semaphore.html)
- [Bulkhead Pattern - Microsoft Azure](https://learn.microsoft.com/en-us/azure/architecture/patterns/bulkhead)

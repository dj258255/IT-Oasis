---
title: '[트러블슈팅] AI 서버 동시 요청 시 GPU OOM'
description: 동시 요청 제한 없이 AI 서버에 보내다가 하루 5-10회 GPU OOM이 터졌다. ThreadPool + Semaphore 이중 동시성 제어로 OOM 0회를 달성한 과정을 정리한다.
date: 2025-10-03T00:00:00.000Z
tags:
  - Troubleshooting
  - GPU
  - OOM
  - Semaphore
  - ThreadPool
  - Concurrency
category: team/Orakgarak
draft: false
coverImage: "/uploads/project/Orakgarak/ts-gpu-oom-concurrent-requests/threadpool-semaphore-dual-control.svg"
series: "Orakgarak"
---

## 한 줄 요약

동시 요청 제한 없이 AI 서버에 보내다가 하루 5-10회 GPU OOM이 터졌습니다.
ThreadPool(max=4) + Semaphore(permits=2)로 이중 동시성 제어를 걸어서 OOM 0회로 잡았습니다.

---

## 증상

운영 중에 음성 분석 요청이 몰리면 Python AI 서버가 죽었습니다.
Pod가 OOMKilled 상태로 재시작되고, 재시작되는 동안 모든 분석 요청이 타임아웃.
하루에 5-10회 반복됐습니다.
Grafana의 컨테이너 모니터링 대시보드에서 AI 서버 Pod의 재시작 횟수가 하루 단위로 올라가는 걸 확인했습니다.

## 환경

- Python FastAPI (AI 서버), PyTorch + GPU (8GB VRAM)
- Spring Boot (API 서버), WebClient 비동기 호출
- Docker Compose 단일 서버 구성

---

## 원인 분석

GPU 메모리를 계산해봤습니다.

GPU 전체 메모리 8GB 중 모델 로딩에 약 3GB가 상시 점유됩니다.
추론 1건당 약 2-3GB를 씁니다.
최대 동시 처리는 (8 - 3) / 2.5 = 약 2건입니다.

그런데 Kafka Consumer에서 이벤트가 들어오는 대로 AI 서버에 요청을 쏘고 있었습니다.
동시에 5건만 들어오면 필요 메모리가 VRAM을 초과하니 OOM이 나는 게 당연했습니다.

AI 분석 담당 팀원과 같이 `nvidia-smi`로 GPU 메모리 사용량을 모니터링하면서 동시 요청 수와 OOM 발생 시점을 대조했습니다.
동시 3건까지는 안정적이고, 4건부터 가끔 스파이크가 나고, 5건 이상이면 거의 확실하게 OOM이 터졌습니다.

---

## 해결: ThreadPool + Semaphore 이중 제어

단순히 동시 요청을 줄이면 되는 문제가 아니었습니다.
WAV 변환과 AI 분석이 같은 Consumer에서 처리되는데, WAV 변환은 CPU 바운드라 빠르게 끝나고 AI 분석은 GPU를 오래 점유합니다.
같은 스레드풀로 처리하면 AI 분석이 WAV 변환까지 블로킹합니다.

그래서 두 가지를 분리했습니다.

**ThreadPool(max=4)**: 시스템 내부 리소스(CPU, 메모리) 보호.
최대 4개 스레드까지 작업을 처리합니다.

**Semaphore(permits=2)**: 외부 서비스(AI 서버 GPU) 보호.
4개 스레드가 동시에 실행되더라도 AI 서버에는 2개만 동시 요청합니다.

permits를 2로 잡은 이유는, GPU 계산상 최대 동시 처리가 약 2건이고, 요청마다 메모리 사용량이 다르기 때문에(음성 길이, 복잡도에 따라 편차) 안전 마진을 포함한 수치입니다.

### 검토했지만 선택하지 않은 대안

| 방식 | 장점 | 단점 | 판단 |
|------|------|------|------|
| **Kafka `max.poll.records` 조절** | 설정만 변경 | Consumer 레벨 제한이라 GPU 메모리와 직접 연동 안 됨. WAV 변환까지 같이 제한됨 | 탈락 |
| **Resilience4j RateLimiter** | 시간 기반 요청률 제한 | AI 분석은 시간당 N건이 아니라 동시 N건이 문제. 처리 시간이 가변적이라 rate 기반은 부적합 | 탈락 |
| **ThreadPool만 (Semaphore 없이)** | 단순 | WAV 변환과 AI 분석이 같은 풀이면 AI가 WAV를 블로킹. 풀을 분리해도 AI 전용 풀 max=2로 하면 Semaphore와 사실상 동일 | 부분 채택 |
| **ThreadPool + Semaphore** | 내부(CPU) + 외부(GPU) 자원을 독립 제어 | 구현 약간 복잡 | **선택** |

ThreadPool만으로도 가능하지만, Semaphore로 "외부 GPU 자원에 대한 동시 접근 제한"을 명시적으로 분리한 게 Bulkhead 패턴의 의도를 더 잘 표현합니다.

![](/uploads/project/Orakgarak/ts-gpu-oom-concurrent-requests/threadpool-semaphore-dual-control.svg)

### Semaphore Bean 설정

![](/uploads/project/Orakgarak/ts-gpu-oom-concurrent-requests/semaphore-bean-config.svg)

### ThreadPool 설정

![](/uploads/project/Orakgarak/ts-gpu-oom-concurrent-requests/threadpool-config.svg)

### Semaphore 사용 코드

![](/uploads/project/Orakgarak/ts-gpu-oom-concurrent-requests/semaphore-usage-code.svg)

---

## 작업별 리소스 분리

| 작업 타입 | ThreadPool | Semaphore | 이유 |
|----------|------------|-----------|------|
| WAV 변환 | 5~10 | 8 | CPU 바운드, 빠른 처리 |
| 음성 분석 | 2~4 | 2 | GPU 사용, 무거운 AI 처리 |
| 이미지 처리 | 3~6 | 4 | 중간 수준 |
| 배치 복구 | 2~4 | 3 | 백그라운드 처리 |

무거운 작업(AI 분석)이 가벼운 작업(WAV 변환)을 블로킹하지 않도록 풀을 분리한 게 핵심입니다.

---

## 결과

| 지표 | 개선 전 | 개선 후 |
|------|--------|--------|
| AI 서버 OOM 발생 | 하루 5-10회 | 0회 |
| 평균 분석 대기 시간 | 실패로 무한 대기 | 30초 |
| GPU 활용률 | 불안정 (100% 스파이크) | 85% 안정 |
| 분석 성공률 | ~70% | 99%+ |

요청이 폭주해도 세마포어 대기열에서 순차 처리되니 Pod 재시작이 0회가 됐습니다.

---

## 참고 자료

- [Java Semaphore - Oracle Docs](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/util/concurrent/Semaphore.html)
- [Bulkhead Pattern - Microsoft Azure](https://learn.microsoft.com/en-us/azure/architecture/patterns/bulkhead)

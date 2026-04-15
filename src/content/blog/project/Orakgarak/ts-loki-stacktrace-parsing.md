---
title: '[트러블슈팅] Loki에서 스택트레이스 파싱 실패'
titleEn: '[Troubleshooting] Stacktrace Parsing Failure in Loki'
description: Exception 로그가 여러 줄로 분리되어 Grafana에서 스택트레이스 검색이 안 됐다. Log4j2 JSON 포맷 + Promtail JSON 파이프라인으로 해결한 과정을 정리한다.
descriptionEn: Documents resolving stacktrace search failures in Grafana caused by multi-line log splitting, using Log4j2 JSON layout and Promtail JSON pipeline.
date: 2025-10-19T00:00:00.000Z
tags:
  - Troubleshooting
  - Loki
  - Log4j2
  - Promtail
  - Logging
  - Grafana
category: project/Orakgarak
draft: false
coverImage: "/uploads/project/Orakgarak/ts-loki-stacktrace-parsing/log4j2-json-layout.svg"
series: "Orakgarak"
---

## 한 줄 요약

Exception 로그가 여러 줄로 분리되어 Grafana에서 스택트레이스 검색이 안 됐어요.
Log4j2를 JSON 포맷으로 바꾸고 Promtail JSON 파이프라인을 설정해서 해결했어요.

---

## 정상 상태

Spring Boot + Log4j2가 텍스트 포맷(PatternLayout)으로 로그를 stdout에 출력하고, Promtail이 이를 수집해서 Loki로 전송하는 구조였어요.
일반 로그(단일 줄)는 정상적으로 수집되고 Grafana에서 검색이 가능했어요.

---

## 증상

Grafana에서 `NullPointerException`을 검색하면 에러 메시지 한 줄만 나오고, 실제 스택트레이스는 보이지 않았어요.
스택트레이스의 각 줄이 별도의 로그 엔트리로 저장되고 있었거든요.

예를 들어 이런 로그가 있으면:

```
2024-01-01 10:00:00.123 ERROR [main] c.e.Service - 처리 실패
java.lang.NullPointerException: null
    at com.example.Service.method(Service.java:10)
    at com.example.Controller.handle(Controller.java:20)
```

Promtail이 줄 단위로 파싱해서 첫 줄, 둘째 줄, 셋째 줄이 각각 별개의 로그 엔트리가 돼요.
"NullPointerException"을 검색하면 둘째 줄만 나오는데, 그 로그에 대한 컨텍스트(어떤 서비스에서, 어떤 요청에 의해)가 전혀 없어요.

## 환경

- Grafana Loki + Promtail
- Spring Boot + Log4j2
- Docker Compose 단일 서버 구성

---

## 원인 분석

Promtail은 기본적으로 `\n`(개행)을 로그 엔트리 경계로 인식해요.
Java 스택트레이스는 여러 줄로 출력되니, Promtail이 각 줄을 독립된 로그 엔트리로 분리하는 건 당연한 동작이에요.

---

## 대안 검토

| 방식 | 장점 | 단점 | 판단 |
|------|------|------|------|
| **Promtail multiline stage** | 기존 텍스트 포맷 유지 | 정규표현식으로 시작 패턴을 정의해야 하고, 로그 포맷이 바뀌면 정규식도 수정 필요. 구조화 쿼리 불가 | 탈락 |
| **Log4j2 JSON 포맷 전환** | 스택트레이스가 JSON 필드 안에 이스케이프되어 자동으로 한 줄. 구조화 쿼리(level, traceId 등) 가능 | 로그 크기 증가 (JSON 메타데이터), 사람이 읽기 어려움 | **선택** |
| **Fluentd/Fluent Bit** | 멀티라인 파서 내장 | Promtail을 교체해야 함. Loki와의 호환성 유지가 목표인데 인프라 변경 과잉 | 탈락 |

multiline stage도 검토했지만, 텍스트 로그에서 정규식으로 멀티라인을 묶으면 "타임스탬프로 시작하는 줄"을 엔트리 경계로 잡아야 하는데, 로그 포맷이 바뀔 때마다 정규식을 수정해야 해요. JSON 전환하면 멀티라인 문제가 원천적으로 사라지고, 덤으로 구조화 쿼리(level="ERROR", traceId 기반 추적)가 가능해져서 JSON을 택했어요.

---

## 해결: Log4j2 JSON 포맷 + Promtail 파이프라인

핵심은 스택트레이스를 한 줄로 만드는 거였어요.
JSON 포맷으로 바꾸면 스택트레이스가 `thrown` 필드(Log4j2 JsonLayout 기준) 안에 이스케이프된 문자열로 들어가니, 전체 로그 이벤트가 한 줄의 JSON이 되어 Promtail이 하나의 엔트리로 인식해요.

### 1. Log4j2 JSON Layout 적용

Log4j2의 JsonLayout을 사용해서 로그를 JSON으로 출력하게 변경했어요.

![](/uploads/project/Orakgarak/ts-loki-stacktrace-parsing/log4j2-json-layout.svg)

결과 JSON:

![](/uploads/project/Orakgarak/ts-loki-stacktrace-parsing/json-log-output.svg)

### 2. Promtail JSON 파이프라인 설정

Promtail이 JSON을 파싱해서 level, logger 등을 Loki 레이블로 추출하도록 설정했어요.

![](/uploads/project/Orakgarak/ts-loki-stacktrace-parsing/promtail-pipeline.svg)

### 3. 환경별 로그 레벨 분리

운영 환경에서는 Kafka, Redis 내부 로그를 WARN 이상만 남기도록 설정했어요.
이런 라이브러리 로그가 Loki 용량을 불필요하게 차지하는 걸 방지하기 위해서예요.

![](/uploads/project/Orakgarak/ts-loki-stacktrace-parsing/log-level-config.svg)

### 4. 비동기 로깅

로그 출력이 애플리케이션 스레드를 블로킹하지 않도록 AsyncLogger를 적용했어요.

![](/uploads/project/Orakgarak/ts-loki-stacktrace-parsing/async-logging.svg)

### 5. ERROR 로그 별도 파일 관리

![](/uploads/project/Orakgarak/ts-loki-stacktrace-parsing/error-log-management.svg)

---

## Grafana 검색 비교

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

traceId 기반 요청 추적도 가능해졌어요:
```
{job="orakgaraki"} | json | traceId="3fa414eac33375e9"
```

---

## 결과

| 지표 | 개선 전 | 개선 후 |
|------|--------|--------|
| 스택트레이스 검색 | 불가능 | 가능 |
| 에러 분석 시간 | 서버 SSH 접속 필요 | Grafana에서 즉시 |
| 로그 필터링 | 텍스트 매칭만 | 구조화 쿼리 |
| 요청 추적 | 수동 | traceId로 자동 추적 |

---

## 참고 자료

- [Log4j2 JSON Layout](https://logging.apache.org/log4j/2.x/manual/layouts.html#JSONLayout)
- [Promtail Pipeline Stages](https://grafana.com/docs/loki/latest/clients/promtail/stages/)
- [Loki LogQL](https://grafana.com/docs/loki/latest/logql/)

<!-- EN -->

## Summary

Resolved stacktrace search failures in Grafana caused by multi-line log splitting. Switching Log4j2 to JSON format and configuring Promtail JSON pipeline fixed the issue.

---

## Normal State

Spring Boot + Log4j2 output text-formatted logs (PatternLayout) to stdout. Promtail collected these and forwarded to Loki. Single-line logs were collected and searchable in Grafana normally.

---

## Symptoms

Searching for `NullPointerException` in Grafana returned only the error message line, not the actual stacktrace. Each stacktrace line was stored as a separate log entry.

For example, this log:

```
2024-01-01 10:00:00.123 ERROR [main] c.e.Service - Processing failed
java.lang.NullPointerException: null
    at com.example.Service.method(Service.java:10)
    at com.example.Controller.handle(Controller.java:20)
```

Promtail parsed line-by-line, making each line a separate log entry. Searching "NullPointerException" returned only the second line with no context about which service or request caused it.

## Environment

- Grafana Loki + Promtail
- Spring Boot + Log4j2
- Docker Compose single-server setup

---

## Root Cause

Promtail uses `\n` (newline) as log entry boundaries by default. Java stacktraces span multiple lines, so Promtail naturally splits each line into a separate log entry.

---

## Alternatives Considered

| Approach | Pros | Cons | Decision |
|----------|------|------|----------|
| **Promtail multiline stage** | Keeps text format | Requires regex for start patterns; regex must update when log format changes; no structured queries | Rejected |
| **Log4j2 JSON format** | Stacktrace auto-escaped into single JSON field; enables structured queries (level, traceId) | Larger log size (JSON metadata); harder to read raw | **Selected** |
| **Fluentd/Fluent Bit** | Built-in multiline parser | Requires replacing Promtail; excessive infra change for this goal | Rejected |

---

## Solution: Log4j2 JSON Format + Promtail Pipeline

The key was making stacktraces single-line. JSON format embeds stacktraces as escaped strings within the `thrown` field (Log4j2 JsonLayout), making the entire log event a single JSON line that Promtail recognizes as one entry.

### 1. Log4j2 JSON Layout

Switched to Log4j2's JsonLayout for JSON-formatted log output.

![](/uploads/project/Orakgarak/ts-loki-stacktrace-parsing/log4j2-json-layout.svg)

Result JSON:

![](/uploads/project/Orakgarak/ts-loki-stacktrace-parsing/json-log-output.svg)

### 2. Promtail JSON Pipeline

Configured Promtail to parse JSON and extract level, logger, etc. as Loki labels.

![](/uploads/project/Orakgarak/ts-loki-stacktrace-parsing/promtail-pipeline.svg)

### 3. Per-Environment Log Level Separation

Production limits Kafka and Redis internal logs to WARN+, preventing library logs from consuming Loki storage.

![](/uploads/project/Orakgarak/ts-loki-stacktrace-parsing/log-level-config.svg)

### 4. Async Logging

AsyncLogger prevents log output from blocking application threads.

![](/uploads/project/Orakgarak/ts-loki-stacktrace-parsing/async-logging.svg)

### 5. Separate ERROR Log Files

![](/uploads/project/Orakgarak/ts-loki-stacktrace-parsing/error-log-management.svg)

---

## Grafana Search Comparison

**Before (text logs)**
```
{job="orakgaraki"} |= "NullPointerException"
→ Error message only, no stacktrace
```

**After (JSON logs)**
```
{job="orakgaraki"} | json | level="ERROR" | line_format "{{.message}}"
→ Full stacktrace included, structured queries possible
```

traceId-based request tracing became possible:
```
{job="orakgaraki"} | json | traceId="3fa414eac33375e9"
```

---

## Results

| Metric | Before | After |
|--------|--------|-------|
| Stacktrace search | Impossible | Possible |
| Error analysis time | Server SSH required | Instant in Grafana |
| Log filtering | Text matching only | Structured queries |
| Request tracing | Manual | Automatic via traceId |

---

## References

- [Log4j2 JSON Layout](https://logging.apache.org/log4j/2.x/manual/layouts.html#JSONLayout)
- [Promtail Pipeline Stages](https://grafana.com/docs/loki/latest/clients/promtail/stages/)
- [Loki LogQL](https://grafana.com/docs/loki/latest/logql/)

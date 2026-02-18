---
title: '[트러블슈팅] Kafka 파티션 불균형으로 처리 지연'
titleEn: '[Troubleshooting] Processing Delay from Kafka Partition Imbalance'
description: userId 기반 파티셔닝 때문에 헤비 유저의 이벤트가 한 파티션에 몰리면서 Lag 편차가 10배까지 벌어졌다. uploadId 기반으로 바꿔서 해결한 과정을 정리한다.
descriptionEn: Documents resolving 10x partition lag variance caused by userId-based partitioning by switching to uploadId-based partitioning for even distribution.
date: 2025-10-11T00:00:00.000Z
tags:
  - Troubleshooting
  - Kafka
  - Partitioning
  - Consumer Lag
  - Performance
category: project/Orakgarak
draft: false
coverImage: "/uploads/project/Orakgarak/ts-kafka-partition-imbalance/uploadid-partitioning.svg"
---

## 한 줄 요약

userId 기반 파티셔닝 때문에 헤비 유저의 이벤트가 한 파티션에 몰리면서 Lag 편차가 10배까지 벌어졌다. uploadId 기반으로 바꿔서 Lag 편차 1.2배, 처리 완료 시간 p99를 5분에서 1분으로 줄였다.

---

## 증상

Kafka Exporter로 Consumer Lag을 파티션별로 확인하니, 특정 파티션에만 메시지가 몰려 있었다. 파티션 0의 Lag이 5000인데 파티션 1은 5, 파티션 2는 3이었다. 파티션 0에 붙은 Consumer만 바쁘게 돌고, 나머지 Consumer는 유휴 상태.

결과적으로 파티션 0에 걸린 사용자의 음성 분석이 5분 넘게 대기하는 반면, 다른 파티션에 걸린 사용자는 바로 처리됐다.

## 환경

- Apache Kafka 3.x (Docker 컨테이너)
- Spring Kafka
- 단일 서버 구성

---

## 원인: 파티션 키가 userId

기존에 userId를 파티션 키로 쓰고 있었다. "같은 사용자의 이벤트는 순서대로 처리되어야 한다"는 생각이었다.

문제는 활동적인 사용자 한 명이 하루에 100건의 녹음을 올리면, 그 100건이 전부 같은 파티션에 들어간다는 것이다. 비활동 사용자는 하루 3-5건이니, 파티션 간 부하 차이가 수십 배까지 벌어진다.

---

## 해결: uploadId 기반 파티셔닝

생각해보니 "같은 사용자의 모든 업로드"가 순서를 보장할 필요는 없었다. 순서가 필요한 건 "같은 파일의 처리 단계" 뿐이다. UPLOADED → CONVERTING → COMPLETED가 순서대로 실행되면 되지, 사용자의 첫 번째 녹음과 두 번째 녹음 사이에 순서가 필요한 건 아니다.

uploadId를 파티션 키로 바꿨다. 업로드마다 UUID가 다르니 해시 분포가 고르게 퍼진다. 같은 파일의 이벤트만 같은 파티션에 들어가면서 순서도 보장된다.

![](/uploads/project/Orakgarak/ts-kafka-partition-imbalance/uploadid-partitioning.svg)

---

## Consumer Group 구성

각 토픽별로 독립적인 Consumer Group을 구성했다.

![](/uploads/project/Orakgarak/ts-kafka-partition-imbalance/consumer-group-config.svg)

### 토픽 구성

| 토픽 | 용도 | 파티션 키 |
|------|------|----------|
| upload-events | 업로드 완료 이벤트 | uploadId |
| processing-status | 처리 상태 변경 | uploadId |
| processing-results | 처리 결과 | uploadId |
| voice-analysis-events | 음성 분석 요청 | uploadId |
| upload-events-retry | 재시도 대기 | uploadId |
| upload-events-dlq | 최종 실패 | uploadId |

모든 토픽에서 uploadId를 파티션 키로 통일했다.

---

## 결과

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

## 참고 자료

- [Kafka Partitioner 공식 문서](https://kafka.apache.org/documentation/#producerconfigs_partitioner.class)
- [Kafka Consumer Group](https://kafka.apache.org/documentation/#consumerconfigs)

<!-- EN -->

## Summary

Resolved 10x partition lag variance caused by userId-based partitioning. Switching to uploadId-based partitioning reduced lag variance to 1.2x and p99 processing time from 5 minutes to 1 minute.

---

## Symptoms

Kafka Exporter showed messages piling up on specific partitions. Partition 0 had a lag of 5000 while partitions 1 and 2 had 5 and 3 respectively. Only the Consumer on partition 0 was busy; the rest were idle.

Users whose events landed on partition 0 waited 5+ minutes for voice analysis, while others were processed immediately.

## Environment

- Apache Kafka 3.x (Docker container)
- Spring Kafka
- Single-server setup

---

## Cause: userId as Partition Key

userId was the partition key, based on the assumption that "same user's events must be processed in order."

The problem: one active user uploading 100 recordings per day sends all 100 to the same partition. Inactive users upload 3-5 per day, creating tens-of-times load difference between partitions.

---

## Solution: uploadId-based Partitioning

On reflection, ordering wasn't needed across "all uploads from the same user." Ordering was only needed for "processing stages of the same file." UPLOADED → CONVERTING → COMPLETED must be sequential, but a user's first and second recordings don't need ordering.

Switching to uploadId as partition key distributes hashes evenly (each upload has a unique UUID). Events for the same file still land on the same partition, preserving ordering.

![](/uploads/project/Orakgarak/ts-kafka-partition-imbalance/uploadid-partitioning.svg)

---

## Consumer Group Configuration

Independent Consumer Groups per topic.

![](/uploads/project/Orakgarak/ts-kafka-partition-imbalance/consumer-group-config.svg)

### Topic Structure

| Topic | Purpose | Partition Key |
|-------|---------|---------------|
| upload-events | Upload completion events | uploadId |
| processing-status | Processing state changes | uploadId |
| processing-results | Processing results | uploadId |
| voice-analysis-events | Voice analysis requests | uploadId |
| upload-events-retry | Retry queue | uploadId |
| upload-events-dlq | Final failures | uploadId |

All topics unified on uploadId as partition key.

---

## Results

| Metric | Before | After |
|--------|--------|-------|
| Per-partition throughput variance | 10x | 1.2x |
| Max Consumer Lag | 5000 | 200 |
| Processing completion time p99 | 5min | 1min |
| Idle Consumer ratio | 66% | 0% |

**Before**
![](/uploads/project/Orakgarak/ts-kafka-partition-imbalance/partition-distribution-before.png)

**After**
![](/uploads/project/Orakgarak/ts-kafka-partition-imbalance/section.png)

---

## References

- [Kafka Partitioner Documentation](https://kafka.apache.org/documentation/#producerconfigs_partitioner.class)
- [Kafka Consumer Group](https://kafka.apache.org/documentation/#consumerconfigs)

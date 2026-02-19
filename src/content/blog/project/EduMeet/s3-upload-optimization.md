---
title: 'S3 파일 업로드 최적화'
titleEn: 'S3 File Upload Optimization'
description: UUID vs Auto Increment PK 전략, S3 업로드 방식 비교, 이미지 처리 접근 방식을 분석하고 프로젝트에 적합한 전략을 선택한 과정을 정리한다.
descriptionEn: Analyzes UUID vs Auto Increment PK strategies, S3 upload methods, and image processing approaches to select the optimal strategy for the project.
date: 2025-08-14T00:00:00.000Z
tags:
  - S3
  - UUID
  - Snowflake ID
  - File Upload
  - Presigned URL
  - MySQL
  - InnoDB
category: project/EduMeet
draft: false
coverImage: "/uploads/project/EduMeet/s3-upload-optimization/section.svg"
---

> EduMeet 프로젝트에서 게시글 이미지 업로드 기능 구현 시 고민한 내용

---

## 1. PK 전략: UUID vs Auto Increment

### 왜 UUID를 PK로 쓰면 안 되는가?

**결론부터 말하면: "UUID 자체가 문제가 아니라, RDBMS의 Clustered Index 구조와 UUID의 랜덤성이 충돌하기 때문이에요."**

#### InnoDB의 Clustered Index 구조

MySQL InnoDB는 PK를 기준으로 **Clustered Index**를 생성해요.

```
Clustered Index = 데이터 자체가 PK 순서로 물리적으로 정렬되어 저장됨
```

- B+Tree 구조로 관리
- PK가 정렬된 순서대로 Leaf 페이지에 데이터가 배치됨
- 새 데이터 삽입 시 PK 순서에 맞는 위치에 삽입

#### UUID v4의 문제: 랜덤 삽입

UUID v4는 122비트가 완전 랜덤이에요.

```
Auto Increment: 항상 마지막 Leaf 노드에 추가 (순차 삽입)
UUID v4: 랜덤한 위치의 Leaf 노드에 삽입 (랜덤 삽입)
```

**랜덤 삽입이 일으키는 문제:**

| 문제 | 설명 |
|------|------|
| 페이지 분할 | 이미 꽉 찬 Leaf 페이지 중간에 삽입 → 페이지 분할(Page Split) 발생 |
| 단편화 | 페이지 분할로 인해 50% 정도만 채워진 페이지들이 생김 → 저장 효율 25%↓ |
| 캐시 미스 | 랜덤 위치 접근으로 Buffer Pool 캐시 효율 저하 |
| I/O 증가 | 흩어진 데이터로 인해 디스크 랜덤 I/O 증가 |

#### UUID 버전별 차이

| 버전 | 생성 방식 | 정렬 가능 | MySQL PK 적합도 |
|------|----------|----------|-----------------|
| v1 | MAC 주소 + 타임스탬프 | △ (타임스탬프가 중간에 위치) | 중간 |
| v4 | 122비트 완전 랜덤 | ✕ | **부적합** |
| v6 | v1 재배열 (타임스탬프 앞으로) | ○ | 좋음 |
| v7 | Unix 타임스탬프(48비트) + 랜덤 | ○ | **좋음** |

### Auto Increment의 문제점

단순히 "숫자가 고갈되면 어떡하지?"보다 실무에서 더 중요한 문제들이 있어요.

#### 메모리/스토리지 오버헤드

| 항목 | Auto Increment (BIGINT) | UUID (VARCHAR 36) | UUID (BINARY 16) |
|------|------------------------|-------------------|------------------|
| PK 크기 | 8 bytes | 36 bytes | 16 bytes |
| Secondary Index 영향 | 기준 | **4.5배** 증가 | **2배** 증가 |
| Buffer Pool 효율 | 최적 | **56% 저하** | **2배 캐시 미스** |

#### 분산 환경에서의 경합 문제

| 문제 | 설명 |
|------|------|
| 충돌 | 여러 서버에서 동일 ID 생성 |
| 경합 | 하나의 시퀀스에 대한 Lock 경합 발생 |
| 병목 | Master-Slave 구조에서 Master만 ID 생성 → 단일 장애점 |

![](/uploads/project/EduMeet/s3-upload-optimization/section.svg)

### 대안: Snowflake ID

Twitter가 만든 **Snowflake ID**는 64비트로 순차성과 분산 환경을 모두 지원해요.

![](/uploads/project/EduMeet/s3-upload-optimization/snowflake-id.png)

**장점:**
- 64비트 = 8바이트 (UUID의 절반)
- 시간순 정렬 가능 (Clustered Index 친화적)
- 분산 환경에서 충돌 없음

#### Snowflake ID의 비즈니스적 이점

ID 자체가 정보를 담고 있다는 점이 핵심이에요.

```
Snowflake ID: 6920399584824147968

분해하면:
- 타임스탬프: 2024-01-15 14:32:05.123 (레코드 생성 시점)
- 데이터센터: 3 (어느 DC에서 생성됐는지)
- 머신 ID: 12 (어느 서버 인스턴스에서 생성됐는지)
- 시퀀스: 0 (해당 밀리초 내 몇 번째인지)
```

**Bad: PK에 비즈니스 의미 부여**
![](/uploads/project/EduMeet/s3-upload-optimization/snowflake-id-02.svg)

**Good: PK와 도메인 식별자 분리**
![](/uploads/project/EduMeet/s3-upload-optimization/snowflake-id-03.svg)

### 결론: 상황에 따라 다르다

| 상황 | 권장 방식 | 이유 |
|------|----------|------|
| 단일 서버, 내부 시스템 | Auto Increment | 단순함, 성능 최적 |
| 분산 환경, 대규모 | Snowflake ID | 충돌 없음 + 추적 정보 |
| 외부 노출 필요 | Auto Increment (PK) + UUID (외부용) | 보안 + 성능 |
| PostgreSQL 환경 | UUID v7 고려 가능 | 네이티브 지원 |
| MSA + 이벤트 소싱 | ULID / UUID v7 | 시간순 + 분산 생성 |

**이 프로젝트에서는:**
- 이미지 파일명: UUID (외부 노출, 예측 불가)
- DB PK: Auto Increment (성능)

---

## 2. S3 업로드 방식 비교

Spring Boot에서 S3에 파일을 업로드하는 세 가지 방법을 검토했어요.

### 2.1 Stream 업로드

![Stream 업로드 아키텍처](/uploads/project/EduMeet/s3-upload-optimization/stream-upload.png)
*이미지 출처: [우아한형제들 기술블로그](https://techblog.woowahan.com/11392/)*

HttpServletRequest의 InputStream을 이용해 S3에 직접 전송하는 방식이에요. 파일 바이너리를 서버에 저장하지 않아요.

**단점:** 대용량 파일 시 속도 문제 (937MB → 약 16분), 이미지 전처리 불가, 진행 상태 제공 불가

### 2.2 MultipartFile 업로드

![MultipartFile 업로드 아키텍처](/uploads/project/EduMeet/s3-upload-optimization/multipartfile-upload.png)
*이미지 출처: [우아한형제들 기술블로그](https://techblog.woowahan.com/11392/)*

Spring의 MultipartFile 인터페이스를 활용하는 방식이에요. WAS(Tomcat)가 임시 디렉터리에 파일을 저장해요.

![MultipartFile 동작 원리](/uploads/project/EduMeet/s3-upload-optimization/multipartfile-upload-02.png)
*이미지 출처: [우아한형제들 기술블로그](https://techblog.woowahan.com/11392/)*

**장점:** 이미지 리사이징 등 전처리 가능
**단점:** 동시 요청 시 스레드 고갈 위험, 임시 파일 관리 필요

### 2.3 AWS Multipart 업로드

![AWS Multipart 업로드](/uploads/project/EduMeet/s3-upload-optimization/aws-multipart-upload.png)
*이미지 출처: [우아한형제들 기술블로그](https://techblog.woowahan.com/11392/)*

파일을 작은 part로 나누어 개별 업로드하는 방식이에요. Spring Boot를 거치지 않고 S3에 직접 업로드하죠.

![AWS Multipart 진행 상태](/uploads/project/EduMeet/s3-upload-optimization/aws-multipart-upload-02.gif)
*이미지 출처: [우아한형제들 기술블로그](https://techblog.woowahan.com/11392/)*

![AWS Multipart 전체 흐름](/uploads/project/EduMeet/s3-upload-optimization/aws-multipart-upload-03.png)
*이미지 출처: [우아한형제들 기술블로그](https://techblog.woowahan.com/11392/)*

### 비교 표

| 특징 | Stream | MultipartFile | AWS Multipart |
|------|--------|---------------|---------------|
| 파일 크기 제한 | 이론상 없음 | 설정에 따라 | 최대 5TB |
| 서버 메모리 영향 | 낮음 | 중간 | 없음 |
| 이미지 전처리 | X | O | X |
| 진행 상태 표시 | X | X | O |
| 구현 복잡도 | 낮음 | 중간 | 높음 |

---

## 3. 이미지 처리 접근 방식

### 전통적인 방식 (선택)

```
클라이언트 → 서버 업로드 → 이미지 처리 → S3 업로드
```

서버에서 일관된 이미지 처리가 가능하고, 클라이언트 구현이 단순해요.

### Presigned URL 방식

```
클라이언트 → Presigned URL 요청 → S3 직접 업로드
```

서버 부하가 최소화되지만, 클라이언트에서 이미지 처리가 필요해요.

### 선택 이유

1. 요구사항: 게시글 이미지 첨부 시 썸네일 생성 필요
2. 개발 기간: 6주 (빠른 구현 필요)
3. 일관된 아키텍처: 서버에서 모든 처리 담당
4. 클라이언트 연동 간편

---

## 4. 구현: 크로스 플랫폼 임시 파일 경로

### 문제

OS마다 파일 경로가 달라요 (Windows: `C:\Users\...\Temp`, Linux: `/tmp`, macOS: `/var/folders/...`).

### 해결: 환경변수 + 기본값

![환경변수 설정 코드](/uploads/project/EduMeet/s3-upload-optimization/solution.png)

![](/uploads/project/EduMeet/s3-upload-optimization/solution-02.svg)

`EDUMEET_UPLOAD_PATH` 환경변수가 있으면 해당 값을, 없으면 `${java.io.tmpdir}/edumeet-upload` 기본값을 사용해요.

---

## 5. 결과: 썸네일 리사이징 효과

![리사이징 결과](/uploads/project/EduMeet/s3-upload-optimization/result-thumbnail-resizing-effect.png)

| 지표 | Before | After | 개선율 |
|------|--------|-------|--------|
| 이미지 용량 | 원본 | 리사이징 | **91.8% 감소** |

**효과:** 페이지 로딩 속도 개선, 네트워크 대역폭 절감, S3 스토리지 비용 절감

---

## Reference

- [MySQL UUIDs – Bad For Performance | Percona](https://www.percona.com/blog/uuids-are-popular-but-bad-for-performance-lets-discuss/)
- [Spring Boot에서 S3에 파일을 업로드하는 세 가지 방법 | 우아한형제들 기술블로그](https://techblog.woowahan.com/11392/)
- [가상 면접 사례로 배우는 대규모 시스템 설계 기초](https://product.kyobobook.co.kr/detail/S000001033116) - 7장: 분산 시스템을 위한 유일 ID 생성기 설계

<!-- EN -->

> Considerations when implementing image upload for posts in the EduMeet project

---

## 1. PK Strategy: UUID vs Auto Increment

### Why UUID Shouldn't Be Used as PK

**Bottom line: "UUID itself isn't the problem — it's the conflict between RDBMS's Clustered Index structure and UUID's randomness."**

#### InnoDB's Clustered Index Structure

MySQL InnoDB creates a **Clustered Index** based on the PK.

```
Clustered Index = Data physically sorted and stored in PK order
```

- Managed with B+Tree structure
- Data placed in Leaf pages in sorted PK order
- New data inserted at the position matching PK order

#### UUID v4's Problem: Random Insertion

UUID v4 has 122 completely random bits.

```
Auto Increment: Always appends to the last Leaf node (sequential insertion)
UUID v4: Inserts at random Leaf node positions (random insertion)
```

**Problems caused by random insertion:**

| Problem | Description |
|---------|-------------|
| Page Split | Insertion into a full Leaf page → Page Split occurs |
| Fragmentation | Pages only ~50% full due to splits → 25% storage efficiency loss |
| Cache Miss | Random position access degrades Buffer Pool cache efficiency |
| I/O Increase | Scattered data increases random disk I/O |

#### UUID Version Differences

| Version | Generation Method | Sortable | MySQL PK Suitability |
|---------|------------------|----------|---------------------|
| v1 | MAC address + timestamp | △ (timestamp in middle) | Medium |
| v4 | 122-bit fully random | X | **Unsuitable** |
| v6 | v1 rearranged (timestamp first) | O | Good |
| v7 | Unix timestamp (48-bit) + random | O | **Good** |

### Auto Increment's Problems

Real-world issues beyond "what if numbers run out":

#### Memory/Storage Overhead

| Item | Auto Increment (BIGINT) | UUID (VARCHAR 36) | UUID (BINARY 16) |
|------|------------------------|-------------------|------------------|
| PK Size | 8 bytes | 36 bytes | 16 bytes |
| Secondary Index Impact | Baseline | **4.5x** increase | **2x** increase |
| Buffer Pool Efficiency | Optimal | **56% degraded** | **2x cache miss** |

#### Distributed Environment Contention

| Problem | Description |
|---------|-------------|
| Collision | Multiple servers generating the same ID |
| Contention | Lock contention on a single sequence |
| Bottleneck | Only Master generates IDs in Master-Slave → single point of failure |

![](/uploads/project/EduMeet/s3-upload-optimization/section.svg)

### Alternative: Snowflake ID

Twitter's **Snowflake ID** supports both sequential ordering and distributed environments in 64 bits.

![](/uploads/project/EduMeet/s3-upload-optimization/snowflake-id.png)

**Advantages:**
- 64 bits = 8 bytes (half of UUID)
- Time-sortable (Clustered Index friendly)
- No collisions in distributed environments

The key business advantage is that **the ID itself contains information**: timestamp, datacenter ID, machine ID, and sequence number — enabling instant tracing of when and where a record was created.

**Bad: Business meaning in PK**
![](/uploads/project/EduMeet/s3-upload-optimization/snowflake-id-02.svg)

**Good: Separate PK and domain identifier**
![](/uploads/project/EduMeet/s3-upload-optimization/snowflake-id-03.svg)

### Conclusion: It Depends

| Scenario | Recommended | Reason |
|----------|-------------|--------|
| Single server, internal system | Auto Increment | Simplicity, optimal performance |
| Distributed, large-scale | Snowflake ID | No collisions + tracing info |
| External exposure needed | Auto Increment (PK) + UUID (external) | Security + performance |
| PostgreSQL | UUID v7 viable | Native support |
| MSA + Event Sourcing | ULID / UUID v7 | Time-ordered + distributed |

**In this project:**
- Image filenames: UUID (externally exposed, unpredictable)
- DB PK: Auto Increment (performance)

---

## 2. S3 Upload Method Comparison

Three methods for uploading files to S3 from Spring Boot were evaluated.

### 2.1 Stream Upload

![Stream upload architecture](/uploads/project/EduMeet/s3-upload-optimization/stream-upload.png)
*Image source: [Woowahan Tech Blog](https://techblog.woowahan.com/11392/)*

Transfers directly to S3 using HttpServletRequest's InputStream. File binaries aren't stored on the server.

**Cons:** Speed issues with large files (937MB ≈ 16 min), no image preprocessing, no progress indication

### 2.2 MultipartFile Upload

![MultipartFile upload architecture](/uploads/project/EduMeet/s3-upload-optimization/multipartfile-upload.png)
*Image source: [Woowahan Tech Blog](https://techblog.woowahan.com/11392/)*

Uses Spring's MultipartFile interface. WAS (Tomcat) saves files to a temporary directory.

![MultipartFile mechanism](/uploads/project/EduMeet/s3-upload-optimization/multipartfile-upload-02.png)
*Image source: [Woowahan Tech Blog](https://techblog.woowahan.com/11392/)*

**Pros:** Image resizing and preprocessing possible
**Cons:** Thread exhaustion risk with concurrent requests, temp file management needed

### 2.3 AWS Multipart Upload

![AWS Multipart upload](/uploads/project/EduMeet/s3-upload-optimization/aws-multipart-upload.png)
*Image source: [Woowahan Tech Blog](https://techblog.woowahan.com/11392/)*

Splits files into small parts for individual upload. Uploads directly to S3 bypassing Spring Boot.

![AWS Multipart progress](/uploads/project/EduMeet/s3-upload-optimization/aws-multipart-upload-02.gif)
*Image source: [Woowahan Tech Blog](https://techblog.woowahan.com/11392/)*

![AWS Multipart flow](/uploads/project/EduMeet/s3-upload-optimization/aws-multipart-upload-03.png)
*Image source: [Woowahan Tech Blog](https://techblog.woowahan.com/11392/)*

### Comparison Table

| Feature | Stream | MultipartFile | AWS Multipart |
|---------|--------|---------------|---------------|
| File size limit | Theoretically none | Configurable | Up to 5TB |
| Server memory impact | Low | Medium | None |
| Image preprocessing | X | O | X |
| Progress indication | X | X | O |
| Implementation complexity | Low | Medium | High |

---

## 3. Image Processing Approach

### Traditional Method (Selected)

```
Client → Server upload → Image processing → S3 upload
```

Enables consistent server-side image processing with simple client implementation.

### Presigned URL Method

```
Client → Request Presigned URL → Direct S3 upload
```

Minimizes server load but requires client-side image processing.

### Selection Rationale

1. Requirement: Thumbnail generation needed for post image attachments
2. Timeline: 6 weeks (fast implementation required)
3. Consistent architecture: Server handles all processing
4. Simple client integration

---

## 4. Implementation: Cross-Platform Temp File Path

### Problem

File paths differ by OS (Windows: `C:\Users\...\Temp`, Linux: `/tmp`, macOS: `/var/folders/...`).

### Solution: Environment Variable + Default

![Environment variable code](/uploads/project/EduMeet/s3-upload-optimization/solution.png)

![](/uploads/project/EduMeet/s3-upload-optimization/solution-02.svg)

Uses `EDUMEET_UPLOAD_PATH` environment variable if set, otherwise falls back to `${java.io.tmpdir}/edumeet-upload`.

---

## 5. Result: Thumbnail Resizing Effect

![Resizing result](/uploads/project/EduMeet/s3-upload-optimization/result-thumbnail-resizing-effect.png)

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| Image size | Original | Resized | **91.8% reduction** |

**Benefits:** Improved page load speed, reduced network bandwidth, lower S3 storage costs

---

## Reference

- [MySQL UUIDs – Bad For Performance | Percona](https://www.percona.com/blog/uuids-are-popular-but-bad-for-performance-lets-discuss/)
- [Three Ways to Upload Files to S3 from Spring Boot | Woowahan Tech Blog](https://techblog.woowahan.com/11392/)
- [System Design Interview – An Insider's Guide](https://product.kyobobook.co.kr/detail/S000001033116) - Chapter 7: Design a Unique ID Generator in Distributed Systems

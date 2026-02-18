---
title: '위키 검색엔진 개요'
titleEn: 'Wiki Search Engine Overview'
description: 나무위키, 위키피디아 덤프 데이터를 MySQL에 적재하고, 커뮤니티 수준의 트래픽을 감당할 수 있는 검색엔진을 만드는 프로젝트의 개요와 서버 구성을 정리한다.
descriptionEn: Overview of the project to load Namuwiki and Wikipedia dump data into MySQL and build a search engine capable of handling community-level traffic.
date: 2026-01-27T00:00:00.000Z
tags:
  - MySQL
  - Search Engine
  - Wiki
  - Oracle Cloud
  - Architecture
category: project/WikiEngine
draft: false
---

나무위키, 위키피디아(한/영) 덤프 데이터를 MySQL에 적재하고, 실제 커뮤니티 수준의 트래픽을 감당할 수 있는 검색엔진을 만드는 프로젝트입니다.
그리고 더 나아가 다른 기능까지 만들 예정입니다.

단순히 "검색 기능을 만들었다"가 아니라, **가장 느린 상태에서 시작하여 병목이 드러날 때마다 다음 기술로 전환**하는 과정 전체를 기록합니다.

각 단계에서 성능, 구현 복잡도, 운영 비용의 트레이드오프를 비교하고, 전환이 필요한 근거를 수치로 남깁니다.

---

## 데이터

| 소스        | 포맷   | 문서 수       | 설명                                     |
| --------- | ---- | ---------- | -------------------------------------- |
| 나무위키      | JSON | 약 100만 건   | 나무마크 본문, 한국어 커뮤니티 문서                   |
| 한국어 위키피디아 | XML  | 약 216만 건   | MediaWiki XML 덤프                       |
| 영문 위키피디아  | XML  | 약 2,528만 건 | MediaWiki XML 덤프 (리다이렉트 제외 시 약 713만 건) |

위키 문서를 그대로 쓰는 것이 아니라, **실제 커뮤니티 게시판처럼 변환**하여 적재합니다:

- 위키 namespace(일반 문서, 토론, 사용자, 틀 등) → **카테고리** (게시판 개념)
- `[[분류:XXX]]` / `[[Category:XXX]]` → **태그** (해시태그 개념)
- author_id → 10만 명의 더미 유저에게 랜덤 균등 배정
- created_at → 2020~2025 범위 내 랜덤 생성
- 리다이렉트 문서 제외

결과적으로 수천만 건의 게시글, 수십만 개의 태그, 카테고리별 게시판이 갖춰진 커뮤니티 데이터셋이 됩니다.

---

## 서버 구성

**시작**은 Oracle Cloud Free Tier 3대에서 시작합니다.

| 서버 | 스펙 | 역할 |
|------|------|------|
| App Server | ARM (Ampere A1) 2코어 / 12GB RAM | Nginx + Spring Boot + MySQL |
| Monitoring #1 | AMD (E2.1.Micro) 1GB + Swap 1GB | Loki + Grafana + Nginx (HTTPS) |
| Monitoring #2 | AMD (E2.1.Micro) 1GB + Swap 1GB | Prometheus |

3대 모두 동일 VCN/서브넷에 위치하며, 서버 간 통신은 Private IP를 사용합니다.

프론트엔드는 Vercel에 배포합니다.

### 아키텍처

![](/uploads/project/WikiEngine/wiki-search-overview/architecture.png)

<!-- EN -->

This is a project to load Namuwiki and Wikipedia (Korean/English) dump data into MySQL and build a search engine capable of handling community-level traffic, with plans to add more features.

Rather than simply "building a search feature," this project records the entire process of **starting from the slowest state and transitioning to the next technology whenever bottlenecks emerge**.

At each stage, we compare trade-offs of performance, implementation complexity, and operational cost, documenting the rationale for transitions with metrics.

---

## Data

| Source | Format | Documents | Description |
|--------|--------|-----------|-------------|
| Namuwiki | JSON | ~1M | Namuwiki markup content, Korean community documents |
| Korean Wikipedia | XML | ~2.16M | MediaWiki XML dump |
| English Wikipedia | XML | ~25.28M | MediaWiki XML dump (~7.13M excluding redirects) |

Wiki documents are not used as-is but **transformed to resemble a real community bulletin board**:

- Wiki namespaces (articles, discussions, users, templates) → **Categories** (board concept)
- `[[분류:XXX]]` / `[[Category:XXX]]` → **Tags** (hashtag concept)
- author_id → Randomly distributed among 100K dummy users
- created_at → Randomly generated within 2020-2025 range
- Redirect documents excluded

The result is a community dataset with tens of millions of posts, hundreds of thousands of tags, and category-based boards.

---

## Server Configuration

**Starting** with 3 Oracle Cloud Free Tier instances.

| Server | Specs | Role |
|--------|-------|------|
| App Server | ARM (Ampere A1) 2 cores / 12GB RAM | Nginx + Spring Boot + MySQL |
| Monitoring #1 | AMD (E2.1.Micro) 1GB + 1GB Swap | Loki + Grafana + Nginx (HTTPS) |
| Monitoring #2 | AMD (E2.1.Micro) 1GB + 1GB Swap | Prometheus |

All 3 instances are in the same VCN/subnet, using Private IPs for inter-server communication.

Frontend is deployed on Vercel.

### Architecture

![](/uploads/project/WikiEngine/wiki-search-overview/architecture.png)

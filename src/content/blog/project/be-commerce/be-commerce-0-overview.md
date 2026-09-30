---
title: 'BE-commerce: 결제 실패를 정합하게 되돌리는 모듈형 모놀리스'
description: 'BE-commerce는 주문·결제·정산·대사·추천을 하나의 Spring Modulith 애플리케이션으로 구현한 이커머스 백엔드입니다. 기능 소개보다 실패를 재현하고 측정해 경계를 정한 글을 영역별로 모았습니다.'
date: 2026-07-08
tags:
  - Payment
  - Spring Boot
  - Spring Modulith
  - Java 21
  - MySQL
  - Redis
  - Kafka
category: study/be-commerce
coverImage: "/uploads/project/be-commerce/diagrams/architecture.svg"
draft: false
series: "BE-commerce"
seriesOrder: 0
---

BE-commerce는 주문부터 결제, 원장, 정산·대사, 추천까지를 하나의 Spring Modulith 애플리케이션으로 구현한 이커머스 백엔드입니다. 이 시리즈에서 다루는 질문은 “기능을 어떻게 만들었나”보다 **실패했을 때 무엇을 확정하고, 무엇을 모르는 상태로 남기며, 어떤 숫자를 측정한 뒤 선택했는가**에 가깝습니다.

예를 들어 결제 타임아웃을 실패로 확정하면 이중 결제가 생길 수 있고, 요청 제한을 초당 100건으로 둔다고 해서 서버 용량이 100건/초가 되지는 않습니다. 그래서 각 글은 문제를 정의하고, 가설을 세우고, 실험 결과와 적용 범위를 분리해 적습니다.

프로젝트 소개와 실행 방법은 [저장소 README](https://github.com/dj258255/BE-commerce)에 있습니다. 아래 지도에서 영역을 고르면 해당 영역의 글만 볼 수 있습니다. 처음 읽는다면 `유입·인증`에서 인증 비용과 요청 제한을 읽은 뒤, `결제`와 `정산·대사`, `개인화` 순서로 이동하면 시스템의 경계가 자연스럽게 이어집니다.

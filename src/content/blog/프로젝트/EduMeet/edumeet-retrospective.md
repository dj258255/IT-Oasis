---
title: 'EduMeet - 첫 팀 프로젝트를 마무리하며'
titleEn: 'EduMeet - Wrapping Up My First Team Project'
description: 청각장애인을 위한 온라인 교육 플랫폼 EduMeet을 6주간 개발하며 배운 것들을 정리했습니다.
descriptionEn: A retrospective on building EduMeet, an online education platform for the hearing-impaired, over 6 weeks.
date: 2025-08-15
tags:
  - Retrospective
  - Spring Boot
  - JPA
  - MySQL
  - AWS S3
category: 프로젝트/EduMeet
coverImage: /uploads/프로젝트/EduMeet/retrospective/title.png
draft: false
---

## 프로젝트 소개

EduMeet은 **실시간 음성-자막 변환으로 청각장애인의 학습을 지원하는 온라인 교육 플랫폼**입니다. 한국수어통역사협회 자료에 따르면 수화 통역사 대비 청각장애인 비율이 1:300이라고 합니다. 온라인 강의에서 청각장애인은 자막 없이는 학습이 사실상 불가능한데, AI 음성인식으로 실시간 자막을 제공하면 이 문제를 크게 개선할 수 있다고 판단했습니다.

![EduMeet 아키텍처](/uploads/프로젝트/EduMeet/retrospective/architecture.png)

**기간**: 2025.07.07 - 2025.08.15 (6주)
**팀 구성**: 6명 (프론트엔드 3명, 백엔드 3명)
**기술 스택**: Java, Spring Boot, JPA, QueryDSL, MySQL, AWS S3, Docker

---

## 내 역할

백엔드 개발(기여도 33%)을 담당했습니다. 구체적으로는 **게시판 CRUD**, **이미지 업로드**, **단위테스트** 전반을 맡았습니다.

첫 팀 프로젝트라서 "기능 구현"에만 집중할 줄 알았는데, 실제로는 기능 구현보다 **방어 로직과 테스트 코드**에 훨씬 더 많은 시간을 쏟았습니다.

---

## 주요 구현

### N+1 문제 해결 (66.9% 성능 개선)

게시판 목록 조회 시 쿼리가 게시글 수에 비례해서 증가하는 N+1 문제를 발견했습니다. `@BatchSize(20)`으로 IN절 배치 조회를 적용해 쿼리 수를 11개에서 2개로 줄이고, 응답 시간을 38.23ms에서 12.66ms로 **66.9% 개선**했습니다.

> 상세 분석: [N+1 문제 분석과 해결](/blog/프로젝트/EduMeet/n-plus-1-issue)

### 127개 단위테스트 & H2 전환

MySQL로 테스트를 돌리면 9.57초가 걸렸는데, H2 인메모리 DB로 전환하니 5.23초로 **45% 빨라졌습니다**. 단위테스트는 H2, 통합테스트는 MySQL로 이원화했습니다.

127개 테스트 케이스 중 절반 이상이 "빈 제목으로 등록하면?", "좋아요가 Integer.MAX_VALUE를 넘으면?" 같은 **비정상 상황 대응** 테스트였습니다.

> 상세 분석: [단위테스트 DB 마이그레이션](/blog/프로젝트/EduMeet/unit-test-db-migration)

### S3 이미지 업로드 최적화

원본 이미지(5MB)를 그대로 저장하면 스토리지 비용이 문제가 됩니다. 이미지 리사이징으로 **91.8% 용량을 감소**시키고, DB PK는 Auto Increment로, 파일명은 UUID로 역할을 분리했습니다.

> 상세 분석: [S3 업로드 최적화](/blog/프로젝트/EduMeet/s3-upload-optimization)

---

## 기억에 남는 트러블슈팅

### OneToMany 중간테이블 자동 생성

Board-BoardImage 1:N 관계를 설정했는데, JPA가 엉뚱하게 `board_image_set`이라는 중간테이블을 자동으로 만들어버렸습니다. ERD에 없는 테이블이 갑자기 생기니 팀원들이 혼란스러워했죠.

원인은 `@OneToMany`에 `mappedBy`를 지정하지 않아서 단방향 연관관계로 인식한 것이었습니다. `mappedBy = "board"`를 추가하니 깔끔하게 해결됐습니다.

> 상세 분석: [OneToMany 중간테이블 문제](/blog/프로젝트/EduMeet/onetomany-join-table)

### QueryDSL 파일 이동 오류

레이어드 아키텍처를 적용하려고 Repository 파일을 옮기면서 클래스명을 바꿨더니 "No property searchAll found for type Board" 에러가 발생했습니다. Spring Data JPA의 **인터페이스명 + Impl 네이밍 규칙** 때문이었는데, 이걸 몰랐으면 한참 헤맸을 겁니다.

> 상세 분석: [파일 이동 오류](/blog/프로젝트/EduMeet/file-move-error)

---

## 느낀 점

### 기능보다 방어 로직이 중요하다

게시판 CRUD 기능 구현은 3일 만에 끝났습니다. 그런데 테스트 코드를 작성하면서 비정상 상황을 하나씩 따져보니, 방어 로직 구현에 5일이 더 걸렸습니다. **기능이 동작한다와 서비스가 안전하다는 다르다**는 걸 처음으로 체감했습니다.

### 코드 리뷰의 가치

GitLab MR 기반 코드 리뷰를 도입했습니다. "왜 이렇게 구현했나요?"라는 질문에 답하려면 공식 문서를 확인하고 근거를 정리해야 했습니다. 번거롭지만, 이 과정 덕분에 모든 코드에 "왜 이렇게 했는가"의 근거를 준비하는 습관이 생겼습니다.

### 완성의 경험

2주차에 기능 목록이 일정 대비 많다는 걸 깨닫고, **핵심 기능부터 완성하자**고 제안했습니다. 게시판 CRUD → 이미지 업로드 → WebRTC 순서로 우선순위를 정하고, 매일 작은 단위로 완성해나갔습니다. 6주 안에 기획부터 배포까지 마무리한 첫 경험이었습니다.

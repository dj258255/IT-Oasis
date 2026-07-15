---
title: '기능은 풍부한데 남이 못 쓰는 상태였습니다 — 셀프호스트 제품으로'
titleEn: 'Feature-Rich but Nobody Could Actually Use It — Turning It into a Self-Host Product'
description: '이기종 DBMS 운영 관리 플랫폼 DBTower 14편. 기능은 KDMS 레퍼런스를 넘어섰는데, 정작 "남이 클론해서 실제로 쓸 수 있나"를 물으니 답이 아니었습니다. 라이선스가 없어 법적으로 아무도 못 쓰고, 암호화 fail-closed가 하필 셀프호스트가 쓰는 docker 프로필만 비껴가 대상 DB 비밀번호가 평문으로 저장되고, 비밀번호 컬럼이 든 옛 H2 파일이 커밋돼 있고, AI 판단 규칙 파일이 이미지에서 빠져 빈 프롬프트로 돌고 있었습니다. 이 편은 이 프로젝트를 포트폴리오에서 실제 셀프호스트 제품으로 끌어올리는 아크의 시작입니다. Phase 0(배포 블로커) 넷을 없애며 발견한 반복되는 착각 — "대상을 향한 기능은 됐는데 플랫폼 자신을 향한 기능이 비어 있다" — 을 라이브 실측과 함께 기록합니다.'
descriptionEn: 'Part 14 of DBTower. The features had already surpassed the KDMS reference, but when I asked "can a stranger clone this and actually run it?", the answer was no. No license meant nobody could legally use it; the encryption fail-closed guard happened to miss exactly the docker profile self-host uses, so target-DB passwords were stored in plaintext; an old H2 file with a password column was committed; and the AI judgment-rules file was excluded from the image, running on an empty prompt. This part starts the arc that lifts the project from a portfolio piece to a real self-host product. Removing the four Phase 0 deployment blockers surfaced a recurring illusion — target-facing features work, but platform-facing features are empty — recorded with live measurement.'
date: 2026-07-15
tags:
  - Java
  - Spring Boot
  - Security
  - Self-Hosting
  - DBRE
category: personal/DBTower
coverImage: /uploads/project/dbtower/cover.svg
draft: false
series: "DBTower"
seriesOrder: 14
---

## 0. 들어가며, "되는 것"과 "남이 쓸 수 있는 것"은 다르다

지난 13편까지, DBTower는 기능적으로는 레퍼런스로 삼은 당근 KDMS를 넘어섰습니다. 5기종 통합, 시점 비교, 회귀 자동 감지, MCP, 웹 콘솔, 자연어 진단까지. 그런데 문득 다른 질문이 떠올랐습니다. **"이걸 내가 아닌 누군가가 깃허브에서 클론해서, 실제로 자기 인프라에 띄울 수 있나?"**

물어보니 답이 아니었습니다. 기능이 되는 것과 남이 쓸 수 있는 것은 완전히 다른 문제였습니다. 그래서 이 프로젝트를 **포트폴리오에서 실제 셀프호스트 제품으로** 끌어올리기로 했습니다. 아무도 못 쓰는 상태 → 한 명 → 한 팀 → 여러 팀 → 수천 대. 이 순서로 벽을 하나씩 허무는 긴 아크의 시작입니다. 이번 편은 그 첫 계단, **"아무도 못 쓰는 이유"** 를 없앤 기록입니다.

## 1. 준비도 감사 — 세 방향으로 나를 훑다

혼자 훑으면 자기 코드에 관대해집니다. 그래서 서브에이전트 셋에게 각각 다른 축을 맡겨 병렬로 감사했습니다. 온보딩·배포(남이 클론→실행할 수 있나), 운영·보안 설정(비밀·TLS·자기 백업), 라이선스·릴리스 위생(법적으로 배포 가능한가). 각 축은 코드를 정독하고 근거를 웹서칭으로 대조했습니다.

결과는 좋은 소식 반, 나쁜 소식 반이었습니다. 좋은 쪽은 이미 탄탄한 것들이 있었다는 겁니다 — 공개 GHCR 멀티아치 이미지가 익명으로 pull되고, admin 부트스트랩은 랜덤 비밀번호에 `admin/admin`을 명시적으로 거부하고, 커밋된 실제 비밀은 없었습니다. 나쁜 쪽은, 정작 배포를 성립시키는 것들이 통째로 비어 있었다는 겁니다.

## 2. 반복된 착각 — 대상을 향한 것은 됐는데, 나 자신을 향한 것이 없다

감사에서 가장 인상적이었던 건 개별 결함이 아니라 **그 결함들이 공유하는 패턴**이었습니다. DBTower는 **관리 대상 DB를 향한(target-facing) 기능**은 갖췄는데, **플랫폼 자신·사용자를 향한(platform-facing) 기능**이 비어 있었습니다. 이름이 비슷해서 "그것도 이미 됐겠지"라는 착각을 반복해서 불렀습니다.

- 대상 DB 접속은 **TLS**로 암호화합니다(`useTls`, 마이그레이션까지 있음). 그런데 사용자가 웹 콘솔에 접속하는 **웹 HTTPS**는 없습니다 — 평문 8080.
- 대상 DB 백업을 **원격 S3에 오프사이트 보관**합니다. 그런데 사용자·모든 자격증명·정책·이력을 담은 **플랫폼 자신의 메타 DB 백업**은 없습니다 — 볼륨 하나에만 의존.
- 로그인 실패를 **감사 로그로 기록**합니다. 그런데 **로그인 rate-limit·계정 잠금**은 없습니다 — 브루트포스가 그대로 뚫립니다.

이 패턴을 알고 나니, 남은 감사 결과가 전부 이 렌즈로 다시 읽혔습니다. "관제탑이 대상은 지키는데 자기 자신은 못 지키고 있었다." 이번 아크는 그 platform-facing 절반을 채워가는 이야기입니다. 그 시작이 Phase 0, 배포 자체를 막고 있던 네 개의 블로커입니다.

## 3. Phase 0 — 남이 못 쓰던 이유 넷

### 넷 중 하나는 코드가 아니라 파일 하나였다

**라이선스가 없었습니다.** 루트에도, 소스 헤더에도, README에도. 저작권 기본값은 "All Rights Reserved"입니다. 공개 저장소에 올리고 GHCR로 이미지를 배포해도, 그건 "사용 허가"가 아닙니다. 남이 복사·수정·재배포·셀프호스트하는 것이 **법적으로 금지된** 상태였습니다. 기능을 아무리 쌓아도 이 파일 하나가 없으면 나머지 전부가 "있어도 못 쓰는" 상태가 됩니다.

Apache-2.0 전문을 `LICENSE`로 넣고, `NOTICE`에 번들 재배포 고지를 달았습니다. 이미지가 MySQL 드라이버(GPLv2 + Universal FOSS Exception)와 Oracle 드라이버(독점 Free Use Terms), mysqldump·pg_dump 같은 CLI를 함께 담아 배포하기 때문에, 그 라이선스들을 고지할 의무가 따라옵니다.

### 가장 아팠던 건, 가드가 하필 그 경로만 비껴간 것

두 번째가 이 아크에서 제일 뼈아팠습니다. 인스턴스 접속 비밀번호는 AES-256-GCM으로 암호화해 저장합니다. 그리고 키가 없으면 조용히 평문으로 저장되는 사고를 막으려고, **운영 프로필에서는 키가 없으면 기동을 거부**하는 fail-closed 가드를 이미 만들어 뒀습니다(CWE-312 방어).

그런데 그 가드는 프로필이 정확히 `prod`일 때만 작동했습니다. **정작 셀프호스트 컨테이너는 `docker` 프로필로 뜹니다.** 그리고 저장소 어디에도 `prod` 프로필은 없습니다. 즉 README대로 키 없이 띄우면, 가드가 있는데도 WARN 한 줄 찍고 정상 부팅한 뒤 **등록한 모든 대상 DB의 접속 비밀번호를 메타 DB에 평문으로 저장**했습니다. 가드가 없었던 게 아니라, 가드가 잘못된 문에 걸려 있었던 겁니다.

판정 대상을 `prod` 하나에서 배포 프로필 집합 `{prod, docker}`로 넓혔습니다. 다만 여기엔 함정이 하나 더 있었습니다. "dev·test 외 전부 fail-closed"로 더 세게 잡고 싶었는데, 키 없이 뜨는 `@SpringBootTest` 컨텍스트가 여덟 개나 있어서 그렇게 하면 테스트가 부팅 단계에서 무너졌습니다. 그래서 blank/dev/test는 유지하고, 배포 프로필만 명시적으로 막되, 셀프호스트 경로는 compose에서 `${DBTOWER_ENCRYPTION_KEY:?}`로 한 번 더 막는 이중 방어로 갔습니다.

직접 확인해봤습니다. `docker` 프로필에 키를 비우고 기동하니 exit 1로 거부됐고, 로그에 정확히 이렇게 남았습니다.

```
IllegalStateException: 배포 프로필(docker)에서 DBTOWER_ENCRYPTION_KEY가 없습니다
 — 인스턴스 비밀번호 평문 저장을 막기 위해 기동을 거부합니다.
```

이건 하위호환을 깨는 변경입니다. 그래서 CHANGELOG에 업그레이드 노트를 남겼습니다 — 기존에 평문으로 운영하던 사용자는 키를 설정하면 기동이 거부되므로, 키 생성 → 기동 → 각 인스턴스 한 번 재저장(그때 새 키로 암호화됨) 절차를 안내했습니다. 보안 수정이 사용자를 갑자기 막아 세우는 것도 부채라서, 막는 것과 안내하는 것을 같이 해야 했습니다.

### 공개 저장소에 나가면 안 되는 것이 하나 있었다

세 번째는 `data/dbhub.mv.db`였습니다. 2.3MB짜리 옛 H2 데이터베이스 파일이 커밋돼 추적되고 있었고, 안에는 `USERS(USERNAME, PASSWORD)` 테이블이 들어 있었습니다. 앱은 이 파일을 쓰지 않는(프로덕션은 PostgreSQL 메타 DB, 테스트는 인메모리 H2) 고아 파일이었지만, 비밀번호 컬럼이 든 바이너리 DB는 공개 저장소에 나갈 물건이 아닙니다. `git rm`으로 제거하고 `data/`를 gitignore에 넣었습니다. (히스토리 자체를 세척하는 건 파괴적이라, 공개 직전 사용자가 결정할 일로 남겨뒀습니다 — 임의로 히스토리를 다시 쓰지 않습니다.)

### 내세운 기능이 배포 이미지에서 조용히 죽어 있었다

네 번째는 발견하기 전엔 몰랐을 종류였습니다. README가 내세운 "판단 기준 문서를 프롬프트로 쓰는 일관된 AI 분석"이, 정작 셀프호스트 이미지에서는 **항상 빈 프롬프트로** 돌고 있었습니다. `.dockerignore`가 `docs` 디렉터리를 통째로 제외하는데, AI 판단 규칙 파일(`ai-analysis-rules.md`)이 바로 그 안에 있었기 때문입니다. 코드는 파일이 없으면 빈 문자열로 넘어가게 방어돼 있어서 크래시는 안 났지만, 그 방어가 오히려 "조용히 가치가 사라지는" 걸 만들었습니다.

`.dockerignore`에 그 파일만 예외로 다시 포함시키고(`!docs` → `docs/*` → `!docs/ai-analysis-rules.md`), Dockerfile에 `COPY docs/ai-analysis-rules.md` 한 줄을 넣었습니다. 이 예외가 실제로 먹는지가 미심쩍어서, 전체 이미지 빌드 대신 `busybox`에 그 파일만 `COPY`하는 가벼운 빌드로 확인했습니다 — 컨텍스트에 파일이 포함돼 빌드가 성공했습니다. compose에는 `ANTHROPIC_API_KEY`를 배선해 키를 주면 AI가 실제로 켜지게 했습니다.

## 4. 이번 계단에서 배운 것

Phase 0의 네 항목은 코드 난이도로 보면 시시합니다. 파일 하나, 조건 하나, `git rm` 하나, `COPY` 한 줄. 그런데 이 시시한 것들이 없으면 위에 쌓은 모든 기능이 "있어도 못 쓰는" 상태가 됩니다. **제품화의 첫 계단은 화려한 기능이 아니라, 배포를 성립시키는 위생**이라는 걸 다시 확인했습니다.

그리고 반복된 착각 — 대상을 향한 기능과 플랫폼 자신을 향한 기능을 이름이 비슷하다고 같은 것으로 여긴 것 — 이 다음 계단들의 지도가 됐습니다. 다음 Phase 1은 그 platform-facing 절반의 본론입니다. 웹 HTTPS, 메타 DB 자기 백업, 로그인 잠금. 관제탑이 자기 자신을 지키기 시작하는 이야기로 이어집니다.

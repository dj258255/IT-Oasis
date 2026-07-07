---
title: '내가 만든 걸 감사하다 — 4축 감사에서 나온 것들을 실제로 고치기'
titleEn: 'Auditing What I Built: Turning a Four-Axis Audit into Real Fixes'
description: "이기종 DBMS 운영 관리 플랫폼 DBTower 13편. 심화 아크 넷을 끝낸 뒤, 만든 것을 스스로 감사했습니다 — 동시성·자원누수, 기종별 정확성, 보안, HA·수명주기 네 축을 병렬로 훑고 OWASP·CWE·벤더 문서까지 웹서칭으로 대조했죠. 나온 결함을 전부 고치진 않았습니다. 코드로 재검증하고 근거를 확인해 FIX와 SKIP을 갈랐고, 그 결정 자체를 로드맵에 남겼습니다. 흥미로운 세 장면 — 내 코드가 이미 정답을 알고 있던 곳(DeepAnalyzer는 XXE를 올바르게 막는데 파서 세 곳만 빠졌다), 병렬화가 되살린 함정(스케일 아크가 커넥션 풀 경합을 키웠다), 그리고 실측이 감사를 다시 이긴 순간(감사는 마이크로초가 안 저장된다 했지만 실제로는 저장돼 수정이 작동했다)을 라이브 실측과 스크린샷으로 기록합니다."
descriptionEn: "Part 13 of DBTower. After finishing four deepening arcs, I audited what I had built — sweeping four axes (concurrency/resource leaks, per-engine correctness, security, HA/lifecycle) in parallel and cross-checking against OWASP, CWE, and vendor docs via web search. I didn't fix everything. I re-verified each finding against code, confirmed the evidence, split FIX from SKIP, and left the decisions themselves in a roadmap. Three scenes stand out — where my own code already knew the right answer (DeepAnalyzer blocks XXE correctly, three parsers didn't), where parallelization revived a trap (the scale arc amplified connection-pool contention), and where live measurement beat the audit again (the audit said microseconds aren't stored, but they were, so the fix works) — all recorded with live measurement and screenshots."
date: 2026-07-07
tags:
  - Java
  - Spring Boot
  - Security
  - Concurrency
  - DBRE
  - Code Audit
category: personal/DBTower
coverImage: /uploads/project/dbtower/cover.svg
draft: false
series: "DBTower"
seriesOrder: 13
---

## 0. 들어가며 — 만든 사람이 만든 걸 감사할 때

앞 편의 심화 아크 넷(플랜 플립 5기종·p95 정직 등급·데드락 축·스케일 제어)을 끝낸 뒤, 스스로에게 물었습니다. "이제 여기저기 에러사항·애로사항이 있을 텐데, 뭐가 있지?" 그래서 **내가 만든 걸 감사**하기로 했습니다.

혼자 훑으면 놓칩니다. 그래서 네 개의 축으로 **병렬 감사**를 돌렸어요 — (1) 동시성·자원누수, (2) 기종별 정확성·버전 호환, (3) 보안, (4) HA·수명주기. 각 축은 코드를 정독하고, **웹서칭으로 OWASP·CWE·벤더 문서와 대조**해 "이건 진짜 깨지나"를 확인했습니다.

나온 결함은 스무 개가 넘었습니다. 그런데 여기서 중요한 판단이 하나 있었어요 — **전부 고치지 않는다.**

## 1. 전부 고치지 않는다 — FIX와 SKIP을 가르다

감사 결과를 받자마자 코드로 재검증했습니다. 어떤 건 확인됐고, 어떤 건 우리가 명시한 전제(지원 버전·데모 환경) 안에선 문제가 아니었어요. 그래서 각 항목을 FIX / SKIP으로 갈라 **로드맵 문서**에 근거와 함께 남겼습니다.

- **SKIP** 예: MySQL 5.7·PostgreSQL 12 이하 비호환 → 우리는 8.0/13+를 명시 지원. Oracle `v$` vs `gv$`(RAC) → 데모는 단일 인스턴스 Oracle Free. ShedLock 쿨다운의 노드 로컬 한계 → 이미 코드 주석이 인정한 것이고 완전 해소는 큰 변경. 이런 건 "지원 전제"로 문서화하고 지나갑니다.
- **FIX** 예: XXE, 삭제 시 자원 누수, 커넥션 풀 경합, 타임존 미고정, sub-second 슬로우쿼리 0ms…

"확실하게 검증하고 진짜 고쳐야 하는지" 판단하는 것 자체가 감사의 절반이었습니다. 안 고쳐도 되는 걸 고치는 것도 부채니까요.

실제 수정은 파일 소유권이 겹치지 않는 **세 워크스트림으로 나눠 병렬**로 했습니다(보안 / 수명주기·동시성 / 기종정확성·타임존). 서로 다른 파일만 만지니 충돌 0으로 합쳐졌고, 신규 단위 28건이 붙었습니다.

## 2. 세 장면

수정 자체보다, 감사가 드러낸 **세 장면**이 이 아크의 진짜 이야기였습니다.

### 장면 1 — 내 코드가 이미 정답을 알고 있었다

가장 심각한 건 XXE(XML 외부 엔티티)였습니다. 데드락 XML과 실행계획 XML을 파싱하는 세 곳이 `load-external-dtd=false`만 걸어놨는데, 이건 OWASP가 **"불충분"**이라 명시한 조합이에요. 악성·중간자 공격된 대상 DB가 조작된 XML을 주면, DBTower 호스트가 외부로 요청을 날리는 블라인드 SSRF가 가능합니다.

그런데 감사가 짚은 결정적 사실 — **같은 저장소의 `DeepAnalyzer`는 이미 `disallow-doctype-decl=true`로 올바르게 막고 있었습니다.** 즉 설계를 몰랐던 게 아니라, 나중에 만든 파서 세 곳에 그 기준을 안 옮긴 **일관성 누락**이었어요. 고치는 건 각 파서에 한 줄씩. 하지만 이걸 스스로 못 찾았다면, "우리 XML은 서버가 주는 거니 안전하겠지"라는 방심으로 남았을 겁니다.

### 장면 2 — 병렬화가 되살린 함정

인스턴스별 커넥션 풀이 max=2인데, 같은 인스턴스에 폴러가 8개 넘게 붙습니다(스냅샷·운영경보·SLO·백업·이상·회귀·Advisor·스코어). 3번째 동시 요청부터 대기하다 타임아웃 → SnapshotScheduler가 이걸 "죽은 대상"으로 오인해 최대 16분 백오프 + 허위 "수집 정지" 경보를 냅니다. **자원 경합이 곧 허위 장애 신호로 증폭**되는 거죠.

아이러니한 건, 바로 앞 편의 스케일 제어 아크에서 넣은 **수집 병렬화(워커 4개)가 이 경합을 키웠다**는 것입니다. 성능을 위한 병렬화가 풀 경합이라는 옛 함정을 되살린 셈이에요. 풀 크기를 설정값으로 올리고(2→6), 지터에 상한을 씌우고, `Future.get`의 예외 처리를 바로잡아 정리했습니다. "개선이 다른 곳에 부채를 만든다"는 걸 감사가 아니었으면 몰랐을 겁니다.

### 장면 3 — 실측이 감사를 다시 이겼다

감사는 MySQL slowQueries가 1초 미만 쿼리를 **0ms로 보고**한다고 지적했습니다(`TIME_TO_SEC`가 정수 반환). 맞는 지적이에요. 그런데 감사는 한 걸음 더 나가 "게다가 `log_output=TABLE`은 마이크로초를 애초에 저장 안 하니 복구도 불가"라고 했습니다.

수정(`+ MICROSECOND(query_time)/1000`)을 넣고 **직접 확인**해봤더니 — `mysql.slow_log`의 원본이 `00:00:00.600594`였습니다. **마이크로초가 저장돼 있었어요.** 감사의 "TABLE은 초 단위 절삭" 가정은 이 MySQL 버전에선 틀렸고, 그래서 수정이 실제로 작동했습니다. 0.6초 쿼리가 이제 600.594ms로 정확히 나옵니다.

![슬로우쿼리 카드 — sub-second 쿼리가 실측 ms로(SLEEP 0.58=581ms, 0.75=750ms). 구코드는 전부 0. 시각은 UTC로 고정](/uploads/project/dbtower/slowquery-subsecond.png)

감사 문서를 그대로 믿고 "TABLE이라 어쩔 수 없다"며 넘어갔다면 이 수정을 안 했을 겁니다. 앞 편의 데드락에서 "ring_buffer 쓰지 마라"는 조사를 라이브가 뒤집었던 것과 똑같은 교훈 — **실측이 문서를 이깁니다.** 이번엔 그 문서가 내가 시킨 감사였다는 게 다를 뿐이죠.

## 3. 라이브로 확인한 것들

수정은 테스트가 초록이어도 라이브로 봐야 믿습니다.

- **sub-second 슬로우쿼리**(장면 3): 위 스크린샷. 구코드 0 → 실측 ms.
- **삭제 시 정리**: 임시 인스턴스를 등록·수집시켜 query_snapshot 32행을 만든 뒤 삭제하니 **0행**으로 — V10에서 넣은 FK `ON DELETE CASCADE`가 자식 행을 함께 지웠습니다. 인메모리 맵(히스토그램 스냅샷·데드락 카운터·쿨다운·백오프)은 삭제 이벤트를 각 모듈이 구독해 evict하도록 배선했고요. 원래 `evictInstance`는 만들어만 두고 아무도 안 부르던 데드코드였는데, 이제 실제로 불립니다.
- **타임존 UTC 고정**: 기동·스냅샷 로그 시각이 `...Z`(UTC)로 바뀌었습니다(이전 `+09:00`). 노드 서버 TZ가 달라도 메타 DB에 저장되는 시각이 일관됩니다.
- **보안 수정**: XXE 페이로드가 파싱에서 거부되고(외부 fetch 없음), 스택 쿼리(`SELECT 1; DROP ...`)가 게이트에서 막히고, prod 프로필에서 암호화 키가 없으면 기동이 실패하는 것을 단위 테스트로 못박았습니다.

전체 스위트는 여전히 초록이고, 기존 기능(레이턴시·데드락 카드)에 회귀는 없습니다.

## 4. 마치며 — 만든 걸 의심하는 습관

이번 아크에 새 기능은 없습니다. 대신 **만든 걸 스스로 의심하는 과정**을 남겼어요. 감사를 병렬로 돌리고, 웹서칭으로 대조하고, 코드로 재검증하고, 전부 고치는 대신 FIX/SKIP을 근거와 함께 갈라 로드맵에 적고, 고친 뒤엔 라이브로 확인하고, 그 결정과 실측을 문서에 남기는 것.

세 장면이 알려준 건 결국 같은 이야기였습니다 — **정답은 종종 내 코드 어딘가에 이미 있고(DeepAnalyzer), 개선은 다른 곳에 부채를 남기며(병렬화), 문서는 실측 앞에서 틀릴 수 있다(마이크로초).** 이걸 아는 유일한 방법은 만든 걸 의심하고 직접 돌려보는 것뿐이더군요.

정직한 잔여도 남깁니다 — 저장 컬럼의 `Instant` 전환, 쿨다운의 메타 DB 외부화, 대규모 보존의 배치 삭제는 이번 범위 밖으로 로드맵에 적어뒀습니다. 다음에 팔 곳의 지도죠.

로드맵·감사 결과·수정·실측 기록 전체는 [GitHub](https://github.com/dj258255/dbtower)에 있습니다.

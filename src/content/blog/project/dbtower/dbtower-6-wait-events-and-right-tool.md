---
title: 'DBA가 매일 보는 화면, 그리고 JPA/Native Query로 통일 안 한 이유'
titleEn: "The Screen a DBA Opens Every Day — and Why I Didn't Unify Everything Under JPA"
description: "이기종 DBMS 운영 관리 플랫폼 DBTower 6편. load%가 '어떤 쿼리가 시간을 쓰나'를 답한다면 Wait Event는 '그 시간에 무엇을 기다렸나'(CPU/IO/Lock/Latch)를 답한다 — DBA가 장애 때 가장 먼저 보는 축을 5기종 통합으로 붙이면서, 기종마다 '대기'의 의미론이 다르다는 현실과 관제 도구가 대상 설정을 바꾸지 않는 정직성 설계를 기록합니다. 그리고 'Operator 계층도 JPA+Lombok+Native Query로 추상화하면 깔끔하지 않냐'는 질문에 대한 답으로서의 적재적소 — 플랫폼 자기 저장소는 Spring Data JPA(파생 메서드·@Query·Specification 3층위), 대상 DB 조회는 JdbcTemplate과 Mongo 드라이버, 경계는 DbmsOperator 인터페이스라는 지도를 왜 그렇게 그렸는지, 감사 로그 검색을 Specification의 제자리로 든 이야기까지."
descriptionEn: "Part 6 of DBTower. If load% answers 'which query spends time,' Wait Events answer 'what did that time wait on' (CPU/IO/Lock/Latch) — the axis a DBA checks first during an incident. Unifying it across five engines surfaced how each engine means something different by 'wait,' and a control-tool honesty principle: never change the target's settings. Then the answer to 'why not abstract the Operator layer under JPA+Lombok+Native Query too': the right tool in the right place — the platform's own store uses Spring Data JPA (derived methods, @Query, Specification), target-DB reads use JdbcTemplate and the Mongo driver, and the boundary is the DbmsOperator interface."
date: 2026-07-04
tags:
  - Java
  - Spring Boot
  - DBRE
  - JPA
  - Spring Data
category: personal/DBTower
coverImage: /uploads/project/dbtower/cover.svg
draft: false
series: "DBTower"
seriesOrder: 6
---

## 0. 들어가며 — 두 개의 질문

[5편](/blog/project/dbtower/dbtower-5-production-safety)에서 운영 안전을 닫고 나니, 성격이 다른 두 가지가 남았어요. 하나는 기능의 질문 — "DBA가 장애 때 실제로 뭘 보는가?" 지금까지 DBTower의 쿼리 통계는 load%, 즉 "어떤 쿼리가 시간을 쓰나"를 답했는데, 현업 DBA가 장애 순간 가장 먼저 여는 건 그다음 질문이에요. **"그 시간에 무엇을 기다렸나"** — CPU냐 IO냐 Lock이냐 Latch냐. 이게 Wait Event 분석입니다.

다른 하나는 설계의 질문이었어요. 누군가 이렇게 물었거든요. "Operator 계층도 JPA + Lombok + Native Query로 추상화하면 더 깔끔하지 않냐?" 좋은 질문이라 제대로 분석해 봤는데, 결론은 반대였습니다. 이번 편은 이 두 질문에 답하면서, 프레임워크를 어디에 쓰고 어디에 안 쓸지를 정리한 기록이에요.

## 1. Wait Event — "무엇을 기다렸나"를 5기종으로

load%가 "누가 시간을 쓰나"라면 Wait Event는 "무엇을 기다렸나"예요. `DbmsOperator`에 메서드 하나(`waitEvents`)를 추가해서 5기종을 통합했습니다. 4편부터 말해온 "새 능력 = 인터페이스 메서드 1개"를 또 한 번 실측한 셈이에요.

그런데 여기서 중요한 건, 기종마다 **"대기"의 의미론 자체가 다르다**는 거였어요. 같은 이름의 기능이라고 같은 걸 답하는 게 아닙니다.

| 기종 | 소스 | 의미 |
|---|---|---|
| MySQL | events_waits_summary_global_by_event_name | 기동 이후 누적(피코초→ms) |
| PostgreSQL | pg_stat_activity (active 세션) | 현재 순간 스냅샷 — 무부하면 빈 배열 |
| SQL Server | dm_os_wait_stats | 기동 이후 누적, idle/백그라운드 필터 |
| Oracle | v$system_event (Idle 제외) | 기동 이후 누적(마이크로초→ms), wait_class |
| MongoDB | serverStatus 대기 큐 + WT 티켓 | 현재 게이지 — wait event가 아니라 대기 지표 |

누적 카운터(MySQL·MSSQL·Oracle)와 현재 순간 스냅샷(PostgreSQL·MongoDB)이 섞여 있어요. PostgreSQL을 무부하 구간에 조회하면 빈 배열이 나오는데, 이건 버그가 아니라 스냅샷 방식의 정직한 결과입니다.

```
MySQL:  wait/io/table/sql/handler io count=17,336,000 totalMs=3705.36
PG:     [] — 무부하 구간, 스냅샷 방식의 정직한 결과
Oracle: db file sequential read (User I/O) 24,948회, latch: shared pool 3,093회
Mongo:  globalLock.currentQueue.readers=0, WT concurrentTransactions 티켓
MCP:    도구 9종(wait_events 포함), 웹 콘솔 Monitoring 탭 카드 렌더링
```

이 기능에서 제일 신경 쓴 건 두 가지 **정직성 설계**였어요.

**하나, 관제 도구는 대상 설정을 바꾸면 안 된다.** MySQL은 wait instrument 상당수가 기본 비활성인데(349종), 이걸 켜면 더 많은 대기가 보이겠지만 그건 대상 DB의 설정을 바꾸는 행위예요. 관제 도구가 관측하려고 관측 대상을 건드리면 안 되죠. 그래서 instrument를 켜지 않고, 대신 "비활성 349종은 집계에 없음"이라고 **안 보이는 범위를 응답에 명시**했습니다.

**둘, 필터는 실측으로 보강한다.** SQL Server는 1차 응답에서 `SOS_WORK_DISPATCHER` 같은 idle 대기가 8억 ms로 화면을 도배했어요. 교과서적인 idle 필터 목록이 있긴 하지만, 실제 응답을 보고 무엇이 노이즈인지 확인한 뒤 필터를 보강했습니다.

![Wait Events — 그 시간에 무엇을 기다렸나, 비활성 instrument 범위까지 응답에 명시](/uploads/project/dbtower/wait-events.png)

## 2. "JPA + Native Query로 통일하면 되지 않냐"에 대한 답

이제 두 번째 질문이에요. 다섯 기종을 다루니까, "Operator도 JPA로 추상화하고 시스템 뷰 조회는 Native Query로 하면 깔끔하지 않냐"는 제안이 자연스러워 보였어요. 그런데 분석해 보니 방향이 반대였습니다.

Operator가 붙는 대상은 **런타임에 등록되는 N개의 남의 DB**예요. JPA는 부팅 시점에 데이터소스가 고정되고 엔티티가 매핑되는 걸 전제로 하는데, 이 둘은 근본적으로 안 맞아요. 게다가 Operator가 읽는 건 `performance_schema`나 `V$SQL` 같은 **시스템 뷰**라, 매핑할 엔티티라는 게 없습니다. Native Query는 결국 "JPA가 실행해주는 raw SQL"일 뿐인데, 매핑할 게 없는 시스템 뷰에 얹으면 오히려 의식만 늘어요. 결정타는 **MongoDB예요 — JPA 자체가 없습니다.**

그래서 추상화 경계를 JPA/JDBC보다 **위**에 뒀어요. `DbmsOperator` 인터페이스가 그 경계인데, 이건 사실 우리가 익숙한 Spring Data의 **Repository + Impl과 같은 모양**입니다. 인터페이스가 능력을 선언하고, 기종별 구현체가 각자의 기술로 그걸 채우는 구조죠. 경계를 위에 두면 안쪽에서는 각 기술을 제자리에 쓸 수 있어요.

## 3. 적재적소 — Lombok과 JdbcTemplate을 딱 필요한 곳에만

경계를 정하고 나니, 안쪽 정리는 오히려 명쾌했어요. 두 가지를 손봤습니다.

**Lombok은 JPA 엔티티에만.** 값 객체는 `record`로 불변을 유지하고, Lombok은 JPA 엔티티 6묶음에만 `@Getter`와 `@NoArgsConstructor(PROTECTED)`로 넣었어요. `@Data`·`@ToString`·`@EqualsAndHashCode`는 일부러 뺐습니다 — 엔티티의 lazy 연관과 hashCode에 지뢰가 되거든요. 이렇게 해서 손으로 쓴 게터 43개를 지웠어요. "Lombok을 쓴다"가 아니라 "어디에 쓰면 안전한가"를 정한 거예요.

**JdbcTemplate은 Operator의 조회 메커니즘에만.** Operator에 남아 있던 raw `try-with-resources` + `ResultSet` 루프를 JdbcTemplate으로 바꿨어요. 중요한 건 **SQL은 한 글자도 안 바꿨다**는 겁니다 — 시스템 뷰를 어떻게 읽을지에 대한 통제는 그대로 두고, 실행 메커니즘만 정리했어요. 순 -53줄(283 삭제/230 추가) 나왔습니다.

여기서도 무리하지 않았어요. Oracle의 explain은 세션 지역 `PLAN_TABLE`을 써서 `ConnectionCallback`로 남기고, 서버 사이드 백업은 raw JDBC 그대로 뒀습니다. 억지로 JdbcTemplate에 밀어 넣으면 정확성이 깨지는 지점이라, 정직하게 남긴 거예요.

## 4. 감사 로그 검색 — Specification의 제자리

정리하면서 하나 더 든 게 감사 로그 검색이에요. 앞선 리팩터에서 "정적 쿼리를 커스텀 프래그먼트로 감싸는 건 과설계"라고 판단했었는데, 그 판단의 **짝**이 이겁니다. Specification이 정말 값을 하는 건 **필터가 런타임에 조립되는 동적 쿼리**일 때예요. 감사 로그 검색이 정확히 그 경우였습니다.

5편에서 감사 로그가 쌓이기 시작하니 "누가 무엇을 했나"를 좁혀 볼 방법이 필요해졌어요. 필터는 사용자·action·인스턴스·결과코드·기간 6종인데, 어느 것이든 있을 수도 없을 수도 있습니다. 이걸 파생 메서드나 `@Query`로 풀면 조합 수만큼 메서드가 폭발해요(`findByPrincipal`, `findByPrincipalAndOutcome`, ... 2^6).

그래서 `JpaSpecificationExecutor`를 상속하고, 각 빌더는 파라미터가 비면 `null`을 반환("이 필터 없음")하게 했어요. 컨트롤러가 null을 걸러 AND로 reduce하면, 필터가 늘어도 메서드가 아니라 조각 하나가 늘 뿐입니다.

```
무필터:                     9건 전체
action=explain (부분일치):  explain 2건만
outcome=200:                200 응답만
instanceId=8 & action=backup (AND): 인스턴스 8의 백업 계열만
미인증 -> 401, VIEWER -> 403 (ADMIN 전용 유지)
```

이로써 Spring Data가 세 층위에서 제자리를 지키게 됐어요. 파생 메서드(정적 단순), `@Query`(정적 집계·벌크), Specification(동적 필터). "어디에 뭘 쓰나"를 기능이 결정하게 두는 거예요 — 프레임워크를 과시하려고 억지로 한 곳에 몰지 않는 거죠.

## 5. 마치며 — 정리 후 최종 지도

정리를 끝내고 보니 기술 배치가 이렇게 정리됐어요.

- **1층 — 플랫폼 자기 저장소**: Spring Data JPA. 파생 메서드(정적 단순) / `@Query`(정적 집계·벌크) / Specification(동적 필터)
- **2층 — 대상 DB 조회**: JdbcTemplate(JDBC 계열) + Mongo 드라이버(비 JDBC)
- **경계**: `DbmsOperator` 인터페이스 — 기종·기술 차이를 그 뒤로 숨긴다

리팩터 후 실 앱에서 5기종의 health·query-stats(RowMapper)·explain(Oracle은 ConnectionCallback로 TABLE ACCESS FULL 판정)·replication이 전부 리팩터 전과 동일하게 나오는 걸 확인했어요. 테스트는 91건까지 늘었고요.

돌아보면 이 프로젝트를 관통한 문장은 하나였어요. "이건 기종마다, 기술마다 어떻게 다른가"를 먼저 묻고, 그 차이를 경계 뒤로 밀어 넣는 것. 기종 차이는 `DbmsOperator` 뒤로, 소비자 차이는 채널 뒤로, 그리고 기술 차이는 각자의 제자리로. 프레임워크로 전부 통일하는 게 깔끔함이 아니라, 각 도구가 제일 잘하는 자리에 있게 두는 게 깔끔함이라는 걸 이번 정리에서 다시 배웠습니다.

코드와 실측 기록 전체는 [GitHub](https://github.com/dj258255/dbtower)에 있습니다.
</content>

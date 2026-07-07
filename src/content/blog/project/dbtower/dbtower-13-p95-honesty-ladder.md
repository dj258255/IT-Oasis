---
title: '정직 등급을 올리는 법 — 다섯 p95의 다섯 사다리'
titleEn: 'Raising the Honesty Grade: Five Ladders for Five p95s'
description: "이기종 DBMS 운영 관리 플랫폼 DBTower 13편. p95는 이미 다섯 기종에서 값을 냈지만, 그 값의 '정직 등급'은 제각각이었습니다. MySQL은 리셋 이후 누적이라 최근 급변을 못 보고, SQL Server는 아예 미지원, PostgreSQL은 평균+표준편차 추정이었죠. 이번엔 값을 더 내는 게 아니라 등급을 올립니다. MySQL은 히스토그램 두 스냅샷을 버킷별로 차분해 '최근 구간' p95를 복원하고(누적 0.48 → 구간 0.19), SQL Server는 Query Store가 켜지면 미지원을 풀어 추정치를 내고, MongoDB는 프로파일러가 꺼져도 opLatencies 히스토그램으로 인스턴스 p95를 살려냅니다. 그리고 Oracle은 원자료가 없어 끝내 못 올린 자리로 남겨, 올린 것과 못 올린 것을 라벨로 정직하게 가릅니다. 라이브 실측에서 2^64-1 센티넬 오버플로와 최소권한 계정의 조용한 폴백까지 진짜 버그 두 개를 잡았습니다."
descriptionEn: "Part 13 of DBTower. p95 already produced values across five engines, but each value's honesty grade differed: MySQL's was cumulative-since-reset (blind to recent shifts), SQL Server was unsupported, PostgreSQL was a mean+stddev estimate. This time we don't produce more values — we raise the grade. MySQL diffs two histogram snapshots per bucket to recover a recent-window p95 (cumulative 0.48 to windowed 0.19), SQL Server lifts its unsupported label into an estimate when Query Store is on, and MongoDB keeps an instance p95 alive via opLatencies histograms even when the profiler is off. Oracle stays the one we couldn't raise (no source data), so labels honestly separate what we lifted from what we didn't. Live measurement caught two real bugs: a 2^64-1 sentinel overflow and a least-privilege account's silent fallback."
date: 2026-07-07
tags:
  - Java
  - Spring Boot
  - DBRE
  - Observability
  - MySQL
  - SQL Server
  - MongoDB
  - PostgreSQL
category: personal/DBTower
coverImage: /uploads/project/dbtower/cover.svg
draft: false
series: "DBTower"
seriesOrder: 13
---

## 0. 들어가며 — 값은 다 냈는데, 등급이 낮았다

앞선 편에서 레이턴시 백분위(p95/p99)를 다섯 기종에서 뽑았습니다. 겉으로는 표가 다 채워졌죠. 그런데 그 표에는 불편한 진실이 하나 있었어요 — **채워진 값들의 신뢰 등급이 제각각**이라는 것.

- MySQL의 p95는 DB가 직접 계산해주는 진짜 분위수지만, **리셋 이후 누적**이라 오래 뜬 서버일수록 과거에 눌려 "지금 막 느려진" 걸 늦게 반영합니다.
- SQL Server와 Oracle은 아예 **미지원**. 통계 뷰가 min/max/평균/총계만 주고 분위수도 표준편차도 안 주니까요.
- PostgreSQL은 평균+표준편차로 근사한 **추정치**. 실제 레이턴시 분포는 꼬리가 무거워서 이 근사는 대개 과소평가합니다.

그래서 이번 편의 목표는 "값을 더 내자"가 아닙니다. **이미 있는 값의 정직 등급을 한 칸씩 올리자**예요. 그리고 못 올리는 자리는 못 올린 채로 정직하게 남기자.

## 1. 라벨이 곧 계약이다

이 기능의 처음부터 지켜온 원칙이 있습니다 — **값을 절대 섞지 않는다.** 추정치를 실측인 척, 미지원을 지원하는 척하는 순간 이 기능은 거짓말이 됩니다. 그래서 값마다 그게 어디서 왔는지를 `source`로 못 박습니다. 기존엔 네 종류였어요.

`NATIVE`(누적 실측) · `COMPUTED`(원샘플 직접계산) · `ESTIMATED`(평균+표준편차 추정) · `UNSUPPORTED`(원자료 없음).

이번에 두 종류를 새로 팠습니다.

- **`NATIVE_WINDOWED`** — 누적 히스토그램을 직전 스냅샷과 버킷별로 차분해 복원한 "최근 구간" p95. 누적(NATIVE)과 달리 과거에 안 눌립니다. 단, 버킷 상한을 p95로 쓰는 **상한 근사**라 그 사실을 라벨에 새깁니다.
- **`NATIVE_HISTOGRAM`** — DB가 주는 히스토그램 버킷을 보간해 얻은 p95. 쿼리 단위가 아니라 인스턴스/컬렉션 단위일 수 있어 그 범위를 함께 표기합니다.

라벨을 늘린 건 멋있어 보이려는 게 아닙니다. "이 p95가 최근을 반영하나?", "쿼리별인가 인스턴스별인가?", "실측인가 추정인가?" — 이 질문들에 **값이 스스로 답하게** 하려는 겁니다.

## 2. 다섯 사다리

기종마다 원자료가 다르니 등급을 올리는 사다리도 다섯 개가 다 달랐습니다.

### MySQL — 누적을 최근 구간으로 (NATIVE_WINDOWED)

MySQL은 `events_statements_histogram_by_digest`에 digest당 450개 버킷의 히스토그램을 둡니다. 문제는 이것도 **재기동 이후 누적**이라는 것. 그런데 누적이라는 성질이 오히려 열쇠였어요 — **두 시점의 스냅샷을 버킷별로 빼면 그 사이 구간의 분포**가 됩니다. 거기서 누적 95%가 넘어가는 버킷의 상한(`BUCKET_TIMER_HIGH`)을 구간 p95로 씁니다.

여기엔 유혹이 하나 있습니다. `TRUNCATE`로 히스토그램을 리셋하면 즉시 깨끗한 최근 창을 얻죠. 하지만 그건 대상 DB의 상태를 바꾸는 행위 — DBTower의 "읽고 판단만" 정체성을 깨는 겁니다. **차분 방식이 바로 그 금지의 대안**이에요. 남의 통계를 건드리지 않고, 내 스냅샷 두 장으로 최근을 복원합니다.

Operator는 매 호출 새로 생성되는(상태 없는) 설계라, 직전 스냅샷은 싱글턴 빈(`HistogramSnapshotStore`)에 보관합니다. 여기서 "구간"은 곧 연속한 두 조회 사이예요 — 폴러 주기면 그 주기, 온디맨드면 "마지막으로 본 이후".

### SQL Server — 미지원을 풀다 (ESTIMATED)

SQL Server는 그동안 정직하게 `UNSUPPORTED`였습니다. 하지만 **Query Store가 켜진 DB**라면 얘기가 달라져요. `query_store_runtime_stats`에 평균과 표준편차가 있거든요. 그럼 PostgreSQL과 똑같은 규약(avg + 1.645×stdev)으로 추정치를 낼 수 있습니다 — 단, 관측된 최대값(max)으로 캡을 씌워서 추정이 실제 최댓값을 넘지 않게.

함정이 하나 있었어요. 활성 interval의 통계는 plan × execution_type별로 여러 행(in-memory + flushed)으로 나뉩니다. 그냥 평균 내면 틀려요. `count_executions`로 가중 재집계해야 맞습니다. 그리고 Query Store가 꺼진 DB(시스템 DB인 master 등)에서는? **게이트가 조용히 UNSUPPORTED로 떨어집니다.** 켜는 행위(`ALTER DATABASE`)는 절대 하지 않아요 — 그건 남의 설정을 바꾸는 거니까.

### MongoDB — 프로파일러가 꺼져도 (NATIVE_HISTOGRAM)

기존 Mongo p95는 `system.profile`의 원샘플에서 직접 계산(COMPUTED)했습니다. 문제는 **프로파일러가 꺼진 인스턴스에선 이게 전멸**한다는 것. 그런데 MongoDB는 `serverStatus.opLatencies`에 reads/writes/commands별 히스토그램을 **프로파일러와 무관하게** 항상 기록합니다. 이걸 스냅샷 차분 후 보간하면, 프로파일러가 꺼져 있어도 인스턴스 층위의 p95가 나와요. 기존 COMPUTED(쿼리 단위)는 그대로 병행하고요.

### PostgreSQL — "있으면 승격", Oracle — 못 올린 자리

PostgreSQL은 확장 `pg_stat_monitor`가 **설치돼 있으면** 그 히스토그램(resp_calls)으로 승격하고, 없으면 기존 추정치를 그대로 씁니다. HypoPG나 SQL Server Query Store에서 이미 쓰던 "있으면 쓰고 아니면 게이트" 패턴이죠.

그리고 **Oracle은 끝내 못 올렸습니다.** `v$sqlstats`에 분위수도, 표준편차도, 히스토그램도 없어요. 근사할 원자료 자체가 없습니다. 그래서 `UNSUPPORTED`로 남겼습니다 — 이게 이번 아크의 **정직성 대비군**이에요. 넷은 올리고 하나는 못 올린 걸 라벨이 정직하게 가릅니다.

## 3. 라이브 — 그리고 진짜 버그 두 개

단위 테스트(30건 추가)가 다 초록이어도, 진짜 검증은 라이브입니다. 그리고 라이브에서만 잡히는 버그가 있었어요.

**MySQL 구간 p95**부터. 첫 호출은 직전 스냅샷이 없어 "구간 학습 중"으로 누적값을 보여주고, 부하를 준 뒤 두 번째 호출에서 최근 구간이 나옵니다. 결과가 이 아크의 논지를 한 줄로 압축했어요 — 같은 `products` 쿼리가 **누적 p95=0.48 → 구간 p95=0.19**. 최근 부하가 빠른 인덱스 조회라, 과거에 눌린 누적보다 구간이 낮게 나온 겁니다. "지금 이 순간"을 본다는 게 이런 거죠.

![MySQL 레이턴시 카드 — 실측구간(NATIVE_WINDOWED)과 실측누적 폴백이 라벨로 공존](/uploads/project/dbtower/latency-windowed.png)

그런데 처음엔 모든 행이 "히스토그램 미수집 — 누적값"으로 폴백됐습니다. 제 코드가 히스토그램 조회 실패를 **조용히 삼키고** 있었거든요. 원인을 드러내려고 그 자리에 경고 로그를 심었더니 — 진짜 버그가 튀어나왔어요.

```
Value '18446744073709551615' is outside of valid range for type java.lang.Long
```

`18446744073709551615` = 2^64 − 1. MySQL 히스토그램의 **마지막 버킷 상한이 unsigned bigint 최댓값(무한대 센티넬)**인데, JDBC `getLong()`은 signed long이라 오버플로로 터진 겁니다. 단위 테스트의 합성 버킷엔 이 센티넬이 없었으니, 라이브가 아니면 절대 못 잡았을 버그예요. `BigDecimal`로 받아 해결했습니다.

버그가 하나 더 있었습니다. 모니터링 계정 `dbtower_monitor`가 `events_statements_summary_by_digest`(요약 뷰) 권한만 있고 **히스토그램 뷰 권한이 없었어요.** 그래서 조회가 Access Denied로 실패하고 — 제 코드가 정직하게 누적값으로 폴백한 겁니다. 이건 사실 설계의 승리이기도 해요. 크래시 대신 "이 권한에선 구간을 못 만든다"를 **값으로 표현**했으니까. 새 기능은 새 권한을 요구하고, 그건 최소권한 문서에 명시할 대상이죠. 뷰 읽기 권한(읽기 전용)을 추가하니 곧바로 구간 p95가 나왔습니다.

**MongoDB의 핵심 검증**은 프로파일러를 끄고 보는 거였어요. 프로파일러 레벨을 0으로 내리고 `system.profile`을 비운 뒤 부하를 주니 — **COMPUTED는 완전히 사라졌지만(0건), 인스턴스 히스토그램 p95는 살아남았습니다**(reads 3.78ms, commands 3.02ms). 프로파일러가 꺼진 인스턴스에서 이게 유일한 레이턴시 관측이 된다는 것, 그게 이 축의 존재 이유입니다.

![Mongo 레이턴시 카드 — 히스토그램(프로파일러 무관)과 직접계산이 함께](/uploads/project/dbtower/latency-histogram.png)

(솔직한 뒷이야기 하나. 이 Mongo 검증의 첫 시도는 제가 잘못된 비밀번호를 써서 부하 주입과 프로파일러 끄기가 **조용히 실패**했었습니다. COMPUTED가 안 사라진 걸 보고 "어? 프로파일러가 안 꺼졌나?" 확인하다 발견했죠. 올바른 자격증명으로 다시 검증했습니다 — 안 되는 걸 되는 것처럼 기록하지 않으려고.)

**SQL Server**는 두 방향을 다 봤어요. 시스템 DB인 master는 Query Store가 없어 UNSUPPORTED 게이트로 정직하게 스킵. Query Store를 켠 사용자 DB를 등록하니 미지원이 풀리고 추정치가 나왔습니다(join p95=0.73ms 등).

![MSSQL 레이턴시 카드 — Query Store가 켜지자 미지원이 추정으로 풀렸다](/uploads/project/dbtower/latency-estimated.png)

## 4. 마치며 — 올린 것과 못 올린 것

이번 편의 배움은 "p95를 더 정확하게"가 아니라 **"값의 정직 등급을 어떻게 표현하는가"**에 있었습니다. 같은 레이턴시 카드 안에서 이제 여섯 개의 배지가 갈립니다 — 실측누적·실측구간·히스토그램·직접계산·추정·미지원. 각 배지는 그 숫자가 얼마나 믿을 만한지, 무엇을 보고 무엇을 못 보는지를 한눈에 말해줍니다.

그리고 정직한 잔여를 남깁니다. NATIVE_WINDOWED의 "구간"은 두 조회 사이라 조회가 뜸하면 창이 길어지고, 버킷 상한 근사라 정확한 분위수는 아닙니다. Oracle은 여전히 못 올린 자리예요 — 원자료가 생기지 않는 한 UNSUPPORTED로 남습니다. 이걸 감추지 않는 게 이 기능의 값을 지키는 유일한 길이라고 생각합니다.

다섯 기종에 다섯 개의 사다리를 놓았지만, 하나는 사다리를 못 놓았습니다. 그 사실을 라벨로 정직하게 말하는 것 — 그게 이 아크의 진짜 결과입니다.

코드와 실측 기록 전체는 [GitHub](https://github.com/dj258255/dbtower)에 있습니다.

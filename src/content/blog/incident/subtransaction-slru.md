---
title: 'SAVEPOINT 하나가 만드는 성능 절벽, PostgreSQL 17에서 달라진 것'
titleEn: 'The Performance Cliff a Single SAVEPOINT Can Cause, and What Changed in PostgreSQL 17'
description: 'GitLab이 2021년에 공개한 서브트랜잭션 장애를 PostgreSQL 17.5에서 재현했습니다. GitLab은 복제본 처리량이 초당 36만에서 5만으로 떨어지는 일을 1년 넘게 겪었고, 원인은 긴 트랜잭션이 열려 있는 동안 발행된 SAVEPOINT였습니다. 갱신 대상 50만 행과 리더 부하를 고정하고 그 50만 건을 몇 개의 서브트랜잭션으로 나눌지만 바꿔 재니 경계가 둘로 갈렸습니다. 서브트랜잭션 64개까지는 pg_subtrans 조회가 정확히 0건입니다. 1만 개로 늘리면 조회가 700만 건 넘게 생기지만 XID 범위가 약 5페이지라 32페이지 캐시에 들어가 빗나감이 네 회차 모두 6건이고 처리량은 기준선의 93~94%에 머무릅니다. 50만 개에서 XID 범위가 약 244페이지가 되어 미스율 22.2~22.4%, 처리량은 기준선의 67~71%, 대기 샘플의 44~57%가 LWLock/SubtransSLRU였습니다. 조건마다 4회씩 반복했고 절대 처리량은 회차 간 1.08배 안쪽으로 흔들려 중앙값과 범위로만 적었습니다. 절벽은 캐시를 넘겼는가보다 XID 범위가 SLRU 페이지 수를 넘겼는가에서 생깁니다. PostgreSQL 17에서 GUC가 된 subtransaction_buffers를 4MB로 올리자 같은 조건에서 조회가 전부 적중하고 처리량이 기준선의 94~96%까지 돌아왔습니다. 재현이 안 되던 이유도 남겼습니다. 긴 트랜잭션과 캐시 초과만으로는 아무 일도 일어나지 않고 XID 카운터를 미는 쓰기 트래픽이 세 번째 조건입니다. GitLab이 겪은 스탠바이 절벽은 재현하지 못해 그대로 남겼고, XLOG_XACT_ASSIGNMENT가 서브트랜잭션 64개마다만 기록된다는 것을 pg_waldump로 확인한 것까지 적었습니다.'
descriptionEn: "This session reproduces on PostgreSQL 17.5 the subtransaction incident GitLab published in 2021. GitLab spent over a year chasing replica throughput that fell from 360,000 to 50,000 transactions per second, caused by SAVEPOINT calls issued while a long-running transaction was open. Holding the 500,000 updated rows and the reader workload fixed and varying only how those updates are grouped into subtransactions splits the problem into two distinct boundaries. Up to 64 subtransactions there are exactly zero pg_subtrans lookups. At 10,000 there are over 7 million lookups, but the XID range spans about five pages and fits the 32 page cache, so exactly six missed in all four rounds and throughput holds at 93% to 94% of baseline. At 500,000 the XID range spans about 244 pages, producing a 22.2% to 22.4% miss rate, throughput at 67% to 71% of baseline, and LWLock/SubtransSLRU accounting for 44% to 57% of wait samples. Every condition ran four times; absolute throughput varied within 1.08x across rounds, so only medians and ranges are reported. The cliff comes from the XID range exceeding the SLRU page count rather than from merely exceeding the per backend cache. Raising subtransaction_buffers, which became a GUC in PostgreSQL 17, to 4MB made every lookup hit and restored throughput to 94% to 96% of baseline. The post also documents why the reproduction initially failed: a long transaction and cache overflow alone do nothing, and write traffic advancing the XID counter is the required third condition. The standby cliff GitLab actually hit was not reproduced, and pg_waldump confirmed that XLOG_XACT_ASSIGNMENT records appear only once every 64 subtransactions."
date: 2026-05-12
tags:
  - PostgreSQL
  - Transaction
  - Database Internals
  - Performance
  - Replication
  - pgbench
  - Docker
category: incident/LockTx
series: '데이터베이스가 무너지는 지점'
seriesOrder: 10
coverImage: /uploads/incident/subtransaction-slru/chart-slru.png
---

> 근거 등급: `E1·축소`
> 출처: [GitLab, Why we spent the last month eliminating PostgreSQL subtransactions](https://about.gitlab.com/blog/why-we-spent-the-last-month-eliminating-postgresql-subtransactions/) · [postgres.ai, PostgreSQL Subtransactions Considered Harmful](https://postgres.ai/blog/20210831-postgresql-subtransactions-considered-harmful) · [PostgreSQL 17, Resource Consumption](https://www.postgresql.org/docs/17/runtime-config-resource.html) · [PostgreSQL 17 릴리스 노트](https://www.postgresql.org/docs/release/17.0/)

GitLab이 겪은 것은 **복제본에서 터지는 절벽**이고, 이 세션은 그것을 재현하지 못했습니다. 재현한 것은 같은 메커니즘이 프라이머리에서 일으키는 절벽이고, 그쪽은 두 경계와 해소책까지 실측했습니다. 스탠바이 쪽은 어디까지 확인했고 무엇이 막혔는지를 4절에 그대로 적었습니다. 근거 등급의 `축소`가 이 뜻입니다.

## 1. 유명한 이유

GitLab이 2021년 9월에 이 사고를 공개했습니다. 2020년 6월부터 GitLab.com의 데이터베이스가 몇 분씩 멈추는 일이 반복됐습니다.

> Since last June, we noticed the database on GitLab.com would mysteriously stall for minutes, which would lead to users seeing 500 errors during this time.

일주일 멀쩡하다가 15분 터지고 며칠 사라지는 패턴이라 재현이 안 됐고, GitLab은 이 현상에 네스호 괴물을 따 **Nessie**라는 이름을 붙였습니다. 가장 크게 맞은 엔드포인트는 CI 러너가 작업을 받아 가는 `POST /api/v4/jobs/request`였습니다.

원인은 `SAVEPOINT`였습니다. 관측된 패턴이 두 가지였습니다.

> Only the replicas were affected; the primary remained unaffected.
> There was a long-running transaction, usually relating to PostgreSQL's autovacuuming, during the time.

이 구간에서 복제본의 처리량이 초당 36만에서 5만으로 떨어졌습니다. 7.2배입니다. 이 글에서 가장 많이 인용되는 계산이 나옵니다.

> 8192/4 = 2048 transaction IDs can be stored in each page
> There are 32 (`NUM_SUBTRANS_BUFFERS`) pages, which means up to 65K transaction IDs
> it took about 18 seconds to fill up all 65K entries

8KB 페이지에 4바이트 XID가 2,048개, 32페이지면 65,536개입니다. 이 65,536이 절벽의 위치입니다.

가장 무서운 문장은 따로 있습니다.

> To our surprise, our experiments also demonstrated that a single `SAVEPOINT` during a long-transaction could initiate this problem if many writes also occurred simultaneously. That is, it wasn't enough just to reduce the frequency of `SAVEPOINT`; we had to eliminate them completely.

GitLab의 애플리케이션은 중첩이 10을 넘은 적이 없었습니다. 64개를 넘겨야 생기는 문제가 아닙니다. 빈도를 줄이는 것으로는 모자랐습니다. 결국 GitLab은 `SAVEPOINT`를 전부 없앴습니다.

### 애플리케이션에 SAVEPOINT라는 단어가 없어도 생깁니다

이 사례가 무서운 이유가 하나 더 있습니다. 다음은 모두 `SAVEPOINT`를 발행합니다.

| 경로 | SAVEPOINT 발행 | 확인 방법 |
|---|---|---|
| PL/pgSQL의 `EXCEPTION` 블록 | 예 | 이 랩에서 실행 |
| Spring `@Transactional(propagation = NESTED)` + `DataSourceTransactionManager` | 예 | **이 랩에서 실행** |
| Spring `NESTED` + `JpaTransactionManager` | 아니요, 예외로 막힙니다 | **이 랩에서 실행** |
| Spring `REQUIRED` 중첩 호출 | 아니요 | **이 랩에서 실행** |
| Spring `REQUIRES_NEW` | 아니요, 물리 트랜잭션이 따로 열립니다 | **이 랩에서 실행** |
| Rails `transaction(requires_new: true)`, `create_or_find_by` | 예 | 소스 확인 |
| Rails `find_or_create_by` | 7.1 이상만 | 버전별 소스 대조 |
| Django 중첩 `atomic()` | 예 | 공식 문서 |
| SQLAlchemy `begin_nested()` | 예 | 공식 문서 |

PL/pgSQL 쪽은 공식 문서가 유난히 불친절합니다. 제어 구조 문서에는 "`EXCEPTION` 절이 있는 블록은 없는 블록보다 진입과 탈출이 훨씬 비싸다"고만 적혀 있고 서브트랜잭션이라는 말이 없습니다. 서브트랜잭션을 명시한 곳은 별도 페이지입니다.

> Also, a block containing an EXCEPTION clause effectively forms a subtransaction that can be rolled back without affecting the outer transaction.

가장 확실한 근거는 소스입니다. `pl_exec.c`가 `EXCEPTION` 절이 있을 때만 조건부로 서브트랜잭션을 엽니다.

```c
if (block->exceptions)
{
    /*
     * Execute the statements in the block's body inside a sub-transaction
     */
    ...
    BeginInternalSubTransaction(NULL);
```

### Spring 경로를 실제로 돌려 확인했습니다

위 표의 Spring 항목은 처음에 공식 문서와 javadoc만으로 적었습니다. 문서를 읽은 것과 돌려 본 것은 다르므로 최소 앱을 만들어 확인했습니다. PostgreSQL의 `log_statement='all'`을 켜고 서버가 실제로 받은 문장을 세는 방식입니다.

![전파 방식과 트랜잭션 매니저별 SAVEPOINT 발행](/uploads/incident/subtransaction-slru/fig-app-tally.png)

| 케이스 | BEGIN | SAVEPOINT | RELEASE | COMMIT | 판정 |
|---|---|---|---|---|---|
| `NESTED` + `DataSourceTransactionManager` | 1 | **3** | 3 | 1 | 발행 |
| `REQUIRED` + JDBC | 1 | 0 | 0 | 1 | 안 함 |
| `REQUIRES_NEW` + JDBC | **4** | 0 | 0 | 4 | 안 함 |
| `NESTED` + `JpaTransactionManager` | 1 | 0 | 0 | 0 | 예외로 막힘 |
| `REQUIRED` + JPA | 1 | 0 | 0 | 1 | 안 함 |
| `REQUIRES_NEW` + JPA | 4 | 0 | 0 | 4 | 안 함 |

`NESTED`를 세 번 부르면 `SAVEPOINT`가 정확히 세 번 나갑니다. 문장 원문이 그대로 찍힙니다.

![NESTED가 발행한 SAVEPOINT 원문](/uploads/incident/subtransaction-slru/fig-app-layer.png)

```
execute <unnamed>: BEGIN
execute <unnamed>: UPDATE sponsor SET amount = amount + 1 WHERE id = 400000
execute <unnamed>: SAVEPOINT "SAVEPOINT_1"
execute <unnamed>: UPDATE sponsor SET amount = amount + 1 WHERE id = $1
```

`JpaTransactionManager`는 예외로 막습니다. 메시지가 이유를 그대로 말해 줍니다.

```
org.springframework.transaction.NestedTransactionNotSupportedException:
  JpaDialect does not support savepoints - check your JPA provider's capabilities
```

`REQUIRES_NEW`는 `BEGIN`이 네 번(바깥 1회와 안쪽 3회) 나가고 `SAVEPOINT`는 0입니다. 별도 물리 트랜잭션이므로 서브트랜잭션이 아니고, 곧 이 글의 절벽과 무관합니다.

그러니 Spring을 쓰면서 이 함정에 빠지는 조합은 `NESTED`와 `DataSourceTransactionManager` 하나입니다. JPA를 쓰면 예외로 막히고 `REQUIRED`와 `REQUIRES_NEW`는 서브트랜잭션을 만들지 않습니다. 다만 PL/pgSQL의 `EXCEPTION` 블록은 애플리케이션 설정과 무관하게 서브트랜잭션을 만듭니다. 트리거나 함수 안에 그 블록이 있으면 Spring 쪽을 어떻게 잡아도 소용이 없습니다.

계측하면서 두 가지를 밟았습니다. pgjdbc는 확장 질의 프로토콜을 쓰므로 서버 로그가 `statement:`가 아니라 `execute <unnamed>:`로 찍힙니다. 처음 집계가 전부 0으로 나온 이유입니다. 그리고 `REQUIRES_NEW`가 바깥 트랜잭션이 잠근 행을 다시 갱신하게 만들어 자기 자신의 락을 기다리며 멈췄습니다. 겹치지 않는 행을 쓰도록 고쳤습니다.

## 2. 재현

### 환경

| 항목 | 값 |
|---|---|
| 호스트 | Darwin 25.3.0 arm64, 12코어, 32GB |
| PostgreSQL | 17.5 프라이머리 + 스트리밍 복제 핫 스탠바이(비동기) |
| 컨테이너 한도 | 각 4코어 4GB, `shared_buffers=1GB`, `autovacuum=off` |
| 데이터 | `sponsor` 50만 행 |
| 부하 | pgbench 17.5, 동시 리더 64, 각 조건 20초 |

같은 호스트에서 두 인스턴스가 각 4코어를 쓰므로 12코어를 나눠 씁니다. 조건 간 상대 비교만 유효합니다.

### 왜 17로 재는가

16 이하에서 subtrans SLRU 크기는 컴파일 타임 상수였습니다.

```c
/* Number of SLRU buffers to use for subtrans */
#define NUM_SUBTRANS_BUFFERS	32
```

바꾸려면 재컴파일해야 했습니다. GitLab이 검토했다가 포기한 것이 이 값을 키우는 Andrey Borodin의 패치였습니다. 그 패치가 17에서 `subtransaction_buffers` GUC로 정식 반영됐습니다. GitLab이 2021년에 원했던 조치를 17에서는 설정 한 줄로 할 수 있습니다.

17에서 이름도 바뀌었습니다. `pg_stat_slru`의 name이 `Subtrans`에서 `subtransaction`으로 바뀌었고, 대기 이벤트는 이미 13에서 `SubtransControlLock`이 `SubtransSLRU`로 바뀌어 있었습니다. 버전별로 계측 쿼리를 분기해야 합니다.

참고로 `https://www.postgresql.org/docs/17/wait-events.html`은 존재하지 않는 URL입니다. 대기 이벤트 표는 `monitoring-stats.html` 안에 있습니다.

17을 쓰되 16 시절의 크기(32블록, 256kB)로 고정한 조건과 키운 조건을 나란히 재면, 같은 이미지 안에서 해소책의 효과가 분리됩니다.

### 두 개의 경계

절벽이 한 군데가 아닙니다.

**64**는 `src/include/storage/proc.h`의 값입니다.

```c
#define PGPROC_MAX_CACHED_SUBXIDS 64	/* XXX guessed-at value */
```

백엔드는 자기 트랜잭션의 서브트랜잭션 XID를 이 배열에 광고합니다. 주석이 넘칠 때 무슨 일이 생기는지 직접 말해 줍니다.

> If none of the caches have overflowed, we can assume that an XID that's not listed anywhere in the PGPROC array is not a running transaction. **Else we have to look at pg_subtrans.**

**65,536**은 위의 32페이지 곱하기 2,048입니다. 여기를 넘으면 `pg_subtrans` 조회마저 SLRU 캐시에서 빗나갑니다.

그래서 조건을 이 두 경계 아래위로 뒀습니다. 갱신 대상 50만 행과 리더 부하를 전부 고정하고, 그 50만 건을 몇 개의 서브트랜잭션으로 나눌지만 바꿉니다.

### RELEASE SAVEPOINT로는 캐시를 비울 수 없습니다

이 64개 배열을 두고 흔히 나오는 처방이 있습니다. postgres.ai는 활성 서브트랜잭션을 64 미만으로 유지하면 총 100개를 만들어도 열화가 없다고 적었습니다. 그러면 서브트랜잭션을 만들고 곧바로 `RELEASE`해서 활성 수를 낮게 유지하면 되지 않느냐는 생각이 자연스럽게 따라옵니다.

PostgreSQL 17에 백엔드별 캐시 상태를 직접 보는 함수가 있어서 재봤습니다. 세 방식으로 서브트랜잭션 70개씩 만들고 트랜잭션을 열어 둔 채 `pg_stat_get_backend_subxact`를 읽었습니다.

| 방식 | 캐시에 남은 서브트랜잭션 | 넘침 |
|---|---|---|
| `SAVEPOINT` → `UPDATE` → `RELEASE` (각각 커밋) | 64개 | **참** |
| `SAVEPOINT` → `UPDATE` → `ROLLBACK TO` (각각 롤백) | **0개** | 거짓 |
| `SAVEPOINT`를 겹쳐 쌓고 풀지 않음 (전부 활성) | 64개 | **참** |

**`RELEASE`는 배열을 비우지 않습니다.** 커밋한 것과 겹쳐 쌓은 것이 캐시 관점에서 구별되지 않습니다. 이유는 가시성입니다. 커밋된 서브트랜잭션의 XID는 최상위 트랜잭션이 끝날 때까지 다른 세션의 판정에 계속 필요하므로 배열에서 뺄 수 없습니다. 반면 롤백된 서브트랜잭션은 그 XID가 만든 변경이 전부 무효이므로 빼도 됩니다. 그래서 롤백 쪽만 0개입니다.

이것이 1절의 Spring `NESTED`나 PL/pgSQL `EXCEPTION` 블록이 위험한 이유를 한 겹 더 설명합니다. `EXCEPTION` 블록을 정상으로 빠져나가는 것은 `RELEASE`와 같으므로, 예외가 한 번도 안 나도 배열은 그대로 채워집니다. **"예외가 안 나니까 괜찮다"가 아니라 "블록에 들어갔으면 이미 쌓였다"입니다.**

측정에서 개수가 70이 아니라 64인 것은 배열이 64에서 멈추고 넘침 표시를 켜기 때문입니다. 그 시점부터 읽는 쪽은 스냅숏만으로 판정하지 못하고 `pg_subtrans`를 봐야 합니다.

## 3. 해소

두 갈래입니다. 둘 다 이 세션이 재고 효과를 확인했습니다.

**SLRU 를 키웁니다.** `subtransaction_buffers` 를 4MB(512블록)로 올리자 같은 50만 서브트랜잭션에서 조회 700만 건이 전부 적중하고 빗나감이 네 회차 모두 0이 됐습니다. 처리량도 기준선 수준으로 돌아옵니다. 4절 표의 `sub500k-buf` 행이 그 조건입니다.

**애초에 17을 기본값으로 쓰면 이 절벽을 안 만납니다.** 17에서 `subtransaction_buffers` 기본값 0은 자동 산정을 뜻하고, `shared_buffers` 나누기 512로 최대 1024블록까지 잡습니다. `shared_buffers=1GB` 면 256블록이라 16 시절의 고정 32블록보다 8배 큽니다. **아래 표의 절벽은 그 기본값을 일부러 32로 되돌려 만든 것입니다.**

**활성 서브트랜잭션을 64 미만으로 유지하라**는 흔한 처방도 있는데, 이 세션은 그것을 그대로 권하지 않습니다. 5절이 그 조건을 따로 만들어 재고 무엇이 성립하고 무엇이 안 성립하는지 갈라 놓았습니다.

## 4. 재계측

![조건별 처리량, SLRU 미스율, 원인 지표](/uploads/incident/subtransaction-slru/chart-slru.png)

세 구간이 성격이 다릅니다. 아래는 4회 반복의 중앙값이고 괄호는 최소에서 최대입니다. 기준선 대비는 회차마다 따로 계산했습니다.

| 조건 | 서브트랜잭션 | SLRU 버퍼 | 초당 처리량 | 기준선 대비 | pg_subtrans 조회 | 빗나감 | SubtransSLRU 대기 |
|---|---|---|---|---|---|---|---|
| `none` | 0 | 256kB | 94,741 (94,017~101,383) | 100% | 0 | 0 | 0% |
| `sub64` | 64 | 256kB | 91,936 (90,774~98,383) | 97% | 0 | 0 | 0% |
| `sub10k` | 10,000 | 256kB | 88,242 (87,779~95,112) | 93~94% | 705만~762만 | 6 (네 번 다) | 0% |
| `sub500k` | 500,000 | 256kB | 66,026 (63,431~70,049) | 67~71% | 508만~561만 | 113만~126만 | 44~57% |
| `sub500k-buf` | 500,000 | 4MB | 89,470 (89,036~97,146) | 94~96% | 712만~778만 | 0 (네 번 다) | 0% |

세 구간이 성격이 다릅니다.

**0에서 64까지는 아무 일도 없습니다.** `pg_subtrans` 조회가 0건입니다. 네 회차 모두 정확히 0입니다. 64개는 PGPROC 배열에 그대로 들어가니 리더가 디스크 구조를 뒤질 이유가 없고, 측정 결과가 소스 주석의 "넘치지 않았으면 pg_subtrans를 볼 필요가 없다"와 그대로 맞습니다.

**64를 넘으면 조회가 시작되지만 그것만으로는 안 느려집니다.** `sub10k`에서 조회가 700만 건 넘게 발생했는데 빗나간 것은 6건입니다. 네 회차에서 이 6이 한 번도 어긋나지 않았습니다. XID 1만 개는 약 5페이지라 32페이지 캐시에 여유롭게 들어갑니다. 처리량은 기준선의 93~94%입니다. 캐시 초과 자체의 비용은 작습니다.

**무너지는 지점은 65,536입니다.** `sub500k`에서 XID 50만 개는 약 244페이지입니다. 32페이지 캐시로는 못 덮으니 조회 500만 건 중 110만 건 넘게 빗나갔습니다. 미스율은 네 회차에서 22.2%에서 22.4%로 거의 고정입니다. 처리량이 기준선의 67~71%가 되고, 대기 샘플의 44%에서 57%가 `LWLock/SubtransSLRU`입니다. 미스율과 `SubtransSLRU` 대기 비중, 처리량 하락이 같은 조건에서 같이 나타납니다.

SLRU를 키우면 해소됩니다. `subtransaction_buffers`를 4MB(512블록)로 올리자 같은 50만 서브트랜잭션에서 조회 700만 건이 전부 적중하고 빗나감이 네 회차 모두 0이 됐습니다. 처리량은 기준선의 94~96%까지 돌아옵니다. `SubtransSLRU` 대기도 사라집니다. GitLab이 100MB 캐시면 2,620만 개를 담는다고 계산했던 그 조치입니다.

### 17의 기본값은 이미 완화되어 있습니다

17에서 `subtransaction_buffers`의 기본값은 0이고, 이는 자동 산정을 뜻합니다.

> The default value is `0`, which requests `shared_buffers`/512 up to 1024 blocks, but not fewer than 16 blocks.

`shared_buffers=1GB`면 131,072블록 나누기 512, 즉 256블록입니다. 16 이하의 고정 32블록보다 8배 큽니다. 위 표의 절벽은 그 기본값을 일부러 32로 되돌려서 만들었습니다. 17을 기본값으로 쓰면 같은 부하에서 이 절벽은 훨씬 얕습니다.

## 5. 스탠바이 절벽은 재현하지 못했습니다

GitLab이 겪은 것은 위와 다릅니다. 원문이 "복제본만 영향을 받았고 프라이머리는 멀쩡했다"고 명시합니다. postgres.ai의 후속 분석도 프라이머리 단일 노드에서는 이 문제가 없어 보인다고 적었습니다.

프라이머리에 핫 스탠바이를 붙이고 postgres.ai의 검증된 레시피를 규모만 줄여 시도했습니다. 결과는 실패입니다.

| 조건 | 프라이머리 쓰기 | 롱TX | 스탠바이 처리량 | 스탠바이 pg_subtrans | WAL의 ASSIGNMENT 레코드 |
|---|---|---|---|---|---|
| `sb-sp3` | SAVEPOINT 3개 + 쓰기 3건 | 있음 | 60,769 | 0 | 0 |
| `sb-plain3` | SAVEPOINT 없이 쓰기 3건 | 있음 | 51,931 | 0 | 0 |
| `sb-sp70` | 쓰기 서브트랜잭션 70개 | 있음 | 72,983 | 0 | 0 |
| `sb-sp70-nolong` | 같음 | 없음 | 76,225 | 0 | 0 |

![스탠바이의 pg_stat_slru](/uploads/incident/subtransaction-slru/fig-standby-slru.png)

스탠바이의 `pg_stat_slru`에서 `subtransaction` 행이 모든 조건에서 0입니다. 같은 시점 `transaction` 행은 2만에서 46만 건씩 잡히므로 통계 수집이 죽은 것은 아닙니다. 복제 지연도 0에서 1초였습니다. 스탠바이 스냅샷의 xmin도 긴 트랜잭션에 제대로 붙잡혀 있었습니다.

### 왜 안 됐는지 알아낸 것까지

스탠바이가 서브트랜잭션 오버플로를 알게 되는 경로는 WAL의 `XLOG_XACT_ASSIGNMENT` 레코드뿐입니다. 이 레코드가 언제 나오는지 `pg_waldump`로 직접 셌습니다.

```console
-- 한 트랜잭션에 쓰기 서브트랜잭션 10만 개
1562 ASSIGNMENT

-- SAVEPOINT 3개짜리 트랜잭션 1.7만 건
16954 COMMIT          ← ASSIGNMENT 0건
```

![스탠바이가 오버플로를 통보받는 유일한 경로](/uploads/incident/subtransaction-slru/fig-assignment.png)

100,000 나누기 64는 1,562.5입니다. 트랜잭션 하나 안에서 서브트랜잭션 64개마다 한 번씩 기록된다는 뜻입니다.

`SAVEPOINT` 3개짜리 트랜잭션에서는 이 레코드가 한 건도 나오지 않았습니다. 64에 닿을 일이 없으니 당연합니다. 스탠바이는 오버플로가 있었다는 사실 자체를 통보받지 못하고, 통보받지 못하면 스냅샷을 `suboverflowed`로 표시하지 않고, 표시하지 않으면 `pg_subtrans`를 볼 이유가 없습니다.

### 이 실패가 반박이 되지 못하는 조건 세 가지

세 가지가 걸립니다.

첫째, `sb-sp70` 조건은 쓰기 처리량이 초당 0.68건이었습니다. 4개 클라이언트가 한 트랜잭션에서 70개 행 락을 잡으니 서로 막고 데드락까지 났습니다. WAL에 ABORT 레코드가 남았습니다. GitLab이 요구한 "동시에 많은 쓰기"와는 거리가 멉니다. ASSIGNMENT 레코드가 나올 수 있는 조건은 이것뿐이었는데, 정작 쓰기량이 없어서 조건을 못 만들었습니다.

둘째, GitLab이 관측한 버전은 12대입니다. 블로그 본문에 버전 명시는 없지만, 본문이 링크한 이슈 제목이 "Benchmark 10-30 concurrent transactions with 3 nested savepoints on PostgreSQL 12.7/12.8"입니다. 관측한 대기 이벤트 이름이 `SubtransControlLock`(13 이전 명칭)인 것과도 맞습니다. postgres.ai가 검증한 버전은 12, 13, 14입니다. 17에서 같은 경로가 그대로 남아 있는지는 확인하지 않았습니다.

셋째, 제 스탠바이는 프라이머리와 같은 호스트에서 컨테이너로 돌았습니다. postgres.ai는 별도 인스턴스 2대를 썼습니다. 자원 경쟁 구조가 다릅니다.

프라이머리 쪽 절벽은 두 경계와 해소책까지 재현했고, GitLab이 겪은 스탠바이 쪽 절벽은 재현하지 못했습니다. 못 한 이유의 일부는 밝혔지만 그것이 GitLab의 서술과 어긋나는 이유는 밝히지 못했습니다.

## 6. 예상과 달랐던 점

### 긴 트랜잭션과 캐시 초과만으로는 아무 일도 안 일어납니다

조건을 다 갖췄다고 믿고 여러 번 쟀는데 `pg_subtrans` 조회가 계속 0이었습니다. 원인은 스냅샷의 xmax였습니다.

긴 트랜잭션이 유일한 쓰기 주체이면 `pg_current_snapshot()`이 이렇게 나옵니다.

```console
spoon=# SELECT pg_current_snapshot();
 2218:2218:                       ← xmin = xmax, 진행 중 목록 비어 있음

spoon=# SELECT id, xmin, xmax FROM sponsor WHERE id IN (5, 50000, 99999);
  id   | xmin | xmax
-------+------+------
     5 |  847 | 2219
 50000 |  847 | 2318
 99999 |  847 | 2418
```

서브트랜잭션 XID가 2219부터인데 스냅샷의 xmax가 2218입니다. `XidInMVCCSnapshot`은 xid가 xmax 이상이면 진행 중이라고 즉시 판정하고 끝냅니다. `pg_subtrans`를 볼 이유가 없습니다.

그래서 조건이 셋입니다. 긴 트랜잭션, 서브트랜잭션 캐시 초과, **XID 카운터를 서브트랜잭션 범위 너머로 밀어 올리는 다른 쓰기 트래픽**입니다. 세 번째를 넣고서야 재현됐습니다.

GitLab 원문의 "if many writes also occurred simultaneously"가 이 조건입니다. 처음에는 부하를 키우라는 뜻으로 읽었는데, 부하의 양보다 XID 카운터를 미는 역할이 핵심이었습니다.

### 캐시 초과의 비용이 거의 없었습니다

64를 넘기면 느려질 것으로 예상했는데 `sub10k`에서 조회 700만 건이 전부 캐시에 적중하며 처리량이 기준선의 93~94%에 머물렀습니다. 절벽은 "캐시를 넘겼는가"보다 "XID 범위가 SLRU 페이지 수를 넘겼는가"에서 생깁니다.

서브트랜잭션을 64개 아래로 유지하는 것만으로는 안심할 수 없고, 64를 넘겼다고 무조건 위험한 것도 아닙니다. 위험한 조건은 XID 소비 속도와 긴 트랜잭션의 길이가 함께 만듭니다.

### 스탠바이가 프라이머리보다 max_connections를 크게 가져야 합니다

스탠바이가 이 로그를 남기고 안 떴습니다.

```
FATAL:  recovery aborted because of insufficient parameter settings
DETAIL:  max_connections = 100 is a lower setting than on the primary server, where its value was 300.
```

이 값이 스탠바이의 `KnownAssignedXids` 배열 크기를 정하기 때문입니다. 스탠바이는 프라이머리에서 진행 중인 XID를 이 배열로 추적하고, 바로 이 배열이 넘칠 때 `pg_subtrans`로 내려갑니다.

### 서브트랜잭션은 XID도 빨리 태웁니다

postgres.ai가 정리한 네 문제 중 첫 번째가 XID 증가입니다.

> One may have, say, 1000 writing transactions per second, but if they all use 10 subtransactions, then XID is incremented by 10000 per second.

PostgreSQL 개발자들이 XID를 최대한 빨리 태우는 수단으로 고른 것도 서브트랜잭션입니다. 17에 들어간 테스트 모듈 `xid_wraparound`의 주석이 그렇게 적혀 있습니다.

> We consume XIDs by calling GetNewTransactionId(true), which marks the consumed XIDs as subtransactions of the current top-level transaction.

그 XID가 바닥나면 어떻게 되는지는 같은 시리즈의 [트랜잭션 ID가 바닥나 읽기 전용이 된다](/blog/incident/xid-wraparound)에서 다룹니다.

## 7. 16과 17을 나란히

PostgreSQL 16과 17.5를 같은 부하로 나란히 돌렸습니다. 두 버전 다
`subtransaction_buffers` 가 32입니다. 16 에는 그 GUC 자체가 없고 값이 32로 고정입니다.
17에서 32로 되돌려 맞췄습니다. 버퍼 수가 같으므로 남는 차이는 SLRU 락 구조입니다.
조건마다 3회 돌렸습니다.

| 조건 | 활성 서브트랜잭션 | 16 중앙 | 16 폭 | 17.5 중앙 | 17.5 폭 | 17.5/16 |
|---|---|---|---|---|---|---|
| none | 0 | 94,793 | 29,273~100,012 | 95,129 | 94,780~99,514 | 1.00배 |
| sub63 | 63 | 90,075 | 28,870~95,891 | 91,367 | 90,011~97,102 | 1.01배 |
| sub64 | 64 | 88,509 | 28,784~93,336 | 88,348 | 85,273~93,486 | 1.00배 |
| sub10k | 10,000 | 84,804 | 30,518~93,271 | 85,645 | 84,375~91,829 | 1.01배 |
| sub500k | 500,000 | 56,087 | 29,315~59,878 | **64,483** | 64,168~69,621 | **1.15배** |

**네 조건에서 두 버전이 같습니다.** 17의 뱅크 단위 SLRU 락은 500,000 조건에서만
1.15배로 벌어집니다. 그 아래에서는 1.00~1.01배입니다.

**16 쪽 회차 폭이 3.4배입니다.** 29,273부터 100,012까지 벌어집니다. 다섯 조건 모두
최솟값이 29,000 대이므로 한 회차가 통째로 느렸다는 뜻이고, 같은 호스트에서 다른
컨테이너와 겹친 구간으로 봅니다. **개별 회차 값은 인용하면 안 되고 중앙값만 씁니다.**
17.5 쪽은 폭이 5% 안이라 그 조건이 없었습니다.

폭이 이렇게 넓은데도 중앙값 배수는 1회 실행 때와 같습니다. 앞서 1회로 잰 값이
1.00 / 1.01 / 1.00 / 0.98 / 1.16배였고 3회 중앙값이 1.00 / 1.01 / 1.00 / 1.01 / 1.15배입니다.

이유는 SLRU 읽기 수에 있습니다.

| 조건 | 16 hit/read | 17.5 hit/read |
|---|---|---|
| none | 0 / 0 | 0 / 0 |
| sub63 | 63 / 0 | 64 / 0 |
| sub64 | 127 / 0 | 64 / 0 |
| sub10k | 7,466,407 / 6 | 7,354,030 / 6 |
| sub500k | 11,686,995 / **1,081,578** | 4,820,372 / **1,245,420** |

**읽기가 백만 건대로 올라가는 조건은 sub500k 하나뿐입니다.** 락을 잡을 일이 있어야
락 구조 개선이 값을 합니다. 10,000 조건에서도 읽기는 6건입니다. 캐시에 다 들어갑니다.

같은 버전 안에서 none 대비 배수는 이렇습니다.

| 조건 | 16 | 17.5 |
|---|---|---|
| sub63 | 0.95배 | 0.96배 |
| sub64 | 0.93배 | 0.93배 |
| sub10k | 0.89배 | 0.90배 |
| sub500k | **0.59배** | **0.68배** |

**63과 64 사이에 계단이 있습니다.** 63은 none의 96~98%를 지키고 64는 93~94%로
떨어집니다. 두 조건 다 SLRU 읽기가 0 이므로 이 계단은 디스크 접근이 아니라 PGPROC
캐시 64칸을 넘긴 비용 자체입니다. **"활성 수를 64 미만으로 유지하면 회복된다"가
처리량 축에서도 확인됩니다.** 2절에서 `ROLLBACK TO` 가 캐시를 비운다는 것만 봤는데,
비운 상태의 처리량이 실제로 none에 가깝습니다.

절벽은 63과 64 사이가 아니라 10,000과 500,000 사이입니다. 0.93배와 0.60배 사이가
훨씬 큽니다. 64를 넘기는 것 자체는 7% 손해이고, SLRU가 캐시에 안 들어갈 만큼
불어나는 것이 40% 손해입니다.

17로 올려도 sub500k는 여전히 none의 0.70배입니다. **락 구조 개선은 손해를
40%에서 30%로 줄이지 그 조건을 없애지 않습니다.**

## 못 한 것

- **7절의 16 쪽 회차 폭이 3.4배입니다.** 다섯 조건 모두 최솟값이 29,000대라 한 회차가 통째로 느렸던 것으로 보이고, 그 회차를 갈라내지는 못했습니다. 중앙값만 인용합니다.
- **스탠바이 절벽.** 5절에 적었습니다. 이 세션의 가장 큰 공백입니다.
- **Multixact 경로.** 서브트랜잭션과 `SELECT ... FOR UPDATE`가 겹치면 multixact가 끼어들어 별도의 열화가 생깁니다. 이 세션 범위 밖입니다.
- **Rails, Django, SQLAlchemy 검증.** Spring 경로는 실행해 확인했지만(1절) 나머지 셋은 문서와 소스로만 확인했습니다.

---

재현에 쓴 compose 파일과 실행 출력 원문은 [incident-lab 저장소의 A19 세션](https://github.com/dj258255/incident-lab/tree/main/sessions/A19-subtransaction-slru)에 있습니다.

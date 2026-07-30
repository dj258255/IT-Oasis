---
title: 'DB는 한가한데 앱만 멈춘다, 커넥션 풀 데드락'
titleEn: 'The Database Is Idle and Only the Application Stalls: Connection Pool Deadlock'
description: '우아한형제들이 공개한 커넥션 풀 데드락 사례를 MySQL 8.4.3과 Spring Boot 3.4.1에서 네 조건으로 재현했습니다. 원인은 개발자가 커넥션을 두 개 잡는 코드를 쓴 것이 아니라 엔티티에 붙인 @GeneratedValue(AUTO)입니다. MySQL에는 시퀀스가 없어 Hibernate가 시퀀스 테이블을 별도 커넥션에서 FOR UPDATE로 잠그므로 save() 한 줄이 커넥션 두 개를 동시에 요구합니다. 동시 요청 16에 풀 10으로 40초를 재니 커넥션을 노골적으로 두 개 잡는 조건은 요청 32건 중 21건이 30초 타임아웃까지 가서 초당 0.3건에 그쳤습니다. 원 사례를 그대로 옮긴 JPA 조건은 전멸하지 않고 실패율 0.5%에 초당 37.2건이었는데, 풀만 24로 올리면 141.1건이 됩니다. 4회 반복에서 이 배수는 3.6배에서 4.3배였습니다. Hibernate 6의 pooled 옵티마이저가 allocationSize 50으로 ID를 미리 확보해 채번이 50건에 한 번만 일어나기 때문이고, 시퀀스 테이블의 next_val이 1에서 51, 101로 뛰는 것으로 확인했습니다. JPA 조건은 실패율 0.5%에 p95 55ms로 지표가 멀쩡한데도 1초를 넘긴 16건이 워커 시간 640초의 88.4~89.1%를 차지했고, 그 16건은 네 회차에서 한 번도 어긋나지 않았습니다. 커넥션 동시 보유를 1로 줄이면 풀 10 그대로 실패 0건에 초당 151건입니다. 널리 인용되는 위키 공식과 우아한형제들이 실제로 쓴 계산이 다른 식이라는 점도 구분해 적었습니다.'
descriptionEn: "This session reproduces the connection pool deadlock that Woowa Brothers published, running four conditions on MySQL 8.4.3 and Spring Boot 3.4.1. The cause is not developer code that grabs two connections but the @GeneratedValue(AUTO) annotation on the entity, because MySQL has no sequence object and Hibernate locks a sequence table with FOR UPDATE on a separate connection, so a single save() demands two connections at once. With 16 concurrent requests against a pool of 10 over 40 seconds, the condition that explicitly holds two connections completed only 32 requests, 21 of which burned the full 30 second timeout, for 0.3 requests per second. The JPA condition that mirrors the original case did not collapse: it reported a 0.5% failure rate at a median 37.2 requests per second, and raising the pool to 24 lifted that to 141.1. Computed per round across four runs, that gap ranges from 3.6x to 4.3x. Hibernate 6 defaults to a pooled optimizer with an allocation size of 50, so the sequence fetch happens once every 50 inserts, confirmed by watching next_val jump from 1 to 51 to 101. Even with a 0.5% failure rate and a healthy 55ms p95, the 16 requests that exceeded one second consumed 88.4% to 89.1% of the 640 available worker seconds, and that count of 16 held in all four rounds. Reducing concurrent connection ownership to one keeps the pool at 10 with zero failures at about 151 requests per second. The post also separates the widely quoted wiki formula from the calculation Woowa Brothers actually applied."
date: 2026-07-30
tags:
  - MySQL
  - Spring Boot
  - JPA
  - Hibernate
  - HikariCP
  - Connection Pool
  - Transaction
  - Docker
category: incident/LockTx
series: '애플리케이션 코드가 부른 장애'
seriesOrder: 4
coverImage: /uploads/incident/hikaricp-pool-deadlock/chart-pool.png
---

> 근거 등급: `E1·축소`
> 출처: [우아한형제들, HikariCP Dead lock에서 벗어나기 (이론편)](https://techblog.woowahan.com/2664/) (이재훈, 2020-02-06) · [실전편](https://techblog.woowahan.com/2663/) · [HikariCP Wiki, About Pool Sizing](https://github.com/brettwooldridge/HikariCP/wiki/About-Pool-Sizing) · [Hibernate 6.6, Identifier generation](https://docs.jboss.org/hibernate/orm/6.6/userguide/html_single/Hibernate_User_Guide.html#identifiers-generators)

## 1. 유명한 이유

이 로그를 처음 보면 DB가 죽었다고 판단하게 됩니다.

```
Connection is not available, request timed out after 30000ms.
Timeout failure stats (total=10, active=10, idle=0, waiting=16)
```

숫자를 읽어 보면 다릅니다. `total=10, active=10, idle=0`은 풀이 가진 커넥션 10개를 전부 누군가 쥐고 있다는 뜻이고, `waiting=16`은 소비자 스레드 16개가 전원 대기 중이라는 뜻입니다. DB 쪽은 커넥션 10개만 받은 채 한가합니다. 멈춘 쪽은 애플리케이션입니다.

우아한형제들이 이 사례를 공개했을 때 널리 읽힌 이유는 원인이 반직관적이기 때문입니다. 개발자가 커넥션을 두 개 잡는 코드를 쓴 적이 없습니다. 엔티티에 `@GeneratedValue(strategy = GenerationType.AUTO)`를 붙였을 뿐입니다.

MySQL에는 시퀀스 객체가 없으므로 Hibernate는 시퀀스 테이블을 대신 씁니다. 실전편의 설명이 이렇습니다.

> MySQL은 Sequence를 지원하지 않기 때문에 hibernate_sequence라는 테이블에 단일 Row를 사용하여 ID값을 생성합니다

그 채번을 별도 트랜잭션으로 처리합니다. 채번은 본 트랜잭션이 롤백돼도 되돌아가면 안 되기 때문입니다. ID를 다시 나눠 주면 충돌합니다. 그래서 `save()` 한 줄이 실행되는 동안 한순간 커넥션 두 개를 동시에 잡습니다.

원 사례의 조건은 CPU 4코어, 소비자 스레드 16개, `maximumPoolSize` 10(기본값), `connectionTimeout` 30000ms(기본값)였고, 풀을 24로 올려 해소했습니다.

### 널리 잘못 인용되는 공식

HikariCP 위키에 이런 공식이 있습니다.

```
pool size = Tn × (Cm - 1) + 1
```

`Tn`은 스레드 수, `Cm`은 한 스레드가 동시에 필요한 커넥션의 최대 개수입니다. 위키는 이 값을 **데드락을 피하는 최소값**이라고 설명합니다. 성능 권장값이 아니라 하한선이고, 이 값으로 풀을 잡으면 멈추지만 않는 상태에 머무릅니다.

우아한형제들이 실제로 쓴 계산은 `16 × (2 - 1) + (16 / 2) = 24`입니다. 뒤의 `+ (Tn / 2)`는 위키 공식에 없습니다. 하한선인 17에 여유분을 더한 자체 확장입니다. 위키 공식으로 24가 나온다고 인용하면 틀립니다. 이 글에서는 두 값을 구분해 씁니다.

## 2. 재현

### 환경

| 항목 | 값 |
|---|---|
| 호스트 | Darwin 25.3.0 arm64, 12코어, 32GB |
| MySQL | 8.4.3 공식 Docker 이미지, `--max-connections=500` |
| 애플리케이션 | Spring Boot 3.4.1, Hibernate 6, JDK 25 |
| 동시 요청 | 16 (원 사례의 소비자 스레드 수와 맞춤) |
| 조건당 시간 | 40초 |
| `connectionTimeout` | 30000ms (HikariCP 기본값, 원 사례와 동일) |

호스트가 12코어라 원 사례의 4코어보다 넉넉합니다. 절대 처리량을 원 사례와 비교하면 안 되고, 조건 간 상대 비교만 유효합니다.

### 네 조건

| 라벨 | 경로 | 풀 | 의도 |
|---|---|---|---|
| `jpa-10` | `save()` 한 줄, `@GeneratedValue(AUTO)` | 10 | 원 사례를 그대로 |
| `jpa-24` | 같음 | 24 | 원 사례의 해소책 |
| `two-10` | 첫 커넥션을 쥔 채 두 번째를 빌림 | 10 | 커넥션 2개 요구를 노골적으로 |
| `one-10` | 첫 커넥션을 반납한 뒤 두 번째를 빌림 | 10 | 동시 보유 최대를 1로 |

`two-10`을 따로 둔 이유가 있습니다. `jpa-10`은 원 사례를 재현하려는 조건이고, `two-10`은 그 원리를 순수한 형태로 분리한 대조군입니다. 둘을 나란히 놓아야 "커넥션 2개 요구"라는 원리와 "JPA 채번이 그 원리를 유발하는 정도"를 따로 볼 수 있습니다.

`two-10`의 코드는 이렇습니다. 첫 커넥션으로 원장에 쓰고, 그것을 들고 있는 채로 두 번째를 빌려 통계를 갱신합니다.

```java
void sponsorTwoConnections(long liveId, int amount) throws Exception {
    try (Connection ledger = ds.getConnection()) {                 // 커넥션 1
        try (var ps = ledger.prepareStatement(
                "INSERT INTO sponsor (live_id, amount) VALUES (?,?)")) {
            ps.setLong(1, liveId);
            ps.setInt(2, amount);
            ps.executeUpdate();
        }
        // 여기서 첫 커넥션을 아직 반납하지 않았다. 그 상태로 두 번째를 요청한다.
        Thread.sleep(holdMs);
        try (Connection stat = ds.getConnection()) {               // 커넥션 2
            try (var ps = stat.prepareStatement(
                    "UPDATE live_stat SET total = total + ? WHERE live_id = ?")) {
                ps.setInt(1, amount);
                ps.setLong(2, liveId);
                ps.executeUpdate();
            }
        }
    }
}
```

실무에서 이 모양이 나오는 경로는 여럿입니다. 원장은 마스터, 통계는 슬레이브로 데이터소스가 갈려 있는데 한 트랜잭션에서 둘 다 건드리는 경우, `@Transactional` 안에서 다른 데이터소스를 쓰는 메서드를 부르는 경우, 레거시 DB와 신규 DB를 한 요청에서 함께 쓰는 경우입니다.

### 증상

`jpa-10`에서 원 사례와 같은 형태의 로그가 그대로 찍혔습니다.

```
HikariPool-1 - Connection is not available, request timed out after 30000ms (total=10, active=10, idle=0, waiting=12)
HikariPool-1 - Connection is not available, request timed out after 30000ms (total=10, active=10, idle=0, waiting=9)
HikariPool-1 - Connection is not available, request timed out after 30001ms (total=10, active=10, idle=0, waiting=10)
```

![풀이 마른 순간의 HikariCP 로그](/uploads/incident/hikaricp-pool-deadlock/fig-hikari.png)

`total=10, active=10, idle=0`이 일치합니다. `waiting`은 그 순간 대기 중인 스레드 수라 9에서 15까지 흔들립니다.

같은 시각 애플리케이션이 DB에 물어본 `Threads_connected`는 10이었습니다. `max-connections`가 500인 서버에서 커넥션 10개만 쓰는 상태로 애플리케이션이 멈춰 있었습니다.

## 3. 내부 원리

### 데드락의 조건

스레드 16개가 모두 첫 커넥션을 잡은 뒤 두 번째를 요청하면, 풀이 10일 때 아무도 두 번째를 못 받습니다. 첫 번째를 내놓아야 남이 진행할 수 있는데, 자기도 두 번째를 기다리느라 내놓지 않습니다. 서로가 서로를 기다립니다.

위키 공식의 `Cm - 1`이 여기서 나옵니다. 각 스레드에 커넥션 하나씩은 이미 나갔다고 보고, 그 상태에서 한 스레드라도 완주할 수 있게 여유분 1개를 더 두는 계산입니다. 그래서 하한선입니다. 하한선에서는 한 번에 한 스레드만 진행하므로 처리량이 나오지 않습니다.

### Hibernate 6에서 달라진 것

순차 INSERT를 하며 시퀀스 테이블을 관측했습니다.

```console
기동 직후  next_val=1
INSERT #1 → next_val=51   max(id)=1   {"status":"ok","ms":40}
INSERT #2 → next_val=101  max(id)=2   {"status":"ok","ms":7}
INSERT #3 → next_val=101  max(id)=3   {"status":"ok","ms":4}
INSERT #4 → next_val=101  max(id)=4   {"status":"ok","ms":4}
```

![Hibernate 6이 몇 건마다 채번하는가](/uploads/incident/hikaricp-pool-deadlock/fig-sequence.png)

`next_val`이 1에서 51, 101로 뛴 뒤 멈춰 있습니다. Hibernate 6은 pooled 옵티마이저가 기본이고 `allocationSize`가 50입니다. 한 번 채번하면 ID 50개를 확보해 메모리에서 나눠 씁니다.

그래서 두 번째 커넥션은 50건에 한 번만 필요합니다. 데드락 조건이 상시로 성립하지 않고 간헐적으로만 성립합니다. 첫 요청만 41ms이고 이후 3~8ms인 것도 여기서 나옵니다. 첫 요청이 채번 커넥션을 여는 비용을 냅니다.

테이블 이름도 달랐습니다. 원 사례가 말하는 전역 `hibernate_sequence` 단일 행이 아니라 엔티티별 `sponsor_jpa_seq`가 생겼습니다.

```console
spoon> SHOW TABLES LIKE '%seq%';
sponsor_jpa_seq
```

전역 단일 행이면 서로 다른 엔티티의 INSERT가 같은 행을 놓고 줄을 섭니다. 엔티티별로 갈리면 그 경합도 사라집니다. 원 사례의 Hibernate 버전은 원문에 없습니다. 그러니 여기서 말할 수 있는 것은 두 동작이 다르다는 사실뿐입니다.

## 4. 해소

세 가지 길이 있고 성격이 다릅니다.

**풀을 늘립니다.** 원 사례의 선택입니다. 코드를 안 고쳐도 되지만 DB 쪽 커넥션 수가 늘어납니다. 애플리케이션 인스턴스가 여러 대면 그만큼 곱해집니다. 하한선은 `Tn × (Cm - 1) + 1`이고, 실제로는 여유를 더 둡니다.

**동시 보유 개수를 1로 줄입니다.** 첫 커넥션을 반납한 뒤 두 번째를 빌립니다. `Cm`이 1이 되면 공식상 필요한 풀은 스레드 수와 무관하게 1이 되어 데드락 자체가 성립하지 않습니다. 다만 두 작업이 한 트랜잭션으로 묶이지 않습니다. 원자성이 필요한 곳에는 쓸 수 없습니다.

**채번 방식을 바꿉니다.** `AUTO` 대신 `IDENTITY`를 쓰면 MySQL의 `AUTO_INCREMENT`를 그대로 쓰므로 별도 커넥션이 사라집니다. 잃는 것은 JDBC 배치 INSERT입니다. Hibernate는 INSERT를 보내기 전에는 생성된 키를 모르므로 배치로 묶지 못합니다. 같은 시리즈의 [JPA 목록 API의 세 함정](/blog/incident/jpa-list-api)에서 `saveAll`이 `IDENTITY` 때문에 느려지는 쪽을 다뤘습니다.

세 가지 모두 측정했습니다. 5절에 있습니다.

## 5. 재계측

조건은 40초, 동시 요청 16입니다.

![조건별 처리량과 실패율, 그리고 느린 요청이 먹은 워커 시간](/uploads/incident/hikaricp-pool-deadlock/chart-pool.png)

4회 반복의 중앙값이고 괄호는 최소에서 최대입니다.

| 조건 | 실패 | 실패율 | 초당 처리량 | p50 | p95 |
|---|---|---|---|---|---|
| `jpa-10` | 7건 (네 번 다) | 0.5% | 37.2 (34.2~40.1) | 39ms | 55ms |
| `jpa-24` | 0건 | 0% | 141.1 (136.6~164.3) | 40ms | 55ms |
| `two-10` | 19~21건 | 64.1% | 0.3 (0.3~0.5) | 30,096ms | 30,129ms |
| `one-10` | 0건 | 0% | 151.2 (126.5~152.8) | 78ms | 85ms |

`two-10`이 데드락의 순수한 모습입니다. 40초 동안 요청이 32건밖에 처리되지 않았고 그중 19건에서 21건이 30초를 꽉 채우고 죽었습니다. p50이 30초라는 것은 절반 이상이 타임아웃까지 갔다는 뜻입니다.

`one-10`은 같은 풀 10에서 네 회차 모두 실패 없이 처리했습니다. 초당 151건 안팎입니다. 풀 크기를 건드리지 않고 동시 보유 개수만 1로 줄여서 얻은 결과입니다. 요청당 지연은 p50 78ms로 `jpa-24`의 40ms보다 긴데, 커넥션을 두 번 나눠 빌리니 획득 비용을 두 번 내기 때문입니다. 그래도 한 번도 실패하지 않습니다.

### 실패율 0.5%가 처리량을 4분의 1로 떨어뜨렸습니다

`jpa-10`과 `jpa-24`를 비교하면 실패율 차이는 0.5%포인트인데 처리량은 초당 37.2건과 141.1건으로 벌어집니다. 회차마다 계산하면 3.6배에서 4.3배입니다. 요청별 소요 시간을 나눠 봤습니다.

| 조건 | 1초 초과 | 1초 초과가 차지한 워커 시간 |
|---|---|---|
| `jpa-10` | 16건 (네 번 다) | 88.4~89.1% |
| `jpa-24` | 0건 | 0% |
| `two-10` | 32건 (네 번 다) | 99.9~100% |
| `one-10` | 0건 | 0% |

`jpa-10`에서 1초를 넘긴 요청은 네 회차 모두 정확히 16건이고 전체의 1.1% 안팎입니다. 그 16건이 워커 시간의 88.4%에서 89.1%를 먹었습니다. 워커 16개가 40초 동안 쓸 수 있는 시간이 640초인데 그중 570초 가까이가 이 16건에 묶여 있었습니다.

대시보드에서 실패율만 보면 0.5%라 정상으로 보입니다. p95도 61ms로 멀쩡합니다. 이 조건에서 이상을 알아채려면 최대값이나 요청별 소요 시간의 분포를 봐야 합니다. p95까지만 보는 대시보드는 이 장애를 놓칩니다.

`two-10`이 640초를 넘겨 쓰는 이유는 타임아웃 30초짜리 요청이 측정 종료 시각을 넘겨 끝났기 때문입니다.

### 채번 방식이 결론을 가릅니다

`allocationSize`를 1로 낮춘 조건과 `IDENTITY` 조건을 새로 쟀습니다. 앞의 것은 원 사례에 더 가까운 강도를 만들려는 조건이고, 뒤의 것은 해소책 세 번째입니다.

![해소책 세 가지와 강도 조건](/uploads/incident/hikaricp-pool-deadlock/chart-remedies.png)

| 조건 | 채번 | 풀 | 실패 | 실패율 | 초당 처리량 | p50 |
|---|---|---|---|---|---|---|
| `two-10` | 없음(커넥션 2개 직접) | 10 | 21 | 65.6% | 0.3 | 30,098ms |
| `seq1-10` | AUTO, `allocationSize=1` | 10 | 19 | **50.0%** | **0.5** | **30,062ms** |
| `jpa-10` | AUTO, `allocationSize=50` | 10 | 7 | 0.5% | 38.5 | 39ms |
| `jpa-24` | 같음 | 24 | 0 | 0% | 164.3 | 37ms |
| `one-10` | 같음, 동시 보유 1개 | 10 | 0 | 0% | 151.2 | 78ms |
| `idn-10` | **IDENTITY** | 10 | 0 | **0%** | **180.9** | 44ms |

**`allocationSize=1`이 원 사례의 강도를 재현합니다.** 실패율 50%에 p50 30초로, 커넥션을 직접 두 개 잡는 `two-10`과 사실상 같습니다. 시퀀스 테이블의 `next_val`이 19행에 20으로 1씩 오른 것이 확인됩니다. 채번이 매 건 일어나므로 `save()` 한 번마다 커넥션 두 개를 상시로 요구합니다.

이것이 "원 사례는 왜 더 심했는가"에 대한 답의 후보입니다. 원문이 전역 `hibernate_sequence` 단일 행을 쓴다고 적었으니 pooled 옵티마이저가 없었을 가능성이 있고, 그러면 `seq1-10`이 그 상태입니다. 다만 원문에 버전과 `allocationSize`가 없으므로 단정하지 않겠습니다.

**`IDENTITY`가 처리량으로는 가장 좋습니다.** 풀 10 그대로 실패 0건에 초당 180.9건으로 모든 조건 중 1위입니다. 풀을 24로 올린 `jpa-24`보다도 높습니다. 별도 커넥션이 아예 없으므로 데드락 조건이 성립하지 않습니다.

### 그 대가는 배치 INSERT입니다

`saveAll`로 같은 건수를 넣고 시간만 비교했습니다. 워밍업 뒤 3회씩 잰 중앙값입니다.

| 건수 | AUTO (배치로 묶임) | IDENTITY (안 묶임) | 배수 |
|---|---|---|---|
| 1,000 | 62ms | 110ms | 1.8배 |
| 5,000 | 180ms | 370ms | 2.1배 |
| 10,000 | 295ms | 752ms | 2.5배 |

건수가 늘수록 배수가 벌어집니다. `hibernate.jdbc.batch_size=100`과 `rewriteBatchedStatements=true`를 켠 상태이고, `AUTO`는 ID를 미리 확보해 두었으므로 INSERT를 묶어 보낼 수 있습니다. `IDENTITY`는 INSERT를 보내야 키를 알기 때문에 한 건씩 갑니다. 원 사례가 배치성 소비자 애플리케이션이었다는 점이 여기서 걸립니다.

### 풀을 늘리는 해소책의 대가

해소책 첫 번째는 인스턴스 하나를 기준으로 계산된 값입니다. 앱 컨테이너를 3대까지 띄워 봤습니다.

![인스턴스를 늘리면 커넥션이 곱해진다](/uploads/incident/hikaricp-pool-deadlock/fig-multi.png)

```console
앱 없을 때 기준 접속 = 1
  인스턴스 1대 → 접속 25 (기준 제외 24)  풀 24 x 1 = 24 기대
  인스턴스 2대 → 접속 49 (기준 제외 48)  풀 24 x 2 = 48 기대
  인스턴스 3대 → 접속 73 (기준 제외 72)  풀 24 x 3 = 72 기대
```

정확히 곱해집니다. `max_connections`를 60으로 낮춰 상한에 닿게 하면 이렇게 됩니다.

```console
    ERROR 1040 (HY000): Too many connections

    인스턴스 1: {"total":24,...,"db_threads_connected":61}
    인스턴스 2: {"total":24,...,"db_threads_connected":61}
    인스턴스 3: {"total":13,...,"db_threads_connected":61}
```

여기가 위험한 자리입니다. **인스턴스 3은 정상 기동해 `/pool`이 200을 돌려주는데 풀이 24가 아니라 13입니다.** 상한에 걸려 절반만 확보했는데 앱 로그에 `Too many connections`가 한 건도 없습니다. HikariCP가 조용히 재시도하다 확보한 만큼만 들고 도는 것입니다. 막힌 것은 관리자 접속뿐이라 장애가 나기 전에는 아무도 모릅니다.

그러니 풀 24는 인스턴스 하나의 계산입니다. 인스턴스 수를 곱한 값이 `max_connections` 안에 들어가는지 따로 확인해야 하고, 그 확인을 앱의 헬스체크로는 할 수 없습니다.

### 커넥션을 쥔 코드를 찾는 방법

`leakDetectionThreshold`를 2초로 두고 `two-10` 경로에 부하를 줬습니다.

![leakDetectionThreshold가 찍은 코드 줄](/uploads/incident/hikaricp-pool-deadlock/fig-leak.png)

```
java.lang.Exception: Apparent connection leak detected
	at com.zaxxer.hikari.HikariDataSource.getConnection(HikariDataSource.java:127)
	at lab.b01.SponsorService.sponsorTwoConnections(B01Application.java:185)
```

185번 줄이 첫 커넥션을 쥔 채 두 번째를 요청하는 그 자리입니다. 30건 잡혔습니다. 이 설정이 없으면 어느 코드가 커넥션을 오래 잡는지 추적할 방법이 스레드 덤프뿐입니다. 기본값은 0, 곧 꺼져 있습니다.

## 6. 예상과 달랐던 점

### 원 사례를 그대로 재현했더니 전멸하지 않았습니다

`jpa-10`이 `two-10`처럼 멈출 줄 알았는데 1,433건이 성공했습니다. 원인은 위에 적은 `allocationSize=50`과 엔티티별 시퀀스 테이블입니다. 두 번째 커넥션이 50건에 한 번만 필요하니 데드락 조건이 상시로 성립하지 않습니다.

원 사례의 Hibernate 버전을 확인하지 못했으므로 원 사례가 왜 더 심했는지는 단정하지 않겠습니다. 확인한 것은 여기까지입니다. Hibernate 6 기본값에서는 `@GeneratedValue(AUTO)` 하나만으로 완전한 데드락에 이르지 않고, 대신 처리량이 4분의 1로 떨어지는 형태로 나타납니다.

이 차이가 오히려 실무에 가깝다고 봅니다. 완전히 멈추면 바로 알아채지만, 처리량만 4분의 1로 떨어지면 한참 모릅니다.

### 실패 예외가 두 종류였습니다

`jpa-10`의 실패 7건은 `CannotCreateTransactionException` 6건과 `DataAccessResourceFailureException` 1건이었습니다. 앞의 것은 트랜잭션을 여는 첫 커넥션조차 못 받은 경우고, 뒤의 것은 트랜잭션은 열렸는데 그 안에서 커넥션을 잃은 경우입니다.

`two-10`은 전부 `SQLTransientConnectionException`이었습니다. `@Transactional` 없이 `DataSource.getConnection()`을 직접 부르니 HikariCP의 예외가 그대로 올라옵니다.

같은 원인인데 스택 위쪽 어디서 잡히느냐에 따라 예외 이름이 달라집니다. 예외 이름으로 검색하면 서로 다른 문서로 흩어집니다.

### 만들면서 또 밟은 Spring 함정

`SponsorService`에 `@Transactional`을 붙이자 빈이 프록시로 감싸였고, 컨트롤러가 `svc.ok` 필드를 직접 읽던 코드가 NPE를 냈습니다. 프록시의 필드는 초기화되지 않은 채 남고 값은 프록시가 감싼 실제 객체에 있습니다.

같은 시리즈의 [라이브 후원 카운터의 핫 로우](/blog/incident/slotted-counter)에서 똑같이 겪고 적어 둔 함정입니다. 알고 있었는데 새 세션에서 같은 코드를 쓰면서 다시 밟았습니다. 접근자 메서드를 두어 고쳤습니다.

```java
// @Transactional이 붙은 빈은 프록시로 감싸인다. 밖에서 필드를 직접 읽으면
// 대상 객체가 아니라 프록시의 미초기화 필드를 보게 되므로 접근자를 둔다.
private final AtomicLong ok = new AtomicLong();

long okCount() { return ok.get(); }
void addOk()   { ok.incrementAndGet(); }
```

## 못 한 것

2026-07-30에 네 항목을 실제로 측정해 지웠습니다(`IDENTITY` 전환, `allocationSize=1`, 인스턴스 여러 대, `leakDetectionThreshold`). 결과는 5절에 있습니다.

- **원 사례의 Hibernate 버전 확인.** 원문에 명시되지 않아 추정을 적지 않았습니다.
- **부하 발생기가 앱, DB와 같은 호스트에 있습니다.** 절대 수치를 서비스 용량으로 읽으면 안 되고 조건 간 비교로만 읽어야 합니다.

---

재현에 쓴 compose 파일과 실행 출력 원문은 [incident-lab 저장소의 B01 세션](https://github.com/dj258255/incident-lab/tree/main/sessions/B01-hikaricp-pool-deadlock)에 있습니다.

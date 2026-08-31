---
title: '초록불 점검: 만들어놓고 켜본 적 없는 것들'
description: '기본 off인 배치 열 개, 안 돌리던 테스트 둘, 실재하지 않는 테이블을 설명하던 ERD. 전부 켜보니 도는데, 정작 그걸 잡으라고 만든 검사기가 하루에 두 번 헛통과했다. 한 번은 대상을 0개 찾고, 한 번은 아예 실행되지 않고.'
date: 2026-08-29T00:00:00.000Z
tags:
  - Payment
  - 테스트
  - Spring Boot
  - 배치
  - 결제 시스템
category: study/pay
coverImage: "/uploads/project/pay/thumbs/pay-ch13.svg"
draft: false
series: "결제 시스템 만들기"
seriesOrder: 7
---

*결제 시스템 시리즈 7편. 6편의 마지막 문단에서 이어진다.*

## 세 번이면 규칙으로 만들어야 한다

6편은 이렇게 끝났다. 감사 로그 서비스에 호출부가 없었고, 비밀번호 이관 서비스는 배선 확인 없이 단위 테스트만 있었고, 결제사 라우팅도 켰을 때 실제로 꽂히는지 아무도 검증하지 않았다. 전부 **있는지**만 보고 **불리는지**를 안 본 것이었다.

셋 다 개별 테스트를 붙여서 막았다. 그런데 남은 게 있었다.

배치가 열 개다. 전부 기본 off인데, 켜려면 두 가지가 **같은 프로퍼티로** 함께 켜져야 한다.

```java
@Component
@ConditionalOnProperty(name = "app.settlement.enabled", havingValue = "true")
class SettlementScheduler {
    @Scheduled(fixedDelayString = "...")
    public void run() { ... }
}

@Configuration
@EnableScheduling
@ConditionalOnProperty(name = "app.settlement.enabled", havingValue = "true")
class SettlementSchedulingConfig { }
```

둘 중 하나만 켜지면 어떻게 되냐면, **아무 일도 안 일어난다.** 빈은 정상 등록되고, 기동 로그도 깨끗하고, `@Scheduled` 메서드만 영원히 안 불린다. 예외도 경고도 없다.

정산 배치를 켠 줄 알았는데 정산이 안 되고 있는 상태를, 며칠 뒤 대사에서야 알게 된다.

지금은 열 쌍이 전부 맞게 짝지어져 있다. 확인했다. 문제는 **그걸 지켜주는 게 각 클래스의 javadoc뿐**이라는 것이었다. 스케줄러를 하나 더 추가하거나 프로퍼티 이름을 바꾸는 순간 조용히 어긋난다.

열 개를 개별 테스트로 막기엔 수가 많다. 그래서 인스턴스 대신 **규칙 자체**를 검사하기로 했다. `@Scheduled`를 가진 모든 클래스에 대해, 같은 게이트를 쓰는 `@EnableScheduling` 설정이 존재하는가.

## 그 검사기가 0개를 찾고 통과할 뻔했다

Spring이 클래스패스 스캐너를 제공한다. 이걸 쓰면 되겠다 싶었다.

```java
var provider = new ClassPathScanningCandidateComponentProvider(false);
provider.addIncludeFilter((TypeFilter) (reader, factory) -> true);
provider.findCandidateComponents("com.beomsu.pay");
```

테스트가 실패했다. 스케줄러를 **0개** 찾았다.

원인은 이랬다. `ClassPathScanningCandidateComponentProvider`는 후보를 모으면서 `@Conditional`을 **평가한다.** 그리고 이 프로젝트의 배치는 전부 기본 off다. 즉 검사하려는 대상이 정확히 "지금 조건을 만족하지 않는 클래스들"인데, 스캐너가 바로 그것들을 걸러낸 것이다.

여기서 중요한 건 **왜 알아챘느냐**다.

```java
assertThat(schedulerGates)
        .as("@Scheduled 스케줄러를 찾지 못했다면 이 테스트는 아무것도 검증하지 못한다")
        .hasSizeGreaterThanOrEqualTo(10);

assertThat(schedulerGates).allSatisfy((scheduler, gate) -> ...);
```

두 번째 줄만 있었으면 이 테스트는 **통과했을 것이다.** 빈 컬렉션에 대해 `allSatisfy`는 참이다. 검사 대상이 0개인 검사는 언제나 성공한다.

그러니까 이건 이렇게 될 뻔했다. 이름은 `SchedulerGatePairingTest`이고, CI에서 초록불이고, 아무것도 검증하지 않는다. **"있는데 안 불리는" 버그를 막으려고 만든 테스트가, "있는데 아무것도 안 보는" 같은 종류의 물건이 될 뻔한 것이다.**

6편에서 k6 스크립트에 `shed_global > 0`을 임계치로 걸어둔 것과 정확히 같은 장치였다. 그때는 "실험이 성립했는지를 실험이 스스로 말하게 하자"였고, 여기서는 "검사가 대상을 찾았는지를 검사가 스스로 말하게 하자"였다. 우연히도 하루 만에 두 번 같은 도구가 필요했다.

## 고친 방법

조건을 평가하지 않고, 클래스를 로드하지도 않고, 바이트코드의 애너테이션 메타데이터만 읽는다.

```java
var resolver = new PathMatchingResourcePatternResolver();
var factory = new CachingMetadataReaderFactory(resolver);
for (var resource : resolver.getResources("classpath*:com/beomsu/pay/**/*.class")) {
    AnnotationMetadata metadata = factory.getMetadataReader(resource).getAnnotationMetadata();
    if (metadata.hasAnnotatedMethods(Scheduled.class.getName())) { ... }
}
```

열 개를 다 찾았고 열 쌍 다 맞았다.

그리고 **일부러 깨뜨려봤다.** 짝이 되는 설정의 게이트 이름 하나를 오타로 바꿨다.

```java
- @ConditionalOnProperty(name = "app.outbox.cleanup.enabled", ...)
+ @ConditionalOnProperty(name = "app.outbox.cleanup.TYPO", ...)
```

실패했다. 원복하니 다시 통과했다. 이 확인을 안 하면 결국 "통과하는 걸 봤다"까지밖에 모른다. 초록불이 무엇을 뜻하는지는 **빨간불을 한 번 봐야** 알 수 있다.

## 남은 여섯 개를 마저 켰다

배선은 이제 구조로 보장된다. 그런데 아직 **켜고 실제로 도는 걸 본 적은 없는** 배치가 여섯 개였다. 주문 만료, 체크아웃 복구, 가상계좌 만료, 에스크로 자동 릴리스, 멱등키 정리, 아웃박스 정리.

여기서 함정이 하나 더 있었다. 여섯 중 다섯이 이렇게 생겼다.

```java
if (deleted > 0) {
    log.info("멱등키 정리 완료 deleted={}", deleted);
}
```

처리할 게 없으면 로그를 안 남긴다. 그러니 **"로그가 없다"가 "안 돌았다"를 뜻하지 않는다.** 켜놓고 로그를 지켜보는 걸로는 아무것도 증명 못 한다.

그래서 각 배치의 대상 조건에 맞는 데이터를 심었다. 만료 시각이 지난 미결제 주문, `PAYMENT_IN_PROGRESS`로 두 시간 멈춰 있는 사가, 기한 지난 가상계좌, 보류 기간이 끝난 에스크로 홀드 같은 것들이다.

10초 주기로 돌려놓고 기다렸다.

```
Outbox 완료 이벤트 정리 completed deleted=6 retentionDays=0
에스크로 자동 릴리스 완료 count=1
멈춘 체크아웃 복구 완료 recovered=1
주문 만료 배치 완료 count=1
멱등키 정리 완료 deleted=1
가상계좌 만료 배치 완료 count=1
```

DB에서도 확인했다. 주문 하나가 `EXPIRED`, 멈춰 있던 사가가 `PAID`로 완결, 에스크로가 `RELEASED`, 계좌가 `EXPIRED`, 멱등키 0건, 아카이브 0건.

이제 기본 off인 플래그 열한 개가 **전부 실제로 도는 걸 본 상태**가 됐다.

### 덤으로 6편의 주장 하나가 검증됐다

6편에서 아웃박스를 고치면서 "아카이브 모드는 기존 정리 스케줄러를 대체하는 게 아니라 짝을 이룬다"고 적었다. 아카이브가 핫 테이블을 미처리분만 남기고, 스케줄러가 아카이브를 보존기간 뒤에 비운다고.

**그때는 그렇게 될 거라고 적기만 했지 확인하지 않았다.** 이번에 정리 배치가 `deleted=6`을 찍었고, 그 6건은 아카이브 테이블에서 나왔다. 적어둔 대로였다.

문서에 적은 걸 나중에 확인해보는 건 생각보다 자주 필요하다. 적을 때는 맞는 줄 알고 적으니까.

## 안 돌리던 테스트 두 개

컨테이너가 필요해서 기본 스위트에서 빼놓은 태스크가 둘 있었다. 오늘 둘 다 돌렸다.

- `integrationTest`: 실 MySQL(Testcontainers)에서 승인·취소가 **DB에 확정되는지**. 응답이 아니라 상태를 본다. 13개 통과.
- `chaosTest`: Toxiproxy로 MySQL 연결을 실제로 끊고 깨끗하게 실패하는지 + 멱등 생존. 1개 통과.

합쳐서 582개다. 기본 568 + 통합 13 + 카오스 1. README에는 567만 적혀 있었는데, 그건 "돌리기 쉬운 것만 센 숫자"였다. 정확히 고쳤다.

## 그리고 문서에 없던 표

배치와 선택 기능 열한 개가 전부 기본 off인데, **그 목록이 어느 문서에도 없었다.**

배포하는 사람이 제일 먼저 필요한 게 이건데. 무엇을 켜야 시스템이 온전히 도는지 알려면 코드를 뒤져 `@ConditionalOnProperty`를 전부 찾는 수밖에 없었다. README에 환경변수, 하는 일, 주기를 표로 넣었다.

이런 게 자꾸 나온다. 기능은 다 만들어놨는데 **그걸 켜는 방법이 적혀 있지 않은 것.** 만든 사람은 알고 있으니 안 적게 된다.

## 한 번 더, 같은 자리에서

여기까지 하고 "이제 없다"고 말하려다가 한 가지만 더 봤다.

6편에서 ERD 문서가 `outbox_events`라는 **채택되지 않은 설계**를 설명하고 있는 걸 발견했었다. 실제로는 Modulith의 `event_publication`을 쓰는데 문서가 결정 이전 상태에 멈춰 있었던 것이다. 그때는 그 한 건만 고쳤다.

그런데 그게 하나뿐이었을까? 확인해볼 수 있는 일이었다. 마이그레이션이 실제로 만드는 테이블 목록과, 문서가 `CREATE TABLE`로 설명하는 테이블 목록을 대조했다.

**네 개가 더 있었다.**

| 문서 | 실제 |
|---|---|
| `ledger_accounts` | 테이블이 아니라 enum `AccountType` |
| `payment_cancels` | 안 만듦. 취소 이력은 `payment_history`에 함께 쌓는다 |
| `pg_transactions` | 안 만듦. 대사 중에만 필요해 비영속 record로 흘린다 |
| `settlement_details` | 이름이 `settlement_items`로 바뀜 |

이런 어긋남은 **조용하다.** 코드는 잘 돌고, 테스트도 통과하고, 문서만 틀린다. 그리고 그 문서를 믿고 쿼리를 짜거나 설계를 설명하는 사람이 틀리게 된다. 대개 "그 테이블이 왜 없죠?"라는 질문으로 발견된다.

전부 표시하고, 앞에서 한 것과 같은 방식으로 규칙을 검사하게 만들었다. ERD 문서의 모든 `CREATE TABLE`은 **실물이거나, 실물이 아님이 같은 줄에 표시되어 있거나** 둘 중 하나여야 한다.

안 만든 설계를 문서에 남기는 것 자체는 막지 않았다. "왜 그렇게 안 했는지"가 기록으로 남는 건 가치가 있다. 다만 **표시 없이** 남기는 건 막는다. 표시가 없으면 읽는 사람이 그게 실물인 줄 안다.

### 그 검사가 안 돌고 있었다

앞에서 배운 대로, 만들자마자 깨뜨려봤다. `(미구현)` 표시를 지우고 테스트를 돌렸다.

**통과했다.**

```
BUILD SUCCESSFUL in 613ms
```

613밀리초. 테스트가 아예 실행되지 않은 것이다. Gradle은 test 태스크의 입력이 무엇인지 안다. 자바 소스와 리소스다. `.md` 파일은 거기 없다. 그러니 문서만 고치면 "바뀐 게 없다"고 판단해 태스크를 통째로 건너뛴다.

즉 **문서와 스키마가 어긋나는 걸 잡으라고 만든 검사가, 정확히 문서만 바뀌었을 때 안 도는** 상태였다.

CI는 초록불이다. 검사는 돌지 않는다. 둘이 동시에 참이다.

고치는 건 간단했다.

```groovy
inputs.dir('docs').withPropertyName('docs')
inputs.dir('src/main/resources/db/migration').withPropertyName('migrations')
```

이제 문서만 고쳐도 재실행된다. 다시 표시를 지워보니 이번엔 제대로 실패했다.

하루에 두 번이다. 앞에서는 검사기가 **대상을 0개 찾고** 통과할 뻔했고, 여기서는 검사기가 **아예 실행되지 않고** 통과했다. 실패하는 방식은 달랐는데 결과는 같았다. 초록불이고, 아무것도 검증되지 않았다.

"검사를 만들었다"와 "그 검사가 실제로 돈다"는 다른 문장이다. 전자는 코드를 쓰면 참이 되지만, 후자는 **빨간불을 한 번 봐야** 참인지 알 수 있다.


---

## 문서 전체를 코드와 대조했다

ERD에서 다섯 개가 나오고 나니 질문이 남았다. **문서가 코드보다 앞서 있는 자리가 ERD뿐일까.**

`CREATE TABLE`만 봤으니 본 것도 그만큼이다. 그래서 대상을 넓혔다. 문서에서 백틱으로 감싼 식별자를 **전부** 뽑아 코드와 대조하는 스크립트를 썼다.

```
문서 27개 · 코드 파일 335개 검사
⚠ 코드에서 못 찾은 심볼 24개
```

24개 중 **21개는 정당한 인용**이었다.

| 분류 | 예 |
|---|---|
| 외부 라이브러리 | `ChatModel`(Spring AI), `DefaultErrorHandler`(Spring Kafka) |
| 외부 시스템 스펙 | `PAYMENT_STATUS_CHANGED`: 토스 **웹훅** 이벤트명 |
| 채택 안 한 대안 | `OrderTimelineContributor`: ADR-011의 "안 2" |
| "없다"는 서술 | `CAPTURED`: *"pay에 CAPTURED 같은 상태는 없다"* |
| Prometheus 알람 | `GlobalRateLimitBinding`: Java가 아니라 `alert-rules.yml`에 실재 |

마지막 건 내 감사 스크립트가 Java만 훑어서 놓친 것이다. **감사도 감사받아야 한다.**

### 남은 3개가 진짜였다

API 스펙이 **오지 않는 에러 코드**를 문서화하고 있었다.

| 문서가 말한 것 | 실제로 나가는 것 |
|---|---|
| `CONCURRENT_MODIFICATION` (409) | `STOCK_CONCURRENCY` / `WALLET_CONCURRENCY` |
| `PG_ERROR` (502) | **안 나감** |
| `PG_TIMEOUT` (504) | **안 나감** |

클라이언트 입장에서 **두 번 손해**다. 오지 않을 코드로 분기를 만들고, 실제로 오는 코드는 문서에 없어서 못 다룬다. **결제 API에서 이건 재시도 로직이 통째로 어긋난다는 뜻이다.**

PG 오류에 502/504가 없는 건 사실 설계 의도였다. PG가 실패하거나 응답이 없으면 결제를 `UNKNOWN`으로 **보존**하고 복구 배치가 조회로 확정한다(1편). 그래서 클라이언트가 받는 건 별도 HTTP 코드가 아니라 **승인 응답의 상태값**이다. 문서만 옛날 계획을 붙들고 있었다.

**재발을 막는 테스트를 붙였다.** 스펙 표에서 코드를 뽑아 실제로 던지는 문자열과 대조한다. 앞의 ERD 문서 대 마이그레이션과 같은 발상이다. **문서가 코드보다 앞서가는 걸 사람이 알아채길 기다리지 않는다.**
---

이틀에 걸쳐 잡은 걸 돌아보면 전부 한 종류였다. 감사 로그, 비밀번호 이관, 결제사 라우팅, 배치 여섯 개, 유입 제어의 전역 층, ERD 문서의 테이블 다섯 개, API 스펙의 유령 에러 코드 세 개, 그리고 검사기 자신이 두 번.

**만들어놓고 켜본 적 없는 것들.**

코드가 있다는 건 아무것도 보장하지 않는다. 테스트가 있다는 것도 마찬가지고, 심지어 **그 테스트가 실행됐다는 것조차** 확인하기 전까지는 그렇다.

그래서 이제 검사를 하나 만들 때마다 반드시 두 가지를 한다. 대상을 하나라도 찾았는지 하한을 걸고, 일부러 깨뜨려서 빨간불을 본다. 둘 다 오늘 실제로 필요했다.

---
coverImage: /uploads/covers/ai-generated/theory/java-time-five-decisions.png
title: '자바에서 시간을 스마트하게 다루는 방법이란?'
description: '알리바바 클라우드의 "How Can We Manipulate Time Gracefully in Java?"를 순서 그대로 따라가며 예제를 서울 시간대와 한국어 로캘로 바꿔 실행했습니다. 원문과 실제가 다른 여덟 곳은 고쳐 적었습니다. KST 약어, 1988년 서머타임, 만 나이, 공휴일을 건너뛰는 영업일, 연결 설정 없이 쓰면 UTC 컨테이너에서 9시간 어긋나는 저장 시각처럼 한국에서 쓸 때 걸리는 곳은 JDK 17, 21, 25와 MySQL 8.4, PostgreSQL 16으로 확인해 보탰습니다.'
date: 2026-10-12
tags:
  - Java
  - java.time
  - Time Zone
  - Instant
  - LocalDateTime
  - DateTimeFormatter
  - SimpleDateFormat
  - MySQL
  - PostgreSQL
  - JDBC
category: theory/Systems
topics:
  - systems
  - database
draft: false
---

이 글은 알리바바 클라우드 커뮤니티의 "How Can We Manipulate Time Gracefully in Java?"를 순서 그대로 따라갑니다. 아래에서는 그 글을 원문이라고 부릅니다. 원문은 컴퓨터가 시간을 저장하는 방식에서 시작해 `java.util`의 옛 API와 `java.time`의 새 API를 차례로 소개하고 둘 사이의 변환, DB 매핑, 시간 도구 클래스로 끝납니다. 원문의 예제는 상하이 시간대와 중국어 로캘(언어와 지역 설정)로 쓰여 있습니다. 여기서는 예제를 서울 시간대와 한국어 로캘로 바꿔 JDK 17, 21, 25에서 실행했고 원문과 실제가 다른 곳은 고쳐 적었습니다. 한국에서 쓸 때 걸리는 곳은 절마다 보탰습니다.

원문의 결론은 둘입니다. 날짜와 시간은 Java 8부터 들어온 `java.time`으로 다루고 프로젝트의 시간 도구 클래스도 `java.time` 위에 만들라는 것입니다. 둘 다 그대로 따르면 됩니다. 실행해 보고 보탠 것은 아래 여섯 가지입니다.

1. `java.time`으로 옮길 이유는 실행 결과에서도 나옵니다. `SimpleDateFormat` 하나를 여덟 스레드가 함께 쓰자 format 160만 번 가운데 78만~86만 번이 틀린 결과였고 `DateTimeFormatter`는 0번이었습니다.
2. 한국 시간대는 `Asia/Seoul`로 가리킵니다. `TimeZone.getTimeZone("KST")`는 예외 없이 GMT를 돌려주고 `ZoneId.of("KST")`는 예외를 던집니다.
3. 서울 시간대에도 서머타임 때문에 없는 시각과 두 번 오는 시각이 있습니다. 1988년 5월 8일 02시 30분을 `atZone`에 넣으면 예외 없이 03시 30분이 됩니다.
4. `LocalDateTime.now()`와 `ZoneId.systemDefault()`는 서버의 시간대를 따릅니다. 서울 시간대의 장비에서 만든 코드를 UTC 컨테이너에 올리면 한국의 자정부터 오전 9시까지 "오늘"이 어제 날짜로 나옵니다. 연결 설정 없이 MySQL에 저장한 시각은 9시간 뒤의 시각으로 읽혔습니다.
5. 도구 클래스는 시계와 시간대와 공휴일 목록을 인자로 받게 만듭니다. 만 나이는 `Period.between`으로 나오고 다음 영업일은 공휴일 목록이 있어야 맞습니다. 2025년 10월 2일의 다음 영업일은 주말만 건너뛰면 10월 3일이고 공휴일까지 건너뛰면 10월 10일입니다.
6. 원문의 예제 네 곳과 설명 네 곳은 실제와 달랐습니다. 해당하는 절에서 고쳤고 끝에 표로 모았습니다.

## 1. 컴퓨터는 시간을 정수 하나로 저장하고 시간대를 붙여 보여 줍니다

컴퓨터가 저장하는 시간은 1970년 1월 1일 0시(UTC)부터 흐른 시간을 센 정수입니다. 이 정수를 에포크 시간 또는 타임스탬프라고 부르고 Java에서는 `System.currentTimeMillis()`가 밀리초 단위의 `long`으로 돌려줍니다. 이 정수는 세계 어디서나 같은 한 점을 가리킵니다. 이 글에서는 그 한 점을 순간이라고 부릅니다.

사람이 읽는 시각은 순간에 시간대를 적용한 결과입니다. 시간대는 UTC와의 차(오프셋)로 적고 한국 표준시는 UTC보다 9시간 빠른 `UTC+09:00`입니다. 원문은 `UTC+08:00`을 예로 듭니다. 정수 `1728300119000`은 서울에서 2024년 10월 7일 20시 21분 59초이고 UTC에서는 같은 날 11시 21분 59초입니다. 그래서 `2024-10-07 20:21:59`라는 글자만으로는 순간이 정해지지 않고 `+09:00`이나 `Asia/Seoul` 같은 시간대가 붙어야 정해집니다. 달력과 시계에 적힌 글자만 있는 시각은 이 글에서 달력의 시각이라고 부릅니다.

한국 표준시에는 지금 서머타임(여름에 시계를 한 시간 앞당기는 제도)이 없습니다. JDK 21의 `Asia/Seoul` 규칙에 2024년 10월 이후 오프셋이 다시 바뀌는 때를 물으면 없다는 답(`null`)이 돌아옵니다. 과거에는 오프셋이 여러 번 바뀌었고 그 영향은 4장에서 다룹니다.

원문은 프로그램을 짤 때 GMT와 UTC의 차이를 무시해도 된다고 적었고 이 글도 둘을 구분하지 않습니다.

## 2. JDK에는 날짜 API가 두 벌 있습니다

옛 API는 `java.util`의 `Date`, `Calendar`, `TimeZone`과 `java.text.SimpleDateFormat`입니다. 새 API는 JDK 8에 들어온 `java.time` 패키지입니다. 원문의 비교표를 항목별로 풀어 실행 결과와 Javadoc에 맞춰 다시 적었습니다.

| 항목 | `Date` | `Calendar` | `java.time` |
|---|---|---|---|
| 값을 바꿀 수 있는지 | 바꿀 수 있음(`setTime`) | 바꿀 수 있음(`set`, `add`) | 바꿀 수 없음. Javadoc이 스레드 안전하다고 적음 |
| 날짜 더하기와 빼기 | 없음 | `add` | `plus`, `minus`, `with` |
| 연도와 월 | 연도에 1900을 더하고 월은 0~11 | 연도는 그대로, 월은 0~11 | 연도와 월 모두 그대로 |
| 정밀도 | 밀리초 | 밀리초 | 나노초 |
| 시간대 | 없음. 찍을 때 JVM의 시간대를 씀 | `TimeZone` | `ZoneId`, `ZoneOffset` |
| 포매터 | `SimpleDateFormat` | `SimpleDateFormat` | `DateTimeFormatter` |
| 포매터를 여러 스레드가 함께 써도 되는지 | 안 됨 | 안 됨 | 됨 |

원문의 표에는 `Date`의 출력 예가 `Tue Oct 08 00:11:16 CST 2024`로 실려 있습니다. 1장의 정수 `1728300119000`으로 만든 `Date`를 서울 시간대의 JVM에서 찍으면 `Mon Oct 07 20:21:59 KST 2024`처럼 `KST`가 붙고 UTC로 띄운 JVM에서 찍으면 `Mon Oct 07 11:21:59 UTC 2024`가 됩니다. `Date`가 담는 것은 정수 하나이고 시간대는 찍을 때 JVM의 기본 시간대에서 가져옵니다.

## 3. 옛 API는 월을 0부터 세고 모르는 시간대 이름을 GMT로 받습니다

새 코드는 `java.time`으로 쓰더라도 이미 있는 코드와 라이브러리에는 옛 API가 남아 있습니다.

### `Date`는 밀리초 정수 하나이고 연도에는 1900을, 월에는 1을 더해야 읽힙니다

`Date`가 담는 것은 밀리초 단위의 `long` 하나이고 `new Date()`는 `System.currentTimeMillis()`의 값을 넣습니다. 연, 월, 일을 꺼내는 메서드는 돌려주는 기준이 서로 다릅니다. 서울 시간대의 JVM에서 실행한 결과입니다.

```java
Date d = new Date(1728300119000L);   // 서울 2024-10-07 20:21:59, 월요일
d.getYear();    // 124. 1900을 더해야 2024
d.getMonth();   // 9. 1을 더해야 10월
d.getDate();    // 7. 그대로 7일
d.getDay();     // 1. 요일이고 0이 일요일
```

### `Calendar`는 날짜를 더하고 뺄 수 있고 월은 여전히 0부터 셉니다

`Calendar`에는 `Date`에 없는 날짜 더하기와 빼기가 있습니다. 연도는 그대로 나옵니다.

```java
Calendar c = Calendar.getInstance(TimeZone.getTimeZone("Asia/Seoul"));
c.setTimeInMillis(1728300119000L);
c.get(Calendar.YEAR);          // 2024
c.get(Calendar.MONTH);         // 9. 10월
c.get(Calendar.DAY_OF_WEEK);   // 2. 1이 일요일이어서 월요일은 2

c.clear();
c.set(2019, 10, 20, 8, 15, 0);            // 10은 11월
c.add(Calendar.DAY_OF_MONTH, 5);
c.add(Calendar.HOUR_OF_DAY, -2);          // 2019-11-25 06:15:00
```

요일을 세는 기준도 타입마다 다릅니다. `Date.getDay()`는 일요일이 0이고 `Calendar.DAY_OF_WEEK`는 일요일이 1입니다. `java.time`의 `DayOfWeek`는 월요일이 1이고 일요일이 7입니다.

### `TimeZone`은 모르는 이름을 받으면 GMT를 돌려줍니다

`Calendar`는 `TimeZone`으로 시간대를 바꿉니다. 원문은 상하이 시각을 뉴욕 시각으로 바꾸는 예제를 실었습니다. 서울로 바꾸면 아래와 같습니다.

```java
Calendar c = Calendar.getInstance();
c.clear();
c.setTimeZone(TimeZone.getTimeZone("Asia/Seoul"));
c.set(2024, 9, 10, 8, 15, 0);                        // 서울 10월 10일 08:15
SimpleDateFormat sdf = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss");
sdf.setTimeZone(TimeZone.getTimeZone("America/New_York"));
sdf.format(c.getTime());                             // 2024-10-09 19:15:00
```

시간대는 `Asia/Seoul` 같은 지역 ID로 가리킵니다. 이름을 조금 틀리게 넣거나 KST 같은 약어를 넣으면 옛 API와 새 API가 다르게 반응합니다. 아래는 이름을 바꿔 가며 호출한 결과입니다.

| 호출 | 결과 |
|---|---|
| `TimeZone.getTimeZone("Asia/Seoul")` | Asia/Seoul |
| `TimeZone.getTimeZone("Asia/seoul")` | GMT |
| `TimeZone.getTimeZone("KST")` | GMT |
| `TimeZone.getTimeZone("JST")` | JST(+09:00). JDK 25는 세 글자 ID가 없어질 예정이라는 경고를 함께 찍음 |
| `ZoneId.of("Asia/seoul")` | `ZoneRulesException` |
| `ZoneId.of("KST")` | `ZoneRulesException` |

`TimeZone.getTimeZone`의 Javadoc에는 받은 ID를 이해하지 못하면 GMT를 돌려준다고 적혀 있습니다. 예외가 없으므로 `KST`를 넣은 코드는 한국 시각보다 9시간 느린 GMT 시각을 찍으면서 그대로 돌아갑니다. `Date`를 찍으면 `KST`라는 글자가 나오지만 이 글자는 ID로 받아 주지 않습니다. `ZoneId.of`에 함께 넘겨 쓰는 약어 표 `ZoneId.SHORT_IDS`에도 `JST`는 있고 `KST`는 없습니다.

### `SimpleDateFormat`은 스레드마다 따로 둡니다

원문은 `SimpleDateFormat`이 스레드 안전하지 않으므로 쓸 때마다 새로 만들거나 `ThreadLocal`에 넣으라고 적었습니다.

```java
static final ThreadLocal<SimpleDateFormat> SIMPLE_DATE_FORMAT_LOCAL =
        ThreadLocal.withInitial(() -> new SimpleDateFormat("yyyy-MM-dd HH:mm:ss"));
```

함께 쓰면 어떻게 되는지 재 봤습니다. 포매터 하나를 스레드 여덟이 함께 쓰며 스레드마다 20만 번, 모두 160만 번을 돌리고 미리 만들어 둔 정답과 비교했습니다. parse는 읽은 값을 다시 문자열로 찍어 정답과 견줬습니다. 표의 수는 세 차례 실행의 범위입니다.

| 방식 | 틀린 결과 | 예외 |
|---|---|---|
| `SimpleDateFormat` 공유, format | 780,134 ~ 862,858 | 88 ~ 1,121 |
| `SimpleDateFormat` 공유, parse | 859,725 ~ 1,014,332 | 34,789 ~ 56,603 |
| `ThreadLocal<SimpleDateFormat>`, format | 0 | 0 |
| `DateTimeFormatter` 공유, format과 parse | 0 | 0 |

format은 절반 안팎이 틀렸는데 예외는 천 번에 한 번도 나지 않았습니다. parse에서는 `2030-04-30`이어야 할 값이 `0012-04-30`으로 읽힌 것도 있었습니다. 예외만 지켜봐서는 포매터를 공유한 실수를 찾지 못합니다. `SimpleDateFormat`의 Javadoc은 "Date formats are not synchronized"라며 스레드마다 따로 만들라고 권하고 `DateTimeFormatter`의 Javadoc에는 "This class is immutable and thread-safe"라고 적혀 있습니다. 알리바바가 공개한 Java 개발 수첩(阿里巴巴Java开发手册, 아래에서는 개발 수첩)도 `SimpleDateFormat`을 static으로 두지 말라는 것을 강제 조항으로 둡니다.

## 4. `java.time`은 순간과 달력의 시각과 시간대를 다른 타입에 담습니다

원문은 오픈소스 Joda가 JSR-310으로 제출되어 JDK에 들어갔다고 소개합니다. Joda-Time의 저자 Stephen Colebourne은 JSR-310을 "started from scratch, but with an API 'inspired by Joda-Time'"이라고 적었습니다. Joda-Time에서 영감을 받아 처음부터 다시 만든 API입니다.

`java.time`의 타입은 1장에서 나눈 순간과 달력의 시각을 따로 담습니다.

| 타입 | 담는 것 | 맞는 자리 |
|---|---|---|
| `Instant` | 순간 | 결제 승인, 로그, 만료 판정 |
| `LocalDate`, `LocalTime`, `LocalDateTime` | 달력의 날짜와 시각. 시간대가 없음 | 생일, 영업일, 매일 오전 9시 |
| `ZonedDateTime` | 달력의 시각과 시간대 규칙 | 사용자에게 보여 줄 시각, 미래의 약속 |
| `OffsetDateTime` | 달력의 시각과 UTC와의 차 | 오프셋이 붙은 문자열과 DB의 순간을 주고받을 때 |
| `Duration`, `Period` | 흐른 시간, 달력의 간격 | 타임아웃, 구독 기간 |

원문은 `LocalDateTime`에 시간대가 없어서 타임스탬프로 바꿀 수 없다고 적었습니다. 시간대를 건네서 바꾸는 방법은 5장에 있습니다.

### `LocalDate`, `LocalTime`, `LocalDateTime`은 달력과 시계의 글자입니다

세 타입은 ISO 8601 형식으로 찍힙니다. 날짜는 `yyyy-MM-dd`, 시각은 `HH:mm:ss`이고 둘 사이에 `T`가 들어갑니다. 만들 때는 `of`나 `parse`를 쓰고 더하고 뺄 때는 `plusXxx`와 `minusXxx`를 이어 부릅니다.

```java
LocalDateTime dt  = LocalDateTime.of(2024, 10, 10, 20, 30, 59);
LocalDateTime dt2 = dt.plusDays(5).minusHours(3);   // 2024-10-15T17:30:59
LocalDateTime dt3 = dt2.minusMonths(1);             // 2024-09-15T17:30:59
dt.withMonth(9);                                    // 2024-09-10T20:30:59
```

원문의 같은 예제에는 `dt3`를 찍는 줄의 주석이 `2019-09-30T17:30:59`로 남아 있는데 실제 출력은 위와 같습니다. 원문도 바로 윗줄의 주석에는 맞는 결과를 적어 두었습니다. 원문의 `LocalDateTime.of(2024, 10, 07, 8, 15, 0)`은 실행됩니다. 다만 `07`은 8진수 리터럴이어서 날짜를 `08`이나 `09`로 바꾸면 컴파일 오류가 나므로 숫자 앞의 0은 뺍니다.

월초나 다음 일요일 같은 날짜는 `TemporalAdjusters`로 구합니다. 2024년 10월 7일 월요일 20시 21분 59초를 넣은 결과입니다.

```java
LocalDateTime now = LocalDateTime.of(2024, 10, 7, 20, 21, 59);
now.toLocalDate().withDayOfMonth(1).atStartOfDay();                 // 2024-10-01T00:00
now.with(TemporalAdjusters.firstDayOfMonth());                      // 2024-10-01T20:21:59
now.with(TemporalAdjusters.lastDayOfMonth());                       // 2024-10-31T20:21:59
now.with(TemporalAdjusters.dayOfWeekInMonth(3, DayOfWeek.FRIDAY));  // 2024-10-18T20:21:59
now.with(TemporalAdjusters.previous(DayOfWeek.MONDAY));             // 2024-09-30T20:21:59
now.with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY));       // 2024-10-07T20:21:59
now.with(TemporalAdjusters.next(DayOfWeek.SUNDAY));                 // 2024-10-13T20:21:59
```

첫 줄은 원문에 `now.withDayOfMonth(1).atStartOfDay()`로 실려 있고 그대로는 컴파일되지 않습니다. `atStartOfDay()`는 `LocalDate`의 메서드여서 `toLocalDate()`를 먼저 불러야 합니다. `firstDayOfMonth()`는 날짜만 바꾸고 시각은 그대로 둡니다. 월요일에 `previous(MONDAY)`를 부르면 지난주 월요일이 나오므로 그날을 포함하려면 `previousOrSame`을 씁니다.

### 월말에서 달을 더하면 순서에 따라 답이 달라집니다

앞의 예제에서 `minusMonths(1)`은 15일에 불러서 날짜가 그대로였습니다. 월말에서는 그달에 없는 날짜가 나올 수 있습니다. `LocalDate`에 `plusMonths`, `minusMonths`, `plusYears`를 부른 결과입니다.

| 계산 | 결과 |
|---|---|
| 2024-01-31에 한 달 | 2024-02-29 |
| 그 결과에 다시 한 달 | 2024-03-29 |
| 2024-01-31에 두 달 | 2024-03-31 |
| 2024-01-31에 한 달을 더하고 한 달을 뺌 | 2024-01-29 |
| 2024-02-29에 한 해 | 2025-02-28 |
| `LocalDate.of(2025, 2, 29)` | `DateTimeException` |

`plusMonths`와 `plusYears`는 결과가 없는 날짜면 그달의 마지막 날로 맞춥니다. 그래서 매달 말일에 돌아오는 일정은 직전 결과에 한 달을 더해 가면 29일로 굳습니다. 시작일에 n달을 더하면 1월 31일, 2월 29일, 3월 31일로 나옵니다.

표 맨 아래 줄처럼 없는 2월 29일을 만들다 난 장애가 2012년 2월 29일의 Microsoft Azure 장애입니다. Microsoft의 사후 요약에 따르면 가상 머신 안의 에이전트가 인증서의 만료일을 현재 날짜의 연도에 1을 더해 만들었고 윤일에는 2013년 2월 29일이라는 없는 날짜가 나와 인증서 생성이 실패했습니다. 장애는 태평양 표준시로 2월 28일 오후 4시에 시작됐고 모든 서비스가 정상이라는 공지는 3월 1일 오전 2시 15분에 올라왔습니다. `plusYears(1)`은 28일로 맞춰 주지만 연, 월, 일을 따로 꺼내 연도만 올린 뒤 `LocalDate.of`에 넣으면 같은 예외가 납니다.

### `now()`가 돌려주는 날짜는 JVM의 시간대에 따라 달라집니다

여기까지는 날짜를 직접 적어 만들었습니다. 현재 날짜를 가져오는 `now()`는 JVM의 기본 시간대를 씁니다. 같은 순간 `2024-10-07T16:00:00Z`에 시간대만 바꿔 불렀습니다.

| 시간대 | `LocalDate.now` | `LocalDateTime.now` |
|---|---|---|
| UTC | 2024-10-07 | 2024-10-07T16:00 |
| Asia/Seoul | 2024-10-08 | 2024-10-08T01:00 |
| America/Los_Angeles | 2024-10-07 | 2024-10-07T09:00 |

한국 시간대의 장비에서 만든 코드를 UTC로 띄운 컨테이너에 올리면 한국의 자정부터 오전 9시까지는 인자 없는 `LocalDate.now()`가 어제 날짜를 돌려줍니다. `ZoneId`를 인자로 받는 `now`를 쓰면 어느 시간대의 오늘인지가 코드에 드러납니다. `Clock`(현재 시각을 돌려주는 시계 객체)을 받는 `now`를 쓰면 테스트에서 시각도 고정할 수 있습니다. 제가 만드는 이커머스 백엔드 BE-commerce에서는 시각이 판정에 들어가는 웹훅 서명 검증, 대기열, 정합성 검사가 `Clock`을 주입받습니다.

### `Duration`은 흐른 시간이고 `Period`는 달력의 간격입니다

`Duration`은 초와 나노초로 센 시간이고 `Period`는 연, 월, 일로 센 간격입니다. 둘 다 `between`으로 두 시점의 차를 구하고 ISO 8601 형식의 문자열을 읽어 만들 수 있습니다.

```java
Duration d = Duration.parse("P1DT1H10M10.5S");   // PT25H10M10.5S
d.toMinutes();                                   // 1510
Period p = Period.parse("P2Y3M5D");              // 2년 3개월 5일
p.getYears(); p.getMonths(); p.getDays();        // 2, 3, 5
```

두 날짜 사이의 날 수는 `ChronoUnit.DAYS.between`으로 셉니다. `Period.between(2024-01-31, 2024-03-01)`은 `P1M1D`이고 `getDays()`는 1입니다. `Period`는 달과 날을 따로 들고 있어서 `getDays()`가 돌려주는 것은 달을 떼고 남은 날입니다. 같은 두 날짜에 `ChronoUnit.DAYS.between`을 부르면 30이 나옵니다.

하루를 더하는 방법은 `plusDays(1)`과 `plus(Duration.ofDays(1))` 둘입니다. 다음 날 새벽에 서머타임이 시작되는 뉴욕의 2024년 3월 9일 정오에 두 방법으로 하루를 더했습니다.

| 더한 것 | 결과 |
|---|---|
| `plusDays(1)` | 2024-03-10T12:00-04:00 |
| `plus(Duration.ofDays(1))` | 2024-03-10T13:00-04:00 |

`Duration`의 하루는 언제나 24시간이고 `plusDays(1)`과 `Period`의 하루는 달력의 하루여서 더한 뒤의 시각을 되도록 같게 맞춥니다. 내일 같은 시각에 알림을 보내려면 달력의 하루를 더하고 24시간 뒤에 만료시키려면 `Duration`을 더합니다. 시간대가 없는 `LocalDateTime` 두 개의 차도 서머타임을 건너면 실제로 흐른 시간과 달라집니다. 서머타임이 시작된 3월 10일의 0시와 6시의 차는 `LocalDateTime`으로 6시간, 뉴욕의 `ZonedDateTime`으로 5시간이 나옵니다.

### `ZonedDateTime`은 없는 시각과 두 번 오는 시각을 예외 없이 받습니다

원문의 정의대로 `ZonedDateTime`은 `LocalDateTime`에 `ZoneId`를 더한 것입니다. 원문의 시간대 변환 예제를 서울 기준으로 실행했습니다.

```java
ZonedDateTime seoul = ZonedDateTime.of(2024, 10, 10, 8, 15, 0, 0, ZoneId.of("Asia/Seoul"));
seoul.withZoneSameInstant(ZoneId.of("America/New_York"));   // 2024-10-09T19:15-04:00[America/New_York]
seoul.withZoneSameLocal(ZoneId.of("America/New_York"));     // 2024-10-10T08:15-04:00[America/New_York]
```

`withZoneSameInstant`는 순간을 지키고 글자를 바꾸며 `withZoneSameLocal`은 그 반대입니다.

시간대 규칙이 붙으면 달력에 없는 시각과 두 번 오는 시각이 생깁니다. 서머타임이 시작할 때 시계를 한 시간 앞으로 돌리면 그 한 시간은 건너뛰고 끝날 때 뒤로 돌리면 같은 한 시간이 두 번 지나갑니다. 한국 시간대에도 이런 시각이 있습니다. JDK 21에 든 `Asia/Seoul` 규칙에는 오프셋이 바뀐 때가 28번 있고 가장 최근의 것이 1987년과 1988년의 서머타임입니다. 생년월일처럼 과거의 날짜와 시각을 다루면 이 구간을 지나게 됩니다. 1988년의 두 시각을 `atZone`에 넣었습니다.

![1988년 5월 8일에는 02시부터 03시가 없고 10월 9일에는 02시부터 03시가 두 번 지나가는 서울의 시계 그림](/uploads/theory/java-time-five-decisions/gap-overlap.svg)

| 입력 | `atZone(Asia/Seoul)`의 결과 |
|---|---|
| 1988-05-08T02:30 (없는 시각) | 1988-05-08T03:30+10:00 |
| 1988-10-09T02:30 (두 번 오는 시각) | 1988-10-09T02:30+10:00 |
| 위 결과에 `withLaterOffsetAtOverlap()` | 1988-10-09T02:30+09:00. 앞의 결과보다 1시간 뒤의 순간 |

두 경우 모두 예외가 나지 않습니다. `ZonedDateTime` Javadoc에 따르면 없는 시각은 빈 구간의 길이만큼 늦추고 두 번 오는 시각은 이른 오프셋을 고릅니다. 입력을 거절하고 싶으면 `ZoneRules.getValidOffsets`가 돌려주는 오프셋의 개수(0, 1, 2)를 보거나 `ZonedDateTime.ofStrict`를 씁니다. 뉴욕의 없는 시각 `2024-03-10T02:30`으로 실행해 보니 `ofStrict`는 `DateTimeException`을 던졌습니다.

### 시간대 규칙이 바뀌면 같은 달력의 시각이 다른 순간이 됩니다

시간대 규칙은 앞으로도 바뀝니다. JDK마다 들어 있는 시간대 자료(tzdata)의 판이 달라서 맥 한 대에 깔린 JDK 두 개에 같은 달력의 시각을 넣자 다른 순간이 나왔습니다.

| JDK | tzdata | `2024-06-01T12:00 Asia/Almaty` | `2025-07-01T12:00 America/Asuncion` |
|---|---|---|---|
| 17.0.7 | 2022g | +06:00, `06:00Z` | -04:00, `16:00Z` |
| 21.0.9 | 2025b | +05:00, `07:00Z` | -03:00, `15:00Z` |

가까운 곳에서도 바뀌었습니다. JDK 21에서 `Asia/Pyongyang`의 오프셋은 2015년 8월 14일에 +09:00, 2016년 1월 1일에 +08:30, 2018년 6월 1일에 다시 +09:00이었습니다.

그래서 사람이 정한 미래의 약속은 달력의 시각과 지역 ID로 저장합니다. Jon Skeet은 2019년에 쓴 글에서 2022년 7월 10일 오전 9시에 암스테르담에서 열릴 회의를 예로 들었습니다. 등록할 때의 규칙으로 UTC 시각을 계산해 저장해 두었는데 그 뒤 네덜란드가 서머타임을 없앤다고 가정하면 저장된 순간은 회의 시작과 한 시간 어긋납니다. Skeet은 규칙의 변경을 늘 있는 일로 다루라고 적었습니다.

> The larger point is that time zone rules change, and that applications should expect that they will change. This isn't a corner case, it's the normal way things work.

Skeet은 사람이 말한 달력의 시각과 지역 ID를 그대로 보존하고 UTC 순간은 다시 계산할 수 있는 파생 데이터로 두라고 합니다. 이미 일어난 일은 규칙이 바뀌어도 달라지지 않으므로 `Instant` 하나로 충분합니다.

### `ZoneId`는 지역 ID와 오프셋을 받습니다

`ZoneId`는 옛 API의 `TimeZone`에 해당합니다. 원문의 형식 표를 한국 기준으로 바꿔 실행했습니다.

| 입력 | 결과 |
|---|---|
| `ZoneId.of("Z")` | Z. UTC이고 한국보다 9시간 느림 |
| `ZoneId.of("+9")` | +09:00 |
| `ZoneId.of("UTC+9")` | UTC+09:00 |
| `ZoneId.of("GMT+9")` | GMT+09:00 |
| `ZoneId.of("Asia/Seoul")` | Asia/Seoul |
| `ZoneId.of("Asia/seoul")` | `ZoneRulesException` |

지역 ID는 대소문자를 가립니다. 원문의 예제 `ZoneId.of("Asia/shanghai")`도 소문자 s 때문에 같은 예외가 납니다. 쓸 수 있는 ID 전체는 `ZoneId.getAvailableZoneIds()`가 돌려줍니다.

`+09:00`과 `Asia/Seoul`은 지금은 같은 시각을 가리키지만 담는 것이 다릅니다. 오프셋은 9시간이라는 차만 담고 지역 ID는 그 지역의 규칙 전체를 담습니다. 위의 1988년 예제는 `Asia/Seoul`이어서 `+10:00`이 나왔고 `+09:00`을 넣으면 언제나 9시간으로 계산됩니다. 과거나 미래의 달력의 시각을 다룰 때는 지역 ID를 씁니다.

### `Instant`는 순간이고 걸린 시간은 `System.nanoTime()`으로 잽니다

`Instant`는 1970년 1월 1일 0시(UTC)부터의 초와 1초에 못 미치는 나노초를 함께 담습니다.

```java
Instant i = Instant.parse("2024-10-07T11:21:59.123456789Z");
i.getEpochSecond();   // 1728300119
i.getNano();          // 123456789
i.toEpochMilli();     // 1728300119123
```

원문은 `Date` 대신 `Instant`를 쓰라고 권합니다. `Date`가 담던 것도 순간이므로 두 타입은 같은 것을 담습니다. 개발 수첩도 JDK 8 이상이면 `Date`는 `Instant`로, `Calendar`는 `LocalDateTime`으로 바꿔 쓸 수 있다고 나눠 적었습니다.

원문은 `Instant`를 코드 실행 시간을 기록하는 용도로도 소개하고 `Instant.now()`를 코드 앞뒤에서 불러 그 차를 구하는 예제를 실었습니다. Javadoc이 이 용도로 지정한 것은 `System.nanoTime()`입니다.

> This method can only be used to measure elapsed time and is not related to any other notion of system or wall-clock time.

`Instant.now()`는 운영체제의 시계가 가리키는 현재 시각을 읽습니다. 이 글에서는 이 시계를 벽시계라고 부릅니다. 시각 동기화가 벽시계를 고치면 시각이 거꾸로 갈 수 있고 `Instant`의 Javadoc에도 구현이 거꾸로 가지 않는 시계(단조 시계)를 제공할 의무는 없다고 적혀 있습니다.

`System.nanoTime()`, `System.currentTimeMillis()`, `Instant.now()` 세 시계가 얼마나 잘게 바뀌고 한 번 부르는 데 얼마나 걸리는지 macOS의 JDK 21에서 쟀습니다. 최소 간격은 연달아 부른 결과들 사이의 가장 작은 양의 차이고 호출 시간은 JMH로 쟀습니다. JMH는 측정용 JVM을 따로 띄워 반복 실행하는 벤치마크 도구입니다.

| 시계 | 결과가 바뀌는 최소 간격 | 호출 한 번의 시간 |
|---|---|---|
| `System.nanoTime()` | 41ns | 14.5ns |
| `System.currentTimeMillis()` | 단위가 1ms | 19.8ns |
| `Instant.now()` | 1,000ns | 31.0ns |

`Instant`는 나노초 자리까지 담을 수 있는 타입이지만 이 환경에서 `Instant.now()`는 1마이크로초 단위로만 바뀌었습니다. 연달아 200만 번 불렀을 때 직전과 같은 결과가 JDK 17에서 177만 번, JDK 21에서 193만 번, JDK 25에서 183만 번이었습니다. 한 번 바뀌기 전에 끝나는 코드의 앞뒤에서 부르면 차가 0으로 나옵니다.

벽시계의 차가 음수가 된 사고가 2017년 1월 1일의 Cloudflare 장애입니다. 윤초가 들어간 자정에 DNS 서버 안에서 두 시각의 차가 음수가 됐고 그 수가 난수 함수에 들어가 패닉(Go 프로그램의 실행을 멈추는 오류)이 났습니다. Cloudflare는 최대 약 0.2%의 DNS 질의가 영향을 받았고 HTTP 요청의 1% 미만이 오류를 냈으며 영향이 06:45 UTC에 끝났다고 밝혔습니다. 거꾸로 갈 수 있는 시계를 쓸 때는 두 시각의 차가 음수인지 늘 확인하라는 예방책도 적었습니다.

> One precaution when using a non-monotonic clock source is to always check whether the difference between two timestamps is negative.

언제 일어났는지를 남길 때는 `Instant`를 쓰고 얼마나 걸렸는지와 타임아웃이 지났는지는 `nanoTime()`의 차로 봅니다.

### `DateTimeFormatter`는 로캘과 패턴 문자에 따라 다른 글자를 찍습니다

`DateTimeFormatter`는 패턴 문자열과 로캘을 받습니다. 원문은 중국 로캘로 찍었고 여기서는 한국 로캘로 찍었습니다.

```java
ZonedDateTime zdt = ZonedDateTime.of(2024, 10, 8, 0, 25, 0, 0, ZoneId.of("Asia/Seoul"));
DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm ZZZZ").format(zdt);                    // 2024-10-08T00:25 GMT+09:00
DateTimeFormatter.ofPattern("yyyy MMM dd EE HH:mm", Locale.KOREA).format(zdt);         // 2024 10월 08 화 00:25
DateTimeFormatter.ofPattern("E, MMMM/dd/yyyy HH:mm", Locale.US).format(zdt);           // Tue, October/08/2024 00:25
DateTimeFormatter.ofPattern("yyyy년 M월 d일 (E) a h:mm", Locale.KOREA).format(zdt);     // 2024년 10월 8일 (화) 오전 12:25
DateTimeFormatter.ofPattern("zzz / zzzz", Locale.KOREA).format(zdt);                   // KST / 대한민국 표준시
```

원문은 둘째 줄을 `Locale.CHINA`로 찍으면서 출력 주석에 미국 형식을 두 번 적었습니다. 중국 로캘의 실제 출력은 `2024 10月 08 周二 00:25`입니다. 넷째 줄처럼 12시간제 `h`를 쓰면 자정 0시 25분은 오전 12:25로 찍힙니다. 마지막 줄의 `zzz`는 `KST`를 찍습니다. 찍을 때는 나오는 이름이지만 3장에서 본 대로 `ZoneId.of`에 ID로 넣을 수는 없습니다.

패턴 문자는 대소문자 하나로 다른 것을 찍습니다. 같은 날짜를 `yyyy`와 `YYYY`로 찍었고 `YYYY`는 로캘을 바꿔 가며 찍었습니다.

| 날짜 | `yyyy-MM-dd` | `YYYY-MM-dd` 한국 로캘 | `YYYY-MM-dd` 미국 로캘 | `YYYY-MM-dd` 영국 로캘 |
|---|---|---|---|---|
| 2024-12-28 (토) | 2024-12-28 | 2024-12-28 | 2024-12-28 | 2024-12-28 |
| 2024-12-29 (일) | 2024-12-29 | 2025-12-29 | 2025-12-29 | 2024-12-29 |
| 2024-12-30 (월) | 2024-12-30 | 2025-12-30 | 2025-12-30 | 2025-12-30 |
| 2027-01-01 (금) | 2027-01-01 | 2027-01-01 | 2027-01-01 | 2026-01-01 |

`Y`는 그 날짜가 든 주가 속한 해입니다. 한 주가 무슨 요일에 시작하고 첫 주를 어떻게 정하는지는 로캘마다 달라서 같은 날짜가 로캘에 따라 다음 해로도 지난해로도 찍힙니다. 한국 로캘은 한 주가 일요일에 시작해서 2024년 12월 29일 일요일부터 2025년으로 찍혔습니다. 개발 수첩은 `yyyy`와 `YYYY`의 구분을 강제 조항으로 두고 `YYYY/MM/dd`로 포맷한 탓에 2017년 12월 31일이 2018/12/31로 나와 서비스 장애가 났다는 사례를 실었습니다.

영국 정부의 결제 서비스 GOV.UK Pay도 `YYYY`로 같은 일을 겪었습니다. 2020년 12월 29일에 새로 만든 API 키의 생성일이 2021년으로 표시됐고 이 오류는 그날 테스트 하나가 실패하면서 드러났습니다. `YYYY` 실수는 연말과 연초 며칠에만 나타나므로 테스트 날짜에 그 며칠을 넣거나 정적 분석으로 잡습니다. Google의 Error Prone에는 `ww` 없이 `YYYY`를 쓴 패턴을 오류로 잡는 `MisusedWeekYear` 검사가 있습니다.

`h`, `D`, `m`도 한 글자 차이로 다른 것을 찍습니다. `h`는 12시간제의 시, `D`는 그해의 몇 번째 날, `m`은 분입니다. 24시간제의 시 `H`, 그달의 날 `d`, 달 `M`과 대소문자만 다릅니다.

| 패턴 | 입력 | 출력 |
|---|---|---|
| `hh:mm` | 13:05 | 01:05 |
| `yyyy-MM-DD` | 2024-02-01 | 2024-02-32 |
| `yyyy-mm-dd` | 2024-02-01 09:41 | 2024-41-01 |

읽을 때는 없는 날짜가 예외 없이 다른 날짜로 바뀌기도 합니다. 없는 날짜가 섞인 문자열을 포매터와 해석 방식(`ResolverStyle`)을 바꿔 가며 읽었습니다.

| 호출 | 결과 |
|---|---|
| `LocalDate.parse("2024-02-30", ofPattern("yyyy-MM-dd"))` | 2024-02-29 |
| `LocalDate.parse("2023-02-31", ofPattern("yyyy-MM-dd"))` | 2023-02-28 |
| `LocalDate.parse("2024-02-32", ofPattern("yyyy-MM-dd"))` | 예외 |
| `LocalDate.parse("2024-02-30")` | 예외 |
| `yyyy-MM-dd`에 `ResolverStyle.STRICT`, 입력 `2024-02-29` | 예외 |
| `uuuu-MM-dd`에 `ResolverStyle.STRICT`, 입력 `2024-02-30` | 예외 |
| `uuuu-MM-dd`에 `ResolverStyle.STRICT`, 입력 `2024-02-29` | 2024-02-29 |
| `new SimpleDateFormat("yyyy-MM-dd")`로 `2024-13-45` | 2025-02-14 |

`ofPattern`으로 만든 포매터는 해석 방식이 SMART이고 이 방식은 날짜가 그달의 마지막 날을 넘으면 마지막 날로 맞춥니다. 31을 넘으면 SMART에서도 예외입니다. 사용자가 넣은 2월 30일을 거절하려면 달력에 없는 날짜를 받지 않는 STRICT로 바꿉니다. STRICT에서 `yyyy`는 연호(기원전과 기원후)가 함께 있어야 하는 해여서 멀쩡한 2월 29일도 실패하므로 STRICT에는 `uuuu`를 씁니다. 패턴 없이 부른 `LocalDate.parse`는 2월 30일을 예외로 거절했고 옛 API의 `SimpleDateFormat`은 13월 45일을 2025년 2월 14일로 받았습니다.

원문의 `DateUtils`는 `ofPattern`을 호출마다 부릅니다. 포매터를 상수로 둘 때와 호출마다 만들 때의 속도를 JMH로 쟀습니다. `LocalDateTime`을 `yyyy-MM-dd HH:mm:ss`로 찍는 format 한 번에 걸리는 시간이고 ± 뒤는 99.9% 신뢰 구간입니다.

| 방식 | format 한 번의 시간 |
|---|---|
| `DateTimeFormatter`를 상수로 두고 씀 | 96.9 ± 1.5ns |
| `DateTimeFormatter.ofPattern`을 호출마다 부름 | 258.1 ± 11.3ns |
| `ThreadLocal<SimpleDateFormat>` | 302.3 ± 20.2ns |
| `new SimpleDateFormat`을 호출마다 만듦 | 839.8 ± 40.7ns |

`ofPattern`을 호출마다 부르면 상수로 둘 때의 2.7배가 걸리고 차이는 호출당 160ns쯤입니다. 가장 느린 `new SimpleDateFormat`도 호출 한 번에 840ns입니다. 초당 만 번을 불러도 차이는 1초에 1.6ms이므로 포매터의 종류는 3장의 틀린 결과 수를 기준으로 고르고 고른 포매터는 상수로 둡니다.

## 5. 옛 타입과 새 타입을 오갈 때는 시간대를 직접 적습니다

원문은 `LocalDateTime`과 `Date`를 오가는 코드를 `ZoneId.systemDefault()`로 적었습니다. 줄이면 아래와 같습니다.

```java
// LocalDateTime → Date
Date date = Date.from(localDateTime.atZone(ZoneId.systemDefault()).toInstant());
// Date → LocalDateTime
LocalDateTime ldt = date.toInstant().atZone(ZoneId.systemDefault()).toLocalDateTime();
```

`Date`는 순간이고 `LocalDateTime`은 달력의 시각이어서 둘 사이에는 시간대가 필요합니다. `systemDefault()`는 JVM의 시간대를 가져오므로 같은 코드가 서버의 시간대에 따라 다른 결과를 냅니다. 같은 변환을 서울로 띄운 JVM과 UTC로 띄운 JVM에서 실행했습니다.

| 변환 | 서울 JVM | UTC JVM |
|---|---|---|
| `Date`(1728300119000) → `LocalDateTime`, `systemDefault()` | 2024-10-07T20:21:59 | 2024-10-07T11:21:59 |
| 같은 변환, `ZoneId.of("Asia/Seoul")` | 2024-10-07T20:21:59 | 2024-10-07T20:21:59 |
| `LocalDateTime`(2024-10-07T20:21:59) → `Date`, `systemDefault()` | 1728300119000 | 1728332519000 |
| 같은 변환, `ZoneId.of("Asia/Seoul")` | 1728300119000 | 1728300119000 |

셋째 줄의 UTC JVM 결과는 9시간 뒤의 순간입니다. 한국 시각으로 다루는 데이터라면 `ZoneId.of("Asia/Seoul")`을 코드에 적어 두어야 서버를 UTC로 옮겨도 결과가 같습니다.

순간끼리의 변환에는 시간대가 필요 없습니다. `Date.toInstant()`와 `Date.from(instant)`, `Timestamp.toInstant()`가 그렇습니다. `Calendar`와 `TimeZone`은 `GregorianCalendar.toZonedDateTime()`과 `TimeZone.toZoneId()`로 새 타입이 됩니다.

## 6. DB에 저장한 순간이 같은 순간으로 읽히는지는 컬럼 타입과 연결 설정에 달려 있습니다

원문은 MyBatis 매핑에서 Java 타입을 `java.util.Date`에서 `java.time.LocalDateTime`으로 바꾸는 한 줄을 보여 줍니다.

```xml
<arg column="gmt_create" jdbcType="TIMESTAMP" javaType="java.time.LocalDateTime"/>
```

컬럼 이름 `gmt_create`는 개발 수첩의 옛 판이 모든 테이블에 두라고 한 이름이고 지금 판은 `create_time`으로 바꿨습니다. 원문은 MyBatis 3.5.0부터 `java.time` 타입 핸들러가 기본으로 들어 있다고 적었는데 MyBatis 문서의 문장은 "Since version 3.4.5, MyBatis supports JSR-310 (Date and Time API) by default"입니다. 그보다 옛 판에는 원문이 적은 대로 `mybatis-typehandlers-jsr310` 의존성을 더합니다.

5장에서 본 대로 `Date`는 순간을 담고 `LocalDateTime`은 달력의 시각을 담습니다. 컬럼에 든 것이 순간이라면 Java 타입을 바꾼 뒤에 같은 순간으로 읽히는지는 컬럼 타입과 연결 설정이 정합니다.

순간 하나(`2024-10-07T16:00:00Z`)를 서울 시간대로 띄운 JVM으로 쓰고 UTC로 띄운 JVM으로 읽었습니다. 앱 서버를 한국 시간대의 장비에서 UTC 컨테이너로 옮기는 상황을 흉내 낸 것입니다. MySQL과 PostgreSQL 서버 두 대의 시간대는 UTC입니다.

![연결 설정이 없을 때는 서울 시각의 글자가 저장되어 UTC JVM이 9시간 늦은 순간으로 읽고 connectionTimeZone을 UTC로 주면 같은 순간으로 읽히는 과정](/uploads/theory/java-time-five-decisions/store-shift.svg)

| DB와 컬럼 | 연결 설정 | 서버에 남은 글자 | UTC JVM이 읽은 순간 |
|---|---|---|---|
| MySQL `DATETIME` | 없음 | 2024-10-08 01:00:00 | 2024-10-08T01:00Z |
| MySQL `TIMESTAMP` | 없음 | 2024-10-08 01:00:00 | 2024-10-08T01:00Z |
| MySQL `DATETIME` | `connectionTimeZone=UTC` | 2024-10-07 16:00:00 | 2024-10-07T16:00Z |
| MySQL `TIMESTAMP` | `connectionTimeZone=UTC` | 2024-10-07 16:00:00 | 2024-10-07T16:00Z |
| PostgreSQL `timestamp` | 없음 | 2024-10-08 01:00:00 | 2024-10-08T01:00Z |
| PostgreSQL `timestamptz` | 없음 | 2024-10-07 16:00:00+00 | 2024-10-07T16:00Z |

순간은 `Timestamp`, `OffsetDateTime`, `Instant` 세 타입으로 넣었고 MySQL에서는 셋의 결과가 같았습니다. PostgreSQL 드라이버는 `Instant`를 받지 않아 예외를 냈습니다.

### MySQL은 `TIMESTAMP` 컬럼도 연결 설정이 없으면 어긋납니다

MySQL 문서에 따르면 `TIMESTAMP`는 넣을 때 UTC로 바꾸고 꺼낼 때 되돌리며 `DATETIME`은 바꾸지 않습니다.

> MySQL converts TIMESTAMP values from the current time zone to UTC for storage, and back from UTC to the current time zone for retrieval. (This does not occur for other types such as DATETIME.)

여기서 current time zone은 서버 세션의 시간대입니다. MySQL의 JDBC 드라이버인 Connector/J의 문서에 따르면 `connectionTimeZone`의 기본 설정은 `LOCAL`이고 이때 드라이버는 연결의 시간대가 JVM의 시간대와 같다고 가정합니다. 그래서 서울 JVM은 서울 시각의 글자 `01:00:00`을 보내고 UTC 세션인 서버는 그 글자를 UTC로 받습니다. 서버에서 `UNIX_TIMESTAMP`로 확인한 `TIMESTAMP` 컬럼의 순간은 실제보다 9시간 뒤였습니다. 쓴 JVM으로 다시 읽으면 같은 가정이 거꾸로 적용되어 맞는 순간이 나오므로 이 어긋남은 앱 서버의 시간대를 바꾸기 전에는 드러나지 않습니다.

`connectionTimeZone=UTC`를 주면 드라이버가 순간을 UTC 시각의 글자로 바꿔 보냅니다. Connector/J 8.0.23부터 `serverTimezone`은 이 속성의 별칭입니다.

`TIMESTAMP`를 시간대를 기록하는 타입으로 권한 곳도 있습니다. 개발 수첩은 생성 시각과 수정 시각의 컬럼을 `datetime`으로 두고 시간대 정보를 기록하려면 `timestamp`로 두라고 권합니다. MySQL 문서의 설명대로라면 `TIMESTAMP`에 남는 것은 세션 시간대로 받아 UTC로 바꿔 둔 순간이고 시간대 정보는 남지 않습니다.

### MySQL에서 `LocalDateTime`으로 넣은 시각은 실행한 세 연결 설정 모두에서 글자 그대로 남았습니다

MySQL에 `LocalDateTime`을 넣으면 드라이버가 변환하지 않습니다. 서울 시각 `2024-10-08T01:00`은 실행한 세 가지 연결 설정 모두에서 그 글자로 저장됐고 어느 JVM에서나 같은 `LocalDateTime`으로 읽혔습니다. 달력의 시각을 저장하려던 것이면 맞는 동작이고 순간을 저장하려던 것이면 시간대가 사라진 데이터입니다. 원문처럼 `Date`를 `LocalDateTime`으로 바꿀 때는 그 컬럼이 어느 시간대의 시각인지를 정해서 적어 둬야 합니다.

### PostgreSQL은 `timestamptz`가 순간이고 `timestamp`가 달력의 시각입니다

PostgreSQL의 JDBC 드라이버(pgjdbc)는 세션의 시간대를 JVM의 시간대로 맞춥니다. 그래서 `timestamptz`에는 `LocalDateTime`, `Timestamp`, `OffsetDateTime` 어느 것으로 넣어도 맞는 순간이 저장됐고 UTC JVM에서 `OffsetDateTime`으로 읽으면 같은 순간이 나왔습니다. `timestamp`에는 쓴 쪽 시간대의 시각 글자가 남았습니다. PostgreSQL 위키의 "Don't Do This"는 `timestamp`를 달력과 시계를 찍은 사진에 견줍니다.

> You can think of it being a picture of a calendar and a clock rather than a point in time.

드라이버 문서에는 `ZonedDateTime`과 `Instant`를 지원하지 않는다고 적혀 있습니다. 순간은 `OffsetDateTime`으로 바꿔서 넣고 읽습니다.

### BE-commerce는 `Instant`, `DATETIME(6)`, UTC 설정 셋을 묶어 씁니다

BE-commerce는 MySQL 8.4를 씁니다. 2026년 10월 7일 커밋 기준으로 운영 코드에서 `Instant`를 쓰는 파일이 136개이고 `LocalDateTime`을 쓰는 파일은 2개입니다. 스키마 파일에는 `DATETIME(6)`이 89번 나오고 `TIMESTAMP`는 없습니다. 연결 주소에는 `serverTimezone=UTC`, Hibernate에는 `hibernate.jdbc.time_zone: UTC`를 줘서 컬럼에 UTC 시각의 글자가 남게 했습니다. 6장 첫 표의 셋째 줄(`DATETIME` 컬럼, 연결 설정 `connectionTimeZone=UTC`)에 해당하는 구성입니다.

이 구성에서 한 번 걸린 곳이 드라이버가 돌려주는 타입입니다. 이번 실행에서 `getObject`의 결과는 `DATETIME`이 `LocalDateTime`, `TIMESTAMP`가 `java.sql.Timestamp`였고 `getObject(컬럼, Instant.class)`는 두 컬럼 모두 예외를 던졌습니다. BE-commerce에는 아직 발행하지 못한 이벤트 가운데 가장 오래된 것이 만들어진 뒤 흐른 시간을 내보내는 지표가 있고 이 지표는 `DATETIME` 컬럼의 최솟값을 `Instant.class`로 읽었습니다. 밀린 이벤트가 없으면 최솟값이 `NULL`이라 변환이 일어나지 않아 조회가 성공했고 밀린 이벤트가 있을 때만 변환 예외가 났습니다. 지표는 그때 NaN이 됐고 NaN은 어떤 임계와 비교해도 참이 되지 않으므로 적체 알림이 울리지 않았습니다. `LocalDateTime`으로 읽어 UTC로 해석하게 고쳤고 경위는 [이슈 #393](https://github.com/dj258255/BE-commerce/issues/393)에 있습니다.

## 7. 시간 도구 클래스는 시계와 시간대와 공휴일 목록을 인자로 받습니다

원문은 `java.util.Date` 위에 만든 도구로 앤트 파이낸셜의 `DateUtil`과 Apache Commons Lang의 `org.apache.commons.lang3.time`을 들고 `java.time` 위에 만든 공개 도구는 찾지 못했다고 적었습니다. 공개된 것으로는 ThreeTen-Extra와 Hutool의 `LocalDateTimeUtil`(소스의 `@since` 표기로 5.3.9부터)이 있습니다.

원문은 이어서 `java.time`으로 만든 `DateUtils`를 예로 싣습니다. `LocalDate`를 받아 형식을 바꾸고 날을 더하고 월초와 분기 말을 구하는 메서드 모음입니다. 방향은 그대로 따르면 되고 그 가운데 여섯 곳은 같은 식을 옮겨 실행해 보고 고쳤습니다.

| 원문의 메서드 | 실행한 결과 | 바꾼 것 |
|---|---|---|
| `getCurrentDate()`처럼 인자 없는 `now()`를 부르는 메서드(`now()` 호출 열 번) | UTC JVM에서는 한국과 다른 날짜(4장의 `now()` 표) | `Clock`과 `ZoneId`를 받음 |
| `parseLocalDate(dateStr, pattern)` | `2024-02-30`을 2월 29일로 받아들임 | `uuuu` 패턴과 STRICT |
| `formatLocalDate(date, pattern)` | 호출마다 `ofPattern`을 부름(4장의 속도 표) | 포매터를 상수로 둠 |
| `isDateInRange(date, startDate, endDate)` | 시작일이나 끝일을 넣으면 false | 양 끝을 포함하고 이름에 드러냄 |
| `getNextWorkingDay(date)` | 2025-10-02를 넣으면 공휴일인 10-03 | 공휴일 목록을 받음 |
| `getFirstDayOfWeek(date)` | 월요일 시작이어서 일요일인 2024-10-06을 넣으면 9월 30일 | 일요일 시작이 필요하면 `WeekFields`를 씀 |

`isDateInRange`는 `isAfter(startDate) && isBefore(endDate)`로 계산해서 양 끝이 빠집니다. 10월 1일부터 31일까지의 기간에 10월 1일을 넣으면 false입니다. 양 끝을 넣을지는 쓰는 쪽이 정하면 되고 어느 쪽인지를 이름과 주석에 적어 둡니다.

### 만 나이는 `Period.between`의 연 수로 구합니다

원문의 `getAge(birthDate)`는 안에서 `LocalDate.now()`를 불러 `Period.between(birthDate, 오늘).getYears()`를 돌려줍니다. 한국에서는 만 나이로 통일하는 민법과 행정기본법 개정이 2023년 6월 28일에 시행됐고 생일이 지났는지를 반영하는 이 계산이 만 나이 계산입니다. 생일과 기준일을 바꿔 가며 계산한 결과입니다.

| 생일 | 기준일 | `Period.between(생일, 기준일).getYears()` |
|---|---|---|
| 1990-10-08 | 2024-10-07 | 33 |
| 1990-10-08 | 2024-10-08 | 34 |
| 2000-02-29 | 2023-02-28 | 22 |
| 2000-02-29 | 2023-03-01 | 23 |
| 2000-02-29 | 2024-02-29 | 24 |

올해에서 태어난 해를 빼는 계산(`2024 - 1990`)은 생일이 지나지 않은 10월 7일에도 34가 나옵니다. 2월 29일에 태어난 사람은 평년에 3월 1일부터 한 살이 올라갑니다. 이것은 `Period`의 계산 결과이고 법령이 윤일 생일을 어떻게 세는지는 이 글에서 확인하지 않았습니다. 기준일인 오늘도 시간대에 따라 달라지므로 기준일은 인자로 받습니다.

### 다음 영업일은 공휴일 목록이 있어야 맞습니다

원문의 `getNextWorkingDay`는 토요일과 일요일만 건너뜁니다. 한국의 공휴일에는 음력으로 정해지는 설과 추석, 공휴일이 주말과 겹칠 때 생기는 대체공휴일, 그해에 정해지는 임시공휴일이 있습니다. JDK가 제공하는 달력 체계를 `Chronology.getAvailableChronologies()`로 뽑으면 ISO, Hijrah-umalqura, Japanese, Minguo, ThaiBuddhist 다섯이고 한국에서 쓰는 음력은 없어서 공휴일은 날짜 목록으로 받습니다.

2025년 10월 2일 목요일의 다음 영업일을 두 방법으로 구했습니다. 그해 10월은 3일 개천절부터 9일 한글날까지 이레가 이어지는 연휴였고 추석 연휴 첫날인 5일이 일요일이었습니다. 토요일인 4일을 빼면 공휴일은 3일, 5일부터 7일, 대체공휴일인 8일, 9일입니다.

| 계산 | 2025-10-02의 다음 영업일 |
|---|---|
| 주말만 건너뜀(원문) | 2025-10-03(금). 개천절 |
| 주말과 공휴일 목록을 건너뜀 | 2025-10-10(금) |

공휴일 목록은 공공데이터포털의 한국천문연구원 특일 정보 API로 받을 수 있습니다. 국경일, 공휴일, 기념일, 24절기를 날짜별로 돌려주고 공공기관 휴일 여부가 함께 옵니다. 임시공휴일은 그해에 정해지므로 목록은 배포 없이 고칠 수 있는 설정이나 DB에 둡니다.

### 한 주의 첫날은 로캘에 따라 달라지고 한국 로캘은 일요일입니다

원문의 `getFirstDayOfWeek`는 주석에 월요일이라고 밝히고 `date.with(DayOfWeek.MONDAY)`를 돌려줍니다. `DayOfWeek`는 월요일에 시작해 일요일에 끝나는 ISO 기준이어서 일요일을 넣으면 엿새 전 월요일이 나옵니다. 로캘이 정한 한 주는 `WeekFields`에 들어 있고 한국 로캘의 첫 요일은 일요일입니다. 두 기준으로 그 주의 첫날과 끝날을 구했습니다.

| 날짜 | ISO 기준(월요일 시작) | 한국 로캘 기준(일요일 시작) |
|---|---|---|
| 2024-10-06(일) | 09-30 ~ 10-06 | 10-06 ~ 10-12 |
| 2024-10-09(수) | 10-07 ~ 10-13 | 10-06 ~ 10-12 |

한국 로캘 기준의 첫날과 끝날은 `WeekFields`로 구했습니다.

```java
WeekFields week = WeekFields.of(Locale.KOREA);   // 첫 요일 SUNDAY
date.with(week.dayOfWeek(), 1);                  // 그 주의 일요일
date.with(week.dayOfWeek(), 7);                  // 그 주의 토요일
```

로캘의 첫 요일은 JDK에 든 로캘 자료를 따릅니다. `WeekFields.of(Locale.CHINA)`의 첫 요일은 JDK 17.0.7에서 일요일이었고 JDK 21.0.9와 25.0.1에서 월요일이었습니다. 주간 집계의 시작 요일은 업무 규칙으로 정하고 원문처럼 코드에 요일을 직접 적어 둡니다.

### 바꾼 것 다섯과 만 나이를 모으면 메서드 여섯 개짜리 클래스가 됩니다

7장 첫 표에서 바꾼 여섯 가운데 한 주의 첫날을 뺀 다섯과 만 나이 계산을 넣은 작은 클래스입니다. 주석의 결과는 실행해서 확인했습니다.

```java
public final class TimeKit {
    public static final ZoneId SEOUL = ZoneId.of("Asia/Seoul");
    private static final DateTimeFormatter DATE =
            DateTimeFormatter.ofPattern("uuuu-MM-dd").withResolverStyle(ResolverStyle.STRICT);
    private static final DateTimeFormatter DATE_TIME = DateTimeFormatter.ofPattern("uuuu-MM-dd HH:mm:ss");

    private TimeKit() {}

    // 어느 시계의 어느 시간대 기준 오늘인지 호출하는 쪽이 정한다
    // 시계가 2024-10-07T16:00Z일 때 SEOUL은 2024-10-08, UTC는 2024-10-07
    public static LocalDate today(Clock clock, ZoneId zone) {
        return LocalDate.now(clock.withZone(zone));
    }

    // "2024-02-30"은 DateTimeParseException
    public static LocalDate parseDate(String text) {
        return LocalDate.parse(text, DATE);
    }

    // 2024-10-07T16:00Z는 "2024-10-08 01:00:00"
    public static String formatSeoul(Instant instant) {
        return DATE_TIME.format(instant.atZone(SEOUL));
    }

    // 만 나이
    public static int age(LocalDate birth, LocalDate today) {
        return Period.between(birth, today).getYears();
    }

    // 시작일과 끝일을 포함한다
    public static boolean isWithin(LocalDate date, LocalDate start, LocalDate end) {
        return !date.isBefore(start) && !date.isAfter(end);
    }

    // 주말과 넘겨받은 공휴일을 건너뛴다
    public static LocalDate nextBusinessDay(LocalDate date, Set<LocalDate> holidays) {
        LocalDate next = date.plusDays(1);
        while (next.getDayOfWeek() == DayOfWeek.SATURDAY
                || next.getDayOfWeek() == DayOfWeek.SUNDAY
                || holidays.contains(next)) {
            next = next.plusDays(1);
        }
        return next;
    }
}
```

## 원문의 예제 네 곳과 설명 네 곳은 실제와 달랐습니다

본문에서 고친 곳을 모았습니다. 원문의 코드를 붙여 넣어 JDK 21에서 실행한 결과입니다. 넷은 실제와 달랐고 하나는 실행은 되지만 날짜를 바꾸면 깨지는 코드였습니다.

| 원문 | 실행 결과 |
|---|---|
| `now.withDayOfMonth(1).atStartOfDay()` | 컴파일 오류. `atStartOfDay()`는 `LocalDate`의 메서드입니다 |
| `ZoneId.of("Asia/shanghai")` | `ZoneRulesException: Unknown time-zone ID` |
| `LocalDateTime.of(2024, 10, 07, 8, 15, 0)` | 실행됩니다. `07`이 8진수 리터럴이어서 `08`이나 `09`로 바꾸면 컴파일 오류가 납니다 |
| `dt3`를 찍는 줄의 주석 `2019-09-30T17:30:59` | 실제 출력은 `2024-09-15T17:30:59`. 윗줄의 주석에는 맞는 결과가 있습니다 |
| 포매터 예제의 출력 주석(미국 형식이 두 번) | 둘째 줄의 실제 출력은 `2024 10月 08 周二 00:25` |

설명 네 곳은 문서와 저자의 글로 확인했습니다.

| 원문의 서술 | 확인한 것 |
|---|---|
| Joda가 JSR-310으로 제출되어 JDK에 들어갔다 | 저자는 JSR-310을 Joda-Time에서 영감을 받아 처음부터 다시 만들었다고 적었습니다 |
| MyBatis 3.5.0부터 `java.time` 타입 핸들러가 기본으로 들어 있다 | MyBatis 문서에는 3.4.5부터라고 적혀 있습니다 |
| `java.time` 기반의 공개 도구를 찾지 못했다 | ThreeTen-Extra와 Hutool의 `LocalDateTimeUtil`이 있습니다 |
| `Instant` 두 개의 차로 코드 실행 시간을 잴 수 있다 | Javadoc이 걸린 시간을 재는 용도로 지정한 것은 `System.nanoTime()`입니다 |

## 실행한 조건과 한계

- JDK는 17.0.7(tzdata 2022g), 21.0.9(2025b), 25.0.1(2025b)이고 Apple Silicon 맥(12코어)의 macOS에서 실행했습니다. 기본 시간대는 Asia/Seoul, 기본 로캘은 ko_KR입니다. tzdata 비교, 포매터 공유, JMH, DB 실험을 뺀 나머지는 세 JDK에서 돌렸습니다. JDK에 따라 달라진 것은 넷입니다. `Instant.now()`가 직전과 같았던 횟수, 예외 메시지의 필드 순서, `WeekFields.of(Locale.CHINA)`의 첫 요일, JDK 25의 세 글자 ID 경고입니다. 포매터 공유, JMH, DB 실험은 JDK 21에서만 돌렸습니다.
- 서울 시간대와 한국어 로캘로 바꾼 예제, 시간대 이름, 변환, 만 나이, 영업일, 한 주의 첫날은 기본 시간대를 서울과 UTC로 바꿔 가며 돌렸습니다.
- 2025년 10월의 공휴일은 우주항공청의 2025년도 월력요항을 다룬 보도에서 가져왔습니다. 보도에 있는 것은 3일부터 9일까지 이레 연휴라는 것과 추석 연휴 첫날인 5일이 일요일이라는 것이고 8일이 대체공휴일이라는 것은 거기서 계산했습니다. 특일 정보 API는 제공 항목을 문서로 확인했고 직접 호출하지는 않았습니다.
- 시계의 최소 간격은 이 맥에서 쟀습니다. 다른 운영체제에서는 다를 수 있습니다. 200만 번 가운데 시각이 거꾸로 간 적은 없었는데 이 결과로 알 수 있는 것은 측정하는 동안 시계 보정이 없었다는 데까지입니다.
- `SimpleDateFormat`의 틀린 결과 수는 실행마다 달라서 세 차례의 범위로 적었습니다. 이 글의 실험을 돌린 동안 같은 맥의 1분 부하 평균은 7.5~11.8이었고 이 실험만의 부하는 따로 남기지 않았습니다.
- JMH는 포크 3번에 측정 5회씩(회당 1초)이고 측정하는 동안 같은 맥에서 다른 작업이 돌고 있었습니다(1분 부하 평균 7.5~9.1). parse는 오차 구간이 넓어 결론에 쓰지 않았습니다.
- DB는 MySQL 8.4.11과 Connector/J 9.1.0, PostgreSQL 16.15와 pgjdbc 42.7.4이고 JDK 21.0.9에서 순수 JDBC로 실행했습니다. Hibernate나 MyBatis를 거칠 때 매핑 계층이 더하는 변환은 재지 않았습니다.
- 회사 사례의 수치는 각 회사가 공개한 글에서 가져왔습니다.

## 참고

따라간 글

- [Alibaba Cloud Community, How Can We Manipulate Time Gracefully in Java?](https://www.alibabacloud.com/blog/how-can-we-manipulate-time-gracefully-in-java_602187)
- [阿里云开发者社区, 如何才能在Java中优雅的操纵时间？](https://developer.aliyun.com/article/1637802)

규약과 사례

- [Alibaba, Java开发手册(黄山版)](https://github.com/alibaba/p3c)
- [Cloudflare, How and why the leap second affected Cloudflare DNS (2017)](https://blog.cloudflare.com/how-and-why-the-leap-second-affected-cloudflare-dns/)
- [Microsoft, Summary of Windows Azure Service Disruption on Feb 29th, 2012](https://azure.microsoft.com/en-us/blog/summary-of-windows-azure-service-disruption-on-feb-29th-2012/)
- [GOV.UK, How we fixed a strange 'week year' bug (2021)](https://technology.blog.gov.uk/2021/03/24/how-we-fixed-a-strange-week-year-bug/)
- [Google Error Prone, MisusedWeekYear](https://errorprone.info/bugpattern/MisusedWeekYear)
- [Jon Skeet, Storing UTC is not a silver bullet (2019)](https://codeblog.jonskeet.uk/2019/03/27/storing-utc-is-not-a-silver-bullet/)
- [Stephen Colebourne, Why JSR-310 isn't Joda-Time (2009)](https://blog.joda.org/2009/11/why-jsr-310-isn-joda-time_4941.html)

한국 기준으로 보탠 것

- [법무부, '만 나이' 통일을 위한 민법 및 행정기본법 개정안, 2023년 6월 28일부터 시행](https://moj.go.kr/bbs/moj/189/566088/artclView.do)
- [공공데이터포털, 한국천문연구원 특일 정보](https://www.data.go.kr/data/15012690/openapi.do)
- [YTN, 우주항공청 2025년도 월력요항 발표 (2024-06-20)](https://www.ytn.co.kr/_ln/0103_202406200817450769)

공식 문서

- [Java SE 21, TimeZone](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/TimeZone.html), [SimpleDateFormat](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/text/SimpleDateFormat.html), [WeekFields](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/time/temporal/WeekFields.html)
- [Java SE 21, System.nanoTime](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/System.html), [Instant](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/time/Instant.html), [Period](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/time/Period.html), [ZonedDateTime](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/time/ZonedDateTime.html)
- [Java SE 21, DateTimeFormatter](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/time/format/DateTimeFormatter.html), [IsoChronology](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/time/chrono/IsoChronology.html)
- [MySQL 8.4, The DATE, DATETIME, and TIMESTAMP Types](https://dev.mysql.com/doc/refman/8.4/en/datetime.html)
- [MySQL Connector/J, Preserving Time Instants](https://dev.mysql.com/doc/connector-j/en/connector-j-time-instants.html)
- [MySQL Connector/J, Datetime types processing](https://dev.mysql.com/doc/connector-j/en/connector-j-connp-props-datetime-types-processing.html)
- [PostgreSQL 16, Date/Time Types](https://www.postgresql.org/docs/16/datatype-datetime.html), [PostgreSQL Wiki, Don't Do This](https://wiki.postgresql.org/wiki/Don%27t_Do_This)
- [PostgreSQL JDBC, Using Java 8 Date and Time classes](https://jdbc.postgresql.org/documentation/query/)
- [MyBatis, Configuration: typeHandlers](https://mybatis.org/mybatis-3/configuration.html)
- [ThreeTen-Extra](https://www.threeten.org/threeten-extra/), [Hutool LocalDateTimeUtil](https://doc.hutool.cn/pages/LocalDateTimeUtil/)

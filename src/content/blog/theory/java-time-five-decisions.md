---
coverImage: /uploads/covers/ai-generated/theory/java-time-five-decisions.png
title: '자바에서 시간을 스마트하게 다루는 방법이란?'
description: '알리바바 클라우드 개발자 커뮤니티의 Java 시간 글 "如何才能在Java中优雅的操纵时间？"를 절 순서 그대로 따라가며 예제를 서울 시간대와 한국어 로캘로 바꿔 JDK 17, 21, 25에서 실행했습니다. 원문이 실행 결과나 문서와 다른 곳은 고쳐 적고 마지막 절에 원문의 메서드 40개짜리 도구 클래스를 한국 기준으로 다시 실었습니다.'
date: 2026-10-12
tags:
  - Java
  - java.time
  - Time Zone
  - Instant
  - LocalDateTime
  - DateTimeFormatter
  - SimpleDateFormat
  - MyBatis
category: theory/Systems
topics:
  - systems
draft: false
series: "자바 시간"
seriesOrder: 1
---

이 글은 알리바바 클라우드 개발자 커뮤니티의 "如何才能在Java中优雅的操纵时间？"를 절 순서 그대로 따라갑니다. 영어판의 제목은 "How Can We Manipulate Time Gracefully in Java?"이고 아래에서는 이 글을 원문이라고 부릅니다. 글쓴이 青栎은 프로젝트 코드에 `java.util.Date`와 `java.time.LocalDateTime`이 섞여 쓰이고 시간 도구 클래스도 여럿인 것을 보고 개념과 도구를 정리했다고 적었습니다. 원문은 컴퓨터가 시간을 저장하는 방식에서 시작해 `java.util`의 옛 API와 `java.time`의 새 API를 차례로 소개하고 둘 사이의 변환, DB 매핑, 시간 도구 클래스로 끝납니다. 문장은 옮겨 오지 않고 새로 썼습니다. 원문의 예제는 상하이 시간대와 중국어 로캘(언어와 지역 설정)로 쓰여 있어서 서울 시간대와 한국어 로캘로 바꿔 JDK 17, 21, 25에서 실행했습니다. 원문과 실제가 다른 곳은 그 자리에서 고쳐 적었고 영어판에만 있는 오류는 영어판의 것이라고 밝혔습니다.

원문은 결론부터 적었습니다.

- 날짜와 시간은 Java 8부터 들어온 `java.time`으로 다룹니다. 원문은 `java.util.Date`보다 안전하고 쓰기도 훨씬 편하다고 적었습니다.
- 널리 쓰이는 시간 도구 클래스는 대부분 `java.util.Date`를 기반으로 합니다. 프로젝트에 필요한 도구는 `java.time`을 기반으로 만듭니다. 원문은 글 끝에 구현 하나를 실었고 이 글도 마지막 절에 같은 클래스를 한국 기준으로 고쳐 실었습니다.

API로 코드를 짤 때 걸리는 곳(포매터 공유, 월말 더하기, 서머타임, 시계, 패턴 문자, DB 저장, 만 나이와 영업일)을 실행해서 확인한 결과는 다음 글 [자바에서 시간을 다룰 때 무엇을 정해야 할까?](/blog/theory/java-time-in-practice)에 따로 적었습니다.

## 컴퓨터에서 시간의 저장과 표시

컴퓨터가 저장하는 시간은 1970년 1월 1일 0시(UTC)부터 흐른 초를 센 정수입니다. 이 정수를 에포크 시간 또는 타임스탬프라고 부릅니다. Java에서는 보통 밀리초 단위의 `long`으로 다루고 `System.currentTimeMillis()`가 돌려줍니다. 이 정수는 세계 어디서나 같은 한 점을 가리킵니다. 이 글에서는 그 한 점을 순간이라고 부릅니다.

사람이 읽는 시각은 순간에 시간대를 적용한 결과입니다. 시간대는 UTC와의 차(오프셋)로 적습니다. `UTC+`나 `UTC-` 뒤에 시와 분을 붙이는 꼴이고 한국 표준시는 UTC보다 9시간 빠른 `UTC+09:00`입니다. 원문은 `GMT+08:00`과 `UTC+08:00`을 예로 듭니다. 정수 `1728300119000`은 서울에서 2024년 10월 7일 20시 21분 59초이고 UTC에서는 같은 날 11시 21분 59초입니다. 그래서 `2024-10-07 20:21:59`라는 글자만으로는 순간이 정해지지 않고 `+09:00`이나 `Asia/Seoul` 같은 시간대가 붙어야 정해집니다. 달력과 시계에 적힌 글자만 있는 시각은 이 글에서 달력의 시각이라고 부릅니다.

한국 표준시에는 지금 서머타임(여름에 시계를 한 시간 앞당기는 제도)이 없습니다. JDK 21의 `Asia/Seoul` 규칙에 2024년 10월 이후 오프셋이 다시 바뀌는 때를 물으면 없다는 답(`null`)이 돌아옵니다. 과거에는 오프셋이 여러 번 바뀌었습니다.

원문은 세계 표준시의 기준이 1972년에 GMT(그리니치 평균시)에서 UTC(협정 세계시)로 바뀌었다고 적습니다. 컴퓨터의 시계가 인터넷에 연결되면 시간 서버와 맞춰지므로 프로그램을 짤 때는 둘의 차이를 무시해도 된다고 설명합니다. 이 글도 둘을 구분하지 않습니다.

## 날짜 API

옛 API는 `java.util`의 `Date`, `Calendar`, `TimeZone`과 `java.text.SimpleDateFormat`입니다. 새 API는 JDK 8에 들어온 `java.time` 패키지입니다. 원문의 비교표를 항목별로 풀어 실행 결과와 Javadoc에 맞춰 다시 적었습니다.

| 항목 | `Date` | `Calendar` | `java.time` |
|---|---|---|---|
| 값을 바꿀 수 있는지 | 바꿀 수 있음(`setTime`) | 바꿀 수 있음(`set`, `add`) | 바꿀 수 없음. Javadoc이 스레드 안전하다고 적음 |
| 날짜 더하기와 빼기 | 없음 | `add` | `plus`, `minus`, `with` |
| 연도와 월 | 연도에 1900을 더하고 월은 0~11 | 연도는 그대로, 월은 0~11 | 연도와 월 모두 그대로 |
| 정밀도 | 밀리초 | 밀리초 | 나노초 |
| 기본 출력 | `Mon Oct 07 20:21:59 KST 2024` 꼴. 원문은 읽기 어렵다고 평가 | 원문은 읽기 어렵다고 평가 | `2024-10-07T20:21:59` 꼴 |
| 시간대 | 없음. 찍을 때 JVM의 시간대를 씀 | `TimeZone` | `ZoneId`, `ZoneOffset` |
| 포매터 | `SimpleDateFormat` | `SimpleDateFormat` | `DateTimeFormatter` |
| 포매터를 여러 스레드가 함께 써도 되는지 | 안 됨 | 안 됨 | 됨 |
| 포매터가 받는 타입 | `Date` | `getTime()`으로 꺼낸 `Date` | `LocalDateTime` 같은 `java.time`의 타입 |

원문의 표에는 `Date`의 출력 예가 `Tue Oct 08 00:11:16 CST 2024`로 실려 있습니다. 앞 절의 정수 `1728300119000`으로 만든 `Date`를 서울 시간대의 JVM에서 찍으면 `Mon Oct 07 20:21:59 KST 2024`처럼 `KST`가 붙고 UTC로 띄운 JVM에서 찍으면 `Mon Oct 07 11:21:59 UTC 2024`가 됩니다. `Date`에는 시간대가 없어서 찍을 때 JVM의 기본 시간대를 가져다 씁니다.

### java.util

JDK 8 전에는 `java.util`의 API로 시간을 다뤘습니다. 새 코드는 `java.time`으로 쓰더라도 이미 있는 코드와 라이브러리에는 이 API가 남아 있습니다. 원문은 연, 월, 일을 꺼낼 때 `Date`와 `Calendar`의 규칙이 서로 다르다는 것부터 짚습니다.

#### Date

`Date`가 담는 것은 밀리초 단위의 `long` 하나이고 `new Date()`는 `System.currentTimeMillis()`의 값을 넣습니다. 원문은 `Date`를 아래처럼 줄여 보여 줍니다.

```java
public class Date {
    long fastTime;

    public Date(long date) { fastTime = date; }

    public long getTime() { return fastTime; }
}
```

원문은 `Date`가 맡는 기능이 적다고 적고 연, 월, 일을 꺼낼 때 주의할 점을 듭니다. 세 메서드가 돌려주는 기준이 서로 다릅니다. 서울 시간대의 JVM에서 실행한 결과입니다.

```java
Date d = new Date(1728300119000L);   // 서울 2024-10-07 20:21:59, 월요일
d.getYear();    // 124. 1900을 더해야 2024
d.getMonth();   // 9. 1을 더해야 10월
d.getDate();    // 7. 1~31이 그대로 나옴
d.getDay();     // 1. 요일이고 0이 일요일
```

#### Calendar

`Calendar`는 연, 월, 일, 시, 분, 초를 필드로 꺼내고 넣을 수 있고 `Date`에 없는 날짜 더하기와 빼기가 있습니다. 연도는 그대로 나옵니다. 원문은 `Calendar`의 코드가 거칠고 API가 쓰기 불편하며 성능도 좋지 않다고 평가합니다. 성능은 이 글에서 재지 않았습니다. 아래는 서울 시간대로 필드를 꺼내고 날짜를 더하고 뺀 결과입니다.

```java
Calendar c = Calendar.getInstance(TimeZone.getTimeZone("Asia/Seoul"));
c.setTimeInMillis(1728300119000L);
c.get(Calendar.YEAR);          // 2024
c.get(Calendar.MONTH);         // 9. 10월
c.get(Calendar.DAY_OF_MONTH);  // 7
c.get(Calendar.DAY_OF_WEEK);   // 2. 1이 일요일이어서 월요일은 2
c.get(Calendar.HOUR_OF_DAY);   // 20
c.get(Calendar.MINUTE);        // 21
c.get(Calendar.SECOND);        // 59
c.get(Calendar.MILLISECOND);   // 0
c.getTime();                   // Date로 꺼냄. Mon Oct 07 20:21:59 KST 2024

c.clear();
c.set(2019, 10, 20, 8, 15, 0);            // 10은 11월
c.add(Calendar.DAY_OF_MONTH, 5);
c.add(Calendar.HOUR_OF_DAY, -2);          // 2019-11-25 06:15:00
```

요일을 세는 기준도 타입마다 다릅니다. `Date.getDay()`는 일요일이 0이고 `Calendar.DAY_OF_WEEK`는 일요일이 1입니다. `java.time`의 `DayOfWeek`는 월요일이 1이고 일요일이 7입니다.

#### TimeZone

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

시간대는 문자열 ID로 가리키고 `Asia/Seoul` 같은 지역 ID와 `GMT+09:00` 같은 오프셋 꼴을 둘 다 받습니다. 쓸 수 있는 ID 전체는 `TimeZone.getAvailableIDs()`가 돌려주고 JDK 21.0.9에서는 632개였습니다. 이름을 조금 틀리게 넣거나 KST 같은 약어를 넣으면 옛 API와 새 API가 다르게 반응합니다. 아래는 이름을 바꿔 가며 호출한 결과입니다.

| 호출 | 결과 |
|---|---|
| `TimeZone.getTimeZone("Asia/Seoul")` | Asia/Seoul |
| `TimeZone.getTimeZone("GMT+09:00")` | GMT+09:00. 원문이 든 오프셋 꼴의 ID |
| `TimeZone.getTimeZone("Asia/seoul")` | GMT |
| `TimeZone.getTimeZone("KST")` | GMT |
| `TimeZone.getTimeZone("JST")` | JST(+09:00). JDK 25는 세 글자 ID가 없어질 예정이라는 경고를 함께 찍음 |
| `ZoneId.of("Asia/seoul")` | `ZoneRulesException` |
| `ZoneId.of("KST")` | `ZoneRulesException` |

`TimeZone.getTimeZone`의 Javadoc에는 받은 ID를 이해하지 못하면 GMT를 돌려준다고 적혀 있습니다. 예외가 없으므로 `KST`를 넣은 코드는 한국 시각보다 9시간 느린 GMT 시각을 찍으면서 그대로 돌아갑니다. `Date`를 찍으면 `KST`라는 글자가 나오지만 이 글자는 ID로 받아 주지 않습니다. `ZoneId.of`에 함께 넘겨 쓰는 약어 표 `ZoneId.SHORT_IDS`에도 `JST`는 있고 `KST`는 없습니다.

#### java.text.SimpleDateFormat

`Date`를 문자열로 찍고 문자열을 `Date`로 읽는 일은 `SimpleDateFormat`이 합니다. 시간대를 정해 주지 않으면 JVM의 시간대로 읽고 찍습니다.

```java
SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss");
format.setTimeZone(TimeZone.getTimeZone("Asia/Seoul"));
Date date = format.parse("2024-10-07 16:10:22");   // getTime()은 1728285022000
String str = format.format(date);                  // 2024-10-07 16:10:22
```

원문은 `SimpleDateFormat`이 스레드 안전하지 않아서 쓸 때마다 새로 만들어야 하고 성능을 위해 `ThreadLocal`에 넣어 쓴다고 적었습니다.

```java
static final ThreadLocal<SimpleDateFormat> SIMPLE_DATE_FORMAT_LOCAL =
        ThreadLocal.withInitial(() -> new SimpleDateFormat("yyyy-MM-dd HH:mm:ss"));
```

포매터 하나를 여러 스레드가 함께 쓰면 어떻게 되는지는 [다음 글](/blog/theory/java-time-in-practice)에서 쟀습니다. 여덟 스레드가 함께 쓰자 format 160만 번 가운데 78만~86만 번이 틀린 결과였고 `DateTimeFormatter`는 0번이었습니다.

### java.time

원문은 오픈소스 날짜 라이브러리 Joda가 API가 명료하고 성능이 좋으며 JSR-310으로 제출되어 Java 8에서 JDK에 들어갔다고 소개합니다. Joda-Time의 저자 Stephen Colebourne은 JSR-310을 "started from scratch, but with an API 'inspired by Joda-Time'"이라고 적었습니다. JSR-310은 Joda-Time에서 영감을 받아 처음부터 다시 만든 API입니다.

`java.time`의 타입은 첫 절에서 나눈 순간과 달력의 시각을 따로 담습니다.

| 타입 | 담는 것 | 맞는 자리 |
|---|---|---|
| `Instant` | 순간 | 결제 승인, 로그, 만료 판정 |
| `LocalDate`, `LocalTime`, `LocalDateTime` | 달력의 날짜와 시각. 시간대가 없음 | 생일, 영업일, 매일 오전 9시 |
| `ZonedDateTime` | 달력의 시각과 시간대 규칙 | 사용자에게 보여 줄 시각, 미래의 약속 |
| `OffsetDateTime` | 달력의 시각과 UTC와의 차 | 오프셋이 붙은 문자열과 DB의 순간을 주고받을 때 |
| `Duration`, `Period` | 흐른 시간, 달력의 간격 | 타임아웃, 구독 기간 |

원문은 `LocalDateTime`에 시간대가 없어서 타임스탬프로 바꿀 수 없다고 적었습니다. 시간대를 건네서 바꾸는 방법은 아래 변환 절에 있습니다.

#### LocalDate, LocalTime, LocalDateTime

세 타입은 ISO 8601 형식으로 찍힙니다. 날짜는 `yyyy-MM-dd`, 시각은 `HH:mm:ss`이고 둘 사이에 `T`가 들어갑니다. 만들 때는 `of`나 `parse`를 쓰고 더하고 뺄 때는 `plusXxx`와 `minusXxx`를 이어 부릅니다. 한 필드만 바꿀 때는 `withXxx`를 쓰고 앞뒤 비교는 `isBefore`와 `isAfter`로 합니다.

```java
LocalDate date = LocalDate.of(2024, 10, 7);                    // 2024-10-07
LocalTime time = LocalTime.parse("08:15:07");                  // 08:15:07
LocalDateTime.parse("2024-10-07T08:15:07");                    // 2024-10-07T08:15:07

LocalDateTime dt  = LocalDateTime.of(2024, 10, 10, 20, 30, 59);
LocalDateTime dt2 = dt.plusDays(5).minusHours(3);   // 2024-10-15T17:30:59
LocalDateTime dt3 = dt2.minusMonths(1);             // 2024-09-15T17:30:59
dt.withMonth(9);                                    // 2024-09-10T20:30:59

date.isBefore(LocalDate.of(2024, 10, 8));           // true
date.isAfter(LocalDate.of(2024, 10, 8));            // false
date.isEqual(LocalDate.of(2024, 10, 7));            // true
```

원문의 같은 예제에는 `dt3`를 찍는 줄의 주석이 `2019-09-30T17:30:59`로 남아 있는데 실제 출력은 위와 같습니다. 바로 윗줄의 주석에는 맞는 결과가 적혀 있습니다. 원문에는 날짜를 `LocalDateTime.of(2024, 10, 07, 8, 15, 0)`처럼 0을 붙여 적은 줄도 있습니다. 이 줄은 실행되지만 `07`이 8진수 리터럴이어서 날짜를 `08`이나 `09`로 바꾸면 컴파일 오류가 납니다. 이 글의 예제에서는 숫자 앞의 0을 뺐습니다.

월초나 다음 일요일 같은 날짜는 `TemporalAdjusters`로 구합니다. 2024년 10월 7일 월요일 20시 21분 59초를 넣은 결과입니다.

```java
LocalDateTime now = LocalDateTime.of(2024, 10, 7, 20, 21, 59);
now.toLocalDate().withDayOfMonth(1).atStartOfDay();                 // 2024-10-01T00:00
now.with(TemporalAdjusters.firstDayOfMonth());                      // 2024-10-01T20:21:59
now.with(TemporalAdjusters.lastDayOfMonth());                       // 2024-10-31T20:21:59
now.with(TemporalAdjusters.firstDayOfNextMonth());                  // 2024-11-01T20:21:59
now.with(TemporalAdjusters.firstDayOfYear());                       // 2024-01-01T20:21:59
now.with(TemporalAdjusters.lastDayOfYear());                        // 2024-12-31T20:21:59
now.with(TemporalAdjusters.firstDayOfNextYear());                   // 2025-01-01T20:21:59
now.with(TemporalAdjusters.dayOfWeekInMonth(3, DayOfWeek.FRIDAY));  // 2024-10-18T20:21:59
now.with(TemporalAdjusters.previous(DayOfWeek.MONDAY));             // 2024-09-30T20:21:59
now.with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY));       // 2024-10-07T20:21:59
now.with(TemporalAdjusters.next(DayOfWeek.SUNDAY));                 // 2024-10-13T20:21:59
```

첫 줄은 원문에 `now.withDayOfMonth(1).atStartOfDay()`로 실려 있고 그대로는 컴파일되지 않습니다. `atStartOfDay()`는 `LocalDate`의 메서드여서 `toLocalDate()`를 먼저 불러야 합니다. `firstDayOfMonth()`는 날짜만 바꾸고 시각은 그대로 둡니다. 월요일에 `previous(MONDAY)`를 부르면 지난주 월요일이 나오므로 그날을 포함하려면 `previousOrSame`을 씁니다.

#### Duration과 Period

`Duration`은 초와 나노초로 센 시간이고 `Period`는 연, 월, 일로 센 간격입니다. 원문은 `Duration`이 짧은 시간을 높은 정밀도로 다룰 때 맞는다고 적었습니다. 둘 다 `between`으로 두 시점의 차를 구하고 ISO 8601 형식의 문자열을 읽어 만들 수 있습니다.

```java
Duration d = Duration.between(LocalDateTime.of(2024, 10, 7, 9, 0),
                              LocalDateTime.of(2024, 10, 8, 10, 30, 15));   // PT25H30M15S
d.getSeconds();                        // 91815
d.getNano();                           // 0
d.toDays(); d.toHours(); d.toMinutes(); // 1, 25, 1530
d.toMillis();                          // 91815000
d.plusHours(2).minusMinutes(30);       // PT27H15S
Duration.ofDays(1);                    // PT24H
Duration.ofHours(25);                  // PT25H
Duration.ofMinutes(90);                // PT1H30M
Duration.ofSeconds(3661);              // PT1H1M1S
Duration.ofMillis(1500);               // PT1.5S
Duration.ofNanos(1_500_000);           // PT0.0015S
Duration.parse("P1DT1H10M10.5S");      // PT25H10M10.5S

Period p = Period.between(LocalDate.of(2022, 7, 2), LocalDate.of(2024, 10, 7));   // P2Y3M5D
p.getYears(); p.getMonths(); p.getDays();   // 2, 3, 5. 셋 다 int
p.plusDays(30);                        // P2Y3M35D
p.minusMonths(4);                      // P2Y-1M5D
p.minusMonths(4).normalized();         // P1Y11M5D
Period.parse("P2Y3M5D");               // P2Y3M5D
```

`Duration`의 `toXxx`는 전체를 그 단위로 바꾼 수를 돌려줍니다. `Period`에 더하고 빼면 연, 월, 일을 따로 계산해서 35일이나 -1개월이 그대로 남습니다. `normalized()`를 부르면 연과 월만 정리되고 날은 손대지 않습니다.

두 날짜 사이의 날 수는 `ChronoUnit.DAYS.between`으로 셉니다. `Period.between(2024-01-31, 2024-03-01)`은 `P1M1D`이고 `getDays()`는 1입니다. `Period`는 달과 날을 따로 들고 있어서 `getDays()`가 돌려주는 것은 달을 떼고 남은 날입니다. 같은 두 날짜에 `ChronoUnit.DAYS.between`을 부르면 30이 나옵니다.

`Duration`으로 더한 24시간과 날짜를 하루 넘긴 결과는 서머타임이 시작하거나 끝나는 날에 한 시간 차이가 납니다.

#### ZonedDateTime

원문의 정의대로 `ZonedDateTime`은 `LocalDateTime`에 `ZoneId`를 더한 것입니다. 원문의 시간대 변환 예제를 서울 기준으로 실행했습니다.

```java
ZonedDateTime seoul = ZonedDateTime.of(2024, 10, 10, 8, 15, 0, 0, ZoneId.of("Asia/Seoul"));
seoul.withZoneSameInstant(ZoneId.of("America/New_York"));   // 2024-10-09T19:15-04:00[America/New_York]
seoul.withZoneSameLocal(ZoneId.of("America/New_York"));     // 2024-10-10T08:15-04:00[America/New_York]
```

`withZoneSameInstant`는 순간을 그대로 두고 달력의 시각을 뉴욕 기준으로 바꿉니다. `withZoneSameLocal`은 08:15라는 달력의 시각을 그대로 두고 시간대만 바꿔서 다른 순간이 됩니다.

원문이 꼽은 자주 쓰는 메서드는 `now()`, `now(ZoneId)`, 필드를 꺼내는 `getXxx`, 필드를 바꾸는 `withXxx`, 더하고 빼는 `plusXxx`와 `minusXxx`입니다.

```java
seoul.getYear(); seoul.getMonthValue(); seoul.getDayOfMonth(); seoul.getHour();   // 2024, 10, 10, 8
seoul.withHour(23);     // 2024-10-10T23:15+09:00[Asia/Seoul]
seoul.plusDays(30);     // 2024-11-09T08:15+09:00[Asia/Seoul]
seoul.minusHours(9);    // 2024-10-09T23:15+09:00[Asia/Seoul]
```

서울 시간대에도 1988년의 서머타임 때문에 달력에 없는 시각과 두 번 오는 시각이 있고 `ZonedDateTime`은 그런 시각을 넣어도 예외를 던지지 않습니다. 그런 시각을 넣었을 때 나오는 결과, 서머타임이 시작하거나 끝나는 날에 `Duration`의 24시간과 달력의 하루가 갈리는 결과, 시간대 규칙이 바뀌는 경우는 다음 글에 있습니다.

#### ZoneId

`ZoneId`는 옛 API의 `TimeZone`에 해당합니다. 추상 클래스이고 원문은 오프셋 꼴은 `ZoneOffset`이, 지역 ID는 `ZoneRegion`이 맡는다고 설명합니다. 아래 표에서 `UTC+9`처럼 앞에 이름이 붙은 오프셋은 `ZoneRegion`으로 나왔습니다. 현재 JVM의 시간대는 `ZoneId.systemDefault()`로, 특정 시간대는 `ZoneId.of`로 얻습니다. 원문은 지역 꼴의 예로 `Europe/Paris`를 듭니다. 원문의 형식 표를 한국 기준으로 바꿔 실행했습니다.

| 입력 | 결과 | 구현 클래스 |
|---|---|---|
| `ZoneId.of("Z")` | Z. UTC이고 한국보다 9시간 느림 | `ZoneOffset` |
| `ZoneId.of("UTC")`, `"GMT"`, `"UT"` | UTC, GMT, UT. 오프셋은 모두 0 | `ZoneRegion` |
| `ZoneId.of("+9")`, `"+09:00"`, `"+0900"`, `"+09:00:00"` | +09:00 | `ZoneOffset` |
| `ZoneId.of("-05:00")` | -05:00 | `ZoneOffset` |
| `ZoneId.of("UTC+9")` | UTC+09:00 | `ZoneRegion` |
| `ZoneId.of("UT+9")` | UT+09:00 | `ZoneRegion` |
| `ZoneId.of("GMT+9")` | GMT+09:00 | `ZoneRegion` |
| `ZoneId.of("Asia/Seoul")` | Asia/Seoul | `ZoneRegion` |
| `ZoneId.of("Etc/GMT-9")` | Etc/GMT-9. 오프셋은 +09:00 | `ZoneRegion` |
| `ZoneId.of("Etc/GMT+9")` | Etc/GMT+9. 오프셋은 -09:00 | `ZoneRegion` |
| `ZoneId.of("Asia/seoul")` | `ZoneRulesException` | |

원문의 표에는 지역 ID의 예로 `Etc/GMT+9`와 `Etc/GMT+8`이 실려 있습니다. `Etc/GMT` 계열은 부호가 반대여서 한국과 같은 오프셋은 `Etc/GMT-9`입니다.

지역 ID는 대소문자를 가립니다. 영어판의 표에는 예가 `ZoneId.of("Asia/shanghai")`로 적혀 있는데 소문자 s 때문에 표의 마지막 줄과 같은 `ZoneRulesException`이 납니다. 중국어 원판의 표에는 `Asia/Shanghai`로 맞게 적혀 있습니다. 쓸 수 있는 ID 전체는 `ZoneId.getAvailableZoneIds()`가 돌려주고 JDK 21.0.9에서는 604개였습니다.

`+09:00`과 `Asia/Seoul`은 지금은 같은 시각을 가리키지만 담는 것이 다릅니다. 오프셋은 9시간이라는 차만 담고 지역 ID는 그 지역의 규칙 전체를 담습니다. 서머타임을 쓰던 1988년 여름의 시각을 `Asia/Seoul`로 계산하면 `+10:00`이 나오고 `+09:00`을 넣으면 언제나 9시간으로 계산됩니다. 과거나 미래의 달력의 시각을 다룰 때는 지역 ID를 씁니다.

#### Instant

`Instant`는 1970년 1월 1일 0시(UTC)부터의 초와 1초에 못 미치는 나노초를 함께 담습니다.

```java
Instant i = Instant.parse("2024-10-07T11:21:59.123456789Z");
i.getEpochSecond();   // 1728300119
i.getNano();          // 123456789
i.toEpochMilli();     // 1728300119123
i.plusNanos(111);     // 2024-10-07T11:21:59.123456900Z
i.plusSeconds(60);    // 2024-10-07T11:22:59.123456789Z
```

원문은 `Date`가 밀리초까지만 담고 값을 바꿀 수 있는 객체인 데 비해 `Instant`는 나노초까지 담고 값을 바꿀 수 없는 객체라는 점을 들어 `Date` 대신 `Instant`를 쓰라고 권합니다. 쓰임으로는 코드 실행 시간의 기록과 사용자가 무언가를 조작한 시점의 기록을 듭니다. `Date`가 담던 것도 순간이므로 두 타입은 같은 것을 담습니다. 알리바바가 공개한 Java 개발 수첩(阿里巴巴Java开发手册, 아래에서는 개발 수첩)도 JDK 8 이상이면 `Date`는 `Instant`로, `Calendar`는 `LocalDateTime`으로 바꿔 쓸 수 있다고 나눠 적었습니다.

원문은 `Instant`를 코드 실행 시간을 기록하는 용도로도 소개하고 `Instant.now()`를 코드 앞뒤에서 불러 그 차를 구하는 예제를 실었습니다. 걸린 시간을 재는 메서드는 `System.nanoTime()`이고 그 Javadoc에는 이렇게 적혀 있습니다.

> This method can only be used to measure elapsed time and is not related to any other notion of system or wall-clock time.

걸린 시간을 재는 데만 쓸 수 있고 시스템의 현재 시각과는 관계가 없다는 문장입니다.

`Instant.now()`는 운영체제의 시계가 가리키는 현재 시각을 읽습니다. 시각 동기화가 이 시계를 고치면 시각이 거꾸로 갈 수 있습니다.

언제 일어났는지를 남길 때는 `Instant`를 쓰고 얼마나 걸렸는지와 타임아웃이 지났는지는 `nanoTime()`의 차로 봅니다. `System.nanoTime()`, `System.currentTimeMillis()`, `Instant.now()`가 바뀌는 최소 간격을 잰 결과와 두 시각의 차가 음수가 되어 난 장애는 [다음 글](/blog/theory/java-time-in-practice)에 있습니다.

#### DateTimeFormatter

`DateTimeFormatter`는 패턴 문자열과 로캘을 받습니다. 원문은 중국 로캘로 찍었고 여기서는 한국 로캘로 찍었습니다.

```java
ZonedDateTime zdt = ZonedDateTime.of(2024, 10, 8, 0, 25, 0, 0, ZoneId.of("Asia/Seoul"));
DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm ZZZZ").format(zdt);                    // 2024-10-08T00:25 GMT+09:00
DateTimeFormatter.ofPattern("yyyy MMM dd EE HH:mm", Locale.KOREA).format(zdt);         // 2024 10월 08 화 00:25
DateTimeFormatter.ofPattern("E, MMMM/dd/yyyy HH:mm", Locale.US).format(zdt);           // Tue, October/08/2024 00:25
DateTimeFormatter.ofPattern("yyyy년 M월 d일 (E) a h:mm", Locale.KOREA).format(zdt);     // 2024년 10월 8일 (화) 오전 12:25
DateTimeFormatter.ofPattern("zzz / zzzz", Locale.KOREA).format(zdt);                   // KST / 대한민국 표준시
```

원문은 둘째 줄을 `Locale.CHINA`로 찍었고 출력 주석은 `2024 十月 08 星期二 00:25`입니다. JDK 17, 21, 25에서 실행하면 `2024 10月 08 周二 00:25`가 나옵니다. JDK 17.0.7과 21.0.9에 옛 로캘 자료를 쓰는 옵션(`-Djava.locale.providers=COMPAT`)을 주자 원문의 주석과 같은 출력이 나왔고 25.0.1은 이 옵션을 받지 않았습니다. 영어판은 이 줄의 주석에 미국 형식을 두 번 적었습니다. 넷째 줄처럼 12시간제 `h`를 쓰면 자정 0시 25분은 오전 12:25로 찍힙니다. 마지막 줄의 `zzz`는 `KST`를 찍습니다. 찍을 때는 나오는 이름이지만 앞의 TimeZone 절에서 본 대로 `ZoneId.of`에 ID로 넣을 수는 없습니다. `yyyy`와 `YYYY`처럼 한 글자로 결과가 달라지는 패턴 문자, 그리고 2월 30일처럼 달력에 없는 날짜를 읽을 때의 동작은 다음 글에 있습니다.

### 변환

원문은 `LocalDateTime`과 `Date`를 오가는 코드를 `ZoneId.systemDefault()`로 적었습니다. 줄이면 아래와 같습니다.

```java
// LocalDateTime → Date
Date date = Date.from(localDateTime.atZone(ZoneId.systemDefault()).toInstant());
// Date → LocalDateTime
LocalDateTime ldt = date.toInstant().atZone(ZoneId.systemDefault()).toLocalDateTime();
```

원문이 적은 대로 `LocalDateTime`에는 시간대가 없고 `Date`는 밀리초 정밀도의 순간이어서 둘 사이를 오가려면 시간대를 건네야 합니다. `systemDefault()`는 JVM의 시간대를 가져오므로 같은 코드가 서버의 시간대에 따라 다른 결과를 냅니다. 같은 변환을 서울로 띄운 JVM과 UTC로 띄운 JVM에서 실행했습니다.

| 변환 | 서울 JVM | UTC JVM |
|---|---|---|
| `Date`(1728300119000) → `LocalDateTime`, `systemDefault()` | 2024-10-07T20:21:59 | 2024-10-07T11:21:59 |
| 같은 변환, `ZoneId.of("Asia/Seoul")` | 2024-10-07T20:21:59 | 2024-10-07T20:21:59 |
| `LocalDateTime`(2024-10-07T20:21:59) → `Date`, `systemDefault()` | 1728300119000 | 1728332519000 |
| 같은 변환, `ZoneId.of("Asia/Seoul")` | 1728300119000 | 1728300119000 |

셋째 줄의 UTC JVM 결과는 9시간 뒤의 순간입니다. 한국 시각으로 다루는 데이터라면 `ZoneId.of("Asia/Seoul")`을 코드에 적어 두어야 서버를 UTC로 옮겨도 결과가 같습니다.

순간끼리의 변환에는 시간대가 필요 없습니다. `Date.toInstant()`와 `Date.from(instant)`, `Timestamp.toInstant()`가 그렇습니다. `Calendar`와 `TimeZone`은 `GregorianCalendar.toZonedDateTime()`과 `TimeZone.toZoneId()`로 새 타입이 됩니다. 원문은 그 밖의 변환을 CSDN의 글 하나로 안내합니다. 그 링크는 참고에 옮겨 두었습니다.

#### DB 매핑의 변화

영어판은 MyBatis 매핑에서 Java 타입을 `java.util.Date`에서 `java.time.LocalDateTime`으로 바꾸는 것을 아래 두 줄로 보여 줍니다. 중국어 원판의 페이지에는 이 자리의 코드가 비어 있습니다.

```xml
<!-- 바꾸기 전 -->
<arg column="gmt_create" jdbcType="TIMESTAMP" javaType="java.util.Date"/>
<!-- 바꾼 뒤 -->
<arg column="gmt_create" jdbcType="TIMESTAMP" javaType="java.time.LocalDateTime"/>
```

컬럼 이름 `gmt_create`는 개발 수첩의 옛 판이 모든 테이블에 두라고 한 이름이고 지금 판은 `create_time`으로 바꿨습니다. 원문은 MyBatis 3.5.0부터 `java.time` 타입 핸들러가 기본으로 들어 있다고 적었는데 MyBatis 문서의 문장은 "Since version 3.4.5, MyBatis supports JSR-310 (Date and Time API) by default"입니다. 그보다 옛 판에는 원문이 적은 대로 아래 의존성을 더합니다.

```xml
<dependency>
    <groupId>org.mybatis</groupId>
    <artifactId>mybatis-typehandlers-jsr310</artifactId>
    <version>1.0.2</version>
</dependency>
```

컬럼에 든 것이 순간이라면 Java 타입을 `LocalDateTime`으로 바꾼 뒤에도 같은 순간으로 읽히는지는 컬럼 타입과 연결 설정(JDBC 연결 주소에 주는 `connectionTimeZone` 같은 시간대 옵션)에 달려 있습니다. 서울 시간대의 JVM이 연결 설정 없이 MySQL의 `DATETIME`과 `TIMESTAMP` 컬럼에 쓴 순간을 UTC로 띄운 JVM으로 읽자 둘 다 9시간 뒤의 순간이 나왔습니다. 컬럼 타입과 연결 설정을 바꿔 가며 실행한 결과는 다음 글에 있습니다.

#### MyBatis의 시간 관련 jdbcType, javaType, typeHandler 대응

원문은 시간 타입의 타입 핸들러, Java 타입, JDBC 타입이 어떻게 짝지어지는지를 표로 실었습니다. MyBatis 문서의 표와 대조했고 같은 내용입니다. 문서에는 여기에 `java.sql.Timestamp`, `java.sql.Date`, `java.sql.Time`의 핸들러 셋이 더 있습니다.

| 타입 핸들러 | Java 타입 | JDBC 타입 |
|---|---|---|
| `DateTypeHandler` | `java.util.Date` | TIMESTAMP |
| `DateOnlyTypeHandler` | `java.util.Date` | DATE |
| `TimeOnlyTypeHandler` | `java.util.Date` | TIME |
| `InstantTypeHandler` | `java.time.Instant` | TIMESTAMP |
| `LocalDateTimeTypeHandler` | `java.time.LocalDateTime` | TIMESTAMP |
| `LocalDateTypeHandler` | `java.time.LocalDate` | DATE |
| `LocalTimeTypeHandler` | `java.time.LocalTime` | TIME |
| `OffsetDateTimeTypeHandler` | `java.time.OffsetDateTime` | TIMESTAMP |
| `OffsetTimeTypeHandler` | `java.time.OffsetTime` | TIME |
| `ZonedDateTimeTypeHandler` | `java.time.ZonedDateTime` | TIMESTAMP |
| `YearTypeHandler` | `java.time.Year` | INTEGER |
| `MonthTypeHandler` | `java.time.Month` | INTEGER |
| `YearMonthTypeHandler` | `java.time.YearMonth` | VARCHAR 또는 LONGVARCHAR |
| `JapaneseDateTypeHandler` | `java.time.chrono.JapaneseDate` | DATE |

#### 시간을 다루는 도구

원문은 `java.util.Date`를 기반으로 한 도구로 앤트 파이낸셜의 `DateUtil`과 Apache Commons Lang의 `org.apache.commons.lang3.time`을 듭니다. 둘 다 날짜와 시간을 다루는 메서드를 폭넓게 제공한다고 소개하고 `java.time`을 기반으로 한 공개 도구는 아직 찾지 못했다고 적었습니다. 공개된 것으로는 ThreeTen-Extra와 Hutool의 `LocalDateTimeUtil`(소스의 `@since` 표기로 5.3.9부터)이 있습니다.

원문은 기존 도구가 요구에 맞지 않아 프로젝트 안에 직접 만들 때는 `java.time`을 기반으로 만들라고 권합니다. 끝에는 메서드 40개짜리 `DateUtils`를 예로 실었습니다. 이 글은 그 40개를 한국에서 쓸 때에 맞춰 고치고 `seoulClock`, `isWorkingDay`, `getWorkingDayCountOfMonth` 셋을 더했습니다. 원문과 달라진 곳은 여섯 가지입니다.

- **현재 날짜와 시각.** 인자 없는 `now()`를 `Clock`(현재 시각을 돌려주는 시계 객체)을 받는 `now(clock)`으로 바꿨습니다. 같은 순간 `2024-10-07T16:00:00Z`를 서울 시계와 UTC 시계에 넣으면 `getCurrentDate`가 각각 2024-10-08과 2024-10-07을 돌려줍니다. 서울 시각의 시계는 `seoulClock()`이 돌려줍니다.
- **기준일.** 원문의 `isBefore`, `isAfter`, `isBeforeOrEqual`, `isAfterOrEqual`, `getAge`도 안에서 `now()`를 부릅니다. 다섯 메서드 모두 기준일을 인자로 받게 했습니다. `getAge`의 결과는 만 나이입니다. 한국에서는 만 나이로 통일하는 민법과 행정기본법 개정이 2023년 6월 28일에 시행됐습니다.
- **형식.** `2024-02-30`을 넣으면 원문의 `parseLocalDate`는 2월 29일을 돌려주고 고친 판은 예외를 던집니다. 달력에 없는 날짜를 받지 않는 해석 방식(`ResolverStyle.STRICT`)을 썼고 이 방식에서는 `yyyy`가 연호를 함께 요구해 멀쩡한 날짜도 실패하므로 패턴을 `uuuu-MM-dd`로 적었습니다. `formatLocalDate`와 `parseLocalDate`가 받던 패턴 인자는 없애고 이 한 가지 형식으로 고정했으며 포매터는 상수로 두었습니다.
- **기간.** `isDateInRange`가 양 끝을 포함합니다. 원문은 시작일이나 끝일을 넣으면 false를 돌려줍니다.
- **한 주의 처음과 끝.** 한국 로캘의 한 주는 일요일에 시작합니다(`WeekFields.of(Locale.KOREA)`). 원문의 `getFirstDayOfWeek`는 월요일에 시작하는 주를 쓰고 고친 판은 `getFirstDayOfWeek`와 `getLastDayOfWeek`가 한 주가 시작하는 요일을 인자로 받습니다.
- **영업일.** 원문의 `getNextWorkingDay`는 토요일과 일요일만 건너뜁니다. `getNextWorkingDay`와 `getPreviousWorkingDay`가 공휴일 목록을 인자로 받게 하고 `isWorkingDay`와 `getWorkingDayCountOfMonth`를 더했습니다. 2025년 10월 2일의 다음 영업일은 원문의 계산으로는 개천절인 10월 3일이고 고친 판에 그해 10월의 공휴일 목록을 인자로 넘기면 10월 10일입니다. 공휴일 목록은 공공데이터포털의 한국천문연구원 특일 정보 API로 받을 수 있습니다.

위 여섯 가지를 뺀 나머지 메서드는 구현을 줄인 곳이 있어도 원문과 결과가 같습니다. 원문의 40개 가운데 `now()`를 쓰는 여덟을 뺀 32개를 2020년 1월 1일부터 2030년 12월 31일까지 모든 날짜에 호출해 96,985건을 비교했습니다. 한 주의 시작에는 월요일을, 영업일에는 빈 공휴일 목록을 넘겼고 `isDateInRange`의 기간은 2024년 10월 한 달로 두었습니다. 다른 결과는 `isDateInRange`의 양 끝 두 날짜뿐이었습니다. 2월 30일처럼 달력에 없는 날짜 74개는 원문이 모두 받아들였고 고친 판은 모두 예외를 던졌습니다. 만 나이, 영업일, 한 주의 첫날을 실행한 결과는 [다음 글](/blog/theory/java-time-in-practice)에 표로 실었습니다. 고친 `DateUtils` 전체는 아래와 같습니다.

```java
import java.time.*;
import java.time.format.DateTimeFormatter;
import java.time.format.ResolverStyle;
import java.time.temporal.ChronoUnit;
import java.time.temporal.TemporalAdjusters;
import java.util.Set;

public final class DateUtils {

    public static final ZoneId SEOUL = ZoneId.of("Asia/Seoul");

    // 포매터는 한 번 만들어 함께 쓴다. STRICT라서 2월 30일처럼 달력에 없는 날짜는 예외가 난다
    private static final DateTimeFormatter DATE =
            DateTimeFormatter.ofPattern("uuuu-MM-dd").withResolverStyle(ResolverStyle.STRICT);

    private DateUtils() {}

    // 서울 시각을 가리키는 시계. 테스트에서는 Clock.fixed(...)를 넘긴다
    public static Clock seoulClock() {
        return Clock.system(SEOUL);
    }

    // 현재 날짜. 어느 시간대의 오늘인지는 넘겨받은 시계가 정한다
    public static LocalDate getCurrentDate(Clock clock) {
        return LocalDate.now(clock);
    }

    // 현재 시각
    public static LocalTime getCurrentTime(Clock clock) {
        return LocalTime.now(clock);
    }

    // 현재 날짜와 시각
    public static LocalDateTime getCurrentDateTime(Clock clock) {
        return LocalDateTime.now(clock);
    }

    // 날짜를 2024-10-07 꼴의 문자열로
    public static String formatLocalDate(LocalDate date) {
        return DATE.format(date);
    }

    // 2024-10-07 꼴의 문자열을 날짜로. 달력에 없는 날짜는 DateTimeParseException
    public static LocalDate parseLocalDate(String dateStr) {
        return LocalDate.parse(dateStr, DATE);
    }

    // 날 더하기
    public static LocalDate addDays(LocalDate date, long days) {
        return date.plusDays(days);
    }

    // 날 빼기
    public static LocalDate minusDays(LocalDate date, long days) {
        return date.minusDays(days);
    }

    // 두 날짜 사이의 날 수
    public static long getDaysBetween(LocalDate startDate, LocalDate endDate) {
        return ChronoUnit.DAYS.between(startDate, endDate);
    }

    // 그달의 첫날
    public static LocalDate getFirstDayOfMonth(LocalDate date) {
        return date.withDayOfMonth(1);
    }

    // 그달의 마지막 날
    public static LocalDate getLastDayOfMonth(LocalDate date) {
        return date.withDayOfMonth(date.lengthOfMonth());
    }

    // 두 날짜가 같은지
    public static boolean isSameDate(LocalDate date1, LocalDate date2) {
        return date1.isEqual(date2);
    }

    // 날짜가 기간 안에 있는지. 시작일과 끝일을 포함한다
    public static boolean isDateInRange(LocalDate date, LocalDate startDate, LocalDate endDate) {
        return !date.isBefore(startDate) && !date.isAfter(endDate);
    }

    // 요일
    public static DayOfWeek getDayOfWeek(LocalDate date) {
        return date.getDayOfWeek();
    }

    // 윤년인지
    public static boolean isLeapYear(int year) {
        return Year.of(year).isLeap();
    }

    // 그달의 날 수
    public static int getDaysInMonth(int year, int month) {
        return YearMonth.of(year, month).lengthOfMonth();
    }

    // 연, 월, 일
    public static int getYear(LocalDate date) {
        return date.getYear();
    }

    public static int getMonth(LocalDate date) {
        return date.getMonthValue();
    }

    public static int getDayOfMonth(LocalDate date) {
        return date.getDayOfMonth();
    }

    // 시, 분, 초
    public static int getHour(LocalDateTime dateTime) {
        return dateTime.getHour();
    }

    public static int getMinute(LocalDateTime dateTime) {
        return dateTime.getMinute();
    }

    public static int getSecond(LocalDateTime dateTime) {
        return dateTime.getSecond();
    }

    // 기준일보다 앞인지, 뒤인지. 기준일은 getCurrentDate(clock)으로 얻어 넘긴다
    public static boolean isBefore(LocalDate date, LocalDate today) {
        return date.isBefore(today);
    }

    public static boolean isAfter(LocalDate date, LocalDate today) {
        return date.isAfter(today);
    }

    public static boolean isBeforeOrEqual(LocalDate date, LocalDate today) {
        return !date.isAfter(today);
    }

    public static boolean isAfterOrEqual(LocalDate date, LocalDate today) {
        return !date.isBefore(today);
    }

    // 만 나이
    public static int getAge(LocalDate birthDate, LocalDate today) {
        return Period.between(birthDate, today).getYears();
    }

    // 분기
    public static int getQuarter(LocalDate date) {
        return (date.getMonthValue() - 1) / 3 + 1;
    }

    // 토요일과 일요일이 아닌 날
    public static boolean isWeekday(LocalDate date) {
        return date.getDayOfWeek() != DayOfWeek.SATURDAY && date.getDayOfWeek() != DayOfWeek.SUNDAY;
    }

    // 토요일이나 일요일
    public static boolean isWeekend(LocalDate date) {
        return !isWeekday(date);
    }

    // 영업일. 주말과 넘겨받은 공휴일을 뺀다
    public static boolean isWorkingDay(LocalDate date, Set<LocalDate> holidays) {
        return isWeekday(date) && !holidays.contains(date);
    }

    // 다음 영업일
    public static LocalDate getNextWorkingDay(LocalDate date, Set<LocalDate> holidays) {
        do {
            date = date.plusDays(1);
        } while (!isWorkingDay(date, holidays));
        return date;
    }

    // 이전 영업일
    public static LocalDate getPreviousWorkingDay(LocalDate date, Set<LocalDate> holidays) {
        do {
            date = date.minusDays(1);
        } while (!isWorkingDay(date, holidays));
        return date;
    }

    // 그 주의 첫날. 한 주가 시작하는 요일을 넘긴다(달력 화면은 SUNDAY, ISO 기준은 MONDAY)
    public static LocalDate getFirstDayOfWeek(LocalDate date, DayOfWeek firstDayOfWeek) {
        return date.with(TemporalAdjusters.previousOrSame(firstDayOfWeek));
    }

    // 그 주의 마지막 날
    public static LocalDate getLastDayOfWeek(LocalDate date, DayOfWeek firstDayOfWeek) {
        return getFirstDayOfWeek(date, firstDayOfWeek).plusDays(6);
    }

    // 그해의 첫날과 마지막 날
    public static LocalDate getFirstDayOfYear(LocalDate date) {
        return date.withDayOfYear(1);
    }

    public static LocalDate getLastDayOfYear(LocalDate date) {
        return date.withDayOfYear(date.lengthOfYear());
    }

    // 그 분기의 첫날과 마지막 날
    public static LocalDate getFirstDayOfQuarter(LocalDate date) {
        int month = (date.getMonthValue() - 1) / 3 * 3 + 1;
        return LocalDate.of(date.getYear(), month, 1);
    }

    public static LocalDate getLastDayOfQuarter(LocalDate date) {
        return getFirstDayOfQuarter(date).plusMonths(2).with(TemporalAdjusters.lastDayOfMonth());
    }

    // 그달의 평일 수와 주말 수
    public static int getWeekdayCountOfMonth(LocalDate date) {
        return countDays(getFirstDayOfMonth(date), getLastDayOfMonth(date), Set.of(), true);
    }

    public static int getWeekendCountOfMonth(LocalDate date) {
        return date.lengthOfMonth() - getWeekdayCountOfMonth(date);
    }

    // 그해의 평일 수
    public static int getWeekdayCountOfYear(LocalDate date) {
        return countDays(getFirstDayOfYear(date), getLastDayOfYear(date), Set.of(), true);
    }

    // 그달의 영업일 수. 평일에서 공휴일을 뺀다
    public static int getWorkingDayCountOfMonth(LocalDate date, Set<LocalDate> holidays) {
        return countDays(getFirstDayOfMonth(date), getLastDayOfMonth(date), holidays, true);
    }

    private static int countDays(LocalDate first, LocalDate last, Set<LocalDate> holidays, boolean working) {
        int count = 0;
        for (LocalDate d = first; !d.isAfter(last); d = d.plusDays(1)) {
            if (isWorkingDay(d, holidays) == working) {
                count++;
            }
        }
        return count;
    }
}
```

## 원문에서 고쳐 읽을 곳

본문에서 짚은 곳과 예제를 실행하다 걸린 곳을 모았습니다. 원문의 코드를 붙여 넣어 JDK 21에서 컴파일하고 실행한 결과입니다. 마지막 줄만 영어판에 있고 나머지는 중국어 원판과 영어판에 모두 있습니다.

| 원문 | 실행 결과 |
|---|---|
| `now.withDayOfMonth(1).atStartOfDay()` | 컴파일 오류. `atStartOfDay()`는 `LocalDate`의 메서드입니다 |
| `dt3`를 찍는 줄의 주석 `2019-09-30T17:30:59` | 실제 출력은 `2024-09-15T17:30:59`. 윗줄의 주석에는 맞는 결과가 있습니다 |
| `Calendar` 예제의 주석 `2019-11-25 6:15:00` | 실제 출력은 `2019-11-25 06:15:00` |
| `Instant` 예제의 `system.out.println` | 소문자 s라 컴파일 오류 |
| 본문의 `getNanosecends()`, `getMonhs()` | 그런 메서드가 없습니다. `getNano()`와 `getMonths()`입니다 |
| 포매터 예제의 중국 로캘 출력 주석 `2024 十月 08 星期二 00:25` | JDK 17, 21, 25의 출력은 `2024 10月 08 周二 00:25`. 옛 로캘 자료 옵션을 주면 주석과 같습니다 |
| 영어판의 `ZoneId.of("Asia/shanghai")`와 포매터 주석의 미국 형식 두 번 | 앞의 것은 `ZoneRulesException`. 중국어 원판에는 둘 다 맞게 적혀 있습니다 |

`LocalDateTime.of(2024, 10, 07, 8, 15, 0)`은 실행은 되지만 `07`이 8진수 리터럴이어서 `08`이나 `09`로 바꾸면 컴파일 오류가 납니다.

설명 가운데 두 곳은 문서와 저자의 글에 적힌 것과 달랐습니다.

| 원문의 서술 | 확인한 것 |
|---|---|
| Joda가 JSR-310으로 제출되어 JDK에 들어갔다 | 저자는 JSR-310을 Joda-Time에서 영감을 받아 처음부터 다시 만들었다고 적었습니다 |
| MyBatis 3.5.0부터 `java.time` 타입 핸들러가 기본으로 들어 있다 | MyBatis 문서에는 3.4.5부터라고 적혀 있습니다 |

두 곳에는 내용을 보탰습니다. 원문은 `java.time` 기반의 공개 도구를 아직 찾지 못했다고 적었고 지금은 ThreeTen-Extra와 Hutool의 `LocalDateTimeUtil`이 있습니다. 원문은 `Instant`로 코드 실행 시간을 기록할 수 있다고 적었고 Javadoc이 걸린 시간을 재는 데 쓰라고 적은 메서드는 `System.nanoTime()`입니다.

## 실행한 조건과 한계

- JDK는 17.0.7, 21.0.9, 25.0.1이고 Apple Silicon 맥(12코어)의 macOS에서 실행했습니다. 기본 시간대는 Asia/Seoul, 기본 로캘은 ko_KR이고 `Date`를 찍은 예와 변환 절의 표는 기본 시간대를 UTC로도 바꿔 돌렸습니다.
- 코드 블록의 주석에 적은 결과는 모두 세 JDK에서 실행한 출력입니다. JDK에 따라 달라진 것은 쓸 수 있는 시간대 ID의 수(17.0.7은 631개와 603개, 21.0.9와 25.0.1은 632개와 604개), JDK 25가 세 글자 ID에 찍는 경고, 옛 로캘 자료 옵션을 받는지입니다.
- 원문의 `DateUtils`는 원문에서 복사한 코드를 고치지 않고 컴파일해 고친 판과 비교했습니다.
- 2025년 10월의 공휴일은 우주항공청의 2025년도 월력요항을 다룬 보도에서 가져왔습니다. 보도에는 3일부터 9일까지 이레 연휴이고 추석 연휴 첫날인 5일이 일요일이라고 나와 있습니다. 8일이 대체공휴일이 된다는 점은 이 둘에서 계산했습니다. 특일 정보 API는 제공 항목을 문서로 확인했고 직접 호출하지는 않았습니다.
- 2월 29일에 태어난 사람의 만 나이를 법령이 어떻게 세는지는 확인하지 못했습니다. `getAge`의 결과는 `Period`의 계산입니다.
- 원문이 변환 방법의 참고로 든 CSDN 글은 이 글을 쓰는 동안 열리지 않아 내용을 확인하지 못했습니다.

## 참고

따라간 글

- [阿里云开发者社区, 如何才能在Java中优雅的操纵时间？](https://developer.aliyun.com/article/1637802)
- [Alibaba Cloud Community, How Can We Manipulate Time Gracefully in Java?](https://www.alibabacloud.com/blog/how-can-we-manipulate-time-gracefully-in-java_602187)
- [원문이 변환 방법의 참고로 든 CSDN 글](https://blog.csdn.net/qq_31635851/article/details/120150588)

고쳐 적을 때 본 것

- [Alibaba, Java开发手册(黄山版)](https://github.com/alibaba/p3c)
- [Stephen Colebourne, Why JSR-310 isn't Joda-Time (2009)](https://blog.joda.org/2009/11/why-jsr-310-isn-joda-time_4941.html)
- [MyBatis, Configuration: typeHandlers](https://mybatis.org/mybatis-3/configuration.html)
- [ThreeTen-Extra](https://www.threeten.org/threeten-extra/), [Hutool LocalDateTimeUtil](https://doc.hutool.cn/pages/LocalDateTimeUtil/)
- [Java SE 21, TimeZone](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/TimeZone.html), [SimpleDateFormat](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/text/SimpleDateFormat.html), [System.nanoTime](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/System.html), [Instant](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/time/Instant.html), [DateTimeFormatter](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/time/format/DateTimeFormatter.html), [WeekFields](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/time/temporal/WeekFields.html)

한국 기준으로 고칠 때 본 것

- [법무부, '만 나이' 통일을 위한 민법 및 행정기본법 개정안, 2023년 6월 28일부터 시행](https://moj.go.kr/bbs/moj/189/566088/artclView.do)
- [공공데이터포털, 한국천문연구원 특일 정보](https://www.data.go.kr/data/15012690/openapi.do)
- [YTN, 우주항공청 2025년도 월력요항 발표 (2024-06-20)](https://www.ytn.co.kr/_ln/0103_202406200817450769)

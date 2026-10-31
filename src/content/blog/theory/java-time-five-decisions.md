---
coverImage: /uploads/covers/ai-generated/theory/java-time-five-decisions.png
title: '자바에서 시간을 스마트하게 다루는 방법이란?'
description: '알리바바 클라우드 개발자 커뮤니티의 Java 시간 글 "如何才能在Java中优雅的操纵时间？"를 절 순서 그대로 따라가며 예제를 서울 시간대와 한국어 로캘로 바꿔 JDK 17, 21, 25에서 실행했습니다. 원문이 실행 결과나 문서와 다른 곳은 고쳐 적었고 서머타임, 월말 더하기, 시계 눈금, 포맷 문자, MySQL과 PostgreSQL의 저장 결과를 실행해 절마다 보탰습니다. 마지막 절에는 원문의 메서드 40개짜리 도구 클래스를 한국 기준으로 다시 실었습니다.'
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
  - MySQL
  - PostgreSQL
  - JDBC
category: theory/Systems
topics:
  - systems
  - database
draft: false
unlisted: true
---

알리바바 클라우드 개발자 커뮤니티에 青栎이 쓴 "如何才能在Java中优雅的操纵时间？"(영어판 "How Can We Manipulate Time Gracefully in Java?")를 절 순서대로 따라가며 정리했습니다. 青栎은 프로젝트 코드에 `java.util.Date`와 `java.time.LocalDateTime`이 섞여 쓰이고 시간 도구 클래스도 여럿인 것을 보고 이 글을 썼습니다. 컴퓨터가 시간을 저장하는 방식에서 시작해 옛 API와 새 API를 차례로 보고 두 API 사이의 변환, DB 매핑, 시간 도구 클래스로 끝나는 구성입니다.

원문의 예제는 상하이 시간대와 중국어 로캘(언어와 지역 설정)로 되어 있어서 서울 시간대와 한국어 로캘로 바꿔 JDK 17, 21, 25에서 돌렸습니다. 돌려 보니 실제와 다른 곳이 있어서 그 자리에서 고쳤습니다. 영어판에만 있는 오류는 영어판의 것이라고 따로 적었습니다.

원문의 결론은 두 가지입니다.

- 날짜와 시간은 Java 8부터 들어온 `java.time`으로 다룹니다. `java.util.Date`보다 안전하고 쓰기도 훨씬 편합니다.
- 널리 쓰이는 시간 도구 클래스는 대부분 `java.util.Date` 기반입니다. 프로젝트에 필요한 도구는 `java.time` 기반으로 만듭니다. 원문은 끝에 구현 하나를 실었고 여기서는 마지막 절에 같은 클래스를 한국 기준으로 고쳐 실었습니다.

원문에는 없지만 직접 돌려 보고 확인한 것도 절마다 넣었습니다. 포매터를 여러 스레드가 함께 쓸 때, 월말에 달을 더할 때, 서머타임이 바뀌는 날, 시계의 눈금, 패턴 문자, DB에 저장할 때, 만 나이와 영업일을 셀 때입니다. 공개된 장애 사례도 같이 붙였습니다.

## 컴퓨터에서 시간의 저장과 표시

컴퓨터가 저장하는 시간은 1970년 1월 1일 0시(UTC)부터 흐른 초를 센 정수입니다. 이 정수를 에포크 시간 또는 타임스탬프라고 부릅니다. Java에서는 보통 밀리초 단위의 `long`으로 다루고 `System.currentTimeMillis()`가 돌려줍니다. 이 정수가 가리키는 것은 세계 어디서나 같은 한 점, 곧 순간입니다.

사람이 읽는 시각은 순간에 시간대를 적용한 결과입니다. 시간대는 UTC와의 차(오프셋)로 적습니다. `UTC+`나 `UTC-` 뒤에 시와 분을 붙이는 꼴이고 한국 표준시는 UTC보다 9시간 빠른 `UTC+09:00`입니다. 원문은 `GMT+08:00`과 `UTC+08:00`을 예로 듭니다. 정수 `1728300119000`은 서울에서 2024년 10월 7일 20시 21분 59초이고 UTC에서는 같은 날 11시 21분 59초입니다. 그래서 `2024-10-07 20:21:59`라는 글자만으로는 순간이 정해지지 않고 `+09:00`이나 `Asia/Seoul` 같은 시간대가 붙어야 정해집니다. `LocalDateTime`이 담는 것이 이런 글자, 곧 시간대 없는 달력의 시각입니다.

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

함께 쓰면 어떻게 되는지 재 봤습니다. 포매터 하나를 스레드 여덟이 함께 쓰며 스레드마다 20만 번, 모두 160만 번을 돌리고 미리 만들어 둔 정답과 비교했습니다. parse는 읽은 값을 다시 글자로 찍어 정답과 견줬습니다. 표의 값은 세 차례 실행의 범위입니다.

| 방식 | 틀린 결과 | 예외 |
|---|---|---|
| `SimpleDateFormat` 공유, format | 780,134 ~ 862,858 | 88 ~ 1,121 |
| `SimpleDateFormat` 공유, parse | 859,725 ~ 1,014,332 | 34,789 ~ 56,603 |
| `ThreadLocal<SimpleDateFormat>`, format | 0 | 0 |
| `DateTimeFormatter` 공유, format과 parse | 0 | 0 |

format은 절반 안팎이 틀렸는데 예외는 천 번에 한 번도 나지 않았습니다. parse에서는 `2030-04-30`이어야 할 값이 `0012-04-30`으로 읽힌 것도 있었습니다. 예외만 지켜봐서는 포매터를 공유한 실수를 찾지 못합니다. 표 아래쪽 두 줄이 0인 것은 Javadoc의 설명과 맞습니다. `SimpleDateFormat`의 Javadoc은 "Date formats are not synchronized"라며 스레드마다 따로 만들라고 권하고 `DateTimeFormatter`의 Javadoc에는 "This class is immutable and thread-safe"라고 적혀 있습니다. 알리바바가 공개한 Java 개발 수첩(阿里巴巴Java开发手册)도 `SimpleDateFormat`을 static으로 두지 말라는 것을 강제 조항으로 둡니다.

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

월말에서 달을 더하면 순서에 따라 답이 달라집니다. `LocalDate`에 `plusMonths`, `minusMonths`, `plusYears`를 불렀습니다.

| 계산 | 결과 |
|---|---|
| 2024-01-31에 한 달 | 2024-02-29 |
| 그 결과에 다시 한 달 | 2024-03-29 |
| 2024-01-31에 두 달 | 2024-03-31 |
| 2024-01-31에 한 달을 더하고 한 달을 뺌 | 2024-01-29 |
| 2024-02-29에 한 해 | 2025-02-28 |
| `LocalDate.of(2025, 2, 29)` | `DateTimeException` |

`plusMonths`와 `plusYears`는 결과가 없는 날짜면 그달의 마지막 날로 맞춥니다. 그래서 매달 말일에 돌아오는 일정은 직전 결과에 한 달을 더해 가면 29일로 굳습니다. 시작일에 n달을 더하면 31일, 29일, 31일로 나옵니다.

표 맨 아래 줄의 `LocalDate.of(2025, 2, 29)`는 2012년 2월 29일의 Microsoft Azure 장애와 같은 모양입니다. Microsoft의 사후 요약에 따르면 가상 머신 안의 에이전트가 인증서의 만료일을 현재 날짜의 연도에 1을 더해 만들었고 윤일에는 2013년 2월 29일이라는 없는 날짜가 나와 인증서 생성이 실패했습니다. 장애는 태평양 표준시로 2월 28일 오후 4시에 시작됐고 모든 서비스가 정상이라는 공지는 3월 1일 오전 2시 15분에 올라왔습니다. `plusYears(1)`은 28일로 맞춰 주지만 연·월·일을 따로 꺼내 연도만 올린 뒤 `LocalDate.of`에 넣으면 같은 예외가 납니다.

`now()`가 돌려주는 날짜는 JVM의 시간대에 따라 달라집니다. 같은 순간 `2024-10-07T16:00:00Z`에 시간대만 바꿔 `now`를 불렀습니다.

| 시간대 | `LocalDate.now` | `LocalDateTime.now` |
|---|---|---|
| UTC | 2024-10-07 | 2024-10-07T16:00 |
| Asia/Seoul | 2024-10-08 | 2024-10-08T01:00 |
| America/Los_Angeles | 2024-10-07 | 2024-10-07T09:00 |

원문이 끝에 실은 도구 클래스 `DateUtils`에는 인자 없는 `now()`가 열 번 나옵니다. 이 코드를 한국 시간대의 장비에서 UTC 컨테이너로 옮기면 한국의 자정부터 오전 9시까지는 "오늘"이 어제 날짜로 나옵니다. `ZoneId`를 인자로 받는 `now`를 쓰면 어느 시간대의 오늘인지가 코드에 드러나고 `Clock`(현재 시각을 돌려주는 시계 객체)을 받는 `now`를 쓰면 테스트에서 시각도 고정할 수 있습니다. 제가 만드는 이커머스 백엔드 BE-commerce에서는 시각이 판정에 들어가는 웹훅 서명 검증, 대기열, 정합성 검사가 `Clock`을 주입받습니다.

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

하루를 더하는 방법은 `plusDays(1)`과 `plus(Duration.ofDays(1))` 둘이고 서머타임이 바뀌는 날에는 한 시간 차이가 납니다. 뉴욕의 2024년 3월 9일 정오에 하루를 더했습니다. 다음 날 새벽에 서머타임이 시작됩니다.

| 더한 것 | 결과 |
|---|---|
| `plusDays(1)` | 2024-03-10T12:00-04:00 |
| `plus(Duration.ofDays(1))` | 2024-03-10T13:00-04:00 |

`plusDays(1)`은 달력의 하루를 더합니다. 위 표의 한 시간 차이는 `Period` Javadoc의 설명 그대로입니다. `Duration`의 하루는 언제나 24시간이고 `Period`의 하루는 달력의 하루여서 더한 뒤의 시각을 되도록 같게 맞춥니다. 내일 같은 시각에 알림을 보내려면 `Period`를 쓰고 24시간 뒤에 만료시키려면 `Duration`을 씁니다.

시간대가 없는 `LocalDateTime` 두 개의 차도 서머타임을 건너면 실제로 흐른 시간과 달라집니다. 서머타임이 시작된 3월 10일의 0시와 6시의 차는 `LocalDateTime`으로 6시간, 뉴욕의 `ZonedDateTime`으로 5시간이 나옵니다.

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

시간대 규칙이 붙으면 달력에 없는 시각과 두 번 오는 시각이 생깁니다. 서머타임이 시작할 때 시계를 한 시간 앞으로 돌리면 그 한 시간은 건너뛰고 끝날 때 뒤로 돌리면 같은 한 시간이 두 번 지나갑니다. 한국 시간대에도 이런 시각이 있습니다. JDK 21에 든 `Asia/Seoul` 규칙에는 오프셋이 바뀐 때가 28번 있습니다. 서머타임을 지금 쓰지 않는 시간대라도 과거 날짜에는 없는 시각과 두 번 오는 시각이 있다는 뜻입니다. 가장 최근의 것이 1987년과 1988년의 서머타임입니다. 1988년의 두 시각을 `atZone`에 넣었습니다.

![1988년 5월 8일에는 02시부터 03시가 없고 10월 9일에는 02시부터 03시가 두 번 지나가는 서울의 시계 그림](/uploads/theory/java-time-five-decisions/gap-overlap.svg)

| 입력 | `atZone(Asia/Seoul)`의 결과 |
|---|---|
| 1988-05-08T02:30 (없는 시각) | 1988-05-08T03:30+10:00 |
| 1988-10-09T02:30 (두 번 오는 시각) | 1988-10-09T02:30+10:00 |
| 위 값에 `withLaterOffsetAtOverlap()` | 1988-10-09T02:30+09:00. 앞의 값보다 1시간 뒤의 순간 |

두 경우 모두 예외가 나지 않습니다. `ZonedDateTime` Javadoc에 따르면 없는 시각은 빈 구간의 길이만큼 늦추고 두 번 오는 시각은 이른 오프셋을 고릅니다. 입력을 거절하고 싶으면 `ZoneRules.getValidOffsets`가 돌려주는 오프셋의 개수(0, 1, 2)를 보거나 `ZonedDateTime.ofStrict`를 씁니다. 뉴욕의 없는 시각 `2024-03-10T02:30`으로 실행해 보니 `ofStrict`는 `DateTimeException`을 던졌습니다.

시간대 규칙은 앞으로도 바뀝니다. Jon Skeet은 2019년에 쓴 글에서 2022년 7월 10일 오전 9시에 암스테르담에서 열릴 회의를 예로 들었습니다. 등록할 때의 규칙으로 UTC 시각을 계산해 저장해 두었는데 그 뒤 네덜란드가 서머타임을 없앤다고 가정하면 저장된 순간은 회의 시작과 한 시간 어긋납니다. Skeet은 시간대 규칙의 변경을 늘 있는 일로 다루라고 합니다.

> The larger point is that time zone rules change, and that applications should expect that they will change. This isn't a corner case, it's the normal way things work.

시간대 규칙이 실제로 바뀐 것을 맥 한 대에 깔린 JDK 두 개로 확인했습니다. JDK마다 들어 있는 시간대 자료(tzdata)의 판이 달라서 같은 달력의 시각을 넣어도 다른 순간이 나왔습니다.

| JDK | tzdata | `2024-06-01T12:00 Asia/Almaty` | `2025-07-01T12:00 America/Asuncion` |
|---|---|---|---|
| 17.0.7 | 2022g | +06:00, `06:00Z` | -04:00, `16:00Z` |
| 21.0.9 | 2025b | +05:00, `07:00Z` | -03:00, `15:00Z` |

규칙은 가까운 곳에서도 바뀌었습니다. JDK 21에서 `Asia/Pyongyang`의 오프셋(UTC와의 차)은 2015년 8월 14일에 +09:00, 2016년 1월 1일에 +08:30, 2018년 6월 1일에 다시 +09:00이었습니다.

2022년의 규칙으로 위 표의 두 약속을 순간으로 바꿔 저장했다면 한 시간 어긋난 값이 남습니다. Skeet이 고른 방법은 사람이 말한 달력의 시각과 지역 ID를 그대로 보존하고 UTC 순간은 다시 계산할 수 있는 파생 데이터로 두는 것입니다. 이미 일어난 일은 규칙이 바뀌어도 달라지지 않으므로 `Instant` 하나로 충분합니다.

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

원문은 `Date`가 밀리초까지만 담고 값을 바꿀 수 있는 객체인 데 비해 `Instant`는 나노초까지 담고 값을 바꿀 수 없는 객체라는 점을 들어 `Date` 대신 `Instant`를 쓰라고 권합니다. 쓰임으로는 코드 실행 시간의 기록과 사용자가 무언가를 조작한 시점의 기록을 듭니다. `Date`가 담던 것도 순간이므로 두 타입은 같은 것을 담습니다. 개발 수첩도 JDK 8 이상이면 `Date`는 `Instant`로, `Calendar`는 `LocalDateTime`으로 바꿔 쓸 수 있다고 나눠 적었습니다.

원문은 `Instant`를 코드 실행 시간을 기록하는 용도로도 소개하고 `Instant.now()`를 코드 앞뒤에서 불러 그 차를 구하는 예제를 실었습니다. 걸린 시간을 재는 메서드는 `System.nanoTime()`이고 그 Javadoc에는 이렇게 적혀 있습니다.

> This method can only be used to measure elapsed time and is not related to any other notion of system or wall-clock time.

걸린 시간을 재는 데만 쓸 수 있고 시스템의 현재 시각과는 관계가 없다는 문장입니다.

`Instant.now()`는 운영체제의 시계가 가리키는 현재 시각을 읽습니다. 흔히 벽시계(wall clock)라고 하는 시계입니다. 시각 동기화가 벽시계를 고치면 시각이 거꾸로 갈 수 있습니다. `Instant`의 Javadoc에는 구현이 단조 시계, 곧 값이 거꾸로 가지 않는 시계를 제공할 의무가 없다고 적혀 있습니다.

`System.nanoTime()`, `System.currentTimeMillis()`, `Instant.now()` 세 시계가 얼마나 잘게 바뀌고 한 번 부르는 데 얼마나 걸리는지 macOS의 JDK 21에서 쟀습니다. 최소 간격은 연달아 부른 값들 사이의 가장 작은 양의 차이고 호출 시간은 JMH로 잰 값입니다.

| 시계 | 값이 바뀌는 최소 간격 | 호출 한 번의 시간 |
|---|---|---|
| `System.nanoTime()` | 41ns | 14.5ns |
| `System.currentTimeMillis()` | 값의 단위가 1ms | 19.8ns |
| `Instant.now()` | 1,000ns | 31.0ns |

`Instant`는 나노초 자리까지 담을 수 있는 타입이지만 이 환경에서 `Instant.now()`의 값은 1마이크로초 단위로만 바뀌었습니다. 연달아 200만 번 불렀을 때 직전과 같은 값이 JDK 17에서 177만 번, JDK 21에서 193만 번, JDK 25에서 183만 번이었습니다. 값이 한 번 바뀌기 전에 끝나는 코드의 앞뒤에서 부르면 차가 0으로 나옵니다.

벽시계의 차가 음수가 된 사고가 2017년 1월 1일의 Cloudflare 장애입니다. 윤초가 들어간 자정에 DNS 서버 안에서 두 시각의 차가 음수가 됐고 그 값이 난수 함수에 들어가 패닉(Go 프로그램의 실행을 멈추는 오류)이 났습니다. Cloudflare는 최대 약 0.2%의 DNS 질의가 영향을 받았고 HTTP 요청의 1% 미만이 오류를 냈으며 영향이 06:45 UTC에 끝났다고 밝혔습니다. 같은 글은 거꾸로 갈 수 있는 시계로 잰 차는 음수인지부터 확인하라는 교훈을 남겼습니다.

> One precaution when using a non-monotonic clock source is to always check whether the difference between two timestamps is negative.

Go는 이 사고를 설계 문서에 인용하고 벽시계 값 안에 단조 시계의 값을 함께 넣는 설계를 택했습니다. Java는 두 시계가 처음부터 다른 메서드로 나뉘어 있어서 용도에 맞는 쪽을 부르면 됩니다. 언제 일어났는지를 남길 때는 `Instant`를 쓰고 얼마나 걸렸는지와 타임아웃이 지났는지는 `nanoTime()`의 차로 봅니다.

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

원문은 둘째 줄을 `Locale.CHINA`로 찍었고 출력 주석은 `2024 十月 08 星期二 00:25`입니다. JDK 17, 21, 25에서 실행하면 `2024 10月 08 周二 00:25`가 나옵니다. JDK 17.0.7과 21.0.9에 옛 로캘 자료를 쓰는 옵션(`-Djava.locale.providers=COMPAT`)을 주자 원문의 주석과 같은 출력이 나왔고 25.0.1은 이 옵션을 받지 않았습니다. 영어판은 이 줄의 주석에 미국 형식을 두 번 적었습니다. 넷째 줄처럼 12시간제 `h`를 쓰면 자정 0시 25분은 오전 12:25로 찍힙니다. 마지막 줄의 `zzz`는 `KST`를 찍습니다. 찍을 때는 나오는 이름이지만 앞의 TimeZone 절에서 본 대로 `ZoneId.of`에 ID로 넣을 수는 없습니다.

`YYYY`는 그 주가 속한 해를 찍습니다. 같은 날짜를 `yyyy`와 `YYYY`로 찍었고 `YYYY`는 로캘을 바꿔 가며 찍었습니다.

| 날짜 | `yyyy-MM-dd` | `YYYY-MM-dd` 한국 로캘 | `YYYY-MM-dd` 미국 로캘 | `YYYY-MM-dd` 영국 로캘 |
|---|---|---|---|---|
| 2024-12-28 (토) | 2024-12-28 | 2024-12-28 | 2024-12-28 | 2024-12-28 |
| 2024-12-29 (일) | 2024-12-29 | 2025-12-29 | 2025-12-29 | 2024-12-29 |
| 2024-12-30 (월) | 2024-12-30 | 2025-12-30 | 2025-12-30 | 2025-12-30 |
| 2027-01-01 (금) | 2027-01-01 | 2027-01-01 | 2027-01-01 | 2026-01-01 |

`Y`는 주 단위로 센 해입니다. 한 주가 무슨 요일에 시작하고 첫 주를 어떻게 정하는지는 로캘마다 달라서 같은 날짜가 로캘에 따라 다음 해로도 지난해로도 찍힙니다. 개발 수첩은 `yyyy`와 `YYYY`의 구분을 강제 조항으로 두고 `YYYY/MM/dd`로 포맷한 탓에 2017년 12월 31일이 2018/12/31로 나와 서비스 장애가 났다는 사례를 실었습니다. 수첩은 한 주가 일요일에 시작하고 해를 넘기면 다음 해가 나온다고 설명하는데 위 표의 영국 로캘처럼 지난해가 나오는 경우도 있습니다.

영국 정부의 결제 서비스 GOV.UK Pay도 `YYYY`로 같은 일을 겪었습니다. 2020년 12월 29일에 새로 만든 API 키의 생성일이 2021년으로 표시됐고 이 오류는 그날 테스트 하나가 실패하면서 드러났습니다. `YYYY` 실수는 연말과 연초 며칠에만 나타나므로 테스트 날짜에 그 며칠을 넣거나 정적 분석으로 잡습니다. Google의 Error Prone에는 `ww` 없이 `YYYY`를 쓴 패턴을 오류로 잡는 `MisusedWeekYear` 검사가 있습니다.

`hh`, `DD`, `mm`도 한 글자 차이로 다른 값을 찍습니다. `h`는 12시간제의 시, `D`는 그해의 몇 번째 날, `m`은 분입니다. 24시간제의 시 `H`, 그달의 날 `d`, 달 `M`과 대소문자만 다릅니다.

| 패턴 | 입력 | 출력 |
|---|---|---|
| `hh:mm` | 13:05 | 01:05 |
| `yyyy-MM-DD` | 2024-02-01 | 2024-02-32 |
| `yyyy-mm-dd` | 2024-02-01 09:41 | 2024-41-01 |

읽을 때는 없는 날짜가 예외 없이 다른 날짜로 바뀝니다. 없는 날짜가 섞인 문자열을 포매터와 해석 방식을 바꿔 가며 읽었습니다.

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

`ofPattern`으로 만든 포매터는 읽은 값을 날짜로 맞추는 방식(`ResolverStyle`)이 SMART이고 이 방식은 날짜가 그달의 마지막 날을 넘으면 마지막 날로 맞춥니다. 31을 넘는 값은 SMART에서도 예외입니다. 사용자가 넣은 2월 30일을 거절하려면 달력에 없는 값을 받지 않는 STRICT로 바꿔야 합니다. STRICT에서 `yyyy`는 연호(기원전과 기원후)가 함께 있어야 하는 해여서 멀쩡한 2월 29일도 실패합니다. 그래서 STRICT에는 `uuuu`를 씁니다. 원문의 `parseLocalDate(dateStr, pattern)`은 받은 패턴으로 SMART 포매터를 만들므로 없는 날짜가 들어와도 마지막 날로 바꿔 받아들입니다.

JMH로 format 한 번에 걸리는 시간을 쟀습니다. JMH는 측정용 JVM을 따로 띄워(포크) 반복 실행하는 벤치마크 도구이고 ± 뒤의 값은 99.9% 신뢰 구간입니다.

| 방식 | format 한 번의 시간 |
|---|---|
| `DateTimeFormatter`를 상수로 두고 씀 | 96.9 ± 1.5ns |
| `DateTimeFormatter.ofPattern`을 호출마다 부름 | 258.1 ± 11.3ns |
| `ThreadLocal<SimpleDateFormat>` | 302.3 ± 20.2ns |
| `new SimpleDateFormat`을 호출마다 만듦 | 839.8 ± 40.7ns |

원문의 `DateUtils`는 `ofPattern`을 호출마다 부릅니다. 상수로 둘 때보다 2.7배 느리고 차이는 호출당 160ns쯤입니다. 초당 만 번을 불러도 1.6ms이므로 포매터는 `java.text.SimpleDateFormat` 절에서 본 틀린 결과 수를 기준으로 고릅니다.

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

컬럼에 든 것이 순간이라면 Java 타입을 `LocalDateTime`으로 바꾼 뒤에도 같은 순간으로 읽히는지는 컬럼 타입과 연결 설정(JDBC 연결 주소에 주는 `connectionTimeZone` 같은 시간대 옵션)에 달려 있습니다. 순간 하나(`2024-10-07T16:00:00Z`)를 서울 시간대로 띄운 JVM으로 쓰고 UTC로 띄운 JVM으로 읽었습니다. 앱 서버를 한국 시간대의 장비에서 UTC 컨테이너로 옮기는 상황을 흉내 낸 것입니다. MySQL과 PostgreSQL 서버 두 대의 시간대는 UTC입니다.

![연결 설정이 없을 때는 서울 시각의 글자가 저장되어 UTC JVM이 9시간 뒤의 순간으로 읽고 connectionTimeZone을 UTC로 주면 같은 순간으로 읽히는 과정](/uploads/theory/java-time-five-decisions/store-shift.svg)

| DB와 컬럼 | 연결 설정 | 서버에 남은 글자 | UTC JVM이 읽은 순간 |
|---|---|---|---|
| MySQL `DATETIME` | 없음 | 2024-10-08 01:00:00 | 2024-10-08T01:00Z |
| MySQL `TIMESTAMP` | 없음 | 2024-10-08 01:00:00 | 2024-10-08T01:00Z |
| MySQL `DATETIME` | `connectionTimeZone=UTC` | 2024-10-07 16:00:00 | 2024-10-07T16:00Z |
| MySQL `TIMESTAMP` | `connectionTimeZone=UTC` | 2024-10-07 16:00:00 | 2024-10-07T16:00Z |
| PostgreSQL `timestamp` | 없음 | 2024-10-08 01:00:00 | 2024-10-08T01:00Z |
| PostgreSQL `timestamptz` | 없음 | 2024-10-07 16:00:00+00 | 2024-10-07T16:00Z |

순간은 `Timestamp`, `OffsetDateTime`, `Instant` 세 타입으로 넣었고 MySQL에서는 셋의 결과가 같았습니다. PostgreSQL 드라이버는 `Instant`를 받지 않아 예외를 냈습니다.

MySQL은 `TIMESTAMP` 컬럼도 연결 설정이 없으면 어긋납니다. MySQL 문서에 따르면 `TIMESTAMP`는 넣을 때 UTC로 바꾸고 꺼낼 때 되돌리며 `DATETIME`은 바꾸지 않습니다.

> MySQL converts TIMESTAMP values from the current time zone to UTC for storage, and back from UTC to the current time zone for retrieval. (This does not occur for other types such as DATETIME.)

여기서 current time zone은 서버 세션의 시간대입니다. MySQL의 JDBC 드라이버인 Connector/J의 문서에 따르면 `connectionTimeZone`의 기본값은 `LOCAL`이고 이때 드라이버는 연결의 시간대가 JVM의 시간대와 같다고 가정합니다. 그래서 서울 JVM은 서울 시각의 글자 `01:00:00`을 보내고 UTC 세션인 서버는 그 글자를 UTC로 받습니다. 서버에서 `UNIX_TIMESTAMP`로 확인한 `TIMESTAMP` 컬럼의 순간은 실제보다 9시간 뒤였습니다. 쓴 JVM으로 다시 읽으면 같은 가정이 거꾸로 적용되어 맞는 값이 나오므로 이 어긋남은 앱 서버의 시간대를 바꾸기 전에는 드러나지 않습니다.

`connectionTimeZone=UTC`를 주면 드라이버가 순간을 UTC 시각의 글자로 바꿔 보냅니다. Connector/J 8.0.23부터 `serverTimezone`은 이 속성의 별칭입니다.

개발 수첩은 생성 시각과 수정 시각의 컬럼을 `datetime`으로 두고 시간대 정보를 기록하려면 `timestamp`로 두라고 권합니다. MySQL 문서의 설명대로라면 `TIMESTAMP`에 남는 것은 세션 시간대로 받아 UTC로 바꿔 둔 순간이고 시간대 정보는 남지 않습니다.

MySQL에서 `LocalDateTime`으로 넣은 시각은 글자 그대로 남았습니다. MySQL에 `LocalDateTime`을 넣으면 드라이버가 변환하지 않습니다. 서울 시각 `2024-10-08T01:00`은 실행한 세 가지 연결 설정(설정 없음, `connectionTimeZone=UTC`, 여기에 `forceConnectionTimeZoneToSession=true`를 더한 것) 모두에서 그 글자로 저장됐고 어느 JVM에서나 같은 `LocalDateTime`으로 읽혔습니다. 달력의 시각을 저장하려던 것이면 맞는 동작이고 순간을 저장하려던 것이면 시간대가 사라진 값입니다.

PostgreSQL은 `timestamptz`가 순간이고 `timestamp`가 달력의 시각입니다. PostgreSQL의 JDBC 드라이버(pgjdbc)는 세션의 시간대를 JVM의 시간대로 맞춥니다. 그래서 `timestamptz`에는 `LocalDateTime`, `Timestamp`, `OffsetDateTime` 어느 것으로 넣어도 맞는 순간이 저장됐고 UTC JVM에서 `OffsetDateTime`으로 읽으면 같은 순간이 나왔습니다. `timestamp`에는 쓴 쪽 시간대의 시각 글자가 남았습니다. PostgreSQL 위키의 "Don't Do This"는 `timestamp`를 달력과 시계를 찍은 사진에 견줍니다.

> You can think of it being a picture of a calendar and a clock rather than a point in time.

드라이버 문서에는 `ZonedDateTime`과 `Instant`를 지원하지 않는다고 적혀 있습니다. 순간은 `OffsetDateTime`으로 바꿔서 넣고 읽습니다.

BE-commerce는 `Instant`, `DATETIME(6)`, UTC 설정 셋을 묶어 쓰고 MySQL 8.4를 씁니다. 2026년 10월 7일 커밋 기준으로 운영 코드에서 `Instant`를 쓰는 파일이 136개이고 `LocalDateTime`을 쓰는 파일은 2개입니다. 스키마 파일에는 `DATETIME(6)`이 89번 나오고 `TIMESTAMP`는 없습니다. 연결 주소에는 `serverTimezone=UTC`, Hibernate에는 `hibernate.jdbc.time_zone: UTC`를 줘서 컬럼에 UTC 시각의 글자가 남게 했습니다. 이 절 첫 표의 셋째 줄(`DATETIME` 컬럼, 연결 설정 `connectionTimeZone=UTC`)에 해당하는 구성입니다.

이 구성에서 한 번 걸린 곳이 드라이버가 돌려주는 타입입니다. 이번 실행에서 `getObject`의 결과는 `DATETIME`이 `LocalDateTime`, `TIMESTAMP`가 `java.sql.Timestamp`였고 `getObject(컬럼, Instant.class)`는 두 컬럼 모두 예외를 던졌습니다. BE-commerce에는 아직 발행하지 못한 이벤트 가운데 가장 오래된 것이 만들어진 뒤 흐른 시간을 내보내는 지표가 있고 이 지표는 `DATETIME` 컬럼의 최솟값을 `Instant.class`로 읽었습니다. 밀린 이벤트가 없으면 최솟값이 `NULL`이라 변환이 일어나지 않아 조회가 성공했고 밀린 이벤트가 있을 때만 변환 예외가 났습니다. 지표는 그때 NaN이 됐고 NaN은 어떤 임계값과 비교해도 참이 되지 않으므로 적체 알림이 울리지 않았습니다. `LocalDateTime`으로 읽어 UTC로 해석하게 고쳤고 경위는 [이슈 #393](https://github.com/dj258255/BE-commerce/issues/393)에 있습니다.

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
- **기준일.** 원문의 `isBefore`, `isAfter`, `isBeforeOrEqual`, `isAfterOrEqual`, `getAge`도 안에서 `now()`를 부릅니다. 다섯 메서드 모두 기준일을 인자로 받게 했습니다. `getAge`의 결과는 만 나이입니다.
- **형식.** `2024-02-30`을 넣으면 원문의 `parseLocalDate`는 2월 29일을 돌려주고 고친 판은 예외를 던집니다. 달력에 없는 날짜를 받지 않는 해석 방식(`ResolverStyle.STRICT`)을 썼고 이 방식에서는 `yyyy`가 연호를 함께 요구해 멀쩡한 날짜도 실패하므로 패턴을 `uuuu-MM-dd`로 적었습니다. `formatLocalDate`와 `parseLocalDate`가 받던 패턴 인자는 없애고 이 한 가지 형식으로 고정했으며 포매터는 상수로 두었습니다.
- **기간.** `isDateInRange`가 양 끝을 포함합니다. 원문은 시작일이나 끝일을 넣으면 false를 돌려줍니다.
- **한 주의 처음과 끝.** 한국 로캘의 한 주는 일요일에 시작합니다(`WeekFields.of(Locale.KOREA)`). 원문의 `getFirstDayOfWeek`는 월요일에 시작하는 주를 쓰고 고친 판은 `getFirstDayOfWeek`와 `getLastDayOfWeek`가 한 주가 시작하는 요일을 인자로 받습니다.
- **영업일.** 원문의 `getNextWorkingDay`는 토요일과 일요일만 건너뜁니다. `getNextWorkingDay`와 `getPreviousWorkingDay`가 공휴일 목록을 인자로 받게 하고 `isWorkingDay`와 `getWorkingDayCountOfMonth`를 더했습니다. 2025년 10월 2일의 다음 영업일은 원문의 계산으로는 개천절인 10월 3일이고 고친 판에 그해 10월의 공휴일 목록을 인자로 넘기면 10월 10일입니다. 공휴일 목록은 공공데이터포털의 한국천문연구원 특일 정보 API로 받을 수 있습니다.

위 여섯 가지를 뺀 나머지 메서드는 구현을 줄인 곳이 있어도 원문과 결과가 같습니다. 원문의 40개 가운데 `now()`를 쓰는 여덟을 뺀 32개를 2020년 1월 1일부터 2030년 12월 31일까지 모든 날짜에 호출해 96,985건을 비교했습니다. 한 주의 시작에는 월요일을, 영업일에는 빈 공휴일 목록을 넘겼고 `isDateInRange`의 기간은 2024년 10월 한 달로 두었습니다. 다른 결과는 `isDateInRange`의 양 끝 두 날짜뿐이었습니다. 2월 30일처럼 달력에 없는 날짜 74개는 원문이 모두 받아들였고 고친 판은 모두 예외를 던졌습니다.

원문의 `getAge(birthDate)`는 안에서 `LocalDate.now()`를 불러 `Period.between(birthDate, 오늘).getYears()`를 돌려줍니다. 한국에서는 만 나이로 통일하는 민법과 행정기본법 개정이 2023년 6월 28일에 시행됐습니다. 원문의 계산은 생일이 지났는지를 반영하므로 결과가 만 나이입니다. 생일과 기준일을 바꿔 가며 계산했습니다.

| 생일 | 기준일 | `Period.between(생일, 기준일).getYears()` |
|---|---|---|
| 1990-10-08 | 2024-10-07 | 33 |
| 1990-10-08 | 2024-10-08 | 34 |
| 2000-02-29 | 2023-02-28 | 22 |
| 2000-02-29 | 2023-03-01 | 23 |
| 2000-02-29 | 2024-02-29 | 24 |

올해에서 태어난 해를 빼면(`2024 - 1990`) 생일이 지나지 않은 10월 7일에도 34가 나옵니다. 2월 29일에 태어난 사람은 평년에 3월 1일부터 한 살이 올라갑니다. 3월 1일이라는 날짜는 `Period`가 계산한 결과이고 법령이 윤일 생일을 어떻게 세는지는 이 글에서 확인하지 못했습니다. 원문은 기준일을 `LocalDate.now()`로 얻는데 `LocalDate` 절에서 본 대로 오늘 날짜는 JVM의 시간대에 따라 달라집니다. 그래서 기준일은 인자로 받습니다.

다음 영업일은 공휴일 목록이 있어야 맞습니다. 한국의 공휴일에는 음력으로 정해지는 설과 추석, 공휴일이 주말과 겹칠 때 생기는 대체공휴일, 그해에 정해지는 임시공휴일이 있습니다. 원문의 `getNextWorkingDay`는 토요일과 일요일만 건너뜁니다. JDK가 제공하는 달력 체계를 `Chronology.getAvailableChronologies()`로 뽑으면 ISO, Hijrah-umalqura, Japanese, Minguo, ThaiBuddhist 다섯입니다. 한국에서 쓰는 음력이 없어 설과 추석 날짜를 JDK로 계산할 수 없으므로 공휴일은 날짜 목록으로 받습니다.

2025년 10월 2일 목요일의 다음 영업일을 두 방법으로 구했습니다. 그해 10월은 3일 개천절부터 9일 한글날까지 이레가 이어지는 연휴였고 추석 연휴 첫날인 5일이 일요일이었습니다. 이레 가운데 토요일인 4일만 공휴일이 아닙니다. 공휴일은 3일, 5일부터 7일, 5일이 일요일과 겹쳐 생긴 대체공휴일 8일, 9일입니다.

| 계산 | 2025-10-02의 다음 영업일 |
|---|---|
| 주말만 건너뜀(원문) | 2025-10-03(금). 개천절 |
| 주말과 공휴일 목록을 건너뜀 | 2025-10-10(금) |

원문의 계산이 돌려준 3일은 개천절이고 공휴일 목록까지 건너뛰어야 10일이 나옵니다.

공휴일 목록은 공공데이터포털의 한국천문연구원 특일 정보 API로 받을 수 있습니다. 국경일, 공휴일, 기념일, 24절기를 날짜별로 돌려주고 공공기관 휴일 여부가 함께 옵니다. 임시공휴일은 그해에 정해지므로 목록은 배포 없이 고칠 수 있는 설정이나 DB에 둡니다.

한 주의 첫날은 한국 로캘에서 일요일이고 집계의 시작 요일은 코드에 적습니다. 원문의 `getFirstDayOfWeek`는 주석에 월요일이라고 밝히고 `date.with(DayOfWeek.MONDAY)`를 돌려줍니다. `DayOfWeek`는 월요일에 시작해 일요일에 끝나는 ISO 기준이어서 일요일을 넣으면 엿새 전 월요일이 나옵니다. 로캘이 정한 한 주는 `WeekFields`에 들어 있고 한국 로캘의 첫 요일은 일요일입니다. 두 기준으로 그 주의 첫날과 끝날을 구했습니다.

| 날짜 | ISO 기준(월요일 시작) | 한국 로캘 기준(일요일 시작) |
|---|---|---|
| 2024-10-06(일) | 09-30 ~ 10-06 | 10-06 ~ 10-12 |
| 2024-10-09(수) | 10-07 ~ 10-13 | 10-06 ~ 10-12 |

일요일인 10월 6일은 ISO 기준으로 그 주의 끝날이고 한국 로캘 기준으로 첫날입니다.

한국 로캘 기준의 첫날과 끝날은 `WeekFields`로 구했습니다.

```java
WeekFields week = WeekFields.of(Locale.KOREA);   // 첫 요일 SUNDAY
date.with(week.dayOfWeek(), 1);                  // 그 주의 일요일
date.with(week.dayOfWeek(), 7);                  // 그 주의 토요일
```

로캘의 첫 요일은 JDK에 든 로캘 자료를 따릅니다. `WeekFields.of(Locale.CHINA)`의 첫 요일은 JDK 17.0.7에서 일요일이었고 JDK 21.0.9와 25.0.1에서 월요일이었습니다. 한국 로캘은 세 JDK 모두 일요일이었습니다. JDK를 올리면 로캘의 첫 요일이 바뀔 수 있으므로 주간 집계의 시작 요일은 업무 규칙으로 정해 코드에 직접 적어 둡니다. 요일을 코드에 직접 적는 방식은 원문과 같습니다.

고친 `DateUtils` 전체는 아래와 같습니다.

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

- JDK는 17.0.7(tzdata 2022g), 21.0.9(2025b), 25.0.1(2025b)이고 Apple Silicon 맥(12코어)의 macOS에서 실행했습니다. 기본 시간대는 Asia/Seoul, 기본 로캘은 ko_KR이고 `Date`를 찍은 예와 변환 절의 표는 기본 시간대를 UTC로도 바꿔 돌렸습니다.
- tzdata 비교, 포매터 공유, JMH, DB 실험을 뺀 나머지는 세 JDK에서 돌렸습니다. JDK에 따라 달라진 것은 `Instant.now()`가 직전과 같았던 횟수, 예외 메시지의 필드 순서, `WeekFields.of(Locale.CHINA)`의 첫 요일, 쓸 수 있는 시간대 ID의 수(17.0.7은 631개와 603개, 21.0.9와 25.0.1은 632개와 604개), JDK 25가 세 글자 ID에 찍는 경고, 옛 로캘 자료 옵션을 받는지입니다. 포매터 공유, JMH, DB 실험은 JDK 21에서만 돌렸습니다.
- 원문의 `DateUtils`는 원문에서 복사한 코드를 고치지 않고 컴파일해 고친 판과 비교했습니다.
- 시계의 최소 간격은 이 맥에서 쟀습니다. 다른 운영체제에서는 다를 수 있습니다. 200만 번 가운데 시각이 거꾸로 간 적은 없었는데 이 결과로 알 수 있는 것은 측정하는 동안 시계 보정이 없었다는 데까지입니다.
- `SimpleDateFormat`의 틀린 결과 수는 실행마다 달라서 세 차례의 범위로 적었습니다. 같은 맥의 1분 부하 평균은 이 글의 실험을 돌린 동안 7.5~11.8이었고 포매터 공유 실험만의 부하는 따로 남기지 않았습니다.
- JMH는 포크 3번에 측정 5회씩(회당 1초)이고 측정하는 동안 같은 맥에서 다른 작업이 돌고 있었습니다(1분 부하 평균 7.5~9.1). parse는 오차 구간이 넓어 결론에 쓰지 않았습니다.
- DB는 MySQL 8.4.11과 Connector/J 9.1.0, PostgreSQL 16.15와 pgjdbc 42.7.4이고 JDK 21.0.9에서 순수 JDBC로 실행했습니다. Hibernate나 MyBatis를 거칠 때 매핑 계층이 더하는 변환은 재지 않았습니다.
- 2025년 10월의 공휴일은 우주항공청의 2025년도 월력요항을 다룬 보도에서 가져왔습니다. 보도에는 3일부터 9일까지 이레 연휴이고 추석 연휴 첫날인 5일이 일요일이라고 나와 있습니다. 8일이 대체공휴일이 된다는 점은 이 둘에서 계산했습니다. 특일 정보 API는 제공 항목을 문서로 확인했고 직접 호출하지는 않았습니다.
- 2월 29일에 태어난 사람의 만 나이를 법령이 어떻게 세는지는 확인하지 못했습니다. `getAge`의 결과는 `Period`의 계산입니다.
- 원문이 변환 방법의 참고로 든 CSDN 글은 이 글을 쓰는 동안 열리지 않아 내용을 확인하지 못했습니다.
- 회사 사례의 수치는 각 회사가 공개한 글에서 가져왔습니다.

## 참고

따라간 글

- [阿里云开发者社区, 如何才能在Java中优雅的操纵时间？](https://developer.aliyun.com/article/1637802)
- [Alibaba Cloud Community, How Can We Manipulate Time Gracefully in Java?](https://www.alibabacloud.com/blog/how-can-we-manipulate-time-gracefully-in-java_602187)
- [원문이 변환 방법의 참고로 든 CSDN 글](https://blog.csdn.net/qq_31635851/article/details/120150588)

고쳐 적거나 보탤 때 본 것

- [Alibaba, Java开发手册(黄山版)](https://github.com/alibaba/p3c)
- [Cloudflare, How and why the leap second affected Cloudflare DNS (2017)](https://blog.cloudflare.com/how-and-why-the-leap-second-affected-cloudflare-dns/)
- [Go, Proposal: Monotonic Elapsed Time Measurements in Go](https://go.googlesource.com/proposal/+/master/design/12914-monotonic.md)
- [Microsoft, Summary of Windows Azure Service Disruption on Feb 29th, 2012](https://azure.microsoft.com/en-us/blog/summary-of-windows-azure-service-disruption-on-feb-29th-2012/)
- [GOV.UK, How we fixed a strange 'week year' bug (2021)](https://technology.blog.gov.uk/2021/03/24/how-we-fixed-a-strange-week-year-bug/)
- [Google Error Prone, MisusedWeekYear](https://errorprone.info/bugpattern/MisusedWeekYear)
- [Jon Skeet, Storing UTC is not a silver bullet (2019)](https://codeblog.jonskeet.uk/2019/03/27/storing-utc-is-not-a-silver-bullet/)
- [Stephen Colebourne, Why JSR-310 isn't Joda-Time (2009)](https://blog.joda.org/2009/11/why-jsr-310-isn-joda-time_4941.html)
- [MyBatis, Configuration: typeHandlers](https://mybatis.org/mybatis-3/configuration.html)
- [ThreeTen-Extra](https://www.threeten.org/threeten-extra/), [Hutool LocalDateTimeUtil](https://doc.hutool.cn/pages/LocalDateTimeUtil/)
- [Java SE 21, TimeZone](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/TimeZone.html), [SimpleDateFormat](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/text/SimpleDateFormat.html), [System.nanoTime](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/System.html), [Instant](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/time/Instant.html), [DateTimeFormatter](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/time/format/DateTimeFormatter.html), [WeekFields](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/time/temporal/WeekFields.html), [Period](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/time/Period.html), [ZonedDateTime](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/time/ZonedDateTime.html), [IsoChronology](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/time/chrono/IsoChronology.html)
- [MySQL 8.4, The DATE, DATETIME, and TIMESTAMP Types](https://dev.mysql.com/doc/refman/8.4/en/datetime.html)
- [MySQL Connector/J, Preserving Time Instants](https://dev.mysql.com/doc/connector-j/en/connector-j-time-instants.html), [Datetime types processing](https://dev.mysql.com/doc/connector-j/en/connector-j-connp-props-datetime-types-processing.html)
- [PostgreSQL 16, Date/Time Types](https://www.postgresql.org/docs/16/datatype-datetime.html), [PostgreSQL Wiki, Don't Do This](https://wiki.postgresql.org/wiki/Don%27t_Do_This)
- [PostgreSQL JDBC, Using Java 8 Date and Time classes](https://jdbc.postgresql.org/documentation/query/)

한국 기준으로 고칠 때 본 것

- [법무부, '만 나이' 통일을 위한 민법 및 행정기본법 개정안, 2023년 6월 28일부터 시행](https://moj.go.kr/bbs/moj/189/566088/artclView.do)
- [공공데이터포털, 한국천문연구원 특일 정보](https://www.data.go.kr/data/15012690/openapi.do)
- [YTN, 우주항공청 2025년도 월력요항 발표 (2024-06-20)](https://www.ytn.co.kr/_ln/0103_202406200817450769)

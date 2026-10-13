---
title: '자바에서 시간을 다룰 때 무엇을 정해야 할까?'
description: 'Java의 시간 API로 코드를 짤 때 정하게 되는 여섯 가지를 실행 결과로 정리했습니다. JDK 17, 21, 25와 MySQL 8.4, PostgreSQL 16으로 서머타임, 월말 더하기, 시계 눈금, 포맷 문자, 컬럼 타입별 저장 결과를 확인했고 Cloudflare, Microsoft, GOV.UK의 사고와 알리바바 개발 수첩의 규약을 출처와 함께 적었습니다. 여섯째로 만 나이, 영업일, 한 주의 첫날처럼 한국 기준이 필요한 계산을 다뤘습니다.'
date: 2026-10-14
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
series: "자바 시간"
seriesOrder: 2
---

[앞 글](/blog/theory/java-time-five-decisions)에서는 알리바바 클라우드 개발자 커뮤니티의 "如何才能在Java中优雅的操纵时间？"를 따라 `java.util`과 `java.time`의 API를 차례로 봤습니다. 아래에서는 알리바바의 그 글을 원문이라고 부릅니다. 원문은 API를 소개하고 `java.time`으로 옮기라고 권합니다. 이 글은 그 API로 코드를 짤 때 정하게 되는 여섯 가지를 실행 결과와 공개된 사고 사례로 적습니다. 값을 어떤 타입에 담을지, 어떻게 더할지, 걸린 시간을 무엇으로 잴지, 문자열로 어떻게 바꿀지, 어디에 어떻게 저장할지, 나이와 영업일 같은 계산에 한국 기준을 어떻게 넣을지입니다. 실행은 JDK 17, 21, 25와 MySQL 8.4, PostgreSQL 16에서 했습니다.

여섯 가지를 실행해서 확인한 결과부터 적습니다.

1. 값이 순간인지 달력의 시각인지를 타입으로 정합니다. 이미 일어난 일은 `Instant`에, 사람이 정한 미래의 약속은 `LocalDateTime`과 `ZoneId`에 담습니다. 미래의 약속을 순간으로 바꿔 두면 시간대 규칙이 바뀔 때 어긋납니다. 같은 `2024-06-01T12:00 Asia/Almaty`가 JDK 17.0.7에서는 `06:00Z`, JDK 21.0.9에서는 `07:00Z`가 됐습니다.
2. 달력 위의 더하기는 순서와 단위에 따라 답이 달라집니다. 1월 31일에 한 달을 두 번 더하면 3월 29일이고 두 달을 한 번에 더하면 3월 31일입니다. 서머타임이 바뀌는 날에는 달력의 하루와 24시간이 한 시간 차이 나고 그 시간대에 없는 시각을 넣어도 `atZone`은 예외 없이 값을 골라 줍니다.
3. 걸린 시간은 `System.nanoTime()`으로 잽니다. `Instant.now()`는 운영체제의 현재 시각을 읽으므로 시각 동기화가 시계를 고치면 값이 거꾸로 갈 수 있습니다. 값이 바뀌는 간격도 1마이크로초여서 JDK 21에서 연달아 부른 200만 번 가운데 193만 번이 직전과 같은 값이었습니다.
4. 문자열로 바꿀 때는 패턴 문자와 해석 방식이 값을 바꿉니다. `YYYY`는 2024년 12월 29일을 2025년으로 찍었고 `yyyy-MM-dd`로 읽은 `2024-02-30`은 예외 없이 2월 29일이 됐습니다. `SimpleDateFormat` 하나를 여덟 스레드가 함께 썼더니 format 160만 번 가운데 78만~86만 번이 틀린 결과였고 예외는 88~1,121번이었습니다.
5. 저장한 순간이 같은 순간으로 읽히는지는 컬럼 타입과 연결 설정에 달려 있습니다. 연결 설정 없이 서울 시간대로 띄운 JVM이 MySQL에 쓴 순간을 UTC로 띄운 JVM으로 읽었더니 `DATETIME`과 `TIMESTAMP` 모두 9시간 뒤의 순간이 나왔습니다. `connectionTimeZone=UTC`를 주거나 PostgreSQL의 `timestamptz`를 쓰면 같은 순간으로 돌아왔습니다.
6. 나이, 영업일, 한 주의 첫날에는 한국 기준을 따로 넣습니다. 만 나이는 `Period.between`으로 나오고 2025년 10월 2일의 다음 영업일은 주말만 건너뛰면 10월 3일, 공휴일까지 건너뛰면 10월 10일입니다. 한국 로캘(언어와 지역 설정)의 한 주는 일요일에 시작합니다.

## 1. 값이 순간인지 달력의 시각인지 타입으로 정합니다

시간 값은 두 종류입니다. 하나는 세계 어디서나 같은 한 점인 순간이고 다른 하나는 달력과 시계에 적힌 글자인 달력의 시각입니다. Google의 Abseil 문서는 둘을 absolute time과 civil time이라고 부릅니다. `java.time`은 둘을 서로 다른 타입에 담습니다.

| 타입 | 담는 것 | 맞는 자리 |
|---|---|---|
| `Instant` | 순간 | 결제 승인, 로그, 만료 판정 |
| `LocalDate`, `LocalDateTime` | 달력의 날짜와 시각. 시간대가 없음 | 생일, 영업일, 매일 오전 9시 |
| `ZonedDateTime` | 달력의 시각과 시간대 규칙 | 사용자에게 보여 줄 시각, 미래의 약속 |
| `OffsetDateTime` | 달력의 시각과 UTC와의 차 | 오프셋이 붙은 문자열과 DB 값을 주고받을 때 |

원문은 `Instant`를 소개하는 절에서 `Date` 대신 `Instant`를 쓰라고 권하는데 DB 매핑 절에서는 `java.util.Date`를 `java.time.LocalDateTime`으로 바꿉니다. `Date`가 담던 것은 순간이므로 뜻을 지키는 짝은 `Instant`입니다. 알리바바가 공개한 Java 개발 수첩(阿里巴巴Java开发手册, 아래에서는 개발 수첩)도 JDK 8 이상이면 `Date`는 `Instant`로, `Calendar`는 `LocalDateTime`으로 바꿔 쓸 수 있다고 나눠 적었습니다.

### `LocalDateTime.now()`의 날짜는 JVM의 시간대에 따라 달라집니다

같은 순간 `2024-10-07T16:00:00Z`에 시간대만 바꿔 `now`를 불렀습니다.

| 시간대 | `LocalDate.now` | `LocalDateTime.now` |
|---|---|---|
| UTC | 2024-10-07 | 2024-10-07T16:00 |
| Asia/Seoul | 2024-10-08 | 2024-10-08T01:00 |
| America/Los_Angeles | 2024-10-07 | 2024-10-07T09:00 |

원문이 끝에 실은 도구 클래스 `DateUtils`에는 인자 없는 `now()`가 열 번 나옵니다. 이 코드를 한국 시간대의 장비에서 UTC 컨테이너로 옮기면 한국의 자정부터 오전 9시까지는 "오늘"이 어제 날짜로 나옵니다. `Clock`이나 `ZoneId`를 인자로 받는 `now`를 쓰면 어느 시간대의 오늘인지가 코드에 드러나고 테스트에서 시각을 고정할 수 있습니다. 제가 만드는 이커머스 백엔드 BE-commerce에서는 시각이 판정에 들어가는 웹훅 서명 검증, 대기열, 정합성 검사가 `Clock`을 주입받습니다.

### 미래의 약속을 순간으로 바꿔 저장하면 규칙이 바뀔 때 어긋납니다

Jon Skeet은 2019년에 쓴 글에서 2022년 7월 10일 오전 9시에 암스테르담에서 열릴 회의를 예로 들었습니다. 등록할 때의 규칙으로 UTC 시각을 계산해 저장해 두었는데 그 뒤 네덜란드가 서머타임을 없앤다고 가정하면 저장된 순간은 회의 시작과 한 시간 어긋납니다. Skeet은 시간대 규칙의 변경을 늘 있는 일로 다루라고 합니다.

> The larger point is that time zone rules change, and that applications should expect that they will change. This isn't a corner case, it's the normal way things work.

시간대 규칙이 실제로 바뀐 것을 맥 한 대에 깔린 JDK 두 개로 확인했습니다. JDK마다 들어 있는 시간대 자료(tzdata)의 판이 달라서 같은 달력의 시각을 넣어도 다른 순간이 나왔습니다.

| JDK | tzdata | `2024-06-01T12:00 Asia/Almaty` | `2025-07-01T12:00 America/Asuncion` |
|---|---|---|---|
| 17.0.7 | 2022g | +06:00, `06:00Z` | -04:00, `16:00Z` |
| 21.0.9 | 2025b | +05:00, `07:00Z` | -03:00, `15:00Z` |

규칙은 가까운 곳에서도 바뀌었습니다. JDK 21에서 `Asia/Pyongyang`의 오프셋(UTC와의 차)은 2015년 8월 14일에 +09:00, 2016년 1월 1일에 +08:30, 2018년 6월 1일에 다시 +09:00이었습니다.

2022년의 규칙으로 위 표의 두 약속을 순간으로 바꿔 저장했다면 한 시간 어긋난 값이 남습니다. Skeet이 고른 방법은 사람이 말한 달력의 시각과 시간대 ID를 그대로 보존하고 UTC 순간은 다시 계산할 수 있는 파생 값으로 두는 것입니다. 이미 일어난 일은 규칙이 바뀌어도 달라지지 않으므로 `Instant` 하나로 충분합니다.

## 2. 달력 위의 더하기는 순서와 단위에 따라 답이 달라집니다

날짜를 더할 때 정할 것은 어디서부터 더할지와 어떤 단위로 더할지입니다. 월말, 서머타임이 바뀌는 날, 그 시간대에 없는 시각에서 답이 갈렸습니다.

### 월말에서 더하면 순서에 따라 답이 다릅니다

`LocalDate`에 `plusMonths`, `minusMonths`, `plusYears`를 불렀습니다.

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

### 두 날짜 사이의 날 수는 `ChronoUnit.DAYS.between`으로 셉니다

`Period.between(2024-01-31, 2024-03-01)`은 `P1M1D`이고 `getDays()`는 1입니다. `Period`는 달과 날을 따로 들고 있어서 `getDays()`로 나오는 값은 달을 떼고 남은 날입니다. 두 날짜 사이의 날 수 30은 `ChronoUnit.DAYS.between`으로 구합니다.

### 하루를 더하는 방법이 둘이고 서머타임 날에는 한 시간 차이가 납니다

뉴욕의 2024년 3월 9일 정오에 하루를 더했습니다. 다음 날 새벽에 서머타임이 시작됩니다.

| 더한 것 | 결과 |
|---|---|
| `plusDays(1)` | 2024-03-10T12:00-04:00 |
| `plus(Duration.ofDays(1))` | 2024-03-10T13:00-04:00 |

`plusDays(1)`은 달력의 하루를 더합니다. 위 표의 한 시간 차이는 `Period` Javadoc의 설명 그대로입니다. `Duration`의 하루는 언제나 24시간이고 `Period`의 하루는 달력의 하루여서 더한 뒤의 시각을 되도록 같게 맞춥니다. 내일 같은 시각에 알림을 보내려면 `Period`를 쓰고 24시간 뒤에 만료시키려면 `Duration`을 씁니다.

시간대가 없는 `LocalDateTime` 두 개의 차도 서머타임을 건너면 실제로 흐른 시간과 달라집니다. 서머타임이 시작된 3월 10일의 0시와 6시의 차는 `LocalDateTime`으로 6시간, 뉴욕의 `ZonedDateTime`으로 5시간이 나옵니다.

### 한국 시간대에도 없는 시각과 두 번 오는 시각이 있습니다

JDK 21에 든 `Asia/Seoul` 규칙에는 오프셋이 바뀐 때가 28번 있습니다. 서머타임을 지금 쓰지 않는 시간대라도 과거 날짜에는 없는 시각과 두 번 오는 시각이 있다는 뜻입니다. 가장 최근의 것이 1987년과 1988년의 서머타임입니다. 1988년의 두 시각을 `atZone`에 넣었습니다.

![1988년 5월 8일에는 02시부터 03시가 없고 10월 9일에는 02시부터 03시가 두 번 지나가는 서울의 시계 그림](/uploads/theory/java-time-five-decisions/gap-overlap.svg)

| 입력 | `atZone(Asia/Seoul)`의 결과 |
|---|---|
| 1988-05-08T02:30 (없는 시각) | 1988-05-08T03:30+10:00 |
| 1988-10-09T02:30 (두 번 오는 시각) | 1988-10-09T02:30+10:00 |
| 위 값에 `withLaterOffsetAtOverlap()` | 1988-10-09T02:30+09:00. 앞의 값보다 1시간 뒤의 순간 |

두 경우 모두 예외가 나지 않습니다. `ZonedDateTime` Javadoc에 따르면 없는 시각은 빈 구간의 길이만큼 늦추고 두 번 오는 시각은 이른 오프셋을 고릅니다. 입력을 거절하고 싶으면 `ZoneRules.getValidOffsets`가 돌려주는 오프셋의 개수(0, 1, 2)를 보거나 `ZonedDateTime.ofStrict`를 씁니다. 뉴욕의 없는 시각 `2024-03-10T02:30`으로 실행해 보니 `ofStrict`는 `DateTimeException`을 던졌습니다.

## 3. 걸린 시간은 `System.nanoTime()`으로 잽니다

시각을 남기는 시계와 걸린 시간을 재는 시계는 다릅니다. `Instant.now()`는 운영체제의 현재 시각을 읽고 이 글에서는 이 시계를 벽시계라고 부릅니다. 시각 동기화가 벽시계를 고치면 값이 거꾸로 갈 수 있어서 두 값의 차를 걸린 시간으로 믿을 수 없습니다. `System.nanoTime()`은 걸린 시간을 재는 데만 쓰는 시계입니다.

원문은 `Instant`를 코드 실행 시간을 기록하는 용도로도 소개하고 `Instant.now()`를 코드 앞뒤에서 불러 그 차를 구하는 예제를 실었습니다. 개발 수첩에도 걸린 시간을 집계할 때 `Instant`를 쓸 수 있다는 문장이 있습니다. Javadoc이 이 용도로 지정한 것은 `System.nanoTime()`입니다.

> This method can only be used to measure elapsed time and is not related to any other notion of system or wall-clock time.

`Instant`의 Javadoc에는 구현이 단조 시계, 곧 값이 거꾸로 가지 않는 시계를 제공할 의무가 없다고 적혀 있습니다.

세 시계를 macOS의 JDK 21에서 쟀습니다. 최소 간격은 연달아 부른 값들 사이의 가장 작은 양의 차이고 호출 시간은 JMH로 잰 값입니다.

| 시계 | 값이 바뀌는 최소 간격 | 호출 한 번의 시간 |
|---|---|---|
| `System.nanoTime()` | 41ns | 14.5ns |
| `System.currentTimeMillis()` | 값의 단위가 1ms | 19.8ns |
| `Instant.now()` | 1,000ns | 31.0ns |

`Instant`는 나노초 자리까지 담을 수 있는 타입이지만 이 환경에서 `Instant.now()`의 값은 1마이크로초 단위로만 바뀌었습니다. 연달아 200만 번 불렀을 때 직전과 같은 값이 JDK 17에서 177만 번, JDK 21에서 193만 번, JDK 25에서 183만 번이었습니다. 값이 한 번 바뀌기 전에 끝나는 코드의 앞뒤에서 부르면 차가 0으로 나옵니다.

벽시계의 차가 음수가 된 사고가 2017년 1월 1일의 Cloudflare 장애입니다. 윤초가 들어간 자정에 DNS 서버 안에서 두 시각의 차가 음수가 됐고 그 값이 난수 함수에 들어가 패닉(Go 프로그램의 실행을 멈추는 오류)이 났습니다. Cloudflare는 최대 약 0.2%의 DNS 질의가 영향을 받았고 HTTP 요청의 1% 미만이 오류를 냈으며 영향이 06:45 UTC에 끝났다고 밝혔습니다. 같은 글은 거꾸로 갈 수 있는 시계로 잰 차는 음수인지부터 확인하라는 교훈을 남겼습니다.

> One precaution when using a non-monotonic clock source is to always check whether the difference between two timestamps is negative.

Go는 이 사고를 설계 문서에 인용하고 벽시계 값 안에 단조 시계의 값을 함께 넣는 설계를 택했습니다. Java는 두 시계가 처음부터 다른 메서드로 나뉘어 있어서 용도에 맞는 쪽을 부르면 됩니다. 언제 일어났는지를 남길 때는 `Instant`를 쓰고 얼마나 걸렸는지와 타임아웃이 지났는지는 `nanoTime()`의 차로 봅니다.

## 4. 문자열로 바꿀 때는 패턴 문자와 해석 방식이 값을 바꿉니다

날짜를 글자로 찍고 글자를 날짜로 읽는 자리에서는 패턴 문자 한 글자, 읽을 때의 해석 방식, 포매터를 함께 쓰는 방식이 저마다 값을 바꿨습니다.

### `YYYY`는 그 주가 속한 해를 찍습니다

같은 날짜를 `yyyy`와 `YYYY`로 찍었고 `YYYY`는 로캘(언어와 지역 설정)을 바꿔 가며 찍었습니다.

| 날짜 | `yyyy-MM-dd` | `YYYY-MM-dd` 한국 로캘 | `YYYY-MM-dd` 미국 로캘 | `YYYY-MM-dd` 영국 로캘 |
|---|---|---|---|---|
| 2024-12-28 (토) | 2024-12-28 | 2024-12-28 | 2024-12-28 | 2024-12-28 |
| 2024-12-29 (일) | 2024-12-29 | 2025-12-29 | 2025-12-29 | 2024-12-29 |
| 2024-12-30 (월) | 2024-12-30 | 2025-12-30 | 2025-12-30 | 2025-12-30 |
| 2027-01-01 (금) | 2027-01-01 | 2027-01-01 | 2027-01-01 | 2026-01-01 |

`Y`는 주 단위로 센 해입니다. 한 주가 무슨 요일에 시작하고 첫 주를 어떻게 정하는지는 로캘마다 달라서 같은 날짜가 로캘에 따라 다음 해로도 지난해로도 찍힙니다. 개발 수첩은 `yyyy`와 `YYYY`의 구분을 강제 조항으로 두고 `YYYY/MM/dd`로 포맷한 탓에 2017년 12월 31일이 2018/12/31로 나와 서비스 장애가 났다는 사례를 실었습니다. 수첩은 한 주가 일요일에 시작하고 해를 넘기면 다음 해가 나온다고 설명하는데 위 표의 영국 로캘처럼 지난해가 나오는 경우도 있습니다.

영국 정부의 결제 서비스 GOV.UK Pay도 `YYYY`로 같은 일을 겪었습니다. 2020년 12월 29일에 새로 만든 API 키의 생성일이 2021년으로 표시됐고 이 오류는 그날 테스트 하나가 실패하면서 드러났습니다. `YYYY` 실수는 연말과 연초 며칠에만 나타나므로 테스트 날짜에 그 며칠을 넣거나 정적 분석으로 잡습니다. Google의 Error Prone에는 `ww` 없이 `YYYY`를 쓴 패턴을 오류로 잡는 `MisusedWeekYear` 검사가 있습니다.

### `hh`, `DD`, `mm`도 한 글자 차이로 다른 값을 찍습니다

`h`는 12시간제의 시, `D`는 그해의 몇 번째 날, `m`은 분입니다. 24시간제의 시 `H`, 그달의 날 `d`, 달 `M`과 대소문자만 다릅니다.

| 패턴 | 입력 | 출력 |
|---|---|---|
| `hh:mm` | 13:05 | 01:05 |
| `yyyy-MM-DD` | 2024-02-01 | 2024-02-32 |
| `yyyy-mm-dd` | 2024-02-01 09:41 | 2024-41-01 |

### 읽을 때는 없는 날짜가 예외 없이 다른 날짜로 바뀝니다

없는 날짜가 섞인 글자를 포매터와 해석 방식을 바꿔 가며 읽었습니다.

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

### `SimpleDateFormat`을 공유하면 틀린 결과가 예외의 열 배 넘게 나옵니다

포매터 하나를 스레드 여덟이 함께 쓰며 스레드마다 20만 번, 모두 160만 번을 돌리고 미리 만들어 둔 정답과 비교했습니다. parse는 읽은 값을 다시 글자로 찍어 정답과 견줬습니다. 표의 값은 세 차례 실행의 범위입니다.

| 방식 | 틀린 결과 | 예외 |
|---|---|---|
| `SimpleDateFormat` 공유, format | 780,134 ~ 862,858 | 88 ~ 1,121 |
| `SimpleDateFormat` 공유, parse | 859,725 ~ 1,014,332 | 34,789 ~ 56,603 |
| `ThreadLocal<SimpleDateFormat>`, format | 0 | 0 |
| `DateTimeFormatter` 공유, format과 parse | 0 | 0 |

format은 절반 안팎이 틀렸는데 예외는 천 번에 한 번도 나지 않았습니다. parse에서는 `2030-04-30`이어야 할 값이 `0012-04-30`으로 읽힌 것도 있었습니다. 예외만 지켜봐서는 포매터를 공유한 실수를 찾지 못합니다. 표 아래쪽 두 줄이 0인 것은 Javadoc의 설명과 맞습니다. `SimpleDateFormat`의 Javadoc은 "Date formats are not synchronized"라며 스레드마다 따로 만들라고 권하고 `DateTimeFormatter`의 Javadoc에는 "This class is immutable and thread-safe"라고 적혀 있습니다. 개발 수첩도 `SimpleDateFormat`을 static으로 두지 말라는 것을 강제 조항으로 둡니다.

### 속도 차이는 호출당 수백 ns여서 포매터는 틀린 결과 수로 고릅니다

JMH로 format 한 번에 걸리는 시간을 쟀습니다. JMH는 측정용 JVM을 따로 띄워(포크) 반복 실행하는 벤치마크 도구이고 ± 뒤의 값은 99.9% 신뢰 구간입니다.

| 방식 | format 한 번의 시간 |
|---|---|
| `DateTimeFormatter`를 상수로 두고 씀 | 96.9 ± 1.5ns |
| `DateTimeFormatter.ofPattern`을 호출마다 부름 | 258.1 ± 11.3ns |
| `ThreadLocal<SimpleDateFormat>` | 302.3 ± 20.2ns |
| `new SimpleDateFormat`을 호출마다 만듦 | 839.8 ± 40.7ns |

원문의 `DateUtils`는 `ofPattern`을 호출마다 부릅니다. 상수로 둘 때보다 2.7배 느리고 차이는 호출당 160ns쯤입니다. 초당 만 번을 불러도 1.6ms이므로 포매터는 앞 절의 틀린 결과 수를 기준으로 고릅니다.

## 5. 저장한 순간이 같은 순간으로 읽히는지는 컬럼 타입과 연결 설정에 달려 있습니다

원문의 영어판은 MyBatis 매핑에서 `gmt_create` 컬럼의 Java 타입을 `java.util.Date`에서 `java.time.LocalDateTime`으로 바꾸는 한 줄을 보여 줍니다. 컬럼에 든 값이 순간이라면 그 한 줄을 바꾸는 것만으로는 같은 순간으로 읽힌다고 장담할 수 없고 컬럼 타입과 연결 설정을 함께 봐야 합니다.

순간 하나(`2024-10-07T16:00:00Z`)를 서울 시간대로 띄운 JVM으로 쓰고 UTC로 띄운 JVM으로 읽었습니다. 앱 서버를 한국 시간대의 장비에서 UTC 컨테이너로 옮기는 상황을 흉내 낸 것입니다. MySQL과 PostgreSQL 서버 두 대의 시간대는 UTC입니다.

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

### MySQL은 `TIMESTAMP` 컬럼도 연결 설정이 없으면 어긋납니다

MySQL 문서에 따르면 `TIMESTAMP`는 넣을 때 UTC로 바꾸고 꺼낼 때 되돌리며 `DATETIME`은 바꾸지 않습니다.

> MySQL converts TIMESTAMP values from the current time zone to UTC for storage, and back from UTC to the current time zone for retrieval. (This does not occur for other types such as DATETIME.)

여기서 current time zone은 서버 세션의 시간대입니다. MySQL의 JDBC 드라이버인 Connector/J의 문서에 따르면 `connectionTimeZone`의 기본값은 `LOCAL`이고 이때 드라이버는 연결의 시간대가 JVM의 시간대와 같다고 가정합니다. 그래서 서울 JVM은 서울 시각의 글자 `01:00:00`을 보내고 UTC 세션인 서버는 그 글자를 UTC로 받습니다. 서버에서 `UNIX_TIMESTAMP`로 확인한 `TIMESTAMP` 컬럼의 순간은 실제보다 9시간 뒤였습니다. 쓴 JVM으로 다시 읽으면 같은 가정이 거꾸로 적용되어 맞는 값이 나오므로 이 어긋남은 앱 서버의 시간대를 바꾸기 전에는 드러나지 않습니다.

`connectionTimeZone=UTC`를 주면 드라이버가 순간을 UTC 시각의 글자로 바꿔 보냅니다. Connector/J 8.0.23부터 `serverTimezone`은 이 속성의 별칭입니다.

개발 수첩은 생성 시각과 수정 시각의 컬럼을 `datetime`으로 두고 시간대 정보를 기록하려면 `timestamp`로 두라고 권합니다. MySQL 문서의 설명대로라면 `TIMESTAMP`에 남는 것은 세션 시간대로 받아 UTC로 바꿔 둔 순간이고 시간대 정보는 남지 않습니다.

### MySQL에서 `LocalDateTime`으로 넣은 시각은 실행한 세 연결 설정 모두에서 글자 그대로 남았습니다

MySQL에 `LocalDateTime`을 넣으면 드라이버가 변환하지 않습니다. 서울 시각 `2024-10-08T01:00`은 실행한 세 가지 연결 설정(설정 없음, `connectionTimeZone=UTC`, 여기에 `forceConnectionTimeZoneToSession=true`를 더한 것) 모두에서 그 글자로 저장됐고 어느 JVM에서나 같은 `LocalDateTime`으로 읽혔습니다. 달력의 시각을 저장하려던 것이면 맞는 동작이고 순간을 저장하려던 것이면 시간대가 사라진 값입니다.

### PostgreSQL은 `timestamptz`가 순간이고 `timestamp`가 달력의 시각입니다

PostgreSQL의 JDBC 드라이버(pgjdbc)는 세션의 시간대를 JVM의 시간대로 맞춥니다. 그래서 `timestamptz`에는 `LocalDateTime`, `Timestamp`, `OffsetDateTime` 어느 것으로 넣어도 맞는 순간이 저장됐고 UTC JVM에서 `OffsetDateTime`으로 읽으면 같은 순간이 나왔습니다. `timestamp`에는 쓴 쪽 시간대의 시각 글자가 남았습니다. PostgreSQL 위키의 "Don't Do This"는 `timestamp`를 달력과 시계를 찍은 사진에 견줍니다.

> You can think of it being a picture of a calendar and a clock rather than a point in time.

드라이버 문서에는 `ZonedDateTime`과 `Instant`를 지원하지 않는다고 적혀 있습니다. 순간은 `OffsetDateTime`으로 바꿔서 넣고 읽습니다.

### BE-commerce는 `Instant`, `DATETIME(6)`, UTC 설정 셋을 묶어 씁니다

BE-commerce는 MySQL 8.4를 씁니다. 2026년 10월 7일 커밋 기준으로 운영 코드에서 `Instant`를 쓰는 파일이 136개이고 `LocalDateTime`을 쓰는 파일은 2개입니다. 스키마 파일에는 `DATETIME(6)`이 89번 나오고 `TIMESTAMP`는 없습니다. 연결 주소에는 `serverTimezone=UTC`, Hibernate에는 `hibernate.jdbc.time_zone: UTC`를 줘서 컬럼에 UTC 시각의 글자가 남게 했습니다. 5장 첫머리 표의 셋째 줄(`DATETIME` 컬럼, 연결 설정 `connectionTimeZone=UTC`)에 해당하는 구성입니다.

이 구성에서 한 번 걸린 곳이 드라이버가 돌려주는 타입입니다. 이번 실행에서 `getObject`의 결과는 `DATETIME`이 `LocalDateTime`, `TIMESTAMP`가 `java.sql.Timestamp`였고 `getObject(컬럼, Instant.class)`는 두 컬럼 모두 예외를 던졌습니다. BE-commerce에는 아직 발행하지 못한 이벤트 가운데 가장 오래된 것이 만들어진 뒤 흐른 시간을 내보내는 지표가 있고 이 지표는 `DATETIME` 컬럼의 최솟값을 `Instant.class`로 읽었습니다. 밀린 이벤트가 없으면 최솟값이 `NULL`이라 변환이 일어나지 않아 조회가 성공했고 밀린 이벤트가 있을 때만 변환 예외가 났습니다. 지표는 그때 NaN이 됐고 NaN은 어떤 임계값과 비교해도 참이 되지 않으므로 적체 알림이 울리지 않았습니다. `LocalDateTime`으로 읽어 UTC로 해석하게 고쳤고 경위는 [이슈 #393](https://github.com/dj258255/BE-commerce/issues/393)에 있습니다.

## 6. 나이, 영업일, 한 주의 첫날에는 한국 기준을 따로 넣습니다

한국에서 쓰는 코드라면 나이를 세는 기준일, 공휴일 목록, 한 주가 시작하는 요일을 정해야 합니다. 원문 끝의 `DateUtils`에는 나이, 영업일, 한 주의 첫날을 구하는 메서드가 있고 이 셋을 한국에서 쓸 때의 기준으로 실행했습니다. 나이는 원문의 계산이 만 나이와 같아서 기준일만 인자로 받으면 되고 영업일과 한 주의 첫날에는 기준을 따로 넣어야 합니다. 고친 클래스 전체는 [앞 글](/blog/theory/java-time-five-decisions)의 '시간을 다루는 도구' 절에 있습니다.

### 만 나이는 `Period.between`으로 구하고 기준일은 인자로 받습니다

원문의 `getAge(birthDate)`는 안에서 `LocalDate.now()`를 불러 `Period.between(birthDate, 오늘).getYears()`를 돌려줍니다. 한국에서는 만 나이로 통일하는 민법과 행정기본법 개정이 2023년 6월 28일에 시행됐습니다. 원문의 계산은 생일이 지났는지를 반영하므로 결과가 만 나이입니다. 생일과 기준일을 바꿔 가며 계산했습니다.

| 생일 | 기준일 | `Period.between(생일, 기준일).getYears()` |
|---|---|---|
| 1990-10-08 | 2024-10-07 | 33 |
| 1990-10-08 | 2024-10-08 | 34 |
| 2000-02-29 | 2023-02-28 | 22 |
| 2000-02-29 | 2023-03-01 | 23 |
| 2000-02-29 | 2024-02-29 | 24 |

올해에서 태어난 해를 빼면(`2024 - 1990`) 생일이 지나지 않은 10월 7일에도 34가 나옵니다. 2월 29일에 태어난 사람은 평년에 3월 1일부터 한 살이 올라갑니다. 3월 1일이라는 날짜는 `Period`가 계산한 결과이고 법령이 윤일 생일을 어떻게 세는지는 이 글에서 확인하지 못했습니다. 원문은 기준일을 `LocalDate.now()`로 얻는데 1장에서 본 대로 오늘 날짜는 JVM의 시간대에 따라 달라집니다. 그래서 기준일은 인자로 받습니다.

### 다음 영업일은 공휴일 목록이 있어야 맞습니다

한국의 공휴일에는 음력으로 정해지는 설과 추석, 공휴일이 주말과 겹칠 때 생기는 대체공휴일, 그해에 정해지는 임시공휴일이 있습니다. 원문의 `getNextWorkingDay`는 토요일과 일요일만 건너뜁니다. JDK가 제공하는 달력 체계를 `Chronology.getAvailableChronologies()`로 뽑으면 ISO, Hijrah-umalqura, Japanese, Minguo, ThaiBuddhist 다섯입니다. 한국에서 쓰는 음력이 없어 설과 추석 날짜를 JDK로 계산할 수 없으므로 공휴일은 날짜 목록으로 받습니다.

2025년 10월 2일 목요일의 다음 영업일을 두 방법으로 구했습니다. 그해 10월은 3일 개천절부터 9일 한글날까지 이레가 이어지는 연휴였고 추석 연휴 첫날인 5일이 일요일이었습니다. 이레 가운데 토요일인 4일만 공휴일이 아닙니다. 공휴일은 3일, 5일부터 7일, 5일이 일요일과 겹쳐 생긴 대체공휴일 8일, 9일입니다.

| 계산 | 2025-10-02의 다음 영업일 |
|---|---|
| 주말만 건너뜀(원문) | 2025-10-03(금). 개천절 |
| 주말과 공휴일 목록을 건너뜀 | 2025-10-10(금) |

원문의 계산이 돌려준 3일은 개천절이고 공휴일 목록까지 건너뛰어야 10일이 나옵니다.

공휴일 목록은 공공데이터포털의 한국천문연구원 특일 정보 API로 받을 수 있습니다. 국경일, 공휴일, 기념일, 24절기를 날짜별로 돌려주고 공공기관 휴일 여부가 함께 옵니다. 임시공휴일은 그해에 정해지므로 목록은 배포 없이 고칠 수 있는 설정이나 DB에 둡니다.

### 한 주의 첫날은 한국 로캘에서 일요일이고 집계의 시작 요일은 코드에 적습니다

원문의 `getFirstDayOfWeek`는 주석에 월요일이라고 밝히고 `date.with(DayOfWeek.MONDAY)`를 돌려줍니다. `DayOfWeek`는 월요일에 시작해 일요일에 끝나는 ISO 기준이어서 일요일을 넣으면 엿새 전 월요일이 나옵니다. 로캘이 정한 한 주는 `WeekFields`에 들어 있고 한국 로캘의 첫 요일은 일요일입니다. 두 기준으로 그 주의 첫날과 끝날을 구했습니다.

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

## 실행한 조건과 한계

- JDK는 17.0.7(tzdata 2022g), 21.0.9(2025b), 25.0.1(2025b)이고 Apple Silicon 맥(12코어)의 macOS에서 실행했습니다. 기본 시간대는 Asia/Seoul, 기본 로캘은 ko_KR입니다. tzdata 비교, 포매터 공유, JMH, DB 실험을 뺀 나머지는 세 JDK에서 돌렸습니다. JDK에 따라 달라진 것은 `Instant.now()`가 직전과 같았던 횟수, 예외 메시지의 필드 순서, `WeekFields.of(Locale.CHINA)`의 첫 요일입니다. 포매터 공유, JMH, DB 실험은 JDK 21에서만 돌렸습니다.
- 시계의 최소 간격은 이 맥에서 쟀습니다. 다른 운영체제에서는 다를 수 있습니다. 200만 번 가운데 시각이 거꾸로 간 적은 없었는데 이 결과로 알 수 있는 것은 측정하는 동안 시계 보정이 없었다는 데까지입니다.
- `SimpleDateFormat`의 틀린 결과 수는 실행마다 달라서 세 차례의 범위로 적었습니다. 같은 맥의 1분 부하 평균은 이 글의 실험을 돌린 동안 7.5~11.8이었고 포매터 공유 실험만의 부하는 따로 남기지 않았습니다.
- JMH는 포크 3번에 측정 5회씩(회당 1초)이고 측정하는 동안 같은 맥에서 다른 작업이 돌고 있었습니다(1분 부하 평균 7.5~9.1). parse는 오차 구간이 넓어 결론에 쓰지 않았습니다.
- DB는 MySQL 8.4.11과 Connector/J 9.1.0, PostgreSQL 16.15와 pgjdbc 42.7.4이고 JDK 21.0.9에서 순수 JDBC로 실행했습니다. Hibernate나 MyBatis를 거칠 때 매핑 계층이 더하는 변환은 재지 않았습니다.
- 2025년 10월의 공휴일은 우주항공청의 2025년도 월력요항을 다룬 보도에서 가져왔습니다. 보도에 있는 것은 3일부터 9일까지 이레 연휴라는 것과 추석 연휴 첫날인 5일이 일요일이라는 것이고 8일이 대체공휴일이라는 것은 거기서 계산했습니다. 특일 정보 API는 제공 항목을 문서로 확인했고 직접 호출하지는 않았습니다.
- 회사 사례의 수치는 각 회사가 공개한 글에서 가져왔습니다.

## 참고

앞 글과 원문

- [자바에서 시간을 스마트하게 다루는 방법이란?](/blog/theory/java-time-five-decisions)
- [阿里云开发者社区, 如何才能在Java中优雅的操纵时间？](https://developer.aliyun.com/article/1637802)
- [Alibaba Cloud Community, How Can We Manipulate Time Gracefully in Java?](https://www.alibabacloud.com/blog/how-can-we-manipulate-time-gracefully-in-java_602187)

규약과 사례

- [Alibaba, Java开发手册(黄山版)](https://github.com/alibaba/p3c)
- [Cloudflare, How and why the leap second affected Cloudflare DNS (2017)](https://blog.cloudflare.com/how-and-why-the-leap-second-affected-cloudflare-dns/)
- [Go, Proposal: Monotonic Elapsed Time Measurements in Go](https://go.googlesource.com/proposal/+/master/design/12914-monotonic.md)
- [Microsoft, Summary of Windows Azure Service Disruption on Feb 29th, 2012](https://azure.microsoft.com/en-us/blog/summary-of-windows-azure-service-disruption-on-feb-29th-2012/)
- [GOV.UK, How we fixed a strange 'week year' bug (2021)](https://technology.blog.gov.uk/2021/03/24/how-we-fixed-a-strange-week-year-bug/)
- [Google Error Prone, MisusedWeekYear](https://errorprone.info/bugpattern/MisusedWeekYear)
- [Jon Skeet, Storing UTC is not a silver bullet (2019)](https://codeblog.jonskeet.uk/2019/03/27/storing-utc-is-not-a-silver-bullet/)
- [Abseil, Time Programming](https://abseil.io/docs/cpp/guides/time)

한국 기준

- [법무부, '만 나이' 통일을 위한 민법 및 행정기본법 개정안, 2023년 6월 28일부터 시행](https://moj.go.kr/bbs/moj/189/566088/artclView.do)
- [공공데이터포털, 한국천문연구원 특일 정보](https://www.data.go.kr/data/15012690/openapi.do)
- [YTN, 우주항공청 2025년도 월력요항 발표 (2024-06-20)](https://www.ytn.co.kr/_ln/0103_202406200817450769)

공식 문서

- [Java SE 21, System.nanoTime](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/System.html), [Instant](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/time/Instant.html), [Period](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/time/Period.html), [ZonedDateTime](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/time/ZonedDateTime.html)
- [Java SE 21, DateTimeFormatter](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/time/format/DateTimeFormatter.html), [IsoChronology](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/time/chrono/IsoChronology.html), [SimpleDateFormat](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/text/SimpleDateFormat.html)
- [MySQL 8.4, The DATE, DATETIME, and TIMESTAMP Types](https://dev.mysql.com/doc/refman/8.4/en/datetime.html)
- [MySQL Connector/J, Preserving Time Instants](https://dev.mysql.com/doc/connector-j/en/connector-j-time-instants.html)
- [MySQL Connector/J, Datetime types processing](https://dev.mysql.com/doc/connector-j/en/connector-j-connp-props-datetime-types-processing.html)
- [PostgreSQL 16, Date/Time Types](https://www.postgresql.org/docs/16/datatype-datetime.html), [PostgreSQL Wiki, Don't Do This](https://wiki.postgresql.org/wiki/Don%27t_Do_This)
- [PostgreSQL JDBC, Using Java 8 Date and Time classes](https://jdbc.postgresql.org/documentation/query/)
- [Java SE 21, WeekFields](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/time/temporal/WeekFields.html)

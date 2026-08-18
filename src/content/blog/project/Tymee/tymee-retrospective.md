---
title: '타이미 개발기: 1인 프로젝트의 기술 결정 15가지'
description: 게이미피케이션 집중 타이머 앱 타이미를 3개월간 혼자 만들면서 내린 기술 결정 15가지를 시간순으로 정리했습니다. 아키텍처 선택부터 모바일 OAuth, Spring Boot 4 API 버전 관리 충돌까지 담았습니다.
date: 2026-02-10
tags:
  - Side Project
  - Spring Boot
  - Architecture
  - Multi-Module
  - JWT
  - OAuth
  - Spring Security
  - MySQL
  - Redis
  - Flyway
  - MapStruct
  - Code Quality
  - Spring Boot 4
  - Retrospective
category: personal/Tymee
coverImage: /uploads/project/Tymee/retrospective/title.svg
draft: false
series: "Tymee"
seriesOrder: 1
---

타이미(Tymee)는 게이미피케이션 기반 집중력 타이머 서비스입니다. 기획부터 디자인, 백엔드, 앱까지 혼자 만들고 있습니다.

2025년 11월부터 2026년 2월까지 개발하면서 내린 기술 결정을 편마다 나눠 기록해왔는데, 흩어져 있으니 앞뒤 맥락이 끊겼습니다. 아키텍처를 그렇게 고른 이유가 나중에 이벤트 기반으로 모듈을 분리한 이유와 이어지는데, 글이 따로 있으면 그 연결이 보이지 않습니다. 그래서 15편을 하나로 합쳤습니다.

각 장은 원래 글의 내용을 그대로 담고 있고, 장 머리에 원문 발행일을 남겨 개발 순서를 알 수 있게 했습니다. 순서대로 읽으면 3개월간의 개발 기록이 되고, 목차에서 필요한 장만 골라 읽어도 됩니다.

**기간**: 2025.11 ~ 진행 중
**형태**: 개인 프로젝트
**기술 스택**: Spring Boot 4, Java 25, MySQL, Redis, Cloudflare R2, React Native, GitHub Actions, Linear

![타이미 집중 타이머](/uploads/project/Tymee/retrospective/focus-timer.png)

---

## 1. 집중을 게임처럼 만들기로 한 이유

*원문 발행일 2025-11-01*

친구가 공부할 때마다 탁상시계 앱을 켜두는 습관이 있었습니다. 스마트폰을 시계처럼 세워두고 시간이 흘러가는 걸 보면서 집중한다고 했습니다. 처음엔 독특한 습관이라고만 생각했는데, 예전에 본 뉴스 하나가 떠올랐습니다.

청소년이 공부보다 게임에 빠지는 이유가 피드백 속도의 차이에 있다는 내용이었습니다. 게임은 버튼을 누르는 순간 캐릭터가 움직이고 점수가 오르고 효과음이 울립니다. 입력한 즉시 결과가 눈앞에 나타납니다. 공부는 다릅니다. 오늘 세 시간을 투자해도 당장 달라지는 것이 없고, 성적이 오르려면 몇 주에서 몇 달이 걸립니다. 그 사이에 동기는 자연스럽게 사라집니다.

여기에 하나를 더 얹었습니다. 사람에게는 자기 성취를 보여주고 싶은 욕구가 있습니다. 게임의 랭킹과 업적 배지가 효과적인 이유도, 운동 인증샷과 독서 기록을 SNS에 올리는 이유도 같다고 봤습니다.

이 둘을 합치면 어떨까 싶었습니다. 집중한 시간이 실시간으로 눈에 보여서 바로 성취감을 느끼고, 그 기록을 남들과 비교하며 동기를 얻는 구조입니다. 단순한 타이머를 넘어 집중 자체를 게임처럼 만드는 것이 타이미의 컨셉입니다.

---

## 2. 1인 프로젝트의 아키텍처 선택

*원문 발행일 2025-11-05*

### 당연히 레이어드로 시작했다

처음에는 고민할 것도 없었습니다. 레이어드 아키텍처는 단순하고 익숙하고 빠릅니다.

```
Controller -> Service -> Repository -> Database
```

Spring Boot로 만드는 대부분의 프로젝트가 이 구조이고, 튜토리얼도 실무도 이렇습니다.

### 헥사고날을 검토하고 버린 이유

그런데 국내 기술 블로그를 보면 헥사고날 아키텍처 이야기가 자주 나옵니다. 카카오뱅크, 카카오페이, 우아한형제들 모두 포트와 어댑터를 언급합니다.

![hexagonal-architecture](/uploads/architecture-selection/hexagonal-architecture.png)

핵심은 비즈니스 로직을 외부 세계로부터 격리하는 것입니다. UI도 Database도 외부 요소로 취급합니다. 기술을 교체하기 쉽고 Port 인터페이스만 모킹하면 테스트도 간단합니다. 카카오뱅크 메시지 허브 팀은 이 구조로 여러 서버와 인프라 연결을 유연하게 구성했다고 합니다.

문제는 파일 수입니다. 로그인 기능 하나에 헥사고날은 UseCase 인터페이스와 구현, Port 두 개, Adapter 두 개, 컨트롤러와 DTO까지 열 개가 넘게 필요합니다. 레이어드로는 컨트롤러, 서비스, JwtUtil, Repository, 도메인, DTO로 대여섯 개면 됩니다. 두 배 차이가 1인 프로젝트에서는 치명적입니다.

결정적이었던 건 카카오페이 사례입니다. 홈 서비스팀은 헥사고날을 적용했다가 걷어냈습니다.

> "이미 연동 인터페이스가 외부 변화를 막아주는 훌륭한 방파제 역할을 하고 있었기 때문에 헥사고날 아키텍처의 핵심인 '도메인 로직 보호'라는 장점이 퇴색될 수밖에 없었습니다."

PR 기준으로 8000줄 이상의 코드가 줄었다고 합니다.

헥사고날이 빛나는 상황은 gRPC와 REST와 WebSocket을 동시에 지원하거나, 저장소 교체가 잦거나, 대규모 팀이 협업할 때입니다. 이 프로젝트는 HTTP와 WebSocket 정도만 쓰고 저장소를 바꿀 일도 없으며 혼자 만듭니다. 오버엔지니어링이 분명했습니다.

### 최종 선택: 도메인 기반 멀티모듈 + 레이어드

```
backend/
├── auth/       # 인증 도메인
├── user/       # 사용자 도메인
├── upload/     # 파일 업로드 도메인
├── core/       # 공통 유틸, 예외 처리
└── bootstrap/  # 앱 실행
```

모듈 안은 controller, service, repository, entity, domain, dto로 나눈 기술 기반 패키지입니다.

![dependency-direction](/uploads/architecture-selection/dependency-direction.png)

헥사고날은 버렸지만 멀티모듈은 유지했습니다. 도메인 경계가 코드에 드러나서 "로그인 버그"라고 하면 auth 모듈만 보면 되고, 모듈마다 필요한 의존성만 가지므로 upload에 Redis가 딸려오지 않습니다. 나중에 특정 모듈만 떼어낼 여지도 남습니다. 실제로 [12장](#12-고아-파일-정리-시스템)에서 User와 Upload 사이의 순환 의존성을 Core 모듈 경유 이벤트로 끊을 때 이 구조가 값을 했습니다.

DDD도 필요한 것만 가져왔습니다. 엔티티와 값 객체를 구분하고, 도메인 모델에 비즈니스 로직을 두고, 다른 애그리거트는 ID로 참조합니다. 반대로 유비쿼터스 언어는 혼자 하는 프로젝트에서 의미가 없고 Port/Adapter는 오버엔지니어링, CQRS는 복잡도 대비 이점이 적어서 쓰지 않았습니다.

정리하면 도메인별 모듈 분리, Entity와 VO 구분, 도메인 모델에 로직 배치, ID 참조로 느슨한 결합까지는 가져가고 그 위의 추상화는 버렸습니다. 출시가 먼저고 리팩토링은 나중입니다.

---

## 3. Gradle 멀티모듈 의존성 관리

*원문 발행일 2025-11-09*

모듈을 나누고 나니 의존성 버전을 하드코딩한 것이 걸렸습니다. 보안 이슈가 터졌을 때 빠르게 올릴 수 있어야 하는데, 버전이 여러 파일에 흩어져 있으면 그게 안 됩니다.

모듈마다 다른 버전을 쓰면 런타임에 `NoSuchMethodError`가 나거나 같은 코드가 모듈마다 다르게 동작하고, 취약한 버전이 일부 모듈에 남습니다. 그렇다고 중앙화를 너무 강하게 하면 한 모듈의 업그레이드가 전체에 영향을 주고 특정 모듈만 새 버전을 시험해보기 어려워집니다.

다섯 가지를 놓고 봤습니다.

버전을 직접 명시하는 방식은 빌드 스크립트만 보면 모든 정보가 보이지만 모듈이 늘어나면 전체 업그레이드에 모든 파일을 고쳐야 합니다. `ext` 변수는 한 곳에서 정의할 수 있어 낫지만 IDE 자동완성이 약하고 타입 안전성이 없어 오타를 잡지 못합니다.

Spring BOM만 쓰면 Spring 생태계 안의 호환성은 BOM이 보장해주고 버전 명시 없이 깔끔하게 선언됩니다. 다만 Flyway나 jjwt처럼 BOM 밖의 라이브러리는 따로 관리해야 합니다.

Gradle Version Catalog만 쓰면 IDE 자동완성이 완벽하고 오타가 컴파일 에러로 잡히며 Dependabot 같은 도구도 붙습니다. 대신 `spring-boot-starter-web`이 의존하는 `spring-core` 버전 같은 Spring 내부 호환성을 직접 맞춰야 합니다.

그래서 둘을 같이 씁니다. Spring 호환성은 BOM이 보장하고, Flyway나 jjwt 같은 외부 라이브러리는 Version Catalog로 중앙 관리합니다. 두 시스템을 모두 알아야 하고 어떤 라이브러리가 어디서 관리되는지 구분해야 하지만, Spring 기반 멀티모듈에서는 이 조합이 가장 실용적이었습니다.

```
backend/
├── gradle/libs.versions.toml  <- 한 곳에서 버전 정의
├── core/build.gradle.kts      <- libs.xxx 사용
├── user/build.gradle.kts      <- libs.xxx 사용 (동일 버전 보장)
└── bootstrap/build.gradle.kts <- libs.xxx 사용 (동일 버전 보장)
```

단일 모듈이거나 빠르게 시작해야 하면 직접 명시나 BOM만으로 충분하고, 비-Spring 프로젝트나 외부 라이브러리가 많으면 Version Catalog만 써도 됩니다. 도구는 문제를 풀려고 있는 것이지 갖춰야 할 격식이 아닙니다.

---

## 4. 설정 파일을 yml로 바꾼 이유

*원문 발행일 2025-11-13*

멀티모듈 구조에 local, test, staging, prod 네 개 프로필을 관리해야 했습니다. Spring Boot 프로젝트를 만들면 `application.properties`가 기본으로 생기는데 yml로 바꿔 썼습니다.

properties는 키와 값의 평면 구조라 단순하지만 설정이 많아지면 접두사가 계속 반복됩니다. yml은 계층 구조라 복잡한 설정도 한눈에 들어오고, 무엇보다 파일 하나 안에서 `---`로 프로필을 나눌 수 있습니다. properties로 하면 `application-local.properties`처럼 파일을 네 개 이상 만들어야 합니다.

![yml-profile-separation](/uploads/project/Tymee/spring-boot-config/yml-profile-separation.svg)

Spring Boot가 properties를 기본으로 만드는 건 그게 더 나아서가 아니라 Java 표준이고 하위 호환성 때문입니다. YAML 지원이 추가되기 전부터 properties가 기본이었고, 두 파일이 함께 있으면 properties가 우선합니다. 요즘 프로젝트는 대부분 yml을 쓰므로 생성 직후에 바꾸면 됩니다.

---

## 5. 예외 처리 설계

*원문 발행일 2025-11-17*

### 검토한 방법들

Spring에서 예외를 처리하는 방법은 여러 갈래입니다. `@ResponseStatus`는 간단하지만 `sendError()`로 HTML 에러 페이지가 나가서 REST API에 맞지 않습니다. `ResponseStatusException`은 프로토타이핑에는 빠른데 여러 컨트롤러에서 같은 코드가 반복되고 Service 레이어에서 던지기 애매합니다. 컨트롤러 레벨 `@ExceptionHandler`는 재사용이 안 됩니다.

외부 라이브러리도 봤습니다. Zalando Problem은 RFC 9457을 완벽히 지원하고 기본 핸들러를 스무 개 넘게 주지만 1인 프로젝트에는 과합니다. Vavr의 Either는 에러를 값으로 다루는 방식이라 명시적이지만 러닝 커브가 있고 Spring 생태계와 잘 맞지 않습니다.

결국 Spring 기본 기능인 `@RestControllerAdvice`에 커스텀 예외를 얹었습니다. 외부 의존성이 없고, Spring을 쓰는 사람이면 누구나 아는 패턴이며, 나중에 RFC 9457로 옮길 여지도 남습니다.

### 알게 된 동작 원리

예외가 발생하면 `HandlerExceptionResolverComposite`가 Resolver를 순서대로 실행합니다. `@ExceptionHandler`를 처리하는 `ExceptionHandlerExceptionResolver`가 가장 먼저이고, 그다음 `@ResponseStatus`, 마지막이 Spring 내장 예외를 상태 코드로 바꾸는 `DefaultHandlerExceptionResolver`입니다. 핸들러가 여러 개면 컨트롤러 내부 `@ExceptionHandler`가 `@ControllerAdvice`보다 우선합니다.

매칭은 정확히 일치하는 핸들러를 먼저 찾고, 없으면 상위 클래스로 거슬러 올라가며 가장 구체적인 것을 고릅니다.

한 가지 함정이 있습니다. `@ControllerAdvice`는 DispatcherServlet 이후에만 동작합니다. JWT 인증 필터처럼 Filter에서 터진 예외는 잡히지 않습니다.

![filter-exception-scope](/uploads/project/Tymee/exception-handling-design/filter-exception-scope.png)

Filter에서는 직접 try-catch로 에러 응답을 쓰거나 `/error`로 포워딩해서 `BasicErrorController`가 처리하게 해야 합니다.

### 왜 커스텀 에러 코드가 필요했나

HTTP 상태 코드만으로는 부족합니다. 같은 404여도 사용자가 없는 건지, 파일이 없는 건지, 게시글이 없는 건지 클라이언트가 알 수 없습니다.

그래서 도메인 접두사와 순번으로 코드를 붙였습니다. C는 공통, A는 인증, U는 사용자, F는 파일입니다.

| 코드 | HTTP | 설명 |
|------|------|------|
| C001 | 400 | 잘못된 입력값 |
| A002 | 401 | 토큰 만료 |
| A003 | 401 | 유효하지 않은 토큰 |
| U002 | 409 | 이메일 중복 |
| F002 | 400 | 파일 크기 초과 |

이러면 클라이언트가 코드로 분기할 수 있습니다. `A002`면 리프레시 토큰으로 재발급을 시도하고 `A003`이면 로그인 화면으로 보내는 식입니다. 상태 코드만으로는 이런 구분이 어렵습니다. 에러 코드를 키로 두면 다국어 메시지 매핑도 자연스럽게 붙습니다.

예외 클래스는 `RuntimeException` 아래에 `BusinessException`을 두고, 404 전용으로 `EntityNotFoundException`을 뒀습니다. 새 도메인이 생기면 `ErrorCode` enum에 상수를 추가하고 `BusinessException`을 던지면 됩니다. `GlobalExceptionHandler`는 손대지 않아도 상속 관계로 잡힙니다.

응답 포맷은 성공과 실패 모두 같은 껍데기를 씁니다.

```json
{
  "success": false,
  "error": {
    "code": "U002",
    "message": "이미 사용 중인 이메일입니다"
  },
  "timestamp": "2025-12-15T10:30:00"
}
```

프로덕션에서는 스택 트레이스나 파일 경로를 그대로 내보내지 않습니다. 상세 정보는 로그에 남기고 클라이언트에는 일반적인 메시지만 보냅니다.

---

## 6. Snowflake ID 도입

*원문 발행일 2025-11-21*

파일 업로드 API를 만들면서 ID를 어떻게 할지 정해야 했습니다. 결론은 내부 PK는 Auto Increment, 외부 노출용은 Snowflake ID로 분리하는 것이었습니다.

### 왜 ID를 두 개로 분리하나

API 응답에 `"uploadId": 1`, `"uploadId": 2` 같은 순차 ID가 내려가면 공격자가 숫자를 하나씩 올려가며 다른 사용자의 파일을 건드려볼 수 있습니다. 권한 체크가 있으니 실제로 삭제되지는 않지만, 전체 파일 수나 생성 속도 같은 정보가 그대로 새어 나갑니다.

업로드에 먼저 적용한 이유는 Presigned URL 흐름 때문입니다. 클라이언트가 URL을 요청하면 서버가 메타데이터를 먼저 저장하고 그 ID를 R2 경로에 넣는데, Auto Increment PK를 그대로 쓰면 `profiles/1/image.jpg` 같은 예측 가능한 경로가 외부에 노출됩니다. 게시글이나 댓글은 일반적인 CRUD라 지금은 Auto Increment PK를 그대로 쓰고, 필요해지면 public ID 컬럼을 추가할 생각입니다.

```java
@Entity
public class Upload {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;           // 내부용 (4~8바이트)

    @Column(unique = true)
    private Long publicId;     // 외부 노출용 (8바이트)
}
```

### UUID를 PK로 쓰지 않은 이유

UUID를 바이너리로 저장해도 16바이트입니다. Auto Increment BIGINT는 8바이트, INT는 4바이트입니다. 이 차이가 두 군데서 문제가 됩니다.

하나는 인덱스 페이지 효율입니다. InnoDB 인덱스 페이지는 기본 16KB인데, PK가 작을수록 한 페이지에 더 많은 레코드가 들어갑니다. InnoDB는 세컨더리 인덱스에 PK를 포인터로 저장하므로 PK가 크면 모든 인덱스가 같이 부풀어 오릅니다.

다른 하나는 페이지 스플릿입니다. UUID v4는 완전 랜덤이라 INSERT가 B-Tree 아무 데나 끼어듭니다.

> "InnoDB will fill the pages to about 94% before creating a new page. When the primary key is random, the amount of space utilized from each page can be as low as 50%."
>
> — [Percona](https://www.percona.com/blog/uuids-are-popular-but-bad-for-performance-lets-discuss/)

순차 PK는 페이지를 94%까지 채우는데 랜덤 UUID는 50%밖에 못 채웁니다.

Auto Increment만 쓰는 것도 답이 아닙니다. 분산 환경에서 서버마다 같은 값을 만들면 충돌하고, ID 생성을 DB 한 곳으로 모으면 그 DB가 병목이 됩니다. 값을 할당할 때 락도 걸립니다.

### 왜 Snowflake인가

Twitter가 2010년에 공개한 분산 ID 생성 방식입니다.

```
[1비트 부호] [41비트 타임스탬프] [10비트 머신ID] [12비트 시퀀스]
```

8바이트라 MySQL BIGINT에 그대로 들어가고, 타임스탬프가 상위 비트에 있어 대략 시간순으로 증가하므로 B-Tree 입장에서는 거의 순차 삽입입니다. 애플리케이션에서 생성하니 DB 락 경합도 없습니다.

단점은 시계 동기화입니다. 서버 간 시계가 어긋나면 순서가 꼬이거나 중복이 날 수 있어 NTP 동기화가 필수이고, 시계가 뒤로 가면 예외를 던지게 해뒀습니다.

```java
if (currentTimestamp < lastTimestamp) {
    throw new IllegalStateException("Clock moved backwards");
}
```

UUID v7도 후보였습니다. 2024년 RFC 9562로 표준화됐고 타임스탬프 기반이라 시간순 정렬이 되며 시계 동기화에 덜 민감합니다. 다만 16바이트로 Snowflake의 두 배입니다. 기존 UUID 인프라가 있거나 PostgreSQL처럼 UUID 타입 지원이 좋은 환경이면 UUID v7이 나을 수 있습니다.

Instagram은 Twitter Snowflake를 검토했다가 별도 ID 서비스를 운영하는 부담 때문에 PostgreSQL 안에서 41비트 타임스탬프, 13비트 샤드 ID, 10비트 시퀀스로 직접 구현했습니다. Discord는 42비트 타임스탬프에 워커와 프로세스 ID를 5비트씩 두고, JavaScript Number가 53비트까지만 정밀해서 API에서 ID를 문자열로 반환합니다.

![snowflake-id-implementation](/uploads/project/Tymee/snowflake-id/snowflake-id-implementation.png)

구현에서는 같은 밀리초에 여러 스레드가 들어와도 시퀀스로 구분되도록 `synchronized`를 걸고, 머신 ID는 MAC 주소 해시로 자동 생성했습니다.

### 정리

싱글 서버 내부 시스템이면 Auto Increment로 충분하고, 외부 노출이 필요한 MySQL 환경이면 Snowflake, 기존 UUID 인프라가 있으면 UUID v7이 무난합니다. 이 프로젝트는 모바일 앱 전용 API라 UUID 호환이 필요 없어서 내부 PK는 Auto Increment로 두고 외부 노출용만 Snowflake로 분리했습니다.

MySQL을 고른 이유도 여기에 걸립니다. 타이머 기록과 랭킹 조회가 주라 Read-heavy이고 복잡한 JOIN보다 단순 CRUD가 대부분입니다. Oracle Cloud Free Tier의 ARM 인스턴스에 직접 설치해 비용 없이 운영할 수 있고, Snowflake ID가 Long이라 BIGINT에 그대로 맞는 것도 이유였습니다.

---

## 7. Flyway로 DB 형상 관리

*원문 발행일 2025-11-25*

JPA의 `ddl-auto=update`는 개발 초기에 편합니다. 엔티티만 고치면 스키마가 따라옵니다. 문제는 그 편함이 무엇을 안 하는지에 있습니다. 컬럼 이름을 바꾸면 기존 컬럼은 그대로 두고 새 컬럼만 추가하고, 컬럼을 지워도 DB에서는 절대 지우지 않으며, NOT NULL을 걸면 기존 데이터가 NULL일 때 그냥 실패합니다.

개발 환경에서는 DB를 날리면 그만이지만 운영에서는 장애가 됩니다.

그렇다고 항상 마이그레이션 도구가 답은 아닙니다. 프로토타이핑 단계에서는 오히려 오버헤드이고, 스키마가 자주 흔들리는 초기 개발에서도 부담입니다. 베타 테스트부터 권장되고 운영에서는 필수라고 봤습니다.

Flyway와 Liquibase 중에서는 Flyway를 골랐습니다. SQL 파일만 쓰면 되고 Spring Boot가 auto-configuration을 주기 때문에 배울 게 적습니다. Liquibase는 XML이나 YAML로 DB 독립적인 마이그레이션을 쓸 수 있고 무료 롤백도 있지만, 단일 DB만 쓰고 롤백보다 새 마이그레이션으로 고치는 쪽을 선호해서 필요하지 않았습니다.

버전 번호는 `V1__`, `V2__` 같은 순차 방식으로 갑니다. 타임스탬프 방식이 브랜치 충돌에 강하지만 혼자 개발하니 충돌이 없습니다. 팀 협업으로 바뀌면 그때 옮길 생각입니다.

### 체크섬 오류에 대응하는 법

Flyway는 적용된 마이그레이션 파일의 해시를 기록해두고, 파일이 바뀌면 실행을 멈춥니다. "적용된 마이그레이션은 불변"이라는 원칙을 강제하는 것입니다.

```
Migration checksum mismatch for migration version 1
-> Applied to database : 1884708740
-> Resolved locally    : -1560729926
```

상황에 따라 대응이 다릅니다. 공백이나 줄바꿈만 바뀌었다면 `./gradlew flywayRepair`로 기록을 현재 파일에 맞추면 됩니다. SQL이 실제로 바뀌었다면 체크섬을 강제로 덮어쓰지 말고 새 마이그레이션 파일로 고치는 쪽이 안전합니다. 마이그레이션이 실패한 채로 남아 있다면 기록을 지우기 전에 DB가 부분적으로 변경되지는 않았는지 먼저 확인해야 합니다.

### 환경별로 다르게 설정했다

| 환경 | ddl-auto | Flyway | 이유 |
|------|----------|--------|------|
| 로컬 | update | enabled | 빠른 개발과 마이그레이션 테스트 |
| 테스트 | create-drop | disabled | 매 테스트마다 깨끗한 스키마 |
| 스테이징 | validate | enabled | 운영과 동일하게, 불일치 감지 |
| 프로덕션 | none | enabled | JPA는 스키마를 건드리지 않음 |

로컬에서 `ddl-auto=update`와 Flyway를 같이 켜두면 Flyway가 먼저 스키마를 만들고 JPA가 엔티티와 비교해 차이를 메웁니다. 마이그레이션을 빠뜨려도 개발이 막히지 않는다는 장점이 있지만, 반대로 마이그레이션 없이 스키마가 바뀔 수 있다는 위험도 같이 옵니다. 스테이징부터 `validate`로 조여서 이걸 걸러냅니다.

---

## 8. 코드 품질 파이프라인 구축

*원문 발행일 2025-11-29*

### 왜 SonarQube를 안 썼나

올인원 도구인 SonarQube가 먼저 떠올랐지만 쓰지 못했습니다. SonarCloud는 private 레포에서 유료이고, 셀프호스팅은 4GB 이상 RAM이 필요합니다. 1인 개발에 private 레포라 개별 도구를 조합해 비용 없이 구성했습니다.

### 도구별 역할

Spotless는 Google Java Format을 Gradle 빌드에 통합해 포맷팅을 강제합니다. IDE 포맷터나 EditorConfig만으로는 import 순서나 중괄호 위치 같은 Java 고유 규칙까지 통일하기 어렵습니다. CI에서 `spotlessCheck`로 검증하고 로컬에서는 `spotlessApply` 한 번이면 고쳐집니다.

Checkstyle은 코딩 컨벤션을 봅니다. 네이밍, import, 블록 규칙에 메서드 길이 50줄, 파라미터 7개 제한을 걸었습니다. DTO와 Entity, Config, Test는 구조상 필드가 많거나 설정이 길 수밖에 없어 suppressions로 완화했습니다. PMD도 검토했지만 SpotBugs가 역할을 상당 부분 대체해서 뺐습니다.

star import를 막은 이유는 세 가지입니다. `java.util.Date`와 `java.sql.Date`처럼 이름이 겹칠 때 어느 패키지인지 모호해지고, 코드만 봐서는 무엇을 실제로 쓰는지 알 수 없으며, 라이브러리 새 버전에서 추가된 클래스가 기존 이름과 충돌할 수 있습니다.

![star-import-problem](/uploads/project/Tymee/code-quality-management/star-import-problem.svg)

SpotBugs는 바이트코드를 분석해서 소스만 봐서는 찾기 어려운 NPE 가능성, 리소스 누수, 동시성 문제를 잡습니다. FindBugs가 2015년에 멈춰서 후속인 SpotBugs를 골랐고, Error Prone도 봤지만 Gradle 설정이 복잡했습니다. DTO와 Entity의 getter가 가변 객체를 반환하는 `EI_EXPOSE_REP` 경고는 의도된 동작이라 제외했습니다.

JaCoCo는 커버리지를 재고 기준 미달이면 빌드를 세웁니다. 라인 60%, 브랜치 70%로 잡았습니다. 40% 아래는 테스트가 거의 없는 상태이고 60%면 핵심 비즈니스 로직은 덮인 상태라 초기 프로젝트에 현실적입니다. 100%는 getter까지 테스트해야 해서 투자 대비 효과가 낮습니다.

Codecov는 커버리지를 PR에서 바로 보여줍니다. Coveralls도 무료지만 커버리지가 올랐는지 내렸는지만 알려줘서 숫자 게임처럼 느껴집니다.

![codecov-vs-coveralls](/uploads/project/Tymee/code-quality-management/codecov-vs-coveralls.png)

Codecov는 비율이 아니라 정확한 줄 수로 표시하고, 패치 안의 커버리지와 패치 밖에서 바뀐 커버리지를 나눠서 보여줍니다. 모노레포에서 `codecov.yml`을 루트에 둬야 인식된다는 것은 한참 헤매고 알았습니다. `backend/` 아래에 두면 조용히 무시됩니다.

![ci-pipeline](/uploads/project/Tymee/code-quality-management/ci-pipeline.png)

CI는 품질 검사를 앞에 두고 빌드를 뒤에 뒀습니다. 빠르게 실패시켜 빌드 시간을 아끼고 어느 단계에서 깨졌는지 바로 알기 위해서입니다.

### Java 25에서 걸린 버전 문제

Java 25 LTS와 Spring Boot 4를 쓰면서 도구 버전을 전부 올려야 했습니다. 기존 버전은 Java 22까지만 지원해서 조용히 실패하거나 분석을 건너뜁니다.

| 도구 | 버전 | 비고 |
|-----|------|------|
| Checkstyle | 12.3.0 | 10.x는 Java 22까지만 지원 |
| SpotBugs Plugin | 6.4.8 | 6.0.x는 Java 25 미지원 |
| JaCoCo | 0.8.14 | 0.8.12는 Java 22까지만 지원 |

### 실제로 뭘 잡아줬나

Spotless를 넣고 나서 PR 리뷰의 포맷팅 지적이 0건이 됐습니다. Checkstyle은 star import 3건과 미사용 import 5건 이상을 CI에서 막았습니다. SpotBugs는 DTO의 가변 객체 반환 경고로 방어적 복사가 필요한 지점을 짚어줬습니다. JaCoCo는 42%에서 시작한 커버리지를 60% 위로 끌어올리는 기준선이 됐습니다.

핵심은 버그를 몇 개 잡았느냐가 아니라, 리뷰에서 기계적으로 지적하던 것들을 자동화해서 로직에만 집중할 수 있게 된 것입니다.

---

## 9. @CurrentUser 커스텀 어노테이션

*원문 발행일 2025-12-03*

Spring Security로 JWT 인증을 붙이면서 로그인한 사용자 정보를 컨트롤러에서 어떻게 꺼낼지 정해야 했습니다.

`SecurityContextHolder`에서 직접 꺼내는 건 가장 원시적입니다. 매번 같은 코드를 쓰고 null 체크도 직접 해야 하며 테스트도 까다롭습니다. 컨트롤러 파라미터로 `Principal`을 받는 방법은 Java 표준 인터페이스라 `getName()`밖에 없어서 userId나 role을 쓸 수 없습니다. `@AuthenticationPrincipal`은 커스텀 로그인 객체를 바로 주입받을 수 있어 가장 편합니다.

셋 다 내부적으로는 같은 일을 합니다.

```java
SecurityContextHolder.getContext().getAuthentication().getPrincipal();
```

그런데 `@AuthenticationPrincipal`을 그대로 쓰면 모든 컨트롤러에 Spring Security import가 따라 들어갑니다. 그래서 이걸 메타 어노테이션으로 감싼 `@CurrentUser`를 만들었습니다. 의존성이 어노테이션 파일 하나에만 모이고, 나중에 Principal 구조가 바뀌어도 한 곳만 고치면 됩니다. Spring Security 공식 문서도 이 방식을 권합니다.

![jwt-auth-flow](/uploads/project/Tymee/current-user-annotation/jwt-auth-flow.png)

JwtAuthenticationFilter가 토큰에서 claim을 파싱해 `UserPrincipal`을 만들고 `SecurityContextHolder`에 넣습니다. 여기서 DB 조회는 없습니다. 토큰 파싱은 CPU 연산뿐이라 1밀리초 아래에서 끝납니다. 세션 방식이라면 매 요청마다 Redis나 DB를 봐야 합니다.

주의할 점은 NPE입니다. 인증이 필요 없는 API에서 `@CurrentUser`를 쓰면 null이 들어옵니다.

```java
@GetMapping("/{id}")
@PreAuthorize("isAuthenticated()")  // 인증 안 되면 여기서 막힘
public ApiResponse<UserResponse> getUser(
        @CurrentUser UserPrincipal currentUser,  // null 아님 보장
        @PathVariable Long id) {
    // ...
}
```

`@PreAuthorize`가 인증 안 된 요청을 먼저 막고 `@CurrentUser`가 principal을 주입하므로, 인증 필수 API에는 둘을 같이 붙였습니다. 로그인 여부에 따라 응답이 달라지는 선택적 인증 API가 필요하면 커스텀 ArgumentResolver로 null을 다뤄야 하는데, 이 프로젝트는 모바일 앱 전용이라 대부분 인증 필수여서 만들지 않았습니다.

---

## 10. MapStruct로 레이어 간 변환

*원문 발행일 2025-12-07*

### 왜 MapStruct를 쓰나

이 프로젝트는 레이어마다 객체 특성이 다릅니다. Domain과 DTO는 불변이고, Entity는 JPA가 dirty checking을 하려면 가변이어야 합니다. 그래서 저장할 때는 Request DTO에서 Domain을 거쳐 Entity로, 조회할 때는 반대 방향으로 계속 변환이 일어납니다.

![manual-mapping-problem](/uploads/project/Tymee/mapstruct-usage/manual-mapping-problem.png)

수동 변환의 문제는 필드 순서를 틀리거나 하나를 빠뜨려도 컴파일 에러가 나지 않는다는 것입니다. 런타임에 엉뚱한 값이 들어가고, 그제서야 알게 됩니다. MapStruct는 컴파일 타임에 매핑 코드를 생성하므로 이런 실수가 빌드에서 걸립니다.

부분 업데이트도 이유였습니다. 설정 변경 API는 보통 전체가 아니라 일부만 바꿉니다.

```json
{ "pushEnabled": false }  // 푸시만 끄고 나머지는 유지
```

null인 필드는 무시하고 기존 값을 유지해야 하는데, 이걸 수동으로 처리하면 필드 수만큼 if 문이 쌓입니다.

### 어디에 쓰고 어디에 안 쓰나

| 모듈 | MapStruct | 이유 |
|------|-----------|------|
| user | O | 필드 많고 VO 변환 많음, PATCH 지원 |
| upload | X | 필드 10개 미만, 추가 파라미터 필요 |
| auth | X | DTO 변환 거의 없음 |
| core | X | 유틸과 설정만 있음 |

user 도메인은 `Email`, `Nickname`, `Tier`, `UserStatus` 같은 VO를 많이 씁니다. DTO로 변환할 때마다 `.value()`나 `.name()`을 호출해야 하는데 필드가 많아지면 손으로 하기 번거롭습니다. UserSettings는 더합니다. 푸시 알림, 개인정보, 플래너 설정으로 20개가 넘는 필드가 있고 부분 업데이트까지 지원해야 해서, 수동으로 짜면 100줄을 넘깁니다.

반대로 upload는 쓰지 않았습니다. `url`과 `thumbnailUrl`은 도메인 객체에 없고 R2StorageService에서 만든 값을 따로 넘겨야 하는데, MapStruct는 객체 대 객체 변환에 최적화되어 있어 이런 경우가 어색합니다. 필드도 10개가 안 되고 VO도 없어서 `from()` 메서드 몇 줄이면 끝납니다.

결국 기준은 보일러플레이트가 얼마나 줄어드느냐입니다. 필드가 10개를 넘고 VO 변환이 잦고 PATCH가 있으면 MapStruct가, 필드가 적고 단순하면 수동이 낫습니다.

### 성능은 문제가 아니었다

불변 객체를 계속 새로 만드는 게 느리지 않을까 걱정했는데, 확인해보니 고민할 지점이 아니었습니다. JVM의 단기 객체 생성 비용은 약 3.6나노초이고, API 요청 하나가 수십에서 수백 밀리초 걸리는 상황에서는 체감되지 않습니다. Escape Analysis로 힙 대신 스택에 할당되거나 아예 객체가 만들어지지 않는 경우도 있습니다.

MapStruct 자체도 빠릅니다. 컴파일 타임에 코드를 생성하기 때문입니다.

| 프레임워크 | 처리량 (ops/sec) |
|------------|------------------|
| MapStruct | 28,039,597 |
| 수동 매핑 | 26,978,437 |
| Orika | 4,565,378 |
| ModelMapper | 184,304 |
| Dozer | 89,860 |

수동 매핑과 사실상 동등합니다. 반면 Dozer나 ModelMapper 같은 리플렉션 기반 매퍼는 150배 이상 차이가 납니다. 선택 기준을 성능이 아니라 타입 안전성과 보일러플레이트로 잡아도 되는 이유입니다.

### UserSettings는 왜 가변으로 뒀나

UserSettings만 완전 불변이 아니라 부분 불변입니다. `userId`와 `createdAt`은 final이고 나머지 20개 넘는 필드는 가변입니다.

필드가 20개를 넘으니 하나 바꿀 때마다 `toBuilder`로 전체를 복사하는 건 코드도 길고 실수하기 쉽습니다. PATCH API를 지원해야 하고, Entity도 가변이라 dirty checking이 자연스럽게 맞물립니다. 대신 setter를 열지 않고 명시적인 `updateXxx()` 메서드로만 상태를 바꿉니다.

```java
public void updatePlannerSettings(int startHour, int dailyGoal, int weeklyGoal, boolean weeklyTimetableEnabled) {
    if (startHour < 0 || startHour > 23) {
        throw new IllegalArgumentException("시작 시간은 0-23 사이여야 합니다");
    }
    // ... 검증 후 업데이트
}
```

검증 로직을 한곳에 두고 `updatedAt` 갱신을 빠뜨리지 않으며, 어떤 필드가 어떻게 바뀔 수 있는지가 코드에 드러납니다. MapStruct의 default 메서드에서 이 `updateXxx()`들을 호출하게 해서 null 체크와 검증을 한 곳에 모았습니다.

---

## 11. 모바일 인증은 왜 웹과 다른가

*원문 발행일 2025-12-11*

이전 프로젝트에서 웹용으로 HttpOnly Cookie와 JWT를 붙였을 때는 간단했습니다.

```java
// 백엔드 3줄
cookie.setHttpOnly(true);
cookie.setSecure(true);
cookie.setAttribute("SameSite", "Lax");
```

브라우저가 알아서 쿠키를 보내주고 XSS도 막아줬습니다. 이번에 모바일 앱 백엔드를 만들면서 이 전제가 하나도 성립하지 않는다는 걸 알게 됐습니다.

| 구분 | 웹 (쿠키 기반) | 모바일 (현재 구현) |
|------|---------------|-------------------|
| 토큰 저장 | HttpOnly 쿠키 (브라우저) | Keychain/Keystore (앱) + Redis (서버) |
| 토큰 탈취 감지 | 어려움 (쿠키는 자동 전송) | 가능 (Redis 값과 비교) |
| 즉시 로그아웃 | 어려움 (토큰 자체가 유효) | 가능 (Redis 삭제) |
| 멀티 디바이스 | 세션 기반으로 복잡 | deviceId별 토큰으로 네이티브 지원 |
| CSRF 방어 | 필요 (쿠키 자동 전송) | 불필요 (Authorization 헤더) |

### 왜 모바일은 쿠키를 안 쓰나

첫째, 네이티브 앱에는 쿠키 개념이 없습니다. 브라우저가 아니므로 쿠키를 쓰려면 CookieManager를 직접 관리해야 하는데 그건 웹뷰에서나 하는 방식입니다. 네이티브 앱은 Authorization 헤더를 씁니다.

둘째, XSS가 없습니다. HttpOnly Cookie를 쓰는 가장 큰 이유가 XSS 방어인데 네이티브 앱은 JavaScript 실행 환경이 아닙니다. 대신 기기 분실과 루팅, 앱 디컴파일이라는 다른 위협이 있어서 Keychain과 Keystore 같은 OS 보안 저장소를 씁니다.

셋째, 멀티 디바이스가 필수입니다. 같은 사용자가 아침에는 iPhone, 집에서는 iPad를 씁니다. 기기마다 독립된 세션이 필요한데 쿠키는 브라우저 단위라 이걸 다루기 어렵습니다.

찾아보니 이 구조가 특이한 선택은 아니었습니다.

> "For native apps, use platform-secure storage APIs. For example, in iOS, use Keychain, and in Android, use Keystore."
>
> — [Curity - OAuth for Mobile Apps Best Practices](https://curity.io/resources/learn/oauth-for-mobile-apps-best-practices/)

### 1인 개발자에게 OAuth 설정은 지옥입니다

웹에서는 구글 콘솔에서 클라이언트 ID를 만들고 redirect URI 하나 등록하면 끝이었습니다. 모바일은 그렇지 않았습니다.

Google은 iOS용과 Android용 클라이언트 ID를 따로 만들어야 하고, Android는 패키지명과 함께 SHA-1 지문을 등록해야 합니다. 그 SHA-1이 debug용, release용, Google Play 앱 서명용으로 각각 다릅니다.

```bash
# debug용
keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android -keypass android

# release용
keytool -list -v -keystore your-release-key.keystore -alias your-alias
```

Apple은 여기에 연 $99 개발자 계정과 App ID, Services ID, .p8 Private Key, Key ID, Team ID가 더 붙습니다. 게다가 Apple의 `client_secret`은 고정 문자열이 아니라 백엔드에서 매번 생성해야 하는 JWT입니다. Kakao도 플랫폼마다 Bundle ID와 키 해시를 따로 등록해야 합니다. 세 개를 전부 설정하는 데 하루 이상 걸렸습니다.

### 검증 방식이 제공자마다 다르다

웹에서는 프론트가 로그인 페이지로 리다이렉트되고, 백엔드가 authorization code를 받아 토큰으로 교환했습니다. 모바일은 앱이 SDK로 로그인해서 받은 idToken을 백엔드로 보내고, 백엔드가 그 토큰을 직접 검증합니다. 리다이렉트가 없습니다.

| 제공자 | 토큰 타입 | 검증 방식 |
|--------|----------|----------|
| Google | `idToken` (JWT) | 공개키로 서명 검증 |
| Apple | `identityToken` (JWT) | 공개키 fetch + 24시간 캐싱 |
| Kakao | `accessToken` (불투명) | API 호출로 사용자 정보 조회 |

Google은 라이브러리가 공개키 fetch와 캐싱, 로테이션까지 전부 처리해줍니다.

```java
// Google - 한 줄이면 끝
GoogleIdToken googleIdToken = verifier.verify(idToken);
```

Apple은 서버 사이드 Java 라이브러리를 제공하지 않습니다. iOS와 macOS SDK만 줍니다. 그래서 JWT 헤더에서 `kid`를 뽑고, Apple JWKS 엔드포인트에서 공개키를 받아오고, 일치하는 키로 RSA 공개키를 만들어 서명을 검증하는 과정을 직접 짰습니다.

매 요청마다 Apple 서버에 공개키를 물으면 해외 서버라 느리고, Apple이 장애나면 우리 로그인도 같이 죽습니다. 그래서 24시간 캐싱을 넣었습니다. Apple이 주기적으로 서명 키를 교체하기 때문에, 캐시에 없는 `kid`가 오면 새로 받아오고 24시간마다 캐시를 비워 폐기된 키가 남지 않게 했습니다.

![apple-public-key-cache](/uploads/project/Tymee/mobile-jwt-auth/apple-public-key-cache.png)

Google이 한 줄이면 되는 일을 Apple은 50줄 넘게 짜야 합니다. 1인 개발자 입장에서 Apple Sign In이 제일 힘들었던 이유입니다.

### Refresh Token 탈취 감지

웹에서는 HttpOnly 쿠키라 JavaScript로 접근 자체가 불가능해서 탈취 감지가 필요 없었습니다. 모바일은 앱 저장소가 털리면 토큰이 노출됩니다.

저장소로 MySQL과 Redis를 비교했습니다. 토큰 갱신은 Access Token이 만료될 때마다 일어나서 읽기와 쓰기가 잦은데, MySQL은 디스크 기반이라 단순 키 조회에도 수 ms가 걸리고 커넥션 풀을 씁니다. Redis는 인메모리라 같은 작업이 1ms 미만이고 TTL로 만료 토큰이 알아서 사라집니다. Oracle Cloud Free Tier에 직접 설치해서 추가 비용도 없습니다.

![refresh-token-reuse-detection](/uploads/project/Tymee/mobile-jwt-auth/refresh-token-reuse-detection.png)

동작은 이렇습니다. 정상 사용자가 토큰을 갱신하면 Redis에 새 토큰이 저장됩니다. 공격자가 훔친 이전 토큰으로 갱신을 시도하면 Redis 값과 어긋나고, 그 순간 모든 기기를 강제 로그아웃시킵니다. 웹을 만들 때는 생각해본 적 없는 로직입니다.

세션은 `refresh_token:{userId}:{deviceId}` 형태로 기기별로 나눠 저장합니다. 그래서 특정 기기만 로그아웃시키거나 전체 기기를 한 번에 끊는 게 둘 다 가능합니다.

### Swagger에서 테스트할 방법이 없다

모바일 OAuth는 앱에서만 동작합니다. Google OAuth Playground로 토큰을 받아 시도했더니 검증에 실패했습니다.

```
우리 앱: 123456789.apps.googleusercontent.com
OAuth Playground: 407408718192.apps.googleusercontent.com
```

Playground의 client_id가 우리 앱과 달라서 JWT의 `aud` 클레임 검증에서 걸린 것이었습니다. 결국 로컬과 테스트 프로필에서만 뜨는 개발용 로그인 API를 따로 만들었습니다. Mock OAuth 서버를 띄우는 방법도 있지만 1인 개발에서는 이쪽이 간단합니다.

![mobile-auth-flow](/uploads/project/Tymee/mobile-jwt-auth/mobile-auth-flow.png)

### 결론

같은 JWT인데 환경에 따라 완전히 다른 아키텍처가 나왔습니다. 웹에서는 HttpOnly 쿠키 하나로 끝나던 것이, 모바일에서는 플랫폼별 OAuth 설정과 인증서 관리, 제공자별 검증 로직, 탈취 감지, 기기별 세션까지 붙었습니다. 각 환경의 위협 모델이 다르니 방어도 달라야 한다는 게 이 장에서 얻은 것입니다.

---

## 12. 고아 파일 정리 시스템

*원문 발행일 2025-12-16*

프로필 이미지를 교체하면 이전 파일이 R2에 그대로 남습니다. 이걸 언제 어떻게 지울지가 문제였습니다.

### 왜 즉시 삭제하지 않았나

가장 단순한 방법은 프로필 수정 트랜잭션 안에서 바로 R2 파일을 지우는 것입니다. 이 방법을 쓰지 않은 이유가 셋 있습니다.

첫째, R2나 S3 같은 외부 스토리지는 DB 트랜잭션에 포함되지 않습니다. 파일을 먼저 지운 뒤 커밋에서 예외가 나면 DB는 롤백되는데 파일은 이미 사라진 상태로 남습니다.

```java
@Transactional
public User updateProfile(..., Long newImageId) {
    user.updateProfileImage(newImageId);  // ① DB 업데이트 (트랜잭션 내)
    r2Service.deleteFile(oldImagePath);   // ② R2 삭제 (외부 시스템)
    return userRepository.save(user);     // ③ 커밋
}
```

둘째, 응답이 느려집니다. DB 업데이트는 5ms인데 R2 삭제는 네트워크 I/O라 100~500ms가 붙습니다. 사용자는 이전 이미지가 언제 지워지는지에 관심이 없습니다.

셋째, 복구가 불가능합니다. `deleted_at`만 마킹해두면 7일 안에는 되돌릴 수 있습니다.

그래서 마킹과 실제 삭제를 분리했습니다. uploads 테이블의 `deleted_at` 컬럼 하나로 프로필 이미지, 게시글 이미지, 채팅 첨부파일을 전부 같은 방식으로 다루므로 새 파일 타입이 생겨도 배치 코드는 건드리지 않습니다. 마킹은 이벤트가, 실제 R2 삭제는 매일 새벽 3시 배치가 맡습니다.

유예 기간 동안 스토리지를 더 쓰는 비용은 계산해봤습니다. R2 저장 비용이 월 $0.015/GB이고 프로필 이미지가 평균 500KB, 일일 교체가 100건이면 7일치 추가 스토리지는 약 350MB, 월 $0.005입니다. 즉시 삭제가 실패했을 때 필요한 보상 트랜잭션을 구현하는 비용이 훨씬 비쌉니다.

### RabbitMQ 대신 Spring Event를 쓴 이유

RabbitMQ가 이미 인프라에 있었지만 이 기능에는 쓰지 않았습니다. 서버가 1대라 User 모듈과 Upload 모듈이 같은 JVM에서 돌고, soft delete가 실패해도 다음 배치가 처리하니 유실이 치명적이지 않습니다. RabbitMQ를 쓰려면 ConnectionFactory와 Exchange, Queue, Binding 설정에 직렬화와 재연결 처리까지 붙는데 Spring Event는 `@EventListener` 하나면 됩니다. ARM 1 OCPU에 6GB RAM 환경에서 불필요한 네트워크 hop도 낭비입니다.

서버를 2대 이상으로 늘리거나, DLQ와 재시도 정책이 필요한 작업이 생기거나, 알림 서버 같은 외부 서비스와 연동하게 되면 그때가 전환 시점이라고 보고 있습니다.

이벤트를 쓴 이유가 하나 더 있습니다. UserService가 UploadService를 직접 호출하면, Upload 모듈도 업로더 정보 조회 때문에 User 모듈을 참조하므로 순환 의존성이 생깁니다. 이벤트 정의를 Core 모듈에 두고 양쪽이 Core만 바라보게 해서 끊었습니다. [2장](#2-1인-프로젝트의-아키텍처-선택)에서 모듈을 도메인별로 나눈 선택이 여기서 값을 했습니다.

`@TransactionalEventListener(AFTER_COMMIT)`을 쓴 것도 같은 맥락입니다. 프로필 업데이트가 롤백되면 리스너가 실행되지 않아 이전 이미지가 그대로 유지됩니다.

---

### AFTER_COMMIT에서 DB 업데이트가 안 되는 문제

프로필 이미지 변경 기능을 구현하다가 이상한 버그를 만났습니다.
이전 이미지를 soft delete 처리하는 이벤트 리스너를 만들었는데, 분명히 `save()`를 호출했는데도 `deleted_at`이 DB에 저장되지 않는 것입니다.

![after-commit-problem](/uploads/project/Tymee/orphan-file-cleanup/after-commit-problem.png)


처음엔 내 코드가 잘못된 줄 알고 한참을 헤맸습니다.
그러다 관련 글을 찾아보면서 원인을 알게 됐는데, 생각보다 깊은 내용이었습니다.

#### 원인: DB 트랜잭션과 스프링 트랜잭션 컨텍스트는 다르다

`AFTER_COMMIT`이니까 당연히 트랜잭션이 끝난 상태라고 생각했습니다.
근데 정확히 말하면 **DB 트랜잭션**만 끝난 것이고, **스프링 트랜잭션 컨텍스트**는 아직 살아있습니다.

Spring의 `processCommit()` 메서드를 까보면 이렇게 돌아갑니다:

```
1. prepareForCommit()
2. triggerBeforeCommit()
3. doCommit()              <-- 여기서 DB 커밋! DB 트랜잭션 종료
4. triggerAfterCommit()    <-- AFTER_COMMIT 리스너 실행 (바로 여기)
5. triggerAfterCompletion()
6. cleanupAfterCompletion() <-- 스프링 트랜잭션 컨텍스트 정리
```

`doCommit()` 이후에 `triggerAfterCommit()`이 호출되는데, 이 시점에서 DB 트랜잭션은 끝났지만 스프링 트랜잭션 컨텍스트는 `cleanupAfterCompletion()`이 호출되기 전까지 살아있습니다.

#### 그래서 뭐가 문제냐면

![transaction-context-alive](/uploads/project/Tymee/orphan-file-cleanup/transaction-context-alive.png)


`@Transactional`의 기본 propagation이 `REQUIRED`인데, 이건 "기존 트랜잭션이 있으면 참여하라"는 뜻입니다.
스프링이 보기엔 트랜잭션 컨텍스트가 아직 있으니까 "오 트랜잭션 있네, 참여해야지!" 하고 기존 트랜잭션에 참여합니다.

근데 DB 트랜잭션은 이미 커밋되어 종료된 상태.
결과적으로 DB에 아무것도 반영되지 않습니다.

#### 더 골치아픈 건

영속성 컨텍스트 때문에 **성공한 것처럼 보인다**:

![persistence-context-cache](/uploads/project/Tymee/orphan-file-cleanup/persistence-context-cache.png)


영속성 컨텍스트(1차 캐시)에서 조회되니까 코드상으로는 변경이 잘 된 것처럼 보입니다.
하지만 DB에 직접 쿼리를 날려보면 값이 안 바뀌어 있습니다.
이게 디버깅을 어렵게 만듭니다.

#### 해결책

**REQUIRES_NEW로 새 트랜잭션 시작**

![requires-new-solution](/uploads/project/Tymee/orphan-file-cleanup/requires-new-solution.png)


`REQUIRES_NEW`는 기존 트랜잭션과 상관없이 새 트랜잭션을 만듭니다.
완전히 새로운 DB 트랜잭션이 시작되니까 정상적으로 저장됩니다.

#### 왜 @Async는 안 썼나?

`@Async`를 쓰면 별도 스레드에서 실행되니까 트랜잭션 컨텍스트가 전파되지 않아서 문제가 해결되긴 합니다.

![async-alternative](/uploads/project/Tymee/orphan-file-cleanup/async-alternative.png)

근데 이 프로젝트에서는 `@Async`를 안 썼습니다. 이유는:

1. **soft delete는 금방 끝남** - `deleted_at` 마킹은 단순 UPDATE 하나라 몇 ms면 끝납니다. 비동기로 할 이유가 없습니다.

2. **동기 실행이 디버깅에 유리** - 비동기면 로그 추적이 복잡해지고, 예외 발생 시 어디서 터졌는지 파악하기 어렵습니다.

3. **REQUIRES_NEW로 충분** - 문제의 본질은 "새 DB 트랜잭션이 필요하다"인데, `REQUIRES_NEW`가 정확히 그걸 해결합니다.

`@Async`는 "이 작업이 오래 걸려서 응답을 기다리기 싫을 때" 쓰는 것입니다.
예를 들어 이메일 발송, 푸시 알림 같은 외부 API 호출이 여기에 해당합니다. soft delete는 해당하지 않습니다.

#### 정리

| 상황 | 결과 | 비고 |
|------|------|------|
| `AFTER_COMMIT` + `@Transactional` (기본 REQUIRED) | DB 반영 안됨 | 이미 종료된 트랜잭션에 참여 시도 |
| `AFTER_COMMIT` + `@Transactional(REQUIRES_NEW)` | **정상 동작** | **이 프로젝트에서 사용** |
| `AFTER_COMMIT` + `@Async` + `@Transactional` | 정상 동작 | 별도 스레드, 오래 걸리는 작업에 적합 |
| `BEFORE_COMMIT` + `@Transactional` (기본 REQUIRED) | 정상 동작 | 아직 트랜잭션 진행 중 |

> **참고한 글들:**
> - [Spring puzzler: the @TransactionalEventListener](https://softice.dev/posts/spring_puzzler_transactional_event_listener/) - 원인을 가장 잘 설명한 글
> - [Spring Framework GitHub Issue #26974](https://github.com/spring-projects/spring-framework/issues/26974) - 공식 이슈
> - [Spring 공식 문서](https://docs.spring.io/spring-framework/reference/data-access/transaction/event.html)
> - [curiousjinan 블로그](https://curiousjinan.tistory.com/entry/fixing-spring-transactionaleventlistener-after-commit-update-issue)
---

### 배운 점

가장 크게 배운 건 트랜잭션의 경계입니다.
R2나 S3 같은 외부 스토리지는 DB 트랜잭션에 포함되지 않으므로, 파일 작업은 DB 커밋이 확정된 뒤에 해야 합니다.
그리고 그 "커밋된 뒤"라는 시점조차 스프링에서는 두 겹으로 나뉘어 있다는 것을, 저장이 안 되는 버그를 며칠 붙잡고서야 알았습니다.

## 13. Spring Boot 4 API 버전 관리

*원문 발행일 2025-12-21*

> Spring Boot 4.0 / Spring Framework 7.0부터 API 버전 관리가 프레임워크 레벨에서 공식 지원된다.

### 설정 파일

**ApiVersionConfig.java**

![api-version-config](/uploads/project/Tymee/spring-boot4-api-versioning/api-version-config.png)

### 버전 관리 전략 비교

| 전략             | 설정 메서드               | URL/헤더 예시                         | 장점                 | 단점                   |
|------------------|---------------------------|---------------------------------------|----------------------|------------------------|
| **Path Segment** | `usePathSegment()`        | `/api/v1/users`                       | 명확함, 캐시 친화적  | URL이 길어짐           |
| Query Param      | `useQueryParam()`         | `/api/users?version=1`                | 간단함               | 캐시 키 복잡           |
| Header           | `useRequestHeader()`      | `X-API-Version: 1`                    | URL 깔끔             | 브라우저 테스트 어려움 |
| Media Type       | `useMediaTypeParameter()` | `Accept: application/vnd.api.v1+json` | RESTful              | 구현 복잡              |

> Path Segment 방식이 가장 직관적이고 캐시 친화적이어서 선택했다

---

### Path Segment를 선택한 이유

4가지 전략 중 **Path Segment** (`/api/v1/users`)를 선택했습니다.

URL만 보고 버전을 바로 알 수 있어서 디버깅이 쉽고, CDN/프록시 캐싱이 자연스럽게 동작하며, 브라우저에서 직접 테스트할 수 있습니다.
URL이 길어진다는 비판이 있지만, 모바일 앱 전용 API라 외부 공개가 아니어서 크게 문제되지 않습니다.

Header 방식(`X-API-Version`)은 URL이 깔끔하지만 브라우저 테스트가 어렵고 로그 분석에 불리합니다.
Media Type 방식은 가장 RESTful하지만 구현이 복잡하고 클라이언트 설정이 번거롭습니다.
Query Parameter 방식은 캐시 키가 복잡해지는 문제가 있습니다.

초기에는 단일 버전으로 시작하되, Breaking Change가 예상될 때 버전을 올리는 게 현실적입니다.

---

## 14. API 버전 관리와 Swagger UI의 충돌

*원문 발행일 2025-12-26*

13장에서 켠 API Versioning 때문에 Swagger UI가 통째로 죽었습니다. 3개월 중 가장 오래 붙잡은 문제입니다.

```
InvalidApiVersionException: 400 BAD_REQUEST "Invalid API version: 'No path segment at index 1'."
```

Spring Boot 4.0.1, Spring Framework 7.0.2, springdoc 3.0.1, Java 25 조합입니다. 새로 나온 기능이라 검색해도 Spring Boot 3 이하 기준의 글만 나왔습니다. 해결까지 여덟 번 시도했고, 실패한 다섯 번이 사실상 이 장의 내용입니다.

### 1차: Spring Security 문제인 줄 알았다

SecurityConfig에 Swagger 경로를 permitAll로 열었습니다. 실패했습니다. 에러 메시지를 다시 보니 `InvalidApiVersionException`이었습니다. Security가 아니라 버전 파싱 단계에서 터지고 있었습니다.

### 2차: springdoc 패키지를 prefix에서 제외

springdoc GitHub [이슈 #3163](https://github.com/springdoc/springdoc-openapi/issues/3163)에서 같은 문제를 겪는 사람을 찾았습니다. maintainer는 `addPathPrefix`에서 springdoc을 제외하라고 답했습니다. 그대로 했는데 실패했습니다.

`addPathPrefix`는 URL prefix만 관리하고 버전 파싱 자체는 건드리지 않습니다. 이 둘이 별개라는 걸 여기서 알았습니다.

### 3차와 4차: 블랙리스트 방식

`ApiVersionResolver`를 직접 구현해서 Swagger 경로면 `null`을 반환하게 했습니다. Swagger는 열렸는데 새 에러가 나왔습니다.

```
InvalidApiVersionException: 400 BAD_REQUEST "Invalid API version: 'auth'."
```

`/auth/login/google`에서 `auth`를 버전으로 읽으려다 실패한 것입니다. 제외할 경로를 계속 추가해야 하는 구조라는 게 드러났습니다.

### 5차: 화이트리스트로 전환

제외할 것을 나열하는 대신, `/api/v{N}/...` 패턴에 맞는 경로에서만 버전을 뽑고 나머지는 전부 `null`을 반환하게 뒤집었습니다.

```java
private static final Pattern VERSION_PATTERN = Pattern.compile("^/api/v(\\d+)/.+");
```

또 실패했습니다.

```
MissingApiVersionException: 400 BAD_REQUEST "API version is required."
```

### 6차: 버전이 기본으로 필수였다

`null`을 반환해도 `DefaultApiVersionStrategy`가 버전을 필수로 보고 예외를 던지고 있었습니다. 이게 제일 찾기 어려웠습니다. `setVersionRequired(false)`를 넣자 Swagger UI가 떴는데, 이번에는 API 목록이 비어 있었습니다.

```
No operations defined in spec!
```

### 7차와 8차: 그룹 설정과 공식 스타일

springdoc이 `@RequestMapping(version = ...)`을 인식해서 버전별로 묶도록 `GroupedOpenApi`를 설정하자 v1과 v2 그룹이 나타났습니다. 마지막으로 Spring Framework 공식 예제가 `"1"` 대신 `"1.0"` 시맨틱 버저닝을 쓰기에, `v1`과 `1`을 모두 `1.0`으로 바꿔주는 `SimpleVersionParser`를 붙여 맞췄습니다.

![final-api-version-config](/uploads/project/Tymee/spring-boot4-swagger-conflict/final-api-version-config.png)

### 정리하면

| 설정 | 역할 |
|------|------|
| `ApiPathVersionResolver` | `/api/v{N}/...` 패턴에서만 버전 추출 |
| `SimpleVersionParser` | `v1`을 `1.0`으로 변환 |
| `setVersionRequired(false)` | Swagger 등 버전 없는 경로 허용 |
| `addPathPrefix` + `negate()` | springdoc 패키지는 prefix에서 제외 |
| `GroupedOpenApi` | Swagger에서 v1/v2 그룹 선택 |

이 과정에서 남은 것은 네 가지입니다. 제외 목록은 계속 늘어나므로 블랙리스트보다 화이트리스트가 낫다는 것, URL prefix 설정과 버전 파싱은 완전히 별개라는 것, 커스텀 `ApiVersionResolver`가 실질적인 제어점이라는 것, 그리고 Spring Boot 4와 springdoc 조합은 아직 이런 우회가 필요한 단계라는 것입니다.

공식 문서에는 화이트리스트나 블랙리스트 필터링에 대한 가이드가 없습니다. 커스텀 `ApiVersionResolver`를 쓸 수 있다는 언급만 있습니다.

---

## 15. 개발 자동화와 3개월의 회고

*원문 발행일 2026-02-10*

### 기획이 맞았는지 확인한 방법

1장에서 세운 가설을 그대로 믿고 시작하지는 않았습니다. 앱스토어 상위 타이머 앱 다섯 개를 2주간 직접 써봤는데, 지속적인 동기 부여가 안 된다는 지점이 공통적이었습니다. 게이미피케이션으로 그 간극을 메우는 방향이 맞다고 보고 진행했습니다.

팀 프로젝트에서는 늘 정해진 사용자만 서비스를 썼습니다. 팀원과 심사위원입니다. 실제 사용자에게 피드백을 받아 고쳐보는 경험이 하고 싶어서 개인 프로젝트를 시작했습니다.

### 자동화는 귀찮음에서 시작된다

혼자 개발하는데도 이슈 관리가 필요했습니다. 초기에는 GitHub Issues만 썼는데, PR을 머지해도 이슈 상태가 바뀌지 않아서 끝난 작업이 Open으로 남았습니다. 117개 이슈 중 실제 진행률을 알 수 없는 상태가 됐습니다.

Linear의 GitHub Integration으로 옮기고 이슈 생성부터 브랜치 생성, PR 머지, 이슈 종료, Slack 알림까지 연결했습니다. 이슈 하나당 다섯 번 하던 수동 작업이 없어졌습니다.

![Linear 보드](/uploads/project/Tymee/retrospective/linear-board.png)

2주차에 "이 기능 구현했었나"를 세 번이나 검색하고 나서 만든 것입니다. 초기 설정에 두 시간을 썼고 이후로 매일 10분 정도를 아끼고 있습니다. 나중에 귀찮아질 일이 보이면 그 자리에서 자동화하는 습관이 생겼습니다.

인증과 코드 품질 파이프라인도 같은 시기에 정리했습니다. 설계 근거는 [11장](#11-모바일-인증은-왜-웹과-다른가)과 [8장](#8-코드-품질-파이프라인-구축)에 적었고, 가장 오래 붙잡았던 Swagger 충돌은 [14장](#14-api-버전-관리와-swagger-ui의-충돌)에 실패한 시도까지 남겼습니다.

### 실제 유저를 위한 코드

지금은 API 설계를 마치고 React Native UI와 백엔드를 함께 진행하고 있습니다.

팀 프로젝트와 개인 프로젝트의 가장 큰 차이는 모든 결정의 책임이 온전히 나에게 있다는 것입니다. 아키텍처부터 UI까지 왜 그렇게 했는지 스스로 설명할 수 있어야 합니다. 이 글의 열다섯 개 장이 전부 그 설명입니다. 헥사고날을 쓰지 않은 이유, UUID 대신 Snowflake를 고른 이유, RabbitMQ가 있는데도 Spring Event를 쓴 이유를 적어두고 나니 다음 결정이 빨라졌습니다.

---

## 참고 자료

### 1인 프로젝트의 아키텍처 선택

- [PresentationDomainDataLayering - Martin Fowler](https://martinfowler.com/bliki/PresentationDomainDataLayering.html)
- [Hexagonal Architecture - Alistair Cockburn](https://alistair.cockburn.us/hexagonal-architecture/)
- [유일한 멀티모듈 헥사고날 아키텍처 - 카카오뱅크](https://tech.kakaobank.com/posts/2311-hexagonal-architecture-in-messaging-hub/)
- [Hexagonal Architecture, 진짜 하실 건가요? - 카카오페이](https://tech.kakaopay.com/post/home-hexagonal-architecture/)
- [멀티모듈 설계 이야기 with Spring, Gradle - 우아한형제들](https://techblog.woowahan.com/2637/)
- [Best practices for multi-module projects with Spring Boot - Bootify](https://bootify.io/multi-module/best-practices-for-spring-boot-multi-module.html)
- [Entity vs Value Object - Enterprise Craftsmanship](https://enterprisecraftsmanship.com/posts/entity-vs-value-object-the-ultimate-list-of-differences/)
- [AnemicDomainModel - Martin Fowler](https://martinfowler.com/bliki/AnemicDomainModel.html)
- [DDD - 애그리거트, 애그리거트 루트](https://assu10.github.io/dev/2024/04/06/ddd-aggregate/)

### Gradle 멀티모듈 의존성 관리

- [Version Catalogs - Gradle 공식 문서](https://docs.gradle.org/current/userguide/version_catalogs.html)
- [Best Practices for Naming Version Catalog Entries - Gradle Blog](https://blog.gradle.org/best-practices-naming-version-catalog-entries)
- [Gradle multi module dependency management using Version Catalogs - Medium](https://medium.com/@rohitloke/gradle-multi-module-dependency-management-using-version-catalogs-379f3988da5b)
- [Thoughtworks Technology Radar - Gradle Version Catalog](https://www.thoughtworks.com/radar/tools/gradle-version-catalog)

### 설정 파일을 yml로 바꾼 이유

- [Using application.yml vs application.properties in Spring Boot | Baeldung](https://www.baeldung.com/spring-boot-yaml-vs-properties)
- [Externalized Configuration :: Spring Boot](https://docs.spring.io/spring-boot/reference/features/external-config.html)
- [Benefits of Spring Boot's application.yml file with examples | TheServerSide](https://www.theserverside.com/blog/Coffee-Talk-Java-News-Stories-and-Opinions/yaml-vs-properties-yml-application-spring-boot-configuration-difference-compare-value-map-list)

### 예외 처리 설계

- [Spring Rest - Exception Handling - DEV Community](https://dev.to/noelopez/spring-rest-exception-handling-part-1-1jj2)
- [Exception Handling in Spring MVC - Spring 공식 블로그](https://spring.io/blog/2013/11/01/exception-handling-in-spring-mvc/)
- [Spring Boot @ControllerAdvice & @ExceptionHandler - BezKoder](https://www.bezkoder.com/spring-boot-controlleradvice-exceptionhandler/)
- [zalando/problem-spring-web - GitHub](https://github.com/zalando/problem-spring-web)
- [Vavr User Guide](https://docs.vavr.io/)
- [RESTful API Design: What About Errors? - Google Cloud Blog](https://cloud.google.com/blog/products/api-management/restful-api-design-what-about-errors)
- [Best Practices for API Error Handling - Postman Blog](https://blog.postman.com/best-practices-for-api-error-handling/)
- [Spring Boot Global Exception Handling - Jose López](https://josealopez.dev/en/blog/spring-boot-global-exception-handling)
- [REST API Error Codes 101 - REST Case](https://blog.restcase.com/rest-api-error-codes-101/)
- [Best Practices for Consistent API Error Handling - Zuplo](https://zuplo.com/learning-center/best-practices-for-api-error-handling)
- [REST API Error Handling Best Practices - Speakeasy](https://www.speakeasy.com/api-design/errors)

### Snowflake ID 도입

- [Twitter Engineering - Announcing Snowflake](https://blog.twitter.com/engineering/en_us/a/2010/announcing-snowflake)
- [Instagram Engineering - Sharding & IDs at Instagram](https://instagram-engineering.com/sharding-ids-at-instagram-1cf5a71e5a5c)
- [PlanetScale - The Problem with Using a UUID Primary Key in MySQL](https://planetscale.com/blog/the-problem-with-using-a-uuid-primary-key-in-mysql)
- [Percona - UUIDs are Popular, but Bad for Performance](https://www.percona.com/blog/uuids-are-popular-but-bad-for-performance-lets-discuss/)
- [Buildkite - Goodbye to sequential integers, hello UUIDv7!](https://buildkite.com/resources/blog/goodbye-integers-hello-uuids/)
- [RFC 9562 - UUID Version 7](https://www.rfc-editor.org/rfc/rfc9562.html)
- [Discord - Snowflake IDs](https://discord.com/developers/docs/reference#snowflakes)

### Flyway로 DB 형상 관리

- [How to Use Flyway for Database Migrations in Spring Boot - JetBrains](https://blog.jetbrains.com/idea/2024/11/how-to-use-flyway-for-database-migrations-in-spring-boot-applications/)
- [Flyway's Repair Command Explained Simply - Redgate](https://www.red-gate.com/hub/product-learning/flyway/flyways-repair-command-explained-simply)
- [How to troubleshoot common Flyway errors - Makolyte](https://makolyte.com/how-to-troubleshoot-common-flyway-errors/)

### 코드 품질 파이프라인 구축

- [Google Java Style Guide](https://google.github.io/styleguide/javaguide.html)
- [Spotless Gradle Plugin](https://github.com/diffplug/spotless)
- [Checkstyle Documentation](https://checkstyle.org/)
- [SpotBugs Documentation](https://spotbugs.github.io/)
- [JaCoCo Documentation](https://www.jacoco.org/jacoco/)
- [Codecov Documentation](https://docs.codecov.com/)

### @CurrentUser 커스텀 어노테이션

- [Spring Security - AuthenticationPrincipal](https://docs.spring.io/spring-security/site/docs/current/api/org/springframework/security/core/annotation/AuthenticationPrincipal.html)
- [Baeldung - Retrieve User Information in Spring Security](https://www.baeldung.com/get-user-in-spring-security)
- [@AuthenticationPrincipal 동작 원리 - Jian's Tech Blog](https://codevang.tistory.com/273)

### MapStruct로 레이어 간 변환

- [MapStruct 공식 문서](https://mapstruct.org/documentation/stable/reference/html/)
- [Baeldung - MapStruct Guide](https://www.baeldung.com/mapstruct)
- [Java Object Mapper Benchmark](https://github.com/arey/java-object-mapper-benchmark)
- [Baeldung - Performance of Java Mapping Frameworks](https://www.baeldung.com/java-performance-mapping-frameworks)
- [The cost of object creation in Java](https://www.bettercodebytes.com/the-cost-of-object-creation-in-java-including-garbage-collection/)
- [Escape Analysis in the JVM](https://medium.com/@AlexanderObregon/the-purpose-and-mechanics-of-escape-analysis-in-the-jvm-f02c17860b8c)

### 모바일 인증은 왜 웹과 다른가

- [Curity - OAuth for Mobile Apps Best Practices](https://curity.io/resources/learn/oauth-for-mobile-apps-best-practices/)
- [Duende Software - JWT Best Practices for Web & Mobile Apps](https://duendesoftware.com/learn/best-practices-using-jwts-with-web-and-mobile-apps)
- [Compile7 - JWT Best Practices for Mobile Apps](https://compile7.org/decompile/jwt-best-practices-for-mobile-apps)
- [WorkOS - OAuth and JWT Best Practices](https://workos.com/blog/oauth-and-jwt-how-to-use-and-best-practices)
- [Redis - Mobile Banking Session Management](https://redis.io/learn/howtos/solutions/mobile-banking/session-management)
- [Redis - Authentication Token Storage](https://redis.io/solutions/authentication-token-storage/)
- [WorkOS - Why Your App Needs Refresh Tokens](https://workos.com/blog/why-your-app-needs-refresh-tokens-and-how-they-work)
- [Serverion - Refresh Token Rotation Best Practices](https://www.serverion.com/uncategorized/refresh-token-rotation-best-practices-for-developers/)
- [DEV.to - Store Refresh Tokens in Redis](https://dev.to/jacobsngoodwin/12-store-refresh-tokens-in-redis-1k5d)
- [Apple Developer - Token Validation](https://developer.apple.com/documentation/signinwithapplerestapi/generate-and-validate-tokens)
- [Apple Developer - Verifying a User](https://developer.apple.com/documentation/signinwithapple/verifying-a-user)
- [Sarunw - Sign in with Apple: Backend Token Verification](https://sarunw.com/posts/sign-in-with-apple-3/)
- [DEV.to - Complete Guide to Apple OAuth 2.0](https://dev.to/varsilias/complete-guide-to-implementing-apple-oauth-20sign-in-with-apple-authentication-in-a-nodeexpress-application-4hf)
- [Google Developers - OAuth 2.0 for iOS & Desktop Apps](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Google Developers - Verify Google ID Token](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)
- [Baeldung - Faking OAuth2 Single Sign-on](https://www.baeldung.com/spring-oauth2-mock-sso)
- [Baeldung - Disable Security for a Profile](https://www.baeldung.com/spring-security-disable-profile)
- [Beeceptor - OAuth 2.0 Mock Usage](https://beeceptor.com/docs/tutorials/oauth-2-0-mock-usage/)
- [GitHub - navikt/mock-oauth2-server](https://github.com/navikt/mock-oauth2-server)

### Spring Boot 4 API 버전 관리

- [Spring Boot 4 API Versioning - Dan Vega](https://www.danvega.dev/blog/spring-boot-4-api-versioning)
- [Spring Boot Built-in API Versioning - Piotr Minkowski](https://piotrminkowski.com/2025/12/01/spring-boot-built-in-api-versioning/)
- [ApiVersionConfigurer 공식 문서](https://docs.spring.io/spring-framework/docs/current-SNAPSHOT/javadoc-api/org/springframework/web/servlet/config/annotation/ApiVersionConfigurer.html)

### API 버전 관리와 Swagger UI의 충돌

- [HTTP 400 with Spring Boot 4 API versioning enabled - springdoc/springdoc-openapi#3163](https://github.com/springdoc/springdoc-openapi/issues/3163)
- [API Versioning :: Spring Framework](https://docs.spring.io/spring-framework/reference/web/webmvc-versioning.html)

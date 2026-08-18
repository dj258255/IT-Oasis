---
title: '빌려조잉 개발기: 6주 팀 프로젝트에서 내린 기술 결정들'
description: >-
  C2C 공유 플랫폼 빌려조잉을 6인 팀으로 6주 만에 만들며 내린 기술 결정을 시간순으로
  모았습니다. Kafka 대신 Redis Pub/Sub을 고른 근거, MySQL과 MongoDB와 Redis를 함께 쓴
  이유, 채팅방 목록 조회를 1,350ms에서 85ms로 줄인 과정, 13년 묵은 Redis 취약점 대응,
  그리고 팀원 이탈 속에서 서비스를 완성한 기록까지 담았습니다.
date: 2025-12-26
tags:
  - Joying
  - Team Project
  - Spring Boot
  - Kotlin
  - WebSocket
  - Redis
  - MongoDB
  - MySQL
  - Performance
  - Security
  - JWT
  - Coroutine
  - Retrospective
category: team/Joying
coverImage: /uploads/project/Joying/retrospective/title.gif
draft: false
series: "Joying"
seriesOrder: 1
---

빌려조잉은 물건을 서로 빌리고 빌려주는 C2C 공유 플랫폼입니다. 캠핑 텐트나 빔프로젝터처럼 한두 번 쓰고 방치되는 물건을 이웃끼리 대여하면, 빌려주는 쪽은 수익을 얻고 빌리는 쪽은 비용을 아끼고 사회 전체로는 자원 낭비가 줍니다.

![빌려조잉 아키텍처](/uploads/project/Joying/retrospective/architecture.png)

| | |
|---|---|
| **기간** | 2025.10.10 ~ 2025.11.20 (6주) |
| **팀 구성** | 6명 (프론트엔드 2명, 백엔드 4명) |
| **수상** | 삼성전자 주식회사 프로젝트 우수상 |
| **기술 스택** | Java, Kotlin, Spring Boot, WebSocket(STOMP), Redis Pub/Sub, MongoDB, MySQL |
| **인프라** | AWS EC2 t3.medium 1대 (2 vCPU / 4GB), Docker Compose |

### 내 역할

6명 팀의 리드를 맡았고 백엔드 35%에 프론트엔드 10%를 담당했습니다. 회원 시스템과 실시간 채팅 시스템 전체를 설계하고 구현했으며, 마감 직전에는 프론트엔드 API 연동까지 직접 했습니다. 결제 에스크로는 담당자 이탈로 이어받았고, 상품과 게시글 같은 나머지 도메인은 다른 백엔드 팀원들이 맡았습니다.

리드로서 신경 쓴 건 둘이었습니다. 하나는 새 기능을 시작할 때마다 어떤 상태가 되면 완성인지를 먼저 글로 적어 팀과 맞추는 것이었습니다. 막판에 인수 기준이 어긋나 다시 짜는 일을 줄이려는 목적이었습니다. 다른 하나는 기술 결정을 혼자 통보하지 않고 후보의 부하 테스트와 실측값을 함께 공유해 같은 기준 위에서 판단하게 한 것이었습니다. 이견이 생겨도 감정보다 근거로 풀자 팀원이 먼저 더 나은 방법을 제안하기도 했습니다.

### 시작 전에 수치로 못 박은 것

기술 선택에 들어가기 전에 감당해야 할 규모와 제약부터 숫자로 정했습니다. 이 가정이 이후 거의 모든 결정의 기준이 됐습니다.

동시 접속은 50~100명, 채팅방당 메시지는 초당 1~3건, 피크에 전체 초당 100~200건으로 잡았습니다. 1:1 채팅이라 참여자는 구매자와 판매자 2명 고정입니다. 인프라는 EC2 t3.medium 단일 서버에 Spring Boot와 MySQL, MongoDB, Redis를 Docker Compose로 함께 올렸습니다. Kafka 클러스터 같은 새 인프라를 띄울 여유가 거의 없었습니다. 일정은 6주라, 검증되지 않은 기술을 새로 배우기보다 빠르게 동작시키고 측정으로 검증하는 편이 합리적이었습니다.

그다음에는 기술 이름보다 구조의 분기점을 먼저 그었습니다. 메시지 브로커를 새 인프라로 도입할지 아니면 이미 쓰는 Redis로 해결할지, 저장소를 단일 DB로 갈지 데이터 성격별로 나눌지, 인증 토큰을 LocalStorage에 둘지 HttpOnly Cookie에 둘지. 이 세 갈래가 채팅 시스템 전체 방향을 결정했습니다.

만드는 동안의 기록을 편마다 나눠 올렸는데, 흩어져 있으니 앞뒤가 끊겼습니다. 트래픽을 수치로 못 박아둔 것이 왜 Kafka를 버리는 근거가 됐는지, 채팅방 목록을 16배 빠르게 만든 과정이 어떤 제약 위에 서 있었는지가 글을 오가야만 보였습니다. 그래서 시간순 열세 장으로 합쳤습니다. 장 머리에 원문 발행일을 남겨 개발 순서를 알 수 있게 했습니다.

---

## 1. Lombok과 코틀린이 안 맞는 이유

*원문 발행일 2025-11-01*

채팅 기능을 새로 만들면서 이 모듈만 Kotlin으로 쓰기로 했습니다. WebSocket 메시지 처리는 비동기 I/O가 핵심인데, Kotlin Coroutine의 `suspend fun`과 `async` 조합이 Java의 `CompletableFuture` 체이닝보다 읽기 좋았습니다. 기존 회원과 상품 코드는 Java로 두고 채팅만 얹는 점진적 도입이었습니다.

Kotlin이 Java와 완전히 호환된다니 문제없을 줄 알았는데 첫 빌드부터 막혔습니다.

```
e: Unresolved reference 'getProductId'.
e: Unresolved reference 'getTitle'.
e: Unresolved reference 'getMemberId'.
```

Java 엔티티에는 분명히 Lombok `@Getter`가 붙어 있었습니다. 원인은 컴파일 순서였습니다. Kotlin 컴파일러가 먼저 도는데 그 시점에는 Lombok이 아직 getter를 만들지 않아서, Kotlin 입장에서는 존재하지 않는 메서드를 부르는 셈이 됩니다.

프로퍼티 접근으로 바꿔보고, kapt에 Lombok을 물려보고, 빌드 순서를 손대봤지만 전부 실패했습니다. 답은 플러그인 두 개를 같이 쓰는 것이었습니다.

![](/uploads/project/Joying/kotlin-lombok-interop/build-order.svg)

```kotlin
plugins {
    kotlin("plugin.lombok")   // Kotlin 컴파일 시 Lombok 인식
    id("io.freefair.lombok")  // Java 컴파일 시 annotation processing
}
```

둘 다 필요한 이유가 있습니다. `kotlin("plugin.lombok")`은 Kotlin 컴파일러가 Lombok이 만들 getter를 미리 안다고 가정하게 해주지만, 정작 Java 쪽 annotation processing은 따로 잡아줘야 합니다. 그걸 `io.freefair.lombok`이 맡습니다. 이 플러그인을 쓰면 `compileOnly("org.projectlombok:lombok")` 같은 의존성을 손으로 적을 필요도 없습니다.

여기까지 하고 나서 Enum에서 또 터졌습니다. Enum은 Kotlin Lombok 플러그인이 처리하지 못하는 영역이라, delombok으로 우회했습니다. Lombok 애노테이션이 풀린 Java 소스를 빌드 시점에 생성하고 Java 컴파일이 그 소스를 보게 하는 방식입니다. 원본 코드를 고치지 않아도 되고, IntelliJ에 기대지 않으므로 CI에서도 똑같이 빌드됩니다.

![](/uploads/project/Joying/kotlin-lombok-interop/delombok.svg)

정리하면 Kotlin과 Java를 한 프로젝트에서 섞을 때 Lombok은 공짜가 아닙니다. 컴파일러가 두 개 도는 구조라, 어느 컴파일러가 무엇을 언제 보는지를 알아야 설정이 풀립니다.

---

## 2. JWT를 쿠키에 둔 이유와 SameSite 사고

*원문 발행일 2025-11-06*

인증 토큰을 어디에 둘지가 시작 전에 그어둔 세 분기 중 하나였습니다. LocalStorage에 두면 JavaScript로 읽을 수 있어 XSS 한 방에 토큰이 털립니다. 반면 HttpOnly Cookie는 스크립트가 접근할 수 없고 브라우저가 알아서 실어 보냅니다.

![](/uploads/project/Joying/jwt-cookie-security/httponly-cookie.svg)

코드량 차이도 컸습니다. LocalStorage 방식은 토큰 저장과 만료 확인, 갱신, 인터셉터, 로그아웃 정리까지 200줄 가까이 직접 짜야 하는데, 쿠키 방식은 백엔드에서 속성 몇 개 붙이고 프론트에서 `withCredentials: true` 한 줄이면 끝납니다. 네이버와 구글, GitHub도 세션 토큰은 HttpOnly 쿠키로 다룹니다. 그래서 쿠키로 갔습니다.

### 그런데 로컬에서만 401이 떴다

배포한 운영 서버에서는 완벽하게 동작했습니다. 로컬에서 개발하려니 문제가 생겼습니다.

```javascript
// AuthContext.jsx
const response = await axiosInstance.get('/api/v1/auth/me');
// → 401 Unauthorized
```

카카오 로그인도 성공했고 개발자 도구에 쿠키도 보이는데 401이었습니다. 같은 API인데 호출하는 도메인에 따라 결과가 달랐습니다.

```
localhost:5173 → https://운영도메인/api/v1/auth/me   → 401 (쿠키 전송 안 됨)
https://운영도메인 → https://운영도메인/api/v1/auth/me → 200 (쿠키 전송됨)
```

### 범인은 SameSite였다

DevTools의 Application 탭에는 쿠키가 멀쩡히 있는데 Network 탭의 요청 헤더에서는 `Cookie`가 비어 있었습니다. 쿠키는 저장돼 있지만 실려 나가지 않고 있었습니다.

```
Name: accessToken
SameSite: Lax  ← 이게 문제
```

SameSite는 CSRF를 막으려고 브라우저가 쿠키 전송을 제한하는 정책입니다.

| SameSite | 언제 쿠키를 보내나 |
|----------|---------------|
| Strict | 무조건 같은 사이트만 |
| Lax | 같은 사이트 + 안전한 GET |
| None | 크로스 사이트도 허용 (Secure 필수) |

우리는 `Lax`였습니다. 그런데 `localhost:5173`에서 운영 도메인을 부르는 건 프로토콜과 도메인, 포트가 전부 달라서 크로스 사이트입니다. 그래서 쿠키가 빠집니다. 운영 도메인끼리는 퍼스트 파티라 정상 전송됩니다.

> 출처: [web.dev - SameSite cookies explained](https://web.dev/i18n/ko/samesite-cookies-explained/)

### 고칠 방법 넷 중에 고르기

`SameSite=None`으로 바꾸는 게 가장 쉽습니다. 백엔드 한 줄이면 끝납니다. 하지만 로컬 개발 편의를 위해 운영 환경의 CSRF 방어를 낮추는 셈이라 본말전도였습니다.

로컬도 HTTPS로 만드는 방법은 프로토콜만 맞출 뿐입니다. 도메인이 여전히 다르니 크로스 사이트가 그대로고, 인증서를 팀원 전부가 관리해야 합니다.

LocalStorage로 돌아가는 건 XSS 취약점을 되살리고 200줄을 다시 짜는 일입니다. 쿠키를 고른 이유 자체를 포기하는 선택입니다.

남은 게 Vite 프록시였습니다. 브라우저가 보기에 요청이 `localhost:5173`으로 나가고 Vite가 뒤에서 백엔드로 넘겨주면, 브라우저 입장에서는 퍼스트 파티가 됩니다. 운영 보안 설정을 그대로 두고 로컬만 푸는 방법입니다.

```properties
VITE_API_BASE_URL=/api/v1
VITE_BACKEND_TARGET=https://운영도메인
```

팀원마다 운영 백엔드를 볼지 로컬 백엔드를 볼지 환경 변수로 고를 수 있게 했습니다.

붙이고 나서 경로가 두 번 붙는 문제를 한 번 더 만났습니다.

```
Request URL: http://localhost:5173/api/v1/api/v1/auth/me
```

`baseURL`에 `/api/v1`을 넣고 요청에도 `/api/v1/auth/me`를 그대로 쓴 탓이었습니다. baseURL에 버전을 두고 요청은 리소스 경로만 쓰는 규칙으로 정리했습니다.

결과적으로 운영은 `SameSite=Lax`를 유지한 채로, 로컬에서도 쿠키가 자동 전송되는 상태가 됐습니다.

### 댓글로 받은 질문: XSS만 막으면 되는 것 아닌가

발행 뒤에 이런 질문을 받았습니다. XSS만 완벽히 막으면 LocalStorage도 안전한 것 아니냐는 것이었습니다.

맞는 말이지만 전제가 셉니다. XSS는 우리 코드에서만 터지지 않습니다. npm 의존성 하나가 오염돼도, 광고나 분석 스크립트 하나가 뚫려도 같은 결과가 됩니다. 우리가 직접 쓴 코드를 아무리 검사해도 의존성 트리 전체를 매번 보증할 수는 없습니다. HttpOnly는 그 실수가 났을 때 토큰까지는 안 넘어가게 막아주는 안전망입니다. 완벽한 방어를 전제로 하는 설계보다, 방어가 뚫렸을 때 피해를 줄이는 설계가 팀 프로젝트에는 더 맞았습니다.

---

## 3. MySQL, MongoDB, Redis를 같이 쓴 이유

*원문 발행일 2025-11-11*

저장소를 하나로 갈지 나눌지가 두 번째 분기였습니다.

MySQL만 쓰면 관계와 트랜잭션은 편한데 채팅 메시지가 문제였습니다. 메시지는 초당 100~200건씩 계속 쌓이는데 관계형 테이블에 넣으면 인덱스 유지 비용이 그대로 붙습니다. MongoDB만 쓰면 쓰기는 빠르지만 회원과 상품, 주문처럼 관계가 얽힌 도메인을 다루기 불편하고 트랜잭션 보장도 약해집니다.

그래서 직접 재봤습니다. 같은 조건에서 메시지 하나를 넣는 데 MySQL은 약 15ms, MongoDB는 약 5ms였습니다. 3배 차이입니다.

MySQL의 JSON 컬럼으로 절충할까도 봤지만 접었습니다. 읽을 때마다 파싱 비용이 붙고, 내부 필드로 인덱스를 걸기 어려우며, 같은 문서를 동시에 수정할 때 통째로 덮어쓰는 문제가 생깁니다.

![](/uploads/project/Joying/mysql-mongodb-redis-why/mysql-json-column-issues.svg)

결론은 데이터 성격대로 나누는 것이었습니다. 회원과 상품, 채팅방처럼 관계가 중요한 데이터는 MySQL에, 채팅 메시지처럼 쓰기가 잦고 스키마가 유연해야 하는 데이터는 MongoDB에, 세션과 안읽은 개수처럼 순간 조회가 잦은 데이터는 Redis에 뒀습니다.

![](/uploads/project/Joying/mysql-mongodb-redis-why/chat-message-mongodb.svg)
![](/uploads/project/Joying/mysql-mongodb-redis-why/chat-room-mysql.svg)

한 가지 주의한 건 경계였습니다. 채팅방은 MySQL, 그 방의 메시지는 MongoDB에 있으니 둘 사이에 트랜잭션이 걸리지 않습니다. 그래서 메시지 저장 실패가 채팅방 상태를 깨뜨리지 않도록, 방 정보는 MySQL 트랜잭션 안에서만 다루고 메시지는 별도로 처리했습니다.

---

## 4. Kafka는 우리에게 과했다

*원문 발행일 2025-11-16*

채팅은 양방향 실시간 통신이 필요합니다. 폴링은 쓸데없는 요청이 너무 많고 SSE는 단방향이라 WebSocket으로 갔습니다. 남은 문제는 서버를 여러 대로 늘렸을 때 메시지를 어떻게 브로드캐스트할 것인가였습니다.

Kafka가 먼저 떠올랐지만 설정이 부담이었습니다. 브로커와 주키퍼 또는 KRaft 구성에 토픽과 파티션 설계까지 붙는데, EC2 t3.medium 한 대에 Spring Boot와 MySQL, MongoDB, Redis가 이미 올라가 있었습니다. 새 클러스터를 띄울 메모리가 없었습니다.

![](/uploads/project/Joying/kafka-was-overkill/kafka.svg) RabbitMQ는 Exchange와 Queue, Binding을 설계해야 하는데 1:1 채팅에 그 유연성이 필요하지 않았습니다. Redis Stream은 소비자 그룹과 재처리가 필요한 작업 큐에 맞는 물건이고, NATS는 가볍지만 결국 새 인프라를 하나 더 배우고 띄우는 일이었습니다.

Redis는 이미 세션 저장소로 띄워둔 상태였습니다. Pub/Sub은 별도 설정 없이 바로 쓸 수 있고, 우리가 잡아둔 초당 100~200건 기준으로 여유가 1,000배 이상이었습니다. 메시지 영속화는 어차피 MongoDB가 맡으니, Pub/Sub이 전달만 책임지면 됐습니다.

Pub/Sub의 약점은 알고 갔습니다. 구독자가 없는 순간에 발행된 메시지는 사라집니다. 다만 우리 구조에서는 MongoDB에 먼저 저장하고 Pub/Sub으로 알리는 순서라, 전달이 실패해도 데이터는 남고 재접속 시 다시 읽어옵니다.

WebSocket 위에는 STOMP를 얹었습니다. Raw WebSocket은 메시지 형식과 라우팅, 구독 관리를 전부 직접 만들어야 하고, Socket.io는 자체 프로토콜이라 Spring 생태계와 붙이기 번거로웠습니다. STOMP는 Spring이 기본 지원하고 목적지 기반 구독이 채팅방 구조에 그대로 맞았습니다.

![](/uploads/project/Joying/kafka-was-overkill/stomp.svg)
![](/uploads/project/Joying/kafka-was-overkill/conclusion.png)

---

## 5. 메시지 순서를 보장하는 법

*원문 발행일 2025-11-21*

메시지가 뒤섞이는 채팅은 채팅이 아닙니다. 그런데 순서에는 두 가지가 섞여 있습니다. 화면에 도착하는 순서와 DB에 저장되는 순서입니다. 단일 서버에서는 둘이 거의 일치하지만, 서버가 늘어나면 갈라집니다. 서버 A와 B가 각자 받은 메시지를 각자의 시계로 찍으면 순서가 어긋납니다.

![](/uploads/project/Joying/chat-message-ordering/server-scaling.svg)

해결책을 셋 검토했습니다.

채팅방마다 시퀀스 번호를 매기는 방식은 순서가 확실하지만 번호를 발급하는 지점이 병목이 되고, 그 지점이 죽으면 채팅 전체가 멈춥니다. 벡터 클락은 분산 환경에서 인과관계까지 표현할 수 있지만 1:1 채팅에 쓰기에는 구현과 저장 비용이 과했습니다. Kafka 파티션은 파티션 단위 순서를 보장해주지만, 그러려면 Kafka를 도입해야 하는데 4장에서 이미 접은 선택지였습니다.

남은 게 서버 타임스탬프였습니다. 메시지를 받은 서버가 저장 시점에 시각을 찍고, 클라이언트는 그 값으로 정렬합니다. 클라이언트 시계는 믿지 않습니다.

![](/uploads/project/Joying/chat-message-ordering/server-timestamp.svg) 사용자 기기 시간은 얼마든지 어긋날 수 있어서, 순서의 기준은 항상 서버가 쥐게 했습니다.

역할도 나눴습니다. 서버는 정렬 기준이 되는 값을 정확히 찍는 데까지만 책임지고, 화면에 어떤 순서로 보일지는 프론트가 그 값으로 정렬해 결정합니다. 이렇게 나누니 재접속해서 과거 메시지를 다시 불러올 때도 같은 기준으로 합쳐집니다.

![](/uploads/project/Joying/chat-message-ordering/role-separation.svg)

단일 서버 환경이라 여기까지가 필요한 전부였습니다. 서버가 여러 대가 되면 시계 동기화가 새 변수로 들어오는데, 그건 다음 과제로 남겼습니다.

---

## 6. 채팅방 목록 1,350ms를 85ms로

*원문 발행일 2025-11-26*

채팅방 목록 하나를 그리는 데 필요한 정보가 생각보다 많았습니다. 채팅방 기본 정보와 상품 제목, 썸네일, 상대방 닉네임과 프로필, 마지막 메시지, 고정과 알림끄기 같은 방 설정까지 MySQL에서 가져오고, 안읽은 메시지 개수는 MongoDB에서 세야 했습니다.

가장 직관적으로 구현하고 재봤습니다. 채팅방 10개를 조회하는 데 1,350ms가 걸렸고, 방이 늘어날수록 선형으로 느려졌습니다.

> 측정 조건: EC2 t3.medium, Spring Boot 내장 Tomcat 기본 설정, 동시 접속 없는 단일 요청. MySQL과 MongoDB, Redis 모두 같은 서버.

### 원인은 N+1이었다

채팅방 10개를 조회하면 목록 쿼리 1번에 더해 Product, Member, ProductFile, ChatRoomMember를 각각 N번씩 Lazy Loading하고, MongoDB count도 N번 나갔습니다. 총 `1 + 5N`으로 51번입니다.

그중 가장 느린 건 MongoDB count였습니다. 한 번에 평균 100ms가 걸렸습니다. 네트워크 왕복에 인덱스 탐색, 조건에 맞는 개수 계산까지 붙으니 디스크 I/O가 병목이었습니다. MongoDB가 느린 게 아니라 쿼리를 너무 많이 날리는 게 문제였습니다.

![](/uploads/project/Joying/chatroom-list-slow-query/problem-2.svg)

### 반정규화를 먼저 시도했다가 접었다

MySQL 쪽에 `unreadCount` 컬럼을 두면 MongoDB를 안 봐도 되지 않을까 싶었습니다. 세 가지에서 막혔습니다.

메시지는 MongoDB에 쌓이는데 카운트는 MySQL에 있으니 둘 사이가 어긋날 수 있습니다. 어긋나지 않게 하려면 두 저장소에 걸친 분산 트랜잭션이 필요한데, 6주 일정에 그걸 넣는 건 무리였습니다. 게다가 같은 방에 메시지가 동시에 들어오면 카운트 갱신이 서로를 덮어씁니다.

![](/uploads/project/Joying/chatroom-list-slow-query/mysql-denormalization.svg)

### Redis 캐싱으로 방향을 바꿨다

애플리케이션 메모리 캐시는 서버가 늘어나면 인스턴스마다 값이 달라집니다. MongoDB Aggregation Pipeline은 쿼리를 한 번으로 줄여주지만 결국 매번 디스크를 봅니다. Redis는 이미 세션과 Pub/Sub으로 띄워둔 상태라 새 인프라가 필요 없었고, 인메모리라 조회가 밀리초 아래로 끝납니다.

MySQL의 N+1은 Fetch Join과 배치 조회로 묶고, MongoDB의 N+1은 Redis로 걷어냈습니다.

![](/uploads/project/Joying/chatroom-list-slow-query/chatroom-list-improvement.svg)

### MGET으로 10번을 1번으로

캐시로 바꿔도 방 10개면 Redis를 10번 부르게 됩니다. 왕복이 10번 생깁니다.

```java
// 방마다 한 번씩 (왕복 10회)
rooms.forEach(r -> redis.get(key(r)));

// 한 번에 (왕복 1회)
redis.opsForValue().multiGet(rooms.stream().map(this::key).toList());
```

MGET으로 묶으니 네트워크 왕복이 한 번으로 줄었습니다. 캐시가 비어 있는 방만 MongoDB로 떨어뜨리고, 그 결과를 다시 채워 넣었습니다.

### 결과

| 지표 | Before | After | 개선 |
|------|--------|-------|------|
| 총 쿼리 수 | 51번 (1 + 5N, N=10) | 4번 | 92% 감소 |
| 총 소요 시간 | 1,350ms | 85ms | 16배 |
| 캐시 히트율 | 없음 (매번 MongoDB) | 95% | MongoDB 부하 95% 감소 |
| 캐시 미스 시 | | +100ms (MongoDB fallback) | 여전히 Before보다 빠름 |

페이지네이션도 같이 손봤습니다. Offset 방식은 100번째 페이지에서 450ms가 걸렸는데, 커서 기반으로 바꾸니 12ms가 됐습니다.

6주 프로젝트라 여기까지가 한계였습니다. 캐시 무효화는 메시지 수신과 읽음 처리 시점에 직접 걸어뒀지만, 서버가 여러 대로 늘었을 때의 캐시 동기화나 장애 주입 테스트까지는 가지 못했습니다.

---

## 7. 메시지마다 DB를 조회하던 권한 체크

*원문 발행일 2025-12-01*

채팅방 목록을 고치고 나니 이번엔 메시지 전송이 느렸습니다. 흐름을 뜯어보니 이랬습니다.

> 측정 조건: EC2 t3.medium 단일 요청 기준. MySQL과 MongoDB, Redis 모두 같은 서버라 네트워크 왕복은 0에 가깝습니다.

MySQL에서 채팅방 멤버십을 확인하는 데 30~50ms, MongoDB에 메시지를 저장하는 데 50~100ms, Redis Pub/Sub 발행에 1ms, 다시 MySQL에 lastMessage를 갱신하는 데 20~30ms. 합쳐서 106~192ms였습니다. 메시지를 열 개 연속으로 보내면 1~2초가 걸렸습니다.

권한 확인 자체는 필요합니다. 참여하지 않은 방이나 이미 나간 방에 메시지를 밀어 넣으려는 시도를 막아야 합니다.

![](/uploads/project/Joying/message-auth-db-check/why-permission-check.svg) 문제는 확인 방식이었습니다. 1:1 채팅이라 구매자와 판매자 두 명이 고정인데, 거의 변하지 않는 정보를 메시지마다 MySQL에 물어보고 있었습니다.

그래서 권한 정보를 Redis에 캐싱했습니다. 채팅방을 만들거나 나갈 때만 캐시를 갱신하고, 메시지를 보낼 때는 Redis만 봅니다. 캐시가 비어 있으면 MySQL에서 읽어 다시 채웁니다.

![](/uploads/project/Joying/message-auth-db-check/flow-diagram.png)

이건 읽기와 쓰기를 나눈 것이기도 합니다. 채팅방 생성은 MySQL이 진실이고 정확성이 우선입니다. 권한 확인은 Redis에서 하고 성능이 우선이며, 어긋나면 MySQL에서 복구합니다. 두 경로를 나누니 각각을 따로 최적화할 수 있었습니다.

lastMessage 갱신은 응답 경로에서 뺐습니다. 사용자가 메시지를 보낸 순간에 꼭 끝나야 하는 일이 아니라 비동기로 돌렸습니다.

| 지표 | Before | After |
|------|--------|-------|
| 권한 확인 | 30ms | 1ms |
| lastMessage 업데이트 | 20ms (동기) | 0ms (비동기) |
| 메시지 전송 총 시간 | 101ms | 52ms |

---

## 8. Coroutine에서 JPA가 401을 뱉었다

*원문 발행일 2025-12-06*

채팅방 목록에서 캐시가 빗나가면 MongoDB를 여러 번 조회해야 합니다. 방이 열 개고 미스가 다섯이면 다섯 번입니다. Coroutine의 `async`로 묶으면 순차로 다섯 번 기다리던 것이 가장 오래 걸리는 한 번으로 줄어듭니다. 그래서 REST API 쪽에도 코루틴을 들였는데, 여기서 문제가 시작됐습니다.

같은 토큰으로 채팅방 생성은 되는데 목록 조회만 401이 떴습니다. 반나절 동안 JWT와 Security 설정만 의심했습니다.

로그를 끝까지 읽고서야 알았습니다. 실제로 터진 건 401이 아니라 `LazyInitializationException`이었습니다.

```
org.hibernate.LazyInitializationException:
could not initialize proxy - no Session
```

`withContext(Dispatchers.IO)`는 스레드를 바꿉니다. Hibernate Session은 ThreadLocal에 매여 있어서 새 스레드에서는 Session을 못 찾습니다.

![](/uploads/project/Joying/coroutine-jpa-401/coroutine-hibernate-session.png) 여기까지는 논리적입니다. 문제는 그다음이었습니다. Spring Security 필터 체인 안에서 예외가 나면 `ExceptionTranslationFilter`가 이걸 인증 실패로 간주해 401로 바꿔 내보냅니다. 원인과 증상이 완전히 다른 얼굴을 하고 있었던 겁니다.

![](/uploads/project/Joying/coroutine-jpa-401/create-vs-list-api.svg)

고치는 방법은 넷을 봤습니다. Eager Loading은 안 쓰는 데이터까지 매번 끌어옵니다. Batch Query는 동작하지만 코드가 복잡해집니다. Fetch Join은 한 번의 쿼리로 필요한 걸 다 가져오면서 N+1도 같이 풀립니다.

결국 `runBlocking`으로 스레드 전환 자체를 막고, Fetch Join으로 필요한 데이터를 미리 로딩하는 이중 안전장치를 걸었습니다.

![](/uploads/project/Joying/coroutine-jpa-401/fetch-join-final.svg)

| 지표 | Before | After |
|------|--------|-------|
| 쿼리 수 | 20~30개 | 3개 |
| 응답 시간 | 200ms 이상 | 65~95ms |
| 에러 | LazyInitializationException | 없음 |

여기서 두 가지를 배웠습니다. 하나는 에러 메시지와 실제 원인이 완전히 다를 수 있으니 추측보다 스택트레이스를 끝까지 읽어야 한다는 것입니다. 다른 하나는 Spring MVC와 Coroutine 조합이 Hibernate나 Security 같은 ThreadLocal 기반 인프라와 부딪힌다는 것입니다. 같은 목적이라면 기존 코드와 호환되는 가상 스레드가 더 자연스러운 선택이었을 겁니다.

---

## 9. Inbound Thread를 빨리 반환하기

*원문 발행일 2025-12-11*

Netty나 Ktor 같은 라이브러리는 EventLoop 방식이라 스레드 풀을 신경 쓸 일이 별로 없습니다. Spring WebSocket STOMP는 다릅니다. 클라이언트에서 들어오는 메시지를 처리하는 Inbound와 나가는 메시지를 보내는 Outbound에 각각 스레드 풀이 있습니다.

`clientInboundChannel`의 기본 corePoolSize는 CPU 코어 수의 두 배입니다. t3.medium은 2 vCPU라 스레드 4개가 모든 사용자의 메시지 전송을 처리하고 있었습니다.

메시지 한 건을 처리할 때 이 스레드가 무엇을 하는지 뜯어봤습니다. MongoDB에 쓰고 응답을 기다리고, Redis Pub/Sub을 발행하고 기다리고, 안읽음 카운터를 올리고 기다립니다. 정작 CPU가 일하는 시간은 파싱과 DTO 변환 정도로 아주 짧고 나머지는 전부 대기입니다.

![](/uploads/project/Joying/inbound-thread-optimization/blocking-io.png)

문제의 핵심은 평균 속도가 아니라 결합이었습니다. 동기 구조에서 처리량 상한은 스레드 수를 메시지당 I/O 시간으로 나눈 값에 묶입니다. 평소에는 I/O가 밀리초라 티가 안 나지만, MongoDB가 디스크 flush나 락 경합으로 한 번 튀는 순간 스레드 4개가 전부 그 지연에 함께 잡히고 모든 사용자의 메시지 수신이 같이 멈춥니다.

그래서 I/O 작업을 Coroutine으로 넘기고 Inbound Thread는 디스패치 후 바로 반환하게 했습니다.

![](/uploads/project/Joying/inbound-thread-optimization/coroutine-applied.svg)

| 관점 | Before (동기) | After (Coroutine) |
|------|--------|-------|
| Inbound Thread 점유 | I/O 완료까지 대기 | 디스패치 후 즉시 반환 |
| 처리량 상한 | 스레드 수 ÷ 메시지당 I/O 시간 | I/O 지연과 분리 |
| MongoDB 지연 스파이크 | 전체 메시지 수신 정체로 전파 | Dispatchers.IO 안에 격리 |
| 실제 병목 지점 | Inbound Thread Pool | MongoDB/Redis I/O 대역폭 |

I/O 작업의 총 소요 시간 자체는 그대로입니다. 병목이 스레드 풀 크기에서 I/O 대역폭으로 옮겨간 것이 핵심입니다.

솔직한 한계도 적어둡니다. 이건 진짜 논블로킹이 아닙니다. `Dispatchers.IO` 스레드는 여전히 I/O가 끝날 때까지 블로킹되고, 대기가 사라진 게 아니라 자리를 옮긴 것뿐입니다. 진짜 논블로킹이 되려면 Reactive MongoDB 드라이버가 필요합니다. 그리고 당시 테스트 규모인 동시 접속 20명에 초당 10~20건이면 동기 구조로도 버틸 수 있었습니다. 이 전환의 가치는 그 시점의 처리량 숫자가 아니라, I/O 지연 스파이크가 메시지 수신 경로 전체를 멈추지 못하게 만든 구조에 있습니다.

---

## 10. WebSocket이 끊기면 메시지를 잃는다

*원문 발행일 2025-12-16*

성능은 잡았는데 모바일 테스트에서 다른 게 나왔습니다. 채팅하다 와이파이가 끊겼다가 다시 연결하면 그사이 메시지가 오지 않는다는 것이었습니다.

```
[사용자 A - 모바일]
10:00:00 - "안녕하세요" 전송 (성공)
10:00:05 - WiFi 끊김 (지하철 터널)

[사용자 B - 웹]
10:00:10 ~ 10:00:20 - 메시지 3건 전송

[사용자 A - 모바일]
10:00:25 - WiFi 재연결 후 채팅방 진입
→ "안녕하세요" 이후 메시지가 없음
```

원인은 Redis Pub/Sub의 성격이었습니다. Pub/Sub은 메시지를 저장하지 않습니다. 발행 시점에 구독 중인 클라이언트에게만 보내고 즉시 버립니다. 연결이 끊겨 있던 동안 발행된 건 영영 받을 수 없습니다.

![](/uploads/project/Joying/websocket-message-loss/chat-message-service.svg)

다행히 메시지 자체는 MongoDB에 다 있었습니다. 유실된 건 실시간 전달 경로뿐이었습니다. 그래서 재연결할 때 놓친 구간을 다시 읽어오게 했습니다.

기존에는 스크롤로 과거 메시지를 불러오는 API와 재연결용 API를 따로 둘 생각이었는데, 하나로 합쳤습니다. 기준 시각 이전을 최신순으로 주면 스크롤이고, 이후를 오래된순으로 주면 재연결 복구입니다.

```
스크롤:   GET /api/chat-rooms/123/messages?before=...&size=20
재연결:   GET /api/chat-rooms/123/messages?after=...&size=50
```

MongoDB에는 `chatRoomId`와 `createdAt` 복합 인덱스를 걸어 이 조회를 받쳤습니다.

![](/uploads/project/Joying/websocket-message-loss/unified-api.svg)
![](/uploads/project/Joying/websocket-message-loss/client-reconnection.svg)

> 측정 조건: EC2 t3.medium, 10명 동시 접속, 모바일 네트워크를 껐다 켜는 방식으로 끊김 시뮬레이션.

| 시나리오 | Before | After |
|----------|--------|-------|
| 네트워크 끊김 후 재연결 | 중간 메시지 유실 | 모든 메시지 복구 |
| 재연결 시 복구 소요 시간 | 복구 불가 | 50~100ms (20건 기준) |
| API 개수 | 2개 (스크롤 + 재연결) | 1개 (통합) |

---

## 11. 서버 여러 대로 확장하려면

*원문 발행일 2025-12-21*

Spring이 기본으로 주는 SimpleBroker는 구독 정보를 서버 메모리에 들고 있습니다. 서버가 한 대일 때는 문제가 없지만, 두 대로 늘리는 순간 A 서버에 붙은 사용자와 B 서버에 붙은 사용자가 서로의 메시지를 못 받습니다.

방법을 셋 봤습니다. Sticky Session은 로드밸런서가 같은 사용자를 늘 같은 서버로 보내는 방식인데, 그 서버가 죽으면 세션이 통째로 날아가고 서버별 부하도 고르지 않습니다. RabbitMQ를 STOMP 브로커로 쓰면 정석이지만 4장에서 접었던 이유가 그대로 남아 있었습니다. 새 인프라를 띄울 메모리가 없었습니다.

그래서 Redis에 세션을 두는 쪽으로 갔습니다. 누가 어느 서버에 붙어 있는지를 Redis가 알고 있으면, 메시지를 보낼 때 방 구독자 목록이 아니라 `memberId`를 기준으로 Pub/Sub에 실어 보내면 됩니다. 각 서버는 자기에게 붙은 사용자만 골라 내려보냅니다. SimpleBroker의 메모리 구독 정보에 기대지 않으니 서버가 몇 대든 같은 방식으로 동작합니다.

![](/uploads/project/Joying/server-scaling-troubleshooting/redis-session-management.png)

확장하면서 두 가지를 같이 고쳤습니다.

시간 타입을 `LocalDateTime`에서 `Instant`로 옮겼습니다. `LocalDateTime`은 시간대 정보가 없어서 서버 시간대 설정이 다르면 같은 시각이 다르게 해석됩니다. 서버가 여러 대가 되면 이게 바로 순서 문제로 번집니다.

페이지네이션은 Offset에서 커서 기반으로 바꿨습니다. Offset은 뒤로 갈수록 앞의 행을 전부 세고 버리기 때문에 100번째 페이지에서 450ms가 걸렸습니다. 마지막으로 본 지점을 커서로 넘기는 방식으로 바꾸니 12ms가 됐습니다.

![](/uploads/project/Joying/server-scaling-troubleshooting/offset-paging-problem.svg)

브라우저 호환은 SockJS로 받쳤습니다. WebSocket을 막는 네트워크에서도 폴백으로 연결이 유지됩니다.

![](/uploads/project/Joying/server-scaling-troubleshooting/final-architecture.png)

---

## 12. 13년 묵은 Redis 취약점

*원문 발행일 2025-12-26*

프로젝트 막바지에 CVE-2025-49844가 공개됐습니다. Redis의 Lua 스크립팅 엔진에 있던 Use-After-Free 취약점으로, CVSS 10.0에 원격 코드 실행까지 가능한 등급이었습니다. 13년 동안 코드에 남아 있던 것이라 RediShell이라는 이름이 붙었습니다.

우리 서버에도 있었습니다.

```bash
$ docker exec redis redis-server --version
Redis server v=7.0.15
```

취약 버전 범위 안이었습니다. 다행히 인증이 걸려 있고 외부에 포트를 열어두지 않아 즉시 공격당할 상태는 아니었지만, 그 두 가지가 안전의 근거가 되어서는 안 됐습니다. 컨테이너 하나만 잘못 열려도 바로 통하는 경로였습니다.

7.2.11로 올렸습니다. docker-compose의 이미지 태그를 바꾸고 컨테이너를 다시 올린 뒤, 기존 세션과 캐시가 정상 동작하는지 확인했습니다. 이 패치 하나에 Lua 엔진 관련 취약점과 HyperLogLog OOB Write까지 여섯 건이 함께 잡혔습니다.

버전만 올리고 끝내지는 않았습니다. 우리가 Lua 스크립팅을 쓰지 않으니 아예 비활성화했고, Redis를 애플리케이션과 같은 도커 네트워크 안에만 두고 호스트 포트 노출을 끊었으며, 방화벽에서도 해당 포트를 막았습니다. 같은 취약점이 또 나와도 도달 경로가 없게 만드는 쪽입니다.

패치 후 성능은 차이가 없었습니다.

여기서 배운 게 셋입니다.

기본값은 안전하지 않습니다. Redis는 기본 설정에서 Lua 스크립팅이 켜져 있고, 우리는 쓰지도 않으면서 그대로 두고 있었습니다. 쓰지 않는 기능이 켜져 있는 것 자체가 공격 면입니다.

보안 업데이트는 미룰 항목이 아닙니다. 6주 프로젝트의 마감 직전이었지만 이건 기능 하나 더 넣는 것보다 우선이었습니다.

그리고 방어는 겹쳐야 합니다. 버전을 올리는 것과 기능을 끄는 것, 네트워크를 격리하는 것, 방화벽을 거는 것 중 하나만으로는 부족합니다. 어느 한 겹이 뚫려도 다음 겹이 남아 있어야 합니다.

---

## 13. 팀원 이탈과 6주의 회고

*원문 발행일 2025-11-20*

### 그 외 구현: AI 자동 게시글 생성

판매자가 대여료를 얼마로 정해야 할지 모르겠다는 문제가 있었습니다. 4단계 파이프라인으로 자동화했습니다. GPT-4o Vision으로 이미지에서 물건 상태를 파악하고, 네이버 쇼핑 API로 시세를 조사한 뒤, 둘을 결합해 적정 대여료와 게시글 초안을 생성합니다.

![AI 자동 게시글 생성](/uploads/project/Joying/retrospective/langchain.gif)

### 담당자가 빠진 자리

3주차에 에스크로 결제 담당자가 취업으로 팀을 떠났습니다. DB 스키마는 있었지만 서비스 로직은 판매 플로우만 구현된 상태였고, 남은 팀원 중 아무도 이어받으려 하지 않았습니다.

제가 맡았습니다. 토스페이먼츠 에스크로 문서를 3일간 분석하고, 빌리는 사람 관점의 역방향 로직을 구현해 양방향 거래 플로우를 완성했습니다. 마감 1주일 전에는 10개 화면 중 7개가 API 연동 없이 하드코딩된 상태라는 걸 발견했습니다. Swagger로 API 문서를 자동 생성한 뒤 연동이 안 된 화면은 직접 React 코드를 수정해 배포 전날까지 모든 화면 연동을 끝냈습니다.

### 배운 것

추측보다 측정이 먼저였습니다. MongoDB가 쓰기에 빠르다거나 Kafka가 더 안정적이라는 통념이 우리 상황에서도 맞는지 직접 재봤습니다. 측정 없이 도구를 고르면 오버 엔지니어링이나 병목 둘 중 하나로 빠집니다.

더 강력한 도구가 더 나은 선택은 아니었습니다. Kafka와 RabbitMQ를 의도적으로 배제하고 Redis Pub/Sub을 택한 것이 이 프로젝트에서 가장 잘한 판단 중 하나였습니다. 규모에 맞지 않는 인프라는 운영 부담만 키웁니다.

6주 프로젝트의 한계도 인정합니다. 수치는 대부분 단일 서버와 추정 트래픽 기반이고, k6 같은 대규모 부하 테스트나 실제 멀티 인스턴스 운영까지는 가지 못했습니다. 멀티 서버 캐시 동기화와 장애 주입 테스트는 다음 과제로 남았습니다.

그리고 기다리기보다 직접 움직이는 편이 나았습니다. 담당자가 빠진 기능과 연동이 안 되는 화면은 기다린다고 해결되지 않습니다. 먼저 손을 들면 프로젝트가 진행됩니다. 백엔드 개발자가 프론트 코드를 만질 수 있으면 병목을 직접 풀 수 있다는 것도 배웠습니다. 다만 이건 마감 위기에서의 임시 대응이지 평소에 역할 경계를 흐리자는 뜻은 아닙니다.

### 핵심 수치

| 항목 | Before | After | 방법 |
|------|--------|-------|------|
| 채팅방 목록 조회 | 1,350ms (51쿼리) | 85ms (4쿼리, 16배) | Fetch Join + Redis MGET + Coroutine 병렬 |
| 페이지네이션(100p) | 450ms | 12ms | Offset에서 커서 기반으로 |
| 메시지 Insert | MySQL 약 15ms | MongoDB 약 5ms (3배) | Polyglot Persistence |
| 메시징 여유 | | 추정 트래픽의 1,000배 이상 | Redis Pub/Sub |
| Redis 보안 | 7.0.15 (CVSS 9.9 취약) | 7.2.11 + 다층 방어 | RediShell 긴급 패치 |

기술적으로 얻은 건 제약을 먼저 수치로 정의하고 통념 대신 측정으로 트레이드오프를 판단하는 법이었습니다. 팀 관점에서 얻은 건 위기 대응 능력이 기술적 완성도만큼 프로젝트 성패를 가른다는 것이었습니다. 팀원 이탈이라는 위기 속에서도 서비스를 완성한 경험이 심사에서 좋게 평가받아 삼성 우수상으로 이어졌다고 생각합니다.

---

## 참고 자료

### Lombok과 코틀린이 안 맞는 이유

- [Kotlin Lombok Compiler Plugin (공식 문서)](https://kotlinlang.org/docs/lombok.html)
- [io.freefair.lombok Gradle Plugin](https://plugins.gradle.org/plugin/io.freefair.lombok)
- [Kotlin 1.7.20 Release Notes](https://kotlinlang.org/docs/whatsnew1720.html#support-for-the-lombok-compiler-plugin)
- [Lombok delombok 사용법](https://projectlombok.org/features/delombok)
- Kotlin 2.1.0
- Spring Boot 3.5.6
- Gradle 8.x
- Java 17
- Lombok (버전은 io.freefair.lombok 플러그인이 자동 관리)

### JWT를 쿠키에 둔 이유와 SameSite 사고

- [CISA - Malware Discovered in Popular NPM Package, ua-parser-js](https://www.cisa.gov/news-events/alerts/2021/10/22/malware-discovered-popular-npm-package-ua-parser-js)
- [Rapid7 - NPM Library (ua-parser-js) Hijacked](https://www.rapid7.com/blog/post/2021/10/25/npm-library-ua-parser-js-hijacked-what-you-need-to-know/)
- [The Hacker News - 25 Malicious npm Packages](https://thehackernews.com/2022/02/25-malicious-javascript-libraries.html)
- [Rapid7 - Cloudflare Cloudbleed Vulnerability](https://www.rapid7.com/blog/post/2017/02/24/cloudflare-data-leakage-or-dare-i-saycloudbleed/)
- [인기있는 NPM 라이브러리 하이잭 사고](https://blog.alyac.co.kr/4213)
- [디스코드 서버 하이재킹하는 악성 패키지](https://m.boannews.com/html/detail.html?idx=103228)
- [colors.js와 faker.js 사태가 준 교훈](https://yceffort.kr/2022/01/npm-colors-fakerjs)
- [OWASP - Token Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/JSON_Web_Token_for_Java_Cheat_Sheet.html)
- [Auth0 - Token Storage Best Practices](https://auth0.com/docs/secure/security-guidance/data-security/token-storage)
- [OWASP - XSS (Cross Site Scripting)](https://owasp.org/www-community/attacks/xss/)
- [GDSC UOS - JWT HTTPS Cookie 사용한 보안 로그인](https://gdsc-university-of-seoul.github.io/Login-by-JWT-HTTPS-COOKIE/)
- [velog - JWT의 안전한 저장소](https://velog.io/@kmlee95/JWT의-안전한-저장소)
- [velog - 프론트에서 안전하게 로그인 처리하기](https://velog.io/@yaytomato/프론트에서-안전하게-로그인-처리하기)
- [web.dev - SameSite cookies explained](https://web.dev/i18n/ko/samesite-cookies-explained/)
- [Google Developers - Get Ready for New SameSite=None; Secure Cookie Settings](https://developers.google.com/search/blog/2020/01/get-ready-for-new-samesitenone-secure)
- [HAHWUL - Cookie and SameSite](https://www.hahwul.com/2020/01/18/samesite-lax/)
- [Microsoft Learn - SameSite 쿠키 변경 처리](https://learn.microsoft.com/ko-kr/azure/active-directory/develop/howto-handle-samesite-cookie-changes-chrome-browser)
- [MDN - SameSite cookies](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Set-Cookie/SameSite)
- [Vite - Server Proxy 공식 문서](https://vitejs.dev/config/server-options.html#server-proxy)
- [velog - Vite 프록시 설정하는 법](https://velog.io/@zerone/Vite-Proxy-%EC%84%A4%EC%A0%95%ED%95%98%EB%8A%94-%EB%B2%95)
- [velog - Cookie SameSite 설정하기](https://velog.io/@seowj0710/Cookie-SameSite-%EC%84%A4%EC%A0%95%ED%95%98%EA%B8%B0)
- [SK쉴더스 - XSS 공격 유형부터 보안대책까지](https://www.skshieldus.com/blog-security/security-trend-idx-06)
- [민트민 개발 블로그 - XSS 직접 사용해 보기](https://www.mintmin.dev/blog/2401/20240119)
- [민동준 Medium - XSS 공격을 직접 해보면서 알아보기](https://dj-min43.medium.com/xss-공격을-직접-해보면서-알아보기-c2c1d9baf7ec)
- [falsy.me - XSS, CSRF에 대하여](https://falsy.me/웹-취약점-공격-방법인-xss-csrf에-대하여-간단하게-알아보/)
- React 18
- Vite 5
- Axios 1.x
- Spring Boot 3.x

### 13년 묵은 Redis 취약점

- [Redis Security Advisory: CVE-2025-49844](https://redis.io/blog/security-advisory-cve-2025-49844/)
- [Redis 7.2.11 Release Notes](https://github.com/redis/redis/releases/tag/7.2.11)
- [Redis ACL Documentation](https://redis.io/docs/management/security/acl/)
- [Wiz Research: RediShell RCE Vulnerability](https://www.wiz.io/blog/wiz-research-redis-rce-cve-2025-49844)
- [Sysdig: Understanding CVE-2025-49844](https://www.sysdig.com/blog/cve-2025-49844-redishell)
- [The Hacker News: 13-Year-Old Redis Flaw](https://thehackernews.com/2025/10/13-year-redis-flaw-exposed-cvss-100.html)
- **Redis**: 7.0.15 → 7.2.11 (alpine)
- **패치 일자**: 2025년 10월

---
title: '설정은 있는데 동작하지 않습니다'
description: >-
  permitAll 목록, @Transactional, actuator exposure.include. 전부 있었지만
  전부 동작하지 않았습니다. 리팩토링 중 찾은 "있는데 무력한 설정" 여섯 가지와,
  추측을 세 번 틀린 뒤 DEBUG 로그 한 줄로 원인을 잡은 디버깅 기록입니다.
date: 2026-08-22
tags:
  - EduMeet
  - Spring Boot
  - Spring Security
  - Spring AOP
  - Actuator
  - Debugging
  - Testing
category: team/EduMeet
coverImage: /uploads/project/EduMeet/EduMeetTitle.png
draft: false
series: "EduMeet"
seriesOrder: 4
---

리팩토링을 하면서 같은 모양의 문제를 여섯 번 만났습니다. **설정은 정성껏 되어 있는데 아무 일도 하지 않는** 경우입니다.

코드 리뷰로는 잘 안 잡힙니다. 읽으면 맞는 코드로 보이거든요.

## 1. permitAll 목록 15줄이 전부 무의미했습니다

```java
.authorizeHttpRequests(authorize -> authorize
        .requestMatchers(
                "/api/v1/members/signup",
                "/api/v1/members/login",
                // ... 13개 더 ...
                "/api/v1/**"                    // ← 이게 마지막에 있었다
        ).permitAll()
        .anyRequest().authenticated()           // ← 사실상 죽은 코드
)
```

`/api/v1/**`가 목록에 있으면 **위에 나열한 경로들은 아무 의미가 없고, `anyRequest().authenticated()`도 도달하지 않습니다.** API 전체가 인증 없이 열려 있었습니다.

정성껏 쓴 15줄이 오히려 "인증이 설계되어 있다"는 착시를 만들었습니다.

### 테스트가 이걸 못 잡은 이유

기존 컨트롤러 테스트는 이렇게 되어 있었습니다.

```java
MockMvcBuilders.webAppContextSetup(context).build();
```

**이 방식은 시큐리티 필터 체인을 타지 않습니다.** 인증이 뚫려 있어도 전부 통과합니다. `@AutoConfigureMockMvc`는 필터를 적용합니다.

```java
@SpringBootTest
@AutoConfigureMockMvc      // ← 이래야 필터가 걸린다
class ApiAuthenticationRequiredTest {
    @Test
    void 보호대상_API_는_인증을_요구한다() throws Exception {
        mockMvc.perform(get("/api/v1/classroom"))
                .andExpect(status().isUnauthorized());
    }
}
```

## 2. 컨트롤러의 400 분기가 실행되지 않았습니다

서비스는 이렇게 되어 있었습니다.

```java
} catch (Exception e) {
    throw new RuntimeException("요약본 업로드 실패: " + e.getMessage(), e);
}
```

컨트롤러는 이렇게 받고 있었습니다.

```java
} catch (IllegalArgumentException e) {
    return ResponseEntity.badRequest().body(response);      // 절대 실행 안 됨
} catch (Exception e) {
    return ResponseEntity.internalServerError().body(response);
}
```

`IllegalArgumentException extends RuntimeException extends Exception`입니다. **검증 실패도 서비스의 catch에 걸려 RuntimeException으로 재포장되므로** 컨트롤러의 400 분기는 도달할 수 없습니다.

**존재하지 않는 ID를 보내도 400이 아니라 500이 나갔습니다.**

재포장을 걷어내고 전역 `@RestControllerAdvice`에 `IllegalArgumentException → 400`을 추가했습니다.

## 3. @Transactional이 무시되고 있었습니다

이건 조금 다른 종류입니다. 붙어 있는데 **프록시를 거치지 않아서** 안 먹는 경우입니다.

Spring의 `@Transactional`은 프록시 기반입니다. 같은 빈 안에서 `this.method()`로 부르면 프록시를 통과하지 않으므로 **어노테이션이 조용히 무시됩니다.** 예외도 경고도 없습니다.

요약본 업로드를 고치면서 이 문제를 정면으로 만났습니다. 원래 코드는 메서드 전체가 `@Transactional`이고 그 안에서 S3 업로드를 두 번 했습니다. **PDF 50MB를 올리는 동안 DB 커넥션을 계속 붙잡습니다.**

느린 I/O를 트랜잭션 밖으로 빼려면 이렇게 되어야 합니다.

```
검증        (트랜잭션 없음)
회의 조회    (짧은 읽기)
S3 업로드    (트랜잭션 없음 ← 여기가 오래 걸린다)
DB 기록      (짧은 쓰기)
```

그런데 오케스트레이션 메서드에서 `this.record(...)`를 부르면 `@Transactional`이 안 먹습니다. 별도 빈으로 쪼개거나 `TransactionTemplate`을 쓰는 수밖에 없는데, **트랜잭션 경계가 코드에 그대로 보이는** 쪽을 택했습니다.

```java
return transactionTemplate.execute(status -> {
    Meeting meeting = meetingRepository.findById(meetingId).orElseThrow(...);
    meeting.recordSummary(markdownUrl, pdfUrl);
    return ...;
});
```

어노테이션이 어디에 붙어 있고 누가 누구를 부르는지 추적하지 않아도 됩니다.

## 4. /actuator/prometheus가 404였습니다

```yaml
management.endpoints.web.exposure.include: health, info, metrics, prometheus
```

관측을 붙이려고 보니 이 설정이 이미 있었습니다. 그런데 엔드포인트는 404였습니다.

**`micrometer-registry-prometheus` 의존성이 없었습니다.**

> `include`는 **"있으면 열어라"** 이지 **"만들어라"** 가 아닙니다. Prometheus 엔드포인트는 `PrometheusMeterRegistry` 빈이 있을 때만 자동 구성됩니다.

그리고 의존성을 넣어도 **여전히 404**였습니다. 여기서 시간을 많이 썼습니다.

## 5. 추측을 세 번 틀렸습니다

원인을 찾는 과정이 이 글에서 제일 배운 부분입니다.

**첫 번째 추측** — "관리 포트를 분리했으니 `ManagementWebSecurityAutoConfiguration`이 자기 필터 체인으로 막는 거다." 그럴듯했습니다. health만 통과하고 나머지가 401인 건 딱 그 동작이거든요. 해당 자동 구성을 제외해봤습니다. **변화 없음.**

**두 번째 추측** — "`EndpointRequest.toAnyEndpoint()`가 자식 컨텍스트라 매칭에 실패한다." 경로 매칭으로 바꿨습니다. **변화 없음.**

**세 번째 추측** — "`requestMatchers(String)`이 MVC 핸들러 매핑에 의존해서 그렇다." URI로 직접 판단하는 매처로 바꿨습니다. **변화 없음.**

세 번 틀리고 나서 추측을 멈추고 로그를 켰습니다.

```
Secured GET /actuator/prometheus     ← 보안은 통과했다
Securing GET /error                  ← 그 다음 /error 로 갔다
→ 401 Unauthorized
```

**보안 문제가 아니었습니다.** 엔드포인트가 404라서 `/error`로 포워드됐고, **`/error`가 인증을 요구해서** 401이 된 것이었습니다.

## 6. 그래서 모든 에러가 401로 둔갑하고 있었습니다

이건 액추에이터만의 문제가 아니었습니다.

**Spring은 처리되지 않은 요청을 `/error`로 포워드합니다.** 이 경로가 `anyRequest().authenticated()`에 걸려 있으면 **404든 500이든 전부 401로 나갑니다.**

오타 난 URL을 호출한 클라이언트는 "인증이 잘못됐나"를 뒤지게 됩니다. 실제로 제가 그랬습니다.

```java
"/error"    // ← permitAll 에 추가
```

그리고 진짜 원인은 조건 평가 리포트(`debug=true`)에서 나왔습니다.

```
@ConditionalOnEnabledMetricsExport management.defaults.metrics.export.enabled is considered false
```

`management.prometheus.metrics.export.enabled: true`를 **명시해야** 레지스트리가 생성됐습니다.

찾기 어려웠던 결정적 이유는 이겁니다 — **`/actuator/metrics`는 200이었습니다.** "액추에이터는 되는데 prometheus만 안 된다"로 보이니 보안 설정만 계속 뒤졌습니다.

## 7. 덤: 관리 포트를 분리하면 헬스체크가 깨집니다

지표는 URI 패턴, 호출량, 커넥션 수 같은 내부 정보를 담습니다. 인터넷에 열린 8080에 두고 싶지 않아서 관리 포트를 9090으로 분리했습니다.

그런데 **포트를 분리하면 액추에이터가 서비스 포트에서 통째로 사라집니다.**

```dockerfile
HEALTHCHECK CMD curl -fsS http://localhost:8080/actuator/health || exit 1
```

Dockerfile이 8080을 보고 있었습니다. 그대로 뒀으면 **컨테이너가 영영 unhealthy로 남았을 겁니다.** 테스트가 잡았습니다.

```java
@Test
void health_moves_to_management_port() {
    assertThat(get(managementPort, "/actuator/health").getStatusCode())
            .isIn(HttpStatus.OK, HttpStatus.SERVICE_UNAVAILABLE);

    assertThat(get(serverPort, "/actuator/health").getStatusCode())
            .as("포트를 분리하면 액추에이터는 서비스 포트에서 통째로 사라진다")
            .isNotEqualTo(HttpStatus.OK);
}
```

그리고 포트 분리 여부를 이렇게 판단하려다 또 틀렸습니다.

```java
boolean separated = managementPort != serverPort;    // ← 틀림
```

`management.server.port=0`(임의 포트)이면 `server.port`도 0일 수 있어서 **"같은 포트"로 잘못 판정됩니다.** Boot가 이미 이 판단을 하고 있고, 0을 DIFFERENT로 칩니다.

```java
if (ManagementPortType.get(environment) == ManagementPortType.DIFFERENT) { ... }
```

## 배운 것

**여섯 개 전부 "설정이 없어서"가 아니라 "설정이 있는데 무력해서" 생긴 문제였습니다.**

| | 있었던 것 | 실제 |
|---|---|---|
| 1 | permitAll 15줄 | 마지막 한 줄이 전부 무효화 |
| 2 | 400 분기 | 도달 불가능한 코드 |
| 3 | `@Transactional` | 프록시를 안 거쳐 무시 |
| 4 | `exposure.include` | 레지스트리가 없어 404 |
| 5 | 보안 규칙 | 원인은 보안이 아니었음 |
| 6 | HEALTHCHECK | 포트가 옮겨가서 무효 |

그래서 전부 테스트로 고정했습니다. **"고쳤다"는 주장이 아니라 "회귀하면 깨진다"는 장치로요.** 설정 파일을 읽어서 확인할 수 있는 문제가 아니었으니까요.

그리고 디버깅에 대해 하나 — **세 번 연속 틀린 추측을 하고 나서야 로그를 켰습니다.** 각 추측은 그럴듯했고, 코드를 고치는 데 시간이 들었고, 전부 헛수고였습니다. 두 번째 실패에서 멈췄어야 했습니다.

---

- PR: [#31 AI 연동 재설계](https://github.com/dj258255/edumeet/pull/31) · [#32 관측 기반](https://github.com/dj258255/edumeet/pull/32)
- 관측 설계 기록: [`docs/ops/04-observability.md`](https://github.com/dj258255/edumeet/blob/master/docs/ops/04-observability.md)

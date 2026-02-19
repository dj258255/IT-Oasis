---
title: 'MapStruct 사용한 이유'
titleEn: 'Why We Used MapStruct'
description: 레이어 간 객체 변환에서 수동 매핑의 문제를 분석하고, MapStruct로 컴파일 타임 매핑 코드를 자동 생성하는 전략을 정리한다.
descriptionEn: Analyzes problems with manual mapping between layers and documents the strategy of auto-generating compile-time mapping code with MapStruct.
date: 2025-12-07T00:00:00.000Z
tags:
  - MapStruct
  - DTO
  - Domain Model
  - Object Mapping
  - Spring Boot
category: project/Tymee
draft: false
coverImage: "/uploads/project/Tymee/mapstruct-usage/manual-mapping-problem.png"
---

> 이 프로젝트에서 MapStruct를 어디에 쓰고, 어디에 안 쓰는지 정리한다.

---

## 왜 MapStruct를 쓰나

### 불변 객체와 가변 객체

이 프로젝트는 레이어별로 객체 특성이 달라요:

- **Domain**: 불변 객체. 생성 후 상태 변경 시 새 객체 반환하거나 명시적 메서드로만 변경해요.
- **Entity**: 가변 객체. JPA가 프록시로 감싸서 dirty checking 하려면 setter나 필드 직접 접근이 필요해요.
- **DTO (Request)**: 불변 객체. Java record 사용. 클라이언트에서 받은 값 그대로 유지해요.
- **DTO (Response)**: 불변 객체. Java record 사용.

문제는 이 객체들 사이에서 변환이 필요하다는 거예요:

```
Request DTO → Domain → Entity (저장)
Entity → Domain → Response DTO (조회)
```

### 수동 변환의 문제

![manual-mapping-problem](/uploads/project/Tymee/mapstruct-usage/manual-mapping-problem.png)


필드 순서 틀리거나 하나 빠뜨리면 컴파일 에러도 안 나고 런타임에 이상한 값이 들어가요.
MapStruct는 컴파일 타임에 매핑 코드를 생성해서 이런 실수를 방지합니다.

### 부분 업데이트 (PATCH)

설정 변경 API는 보통 전체가 아니라 일부만 바꿔요:

```json
{ "pushEnabled": false }  // 푸시만 끄고 나머지는 유지
```

이걸 처리하려면:

![partial-update-problem](/uploads/project/Tymee/mapstruct-usage/partial-update-problem.png)


MapStruct의 `@BeanMapping(nullValuePropertyMappingStrategy = IGNORE)`나 default 메서드로 이걸 깔끔하게 처리할 수 있어요.

---

## 현재 사용 현황

| 모듈 | MapStruct | 이유 |
|------|-----------|------|
| user | O | 필드 많고 변환 로직 복잡함 |
| upload | X | 단순 변환, 추가 파라미터 필요 |
| auth | X | DTO 변환 거의 없음 |
| core | X | 유틸/설정만 있음 |

---

## user 모듈: MapStruct 사용

### UserMapper

![user-mapper](/uploads/project/Tymee/mapstruct-usage/user-mapper.png)


User 도메인은 Value Object를 많이 써요.
`Email`, `Nickname`, `Tier`, `UserStatus` 같은 VO들이 있고, 이걸 DTO로 변환할 때 `.value()`나 `.name()` 호출이 필요합니다.
필드가 많아지면 수동으로 하기 귀찮고 실수하기 쉬워서 MapStruct를 썼어요.

### UserSettingsMapper

![user-settings-mapper](/uploads/project/Tymee/mapstruct-usage/user-settings-mapper.png)


UserSettings는 더 심해요.
푸시 알림, 개인정보, 플래너 설정 등 20개가 넘는 필드가 있고, 부분 업데이트(PATCH)를 지원해야 합니다.
null인 필드는 무시하고 기존 값을 유지하는 로직이 필요한데, 이걸 수동으로 하면 코드가 100줄 넘어가요.

---

## upload 모듈: 수동 변환

### UploadResponse.from()

![upload-response-from](/uploads/project/Tymee/mapstruct-usage/upload-response-from.png)


upload은 MapStruct 안 써요. 이유는:

1. **추가 파라미터 필요**: `url`과 `thumbnailUrl`은 도메인 객체에 없어요. R2StorageService에서 생성한 값을 같이 넘겨야 하는데, MapStruct는 단순 객체 → 객체 변환에 최적화되어 있어서 이런 케이스가 어색해요.

2. **필드가 적음**: Upload 도메인은 필드가 10개 안 돼요. 수동으로 해도 코드 몇 줄이라 MapStruct 설정하는 비용이 더 커요.

3. **VO 없음**: user처럼 Email, Nickname 같은 VO를 안 써요. 그냥 primitive 타입이라 변환 로직이 단순합니다.

### UploadEntity 변환

![upload-entity-conversion](/uploads/project/Tymee/mapstruct-usage/upload-entity-conversion.png)


엔티티 ↔ 도메인도 필드명이 똑같고 타입도 같아요.
MapStruct 쓰면 자동으로 해주긴 하는데, 이 정도는 수동으로 해도 충분합니다.

---

## 언제 MapStruct를 쓰나

| 상황 | MapStruct | 수동 |
|------|-----------|------|
| 필드 10개 이상 | O | |
| VO → primitive 변환 많음 | O | |
| 부분 업데이트(PATCH) | O | |
| 추가 파라미터 필요 | | O |
| 필드 5개 이하 | | O |
| 1:1 단순 매핑 | 둘 다 OK | 둘 다 OK |

결국 보일러플레이트가 얼마나 많이 줄어드냐의 문제예요.
user처럼 VO도 많고 필드도 많고 부분 업데이트도 있으면 MapStruct가 확실히 낫습니다.
upload처럼 단순하면 굳이 의존성 추가할 필요 없어요.

---

## MapStruct 설정

### build.gradle.kts

![mapstruct-build-gradle](/uploads/project/Tymee/mapstruct-usage/mapstruct-build-gradle.png)


Lombok과 같이 쓰면 annotationProcessor 순서가 중요해요.
MapStruct가 Lombok이 생성한 getter/setter를 사용하기 때문에 Lombok이 먼저 처리되어야 하거든요.

### Mapper 인터페이스

![mapper-interface](/uploads/project/Tymee/mapstruct-usage/mapper-interface.png)


`componentModel = "spring"`으로 설정하면 Spring Bean으로 등록돼요.
`@Autowired`나 생성자 주입으로 사용할 수 있습니다.

---

## 성능: 불변 vs 가변 변환

### 객체 생성 비용, 걱정할 필요 없다

불변 객체 변환은 매번 새 객체를 만들어야 하니까 가변 객체보다 느리지 않을까요? 결론부터 말하면 **거의 차이 없어요**.

JVM의 단기 객체(short-lived object) 생성 비용은 약 **3.6 나노초**예요.
API 요청 하나 처리하는 데 보통 수십~수백 밀리초가 걸리는데, 객체 몇 개 더 만든다고 체감되는 성능 저하는 없어요.

게다가 JVM은 **Escape Analysis**라는 최적화를 해요:

- 메서드 밖으로 안 나가는 객체는 힙 대신 스택에 할당
- 아예 객체를 만들지 않고 필드만 변수로 쪼개는 **Scalar Replacement**
- 단일 스레드에서만 쓰이면 동기화 제거

결국 불변 객체를 자주 만들어도 GC 부담이 크게 늘지 않아요. 오히려 불변 객체는:

- **방어적 복사 불필요**: 가변 객체는 넘길 때마다 복사해야 안전한데, 불변은 그냥 참조 전달
- **동기화 불필요**: 멀티스레드 환경에서 락 오버헤드 제로
- **GC 친화적**: 짧게 살고 죽는 객체는 Young GC에서 빠르게 정리됨

### MapStruct는 수동 매핑만큼 빠르다

[Java Object Mapper Benchmark](https://github.com/arey/java-object-mapper-benchmark) 결과:

| 프레임워크 | 처리량 (ops/sec) |
|------------|------------------|
| MapStruct | 28,039,597 |
| 수동 매핑 | 26,978,437 |
| JMapper | 24,531,754 |
| Orika | 4,565,378 |
| ModelMapper | 184,304 |
| Dozer | 89,860 |

MapStruct가 수동 매핑과 거의 동등한 성능을 내요.
**컴파일 타임에 최적화된 코드를 생성**하기 때문이에요.

반면 Dozer나 ModelMapper는 리플렉션 기반이라 런타임 오버헤드가 커요. 150배 이상 차이 납니다.

### 그래서 뭘 쓰나

| 상황 | 권장 |
|------|------|
| 필드 많음 + VO 변환 | MapStruct (타입 안전 + 빠름) |
| 필드 적음 + 단순 변환 | 수동 (의존성 추가 비용 > 이득) |
| 리플렉션 기반 매퍼 | 쓰지 마라 (성능 병목) |

성능 측면에서 불변 객체 변환은 문제가 안 돼요.
선택 기준은 **보일러플레이트 감소 효과**와 **타입 안전성**입니다.

---

## 불변 객체 수정: toBuilder vs Wither vs Factory

레이어드 아키텍처에서 불변 객체를 쓰면 필연적으로 마주치는 문제가 있어요: **필드 하나만 바꾸고 싶은데 전체를 복사해야 한다**는 거예요.

### 문제 상황

```java
// 닉네임 하나만 바꾸고 싶은데...
var updated = User.builder()
                .id(user.getId())
                .email(user.getEmail())
                .nickname("새닉네임")  // 이것만 바꾸고 싶음
                .status(user.getStatus())
                .tier(user.getTier())
                .createdAt(user.getCreatedAt())
                .updatedAt(user.getUpdatedAt())
                // ... 20개 필드 전부 복사
                .build();
```

필드 20개 도메인이면 코드가 20줄이에요.
실수하기 딱 좋고, 필드 추가될 때마다 여기저기 수정해야 합니다.

### 해결책 1: toBuilder (Lombok)

```java
@Builder(toBuilder = true)
public class User {
    // ...
}

// 사용
var updated = user.toBuilder()
        .nickname("새닉네임")
        .build();
```

기존 객체의 모든 필드를 복사한 Builder를 반환해요. 바꿀 필드만 덮어쓰면 됩니다.

### 해결책 2: Wither 패턴 (Lombok @With)

```java
@With
public class User {
    private final String nickname;
    // ...
}

// 사용 - 각 필드마다 withXxx 메서드 생성됨
var updated = user.withNickname("새닉네임");
```

단일 필드 변경에 가장 깔끔해요. 여러 필드 변경하려면 체이닝:

```java
var updated = user
        .withNickname("새닉네임")
        .withStatus(UserStatus.ACTIVE);
```

### 해결책 3: Java Record + 수동 Wither

```java
public record User(String name, int age) {
    public User withName(String name) {
        return new User(name, this.age);
    }
    public User withAge(int age) {
        return new User(this.name, age);
    }
}
```

Record는 Lombok 없이 써야 할 때 적합해요. 필드 적으면 괜찮은데, 많으면 보일러플레이트가 늘어나요.

### 해결책 4: Factory 메서드

```java
public class User {
    public static User updateNickname(User original, String newNickname) {
        return User.builder()
                .id(original.getId())
                // ... 복사
                .nickname(newNickname)
                .build();
    }
}
```

검증 로직 넣거나, 캐싱하거나, 서브타입 반환할 때 유용해요.
단순 필드 변경엔 과합니다.

### 비교

`toBuilder`는 여러 필드를 동시에 바꿀 때 좋고, Wither는 단일 필드 변경에 깔끔해요.
Factory 메서드는 검증이나 캐싱 로직이 필요할 때 유용하고, Record wither는 Lombok 없이 쓸 때 적합합니다.
성능은 다 비슷해요. 결국 새 객체를 만드는 건 똑같고 JVM이 최적화해주거든요.
선택 기준은 코드 가독성과 유지보수성이에요.

---

## 실제 프로젝트: UserSettings 사례

이론은 여기까지고, 실제 이 프로젝트에서 어떻게 했는지 볼게요.

### UserSettings는 "부분 불변"

```java
@Getter
public class UserSettings {
    private final Long userId;              // 불변 (final)
    private final LocalDateTime createdAt;  // 불변 (final)

    private ThemeMode themeMode;            // 가변 (final 아님)
    private boolean pushEnabled;            // 가변
    private boolean pushFriendRequest;      // 가변
    // ... 20개 넘는 필드가 가변
}
```

**완전 불변이 아니라 가변 도메인**이에요. 왜냐하면:

1. **필드가 20개 넘음**: 완전 불변이면 하나만 바꿔도 `toBuilder`로 새 객체 만들어야 함
2. **PATCH API 지원**: 클라이언트가 `{ "pushEnabled": false }` 만 보내면 나머지는 유지해야 함
3. **JPA와 자연스러운 연동**: Entity도 가변이라 dirty checking이 자연스러움

### update 메서드로 상태 변경

```java
public void updateThemeMode(ThemeMode themeMode) {
    this.themeMode = themeMode;
    this.updatedAt = LocalDateTime.now();
}

public void updatePlannerSettings(int startHour, int dailyGoal, int weeklyGoal, boolean weeklyTimetableEnabled) {
    if (startHour < 0 || startHour > 23) {
        throw new IllegalArgumentException("시작 시간은 0-23 사이여야 합니다");
    }
    // ... 검증 후 업데이트
}
```

`toBuilder` 대신 명시적 `updateXxx()` 메서드를 써요. 장점은:
- **검증 로직 포함 가능**: `plannerStartHour` 범위 체크 같은 거
- **updatedAt 자동 갱신**: 매번 까먹지 않음
- **의도 명확**: "이 필드는 이렇게 바꿀 수 있다"가 코드에 드러남

### MapStruct에서 부분 업데이트

```java
@Mapper(componentModel = "spring")
public interface UserSettingsMapper {

    default void updateFromRequest(UserSettingsUpdateRequest request, UserSettings settings) {
        if (request.themeMode() != null) {
            settings.updateThemeMode(ThemeMode.valueOf(request.themeMode().toUpperCase()));
        }
        if (request.pushEnabled() != null) {
            settings.updatePushEnabled(request.pushEnabled());
        }
        // ... 20개 필드 null 체크
    }
}
```

이게 바로 **MapStruct를 쓰는 이유**예요:
- null인 필드는 무시하고 기존 값 유지 (PATCH 시맨틱)
- 20개 필드 null 체크를 한 곳에서 관리
- 도메인의 `updateXxx()` 메서드를 호출해서 검증도 탐

### 왜 toBuilder를 안 썼나

| 접근법 | 특징 |
|--------|------|
| **완전 불변 + toBuilder** | 필드 변경할 때마다 새 객체 반환 |
| **가변 + update 메서드** | 기존 객체 상태를 직접 변경 <- **현재 방식** |

현재 방식을 선택한 이유:
1. **필드가 너무 많음**: 20개 넘는 필드를 매번 복사하는 건 코드도 길고 실수하기 쉬움
2. **JPA Entity와 맞물림**: Domain → Entity 변환 후 dirty checking 자연스러움
3. **검증 로직 분산 방지**: `updatePlannerSettings()`에 범위 체크 넣으면 끝

만약 완전 불변으로 바꾸면:

```java
public UserSettings updateThemeMode(ThemeMode themeMode) {
    return this.toBuilder()
        .themeMode(themeMode)
        .updatedAt(LocalDateTime.now())
        .build();
}
```

나쁘진 않은데, 현재 구조에선 굳이 필요 없어요.

---

## 결론: 왜 MapStruct인가

정리하면 이래요:

1. **레이어 간 변환** (User → UserResponse): MapStruct
    - 타입이 다르고, VO → primitive 변환 필요
    - 필드 많으면 수동으로 하기 귀찮고 실수하기 쉬움
    - 컴파일 타임 검증으로 안전

2. **같은 타입 내 수정** (User → User with 닉네임 변경): toBuilder / Wither
    - 타입이 같으니 MapStruct 쓸 이유 없음
    - Lombok이 이미 제공하는 기능으로 충분

3. **단순 변환** (Upload → UploadResponse): 수동
    - 필드 적고 타입 변환 없으면 그냥 `from()` 메서드로 충분
    - 추가 파라미터 필요하면 오히려 수동이 자연스러움

결국 **"보일러플레이트가 얼마나 줄어드느냐"**가 핵심이에요.
줄어드는 게 많으면 도구 쓰고, 별로면 수동으로 하면 됩니다.
성능은 걱정할 필요 없어요.

---

## 참고

- [MapStruct 공식 문서](https://mapstruct.org/documentation/stable/reference/html/)
- [Baeldung - MapStruct Guide](https://www.baeldung.com/mapstruct)
- [Java Object Mapper Benchmark](https://github.com/arey/java-object-mapper-benchmark)
- [Baeldung - Performance of Java Mapping Frameworks](https://www.baeldung.com/java-performance-mapping-frameworks)
- [The cost of object creation in Java](https://www.bettercodebytes.com/the-cost-of-object-creation-in-java-including-garbage-collection/)
- [Escape Analysis in the JVM](https://medium.com/@AlexanderObregon/the-purpose-and-mechanics-of-escape-analysis-in-the-jvm-f02c17860b8c)
- [Lombok @Builder](https://projectlombok.org/features/Builder) - toBuilder 옵션 포함
- [Lombok @With](https://projectlombok.org/features/With) - Wither 패턴
- [Builders, Withers, and Records - Java's path to immutability](https://www.sonarsource.com/blog/builders-withers-and-records-java-s-path-to-immutability/)
- [Lombok Builders and Copy Constructors](https://www.kapresoft.com/java/2021/12/27/lombok-builders-and-copy-constructors.html)

<!-- EN -->

> This post documents where MapStruct is used in this project and where it is not.

---

## Why Use MapStruct

### Immutable Objects vs Mutable Objects

This project has different object characteristics per layer:

- **Domain**: Immutable objects. After creation, state changes return new objects or are only modified through explicit methods.
- **Entity**: Mutable objects. JPA wraps them in proxies, so setters or direct field access are needed for dirty checking.
- **DTO (Request)**: Immutable objects. Uses Java records. Values received from the client are kept as-is.
- **DTO (Response)**: Immutable objects. Uses Java records.

The problem is that conversions are needed between these objects:

```
Request DTO → Domain → Entity (save)
Entity → Domain → Response DTO (query)
```

### Problems with Manual Conversion

![manual-mapping-problem](/uploads/project/Tymee/mapstruct-usage/manual-mapping-problem.png)


If you get the field order wrong or miss one, there's no compile error — you get incorrect values at runtime. MapStruct generates mapping code at compile time to prevent such mistakes.

### Partial Updates (PATCH)

Settings update APIs typically change only a subset of fields:

```json
{ "pushEnabled": false }  // Only disable push, keep everything else
```

To handle this:

![partial-update-problem](/uploads/project/Tymee/mapstruct-usage/partial-update-problem.png)


MapStruct's `@BeanMapping(nullValuePropertyMappingStrategy = IGNORE)` or default methods can handle this cleanly.

---

## Current Usage

| Module | MapStruct | Reason |
|--------|-----------|--------|
| user | O | Many fields, complex conversion logic |
| upload | X | Simple conversion, additional parameters needed |
| auth | X | Almost no DTO conversion |
| core | X | Only utilities/configuration |

---

## user Module: Using MapStruct

### UserMapper

![user-mapper](/uploads/project/Tymee/mapstruct-usage/user-mapper.png)


The User domain uses many Value Objects. There are VOs like `Email`, `Nickname`, `Tier`, and `UserStatus`, and converting them to DTOs requires calling `.value()` or `.name()`. As the number of fields grows, doing this manually becomes tedious and error-prone, so we used MapStruct.

### UserSettingsMapper

![user-settings-mapper](/uploads/project/Tymee/mapstruct-usage/user-settings-mapper.png)


UserSettings is even more involved. There are over 20 fields including push notifications, privacy, and planner settings, and it needs to support partial updates (PATCH). The logic to ignore null fields and preserve existing values would exceed 100 lines if done manually.

---

## upload Module: Manual Conversion

### UploadResponse.from()

![upload-response-from](/uploads/project/Tymee/mapstruct-usage/upload-response-from.png)


upload does not use MapStruct. Here's why:

1. **Additional parameters needed**: `url` and `thumbnailUrl` don't exist in the domain object. Values generated by R2StorageService need to be passed along, but MapStruct is optimized for simple object-to-object conversion, making this case awkward.

2. **Few fields**: The Upload domain has fewer than 10 fields. Even manual conversion is just a few lines, so the cost of setting up MapStruct outweighs the benefit.

3. **No VOs**: Unlike user, there are no VOs like Email or Nickname. It's all primitive types, so the conversion logic is simple.

### UploadEntity Conversion

![upload-entity-conversion](/uploads/project/Tymee/mapstruct-usage/upload-entity-conversion.png)


Entity-to-domain conversion also has identical field names and types. MapStruct would do this automatically, but this level of work is perfectly fine to do manually.

---

## When to Use MapStruct

| Scenario | MapStruct | Manual |
|----------|-----------|--------|
| 10+ fields | O | |
| Many VO → primitive conversions | O | |
| Partial updates (PATCH) | O | |
| Additional parameters needed | | O |
| 5 or fewer fields | | O |
| Simple 1:1 mapping | Either works | Either works |

Ultimately, it comes down to how much boilerplate you can eliminate. If there are many VOs, many fields, and partial updates like in user, MapStruct is clearly better. If it's simple like upload, there's no need to add the dependency.

---

## MapStruct Configuration

### build.gradle.kts

![mapstruct-build-gradle](/uploads/project/Tymee/mapstruct-usage/mapstruct-build-gradle.png)


When using with Lombok, the annotationProcessor order matters. Since MapStruct uses the getters/setters generated by Lombok, Lombok must be processed first.

### Mapper Interface

![mapper-interface](/uploads/project/Tymee/mapstruct-usage/mapper-interface.png)


Setting `componentModel = "spring"` registers it as a Spring Bean. You can use it with `@Autowired` or constructor injection.

---

## Performance: Immutable vs Mutable Conversion

### Object Creation Cost Is Not a Concern

Immutable object conversion creates a new object every time, so wouldn't it be slower than mutable objects? The conclusion is that **there's virtually no difference**.

The JVM's short-lived object creation cost is approximately **3.6 nanoseconds**. Processing a single API request typically takes tens to hundreds of milliseconds, so creating a few extra objects has no perceptible performance impact.

Moreover, the JVM performs **Escape Analysis** optimization:

- Objects that don't escape the method are allocated on the stack instead of the heap
- **Scalar Replacement** decomposes objects into individual field variables without even creating the object
- Synchronization is removed for objects used by a single thread only

As a result, frequently creating immutable objects doesn't significantly increase GC pressure. In fact, immutable objects offer:

- **No defensive copying needed**: Mutable objects must be copied for safety when passed around, but immutable objects can be passed by reference
- **No synchronization needed**: Zero lock overhead in multithreaded environments
- **GC-friendly**: Short-lived objects are quickly cleaned up in Young GC

### MapStruct Is as Fast as Manual Mapping

[Java Object Mapper Benchmark](https://github.com/arey/java-object-mapper-benchmark) results:

| Framework | Throughput (ops/sec) |
|-----------|---------------------|
| MapStruct | 28,039,597 |
| Manual mapping | 26,978,437 |
| JMapper | 24,531,754 |
| Orika | 4,565,378 |
| ModelMapper | 184,304 |
| Dozer | 89,860 |

MapStruct delivers nearly identical performance to manual mapping because it **generates optimized code at compile time**.

In contrast, Dozer and ModelMapper are reflection-based, incurring significant runtime overhead — over 150x slower.

### So What Should You Use?

| Scenario | Recommendation |
|----------|---------------|
| Many fields + VO conversion | MapStruct (type-safe + fast) |
| Few fields + simple conversion | Manual (dependency cost > benefit) |
| Reflection-based mappers | Don't use them (performance bottleneck) |

From a performance perspective, immutable object conversion is not a problem. The selection criteria should be **boilerplate reduction** and **type safety**.

---

## Modifying Immutable Objects: toBuilder vs Wither vs Factory

When using immutable objects in a layered architecture, you inevitably face this problem: **you want to change just one field but have to copy everything**.

### The Problem

```java
// I just want to change the nickname...
var updated = User.builder()
                .id(user.getId())
                .email(user.getEmail())
                .nickname("newNickname")  // Only want to change this
                .status(user.getStatus())
                .tier(user.getTier())
                .createdAt(user.getCreatedAt())
                .updatedAt(user.getUpdatedAt())
                // ... copy all 20 fields
                .build();
```

With a 20-field domain, that's 20 lines of code. It's prone to mistakes, and every time a field is added, you have to update multiple places.

### Solution 1: toBuilder (Lombok)

```java
@Builder(toBuilder = true)
public class User {
    // ...
}

// Usage
var updated = user.toBuilder()
        .nickname("newNickname")
        .build();
```

Returns a Builder with all fields copied from the existing object. You only override the fields you want to change.

### Solution 2: Wither Pattern (Lombok @With)

```java
@With
public class User {
    private final String nickname;
    // ...
}

// Usage - generates withXxx method for each field
var updated = user.withNickname("newNickname");
```

Cleanest for single-field changes. For multiple fields, use chaining:

```java
var updated = user
        .withNickname("newNickname")
        .withStatus(UserStatus.ACTIVE);
```

### Solution 3: Java Record + Manual Wither

```java
public record User(String name, int age) {
    public User withName(String name) {
        return new User(name, this.age);
    }
    public User withAge(int age) {
        return new User(this.name, age);
    }
}
```

For when you need to use Records without Lombok. Fine with few fields, but boilerplate grows with more.

### Solution 4: Factory Method

```java
public class User {
    public static User updateNickname(User original, String newNickname) {
        return User.builder()
                .id(original.getId())
                // ... copy
                .nickname(newNickname)
                .build();
    }
}
```

Useful when you need validation logic, caching, or subtype returns. Overkill for simple field changes.

### Comparison

`toBuilder` is good for changing multiple fields at once, while Wither is clean for single-field changes. Factory methods are useful when validation or caching logic is needed, and Record withers are suitable when working without Lombok. Performance is similar across all approaches — they all create new objects, and the JVM optimizes them. The selection criteria are code readability and maintainability.

---

## Real Project: UserSettings Case

That's the theory. Let's look at what was actually done in this project.

### UserSettings Is "Partially Immutable"

```java
@Getter
public class UserSettings {
    private final Long userId;              // immutable (final)
    private final LocalDateTime createdAt;  // immutable (final)

    private ThemeMode themeMode;            // mutable (not final)
    private boolean pushEnabled;            // mutable
    private boolean pushFriendRequest;      // mutable
    // ... 20+ fields are mutable
}
```

**It's not fully immutable — it's a mutable domain.** Why?

1. **Over 20 fields**: If fully immutable, you'd need `toBuilder` to create a new object for every single change
2. **PATCH API support**: When the client sends only `{ "pushEnabled": false }`, the rest must be preserved
3. **Natural JPA integration**: Since entities are also mutable, dirty checking works naturally

### State Changes via update Methods

```java
public void updateThemeMode(ThemeMode themeMode) {
    this.themeMode = themeMode;
    this.updatedAt = LocalDateTime.now();
}

public void updatePlannerSettings(int startHour, int dailyGoal, int weeklyGoal, boolean weeklyTimetableEnabled) {
    if (startHour < 0 || startHour > 23) {
        throw new IllegalArgumentException("Start hour must be between 0 and 23");
    }
    // ... validate then update
}
```

Instead of `toBuilder`, we use explicit `updateXxx()` methods. Advantages:
- **Can include validation logic**: Like range checking `plannerStartHour`
- **Automatic updatedAt refresh**: No chance of forgetting
- **Clear intent**: "This field can be changed in this way" is visible in the code

### Partial Updates with MapStruct

```java
@Mapper(componentModel = "spring")
public interface UserSettingsMapper {

    default void updateFromRequest(UserSettingsUpdateRequest request, UserSettings settings) {
        if (request.themeMode() != null) {
            settings.updateThemeMode(ThemeMode.valueOf(request.themeMode().toUpperCase()));
        }
        if (request.pushEnabled() != null) {
            settings.updatePushEnabled(request.pushEnabled());
        }
        // ... null check for 20 fields
    }
}
```

This is exactly **why we use MapStruct**:
- Ignores null fields and preserves existing values (PATCH semantics)
- Manages null checks for 20 fields in one place
- Calls the domain's `updateXxx()` methods for validation as well

### Why We Didn't Use toBuilder

| Approach | Characteristics |
|----------|----------------|
| **Fully immutable + toBuilder** | Returns new object for every field change |
| **Mutable + update methods** | Directly modifies existing object state <- **current approach** |

Reasons for choosing the current approach:
1. **Too many fields**: Copying 20+ fields every time makes code long and error-prone
2. **Integration with JPA Entity**: Dirty checking works naturally after Domain-to-Entity conversion
3. **Prevents scattered validation**: Just put range checks in `updatePlannerSettings()` and you're done

If we switched to fully immutable:

```java
public UserSettings updateThemeMode(ThemeMode themeMode) {
    return this.toBuilder()
        .themeMode(themeMode)
        .updatedAt(LocalDateTime.now())
        .build();
}
```

Not bad, but unnecessary for the current structure.

---

## Conclusion: Why MapStruct

Here's the summary:

1. **Cross-layer conversion** (User → UserResponse): MapStruct
    - Types differ, VO-to-primitive conversion needed
    - Many fields make manual work tedious and error-prone
    - Compile-time validation ensures safety

2. **Same-type modification** (User → User with nickname change): toBuilder / Wither
    - Same type, so no reason to use MapStruct
    - Lombok's built-in features are sufficient

3. **Simple conversion** (Upload → UploadResponse): Manual
    - Few fields with no type conversion — a `from()` method is enough
    - When additional parameters are needed, manual is more natural

Ultimately, the key factor is **"how much boilerplate can be reduced."** If the reduction is significant, use the tool. If not, go manual. Performance is not a concern.

---

## References

- [MapStruct Official Documentation](https://mapstruct.org/documentation/stable/reference/html/)
- [Baeldung - MapStruct Guide](https://www.baeldung.com/mapstruct)
- [Java Object Mapper Benchmark](https://github.com/arey/java-object-mapper-benchmark)
- [Baeldung - Performance of Java Mapping Frameworks](https://www.baeldung.com/java-performance-mapping-frameworks)
- [The cost of object creation in Java](https://www.bettercodebytes.com/the-cost-of-object-creation-in-java-including-garbage-collection/)
- [Escape Analysis in the JVM](https://medium.com/@AlexanderObregon/the-purpose-and-mechanics-of-escape-analysis-in-the-jvm-f02c17860b8c)
- [Lombok @Builder](https://projectlombok.org/features/Builder) - includes toBuilder option
- [Lombok @With](https://projectlombok.org/features/With) - Wither pattern
- [Builders, Withers, and Records - Java's path to immutability](https://www.sonarsource.com/blog/builders-withers-and-records-java-s-path-to-immutability/)
- [Lombok Builders and Copy Constructors](https://www.kapresoft.com/java/2021/12/27/lombok-builders-and-copy-constructors.html)

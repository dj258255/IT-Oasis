---
title: '훔친 refresh token은 두 번째 사용에서 들킨다 - 회전·재사용 감지·family 무효화 직접 구현'
titleEn: 'A Stolen Refresh Token Gets Caught on Its Second Use - Rotation, Reuse Detection, and Family Revocation'
description: >-
  별찌 Identity 도메인에서 외부 인증 SaaS 없이 직접 구현한 JWT 인증의 핵심 — Access는 stateless
  15분, Refresh는 stateful 7일로 비대칭을 두고, 회전(rotation)·재사용 감지(reuse
  detection)·token family 무효화로 토큰 탈취를 막은 과정을 실제 코드로 정리합니다. refresh
  token 원본을 저장하지 않고 SHA-256 해시만 두는 이유, family_id·parent_token_id로 회전
  계보를 추적하는 스키마, 죽은 토큰이 다시 오면 family 전체를 끄는 JPQL, 그리고 표준(RFC
  9700·Auth0)이 알려주지 않는 가장 어려운 부분 — 정상 사용자가 토큰 만료 직후 동시에 갱신할
  때 발생하는 race condition과 family 오탐(멀쩡한 사용자 강제 로그아웃)을 PG 행 잠금 + 10초
  grace + noRollbackFor로 풀고, 20스레드 동시 갱신 오탐 0을 testcontainers 회귀 테스트로
  검증하기까지 담았습니다.
descriptionEn: >-
  How Byeolchi's Identity domain implements self-issued JWT auth without an auth SaaS —
  asymmetric lifetimes (stateless 15-minute access, stateful 7-day refresh),
  refresh token rotation, reuse detection, and token-family revocation against
  token theft, all with real code. Covers why only the SHA-256 hash is stored,
  the family_id/parent_token_id rotation lineage schema, the JPQL that revokes an
  entire family when a dead token reappears, and the hardest part the standards
  (RFC 9700, Auth0) leave unspecified: the concurrent-refresh race that triggers a
  false-positive family compromise, solved with a PG row lock + 10s grace +
  noRollbackFor and verified by a 20-thread testcontainers regression (zero false
  positives).
date: 2026-06-09T00:00:00.000Z
tags:
  - JWT
  - OAuth
  - Refresh Token
  - Token Rotation
  - Reuse Detection
  - Spring Security
  - Java
  - PostgreSQL
  - Concurrency
  - Security
  - Byeolchi
category: project/Byeolchi
draft: false
coverImage: /uploads/project/Byeolchi/jwt-refresh-rotation/cover.svg
series: "Byeolchi"
---

별찌에서 인증(Identity)은 제가 단독으로 맡은 도메인이에요. [별찌를 만드는 중](/blog/project/byeolchi/byeolchi-building) 글에서 "인증 SaaS 대신 자체 OAuth"를 골랐다고 적었는데, 자체 구현을 택한 순간 따라오는 진짜 숙제는 로그인이 아니에요. **토큰을 훔쳤을 때 어떻게 되는가**예요.

소셜 로그인 자체는 Spring Security가 거의 다 해줘요. 문제는 그다음이에요. 로그인 한 번에 토큰을 주고, 그 토큰으로 API를 계속 호출하게 하는데 — 그 토큰이 새거나 탈취되면? 인증 SaaS를 썼으면 그쪽이 알아서 했을 부분을, 안 쓰기로 한 이상 제가 직접 책임져야 했어요. 이 글은 그 부분을 실제 코드로 정리한 거예요.

## 출발점 — 토큰이 새는 건 "혹시"가 아니라 "언제"

전제부터 비관적으로 깔았어요. 토큰은 새요. XSS, 로그가 찍힌 토큰, 공용 PC, 탈취된 기기 — 경로는 많아요. 그래서 목표를 "토큰이 안 새게 한다"로 잡으면 안 되고, **"새더라도 피해를 짧고 좁게 막는다"**로 잡아야 했어요.

여기서 두 토큰의 성격이 갈려요.

- **Access token**: 매 API 요청에 실려요. 자주 노출돼요. 그래서 **수명이 짧아야** 해요.
- **Refresh token**: Access를 새로 받을 때만 써요. 거의 안 노출돼요. 대신 수명이 길어서, 한 번 새면 **오래 악용**될 수 있어요.

그래서 둘을 비대칭으로 설계했어요.

| | Access token | Refresh token |
|---|---|---|
| 수명 | 15분 | 7일 |
| 저장 | **stateless** (DB에 없음, 서명만 검증) | **stateful** (DB에 해시 저장·추적) |
| 쓰임 | 모든 API 인증 | `/api/auth/refresh` 에서만 |
| 탈취 시 노출 | 최대 15분 | 회전·재사용 감지로 차단 |

이 표가 글 전체의 뼈대예요. Access는 짧게 버리는 카드, Refresh는 길게 추적하는 카드.

## Access는 왜 DB를 안 보나 — 비용 트레이드오프

Access token은 매 요청에 와요. 만약 매 요청마다 "이 토큰 유효해?"를 DB에서 확인하면, 인증이 모든 API에 DB 조회 1번씩을 더하는 셈이에요. 트래픽이 늘수록 그게 그대로 비용이에요.

그래서 Access는 **stateless**로 갔어요. HS256으로 서명하고, 서버는 서명만 검증해요. DB를 안 봐요.

```java
// JwtIssuer.java — Access token 발급 (DB 저장 없음)
public String issueAccessToken(User user) {
    Instant now = Instant.now();
    Instant expiry = now.plus(properties.accessTokenTtl()); // 15분
    return Jwts.builder()
            .issuer(properties.issuer())
            .subject(user.getId().toString())
            .claim("email", user.getEmail())
            .claim("role", user.getRole().name())
            .issuedAt(Date.from(now))
            .expiration(Date.from(expiry))
            .signWith(key)
            .compact();
}
```

대신 분명한 비용이 있어요. **로그아웃해도 Access token은 못 죽여요.** DB를 안 보니까, 이미 발급된 Access는 만료(최대 15분)까지 유효해요. 토큰 탈취가 확인돼 family를 전부 끊어도, 공격자의 손에 든 Access token은 길어야 15분 더 살아요.

이걸 막으려면 매 요청 blacklist 조회를 넣어야 하는데, 그건 다시 "모든 API에 DB 1번"이에요. 그래서 **수명을 15분으로 짧게 잡아 그 노출 창을 받아들이는** 쪽을 택했어요. "모든 요청에 DB 조회" vs "최대 15분 노출" — 별찌 규모에선 후자가 합리적이라고 봤어요. 이건 무료가 아니라 **선택한 트레이드오프**예요.

## refresh_tokens 스키마 — 원본은 절대 저장하지 않는다

추적은 Refresh token에 몰아넣었어요. 먼저 스키마부터.

```sql
-- refresh_tokens (ERD.dbml 발췌)
id              uuid pk     -- uuidv7
user_id         uuid
token_hash      text unique -- SHA-256 해시만. 원본은 절대 저장 X
family_id       uuid        -- 회전 family 추적
parent_token_id uuid        -- 직전 토큰(회전 계보), null이면 family 루트
expires_at      timestamptz
revoked_at      timestamptz -- 무효화 시각
revoked_reason  text        -- logout | rotated | reuse_detected | family_compromised
user_agent      text        -- 발급 시점 UA (포렌식)
ip_address      inet        -- 발급 시점 IP (PIPA 30일 후 마스킹)
created_at      timestamptz
```

두 가지가 핵심이에요.

**첫째, 토큰 원본을 저장하지 않아요.** `token_hash`는 SHA-256 해시예요. DB가 통째로 유출돼도, 거기서 진짜 refresh token을 복원할 수 없어요. 비밀번호를 평문으로 저장하지 않는 것과 같은 이유예요.

```java
// RefreshTokenService.java — 32바이트 난수를 토큰으로, 저장은 해시만
private String generateToken() {
    byte[] bytes = new byte[32];
    RANDOM.nextBytes(bytes);                                  // SecureRandom
    return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
}

private String sha256(String input) {
    MessageDigest md = MessageDigest.getInstance("SHA-256");
    byte[] digest = md.digest(input.getBytes(StandardCharsets.UTF_8));
    return Base64.getUrlEncoder().withoutPadding().encodeToString(digest);
}
```

(비밀번호가 아니라 **고엔트로피 난수**라, bcrypt 같은 느린 해시 대신 SHA-256으로 충분해요. 추측 공격 대상이 아니라 단순 룩업 키니까요.)

**둘째, `family_id`와 `parent_token_id`로 회전 계보를 만들어요.** 한 번 로그인하면 family 하나가 생기고, 토큰을 갱신할 때마다 같은 family 안에서 자식 토큰이 이어져요. 이 계보가 다음 두 장의 핵심이에요.

## 회전(rotation) — 한 번 쓴 refresh는 그 자리에서 죽는다

회전 규칙은 단순해요. **refresh token은 일회용이에요.** `/api/auth/refresh`를 호출해 새 Access를 받는 순간, 방금 쓴 refresh token은 폐기되고 새 refresh token이 나와요.

```java
// RefreshTokenService.java — 처음 짠 버전. 동시성 구멍이 있어요('가장 어려운 부분'에서 고쳐요)
@Transactional
public RotatedTokens rotate(String presentedToken, String userAgent, String ipAddress) {
    String hash = sha256(presentedToken);
    RefreshToken stored = repository.findByTokenHash(hash)
            .orElseThrow(() -> new InvalidRefreshTokenException("Unknown refresh token"));

    if (stored.isExpired()) {
        throw new InvalidRefreshTokenException("Refresh token expired");
    }

    if (stored.isRevoked()) {
        // ↓ 다음 장의 재사용 감지
        int revokedCount = repository.revokeFamily(stored.getFamilyId(), OffsetDateTime.now(), "family_compromised");
        log.warn("Refresh token reuse detected — revoked {} tokens in family {} for user {}",
                revokedCount, stored.getFamilyId(), stored.getUserId());
        throw new InvalidRefreshTokenException("Refresh token reuse detected (family compromised)");
    }

    stored.revoke("rotated");                                          // 방금 쓴 토큰 폐기
    IssuedRefreshToken next = issue(stored.getUserId(), stored.getFamilyId(), stored.getId(), userAgent, ipAddress);
    return new RotatedTokens(stored.getUserId(), next);               // 같은 family, parent = 직전 토큰
}
```

왜 회전이 필요할까요? 회전이 없으면 refresh token 하나가 7일 내내 유효해요. 그 7일치 토큰을 공격자가 훔치면, 정상 사용자와 똑같이 7일을 쓸 수 있고 **아무도 그걸 몰라요.** 회전을 넣으면 토큰이 계속 바뀌니까, "옛 토큰이 다시 나타나는 것" 자체가 이상 신호가 돼요. 그게 다음 장이에요.

## 재사용 감지 — 죽은 토큰이 다시 오면 family 전체를 끈다

회전을 넣으면 공짜로 따라오는 보너스가 있어요. **이미 회전돼 죽은 토큰이 다시 들어오면, 그건 탈취의 증거예요.**

시나리오로 보면 명확해요. 공격자가 사용자의 refresh token `R1`을 훔쳤다고 해봐요.

| 시점 | 정상 사용자 | 공격자 | 서버 판정 |
|------|------------|--------|----------|
| ① | `R1`으로 갱신 → `R2` 받음 | — | `R1` revoked("rotated"), `R2` 발급 |
| ② | — | 훔친 `R1`으로 갱신 시도 | `R1`은 이미 revoked → **재사용 감지** |
| ③ | — | — | `R1`의 family 전체 revoke("family_compromised") |
| ④ | `R2`로 갱신 시도 | — | `R2`도 family와 함께 죽음 → **강제 재로그인** |

반대로 공격자가 먼저 써도 똑같아요. 누가 먼저 `R1`을 한 번 더 쓰든, **두 번째 사용**이 들어오는 순간 family가 통째로 꺼져요. 훔친 토큰의 수명이 "다음 갱신까지"로 확 짧아지는 거예요.

family를 끄는 건 JPQL UPDATE 한 방이에요. 토큰을 한 줄씩 도는 게 아니라, `family_id`로 한 번에 무효화해요.

```java
// RefreshTokenRepository.java
@Modifying
@Query("UPDATE RefreshToken r SET r.revokedAt = :now, r.revokedReason = :reason "
        + "WHERE r.familyId = :familyId AND r.revokedAt IS NULL")
int revokeFamily(@Param("familyId") UUID familyId,
                 @Param("now") OffsetDateTime now,
                 @Param("reason") String reason);
```

여기서 짚을 점 하나. **죽은 토큰을 너무 빨리 지우면 안 돼요.** 재사용을 감지하려면, revoked된 토큰이 DB에 남아 있어야 "이거 죽은 건데 또 왔네"를 판정할 수 있거든요. 그래서 정리 배치는 revoke되고도 7일을 더 기다린 뒤에 지워요.

```java
// RefreshTokenCleanupBatch.java — 매일 새벽 3:30 KST
@Scheduled(cron = "0 30 3 * * *", zone = "Asia/Seoul")
@Transactional
public void cleanup() {
    OffsetDateTime cutoff = OffsetDateTime.now().minusDays(7);
    int deleted = repository.deleteOldTokens(cutoff); // expires_at < cutoff OR revoked_at < cutoff
    log.info("Refresh token cleanup — deleted {} rows older than {}", deleted, cutoff);
}
```

이게 표준이 권하는 모습이에요. 2025년 1월에 나온 **RFC 9700(OAuth 2.0 Security Best Current Practice)** 은 refresh token 회전을 선택이 아니라 사실상 의무로 올렸고, 재사용이 감지되면 **token family 전체를 무효화**하라고 못 박았어요. Auth0의 rotation도 정확히 같은 모델(reuse detection → 전체 family 무효화)이에요. 여기까지는 교과서대로예요.

문제는, 교과서가 끝나는 지점부터예요.

## 가장 어려운 부분 — 정상 사용자가 동시에 갱신하면?

여기가 이 글을 쓴 진짜 이유예요. 위 코드를 짜고 나서 스스로 공격해봤더니, **정상 사용자를 로그아웃시킬 수 있었어요.**

상황은 이래요. 모바일 앱이 백그라운드에 있다가 포그라운드로 돌아와요. Access token은 만료된 상태. 그 순간 화면 두 개가 거의 동시에 API를 호출하고, 둘 다 401을 받고, 둘 다 **같은 refresh token `R1`으로 갱신을 시도**해요. 모바일에선 아주 흔한 패턴이에요.

`rotate()`는 `findByTokenHash` → `isRevoked` 확인 → `revoke` 의 **read-then-write**예요. 동시 요청 둘이 이 사이에 끼면:

- **경우 A (이중 발급):** 둘 다 `R1`을 "안 죽었다"로 읽어요. 둘 다 회전에 성공해서, 한 family에 자식이 둘(`R2`, `R2'`) 생겨요. 클라이언트는 하나만 보관하니 나머지는 떠돌이가 돼요.
- **경우 B (오탐 — 더 아파요):** 한 요청이 먼저 `R1`을 revoke하고 커밋해요. 살짝 늦은 두 번째 요청이 이제 `R1`을 **revoked로 읽어요** → 재사용으로 오판 → **family_compromised → 멀쩡한 사용자가 강제 로그아웃.**

즉 보안을 위해 넣은 재사용 감지가, 정상 동시 요청을 공격으로 오해해서 사용자를 쫓아내는 거예요. 공격자는 구경도 안 했는데요.

그런데 표준을 다시 봐도 답이 없어요. **RFC 9700도 Auth0 문서도 "회전하고 재사용을 감지하라"까지만 말하지, "정상적인 동시 갱신은 어떻게 구분하냐"는 명시하지 않아요.** (실제로 여러 인증 라이브러리가 이 "grace period / overlap window" 문제로 이슈를 달고 있어요.) 여기는 직접 설계해야 하는 자리였어요.

후보를 셋 놓고 따졌어요.

| 대안 | 방식 | 트레이드오프 |
|------|------|------------|
| A. 비관적 락 (`SELECT ... FOR UPDATE`) | 같은 토큰 행을 잠가 회전을 **직렬화** | 동시 요청이 줄을 서서 레이스 자체가 사라짐. 단일 DB라 비용 작음 |
| B. grace window | 막 회전된 토큰을 N초(예: 10초) 안에 재사용하면, family를 끄는 대신 **직전에 발급한 자식 토큰을 그대로 돌려줌** | 정상 동시 요청을 흡수. 단 grace 동안은 재사용 감지가 살짝 느슨해짐 |
| C. 분산 락 (Redis) | 토큰 키로 락 | 멀티 인스턴스엔 맞지만, 별찌는 아직 단일 인스턴스라 오버스펙 |

별찌는 Phase 1이 **단일 PostgreSQL·단일 인스턴스**라, **A(행 잠금)를 기본으로 B(grace)를 얇게 얹는** 쪽으로 풀었어요(BYC-206).

먼저 조회를 비관적 락으로 바꿔, 같은 토큰의 회전을 직렬화해요.

```java
// RefreshTokenRepository.java — SELECT ... FOR UPDATE 로 같은 토큰 회전을 직렬화
@Lock(LockModeType.PESSIMISTIC_WRITE)
@Query("SELECT r FROM RefreshToken r WHERE r.tokenHash = :tokenHash")
Optional<RefreshToken> findByTokenHashForUpdate(@Param("tokenHash") String tokenHash);
```

이러면 동시 요청 둘이 같은 토큰 행을 두고 줄을 서요(경우 A 이중 발급 소멸). 그리고 `isRevoked` 분기 안에서, "방금 rotated된 토큰을 grace(10초) 안에 다시 들고 온 것"은 모바일의 정상 동시 갱신으로 보고 family를 끄는 대신 새 자식을 재발급해요.

```java
// noRollbackFor — 이게 핵심. 아래에서 설명.
@Transactional(noRollbackFor = InvalidRefreshTokenException.class)
public RotatedTokens rotate(String presentedToken, String userAgent, String ipAddress) {
    String hash = sha256(presentedToken);
    RefreshToken stored = repository.findByTokenHashForUpdate(hash)              // 행 잠금으로 직렬화
            .orElseThrow(() -> new InvalidRefreshTokenException("Unknown refresh token"));
    if (stored.isExpired()) throw new InvalidRefreshTokenException("Refresh token expired");

    if (stored.isRevoked()) {
        if (isWithinRotationGrace(stored)) {                                    // grace 안 = 정상 동시 갱신
            IssuedRefreshToken regranted = issue(stored.getUserId(), stored.getFamilyId(), stored.getId(), userAgent, ipAddress);
            return new RotatedTokens(stored.getUserId(), regranted);            // family 안 끄고 재발급
        }
        repository.revokeFamily(stored.getFamilyId(), now(), "family_compromised"); // grace 밖 = 진짜 재사용
        throw new InvalidRefreshTokenException("Refresh token reuse detected (family compromised)");
    }
    stored.revoke("rotated");
    return new RotatedTokens(stored.getUserId(), issue(stored.getUserId(), stored.getFamilyId(), stored.getId(), userAgent, ipAddress));
}

private boolean isWithinRotationGrace(RefreshToken stored) {
    return stored.isRevokedReason("rotated") && stored.getRevokedAt() != null
            && stored.getRevokedAt().isAfter(OffsetDateTime.now().minus(properties.refreshRotationGrace()));
}
```

여기서 진짜 함정은 `noRollbackFor`였어요. 재사용을 감지하면 `revokeFamily`로 family를 끈 **다음에** `InvalidRefreshTokenException`을 던져 거부하는데 — 이 예외가 RuntimeException이라, 기본 `@Transactional`이면 그 예외로 **트랜잭션이 통째로 롤백**돼요. 즉 방금 한 family 무효화(보안 조치)가 같이 취소돼요. 거부는 했는데 토큰은 안 끊긴, 최악의 조용한 실패죠. 그래서 `noRollbackFor`로 "이 예외에는 롤백하지 마라"를 명시해서 **거부는 던지되 family 무효화는 커밋되게** 했어요. 이런 건 검색으론 안 나오고, 트랜잭션 경계를 직접 의심해봐야 보여요.

grace는 10초로 뒀어요. 모바일 동시 요청은 수 ms~수백 ms 안에 들어오니 넉넉히 흡수되고, 탈취 replay는 분~시간 단위라 이 창을 한참 넘겨서 여전히 family_compromised로 잡혀요.

### 테스트로 확인 — 20스레드 동시 갱신, 오탐 0

이번엔 "다음 글에서"가 아니라 지금 검증했어요. row lock은 진짜 DB라야 의미가 있어서 testcontainers로 실제 Postgres(pgvector/pgvector:pg18)를 띄웠어요.

- **정상 동시 갱신**: 20스레드가 같은 `R1`으로 동시에 `rotate()` → `success=20`, `reuse_detected(오탐)=0`, `family_compromised=0`, `live_leaves=20`(살아있는 리프 토큰). 20스레드 **전부 유효 토큰 수령**, family는 하나도 안 끊김. (grace를 1초로 좁혀 테스트)
- **진짜 재사용**: 1회 정상 회전 후 grace(1초)를 넘겨 `R1` 재사용 → `family_compromised` 발생, 생존 토큰 0.

한 줄 더. 정상 동시 갱신 쪽 `family_rows=21`이 깔끔한 증거예요 — `R1`(부모, rotated로 revoked) + 자식 20개 = 21행. 첫 요청은 정상 회전, 나머지 19개는 grace 안 재발급으로 흡수돼서, **20스레드가 다 통과했는데 family는 한 번도 안 끊긴** 거예요.

"정상 동시 요청은 흡수, 진짜 재사용은 차단"이 한 테스트 안에서 둘 다 통과해요. 표준이 안 알려준 부분을 직접 메우고, 회귀 테스트로 못 박은 지점이에요.

이 테스트는 통과 확인이자 **재현 그물**이에요 — 수정 전(행 잠금·grace 없는) 코드라면 늦게 온 요청들이 `family_compromised`로 가서 오탐>0이 나, 같은 단언에서 빨강이 떠요. 다만 정직하게 적자면, 그 "수정 전 빨강" 실행 로그를 따로 캡처해 두진 않았어요. 재현은 수치가 아니라 위 **경우 A(이중 발급)·B(오탐 강제 로그아웃)** 로 분해해 이슈(BYC-206)에 적어 뒀고, 수정 후 초록(오탐 0)으로 그 경로가 막혔음을 보여주는 식이에요.

이 한 장이 사실 이 글의 전부예요. 회전·재사용 감지는 검색하면 나오지만, **그걸 실제로 켰을 때 정상 사용자가 튕기는 레이스**, 그리고 **그 수정이 트랜잭션 롤백에 같이 쓸려나가는 함정**은 직접 만들어보지 않으면 안 보여요.

## 남은 트레이드오프들

무기 하나를 깊게 파면, 그 옆의 선택들도 같이 설명돼야 정직해요.

- **HS256 단일 시크릿.** 지금은 대칭키(HS256)예요. 단일 백엔드가 발급·검증을 다 하니 시크릿이 신뢰 경계 밖으로 안 나가요 — 이 단계엔 HS256가 맞는 선택이에요(RS256은 여러 서비스가 각자 검증하거나 외부가 검증할 때의 답이고요). HS256의 유일한 실질 약점은 약한 시크릿인데, 둘로 막았어요: `Keys.hmacShaKeyFor`가 256bit 미만 시크릿이면 부팅을 거부하고, prod 시크릿은 Ansible Vault에 둔 `openssl rand -hex 32`(256bit CSPRNG 랜덤)예요 — 사람이 친 문자열이 아니라서요. 시크릿을 회전하면 살아있는 Access가 전부 무효가 되지만 수명이 15분이라 **blast radius가 최대 15분**이고요. 서비스가 쪼개져 검증 주체가 늘면 RS256(검증 측엔 공개키만)으로 가는데, 그건 지금 고칠 코드가 아니라 멀티서비스 시점의 트리거 작업으로 따로 추적해요(ADR 0013에 미리 적어둠 — Redis 다중화를 트리거까지 미뤄둔 것과 같은 패턴이에요).
- **IP·UA는 지금 포렌식용.** 발급 시점 IP·User-Agent를 저장하지만, 회전 시 "IP가 갑자기 바뀌었으니 막자" 같은 능동 차단엔 안 써요(`rotate()`가 둘을 받지만 저장에만 쓰고 어떤 판정에도 안 넣어요). 정상 사용자도 LTE↔WiFi로 IP가 자주 바뀌어서 오탐이 크거든요. IP는 개인정보라 오래 들고 있으면 안 되는데, 별도 마스킹 잡을 두는 대신 정리 배치가 **토큰 행(IP 포함)을 revoke·만료 7일 뒤에 통째로 삭제**해요 — 발급 기준 길어야 ~14일이면 사라지니, 마스킹보다 강한 삭제로 보관을 짧게 가져가요(정확히는 "마스킹"이 아니라 "삭제"예요). 그래서 IP는 "탈취 추적 단서"로만 두고, 차단 판단은 family 재사용이라는 더 확실한 신호에 맡겼어요.
- **logout은 refresh만 죽여요.** `/api/auth/logout`은 해당 refresh token을 revoke하지만, 위에서 말한 대로 Access는 stateless라 최대 15분 더 살아요. "한 사용자의 모든 family를 한 번에 끄는" 기능(`revokeAllByUserId`)은 이미 만들어 뒀고, 지금은 계정 삭제 흐름에서 쓰고 있어요. 다만 "계정 도용 신고 → 즉시 전체 차단" 같은 사용자용 트리거(엔드포인트)는 아직 안 달았어요 — 총은 있는데 그 방아쇠는 후속 작업이에요. 이런 것까지 "이미 됐다"고 안 쓰고 "기반은 있고 트리거는 후속"이라고 적는 게 정직하다고 봤어요.

## 정리

자체 인증을 택한다는 건 로그인을 만든다는 뜻이 아니라, **토큰이 샜을 때를 책임진다는 뜻**이었어요. 그래서 별찌 Identity는 이렇게 서요.

- Access는 stateless 15분 — 짧게 버려서 노출 창을 좁힌다.
- Refresh는 stateful 7일 + 회전 — 한 번 쓰면 죽고, 매번 새로 난다.
- 죽은 토큰이 다시 오면 family 전체를 끈다 — 훔친 토큰의 수명을 "다음 갱신까지"로 줄인다.
- 원본은 저장하지 않는다 — DB가 유출돼도 토큰은 복원 불가.

그리고 가장 중요한 한 가지. **표준대로 회전·재사용 감지를 켜면, 정상 사용자의 동시 갱신이 family 오탐으로 튕긴다.** 이 레이스는 RFC도 Auth0도 답을 주지 않아서 직접 풀어야 했고, 별찌는 단일 인스턴스라 PG 행 잠금(`FOR UPDATE`) + 10초 grace + `noRollbackFor`로 막았어요. 20스레드 동시 갱신에 오탐 0, 진짜 재사용은 그대로 family 무효화 — 둘 다 testcontainers 회귀 테스트로 못 박았어요.

토큰 회전을 "구현했다"가 아니라, **구현했더니 보이는 다음 문제와 그 함정(트랜잭션 롤백)까지 풀고 테스트로 잠근 것**이 이 도메인의 진짜 일이었어요.

---

## 참고 자료

- [RFC 9700 - Best Current Practice for OAuth 2.0 Security](https://datatracker.ietf.org/doc/rfc9700/)
- [Refresh Token Rotation - Auth0 Docs](https://auth0.com/docs/secure/tokens/refresh-tokens/refresh-token-rotation)
- [OAuth best practices: We read RFC 9700 so you don't have to — WorkOS](https://workos.com/blog/oauth-best-practices)
- [Refresh Token Rotation Grace Period (Overlap Window) — better-auth #8512](https://github.com/better-auth/better-auth/issues/8512)
- [RS256 vs HS256: When to use which — WorkOS](https://workos.com/blog/rs256-vs-hs256-jwt-signing-algorithms)
- [RS256 vs HS256: What's the difference — Auth0](https://auth0.com/blog/rs256-vs-hs256-whats-the-difference/)

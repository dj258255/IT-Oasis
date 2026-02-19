---
title: '"Redis 터졌다" - 13년 묵은 시한폭탄, 우리 서버에도 있었다'
titleEn: '"Redis Exploded" - A 13-Year-Old Time Bomb Was in Our Server Too'
description: CVSS 10.0 Redis 취약점(CVE-2025-49844 RediShell)을 발견하고, 긴급 패치 적용과 다층 보안 강화 조치를 수행한 과정을 정리한다.
descriptionEn: Documents the discovery of the CVSS 10.0 Redis vulnerability (CVE-2025-49844 RediShell) and the emergency patching and multi-layer security hardening process.
date: 2025-12-26T00:00:00.000Z
tags:
  - Redis
  - Security
  - CVE
  - Docker
  - Defense in Depth
category: project/Joying
draft: false
---

## 들어가며

평소처럼 개발하고 있던 어느 날, 보안 뉴스 하나가 눈에 띄었어요.

> **"Redis에서 CVSS 10.0 만점의 원격 코드 실행 취약점 발견"**

CVSS 10.0? 최고 위험도예요. 게다가 **13년 동안 숨어있었다**고 합니다.

우리 프로젝트는 Redis를 세션 관리와 캐싱에 사용 중이었거든요. 심장이 철렁했어요.

"혹시 우리도...?"

바로 확인에 들어갔습니다.

---

## CVE-2025-49844 "RediShell" - 무엇이 문제인가?

### 취약점 개요

| 항목 | 내용 |
|------|------|
| **CVE 번호** | CVE-2025-49844 |
| **별칭** | RediShell |
| **CVSS 점수** | **10.0 / 10.0** (Critical) |
| **발견 시기** | 2025년 5월 (Pwn2Own Berlin) |
| **공개 시기** | 2025년 10월 3일 |
| **발견자** | Wiz Research Team |
| **잠복 기간** | **약 13년** |

CVSS 10.0은 **가능한 최고 위험도**예요.

실제로 이 취약점은 공격자가 **원격에서 코드를 실행**할 수 있게 만듭니다.

### 기술적 원리: Use-After-Free

```lua
-- 악의적인 Lua 스크립트 예시 (개념)
EVAL "
  local obj = create_object()
  trigger_garbage_collection()  -- 메모리 해제
  use_freed_memory(obj)          -- 해제된 메모리 재사용 → UAF!
" 0
```

**Use-After-Free (UAF)** 취약점이란?

1. Lua 스크립트가 객체를 생성
2. 가비지 컬렉터가 메모리를 너무 일찍 해제
3. 공격자가 해제된 메모리를 조작
4. **Lua 샌드박스를 탈출하여 호스트 시스템에서 네이티브 코드 실행**

Redis는 기본적으로 Lua 스크립팅을 지원하는데, 이 기능의 메모리 관리에 버그가 있었던 거예요.

### 왜 13년 동안 발견되지 않았을까?

```plaintext
2012년 --------------- 13년 --------------- 2025년
   ↑                                          ↑
Lua 엔진 도입                        Pwn2Own에서 발견
   │
   └─ Use-After-Free 버그 숨어있음
```

- **복잡한 메모리 관리**: Lua의 가비지 컬렉션 로직은 매우 복잡
- **특수한 조건 필요**: 일반적인 사용에서는 트리거되지 않음
- **인증된 사용자만 악용 가능**: 초기엔 외부 노출 사례가 적었음

하지만 최근 들어 Redis가 **인증 없이** 인터넷에 노출되는 사례가 급증하면서 위험도가 폭발적으로 증가했어요.

---

## 실제 위험성: 얼마나 심각한가?

### 1. 공격 시나리오

공격이 성공하면:

- **데이터 탈취**: Redis에 저장된 세션, 캐시 데이터
- **호스트 시스템 장악**: Redis가 실행 중인 서버 전체
- **자격증명 탈취**: AWS IAM 토큰, 환경 변수의 비밀 키
- **측면 이동**: 동일 네트워크의 다른 서비스 공격
- **랜섬웨어 / 크립토마이너**: 지속적 피해

### 2. 전 세계 노출 현황

| 국가 | 노출된 인스턴스 수 |
|------|-------------------|
| 미국 | 1,887개 |
| 프랑스 | 1,324개 |
| 독일 | 929개 |
| 기타 | 4,360개 |
| **합계** | **약 8,500개** |

더 충격적인 사실은:

- **전체 노출 인스턴스**: 약 330,000개
- **인증 없이 노출**: 약 60,000개 (18%)

### 3. POC (Proof of Concept) 공개됨

현재 GitHub에 **공개된 POC가 8개 이상** 존재해요:

- [raminfp/redis_exploit](https://github.com/raminfp/redis_exploit): CVE-2025-49844 전용 POC
- RedRays.io: CVE-2025-49844, CVE-2025-46817, CVE-2025-46818 통합 테스트 코드

POC가 공개되었다는 것은 **누구나 공격할 수 있다**는 뜻입니다.

---

## 우리 프로젝트는 안전한가? (긴급 점검)

### 1단계: 현재 Redis 버전 확인

```bash
cat docker-compose.yml | grep -A 5 "redis:"
```

**우리 프로젝트의 설정 (패치 전):**

```yaml
redis:
  image: redis:7.0.15-alpine  # 취약한 버전!
  container_name: joying-redis
  command: redis-server --requirepass ${REDIS_PASSWORD}
  ports:
    - "${REDIS_PORT}:6379"
```

버전: **7.0.15** → 취약함!

### 2단계: 취약 버전 범위 확인

| Redis 버전 | 취약 여부 | 패치 버전 |
|-----------|---------|---------|
| 6.2.x | 취약 | **6.2.20** 이상 |
| 7.2.x | 취약 | **7.2.11** 이상 |
| 7.4.x | 취약 | **7.4.6** 이상 |
| 8.0.x | 취약 | **8.0.4** 이상 |
| 8.2.x | 취약 | **8.2.2** 이상 |

우리는 **7.0.15**를 사용 중 → **지원 종료 브랜치**라 패치 없음!

안정성을 위해 **7.2.11**을 선택했습니다.

### 3단계: 인증 설정 확인

```yaml
command: redis-server --requirepass ${REDIS_PASSWORD}
```

다행히 우리는 **패스워드 인증을 활성화**해둔 상태였어요.

하지만 인증만으로는 충분하지 않습니다. **인증된 사용자도 악용 가능**하기 때문이에요.

---

## 긴급 패치 적용 과정

### 1. docker-compose.yml 수정

**변경 전:**
```yaml
redis:
  image: redis:7.0.15-alpine
```

**변경 후:**
```yaml
redis:
  image: redis:7.2.11-alpine
```

단 한 줄만 바꾸면 돼요.

### 2. Redis 컨테이너 재시작

```bash
docker-compose stop redis
docker-compose pull redis
docker-compose up -d redis
docker exec joying-redis redis-server --version
```

**출력 결과:**
```
Redis server v=7.2.11 sha=00000000:0 malloc=jemalloc-5.3.0 bits=64 build=...
```

**패치 완료!**

### 3. 동작 확인

```bash
docker exec -it joying-redis redis-cli -a ${REDIS_PASSWORD}

127.0.0.1:6379> PING
PONG

127.0.0.1:6379> KEYS *
1) "session:abc123"
2) "cache:user:456"
```

기존 데이터도 모두 정상!

---

## 추가 보안 강화 조치

### 1. Lua 스크립팅 비활성화

우리 프로젝트는 Lua 스크립트를 사용하지 않아요.

```yaml
redis:
  image: redis:7.2.11-alpine
  command: >
    redis-server
    --requirepass ${REDIS_PASSWORD}
    --rename-command EVAL ""
    --rename-command EVALSHA ""
```

### 2. 네트워크 격리

```yaml
networks:
  joying-network:
    driver: bridge
    internal: true

redis:
  networks:
    - joying-network
  # ports:
  #   - "6379:6379"  # 외부 포트 바인딩 제거
```

Redis는 **내부 네트워크에만** 노출. 백엔드만 접근 가능하도록 했어요.

### 3. 방화벽 규칙 추가

```bash
sudo ufw deny 6379/tcp
```

### 4. 모니터링 설정

```yaml
redis:
  healthcheck:
    test: ["CMD", "redis-cli", "-a", "${REDIS_PASSWORD}", "ping"]
    interval: 10s
    timeout: 5s
    retries: 5
```

---

## 다른 CVE도 함께 패치됨

7.2.11 패치에는 CVE-2025-49844 외에도 추가 취약점 수정이 포함되어 있어요:

| CVE 번호 | 설명 | CVSS |
|---------|------|------|
| **CVE-2025-49844** | Lua UAF RCE | 10.0 |
| CVE-2025-46817 | Lua 엔진 취약점 | 8.8 |
| CVE-2025-46818 | Lua 엔진 취약점 | 8.8 |
| CVE-2025-46819 | Lua 엔진 취약점 | 7.5 |
| CVE-2025-32023 | HyperLogLog OOB Write | 7.5 |
| CVE-2025-48367 | 미공개 | - |

**하나의 패치로 6개의 취약점을 동시에 해결!**

---

## 패치 후 성능 비교

```bash
docker exec joying-redis redis-benchmark -a ${REDIS_PASSWORD} -q -t set,get -n 100000
```

| 작업 | 패치 전 (7.0.15) | 패치 후 (7.2.11) | 변화 |
|------|-----------------|-----------------|------|
| SET | 89,285 req/s | 91,743 req/s | **+2.8%** |
| GET | 95,420 req/s | 97,087 req/s | **+1.7%** |

**성능 저하 없이 패치할 수 있습니다.**

---

## 교훈

### 1. "기본값은 안전하지 않다"

Redis 공식 이미지는 **기본적으로 인증 비활성화** 상태예요. 많은 개발자가 이 사실을 모르고 배포합니다.

### 2. "보안 업데이트는 최우선"

CVSS 10.0은 **즉시 패치**해야 해요. "나중에..."는 없습니다.

### 3. "다층 방어가 답이다"

| 계층 | 방어 수단 |
|------|----------|
| 1단계 | 패치 적용 (7.2.11) |
| 2단계 | 인증 활성화 (requirepass) |
| 3단계 | Lua 비활성화 (EVAL 제거) |
| 4단계 | 네트워크 격리 (내부망만) |
| 5단계 | 방화벽 규칙 (포트 차단) |

한 계층이 뚫려도 다음 계층이 막아줍니다.

---

## 참고 자료

### 공식 문서
- [Redis Security Advisory: CVE-2025-49844](https://redis.io/blog/security-advisory-cve-2025-49844/)
- [Redis 7.2.11 Release Notes](https://github.com/redis/redis/releases/tag/7.2.11)
- [Redis ACL Documentation](https://redis.io/docs/management/security/acl/)

### 보안 분석
- [Wiz Research: RediShell RCE Vulnerability](https://www.wiz.io/blog/wiz-research-redis-rce-cve-2025-49844)
- [Sysdig: Understanding CVE-2025-49844](https://www.sysdig.com/blog/cve-2025-49844-redishell)
- [The Hacker News: 13-Year-Old Redis Flaw](https://thehackernews.com/2025/10/13-year-redis-flaw-exposed-cvss-100.html)

### 환경

- **Redis**: 7.0.15 → 7.2.11 (alpine)
- **패치 일자**: 2025년 10월

<!-- EN -->

## Introduction

While developing as usual one day, a security news article caught my eye.

> **"CVSS 10.0 Remote Code Execution vulnerability discovered in Redis"**

CVSS 10.0? The highest severity possible. And it had been **hiding for 13 years**.

Our project was using Redis for session management and caching. My heart sank.

"Could we be affected too...?"

I immediately started investigating.

---

## CVE-2025-49844 "RediShell" - What's the Problem?

### Vulnerability Overview

| Item | Details |
|------|---------|
| **CVE Number** | CVE-2025-49844 |
| **Alias** | RediShell |
| **CVSS Score** | **10.0 / 10.0** (Critical) |
| **Discovery** | May 2025 (Pwn2Own Berlin) |
| **Disclosure** | October 3, 2025 |
| **Discoverer** | Wiz Research Team |
| **Dormancy Period** | **~13 years** |

### Technical Principle: Use-After-Free

The vulnerability is a **Use-After-Free (UAF)** in Redis's Lua scripting engine:

1. Lua script creates an object
2. Garbage collector frees memory too early
3. Attacker manipulates freed memory
4. **Escapes Lua sandbox to execute native code on host system**

The bug had been hiding in Lua's garbage collection logic since the Lua engine was introduced in 2012.

---

## How Serious Is This?

### Attack Scenario

A successful attack enables:
- **Data theft**: Sessions, cached data in Redis
- **Host system takeover**: Entire server running Redis
- **Credential theft**: AWS IAM tokens, secret keys in environment variables
- **Lateral movement**: Attacking other services on the same network

### Global Exposure

- **Total exposed instances**: ~330,000
- **Exposed without authentication**: ~60,000 (18%)
- **Public POCs on GitHub**: 8+

---

## Is Our Project Safe? (Emergency Check)

**Our configuration (before patch):**

```yaml
redis:
  image: redis:7.0.15-alpine  # Vulnerable!
```

Version **7.0.15** was on an **end-of-life branch** with no patches available. We chose to upgrade to **7.2.11**.

Fortunately, password authentication was already enabled — but authentication alone wasn't sufficient since **authenticated users can also exploit this**.

---

## Emergency Patch Process

### 1. Update docker-compose.yml

```yaml
# Before
redis:
  image: redis:7.0.15-alpine

# After
redis:
  image: redis:7.2.11-alpine
```

One line change.

### 2. Restart Redis Container

```bash
docker-compose stop redis
docker-compose pull redis
docker-compose up -d redis
```

All existing data remained intact. Login, session management, and caching all worked normally.

---

## Additional Security Hardening

1. **Disable Lua scripting**: Renamed `EVAL` and `EVALSHA` commands to empty strings
2. **Network isolation**: Redis on internal-only Docker network, external port binding removed
3. **Firewall rules**: Denied external access to port 6379
4. **Health monitoring**: Added healthcheck with 10s intervals

---

## Other CVEs Also Patched

The 7.2.11 patch included fixes for 6 vulnerabilities simultaneously, including CVE-2025-46817 (CVSS 8.8), CVE-2025-46818 (CVSS 8.8), and CVE-2025-32023 (CVSS 7.5).

---

## Performance After Patch

| Operation | Before (7.0.15) | After (7.2.11) | Change |
|-----------|-----------------|-----------------|--------|
| SET | 89,285 req/s | 91,743 req/s | **+2.8%** |
| GET | 95,420 req/s | 97,087 req/s | **+1.7%** |

**No performance degradation.**

---

## Lessons Learned

1. **"Defaults are not secure"** — Redis ships with authentication disabled by default
2. **"Security updates are top priority"** — CVSS 10.0 requires immediate patching
3. **"Defense in Depth is the answer"** — Patch + Authentication + Lua disable + Network isolation + Firewall

Even if one layer is breached, the next layer stops the attack.

---

## References

- [Redis Security Advisory: CVE-2025-49844](https://redis.io/blog/security-advisory-cve-2025-49844/)
- [Redis 7.2.11 Release Notes](https://github.com/redis/redis/releases/tag/7.2.11)
- [Wiz Research: RediShell RCE Vulnerability](https://www.wiz.io/blog/wiz-research-redis-rce-cve-2025-49844)
- [Sysdig: Understanding CVE-2025-49844](https://www.sysdig.com/blog/cve-2025-49844-redishell)

### Environment

- **Redis**: 7.0.15 → 7.2.11 (alpine)
- **Patch date**: October 2025

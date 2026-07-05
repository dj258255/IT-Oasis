---
title: '이상거래탐지(FDS) — 정확도보다 아키텍처 판단'
titleEn: "Fraud Detection — Architecture Decisions Over Accuracy"
description: 결제 시스템 확장 6. 룰 기반 FDS를 만든다. velocity check로 단위시간 시도 횟수를 세고, 금액 이상치와 블랙리스트를 가중치로 합산해 ALLOW/CHALLENGE/REVIEW/BLOCK으로 판정한다. 핵심은 탐지 정확도가 아니라 아키텍처 판단이다 — 룰을 데이터로 관리해 무배포 조정하고, velocity 카운터를 추상화해 인메모리에서 Redis로 갈아끼운다.
descriptionEn: "Payment system extension 6. Building a rule-based FDS. A velocity check counts attempts per time window, and amount anomalies plus a blacklist are summed by weight into an ALLOW/CHALLENGE/REVIEW/BLOCK decision. The point isn't detection accuracy but architecture — managing rules as data for redeploy-free tuning, and abstracting the velocity counter so an in-memory impl swaps to Redis."
date: 2026-07-19T00:00:00.000Z
tags:
  - Payment
  - Fraud Detection
  - FDS
  - Rule Engine
  - Java
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 14
---

*결제 시스템 시리즈. 확장 6편 — 이상거래탐지.*

## 0. FDS에서 중요한 건 정확도가 아니다

이상거래탐지(FDS)라고 하면 ML·그래프 분석부터 떠올리는데, 실 서비스에서 먼저 중요한 건 **아키텍처 판단**이에요. 탐지 로직이 정교한지보다, "결제 경로에서 얼마나 빠르게 판정하는가", "룰을 어떻게 무배포로 바꾸는가", "다중 인스턴스에서 카운터를 어떻게 공유하는가" 같은 게 먼저예요.

그래서 여기선 **룰 기반 엔진**을 만들되, 그 세 가지 판단을 코드로 드러냈어요.

## 1. velocity check + 가중치 스코어링

여러 룰의 위험 점수를 합산해 판정해요.

```java
public FraudResult evaluate(FraudCheckRequest req) {
    int score = 0;
    if (cardBlacklist.contains(req.cardKey())) score += 100;     // 블랙리스트
    int attempts = velocityCounter.recordAndCount("card:" + req.cardKey());
    if (attempts > velocityThreshold) score += 40;              // velocity 초과
    if (req.amount() > amountThreshold) score += 30;            // 금액 이상치
    return new FraudResult(score, decide(score), reasons);
}
```

점수 구간으로 4단계 대응을 결정해요.

| 점수 | 판정 | 대응 |
|---|---|---|
| ≥100 | **BLOCK** | 차단 |
| ≥60 | **REVIEW** | 사후 사람 검토 큐 |
| ≥40 | **CHALLENGE** | 추가 인증 요구 |
| < 40 | **ALLOW** | 통과 |

velocity check는 "1분 안에 이 카드로 몇 번 시도했나"를 세요. 도난 카드로 여러 금액을 빠르게 긁는 패턴을 잡죠.

## 2. 룰은 코드가 아니라 데이터

여기가 실무 판단이에요. 임계값과 가중치를 **코드에 박으면**, 룰을 바꿀 때마다 배포해야 해요. 사기 패턴은 실시간으로 바뀌는데 배포 사이클을 기다릴 순 없죠.

```java
@Value("${fds.velocity.threshold:5}")  private int velocityThreshold;
@Value("${fds.amount.threshold:1000000}") private long amountThreshold;
```

임계값을 설정으로 빼서 **무배포로 조정**하고, 블랙리스트도 런타임에 추가해요. 운영에선 이걸 DB나 룰 관리 콘솔로 확장하고요.

## 3. velocity 카운터는 추상화

velocity 카운터를 인터페이스로 뺐어요.

```java
public interface VelocityCounter {
    int recordAndCount(String key);
}
```

지금은 인메모리 슬라이딩 윈도우(`ArrayDeque`로 최근 1분 타임스탬프 유지)로 구현했지만, **다중 인스턴스에서는 카운트를 공유해야** 하니 운영에선 Redis(Sorted Set)로 갈아끼워요. 인터페이스 덕에 구현만 바꾸면 되죠. (시간 소스를 주입 가능하게 해서 윈도우 만료를 테스트로 검증했어요.)

## 4. 동기 vs 비동기

마지막 판단 하나. 이 룰 엔진은 **결제 경로에서 동기로** 빠르게 도는 경량 룰만 담았어요. 무거운 분석(그래프·ML)은 지연 예산 안에서 못 하니 **비동기 사후 탐지**로 분리하는 게 정석이에요. 이 경계를 어디에 긋느냐가 FDS 설계의 핵심이에요.

> "if문 몇 개로 사기를 잡는다"가 아니라, "경량 룰은 동기 인라인, 무거운 건 비동기 사후, 룰은 데이터로 무배포 조정, 카운터는 Redis로 확장" — 이 구조적 판단이 FDS에서 실제로 중요한 부분이에요.

## 다음 — 필드 암호화

다음은 민감정보 필드 암호화예요. 계좌번호를 AES-256-GCM으로 암호화하고, 암호화 컬럼을 검색하기 위한 블라인드 인덱스, 그리고 키를 코드에 두지 않는 법까지. 이어서 씁니다.

---

*확장도 기존 기반 위에 얹으며, 각 판단을 테스트로 고정합니다.*

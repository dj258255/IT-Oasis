---
title: '자동 복구가 포기한 순간, 운영은 무엇을 할 수 있나 — 손댈 수 있는 어드민 만들기'
titleEn: "When Auto-Recovery Gives Up, What Can Ops Do? — Building an Admin You Can Actually Touch"
description: 결제 시스템 개선기. 보상 트랜잭션도 복구 배치도 다 자동 루프로 만들어놨는데, 문득 깨달았다 — 그 자동이 실패하면 운영은 지켜보는 것 말곤 할 게 없다. 재시도를 소진한 보상 태스크, 온디맨드로 못 돌리는 복구, 조회조차 안 되는 정산 불일치. 자동화의 마지막 1%를 사람이 손댈 수 있게 어드민 API를 연 이야기.
descriptionEn: "Payment system improvement log. I'd built compensation and recovery all as automatic loops — then realized: when the automation fails, ops can do nothing but watch. Compensation tasks that exhausted their retries, recovery you can't trigger on demand, reconciliation mismatches you can't even view. A story of opening admin APIs so a human can touch the last 1% of automation."
date: 2026-08-29T00:00:00.000Z
tags:
  - Payment
  - Operations
  - Admin
  - Spring Modulith
  - Reliability
category: project/pay
draft: true
series: "결제 시스템 만들기"
seriesOrder: 23
---

*결제 시스템 시리즈. 개선기 — 자동화가 멈춘 지점을 사람에게 넘기기.*

## 0. 자동으로 다 되는데, 안 되면?

지금까지 실패 처리를 꽤 공들여 자동화했어요.

- [보상 트랜잭션](/blog/project/pay/pay-19-compensation-network-cancel)이 승인 후 재고 부족을 자동 망취소하고,
- [복구 배치](/blog/project/pay/pay-2-designing-for-failure)가 미확정(UNKNOWN) 결제를 PG 조회로 확정하고,
- [정산 대사](/blog/project/pay/pay-4-ledger-settlement-reconciliation)가 내부·외부 기록을 맞춰봐요.

다 자동 루프예요. 그런데 어느 순간 깨달았어요 — **이 자동이 실패하면, 운영은 뭘 할 수 있지?**

보상 태스크는 지수 백오프로 재시도하다 5번을 소진하면 `FAILED`로 남아요. 그게 "사람이 개입하라"는 신호인데 — **정작 그 FAILED 태스크를 볼 방법도, 다시 시도할 방법도 없었어요.** 복구 배치는 만들어놨지만 호출할 엔드포인트도 스케줄러도 없어서 사실상 죽은 코드였고요. 정산 불일치는 DB를 직접 쿼리하지 않는 한 확인조차 안 됐어요.

자동화의 99%는 만들었는데, **나머지 1%(자동이 포기한 지점)를 사람이 손댈 손잡이**가 없었던 거예요.

## 1. "자동이 실패한다"를 전제로 설계하기

결제 시스템의 철학은 처음부터 "장애는 실제로 일어난다"였어요. 그 철학을 자동 복구에도 적용해야 했어요 — **자동 복구도 실패한다.** PG가 오래 죽어있으면 망취소 재시도가 다 소진되고, 복구 배치도 PG 조회가 안 되면 못 확정해요.

그래서 이번 개선의 방향은 명확했어요. 각 자동 루프마다 **"관측 + 수동 개입"** 어드민을 붙이는 거예요. 이미 [DLQ 재처리 어드민](/blog/project/pay/pay-6-operations)을 만들어둔 패턴이 있었으니, 같은 결로 확장했어요.

만든 건 세 가지예요. 데모 콘솔의 운영 콘솔 탭이 이 손잡이들을 한데 모아둔 모습이에요.

![운영 콘솔 데모 — 미확정 복구·보상 재처리·정산 대사·강제취소 2인 승인·FDS 심사·DLQ](/uploads/project/pay/demo/demo-admin.png)

## 2. 보상 태스크: 소진된 걸 다시 무장하기

제일 중요한 건 보상 태스크 재처리였어요.

```
GET  /api/v1/admin/compensations?status=FAILED   → 소진된 태스크 목록
POST /api/v1/admin/compensations/{id}/retry      → 재시도
```

핵심은 `retry`가 하는 일이에요. FAILED 태스크는 재시도 예산(5회)을 다 쓴 상태라, 그냥 스케줄러가 다시 집어도 소용없어요. 그래서 도메인 메서드 `reopen()`을 만들었어요.

```java
/** 소진(FAILED)된 태스크를 근본 원인 수정 후 재무장 — 재시도 예산을 리셋한다. */
public void reopen() {
    this.status = CompensationStatus.PENDING;
    this.retryCount = 0;              // 새 예산으로 다시
    this.nextAttemptAt = Instant.now();
}
```

시나리오는 이래요 — PG가 두 시간 죽어서 어떤 망취소가 재시도를 다 소진하고 FAILED가 됐어요. PG가 복구되면, 운영자가 어드민에서 그 태스크를 `retry`해요. `reopen()`으로 재시도 예산을 리셋하고 **즉시 한 번 시도**하죠. 이번엔 PG가 살아있으니 성공해요.

여기서 [지난 편의 트랜잭션 함정](/blog/project/pay/pay-19-compensation-network-cancel)이 또 나와요. 재시도 실행은 태스크별 트랜잭션에 위임하고, 실패는 별도 트랜잭션으로 기록해야 해요. 그래서 어드민 서비스엔 `@Transactional`을 안 걸고, `reopen()` 저장 → `executor.attempt()`(자기 트랜잭션) → 실패 시 `executor.recordFailure()`(별도 트랜잭션) 순으로 위임했어요. 한 건의 롤백이 어드민 호출 전체를 오염시키지 않게요.

## 3. 복구·정산: 죽어있던 손잡이를 켜기

나머지 둘은 더 단순해요 — **이미 있는 로직을 부를 수 있게** 한 거예요.

```
POST /api/v1/admin/payments/recover            → UNKNOWN 결제 복구 온디맨드 실행
GET  /api/v1/admin/payments/unknown            → 미확정 결제 목록
GET  /api/v1/admin/reconciliations/mismatches  → 사람 확인 필요한 불일치
```

복구 배치는 로직(`recoverUnknownPayments()`)은 있었지만 트리거가 없었어요. "미확정 결제가 쌓인 것 같다" 싶을 때 운영자가 즉시 돌릴 수 있게 POST를 열었죠. 정산 불일치는 `ReconStatus.PENDING`(자동 종결 못 하고 사람 확인 필요한 건)만 골라 보여줘요 — 금액이 안 맞거나 한쪽에만 있는 기록이요.

## 4. 엔티티를 그대로 던지지 않기

작은 결정 하나. 어드민 응답으로 JPA 엔티티를 그대로 직렬화하고 싶은 유혹이 있는데, 안 했어요. 대신 뷰 record를 따로 뒀어요.

```java
record CompensationTaskView(Long id, String orderNo, long amount,
        CompensationStatus status, int retryCount, String lastError, Instant nextAttemptAt) {}
```

이유는 두 가지예요.

> **(1) 유출 방지**: 엔티티를 직렬화하면 지연로딩 컬렉션(예: 결제 이력)이 딸려 나오거나, 내부 상태머신 필드·낙관적 락 `version` 같은 운영 표면에 불필요한 것까지 새어나가요.
> **(2) 계약 분리**: API 응답 스펙을 엔티티 스키마 변화로부터 떼어놔요. 엔티티에 컬럼을 하나 추가해도 어드민 API 계약은 안 흔들려요.

어드민이라고 대충 엔티티를 던지면, 나중에 그게 외부 계약이 돼서 스키마를 못 바꾸게 돼요.

## 5. 모듈 경계는 여기서도 지킨다

세 어드민을 각각 **자기 모듈 안**에 뒀어요 — 보상 어드민은 order, 복구 어드민은 payment, 정산 어드민은 reconciliation. 각자 자기 모듈의 package-private 리포지토리·서비스에만 접근하니, [모듈 경계](/blog/project/pay/pay-21-ci-guards-boundaries)를 넘지 않아요. "어드민"이라는 이유로 아무 모듈이나 들쑤시는 God 컨트롤러를 만들지 않은 거죠. `ModularityTests`도 그대로 통과하고요.

인가는 `SecurityConfig`가 `/api/v1/admin/**`에 ROLE_ADMIN을 요구해 한 곳에서 강제하고, 상태를 바꾸는 재처리는 호출자(principal)를 감사 로그로 남겨요.

## 마치며

이번 건 새 도메인 기능은 아니에요. 하지만 **"운영 가능성(operability)"**이라는, 실서비스에선 기능만큼 중요한 걸 채운 편이에요.

자동화를 아무리 잘 만들어도 100%는 없어요. 남은 1%는 반드시 사람이 손대야 하고, 그때 **손댈 손잡이가 있느냐 없느냐**가 장애 대응 시간을 가르죠. "자동으로 안 되면 어떡하지?"라는 질문에 "이 어드민으로 이렇게 개입한다"고 답할 수 있게 된 게, 이번 개선의 전부예요.

---

*전체 코드는 [Spring Modulith 기반 결제 시스템](https://github.com/dj258255/payment-system)에 있고, 모든 상태 변경 어드민 액션은 감사 로그로 남깁니다.*

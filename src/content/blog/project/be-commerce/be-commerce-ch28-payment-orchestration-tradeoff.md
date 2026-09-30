---
title: '결제 오케스트레이션은 장애를 줄이는가, 복잡성을 옮기는가'
description: '배민은 카드 결제에 PG 세 곳을 붙이고 Adyen은 오케스트레이션이 복잡성을 없애지 않는다고 씁니다. BE-commerce에는 failover 라우팅 코드와 규칙 테스트가 있지만 기본값은 꺼져 있고 경로는 가짜 PG 둘입니다. 무엇을 코드로 강제했고 무엇을 검증하지 못했는지 나눠 적었습니다.'
date: 2026-09-22
category: study/be-commerce
coverImage: "/uploads/project/be-commerce/diagrams/erd.svg"
draft: false
series: "BE-commerce"
seriesOrder: 28
tags:
  - Payment
  - Architecture
  - Reliability
  - 결제 시스템
---

다중 PG는 흔히 복원력의 정답처럼 보입니다. 한 PG가 장애면 다른 PG로 보내면 되기 때문입니다. 결제에서는 두 조건을 먼저 지켜야 합니다. 같은 결제가 두 번 승인되지 않아야 하고 이후 취소와 정산까지 설명할 수 있어야 합니다.

## 결론부터

- 다중 PG는 장애 우회 경로를 제공하지만, UNKNOWN 승인·토큰·환불·정산·대사라는 책임을 없애지 않습니다.
- failover는 기존 PG에 요청이 도달하지 않았다는 조건에서만 허용하고, 도달 여부를 모르면 `UNKNOWN`으로 남깁니다.
- BE-commerce에서는 라우팅 코드와 규칙 테스트를 만들었지만 기본값은 꺼 두었습니다. 실제 PG 계약과 운영 데이터 없이 복원력을 주장하지 않기 위해서입니다.

오케스트레이션의 효과는 PG 개수로 판단할 수 없습니다. **우회했을 때 새로 생기는 상태와 복구 작업까지 운영할 수 있는가**를 함께 계산해야 합니다.

## 다른 회사는 왜 PG를 여럿 두나

**우아한형제들**은 배달의민족 앱의 신용·체크카드 결제에 PG 세 곳을 씁니다. [결제 담당자가 장애에 대응하는 방법](https://techblog.woowahan.com/15236/)(2023)에서 PG마다 연동 규격에 맞춰 따로 붙여야 한다고 적었습니다. 카드사 장애 안내가 왔는데 내부 모니터링에는 아무것도 잡히지 않은 사례도 소개합니다. 특정 회선에서만 난 문제였고 그 뒤 자체 모니터링을 따로 만들었습니다. PG를 여럿 두면 장애를 우회할 길이 생기지만 어느 경로가 아픈지 알아내는 일은 여전히 남는다는 이야기입니다.

**Adyen**은 [payment orchestration 글](https://www.adyen.com/knowledge-hub/payment-orchestration)에서 오케스트레이션이 복잡성을 없애지 않고 그 복잡성을 관리하는 방식을 바꾼다고 씁니다. 진짜 복원력을 얻으려면 오케스트레이션 옆에 PSP 직접 연동을 대체 경로로 함께 두는 경우가 많고 그만큼 운영 부담이 늘어난다고도 적었습니다.

## 무엇을 얻고 무엇을 새로 떠안나

| 선택 | 얻는 것 | 새로 생기는 책임 |
|---|---|---|
| 단일 PG | 계약·환불·정산의 단순성 | 한 사업자 장애가 곧 결제 장애 |
| active-passive | 장애 우회 가능성 | UNKNOWN 승인과 failover 중복 방지 |
| active-active | 승인율·비용 최적화 가능성 | 라우팅·토큰·정산·대사 복잡성 |
| 외부 orchestrator | 초기 연결 비용 감소 | 데이터·장애·계약 책임의 경계가 하나 더 생김 |

## BE-commerce에 실제로 있는 것

`PgClient` 인터페이스 아래 어댑터가 넷 있습니다.

| 어댑터 | 상태 |
|---|---|
| `TossPgClient` | 기본 PG |
| `KakaoPayPgClient` | `kakaopay` 프로파일에서만 켜짐. 사업자등록이 없어 개발 키로는 401만 돌아와 성공 경로는 확인하지 못함 |
| `FakePgClient` | 테스트·데모용 |
| `RoutingPgClient` | PG별 서킷브레이커, 가중치 순 시도, 조건부 failover |

**라우팅은 기본으로 꺼져 있습니다.** `RoutingPgClient`는 `app.pg.routing.enabled=true`일 때만 등록되고 기본값은 `false`입니다. 켜도 경로는 가중치가 다른 `FakePgClient` 둘이고 토스와 카카오페이를 묶은 경로는 없습니다. 그래서 이 글에서 "failover를 구현했다"는 말은 규칙과 테스트까지를 뜻합니다. 실 PG 두 곳 사이에서 장애를 넘긴 적은 없습니다.

카카오페이 어댑터는 성공 경로를 확인하지 못했는데도 만들었습니다. 개발 키로 받은 401이 실제 응답이기 때문입니다. 401은 요청이 PG에 닿은 뒤 거절된 경우라서 다른 PG로 넘기면 안 됩니다. 라우팅 규칙이 이 경우를 failover 대상에서 빼는지 가짜 예외가 아닌 실제 응답으로 확인하려고 붙였습니다.

## failover에서 자동화하지 않는 경계

앞선 판단의 기준은 [결제 재시도 글](/blog/project/be-commerce/be-commerce-ch26-payment-retries-retry-storm)과 같습니다. 요청이 PG에 닿았을 수 있으면 다른 곳으로 보내지 않습니다.

| 경계 | 지금 상태 |
|---|---|
| 승인 결과가 UNKNOWN(타임아웃)이면 다른 PG로 재승인하지 않음 | 코드로 강제. `RoutingPgClient`는 SUCCESS·FAILED·TIMEOUT을 모두 "PG가 응답했다"로 보고 그대로 돌려줌 |
| 요청이 닿지 못한 경우(`PgUnreachableException`, 서킷 오픈)만 다음 PG로 넘김 | 코드로 강제 |
| 최초 승인 PG를 결제에 보존 | 코드로 강제. `Payment.pgProvider`에 승인한 경로 이름을 적음 |
| 환불·취소·조회는 승인한 PG로만 보냄 | 코드와 테스트로 강제. `CancelRoutesToApprovingPgTest`가 지정 PG로만 가는지, 모르는 PG면 예외인지 확인 |
| PG 거래 reference와 내부 결제 연결 | `paymentKey`와 `pgProvider`를 함께 저장. 별도 reference 필드는 없음 |
| 승인율과 함께 중복 승인·환불 실패·대사 지연 비교 | 없음. 비교할 실 트래픽이 없음 |

모든 PG가 불가하면 결과를 UNKNOWN으로 돌려 복구 배치에 맡깁니다.

## 검증하지 못한 것

두 실 PG 사이의 장애 전환, 토큰 이동, PG별 정산 파일 대사, 환불 계약은 계정과 외부 계약이 있어야 확인할 수 있습니다. 우아한형제들 사례처럼 PG를 여럿 둔 뒤에 생기는 "어느 경로가 아픈가" 문제도 실 트래픽이 있어야 드러납니다. 두 PG failover는 작업 보드에 `Blocked by external state`로 남겨 두었습니다.

## 참고

- [우아한형제들 - 결제는 계속된다: 결제 담당자가 장애에 대응하는 방법](https://techblog.woowahan.com/15236/)
- [Adyen - Payment Orchestration](https://www.adyen.com/knowledge-hub/payment-orchestration)
- [결제 오케스트레이션 판단 문서](https://github.com/dj258255/BE-commerce/blob/main/docs/36-%EA%B2%B0%EC%A0%9C-%EC%98%A4%EC%BC%80%EC%8A%A4%ED%8A%B8%EB%A0%88%EC%9D%B4%EC%85%98%EC%9D%98-%EB%B3%B5%EC%9E%A1%EC%84%B1-%EC%9D%B4%EB%8F%99-%ED%8C%90%EB%8B%A8.md)

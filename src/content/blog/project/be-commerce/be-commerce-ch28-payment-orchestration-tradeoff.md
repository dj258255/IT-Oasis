---
title: '결제 오케스트레이션은 장애를 줄이는가, 복잡성을 옮기는가'
description: '두 개 이상의 PG를 연결하면 장애 우회와 승인율 최적화를 얻을 수 있지만, 상태·환불·토큰·정산·대사의 복잡성이 함께 생긴다. BE-commerce에서 다중 PG를 바로 확대하지 않고 계약과 실패 경계를 먼저 남긴 이유를 정리했다.'
date: 2026-09-22
category: study/be-commerce
coverImage: "/uploads/project/be-commerce/diagrams/erd.svg"
draft: false
unlisted: true
series: "BE-commerce"
seriesOrder: 28
tags:
  - Payment
  - Architecture
  - Reliability
  - 결제 시스템
---

다중 PG는 흔히 복원력의 정답처럼 보입니다. 한 PG가 장애면 다른 PG로 보내면 되기 때문입니다. 하지만 결제에서 중요한 것은 “다른 곳으로 보냈는가”가 아니라 **같은 결제가 두 번 승인되지 않았고, 이후 취소와 정산까지 설명 가능한가**입니다.

## 무엇을 얻고 무엇을 포기하는가

| 선택 | 얻는 것 | 새로 생기는 책임 |
|---|---|---|
| 단일 PG | 계약·환불·정산의 단순성 | 단일 사업자 장애 영향 |
| active-passive | 장애 우회 가능성 | UNKNOWN 승인과 failover 중복 방지 |
| active-active | 승인율·비용 최적화 가능성 | 라우팅·토큰·정산·대사 복잡성 |
| 외부 orchestrator | 초기 연결 비용 감소 | 데이터·장애·계약 책임의 추가 경계 |

Adyen도 orchestration이 장애를 없애는 기능이 아니라 복잡성을 다른 위치로 이동시키는 선택이라고 설명합니다. 그래서 현재 BE-commerce에서는 provider 추상화가 있다고 해서 live failover가 구현됐다고 쓰지 않습니다.

## failover에서 절대 자동화하면 안 되는 경계

- 승인 결과가 UNKNOWN이면 다른 PG로 재승인하지 않는다.
- 최초 승인 provider를 payment에 보존한다.
- 환불·취소는 원 승인 provider 또는 계약상 허용된 경로로만 보낸다.
- provider transaction reference와 내부 payment를 연결한다.
- 승인율뿐 아니라 중복 승인·환불 실패·대사 지연을 함께 비교한다.

실제 두 PG의 장애 전환, 토큰 이동, 정산 파일, 환불 계약은 계정과 외부 계약 없이는 검증할 수 없으므로 다음 milestone으로 남겼습니다.

## 참고

- [Adyen - Payment Orchestration](https://www.adyen.com/knowledge-hub/payment-orchestration)
- [Adyen - Design to Duty](https://www.adyen.com/knowledge-hub/design-to-duty-adyen-architecture)
- [결제 오케스트레이션 판단 문서](https://github.com/dj258255/BE-commerce/blob/main/docs/36-%EA%B2%B0%EC%A0%9C-%EC%98%A4%EC%BC%80%EC%8A%A4%ED%8A%B8%EB%A0%88%EC%9D%B4%EC%85%98%EC%9D%98-%EB%B3%B5%EC%9E%A1%EC%84%B1-%EC%9D%B4%EB%8F%99-%ED%8C%90%EB%8B%A8.md)

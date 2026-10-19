---
title: '[DE Ch-14] 스키마 레지스트리와 호환성: 누가 먼저 올라가는지가 모드를 정한다'
description: 메시지를 쓰는 쪽과 읽는 쪽은 서로 다른 시점에 배포됩니다. 스키마 레지스트리의 호환성 모드는 새 스키마로 옛 데이터를 읽을 수 있는지(BACKWARD), 옛 스키마로 새 데이터를 읽을 수 있는지(FORWARD)를 등록 시점에 검사합니다. 필드 추가, 삭제, 타입 변경이 각 방향에서 읽히는지를 fastavro로 직접 확인하고 Avro 스키마 해석 규칙, Confluent 레지스트리의 기본값과 업그레이드 순서 Protobuf와 JSON Schema의 차이, data contract까지 정리합니다.
date: 2026-10-19T00:00:00.000Z
tags:
  - Data Engineering
  - Schema Registry
  - Avro
  - Protobuf
  - Schema Evolution
  - Data Contract
category: data/Foundations
topics:
  - pipeline
  - messaging
draft: false
series: "DE 공부"
seriesOrder: 14
---

## 결론부터

1. 호환성은 방향이 둘입니다. BACKWARD는 새 스키마를 가진 컨슈머가 옛 스키마로 쓴 데이터를 읽을 수 있는 것이고 FORWARD는 옛 스키마를 가진 컨슈머가 새 스키마로 쓴 데이터를 읽을 수 있는 것입니다. BACKWARD면 컨슈머를 먼저, FORWARD면 프로듀서를 먼저 올립니다.
2. fastavro로 확인한 결과입니다. 기본값 있는 필드 추가는 두 방향 모두 읽혔습니다. 기본값 없는 필드 추가는 BACKWARD가 깨졌고 필드 삭제와 int에서 long으로 넓히기는 FORWARD가 깨졌습니다. int에서 string으로 바꾸면 두 방향 모두 깨졌습니다.
3. Confluent Schema Registry의 기본 모드는 BACKWARD입니다. 문서는 컨슈머를 토픽 처음으로 되감아 옛 데이터를 다시 읽을 수 있게 하려는 것이 이유라고 적습니다. 기본 모드는 직전 버전 하나와만 비교하므로, 모든 과거 버전과 비교하려면 `_TRANSITIVE`를 씁니다.
4. 레지스트리는 스키마의 모양만 검사합니다. enum 값 추가처럼 레지스트리를 통과해도 옛 컨슈머가 못 읽는 변경이 있고 값의 의미나 범위는 data contract의 규칙으로 따로 다룹니다.

---

## 1. 쓰는 쪽과 읽는 쪽은 따로 배포된다

Ch-11에서 토픽의 데이터는 보존 기간 동안 남는다고 했습니다. 주문 이벤트에 `coupon` 필드를 추가한다고 해 봅시다. 프로듀서를 먼저 배포하면 옛 컨슈머가 새 필드가 든 메시지를 받습니다. 컨슈머를 먼저 배포하면 새 컨슈머가 `coupon`이 없는 옛 메시지를 받습니다. 토픽 처음부터 다시 읽으면 일주일 전 메시지도 받습니다. 어느 쪽이든 서로 다른 스키마로 쓰고 읽는 상황이 생깁니다.

스키마 레지스트리는 스키마를 버전별로 저장하고 새 버전을 등록할 때 정한 규칙(호환성 모드)을 지키는지 검사합니다. 메시지에는 스키마 전체 대신 스키마 ID만 붙입니다. Confluent 형식은 첫 바이트가 0(버전 바이트), 다음 4바이트가 스키마 ID이고 그 뒤가 데이터입니다.

## 2. Avro의 스키마 해석 규칙

Avro 명세는 데이터를 쓸 때의 스키마를 writer 스키마, 애플리케이션이 기대하는 스키마를 reader 스키마라고 부르고 둘이 다를 때의 규칙을 정합니다.

| 상황 | 명세의 규칙 |
|---|---|
| 필드 순서가 다름 | 필드는 이름으로 맞춘다 |
| writer에만 있는 필드 | writer의 값을 무시한다 |
| reader에만 있고 기본값이 있는 필드 | reader의 기본값을 쓴다 |
| reader에만 있고 기본값이 없는 필드 | 오류 |
| 타입 승격 | int는 long, float, double로, long은 float, double로, float는 double로, string과 bytes는 서로 승격된다 |
| enum | writer의 값이 reader의 enum에 없을 때 reader에 기본값이 있으면 그걸 쓰고 없으면 오류 |

## 3. 재현: 어떤 변경이 어느 방향으로 읽히나

주문 스키마 v1(`order_id: long`, `amount: int`)에서 변경 다섯 가지를 만들고 fastavro로 실제로 쓰고 읽었습니다([labs/de-study/ch14](https://github.com/dj258255/IT-Oasis/tree/main/labs/de-study/ch14)의 `avro_compat.py`).

- BACKWARD 확인: v1으로 쓴 데이터를 v2 스키마로 읽는다
- FORWARD 확인: v2로 쓴 데이터를 v1 스키마로 읽는다

| 변경 | BACKWARD(새 reader, 옛 데이터) | FORWARD(옛 reader, 새 데이터) |
|---|---|---|
| 필드 추가, 기본값 있음(`coupon: ["null","string"]`, 기본 null) | 읽힘. `coupon`은 None | 읽힘. `coupon`은 무시 |
| 필드 추가, 기본값 없음(`coupon: string`) | 실패(SchemaResolutionError) | 읽힘 |
| 필드 삭제(`amount`) | 읽힘. `amount`는 무시 | 실패 |
| 타입 넓히기(`amount` int → long) | 읽힘 | 실패 |
| 타입 바꾸기(`amount` int → string) | 실패 | 실패 |

결과는 2절의 규칙 그대로입니다.

- 기본값 없는 필드를 추가하면, 옛 데이터에는 그 필드가 없는데 새 reader가 채울 값을 모릅니다. 그래서 BACKWARD가 깨집니다.
- 필드를 삭제하면 반대로 옛 reader가 그 필드를 기대하는데 새 데이터에 없습니다. 옛 스키마에서 그 필드에 기본값이 없었으니 FORWARD가 깨집니다.
- int를 long으로 넓히면 새 reader(long)는 옛 int 데이터를 승격해서 읽지만 옛 reader(int)는 새 long 데이터를 좁힐 수 없습니다.

Confluent 문서의 요약표도 같은 결론입니다. 필수 필드 추가는 FORWARD만, 필수 필드 삭제는 BACKWARD만, 타입 넓히기는 BACKWARD만 허용되고 optional 필드(기본값 있는 필드)의 추가와 삭제는 모든 모드에서 허용됩니다. Avro에서 optional 필드는 `["null", "string"]` 같은 union으로 만들고 기본값은 union의 첫 번째 타입을 따라야 해서 null을 앞에 두고 `"default": null`로 씁니다.

## 4. 호환성 모드와 업그레이드 순서

### 4-1. 모드

Confluent Schema Registry 문서의 정의입니다.

| 모드 | 정의 | 먼저 올리는 쪽 |
|---|---|---|
| BACKWARD(기본) | 스키마 X를 쓰는 컨슈머가 X와 X-1로 쓴 데이터를 처리할 수 있다 | 컨슈머 |
| BACKWARD_TRANSITIVE | X, X-1, X-2 ... 전부 | 컨슈머 |
| FORWARD | X로 쓴 데이터를 X와 X-1 컨슈머가 읽을 수 있다 | 프로듀서 |
| FORWARD_TRANSITIVE | X, X-1, X-2 ... 전부 | 프로듀서 |
| FULL | X와 X-1 사이에서 양방향 | 아무 쪽이나 |
| FULL_TRANSITIVE | 모든 과거 버전과 양방향 | 아무 쪽이나 |
| NONE | 검사하지 않는다 | 모두 동시에, 또는 새 토픽 |

문서는 업그레이드 순서를 이렇게 적습니다. BACKWARD 계열은 새 이벤트를 쓰기 전에 모든 컨슈머를 올립니다. FORWARD 계열은 프로듀서를 먼저 올리고 옛 스키마로 쓴 데이터가 컨슈머에게 가지 않게 한 뒤 컨슈머를 올립니다. FULL 계열은 따로 올려도 됩니다.

### 4-2. BACKWARD가 기본인 이유와 transitive

문서는 BACKWARD가 Kafka에서 기본이자 권장인 주된 이유를 컨슈머를 토픽 처음으로 되감을 수 있게 하기 위해서라고 적습니다. 새 컨슈머가 보존 기간 안의 옛 메시지를 모두 읽을 수 있어야 하기 때문입니다. FORWARD는 옛 메시지를 읽을 수 있다는 보장이 없고 앞으로의 변경을 모두 예상해야 해서 다루기 어렵다고 적습니다.

기본 모드는 transitive가 아닙니다. 새 버전을 최신 버전 하나와만 비교하므로 X-2와 X-1, X-1과 X는 호환되지만 X-2와 X는 보장되지 않습니다. 토픽에 오래된 버전의 메시지가 남아 있고 처음부터 다시 읽을 일이 있다면 `BACKWARD_TRANSITIVE`가 맞습니다.

### 4-3. subject와 이름 전략

호환성은 subject 단위로 검사합니다. 기본 `TopicNameStrategy`는 subject를 `<토픽>-value`, `<토픽>-key`로 정해서 토픽 하나에 스키마 한 종류를 둡니다. 토픽 하나에 이벤트 종류 여러 개(주문 생성, 주문 취소)를 담으려면 레코드 이름 기준의 `RecordNameStrategy`나 `TopicRecordNameStrategy`를 씁니다.

## 5. Protobuf와 JSON Schema

| 형식 | 문서에서 확인한 것 |
|---|---|
| Protobuf | 필드는 번호로 맞춘다. 번호를 재사용하면 디코딩이 모호해지므로 지운 필드의 번호(와 이름)는 `reserved`로 막는다. 기존 필드의 번호를 바꾸는 것은 안전하지 않다. Confluent는 새 메시지 타입 추가가 FORWARD 호환이 아니라서 Protobuf에는 `BACKWARD_TRANSITIVE`를 권한다 |
| JSON Schema | 기본이 열린 모델(`additionalProperties: true`)이라 아무 속성이나 더 올 수 있다. Confluent 문서는 JSON Schema의 BACKWARD 규칙이 Avro보다 복잡하다고 적고 열린 모델과 닫힌 모델에 따라 허용되는 변경이 반대로 갈린다 |

JSON Schema가 까다로운 이유를 Robert Yokota의 글(2021)이 설명합니다. 열린 모델의 스키마는 어떤 속성이든 받아들이는데 여기에 타입이 정해진 속성을 추가하면 이전에 그 이름으로 다른 타입의 값이 들어왔을 수 있어서 BACKWARD가 깨집니다.

## 6. 레지스트리 밖에서 정할 것: 배포 순서와 값의 규칙

### 6-1. enum 값 추가

Kris Drouet의 2026년 글에 이런 사례가 있습니다. 프로듀서 팀이 이벤트의 enum에 `EXTENDED`를 추가했고 레지스트리는 기본 BACKWARD라 이 변경을 받아들였습니다. 새 스키마(reader)는 옛 데이터의 모든 enum 값을 알고 있으니 BACKWARD는 맞습니다. 그런데 옛 스키마로 생성한 클래스를 쓰던 컨슈머 둘이 처음 보는 enum 값을 만났고 기본값이 없어서 역직렬화에 실패했습니다. 저녁까지 DLQ에 수백 건이 쌓였습니다.

2절의 enum 규칙과 4-1절의 업그레이드 순서를 같이 보면 설명됩니다. BACKWARD는 컨슈머를 먼저 올린다는 전제의 모드인데, 프로듀서가 먼저 새 값을 보냈습니다. 레지스트리는 등록 시점의 규칙만 검사하고 실제 배포 순서는 모릅니다.

### 6-2. data contract

스키마는 모양(필드 이름과 타입)만 정합니다. "금액은 0 이상", "주민번호는 9자리" 같은 값의 규칙과 이 데이터의 담당자, 변경 절차는 스키마 밖에 있습니다.

Andrew Jones는 2021년 글 "Data contracts"에서 스키마를 하류 사용자와의 계약으로 보고 애플리케이션 API처럼 문서화하고 버전을 매기고 깨지는 변경을 피한다고 썼습니다. Confluent 문서는 data contract를 상류와 하류 사이에 움직이는 데이터의 구조와 의미에 대한 공식 합의로 정의하고 스키마는 그 한 요소라고 적습니다. 구성 요소로 구조, 무결성 제약, 메타데이터, 규칙, 변경 절차를 듭니다.

Confluent의 구현은 스키마에 규칙을 붙이는 방식입니다(CP 7.4 이상, 일부 상용 패키지).

| 규칙 | 예 |
|---|---|
| 도메인 규칙(쓸 때, 읽을 때 검사) | `size(message.ssn) == 9`를 만족하지 않으면 오류나 DLQ |
| 마이그레이션 규칙 | 메이저 버전이 바뀔 때 UPGRADE 규칙으로 새 컨슈머가 옛 메시지를 읽고 DOWNGRADE 규칙으로 옛 컨슈머가 새 메시지를 읽는다. 예: 필드 이름 `ssn`을 `socialSecurityNumber`로 바꾸는 변환 |

이름 바꾸기는 3절의 규칙으로는 "삭제 + 추가"라 호환되지 않습니다. 마이그레이션 규칙은 읽는 시점에 변환해서 같은 토픽 안에서 깨지는 변경을 넘깁니다.

## 7. 다른 레지스트리

| 레지스트리 | 모드 이름 |
|---|---|
| Confluent | BACKWARD, FORWARD, FULL과 각각의 `_TRANSITIVE`, NONE |
| AWS Glue Schema Registry | NONE, DISABLED, BACKWARD, BACKWARD_ALL, FORWARD, FORWARD_ALL, FULL, FULL_ALL. `_ALL`이 Confluent의 `_TRANSITIVE`에 해당하고 DISABLED는 새 버전 등록 자체를 막는다 |
| Apicurio Registry | Confluent와 같은 이름. 규칙을 설정하지 않으면 검사하지 않는 것으로 보인다 |

## 8. 중국과 국내 사례를 찾지 못한 것

중국과 국내 빅테크에서 스키마 레지스트리 도입기나 스키마 변경 장애 회고는 찾지 못했습니다. LINE VOOM의 2023년 글 "쿠버네티스 환경에서 Confluent Platform을 사용해 한 단계 진보한 데이터 파이프라인 구축하기"가 Schema Registry(cp-schema-registry 7.2.2)를 운영하며 스키마가 바뀌면 레지스트리만 바꿔 대응한다고 적은 것이 전부이고 포맷과 호환성 모드, 장애 경험은 나오지 않습니다. 같은 글은 `acks=all`, 복제 3, `min.insync.replicas=2`를 함께 적었습니다.

## 9. 범위와 한계

- 3절은 fastavro 1.13.1로 확인했습니다. 레지스트리 서버를 띄워 등록 검사를 돌리지는 않았습니다. 레지스트리의 검사 결과는 Confluent 문서의 요약표와 대조했습니다.
- Confluent 문서 안에서 Kafka Streams가 지원하는 모드를 두 곳에서 다르게 적고 있어 다루지 않았습니다.
- 6-1절은 한 사람의 경험담이고 채용 회사와 함께 쓴 글입니다.

## 10. 헷갈렸던 것

**Q. BACKWARD인데 필드 삭제는 되고 추가는 안 되는 게 거꾸로 같아요.**

BACKWARD는 "새 스키마로 옛 데이터를 읽는다"입니다. 삭제한 필드는 옛 데이터에 있어도 새 reader가 무시하면 되니 문제가 없습니다. 추가한 필드는 옛 데이터에 없는데 새 reader가 값을 채워야 하니 기본값이 필요합니다. 방향을 "누가 누구를 읽는지"로 떠올리면 헷갈리지 않습니다.

**Q. 그럼 필드는 항상 기본값을 줘서 추가하면 되나요?**

기본값 있는 필드의 추가와 삭제는 모든 모드에서 허용되니 가장 안전합니다. 대신 기본값이 의미를 가려 버릴 수 있습니다. `coupon`의 기본값이 null이면 "쿠폰을 안 썼다"와 "쿠폰 필드가 생기기 전의 데이터"가 구분되지 않습니다.

**Q. 깨지는 변경이 꼭 필요하면요?**

Confluent 문서는 NONE으로 모든 클라이언트를 동시에 올리거나, 더 흔하게는 새 토픽을 만들어 애플리케이션을 옮기라고 적습니다. data contract의 마이그레이션 규칙을 쓸 수 있으면 같은 토픽 안에서 변환하는 방법도 있습니다.

## 참고 자료

공식 문서와 명세
- Confluent, [Schema Evolution and Compatibility for Schema Registry on Confluent Platform](https://docs.confluent.io/platform/current/schema-registry/fundamentals/schema-evolution.html)
- Confluent, [Formats, Serializers, and Deserializers for Schema Registry on Confluent Platform](https://docs.confluent.io/platform/current/schema-registry/fundamentals/serdes-develop/index.html)
- Confluent, [Protobuf Schema Serializer and Deserializer](https://docs.confluent.io/platform/current/schema-registry/fundamentals/serdes-develop/serdes-protobuf.html), [JSON Schema Serializer and Deserializer](https://docs.confluent.io/platform/current/schema-registry/fundamentals/serdes-develop/serdes-json.html)
- Confluent, [Data Contracts for Schema Registry on Confluent Platform](https://docs.confluent.io/platform/current/schema-registry/fundamentals/data-contracts.html)
- Apache Avro, [Specification 1.12.0](https://avro.apache.org/docs/1.12.0/specification/)
- Protocol Buffers, [Language Guide (proto 3)](https://protobuf.dev/programming-guides/proto3/)
- AWS, [AWS Glue Schema registry](https://docs.aws.amazon.com/glue/latest/dg/schema-registry.html)
- Apicurio, [Apicurio Registry content rule reference](https://www.apicur.io/registry/docs/apicurio-registry/3.0.x/getting-started/assembly-rule-reference.html)

글과 사례
- Andrew Jones, [Data contracts](https://andrew-jones.com/blog/data-contracts/), 2021
- Chad Sanderson, [The Rise of Data Contracts](https://dataproducts.substack.com/p/the-rise-of-data-contracts), 2022
- Robert Yokota, [Understanding JSON Schema Compatibility](https://yokota.blog/2021/03/29/understanding-json-schema-compatibility/), 2021
- Kris Drouet, [Schema Evolution Without Downtime: Versioning Events People Actually Consume](https://www.kore1.com/event-schema-evolution-versioning/), 2026
- Haandol, [Kafka Schema Registry 에서 Protobuf 사용하기](https://haandol.github.io/2022/12/29/use-kafka-schema-registry-for-protobuf.html), 2022
- 실습 코드: [labs/de-study/ch14](https://github.com/dj258255/IT-Oasis/tree/main/labs/de-study/ch14)

중국과 국내 빅테크 사례
- 박찬우, [쿠버네티스 환경에서 Confluent Platform을 사용해 한 단계 진보한 데이터 파이프라인 구축하기](https://engineering.linecorp.com/ko/blog/advanced-data-pipeline-with-confluent-platform-on-kubernetes/), LINE, 2023

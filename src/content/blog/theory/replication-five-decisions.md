---
title: '데이터 복제에서 정하는 다섯 가지: 기다리는 지점, 읽는 곳, 승격, 쿼럼, 쓰기를 받는 곳'
description: '메이퇀 기술 블로그의 복제 정리를 뼈대로 복제를 설계할 때 정하는 다섯 가지와 각각의 비용을 적었습니다. GitHub, Meta, Shopify, Cloudflare, Amazon, 텐센트, PingCAP의 선택을 원문으로 확인해 붙였고 PostgreSQL로 동기 수준별 커밋 지연과 쓴 직후 복제본 읽기의 실패 횟수를 직접 쟀습니다.'
date: 2026-10-11
tags:
  - Replication
  - Database
  - Consistency
  - Failover
  - Quorum
  - Raft
  - PostgreSQL
  - Kafka
  - MySQL
  - Distributed Systems
category: theory/Database
coverImage: /uploads/covers/theory/replication-five-decisions.svg
draft: false
---

데이터를 여러 서버에 복제하면 다섯 가지를 정해야 하고 다섯 가지 모두 비용이 따릅니다. 이 글은 메이퇀 기술 블로그의 "Replication" 두 편을 뼈대로 그 다섯 가지를 정리합니다. 메이퇀의 글은 『데이터 중심 애플리케이션 설계』를 요약하고 Kafka에 대응시킨 글이어서 이론은 그 두 편에 정리돼 있습니다. 여기에는 회사들이 실제로 무엇을 고르고 무엇을 치렀는지를 원문으로 확인해 붙였고 PostgreSQL로 직접 잰 값을 더했습니다.

먼저 결론입니다.

1. 쓰기가 어디까지 가면 성공이라고 답할지를 정합니다. 복제 링크에 편도 5ms 지연을 두면 비동기 커밋은 0.26ms, 복제본을 기다리는 커밋은 12.7ms였습니다.
2. 읽기를 어디서 할지를 정합니다. 복제 링크가 편도 5ms 늦을 때 비동기 복제본에서 쓴 직후에 읽으면 6,000회 중 6,000회가 실패했습니다. 복제본의 적용이 20ms 밀릴 때는 복제본의 디스크까지 기다리는 수준도 전부 실패했고 적용까지 기다리는 수준만 0회였습니다.
3. 주 서버가 죽었을 때 승격을 누가 결정할지를 정합니다. GitHub은 43초의 단절 뒤 자동 승격으로 양쪽에 서로 없는 쓰기가 생겨 24시간 11분 동안 서비스가 저하됐습니다. Meta는 승격을 복제 로그에 태우는 합의 알고리즘을 MySQL에 넣어 장애 조치를 20~40초에서 보통 2초 안으로 줄였고 같은 글에서 합의가 가용성까지 올려 주지는 않는다고 밝혔습니다.
4. 몇 벌을 두고 몇 벌의 응답을 기다릴지를 정합니다. 서버 수로만 과반을 세면 같은 가용 영역의 서버들이 함께 죽는 경우를 놓칩니다. Aurora는 가용 영역 하나와 서버 한 대를 함께 잃는 경우를 견디려고 6벌에 쓰기 4, 읽기 3을 골랐습니다.
5. 쓰기를 몇 곳에서 받을지를 정합니다. 여러 곳에서 받으면 쓰기를 거절할 일이 줄지만 충돌을 어떻게 풀지가 설계의 일부가 됩니다.

다섯 가지 뒤에는 일관성 용어인 선형성과 직렬성을 따로 정리했습니다. 쓰기를 받는 서버는 주 서버, 받아 가는 서버는 복제본이라고 불렀고 Kafka와 Raft를 다루는 대목에서는 그쪽 이름인 리더와 팔로워를 썼습니다. 구현과 격리 수준은 이 블로그의 다른 글에 있습니다.

| 주제 | 글 |
|---|---|
| 복제를 직접 구현 | [DB 내부 ⑨: 복제](/blog/project/db-hobby/db-internals-09-replication) |
| Raft와 리더 선출 | [DB 내부 ⑩: Raft](/blog/project/db-hobby/db-internals-10-raft) |
| 격리 수준과 일관성의 두 뜻 | [트랜잭션 ACID ②: Isolation](/blog/theory/transaction-acid-02-isolation), [트랜잭션 ACID ③: Consistency](/blog/theory/transaction-acid-03-consistency) |
| 한 기계 안의 같은 문제 | [멀티스레드와 동기화를 한 줄기로](/blog/theory/multithreading-and-synchronization) |

## 1. 쓰기가 어디까지 가면 성공이라고 답할지 정합니다

쓰기 하나는 주 서버의 디스크에 쓰이고 네트워크를 건너 복제본에 도착하고 복제본의 디스크에 쓰이고 복제본에 적용됩니다. 클라이언트에게 성공이라고 답하는 시점을 이 길의 어디에 두느냐가 첫 결정입니다.

![쓰기 하나가 주 서버에서 복제본으로 가는 길 위에 성공이라고 답할 수 있는 네 지점을 표시한 그림](/uploads/theory/replication-five-decisions/wait-points.svg)

일찍 답하면 빠르지만 주 서버가 죽을 때 그 쓰기가 사라질 수 있습니다. 늦게 답하면 쓰기는 안전해도 복제본이 느리거나 죽었을 때 쓰기가 함께 느려지거나 멈춥니다. 제품마다 이 지점을 고르는 손잡이가 있습니다.

| 제품 | 손잡이 | 눈여겨볼 것 |
|---|---|---|
| PostgreSQL | `synchronous_commit` (`local`, `remote_write`, `on`, `remote_apply`) | 그림의 네 지점에 차례로 대응 |
| MySQL | 반동기 복제 | 정해 둔 시간 안에 복제본의 확인이 없으면 비동기로 돌아감 |
| Kafka | `acks`, `min.insync.replicas` | `acks=all`은 지금 동기화된 복제본 집합 전체의 확인. `min.insync.replicas`의 기본값은 1 |

### 편도 5ms 링크에서 복제본을 기다리면 커밋 지연이 0.26ms에서 12.7ms가 됐습니다

PostgreSQL 16의 주 서버 한 대와 동기 복제본 한 대로 쟀습니다. 수준마다 커밋을 2,000번씩 세 차례 하고 커밋 지연의 중앙값을 적었습니다.

| 조건 | `local` | `remote_write` | `on` | `remote_apply` |
|---|---|---|---|---|
| 복제 링크에 지연 없음 | 0.24ms | 0.45ms | 0.45ms | 0.51ms |
| 복제 링크에 편도 5ms 지연 | 0.26ms | 12.67ms | 12.74ms | 12.56ms |
| 복제본의 적용을 20ms 늦춤 | 0.32ms | 0.54ms | 0.57ms | 24.90ms |

비동기(`local`)는 링크가 느려져도 0.3ms 안쪽입니다. 복제본을 기다리는 세 수준은 12.6~12.7ms가 됐습니다. 링크의 왕복 10ms에 2ms 남짓이 더 붙은 값이고 더 붙은 몫이 어디서 왔는지는 가르지 않았습니다. 복제본의 적용이 밀리면 적용까지 기다리는 `remote_apply`만 그 시간을 떠안습니다.

### 회사들은 업무마다 다른 지점을 골랐습니다

메이퇀은 2017년 글에서 MySQL을 비동기 복제로 운영하며 핵심 업무 일부에만 반동기 복제를 쓴다고 적었습니다. 그렇게 해도 95% 이상의 상황에서 데이터를 잃지 않는 정도이고 극단적인 경우에는 강한 일관성을 보장하지 못한다고 덧붙였습니다.

텐센트의 TDSQL 논문은 반동기 복제가 금융 업무의 요구를 채우지 못했다고 설명합니다. 복제본이 정해 둔 시간 안에 답하지 않으면 비동기로 내려가서 일관성 문제가 남고 데이터센터 사이의 지연과 흔들림이 크면 요청 지연도 튄다는 이유입니다. 그래서 과반의 확인을 기다리는 방식으로 바꿨는데 비동기에 견줘 처리량이 절반이 되는 경우가 많았다고 합니다. 논문은 스레드 구조를 고쳐 이 차이를 비동기에 견줄 만큼 줄였다고도 적었고 그 대목에 수치는 없습니다.

### `acks=all`이 기다리는 범위는 그때의 동기화된 집합입니다

Kafka의 `acks=all`이 기다리는 것은 지금 동기화된 복제본 집합입니다. 공식 문서는 이 집합을 "the full set of in-sync replicas"라고 씁니다. 동기화된 집합이 리더 하나로 줄면 리더 혼자 쓴 것만으로 성공이라고 답합니다. 그래서 문서는 복제본 3개에 `min.insync.replicas`를 2로 두고 `acks=all`로 쓰는 구성을 예로 듭니다. 메이퇀의 글은 `acks=all`을 완전한 동기 복제라고 했습니다. 실제로 기다리는 범위는 그때의 동기화된 집합이고 그 집합이 몇 개까지 줄어도 쓰기를 받을지는 `min.insync.replicas`가 정합니다.

## 2. 읽기를 어디서 할지 정합니다

복제본에서 읽으면 주 서버의 부하가 줄지만 복제본이 아직 받지 못한 쓰기는 보이지 않습니다. 메이퇀의 글은 사용자에게 보이는 모양을 셋으로 나눕니다.

| 모양 | 사용자가 보는 것 |
|---|---|
| 쓴 직후 읽기가 깨짐 | 방금 단 댓글이 새로 고침하면 사라져 있음 |
| 단조 읽기가 깨짐 | 보였던 댓글이 다음 새로 고침에서 사라짐. 요청마다 다른 복제본으로 갔기 때문 |
| 순서가 뒤바뀜 | 답이 질문보다 먼저 보임. 두 글이 지연이 다른 파티션에 있었기 때문 |

### 쓴 직후 읽기는 적용까지 기다리는 수준에서만 실패가 0회였습니다

1장과 같은 구성에서 주 서버에 행 하나를 넣고 커밋이 돌아오자마자 복제본에서 그 행을 읽었습니다. 아래 표는 수준마다 6,000번 가운데 읽지 못한 횟수입니다.

| 조건 | `local` | `remote_write` | `on` | `remote_apply` |
|---|---|---|---|---|
| 복제 링크에 지연 없음 | 25 | 0 | 0 | 0 |
| 복제 링크에 편도 5ms 지연 | 6,000 | 0 | 0 | 0 |
| 복제본의 적용을 20ms 늦춤 | 6,000 | 6,000 | 6,000 | 0 |

비동기는 링크가 5ms만 늦어도 매번 실패했고 그 행은 중앙값 5.8ms 뒤에 보였습니다. 같은 기계 안에서도 6,000번 중 25번 실패했습니다.

편도 5ms 조건에서 `remote_write`와 `on`의 실패가 0인 것은 보장이 아닙니다. 실행 전에는 이 두 수준에서도 실패가 나올 것이라고 적어 두었는데 0회였습니다. 확인 응답이 5ms 링크를 되돌아가는 동안 복제본이 적용을 끝냈기 때문이라고 봅니다. 응답이 돌아가기 전에 적용이 끝났는지는 따로 재지 않았습니다. 적용을 20ms 늦춘 조건에서는 두 수준이 6,000번 모두 실패했습니다. PostgreSQL 문서도 `remote_apply`만 복제본이 그 커밋을 적용해 복제본의 쿼리에 보일 때까지 기다린다고 설명합니다.

### 회사들이 푼 방법은 포기한 것이 서로 다릅니다

| 회사 | 방법 | 얻은 것 | 낸 것 |
|---|---|---|---|
| GitHub | 쓰기 뒤의 읽기 요청마다 클러스터의 최대 복제 지연을 묻고 그 값이 마지막 쓰기 뒤로 흐른 시간보다 작으면 복제본으로 보냄 | 주 서버로 가던 요청의 약 30%를 복제본으로 돌림 | 지연을 계속 재는 서비스를 운영 |
| Shopify | 관련된 읽기들을 같은 복제본으로 보냄 | 단조 읽기 | 쓴 직후 읽기는 보장하지 않음. 고른 복제본이 죽으면 불일치가 생길 수 있음 |
| PingCAP TiDB | 팔로워가 읽기 전에 리더에게 최신 커밋 위치를 확인 | 팔로워에서 읽어도 강한 일관성 | 읽기마다 리더와 한 번 더 통신 |

GitHub의 이전 규칙은 마지막 쓰기 뒤 5초 동안은 주 서버에서 읽는 것이었습니다. 복제 지연이 보통 1초 안쪽인데 5초를 기다리고 있었으므로 실제 지연을 재서 그만큼만 기다리게 바꿨습니다.

Shopify는 더 강한 방식도 검토했습니다. 쓰기의 식별자를 들고 다니며 그 쓰기를 받은 복제본에서만 읽는 방식입니다. 복제본마다 현재 위치를 보고하는 소프트웨어가 필요했고 자기들의 쓰임새에는 그 수준의 보장이 필요하지 않다고 판단해 접었다고 합니다.

## 3. 승격을 누가 결정할지 정합니다

주 서버가 죽으면 복제본 하나를 새 주 서버로 올립니다. 이 결정을 서버 밖의 도구에 맡길지 서버들끼리의 합의에 맡길지가 셋째 결정입니다. 메이퇀의 글은 승격을 주 서버가 죽었다고 판정하는 단계, 새 주 서버를 고르는 단계, 모두가 새 주 서버를 쓰게 설정을 바꾸는 단계로 나눕니다. 세 단계마다 위험이 있습니다.

- 판정 단계에서는 응답이 없다는 것만으로는 죽었는지 느린지 알 수 없어서 제한 시간으로 정합니다. 짧으면 멀쩡한 서버를 죽었다고 보고 길면 장애가 길어집니다.
- 선택 단계에서는 비동기 복제였다면 새 주 서버에는 옛 주 서버가 성공이라고 답한 쓰기 일부가 없습니다.
- 전환 단계에서는 옛 주 서버가 자기가 물러난 줄 모르고 쓰기를 계속 받으면 주 서버가 둘이 됩니다.

메이퇀의 2017년 글에 전환 단계의 사례가 있습니다. 서버 위의 스위치가 흔들려 주 서버에 닿지 못하자 승격 도구가 장애로 판정해 쓰기 주소를 새 주 서버로 옮겼습니다. 스위치가 돌아왔을 때 옛 주 서버에서 그 주소가 내려가지 않아 두 서버가 같은 주소를 가졌습니다. 메이퇀은 승격 도구가 같은 랙의 다른 서버들도 살펴보고 네트워크 고장인지 서버 고장인지 가르게 고쳤습니다.

### GitHub은 43초의 단절 뒤 24시간 11분을 썼습니다

2018년 10월 GitHub의 사후 분석에는 세 위험이 모두 나옵니다. 광 장비 교체 작업으로 동부 데이터센터와 네트워크 허브 사이의 연결이 43초 동안 끊겼습니다. 승격을 맡은 도구는 동부를 볼 수 없게 되자 서부 데이터센터의 복제본들을 주 서버로 올렸습니다.

![동부가 받은 쓰기 일부가 서부로 복제되지 못한 채 서부가 승격되어 양쪽에 서로 없는 쓰기가 남는 그림](/uploads/theory/replication-five-decisions/split-writes.svg)

동부에는 서부로 복제되지 못한 쓰기가 있었고 서부는 승격 뒤 새 쓰기를 받았습니다. GitHub은 이렇게 적었습니다.

> Because the database clusters in both data centers now contained writes that were not present in the other data center, we were unable to fail the primary back over to the US East Coast data center safely.

가장 바쁜 클러스터 하나에서 서부로 복제되지 못한 쓰기는 954건이었습니다. GitHub은 복구 시간을 내주고 데이터를 맞추는 쪽을 택했고 서비스 저하는 24시간 11분 이어졌습니다. 뒤에 바꾼 것 가운데 하나로 승격 도구가 지역의 경계를 넘어 주 서버를 올리지 못하게 했습니다.

### 합의는 승격을 서버 안으로 넣습니다

GitHub과 메이퇀의 사례에서는 데이터를 복제하는 경로와 승격을 결정하는 경로가 따로였습니다. Meta의 2023년 글이 이 구조를 직접 다룹니다. Meta의 MySQL은 반동기 복제로 데이터를 보냈고 승격과 장애 조치는 서버 밖의 Python 데몬들이 맡았습니다. 예외 상황을 덧대다 보니 이 자동화가 갈수록 복잡해졌다고 합니다. Meta는 승격과 구성원 변경을 데이터와 같은 복제 로그에 태우려고 Raft를 MySQL 안에 넣었습니다.

장애 조치가 20~40초에서 보통 2초 안으로 줄었고 쓰기 경로의 지연은 반동기 때와 같았습니다. 같은 글은 한계도 밝혔습니다.

> while correctness was easier to reason with Raft, the Raft protocol in itself does not help much in the concern of availability.

Raft는 과반이 살아 있어야 쓰기를 받으므로 과반을 잃으면 멈춥니다.

메이퇀의 분산 키값 저장소 Cellar도 Raft로 옮겼습니다. 비동기 복제에서는 고장 난 노드를 뺄 때 아직 복제되지 못한 데이터를 잃었고 결제 같은 업무는 그 유실을 받아들일 수 없어서 Raft로 바꿨다고 밝혔습니다. 합의 알고리즘 가운데 Raft를 고른 이유로는 논문이 자세하고 성숙한 오픈소스 구현이 있어 개발 기간이 줄어든다는 점을 들었습니다.

Kafka도 승격 결정을 자기 안의 합의로 옮겼습니다. 메이퇀의 글이 나온 2021년에는 브로커들을 조율하는 컨트롤러를 ZooKeeper로 뽑았는데 2025년 3월에 나온 Kafka 4.0은 ZooKeeper 없이 동작하는 방식만 남긴 첫 주요 릴리스입니다. 메이퇀의 글에 나오는 "재시작하면 하이 워터마크까지 잘라낸다"는 복구 방식은 0.11.0에서 리더 에포크 기준으로 바뀌었습니다. 하이 워터마크는 동기화된 복제본 모두가 받아 간 위치이고 리더 에포크는 리더가 바뀔 때마다 올라가는 번호입니다. 하이 워터마크로 자르면 메시지를 잃거나 복제본이 갈라지는 경우가 있어서 고친 것입니다.

### etcd가 읽기 전용이 되자 그 위의 데이터베이스가 자동 승격됐습니다

2020년 11월 Cloudflare의 장애에서 합의에 기댄 구조의 비용이 드러났습니다. 스위치 하나가 일부 패킷만 전달하는 상태가 되자 etcd 클러스터의 노드들이 서로 다른 것을 보게 됐고 리더 선출이 동률로 끝나기를 되풀이해 클러스터가 읽기 전용이 됐습니다. etcd에 건강 상태를 알리지 못한 데이터베이스 클러스터 둘에서 복제본이 자동으로 승격됐습니다. 그 클러스터 관리 시스템에는 승격 뒤 복제본을 전부 다시 만들어야 하는 결함이 있어서 읽기를 많이 받던 인증 데이터베이스의 주 서버가 부하를 혼자 떠안았고 API와 대시보드가 6시간 33분 동안 영향을 받았습니다.

메이퇀의 글은 합의를 직접 만들지 말고 ZooKeeper나 etcd에 맡기라고 권합니다. 맞는 권고이고 Cloudflare의 장애에서 보듯 맡긴 시스템이 멈출 때 무슨 일이 일어나는지도 설계에 들어가야 합니다.

### 리더가 있어도 읽기에는 확인이 한 번 더 필요합니다

합의로 리더를 뽑아도 물러난 줄 모르는 옛 리더가 읽기에 답할 수 있습니다. Raft 논문의 방법은 리더가 읽기에 답하기 전에 과반과 통신해 자기가 아직 리더인지 확인하는 것입니다. TiKV는 이 왕복을 줄이려고 리스를 씁니다. 리스는 정해 둔 시간 동안은 리더가 과반에 묻는 단계를 건너뛰고 읽기에 답해도 된다는 약속입니다. 선출 제한 시간이 10초이고 리스를 9초로 잡아서 다음 리더가 뽑힐 때에는 옛 리더의 리스가 끝나 있게 했습니다. 이 방식은 서버의 시계가 정해 둔 범위 안에서 흐른다는 가정에 기댑니다.

## 4. 몇 벌을 두고 몇 벌의 응답을 기다릴지 정합니다

몇 벌의 응답을 기다릴지는 겹침 조건으로 정하고 몇 벌을 둘지는 함께 죽는 단위까지 세어서 정합니다. 응답을 기다리는 최소 개수를 쿼럼이라고 부릅니다. 복제본 N개 가운데 쓰기는 W개, 읽기는 R개의 응답을 기다린다고 하면 W + R > N일 때 읽은 집합과 쓴 집합이 적어도 하나 겹칩니다. Dynamo 논문의 문장으로는 "Setting R and W such that R + W > N yields a quorum-like system"입니다.

메이퇀의 글은 과반 쿼럼에서 "N개의 노드는 ⌈(N+1)/2⌉−1개의 고장을 견딘다"고 적었습니다. 이 식은 N이 홀수일 때만 맞습니다.

| N | 과반 | 견디는 고장 수 | 메이퇀 글의 식 |
|---|---|---|---|
| 3 | 2 | 1 | 1 |
| 4 | 3 | 1 | 2 |
| 5 | 3 | 2 | 2 |
| 6 | 4 | 2 | 3 |

견디는 고장 수는 N에서 과반을 뺀 값, 곧 ⌊(N−1)/2⌋입니다. 4대는 3대와 똑같이 한 대의 고장만 견딥니다.

### Aurora는 함께 죽는 단위를 셌습니다

서버 수만 세면 같은 가용 영역의 서버들이 함께 죽는다는 사실을 놓칩니다. Aurora 논문은 가용 영역 하나가 죽은 상태에서 다른 서버 한 대만 더 죽어도 쿼럼을 잃기 때문에 3벌에 과반 2로는 모자란다고 봤습니다. 그래서 가용 영역 셋에 두 벌씩 6벌을 두고 쓰기는 4, 읽기는 3의 응답을 기다립니다. 가용 영역 하나와 서버 한 대를 더 잃어도 읽을 수 있고 아무 두 대를 잃어도 쓸 수 있습니다.

OceanBase 논문의 수치에도 고장 범위가 조건으로 붙어 있습니다. 복구 시점 목표 0과 복구 시간 목표 30초 미만은 소수의 노드가 고장 났을 때의 값입니다.

### W + R > N을 맞춰도 동시 쓰기, 부분 실패, 느슨한 쿼럼의 문제가 남습니다

메이퇀의 글이 정리한 한계는 그대로 유효합니다. 두 쓰기가 동시에 일어나면 어느 쪽이 남을지를 따로 정해야 합니다. 쓰기가 일부 복제본에만 성공하고 전체로는 실패해도 성공한 복제본의 값은 되돌려지지 않습니다. Dynamo는 가용성을 위해 엄격한 쿼럼을 쓰지 않습니다. 원래 맡기로 한 노드가 죽어 있으면 살아 있는 다른 노드가 대신 받았다가 나중에 넘겨줍니다. 이 경우에는 읽은 집합과 쓴 집합이 겹치지 않아 옛 값을 읽을 수 있습니다.

## 5. 쓰기를 몇 곳에서 받을지 정합니다

1장부터 3장까지는 쓰기를 한 곳에서 받는 구성이었습니다. 메이퇀의 글이 정리한 복제 방식 셋은 쓰기를 받는 곳의 수로 갈립니다.

| 방식 | 쓰기를 받는 곳 | 얻는 것 | 내는 것 |
|---|---|---|---|
| 주종 | 한 곳 | 쓰기의 순서가 하나로 정해짐 | 주 서버가 죽으면 승격이 필요 |
| 다중 주 | 여러 곳 | 가까운 곳에 쓰고 한 곳이 죽어도 계속 받음 | 같은 데이터를 두 곳에서 고치면 충돌 |
| 주 없음 | 모든 복제본 | 승격이 없음 | 충돌 해소와 뒤처진 복제본의 복구를 설계해야 함 |

Dynamo는 쓰기를 언제나 받는 저장소를 목표로 주 없는 방식을 골랐습니다. 논문은 장바구니에 담기를 거절하면 고객 경험이 나빠진다는 이유를 들었고 이 목표를 "always writeable"이라고 불렀습니다. 그 대가로 충돌은 읽을 때 풀고 장바구니에서는 갈라진 판들을 합칩니다. 논문은 이렇게 합치면 담은 물건은 사라지지 않고 지운 물건이 되살아날 수 있다고 적었습니다.

충돌을 시각이 늦은 쓰기를 남기는 규칙으로 풀면 메이퇀의 글이 짚은 대로 서버들의 시계가 서로 다를 때 나중에 일어난 쓰기가 버려집니다. 시계 문제는 순서만 세는 논리 시계를 쓰거나 시계의 오차를 드러내는 두 가지 길로 다룹니다. Spanner의 TrueTime은 오차를 드러내는 쪽이어서 현재 시각을 가장 이른 값과 가장 늦은 값의 구간으로 돌려줍니다. 논문은 이 불확실성이 대개 10ms 미만이라고 했고 Spanner는 커밋할 때 그 구간이 지나가기를 기다립니다.

바이트댄스의 그래프 데이터베이스 논문은 주종과 다중 주를 섞은 구성을 소개합니다. 같은 지역 안에서는 주종으로 복제하고 지역 사이에는 지역마다 쓰기를 받습니다. 물리 시계를 그대로 쓸 수 없어서 하이브리드 논리 시계로 충돌을 풀고 복제본 사이에는 최종 일관성만 보장한다고 적었습니다.

## 선형성과 직렬성은 다른 축입니다

복제를 다루다 보면 "강한 일관성"이라는 말이 여러 뜻으로 쓰입니다. 메이퇀의 글은 트랜잭션 격리 쪽을 외부 일관성, 복제본 사이를 내부 일관성이라고 부르고 Jepsen의 정의라고 적었는데 Jepsen의 페이지를 열어 보면 용어가 다릅니다.

| 축 | Jepsen의 이름 | 가장 강한 수준 | 묻는 것 |
|---|---|---|---|
| 객체 하나에 대한 연산 | single object operations | 선형성 | 복제본이 여럿이어도 하나처럼 보이는지 |
| 여러 객체에 걸친 트랜잭션 | multi-object transactions | 직렬성 | 동시에 돈 트랜잭션들이 하나씩 돈 것처럼 보이는지 |

두 축은 맨 위에서 엄격한 직렬성으로 만나고 Jepsen은 엄격한 직렬성이 두 계열을 합친다고 적습니다. "외부 일관성"은 Spanner 논문이 트랜잭션의 실제 시간 순서를 지키는 보장에 쓰는 말이어서 격리 수준 전체를 가리키는 이름으로 쓰기에는 맞지 않습니다. 두 축으로 나누는 것 자체는 메이퇀의 글과 Jepsen이 같습니다. 트랜잭션 쪽 축의 격리 수준은 [트랜잭션 ACID ②](/blog/theory/transaction-acid-02-isolation)에 따로 적었습니다.

CAP 정리의 C는 이 가운데 선형성입니다. 메이퇀의 글이 짚었듯 CAP은 네트워크가 완전히 끊긴 경우만 다루므로 지연과 일관성 사이의 선택은 CAP 바깥에서 따로 정해야 합니다. 이 글에서는 1장과 2장의 표가 지연과 일관성 사이의 선택을 잰 것입니다.

### Kafka의 선형성과 Jepsen 통과는 확인된 범위까지만 받아들입니다

메이퇀의 글은 `acks=all`에 `min.insync.replicas`를 과반으로 두면 한 파티션에서 선형성이 보장된다고 했습니다. Kafka의 공식 문서에서 이 보장을 찾지 못했습니다. 문서가 약속하는 것은 동기화된 복제본이 하나라도 살아 있으면 확인된 레코드를 잃지 않는다는 데까지입니다.

글 끝에는 팀이 Jepsen으로 Kafka를 시험해 통과했다는 서술이 있습니다. Jepsen이 Kafka를 직접 시험한 글로 제가 찾은 것은 2013년에 출시 전 설계를 다룬 것 하나이고 그 글에서는 확인된 쓰기가 사라지는 경우가 나왔습니다. 그 뒤로는 Kafka와 호환되는 시스템 둘을 분석하면서 Kafka 쪽의 문제를 함께 적었습니다. 2022년 Redpanda 분석은 Kafka의 기본 설정이 디스크에 내려쓰기 전에 쓰기를 확인할 수 있다고 적었습니다. 2024년 Bufstream 분석은 트랜잭션 프로토콜에서 쓰기 유실과 중단된 트랜잭션이 읽히는 문제를 찾아 Kafka 이슈로 올렸습니다. 시험을 통과했다는 말은 시험한 조건 안에서 나온 결과로 읽습니다.

## 직접 잰 조건과 한계

- PostgreSQL 16.15의 주 서버 한 대와 동기 복제본 한 대를 같은 가상 머신(CPU 6, 메모리 8GiB)의 컨테이너로 띄웠습니다. 데이터 디렉터리는 메모리 파일 시스템에 두었으므로 디스크에 내려쓰는 비용은 실제보다 작습니다.
- 클라이언트 하나가 차례로 실행했습니다. 동시에 여러 클라이언트가 쓸 때의 값은 재지 않았습니다.
- 링크 지연은 복제 연결만 지나는 프록시에 편도 5ms를 넣어 만들었습니다. 실제 데이터센터 사이의 지연과 흔들림은 이보다 큽니다.
- 적용 지연은 복제본의 `recovery_min_apply_delay`를 20ms로 두어 만들었습니다. 실제로 적용이 밀리는 원인(복제본의 긴 쿼리, 무거운 쓰기)을 재현한 것은 아닙니다.
- 측정 동안 같은 기계에서 다른 작업이 돌고 있었습니다. 앞의 두 조건을 잰 5분 동안 1분 부하 평균은 2.9~4.1이었고 적용 지연 조건을 잰 9분 동안은 2.5에서 8.5까지 올랐습니다. 그래서 중앙값만 적었고 0.1ms 단위의 차이는 이 측정으로 가릴 수 없습니다.
- 회사 사례의 수치는 각 회사가 공개한 글과 논문의 값이고 제가 재현한 것이 아닙니다.

## 참고

뼈대로 삼은 글

- [Replication（上）：常见复制模型&分布式系统挑战 (美团技术团队, 2021-08-25)](https://tech.meituan.com/2021/08/25/Replication-in-meituan-01.html)
- [Replication（下）：事务，一致性与共识 (美团技术团队, 2021-08-25)](https://tech.meituan.com/2021/08/25/Replication-in-meituan-02.html)

회사 사례

- [GitHub, October 21 post-incident analysis (2018)](https://github.blog/news-insights/company-news/oct21-post-incident-analysis/)
- [GitHub, Mitigating replication lag and reducing read load with freno (2017)](https://github.blog/engineering/infrastructure/mitigating-replication-lag-and-reducing-read-load-with-freno/)
- [Shopify, Read Consistency with Database Replicas (2021)](https://shopify.engineering/read-consistency-database-replicas)
- [Meta, Building and deploying MySQL Raft at Meta (2023)](https://engineering.fb.com/2023/05/16/data-infrastructure/mysql-raft-meta/)
- [Cloudflare, A Byzantine failure in the real world (2020)](https://blog.cloudflare.com/a-byzantine-failure-in-the-real-world/)
- [美团, 美团数据库高可用架构的演进与设想 (2017)](https://tech.meituan.com/2017/06/29/database-availability-architecture.html)
- [美团, 美团万亿级 KV 存储架构与实践 (2020)](https://tech.meituan.com/2020/07/01/KV-Squirrel-Cellar.html)
- [TiKV, How TiKV Uses "Lease Read" to Guarantee High Performances, Strong Consistency and Linearizability](https://tikv.org/blog/lease-read/), [TiDB, Follower Read](https://docs.pingcap.com/tidb/stable/follower-read)

논문

- [Amazon, Dynamo: Amazon's Highly Available Key-value Store (2007)](https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf)
- [Amazon, Amazon Aurora: Design Considerations for High Throughput Cloud-Native Relational Databases (2017)](https://pages.cs.wisc.edu/~yxy/cs764-f20/papers/aurora-sigmod-17.pdf)
- [Google, Spanner: Google's Globally-Distributed Database (2012)](https://static.googleusercontent.com/media/research.google.com/en//archive/spanner-osdi2012.pdf)
- [Tencent, TDSQL: Tencent Distributed Database System (VLDB 2024)](https://www.vldb.org/pvldb/vol17/p3869-chen.pdf)
- [OceanBase: A 707 Million tpmC Distributed Relational Database System (VLDB 2022)](https://www.vldb.org/pvldb/vol15/p3385-xu.pdf)
- [ByteDance, ByteGraph: A High-Performance Distributed Graph Database in ByteDance (VLDB 2022)](https://vldb.org/pvldb/vol15/p3306-li.pdf)
- [Ongaro & Ousterhout, In Search of an Understandable Consensus Algorithm (Raft)](https://raft.github.io/raft.pdf)

공식 문서와 분석

- [PostgreSQL 16, synchronous_commit](https://www.postgresql.org/docs/16/runtime-config-wal.html)
- [MySQL 8.4, Semisynchronous Replication](https://dev.mysql.com/doc/refman/8.4/en/replication-semisync.html)
- [Apache Kafka, Producer Configs (acks)](https://kafka.apache.org/39/generated/producer_config.html), [Topic Configs (min.insync.replicas)](https://kafka.apache.org/39/generated/topic_config.html)
- [Apache Kafka 4.0.0 Release Announcement (2025)](https://kafka.apache.org/blog/2025/03/18/apache-kafka-4.0.0-release-announcement/)
- [KIP-101: Alter Replication Protocol to use Leader Epoch rather than High Watermark for Truncation](https://cwiki.apache.org/confluence/display/KAFKA/KIP-101+-+Alter+Replication+Protocol+to+use+Leader+Epoch+rather+than+High+Watermark+for+Truncation)
- [Jepsen, Consistency Models](https://jepsen.io/consistency/models)
- [Jepsen, Kafka (2013)](https://aphyr.com/posts/293-call-me-maybe-kafka)
- [Jepsen, Redpanda 21.10.1 (2022)](https://jepsen.io/analyses/redpanda-21.10.1), [Jepsen, Bufstream 0.1.0 (2024)](https://jepsen.io/analyses/bufstream-0.1.0)

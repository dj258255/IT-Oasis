---
title: '같은 각주를 마트마다 달고 있었는데, 이미 읽던 원천에 답이 있었습니다'
titleEn: 'I Kept Writing the Same Caveat on Every Mart, When the Answer Was in a Source I Already Read'
description: '여러 마트가 같은 각주를 달고 있었습니다. "이 창고엔 기종 축이 없다, 기종은 소비자가 DBTower 화면에서 안다"는 문장이 대기 마트에도, 백업 공백 마트에도 반복됐습니다. 대기 마트는 delta와 last의 의미가 기종마다 다른데 구분을 못 했고, 백업 마트는 no_backup_observed가 정말 미백업인지 그 기종을 아직 수집 못 한 건지 못 갈랐습니다. 대시보드도 instance_id 4 같은 숫자뿐이라 안 읽혔습니다. 그런데 정작 기종이 든 database_instance는 이미 매 오프로드가 읽고 있었습니다. 인스턴스 id를 뽑느라 매번 읽던 그 테이블에, name과 type 컬럼이 나란히 있었습니다. 그래서 컬럼 두 개만 더 실어 dim_instance 차원을 만들었습니다. 이건 팩트와 성질이 다릅니다. database_instance는 시계열 스냅샷이 아니라 인스턴스 목록 자체라 느린 변화 차원이고, instance_id로 파티션할 수도 없습니다. 그래서 팩트 오프로드와 별개로 전량을 한 파일에 스냅샷하고, 마트는 최신 스냅샷만 취해 현재 상태를 만듭니다. 이 차원을 대기 마트와 주간 보고에 조인하니 instance_id 1이 local-mysql (MYSQL)로 읽히고, top 대기 이벤트가 기종과 나란히 서서 binlog는 MySQL, WalSenderMain은 PostgreSQL 복제라는 게 바로 보입니다. 흩어져 있던 각주들이 이 조인 하나로 사라집니다. 같은 김에 변경 영향 상관에 볼륨 축도 더해, 설정 변경 뒤 용량이 급증했는지도 봅니다. 다만 설정이 디스크를 직접 키우는 인과는 약해서 우선순위 최하에 조언 어휘로만 싣습니다.'
descriptionEn: 'Several marts carried the same caveat: "this warehouse has no engine axis, the consumer knows the engine from the DBTower screen." The wait mart could not tell that delta and last mean different things per engine; the backup mart could not separate whether no_backup_observed meant no backups or an engine not yet collected. Dashboards showed only numbers like instance_id 4. Yet the table that holds the engine, database_instance, was already read on every offload to get instance ids, and it had name and type columns right there. So I added just two columns to build a dim_instance dimension. It differs from facts: database_instance is not a time-series snapshot but the instance list itself, a slowly-changing dimension that cannot be partitioned by instance_id, so I snapshot the whole thing to one file separately from fact offloads and the mart takes only the latest snapshot as current state. Joining this dimension into the wait mart and weekly report makes instance_id 1 read as local-mysql (MYSQL), with top wait events sitting beside the engine so binlog reads as MySQL and WalSenderMain as PostgreSQL replication at a glance. The scattered caveats vanish with this one join. While here, I added a volume axis to the change-impact correlation to see whether capacity grew after a config change, though since a parameter rarely grows disk directly it ships at the lowest priority as advisory wording only.'
date: 2026-07-18
tags:
  - Data Engineering
  - dbt
  - DuckDB
  - Metabase
category: personal/lakehouse
coverImage: /uploads/project/lakehouse/cover.svg
draft: false
series: "lakehouse"
seriesOrder: 13
---

## 0. 같은 각주가 마트마다 반복됐다

편을 거듭하다 보니 눈에 걸리는 게 있었습니다. 여러 마트가 **같은 각주**를 달고 있었습니다.
"이 창고엔 기종 축이 없다, 기종은 소비자가 DBTower 인스턴스 화면에서 안다."

대기 마트(`mart_wait_top`)에서는 `delta_ms`와 `last_ms`의 의미가 기종마다 다릅니다. MySQL은
누적, PostgreSQL은 현재 스냅샷, Mongo는 대기 큐입니다. 그런데 마트엔 기종이 없어서 "누적인지
스냅샷인지는 저쪽에서 보세요"라고 적어 두었습니다. 백업 공백 마트에서는 `no_backup_observed`가
정말 백업이 안 도는 건지, 그 기종을 아직 수집 못 한 건지 못 갈랐습니다. 대시보드도 마찬가지로
`instance_id 4` 같은 숫자만 나와서 안 읽혔습니다.

각주가 한 곳이면 한계지만, 여러 곳에서 반복되면 신호입니다. 뭔가 빠져 있다는 신호입니다.

## 1. 원천은 이미 읽고 있었다

그런데 정작 기종이 든 테이블은 새로 만들 필요가 없었습니다. `database_instance`는 **이미 매
오프로드가 읽고 있었습니다.** "어느 인스턴스를 훑을지" 목록을 뽑느라 매번 읽던 그 테이블에,
`name`(local-mysql, local-postgres…)과 `type`(MYSQL, POSTGRESQL, MSSQL, MONGODB, ORACLE)이
나란히 있었습니다. 컬럼 두 개만 더 실으면 되는 거였습니다.

## 2. 차원으로 내린다

여기서 한 가지는 조심해야 했습니다. `database_instance`는 지금까지 내리던 팩트와 **성질이
다릅니다.** 팩트는 시계열 스냅샷이라 날짜와 인스턴스로 파티션했는데, `database_instance`는
인스턴스 목록 자체입니다. 느린 변화 차원이고, instance_id로 파티션할 수도 없습니다(그게 곧
행이니까요).

그래서 팩트 오프로드 기계를 재사용하지 않고, 전량을 날짜별로 한 파일에 스냅샷하는 작은
오프로드를 따로 만들었습니다. 이름과 기종이 나중에 바뀌면 그 이력까지 남습니다. 그리고 차원
마트(`dim_instance`)는 그중 **최신 스냅샷만** 취해 현재 상태를 만듭니다. 변화 이력이 필요하면
스테이징을 직접 보면 됩니다.

## 3. 각주가 사라진다

이 차원을 대기 마트와 주간 보고에 조인했습니다.

![기종 축이 흩어진 각주를 회수하는 구조. 왼쪽의 팩트 마트들은 instance_id 숫자만 갖고 있었는데, dim_instance를 조인하면 instance_id 1이 local-mysql (MYSQL)로 읽힌다. 이 조인 하나로 대기 마트의 delta/last 의미 각주, 백업 마트의 미백업 대 미수집 각주, 대시보드의 숫자 표기가 모두 해소된다. 새 기능이라기보다 흩어져 있던 각주의 회수다](/uploads/project/lakehouse/lh20_engine_axis.svg)

결과가 바로 읽힙니다. `instance_id 1`이 `local-mysql (MYSQL)`이 되고, top 대기 이벤트가 기종과
나란히 섭니다. `wait/io/file/sql/binlog`는 MySQL의 것이고, `WalSenderMain`은 PostgreSQL 복제,
`RESOURCE_SEMAPHORE_QUERY_COMPILE`은 MSSQL, `resmgr:cpu quantum`은 Oracle이라는 게 한눈에
보입니다. 예전엔 이 대기 이름만 보고 기종을 짐작해야 했는데, 이제 옆 칸에 기종이 있습니다.

![Metabase 주간 운영 보고 대시보드. instance_id 옆에 instance_name과 engine 컬럼이 붙어, 1은 local-mysql (MYSQL), 2는 local-postgres (POSTGRESQL), 3은 local-mssql (MSSQL), 4는 dbtower-self (POSTGRESQL)로 읽힌다. top 대기 이벤트가 기종과 나란히 서 있다](/uploads/project/lakehouse/lh20_weekly_engine.png)

이건 새 기능이라기보다 **흩어져 있던 "기종은 저쪽에서 보세요"의 회수**입니다. 원천에 이미
있던 걸 안 실었을 뿐이었습니다.

## 4. 상관에 볼륨 축을 더한다

온 김에 변경 영향 상관도 한 축 넓혔습니다. 앞 편에서 플랜 뒤집힘과 지연 두 축을 봤는데,
여기에 **변경 전후로 용량이 급증했나**를 더했습니다. 설정 변경 뒤 인스턴스의 총 크기가
임계 이상 커지면 `followed_by_size_growth`로 잡습니다.

다만 이 축은 정직하게 약한 신호입니다. 설정 변경이 디스크를 직접 키우는 경우는 드뭅니다.
로깅을 켜거나 WAL 보존을 늘리는 정도입니다. 그래서 우선순위 사다리의 **맨 아래**에 두고,
회귀나 지연 상승이 있으면 그쪽을 먼저 봅니다. 세 축(플랜·지연·볼륨)을 한 번에 조인하면
행이 곱해져 부풀 수 있어서, 지연과 볼륨을 인스턴스와 날짜 단위로 먼저 접어 조인 폭발을
막았습니다. 평균과 합의 의미는 그래도 그대로입니다.

## 5. 남은 것

이번 편은 짓기보다 **회수**에 가까웠습니다. 기종 축은 없던 걸 만든 게 아니라 원천에 있던 걸
안 실었던 것이고, 그걸 실으니 네댓 군데 각주가 한 번에 사라졌습니다. 판정 마트들이 이제
숫자 대신 이름과 기종으로 읽히니, 사람이 대시보드를 볼 때 머릿속으로 하던 "4번이 어느
DB더라"를 안 해도 됩니다.

상관 층은 이제 플랜·지연·볼륨 세 축입니다. 다만 볼륨과 지연은 후행 관측이 필요해서, 변경이
당일 일어난 지금은 아직 신호가 안 켜집니다. 이건 정직한 상태이고, 데이터가 쌓이면 켜집니다.
축을 미리 다 벌려 놓기보다 신호가 실제로 도는 걸 보고 하나씩 붙이는 방식은 이번에도 지켰고,
볼륨 축을 맨 아래에 둔 것도 그 절제의 일부입니다.

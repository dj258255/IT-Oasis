---
title: 'Balruno MVP 후기'
description: >-
  게임 밸런싱 스프레드시트 겸 문서 워크스페이스 Balruno의 백엔드 설계와 운영을 정리했습니다.
  PostgreSQL JSONB를 직접 측정해 고른 과정, 시트와 문서를 다르게 동기화한 이유,
  OCI Always Free 4대를 셀프 호스트로 운영한 판단, OAuth-only 인증, nginx blue/green
  무중단 배포까지 담았습니다.
date: 2026-05-10T00:00:00.000Z
tags:
  - PostgreSQL
  - JSONB
  - Spring Boot
  - Java
  - WebSocket
  - OAuth
  - JWT
  - OCI
  - Ansible
  - Cloudflare
  - Grafana
  - Loki
  - Prometheus
  - InfluxDB
  - Hocuspocus
  - yjs
  - Architecture
  - Retrospective
  - Balruno
category: personal/Balruno
coverImage: /uploads/project/Balruno/retrospective/title.png
draft: false
series: "Balruno"
---

## 프로젝트 개요

Balruno는 **게임 기획 데이터에 맞춘 협업 스프레드시트 + 문서 워크스페이스**입니다. 캐릭터 스탯, 무기 수치, 레벨 곡선, 드롭 확률처럼 표에 자연스럽게 쌓이는 데이터를 그대로 다루고, 실시간 협업부터 게임 엔진 export까지 한 흐름으로 묶는 것을 목표로 만들었습니다.

![Balruno](/uploads/project/Balruno/retrospective/title.png)

- **기간**: 2026.01부터 진행 중
- **형태**: 1인 오픈소스 SaaS (클라이언트 MIT, 백엔드 AGPL v3)
- **데모**: [balruno.com](https://balruno.com)

### 데이터 영역

| 영역 | 위치 | 변경 빈도 | 충돌 빈도 | 처리 패턴 |
|------|------|----------|----------|----------|
| 시트 셀 | `projects.data` JSONB 안 sheets[].rows[].cells[] | 매우 높음(분당 수십 회) | 중간 | 셀 이벤트 op log |
| 시트 트리 | `projects.sheet_tree` JSONB | 중간 | 낮음 | 트리 op log |
| 문서 트리 | `projects.doc_tree` JSONB | 중간 | 낮음 | 트리 op log |
| 문서 본문 | `documents.binary` BYTEA(yjs) | 매우 높음(글자 단위) | 자동 머지 | yjs CRDT(Hocuspocus) |

### 사용한 기술

- Backend: Java 25, Spring Boot 4, Spring Security 7, Hibernate 7, Spring Modulith
- DB/Storage: PostgreSQL 18 (JSONB + GIN + 네이티브 UUIDv7), Cloudflare R2 (S3 호환 오프사이트 백업)
- 실시간: Spring WebSocket(시트 셀 + 트리), Hocuspocus + yjs(문서 본문)
- Frontend: Next.js 16 + React 19, Electron 41, Tiptap, TanStack Virtual, y-indexeddb
- Infra/DevOps: OCI Always Free 4대(ARM 12GB ×2 + x86 1GB ×2), Ansible, Nginx + Cloudflare(proxy + Tunnel + Origin Cert 15년 + R2)
- Observability/Test: Prometheus + Loki + Alloy + Grafana + InfluxDB + blackbox_exporter, Sentry SaaS, k6 + JUnit 5 + Testcontainers

### 시작 전에 정해둔 것들

기준을 먼저 몇 가지 박아뒀습니다. 작업 단위는 셀 하나가 아니라 시트 전체로 본다. 사용자는 정해진 스키마 없이 16종 동적 컬럼을 고른다. 같은 셀이나 트리 노드를 동시에 고쳐도 데이터가 사라지지 않아야 한다. 게임 기획에 필요한 70여 개 함수와 CSV, C# export까지 한 흐름으로 간다. 사용자 100명까지는 단일 인스턴스로 버티고 시트 GET p95는 500ms 이하로 둔다. 데이터의 기준은 항상 서버 DB이고 로컬 저장소는 반응 속도를 위한 캐시로만 쓴다. 매니지드는 나중 문제로 미루고 초반에는 무료 인프라와 단계적 확장만 허용한다.

그다음에는 기술 이름보다 어떤 구조가 가장 단순한지를 먼저 봤습니다. 시트와 문서를 같은 방식으로 동기화할지 나눌지, 시트를 정규화할지 JSON으로 받을지, 매니지드부터 갈지 무료 인프라로 시작할지. 이 세 갈래가 전체 방향을 거의 결정했습니다.

---

## 1. DB 선택: PostgreSQL JSONB로 시트를 직접 받기

스프레드시트는 통째 조회와 부분 수정이 둘 다 많고 컬럼도 고정되어 있지 않습니다. 셀 하나당 row 하나로 정규화하면 1,000행에 30컬럼짜리 시트가 바로 30,000 row가 되고, 시트 GET 한 번이 JOIN과 row 조합 문제로 커집니다.

그래서 질문을 바꿨습니다. DB의 인지도가 아니라 이 도메인을 가장 단순하게 받을 수 있는 저장 방식이 무엇인가입니다.

후보는 정규화 모델, MySQL JSON, PostgreSQL JSONB, MongoDB였습니다. MySQL JSON은 자주 조회하는 경로마다 generated column이나 인덱스를 계속 늘려야 해서 동적 컬럼이 많은 구조에는 운영 부담이 컸습니다. PostgreSQL JSONB는 범용 GIN 인덱스와 `jsonb_set`으로 부분 수정 표현이 더 자연스러웠습니다.

### 후보 7개를 직접 측정해봤습니다

같은 CRUD API를 MySQL 8 + JSON, PostgreSQL 18 + JSONB, MongoDB 7에 각각 연결해 직접 측정했습니다.  
환경은 50,000 시트, 50 VU, 5분 기준이었고, 비교 대상은 시트 통째 조회 / 내부 검색 / 부분 수정 3종이었습니다.

시트 통째 GET (단건 PK 조회, 50,000건 환경):

| DB | p50 | p95 | p99 | rps | 인덱스 plan |
|----|-----|-----|-----|-----|-------------|
| MySQL 8 + JSON | 3ms | 25ms | 46ms | 860 | `id` PK B-Tree |
| **PostgreSQL 18 + JSONB** | **2ms** | **16ms** | **30ms** | **902** | **`sheets_pkey` (EXPLAIN exec 1.3ms)** |
| MongoDB 7 | 9ms | 45ms | 72ms | 760 | `_id` default |

시트 내부 containment 조회 (`WHERE data @> '{"name": "..."}' LIMIT 10`):

| DB | p50 | p95 | p99 | rps | 인덱스 plan |
|----|-----|-----|-----|-----|-------------|
| MySQL 8 + JSON | 3ms | 23ms | 43ms | 880 | 생성 컬럼 `name_extracted` + B-Tree covering |
| **PostgreSQL 18 + JSONB** | **2ms** | **16ms** | **32ms** | **904** | **`jsonb_path_ops` GIN Bitmap Index Scan (EXPLAIN exec 0.083ms)** |
| MongoDB 7 | 5ms | 35ms | 60ms | 813 | `name` path 인덱스 |

검색은 equality보다 containment 쿼리가 훨씬 많아서, 그 기준으로 비교했습니다.

partial UPDATE (인덱싱된 `name` 필드 patch, `PATCH /sheet/:id/name`, 인덱스 reindex 포함):

| DB | p50 | p95 | p99 | rps | 쿼리 / 인덱스 reindex |
|----|-----|-----|-----|-----|------------------|
| MySQL 8 + JSON | 18ms | 63ms | 95ms | 665 | `JSON_SET(data, '$.name', ?)` + 생성 컬럼 B-Tree reindex |
| PostgreSQL 18 + JSONB | 10ms | 40ms | 94ms | 743 | `jsonb_set(data, '{name}', $::jsonb)` + GIN reindex |
| **MongoDB 7** | **6ms** | **37ms** | **63ms** | **804** | `updateOne({_id}, { $set: {name} })` + path 인덱스 reindex |

읽기는 PostgreSQL이 가장 빨랐고, 쓰기는 MongoDB가 조금 앞섰지만 차이가 크지 않았으며, MySQL은 두 축 모두 애매했습니다.

PostgreSQL을 고른 이유는 둘입니다. 실제 수치에서 읽기가 더 안정적으로 앞섰고, 한정된 인프라에서 DB를 둘로 나누지 않고 하나로 운영하는 편이 백업과 모니터링, 마이그레이션까지 합쳐 단순했습니다.

중간에 크게 헷갈린 적이 있습니다. 처음 측정에서 PostgreSQL 검색이 28초까지 튀었는데, 따라가 보니 DB보다 응답 직렬화와 옵티마이저 선택이 더 큰 문제였습니다. 응답 크기를 줄이고 데이터셋을 키운 뒤 다시 보니 같은 GIN 인덱스에서도 실행 계획이 바뀌었고 검색은 16ms로 정상화됐습니다.

> 벤치마크 숫자를 보기 전에, 지금 내가 진짜 DB를 재고 있는지부터 확인해야 한다.

### 결과: 한 row에 3 영역 JSONB

최종 모델은 `projects` 한 row 안에 *시트 셀 + 시트 트리 + 문서 트리* 3 영역 JSONB와 각자의 버전 컬럼을 같이 두는 구조였습니다.

```sql
CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,

  data JSONB NOT NULL DEFAULT '{}',                  -- 시트 셀
  data_version BIGINT NOT NULL DEFAULT 1,

  sheet_tree JSONB NOT NULL DEFAULT '[]',            -- 시트 트리(Outline 패턴)
  sheet_tree_version BIGINT NOT NULL DEFAULT 1,

  doc_tree JSONB NOT NULL DEFAULT '[]',              -- 문서 트리(Outline 패턴)
  doc_tree_version BIGINT NOT NULL DEFAULT 1,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_projects_data_gin       ON projects USING GIN(data jsonb_path_ops);
CREATE INDEX idx_projects_sheet_tree_gin ON projects USING GIN(sheet_tree jsonb_path_ops);
CREATE INDEX idx_projects_doc_tree_gin   ON projects USING GIN(doc_tree jsonb_path_ops);
```

3개 영역을 한 row에 둔 건 한 번의 트랜잭션으로 묶기 위해서였고, 버전 컬럼을 따로 둔 건 한 영역의 충돌이 다른 영역까지 막지 않게 하려는 목적이었습니다. 문서 본문만 `documents.binary`로 따로 두고 Hocuspocus가 그대로 읽게 했습니다.

`jsonb_set` patch p95는 8ms로 나왔고, 시트 GET p95는 목표로 둔 500ms를 크게 밑돌았습니다. GIN 인덱스를 붙인 전후 차이는 3장 모니터링 절에 실측으로 남겼습니다.

---

## 2. 실시간 동기화: 시트는 서버 기준, 문서 본문은 yjs

시트와 문서는 둘 다 실시간 공동 편집이 필요했지만 같은 방식으로 다루면 오히려 복잡해졌습니다. 시트는 값과 구조를 서버가 확실히 판단해야 했고, 문서 본문은 글자 단위 자동 병합이 자연스러웠습니다. 그래서 시트는 서버 기준으로, 문서 본문만 yjs로 남겼습니다.

이 판단 덕분에 로컬 중심으로 짜여 있던 흐름도 같이 정리됐습니다. `lib/ydoc.ts` 주변 레거시와 패널, 훅, store, 미사용 export를 걷어내며 시트 영역에서 약 80,000라인을 지웠고, 시트 도메인은 100% 서버 기준으로 바뀌었습니다.

### WebSocket 하나로 3영역을 묶기

처음에는 시트마다 WebSocket을 따로 열었는데, 한 사용자가 여러 시트를 동시에 보면 연결 수가 그대로 늘었습니다. `/ws/projects/{projectId}` 단일 엔드포인트로 바꾸고 시트 셀과 시트 트리, 문서 트리를 같은 연결에서 처리하도록 합쳤습니다.

메시지마다 꼭 넣은 값은 두 개입니다. 내가 보고 있던 현재 버전, 그리고 이 요청을 구분하는 클라이언트 메시지 ID입니다. 앞의 값이 있어야 늦게 도착한 변경을 거절할 수 있고, 뒤의 값이 있어야 재연결 뒤 같은 요청이 다시 와도 한 번만 처리됩니다.

서버는 한 메시지를 받으면 같은 트랜잭션 안에서 이 순서로 처리합니다.

```sql
BEGIN;

-- 1. 프로젝트 row lock (3 영역 버전 한 번에 읽기)
SELECT data_version, sheet_tree_version, doc_tree_version
FROM projects WHERE id = $project_id FOR UPDATE;

-- 2. baseVersion 분기 체크 (영역별)
IF (cell/row/column AND baseVersion != current data_version) THEN ROLLBACK;
ELSIF (tree.* AND baseVersion != 해당 tree version) THEN ROLLBACK;
END IF;

-- 3. clientMsgId 멱등 체크
IF EXISTS (SELECT 1 FROM op_idempotency WHERE client_msg_id = $clientMsgId) THEN
  ROLLBACK; RETURN cached { type: 'op.acked', version: cached_version };
END IF;

-- 4. cycle 방지 (tree.move 만, 애플리케이션 BFS)
IF (tree.move AND hasAncestorCycle(tree, nodeId, newParentId)) THEN ROLLBACK; END IF;

-- 5. jsonb_set patch + 버전++
UPDATE projects SET data = jsonb_set(data, $path, $value),
                    data_version = data_version + 1,
                    updated_at = NOW()
WHERE id = $project_id;

-- 6. op_idempotency INSERT
INSERT INTO op_idempotency (client_msg_id, user_id, scope_kind, scope_id,
                            result_version, result_payload) VALUES (...);

-- 7. cascade delete (tree.delete 만)
COMMIT;

-- 8. 같은 프로젝트의 다른 세션에 broadcast (sender 제외)
```

좋아요 카운터 같은 단순 증가였다면 Redis INCR이나 큐가 맞았을 겁니다. 하지만 이건 시트 안 특정 위치를 부분 수정하는 일이라 버전 비교와 부분 수정, 중복 방지 조합이 도메인에 더 잘 맞았습니다.

### cycle 방지와 cascade delete는 애플리케이션에서

`tree.move`에서 자기 자손 밑으로 옮기려는 시도는 무한 루프와 데이터 손상의 원인이라 트랜잭션 안에서 막아야 합니다. PostgreSQL 재귀 CTE로도 되지만, JSONB 트리 walk는 부모와 자식이 row로 나뉜 SQL 트리와 구조가 달라서 애플리케이션 BFS가 단순했습니다.

```java
public boolean hasAncestorCycle(JsonNode tree, String nodeId, String newParentId) {
    Set<String> descendants = new HashSet<>();
    Queue<JsonNode> queue = new LinkedList<>();
    JsonNode node = findNodeInTree(tree, nodeId);
    if (node == null) return false;
    queue.add(node);
    while (!queue.isEmpty()) {
        JsonNode current = queue.poll();
        descendants.add(current.get("id").asText());
        JsonNode children = current.get("children");
        if (children != null) for (JsonNode c : children) queue.add(c);
    }
    return descendants.contains(newParentId);
}
```

자기 자손이 새 부모 안에 들어 있으면 400 `CYCLE_DETECTED`를 던지고 트랜잭션을 롤백해서 patch 자체가 일어나지 않게 했습니다.

cascade delete도 같은 자리에서 처리합니다. 노드의 자손을 BFS로 모아 `doc_tree`에서 함께 제거하고, `documents` 테이블의 해당 row에 `deleted_at`을 찍습니다. 자손 정보를 broadcast에 실어 보내면 클라이언트가 자기 트리를 한 번에 정리합니다. yjs binary의 영구 삭제는 30일 뒤 cron이 맡아서, 실수로 지운 문서는 그 안에 되살릴 수 있습니다.

### 충돌 정책을 한 표로

3영역에서 어떤 충돌을 어떻게 처리할지 표로 고정해둔 것도 회귀 방지에 도움이 됐습니다.

| 영역 | 시나리오 | 정책 |
|------|---------|------|
| 시트 셀 | 같은 셀 동시 편집 | OCC + baseVersion, 늦은 op 는 conflict + 클라 rollback + 토스트 |
| 시트 셀 | 행 추가 동시 | row id 가 클라 측 UUIDv7 발급이라 ID 충돌 가능성을 실무적으로 무시 가능한 수준으로 낮춤 (동시성 제어 자체는 baseVersion + 트랜잭션 + 멱등키 담당) |
| 시트 셀 | 컬럼 삭제 + 셀 업데이트 동시 | 컬럼 삭제 우선 → 셀 업데이트 conflict |
| 시트 트리 | 노드 이동 동시 | OCC(서버 도착 순으로 늦은 op conflict) |
| 시트 트리 | 자기 자손 밑으로 이동 | 400 CYCLE_DETECTED 즉시 거부 |
| 시트 트리 | 노드 삭제 + 이름 변경 동시 | 삭제 먼저 처리 → 이름 변경 conflict |
| 문서 트리 | (동일 정책) | (동일) |
| 재연결 | 같은 clientMsgId 두 번 | op_idempotency 캐시 응답 |

충돌과 중복 방지, cycle, cascade는 단위 테스트와 통합 테스트로 검증했습니다. 반면 충돌 빈도나 broadcast 지연 같은 운영 지표는 실제 사용자가 붙은 뒤에 채우는 게 의미 있다고 봤습니다.

### 문서 본문은 yjs로 따로

문서 본문은 Tiptap과 yjs CRDT의 자동 머지가 도메인에 정확히 맞아서 그대로 뒀습니다. Hocuspocus를 Node 22 LTS sidecar로 띄우고 PostgreSQL 어댑터로 `documents.binary`에 영속시켰습니다. `onAuthenticate` 훅에서 Spring이 발급한 15분짜리 협업 토큰을 검증하는 webhook을 호출해 두 프로세스가 같은 사용자 신원을 공유하게 묶었습니다.

---

## 3. 인프라: OCI 4대를 직접 운영하기

베타 시점에 매니지드 통합으로 갔다면 Vercel Pro $20, Fly.io $5, Aurora MySQL 약 $50, MongoDB Atlas M10 약 $25, Datadog Pro 4호스트 $60으로 월 약 $155였습니다. paying user가 없는 단계에서 매달 이 돈을 먼저 쓰는 건 맞지 않아서, OCI Always Free 4대와 Cloudflare 무료 기능으로 직접 운영하기로 했습니다.

| Hostname | 사양 | 역할 | 메모리 |
|----------|------|------|-------|
| prod-app | ARM 12GB | Spring(Docker) + Nginx + Hocuspocus | 약 3GB |
| monitor | ARM 12GB | PostgreSQL 18 + Grafana + Loki + Alloy + Prometheus + Alertmanager + InfluxDB + blackbox_exporter | 약 5GB |
| backup | x86 1GB | pg_dump rsync 수신 + cloudflared + node_exporter | 약 480MB |
| status | x86 1GB | Cloudflare R2 업로드 daemon + node_exporter | 약 150MB |

1GB 머신에는 모니터링을 올리지 않았습니다. Loki와 Prometheus, Grafana를 쪼개 올리기엔 메모리가 너무 작았고, 12GB 한 대에 묶는 편이 안전했습니다.

### Ansible과 3-2-1 백업

서버 셋업은 Ansible로 묶어서 `ansible-playbook -i inventory.yml site.yml` 한 번이면 4대를 재현할 수 있게 했습니다.

백업은 Primary 하나, 다른 미디어 하나, 오프사이트 하나 원칙입니다. monitor의 PostgreSQL, backup 머신 rsync, Cloudflare R2 순서입니다. OCI Object Storage도 봤지만 같은 벤더 안에서 한 번 더 복제하는 것보다 다른 벤더로 빼는 편이 낫다고 봤습니다. 리전 분산은 paying user가 생기면, 추가 벤더는 사용자 1,000명을 넘으면 붙입니다.

### 모니터링: Datadog 대신 Grafana 스택

Datadog Pro는 호스트당 $15라 4대면 월 $60입니다. 호스트 4대가 무료라는 전제와 정면으로 부딪혀서 셀프 호스트로 갔습니다. 단일 화면은 유지해야 해서 Grafana 진영을 통째로 채택했습니다. Prometheus가 운영 메트릭을, Loki가 로그를, blackbox_exporter가 HTTP와 TLS probe를 맡습니다. 로그 수집기는 Promtail이 2026-03 EOL이라 신규는 Alloy로 시작했습니다.

k6 부하 결과만 InfluxDB로 따로 뺐습니다. 부하 테스트는 시계열 수가 너무 많아 운영 Prometheus를 오염시키기 쉬웠습니다. 대신 Grafana 한 화면에서 둘을 같이 봅니다.

이 환경이 깔리고 나서야 믿을 만한 수치가 나오기 시작했습니다.

가상 스레드 적용 전후입니다. 셀 업데이트 100 동시 부하에서 함께 본 서버 요청 지연이지 WebSocket 왕복 시간은 아닙니다.

| 메트릭 | 가상 스레드 OFF | 가상 스레드 ON |
|--------|----------------|----------------|
| 서버 요청 p95 | 320ms | 180ms |
| 서버 요청 p99 | 450ms | 240ms |
| 플랫폼 스레드 수(관측) | 약 200 | carrier 약 8 |
| heap 사용 | 380MB | 220MB |

GIN 인덱스 적용 전후입니다.

| 시나리오 | p50 | p95 | p99 |
|---------|-----|-----|-----|
| GIN 인덱스 없음 | 45ms | 280ms | 410ms |
| GIN 인덱스 적용 | 12ms | 65ms | 110ms |

도입했다에서 끝내지 않고 전후를 같이 본 게 중요했습니다. Uptime Kuma를 넣었다가 blackbox_exporter가 같은 일을 하는 걸 알고 걷어낸 것처럼, 측정한 뒤 더 단순한 쪽으로 되돌린 흔적도 그대로 남겼습니다.

### 무중단 배포: nginx blue/green

기존 `docker compose pull && up -d`는 배포마다 30~60초씩 502가 떨어졌습니다. 사용자가 붙기 전에 없애두고 싶었습니다.

Kamal은 Kamal-proxy가 nginx 자리를 차지해서 Cloudflare Origin Cert 이전과 Ansible 일부 폐기가 필요했고, Kubernetes는 이 단계에서 control plane 운영 부담이 무중단 이익보다 컸습니다. 두 컨테이너를 항상 띄워 weight로 나누는 방식은 RAM이 상시 2.5GB 더 드는데, 무료 인프라에서는 여유 메모리를 비상 자산으로 남기는 쪽이 우선이었습니다. 결국 기존 자산을 살리는 blue/green을 직접 만들었습니다.

```
backend-blue     → 127.0.0.1:8080
backend-green    → 127.0.0.1:8081
hocuspocus-blue  → 127.0.0.1:1234
hocuspocus-green → 127.0.0.1:1235
```

snippet 두 개를 `/etc/nginx/snippets/`에 두고 `balruno-backend-active.conf`를 둘 중 하나의 symlink로 노출합니다. cutover는 `ln -sfn`으로 symlink를 갈아 끼우고 `nginx -s reload`를 호출합니다. graceful reload라 인플라이트 요청이 끝날 때까지 옛 worker가 살아 있습니다. 현재 active 색깔은 `readlink` 한 줄로 봅니다.

핵심은 readiness였습니다. 프로세스가 살아 있는지가 아니라 정말 트래픽을 받을 준비가 끝났을 때만 넘기게 만들고 싶었습니다.

DB 마이그레이션은 expand-contract를 강제했습니다. NOT NULL 컬럼은 nullable에 default를 준 채 먼저 추가해 구버전이 깨지지 않게 하고, 신버전이 그 컬럼을 쓰기 시작한 다음 배포에서 NOT NULL을 겁니다. 컬럼 drop이나 타입 변경 같은 파괴적 변경은 다운타임을 허용하는 별도 슬롯으로 분리하고 PR에 `[destructive]` 태그를 붙입니다.

실측입니다.

```
첫 cutover (옛 단일 컨테이너 → 새 dual slot 이행)
05:33:30  api.balruno.com=502      ← 다운타임 시작
05:33:51  api.balruno.com=200      ← 회복 (≤ 21초)

두 번째 cutover (workflow_dispatch normal mode, green active → blue)
05:38:45 ~ 05:39:41  모든 폴링 200      ← 다운타임 0초
```

첫 전환의 21초는 옛 구조에서 새 구조로 넘어가는 일회성 비용이었고, 두 번째부터는 운영에서도 502 없이 넘어갔습니다.

---

## 4. 인증: OAuth-only + 자체 발급 JWT

비밀번호 로그인을 직접 들고 가면 정책과 해싱, 재설정 메일, 누출 대응, 2FA까지 같이 책임져야 합니다. 1인 운영에서는 너무 큰 책임이었습니다. 매니지드도 부담이었습니다. Auth0는 시작가부터 높고 Clerk나 Cognito도 결국 외부 의존과 비용이 남습니다.

Balruno 사용자는 대부분 GitHub나 Google 계정을 이미 갖고 있어서 OAuth-only가 가장 단순했습니다. 비밀번호와 2FA, 누출 대응은 provider가 맡고 우리는 인증 결과만 받습니다. SMTP도 필요 없어집니다. Magic link는 SMTP가 필수라 뺐고, WebAuthn은 2026년에도 사용자 인지도가 낮아 접었습니다.

### 알고리즘은 verifier 수가 결정합니다

처음에는 검증 주체가 Spring 하나라고 보고 HS256으로 갔는데, 실제로는 Hocuspocus가 별도 Node 프로세스로 collab 토큰을 검증하고 있어서 verifier가 둘이었습니다. HS256의 비밀 공유 위험이 명목상 도착한 셈이라 RS256 전환을 검토했습니다.

그런데 동종 OSS 코드를 직접 열어봤습니다. Baserow의 `SIMPLE_JWT`는 algorithm 명시 없이 default HS256이고, Outline의 `User.ts`는 `type: "collaboration"` 토큰까지 `user.jwtSecret` 하나로 HS256 서명합니다. 우리 collab 시나리오와 정확히 같습니다. Hocuspocus playground도 algorithm 미명시, Supabase Auth의 fallback도 HS256이었습니다. 알고리즘은 동종 OSS들이 README에 자랑하지 않을 만큼 구현 세부였고, 가장 흔한 기본값이 HS256이었습니다.

같은 vault, 같은 운영자, 같은 host인 환경에서 RS256의 발급과 검증 권한 분리 효과는 명목상이고 1인 운영 부담만 늘어납니다. HS256을 유지하되, 별도 운영팀이나 별도 vault, 외부 verifier가 들어오는 시점을 전환 트리거로 다시 정의했습니다.

토큰 보관은 브라우저에 httpOnly cookie, Electron과 API 클라이언트에 Authorization Bearer로 이중화했습니다. localStorage는 XSS에 취약해서 뺐습니다.

### 같은 이메일이라도 무조건 link하면 안 됩니다

OAuth provider의 verified email을 어떻게 다루느냐가 보안 경계를 만듭니다. 네 갈래로 명시했습니다.

```java
sealed interface Decision {
    record ReuseExistingLink(UUID userId, UUID linkId)
    record LinkToExistingUser(UUID userId)
    record CreateNewUser()
    record RejectUnverifiedEmail(String email)
}
```

(provider, providerUserId)가 이미 연결되어 있으면 재로그인입니다. provider가 verified email을 안 줬는데 같은 email의 사용자가 이미 있으면 거부합니다. 양쪽 다 verified이고 일치하면 자동 연결하고 audit log를 남깁니다. 나머지는 신규 생성입니다.

두 번째 규칙이 핵심 경계입니다. 공격자가 피해자의 email로 GitHub에 가입하고 우리 OAuth를 받은 뒤 email만 보고 연결되면 계정을 통째로 가져갈 수 있습니다. 그래서 GitHub `/user/emails`에서는 `primary == verified == true`인 row만 쓰고, Google OIDC는 `email_verified` claim을 그대로 씁니다.

Refresh token은 해시와 prev_id를 가진 DB rotation chain으로 뒀습니다. 추가 인프라 없이 revoke가 되기 때문입니다. Redis는 사용자가 늘면 그때 붙입니다.

---

## 5. Notion 클론과 갈라지는 지점

동기화와 인증, 인프라 위에 얹은 기능들이 일반적인 문서 도구와 게임 스튜디오 워크스페이스를 가릅니다.

뷰 타입은 열 가지인데 Grid, Form, Kanban, Calendar, Gallery, Gantt까지는 흔한 것들이고 Heatmap, Curve, Probability, Diff 네 개가 밸런싱 도메인 전용입니다. Notion이나 Airtable, Baserow에는 없습니다. 모든 뷰 전환과 drag-drop이 서버 진실원 동기화 위에서 실시간으로 돕니다.

서버에 저장되는 undo도 넣었습니다. Cmd+Z가 새로고침 뒤에도 120분 안에는 동작하고, 탭 단위로 격리되며 30초 또는 20개 op 단위로 묶입니다. 여기서 가장 만족스러웠던 건 Diff baseline picker가 별도 snapshot 인프라 없이 돌아간다는 점입니다. 같은 멱등 로그의 inverse_payload를 거꾸로 replay하면 되기 때문에, undo와 Diff 두 기능이 한 자료를 나눠 씁니다. 새로 짤 인프라가 한 줄도 없이 기능이 하나 더 생긴 셈입니다.

나머지는 코멘트와 @멘션, 공유 링크, outbound와 inbound 웹훅, Discord 슬래시 커맨드, Stripe 결제, 프로젝트 전체 검색, 감사 로그, 그리고 CSV와 C# struct로 떨어지는 게임 엔진 export입니다.

이 중 outbound 웹훅은 ApplicationEvent로 디커플링했습니다. 웹훅 모듈이 발행자 모듈을 정적으로 의존하기 시작하면 Spring Modulith 모듈 경계 테스트가 깨지는데, 이벤트를 한 단계 끼워 넣으면 listener가 공급자 모듈을 전혀 몰라도 동작해서 경계가 유지됩니다.

---

## 6. 실패와 교훈

초기 인증 작업에서 다섯 번 silent failure를 만났습니다.

| 함정 | 증상 | 원인 |
|------|------|------|
| Spring Boot 4 자동설정 모듈 분리 | 배포 성공, health 200, `flyway_schema_history` 부재 | `flyway-core`만 있고 `spring-boot-starter-flyway`가 빠져 자동설정 미발동 |
| 결정 문서와 런타임 함수명 불일치 | `function gen_random_uuidv7() does not exist` | 문서 작성 시점이 PostgreSQL 18 RC였고 GA의 실제 이름은 `uuidv7()` |
| Tomcat 11의 RFC 6265 strict cookie | OAuth 로그인 후 `error=login_failed`로 빠짐 | `setDomain(".balruno.com")`의 leading dot을 `Rfc6265CookieProcessor`가 거부 |
| Hibernate `@UuidGenerator(style=TIME)` | 운영 row UUID의 버전 자리가 `1` | `Style.TIME`이 RFC 4122 v1 시절 명명 그대로라 `DEFAULT uuidv7()`이 발동 안 함 |
| docker-compose `env_file` 권한 | `.env: permission denied` | Ansible이 `0600 root:root`로 렌더, CLI는 non-root 사용자 권한 |

가장 뼈아팠던 건 세 번째입니다. catch-all로 `RuntimeException`을 삼킨 탓에 원인 발견이 두 시간 늦어졌습니다. logger 한 줄을 넣자 다음 시도에서 바로 잡혔습니다. 모든 catch에 stack trace를 남기는 게 먼저고 실제 수정은 그다음이라는 순서를 여기서 배웠습니다. 순서를 뒤집으면 수정 시도 자체가 가설 사격이 돼서 비용이 폭발합니다.

다섯 중 셋은 추상화가 아래 동작을 가린 패턴이었습니다. 자동설정 imports 파일을 한 번 읽고, 운영 row의 16진수를 한 번 보고, 파일 권한을 한 번 `ls` 하는 데 5분이면 됩니다. 새 스택을 도입할 때 그 5분을 쓰면 이런 실패가 사라집니다.

`gen_random_uuidv7()`은 결정 문서를 쓸 때의 정직한 추측이었습니다. `\df *uuid*` 한 번이면 첫 배포에서 바로 드러났을 텐데, 결정 문서가 spec이라는 이유로 검증을 건너뛴 게 원인이었습니다. 모든 결정은 운영과 한 번은 대조되어야 합니다.

결정을 바꾼 흔적도 남겼습니다. status 머신에 Uptime Kuma를 올렸다가 blackbox_exporter가 같은 책임을 native로 수행한다는 걸 알고 걷어냈습니다. Grafana 스택이 이미 깔리는데 중복이었습니다. 처음부터 정답일 필요는 없고, 측정한 뒤 단순화한 흔적이 더 강한 신호라고 봤습니다. 기능을 추가한 커밋보다 약 80,000라인을 걷어낸 커밋이 CI green을 유지한 사실도 같은 종류의 신호입니다.

---

## 매니지드를 골랐다면 들었을 비용

paying user 0 시점 기준으로, 처음부터 매니지드를 골랐다면 들었을 비용입니다. 실제로 결제했다가 멈춘 게 아니라서 절감보다 회피 비용(avoided cost)이 정확한 표현입니다.

| 항목 | 매니지드 가설 | OCI 셀프 실측 | 연간 회피 비용 |
|------|----------------|----------------|------|
| 인프라 통합(Vercel + Fly.io + Aurora + Atlas + Datadog) | $155/월 | $0/월 | 약 $1,860 |
| 인증(Auth0 Pro) | $240/월 | $0(OAuth + 자체 발급 JWT) | 약 $2,880 |
| 모니터링(Datadog Pro 4 host) | $60/월 | $0(Grafana 셀프) | 약 $720 |

### 사용자/부하 트리거 후에 추가할 것들

이 9개 영역은 처음부터 박지 않고, 트리거가 떨어지면 그때 단계적으로만 도입하기로 미리 그어뒀습니다.

1. Redis 캐시: 사용자 50명 + Spring p95 > 500ms
2. PostgreSQL 읽기 복제본: 사용자 500명 + 읽기 부하
3. 로드밸런서 + 다중 prod-app: 사용자 500명 + Spring CPU > 70%
4. 지역 분산 백업(cross-region): paying user 등장
5. OpenTelemetry 분산 추적: 사용자 50명
6. DR 드릴: paying user 등장
7. Secret 회전(Vault): 사용자 100명
8. 비동기 큐(Kafka / RabbitMQ): 사용자 500명
9. WAF Pro: 봇 트래픽 발견

---

## 마무리

Balruno는 발명이라기보다 조합으로 풀린 프로젝트였습니다. Baserow의 셀 이벤트 + Linear의 트리 op log + Outline의 문서 본문 yjs / Hocuspocus + Notion의 PostgreSQL JSONB block 모델 + Spring Security 7의 OAuth 2.1 default + OCI Always Free + Cloudflare R2, 각각이 5년 이상 검증된 OSS 다수파였고, 1인 OSS의 안전한 길은 *각 도메인 표준을 존중하면서, 도메인 차이가 드러나는 한 점에서만 분기*하는 것이었습니다.

그 한 점이 시트가 Baserow 계열이라는 인식이었고, 이 분기 위에서 로컬 모드 정리와 시트 도메인의 서버 진실원 전환, 3영역 통합 동기화, 무중단 배포, 셀프 호스트 인프라가 차례로 풀렸습니다. 위 표를 합치면 연 약 $5,460을 피한 셈이고, 거기에 데이터 통제권과 운영 자동화 경험이 같이 따라왔습니다. 모든 결정은 70여 개의 결정 문서로 추적할 수 있게 남겨뒀습니다.

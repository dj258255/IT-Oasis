---
title: 'Balruno MVP 후기'
titleEn: 'Balruno MVP Retrospective'
description: >-
  게임 밸런싱 스프레드시트 + 문서 워크스페이스 Balruno의 백엔드 설계와 운영을 한 글에
  정리합니다. PostgreSQL JSONB 채택(50,000 시트 환경에서 MySQL/PG/Mongo 직접 측정
  — Sheet GET p95: PG 16ms / MySQL 25ms / Mongo 45ms, Name UPDATE p95: Mongo 37ms
  / PG 40ms / MySQL 63ms. 쓰기만 보면 MongoDB가 조금 빨랐지만, 한정된 인프라 안에서
  DB를 둘로 나누지 않고 하나로 운영하는 편이 더 합리적이라고 판단해 PostgreSQL 선택),
  시트 셀 + 시트 트리 + 문서 트리 3영역 통합 동기화 알고리즘(Baserow + Linear +
  Outline 합본), OCI Always Free 4대 + Ansible 자동화 + Cloudflare R2 3-2-1
  백업으로 매니지드 대비 예상 회피 비용 연 약 $1,860, OAuth-only + 자체 발급 JWT(Auth0
  대비 연 약 $2,880), Grafana + Loki + Alloy + Prometheus + InfluxDB 셀프 호스트
  모니터링(Datadog 대비 연 약 $720), nginx blue/green 무중단 배포(첫 cutover 21초 →
  두 번째부터 0초), 시트 도메인 100% 서버 진실원 전환(약 80,000 라인 정리)까지
  포함합니다.
descriptionEn: >-
  A retrospective of Balruno — a game-balancing spreadsheet + document
  workspace built solo. Covers PostgreSQL JSONB adoption (head-to-head
  MySQL/PG/Mongo measurements at 50,000 sheets — Sheet GET p95: PG 16ms /
  MySQL 25ms / Mongo 45ms, Name UPDATE p95: Mongo 37ms / PG 40ms / MySQL
  63ms. MongoDB was slightly faster on writes, but PostgreSQL was chosen
  because the gap was small and a single database was more practical under
  constrained infrastructure), unified 3-region sync (sheet cells + sheet tree
  + doc tree) combining Baserow + Linear + Outline patterns, OCI Always Free
  4-machine self-host with Ansible ($1,860/yr saved vs managed), OAuth-only +
  self-issued JWT ($2,880/yr saved vs Auth0), self-hosted observability with
  Grafana/Loki/Alloy/Prometheus/InfluxDB ($720/yr saved vs Datadog), nginx
  blue/green zero-downtime deploy (21s first cutover, 0s thereafter), and the
  server-canonical migration that retired ~80K lines of local-mode code.
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
category: project/Balruno
coverImage: /uploads/project/Balruno/retrospective/title.png
draft: false
series: "Balruno"
---

## 프로젝트 개요

Balruno는 **게임 기획 데이터에 맞춘 협업 스프레드시트 + 문서 워크스페이스**예요. 캐릭터 스탯, 무기 수치, 레벨 곡선, 드롭 확률처럼 표에 자연스럽게 쌓이는 데이터를 그대로 다루고, 실시간 협업부터 게임 엔진 export까지 한 흐름으로 묶는 걸 목표로 만들었어요.

![Balruno](/uploads/project/Balruno/retrospective/title.png)

- **기간**: 2026.01 — 진행 중
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

처음부터 기준을 몇 가지 먼저 정해뒀어요.

- 작업 단위는 셀 1개가 아니라 **시트 전체**로 본다.
- 사용자는 미리 정해진 스키마 없이 **16종 동적 컬럼**을 고른다.
- 같은 셀이나 트리 노드를 동시에 수정해도 **데이터 손실이 없어야** 한다.
- 게임 기획에 필요한 **70여 개 함수**와 CSV / C# export까지 한 흐름으로 간다.
- 사용자 100명까지는 **단일 인스턴스**로 버티고, 시트 GET p95는 **500ms 이하**를 목표로 둔다.
- 데이터의 기준은 항상 **서버 DB**로 두고, 로컬 저장소는 반응 속도를 위한 캐시로만 쓴다.
- 매니지드는 나중 문제로 미루고, 초반에는 **무료 인프라 + 단계적 확장**만 허용한다.

### 설계 전에 분기를 미리 그어둔 곳

요구사항을 정리한 뒤에는 기술 이름보다 **어떤 구조가 가장 단순한지**를 먼저 봤어요.

- 시트와 문서를 같은 방식으로 동기화할지, 아니면 나눌지
- 시트를 정규화할지, JSON 기반으로 받을지
- 매니지드부터 갈지, 무료 인프라로 시작할지

이 세 갈래가 Balruno 전체 방향을 거의 결정했어요.

---

## 1. DB 선택 — PostgreSQL JSONB로 시트 도메인을 직접 받기

스프레드시트는 통째 조회와 부분 수정이 모두 많았고, 컬럼도 고정돼 있지 않았어요. 셀 1개당 row 1개로 정규화하면 1,000행 × 30컬럼 시트가 바로 30,000 row가 되고, 시트 GET 한 번이 JOIN과 row 조합 문제로 커질 수밖에 없었어요.

그래서 질문을 이렇게 바꿨어요.

> "어떤 DB가 더 유명한가?"가 아니라,  
> "이 도메인을 가장 단순하게 받을 수 있는 저장 방식이 무엇인가?"

후보는 정규화 모델, MySQL JSON, PostgreSQL JSONB, MongoDB였어요.  
특히 MySQL JSON은 자주 조회하는 경로마다 generated column이나 별도 인덱스를 계속 늘려야 해서, 동적 컬럼이 많은 구조에서는 운영 부담이 더 크다고 봤어요. 반면 PostgreSQL JSONB는 범용 GIN 인덱스와 `jsonb_set`으로 부분 수정 표현이 더 자연스러웠어요.

### 후보 7개를 직접 측정해봤어요

같은 CRUD API를 MySQL 8 + JSON, PostgreSQL 18 + JSONB, MongoDB 7에 각각 연결해 직접 측정했어요.  
환경은 50,000 시트, 50 VU, 5분 기준이었고, 비교 대상은 시트 통째 조회 / 내부 검색 / 부분 수정 3종이었어요.

시트 통째 GET — 단건 PK 조회 (50,000건 환경):

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

검색은 equality보다 containment 쿼리가 훨씬 많아서, 그 기준으로 비교했어요.

partial UPDATE — 인덱싱된 `name` 필드 patch (`PATCH /sheet/:id/name`, 인덱스 reindex 포함):

| DB | p50 | p95 | p99 | rps | 쿼리 / 인덱스 reindex |
|----|-----|-----|-----|-----|------------------|
| MySQL 8 + JSON | 18ms | 63ms | 95ms | 665 | `JSON_SET(data, '$.name', ?)` + 생성 컬럼 B-Tree reindex |
| PostgreSQL 18 + JSONB | 10ms | 40ms | 94ms | 743 | `jsonb_set(data, '{name}', $::jsonb)` + GIN reindex |
| **MongoDB 7** | **6ms** | **37ms** | **63ms** | **804** | `updateOne({_id}, { $set: {name} })` + path 인덱스 reindex |

여기서 본 핵심은 명확했어요.

- 읽기는 PostgreSQL이 가장 빨랐고
- 쓰기는 MongoDB가 조금 더 빨랐지만 차이는 크지 않았고
- MySQL은 두 축 모두 애매했어요.

결국 PostgreSQL을 고른 이유는 두 가지였어요.

첫째, 실제 수치에서 읽기 성능이 더 안정적으로 앞섰어요.  
둘째, 한정된 인프라에서 DB를 둘로 나누지 않고 하나로 운영하는 편이 백업, 모니터링, 마이그레이션까지 포함해 더 단순했어요.

중간에 한 번 크게 헷갈린 적도 있었어요.  
처음 측정에서는 PostgreSQL 검색이 28초까지 튀었는데, 원인을 따라가 보니 DB보다 응답 직렬화와 옵티마이저 선택이 더 큰 문제였어요. 응답 크기를 줄이고 데이터셋을 키운 뒤 다시 보니 같은 GIN 인덱스에서도 실행 계획이 바뀌었고, 검색은 16ms 수준으로 정상화됐어요. 이때 배운 건 하나였어요.

> 벤치마크 숫자만 보는 게 아니라,  
> "지금 내가 진짜 DB를 재고 있는지"부터 확인해야 한다.

### 결과 — 한 row에 3 영역 JSONB

최종 모델은 `projects` 한 row 안에 *시트 셀 + 시트 트리 + 문서 트리* 3 영역 JSONB와 각자의 버전 컬럼을 같이 두는 구조였어요.

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

3개 영역을 한 row에 둔 건 한 번의 트랜잭션으로 묶기 위해서였고, 버전 컬럼을 따로 둔 건 한 영역의 충돌이 다른 영역까지 막지 않게 하려는 목적이었어요. 문서 본문만 `documents.binary`로 따로 두고 Hocuspocus가 그대로 읽게 했어요.

결과도 명확했어요.

- 시트 GET p95 `65ms`
- `jsonb_set` patch p95 `8ms`
- GIN 적용 전후 비교 시 p95 `280ms → 65ms`

목표로 둔 시트 GET p95 `500ms 이하`는 충분히 넘겼고, 운영 구조도 단순하게 유지할 수 있었어요.

---

## 2. 실시간 동기화 — 시트는 서버 기준으로, 문서 본문은 yjs로

시트와 문서는 둘 다 실시간 공동 편집이 필요했지만, 같은 방식으로 다루는 건 오히려 더 복잡했어요.

시트는 값과 구조를 서버가 확실히 판단해야 했고, 문서 본문은 글자 단위 자동 병합이 더 자연스러웠어요. 그래서 시트는 서버 기준 구조로, 문서 본문만 Hocuspocus + yjs로 남겼어요.

이 판단 덕분에 복잡했던 로컬 중심 흐름도 같이 정리할 수 있었어요. `lib/ydoc.ts` 주변 레거시 코드, 패널, 훅, store, 미사용 export를 걷어내며 시트 영역 약 `80,000라인`을 삭제했고, 시트 도메인은 `100% 서버 기준 구조`로 바뀌었어요.

### WebSocket 하나로 3 영역을 묶기

처음에는 시트마다 WebSocket을 따로 열었는데, 한 사용자가 여러 시트를 동시에 보면 연결 수가 그대로 늘어나는 구조였어요. 그래서 `/ws/projects/{projectId}` 단일 엔드포인트로 바꾸고, 시트 셀·시트 트리·문서 트리를 같은 연결에서 처리하도록 합쳤어요.

메시지마다 꼭 넣은 값은 두 개였어요.

- 내가 보고 있던 **현재 버전**
- 이 요청을 구분하는 **클라이언트 메시지 ID**

이 두 값이 있어야 늦게 도착한 변경을 거절하고, 재연결 뒤 같은 요청이 다시 와도 한 번만 처리할 수 있었어요.

### 서버 트랜잭션 흐름

서버는 한 메시지를 받으면 같은 트랜잭션 안에서 아래 순서로 처리했어요.

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

핵심은 단순했어요.  
서버는 "내가 수정한 기준 버전이 아직 최신인지"를 먼저 보고, 아니면 충돌로 돌려보냈어요. 그리고 같은 요청이 다시 와도 두 번 반영되지 않도록 메시지 ID를 따로 기억했어요.

이 구조를 고른 이유도 분명했어요. 이 문제는 좋아요 카운터처럼 숫자 하나만 올리는 문제가 아니라, 시트 안의 특정 위치를 부분 수정하는 문제였어요. 그래서 Redis INCR이나 큐보다, **버전 비교 + 부분 수정 + 중복 방지** 조합이 이 도메인에 더 잘 맞았어요.

### cycle 방지 — 애플리케이션 BFS

`tree.move`에서 자기 자손 밑으로 이동시키려는 시도는 무한 루프와 데이터 손상의 원인이라 트랜잭션 안에서 차단해야 해요. PostgreSQL 재귀 CTE로도 가능하지만, JSONB 트리 walk는 SQL 트리(부모-자식 row 분리)와 구조가 달라서 애플리케이션 레벨 BFS가 단순했어요.

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

자기 자손이 새 부모 노드 안에 들어 있으면 즉시 400 `CYCLE_DETECTED`를 던지고 트랜잭션 자체를 롤백해서 patch가 발생하지 않게 했어요.

### cascade delete — 애플리케이션 재귀

문서 트리에서 노드를 지우면 흐름은 이렇게 돼요.

1. `doc_tree` JSONB에서 해당 노드의 자손을 BFS로 모음.
2. 같은 트랜잭션 안에서 `doc_tree`에서 노드 + 자손 제거 + `documents` 테이블의 해당 문서 row들에 `deleted_at = NOW()`(soft delete).
3. 자손 정보를 포함한 broadcast로 클라들이 자기 트리에서 한 번에 정리.

문서 본문 yjs binary의 영구 삭제는 별도 cron이 30일 후에 hard delete하는 구조라, 사용자 실수에 의한 삭제는 30일 안에 복구가 가능해요.

### 충돌 정책을 한 표로

3영역에서 어떤 충돌을 어떻게 처리할지 표로 고정해둔 것도 회귀 방지에 도움이 됐어요.

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

충돌, 중복 방지, cycle, cascade는 단위·통합 테스트로 검증했어요. 반면 충돌 빈도나 broadcast 지연 같은 운영 지표는 실제 사용자가 붙은 뒤에 채우는 게 더 의미 있다고 판단했어요.

### 문서 본문은 yjs(Hocuspocus)로 따로

문서 본문은 *Tiptap + yjs CRDT 자동 머지*가 도메인에 정확히 맞아서 그대로 두고, Hocuspocus를 Node 22 LTS sidecar로 운영하면서 PostgreSQL 어댑터로 `documents.binary` BYTEA에 영속시켰어요. Hocuspocus의 `onAuthenticate` 훅에서 Spring이 발급한 협업용 단명 토큰(15분)을 검증하는 webhook을 호출해서, Spring과 Hocuspocus가 같은 사용자 신원을 공유하도록 묶었어요.

---

## 3. 인프라 — OCI 4대 + Ansible + Cloudflare + 셀프 호스트 모니터링

### 매니지드 통합을 거부한 이유 — paying user 0 시점의 진짜 비용

베타 출시 시점에 매니지드 통합으로 갔다면 가설 비용은 다음과 같았어요.

| 항목 | 월 |
|------|----|
| Vercel Pro | $20 |
| Fly.io backend | $5 |
| Aurora MySQL(가벼운 인스턴스) | ~$50 |
| MongoDB Atlas(M10) | ~$25 |
| Datadog Pro($15/host × 4) | $60 |
| **합계** | **~$155/월(연 약 $1,860)** |

paying user가 없는 단계에서 매달 이 비용을 먼저 쓰는 건 맞지 않았어요. 그래서 처음부터 매니지드로 가지 않고, OCI Always Free 4대 + Cloudflare 무료 기능을 바탕으로 직접 운영하기로 했어요.

### 머신 4대 역할 분배

| Hostname | 사양 | 역할 | 메모리 |
|----------|------|------|-------|
| **prod-app** | ARM 12GB | Spring(Docker) + Nginx + Hocuspocus | ~3GB |
| **monitor** | ARM 12GB | PostgreSQL 18 + Grafana + Loki + Alloy + Prometheus + Alertmanager + InfluxDB + blackbox_exporter | ~5GB |
| **backup** | x86 1GB | pg_dump rsync 수신 + cloudflared(monitor 도메인 Tunnel) + node_exporter | ~480MB |
| **status** | x86 1GB | Cloudflare R2 업로드 daemon + node_exporter | ~150MB |

1GB 머신에는 모니터링을 올리지 않았어요. Loki, Prometheus, Grafana를 쪼개서 올리기엔 메모리가 너무 작았고, 그보다 12GB ARM 한 대에 묶는 편이 훨씬 안전했어요. 1GB 머신은 업로드 데몬이나 cloudflared처럼 역할이 단순한 프로세스만 맡겼어요.

### Ansible로 자동화

서버 셋업은 수동 대신 Ansible로 묶었어요. `ansible-playbook -i inventory.yml site.yml` 한 번이면 4대를 통째로 재현할 수 있게 만들었고, GitHub Actions로 배포 흐름까지 연결했어요.

### 3-2-1 백업 체인

원칙은 *Primary 1개 + 다른 미디어 1개 + 오프사이트 1개*였어요. 처음부터 큰 인프라를 박지 않고 단계적으로 가는 매트릭스를 그렸어요.

| 시기 | Primary | Secondary | Offsite |
|------|---------|-----------|---------|
| **베타 출시 시점** | monitor의 PG 18 | backup 머신 rsync | **Cloudflare R2**(다른 클라우드, S3 호환) |
| paying user 등장 시 | + 다른 리전(도쿄 / 프랑크푸르트) | | |
| 사용자 1,000명 이상 | + 추가 vendor(AWS S3 / Backblaze B2) | | |

처음에는 OCI Object Storage도 봤지만, 같은 벤더 안에서 한 번 더 복제하는 것보다 다른 벤더로 하나 더 빼는 편이 낫다고 봤어요. 그래서 R2로 바꿨고, `pg_dump → rsync → R2 업로드` 흐름을 실제로 검증했어요.

### 모니터링 — Datadog 거부 + 직접 측정 인프라

Datadog Pro $15/host × 4대 = 월 $60 / 연 $720 비용이 *호스트 4대 무료* 정책과 정면으로 충돌했어요. 셀프 호스트로 가되 *단일 화면(single pane of glass)*을 유지하기 위해 Grafana 진영을 통째로 채택했어요.

| 도구 | 역할 | 후보 비교 후 채택 사유 |
|------|------|------------------------|
| **Prometheus** | 운영 메트릭 TSDB | Spring Actuator native + Spring 진영에서 가장 널리 쓰이는 옵션 |
| **Loki** | 로그 aggregator | 약 512MB, Elasticsearch ~2GB 대비 부담 ↓ |
| **Alloy** | 로그 수집기 | Promtail은 [2025-02 LTS 전환 + 2026-03 EOL 발표](https://grafana.com/blog/2025/02/13/grafana-loki-3.4-standardized-storage-config-sizing-guidance-and-promtail-merging-into-alloy/), 신규는 Alloy로 시작이 정석 |
| **InfluxDB 2.x** | k6 부하 결과 TSDB(분리) | 부하 결과의 high-cardinality 시계열이 운영 Prometheus 오염 방지 |
| **blackbox_exporter** | 내부 HTTP/TLS/TCP probe + 알람 | Uptime Kuma의 대안으로 자기 자신을 명시(redundant) |
| **Grafana** | 단일 대시보드 | 4 데이터소스 한 화면 |

운영 메트릭과 k6 결과를 같은 TSDB에 넣지 않은 것도 의도였어요. 부하 테스트 결과는 시계열 수가 너무 많아서 운영 Prometheus를 오염시키기 쉬웠고, 그래서 InfluxDB에 따로 떼어 저장했어요. 대신 Grafana 한 화면에서 둘을 같이 볼 수 있게 맞췄어요.

이 환경이 깔리고 나서야 실제로 믿을 만한 수치가 나오기 시작했어요.

**가상 스레드 적용 전후**(셀 업데이트 100 동시 부하 시나리오에서 함께 본 서버 요청 지연):

| 메트릭 | 가상 스레드 OFF | 가상 스레드 ON |
|--------|----------------|----------------|
| 서버 요청 p95 | 320ms | **180ms** |
| 서버 요청 p99 | 450ms | **240ms** |
| 플랫폼 스레드 수(관측) | 약 200 | carrier 약 8 |
| heap 사용 | 380MB | **220MB** |

여기서 본 건 "가상 스레드가 코드를 더 빨리 실행하느냐"가 아니었어요. 같은 부하가 들어왔을 때, 요청이 덜 밀리고 메모리를 덜 쓰는지를 본 거였어요. 이 표의 p95 / p99는 WebSocket 메시지 왕복 시간이 아니라, 같은 시나리오에서 함께 본 서버 요청 지연이에요.

**시트 GET p95**(`projects.data` JSONB 1만 건):

| 시나리오 | p50 | p95 | p99 |
|---------|-----|-----|-----|
| GIN 인덱스 없음 | 45ms | 280ms | 410ms |
| GIN 인덱스 적용 | 12ms | **65ms** | 110ms |

이 수치들이 의미 있는 이유는, "도입했다"에서 끝나지 않고 실제로 어떤 변화가 있었는지 같이 보여주기 때문이에요. 그리고 Uptime Kuma를 넣었다가 blackbox_exporter로 정리한 것처럼, 측정 뒤에 더 단순한 쪽으로 다시 줄여 가는 과정도 같이 남겼어요.

### 무중단 배포 — nginx blue/green + readiness probe

기존 `docker compose pull && up -d` 방식은 배포할 때마다 30~60초 정도 502가 떨어졌어요. 사용자 붙기 전에 이 문제는 먼저 없애두고 싶었어요.

대안 비교:

| 후보 | 거부 사유 |
|------|-----------|
| Kamal | Kamal-proxy가 nginx 자리를 차지 → Cloudflare Origin Cert 이전 + Ansible 일부 폐기 필요. nginx 직접 방식 대비 도입 시간 비용이 큼 |
| Kubernetes | 우리 단계에서는 etcd / control plane / 네트워크 플러그인 운영 부담이 zero-downtime 이익보다 컸음. 사용자 규모가 커지면 다시 평가 |
| 두 컨테이너 항상 공존 + weight 분산 | RAM 상시 +2.5GB. 무료 인프라에서 비상 자산을 유지하는 게 우선. 카나리는 사용자 1,000명+ 시점 별도 검토 |

결국 기존 nginx와 Ansible 자산을 그대로 살릴 수 있는 blue/green 구성을 직접 만들었어요.

```
backend-blue     → 127.0.0.1:8080
backend-green    → 127.0.0.1:8081
hocuspocus-blue  → 127.0.0.1:1234
hocuspocus-green → 127.0.0.1:1235
```

snippet 두 개(`upstream-blue.conf`, `upstream-green.conf`)를 `/etc/nginx/snippets/`에 두고, `/etc/nginx/conf.d/balruno-backend-active.conf`를 둘 중 하나의 symlink로 노출하는 구조예요. cutover는 `ln -sfn`으로 symlink를 갈아 끼우고 `nginx -s reload`(graceful — 인플라이트 요청이 끝날 때까지 옛 worker가 살아있어요)를 호출해요. 디버깅은 `readlink` 한 줄로 현재 active 색깔을 볼 수 있어요.

핵심은 readiness였어요. 프로세스가 살아 있는지만 보는 게 아니라, **정말 트래픽을 받을 준비가 끝났을 때만** 넘기게 만들고 싶었거든요.

DB 마이그레이션은 expand-contract 강제: NOT NULL 컬럼 추가 시 nullable + default로 추가(구버전이 안 깨짐) → 신버전 코드가 새 컬럼 사용 → 다음 배포에서 NOT NULL 강제. 컬럼 drop이나 타입 변경 같은 파괴적 변경은 별도 슬롯(in-place 다운타임 허용)으로 분리하고, PR에 `[destructive]` 태그를 붙이도록 했어요.

실측(2026-05-10):

```
첫 cutover (옛 단일 컨테이너 → 새 dual slot 이행)
05:33:30  api.balruno.com=502      ← 다운타임 시작
05:33:51  api.balruno.com=200      ← 회복 (≤ 21초)

두 번째 cutover (workflow_dispatch normal mode, green active → blue)
05:38:45 ~ 05:39:41  모든 폴링 200      ← 다운타임 0초
```

첫 전환의 21초는 예전 구조에서 새 구조로 넘어가는 일회성 비용이었고, 두 번째부터는 실제 운영에서도 502 없이 넘어갔어요.

---

## 4. 인증 — OAuth-only + 자체 발급 JWT(HS256, 미래에 RS256 예약)

### 자체 비밀번호의 진짜 비용

비밀번호 로그인까지 직접 들고 가면, 비밀번호 정책·해싱·재설정 메일·누출 대응·2FA까지 같이 책임져야 해요. 1인 운영 단계에서는 이 책임이 너무 컸어요.  
매니지드 인증도 비용이 부담됐어요. Auth0는 시작가부터 높고, Clerk나 Cognito도 결국 외부 의존과 비용이 남아요.

### OAuth-only 채택 — 페르소나에 맞는 길

Balruno 사용자는 대부분 GitHub나 Google 계정을 이미 갖고 있었어요. 그래서 OAuth-only가 가장 단순했고, 비밀번호·2FA·누출 대응은 provider가 맡고 우리는 인증 결과만 받는 구조로 가져갔어요.

후보 비교:

| 후보 | 비밀번호 | SMTP | 누출 책임 | 매니지드 비용 |
|------|---------|------|-----------|---------------|
| 자체 ID + bcrypt + SMTP | 있음 | 필수 | 직접 | $0(셀프, 운영 비용 ↑) |
| Magic link | 없음 | **필수** | 직접 | SMTP 비용 |
| WebAuthn(passkey) | 없음 | 0 | 분산 | $0(2026 인지도 낮음) |
| **OAuth-only(GitHub + Google)** | 없음 | **0** | provider | **$0** |
| 매니지드(Auth0 / Clerk) | – | – | provider | $25~240/월 |

### JWT 알고리즘은 *verifier 수*가 결정해요

| 알고리즘 | 키 | sign | verify | 다중 verifier | 채택 시점 |
|----------|-----|------|--------|--------------|-----------|
| **HS256** | symmetric 32B | ~1µs | ~1µs | 비밀 공유 위험 ↑ | **현재 ★** |
| HS512 | symmetric 64B | ~1µs | ~1µs | 동일 | – |
| **RS256** | private + public | ~50µs | ~5µs | **JWKS 엔드포인트 OK** | 별도 운영팀·외부 verifier 시점 예약 |
| ES256 | private + public(작음) | ~10µs | ~30µs | JWKS OK | RS256의 modern 대안 |
| EdDSA(Ed25519) | private + public(가장 작음) | ~5µs | ~15µs | JWKS OK | 미래 표준 후보 |

처음에는 *검증 주체가 Spring 하나* 라고 봐서 HS256으로 갔는데, 실제로는 Hocuspocus(`packages/collab`)가 별도 Node.js 프로세스로 collab 토큰을 검증하고 있어서 사실 *verifier가 둘* 이었어요. 이 구조라면 HS256의 비밀 공유 위험이 명목상 도착한 셈이라 RS256으로 옮기는 걸 검토했어요.

그런데 동종 OSS의 코드를 직접 까봤어요. Baserow의 `SIMPLE_JWT`는 algorithm 명시 없이 default HS256, Outline의 `User.ts`는 `type: "collaboration"` 토큰까지 `user.jwtSecret` 하나로 HS256 sign(우리 collab 시나리오와 정확히 동일), Hocuspocus playground도 `jsonwebtoken.sign(payload, secret)` algorithm 미명시, Supabase Auth의 `GetSigningAlg()` fallback도 `jwt.SigningMethodHS256`. *알고리즘은 동종 OSS들이 README에 자랑하지 않을 만큼 implementation detail* 이었고, 가장 흔한 default가 HS256이었어요.

같은 vault·같은 운영자·같은 host인 우리 환경에서 RS256의 *발급/검증 권한 분리* 효과는 명목상이고, 1인 운영 부담만 늘어나요. 그래서 HS256 유지로 결정했어요. RS256 transition trigger는 *별도 운영팀·별도 vault·외부 verifier(mobile SDK나 third-party 같은)* 가 들어오는 시점으로 재정의했어요.

### JWT 보관 — cookie + Bearer 듀얼

| 위치 | XSS | CSRF | API 클라이언트 호환 | 채택 |
|------|-----|------|---------------------|------|
| localStorage | **취약** | 없음 | OK | 거부 |
| **httpOnly cookie**(`Domain=balruno.com`, `SameSite=Lax`) | **0** | 약함(Lax) | X | **★ 브라우저** |
| **Authorization Bearer header** | 0(메모리) | 0 | **OK** | **★ Electron / API 클라이언트** |

브라우저와 데스크톱 클라이언트를 같이 지원해야 해서, cookie와 Bearer를 둘 다 받는 구조로 갔어요.

### 같은 이메일이면 무조건 link하면 안 돼요

OAuth provider의 `verified email`을 어떻게 처리하느냐가 보안 경계를 만들어요. 4가지 케이스로 분기를 명시했어요(Notion / Linear / Vercel과 같은 패턴이에요).

```java
sealed interface Decision {
    record ReuseExistingLink(UUID userId, UUID linkId)
    record LinkToExistingUser(UUID userId)
    record CreateNewUser()
    record RejectUnverifiedEmail(String email)
}
```

규칙:
1. (provider, providerUserId)가 이미 link되어 있으면 → ReuseExistingLink (재로그인).
2. provider가 verified email을 안 줬는데 같은 email user가 이미 존재하면 → **RejectUnverifiedEmail** (계정 takeover 차단).
3. 양쪽이 verified email이고 일치하면 → LinkToExistingUser (자동 link + audit log).
4. 그 외에는 → CreateNewUser.

규칙 2가 핵심 보안 경계예요. 공격자가 victim의 email로 GitHub에 가입(GitHub가 verified를 안 한 상태) → 우리 OAuth 받기 → email만 보고 link → victim 계정 takeover 시나리오를 막아야 해요. 그래서 GitHub `/user/emails`는 `primary == verified == true`인 row만 추출하고, Google OIDC는 `email_verified` claim을 그대로 사용해요. 양쪽 다 verified=true일 때만 자동 link해요.

### Refresh token — DB rotation chain

| 후보 | revoke 가능 | 추가 인프라 | 채택 |
|------|------------|------------|------|
| **DB rotation chain**(BYTEA 해시 + prev_id) | **OK** | 0 | **★** |
| Redis | OK + 빠름 | Redis 추가 | 사용자 늘면 트리거 |
| Stateless(rotation only) | **X** | 0 | 거부 |

결과적으로 인증은 사용자 입장에서는 더 단순했고, 운영 입장에서는 비용과 의존성을 함께 줄일 수 있었어요.

---

## 5. Notion 클론에서 *게임 스튜디오 워크스페이스*로 분리되는 부가 기능들

핵심 동기화 + 인증 + 인프라 위에 얹은 기능들이 *Notion 클론*과 *진짜 게임 스튜디오 워크스페이스*의 분기를 만들어요.

| 기능 | 핵심 |
|------|------|
| **서버 백드 영구 undo** | Cmd+Z가 새로고침 후에도 120분 안에 작동(Baserow의 `MINUTES_UNTIL_ACTION_CLEANED_UP` 패턴), 탭 단위 격리, 30초/20-op 액션 그룹. *Diff baseline picker*도 같은 멱등 로그의 inverse_payload를 거꾸로 replay해서 동작 — 별도 snapshot 인프라가 필요 없었어요 |
| **10가지 뷰 타입** | Grid · Form · Kanban · Calendar · Gallery · Gantt · **Heatmap · Curve · Probability · Diff** — 마지막 4개가 게임 밸런싱 도메인 특화(Notion / Airtable / Baserow에 없음). 모든 뷰 전환과 drag-drop이 서버 진실원 동기화 위에서 실시간 멀티플레이어 |
| **코멘트 + @멘션 + 알림** | 시트 셀과 문서 본문에서 *범위 핀 하이라이트*(Tiptap Decoration plugin), 1단계 답글 스레드(Slack/Linear 패턴), 이메일 + Web Push(VAPID, RFC 8030/8292), 일/주간 다이제스트 |
| **공유 링크** | `/share/:token`에 인증 없는 read-only viewer. UUIDv7 PK + UUIDv4 token, 시트/뷰/만료를 핀할 수 있고 즉시 revoke |
| **Outbound 웹훅** | `comment.added` / `mention.created` / `row.added` 이벤트의 HMAC-SHA256 POST. 발행자(publisher) 모듈이 웹훅 모듈을 정적으로 의존하지 않도록 ApplicationEvent로 디커플링 |
| **Inbound 웹훅(GitHub / generic)** | HMAC 서명 검증 후 PR/issue 이벤트가 자동으로 row 추가. 시트의 "받기" 버튼으로 URL + secret 발급 |
| **Discord 슬래시 커맨드** | Ed25519 검증 인터랙션 엔드포인트. `/balruno bug <text>`가 워크스페이스 기본 시트에 row 추가 |
| **Stripe 결제** | Checkout + Customer Portal + 서명 검증 webhook, 글로벌 + 한국 카드 |
| **프로젝트 전체 검색** | 셀 + 트리 + 코멘트 본문, Cmd+K + 200ms debounce |
| **워크스페이스 감사 로그** | `workspace_audit_log` 테이블 + ApplicationEvent. 활동 피드의 backing store |
| **게임 엔진 export** | CSV(RFC 4180 + BOM) + C# `[Serializable]` struct + readonly 배열. Unity 프로젝트에 그대로 드롭 |
| **Cmd+K + GDPR + PWA** | 빠른 점프, 데이터 export + 계정 삭제 자체 서비스, "홈 화면에 추가" |

이 표 안에서 가장 만족스러웠던 두 가지를 짚자면, outbound 웹훅을 *ApplicationEvent로 디커플링*해 둔 부분과 *Diff baseline picker가 별도 snapshot 인프라 없이 inverse_payload의 backward replay만으로 동작*한다는 점이에요. 전자는 웹훅 모듈이 발행자 모듈을 정적으로 의존하기 시작하면 Spring Modulith 모듈 경계 테스트가 깨지는데, ApplicationEvent를 한 단계 끼워 넣으면 listener가 공급자 모듈을 전혀 몰라도 동작해서 경계가 그대로 유지돼요. 후자는 같은 자료(멱등 로그)를 *undo*와 *Diff* 두 기능이 동시에 재사용하는 합리화로, 새로 짤 인프라가 한 줄도 없이 기능 하나가 더 추가된 셈이 됐어요.

---

## 6. 실패와 교훈

### 1. 5종의 silent failure — `catch (RuntimeException)` 함정

초기 인증 작업하면서 다섯 번 silent failure를 만났어요.

| 함정 | 증상 | 원인 |
|------|------|------|
| Spring Boot 4 자동설정 모듈 분리 | 배포 성공 / health 200 / `flyway_schema_history` 테이블 부재 | `flyway-core`만 있고 `spring-boot-starter-flyway`가 빠져서 자동설정이 발동 안 함 |
| 결정 문서 vs 런타임 함수명 불일치 | `IllegalArgumentException ... function gen_random_uuidv7() does not exist` | 결정 문서 작성 시점이 PostgreSQL 18 RC 단계였고, GA의 실제 이름은 `uuidv7()` |
| Tomcat 11의 RFC 6265 strict cookie | OAuth 로그인 후 catch-all `error=login_failed`로 빠짐 | `Cookie.setDomain(".balruno.com")`의 leading dot을 [Tomcat 11의 `Rfc6265CookieProcessor`가 reject](https://docs.spring.io/spring-framework/issues/23776) |
| Hibernate `@UuidGenerator(style=TIME)` | 운영 row의 UUID 16진수에서 버전 자리가 `1`(UUIDv1) | [`Style.TIME`의 내부 구현이 RFC 4122 v1 시절 명명 그대로](https://thorben-janssen.com/generate-uuids-primary-keys-hibernate/). PostgreSQL의 `DEFAULT uuidv7()`이 fire되지 않음 |
| docker-compose `env_file` 권한 | `open /opt/balruno/backend/.env: permission denied` | Ansible이 `0600 root:root`로 렌더 → SSH 사용자 `rocky`(non-root)로 docker compose CLI 실행. *데몬은 root지만 CLI는 사용자 권한* |

**교훈**: catch-all로 `RuntimeException`을 swallow한 게 함정 3 발견을 *2시간 지연*시켰어요. logger 한 줄을 추가하고 다음 시도에서 즉시 root cause를 잡았고, *모든 catch에 stack trace 로깅이 self-host SaaS의 baseline*이라는 결론이 됐어요. 그 다음이 *실제 fix*. 순서를 거꾸로 하면 fix 시도 자체가 가설 사격이 돼서 비용이 폭발해요.

### 2. abstraction의 underlying을 한 번씩 직접 보자

함정 1, 4, 5는 모두 *abstraction이 underlying behavior를 가린* 패턴이었어요. autoconfig 모듈 분리, annotation 이름, docker compose 단어 — 모두 abstraction 계층에서는 동작이 안 보이는 함정이에요. 새 stack 도입 시점에 자동설정 imports 파일 한 번 읽기, 운영 row의 16진수 한 번 보기, 파일 권한 한 번 `ls` — 5분 투자로 silent failure 0이 돼요.

### 3. 결정 문서 → 검증 → 정정 사이클

`gen_random_uuidv7()`는 결정 문서 작성 시점에 정직한 추측이었어요(`gen_random_uuid()` v4 패턴을 따라 짐). 운영 첫 배포 후 `\df *uuid*` 한 번이면 즉시 발견됐을 텐데, *결정 문서가 spec source라 spec만 보고 검증을 안 한 게* 원인이었어요. 모든 결정이 운영과 한 번은 cross-check되어야 하고, *결정을 바꾸는 행위 자체*가 spec-driven 개발의 정석이라는 게 교훈이었어요.

### 4. 외부 health probe 도구 교체 — 측정 후 단순화

처음에는 status 머신에 Uptime Kuma를 채택했어요(UptimeRobot 무료 플랜의 상업적 이용 제한 우회 목적). 며칠 뒤 *blackbox_exporter(Prometheus 진영)가 같은 책임을 native로 수행한다*는 걸 발견하고 drop했어요. Grafana 스택이 이미 깔리는데 Uptime Kuma는 redundant였어요. 외부 vantage가 진짜 필요한 영역(monitor 자체가 죽었을 때)은 Cloudflare Workers cron 한 줄로 분리했어요. *결정을 바꾸는 행위 자체*가 시그널 — 처음부터 정답일 필요는 없고, 측정 후 단순화한 흔적이 더 강한 신호라고 봤어요.

### 5. 약 80,000 라인의 로컬 모드 코드 정리

시트와 문서를 같은 방식으로 다루지 않고, 시트는 서버 기준 구조로 정리한 게 큰 전환점이었어요. 단계별 정리로 *시트 영역 약 80,000 라인의 로컬 모드 코드*를 들어내고 시트 도메인을 100% 서버 진실원으로 옮겼어요. *기능을 추가한 commit*보다 *기능을 정리한 commit*이 prod CI green을 유지한 사실이 더 강한 신호예요.

---

## 최종 아키텍처 + 핵심 수치

### 인프라 + 비용

| 항목 | 매니지드 가설 | OCI 셀프 실측 | 예상 회피 비용(avoided cost) |
|------|----------------|----------------|------|
| 인프라 통합(Vercel + Fly.io + Aurora + Atlas + Datadog) | $155/월 | **$0/월** | **연 약 $1,860** |
| 인증(Auth0 Pro) | $240/월 | $0(OAuth + 자체 발급 JWT) | **연 약 $2,880** |
| 인증(Clerk Pro + 100 MAU) | $27/월 | $0 | 연 약 $324 |
| 모니터링(Datadog Pro 4 host) | $60/월 | $0(Grafana 셀프) | **연 약 $720** |

> 매니지드를 실제로 결제했다가 멈춘 게 아니라 *처음부터 매니지드를 골랐다면 들었을 비용*이라서 "절감"보다 *avoided cost* 표현이 정확해요.

### DB

| 항목 | 결과 | 측정 조건 |
|------|------|-----------|
| 시트 GET p95(50,000건) | **PG 16ms / MySQL 25ms / Mongo 45ms** | k6 50 가상 사용자 × 5분, OCI ARM 12GB |
| Name UPDATE p95 | **Mongo 37ms / PG 40ms / MySQL 63ms** | 같은 조건 |
| GIN 인덱스 효과 | p95 **280ms → 65ms (4.3배)** | 인덱스 ON/OFF 직접 비교 |
| `jsonb_set` patch p95 | **8ms** | 트랜잭션 단위 측정 |

### 가상 스레드 + JVM

| 메트릭 | 가상 스레드 OFF | 가상 스레드 ON | 변화 |
|--------|----------------|----------------|------|
| 서버 요청 p95 | 320ms | **180ms** | -44% |
| 서버 요청 p99 | 450ms | **240ms** | -47% |
| heap | 380MB | **220MB** | -42% |
| 플랫폼 스레드 수(관측) | 약 200 | carrier 약 8 | – |

> 이 표는 WebSocket 메시지 왕복 시간이라기보다, 같은 셀 업데이트 부하 시나리오에서 함께 본 서버 요청 지연과 JVM 상태를 정리한 거예요.

### 동기화

| 항목 | 결과 |
|------|------|
| WebSocket 엔드포인트 | `/ws/projects/{projectId}` 단일 통합(시트 셀 + 시트 트리 + 문서 트리 3 영역) |
| 충돌 감지 | 서버가 현재 버전을 보고, 늦게 도착한 변경은 거절 + 클라 rollback |
| 재전송 중복 방지 | 클라이언트 메시지 ID를 기억해 같은 요청이 다시 와도 한 번만 반영 |
| cycle 방지 | 애플리케이션 BFS, 400 CYCLE_DETECTED |
| cascade delete | 애플리케이션 재귀 + `documents.deleted_at`(30일 hard delete cron) |
| 문서 본문 | yjs 기반 자동 머지(Hocuspocus Node sidecar + `documents.binary` BYTEA) |

### 무중단 배포

| 항목 | 결과 |
|------|------|
| 옛 in-place 패턴 | 매 배포 30~60초 502 윈도 |
| nginx blue/green 첫 cutover | **≤21초**(옛 단일 → 새 dual slot 일회성 이행) |
| nginx blue/green 두 번째 cutover부터 | **0초**(prod 실측, 10초 폴링 정확도 안에서 502 윈도 없음) |
| nginx `backup` directive 자동 fail-over | 명시적 swap 없이도 부분 무중단 보너스 |
| 마이그레이션 정책 | expand-contract 강제, 파괴적 변경은 `[destructive]` 태그 + 별도 슬롯 |

### 코드 베이스

| 항목 | 결과 |
|------|------|
| 시트 도메인 yjs 의존성 | 0(서버 진실원 100%) |
| 로컬 모드 정리 | 약 -80,000 라인 |
| Spring Modulith 모듈 경계 테스트 | green |

### 사용자/부하 트리거 후에 추가할 것들

이 9개 영역은 처음부터 박지 않고, 트리거가 떨어지면 그때 단계적으로만 도입하기로 미리 그어뒀어요.

1. Redis 캐시 — 사용자 50명 + Spring p95 > 500ms
2. PostgreSQL 읽기 복제본 — 사용자 500명 + 읽기 부하
3. 로드밸런서 + 다중 prod-app — 사용자 500명 + Spring CPU > 70%
4. 지역 분산 백업(cross-region) — paying user 등장
5. OpenTelemetry 분산 추적 — 사용자 50명
6. DR 드릴 — paying user 등장
7. Secret 회전(Vault) — 사용자 100명
8. 비동기 큐(Kafka / RabbitMQ) — 사용자 500명
9. WAF Pro — 봇 트래픽 발견

---

## 마무리

Balruno는 *발명*이 아니라 *조합*으로 풀린 프로젝트였어요. Baserow의 셀 이벤트 + Linear의 트리 op log + Outline의 문서 본문 yjs / Hocuspocus + Notion의 PostgreSQL JSONB block 모델 + Spring Security 7의 OAuth 2.1 default + OCI Always Free + Cloudflare R2 — 각각이 5년 이상 검증된 OSS 다수파였고, 1인 OSS의 안전한 길은 *각 도메인 표준을 존중하면서, 도메인 차이가 드러나는 한 점에서만 분기*하는 것이었어요.

그 한 점이 *시트가 Baserow 계열이다*라는 인식이었고, 이 분기 위에서 약 80,000 라인 로컬 모드 정리, 시트 도메인 100% 서버 진실원 전환, 3 영역 통합 동기화, 무중단 배포, 셀프 호스트 인프라가 차례로 풀렸어요. paying user 0 시점 기준으로 매니지드 통합을 골랐다면 들었을 *예상 회피 비용* 이 연 약 $5,460(인프라 약 $1,860 + 인증 약 $2,880 + 모니터링 약 $720), 거기에 데이터 통제권과 운영 자동화 경험이 같이 따라왔어요. 모든 결정은 70여 개의 결정 문서로 추적할 수 있게 남겨뒀어요.

<!-- EN -->

## Project Overview

Balruno is an **open-source collaborative spreadsheet + document workspace specialized for game balancing**. Character stats, weapon values, level curves, drop/gacha probabilities — domains that naturally fall into a table — are taken in directly, then connected to real-time collaboration and game-engine export (C# struct, Unity project drop) in a single flow.

- **Duration**: Jan 2026 — In Progress
- **Type**: Solo open-source SaaS (client MIT, backend AGPL v3)
- **Demo**: [balruno.com](https://balruno.com)

### Data Regions

| Region | Location | Change frequency | Conflict frequency | Pattern |
|--------|----------|------------------|--------------------|---------| 
| Sheet cells | `projects.data` JSONB → `sheets[].rows[].cells[]` | Very high | Medium | cell event op log |
| Sheet tree | `projects.sheet_tree` JSONB | Medium | Low | tree op log |
| Doc tree | `projects.doc_tree` JSONB | Medium | Low | tree op log |
| Doc body | `documents.binary` BYTEA (yjs) | Very high | Auto-merge | yjs CRDT (Hocuspocus) |

### Stack

- Backend: Java 25, Spring Boot 4, Spring Security 7, Hibernate 7, Spring Modulith
- DB/Storage: PostgreSQL 18 (JSONB + GIN + native UUIDv7), Cloudflare R2 (S3-compatible offsite backup)
- Realtime: Spring WebSocket (cells + trees), Hocuspocus + yjs (doc bodies)
- Frontend: Next.js 16 + React 19, Electron 41, Tiptap, TanStack Virtual, y-indexeddb
- Infra/DevOps: OCI Always Free 4 hosts (ARM 12GB ×2 + x86 1GB ×2), Ansible, Nginx + Cloudflare (proxy + Tunnel + 15-year Origin Cert + R2)
- Observability/Test: Prometheus + Loki + Alloy + Grafana + InfluxDB + blackbox_exporter, Sentry SaaS, k6 + JUnit 5 + Testcontainers

---

## 1. DB Choice — Taking the Sheet Domain Directly with PostgreSQL JSONB

Spreadsheets in Balruno do two things all the time: full-sheet reads and small partial edits. They also carry dynamic columns, so normalising 1 cell → 1 row would have turned a 1000×30 sheet into 30,000 rows and made every sheet GET much heavier.

So the real question was not "which database is more popular?" but "which storage model takes this domain with the least friction?"

I compared a normalised model, MySQL JSON, PostgreSQL JSONB, and MongoDB. The same CRUD API was wired to MySQL 8 + JSON, PostgreSQL 18 + JSONB, and MongoDB 7, then measured under the same load: 50,000 sheets, 50 VU, 5 minutes.

| DB | Sheet GET p95 | Name UPDATE p95 |
|----|---------------|-----------------|
| MySQL 8 + JSON | 25ms | 63ms |
| **PostgreSQL 18 + JSONB** | **16ms** | 40ms |
| MongoDB 7 | 45ms | **37ms** |

The conclusion was simple:

- PostgreSQL was clearly better on reads.
- MongoDB was slightly faster on writes, but the gap was small.
- MySQL was not strong enough on either side to justify the extra operational friction of JSON indexing in this shape.

I still picked PostgreSQL. Reads mattered more in practice, and under limited infrastructure it was more reasonable to run one database well than split the system across two.

One important lesson came from a bad first benchmark. PostgreSQL search once showed 28 seconds, but the real problem turned out to be response serialization and planner choice, not the database itself. After reducing payload size and re-running the test with a larger dataset, the same GIN index switched to a better plan and search dropped to normal numbers. That was the point where I learned to verify *what I am actually measuring* before trusting the number.

The final model keeps 3 JSONB regions plus 3 version columns in the same `projects` row, while document bodies stay in `documents.binary` as yjs binary. That kept the write path transactional and let each region resolve conflicts independently.

---

## 2. Realtime Sync — Server-canonical Sheets, yjs Doc Bodies

Sheets and documents both needed realtime collaboration, but they did not want the same conflict model.

Sheets needed the server to decide whether a value or structure change was valid. Document bodies benefited more from character-level auto-merge. So I kept document bodies on Hocuspocus + yjs, and moved sheets to a server-canonical flow.

That decision also made cleanup possible. Roughly **80,000 lines** of local-mode code were removed, and the sheet domain became fully server-canonical.

All three regions now go through one WebSocket endpoint: `/ws/projects/{projectId}`. Every message carries two values:

- the version the client was looking at
- a client-side message ID

That is enough for the server to reject late writes and ignore duplicate retries after reconnect.

The write flow is straightforward:

1. lock the project row
2. compare the client's version with the current version
3. reject if it is stale
4. check whether the same message ID was already handled
5. apply the JSONB patch and bump the version
6. save the idempotency record
7. broadcast to other sessions

I chose this combination — version check + partial patch + idempotency key — because this is not a single counter problem like Redis `INCR`. It is a position-specific update problem inside a spreadsheet. For this domain, that model was simpler and more accurate than a queue or a counter-based approach.

---

## 3. Infrastructure — OCI 4 Hosts + Ansible + Cloudflare + Observability

At paying-user 0, a managed stack would have cost about **$155/mo ($1,860/yr)**. That curve did not make sense, so I built around OCI Always Free 4 hosts and free Cloudflare features instead.

The 4 hosts were split into app, monitor, backup, and status roles. I deliberately kept monitoring off the 1GB hosts because Loki, Prometheus, and Grafana were too large to run there safely. Those machines only handled simple single-purpose daemons.

Provisioning and deployment were automated with Ansible, and the backup chain followed a simple 3-2-1 layout: `pg_dump → rsync → Cloudflare R2`.

The observability stack was also self-hosted: Prometheus, Loki, Alloy, Grafana, InfluxDB, and blackbox_exporter. k6 results were kept out of Prometheus and stored in InfluxDB instead, so load-test data would not pollute operational metrics.

That setup produced the first measurements I could actually trust:

- under the 100-concurrent cell-update scenario, server-request p95 dropped from **320ms → 180ms** after enabling virtual threads
- with GIN enabled, sheet GET p95 dropped from **280ms → 65ms**

Those numbers matter because they are not just feature descriptions. They are the reason those choices stayed.

I also replaced the old in-place deploy flow, which produced a 30~60s 502 window on every release. Instead of throwing away the existing nginx setup, I built blue/green deployment on top of it. Readiness checks decided when traffic could move.

Production result:

- first cutover: **≤21s**
- every cutover after that: **0s** within the polling window

That was the point where the deploy path stopped being a guess and became something I could measure.

---

## 4. Auth — OAuth-only + Self-issued JWT (HS256, RS256 deferred)

Running passwords directly would have meant owning password policy, hashing, reset mail, leak response, and 2FA. That was too much responsibility for a solo product at this stage. Managed auth was also more expensive than it needed to be.

OAuth-only fit the product better. Most users already had GitHub or Google accounts, so the login flow stayed simple while the provider handled passwords and 2FA.

JWT design followed the number of verifiers. I first assumed Spring would be the only verifier, but Hocuspocus (`packages/collab`) is a separate Node.js process verifying collab tokens — there were already two verifiers, and HS256's shared-secret weakness had textbook trigger to switch.

I read the source of comparable OSS before migrating. Baserow's `SIMPLE_JWT` doesn't specify an algorithm (django-rest-framework-simplejwt defaults to HS256). Outline's `User.ts` signs every token kind, including `type: "collaboration"`, with a single `user.jwtSecret` and no algorithm option — the closest analogue to our collab token scenario, and they share the same secret across verifiers. The Hocuspocus playground itself calls `jsonwebtoken.sign(payload, secret)` with no algorithm. Supabase Auth's `GetSigningAlg()` fallback is `jwt.SigningMethodHS256`. The algorithm is the kind of detail none of these projects highlight in their README — and the default is consistently HS256.

In our environment (same vault, same operator, same host), RS256's issuer/verifier separation is theoretical. The migration adds key-management cost to a one-person operation for a benefit nobody comparable is paying for. HS256 stays. The trigger for revisiting gets redefined to a real boundary: a separate operations team, a separate vault, or an external verifier (a future mobile SDK or third-party integration).

Token delivery is dual: httpOnly cookie for browsers, Bearer token for desktop and API clients.

Verified email handling is strict. If a provider does not prove the email is verified, the account is not auto-linked. That is the boundary that blocks takeover through an unverified OAuth identity.

Refresh tokens use a DB rotation chain, so revoke works immediately without adding more infrastructure.

---

## 5. Feature Layer — What Separates a Notion Clone from a Game-Studio Workspace

- **Persistent server-backed undo** — Cmd+Z survives refresh within 120 min (Baserow `MINUTES_UNTIL_ACTION_CLEANED_UP`), per-tab isolation, 30s/20-op action grouping. The Diff baseline picker reuses the same idempotency log's `inverse_payload` via backward replay — no separate snapshot infra.
- **10 view types** — Grid · Form · Kanban · Calendar · Gallery · Gantt · **Heatmap · Curve · Probability · Diff**. The last 4 are game-balance specific and don't exist in Notion / Airtable / Baserow. Every view switch and drag-drop broadcasts to peers via the server-canonical sync.
- **Comments + @mentions + notifications** — sheet cells + doc body range-anchored highlights (Tiptap Decoration plugin), 1-level reply threads (Slack/Linear pattern), email + Web Push (VAPID, RFC 8030 + 8292), daily/weekly digests.
- **Webhooks** — outbound (HMAC-SHA256 POSTs decoupled via ApplicationEvent so the Spring Modulith arch test stays green), inbound GitHub PR/issues + generic.
- **Discord slash commands** — Ed25519-verified `/v1/discord/interactions`.
- **Stripe billing**, **share links**, **project-wide search** (Cmd+K + 200ms debounce), **workspace audit log**, **Unity export** (CSV RFC 4180 + BOM + C# struct), **GDPR + PWA**.

The two most satisfying decisions in this layer were the ApplicationEvent decoupling on outbound webhooks (the webhook module never statically depends on publishers, so the Modulith boundary test stays green) and the Diff baseline picker reusing the same idempotency log — one feature shipped without a single line of new infrastructure.

---

## 6. Failures and Lessons

- **Five silent failures in early auth work**: missing Flyway autoconfig, wrong `uuidv7()` function name, Tomcat 11 cookie strictness, Hibernate UUIDv1 generation, and docker-compose env file permissions. The shared lesson was simple: swallowing `RuntimeException` delayed root-cause discovery. Every catch must log the stack trace.
- **Check the layer under the abstraction once.** Several failures would have been caught earlier by reading the real imports, checking the actual UUID bits, or listing file permissions directly.
- **Decision → verify → correct.** A wrong early assumption is not the problem. Failing to check it against production once is.
- **Drop tools when they become redundant.** Uptime Kuma was replaced by blackbox_exporter because the Grafana stack already covered that role. Removing a tool after measurement is a good sign, not a bad one.
- **The 80K-line cleanup mattered.** Turning sheets into a server-canonical domain ended up being a stronger signal than adding one more feature.

---

## Closing

Balruno was not about inventing a new stack. It was about choosing where to stay conventional and where the domain really needed a different answer.

The biggest branch was this: spreadsheets in this product needed a server-canonical model, while document bodies still benefited from yjs. Once that decision was made, the rest followed more cleanly — the DB choice, the 80K-line cleanup, the unified sync path, the zero-downtime deploy, and the self-hosted infrastructure.

At paying-user 0, the avoided cost versus a managed baseline is roughly **$5,460/yr**. More importantly, the system is now simpler to explain, simpler to operate, and much easier to evolve.

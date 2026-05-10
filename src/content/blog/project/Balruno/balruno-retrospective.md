---
title: 'Balruno 총정리 — 게임 밸런싱 워크스페이스의 백엔드 설계부터 무중단 배포까지'
titleEn: 'Balruno Retrospective — From Backend Design to Zero-Downtime Deploy'
description: 게임 밸런싱 스프레드시트 + 문서 워크스페이스 Balruno의 백엔드 설계와 운영을 한 글에 정리합니다. PostgreSQL 18 JSONB 채택(MySQL JSON 240ms vs PG 65ms 직접 측정), 시트 셀 + 시트 트리 + 문서 트리 3 영역 통합 sync 알고리즘(Baserow + Linear + Outline 합본), OCI Always Free 4대 + Ansible 8 role + Cloudflare R2 3-2-1 백업으로 매니지드 대비 연 $1860 절감, OAuth-only + Spring Security 7 + nimbus JWT(Auth0 대비 연 $2880 절감), Grafana + Loki + Alloy + Prometheus + InfluxDB 셀프 호스트 모니터링(Datadog 대비 연 $720 절감), nginx blue/green 무중단 배포(첫 cutover 21s → 두 번째부터 0s), 시트 도메인 100% server-canonical 전환(local-mode 약 80K 라인 정리)까지 포함합니다.
descriptionEn: A retrospective of Balruno — a game-balancing spreadsheet + document workspace built solo. Covers PostgreSQL 18 JSONB adoption (MySQL JSON 240ms vs PG 65ms, measured directly), unified 3-region sync (sheet cells + sheet tree + doc tree) combining Baserow + Linear + Outline patterns, OCI Always Free 4-machine self-host with Ansible 8 roles ($1860/yr saved vs managed), OAuth-only + Spring Security 7 + nimbus JWT ($2880/yr saved vs Auth0), self-hosted observability with Grafana/Loki/Alloy/Prometheus/InfluxDB ($720/yr saved vs Datadog), nginx blue/green zero-downtime deploy (21s first cutover, 0s thereafter), and the server-canonical migration that retired ~80K lines of local-mode code.
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

Balruno는 **게임 밸런싱 도메인에 특화된 협업 스프레드시트 + 문서 워크스페이스**입니다. 캐릭터 스탯, 무기 수치, 레벨 곡선, 드롭/가챠 확률처럼 게임 기획 데이터가 자연스럽게 표 안에 모이는 도메인을 그대로 받아내고, 이를 실시간 협업과 게임 엔진 export(C# struct, Unity Assets/ 드롭)까지 한 흐름으로 묶는 게 목표입니다.

![Balruno](/uploads/project/Balruno/retrospective/title.png)

- **기간**: 2026.01 — 진행 중
- **형태**: 1인 오픈소스 SaaS (클라이언트 MIT, 백엔드 AGPL v3)
- **데모**: [balruno.com](https://balruno.com)

### 데이터 영역

| 영역 | 위치 | 변경 빈도 | 충돌 빈도 | 처리 패턴 |
|------|------|----------|----------|----------|
| 시트 셀 | `projects.data JSONB` 안 sheets[].rows[].cells[] | 매우 높음(분당 수십 회) | 중간 | cell event op log |
| 시트 트리 | `projects.sheet_tree JSONB` | 중간 | 낮음 | tree op log |
| 문서 트리 | `projects.doc_tree JSONB` | 중간 | 낮음 | tree op log |
| 문서 본문 | `documents.binary BYTEA`(yjs) | 매우 높음(글자 단위) | 자동 머지 | yjs CRDT(Hocuspocus) |

### 사용한 기술

- Backend: Java 25, Spring Boot 4.0.6, Spring Security 7, Hibernate 7.2, Spring Modulith 1.4
- DB/Storage: PostgreSQL 18.3(JSONB + GIN + UUIDv7 native), Cloudflare R2 (S3 호환 백업 오프사이트)
- Realtime: Spring WebSocket(시트 셀 + 트리), Hocuspocus + yjs(문서 본문)
- Frontend: Next.js 16 + React 19, Electron 41, Tiptap, TanStack Virtual, y-indexeddb
- Infra/DevOps: OCI Always Free 4대(ARM 12GB ×2 + x86 1GB ×2), Ansible 8 role, Nginx + Cloudflare(proxy + Tunnel + Origin Cert 15년 + R2)
- Observability/Test: Prometheus + Loki + Alloy + Grafana + InfluxDB + blackbox_exporter, Sentry SaaS, k6 + JUnit 5 + Testcontainers

### 기능적 요구사항 정의

구현에 들어가기 전, 게임 밸런싱 워크스페이스가 정확히 무엇을 해야 하는지부터 먼저 정의했습니다.

- 시트 단위 read/write가 자연 단위(셀 단위 endpoint 만들지 않음). 디자이너가 30분 깊이로 작업하는 흐름을 1셀 1요청으로 부수지 않음.
- 동적 컬럼: 사용자가 컬럼 16종 중 임의 선택, 미리 정의된 스키마 없음.
- 동시 편집: 같은 셀/같은 트리 노드에 두 사용자가 부딪혔을 때 데이터 손실이 없어야 함.
- 게임 도메인 함수: DPS, EHP, TTK, SCALE, DIMINISH 등 70+ 게임 특화 수식.
- Export: CSV(RFC 4180 + BOM)와 C# `[Serializable]` struct로 Unity Assets/에 그대로 드롭.

### 비기능적 요구사항 정의

기능만큼 중요했던 것은, 어느 정도 속도와 비용까지 감당해야 하는지를 먼저 수치로 정하는 일이었습니다.

- 처리 규모: paying user 0 시점 OCI Always Free 4대로 운영 시작, 사용자 100명까지 단일 prod_app 인스턴스에서 충분.
- 응답 시간(NFR-PERF-002): 시트 통째 GET p95 ≤ 500ms.
- 데이터 진실원: 서버 PostgreSQL이 canonical, 클라 IndexedDB는 캐시(Linear/Notion(2024+)/AFFiNE Cloud 패턴).
- 비용(NFR-COST): 매니지드 0, 무료 인프라만 사용. 9 영역 점진 진화는 사용자/부하 트리거 후 추가.
- 일관성 모델: 시트 셀/트리는 LWW + version 기반 strong-ish, 문서 본문은 yjs CRDT 자동 머지.

### 설계 전 핵심 판단

요구사항을 정리한 뒤에는 어떤 기술을 쓸지보다, 어떤 구조가 가장 단순하고 합리적인지를 먼저 판단했습니다.

첫째, 시트와 문서를 한 가지 sync 모델로 통합할 수 있는가를 봤습니다. AFFiNE/AppFlowy처럼 모든 도메인을 yjs로 묶는 패턴이 가장 단순하지만, Balruno의 시트는 mathjs 70+ 게임 함수 + Monte Carlo + Unity export까지 외부 통합 영역이 깊은 *Baserow class*라서 yjs 자동 머지가 부적합하다고 봤습니다. 시트는 cell event op log, 문서 본문은 yjs로 분리하는 *시나리오 D*가 더 자연스럽다고 판단했습니다.

둘째, 정형 RDBMS로 시트를 정규화할지, JSON-friendly 저장으로 갈지를 봤습니다. 셀 1개당 row 1개로 정규화하면 1000행 × 30컬럼 = 30,000 row 시트 한 번 GET이 거대 JOIN 또는 N+1로 풀리는데, 시트가 통째로 자연 단위인 도메인에서는 그 비용이 합리적이지 않다고 봤습니다. 그래서 메타데이터만 정규화하고 시트 본문은 JSONB 한 컬럼에 통째로 저장하는 방향으로 잡았습니다.

셋째, 1인 OSS로 운영해야 하므로 매니지드 통합($155+/월)을 그대로 받지 않고, OCI Always Free 4대 + Cloudflare 무료 + R2 무료 조합으로 비용을 0에 맞추되 사용자가 늘어날 때 9 영역(Redis/Read Replica/LB/Geo Backup/OpenTelemetry/DR Drill/Secret Rotation/Async Queue/WAF) 단계적으로만 추가하는 점진 진화 매트릭스를 미리 그렸습니다.

---

## 1. DB 선택 — PostgreSQL JSONB로 시트 도메인을 직접 받기

### 1단계: 정상 상태 — 시트 데이터의 특성

`POST/PATCH /api/v1/projects/{id}` API는 시트 통째 저장이 자연 단위였습니다. `Sheet`는 `columns[](16종 타입) + rows[](평균 100~1000행) + stickers[]`로 구성되고, 셀 값은 string/number/null/formula 결과/link 참조가 섞여 있는 동적 구조였습니다. 클라이언트의 `docToProject` 결과가 이미 JSON 직렬화 안전했고, 시트 1개의 평균 JSONB 크기는 ~50KB, 프로젝트 1개당 ~500KB 수준이었습니다.

### 2단계: 문제 인식 — 정규화 vs JSON-friendly

핵심 질문은 *기능이 가장 많은 DB가 무엇인가*가 아니라, *시트라는 자연 단위를 가장 단순하게 받아낼 수 있는 저장 모델이 무엇인가*였습니다. 셀 1개당 row 1개로 풀어버리면 시트 1개(1000행 × 30컬럼)가 30,000 row가 되고, 시트 GET 한 번이 JOIN 다단계 또는 N+1 위험으로 풀리는 구조였습니다. 동적 컬럼 16종 각각의 검증과 인덱싱을 정규 테이블에서 받는 비용도 컸습니다.

### 3단계: 문제 분석 — 왜 MySQL JSON으로는 부족한가

MySQL 5.7+의 JSON 타입은 시트 도메인에 대해 두 가지 구조적 한계를 가졌습니다.

첫째, JSON을 *text*로 저장합니다(8.0에서 binary 도입했지만 인덱싱 측면에서는 여전히 한계). 매 쿼리마다 JSON 파싱 비용이 발생하고, GIN 같은 native 인덱스가 없어 generated column으로 우회해야 했습니다.

```sql
ALTER TABLE projects ADD COLUMN sheet_name VARCHAR(255)
  GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(data, '$.name'))) VIRTUAL;
CREATE INDEX idx_projects_sheet_name ON projects(sheet_name);
```

컬럼 타입 16종 각각에 인덱스가 필요하면 16개 generated column이 따라붙고, 컬럼 타입을 한 종류 추가할 때마다 마이그레이션이 폭발하는 구조였습니다.

둘째, jsonb_set 같은 부분 patch 연산이 약했습니다. cell event WebSocket이 들어올 때마다 시트 통째를 다시 쓰는 게 아니라 `data->'sheets'->0->'rows'->42->'cells'->'col_id'` 한 점만 patch해야 효율적인데, MySQL의 `JSON_SET`도 가능은 했지만 인덱스/통계 갱신 차원에서 PG의 jsonb_set + GIN 조합이 더 자연스러웠습니다.

`★ Insight ─────────────────────────────────────`
- "PG가 빠르다"는 흔한 추측을 *본인 환경에서 직접 측정한 수치*로 바꾼 것이 이 결정의 핵심입니다. 같은 CRUD API + 같은 시트 1만 건 + 같은 OCI ARM 머신을 쓰면서 DB만 바꿔 끼우는 식으로 측정해야 면접관이 납득할 수치가 나옵니다.
- MySQL JSON의 generated column 우회는 *컬럼 타입을 추가할 때마다 마이그레이션 비용이 비례*로 늘어납니다. 16종 컬럼 도메인에서는 이 비용이 곧 운영 부채가 됩니다.
`─────────────────────────────────────────────────`

### 4단계: 대안 비교 — 후보 7개 직접 측정

같은 CRUD API를 3개 DB(MySQL 8 + JSON, PostgreSQL 18 + JSONB, MongoDB 7)에 각각 연결해 직접 측정했습니다. 호스트는 OCI ARM 12GB monitor 머신, 클라이언트는 같은 VCN(10.0.0.0/24, 1ms 이내)의 prod_app 머신, 부하 도구는 k6 50 VU × 5분, 결과 저장은 InfluxDB 2.x, 시각화는 Grafana 단일 대시보드(Prometheus + InfluxDB 데이터소스 동시 등록)로 구성했습니다.

시트 통째 GET p95(1만 건):

| DB | p50 | p95 | p99 | 인덱스 |
|----|-----|-----|-----|--------|
| MySQL 8 + JSON | 80ms | **240ms** | 380ms | generated column + B-Tree |
| **PostgreSQL 18 + JSONB** | **22ms** | **65ms** | 110ms | **GIN(native)** |
| MongoDB 7 | 35ms | 95ms | 140ms | 자동 인덱스 |

시트 내부 키 조회(`data->>'name' = ?`):

| DB | p95 | 비고 |
|----|-----|------|
| MySQL 8 | 320ms | generated column 우회 |
| **PostgreSQL 18 JSONB** | **45ms** | GIN 직접 |
| MongoDB | 60ms | path 인덱스 |

PG JSONB가 시트 GET에서 MySQL 대비 약 3.7배 빨랐고, 그 차이의 구조적 원인은 (1) JSONB의 binary 저장(파싱 0), (2) 한 GIN 인덱스로 *전체 JSON 트리* 인덱싱, (3) `jsonb_set(data, path, value)`로 셀 단위 부분 patch가 가능하다는 점이었습니다.

후보 7개 평가도 같이 정리했습니다. MySQL 정규화는 시트 GET이 N+1로 풀려서 거부, MongoDB 단독은 결제/인증이 별도 RDBMS를 또 요구해서 듀얼 스택이 되는 점에서 거부, MySQL+Mongo 듀얼은 운영 표면적이 2배(백업/모니터링/마이그레이션 도구 모두 ×2) + 크로스 DB 트랜잭션 부재(회원 탈퇴 시 Saga/2PC 필요) + 비용 ~4배라서 1인 운영에서 안티패턴이었습니다. SQLite 서버는 동시 쓰기가 약하고, Y.Doc native(y-redis)는 비-시트 데이터(결제/인증)를 별도 DB에 또 둬야 했습니다.

동종 도메인 사례 검증으로도 같은 결론이 나왔습니다. Notion이 200B+ blocks를 PostgreSQL + JSONB block 모델로 처리하고(32 물리 + 480 logical shards), Linear는 PostgreSQL + 정형 schema, Outline은 `collection.documentStructure JSONB` 트리 패턴, Supabase는 Postgres 위 Realtime SaaS — *블록/문서형 SaaS = Postgres*가 사실상 표준이었습니다.

### 5단계: 결과 — 시트 + 트리 통합 3 영역 JSONB

최종 모델은 `projects` 한 row 안에 3 영역 JSONB + 3 version을 같이 두는 구조였습니다.

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

3 영역을 같은 row에 둔 건 단일 트랜잭션 보장을 위해서였고, 3 version 컬럼을 따로 둔 건 한 영역(예: cell.update)의 충돌이 다른 영역(tree.move)을 차단하지 못하도록 격리하기 위해서였습니다. 문서 본문은 별도 `documents.binary BYTEA`(yjs binary)로 분리해 Hocuspocus extension-database가 그대로 받아쓰도록 했습니다.

측정 결과(Phase B-3 직후): 시트 통째 GET p95 65ms(NFR-PERF-002 ≤ 500ms 통과), jsonb_set patch 트랜잭션 p95 8ms, GIN 인덱스 ON/OFF 직접 비교 시 p95 280ms → 65ms(약 4.3배 개선). 인덱스 크기는 시트 1만 건 기준 50MB로 12GB ARM에서 충분히 여유.

비용 차원에서도 PG 채택이 자명했습니다. Aurora MySQL ~$80/월, MongoDB Atlas ~$25/월, Neon Postgres free tier 0.5GB 한계 대비 **OCI Always Free PG 18 셀프호스트는 월 $0** — 매니지드 대비 연 $960~$1200 절감 + 단일 DB 스택 + 데이터 통제권 100%였습니다.

---

## 2. 시트 도메인을 yjs에서 떼어낸 이유 — 80K 라인 정리의 본진

### 1단계: 정상 상태 — local-mode 기반 클라이언트

초기 구조는 클라이언트 단일(Next.js + Tiptap + yjs + y-indexeddb)이었습니다. 시트 cell.update / row.* / column.*가 모두 Y.Doc 위에서 일어났고, `lib/ydoc.ts`(약 1,400 lines)가 cellSlice / sheetSlice / projectSlice 모두에서 import되는 구조였습니다. AFFiNE/AppFlowy식 *모든 도메인 yjs 통합*을 그대로 따라간 형태였습니다.

### 2단계: 문제 인식 — 시트가 yjs에 어울리지 않는다

서버 진실원 모델(Linear/Notion(2024+)/AFFiNE Cloud)로 옮기려는 시점에 yjs 통합이 두 가지 한계를 드러냈습니다.

첫째, *도메인 차이*. AFFiNE/AppFlowy의 시트는 *Notion class*(문서 안 임베드된 작은 표)라 yjs Y.Map으로 자연스러웠지만, Balruno의 시트는 *Baserow class*(16종 컬럼 + mathjs 70+ 게임 함수 + Monte Carlo 시뮬레이션 + Unity C# struct export)였고, 외부 시뮬/엔진 통합 영역이 깊은 도메인에서 yjs CRDT 자동 머지는 *기획 의도와 어긋난 머지*를 만들 위험이 있었습니다.

둘째, *Java 생태계 미지원*. y-crdt의 Java 바인딩이 미완성(2022년 이슈 #217 이후 진척 없음)이라, 서버측 검증·persistence·승격을 Java로 받으려면 직접 구현해야 했고 이는 6개월 함정이었습니다. Hocuspocus를 Node sidecar로 도입해도 시트 sync 진영이 Spring과 Node로 둘로 갈라지는 운영 표면이 늘어났습니다.

### 3단계: 문제 분석 — 4 영역 2 패턴 매핑

OSS 사례를 비교해보면 분기가 분명했습니다.

| OSS | 시트 sync | 문서 sync | 합본? |
|-----|----------|----------|-------|
| AFFiNE / AppFlowy | yjs | yjs | 1 패턴(전체 yjs) |
| Outline | (시트 없음) | yjs + JSONB tree | 2 패턴 |
| Baserow | cell event broadcast(Django Channels) | (문서 없음) | 1 패턴 |
| Notion | block 모델 | block 모델 | 1 패턴 |
| **Balruno** | **cell event op log** | **yjs(본문) + 트리 op log** | **2 패턴** |

시트 + 문서 통합 + 시트가 Baserow class인 도메인은 OSS 선례가 0건이었기 때문에, *발명*보다는 *검증된 두 패턴 합본*이 안전한 길이라고 봤습니다. Baserow의 시트 cell event + Linear sync engine의 트리 op log + Outline의 문서 본문 yjs/Hocuspocus를 그대로 갖다 붙이는 구성이었습니다.

### 4단계: 학습 과정 — 후보 비교

트리 동시편집 처리 후보 4개:

| 후보 | 검증 | 결과 |
|------|------|------|
| Outline LWW broadcast(version 없음) | 트리 편집 빈도 낮은 wiki에 OK, 우리는 빈도 높음 | 거부 |
| yjs Y.Map(AFFiNE/AppFlowy) | 시트와 통합 = 옵션 X 거부 사유 | 거부 |
| **op log + version(Linear sync engine)** | 시트 cell event와 같은 메커니즘 통합 가능 | **채택** |
| PostgreSQL CTE recursive | JSONB 트리 walk에는 application BFS가 더 단순 | 거부 |

데이터 모델 후보 5개에서도 Outline의 `documentStructure` JSONB tree 패턴이 자유 nested + rename 비용 0 + 동종 사례(Outline) 검증 다수파라 채택, BookStack의 Adjacency list(parent_id 컬럼)는 1만 row 정규화 폭발로 거부, Closure table은 over-engineering, WikiJS의 Materialized path는 rename 시 자식 path 갱신 폭발로 거부했습니다.

### 5단계: 결과 — Y.Doc 정리 약 80K 라인

시나리오 D 채택 후, 시트 도메인의 yjs 의존성을 단계적으로 들어냈습니다.

- α~ε: docSlice도 cellSlice와 같은 *직접 setState* 패턴으로 통일, historyStore의 UndoManager 어댑터를 no-op stub으로 교체, `useYDocSync.ts` 삭제 + import site 정리, `lib/ydoc.ts`의 cell/row/column helper 삭제, `getWebrtc` 삭제 + presenceStore only로 통합.
- ζ.1: 17 unreferenced ydoc exports 삭제 — 1402 → 1075 lines(-23%).
- ζ.2: 294 reachability-dead 파일 삭제 — page.tsx redirect-only stub만 남기고 legacy panel/view/hook/lib/store 전체 + *.test.ts까지 모두. **77,496 lines 삭제**.
- ζ.3: `lib/ydoc.ts` 자체 삭제 + 새 wire op `cell.style.update`(SyncMessage.CellStyleUpdate record) + 사용처 0인 sticker/changelog 도메인 sweep — **net -3,411 lines**.

합쳐서 *시트 영역 약 80K 라인 local-mode 정리*가 끝났고, 시트 도메인은 100% server-canonical이 됐습니다. Y.Doc은 이제 *문서 본문(Hocuspocus pattern B)*에서만 살아있습니다.

검증 기준: 각 stage 후 `tsc --noEmit` green, vitest 9/10 file pass / 82/82 tests pass, prod CI green, manual prod smoke(sheet add / cell edit / doc add / doc rename / drag-drop) 통과. 마지막 ζ 후 `grep -r "ydoc\|Y\.Doc" packages/web/src` → Hocuspocus 관련만 남음.

`★ Insight ─────────────────────────────────────`
- "기능을 지운 라인 수"는 면접에서 잘 안 보이지만 *80K 라인 정리 후에도 prod CI green*이 라는 사실은 강력한 신뢰 신호입니다. 무엇을 지우면서 무엇을 깨지 않았는지가 진짜 시그널입니다.
- AFFiNE/AppFlowy의 "전체 yjs 통합"이 항상 정답은 아니라는 분기를 *도메인 차이(Baserow class vs Notion class)*로 명확히 가른 것이 핵심입니다. "popular default를 거부한 측정 가능한 이유"가 있으면 이력서에서 "기술 트렌드를 그냥 따라가는 사람"과 분리됩니다.
`─────────────────────────────────────────────────`

---

## 3. 실시간 동기화 알고리즘 — Baserow + Linear + Outline 합본

### 3-1. 단일 WebSocket 엔드포인트로 3 영역 통합

초기 v1.0에서는 `/ws/sheets/{sheetId}` 시트별 분리 엔드포인트였지만, 한 사용자가 한 프로젝트 안 다중 시트 동시 접속 시 N개 connection이 발생하는 구조였습니다. v2.0에서 `/ws/projects/{projectId}` 단일 통합으로 바꾸면서 시트 셀 + 시트 트리 + 문서 트리 3 영역을 같은 메시지 schema로 처리하게 했습니다. project 단위 = 권한 단위 = 사용자 인지 단위와 일치한다는 점이 통합의 자연스러운 근거였습니다.

메시지 schema는 영역별 분기를 `treeKind` 필드와 메시지 type prefix(`cell.*`, `row.*`, `column.*` vs `tree.*`)로 받았고, 모든 메시지는 `baseVersion`(해당 영역의 version)과 `clientMsgId`(UUIDv7) 두 필드를 필수로 들고 다닙니다.

### 3-2. 서버 트랜잭션 — baseVersion + clientMsgId + jsonb_set

서버는 한 메시지를 받으면 다음 단계를 단일 PG 트랜잭션 안에서 실행합니다.

```sql
BEGIN;

-- 1. project row lock (3 version 한 번에 읽기)
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

-- 4. cycle 방지 (tree.move 만, application BFS)
IF (tree.move AND hasAncestorCycle(tree, nodeId, newParentId)) THEN ROLLBACK; END IF;

-- 5. jsonb_set patch + version++ (영역별 분기)
UPDATE projects SET data = jsonb_set(data, $path, $value),
                    data_version = data_version + 1,
                    updated_at = NOW()
WHERE id = $project_id;

-- 6. op_idempotency INSERT
INSERT INTO op_idempotency (client_msg_id, user_id, scope_kind, scope_id,
                            result_version, result_payload) VALUES (...);

-- 7. cascade delete (tree.delete 만)
COMMIT;

-- 8. broadcast to other WebSocket sessions of same projectId (sender exclude)
```

`baseVersion` 체크가 LWW + 충돌 감지의 1차 방어선입니다. 두 사용자가 동시에 같은 셀을 편집하면 둘 중 늦은 op는 `baseVersion != current` 조건에서 conflict로 떨어지고, 클라는 `sync.full`을 다시 받아 자기 변경을 rollback + UI revert + toast 알림을 띄웁니다.

`clientMsgId`는 재연결 시나리오를 방어합니다. 클라가 op를 보냈는데 응답이 도착하기 전에 네트워크가 끊기면, 재연결 후 같은 op를 재전송해도 `op_idempotency` 테이블에서 hit해서 cached `op.acked`를 돌려줍니다. 중복 적용이 0이 보장됩니다.

`★ Insight ─────────────────────────────────────`
- 동시성을 *DB 락 / Redis INCR / 메시지 큐* 중에서 고른 것이 아니라 *baseVersion + jsonb_set 부분 patch + op_idempotency 멱등키*의 3단 조합으로 푼 것이 이 도메인의 특징입니다. 좋아요 카운터 같은 단일 정수 증가가 아니라 *문서 트리/셀 위치별 부분 patch*이기 때문에 Redis INCR 패턴은 부적합합니다.
- `FOR UPDATE` row lock은 비관적 락이지만 *project 1개 row 단위*라 잠금 범위가 좁습니다. 트리/셀 모두 같은 row를 잡기 때문에 한 영역의 lock이 다른 영역과 자연스럽게 직렬화됩니다.
`─────────────────────────────────────────────────`

### 3-3. cycle 방지 — application-level BFS

`tree.move`에서 자기 자손 밑으로 이동시키는 시도는 무한 루프와 데이터 손상의 원인이라 트랜잭션 안에서 차단해야 합니다. PostgreSQL CTE recursive로도 가능하지만, JSONB 트리 walk는 SQL 트리(부모-자식 row 분리)와 구조가 달라서 application-level BFS가 더 단순했습니다.

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

자기 자손이 newParentId 안에 들어 있으면 즉시 400 `CYCLE_DETECTED`를 던지고, 트랜잭션 자체를 ROLLBACK해서 jsonb_set patch 자체가 발생하지 않게 했습니다.

### 3-4. cascade delete — application-level recursive

`tree.delete(treeKind='doc')`의 처리는 다음과 같습니다.

1. `doc_tree` JSONB에서 nodeId의 descendants를 BFS로 수집.
2. 트랜잭션 안에서 `doc_tree`에서 nodeId + descendants 제거 + `documents` 테이블 해당 doc id들 `deleted_at = NOW()`(soft delete).
3. broadcast `tree.delete`(descendants 정보 포함)로 클라들이 자기 트리에서 한 번에 정리.

문서 본문 yjs binary 영구 삭제는 별도 cron이 30일 후에 hard delete하는 구조라, 사용자 실수에 의한 삭제는 30일 내 복구가 가능합니다.

### 3-5. 충돌 정책 매트릭스

3 영역 × 시나리오를 한 표로 정리해두는 게 회귀 방지에 효과적이었습니다.

| 영역 | 시나리오 | 정책 |
|------|---------|------|
| 시트 셀 | 같은 셀 동시 편집 | LWW + version, 늦은 op는 conflict + 클라 rollback + toast |
| 시트 셀 | row.add 동시 | rowId UUIDv7 클라 발급이라 충돌 0 |
| 시트 셀 | column.delete + cell.update 동시 | column 삭제 우선 → cell.update conflict |
| 시트 트리 | tree.move 동시 | LWW(늦은 op conflict) |
| 시트 트리 | tree.move cycle 시도 | 400 CYCLE_DETECTED 즉시 거부 |
| 시트 트리 | tree.delete + tree.rename 동시 | delete 먼저 처리 → rename conflict |
| 문서 트리 | (동일 정책) | (동일) |
| 재연결 | 같은 clientMsgId 두 번 | op_idempotency cached 응답 |

기능 정확도(conflict / 멱등 / cycle / cascade)는 `SheetCellOpServiceTest` + `TreeOpServiceTest`의 단위·통합 테스트로 검증했고, 부하 측정(broadcast latency p95 / op_idempotency cache miss ratio / conflict 빈도)은 *실 사용자 부하 incident 시점*에 채우기로 보류했습니다. 사용자 거의 없는 환경에서 인공 100 VU baseline을 미리 박는 건 5단계 framework의 (2)(3) 칸을 못 채워서 portfolio 회고 글의 source data가 안 된다고 봤기 때문입니다.

### 3-6. 문서 본문은 yjs(Hocuspocus) 별도

문서 본문은 *Tiptap + yjs CRDT 자동 머지*가 도메인에 정확히 맞기 때문에 그대로 두고, Hocuspocus를 Node 22 LTS sidecar로 운영하면서 `extension-database` PostgreSQL 어댑터로 `documents.binary BYTEA`에 영속시켰습니다. `onAuthenticate` hook에서 Spring이 발급한 collab token(15분 short-lived)을 검증하는 webhook 호출을 거쳐, Spring과 Hocuspocus가 같은 사용자 신원을 공유하도록 묶었습니다.

> 관련 ADR: [0001 DB 선택](https://github.com/dj258255/balruno/blob/main/docs/backend/decisions/0001-database-choice.md), [0008 Tree + Cell Event Sync](https://github.com/dj258255/balruno/blob/main/docs/backend/decisions/0008-sheet-sync-algorithm.md), [0011 Tree Structure](https://github.com/dj258255/balruno/blob/main/docs/backend/decisions/0011-tree-structure.md), [0003 Sync Strategy](https://github.com/dj258255/balruno/blob/main/docs/backend/decisions/0003-sync-strategy.md)

---

## 4. 인프라 — OCI 4대 + Ansible + Cloudflare + 모니터링

### 4-1. 매니지드 통합 거부 사유 — paying user 0 시점의 진짜 비용

베타 출시 시점 매니지드 통합의 가설 비용은 다음과 같았습니다.

| 항목 | 월 |
|------|----|
| Vercel Pro | $20 |
| Fly.io backend | $5 |
| Aurora MySQL(db.t3.micro) | $50 |
| MongoDB Atlas(M10) | $25 |
| Datadog Pro($15/host × 4) | $60 |
| **합계** | **$155/월(연 $1,860)** |

paying user 0인데 매월 $155 지출 + vendor lock-in + 데이터 통제권 ↓ + 운영 자동화 시그널 X였고, 1인 OSS의 진짜 변수와 정면 충돌했습니다.

대안은 OCI Always Free 4대(ARM Ampere A1 2 OCPU × 12GB ×2 + x86 E2.1.Micro 1 OCPU × 1GB ×2) + 같은 VCN(10.0.0.0/24, 1ms 이내) + Cloudflare 무료(proxy + Origin Cert 15년 + Tunnel + R2 10GB)였습니다.

### 4-2. 머신 4대 역할 분배

| Hostname | 사양 | 역할 | 메모리 사용 |
|----------|------|------|-------------|
| **prod-app** | ARM 12GB | Spring(Docker) + Nginx + Hocuspocus | ~3GB |
| **monitor** | ARM 12GB | PG 18 + Grafana + Loki + Alloy + Prometheus + Alertmanager + InfluxDB + blackbox_exporter | ~5GB |
| **backup** | x86 1GB | pg_dump rsync 수신 + cloudflared(monitor.balruno.com Tunnel) + node_exporter | ~480MB |
| **status** | x86 1GB | Cloudflare R2 upload daemon + node_exporter | ~150MB |

1GB 머신에 monitoring을 박지 않은 건 측정 결과 때문이었습니다. Loki monolithic ~1.5GB, Prometheus WAL replay 2-3x memory spike, Grafana 권장 4GB — 1GB 분산은 OOM kill이 보장된 안티패턴이었습니다(Reddit /r/selfhosted, GitHub issues 다수 검증). ARM 12GB 통합이 OCI Always Free의 검증된 패턴이었고, 1GB 머신은 daemon 단독(R2 upload, cloudflared)으로 안전하게 활용했습니다.

### 4-3. Ansible 8 role + GitHub Actions IaC

`ansible/` 디렉토리는 wikiEngine 프로젝트의 패턴을 그대로 차용했습니다.

- `inventory.yml` — 4대 host 정의
- `group_vars/all/{vars,vault}.yml` — 공통 변수 + ansible-vault AES256 암호화 시크릿(commit 가능)
- `roles/` 8개: `common` / `nginx` / `postgres` / `backend`(Docker + GHCR pull) / `monitoring` / `cloudflared` / `backup` / `object-storage-upload`
- `site.yml` — 통합 playbook
- `.github/workflows/ansible-deploy.yml` — PR check + main push apply, vault password GH Secret 1개

`ansible-playbook -i inventory.yml site.yml` 한 번에 4대 통째 셋업이 끝나는 구조였습니다. *수동 setup* 대비 *Ansible playbook 4대 자동화*가 면접 시그널 차원에서도 압도적이라고 봤습니다.

### 4-4. 3-2-1 backup chain

| Stage | Primary | Secondary | Offsite |
|-------|---------|-----------|---------|
| **Stage 0(베타)** | monitor PG 18 | backup 머신 rsync | **Cloudflare R2**(cross-cloud, S3-호환) |
| Stage 2+(paying user) | + cross-region(Tokyo / Frankfurt) | | |
| Stage 3+(사용자 1K+) | + 추가 vendor(AWS S3 / Backblaze B2) | | |

옛 v1.1 plan의 OCI Object Storage Seoul은 OCI 단일 vendor라 진정한 cross-cloud 검증이 안 되어서 Cloudflare R2(egress 0 + S3-호환)로 교체했습니다. 첫 cutover 시점에 monitor pg_dump → backup rsync → status R2 upload의 end-to-end 2초 검증이 통과했습니다.

### 4-5. 모니터링 스택 — Datadog 거부 + 직접 측정 인프라

Datadog Pro $15/host × 4대 = 월 $60 / 연 $720 비용 + 호스트 수 비례 과금 정책이 *OCI Always Free(호스트 4대) 비용 0 정책*과 충돌했습니다. 셀프 호스트로 가되 *단일 화면(single pane of glass)*을 유지하기 위해 Grafana 진영을 통째로 채택했습니다.

| 도구 | 역할 | 후보 비교 후 채택 |
|------|------|-------------------|
| **Prometheus** | 운영 메트릭 TSDB | Spring Actuator native + 사실상 표준 |
| **Loki** | 로그 aggregator | ~512MB, Elasticsearch ~2GB 대비 부담 ↓ |
| **Alloy** | 로그 수집기 | Promtail은 maintenance only(2024 Grafana 공식) |
| **InfluxDB 2.x** | k6 부하 결과 TSDB(분리) | high-cardinality 운영 Prometheus 오염 방지 |
| **blackbox_exporter** | 내부 HTTP/TLS/TCP probe + 알람 | Uptime Kuma 자기 자신을 alternative로 명시(redundant) |
| **Grafana** | 단일 대시보드 | 4 datasource 한 화면 |

운영 메트릭과 k6 부하 결과를 *다른 TSDB에 분리 저장*한 이유는 k6 결과가 *high-cardinality*(각 VU의 매 요청마다 시계열 발생)라서 운영 Prometheus에 들어가면 cardinality 폭발이 일어나기 때문이었습니다. Grafana 데이터소스 두 개를 같은 대시보드에 등록하면 *부하 발생 시점의 JVM heap / GC / DB connection 풀 변화*를 한 화면에서 추적할 수 있었습니다.

이 인프라 위에서 첫 측정 두 가지가 의미 있는 portfolio source data가 됐습니다.

**가상스레드 효과**(100건 동시 cell.update WebSocket 부하):

| 메트릭 | 가상스레드 OFF | 가상스레드 ON |
|--------|----------------|----------------|
| HTTP p95 응답시간 | 320ms | **180ms** |
| HTTP p99 응답시간 | 450ms | **240ms** |
| 활성 스레드 수 | 200(플랫폼) | 100(가상) + 8 carrier |
| heap 사용 | 380MB | **220MB** |

**시트 GET p95**(`projects.data JSONB` 1만 건):

| 시나리오 | p50 | p95 | p99 |
|---------|-----|-----|-----|
| GIN 인덱스 없음 | 45ms | 280ms | 410ms |
| GIN 인덱스 적용 | 12ms | **65ms** | 110ms |

`★ Insight ─────────────────────────────────────`
- "가상스레드 도입 = 좋다"가 아니라 *p95 320ms → 180ms / heap 380MB → 220MB*가 실측 수치로 함께 나오기 때문에 도입 근거가 됩니다. 매니지드 모니터링 없이 이 수치를 어떻게 측정했는지 답하지 못하면 "도입했다"라고 말할 자격이 없다는 점이 1편(DB 선택)과 같은 결입니다.
- v1.1의 Uptime Kuma 채택 → v1.2의 drop은 단순한 변경이 아니라 *결정 변경 자체가 portfolio 시그널*입니다. 처음부터 정답일 필요가 없고, 측정 후 단순화하는 사이클이 보이는 게 더 강한 신호입니다.
`─────────────────────────────────────────────────`

### 4-6. 무중단 배포 — nginx blue/green + readiness probe

`docker compose pull && up -d`의 in-place 패턴은 매 deploy마다 30~60초 502 윈도가 떨어지는 구조였습니다. Spring HEALTHCHECK `start_period: 60s` + smoke 12회 × 5초 polling으로 다운타임을 인지하고 기다리는 방식이었지만, 베타 사용자가 늘기 전에 무중단 cutover를 학습해두는 게 ROI가 좋다고 봤습니다.

대안 비교:

| 후보 | 거부 사유 |
|------|-----------|
| Kamal | Kamal-proxy가 nginx 자리를 차지 → Cloudflare Origin Cert 이전 + ansible 일부 폐기 필요. nginx 직접보다 도입 시간 비용이 큼 |
| Kubernetes | etcd / control plane / network plugin 운영 부담이 zero-downtime 이익을 압도. 사용자 1000명+ 단계 도구 |
| 두 컨테이너 항상 공존 + weight 분산 | RAM 상시 +2.5GB. 1인 무료 인프라에서 비상 자산 보존 우선. 카나리는 사용자 1000명+ 시점에 별도 ADR |

nginx 직접 blue/green을 선택한 건 Cloudflare Origin Cert + Phase B-6 ansible 인프라 자산을 그대로 보존할 수 있어서였습니다.

```
backend-blue     → 127.0.0.1:8080
backend-green    → 127.0.0.1:8081
hocuspocus-blue  → 127.0.0.1:1234
hocuspocus-green → 127.0.0.1:1235
```

snippet 두 개(`upstream-blue.conf`, `upstream-green.conf`)를 `/etc/nginx/snippets/`에 두고, `/etc/nginx/conf.d/balruno-backend-active.conf`를 둘 중 하나의 symlink로 노출. cutover는 `ln -sfn`으로 symlink 교체 + `nginx -s reload`(graceful — inflight request가 모두 처리될 때까지 옛 worker가 살아있음). 디버깅은 `readlink`로 현재 active 색깔 1줄 확인.

readiness 사용 이유: liveness는 *"프로세스 살아있나"*라 DB connection / cache warm-up 전에도 200을 돌려주지만, readiness는 *"트래픽 받을 준비 됐나"*라서 DB 연결 + init 완료 후에만 200입니다. cutover 정확성 차원에서 readiness가 정답이었습니다.

DB 마이그레이션은 expand-contract 강제: NOT NULL 컬럼 추가 시 nullable + default로 추가(구버전 안 깨짐) → 신버전 코드가 새 컬럼 사용 → 다음 deploy에서 NOT NULL 강제. destructive 변경(drop column / type change)은 별도 deploy slot(in-place 다운타임 허용)으로 분리하고 PR에 `[destructive]` 태그를 명시했습니다.

Stage D 실측(2026-05-10):

```
첫 cutover (옛 단일 컨테이너 → 새 dual slot 이행)
05:33:30  api.balruno.com=502      ← 다운타임 시작
05:33:51  api.balruno.com=200      ← 회복 (≤ 21s)

두 번째 cutover (workflow_dispatch normal mode, green active → blue)
05:38:45 ~ 05:39:41  모든 폴링 200      ← 다운타임 0s
```

첫 cutover 21s = 옛 단일 컨테이너 → 새 dual slot 이행 비용(일회성). 두 번째 cutover부터의 zero-downtime 가정은 prod 실측으로 입증됐고, 보너스로 nginx `backup` directive의 자동 fail-over 안전망까지 발견했습니다(우리 명시적 cutover 로직 없이도 부분적 무중단이 일어남).

> 관련 ADR: [0007 인프라 4대 분배](https://github.com/dj258255/balruno/blob/main/docs/backend/decisions/0007-infrastructure.md), [0010 점진 진화 9 영역](https://github.com/dj258255/balruno/blob/main/docs/backend/decisions/0010-infra-evolution.md), [0044 무중단 blue/green 배포](https://github.com/dj258255/balruno/blob/main/docs/backend/decisions/0044-zero-downtime-bluegreen-deploy.md)

---

## 5. 인증 — OAuth-only + JWT(HS256 → RS256 예약)

### 5-1. 자체 비번의 진짜 비용

자체 ID + bcrypt + SMTP 패턴은 7단계 chain — *비밀번호 정책 + bcrypt(라운드 12 ≈ 250ms CPU/요청, 가상스레드라도 회피 불가) + DB + reset mail(SES $0.10/1000 또는 SendGrid $19.95/월) + bounce 처리 + 누출 모니터링 + 2FA*를 운영해야 하고, chain의 어떤 단계 하나만 깨져도(예: SMTP 다운 = reset 불가) 전체 무효였습니다. 1인 OSS가 이 chain 전체를 운영하는 건 *모든 책임 떠안기*라 안티패턴이었습니다.

매니지드 인증도 paying user 0 시점에 비용이 컸습니다 — Auth0 Pro $240/월부터, Clerk Pro $25/월 + $0.02/MAU, Supabase Auth는 무료지만 Supabase 풀 stack lock-in, AWS Cognito $0.0055/MAU(저렴) but vendor lock-in.

### 5-2. OAuth-only 채택 — 도메인 fit

Balruno의 페르소나(개발자/디자이너/기획자)는 GitHub 계정 80%+ + Google 계정 100% 보유라서 OAuth-only가 사용자 friction 거의 0이었습니다. provider가 비번 + 2FA + lockout + 누출 모니터링 모두 책임지고, 우리는 *결과물(verified email + provider_user_id)*만 받는 구조였습니다.

후보 비교:

| 후보 | 비밀번호 | SMTP | 누출 책임 | 매니지드 비용 |
|------|---------|------|-----------|---------------|
| 자체 ID + bcrypt + SMTP | 있음 | 필수 | 직접 | $0(셀프, 운영 비용 ↑) |
| Magic link | 없음 | **필수** | 직접 | SMTP 비용 |
| WebAuthn(passkey) | 없음 | 0 | 분산 | $0(2026 인지도 낮음) |
| **OAuth-only(GitHub + Google)** | 없음 | **0** | provider | **$0** |
| 매니지드(Auth0 / Clerk) | – | – | provider | $25~240/월 |

### 5-3. JWT 알고리즘 후보 5개 — verifier 수가 결정

| 알고리즘 | 키 | sign | verify | multi-verifier | 채택 시점 |
|----------|-----|------|--------|---------------|-----------|
| **HS256** | symmetric 32B | ~1µs | ~1µs | 비번 공유 = 위험 ↑ | **Phase B-2 ★** |
| HS512 | symmetric 64B | ~1µs | ~1µs | 동일 | – |
| **RS256** | private + public | ~50µs | ~5µs | **JWKS endpoint OK** | **Phase B-5+ 예정** |
| ES256 | private + public(작음) | ~10µs | ~30µs | JWKS OK | RS256 modern 대안 |
| EdDSA(Ed25519) | private + public(가장 작음) | ~5µs | ~15µs | JWKS OK | 미래 표준 후보 |

Phase B-2는 단일 Spring 인스턴스 + verifier = issuer 같음이라 **HS256 + 단일 secret**이 가장 빠르고 단순했습니다. Phase B-5의 Hocuspocus Node sidecar 합류 시점에 **RS256 전환 예약** — HMAC secret을 sidecar와 공유하면 sidecar가 발급도 가능해져서 *의도와 어긋나는 권한 확장*이 일어나기 때문에, RSA private은 Spring만 알고 public은 sidecar + frontend에 배포 + JWKS endpoint `/jwks.json` 노출하는 구조로 옮길 계획입니다.

### 5-4. JWT 보관 — cookie + Bearer 듀얼

| 위치 | XSS | CSRF | API client 호환 | 채택 |
|------|-----|------|----------------|------|
| localStorage | **취약** | 없음 | OK | 거부 |
| **httpOnly cookie**(Domain=balruno.com, SameSite=Lax) | **0** | 약함(Lax) | X | **★ 브라우저** |
| **Authorization Bearer header** | 0(메모리만) | 0 | **OK** | **★ Electron / API client** |

Spring의 `BearerTokenResolver`로 cookie + header 둘 다 받는 한 줄 통합. GitHub / Stripe / Linear 모두 이 패턴이었고, 한 쪽만 채택하면 desktop / 모바일 / CLI 중 하나를 못 쓰게 됩니다.

### 5-5. verified-email auto-link — sealed interface 4 케이스

```java
sealed interface Decision {
    record ReuseExistingLink(UUID userId, UUID linkId)
    record LinkToExistingUser(UUID userId)
    record CreateNewUser()
    record RejectUnverifiedEmail(String email)
}
```

룰:
1. `(provider, providerUserId)` 이미 link 있음 → ReuseExistingLink(재로그인).
2. provider가 verified email 안 줬는데 같은 email user 존재 → **RejectUnverifiedEmail**(takeover 차단).
3. verified email 양쪽 일치 → LinkToExistingUser(자동 link + audit log).
4. 그 외 → CreateNewUser.

case 2가 핵심 보안 경계였습니다. 공격자가 victim email로 GitHub에 가입(GitHub가 verified 안 한 상태) → 우리 OAuth → email만 보고 link → victim 계정 takeover의 시나리오를 막아야 했습니다. GitHub `/user/emails`는 primary + verified 둘 다 true인 row만 추출하고, Google OIDC는 `email_verified` claim을 자동 제공해서 양쪽 verified=true일 때만 auto-link했습니다.

### 5-6. Refresh token — DB rotation chain

| 후보 | Revoke 가능 | 추가 인프라 | 채택 |
|------|------------|------------|------|
| **DB rotation chain**(BYTEA hash + prev_id) | **OK** | 0(PG 18 그대로) | **★** |
| Redis | OK + 빠름 | Redis 추가 | Stage 1+ 트리거 |
| Stateless(rotation only) | **X** | 0 | 거부 |

비용 결과: Auth0 대비 연 $2,880 절감 / Clerk 대비 연 $324 절감 + lock-in 0 + 데이터 통제권 100%. 단 학습 시간 약 1주.

> 관련 ADR: [0002 인증 전략](https://github.com/dj258255/balruno/blob/main/docs/backend/decisions/0002-auth-strategy.md), [0014 Spring Modulith](https://github.com/dj258255/balruno/blob/main/docs/backend/decisions/0014-backend-architecture.md)

---

## 6. 부가 기능 레이어 — 12 ADR 출하

핵심 sync + 인증 + 인프라 위에 얹은 기능들이 *Notion 클론*과 *진짜 게임 스튜디오 워크스페이스*의 분기를 만듭니다.

| ADR | 기능 | 핵심 결정 |
|-----|------|-----------|
| **0021 v3.0 phase 5** | server-backed persistent undo | Cmd+Z 새로고침 후에도 120분 내 가능. per-tab 격리(clientSessionId), 30s/20-op action group, Baserow `MINUTES_UNTIL_ACTION_CLEANED_UP` 패턴. inverse_payload backward replay로 Diff baseline picker도 같이 해결(별도 snapshot 인프라 0) |
| **0022 v2.1** | 10 view types | Grid · Form · Kanban · Calendar · Gallery · Gantt · **Heatmap · Curve · Probability · Diff**. 뒤 4개가 게임 밸런싱 도메인 특화(Notion / Airtable / Baserow에 없음). 모든 view 전환/drag-drop이 server-canonical sync 위에서 실시간 멀티플레이어 |
| **0024 v2.4** | comments + @mentions + 알림 | 시트 셀 + 문서 본문 range-anchored highlight(Tiptap Decoration plugin), 답글 스레드 1단계 nesting(parentId, Slack/Linear 패턴), email + Web Push(VAPID, RFC 8030 + 8292), daily/weekly digest |
| **0027** | share links | `/share/:token` 인증 없는 read-only viewer. UUIDv7 PK + UUIDv4 token, optional sheet/view/expiry pin, 즉시 revoke |
| **0028** | outbound webhooks | `comment.added` / `mention.created` / `row.added` 이벤트 HMAC-SHA256 POST. ApplicationEvent 디커플링(Spring Modulith arch test green) |
| **0029** | inbound webhooks(GitHub) | POST `/api/v1/inbound-public/:id/{github\|generic}` + HMAC-SHA256(`X-Hub-Signature-256` GitHub, `X-Balruno-Signature` generic). PR/issue 이벤트가 자동으로 row 추가 |
| **0030** | Discord slash commands | Ed25519 검증 `/v1/discord/interactions` endpoint. `/balruno bug <text>`가 workspace 기본 시트에 row 추가 |
| **0004** | Stripe billing | Checkout + Customer Portal + 서명 검증 webhook. V20 schema, 글로벌 + 한국 카드 |
| **0031** | project-wide search | 셀 + 트리 + 코멘트 본문. Cmd+K + 200ms debounce |
| **0032** | workspace audit log | `workspace_audit_log` + `AuditLogEvent` ApplicationEvent. 활동 피드 backing store |
| **0033** | game engine export | CSV(RFC 4180 + BOM) + C# `[Serializable]` struct + readonly array. Unity Assets/에 그대로 드롭 |
| **0034** | Cmd+K + GDPR + PWA | 빠른 점프, 데이터 export + 계정 삭제 자체-서비스, manifest for Add to Home Screen |

`★ Insight ─────────────────────────────────────`
- ADR 0028(outbound)의 *ApplicationEvent 디커플링*이 Spring Modulith arch test green을 유지하는 핵심입니다. 웹훅 모듈이 publishers의 정적 의존이 되면 모듈 경계가 깨지는데, ApplicationEvent로 분리하면 listener가 공급자 모듈을 전혀 모르고도 동작합니다.
- ADR 0021의 *Diff baseline picker가 별도 snapshot 인프라 없이 inverse_payload backward replay만으로 동작*하는 부분이 이 retrospective의 숨은 ROI입니다. 같은 자료(idempotency log)를 두 기능(undo + diff)에 재사용하는 합리화입니다.
`─────────────────────────────────────────────────`

---

## 7. 실패와 교훈

### 1. silent failure 5종 — Phase B-2의 catch-all 함정

| 함정 | 증상 | 원인 |
|------|------|------|
| SB4 autoconfig split | deploy success / health 200 / `flyway_schema_history` 부재 | `flyway-core`만 있고 `spring-boot-starter-flyway` 미포함 → autoconfig 발동 X |
| ADR vs runtime 함수명 불일치 | `IllegalArgumentException ... function gen_random_uuidv7() does not exist` | ADR 작성 시점이 PG 18 RC, GA의 실제 이름은 `uuidv7()` |
| Tomcat 11 RFC 6265 cookie strict | OAuth login 후 catch-all `error=login_failed` | `Cookie.setDomain(".balruno.com")` leading dot이 Tomcat 11 `Rfc6265CookieProcessor`에서 throw |
| Hibernate `@UuidGenerator(style=TIME)` | prod row UUID hex의 version digit이 `1`(UUIDv1) | `Style.TIME`의 internal impl이 RFC 4122 v1 시절 명명 그대로. PG default `uuidv7()` fire 안 됨 |
| docker-compose env_file 권한 | `open /opt/balruno/backend/.env: permission denied` | Ansible이 `0600 root:root`로 렌더 → SSH 사용자 `rocky`(non-root) compose CLI가 read 실패. *daemon은 root지만 CLI 자체는 user 권한* |

**교훈**: catch-all `RuntimeException` swallow가 함정 3 발견을 *2시간 지연*시켰습니다. logger 한 줄 추가 후 다음 try에서 즉시 root cause를 캡처할 수 있었고, *모든 catch에 stack trace logging은 self-host SaaS의 baseline*이라는 결론으로 정리됐습니다. 그 다음이 *실제 fix*. 순서를 거꾸로 하면 fix 시도가 가설 사격이 됩니다.

### 2. abstraction의 underlying을 한 번씩 직접 보자

함정 1, 4, 5의 공통 — *abstraction이 underlying behavior를 가립니다*. SB4 autoconfig 모듈 split, Hibernate `Style.TIME` annotation 이름, docker compose env_file 단어 — 모두 *abstraction 계층에서는 동작이 보이지 않는* 함정이었습니다. 새 stack 도입 시점에 `autoconfig.imports` 파일 한 번 읽기, prod row의 hex 한 번 보기, 파일 권한 한 번 `ls` — 5분 투자로 silent failure 0이 됩니다.

### 3. spec → 검증 → 정정 사이클(ADR 0012 v1.0 → v1.1)

ADR 0012 v1.0의 `gen_random_uuidv7()`는 작성 시점에 정직한 추측이었습니다(`gen_random_uuid()` v4 패턴 따라 짐). prod 첫 deploy 후 `\df *uuid*` 한 번 했으면 즉시 발견됐을 텐데, *spec source라 spec만 보고 검증을 안 한 게* 원인이었습니다. 모든 ADR이 prod와 한 번 cross-check되어야 하고, *결정 변경(v1.0 → v1.1) 자체*가 spec-driven dev의 정석이라는 점이 교훈이었습니다.

### 4. Uptime Kuma drop — 측정 후 단순화

v1.1까지는 status 머신에 Uptime Kuma 채택(UptimeRobot 무료 ToS 2024-12 commercial 금지 우회). v1.2에서 *blackbox_exporter(Prometheus 진영)가 같은 책임을 native로 수행*한다는 걸 발견하고 drop. Grafana stack이 이미 깔리는데 Uptime Kuma는 redundant였습니다. 외부 vantage가 진짜 필요한 부분(monitor 자체가 죽었을 때)은 Cloudflare Workers cron 1줄로 분리. *결정 변경 자체*가 portfolio 시그널 — 처음부터 정답일 필요 X, 측정 후 단순화 O.

### 5. local-mode 약 80K 라인 정리(2편 본진)

처음 AFFiNE/AppFlowy식 *전체 yjs 통합*으로 시작한 게 Balruno 시트의 *Baserow class* 도메인과 어긋나면서 누적된 부채였습니다. v0.6 cleanup α~ζ.3을 통해 ~80,000 lines local-mode를 정리하고 시트 도메인을 100% server-canonical로 옮겼습니다. *기능을 추가한 commit*보다 *기능을 정리한 commit*이 prod CI green을 유지한 사실이 더 강한 신호입니다.

---

## 최종 아키텍처 + 핵심 수치

### 인프라 + 비용

| 항목 | 매니지드(가설) | OCI 셀프(실측) | 절감 |
|------|----------------|----------------|------|
| 인프라 통합(Vercel + Fly.io + Aurora + Atlas + Datadog) | $155/월 | **$0/월** | **연 $1,860** |
| 인증(Auth0 Pro) | $240/월 | $0(OAuth + nimbus JWT) | **연 $2,880** |
| 인증(Clerk Pro + 100 MAU) | $27/월 | $0 | 연 $324 |
| 모니터링(Datadog Pro 4 host) | $60/월 | $0(Grafana 셀프) | **연 $720** |

### DB

| 항목 | Before | After | 측정 조건 |
|------|--------|-------|-----------|
| 시트 통째 GET p95(1만 건) | MySQL JSON 240ms | **PG JSONB 65ms** | k6 50 VU × 5분, OCI ARM 12GB |
| 시트 내부 키 조회 p95 | MySQL 320ms | **PG GIN 45ms** | `data->>'name' = ?` |
| GIN 인덱스 효과 | p95 280ms | **65ms (4.3배)** | 인덱스 ON/OFF 직접 비교 |
| jsonb_set patch p95 | – | **8ms** | 트랜잭션 단위 측정 |

### 가상스레드 + JVM

| 메트릭 | 가상스레드 OFF | 가상스레드 ON | 변화 |
|--------|----------------|----------------|------|
| HTTP p95 | 320ms | **180ms** | -44% |
| HTTP p99 | 450ms | 240ms | -47% |
| heap | 380MB | **220MB** | -42% |
| 활성 스레드 | 200(플랫폼) | 100(가상) + 8 carrier | – |

### 동기화

| 항목 | 결과 |
|------|------|
| WebSocket 엔드포인트 | `/ws/projects/{projectId}` 단일 통합(시트 셀 + 시트 트리 + 문서 트리 3 영역) |
| 충돌 감지 | baseVersion + LWW + 클라 rollback |
| 재전송 멱등 | clientMsgId UUIDv7 + `op_idempotency` cached 응답 |
| cycle 방지 | application-level BFS, 400 CYCLE_DETECTED |
| cascade delete | application-level recursive + `documents.deleted_at`(30일 hard delete cron) |
| 문서 본문 | yjs CRDT 자동 머지(Hocuspocus Node sidecar + `documents.binary BYTEA`) |

### 무중단 배포

| 항목 | 결과 |
|------|------|
| 옛 in-place 패턴 | 매 deploy 30~60s 502 윈도 |
| nginx blue/green 첫 cutover | **≤21s**(옛 단일 → 새 dual slot 일회성 이행) |
| nginx blue/green 두 번째 cutover부터 | **0s**(prod 실측, 10s 폴링 정확도 안에서 502 윈도 없음) |
| nginx `backup` directive 자동 fail-over | 명시적 swap 로직 없이도 부분 무중단 보너스 |
| 마이그레이션 정책 | expand-contract 강제, destructive는 `[destructive]` 태그 + 별도 deploy slot |

### 코드 베이스

| 항목 | 결과 |
|------|------|
| 시트 도메인 yjs 의존성 | 0(server-canonical 100%) |
| local-mode 정리 | 약 -80,000 lines(ζ.2 -77,496 + ζ.3 -3,411) |
| Spring Modulith arch test | green(`com.balruno.user` 등 모듈 경계 자동 검증) |
| 출하된 ADR | 12개 prod(0004 / 0021 / 0022 / 0024 / 0027~0034 / 0044) |

### 9 영역 점진 진화 트리거(ADR 0010, Stage 0 안 함)

1. Redis 캐시 — 사용자 50명 + Spring p95 > 500ms
2. PG Read Replica — 사용자 500명 + read 부하
3. Load Balancer + 다중 prod-app — 사용자 500명 + Spring CPU > 70%
4. Geo-redundant Backup(cross-region) — paying user 등장
5. OpenTelemetry Distributed Tracing — 사용자 50명
6. DR Drill — paying user 등장
7. Secret Rotation(Vault) — 사용자 100명
8. Async Queue(Kafka/RabbitMQ) — 사용자 500명
9. WAF Pro — 봇 트래픽 발견

---

## 마무리

Balruno는 *발명*이 아니라 *조합*으로 풀린 프로젝트였습니다. Baserow의 시트 cell event + Linear의 트리 op log + Outline의 문서 본문 yjs/Hocuspocus + Notion의 PG JSONB block 모델 + Spring Security 7의 OAuth 2.1 default + OCI Always Free + Cloudflare R2 — 각각이 5년+ 검증된 OSS 다수파였고, 1인 OSS의 안전한 길은 *각 도메인 표준을 존중하면서, 도메인 차이가 드러나는 한 점에서만 분기*하는 것이었습니다.

그 한 점이 *시트가 Baserow class다*라는 인식이었고, 이 분기 위에서 약 80K 라인 local-mode 정리, 시트 도메인 100% server-canonical 전환, 3 영역 통합 sync, 무중단 배포, 셀프 호스트 인프라가 차례대로 풀렸습니다. paying user 0 시점에 매니지드 통합 대비 연 $5,460 절감(인프라 $1,860 + 인증 $2,880 + 모니터링 $720) + 데이터 통제권 100% + 운영 자동화 시그널까지 함께 확보했고, 이 모든 결정의 추적성이 74개 ADR로 살아있는 문서로 남아 있습니다.

<!-- EN -->

## Project Overview

Balruno is an **open-source collaborative spreadsheet + document workspace specialized for game balancing**. Character stats, weapon values, level curves, drop/gacha probabilities — domains that naturally fall into a table — are taken in directly, then connected to real-time collaboration and game-engine export (C# struct, Unity Assets/ drop) in a single flow.

- **Duration**: Jan 2026 — In Progress
- **Type**: Solo open-source SaaS (client MIT, backend AGPL v3)
- **Demo**: [balruno.com](https://balruno.com)

### Data Regions

| Region | Location | Change frequency | Conflict frequency | Pattern |
|--------|----------|------------------|--------------------|---------| 
| Sheet cells | `projects.data JSONB` → `sheets[].rows[].cells[]` | Very high | Medium | cell event op log |
| Sheet tree | `projects.sheet_tree JSONB` | Medium | Low | tree op log |
| Doc tree | `projects.doc_tree JSONB` | Medium | Low | tree op log |
| Doc body | `documents.binary BYTEA` (yjs) | Very high | Auto-merge | yjs CRDT (Hocuspocus) |

### Stack

- Backend: Java 25, Spring Boot 4.0.6, Spring Security 7, Hibernate 7.2, Spring Modulith 1.4
- DB/Storage: PostgreSQL 18.3 (JSONB + GIN + native UUIDv7), Cloudflare R2 (S3-compatible offsite backup)
- Realtime: Spring WebSocket (cells + trees), Hocuspocus + yjs (doc bodies)
- Frontend: Next.js 16 + React 19, Electron 41, Tiptap, TanStack Virtual, y-indexeddb
- Infra/DevOps: OCI Always Free 4 hosts (ARM 12GB ×2 + x86 1GB ×2), Ansible 8 roles, Nginx + Cloudflare (proxy + Tunnel + 15-year Origin Cert + R2)
- Observability/Test: Prometheus + Loki + Alloy + Grafana + InfluxDB + blackbox_exporter, Sentry SaaS, k6 + JUnit 5 + Testcontainers

---

## 1. DB Choice — Taking the Sheet Domain Directly with PostgreSQL JSONB

The core question wasn't *which DB has the most features* but *which storage model takes the natural unit of "a sheet" with the least friction*. Normalising 1 cell → 1 row would turn a 1000×30 sheet into 30,000 rows, and a single sheet GET would unfold into a multi-stage JOIN or N+1 risk.

The same CRUD API was wired to MySQL 8 + JSON, PostgreSQL 18 + JSONB, and MongoDB 7 on the same OCI ARM 12GB monitor host (same VCN, ≤1ms internal). With k6 (50 VU, 5 min) writing to InfluxDB 2.x and a single Grafana dashboard registering both Prometheus (live) and InfluxDB (load) data sources, the measurements were:

| DB | Sheet GET p95 (10K) | Internal key lookup p95 |
|----|----------------------|--------------------------|
| MySQL 8 + JSON | **240ms** | 320ms (generated column) |
| **PostgreSQL 18 + JSONB** | **65ms** | **45ms (GIN native)** |
| MongoDB 7 | 95ms | 60ms |

PG JSONB was about 3.7× faster than MySQL JSON on sheet GET. The structural reasons were (1) JSONB binary storage (no parsing per query), (2) one GIN index covering the *entire* JSON tree, and (3) `jsonb_set(data, path, value)` enabling per-cell partial patches that match the cell-event WebSocket exactly. Same-domain references (Notion 200B+ blocks on PG, Linear on PG, Outline `documentStructure` JSONB tree) confirmed the choice. Aurora MySQL ~$80/mo + Mongo Atlas ~$25/mo became OCI self-hosted PG **$0/mo** — yearly savings of $960~$1,200 plus full data control.

Final model: 3 JSONB columns + 3 version columns in the same `projects` row. Single transaction guarantee for cross-region writes; independent versions so a conflict in one region doesn't block another. Document bodies stay as `documents.binary BYTEA` (yjs) consumed by Hocuspocus' extension-database adapter.

---

## 2. Why Sheets Were Lifted Out of yjs — The 80K-Line Cleanup

The initial structure inherited the AFFiNE/AppFlowy "everything yjs" pattern. Two structural mismatches surfaced when migrating to a server-canonical model.

First, **domain mismatch**. AFFiNE/AppFlowy spreadsheets are *Notion-class* (small embedded tables in a doc), where Y.Map auto-merge is natural. Balruno sheets are *Baserow-class* — 16 column types + mathjs 70+ game functions + Monte Carlo simulation + Unity C# struct export — and yjs CRDT auto-merge could produce merges that *contradict the designer's intent* on top of external simulation/engine integrations.

Second, **Java ecosystem gap**. y-crdt's Java binding has been incomplete since GitHub issue #217 (2022), so server-side validation/persistence/promotion in Java would require a hand-rolled implementation — a six-month trap. Even introducing Hocuspocus as a Node sidecar would split the sheet sync stack between Spring and Node.

A 4-region × 2-pattern mapping became the answer: sheet cells (Baserow cell event) + sheet tree (Linear sync engine op log) + doc tree (Linear op log) + doc bodies (Outline yjs/Hocuspocus). The Y.Doc retirement spanned α through ζ.3:

- α–ε: docSlice unified to direct setState, UndoManager adapter to no-op, `useYDocSync.ts` and `getWebrtc` removed.
- ζ.1: 17 unreferenced ydoc exports — 1402 → 1075 lines (-23%).
- ζ.2: 294 reachability-dead files — **-77,496 lines**.
- ζ.3: `lib/ydoc.ts` itself + sticker/changelog audit (zero UI consumers) — **net -3,411 lines**.

About **~80,000 lines** of local-mode code retired. Sheet domain is now 100% server-canonical, with yjs surviving only in the doc-body Hocuspocus path. Each stage was gated by `tsc --noEmit` green, vitest 9/10 file pass / 82/82 tests, prod CI green, and manual prod smoke (sheet add / cell edit / doc add / doc rename / drag-drop).

---

## 3. Realtime Sync — Baserow + Linear + Outline Combined

A single WebSocket endpoint `/ws/projects/{projectId}` handles all three regions. Per-message `baseVersion` (per-region version) + `clientMsgId` (UUIDv7) drive LWW conflict detection and idempotent retry. The server transaction is one Spring `@Transactional`:

1. `SELECT ... FOR UPDATE` on the project row — reads all 3 versions at once.
2. `baseVersion` check (region-specific) — mismatch → ROLLBACK + conflict response.
3. `op_idempotency` lookup by `clientMsgId` — hit → return cached `op.acked`.
4. Cycle check (only on `tree.move`) — application-level BFS over the JSONB tree.
5. `jsonb_set` patch + `version++`.
6. `INSERT INTO op_idempotency (..., scope_kind, scope_id, ...)`.
7. Cascade delete (only on `tree.delete`) — recursive descendants + `documents.deleted_at` soft delete.
8. Broadcast to remaining sessions (sender excluded).

Why baseVersion + jsonb_set + idempotency rather than DB lock / Redis INCR / message queue: this isn't a single-integer counter (Redis INCR's sweet spot) — it's per-position partial patches across a JSONB tree, where the row-level `FOR UPDATE` already keeps the lock surface small (1 project = 1 row). Cycle prevention is application-BFS rather than PG CTE recursive because JSONB tree walks differ from row-based parent/child trees and Spring code is simpler to reason about.

Functional accuracy (conflicts / idempotency / cycle / cascade) is verified by `SheetCellOpServiceTest` + `TreeOpServiceTest`. Load measurements (broadcast latency p95, op_idempotency miss ratio, conflict rate) are deferred to a *real-traffic regression incident* — synthetic 100 VU baselines on a near-empty service can't fill the (2)(3) phases of the 5-step framework, and the regression event itself becomes the source data.

---

## 4. Infrastructure — OCI 4 Hosts + Ansible + Cloudflare + Observability

Managed-stack baseline (Vercel Pro $20 + Fly.io $5 + Aurora $50 + Atlas $25 + Datadog $60) totalled **$155/mo = $1,860/yr** at paying-user 0 — an unfit cost curve for solo OSS. The replacement: OCI Always Free 4 hosts (ARM Ampere A1 2 OCPU × 12GB ×2 + x86 E2.1.Micro 1 OCPU × 1GB ×2) on the same VCN (10.0.0.0/24, ≤1ms internal) + free Cloudflare (proxy + 15-year Origin Cert + Tunnel + R2 10GB).

Role distribution: prod-app (Spring + Nginx + Hocuspocus, ~3GB), monitor (PG 18 + Grafana stack, ~5GB), backup (pg_dump rsync + cloudflared + node_exporter, ~480MB), status (R2 upload daemon + node_exporter, ~150MB). The 1GB hosts deliberately do **not** carry monitoring (Loki ~1.5GB, Prometheus WAL replay 2-3× spike, Grafana recommended 4GB — community evidence of OOM kills); ARM 12GB consolidation is the OCI Ampere A1 norm.

Ansible 8 roles + a single GitHub Actions workflow (PR check + main push apply, 1 vault-password GitHub Secret) bring all 4 hosts up via `ansible-playbook -i inventory.yml site.yml`. The 3-2-1 backup chain runs monitor pg_dump → backup rsync → status R2 upload (cross-cloud, S3-compatible) and was validated end-to-end at 2 seconds.

The observability stack is fully self-hosted: Prometheus (live ops metrics) + Loki (logs, ~512MB vs Elasticsearch ~2GB) + Alloy (log shipper, since Promtail went maintenance-only in 2024) + InfluxDB 2.x (k6 load results, kept *separate* from Prometheus to avoid high-cardinality contamination) + blackbox_exporter (HTTP/TLS/TCP probes, replacing the earlier Uptime Kuma plan once it became redundant) + Grafana (single pane). Datadog Pro $15/host × 4 = $720/yr saved.

The first measurements that became real portfolio source data:

- **Virtual threads on cell.update WebSocket (100 concurrent)**: p95 320ms → 180ms (-44%), heap 380MB → 220MB (-42%).
- **JSONB GIN on sheet GET (10K rows)**: p95 280ms → 65ms (4.3×), p99 410ms → 110ms.

Zero-downtime deploy followed (ADR 0044). Replacing `docker compose pull && up -d`'s 30~60s 502 window, two `nginx` upstream snippets (`-blue.conf` / `-green.conf`) under `/etc/nginx/snippets/` are exposed via a single symlink `/etc/nginx/conf.d/balruno-backend-active.conf`. Cutover: `ln -sfn` the alternate snippet + `nginx -s reload` (graceful — old workers drain inflight requests; `worker_shutdown_timeout 30s` defends WS retention). Readiness probes drive the swap (liveness only proves the process is alive; readiness gates DB connection + cache warm-up). DB migrations enforce expand-contract; destructive changes are tagged `[destructive]` and run on a separate slot.

Production measurement (2026-05-10): first cutover (single → dual-slot transition) ≤21s, every subsequent cutover **0s** within 10s polling resolution. Bonus discovery — `nginx`'s `backup` directive auto-fails over even before the explicit symlink swap, providing a partial zero-downtime safety net for free.

---

## 5. Auth — OAuth-only + JWT (HS256 → RS256 reserved)

Self-rolled passwords are a 7-stage chain (policy + bcrypt round-12 ~250ms CPU/req + DB + reset email + bounce handling + leak monitoring + 2FA), and a single broken stage invalidates the whole chain. Managed auth (Auth0 Pro $240/mo, Clerk Pro $25/mo + per-MAU) doesn't fit the paying-user-0 cost curve. Balruno's persona (developers/designers, GitHub 80%+ + Google 100%) makes OAuth-only nearly friction-free.

JWT algorithm follows verifier count: HS256 (symmetric 32B, ~1µs sign/verify, single-secret) is correct while there's only one verifier. Phase B-5's Hocuspocus Node sidecar will introduce a second verifier — sharing the HMAC secret would unintentionally grant the sidecar issuance capability, so the migration to RS256 (asymmetric, JWKS endpoint, public-only on sidecar/frontend) is reserved for that point.

Token storage is dual: httpOnly cookie (`Domain=balruno.com`, SameSite=Lax) for browsers + `Authorization: Bearer` for Electron / mobile / CLI, unified by a `BearerTokenResolver` that tries the header first and falls back to the cookie. GitHub / Stripe / Linear all use this pattern.

Verified-email auto-link uses a sealed interface with 4 cases (Notion / Linear / Vercel pattern). Case 2 — *provider didn't mark email as verified, but a user with the same email already exists* — is rejected to block account takeover (an attacker registering an unverified GitHub email with the victim's address would otherwise auto-link). GitHub's `/user/emails` is filtered to `primary == verified == true`; Google OIDC's `email_verified` claim provides this directly. Refresh tokens are DB rotation chains (BYTEA hash + prev_id) so revoke is instant; Redis comes in at the Stage 1+ trigger.

Cost outcome: Auth0 vs self-hosted = $2,880/yr saved, Clerk vs self = $324/yr, plus 0 lock-in.

---

## 6. Feature Layer — 12 Shipped ADRs

The differentiator from a Notion clone:

- **Persistent server-backed undo** (ADR 0021 v3.0 phase 5) — Cmd+Z survives refresh within 120 min (Baserow `MINUTES_UNTIL_ACTION_CLEANED_UP`), per-tab isolation via `clientSessionId`, 30s/20-op action grouping. Diff baseline picker reuses `op_idempotency.inverse_payload` backward replay — no separate snapshot infra.
- **10 view types** (ADR 0022 v2.1) — Grid · Form · Kanban · Calendar · Gallery · Gantt · **Heatmap · Curve · Probability · Diff**. The last 4 are game-balance specific and don't exist in Notion / Airtable / Baserow. Every view switch and drag-drop broadcasts to peers via the server-canonical sync.
- **Comments + @mentions + notifications** (ADR 0024 v2.4) — sheet cells + doc body range-anchored highlights (Tiptap Decoration plugin), 1-level reply threads (Slack/Linear pattern), email + Web Push (VAPID, RFC 8030 + 8292), daily/weekly digests.
- **Webhooks** — outbound (ADR 0028, HMAC-SHA256 POSTs decoupled via ApplicationEvent so the Spring Modulith arch test stays green), inbound GitHub PR/issues + generic (ADR 0029).
- **Discord slash commands** (ADR 0030) — Ed25519-verified `/v1/discord/interactions`.
- **Stripe billing** (ADR 0004), **share links** (ADR 0027), **project-wide search** (ADR 0031, Cmd+K + 200ms debounce), **workspace audit log** (ADR 0032), **Unity export** (ADR 0033, CSV RFC 4180 + BOM + C# struct), **GDPR + PWA** (ADR 0034).

---

## 7. Failures and Lessons

- **Five silent failures in Phase B-2**: SB4 autoconfig split (no `flyway-schema-history`), ADR vs runtime drift (`gen_random_uuidv7()` vs the GA `uuidv7()`), Tomcat 11 RFC 6265 strict cookie (leading-dot `Domain` rejected), Hibernate `@UuidGenerator(style=TIME)` actually emitting UUIDv1, docker-compose `env_file` permissions (compose CLI parses client-side as the user, not the daemon's root). Common pattern: `catch (RuntimeException)` swallow hid the real cause until logging was added — *every catch must log the stack trace* is the baseline for a self-host SaaS.
- **Inspect the underlying once for every abstraction.** Faults 1, 4, 5 all hid behind a layer (autoconfig, annotation name, compose CLI). 5 minutes of `\dt`, hex dump, `ls -la` would have killed each one earlier.
- **Spec → verify → correct cycle.** ADR 0012 v1.0 was an honest guess written when PG 18 was still RC. The lesson isn't "don't guess" — it's "every ADR must be cross-checked against prod once after first deploy", and *the v1.0 → v1.1 amendment itself is the credibility signal*.
- **Uptime Kuma drop (v1.1 → v1.2).** Adopting Uptime Kuma was valid (UptimeRobot's commercial-use ToS change in 2024-12), but `blackbox_exporter` in the existing Grafana stack covered the same responsibility natively. Removing a tool *because measurement showed it was redundant* is itself a portfolio signal — first answers don't have to be final.
- **~80K lines of local-mode retired.** The original AFFiNE/AppFlowy "everything yjs" path collected as debt once Balruno's *Baserow-class* sheet domain came into focus. The cleanup commits keeping prod CI green is a stronger signal than the feature commits.

---

## Closing

Balruno was less invention and more **composition**. Baserow cell events + Linear op logs + Outline JSONB doc trees + Notion's PG JSONB block model + Spring Security 7's OAuth 2.1 defaults + OCI Always Free + Cloudflare R2 — each backed by 5+ years of OSS validation. The single inflection point was recognising that *sheets here are Baserow-class, not Notion-class*; everything downstream — the 80K-line cleanup, the server-canonical migration, the 3-region unified sync, the zero-downtime cutover, the self-hosted infrastructure — followed from that one branch. At paying-user 0 the stack saves $5,460/yr versus managed (infra $1,860 + auth $2,880 + observability $720) while keeping full data control and operational-automation signal, and 74 ADRs preserve every decision's traceability.

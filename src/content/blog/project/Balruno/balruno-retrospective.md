---
title: 'Balruno MVP 후기'
titleEn: 'Balruno MVP Retrospective'
description: 게임 밸런싱 스프레드시트 + 문서 워크스페이스 Balruno의 백엔드 설계와 운영을 한 글에 정리합니다. PostgreSQL JSONB 채택(MySQL JSON 240ms vs PG 65ms 직접 측정), 시트 셀 + 시트 트리 + 문서 트리 3 영역 통합 동기화 알고리즘(Baserow + Linear + Outline 합본), OCI Always Free 4대 + Ansible 자동화 + Cloudflare R2 3-2-1 백업으로 매니지드 대비 연 $1,860 절감, OAuth-only + 자체 발급 JWT(Auth0 대비 연 $2,880 절감), Grafana + Loki + Alloy + Prometheus + InfluxDB 셀프 호스트 모니터링(Datadog 대비 연 $720 절감), nginx blue/green 무중단 배포(첫 cutover 21초 → 두 번째부터 0초), 시트 도메인 100% 서버 진실원 전환(약 80,000 라인 정리)까지 포함합니다.
descriptionEn: A retrospective of Balruno — a game-balancing spreadsheet + document workspace built solo. Covers PostgreSQL JSONB adoption (MySQL JSON 240ms vs PG 65ms, measured directly), unified 3-region sync (sheet cells + sheet tree + doc tree) combining Baserow + Linear + Outline patterns, OCI Always Free 4-machine self-host with Ansible ($1,860/yr saved vs managed), OAuth-only + self-issued JWT ($2,880/yr saved vs Auth0), self-hosted observability with Grafana/Loki/Alloy/Prometheus/InfluxDB ($720/yr saved vs Datadog), nginx blue/green zero-downtime deploy (21s first cutover, 0s thereafter), and the server-canonical migration that retired ~80K lines of local-mode code.
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

Balruno는 **게임 밸런싱 도메인에 특화된 협업 스프레드시트 + 문서 워크스페이스**예요. 캐릭터 스탯, 무기 수치, 레벨 곡선, 드롭/가챠 확률처럼 게임 기획 데이터가 자연스럽게 표 안에 모이는 영역을 그대로 받아내고, 실시간 협업과 게임 엔진 export(C# struct, Unity 프로젝트 폴더에 그대로 드롭)까지 한 흐름으로 묶는 게 목표였어요.

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

구현에 들어가기 전 *어떻게 만들지*보다 *무엇을 만들지*부터 먼저 정리했어요.

- 시트 단위 read/write가 자연 단위. 셀 1개당 1요청을 만들지 않고, 디자이너가 30분 깊이로 작업하는 흐름을 작은 호출로 부수지 않을 것.
- 동적 컬럼: 사용자가 16종 중 임의 선택, 미리 정의된 스키마 없음.
- 동시 편집: 같은 셀이나 같은 트리 노드에 두 사용자가 부딪혀도 데이터 손실이 없을 것.
- 게임 도메인 함수 70여 개(DPS, EHP, TTK, SCALE, DIMINISH 등) 지원.
- Export: CSV(RFC 4180 + BOM)와 C# `[Serializable]` struct로 Unity 프로젝트에 그대로 드롭.

비기능 쪽도 마찬가지로 미리 숫자로 박아뒀어요.

- 처리 규모: 사용자 100명까지 단일 인스턴스로 충분.
- 응답 시간 목표: 시트 통째 GET p95 500ms 이하.
- 데이터 진실원: 서버 PostgreSQL이 정답. 클라 IndexedDB는 즉각 반응을 위한 캐시(Linear / Notion / AFFiNE Cloud의 최신 모델).
- 비용: 매니지드 0원, 무료 인프라만. 사용자/부하 트리거가 떨어지면 그때부터 캐시·읽기 복제본·로드밸런서·지역 백업 등을 *단계적으로만* 도입.
- 일관성: 시트 셀과 트리는 *마지막 쓰기 우선(LWW) + 버전 비교*, 문서 본문은 yjs CRDT 자동 머지.

### 설계 전에 분기를 미리 그어둔 곳

요구사항을 정리한 뒤에는 어떤 기술을 쓸지보다, 어떤 구조가 가장 단순하고 합리적인지를 먼저 판단했어요.

첫째, 시트와 문서를 한 가지 동기화 모델로 묶을지 정해야 했어요. AFFiNE이나 AppFlowy처럼 모든 도메인을 yjs로 묶는 패턴이 가장 단순하지만, Balruno의 시트는 mathjs 70여 개 게임 함수 + 몬테카를로 시뮬레이션 + Unity 엔진 export까지 외부 영역이 깊은 *Baserow 계열* 시트라서 yjs 자동 머지가 부적합하다고 봤어요. 시트는 셀 이벤트 기반 op log, 문서 본문만 yjs로 분리하는 게 더 자연스러웠어요.

둘째, 정형 RDBMS로 시트를 정규화할지, JSON 친화적 저장으로 갈지를 봤어요. 셀 1개당 row 1개로 정규화하면 1,000행 × 30컬럼 시트가 30,000 row가 되고, 시트 GET 한 번이 거대한 JOIN이나 N+1 위험으로 풀리는데, 시트가 통째로 자연 단위인 이 도메인에서는 그 비용이 합리적이지 않았어요. 그래서 메타데이터만 정규화하고 시트 본문은 JSONB 한 컬럼에 통째로 넣기로 했어요.

셋째, 1인 OSS로 운영해야 하니 매니지드 통합($155+/월)을 그대로 받지 않고 OCI Always Free + Cloudflare 무료 + R2 무료 조합으로 비용을 0으로 맞추되, 사용자가 늘면 그때 단계별로만 옵션을 추가하는 진화 매트릭스를 미리 그렸어요.

---

## 1. DB 선택 — PostgreSQL JSONB로 시트 도메인을 직접 받기

### 시트 데이터의 특성

시트 단위 저장이 자연 단위였어요. `Sheet`는 16종 컬럼 + 평균 100~1,000행 + 부가 데이터로 구성되고, 셀 값은 문자열/숫자/null/수식 결과/링크 참조가 섞인 동적 구조예요. 클라이언트 쪽 직렬화 결과가 이미 JSON 안전했고, 시트 1개 평균 JSONB 크기는 약 50KB, 프로젝트 1개당 약 500KB 수준이었어요.

### 정규화 vs JSON 친화

질문은 *기능이 가장 많은 DB가 무엇인가*가 아니라 *시트라는 자연 단위를 가장 단순하게 받아낼 수 있는 저장 모델이 무엇인가*였어요. 셀 1개당 row 1개로 풀어버리면 시트 1개(1,000 × 30)가 30,000 row가 되고 시트 GET 한 번이 다단계 JOIN이나 N+1 위험으로 풀려요. 동적 컬럼 16종 각각의 검증과 인덱싱을 정규 테이블에서 받는 비용도 컸어요.

### 왜 MySQL JSON으로는 부족한가

MySQL 5.7+의 JSON 타입은 시트 도메인에 대해 두 가지 구조적 한계를 갖고 있었어요.

첫째, JSON을 *텍스트*로 저장해요(8.0에서 binary가 도입됐지만 인덱싱 측면에서는 여전히 한계예요). 매 쿼리마다 JSON 파싱 비용이 들어가고, GIN 같은 네이티브 JSON 인덱스가 없어서 generated column으로 우회해야 해요.

```sql
ALTER TABLE projects ADD COLUMN sheet_name VARCHAR(255)
  GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(data, '$.name'))) VIRTUAL;
CREATE INDEX idx_projects_sheet_name ON projects(sheet_name);
```

컬럼 16종 각각에 인덱스가 필요하면 16개 generated column이 따라붙고, 컬럼 타입을 한 종류 추가할 때마다 마이그레이션이 폭발하는 구조였어요.

둘째, 부분 patch 연산이 약했어요. 셀 이벤트 WebSocket이 들어올 때마다 시트 통째를 다시 쓰는 게 아니라 `data->'sheets'->0->'rows'->42->'cells'->'col_id'` 한 점만 patch해야 효율적인데, MySQL `JSON_SET`도 가능은 했지만 인덱스/통계 갱신 차원에서 PostgreSQL의 `jsonb_set` + GIN 조합이 훨씬 자연스러웠어요.

### 후보 7개를 직접 측정해봤어요

같은 CRUD API를 MySQL 8 + JSON, PostgreSQL 18 + JSONB, MongoDB 7 세 곳에 각각 연결해 직접 측정했어요. 호스트는 OCI ARM 12GB 머신, 클라이언트는 같은 가상 네트워크의 다른 머신(서로 1ms 이내), 부하 도구는 k6(50 가상 사용자, 5분), 결과 저장은 InfluxDB, 시각화는 Grafana 한 대시보드(Prometheus + InfluxDB 데이터소스 동시 등록)로 묶었어요.

시트 통째 GET p95 (1만 건):

| DB | p50 | p95 | p99 | 인덱스 |
|----|-----|-----|-----|--------|
| MySQL 8 + JSON | 80ms | **240ms** | 380ms | generated column + B-Tree |
| **PostgreSQL 18 + JSONB** | **22ms** | **65ms** | 110ms | **GIN(네이티브)** |
| MongoDB 7 | 35ms | 95ms | 140ms | 자동 인덱스 |

시트 내부 키 조회(`data->>'name' = ?`):

| DB | p95 | 비고 |
|----|-----|------|
| MySQL 8 | 320ms | generated column 우회 |
| **PostgreSQL 18 JSONB** | **45ms** | GIN 직접 |
| MongoDB | 60ms | path 인덱스 |

PostgreSQL JSONB가 시트 GET에서 MySQL 대비 약 3.7배 빨랐고, 그 차이는 (1) JSONB의 binary 저장(파싱 0), (2) 한 GIN 인덱스로 *전체 JSON 트리* 인덱싱, (3) `jsonb_set(data, path, value)`로 셀 단위 부분 patch가 가능하다는 점에서 나왔어요.

후보 7개 평가도 같이 해봤어요. MySQL 정규화는 시트 GET이 N+1로 풀려서 거부, MongoDB 단독은 결제/인증이 별도 RDBMS를 또 요구해서 듀얼 스택이 되는 점에서 거부, MySQL + Mongo 듀얼은 운영 표면적이 2배(백업/모니터링/마이그레이션 도구 모두 ×2) + 크로스 DB 트랜잭션 부재(회원 탈퇴 시 Saga / 2PC 필요) + 비용 약 4배라서 1인 운영에서는 안티패턴이었어요. SQLite 서버는 동시 쓰기가 약하고, yjs 네이티브 저장(y-redis)은 결제·인증 같은 비-시트 데이터를 별도 DB에 또 둬야 했어요.

같은 도메인의 다른 제품들이 어떻게 가는지도 같이 봤어요. Notion은 [PostgreSQL을 32개 데이터베이스 샤드로 운영](https://www.notion.com/blog/the-great-re-shard)하면서 블록 모델을 받아내고 있고, Linear는 PostgreSQL + 정형 스키마, Outline은 `collection.documentStructure`라는 JSONB 트리를 활용하고, Supabase는 Postgres 위 Realtime SaaS를 돌려요 — *블록/문서형 SaaS = PostgreSQL*이 사실상 표준이 되어 있다는 인상을 받았어요.

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

3 영역을 같은 row에 둔 건 단일 트랜잭션 보장을 위해서였고, 버전 컬럼을 따로 둔 건 한 영역(예: 셀 업데이트)의 충돌이 다른 영역(예: 트리 이동)을 차단하지 못하도록 격리하기 위해서였어요. 문서 본문은 `documents.binary` BYTEA(yjs binary)로 분리해서 Hocuspocus의 데이터베이스 어댑터가 그대로 받아쓰도록 했어요.

측정 결과: 시트 통째 GET p95 65ms(목표 500ms 이하 통과), `jsonb_set` patch 트랜잭션 p95 8ms, GIN 인덱스 ON/OFF를 직접 비교해보면 p95가 280ms에서 65ms로 약 4.3배 개선됐어요. 인덱스 크기는 시트 1만 건 기준 50MB로 12GB ARM에서 충분히 여유가 있었어요.

비용 차원에서도 PG 채택이 자명했어요. Aurora MySQL이 가벼운 인스턴스 기준 월 $50 안팎, MongoDB Atlas가 월 $25 안팎인 데 비해 OCI Always Free 위 PostgreSQL 셀프호스트는 **월 $0**이고, 하나의 DB로 결제·인증·시트·yjs binary까지 다 받을 수 있어서 스택이 단순했어요. 매니지드 대비 연 $960~$1,200 절감 + 데이터 통제권 유지가 같이 따라왔어요.

---

## 2. 시트를 yjs에서 떼어내고, 약 80,000 라인을 정리한 이야기

### 처음에는 "전부 yjs"로 시작했어요

초기 구조는 클라이언트 단일(Next.js + Tiptap + yjs + y-indexeddb)이었어요. 시트 셀·행·컬럼 변경이 모두 Y.Doc 위에서 일어나고, 약 1,400 라인짜리 `lib/ydoc.ts` 한 파일이 여러 store에서 import되고 있었어요. AFFiNE / AppFlowy식 *모든 도메인 yjs 통합*을 그대로 따라간 형태였어요.

### 시트가 yjs에 어울리지 않는다

서버 진실원 모델(Linear / Notion / AFFiNE Cloud의 최신 패턴)로 옮기려는 시점에 yjs 통합이 두 가지 한계를 드러냈어요.

첫째 **도메인 차이**. AFFiNE/AppFlowy의 시트는 *Notion 계열*(문서 안에 임베드된 작은 표)이라 yjs Y.Map으로 자연스럽지만, Balruno의 시트는 *Baserow 계열*(16종 컬럼 + 게임 함수 70+ + 몬테카를로 시뮬 + Unity export)이라 외부 시뮬/엔진 통합 영역이 깊었어요. 이런 도메인에서 yjs CRDT 자동 머지는 *기획 의도와 어긋난 머지*를 만들 위험이 컸어요.

둘째 **Java 생태계 미지원**. y-crdt의 Java 바인딩이 미완성(2022년에 열린 이슈 #217 이후 진척이 거의 없어요)이라 서버측 검증·persistence·승격을 Java로 받으려면 직접 구현해야 했고, 이건 6개월짜리 함정이었어요. Hocuspocus를 Node sidecar로 도입하더라도 시트 동기화 진영이 Spring과 Node로 쪼개지는 운영 표면이 늘어났어요.

### 4 영역 × 2 패턴으로 나누기

이 시점에 다른 OSS들이 어떻게 가는지 한 번 더 비교해봤어요.

| OSS | 시트 sync | 문서 sync | 합본? |
|-----|----------|----------|-------|
| AFFiNE / AppFlowy | yjs | yjs | 1 패턴(전체 yjs) |
| Outline | (시트 없음) | yjs + JSONB tree | 2 패턴 |
| Baserow | 셀 이벤트 broadcast(Django Channels) | (문서 없음) | 1 패턴 |
| Notion | block 모델 | block 모델 | 1 패턴 |
| **Balruno** | **셀 이벤트 op log** | **yjs(본문) + 트리 op log** | **2 패턴** |

시트 + 문서를 같이 다루면서 시트가 Baserow 계열인 도메인은 OSS 선례가 0건이었기 때문에, *발명*보다는 *검증된 두 패턴 합본*이 안전한 길이라고 봤어요. Baserow의 시트 셀 이벤트 + Linear sync 엔진의 트리 op log + Outline의 문서 본문 yjs/Hocuspocus를 그대로 갖다 붙이는 구성이었어요.

트리 동시편집 처리도 후보를 비교해봤어요. Outline식 LWW broadcast(버전 없음)는 트리 편집 빈도가 낮은 위키 도메인엔 잘 맞지만 우리는 빈도가 높아서 거부, AFFiNE/AppFlowy식 Y.Map은 시트와 통합한다는 가정 자체에 이미 거부 사유가 들어가 있었고, Linear 식 op log + 버전 비교가 시트 셀 이벤트와 같은 메커니즘으로 통합 가능해서 채택했어요. 트리 walk는 PostgreSQL의 재귀 CTE보다 애플리케이션 BFS가 단순해서 그쪽으로 갔어요.

### Y.Doc을 단계적으로 들어낸 과정과, 약 80,000 라인 정리

준비 단계에서 시트 store를 `Y.Doc → Zustand 직접 setState` 패턴으로 통일하고, undo/redo 어댑터를 stub으로 교체하고, `useYDocSync.ts`를 삭제하고, `lib/ydoc.ts`의 셀/행/컬럼 헬퍼를 제거하고, presence 관련 webrtc 분기까지 정리했어요. 그 위에서 본격 정리 세 번이 이어졌어요.

- **첫 번째 정리**: 17개 미참조 ydoc export를 삭제 — 1,402 → 1,075 라인(-23%).
- **두 번째 정리**: 도달 불가능한 294개 파일을 통째로 삭제. legacy 패널 / 뷰 / 훅 / lib / store 전부 + 관련 테스트까지. **77,496 라인 삭제**.
- **마지막 정리**: `lib/ydoc.ts` 자체 삭제 + 셀 스타일 동기화를 새 wire op로 정리 + UI 소비자가 0이었던 sticker / changelog 도메인 정리 — 순감 **-3,411 라인**.

합쳐서 *시트 영역 약 80,000 라인의 로컬 모드 코드 정리*가 끝났고, 시트 도메인은 100% 서버 진실원이 됐어요. yjs는 이제 *문서 본문* 쪽에서만 살아있어요.

검증은 단계마다 같은 기준으로 잡았어요. `tsc --noEmit` green, vitest 9/10 file pass / 82/82 tests pass, prod CI green, 수동 prod smoke(시트 추가 / 셀 편집 / 문서 추가 / 문서 이름 변경 / drag-drop) 통과. 마지막 정리 후 `grep -r "ydoc\|Y\.Doc" packages/web/src` 결과는 Hocuspocus 관련만 남았어요.

돌이켜보면 *얼마나 많이 추가했는가*보다 *80,000 라인을 지우면서도 prod CI를 한 번도 깨지 않았는가*가 이 단계에서 가장 분명한 신호였어요. 그리고 그 정리가 가능했던 이유는 더 단순해요. AFFiNE/AppFlowy의 "전부 yjs"라는 인기 디폴트를 *도메인 차이(Baserow 계열 시트 vs Notion 계열 시트)*라는 측정 가능한 분기로 떼어놓고 보니, 우리에게는 그게 정답이 아니었다는 걸 받아들일 수 있었어요.

---

## 3. 실시간 동기화 — Baserow + Linear + Outline 합본

### WebSocket 하나로 3 영역을 묶기

처음에는 시트별로 분리된 WebSocket 엔드포인트(`/ws/sheets/{sheetId}`)였는데, 한 사용자가 한 프로젝트 안 여러 시트에 동시 접속하면 N개의 connection이 떠버리는 구조였어요. 통째로 갈아엎고 `/ws/projects/{projectId}` 단일 엔드포인트로 바꾸면서 시트 셀 + 시트 트리 + 문서 트리 3 영역을 같은 메시지 스키마로 처리하도록 했어요. 프로젝트 단위 = 권한 단위 = 사용자 인지 단위와 일치한다는 점이 통합의 자연스러운 근거였어요.

메시지 스키마는 영역 분기를 `treeKind` 필드와 메시지 타입 prefix(`cell.*`, `row.*`, `column.*` vs `tree.*`)로 받고, 모든 메시지는 두 필드를 필수로 가져와요. 하나는 *해당 영역의 현재 버전*인 `baseVersion`, 다른 하나는 클라가 발급하는 UUIDv7 형식의 `clientMsgId`예요.

### 서버 트랜잭션 흐름

서버는 한 메시지를 받으면 다음 단계를 단일 트랜잭션 안에서 실행해요.

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

`baseVersion` 비교가 LWW + 충돌 감지의 1차 방어선이에요. 두 사용자가 동시에 같은 셀을 편집하면 둘 중 늦게 도착한 op는 `baseVersion != current` 조건에서 conflict로 떨어지고, 클라는 전체 상태(`sync.full`)를 다시 받아서 자기 변경을 되돌리고 토스트로 알리는 흐름이에요.

`clientMsgId`는 재연결 시나리오를 방어해요. 클라가 op를 보냈는데 응답 오기 전에 네트워크가 끊기면, 재연결 후 같은 op를 재전송해도 `op_idempotency` 테이블에서 hit되어 캐시된 ack를 돌려줘요. 중복 적용이 0으로 보장돼요.

이 도메인은 *DB 락 / Redis INCR / 메시지 큐* 중 하나를 고르는 문제가 아니라 *baseVersion + 부분 patch + 멱등키*의 3단 조합으로 풀어야 한다고 봤어요. 좋아요 카운터처럼 단일 정수를 증가시키는 게 아니라 문서 트리와 셀의 위치별 부분 patch가 들어오기 때문에 Redis INCR 패턴은 도메인에 맞지 않았어요. `FOR UPDATE` row lock은 비관적 락이긴 하지만 *프로젝트 1 row 단위*라 잠금 범위가 좁고, 시트 셀과 트리가 모두 같은 row를 잡기 때문에 한 영역의 변경이 다른 영역과 같은 트랜잭션 안에서 자연스럽게 직렬화돼요.

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

3 영역 × 시나리오를 한 표로 정리해두는 게 회귀 방지에 효과적이었어요.

| 영역 | 시나리오 | 정책 |
|------|---------|------|
| 시트 셀 | 같은 셀 동시 편집 | LWW + 버전, 늦은 op는 conflict + 클라 rollback + 토스트 |
| 시트 셀 | 행 추가 동시 | row id가 클라 측 UUIDv7 발급이라 충돌 0 |
| 시트 셀 | 컬럼 삭제 + 셀 업데이트 동시 | 컬럼 삭제 우선 → 셀 업데이트 conflict |
| 시트 트리 | 노드 이동 동시 | LWW(늦은 op conflict) |
| 시트 트리 | 자기 자손 밑으로 이동 | 400 CYCLE_DETECTED 즉시 거부 |
| 시트 트리 | 노드 삭제 + 이름 변경 동시 | 삭제 먼저 처리 → 이름 변경 conflict |
| 문서 트리 | (동일 정책) | (동일) |
| 재연결 | 같은 clientMsgId 두 번 | op_idempotency 캐시 응답 |

기능 정확도(충돌 / 멱등 / cycle / cascade)는 단위·통합 테스트로 검증했고, 부하 측정(broadcast 지연 p95 / 멱등 캐시 미스율 / 충돌 빈도)은 *실제 사용자 부하 사고가 발생한 시점*에 채우기로 미뤘어요. 사용자가 거의 없는 환경에서 인공 부하(100 가상 사용자) 베이스라인을 미리 박아두는 건, 회고 글의 "정상 상태 → 문제 → 분석" 흐름의 (정상 상태)와 (문제) 칸을 채우지 못해서 자료로서 가치가 없다고 봤기 때문이에요.

### 문서 본문은 yjs(Hocuspocus)로 따로

문서 본문은 *Tiptap + yjs CRDT 자동 머지*가 도메인에 정확히 맞아서 그대로 두고, Hocuspocus를 Node 22 LTS sidecar로 운영하면서 PostgreSQL 어댑터로 `documents.binary` BYTEA에 영속시켰어요. Hocuspocus의 `onAuthenticate` 훅에서 Spring이 발급한 협업용 단명 토큰(15분)을 검증하는 webhook을 호출해서, Spring과 Hocuspocus가 같은 사용자 신원을 공유하도록 묶었어요.

---

## 4. 인프라 — OCI 4대 + Ansible + Cloudflare + 셀프 호스트 모니터링

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

paying user 0인데 매월 $155 지출 + vendor lock-in + 데이터 통제권 ↓ + 운영 자동화 시그널 X — 1인 OSS의 진짜 변수와 정면으로 충돌했어요.

대안은 OCI Always Free 4대(ARM Ampere A1 2 OCPU × 12GB ×2 + x86 E2.1.Micro 1 OCPU × 1GB ×2) + 같은 가상 네트워크(서로 1ms 이내) + Cloudflare 무료(proxy + 15년 Origin Cert + Tunnel + R2 10GB)였어요.

### 머신 4대 역할 분배

| Hostname | 사양 | 역할 | 메모리 |
|----------|------|------|-------|
| **prod-app** | ARM 12GB | Spring(Docker) + Nginx + Hocuspocus | ~3GB |
| **monitor** | ARM 12GB | PostgreSQL 18 + Grafana + Loki + Alloy + Prometheus + Alertmanager + InfluxDB + blackbox_exporter | ~5GB |
| **backup** | x86 1GB | pg_dump rsync 수신 + cloudflared(monitor 도메인 Tunnel) + node_exporter | ~480MB |
| **status** | x86 1GB | Cloudflare R2 업로드 daemon + node_exporter | ~150MB |

1GB 머신에 모니터링을 박지 않은 건 측정 결과 때문이었어요. Loki 모놀리식이 안정 상태에서 약 1.5GB, Prometheus WAL replay가 일시적으로 2~3배 메모리 스파이크를 일으키고, Grafana 권장이 4GB — 1GB로 분산은 OOM kill이 보장된 안티패턴이었어요(Reddit /r/selfhosted, GitHub 이슈에서 다수 검증). ARM 12GB 통합이 OCI Always Free의 검증된 패턴이고, 1GB 머신은 단일 daemon(R2 업로드, cloudflared)으로만 채워서 안전하게 활용했어요.

### Ansible로 자동화

`ansible/` 디렉토리에 8개 role(`common` / `nginx` / `postgres` / `backend` / `monitoring` / `cloudflared` / `backup` / `object-storage-upload`) + 통합 playbook + GitHub Actions(PR check + main push apply, vault password GitHub Secret 1개)로 구성했어요. `ansible-playbook -i inventory.yml site.yml` 한 번이면 4대를 통째로 셋업하는 구조였어요. 장기적으로 *수동 setup*보다 *playbook 자동화*가 운영 자동화 시그널 측면에서 훨씬 가치가 있다고 봤어요.

### 3-2-1 백업 체인

원칙은 *Primary 1개 + 다른 미디어 1개 + 오프사이트 1개*였어요. 처음부터 큰 인프라를 박지 않고 단계적으로 가는 매트릭스를 그렸어요.

| 시기 | Primary | Secondary | Offsite |
|------|---------|-----------|---------|
| **베타 출시 시점** | monitor의 PG 18 | backup 머신 rsync | **Cloudflare R2**(다른 클라우드, S3 호환) |
| paying user 등장 시 | + 다른 리전(도쿄 / 프랑크푸르트) | | |
| 사용자 1,000명 이상 | + 추가 vendor(AWS S3 / Backblaze B2) | | |

처음에는 OCI Object Storage(서울)로 가려다가 *같은 vendor 안의 redundancy*는 진정한 cross-cloud가 아니라서 Cloudflare R2(egress 0 + S3 호환)로 교체했어요. 첫 cutover 시점에 *monitor의 pg_dump → backup의 rsync → status의 R2 업로드* end-to-end 2초 검증이 통과했어요.

### 모니터링 — Datadog 거부 + 직접 측정 인프라

Datadog Pro $15/host × 4대 = 월 $60 / 연 $720 비용이 *호스트 4대 무료* 정책과 정면으로 충돌했어요. 셀프 호스트로 가되 *단일 화면(single pane of glass)*을 유지하기 위해 Grafana 진영을 통째로 채택했어요.

| 도구 | 역할 | 후보 비교 후 채택 사유 |
|------|------|------------------------|
| **Prometheus** | 운영 메트릭 TSDB | Spring Actuator native + 사실상 표준 |
| **Loki** | 로그 aggregator | 약 512MB, Elasticsearch ~2GB 대비 부담 ↓ |
| **Alloy** | 로그 수집기 | Promtail은 [2025-02 LTS 전환 + 2026-03 EOL 발표](https://grafana.com/blog/2025/02/13/grafana-loki-3.4-standardized-storage-config-sizing-guidance-and-promtail-merging-into-alloy/), 신규는 Alloy로 시작이 정석 |
| **InfluxDB 2.x** | k6 부하 결과 TSDB(분리) | 부하 결과의 high-cardinality 시계열이 운영 Prometheus 오염 방지 |
| **blackbox_exporter** | 내부 HTTP/TLS/TCP probe + 알람 | Uptime Kuma의 대안으로 자기 자신을 명시(redundant) |
| **Grafana** | 단일 대시보드 | 4 데이터소스 한 화면 |

운영 메트릭과 k6 부하 결과를 *다른 TSDB에 분리 저장*한 이유는, k6 결과가 매 가상 사용자의 매 요청마다 시계열을 만들어내는 *high-cardinality* 부하라서 운영 Prometheus에 그대로 들어가면 카디널리티 폭발이 일어나기 때문이에요. Grafana 데이터소스 두 개를 같은 대시보드에 등록하면 *부하 발생 시점의 JVM heap / GC / DB 커넥션 풀 변화*를 한 화면에서 추적할 수 있었어요.

이 인프라 위에서 첫 측정 두 가지가 의미 있는 출처 데이터가 됐어요.

**가상 스레드 효과**(셀 업데이트 WebSocket 100 동시 부하):

| 메트릭 | 가상 스레드 OFF | 가상 스레드 ON |
|--------|----------------|----------------|
| HTTP p95 | 320ms | **180ms** |
| HTTP p99 | 450ms | **240ms** |
| 활성 스레드 | 200(플랫폼) | 100(가상) + 8 carrier |
| heap 사용 | 380MB | **220MB** |

**시트 GET p95**(`projects.data` JSONB 1만 건):

| 시나리오 | p50 | p95 | p99 |
|---------|-----|-----|-----|
| GIN 인덱스 없음 | 45ms | 280ms | 410ms |
| GIN 인덱스 적용 | 12ms | **65ms** | 110ms |

이 두 표가 단순한 자랑이 아니라 *도입 근거*로 쓰이는 이유는, 가상 스레드든 GIN 인덱스든 결국 "도입했다"는 말 옆에 *어떤 환경에서 측정해서 얼마가 어떻게 줄었는지*가 같이 와야 의미가 생기기 때문이에요. 셀프 호스트 모니터링이 깔려 있지 않았다면 이 수치 자체가 나올 수 없었고, 그래서 1절(DB 선택)에서의 직접 측정과 이 절은 같은 결을 공유해요. 처음에 채택했다가 며칠 뒤 drop한 도구도 있었어요. Uptime Kuma를 외부 health probe 용도로 채택해뒀는데, 이미 깔린 Grafana 진영에 같은 책임을 native로 수행하는 blackbox_exporter가 있다는 걸 발견하고는 redundant라고 판단해서 떼어냈어요. 처음부터 정답을 고를 필요는 없고, 측정 후 단순화하는 사이클이 보이는 게 한 번에 정답을 찍은 이력보다 더 강한 신호라고 봤어요.

### 무중단 배포 — nginx blue/green + readiness probe

`docker compose pull && up -d`라는 in-place 패턴은 매 배포마다 30~60초 502 윈도가 떨어지는 구조였어요. Spring HEALTHCHECK `start_period: 60s` + smoke 12회 × 5초 polling으로 다운타임을 인지하고 기다리는 방식이긴 했지만, 베타 사용자가 늘기 전에 무중단 cutover를 학습해두는 게 ROI가 좋다고 봤어요.

대안 비교:

| 후보 | 거부 사유 |
|------|-----------|
| Kamal | Kamal-proxy가 nginx 자리를 차지 → Cloudflare Origin Cert 이전 + Ansible 일부 폐기 필요. nginx 직접 방식 대비 도입 시간 비용이 큼 |
| Kubernetes | etcd / control plane / 네트워크 플러그인 운영 부담이 zero-downtime 이익을 압도. 사용자 1,000명+ 단계 도구 |
| 두 컨테이너 항상 공존 + weight 분산 | RAM 상시 +2.5GB. 무료 인프라에서 비상 자산을 유지하는 게 우선. 카나리는 사용자 1,000명+ 시점 별도 검토 |

nginx 직접 blue/green을 선택한 건 Cloudflare Origin Cert + 기존 Ansible 인프라 자산을 그대로 보존할 수 있어서였어요.

```
backend-blue     → 127.0.0.1:8080
backend-green    → 127.0.0.1:8081
hocuspocus-blue  → 127.0.0.1:1234
hocuspocus-green → 127.0.0.1:1235
```

snippet 두 개(`upstream-blue.conf`, `upstream-green.conf`)를 `/etc/nginx/snippets/`에 두고, `/etc/nginx/conf.d/balruno-backend-active.conf`를 둘 중 하나의 symlink로 노출하는 구조예요. cutover는 `ln -sfn`으로 symlink를 갈아 끼우고 `nginx -s reload`(graceful — 인플라이트 요청이 끝날 때까지 옛 worker가 살아있어요)를 호출해요. 디버깅은 `readlink` 한 줄로 현재 active 색깔을 볼 수 있어요.

readiness probe를 쓰는 이유: liveness는 *프로세스 살아 있나*만 확인하니까 DB 연결과 캐시 워밍 전에도 200을 돌려주지만, readiness는 *트래픽 받을 준비가 됐나*라서 DB 연결 + init 완료 후에만 200을 줘요. cutover 정확성 차원에서는 readiness가 정답이었어요.

DB 마이그레이션은 expand-contract 강제: NOT NULL 컬럼 추가 시 nullable + default로 추가(구버전이 안 깨짐) → 신버전 코드가 새 컬럼 사용 → 다음 배포에서 NOT NULL 강제. 컬럼 drop이나 타입 변경 같은 파괴적 변경은 별도 슬롯(in-place 다운타임 허용)으로 분리하고, PR에 `[destructive]` 태그를 붙이도록 했어요.

실측(2026-05-10):

```
첫 cutover (옛 단일 컨테이너 → 새 dual slot 이행)
05:33:30  api.balruno.com=502      ← 다운타임 시작
05:33:51  api.balruno.com=200      ← 회복 (≤ 21초)

두 번째 cutover (workflow_dispatch normal mode, green active → blue)
05:38:45 ~ 05:39:41  모든 폴링 200      ← 다운타임 0초
```

첫 cutover 21초는 옛 단일 컨테이너에서 새 dual slot으로 이행하는 일회성 비용이었어요. 두 번째부터는 zero-downtime 가정이 prod 실측으로 입증됐고, 보너스로 nginx `backup` directive의 자동 fail-over 안전망까지 발견했어요(우리가 명시적으로 swap하기 *전에도* 부분적으로 무중단이 일어났어요).

---

## 5. 인증 — OAuth-only + 자체 발급 JWT(HS256, 미래에 RS256 예약)

### 자체 비밀번호의 진짜 비용

자체 ID + bcrypt + SMTP 패턴은 7단계 chain이에요 — *비밀번호 정책 + bcrypt(라운드 12면 요청당 약 250ms CPU, 가상 스레드라도 회피 불가) + DB + 비밀번호 재설정 메일(SES $0.10/1,000 또는 SendGrid 월 $19.95) + bounce 처리 + 누출 모니터링 + 2FA*. chain의 어떤 단계 하나만 깨져도(예: SMTP가 다운되면 비밀번호 재설정 자체가 막혀요) 전체가 무효예요. 1인 OSS가 이 chain 전체를 운영하는 건 *모든 책임을 떠안기*라 안티패턴이었어요.

매니지드 인증도 paying user 0 시점에는 비용이 컸어요 — [Auth0 Pro가 시작가 월 $240](https://auth0.com/pricing), Clerk Pro 월 $25 + per-MAU, Supabase Auth는 무료지만 Supabase 풀 스택 lock-in, AWS Cognito는 $0.0055/MAU로 저렴하지만 vendor lock-in.

### OAuth-only 채택 — 페르소나에 맞는 길

Balruno의 페르소나(개발자/디자이너/기획자)는 GitHub 계정 80% 이상 + Google 계정 100% 보유라서 OAuth-only가 사용자 friction이 거의 0이었어요. provider가 비밀번호 + 2FA + lockout + 누출 모니터링까지 다 책임지고, 우리는 *결과(verified email + provider user id)*만 받는 구조예요.

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
| **RS256** | private + public | ~50µs | ~5µs | **JWKS 엔드포인트 OK** | **Hocuspocus 합류 시점 예약** |
| ES256 | private + public(작음) | ~10µs | ~30µs | JWKS OK | RS256의 modern 대안 |
| EdDSA(Ed25519) | private + public(가장 작음) | ~5µs | ~15µs | JWKS OK | 미래 표준 후보 |

지금은 단일 Spring 인스턴스 + verifier가 issuer와 같으니 **HS256 + 단일 secret**이 가장 빠르고 단순해요. 다음 단계에서 Hocuspocus(Node) sidecar가 합류하면 verifier가 둘이 되는데, HMAC secret을 sidecar와 공유하면 sidecar가 *발급도* 가능해져서 권한이 의도와 다르게 늘어나요. 그래서 그 시점에는 RS256으로 옮겨서 RSA private은 Spring만 알고 public은 sidecar / frontend에 배포 + JWKS 엔드포인트를 노출하는 구조로 갈 계획이에요.

### JWT 보관 — cookie + Bearer 듀얼

| 위치 | XSS | CSRF | API 클라이언트 호환 | 채택 |
|------|-----|------|---------------------|------|
| localStorage | **취약** | 없음 | OK | 거부 |
| **httpOnly cookie**(`Domain=balruno.com`, `SameSite=Lax`) | **0** | 약함(Lax) | X | **★ 브라우저** |
| **Authorization Bearer header** | 0(메모리) | 0 | **OK** | **★ Electron / API 클라이언트** |

Spring의 `BearerTokenResolver`로 cookie + header를 한 줄로 통합해요. GitHub / Stripe / Linear가 모두 이 패턴이고, 한쪽만 채택하면 데스크톱 / 모바일 / CLI 중 하나는 못 쓰게 돼요.

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

비용 결과: Auth0 대비 연 $2,880 절감 / Clerk 대비 연 $324 절감 + lock-in 0 + 데이터 통제권 100%. 학습 시간은 약 1주 정도였어요.

---

## 6. Notion 클론에서 *게임 스튜디오 워크스페이스*로 분리되는 부가 기능들

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

## 7. 실패와 교훈

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

처음 AFFiNE / AppFlowy 식 *전체 yjs 통합*으로 시작한 게 Balruno 시트의 *Baserow 계열* 도메인과 어긋나면서 누적된 부채였어요. 단계별 정리로 *시트 영역 약 80,000 라인의 로컬 모드 코드*를 들어내고 시트 도메인을 100% 서버 진실원으로 옮겼어요. *기능을 추가한 commit*보다 *기능을 정리한 commit*이 prod CI green을 유지한 사실이 더 강한 신호예요.

---

## 최종 아키텍처 + 핵심 수치

### 인프라 + 비용

| 항목 | 매니지드 가설 | OCI 셀프 실측 | 절감 |
|------|----------------|----------------|------|
| 인프라 통합(Vercel + Fly.io + Aurora + Atlas + Datadog) | $155/월 | **$0/월** | **연 $1,860** |
| 인증(Auth0 Pro) | $240/월 | $0(OAuth + 자체 발급 JWT) | **연 $2,880** |
| 인증(Clerk Pro + 100 MAU) | $27/월 | $0 | 연 $324 |
| 모니터링(Datadog Pro 4 host) | $60/월 | $0(Grafana 셀프) | **연 $720** |

### DB

| 항목 | Before | After | 측정 조건 |
|------|--------|-------|-----------|
| 시트 통째 GET p95(1만 건) | MySQL JSON 240ms | **PG JSONB 65ms** | k6 50 가상 사용자 × 5분, OCI ARM 12GB |
| 시트 내부 키 조회 p95 | MySQL 320ms | **PG GIN 45ms** | `data->>'name' = ?` |
| GIN 인덱스 효과 | p95 280ms | **65ms (4.3배)** | 인덱스 ON/OFF 직접 비교 |
| `jsonb_set` patch p95 | – | **8ms** | 트랜잭션 단위 측정 |

### 가상 스레드 + JVM

| 메트릭 | 가상 스레드 OFF | 가상 스레드 ON | 변화 |
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
| 재전송 멱등 | clientMsgId UUIDv7 + `op_idempotency` 캐시 응답 |
| cycle 방지 | 애플리케이션 BFS, 400 CYCLE_DETECTED |
| cascade delete | 애플리케이션 재귀 + `documents.deleted_at`(30일 hard delete cron) |
| 문서 본문 | yjs CRDT 자동 머지(Hocuspocus Node sidecar + `documents.binary` BYTEA) |

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

그 한 점이 *시트가 Baserow 계열이다*라는 인식이었고, 이 분기 위에서 약 80,000 라인 로컬 모드 정리, 시트 도메인 100% 서버 진실원 전환, 3 영역 통합 동기화, 무중단 배포, 셀프 호스트 인프라가 차례로 풀렸어요. paying user 0 시점에 매니지드 통합 대비 연 약 $5,460 절감(인프라 $1,860 + 인증 $2,880 + 모니터링 $720) + 데이터 통제권 100% + 운영 자동화까지 같이 확보했고, 이 모든 결정의 추적성이 70여 개의 결정 문서로 남아 있어요.

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

The core question wasn't *which DB has the most features* but *which storage model takes the natural unit of "a sheet" with the least friction*. Normalising 1 cell → 1 row would turn a 1000×30 sheet into 30,000 rows, and a single sheet GET would unfold into a multi-stage JOIN or N+1 risk.

The same CRUD API was wired to MySQL 8 + JSON, PostgreSQL 18 + JSONB, and MongoDB 7 on the same OCI ARM 12GB monitor host (same VCN, ≤1ms internal). With k6 (50 VU, 5 min) writing to InfluxDB 2.x and a single Grafana dashboard registering both Prometheus (live) and InfluxDB (load) data sources, the measurements were:

| DB | Sheet GET p95 (10K) | Internal key lookup p95 |
|----|----------------------|--------------------------|
| MySQL 8 + JSON | **240ms** | 320ms (generated column) |
| **PostgreSQL 18 + JSONB** | **65ms** | **45ms (GIN native)** |
| MongoDB 7 | 95ms | 60ms |

PG JSONB was about 3.7× faster than MySQL JSON on sheet GET. The structural reasons were (1) JSONB binary storage (no parsing per query), (2) one GIN index covering the *entire* JSON tree, and (3) `jsonb_set(data, path, value)` enabling per-cell partial patches that match the cell-event WebSocket exactly. Same-domain references — Notion sharding [PostgreSQL across 32 databases](https://www.notion.com/blog/the-great-re-shard) for blocks/comments/collections, Linear on PG, Outline's `documentStructure` JSONB tree, Supabase's PG-based Realtime — confirmed the choice. Aurora MySQL ~$50/mo + Mongo Atlas ~$25/mo became OCI self-hosted PG **$0/mo** — yearly savings of $960~$1,200 plus full data control.

Final model: 3 JSONB columns + 3 version columns in the same `projects` row. Single transaction guarantee for cross-region writes; independent versions so a conflict in one region doesn't block another. Document bodies stay as `documents.binary` BYTEA (yjs) consumed by Hocuspocus' database extension adapter.

---

## 2. Why Sheets Were Lifted Out of yjs — The 80K-Line Cleanup

The initial structure inherited the AFFiNE/AppFlowy "everything yjs" pattern. Two structural mismatches surfaced when migrating to a server-canonical model.

First, **domain mismatch**. AFFiNE/AppFlowy spreadsheets are *Notion-class* (small embedded tables in a doc), where Y.Map auto-merge is natural. Balruno sheets are *Baserow-class* — 16 column types + mathjs 70+ game functions + Monte Carlo simulation + Unity C# struct export — and yjs CRDT auto-merge could produce merges that *contradict the designer's intent* on top of external simulation/engine integrations.

Second, **Java ecosystem gap**. y-crdt's Java binding has been incomplete since GitHub issue #217 (2022), so server-side validation/persistence/promotion in Java would require a hand-rolled implementation — a six-month trap. Even introducing Hocuspocus as a Node sidecar would split the sheet sync stack between Spring and Node.

A 4-region × 2-pattern mapping became the answer: sheet cells (Baserow cell event) + sheet tree (Linear sync engine op log) + doc tree (Linear op log) + doc bodies (Outline yjs/Hocuspocus). The Y.Doc retirement happened in stages:

- Preparation: docSlice unified to direct setState, UndoManager adapter to no-op, `useYDocSync.ts` + webrtc helpers removed.
- First sweep: 17 unreferenced ydoc exports — 1402 → 1075 lines (-23%).
- Main sweep: 294 reachability-dead files, including legacy panels/views/hooks/lib/store + tests — **-77,496 lines**.
- Final sweep: `lib/ydoc.ts` itself + sticker/changelog audit (zero UI consumers) — **net -3,411 lines**.

About **~80,000 lines** of local-mode code retired. Sheet domain is now 100% server-canonical, with yjs surviving only in the doc-body Hocuspocus path. Each stage was gated by `tsc --noEmit` green, vitest 9/10 file pass / 82/82 tests, prod CI green, and manual prod smoke.

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

Functional accuracy (conflicts / idempotency / cycle / cascade) is verified by `SheetCellOpServiceTest` + `TreeOpServiceTest`. Load measurements (broadcast latency p95, op_idempotency miss ratio, conflict rate) are deferred to a *real-traffic regression incident* — synthetic 100 VU baselines on a near-empty service can't fill the (current state)/(problem) phases of a real retrospective, and the regression event itself becomes the source data.

---

## 4. Infrastructure — OCI 4 Hosts + Ansible + Cloudflare + Observability

Managed-stack baseline (Vercel Pro $20 + Fly.io $5 + Aurora $50 + Atlas $25 + Datadog $60) totalled **$155/mo = $1,860/yr** at paying-user 0 — an unfit cost curve for solo OSS. The replacement: OCI Always Free 4 hosts (ARM Ampere A1 2 OCPU × 12GB ×2 + x86 E2.1.Micro 1 OCPU × 1GB ×2) on the same VCN (≤1ms internal) + free Cloudflare (proxy + 15-year Origin Cert + Tunnel + R2 10GB).

Role distribution: prod-app (Spring + Nginx + Hocuspocus, ~3GB), monitor (PG 18 + Grafana stack, ~5GB), backup (pg_dump rsync + cloudflared + node_exporter, ~480MB), status (R2 upload daemon + node_exporter, ~150MB). The 1GB hosts deliberately do **not** carry monitoring (Loki ~1.5GB, Prometheus WAL replay 2-3× spike, Grafana recommended 4GB — community evidence of OOM kills); ARM 12GB consolidation is the OCI Ampere A1 norm.

Ansible roles + a single GitHub Actions workflow (PR check + main push apply, 1 vault-password GitHub Secret) bring all 4 hosts up via `ansible-playbook -i inventory.yml site.yml`. The 3-2-1 backup chain runs monitor pg_dump → backup rsync → status R2 upload (cross-cloud, S3-compatible) and was validated end-to-end at 2 seconds.

The observability stack is fully self-hosted: Prometheus (live ops metrics) + Loki (logs, ~512MB vs Elasticsearch ~2GB) + Alloy (log shipper, since [Promtail entered LTS in Feb 2025 and EOL is Mar 2026](https://grafana.com/blog/2025/02/13/grafana-loki-3.4-standardized-storage-config-sizing-guidance-and-promtail-merging-into-alloy/)) + InfluxDB 2.x (k6 load results, kept *separate* from Prometheus to avoid high-cardinality contamination) + blackbox_exporter (HTTP/TLS/TCP probes, replacing the earlier Uptime Kuma plan once it became redundant) + Grafana (single pane). Datadog Pro $15/host × 4 = $720/yr saved.

The first measurements that became real source data:

- **Virtual threads on cell.update WebSocket (100 concurrent)**: p95 320ms → 180ms (-44%), heap 380MB → 220MB (-42%).
- **JSONB GIN on sheet GET (10K rows)**: p95 280ms → 65ms (4.3×), p99 410ms → 110ms.

Zero-downtime deploy followed. Replacing `docker compose pull && up -d`'s 30~60s 502 window, two `nginx` upstream snippets (`-blue.conf` / `-green.conf`) under `/etc/nginx/snippets/` are exposed via a single symlink `/etc/nginx/conf.d/balruno-backend-active.conf`. Cutover: `ln -sfn` the alternate snippet + `nginx -s reload` (graceful — old workers drain inflight requests; `worker_shutdown_timeout 30s` defends WS retention). Readiness probes drive the swap (liveness only proves the process is alive; readiness gates DB connection + cache warm-up). DB migrations enforce expand-contract; destructive changes are tagged `[destructive]` and run on a separate slot.

Production measurement (2026-05-10): first cutover (single → dual-slot transition) ≤21s, every subsequent cutover **0s** within 10s polling resolution. Bonus discovery — `nginx`'s `backup` directive auto-fails over even before the explicit symlink swap, providing a partial zero-downtime safety net for free.

---

## 5. Auth — OAuth-only + Self-issued JWT (HS256, RS256 reserved)

Self-rolled passwords are a 7-stage chain (policy + bcrypt round-12 ~250ms CPU/req + DB + reset email + bounce handling + leak monitoring + 2FA), and a single broken stage invalidates the whole chain. Managed auth (Auth0 Pro $240/mo, Clerk Pro $25/mo + per-MAU) doesn't fit the paying-user-0 cost curve. Balruno's persona (developers/designers, GitHub 80%+ + Google 100%) makes OAuth-only nearly friction-free.

JWT algorithm follows verifier count: HS256 (symmetric 32B, ~1µs sign/verify, single-secret) is correct while there's only one verifier. When the Hocuspocus Node sidecar arrives, the second verifier appears — sharing the HMAC secret would unintentionally grant the sidecar issuance capability, so the migration to RS256 (asymmetric, JWKS endpoint, public-only on sidecar/frontend) is reserved for that point.

Token storage is dual: httpOnly cookie (`Domain=balruno.com`, SameSite=Lax) for browsers + `Authorization: Bearer` for Electron / mobile / CLI, unified by a `BearerTokenResolver` that tries the header first and falls back to the cookie. GitHub / Stripe / Linear all use this pattern.

Verified-email auto-link uses a sealed interface with 4 cases (Notion / Linear / Vercel pattern). Case 2 — *provider didn't mark email as verified, but a user with the same email already exists* — is rejected to block account takeover (an attacker registering an unverified GitHub email with the victim's address would otherwise auto-link). GitHub's `/user/emails` is filtered to `primary == verified == true`; Google OIDC's `email_verified` claim provides this directly. Refresh tokens are DB rotation chains (BYTEA hash + prev_id) so revoke is instant; Redis comes in once user count justifies it.

Cost outcome: Auth0 vs self-hosted = $2,880/yr saved, Clerk vs self = $324/yr, plus 0 lock-in.

---

## 6. Feature Layer — What Separates a Notion Clone from a Game-Studio Workspace

- **Persistent server-backed undo** — Cmd+Z survives refresh within 120 min (Baserow `MINUTES_UNTIL_ACTION_CLEANED_UP`), per-tab isolation, 30s/20-op action grouping. The Diff baseline picker reuses the same idempotency log's `inverse_payload` via backward replay — no separate snapshot infra.
- **10 view types** — Grid · Form · Kanban · Calendar · Gallery · Gantt · **Heatmap · Curve · Probability · Diff**. The last 4 are game-balance specific and don't exist in Notion / Airtable / Baserow. Every view switch and drag-drop broadcasts to peers via the server-canonical sync.
- **Comments + @mentions + notifications** — sheet cells + doc body range-anchored highlights (Tiptap Decoration plugin), 1-level reply threads (Slack/Linear pattern), email + Web Push (VAPID, RFC 8030 + 8292), daily/weekly digests.
- **Webhooks** — outbound (HMAC-SHA256 POSTs decoupled via ApplicationEvent so the Spring Modulith arch test stays green), inbound GitHub PR/issues + generic.
- **Discord slash commands** — Ed25519-verified `/v1/discord/interactions`.
- **Stripe billing**, **share links**, **project-wide search** (Cmd+K + 200ms debounce), **workspace audit log**, **Unity export** (CSV RFC 4180 + BOM + C# struct), **GDPR + PWA**.

The two most satisfying decisions in this layer were the ApplicationEvent decoupling on outbound webhooks (the webhook module never statically depends on publishers, so the Modulith boundary test stays green) and the Diff baseline picker reusing the same idempotency log — one feature shipped without a single line of new infrastructure.

---

## 7. Failures and Lessons

- **Five silent failures during early auth work**: Spring Boot 4 autoconfig split (no `flyway-schema-history`), spec drift (`gen_random_uuidv7()` vs the GA `uuidv7()`), Tomcat 11 RFC 6265 strict cookie (leading-dot `Domain` rejected), Hibernate `@UuidGenerator(style=TIME)` actually emitting UUIDv1, docker-compose `env_file` permissions (compose CLI parses client-side as the user, not the daemon's root). Common pattern: `catch (RuntimeException)` swallow hid the real cause until logging was added — *every catch must log the stack trace* is the baseline for a self-host SaaS.
- **Inspect the underlying once for every abstraction.** Faults 1, 4, 5 all hid behind a layer (autoconfig, annotation name, compose CLI). 5 minutes of `\dt`, hex dump, `ls -la` would have killed each one earlier.
- **Spec → verify → correct cycle.** The original `gen_random_uuidv7()` was an honest guess written when PG 18 was still RC. The lesson isn't "don't guess" — it's "every decision must be cross-checked against prod once after first deploy", and *the amendment itself is the credibility signal*.
- **Uptime Kuma swap.** Adopting Uptime Kuma was valid (UptimeRobot's commercial-use ToS change), but `blackbox_exporter` in the existing Grafana stack covered the same responsibility natively. Removing a tool *because measurement showed it was redundant* is itself a portfolio signal — first answers don't have to be final.
- **~80K lines of local-mode retired.** The original AFFiNE/AppFlowy "everything yjs" path collected as debt once Balruno's *Baserow-class* sheet domain came into focus. The cleanup commits keeping prod CI green is a stronger signal than the feature commits.

---

## Closing

Balruno was less invention and more **composition**. Baserow cell events + Linear op logs + Outline JSONB doc trees + Notion's PG JSONB block model + Spring Security 7's OAuth 2.1 defaults + OCI Always Free + Cloudflare R2 — each backed by 5+ years of OSS validation. The single inflection point was recognising that *sheets here are Baserow-class, not Notion-class*; everything downstream — the 80K-line cleanup, the server-canonical migration, the 3-region unified sync, the zero-downtime cutover, the self-hosted infrastructure — followed from that one branch. At paying-user 0 the stack saves about $5,460/yr versus managed (infra $1,860 + auth $2,880 + observability $720) while keeping full data control and operational-automation signal.

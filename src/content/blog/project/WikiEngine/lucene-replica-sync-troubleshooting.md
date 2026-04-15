---
title: 'Lucene Replica 인덱스 동기화 — rsync 경로 오류에서 atomic swap까지'
titleEn: 'Lucene Replica Index Sync — From rsync Path Mismatch to Atomic Swap'
description: 2대 서버 환경에서 Lucene 인덱스를 rsync로 동기화하는 과정에서 발생한 문제들을 추적합니다. sync-index.sh의 glob 삭제 버그, Docker 볼륨 경로 불일치(named volume vs bind mount), Redis 배치 version 충돌, 자동완성 Lucene fallback 실패를 하나씩 디버깅하며, 최종적으로 temp directory + atomic swap 패턴과 경로 수정으로 해결합니다.
descriptionEn: Traces index synchronization issues between primary and replica Lucene servers in a 2-node setup. Debugs sync-index.sh glob deletion bug, Docker volume path mismatch (named volume vs bind mount), Redis batch version collision, and autocomplete Lucene fallback failure, ultimately resolving with temp directory + atomic swap pattern and correct path configuration.
date: 2026-04-05T00:00:00.000Z
tags:
  - Lucene
  - Docker
  - rsync
  - Troubleshooting
  - Distributed Systems
  - DevOps
  - Spring Boot
  - Wiki
category: project/WikiEngine
draft: true
series: "WikiEngine"
---

## 이전 글

[Nori 형태소 분석기 Stop Filter 문제 — "안녕" 검색 0건의 원인과 해결](/blog/project/wikiengine/nori-stop-filter-fix)에서 Nori의 `DEFAULT_STOP_TAGS`에 포함된 IC(감탄사) 필터를 제거하고, `title_ngram` 2-3gram 필드를 추가하여 dis_max 쿼리로 형태소 분석 실패를 보완했습니다.

| 지표 | 결과 |
|------|------|
| IC 제거 | "안녕" 검색 0건 해결 |
| title_ngram + dis_max | "안녕하세" 불완전 입력 랭킹 개선 |
| 인덱스 크기 | 36GB → 39GB (+8%) |
| 재색인 | **필수** (12M건, 69분) |

`title_ngram` 필드 추가로 전체 재색인이 필요했고, 재색인된 인덱스를 서버2(replica)에 동기화하는 과정에서 이 글의 문제들이 시작됩니다.

---

## 1. 정상 상태 --- 인덱스 동기화 아키텍처

wikiEngine은 2대의 ARM 서버에서 운영됩니다. Lucene 인덱스의 쓰기는 서버1(primary)에서만 수행하고, 서버2(replica)는 읽기 전용으로 동작합니다. MySQL의 Primary-Replica 패턴과 동일한 사고 모델입니다.

![wikiEngine Primary-Replica 아키텍처 — 서버1은 IndexWriter/NRT SearcherManager로 쓰기 전용, 서버2는 DirectoryReader로 읽기 전용, 사이를 rsync로 동기화](/uploads/project/WikiEngine/lucene-replica-sync-troubleshooting/primary-replica-architecture.svg)

서버1의 앱은 Kafka CDC 이벤트를 수신하여 실시간으로 Lucene 인덱스를 갱신합니다. `IndexWriter`로 문서를 추가/수정/삭제하고, `SearcherManager`의 NRT(Near Real-Time) 리더가 변경사항을 반영합니다.

서버2의 앱은 `DirectoryReader`만 사용합니다. `IndexWriter`가 없으므로 직접 인덱스를 수정할 수 없고, rsync로 서버1의 인덱스 파일을 복사받아 갱신합니다.

동기화 스크립트(`sync-index.sh`)의 기본 흐름은 다음과 같습니다:

1. 양쪽 앱 컨테이너 중지
2. 서버2의 기존 인덱스 삭제
3. 서버1 → 서버2로 rsync
4. 양쪽 앱 컨테이너 시작

재색인 전까지 이 흐름은 문제없이 동작하고 있었습니다. 인덱스 규모는 12M 문서, 약 39GB, `forceMerge(5)` 적용 후 5개 세그먼트입니다.

---

## 2. 문제 발생 --- 재색인 후 자동완성이 안 됨

`title_ngram` 필드 추가를 위해 로컬에서 전체 재색인을 수행한 뒤, `sync-index.sh`로 양쪽 서버에 인덱스를 배포했습니다.

배포 직후 검색은 정상이었지만, 자동완성에서 이상한 패턴이 나타났습니다.

"안녕"을 입력하면 자동완성이 정상 동작하는데, "황치열"을 입력하면 결과가 없습니다. 같은 키워드를 반복해서 입력하면 **될 때도 있고 안 될 때도 있었습니다**. 대략 50% 확률이었습니다.

50%라는 숫자가 단서였습니다. Nginx가 `least_conn`으로 서버1과 서버2에 요청을 분산하고 있으므로, "어느 서버에 걸리느냐"에 따라 결과가 달라지는 것이었습니다. 직접 확인해보니 서버1은 자동완성이 정상이고, 서버2는 빈 결과를 반환했습니다.

서버2의 인덱스에 문제가 있다는 것은 분명했지만, 정확히 무엇이 잘못되었는지를 찾는 데 네 단계의 디버깅이 필요했습니다.

---

## 3. 원인 추적 1 --- sync-index.sh glob 삭제 버그

첫 번째로 의심한 것은 인덱스 파일 동기화 자체였습니다. 서버2에서 Lucene 인덱스 디렉토리의 파일 수를 확인했습니다.

```bash
# 서버1
$ ls /var/lib/docker/volumes/backend_lucene_index/_data/wiki-index/ | wc -l
92

# 서버2
$ ls /data/lucene/wiki-index/ | wc -l
104
```

서버2에 파일이 12개 더 많았습니다. rsync로 동기화했는데 파일 수가 다르다는 것은 **기존 파일이 완전히 삭제되지 않은 채 새 파일이 덮어씌워졌다**는 뜻입니다.

당시 `sync-index.sh`의 삭제 명령은 glob 패턴을 사용하고 있었습니다:

```bash
# 문제가 된 코드 (Before)
ssh $SERVER2 "rm -rf ${SERVER2_BASE}/wiki-index/*"
```

이 방식은 쉘 glob expansion에 의존합니다. 파일이 매우 많거나 숨김 파일이 있으면 모든 파일이 삭제되지 않을 수 있습니다. 서버2에 남아 있던 12개의 파일은 이전 색인의 세그먼트 파일들이었고, 이 오래된 세그먼트에는 `title_raw` 필드가 없었습니다.

Lucene은 각 세그먼트를 독립적으로 검색합니다. 자동완성 쿼리가 `title_raw` PrefixQuery를 사용할 때, 새 세그먼트에서는 정상적으로 매칭되지만 **오래된 세그먼트에서는 필드 자체가 존재하지 않아** 해당 세그먼트의 문서들이 매칭되지 않습니다.

수정은 간단했습니다. glob 대신 디렉토리 자체를 삭제하고 다시 생성합니다:

```bash
# 수정 (After)
ssh $SERVER2 "rm -rf ${SERVER2_BASE}/wiki-index && mkdir -p ${SERVER2_BASE}/wiki-index"
```

이렇게 하면 숨김 파일이든 특수 파일이든 관계없이 디렉토리 안의 모든 것이 확실하게 제거됩니다.

---

## 4. 원인 추적 2 --- Redis 배치 version 불일치

glob 삭제를 수정하고 다시 동기화했지만, 자동완성 문제가 완전히 해결되지 않았습니다. 여전히 서버2에서 일부 키워드의 자동완성이 실패했습니다.

wikiEngine의 자동완성은 2단계로 동작합니다. 먼저 Redis에 캐싱된 prefix top-K 결과를 조회하고, Redis에 없으면 Lucene에서 PrefixQuery로 직접 검색합니다(fallback). 문제는 Redis 단계에서 발생하고 있었습니다.

자동완성 배치 스케줄러(`AutocompleteBatchScheduler`)는 매 시간마다 실행되어, Lucene 인덱스에서 인기 키워드를 추출하고 Redis에 `prefix_topk:{prefix}` 형태로 저장합니다. 이때 version 번호를 함께 관리하여, 배치가 완료되면 최신 version의 데이터만 읽도록 합니다.

문제는 이 배치가 **양쪽 서버에서 독립적으로 실행**되고 있었다는 점입니다. 서버1과 서버2는 같은 Redis 샤드 클러스터를 공유합니다. Consistent Hashing으로 키가 3개 샤드에 분산되는데, 서버1의 배치와 서버2의 배치가 각각 다른 version 번호를 기록했습니다.

```
시나리오:
  서버1 배치 실행 → version=42 기록, prefix 데이터를 version=42로 저장
  서버2 배치 실행 → version=43 기록, prefix 데이터를 version=43으로 저장

  서버2 자동완성 요청:
    getCurrentVersion() → 42 (서버1이 기록한 version을 읽을 수 있음)
    get("prefix_topk:v43:황") → 데이터 존재  (서버2가 v43으로 저장)
    하지만 현재 version=42로 읽으므로:
    get("prefix_topk:v42:황") → miss  (서버1의 v42 데이터는 다른 샤드에 있거나 불완전)
```

version이 서로 다른 값으로 뒤섞이면서, 요청 시점에 어느 version을 읽느냐에 따라 결과가 있거나 없었습니다.

해결은 replica에서 배치를 실행하지 않는 것이었습니다. 이미 `lucene.mode` 설정으로 primary/replica를 구분하고 있었으므로, 배치 스케줄러에서 모드를 확인하는 조건만 추가했습니다:

```java
// AutocompleteBatchScheduler.java
@Value("${lucene.mode:primary}")
private String luceneMode;

@Scheduled(cron = "0 0 * * * *")
public void runAutocompleteBuildJob() {
    if (!"primary".equals(luceneMode)) {
        log.info("Replica 모드 — 자동완성 배치 스킵");
        return;
    }
    // ... 배치 실행
}
```

서버1만 배치를 실행하므로 version 충돌이 발생하지 않습니다. 서버2는 서버1이 저장한 Redis 데이터를 읽기만 합니다.

---

## 5. 원인 추적 3 --- 자동완성 Lucene fallback (title_jamo에서 title_raw로)

Redis 배치 문제를 수정한 뒤에도, Redis에 캐싱되지 않은 키워드의 자동완성이 여전히 불안정했습니다. Redis miss일 때 Lucene fallback이 제대로 동작하지 않는 것이었습니다.

당시 Lucene fallback은 `title_jamo` 필드를 사용하고 있었습니다. `title_jamo`는 제목을 자모 단위로 분해하여 저장한 `StringField`입니다. "황치열"을 입력하면 자모로 분해한 뒤 PrefixQuery를 실행합니다.

문제는 **완성된 한글은 자모 분해 시 prefix 범위가 너무 넓어진다**는 것이었습니다. "황치열"을 자모 분해하면 "ㅎㅘㅇㅊㅣㅇㅕㄹ"이 되는데, 이 접두사로 시작하는 term이 12M건의 인덱스에서 엄청나게 많습니다. Lucene의 `PrefixQuery`는 내부적으로 매칭되는 모든 term을 `BooleanQuery`로 확장하는데, term 수가 `BooleanQuery.maxClauseCount`를 초과하면 예외가 발생하거나 결과가 잘리게 됩니다.

	반면, 자모가 입력에 포함된 경우("자ㅂ", "ㅅㅅ")에는 `title_jamo` PrefixQuery가 적합합니다. 자모 자체가 term 구분자 역할을 하여 매칭 범위가 좁아지기 때문입니다.

수정은 입력 유형에 따라 다른 필드를 사용하도록 분기하는 것이었습니다:

```java
// LuceneSearchService.java — searchByPrefix()
if (JamoDecomposer.containsJamo(normalized)) {
    // 자모 포함 ("자ㅂ", "ㅅㅅ") → title_jamo PrefixQuery
    String decomposed = JamoDecomposer.decompose(normalized);
    query = new PrefixQuery(new Term("title_jamo", decomposed));
} else {
    // 완성된 한글/영어 ("황치열", "java") → title_raw PrefixQuery
    // title_raw는 원본 제목 lowercase — StringField로 직접 매칭
    query = new PrefixQuery(new Term("title_raw", normalized));
}
```

`title_raw`는 제목 원본을 lowercase로 저장한 `StringField`입니다. "황치열"로 PrefixQuery를 실행하면 "황치열"로 시작하는 제목만 정확히 매칭되므로, term 폭발 문제가 발생하지 않습니다.

이 수정까지 적용하고 서버1에서 자동완성이 완벽하게 동작하는 것을 확인했습니다. 그런데 서버2에서는 여전히 "g마켓이", "python" 같은 영어/혼합 키워드의 자동완성이 0건이었습니다.

---

## 6. 원인 추적 4 --- Docker 볼륨 경로 불일치 (근본 원인)

세 가지 문제를 모두 수정했는데도 서버2에서 특정 키워드의 자동완성이 실패한다는 것은, 서버2의 인덱스 자체에 근본적인 문제가 있다는 뜻이었습니다. 여기서부터는 추측이 아니라 **인덱스 내부를 직접 들여다보는** 접근이 필요했습니다.

### 디버그 엔드포인트 추가

Lucene 세그먼트별로 `title_raw` 필드가 존재하는지 확인하는 디버그 엔드포인트를 추가했습니다:

```java
// PostAdminController.java
@GetMapping("/debug-title-raw")
public Map<String, Object> debugTitleRaw(@RequestParam String prefix,
                                          @RequestParam(defaultValue = "10") int limit)
        throws IOException {
    var searcher = searcherManager.acquire();
    try {
        var query = new PrefixQuery(new Term("title_raw", prefix.toLowerCase()));
        var topDocs = searcher.search(query, limit);

        // 세그먼트별 title_raw 필드 정보
        var reader = searcher.getIndexReader();
        var fieldInfos = new ArrayList<String>();
        for (var leaf : reader.leaves()) {
            var fi = leaf.reader().getFieldInfos();
            var titleRawInfo = fi.fieldInfo("title_raw");
            fieldInfos.add("segment=" + leaf.reader() +
                    " title_raw=" + (titleRawInfo != null
                        ? titleRawInfo.getIndexOptions() : "NOT_FOUND") +
                    " docCount=" + leaf.reader().numDocs());
        }
        return Map.of(
                "prefix", prefix.toLowerCase(),
                "totalHits", topDocs.totalHits.value(),
                "fieldInfoPerSegment", fieldInfos
        );
    } finally {
        searcherManager.release(searcher);
    }
}
```

이 엔드포인트가 문제의 핵심을 드러냈습니다.

### 서버1 결과 --- 정상

```json
{
  "prefix": "python",
  "totalHits": 6,
  "fieldInfoPerSegment": [
    "segment=_li title_raw=DOCS docCount=2431117",
    "segment=_lj title_raw=DOCS docCount=2431118",
    "segment=_lk title_raw=DOCS docCount=2431118",
    "segment=_ll title_raw=DOCS docCount=2431118",
    "segment=_lm title_raw=DOCS docCount=2431118"
  ]
}
```

5개 세그먼트 모두 `title_raw=DOCS`입니다. 필드가 정상적으로 존재하며, PrefixQuery가 6건을 반환합니다.

### 서버2 결과 --- 비정상

```json
{
  "prefix": "python",
  "totalHits": 0,
  "fieldInfoPerSegment": [
    "segment=_2o8 title_raw=NOT_FOUND docCount=1891234",
    "segment=_h2h title_raw=NOT_FOUND docCount=2567891",
    "segment=_h5k title_raw=NOT_FOUND docCount=2456789",
    "segment=_hjb title_raw=NOT_FOUND docCount=2789123"
  ]
}
```

서버2의 모든 세그먼트에서 `title_raw=NOT_FOUND`입니다. **`title_raw` 필드가 아예 존재하지 않는 오래된 인덱스를 읽고 있었습니다.**

세그먼트 이름도 서버1(`_li~_lm`)과 완전히 다릅니다(`_2o8, _h2h~_hjb`). rsync로 동기화했다면 같은 세그먼트가 있어야 합니다. 서버2는 **rsync가 전혀 반영되지 않은 별도의 인덱스**를 사용하고 있었습니다.

### 진짜 원인 --- named volume vs bind mount

여기서 양쪽 서버의 `docker-compose.yml`을 비교했습니다.

**서버1 (docker-compose.yml):**

```yaml
services:
  app:
    volumes:
      - lucene_index:/data/lucene

volumes:
  lucene_index:     # pure named volume
```

서버1의 `lucene_index`는 **Docker named volume**입니다. Docker가 관리하는 볼륨이며, 호스트 파일시스템에서의 실제 경로는 `/var/lib/docker/volumes/backend_lucene_index/_data/`입니다.

**서버2 (docker-compose.yml):**

```yaml
services:
  app:
    volumes:
      - lucene_index:/data/lucene

volumes:
  lucene_index:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: /data/lucene    # bind mount!
```

서버2의 `lucene_index`는 겉보기에는 named volume이지만, `driver_opts`로 **bind mount**가 설정되어 있습니다. 호스트 파일시스템에서의 실제 경로는 `/data/lucene/`입니다.

Docker Compose의 `volumes` 섹션에서 `driver_opts: { type: none, o: bind, device: /path }`를 지정하면, named volume처럼 선언되지만 실제로는 지정된 호스트 경로를 직접 마운트합니다. 이는 Docker의 잘 알려진 패턴이지만, **두 서버의 볼륨 설정이 다르다는 것을 간과하면** 이런 문제가 발생합니다.

**`sync-index.sh`의 경로 설정 (수정 전):**

```bash
SERVER1_BASE="/var/lib/docker/volumes/backend_lucene_index/_data"  # 맞음
SERVER2_BASE="/var/lib/docker/volumes/mysql-replica_lucene_index/_data"  # 틀림!
```

서버2의 경로가 Docker named volume 경로(`/var/lib/docker/volumes/...`)로 설정되어 있었습니다. 하지만 서버2는 bind mount이므로 실제 데이터는 `/data/lucene/`에 있습니다.

rsync는 `/var/lib/docker/volumes/mysql-replica_lucene_index/_data/`에 파일을 열심히 복사했지만, 컨테이너는 `/data/lucene/`에서 인덱스를 읽고 있었습니다. rsync가 보낸 파일은 컨테이너가 전혀 보지 않는 디렉토리에 저장되었고, 컨테이너는 **재색인 이전의 오래된 인덱스를 그대로 사용**하고 있었습니다.

### 수정

```bash
# Before
SERVER2_BASE="/var/lib/docker/volumes/mysql-replica_lucene_index/_data"

# After
SERVER2_BASE="/data/lucene"  # bind mount (device: /data/lucene)
```

`docker inspect`로 볼륨의 실제 마운트 포인트를 확인하면 이 차이를 바로 알 수 있습니다:

```bash
# named volume (서버1)
$ docker volume inspect backend_lucene_index
[{ "Mountpoint": "/var/lib/docker/volumes/backend_lucene_index/_data" }]

# bind mount (서버2)
$ docker volume inspect mysql-replica_lucene_index
[{ "Mountpoint": "/data/lucene",
   "Options": { "type": "none", "o": "bind", "device": "/data/lucene" } }]
```

---

## 7. 추가 개선 --- temp directory + atomic swap

경로를 수정하면서 `sync-index.sh` 전체를 재설계했습니다. 기존 방식은 live 디렉토리에서 바로 삭제하고 rsync하기 때문에, rsync 중간에 실패하면 **삭제는 완료됐는데 복사는 불완전한** 상태가 됩니다. 이 경우 앱이 시작되면 corrupt된 인덱스를 읽게 됩니다.

개선된 패턴은 temp directory에 먼저 rsync한 뒤, atomic swap(mv)으로 교체하는 것입니다:

```bash
# 1. temp 디렉토리 준비
ssh $SERVER2 "sudo rm -rf ${BASE}/wiki-index-new && sudo mkdir -p ${BASE}/wiki-index-new"

# 2. rsync to temp (live 디렉토리는 건드리지 않음)
rsync -avz --delete $SERVER1:${BASE}/wiki-index/ $SERVER2:${BASE}/wiki-index-new/

# 3. atomic swap — mv는 같은 파일시스템 내에서 inode만 교체하므로 순간적
ssh $SERVER2 "sudo rm -rf ${BASE}/wiki-index && sudo mv ${BASE}/wiki-index-new ${BASE}/wiki-index"
```

이 패턴의 핵심은 rsync가 완료될 때까지 기존 인덱스가 그대로 유지된다는 점입니다. rsync 중간에 네트워크가 끊기더라도 live 디렉토리에는 영향이 없습니다. `mv`는 같은 파일시스템 내에서 디렉토리 엔트리만 변경하므로 사실상 원자적(atomic)입니다.

최종 `sync-index.sh`는 두 가지 모드를 지원합니다:

```bash
./sync-index.sh          # 로컬 → 서버1 + 서버2 (재색인 후 전체 배포)
./sync-index.sh server2  # 서버1 → 서버2 (서버 간 직접 전송)
```

Solr의 Leader/Follower 복제에서도 유사한 패턴을 사용합니다. Solr의 follower는 leader로부터 파일을 다운로드할 때 임시 디렉토리에 먼저 저장하고, 완료 후 교체합니다. OpenSearch의 Segment Replication도 primary가 checkpoint를 전송하면 replica가 파일 diff를 계산하여 필요한 세그먼트만 받아오는데, 전송 중 기존 세그먼트를 유지하는 원리는 동일합니다.

---

## 8. 현업 조사 --- Lucene replica 동기화 패턴

이번 문제를 계기로 프로덕션에서 Lucene replica 인덱스를 동기화하는 방법을 조사했습니다. rsync 기반 동기화가 현업에서도 유효한 패턴인지 확인하기 위해서입니다.

| 시스템 | 동기화 방식 | 핵심 메커니즘 |
|--------|-----------|-------------|
| **OpenSearch Segment Replication** | primary → replica 세그먼트 전송 | primary가 checkpoint를 전송, replica가 파일 diff 계산 후 필요한 세그먼트만 요청 |
| **Yelp nrtsearch** | gRPC 기반 세그먼트 전송 + S3 백업 | primary가 인덱싱/머지 전담, replica는 NRT API로 동기화. 부트스트랩 시 S3에서 복구 |
| **Atlassian Jira Data Center** | DB journal table | 각 노드가 독립적으로 인덱싱. journal 테이블로 변경 추적 후 재인덱싱 |
| **Solr Leader/Follower** | HTTP polling 파일 전송 | follower가 leader에게 주기적으로 poll, 파일 단위로 다운로드 후 교체 |

Yelp의 nrtsearch가 이 프로젝트와 가장 유사한 구조입니다. Yelp는 *"dedicated primary/writer node that takes care of indexing operations and expensive operations like segment merges, allowing the replicas' system resources to be dedicated entirely for search queries"* 라고 설명합니다. wikiEngine도 서버1이 IndexWriter를 전담하고 서버2가 검색 전용으로 동작하는 동일한 패턴입니다.

rsync 기반 동기화는 위 시스템들에 비해 단순하지만, 2대 규모에서는 충분히 유효합니다. 다만 **구현 세부사항**에서 문제가 발생한다는 것을 이번에 경험했습니다. 경로가 맞아야 하고, 삭제가 완전해야 하고, 전송 중 인덱스 일관성이 보장되어야 합니다.

---

## 9. 검증 --- Before / After

### Before (경로 수정 전)

서버2의 debug-title-raw 엔드포인트에서 모든 세그먼트가 `title_raw=NOT_FOUND`를 반환합니다. 서버2는 `title_raw` 필드가 없는 이전 인덱스를 읽고 있었습니다.

| 키워드 | 서버1 | 서버2 |
|--------|-------|-------|
| "g마켓이" 자동완성 | 7건 | **0건** |
| "python" 자동완성 | 6건 | **0건** |
| "황" 자동완성 | 1건 | **0건** |

### After (경로 수정 + atomic swap 적용)

경로를 `/data/lucene`으로 수정하고, atomic swap 패턴으로 재동기화한 뒤:

| 키워드 | 서버1 | 서버2 |
|--------|-------|-------|
| "g마켓이" 자동완성 | 6건 | 6건 |
| "python" 자동완성 | 6건 | 6건 |
| "황" 자동완성 | 1건 | 1건 |

서버2의 debug-title-raw 엔드포인트에서도 모든 세그먼트가 `title_raw=DOCS`를 반환합니다. 세그먼트 이름도 서버1과 동일합니다.

### 전체 문제 요약

| 문제 | 원인 | 해결 |
|------|------|------|
| sync-index.sh 삭제 실패 | `rm -rf ${PATH}*` glob expansion 불완전 | 디렉토리 자체 삭제 + 재생성 |
| Redis 자동완성 50% 실패 | 양쪽 서버 배치 독립 실행, version 충돌 | replica에서 배치 스킵 (`lucene.mode` 체크) |
| "황치열" 자동완성 안 됨 | title_jamo PrefixQuery 범위 초과 | 완성 한글/영어는 title_raw PrefixQuery 사용 |
| **서버2 영어/혼합 자동완성 0건** | **sync-index.sh 서버2 경로 오류** (named volume vs bind mount) | **경로를 `/data/lucene`으로 수정** |

네 번째 문제가 근본 원인이었습니다. 처음 세 가지는 그 과정에서 발견된 부가적인 버그들입니다. 경로가 처음부터 올바르게 설정되어 있었더라도 첫 세 가지 문제는 여전히 존재했을 것이므로, 이 디버깅 과정에서 함께 수정한 것은 결과적으로 좋은 일이었습니다.

---

## 10. 교훈

**Docker의 named volume과 bind mount는 겉으로 비슷하지만 호스트 경로가 완전히 다릅니다.** 두 서버의 `docker-compose.yml`이 같은 이름의 volume을 선언하더라도 `driver_opts`에 따라 실제 호스트 경로가 달라집니다. 인덱스 동기화, 백업, 모니터링 등 **호스트 파일시스템에 직접 접근하는** 작업에서는 `docker volume inspect`로 실제 마운트 포인트를 반드시 확인해야 합니다.

**분산 환경에서 "되었다 안 되었다"하는 문제는 대부분 서버 간 상태 불일치입니다.** 50%라는 숫자가 단서였습니다. Nginx load balancing으로 어느 서버에 걸리느냐에 따라 증상이 달라지므로, 각 서버를 직접 호출하여 차이를 확인하는 것이 첫 번째 디버깅 단계였어야 합니다. MySQL Replication lag, Redis 캐시 불일치, 파일 동기화 실패 --- 2대 이상의 서버를 운영하면 "서버 간 상태가 같은가?"라는 질문이 항상 첫 번째여야 합니다.

**디버그 엔드포인트를 추가하는 것이 가장 빠른 디버깅 방법이었습니다.** 세그먼트별 필드 존재 여부를 확인하는 엔드포인트 하나(`/admin/lucene/debug-title-raw`)로 근본 원인을 찾았습니다. Lucene의 인덱스 파일을 직접 분석하거나, `luke` 같은 외부 도구를 사용하는 것보다, 애플리케이션에 간단한 진단 API를 추가하는 것이 운영 환경에서는 훨씬 효율적입니다.

**rsync + Lucene replica는 현업에서도 사용하는 패턴이지만, 구현 세부사항에서 문제가 발생합니다.** 경로가 맞는지, 삭제가 완전한지, 전송 중 인덱스가 corrupt되지 않는지 --- 동기화의 "무엇을"보다 "어떻게"에서 버그가 숨어 있었습니다. temp directory + atomic swap 패턴으로 전송 중 안전성을 확보하고, 경로를 정확히 설정하는 것이 운영 안정성의 기본입니다.

---

## 출처

- [Yelp Engineering Blog — nrtsearch: Yelp's Fast, Scalable, and Cost Effective Search Engine](https://engineeringblog.yelp.com/2021/09/nrtsearch-yelps-fast-scalable-and-cost-effective-search-engine.html)
- [OpenSearch — Segment Replication](https://opensearch.org/docs/latest/tuning-your-cluster/replication-plugin/segment-replication/)
- [Apache Solr — Index Replication](https://solr.apache.org/guide/solr/latest/deployment-guide/solr-replication.html)
- [Atlassian — Jira Data Center Search Index](https://confluence.atlassian.com/jirakb/how-to-rebuild-the-search-index-in-jira-data-center-702886490.html)
- [Mike McCandless — Lucene's Near-Real-Time Segment Index Replication](https://blog.mikemccandless.com/2017/09/lucenes-near-real-time-segment-index.html)
- [Docker Docs — Use volumes](https://docs.docker.com/engine/storage/volumes/)

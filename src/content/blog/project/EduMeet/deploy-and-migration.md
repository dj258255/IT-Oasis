---
title: '저장소를 합치고 배포를 자동화했더니, 스키마를 바꿀 수가 없었습니다'
description: >-
  GitLab에 있던 파이썬 서버를 이력을 잃지 않고 합치고, GitLab CI를 GitHub Actions로 옮겨
  OCI ARM64 서버에 자동 배포를 붙였습니다. 합치는 과정에서 한 번도 동작한 적 없던 연동이 드러났습니다.
  그리고 다음 작업에서 컬럼 하나를 추가하려다 막혔습니다. ddl-auto는 테스트 프로필에만
  있었고 마이그레이션 도구는 없었습니다. Flyway를 baseline-on-migrate로 도입하고
  Testcontainers로 실제 MySQL에서 검증한 과정입니다.
date: 2026-08-22
tags:
  - EduMeet
  - GitHub Actions
  - Docker
  - OCI
  - Flyway
  - Testcontainers
  - DevOps
  - FastAPI
  - Git
category: team/EduMeet
coverImage: /uploads/project/EduMeet/EduMeetTitle.png
draft: false
series: "EduMeet"
seriesOrder: 2
---

자동 배포를 다 만들고 나서, **다음 작업에서 컬럼을 하나 추가하려다 막혔습니다.**

`ddl-auto`는 test·perf 프로필에만 있었고, **비임베디드 DB의 Spring Boot 기본값은 `none`** 입니다. 운영에서는 Hibernate가 스키마를 손대지 않습니다. 그런데 마이그레이션 도구도 없었습니다.

```
push  →  새 이미지가 뜬다  →  컨테이너는 정상  →  그 엔티티를 처음 쓰는 질의에서 Unknown column
```

**부팅에서 죽지도 않습니다.** `none` 은 Hibernate 가 스키마를 *"안 본다"* 는 뜻이라 컨테이너는 멀쩡히 뜨고 헬스체크도 초록입니다. 기능만 죽습니다.

**배포는 자동인데 스키마는 손으로도 못 바꾸는 상태**였습니다. 정확히는, 바꾸면 그 기능이 죽습니다.

아래는 거기까지 가는 동안 만든 것과, 막힌 뒤에 고친 것입니다.

## 요약

- **문제**: 자동 배포를 다 만든 뒤 컬럼을 추가하려다 막혔습니다. `ddl-auto` 는 test·perf 프로필에만 있었고 **비임베디드 DB 의 Boot 기본값은 `none`** 이라 운영에서 Hibernate 가 스키마를 손대지 않습니다. 마이그레이션 도구도 없었습니다.
    - **→ push 하면 새 이미지가 뜨는데 컬럼이 없으면 런타임에 죽는 구조**
- **판단**: Flyway 를 `baseline-on-migrate` 로 넣되, **V1 baseline 을 손으로 쓰지 않고 엔티티에서 DDL 을 생성**했습니다(18테이블 · FK 16 · UNIQUE 4).
    - **이 옵션이 무엇을 안 해 주는지가 핵심입니다.** 기존 스키마가 V1 과 같은지는 **검증해 주지 않습니다.** 이력 테이블이 없으면 *"이미 V1"* 로 표시만 하고 V2 부터 돕니다
    - **→ 그래서 시험을 새 DB 경로와 기존 DB 업그레이드 경로로 갈랐습니다**
- **검증**: **진짜 MySQL 8.0(Testcontainers)** 에서 합니다. baseline 에 `engine=InnoDB`, `enum(...)` 같은 MySQL 전용 문법이 있어 **H2 로는 확인할 수 없습니다.**
- **곁가지**: ARM64 를 QEMU 크로스빌드 대신 **네이티브 러너**로 빌드해 배포 시간을 줄였습니다.
- **합치면서 드러난 것**: `git subtree add` 는 `git blame` 은 되는데 `git log -- frontend/` 가 **0건**이었습니다. 병합 이전 커밋의 경로가 루트라 필터가 안 걸립니다.
    - `filter-repo --to-subdirectory-filter` 로 경로를 재작성해 **3건 → 218건**. **백엔드는 SHA 를 바꾸지 않았습니다.** 같은 필터를 걸면 머지된 PR 90여 개의 참조가 깨집니다
    - 합치고 나니 **AI 연동이 한 번도 동작한 적 없었고**, `async` 를 붙인 것이 오히려 상황을 악화시키고 있었습니다

## 먼저 저장소를 합쳤습니다

파이썬 AI 서버가 GitLab에 따로 있었습니다. 합치기로 한 이유는 단순합니다. **경계를 넘는 계약을 한 저장소 안에서 시험할 수 없으면, 양쪽 시험이 다 통과해도 연동이 죽어 있을 수 있습니다.**

### 이력을 잃지 않고 합치기

**커밋 이력이 자산입니다.** 팀 6주의 기록이고 작성자별 기여가 남아야 합니다. 처음엔 `git subtree add`로 붙였는데, 잘 붙는 것처럼 보였습니다.

```bash
git blame frontend/src/App.vue       # O  2025-07-22 까지 추적된다
git log -- frontend/src/App.vue      # ×  0 커밋
```

**blame은 되는데 log는 안 됐습니다.** 병합 이전 커밋들의 **경로가 `frontend/`가 아니라 루트**였기 때문입니다. 경로 필터가 안 걸립니다.

```bash
git filter-repo --path EduMeet/ --path-rename EduMeet/:      # EduMeet/ 를 루트로
git filter-repo --to-subdirectory-filter frontend            # 전부 frontend/ 아래로
git merge --allow-unrelated-histories
```

| | subtree add | to-subdirectory-filter |
|---|---:|---:|
| `git log -- frontend` | 3 | **218** |
| `git log -- frontend/src/App.vue` | 0 | **18** |

**"이력이 기술적으로 존재한다"와 "이력을 쓸 수 있다"는 다른 얘기입니다.**

**백엔드는 이력을 다시 쓰지 않았습니다.** `backend/`로 옮겼지만 SHA는 그대로입니다. 같은 필터를 걸면 모든 SHA가 바뀌고 **머지된 PR 90여 개의 커밋 참조가 전부 깨집니다.** `git mv`의 rename 추적으로 충분했습니다.

### AI 연동이 한 번도 동작한 적 없었습니다

합치고 나서 자바 → 파이썬 호출 경로를 열어 보니 URL의 `{meetingId}`가 **치환조차 안 됐고** `X-Internal-Token`이 없었습니다. 자바는 400을 받고, 경로가 맞아도 403입니다.

**문서는 알고 있었습니다.** *"파이썬 저장소가 이 리포에 없어서 클라이언트 쪽 변경은 미반영"* 이라고 적혀 있었습니다. 저장소가 갈라져 있으면 이런 문장이 **버그가 아니라 상태 설명**으로 남습니다.

계약을 기계가 읽는 파일(`contracts/internal-api.json`)로 옮겨 **양쪽 시험이 같은 것을 읽게** 했습니다. 이 구조에도 구멍이 있었습니다. 계약 파일만 바꾸면 Gradle이 테스트를 `UP-TO-DATE`로 건너뜁니다. `inputs.file`로 막고 되돌려 확인했습니다.

### `async`를 붙인 것이 상황을 악화시키고 있었습니다

```python
@app.post("/STT/{class_id}")
async def merge_audio(...):
    Start_STT(...)    # 동기 requests.post(timeout=600)  ← 최대 10분
```

FastAPI는 `async def` 핸들러를 **이벤트 루프에서 직접** 돌립니다. 그 안에서 블로킹하면 그동안 워커가 다른 요청을 **하나도** 못 받습니다.

| | 동시 2요청 | 동시 4요청 |
|---|---:|---:|
| 고치기 전 | **1.02초** (직렬 1.0초 기대) | — |
| 고친 뒤 | **0.52초** | **0.52초** (직렬이면 2.0초) |

**`async`를 뗐습니다.** `def`로 두면 FastAPI가 스레드풀에서 돌립니다. 역설적입니다. **`async`를 안 붙였으면 처음부터 괜찮았습니다.**

그리고 **실패가 전부 HTTP 200**이었습니다. STT 실패도 요약 실패도 `{"status": "stt_failed"}` + 200입니다. 재시도 정책을 상태 코드로 못 짜고(200은 재시도 대상이 아닙니다), 프록시·모니터링이 전부 성공으로 세서 **실패율 지표가 0**이 됩니다. 외부 의존 실패는 502로 나눴습니다.

### CI/CD가 절반만 자동화돼 있었습니다

| | CI | Deploy |
|---|---|---|
| backend | 있음 | 있음 |
| ai | 있음 | **없음** |
| **frontend** | **빌드조차 안 함** | **손으로 올림** |

프론트를 손으로 올리고 있었습니다. master에 push해도 서버는 그대로라 *"머지했는데 왜 안 바뀌지"* 가 됩니다. 붙이면서 세 가지를 정했습니다.

**경로 필터를 `on:`이 아니라 잡 단위로.** 워크플로의 `on:`에 걸면 **"돌지 않은 잡"이 pending으로 남습니다.** 필수 체크로 지정했다면 PR이 영원히 머지되지 않습니다. 잡 단위로 나누면 해당 없는 잡은 skip되고 체크는 초록으로 끝납니다.

**빌드 산출물을 검증합니다.** Vite는 빌드 시점에 `.env.production` 값을 코드에 박습니다. 값이 안 들어가도 **빌드도 배포도 성공하고, 화면에서 API 호출만 전부 실패합니다.**

```bash
grep -q "api.studywithtymee.com" dist/assets/*.js || exit 1
```

**첫 자동 배포는 실패했습니다.** `tar: empty archive` 였습니다. `scp-action`은 `source`를 러너 작업 디렉터리 기준으로 찾는데 절대경로를 주면 상대경로로 해석해 아무것도 담지 못합니다. **빌드도 압축도 성공한 채로 전송만 빈 파일이 갑니다.** 그래서 서버 쪽에 방어를 넣었습니다.

```bash
test -s /tmp/fe-dist.tgz                    # 빈 아카이브면 멈춘다
test -f /var/www/edumeet.new/index.html     # 교체 전에 확인한다
```

이게 없으면 **빈 아카이브가 그대로 배포되어 사이트가 빈 화면이 되고, 배포는 성공으로 끝납니다.**

> ai는 지금도 수동(`workflow_dispatch`)입니다. 트리거 경로도 자막 소스도 없어서 자동으로 띄워도 아무 일이 없기 때문입니다. **자동화하지 않은 이유를 적어 두는 것도 자동화의 일부라고 봤습니다.**

## ARM64를 QEMU로 빌드하지 않습니다

첫 번째 선택지는 x86 러너에서 QEMU로 ARM64 이미지를 크로스 빌드하는 것이었습니다. 흔한 방법이지만 **에뮬레이션이라 빌드가 몇 배 느립니다.**

GitHub가 **`ubuntu-24.04-arm` 네이티브 ARM64 러너**를 제공하고, 퍼블릭 저장소에서는 무료입니다.

```yaml
runs-on: ubuntu-24.04-arm
```

한 줄로 끝났습니다. 배포 대상이 ARM이니 **빌드도 ARM에서 하는 게 자연스럽습니다.** 에뮬레이션 계층이 사라지면 "로컬에서는 되는데 서버에서 안 되는" 아키텍처 관련 문제도 같이 사라집니다.

## Dockerfile에서 고친 것

기존 이미지는 `openjdk`를 쓰고 있었습니다. **이 이미지는 2022년에 deprecated 됐습니다.** 후속인 Eclipse Temurin으로 바꾸고, 런타임에는 JDK가 필요 없으니 JRE 이미지를 썼습니다.

그리고 하나 더:

```dockerfile
ENV JAVA_OPTS="-XX:MaxRAMPercentage=70 -XX:+ExitOnOutOfMemoryError"
```

**이게 없으면 JVM이 컨테이너 제한이 아니라 호스트 메모리를 보고 힙을 잡습니다.** 12GB 호스트에서 컨테이너에 2GB를 줘도 JVM은 3GB를 잡으려 하고, 그러면 컨테이너가 OOMKilled 됩니다. 로그에는 아무것도 안 남고 컨테이너만 조용히 죽습니다.

## docker-compose에서 발견한 것

기존 compose는 MySQL과 Redis를 이렇게 열고 있었습니다.

```yaml
ports:
  - "3306:3306"
  - "6379:6379"
```

로컬 개발에서는 편합니다. 그런데 **공인 IP가 붙은 서버에서 이러면 인터넷 전체에 DB가 노출됩니다.**

같은 compose 네트워크 안에서는 서비스명으로 접근되므로 포트를 호스트에 공개할 이유가 없습니다.

```yaml
expose:
  - "3306"      # 컨테이너 네트워크 안에서만
```

그리고 `depends_on`도 고쳤습니다.

```yaml
depends_on:
  mysql:
    condition: service_healthy
```

`condition` 없이 `depends_on`만 쓰면 **MySQL 프로세스가 뜬 순간 앱이 시작합니다.** MySQL이 아직 초기화 중이면 앱은 커넥션 실패로 죽습니다. 재시작 정책 때문에 결국은 뜨지만, 로그에는 이유 없는 실패가 몇 번 남습니다.

## 그리고 다음 작업에서 막혔습니다

배포 파이프라인을 머지하고, 다음 작업에서 `meeting` 테이블에 컬럼 두 개를 추가하려 했습니다. 그리고 **추가할 방법이 없다는 걸 알았습니다.**

```
$ grep -rn "ddl-auto" src/main/resources/
application-test.yml:  ddl-auto: create-drop
application-perf.yml:  ddl-auto: create
```

운영 프로필에는 없었습니다. 그리고 `ddl-auto`의 기본값은 DB 종류에 따라 갈립니다. **임베디드 DB(H2 등)면 `create-drop`, 그 외에는 `none`입니다.** MySQL이니 운영에서 Hibernate는 테이블을 만들지도 고치지도 않습니다.

Flyway도 Liquibase도 없었습니다. **스키마 변경 경로가 존재하지 않았습니다.**

지금까지 문제가 안 됐던 이유는 단순합니다. **스키마를 바꾼 적이 없었습니다.**

그리고 이건 제가 방금 만든 자동 배포의 구멍이기도 합니다. push하면 새 이미지가 뜨는데, 컬럼이 없으면 런타임에 죽습니다. 헬스체크가 감지는 하지만 **막는 게 아니라 롤백만 시킵니다.**

> `application-prod.yml` 자체가 없다는 것도 이때 알았습니다. Dockerfile은 `SPRING_PROFILES_ACTIVE=prod`를 켜는데 해당 파일이 없었습니다. 에러는 아니지만(프로필 파일은 선택) **운영 전용 설정을 둘 곳이 없었습니다.**

## baseline은 손으로 쓰지 않습니다

Flyway를 넣기로 하고 첫 번째 문제를 만났습니다. **운영 DB에는 이미 18개 테이블이 있습니다.** V1에 무엇을 써야 하나?

운영 DB를 직접 볼 수 없는 상태에서 스키마를 SQL로 역생성하는 건 위험합니다. 대신 **엔티티에서 DDL을 뽑았습니다.**

```java
@TestPropertySource(properties = {
    "spring.jpa.properties.jakarta.persistence.schema-generation.scripts.action=create",
    "spring.jpa.properties.jakarta.persistence.schema-generation.scripts.create-target=build/schema-mysql.sql",
    "spring.jpa.properties.hibernate.dialect=org.hibernate.dialect.MySQLDialect"
})
class SchemaExportTest { @Test void export() { } }
```

컨텍스트를 띄우기만 하면 Hibernate가 DDL 파일을 씁니다. 18개 테이블, FK 16개, UNIQUE 4개가 나왔습니다. **손으로 쓴 baseline은 반드시 실제와 어긋납니다.**

그리고 `baseline-on-migrate`를 씁니다.

| DB 상태 | Flyway 동작 |
|---|---|
| 기존 운영 DB (스키마 있음, 이력 테이블 없음) | V1을 **실행하지 않고** V1로 표시만 |
| 빈 DB (신규 개발자) | V1부터 **실제로 실행** |

이 파일은 "운영 스키마의 사본"이 아니라 **"엔티티가 기대하는 스키마"** 입니다. 둘이 다르면 V2 이후 마이그레이션에서 드러납니다.

## 검증은 진짜 MySQL에서 합니다

테스트 프로필은 H2를 씁니다. 그런데 baseline에는 이런 게 들어 있습니다.

```sql
session_type enum ('BROADCAST','INTERACTIVE') not null
) engine=InnoDB;
```

**H2의 MySQL 호환 모드로도 이건 깨집니다.** 그래서 Testcontainers로 진짜 MySQL 8.0을 띄웠습니다.

```java
@Container
static final MySQLContainer<?> MYSQL = new MySQLContainer<>("mysql:8.0");
```

이 테스트가 없으면 *"마이그레이션을 넣었다"* 는 주장은 **배포 시점에야 검증됩니다.** CI에서 ARM64 러너로도 통과하는 걸 확인했습니다.

### 그런데 이 시험은 빈 DB 경로만 봤습니다

나중에 지적받고 다시 보니, 위 시험은 **빈 DB 에 V1 부터 전부 적용하는 경로**만 검증합니다. 운영에서 실제로 일어나는 일은 그게 아닙니다. 스키마는 이미 있고 **Flyway 이력 테이블만 없는** 상태에서 시작합니다.

`baseline-on-migrate: true` 는 그 상태에서 **기존 스키마가 V1 과 같은지 검증하지 않습니다.** *"이미 V1"* 로 표시만 하고 V2 부터 돕니다. 어긋나 있어도 조용히 지나갑니다. Flyway 문서도 이 옵션이 **잘못된 DB 를 대상으로 실행되는 것을 막던 안전장치를 없앤다**고 적고 있습니다.

그래서 그 경로를 그대로 만드는 시험을 따로 추가했습니다.

```
V1 까지만 적용  →  flyway_schema_history 삭제  →  baseline-on-migrate 로 재실행
```

- V1 이 `BASELINE` 으로 표시되고 **다시 실행되지 않는지** (실행되면 `create table` 이 충돌합니다)
- V2~V9 가 `SQL` 로 **실제 적용되는지**

같이 `ddl-auto` 도 `none` 에서 `validate` 로 바꿨습니다. **`none` 은 "손대지 않는다" 이지 "확인한다" 가 아닙니다.** 이제 엔티티와 스키마가 어긋나면 부팅에서 실패합니다.

**아직 안 한 것**: MySQL 이미지 패치 버전을 못 박지 않았습니다. `mysql:8.0` 이라 이미지가 갱신되면 CI 결과가 조용히 바뀝니다.

## 브리틀한 단언이 바로 걸렸습니다

첫 버전에 이렇게 썼습니다.

```java
assertThat(meetingColumns).isEqualTo(8);
```

그리고 다음 작업에서 V2로 컬럼 두 개를 추가하자마자 깨졌습니다. **개수를 세는 단언은 마이그레이션이 추가될 때마다 깨집니다.**

```java
assertThat(columnsOf("meeting"))
        .contains("summary_md_url", "summary_pdf_url");
```

개수가 아니라 **"엔티티가 요구하는 컬럼이 있는가"** 를 보게 바꿨습니다. 테스트가 깨진 게 나쁜 일은 아니었습니다. **스키마가 바뀌었다는 걸 정확히 알려줬으니까요.** 다만 알려주는 방식이 잘못돼 있었습니다.

## 정리

배포 자동화를 먼저 만들고 스키마 관리를 나중에 발견한 순서가 좋았다고는 못 하겠습니다. 다만 **"자동 배포와 수동 스키마 관리는 공존할 수 없다"는 걸 실제로 막혀보고 알았습니다.**

파이프라인은 코드를 바꿀 수 있게 해줬지만, 그 코드가 요구하는 스키마를 바꿀 수단이 없으면 반쪽입니다.

---

- CI/CD 구조: [`docs/ops/01-cicd-and-deploy.md`](https://github.com/dj258255/edumeet/blob/master/docs/ops/01-cicd-and-deploy.md)
- PR: [#26 CI/CD](https://github.com/dj258255/edumeet/pull/26) · [#30 Flyway](https://github.com/dj258255/edumeet/pull/30)

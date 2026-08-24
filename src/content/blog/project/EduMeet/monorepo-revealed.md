---
title: '저장소를 합치니 끊겨 있던 것이 보였습니다'
description: >-
  GitLab에 흩어져 있던 프론트·AI를 이력째 모노레포로 합쳤습니다.
  합치고 나서 AI 연동이 한 번도 동작한 적 없다는 것을,
  프론트가 없어진 서버를 부르고 있다는 것을,
  CI/CD가 절반만 자동화돼 있다는 것을 알았습니다.
date: 2026-08-24
tags:
  - EduMeet
  - Monorepo
  - Git
  - FastAPI
  - Spring Boot
  - GitHub Actions
  - Contract Testing
category: team/EduMeet
coverImage: /uploads/project/EduMeet/EduMeetTitle.png
draft: false
series: "EduMeet"
seriesOrder: 6
---

EduMeet은 저장소가 셋이었습니다.

```
github.com/dj258255/edumeet            Spring 백엔드 (개인 리팩토링 중)
lab.ssafy.com/simsim/edumeet_frontend  Vue 프론트
lab.ssafy.com/simsim/edumeet_ai        FastAPI
```

SSAFY GitLab은 외부에 공개할 수 없어서, 포트폴리오로 보면 **절반이 안 보였습니다.**

합치기로 했습니다. 그런데 합치고 나서야 보인 것들이 있었습니다.

---

## 1. 이력을 잃지 않고 합치기

**커밋 이력이 자산입니다.** 팀 6주의 기록이고 작성자별 기여가 남아야 합니다.

처음엔 `git subtree add`로 붙였습니다. 잘 붙는 것처럼 보였습니다.

```bash
git blame frontend/src/App.vue       # ✅ 이승민 2025-07-22 까지 추적된다
git log -- frontend/src/App.vue      # ❌ 0 커밋
```

**blame은 되는데 log는 안 됐습니다.**

병합 이전 커밋들의 **경로가 `frontend/`가 아니라 루트**였기 때문입니다.
경로 필터가 안 걸립니다.

`filter-repo`로 **모든 커밋의 경로를 목적지 기준으로 재작성**한 뒤 합쳤습니다.

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

### 백엔드는 이력을 다시 쓰지 않았습니다

`backend/`로 옮겼지만 **SHA는 그대로**입니다.
백엔드에도 같은 필터를 걸면 모든 SHA가 바뀌고, **머지된 PR 90여 개의 커밋 참조가 전부 깨집니다.**

`git mv`의 rename 추적으로 충분했습니다 — `--follow`가 `openvidu` → `meeting` 리네임까지 넘어갑니다.

### 덤: `.mailmap`

합치고 나서 `git shortlog`를 보니 한 사람이 여러 줄로 세어지고 있었습니다.

| | 전 | 후 |
|---|---|---|
| 범수 | 135 + 30(`BeomSu`) + 19 + 6(`dj258255`) | **190** |
| 권민환 | 35 + 61(`kwonminhwan`) | **96** |

로컬 git config 이름과 GitHub 프로필 이름이 다르고, 웹에서 머지하면 noreply로 기록되기 때문입니다.
`.mailmap`은 **표시만** 바꿉니다. 저자를 고치면 SHA가 바뀝니다.

---

## 2. AI 연동이 한 번도 동작한 적 없었습니다

`ai/`를 처음 제대로 읽었습니다. 실제로 나가던 요청이 이랬습니다.

```
[upload:url]  http://.../meetings/{meetingId}/summary   ← 치환조차 안 됨
[upload:data] {'class_id':'5','meeting_id':'77'}        ← meetingId 를 폼 필드로
headers       {"Accept": "application/json"}            ← X-Internal-Token 없음
```

Java는 `%7BmeetingId%7D`를 `Long`으로 파싱하려다 **400**,
경로가 맞았어도 `hasRole("INTERNAL")`에서 **403**입니다.

**AI 요약본이 서비스에 도달한 적이 없었습니다.**

### 문서는 알고 있었습니다

`docs/ops/03-internal-api-contract.md`에 **"파이썬이 바꿔야 하는 것"** 표가 있었습니다.
그리고 마지막 줄이 이랬습니다.

> *"파이썬 저장소가 이 리포에 없어서 **클라이언트 쪽 변경은 미반영**이다"*

**몰라서 안 고친 게 아니라 고칠 수 없는 위치에 있었습니다.**
그리고 **문서는 CI를 실패시키지 못합니다.**

### 계약을 기계가 읽는 파일로

```
contracts/internal-api.json    Java 테스트와 파이썬 테스트가 함께 읽는다
```

| | 무엇을 검증 |
|---|---|
| `InternalApiContractTest` (Java) | 실제 노출 경로·헤더 이름이 계약과 같은지 |
| `test_summary_upload_contract.py` (파이썬) | 실제로 **나가는 HTTP 요청**이 계약과 같은지 |

**손으로 옮겨 적으면 의미가 없습니다.** Java가 경로를 바꿔도 파이썬 테스트는 초록으로 남습니다.
그게 정확히 이 버그가 오래 산 이유입니다.

### 그 구조에도 구멍이 있었습니다

계약 파일만 바꿔 봤더니 **파이썬은 잡는데 Java는 0개**였습니다.

Gradle이 `test`를 **UP-TO-DATE로 건너뛴** 것이었습니다.
계약 파일이 `backend/` 밖에 있어서 Gradle이 변경을 모릅니다.

```kotlin
tasks.named<Test>("test") {
    inputs.file(rootProject.file("../contracts/internal-api.json"))
}
```

**CI가 초록인데 계약이 갈라지는 상태**를 만들 뻔했습니다.

---

## 3. `async`를 붙인 것이 상황을 악화시키고 있었습니다

같은 파일에서 하나 더 나왔습니다.

```python
@app.post("/STT/{class_id}")
async def merge_audio(...):
    Start_STT(...)    # 동기 requests.post(timeout=600)  ← 최대 10분
```

FastAPI는 `async def` 핸들러를 **이벤트 루프에서 직접** 돌립니다.
그 안에서 블로킹하면 그동안 워커가 다른 요청을 **하나도** 못 받습니다.

| | 동시 2요청 | 동시 4요청 |
|---|---:|---:|
| 고치기 전 | **1.02초** (직렬 1.0초 기대) | — |
| 고친 뒤 | **0.52초** | **0.52초** (직렬이면 2.0초) |

**`async`를 뗐습니다.** `def`로 두면 FastAPI가 스레드풀에서 돌립니다.

역설적입니다 — **`async`를 안 붙였으면 처음부터 괜찮았습니다.**

### 그리고 실패가 HTTP 200이었습니다

STT 실패도, 요약 실패도 전부 `{"status": "stt_failed"}` + **200**.

- 재시도 정책을 상태 코드로 못 짭니다. 200은 재시도 대상이 아닙니다
- 프록시·모니터링이 전부 성공으로 셉니다 — **실패율 지표가 0**이고 알림이 안 울립니다

외부 의존 실패는 502로 나눴습니다.

---

## 4. 프론트가 없어진 서버를 부르고 있었습니다

```
https://i13c205.p.ssafy.io    7개 파일 13곳
```

SSAFY 배포 서버이고 **이미 없습니다.** 환경변수를 넣어도 이 줄들은 그대로 죽은 곳을 부릅니다.
하나는 **오타**였습니다 — `https://i13c205.p..io` (점 두 개).

11곳을 새 도메인으로 바꿨습니다. **2곳은 일부러 남겼습니다.**

| 경로 | |
|---|---|
| `/api/extract-key-sentences` | 우리 백엔드에 **없음**. Express에도 없음 |
| `/api/llm-summarize` | 〃 |

**도메인만 바꾸면 "없는 걸 있는 척" 하게 됩니다.**

---

## 5. CI/CD가 절반만 자동화돼 있었습니다

합친 뒤 세어 보니 이랬습니다.

| | CI | Deploy |
|---|---|---|
| backend | ✅ | ✅ |
| ai | ✅ | ❌ |
| **frontend** | **❌ 빌드조차 안 함** | **❌ 손으로 올림** |

**프론트를 손으로 올리고 있었습니다.** master에 push해도 서버는 그대로입니다 —
*"머지했는데 왜 안 바뀌지"*가 됩니다.

### 경로 필터를 `on:`이 아니라 잡 단위로

```yaml
on:
  push:
    paths: ['backend/**']     # ← 이렇게 하지 않습니다
```

**워크플로의 `on:`에 걸면 "돌지 않은 잡"이 pending으로 남습니다.**
필수 체크로 지정했다면 PR이 영원히 머지되지 않습니다.

잡 단위로 나누면 해당 없는 잡은 **skip**되고 체크는 초록으로 끝납니다.

### 빌드 산출물을 검증합니다

**Vite는 빌드 시점에 `.env.production` 값을 코드에 박습니다.**
값이 안 들어가도 **빌드는 성공하고, 배포도 성공하고, 화면에서 API 호출만 전부 실패합니다.**

```bash
grep -q "api.studywithtymee.com" dist/assets/*.js || exit 1
```

### 첫 자동 배포는 실패했습니다

```
tar: empty archive
```

`scp-action`은 `source`를 **러너 작업 디렉터리 기준**으로 찾습니다.
절대경로를 주면 상대경로로 해석해 아무것도 담지 못합니다.

**빌드도 압축도 성공한 채로 전송만 빈 파일이 갑니다.**

그래서 서버 쪽에 방어를 넣었습니다.

```bash
test -s /tmp/fe-dist.tgz                    # 빈 아카이브면 멈춘다
test -f /var/www/edumeet.new/index.html     # 교체 전에 확인한다
```

이게 없으면 **빈 아카이브가 그대로 배포되어 사이트가 빈 화면이 되고, 배포는 성공으로 끝납니다.**

---

## 배운 것

이 글의 발견들은 **하나도 새로 만든 기능이 아닙니다.** 전부 이미 있던 것이었고,
**저장소가 나뉘어 있어서 아무도 맞춰 보지 않았을 뿐입니다.**

AI 연동은 특히 그렇습니다. **Java 쪽 코드도 맞고, 파이썬 쪽 코드도 맞았습니다.**
각자의 단위 테스트도 다 통과했습니다. **둘이 서로 같은 것을 말하는지는 아무도 안 봤습니다.**

> 경계에 있는 버그는 어느 쪽 테스트로도 안 잡힙니다.
> 그래서 계약을 **양쪽이 함께 읽는 파일**로 만들어야 합니다.

그리고 문서로는 부족했습니다. *"파이썬이 바꿔야 한다"*고 표까지 만들어 뒀는데
**문서는 CI를 실패시키지 못합니다.**

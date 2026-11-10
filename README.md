# IT Oasis

백엔드와 시스템 내부 동작, 데이터 엔지니어링을 측정과 실패 사례로 확인해 적는 개인 기술 블로그입니다.

A personal tech blog on backend, systems internals and data engineering, written in Korean.

- 주소: https://dj258255.github.io/IT-Oasis/
- 스택: Astro 5, Tailwind CSS 4, Expressive Code, GitHub Pages

## 실행

Node 버전은 `.nvmrc`를 따르고 패키지 관리자는 pnpm입니다.

```bash
pnpm install --frozen-lockfile
pnpm dev        # http://localhost:4321
pnpm build      # dist/ 로 정적 빌드
CI=true pnpm build && node scripts/check-links.mjs dist   # 배포와 같은 조건(base /IT-Oasis)으로 확인
```

운영 빌드는 `astro.config.mjs`에서 `base`를 `/IT-Oasis`로 붙입니다. 저장소 이름을 바꾸면 블로그 주소가 함께 바뀌고 옛 주소는 리다이렉트되지 않습니다.

## 폴더

| 경로 | 역할 |
|---|---|
| `src/content/blog/` | 글(Markdown). 폴더는 카테고리이고 주소의 일부입니다 |
| `src/data/topics.ts` | 주제 열 개. 공개 글에 `topics`가 없으면 빌드가 멈춥니다 |
| `src/data/categories/`, `src/data/projects/`, `src/data/site/` | 카테고리, 프로젝트 소개, 사이트 설정(JSON) |
| `src/pages/`, `src/layouts/`, `src/components/`, `src/styles/` | 화면 |
| `public/uploads/` | 글에 쓰는 그림. 글 주소와 같은 경로 아래 둡니다 |
| `scripts/` | `ensure-blog-folders.mjs`(dev·build 전 카테고리 폴더 생성), `content-gate.mjs`(빌드 결과에 빠진 글이 없는지 셈), `check-links.mjs`(내부 링크 검사) |
| `tools/covers/`, `tools/diagrams/` | 표지와 도식 SVG 생성기. 사용법은 각 폴더의 README |
| `labs/de-study/` | "DE 공부" 시리즈 실습 코드. 글이 이 경로를 링크하므로 옮기지 않습니다 |
| `.github/workflows/deploy.yml` | main 푸시 시 빌드, 누락 글 재시도, 링크 검사 후 Pages 배포 |

## 배포

main에 머지되면 GitHub Actions가 배포합니다. Astro 콘텐츠 동기화가 가끔 글을 빠뜨려서, 배포 단계는 `content-gate.mjs`로 누락 편 수를 세고 0이 될 때까지 다시 빌드합니다. 끝내 0이 안 되면 배포를 멈춥니다.

## 글 규칙

- 글 `date`는 처음 쓴 날로 고정하고 고쳐도 바꾸지 않습니다.
- 목록에서 내린 글은 지우지 않고 `unlisted: true`로 둡니다. 주소는 유지됩니다.
- 이력서, 자소서 같은 개인 자료는 저장소에 올리지 않습니다. `.gitignore`가 `_workspace/`와 루트의 문서 파일을 막습니다.

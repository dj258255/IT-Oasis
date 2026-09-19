# tools/covers — 블로그 커버 생성기

글 썸네일(`coverImage`)을 rough.js 손그림으로 만든다.
`tools/diagrams/draw.mjs` 를 그대로 쓴다. 도화지·팔레트·획이 같아야 글 안 도식과 커버가 같은 결로 보인다.

## 실행

```
cd tools/covers
node build.mjs          # specs 를 전부 그려 public/uploads/covers/<글 id>.svg 로 쓴다
node check.mjs          # 스펙↔글 1:1, 글자 넘침, 파일 존재를 검사한다
node apply.mjs          # 각 글 프런트매터의 coverImage 를 새 경로로 바꾼다
node contact-sheet.mjs  # 이전/새 커버를 카드 크기로 나란히 놓은 out/contact-sheet.html
```

`build.mjs` 와 `check.mjs` 는 첫 인자로 출력 디렉터리를 받는다(기본 `../../public/uploads/covers`).

## 규칙

- **SVG 를 손으로 쓰지 않는다.** 고칠 때는 `specs/*.mjs`(문구)나 `motifs.mjs`(그림)를 고치고 다시 돌린다.
- **seed 를 건드리지 않는다.** `draw.mjs` 가 좌표에서 seed 를 뽑아 고정한다. 랜덤으로 바꾸면
  커밋마다 SVG 전체가 바뀌어 diff 가 쓸모없어진다.
- **글자는 반드시 `fit()` 으로 그린다.** 빌드에 캔버스가 없어 실제 측정이 불가능하므로 폭을
  추정해서 넘치면 경고를 남긴다. 경고가 0 이 아니면 스펙 문구를 줄이거나 레이아웃을 바꾼다.
- **초안(`draft: true`)에는 커버를 만들지 않는다.** `getBuildablePosts()` 가 걸러내 페이지
  자체가 만들어지지 않는다. 공개로 돌릴 때 `specs/` 에 더하고 `build.mjs` 만 다시 돌린다.
- **없는 도형은 `../diagrams/draw.mjs` 에 더한다.** 커버 전용 사본을 만들지 않는다.
- **검토는 카드 크기로 한다.** 1200px 원본으로 보면 다 좋아 보인다. `contact-sheet.html` 은
  목록 카드와 같은 폭(380px)으로 그린다.

## 규격

- **1200x630.** `PostCard.astro` 의 `aspect-[40/21]`(=1.9047)과 정확히 맞고, OG 표준 1.91:1 과도 같다.
  `CarouselCard` 는 16:10 이라 `object-cover` 로 크롭된다. `object-fill` 이면 가로로 19% 압축된다.
- 출력은 `public/uploads/covers/<글 id>.svg`, 프런트매터는 `coverImage: /uploads/covers/<글 id>.svg`.
  `assetPath()` 는 `/uploads` 를 붙여주지 않으므로 경로 전체를 적어야 한다.
- 글 id 에 공백이 있으면(`project/IT Oasis/...`) 경로에도 공백이 들어간다. `assetPath()` 가 인코딩한다.

## 스펙 (`specs/*.mjs`)

```js
{
  id: 'theory/db-connection-pool',        // 글 id 와 1:1. 출력 경로도 이 값이다
  kicker: 'Database',                     // 좌상단 작은 라벨 (시리즈·카테고리)
  title: ['커넥션은 비싸서', '풀에 담아 다시 쓴다'],   // 1~2줄, 글의 주장
  thesis: '매 요청마다 TCP 연결과 인증을 다시 하던 비용',  // 근거 한 줄
  layout: 'right-diagram',
  motif: 'pool-saturation',
  accent: 'blue',
  note: 'HikariCP: (코어 수 × 2) + 스핀들 수',   // 하단 오른쪽 각주
  previous: '/uploads/theory/db-connection-pool/cost.svg',  // 교체 전 커버 (contact sheet 전용)
  labels: { /* 모티프가 읽는 라벨 */ },
}
```

- `title` 은 **그 글의 주장**이다. 글 제목을 복사하지 않는다. 카드가 이미 제목을 보여준다.
- `thesis` 에는 숫자가 있으면 숫자를 박는다. "배포 중단 270건 → 0건" 같은 한 줄이 썸네일에서 가장 강하다.
- 문체는 `_workspace/prompts/diagram-style-prompt.md` §4 를 따른다. 문중 대시 금지,
  "X가 아니라 Y" 대비 프레임 금지, 이모지 금지.
- **라벨은 본문 표현이어야 한다.** 도식 문구는 본문과 따로 살아서 어긋나기 쉽다
  (`tools/diagrams/README.md` 에 문구 동기화 사고 기록이 세 번 있다).

## 레이아웃 3종 (`compose.mjs`)

| layout | 배치 | 쓰는 곳 |
|---|---|---|
| `right-diagram` | 좌측 텍스트(폭 544, 제목 38px) + 우측 도식(472x388) | 제목이 짧고 도식이 정방형 |
| `bottom-band` | 상단 제목 전폭(제목 46px) + 하단 밴드(1056x196) | 흐름·파이프라인 |
| `two-cards` | 상단 제목 + 하단 카드 2장 | 대조·비교가 뼈대일 때 |

같은 계열 글이 이어질 때 레이아웃을 섞지 않으면 한 템플릿으로 보인다.

## 모티프 (`motifs.mjs`)

`(k, a, spec, accent)` 를 받아 `a = {x, y, w, h}` 안에만 그린다.

| id | 그림 | 쓰는 곳 |
|---|---|---|
| `schema-mismatch` | 좌우 카드 + ≠ | 코드와 스키마, 테스트 환경과 실 DB |
| `cdc-pipeline` | 5단 가로 파이프라인 | 쓰기 → 로그 → 캡처 → 브로커 → 읽기 모델 |
| `pipeline-roles` | 태그 붙은 4분면 | 무엇을 고정하고 무엇을 위임할지 |
| `btree` | 루트→내부→리프 + 사슬 | 인덱스·트리 구조 |
| `pool-saturation` | 스레드 5 + 풀 상자 | 커넥션·스레드 풀 |
| `tcp-handshake` | 생명선 2 + 화살표 3 | 핸드셰이크·왕복 프로토콜 |

모티프를 늘릴 때는 라벨만 바꿔 재사용할 수 있게 `spec.labels` 를 읽는 형태로 쓴다.

import { writeFileSync, mkdirSync } from 'fs';
import { pilot } from './specs/pilot.mjs';
import { posts } from './specs/posts.mjs';

const specs = [...pilot, ...posts];

// 이전 커버와 새 커버를 카드 크기로 나란히 놓는다.
// 1200px 원본으로 보면 다 좋아 보이므로, 실제 목록 카드와 같은 폭(380px)에서 판단한다.
const OUT = 'out/contact-sheet.html';
mkdirSync('out', { recursive: true });

const figure = (src, label) => `
      <figure>
        <img src="${src}" alt="">
        <figcaption>${label}</figcaption>
      </figure>`;

const sections = specs
  .map(
    (spec) => `
    <section>
      <h2>${spec.id}</h2>
      <div class="pair">
        ${figure(`../../../public${spec.previous}`, '이전')}
        ${figure(`../../../public/uploads/covers/${spec.id}.svg`, '새 커버')}
      </div>
    </section>`,
  )
  .join('');

const html = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>커버 파일럿 — 이전 / 새 커버</title>
<style>
  body { margin: 0; padding: 32px; background: #e9f3fc; font-family: -apple-system, 'Pretendard', 'Apple SD Gothic Neo', sans-serif; }
  h1 { font-size: 19px; margin: 0 0 26px; color: #1e293b; }
  section { margin-bottom: 26px; }
  h2 { font-size: 11px; font-weight: 600; color: #64748b; margin: 0 0 8px; font-family: ui-monospace, SFMono-Regular, monospace; }
  .pair { display: flex; gap: 16px; }
  figure { margin: 0; }
  img { display: block; width: 380px; aspect-ratio: 40 / 21; object-fit: cover; border-radius: 12px;
        background: #fff; box-shadow: inset 0 0 0 1px rgba(15, 40, 80, 0.07); }
  figcaption { font-size: 11px; color: #94a3b8; margin-top: 6px; }
</style>
</head>
<body>
<h1>커버 파일럿 — 실제 카드 크기(380px)에서 이전 / 새 커버</h1>
${sections}
</body>
</html>
`;

writeFileSync(OUT, html);
console.log(`  ✓ ${OUT}`);

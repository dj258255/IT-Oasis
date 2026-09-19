import { readFileSync, existsSync } from 'fs';
import { render } from '../diagrams/draw.mjs';
import { compose, LAYOUTS, takeOverflow } from './compose.mjs';
import { MOTIFS } from './motifs.mjs';
import { pilot } from './specs/pilot.mjs';

// 빌드에 캔버스가 없어 글자 폭을 실제로 잴 수 없다. 그래서 렌더하면서
// fit() 이 남긴 넘침 기록을 모아 검사한다. 100편을 눈으로 다 볼 수 없을 때의 안전망이다.
const BLOG = '../../src/content/blog';
const OUT = process.argv[2] || '../../public/uploads/covers';
const problems = [];

const seen = new Set();
for (const spec of pilot) {
  if (seen.has(spec.id)) problems.push(`id 중복: ${spec.id}`);
  seen.add(spec.id);

  const md = `${BLOG}/${spec.id}.md`;
  if (!existsSync(md)) {
    problems.push(`글이 없음: ${md}`);
    continue;
  }
  const src = readFileSync(md, 'utf8');
  if (/^draft: true$/m.test(src)) problems.push(`초안에는 커버를 만들지 않는다: ${spec.id}`);
  if (!/^coverImage:/m.test(src)) problems.push(`coverImage 없음 (apply.mjs 필요): ${spec.id}`);

  if (!LAYOUTS[spec.layout]) problems.push(`모르는 레이아웃: ${spec.layout} (${spec.id})`);
  if (!MOTIFS[spec.motif]) problems.push(`모르는 모티프: ${spec.motif} (${spec.id})`);
}

takeOverflow();
for (const spec of pilot) {
  if (!LAYOUTS[spec.layout] || !MOTIFS[spec.motif]) continue;
  render(compose(spec, MOTIFS[spec.motif]));
}
takeOverflow().forEach((o) => problems.push(o));

for (const spec of pilot) {
  if (!existsSync(`${OUT}/${spec.id}.svg`)) problems.push(`SVG 없음 (build.mjs 필요): ${spec.id}`);
}

if (problems.length) {
  console.error(`검사 실패 ${problems.length}건`);
  problems.forEach((p) => console.error('  -', p));
  process.exit(1);
}

console.log(`검사 통과 — 스펙 ${pilot.length}개, 글과 1:1, 글자 넘침 없음`);

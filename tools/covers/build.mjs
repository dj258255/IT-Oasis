import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { render } from '../diagrams/draw.mjs';
import { compose, LAYOUTS, takeOverflow } from './compose.mjs';
import { MOTIFS } from './motifs.mjs';
import { pilot } from './specs/pilot.mjs';

// 기본 출력. tools/covers/ 에서 실행하므로 저장소의 public/uploads/covers 로 떨어진다.
const OUT = process.argv[2] || '../../public/uploads/covers';

takeOverflow();

for (const spec of pilot) {
  if (!LAYOUTS[spec.layout]) throw new Error(`모르는 레이아웃: ${spec.layout} (${spec.id})`);
  if (!MOTIFS[spec.motif]) throw new Error(`모르는 모티프: ${spec.motif} (${spec.id})`);

  const path = `${OUT}/${spec.id}.svg`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, render(compose(spec, MOTIFS[spec.motif])));
  console.log('  ✓', path);
}

const overflow = takeOverflow();
if (overflow.length) {
  console.error(`\n글자 넘침 ${overflow.length}건 — 스펙 문구를 줄이거나 레이아웃을 바꾼다:`);
  overflow.forEach((o) => console.error('  -', o));
  process.exitCode = 1;
}

console.log(`${pilot.length}장 생성`);

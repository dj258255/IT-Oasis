import { readFileSync, writeFileSync } from 'fs';
import { pilot } from './specs/pilot.mjs';

// 각 글 프런트매터의 coverImage 한 줄만 바꾼다. 없으면 draft 줄 앞에 새로 넣는다.
// (draft 는 어느 글이나 프런트매터에 있으므로 그 줄을 기준으로 삼는다.)
const BLOG = '../../src/content/blog';

let changed = 0;
for (const spec of pilot) {
  const path = `${BLOG}/${spec.id}.md`;
  const value = `/uploads/covers/${spec.id}.svg`;
  const before = readFileSync(path, 'utf8');

  const after = /^coverImage:.*$/m.test(before)
    ? before.replace(/^coverImage:.*$/m, `coverImage: ${value}`)
    : before.replace(/^draft:/m, `coverImage: ${value}\ndraft:`);

  if (after === before) {
    console.log('  = 이미 최신', spec.id);
    continue;
  }
  writeFileSync(path, after);
  console.log('  ✓', spec.id);
  changed += 1;
}
console.log(`${changed}편 갱신`);

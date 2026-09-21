import { execFileSync } from 'child_process';
import { readdirSync, mkdirSync } from 'fs';
// 「Spring 백엔드 개발자가 성능 지표를 읽는 법」 글의 도식. 상위 build-all.mjs 와 출력 위치가 달라 따로 둔다.
const OUT = process.argv[2] || '../../../public/uploads/theory/reading-performance-metrics';
mkdirSync(OUT, { recursive: true });
for (const f of readdirSync('.').filter(f => f.startsWith('gen-') && f.endsWith('.mjs')).sort()) {
  const name = f.slice(4, -4);
  execFileSync('node', [f, `${OUT}/${name}.svg`], { stdio: 'inherit' });
  console.log('  ✓', name);
}

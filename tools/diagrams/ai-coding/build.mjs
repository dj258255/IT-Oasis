import { execFileSync } from 'child_process';
import { readdirSync, mkdirSync } from 'fs';
// 「AI 코딩, 저는 이렇게 개발하고 있습니다」 글의 도식. 상위 build-all.mjs 와 출력 위치가 달라 따로 둔다.
const OUT = process.argv[2] || '../../../public/uploads/blog/ai/ai-coding';
mkdirSync(OUT, { recursive: true });
for (const f of readdirSync('.').filter(f => f.startsWith('gen-') && f.endsWith('.mjs')).sort()) {
  const name = f.slice(4, -4);
  execFileSync('node', [f, `${OUT}/${name}.svg`], { stdio: 'inherit' });
  console.log('  ✓', name);
}

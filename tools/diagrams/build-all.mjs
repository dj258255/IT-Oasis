import { execFileSync } from 'child_process';
import { readdirSync } from 'fs';
const OUT = process.argv[2] || '../../public/uploads/project/pay/diagrams';
for (const f of readdirSync('.').filter(f => f.startsWith('gen-') && f.endsWith('.mjs')).sort()) {
  const name = f.slice(4, -4);
  execFileSync('node', [f, `${OUT}/${name}.svg`], { stdio: 'inherit' });
  console.log('  ✓', name);
}

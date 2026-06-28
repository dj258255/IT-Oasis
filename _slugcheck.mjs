import { slug as ghSlug } from 'github-slugger';
import { execSync } from 'child_process';
const files = execSync("git ls-files 'src/content/blog/**/*.md'").toString().trim().split('\n');
const ids = new Map(); const collisions = [];
for (const f of files) {
  const rel = f.replace('src/content/blog/','').replace(/\.md$/,'');
  const id = rel.split('/').map(s => ghSlug(s)).join('/');
  if (ids.has(id) && ids.get(id) !== rel) collisions.push([id, ids.get(id), rel]);
  else ids.set(id, rel);
}
console.log('files:', files.length, '| unique ids:', ids.size, '| collisions:', collisions.length);
for (const [id,a,b] of collisions) console.log('COLLIDE id='+id+'\n   '+a+'\n   '+b);

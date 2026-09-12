// 빌드 산출물이 기대한 글을 모두 담았는지 센다.
//
// 예전에는 사이드바 "전체" 뱃지의 숫자를 dist/index.html에서 긁어 썼다. 그 방식은 화면 마크업에
// 묶여 있어 두 번 깨졌다. 한 번은 data-ko/data-en 쌍을 걷어내며 매칭이 실패했고(2026-08-08),
// 한 번은 홈 구조를 정리하며 사이드바 자체가 페이지에서 사라졌다(2026-09-12). 두 경우 모두
// 빌드는 멀쩡한데 0으로 읽혀 20회 재시도 후 배포가 막혔다.
//
// 그래서 화면이 아니라 파일을 센다. 프런트매터로 기대 슬러그를 만들고, dist에 index.html이
// 생긴 경로와 대조한다. 표준 출력에는 누락 편 수만 쓰고(껍데기 파싱 없이 셸이 바로 읽는다),
// 사람이 볼 진단은 표준 오류로 보낸다.
import fs from 'node:fs';
import path from 'node:path';

const slugify = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}\-_]+/gu, '-').replace(/^-+|-+$/g, '');

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : entry.name.endsWith('.md') ? [full] : [];
  });

const expected = new Set();
let draft = 0;
let unlisted = 0;
for (const file of walk('src/content/blog')) {
  // 프런트매터만 본다
  const head = fs.readFileSync(file, 'utf8').split('\n---')[0];
  if (/^draft:\s*true/m.test(head)) {
    draft += 1;
    continue;
  }
  if (/^unlisted:\s*true/m.test(head)) {
    unlisted += 1;
    continue;
  }
  expected.add(file.replace(/^src\/content\/blog\//, '').replace(/\.md$/, '').split('/').map(slugify).join('/'));
}

const built = new Set();
const walkDist = (dir, base) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (fs.existsSync(path.join(full, 'index.html'))) built.add(rel);
    walkDist(full, rel);
  }
};
if (fs.existsSync('dist/blog')) walkDist('dist/blog', '');

const missing = [...expected].filter((slug) => !built.has(slug)).sort();
console.error(`기대 ${expected.size}편 (초안 ${draft}, unlisted ${unlisted}), dist 페이지 ${built.size}개, 누락 ${missing.length}편`);
for (const slug of missing.slice(0, 30)) console.error(`  누락: ${slug}`);
if (missing.length > 30) console.error(`  ... 외 ${missing.length - 30}편`);

console.log(missing.length);
process.exit(missing.length === 0 ? 0 : 1);
